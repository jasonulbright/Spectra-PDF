//! Registration of the File Explorer commands (Convert to PDF, Combine into
//! one PDF).
//!
//! One handler DLL serves two registrations, and exactly one of them is live
//! per machine and user:
//! - a sparse package (packaging with external location) whose manifest maps
//!   each accepted extension to the handler's CLSIDs. Only this reaches the
//!   Windows 11 top-level menu;
//! - classic static verbs whose `ExplorerCommandHandler` names the same
//!   CLSIDs, for every system the sparse package does not serve and as the
//!   fallback when Windows refuses the package.
//!
//! The installer registers machine-wide (`shell-menu install-machine`,
//! elevated) and for the installing user (`register-user`). A portable copy
//! registers nothing until the Preferences toggle registers it for the
//! current user, without elevation. `HKLM\SOFTWARE\Spectra PDF\
//! DisableExplorerMenu = 1` hides both verbs through the handler's
//! `GetState`, so removing the policy restores them without a reinstall.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// Shared with the handler crate, which uses the parts this crate does not.
#[allow(dead_code)]
#[path = "../shell-menu/src/ids.rs"]
pub(crate) mod ids;

use ids::Verb;

/// Windows 11 and later get the sparse package; earlier builds have no
/// top-level menu to reach, and the classic verbs are the documented
/// `IExplorerCommand` route into their only menu.
pub const SPARSE_MIN_BUILD: u32 = 22000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mechanism {
    Sparse,
    Classic,
    None,
}

impl Mechanism {
    fn as_str(self) -> &'static str {
        match self {
            Mechanism::Sparse => "sparse",
            Mechanism::Classic => "classic",
            Mechanism::None => "none",
        }
    }

    fn parse(text: &str) -> Option<Mechanism> {
        match text {
            "sparse" => Some(Mechanism::Sparse),
            "classic" => Some(Mechanism::Classic),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerKind {
    Installed,
    Portable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellMenuStatus {
    pub mechanism: Mechanism,
    pub registered: bool,
    pub visible: bool,
    pub managed: bool,
    pub container: ContainerKind,
    pub other_copy: bool,
    pub error: Option<String>,
}

pub fn plan(build: u32) -> Mechanism {
    if build >= SPARSE_MIN_BUILD {
        Mechanism::Sparse
    } else {
        Mechanism::Classic
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arch {
    X64,
    Arm64,
}

impl Arch {
    pub const fn dir(self) -> &'static str {
        match self {
            Arch::X64 => "x64",
            Arch::Arm64 => "arm64",
        }
    }
}

/// Where a copy keeps its handler files, relative to its executable.
pub struct Layout {
    pub root: PathBuf,
}

impl Layout {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }

    pub fn exe(&self) -> PathBuf {
        self.root.join("spectrapdf.exe")
    }

    pub fn dll(&self, arch: Arch) -> PathBuf {
        self.root
            .join("shell")
            .join(arch.dir())
            .join("spectrapdf_shell.dll")
    }

    pub fn msix(&self, arch: Arch) -> PathBuf {
        self.root
            .join("shell")
            .join(format!("{}_{}.msix", ids::PACKAGE_NAME, arch.dir()))
    }

    pub fn identity_file(&self) -> PathBuf {
        self.root.join("shell").join("package-identity.json")
    }
}

/// The identity the build stamped into both packages, read back from the
/// file written beside them.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct PackageIdentity {
    pub name: String,
    pub publisher: String,
    pub version: String,
}

impl PackageIdentity {
    pub fn read(layout: &Layout) -> Result<PackageIdentity, String> {
        let path = layout.identity_file();
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("The File Explorer command files are missing ({}): {e}", path.display()))?;
        let identity: PackageIdentity = serde_json::from_str(&text)
            .map_err(|e| format!("{} is malformed: {e}", path.display()))?;
        if identity.name != ids::PACKAGE_NAME {
            return Err(format!("{} names package {}", path.display(), identity.name));
        }
        Ok(identity)
    }

    pub fn family_name(&self) -> String {
        family_name(&self.name, &self.publisher)
    }
}

/// The 13-character publisher id Windows derives from the publisher subject:
/// the first 64 bits of SHA-256 over its UTF-16LE bytes, padded with one zero
/// bit to 65 and written as 13 Crockford base-32 digits.
pub fn publisher_id(publisher: &str) -> String {
    use sha2::{Digest, Sha256};
    const ALPHABET: &[u8; 32] = b"0123456789abcdefghjkmnpqrstvwxyz";
    let utf16: Vec<u8> = publisher.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let digest = Sha256::digest(&utf16);
    let mut bits: u128 = 0;
    for byte in &digest[..8] {
        bits = (bits << 8) | u128::from(*byte);
    }
    bits <<= 1;
    (0..13)
        .rev()
        .map(|group| ALPHABET[((bits >> (group * 5)) & 0x1f) as usize] as char)
        .collect()
}

pub fn family_name(name: &str, publisher: &str) -> String {
    format!("{name}_{}", publisher_id(publisher))
}

/// One value the classic registration writes, relative to a hive's
/// `Software\Classes`. An empty `name` is the key's default value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassicEntry {
    pub key: String,
    pub name: String,
    pub value: String,
}

pub fn verb_key(extension: &str, verb: Verb) -> String {
    format!(
        "Software\\Classes\\SystemFileAssociations\\.{extension}\\shell\\{}",
        verb.verb_id()
    )
}

pub fn clsid_key(verb: Verb) -> String {
    format!("Software\\Classes\\CLSID\\{{{}}}", verb.clsid())
}

