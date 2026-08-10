//! Windows scanner acquisition — WIA 2.0 device enumeration, the capability
//! report, and the page transfer.
//!
//! One implementation shared by the GUI (`list_scanners` /
//! `scanner_capabilities` / `scan_acquire` / `scan_cancel` /
//! `scanner_select_dialog`) and the CLI (`scanners` and `scan`) — the
//! `printers.rs` shape, so neither surface can hold a different idea of what a
//! device is.
//!
//! # Cancel is a flag, and a cancelled run is a result
//!
//! The scan thread is inside the driver for the whole transfer, so a cancel
//! cannot be a call into the transfer object. `scan_cancel` sets an
//! `AtomicBool` the callback reads, and the next callback tick returns
//! `S_FALSE`. What comes back is a [`ScanResult`] carrying the pages that
//! completed: a user who cancels a fifty-page feeder run at page thirty wants
//! the thirty.
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
use std::os::windows::ffi::OsStrExt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::{implement, Interface, BSTR, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Devices::ImageAcquisition::{
    IEnumWiaItem2, IWiaDevMgr2, IWiaItem2, IWiaPropertyStorage, IWiaTransfer,
    IWiaTransferCallback, IWiaTransferCallback_Impl, WiaDevMgr2, WiaImgFmt_BMP, WiaImgFmt_PNG,
    WiaImgFmt_TIFF, WiaTransferParams, ADVANCED_DUPLEX,
    DUPLEX, FEEDER, FLATBED, WIA_CATEGORY_AUTO, WIA_CATEGORY_FEEDER, WIA_CATEGORY_FEEDER_BACK,
    WIA_CATEGORY_FEEDER_FRONT, WIA_CATEGORY_FLATBED, WIA_CATEGORY_FILM, WIA_DATA_AUTO,
    WIA_DATA_COLOR, WIA_DATA_GRAYSCALE, WIA_DATA_THRESHOLD, WIA_DEVINFO_ENUM_LOCAL,
    WIA_DIP_DEV_ID, WIA_DIP_DEV_NAME, WIA_DIP_DEV_TYPE,
    WIA_DPS_DOCUMENT_HANDLING_CAPABILITIES, WIA_DPS_MAX_SCAN_TIME, WIA_ERROR_BUSY,
    WIA_ERROR_COVER_OPEN, WIA_ERROR_DEVICE_LOCKED, WIA_ERROR_EXCEPTION_IN_DRIVER,
    WIA_ERROR_INVALID_COMMAND, WIA_ERROR_OFFLINE, WIA_ERROR_PAPER_EMPTY, WIA_ERROR_PAPER_JAM,
    WIA_ERROR_PAPER_PROBLEM, WIA_ERROR_USER_INTERVENTION, WIA_FLAG_NOM, WIA_FLAG_VALUES,
    WIA_IPA_DATATYPE, WIA_IPA_FORMAT,
    WIA_IPA_FULL_ITEM_NAME, WIA_IPA_ITEM_CATEGORY, WIA_IPA_TYMED, WIA_IPS_BRIGHTNESS,
    WIA_IPS_CONTRAST,
    WIA_IPS_DOCUMENT_HANDLING_SELECT, WIA_IPS_OPTICAL_XRES, WIA_IPS_PAGES, WIA_IPS_XEXTENT,
    WIA_IPS_XPOS, WIA_IPS_XRES, WIA_IPS_YEXTENT, WIA_IPS_YPOS, WIA_IPS_YRES, WIA_LIST_COUNT,
    WIA_LIST_NOM, WIA_LIST_VALUES,
    WIA_PROP_FLAG, WIA_PROP_LIST, WIA_PROP_RANGE, WIA_PROP_READ, WIA_PROP_WRITE, WIA_RANGE_MAX,
    WIA_RANGE_MIN, WIA_RANGE_NOM, WIA_RANGE_STEP, WIA_S_NO_DEVICE_AVAILABLE,
    WIA_STATUS_WARMING_UP, WIA_TRANSFER_MSG_DEVICE_STATUS, WIA_TRANSFER_MSG_END_OF_STREAM,
    WIA_TRANSFER_MSG_END_OF_TRANSFER, WIA_TRANSFER_MSG_NEW_PAGE, WIA_TRANSFER_MSG_STATUS,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::StructuredStorage::{
    PropVariantClear, PROPSPEC, PROPSPEC_0, PROPSPEC_KIND, PROPVARIANT,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IStream, CLSCTX_LOCAL_SERVER,
    COINIT_APARTMENTTHREADED, STGM_CREATE, STGM_SHARE_EXCLUSIVE, STGM_WRITE, TYMED_FILE,
};
use windows::Win32::System::Variant::{
    VT_BSTR, VT_CLSID, VT_I2, VT_I4, VT_LPWSTR, VT_UI2, VT_UI4, VT_VECTOR,
};
use windows::Win32::UI::Shell::SHCreateStreamOnFileEx;
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorMode {
    BlackAndWhite,
    Grayscale,
    Color,
    Auto,
}

impl ColorMode {
    /// The `WIA_IPA_DATATYPE` value this mode writes.
    pub fn data_type(self) -> i32 {
        match self {
            ColorMode::BlackAndWhite => WIA_DATA_THRESHOLD as i32,
            ColorMode::Grayscale => WIA_DATA_GRAYSCALE as i32,
            ColorMode::Color => WIA_DATA_COLOR as i32,
            ColorMode::Auto => WIA_DATA_AUTO as i32,
        }
    }
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

/// `FILE_ATTRIBUTE_NORMAL`, for the staged page files. Named here rather than
/// pulled in behind another crate feature, the `STI_DEVICE_TYPE_SCANNER`
/// precedent — one frozen constant.
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;

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
/// `var` must be an initialised PROPVARIANT.
unsafe fn variant_vector_guid(var: &PROPVARIANT) -> Vec<GUID> {
    let inner = unsafe { &*var.Anonymous.Anonymous };
    unsafe {
        if inner.vt.0 != VT_VECTOR.0 | VT_CLSID.0 {
            return variant_guid(var).into_iter().collect();
        }
        let ca = &inner.Anonymous.cauuid;
        if ca.pElems.is_null() || ca.cElems == 0 {
            return Vec::new();
        }
        std::slice::from_raw_parts(ca.pElems, ca.cElems as usize).to_vec()
    }
}

/// A `VT_I4` PROPVARIANT. Owns nothing, so it is never cleared.
fn propvariant_i32(value: i32) -> PROPVARIANT {
    let mut var = PROPVARIANT::default();
    unsafe {
        let inner = &mut *var.Anonymous.Anonymous;
        inner.vt = VT_I4;
        inner.Anonymous.lVal = value;
    }
    var
}

/// A `VT_CLSID` PROPVARIANT BORROWING `guid`.
///
/// The variant points at the caller's GUID rather than owning a task-allocated
/// copy, which is why it must never reach `PropVariantClear`: that would hand
/// `CoTaskMemFree` a pointer it did not allocate. `WriteMultiple` only reads
/// the value, so borrowing is enough and the caller keeps `guid` alive across
/// the call.
fn propvariant_guid(guid: &mut GUID) -> PROPVARIANT {
    let mut var = PROPVARIANT::default();
    unsafe {
        let inner = &mut *var.Anonymous.Anonymous;
        inner.vt = VT_CLSID;
        inner.Anonymous.puuid = guid as *mut GUID;
    }
    var
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
unsafe fn write_i32(store: &IWiaPropertyStorage, id: u32, value: i32) -> bool {
    let spec = propspec(id);
    let var = propvariant_i32(value);
    unsafe { store.WriteMultiple(1, &spec, &var, 2).is_ok() }
}

/// # Safety
/// `store` must be a live property storage on the calling apartment.
unsafe fn write_guid(store: &IWiaPropertyStorage, id: u32, mut value: GUID) -> bool {
    let spec = propspec(id);
    let var = propvariant_guid(&mut value);
    unsafe { store.WriteMultiple(1, &spec, &var, 2).is_ok() }
}

/// Every GUID `GetPropertyAttributes` returned for `WIA_IPA_FORMAT`, header
/// slots included.
///
/// The list's leading slots encode the element count and the nominal value
/// rather than naming formats, and their encoding differs between drivers. The
/// vector is therefore never indexed: `chosen_format` only tests MEMBERSHIP,
/// and no count-or-nominal slot can collide with a `WiaImgFmt_*` GUID.
///
/// # Safety
/// `store` must be a live property storage on the calling apartment.
unsafe fn listed_formats(store: &IWiaPropertyStorage) -> Vec<GUID> {
    let spec = propspec(WIA_IPA_FORMAT);
    let mut flags = 0u32;
    let mut attr = PROPVARIANT::default();
    unsafe {
        if store
            .GetPropertyAttributes(1, &spec, &mut flags, &mut attr)
            .is_err()
        {
            return Vec::new();
        }
        let all = variant_vector_guid(&attr);
        let _ = PropVariantClear(&mut attr);
        all
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
    Acquire(AcquireRequest),
    Shutdown,
}

struct Session {
    requests: Sender<Request>,
    thread: Option<JoinHandle<()>>,
    last_used: Instant,
    /// Read by the transfer callback on every tick. Cancel is a flag rather
    /// than a call because the scan thread is inside the driver for the whole
    /// run, and `scan_cancel` arrives on another thread entirely.
    cancel: Arc<AtomicBool>,
    /// A device is held by at most one run: a queued scan would start minutes
    /// later against paper that is no longer in the tray.
    busy: Arc<AtomicBool>,
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
                cancel: Arc::new(AtomicBool::new(false)),
                busy: Arc::new(AtomicBool::new(false)),
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
            Ok(Request::Acquire(request)) => {
                let AcquireRequest {
                    settings,
                    dir,
                    sink,
                    cancel,
                    reply,
                } = request;
                let outcome = catch_unwind(AssertUnwindSafe(|| unsafe {
                    acquire(&root, settings, dir, sink, cancel)
                }))
                .unwrap_or_else(|_| {
                    Err(ScanRefusal::named(
                        "scan.failed",
                        "The scanner driver failed during the scan.",
                    ))
                });
                let _ = reply.send(outcome);
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

// ── Acquisition ─────────────────────────────────────────────────────────────

/// The paper sizes the scan area dropdown offers. `Auto` writes no area at
/// all, which leaves the device's own full bed — the only honest reading of
/// "whatever is on the glass".
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaperSize {
    Auto,
    Letter,
    Legal,
    Tabloid,
    A3,
    A4,
    A5,
}

/// Every paper size this build offers, in dropdown order.
pub const PAPER_SIZES: &[PaperSize] = &[
    PaperSize::Auto,
    PaperSize::Letter,
    PaperSize::Legal,
    PaperSize::Tabloid,
    PaperSize::A3,
    PaperSize::A4,
    PaperSize::A5,
];

impl PaperSize {
    /// Width × height in inches, portrait. The metric sizes are their exact
    /// millimetre definitions converted at 25.4 mm to the inch, not rounded
    /// inch approximations — a 0.5 mm error is 12 pixels at 600 dpi.
    pub fn dimensions_in(self) -> Option<(f64, f64)> {
        let mm = |w: f64, h: f64| Some((w / 25.4, h / 25.4));
        match self {
            PaperSize::Auto => None,
            PaperSize::Letter => Some((8.5, 11.0)),
            PaperSize::Legal => Some((8.5, 14.0)),
            PaperSize::Tabloid => Some((11.0, 17.0)),
            PaperSize::A3 => mm(297.0, 420.0),
            PaperSize::A4 => mm(210.0, 297.0),
            PaperSize::A5 => mm(148.0, 210.0),
        }
    }

    /// The wire spelling, so the CLI can accept the same vocabulary the
    /// dialog sends.
    pub fn parse(text: &str) -> Option<Self> {
        match text.to_ascii_lowercase().as_str() {
            "auto" => Some(PaperSize::Auto),
            "letter" => Some(PaperSize::Letter),
            "legal" => Some(PaperSize::Legal),
            "tabloid" => Some(PaperSize::Tabloid),
            "a3" => Some(PaperSize::A3),
            "a4" => Some(PaperSize::A4),
            "a5" => Some(PaperSize::A5),
            _ => None,
        }
    }
}

/// `WIA_IPS_XPOS` / `YPOS` / `XEXTENT` / `YEXTENT`, in PIXELS at the
/// resolution that will be in force for the transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct ScanArea {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// The scan area for a paper size at a resolution, clamped to the bed.
///
/// Extents are pixels, so they depend on the resolution and must be computed
/// AFTER the resolution is written — a Letter area computed at 300 dpi and
/// applied at 600 would scan the top-left quarter of the sheet.
///
/// `max_width` / `max_height` are the device's own reported extent maxima at
/// that resolution, i.e. its bed. A sheet longer than the bed is clamped
/// rather than refused: a legal-size request on a letter-size flatbed scans
/// the letter-size area it has, which is what the glass can see.
///
/// `Auto` returns nothing at all, and nothing is then written.
pub fn scan_area(
    paper: PaperSize,
    dpi: i32,
    max_width: Option<i32>,
    max_height: Option<i32>,
) -> Option<ScanArea> {
    let (width_in, height_in) = paper.dimensions_in()?;
    if dpi <= 0 {
        return None;
    }
    // Round to the nearest pixel, never truncate: truncation loses up to a
    // pixel per axis on every page, and a page one pixel short of the sheet
    // is a page with a white line where the sheet's edge was.
    let pixels = |inches: f64| ((inches * dpi as f64).round() as i64).clamp(1, i32::MAX as i64) as i32;
    let mut width = pixels(width_in);
    let mut height = pixels(height_in);
    if let Some(max) = max_width.filter(|m| *m > 0) {
        width = width.min(max);
    }
    if let Some(max) = max_height.filter(|m| *m > 0) {
        height = height.min(max);
    }
    Some(ScanArea {
        x: 0,
        y: 0,
        width,
        height,
    })
}

/// The transfer format, chosen from what the source lists.
///
/// BMP first because every WIA driver supports it, it is lossless, and its
/// header carries pixels-per-metre — which is what makes the requested
/// resolution survive into `create_pdf`'s DPI-honest page sizing. PNG and
/// TIFF are the fallbacks for a source that lists neither.
pub fn chosen_format(listed: &[GUID]) -> (GUID, &'static str) {
    for (guid, extension) in [
        (WiaImgFmt_BMP, "bmp"),
        (WiaImgFmt_PNG, "png"),
        (WiaImgFmt_TIFF, "tif"),
    ] {
        if listed.contains(&guid) {
            return (guid, extension);
        }
    }
    // A source that lists nothing still transfers; BMP is the format every
    // WIA driver is required to support.
    (WiaImgFmt_BMP, "bmp")
}

/// What the dialog (or the CLI) asked for. Every field is optional: a control
/// the device did not report is a control the dialog did not render, so its
/// setting is absent rather than guessed.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct ScanSettings {
    /// `WIA_IPA_FULL_ITEM_NAME` of the chosen scan source; the first reported
    /// source when absent.
    pub item_name: Option<String>,
    pub dpi: Option<i32>,
    pub color_mode: Option<ColorMode>,
    pub paper: Option<PaperSize>,
    /// `WIA_IPS_PAGES`; `0` is "until the feeder empties".
    pub pages: Option<i32>,
    /// The `WIA_IPS_DOCUMENT_HANDLING_SELECT` bits to write.
    pub document_handling: Option<i32>,
    pub brightness: Option<i32>,
    pub contrast: Option<i32>,
}

/// A setting the device did not take.
///
/// Both halves of the driver-quality defence land here: a write the driver
/// REFUSED (`actual` absent) and a write it accepted and then reported back
/// differently (`actual` present and unequal). Neither fails the scan — a
/// device that silently clamps 1200 dpi to 600 still produced pages, and
/// hiding that would be worse than a refusal.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PropertyAdjustment {
    /// The property's own name as the driver spells it, never translated.
    pub property: String,
    pub requested: i32,
    pub actual: Option<i32>,
}

/// One acquisition's outcome. A cancelled run is a RESULT: the pages that
/// completed are here and the dialog offers them.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanResult {
    pub pages: Vec<String>,
    pub cancelled: bool,
    /// The scratch folder holding `pages`, handed back to `scan_discard`.
    pub scratch: String,
    /// The resolution actually in force, read back after the write. This is
    /// what `create_pdf`'s `image_dpi_default` is set from, so a driver that
    /// clamped the request still produces correctly sized pages.
    pub dpi: i32,
    pub adjusted: Vec<PropertyAdjustment>,
    pub bytes: u64,
}

/// Progress for one acquisition, over that invocation's own channel.
///
/// A per-invocation channel rather than a named global event: two dialogs, or
/// a dialog and a CLI-driven run, sharing one event name would cross their
/// progress.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScanEvent {
    Warming,
    PageStarted { index: u32 },
    Progress { index: u32, percent: u32 },
    PageFinished { index: u32, path: String },
    DeviceStatus { code: String },
    /// The scratch has passed [`SCAN_SIZE_WARN_BYTES`]. Emitted once per run:
    /// an uncompressed 600-dpi colour A3 page is roughly 400 MB, and a long
    /// ADF stack can fill a volume silently.
    SizeWarning { bytes: u64 },
}

/// Where a run's staged pages start being worth mentioning. Two 600-dpi
/// colour A4 pages, near enough — big enough that a normal letter-size run
/// never trips it, small enough to arrive before a volume is in trouble.
pub const SCAN_SIZE_WARN_BYTES: u64 = 512 * 1024 * 1024;

/// How long a run may go with no callback at all before the watchdog gives
/// up, when the device reports no `WIA_DPS_MAX_SCAN_TIME`.
const DEFAULT_WATCHDOG: Duration = Duration::from_secs(120);
/// The floor under a device-reported watchdog. A driver reporting a
/// two-second maximum scan time would otherwise cut off its own first page.
const MIN_WATCHDOG: Duration = Duration::from_secs(60);
/// How often the watchdog looks at the last callback's timestamp.
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(1);

/// A boxed event sink, so the transfer path has no idea whether it is feeding
/// a Tauri channel, a CLI's stderr, or nothing.
pub type EventSink = Box<dyn Fn(ScanEvent) + Send + Sync>;

/// Everything the callback object and the watchdog share.
struct TransferState {
    cancel: Arc<AtomicBool>,
    dir: PathBuf,
    extension: &'static str,
    sink: EventSink,
    /// Pages whose stream reached end-of-stream, in transfer order.
    pages: Mutex<Vec<PathBuf>>,
    /// The page currently being written; taken at end-of-stream. A page still
    /// open when the run ends was cut mid-transfer and is deleted with the
    /// scratch rather than offered.
    open: Mutex<Option<(u32, PathBuf)>>,
    next: AtomicU32,
    bytes: AtomicU64,
    warned: AtomicBool,
    /// When the driver last said anything. The watchdog measures from here,
    /// not from the start, so a legitimately slow 1200-dpi A3 page is not cut
    /// off while it is still reporting.
    activity: Mutex<Instant>,
    /// Set by the watchdog, so a cancel it caused reads as
    /// `scan.notResponding` rather than as the user's own cancel.
    timed_out: AtomicBool,
    /// The last error the driver reported through the callback.
    failure: Mutex<Option<HRESULT>>,
}

impl TransferState {
    fn touch(&self) {
        if let Ok(mut at) = self.activity.lock() {
            *at = Instant::now();
        }
    }

    fn emit(&self, event: ScanEvent) {
        (self.sink)(event);
    }
}

/// The transfer callback: one file per page, progress as it arrives, and a
/// cancel the driver sees on its next tick.
#[implement(IWiaTransferCallback)]
struct TransferSink {
    state: Arc<TransferState>,
}

/// `S_FALSE` — what a callback returns to abort a transfer. Never
/// `IWiaTransfer::Cancel()`: that would be a call into an interface the scan
/// thread is currently inside.
fn abort() -> windows::core::Error {
    windows::core::Error::from(HRESULT(1))
}

impl IWiaTransferCallback_Impl for TransferSink_Impl {
    fn TransferCallback(
        &self,
        _flags: i32,
        params: *const WiaTransferParams,
    ) -> windows::core::Result<()> {
        let state = &self.state;
        state.touch();
        if state.cancel.load(Ordering::SeqCst) {
            return Err(abort());
        }
        if params.is_null() {
            return Ok(());
        }
        let params = unsafe { &*params };
        let status = params.hrErrorStatus;
        if status.0 < 0 {
            if let Ok(mut failure) = state.failure.lock() {
                *failure = Some(status);
            }
        }
        let index = state
            .open
            .lock()
            .ok()
            .and_then(|open| open.as_ref().map(|(index, _)| *index))
            .unwrap_or_else(|| state.next.load(Ordering::SeqCst).saturating_sub(1));
        match params.lMessage as u32 {
            WIA_TRANSFER_MSG_STATUS => {
                let percent = params.lPercentComplete.clamp(0, 100) as u32;
                state.emit(ScanEvent::Progress { index, percent });
            }
            // The page's own start is reported from `GetNextStream`, which is
            // the hook that runs exactly once per page and is the one that
            // knows the page's file. This message only proves the device is
            // alive, which `touch` above already recorded.
            WIA_TRANSFER_MSG_NEW_PAGE => {}
            WIA_TRANSFER_MSG_END_OF_STREAM => {
                let finished = state.open.lock().ok().and_then(|mut open| open.take());
                if let Some((index, path)) = finished {
                    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    let total = state.bytes.fetch_add(size, Ordering::SeqCst) + size;
                    if let Ok(mut pages) = state.pages.lock() {
                        pages.push(path.clone());
                    }
                    state.emit(ScanEvent::PageFinished {
                        index,
                        path: path.to_string_lossy().to_string(),
                    });
                    if total >= SCAN_SIZE_WARN_BYTES && !state.warned.swap(true, Ordering::SeqCst) {
                        state.emit(ScanEvent::SizeWarning { bytes: total });
                    }
                }
            }
            WIA_TRANSFER_MSG_DEVICE_STATUS => {
                if status == WIA_STATUS_WARMING_UP {
                    state.emit(ScanEvent::Warming);
                } else {
                    state.emit(ScanEvent::DeviceStatus {
                        code: format!("0x{:08X}", status.0 as u32),
                    });
                }
            }
            WIA_TRANSFER_MSG_END_OF_TRANSFER => {}
            _ => {}
        }
        Ok(())
    }

    fn GetNextStream(
        &self,
        _flags: i32,
        _item_name: &BSTR,
        _full_item_name: &BSTR,
    ) -> windows::core::Result<IStream> {
        let state = &self.state;
        state.touch();
        if state.cancel.load(Ordering::SeqCst) {
            return Err(abort());
        }
        let index = state.next.fetch_add(1, Ordering::SeqCst);
        // Zero-padded so the staged pages sort in transfer order in any
        // listing, which is the order `create_pdf` is handed them in.
        let path = state
            .dir
            .join(format!("page-{index:04}.{}", state.extension));
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        let stream = unsafe {
            SHCreateStreamOnFileEx(
                PCWSTR(wide.as_ptr()),
                STGM_CREATE.0 | STGM_WRITE.0 | STGM_SHARE_EXCLUSIVE.0,
                FILE_ATTRIBUTE_NORMAL,
                true,
                None,
            )
        }?;
        if let Ok(mut open) = state.open.lock() {
            *open = Some((index, path));
        }
        state.emit(ScanEvent::PageStarted { index });
        Ok(stream)
    }
}

/// Write one property and read it back, recording a disagreement rather than
/// assuming the device agreed.
///
/// # Safety
/// `store` must be a live property storage on the calling apartment.
unsafe fn apply_setting(
    store: &IWiaPropertyStorage,
    id: u32,
    value: i32,
    adjusted: &mut Vec<PropertyAdjustment>,
) -> Option<i32> {
    unsafe {
        let wrote = write_i32(store, id, value);
        let actual = read_i32(store, id);
        let name = read_property_name(store, id);
        let property = if name.is_empty() {
            format!("{id}")
        } else {
            name
        };
        if !wrote {
            adjusted.push(PropertyAdjustment {
                property,
                requested: value,
                actual: None,
            });
            return actual;
        }
        match actual {
            Some(got) if got != value => adjusted.push(PropertyAdjustment {
                property,
                requested: value,
                actual: Some(got),
            }),
            // A property the device will not read back says nothing either
            // way; the write reported success and that is all there is.
            _ => {}
        }
        actual
    }
}

/// Everything one acquire request carries onto the session thread.
struct AcquireRequest {
    settings: ScanSettings,
    dir: PathBuf,
    sink: EventSink,
    cancel: Arc<AtomicBool>,
    reply: Sender<Result<ScanResult, ScanRefusal>>,
}

/// Run one acquisition on the session thread.
///
/// # Safety
/// `root` must belong to the calling thread's apartment.
unsafe fn acquire(
    root: &IWiaItem2,
    settings: ScanSettings,
    dir: PathBuf,
    sink: EventSink,
    cancel: Arc<AtomicBool>,
) -> Result<ScanResult, ScanRefusal> {
    unsafe {
        let root_store: IWiaPropertyStorage = root.cast().map_err(refusal_from)?;
        let max_scan_time = read_i32(&root_store, WIA_DPS_MAX_SCAN_TIME)
            .filter(|ms| *ms > 0)
            .map(|ms| Duration::from_millis(ms as u64))
            .unwrap_or(DEFAULT_WATCHDOG)
            .max(MIN_WATCHDOG);

        let item = select_source(root, settings.item_name.as_deref())?;
        let store: IWiaPropertyStorage = item.cast().map_err(refusal_from)?;
        let mut adjusted: Vec<PropertyAdjustment> = Vec::new();

        // Document handling first: it decides which source is being read, and
        // a device can report different extents for its feeder and its glass.
        if let Some(bits) = settings.document_handling {
            apply_setting(&store, WIA_IPS_DOCUMENT_HANDLING_SELECT, bits, &mut adjusted);
        }
        if let Some(mode) = settings.color_mode {
            apply_setting(&store, WIA_IPA_DATATYPE, mode.data_type(), &mut adjusted);
        }
        // Resolution before the area: the area is in pixels at the resolution
        // in force, so writing it first would size it against the old one.
        let mut dpi = read_i32(&store, WIA_IPS_XRES).unwrap_or(0);
        if let Some(requested) = settings.dpi.filter(|d| *d > 0) {
            let x = apply_setting(&store, WIA_IPS_XRES, requested, &mut adjusted);
            apply_setting(&store, WIA_IPS_YRES, requested, &mut adjusted);
            dpi = x.unwrap_or(requested);
        }
        if dpi <= 0 {
            dpi = settings.dpi.unwrap_or(300).max(1);
        }
        if let Some(paper) = settings.paper {
            // The bed is read AFTER the resolution write, because the extent
            // maxima are pixels at whatever resolution is now in force.
            let max_x = read_property(&store, WIA_IPS_XEXTENT).and_then(domain_max);
            let max_y = read_property(&store, WIA_IPS_YEXTENT).and_then(domain_max);
            if let Some(area) = scan_area(paper, dpi, max_x, max_y) {
                apply_setting(&store, WIA_IPS_XPOS, area.x, &mut adjusted);
                apply_setting(&store, WIA_IPS_YPOS, area.y, &mut adjusted);
                apply_setting(&store, WIA_IPS_XEXTENT, area.width, &mut adjusted);
                apply_setting(&store, WIA_IPS_YEXTENT, area.height, &mut adjusted);
            }
        }
        if let Some(pages) = settings.pages.filter(|p| *p >= 0) {
            apply_setting(&store, WIA_IPS_PAGES, pages, &mut adjusted);
        }
        if let Some(brightness) = settings.brightness {
            apply_setting(&store, WIA_IPS_BRIGHTNESS, brightness, &mut adjusted);
        }
        if let Some(contrast) = settings.contrast {
            apply_setting(&store, WIA_IPS_CONTRAST, contrast, &mut adjusted);
        }

        // The transfer format is OURS, not the user's: per-page files
        // so a cancel still yields the pages that completed.
        let (format, extension) = chosen_format(&listed_formats(&store));
        write_i32(&store, WIA_IPA_TYMED, TYMED_FILE.0);
        write_guid(&store, WIA_IPA_FORMAT, format);

        std::fs::create_dir_all(&dir).map_err(|e| ScanRefusal {
            key: "scan.failed",
            message: format!("Could not create the scan scratch folder: {e}"),
            code: None,
        })?;

        let state = Arc::new(TransferState {
            cancel: cancel.clone(),
            dir: dir.clone(),
            extension,
            sink,
            pages: Mutex::new(Vec::new()),
            open: Mutex::new(None),
            next: AtomicU32::new(0),
            bytes: AtomicU64::new(0),
            warned: AtomicBool::new(false),
            activity: Mutex::new(Instant::now()),
            timed_out: AtomicBool::new(false),
            failure: Mutex::new(None),
        });

        let transfer: IWiaTransfer = item.cast().map_err(refusal_from)?;
        let callback: IWiaTransferCallback = TransferSink {
            state: state.clone(),
        }
        .into();

        // The watchdog is a separate thread because `Download` blocks this
        // one for the whole run. It cancels the same way the user does, so
        // the driver is never called into from outside its apartment.
        let watched = state.clone();
        let running = Arc::new(AtomicBool::new(true));
        let watching = running.clone();
        let watchdog = std::thread::spawn(move || {
            while watching.load(Ordering::SeqCst) {
                std::thread::sleep(WATCHDOG_INTERVAL);
                let idle = watched
                    .activity
                    .lock()
                    .map(|at| at.elapsed())
                    .unwrap_or_default();
                if idle > max_scan_time {
                    watched.timed_out.store(true, Ordering::SeqCst);
                    watched.cancel.store(true, Ordering::SeqCst);
                    return;
                }
            }
        });

        let outcome = transfer.Download(0, &callback);
        running.store(false, Ordering::SeqCst);
        let _ = watchdog.join();
        // Drop the callback before anything else runs: it holds the state the
        // page list is read out of, and an open page's stream with it.
        drop(callback);
        drop(transfer);

        let timed_out = state.timed_out.load(Ordering::SeqCst);
        let cancelled = cancel.load(Ordering::SeqCst);
        // A page still open was cut mid-transfer; it is a partial file and is
        // swept with the scratch rather than offered as a page.
        if let Ok(mut open) = state.open.lock() {
            if let Some((_, path)) = open.take() {
                let _ = std::fs::remove_file(&path);
            }
        }
        let pages: Vec<String> = state
            .pages
            .lock()
            .map(|pages| {
                pages
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        let bytes = state.bytes.load(Ordering::SeqCst);

        if timed_out {
            return Err(ScanRefusal::named(
                "scan.notResponding",
                "The scanner stopped responding.",
            ));
        }
        if let Err(e) = outcome {
            // A cancel we asked for surfaces as S_FALSE or as a cancelled
            // HRESULT; that is a result with pages, not a failure.
            if !cancelled {
                let reported = state.failure.lock().ok().and_then(|f| *f);
                return Err(refusal_for(reported.unwrap_or_else(|| e.code())));
            }
        }
        // A transfer that ended cleanly with no pages at all is the device's
        // own Cancel button: indistinguishable from success at the HRESULT
        // level, wrong as an error and baffling as an empty success.
        if pages.is_empty() && !cancelled {
            return Err(ScanRefusal::named(
                "scan.cancelledAtDevice",
                "The scan was cancelled at the scanner.",
            ));
        }
        Ok(ScanResult {
            pages,
            cancelled,
            scratch: dir.to_string_lossy().to_string(),
            dpi,
            adjusted,
            bytes,
        })
    }
}

/// The largest value a property's own domain allows, which is what an extent
/// maximum means: the bed.
fn domain_max(report: PropertyReport) -> Option<i32> {
    match report.domain {
        PropertyDomain::Range { max, .. } => Some(max),
        PropertyDomain::List { values, .. } => values.into_iter().max(),
        _ => None,
    }
}

/// The child item a run transfers from: the one whose full item name matches,
/// else the first item that produces a scanned page.
///
/// # Safety
/// `root` must belong to the calling thread's apartment.
unsafe fn select_source(root: &IWiaItem2, item_name: Option<&str>) -> Result<IWiaItem2, ScanRefusal> {
    unsafe {
        let children: IEnumWiaItem2 = root.EnumChildItems(None).map_err(refusal_from)?;
        let mut first: Option<IWiaItem2> = None;
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
            let category = child
                .GetItemCategory()
                .ok()
                .or_else(|| read_guid(&store, WIA_IPA_ITEM_CATEGORY))
                .map(|guid| category_of(&guid))
                .unwrap_or(SourceCategory::Other);
            if matches!(category, SourceCategory::Other) {
                continue;
            }
            let name = read_string(&store, WIA_IPA_FULL_ITEM_NAME).unwrap_or_default();
            match item_name {
                Some(wanted) if name == wanted => return Ok(child),
                Some(_) => {
                    if first.is_none() {
                        first = Some(child);
                    }
                }
                None => return Ok(child),
            }
        }
        // A named item that is no longer there falls back to the first scan
        // source rather than refusing: the name came from a capability report
        // the device itself may have re-issued between the report and the run.
        first.ok_or_else(|| {
            ScanRefusal::named(
                "scan.failed",
                "The scanner reported no source that can produce a page.",
            )
        })
    }
}

// ── Scan scratch ────────────────────────────────────────────────────────────

/// The one folder every run's staged pages live under. Same discipline as the
/// batch scratch: a delete names exactly what it may take, so a caller cannot
/// turn `scan_discard` into a general remove by passing a source path.
fn scan_scratch_root() -> PathBuf {
    std::env::temp_dir().join("spectrapdf").join("scan-scratch")
}

/// A fresh, empty scratch folder for one run.
pub fn new_scan_scratch() -> Result<PathBuf, ScanRefusal> {
    let root = scan_scratch_root();
    for n in 0..10_000u32 {
        let candidate = root.join(format!("scan-{n}"));
        if !candidate.exists() {
            std::fs::create_dir_all(&candidate).map_err(|e| ScanRefusal {
                key: "scan.failed",
                message: format!("Could not create the scan scratch folder: {e}"),
                code: None,
            })?;
            return Ok(candidate);
        }
    }
    Err(ScanRefusal::named(
        "scan.failed",
        "Could not allocate a scan scratch folder.",
    ))
}

/// Is this path a scan scratch folder this process may delete?
///
/// String containment is not the test: `..` and a symlink both defeat it. The
/// comparison is between canonicalised paths, and a path that cannot be
/// canonicalised is not inside anything.
pub fn inside_scan_scratch(path: &Path) -> bool {
    match (path.canonicalize(), scan_scratch_root().canonicalize()) {
        (Ok(target), Ok(root)) => target.starts_with(&root) && target != root,
        _ => false,
    }
}

/// Delete one run's scratch folder and everything staged in it.
pub fn discard_scan_scratch(path: &Path) -> Result<(), ScanRefusal> {
    if !inside_scan_scratch(path) {
        return Err(ScanRefusal::named(
            "scan.failed",
            "That folder is not a scan scratch folder.",
        ));
    }
    std::fs::remove_dir_all(path).map_err(|e| ScanRefusal {
        key: "scan.failed",
        message: format!("Could not remove the scan scratch folder: {e}"),
        code: None,
    })
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

    /// Run one acquisition, opening a session for the device if none is live.
    ///
    /// The store's lock is released before the run starts. Holding it for the
    /// whole transfer would make `cancel` and `close` wait for the very run
    /// they are trying to stop.
    pub fn acquire(
        &self,
        device_id: &str,
        settings: ScanSettings,
        dir: PathBuf,
        sink: EventSink,
    ) -> Result<ScanResult, ScanRefusal> {
        let (requests, cancel, busy) = {
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
            (
                session.requests.clone(),
                session.cancel.clone(),
                session.busy.clone(),
            )
        };
        if busy.swap(true, Ordering::SeqCst) {
            return Err(ScanRefusal::named(
                "scan.busy",
                "A scan is already running on this scanner.",
            ));
        }
        cancel.store(false, Ordering::SeqCst);
        let (reply, answer) = mpsc::channel();
        let sent = requests.send(Request::Acquire(AcquireRequest {
            settings,
            dir,
            sink,
            cancel,
            reply,
        }));
        let outcome = if sent.is_err() {
            Err(ScanRefusal::named(
                "scan.failed",
                "The scanner session is no longer running.",
            ))
        } else {
            answer.recv().unwrap_or_else(|_| {
                Err(ScanRefusal::named(
                    "scan.failed",
                    "The scanner session stopped during the scan.",
                ))
            })
        };
        busy.store(false, Ordering::SeqCst);
        if let Ok(mut open) = self.sessions.lock() {
            if let Some(session) = open.get_mut(device_id) {
                session.last_used = Instant::now();
            }
        }
        outcome
    }

    /// Ask the run in flight to stop at the driver's next callback tick.
    ///
    /// A device with nothing running is not an error: a cancel that arrives
    /// after the last page is a cancel of nothing.
    pub fn cancel(&self, device_id: &str) {
        if let Ok(open) = self.sessions.lock() {
            if let Some(session) = open.get(device_id) {
                session.cancel.store(true, Ordering::SeqCst);
            }
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

/// Acquire pages from one device, streaming progress over `on_event`.
///
/// A cancelled run returns `Ok` with the pages that completed — the caller
/// offers them. Only a device or driver fault is an error.
#[tauri::command]
pub async fn scan_acquire(
    sessions: tauri::State<'_, ScannerSessions>,
    device_id: String,
    settings: ScanSettings,
    on_event: tauri::ipc::Channel<ScanEvent>,
) -> Result<ScanResult, ScanRefusal> {
    let dir = new_scan_scratch()?;
    let outcome = sessions.acquire(
        &device_id,
        settings,
        dir.clone(),
        Box::new(move |event| {
            let _ = on_event.send(event);
        }),
    );
    if outcome.is_err() {
        // A failed run leaves nothing worth keeping, and the folder it would
        // otherwise leave behind is one nothing will ever come back for.
        let _ = discard_scan_scratch(&dir);
    }
    outcome
}

/// Stop the run in flight on one device.
#[tauri::command]
pub async fn scan_cancel(
    sessions: tauri::State<'_, ScannerSessions>,
    device_id: String,
) -> Result<(), ScanRefusal> {
    sessions.cancel(&device_id);
    Ok(())
}

/// Delete one run's staged pages.
#[tauri::command]
pub async fn scan_discard(scratch: String) -> Result<(), ScanRefusal> {
    discard_scan_scratch(Path::new(&scratch))
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
    fn a_paper_size_becomes_pixels_at_the_requested_resolution() {
        // Letter at 300 dpi is exactly 2550 × 3300 pixels; the assertion is
        // the whole point of computing the area after the resolution write.
        assert_eq!(
            scan_area(PaperSize::Letter, 300, None, None),
            Some(ScanArea {
                x: 0,
                y: 0,
                width: 2550,
                height: 3300,
            })
        );
        assert_eq!(
            scan_area(PaperSize::Letter, 600, None, None),
            Some(ScanArea {
                x: 0,
                y: 0,
                width: 5100,
                height: 6600,
            })
        );
    }

    #[test]
    fn a_metric_paper_size_rounds_to_the_nearest_pixel() {
        // A4 is 210 × 297 mm = 8.2677… × 11.6929… in, which at 300 dpi is
        // 2480.31 × 3507.87 — the rounding rule, not truncation: a truncated
        // height would be 3507 and leave a white line where the sheet ended.
        assert_eq!(
            scan_area(PaperSize::A4, 300, None, None),
            Some(ScanArea {
                x: 0,
                y: 0,
                width: 2480,
                height: 3508,
            })
        );
    }

    #[test]
    fn an_area_beyond_the_bed_clamps_to_it() {
        // Legal on a letter-size bed: the height the glass has, not the
        // height the sheet has.
        let area = scan_area(PaperSize::Legal, 300, Some(2550), Some(3300))
            .expect("legal has dimensions");
        assert_eq!(area.width, 2550);
        assert_eq!(area.height, 3300);
        // A bed the device reports as zero or negative is no bed at all and
        // must not clamp everything to one pixel.
        let area = scan_area(PaperSize::Letter, 300, Some(0), Some(-1))
            .expect("letter has dimensions");
        assert_eq!((area.width, area.height), (2550, 3300));
    }

    #[test]
    fn auto_paper_writes_no_area_at_all() {
        assert_eq!(scan_area(PaperSize::Auto, 300, None, None), None);
        // A resolution that is not a resolution cannot produce an area.
        assert_eq!(scan_area(PaperSize::Letter, 0, None, None), None);
    }

    #[test]
    fn every_paper_size_round_trips_its_own_spelling() {
        for paper in PAPER_SIZES {
            let text = serde_json::to_string(paper).expect("a paper size serialises");
            let wire = text.trim_matches('"');
            assert_eq!(PaperSize::parse(wire), Some(*paper), "{wire}");
            assert_eq!(PaperSize::parse(&wire.to_uppercase()), Some(*paper));
        }
        assert_eq!(PaperSize::parse("foolscap"), None);
        // Auto is the only size with no dimensions; every other one has them.
        for paper in PAPER_SIZES {
            assert_eq!(
                paper.dimensions_in().is_none(),
                *paper == PaperSize::Auto,
                "{paper:?}"
            );
        }
    }

    #[test]
    fn the_transfer_format_prefers_bmp_and_falls_back_in_order() {
        assert_eq!(chosen_format(&[WiaImgFmt_BMP, WiaImgFmt_PNG]).1, "bmp");
        assert_eq!(chosen_format(&[WiaImgFmt_PNG, WiaImgFmt_TIFF]).1, "png");
        assert_eq!(chosen_format(&[WiaImgFmt_TIFF]).1, "tif");
        // A source that lists nothing still transfers: BMP is the format
        // every WIA driver is required to support.
        assert_eq!(chosen_format(&[]).0, WiaImgFmt_BMP);
        // A list's leading slots encode a count and a nominal rather than a
        // format, and membership testing is what makes them harmless.
        let count_slot = GUID::from_u128(3);
        assert_eq!(chosen_format(&[count_slot, WiaImgFmt_PNG]).1, "png");
    }

    #[test]
    fn each_colour_mode_writes_its_own_data_type() {
        let modes = [
            ColorMode::BlackAndWhite,
            ColorMode::Grayscale,
            ColorMode::Color,
            ColorMode::Auto,
        ];
        let mut values: Vec<i32> = modes.iter().map(|m| m.data_type()).collect();
        let distinct = values.len();
        values.sort_unstable();
        values.dedup();
        assert_eq!(values.len(), distinct, "two modes write the same data type");
        // The mapping is the inverse of the one the capability report reads.
        for mode in modes {
            let report = PropertyReport {
                id: WIA_IPA_DATATYPE,
                name: "Data Type".into(),
                readable: true,
                writable: true,
                current: Some(mode.data_type()),
                domain: PropertyDomain::List {
                    values: vec![mode.data_type()],
                    nominal: None,
                },
            };
            assert_eq!(color_modes(Some(&report)), vec![mode]);
        }
    }

    #[test]
    fn an_extent_maximum_comes_from_the_property_domain() {
        let range = PropertyReport {
            id: WIA_IPS_XEXTENT,
            name: "Horizontal Extent".into(),
            readable: true,
            writable: true,
            current: Some(2550),
            domain: PropertyDomain::Range {
                min: 1,
                max: 5100,
                step: 1,
                nominal: None,
            },
        };
        assert_eq!(domain_max(range), Some(5100));
        let listed = PropertyReport {
            id: WIA_IPS_XEXTENT,
            name: "Horizontal Extent".into(),
            readable: true,
            writable: true,
            current: Some(1275),
            domain: PropertyDomain::List {
                values: vec![1275, 2550, 1700],
                nominal: None,
            },
        };
        assert_eq!(domain_max(listed), Some(2550));
        let none = PropertyReport {
            id: WIA_IPS_XEXTENT,
            name: "Horizontal Extent".into(),
            readable: true,
            writable: true,
            current: Some(2550),
            domain: PropertyDomain::None,
        };
        assert_eq!(domain_max(none), None);
    }

    #[test]
    fn the_transfer_path_refusals_are_named_and_distinct() {
        // The three rows the transfer produces have no HRESULT behind them,
        // so nothing else pins their spelling.
        let rows = [
            ("scan.busy", "A scan is already running on this scanner."),
            ("scan.cancelledAtDevice", "The scan was cancelled at the scanner."),
            ("scan.notResponding", "The scanner stopped responding."),
        ];
        let mut keys: Vec<&str> = rows.iter().map(|(key, _)| *key).collect();
        let named = keys.len();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), named);
        for (key, message) in rows {
            let refusal = ScanRefusal::named(key, message);
            assert!(refusal.code.is_none());
            assert!(!refusal.message.is_empty());
            // No transfer row may collide with an HRESULT row.
            for (_, hresult_key, _) in HRESULT_REFUSALS {
                assert_ne!(*hresult_key, key);
            }
        }
    }

    #[test]
    fn only_a_folder_under_the_scan_scratch_root_can_be_discarded() {
        let scratch = new_scan_scratch().expect("a scratch folder is allocatable");
        assert!(inside_scan_scratch(&scratch));
        // The root itself is not a run's folder, and neither is anything
        // outside it — a caller must not be able to turn discard into a
        // general remove by passing a source path.
        assert!(!inside_scan_scratch(&scan_scratch_root()));
        assert!(!inside_scan_scratch(&std::env::temp_dir()));
        assert!(!inside_scan_scratch(Path::new("C:\\Windows")));
        // A path that leaves the root by traversal is outside it, which
        // string containment would not have caught.
        assert!(!inside_scan_scratch(&scratch.join("..").join("..")));

        std::fs::write(scratch.join("page-0000.bmp"), b"staged").expect("stage a page");
        discard_scan_scratch(&scratch).expect("its own scratch is discardable");
        assert!(!scratch.exists());
        // A folder that is already gone cannot be canonicalised, so it is
        // inside nothing and the second discard refuses rather than ranging
        // over the filesystem.
        assert_eq!(
            discard_scan_scratch(&scratch).expect_err("a gone folder refuses").key,
            "scan.failed"
        );
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
