//! Windows scanner acquisition — WIA 2.0 device enumeration and the
//! capability report.
//!
//! One implementation shared by the GUI (`list_scanners` /
//! `scanner_capabilities` / `scanner_select_dialog`) and the CLI (`scanners`
//! subcommand and its `--capabilities` arm) — the `printers.rs` shape, so
//! neither surface can hold a different idea of what a device is.
//!
//! # The apartment rule is this module's boundary
//!
//! `IWiaItem2` and everything reachable from it are apartment-bound, and a
//! Tauri command body runs on whichever worker the runtime picked. So every
//! WIA interface pointer created here lives on one dedicated thread that
//! initialises its own single-threaded apartment, pumps messages, and takes
//! work over a channel. Nothing outside this module can name a WIA type: the
//! interfaces are private, the session's request enum is private, and the
//! exported surface is plain serialisable data.
//!
//! Enumeration is the one deliberate exception: it builds and drops its own
//! short-lived apartment per call, so listing devices needs no session and
//! cannot be blocked by one already open.
//!
//! # A live session holds a device lock
//!
//! WIA locks a device for as long as an `IWiaItem2` on it lives; a leaked one
//! makes every other imaging application on the machine fail until this
//! process exits. Three things release it: the session thread drops its
//! interfaces before `CoUninitialize`, `Session`'s `Drop` shuts that thread
//! down and joins it, and the idle reaper drops a session nothing has used
//! within `IDLE_TIMEOUT`. The session thread also catches panics rather than
//! unwinding through COM.
//!
//! # Refusals are structured, not prose
//!
//! Commands fail with [`ScanRefusal`], which carries a stable catalog key
//! beside its English sentence. The renderer renders `refusal.<key>`; the CLI
//! prints the sentence. Control flow matches the HRESULT, never a message.