/// The complete classic registration for one copy: a Player-model verb per
/// accepted extension, and the in-process server for each CLSID.
pub fn classic_keys(dll: &Path, exe: &Path) -> Vec<ClassicEntry> {
    let entry = |key: String, name: &str, value: String| ClassicEntry {
        key,
        name: name.to_string(),
        value,
    };
    let icon = format!("\"{}\",0", exe.display());
    let mut out = Vec::new();
    for verb in Verb::ALL {
        for extension in verb.extensions() {
            let key = verb_key(extension, verb);
            out.push(entry(key.clone(), "", verb.english_label().to_string()));
            out.push(entry(key.clone(), "ExplorerCommandHandler", format!("{{{}}}", verb.clsid())));
            out.push(entry(key.clone(), "MultiSelectModel", "Player".to_string()));
            out.push(entry(key, "Icon", icon.clone()));
        }
        let clsid = clsid_key(verb);
        out.push(entry(clsid.clone(), "", verb.english_label().to_string()));
        let server = format!("{clsid}\\InprocServer32");
        out.push(entry(server.clone(), "", dll.display().to_string()));
        out.push(entry(server, "ThreadingModel", "Apartment".to_string()));
    }
    out
}

/// The keys removal deletes, each with everything under it.
pub fn classic_removal_keys() -> Vec<String> {
    let mut out = Vec::new();
    for verb in Verb::ALL {
        for extension in verb.extensions() {
            out.push(verb_key(extension, verb));
        }
        out.push(clsid_key(verb));
    }
    out
}

/// Whether recorded in-process servers name a handler file that is gone.
pub fn stale_servers(servers: &[String], exists: &dyn Fn(&Path) -> bool) -> bool {
    servers.iter().any(|server| !exists(Path::new(server.trim_matches('"'))))
}

/// Exit codes of `spectrapdf shell-menu`.
pub const EXIT_DONE: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_FELL_BACK: i32 = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Done,
    /// The sparse package was refused and the classic verbs were written.
    FellBack(String),
    Failed(String),
}

impl Outcome {
    pub fn exit_code(&self) -> i32 {
        match self {
            Outcome::Done => EXIT_DONE,
            Outcome::FellBack(_) => EXIT_FELL_BACK,
            Outcome::Failed(_) => EXIT_FAILED,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum CliAction {
    InstallMachine,
    UninstallMachine,
    RegisterUser,
    UnregisterUser,
}

/// `spectrapdf shell-menu <action>`: the installer's entry point. It runs on
/// the CLI path, so it never starts a window, WebView2 or the single-instance
/// plugin.
pub fn run_cli(action: CliAction) -> i32 {
    let outcome = run_action(action);
    match &outcome {
        Outcome::Done => {}
        Outcome::FellBack(reason) => {
            eprintln!("shell-menu: the app package was refused; classic menu entries were registered: {reason}")
        }
        Outcome::Failed(reason) => eprintln!("error: {reason}"),
    }
    outcome.exit_code()
}

#[cfg(windows)]
fn run_action(action: CliAction) -> Outcome {
    match action {
        CliAction::InstallMachine => win::install_machine(),
        CliAction::UninstallMachine => win::uninstall_machine(),
        CliAction::RegisterUser => win::register_user(),
        CliAction::UnregisterUser => win::unregister_user(),
    }
}

#[cfg(not(windows))]
fn run_action(_action: CliAction) -> Outcome {
    Outcome::Failed(unsupported())
}

#[cfg(not(windows))]
fn unsupported() -> String {
    crate::platform::Unsupported::new(crate::platform::feature::EXPLORER_MENU).into()
}

/// Whether two folder paths name the same folder, as Windows compares them.
pub fn same_folder(a: &Path, b: &Path) -> bool {
    let key = |p: &Path| {
        let canonical = dunce::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        canonical
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_lowercase()
    };
    key(a) == key(b)
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_shell_menu_status() -> Result<ShellMenuStatus, String> {
    blocking(status).await
}

/// A registration failure is reported in the returned status, never as a
/// rejected invoke.
#[tauri::command]
pub async fn set_shell_menu_enabled(enabled: bool) -> Result<ShellMenuStatus, String> {
    blocking(move || set_enabled(enabled)).await
}

#[tauri::command]
pub async fn set_shell_menu_language(lng: String) -> Result<(), String> {
    set_language(&lng)
}

/// The launch-time repair failure, or "". Reading clears it. While the repair
/// is still running this waits for it, so a failure that lands after the
/// window mounted is still reported.
#[tauri::command]
pub async fn shell_menu_repair_notice(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    blocking(move || Ok(app.state::<RepairNotice>().take_when_finished())).await
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

/// The launch-time repair's outcome: running, or finished with its failure
/// text (or none).
pub struct RepairNotice {
    state: std::sync::Mutex<RepairState>,
    finished: std::sync::Condvar,
}

enum RepairState {
    Running,
    Finished(Option<String>),
}

impl RepairNotice {
    pub fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(RepairState::Finished(None)),
            finished: std::sync::Condvar::new(),
        }
    }

    fn begin(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = RepairState::Running;
        }
    }

    fn finish(&self, failure: Option<String>) {
        if let Ok(mut state) = self.state.lock() {
            *state = RepairState::Finished(failure);
        }
        self.finished.notify_all();
    }

    /// The failure text once the repair has finished, cleared by the read.
    fn take_when_finished(&self) -> String {
        let Ok(mut state) = self.state.lock() else {
            return String::new();
        };
        while matches!(*state, RepairState::Running) {
            state = match self.finished.wait(state) {
                Ok(state) => state,
                Err(_) => return String::new(),
            };
        }
        match std::mem::replace(&mut *state, RepairState::Finished(None)) {
            RepairState::Finished(failure) => failure.unwrap_or_default(),
            RepairState::Running => String::new(),
        }
    }
}

impl Default for RepairNotice {
    fn default() -> Self {
        Self::new()
    }
}

/// Bring this user's registration in line with this copy, off the main
/// thread: a moved portable copy re-registers at its new folder, an upgraded
/// installed copy registers its new package version, and classic entries
/// whose handler file is gone are removed. The outcome is held for the first
/// window that asks, however late it asks.
pub fn repair_at_launch(app: &tauri::AppHandle) {
    use tauri::Manager;
    app.state::<RepairNotice>().begin();
    let app = app.clone();
    std::thread::spawn(move || {
        let failure = std::panic::catch_unwind(repair)
            .unwrap_or_else(|_| Err("the File Explorer command repair stopped unexpectedly".into()))
            .err();
        app.state::<RepairNotice>().finish(failure);
    });
}

#[cfg(windows)]
fn status() -> Result<ShellMenuStatus, String> {
    Ok(win::status())
}

#[cfg(windows)]
fn set_enabled(enabled: bool) -> Result<ShellMenuStatus, String> {
    Ok(win::set_enabled(enabled))
}

#[cfg(windows)]
fn set_language(lng: &str) -> Result<(), String> {
    win::set_language(lng)
}

#[cfg(windows)]
fn repair() -> Result<(), String> {
    win::repair()
}

#[cfg(not(windows))]
fn status() -> Result<ShellMenuStatus, String> {
    Err(unsupported())
}

#[cfg(not(windows))]
fn set_enabled(_enabled: bool) -> Result<ShellMenuStatus, String> {
    Err(unsupported())
}

#[cfg(not(windows))]
fn set_language(_lng: &str) -> Result<(), String> {
    Err(unsupported())
}

#[cfg(not(windows))]
fn repair() -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::core::HSTRING;
    use windows::Management::Deployment::{
        AddPackageOptions, DeploymentOptions, DeploymentProgress, DeploymentResult,
        PackageManager, RemovalOptions, StagePackageOptions,
    };
    use winreg::enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WRITE,
    };
    use winreg::RegKey;

