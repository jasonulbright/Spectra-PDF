//! The scanner model every acquisition stack shares: the reported shapes,
//! the refusals, the control derivation, the backend seam, the scan scratch
//! and the session store.
//!
//! The stacks themselves live in `scanner.rs` (WIA 2.0, Windows) and
//! `scanner_sane.rs` (SANE, Linux); each re-exports this module as
//! `crate::scanner` and supplies `backends`, `backend_for` and the device
//! picker. Every serialised shape here is the renderer's wire contract
//! (`src/renderer/lib/scan.ts`) on both platforms.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Once, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime};

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

/// Read a refusal back from its own serialised form.
///
/// Hand-written because the key is `&'static str`: the wire carries owned
/// text, and the interner is what turns it back into the spelling the type
/// requires. Every field round-trips, so a refusal that crossed a process
/// boundary is the same refusal, `code` and `folder` included.
impl<'de> serde::Deserialize<'de> for ScanRefusal {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        struct Wire {
            key: String,
            message: String,
            #[serde(default)]
            code: Option<String>,
            #[serde(default)]
            folder: Option<String>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Ok(ScanRefusal {
            key: intern_refusal_key(&wire.key),
            message: wire.message,
            code: wire.code,
            folder: wire.folder,
        })
    }
}

/// Resolve a refusal key that arrived as owned text back to the `'static`
/// spelling the type carries.
///
/// Keys originate as literals in this module, so the set is finite and the
/// interner leaks at most once per distinct key. An unrecognised key would be
/// a key this module never wrote.
pub(crate) fn intern_refusal_key(key: &str) -> &'static str {
    static KNOWN: OnceLock<Mutex<std::collections::HashSet<&'static str>>> = OnceLock::new();
    if key.is_empty() {
        return "scan.failed";
    }
    let known = KNOWN.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    let Ok(mut known) = known.lock() else {
        return "scan.failed";
    };
    if let Some(found) = known.get(key) {
        return found;
    }
    let leaked: &'static str = Box::leak(key.to_string().into_boxed_str());
    known.insert(leaked);
    leaked
}

impl ScanRefusal {
    pub(crate) fn named(key: &'static str, message: &str) -> Self {
        Self {
            key,
            message: message.to_string(),
            code: None,
            folder: None,
        }
    }
}

// ── Reported shapes ─────────────────────────────────────────────────────────

/// One enumerated imaging device of scanner type.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

/// How a duplex run reaches both sides of a sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceOptionId {
    Flatbed,
    Feeder,
    Duplex,
}

/// One row of the source picker: which item a run transfers from and what it
/// writes to select it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    for backend in crate::scanner::backends() {
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
pub(crate) fn resolve_default(scanners: &[ScannerDevice], last_used: Option<String>) -> Option<String> {
    let wanted = DeviceId::parse(&last_used?).qualified();
    scanners.iter().any(|d| d.id == wanted).then_some(wanted)
}

// ── The backend seam ────────────────────────────────────────────────────────

/// Which acquisition stack a device came from.
///
/// One stack ships. The seam exists so that a second one is an added
/// implementation rather than a rewrite of the session store, the commands and
/// the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScanStack {
    #[cfg(windows)]
    Wia,
    #[cfg(target_os = "linux")]
    Sane,
}

impl ScanStack {
    /// The stack an unprefixed id belongs to: the one this platform builds.
    fn native() -> Self {
        #[cfg(windows)]
        {
            ScanStack::Wia
        }
        #[cfg(target_os = "linux")]
        {
            ScanStack::Sane
        }
    }

