//! The virtual printer: "Spectra PDF" appears in every
//! application's print dialog; printing to it lands the pages in this app
//! as a fresh PDF.
//!
//! Shape: a Windows printer using the IN-BOX "Microsoft PS Class Driver" on
//! a standard TCP/IP RAW port aimed at 127.0.0.1:9100, where THIS APP
//! listens (loopback only). The spooler streams PostScript; the listener
//! hands it to the bundled Ghostscript through the CLI `distill` arm,
//! and the finished PDF opens through the normal open funnel
//! (the second-instance `app:openFile` event). No driver is shipped, no
//! service is installed — the OS driver does the rendering contract and the
//! listener lives only while the app runs (tray-residency counts), the same
//! posture as watched folders.
//!
//! Printer/port INSTALLATION needs admin (ports are machine objects), so
//! Install/Remove run a visible, user-initiated UAC elevation over a staged
//! pure-ASCII PowerShell script — never a silent elevation. A print sent
//! while the app is closed sits in the Windows queue erroring-retrying until
//! the app (and so the listener) is back; the Settings block says exactly
//! that.

use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

pub const PRINTER_NAME: &str = "Spectra PDF";
pub const PORT_NAME: &str = "SpectraPDF_9100";
pub const PORT: u16 = 9100;
/// A print job larger than this is refused (a runaway client, not a page).
const MAX_JOB_BYTES: u64 = 512 * 1024 * 1024;
/// Idle read timeout for one connection. RAW/JetDirect clients stream and
/// close; a spooler may pause mid-job, so this is generous. Without it a
/// client that connects and never writes holds the socket forever.
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
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

