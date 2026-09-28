//! Scheduled batch runs.
//!
//! The app owns the complete lifecycle: create, list, run now, enable, disable,
//! and delete.
//!
//! **Windows Task Scheduler runs them, not us.** An in-app timer only fires
//! while the app happens to be
//! running — a scheduled job that silently does not happen is worse than no
//! scheduling. Task Scheduler survives logoff and reboot without requiring the
//! app to ship a background service.
//!
//! **One source of truth.** The registered task IS the store: `<Arguments>`
//! carry the job options, while its trigger and principal carry the schedule
//! and account. The UI reconstructs edits from that same definition.
//!
//! **Scoped to our own folder.** Everything lives under `\Spectra PDF\`, so
//! enumeration and deletion address a folder we created rather than pattern-
//! matching across the machine — the same discipline as the batch-log sweep and
//! `delete_batch_scratch`. This code never touches a task outside that folder.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::SystemTime;

use tauri::AppHandle;

/// The one Task Scheduler folder this app writes to. Everything below is
/// scoped to it; nothing outside it is ever listed, changed or deleted.
const TASK_FOLDER: &str = "Spectra PDF";

fn default_schedule_enabled() -> bool {
    true
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleProfile {
    /// Display name; also the task name inside our folder.
    pub name: String,
    pub source: String,
    pub dest: String,
    #[serde(default)]
    pub lang: String,
    #[serde(default)]
    pub moved_root: String,
    #[serde(default)]
    pub error_root: String,
    #[serde(default)]
    pub repair_damaged: bool,
    #[serde(default)]
    pub replace_repaired_originals: bool,
    /// Where the run log goes. REQUIRED when `account` is set — see
    /// `validate_profile`.
    #[serde(default)]
    pub log_dir: String,
    /// "daily" | "weekly"
    #[serde(default)]
    pub frequency: String,
    /// HH:MM, 24-hour, local time.
    #[serde(default)]
    pub time: String,
    /// Weekly only: MON..SUN, comma-joined.
    #[serde(default)]
    pub days: String,
    /// Empty = run as the current user. Otherwise a specific account
    /// (`DOMAIN\user`, or `DOMAIN\gmsa$` for a group Managed Service Account).
    #[serde(default)]
    pub account: String,
    /// Task Scheduler does not return the stored password. When editing a
    /// password-logon task, the owner must enter it again before replacement.
    #[serde(default)]
    pub account_password_required: bool,
    /// Preserve a paused task when its remaining settings are edited.
    #[serde(default = "default_schedule_enabled")]
    pub enabled: bool,
    /// DESTRUCTIVE: replace each original with its searchable version instead
    /// of mirroring into `dest`. Mutually exclusive with a destination and
    /// with `moved_root` — the processed file IS the original.
    #[serde(default)]
    pub in_place: bool,
    /// MRC-compress each processed file after recognition.
    #[serde(default)]
    pub mrc: bool,
    /// MRC preset; read only when `mrc` is set.
    #[serde(default)]
    pub mrc_preset: String,
    #[serde(default)]
    pub mrc_verify_text: bool,
    /// Deskew/despeckle/whiten each scan BEFORE recognition.
    #[serde(default)]
    pub enhance: bool,
    /// The orientation half of enhancement. Its shipped default is ON, so the
    /// command line spells the OFF case (`--no-enhance-orientation`) and
    /// `profile_from_command` starts from true.
    #[serde(default)]
    pub enhance_orientation: bool,
    /// After the run, delete folders inside the source root that are empty.
    #[serde(default)]
    pub remove_empty_folders: bool,
    /// Repair every file and run no OCR. Refused beside `mrc` and `enhance`.
    #[serde(default)]
    pub repair_only: bool,
    /// Which CLI arm the task invokes: "batch-ocr" (the default, also for
    /// empty) or "action" — a guided-action run over the source tree.
    #[serde(default)]
    pub run_type: String,
    /// Action runs only: the frozen action file the task reads. Set by
    /// `create_scheduled_run` (never by the caller): a file of this app's
    /// machine-scoped scheduled-actions folder that belongs to one
    /// registration of the task.
    #[serde(default)]
    pub action_file: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
    pub name: String,
    /// The profile reconstructed from the task definition. `None` when its
    /// command, trigger or principal cannot be represented by this editor.
    pub profile: Option<ScheduleProfile>,
    /// Task Scheduler's own status ("Ready", "Disabled", "Running", …).
    /// Display only: schtasks localizes it, so nothing may branch on the text.
    /// `enabled` below is the locale-independent discriminant.
    pub status: String,
    /// Whether the task is enabled, read from the task XML's
    /// `<Settings><Enabled>` — a boolean, so it is locale-independent.
    pub enabled: bool,
    pub next_run: String,
    pub last_run: String,
    pub last_result: String,
    /// Action runs: the action's display name read from the frozen file
    /// (empty for batch-OCR runs).
    pub action_name: String,
    /// Action runs: the step op names, in order (empty for batch-OCR runs).
    pub action_steps: Vec<String>,
    /// True when the task references an action file that cannot be read.
    /// The task will still FIRE and fail — shown rather than hidden.
    pub action_missing: bool,
}

fn task_path(name: &str) -> String {
    format!("\\{TASK_FOLDER}\\{name}")
}

/// Where frozen action files live. MACHINE-scoped (ProgramData) on purpose:
/// scheduled tasks are machine-scoped objects, and the file must be readable
/// by whatever account the task runs as — a per-user %APPDATA% path would be
/// unreadable to an alternate-credential or (g)MSA run. ProgramData's
/// inherited ACL gives BUILTIN\Users read on files created here (verified).
fn actions_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .ok_or_else(|| "ProgramData is not set".to_string())?;
    Ok(base.join(TASK_FOLDER).join("scheduled-actions"))
}

// ── Action files ─────────────────────────────────────────────────────────
//
// Each registration of an action schedule names an action file of its own,
// `<task>@<pid>-<8 hex>.json`, written whole before the task is registered and
// never written again. A registered task therefore always reads the action it
// was registered with, at every instant: a process killed after Windows
// accepts a task and before anything else happens leaves a task that names a
// complete file. The file the task named before is removed only after the new
// registration is accepted. No task name can hold `@`, so no name an earlier
// version gave an action file (`<task>.json`, `<task>.json.new`) reads as one
// of these.

/// The action file one registration of `task` by the process `pid` names.
fn registration_action_name(task: &str, pid: u32, unique: &str) -> String {
    format!("{task}@{pid}-{unique}.json")
}

/// The task and the writing process a registration's action file name carries.
fn registration_action_owner(entry: &str) -> Option<(&str, u32)> {
    let (task, tag) = entry.strip_suffix(".json")?.split_once('@')?;
    let (pid, unique) = tag.split_once('-')?;
    if !valid_task_name(task)
        || unique.len() != 8
        || !unique.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    Some((task, crate::staging::decimal_pid(pid)?))
}

/// The task whose action file versions without per-registration files named
/// `<task>.json`.
fn legacy_action_file(entry: &str) -> Option<&str> {
    entry.strip_suffix(".json").filter(|task| valid_task_name(task))
}

/// The task of a stage that versions without per-registration files wrote as
/// `<task>.json.new`.
fn legacy_stage_task(entry: &str) -> Option<&str> {
    entry.strip_suffix(".json.new").filter(|task| valid_task_name(task))
}

/// Whether `entry` in `dir` is a legacy stage with the task's action file
/// beside it.
///
/// Those versions removed the action file before renaming the stage over it,
/// so a kill between the two left the stage as the only copy of the action a
/// registered task reads. A stage with no action file beside it is taken only
/// by the orphan reclaim, which first asks whether any task names that file.
fn legacy_action_stage(dir: &Path, entry: &str) -> bool {
    legacy_stage_task(entry).is_some_and(|task| dir.join(format!("{task}.json")).is_file())
}

/// Remove the legacy action stages that have outlived any registration.
fn reclaim_legacy_action_stages(dir: &Path, now: SystemTime) -> usize {
    crate::staging::reclaim_aged(
        dir,
        |entry| legacy_action_stage(dir, entry),
        crate::staging::LEGACY_STAGE_AGE,
        now,
    )
}

/// Whether `path` names an action file of `task` in `dir`: a registration's
/// file, or the file versions without per-registration files named.
fn action_file_of(dir: &Path, task: &str, path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let belongs = registration_action_owner(name).is_some_and(|(owner, _)| owner == task)
        || legacy_action_file(name) == Some(task);
    belongs
        && path
            .parent()
            .is_some_and(|parent| same_file::is_same_file(parent, dir).unwrap_or(false))
}

/// The value of the `--action` argument in a task definition.
fn action_argument(definition: &str) -> Option<String> {
    let arguments = extract_tag(definition, "Arguments")?;
    let tokens = tokenize(&arguments);
    let at = tokens.iter().position(|t| t == "--action")?;
    tokens.get(at + 1).cloned()
}

/// The action file of `task` in `dir` that the task `definition` names, if
/// it names one of this app's action files for that task.
fn named_action(dir: &Path, task: &str, definition: &str) -> Option<PathBuf> {
    let named = PathBuf::from(action_argument(definition)?);
    action_file_of(dir, task, &named).then_some(named)
}

/// The action file of `task` in `dir` that the registered task names now.
/// `Ok(None)` when no such task is registered, or it names no action file of
/// this app's for that task.
fn registered_action(dir: &Path, task: &str) -> Result<Option<PathBuf>, String> {
    Ok(registered_task_definition(task_path(task))?
        .and_then(|definition| named_action(dir, task, &definition)))
}

/// A registration's action file, written whole and flushed, and held open
/// until the registration's outcome is known, so an orphan reclaim running
/// meanwhile finds it held.
struct RegistrationAction {
    path: PathBuf,
    held: std::fs::File,
}

impl RegistrationAction {
    fn write(dir: &Path, task: &str, json: &str) -> Result<Self, String> {
        use std::io::Write;
        let refused = |e: std::io::Error| format!("Could not write the action file: {e}");
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Could not create the scheduled-actions folder: {e}"))?;
        for _ in 0..16 {
            let unique = uuid::Uuid::new_v4().simple().to_string();
            let name = registration_action_name(task, std::process::id(), &unique[..8]);
            let path = dir.join(name);
            let mut held = match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(held) => held,
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(refused(e)),
            };
            return match held.write_all(json.as_bytes()).and_then(|()| held.sync_all()) {
                Ok(()) => Ok(Self { path, held }),
                Err(e) => {
                    drop(held);
                    let _ = std::fs::remove_file(&path);
                    Err(refused(e))
                }
            };
        }
        Err("Could not write the action file: every name tried is taken.".into())
    }

    /// Windows refused the task: nothing names the file.
    fn abandon(self) {
        drop(self.held);
        let _ = std::fs::remove_file(&self.path);
    }

    /// Windows accepted the task: the file belongs to the registration now.
    fn release(self) {
        drop(self.held);
    }
}

/// Serializes the registrations and deletions of this process: each one reads
/// the action file the task names, and a second one in between would remove
/// the file the first one registered.
static REGISTRATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Register `profile` through `register`, with the action file it names.
///
/// `current` is the action file of the task's registration now (see
/// [`registered_action`]). An action run with `json` names a new file of
/// its own in `dir`; one without names the current file, which must exist.
/// The current file is removed only once `register` has accepted the new
/// registration, and only when the new one does not name it. A refused
/// registration removes the new file and leaves the current one.
fn register_with_action(
    profile: &mut ScheduleProfile,
    json: Option<&str>,
    dir: Result<PathBuf, String>,
    current: Result<Option<PathBuf>, String>,
    register: impl FnOnce(&ScheduleProfile) -> Result<(), String>,
) -> Result<(), String> {
    let mut written = None;
    let mut kept = None;
    if profile.run_type == "action" {
        match json {
            Some(json) => {
                let action = RegistrationAction::write(&dir?, &profile.name, json)?;
                profile.action_file = action.path.to_string_lossy().to_string();
                written = Some(action);
            }
            None => {
                let current = current
                    .clone()?
                    .filter(|file| file.is_file())
                    .ok_or("An action schedule needs a guided action to run.")?;
                profile.action_file = current.to_string_lossy().to_string();
                kept = Some(current);
            }
        }
    }
    if let Err(refused) = register(profile) {
        if let Some(action) = written {
            action.abandon();
        }
        return Err(refused);
    }
    if let Some(action) = written {
        action.release();
    }
    if let Ok(Some(previous)) = current {
        if kept.as_ref() != Some(&previous) {
            let _ = std::fs::remove_file(previous);
        }
    }
    Ok(())
}

/// Delete a task through `delete`, then the action file it named. A refused
/// deletion keeps the file: the task still reads it.
fn delete_with(
    named: Option<PathBuf>,
    delete: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    delete()?;
    if let Some(file) = named {
        let _ = std::fs::remove_file(file);
    }
    Ok(())
}

// ── Orphaned action files ────────────────────────────────────────────────

/// An action file no registration may name any more, pending the check that
/// no task definition mentions `kept_by`.
#[derive(Debug, PartialEq, Eq)]
struct Orphan {
    path: PathBuf,
    kept_by: String,
}

/// The files of `dir` that may be orphans: a registration's file whose writer
/// is neither `own` nor `running`, and a file without a process id once it
/// has existed [`crate::staging::LEGACY_STAGE_AGE`]. Each is a file, and owned
/// by this account (`ours`).
///
/// Taken BEFORE the task definitions are read: a writer that had already
/// stopped cannot register a task naming its file after that read.
///
/// `ours` keeps another account's files out: a standard account sees only
/// the tasks it created, and the account that created the folder may still
/// delete every file in it.
fn orphan_candidates(
    dir: &Path,
    own: u32,
    running: impl Fn(u32) -> bool,
    ours: impl Fn(&Path) -> bool,
    now: SystemTime,
) -> Vec<Orphan> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let aged = |path: &Path| {
        std::fs::symlink_metadata(path)
            .and_then(|meta| meta.created())
            .ok()
            .and_then(|born| now.duration_since(born).ok())
            .is_some_and(|existed| existed >= crate::staging::LEGACY_STAGE_AGE)
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let kept_by = if let Some((_, pid)) = registration_action_owner(&name) {
            (pid != own && !running(pid)).then(|| name.clone())
        } else if legacy_action_file(&name).is_some() {
            aged(&path).then(|| name.clone())
        } else if let Some(task) = legacy_stage_task(&name) {
            let action = format!("{task}.json");
            (aged(&path) && !dir.join(&action).is_file()).then_some(action)
        } else {
            None
        };
        let Some(kept_by) = kept_by else {
            continue;
        };
        if entry.file_type().is_ok_and(|kind| kind.is_file()) && ours(&path) {
            found.push(Orphan { path, kept_by });
        }
    }
    found
}

