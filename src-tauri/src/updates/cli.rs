//! The update modes of the executable. Each runs headless: it is dispatched
//! from `main` before the argument parser, the console attach and Tauri, and
//! it never creates a window or a webview.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::portable_update::{self, Layout, Recovery, StagedRecord, SwapError, SwapRecord, HELPER_EXE, MAIN_EXE};
use super::proc::{Folder, ProcessImage};
use super::system::{self, LastApply, Outcome};
use super::version::Version;

pub const REGISTER_TASK: &str = "--register-update-task";
pub const UNREGISTER_TASK: &str = "--unregister-update-task";
pub const SYSTEM_UPDATE: &str = "--system-update";
pub const SYSTEM_UPDATE_STAGE2: &str = "--system-update-stage2";
pub const AWAIT_UPDATE: &str = "--await-update";
pub const APPLY_PORTABLE: &str = "--apply-portable-update";
pub const SELF_CHECK: &str = "--update-self-check";

const MODES: [&str; 7] = [
    REGISTER_TASK,
    UNREGISTER_TASK,
    SYSTEM_UPDATE,
    SYSTEM_UPDATE_STAGE2,
    AWAIT_UPDATE,
    APPLY_PORTABLE,
    SELF_CHECK,
];

/// `--name value` pairs and bare `--flag`s; a repeated name is refused.
#[derive(Debug, Default)]
pub struct Flags {
    values: Vec<(String, Option<String>)>,
}

impl Flags {
    pub fn parse(args: &[String]) -> Option<Self> {
        let mut values: Vec<(String, Option<String>)> = Vec::new();
        let mut index = 0;
        while index < args.len() {
            let name = &args[index];
            if !name.starts_with("--") || values.iter().any(|(n, _)| n == name) {
                return None;
            }
            match args.get(index + 1) {
                Some(value) if !value.starts_with("--") => {
                    values.push((name.clone(), Some(value.clone())));
                    index += 2;
                }
                _ => {
                    values.push((name.clone(), None));
                    index += 1;
                }
            }
        }
        Some(Flags { values })
    }

    pub fn value(&self, name: &str) -> Option<&str> {
        self.values.iter().find(|(n, _)| n == name).and_then(|(_, v)| v.as_deref())
    }

    pub fn has(&self, name: &str) -> bool {
        self.values.iter().any(|(n, v)| n == name && v.is_none())
    }
}

/// The exit code of an update mode, or `None` when argv names none.
pub fn dispatch(argv: &[String]) -> Option<i32> {
    let mode = argv.get(1)?;
    if !MODES.contains(&mode.as_str()) {
        return None;
    }
    let rest = &argv[2..];
    Some(run(mode, rest))
}

#[cfg(windows)]
fn run(mode: &str, rest: &[String]) -> i32 {
    match mode {
        REGISTER_TASK if rest.is_empty() => system::register_cli(),
        UNREGISTER_TASK if rest.is_empty() => system::unregister_cli(),
        SYSTEM_UPDATE if rest.is_empty() => system::stage1(),
        SYSTEM_UPDATE_STAGE2 => match Flags::parse(rest).and_then(|f| f.value("--instdir").map(PathBuf::from)) {
            Some(instdir) => system::stage2(&instdir),
            None => system::EXIT_USAGE,
        },
        AWAIT_UPDATE => match system::AwaitArgs::parse(rest) {
            Some(args) => system::await_update(&args),
            None => system::EXIT_USAGE,
        },
        APPLY_PORTABLE => match HelperArgs::parse(rest) {
            Some(args) => apply_portable(&args),
            None => system::EXIT_USAGE,
        },
        SELF_CHECK => match rest {
            [version] => self_check(version),
            _ => system::EXIT_USAGE,
        },
        _ => system::EXIT_USAGE,
    }
}

#[cfg(not(windows))]
fn run(_mode: &str, _rest: &[String]) -> i32 {
    eprintln!(
        "error: {}",
        crate::platform::Unsupported::new(crate::platform::feature::AUTOMATIC_UPDATES)
    );
    system::EXIT_USAGE
}

