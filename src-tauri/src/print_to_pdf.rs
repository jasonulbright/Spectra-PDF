//! The virtual printer: "Spectra PDF" appears in every
//! application's print dialog; printing to it lands the pages in this app
//! as a fresh PDF.
//!
//! Shape: a Windows printer using the IN-BOX "Microsoft PS Class Driver" on
//! a standard TCP/IP RAW port aimed at 127.0.0.1:9100, where THIS APP
//! listens (loopback only). The spooler streams PostScript; the listener
//! hands it to the configured Ghostscript through the CLI `distill` arm,
//! and the finished PDF opens through the normal open funnel
//! (the second-instance `app:openFile` event). No driver is shipped, no
//! service is installed — the OS driver does the rendering contract and the
//! listener lives only while the app runs (tray-residency counts), the same
//! posture as watched folders.
//!
//! Printer/port INSTALLATION needs admin (ports are machine objects), so
//! Install/Remove run a visible, user-initiated UAC elevation with a
//! UTF-16LE-encoded PowerShell command — never a silent elevation or a
//! swappable script file. A print sent
//! while the app is closed sits in the Windows queue erroring-retrying until
//! the app (and so the listener) is back; the Settings block says exactly
//! that.

use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use tauri::{AppHandle, Manager};

pub const PRINTER_NAME: &str = "Spectra PDF";
pub const PORT_NAME: &str = "SpectraPDF_9100";
pub const PORT: u16 = 9100;
/// A print job larger than this is refused (a runaway client, not a page).
const MAX_JOB_BYTES: u64 = 512 * 1024 * 1024;
/// Idle read timeout for one connection. RAW/JetDirect clients stream and
/// close; a spooler may pause mid-job, so this is generous. Without it a
/// client that connects and never writes holds the socket forever.
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// A client cannot keep one of the eight job slots alive forever by sending
/// bytes just before each idle timeout expires.
const MAX_JOB_RECEIVE_DURATION: Duration = Duration::from_secs(10 * 60);
/// Concurrent job cap. The accept loop does not serialise reads, so
/// thread-per-connection needs a bound.
const MAX_CONCURRENT_JOBS: usize = 8;

/// Distinguishes jobs arriving within the same second. Only one process binds
/// the port, so a process-local counter suffices; `create_new` is what
/// guarantees uniqueness.
static JOB_SEQ: AtomicU64 = AtomicU64::new(0);
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Releases the slot however the job thread leaves, including a panic.
struct JobSlot;
impl Drop for JobSlot {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}

pub struct PrinterState {
    /// "listening" once the loopback socket is up, else the bind error —
    /// shown verbatim in Settings so a taken port is a named condition.
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

fn printed_dir() -> PathBuf {
    std::env::temp_dir().join("spectrapdf").join("printed")
}

/// How every name a job writes into the printed folder begins.
const PRINTED_PREFIX: &str = "Printed ";

fn timestamp_name() -> String {
    // Seconds precision keeps names sortable and human. Not unique; `claim`
    // guarantees that.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{PRINTED_PREFIX}{now}")
}

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
/// Runs once the port is bound and before any job is accepted. Only the
/// process that holds the port runs jobs, so at that moment every
/// intermediate in the folder belongs to a job that can no longer finish.
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
/// second resolve to the same `.ps` and `.pdf`, and the second overwrites the
/// first's staged PostScript with no error reported. `create_new` cannot race.
fn claim(path: &Path) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
}

struct StagedPostscript {
    path: PathBuf,
    file: Option<std::fs::File>,
    cleanup: bool,
}

impl StagedPostscript {
    fn file_mut(&mut self) -> &mut std::fs::File {
        self.file.as_mut().expect("staged PostScript handle is open")
    }

    /// Keep a test reservation on disk after closing its writer.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn retain_path(mut self) -> PathBuf {
        self.file.take();
        self.cleanup = false;
        self.path.clone()
    }
}