#![cfg(windows)]

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::{Interface, BSTR, GUID, HRESULT, PWSTR};
use windows::Win32::Devices::ImageAcquisition::{
    IEnumWiaItem2, IWiaDevMgr2, IWiaItem2, IWiaPropertyStorage, WiaDevMgr2, ADVANCED_DUPLEX,
    DUPLEX, FEEDER, FLATBED, WIA_CATEGORY_AUTO, WIA_CATEGORY_FEEDER, WIA_CATEGORY_FEEDER_BACK,
    WIA_CATEGORY_FEEDER_FRONT, WIA_CATEGORY_FLATBED, WIA_CATEGORY_FILM, WIA_DATA_AUTO,
    WIA_DATA_COLOR, WIA_DATA_GRAYSCALE, WIA_DATA_THRESHOLD, WIA_DEVINFO_ENUM_LOCAL,
    WIA_DIP_DEV_ID, WIA_DIP_DEV_NAME, WIA_DIP_DEV_TYPE,
    WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES, WIA_DPS_MAX_SCAN_TIME, WIA_ERROR_BUSY,
    WIA_ERROR_COVER_OPEN, WIA_ERROR_DEVICE_LOCKED, WIA_ERROR_EXCEPTION_IN_DRIVER,
    WIA_ERROR_INVALID_COMMAND, WIA_ERROR_OFFLINE, WIA_ERROR_PAPER_EMPTY, WIA_ERROR_PAPER_JAM,
    WIA_ERROR_PAPER_PROBLEM, WIA_ERROR_USER_INTERVENTION, WIA_FLAG_NOM, WIA_FLAG_VALUES,
    WIA_IPA_DATATYPE,
    WIA_IPA_FULL_ITEM_NAME, WIA_IPA_ITEM_CATEGORY, WIA_IPS_BRIGHTNESS, WIA_IPS_CONTRAST,
    WIA_IPS_DOCUMENT_HANDLING_SELECT, WIA_IPS_OPTICAL_XRES, WIA_IPS_PAGES, WIA_IPS_XEXTENT,
    WIA_IPS_XRES, WIA_IPS_YEXTENT, WIA_IPS_YRES, WIA_LIST_COUNT, WIA_LIST_NOM, WIA_LIST_VALUES,
    WIA_PROP_FLAG, WIA_PROP_LIST, WIA_PROP_RANGE, WIA_PROP_READ, WIA_PROP_WRITE, WIA_RANGE_MAX,
    WIA_RANGE_MIN, WIA_RANGE_NOM, WIA_RANGE_STEP, WIA_S_NO_DEVICE_AVAILABLE,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::StructuredStorage::{
    PropVariantClear, PROPSPEC, PROPSPEC_0, PROPSPEC_KIND, PROPVARIANT,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_LOCAL_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Variant::{
    VT_BSTR, VT_CLSID, VT_I2, VT_I4, VT_LPWSTR, VT_UI2, VT_UI4, VT_VECTOR,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};

// ── Refusals ────────────────────────────────────────────────────────────────

/// A named scanner refusal: a stable catalog key, the English sentence, and
/// the HRESULT for the cases that have no named row.
///
/// Serialised as the command's error, so the renderer reads a field rather
/// than parsing a sentence.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanRefusal {
    /// Catalog key without the `refusal.` prefix (`scan.deviceLocked`).
    pub key: &'static str,
    /// English, for the CLI and for any surface with no catalog entry.
    pub message: String,
    /// `0x8021000D` for an unnamed HRESULT; absent for a named row.
    pub code: Option<String>,
}

impl std::fmt::Display for ScanRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl ScanRefusal {
    fn named(key: &'static str, message: &str) -> Self {
        Self {
            key,
            message: message.to_string(),
            code: None,
        }
    }
}

/// HRESULT → catalog key, matched in order.
///
/// `WIA_S_NO_DEVICE_AVAILABLE` and `WIA_ERROR_MAXIMUM_PRINTER_ENDORSER_COUNTER`
/// are the same value (`0x80210015`) in the platform headers, so the earlier
/// row wins and the collision is pinned by test.
const HRESULT_REFUSALS: &[(i32, &str, &str)] = &[
    (
        WIA_S_NO_DEVICE_AVAILABLE.0,
        "scan.deviceGone",
        "The scanner is no longer connected.",
    ),
    (
        WIA_ERROR_DEVICE_LOCKED.0,
        "scan.deviceLocked",
        "Another program is using the scanner.",
    ),
    (
        WIA_ERROR_OFFLINE.0,
        "scan.deviceOffline",
        "The scanner is turned off or cannot be reached.",
    ),
    (
        WIA_ERROR_BUSY.0,
        "scan.deviceBusy",
        "The scanner is busy. Try again in a moment.",
    ),
    (
        WIA_ERROR_PAPER_EMPTY.0,
        "scan.feederEmpty",
        "Put paper in the feeder.",
    ),
    (
        WIA_ERROR_PAPER_JAM.0,
        "scan.paperJam",
        "Clear the paper jam, then scan again.",
    ),
    (
        WIA_ERROR_PAPER_PROBLEM.0,
        "scan.paperProblem",
        "Check the paper in the feeder.",
    ),
    (
        WIA_ERROR_COVER_OPEN.0,
        "scan.coverOpen",
        "Close the scanner cover.",
    ),
    (
        WIA_ERROR_USER_INTERVENTION.0,
        "scan.needsAttention",
        "The scanner needs attention at the device.",
    ),
    (
        WIA_ERROR_EXCEPTION_IN_DRIVER.0,
        "scan.driverError",
        "The scanner driver reported a problem.",
    ),
    (
        WIA_ERROR_INVALID_COMMAND.0,
        "scan.settingRejected",
        "The scanner rejected one of the requested settings.",
    ),
];

/// Map an HRESULT onto its named refusal. Anything the table does not name
/// becomes `scan.failed` carrying the hex code, so a bug report stays
/// actionable.
pub fn refusal_for(hr: HRESULT) -> ScanRefusal {
    for (code, key, message) in HRESULT_REFUSALS {
        if hr.0 == *code {
            return ScanRefusal::named(key, message);
        }
    }
    let hex = format!("0x{:08X}", hr.0 as u32);
    ScanRefusal {
        key: "scan.failed",
        message: format!("The scanner reported an error ({hex})."),
        code: Some(hex),
    }
}

fn refusal_from(err: windows::core::Error) -> ScanRefusal {
    refusal_for(err.code())
}

// ── Reported shapes ─────────────────────────────────────────────────────────

/// One enumerated imaging device of scanner type.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ScannerDevice {
    /// `WIA_DIP_DEV_ID` — the durable id every other call round-trips.
    pub id: String,
    /// `WIA_DIP_DEV_NAME` — what the driver calls the hardware, never
    /// translated: the OS's own scan surfaces show the same string.
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScannerList {
    pub scanners: Vec<ScannerDevice>,
    /// The caller's stored last-used id, kept only when it is still one of
    /// `scanners` — a stale id would preselect a device that is not there.
    pub default: Option<String>,
}

/// What a property's `GetPropertyAttributes` reported. The only honest source
/// for a control's legal values: a device whose resolution is a stepped range
/// and one that lists three values need different controls, and neither is a
/// hard-coded dropdown.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PropertyDomain {
    /// `WIA_PROP_NONE` — any value the property's type allows.
    None,
    List {
        values: Vec<i32>,
        nominal: Option<i32>,
    },
    Range {
        min: i32,
        max: i32,
        step: i32,
        nominal: Option<i32>,
    },
    /// `WIA_PROP_FLAG` — a bitmask; `valid` is every bit the device accepts.
    Flag {
        valid: i32,
        nominal: Option<i32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PropertyReport {
    pub id: u32,
    /// The driver's own name for the property, not translated.
    pub name: String,
    pub readable: bool,
    pub writable: bool,
    pub current: Option<i32>,
    pub domain: PropertyDomain,
}

/// What a control derived from one property can offer. `Absent` and `Fixed`
/// are the two cases that must never render an interactive control: a device
/// that reports no brightness gets no brightness slider, and a read-only
/// property gets a value, not a picker.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControlModel {
    Absent,
    Fixed {
        value: i32,
    },
    Choice {
        values: Vec<i32>,
        current: Option<i32>,
    },
    Span {
        min: i32,
        max: i32,
        step: i32,
        current: Option<i32>,
    },
    Flags {
        valid: i32,
        current: Option<i32>,
    },
}

/// Derive one control from one property report.
///
/// A property that is present but not writable can only ever show its current
/// value, and a domain that resolves to a single value is the same case: both
/// are `Fixed`, so no surface can offer a choice the device does not have.
pub fn control_model(report: Option<&PropertyReport>) -> ControlModel {
    let Some(p) = report else {
        return ControlModel::Absent;
    };
    if !p.writable {
        return match p.current {
            Some(value) => ControlModel::Fixed { value },
            None => ControlModel::Absent,
        };
    }
    match &p.domain {
        PropertyDomain::None => match p.current {
            Some(value) => ControlModel::Fixed { value },
            None => ControlModel::Absent,
        },
        PropertyDomain::List { values, .. } => {
            let mut values: Vec<i32> = values.clone();
            values.sort_unstable();
            values.dedup();
            match values.len() {
                0 => ControlModel::Absent,
                1 => ControlModel::Fixed { value: values[0] },
                _ => ControlModel::Choice {
                    values,
                    current: p.current,
                },
            }
        }
        PropertyDomain::Range {
            min, max, step, ..
        } => {
            if max < min {
                ControlModel::Absent
            } else if max == min {
                ControlModel::Fixed { value: *min }
            } else {
                // A driver that reports a zero or negative step still has a
                // usable span; one-unit steps are the honest reading of "no
                // step reported".
                ControlModel::Span {
                    min: *min,
                    max: *max,
                    step: if *step > 0 { *step } else { 1 },
                    current: p.current,
                }
            }
        }
        PropertyDomain::Flag { valid, .. } => ControlModel::Flags {
            valid: *valid,
            current: p.current,
        },
    }
}

/// The colour modes offered, in the order a dialog shows them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorMode {
    BlackAndWhite,
    Grayscale,
    Color,
    Auto,
}

