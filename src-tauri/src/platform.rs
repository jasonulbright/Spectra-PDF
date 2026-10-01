//! Platform-bound features that have no backend on the running platform.
//!
//! A subsystem without a backend refuses by name through `Unsupported`: the
//! renderer drops the feature's UI entry off `platform_capabilities`, and the
//! CLI prints this message and exits non-zero. A generic error for a missing
//! backend is never returned.

use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unsupported {
    pub feature: &'static str,
}

impl Unsupported {
    pub const fn new(feature: &'static str) -> Self {
        Self { feature }
    }
}

impl fmt::Display for Unsupported {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} is not available on this platform", self.feature)
    }
}

impl std::error::Error for Unsupported {}

impl From<Unsupported> for String {
    fn from(value: Unsupported) -> Self {
        value.to_string()
    }
}

/// A vendored program's path relative to its component tree. A Linux tree is
/// the pinned artifact unpacked as published: programs in `bin/` load their
/// libraries from `lib/` through RUNPATH `$ORIGIN/../lib`, so the tree is
/// never flattened.
pub fn program_relative(stem: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(format!("{stem}.exe"))
    } else {
        Path::new("bin").join(stem)
    }
}

/// The engine interpreter relative to the resource root.
pub fn python_relative() -> PathBuf {
    if cfg!(windows) {
        Path::new("python").join("python.exe")
    } else {
        Path::new("python").join("bin").join("python3")
    }
}

/// LibreOffice's `soffice` relative to the resource root.
pub fn soffice_relative() -> PathBuf {
    let name = if cfg!(windows) { "soffice.exe" } else { "soffice" };
    Path::new("libreoffice").join("program").join(name)
}

/// The resource root for a process with no Tauri runtime (the CLI), resolved
/// the way `PathResolver::resource_dir` resolves it for the window.
///
/// Windows and a cargo output directory keep resources beside the executable.
/// An installed Linux build keeps them in `<exe>/../lib/<product>`, and an
/// AppImage in `$APPDIR/usr/lib/<product>`.
pub fn resource_root_for(exe_dir: &Path) -> PathBuf {
    if cfg!(windows) || exe_dir.join("engine").is_dir() {
        return exe_dir.to_path_buf();
    }
    if let Ok(installed) = exe_dir.join("..").join("lib").join(PRODUCT_NAME).canonicalize() {
        return installed;
    }
    if let Some(appdir) = std::env::var_os("APPDIR") {
        return PathBuf::from(appdir).join("usr").join("lib").join(PRODUCT_NAME);
    }
    exe_dir.to_path_buf()
}

/// `productName` in `tauri.conf.json`; Tauri names the Linux resource
/// directory after it.
const PRODUCT_NAME: &str = "Spectra PDF";

/// Feature names, shared by the command layer and the CLI so one feature has
/// one spelling.
pub mod feature {
    pub const SYSTEM_PRINTING: &str = "System printing";
    pub const VIRTUAL_PRINTER: &str = "The virtual printer";
    pub const SCANNING: &str = "Scanning";
    pub const SCANNER_CHECKLIST: &str = "The scanner checklist";
    pub const SCHEDULED_ACTIONS: &str = "Scheduled actions";
    pub const STORE_CERTIFICATES: &str = "Certificate-store signing";
    pub const SEND_BY_EMAIL: &str = "Send by email";
    pub const WEB_CAPTURE: &str = "Web capture";
    pub const CLIPBOARD_READ: &str = "Reading the clipboard";
    pub const SNAPSHOT: &str = "Snapshot to the clipboard";
    pub const ENTERPRISE_POLICY: &str = "Enterprise policy";
    pub const START_WITH_SYSTEM: &str = "Start with the system";
    pub const PROCESS_LIFETIME: &str = "Child-process lifetime binding";
    pub const FOLDER_LEASES: &str = "Folder-claim leasing";
    pub const START_MINIMIZED: &str = "Starting minimized to the tray";
    pub const TRAY_RESIDENCY: &str = "The system tray";
    pub const EXPLORER_MENU: &str = "The File Explorer context menu";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_refusal_names_the_feature() {
        let refusal = Unsupported::new(feature::SCANNING);
        assert_eq!(refusal.to_string(), "Scanning is not available on this platform");
        let as_string: String = refusal.into();
        assert!(as_string.starts_with("Scanning "));
    }

    #[test]
    fn a_directory_holding_the_engine_is_its_own_resource_root() {
        let dir = std::env::temp_dir().join(format!("spectra-root-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("engine")).unwrap();
        assert_eq!(resource_root_for(&dir), dir);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn programs_keep_the_published_tree_layout() {
        if cfg!(windows) {
            assert_eq!(program_relative("tesseract"), PathBuf::from("tesseract.exe"));
            assert_eq!(python_relative(), Path::new("python").join("python.exe"));
        } else {
            assert_eq!(program_relative("tesseract"), Path::new("bin").join("tesseract"));
            assert_eq!(python_relative(), Path::new("python").join("bin").join("python3"));
        }
    }
}
