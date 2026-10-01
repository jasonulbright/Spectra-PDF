//! The app side of the File Explorer verbs: the one-shot handoff file the
//! command handler writes, and the `--shell-action <file>` argument that
//! names it.
//!
//! The handler writes the selection to
//! `<Local AppData>\Temp\spectrapdf\shell-handoff\<32 hex>.json` and starts
//! the app once.
//! A file rather than argv carries the paths because a COM verb has no item
//! limit and a command line stops at 32,767 characters. The file is accepted
//! only from that folder, under that name shape, at a bounded size, and is
//! deleted once read so a handoff cannot be replayed.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const ARG: &str = "--shell-action";
pub const HANDOFF_VERSION: u32 = 1;
pub const MAX_HANDOFF_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellVerb {
    Convert,
    Combine,
}

/// `PendingOpen.create`: canonical paths in handoff order, plus how many
/// selected items did not survive the handler and this read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellCreate {
    pub action: ShellVerb,
    pub paths: Vec<String>,
    pub skipped: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HandoffFile {
    version: u32,
    action: ShellVerb,
    paths: Vec<String>,
    skipped: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HandoffError {
    OutsideHandoffFolder(String),
    BadName(String),
    TooLarge(u64),
    Unreadable(String),
    Malformed(String),
    UnsupportedVersion(u32),
}

impl std::fmt::Display for HandoffError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandoffError::OutsideHandoffFolder(p) => {
                write!(f, "the shell handoff {p} is not in the handoff folder")
            }
            HandoffError::BadName(p) => write!(f, "the shell handoff {p} has an unexpected name"),
            HandoffError::TooLarge(n) => write!(f, "the shell handoff is too large ({n} bytes)"),
            HandoffError::Unreadable(e) => write!(f, "the shell handoff could not be read: {e}"),
            HandoffError::Malformed(e) => write!(f, "the shell handoff is malformed: {e}"),
            HandoffError::UnsupportedVersion(v) => {
                write!(f, "the shell handoff has unsupported version {v}")
            }
        }
    }
}

/// Where the handler writes handoffs. Resolved from the user's Local AppData
/// known folder, never from TMP or TEMP: the handler runs with Explorer's
/// environment, and a running instance started with another TMP would refuse
/// every handoff it forwards.
pub fn handoff_dir() -> PathBuf {
    handoff_dir_in(&local_app_data())
}

/// The handoff folder under a Local AppData folder. The handler's
/// `handoff_dir_in` builds the same path.
pub fn handoff_dir_in(local_app_data: &Path) -> PathBuf {
    local_app_data
        .join("Temp")
        .join("spectrapdf")
        .join("shell-handoff")
}

#[cfg(windows)]
fn local_app_data() -> PathBuf {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    match unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, None) } {
        Ok(path) => {
            let text = unsafe { path.to_string() }.unwrap_or_default();
            unsafe { CoTaskMemFree(Some(path.0 as *const core::ffi::c_void)) };
            PathBuf::from(text)
        }
        Err(_) => std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir),
    }
}

#[cfg(not(windows))]
fn local_app_data() -> PathBuf {
    std::env::temp_dir()
}

/// The identity log stays a few kilobytes: past this size it starts over.
const IDENTITY_LOG_LIMIT: u64 = 16 * 1024;

/// The value after `--shell-action`, in either the separated or the `=` form.
pub fn arg_value(argv: &[String]) -> Option<String> {
    let mut iter = argv.iter().skip(1);
    while let Some(token) = iter.next() {
        if token == ARG {
            return iter.next().cloned();
        }
        if let Some(value) = token.strip_prefix("--shell-action=") {
            return Some(value.to_string());
        }
    }
    None
}

