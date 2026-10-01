//! Linux scanner acquisition — SANE device enumeration, the capability
//! report, and the page transfer.
//!
//! The same contract as the Windows WIA module (`scanner.rs`): the shared
//! model in `scan_model.rs`, the same commands, the same CLI arms. The
//! interface is the SANE standard (version 1.06, chapter 4); `libsane.so.1`
//! is the system's own copy, opened with `dlopen`, never bundled. A system
//! without it refuses by name.
//!
//! # Every SANE call runs in the scanner host child
//!
//! A SANE backend is a driver loaded into the calling process. One that
//! crashes or hangs on its USB transfer must not take the app with it, so the
//! library is loaded only inside the scanner host child (`crate::scan_host`),
//! whose requests are bounded and whose process is terminable from outside.
//! The child's lifetime is bound to the app's (`PR_SET_PDEATHSIG`).
//!
//! # One lock serializes the library
//!
//! The standard makes no promise about concurrent calls into one backend, so
//! every call except `sane_cancel` holds one process-wide lock. An
//! acquisition holds it for its whole run; a request that arrives meanwhile
//! is answered without touching the library — enumeration from the last
//! answer, anything else with `scan.busy` — so it can never wait out the host
//! deadline and cost the run its process. `sane_cancel` is the one call the
//! standard allows asynchronously, which is what makes Stop work mid-page.
//!
//! # Options are read by name
//!
//! `resolution`, `tl-x`, `tl-y`, `br-x`, `br-y` are the standard's
//! well-known options (section 4.5). `source`, `mode`, `brightness`,
//! `contrast` and the duplex switches are the names sane-backends uses
//! across its backends; their string values are matched by meaning, because
//! the standard leaves them to each backend.

pub use crate::scan_model::*;

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

// ── The SANE ABI (SANE standard 1.06, chapter 4) ───────────────────────────

/// The SONAME of sane-backends' front-end library on every distribution.
pub const LIBRARY: &str = "libsane.so.1";

type Word = c_int;

mod status {
    pub const GOOD: i32 = 0;
    pub const UNSUPPORTED: i32 = 1;
    pub const CANCELLED: i32 = 2;
    pub const DEVICE_BUSY: i32 = 3;
    pub const INVAL: i32 = 4;
    pub const EOF: i32 = 5;
    pub const JAMMED: i32 = 6;
    pub const NO_DOCS: i32 = 7;
    pub const COVER_OPEN: i32 = 8;
    pub const IO_ERROR: i32 = 9;
    pub const NO_MEM: i32 = 10;
    pub const ACCESS_DENIED: i32 = 11;

    pub fn name(code: i32) -> &'static str {
        match code {
            GOOD => "SANE_STATUS_GOOD",
            UNSUPPORTED => "SANE_STATUS_UNSUPPORTED",
            CANCELLED => "SANE_STATUS_CANCELLED",
            DEVICE_BUSY => "SANE_STATUS_DEVICE_BUSY",
            INVAL => "SANE_STATUS_INVAL",
            EOF => "SANE_STATUS_EOF",
            JAMMED => "SANE_STATUS_JAMMED",
            NO_DOCS => "SANE_STATUS_NO_DOCS",
            COVER_OPEN => "SANE_STATUS_COVER_OPEN",
            IO_ERROR => "SANE_STATUS_IO_ERROR",
            NO_MEM => "SANE_STATUS_NO_MEM",
            ACCESS_DENIED => "SANE_STATUS_ACCESS_DENIED",
            _ => "SANE_STATUS_UNKNOWN",
        }
    }
}

mod kind {
    pub const BOOL: i32 = 0;
    pub const INT: i32 = 1;
    pub const FIXED: i32 = 2;
    pub const STRING: i32 = 3;
}

mod unit {
    pub const PIXEL: i32 = 1;
    pub const MM: i32 = 3;
}

const CAP_SOFT_SELECT: Word = 1 << 0;
const CAP_INACTIVE: Word = 1 << 5;
const INFO_RELOAD_OPTIONS: Word = 1 << 1;

const CONSTRAINT_RANGE: i32 = 1;
const CONSTRAINT_WORD_LIST: i32 = 2;
const CONSTRAINT_STRING_LIST: i32 = 3;

const ACTION_GET: i32 = 0;
const ACTION_SET: i32 = 1;

mod frame {
    pub const GRAY: i32 = 0;
    pub const RGB: i32 = 1;
    pub const RED: i32 = 2;
    pub const GREEN: i32 = 3;
    pub const BLUE: i32 = 4;
}

#[repr(C)]
struct RawDevice {
    name: *const c_char,
    vendor: *const c_char,
    model: *const c_char,
    kind: *const c_char,
}

#[repr(C)]
struct RawRange {
    min: Word,
    max: Word,
    quant: Word,
}

#[repr(C)]
struct RawOption {
    name: *const c_char,
    title: *const c_char,
    desc: *const c_char,
    kind: c_int,
    unit: c_int,
    size: Word,
    cap: Word,
    constraint_type: c_int,
    constraint: *const c_void,
}

#[repr(C)]
#[derive(Default, Clone, Copy, Debug)]
struct RawParameters {
    format: c_int,
    last_frame: Word,
    bytes_per_line: Word,
    pixels_per_line: Word,
    lines: Word,
    depth: Word,
}

type Handle = *mut c_void;

struct Sane {
    get_devices: unsafe extern "C" fn(*mut *const *const RawDevice, Word) -> c_int,
    open: unsafe extern "C" fn(*const c_char, *mut Handle) -> c_int,
    close: unsafe extern "C" fn(Handle),
    get_option_descriptor: unsafe extern "C" fn(Handle, Word) -> *const RawOption,
    control_option: unsafe extern "C" fn(Handle, Word, c_int, *mut c_void, *mut Word) -> c_int,
    get_parameters: unsafe extern "C" fn(Handle, *mut RawParameters) -> c_int,
    start: unsafe extern "C" fn(Handle) -> c_int,
    read: unsafe extern "C" fn(Handle, *mut u8, Word, *mut Word) -> c_int,
    cancel: unsafe extern "C" fn(Handle),
}

unsafe impl Send for Sane {}
unsafe impl Sync for Sane {}

fn sane_missing() -> ScanRefusal {
    ScanRefusal::named(
        "scan.saneMissing",
        "Scanning needs SANE (libsane.so.1), which is not installed on this system.",
    )
}

/// A library a test loads in place of the system's.
#[cfg(test)]
static TEST_LIBRARY: OnceLock<PathBuf> = OnceLock::new();

fn library_name() -> CString {
    #[cfg(test)]
    if let Some(path) = TEST_LIBRARY.get() {
        use std::os::unix::ffi::OsStrExt;
        return CString::new(path.as_os_str().as_bytes()).expect("library path has no NUL");
    }
    CString::new(LIBRARY).expect("library name has no NUL")
}

/// The library, loaded and initialised once per host child.
fn sane() -> Result<&'static Sane, ScanRefusal> {
    static LOADED: OnceLock<Result<Sane, ScanRefusal>> = OnceLock::new();
    LOADED.get_or_init(load).as_ref().map_err(Clone::clone)
}