    const POLICY_VALUE: &str = "DisableExplorerMenu";
    const USER_KEY: &str = "Software\\Spectra PDF";
    const USER_VISIBLE_VALUE: &str = "ExplorerMenu";
    const USER_RECORD_KEY: &str = "Software\\Spectra PDF\\ExplorerMenu";
    /// The installer's product key, written by the 32-bit installer and so
    /// read through the 32-bit view. Its default value is the install folder.
    const PRODUCT_KEY: &str = "Software\\Jason Ulbright\\Spectra PDF";
    const MACHINE_RECORD_KEY: &str = "Software\\Jason Ulbright\\Spectra PDF\\ExplorerMenu";

    type Operation = windows_future::IAsyncOperationWithProgress<DeploymentResult, DeploymentProgress>;

    pub fn native_arch() -> Option<Arch> {
        use windows::Win32::System::SystemInformation::{
            IMAGE_FILE_MACHINE, IMAGE_FILE_MACHINE_AMD64, IMAGE_FILE_MACHINE_ARM64,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, IsWow64Process2};
        let mut process = IMAGE_FILE_MACHINE(0);
        let mut native = IMAGE_FILE_MACHINE(0);
        unsafe { IsWow64Process2(GetCurrentProcess(), &mut process, Some(&mut native)) }.ok()?;
        match native {
            IMAGE_FILE_MACHINE_AMD64 => Some(Arch::X64),
            IMAGE_FILE_MACHINE_ARM64 => Some(Arch::Arm64),
            _ => None,
        }
    }

    fn os_build() -> u32 {
        windows_version::OsVersion::current().build
    }

    fn layout() -> Result<Layout, String> {
        crate::portable::exe_dir().map(|dir| Layout::new(&dir))
    }

    fn container() -> Result<ContainerKind, String> {
        Ok(if crate::portable::is_portable()? {
            ContainerKind::Portable
        } else {
            ContainerKind::Installed
        })
    }

    pub fn managed() -> bool {
        crate::commands::machine_policy_set(POLICY_VALUE)
    }

