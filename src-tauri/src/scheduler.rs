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
//! **One source of truth.** The registered task IS the store: its `<Arguments>`
//! carry the whole run, and its `<Description>` carries the profile JSON the UI
//! renders. Keeping a parallel profile file would let the two disagree about
//! what a schedule does, and the one that actually fires would be the one the
//! user cannot see.
//!
//! **Scoped to our own folder.** Everything lives under `\Spectra PDF\`, so
//! enumeration and deletion address a folder we created rather than pattern-
//! matching across the machine — the same discipline as the batch-log sweep and
//! `delete_batch_scratch`. This code never touches a task outside that folder.

use std::path::PathBuf;
use std::process::Command;

use tauri::AppHandle;

/// The one Task Scheduler folder this app writes to. Everything below is
/// scoped to it; nothing outside it is ever listed, changed or deleted.
const TASK_FOLDER: &str = "Spectra PDF";

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
    /// "daily" | "weekly" | "once"
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
    /// Which CLI arm the task invokes: "batch-ocr" (the default, also for
    /// empty) or "action" — a guided-action run over the source tree.
    #[serde(default)]
    pub run_type: String,
    /// Action runs only: the frozen action file the task reads. Set by
    /// `create_scheduled_run` (never by the caller) — derived from the task
    /// name inside this app's machine-scoped scheduled-actions folder.
    #[serde(default)]
    pub action_file: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
    pub name: String,
    /// The profile as stored in the task's description. `None` when the task
    /// was edited outside the app and no longer carries one — shown as such
    /// rather than hidden, because it will still FIRE.
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

