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
use std::fs::{File, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, Once, OnceLock, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime};

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
    WIA_ERROR_COVER_OPEN, WIA_ERROR_DEVICE_COMMUNICATION, WIA_ERROR_DEVICE_LOCKED,
    WIA_ERROR_EXCEPTION_IN_DRIVER,
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
    CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CoTaskMemFree, CoUninitialize, IStream,
    CLSCTX_LOCAL_SERVER,
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
    /// A folder the user can act on, for the rows whose remedy is a path.
    ///
    /// Carried as a FIELD rather than left inside `message`: the renderer
    /// interpolates it into its own catalog sentence, which a surface that had
    /// to parse the English one could not do.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
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
            folder: None,
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
        WIA_ERROR_DEVICE_COMMUNICATION.0,
        "scan.deviceLost",
        "The scanner stopped responding during the scan.",
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
        folder: None,
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
    /// The exact `WIA_IPS_DOCUMENT_HANDLING_SELECT` value each offered source
    /// writes. Reported rather than reconstructed by the caller: a second
    /// declaration of these bit values somewhere else is a second thing to
    /// keep right, and the one that is wrong scans the wrong side of a sheet.
    pub flatbed_select: i32,
    pub feeder_select: i32,
    pub duplex_select: i32,
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
        flatbed_select: FLATBED as i32,
        feeder_select: FEEDER as i32,
        // A duplex run selects the feeder AND the duplex bit. On a device
        // whose front and back arrive as separate child items the driver
        // still honours this pair; the separate items exist so per-side
        // settings are possible, not because the bit stops working.
        duplex_select: (FEEDER | DUPLEX) as i32,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceOptionId {
    Flatbed,
    Feeder,
    Duplex,
}

/// One row of the source picker: which item a run transfers from and what it
/// writes to select it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ScanSourceOption {
    pub id: SourceOptionId,
    pub item_name: String,
    /// The `WIA_IPS_DOCUMENT_HANDLING_SELECT` value this row writes, absent
    /// where the device reports no such property to write.
    pub document_handling: Option<i32>,
    /// Can this row produce more than one page in one run? Only a feeder can,
    /// which is what makes a page count meaningful.
    pub feeds: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScannerCapabilities {
    pub device_id: String,
    pub device_name: String,
    pub document_handling: DocumentHandling,
    /// The sources this device offers, in picker order.
    ///
    /// Derived HERE and reported, never re-derived by a caller: the dialog
    /// and the CLI arm would otherwise be two answers to "which sources does
    /// this device have", and the one that is wrong scans the wrong side of a
    /// sheet or offers duplex on a flatbed.
    pub source_options: Vec<ScanSourceOption>,
    /// `WIA_DPS_MAX_SCAN_TIME` in milliseconds — the device's own answer to
    /// how long its slowest page takes, and the only honest basis for a
    /// watchdog.
    pub max_scan_time_ms: Option<i32>,
    pub sources: Vec<ScanSourceReport>,
}

/// The sources a device offers, in picker order.
///
/// A row appears only where the device reported BOTH the capability and an
/// item to transfer from: a duplex row on a flatbed and a feeder row on a
/// device with no feeder are exactly what deriving from the report prevents.
pub fn source_options(
    handling: &DocumentHandling,
    sources: &[ScanSourceReport],
) -> Vec<ScanSourceOption> {
    let item = |wanted: &[SourceCategory]| -> Option<&ScanSourceReport> {
        wanted
            .iter()
            .find_map(|c| sources.iter().find(|s| s.category == *c))
    };
    // A device with one scan source and no handling word still scans; the
    // item it reported is the source, and nothing is written to select it.
    let only = if sources.len() == 1 {
        sources.first()
    } else {
        None
    };
    let writes = |value: i32| -> Option<i32> {
        sources
            .iter()
            .any(|s| !matches!(s.document_handling_select, ControlModel::Absent))
            .then_some(value)
    };
    let flatbed = item(&[SourceCategory::Flatbed]).or(only);
    let feeder = item(&[SourceCategory::Feeder, SourceCategory::FeederFront]).or(only);

    let mut options: Vec<ScanSourceOption> = Vec::new();
    if let Some(source) = flatbed.filter(|_| handling.flatbed) {
        options.push(ScanSourceOption {
            id: SourceOptionId::Flatbed,
            item_name: source.item_name.clone(),
            document_handling: writes(handling.flatbed_select),
            feeds: false,
        });
    }
    if let Some(source) = feeder.filter(|_| handling.feeder) {
        options.push(ScanSourceOption {
            id: SourceOptionId::Feeder,
            item_name: source.item_name.clone(),
            document_handling: writes(handling.feeder_select),
            feeds: true,
        });
    }
    if let Some(source) = feeder.filter(|_| handling.duplex_mode != DuplexMode::None) {
        options.push(ScanSourceOption {
            id: SourceOptionId::Duplex,
            item_name: source.item_name.clone(),
            document_handling: writes(handling.duplex_select),
            feeds: true,
        });
    }
    // A device that reported neither capability still has items; offering the
    // first of them beats an empty picker on a working scanner.
    if options.is_empty() {
        if let Some(first) = sources.first() {
            let feeds = !matches!(first.category, SourceCategory::Flatbed);
            options.push(ScanSourceOption {
                id: if feeds {
                    SourceOptionId::Feeder
                } else {
                    SourceOptionId::Flatbed
                },
                item_name: first.item_name.clone(),
                document_handling: None,
                feeds,
            });
        }
    }
    options
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

/// A `VT_CLSID` PROPVARIANT whose payload is TASK-ALLOCATED, or `None` when the
/// allocation fails.
///
/// `IWiaPropertyStorage::WriteMultiple` clears the variant it is handed, so the
/// `puuid` payload reaches `CoTaskMemFree`. A payload that is not task-allocated
/// corrupts the heap at that free — `WIA_IPA_FORMAT` written from a borrowed
/// stack GUID aborts the process with `STATUS_HEAP_CORRUPTION` before the
/// transfer starts. Ownership passes to the callee; nothing here frees it.
fn propvariant_guid(value: GUID) -> Option<PROPVARIANT> {
    let payload = unsafe { CoTaskMemAlloc(core::mem::size_of::<GUID>()) } as *mut GUID;
    if payload.is_null() {
        return None;
    }
    unsafe { payload.write(value) };
    let mut var = PROPVARIANT::default();
    unsafe {
        let inner = &mut *var.Anonymous.Anonymous;
        inner.vt = VT_CLSID;
        inner.Anonymous.puuid = payload;
    }
    Some(var)
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
unsafe fn write_guid(store: &IWiaPropertyStorage, id: u32, value: GUID) -> bool {
    let spec = propspec(id);
    let Some(var) = propvariant_guid(value) else {
        return false;
    };
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

/// List the scanners every backend can see, with their ids namespaced.
///
/// An empty list is the answer, never an error: a machine with no scanner
/// enumerates zero devices and reports no failure, and that is the state the
/// dialog's empty screen renders.
///
/// `last_used` is the caller's stored preference in either spelling — a
/// namespaced id or one stored before the namespace existed. It survives only
/// when it is still one of the enumerated ids, and it comes back namespaced,
/// which is what rewrites a stored legacy value on the caller's next save.
pub fn enumerate(last_used: Option<String>) -> Result<ScannerList, ScanRefusal> {
    // The scanner subsystem's first use on either surface, so this is where
    // the scratch sweep is paid for — before a run has anything staged, and
    // never on a launch that does not scan.
    sweep_scan_scratch_once();
    let mut scanners: Vec<ScannerDevice> = Vec::new();
    for backend in backends() {
        let stack = backend.stack();
        for device in backend.enumerate()? {
            scanners.push(ScannerDevice {
                id: DeviceId {
                    stack,
                    native: device.id,
                }
                .qualified(),
                name: device.name,
            });
        }
    }
    scanners.sort_by_key(|d| d.name.to_lowercase());
    let default = resolve_default(&scanners, last_used);
    Ok(ScannerList { scanners, default })
}

/// The preselected device, given what enumerated and what the caller stored.
///
/// Split out so the migration is provable without a scanner: a stored id in
/// either spelling has to preselect the same device, and a stored id that no
/// longer enumerates has to preselect nothing.
fn resolve_default(scanners: &[ScannerDevice], last_used: Option<String>) -> Option<String> {
    let wanted = DeviceId::parse(&last_used?).qualified();
    scanners.iter().any(|d| d.id == wanted).then_some(wanted)
}

/// Every WIA scanner, by the id WIA itself knows it by.
fn wia_enumerate() -> Result<Vec<ScannerDevice>, ScanRefusal> {
    in_apartment(|| unsafe {
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
    })
}

// ── The backend seam ────────────────────────────────────────────────────────

/// Which acquisition stack a device came from.
///
/// One stack ships. The seam exists so that a second one is an added
/// implementation rather than a rewrite of the session store, the commands and
/// the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScanStack {
    Wia,
}

impl ScanStack {
    /// The prefix this stack's device ids carry.
    pub fn prefix(self) -> &'static str {
        match self {
            ScanStack::Wia => "wia",
        }
    }

    fn from_prefix(prefix: &str) -> Option<Self> {
        match prefix {
            "wia" => Some(ScanStack::Wia),
            _ => None,
        }
    }
}

/// A device id split into the stack that owns it and the id that stack knows.
///
/// Every id that crosses a command boundary is namespaced (`wia:<native>`);
/// the native half never leaves this module. Callers treat ids as opaque —
/// [`DeviceId::parse`] and [`DeviceId::qualified`] are the only place the
/// spelling is known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceId {
    pub stack: ScanStack,
    pub native: String,
}