fn load() -> Result<Sane, ScanRefusal> {
    let name = library_name();
    let handle = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
    if handle.is_null() {
        return Err(sane_missing());
    }
    macro_rules! sym {
        ($name:literal) => {{
            let symbol = CString::new($name).expect("symbol name has no NUL");
            let found = unsafe { libc::dlsym(handle, symbol.as_ptr()) };
            if found.is_null() {
                return Err(sane_missing());
            }
            unsafe { std::mem::transmute::<*mut c_void, _>(found) }
        }};
    }
    let init: unsafe extern "C" fn(*mut Word, *mut c_void) -> c_int = sym!("sane_init");
    let mut version: Word = 0;
    let rc = unsafe { init(&mut version, std::ptr::null_mut()) };
    if rc != status::GOOD {
        return Err(refusal_for(rc, Phase::Open));
    }
    Ok(Sane {
        get_devices: sym!("sane_get_devices"),
        open: sym!("sane_open"),
        close: sym!("sane_close"),
        get_option_descriptor: sym!("sane_get_option_descriptor"),
        control_option: sym!("sane_control_option"),
        get_parameters: sym!("sane_get_parameters"),
        start: sym!("sane_start"),
        read: sym!("sane_read"),
        cancel: sym!("sane_cancel"),
    })
}

// ── Refusals ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Phase {
    Open,
    Transfer,
}

/// A SANE status as a named refusal. Statuses the table does not name carry
/// the status name as their code, so a report stays actionable.
pub(crate) fn refusal_for(code: i32, phase: Phase) -> ScanRefusal {
    match code {
        status::DEVICE_BUSY => {
            ScanRefusal::named("scan.deviceBusy", "The scanner is busy. Try again in a moment.")
        }
        status::INVAL => ScanRefusal::named(
            "scan.settingRejected",
            "The scanner rejected one of the requested settings.",
        ),
        status::JAMMED => {
            ScanRefusal::named("scan.paperJam", "Clear the paper jam, then scan again.")
        }
        status::NO_DOCS => ScanRefusal::named("scan.feederEmpty", "Put paper in the feeder."),
        status::COVER_OPEN => ScanRefusal::named("scan.coverOpen", "Close the scanner cover."),
        status::IO_ERROR if phase == Phase::Open => ScanRefusal::named(
            "scan.deviceOffline",
            "The scanner is turned off or cannot be reached.",
        ),
        status::IO_ERROR => ScanRefusal::named(
            "scan.deviceLost",
            "The scanner stopped responding during the scan.",
        ),
        status::ACCESS_DENIED => ScanRefusal::named(
            "scan.accessDenied",
            "This account is not allowed to use the scanner. Ask an administrator to grant scanner access.",
        ),
        status::CANCELLED => ScanRefusal::named(
            "scan.cancelledAtDevice",
            "The scan was cancelled at the scanner.",
        ),
        other => {
            let name = status::name(other);
            ScanRefusal {
                key: "scan.failed",
                message: format!("The scanner reported an error ({name})."),
                code: Some(name.to_string()),
                folder: None,
            }
        }
    }
}

fn busy() -> ScanRefusal {
    ScanRefusal::named("scan.busy", "A scan is already running on this scanner.")
}

// ── The library lock ────────────────────────────────────────────────────────

fn lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}

/// True while an acquisition holds the library.
static ACQUIRING: AtomicBool = AtomicBool::new(false);

/// How long a non-acquisition call waits for the library before it answers
/// without it. Well inside the host's call deadline.
const LOCK_PATIENCE: Duration = Duration::from_secs(5);

fn try_hold() -> Option<MutexGuard<'static, ()>> {
    let deadline = Instant::now() + LOCK_PATIENCE;
    loop {
        match lock().try_lock() {
            Ok(guard) => return Some(guard),
            Err(std::sync::TryLockError::Poisoned(p)) => return Some(p.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => {
                if ACQUIRING.load(Ordering::SeqCst) || Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

fn hold() -> MutexGuard<'static, ()> {
    lock().lock().unwrap_or_else(|p| p.into_inner())
}

// ── Enumeration ─────────────────────────────────────────────────────────────

fn text(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
}

/// A device row as SANE reports it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DeviceRow {
    pub name: String,
    pub vendor: String,
    pub model: String,
    pub kind: String,
}

/// The devices worth offering, with display names that tell apart one model
/// reached through two backends (for example a USB driver and eSCL).
pub(crate) fn device_list(rows: &[DeviceRow]) -> Vec<ScannerDevice> {
    let shown: Vec<&DeviceRow> = rows
        .iter()
        .filter(|r| !r.name.is_empty())
        .filter(|r| {
            let kind = r.kind.to_ascii_lowercase();
            !(kind.contains("camera") || kind.contains("video"))
        })
        .collect();
    let label = |r: &DeviceRow| {
        let joined = format!("{} {}", r.vendor.trim(), r.model.trim());
        let joined = joined.trim();
        if joined.is_empty() {
            r.name.clone()
        } else {
            joined.to_string()
        }
    };
    let mut devices: Vec<ScannerDevice> = Vec::new();
    for row in &shown {
        let base = label(row);
        let twins = shown.iter().filter(|other| label(other) == base).count();
        let name = if twins > 1 {
            let backend = row.name.split(':').next().unwrap_or(&row.name);
            format!("{base} ({backend})")
        } else {
            base
        };
        devices.push(ScannerDevice {
            id: row.name.clone(),
            name,
        });
    }
    devices.sort_by_key(|d| d.name.to_lowercase());
    devices
}

fn last_listing() -> &'static Mutex<Vec<ScannerDevice>> {
    static LAST: Mutex<Vec<ScannerDevice>> = Mutex::new(Vec::new());
    &LAST
}

fn sane_enumerate() -> Result<Vec<ScannerDevice>, ScanRefusal> {
    let lib = sane()?;
    let Some(_guard) = try_hold() else {
        return Ok(last_listing().lock().map(|l| l.clone()).unwrap_or_default());
    };
    let mut list: *const *const RawDevice = std::ptr::null();
    let rc = unsafe { (lib.get_devices)(&mut list, 0) };
    if rc != status::GOOD {
        return Err(refusal_for(rc, Phase::Open));
    }
    let mut rows = Vec::new();
    if !list.is_null() {
        let mut at = 0;
        loop {
            let device = unsafe { *list.add(at) };
            if device.is_null() {
                break;
            }
            let device = unsafe { &*device };
            rows.push(DeviceRow {
                name: text(device.name),
                vendor: text(device.vendor),
                model: text(device.model),
                kind: text(device.kind),
            });
            at += 1;
        }
    }
    let devices = device_list(&rows);
    if let Ok(mut last) = last_listing().lock() {
        *last = devices.clone();
    }
    Ok(devices)
}

/// Every SANE scanner, by SANE's own device name. Reached only inside a
/// scanner host child.
pub(crate) fn host_enumerate_announced<A>(announce: A) -> Result<Vec<ScannerDevice>, ScanRefusal>
where
    A: FnOnce() + Send + 'static,
{
    let outcome = sane_enumerate();
    announce();
    outcome
}

/// SANE has no system device picker; enumeration already includes network
/// devices. `Ok(None)` is the seam's answer for a stack with no picker.
pub(crate) fn host_select_device_dialog_announced<A>(
    _parent: usize,
    announce: A,
) -> Result<Option<String>, ScanRefusal>
where
    A: FnOnce() + Send + 'static,
{
    announce();
    Ok(None)
}

// ── Options ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Constraint {
    None,
    Range { min: Word, max: Word, quant: Word },
    Words(Vec<Word>),
    Strings(Vec<String>),
}

/// One option descriptor, copied out of the backend's memory.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OptionDesc {
    pub index: Word,
    pub name: String,
    pub title: String,
    pub kind: i32,
    pub unit: i32,
    pub size: Word,
    pub cap: Word,
    pub constraint: Constraint,
}

impl OptionDesc {
    fn active(&self) -> bool {
        self.cap & CAP_INACTIVE == 0
    }

