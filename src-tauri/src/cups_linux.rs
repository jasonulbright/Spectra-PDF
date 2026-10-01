//! The system's CUPS client library, loaded at run time.
//!
//! CUPS is user-supplied: `libcups.so.2` is opened with `dlopen` when a print
//! surface first needs it and is never bundled. A system without it refuses
//! by name. Every call goes through the destination API the CUPS Programming
//! Manual documents (`cupsGetDests2`, `cupsCopyDestInfo`,
//! `cupsGetDestMediaByIndex`, `cupsCheckDestSupported`); no command-line tool
//! is parsed, so the answer does not depend on the session's locale.
//!
//! Only the documented ABI of `libcups.so.2` is declared here. The
//! `cups_dest_t`, `cups_option_t` and `cups_size_t` layouts are the public
//! structures of `<cups/cups.h>`.

use std::ffi::{c_char, c_int, c_uint, c_void, CStr, CString};
use std::sync::OnceLock;

/// The SONAME the CUPS 2.x client library carries on every distribution.
pub const LIBRARY: &str = "libcups.so.2";

#[repr(C)]
pub struct CupsOption {
    pub name: *mut c_char,
    pub value: *mut c_char,
}

#[repr(C)]
pub struct CupsDest {
    pub name: *mut c_char,
    pub instance: *mut c_char,
    pub is_default: c_int,
    pub num_options: c_int,
    pub options: *mut CupsOption,
}

/// `cups_size_t`: dimensions and margins in hundredths of millimetres.
#[repr(C)]
pub struct CupsSize {
    pub media: [c_char; 128],
    pub width: c_int,
    pub length: c_int,
    pub bottom: c_int,
    pub left: c_int,
    pub right: c_int,
    pub top: c_int,
}

impl CupsSize {
    pub fn zeroed() -> Self {
        Self {
            media: [0; 128],
            width: 0,
            length: 0,
            bottom: 0,
            left: 0,
            right: 0,
            top: 0,
        }
    }