/// The colour modes a device actually lists, never a fixed menu. A device
/// that does not report autodetect must not be offered it.
pub fn color_modes(report: Option<&PropertyReport>) -> Vec<ColorMode> {
    let Some(p) = report else {
        return Vec::new();
    };
    let listed: Vec<i32> = match &p.domain {
        PropertyDomain::List { values, .. } => values.clone(),
        // A device that pins its data type reports no list; the one value it
        // has is the one mode it offers.
        _ => p.current.into_iter().collect(),
    };
    let mut modes = Vec::new();
    for (value, mode) in [
        (WIA_DATA_THRESHOLD as i32, ColorMode::BlackAndWhite),
        (WIA_DATA_GRAYSCALE as i32, ColorMode::Grayscale),
        (WIA_DATA_COLOR as i32, ColorMode::Color),
        (WIA_DATA_AUTO as i32, ColorMode::Auto),
    ] {
        if listed.contains(&value) {
            modes.push(mode);
        }
    }
    modes
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceCategory {
    Flatbed,
    Feeder,
    FeederFront,
    FeederBack,
    Auto,
    Film,
    Other,
}

fn category_of(guid: &GUID) -> SourceCategory {
    if *guid == WIA_CATEGORY_FLATBED {
        SourceCategory::Flatbed
    } else if *guid == WIA_CATEGORY_FEEDER {
        SourceCategory::Feeder
    } else if *guid == WIA_CATEGORY_FEEDER_FRONT {
        SourceCategory::FeederFront
    } else if *guid == WIA_CATEGORY_FEEDER_BACK {
        SourceCategory::FeederBack
    } else if *guid == WIA_CATEGORY_AUTO {
        SourceCategory::Auto
    } else if *guid == WIA_CATEGORY_FILM {
        SourceCategory::Film
    } else {
        SourceCategory::Other
    }
}

/// How a duplex run reaches both sides of a sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DuplexMode {
    /// No duplex is offered.
    None,
    /// One stream, selected through the `DUPLEX` bit of
    /// `WIA_IPS_DOCUMENT_HANDLING_SELECT`.
    DuplexBit,
    /// Two streams: the front and back child items are transferred
    /// separately.
    FrontBackItems,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DocumentHandling {
    /// The raw `WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES` word.
    pub capabilities: i32,
    pub flatbed: bool,
    pub feeder: bool,
    pub duplex: bool,
    pub advanced_duplex: bool,
    pub duplex_mode: DuplexMode,
}

/// Read the capabilities word, masked against the child items the device
/// actually exposes.
///
/// A `DUPLEX` bit without a feeder is not a duplex offer — there is no second
/// side of a sheet on a flatbed — and `ADVANCED_DUPLEX` means the front and
/// back arrive as separate child items, so the duplex bit is not what selects
/// them.
pub fn document_handling(capabilities: i32, categories: &[SourceCategory]) -> DocumentHandling {
    let has = |bit: u32| capabilities & bit as i32 != 0;
    let feeder = has(FEEDER) || categories.contains(&SourceCategory::Feeder);
    let flatbed = has(FLATBED) || categories.contains(&SourceCategory::Flatbed);
    let duplex = has(DUPLEX) && feeder;
    let advanced_duplex = has(ADVANCED_DUPLEX) && feeder;
    let front_back = categories.contains(&SourceCategory::FeederFront)
        && categories.contains(&SourceCategory::FeederBack);
    let duplex_mode = if advanced_duplex && front_back {
        DuplexMode::FrontBackItems
    } else if duplex {
        DuplexMode::DuplexBit
    } else {
        DuplexMode::None
    };
    DocumentHandling {
        capabilities,
        flatbed,
        feeder,
        duplex,
        advanced_duplex,
        duplex_mode,
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanSourceReport {
    /// `WIA_IPA_FULL_ITEM_NAME` — the item path the transfer names.
    pub item_name: String,
    pub category: SourceCategory,
    /// Every property this report read, kind and legal values included.
    pub properties: Vec<PropertyReport>,
    pub resolution: ControlModel,
    /// `WIA_IPS_OPTICAL_XRES`, so interpolated resolutions can be marked as
    /// such rather than presented as real ones.
    pub optical_resolution: Option<i32>,
    pub color_modes: Vec<ColorMode>,
    pub brightness: ControlModel,
    pub contrast: ControlModel,
    pub pages: ControlModel,
    pub document_handling_select: ControlModel,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScannerCapabilities {
    pub device_id: String,
    pub device_name: String,
    pub document_handling: DocumentHandling,
    /// `WIA_DPS_MAX_SCAN_TIME` in milliseconds — the device's own answer to
    /// how long its slowest page takes, and the only honest basis for a
    /// watchdog.
    pub max_scan_time_ms: Option<i32>,
    pub sources: Vec<ScanSourceReport>,
}

/// The properties the report reads per scan source, in report order.
const SOURCE_PROPERTIES: &[u32] = &[
    WIA_IPS_XRES,
    WIA_IPS_YRES,
    WIA_IPS_OPTICAL_XRES,
    WIA_IPA_DATATYPE,
    WIA_IPS_DOCUMENT_HANDLING_SELECT,
    WIA_IPS_PAGES,
    WIA_IPS_BRIGHTNESS,
    WIA_IPS_CONTRAST,
    WIA_IPS_XEXTENT,
    WIA_IPS_YEXTENT,
];

fn property(properties: &[PropertyReport], id: u32) -> Option<&PropertyReport> {
    properties.iter().find(|p| p.id == id)
}

// ── PROPVARIANT reads ───────────────────────────────────────────────────────

const PRSPEC_PROPID: PROPSPEC_KIND = PROPSPEC_KIND(1);

/// STI major device type for a scanner. `WIA_DIP_DEV_TYPE` packs the major
/// type in its high word; the `windows` crate generates the constant itself
/// only behind an unrelated feature.
const STI_DEVICE_TYPE_SCANNER: i32 = 1;

fn propspec(id: u32) -> PROPSPEC {
    PROPSPEC {
        ulKind: PRSPEC_PROPID,
        Anonymous: PROPSPEC_0 { propid: id },
    }
}

/// # Safety
/// `var` must be an initialised PROPVARIANT.
unsafe fn variant_i32(var: &PROPVARIANT) -> Option<i32> {
    let inner = unsafe { &*var.Anonymous.Anonymous };
    let vt = inner.vt.0;
    unsafe {
        if vt == VT_I4.0 {
            Some(inner.Anonymous.lVal)
        } else if vt == VT_UI4.0 {
            Some(inner.Anonymous.ulVal as i32)
        } else if vt == VT_I2.0 {
            Some(inner.Anonymous.iVal as i32)
        } else if vt == VT_UI2.0 {
            Some(inner.Anonymous.uiVal as i32)
        } else {
            None
        }
    }
}

/// # Safety
/// `var` must be an initialised PROPVARIANT.
unsafe fn variant_string(var: &PROPVARIANT) -> Option<String> {
    let inner = unsafe { &*var.Anonymous.Anonymous };
    let vt = inner.vt.0;
    unsafe {
        if vt == VT_BSTR.0 {
            Some((*inner.Anonymous.bstrVal).to_string())
        } else if vt == VT_LPWSTR.0 {
            inner.Anonymous.pwszVal.to_string().ok()
        } else {
            None
        }
    }
}

/// # Safety
/// `var` must be an initialised PROPVARIANT.
unsafe fn variant_guid(var: &PROPVARIANT) -> Option<GUID> {
    let inner = unsafe { &*var.Anonymous.Anonymous };
    unsafe {
        if inner.vt.0 == VT_CLSID.0 && !inner.Anonymous.puuid.is_null() {
            Some(*inner.Anonymous.puuid)
        } else {
            None
        }
    }
}

/// # Safety
/// `var` must be an initialised PROPVARIANT.
unsafe fn variant_vector_i32(var: &PROPVARIANT) -> Vec<i32> {
    let inner = unsafe { &*var.Anonymous.Anonymous };
    let vt = inner.vt.0;
    unsafe {
        if vt == VT_VECTOR.0 | VT_I4.0 {
            let ca = &inner.Anonymous.cal;
            if ca.pElems.is_null() || ca.cElems == 0 {
                return Vec::new();
            }
            std::slice::from_raw_parts(ca.pElems, ca.cElems as usize).to_vec()
        } else if vt == VT_VECTOR.0 | VT_UI4.0 {
            let ca = &inner.Anonymous.caul;
            if ca.pElems.is_null() || ca.cElems == 0 {
                return Vec::new();
            }
            std::slice::from_raw_parts(ca.pElems, ca.cElems as usize)
                .iter()
                .map(|v| *v as i32)
                .collect()
        } else {
            // A driver that answers a vector query with a scalar still said
            // something; treat it as a one-element vector rather than losing
            // it.
            variant_i32(var).into_iter().collect()
        }
    }
}

/// # Safety
/// `store` must be a live property storage on the calling apartment.
unsafe fn read_i32(store: &IWiaPropertyStorage, id: u32) -> Option<i32> {
    let spec = propspec(id);
    let mut var = PROPVARIANT::default();
    unsafe {
        if store.ReadMultiple(1, &spec, &mut var).is_err() {
            return None;
        }
        let value = variant_i32(&var);
        let _ = PropVariantClear(&mut var);
        value
    }
}

/// # Safety
/// `store` must be a live property storage on the calling apartment.
unsafe fn read_string(store: &IWiaPropertyStorage, id: u32) -> Option<String> {
    let spec = propspec(id);
    let mut var = PROPVARIANT::default();
    unsafe {
        if store.ReadMultiple(1, &spec, &mut var).is_err() {
            return None;
        }
        let value = variant_string(&var);
        let _ = PropVariantClear(&mut var);
        value
    }
}

/// # Safety
/// `store` must be a live property storage on the calling apartment.
unsafe fn read_guid(store: &IWiaPropertyStorage, id: u32) -> Option<GUID> {
    let spec = propspec(id);
    let mut var = PROPVARIANT::default();
    unsafe {
        if store.ReadMultiple(1, &spec, &mut var).is_err() {
            return None;
        }
        let value = variant_guid(&var);
        let _ = PropVariantClear(&mut var);
        value
    }
}

/// # Safety
/// `store` must be a live property storage on the calling apartment.
unsafe fn read_property_name(store: &IWiaPropertyStorage, id: u32) -> String {
    let mut name = PWSTR::null();
    unsafe {
        if store.ReadPropertyNames(1, &id, &mut name).is_err() || name.is_null() {
            return String::new();
        }
        let text = name.to_string().unwrap_or_default();
        // ReadPropertyNames allocates with the task allocator.
        CoTaskMemFree(Some(name.as_ptr() as *const _));
        text
    }
}

/// # Safety
/// `store` must be a live property storage on the calling apartment.
unsafe fn read_property(store: &IWiaPropertyStorage, id: u32) -> Option<PropertyReport> {
    let spec = propspec(id);
    let mut flags = 0u32;
    let mut attr = PROPVARIANT::default();
    unsafe {
        if store
            .GetPropertyAttributes(1, &spec, &mut flags, &mut attr)
            .is_err()
        {
            return None;
        }
        let domain = domain_from(flags, &attr);
        let _ = PropVariantClear(&mut attr);
        Some(PropertyReport {
            id,
            name: read_property_name(store, id),
            readable: flags & WIA_PROP_READ != 0,
            writable: flags & WIA_PROP_WRITE != 0,
            current: read_i32(store, id),
            domain,
        })
    }
}

/// # Safety
/// `attr` must be the PROPVARIANT `GetPropertyAttributes` filled for `flags`.
unsafe fn domain_from(flags: u32, attr: &PROPVARIANT) -> PropertyDomain {
    let elements = unsafe { variant_vector_i32(attr) };
    let at = |index: u32| elements.get(index as usize).copied();
    if flags & WIA_PROP_LIST != 0 {
        // [count, nominal, value…] — the count is the driver's own, so the
        // slice bound stays the authority on how many are really there.
        let count = at(WIA_LIST_COUNT).unwrap_or(0).max(0) as usize;
        let values: Vec<i32> = elements
            .iter()
            .skip(WIA_LIST_VALUES as usize)
            .take(count)
            .copied()
            .collect();
        PropertyDomain::List {
            values,
            nominal: at(WIA_LIST_NOM),
        }
    } else if flags & WIA_PROP_RANGE != 0 {
        // [min, nominal, max, step]
        match (at(WIA_RANGE_MIN), at(WIA_RANGE_MAX)) {
            (Some(min), Some(max)) => PropertyDomain::Range {
                min,
                max,
                step: at(WIA_RANGE_STEP).unwrap_or(1),
                nominal: at(WIA_RANGE_NOM),
            },
            _ => PropertyDomain::None,
        }
    } else if flags & WIA_PROP_FLAG != 0 {
        // [nominal, valid bits]
        match at(WIA_FLAG_VALUES) {
            Some(valid) => PropertyDomain::Flag {
                valid,
                nominal: at(WIA_FLAG_NOM),
            },
            None => PropertyDomain::None,
        }
    } else {
        PropertyDomain::None
    }
}

// ── Enumeration ─────────────────────────────────────────────────────────────

/// List the scanners attached to this machine.
///
/// An empty list is the answer, never an error: a machine with no scanner
/// enumerates zero devices and reports no failure, and that is the state the
/// dialog's empty screen renders.
///
/// `last_used` is the caller's stored preference; it survives only when it is
/// still one of the enumerated ids.
pub fn enumerate(last_used: Option<String>) -> Result<ScannerList, ScanRefusal> {
    let scanners = in_apartment(|| unsafe {
        let manager: IWiaDevMgr2 = CoCreateInstance(&WiaDevMgr2, None, CLSCTX_LOCAL_SERVER)
            .map_err(refusal_from)?;
        let devices = manager
            .EnumDeviceInfo(WIA_DEVINFO_ENUM_LOCAL as i32)
            .map_err(refusal_from)?;
        let mut scanners: Vec<ScannerDevice> = Vec::new();
        loop {
            let mut slot: Option<IWiaPropertyStorage> = None;
            let mut fetched = 0u32;
            if devices.Next(1, &mut slot, &mut fetched).is_err() || fetched == 0 {
                break;
            }
            let Some(store) = slot else { break };
            // The major type sits in the high word of WIA_DIP_DEV_TYPE; a
            // camera or video device is not a scanner and is not offered.
            let device_type = read_i32(&store, WIA_DIP_DEV_TYPE).unwrap_or(0);
            if device_type >> 16 != STI_DEVICE_TYPE_SCANNER {
                continue;
            }
            let Some(id) = read_string(&store, WIA_DIP_DEV_ID) else {
                continue;
            };
            let name = read_string(&store, WIA_DIP_DEV_NAME).unwrap_or_else(|| id.clone());
            scanners.push(ScannerDevice { id, name });
        }
        scanners.sort_by_key(|d| d.name.to_lowercase());
        Ok(scanners)
    })?;

    let default = last_used.filter(|id| scanners.iter().any(|d| &d.id == id));
    Ok(ScannerList { scanners, default })
}

/// Run `body` on a thread with its own single-threaded apartment, and tear
/// the apartment down before returning.
///
/// Every WIA entry point needs one, and no Tauri worker can be assumed to
/// have the right apartment (or any).
fn in_apartment<T, F>(body: F) -> Result<T, ScanRefusal>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, ScanRefusal> + Send + 'static,
{
    std::thread::spawn(move || unsafe {
        let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let owned = init.is_ok();
        let outcome = catch_unwind(AssertUnwindSafe(body)).unwrap_or_else(|_| {
            Err(ScanRefusal::named(
                "scan.failed",
                "The scanner service call failed unexpectedly.",
            ))
        });
        if owned {
            CoUninitialize();
        }
        outcome
    })
    .join()
    .unwrap_or_else(|_| {
        Err(ScanRefusal::named(
            "scan.failed",
            "The scanner service call failed unexpectedly.",
        ))
    })
}

// ── The session actor ───────────────────────────────────────────────────────

/// How long a session may sit unused before the reaper drops it and releases
/// the device lock with it.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// How often the reaper looks.
const REAP_INTERVAL: Duration = Duration::from_secs(15);
/// How long the session thread waits on its channel between message pumps.
const PUMP_INTERVAL: Duration = Duration::from_millis(50);

enum Request {
    Capabilities(Sender<Result<ScannerCapabilities, ScanRefusal>>),
    Shutdown,
}

struct Session {
    requests: Sender<Request>,
    thread: Option<JoinHandle<()>>,
    last_used: Instant,
}

impl Session {
    /// Open a device on its own apartment-owning thread. The device's
    /// interfaces are created there and never leave it.
    fn open(device_id: String) -> Result<Self, ScanRefusal> {
        let (requests, inbox) = mpsc::channel::<Request>();
        let (ready, opened) = mpsc::channel::<Result<(), ScanRefusal>>();
        let thread = std::thread::spawn(move || unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let owned = init.is_ok();
            session_thread(&device_id, &ready, inbox);
            if owned {
                CoUninitialize();
            }
        });
        match opened.recv() {
            Ok(Ok(())) => Ok(Session {
                requests,
                thread: Some(thread),
                last_used: Instant::now(),
            }),
            Ok(Err(refusal)) => {
                let _ = thread.join();
                Err(refusal)
            }
            // The thread died before it answered.
            Err(_) => {
                let _ = thread.join();
                Err(ScanRefusal::named(
                    "scan.failed",
                    "The scanner session could not be started.",
                ))
            }
        }
    }

    fn capabilities(&self) -> Result<ScannerCapabilities, ScanRefusal> {
        let (reply, answer) = mpsc::channel();
        if self.requests.send(Request::Capabilities(reply)).is_err() {
            return Err(ScanRefusal::named(
                "scan.failed",
                "The scanner session is no longer running.",
            ));
        }
        answer.recv().unwrap_or_else(|_| {
            Err(ScanRefusal::named(
                "scan.failed",
                "The scanner session stopped before it answered.",
            ))
        })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.requests.send(Request::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The body of a session thread: create the device, answer requests, and
/// release the device before the apartment goes away.
///
/// # Safety
/// Must run on a thread that has entered a single-threaded apartment.
unsafe fn session_thread(
    device_id: &str,
    ready: &Sender<Result<(), ScanRefusal>>,
    inbox: Receiver<Request>,
) {
    let opened = unsafe {
        (|| -> Result<(IWiaDevMgr2, IWiaItem2), ScanRefusal> {
            let manager: IWiaDevMgr2 = CoCreateInstance(&WiaDevMgr2, None, CLSCTX_LOCAL_SERVER)
                .map_err(refusal_from)?;
            let root = manager
                .CreateDevice(0, &BSTR::from(device_id))
                .map_err(refusal_from)?;
            Ok((manager, root))
        })()
    };
    let (manager, root) = match opened {
        Ok(pair) => {
            let _ = ready.send(Ok(()));
            pair
        }
        Err(refusal) => {
            let _ = ready.send(Err(refusal));
            return;
        }
    };

    loop {
        // A single-threaded apartment delivers incoming COM calls as window
        // messages; a thread parked on the channel alone would starve them.
        unsafe { pump_messages() };
        match inbox.recv_timeout(PUMP_INTERVAL) {
            Ok(Request::Capabilities(reply)) => {
                // A panic here would unwind through the COM frames and leave
                // the device locked for the life of the process.
                let report = catch_unwind(AssertUnwindSafe(|| unsafe {
                    capability_report(device_id, &root)
                }))
                .unwrap_or_else(|_| {
                    Err(ScanRefusal::named(
                        "scan.failed",
                        "The scanner driver failed while reporting what it can do.",
                    ))
                });
                let _ = reply.send(report);
            }
            Ok(Request::Shutdown) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Explicit, and in this order: the device lock is held until the last
    // interface on it is released.
    drop(root);
    drop(manager);
}

/// # Safety
/// Must run on the thread that owns the apartment being pumped.
unsafe fn pump_messages() {
    let mut message = MSG::default();
    unsafe {
        while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

/// # Safety
/// `root` must belong to the calling thread's apartment.
unsafe fn capability_report(
    device_id: &str,
    root: &IWiaItem2,
) -> Result<ScannerCapabilities, ScanRefusal> {
    unsafe {
        let root_store: IWiaPropertyStorage = root.cast().map_err(refusal_from)?;
        let device_name =
            read_string(&root_store, WIA_DIP_DEV_NAME).unwrap_or_else(|| device_id.to_string());
        let capabilities = read_i32(&root_store, WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES).unwrap_or(0);
        let max_scan_time_ms = read_i32(&root_store, WIA_DPS_MAX_SCAN_TIME);

        let children: IEnumWiaItem2 = root.EnumChildItems(None).map_err(refusal_from)?;
        let mut sources: Vec<ScanSourceReport> = Vec::new();
        loop {
            let mut slot: [Option<IWiaItem2>; 1] = [None];
            let mut fetched = 0u32;
            if children.Next(1, slot.as_mut_ptr(), &mut fetched).is_err() || fetched == 0 {
                break;
            }
            let Some(child) = slot[0].take() else { break };
            let Ok(store) = child.cast::<IWiaPropertyStorage>() else {
                continue;
            };
            // Two readings of the same fact: a driver that does not implement
            // GetItemCategory still carries WIA_IPA_ITEM_CATEGORY, and an
            // unreadable category would drop a working scan source.
            let category = child
                .GetItemCategory()
                .ok()
                .or_else(|| read_guid(&store, WIA_IPA_ITEM_CATEGORY))
                .map(|guid| category_of(&guid))
                .unwrap_or(SourceCategory::Other);
            // An endorser, a barcode reader or a stored-file folder is a
            // child item too; only the items that produce a scanned page are
            // scan sources.
            if matches!(category, SourceCategory::Other) {
                continue;
            }
            let item_name = read_string(&store, WIA_IPA_FULL_ITEM_NAME).unwrap_or_default();
            let properties: Vec<PropertyReport> = SOURCE_PROPERTIES
                .iter()
                .filter_map(|id| read_property(&store, *id))
                .collect();
            sources.push(ScanSourceReport {
                item_name,
                category,
                resolution: control_model(property(&properties, WIA_IPS_XRES)),
                optical_resolution: property(&properties, WIA_IPS_OPTICAL_XRES)
                    .and_then(|p| p.current),
                color_modes: color_modes(property(&properties, WIA_IPA_DATATYPE)),
                brightness: control_model(property(&properties, WIA_IPS_BRIGHTNESS)),
                contrast: control_model(property(&properties, WIA_IPS_CONTRAST)),
                pages: control_model(property(&properties, WIA_IPS_PAGES)),
                document_handling_select: control_model(property(
                    &properties,
                    WIA_IPS_DOCUMENT_HANDLING_SELECT,
                )),
                properties,
            });
        }

        let categories: Vec<SourceCategory> = sources.iter().map(|s| s.category).collect();
        Ok(ScannerCapabilities {
            device_id: device_id.to_string(),
            device_name,
            document_handling: document_handling(capabilities, &categories),
            max_scan_time_ms,
            sources,
        })
    }
}

// ── Session store ───────────────────────────────────────────────────────────

/// The live sessions, one per device id.
///
/// Managed Tauri state in the app and a local value in the CLI, so both reach
/// a device the same way. Dropping the store closes every session it holds,
/// which is what releases the device locks.
pub struct ScannerSessions {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    /// The reaper starts with the first session, so a process that never
    /// opens a device never grows the thread.
    reaper: std::sync::Once,
}

impl Default for ScannerSessions {
    fn default() -> Self {
        Self::new()
    }
}

impl ScannerSessions {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            reaper: std::sync::Once::new(),
        }
    }

    fn start_reaper(&self) {
        // The reaper holds a weak reference, so it ends when the store does.
        let watched: Weak<Mutex<HashMap<String, Session>>> = Arc::downgrade(&self.sessions);
        self.reaper.call_once(move || {
            std::thread::spawn(move || loop {
                std::thread::sleep(REAP_INTERVAL);
                let Some(sessions) = watched.upgrade() else {
                    return;
                };
                let Ok(mut open) = sessions.lock() else {
                    return;
                };
                open.retain(|_, session| session.last_used.elapsed() < IDLE_TIMEOUT);
            });
        });
    }

    /// One device's capability report, opening a session for it if none is
    /// live.
    pub fn capabilities(&self, device_id: &str) -> Result<ScannerCapabilities, ScanRefusal> {
        let mut open = self.sessions.lock().map_err(|_| {
            ScanRefusal::named("scan.failed", "The scanner session store is unusable.")
        })?;
        if !open.contains_key(device_id) {
            let session = Session::open(device_id.to_string())?;
            self.start_reaper();
            open.insert(device_id.to_string(), session);
        }
        let session = open.get_mut(device_id).expect("session was just inserted");
        session.last_used = Instant::now();
        let report = session.capabilities();
        if report.is_err() {
            // A session that failed its own report is not one to keep a
            // device locked with.
            open.remove(device_id);
        }
        report
    }

    /// Close the session on one device, releasing its lock now rather than at
    /// the idle timeout.
    pub fn close(&self, device_id: &str) {
        if let Ok(mut open) = self.sessions.lock() {
            open.remove(device_id);
        }
    }
}

// ── The system device picker ────────────────────────────────────────────────

/// `IWiaDevMgr2::SelectDeviceDlgID` — the door for a device our enumeration
/// filter drops, such as a multifunction whose scan function reports an
/// unexpected type.
///
/// Returns the chosen device id; `None` when the user cancels. The id then
/// flows through the ordinary capability path, so this is a door and not a
/// second route.
pub fn select_device_dialog(parent: usize) -> Result<Option<String>, ScanRefusal> {
    in_apartment(move || unsafe {
        let manager: IWiaDevMgr2 =
            CoCreateInstance(&WiaDevMgr2, None, CLSCTX_LOCAL_SERVER).map_err(refusal_from)?;
        let mut chosen = BSTR::new();
        // The dialog is parented to the app window but pumped on this
        // thread's own apartment, which is where the device manager lives.
        let hwnd = HWND(parent as *mut std::ffi::c_void);
        match manager.SelectDeviceDlgID(hwnd, STI_DEVICE_TYPE_SCANNER, 0, &mut chosen) {
            Ok(()) => {
                let id = chosen.to_string();
                if id.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(id))
                }
            }
            // A cancelled picker is a result, not a failure.
            Err(e) if e.code() == HRESULT(1) || e.code() == WIA_S_NO_DEVICE_AVAILABLE => Ok(None),
            Err(e) => Err(refusal_from(e)),
        }
    })
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Scanners attached to this machine, plus the caller's last-used device when
/// it is still one of them.
#[tauri::command]
pub async fn list_scanners(last_used: Option<String>) -> Result<ScannerList, ScanRefusal> {
    enumerate(last_used)
}

/// One device's scan sources and what each of them reports it can do.
#[tauri::command]
pub async fn scanner_capabilities(
    sessions: tauri::State<'_, ScannerSessions>,
    device_id: String,
) -> Result<ScannerCapabilities, ScanRefusal> {
    sessions.capabilities(&device_id)
}

/// Release a device now instead of at the idle timeout.
#[tauri::command]
pub async fn scanner_close(
    sessions: tauri::State<'_, ScannerSessions>,
    device_id: String,
) -> Result<(), ScanRefusal> {
    sessions.close(&device_id);
    Ok(())
}

/// The system device picker.
#[tauri::command]
pub async fn scanner_select_dialog(
    window: tauri::WebviewWindow,
) -> Result<Option<String>, ScanRefusal> {
    let parent = window.hwnd().map(|h| h.0 as usize).unwrap_or(0);
    select_device_dialog(parent)
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Devices::ImageAcquisition::{
        WIA_ERROR_GENERAL_ERROR, WIA_ERROR_MAXIMUM_PRINTER_ENDORSER_COUNTER,
    };

    fn report(writable: bool, current: Option<i32>, domain: PropertyDomain) -> PropertyReport {
        PropertyReport {
            id: WIA_IPS_XRES,
            name: "Horizontal Resolution".into(),
            readable: true,
            writable,
            current,
            domain,
        }
    }

    #[test]
    fn a_scannerless_machine_enumerates_empty_and_does_not_fail() {
        // The contract the empty state rests on: no device is a result.
        let list = enumerate(None).expect("enumeration is never an error");
        for device in &list.scanners {
            assert!(!device.id.is_empty(), "an enumerated device carries an id");
        }
        assert!(list.default.is_none());
    }

    #[test]
    fn a_last_used_device_that_is_gone_is_dropped() {
        // The phantom-default rule, at its second site: a stored id that no
        // longer enumerates must not preselect a device that is not there.
        let list = enumerate(Some("no-such-device".into())).expect("enumeration is never an error");
        let enumerated = list.scanners.iter().any(|d| d.id == "no-such-device");
        assert!(!enumerated);
        assert_eq!(list.default, None);
    }

    #[test]
    fn every_named_hresult_maps_to_its_own_refusal() {
        let rows: &[(HRESULT, &str)] = &[
            (WIA_S_NO_DEVICE_AVAILABLE, "scan.deviceGone"),
            (WIA_ERROR_DEVICE_LOCKED, "scan.deviceLocked"),
            (WIA_ERROR_OFFLINE, "scan.deviceOffline"),
            (WIA_ERROR_BUSY, "scan.deviceBusy"),
            (WIA_ERROR_PAPER_EMPTY, "scan.feederEmpty"),
            (WIA_ERROR_PAPER_JAM, "scan.paperJam"),
            (WIA_ERROR_PAPER_PROBLEM, "scan.paperProblem"),
            (WIA_ERROR_COVER_OPEN, "scan.coverOpen"),
            (WIA_ERROR_USER_INTERVENTION, "scan.needsAttention"),
            (WIA_ERROR_EXCEPTION_IN_DRIVER, "scan.driverError"),
            (WIA_ERROR_INVALID_COMMAND, "scan.settingRejected"),
        ];
        for (hr, key) in rows {
            let refusal = refusal_for(*hr);
            assert_eq!(refusal.key, *key, "{hr:?}");
            assert!(!refusal.message.is_empty(), "{key} has no sentence");
            assert!(refusal.code.is_none(), "{key} is named, not a hex fallback");
        }
        // Every row names a distinct key.
        let mut keys: Vec<&str> = rows.iter().map(|(_, key)| *key).collect();
        keys.sort_unstable();
        let named = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), named);
    }

    #[test]
    fn an_unnamed_hresult_carries_its_hex_code() {
        let refusal = refusal_for(WIA_ERROR_GENERAL_ERROR);
        assert_eq!(refusal.key, "scan.failed");
        assert_eq!(refusal.code.as_deref(), Some("0x80210001"));
        assert!(refusal.message.contains("0x80210001"));

        let refusal = refusal_for(HRESULT(0x8007_0005u32 as i32));
        assert_eq!(refusal.key, "scan.failed");
        assert_eq!(refusal.code.as_deref(), Some("0x80070005"));
    }

    #[test]
    fn the_shared_hresult_resolves_to_the_device_gone_row() {
        // WIA_S_NO_DEVICE_AVAILABLE and the endorser-counter error are the
        // same value in the platform headers; the table's order decides, and
        // it decides in favour of the row a user can act on.
        assert_eq!(
            WIA_S_NO_DEVICE_AVAILABLE.0,
            WIA_ERROR_MAXIMUM_PRINTER_ENDORSER_COUNTER.0
        );
        assert_eq!(refusal_for(WIA_S_NO_DEVICE_AVAILABLE).key, "scan.deviceGone");
    }

    #[test]
    fn an_absent_property_renders_no_control() {
        assert_eq!(control_model(None), ControlModel::Absent);
    }

    #[test]
    fn a_read_only_property_is_a_value_not_a_picker() {
        let p = report(
            false,
            Some(300),
            PropertyDomain::List {
                values: vec![100, 200, 300],
                nominal: Some(300),
            },
        );
        assert_eq!(control_model(Some(&p)), ControlModel::Fixed { value: 300 });

        // Read-only with nothing to show is nothing to render.
        let p = report(false, None, PropertyDomain::None);
        assert_eq!(control_model(Some(&p)), ControlModel::Absent);
    }

    #[test]
    fn a_listed_property_offers_exactly_what_it_lists() {
        let p = report(
            true,
            Some(200),
            PropertyDomain::List {
                values: vec![300, 100, 200, 100],
                nominal: Some(200),
            },
        );
        assert_eq!(
            control_model(Some(&p)),
            ControlModel::Choice {
                values: vec![100, 200, 300],
                current: Some(200),
            }
        );
    }

    #[test]
    fn a_one_value_list_is_fixed_and_an_empty_one_is_absent() {
        let p = report(
            true,
            Some(600),
            PropertyDomain::List {
                values: vec![600],
                nominal: Some(600),
            },
        );
        assert_eq!(control_model(Some(&p)), ControlModel::Fixed { value: 600 });

        let p = report(
            true,
            Some(600),
            PropertyDomain::List {
                values: vec![],
                nominal: None,
            },
        );
        assert_eq!(control_model(Some(&p)), ControlModel::Absent);
    }

    #[test]
    fn a_range_keeps_its_own_step_and_collapses_when_it_has_one_value() {
        let p = report(
            true,
            Some(300),
            PropertyDomain::Range {
                min: 75,
                max: 1200,
                step: 25,
                nominal: Some(300),
            },
        );
        assert_eq!(
            control_model(Some(&p)),
            ControlModel::Span {
                min: 75,
                max: 1200,
                step: 25,
                current: Some(300),
            }
        );

        // A range whose min equals its max offers one value, not a slider.
        let p = report(
            true,
            Some(300),
            PropertyDomain::Range {
                min: 300,
                max: 300,
                step: 1,
                nominal: Some(300),
            },
        );
        assert_eq!(control_model(Some(&p)), ControlModel::Fixed { value: 300 });

        // A driver that reports no usable step still has a usable span.
        let p = report(
            true,
            Some(0),
            PropertyDomain::Range {
                min: -1000,
                max: 1000,
                step: 0,
                nominal: Some(0),
            },
        );
        assert_eq!(
            control_model(Some(&p)),
            ControlModel::Span {
                min: -1000,
                max: 1000,
                step: 1,
                current: Some(0),
            }
        );

        // An inverted range is not a control.
        let p = report(
            true,
            None,
            PropertyDomain::Range {
                min: 600,
                max: 300,
                step: 1,
                nominal: None,
            },
        );
        assert_eq!(control_model(Some(&p)), ControlModel::Absent);
    }

    #[test]
    fn a_flag_property_reports_its_valid_bits() {
        let p = report(
            true,
            Some(FEEDER as i32),
            PropertyDomain::Flag {
                valid: (FEEDER | FLATBED | DUPLEX) as i32,
                nominal: Some(FLATBED as i32),
            },
        );
        assert_eq!(
            control_model(Some(&p)),
            ControlModel::Flags {
                valid: (FEEDER | FLATBED | DUPLEX) as i32,
                current: Some(FEEDER as i32),
            }
        );
    }

    #[test]
    fn a_property_with_no_domain_shows_the_value_it_has() {
        let p = report(true, Some(1), PropertyDomain::None);
        assert_eq!(control_model(Some(&p)), ControlModel::Fixed { value: 1 });
    }

    #[test]
    fn colour_modes_come_only_from_what_the_device_lists() {
        let p = PropertyReport {
            id: WIA_IPA_DATATYPE,
            name: "Data Type".into(),
            readable: true,
            writable: true,
            current: Some(WIA_DATA_COLOR as i32),
            domain: PropertyDomain::List {
                values: vec![
                    WIA_DATA_COLOR as i32,
                    WIA_DATA_THRESHOLD as i32,
                    WIA_DATA_GRAYSCALE as i32,
                    // A raw-format data type is not one of our modes.
                    7,
                ],
                nominal: Some(WIA_DATA_COLOR as i32),
            },
        };
        assert_eq!(
            color_modes(Some(&p)),
            vec![
                ColorMode::BlackAndWhite,
                ColorMode::Grayscale,
                ColorMode::Color
            ]
        );

        // Autodetect is offered only where it is listed.
        assert!(!color_modes(Some(&p)).contains(&ColorMode::Auto));
        assert_eq!(color_modes(None), Vec::<ColorMode>::new());
    }

    #[test]
    fn a_pinned_data_type_offers_the_one_mode_it_has() {
        let p = PropertyReport {
            id: WIA_IPA_DATATYPE,
            name: "Data Type".into(),
            readable: true,
            writable: false,
            current: Some(WIA_DATA_GRAYSCALE as i32),
            domain: PropertyDomain::None,
        };
        assert_eq!(color_modes(Some(&p)), vec![ColorMode::Grayscale]);
    }

    #[test]
    fn duplex_without_a_feeder_is_not_offered() {
        let handling = document_handling(
            (FLATBED | DUPLEX) as i32,
            &[SourceCategory::Flatbed],
        );
        assert!(handling.flatbed);
        assert!(!handling.feeder);
        assert!(!handling.duplex);
        assert_eq!(handling.duplex_mode, DuplexMode::None);
    }

    #[test]
    fn a_feeder_with_the_duplex_bit_selects_one_duplex_stream() {
        let handling = document_handling(
            (FLATBED | FEEDER | DUPLEX) as i32,
            &[SourceCategory::Flatbed, SourceCategory::Feeder],
        );
        assert!(handling.duplex);
        assert!(!handling.advanced_duplex);
        assert_eq!(handling.duplex_mode, DuplexMode::DuplexBit);
    }

    #[test]
    fn advanced_duplex_selects_the_front_and_back_items() {
        let handling = document_handling(
            (FEEDER | DUPLEX | ADVANCED_DUPLEX) as i32,
            &[
                SourceCategory::Feeder,
                SourceCategory::FeederFront,
                SourceCategory::FeederBack,
            ],
        );
        assert!(handling.advanced_duplex);
        assert_eq!(handling.duplex_mode, DuplexMode::FrontBackItems);
    }

    #[test]
    fn advanced_duplex_without_the_two_items_falls_back_to_the_duplex_bit() {
        // Devices reporting ADVANCED_DUPLEX without front/back children are
        // the case the plain bit exists for.
        let handling = document_handling(
            (FEEDER | DUPLEX | ADVANCED_DUPLEX) as i32,
            &[SourceCategory::Feeder],
        );
        assert!(handling.advanced_duplex);
        assert_eq!(handling.duplex_mode, DuplexMode::DuplexBit);
    }

    #[test]
    fn a_child_item_can_prove_a_feeder_the_capabilities_word_omits() {
        let handling = document_handling(0, &[SourceCategory::Feeder]);
        assert!(handling.feeder);
        assert!(!handling.duplex);
    }

    #[test]
    fn a_scan_category_is_recognised_by_its_own_guid() {
        assert_eq!(category_of(&WIA_CATEGORY_FLATBED), SourceCategory::Flatbed);
        assert_eq!(category_of(&WIA_CATEGORY_FEEDER), SourceCategory::Feeder);
        assert_eq!(
            category_of(&WIA_CATEGORY_FEEDER_FRONT),
            SourceCategory::FeederFront
        );
        assert_eq!(
            category_of(&WIA_CATEGORY_FEEDER_BACK),
            SourceCategory::FeederBack
        );
        assert_eq!(category_of(&GUID::zeroed()), SourceCategory::Other);
    }

    #[test]
    fn an_unknown_device_refuses_by_name() {
        let sessions = ScannerSessions::new();
        let refusal = sessions
            .capabilities("no-such-device")
            .expect_err("an id that names no device cannot report capabilities");
        assert!(
            refusal.key.starts_with("scan."),
            "refused with {}",
            refusal.key
        );
    }
}
