//! Scheduled runs on Linux: one systemd user timer and its service per run.
//!
//! The user's systemd manager runs them, so a run happens whether or not the
//! app is open, and under the user who created it — the only account a user
//! unit can run as. The unit files ARE the store, as the registered task is on
//! Windows: the service's `ExecStart=` carries the job options, the timer's
//! `OnCalendar=` the schedule, and the timer's enablement whether it is paused.
//!
//! Units live in the user unit directory `$XDG_CONFIG_HOME/systemd/user`
//! (systemd.unit(5)) and are named `spectrapdf-run-<16 hex>`, the hex being
//! the start of the SHA-256 of the run's name, which a unit name cannot hold
//! verbatim. The name itself rides in `X-SpectraPDF-Name=`, a key systemd
//! ignores. Nothing outside that prefix is ever listed, changed or deleted.
//!
//! Semantics carried over from the Task Scheduler definition:
//!   * `Persistent=true` (systemd.timer(5)) is StartWhenAvailable: a run the
//!     machine was off or the user signed out for starts as soon as the timer
//!     is active again;
//!   * `Type=oneshot` (systemd.service(5)) is IgnoreNew: a timer elapsing
//!     while the run is still active starts nothing, and a oneshot service has
//!     no start timeout, as ExecutionTimeLimit PT0S has none.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use super::{ScheduleProfile, ScheduledRun};

pub const NO_USER_MANAGER: &str = "Scheduled runs need a systemd user session, and this session \
     has none (for example on a system that does not run systemd).";
const RUNS_AS_YOU: &str =
    "On this system a scheduled run always runs as you. Leave \"Run as\" empty.";

const UNIT_PREFIX: &str = "spectrapdf-run-";
const NAME_KEY: &str = "X-SpectraPDF-Name";

/// Whether this session has a systemd user manager: the system was booted
/// with systemd (sd_booted(3): `/run/systemd/system` exists) and the user
/// manager's runtime directory exists under `$XDG_RUNTIME_DIR`.
pub fn user_manager_present() -> bool {
    Path::new("/run/systemd/system").is_dir()
        && std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .is_some_and(|runtime| runtime.is_absolute() && runtime.join("systemd").is_dir())
}