impl Drop for StagedPostscript {
    fn drop(&mut self) {
        self.file.take();
        if self.cleanup {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Reserve the staging path for one job's PostScript. Internal; never seen.
fn claim_staging(dir: &Path, stem: &str) -> std::io::Result<StagedPostscript> {
    let seq = JOB_SEQ.fetch_add(1, Ordering::Relaxed);
    for extra in 0..1000u64 {
        let candidate = dir.join(format!("{stem}-{}.ps", seq + extra));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Ghostscript may read the completed file while this reservation
            // stays open; other processes cannot replace or edit it.
            options.share_mode(1); // FILE_SHARE_READ
        }
        match options.open(&candidate) {
            Ok(file) => {
                return Ok(StagedPostscript {
                    path: candidate,
                    file: Some(file),
                    cleanup: true,
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not claim a staging path",
    ))
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

fn handle_job(app: &AppHandle, stem: &str, staged: StagedPostscript) {
    let record_error = |msg: String| {
        eprintln!("virtual printer: {msg}");
        if let Some(state) = app.try_state::<PrinterState>() {
            *state.last_job_error.lock().unwrap() = msg;
        }
    };
    let dir = printed_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return record_error(format!("cannot create the printed-jobs folder: {e}"));
    }
    let ps_path = staged.path.clone();
    let pdf_path = match reserve_pdf(&dir, stem) {
        Ok(p) => p,
        Err(e) => {
            return record_error(format!("cannot name the printed file: {e}"));
        }
    };
    // Distil to a sibling and rename over the reservation, so a reader never
    // sees a half-written PDF at the final name.
    let part_path = part_path(&pdf_path);
    let Ok(exe) = std::env::current_exe() else {
        let _ = std::fs::remove_file(&pdf_path);
        return record_error("cannot resolve the app path".to_string());
    };
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("distill")
        .arg(&ps_path)
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
    let ok = match crate::gs::output_within(cmd, Duration::from_secs(2 * 60 * 60)) {
        Ok(out) if out.status.success() && part_path.is_file() => {
            // Replace the reservation with the finished file.
            match std::fs::rename(&part_path, &pdf_path) {
                Ok(()) => true,
                Err(e) => {
                    record_error(format!("could not finalize the printed file: {e}"));
                    false
                }
            }
        }
        Ok(out) => {
            record_error(format!(
                "the print job could not be converted: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
            false
        }
        Err(e) => {
            record_error(format!("the converter could not finish: {e}"));
            false
        }
    };
    if !ok {
        // Release the reserved name: a zero-byte PDF would look like a
        // successful print and consume the name permanently.
        let _ = std::fs::remove_file(&part_path);
        let _ = std::fs::remove_file(&pdf_path);
        return;
    }
    if let Some(state) = app.try_state::<PrinterState>() {
        state.last_job_error.lock().unwrap().clear();
    }
    // The normal open funnel — exactly what a second instance's argv does.
    let canonical = crate::commands::canonical_path(&pdf_path.to_string_lossy());
    crate::app_windows::route_open(app, vec![canonical], false);
}

/// Start the loopback listener — the app-setup hook. Never panics: a taken
/// port becomes a named status the Settings block shows.
pub fn start_listener(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(l) => l,
            Err(e) => {
                if let Some(state) = handle.try_state::<PrinterState>() {
                    *state.listener_status.lock().unwrap() =
                        format!("port {PORT} is unavailable: {e}");
                }
                return;
            }
        };
        reclaim_job_intermediates(&printed_dir());
        if let Some(state) = handle.try_state::<PrinterState>() {
            *state.listener_status.lock().unwrap() = "listening".to_string();
        }
        serve(
            listener,
            READ_IDLE_TIMEOUT,
            printed_dir(),
            move |stem, staged| handle_job(&handle, &stem, staged),
        );
    });
}

/// The accept loop, separated from the app wiring so the stall behaviour is
/// testable against real sockets: a test binds an ephemeral port and passes a
/// plain sink, production passes `handle_job`. `idle_timeout` and the staging
/// directory are parameters so the socket behaviour and on-disk result can be
/// tested without the app's global temp folder.
fn serve(
    listener: TcpListener,
    idle_timeout: Duration,
    staging_dir: PathBuf,
    on_job: impl Fn(String, StagedPostscript) + Clone + Send + 'static,
) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        // The read happens on the job thread. On the accept loop, one
        // client that connects and never closes blocks every later print
        // until restart.
        if IN_FLIGHT.load(Ordering::Relaxed) >= MAX_CONCURRENT_JOBS {
            eprintln!("virtual printer: {MAX_CONCURRENT_JOBS} jobs already in flight, refused");
            drop(stream);
            continue;
        }
        IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
        let sink = on_job.clone();
        let staging_dir = staging_dir.clone();
        std::thread::spawn(move || {
            let _slot = JobSlot;
            let mut stream = stream;
            // Per-read idle timeout: a half-open connection dies on its own
            // thread instead of holding the listener.
            let _ = stream.set_read_timeout(Some(idle_timeout));
            if let Err(error) = std::fs::create_dir_all(&staging_dir) {
                eprintln!("virtual printer: cannot create staging folder: {error}");
                return;
            }
            let stem = timestamp_name();
            let mut staged = match claim_staging(&staging_dir, &stem) {
                Ok(staged) => staged,
                Err(error) => {
                    eprintln!("virtual printer: cannot reserve the staging file: {error}");
                    return;
                }
            };
            // Stream RAW/JetDirect bytes straight to disk. Retaining every
            // concurrent 512 MiB job in a Vec could use 4 GiB before
            // Ghostscript starts. Read one byte over the cap to detect
            // overflow; timeout and other failures drop the partial stage.
            let count = match copy_job(
                &mut stream,
                staged.file_mut(),
                MAX_JOB_BYTES,
                MAX_JOB_RECEIVE_DURATION,
            ) {
                Ok(count) => count,
                Err(error) => {
                    eprintln!("virtual printer: could not receive the job: {error}");
                    return;
                }
            };
            if count == 0 {
                return; // port probes (and the spooler's SNMP pokes) are not jobs
            }
            if count > MAX_JOB_BYTES {
                eprintln!("virtual printer: job over the {MAX_JOB_BYTES}-byte cap, refused");
                return;
            }
            if let Err(error) = staged.file_mut().flush() {
                eprintln!("virtual printer: could not finish staging the job: {error}");
                return;
            }
            sink(stem, staged);
        });
    }
}

fn copy_job<R: std::io::Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    limit: u64,
    max_duration: Duration,
) -> std::io::Result<u64> {
    let deadline = std::time::Instant::now() + max_duration;
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "print job receive deadline exceeded",
            ));
        }
        let remaining = limit.saturating_add(1).saturating_sub(total);
        if remaining == 0 {
            return Ok(total);
        }
        let capacity = remaining.min(buffer.len() as u64) as usize;
        let read = reader.read(&mut buffer[..capacity])?;
        if read == 0 {
            return Ok(total);
        }
        writer.write_all(&buffer[..read])?;
        total = total.saturating_add(read as u64);
    }
}

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
            "The administrator prompt was declined — the printer was not changed.".to_string()
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
}

