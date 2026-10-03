//! Is a usable Ghostscript configured? — the Rust half of the one answer.
//!
//! Ghostscript is a user-supplied prerequisite: the distribution provides
//! none. This module is the Rust mirror of `engine/gs_capability.py`, and it
//! exists for the two places the engine cannot answer for itself — the GUI's
//! settings surface, which has to report a path and a version before any
//! document is open, and the CLI, which has to refuse by name before it
//! starts an engine at all.
//!
//! Validation is a PROBE, never file existence: `--version` proves a file
//! answers, and a one-page render proves the interpreter initialises, finds
//! its resource tree, and can write through `-dSAFER`. A copied executable
//! without its `Resource/` tree passes the first and fails the second, which
//! is exactly the install the old existence check called usable.
//!
//! Discovery is ordered explicit → environment → bundled (the installer's
//! tree, then an AppImage's own copy) → registry → PATH. The registry scan is
//! kept because it finds per-machine installs that were never put on PATH;
//! the bundled candidates are optional — the resolution must not assume a
//! vendored copy exists.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The minimum Ghostscript this build drives, mirroring
/// `engine/gs_capability.MINIMUM_VERSION`. A minimum, never a pin.
pub const MINIMUM_VERSION: (u32, u32) = (10, 0);

pub const NOT_CONFIGURED: &str = "not-configured";
pub const NOT_EXECUTABLE: &str = "not-executable";
pub const PROBE_FAILED: &str = "probe-failed";
pub const VERSION_BELOW_MINIMUM: &str = "version-below-minimum";

/// Environment override, shared with the engine authority.
pub const PATH_ENV_VAR: &str = "SPECTRAPDF_GS_PATH";

const CANDIDATE_NAMES: [&str; 3] = ["gswin64c", "gswin32c", "gs"];

/// The ONE named error every gs-needing CLI subcommand reports.
///
/// One string rather than 29: a per-subcommand spelling is how one of them
/// ends up reporting a raw spawn failure instead. `31-print.spec.ts` asserts
/// a driver-open failure's stderr does NOT mention Ghostscript, so this text
/// may only ever be produced by the capability path.
///
/// It names the command line's own fix, `--gs-path` and `PATH_ENV_VAR`, and
/// never the window's Preferences: the CLI is the only surface that shows it.
pub const CLI_REQUIRED: &str = "this command requires Ghostscript; none is configured -- \
install it from ghostscript.com, then name it with --gs-path or the SPECTRAPDF_GS_PATH \
environment variable";

/// One validated answer about one Ghostscript path.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GsAnswer {
    pub available: bool,
    pub path: String,
    pub version: String,
    /// One of the named reasons above; empty when `available`.
    pub reason: String,
    /// Probe output for the settings surface; never matched on.
    pub detail: String,
}

impl GsAnswer {
    fn unavailable(path: &str, reason: &str, detail: &str) -> Self {
        GsAnswer {
            available: false,
            path: path.to_string(),
            version: String::new(),
            reason: reason.to_string(),
            detail: detail.to_string(),
        }
    }
}

// ── Probing ───────────────────────────────────────────────────────────────

/// Cached per path + mtime + size: a replaced binary at the same path
/// re-probes, an unchanged one costs nothing after the first ask.
type CacheKey = (String, u128, u64);
const MAX_CACHE_ENTRIES: usize = 32;
static CACHE: Mutex<Option<Vec<(CacheKey, GsAnswer)>>> = Mutex::new(None);

pub fn clear_cache() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
}

fn cache_key(path: &Path) -> Option<CacheKey> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some((path.to_string_lossy().to_string(), mtime, meta.len()))
}

fn cached(key: &CacheKey) -> Option<GsAnswer> {
    let guard = CACHE.lock().ok()?;
    let entries = guard.as_ref()?;
    entries
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, answer)| answer.clone())
}

fn remember_in(entries: &mut Vec<(CacheKey, GsAnswer)>, key: CacheKey, answer: &GsAnswer) {
    entries.retain(|(cached_key, _)| cached_key != &key);
    if entries.len() >= MAX_CACHE_ENTRIES {
        entries.remove(0);
    }
    entries.push((key, answer.clone()));
}

fn remember(key: CacheKey, answer: &GsAnswer) {
    if let Ok(mut guard) = CACHE.lock() {
        remember_in(guard.get_or_insert_with(Vec::new), key, answer);
    }
}

fn cacheable_probe_result(answer: &GsAnswer, budget: Duration) -> bool {
    budget >= RESOLUTION_BUDGET || answer.reason != PROBE_FAILED
}

fn command(exe: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd
}