fn units_dir() -> Result<PathBuf, String> {
    crate::autostart_linux::config_home(
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
    .map(|config| config.join("systemd").join("user"))
    .ok_or_else(|| "Cannot locate the systemd user unit folder: HOME is not set".to_string())
}

/// `$XDG_DATA_HOME`, or `$HOME/.local/share` when it is unset or relative.
fn data_home(xdg: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    match xdg.filter(|p| p.is_absolute()) {
        Some(data) => Some(data),
        None => home
            .filter(|p| p.is_absolute())
            .map(|home| home.join(".local").join("share")),
    }
}

/// Where frozen action files live. User-scoped: a user unit runs as the user
/// who created it, so nothing else ever reads the file.
pub(super) fn actions_dir() -> Result<PathBuf, String> {
    data_home(
        std::env::var_os("XDG_DATA_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
    .map(|data| data.join("com.spectrapdf.app").join("scheduled-actions"))
    .ok_or_else(|| "HOME is not set".to_string())
}

fn unit_stem(name: &str) -> String {
    let digest = Sha256::digest(name.as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("{UNIT_PREFIX}{hex}")
}

/// One argument of a unit command line (systemd.service(5), "Command
/// lines"): double-quoted, with `\` and `"` escaped, `%` doubled against
/// specifier expansion and `$` doubled against variable expansion.
fn quote(arg: &str) -> Result<String, String> {
    if arg.chars().any(char::is_control) {
        return Err(format!("A scheduled run cannot name a path with control characters: {arg:?}"));
    }
    let mut quoted = String::from("\"");
    for ch in arg.chars() {
        match ch {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '%' => quoted.push_str("%%"),
            '$' => quoted.push_str("$$"),
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

/// The arguments of a command line [`quote`] wrote. Anything else — an
/// unquoted word, another escape, a prefix character — is not this app's.
fn unquote(line: &str) -> Option<Vec<String>> {
    let mut args = Vec::new();
    let mut chars = line.chars().peekable();
    loop {
        while chars.peek() == Some(&' ') {
            chars.next();
        }
        match chars.next() {
            None => return Some(args),
            Some('"') => {}
            Some(_) => return None,
        }
        let mut arg = String::new();
        loop {
            match chars.next()? {
                '"' => break,
                '\\' => match chars.next()? {
                    c @ ('\\' | '"') => arg.push(c),
                    _ => return None,
                },
                '%' => {
                    if chars.next()? != '%' {
                        return None;
                    }
                    arg.push('%');
                }
                '$' => {
                    if chars.next()? != '$' {
                        return None;
                    }
                    arg.push('$');
                }
                other => arg.push(other),
            }
        }
        if chars.peek().is_some_and(|c| *c != ' ') {
            return None;
        }
        args.push(arg);
    }
}

/// The run's command-line arguments, unquoted. The Windows argument string
/// is the one definition of a run's options; its CRT quoting round-trips
/// exactly through `tokenize`.
fn run_arguments(p: &ScheduleProfile) -> Vec<String> {
    super::tokenize(&super::build_arguments("", p))
}

fn service_text(program: &str, p: &ScheduleProfile) -> Result<String, String> {
    let mut command = quote(program)?;
    for arg in run_arguments(p) {
        command.push(' ');
        command.push_str(&quote(&arg)?);
    }
    Ok(format!(
        "[Unit]\nDescription=Spectra PDF scheduled run: {name}\n{NAME_KEY}={name}\n\n\
         [Service]\nType=oneshot\nExecStart={command}\n",
        name = p.name
    ))
}

fn calendar(p: &ScheduleProfile) -> Result<String, String> {
    let time = if p.time.is_empty() { "09:30" } else { &p.time };
    if p.frequency != "weekly" {
        return Ok(format!("*-*-* {time}:00"));
    }
    super::parse_weekly_days(&p.days)?;
    let days: Vec<String> = p
        .days
        .split(',')
        .map(|day| {
            let day = day.trim().to_ascii_lowercase();
            let mut chars = day.chars();
            chars
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        })
        .collect();
    Ok(format!("{} *-*-* {time}:00", days.join(",")))
}

fn timer_text(p: &ScheduleProfile) -> Result<String, String> {
    Ok(format!(
        "[Unit]\nDescription=Spectra PDF schedule: {name}\n{NAME_KEY}={name}\n\n\
         [Timer]\nOnCalendar={calendar}\nPersistent=true\nUnit={stem}.service\n\n\
         [Install]\nWantedBy=timers.target\n",
        name = p.name,
        calendar = calendar(p)?,
        stem = unit_stem(&p.name),
    ))
}

/// The value of the first `key=` line in `text`.
fn unit_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines()
        .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
}

/// (frequency, time, days) from an `OnCalendar=` value [`calendar`] wrote.
fn schedule_from_calendar(value: &str) -> Option<(String, String, String)> {
    let (head, clock) = value.rsplit_once(' ')?;
    let time = clock.strip_suffix(":00")?.to_string();
    if !super::valid_schedule_time(&time) || time.is_empty() {
        return None;
    }
    if head == "*-*-*" {
        return Some(("daily".into(), time, String::new()));
    }
    let (days, rest) = head.split_once(' ')?;
    if rest != "*-*-*" {
        return None;
    }
    Some(("weekly".into(), time, days.to_ascii_uppercase()))
}

/// The profile both unit files describe, or `None` when either holds
/// anything this editor would not write itself.
fn profile_from_units(
    name: &str,
    service: &str,
    timer: &str,
    expected_program: &Path,
) -> Option<ScheduleProfile> {
    let tokens = unquote(unit_value(service, "ExecStart")?)?;
    let program = tokens.first()?;
    if Path::new(program) != expected_program
        && !same_file::is_same_file(program, expected_program).unwrap_or(false)
    {
        return None;
    }
    let run_type = match tokens.get(1)?.as_str() {
        "batch-ocr" => "batch-ocr",
        "run-action" => "action",
        _ => return None,
    };
    let mut profile = super::profile_from_tokens(name, &tokens, 1, run_type)?;
    let (frequency, time, days) = schedule_from_calendar(unit_value(timer, "OnCalendar")?)?;
    profile.frequency = frequency;
    profile.time = time;
    profile.days = days;
    if service_text(program, &profile).ok()? != service
        || timer_text(&profile).ok()? != timer
    {
        return None;
    }
    Some(profile)
}

/// The action file of `task` in `dir` that a service definition names.
fn named_action(dir: &Path, task: &str, service: &str) -> Option<PathBuf> {
    let tokens = unquote(unit_value(service, "ExecStart")?)?;
    let at = tokens.iter().position(|t| t == "--action")?;
    let named = PathBuf::from(tokens.get(at + 1)?);
    super::action_file_of(dir, task, &named).then_some(named)
}

fn systemctl(args: &[&str]) -> Result<String, String> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                NO_USER_MANAGER.to_string()
            } else {
                format!("Could not run systemctl: {e}")
            }
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.contains("Failed to connect to bus") || stderr.contains("No medium found") {
        return Err(NO_USER_MANAGER.to_string());
    }
    Err(if stderr.is_empty() { stdout.trim().to_string() } else { stderr })
}

fn read_unit(path: &Path) -> Result<Option<String>, String> {
    crate::staging::read_record(path)
        .map(|bytes| bytes.map(|b| String::from_utf8_lossy(&b).into_owned()))
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))
}

/// Restores a unit file to what it held before an install that failed.
fn restore_unit(path: &Path, previous: Option<&str>) {
    let _ = match previous {
        Some(text) => crate::staging::write_record(path, text.as_bytes()),
        None => std::fs::remove_file(path),
    };
}

fn install(units: &Path, program: &str, p: &ScheduleProfile) -> Result<(), String> {
    let stem = unit_stem(&p.name);
    let (service_path, timer_path) = (
        units.join(format!("{stem}.service")),
        units.join(format!("{stem}.timer")),
    );
    let (service, timer) = (service_text(program, p)?, timer_text(p)?);
    std::fs::create_dir_all(units)
        .map_err(|e| format!("Could not create the systemd user unit folder: {e}"))?;
    let previous_service = read_unit(&service_path)?;
    let previous_timer = read_unit(&timer_path)?;
    let timer_unit = format!("{stem}.timer");
    let result = (|| {
        crate::staging::write_record(&service_path, service.as_bytes())
            .map_err(|e| format!("Could not write the schedule: {e}"))?;
        crate::staging::write_record(&timer_path, timer.as_bytes())
            .map_err(|e| format!("Could not write the schedule: {e}"))?;
        systemctl(&["daemon-reload"])?;
        if p.enabled {
            systemctl(&["enable", &timer_unit])?;
            systemctl(&["restart", &timer_unit])?;
        } else {
            systemctl(&["disable", "--now", &timer_unit])?;
        }
        Ok(())
    })();
    if result.is_err() {
        restore_unit(&service_path, previous_service.as_deref());
        restore_unit(&timer_path, previous_timer.as_deref());
        let _ = systemctl(&["daemon-reload"]);
    }
    result
}

/// The service definitions of every run in `units`, for the orphan reclaim.
/// A definition that cannot be read fails the whole read.
fn service_definitions(units: &Path) -> Result<Vec<String>, String> {
    let entries = match std::fs::read_dir(units) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut definitions = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(UNIT_PREFIX) && name.ends_with(".service") {
            definitions.push(std::fs::read_to_string(entry.path()).map_err(|e| e.to_string())?);
        }
    }
    Ok(definitions)
}

fn registered_action(units: &Path, dir: &Path, task: &str) -> Result<Option<PathBuf>, String> {
    let service = units.join(format!("{}.service", unit_stem(task)));
    Ok(read_unit(&service)?.and_then(|text| named_action(dir, task, &text)))
}

/// Whether the process `pid` exists: `kill(pid, 0)` refuses with ESRCH only
/// when it does not.
fn process_running(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn reclaim_orphaned_actions(units: &Path, dir: &Path) -> usize {
    let _registering = super::REGISTRATION.lock().unwrap_or_else(|e| e.into_inner());
    super::reclaim_orphans_with(
        dir,
        std::process::id(),
        process_running,
        super::owned_by_this_account,
        SystemTime::now(),
        || service_definitions(units),
    )
}

pub(super) fn create(
    mut profile: ScheduleProfile,
    password: Option<String>,
    action_json: Option<String>,
) -> Result<String, String> {
    if !profile.account.trim().is_empty() || password.is_some_and(|p| !p.is_empty()) {
        return Err(RUNS_AS_YOU.to_string());
    }
    profile.account_password_required = false;
    super::validate_profile(&profile)?;
    let program = crate::autostart_linux::launch_target()?
        .to_string_lossy()
        .into_owned();
    let units = units_dir()?;

    let _registering = super::REGISTRATION.lock().unwrap_or_else(|e| e.into_inner());
    let dir = actions_dir();
    let current = match &dir {
        Ok(dir) => registered_action(&units, dir, &profile.name),
        Err(e) => Err(e.clone()),
    };
    let json = action_json.as_deref().filter(|j| !j.trim().is_empty());
    super::register_with_action(&mut profile, json, dir, current, |profile| {
        install(&units, &program, profile)
    })?;
    Ok(format!("{}.timer", unit_stem(&profile.name)))
}

/// `KEY=value` blocks of `systemctl show`, one per unit, keyed by `Id`.
fn show_blocks(output: &str) -> std::collections::HashMap<String, std::collections::HashMap<String, String>> {
    let mut blocks = std::collections::HashMap::new();
    for block in output.split("\n\n") {
        let values: std::collections::HashMap<String, String> = block
            .lines()
            .filter_map(|line| line.split_once('='))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        if let Some(id) = values.get("Id").cloned() {
            blocks.insert(id, values);
        }
    }
    blocks
}

/// A `systemctl show` timestamp for display; "n/a", 0 and empty mean none.
fn shown_time(value: Option<&String>) -> String {
    match value.map(|v| v.trim()) {
        None | Some("") | Some("n/a") | Some("0") => String::new(),
        Some(v) => v.to_string(),
    }
}

pub(super) fn list() -> Result<Vec<ScheduledRun>, String> {
    let units = units_dir()?;
    if let Ok(dir) = actions_dir() {
        super::reclaim_legacy_action_stages(&dir, SystemTime::now());
        reclaim_orphaned_actions(&units, &dir);
    }
    let entries = match std::fs::read_dir(&units) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Cannot read {}: {e}", units.display())),
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let Some(stem) = file
            .strip_suffix(".timer")
            .filter(|stem| stem.starts_with(UNIT_PREFIX))
        else {
            continue;
        };
        let Ok(timer) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Some(name) = unit_value(&timer, NAME_KEY).map(str::to_string) else {
            continue;
        };
        if unit_stem(&name) != stem || !super::valid_task_name(&name) {
            continue;
        }
        let service = std::fs::read_to_string(units.join(format!("{stem}.service"))).ok();
        found.push((stem.to_string(), name, timer, service));
    }
    if found.is_empty() {
        return Ok(Vec::new());
    }
    let mut show = vec![
        "show".to_string(),
        "--property=Id,UnitFileState,NextElapseUSecRealtime,ExecMainStartTimestamp,ExecMainStatus"
            .to_string(),
    ];
    for (stem, ..) in &found {
        show.push(format!("{stem}.timer"));
        show.push(format!("{stem}.service"));
    }
    let shown = show_blocks(&systemctl(&show.iter().map(String::as_str).collect::<Vec<_>>())?);
    let program = crate::autostart_linux::launch_target().ok();
    let mut runs = Vec::new();
    for (stem, name, timer, service) in found {
        let empty = std::collections::HashMap::new();
        let timer_state = shown.get(&format!("{stem}.timer")).unwrap_or(&empty);
        let service_state = shown.get(&format!("{stem}.service")).unwrap_or(&empty);
        let enabled = timer_state.get("UnitFileState").map(String::as_str) == Some("enabled");
        let mut profile = match (&service, &program) {
            (Some(service), Some(program)) => profile_from_units(&name, service, &timer, program),
            _ => None,
        };
        if let Some(profile) = profile.as_mut() {
            profile.enabled = enabled;
        }
        let last_run = shown_time(service_state.get("ExecMainStartTimestamp"));
        let last_result = if last_run.is_empty() {
            String::new()
        } else {
            service_state.get("ExecMainStatus").cloned().unwrap_or_default()
        };
        let (action_name, action_steps, action_missing) =
            super::read_action_summary(profile.as_ref());
        runs.push(ScheduledRun {
            name,
            profile,
            status: String::new(),
            enabled,
            next_run: if enabled {
                shown_time(timer_state.get("NextElapseUSecRealtime"))
            } else {
                String::new()
            },
            last_run,
            last_result,
            action_name,
            action_steps,
            action_missing,
        });
    }
    runs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(runs)
}

/// The unit files of `name`, refusing a name this app never created.
fn existing_units(units: &Path, name: &str) -> Result<(String, PathBuf, PathBuf), String> {
    if !super::valid_task_name(name) {
        return Err(format!("Not a schedule this app created: {name}"));
    }
    let stem = unit_stem(name);
    let timer = units.join(format!("{stem}.timer"));
    let service = units.join(format!("{stem}.service"));
    if !timer.is_file() && !service.is_file() {
        return Err(format!("Not a schedule this app created: {name}"));
    }
    Ok((stem, timer, service))
}

pub(super) fn delete(name: &str) -> Result<(), String> {
    let units = units_dir()?;
    let (stem, timer, service) = existing_units(&units, name)?;
    let _registering = super::REGISTRATION.lock().unwrap_or_else(|e| e.into_inner());
    let named = actions_dir()
        .ok()
        .and_then(|dir| registered_action(&units, &dir, name).ok().flatten());
    super::delete_with(named, || {
        if timer.is_file() {
            systemctl(&["disable", "--now", &format!("{stem}.timer")])?;
        }
        for path in [&timer, &service] {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Could not remove {}: {e}", path.display())),
            }
        }
        systemctl(&["daemon-reload"])?;
        let _ = systemctl(&["reset-failed", &format!("{stem}.service")]);
        Ok(())
    })
}