fn timestamp_name() -> String {
    // Seconds precision keeps names sortable and human. Not unique; `claim`
    // guarantees that.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("Printed {now}")
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

/// Reserve the staging path for one job's PostScript. Internal; never seen.
fn claim_staging(dir: &Path, stem: &str) -> std::io::Result<PathBuf> {
    let seq = JOB_SEQ.fetch_add(1, Ordering::Relaxed);
    for extra in 0..1000u64 {
        let candidate = dir.join(format!("{stem}-{}.ps", seq + extra));
        match claim(&candidate) {
            Ok(()) => return Ok(candidate),
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

fn handle_job(app: &AppHandle, bytes: Vec<u8>) {
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
    let stem = timestamp_name();
    let ps_path = match claim_staging(&dir, &stem) {
        Ok(p) => p,
        Err(e) => return record_error(format!("cannot stage the print job: {e}")),
    };
    if let Err(e) = std::fs::write(&ps_path, &bytes) {
        let _ = std::fs::remove_file(&ps_path);
        return record_error(format!("cannot stage the print job: {e}"));
    }
    let pdf_path = match reserve_pdf(&dir, &stem) {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_file(&ps_path);
            return record_error(format!("cannot name the printed file: {e}"));
        }
    };
    // Distil to a sibling and rename over the reservation, so a reader never
    // sees a half-written PDF at the final name.
    let part_path = dir.join(format!(
        "{}.part",
        pdf_path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let Ok(exe) = std::env::current_exe() else {
        let _ = std::fs::remove_file(&ps_path);
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
    let ok = match cmd.output() {
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
            record_error(format!("could not run the converter: {e}"));
            false
        }
    };
    let _ = std::fs::remove_file(&ps_path);
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
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let canonical = crate::commands::canonical_path(&pdf_path.to_string_lossy());
        let payload = serde_json::json!({ "files": [canonical], "merge": false });
        let _ = window.emit("app:openFile", payload);
    }
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
        if let Some(state) = handle.try_state::<PrinterState>() {
            *state.listener_status.lock().unwrap() = "listening".to_string();
        }
        serve(listener, READ_IDLE_TIMEOUT, move |bytes| {
            handle_job(&handle, bytes)
        });
    });
}

/// The accept loop, separated from the app wiring so the stall behaviour is
/// testable against real sockets: a test binds an ephemeral port and passes a
/// plain sink, production passes `handle_job`. `idle_timeout` is a parameter
/// for the same reason — the mid-job-stall test cannot wait out the
/// production 60 seconds. Behaviour is identical to the pre-extraction loop.
fn serve(
    listener: TcpListener,
    idle_timeout: Duration,
    on_job: impl Fn(Vec<u8>) + Clone + Send + 'static,
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
        std::thread::spawn(move || {
            let _slot = JobSlot;
            let mut stream = stream;
            // Per-read idle timeout: a half-open connection dies on its own
            // thread instead of holding the listener.
            let _ = stream.set_read_timeout(Some(idle_timeout));
            // RAW/JetDirect: the client streams the job and closes. Reads
            // are capped so a runaway writer cannot exhaust disk staging.
            let mut bytes = Vec::new();
            let mut capped = std::io::Read::take(&mut stream, MAX_JOB_BYTES + 1);
            if capped.read_to_end(&mut bytes).is_err() {
                // On timeout `read_to_end` leaves partial bytes in the
                // buffer. Distilling a truncated stream yields a
                // plausible-looking wrong document, so drop it.
                return;
            }
            if bytes.is_empty() {
                return; // port probes (and the spooler's SNMP pokes) are not jobs
            }
            if bytes.len() as u64 > MAX_JOB_BYTES {
                eprintln!("virtual printer: job over the {MAX_JOB_BYTES}-byte cap, refused");
                return;
            }
            sink(bytes);
        });
    }
}

fn run_powershell(args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("powershell.exe");
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

/// Stage a pure-ASCII script and run it through ONE visible UAC elevation.
fn run_elevated_script(script_body: &str, label: &str) -> Result<(), String> {
    // Pid-suffixed, as scheduler.rs stages its task XML: a fixed path executed
    // under RunAs leaves a same-user swap window between write and read.
    let path = std::env::temp_dir().join(format!(
        "opdfs-printer-{label}-{}.ps1",
        std::process::id()
    ));
    if !script_body.is_ascii() {
        return Err("internal: the printer script must be pure ASCII".to_string());
    }
    std::fs::write(&path, script_body).map_err(|e| format!("Could not stage the script: {e}"))?;
    let command = format!(
        "$p = Start-Process -Verb RunAs -Wait -PassThru powershell -ArgumentList \
         '-NoProfile','-ExecutionPolicy','Bypass','-File','{}'; exit $p.ExitCode",
        path.display()
    );
    let result = run_powershell(&[&command]);
    let _ = std::fs::remove_file(&path);
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

#[tauri::command]
pub async fn virtual_printer_status(app: AppHandle) -> Result<VirtualPrinterStatus, String> {
    let installed = run_powershell(&[&format!(
        "if (Get-Printer -Name '{PRINTER_NAME}' -ErrorAction SilentlyContinue) {{ 'yes' }} else {{ 'no' }}"
    )])
    .map(|out| out.contains("yes"))
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
    let script = format!(
        "$ErrorActionPreference = 'Stop'\r\n\
         if (-not (Get-PrinterPort -Name '{PORT_NAME}' -ErrorAction SilentlyContinue)) {{\r\n\
           Add-PrinterPort -Name '{PORT_NAME}' -PrinterHostAddress '127.0.0.1' -PortNumber {PORT}\r\n\
         }}\r\n\
         if (-not (Get-Printer -Name '{PRINTER_NAME}' -ErrorAction SilentlyContinue)) {{\r\n\
           Add-Printer -Name '{PRINTER_NAME}' -DriverName 'Microsoft PS Class Driver' -PortName '{PORT_NAME}'\r\n\
         }}\r\n"
    );
    run_elevated_script(&script, "install")
}

#[tauri::command]
pub async fn uninstall_virtual_printer() -> Result<(), String> {
    let script = format!(
        "Remove-Printer -Name '{PRINTER_NAME}' -ErrorAction SilentlyContinue\r\n\
         Remove-PrinterPort -Name '{PORT_NAME}' -ErrorAction SilentlyContinue\r\n\
         exit 0\r\n"
    );
    run_elevated_script(&script, "remove")
}

#[cfg(test)]
mod tests {
    use super::*;

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
                let ps = claim_staging(&d, stem).expect("staging");
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

    #[test]
    fn install_scripts_are_pure_ascii() {
        // The standing .ps1 rule: a non-ASCII char in a BOM-less script is
        // read as ANSI by PS 5.1 and silently corrupts the parse.
        let install = format!("{PRINTER_NAME}{PORT_NAME}");
        assert!(install.is_ascii());
    }

    /// the acceptance, against real sockets: one client that connects and
    /// never writes must not block later jobs. This is the exact wedge shape
    /// the fix exists for — pre-R2, the accept loop read each connection to
    /// EOF, so the silent client held every later print until app restart.
    #[test]
    fn a_stalled_client_does_not_block_other_jobs() {
        use std::io::Write;
        use std::sync::mpsc;

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            serve(listener, Duration::from_secs(5), move |b| {
                let _ = tx.send(b);
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
        std::thread::spawn(move || {
            serve(listener, Duration::from_millis(300), move |b| {
                let _ = tx.send(b);
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
}