/// `--update-self-check <version>`: the new executable confirms it is the
/// expected version and sits in a payload tree, then leaves the started
/// marker the helper waits for.
#[cfg_attr(not(windows), allow(dead_code))]
fn self_check(expected: &str) -> i32 {
    if Version::parse(expected) != Some(Version::running()) {
        return system::EXIT_FAILED;
    }
    let Ok(dir) = crate::portable::exe_dir() else {
        return system::EXIT_FAILED;
    };
    if !dir.join("engine").is_dir() || !dir.join("THIRD-PARTY-LICENSES.md").is_file() {
        return system::EXIT_FAILED;
    }
    let layout = Layout::new(&dir);
    match std::fs::write(layout.started_marker(expected), expected) {
        Ok(()) => system::EXIT_OK,
        Err(_) => system::EXIT_FAILED,
    }
}

/// The arguments of `--apply-portable-update`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperArgs {
    pub root: PathBuf,
    pub parent: u32,
    pub version: String,
    pub relaunch: bool,
}

impl HelperArgs {
    pub fn to_args(&self) -> Vec<String> {
        let mut args = vec![
            APPLY_PORTABLE.to_string(),
            "--root".to_string(),
            self.root.display().to_string(),
            "--parent".to_string(),
            self.parent.to_string(),
            "--version".to_string(),
            self.version.clone(),
        ];
        if self.relaunch {
            args.push("--relaunch".to_string());
        }
        args
    }

    pub fn parse(args: &[String]) -> Option<Self> {
        let flags = Flags::parse(args)?;
        Some(HelperArgs {
            root: PathBuf::from(flags.value("--root")?),
            parent: flags.value("--parent")?.parse().ok()?,
            version: Version::parse(flags.value("--version")?)?.to_string(),
            relaunch: flags.has("--relaunch"),
        })
    }
}

/// The payload root a helper copy serves: `<root>\.spectra-update\helper\`.
fn root_of_helper(exe: &Path) -> Option<PathBuf> {
    let helper_dir = exe.parent()?;
    let update_dir = helper_dir.parent()?;
    if !exe.file_name()?.to_string_lossy().eq_ignore_ascii_case(HELPER_EXE)
        || !helper_dir.file_name()?.to_string_lossy().eq_ignore_ascii_case("helper")
        || !update_dir
            .file_name()?
            .to_string_lossy()
            .eq_ignore_ascii_case(portable_update::UPDATE_DIR)
    {
        return None;
    }
    update_dir.parent().map(Path::to_path_buf)
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let key = |p: &Path| {
        dunce::canonicalize(p)
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .to_lowercase()
    };
    key(a) == key(b)
}

fn record(layout: &Layout, outcome: Outcome, version: &str) {
    let _ = portable_update::write_json(
        &layout.last_apply,
        &LastApply {
            run_id: String::new(),
            outcome,
            version: version.to_string(),
        },
    );
}

/// Whether the helper a swap record names still runs, other than this
/// process. When the process list cannot be taken, the helper counts as
/// running.
fn helper_alive(layout: &Layout, record: &SwapRecord) -> bool {
    if record.helper_pid == std::process::id() {
        return false;
    }
    let Some(images) = super::proc::process_images() else {
        return true;
    };
    let helper_dir = Folder::new(&layout.helper);
    images.iter().any(|p| {
        p.pid == record.helper_pid
            && is_helper(p, &helper_dir, record.helper_started, || super::proc::creation_time(p.pid))
    })
}

/// Whether `process` is the helper of the folder `helper_dir` that started at
/// `started` (0: unknown). A known start time that differs means a reused
/// pid. An image path decides by folder; an unreadable one by the helper's
/// file name, so a protected process that reuses the pid never counts.
pub fn is_helper(
    process: &ProcessImage,
    helper_dir: &Folder,
    started: u64,
    created: impl FnOnce() -> Option<u64>,
) -> bool {
    if started != 0 && created().is_some_and(|created| created != started) {
        return false;
    }
    match process.path.as_deref() {
        Some(path) => helper_dir.contains(path),
        None => process.name.eq_ignore_ascii_case(HELPER_EXE),
    }
}

