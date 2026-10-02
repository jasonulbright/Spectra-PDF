//! The virtual printer: "Spectra PDF" appears in every
//! application's print dialog; printing to it lands the pages in this app
//! as a fresh PDF.
//!
//! Windows: a per-account queue on the IN-BOX "Microsoft PS Class Driver" that
//! holds every job (`print_to_pdf_windows.rs`). The receiver reads each job's
//! PostScript from the spooler and hands it to the configured Ghostscript
//! through the CLI `distill` arm, and the finished PDF opens through the normal
//! open funnel (the second-instance `app:openFile` event). No driver is
//! shipped and no service is installed; the receiver lives only while the app
//! runs (tray-residency counts). A job printed while the app is closed waits
//! in the Windows queue.
//!
//! Printer/port INSTALLATION needs admin (ports are machine objects), so
//! Install/Remove run a visible, user-initiated UAC elevation with a
//! UTF-16LE-encoded PowerShell command, never a silent elevation or a
//! swappable script file.
//!
//! On Linux the queue is a per-user CUPS queue that holds every job, and the
//! receiver copies each job out of the spool (`print_to_pdf_linux.rs`); it
//! reuses the job naming and conversion rules below.

#![cfg_attr(target_os = "linux", allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "linux")]
#[path = "print_to_pdf_linux.rs"]
mod linux;

#[cfg(windows)]
#[path = "print_to_pdf_windows.rs"]
mod windows_receiver;

pub const PRINTER_NAME: &str = "Spectra PDF";
/// A print job larger than this is refused (a runaway client, not a page).
const MAX_JOB_BYTES: u64 = 512 * 1024 * 1024;
/// Concurrent job cap: each job runs on its own thread.
const MAX_CONCURRENT_JOBS: usize = 8;

static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Releases the slot however the job thread leaves, including a panic.
struct JobSlot;
impl Drop for JobSlot {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}

pub struct PrinterState {
    /// "listening" once the receiver is up, else the named reason it is
    /// not, shown verbatim in Settings.
    pub listener_status: Mutex<String>,
    pub last_job_error: Mutex<String>,
}