fn name_is_valid(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    stem.len() == 32 && stem.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn read_handoff(path: &str) -> Result<ShellCreate, HandoffError> {
    read_handoff_in(Path::new(path), &handoff_dir(), &|p: &Path| p.is_file())
}

/// `exists` answers whether a listed source is a file, so the skip rule is
/// testable against a directory the test builds.
pub fn read_handoff_in(
    path: &Path,
    folder: &Path,
    exists: &dyn Fn(&Path) -> bool,
) -> Result<ShellCreate, HandoffError> {
    let shown = path.display().to_string();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| HandoffError::BadName(shown.clone()))?;
    if !name_is_valid(name) {
        return Err(HandoffError::BadName(shown));
    }
    let canonical = dunce::canonicalize(path).map_err(|e| HandoffError::Unreadable(e.to_string()))?;
    let folder = dunce::canonicalize(folder)
        .map_err(|_| HandoffError::OutsideHandoffFolder(shown.clone()))?;
    if canonical.parent() != Some(folder.as_path()) {
        return Err(HandoffError::OutsideHandoffFolder(shown));
    }

    let read = read_bounded(&canonical);
    let _ = std::fs::remove_file(&canonical);
    let bytes = read?;

    let file: HandoffFile =
        serde_json::from_slice(&bytes).map_err(|e| HandoffError::Malformed(e.to_string()))?;
    if file.version != HANDOFF_VERSION {
        return Err(HandoffError::UnsupportedVersion(file.version));
    }

    let mut skipped = file.skipped;
    let mut paths = Vec::with_capacity(file.paths.len());
    for source in file.paths {
        let candidate = Path::new(&source);
        if !candidate.is_absolute()
            || !crate::create_pdf_sources::accepts(candidate)
            || !exists(candidate)
        {
            skipped = skipped.saturating_add(1);
            continue;
        }
        paths.push(crate::commands::canonical_path(&source));
    }
    Ok(ShellCreate {
        action: file.action,
        paths,
        skipped,
    })
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, HandoffError> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| HandoffError::Unreadable(e.to_string()))?;
    let size = file
        .metadata()
        .map_err(|e| HandoffError::Unreadable(e.to_string()))?
        .len();
    if size > MAX_HANDOFF_BYTES {
        return Err(HandoffError::TooLarge(size));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(MAX_HANDOFF_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| HandoffError::Unreadable(e.to_string()))?;
    if bytes.len() as u64 > MAX_HANDOFF_BYTES {
        return Err(HandoffError::TooLarge(bytes.len() as u64));
    }
    Ok(bytes)
}

/// The package this process runs under, if any. On the sparse-package path
/// the handler starts the app from a packaged surrogate, and whether the child
/// inherits that identity is decided by Windows, not by this code.
#[cfg(windows)]
pub fn package_identity() -> Option<String> {
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    let mut length: u32 = 0;
    // APPMODEL_ERROR_NO_PACKAGE (15700) is the no-identity answer.
    let first = unsafe { GetCurrentPackageFullName(&mut length, None) };
    if first.0 == 15700 || length == 0 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize];
    let second =
        unsafe { GetCurrentPackageFullName(&mut length, Some(windows::core::PWSTR(buffer.as_mut_ptr()))) };
    if second.0 != 0 {
        return None;
    }
    let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

#[cfg(not(windows))]
pub fn package_identity() -> Option<String> {
    None
}