/// Budgets for the two probe runs, the same as `engine/gs_capability.py`'s.
/// A picked program that never exits (the windowed `gswin64.exe` waits for
/// its window to close) would otherwise hold the probe, and the settings
/// surface waiting on it, for as long as it runs.
const VERSION_BUDGET: Duration = Duration::from_secs(30);
const SMOKE_BUDGET: Duration = Duration::from_secs(60);
const RESOLUTION_BUDGET: Duration = Duration::from_secs(90);
const MAX_PATH_DIRECTORIES: usize = 1024;
const MAX_PATH_CANDIDATES: usize = 64;
#[cfg(windows)]
const MAX_REGISTRY_KEYS: usize = 1024;
#[cfg(windows)]
const MAX_REGISTRY_CANDIDATES: usize = 32;
const MAX_DISCOVERY_CANDIDATES: usize = 128;
const MAX_CAPTURED_OUTPUT: usize = 1024 * 1024;
const PIPE_DRAIN_GRACE: Duration = Duration::from_millis(500);

#[cfg(unix)]
fn terminate_process_group(pid: u32) {
    use std::os::raw::c_int;
    extern "C" {
        fn kill(pid: c_int, signal: c_int) -> c_int;
    }
    if let Ok(pid) = i32::try_from(pid) {
        // `output_within` creates a new process group before spawn; descendants
        // inherit it. Closing the group prevents a child that inherited our
        // pipes from outliving the bounded read threads.
        unsafe {
            let _ = kill(-pid, 9); // SIGKILL
        }
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_pid: u32) {}

fn stop_process(child: &mut std::process::Child, pid: u32) {
    terminate_process_group(pid);
    let _ = child.kill();
    let _ = child.wait();
}

/// Run `cmd` to completion or until `budget` passes, when it is killed and
/// the run fails with `TimedOut`. Output is drained on threads so a child
/// that fills a pipe cannot stall the wait.
pub(crate) fn output_within(
    cmd: std::process::Command,
    budget: Duration,
) -> std::io::Result<std::process::Output> {
    output_within_using(cmd, budget, true, drain_bounded)
}

fn drain_bounded(
    pipe: Option<Box<dyn std::io::Read + Send>>,
) -> std::io::Result<std::sync::mpsc::Receiver<Vec<u8>>> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new().spawn(move || {
        let mut bytes = Vec::with_capacity(8192);
        let mut buffer = [0u8; 8192];
        if let Some(mut pipe) = pipe {
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let remaining = MAX_CAPTURED_OUTPUT.saturating_sub(bytes.len());
                        let keep = count.min(remaining);
                        bytes.extend_from_slice(&buffer[..keep]);
                        // Continue draining after the cap so a verbose
                        // process cannot block on a full pipe.
                    }
                }
            }
        }
        let _ = send.send(bytes);
    })?;
    Ok(receive)
}

fn output_within_using(
    cmd: std::process::Command,
    budget: Duration,
    contain_process_tree: bool,
    mut drain: impl FnMut(
        Option<Box<dyn std::io::Read + Send>>,
    ) -> std::io::Result<std::sync::mpsc::Receiver<Vec<u8>>>,
) -> std::io::Result<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;
    let mut cmd = cmd;
    #[cfg(unix)]
    if contain_process_tree {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    let (mut child, job) = if contain_process_tree {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let (child, job) = crate::process_job::ProcessJob::spawn(cmd, CREATE_NO_WINDOW)?;
        (child, Some(job))
    } else {
        (cmd.spawn()?, None)
    };
    #[cfg(not(windows))]
    let mut child = cmd.spawn()?;
    #[cfg(not(windows))]
    let job: Option<()> = None;
    let pid = child.id();

    let stdout = match drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    ) {
        Ok(reader) => reader,
        Err(error) => {
            stop_process(&mut child, pid);
            drop(job);
            return Err(error);
        }
    };
    let stderr = match drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    ) {
        Ok(reader) => reader,
        Err(error) => {
            stop_process(&mut child, pid);
            drop(job);
            return Err(error);
        }
    };
    let deadline = Instant::now() + budget;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                stop_process(&mut child, pid);
                drop(job);
                return Err(error);
            }
        }
        if Instant::now() >= deadline {
            stop_process(&mut child, pid);
            drop(job);
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!(
                    "the program did not finish within {} seconds",
                    budget.as_secs()
                ),
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    // A probe owns the process tree it started. On Windows closing the job
    // terminates descendants that inherited the captured pipe handles. On
    // Unix the process group is terminated directly. The bounded receive is a
    // final guard against a stray handle on another target extending timeout.
    terminate_process_group(pid);
    drop(job);
    let drain_deadline = Instant::now() + PIPE_DRAIN_GRACE;
    let collect = |reader: std::sync::mpsc::Receiver<Vec<u8>>| {
        reader
            .recv_timeout(drain_deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_default()
    };
    Ok(std::process::Output {
        status,
        stdout: collect(stdout),
        stderr: collect(stderr),
    })
}

/// The leading dotted integers of a `--version` line.
///
/// Ghostscript prints `10.07.1`; the zero-padded minor is a spelling, not a
/// value, so `10.07` reads as (10, 7) and sorts above 9.50's (9, 50).
pub fn parse_version(text: &str) -> Option<(u32, u32)> {
    let start = text.find(|c: char| c.is_ascii_digit())?;
    let rest: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = rest.split('.').filter(|p| !p.is_empty());
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    Some((major, minor))
}

/// The directory one probe renders into, created for that probe alone.
///
/// Two probes that share a directory delete each other's raster before it is
/// checked, and the cache then keeps a working program's answer as
/// `probe-failed`. A name taken from the clock is not enough: threads that
/// start together read the same tick.
fn probe_dir() -> std::io::Result<tempfile::TempDir> {
    tempfile::Builder::new()
        .prefix("spectra-gs-probe-")
        .tempdir()
}

/// Render one tiny page. `Ok(())` only when a raster actually came out.
fn smoke(exe: &str, budget: Duration) -> Result<(), String> {
    let dir = probe_dir().map_err(|e| format!("cannot create a probe directory: {}", e))?;
    let png = dir.path().join("probe.png");
    let mut render = command(exe);
    render
        .args([
            "-q",
            "-dNOPAUSE",
            "-dBATCH",
            "-dSAFER",
            "-sDEVICE=png16m",
            "-g16x16",
            "-r72",
        ])
        .arg(format!("-sOutputFile={}", png.display()))
        .args([
            "-c",
            "0 0 moveto 16 16 lineto 0.5 setlinewidth stroke showpage",
        ]);
    let outcome = output_within(render, budget);
    let verdict = match outcome {
        Err(e) => Err(format!("{}", e)),
        Ok(out) if !out.status.success() => {
            let text = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if text.is_empty() {
                "the probe render failed".to_string()
            } else {
                text
            })
        }
        Ok(_) => match std::fs::metadata(&png) {
            Ok(meta) if meta.len() > 0 => Ok(()),
            _ => Err("the probe render produced no output".to_string()),
        },
    };
    let _ = dir.close();
    verdict
}