    fn settable(&self) -> bool {
        self.active() && self.cap & CAP_SOFT_SELECT != 0
    }

    fn numeric(&self) -> bool {
        matches!(self.kind, kind::INT | kind::FIXED)
    }
}

/// An option's current value.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum OptValue {
    Number(f64),
    Bool(bool),
    Text(String),
}

/// What one read of a device's options found.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Snapshot {
    pub options: Vec<OptionDesc>,
    pub values: Vec<(String, OptValue)>,
}

impl Snapshot {
    pub fn find(&self, name: &str) -> Option<&OptionDesc> {
        self.options.iter().find(|o| o.name == name && o.active())
    }

    pub fn value(&self, name: &str) -> Option<&OptValue> {
        self.values.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }

    fn number(&self, name: &str) -> Option<f64> {
        match self.value(name) {
            Some(OptValue::Number(n)) => Some(*n),
            _ => None,
        }
    }

    fn string(&self, name: &str) -> Option<&str> {
        match self.value(name) {
            Some(OptValue::Text(s)) => Some(s),
            _ => None,
        }
    }
}

fn to_fixed(value: f64) -> Word {
    (value * 65536.0).round() as Word
}

fn from_fixed(value: Word) -> f64 {
    value as f64 / 65536.0
}

fn word_value(desc: &OptionDesc, raw: Word) -> f64 {
    if desc.kind == kind::FIXED {
        from_fixed(raw)
    } else {
        raw as f64
    }
}

fn copy_descriptor(raw: &RawOption, index: Word) -> OptionDesc {
    let constraint = unsafe {
        match raw.constraint_type {
            CONSTRAINT_RANGE if !raw.constraint.is_null() => {
                let r = &*(raw.constraint as *const RawRange);
                Constraint::Range {
                    min: r.min,
                    max: r.max,
                    quant: r.quant,
                }
            }
            CONSTRAINT_WORD_LIST if !raw.constraint.is_null() => {
                // The first word is the count of the words that follow.
                let words = raw.constraint as *const Word;
                let count = (*words).clamp(0, 4096) as usize;
                Constraint::Words((1..=count).map(|i| *words.add(i)).collect())
            }
            CONSTRAINT_STRING_LIST if !raw.constraint.is_null() => {
                let list = raw.constraint as *const *const c_char;
                let mut values = Vec::new();
                let mut at = 0;
                while at < 4096 {
                    let item = *list.add(at);
                    if item.is_null() {
                        break;
                    }
                    values.push(text(item));
                    at += 1;
                }
                Constraint::Strings(values)
            }
            _ => Constraint::None,
        }
    };
    OptionDesc {
        index,
        name: text(raw.name),
        title: text(raw.title),
        kind: raw.kind,
        unit: raw.unit,
        size: raw.size,
        cap: raw.cap,
        constraint,
    }
}

/// A device handle open in this host child. Every call through it is made
/// with the library lock held by the caller.
struct Device {
    lib: &'static Sane,
    handle: Handle,
}

unsafe impl Send for Device {}
unsafe impl Sync for Device {}

impl Device {
    fn descriptors(&self) -> Vec<OptionDesc> {
        let count_desc = unsafe { (self.lib.get_option_descriptor)(self.handle, 0) };
        if count_desc.is_null() {
            return Vec::new();
        }
        let mut count: Word = 0;
        let rc = unsafe {
            (self.lib.control_option)(
                self.handle,
                0,
                ACTION_GET,
                &mut count as *mut Word as *mut c_void,
                std::ptr::null_mut(),
            )
        };
        if rc != status::GOOD {
            return Vec::new();
        }
        (1..count.clamp(1, 4096))
            .filter_map(|index| {
                let raw = unsafe { (self.lib.get_option_descriptor)(self.handle, index) };
                (!raw.is_null()).then(|| copy_descriptor(unsafe { &*raw }, index))
            })
            .collect()
    }

    fn get(&self, desc: &OptionDesc) -> Option<OptValue> {
        if !desc.active() || desc.size <= 0 {
            return None;
        }
        let mut buf = vec![0u8; (desc.size as usize).max(std::mem::size_of::<Word>())];
        let rc = unsafe {
            (self.lib.control_option)(
                self.handle,
                desc.index,
                ACTION_GET,
                buf.as_mut_ptr() as *mut c_void,
                std::ptr::null_mut(),
            )
        };
        if rc != status::GOOD {
            return None;
        }
        let word = Word::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
        match desc.kind {
            kind::BOOL => Some(OptValue::Bool(word != 0)),
            kind::INT | kind::FIXED => Some(OptValue::Number(word_value(desc, word))),
            kind::STRING => {
                let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
                Some(OptValue::Text(String::from_utf8_lossy(&buf[..end]).into_owned()))
            }
            _ => None,
        }
    }

    fn snapshot(&self) -> Snapshot {
        let options = self.descriptors();
        let values = options
            .iter()
            .filter(|o| matches!(o.kind, kind::BOOL | kind::INT | kind::FIXED | kind::STRING))
            .filter_map(|o| self.get(o).map(|v| (o.name.clone(), v)))
            .collect();
        Snapshot { options, values }
    }

    /// Write one value. Returns the status and the info word.
    fn set(&self, desc: &OptionDesc, value: &OptValue) -> (i32, Word) {
        let mut info: Word = 0;
        let rc = match (desc.kind, value) {
            (kind::STRING, OptValue::Text(s)) => {
                let size = desc.size.max(1) as usize;
                if s.len() + 1 > size {
                    return (status::INVAL, 0);
                }
                let mut buf = vec![0u8; size];
                buf[..s.len()].copy_from_slice(s.as_bytes());
                unsafe {
                    (self.lib.control_option)(
                        self.handle,
                        desc.index,
                        ACTION_SET,
                        buf.as_mut_ptr() as *mut c_void,
                        &mut info,
                    )
                }
            }
            (kind::BOOL, OptValue::Bool(b)) => {
                let mut word: Word = Word::from(*b);
                unsafe {
                    (self.lib.control_option)(
                        self.handle,
                        desc.index,
                        ACTION_SET,
                        &mut word as *mut Word as *mut c_void,
                        &mut info,
                    )
                }
            }
            (kind::INT | kind::FIXED, OptValue::Number(n)) => {
                // A numeric option may be an array (a gamma table); a scalar
                // write fills only its first word, so arrays are not written.
                if desc.size as usize != std::mem::size_of::<Word>() {
                    return (status::INVAL, 0);
                }
                let mut word: Word = if desc.kind == kind::FIXED {
                    to_fixed(*n)
                } else {
                    n.round() as Word
                };
                unsafe {
                    (self.lib.control_option)(
                        self.handle,
                        desc.index,
                        ACTION_SET,
                        &mut word as *mut Word as *mut c_void,
                        &mut info,
                    )
                }
            }
            _ => status::INVAL,
        };
        (rc, info)
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        let _guard = hold();
        unsafe { (self.lib.close)(self.handle) };
    }
}

// ── The capability report (pure over a snapshot) ───────────────────────────

/// The colour mode a `mode` value means. Backends spell these differently
/// ("Color", "24bit Color", "Gray", "True Gray", "Lineart", "Binary").
pub(crate) fn color_mode_of(value: &str) -> Option<ColorMode> {
    let v = value.to_ascii_lowercase();
    if v.contains("color") || v.contains("colour") {
        Some(ColorMode::Color)
    } else if v.contains("gray") || v.contains("grey") {
        Some(ColorMode::Grayscale)
    } else if v.contains("lineart")
        || v.contains("binary")
        || v.contains("black")
        || v.contains("monochrome")
        || v.contains("threshold")
        || v == "bw"
    {
        Some(ColorMode::BlackAndWhite)
    } else {
        None
    }
}