/// Whether some definition names a file called `name`: the name right after a
/// path separator, in any case.
fn mentioned(definitions: &[String], name: &str) -> bool {
    let name = name.to_lowercase();
    let (back, forward) = (format!("\\{name}"), format!("/{name}"));
    definitions.iter().any(|definition| {
        let definition = definition.to_lowercase();
        definition.contains(&back) || definition.contains(&forward)
    })
}

/// Remove the orphans of `dir` that no definition mentions and that no handle
/// holds open when they are removed. `definitions` is read only when there
/// are candidates, and a definition set that cannot be read in full removes
/// nothing.
fn reclaim_orphans_with(
    dir: &Path,
    own: u32,
    running: impl Fn(u32) -> bool,
    ours: impl Fn(&Path) -> bool,
    now: SystemTime,
    definitions: impl FnOnce() -> Result<Vec<String>, String>,
) -> usize {
    let candidates = orphan_candidates(dir, own, running, ours, now);
    if candidates.is_empty() {
        return 0;
    }
    let Ok(definitions) = definitions() else {
        return 0;
    };
    candidates
        .into_iter()
        .filter(|orphan| {
            !mentioned(&definitions, &orphan.kept_by)
                && !crate::staging::held_open(&orphan.path)
                && std::fs::remove_file(&orphan.path).is_ok()
        })
        .count()
}

/// Remove the action files of `dir` that no task of this app's folder names
/// and no running registration can still name. Holds [`REGISTRATION`], so no
/// registration of this process updates a task while its definitions are
/// read.
fn reclaim_orphaned_actions(dir: &Path) -> usize {
    let _registering = REGISTRATION.lock().unwrap_or_else(|e| e.into_inner());
    reclaim_orphans_with(
        dir,
        std::process::id(),
        crate::staging::process_running,
        owned_by_this_account,
        SystemTime::now(),
        || folder_task_definitions(format!("\\{TASK_FOLDER}")),
    )
}

/// Whether this process's account owns `path`: the file's owner is the owner
/// this process gives the files it creates. Anything unreadable is not ours.
#[cfg(windows)]
fn owned_by_this_account(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        EqualSid, GetKernelObjectSecurity, GetSecurityDescriptorOwner, GetTokenInformation,
        TokenOwner, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, TOKEN_OWNER,
        TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    const READ_CONTROL: u32 = 0x0002_0000;

    let Ok(file) = std::fs::OpenOptions::new()
        .access_mode(READ_CONTROL)
        .open(path)
    else {
        return false;
    };
    let handle = HANDLE(file.as_raw_handle());
    let mut needed = 0u32;
    let _ = unsafe {
        GetKernelObjectSecurity(handle, OWNER_SECURITY_INFORMATION.0, None, 0, &mut needed)
    };
    if needed == 0 {
        return false;
    }
    // A security descriptor requires DWORD alignment.
    let mut descriptor = vec![0u32; (needed as usize).div_ceil(4)];
    let sd = PSECURITY_DESCRIPTOR(descriptor.as_mut_ptr().cast());
    if unsafe {
        GetKernelObjectSecurity(handle, OWNER_SECURITY_INFORMATION.0, Some(sd), needed, &mut needed)
    }
    .is_err()
    {
        return false;
    }
    let mut file_owner = PSID::default();
    let mut defaulted = windows::core::BOOL::default();
    if unsafe { GetSecurityDescriptorOwner(sd, &mut file_owner, &mut defaulted) }.is_err()
        || file_owner.0.is_null()
    {
        return false;
    }

    let mut token = HANDLE::default();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.is_err() {
        return false;
    }
    let mut length = 0u32;
    let _ = unsafe { GetTokenInformation(token, TokenOwner, None, 0, &mut length) };
    // TOKEN_OWNER holds a pointer, so the buffer is pointer-aligned.
    let mut buffer = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
    let read = unsafe {
        GetTokenInformation(
            token,
            TokenOwner,
            Some(buffer.as_mut_ptr().cast()),
            length,
            &mut length,
        )
    };
    unsafe {
        let _ = CloseHandle(token);
    }
    if read.is_err() || length == 0 {
        return false;
    }
    let owner = unsafe { &*(buffer.as_ptr() as *const TOKEN_OWNER) };
    unsafe { EqualSid(file_owner, owner.Owner) }.is_ok()
}

#[cfg(not(windows))]
fn owned_by_this_account(_path: &Path) -> bool {
    false
}

/// A task name we are willing to create or delete. Deliberately strict: this
/// gates a `schtasks /Delete`, and the standing rule after a session wiped
/// archived installers with a glob is that a destructive call names exactly
/// what it may take. No separators (which would escape our folder), no wildcards.
fn valid_task_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.contains('\\')
        && !name.contains('/')
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.')
}

fn schtasks() -> Command {
    let mut cmd = Command::new("schtasks.exe");
    // Never pop a console window on a GUI-initiated call.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Register (or replace) a task through the Task Scheduler COM API.
///
/// Keeps the account password off a command line. `schtasks /RP <password>` is
/// readable from any local process listing for the life of the child;
/// `RegisterTask` takes the credential as an in-process VARIANT.
///
/// Not done by piping a PowerShell script to stdin: the secret would sit in a
/// script body, and environments with ScriptBlock logging enabled -- common
/// where named service accounts are used -- would write it to an event log,
/// trading a transient exposure for a durable one.
///
/// `logon_type` must agree with the `<LogonType>` in the XML's Principal;
/// disagreeing registers a task that never runs.
///
/// Creates the task path's FOLDER when it is missing, BEFORE registering.
/// `RegisterTask` is not documented to create folders (folder-tree creation
/// is `ITaskFolder::CreateFolder`'s job). A controlled mutation test on Win11
/// 26200 showed it auto-creates anyway — observed, undocumented — but the
/// first-ever schedule on a fresh install also runs on supported Server SKUs,
/// and an explicit ensure makes folder creation contractual on every build
/// instead of leaning on behavior no contract promises. The `#[ignore]`d COM
/// tests below run in CI, where the runner genuinely has no `\Spectra PDF\`
/// folder, so the fresh-install path stays exercised on Server as well.
///
/// Runs on its own thread so COM initialisation cannot collide with the async
/// runtime's thread reuse, and the apartment is torn down deterministically.
#[cfg(windows)]
fn register_task_com(
    task_path: String,
    xml: String,
    account: String,
    password: Option<String>,
) -> Result<(), String> {
    std::thread::spawn(move || -> Result<(), String> {
        use windows::core::BSTR;
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::System::Variant::VARIANT;
        use windows::Win32::System::TaskScheduler::{
            ITaskService, TaskScheduler, TASK_CREATE_OR_UPDATE, TASK_LOGON_INTERACTIVE_TOKEN,
            TASK_LOGON_PASSWORD, TASK_LOGON_S4U,
        };

        unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let owned = init.is_ok();
            let outcome = (|| -> Result<(), String> {
                let service: ITaskService =
                    CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)
                        .map_err(|e| format!("Task Scheduler is unavailable: {}", e.message()))?;
                service
                    .Connect(
                        &VARIANT::default(),
                        &VARIANT::default(),
                        &VARIANT::default(),
                        &VARIANT::default(),
                    )
                    .map_err(|e| format!("Could not connect to Task Scheduler: {}", e.message()))?;
                let root = service
                    .GetFolder(&BSTR::from("\\"))
                    .map_err(|e| format!("Could not open the task folder: {}", e.message()))?;

                // Ensure the task's folder exists (see the function doc).
                // ERROR_ALREADY_EXISTS is success: another registration can
                // race this one between the Get and the Create.
                if let Some((parent, _)) = task_path.rsplit_once('\\') {
                    let parent = parent.trim_start_matches('\\');
                    if !parent.is_empty() && root.GetFolder(&BSTR::from(parent)).is_err() {
                        if let Err(e) = root.CreateFolder(&BSTR::from(parent), &VARIANT::default())
                        {
                            const ERROR_ALREADY_EXISTS: u32 = 0x800700B7;
                            if e.code().0 as u32 != ERROR_ALREADY_EXISTS {
                                return Err(format!(
                                    "Could not create the task folder \\{parent}: {}",
                                    e.message()
                                ));
                            }
                        }
                    }
                }

                let account = account.trim();
                let (logon, user_v, pw_v) = if account.is_empty() {
                    (
                        TASK_LOGON_INTERACTIVE_TOKEN,
                        VARIANT::default(),
                        VARIANT::default(),
                    )
                } else {
                    match password.as_deref() {
                        Some(pw) if !pw.is_empty() => (
                            TASK_LOGON_PASSWORD,
                            VARIANT::from(account),
                            VARIANT::from(pw),
                        ),
                        // No password for a named account is the (g)MSA shape:
                        // S4U needs no secret.
                        _ => (TASK_LOGON_S4U, VARIANT::from(account), VARIANT::default()),
                    }
                };

                root.RegisterTask(
                    &BSTR::from(task_path.as_str()),
                    &BSTR::from(xml.as_str()),
                    TASK_CREATE_OR_UPDATE.0,
                    &user_v,
                    &pw_v,
                    logon,
                    &VARIANT::default(),
                )
                .map(|_| ())
                .map_err(|e| e.message().to_string())
            })();
            if owned {
                CoUninitialize();
            }
            outcome
        }
    })
    .join()
    .map_err(|_| "The task registration thread panicked.".to_string())?
}

/// Run `work` against a connected Task Scheduler service on a thread of its
/// own, for the same reasons as [`register_task_com`].
#[cfg(windows)]
fn with_task_service<T: Send + 'static>(
    work: impl FnOnce(&windows::Win32::System::TaskScheduler::ITaskService) -> Result<T, String>
        + Send
        + 'static,
) -> Result<T, String> {
    std::thread::spawn(move || -> Result<T, String> {
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::System::TaskScheduler::{ITaskService, TaskScheduler};
        use windows::Win32::System::Variant::VARIANT;

        unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let owned = init.is_ok();
            let outcome = (|| -> Result<T, String> {
                let service: ITaskService =
                    CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)
                        .map_err(|e| format!("Task Scheduler is unavailable: {}", e.message()))?;
                service
                    .Connect(
                        &VARIANT::default(),
                        &VARIANT::default(),
                        &VARIANT::default(),
                        &VARIANT::default(),
                    )
                    .map_err(|e| format!("Could not connect to Task Scheduler: {}", e.message()))?;
                work(&service)
            })();
            if owned {
                CoUninitialize();
            }
            outcome
        }
    })
    .join()
    .map_err(|_| "The Task Scheduler thread panicked.".to_string())?
}

/// Whether a Task Scheduler call failed because the task or folder it names
/// does not exist (ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND).
#[cfg(windows)]
fn absent(error: &windows::core::Error) -> bool {
    matches!(error.code().0 as u32, 0x8007_0002 | 0x8007_0003)
}

/// The definition (task XML) of the task at `task_path`, or `None` when no
/// such task exists.
#[cfg(windows)]
fn registered_task_definition(task_path: String) -> Result<Option<String>, String> {
    with_task_service(move |service| unsafe {
        use windows::core::BSTR;
        let root = service
            .GetFolder(&BSTR::from("\\"))
            .map_err(|e| format!("Could not open the task folder: {}", e.message()))?;
        match root.GetTask(&BSTR::from(task_path.as_str())) {
            Ok(task) => task
                .Xml()
                .map(|xml| Some(xml.to_string()))
                .map_err(|e| format!("Could not read the task {task_path}: {}", e.message())),
            Err(e) if absent(&e) => Ok(None),
            Err(e) => Err(format!("Could not open the task {task_path}: {}", e.message())),
        }
    })
}

#[cfg(not(windows))]
fn registered_task_definition(_task_path: String) -> Result<Option<String>, String> {
    Err("Task Scheduler is available on Windows only.".into())
}

/// The definition of every task in `folder`, hidden ones included; an empty
/// list when the folder does not exist. A task whose definition cannot be
/// read fails the whole call, so the list is never read as complete when it
/// is not.
#[cfg(windows)]
fn folder_task_definitions(folder: String) -> Result<Vec<String>, String> {
    with_task_service(move |service| unsafe {
        use windows::core::BSTR;
        use windows::Win32::System::TaskScheduler::TASK_ENUM_HIDDEN;
        use windows::Win32::System::Variant::VARIANT;
        let folder = match service.GetFolder(&BSTR::from(folder.as_str())) {
            Ok(folder) => folder,
            Err(e) if absent(&e) => return Ok(Vec::new()),
            Err(e) => return Err(format!("Could not open the task folder: {}", e.message())),
        };
        let tasks = folder
            .GetTasks(TASK_ENUM_HIDDEN.0)
            .map_err(|e| format!("Could not list the task folder: {}", e.message()))?;
        let count = tasks
            .Count()
            .map_err(|e| format!("Could not count the tasks: {}", e.message()))?;
        let mut definitions = Vec::with_capacity(count.max(0) as usize);
        for index in 1..=count {
            let task = tasks
                .get_Item(&VARIANT::from(index))
                .map_err(|e| format!("Could not open task {index}: {}", e.message()))?;
            let xml = task
                .Xml()
                .map_err(|e| format!("Could not read task {index}: {}", e.message()))?;
            definitions.push(xml.to_string());
        }
        Ok(definitions)
    })
}

#[cfg(not(windows))]
fn folder_task_definitions(_folder: String) -> Result<Vec<String>, String> {
    Err("Task Scheduler is available on Windows only.".into())
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd
        .output()
        .map_err(|e| format!("Could not run schtasks: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let detail = if stderr.trim().is_empty() { stdout } else { stderr };
        return Err(detail.trim().to_string());
    }
    Ok(stdout)
}

fn valid_schedule_time(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let bytes = value.as_bytes();
    if bytes.len() != 5
        || bytes[2] != b':'
        || !bytes[..2].iter().all(u8::is_ascii_digit)
        || !bytes[3..].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    let hours = (bytes[0] - b'0') * 10 + (bytes[1] - b'0');
    let minutes = (bytes[3] - b'0') * 10 + (bytes[4] - b'0');
    hours < 24 && minutes < 60
}

fn parse_weekly_days(days: &str) -> Result<Vec<&'static str>, String> {
    let mut parsed = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for day in days.split(',') {
        let xml_day = match day.trim().to_ascii_uppercase().as_str() {
            "MON" => "<Monday />",
            "TUE" => "<Tuesday />",
            "WED" => "<Wednesday />",
            "THU" => "<Thursday />",
            "FRI" => "<Friday />",
            "SAT" => "<Saturday />",
            "SUN" => "<Sunday />",
            _ => return Err("A weekly schedule contains an unknown or empty day.".into()),
        };
        if !seen.insert(xml_day) {
            return Err("A weekly schedule cannot repeat a day.".into());
        }
        parsed.push(xml_day);
    }
    if parsed.is_empty() {
        return Err("A weekly schedule needs at least one day.".into());
    }
    Ok(parsed)
}