/// Validate ONE candidate path.
pub fn probe(path: &str) -> GsAnswer {
    probe_with_budget(path, RESOLUTION_BUDGET)
}

fn probe_with_budget(path: &str, budget: Duration) -> GsAnswer {
    let started = Instant::now();
    if path.trim().is_empty() {
        return GsAnswer::unavailable("", NOT_CONFIGURED, "");
    }
    let key = match cache_key(Path::new(path)) {
        Some(key) => key,
        None => return GsAnswer::unavailable(path, NOT_EXECUTABLE, ""),
    };
    if let Some(hit) = cached(&key) {
        return hit;
    }

    let mut version = command(path);
    version.arg("--version");
    let answer = match output_within(version, budget.min(VERSION_BUDGET)) {
        Err(e) => GsAnswer::unavailable(path, PROBE_FAILED, &format!("{}", e)),
        Ok(out) => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let version = version.lines().next().unwrap_or("").trim().to_string();
            if !out.status.success() || version.is_empty() {
                let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
                GsAnswer::unavailable(
                    path,
                    PROBE_FAILED,
                    if detail.is_empty() {
                        "no version was reported"
                    } else {
                        &detail
                    },
                )
            } else if !parse_version(&version).is_some_and(|v| v >= MINIMUM_VERSION) {
                GsAnswer {
                    available: false,
                    path: path.to_string(),
                    version,
                    reason: VERSION_BELOW_MINIMUM.to_string(),
                    detail: String::new(),
                }
            } else {
                let smoke_budget = budget
                    .saturating_sub(started.elapsed())
                    .min(SMOKE_BUDGET);
                if smoke_budget.is_zero() {
                    GsAnswer::unavailable(
                        path,
                        PROBE_FAILED,
                        "the capability check exceeded its total time budget",
                    )
                } else {
                    match smoke(path, smoke_budget) {
                        Ok(()) => GsAnswer {
                            available: true,
                            path: path.to_string(),
                            version,
                            reason: String::new(),
                            detail: String::new(),
                        },
                        Err(detail) => GsAnswer {
                            available: false,
                            path: path.to_string(),
                            version,
                            reason: PROBE_FAILED.to_string(),
                            detail,
                        },
                    }
                }
            }
        }
    };
    if cacheable_probe_result(&answer, budget) {
        remember(key, &answer);
    }
    answer
}

// ── Discovery ─────────────────────────────────────────────────────────────

fn exe_names() -> Vec<String> {
    CANDIDATE_NAMES
        .iter()
        .map(|n| {
            if cfg!(windows) {
                format!("{}.exe", n)
            } else {
                n.to_string()
            }
        })
        .collect()
}

