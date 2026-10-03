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
//! A Windows portable copy keeps every record — settings, session, logs, the
//! webview data folder and the colour-profile answer — in `<exe dir>\data`.
//! Whether that folder can be written is decided ONCE per process
//! ([`root_decision`]), by one probe of `data` itself, and every record reads
//! that decision. When the folder cannot be written (Program Files, read-only
//! media), every new record goes to the per-user folders together, and the log
//! says so once; a volume that changes mid-run moves nothing.
//!
//! The colour-profile answer is READ in a fixed order that no writability
//! decision enters ([`assent_read_path`]): (a) the installer's record, the
//! only record an installed copy has; (b) the record beside a portable copy,
//! when it reads as an answer; (c) the per-user record. The record beside the
//! copy therefore wins for that copy over a per-user one, and a copy moved
//! onto read-only media keeps the answer it carries. The decision chooses only
//! where a NEW answer is written; a writer whose chosen place fails falls to
//! the per-user folder, which (c) reads. A new answer replaces a readable
//! record beside the copy, because that is where it is read first, and is
//! refused by name when that record cannot be replaced. Other records follow
//! the decision for reads as well as writes (see [`data_root`]).
//!
//! The creating decision and a non-creating one are the same function of the
//! same facts, examined without following a link first: a real folder is
//! probed; a link (a junction included) counts only when it resolves to a
//! folder, which is probed; a dangling link or any other object at the name is
//! a fallback; an absent name is decided by its nearest existing ancestor. The
//! creating variant then creates, and a creation that still fails makes the
//! decision a fallback, which no reader depends on.
//!
//! On Linux the executable's directory is never a state root, whoever runs
//! the app. Linux has two more shapes:
//!
//! - A distribution package (.deb, .rpm) is [`Container::Package`]. It has no
//!   installer dialog and no install record, and its executable directory
//!   (`/usr/bin`) belongs to the system. The package is recognised by its
//!   layout, the same layout the resource resolver follows: an executable
//!   whose `../lib/<product>` resource tree exists, outside an AppImage. An
//!   inherited `$APPIMAGE` does not make a package an AppImage: the variable
//!   counts only while this executable runs from an image mount. The
//!   app asks for the colour-profile answer on first run and records it in
//!   the per-user configuration directory (`$XDG_CONFIG_HOME`, default
//!   `~/.config`, under the bundle identifier), which is the directory Tauri's
//!   `app_config_dir` names. Every other per-user root is the standard one.
//! - An AppImage mounts read-only and stays [`Container::Portable`] with no
//!   root beside the executable. `$APPIMAGE` names the image file, and a
//!   portable AppImage keeps its root in the `<image>.config` or
//!   `<image>.home` folder beside that file, the directories the AppImage
//!   runtime itself treats as the portable home. An AppImage with neither
//!   folder has no portable root: its assent record and every other root are
//!   the per-user ones, as for a package.
//! - Any other tree (a build output, an extracted archive) is
//!   [`Container::Portable`] with no portable root: the per-user folders.
//!
//! An executable path that cannot be resolved is a refusal, never the working
//! directory. One resolver ([`assent_read_path`]) answers the assent question
//! for the window, the CLI and the engine environment ([`ICC_ASSENT_ENV`]), so
//! the answer read back is always the answer written. A status query and an
//! engine spawn read only: they make no decision and create nothing.

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
    /// A Linux distribution package: its executable directory is not
    /// writable, and every record lives in a per-user directory.
    Package,
    /// Extracted from the portable zip, an AppImage, or a `cargo build` tree.
    Portable,
}

impl Container {
    /// Whether the app presents the colour-profile licence itself. Only the
    /// Windows installer presents it on the app's behalf.
    pub fn asks_in_app(self) -> bool {
        self != Container::Installed
    }
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
    /// True when the app presents the dialog itself ([`Container::asks_in_app`]):
    /// the portable and package containers. The installed container never
    /// presents it, because its record always exists.
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
///
/// An executable path that cannot be resolved is a refusal: the working
/// directory is never a stand-in, because every root below would then follow
/// whatever folder the process was started from.
pub fn exe_dir() -> Result<PathBuf, String> {
    exe_dir_from(std::env::current_exe())
}

fn exe_dir_from(exe: std::io::Result<PathBuf>) -> Result<PathBuf, String> {
    let exe = exe.map_err(|e| format!("Cannot resolve this application's path: {e}"))?;
    exe.parent()
        .filter(|dir| dir.is_absolute())
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("Cannot resolve the folder of {}.", exe.display()))
}

// ── container detection ────────────────────────────────────────────────────

/// Pure over a payload directory and the running image, so the decision is
/// testable without an installer. See the module docstring for why
/// presence-of-a-file rather than a path shape, and why a Linux package is
/// recognised by its resource layout.
pub fn container_for(dir: &Path, appimage: Option<&Path>) -> Container {
    if dir.join(INSTALL_RECORD).is_file() {
        Container::Installed
    } else if cfg!(target_os = "linux")
        && appimage.is_none()
        && crate::platform::package_resource_root(dir).is_some()
    {
        Container::Package
    } else {
        Container::Portable
    }
}

pub fn container() -> Result<Container, String> {
    exe_dir().map(|dir| container_for(&dir, appimage().as_deref()))
}

pub fn is_portable() -> Result<bool, String> {
    container().map(|container| container == Container::Portable)
}

// ── the portable root ──────────────────────────────────────────────────────

/// The portable container's writable root, or None when it has none.
///
/// Pure over the image path so every layout is pinnable. On Windows, without
/// an image, the root is `<exe dir>\data`, as in the zip. On Linux the
/// executable's directory is never a root: only an AppImage has one, the
/// first of `<image>.config` and `<image>.home` that exists as a folder,
/// which the user creates to make the image portable.
pub fn portable_root_for(dir: &Path, appimage: Option<&Path>) -> Option<PathBuf> {
    let Some(image) = appimage else {
        return (!cfg!(target_os = "linux")).then(|| dir.join(PORTABLE_DATA_DIR));
    };
    [".config", ".home"].into_iter().find_map(|suffix| {
        let mut beside = image.as_os_str().to_os_string();
        beside.push(suffix);
        let beside = PathBuf::from(beside);
        beside.is_dir().then(|| beside.join(APP_IDENTIFIER))
    })
}