/// Settles what a recovery found. Returns whether the root is free of an
/// unfinished swap.
fn settle_recovery(layout: &Layout, recovery: Recovery) -> bool {
    settle_recovery_why(layout, recovery).is_ok()
}

/// [`settle_recovery`] with the reason an unfinished swap stays.
fn settle_recovery_why(layout: &Layout, recovery: Recovery) -> Result<(), String> {
    match recovery {
        Recovery::None => Ok(()),
        Recovery::Busy => Err(
            "An update of this copy of Spectra PDF is still being installed. Start Spectra PDF again when it has finished."
                .to_string(),
        ),
        Recovery::Finished(version) => {
            let _ = std::fs::remove_dir_all(&layout.staged);
            let _ = std::fs::remove_file(&layout.staged_record);
            let _ = std::fs::write(layout.started_marker(&version), &version);
            record(layout, Outcome::Installed, &version);
            Ok(())
        }
        Recovery::RolledBack(version) => {
            record(layout, Outcome::Failed, &version);
            Ok(())
        }
        Recovery::Incomplete(why) => {
            let version = portable_update::read_json::<SwapRecord>(&layout.swap_record)
                .map(|r| r.version)
                .unwrap_or_default();
            record(layout, Outcome::Failed, &version);
            Err(format!(
                "An unfinished update of this copy of Spectra PDF could not be undone: {why}. Close every program that uses files in {} and start Spectra PDF again.",
                layout.root.display()
            ))
        }
    }
}

/// What `main` does after the start-up recovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartDecision {
    /// The app starts.
    Start,
    /// The app does not start; the text names the reason.
    Refuse(String),
    /// A rollback put the earlier executable back while this one ran; the
    /// earlier one is started in its place and this process exits.
    HandOver,
    /// As `HandOver` for a command-line run: the earlier executable ran the
    /// same command on this process's console and standard handles, and this
    /// process exits with its exit code.
    Exit(i32),
}

/// Runs in `main` before anything else of a portable copy starts: a swap that
/// a crash or a power loss cut off is finished or rolled back while no part of
/// the payload is in use yet. Returns what `main` does next. While a swap
/// record stands and its helper still runs, another process runs from the
/// root, or the rollback could not finish, the app does not start: its payload
/// is mixed, and its own update code would remove what the record needs.
/// `argv` is passed on when the earlier executable is started in this one's
/// place; `command_line` and `attach_console` decide how (see [`hand_over`]).
pub fn recover_portable_swap_at_start(argv: &[String], command_line: bool, attach_console: impl FnOnce()) -> StartDecision {
    if !cfg!(windows) || !matches!(crate::portable::container(), Ok(crate::portable::Container::Portable)) {
        return StartDecision::Start;
    }
    let Ok(root) = crate::portable::exe_dir() else {
        return StartDecision::Start;
    };
    let layout = Layout::new(&root);
    let running = Version::running().to_string();
    let decision = start_after_recovery(
        &layout,
        &running,
        || super::proc::processes_using(&root, std::slice::from_ref(&layout.dir), None).map(|users| !users.is_empty()),
        |layout| portable_update::recover(layout, Some(&running), |record| helper_alive(layout, record)),
    );
    if decision != StartDecision::HandOver {
        return decision;
    }
    hand_over(&root.join(MAIN_EXE), argv.get(1..).unwrap_or_default(), &root, command_line, attach_console)
}