/// One named executable, as PATH resolves it.
pub fn which(name: &str) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    let names = if cfg!(windows) && !name.to_lowercase().ends_with(".exe") {
        vec![name.to_string(), format!("{}.exe", name)]
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&path_var).take(MAX_PATH_DIRECTORIES) {
        for candidate in &names {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// The Ghostscript an AppImage carries: `bin/gs`, which starts the image's
/// own copy on the image's own libraries.
fn image_candidate_in(root: Option<&Path>) -> Option<PathBuf> {
    let exe = root?.join("bin").join("gs");
    exe.is_file().then_some(exe)
}

pub fn image_candidate() -> Option<PathBuf> {
    image_candidate_in(crate::engine::image_root().as_deref())
}

/// Whether `dir` lies inside `root`. The image's start puts its own `bin`
/// first on PATH; that copy is already the bundled candidate, and a PATH
/// entry inside the image is not a discovered install.
fn inside(dir: &Path, root: &Path) -> bool {
    let resolve = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    resolve(dir).starts_with(resolve(root))
}

/// Console executables reachable through PATH.
pub fn path_candidates() -> Vec<String> {
    path_candidates_in(std::env::var_os("PATH"), crate::engine::image_root().as_deref())
}

fn path_candidates_in(path_var: Option<std::ffi::OsString>, image: Option<&Path>) -> Vec<String> {
    let mut found = Vec::new();
    let Some(path_var) = path_var else {
        return found;
    };
    for dir in std::env::split_paths(&path_var).take(MAX_PATH_DIRECTORIES) {
        if image.is_some_and(|root| inside(&dir, root)) {
            continue;
        }
        for name in exe_names() {
            let candidate = dir.join(&name);
            if candidate.is_file() {
                let text = candidate.to_string_lossy().to_string();
                if !found.contains(&text) {
                    found.push(text);
                    if found.len() >= MAX_PATH_CANDIDATES {
                        return found;
                    }
                }
            }
        }
    }
    found
}

/// Installs recorded in the machine's uninstall keys.
///
/// Kept — not replaced by PATH — because a per-machine Ghostscript install
/// puts nothing on PATH, and that is the ordinary shape of the install this
/// product now asks users to perform.
#[cfg(windows)]
pub fn registry_candidates() -> Vec<(String, String, String)> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let mut found: Vec<(String, String, String)> = Vec::new();
    let mut scanned = 0usize;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let uninstall_paths = [
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ];

    for uninstall_path in &uninstall_paths {
        let Ok(key) = hklm.open_subkey_with_flags(uninstall_path, KEY_READ) else {
            continue;
        };
        for entry in key
            .enum_keys()
            .take(MAX_REGISTRY_KEYS.saturating_sub(scanned))
        {
            scanned += 1;
            let Ok(name) = entry else {
                continue;
            };
            if !name.to_lowercase().contains("ghostscript") {
                continue;
            }
            let Ok(subkey) = key.open_subkey_with_flags(&name, KEY_READ) else {
                continue;
            };
            let display_name: String = subkey.get_value("DisplayName").unwrap_or_default();
            let publisher: String = subkey.get_value("Publisher").unwrap_or_default();
            let mut install_location: String =
                subkey.get_value("InstallLocation").unwrap_or_default();

            if install_location.is_empty() {
                let uninstall_str: String = subkey.get_value("UninstallString").unwrap_or_default();
                if !uninstall_str.is_empty() {
                    let clean = uninstall_str.trim_matches('"');
                    if let Some(parent) = Path::new(clean).parent() {
                        install_location = parent.to_string_lossy().to_string();
                    }
                }
            }
            if install_location.is_empty() {
                continue;
            }

            let install_path = Path::new(&install_location);
            for name in exe_names() {
                let exe = install_path.join("bin").join(&name);
                if exe.is_file() {
                    found.push((
                        exe.to_string_lossy().to_string(),
                        display_name.clone(),
                        publisher.clone(),
                    ));
                    if found.len() >= MAX_REGISTRY_CANDIDATES {
                        return found;
                    }
                    break;
                }
            }
        }
    }
    found
}

#[cfg(not(windows))]
pub fn registry_candidates() -> Vec<(String, String, String)> {
    Vec::new()
}

/// Every candidate path, best first: explicit, environment, the bundled
/// copies (the installer's tree, then an AppImage's own), then what discovery
/// finds (registry, PATH).
pub fn candidates(explicit: Option<&str>, bundled: Option<&Path>) -> Vec<String> {
    let mut discovered: Vec<String> = registry_candidates()
        .into_iter()
        .map(|(path, _, _)| path)
        .collect();
    discovered.extend(path_candidates());
    let env = std::env::var(PATH_ENV_VAR).ok();
    let image = image_candidate();
    ordered_candidates(explicit, env.as_deref(), &[bundled, image.as_deref()], discovered)
}

fn ordered_candidates(
    explicit: Option<&str>,
    env: Option<&str>,
    bundled: &[Option<&Path>],
    discovered: Vec<String>,
) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut push = |text: String| {
        if found.len() < MAX_DISCOVERY_CANDIDATES
            && !text.trim().is_empty()
            && !found.contains(&text)
        {
            found.push(text);
        }
    };
    if let Some(explicit) = explicit {
        push(explicit.to_string());
    }
    if let Some(env) = env {
        push(env.trim().to_string());
    }
    for copy in bundled.iter().flatten() {
        push(copy.to_string_lossy().to_string());
    }
    for path in discovered {
        push(path);
    }
    found
}

