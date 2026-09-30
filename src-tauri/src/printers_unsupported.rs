//! System printing off Windows. No backend yet: every call refuses by name,
//! and `platform_capabilities` reports `systemPrinting` false so the renderer
//! offers no print entry.

use crate::platform::{feature, Unsupported};

/// Uninhabited: no printer list exists to return.
#[derive(serde::Serialize)]
pub enum PrinterList {}

/// Uninhabited: no capability report exists to return.
#[derive(serde::Serialize)]
pub enum PrinterCapabilities {}

pub fn enumerate() -> Result<PrinterList, String> {
    Err(Unsupported::new(feature::SYSTEM_PRINTING).into())
}

pub fn capabilities(_name: &str) -> Result<PrinterCapabilities, String> {
    Err(Unsupported::new(feature::SYSTEM_PRINTING).into())
}
