//! The virtual printer (O7): "Spectra PDF" appears in every
//! application's print dialog; printing to it lands the pages in this app
//! as a fresh PDF.
//!
//! Shape: a Windows printer using the IN-BOX "Microsoft PS Class Driver" on
//! a standard TCP/IP RAW port aimed at 127.0.0.1:9100, where THIS APP
//! listens (loopback only). The spooler streams PostScript; the listener
//! hands it to the bundled Ghostscript through the same CLI `distill` arm
//! Phase 8 ships, and the finished PDF opens through the normal open funnel
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
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

pub const PRINTER_NAME: &str = "Spectra PDF";
pub const PORT_NAME: &str = "SpectraPDF_9100";
pub const PORT: u16 = 9100;
/// A print job larger than this is refused (a runaway client, not a page).
const MAX_JOB_BYTES: u64 = 512 * 1024 * 1024;

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
    // Seconds-precision local time keeps names sortable and human; a
    // same-second collision falls back to the counter suffix below.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("Printed {now}")
}

fn unique_pdf(dir: &PathBuf, stem: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.pdf"));
    if !first.exists() {
        return first;
    }
    for n in 2.. {
        let candidate = dir.join(format!("{stem} ({n}).pdf"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
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
    let ps_path = dir.join(format!("{stem}.ps"));
    if let Err(e) = std::fs::write(&ps_path, &bytes) {
        return record_error(format!("cannot stage the print job: {e}"));
    }
    let pdf_path = unique_pdf(&dir, &stem);
    let Ok(exe) = std::env::current_exe() else {
        return record_error("cannot resolve the app path".to_string());
    };
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("distill")
        .arg(&ps_path)
        .arg("--output")
        .arg(&pdf_path)
        .arg("--preset")
        .arg("printer");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let ok = match cmd.output() {
        Ok(out) if out.status.success() && pdf_path.is_file() => true,
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
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            // RAW/JetDirect: the client streams the job and closes. Reads are
            // capped so a runaway writer cannot exhaust the disk staging.
            let mut bytes = Vec::new();
            let mut capped = std::io::Read::take(&mut stream, MAX_JOB_BYTES + 1);
            if capped.read_to_end(&mut bytes).is_err() {
                continue;
            }
            if bytes.is_empty() {
                continue; // port probes (and the spooler's SNMP pokes) are not jobs
            }
            if bytes.len() as u64 > MAX_JOB_BYTES {
                eprintln!("virtual printer: job over the {MAX_JOB_BYTES}-byte cap, refused");
                continue;
            }
            let job_app = handle.clone();
            std::thread::spawn(move || handle_job(&job_app, bytes));
        }
    });
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
    let path = std::env::temp_dir().join(format!("opdfs-printer-{label}.ps1"));
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
        let first = unique_pdf(&dir, "Printed 1");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_pdf(&dir, "Printed 1");
        assert_eq!(second.file_name().unwrap(), "Printed 1 (2).pdf");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_scripts_are_pure_ascii() {
        // The standing .ps1 rule: a non-ASCII char in a BOM-less script is
        // read as ANSI by PS 5.1 and silently corrupts the parse.
        let install = format!("{PRINTER_NAME}{PORT_NAME}");
        assert!(install.is_ascii());
    }
}