/// The modes a device lists, each with the first value that means it, in
/// dialog order.
pub(crate) fn color_modes_of(values: &[String]) -> Vec<(ColorMode, String)> {
    let mut found: Vec<(ColorMode, String)> = Vec::new();
    for wanted in [ColorMode::BlackAndWhite, ColorMode::Grayscale, ColorMode::Color] {
        if let Some(value) = values.iter().find(|v| color_mode_of(v) == Some(wanted)) {
            found.push((wanted, value.clone()));
        }
    }
    found
}

/// What a `source` value names.
pub(crate) fn source_category(value: &str) -> SourceCategory {
    let v = value.to_ascii_lowercase();
    if v.contains("flatbed") || v.contains("platen") || v.contains("glass") {
        SourceCategory::Flatbed
    } else if v.contains("transparency") || v.contains("film") || v.contains("negative")
        || v.contains("slide") || v.contains("tpu")
    {
        SourceCategory::Film
    } else if v.contains("back") && !v.contains("duplex") {
        SourceCategory::FeederBack
    } else if v.contains("front") && !v.contains("duplex") {
        SourceCategory::FeederFront
    } else if v.contains("adf") || v.contains("feeder") || v.contains("duplex")
        || v.contains("document") || v.contains("sheet")
    {
        SourceCategory::Feeder
    } else if v.contains("auto") {
        SourceCategory::Auto
    } else {
        SourceCategory::Other
    }
}

/// A `source` value that feeds both sides of each sheet.
pub(crate) fn is_duplex_source(value: &str) -> bool {
    let v = value.to_ascii_lowercase();
    v.contains("duplex") || v.contains("both sides") || v.contains("double")
}

/// The written value of a duplex switch a backend offers beside its
/// sources: a `duplex` boolean, or an `adf-mode` list holding "Duplex".
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum DuplexSwitch {
    Boolean,
    Mode { on: String, off: String },
}

pub(crate) fn duplex_switch(snapshot: &Snapshot) -> Option<DuplexSwitch> {
    if snapshot
        .find("duplex")
        .is_some_and(|d| d.settable() && d.kind == kind::BOOL)
    {
        return Some(DuplexSwitch::Boolean);
    }
    let desc = snapshot.find("adf-mode").filter(|d| d.settable())?;
    let Constraint::Strings(values) = &desc.constraint else {
        return None;
    };
    let on = values.iter().find(|v| v.to_ascii_lowercase().contains("duplex"))?;
    let off = values.iter().find(|v| v.to_ascii_lowercase().contains("simplex"))?;
    Some(DuplexSwitch::Mode {
        on: on.clone(),
        off: off.clone(),
    })
}

/// The `document_handling` values a source row carries on this stack: the
/// duplex switch's position, where the device has a switch.
pub(crate) const DUPLEX_OFF: i32 = 0;
pub(crate) const DUPLEX_ON: i32 = 1;

/// The page-count control a source offers. A feeder runs until it empties
/// (`0`) or for a chosen count; the flatbed scans one page.
const MAX_FEEDER_PAGES: i32 = 10_000;

fn report_of(desc: &OptionDesc, current: Option<f64>) -> PropertyReport {
    let round = |raw: Word| word_value(desc, raw).round() as i32;
    let domain = match &desc.constraint {
        Constraint::Range { min, max, quant } => PropertyDomain::Range {
            min: round(*min),
            max: round(*max),
            step: if *quant > 0 { round(*quant).max(1) } else { 1 },
            nominal: None,
        },
        Constraint::Words(words) => PropertyDomain::List {
            values: words.iter().map(|w| round(*w)).collect(),
            nominal: None,
        },
        _ => PropertyDomain::None,
    };
    PropertyReport {
        id: desc.index as u32,
        name: if desc.title.is_empty() {
            desc.name.clone()
        } else {
            desc.title.clone()
        },
        readable: true,
        writable: desc.settable(),
        current: current.map(|v| v.round() as i32),
        domain,
    }
}

fn numeric_report(snapshot: &Snapshot, name: &str) -> Option<PropertyReport> {
    let desc = snapshot.find(name).filter(|d| d.numeric())?;
    Some(report_of(desc, snapshot.number(name)))
}

/// The resolution option: the well-known `resolution`, else the
/// `x-resolution` some backends use beside a `y-resolution`.
fn resolution_name(snapshot: &Snapshot) -> Option<&'static str> {
    ["resolution", "x-resolution"]
        .into_iter()
        .find(|n| snapshot.find(n).is_some_and(OptionDesc::numeric))
}

/// One source's report from the snapshot read while that source was
/// selected.
pub(crate) fn source_report(snapshot: &Snapshot, item_name: &str, category: SourceCategory, feeds: bool) -> ScanSourceReport {
    let resolution = resolution_name(snapshot).and_then(|n| numeric_report(snapshot, n));
    let brightness = numeric_report(snapshot, "brightness");
    let contrast = numeric_report(snapshot, "contrast");
    let modes: Vec<String> = match snapshot.find("mode").map(|d| &d.constraint) {
        Some(Constraint::Strings(values)) => values.clone(),
        _ => snapshot.string("mode").map(|s| vec![s.to_string()]).unwrap_or_default(),
    };
    let properties: Vec<PropertyReport> = [&resolution, &brightness, &contrast]
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    ScanSourceReport {
        item_name: item_name.to_string(),
        category,
        properties,
        resolution: control_model(resolution.as_ref()),
        optical_resolution: None,
        color_modes: color_modes_of(&modes).into_iter().map(|(m, _)| m).collect(),
        brightness: control_model(brightness.as_ref()),
        contrast: control_model(contrast.as_ref()),
        pages: if feeds {
            ControlModel::Span {
                min: 0,
                max: MAX_FEEDER_PAGES,
                step: 1,
                current: Some(0),
            }
        } else {
            ControlModel::Absent
        },
        document_handling_select: ControlModel::Absent,
    }
}

/// Whether a source feeds sheets.
fn source_feeds(category: SourceCategory, duplex: bool) -> bool {
    duplex
        || matches!(
            category,
            SourceCategory::Feeder | SourceCategory::FeederFront | SourceCategory::FeederBack
        )
}