impl DeviceId {
    /// Read a raw id from a caller.
    ///
    /// An id carrying a known stack prefix keeps that stack. Anything else is
    /// a value written before the namespace existed, which can only be WIA's:
    /// that is the migration, and because the qualified form is what goes back
    /// out, the caller stores the namespaced spelling on its next save.
    pub fn parse(raw: &str) -> Self {
        if let Some((prefix, native)) = raw.split_once(':') {
            if let Some(stack) = ScanStack::from_prefix(prefix) {
                return DeviceId {
                    stack,
                    native: native.to_string(),
                };
            }
        }
        DeviceId {
            stack: ScanStack::Wia,
            native: raw.to_string(),
        }
    }

    /// The namespaced spelling — the only id form that leaves this module.
    pub fn qualified(&self) -> String {
        format!("{}:{}", self.stack.prefix(), self.native)
    }
}

/// One acquisition stack.
///
/// Native ids are this trait's currency: the namespace is applied and stripped
/// at the seam, so an implementation never sees a prefix it would have to know
/// about.
pub trait ScanBackend: Send + Sync {
    fn stack(&self) -> ScanStack;

    /// The devices this stack can see, by native id. An empty list is an
    /// answer, never an error.
    fn enumerate(&self) -> Result<Vec<ScannerDevice>, ScanRefusal>;

    /// Open one device. The session owns whatever thread the stack requires
    /// and releases the device when it drops.
    fn open(&self, native_id: &str) -> Result<Arc<dyn ScanSession>, ScanRefusal>;

    /// The stack's own device picker. `Ok(None)` is both a cancelled picker
    /// and a stack with no picker to raise; the returned id is native.
    fn select_device_dialog(&self, parent: usize) -> Result<Option<String>, ScanRefusal>;
}

/// A device one backend holds open.
///
/// Cancel is a flag rather than a call for the reason the module header gives:
/// the acquiring thread is inside the driver for the whole run.
pub trait ScanSession: Send + Sync {
    fn capabilities(&self) -> Result<ScannerCapabilities, ScanRefusal>;
    fn acquire(
        &self,
        settings: ScanSettings,
        dir: PathBuf,
        sink: EventSink,
    ) -> Result<ScanResult, ScanRefusal>;
    fn cancel(&self);
}

/// The WIA 2.0 stack — the only backend this build carries.
pub struct WiaBackend;

static WIA_BACKEND: WiaBackend = WiaBackend;

impl ScanBackend for WiaBackend {
    fn stack(&self) -> ScanStack {
        ScanStack::Wia
    }

    fn enumerate(&self) -> Result<Vec<ScannerDevice>, ScanRefusal> {
        wia_enumerate()
    }

    fn open(&self, native_id: &str) -> Result<Arc<dyn ScanSession>, ScanRefusal> {
        Ok(Arc::new(Session::open(native_id.to_string())?))
    }

    fn select_device_dialog(&self, parent: usize) -> Result<Option<String>, ScanRefusal> {
        wia_select_device_dialog(parent)
    }
}

/// Every stack this build carries, in the order their devices are offered.
pub fn backends() -> &'static [&'static dyn ScanBackend] {
    static ALL: [&dyn ScanBackend; 1] = [&WIA_BACKEND];
    &ALL
}

/// The backend for one stack.
fn backend_for(stack: ScanStack) -> &'static dyn ScanBackend {
    backends()
        .iter()
        .copied()
        .find(|backend| backend.stack() == stack)
        .expect("every stack in ScanStack has a backend")
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

impl ScanSession for Session {
    fn capabilities(&self) -> Result<ScannerCapabilities, ScanRefusal> {
        Session::capabilities(self)
    }

