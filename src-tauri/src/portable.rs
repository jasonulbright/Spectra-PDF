//! Which container this binary is running in, and the four answers that
//! follow from it.
//!
//! Two containers ship the SAME payload tree: the NSIS installer lays it down
//! under `$INSTDIR`, and `spectrapdf-<version>-portable.zip` carries the
//! identical bytes to wherever the user extracts them. Everything below is the
//! set of decisions that differ between the two.
//!
//! **The container is decided structurally, never by inspecting the path.** The
//! installer writes `install-record.json` beside the executable in its
//! post-install hook; the zip has no such file and cannot acquire one. A path
//! heuristic ("is this under Program Files?") would misread a zip extracted to
//! `C:\Program Files\` and an installer redirected by `/D=` alike, in opposite
//! directions.
//!
//! The same record carries the installer's Adobe colour-profile EULA
//! acceptance, which the installer has already obtained by the time it runs the
//! hook: interactively through the wizard's licence page (the bundler's
//! `licenseFile` is that exact text), and unattended through `/acceptEULA`,
//! which `nsis-hooks.nsh` refuses to install without. So an installed run
//! carries its acceptance and never asks again; a portable run has no record
//! until the first-run dialog writes one.
//!
//! On Linux the same record decides the same way: a distribution package lays
//! `install-record.json` beside the executable, and anything without it is
//! portable. An AppImage mounts read-only, so nothing can be written beside
//! the executable; `$APPIMAGE` names the image file instead, and a portable
//! AppImage keeps its root in the `<image>.config` or `<image>.home` folder
//! beside that file, the directories the AppImage runtime itself treats as
//! the portable home. An AppImage with neither folder has no portable root
//! and uses the per-user XDG directories, exactly as the read-only-media
//! fallback does on Windows.

use std::path::{Path, PathBuf};
use tauri::Manager;

/// Written beside the executable by `NSIS_HOOK_POSTINSTALL`. Its presence IS
/// the installed container; a zip never has one.
pub const INSTALL_RECORD: &str = "install-record.json";

/// The portable container's writable root, beside the executable. One root for
/// every per-machine thing a portable copy must carry with it — the WebView2
/// user data folder (which holds localStorage, and therefore every app
/// setting) and the colour-profile assent record.
pub const PORTABLE_DATA_DIR: &str = "data";

/// The assent record a portable run writes, under [`PORTABLE_DATA_DIR`].
pub const ICC_ASSENT_FILE: &str = "icc-assent.json";

/// The webview's user data folder under the portable root.
#[cfg(not(target_os = "linux"))]
pub const WEBVIEW_DATA_DIR: &str = "webview2";
#[cfg(target_os = "linux")]
pub const WEBVIEW_DATA_DIR: &str = "webview";

/// The bundle identifier: the folder name every per-user root is keyed by.
pub const APP_IDENTIFIER: &str = "com.spectrapdf.app";

/// Set by the AppImage runtime to the image file's absolute path.
pub const APPIMAGE_ENV: &str = "APPIMAGE";

/// The engine subprocess reads its assent state from this variable. See
/// [`assent_env_value`] for why the engine is told rather than asked to look.
pub const ICC_ASSENT_ENV: &str = "SPECTRAPDF_ICC_ASSENT";

/// WebView2 honours this ahead of its own default and ahead of the registry
/// override, documented on `CreateCoreWebView2EnvironmentWithOptions`. It is
/// read when the WebView2 *environment* is created — once per process — so
/// setting it before the first window covers every later window too.
pub const WEBVIEW_USER_DATA_ENV: &str = "WEBVIEW2_USER_DATA_FOLDER";

/// The EdgeUpdate client id of the WebView2 Evergreen Runtime.
#[cfg_attr(not(windows), allow(dead_code))]
const WEBVIEW2_CLIENT: &str =
    r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// Where a user gets the runtime. Compiled in, exactly like the releases page:
/// nothing at run time may redirect it.
pub const WEBVIEW2_DOWNLOAD_URL: &str =
    "https://developer.microsoft.com/microsoft-edge/webview2/";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    /// Laid down by the NSIS installer; carries `install-record.json`.
    Installed,
    /// Extracted from the portable zip, or a `cargo build` tree.
    Portable,
}

/// Whether the Adobe colour-profile EULA has been assented to, and how.
///
/// `Declined` is a RECORDED answer, not the absence of one: it stops the
/// dialog reappearing every launch while leaving the profiles unread. Only
/// `Unrecorded` opens the dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IccAssent {
    Accepted,
    Declined,
    Unrecorded,
}

impl IccAssent {
    pub fn accepted(self) -> bool {
        matches!(self, IccAssent::Accepted)
    }
}

