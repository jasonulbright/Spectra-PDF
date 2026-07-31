//! File ▸ Send To ▸ Email (owner-ruled in scope 2026-07-31 — a local OS
//! integration with the DEFAULT DESKTOP MAIL CLIENT, distinct from the
//! excluded cloud-share cluster).
//!
//! Simple MAPI (`MAPISendMailW`) is the one Windows mechanism that ATTACHES a
//! file to a compose window — `mailto:` cannot carry attachments. The client
//! is whatever registered under `SOFTWARE\Clients\Mail` (Outlook,
//! Thunderbird, eM Client…); with none registered the command refuses with a
//! visible, actionable message instead of a mystery no-op — never offer a
//! flow that cannot fire (the scheduler's rule, applied here).
//!
//! The attachment is a STAGED COPY of the working file under the document's
//! real name: mail clients may read the attachment lazily, so attaching the
//! live working copy would race later edits — and the working copy's mangled
//! temp name must not leak into an email. Staging lives under the app's own
//! temp area and old copies are swept by age on the next call.

use std::path::{Path, PathBuf};

const SWEEP_AFTER_SECS: u64 = 24 * 60 * 60;

fn send_dir() -> PathBuf {
    std::env::temp_dir().join("openpdfstudio").join("send-to")
}

/// A display name derives from a real file name, but it crossed the webview
/// boundary — strip separators and reserved characters anyway.
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if (c as u32) < 0x20 => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "document.pdf".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `name.pdf` → `name (2).pdf` → `name (3).pdf`… first free slot. Every
/// staged copy keeps its own bytes — a second send must never overwrite a
/// file an open compose window may still read.
fn collision_free(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    for n in 2.. {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Best-effort sweep of staged copies older than a day. Failures are ignored
/// — a file still held open by a mail client simply survives to the next
/// sweep. Age is judged by CREATION time: Windows `fs::copy` PRESERVES the
/// source's write time, so a copy staged a second ago can carry an mtime
/// weeks old — an mtime sweep deleted a fresh staging (caught by e2e 81).
fn sweep_old(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(born) = meta.created().or_else(|_| meta.modified()) else { continue };
        if let Ok(age) = now.duration_since(born) {
            if age.as_secs() > SWEEP_AFTER_SECS {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Stage the attachment copy. Split from the MAPI launch so the copy half is
/// testable end-to-end (the launch half needs a real mail client and a human
/// at the compose window).
#[tauri::command]
pub async fn stage_send_copy(path: String, display_name: String) -> Result<String, String> {
    let dir = send_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not prepare the staging folder: {e}"))?;
    sweep_old(&dir);
    let dest = collision_free(&dir, &safe_file_name(&display_name));
    std::fs::copy(&path, &dest).map_err(|e| format!("Could not stage the attachment copy: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

/// The default desktop mail client's registered name, if any. HKCU overrides
/// HKLM (per-user default beats machine default), both read-only.
fn default_mail_client() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    for root in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        if let Ok(key) = winreg::RegKey::predef(root).open_subkey(r"SOFTWARE\Clients\Mail") {
            if let Ok(v) = key.get_value::<String, _>("") {
                if !v.trim().is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

const SUCCESS_SUCCESS: u32 = 0;
const MAPI_E_USER_ABORT: u32 = 1;
const MAPI_LOGON_UI: u32 = 0x1;
const MAPI_DIALOG: u32 = 0x8;

/// The failures worth naming (full table is MAPI.h; the rest report the code).
fn mapi_error_name(code: u32) -> String {
    match code {
        2 => "the mail app reported a general failure".to_string(),
        3 => "the mail app could not log on".to_string(),
        5 => "the mail app ran out of memory".to_string(),
        9 => "the mail app could not open the attachment".to_string(),
        11 => "the mail app could not write the attachment".to_string(),
        21 => "the mail app rejected the compose text".to_string(),
        26 => "the mail app does not support Unicode here".to_string(),
        other => format!("the mail app returned MAPI error {other}"),
    }
}

#[repr(C)]
struct MapiFileDescW {
    ul_reserved: u32,
    fl_flags: u32,
    n_position: u32,
    lpsz_path_name: *const u16,
    lpsz_file_name: *const u16,
    lp_file_type: *mut core::ffi::c_void,
}

#[repr(C)]
struct MapiMessageW {
    ul_reserved: u32,
    lpsz_subject: *const u16,
    lpsz_note_text: *const u16,
    lpsz_message_type: *const u16,
    lpsz_date_received: *const u16,
    lpsz_conversation_id: *const u16,
    fl_flags: u32,
    lp_originator: *mut core::ffi::c_void,
    n_recip_count: u32,
    lp_recips: *mut core::ffi::c_void,
    n_file_count: u32,
    lp_files: *mut MapiFileDescW,
}

type MapiSendMailWFn = unsafe extern "system" fn(usize, usize, *const MapiMessageW, u32, u32) -> u32;

fn utf16z(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Run `MAPISendMailW` with one attachment and no recipients — the client
/// opens its compose window and the user takes it from there. Runs on a
/// dedicated thread (MAPI providers dislike foreign COM apartments) and
/// BLOCKS until the compose window closes on most clients.
fn run_mapi(hwnd: usize, staged_path: &str) -> Result<u32, String> {
    use windows::core::{s, w};
    use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    let module = unsafe { LoadLibraryW(w!("mapi32.dll")) }
        .map_err(|e| format!("MAPI is not available on this system: {e}"))?;
    let Some(proc_addr) = (unsafe { GetProcAddress(module, s!("MAPISendMailW")) }) else {
        return Err("The default mail app does not support MAPI attachments.".to_string());
    };
    let send: MapiSendMailWFn = unsafe { std::mem::transmute(proc_addr) };

    let file_name = Path::new(staged_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "document.pdf".to_string());
    let subject = file_name.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| file_name.clone());

    let path_w = utf16z(staged_path);
    let name_w = utf16z(&file_name);
    let subject_w = utf16z(&subject);

    let mut file = MapiFileDescW {
        ul_reserved: 0,
        fl_flags: 0,
        n_position: u32::MAX,
        lpsz_path_name: path_w.as_ptr(),
        lpsz_file_name: name_w.as_ptr(),
        lp_file_type: std::ptr::null_mut(),
    };
    let message = MapiMessageW {
        ul_reserved: 0,
        lpsz_subject: subject_w.as_ptr(),
        lpsz_note_text: std::ptr::null(),
        lpsz_message_type: std::ptr::null(),
        lpsz_date_received: std::ptr::null(),
        lpsz_conversation_id: std::ptr::null(),
        fl_flags: 0,
        lp_originator: std::ptr::null_mut(),
        n_recip_count: 0,
        lp_recips: std::ptr::null_mut(),
        n_file_count: 1,
        lp_files: &mut file,
    };

    Ok(unsafe { send(0, hwnd, &message, MAPI_DIALOG | MAPI_LOGON_UI, 0) })
}

/// Hand a staged copy to the default mail client's compose window.
///
/// The result contract: fast failures (no registered client, a client that
/// refuses to start) surface as errors within moments; once the compose
/// window is up the call is a SUCCESS from this app's point of view — the
/// user sending, editing, or discarding the email is their business, so a
/// result that hasn't arrived in 3 seconds means "handed over" and the
/// worker thread is left to park until the client returns. The user closing
/// the compose window without sending (MAPI_E_USER_ABORT) is likewise not an
/// error — attaching and then deciding not to send is a valid choice.
#[tauri::command]
pub async fn send_by_email(window: tauri::WebviewWindow, staged_path: String) -> Result<(), String> {
    if default_mail_client().is_none() {
        return Err(
            "No desktop email app is set up on this PC. Install or configure one \
             (for example Outlook or Thunderbird), then try again."
                .to_string(),
        );
    }
    if !Path::new(&staged_path).is_file() {
        return Err(format!("The staged attachment is missing: {staged_path}"));
    }
    let hwnd = window.hwnd().map(|h| h.0 as usize).unwrap_or(0);

    let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();
    std::thread::spawn(move || {
        let _ = tx.send(run_mapi(hwnd, &staged_path));
    });
    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(code)) if code == SUCCESS_SUCCESS || code == MAPI_E_USER_ABORT => Ok(()),
        Ok(Ok(code)) => Err(format!(
            "Could not hand the file to the mail app — {}.",
            mapi_error_name(code)
        )),
        Ok(Err(e)) => Err(e),
        // No verdict in 3s = the compose window is up. Handed over.
        Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_are_sanitized() {
        assert_eq!(safe_file_name("report.pdf"), "report.pdf");
        assert_eq!(safe_file_name(r"..\..\evil?.pdf"), "-..-evil-.pdf");
        assert_eq!(safe_file_name("con:tract*.pdf"), "con-tract-.pdf");
        assert_eq!(safe_file_name("   "), "document.pdf");
        assert_eq!(safe_file_name("..."), "document.pdf");
    }

    #[test]
    fn staged_names_never_collide() {
        let dir = std::env::temp_dir().join("opdfs-sendto-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let first = collision_free(&dir, "doc.pdf");
        assert_eq!(first.file_name().unwrap(), "doc.pdf");
        std::fs::write(&first, b"a").unwrap();
        let second = collision_free(&dir, "doc.pdf");
        assert_eq!(second.file_name().unwrap(), "doc (2).pdf");
        std::fs::write(&second, b"b").unwrap();
        let third = collision_free(&dir, "doc.pdf");
        assert_eq!(third.file_name().unwrap(), "doc (3).pdf");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mapi_failures_are_named() {
        assert!(mapi_error_name(3).contains("log on"));
        assert!(mapi_error_name(9).contains("attachment"));
        assert!(mapi_error_name(99).contains("99"));
    }
}