    fn visible() -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(USER_KEY)
            .and_then(|key| key.get_value::<u32, _>(USER_VISIBLE_VALUE))
            .map(|value| value != 0)
            .unwrap_or(true)
    }

    fn set_visible(on: bool) -> Result<(), String> {
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(USER_KEY)
            .map_err(|e| e.to_string())?;
        key.set_value(USER_VISIBLE_VALUE, &u32::from(on))
            .map_err(|e| e.to_string())
    }

    /// The installed copy's folder, when it is not this copy's folder.
    fn installed_copy_elsewhere(here: &Path) -> bool {
        let folder: Option<String> = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(PRODUCT_KEY, KEY_READ | KEY_WOW64_32KEY)
            .and_then(|key| key.get_value(""))
            .ok();
        match folder {
            Some(folder) if !folder.trim().is_empty() => {
                let folder = PathBuf::from(folder.trim().trim_matches('"'));
                folder.join("spectrapdf.exe").is_file() && !same_folder(&folder, here)
            }
            _ => false,
        }
    }

    // ── records ─────────────────────────────────────────────────────────────

    struct Record {
        mechanism: Option<Mechanism>,
        error: Option<String>,
    }

    fn user_record() -> Option<RegKey> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(USER_RECORD_KEY)
            .ok()
    }

    fn user_record_writable() -> Result<RegKey, String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(USER_RECORD_KEY)
            .map(|(key, _)| key)
            .map_err(|e| e.to_string())
    }

    fn machine_record() -> Option<RegKey> {
        RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(MACHINE_RECORD_KEY, KEY_READ | KEY_WOW64_32KEY)
            .ok()
    }

    fn read_record(key: Option<RegKey>) -> Record {
        let text = |name: &str| -> Option<String> {
            key.as_ref()
                .and_then(|k| k.get_value::<String, _>(name).ok())
                .filter(|v| !v.is_empty())
        };
        Record {
            mechanism: text("Mechanism").as_deref().and_then(Mechanism::parse),
            error: text("Error"),
        }
    }

    fn write_record(key: &RegKey, mechanism: Mechanism, error: Option<&str>) -> Result<(), String> {
        key.set_value("Mechanism", &mechanism.as_str())
            .map_err(|e| e.to_string())?;
        match error {
            Some(text) => key.set_value("Error", &text).map_err(|e| e.to_string()),
            None => {
                let _ = key.delete_value("Error");
                Ok(())
            }
        }
    }

    fn record_user(mechanism: Mechanism, error: Option<&str>, location: Option<&Path>) {
        if let Ok(key) = user_record_writable() {
            let _ = write_record(&key, mechanism, error);
            if let Some(location) = location {
                let _ = key.set_value("Location", &location.display().to_string());
            }
        }
    }

    fn record_user_error(error: &str) {
        if let Ok(key) = user_record_writable() {
            let _ = key.set_value("Error", &error);
        }
    }

    fn record_machine(mechanism: Mechanism, error: Option<&str>) {
        if let Ok((key, _)) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .create_subkey_with_flags(MACHINE_RECORD_KEY, KEY_READ | KEY_WRITE | KEY_WOW64_32KEY)
        {
            let _ = write_record(&key, mechanism, error);
        }
    }

    fn clear_user_record() {
        if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(USER_RECORD_KEY, KEY_READ | KEY_WRITE)
        {
            for name in ["Mechanism", "Error", "Location", "RegisteredVersion"] {
                let _ = key.delete_value(name);
            }
        }
    }

    fn recorded_location() -> Option<PathBuf> {
        user_record()
            .and_then(|key| key.get_value::<String, _>("Location").ok())
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    }

    fn registered_version() -> Option<String> {
        user_record().and_then(|key| key.get_value::<String, _>("RegisteredVersion").ok())
    }

    fn record_registered_version() {
        if let Ok(key) = user_record_writable() {
            let _ = key.set_value("RegisteredVersion", &env!("CARGO_PKG_VERSION"));
        }
    }

    pub fn set_language(lng: &str) -> Result<(), String> {
        user_record_writable()?
            .set_value("Language", &lng)
            .map_err(|e| e.to_string())
    }

    // ── classic verbs ───────────────────────────────────────────────────────

    fn write_classic(hive: &RegKey, layout: &Layout, arch: Arch) -> Result<(), String> {
        let dll = layout.dll(arch);
        if !dll.is_file() {
            return Err(format!("The File Explorer command handler is missing: {}", dll.display()));
        }
        for entry in classic_keys(&dll, &layout.exe()) {
            let (key, _) = hive.create_subkey(&entry.key).map_err(|e| e.to_string())?;
            key.set_value(&entry.name, &entry.value)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn remove_classic(hive: &RegKey) {
        for key in classic_removal_keys() {
            let _ = hive.delete_subkey_all(&key);
        }
    }

    /// Whether `hive` holds a classic registration naming this copy's handler.
    fn classic_present(hive: &RegKey, layout: &Layout, arch: Arch) -> bool {
        let wanted = layout.dll(arch);
        Verb::ALL.iter().all(|verb| {
            hive.open_subkey(format!("{}\\InprocServer32", clsid_key(*verb)))
                .and_then(|key| key.get_value::<String, _>(""))
                .map(|server| same_file_path(Path::new(&server), &wanted))
                .unwrap_or(false)
        })
    }

    fn classic_foreign(hive: &RegKey, layout: &Layout, arch: Arch) -> bool {
        let wanted = layout.dll(arch);
        Verb::ALL.iter().any(|verb| {
            hive.open_subkey(format!("{}\\InprocServer32", clsid_key(*verb)))
                .and_then(|key| key.get_value::<String, _>(""))
                .map(|server| !same_file_path(Path::new(&server), &wanted))
                .unwrap_or(false)
        })
    }

    /// Per-user classic entries left by a copy that was uninstalled or deleted
    /// name a handler file that no longer exists; they are removed so the verb
    /// does not linger with nothing behind it.
    fn remove_stale_classic(hive: &RegKey) {
        let servers: Vec<String> = Verb::ALL
            .iter()
            .filter_map(|verb| {
                hive.open_subkey(format!("{}\\InprocServer32", clsid_key(*verb)))
                    .and_then(|key| key.get_value::<String, _>(""))
                    .ok()
            })
            .collect();
        if stale_servers(&servers, &|p: &Path| p.is_file()) {
            remove_classic(hive);
        }
    }

    fn same_file_path(a: &Path, b: &Path) -> bool {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    }

    fn hklm() -> RegKey {
        RegKey::predef(HKEY_LOCAL_MACHINE)
    }

    fn hkcu() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    fn notify_shell() {
        use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    }

    // ── packages ────────────────────────────────────────────────────────────

    fn file_uri(path: &Path, folder: bool) -> Result<windows::Foundation::Uri, String> {
        let url = if folder {
            url::Url::from_directory_path(path)
        } else {
            url::Url::from_file_path(path)
        }
        .map_err(|_| format!("{} is not an absolute path", path.display()))?;
        windows::Foundation::Uri::CreateUri(&HSTRING::from(url.as_str())).map_err(|e| e.message())
    }

    fn describe(error: &windows::core::Error) -> String {
        format!("{} (0x{:08X})", error.message().trim(), error.code().0 as u32)
    }

    fn finish(operation: windows::core::Result<Operation>) -> Result<(), String> {
        let operation = operation.map_err(|e| describe(&e))?;
        match operation.join() {
            Ok(result) => match result.ExtendedErrorCode() {
                Ok(code) if code.is_err() => Err(result
                    .ErrorText()
                    .map(|t| t.to_string())
                    .unwrap_or_else(|_| windows::core::Error::from(code).message())),
                _ => Ok(()),
            },
            Err(error) => {
                let text = operation
                    .GetResults()
                    .ok()
                    .and_then(|result| result.ErrorText().ok())
                    .map(|text| text.to_string())
                    .filter(|text| !text.trim().is_empty());
                Err(match text {
                    Some(text) => format!("{} (0x{:08X})", text.trim(), error.code().0 as u32),
                    None => describe(&error),
                })
            }
        }
    }

    fn manager() -> Result<PackageManager, String> {
        PackageManager::new().map_err(|e| describe(&e))
    }

    struct Found {
        full_name: String,
        family_name: String,
    }

    fn found(packages: windows::core::Result<impl IntoIterator<Item = windows::ApplicationModel::Package>>) -> Vec<Found> {
        let Ok(packages) = packages else {
            return Vec::new();
        };
        packages
            .into_iter()
            .filter_map(|package| {
                let id = package.Id().ok()?;
                (id.Name().ok()?.to_string() == ids::PACKAGE_NAME).then(|| Found {
                    full_name: id.FullName().map(|n| n.to_string()).unwrap_or_default(),
                    family_name: id.FamilyName().map(|n| n.to_string()).unwrap_or_default(),
                })
            })
            .collect()
    }

    fn user_packages(pm: &PackageManager) -> Vec<Found> {
        found(pm.FindPackagesByUserSecurityId(&HSTRING::new()))
    }

    fn user_has_family(family: &str) -> bool {
        manager()
            .map(|pm| user_packages(&pm).iter().any(|p| p.family_name == family))
            .unwrap_or(false)
    }

    /// Every registration of the package name for every user, whatever its
    /// publisher: a changed signing subject changes the family, and the old
    /// family would otherwise keep a second copy of each verb.
    fn remove_all_users(pm: &PackageManager, family: Option<&str>) -> Result<(), String> {
        let mut candidates = found(pm.FindPackages());
        if let Ok(provisioned) = pm.FindProvisionedPackages() {
            candidates.extend(found(Ok(provisioned)));
        }
        let mut families: Vec<String> = candidates.iter().map(|c| c.family_name.clone()).collect();
        if let Some(family) = family {
            families.push(family.to_string());
        }
        families.sort();
        families.dedup();
        for family in &families {
            let _ = finish(pm.DeprovisionPackageForAllUsersAsync(&HSTRING::from(family.as_str())));
        }
        let mut names: Vec<String> = candidates.into_iter().map(|c| c.full_name).collect();
        names.sort();
        names.dedup();
        let mut failure = None;
        for name in names.iter().filter(|n| !n.is_empty()) {
            if let Err(e) = finish(pm.RemovePackageWithOptionsAsync(
                &HSTRING::from(name.as_str()),
                RemovalOptions::RemoveForAllUsers,
            )) {
                failure = Some(format!("{name}: {e}"));
            }
        }
        failure.map_or(Ok(()), Err)
    }

    fn remove_user_packages(pm: &PackageManager) -> Result<(), String> {
        let mut failure = None;
        for package in user_packages(pm) {
            if let Err(e) = finish(pm.RemovePackageAsync(&HSTRING::from(package.full_name.as_str()))) {
                failure = Some(format!("{}: {e}", package.full_name));
            }
        }
        failure.map_or(Ok(()), Err)
    }

    fn stage_and_provision(pm: &PackageManager, layout: &Layout, arch: Arch, family: &str) -> Result<(), String> {
        let msix = layout.msix(arch);
        if !msix.is_file() {
            return Err(format!("The File Explorer command package is missing: {}", msix.display()));
        }
        let options = StagePackageOptions::new().map_err(|e| describe(&e))?;
        options
            .SetExternalLocationUri(&file_uri(&layout.root, true)?)
            .map_err(|e| describe(&e))?;
        finish(pm.StagePackageByUriAsync(&file_uri(&msix, false)?, &options))?;
        finish(pm.ProvisionPackageForAllUsersAsync(&HSTRING::from(family)))
    }

    fn add_for_user(pm: &PackageManager, layout: &Layout, arch: Arch) -> Result<(), String> {
        let msix = layout.msix(arch);
        if !msix.is_file() {
            return Err(format!("The File Explorer command package is missing: {}", msix.display()));
        }
        let options = AddPackageOptions::new().map_err(|e| describe(&e))?;
        options
            .SetExternalLocationUri(&file_uri(&layout.root, true)?)
            .map_err(|e| describe(&e))?;
        finish(pm.AddPackageByUriAsync(&file_uri(&msix, false)?, &options))
    }

    fn register_family_for_user(pm: &PackageManager, family: &str) -> Result<(), String> {
        finish(pm.RegisterPackageByFamilyNameAndOptionalPackagesAsync(
            &HSTRING::from(family),
            None::<&windows_collections::IIterable<HSTRING>>,
            DeploymentOptions::None,
            None::<&windows::Management::Deployment::PackageVolume>,
            None::<&windows_collections::IIterable<HSTRING>>,
        ))
    }

    // ── operations ──────────────────────────────────────────────────────────

    fn unsupported_arch() -> Outcome {
        Outcome::Failed("This processor architecture has no File Explorer command handler.".to_string())
    }

    pub fn install_machine() -> Outcome {
        let Some(arch) = native_arch() else {
            return unsupported_arch();
        };
        let layout = match layout() {
            Ok(layout) => layout,
            Err(refusal) => return Outcome::Failed(refusal),
        };
        let identity = PackageIdentity::read(&layout);
        let family = identity.as_ref().ok().map(PackageIdentity::family_name);
        if let Ok(pm) = manager() {
            let _ = remove_all_users(&pm, family.as_deref());
        }
        remove_classic(&hklm());

        let outcome = match plan(os_build()) {
            Mechanism::Sparse => {
                let sparse = identity
                    .and_then(|identity| {
                        let pm = manager()?;
                        stage_and_provision(&pm, &layout, arch, &identity.family_name())
                    });
                match sparse {
                    Ok(()) => {
                        record_machine(Mechanism::Sparse, None);
                        Outcome::Done
                    }
                    Err(refused) => match write_classic(&hklm(), &layout, arch) {
                        Ok(()) => {
                            record_machine(Mechanism::Classic, Some(&refused));
                            Outcome::FellBack(refused)
                        }
                        Err(e) => {
                            record_machine(Mechanism::None, Some(&e));
                            Outcome::Failed(format!("{refused}; {e}"))
                        }
                    },
                }
            }
            _ => match write_classic(&hklm(), &layout, arch) {
                Ok(()) => {
                    record_machine(Mechanism::Classic, None);
                    Outcome::Done
                }
                Err(e) => {
                    record_machine(Mechanism::None, Some(&e));
                    Outcome::Failed(e)
                }
            },
        };
        notify_shell();
        outcome
    }

    pub fn uninstall_machine() -> Outcome {
        let layout = layout().ok();
        let family = layout
            .as_ref()
            .and_then(|layout| PackageIdentity::read(layout).ok())
            .map(|i| i.family_name());
        let removal = manager().and_then(|pm| remove_all_users(&pm, family.as_deref()));
        remove_classic(&hklm());
        // The elevating account's own per-user fallback keys, when they name
        // this copy; no other profile's hive is reachable from here.
        if let (Some(arch), Some(layout)) = (native_arch(), &layout) {
            if classic_present(&hkcu(), layout, arch) {
                remove_classic(&hkcu());
            }
        }
        let _ = hklm().delete_subkey_with_flags(MACHINE_RECORD_KEY, KEY_WOW64_32KEY);
        notify_shell();
        match removal {
            Ok(()) => Outcome::Done,
            Err(e) => Outcome::Failed(e),
        }
    }

    pub fn register_user() -> Outcome {
        let Some(arch) = native_arch() else {
            return unsupported_arch();
        };
        let outcome = match (layout(), container()) {
            (Ok(layout), Ok(ContainerKind::Installed)) => register_installed_user(&layout, arch),
            (Ok(layout), Ok(ContainerKind::Portable)) => register_portable_user(&layout, arch),
            (Err(refusal), _) | (_, Err(refusal)) => Outcome::Failed(refusal),
        };
        if let Outcome::Failed(reason) = &outcome {
            record_user_error(reason);
        }
        notify_shell();
        outcome
    }

    /// The registered version is recorded only after a registration that
    /// worked, so a failed one is retried at the next launch.
    fn register_installed_user(layout: &Layout, arch: Arch) -> Outcome {
        let outcome = register_installed_user_now(layout, arch);
        if !matches!(outcome, Outcome::Failed(_)) {
            record_registered_version();
        }
        outcome
    }

    fn register_installed_user_now(layout: &Layout, arch: Arch) -> Outcome {
        // A portable copy's per-user keys name another DLL under the same
        // CLSIDs and would shadow the installed copy for this user.
        if classic_foreign(&hkcu(), layout, arch) {
            remove_classic(&hkcu());
        }
        let machine = read_record(machine_record()).mechanism;
        if machine == Some(Mechanism::Classic) || plan(os_build()) == Mechanism::Classic {
            if classic_present(&hklm(), layout, arch) {
                record_user(Mechanism::Classic, None, None);
                return Outcome::Done;
            }
            return match write_classic(&hkcu(), layout, arch) {
                Ok(()) => {
                    record_user(Mechanism::Classic, None, None);
                    Outcome::Done
                }
                Err(e) => Outcome::Failed(e),
            };
        }
        let sparse = PackageIdentity::read(layout).and_then(|identity| {
            let pm = manager()?;
            let family = identity.family_name();
            if user_packages(&pm).iter().any(|p| p.family_name == family) {
                return Ok(());
            }
            register_family_for_user(&pm, &family).or_else(|staged| {
                let _ = remove_user_packages(&pm);
                add_for_user(&pm, layout, arch).map_err(|added| format!("{staged}; {added}"))
            })
        });
        match sparse {
            Ok(()) => {
                remove_classic(&hkcu());
                record_user(Mechanism::Sparse, None, None);
                Outcome::Done
            }
            Err(refused) => match write_classic(&hkcu(), layout, arch) {
                Ok(()) => {
                    record_user(Mechanism::Classic, Some(&refused), None);
                    Outcome::FellBack(refused)
                }
                Err(e) => Outcome::Failed(format!("{refused}; {e}")),
            },
        }
    }

    fn register_portable_user(layout: &Layout, arch: Arch) -> Outcome {
        if installed_copy_elsewhere(&layout.root) {
            return Outcome::Failed("The installed copy of Spectra PDF provides these commands.".to_string());
        }
        let sparse = match plan(os_build()) {
            Mechanism::Sparse => Some(PackageIdentity::read(layout).and_then(|_| {
                let pm = manager()?;
                let _ = remove_user_packages(&pm);
                add_for_user(&pm, layout, arch)
            })),
            _ => None,
        };
        match sparse {
            Some(Ok(())) => {
                remove_classic(&hkcu());
                record_user(Mechanism::Sparse, None, Some(&layout.root));
                Outcome::Done
            }
            Some(Err(refused)) => match write_classic(&hkcu(), layout, arch) {
                Ok(()) => {
                    record_user(Mechanism::Classic, Some(&refused), Some(&layout.root));
                    Outcome::FellBack(refused)
                }
                Err(e) => Outcome::Failed(format!("{refused}; {e}")),
            },
            None => match write_classic(&hkcu(), layout, arch) {
                Ok(()) => {
                    record_user(Mechanism::Classic, None, Some(&layout.root));
                    Outcome::Done
                }
                Err(e) => Outcome::Failed(e),
            },
        }
    }

    pub fn unregister_user() -> Outcome {
        let removal = manager().and_then(|pm| remove_user_packages(&pm));
        remove_classic(&hkcu());
        clear_user_record();
        notify_shell();
        match removal {
            Ok(()) => Outcome::Done,
            Err(e) => Outcome::Failed(e),
        }
    }

    pub fn status() -> ShellMenuStatus {
        let managed = managed();
        let visible = visible();
        let (layout, container) = match (layout(), container()) {
            (Ok(layout), Ok(container)) => (layout, container),
            (Err(refusal), _) | (_, Err(refusal)) => {
                return ShellMenuStatus {
                    mechanism: Mechanism::None,
                    registered: false,
                    visible,
                    managed,
                    container: ContainerKind::Installed,
                    other_copy: false,
                    error: Some(refusal),
                };
            }
        };
        let other_copy =
            container == ContainerKind::Portable && installed_copy_elsewhere(&layout.root);
        let Some(arch) = native_arch() else {
            return ShellMenuStatus {
                mechanism: Mechanism::None,
                registered: false,
                visible,
                managed,
                container,
                other_copy,
                error: None,
            };
        };
        let sparse = PackageIdentity::read(&layout)
            .map(|identity| user_has_family(&identity.family_name()))
            .unwrap_or(false);
        let classic = classic_present(&hkcu(), &layout, arch)
            || (container == ContainerKind::Installed && classic_present(&hklm(), &layout, arch));
        let user = read_record(user_record());
        let error = match container {
            ContainerKind::Installed => user.error.or_else(|| read_record(machine_record()).error),
            ContainerKind::Portable => user.error,
        };
        let mechanism = if sparse {
            Mechanism::Sparse
        } else if classic {
            Mechanism::Classic
        } else {
            plan(os_build())
        };
        ShellMenuStatus {
            mechanism,
            registered: sparse || classic,
            visible,
            managed,
            container,
            other_copy,
            error,
        }
    }

    pub fn set_enabled(enabled: bool) -> ShellMenuStatus {
        let current = status();
        if current.managed || current.mechanism == Mechanism::None {
            return current;
        }
        match current.container {
            ContainerKind::Installed => {
                if let Err(e) = set_visible(enabled) {
                    record_user_error(&e);
                }
                if enabled && !current.registered {
                    let _ = register_user();
                }
            }
            ContainerKind::Portable => {
                if current.other_copy {
                    return current;
                }
                if enabled {
                    if let Err(e) = set_visible(true) {
                        record_user_error(&e);
                    }
                    let _ = register_user();
                } else if let Outcome::Failed(e) = unregister_user() {
                    record_user_error(&e);
                }
            }
        }
        status()
    }

    pub fn repair() -> Result<(), String> {
        remove_stale_classic(&hkcu());
        if managed() || native_arch().is_none() {
            return Ok(());
        }
        let layout = layout()?;
        match container()? {
            ContainerKind::Portable => {
                let Some(location) = recorded_location() else {
                    return Ok(());
                };
                if same_folder(&location, &layout.root) || installed_copy_elsewhere(&layout.root) {
                    return Ok(());
                }
                let _ = unregister_user();
                match register_user() {
                    Outcome::Failed(reason) => Err(reason),
                    _ => Ok(()),
                }
            }
            ContainerKind::Installed => {
                let machine = read_record(machine_record()).mechanism;
                if machine != Some(Mechanism::Sparse)
                    || registered_version().as_deref() == Some(env!("CARGO_PKG_VERSION"))
                {
                    return Ok(());
                }
                match register_user() {
                    Outcome::Failed(reason) => Err(reason),
                    _ => Ok(()),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plan_gives_the_package_to_windows_11_and_later_only() {
        for (build, want) in [
            (14393, Mechanism::Classic),
            (17763, Mechanism::Classic),
            (19041, Mechanism::Classic),
            (19045, Mechanism::Classic),
            (20348, Mechanism::Classic),
            (22000, Mechanism::Sparse),
            (26100, Mechanism::Sparse),
        ] {
            assert_eq!(plan(build), want, "{build}");
        }
    }

    #[test]
    fn the_publisher_id_matches_the_windows_derivation() {
        assert_eq!(
            publisher_id(
                "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"
            ),
            "8wekyb3d8bbwe"
        );
        assert_eq!(
            family_name(
                "Microsoft.WindowsCalculator",
                "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US"
            ),
            "Microsoft.WindowsCalculator_8wekyb3d8bbwe"
        );
    }

    #[test]
    fn the_classic_set_covers_every_accepted_extension_and_both_servers() {
        let dll = Path::new(r"C:\Program Files\Spectra PDF\shell\x64\spectrapdf_shell.dll");
        let exe = Path::new(r"C:\Program Files\Spectra PDF\spectrapdf.exe");
        let entries = classic_keys(dll, exe);
        let value = |key: &str, name: &str| {
            entries
                .iter()
                .find(|e| e.key == key && e.name == name)
                .map(|e| e.value.clone())
        };
        for verb in Verb::ALL {
            for ext in verb.extensions() {
                let key = verb_key(ext, verb);
                assert_eq!(value(&key, "ExplorerCommandHandler"), Some(format!("{{{}}}", verb.clsid())));
                assert_eq!(value(&key, "MultiSelectModel"), Some("Player".to_string()));
                assert_eq!(value(&key, ""), Some(verb.english_label().to_string()));
                assert!(value(&key, "Icon").unwrap().contains("spectrapdf.exe"));
            }
            let server = format!("{}\\InprocServer32", clsid_key(verb));
            assert_eq!(value(&server, ""), Some(dll.display().to_string()));
            assert_eq!(value(&server, "ThreadingModel"), Some("Apartment".to_string()));
        }
        assert!(value(&verb_key("pdf", Verb::Combine), "").is_some());
        assert!(value(&verb_key("pdf", Verb::Convert), "").is_none());
        for ext in crate::create_pdf_sources::POSTSCRIPT {
            assert!(entries.iter().all(|e| !e.key.contains(&format!("\\.{ext}\\"))), "{ext}");
        }
    }

    #[test]
    fn removal_deletes_exactly_the_keys_registration_writes() {
        let entries = classic_keys(Path::new(r"C:\x\shell\x64\spectrapdf_shell.dll"), Path::new(r"C:\x\spectrapdf.exe"));
        let removal = classic_removal_keys();
        for entry in &entries {
            assert!(
                removal.iter().any(|root| entry.key == *root || entry.key.starts_with(&format!("{root}\\"))),
                "{} is written but never removed",
                entry.key
            );
        }
        for root in &removal {
            assert!(entries.iter().any(|e| e.key == *root), "{root} is removed but never written");
        }
    }

    #[test]
    fn the_status_serializes_the_contract_shape() {
        let status = ShellMenuStatus {
            mechanism: Mechanism::Classic,
            registered: true,
            visible: true,
            managed: false,
            container: ContainerKind::Portable,
            other_copy: false,
            error: Some("0x80073CFF".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "mechanism": "classic",
                "registered": true,
                "visible": true,
                "managed": false,
                "container": "portable",
                "otherCopy": false,
                "error": "0x80073CFF",
            })
        );
        let none = ShellMenuStatus { error: None, mechanism: Mechanism::None, ..status };
        let value = serde_json::to_value(&none).unwrap();
        assert_eq!(value["error"], serde_json::Value::Null);
        assert_eq!(value["mechanism"], "none");
    }

    #[test]
    fn the_layout_resolves_the_handler_beside_the_executable() {
        let layout = Layout::new(Path::new(r"C:\Apps\Spectra"));
        assert_eq!(layout.dll(Arch::Arm64), Path::new(r"C:\Apps\Spectra").join("shell").join("arm64").join("spectrapdf_shell.dll"));
        assert_eq!(
            layout.msix(Arch::X64).file_name().unwrap(),
            "SpectraPDF.ExplorerCommands_x64.msix"
        );
    }

    #[test]
    fn entries_naming_a_missing_handler_are_stale() {
        let present = |p: &Path| p == Path::new(r"C:\x\shell\x64\spectrapdf_shell.dll");
        let live = vec![r"C:\x\shell\x64\spectrapdf_shell.dll".to_string()];
        let gone = vec![r"C:\gone\shell\x64\spectrapdf_shell.dll".to_string()];
        assert!(!stale_servers(&live, &present));
        assert!(stale_servers(&gone, &present));
        assert!(stale_servers(&[live[0].clone(), gone[0].clone()], &present));
        assert!(!stale_servers(&[], &present));
    }

    #[test]
    fn a_late_repair_failure_still_reaches_the_first_reader() {
        let notice = std::sync::Arc::new(RepairNotice::new());
        assert_eq!(notice.take_when_finished(), "");
        notice.begin();
        let writer = notice.clone();
        let late = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(50));
            writer.finish(Some("0x80073CF3".into()));
        });
        assert_eq!(notice.take_when_finished(), "0x80073CF3");
        late.join().unwrap();
        assert_eq!(notice.take_when_finished(), "");
    }

    #[test]
    fn no_registration_call_shuts_down_running_applications() {
        let source = include_str!("shell_menu.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        for option in ["ForceAppShutdown", "ForceTargetAppShutdown", "ForceUpdateFromAnyVersion"] {
            assert!(!code.contains(&format!("Set{option}")), "{option}");
        }
    }

    #[test]
    fn exit_codes_follow_the_installer_contract() {
        assert_eq!(Outcome::Done.exit_code(), 0);
        assert_eq!(Outcome::FellBack("x".into()).exit_code(), 3);
        assert_eq!(Outcome::Failed("x".into()).exit_code(), 1);
    }

    #[test]
    fn the_identity_file_must_name_the_package() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("shell")).unwrap();
        let layout = Layout::new(dir.path());
        assert!(PackageIdentity::read(&layout).is_err());
        std::fs::write(
            layout.identity_file(),
            r#"{"name":"SpectraPDF.ExplorerCommands","publisher":"CN=Spectra PDF Development","version":"1.2.8.0"}"#,
        )
        .unwrap();
        let identity = PackageIdentity::read(&layout).unwrap();
        assert_eq!(identity.family_name(), family_name(ids::PACKAGE_NAME, "CN=Spectra PDF Development"));
        std::fs::write(layout.identity_file(), r#"{"name":"Other","publisher":"CN=x","version":"1.0.0.0"}"#).unwrap();
        assert!(PackageIdentity::read(&layout).is_err());
    }
}