/// The full answer the renderer reads to decide whether to open the dialog and
/// how to describe the ICC-dependent surfaces.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssentState {
    /// True in the portable container. The installed container never presents
    /// the dialog, because its record always exists.
    pub portable: bool,
    pub assent: IccAssent,
    /// The licence text file that must be presented, or "" when it is missing
    /// from the resource tree (which is itself a refusal — see
    /// `read_icc_license`).
    pub license_path: String,
}

// ── the exe's own directory ────────────────────────────────────────────────

/// The directory the running executable sits in.
///
/// Every payload path in both containers is relative to this — the CLI already
/// resolves `python`, `engine`, `icc`, `fonts` and `tesseract` from it, and the
/// windowed build reaches the same tree through Tauri's `resource_dir()`. A
/// portable copy therefore needs no new path machinery; it needs only the
/// writable root below.
pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

// ── container detection ────────────────────────────────────────────────────

/// Pure over a payload directory, so the decision is testable without an
/// installer. See the module docstring for why presence-of-a-file rather than
/// a path shape.
pub fn container_at(dir: &Path) -> Container {
    if dir.join(INSTALL_RECORD).is_file() {
        Container::Installed
    } else {
        Container::Portable
    }
}

pub fn container() -> Container {
    container_at(&exe_dir())
}

pub fn is_portable() -> bool {
    container() == Container::Portable
}

// ── the portable root ──────────────────────────────────────────────────────

/// The portable container's writable root, or None when it has none.
///
/// Pure over the image path so both layouts are pinnable. Without an image the
/// root is `<exe dir>/data`, as in the Windows zip. With one, the root is the
/// first of `<image>.config` and `<image>.home` that exists as a folder; the
/// user creates one of them to make an AppImage portable.
pub fn portable_root_for(dir: &Path, appimage: Option<&Path>) -> Option<PathBuf> {
    let Some(image) = appimage else {
        return Some(dir.join(PORTABLE_DATA_DIR));
    };
    [".config", ".home"].into_iter().find_map(|suffix| {
        let mut beside = image.as_os_str().to_os_string();
        beside.push(suffix);
        let beside = PathBuf::from(beside);
        beside.is_dir().then(|| beside.join(APP_IDENTIFIER))
    })
}

/// The running AppImage file, when this process runs from one.
pub fn appimage() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os(APPIMAGE_ENV)
            .map(PathBuf::from)
            .filter(|image| image.is_absolute() && image.is_file())
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

pub fn portable_root(dir: &Path) -> Option<PathBuf> {
    portable_root_for(dir, appimage().as_deref())
}

// ── the XDG base directories ───────────────────────────────────────────────

/// One XDG base directory: the variable's value when it is an absolute path,
/// else `$HOME/<fallback>`. The specification says a relative value is
/// invalid and must be ignored.
pub fn xdg_base_from(
    value: Option<std::ffi::OsString>,
    home: Option<PathBuf>,
    fallback: &str,
) -> Option<PathBuf> {
    value
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| home.filter(|home| home.is_absolute()).map(|home| home.join(fallback)))
}

fn xdg_base(variable: &str, fallback: &str) -> Option<PathBuf> {
    xdg_base_from(
        std::env::var_os(variable),
        std::env::var_os("HOME").map(PathBuf::from),
        fallback,
    )
}

/// `$XDG_CONFIG_HOME`, default `~/.config`.
pub fn xdg_config_home() -> Option<PathBuf> {
    xdg_base("XDG_CONFIG_HOME", ".config")
}

/// `$XDG_DATA_HOME`, default `~/.local/share`.
pub fn xdg_data_home() -> Option<PathBuf> {
    xdg_base("XDG_DATA_HOME", ".local/share")
}

/// `$XDG_STATE_HOME`, default `~/.local/state`.
pub fn xdg_state_home() -> Option<PathBuf> {
    xdg_base("XDG_STATE_HOME", ".local/state")
}

/// Where a portable copy with no portable root records its assent: the
/// per-user configuration folder. Only a Linux AppImage without a portable
/// folder reaches this; a Windows portable copy always has its root.
fn assent_record_dir(dir: &Path) -> Option<PathBuf> {
    portable_root(dir).or_else(|| {
        if cfg!(target_os = "linux") {
            xdg_config_home().map(|config| config.join(APP_IDENTIFIER))
        } else {
            None
        }
    })
}

// ── the assent record ──────────────────────────────────────────────────────