fn action_file_path(name: &str) -> Result<PathBuf, String> {
    // `name` has passed valid_task_name: no separators, no wildcards — safe
    // as a file name inside our own folder.
    Ok(actions_dir()?.join(format!("{name}.json")))
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

/// The refusals that must happen BEFORE a task is registered.
///
/// A run under a service account resolves `%APPDATA%` inside that account's
/// profile, so a scheduled run's log would land somewhere the person who set it
/// up cannot see. Registering such a task without an explicit shared log folder
/// produces exactly the failure this whole logging feature exists to prevent —
/// an unattended run with no findable audit trail.
pub fn validate_profile(p: &ScheduleProfile) -> Result<(), String> {
    if !valid_task_name(&p.name) {
        return Err(
            "A schedule name may use letters, numbers, spaces, dots, hyphens and underscores only."
                .into(),
        );
    }
    if p.source.trim().is_empty() || p.dest.trim().is_empty() {
        return Err("A scheduled run needs both a source and a destination folder.".into());
    }
    if !PathBuf::from(&p.source).is_dir() {
        return Err(format!("Source folder not found: {}", p.source));
    }
    if !p.time.is_empty()
        && !(p.time.len() == 5
            && p.time.as_bytes()[2] == b':'
            && p.time[..2].chars().all(|c| c.is_ascii_digit())
            && p.time[3..].chars().all(|c| c.is_ascii_digit()))
    {
        return Err("Time must be HH:MM (24-hour).".into());
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
        let mut args = format!(
            "run-action \"{}\" --dest \"{}\" --action \"{}\"",
            p.source, p.dest, p.action_file
        );
        if !p.log_dir.is_empty() {
            args.push_str(&format!(" --log-dir \"{}\"", p.log_dir));
        }
        return args;
    }
    let mut args = format!(
        "batch-ocr \"{}\" --dest \"{}\" --lang {}",
        p.source,
        p.dest,
        if p.lang.is_empty() { "eng" } else { &p.lang }
    );
    if !p.moved_root.is_empty() {
        args.push_str(&format!(" --moved \"{}\"", p.moved_root));
    }
    if !p.error_root.is_empty() {
        args.push_str(&format!(" --errors \"{}\"", p.error_root));
    }
    if p.repair_damaged {
        args.push_str(" --repair");
    }
    if p.replace_repaired_originals {
        args.push_str(" --replace-repaired");
    }
    if !p.log_dir.is_empty() {
        args.push_str(&format!(" --log-dir \"{}\"", p.log_dir));
    }
    args
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
/// keeps the file already on disk.
#[tauri::command]
pub async fn create_scheduled_run(
    app: AppHandle,
    mut profile: ScheduleProfile,
    password: Option<String>,
    action_json: Option<String>,
) -> Result<String, String> {
    validate_profile(&profile)?;
    if profile.run_type == "action" {
        let file = action_file_path(&profile.name)?;
        profile.action_file = file.to_string_lossy().to_string();
        if action_json.as_deref().map_or(true, |j| j.trim().is_empty()) && !file.is_file() {
            return Err("An action schedule needs a guided action to run.".into());
        }
    }
    let exe = std::env::current_exe()
        .map_err(|e| format!("Cannot resolve this application's path: {e}"))?
        .to_string_lossy()
        .to_string();
    let _ = app;

    // Stage the frozen action beside its final name and swap it in only after
    // Windows accepts the task: a failed registration must not clobber the
    // file an EXISTING schedule of the same name is still reading.
    let mut staged_action: Option<(PathBuf, PathBuf)> = None;
    if profile.run_type == "action" {
        if let Some(json) = action_json.as_deref().filter(|j| !j.trim().is_empty()) {
            let final_path = PathBuf::from(&profile.action_file);
            let staging = final_path.with_extension("json.new");
            if let Some(parent) = final_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Could not create the scheduled-actions folder: {e}"))?;
            }
            std::fs::write(&staging, json)
                .map_err(|e| format!("Could not write the action file: {e}"))?;
            staged_action = Some((staging, final_path));
        }
    }

    // Registration goes through TASK XML, not `/TR`, and that is not a style
    // choice: `/TR` is capped at 261 characters by schtasks, and a real run
    // (exe path + source + destination + moved + error + log folders) exceeds
    // that cap with realistic paths.
    let xml = build_task_xml(&exe, &profile, password.as_deref())?;

    // COM takes the XML as a string, so no staged temp file and no
    // UTF-16-with-BOM encoding (both were schtasks requirements). The
    // 261-character `/TR` cap above is still why the definition is XML.
    let outcome = register_task_com(
        task_path(&profile.name),
        xml,
        profile.account.trim().to_string(),
        password.clone(),
    );
    if outcome.is_err() {
        if let Some((staging, _)) = &staged_action {
            let _ = std::fs::remove_file(staging);
        }
    }
    outcome.map_err(|e| {
        // The two failures worth naming, because both register-then-never-fire.
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
    })?;
    if let Some((staging, final_path)) = staged_action {
        // Windows refuses a rename onto an existing file — clear the old
        // frozen copy first (the replace case).
        if final_path.is_file() {
            let _ = std::fs::remove_file(&final_path);
        }
        std::fs::rename(&staging, &final_path).map_err(|e| {
            format!(
                "The schedule was created but its action file could not be placed: {e}\n\
                 Delete and recreate the schedule."
            )
        })?;
    }

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
            let days: Vec<String> = p
                .days
                .split(',')
                .map(|d| d.trim().to_uppercase())
                .filter(|d| !d.is_empty())
                .map(|d| match d.as_str() {
                    "MON" => "<Monday />".to_string(),
                    "TUE" => "<Tuesday />".to_string(),
                    "WED" => "<Wednesday />".to_string(),
                    "THU" => "<Thursday />".to_string(),
                    "FRI" => "<Friday />".to_string(),
                    "SAT" => "<Saturday />".to_string(),
                    "SUN" => "<Sunday />".to_string(),
                    _ => String::new(),
                })
                .filter(|d| !d.is_empty())
                .collect();
            if days.is_empty() {
                return Err("A weekly schedule needs at least one day.".into());
            }
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
    <Enabled>true</Enabled>
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
    ))
}