    pub fn media(&self) -> String {
        let bytes: Vec<u8> = self
            .media
            .iter()
            .take_while(|&&c| c != 0)
            .map(|&c| c as u8)
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// `CUPS_MEDIA_FLAGS_DEFAULT`.
pub const MEDIA_FLAGS_DEFAULT: c_uint = 0;
/// `CUPS_HTTP_DEFAULT`: libcups's own connection to the default scheduler.
pub const HTTP_DEFAULT: *mut c_void = std::ptr::null_mut();
/// The last successful IPP status; anything above is a failure.
const IPP_STATUS_OK_MAX: c_int = 0x00FF;

type GetDests2 = unsafe extern "C" fn(*mut c_void, *mut *mut CupsDest) -> c_int;
type FreeDests = unsafe extern "C" fn(c_int, *mut CupsDest);
type GetOption = unsafe extern "C" fn(*const c_char, c_int, *mut CupsOption) -> *const c_char;
type CopyDestInfo = unsafe extern "C" fn(*mut c_void, *mut CupsDest) -> *mut c_void;
type FreeDestInfo = unsafe extern "C" fn(*mut c_void);
type CheckDestSupported =
    unsafe extern "C" fn(*mut c_void, *mut CupsDest, *mut c_void, *const c_char, *const c_char) -> c_int;
type FindDestSupported =
    unsafe extern "C" fn(*mut c_void, *mut CupsDest, *mut c_void, *const c_char) -> *mut c_void;
type GetDestMediaCount = unsafe extern "C" fn(*mut c_void, *mut CupsDest, *mut c_void, c_uint) -> c_int;
type GetDestMediaByIndex =
    unsafe extern "C" fn(*mut c_void, *mut CupsDest, *mut c_void, c_int, c_uint, *mut CupsSize) -> c_int;
type GetDestMediaDefault =
    unsafe extern "C" fn(*mut c_void, *mut CupsDest, *mut c_void, c_uint, *mut CupsSize) -> c_int;
type LocalizeDestMedia =
    unsafe extern "C" fn(*mut c_void, *mut CupsDest, *mut c_void, c_uint, *mut CupsSize) -> *const c_char;
type IppGetRange = unsafe extern "C" fn(*mut c_void, c_int, *mut c_int) -> c_int;
type IppGetCount = unsafe extern "C" fn(*mut c_void) -> c_int;
type LastError = unsafe extern "C" fn() -> c_int;
type LastErrorString = unsafe extern "C" fn() -> *const c_char;
type GetDestWithUri = unsafe extern "C" fn(*const c_char, *const c_char) -> *mut CupsDest;
type ConnectDest = unsafe extern "C" fn(
    *mut CupsDest,
    c_uint,
    c_int,
    *mut c_int,
    *mut c_char,
    usize,
    *mut c_void,
    *mut c_void,
) -> *mut c_void;
type HttpClose = unsafe extern "C" fn(*mut c_void);
type PwgMediaForSize = unsafe extern "C" fn(c_int, c_int) -> *const PwgMedia;

/// `pwg_media_t`: one standard size's names and dimensions.
#[repr(C)]
pub struct PwgMedia {
    pub pwg: *const c_char,
    pub legacy: *const c_char,
    pub ppd: *const c_char,
    pub width: c_int,
    pub length: c_int,
}

/// `CUPS_DEST_FLAGS_NONE`: connect to the scheduler that owns the queue.
const DEST_FLAGS_NONE: c_uint = 0;
const CONNECT_TIMEOUT_MS: c_int = 30_000;

/// The resolved entry points. The library handle is never closed: the
/// function pointers live for the process.
pub struct Cups {
    #[cfg_attr(not(test), allow(dead_code))]
    handle: *mut c_void,
    get_dests2: GetDests2,
    free_dests: FreeDests,
    get_option: GetOption,
    copy_dest_info: CopyDestInfo,
    free_dest_info: FreeDestInfo,
    check_dest_supported: CheckDestSupported,
    find_dest_supported: FindDestSupported,
    get_dest_media_count: GetDestMediaCount,
    get_dest_media_by_index: GetDestMediaByIndex,
    get_dest_media_default: GetDestMediaDefault,
    localize_dest_media: LocalizeDestMedia,
    ipp_get_range: IppGetRange,
    ipp_get_count: IppGetCount,
    last_error: LastError,
    last_error_string: LastErrorString,
    #[cfg_attr(not(test), allow(dead_code))]
    get_dest_with_uri: GetDestWithUri,
    connect_dest: ConnectDest,
    http_close: HttpClose,
    pwg_media_for_size: PwgMediaForSize,
}

// The handle and the function pointers are process-global and immutable once
// resolved; libcups keeps its per-call state in thread-local storage.
unsafe impl Send for Cups {}
unsafe impl Sync for Cups {}

/// The refusal for a system without the CUPS client library.
pub fn missing_library() -> String {
    format!("System printing needs CUPS ({LIBRARY}), which is not installed on this system.")
}

/// The loaded library, or the refusal naming what is missing.
pub fn cups() -> Result<&'static Cups, String> {
    static LOADED: OnceLock<Result<Cups, String>> = OnceLock::new();
    LOADED.get_or_init(load).as_ref().map_err(Clone::clone)
}

fn load() -> Result<Cups, String> {
    let name = CString::new(LIBRARY).expect("library name has no NUL");
    let handle = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
    if handle.is_null() {
        return Err(missing_library());
    }
    macro_rules! sym {
        ($name:literal) => {{
            let symbol = CString::new($name).expect("symbol name has no NUL");
            let found = unsafe { libc::dlsym(handle, symbol.as_ptr()) };
            if found.is_null() {
                return Err(format!(
                    "The installed CUPS library ({LIBRARY}) has no {}; it is too old for printing.",
                    $name
                ));
            }
            unsafe { std::mem::transmute::<*mut c_void, _>(found) }
        }};
    }
    Ok(Cups {
        handle,
        get_dests2: sym!("cupsGetDests2"),
        free_dests: sym!("cupsFreeDests"),
        get_option: sym!("cupsGetOption"),
        copy_dest_info: sym!("cupsCopyDestInfo"),
        free_dest_info: sym!("cupsFreeDestInfo"),
        check_dest_supported: sym!("cupsCheckDestSupported"),
        find_dest_supported: sym!("cupsFindDestSupported"),
        get_dest_media_count: sym!("cupsGetDestMediaCount"),
        get_dest_media_by_index: sym!("cupsGetDestMediaByIndex"),
        get_dest_media_default: sym!("cupsGetDestMediaDefault"),
        localize_dest_media: sym!("cupsLocalizeDestMedia"),
        ipp_get_range: sym!("ippGetRange"),
        ipp_get_count: sym!("ippGetCount"),
        last_error: sym!("cupsLastError"),
        last_error_string: sym!("cupsLastErrorString"),
        get_dest_with_uri: sym!("cupsGetDestWithURI"),
        connect_dest: sym!("cupsConnectDest"),
        http_close: sym!("httpClose"),
        pwg_media_for_size: sym!("pwgMediaForSize"),
    })
}

fn owned(text: *const c_char) -> Option<String> {
    if text.is_null() {
        return None;
    }
    Some(unsafe { CStr::from_ptr(text) }.to_string_lossy().into_owned())
}

impl Cups {
    /// The raw library handle, for resolving entry points only a test uses.
    #[cfg(test)]
    pub fn handle(&self) -> *mut c_void {
        self.handle
    }