/// The refusals that must happen BEFORE a task is registered.
///
/// A run under a service account resolves `%APPDATA%` inside that account's
/// profile, so a scheduled run's log would land somewhere the person who set it
/// up cannot see. Registering such a task without an explicit shared log folder
/// produces exactly the failure this whole logging feature exists to prevent —
/// an unattended run with no findable audit trail.
pub fn validate_profile(p: &ScheduleProfile) -> Result<(), String> {
    let run_type = if p.run_type.is_empty() {
        "batch-ocr"
    } else {
        p.run_type.as_str()
    };
    if run_type != "action" && run_type != "batch-ocr" {
        return Err("A scheduled run must be a batch OCR run or a guided action.".into());
    }
    if p.frequency != "daily" && p.frequency != "weekly" {
        return Err("A scheduled run frequency must be daily or weekly.".into());
    }
    if !valid_task_name(&p.name) {
        return Err(
            "A schedule name may use letters, numbers, spaces, dots, hyphens and underscores only."
                .into(),
        );
    }
    if p.source.trim().is_empty() {
        return Err("A scheduled run needs a source folder.".into());
    }
    // In-place replaces each original, so a destination would name a mirror
    // that is never written; a guided action still needs one.
    if p.in_place && run_type == "action" {
        return Err("A guided action cannot be scheduled in place from here.".into());
    }
    if p.in_place && !p.dest.trim().is_empty() {
        return Err("An in-place run takes no destination -- the originals are replaced.".into());
    }
    if p.in_place && !p.moved_root.trim().is_empty() {
        return Err(
            "An in-place run cannot also move processed originals -- the processed file IS \
             the original."
                .into(),
        );
    }
    if !p.in_place && p.dest.trim().is_empty() {
        return Err("A scheduled run needs both a source and a destination folder.".into());
    }
    if !PathBuf::from(&p.source).is_dir() {
        return Err(format!("Source folder not found: {}", p.source));
    }
    if !valid_schedule_time(&p.time) {
        return Err("Time must be HH:MM (24-hour).".into());
    }
    if p.frequency == "weekly" {
        parse_weekly_days(&p.days)?;
    }
    if run_type == "batch-ocr" {
        if !p.lang.is_empty()
            && !p.lang.split('+').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            })
        {
            return Err("A scheduled OCR language must contain language codes only.".into());
        }
        if p.mrc
            && !p.mrc_preset.is_empty()
            && !matches!(p.mrc_preset.as_str(), "archival" | "balanced" | "smallest")
        {
            return Err("A scheduled MRC preset must be archival, balanced or smallest.".into());
        }
        if p.repair_only && (p.mrc || p.enhance || p.repair_damaged) {
            return Err(
                "A repair-only run performs no OCR, so it cannot also use MRC compression, \
                 scan enhancement or the damaged-file repair option."
                    .into(),
            );
        }
    }
    if !p.account.trim().is_empty() && p.log_dir.trim().is_empty() {
        return Err(
            "A run under another account needs an explicit log folder: the default location \
             belongs to whichever account runs the batch, so the log would not be where you \
             can see it."
                .into(),
        );
    }
    Ok(())
}

fn build_arguments(exe: &str, p: &ScheduleProfile) -> String {
    let _ = exe;
    if p.run_type == "action" {
        let mut args = vec![
            "run-action".to_string(),
            quote_windows_arg(&p.source),
            "--dest".to_string(),
            quote_windows_arg(&p.dest),
            "--action".to_string(),
            quote_windows_arg(&p.action_file),
        ];
        if !p.log_dir.is_empty() {
            args.extend(["--log-dir".to_string(), quote_windows_arg(&p.log_dir)]);
        }
        return args.join(" ");
    }
    // The whole run is expanded HERE, into the task's own command line: the
    // registered task is the store, so a schedule carries its settings rather
    // than a reference to a preset the run could not read anyway (it fires
    // with the app closed, and possibly under another account).
    let mut args = if p.in_place {
        vec![
            "batch-ocr".to_string(),
            quote_windows_arg(&p.source),
            "--in-place".to_string(),
            "--lang".to_string(),
            quote_windows_arg(if p.lang.is_empty() { "eng" } else { &p.lang }),
        ]
    } else {
        vec![
            "batch-ocr".to_string(),
            quote_windows_arg(&p.source),
            "--dest".to_string(),
            quote_windows_arg(&p.dest),
            "--lang".to_string(),
            quote_windows_arg(if p.lang.is_empty() { "eng" } else { &p.lang }),
        ]
    };
    if p.repair_only {
        args.push("--repair-only".to_string());
    }
    if p.mrc {
        args.push("--mrc".to_string());
        if !p.mrc_preset.is_empty() {
            args.extend(["--mrc-preset".to_string(), quote_windows_arg(&p.mrc_preset)]);
        }
        if p.mrc_verify_text {
            args.push("--mrc-verify-text".to_string());
        }
    }
    if p.enhance {
        args.push("--enhance".to_string());
        if !p.enhance_orientation {
            args.push("--no-enhance-orientation".to_string());
        }
    }
    if !p.moved_root.is_empty() {
        args.extend(["--moved".to_string(), quote_windows_arg(&p.moved_root)]);
    }
    if !p.error_root.is_empty() {
        args.extend(["--errors".to_string(), quote_windows_arg(&p.error_root)]);
    }
    if p.repair_damaged && !p.repair_only {
        args.push("--repair".to_string());
    }
    if p.replace_repaired_originals {
        args.push("--replace-repaired".to_string());
    }
    if p.remove_empty_folders {
        args.push("--remove-empty-folders".to_string());
    }
    if !p.log_dir.is_empty() {
        args.extend(["--log-dir".to_string(), quote_windows_arg(&p.log_dir)]);
    }
    args.join(" ")
}

/// Encode one argument using the Windows CRT quoting rules used by the task's
/// executable. Backslashes before a closing quote must be doubled, or a path
/// ending in `\` escapes that quote and changes every following argument.
fn quote_windows_arg(value: &str) -> String {
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for ch in value.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                for _ in 0..backslashes.saturating_mul(2).saturating_add(1) {
                    quoted.push('\\');
                }
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                for _ in 0..backslashes {
                    quoted.push('\\');
                }
                quoted.push(ch);
                backslashes = 0;
            }
        }
    }
    for _ in 0..backslashes.saturating_mul(2) {
        quoted.push('\\');
    }
    quoted.push('"');
    quoted
}

/// Create (or replace) a scheduled run.
///
/// `password` is used ONLY here and is never stored by this app: Task Scheduler
/// keeps it in LSA. It is passed to schtasks and dropped — the same posture as
/// the `.pfx` signing password.
///
/// `action_json` (run_type "action" only) is the frozen `{name, steps}` action
/// the task will run — the SAME sanitized shape the panel exports, so it can
/// never carry a password. It is written to this app's machine-scoped
/// scheduled-actions folder; a scheduled task must not depend on the GUI's
/// localStorage (wrong profile under a service account, and the run fires with
/// the app closed). Omitting it while replacing an existing action schedule
/// keeps the action file the registered task names. See
/// [`register_with_action`] for how the action file follows the
/// registration.
#[tauri::command]
pub async fn create_scheduled_run(
    app: AppHandle,
    mut profile: ScheduleProfile,
    password: Option<String>,
    action_json: Option<String>,
) -> Result<String, String> {
    validate_profile(&profile)?;
    let exe = std::env::current_exe()
        .map_err(|e| format!("Cannot resolve this application's path: {e}"))?
        .to_string_lossy()
        .to_string();
    let _ = app;

    let _registering = REGISTRATION.lock().unwrap_or_else(|e| e.into_inner());
    let dir = actions_dir();
    let current = match &dir {
        Ok(dir) => registered_action(dir, &profile.name),
        Err(e) => Err(e.clone()),
    };
    let json = action_json.as_deref().filter(|j| !j.trim().is_empty());
    register_with_action(&mut profile, json, dir, current, |profile| {
        // Registration goes through TASK XML, not `/TR`, and that is not a
        // style choice: `/TR` is capped at 261 characters by schtasks, and a
        // real run (exe path + source + destination + moved + error + log
        // folders) exceeds that cap with realistic paths.
        let xml = build_task_xml(&exe, profile, password.as_deref())?;

        // COM takes the XML as a string, so no staged temp file and no
        // UTF-16-with-BOM encoding (both were schtasks requirements). The
        // 261-character `/TR` cap above is still why the definition is XML.
        register_task_com(
            task_path(&profile.name),
            xml,
            profile.account.trim().to_string(),
            password.clone(),
        )
        .map_err(|e| {
            // The two failures worth naming, because both
            // register-then-never-fire.
            if e.contains("Access is denied") {
                format!(
                    "Windows refused to create the schedule: {e}\nRunning as another account \
                     usually requires administrator rights."
                )
            } else if e.to_lowercase().contains("logon") {
                format!(
                    "Windows refused the account: {e}\nThe account also needs the \
                     \"Log on as a batch job\" right on this machine, or the task registers \
                     but never runs."
                )
            } else {
                e
            }
        })
    })?;

    Ok(task_path(&profile.name))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The Task Scheduler XML for one profile.
///
/// `StartBoundary` deliberately uses a fixed PAST date. A recurring trigger
/// counts forward from its start, so a past boundary simply means "the next
/// occurrence at this time" — which avoids date arithmetic here entirely, and
/// avoids the bug where a schedule created after today's time silently waits a
/// whole extra day.
fn build_task_xml(
    exe: &str,
    p: &ScheduleProfile,
    password: Option<&str>,
) -> Result<String, String> {
    let time = if p.time.is_empty() { "09:30" } else { &p.time };
    let trigger = match p.frequency.as_str() {
        "weekly" => {
            let days = parse_weekly_days(&p.days)?;
            format!(
                "<CalendarTrigger><StartBoundary>2020-01-01T{time}:00</StartBoundary>\
                 <Enabled>true</Enabled><ScheduleByWeek><WeeksInterval>1</WeeksInterval>\
                 <DaysOfWeek>{}</DaysOfWeek></ScheduleByWeek></CalendarTrigger>",
                days.join("")
            )
        }
        _ => format!(
            "<CalendarTrigger><StartBoundary>2020-01-01T{time}:00</StartBoundary>\
             <Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval>\
             </ScheduleByDay></CalendarTrigger>"
        ),
    };

    // An account with no password is the (g)MSA case: Password logon needs a
    // secret, S4U does not. Getting this wrong registers a task that never runs.
    let principal = if p.account.trim().is_empty() {
        "<Principal id=\"Author\"><LogonType>InteractiveToken</LogonType>\
         <RunLevel>LeastPrivilege</RunLevel></Principal>"
            .to_string()
    } else {
        let logon = match password {
            Some(pw) if !pw.is_empty() => "Password",
            _ if p.account_password_required => {
                return Err(
                    "This schedule uses a Windows-stored password. Enter it again to update the schedule."
                        .into(),
                )
            }
            _ => "S4U",
        };
        format!(
            "<Principal id=\"Author\"><UserId>{}</UserId><LogonType>{logon}</LogonType>\
             <RunLevel>LeastPrivilege</RunLevel></Principal>",
            xml_escape(p.account.trim())
        )
    };

    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Spectra PDF</Author>
    <Description>{kind}: {desc}</Description>
  </RegistrationInfo>
  <Triggers>{trigger}</Triggers>
  <Principals>{principal}</Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>{enabled}</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{args}</Arguments>
    </Exec>
  </Actions>
</Task>"#,
        kind = if p.run_type == "action" { "Guided action" } else { "Batch OCR" },
        desc = xml_escape(&format!("{} -> {}", p.source, p.dest)),
        command = xml_escape(exe),
        args = xml_escape(&build_arguments(exe, p)),
        enabled = p.enabled,
    ))
}