impl PrinterState {
    pub fn new() -> Self {
        Self {
            listener_status: Mutex::new("starting".to_string()),
            last_job_error: Mutex::new(String::new()),
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn printed_dir() -> PathBuf {
    std::env::temp_dir().join("spectrapdf").join("printed")
}

/// The per-user cache folder, never the shared `/tmp`: another account could
/// create `/tmp/spectrapdf` first and read or replace what lands in it.
#[cfg(target_os = "linux")]
fn printed_dir() -> PathBuf {
    linux::printed_dir()
}

/// How every name a job writes into the printed folder begins.
const PRINTED_PREFIX: &str = "Printed ";

/// Where the distiller writes before its output is renamed over the
/// reservation.
fn part_path(pdf_path: &Path) -> PathBuf {
    let mut name = pdf_path.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    pdf_path.with_file_name(name)
}

/// Whether `name`, holding `len` bytes, is what a job leaves before it
/// finishes: its staged PostScript, the distiller's output before the rename,
/// or the name reservation before the rename fills it. A finished print is
/// never empty.
fn is_job_intermediate(name: &str, len: u64) -> bool {
    let Some(rest) = name.strip_prefix(PRINTED_PREFIX) else {
        return false;
    };
    rest.ends_with(".ps") || rest.ends_with(".pdf.part") || (rest.ends_with(".pdf") && len == 0)
}

/// Remove what the jobs of an earlier process left in the printed folder.
///
/// Runs once the receiver holds its endpoint and before any job is accepted.
/// Only that process runs jobs, so at that moment every intermediate in the
/// folder belongs to a job that can no longer finish.
fn reclaim_job_intermediates(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let intermediate = entry
            .file_name()
            .to_str()
            .is_some_and(|name| is_job_intermediate(name, meta.len()));
        if intermediate && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Create a path atomically, failing if anything is already there.
///
/// `exists()`-then-create is a race: two jobs naming themselves in the same
/// second resolve to the same `.pdf`, and the second overwrites the first with
/// no error reported. `create_new` cannot race.
fn claim(path: &Path) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
}

/// Reserve the user-facing pdf name, keeping the readable `(2)`/`(3)` suffixes.
/// The reservation is a real zero-byte file, so a concurrent job sees it and
/// takes the next number. Ghostscript writes a `.part` sibling renamed over it;
/// on Windows `fs::rename` is `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`, so
/// that step is atomic too.
fn reserve_pdf(dir: &Path, stem: &str) -> std::io::Result<PathBuf> {
    let first = dir.join(format!("{stem}.pdf"));
    match claim(&first) {
        Ok(()) => return Ok(first),
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
        _ => {}
    }
    // Bounded: an open range overflows rather than terminating.
    for n in 2..10_000u32 {
        let candidate = dir.join(format!("{stem} ({n}).pdf"));
        match claim(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "too many printed files with the same name",
    ))
}

/// Distil one staged PostScript job into the printed folder and return the
/// finished PDF.
///
/// The PDF is written under a `.part` name and renamed over a zero-byte
/// reservation, so the final name holds a complete file or nothing.
/// `before_rename` runs once that name is known and the PDF is complete; an
/// error from it fails the conversion. On failure the printed folder keeps
/// nothing and `staged` is untouched.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn convert_staged(
    staged: &Path,
    stem: &str,
    before_rename: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    let dir = printed_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("cannot create the printed-jobs folder: {e}"))?;
    let pdf_path =
        reserve_pdf(&dir, stem).map_err(|e| format!("cannot name the printed file: {e}"))?;
    let part_path = part_path(&pdf_path);
    let finished = (|| {
        let exe = std::env::current_exe().map_err(|_| "cannot resolve the app path".to_string())?;
        let mut cmd = std::process::Command::new(exe);
        cmd.arg("distill")
            .arg(staged)
            .arg("--output")
            .arg(&part_path)
            .arg("--preset")
            .arg("printer");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        match crate::gs::output_within(cmd, Duration::from_secs(2 * 60 * 60)) {
            Ok(out) if out.status.success() && part_path.is_file() => {}
            Ok(out) => {
                return Err(format!(
                    "the print job could not be converted: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ))
            }
            Err(e) => return Err(format!("the converter could not finish: {e}")),
        }
        before_rename(&pdf_path)?;
        std::fs::rename(&part_path, &pdf_path)
            .map_err(|e| format!("could not finalize the printed file: {e}"))
    })();
    match finished {
        Ok(()) => Ok(pdf_path),
        Err(e) => {
            // A zero-byte PDF would look like a finished print and keep the
            // name taken.
            let _ = std::fs::remove_file(&part_path);
            let _ = std::fs::remove_file(&pdf_path);
            Err(e)
        }
    }
}

/// Open a printed PDF through the normal open funnel, exactly what a second
/// instance's argv does.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn open_printed(app: &AppHandle, pdf_path: &Path) {
    if let Some(state) = app.try_state::<PrinterState>() {
        state.last_job_error.lock().unwrap().clear();
    }
    let canonical = crate::commands::canonical_path(&pdf_path.to_string_lossy());
    crate::app_windows::route_open(app, vec![canonical], false);
}

/// Start the receiver: the app-setup hook. Never panics: every failure
/// becomes a named status the Settings block shows.
#[cfg(windows)]
pub fn start_listener(app: &AppHandle) {
    windows_receiver::start(app);
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn start_listener(_app: &AppHandle) {}

fn run_powershell(args: &[&str]) -> Result<String, String> {
    let executable = powershell_executable()?;
    let mut cmd = std::process::Command::new(&executable);
    #[cfg(windows)]
    configure_powershell_environment(&mut cmd, &executable)?;
    cmd.arg("-NoProfile").arg("-NonInteractive").arg("-Command");
    for a in args {
        cmd.arg(a);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|e| format!("Could not run PowerShell: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_executable_under(system_dir: &Path) -> PathBuf {
    system_dir
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_modules_directory(executable: &Path) -> Result<PathBuf, String> {
    executable
        .parent()
        .map(|directory| directory.join("Modules"))
        .ok_or_else(|| "Could not locate the PowerShell module directory.".to_string())
}

#[cfg(windows)]
fn configure_powershell_environment(
    command: &mut std::process::Command,
    executable: &Path,
) -> Result<(), String> {
    command.env("PSModulePath", powershell_modules_directory(executable)?);
    Ok(())
}

fn powershell_executable() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;

        let mut buffer = vec![0u16; 32_768];
        let length = unsafe {
            windows::Win32::System::SystemInformation::GetSystemDirectoryW(Some(&mut buffer))
        } as usize;
        if length == 0 || length >= buffer.len() {
            return Err("Could not locate the Windows system directory.".to_string());
        }
        let system_dir = PathBuf::from(OsString::from_wide(&buffer[..length]));
        Ok(powershell_executable_under(&system_dir))
    }
    #[cfg(not(windows))]
    {
        Ok(PathBuf::from("powershell.exe"))
    }
}

fn encode_powershell_command(script_body: &str) -> String {
    let utf16le: Vec<u8> = script_body
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16le)
}

fn elevated_script_body(script_body: &str) -> String {
    format!("$env:PSModulePath = Join-Path $PSHOME 'Modules'\r\n{script_body}")
}

fn elevation_command(script_body: &str) -> String {
    let encoded = encode_powershell_command(&elevated_script_body(script_body));
    format!(
        "$argumentList = '-NoProfile -ExecutionPolicy Bypass -EncodedCommand {encoded}'; \
         $systemPowerShell = Join-Path $PSHOME 'powershell.exe'; \
         $p = Start-Process -Verb RunAs -Wait -PassThru -FilePath $systemPowerShell \
         -ArgumentList $argumentList; exit $p.ExitCode"
    )
}

/// A legacy staged-script name left by a process killed during elevation.
fn elevated_script_owner(entry: &str) -> Option<u32> {
    let (label, pid) = entry
        .strip_prefix("opdfs-printer-")?
        .strip_suffix(".ps1")?
        .rsplit_once('-')?;
    if label.is_empty() || !label.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    crate::staging::decimal_pid(pid)
}

/// Remove the scripts of processes killed while their elevation was pending.
fn reclaim_elevated_scripts(dir: &Path, own: u32, running: impl Fn(u32) -> bool) -> usize {
    crate::staging::reclaim(dir, own, elevated_script_owner, running)
}

/// What a declined UAC prompt reports; the printer commands show it as is.
pub(crate) const ELEVATION_DECLINED: &str =
    "The administrator prompt was declined — the printer was not changed.";

/// Run a PowerShell script through ONE visible UAC elevation. Passing the
/// script as encoded command text removes the disk path and its swap window.
fn run_elevated_script(script_body: &str) -> Result<(), String> {
    let dir = std::env::temp_dir();
    let own = std::process::id();
    reclaim_elevated_scripts(&dir, own, crate::staging::process_running);
    let command = elevation_command(script_body);
    // Leave room for powershell.exe, its switches and CreateProcess quoting.
    // Windows rejects process command lines at 32,767 UTF-16 code units.
    if command.encode_utf16().count().saturating_add(512) >= 32_767 {
        return Err(
            "The printer setup command exceeds the Windows command-line limit.".to_string(),
        );
    }
    let result = run_powershell(&[&command]);
    result.map(|_| ()).map_err(|e| {
        if e.contains("canceled") || e.contains("cancelled") || e.contains("The operation was") {
            ELEVATION_DECLINED.to_string()
        } else {
            e
        }
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualPrinterStatus {
    pub installed: bool,
    pub listener: String,
    pub last_job_error: String,
    pub printer_name: String,
    /// An update removed the machine's loopback printer, none is left, and
    /// this account has neither installed nor removed its own printer since.
    pub replaced: bool,
    /// A printer of the releases that delivered jobs over loopback TCP is
    /// still installed.
    pub legacy_present: bool,
    /// The folder of jobs taken from the queue and not yet converted
    /// (Windows); empty elsewhere.
    pub staging: String,
    /// Why the print service could not list its printers; empty while it
    /// answers. `installed` means nothing while this is set.
    pub service_error: String,
}

/// The virtual printer needs a print-queue backend; without one every command
/// refuses by name before running anything.
fn virtual_printer_available() -> Result<(), String> {
    if crate::commands::PlatformCapabilities::current().virtual_printer {
        Ok(())
    } else {
        Err(crate::platform::Unsupported::new(crate::platform::feature::VIRTUAL_PRINTER).into())
    }
}

/// `spectrapdf virtual-printer <action>`: the installer's entry point, run
/// elevated.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum CliAction {
    /// Remove the queue of releases that delivered jobs over loopback TCP.
    RetireLegacy,
    /// Remove every account's printer and port.
    RemoveAll,
}

pub fn run_cli(action: CliAction) -> i32 {
    #[cfg(windows)]
    let outcome = match action {
        CliAction::RetireLegacy => windows_receiver::retire_legacy(),
        CliAction::RemoveAll => windows_receiver::remove_all(),
    };
    #[cfg(not(windows))]
    let outcome: Result<(), String> = {
        let _ = action;
        Err(crate::platform::Unsupported::new(crate::platform::feature::VIRTUAL_PRINTER).into())
    };
    match outcome {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

/// Start the receiver of the held CUPS queue — the app-setup hook.
#[cfg(target_os = "linux")]
pub fn start_listener(app: &AppHandle) {
    linux::start_listener(app);
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn virtual_printer_status(app: AppHandle) -> Result<VirtualPrinterStatus, String> {
    virtual_printer_available()?;
    linux::status(&app)
}

/// `comment` is the queue's location text, in the installing user's language.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn install_virtual_printer(comment: Option<String>) -> Result<(), String> {
    virtual_printer_available()?;
    linux::install(comment.as_deref().unwrap_or_default())
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn uninstall_virtual_printer() -> Result<(), String> {
    virtual_printer_available()?;
    linux::uninstall()
}

#[cfg(windows)]
#[tauri::command]
pub async fn virtual_printer_status(app: AppHandle) -> Result<VirtualPrinterStatus, String> {
    virtual_printer_available()?;
    windows_receiver::status(&app)
}

/// `comment` is the queue's Comment field, in the installing user's language.
#[cfg(windows)]
#[tauri::command]
pub async fn install_virtual_printer(comment: Option<String>) -> Result<(), String> {
    virtual_printer_available()?;
    windows_receiver::install(comment.as_deref().unwrap_or_default())
}

#[cfg(windows)]
#[tauri::command]
pub async fn uninstall_virtual_printer() -> Result<(), String> {
    virtual_printer_available()?;
    windows_receiver::uninstall()
}

#[cfg(not(any(windows, target_os = "linux")))]
#[tauri::command]
pub async fn virtual_printer_status(app: AppHandle) -> Result<VirtualPrinterStatus, String> {
    let _ = app;
    virtual_printer_available()?;
    Err(crate::platform::Unsupported::new(crate::platform::feature::VIRTUAL_PRINTER).into())
}

#[cfg(not(any(windows, target_os = "linux")))]
#[tauri::command]
pub async fn install_virtual_printer() -> Result<(), String> {
    virtual_printer_available()?;
    Err(crate::platform::Unsupported::new(crate::platform::feature::VIRTUAL_PRINTER).into())
}

#[cfg(not(any(windows, target_os = "linux")))]
#[tauri::command]
pub async fn uninstall_virtual_printer() -> Result<(), String> {
    virtual_printer_available()?;
    Err(crate::platform::Unsupported::new(crate::platform::feature::VIRTUAL_PRINTER).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevation_command_carries_the_exact_utf16le_script_without_a_file_path() {
        let script = "$value = 'O''; Start-Process calc;#'; exit 7";
        let elevated_script = elevated_script_body(script);
        assert!(elevated_script.starts_with(
            "$env:PSModulePath = Join-Path $PSHOME 'Modules'\r\n"
        ));
        let encoded = encode_powershell_command(&elevated_script);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap(), elevated_script);

        let command = elevation_command(script);
        assert!(command.contains(&format!("-EncodedCommand {encoded}")));
        assert!(command.contains("Join-Path $PSHOME 'powershell.exe'"));
        assert!(!command.contains(" -File "));
        assert!(!command.contains(".ps1"));
    }

    #[cfg(windows)]
    #[test]
    fn printer_powershell_path_is_rooted_in_the_windows_system_directory() {
        let executable =
            powershell_executable_under(Path::new(r"C:\Windows\System32"));
        assert_eq!(
            executable,
            PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
        );
        assert_eq!(
            powershell_modules_directory(&executable).unwrap(),
            PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\Modules"),
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_executed_powershell_path_is_absolute_and_system_rooted() {
        let path = powershell_executable().unwrap();
        assert!(path.is_absolute(), "{path:?}");
        assert!(path.ends_with(Path::new(
            r"WindowsPowerShell\v1.0\powershell.exe"
        )), "{path:?}");
    }

    #[cfg(windows)]
    #[test]
    fn powershell_does_not_load_modules_from_the_inherited_user_path() {
        let executable = powershell_executable().unwrap();
        let mut expected_modules = Vec::new();
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            expected_modules.push(
                PathBuf::from(program_files)
                    .join("WindowsPowerShell")
                    .join("Modules"),
            );
        }
        expected_modules.push(powershell_modules_directory(&executable).unwrap());
        let mut command = std::process::Command::new(&executable);
        command.env("PSModulePath", r"C:\Users\Public\UntrustedModules");
        configure_powershell_environment(&mut command, &executable).unwrap();
        let output = command
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg("[Console]::Out.Write($env:PSModulePath)")
            .output()
            .unwrap();
        assert!(output.status.success());
        let actual = String::from_utf8(output.stdout).unwrap();
        let actual_modules: Vec<_> = std::env::split_paths(std::ffi::OsStr::new(&actual)).collect();
        assert_eq!(actual_modules, expected_modules);
    }

    #[cfg(windows)]
    #[test]
    fn elevated_child_executes_encoded_script_and_returns_its_exit_code() {
        use std::process::Command;

        let command = elevation_command("exit 7\r\n").replace("-Verb RunAs ", "");
        let output = Command::new(powershell_executable().unwrap())
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(command)
            .output()
            .unwrap();

        assert_eq!(
            output.status.code(),
            Some(7),
            "stdout: {}; stderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn printed_names_never_collide() {
        let dir = std::env::temp_dir().join("opdfs-vprint-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let first = reserve_pdf(&dir, "Printed 1").unwrap();
        assert_eq!(first.file_name().unwrap(), "Printed 1.pdf");
        // The reservation is a real file, so the next caller sees it.
        let second = reserve_pdf(&dir, "Printed 1").unwrap();
        assert_eq!(second.file_name().unwrap(), "Printed 1 (2).pdf");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// N jobs naming themselves in the same second: each must get its own
    /// output name.
    #[test]
    fn concurrent_jobs_never_share_a_path() {
        let dir = std::env::temp_dir().join("opdfs-vprint-concurrent");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        const N: usize = 16;
        let stem = "Printed 1700000000"; // one fixed second, on purpose
        let mut handles = Vec::new();
        for _ in 0..N {
            let d = dir.clone();
            handles.push(std::thread::spawn(move || {
                reserve_pdf(&d, stem).expect("pdf")
            }));
        }
        let mut pdf_paths: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        pdf_paths.sort();
        pdf_paths.dedup();
        assert_eq!(pdf_paths.len(), N, "two jobs shared an output name");
        for p in &pdf_paths {
            assert!(p.is_file(), "reservation not actually on disk: {p:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn names(dir: &Path) -> std::collections::BTreeSet<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect()
    }

    #[test]
    fn a_bound_listener_clears_only_what_unfinished_jobs_left() {
        let dir = tempfile::tempdir().unwrap();
        let stem = format!("{PRINTED_PREFIX}1700000000");
        std::fs::write(dir.path().join(format!("{stem}-0.ps")), b"%!PS-Adobe-3.0").unwrap();
        let reserved = reserve_pdf(dir.path(), &stem).unwrap();
        let distilled = part_path(&reserved);
        std::fs::write(&distilled, b"%PDF-1.7 unfinished").unwrap();
        let finished = reserve_pdf(dir.path(), &stem).unwrap();
        std::fs::write(&finished, b"%PDF-1.7 finished").unwrap();
        let unrelated = [
            ("notes.ps", &b"%!PS"[..]),
            ("empty.pdf", &b""[..]),
            ("document-stage-4300-abcdef.pdf", &b"%PDF"[..]),
        ];
        for (name, bytes) in unrelated {
            std::fs::write(dir.path().join(name), bytes).unwrap();
        }

        assert_eq!(reclaim_job_intermediates(dir.path()), 3);

        let mut kept: std::collections::BTreeSet<String> =
            unrelated.iter().map(|(name, _)| name.to_string()).collect();
        kept.insert(finished.file_name().unwrap().to_str().unwrap().to_string());
        assert_eq!(names(dir.path()), kept);
    }

    #[test]
    fn an_elevation_reclaims_only_the_scripts_of_stopped_processes() {
        const OWN: u32 = 4100;
        const LIVE: u32 = 4200;
        const DEAD: u32 = 4300;
        let dir = tempfile::tempdir().unwrap();
        let script = |label: &str, pid: u32| format!("opdfs-printer-{label}-{pid}.ps1");
        let kept = [
            script("install", OWN),
            script("remove", LIVE),
            "opdfs-printer-install-x.ps1".to_string(),
            "opdfs-printer--4300.ps1".to_string(),
            "opdfs-printer-re move-4300.ps1".to_string(),
            "opdfs-printer-install-04300.ps1".to_string(),
            "opdfs-printer-install-4300.ps1.bak".to_string(),
            "other-install-4300.ps1".to_string(),
        ];
        let reclaimed = [script("install", DEAD), script("remove", DEAD)];
        for name in kept.iter().chain(&reclaimed) {
            std::fs::write(dir.path().join(name), "exit 0").unwrap();
        }

        assert_eq!(
            reclaim_elevated_scripts(dir.path(), OWN, |pid| pid == LIVE),
            2
        );

        let kept: std::collections::BTreeSet<String> = kept.into_iter().collect();
        assert_eq!(names(dir.path()), kept);
    }
}