    /// `cupsLastError` and `cupsLastErrorString` of this thread's last call.
    pub fn last_error(&self) -> (c_int, String) {
        let code = unsafe { (self.last_error)() };
        let text = owned(unsafe { (self.last_error_string)() }).unwrap_or_default();
        (code, text)
    }

    /// Every destination the print system offers this user.
    pub fn destinations(&self) -> Result<Destinations<'_>, String> {
        let mut list: *mut CupsDest = std::ptr::null_mut();
        let count = unsafe { (self.get_dests2)(HTTP_DEFAULT, &mut list) };
        if count <= 0 {
            if !list.is_null() {
                unsafe { (self.free_dests)(count.max(0), list) };
            }
            let (code, text) = self.last_error();
            if code > IPP_STATUS_OK_MAX {
                return Err(format!("The print system could not be reached: {text}"));
            }
            return Ok(Destinations {
                cups: self,
                list: std::ptr::null_mut(),
                count: 0,
            });
        }
        Ok(Destinations {
            cups: self,
            list,
            count,
        })
    }

    /// A destination for an IPP printer URI that no queue names.
    #[cfg(test)]
    pub fn destination_for_uri(&self, uri: &str) -> Result<Destinations<'_>, String> {
        let uri = CString::new(uri).map_err(|_| "The printer address is invalid.".to_string())?;
        let dest = unsafe { (self.get_dest_with_uri)(std::ptr::null(), uri.as_ptr()) };
        if dest.is_null() {
            let (_, text) = self.last_error();
            return Err(format!("The printer could not be reached: {text}"));
        }
        Ok(Destinations {
            cups: self,
            list: dest,
            count: 1,
        })
    }

    pub fn option(&self, dest: &CupsDest, name: &str) -> Option<String> {
        let name = CString::new(name).ok()?;
        owned(unsafe { (self.get_option)(name.as_ptr(), dest.num_options, dest.options) })
    }
}

/// A destination list owned by libcups, freed on drop.
pub struct Destinations<'a> {
    cups: &'a Cups,
    list: *mut CupsDest,
    count: c_int,
}

impl Drop for Destinations<'_> {
    fn drop(&mut self) {
        if !self.list.is_null() {
            unsafe { (self.cups.free_dests)(self.count, self.list) };
        }
    }
}

impl Destinations<'_> {
    pub fn iter(&self) -> impl Iterator<Item = &CupsDest> {
        let slice: &[CupsDest] = if self.list.is_null() {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(self.list, self.count as usize) }
        };
        slice.iter()
    }

    /// The destination a printer name names: `queue` or `queue/instance`.
    pub fn find(&self, name: &str) -> Option<&CupsDest> {
        self.iter().find(|dest| display_name(dest) == name)
    }

    /// The destination information for one destination of this list. The
    /// information borrows the list, so it cannot outlive the destination.
    ///
    /// The connection is opened to the destination's own scheduler and lives
    /// as long as the information: the localization calls refuse
    /// `CUPS_HTTP_DEFAULT`.
    pub fn info<'s>(&'s self, dest: &'s CupsDest) -> Result<DestInfo<'s>, String> {
        let raw = dest as *const CupsDest as *mut CupsDest;
        let mut resource = [0 as c_char; 1024];
        let http = unsafe {
            (self.cups.connect_dest)(
                raw,
                DEST_FLAGS_NONE,
                CONNECT_TIMEOUT_MS,
                std::ptr::null_mut(),
                resource.as_mut_ptr(),
                resource.len(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if http.is_null() {
            let (_, text) = self.cups.last_error();
            return Err(format!(
                "The printer '{}' could not be reached: {text}",
                display_name(dest)
            ));
        }
        let mut info = self.info_over(http, dest);
        match &mut info {
            Ok(info) => info.owns_http = true,
            Err(_) => unsafe { (self.cups.http_close)(http) },
        }
        info
    }

    /// The destination information read over an explicit connection, such as
    /// one `cupsConnectDest` opened to the device itself.
    pub fn info_over<'s>(
        &'s self,
        http: *mut c_void,
        dest: &'s CupsDest,
    ) -> Result<DestInfo<'s>, String> {
        let dest = dest as *const CupsDest as *mut CupsDest;
        let info = unsafe { (self.cups.copy_dest_info)(http, dest) };
        if info.is_null() {
            let (_, text) = self.cups.last_error();
            return Err(format!(
                "The printer '{}' did not report its capabilities: {text}",
                display_name(unsafe { &*dest })
            ));
        }
        Ok(DestInfo {
            cups: self.cups,
            http,
            owns_http: false,
            dest,
            info,
        })
    }
}