    /// The prefix this stack's device ids carry.
    pub fn prefix(self) -> &'static str {
        match self {
            #[cfg(windows)]
            ScanStack::Wia => "wia",
            #[cfg(target_os = "linux")]
            ScanStack::Sane => "sane",
        }
    }

    pub(crate) fn from_prefix(prefix: &str) -> Option<Self> {
        match prefix {
            #[cfg(windows)]
            "wia" => Some(ScanStack::Wia),
            #[cfg(target_os = "linux")]
            "sane" => Some(ScanStack::Sane),
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
            stack: ScanStack::native(),
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

/// How long a session may sit unused before the reaper drops it and releases
/// the device lock with it.
pub(crate) const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// How often the reaper looks.
pub(crate) const REAP_INTERVAL: Duration = Duration::from_secs(15);

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
    /// The bytes could not be inspected; this is not proof of a short transfer.
    Unreadable { error: String },
}

/// The bytes a BMP's own headers promise, from `bfSize` when the encoder wrote
/// one and from the DIB geometry when it did not.
///
/// Rows are padded to a four-byte boundary — the format's own rule, and the
/// reason the row stride is not `width * bits / 8`.
pub(crate) fn bmp_declared_len(head: &[u8]) -> Option<u64> {
    if head.len() < 14 || &head[0..2] != b"BM" {
        return None;
    }
    let u32_at = |at: usize| -> u64 {
        u32::from_le_bytes([head[at], head[at + 1], head[at + 2], head[at + 3]]) as u64
    };
    let declared = u32_at(2);
    let geometry = if head.len() >= 54 {
        let offset = u32_at(10);
        let width = i32::from_le_bytes([head[18], head[19], head[20], head[21]]) as i64;
        let height = i32::from_le_bytes([head[22], head[23], head[24], head[25]]) as i64;
        let bits = u16::from_le_bytes([head[28], head[29]]) as i64;
        let compression = u32_at(30);
        if compression == 0 && width > 0 && height != 0 && bits > 0 {
            // An overflowing geometry cannot describe a complete file on any
            // supported filesystem. Preserve it as a too-large declaration.
            let row_bits = (width as u64) * (bits as u64);
            let stride = ((row_bits + 31) / 32) * 4;
            let rows = height.unsigned_abs() as u64;
            Some(
                stride
                    .checked_mul(rows)
                    .and_then(|image_bytes| offset.checked_add(image_bytes))
                    .unwrap_or(u64::MAX),
            )
        } else {
            None
        }
    } else {
        None
    };
    match (declared >= 14, geometry) {
        (true, Some(geometry)) => Some((declared as u64).max(geometry)),
        (true, None) => Some(declared as u64),
        (false, geometry) => geometry,
    }
}

/// Whether one staged page holds everything its header promises.
///
/// Read from the file rather than from the transfer's byte counter: the counter
/// records what the callback was told, and a lost device is exactly the case
/// where that and the file disagree.
pub fn page_integrity(path: &Path) -> PageIntegrity {
    retry_page_integrity(|| read_page_integrity(path), std::thread::sleep)
}

pub(crate) const PAGE_READ_RETRY_LIMIT: u32 = 20;
pub(crate) const PAGE_READ_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(50);

pub(crate) fn retry_page_integrity(
    mut read: impl FnMut() -> std::io::Result<PageIntegrity>,
    mut wait: impl FnMut(std::time::Duration),
) -> PageIntegrity {
    for attempt in 0..=PAGE_READ_RETRY_LIMIT {
        match read() {
            Ok(verdict) => return verdict,
            Err(error)
                if matches!(error.raw_os_error(), Some(32 | 33))
                    && attempt < PAGE_READ_RETRY_LIMIT =>
            {
                wait(PAGE_READ_RETRY_DELAY);
            }
            Err(error) => return PageIntegrity::Unreadable { error: error.to_string() },
        }
    }
    unreachable!()
}

pub(crate) fn read_page_integrity(path: &Path) -> std::io::Result<PageIntegrity> {
    use std::io::{Read, Seek, SeekFrom};
    // One handle supplies both the length and the bytes, and a failed open or
    // metadata read is an error, never a zero-length page read as device loss.
    let mut file = std::fs::File::open(path)?;
    let actual = file.metadata()?.len();
    let mut head = [0u8; 54];
    let count = actual.min(head.len() as u64) as usize;
    file.read_exact(&mut head[..count])?;
    let head = &head[..count];
    if head.starts_with(b"BM") {
        return Ok(match bmp_declared_len(head) {
            Some(declared) if actual < declared => PageIntegrity::Truncated { declared, actual },
            Some(_) => PageIntegrity::Complete,
            None => PageIntegrity::Unverifiable,
        });
    }
    if head.starts_with(PNG_SIGNATURE) {
        // IEND is a zero-length chunk followed by its four-byte CRC.
        const IEND: [u8; 12] = [0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82];
        let mut tail = [0u8; 12];
        let ended = if actual >= 12 {
            file.seek(SeekFrom::End(-12))?;
            file.read_exact(&mut tail)?;
            tail == IEND
        } else { false };
        return Ok(if ended { PageIntegrity::Complete } else {
            PageIntegrity::Truncated { declared: 0, actual }
        });
    }
    Ok(if actual == 0 {
        PageIntegrity::Truncated { declared: 0, actual }
    } else { PageIntegrity::Unverifiable })
}

pub(crate) const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// The first staged page that is short or cannot be inspected, if any.
pub fn first_incomplete_page(pages: &[PathBuf]) -> Option<(PathBuf, PageIntegrity)> {
    pages.iter().find_map(|path| match page_integrity(path) {
        short @ (PageIntegrity::Truncated { .. } | PageIntegrity::Unreadable { .. }) => Some((path.clone(), short)),
        _ => None,
    })
}

/// What the dialog (or the CLI) asked for. Every field is optional: a control
/// the device did not report is a control the dialog did not render, so its
/// setting is absent rather than guessed.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PropertyAdjustment {
    /// The property's own name as the driver spells it, never translated.
    pub property: String,
    pub requested: i32,
    pub actual: Option<i32>,
}