/// The one field both records carry. Spelled the same in the installer's JSON
/// and in the portable one so a single reader serves both.
const ACCEPTED_KEY: &str = "adobeIccEulaAccepted";
const MAX_ASSENT_RECORD_BYTES: u64 = 4 * 1024;
const MAX_ICC_LICENSE_BYTES: u64 = 256 * 1024;

fn read_utf8_limited(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    use std::io::Read;

    let file = std::fs::File::open(path)?;
    if file.metadata()?.len() > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file exceeds the allowed size",
        ));
    }

    let mut text = String::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_string(&mut text)?;
    if text.len() as u64 > max_bytes {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file exceeds the allowed size",
        ));
    }
    Ok(text)
}

fn read_accepted_flag(path: &Path) -> Option<bool> {
    let text = read_utf8_limited(path, MAX_ASSENT_RECORD_BYTES).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get(ACCEPTED_KEY)?.as_bool()
}

/// The recorded assent for a payload directory, whichever container it is.
///
/// The installer's record wins when it exists, because in that container it is
/// the only record there is — the installer obtained the acceptance and the app
/// must not re-ask. A malformed or unreadable record is `Unrecorded` rather
/// than an assumed yes: an unreadable file has told us nothing.
pub fn icc_assent_at(dir: &Path) -> IccAssent {
    let record = dir.join(INSTALL_RECORD);
    if record.is_file() {
        return match read_accepted_flag(&record) {
            Some(true) => IccAssent::Accepted,
            Some(false) => IccAssent::Declined,
            None => IccAssent::Unrecorded,
        };
    }
    let Some(root) = assent_record_dir(dir) else {
        return IccAssent::Unrecorded;
    };
    match read_accepted_flag(&root.join(ICC_ASSENT_FILE)) {
        Some(true) => IccAssent::Accepted,
        Some(false) => IccAssent::Declined,
        None => IccAssent::Unrecorded,
    }
}

pub fn icc_assent() -> IccAssent {
    icc_assent_at(&exe_dir())
}

/// Records the user's answer in the portable container.
///
/// Refuses in the installed container rather than writing a second record: two
/// records would give one machine two answers, and the installer's is the one
/// the licence terms were satisfied through.
pub fn record_icc_assent_at(dir: &Path, accepted: bool) -> Result<(), String> {
    if container_at(dir) == Container::Installed {
        return Err(
            "This copy was installed, so its colour-profile licence acceptance was recorded \
             by the installer and cannot be changed here."
                .to_string(),
        );
    }
    let root = assent_record_dir(dir)
        .ok_or_else(|| "Cannot resolve the configuration folder.".to_string())?;
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Cannot create {}: {}", root.display(), e))?;
    let body = format!("{{\n  \"{ACCEPTED_KEY}\": {accepted}\n}}\n");
    let path = root.join(ICC_ASSENT_FILE);
    crate::staging::write_record(&path, body.as_bytes())
        .map_err(|e| format!("Cannot write {}: {}", path.display(), e))
}

/// What the engine subprocess is told, as an environment value.
///
/// The engine is TOLD rather than left to look, because the two containers
/// disagree about where the record lives and because the CLI and the window
/// spawn the same engine from the same binary — one resolver here, not a second
/// one in Python. `"1"` and `"0"` are the two recorded answers; `Unrecorded`
/// sends `"0"`, since nothing has been assented to yet.
///
/// The variable's ABSENCE is a third state and means "no shipped container
/// launched this engine": a source-tree run, a pytest, a developer driving
/// `__startup__.py` by hand. Those read profiles as they always have. Both
/// shipped containers always set it, so absence is unreachable in the product.
pub fn assent_env_value(assent: IccAssent) -> &'static str {
    if assent.accepted() {
        "1"
    } else {
        "0"
    }
}

// ── the WebView2 user data folder ──────────────────────────────────────────