/// The source picker rows and the handling summary, from the sources a
/// device lists and the duplex switch it offers.
pub(crate) fn plan_sources(
    sources: &[(String, SourceCategory, bool)],
    switch: Option<&DuplexSwitch>,
) -> (DocumentHandling, Vec<ScanSourceOption>) {
    let flatbed = sources.iter().find(|(_, c, d)| *c == SourceCategory::Flatbed && !d);
    let feeder = sources.iter().find(|(_, c, d)| {
        !d && matches!(c, SourceCategory::Feeder | SourceCategory::FeederFront)
    });
    let duplex_source = sources.iter().find(|(_, _, d)| *d);
    let switch_handling = |position: i32| switch.map(|_| position);
    let mut options = Vec::new();
    if let Some((name, _, _)) = flatbed {
        options.push(ScanSourceOption {
            id: SourceOptionId::Flatbed,
            item_name: name.clone(),
            document_handling: None,
            feeds: false,
        });
    }
    if let Some((name, _, _)) = feeder {
        options.push(ScanSourceOption {
            id: SourceOptionId::Feeder,
            item_name: name.clone(),
            document_handling: switch_handling(DUPLEX_OFF),
            feeds: true,
        });
    }
    let duplex_mode = if let Some((name, _, _)) = duplex_source {
        options.push(ScanSourceOption {
            id: SourceOptionId::Duplex,
            item_name: name.clone(),
            document_handling: None,
            feeds: true,
        });
        DuplexMode::FrontBackItems
    } else if let (Some((name, _, _)), Some(_)) = (feeder, switch) {
        options.push(ScanSourceOption {
            id: SourceOptionId::Duplex,
            item_name: name.clone(),
            document_handling: Some(DUPLEX_ON),
            feeds: true,
        });
        DuplexMode::DuplexBit
    } else {
        DuplexMode::None
    };
    if options.is_empty() {
        if let Some((name, category, duplex)) = sources.first() {
            let feeds = source_feeds(*category, *duplex);
            options.push(ScanSourceOption {
                id: if feeds {
                    SourceOptionId::Feeder
                } else {
                    SourceOptionId::Flatbed
                },
                item_name: name.clone(),
                document_handling: None,
                feeds,
            });
        }
    }
    let handling = DocumentHandling {
        capabilities: 0,
        flatbed: flatbed.is_some(),
        feeder: feeder.is_some() || duplex_source.is_some(),
        duplex: duplex_mode != DuplexMode::None,
        advanced_duplex: duplex_source.is_some(),
        duplex_mode,
        flatbed_select: DUPLEX_OFF,
        feeder_select: DUPLEX_OFF,
        duplex_select: DUPLEX_ON,
    };
    (handling, options)
}

// ── Sessions ────────────────────────────────────────────────────────────────

pub struct SaneSession {
    device: Mutex<Option<Device>>,
    native: String,
    /// The open handle, for `sane_cancel` from another thread.
    handle: AtomicUsize,
    cancel: AtomicBool,
    running: AtomicBool,
}

impl SaneSession {
    fn open(native: String) -> Result<Self, ScanRefusal> {
        let lib = sane()?;
        let Some(_guard) = try_hold() else {
            return Err(busy());
        };
        let name = CString::new(native.clone())
            .map_err(|_| ScanRefusal::named("scan.deviceGone", "The scanner is no longer connected."))?;
        let mut handle: Handle = std::ptr::null_mut();
        let rc = unsafe { (lib.open)(name.as_ptr(), &mut handle) };
        if rc != status::GOOD || handle.is_null() {
            return Err(refusal_for(if rc == status::GOOD { status::IO_ERROR } else { rc }, Phase::Open));
        }
        Ok(Self {
            device: Mutex::new(Some(Device { lib, handle })),
            native,
            handle: AtomicUsize::new(handle as usize),
            cancel: AtomicBool::new(false),
            running: AtomicBool::new(false),
        })
    }

    fn with_device<T>(&self, f: impl FnOnce(&Device) -> Result<T, ScanRefusal>) -> Result<T, ScanRefusal> {
        let device = self.device.lock().map_err(|_| busy())?;
        let device = device
            .as_ref()
            .ok_or_else(|| ScanRefusal::named("scan.deviceGone", "The scanner is no longer connected."))?;
        f(device)
    }

    fn report(&self, device: &Device) -> Result<ScannerCapabilities, ScanRefusal> {
        let initial = device.snapshot();
        let mut source_reports = Vec::new();
        let mut planned: Vec<(String, SourceCategory, bool)> = Vec::new();
        match initial.find("source").map(|d| (d.clone(), d.constraint.clone())) {
            Some((desc, Constraint::Strings(values))) if desc.settable() && !values.is_empty() => {
                let original = initial.string("source").map(str::to_string);
                for value in &values {
                    let category = source_category(value);
                    let duplex = is_duplex_source(value);
                    let (rc, _) = device.set(&desc, &OptValue::Text(value.clone()));
                    let snapshot = if rc == status::GOOD { device.snapshot() } else { initial.clone() };
                    source_reports.push(source_report(&snapshot, value, category, source_feeds(category, duplex)));
                    planned.push((value.clone(), category, duplex));
                }
                if let Some(original) = original {
                    let reread = device.snapshot();
                    if let Some(desc) = reread.find("source") {
                        let _ = device.set(desc, &OptValue::Text(original));
                    }
                }
            }
            _ => {
                let name = initial.string("source").unwrap_or("").to_string();
                let category = if name.is_empty() { SourceCategory::Flatbed } else { source_category(&name) };
                let duplex = is_duplex_source(&name);
                source_reports.push(source_report(&initial, &name, category, source_feeds(category, duplex)));
                planned.push((name, category, duplex));
            }
        }
        let switch = duplex_switch(&device.snapshot());
        let (handling, options) = plan_sources(&planned, switch.as_ref());
        let device_name = last_listing()
            .lock()
            .ok()
            .and_then(|list| list.iter().find(|d| d.id == self.native).map(|d| d.name.clone()))
            .unwrap_or_else(|| self.native.clone());
        Ok(ScannerCapabilities {
            device_id: self.native.clone(),
            device_name,
            document_handling: handling,
            source_options: options,
            max_scan_time_ms: None,
            sources: source_reports,
        })
    }
}

impl ScanSession for SaneSession {
    fn capabilities(&self) -> Result<ScannerCapabilities, ScanRefusal> {
        let Some(_guard) = try_hold() else {
            return Err(busy());
        };
        self.with_device(|device| self.report(device))
    }

    fn acquire(&self, settings: ScanSettings, dir: PathBuf, sink: EventSink) -> Result<ScanResult, ScanRefusal> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(busy());
        }
        let _guard = hold();
        ACQUIRING.store(true, Ordering::SeqCst);
        self.cancel.store(false, Ordering::SeqCst);
        let outcome = self.with_device(|device| run(device, &settings, &dir, &sink, &self.cancel));
        ACQUIRING.store(false, Ordering::SeqCst);
        self.running.store(false, Ordering::SeqCst);
        outcome
    }

    fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if self.running.load(Ordering::SeqCst) {
            if let Ok(lib) = sane() {
                let handle = self.handle.load(Ordering::SeqCst) as Handle;
                if !handle.is_null() {
                    unsafe { (lib.cancel)(handle) };
                }
            }
        }
    }
}

// ── Settings ────────────────────────────────────────────────────────────────

/// One option write and what the device made of it.
struct Writer<'a> {
    device: &'a Device,
    snapshot: Snapshot,
    adjusted: Vec<PropertyAdjustment>,
}

impl Writer<'_> {
    fn write(&mut self, name: &str, value: OptValue) -> Option<i32> {
        let desc = self.snapshot.find(name).filter(|d| d.settable())?.clone();
        let (rc, info) = self.device.set(&desc, &value);
        if info & INFO_RELOAD_OPTIONS != 0 {
            self.snapshot = self.device.snapshot();
        } else if let Some(read) = self.device.get(&desc) {
            // Read back every write: the inexact flag is the backend's own
            // report, and a backend that clamps without setting it still
            // shows the clamped value here.
            match self.snapshot.values.iter_mut().find(|(n, _)| *n == desc.name) {
                Some((_, slot)) => *slot = read,
                None => self.snapshot.values.push((desc.name.clone(), read)),
            }
        }
        if let OptValue::Number(requested) = value {
            let actual = (rc == status::GOOD).then(|| self.snapshot.number(name)).flatten();
            let requested_i = requested.round() as i32;
            let actual_i = actual.map(|a| a.round() as i32);
            if actual_i != Some(requested_i) {
                self.adjusted.push(PropertyAdjustment {
                    property: if desc.title.is_empty() { desc.name.clone() } else { desc.title.clone() },
                    requested: requested_i,
                    actual: actual_i,
                });
            }
        }
        Some(rc)
    }
}