/// The running AppImage file, when this process runs from one.
///
/// `$APPIMAGE` alone is not proof: a process started from another AppImage's
/// environment (a launcher, a terminal opened from one) inherits that image's
/// variable, and trusting it would put this copy's state in the other image's
/// portable folder and point autostart and scheduled runs at the other image.
/// The variable counts only while this executable runs from an image mount
/// ([`crate::engine::image_root`]).
pub fn appimage() -> Option<PathBuf> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    appimage_from(
        std::env::var_os(APPIMAGE_ENV).map(PathBuf::from),
        crate::engine::image_root().is_some(),
    )
}

pub(crate) fn appimage_from(image: Option<PathBuf>, runs_from_image: bool) -> Option<PathBuf> {
    image
        .filter(|_| runs_from_image)
        .filter(|image| image.is_absolute() && image.is_file())
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

/// The per-user configuration directory, the one Tauri's `app_config_dir`
/// names: `$XDG_CONFIG_HOME` (default `~/.config`) on Linux, the roaming
/// application data folder on Windows, under the bundle identifier. Resolved
/// without an app handle so the CLI and the engine environment read the same
/// place the window writes.
pub fn user_config_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        roaming_app_data().map(|config| config.join(APP_IDENTIFIER))
    }
    #[cfg(not(windows))]
    {
        xdg_config_home().map(|config| config.join(APP_IDENTIFIER))
    }
}

#[cfg(windows)]
fn roaming_app_data() -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_RoamingAppData, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
    let path = unsafe { SHGetKnownFolderPath(&FOLDERID_RoamingAppData, KF_FLAG_DEFAULT, None) }.ok()?;
    let text = unsafe { path.to_string() }.ok();
    unsafe { CoTaskMemFree(Some(path.0 as *const core::ffi::c_void)) };
    text.map(PathBuf::from).filter(|dir| dir.is_absolute())
}

/// Where this process keeps its records. Decided once per process
/// ([`root_decision`]) and read by every record — settings, session, logs, the
/// webview data folder and the colour-profile answer — so a volume that fills
/// or turns read-only mid-run cannot move some records and leave the rest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootDecision {
    /// This container has no portable root: the per-user folders.
    PerUser,
    /// The portable root accepted a new file and holds every record.
    Portable(PathBuf),
    /// The portable root could not be written: the per-user folders hold
    /// every new record.
    Fallback(PathBuf),
}

impl RootDecision {
    /// The portable root in force, or None for the per-user folders.
    pub fn root(&self) -> Option<&Path> {
        match self {
            RootDecision::Portable(root) => Some(root),
            _ => None,
        }
    }
}

/// Pure over the container, the image and a writability probe. The probe is
/// called once, on the portable root itself, and only when one exists.
pub fn decide_root(
    dir: &Path,
    container: Container,
    appimage: Option<&Path>,
    writable: impl FnOnce(&Path) -> bool,
) -> RootDecision {
    let preferred = match container {
        Container::Installed | Container::Package => None,
        Container::Portable => portable_root_for(dir, appimage),
    };
    match preferred {
        None => RootDecision::PerUser,
        Some(root) if writable(&root) => RootDecision::Portable(root),
        Some(root) => RootDecision::Fallback(root),
    }
}

static ROOT_DECISION: std::sync::OnceLock<RootDecision> = std::sync::OnceLock::new();

/// The running copy's decision, made on first use with a probe that creates
/// the portable root. A fallback is logged once, here.
pub fn root_decision() -> Result<&'static RootDecision, String> {
    if let Some(decision) = ROOT_DECISION.get() {
        return Ok(decision);
    }
    let dir = exe_dir()?;
    Ok(ROOT_DECISION.get_or_init(|| {
        let image = appimage();
        let decision = decide_root(
            &dir,
            container_for(&dir, image.as_deref()),
            image.as_deref(),
            ensure_writable_dir,
        );
        if let RootDecision::Fallback(root) = &decision {
            eprintln!(
                "{} cannot be written; settings, records and the colour-profile answer are kept \
                 in the per-user folders instead.",
                root.display()
            );
        }
        decision
    }))
}

/// The per-user root that takes a record when no portable root is in force.
pub fn resolve_root(decision: &RootDecision, standard: Option<PathBuf>) -> Option<PathBuf> {
    decision.root().map(Path::to_path_buf).or(standard)
}

/// Where a copy that asks in the app writes its answer, or None when it
/// writes none (installed) or has nowhere to write it: the portable root in
/// force, else the per-user configuration directory.
pub fn assent_write_dir(
    container: Container,
    decision: &RootDecision,
    user_config: Option<PathBuf>,
) -> Option<PathBuf> {
    match container {
        Container::Installed => None,
        _ => resolve_root(decision, user_config),
    }
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

/// The record beside a portable copy, whether or not it exists.
fn portable_record(dir: &Path, container: Container, appimage: Option<&Path>) -> Option<PathBuf> {
    if container != Container::Portable {
        return None;
    }
    portable_root_for(dir, appimage).map(|root| root.join(ICC_ASSENT_FILE))
}

/// The portable copy's own record, when it exists and reads as an answer.
fn readable_portable_record(
    dir: &Path,
    container: Container,
    appimage: Option<&Path>,
) -> Option<PathBuf> {
    portable_record(dir, container, appimage).filter(|record| read_accepted_flag(record).is_some())
}

/// The file the answer is read from, or None when no record reads as one.
///
/// A fixed order that no writability decision enters: (a) the installer's
/// record, which is the only record an installed copy has; (b) the record
/// beside a portable copy, when it reads as an answer; (c) the per-user
/// record. So a writer that could not use its preferred place, for whatever
/// reason, leaves an answer the next reader finds.
pub fn assent_read_path(
    dir: &Path,
    container: Container,
    appimage: Option<&Path>,
    user_config: Option<PathBuf>,
) -> Option<PathBuf> {
    if container == Container::Installed {
        return Some(dir.join(INSTALL_RECORD));
    }
    readable_portable_record(dir, container, appimage).or_else(|| {
        user_config
            .map(|config| config.join(ICC_ASSENT_FILE))
            .filter(|record| read_accepted_flag(record).is_some())
    })
}

/// The recorded assent, whichever container it is.
///
/// The installer's record wins when it exists, because in that container it is
/// the only record there is — the installer obtained the acceptance and the app
/// must not re-ask. A malformed or unreadable record is `Unrecorded` rather
/// than an assumed yes: an unreadable file has told us nothing.
pub fn icc_assent_for(
    dir: &Path,
    container: Container,
    appimage: Option<&Path>,
    user_config: Option<PathBuf>,
) -> IccAssent {
    let Some(record) = assent_read_path(dir, container, appimage, user_config) else {
        return IccAssent::Unrecorded;
    };
    match read_accepted_flag(&record) {
        Some(true) => IccAssent::Accepted,
        Some(false) => IccAssent::Declined,
        None => IccAssent::Unrecorded,
    }
}

fn write_answer_in(root: &Path, accepted: bool) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root)
        .map_err(|e| format!("Cannot create {}: {}", root.display(), e))?;
    let body = format!("{{\n  \"{ACCEPTED_KEY}\": {accepted}\n}}\n");
    let path = root.join(ICC_ASSENT_FILE);
    crate::staging::write_record(&path, body.as_bytes())
        .map_err(|e| format!("Cannot write {}: {}", path.display(), e))?;
    Ok(path)
}