/// The capability answer for an explicit path, or for what discovery finds.
///
/// An explicit path that fails IS the answer: quietly running a different
/// Ghostscript than the one the user named is how a settings screen starts
/// lying about what it is doing.
pub fn resolve(explicit: Option<&str>, bundled: Option<&Path>) -> GsAnswer {
    if let Some(explicit) = explicit {
        let explicit = explicit.trim();
        if !explicit.is_empty() {
            if explicit.contains('/') || explicit.contains('\\') {
                return probe(explicit);
            }
            // A bare name is still explicit: it resolves through PATH, and a
            // name PATH cannot resolve is the answer rather than a reason to
            // go looking for some other install.
            return match which(explicit) {
                Some(found) => probe(&found),
                None => GsAnswer::unavailable(explicit, NOT_EXECUTABLE, ""),
            };
        }
    }
    resolve_candidates_with(
        candidates(None, bundled),
        RESOLUTION_BUDGET,
        probe_with_budget,
    )
}

fn resolve_candidates_with(
    candidates: impl IntoIterator<Item = String>,
    budget: Duration,
    mut probe_candidate: impl FnMut(&str, Duration) -> GsAnswer,
) -> GsAnswer {
    let deadline = Instant::now() + budget;
    let mut first_failure: Option<GsAnswer> = None;
    let mut first_candidate = true;
    for candidate in candidates.into_iter().take(MAX_DISCOVERY_CANDIDATES) {
        let remaining = if first_candidate {
            budget
        } else {
            deadline.saturating_duration_since(Instant::now())
        };
        if remaining.is_zero() {
            return GsAnswer::unavailable(
                first_failure.as_ref().map_or("", |answer| answer.path.as_str()),
                PROBE_FAILED,
                "Ghostscript discovery exceeded its total time budget.",
            );
        }
        first_candidate = false;
        let answer = probe_candidate(&candidate, remaining);
        if answer.available {
            return answer;
        }
        if Instant::now() >= deadline {
            return GsAnswer::unavailable(
                &candidate,
                PROBE_FAILED,
                "Ghostscript discovery exceeded its total time budget.",
            );
        }
        if first_failure.is_none() {
            first_failure = Some(answer);
        }
    }
    first_failure.unwrap_or_else(|| GsAnswer::unavailable("", NOT_CONFIGURED, ""))
}

/// The CLI's resolution: a validated path, or the one named error.
pub fn resolve_for_cli(explicit: Option<&str>, bundled: Option<&Path>) -> Result<PathBuf, String> {
    let answer = resolve(explicit, bundled);
    if answer.available {
        return Ok(PathBuf::from(answer.path));
    }
    Err(cli_error(&answer))
}

