//! Platform-bound features that have no backend on the running platform.
//!
//! A subsystem without a backend refuses by name through `Unsupported`: the
//! renderer drops the feature's UI entry off `platform_capabilities`, and the
//! CLI prints this message and exits non-zero. A generic error for a missing
//! backend is never returned.

use std::fmt;

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

/// Feature names, shared by the command layer and the CLI so one feature has
/// one spelling.
pub mod feature {
    pub const SYSTEM_PRINTING: &str = "System printing";
    pub const VIRTUAL_PRINTER: &str = "The virtual printer";
    pub const SCANNING: &str = "Scanning";
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
}