/// Where WebView2 keeps its user data folder, or None to leave its default.
///
/// Pure over the container so the decision can be pinned. Portable puts it
/// BESIDE the app, under the one writable root: the folder holds localStorage,
/// and localStorage is where every app setting, the recent-file list and each
/// window's `workbench-ui`/`snap-ui`/`takeoff-ui`/`spectra-toolbar` key live —
/// so a portable copy that left it in `%LOCALAPPDATA%` would carry its files
/// and abandon its settings. Installed keeps WebView2's default, which is the
/// per-user location an installed app should use and the one every prior
/// release has written to; moving it would strand existing users' settings.
pub fn webview_user_data_at(dir: &Path, container: Container) -> Option<PathBuf> {
    match container {
        Container::Installed => None,
        Container::Portable => portable_root(dir).map(|root| root.join(WEBVIEW_DATA_DIR)),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebViewUserDataDecision {
    /// Leave WebView2's default alone (installed app or an explicit override).
    UseDefault,
    /// Set the portable profile beside the executable.
    SetPortable(PathBuf),
    /// The app folder cannot hold the portable profile; WebView2 will use its
    /// per-user default, which will not travel with the extracted copy.
    PortableFallback,
}

/// Decides whether startup can keep WebView2 data beside a portable copy.
///
/// The override is supplied by an administrator or test harness and takes
/// precedence over this app's default. The writable probe is only called when
/// the portable folder is actually needed.
pub fn decide_webview_user_data(
    dir: &Path,
    container: Container,
    has_override: bool,
    writable: impl FnOnce(&Path) -> bool,
) -> WebViewUserDataDecision {
    if has_override || container == Container::Installed {
        return WebViewUserDataDecision::UseDefault;
    }
    let Some(wanted) = webview_user_data_at(dir, container) else {
        return WebViewUserDataDecision::UseDefault;
    };
    if writable(&wanted) {
        WebViewUserDataDecision::SetPortable(wanted)
    } else {
        WebViewUserDataDecision::PortableFallback
    }
}

/// Applies the decision to this process, before any WebView2 environment is
/// created.
///
/// Returns the folder actually in force, or None when WebView2's default is.
/// A portable copy on read-only media cannot create the folder; that falls back
/// to the default rather than failing to open a window. A native warning names
/// that the settings will stay in this Windows profile instead of traveling
/// with the portable copy.
///
/// An existing `WEBVIEW2_USER_DATA_FOLDER` in the environment is left alone:
/// whoever set it (an administrator, a test harness) outranks this default.
pub fn apply_webview_user_data() -> Option<PathBuf> {
    let dir = exe_dir();
    match decide_webview_user_data(
        &dir,
        container_at(&dir),
        std::env::var_os(WEBVIEW_USER_DATA_ENV).is_some(),
        ensure_writable_dir,
    ) {
        WebViewUserDataDecision::UseDefault => None,
        WebViewUserDataDecision::SetPortable(wanted) => {
            #[cfg(not(target_os = "linux"))]
            std::env::set_var(WEBVIEW_USER_DATA_ENV, &wanted);
            #[cfg(target_os = "linux")]
            let _ = WEBVIEW_DATA_IN_FORCE.set(wanted.clone());
            Some(wanted)
        }
        WebViewUserDataDecision::PortableFallback => {
            report_portable_storage_fallback();
            None
        }
    }
}

/// WebKitGTK takes its data directory per window, not from the environment.
/// Startup records the decision here and every window builder applies it.
#[cfg(target_os = "linux")]
static WEBVIEW_DATA_IN_FORCE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// The portable webview data directory, or None for the per-user default
/// (`$XDG_DATA_HOME/com.spectrapdf.app`).
#[cfg(target_os = "linux")]
pub fn webview_data_in_force() -> Option<PathBuf> {
    WEBVIEW_DATA_IN_FORCE.get().cloned()
}

/// Create `dir` if needed and prove it can accept a new file.
///
/// `create_dir_all` succeeds when the directory already exists, even when its
/// volume or permissions have since become read-only. A portable copy may be
/// moved onto read-only media after a prior launch, so existence alone cannot
/// decide whether WebView2 or the app can keep using the portable root.
fn ensure_writable_dir(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    tempfile::Builder::new()
        .prefix(".spectrapdf-write-probe-")
        .tempfile_in(dir)
        .is_ok()
}

// ── the writable data root ─────────────────────────────────────────────────

/// Chooses between the root beside the executable and the per-user standard
/// one, given a probe for whether the first can actually be written.
///
/// Pure over the probe so both outcomes are pinnable without read-only media.
/// `standard` is an Option because resolving the per-user directory can itself
/// fail; when it does and the preferred root is unwritable there is no root at
/// all, which is the None the caller reports.
pub fn resolve_data_root(
    preferred: Option<PathBuf>,
    standard: Option<PathBuf>,
    writable: impl FnOnce(&Path) -> bool,
) -> Option<PathBuf> {
    match preferred {
        Some(dir) if writable(&dir) => Some(dir),
        _ => standard,
    }
}

/// The preferred root for a container: beside the executable when portable,
/// the per-user standard directory when installed.
///
/// Installed is `None` here — "no preference, take the standard one" — so an
/// installed copy resolves byte-identically to what every prior release wrote,
/// with no second location for its settings to be split across.
pub fn preferred_data_root(dir: &Path, container: Container) -> Option<PathBuf> {
    match container {
        Container::Installed => None,
        Container::Portable => portable_root(dir),
    }
}

fn root_from(standard: Option<PathBuf>, what: &str) -> Result<PathBuf, String> {
    let dir = exe_dir();
    let preferred = preferred_data_root(&dir, container_at(&dir));
    resolve_data_root(preferred, standard, ensure_writable_dir)
        .ok_or_else(|| format!("Cannot resolve the {what} folder."))
}

/// Where per-user state is written: `<exe dir>\data` in the portable
/// container, the standard per-user directory otherwise.
///
/// One root for everything a portable copy must carry with it — dictionaries,
/// batch and operation logs, the session, the pre-window startup flags, the
/// extracted portfolio members — so a copy on a stick leaves nothing behind in
/// the profile of whatever machine it was plugged into. It is the same root
/// the WebView2 user data folder uses, and it inherits that folder's fallback:
/// a copy on read-only media cannot create it, and falls back to the standard
/// directory rather than failing the feature.
///
/// Creating the root IS the writability probe, so the folder appears on the
/// first launch that needs state and never before.
///
/// No migration exists in either direction: a portable first run starts fresh,
/// and an installed copy resolves exactly where it always did.
pub fn data_root<R: tauri::Runtime, M: Manager<R>>(app: &M) -> Result<PathBuf, String> {
    root_from(app.path().app_data_dir().ok(), "data")
}

/// The configuration counterpart of [`data_root`]. Portable collapses both
/// onto the one root — the container has a single writable place — while an
/// installed copy keeps the standard configuration directory it always used.
pub fn config_root<R: tauri::Runtime, M: Manager<R>>(app: &M) -> Result<PathBuf, String> {
    root_from(app.path().app_config_dir().ok(), "config")
}

// ── the WebView2 runtime probe ─────────────────────────────────────────────

/// Whether a version string from EdgeUpdate names an installed runtime.
///
/// EdgeUpdate leaves the value present and zeroed after an uninstall, so
/// "present" is not the test — a version with a non-zero component is.
pub fn webview2_version_is_installed(version: &str) -> bool {
    let trimmed = version.trim();
    !trimmed.is_empty() && trimmed.split('.').any(|part| part.parse::<u64>().unwrap_or(0) > 0)
}

/// The installed Evergreen Runtime's version, or None.
///
/// Three locations, in the order WebView2's own loader consults them: the
/// machine-wide 32-bit view (where the runtime records itself on x64), the
/// machine-wide native view, and the per-user install.
#[cfg(windows)]
pub fn webview2_version() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
    use winreg::RegKey;

    let candidates: [(winreg::HKEY, u32); 3] = [
        (HKEY_LOCAL_MACHINE, KEY_READ | KEY_WOW64_32KEY),
        (HKEY_LOCAL_MACHINE, KEY_READ),
        (HKEY_CURRENT_USER, KEY_READ),
    ];
    for (root, flags) in candidates {
        let Ok(key) = RegKey::predef(root).open_subkey_with_flags(
            format!(r"SOFTWARE\{WEBVIEW2_CLIENT}"),
            flags,
        ) else {
            continue;
        };
        let Ok(version) = key.get_value::<String, _>("pv") else {
            continue;
        };
        if webview2_version_is_installed(&version) {
            return Some(version);
        }
    }
    None
}

#[cfg(not(windows))]
pub fn webview2_version() -> Option<String> {
    None
}

/// Reports an absent WebView2 runtime and returns false, or returns true.
///
/// Called BEFORE any window is built, because the report has to reach the user
/// through the only surface that still exists without a webview: a native
/// message box: name the missing prerequisite and point at where it comes
/// from, never fail with a blank window or a loader error.
///
/// The installer never reaches this: `webviewInstallMode` is
/// `downloadBootstrapper`, so an installed machine has the runtime by the time
/// the app first runs. The zip carries no bootstrapper and never will — a
/// first-party Microsoft platform runtime is not vendored.
#[cfg(windows)]
pub fn report_missing_webview2() -> bool {
    if webview2_version().is_some() {
        return true;
    }
    let text = format!(
        "Spectra PDF needs the Microsoft Edge WebView2 Runtime, and this computer does not \
         have it.\r\n\r\nWebView2 is a free Microsoft component. Installing it once is all \
         this needs; Spectra PDF does not include a copy and never installs one for you.\r\n\r\n\
         Open the official WebView2 download page now?\r\n\r\n{WEBVIEW2_DOWNLOAD_URL}"
    );
    if yes_no_box(&text, "Spectra PDF — WebView2 Runtime required") {
        open_url(WEBVIEW2_DOWNLOAD_URL);
    }
    false
}

#[cfg(not(windows))]
pub fn report_missing_webview2() -> bool {
    true
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn yes_no_box(text: &str, caption: &str) -> bool {
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }
    const MB_YESNO: u32 = 0x00000004;
    const MB_ICONEXCLAMATION: u32 = 0x00000030;
    const IDYES: i32 = 6;
    let body = wide(text);
    let title = wide(caption);
    unsafe { MessageBoxW(0, body.as_ptr(), title.as_ptr(), MB_YESNO | MB_ICONEXCLAMATION) == IDYES }
}

#[cfg(windows)]
fn report_portable_storage_fallback() {
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }
    const MB_OK: u32 = 0x00000000;
    const MB_ICONWARNING: u32 = 0x00000030;
    let body = wide(
        "The folder containing this portable copy cannot be written. Spectra PDF will keep settings in this Windows user profile, so they will not travel with the copy. Move the copy to a writable folder before changing settings if you want new settings saved beside it. Existing profile settings will not move automatically.",
    );
    let title = wide("Spectra PDF — Portable settings location");
    unsafe {
        MessageBoxW(
            0,
            body.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONWARNING,
        );
    }
}