/// Split a Windows command line using the executable's CRT backslash/quote rules.
fn tokenize(line: &str) -> Vec<String> {
    let mut chars = line.chars().peekable();
    let mut tokens = Vec::new();
    loop {
        while chars.peek().is_some_and(|ch| ch.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let mut token = String::new();
        let mut in_quotes = false;
        let mut started = false;
        while let Some(&ch) = chars.peek() {
            if ch.is_whitespace() && !in_quotes {
                break;
            }
            if ch == '\\' {
                let mut count = 0usize;
                while chars.peek() == Some(&'\\') {
                    chars.next();
                    count += 1;
                }
                if chars.peek() == Some(&'"') {
                    token.extend(std::iter::repeat('\\').take(count / 2));
                    chars.next();
                    if count % 2 == 1 {
                        token.push('"');
                    } else if in_quotes && chars.peek() == Some(&'"') {
                        chars.next();
                        token.push('"');
                    } else {
                        in_quotes = !in_quotes;
                    }
                } else {
                    token.extend(std::iter::repeat('\\').take(count));
                }
                started = true;
                continue;
            }
            if ch == '"' {
                chars.next();
                if in_quotes && chars.peek() == Some(&'"') {
                    chars.next();
                    token.push('"');
                } else {
                    in_quotes = !in_quotes;
                }
                started = true;
                continue;
            }
            token.push(ch);
            chars.next();
            started = true;
        }
        if started {
            tokens.push(token);
        }
    }
    tokens
}

fn command_value(args: &[String], index: &mut usize) -> Option<String> {
    *index += 1;
    let value = args.get(*index)?;
    if value.is_empty() || value.starts_with("--") {
        return None;
    }
    Some(value.clone())
}

#[cfg(test)]
fn profile_from_command(name: &str, command: &str) -> Option<ScheduleProfile> {
    let tokens = tokenize(command);
    let (start, run_type) = match tokens.iter().position(|t| t == "batch-ocr") {
        Some(i) => (i, "batch-ocr"),
        None => (tokens.iter().position(|t| t == "run-action")?, "action"),
    };
    profile_from_tokens(name, &tokens, start, run_type)
}

/// Rebuild the profile from the task's argument string, which is the source of
/// truth for job options. Trigger and principal settings come from the XML.
fn profile_from_arguments(name: &str, arguments: &str) -> Option<ScheduleProfile> {
    let tokens = tokenize(arguments);
    let run_type = match tokens.first()?.as_str() {
        "batch-ocr" => "batch-ocr",
        "run-action" => "action",
        _ => return None,
    };
    profile_from_tokens(name, &tokens, 0, run_type)
}

fn profile_from_tokens(
    name: &str,
    tokens: &[String],
    start: usize,
    run_type: &str,
) -> Option<ScheduleProfile> {
    let rest = &tokens[start + 1..];
    let mut p = ScheduleProfile {
        name: name.to_string(),
        source: String::new(),
        dest: String::new(),
        lang: if run_type == "action" { String::new() } else { "eng".into() },
        moved_root: String::new(),
        error_root: String::new(),
        repair_damaged: false,
        replace_repaired_originals: false,
        log_dir: String::new(),
        frequency: String::new(),
        time: String::new(),
        days: String::new(),
        account: String::new(),
        account_password_required: false,
        enabled: true,
        in_place: false,
        mrc: false,
        mrc_preset: String::new(),
        mrc_verify_text: false,
        enhance: false,
        // Its shipped default is ON; only the explicit off-flag lowers it.
        enhance_orientation: true,
        remove_empty_folders: false,
        repair_only: false,
        run_type: run_type.to_string(),
        action_file: String::new(),
    };
    let mut i = 0;
    while i < rest.len() {
        let tok = rest[i].as_str();
        match tok {
            "--dest" => p.dest = command_value(rest, &mut i)?,
            "--lang" if run_type == "batch-ocr" => p.lang = command_value(rest, &mut i)?,
            "--moved" if run_type == "batch-ocr" => p.moved_root = command_value(rest, &mut i)?,
            "--errors" if run_type == "batch-ocr" => p.error_root = command_value(rest, &mut i)?,
            "--log-dir" => p.log_dir = command_value(rest, &mut i)?,
            "--action" if run_type == "action" => p.action_file = command_value(rest, &mut i)?,
            "--mrc-preset" if run_type == "batch-ocr" => {
                p.mrc_preset = command_value(rest, &mut i)?
            }
            "--repair" if run_type == "batch-ocr" => p.repair_damaged = true,
            "--replace-repaired" if run_type == "batch-ocr" => p.replace_repaired_originals = true,
            "--in-place" if run_type == "batch-ocr" => p.in_place = true,
            "--mrc" if run_type == "batch-ocr" => p.mrc = true,
            "--mrc-verify-text" if run_type == "batch-ocr" => p.mrc_verify_text = true,
            "--enhance" if run_type == "batch-ocr" => p.enhance = true,
            "--no-enhance-orientation" if run_type == "batch-ocr" => p.enhance_orientation = false,
            "--remove-empty-folders" if run_type == "batch-ocr" => p.remove_empty_folders = true,
            "--repair-only" if run_type == "batch-ocr" => p.repair_only = true,
            other if !other.starts_with("--") && p.source.is_empty() => {
                p.source = other.to_string();
            }
            _ => return None,
        }
        i += 1;
    }
    // Do not offer an edit if it would normalize away unsupported combinations.
    if p.source.is_empty()
        || (p.dest.is_empty() && !p.in_place)
        || (p.in_place && (!p.dest.is_empty() || !p.moved_root.is_empty()))
        || (p.mrc_verify_text && !p.mrc)
        || (!p.mrc_preset.is_empty() && !p.mrc)
        || (!p.enhance_orientation && !p.enhance)
        || (p.repair_only && (p.mrc || p.enhance || p.repair_damaged))
    {
        return None;
    }
    if p.run_type == "action" && p.action_file.is_empty() {
        return None;
    }
    Some(p)
}

fn weekly_days_from_xml(days: &str) -> Option<String> {
    const DAYS: [(&str, &str); 7] = [
        ("Monday", "MON"),
        ("Tuesday", "TUE"),
        ("Wednesday", "WED"),
        ("Thursday", "THU"),
        ("Friday", "FRI"),
        ("Saturday", "SAT"),
        ("Sunday", "SUN"),
    ];
    let mut remainder = days.to_string();
    let mut found = Vec::new();
    for (element, day) in DAYS {
        let spaced = format!("<{element} />");
        let compact = format!("<{element}/>");
        let count =
            remainder.matches(&spaced).count() + remainder.matches(&compact).count();
        if count > 1 {
            return None;
        }
        if count == 1 {
            remainder = remainder.replace(&spaced, "").replace(&compact, "");
            found.push(day);
        }
    }
    if found.is_empty() || !remainder.chars().all(char::is_whitespace) {
        return None;
    }
    Some(found.join(","))
}

/// Rebuild every editable profile field from the registered task definition.
/// The command line holds the job options; trigger/principal XML holds when
/// and under which account Windows will run it. If either half is unknown,
/// leave the task visible but do not offer an unsafe partial edit.
fn profile_from_task_xml(
    name: &str,
    xml: &str,
    expected_exe: &Path,
    current_user_sid: Option<&str>,
) -> Option<ScheduleProfile> {
    let executable = extract_tag(xml, "Command")?;
    if !same_file::is_same_file(&executable, expected_exe).unwrap_or(false) {
        return None;
    }
    let arguments = extract_tag(xml, "Arguments")?;
    let mut profile = profile_from_arguments(name, &arguments)?;
    let triggers = extract_tag(xml, "Triggers")?;
    if triggers.matches("<CalendarTrigger>").count() != 1
        || triggers.matches("</CalendarTrigger>").count() != 1
        || ["EndBoundary", "Repetition", "RandomDelay", "Delay"]
            .iter()
            .any(|setting| triggers.contains(&format!("<{setting}")))
        || [
            "BootTrigger",
            "EventTrigger",
            "IdleTrigger",
            "LogonTrigger",
            "RegistrationTrigger",
            "SessionStateChangeTrigger",
            "TimeTrigger",
        ]
        .iter()
        .any(|trigger| triggers.contains(&format!("<{trigger}")))
        || !supported_calendar_trigger_markup(&triggers)
    {
        return None;
    }
    if !tag_or_default(&triggers, "Enabled", "true")?.eq_ignore_ascii_case("true") {
        return None;
    }
    let boundary = extract_tag(&triggers, "StartBoundary")?;
    let (date, clock) = boundary.split_once('T')?;
    if date != "2020-01-01" {
        return None;
    }
    if clock.get(5..8)? != ":00" || !clock.get(8..)?.is_empty() {
        return None;
    }
    let time = clock.get(..5)?.to_string();
    if !valid_schedule_time(&time) {
        return None;
    }
    let weekly = extract_tag(&triggers, "ScheduleByWeek");
    let daily = extract_tag(&triggers, "ScheduleByDay");
    let (frequency, days) = match (weekly, daily) {
        (Some(weekly), None) => {
            if extract_tag(&weekly, "WeeksInterval").as_deref() != Some("1") {
                return None;
            }
            let days_xml = extract_tag(&weekly, "DaysOfWeek")?;
            ("weekly", weekly_days_from_xml(&days_xml)?)
        }
        (None, Some(daily)) => {
            if extract_tag(&daily, "DaysInterval").as_deref() != Some("1") {
                return None;
            }
            ("daily", String::new())
        }
        _ => return None,
    };

    let settings = extract_tag(xml, "Settings")?;
    let enabled = match tag_or_default(&settings, "Enabled", "true")?.as_str() {
        "true" => true,
        "false" => false,
        _ => return None,
    };
    if tag_or_default(&settings, "MultipleInstancesPolicy", "IgnoreNew")?.as_str() != "IgnoreNew"
        || extract_tag(&settings, "DisallowStartIfOnBatteries")?.as_str() != "false"
        || extract_tag(&settings, "StopIfGoingOnBatteries")?.as_str() != "false"
        || extract_tag(&settings, "StartWhenAvailable")?.as_str() != "true"
        || tag_or_default(&settings, "Hidden", "false")?.as_str() != "false"
        || extract_tag(&settings, "ExecutionTimeLimit")?.as_str() != "PT0S"
        || extract_tag(&settings, "AllowStartOnDemand")
            .as_deref()
            .is_some_and(|v| v != "true")
        || extract_tag(&settings, "AllowHardTerminate")
            .as_deref()
            .is_some_and(|v| v != "true")
        || extract_tag(&settings, "RunOnlyIfNetworkAvailable")
            .as_deref()
            .is_some_and(|v| v != "false")
        || extract_tag(&settings, "RunOnlyIfIdle")
            .as_deref()
            .is_some_and(|v| v != "false")
        || extract_tag(&settings, "UseUnifiedSchedulingEngine")
            .as_deref()
            .is_some_and(|v| v != "false")
        || extract_tag(&settings, "DisallowStartOnRemoteAppSession")
            .as_deref()
            .is_some_and(|v| v != "false")
        || extract_tag(&settings, "Volatile")
            .as_deref()
            .is_some_and(|v| v != "false")
        || extract_tag(&settings, "Priority")
            .as_deref()
            .is_some_and(|v| v != "7")
        || extract_tag(&settings, "DeleteExpiredTaskAfter")
            .as_deref()
            .is_some_and(|v| v != "PT0S")
        || settings.contains("<RestartOnFailure")
        || settings.contains("<MaintenanceSettings")
        || extract_tag(&settings, "WakeToRun").as_deref().is_some_and(|v| v != "false")
    {
        return None;
    }

    let principals = extract_tag(xml, "Principals")?;
    if principals.matches("<Principal ").count() != 1
        || principals.matches("</Principal>").count() != 1
        || principals.contains("<ProcessTokenSidType")
        || principals.contains("<RequiredPrivileges")
    {
        return None;
    }
    if tag_or_default(&principals, "RunLevel", "LeastPrivilege")?.as_str() != "LeastPrivilege" {
        return None;
    }
    let (account, password_required) = match extract_tag(&principals, "LogonType")?.as_str() {
        "InteractiveToken" => {
            let user_id = optional_tag(&principals, "UserId")?;
            if !interactive_user_matches(user_id.as_deref(), current_user_sid) {
                return None;
            }
            (String::new(), false)
        }
        "Password" => (extract_tag(&principals, "UserId")?, true),
        "S4U" => (extract_tag(&principals, "UserId")?, false),
        _ => return None,
    };
    if password_required && account.trim().is_empty() {
        return None;
    }

    let exec = extract_tag(xml, "Exec")?;
    if exec.contains("<WorkingDirectory")
        || xml.matches("<Exec>").count() != 1
        || xml.matches("</Exec>").count() != 1
        || xml.contains("<ComHandler")
        || xml.contains("<SendEmail")
        || xml.contains("<ShowMessage")
    {
        return None;
    }

    profile.frequency = frequency.to_string();
    profile.time = time;
    profile.days = days;
    profile.account = account;
    profile.account_password_required = password_required;
    profile.enabled = enabled;
    Some(profile)
}

fn interactive_user_matches(user_id: Option<&str>, current_user_sid: Option<&str>) -> bool {
    match user_id {
        None => true,
        Some(user_id) => current_user_sid
            .is_some_and(|current| user_id.trim().eq_ignore_ascii_case(current.trim())),
    }
}

/// SID for the user whose interactive token will bind an InteractiveToken task.
#[cfg(windows)]
fn current_user_sid() -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, SID, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = HANDLE::default();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.is_err() {
        return None;
    }
    let sid = (|| {
        let mut length = 0u32;
        let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut length) };
        if length == 0 {
            return None;
        }
        let mut buffer = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                length,
                &mut length,
            )
        }
        .is_err()
        {
            return None;
        }
        let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
        if user.User.Sid.0.is_null() {
            return None;
        }
        let sid = unsafe { &*(user.User.Sid.0 as *const SID) };
        let count = usize::from(sid.SubAuthorityCount);
        if count > 15 {
            return None;
        }
        let authority = sid
            .IdentifierAuthority
            .Value
            .iter()
            .fold(0u64, |value, byte| (value << 8) | u64::from(*byte));
        let sub_authorities = unsafe {
            std::slice::from_raw_parts(std::ptr::addr_of!(sid.SubAuthority).cast::<u32>(), count)
        };
        Some(format!(
            "S-{}-{}{}",
            sid.Revision,
            authority,
            sub_authorities
                .iter()
                .map(|part| format!("-{part}"))
                .collect::<String>()
        ))
    })();
    unsafe {
        let _ = CloseHandle(token);
    }
    sid
}

#[cfg(not(windows))]
fn current_user_sid() -> Option<String> {
    None
}

/// What the frozen action file says it does — for the list. A missing or
/// unreadable file is reported, not hidden: the task still FIRES.
fn read_action_summary(profile: Option<&ScheduleProfile>) -> (String, Vec<String>, bool) {
    let Some(p) = profile else {
        return (String::new(), vec![], false);
    };
    if p.run_type != "action" {
        return (String::new(), vec![], false);
    }
    let Ok(raw) = std::fs::read_to_string(&p.action_file) else {
        return (String::new(), vec![], true);
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return (String::new(), vec![], true);
    };
    let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
    let steps = v
        .get("steps")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.get("op").and_then(|o| o.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    (name, steps, false)
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn extract_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml_unescape(xml[start..end].trim()))
}

/// Read an optional element while distinguishing absence from malformed XML.
/// Task Scheduler omits default-valued elements in `/Query /XML`; an element
/// that is present but not in the shape this reader understands still refuses.
fn optional_tag(xml: &str, tag: &str) -> Option<Option<String>> {
    let prefix = format!("<{tag}");
    let present = xml.match_indices(&prefix).any(|(start, _)| {
        xml.as_bytes()
            .get(start + prefix.len())
            .is_some_and(|next| *next == b'>' || next.is_ascii_whitespace() || *next == b'/')
    });
    if present {
        extract_tag(xml, tag).map(Some)
    } else {
        Some(None)
    }
}

fn tag_or_default(xml: &str, tag: &str, default: &str) -> Option<String> {
    optional_tag(xml, tag)?.or_else(|| Some(default.to_string()))
}

fn supported_calendar_trigger_markup(triggers: &str) -> bool {
    const ELEMENTS: [&str; 15] = [
        "CalendarTrigger",
        "StartBoundary",
        "Enabled",
        "ScheduleByDay",
        "DaysInterval",
        "ScheduleByWeek",
        "WeeksInterval",
        "DaysOfWeek",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
    ];
    let mut remaining = triggers;
    while let Some(start) = remaining.find('<') {
        let Some(end) = remaining[start..].find('>') else {
            return false;
        };
        let element = remaining[start + 1..start + end].trim();
        let name = element
            .strip_prefix('/')
            .unwrap_or(element)
            .trim_end_matches('/')
            .split_ascii_whitespace()
            .next()
            .unwrap_or("");
        if element.contains('=') || !ELEMENTS.contains(&name) {
            return false;
        }
        remaining = &remaining[start + end + 1..];
    }
    true
}