/// Append one line per verb launch to `<temp>\spectrapdf\shell-action.log`,
/// naming the package identity the launch ran with.
pub fn record_launch_identity() {
    use std::io::Write;
    let dir = std::env::temp_dir().join("spectrapdf");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let line = format!(
        "pid={} package={}\n",
        std::process::id(),
        package_identity().unwrap_or_else(|| "none".to_string())
    );
    let path = dir.join("shell-action.log");
    let full = std::fs::metadata(&path).is_ok_and(|m| m.len() > IDENTITY_LOG_LIMIT);
    let mut options = std::fs::OpenOptions::new();
    options.create(true);
    if full {
        options.write(true).truncate(true);
    } else {
        options.append(true);
    }
    if let Ok(mut file) = options.open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: &str = "0123456789abcdef0123456789abcdef.json";

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    fn sources(dir: &Path) -> (String, String) {
        let png = dir.join("a.png");
        let pdf = dir.join("b.pdf");
        std::fs::write(&png, b"x").unwrap();
        std::fs::write(&pdf, b"x").unwrap();
        (png.display().to_string(), pdf.display().to_string())
    }

    fn json(action: &str, paths: &[&str], skipped: u32) -> String {
        serde_json::json!({"version": 1, "action": action, "paths": paths, "skipped": skipped})
            .to_string()
    }

    #[test]
    fn a_valid_handoff_is_read_in_order_and_deleted() {
        let folder = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let (png, pdf) = sources(data.path());
        let path = write(folder.path(), NAME, &json("combine", &[&pdf, &png], 2));
        let got = read_handoff_in(&path, folder.path(), &|p: &Path| p.is_file()).unwrap();
        assert_eq!(got.action, ShellVerb::Combine);
        assert_eq!(
            got.paths,
            vec![crate::commands::canonical_path(&pdf), crate::commands::canonical_path(&png)]
        );
        assert_eq!(got.skipped, 2);
        assert!(!path.exists());
    }

    #[test]
    fn missing_and_unaccepted_sources_are_counted_as_skipped() {
        let folder = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let (png, _) = sources(data.path());
        let zip = data.path().join("c.zip");
        std::fs::write(&zip, b"x").unwrap();
        let gone = data.path().join("gone.png").display().to_string();
        let path = write(
            folder.path(),
            NAME,
            &json("convert", &[&png, &zip.display().to_string(), &gone, "relative.png"], 1),
        );
        let got = read_handoff_in(&path, folder.path(), &|p: &Path| p.is_file()).unwrap();
        assert_eq!(got.action, ShellVerb::Convert);
        assert_eq!(got.paths.len(), 1);
        assert_eq!(got.skipped, 4);
    }

    #[test]
    fn a_file_outside_the_handoff_folder_is_refused_and_kept() {
        let folder = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let path = write(elsewhere.path(), NAME, &json("convert", &[], 0));
        assert!(matches!(
            read_handoff_in(&path, folder.path(), &|_: &Path| true),
            Err(HandoffError::OutsideHandoffFolder(_))
        ));
        assert!(path.exists());
    }

    #[test]
    fn a_wrong_name_is_refused_and_kept() {
        let folder = tempfile::tempdir().unwrap();
        for name in [
            "0123456789ABCDEF0123456789abcdef.json",
            "0123456789abcdef0123456789abcde.json",
            "0123456789abcdef0123456789abcdef.txt",
            "settings.json",
        ] {
            let path = write(folder.path(), name, &json("convert", &[], 0));
            assert!(
                matches!(
                    read_handoff_in(&path, folder.path(), &|_: &Path| true),
                    Err(HandoffError::BadName(_))
                ),
                "{name}"
            );
            assert!(path.exists(), "{name}");
        }
    }

    #[test]
    fn an_oversized_handoff_is_refused_and_deleted() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join(NAME);
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_HANDOFF_BYTES + 1).unwrap();
        drop(file);
        assert_eq!(
            read_handoff_in(&path, folder.path(), &|_: &Path| true),
            Err(HandoffError::TooLarge(MAX_HANDOFF_BYTES + 1))
        );
        assert!(!path.exists());
    }

    #[test]
    fn a_wrong_version_or_malformed_json_is_refused_and_deleted() {
        let folder = tempfile::tempdir().unwrap();
        let wrong = r#"{"version":2,"action":"convert","paths":[],"skipped":0}"#;
        let path = write(folder.path(), NAME, wrong);
        assert_eq!(
            read_handoff_in(&path, folder.path(), &|_: &Path| true),
            Err(HandoffError::UnsupportedVersion(2))
        );
        assert!(!path.exists());
        for body in [
            "not json",
            r#"{"version":1,"action":"print","paths":[],"skipped":0}"#,
            r#"{"version":1,"action":"convert","paths":[],"skipped":0,"run":"x"}"#,
            r#"{"version":1,"action":"convert","skipped":0}"#,
        ] {
            let path = write(folder.path(), NAME, body);
            assert!(
                matches!(
                    read_handoff_in(&path, folder.path(), &|_: &Path| true),
                    Err(HandoffError::Malformed(_))
                ),
                "{body}"
            );
            assert!(!path.exists(), "{body}");
        }
    }

    #[test]
    fn the_handoff_folder_does_not_follow_tmp() {
        let base = Path::new(r"C:\Users\u\AppData\Local");
        assert_eq!(
            handoff_dir_in(base),
            base.join("Temp").join("spectrapdf").join("shell-handoff")
        );
        #[cfg(windows)]
        assert_eq!(handoff_dir(), handoff_dir_in(&local_app_data()));
        #[cfg(windows)]
        assert!(local_app_data().is_absolute());
    }

    #[test]
    fn the_argument_value_is_found_in_both_spellings() {
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            arg_value(&argv(&["spectrapdf", "--shell-action", r"C:\t\x.json"])),
            Some(r"C:\t\x.json".to_string())
        );
        assert_eq!(
            arg_value(&argv(&["spectrapdf", r"--shell-action=C:\t\x.json"])),
            Some(r"C:\t\x.json".to_string())
        );
        assert_eq!(arg_value(&argv(&["spectrapdf", "--shell-action"])), None);
        assert_eq!(arg_value(&argv(&["spectrapdf", "a.pdf"])), None);
    }

    #[test]
    fn the_create_entry_serializes_the_contract_shape() {
        let create = ShellCreate {
            action: ShellVerb::Convert,
            paths: vec!["C:\\a.png".into()],
            skipped: 3,
        };
        assert_eq!(
            serde_json::to_value(&create).unwrap(),
            serde_json::json!({"action": "convert", "paths": ["C:\\a.png"], "skipped": 3})
        );
    }
}