#[cfg(not(windows))]
fn report_portable_storage_fallback() {}

/// Opens a URL with the shell. Used only with [`WEBVIEW2_DOWNLOAD_URL`], which
/// is compiled in — this takes no caller-supplied destination for the same
/// reason `open_releases_page` takes no argument.
#[cfg(windows)]
fn open_url(url: &str) {
    extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }
    const SW_SHOWNORMAL: i32 = 1;
    let op = wide("open");
    let target = wide(url);
    unsafe {
        ShellExecuteW(
            0,
            op.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
    }
}

// ── the licence text ───────────────────────────────────────────────────────

/// The Exhibit B end-user licence, read from the file the profiles ship beside.
///
/// **The same file the installer presents.** `tauri.conf.json` points its
/// `licenseFile` at `vendor/icc/Adobe-Color-Profile-License.txt`, and
/// `bundle-icc.ps1` copies that exact file into `icc/` in the payload tree, so
/// the wizard's licence page and this dialog show one text from one source.
/// There is no second copy to drift.
pub fn read_icc_license(icc_dir: &Path) -> Result<String, String> {
    let path = icc_dir.join("Adobe-Color-Profile-License.txt");
    read_utf8_limited(&path, MAX_ICC_LICENSE_BYTES)
        .map_err(|e| {
            format!(
                "Cannot read the colour-profile licence at {}: {}",
                path.display(),
                e
            )
        })
}

