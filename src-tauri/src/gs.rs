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
//! Discovery is ordered explicit → environment → registry → PATH → bundled
//! candidate. The registry scan is kept because it finds per-machine installs
//! that were never put on PATH; the bundled candidate is LAST and optional —
//! the resolution must not assume the vendored tree exists.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

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
pub const CLI_REQUIRED: &str = "this command requires Ghostscript; none is configured -- \
install it from ghostscript.com, or point Spectra at an existing install with --gs-path \
(Preferences > Engine in the app)";

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

fn remember(key: CacheKey, answer: &GsAnswer) {
    if let Ok(mut guard) = CACHE.lock() {
        let entries = guard.get_or_insert_with(Vec::new);
        entries.retain(|(k, _)| k != &key);
        entries.push((key, answer.clone()));
    }
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

/// Render one tiny page. `Ok(())` only when a raster actually came out.
fn smoke(exe: &str) -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!(
        "spectra-gs-probe-{}",
        std::process::id() as u64 * 31 + rand_suffix()
    ));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Err(format!("cannot create a probe directory: {}", e));
    }
    let png = dir.join("probe.png");
    let outcome = command(exe)
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
        ])
        .output();
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
    let _ = std::fs::remove_dir_all(&dir);
    verdict
}

/// A per-call suffix so two concurrent probes cannot share a scratch dir.
fn rand_suffix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0)
}

/// Validate ONE candidate path.
pub fn probe(path: &str) -> GsAnswer {
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

    let answer = match command(path).arg("--version").output() {
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
                match smoke(path) {
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
    };
    remember(key, &answer);
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
    for dir in std::env::split_paths(&path_var) {
        for candidate in &names {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Console executables reachable through PATH.
pub fn path_candidates() -> Vec<String> {
    let mut found = Vec::new();
    let Some(path_var) = std::env::var_os("PATH") else {
        return found;
    };
    for dir in std::env::split_paths(&path_var) {
        for name in exe_names() {
            let candidate = dir.join(&name);
            if candidate.is_file() {
                let text = candidate.to_string_lossy().to_string();
                if !found.contains(&text) {
                    found.push(text);
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
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let uninstall_paths = [
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ];

    for uninstall_path in &uninstall_paths {
        let Ok(key) = hklm.open_subkey_with_flags(uninstall_path, KEY_READ) else {
            continue;
        };
        for name in key.enum_keys().flatten() {
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

/// Every candidate path, best first: explicit, environment, registry, PATH,
/// then the bundled tree if one is still present.
pub fn candidates(explicit: Option<&str>, bundled: Option<&Path>) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    let mut push = |text: String| {
        if !text.trim().is_empty() && !found.contains(&text) {
            found.push(text);
        }
    };
    if let Some(explicit) = explicit {
        push(explicit.to_string());
    }
    if let Ok(env) = std::env::var(PATH_ENV_VAR) {
        push(env.trim().to_string());
    }
    for (path, _, _) in registry_candidates() {
        push(path);
    }
    for path in path_candidates() {
        push(path);
    }
    if let Some(bundled) = bundled {
        push(bundled.to_string_lossy().to_string());
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
    let mut first_failure: Option<GsAnswer> = None;
    for candidate in candidates(None, bundled) {
        let answer = probe(&candidate);
        if answer.available {
            return answer;
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
    fn discovery_puts_an_explicit_path_first_and_the_bundle_last() {
        let bundled = PathBuf::from("C:\\app\\ghostscript\\gswin64c.exe");
        let found = candidates(Some("C:\\chosen\\gswin64c.exe"), Some(&bundled));
        assert_eq!(found.first().map(String::as_str), Some("C:\\chosen\\gswin64c.exe"));
        assert_eq!(
            found.last().map(String::as_str),
            Some("C:\\app\\ghostscript\\gswin64c.exe")
        );
    }

    #[test]
    fn discovery_without_a_bundle_still_produces_candidates_or_none() {
        // The bundled tree is optional by construction: asking with None must
        // not panic and must never invent the vendored path.
        let found = candidates(None, None);
        assert!(found.iter().all(|p| !p.contains("\\ghostscript\\gswin64c.exe")
            || !p.starts_with("C:\\app")));
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