    /// One run, start to finish. Blocks: the caller releases the session
    /// store's lock first, so `cancel` and `close` do not wait on the very run
    /// they are trying to stop.
    fn acquire(
        &self,
        settings: ScanSettings,
        dir: PathBuf,
        sink: EventSink,
    ) -> Result<ScanResult, ScanRefusal> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err(ScanRefusal::named(
                "scan.busy",
                "A scan is already running on this scanner.",
            ));
        }
        self.cancel.store(false, Ordering::SeqCst);
        let (reply, answer) = mpsc::channel();
        let sent = self.requests.send(Request::Acquire(AcquireRequest {
            settings,
            dir,
            sink,
            cancel: self.cancel.clone(),
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
        self.busy.store(false, Ordering::SeqCst);
        outcome
    }

    fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
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
        let handling = document_handling(capabilities, &categories);
        Ok(ScannerCapabilities {
            device_id: device_id.to_string(),
            device_name,
            source_options: source_options(&handling, &sources),
            document_handling: handling,
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

// ── Staged-page integrity ───────────────────────────────────────────────────

/// What a staged page's own header says about whether the transfer finished.
///
/// A driver that loses its device mid-transfer can still deliver
/// `WIA_TRANSFER_MSG_END_OF_STREAM` and return `S_OK` from
/// `IWiaTransfer::Download`, leaving a file whose header promises more bytes
/// than the file holds. Nothing downstream of the scanner layer can name that
/// as a device loss — the assembler only sees an unreadable image — so the
/// check lives here, where the refusal can be named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageIntegrity {
    /// The header's promise is met by the bytes on disk.
    Complete,
    /// The file is short of what its own header declares.
    Truncated { declared: u64, actual: u64 },
    /// The format carries no self-describing length this check can read; the
    /// page is passed on rather than refused on a guess.
    Unverifiable,
}

/// The bytes a BMP's own headers promise, from `bfSize` when the encoder wrote
/// one and from the DIB geometry when it did not.
///
/// Rows are padded to a four-byte boundary — the format's own rule, and the
/// reason the row stride is not `width * bits / 8`.
fn bmp_declared_len(head: &[u8]) -> Option<u64> {
    if head.len() < 14 || &head[0..2] != b"BM" {
        return None;
    }
    let u32_at = |at: usize| -> u64 {
        u32::from_le_bytes([head[at], head[at + 1], head[at + 2], head[at + 3]]) as u64
    };
    let declared = u32_at(2);
    if declared >= 14 {
        return Some(declared);
    }
    // `bfSize` of zero is written by some encoders. The DIB header is then the
    // only witness, and only for an uncompressed image, whose size is exactly
    // the padded rows.
    if head.len() < 54 {
        return None;
    }
    let offset = u32_at(10);
    let width = i32::from_le_bytes([head[18], head[19], head[20], head[21]]) as i64;
    let height = i32::from_le_bytes([head[22], head[23], head[24], head[25]]) as i64;
    let bits = u16::from_le_bytes([head[28], head[29]]) as i64;
    let compression = u32_at(30);
    if compression != 0 || width <= 0 || height == 0 || bits <= 0 {
        return None;
    }
    let stride = ((width * bits + 31) / 32) * 4;
    let rows = height.unsigned_abs();
    Some(offset + (stride as u64) * rows)
}

/// Whether one staged page holds everything its header promises.
///
/// Read from the file rather than from the transfer's byte counter: the counter
/// records what the callback was told, and a lost device is exactly the case
/// where that and the file disagree.
pub fn page_integrity(path: &Path) -> PageIntegrity {
    let Ok(actual) = std::fs::metadata(path).map(|m| m.len()) else {
        return PageIntegrity::Truncated {
            declared: 0,
            actual: 0,
        };
    };
    let mut head = [0u8; 54];
    let read = {
        use std::io::Read;
        std::fs::File::open(path)
            .and_then(|mut f| f.read(&mut head))
            .unwrap_or_default()
    };
    let head = &head[..read];
    if head.starts_with(b"BM") {
        return match bmp_declared_len(head) {
            Some(declared) if actual < declared => PageIntegrity::Truncated { declared, actual },
            Some(_) => PageIntegrity::Complete,
            None => PageIntegrity::Unverifiable,
        };
    }
    if head.starts_with(PNG_SIGNATURE) {
        // PNG declares no total length; its terminator is the promise.
        let mut tail = [0u8; 8];
        let ended = {
            use std::io::{Read, Seek, SeekFrom};
            actual >= 8
                && std::fs::File::open(path)
                    .and_then(|mut f| {
                        f.seek(SeekFrom::End(-8))?;
                        f.read_exact(&mut tail)?;
                        Ok(())
                    })
                    .is_ok()
                && &tail[4..8] == b"IEND"
        };
        return if ended {
            PageIntegrity::Complete
        } else {
            PageIntegrity::Truncated {
                declared: 0,
                actual,
            }
        };
    }
    // TIFF and anything else: no cheap self-describing total length.
    if actual == 0 {
        PageIntegrity::Truncated {
            declared: 0,
            actual: 0,
        }
    } else {
        PageIntegrity::Unverifiable
    }
}

const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// The first staged page that is short of its own header, if any.
pub fn first_truncated_page(pages: &[PathBuf]) -> Option<(PathBuf, PageIntegrity)> {
    pages.iter().find_map(|path| match page_integrity(path) {
        short @ PageIntegrity::Truncated { .. } => Some((path.clone(), short)),
        _ => None,
    })
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
    /// The feeder fault that ended the batch early, when one did.
    ///
    /// `pages` then holds the sheets that finished before it, and the caller
    /// assembles exactly those: a jam is a clean partial, not a failure that
    /// throws away work the user already fed through the machine. A page torn
    /// by the jam never reaches here — [`judge_transfer`] discards it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<ScanRefusal>,
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
            folder: None,
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
        let staged: Vec<PathBuf> = state.pages.lock().map(|pages| pages.clone()).unwrap_or_default();
        let bytes = state.bytes.load(Ordering::SeqCst);
        let verdict = judge_transfer(TransferOutcome {
            timed_out,
            cancelled,
            download: outcome.err().map(|e| e.code()),
            reported: state.failure.lock().ok().and_then(|f| *f),
            staged: &staged,
        })?;
        Ok(ScanResult {
            pages: verdict.pages,
            interrupted: verdict.interrupted,
            cancelled,
            scratch: dir.to_string_lossy().to_string(),
            dpi,
            adjusted,
            bytes,
        })
    }
}

/// Everything a finished transfer is judged on, and nothing that needs a
/// device: the seam the run's verdict is decided at.
pub struct TransferOutcome<'a> {
    /// The watchdog cancelled the run because the driver went silent.
    pub timed_out: bool,
    /// The run was cancelled from this side (the user, or the watchdog).
    pub cancelled: bool,
    /// What `IWiaTransfer::Download` returned, when it failed.
    pub download: Option<HRESULT>,
    /// The last failing status the driver reported through the callback.
    pub reported: Option<HRESULT>,
    /// The pages the driver signalled complete, in transfer order.
    pub staged: &'a [PathBuf],
}

/// One finished transfer's verdict: what to offer, and what ended the run
/// early if anything did.
#[derive(Debug)]
pub struct TransferVerdict {
    /// The pages to offer, every one of them integrity-passing.
    pub pages: Vec<String>,
    /// The feeder fault the batch stopped on, when the run was a clean
    /// partial rather than a whole batch.
    pub interrupted: Option<ScanRefusal>,
}

/// Whether an HRESULT is a fault in the PAPER PATH rather than in the device.
///
/// A jam or a misfeed stops the batch where it is; the sheets already
/// transferred are whole and are the user's. A device that stopped responding
/// is the opposite case — nothing it delivered can be trusted — and it is not
/// in this class. `WIA_ERROR_PAPER_EMPTY` is not here either: an empty tray is
/// how a feeder reports that the batch ENDED, and treating it as a fault would
/// name every completed feeder run a partial.
fn is_feeder_interruption(hr: HRESULT) -> bool {
    hr == WIA_ERROR_PAPER_JAM || hr == WIA_ERROR_PAPER_PROBLEM
}

/// The verdict on one finished transfer: the pages to offer, or the refusal
/// that names what went wrong.
///
/// Truncated pages are deleted here rather than left for the scratch sweep,
/// so nothing downstream can be handed a page this decided not to offer.
pub fn judge_transfer(outcome: TransferOutcome<'_>) -> Result<TransferVerdict, ScanRefusal> {
    if outcome.timed_out {
        return Err(ScanRefusal::named(
            "scan.notResponding",
            "The scanner stopped responding.",
        ));
    }
    let mut staged: Vec<PathBuf> = outcome.staged.to_vec();
    let mut interrupted = None;
    // A cancel we asked for surfaces as S_FALSE or as a cancelled HRESULT;
    // that is a result with pages, not a failure.
    if !outcome.cancelled {
        // A driver can report a failure through the callback and STILL return
        // `S_OK` from `Download`. The reported status is the device's own
        // verdict on the run and outranks the return value.
        if let Some(status) = outcome.reported.or(outcome.download) {
            let refusal = refusal_for(status);
            if !is_feeder_interruption(status) {
                return Err(refusal);
            }
            // A jam mid-batch: the sheet in the paper path is discarded and
            // every sheet that finished before it is kept. The alternative —
            // refusing the run — throws away pages the device already read
            // and makes the user feed them again.
            let mut kept = Vec::with_capacity(staged.len());
            for page in staged {
                if matches!(page_integrity(&page), PageIntegrity::Truncated { .. }) {
                    let _ = std::fs::remove_file(&page);
                } else {
                    kept.push(page);
                }
            }
            if kept.is_empty() {
                return Err(refusal);
            }
            staged = kept;
            interrupted = Some(refusal);
        }
    }
    // A page whose header promises more bytes than the file holds means the
    // device stopped mid-stream even though the driver signalled the page
    // complete — the shape a device losing power takes, since a driver can
    // deliver end-of-stream and S_OK over a stream that stopped arriving.
    // The whole run refuses: a truncated raster that reached assembly surfaces
    // as the assembler's unreadable-image error, which names nothing the user
    // can act on, and a run that lost its device has no honest partial to
    // offer.
    if first_truncated_page(&staged).is_some() {
        for page in &staged {
            let _ = std::fs::remove_file(page);
        }
        return Err(ScanRefusal::named(
            "scan.deviceLost",
            "The scanner stopped responding during the scan.",
        ));
    }
    let pages: Vec<String> = staged
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    // A transfer that ended cleanly with no pages at all is the device's own
    // Cancel button: indistinguishable from success at the HRESULT level,
    // wrong as an error and baffling as an empty success.
    if pages.is_empty() && !outcome.cancelled {
        return Err(ScanRefusal::named(
            "scan.cancelledAtDevice",
            "The scan was cancelled at the scanner.",
        ));
    }
    Ok(TransferVerdict { pages, interrupted })
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

/// The marker file a live run holds OPEN inside its own scratch folder.
///
/// A held handle, never a pid file: a pid can be reused and a crash leaves the
/// file behind claiming the run is alive, whereas a handle is closed by the
/// kernel when the owning process dies however it dies. The handle is taken
/// with no sharing, so a second process — or a second window of this one —
/// cannot open it while the owner holds it, and neither can delete it. That is
/// the whole liveness test, and it needs no cross-process bookkeeping.
const SCRATCH_LOCK: &str = ".live";

/// How long an UNLOCKED run folder survives before the sweeper takes it.
///
/// Long enough that no ordinary review session is at risk (a folder is locked
/// for as long as its run is live, so the age rule only ever governs folders
/// nothing holds — including those left by a version that had no marker).
const SCRATCH_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// The lock handles this process holds, keyed by the run folder.
///
/// Held here rather than in the caller so a discard can release the handle
/// before removing the folder — the no-sharing handle blocks its own delete.
fn scratch_locks() -> &'static Mutex<HashMap<PathBuf, File>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, File>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Release this process's hold on a run folder's marker.
///
/// Compared canonically, for the same reason `inside_scan_scratch` is: the
/// path arriving from a caller need not be spelled the way it was handed out,
/// and a handle left held would refuse the folder's own delete.
fn release_scratch_lock(path: &Path) {
    if let Ok(mut held) = scratch_locks().lock() {
        let target = path.canonicalize().ok();
        held.retain(|dir, _| dir != path && dir.canonicalize().ok() != target);
    }
}

/// Take the run folder's liveness marker, failing if it cannot be held.
fn hold_scratch_lock(dir: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .share_mode(0)
        .open(dir.join(SCRATCH_LOCK))
}

/// Does a live run still own this folder?
///
/// Answered by trying to take the marker exclusively: an open that succeeds
/// proves nobody holds it, a sharing violation proves somebody does, and a
/// folder with no marker at all (an older version's, or one whose creation
/// raced) is not live. Any other error answers LIVE — the sweeper deletes only
/// what it can prove is abandoned.
fn scratch_is_live(dir: &Path) -> bool {
    match OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(dir.join(SCRATCH_LOCK))
    {
        Ok(_) => false,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

/// Delete every abandoned run folder under `root`, and report how many went.
///
/// Abandoned means both: no live owner holds its marker, AND it has not been
/// written to within `max_age`. Either test alone is wrong — the marker alone
/// would take a folder a crashed run left seconds ago while the user is still
/// deciding what to do about the crash, and the age alone would take a folder
/// out from under a long review or a second window's live run.
///
/// A symlink is not a directory here (`read_dir`'s file type does not follow
/// one), so a link planted in the root is skipped rather than followed.
fn sweep_scratch_root(root: &Path, max_age: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut swept = 0;
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        if scratch_is_live(&dir) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= max_age);
        if !stale {
            continue;
        }
        if std::fs::remove_dir_all(&dir).is_ok() {
            swept += 1;
        }
    }
    swept
}

/// Sweep the scan scratch root once per process, on first use of the scanner.
///
/// On first use rather than at boot: a user who never scans should not pay for
/// a directory walk, and by the time anything here runs the walk is dwarfed by
/// opening a device. Failure is silent by design — a scratch that cannot be
/// swept must not stop a scan.
fn sweep_scan_scratch_once() {
    static SWEPT: Once = Once::new();
    SWEPT.call_once(|| {
        sweep_scratch_root(&scan_scratch_root(), SCRATCH_MAX_AGE);
    });
}

/// The highest run index the allocator will try before refusing.
const SCRATCH_INDEX_LIMIT: u32 = 10_000;

/// A fresh, empty scratch folder for one run, with its liveness marker held.
pub fn new_scan_scratch() -> Result<PathBuf, ScanRefusal> {
    sweep_scan_scratch_once();
    allocate_scan_scratch(&scan_scratch_root(), SCRATCH_INDEX_LIMIT)
}

/// The allocator, over an explicit root and ceiling so exhaustion is reachable
/// in a test without ten thousand folders.
fn allocate_scan_scratch(root: &Path, limit: u32) -> Result<PathBuf, ScanRefusal> {
    let create_failed = |e: std::io::Error| ScanRefusal {
        key: "scan.failed",
        message: format!("Could not create the scan scratch folder: {e}"),
        code: None,
        folder: None,
    };
    std::fs::create_dir_all(root).map_err(create_failed)?;
    for n in 0..limit {
        let candidate = root.join(format!("scan-{n}"));
        // `create_dir` is the claim, not a preceding `exists` test: two runs
        // starting together would both see the same index free.
        match std::fs::create_dir(&candidate) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(create_failed(e)),
        }
        let lock = hold_scratch_lock(&candidate).map_err(|e| {
            let _ = std::fs::remove_dir_all(&candidate);
            create_failed(e)
        })?;
        scratch_locks()
            .lock()
            .expect("the scratch lock table is not poisoned")
            .insert(candidate.clone(), lock);
        return Ok(candidate);
    }
    // Every index taken AFTER a sweep means ten thousand runs are genuinely
    // live, which no reclaiming can help. The refusal names the root so the
    // remedy is something the user can act on rather than a dead end.
    Err(ScanRefusal {
        key: "scan.scratchFull",
        message: format!(
            "Could not allocate a scan scratch folder: every run folder under {} is in use.",
            root.display()
        ),
        code: None,
        folder: Some(root.to_string_lossy().to_string()),
    })
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
    // The liveness marker is held with no sharing, so it blocks its own
    // delete: release this process's handle before the folder goes.
    release_scratch_lock(path);
    std::fs::remove_dir_all(path).map_err(|e| ScanRefusal {
        key: "scan.failed",
        message: format!("Could not remove the scan scratch folder: {e}"),
        code: None,
        folder: None,
    })
}

// ── Session store ───────────────────────────────────────────────────────────

/// One open device, plus the store's own idle bookkeeping.
///
/// `last_used` belongs to the store rather than the backend: how long a
/// session has sat unused is not a fact about the stack that opened it.
struct Entry {
    session: Arc<dyn ScanSession>,
    last_used: Instant,
}

/// The live sessions, one per namespaced device id.
///
/// Managed Tauri state in the app and a local value in the CLI, so both reach
/// a device the same way. Dropping the store closes every session it holds,
/// which is what releases the device locks.
pub struct ScannerSessions {
    sessions: Arc<Mutex<HashMap<String, Entry>>>,
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
        let watched: Weak<Mutex<HashMap<String, Entry>>> = Arc::downgrade(&self.sessions);
        self.reaper.call_once(move || {
            std::thread::spawn(move || loop {
                std::thread::sleep(REAP_INTERVAL);
                let Some(sessions) = watched.upgrade() else {
                    return;
                };
                let Ok(mut open) = sessions.lock() else {
                    return;
                };
                open.retain(|_, entry| entry.last_used.elapsed() < IDLE_TIMEOUT);
            });
        });
    }

    /// One device's capability report, opening a session for it if none is
    /// live.
    ///
    /// The report's own `device_id` comes back namespaced, so a caller that
    /// round-trips it — the checklist runner does — reaches the same device.
    pub fn capabilities(&self, device_id: &str) -> Result<ScannerCapabilities, ScanRefusal> {
        let id = DeviceId::parse(device_id);
        let key = id.qualified();
        let mut open = self.sessions.lock().map_err(|_| {
            ScanRefusal::named("scan.failed", "The scanner session store is unusable.")
        })?;
        if !open.contains_key(&key) {
            let session = backend_for(id.stack).open(&id.native)?;
            self.start_reaper();
            open.insert(
                key.clone(),
                Entry {
                    session,
                    last_used: Instant::now(),
                },
            );
        }
        let entry = open.get_mut(&key).expect("session was just inserted");
        entry.last_used = Instant::now();
        let report = entry.session.capabilities();
        if report.is_err() {
            // A session that failed its own report is not one to keep a
            // device locked with.
            open.remove(&key);
        }
        report.map(|mut caps| {
            caps.device_id = key;
            caps
        })
    }

    /// Close the session on one device, releasing its lock now rather than at
    /// the idle timeout.
    pub fn close(&self, device_id: &str) {
        let key = DeviceId::parse(device_id).qualified();
        if let Ok(mut open) = self.sessions.lock() {
            open.remove(&key);
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
        let id = DeviceId::parse(device_id);
        let key = id.qualified();
        let session = {
            let mut open = self.sessions.lock().map_err(|_| {
                ScanRefusal::named("scan.failed", "The scanner session store is unusable.")
            })?;
            if !open.contains_key(&key) {
                let session = backend_for(id.stack).open(&id.native)?;
                self.start_reaper();
                open.insert(
                    key.clone(),
                    Entry {
                        session,
                        last_used: Instant::now(),
                    },
                );
            }
            let entry = open.get_mut(&key).expect("session was just inserted");
            entry.last_used = Instant::now();
            entry.session.clone()
        };
        let outcome = session.acquire(settings, dir, sink);
        if let Ok(mut open) = self.sessions.lock() {
            if let Some(entry) = open.get_mut(&key) {
                entry.last_used = Instant::now();
            }
        }
        outcome
    }

    /// Ask the run in flight to stop at the driver's next callback tick.
    ///
    /// A device with nothing running is not an error: a cancel that arrives
    /// after the last page is a cancel of nothing.
    pub fn cancel(&self, device_id: &str) {
        let key = DeviceId::parse(device_id).qualified();
        if let Ok(open) = self.sessions.lock() {
            if let Some(entry) = open.get(&key) {
                entry.session.cancel();
            }
        }
    }
}

// ── The system device picker ────────────────────────────────────────────────

/// `IWiaDevMgr2::SelectDeviceDlgID` — the door for a device our enumeration
/// filter drops, such as a multifunction whose scan function reports an
/// unexpected type.
///
/// Returns the chosen device id, namespaced; `None` when the user cancels.
/// The id then flows through the ordinary capability path, so this is a door
/// and not a second route.
///
/// A stack whose devices this picker cannot show is reached through
/// enumeration, which is why the door belongs to one backend rather than to
/// the seam.
pub fn select_device_dialog(parent: usize) -> Result<Option<String>, ScanRefusal> {
    let backend = backend_for(ScanStack::Wia);
    let stack = backend.stack();
    Ok(backend
        .select_device_dialog(parent)?
        .map(|native| DeviceId { stack, native }.qualified()))
}

/// `IWiaDevMgr2::SelectDeviceDlgID`, returning WIA's own device id.
fn wia_select_device_dialog(parent: usize) -> Result<Option<String>, ScanRefusal> {
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
    // A run nothing can come back for is swept here rather than left for the
    // age-based sweeper. A failure leaves nothing worth keeping; a run that
    // completed ZERO pages leaves a folder whose name reaches the caller only
    // on a staged page, so with no page nothing would ever name it again.
    let barren = match &outcome {
        Ok(result) => result.pages.is_empty(),
        Err(_) => true,
    };
    if barren {
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
            (WIA_ERROR_DEVICE_COMMUNICATION, "scan.deviceLost"),
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

    /// A BMP header for a 24-bit uncompressed image, with `bfSize` written or
    /// left at zero, and the padded row stride the format's own rule gives.
    fn bmp_header(width: i32, height: i32, declare_size: bool) -> (Vec<u8>, u64) {
        let stride = (((width as i64) * 24 + 31) / 32) * 4;
        let total = 54u64 + (stride as u64) * (height.unsigned_abs() as u64);
        let mut head = vec![0u8; 54];
        head[0..2].copy_from_slice(b"BM");
        let declared = if declare_size { total as u32 } else { 0 };
        head[2..6].copy_from_slice(&declared.to_le_bytes());
        head[10..14].copy_from_slice(&54u32.to_le_bytes());
        head[14..18].copy_from_slice(&40u32.to_le_bytes());
        head[18..22].copy_from_slice(&width.to_le_bytes());
        head[22..26].copy_from_slice(&height.to_le_bytes());
        head[26..28].copy_from_slice(&1u16.to_le_bytes());
        head[28..30].copy_from_slice(&24u16.to_le_bytes());
        (head, total)
    }

    /// Stage one page file: a header plus `written` bytes of body, so a page
    /// cut mid-transfer can be posed without a device.
    fn stage_page(dir: &Path, name: &str, head: &[u8], written: u64) -> PathBuf {
        std::fs::create_dir_all(dir).expect("a staging folder");
        let path = dir.join(name);
        let mut bytes = head.to_vec();
        bytes.resize(written.max(head.len() as u64) as usize, 0);
        std::fs::write(&path, &bytes).expect("a staged page");
        path
    }

    #[test]
    fn a_bmp_short_of_its_declared_size_is_truncated() {
        // Row 10: the device dies mid-transfer, the driver still signals the
        // page complete, and the file is short of its own header.
        let root = temp_scratch_root("integrity-short");
        let (head, total) = bmp_header(2550, 3300, true);
        let path = stage_page(&root, "page-0000.bmp", &head, 4096);
        assert_eq!(
            page_integrity(&path),
            PageIntegrity::Truncated {
                declared: total,
                actual: 4096
            }
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bmp_that_holds_its_declared_size_is_complete() {
        let root = temp_scratch_root("integrity-whole");
        let (head, total) = bmp_header(8, 8, true);
        let path = stage_page(&root, "page-0000.bmp", &head, total);
        assert_eq!(page_integrity(&path), PageIntegrity::Complete);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bmp_with_no_declared_size_is_measured_from_its_dib_header() {
        // `bfSize` of zero is legal enough that some encoders write it; the
        // geometry is then the only witness, and it still catches a short file.
        let root = temp_scratch_root("integrity-dib");
        let (head, total) = bmp_header(64, 64, false);
        let short = stage_page(&root, "page-0000.bmp", &head, 100);
        assert_eq!(
            page_integrity(&short),
            PageIntegrity::Truncated {
                declared: total,
                actual: 100
            }
        );
        let whole = stage_page(&root, "page-0001.bmp", &head, total);
        assert_eq!(page_integrity(&whole), PageIntegrity::Complete);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_png_is_judged_by_its_terminator() {
        let root = temp_scratch_root("integrity-png");
        let mut whole = PNG_SIGNATURE.to_vec();
        whole.extend_from_slice(&[0, 0, 0, 0]);
        whole.extend_from_slice(b"IEND");
        whole.extend_from_slice(&[0xAE, 0x42, 0x60, 0x82]);
        // The check reads the last eight bytes: length then chunk type.
        let mut ended = PNG_SIGNATURE.to_vec();
        ended.extend_from_slice(&[1, 2, 3, 4]);
        ended.extend_from_slice(&[0, 0, 0, 0]);
        ended.extend_from_slice(b"IEND");
        let path = root.join("ended.png");
        std::fs::create_dir_all(&root).expect("a staging folder");
        std::fs::write(&path, &ended).expect("a staged page");
        assert_eq!(page_integrity(&path), PageIntegrity::Complete);

        let cut = root.join("cut.png");
        std::fs::write(&cut, &whole[..12]).expect("a staged page");
        assert!(matches!(
            page_integrity(&cut),
            PageIntegrity::Truncated { .. }
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_staged_page_is_truncated_whatever_its_format() {
        let root = temp_scratch_root("integrity-empty");
        std::fs::create_dir_all(&root).expect("a staging folder");
        let path = root.join("page-0000.tif");
        std::fs::write(&path, b"").expect("a staged page");
        assert!(matches!(
            page_integrity(&path),
            PageIntegrity::Truncated { .. }
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_run_with_one_short_page_names_that_page() {
        // The run-level check the acquire path refuses on: good pages before
        // the loss do not hide the page the device died inside.
        let root = temp_scratch_root("integrity-run");
        let (head, total) = bmp_header(16, 16, true);
        let good = stage_page(&root, "page-0000.bmp", &head, total);
        let short = stage_page(&root, "page-0001.bmp", &head, total - 10);
        assert!(first_truncated_page(std::slice::from_ref(&good)).is_none());
        let (named, _) = first_truncated_page(&[good, short.clone()])
            .expect("a run holding a short page is caught");
        assert_eq!(named, short);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn judged(
        timed_out: bool,
        cancelled: bool,
        download: Option<HRESULT>,
        reported: Option<HRESULT>,
        staged: &[PathBuf],
    ) -> Result<TransferVerdict, ScanRefusal> {
        judge_transfer(TransferOutcome {
            timed_out,
            cancelled,
            download,
            reported,
            staged,
        })
    }

    #[test]
    fn a_page_short_of_its_header_refuses_by_the_device_lost_key() {
        // Checklist row 10, without the hardware: the device loses power, the
        // driver still signals the page complete and `Download` still returns
        // S_OK, and the file is short. Before this, the run reported success
        // and the truncated page reached the assembler, which could only say
        // the image was unreadable.
        let root = temp_scratch_root("judge-short");
        let (head, _) = bmp_header(2550, 3300, true);
        let short = stage_page(&root, "page-0000.bmp", &head, 8192);
        let refusal = judged(false, false, None, None, std::slice::from_ref(&short))
            .expect_err("a short page is a refusal, not a result");
        assert_eq!(refusal.key, "scan.deviceLost");
        assert!(refusal.code.is_none());
        assert!(
            !short.exists(),
            "a page the run refused on is never left where assembly could read it"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_whole_page_over_a_silent_transfer_is_a_result() {
        let root = temp_scratch_root("judge-whole");
        let (head, total) = bmp_header(16, 16, true);
        let page = stage_page(&root, "page-0000.bmp", &head, total);
        let verdict = judged(false, false, None, None, std::slice::from_ref(&page))
            .expect("a whole page passes");
        assert_eq!(verdict.pages, vec![page.to_string_lossy().to_string()]);
        assert!(verdict.interrupted.is_none());
        assert!(page.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_jam_mid_batch_keeps_the_good_pages_and_discards_the_torn_one() {
        // Checklist row 9 at the injected-transfer seam. Three sheets went
        // through, the fourth tore in the paper path, and the driver reported
        // a jam. The three whole sheets are the user's work and are offered;
        // the torn one is deleted so nothing downstream can decode it; the
        // outcome names the jam rather than reporting a clean success.
        let root = temp_scratch_root("judge-jam");
        let (head, total) = bmp_header(64, 64, true);
        let whole: Vec<PathBuf> = (0..3)
            .map(|i| stage_page(&root, &format!("page-{i:04}.bmp"), &head, total))
            .collect();
        let torn = stage_page(&root, "page-0003.bmp", &head, total - 500);
        let mut staged = whole.clone();
        staged.push(torn.clone());

        let verdict = judged(false, false, None, Some(WIA_ERROR_PAPER_JAM), &staged)
            .expect("a jam over completed sheets is a partial, not a failure");
        assert_eq!(verdict.pages.len(), 3, "every whole sheet is kept");
        assert_eq!(
            verdict.interrupted.as_ref().map(|r| r.key),
            Some("scan.paperJam"),
            "the outcome names the jam"
        );
        assert!(!torn.exists(), "the torn sheet never reaches assembly");
        assert!(whole.iter().all(|p| p.exists()));

        // A misfeed the driver calls a paper problem is the same class.
        let verdict = judged(false, false, None, Some(WIA_ERROR_PAPER_PROBLEM), &whole)
            .expect("a misfeed over completed sheets is a partial");
        assert_eq!(verdict.interrupted.map(|r| r.key), Some("scan.paperProblem"));

        // A jam with nothing whole behind it has no honest partial to offer.
        let refusal = judged(
            false,
            false,
            None,
            Some(WIA_ERROR_PAPER_JAM),
            std::slice::from_ref(&torn),
        )
            .expect_err("a jam that staged nothing usable refuses");
        assert_eq!(refusal.key, "scan.paperJam");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_lost_device_is_still_total_and_is_not_a_jam() {
        // The line between the two: a jam keeps what completed, a device loss
        // keeps nothing. Same staged pages, different reported status.
        let root = temp_scratch_root("judge-jam-vs-loss");
        let (head, total) = bmp_header(64, 64, true);
        let whole = stage_page(&root, "page-0000.bmp", &head, total);
        let torn = stage_page(&root, "page-0001.bmp", &head, total - 500);
        let staged = vec![whole.clone(), torn.clone()];

        let refusal = judged(
            false,
            false,
            None,
            Some(WIA_ERROR_DEVICE_COMMUNICATION),
            &staged,
        )
        .expect_err("a device loss refuses the whole run");
        assert_eq!(refusal.key, "scan.deviceLost");

        // And a truncated page with no reported status at all stays total:
        // every staged page goes, not only the short one.
        let whole = stage_page(&root, "page-0002.bmp", &head, total);
        let torn = stage_page(&root, "page-0003.bmp", &head, total - 500);
        let refusal = judged(false, false, None, None, &[whole.clone(), torn.clone()])
            .expect_err("a short page with no status is a device loss");
        assert_eq!(refusal.key, "scan.deviceLost");
        assert!(!whole.exists() && !torn.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_status_reported_through_the_callback_outranks_a_successful_download() {
        // The second half of the same driver behaviour: a failure reported on
        // the callback while `Download` returns S_OK was read as a clean run.
        let refusal = judged(false, false, None, Some(WIA_ERROR_DEVICE_COMMUNICATION), &[])
            .expect_err("a reported failure is a refusal");
        assert_eq!(refusal.key, "scan.deviceLost");

        let refusal = judged(false, false, None, Some(WIA_ERROR_OFFLINE), &[])
            .expect_err("a reported failure is a refusal");
        assert_eq!(refusal.key, "scan.deviceOffline");

        // And a general error with nothing else to say still names itself.
        let refusal = judged(false, false, Some(WIA_ERROR_GENERAL_ERROR), None, &[])
            .expect_err("a failed download is a refusal");
        assert_eq!(refusal.key, "scan.failed");
        assert_eq!(refusal.code.as_deref(), Some("0x80210001"));
    }

    #[test]
    fn a_cancel_keeps_its_pages_and_the_watchdog_keeps_its_own_key() {
        let root = temp_scratch_root("judge-cancel");
        let (head, total) = bmp_header(16, 16, true);
        let page = stage_page(&root, "page-0000.bmp", &head, total);
        // A cancel we asked for: the driver's S_FALSE is not a failure.
        let verdict = judged(false, true, Some(HRESULT(1)), None, std::slice::from_ref(&page))
            .expect("a cancelled run offers what completed");
        assert_eq!(verdict.pages.len(), 1);
        assert!(verdict.interrupted.is_none(), "a cancel is not a jam");
        // The watchdog's own row is not displaced by the new one.
        let refusal =
            judged(true, true, None, Some(WIA_ERROR_DEVICE_COMMUNICATION), &[]).expect_err("timed out");
        assert_eq!(refusal.key, "scan.notResponding");
        // A clean transfer with no pages is still the device's Cancel button.
        let refusal = judged(false, false, None, None, &[]).expect_err("no pages, no cancel");
        assert_eq!(refusal.key, "scan.cancelledAtDevice");
        let _ = std::fs::remove_dir_all(&root);
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
    fn each_offered_source_reports_the_value_it_writes() {
        let handling = document_handling(
            (FLATBED | FEEDER | DUPLEX) as i32,
            &[SourceCategory::Flatbed, SourceCategory::Feeder],
        );
        assert_eq!(handling.flatbed_select, FLATBED as i32);
        assert_eq!(handling.feeder_select, FEEDER as i32);
        // A duplex run selects the feeder as well as the duplex bit; the bit
        // alone names no source to take the sheet from.
        assert_eq!(handling.duplex_select, (FEEDER | DUPLEX) as i32);
        assert_ne!(handling.duplex_select & FEEDER as i32, 0);
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

    fn reported(category: SourceCategory, selectable: bool) -> ScanSourceReport {
        ScanSourceReport {
            item_name: format!("Root\\{category:?}"),
            category,
            properties: Vec::new(),
            resolution: ControlModel::Absent,
            optical_resolution: None,
            color_modes: Vec::new(),
            brightness: ControlModel::Absent,
            contrast: ControlModel::Absent,
            pages: ControlModel::Absent,
            document_handling_select: if selectable {
                ControlModel::Flags {
                    valid: 7,
                    current: Some(2),
                }
            } else {
                ControlModel::Absent
            },
        }
    }

    #[test]
    fn a_flatbed_only_device_offers_no_feeder_and_no_duplex() {
        let sources = vec![reported(SourceCategory::Flatbed, true)];
        let handling = document_handling(FLATBED as i32, &[SourceCategory::Flatbed]);
        let options = source_options(&handling, &sources);
        assert_eq!(
            options.iter().map(|o| o.id).collect::<Vec<_>>(),
            vec![SourceOptionId::Flatbed]
        );
        assert!(!options[0].feeds);
    }

    #[test]
    fn a_feeder_with_duplex_offers_three_rows_and_writes_the_reported_values() {
        let sources = vec![
            reported(SourceCategory::Flatbed, true),
            reported(SourceCategory::Feeder, true),
        ];
        let handling = document_handling(
            (FLATBED | FEEDER | DUPLEX) as i32,
            &[SourceCategory::Flatbed, SourceCategory::Feeder],
        );
        let options = source_options(&handling, &sources);
        assert_eq!(
            options.iter().map(|o| o.id).collect::<Vec<_>>(),
            vec![
                SourceOptionId::Flatbed,
                SourceOptionId::Feeder,
                SourceOptionId::Duplex
            ]
        );
        assert_eq!(
            options
                .iter()
                .map(|o| o.document_handling)
                .collect::<Vec<_>>(),
            vec![
                Some(FLATBED as i32),
                Some(FEEDER as i32),
                Some((FEEDER | DUPLEX) as i32)
            ]
        );
        // Only a feeder can produce more than one page in one run.
        assert_eq!(
            options.iter().map(|o| o.feeds).collect::<Vec<_>>(),
            vec![false, true, true]
        );
        // The duplex row transfers from the FEEDER item; the duplex bit names
        // no source to take the sheet from.
        assert_eq!(options[2].item_name, options[1].item_name);
    }

    #[test]
    fn front_and_back_child_items_still_transfer_from_the_feeder() {
        let sources = vec![
            reported(SourceCategory::Feeder, true),
            reported(SourceCategory::FeederFront, true),
            reported(SourceCategory::FeederBack, true),
        ];
        let handling = document_handling(
            (FEEDER | DUPLEX | ADVANCED_DUPLEX) as i32,
            &[
                SourceCategory::Feeder,
                SourceCategory::FeederFront,
                SourceCategory::FeederBack,
            ],
        );
        let options = source_options(&handling, &sources);
        let duplex = options
            .iter()
            .find(|o| o.id == SourceOptionId::Duplex)
            .expect("a duplex row");
        assert_eq!(duplex.item_name, "Root\\Feeder");
    }

    #[test]
    fn a_device_that_reports_no_handling_still_offers_the_item_it_has() {
        let sources = vec![reported(SourceCategory::Flatbed, false)];
        let handling = document_handling(0, &[SourceCategory::Flatbed]);
        let options = source_options(&handling, &sources);
        assert_eq!(options.len(), 1);
        // Nothing is written to select a source the device never said it had
        // a property for.
        assert_eq!(options[0].document_handling, None);
    }

    #[test]
    fn a_device_with_no_scan_source_offers_nothing() {
        let handling = document_handling(0, &[]);
        assert!(source_options(&handling, &[]).is_empty());
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
    fn every_refusal_key_is_one_the_catalog_carries() {
        // The cross-language pin. A key this module can refuse with and the
        // renderer's catalog has no row for renders as its own name, and
        // nothing on either side would notice on its own.
        let fixture = include_str!("../../tests/fixtures/scan-refusal-keys.json");
        let carried: Vec<String> = serde_json::from_str(fixture).expect("the fixture is JSON");
        let mut produced: Vec<&str> = HRESULT_REFUSALS.iter().map(|(_, key, _)| *key).collect();
        produced.extend([
            "scan.failed",
            "scan.busy",
            "scan.cancelledAtDevice",
            "scan.notResponding",
            "scan.scratchFull",
        ]);
        for key in &produced {
            assert!(
                carried.iter().any(|c| c == key),
                "{key} is refusable here and absent from the catalog fixture"
            );
        }
        // And the other way: a fixture row nothing produces is a catalog
        // entry with no refusal behind it.
        for key in &carried {
            assert!(
                produced.contains(&key.as_str()),
                "{key} is in the catalog fixture and nothing here produces it"
            );
        }
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

    /// A scratch root of this test's own, so a sweep here can never reach a
    /// live run's folder under the real root.
    fn temp_scratch_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir()
            .join("spectrapdf-scratch-tests")
            .join(format!("{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a test root is creatable");
        root
    }

    #[test]
    fn the_sweeper_takes_only_folders_that_are_both_unlocked_and_old() {
        let root = temp_scratch_root("sweep");
        let live = allocate_scan_scratch(&root, 8).expect("a live run allocates");
        let abandoned = allocate_scan_scratch(&root, 8).expect("a second run allocates");
        // The abandoned run's process is gone: its marker is no longer held.
        release_scratch_lock(&abandoned);
        // A folder from a version that never wrote a marker is not live
        // either, and the age rule is the only thing protecting it.
        let markerless = root.join("scan-legacy");
        std::fs::create_dir_all(&markerless).expect("a markerless folder");
        std::fs::write(abandoned.join("page-0000.bmp"), b"staged").expect("stage a page");

        // Young is kept whatever its lock says: nothing here is an hour old.
        assert_eq!(sweep_scratch_root(&root, Duration::from_secs(3600)), 0);
        assert!(live.exists() && abandoned.exists() && markerless.exists());

        // Old enough, and now only the lock decides.
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(sweep_scratch_root(&root, Duration::ZERO), 2);
        assert!(!abandoned.exists(), "an unlocked, old run folder is swept");
        assert!(!markerless.exists(), "so is one with no marker at all");
        assert!(live.exists(), "a held folder survives any age");

        release_scratch_lock(&live);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_liveness_marker_dies_with_the_process_that_held_it() {
        // The reason the marker is a HELD HANDLE and not a pid file: a process
        // killed outright still releases it, and nothing has to be trusted to
        // clean up after itself.
        let root = temp_scratch_root("orphan");
        let dir = allocate_scan_scratch(&root, 4).expect("a run allocates");
        release_scratch_lock(&dir);
        let lock = dir.join(SCRATCH_LOCK).to_string_lossy().to_string();
        let mut child = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "$f=[System.IO.File]::Open('{lock}','Open','ReadWrite','None'); Start-Sleep 120"
                ),
            ])
            .spawn()
            .expect("a child process can be spawned");
        // The open is not instant; wait for the hold rather than assuming it.
        let mut held = false;
        for _ in 0..100 {
            if scratch_is_live(&dir) {
                held = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(held, "the child took the marker");
        assert_eq!(
            sweep_scratch_root(&root, Duration::ZERO),
            0,
            "a folder another process holds is not swept"
        );

        child.kill().expect("the child can be killed");
        child.wait().expect("the child is reaped");
        // The handle went with the process, with nothing run on its behalf.
        let mut released = false;
        for _ in 0..100 {
            if !scratch_is_live(&dir) {
                released = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(released, "the killed process released the marker");
        assert_eq!(sweep_scratch_root(&root, Duration::ZERO), 1);
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn exhaustion_refuses_by_its_own_key_and_names_the_root() {
        // Every index taken means live runs, not leaked ones — the sweep has
        // already run by then. The refusal has to leave the user somewhere to
        // go, which is why it carries the folder as a FIELD.
        let root = temp_scratch_root("full");
        let taken: Vec<PathBuf> = (0..2)
            .map(|_| allocate_scan_scratch(&root, 2).expect("both indices allocate"))
            .collect();
        let refusal = allocate_scan_scratch(&root, 2).expect_err("no index is left");
        assert_eq!(refusal.key, "scan.scratchFull");
        assert_eq!(refusal.folder.as_deref(), Some(root.to_string_lossy().as_ref()));
        assert!(refusal.message.contains(&root.to_string_lossy().to_string()));
        for dir in &taken {
            release_scratch_lock(dir);
        }
        let _ = std::fs::remove_dir_all(&root);
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

    // ── The backend seam ────────────────────────────────────────────────

    /// Every stack, so a new one cannot be added without meeting the rules
    /// below.
    const EVERY_STACK: &[ScanStack] = &[ScanStack::Wia];

    #[test]
    fn every_stack_has_a_backend_that_answers_for_it() {
        for &stack in EVERY_STACK {
            assert_eq!(backend_for(stack).stack(), stack);
        }
        assert_eq!(
            backends().len(),
            EVERY_STACK.len(),
            "a stack without a registered backend cannot open a device"
        );
    }

    #[test]
    fn every_stack_prefix_is_unique_and_readable_back() {
        let mut seen: Vec<&str> = Vec::new();
        for &stack in EVERY_STACK {
            let prefix = stack.prefix();
            assert!(!seen.contains(&prefix), "two stacks share the prefix {prefix}");
            seen.push(prefix);
            assert_eq!(ScanStack::from_prefix(prefix), Some(stack));
        }
    }

    #[test]
    fn a_namespaced_id_round_trips_and_its_native_half_stays_native() {
        // A WIA device id is a device-path shape, and it survives verbatim:
        // the native half is what reaches the driver.
        let native = r"\\?\usb#vid_04a9&pid_1913#0000#{6bdd1fc6-810f-11d0-bec7-08002be2092f}";
        let id = DeviceId {
            stack: ScanStack::Wia,
            native: native.to_string(),
        };
        let qualified = id.qualified();
        assert_eq!(qualified, format!("wia:{native}"));
        let read = DeviceId::parse(&qualified);
        assert_eq!(read.stack, ScanStack::Wia);
        assert_eq!(read.native, native);
        assert_eq!(read.qualified(), qualified);
    }

    #[test]
    fn parsing_a_namespaced_id_twice_does_not_namespace_it_twice() {
        let once = DeviceId::parse("wia:device-7").qualified();
        assert_eq!(once, "wia:device-7");
        assert_eq!(DeviceId::parse(&once).qualified(), once);
    }

    #[test]
    fn an_id_stored_before_the_namespace_existed_reads_as_wia() {
        // The migration: every shipped version wrote a bare WIA id, and there
        // was no other stack it could have come from.
        let legacy = "{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0000";
        let read = DeviceId::parse(legacy);
        assert_eq!(read.stack, ScanStack::Wia);
        assert_eq!(read.native, legacy);
        assert_eq!(read.qualified(), format!("wia:{legacy}"));
    }

    #[test]
    fn a_legacy_stored_device_still_preselects_and_comes_back_namespaced() {
        // The migration end to end, without a scanner: the stored value is
        // the old spelling, the enumerated id is the new one, and what goes
        // back is the new one — which is what the caller stores next.
        let legacy = "{6BDD1FC6-810F-11D0-BEC7-08002BE2092F}\\0000";
        let scanners = vec![ScannerDevice {
            id: format!("wia:{legacy}"),
            name: "A scanner".to_string(),
        }];
        assert_eq!(
            resolve_default(&scanners, Some(legacy.to_string())),
            Some(format!("wia:{legacy}"))
        );
        // And the already-migrated value keeps working unchanged.
        assert_eq!(
            resolve_default(&scanners, Some(format!("wia:{legacy}"))),
            Some(format!("wia:{legacy}"))
        );
        // The phantom-default rule holds in both spellings.
        assert_eq!(resolve_default(&scanners, Some("gone".into())), None);
        assert_eq!(resolve_default(&scanners, Some("wia:gone".into())), None);
        assert_eq!(resolve_default(&scanners, None), None);
    }

    #[test]
    fn every_enumerated_id_carries_a_stack_that_can_be_read_back() {
        // Vacuous on a scannerless machine and load-bearing on one with a
        // device: an id that leaves enumeration unnamespaced would reach the
        // store as some other stack's.
        let list = enumerate(None).expect("enumeration is never an error");
        for device in &list.scanners {
            let (prefix, _) = device
                .id
                .split_once(':')
                .unwrap_or_else(|| panic!("{} left enumeration unnamespaced", device.id));
            assert!(
                ScanStack::from_prefix(prefix).is_some(),
                "{} names no stack this build carries",
                device.id
            );
        }
    }

    /// A session belonging to no real device, so the store's routing can be
    /// tested without one.
    struct FakeSession {
        runs: Mutex<Vec<PathBuf>>,
        cancelled: Arc<AtomicBool>,
    }

    impl ScanSession for FakeSession {
        fn capabilities(&self) -> Result<ScannerCapabilities, ScanRefusal> {
            Err(ScanRefusal::named("scan.failed", "not a real device"))
        }

        fn acquire(
            &self,
            _settings: ScanSettings,
            dir: PathBuf,
            _sink: EventSink,
        ) -> Result<ScanResult, ScanRefusal> {
            self.runs.lock().expect("test lock").push(dir.clone());
            Ok(ScanResult {
                pages: Vec::new(),
                cancelled: false,
                interrupted: None,
                scratch: dir.to_string_lossy().into_owned(),
                dpi: 300,
                adjusted: Vec::new(),
                bytes: 0,
            })
        }

        fn cancel(&self) {
            self.cancelled.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn the_store_routes_both_spellings_of_one_id_to_the_same_session() {
        // Slice A's whole point: the store holds sessions by namespaced id,
        // and a caller holding either spelling reaches the one session — no
        // second device lock, and no run started against a stale key.
        let sessions = ScannerSessions::new();
        let cancelled = Arc::new(AtomicBool::new(false));
        let fake = Arc::new(FakeSession {
            runs: Mutex::new(Vec::new()),
            cancelled: cancelled.clone(),
        });
        sessions.sessions.lock().expect("test lock").insert(
            "wia:fake".to_string(),
            Entry {
                session: fake.clone(),
                last_used: Instant::now(),
            },
        );

        // The legacy spelling reaches it…
        sessions
            .acquire(
                "fake",
                ScanSettings::default(),
                PathBuf::from("legacy"),
                Box::new(|_| {}),
            )
            .expect("the fake session answers");
        // …and so does the namespaced one.
        sessions
            .acquire(
                "wia:fake",
                ScanSettings::default(),
                PathBuf::from("namespaced"),
                Box::new(|_| {}),
            )
            .expect("the fake session answers");
        assert_eq!(
            *fake.runs.lock().expect("test lock"),
            vec![PathBuf::from("legacy"), PathBuf::from("namespaced")]
        );

        sessions.cancel("fake");
        assert!(cancelled.load(Ordering::SeqCst), "cancel reached the session");

        sessions.close("fake");
        assert!(
            sessions.sessions.lock().expect("test lock").is_empty(),
            "the legacy spelling closes the session it opened"
        );
    }
}
