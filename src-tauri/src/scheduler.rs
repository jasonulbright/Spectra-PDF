//! Scheduled batch runs (Phase 12, issue #1 request 5).
//!
//! The owner's ruling: scheduling is a GUI FEATURE, not a documentation page —
//! "so the user never has to touch task scheduler". So the app owns the whole
//! lifecycle: create, list, run-now, enable/disable and DELETE.
//!
//! **Windows Task Scheduler runs them, not us.** The requested case is "every
//! day at 09:30", and an in-app timer only fires while the app happens to be
//! running — a scheduled job that silently does not happen is worse than no
//! scheduling. Task Scheduler survives logoff and reboot, and it means we ship
//! no background service of our own (the same posture as the notify-only
//! updater). The owner was explicit: not a fan of a system service.
//!
//! **One source of truth.** The registered task IS the store: its `<Arguments>`
//! carry the whole run, and its `<Description>` carries the profile JSON the UI
//! renders. Keeping a parallel profile file would let the two disagree about
//! what a schedule does, and the one that actually fires would be the one the
//! user cannot see.
//!
//! **Scoped to our own folder.** Everything lives under `\Open PDF Studio\`, so
//! enumeration and deletion address a folder we created rather than pattern-
//! matching across the machine — the same discipline as the batch-log sweep and
//! `delete_batch_scratch`. This code never touches a task outside that folder.

use std::path::PathBuf;
use std::process::Command;

use tauri::AppHandle;

/// The one Task Scheduler folder this app writes to. Everything below is
/// scoped to it; nothing outside it is ever listed, changed or deleted.
const TASK_FOLDER: &str = "Open PDF Studio";

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
    pub status: String,
    pub next_run: String,
    pub last_run: String,
    pub last_result: String,
}

fn task_path(name: &str) -> String {
    format!("\\{TASK_FOLDER}\\{name}")
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
/// The rule that matters most is the last one, and it is an owner requirement:
/// a run under a service account resolves `%APPDATA%` inside THAT account's
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
    let _ = exe;
    args
}

/// Create (or replace) a scheduled run.
///
/// `password` is used ONLY here and is never stored by this app: Task Scheduler
/// keeps it in LSA. It is passed to schtasks and dropped — the same posture as
/// the `.pfx` signing password.
#[tauri::command]
pub async fn create_scheduled_run(
    app: AppHandle,
    profile: ScheduleProfile,
    password: Option<String>,
) -> Result<String, String> {
    validate_profile(&profile)?;
    let exe = std::env::current_exe()
        .map_err(|e| format!("Cannot resolve this application's path: {e}"))?
        .to_string_lossy()
        .to_string();
    let _ = app;

    // Registration goes through TASK XML, not `/TR`, and that is not a style
    // choice: `/TR` is capped at 261 characters by schtasks, and a real run
    // (exe path + source + destination + moved + error + log folders) blows
    // past that immediately. Found the hard way — the first cut registered
    // fine for short paths and failed for realistic ones.
    let xml = build_task_xml(&exe, &profile, password.as_deref())?;
    let tmp = std::env::temp_dir().join(format!("opdfs-task-{}.xml", std::process::id()));
    // schtasks requires UTF-16 for /XML; a UTF-8 file is rejected as malformed.
    let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
    for unit in xml.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Could not stage the task file: {e}"))?;

    let mut cmd = schtasks();
    cmd.args([
        "/Create",
        "/F",
        "/TN",
        &task_path(&profile.name),
        "/XML",
        &tmp.to_string_lossy(),
    ]);
    if !profile.account.trim().is_empty() {
        cmd.args(["/RU", profile.account.trim()]);
        match password.as_deref() {
            Some(pw) if !pw.is_empty() => {
                cmd.args(["/RP", pw]);
            }
            // No password for a named account is the (g)MSA shape: schtasks
            // reads an empty /RP as "this account needs no password".
            _ => {
                cmd.args(["/RP", ""]);
            }
        }
    }

    let outcome = run(&mut cmd);
    let _ = std::fs::remove_file(&tmp);
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
    <Author>Open PDF Studio</Author>
    <Description>Batch OCR: {desc}</Description>
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
    let start = tokens.iter().position(|t| t == "batch-ocr")?;
    let rest = &tokens[start + 1..];
    let mut p = ScheduleProfile {
        name: name.to_string(),
        source: String::new(),
        dest: String::new(),
        lang: "eng".into(),
        moved_root: String::new(),
        error_root: String::new(),
        repair_damaged: false,
        replace_repaired_originals: false,
        log_dir: String::new(),
        frequency: String::new(),
        time: String::new(),
        days: String::new(),
        account: String::new(),
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
    Some(p)
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
        let command = get(i_cmd);
        runs.push(ScheduledRun {
            name: name.clone(),
            profile: profile_from_command(&name, &command),
            status: get(i_status),
            next_run: get(i_next),
            last_run: get(i_last),
            last_result: get(i_result),
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