/// Records the user's answer in a container that asks in the app.
///
/// The decision chooses only where a NEW answer goes: the portable root when
/// it is in force, else the per-user folder. A write to the portable root that
/// fails anyway (a race, a quota) falls to the per-user folder, which the
/// reader consults next. The answer must land where [`assent_read_path`]
/// finds it first: when a record beside the copy reads as an answer, the new
/// answer replaces that record, and when it cannot, the answer is refused by
/// name rather than written where that record would hide it.
///
/// Refuses in the installed container rather than writing a second record: two
/// records would give one machine two answers, and the installer's is the one
/// the licence terms were satisfied through.
pub fn record_icc_assent_for(
    dir: &Path,
    container: Container,
    appimage: Option<&Path>,
    decision: &RootDecision,
    user_config: Option<PathBuf>,
    accepted: bool,
) -> Result<(), String> {
    if container == Container::Installed {
        return Err(
            "This copy was installed, so its colour-profile licence acceptance was recorded \
             by the installer and cannot be changed here."
                .to_string(),
        );
    }
    if let Some(beside) = readable_portable_record(dir, container, appimage) {
        let root = beside.parent().map(Path::to_path_buf).unwrap_or_default();
        return write_answer_in(&root, accepted).map(|_| ()).map_err(|_| {
            format!(
                "The colour-profile answer is recorded in {}, which cannot be written, so it \
                 cannot be changed here.",
                beside.display()
            )
        });
    }
    let per_user = || -> Result<(), String> {
        let config = user_config
            .clone()
            .ok_or_else(|| "Cannot resolve the configuration folder.".to_string())?;
        write_answer_in(&config, accepted).map(|_| ())
    };
    match decision.root() {
        Some(root) => write_answer_in(root, accepted).map(|_| ()).or_else(|_| per_user()),
        None => per_user(),
    }
}

/// The running copy, as the resolvers above take it.
struct Running {
    dir: PathBuf,
    container: Container,
    appimage: Option<PathBuf>,
}

fn running() -> Result<Running, String> {
    let dir = exe_dir()?;
    let appimage = appimage();
    let container = container_for(&dir, appimage.as_deref());
    Ok(Running { dir, container, appimage })
}

/// What a status query reports for the running copy: its container, its
/// answer and the record the answer is read from. Reads only: no decision is
/// made and nothing is created.
pub struct AssentStatus {
    pub container: Container,
    pub assent: IccAssent,
    pub record: Option<PathBuf>,
}

pub fn assent_status() -> Result<AssentStatus, String> {
    let running = running()?;
    let image = running.appimage.as_deref();
    Ok(AssentStatus {
        container: running.container,
        assent: icc_assent_for(&running.dir, running.container, image, user_config_dir()),
        record: assent_read_path(&running.dir, running.container, image, user_config_dir()),
    })
}

/// The answer the engine is told. An executable path that cannot be resolved
/// has no record to read, which is `Unrecorded`.
pub fn icc_assent() -> IccAssent {
    assent_status().map_or(IccAssent::Unrecorded, |status| status.assent)
}

/// Records the running copy's answer at the process's one root decision.
pub fn record_running_assent(accepted: bool) -> Result<(), String> {
    let running = running()?;
    record_icc_assent_for(
        &running.dir,
        running.container,
        running.appimage.as_deref(),
        root_decision()?,
        user_config_dir(),
        accepted,
    )
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

/// Where the webview keeps its user data folder, read off the process's one
/// root decision.
///
/// The folder holds localStorage, and localStorage is where every app setting,
/// the recent-file list and each window's `workbench-ui`/`snap-ui`/
/// `takeoff-ui`/`spectra-toolbar` key live — so a portable copy keeps it under
/// its portable root, or it would carry its files and abandon its settings.
/// Installed and packaged copies keep the webview's per-user default, the one
/// every prior release has written to. The override is supplied by an
/// administrator or test harness and outranks this app's default.
pub fn decide_webview_user_data(
    decision: &RootDecision,
    has_override: bool,
) -> WebViewUserDataDecision {
    if has_override {
        return WebViewUserDataDecision::UseDefault;
    }
    match decision {
        RootDecision::PerUser => WebViewUserDataDecision::UseDefault,
        RootDecision::Portable(root) => {
            WebViewUserDataDecision::SetPortable(root.join(WEBVIEW_DATA_DIR))
        }
        RootDecision::Fallback(_) => WebViewUserDataDecision::PortableFallback,
    }
}

/// Makes the process's root decision and applies it to the webview, before
/// any WebView2 environment is created.
///
/// Returns the folder actually in force, or None when the webview's default
/// is. A portable copy on read-only media falls back to the default rather
/// than failing to open a window, and a native warning names that the
/// settings will stay in this profile instead of traveling with the copy.
pub fn apply_webview_user_data() -> Option<PathBuf> {
    let decision = root_decision().ok()?;
    match decide_webview_user_data(decision, std::env::var_os(WEBVIEW_USER_DATA_ENV).is_some()) {
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
/// The same classification as [`writable_without_creating`], then the
/// creation: the creating and the non-creating decisions are one function of
/// the same filesystem facts. A creation that still fails (a race, a quota)
/// makes the decision a fallback, which readers never depend on.
fn ensure_writable_dir(dir: &Path) -> bool {
    writable_without_creating(dir) && std::fs::create_dir_all(dir).is_ok() && probe_file_in(dir)
}

/// Whether `dir` could hold a new file, examined without creating it and
/// without following anything first: a real folder is probed in place; a link
/// (a junction included) counts only when it resolves to a folder, which is
/// then probed; a dangling link or any other object at the name can never be
/// the root; an absent name is decided by its nearest existing ancestor under
/// the same rules. Every probe file is removed before returning.
fn writable_without_creating(dir: &Path) -> bool {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) => existing_folder_accepts_a_file(dir, &meta),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => dir
            .ancestors()
            .skip(1)
            .find_map(|ancestor| {
                std::fs::symlink_metadata(ancestor).ok().map(|meta| (ancestor, meta))
            })
            .is_some_and(|(ancestor, meta)| existing_folder_accepts_a_file(ancestor, &meta)),
        Err(_) => false,
    }
}

fn existing_folder_accepts_a_file(path: &Path, meta: &std::fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return std::fs::metadata(path).is_ok_and(|target| target.is_dir()) && probe_file_in(path);
    }
    meta.is_dir() && probe_file_in(path)
}