fn printer_check_functions() -> String {
    format!(
        "function Test-SpectraPdfPort($candidate) {{\n\
           if ($null -eq $candidate) {{ return $false }}\n\
           return ([string]$candidate.PrinterHostAddress -eq '127.0.0.1' -and [int]$candidate.PortNumber -eq {PORT} -and [int]$candidate.Protocol -eq 1)\n\
         }}\n\
         function Test-SpectraPdfPrinter($candidate) {{\n\
           return ($null -ne $candidate -and [string]$candidate.DriverName -eq 'Microsoft PS Class Driver' -and [string]$candidate.PortName -eq '{PORT_NAME}')\n\
         }}\n"
    )
}

fn printer_status_script() -> String {
    format!(
        "{}$printer = Get-Printer -Name '{PRINTER_NAME}' -ErrorAction SilentlyContinue; \
         if (Test-SpectraPdfPrinter $printer) {{ \
           $port = Get-PrinterPort -Name '{PORT_NAME}' -ErrorAction SilentlyContinue; \
           if (Test-SpectraPdfPort $port) {{ 'yes' }} else {{ 'no' }} \
         }} else {{ 'no' }}",
        printer_check_functions()
    )
}

fn install_printer_script() -> String {
    format!(
        "{}$ErrorActionPreference = 'Stop'\r\n\
         $printer = Get-Printer -Name '{PRINTER_NAME}' -ErrorAction SilentlyContinue\r\n\
         if ($printer -and -not (Test-SpectraPdfPrinter $printer)) {{ throw 'A different printer already uses the Spectra PDF name.' }}\r\n\
         $port = Get-PrinterPort -Name '{PORT_NAME}' -ErrorAction SilentlyContinue\r\n\
         $createdPort = $false\r\n\
         $createdPrinter = $false\r\n\
         try {{\r\n\
           if (-not $port) {{\r\n\
             Add-PrinterPort -Name '{PORT_NAME}' -PrinterHostAddress '127.0.0.1' -PortNumber {PORT}\r\n\
             $createdPort = $true\r\n\
             $port = Get-PrinterPort -Name '{PORT_NAME}' -ErrorAction Stop\r\n\
           }}\r\n\
           if (-not (Test-SpectraPdfPort $port)) {{ throw 'The Spectra PDF port name is already in use by a different port configuration.' }}\r\n\
           if (-not $printer) {{\r\n\
             Add-Printer -Name '{PRINTER_NAME}' -DriverName 'Microsoft PS Class Driver' -PortName '{PORT_NAME}'\r\n\
             $createdPrinter = $true\r\n\
             $printer = Get-Printer -Name '{PRINTER_NAME}' -ErrorAction Stop\r\n\
           }}\r\n\
           if (-not (Test-SpectraPdfPrinter $printer) -or -not (Test-SpectraPdfPort $port)) {{ throw 'The installed Spectra PDF printer configuration could not be verified.' }}\r\n\
         }} catch {{\r\n\
           $installError = $_\r\n\
           $rollbackErrors = @()\r\n\
           if ($createdPrinter) {{\r\n\
             try {{\r\n\
               $installedPrinter = Get-Printer -Name '{PRINTER_NAME}' -ErrorAction SilentlyContinue\r\n\
               if (Test-SpectraPdfPrinter $installedPrinter) {{ Remove-Printer -Name '{PRINTER_NAME}' -ErrorAction Stop }}\r\n\
             }} catch {{ $rollbackErrors += $_.Exception.Message }}\r\n\
           }}\r\n\
           if ($createdPort) {{\r\n\
             try {{\r\n\
               $users = @(Get-Printer -ErrorAction Stop | Where-Object {{ $_.PortName -eq '{PORT_NAME}' }})\r\n\
               $currentPort = Get-PrinterPort -Name '{PORT_NAME}' -ErrorAction SilentlyContinue\r\n\
               if ($users.Count -eq 0 -and (Test-SpectraPdfPort $currentPort)) {{ Remove-PrinterPort -Name '{PORT_NAME}' -ErrorAction Stop }}\r\n\
             }} catch {{ $rollbackErrors += $_.Exception.Message }}\r\n\
           }}\r\n\
           if ($rollbackErrors.Count -gt 0) {{\r\n\
             throw \"$($installError.Exception.Message) (rollback failed: $($rollbackErrors -join '; '))\"\r\n\
           }}\r\n\
           throw $installError\r\n\
         }}",
        printer_check_functions()
    )
}