/// The name a printer is listed and submitted by: the queue name, plus
/// `/instance` for a saved option instance. A queue name never contains `/`.
pub fn display_name(dest: &CupsDest) -> String {
    let name = owned(dest.name).unwrap_or_default();
    match owned(dest.instance) {
        Some(instance) if !instance.is_empty() => format!("{name}/{instance}"),
        _ => name,
    }
}

/// `cups_dinfo_t` for one destination, freed on drop.
pub struct DestInfo<'a> {
    cups: &'a Cups,
    http: *mut c_void,
    owns_http: bool,
    dest: *mut CupsDest,
    info: *mut c_void,
}

impl Drop for DestInfo<'_> {
    fn drop(&mut self) {
        unsafe { (self.cups.free_dest_info)(self.info) };
        if self.owns_http {
            unsafe { (self.cups.http_close)(self.http) };
        }
    }
}

impl DestInfo<'_> {
    pub fn supports(&self, option: &str, value: &str) -> bool {
        let (Ok(option), Ok(value)) = (CString::new(option), CString::new(value)) else {
            return false;
        };
        unsafe {
            (self.cups.check_dest_supported)(
                self.http,
                self.dest,
                self.info,
                option.as_ptr(),
                value.as_ptr(),
            ) != 0
        }
    }

    /// The upper bound of an integer-range `xxx-supported` attribute.
    pub fn range_upper(&self, option: &str) -> Option<i32> {
        let option = CString::new(option).ok()?;
        let attr = unsafe {
            (self.cups.find_dest_supported)(self.http, self.dest, self.info, option.as_ptr())
        };
        if attr.is_null() || unsafe { (self.cups.ipp_get_count)(attr) } < 1 {
            return None;
        }
        let mut upper: c_int = 0;
        unsafe { (self.cups.ipp_get_range)(attr, 0, &mut upper) };
        (upper > 0).then_some(upper)
    }

    /// The PWG 5101.1 size name for a size: the value a job's `media`
    /// option takes. A media-database key can carry the source, the type and
    /// a borderless suffix, none of which is a size.
    pub fn size_name(&self, size: &CupsSize) -> Option<String> {
        let pwg = unsafe { (self.cups.pwg_media_for_size)(size.width, size.length) };
        if pwg.is_null() {
            return None;
        }
        owned(unsafe { (*pwg).pwg })
    }

    /// Every media entry the destination reports, with its localized name.
    pub fn media(&self) -> Vec<(CupsSize, String)> {
        let count = unsafe {
            (self.cups.get_dest_media_count)(self.http, self.dest, self.info, MEDIA_FLAGS_DEFAULT)
        };
        let mut sizes = Vec::new();
        for index in 0..count.max(0) {
            let mut size = CupsSize::zeroed();
            let found = unsafe {
                (self.cups.get_dest_media_by_index)(
                    self.http,
                    self.dest,
                    self.info,
                    index,
                    MEDIA_FLAGS_DEFAULT,
                    &mut size,
                )
            };
            if found == 0 {
                continue;
            }
            let localized = owned(unsafe {
                (self.cups.localize_dest_media)(
                    self.http,
                    self.dest,
                    self.info,
                    MEDIA_FLAGS_DEFAULT,
                    &mut size,
                )
            })
            .unwrap_or_else(|| size.media());
            sizes.push((size, localized));
        }
        sizes
    }

    pub fn default_size(&self) -> Option<CupsSize> {
        let mut size = CupsSize::zeroed();
        let found = unsafe {
            (self.cups.get_dest_media_default)(
                self.http,
                self.dest,
                self.info,
                MEDIA_FLAGS_DEFAULT,
                &mut size,
            )
        };
        (found != 0 && size.width > 0 && size.length > 0).then_some(size)
    }
}