/// The task definition, read from its XML rather than the truncation-prone CSV.
///
/// NOT from the CSV listing: schtasks' "Task To Run" column TRUNCATES around
/// 261 characters and prints embedded quotes raw (both verified live) — a
/// run-action command with real paths overflows it, and the truncation +
/// quote desync turned the parsed profile into garbage. The XML is the full,
/// properly-escaped definition.
fn task_definition_xml(full_task_path: &str) -> Option<(bool, String)> {
    let xml = run(schtasks().args(["/Query", "/TN", full_task_path, "/XML"])).ok()?;
    // `<Enabled>` appears inside TRIGGERS as well, and a trigger precedes
    // <Settings> in schtasks' XML — so the settings block is sliced out first
    // and the tag read from THAT. Absent (or unreadable) means enabled, which
    // is Task Scheduler's own default.
    let enabled = extract_tag(&xml, "Settings")
        .as_deref()
        .and_then(|s| extract_tag(s, "Enabled"))
        .map(|v| !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true);
    if extract_tag(&xml, "Command").is_none() {
        return None;
    }
    Some((enabled, xml))
}

/// One row of schtasks' CSV output. Quoted fields, `""` for a literal quote.
fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => fields.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    fields.push(cur);
    fields
}

/// Every run this app created. Scoped to our folder — a `/Query` on the folder
/// cannot return anything we did not put there.
#[tauri::command]
pub async fn list_scheduled_runs() -> Result<Vec<ScheduledRun>, String> {
    if let Ok(dir) = actions_dir() {
        reclaim_legacy_action_stages(&dir, SystemTime::now());
        reclaim_orphaned_actions(&dir);
    }
    let out = match run(schtasks().args([
        "/Query",
        "/TN",
        &format!("\\{TASK_FOLDER}\\"),
        "/FO",
        "CSV",
        "/V",
    ])) {
        Ok(s) => s,
        // No folder yet simply means nothing has been scheduled.
        Err(e) if e.contains("cannot find") || e.contains("does not exist") => {
            return Ok(vec![])
        }
        Err(e) => return Err(e),
    };

    let mut lines = out.lines().filter(|l| !l.trim().is_empty());
    let headers = match lines.next() {
        Some(h) => parse_csv_line(h),
        None => return Ok(vec![]),
    };
    let idx = |name: &str| {
        headers
            .iter()
            .position(|h| h.trim().eq_ignore_ascii_case(name))
    };
    let (i_name, i_next, i_status, i_last, i_result) = (
        idx("TaskName"),
        idx("Next Run Time"),
        idx("Status"),
        idx("Last Run Time"),
        idx("Last Result"),
    );

    let prefix = format!("\\{TASK_FOLDER}\\");
    let current_exe = std::env::current_exe().ok();
    let current_sid = current_user_sid();
    let mut runs = Vec::new();
    for line in lines {
        let record = parse_csv_line(line);
        let get = |i: Option<usize>| {
            i.and_then(|n| record.get(n)).map(|s| s.trim()).unwrap_or("").to_string()
        };
        let full = get(i_name);
        // schtasks repeats the header row per folder; skip anything that is not
        // a direct child of OUR folder.
        if !full.starts_with(&prefix) {
            continue;
        }
        let name = full[prefix.len()..].to_string();
        if name.is_empty() || name.contains('\\') {
            continue;
        }
        // The CSV's command column is truncation-prone, and it contains none
        // of the trigger or principal settings. Only a complete XML readback
        // can safely produce an editable profile.
        let definition = task_definition_xml(&full);
        let enabled = definition
            .as_ref()
            .map(|(enabled, _)| *enabled)
            .unwrap_or(true);
        let profile = definition
            .as_ref()
            .and_then(|(_, xml)| {
                current_exe
                    .as_deref()
                    .and_then(|exe| profile_from_task_xml(&name, xml, exe, current_sid.as_deref()))
            });
        let (action_name, action_steps, action_missing) = read_action_summary(profile.as_ref());
        runs.push(ScheduledRun {
            name: name.clone(),
            profile,
            status: get(i_status),
            enabled,
            next_run: get(i_next),
            last_run: get(i_last),
            last_result: get(i_result),
            action_name,
            action_steps,
            action_missing,
        });
    }
    Ok(runs)
}

/// Delete a scheduled run. Refuses any name that could address a task outside
/// our own folder — this is the destructive call, so it gets the narrow gate.
#[tauri::command]
pub async fn delete_scheduled_run(name: String) -> Result<(), String> {
    if !valid_task_name(&name) {
        return Err(format!("Not a schedule this app created: {name}"));
    }
    // The GUI owns the WHOLE lifecycle: a deleted action schedule leaves no
    // frozen file behind. The file is the one the task names, and only when
    // it is an action file of this task in our own folder — never a pattern.
    // A definition that cannot be read leaves the file to the orphan reclaim.
    let _registering = REGISTRATION.lock().unwrap_or_else(|e| e.into_inner());
    let named = actions_dir()
        .ok()
        .and_then(|dir| registered_action(&dir, &name).ok().flatten());
    delete_with(named, || {
        run(schtasks().args(["/Delete", "/F", "/TN", &task_path(&name)])).map(drop)
    })
}

/// Run a scheduled batch immediately, through Task Scheduler, so it runs under
/// exactly the identity it will use on its own — testing it any other way tests
/// the wrong thing.
#[tauri::command]
pub async fn run_scheduled_now(name: String) -> Result<(), String> {
    if !valid_task_name(&name) {
        return Err(format!("Not a schedule this app created: {name}"));
    }
    run(schtasks().args(["/Run", "/TN", &task_path(&name)]))?;
    Ok(())
}