/// The scan area for a paper at a resolution, in the area options' own
/// units, clamped to the bed.
pub(crate) fn area_values(paper: PaperSize, dpi: f64, snapshot: &Snapshot) -> Option<[(&'static str, f64); 4]> {
    let tl_x = snapshot.find("tl-x")?;
    let tl_y = snapshot.find("tl-y")?;
    let br_x = snapshot.find("br-x")?;
    let br_y = snapshot.find("br-y")?;
    let bounds = |desc: &OptionDesc| match desc.constraint {
        Constraint::Range { min, max, .. } => Some((word_value(desc, min), word_value(desc, max))),
        _ => None,
    };
    let (x0, _) = bounds(tl_x)?;
    let (y0, _) = bounds(tl_y)?;
    let (_, x1) = bounds(br_x)?;
    let (_, y1) = bounds(br_y)?;
    let Some((w_in, h_in)) = paper.dimensions_in() else {
        return Some([("tl-x", x0), ("tl-y", y0), ("br-x", x1), ("br-y", y1)]);
    };
    let scale = match br_x.unit {
        unit::MM => 25.4,
        unit::PIXEL if dpi > 0.0 => dpi,
        _ => return None,
    };
    Some([
        ("tl-x", x0),
        ("tl-y", y0),
        ("br-x", (x0 + w_in * scale).min(x1)),
        ("br-y", (y0 + h_in * scale).min(y1)),
    ])
}

fn apply<'d>(device: &'d Device, settings: &ScanSettings) -> Writer<'d> {
    let mut w = Writer {
        device,
        snapshot: device.snapshot(),
        adjusted: Vec::new(),
    };
    if let Some(source) = &settings.item_name {
        let listed = matches!(
            w.snapshot.find("source").map(|d| &d.constraint),
            Some(Constraint::Strings(values)) if values.contains(source)
        );
        if listed {
            w.write("source", OptValue::Text(source.clone()));
        }
    }
    if let Some(mode) = settings.color_mode {
        let values = match w.snapshot.find("mode").map(|d| &d.constraint) {
            Some(Constraint::Strings(values)) => values.clone(),
            _ => Vec::new(),
        };
        if let Some((_, value)) = color_modes_of(&values).into_iter().find(|(m, _)| *m == mode) {
            w.write("mode", OptValue::Text(value));
        }
    }
    if let Some(dpi) = settings.dpi {
        if let Some(name) = resolution_name(&w.snapshot) {
            w.write(name, OptValue::Number(dpi as f64));
            if name == "x-resolution" {
                w.write("y-resolution", OptValue::Number(dpi as f64));
            }
        }
    }
    let dpi = resolution_name(&w.snapshot)
        .and_then(|n| w.snapshot.number(n))
        .unwrap_or(0.0);
    if let Some(values) = area_values(settings.paper.unwrap_or(PaperSize::Auto), dpi, &w.snapshot) {
        // Top-left first, so the bottom-right is never written left of it.
        for (name, value) in values {
            let desc = w.snapshot.find(name).cloned();
            if let Some(desc) = desc.filter(OptionDesc::settable) {
                let _ = w.device.set(&desc, &OptValue::Number(value));
            }
        }
        w.snapshot = w.device.snapshot();
    }
    if let Some(level) = settings.brightness {
        w.write("brightness", OptValue::Number(level as f64));
    }
    if let Some(level) = settings.contrast {
        w.write("contrast", OptValue::Number(level as f64));
    }
    if let Some(position) = settings.document_handling {
        match duplex_switch(&w.snapshot) {
            Some(DuplexSwitch::Boolean) => {
                w.write("duplex", OptValue::Bool(position == DUPLEX_ON));
            }
            Some(DuplexSwitch::Mode { on, off }) => {
                w.write("adf-mode", OptValue::Text(if position == DUPLEX_ON { on } else { off }));
            }
            None => {}
        }
    }
    w
}

// ── The page writer ─────────────────────────────────────────────────────────

/// Writes one scanned page as an uncompressed top-down BMP while the frame
/// arrives, so a page of unknown length never sits in memory. BMP because its
/// header carries pixels per metre, which is what keeps the resolution
/// through `create_pdf`'s page sizing, and because the shared page-integrity
/// check reads its declared length.
pub(crate) struct PageWriter {
    out: BufWriter<File>,
    width: u32,
    bits: u16,
    stride: usize,
    rows: u32,
    bytes: u64,
}

const BMP_HEADER: u32 = 14 + 40;

impl PageWriter {
    pub fn create(path: &Path, width: u32, bits: u16, dpi: f64) -> std::io::Result<Self> {
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
        let mut out = BufWriter::new(file);
        let palette = match bits {
            1 => 2u32,
            8 => 256,
            _ => 0,
        };
        let offset = BMP_HEADER + palette * 4;
        let ppm = (dpi / 0.0254).round().clamp(0.0, i32::MAX as f64) as i32;
        let mut head = Vec::with_capacity(offset as usize);
        head.extend_from_slice(b"BM");
        head.extend_from_slice(&0u32.to_le_bytes());
        head.extend_from_slice(&0u32.to_le_bytes());
        head.extend_from_slice(&offset.to_le_bytes());
        head.extend_from_slice(&40u32.to_le_bytes());
        head.extend_from_slice(&(width as i32).to_le_bytes());
        head.extend_from_slice(&0i32.to_le_bytes());
        head.extend_from_slice(&1u16.to_le_bytes());
        head.extend_from_slice(&bits.to_le_bytes());
        head.extend_from_slice(&0u32.to_le_bytes());
        head.extend_from_slice(&0u32.to_le_bytes());
        head.extend_from_slice(&ppm.to_le_bytes());
        head.extend_from_slice(&ppm.to_le_bytes());
        head.extend_from_slice(&palette.to_le_bytes());
        head.extend_from_slice(&0u32.to_le_bytes());
        match bits {
            // SANE: a set bit is black (standard section 3.2); palette entry
            // 1 is black so the bits are written as they arrive.
            1 => {
                head.extend_from_slice(&[255, 255, 255, 0]);
                head.extend_from_slice(&[0, 0, 0, 0]);
            }
            8 => {
                for level in 0..=255u8 {
                    head.extend_from_slice(&[level, level, level, 0]);
                }
            }
            _ => {}
        }
        out.write_all(&head)?;
        let row_bits = width as usize * bits as usize;
        let stride = row_bits.div_ceil(32) * 4;
        Ok(Self {
            out,
            width,
            bits,
            stride,
            rows: 0,
            bytes: offset as u64,
        })
    }

    /// One row in BMP sample order (palette index, or blue-green-red).
    pub fn row(&mut self, samples: &[u8]) -> std::io::Result<()> {
        let used = (self.width as usize * self.bits as usize).div_ceil(8);
        let mut padded = vec![0u8; self.stride];
        let n = used.min(samples.len());
        padded[..n].copy_from_slice(&samples[..n]);
        self.out.write_all(&padded)?;
        self.rows += 1;
        self.bytes += self.stride as u64;
        Ok(())
    }

    /// Patch the sizes and the height now that the row count is known.
    pub fn finish(self) -> std::io::Result<u64> {
        let PageWriter { out, rows, stride, bytes, .. } = self;
        let mut file = out.into_inner().map_err(|e| e.into_error())?;
        let image = stride as u64 * rows as u64;
        let total = u32::try_from(bytes).unwrap_or(u32::MAX);
        file.seek(SeekFrom::Start(2))?;
        file.write_all(&total.to_le_bytes())?;
        file.seek(SeekFrom::Start(22))?;
        // A negative height is a top-down image: rows were written first to
        // last as the scanner sent them.
        file.write_all(&(-(rows as i32)).to_le_bytes())?;
        file.seek(SeekFrom::Start(34))?;
        file.write_all(&u32::try_from(image).unwrap_or(u32::MAX).to_le_bytes())?;
        file.sync_all()?;
        Ok(bytes)
    }
}