// ── the commands ───────────────────────────────────────────────────────────

/// What the renderer needs to decide whether to present the dialog.
#[tauri::command]
pub async fn icc_assent_state(app: tauri::AppHandle) -> Result<AssentState, String> {
    let dir = exe_dir();
    let icc = PathBuf::from(crate::engine::get_icc_path(&app));
    let license = icc.join("Adobe-Color-Profile-License.txt");
    Ok(AssentState {
        portable: container_at(&dir) == Container::Portable,
        assent: icc_assent_at(&dir),
        license_path: if license.is_file() {
            license.to_string_lossy().into_owned()
        } else {
            String::new()
        },
    })
}

/// The Exhibit B text the dialog presents.
#[tauri::command]
pub async fn icc_license_text(app: tauri::AppHandle) -> Result<String, String> {
    read_icc_license(Path::new(&crate::engine::get_icc_path(&app)))
}

/// Records the answer and re-tells the running engine.
///
/// The engine is a long-lived subprocess that read [`ICC_ASSENT_ENV`] at spawn,
/// so accepting mid-session has to reach it: the engine is stopped here and the
/// next call starts a fresh one with the new value. The engine does hold state
/// between calls (the credentials of password- and certificate-opened
/// documents); each replacement worker is given its window's credentials again
/// before it serves a request (`engine::CredentialLedger`).
#[tauri::command]
pub async fn record_icc_assent(app: tauri::AppHandle, accepted: bool) -> Result<AssentState, String> {
    record_icc_assent_at(&exe_dir(), accepted)?;
    crate::engine::restart_for_assent(&app).await;
    icc_assent_state(app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("spectrapdf-portable-{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_installer_marker_is_what_separates_the_containers() {
        let dir = scratch("container");
        // A zip's tree, wherever it was extracted to.
        assert_eq!(container_at(&dir), Container::Portable);
        // The same directory, once the installer's hook has run in it. Nothing
        // about the PATH changed, which is the point.
        std::fs::write(dir.join(INSTALL_RECORD), r#"{"adobeIccEulaAccepted":true}"#).unwrap();
        assert_eq!(container_at(&dir), Container::Installed);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_installed_copy_carries_the_installers_acceptance() {
        let dir = scratch("installed-assent");
        std::fs::write(
            dir.join(INSTALL_RECORD),
            r#"{"installed":true,"adobeIccEulaAccepted":true}"#,
        )
        .unwrap();
        assert_eq!(icc_assent_at(&dir), IccAssent::Accepted);
        // And it is not asked again, nor overwritten from inside the app.
        assert!(record_icc_assent_at(&dir, false).is_err());
        assert_eq!(icc_assent_at(&dir), IccAssent::Accepted);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_portable_copy_starts_unrecorded_and_keeps_both_answers() {
        let dir = scratch("portable-assent");
        assert_eq!(icc_assent_at(&dir), IccAssent::Unrecorded);

        record_icc_assent_at(&dir, false).unwrap();
        // Declining is RECORDED: the dialog must not reappear every launch.
        assert_eq!(icc_assent_at(&dir), IccAssent::Declined);
        assert_eq!(assent_env_value(icc_assent_at(&dir)), "0");

        record_icc_assent_at(&dir, true).unwrap();
        assert_eq!(icc_assent_at(&dir), IccAssent::Accepted);
        assert_eq!(assent_env_value(icc_assent_at(&dir)), "1");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The answer lands through the staged writer, which is also what reclaims
    /// the stage a writer killed mid-answer left beside the record.
    #[cfg(windows)]
    #[test]
    fn an_answer_replaces_a_torn_record_whole() {
        let dir = scratch("portable-assent-torn");
        let record = dir.join(PORTABLE_DATA_DIR).join(ICC_ASSENT_FILE);
        std::fs::create_dir_all(record.parent().unwrap()).unwrap();
        std::fs::write(&record, "{\n  \"adobeIccEulaAcc").unwrap();
        assert_eq!(icc_assent_at(&dir), IccAssent::Unrecorded);
        let mut writer = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        writer.wait().unwrap();
        let orphan = crate::staging::stage_path(&record, writer.id());
        std::fs::write(&orphan, "{\n  \"adobeIccEulaAccepted\": tr").unwrap();

        record_icc_assent_at(&dir, true).unwrap();

        assert_eq!(icc_assent_at(&dir), IccAssent::Accepted);
        let beside: Vec<_> = std::fs::read_dir(record.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(beside, vec![std::ffi::OsString::from(ICC_ASSENT_FILE)]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_record_has_told_us_nothing() {
        let dir = scratch("garbled-assent");
        std::fs::write(dir.join(INSTALL_RECORD), "not json at all").unwrap();
        assert_eq!(icc_assent_at(&dir), IccAssent::Unrecorded);
        assert_eq!(assent_env_value(IccAssent::Unrecorded), "0");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_oversized_assent_record_is_not_loaded() {
        let dir = scratch("oversized-assent");
        let mut record = format!(r#"{{"{ACCEPTED_KEY}":true}}"#);
        record.push_str(&" ".repeat(MAX_ASSENT_RECORD_BYTES as usize + 1));
        std::fs::write(dir.join(INSTALL_RECORD), record).unwrap();

        assert_eq!(icc_assent_at(&dir), IccAssent::Unrecorded);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_oversized_license_text_is_refused() {
        let dir = scratch("oversized-license");
        let path = dir.join("Adobe-Color-Profile-License.txt");
        std::fs::write(&path, "x".repeat(MAX_ICC_LICENSE_BYTES as usize + 1)).unwrap();

        assert!(read_icc_license(&dir).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn portable_keeps_its_webview_data_beside_the_app() {
        let dir = PathBuf::from(r"D:\Tools\SpectraPDF");
        assert_eq!(
            webview_user_data_at(&dir, Container::Portable),
            Some(dir.join(PORTABLE_DATA_DIR).join(WEBVIEW_DATA_DIR)),
        );
        // Installed keeps WebView2's own per-user default. Relocating it would
        // strand every existing user's settings, which live in localStorage
        // inside that folder.
        assert_eq!(webview_user_data_at(&dir, Container::Installed), None);
    }

    #[test]
    fn an_unwritable_portable_webview_folder_is_reported_as_a_fallback() {
        let dir = PathBuf::from(r"E:\SpectraPDF");
        let wanted = dir.join(PORTABLE_DATA_DIR).join(WEBVIEW_DATA_DIR);

        assert_eq!(
            decide_webview_user_data(&dir, Container::Portable, false, |path| path == wanted),
            WebViewUserDataDecision::SetPortable(wanted.clone()),
        );
        assert_eq!(
            decide_webview_user_data(&dir, Container::Portable, false, |_| false),
            WebViewUserDataDecision::PortableFallback,
        );
        assert_eq!(
            decide_webview_user_data(&dir, Container::Installed, false, |_| panic!(
                "an installed copy must leave WebView2's default alone"
            )),
            WebViewUserDataDecision::UseDefault,
        );
        assert_eq!(
            decide_webview_user_data(&dir, Container::Portable, true, |_| panic!(
                "an explicit WebView2 folder takes precedence"
            )),
            WebViewUserDataDecision::UseDefault,
        );
    }

    #[test]
    fn a_portable_copy_keeps_its_state_beside_the_exe_and_an_installed_one_does_not() {
        let dir = PathBuf::from(r"D:\Tools\SpectraPDF");
        let standard = PathBuf::from(r"C:\Users\u\AppData\Roaming\com.spectrapdf.app");

        assert_eq!(
            preferred_data_root(&dir, Container::Portable),
            Some(dir.join(PORTABLE_DATA_DIR)),
        );
        assert_eq!(
            resolve_data_root(
                preferred_data_root(&dir, Container::Portable),
                Some(standard.clone()),
                |_| true
            ),
            Some(dir.join(PORTABLE_DATA_DIR)),
        );

        // Installed expresses no preference, so it resolves to the same
        // per-user directory every prior release wrote to.
        assert_eq!(preferred_data_root(&dir, Container::Installed), None);
        assert_eq!(
            resolve_data_root(
                preferred_data_root(&dir, Container::Installed),
                Some(standard.clone()),
                |_| panic!("an installed copy must not probe a root beside the exe"),
            ),
            Some(standard),
        );
    }

    #[test]
    fn unwritable_media_falls_back_rather_than_failing_the_feature() {
        let dir = PathBuf::from(r"E:\SpectraPDF");
        let standard = PathBuf::from(r"C:\Users\u\AppData\Roaming\com.spectrapdf.app");
        assert_eq!(
            resolve_data_root(Some(dir.join(PORTABLE_DATA_DIR)), Some(standard.clone()), |_| false),
            Some(standard),
        );
        // And with nowhere left to write, the caller is told rather than
        // handed a path that does not exist.
        assert_eq!(
            resolve_data_root(Some(dir.join(PORTABLE_DATA_DIR)), None, |_| false),
            None,
        );
    }

    #[test]
    fn an_existing_data_directory_is_probed_for_file_creation() {
        let temp = tempfile::tempdir().unwrap();
        let existing = temp.path().join("data");
        std::fs::create_dir(&existing).unwrap();

        assert!(ensure_writable_dir(&existing));
        assert_eq!(std::fs::read_dir(&existing).unwrap().count(), 0);

        let blocked = temp.path().join("not-a-directory");
        std::fs::write(&blocked, b"file").unwrap();
        assert!(!ensure_writable_dir(&blocked));
    }

    #[test]
    fn edgeupdate_leaves_a_zeroed_version_behind_after_an_uninstall() {
        assert!(webview2_version_is_installed("140.0.3485.81"));
        assert!(webview2_version_is_installed("0.0.0.1"));
        assert!(!webview2_version_is_installed("0.0.0.0"));
        assert!(!webview2_version_is_installed(""));
        assert!(!webview2_version_is_installed("   "));
    }

    #[test]
    fn an_appimage_is_portable_only_with_a_folder_beside_the_image() {
        let dir = scratch("appimage");
        let image = dir.join("Spectra_PDF.AppImage");
        std::fs::write(&image, b"").unwrap();
        let payload = dir.join("mount");
        assert_eq!(
            portable_root_for(&payload, None),
            Some(payload.join(PORTABLE_DATA_DIR))
        );
        assert_eq!(portable_root_for(&payload, Some(&image)), None);
        let home = dir.join("Spectra_PDF.AppImage.home");
        std::fs::create_dir_all(&home).unwrap();
        assert_eq!(
            portable_root_for(&payload, Some(&image)),
            Some(home.join(APP_IDENTIFIER))
        );
        let config = dir.join("Spectra_PDF.AppImage.config");
        std::fs::create_dir_all(&config).unwrap();
        assert_eq!(
            portable_root_for(&payload, Some(&image)),
            Some(config.join(APP_IDENTIFIER))
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn xdg_directories_ignore_relative_values_and_default_under_home() {
        let home = std::env::temp_dir().join("home");
        let set = std::env::temp_dir().join("state");
        assert_eq!(
            xdg_base_from(Some(set.clone().into_os_string()), Some(home.clone()), ".local/state"),
            Some(set)
        );
        assert_eq!(
            xdg_base_from(Some("relative".into()), Some(home.clone()), ".local/state"),
            Some(home.join(".local/state"))
        );
        assert_eq!(xdg_base_from(None, None, ".config"), None);
    }
}