/// Enable or disable without deleting — the "pause this for now" the user
/// otherwise has to open Task Scheduler for.
#[tauri::command]
pub async fn set_scheduled_run_enabled(name: String, enabled: bool) -> Result<(), String> {
    if !valid_task_name(&name) {
        return Err(format!("Not a schedule this app created: {name}"));
    }
    run(schtasks().args([
        "/Change",
        "/TN",
        &task_path(&name),
        if enabled { "/ENABLE" } else { "/DISABLE" },
    ]))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn action_profile() -> ScheduleProfile {
        ScheduleProfile {
            name: "Nightly Strip".into(),
            source: r"C:\in folder".into(),
            dest: r"C:\out".into(),
            lang: String::new(),
            moved_root: String::new(),
            error_root: String::new(),
            repair_damaged: false,
            replace_repaired_originals: false,
            log_dir: r"C:\logs".into(),
            frequency: "daily".into(),
            time: "03:00".into(),
            days: String::new(),
            account: String::new(),
            account_password_required: false,
            enabled: true,
            in_place: false,
            mrc: false,
            mrc_preset: String::new(),
            mrc_verify_text: false,
            enhance: false,
            enhance_orientation: true,
            remove_empty_folders: false,
            repair_only: false,
            run_type: "action".into(),
            action_file: r"C:\ProgramData\Spectra PDF\scheduled-actions\Nightly Strip.json"
                .into(),
        }
    }

    /// The password belongs in exactly one place: the in-process VARIANT handed
    /// to `RegisterTask`. It must not reach the task definition, which Windows
    /// stores on disk and `schtasks /Query /XML` reads back; `password` is
    /// consulted only to pick the LogonType.
    #[test]
    fn the_password_never_reaches_the_task_definition() {
        const SECRET: &str = "correct-horse-battery-staple";
        let mut p = action_profile();
        p.account = r"CONTOSO\svc_pdf".into();

        let xml = build_task_xml(r"C:\app.exe", &p, Some(SECRET)).unwrap();
        assert!(
            !xml.contains(SECRET),
            "the password leaked into the task XML"
        );
        assert!(
            xml.contains("<LogonType>Password</LogonType>"),
            "a supplied password must select Password logon, or the task never runs"
        );
        assert!(xml.contains(r"CONTOSO\svc_pdf"));

        // No password on a named account is the (g)MSA shape: S4U, no secret.
        let xml = build_task_xml(r"C:\app.exe", &p, None).unwrap();
        assert!(xml.contains("<LogonType>S4U</LogonType>"));

        // No account at all runs as the interactive user.
        p.account = String::new();
        let xml = build_task_xml(r"C:\app.exe", &p, None).unwrap();
        assert!(xml.contains("<LogonType>InteractiveToken</LogonType>"));
    }

    /// Exercises the COM registration end to end. `#[ignore]`d because it
    /// touches the machine's task store; run it deliberately with:
    ///
    ///   cargo test scheduler -- --ignored
    ///
    /// The other tests are compile-time or string-level, and a COM call that
    /// compiles can still fail at runtime on a CLSID, an apartment or a VARIANT
    /// type. Registers under the app's own folder, then deletes.
    ///
    /// CI runs this (and the fresh-folder test below) on every push: the
    /// hosted runner has no `\Spectra PDF\` folder, so there this IS the
    /// fresh-install acceptance — the case the dev machine can never
    /// reproduce, because its folder already exists.
    ///
    /// Covers the InteractiveToken path. The Password path is the same call
    /// with a populated VARIANT and needs real domain credentials.
    #[test]
    #[ignore]
    fn com_registration_round_trip() {
        let mut p = action_profile();
        p.name = "ZZ Probe DELETE ME".into();
        let xml = build_task_xml(r"C:\Windows\System32\cmd.exe", &p, None).unwrap();
        let full = task_path(&p.name);

        register_task_com(full.clone(), xml, String::new(), None)
            .expect("COM registration failed");

        let listed = run(schtasks().args(["/Query", "/TN", &full]));
        let found = listed.is_ok();

        let _ = run(schtasks().args(["/Delete", "/F", "/TN", &full]));

        assert!(found, "task registered via COM but schtasks could not see it");
    }

    /// The fresh-machine case, provable on ANY machine: registration into a
    /// folder that does not exist yet must succeed and end with the task
    /// queryable. RegisterTask is not documented to create folders, although
    /// current Windows builds may do so. The test pins the whole path; on
    /// builds where the undocumented behavior is absent, it pins the ensure
    /// step itself. Uses its own probe folder so the app's real folder —
    /// which may hold a user's schedules — is never touched or deleted.
    #[test]
    #[ignore]
    fn com_registration_creates_the_missing_folder() {
        // Pid + nanos: a pid alone is reusable across runs, and a stale
        // probe folder would make this test pass without the feature.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let folder = format!("Spectra PDF Probe {}-{nanos}", std::process::id());
        let mut p = action_profile();
        p.name = "ZZ Fresh DELETE ME".into();
        let xml = build_task_xml(r"C:\Windows\System32\cmd.exe", &p, None).unwrap();
        let full = format!("\\{folder}\\{}", p.name);

        let registered = register_task_com(full.clone(), xml, String::new(), None);

        let found = registered.is_ok() && run(schtasks().args(["/Query", "/TN", &full])).is_ok();

        // Cleanup before asserting: a failed assert must not strand the probe.
        let _ = run(schtasks().args(["/Delete", "/F", "/TN", &full]));
        delete_task_folder(&folder);

        registered.expect("registration into a fresh folder failed");
        assert!(
            found,
            "task registered into a fresh folder but schtasks could not see it"
        );
    }

    /// Test-only cleanup: schtasks can delete tasks but not FOLDERS.
    fn delete_task_folder(folder: &str) {
        use windows::core::BSTR;
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        };
        use windows::Win32::System::TaskScheduler::{ITaskService, TaskScheduler};
        use windows::Win32::System::Variant::VARIANT;
        unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let owned = init.is_ok();
            let service: Result<ITaskService, _> =
                CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER);
            if let Ok(service) = service {
                if service
                    .Connect(
                        &VARIANT::default(),
                        &VARIANT::default(),
                        &VARIANT::default(),
                        &VARIANT::default(),
                    )
                    .is_ok()
                {
                    if let Ok(root) = service.GetFolder(&BSTR::from("\\")) {
                        let _ = root.DeleteFolder(&BSTR::from(folder), 0);
                    }
                }
            }
            if owned {
                CoUninitialize();
            }
        }
    }

    #[test]
    fn action_arguments_invoke_the_run_action_arm() {
        let args = build_arguments("exe", &action_profile());
        assert_eq!(
            args,
            r#"run-action "C:\in folder" --dest "C:\out" --action "C:\ProgramData\Spectra PDF\scheduled-actions\Nightly Strip.json" --log-dir "C:\logs""#
        );
    }

    #[test]
    fn run_action_command_round_trips_to_a_profile() {
        // The command line is the single source of truth: the UI must read
        // back exactly the run that will fire, for the action arm too.
        let p = action_profile();
        let command = format!("\"C:\\Program Files\\app.exe\" {}", build_arguments("exe", &p));
        let parsed = profile_from_command(&p.name, &command).expect("parses");
        assert_eq!(parsed.run_type, "action");
        assert_eq!(parsed.source, p.source);
        assert_eq!(parsed.dest, p.dest);
        assert_eq!(parsed.action_file, p.action_file);
        assert_eq!(parsed.log_dir, p.log_dir);
        // A run-action command with no --action is not a schedule we can
        // explain — reported as profile-less rather than half-parsed.
        assert!(profile_from_command("x", "app.exe run-action \"C:\\a\" --dest \"C:\\b\"").is_none());
    }

    #[test]
    fn task_xml_yields_the_full_unescaped_command() {
        // The CSV column truncates (~261 chars, verified live) — the XML is
        // the faithful source, entities unescaped, exe + args joined.
        let xml = r#"<Task><Actions Context="Author"><Exec>
      <Command>C:\Program Files\app.exe</Command>
      <Arguments>run-action &quot;C:\in &amp; out\src&quot; --dest &quot;C:\out&quot; --action &quot;C:\ProgramData\Spectra PDF\scheduled-actions\N.json&quot;</Arguments>
    </Exec></Actions></Task>"#;
        assert_eq!(extract_tag(xml, "Command").as_deref(), Some(r"C:\Program Files\app.exe"));
        let args = extract_tag(xml, "Arguments").expect("arguments");
        assert_eq!(
            args,
            r#"run-action "C:\in & out\src" --dest "C:\out" --action "C:\ProgramData\Spectra PDF\scheduled-actions\N.json""#
        );
        let parsed = profile_from_command("N", &format!("\"C:\\Program Files\\app.exe\" {args}"))
            .expect("parses");
        assert_eq!(parsed.source, r"C:\in & out\src");
        assert_eq!(
            parsed.action_file,
            r"C:\ProgramData\Spectra PDF\scheduled-actions\N.json"
        );
    }

    #[test]
    fn batch_ocr_parsing_is_unchanged() {
        let command = r#"app.exe batch-ocr "C:\scans" --dest "C:\done" --lang eng --repair"#;
        let parsed = profile_from_command("Legacy", command).expect("parses");
        assert_eq!(parsed.run_type, "batch-ocr");
        assert_eq!(parsed.source, r"C:\scans");
        assert!(parsed.repair_damaged);
        assert!(parsed.action_file.is_empty());
        // A command line written before these flags existed reads back with
        // enhancement off and its orientation half at the shipped default.
        assert!(!parsed.enhance && parsed.enhance_orientation);
        assert!(!parsed.in_place && !parsed.mrc);
    }

    #[test]
    fn unsupported_task_command_arguments_are_not_offered_for_editing() {
        for command in [
            r#"app.exe batch-ocr "C:\scans" --dest "C:\done" --future-option"#,
            r#"app.exe batch-ocr "C:\scans" --dest "C:\done" unexpected-operand"#,
            r#"app.exe batch-ocr "C:\scans" --dest "C:\done" --lang"#,
            r#"app.exe batch-ocr "C:\scans" --dest "C:\done" --lang """#,
            r#"app.exe batch-ocr "C:\scans" --dest "C:\done" --mrc-verify-text"#,
        ] {
            assert!(
                profile_from_command("Legacy", command).is_none(),
                "unsupported task command was offered for editing: {command}"
            );
        }
    }

    #[test]
    fn task_arguments_must_start_with_a_supported_verb() {
        let p = ocr_profile();
        let xml = build_test_task_xml(&p, None).replace(
            "<Arguments>batch-ocr",
            "<Arguments>--future-option batch-ocr",
        );
        assert!(parse_test_task_xml(&p.name, &xml).is_none());
    }

    fn ocr_profile() -> ScheduleProfile {
        ScheduleProfile {
            name: "Nightly Scans".into(),
            source: r"C:\intake".into(),
            dest: r"C:\searchable".into(),
            lang: "eng+fra".into(),
            moved_root: r"C:\done".into(),
            error_root: r"C:\failed".into(),
            repair_damaged: true,
            replace_repaired_originals: true,
            log_dir: r"C:\logs".into(),
            frequency: "daily".into(),
            time: "03:00".into(),
            days: String::new(),
            account: String::new(),
            account_password_required: false,
            enabled: true,
            in_place: false,
            mrc: true,
            mrc_preset: "smallest".into(),
            mrc_verify_text: true,
            enhance: true,
            enhance_orientation: false,
            remove_empty_folders: true,
            repair_only: false,
            run_type: "batch-ocr".into(),
            action_file: String::new(),
        }
    }

    fn build_test_task_xml(p: &ScheduleProfile, password: Option<&str>) -> String {
        let exe = std::env::current_exe().expect("test executable path");
        let exe = exe.to_string_lossy();
        build_task_xml(&exe, p, password).expect("valid test task XML")
    }

    fn parse_test_task_xml(name: &str, xml: &str) -> Option<ScheduleProfile> {
        parse_test_task_xml_for_user(name, xml, None)
    }

    fn parse_test_task_xml_for_user(
        name: &str,
        xml: &str,
        current_sid: Option<&str>,
    ) -> Option<ScheduleProfile> {
        let exe = std::env::current_exe().ok()?;
        profile_from_task_xml(name, xml, &exe, current_sid)
    }

    #[test]
    fn task_xml_round_trips_weekly_trigger_and_password_logon() {
        let mut p = ocr_profile();
        p.frequency = "weekly".into();
        p.days = "MON,FRI".into();
        p.time = "22:45".into();
        p.account = r"CORP\Scanner".into();
        p.account_password_required = true;

        let xml = build_test_task_xml(&p, Some("secret"));
        let loaded = parse_test_task_xml(&p.name, &xml).expect("editable task profile");
        assert_eq!(loaded.frequency, p.frequency);
        assert_eq!(loaded.days, p.days);
        assert_eq!(loaded.time, p.time);
        assert_eq!(loaded.account, p.account);
        assert!(loaded.account_password_required);
        assert!(loaded.enabled);
    }

    #[test]
    fn empty_run_type_uses_the_documented_batch_ocr_default() {
        let source = tempfile::tempdir().expect("source folder");
        let profile: ScheduleProfile = serde_json::from_value(serde_json::json!({
            "name": "Legacy OCR",
            "source": source.path(),
            "dest": r"C:\\searchable",
            "frequency": "daily",
            "time": "03:00"
        }))
        .expect("profile without runType deserializes");

        assert_eq!(profile.run_type, "");
        assert!(validate_profile(&profile).is_ok());
        assert!(build_arguments("app.exe", &profile).starts_with("batch-ocr "));

        let mut invalid = profile;
        invalid.lang = "eng --repair".into();
        assert!(validate_profile(&invalid).is_err());
    }

    #[test]
    fn editing_a_disabled_task_preserves_its_disabled_state() {
        let mut p = ocr_profile();
        p.enabled = false;
        let xml = build_test_task_xml(&p, None);
        let loaded = parse_test_task_xml(&p.name, &xml).expect("editable task profile");
        assert!(!loaded.enabled);
        assert!(xml.contains("<Enabled>false</Enabled>"));
    }

    #[test]
    fn task_xml_round_trips_s4u_without_requesting_a_password() {
        let mut p = ocr_profile();
        p.account = r"CORP\nightly$".into();
        let xml = build_test_task_xml(&p, None);
        let loaded = parse_test_task_xml(&p.name, &xml).expect("editable task profile");
        assert_eq!(loaded.account, p.account);
        assert!(!loaded.account_password_required);
    }

    #[test]
    fn replacing_password_logon_schedule_requires_the_secret_again() {
        let mut p = ocr_profile();
        p.account = r"CORP\Scanner".into();
        p.account_password_required = true;
        let exe = std::env::current_exe().unwrap();
        let exe = exe.to_string_lossy();
        let error = build_task_xml(&exe, &p, None).expect_err("must not downgrade");
        assert!(error.contains("Enter it again"), "{error}");
    }

    #[test]
    fn unknown_task_trigger_is_not_offered_as_an_editable_profile() {
        let p = ocr_profile();
        let xml = build_test_task_xml(&p, None).replace(
            "<DaysInterval>1</DaysInterval>",
            "<DaysInterval>2</DaysInterval>",
        );
        assert!(parse_test_task_xml(&p.name, &xml).is_none());

        let xml = build_test_task_xml(&p, None).replace(
            "<Triggers>",
            "<Triggers><TimeTrigger><Enabled>true</Enabled></TimeTrigger>",
        );
        assert!(parse_test_task_xml(&p.name, &xml).is_none());

        let xml = build_test_task_xml(&p, None).replace("2020-01-01", "2030-01-01");
        assert!(parse_test_task_xml(&p.name, &xml).is_none());
    }

    #[test]
    fn a_calendar_trigger_with_unpreserved_modifiers_is_not_offered_for_editing() {
        let p = ocr_profile();
        let base = build_test_task_xml(&p, None);
        for modifier in [
            "<EndBoundary>2030-01-01T03:00:00</EndBoundary>",
            "<Repetition><Interval>PT5M</Interval><Duration>PT1H</Duration></Repetition>",
            "<RandomDelay>PT15M</RandomDelay>",
            "<Delay>PT15M</Delay>",
            "<ExecutionTimeLimit>PT1H</ExecutionTimeLimit>",
        ] {
            let xml = base.replace(
                "</CalendarTrigger>",
                &format!("{modifier}</CalendarTrigger>"),
            );
            assert!(
                parse_test_task_xml(&p.name, &xml).is_none(),
                "calendar modifier was offered for editing: {modifier}"
            );
        }
    }

    #[test]
    fn unknown_task_privilege_or_run_policy_is_not_offered_for_editing() {
        let p = ocr_profile();
        let xml = build_test_task_xml(&p, None);
        let elevated = xml.replace(
            "<RunLevel>LeastPrivilege</RunLevel>",
            "<RunLevel>HighestAvailable</RunLevel>",
        );
        assert!(parse_test_task_xml(&p.name, &elevated).is_none());
        let parallel = xml.replace(
            "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
            "<MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>",
        );
        assert!(parse_test_task_xml(&p.name, &parallel).is_none());
    }

    #[test]
    fn task_with_an_unpreserved_wake_setting_is_not_offered_for_editing() {
        let p = ocr_profile();
        let xml = build_test_task_xml(&p, None).replace(
            "</Settings>",
            "<WakeToRun>true</WakeToRun></Settings>",
        );
        assert!(parse_test_task_xml(&p.name, &xml).is_none());
    }

    #[test]
    fn a_task_with_unpreserved_execution_settings_is_not_offered_for_editing() {
        let p = ocr_profile();
        let base = build_test_task_xml(&p, None);
        for setting in [
            "<AllowStartOnDemand>false</AllowStartOnDemand>",
            "<AllowHardTerminate>false</AllowHardTerminate>",
            "<RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>",
            "<RunOnlyIfIdle>true</RunOnlyIfIdle>",
            "<UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>",
            "<DisallowStartOnRemoteAppSession>true</DisallowStartOnRemoteAppSession>",
            "<Volatile>true</Volatile>",
            "<Priority>5</Priority>",
            "<DeleteExpiredTaskAfter>P1D</DeleteExpiredTaskAfter>",
            "<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>",
            "<MaintenanceSettings><Period>P7D</Period><Deadline>P1M</Deadline></MaintenanceSettings>",
        ] {
            let xml = base.replace("</Settings>", &format!("{setting}</Settings>"));
            assert!(
                parse_test_task_xml(&p.name, &xml).is_none(),
                "execution setting was offered for editing: {setting}"
            );
        }
    }

    #[test]
    fn a_task_with_unpreserved_principal_restrictions_is_not_offered_for_editing() {
        let p = ocr_profile();
        let base = build_test_task_xml(&p, None);
        for restriction in [
            "<ProcessTokenSidType>Unrestricted</ProcessTokenSidType>",
            "<RequiredPrivileges><Privilege>SeChangeNotifyPrivilege</Privilege></RequiredPrivileges>",
        ] {
            let xml = base.replace("</Principal>", &format!("{restriction}</Principal>"));
            assert!(
                parse_test_task_xml(&p.name, &xml).is_none(),
                "principal restriction was offered for editing: {restriction}"
            );
        }
    }

    #[test]
    fn a_task_repointed_to_another_executable_is_not_offered_for_editing() {
        let p = ocr_profile();
        let xml = build_task_xml("foreign.exe", &p, None).expect("valid task XML");
        assert!(parse_test_task_xml(&p.name, &xml).is_none());
    }

    #[test]
    fn an_interactive_task_with_a_foreign_user_sid_is_not_offered_for_editing() {
        let p = ocr_profile();
        let current_sid = "S-1-5-21-1-2-3-1001";
        let xml = build_test_task_xml(&p, None).replace(
            "<LogonType>InteractiveToken</LogonType>",
            "<UserId>S-1-5-21-1-2-3-1105</UserId><LogonType>InteractiveToken</LogonType>",
        );

        assert!(parse_test_task_xml_for_user(&p.name, &xml, Some(current_sid)).is_none());
        assert!(parse_test_task_xml_for_user(&p.name, &xml, None).is_none());
        let own = xml.replace("S-1-5-21-1-2-3-1105", current_sid);
        let loaded = parse_test_task_xml_for_user(&p.name, &own, Some(current_sid))
            .expect("an interactive task belonging to the current user is editable");
        assert!(loaded.account.is_empty());
    }

    /// Uses Task Scheduler itself to produce the XML that the product reads.
    /// This is ignored in the normal suite because it registers and removes a
    /// uniquely named task in an isolated probe folder.
    #[test]
    #[ignore]
    fn schtasks_readback_with_omitted_defaults_remains_editable() {
        let suffix = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let folder = format!("Spectra PDF Probe {}-{suffix}", std::process::id());
        let mut profile = action_profile();
        profile.name = format!("Readback {}-{suffix}", std::process::id());
        profile.enabled = false;
        let exe = std::env::current_exe().expect("test executable path");
        let xml = build_task_xml(&exe.to_string_lossy(), &profile, None).expect("valid task XML");
        let full = format!("\\{folder}\\{}", profile.name);

        let registered = register_task_com(full.clone(), xml, String::new(), None);
        let readback = registered.and_then(|()| run(schtasks().args(["/Query", "/TN", &full, "/XML"])));
        let _ = run(schtasks().args(["/Delete", "/F", "/TN", &full]));
        delete_task_folder(&folder);

        let readback = readback.expect("registered task's schtasks XML readback");
        let trigger_xml = extract_tag(&readback, "Triggers").expect("readback triggers");
        let settings_xml = extract_tag(&readback, "Settings").expect("readback settings");
        let principals_xml = extract_tag(&readback, "Principals").expect("readback principals");
        let omitted_defaults = [
            optional_tag(&trigger_xml, "Enabled").expect("trigger Enabled shape"),
            optional_tag(&settings_xml, "Enabled").expect("settings Enabled shape"),
            optional_tag(&settings_xml, "Hidden").expect("Hidden shape"),
            optional_tag(&principals_xml, "RunLevel").expect("RunLevel shape"),
        ];
        assert!(
            omitted_defaults.iter().any(Option::is_none),
            "Task Scheduler readback did not omit any of the default-valued elements"
        );
        let current_sid = current_user_sid();
        let loaded = profile_from_task_xml(&profile.name, &readback, &exe, current_sid.as_deref())
            .expect("real schtasks readback remains editable");
        assert_eq!(loaded.run_type, profile.run_type);
        assert_eq!(loaded.source, profile.source);
        assert_eq!(loaded.dest, profile.dest);
        assert_eq!(loaded.frequency, profile.frequency);
        assert_eq!(loaded.time, profile.time);
        assert_eq!(loaded.action_file, profile.action_file);
        assert!(!loaded.enabled);
    }

    #[test]
    fn a_task_with_an_unpreserved_working_directory_is_not_offered_for_editing() {
        let p = ocr_profile();
        let xml = build_test_task_xml(&p, None).replace(
            "</Exec>",
            "<WorkingDirectory>C:\\scheduled-work</WorkingDirectory></Exec>",
        );
        assert!(parse_test_task_xml(&p.name, &xml).is_none());
    }

    /// A named preset is EXPANDED into the command line at scheduling time —
    /// there is no preset reference to resolve later, because the task fires
    /// with the app closed and cannot read the app's own store. So every
    /// setting has to survive the round trip through the argument string, or
    /// the schedule silently runs a different job from the one that was saved.
    #[test]
    fn every_preset_setting_survives_the_command_line_round_trip() {
        let p = ocr_profile();
        let command = format!("\"C:\\Program Files\\app.exe\" {}", build_arguments("exe", &p));
        let parsed = profile_from_command(&p.name, &command).expect("parses");
        assert_eq!(parsed.source, p.source);
        assert_eq!(parsed.dest, p.dest);
        assert_eq!(parsed.lang, p.lang);
        assert_eq!(parsed.moved_root, p.moved_root);
        assert_eq!(parsed.error_root, p.error_root);
        assert_eq!(parsed.log_dir, p.log_dir);
        assert!(parsed.repair_damaged && parsed.replace_repaired_originals);
        assert!(parsed.mrc && parsed.mrc_verify_text);
        assert_eq!(parsed.mrc_preset, "smallest");
        assert!(parsed.enhance);
        assert!(!parsed.enhance_orientation);
        assert!(parsed.remove_empty_folders);
        assert!(!parsed.in_place);
        assert!(!parsed.repair_only);
        let mut off = p.clone();
        off.remove_empty_folders = false;
        let args = build_arguments("exe", &off);
        assert!(!args.contains("--remove-empty-folders"), "{args}");
        assert!(!args.contains("--repair-only"), "{args}");
    }

    #[test]
    fn a_repair_only_schedule_round_trips_and_refuses_ocr_switches() {
        let mut p = ocr_profile();
        p.repair_only = true;
        p.mrc = false;
        p.mrc_preset = String::new();
        p.mrc_verify_text = false;
        p.enhance = false;
        p.enhance_orientation = true;
        p.repair_damaged = false;
        p.source = std::env::temp_dir().to_string_lossy().to_string();
        assert!(validate_profile(&p).is_ok());
        let args = build_arguments("exe", &p);
        assert!(args.contains("--repair-only"), "{args}");
        assert!(!args.contains("--repair "), "{args}");
        assert!(!args.ends_with("--repair"), "{args}");
        let command = format!("\"C:\\Program Files\\app.exe\" {args}");
        let parsed = profile_from_command(&p.name, &command).expect("parses");
        assert!(parsed.repair_only);
        assert!(parsed.replace_repaired_originals);
        assert!(!parsed.repair_damaged && !parsed.mrc && !parsed.enhance);
        assert_eq!(parsed.moved_root, p.moved_root);
        assert_eq!(parsed.error_root, p.error_root);

        let mut in_place = p.clone();
        in_place.in_place = true;
        in_place.dest = String::new();
        in_place.moved_root = String::new();
        let command = format!(
            "\"C:\\Program Files\\app.exe\" {}",
            build_arguments("exe", &in_place)
        );
        let parsed = profile_from_command(&p.name, &command).expect("parses");
        assert!(parsed.repair_only && parsed.in_place);

        let mut with_mrc = p.clone();
        with_mrc.mrc = true;
        let error = validate_profile(&with_mrc).unwrap_err();
        assert!(error.contains("repair-only"), "{error}");
        let mut with_enhance = p.clone();
        with_enhance.enhance = true;
        assert!(validate_profile(&with_enhance).is_err());
        let mut with_repair = p.clone();
        with_repair.repair_damaged = true;
        assert!(validate_profile(&with_repair).is_err());
        assert!(profile_from_command(
            &p.name,
            &format!("\"C:\\app.exe\" {} --repair", build_arguments("exe", &p)),
        )
        .is_none());
        assert!(profile_from_command(
            &p.name,
            &format!("\"C:\\app.exe\" {} --mrc", build_arguments("exe", &p)),
        )
        .is_none());
    }

    #[test]
    fn scheduled_folder_paths_ending_in_backslashes_round_trip() {
        let mut p = ocr_profile();
        p.source = r"C:\".into();
        p.dest = r"D:\out folder\".into();
        p.moved_root = r"E:\processed folder\".into();
        p.error_root = r"F:\failed folder\".into();
        p.log_dir = r"G:\logs folder\".into();

        let args = build_arguments("exe", &p);
        let parsed = profile_from_command(&p.name, &format!(r#""C:\Program Files\app.exe" {args}"#))
            .expect("parses");
        assert_eq!(parsed.source, p.source);
        assert_eq!(parsed.dest, p.dest);
        assert_eq!(parsed.moved_root, p.moved_root);
        assert_eq!(parsed.error_root, p.error_root);
        assert_eq!(parsed.log_dir, p.log_dir);
    }

    #[test]
    fn windows_argument_quoting_round_trips_quotes_and_backslashes() {
        let values = ["", "plain", "has space", r#"embedded \" quote"#, r"ends\\"];
        for value in values {
            assert_eq!(tokenize(&quote_windows_arg(value)), [value], "{value:?}");
        }
    }

    #[test]
    fn schedule_rejects_unsupported_modes_and_argument_values() {
        let mut p = ocr_profile();
        p.source = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(validate_profile(&p).is_ok());

        p.frequency = "once".into();
        assert!(validate_profile(&p).is_err());
        p.frequency = "daily".into();
        p.run_type = "unknown".into();
        assert!(validate_profile(&p).is_err());
        p.run_type = "batch-ocr".into();
        p.lang = "eng --in-place".into();
        assert!(validate_profile(&p).is_err());
        p.lang = "eng+fra".into();
        p.mrc_preset = "smallest --repair".into();
        assert!(validate_profile(&p).is_err());
    }

    #[test]
    fn weekly_schedule_rejects_days_it_would_otherwise_silently_drop() {
        let mut p = ocr_profile();
        p.source = std::env::temp_dir().to_string_lossy().into_owned();
        p.frequency = "weekly".into();
        p.days = "MON,FRI".into();
        assert!(validate_profile(&p).is_ok());
        p.days = "MON,NOT-A-DAY,FRI".into();
        assert!(validate_profile(&p).is_err());
        p.days = "MON,,FRI".into();
        assert!(validate_profile(&p).is_err());
        p.days = "MON,mon".into();
        assert!(validate_profile(&p).is_err());

        p.days = "MON".into();
        p.time = "24:00".into();
        assert!(validate_profile(&p).is_err());
        p.time = "09:60".into();
        assert!(validate_profile(&p).is_err());
        p.time = "23:59".into();
        assert!(validate_profile(&p).is_ok());
    }

    #[test]
    fn an_in_place_schedule_carries_no_destination() {
        let mut p = ocr_profile();
        p.in_place = true;
        p.dest = String::new();
        p.moved_root = String::new();
        let args = build_arguments("exe", &p);
        assert!(args.contains("--in-place"), "{args}");
        assert!(!args.contains("--dest"), "{args}");
        let parsed = profile_from_command(&p.name, &format!("app.exe {args}")).expect("parses");
        assert!(parsed.in_place);
        assert!(parsed.dest.is_empty());
    }

    /// The three refusals that would otherwise register a task describing a
    /// run the engine refuses on its first firing.
    #[test]
    fn in_place_refuses_the_settings_it_retires() {
        let mut p = ocr_profile();
        // The source must EXIST for validation to reach the in-place rules —
        // the missing-folder refusal fires first and would pass this test for
        // the wrong reason.
        p.source = std::env::temp_dir().to_string_lossy().to_string();
        p.in_place = true;
        p.moved_root = String::new();
        assert!(validate_profile(&p).is_err(), "a destination alongside in-place");
        p.dest = String::new();
        p.moved_root = r"C:\done".into();
        assert!(validate_profile(&p).is_err(), "a moved root alongside in-place");
        p.moved_root = String::new();
        assert!(validate_profile(&p).is_ok());
        p.run_type = "action".into();
        assert!(validate_profile(&p).is_err(), "an in-place guided action");
    }

    /// The orientation half defaults ON, so the OFF case is the one the
    /// command line spells. An enhancement schedule that left orientation
    /// alone must not emit the flag at all.
    #[test]
    fn the_orientation_flag_is_written_only_when_it_is_off() {
        let mut p = ocr_profile();
        p.enhance_orientation = true;
        let args = build_arguments("exe", &p);
        assert!(args.contains("--enhance"), "{args}");
        assert!(!args.contains("--no-enhance-orientation"), "{args}");
        assert!(
            profile_from_command(&p.name, &format!("app.exe {args}"))
                .expect("parses")
                .enhance_orientation
        );
        p.enhance = false;
        let args = build_arguments("exe", &p);
        assert!(!args.contains("--enhance"), "{args}");
    }

    fn listing(dir: &Path) -> std::collections::BTreeSet<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect()
    }

    #[test]
    fn a_registration_file_name_carries_its_task_and_its_writer() {
        let name = registration_action_name("Nightly v1.2", 4300, "0a1b2c3d");
        assert_eq!(name, "Nightly v1.2@4300-0a1b2c3d.json");
        assert_eq!(registration_action_owner(&name), Some(("Nightly v1.2", 4300)));
        assert_eq!(legacy_action_file(&name), None);
        assert_eq!(legacy_stage_task(&name), None);
        for other in [
            "Nightly v1.2.json",
            "Nightly v1.2.json.new",
            "Nightly@04300-0a1b2c3d.json",
            "Nightly@4300-0A1B2C3D.json",
            "Nightly@4300-0a1b2c3.json",
            "Nightly@4300-0a1b2c3d4.json",
            "Nightly@4300-0a1b2c3g.json",
            "Nightly@4300.json",
            "Nightly@x-0a1b2c3d.json",
            "Nightly@4300-0a1b2c3d.json.new",
            "Nightly@4300-0a1b2c3d.JSON",
            "a+b@4300-0a1b2c3d.json",
            "..@4300-0a1b2c3d.json",
            "@4300-0a1b2c3d.json",
            "Nightly@4300@1-0a1b2c3d.json",
        ] {
            assert_eq!(registration_action_owner(other), None, "{other}");
        }
        assert_eq!(legacy_action_file("Nightly v1.2.json"), Some("Nightly v1.2"));
        assert_eq!(legacy_stage_task("Nightly v1.2.json.new"), Some("Nightly v1.2"));
        for other in ["a+b.json", ".json", "Nightly.JSON", "Nightly.json.new"] {
            assert_eq!(legacy_action_file(other), None, "{other}");
        }
        for other in ["a+b.json.new", ".json.new", "Nightly.json.4300.new", "Nightly.json"] {
            assert_eq!(legacy_stage_task(other), None, "{other}");
        }
    }

    fn definition_naming(action: &Path) -> String {
        let mut p = action_profile();
        p.action_file = action.to_string_lossy().to_string();
        build_task_xml(r"C:\Program Files\Spectra PDF\spectrapdf.exe", &p, None).unwrap()
    }

    #[test]
    fn only_an_action_file_of_the_task_in_its_folder_is_the_named_action() {
        let dir = tempfile::tempdir().unwrap();
        let task = "Nightly Strip";
        let own = dir.path().join(registration_action_name(task, 4300, "0a1b2c3d"));
        let legacy = dir.path().join(format!("{task}.json"));
        let other_task = dir.path().join(registration_action_name("Weekly", 4300, "0a1b2c3d"));
        let other_legacy = dir.path().join("Weekly.json");
        let elsewhere = tempfile::tempdir().unwrap();
        let outside = elsewhere.path().join(registration_action_name(task, 4300, "0a1b2c3d"));
        let stranger = dir.path().join("notes.txt");

        let named = |action: &Path| named_action(dir.path(), task, &definition_naming(action));
        assert_eq!(named(&own), Some(own.clone()));
        assert_eq!(named(&legacy), Some(legacy.clone()));
        assert_eq!(named(&other_task), None);
        assert_eq!(named(&other_legacy), None);
        assert_eq!(named(&outside), None);
        assert_eq!(named(&stranger), None);
        let batch = build_task_xml("exe", &ocr_profile(), None).unwrap();
        assert_eq!(named_action(dir.path(), task, &batch), None);
    }

    /// The instant Windows accepts a task, the file it names already holds the
    /// action it was registered with, and the file the task named before is
    /// still whole: a process killed at that instant leaves a task that runs
    /// its own action.
    #[test]
    fn the_file_a_registration_names_holds_its_own_action_when_windows_accepts_it() {
        let dir = tempfile::tempdir().unwrap();
        let previous = dir.path().join("Nightly Strip.json");
        std::fs::write(&previous, b"{\"steps\":[\"old\"]}").unwrap();
        let mut profile = action_profile();
        let mut accepted = None;

        register_with_action(
            &mut profile,
            Some("{\"steps\":[\"new\"]}"),
            Ok(dir.path().to_path_buf()),
            Ok(Some(previous.clone())),
            |registered| {
                let named = PathBuf::from(&registered.action_file);
                assert_eq!(std::fs::read(&named).unwrap(), b"{\"steps\":[\"new\"]}");
                assert_eq!(std::fs::read(&previous).unwrap(), b"{\"steps\":[\"old\"]}");
                accepted = Some(named);
                Ok(())
            },
        )
        .unwrap();

        let named = accepted.unwrap();
        assert_eq!(profile.action_file, named.to_string_lossy());
        let name = named.file_name().unwrap().to_str().unwrap();
        assert_eq!(
            registration_action_owner(name),
            Some(("Nightly Strip", std::process::id()))
        );
        assert_eq!(named.parent().unwrap(), dir.path());
        assert!(!previous.exists(), "the replaced action stayed");
        assert_eq!(listing(dir.path()), [name.to_string()].into());
    }

    #[test]
    fn a_refused_registration_keeps_the_current_action_and_leaves_no_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join(registration_action_name("Nightly Strip", 4300, "0a1b2c3d"));
        std::fs::write(&current, b"{\"steps\":[\"current\"]}").unwrap();
        let mut profile = action_profile();

        let refused = register_with_action(
            &mut profile,
            Some("{\"steps\":[\"new\"]}"),
            Ok(dir.path().to_path_buf()),
            Ok(Some(current.clone())),
            |_| Err("Access is denied.".to_string()),
        );

        assert_eq!(refused.unwrap_err(), "Access is denied.");
        assert_eq!(std::fs::read(&current).unwrap(), b"{\"steps\":[\"current\"]}");
        assert_eq!(
            listing(dir.path()),
            [current.file_name().unwrap().to_str().unwrap().to_string()].into()
        );
    }

    #[test]
    fn a_registration_without_an_action_keeps_the_file_the_task_names() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join(registration_action_name("Nightly Strip", 4300, "0a1b2c3d"));
        std::fs::write(&current, b"{\"steps\":[\"current\"]}").unwrap();
        let mut profile = action_profile();
        profile.action_file = r"C:\somewhere\else.json".into();

        register_with_action(
            &mut profile,
            None,
            Ok(dir.path().to_path_buf()),
            Ok(Some(current.clone())),
            |registered| {
                assert_eq!(registered.action_file, current.to_string_lossy());
                Ok(())
            },
        )
        .unwrap();
        assert!(current.exists(), "the kept action was removed");
        assert_eq!(listing(dir.path()).len(), 1);

        let register_nothing = |_: &ScheduleProfile| -> Result<(), String> {
            panic!("a schedule without its action was registered")
        };
        let missing = dir.path().join(registration_action_name("Nightly Strip", 4300, "ffffffff"));
        for current in [Ok(None), Ok(Some(missing)), Err("unreadable".to_string())] {
            let refused = register_with_action(
                &mut action_profile(),
                None,
                Ok(dir.path().to_path_buf()),
                current,
                register_nothing,
            );
            assert!(refused.is_err());
        }
    }

    #[test]
    fn a_batch_run_replacing_an_action_schedule_drops_its_file_once_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let current = dir.path().join(registration_action_name("Nightly Scans", 4300, "0a1b2c3d"));
        std::fs::write(&current, b"{}").unwrap();

        let refused = register_with_action(
            &mut ocr_profile(),
            None,
            Err("ProgramData is not set".to_string()),
            Ok(Some(current.clone())),
            |_| Err("refused".to_string()),
        );
        assert!(refused.is_err());
        assert!(current.exists());

        register_with_action(
            &mut ocr_profile(),
            None,
            Err("ProgramData is not set".to_string()),
            Ok(Some(current.clone())),
            |registered| {
                assert!(registered.action_file.is_empty());
                assert!(current.exists());
                Ok(())
            },
        )
        .unwrap();
        assert!(!current.exists());
    }

    #[test]
    fn a_deletion_removes_the_named_file_only_once_the_task_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let named = dir.path().join(registration_action_name("Nightly Strip", 4300, "0a1b2c3d"));
        std::fs::write(&named, b"{}").unwrap();
        assert!(delete_with(Some(named.clone()), || Err("refused".into())).is_err());
        assert!(named.exists());
        delete_with(Some(named.clone()), || Ok(())).unwrap();
        assert!(!named.exists());
        delete_with(None, || Ok(())).unwrap();
    }

    /// A process id that no running process holds while the returned child is
    /// alive: the child has exited, and its handle keeps the id from reuse.
    #[cfg(windows)]
    fn stopped_process() -> (std::process::Child, u32) {
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        child.wait().unwrap();
        let pid = child.id();
        (child, pid)
    }

    #[test]
    fn an_orphan_goes_only_when_no_running_writer_or_task_can_name_it() {
        const OWN: u32 = 4100;
        const LIVE: u32 = 4200;
        const DEAD: u32 = 4300;
        let dir = tempfile::tempdir().unwrap();
        let file = |name: String| {
            std::fs::write(dir.path().join(&name), b"{}").unwrap();
            name
        };
        let own = file(registration_action_name("A", OWN, "0a1b2c3d"));
        let live = file(registration_action_name("A", LIVE, "0a1b2c3d"));
        let dead = file(registration_action_name("A", DEAD, "0a1b2c3d"));
        let dead_named = file(registration_action_name("B", DEAD, "0a1b2c3d"));
        let dead_foreign = file(registration_action_name("C", DEAD, "0a1b2c3d"));
        let legacy = file("D.json".to_string());
        let legacy_named = file("E.json".to_string());
        let stage_alone = file("F.json.new".to_string());
        let stage_named = file("G.json.new".to_string());
        let stranger = file("notes.json.bak".to_string());
        let folder = registration_action_name("H", DEAD, "0a1b2c3d");
        std::fs::create_dir(dir.path().join(&folder)).unwrap();
        let definitions = vec![
            format!("<Arguments>--action \"C:\\data\\{}\"</Arguments>", dead_named.to_uppercase()),
            format!("<Arguments>--action \"C:/data/{legacy_named}\"</Arguments>"),
            r#"<Arguments>--action "C:\data\G.json"</Arguments>"#.to_string(),
            // A longer name that ends in another file's name keeps nothing.
            r#"<Arguments>--action "C:\data\XD.json"</Arguments>"#.to_string(),
        ];
        let ours = |path: &Path| !path.ends_with(&dead_foreign);
        let later = SystemTime::now() + crate::staging::LEGACY_STAGE_AGE + Duration::from_secs(60);

        let removed = reclaim_orphans_with(
            dir.path(),
            OWN,
            |pid| pid == LIVE,
            ours,
            later,
            || Ok(definitions),
        );

        assert_eq!(removed, 3);
        let kept: std::collections::BTreeSet<String> = [
            own,
            live,
            dead_named,
            dead_foreign,
            legacy_named,
            stage_named,
            stranger,
            folder,
        ]
        .into();
        assert_eq!(listing(dir.path()), kept);
        assert!(![dead, legacy, stage_alone].iter().any(|n| dir.path().join(n).exists()));
    }

    #[test]
    fn a_young_file_without_a_process_id_and_an_unread_task_list_keep_every_file() {
        const OWN: u32 = 4100;
        let dir = tempfile::tempdir().unwrap();
        for name in ["D.json".to_string(), "F.json.new".to_string()] {
            std::fs::write(dir.path().join(name), b"{}").unwrap();
        }
        let untouched = || -> Result<Vec<String>, String> {
            panic!("the task list was read with no candidate to check")
        };
        let now = SystemTime::now();
        assert_eq!(reclaim_orphans_with(dir.path(), OWN, |_| false, |_| true, now, untouched), 0);

        let dead = registration_action_name("A", 4300, "0a1b2c3d");
        std::fs::write(dir.path().join(&dead), b"{}").unwrap();
        let unread = || Err("Task Scheduler is unavailable".to_string());
        assert_eq!(reclaim_orphans_with(dir.path(), OWN, |_| false, |_| true, now, unread), 0);
        assert_eq!(listing(dir.path()).len(), 3);

        // A stage whose action file is beside it is the other rule's to take.
        std::fs::write(dir.path().join("D.json.new"), b"{}").unwrap();
        let later = now + crate::staging::LEGACY_STAGE_AGE + Duration::from_secs(60);
        let found = orphan_candidates(dir.path(), OWN, |_| false, |_| true, later);
        let names: Vec<String> = found
            .iter()
            .map(|o| o.path.file_name().unwrap().to_str().unwrap().to_string())
            .collect();
        assert!(!names.contains(&"D.json.new".to_string()), "{names:?}");
        assert_eq!(found.len(), 3, "{names:?}");
    }

    #[cfg(windows)]
    #[test]
    fn an_orphan_a_handle_holds_open_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (_writer, dead) = stopped_process();
        let held = dir.path().join(registration_action_name("A", dead, "0a1b2c3d"));
        std::fs::write(&held, b"{}").unwrap();
        let handle = std::fs::File::open(&held).unwrap();
        let reclaim = || {
            reclaim_orphans_with(
                dir.path(),
                std::process::id(),
                crate::staging::process_running,
                owned_by_this_account,
                SystemTime::now(),
                || Ok(Vec::new()),
            )
        };
        assert_eq!(reclaim(), 0);
        assert!(held.exists());
        drop(handle);
        assert_eq!(reclaim(), 1);
        assert!(!held.exists());
    }

    fn section(source: &'static str, start: &str, end: &str) -> &'static str {
        let from = source.find(start).expect(start);
        let to = from + source[from..].find(end).expect(end);
        &source[from..to]
    }

    /// The commands run against the machine's task store, so their wiring is
    /// pinned in the source: the listing reclaims orphans, a registration
    /// reads the file its task names before it replaces it, and a deletion
    /// removes the file the task named.
    #[test]
    fn the_commands_follow_each_task_s_action_file() {
        let source = include_str!("scheduler.rs");
        let listing = section(source, "pub async fn list_scheduled_runs", "let out = match run(");
        assert!(listing.contains("reclaim_orphaned_actions(&dir);"));
        assert!(listing.contains("reclaim_legacy_action_stages(&dir, SystemTime::now());"));
        let create = section(
            source,
            "pub async fn create_scheduled_run",
            "Ok(task_path(&profile.name))",
        );
        assert!(create.contains("Ok(dir) => registered_action(dir, &profile.name),"));
        assert!(create.contains("register_with_action(&mut profile, json, dir, current, |profile| {"));
        let delete = section(source, "pub async fn delete_scheduled_run", "#[tauri::command]");
        assert!(delete.contains(".and_then(|dir| registered_action(&dir, &name).ok().flatten());"));
        assert!(delete.contains("delete_with(named, || {"));
    }

    #[cfg(windows)]
    #[test]
    fn only_a_file_this_account_created_is_ours() {
        let dir = tempfile::tempdir().unwrap();
        let mine = dir.path().join("mine.json");
        std::fs::write(&mine, b"{}").unwrap();
        assert!(owned_by_this_account(&mine));
        let windir = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap();
        assert!(!owned_by_this_account(&windir.join("System32").join("kernel32.dll")));
        assert!(!owned_by_this_account(&dir.path().join("absent.json")));
    }

    #[test]
    fn a_registration_action_is_held_until_its_outcome_and_abandoning_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let written = RegistrationAction::write(dir.path(), "Nightly Strip", "{\"steps\":[]}").unwrap();
        assert_eq!(std::fs::read(&written.path).unwrap(), b"{\"steps\":[]}");
        #[cfg(windows)]
        assert!(crate::staging::held_open(&written.path));
        let path = written.path.clone();
        written.abandon();
        assert!(!path.exists());

        let kept = RegistrationAction::write(dir.path(), "Nightly Strip", "{}").unwrap();
        let path = kept.path.clone();
        kept.release();
        #[cfg(windows)]
        assert!(!crate::staging::held_open(&path));
        assert!(path.exists());
    }

    /// The Task Scheduler reads, against the real store: what a registration
    /// names reads back through the definition, and absence is not an error.
    /// Uses a probe folder of its own, deleted at the end.
    #[test]
    #[ignore]
    fn com_definitions_read_back_the_action_a_registration_names() {
        let nanos = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let folder = format!("Spectra PDF Probe {}-{nanos}", std::process::id());
        let dir = tempfile::tempdir().unwrap();
        let mut p = action_profile();
        p.name = "ZZ Actions DELETE ME".into();
        let action = dir.path().join(registration_action_name(&p.name, 4300, "0a1b2c3d"));
        p.action_file = action.to_string_lossy().to_string();
        let full = format!("\\{folder}\\{}", p.name);
        let xml = build_task_xml(r"C:\Windows\System32\cmd.exe", &p, None).unwrap();

        let registered = register_task_com(full.clone(), xml, String::new(), None);
        let definition = registered_task_definition(full.clone());
        let listed = folder_task_definitions(format!("\\{folder}"));
        let absent_task = registered_task_definition(format!("\\{folder}\\ZZ Absent"));
        let absent_folder = folder_task_definitions(format!("\\{folder} Absent"));

        let _ = run(schtasks().args(["/Delete", "/F", "/TN", &full]));
        delete_task_folder(&folder);

        registered.expect("registration failed");
        let definition = definition.unwrap().expect("the registered task reads back");
        assert_eq!(named_action(dir.path(), &p.name, &definition), Some(action.clone()));
        let listed = listed.unwrap();
        assert_eq!(listed.len(), 1);
        let name = action.file_name().unwrap().to_str().unwrap();
        assert!(mentioned(&listed, name));
        assert_eq!(absent_task.unwrap(), None);
        assert!(absent_folder.unwrap().is_empty());
    }

    /// The whole replace against the real store, in a probe folder: after two
    /// registrations the task names the second file, which holds the second
    /// action, and the first file is gone.
    #[test]
    #[ignore]
    fn com_a_replaced_schedule_names_its_own_complete_action() {
        let nanos = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let folder = format!("Spectra PDF Probe {}-{nanos}", std::process::id());
        let dir = tempfile::tempdir().unwrap();
        let task = "ZZ Replace DELETE ME";
        let full = format!("\\{folder}\\{task}");
        let register = |p: &ScheduleProfile| {
            let xml = build_task_xml(r"C:\Windows\System32\cmd.exe", p, None)?;
            register_task_com(full.clone(), xml, String::new(), None)
        };
        let current = || {
            registered_task_definition(full.clone())
                .map(|found| found.and_then(|d| named_action(dir.path(), task, &d)))
        };
        let mut outcome = Vec::new();
        for steps in ["[\"first\"]", "[\"second\"]"] {
            let mut p = action_profile();
            p.name = task.into();
            let json = format!("{{\"steps\":{steps}}}");
            outcome.push(register_with_action(
                &mut p,
                Some(&json),
                Ok(dir.path().to_path_buf()),
                current(),
                &register,
            ));
        }
        let named = current();

        let _ = run(schtasks().args(["/Delete", "/F", "/TN", &full]));
        delete_task_folder(&folder);

        for registered in outcome {
            registered.expect("registration failed");
        }
        let named = named.unwrap().expect("the task names an action file");
        assert_eq!(std::fs::read(&named).unwrap(), b"{\"steps\":[\"second\"]}");
        assert_eq!(
            listing(dir.path()),
            [named.file_name().unwrap().to_str().unwrap().to_string()].into()
        );
    }

    #[test]
    fn only_a_legacy_stage_beside_its_action_file_is_one_to_take() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Nightly v1.2.json"), "{}").unwrap();
        // A name no schedule can carry, even with a file of that name beside it.
        std::fs::write(dir.path().join("a+b.json"), "{}").unwrap();
        assert!(legacy_action_stage(dir.path(), "Nightly v1.2.json.new"));
        for other in [
            "a+b.json.new",
            // The only copy of a registered task's action.
            "Orphaned.json.new",
            "Nightly v1.2.json.4300.new",
            "Nightly v1.2.json",
            "Nightly v1.2.json.new.bak",
            "Nightly v1.2.JSON.NEW",
            "..\\Nightly v1.2.json.new",
            ".json.new",
        ] {
            assert!(!legacy_action_stage(dir.path(), other), "{other}");
        }
    }

    #[test]
    fn a_listing_reclaims_a_legacy_stage_only_once_it_is_old_enough() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "Nightly.json",
            "Nightly.json.new",
            "Orphaned.json.new",
            "Weekly.json",
        ] {
            std::fs::write(dir.path().join(name), "{}").unwrap();
        }
        let now = std::time::SystemTime::now();
        assert_eq!(reclaim_legacy_action_stages(dir.path(), now), 0);
        let later = now + crate::staging::LEGACY_STAGE_AGE + std::time::Duration::from_secs(60);
        assert_eq!(reclaim_legacy_action_stages(dir.path(), later), 1);
        assert_eq!(
            listing(dir.path()),
            ["Nightly.json", "Orphaned.json.new", "Weekly.json"]
                .map(String::from)
                .into()
        );
    }
}