/// One SANE frame row as BMP samples. `planes` are earlier single-channel
/// frames of a three-pass colour page.
pub(crate) fn convert_row(params: &RawParametersView, raw: &[u8]) -> Vec<u8> {
    let width = params.pixels as usize;
    let sample = |row: &[u8], i: usize| -> u8 {
        match params.depth {
            16 => {
                let at = i * 2;
                let v = u16::from_ne_bytes([row[at], row[at + 1]]);
                (v >> 8) as u8
            }
            8 => row[i],
            _ => {
                // Depth 1 in a colour or single-channel frame: a set bit is
                // full intensity (only grey frames invert, standard 3.2).
                let bit = (row[i / 8] >> (7 - (i % 8))) & 1;
                if bit == 1 { 255 } else { 0 }
            }
        }
    };
    match params.format {
        frame::GRAY if params.depth == 1 => raw[..width.div_ceil(8).min(raw.len())].to_vec(),
        frame::GRAY => (0..width).map(|i| sample(raw, i)).collect(),
        frame::RGB => {
            let mut out = Vec::with_capacity(width * 3);
            for x in 0..width {
                let r = sample(raw, x * 3);
                let g = sample(raw, x * 3 + 1);
                let b = sample(raw, x * 3 + 2);
                out.extend_from_slice(&[b, g, r]);
            }
            out
        }
        _ => (0..width).map(|i| sample(raw, i)).collect(),
    }
}

/// The parts of `SANE_Parameters` the conversion reads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RawParametersView {
    pub format: i32,
    pub depth: i32,
    pub pixels: i32,
}

/// The minimum bytes one row of a frame carries.
pub(crate) fn row_bytes(view: &RawParametersView) -> usize {
    let channels = if view.format == frame::RGB { 3 } else { 1 };
    (view.pixels as usize * channels * view.depth.max(1) as usize).div_ceil(8)
}

// ── Acquisition ─────────────────────────────────────────────────────────────

enum PageEnd {
    Done(PathBuf, u64),
    Cancelled,
    Failed(ScanRefusal),
    Empty,
}

fn page_path(dir: &Path, index: u32) -> PathBuf {
    dir.join(format!("page-{:04}.bmp", index + 1))
}

fn unwritable(e: std::io::Error) -> ScanRefusal {
    ScanRefusal {
        key: "scan.failed",
        message: format!("The scanned page could not be written: {e}"),
        code: None,
        folder: None,
    }
}

fn params_of(device: &Device) -> Result<RawParameters, i32> {
    let mut params = RawParameters::default();
    let rc = unsafe { (device.lib.get_parameters)(device.handle, &mut params) };
    if rc != status::GOOD {
        return Err(rc);
    }
    Ok(params)
}

/// Read one frame's rows, handing each complete row to `row`.
fn read_frame(
    device: &Device,
    params: &RawParameters,
    cancel: &AtomicBool,
    mut row: impl FnMut(&[u8]) -> std::io::Result<()>,
    mut progress: impl FnMut(u64),
) -> Result<bool, (i32, Option<std::io::Error>)> {
    let line = params.bytes_per_line.max(0) as usize;
    if line == 0 || params.pixels_per_line <= 0 {
        return Err((status::IO_ERROR, None));
    }
    let mut buf = vec![0u8; 64 * 1024];
    let mut pending: Vec<u8> = Vec::with_capacity(line);
    let mut total = 0u64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let mut got: Word = 0;
        let rc = unsafe { (device.lib.read)(device.handle, buf.as_mut_ptr(), buf.len() as Word, &mut got) };
        match rc {
            status::GOOD => {}
            status::EOF => return Ok(true),
            status::CANCELLED if cancel.load(Ordering::SeqCst) => return Ok(false),
            other => return Err((other, None)),
        }
        let mut chunk = &buf[..got.clamp(0, buf.len() as Word) as usize];
        total += chunk.len() as u64;
        progress(total);
        while !chunk.is_empty() {
            let take = (line - pending.len()).min(chunk.len());
            pending.extend_from_slice(&chunk[..take]);
            chunk = &chunk[take..];
            if pending.len() == line {
                row(&pending).map_err(|e| (status::IO_ERROR, Some(e)))?;
                pending.clear();
            }
        }
    }
}

/// One page: every frame of it, written to `path`.
fn scan_page(
    device: &Device,
    path: &Path,
    dpi: f64,
    index: u32,
    sink: &EventSink,
    cancel: &AtomicBool,
) -> PageEnd {
    let mut writer: Option<PageWriter> = None;
    let mut planes: Vec<Vec<Vec<u8>>> = Vec::new();
    let mut plane_view: Option<RawParametersView> = None;
    let mut first = true;
    loop {
        if !first {
            let rc = unsafe { (device.lib.start)(device.handle) };
            if rc != status::GOOD {
                return PageEnd::Failed(refusal_for(rc, Phase::Transfer));
            }
        }
        first = false;
        let params = match params_of(device) {
            Ok(p) => p,
            Err(rc) => return PageEnd::Failed(refusal_for(rc, Phase::Transfer)),
        };
        let view = RawParametersView {
            format: params.format,
            depth: params.depth,
            pixels: params.pixels_per_line,
        };
        if !matches!(params.depth, 1 | 8 | 16) || row_bytes(&view) > params.bytes_per_line.max(0) as usize {
            return PageEnd::Failed(ScanRefusal::named(
                "scan.driverError",
                "The scanner driver reported a problem.",
            ));
        }
        let expected = if params.lines > 0 {
            params.bytes_per_line as u64 * params.lines as u64
        } else {
            0
        };
        let mut last_percent = u32::MAX;
        let mut progress = |read: u64| {
            if expected > 0 {
                let percent = ((read.saturating_mul(100)) / expected).min(100) as u32;
                if percent != last_percent {
                    last_percent = percent;
                    sink(ScanEvent::Progress { index, percent });
                }
            }
        };
        let finished = match params.format {
            frame::GRAY | frame::RGB => {
                if writer.is_none() {
                    let bits = match (params.format, params.depth) {
                        (frame::GRAY, 1) => 1,
                        (frame::GRAY, _) => 8,
                        _ => 24,
                    };
                    match PageWriter::create(path, params.pixels_per_line as u32, bits, dpi) {
                        Ok(w) => writer = Some(w),
                        Err(e) => return PageEnd::Failed(unwritable(e)),
                    }
                }
                let w = writer.as_mut().expect("writer was just created");
                read_frame(device, &params, cancel, |raw| w.row(&convert_row(&view, raw)), &mut progress)
            }
            frame::RED | frame::GREEN | frame::BLUE => {
                plane_view = Some(view);
                let mut plane = Vec::new();
                let result = read_frame(
                    device,
                    &params,
                    cancel,
                    |raw| {
                        plane.push(convert_row(&view, raw));
                        Ok(())
                    },
                    &mut progress,
                );
                planes.push(plane);
                result
            }
            _ => {
                return PageEnd::Failed(ScanRefusal::named(
                    "scan.driverError",
                    "The scanner driver reported a problem.",
                ))
            }
        };
        match finished {
            Ok(true) => {}
            Ok(false) => {
                drop(writer);
                let _ = std::fs::remove_file(path);
                return PageEnd::Cancelled;
            }
            Err((rc, io)) => {
                drop(writer);
                let _ = std::fs::remove_file(path);
                return PageEnd::Failed(match io {
                    Some(e) => unwritable(e),
                    None => refusal_for(rc, Phase::Transfer),
                });
            }
        }
        if params.last_frame != 0 {
            break;
        }
    }
    if !planes.is_empty() {
        let view = plane_view.expect("a plane carries its parameters");
        if planes.len() != 3 {
            return PageEnd::Failed(ScanRefusal::named(
                "scan.driverError",
                "The scanner driver reported a problem.",
            ));
        }
        let rows = planes.iter().map(Vec::len).min().unwrap_or(0);
        let mut w = match PageWriter::create(path, view.pixels as u32, 24, dpi) {
            Ok(w) => w,
            Err(e) => return PageEnd::Failed(unwritable(e)),
        };
        for y in 0..rows {
            let mut out = Vec::with_capacity(view.pixels as usize * 3);
            for x in 0..view.pixels as usize {
                out.extend_from_slice(&[planes[2][y][x], planes[1][y][x], planes[0][y][x]]);
            }
            if let Err(e) = w.row(&out) {
                return PageEnd::Failed(unwritable(e));
            }
        }
        writer = Some(w);
    }
    match writer {
        Some(w) if w.rows > 0 => match w.finish() {
            Ok(bytes) => PageEnd::Done(path.to_path_buf(), bytes),
            Err(e) => PageEnd::Failed(unwritable(e)),
        },
        Some(w) => {
            drop(w);
            let _ = std::fs::remove_file(path);
            PageEnd::Empty
        }
        None => PageEnd::Empty,
    }
}