fn uninstall_printer_script() -> String {
    format!(
        "{}$ErrorActionPreference = 'Stop'\r\n\
         $printer = Get-Printer -Name '{PRINTER_NAME}' -ErrorAction SilentlyContinue\r\n\
         if ($printer) {{\r\n\
           if (-not (Test-SpectraPdfPrinter $printer)) {{ throw 'A different printer already uses the Spectra PDF name; it was not removed.' }}\r\n\
           Remove-Printer -Name '{PRINTER_NAME}'\r\n\
         }}\r\n\
         $users = @(Get-Printer -ErrorAction Stop | Where-Object {{ $_.PortName -eq '{PORT_NAME}' }})\r\n\
         $port = Get-PrinterPort -Name '{PORT_NAME}' -ErrorAction SilentlyContinue\r\n\
         if ($users.Count -eq 0 -and (Test-SpectraPdfPort $port)) {{ Remove-PrinterPort -Name '{PORT_NAME}' -ErrorAction Stop }}",
        printer_check_functions()
    )
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

#[tauri::command]
pub async fn virtual_printer_status(app: AppHandle) -> Result<VirtualPrinterStatus, String> {
    virtual_printer_available()?;
    let installed = run_powershell(&[&printer_status_script()])
        .map(|out| out.trim().eq_ignore_ascii_case("yes"))
        .unwrap_or(false);
    let state = app.state::<PrinterState>();
    let listener = state.listener_status.lock().unwrap().clone();
    let last_job_error = state.last_job_error.lock().unwrap().clone();
    Ok(VirtualPrinterStatus {
        installed,
        listener,
        last_job_error,
        printer_name: PRINTER_NAME.to_string(),
    })
}

#[tauri::command]
pub async fn install_virtual_printer() -> Result<(), String> {
    virtual_printer_available()?;
    let script = install_printer_script();
    run_elevated_script(&script)
}

#[tauri::command]
pub async fn uninstall_virtual_printer() -> Result<(), String> {
    virtual_printer_available()?;
    let script = uninstall_printer_script();
    run_elevated_script(&script)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn run_printer_script_probe(setup: &str, script: &str) -> Result<String, String> {
        let harness = r#"
$script:printers = @()
$script:ports = @()
$script:events = @()
function Get-Printer {
    [CmdletBinding()]
    param([string]$Name)
    if ($PSBoundParameters.ContainsKey('Name')) {
        return @($script:printers | Where-Object { $_.Name -eq $Name })
    }
    return @($script:printers)
}
function Get-PrinterPort {
    [CmdletBinding()]
    param([string]$Name)
    return @($script:ports | Where-Object { $_.Name -eq $Name })
}
function Add-PrinterPort {
    [CmdletBinding()]
    param([string]$Name, [string]$PrinterHostAddress, [uint32]$PortNumber)
    $script:events += 'add-port'
    $script:ports += [pscustomobject]@{ Name=$Name; PrinterHostAddress=$PrinterHostAddress; PortNumber=$PortNumber; Protocol=1 }
}
function Remove-PrinterPort {
    [CmdletBinding()]
    param([string]$Name)
    $script:events += 'remove-port'
    $script:ports = @($script:ports | Where-Object { $_.Name -ne $Name })
}
function Add-Printer {
    [CmdletBinding()]
    param([string]$Name, [string]$DriverName, [string]$PortName)
    $script:events += 'add-printer'
    $script:printers += [pscustomobject]@{ Name=$Name; DriverName=$DriverName; PortName=$PortName }
}
function Remove-Printer {
    [CmdletBinding()]
    param([string]$Name)
    $script:events += 'remove-printer'
    $script:printers = @($script:printers | Where-Object { $_.Name -ne $Name })
}
__SETUP__
try {
    __SCRIPT__
    $script:result = 'OK'
} catch {
    $script:result = 'ERROR'
    $script:message = $_.Exception.Message
}
"RESULT=$($script:result)"
"ERROR=$($script:message)"
"EVENTS=$($script:events -join ',')"
"PRINTERS=$($script:printers.Name -join ',')"
"PORTS=$($script:ports.Name -join ',')"
"#;
        let command = harness
            .replace("__SETUP__", setup)
            .replace("__SCRIPT__", script);
        run_powershell(&[&command])
    }

    #[cfg(windows)]
    fn matching_port_record() -> &'static str {
        "$script:ports = @([pscustomobject]@{ Name='SpectraPDF_9100'; PrinterHostAddress='127.0.0.1'; PortNumber=9100; Protocol=1 })"
    }

    #[cfg(windows)]
    #[test]
    fn install_creates_and_reads_back_the_expected_printer_and_port() {
        let result = run_printer_script_probe("", &install_printer_script()).unwrap();
        assert!(result.contains("RESULT=OK"), "{result}");
        assert!(result.contains("EVENTS=add-port,add-printer"), "{result}");
        assert!(result.contains("PRINTERS=Spectra PDF"), "{result}");
        assert!(result.contains("PORTS=SpectraPDF_9100"), "{result}");
    }

    #[cfg(windows)]
    #[test]
    fn install_refuses_a_different_printer_with_the_product_name() {
        let setup = format!(
            "{}\n$script:printers = @([pscustomobject]@{{ Name='Spectra PDF'; DriverName='Microsoft Print to PDF'; PortName='FILE:' }})",
            matching_port_record()
        );
        let result = run_printer_script_probe(&setup, &install_printer_script()).unwrap();
        assert!(result.contains("RESULT=ERROR"), "{result}");
        assert!(result.contains("different printer already uses the Spectra PDF name"), "{result}");
        assert!(result.contains("EVENTS="), "{result}");
    }

    #[cfg(windows)]
    #[test]
    fn install_does_not_create_a_port_when_the_printer_name_is_foreign() {
        let setup = "$script:printers = @([pscustomobject]@{ Name='Spectra PDF'; DriverName='Microsoft Print to PDF'; PortName='FILE:' })";
        let result = run_printer_script_probe(setup, &install_printer_script()).unwrap();
        assert!(result.contains("RESULT=ERROR"), "{result}");
        assert!(result.contains("EVENTS=\r\n"), "{result}");
        assert!(result.contains("PORTS=\r\n"), "{result}");
    }

    #[cfg(windows)]
    #[test]
    fn install_removes_its_new_port_when_printer_creation_fails() {
        let setup = "function Add-Printer { throw 'simulated printer creation failure' }";
        let result = run_printer_script_probe(setup, &install_printer_script()).unwrap();
        assert!(result.contains("RESULT=ERROR"), "{result}");
        assert!(result.contains("EVENTS=add-port,remove-port"), "{result}");
        assert!(result.contains("PRINTERS="), "{result}");
        assert!(result.contains("PORTS="), "{result}");
    }

    #[cfg(windows)]
    #[test]
    fn install_refuses_a_port_name_with_a_different_endpoint_or_protocol() {
        let setup = "$script:ports = @([pscustomobject]@{ Name='SpectraPDF_9100'; PrinterHostAddress='203.0.113.7'; PortNumber=9100; Protocol=2 })";
        let result = run_printer_script_probe(setup, &install_printer_script()).unwrap();
        assert!(result.contains("RESULT=ERROR"), "{result}");
        assert!(result.contains("different port configuration"), "{result}");
        assert!(result.contains("EVENTS="), "{result}");
    }

    #[cfg(windows)]
    #[test]
    fn status_does_not_call_a_misconfigured_same_name_printer_installed() {
        let setup = format!(
            "{}\n$script:printers = @([pscustomobject]@{{ Name='Spectra PDF'; DriverName='Microsoft Print to PDF'; PortName='FILE:' }})",
            matching_port_record()
        );
        let result = run_printer_script_probe(&setup, &printer_status_script()).unwrap();
        assert!(result.lines().any(|line| line.trim() == "no"), "{result}");
        assert!(!result.lines().any(|line| line.trim() == "yes"), "{result}");
    }

    #[cfg(windows)]
    #[test]
    fn uninstall_keeps_a_port_still_used_by_another_printer() {
        let setup = format!(
            "{}\n$script:printers = @([pscustomobject]@{{ Name='Spectra PDF'; DriverName='Microsoft PS Class Driver'; PortName='SpectraPDF_9100' }}, [pscustomobject]@{{ Name='Other printer'; DriverName='Other driver'; PortName='SpectraPDF_9100' }})",
            matching_port_record()
        );
        let result = run_printer_script_probe(&setup, &uninstall_printer_script()).unwrap();
        assert!(result.contains("RESULT=OK"), "{result}");
        assert!(result.contains("EVENTS=remove-printer"), "{result}");
        assert!(result.contains("PRINTERS=Other printer"), "{result}");
        assert!(result.contains("PORTS=SpectraPDF_9100"), "{result}");
    }

    #[cfg(windows)]
    #[test]
    fn uninstall_removes_the_owned_printer_and_its_unused_port() {
        let setup = format!(
            "{}\n$script:printers = @([pscustomobject]@{{ Name='Spectra PDF'; DriverName='Microsoft PS Class Driver'; PortName='SpectraPDF_9100' }})",
            matching_port_record()
        );
        let result = run_printer_script_probe(&setup, &uninstall_printer_script()).unwrap();
        assert!(result.contains("RESULT=OK"), "{result}");
        assert!(result.contains("EVENTS=remove-printer,remove-port"), "{result}");
        assert!(result.contains("PRINTERS="), "{result}");
        assert!(result.contains("PORTS="), "{result}");
    }

    #[cfg(windows)]
    #[test]
    fn uninstall_refuses_to_remove_an_unrelated_same_name_printer() {
        let setup = "$script:printers = @([pscustomobject]@{ Name='Spectra PDF'; DriverName='Microsoft Print to PDF'; PortName='FILE:' })";
        let result = run_printer_script_probe(setup, &uninstall_printer_script()).unwrap();
        assert!(result.contains("RESULT=ERROR"), "{result}");
        assert!(result.contains("EVENTS="), "{result}");
        assert!(result.contains("PRINTERS=Spectra PDF"), "{result}");
    }

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
    /// staging path and its own output name.
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
                let ps = claim_staging(&d, stem).expect("staging").retain_path();
                let pdf = reserve_pdf(&d, stem).expect("pdf");
                (ps, pdf)
            }));
        }
        let claimed: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        let mut ps_paths: Vec<_> = claimed.iter().map(|(p, _)| p.clone()).collect();
        let mut pdf_paths: Vec<_> = claimed.iter().map(|(_, p)| p.clone()).collect();
        ps_paths.sort();
        ps_paths.dedup();
        pdf_paths.sort();
        pdf_paths.dedup();
        assert_eq!(ps_paths.len(), N, "two jobs shared a staging path");
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
        let stem = timestamp_name();
        let mut staged = claim_staging(dir.path(), &stem).unwrap();
        staged.file_mut().write_all(b"%!PS-Adobe-3.0").unwrap();
        let _ = staged.retain_path();
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

    #[test]
    fn install_scripts_are_pure_ascii() {
        // The standing .ps1 rule: a non-ASCII char in a BOM-less script is
        // read as ANSI by PS 5.1 and silently corrupts the parse.
        assert!(format!("{PRINTER_NAME}{PORT_NAME}").is_ascii());
        assert!(printer_status_script().is_ascii());
        assert!(install_printer_script().is_ascii());
        assert!(uninstall_printer_script().is_ascii());
    }

    /// the acceptance, against real sockets: one client that connects and
    /// never writes must not block later jobs. This is the exact wedge shape
    /// the fix exists for: the accept loop used to read each connection to
    /// EOF, so the silent client held every later print until app restart.
    #[test]
    fn a_stalled_client_does_not_block_other_jobs() {
        use std::io::Write;
        use std::sync::mpsc;

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let staging_dir = tempfile::tempdir().unwrap();
        let staging_path = staging_dir.path().to_path_buf();
        std::thread::spawn(move || {
            serve(listener, Duration::from_secs(5), staging_path, move |_, staged| {
                let _ = tx.send(std::fs::read(&staged.path).unwrap());
            })
        });

        // The stalled client: connected, silent, held open across the test.
        let stalled = std::net::TcpStream::connect(addr).unwrap();

        let mut expected = Vec::new();
        for i in 0..3u8 {
            let payload = format!("%!PS job {i}").into_bytes();
            expected.push(payload.clone());
            let mut c = std::net::TcpStream::connect(addr).unwrap();
            c.write_all(&payload).unwrap();
            // Close = end of job (the RAW/JetDirect contract).
            drop(c);
        }

        let mut got = Vec::new();
        for _ in 0..3 {
            got.push(rx.recv_timeout(Duration::from_secs(10)).expect(
                "a completed job never arrived — blocked behind a stalled connection",
            ));
        }
        got.sort();
        expected.sort();
        assert_eq!(got, expected);
        drop(stalled);
    }

    /// The other half: a client that stalls MID-JOB is dropped, never
    /// delivered. `read_to_end` leaves the partial bytes in the buffer on
    /// timeout, and distilling a truncated PostScript stream yields a
    /// plausible-looking WRONG document — the silent-degradation class.
    #[test]
    fn a_mid_job_stall_is_dropped_not_delivered() {
        use std::io::Write;
        use std::sync::mpsc;

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let staging_dir = tempfile::tempdir().unwrap();
        let staging_path = staging_dir.path().to_path_buf();
        std::thread::spawn(move || {
            serve(listener, Duration::from_millis(300), staging_path, move |_, staged| {
                let _ = tx.send(std::fs::read(&staged.path).unwrap());
            })
        });

        let mut c = std::net::TcpStream::connect(addr).unwrap();
        c.write_all(b"%!PS half a job").unwrap();
        // No close, no more bytes: the job thread's idle timeout must fire
        // and the partial buffer must be dropped, not handed to the sink.
        let delivered = rx.recv_timeout(Duration::from_secs(3));
        assert!(
            delivered.is_err(),
            "a truncated job was delivered as if complete: {delivered:?}"
        );
        drop(c);
    }

    #[test]
    fn streamed_job_copy_reads_only_one_byte_past_its_limit() {
        let mut source = std::io::Cursor::new(b"four bytes".to_vec());
        let mut staged = Vec::new();
        let copied = copy_job(&mut source, &mut staged, 4, Duration::from_secs(1)).unwrap();
        assert_eq!(copied, 5);
        assert_eq!(staged, b"four ");
    }

    #[test]
    fn a_slow_trickle_cannot_hold_a_job_slot_forever() {
        struct Trickle {
            remaining: usize,
        }
        impl std::io::Read for Trickle {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_millis(10));
                if self.remaining == 0 {
                    return Ok(0);
                }
                out[0] = b'x';
                self.remaining -= 1;
                Ok(1)
            }
        }

        let mut source = Trickle { remaining: 100 };
        let mut staged = Vec::new();
        let error = copy_job(
            &mut source,
            &mut staged,
            1024,
            Duration::from_millis(35),
        )
        .expect_err("the total receive deadline must stop an active trickle");
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(staged.len() < 100);
    }
}