/// One acquisition's outcome. A cancelled run is a RESULT: the pages that
/// completed are here and the dialog offers them.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

/// A boxed event sink, so the transfer path has no idea whether it is feeding
/// a Tauri channel, a CLI's stderr, or nothing.
pub type EventSink = Box<dyn Fn(ScanEvent) + Send + Sync>;

// ── Scan scratch ────────────────────────────────────────────────────────────

/// The one folder every run's staged pages live under. Same discipline as the
/// batch scratch: a delete names exactly what it may take, so a caller cannot
/// turn `scan_discard` into a general remove by passing a source path.
#[cfg(windows)]
pub(crate) fn scan_scratch_root() -> PathBuf {
    std::env::temp_dir().join("spectrapdf").join("scan-scratch")
}

/// The per-user cache folder, never the shared `/tmp`: another account could
/// create the folder first and read or replace the staged pages.
#[cfg(target_os = "linux")]
pub(crate) fn scan_scratch_root() -> PathBuf {
    crate::portable::xdg_base_from(
        std::env::var_os("XDG_CACHE_HOME"),
        std::env::var_os("HOME").map(PathBuf::from),
        ".cache",
    )
    .map(|cache| cache.join("spectrapdf").join("scan-scratch"))
    .unwrap_or_else(|| {
        std::env::temp_dir()
            .join(format!("spectrapdf-{}", unsafe { libc::geteuid() }))
            .join("scan-scratch")
    })
}

/// The marker file a live run holds OPEN inside its own scratch folder.
///
/// A held handle, never a pid file: a pid can be reused and a crash leaves the
/// file behind claiming the run is alive, whereas a handle is closed by the
/// kernel when the owning process dies however it dies. The handle is taken
/// with no sharing, so a second process — or a second window of this one —
/// cannot open it while the owner holds it, and neither can delete it. That is
/// the whole liveness test, and it needs no cross-process bookkeeping.
pub(crate) const SCRATCH_LOCK: &str = ".live";

/// How long an UNLOCKED run folder survives before the sweeper takes it.
///
/// Long enough that no ordinary review session is at risk (a folder is locked
/// for as long as its run is live, so the age rule only ever governs folders
/// nothing holds — including those left by a version that had no marker).
pub(crate) const SCRATCH_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// The lock handles this process holds, keyed by the run folder.
///
/// Held here rather than in the caller so a discard can release the handle
/// before removing the folder — the no-sharing handle blocks its own delete.
pub(crate) fn scratch_locks() -> &'static Mutex<HashMap<PathBuf, File>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, File>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Release this process's hold on a run folder's marker.
///
/// Compared canonically, for the same reason `inside_scan_scratch` is: the
/// path arriving from a caller need not be spelled the way it was handed out,
/// and a handle left held would refuse the folder's own delete.
pub(crate) fn release_scratch_lock(path: &Path) {
    if let Ok(mut held) = scratch_locks().lock() {
        let target = path.canonicalize().ok();
        held.retain(|dir, _| dir != path && dir.canonicalize().ok() != target);
    }
}