/// Split a command line on spaces, respecting double quotes.
fn tokenize(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in line.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Rebuild the profile from the command line the task will actually run.
///
/// The COMMAND LINE is the single source of truth on purpose. A parallel
/// profile file could disagree with it, and the one that would actually fire is
/// the one the user cannot see — so the UI reads back exactly what will run.
fn profile_from_command(name: &str, command: &str) -> Option<ScheduleProfile> {
    let tokens = tokenize(command);
    let (start, run_type) = match tokens.iter().position(|t| t == "batch-ocr") {
        Some(i) => (i, "batch-ocr"),
        None => (tokens.iter().position(|t| t == "run-action")?, "action"),
    };
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
        run_type: run_type.to_string(),
        action_file: String::new(),
    };
    let mut i = 0;
    while i < rest.len() {
        let tok = rest[i].as_str();
        let mut take_value = |target: &mut String| {
            if i + 1 < rest.len() {
                *target = rest[i + 1].clone();
                i += 1;
            }
        };
        match tok {
            "--dest" => take_value(&mut p.dest),
            "--lang" => take_value(&mut p.lang),
            "--moved" => take_value(&mut p.moved_root),
            "--errors" => take_value(&mut p.error_root),
            "--log-dir" => take_value(&mut p.log_dir),
            "--action" => take_value(&mut p.action_file),
            "--repair" => p.repair_damaged = true,
            "--replace-repaired" => p.replace_repaired_originals = true,
            other if !other.starts_with("--") && p.source.is_empty() => {
                p.source = other.to_string();
            }
            _ => {}
        }
        i += 1;
    }
    if p.source.is_empty() || p.dest.is_empty() {
        return None;
    }
    if p.run_type == "action" && p.action_file.is_empty() {
        return None;
    }
    Some(p)
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

/// The command line a task will run, read from its XML definition.
///
/// NOT from the CSV listing: schtasks' "Task To Run" column TRUNCATES around
/// 261 characters and prints embedded quotes raw (both verified live) — a
/// run-action command with real paths overflows it, and the truncation +
/// quote desync turned the parsed profile into garbage. The XML is the full,
/// properly-escaped definition.
fn task_command_line(full_task_path: &str) -> Option<(String, bool)> {
    let xml = run(schtasks().args(["/Query", "/TN", full_task_path, "/XML"])).ok()?;
    let cmd = extract_tag(&xml, "Command").unwrap_or_default();
    let args = extract_tag(&xml, "Arguments").unwrap_or_default();
    // `<Enabled>` appears inside TRIGGERS as well, and a trigger precedes
    // <Settings> in schtasks' XML — so the settings block is sliced out first
    // and the tag read from THAT. Absent (or unreadable) means enabled, which
    // is Task Scheduler's own default.
    let enabled = extract_tag(&xml, "Settings")
        .as_deref()
        .and_then(|s| extract_tag(s, "Enabled"))
        .map(|v| !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true);
    if cmd.is_empty() && args.is_empty() {
        return None;
    }
    Some((format!("{cmd} {args}"), enabled))
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
    let (i_name, i_next, i_status, i_last, i_result, i_cmd) = (
        idx("TaskName"),
        idx("Next Run Time"),
        idx("Status"),
        idx("Last Run Time"),
        idx("Last Result"),
        idx("Task To Run"),
    );

    let prefix = format!("\\{TASK_FOLDER}\\");
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
        // The CSV's own command column is truncation-prone — the task XML is
        // the faithful source; the column stays as a last-resort fallback.
        let (command, enabled) = task_command_line(&full).unwrap_or_else(|| (get(i_cmd), true));
        let profile = profile_from_command(&name, &command);
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
    run(schtasks().args(["/Delete", "/F", "/TN", &task_path(&name)]))?;
    // The GUI owns the WHOLE lifecycle: a deleted action schedule leaves no
    // frozen file behind. Addressed inside our own folder by the validated
    // name — never a pattern. Best-effort: the task is already gone.
    if let Ok(file) = action_file_path(&name) {
        if file.is_file() {
            let _ = std::fs::remove_file(&file);
        }
    }
    Ok(())
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
    }
}