/// The named CLI error, with the reason appended when there is one to give.
pub fn cli_error(answer: &GsAnswer) -> String {
    match answer.reason.as_str() {
        NOT_EXECUTABLE => format!("{} (nothing runnable at {})", CLI_REQUIRED, answer.path),
        PROBE_FAILED => format!(
            "{} (the one at {} did not pass its capability check: {})",
            CLI_REQUIRED,
            answer.path,
            if answer.detail.is_empty() {
                "the probe render failed"
            } else {
                &answer.detail
            }
        ),
        VERSION_BELOW_MINIMUM => format!(
            "{} (the one at {} is {}, older than the {}.{} this build requires)",
            CLI_REQUIRED,
            answer.path,
            if answer.version.is_empty() {
                "an unknown version"
            } else {
                &answer.version
            },
            MINIMUM_VERSION.0,
            MINIMUM_VERSION.1
        ),
        _ => CLI_REQUIRED.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parses_zero_padded_minors_as_values() {
        assert_eq!(parse_version("10.07.1"), Some((10, 7)));
        assert_eq!(parse_version("10.0.0"), Some((10, 0)));
        assert_eq!(parse_version("9.50"), Some((9, 50)));
        assert_eq!(parse_version("GPL Ghostscript 10.02.1"), Some((10, 2)));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("not a version"), None);
    }

    #[test]
    fn the_probe_cache_has_a_fixed_entry_limit() {
        let mut entries = Vec::new();
        for index in 0..(MAX_CACHE_ENTRIES * 4) {
            let path = format!("C:\\gs\\candidate-{index}\\gswin64c.exe");
            let key = (path.clone(), index as u128, index as u64);
            remember_in(
                &mut entries,
                key,
                &GsAnswer::unavailable(&path, PROBE_FAILED, "x"),
            );
        }

        assert_eq!(entries.len(), MAX_CACHE_ENTRIES);
        assert!(entries.iter().all(|(key, _)| key.0.contains("candidate-")));
    }

    #[test]
    fn the_floor_rejects_the_whole_nine_series() {
        // 9.50's minor is 50, which is larger than 10.0's 0 — the comparison
        // is on the PAIR, never on the minor alone.
        assert!(parse_version("9.50").unwrap() < MINIMUM_VERSION);
        assert!(parse_version("9.99").unwrap() < MINIMUM_VERSION);
        assert!(parse_version("10.0.0").unwrap() >= MINIMUM_VERSION);
        assert!(parse_version("10.07.1").unwrap() >= MINIMUM_VERSION);
    }

    #[test]
    fn a_missing_path_is_not_executable_never_a_spawn() {
        let answer = probe("C:\\nowhere\\gswin64c.exe");
        assert!(!answer.available);
        assert_eq!(answer.reason, NOT_EXECUTABLE);
    }

    #[test]
    fn an_empty_path_is_not_configured() {
        let answer = probe("   ");
        assert!(!answer.available);
        assert_eq!(answer.reason, NOT_CONFIGURED);
    }

    #[test]
    fn a_directory_is_not_a_program() {
        let dir = std::env::temp_dir();
        let answer = probe(&dir.to_string_lossy());
        assert!(!answer.available);
        assert_eq!(answer.reason, NOT_EXECUTABLE);
    }

    #[test]
    fn discovery_puts_explicit_then_environment_then_bundled_then_discovered() {
        let bundled = PathBuf::from(r"C:\app\ghostscript\gswin64c.exe");
        let image = PathBuf::from("/tmp/.mount_spectra/bin/gs");
        let found = ordered_candidates(
            Some(r"C:\chosen\gswin64c.exe"),
            Some(r"C:\env\gswin64c.exe"),
            &[Some(&bundled), Some(&image)],
            vec![r"C:\Program Files\gs\bin\gswin64c.exe".to_string(), "/usr/bin/gs".to_string()],
        );
        assert_eq!(
            found,
            vec![
                r"C:\chosen\gswin64c.exe",
                r"C:\env\gswin64c.exe",
                r"C:\app\ghostscript\gswin64c.exe",
                "/tmp/.mount_spectra/bin/gs",
                r"C:\Program Files\gs\bin\gswin64c.exe",
                "/usr/bin/gs",
            ]
        );
        let found = candidates(Some(r"C:\chosen\gswin64c.exe"), Some(&bundled));
        assert_eq!(found.first().map(String::as_str), Some(r"C:\chosen\gswin64c.exe"));
        let at = found.iter().position(|p| p == r"C:\app\ghostscript\gswin64c.exe");
        let env = usize::from(std::env::var(PATH_ENV_VAR).is_ok_and(|v| !v.trim().is_empty()));
        assert_eq!(at, Some(1 + env));
    }

    #[test]
    fn an_image_directory_on_path_is_not_a_path_candidate() {
        let scratch = tempfile::tempdir().unwrap();
        let image = scratch.path().join("mount");
        let host = scratch.path().join("host");
        let name = exe_names()[0].clone();
        for dir in [image.join("bin"), host.join("bin")] {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(&name), b"").unwrap();
        }
        let path_var = std::env::join_paths([image.join("bin"), host.join("bin")]).unwrap();
        let host_copy = host.join("bin").join(&name).to_string_lossy().to_string();
        assert_eq!(
            path_candidates_in(Some(path_var.clone()), Some(&image)),
            vec![host_copy.clone()]
        );
        assert_eq!(path_candidates_in(Some(path_var), None).len(), 2);
    }

    #[test]
    fn a_copy_named_twice_is_probed_once() {
        let image = PathBuf::from("/tmp/.mount_spectra/bin/gs");
        let once = ordered_candidates(None, None, &[Some(&image), Some(&image)], vec![image.to_string_lossy().to_string()]);
        assert_eq!(once, vec!["/tmp/.mount_spectra/bin/gs".to_string()]);
    }

    #[test]
    fn the_image_candidate_exists_only_when_the_image_carries_bin_gs() {
        let scratch = tempfile::tempdir().unwrap();
        assert_eq!(image_candidate_in(Some(scratch.path())), None);
        assert_eq!(image_candidate_in(None), None);
        std::fs::create_dir_all(scratch.path().join("bin")).unwrap();
        std::fs::write(scratch.path().join("bin").join("gs"), b"").unwrap();
        assert_eq!(
            image_candidate_in(Some(scratch.path())),
            Some(scratch.path().join("bin").join("gs"))
        );
    }

    #[test]
    fn discovery_without_a_bundle_still_produces_candidates_or_none() {
        // The bundled tree is optional by construction: asking with None must
        // not panic and must never invent the vendored path.
        let found = candidates(None, None);
        assert!(found
            .iter()
            .all(|p| !p.contains("\\ghostscript\\gswin64c.exe") || !p.starts_with("C:\\app")));
    }

    #[test]
    fn discovery_stops_after_its_total_time_budget() {
        let candidates = vec!["slow-candidate".to_string(), "later-candidate".to_string()];
        let mut attempts = 0;
        let answer = resolve_candidates_with(
            candidates,
            Duration::from_millis(1),
            |path, _remaining| {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(10));
                GsAnswer::unavailable(path, NOT_EXECUTABLE, "")
            },
        );
        assert_eq!(attempts, 1);
        assert_eq!(answer.reason, PROBE_FAILED);
        assert!(answer.detail.contains("total time budget"));
    }

    #[test]
    fn a_short_probe_failure_is_not_cached_as_a_full_capability_answer() {
        let failed = GsAnswer::unavailable("gs.exe", PROBE_FAILED, "timed out");
        assert!(!cacheable_probe_result(
            &failed,
            Duration::from_secs(RESOLUTION_BUDGET.as_secs() - 1),
        ));
        assert!(cacheable_probe_result(&failed, RESOLUTION_BUDGET));

        let old = GsAnswer {
            available: false,
            path: "gs.exe".into(),
            version: "9.50".into(),
            reason: VERSION_BELOW_MINIMUM.into(),
            detail: String::new(),
        };
        assert!(cacheable_probe_result(
            &old,
            Duration::from_secs(1),
        ));
    }

    #[test]
    fn discovery_caps_the_number_of_candidates_it_probes() {
        let candidates = (0..MAX_DISCOVERY_CANDIDATES + 1)
            .map(|index| format!("candidate-{index}"));
        let mut attempts = 0;
        let answer = resolve_candidates_with(candidates, Duration::from_secs(10), |path, _| {
            attempts += 1;
            GsAnswer::unavailable(path, NOT_EXECUTABLE, "")
        });
        assert_eq!(attempts, MAX_DISCOVERY_CANDIDATES);
        assert_eq!(answer.path, "candidate-0");
    }

    #[test]
    fn an_unusable_answer_produces_the_one_named_cli_error() {
        let answer = GsAnswer::unavailable("", NOT_CONFIGURED, "");
        assert_eq!(cli_error(&answer), CLI_REQUIRED);

        let missing = GsAnswer::unavailable("C:\\nowhere\\gs.exe", NOT_EXECUTABLE, "");
        assert!(missing_names_the_shared_error(&cli_error(&missing)));
        assert!(cli_error(&missing).contains("C:\\nowhere\\gs.exe"));

        let old = GsAnswer {
            available: false,
            path: "C:\\gs\\gs.exe".into(),
            version: "9.50".into(),
            reason: VERSION_BELOW_MINIMUM.into(),
            detail: String::new(),
        };
        assert!(cli_error(&old).contains("9.50"));
        assert!(cli_error(&old).contains("10.0"));
    }

    fn missing_names_the_shared_error(text: &str) -> bool {
        text.starts_with(CLI_REQUIRED)
    }

    #[test]
    fn the_cli_error_names_the_command_lines_fix_for_every_reason() {
        assert_eq!(
            CLI_REQUIRED,
            "this command requires Ghostscript; none is configured -- install it from \
             ghostscript.com, then name it with --gs-path or the SPECTRAPDF_GS_PATH \
             environment variable"
        );
        assert!(CLI_REQUIRED.contains(PATH_ENV_VAR));
        let at = |reason: &str, version: &str, detail: &str| GsAnswer {
            available: false,
            path: "C:\\gs\\gswin64c.exe".into(),
            version: version.into(),
            reason: reason.into(),
            detail: detail.into(),
        };
        for answer in [
            at(NOT_CONFIGURED, "", ""),
            at(NOT_EXECUTABLE, "", ""),
            at(PROBE_FAILED, "10.07.1", "the probe render failed"),
            at(PROBE_FAILED, "10.07.1", ""),
            at(VERSION_BELOW_MINIMUM, "9.50", ""),
            at(VERSION_BELOW_MINIMUM, "", ""),
        ] {
            let text = cli_error(&answer);
            assert!(
                missing_names_the_shared_error(&text),
                "{}: {text}",
                answer.reason
            );
            assert!(text.contains("--gs-path"), "{}: {text}", answer.reason);
            assert!(text.contains(PATH_ENV_VAR), "{}: {text}", answer.reason);
            assert!(!text.contains("Preferences"), "{}: {text}", answer.reason);
        }
    }

    #[test]
    fn probes_that_start_together_never_share_a_directory() {
        use std::sync::{Arc, Barrier};
        const WIDTH: usize = 16;
        for _ in 0..50 {
            let barrier = Arc::new(Barrier::new(WIDTH));
            let starts: Vec<_> = (0..WIDTH)
                .map(|_| {
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        probe_dir().expect("a probe directory")
                    })
                })
                .collect();
            let dirs: Vec<tempfile::TempDir> = starts
                .into_iter()
                .map(|t| t.join().expect("a probe thread"))
                .collect();
            let distinct: std::collections::HashSet<PathBuf> =
                dirs.iter().map(|d| d.path().to_path_buf()).collect();
            assert_eq!(distinct.len(), WIDTH);
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_program_that_never_exits_is_killed_at_its_budget_on_unix() {
        let started = Instant::now();
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "sleep 60"]);
        let err = output_within(cmd, Duration::from_millis(500)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(10));

        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "echo 10.05.1"]);
        let out = output_within(cmd, Duration::from_secs(10)).unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "10.05.1");
    }

    #[test]
    #[cfg(windows)]
    fn a_program_that_never_exits_is_killed_at_its_budget() {
        let started = Instant::now();
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
        let err = output_within(cmd, Duration::from_millis(500)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(10));

        let mut cmd = std::process::Command::new("cmd.exe");
        cmd.args(["/c", "echo 10.05.1"]);
        let out = output_within(cmd, Duration::from_secs(10)).unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "10.05.1");
    }

    #[test]
    #[cfg(windows)]
    fn output_within_stops_the_child_if_a_pipe_reader_cannot_start() {
        let scratch = tempfile::tempdir().unwrap();
        let marker = scratch.path().join("reader-start-failure");
        let started = marker.with_extension("started");
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-Command",
            "Set-Content -NoNewline -Path $env:SPECTRA_GS_STARTED_MARKER -Value started; Start-Sleep -Milliseconds 300; Set-Content -NoNewline -Path $env:SPECTRA_GS_DESCENDANT_MARKER -Value survived",
        ])
        .env("SPECTRA_GS_STARTED_MARKER", &started)
        .env("SPECTRA_GS_DESCENDANT_MARKER", &marker);

        let error = output_within_using(cmd, Duration::from_secs(2), false, {
            let started = started.clone();
            move |_| {
                let startup_deadline = Instant::now() + Duration::from_secs(2);
                while !started.exists() && Instant::now() < startup_deadline {
                    std::thread::sleep(Duration::from_millis(10));
                }
                if !started.exists() {
                    return Err(std::io::Error::other(
                        "the child did not reach its startup marker",
                    ));
                }
                Err(std::io::Error::other(
                    "forced output-reader startup failure",
                ))
            }
        })
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        assert_eq!(
            error.to_string(),
            "forced output-reader startup failure",
            "the injected failure must happen after the child starts"
        );
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            !marker.exists(),
            "the child outlived reader startup failure"
        );
    }

    #[test]
    #[ignore]
    fn output_within_descendant_helper() {
        if std::env::var("SPECTRA_GS_DESCENDANT_HELPER").as_deref() == Ok("parent") {
            let exe = std::env::current_exe().unwrap();
            std::process::Command::new(exe)
                .args([
                    "--exact",
                    "gs::tests::output_within_descendant_helper",
                    "--ignored",
                    "--nocapture",
                ])
                .env("SPECTRA_GS_DESCENDANT_HELPER", "child")
                .spawn()
                .unwrap();
        } else if std::env::var("SPECTRA_GS_DESCENDANT_HELPER").as_deref() == Ok("child") {
            std::thread::sleep(Duration::from_millis(200));
            if let Some(marker) = std::env::var_os("SPECTRA_GS_DESCENDANT_MARKER") {
                std::fs::write(marker, b"survived").unwrap();
            }
        } else if std::env::var("SPECTRA_GS_DESCENDANT_HELPER").as_deref() == Ok("flood") {
            use std::io::Write;
            std::io::stdout()
                .write_all(&vec![b'x'; MAX_CAPTURED_OUTPUT * 2])
                .unwrap();
        }
    }

    #[test]
    fn output_within_finishes_when_the_executable_leaves_a_pipe_holding_child() {
        let scratch = tempfile::tempdir().unwrap();
        let marker = scratch.path().join("descendant-survived");
        let started = Instant::now();
        let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "gs::tests::output_within_descendant_helper",
            "--ignored",
            "--nocapture",
        ])
        .env("SPECTRA_GS_DESCENDANT_HELPER", "parent")
        .env("SPECTRA_GS_DESCENDANT_MARKER", &marker);
        let out = output_within(cmd, Duration::from_secs(2)).unwrap();
        assert!(out.status.success());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!marker.exists(), "the descendant outlived its run");
    }

    #[test]
    fn output_within_bounds_the_bytes_retained_from_a_probe() {
        let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "gs::tests::output_within_descendant_helper",
            "--ignored",
            "--nocapture",
        ])
        .env("SPECTRA_GS_DESCENDANT_HELPER", "flood");
        let out = output_within(cmd, Duration::from_secs(2)).unwrap();
        assert!(out.status.success());
        assert!(out.stdout.len() <= MAX_CAPTURED_OUTPUT);
    }

    #[test]
    fn a_bare_name_path_cannot_resolve_is_the_answer() {
        let answer = resolve(Some("no-such-ghostscript"), None);
        assert!(!answer.available);
        assert_eq!(answer.reason, NOT_EXECUTABLE);
        assert_eq!(answer.path, "no-such-ghostscript");
    }

    #[test]
    fn resolving_an_explicit_failure_never_falls_through_to_discovery() {
        // A named path that cannot run is the answer; substituting a
        // different install would make the settings surface report a path the
        // run did not use.
        let answer = resolve(Some("C:\\nowhere\\gswin64c.exe"), None);
        assert!(!answer.available);
        assert_eq!(answer.path, "C:\\nowhere\\gswin64c.exe");
    }
}