pub(super) fn run_now(name: &str) -> Result<(), String> {
    let units = units_dir()?;
    let (stem, _, service) = existing_units(&units, name)?;
    if !service.is_file() {
        return Err(format!("Not a schedule this app created: {name}"));
    }
    systemctl(&["start", "--no-block", &format!("{stem}.service")]).map(drop)
}

pub(super) fn set_enabled(name: &str, enabled: bool) -> Result<(), String> {
    let units = units_dir()?;
    let (stem, timer, _) = existing_units(&units, name)?;
    if !timer.is_file() {
        return Err(format!("Not a schedule this app created: {name}"));
    }
    let unit = format!("{stem}.timer");
    if enabled {
        systemctl(&["enable", "--now", &unit]).map(drop)
    } else {
        systemctl(&["disable", "--now", &unit]).map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ScheduleProfile {
        ScheduleProfile {
            name: "Nightly Scans".into(),
            source: "/srv/in box".into(),
            dest: "/srv/out".into(),
            lang: "eng+deu".into(),
            moved_root: "/srv/done $HOME 100%".into(),
            error_root: String::new(),
            repair_damaged: true,
            replace_repaired_originals: false,
            log_dir: String::new(),
            frequency: "weekly".into(),
            time: "03:15".into(),
            days: "MON,WED".into(),
            account: String::new(),
            account_password_required: false,
            enabled: true,
            in_place: false,
            mrc: true,
            mrc_preset: "balanced".into(),
            mrc_verify_text: false,
            enhance: true,
            enhance_orientation: false,
            remove_empty_folders: true,
            repair_only: false,
            run_type: "batch-ocr".into(),
            action_file: String::new(),
        }
    }

    #[test]
    fn unit_names_are_stable_and_hold_no_part_of_the_name() {
        let stem = unit_stem("Nightly Scans");
        assert_eq!(stem, unit_stem("Nightly Scans"));
        assert_ne!(stem, unit_stem("nightly scans"));
        assert!(stem.starts_with(UNIT_PREFIX));
        assert_eq!(stem.len(), UNIT_PREFIX.len() + 16);
        assert!(stem[UNIT_PREFIX.len()..].bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn command_line_quoting_round_trips_and_disarms_expansion() {
        let args = ["/a b/c", r#"q"uote"#, r"back\slash", "100% $HOME ${X}", "ünï"];
        let line: Vec<String> = args.iter().map(|a| quote(a).unwrap()).collect();
        let line = line.join(" ");
        assert!(line.contains("100%% $$HOME $${X}"));
        assert_eq!(unquote(&line).unwrap(), args);
        assert_eq!(unquote("bare word"), None);
        assert_eq!(unquote(r#""a\nb""#), None);
        assert_eq!(unquote(r#""50%d""#), None);
        assert_eq!(unquote(r#""a""b""#), None);
        assert!(quote("a\nb").is_err());
    }

    #[test]
    fn the_calendar_spells_daily_and_weekly_runs() {
        let mut p = profile();
        assert_eq!(calendar(&p).unwrap(), "Mon,Wed *-*-* 03:15:00");
        p.frequency = "daily".into();
        assert_eq!(calendar(&p).unwrap(), "*-*-* 03:15:00");
        p.time = String::new();
        assert_eq!(calendar(&p).unwrap(), "*-*-* 09:30:00");
        p.frequency = "weekly".into();
        p.days = "MON,MON".into();
        assert!(calendar(&p).is_err());
        assert_eq!(
            schedule_from_calendar("Mon,Wed *-*-* 03:15:00"),
            Some(("weekly".into(), "03:15".into(), "MON,WED".into()))
        );
        assert_eq!(
            schedule_from_calendar("*-*-* 09:30:00"),
            Some(("daily".into(), "09:30".into(), String::new()))
        );
        assert_eq!(schedule_from_calendar("hourly"), None);
        assert_eq!(schedule_from_calendar("*-*-* 25:00:00"), None);
    }

    #[test]
    fn missed_runs_start_late_and_overlapping_runs_are_ignored() {
        let timer = timer_text(&profile()).unwrap();
        assert!(timer.contains("\nPersistent=true\n"));
        assert!(timer.contains("\nWantedBy=timers.target\n"));
        let service = service_text("/opt/spectrapdf", &profile()).unwrap();
        assert!(service.contains("\nType=oneshot\n"));
        assert!(!service.contains("User="));
    }

    #[test]
    fn the_units_read_back_as_the_profile_that_wrote_them() {
        let program = Path::new("/opt/Spectra PDF/spectrapdf");
        for p in [
            profile(),
            ScheduleProfile { frequency: "daily".into(), days: String::new(), ..profile() },
            ScheduleProfile {
                run_type: "action".into(),
                lang: String::new(),
                moved_root: String::new(),
                repair_damaged: false,
                mrc: false,
                mrc_preset: String::new(),
                enhance: false,
                enhance_orientation: true,
                remove_empty_folders: false,
                action_file: "/home/u/.local/share/com.spectrapdf.app/scheduled-actions/Nightly Scans@7-0011aabb.json".into(),
                log_dir: "/home/u/logs".into(),
                ..profile()
            },
        ] {
            let service = service_text(&program.to_string_lossy(), &p).unwrap();
            let timer = timer_text(&p).unwrap();
            let back = profile_from_units(&p.name, &service, &timer, program).expect("read back");
            assert_eq!(service_text(&program.to_string_lossy(), &back).unwrap(), service);
            assert_eq!(timer_text(&back).unwrap(), timer);
            assert_eq!(back.source, p.source);
            assert_eq!(back.moved_root, p.moved_root);
            assert_eq!(back.days, p.days);
            assert_eq!(back.time, p.time);
            assert_eq!(back.action_file, p.action_file);
        }
    }

    #[test]
    fn units_edited_outside_the_app_offer_no_edit() {
        let program = Path::new("/opt/spectrapdf");
        let p = profile();
        let service = service_text("/opt/spectrapdf", &p).unwrap();
        let timer = timer_text(&p).unwrap();
        assert!(profile_from_units(&p.name, &service, &timer, program).is_some());
        let extra = format!("{service}Environment=X=1\n");
        assert!(profile_from_units(&p.name, &extra, &timer, program).is_none());
        let random = timer.replace("Persistent=true", "Persistent=false");
        assert!(profile_from_units(&p.name, &service, &random, program).is_none());
        let other = service_text("/usr/bin/other", &p).unwrap();
        assert!(profile_from_units(&p.name, &other, &timer, program).is_none());
        assert!(profile_from_units("Other name", &service, &timer, program).is_none());
    }

    #[test]
    fn the_service_names_its_action_file_for_the_reclaim() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Nightly Scans@7-0011aabb.json");
        std::fs::write(&file, b"{}").unwrap();
        let p = ScheduleProfile {
            run_type: "action".into(),
            action_file: file.to_string_lossy().into_owned(),
            ..profile()
        };
        let service = service_text("/opt/spectrapdf", &p).unwrap();
        assert_eq!(named_action(dir.path(), "Nightly Scans", &service), Some(file.clone()));
        assert_eq!(named_action(dir.path(), "Other", &service), None);
        assert!(super::super::mentioned(&[service], "Nightly Scans@7-0011aabb.json"));
    }

    #[test]
    fn show_output_splits_into_units() {
        let out = "Id=a.timer\nUnitFileState=enabled\nNextElapseUSecRealtime=Thu 2026-10-01 03:15:00 UTC\n\n\
                   Id=a.service\nExecMainStartTimestamp=n/a\nExecMainStatus=0\n";
        let blocks = show_blocks(out);
        assert_eq!(blocks["a.timer"]["UnitFileState"], "enabled");
        assert_eq!(shown_time(blocks["a.service"].get("ExecMainStartTimestamp")), "");
        assert_eq!(shown_time(blocks["a.timer"].get("NextElapseUSecRealtime")), "Thu 2026-10-01 03:15:00 UTC");
    }

    #[test]
    fn another_account_is_refused_before_anything_is_written() {
        let p = ScheduleProfile { account: "svc".into(), ..profile() };
        assert_eq!(create(p, None, None).unwrap_err(), RUNS_AS_YOU);
        assert_eq!(create(profile(), Some("pw".into()), None).unwrap_err(), RUNS_AS_YOU);
    }

    #[test]
    fn a_process_that_exists_is_running() {
        assert!(process_running(std::process::id()));
        assert!(!process_running(u32::MAX));
    }

    /// Registers a real timer with this user's systemd manager, reads it back
    /// through `list`, pauses it, runs nothing, and deletes it. `#[ignore]`d
    /// because it changes the user's unit directory; run it with
    /// `cargo test --lib scheduler -- --ignored` in a session with a systemd
    /// user manager.
    #[test]
    #[ignore]
    fn a_timer_registers_lists_pauses_and_deletes() {
        assert!(user_manager_present(), "no systemd user manager in this session");
        let source = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        let p = ScheduleProfile {
            name: "ZZ Probe DELETE ME".into(),
            source: source.path().to_string_lossy().into_owned(),
            dest: dest.path().to_string_lossy().into_owned(),
            moved_root: String::new(),
            frequency: "daily".into(),
            days: String::new(),
            ..profile()
        };
        let created = create(p.clone(), None, None);
        let listed = list();
        let paused = set_enabled(&p.name, false);
        let after_pause = list();
        let deleted = delete(&p.name);
        let units = units_dir().unwrap();
        let stem = unit_stem(&p.name);
        let left = units.join(format!("{stem}.timer")).exists()
            || units.join(format!("{stem}.service")).exists();

        created.expect("create");
        let listed = listed.expect("list");
        let run = listed.iter().find(|r| r.name == p.name).expect("listed");
        assert!(run.enabled);
        assert!(!run.next_run.is_empty(), "an enabled timer has a next elapse");
        let back = run.profile.as_ref().expect("read back as editable");
        assert_eq!(back.source, p.source);
        paused.expect("pause");
        let after_pause = after_pause.expect("list after pause");
        assert!(!after_pause.iter().find(|r| r.name == p.name).unwrap().enabled);
        deleted.expect("delete");
        assert!(!left, "unit files were left behind");
    }
}