fn probe_file_in(dir: &Path) -> bool {
    tempfile::Builder::new()
        .prefix(".spectrapdf-write-probe-")
        .tempfile_in(dir)
        .is_ok()
}

// ── the writable data root ─────────────────────────────────────────────────

fn root_from(standard: Option<PathBuf>, what: &str) -> Result<PathBuf, String> {
    resolve_root(root_decision()?, standard)
        .ok_or_else(|| format!("Cannot resolve the {what} folder."))
}

/// Where per-user state is written: the portable root when the process's one
/// decision put it in force (`<exe dir>\data` on Windows, an AppImage's
/// `<image>.config` or `<image>.home` folder on Linux), the standard per-user
/// directory otherwise.
///
/// One root for everything a portable copy must carry with it — dictionaries,
/// batch and operation logs, the session, the pre-window startup flags, the
/// extracted portfolio members — so a copy on a stick leaves nothing behind in
/// the profile of whatever machine it was plugged into. It is the same root
/// the webview user data folder uses, and it shares that folder's fallback: a
/// copy on read-only media falls back to the standard directory rather than
/// failing the feature.
///
/// After a fallback these records are read from the standard directory too,
/// not from an older copy left in the portable root: reading some files from
/// one root while writing them to another would split one set of records, and
/// the startup warning already names that existing settings do not move. The
/// startup flags, the session and the watched-folder list are rewritten as the
/// user works: reading a stale copy beside the media while writing per-user would
/// make every later change invisible, so they keep one root for both. The
/// colour-profile answer is the one exception ([`assent_read_path`]): it is a
/// licence decision written once, and asking it again would look like a lost
/// answer.
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
    let status = assent_status()?;
    let icc = PathBuf::from(crate::engine::get_icc_path(&app));
    let license = icc.join("Adobe-Color-Profile-License.txt");
    Ok(AssentState {
        portable: status.container.asks_in_app(),
        assent: status.assent,
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
    record_running_assent(accepted)?;
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

    fn no_probe(_: &Path) -> bool {
        panic!("this container must not probe a folder beside its executable")
    }

    /// Every path under `root` with its bytes, for byte-identity checks.
    fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    out.push((path.clone(), Vec::new()));
                    stack.push(path);
                } else {
                    out.push((path.clone(), std::fs::read(&path).unwrap()));
                }
            }
        }
        out.sort();
        out
    }

    fn write_answer(path: &Path, accepted: bool) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, format!("{{\"{ACCEPTED_KEY}\": {accepted}}}")).unwrap();
    }

    /// A package's tree: `usr/bin` holds the executable and `usr/lib/<product>`
    /// the resources, with nothing writable beside the executable.
    fn package_tree(root: &Path) -> PathBuf {
        let bin = root.join("usr").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(root.join("usr").join("lib").join("spectrapdf")).unwrap();
        bin
    }

    /// An image file with its `.config` portable folder beside it.
    fn portable_image(root: &Path) -> (PathBuf, PathBuf) {
        let image = root.join("Spectra_PDF.AppImage");
        std::fs::write(&image, b"").unwrap();
        let beside = root.join("Spectra_PDF.AppImage.config");
        std::fs::create_dir_all(&beside).unwrap();
        (image, beside.join(APP_IDENTIFIER))
    }

    #[test]
    fn the_installer_marker_is_what_separates_the_containers() {
        let dir = scratch("container");
        // A zip's tree, wherever it was extracted to.
        assert_eq!(container_for(&dir, None), Container::Portable);
        // The same directory, once the installer's hook has run in it. Nothing
        // about the PATH changed, which is the point.
        std::fs::write(dir.join(INSTALL_RECORD), r#"{"adobeIccEulaAccepted":true}"#).unwrap();
        assert_eq!(container_for(&dir, None), Container::Installed);
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
        let decision = decide_root(&dir, Container::Installed, None, no_probe);
        assert_eq!(decision, RootDecision::PerUser);
        let read = || icc_assent_for(&dir, Container::Installed, None, None);
        assert_eq!(read(), IccAssent::Accepted);
        // And it is not asked again, nor overwritten from inside the app.
        assert!(record_icc_assent_for(&dir, Container::Installed, None, &decision, None, false).is_err());
        assert_eq!(read(), IccAssent::Accepted);
        assert!(!Container::Installed.asks_in_app());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_portable_copy_starts_unrecorded_and_keeps_both_answers() {
        let dir = scratch("portable-assent");
        let config = dir.join("per-user").join(APP_IDENTIFIER);
        let decision = decide_root(&dir, Container::Portable, None, ensure_writable_dir);
        let read = || icc_assent_for(&dir, Container::Portable, None, Some(config.clone()));
        let record = |accepted| {
            record_icc_assent_for(&dir, Container::Portable, None, &decision, Some(config.clone()), accepted)
        };
        assert_eq!(read(), IccAssent::Unrecorded);

        record(false).unwrap();
        // Declining is RECORDED: the dialog must not reappear every launch.
        assert_eq!(read(), IccAssent::Declined);
        assert_eq!(assent_env_value(read()), "0");

        record(true).unwrap();
        assert_eq!(read(), IccAssent::Accepted);
        assert_eq!(assent_env_value(read()), "1");
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
        let decision = decide_root(&dir, Container::Portable, None, ensure_writable_dir);
        let read = || icc_assent_for(&dir, Container::Portable, None, None);
        assert_eq!(read(), IccAssent::Unrecorded);
        let mut writer = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        writer.wait().unwrap();
        let orphan = crate::staging::stage_path(&record, writer.id());
        std::fs::write(&orphan, "{\n  \"adobeIccEulaAccepted\": tr").unwrap();

        record_icc_assent_for(&dir, Container::Portable, None, &decision, None, true).unwrap();

        assert_eq!(read(), IccAssent::Accepted);
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
        assert_eq!(
            icc_assent_for(&dir, Container::Installed, None, None),
            IccAssent::Unrecorded
        );
        assert_eq!(assent_env_value(IccAssent::Unrecorded), "0");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_oversized_assent_record_is_not_loaded() {
        let dir = scratch("oversized-assent");
        let mut record = format!(r#"{{"{ACCEPTED_KEY}":true}}"#);
        record.push_str(&" ".repeat(MAX_ASSENT_RECORD_BYTES as usize + 1));
        std::fs::write(dir.join(INSTALL_RECORD), record).unwrap();

        assert_eq!(
            icc_assent_for(&dir, Container::Installed, None, None),
            IccAssent::Unrecorded
        );
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

    #[cfg(windows)]
    #[test]
    fn a_windows_zip_decides_its_data_folder_and_an_installed_copy_does_not_probe() {
        let dir = PathBuf::from(r"D:\Tools\SpectraPDF");
        let root = dir.join(PORTABLE_DATA_DIR);
        assert_eq!(
            decide_root(&dir, Container::Portable, None, |probed| {
                assert_eq!(probed, root, "the probe runs on the data folder itself");
                true
            }),
            RootDecision::Portable(root.clone())
        );
        assert_eq!(
            decide_root(&dir, Container::Portable, None, |_| false),
            RootDecision::Fallback(root)
        );
        assert_eq!(decide_root(&dir, Container::Installed, None, no_probe), RootDecision::PerUser);
    }

    #[test]
    fn the_webview_folder_follows_the_one_root_decision() {
        let root = std::env::temp_dir().join("portable-root");
        assert_eq!(
            decide_webview_user_data(&RootDecision::Portable(root.clone()), false),
            WebViewUserDataDecision::SetPortable(root.join(WEBVIEW_DATA_DIR)),
        );
        assert_eq!(
            decide_webview_user_data(&RootDecision::Fallback(root.clone()), false),
            WebViewUserDataDecision::PortableFallback,
        );
        // Installed and packaged copies keep the webview's own per-user
        // default; relocating it would strand every existing user's settings.
        assert_eq!(
            decide_webview_user_data(&RootDecision::PerUser, false),
            WebViewUserDataDecision::UseDefault,
        );
        // An explicit folder from an administrator or harness takes precedence.
        assert_eq!(
            decide_webview_user_data(&RootDecision::Portable(root), true),
            WebViewUserDataDecision::UseDefault,
        );
    }

    /// Once made, the decision is what every record writes to: a portable
    /// root that becomes writable (or unwritable) mid-run moves nothing,
    /// because no record probes again.
    #[test]
    fn every_record_follows_one_decision_and_a_made_decision_is_never_reprobed() {
        let root = std::env::temp_dir().join("portable-root");
        let standard = std::env::temp_dir().join("per-user");
        let config = std::env::temp_dir().join("per-user-config");

        let fallback = RootDecision::Fallback(root.clone());
        assert_eq!(resolve_root(&fallback, Some(standard.clone())), Some(standard.clone()));
        assert_eq!(resolve_root(&fallback, Some(config.clone())), Some(config.clone()));
        assert_eq!(
            assent_write_dir(Container::Portable, &fallback, Some(config.clone())),
            Some(config.clone())
        );
        assert_eq!(decide_webview_user_data(&fallback, false), WebViewUserDataDecision::PortableFallback);

        let portable = RootDecision::Portable(root.clone());
        assert_eq!(resolve_root(&portable, Some(standard.clone())), Some(root.clone()));
        assert_eq!(
            assent_write_dir(Container::Portable, &portable, Some(config.clone())),
            Some(root.clone())
        );
        assert_eq!(
            decide_webview_user_data(&portable, false),
            WebViewUserDataDecision::SetPortable(root.join(WEBVIEW_DATA_DIR))
        );

        // With nowhere left to write, the caller is told rather than handed a
        // path that does not exist.
        assert_eq!(resolve_root(&fallback, None), None);

        let mut probes = 0;
        decide_root(Path::new("/x"), Container::Portable, None, |_| {
            probes += 1;
            true
        });
        assert!(probes <= 1);
    }

    /// The record beside the copy wins for that copy over the per-user one,
    /// so a new answer replaces that record; when its folder is read-only the
    /// answer is refused by name rather than written where it would be hidden.
    #[test]
    fn an_answer_beside_the_copy_wins_and_a_new_answer_replaces_it_or_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("mount");
        std::fs::create_dir_all(&mount).unwrap();
        let (image, root) = portable_image(temp.path());
        let config = temp.path().join("roaming").join(APP_IDENTIFIER);
        write_answer(&root.join(ICC_ASSENT_FILE), true);
        write_answer(&config.join(ICC_ASSENT_FILE), false);
        let image = Some(image.as_path());
        let read = || icc_assent_for(&mount, Container::Portable, image, Some(config.clone()));

        assert_eq!(
            assent_read_path(&mount, Container::Portable, image, Some(config.clone())),
            Some(root.join(ICC_ASSENT_FILE))
        );
        assert_eq!(read(), IccAssent::Accepted);

        // Whatever the decision, the new answer lands where it is read first.
        let fallback = RootDecision::Fallback(root.clone());
        record_icc_assent_for(&mount, Container::Portable, image, &fallback, Some(config.clone()), false)
            .unwrap();
        assert_eq!(read(), IccAssent::Declined);

        if let Some(_guard) = ReadOnly::new(&root) {
            let refused = record_icc_assent_for(
                &mount, Container::Portable, image, &fallback, Some(config.clone()), true,
            )
            .unwrap_err();
            assert!(refused.contains("cannot be written"), "{refused}");
            assert_eq!(read(), IccAssent::Declined);
        }

        // An unreadable record beside the copy tells nothing; the per-user
        // record answers.
        std::fs::write(root.join(ICC_ASSENT_FILE), "garbled").unwrap();
        write_answer(&config.join(ICC_ASSENT_FILE), true);
        assert_eq!(read(), IccAssent::Accepted);
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_zip_on_read_only_media_keeps_its_recorded_answer() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("zip");
        write_answer(&dir.join(PORTABLE_DATA_DIR).join(ICC_ASSENT_FILE), false);
        let config = temp.path().join("roaming").join(APP_IDENTIFIER);
        let read_only = decide_root(&dir, Container::Portable, None, |_| false);
        assert_eq!(read_only, RootDecision::Fallback(dir.join(PORTABLE_DATA_DIR)));
        assert_eq!(
            icc_assent_for(&dir, Container::Portable, None, Some(config)),
            IccAssent::Declined
        );
    }

    #[cfg(windows)]
    #[test]
    fn an_unwritable_windows_zip_reads_back_the_answer_it_recorded_per_user() {
        let temp = tempfile::tempdir().unwrap();
        let blocked = temp.path().join("zip");
        std::fs::create_dir_all(&blocked).unwrap();
        // A file where the root folder belongs: the root cannot be created.
        std::fs::write(blocked.join(PORTABLE_DATA_DIR), b"").unwrap();
        let config = temp.path().join("roaming").join(APP_IDENTIFIER);
        let decision = decide_root(&blocked, Container::Portable, None, ensure_writable_dir);
        assert_eq!(decision, RootDecision::Fallback(blocked.join(PORTABLE_DATA_DIR)));
        record_icc_assent_for(&blocked, Container::Portable, None, &decision, Some(config.clone()), true)
            .unwrap();
        assert!(config.join(ICC_ASSENT_FILE).is_file());
        assert_eq!(
            icc_assent_for(&blocked, Container::Portable, None, Some(config)),
            IccAssent::Accepted
        );
    }

    /// The writer and a fresh reader decide from the same facts: an answer
    /// saved by one process is the answer a brand-new non-creating decision
    /// reads back, when a file occupies the portable root's name.
    #[test]
    fn a_fresh_reader_finds_the_answer_saved_past_a_file_in_the_roots_place() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("mount");
        std::fs::create_dir_all(&mount).unwrap();
        let (image, root) = portable_image(temp.path());
        std::fs::write(&root, b"not a folder").unwrap();
        let config = temp.path().join("roaming").join(APP_IDENTIFIER);
        let image = Some(image.as_path());

        let writer = decide_root(&mount, Container::Portable, image, ensure_writable_dir);
        assert_eq!(writer, RootDecision::Fallback(root.clone()));
        record_icc_assent_for(&mount, Container::Portable, image, &writer, Some(config.clone()), true)
            .unwrap();

        let reader = decide_root(&mount, Container::Portable, image, writable_without_creating);
        assert_eq!(reader, writer);
        assert_eq!(
            icc_assent_for(&mount, Container::Portable, image, Some(config.clone())),
            IccAssent::Accepted
        );
        assert_eq!(
            assent_read_path(&mount, Container::Portable, image, Some(config.clone())),
            Some(config.join(ICC_ASSENT_FILE))
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_fresh_reader_of_a_windows_zip_with_a_file_named_data_reads_the_saved_answer() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("zip");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(PORTABLE_DATA_DIR), b"").unwrap();
        let config = temp.path().join("roaming").join(APP_IDENTIFIER);

        let writer = decide_root(&dir, Container::Portable, None, ensure_writable_dir);
        record_icc_assent_for(&dir, Container::Portable, None, &writer, Some(config.clone()), false).unwrap();
        let reader = decide_root(&dir, Container::Portable, None, writable_without_creating);
        assert_eq!(reader, RootDecision::Fallback(dir.join(PORTABLE_DATA_DIR)));
        assert_eq!(
            icc_assent_for(&dir, Container::Portable, None, Some(config)),
            IccAssent::Declined
        );
    }

    /// A folder made read-only for the life of the guard: mode 0555 on Unix,
    /// a deny-write entry for everyone on Windows. None when the account
    /// ignores the restriction (an administrator, root), so the case cannot be
    /// arranged here.
    struct ReadOnly(PathBuf);

    impl ReadOnly {
        fn new(dir: &Path) -> Option<Self> {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o555)).ok()?;
            }
            #[cfg(windows)]
            {
                let status = std::process::Command::new("icacls")
                    .arg(dir)
                    .args(["/deny", "*S-1-1-0:(W)"])
                    .stdout(std::process::Stdio::null())
                    .status()
                    .ok()?;
                if !status.success() {
                    return None;
                }
            }
            let guard = ReadOnly(dir.to_path_buf());
            (!probe_file_in(dir)).then_some(guard)
        }
    }

    impl Drop for ReadOnly {
        fn drop(&mut self) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("icacls")
                    .arg(&self.0)
                    .args(["/remove:d", "*S-1-1-0"])
                    .stdout(std::process::Stdio::null())
                    .status();
            }
        }
    }

    /// Two processes: a writer that may create its root, then a fresh reader
    /// that may not. Returns both decisions and what the reader reads.
    fn writer_then_reader(
        dir: &Path,
        image: Option<&Path>,
        config: &Path,
    ) -> (RootDecision, RootDecision, IccAssent) {
        let writer = decide_root(dir, Container::Portable, image, ensure_writable_dir);
        record_icc_assent_for(dir, Container::Portable, image, &writer, Some(config.to_path_buf()), true)
            .unwrap();
        let reader = decide_root(dir, Container::Portable, image, writable_without_creating);
        let read = icc_assent_for(dir, Container::Portable, image, Some(config.to_path_buf()));
        (writer, reader, read)
    }

    /// An image whose portable folder exists, with `occupy` deciding what sits
    /// at the root's name. Returns the mount, the image, the root and the
    /// per-user folder.
    fn occupied_root(temp: &Path, occupy: impl FnOnce(&Path)) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let mount = temp.join("mount");
        std::fs::create_dir_all(&mount).unwrap();
        let (image, root) = portable_image(temp);
        occupy(&root);
        (mount, image, root, temp.join("per-user").join(APP_IDENTIFIER))
    }

    fn link_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
        }
    }

    fn link_file(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
    }

    /// The reviewer's case: an existing portable folder whose root entry is a
    /// link to nothing. Both decisions fall back, and the fresh reader finds
    /// the saved answer.
    #[test]
    fn a_dangling_link_at_the_root_is_a_fallback_for_writer_and_reader() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing-target");
        let mut linked = false;
        let (mount, image, _root, config) =
            occupied_root(temp.path(), |root| linked = link_dir(&missing, root));
        if !linked {
            return; // this account cannot create symbolic links
        }
        let (writer, reader, read) = writer_then_reader(&mount, Some(&image), &config);
        assert!(matches!(writer, RootDecision::Fallback(_)), "{writer:?}");
        assert_eq!(reader, writer);
        assert_eq!(read, IccAssent::Accepted);
        assert!(config.join(ICC_ASSENT_FILE).is_file());
    }

    #[test]
    fn a_link_to_a_file_at_the_root_is_a_fallback_for_writer_and_reader() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a-file");
        std::fs::write(&file, b"x").unwrap();
        let mut linked = false;
        let (mount, image, _root, config) =
            occupied_root(temp.path(), |root| linked = link_file(&file, root));
        if !linked {
            return;
        }
        let (writer, reader, read) = writer_then_reader(&mount, Some(&image), &config);
        assert!(matches!(writer, RootDecision::Fallback(_)), "{writer:?}");
        assert_eq!(reader, writer);
        assert_eq!(read, IccAssent::Accepted);
        assert_eq!(std::fs::read(&file).unwrap(), b"x");
    }

    #[test]
    fn a_link_to_a_writable_folder_is_the_root_for_writer_and_reader() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let mut linked = false;
        let (mount, image, root, config) =
            occupied_root(temp.path(), |root| linked = link_dir(&target, root));
        if !linked {
            return;
        }
        let (writer, reader, read) = writer_then_reader(&mount, Some(&image), &config);
        assert_eq!(writer, RootDecision::Portable(root));
        assert_eq!(reader, writer);
        assert_eq!(read, IccAssent::Accepted);
        assert!(target.join(ICC_ASSENT_FILE).is_file());
    }

    #[test]
    fn a_link_to_a_read_only_folder_is_a_fallback_for_writer_and_reader() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let mut linked = false;
        let (mount, image, _root, config) =
            occupied_root(temp.path(), |root| linked = link_dir(&target, root));
        if !linked {
            return;
        }
        let Some(_guard) = ReadOnly::new(&target) else { return };
        let (writer, reader, read) = writer_then_reader(&mount, Some(&image), &config);
        assert!(matches!(writer, RootDecision::Fallback(_)), "{writer:?}");
        assert_eq!(reader, writer);
        assert_eq!(read, IccAssent::Accepted);
    }

    #[test]
    fn a_read_only_root_folder_is_a_fallback_for_writer_and_reader() {
        let temp = tempfile::tempdir().unwrap();
        let (mount, image, root, config) =
            occupied_root(temp.path(), |root| std::fs::create_dir_all(root).unwrap());
        let Some(_guard) = ReadOnly::new(&root) else { return };
        let (writer, reader, read) = writer_then_reader(&mount, Some(&image), &config);
        assert_eq!(writer, RootDecision::Fallback(root));
        assert_eq!(reader, writer);
        assert_eq!(read, IccAssent::Accepted);
    }

    /// The root is absent and its parent cannot take a new folder: the
    /// read-only volume case, arranged with permissions.
    #[test]
    fn a_read_only_parent_of_an_absent_root_is_a_fallback_for_writer_and_reader() {
        let temp = tempfile::tempdir().unwrap();
        let (mount, image, root, config) = occupied_root(temp.path(), |_| {});
        let Some(_guard) = ReadOnly::new(root.parent().unwrap()) else { return };
        let (writer, reader, read) = writer_then_reader(&mount, Some(&image), &config);
        assert_eq!(writer, RootDecision::Fallback(root.clone()));
        assert_eq!(reader, writer);
        assert_eq!(read, IccAssent::Accepted);
        assert!(!root.exists());
    }

    #[cfg(windows)]
    fn junction(target: &Path, link: &Path) -> bool {
        std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_is_the_root_while_its_target_exists_and_a_fallback_after() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let (mount, image, root, config) =
            occupied_root(temp.path(), |root| assert!(junction(&target, root)));
        let (writer, reader, read) = writer_then_reader(&mount, Some(&image), &config);
        assert_eq!(writer, RootDecision::Portable(root.clone()));
        assert_eq!(reader, writer);
        assert_eq!(read, IccAssent::Accepted);
        assert!(target.join(ICC_ASSENT_FILE).is_file());

        // The same junction once its target is gone: dangling. The record
        // beside the copy went with the target, so the answer lands per user.
        std::fs::remove_dir_all(&target).unwrap();
        let (writer, reader, read) = writer_then_reader(&mount, Some(&image), &config);
        assert_eq!(writer, RootDecision::Fallback(root));
        assert_eq!(reader, writer);
        assert_eq!(read, IccAssent::Accepted);
        assert!(config.join(ICC_ASSENT_FILE).is_file());
    }

    /// The zip's `data` folder spelled in another case is the same folder on
    /// a case-insensitive volume: its record is read, and both decisions use it.
    #[cfg(windows)]
    #[test]
    fn a_data_folder_in_another_case_is_the_same_root_for_writer_and_reader() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("zip");
        let upper = dir.join("DATA");
        std::fs::create_dir_all(&upper).unwrap();
        write_answer(&upper.join(ICC_ASSENT_FILE), false);
        let config = temp.path().join("roaming").join(APP_IDENTIFIER);
        assert_eq!(
            icc_assent_for(&dir, Container::Portable, None, Some(config.clone())),
            IccAssent::Declined
        );
        let (writer, reader, read) = writer_then_reader(&dir, None, &config);
        assert_eq!(writer, RootDecision::Portable(dir.join(PORTABLE_DATA_DIR)));
        assert_eq!(reader, writer);
        assert_eq!(read, IccAssent::Accepted);
        assert!(!config.join(ICC_ASSENT_FILE).exists());
    }

    /// A status query creates nothing: the decision it reads is probed without
    /// creating the portable root, and the tree is byte-identical afterwards.
    #[test]
    fn a_status_query_leaves_a_fresh_portable_tree_byte_identical() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("mount");
        std::fs::create_dir_all(&mount).unwrap();
        let (image, root) = portable_image(temp.path());
        let config = temp.path().join("roaming").join(APP_IDENTIFIER);
        let check = |dir: &Path, image: Option<&Path>| {
            let before = snapshot(temp.path());
            let decision = decide_root(dir, Container::Portable, image, writable_without_creating);
            assert!(decision.root().is_some(), "{decision:?}");
            assert_eq!(
                icc_assent_for(dir, Container::Portable, image, Some(config.clone())),
                IccAssent::Unrecorded
            );
            assert_eq!(assent_read_path(dir, Container::Portable, image, Some(config.clone())), None);
            assert_eq!(snapshot(temp.path()), before);
        };
        check(&mount, Some(&image));
        assert!(!root.exists());
        #[cfg(windows)]
        {
            check(&mount, None);
            assert!(!mount.join(PORTABLE_DATA_DIR).exists());
        }
    }

    #[test]
    fn an_existing_data_directory_is_probed_for_file_creation() {
        let temp = tempfile::tempdir().unwrap();
        let existing = temp.path().join("data");
        std::fs::create_dir(&existing).unwrap();

        assert!(ensure_writable_dir(&existing));
        assert!(writable_without_creating(&existing));
        assert_eq!(std::fs::read_dir(&existing).unwrap().count(), 0);

        let blocked = temp.path().join("not-a-directory");
        std::fs::write(&blocked, b"file").unwrap();
        assert!(!ensure_writable_dir(&blocked));
        assert!(!writable_without_creating(&blocked.join("data")));
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
        // Windows keeps the zip's root beside the executable; Linux never
        // makes the executable's directory a root.
        let beside = if cfg!(target_os = "linux") {
            None
        } else {
            Some(payload.join(PORTABLE_DATA_DIR))
        };
        assert_eq!(portable_root_for(&payload, None), beside);
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
    fn an_inherited_appimage_variable_counts_only_inside_an_image() {
        let temp = tempfile::tempdir().unwrap();
        let image = temp.path().join("Other.AppImage");
        std::fs::write(&image, b"").unwrap();
        assert_eq!(appimage_from(Some(image.clone()), false), None);
        assert_eq!(appimage_from(Some(image.clone()), true), Some(image));
        assert_eq!(appimage_from(Some(PathBuf::from("relative.AppImage")), true), None);
        assert_eq!(appimage_from(None, true), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_package_launched_from_another_images_environment_stays_a_package() {
        let temp = tempfile::tempdir().unwrap();
        let bin = package_tree(&temp.path().join("root"));
        let (foreign, foreign_root) = portable_image(temp.path());
        let config = temp.path().join("home").join(".config").join(APP_IDENTIFIER);
        let exe = bin.join("spectrapdf");

        // The package does not run from an image mount, so the inherited
        // variable is not this copy's image.
        let image = appimage_from(Some(foreign.clone()), false);
        assert_eq!(image, None);
        assert_eq!(container_for(&bin, image.as_deref()), Container::Package);
        let decision = decide_root(&bin, Container::Package, image.as_deref(), no_probe);
        assert_eq!(decision, RootDecision::PerUser);
        assert_eq!(
            assent_write_dir(Container::Package, &decision, Some(config.clone())),
            Some(config)
        );
        assert!(!foreign_root.exists(), "the other image's portable folder was used");
        assert_eq!(
            crate::autostart_linux::launch_target_for(image, Ok(exe.clone())),
            Ok(exe)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_linux_package_layout_is_the_package_container() {
        let temp = tempfile::tempdir().unwrap();
        let bin = package_tree(temp.path());
        assert_eq!(container_for(&bin, None), Container::Package);
        assert!(Container::Package.asks_in_app());
        assert_eq!(decide_root(&bin, Container::Package, None, no_probe), RootDecision::PerUser);

        // The same layout mounted from an image is the AppImage, not a package.
        let image = temp.path().join("Spectra_PDF.AppImage");
        std::fs::write(&image, b"").unwrap();
        assert_eq!(container_for(&bin, Some(&image)), Container::Portable);

        // A cargo output directory carries its own engine and stays portable,
        // with no root beside its executable.
        let built = temp.path().join("target").join("debug");
        std::fs::create_dir_all(built.join("engine")).unwrap();
        assert_eq!(container_for(&built, None), Container::Portable);
        assert_eq!(decide_root(&built, Container::Portable, None, no_probe), RootDecision::PerUser);
    }

    #[cfg(windows)]
    #[test]
    fn a_package_layout_on_windows_stays_portable() {
        let temp = tempfile::tempdir().unwrap();
        let bin = package_tree(temp.path());
        assert_eq!(container_for(&bin, None), Container::Portable);
    }

    #[test]
    fn a_package_records_its_answer_in_the_user_configuration_folder() {
        let temp = tempfile::tempdir().unwrap();
        let bin = package_tree(temp.path());
        let config = temp.path().join("home").join(".config").join(APP_IDENTIFIER);
        let package = Container::Package;
        let decision = decide_root(&bin, package, None, no_probe);
        let read = || icc_assent_for(&bin, package, None, Some(config.clone()));

        assert_eq!(read(), IccAssent::Unrecorded);
        record_icc_assent_for(&bin, package, None, &decision, Some(config.clone()), true).unwrap();
        assert_eq!(
            assent_read_path(&bin, package, None, Some(config.clone())),
            Some(config.join(ICC_ASSENT_FILE))
        );
        // The next launch reads the same answer back: the dialog stays shut.
        assert_eq!(read(), IccAssent::Accepted);
        assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 0);

        // With no per-user folder there is nowhere to write, and the refusal
        // names that instead of falling back beside the executable.
        assert!(record_icc_assent_for(&bin, package, None, &decision, None, true).is_err());
        assert_eq!(std::fs::read_dir(&bin).unwrap().count(), 0);
    }

    #[test]
    fn an_appimage_records_beside_the_image_only_when_it_was_made_portable() {
        let temp = tempfile::tempdir().unwrap();
        let mount = package_tree(&temp.path().join("mount"));
        let image = temp.path().join("Spectra_PDF.AppImage");
        std::fs::write(&image, b"").unwrap();
        let config = temp.path().join("home").join(".config").join(APP_IDENTIFIER);
        let portable = Container::Portable;
        let image = Some(image.as_path());

        let decision = decide_root(&mount, portable, image, ensure_writable_dir);
        assert_eq!(decision, RootDecision::PerUser);
        record_icc_assent_for(&mount, portable, image, &decision, Some(config.clone()), false).unwrap();
        assert_eq!(
            icc_assent_for(&mount, portable, image, Some(config.clone())),
            IccAssent::Declined
        );

        let beside = temp.path().join("Spectra_PDF.AppImage.config");
        std::fs::create_dir_all(&beside).unwrap();
        let root = beside.join(APP_IDENTIFIER);
        let decision = decide_root(&mount, portable, image, ensure_writable_dir);
        assert_eq!(decision, RootDecision::Portable(root.clone()));
        // The per-user answer is still read until the portable folder has one.
        assert_eq!(
            icc_assent_for(&mount, portable, image, Some(config.clone())),
            IccAssent::Declined
        );
        record_icc_assent_for(&mount, portable, image, &decision, Some(config.clone()), true).unwrap();
        assert!(root.join(ICC_ASSENT_FILE).is_file());
        assert_eq!(
            icc_assent_for(&mount, portable, image, Some(config)),
            IccAssent::Accepted
        );
        assert_eq!(std::fs::read_dir(&mount).unwrap().count(), 0);
    }

    #[test]
    fn an_unresolvable_executable_is_a_refusal_never_the_working_directory() {
        assert!(exe_dir_from(Err(std::io::Error::other("gone"))).is_err());
        assert!(exe_dir_from(Ok(PathBuf::from("spectrapdf"))).is_err());
        let exe = std::env::temp_dir().join("spectrapdf");
        assert_eq!(exe_dir_from(Ok(exe.clone())), Ok(exe.parent().unwrap().to_path_buf()));
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