/// Take the run folder's liveness marker, failing if it cannot be held.
#[cfg(windows)]
pub(crate) fn hold_scratch_lock(dir: &Path) -> std::io::Result<File> {
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
#[cfg(windows)]
pub(crate) fn scratch_is_live(dir: &Path) -> bool {
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

/// The marker held with an exclusive `flock`: the kernel releases the lock
/// when the owning process dies however it dies, the property the Windows
/// no-sharing handle has.
#[cfg(target_os = "linux")]
pub(crate) fn hold_scratch_lock(dir: &Path) -> std::io::Result<File> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(dir.join(SCRATCH_LOCK))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(file)
}

/// A folder is live while some process holds its marker's lock. A missing
/// marker is not live; any other failure answers LIVE, as on Windows.
#[cfg(target_os = "linux")]
pub(crate) fn scratch_is_live(dir: &Path) -> bool {
    use std::os::fd::AsRawFd;
    match File::open(dir.join(SCRATCH_LOCK)) {
        Ok(file) => (unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }) != 0,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

/// Create the scratch root readable by its owner only, and refuse a folder
/// another account owns or a symbolic link put in its place.
#[cfg(target_os = "linux")]
pub(crate) fn private_root(root: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(root)?;
    let meta = std::fs::symlink_metadata(root)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{} is not a folder this user owns", root.display()),
        ));
    }
    Ok(())
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
pub(crate) fn sweep_scratch_root(root: &Path, max_age: Duration) -> usize {
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
pub(crate) fn sweep_scan_scratch_once() {
    static SWEPT: Once = Once::new();
    SWEPT.call_once(|| {
        sweep_scratch_root(&scan_scratch_root(), SCRATCH_MAX_AGE);
    });
}

/// How many fresh names to try before refusing an allocation. Run folders
/// carry random names so the path returned to one renderer is a capability;
/// another window cannot guess and delete its scan by incrementing an index.
pub(crate) const SCRATCH_ALLOCATION_ATTEMPTS: u32 = 32;

/// A fresh, empty scratch folder for one run, with its liveness marker held.
pub fn new_scan_scratch() -> Result<PathBuf, ScanRefusal> {
    sweep_scan_scratch_once();
    allocate_scan_scratch(&scan_scratch_root(), SCRATCH_ALLOCATION_ATTEMPTS)
}

/// The allocator, over an explicit root and attempt ceiling so collisions are
/// reachable in a test without manufacturing a huge directory tree.
pub(crate) fn allocate_scan_scratch(root: &Path, limit: u32) -> Result<PathBuf, ScanRefusal> {
    allocate_scan_scratch_with(root, limit, |_, root| {
        root.join(format!("scan-{}", uuid::Uuid::new_v4().simple()))
    })
}

pub(crate) fn allocate_scan_scratch_with(
    root: &Path,
    limit: u32,
    mut candidate_for: impl FnMut(u32, &Path) -> PathBuf,
) -> Result<PathBuf, ScanRefusal> {
    let create_failed = |e: std::io::Error| ScanRefusal {
        key: "scan.failed",
        message: format!("Could not create the scan scratch folder: {e}"),
        code: None,
        folder: None,
    };
    #[cfg(windows)]
    std::fs::create_dir_all(root).map_err(create_failed)?;
    #[cfg(target_os = "linux")]
    private_root(root).map_err(create_failed)?;
    for n in 0..limit {
        let candidate = candidate_for(n, root);
        // `create_dir` is the claim, not a preceding `exists` test: even a
        // collision or simultaneous allocation cannot replace another run.
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
    // Repeated collisions are not evidence that 10,000 scans are live; random
    // names make that explanation both false and misleading.
    Err(ScanRefusal {
        key: "scan.failed",
        message: format!("Could not allocate a unique scan scratch folder under {}.", root.display()),
        code: None,
        folder: Some(root.to_string_lossy().to_string()),
    })
}

/// Is this exact run folder under the scan scratch root?
///
/// String containment is not the test: `..` and a symlink both defeat it. The
/// comparison is between canonicalised paths, and a path that cannot be
/// canonicalised is not inside anything. Requiring a direct child also keeps
/// a renderer from using this command to remove a nested or sibling resource.
pub fn inside_scan_scratch(path: &Path) -> bool {
    inside_scan_scratch_at(path, &scan_scratch_root())
}

pub(crate) fn inside_scan_scratch_at(path: &Path, scratch_root: &Path) -> bool {
    match (path.canonicalize(), scratch_root.canonicalize()) {
        (Ok(target), Ok(root)) => {
            let run_name = target
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix("scan-"));
            target.parent() == Some(root.as_path())
                && run_name.is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        }
        _ => false,
    }
}

/// Delete one run's scratch folder and everything staged in it.
pub fn discard_scan_scratch(path: &Path) -> Result<(), ScanRefusal> {
    discard_scan_scratch_at(path, &scan_scratch_root())
}

pub(crate) fn discard_scan_scratch_at(path: &Path, scratch_root: &Path) -> Result<(), ScanRefusal> {
    if !inside_scan_scratch_at(path, scratch_root) {
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
pub(crate) struct Entry {
    pub(crate) session: Arc<dyn ScanSession>,
    pub(crate) last_used: Instant,
}

/// The live sessions, one per namespaced device id.
///
/// Managed Tauri state in the app and a local value in the CLI, so both reach
/// a device the same way. Dropping the store closes every session it holds,
/// which is what releases the device locks.
pub struct ScannerSessions {
    pub(crate) sessions: Arc<Mutex<HashMap<String, Entry>>>,
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

    /// The live session on one device, opening it if none is live.
    ///
    /// The store's lock is released before the returned session is used: a
    /// device call is bounded but not instant, and a caller holding the store
    /// lock across one would make `cancel` and `close` wait for the very call
    /// they are trying to stop.
    fn ensure(&self, id: &DeviceId) -> Result<Arc<dyn ScanSession>, ScanRefusal> {
        let key = id.qualified();
        let mut open = self.sessions.lock().map_err(|_| {
            ScanRefusal::named("scan.failed", "The scanner session store is unusable.")
        })?;
        if !open.contains_key(&key) {
            let session = crate::scanner::backend_for(id.stack).open(&id.native)?;
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
        Ok(entry.session.clone())
    }

    /// Open a device and keep it, without asking it anything.
    ///
    /// The scanner host's own entry point: a caller that opens a device in one
    /// request and reports on it in the next needs the open to have happened
    /// and to have been reported as itself.
    pub fn open(&self, device_id: &str) -> Result<(), ScanRefusal> {
        self.ensure(&DeviceId::parse(device_id)).map(|_| ())
    }

    fn touch(&self, key: &str) {
        if let Ok(mut open) = self.sessions.lock() {
            if let Some(entry) = open.get_mut(key) {
                entry.last_used = Instant::now();
            }
        }
    }

    /// One device's capability report, opening a session for it if none is
    /// live.
    ///
    /// The report's own `device_id` comes back namespaced, so a caller that
    /// round-trips it — the checklist runner does — reaches the same device.
    pub fn capabilities(&self, device_id: &str) -> Result<ScannerCapabilities, ScanRefusal> {
        let id = DeviceId::parse(device_id);
        let key = id.qualified();
        let session = self.ensure(&id)?;
        let report = session.capabilities();
        self.touch(&key);
        if report.is_err() {
            let mut open = self.sessions.lock().map_err(|_| {
                ScanRefusal::named("scan.failed", "The scanner session store is unusable.")
            })?;
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
        let session = self.ensure(&id)?;
        let outcome = session.acquire(settings, dir, sink);
        self.touch(&key);
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