fn run(
    device: &Device,
    settings: &ScanSettings,
    dir: &Path,
    sink: &EventSink,
    cancel: &AtomicBool,
) -> Result<ScanResult, ScanRefusal> {
    let applied = apply(device, settings);
    let snapshot = applied.snapshot.clone();
    let adjusted = applied.adjusted;
    let dpi = resolution_name(&snapshot)
        .and_then(|n| snapshot.number(n))
        .unwrap_or(0.0);
    let source = snapshot.string("source").unwrap_or("").to_string();
    let feeds_sheets = settings.document_handling == Some(DUPLEX_ON)
        || source_feeds(source_category(&source), is_duplex_source(&source));
    let limit = if feeds_sheets {
        settings.pages.filter(|p| *p > 0).map(|p| p as u32)
    } else {
        Some(1)
    };
    let mut pages: Vec<String> = Vec::new();
    let mut bytes = 0u64;
    let mut warned = false;
    let mut cancelled = false;
    let mut interrupted: Option<ScanRefusal> = None;
    let mut index = 0u32;
    loop {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        let rc = unsafe { (device.lib.start)(device.handle) };
        if rc == status::NO_DOCS && index > 0 {
            break;
        }
        if rc == status::CANCELLED && cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        if rc != status::GOOD {
            let refusal = refusal_for(rc, Phase::Transfer);
            unsafe { (device.lib.cancel)(device.handle) };
            if pages.is_empty() {
                return Err(refusal);
            }
            interrupted = Some(refusal);
            break;
        }
        sink(ScanEvent::PageStarted { index });
        let path = page_path(dir, index);
        match scan_page(device, &path, dpi, index, sink, cancel) {
            PageEnd::Done(path, size) => {
                bytes += size;
                let shown = path.to_string_lossy().into_owned();
                sink(ScanEvent::PageFinished { index, path: shown.clone() });
                pages.push(shown);
                if !warned && bytes > SCAN_SIZE_WARN_BYTES {
                    warned = true;
                    sink(ScanEvent::SizeWarning { bytes });
                }
            }
            PageEnd::Cancelled => {
                cancelled = true;
                break;
            }
            PageEnd::Empty => break,
            PageEnd::Failed(refusal) => {
                unsafe { (device.lib.cancel)(device.handle) };
                if pages.is_empty() {
                    return Err(refusal);
                }
                interrupted = Some(refusal);
                break;
            }
        }
        index += 1;
        if limit.is_some_and(|l| index >= l) {
            break;
        }
    }
    // Ends the batch: the standard requires `sane_cancel` after the last
    // frame, and a feeder keeps its state until it is called.
    unsafe { (device.lib.cancel)(device.handle) };
    Ok(ScanResult {
        pages,
        cancelled,
        interrupted,
        scratch: dir.to_string_lossy().into_owned(),
        dpi: dpi.round() as i32,
        adjusted,
        bytes,
    })
}

// ── The backend seam ────────────────────────────────────────────────────────

/// The SANE stack — the only backend the Linux build carries.
pub struct SaneBackend;

static SANE_BACKEND: SaneBackend = SaneBackend;

impl ScanBackend for SaneBackend {
    fn stack(&self) -> ScanStack {
        ScanStack::Sane
    }

    fn enumerate(&self) -> Result<Vec<ScannerDevice>, ScanRefusal> {
        if crate::scan_host::is_host_child() {
            sane_enumerate()
        } else {
            crate::scan_host::enumerate()
        }
    }

    fn open(&self, native_id: &str) -> Result<Arc<dyn ScanSession>, ScanRefusal> {
        if crate::scan_host::is_host_child() {
            Ok(Arc::new(SaneSession::open(native_id.to_string())?))
        } else {
            crate::scan_host::open(native_id)
        }
    }

    fn select_device_dialog(&self, _parent: usize) -> Result<Option<String>, ScanRefusal> {
        Ok(None)
    }
}

/// Every stack this build carries, in the order their devices are offered.
pub fn backends() -> &'static [&'static dyn ScanBackend] {
    static ALL: [&dyn ScanBackend; 1] = [&SANE_BACKEND];
    &ALL
}

pub(crate) fn backend_for(stack: ScanStack) -> &'static dyn ScanBackend {
    backends()
        .iter()
        .copied()
        .find(|backend| backend.stack() == stack)
        .expect("every stack in ScanStack has a backend")
}

/// SANE has no system picker; the door answers "nothing chosen".
pub fn select_device_dialog(_parent: usize) -> Result<Option<String>, ScanRefusal> {
    Ok(None)
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_scanners(last_used: Option<String>) -> Result<ScannerList, ScanRefusal> {
    enumerate(last_used)
}

#[tauri::command]
pub async fn scanner_capabilities(
    sessions: tauri::State<'_, ScannerSessions>,
    device_id: String,
) -> Result<ScannerCapabilities, ScanRefusal> {
    sessions.capabilities(&device_id)
}

#[tauri::command]
pub async fn scanner_close(
    sessions: tauri::State<'_, ScannerSessions>,
    device_id: String,
) -> Result<(), ScanRefusal> {
    sessions.close(&device_id);
    Ok(())
}

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
    let barren = match &outcome {
        Ok(result) => result.pages.is_empty(),
        Err(_) => true,
    };
    if barren {
        let _ = discard_scan_scratch(&dir);
    }
    outcome
}

#[tauri::command]
pub async fn scan_cancel(
    sessions: tauri::State<'_, ScannerSessions>,
    device_id: String,
) -> Result<(), ScanRefusal> {
    sessions.cancel(&device_id);
    Ok(())
}

#[tauri::command]
pub async fn scan_discard(scratch: String) -> Result<(), ScanRefusal> {
    discard_scan_scratch(Path::new(&scratch))
}

#[tauri::command]
pub async fn scanner_select_dialog(
    window: tauri::WebviewWindow,
) -> Result<Option<String>, ScanRefusal> {
    let _ = window;
    select_device_dialog(0)
}

#[cfg(test)]
#[path = "scanner_sane_tests.rs"]
mod tests;