/// Starts the restored executable in this one's place. A window launch starts
/// it detached in `root`, and nothing waits on it. A command-line run has a
/// caller that reads its output and exit status, so the restored executable
/// runs the same command attached: `attach_console` gives this process the
/// caller's console first, the child inherits the standard handles and the
/// working folder (relative paths in the command stay valid), and its exit
/// code becomes this process's.
pub fn hand_over(exe: &Path, args: &[String], root: &Path, command_line: bool, attach_console: impl FnOnce()) -> StartDecision {
    let refused = |e: std::io::Error| {
        StartDecision::Refuse(format!(
            "An unfinished update was undone, but the restored Spectra PDF could not be started: {e}. Start Spectra PDF again."
        ))
    };
    if !command_line {
        return match super::proc::spawn_detached(exe, args, root) {
            Ok(_) => StartDecision::HandOver,
            Err(e) => refused(e),
        };
    }
    attach_console();
    match std::process::Command::new(exe).args(args).status() {
        Ok(status) => StartDecision::Exit(status.code().unwrap_or(1)),
        Err(e) => refused(e),
    }
}

/// The start-up rule of [`recover_portable_swap_at_start`]. `running` is the
/// version of this executable; `others_running` is `None` when the process
/// list cannot be taken. Retired executables are removed only when the
/// decision is `Start` or `HandOver`: while a swap record stands, a helper's
/// rollback may be about to rename a retired executable back into the root.
pub fn start_after_recovery(
    layout: &Layout,
    running: &str,
    others_running: impl FnOnce() -> Option<bool>,
    recover: impl FnOnce(&Layout) -> Recovery,
) -> StartDecision {
    let decision = start_rule(layout, running, others_running, recover);
    if matches!(decision, StartDecision::Start | StartDecision::HandOver) {
        layout.clear_retired();
    }
    decision
}

fn start_rule(
    layout: &Layout,
    running: &str,
    others_running: impl FnOnce() -> Option<bool>,
    recover: impl FnOnce(&Layout) -> Recovery,
) -> StartDecision {
    if !layout.swap_record.exists() {
        return StartDecision::Start;
    }
    match others_running() {
        Some(false) => {}
        Some(true) => {
            return StartDecision::Refuse(format!(
                "An update of this copy of Spectra PDF is unfinished, and another program still runs from {}. Close it and start Spectra PDF again.",
                layout.root.display()
            ))
        }
        None => {
            return StartDecision::Refuse(
                "An update of this copy of Spectra PDF is unfinished, and the list of running programs cannot be read. Start Spectra PDF again."
                    .to_string(),
            )
        }
    }
    let recovery = recover(layout);
    let rolled_back_from_this = matches!(&recovery, Recovery::RolledBack(version) if version == running);
    match settle_recovery_why(layout, recovery) {
        Err(why) => StartDecision::Refuse(why),
        Ok(()) if rolled_back_from_this => StartDecision::HandOver,
        Ok(()) => StartDecision::Start,
    }
}

/// Runs the new executable's self-check with a bounded wait.
fn run_self_check(layout: &Layout, version: &str) -> Result<(), String> {
    let marker = layout.started_marker(version);
    let _ = std::fs::remove_file(&marker);
    let mut child = std::process::Command::new(layout.root.join(MAIN_EXE))
        .arg(SELF_CHECK)
        .arg(version)
        .current_dir(&layout.dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("it could not be started: {e}"))?;
    let status = bounded_wait(&mut child, Duration::from_secs(120))?;
    if status.success() && marker.is_file() {
        Ok(())
    } else {
        Err(format!("its check ended with {status}"))
    }
}

/// Waits for `child` at most `timeout`. On a timeout the child is ended and
/// waited for, so its image is no longer mapped when this returns: a rollback
/// that follows can rename over it.
fn bounded_wait(child: &mut std::process::Child, timeout: Duration) -> Result<std::process::ExitStatus, String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(Duration::from_millis(250)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("its check did not finish".to_string());
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    }
}

/// After a swap whose rollback could not finish, runs the recovery again a
/// bounded number of times. The record names this helper, so the recovery
/// does not wait for it. Returns whether the record is settled.
fn settle_after_incomplete(
    layout: &Layout,
    attempts: u32,
    pause: Duration,
    mut recover: impl FnMut(&Layout) -> Recovery,
) -> bool {
    for attempt in 0..attempts {
        if attempt > 0 {
            std::thread::sleep(pause);
        }
        if settle_recovery(layout, recover(layout)) {
            return true;
        }
    }
    !layout.swap_record.exists()
}

/// Starts the root's executable when asked and no swap record stands. A start
/// over a standing record would meet this helper still running, take the
/// record as busy and refuse.
fn relaunch_when_settled(layout: &Layout, asked: bool, start: impl FnOnce()) -> bool {
    if asked && !layout.swap_record.exists() {
        start();
        return true;
    }
    false
}

/// `--apply-portable-update`: runs from the helper copy after the app has
/// exited. The outcome is recorded for the next start; the old or the new
/// executable is relaunched when asked.
pub fn apply_portable(args: &HelperArgs) -> i32 {
    let Some(root) = std::env::current_exe().ok().as_deref().and_then(root_of_helper) else {
        return system::EXIT_USAGE;
    };
    if !same_dir(&root, &args.root) {
        return system::EXIT_USAGE;
    }
    let layout = Layout::new(&root);
    let relaunch = || {
        relaunch_when_settled(&layout, args.relaunch, || {
            let _ = super::proc::spawn_detached(&root.join(MAIN_EXE), &[], &root);
        });
    };
    super::proc::wait_for_exit(args.parent, Duration::from_secs(600));
    let recovery = portable_update::recover(&layout, None, |record| helper_alive(&layout, record));
    let finished = matches!(recovery, Recovery::Finished(_));
    if !settle_recovery(&layout, recovery) {
        relaunch();
        return system::EXIT_FAILED;
    }
    if finished {
        relaunch();
        return system::EXIT_OK;
    }
    if crate::commands::machine_policy_set("DisableAutoUpdate") {
        relaunch();
        return system::EXIT_OK;
    }
    let staged: Option<StagedRecord> = portable_update::read_json(&layout.staged_record);
    if staged.as_ref().map(|s| s.version.as_str()) != Some(args.version.as_str()) {
        record(&layout, Outcome::Failed, &args.version);
        relaunch();
        return system::EXIT_FAILED;
    }
    let except = vec![layout.dir.clone()];
    if !super::proc::wait_until_unused(&root, &except, None, Duration::from_secs(120)) {
        record(&layout, Outcome::Deferred, &args.version);
        relaunch();
        return system::EXIT_OK;
    }
    if let Err(e) = portable_update::renew_backup(&layout) {
        eprintln!("{e}");
        record(&layout, Outcome::Failed, &args.version);
        relaunch();
        return system::EXIT_FAILED;
    }
    let started = super::proc::creation_time(std::process::id()).unwrap_or(0);
    let outcome = portable_update::swap(&layout, &args.version, std::process::id(), started, || {
        run_self_check(&layout, &args.version)
    });
    let code = match outcome {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(&layout.staged);
            let _ = std::fs::remove_file(&layout.staged_record);
            record(&layout, Outcome::Installed, &args.version);
            system::EXIT_OK
        }
        Err(SwapError::RolledBack(_)) => {
            record(&layout, Outcome::Failed, &args.version);
            system::EXIT_FAILED
        }
        Err(SwapError::Incomplete(e)) => {
            eprintln!("{e}");
            if !settle_after_incomplete(&layout, 20, Duration::from_millis(500), |layout| {
                portable_update::recover(layout, None, |record| helper_alive(layout, record))
            }) {
                record(&layout, Outcome::Failed, &args.version);
            }
            system::EXIT_FAILED
        }
    };
    relaunch();
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }

    #[test]
    fn only_an_exact_mode_in_first_position_dispatches() {
        assert_eq!(dispatch(&s(&["spectrapdf.exe"])), None);
        assert_eq!(dispatch(&s(&["spectrapdf.exe", "C:\\a.pdf"])), None);
        assert_eq!(dispatch(&s(&["spectrapdf.exe", "compress", "--system-update"])), None);
        assert_eq!(dispatch(&s(&["spectrapdf.exe", "--system-update-x"])), None);
        assert_eq!(dispatch(&s(&["spectrapdf.exe", "--await-update"])), Some(system::EXIT_USAGE));
    }

    #[test]
    fn flags_refuse_repeats_and_stray_values() {
        assert!(Flags::parse(&s(&["--a", "1", "--a", "2"])).is_none());
        assert!(Flags::parse(&s(&["stray"])).is_none());
        let flags = Flags::parse(&s(&["--root", "C:\\x", "--relaunch"])).unwrap();
        assert_eq!(flags.value("--root"), Some("C:\\x"));
        assert!(flags.has("--relaunch"));
        assert!(!flags.has("--root"));
    }

    #[test]
    fn helper_arguments_round_trip() {
        let args = HelperArgs {
            root: PathBuf::from(r"D:\Apps\Spectra PDF"),
            parent: 77,
            version: "2026.1101.160".to_string(),
            relaunch: false,
        };
        let argv = args.to_args();
        assert_eq!(HelperArgs::parse(&argv[1..]), Some(args));
        assert_eq!(HelperArgs::parse(&s(&["--root", "x", "--parent", "1", "--version", "1.02.3"])), None);
    }

    #[test]
    fn a_standing_swap_record_keeps_the_app_from_starting_until_it_is_settled() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::new(temp.path());
        let never = |_: &Layout| -> Recovery { panic!("no recovery may run") };
        let old = "2026.1014.156";
        let refused = |d: StartDecision| matches!(d, StartDecision::Refuse(ref why) if !why.is_empty());
        assert_eq!(start_after_recovery(&layout, old, || panic!("no record, no scan"), never), StartDecision::Start);
        std::fs::create_dir_all(&layout.dir).unwrap();
        std::fs::write(&layout.swap_record, "{}").unwrap();
        assert!(refused(start_after_recovery(&layout, old, || Some(true), never)), "another process runs from the root");
        assert!(refused(start_after_recovery(&layout, old, || None, never)), "the process list could not be taken");
        assert!(refused(start_after_recovery(&layout, old, || Some(false), |_| Recovery::Busy)), "the helper still runs");
        let incomplete = start_after_recovery(&layout, old, || Some(false), |_| Recovery::Incomplete("engine is held".into()));
        assert!(matches!(incomplete, StartDecision::Refuse(ref why) if why.contains("engine is held")), "{incomplete:?}");
        assert_eq!(
            start_after_recovery(&layout, old, || Some(false), |_| Recovery::RolledBack("2026.1101.160".into())),
            StartDecision::Start
        );
    }

    #[test]
    fn a_new_executable_whose_swap_was_undone_hands_over_to_the_restored_one() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::new(temp.path());
        std::fs::create_dir_all(&layout.dir).unwrap();
        std::fs::write(&layout.swap_record, "{}").unwrap();
        let new = "2026.1101.160";
        assert_eq!(
            start_after_recovery(&layout, new, || Some(false), |_| Recovery::RolledBack(new.into())),
            StartDecision::HandOver
        );
        let last: LastApply = portable_update::read_json(&layout.last_apply).unwrap();
        assert_eq!((last.outcome, last.version.as_str()), (Outcome::Failed, new));
    }

    #[test]
    fn retired_executables_stay_while_a_swap_record_keeps_the_app_from_starting() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::new(temp.path());
        let retire = || {
            std::fs::create_dir_all(&layout.retired).unwrap();
            let aside = layout.retired.join(format!("1-{MAIN_EXE}"));
            std::fs::write(&aside, b"image").unwrap();
            aside
        };
        let old = "2026.1014.156";
        let new = "2026.1101.160";
        let aside = retire();
        assert_eq!(start_after_recovery(&layout, old, || panic!("no record, no scan"), |_| panic!("no recovery")), StartDecision::Start);
        assert!(!aside.exists(), "no record: retired executables are removed");

        std::fs::create_dir_all(&layout.dir).unwrap();
        std::fs::write(&layout.swap_record, "{}").unwrap();
        let aside = retire();
        let never = |_: &Layout| -> Recovery { panic!("no recovery may run") };
        assert!(matches!(start_after_recovery(&layout, old, || Some(true), never), StartDecision::Refuse(_)));
        assert!(matches!(start_after_recovery(&layout, old, || None, never), StartDecision::Refuse(_)));
        assert!(matches!(start_after_recovery(&layout, old, || Some(false), |_| Recovery::Busy), StartDecision::Refuse(_)));
        assert!(matches!(
            start_after_recovery(&layout, old, || Some(false), |_| Recovery::Incomplete("engine is held".into())),
            StartDecision::Refuse(_)
        ));
        assert!(aside.exists(), "a helper's rollback may still rename the retired executable back");

        assert_eq!(
            start_after_recovery(&layout, new, || Some(false), |_| Recovery::RolledBack(new.into())),
            StartDecision::HandOver
        );
        assert!(!aside.exists(), "a settled record: retired executables are removed");

        let source = include_str!("cli.rs");
        let code = &source[..source.find("#[cfg(test)]").unwrap()];
        assert_eq!(code.matches("clear_retired()").count(), 1, "only the start rule removes retired executables");
    }

    #[cfg(windows)]
    fn exits_with(code: i32) -> (PathBuf, Vec<String>) {
        let shell = std::env::var_os("ComSpec").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe"));
        (shell, s(&["/d", "/c", &format!("exit {code}")]))
    }

    #[cfg(not(windows))]
    fn exits_with(code: i32) -> (PathBuf, Vec<String>) {
        (PathBuf::from("/bin/sh"), s(&["-c", &format!("exit {code}")]))
    }

    #[test]
    fn a_command_line_hand_over_runs_the_restored_executable_attached_and_returns_its_exit_code() {
        let temp = tempfile::tempdir().unwrap();
        let (exe, args) = exits_with(7);
        let mut attached = false;
        assert_eq!(hand_over(&exe, &args, temp.path(), true, || attached = true), StartDecision::Exit(7));
        assert!(attached, "the caller's console is attached before the child starts");
        let missing = temp.path().join(MAIN_EXE);
        let refused = hand_over(&missing, &args, temp.path(), true, || {});
        assert!(matches!(refused, StartDecision::Refuse(ref why) if why.contains("Start Spectra PDF again")), "{refused:?}");
    }

    #[test]
    fn a_window_hand_over_starts_the_restored_executable_detached_without_a_console() {
        let temp = tempfile::tempdir().unwrap();
        let (exe, args) = exits_with(0);
        let attach = || panic!("a window launch has no console to attach");
        assert_eq!(hand_over(&exe, &args, temp.path(), false, attach), StartDecision::HandOver);
        let refused = hand_over(&temp.path().join(MAIN_EXE), &args, temp.path(), false, attach);
        assert!(matches!(refused, StartDecision::Refuse(_)), "{refused:?}");
    }

    #[test]
    fn main_does_not_start_the_app_over_an_unsettled_swap_and_says_why() {
        let main = include_str!("../main.rs");
        let at = main
            .find("match spectrapdf_lib::updates::cli::recover_portable_swap_at_start(")
            .expect("main asks the start-up recovery");
        let decision = &main[at..];
        assert!(decision.contains("StartDecision::Start => {}"));
        assert!(decision.contains("StartDecision::HandOver => std::process::exit(0)"));
        assert!(decision.contains("StartDecision::Exit(code) => std::process::exit(code)"));
        assert!(decision.contains("report_refused_start(&argv, &why);"));
        assert!(at < main.find("spectrapdf_lib::run();").unwrap());
    }

    #[cfg(windows)]
    fn image(name: &str, path: Option<&str>) -> ProcessImage {
        ProcessImage {
            pid: 4,
            name: name.to_string(),
            path: path.map(PathBuf::from),
        }
    }

    #[cfg(windows)]
    #[test]
    fn only_the_helper_itself_keeps_a_swap_busy() {
        let helper = Folder::new(Path::new(r"D:\Apps\Spectra PDF\.spectra-update\helper"));
        let inside = Some(r"D:\Apps\Spectra PDF\.spectra-update\helper\spectrapdf-update-helper.exe");
        let none = || panic!("no start time is read when none was recorded");
        assert!(is_helper(&image(HELPER_EXE, inside), &helper, 0, none));
        assert!(!is_helper(&image("System", None), &helper, 0, none), "a protected process reusing the pid");
        assert!(!is_helper(&image("Registry", None), &helper, 0, none));
        assert!(is_helper(&image(HELPER_EXE, None), &helper, 0, none), "an unreadable helper image");
        assert!(!is_helper(&image("spectrapdf.exe", Some(r"D:\Apps\Spectra PDF\spectrapdf.exe")), &helper, 0, none));
        assert!(!is_helper(&image(HELPER_EXE, inside), &helper, 100, || Some(200)), "a reused pid starts later");
        assert!(is_helper(&image(HELPER_EXE, inside), &helper, 100, || Some(100)));
        assert!(is_helper(&image(HELPER_EXE, None), &helper, 100, || None), "an unreadable start time");
        assert!(!is_helper(&image("svchost.exe", None), &helper, 100, || None));
    }

    #[cfg(windows)]
    #[test]
    fn this_process_has_a_readable_start_time_that_a_helper_record_can_hold() {
        let own = super::super::proc::creation_time(std::process::id()).expect("own start time");
        assert!(own > 0);
        assert_eq!(super::super::proc::creation_time(std::process::id()), Some(own));
    }

    #[cfg(windows)]
    #[test]
    fn a_timed_out_check_is_ended_and_waited_for_so_its_image_can_be_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let exe = temp.path().join(MAIN_EXE);
        std::fs::copy(system.join("System32").join("PING.EXE"), &exe).unwrap();
        let mut child = std::process::Command::new(&exe)
            .args(["-n", "60", "127.0.0.1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let error = bounded_wait(&mut child, Duration::from_millis(300)).unwrap_err();
        assert!(error.contains("did not finish"), "{error}");
        let backup = temp.path().join("backup.exe");
        std::fs::write(&backup, "old exe").unwrap();
        std::fs::rename(&backup, &exe).expect("the ended check no longer maps the image");
        assert_eq!(std::fs::read_to_string(&exe).unwrap(), "old exe");
    }

    #[test]
    fn the_helper_relaunches_only_once_its_swap_record_is_settled() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::new(temp.path());
        std::fs::create_dir_all(&layout.dir).unwrap();
        std::fs::write(&layout.swap_record, "{}").unwrap();
        assert!(!relaunch_when_settled(&layout, true, || panic!("no start over a standing record")));
        let mut attempts = 0;
        let settled = settle_after_incomplete(&layout, 5, Duration::ZERO, |layout| {
            attempts += 1;
            if attempts < 3 {
                Recovery::Incomplete("spectrapdf.exe is held".into())
            } else {
                std::fs::remove_file(&layout.swap_record).unwrap();
                Recovery::RolledBack("2026.1101.160".into())
            }
        });
        assert!(settled);
        assert_eq!(attempts, 3);
        let mut started = false;
        assert!(relaunch_when_settled(&layout, true, || started = true));
        assert!(started);
        assert!(!relaunch_when_settled(&layout, false, || panic!("not asked")));

        std::fs::write(&layout.swap_record, "{}").unwrap();
        assert!(!settle_after_incomplete(&layout, 2, Duration::ZERO, |_| Recovery::Incomplete("held".into())));
        assert!(!relaunch_when_settled(&layout, true, || panic!("no start over a standing record")));
    }

    #[cfg(windows)]
    #[test]
    fn the_helper_serves_only_the_root_it_sits_under() {
        let exe = Path::new(r"D:\Apps\Spectra PDF\.spectra-update\helper\spectrapdf-update-helper.exe");
        assert_eq!(root_of_helper(exe), Some(PathBuf::from(r"D:\Apps\Spectra PDF")));
        assert_eq!(root_of_helper(Path::new(r"D:\Apps\Spectra PDF\spectrapdf.exe")), None);
        assert_eq!(
            root_of_helper(Path::new(r"D:\Apps\Spectra PDF\.spectra-update\staged\spectrapdf.exe")),
            None
        );
    }
}
