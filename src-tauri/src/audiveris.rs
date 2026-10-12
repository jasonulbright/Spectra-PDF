//! Is a usable Audiveris installed? — discovery, probe and the user's choice.
//!
//! Audiveris is a separate program the user installs; Spectra ships no copy.
//! Only Recognize music needs it. This module answers for the window (the
//! Preferences section and every engine request that runs it) and for the
//! command line, and hands the engine the answer as the request's `audiveris`
//! parameter, so the engine never runs a program this module did not probe.
//!
//! Discovery order: the path chosen in Preferences (the whole answer when set,
//! even when it fails), `SPECTRAPDF_AUDIVERIS_PATH`, the Windows uninstall
//! entries, the documented Windows install path, PATH, the Linux package's
//! `/opt` path, then the Flathub package.
//!
//! Validation is a probe, never file existence: `-version` must name 5.11 or
//! newer, and a batch export of a score Spectra draws itself must produce one
//! MusicXML score. Answers are cached per path, modification time and size.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::gs::{NOT_CONFIGURED, NOT_EXECUTABLE, PROBE_FAILED, VERSION_BELOW_MINIMUM};

pub const READY: &str = "ready";

/// A minimum, never a pin: 5.11 is the first release whose batch export
/// survives the scan defects that aborted it before.
pub const MINIMUM_VERSION: (u32, u32) = (5, 11);

pub const PATH_ENV_VAR: &str = "SPECTRAPDF_AUDIVERIS_PATH";

pub const FLATPAK_APP_ID: &str = "org.audiveris.audiveris";

/// The project's own releases page. Compiled in: nothing at run time may
/// redirect the user to another download.
pub const RELEASES_URL: &str = "https://github.com/Audiveris/audiveris/releases";

pub const SOURCE_PREFERENCES: &str = "preferences";
pub const SOURCE_ENV: &str = "env";
pub const SOURCE_REGISTRY: &str = "registry";
pub const SOURCE_DEFAULT: &str = "default";
pub const SOURCE_PATH: &str = "path";
pub const SOURCE_OPT: &str = "opt";
pub const SOURCE_FLATPAK: &str = "flatpak";
pub const SOURCE_EXPLICIT: &str = "explicit";

pub const LAUNCHER_EXE: &str = "exe";
pub const LAUNCHER_FLATPAK: &str = "flatpak";

/// The one refusal every Audiveris-needing CLI subcommand reports.
pub const CLI_REQUIRED: &str = "this command requires Audiveris; none was found -- install it \
from https://github.com/Audiveris/audiveris/releases, or name its program with \
--audiveris-path or the SPECTRAPDF_AUDIVERIS_PATH environment variable";

/// The score image the smoke run recognizes (`tests/fixtures/make_omr_probe.py`).
const PROBE_SCORE: &[u8] = include_bytes!("../../tests/fixtures/omr-probe-score.png");

const PREFERENCE_FILE: &str = "audiveris.json";

const VERSION_BUDGET: Duration = Duration::from_secs(60);
const SMOKE_BUDGET: Duration = Duration::from_secs(180);
const RESOLUTION_BUDGET: Duration = Duration::from_secs(300);
const FLATPAK_INFO_BUDGET: Duration = Duration::from_secs(20);
const MAX_CACHE_ENTRIES: usize = 16;
const MAX_ZIP_ENTRIES: usize = 64;
const MAX_ZIP_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(windows)]
const MAX_REGISTRY_KEYS: usize = 4096;

/// The answer the Preferences section shows and the engine is handed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudiverisStatus {
    pub kind: String,
    pub path: Option<String>,
    pub launcher: Option<String>,
    pub version: Option<String>,
    pub source: Option<String>,
    pub ocr_languages: Vec<String>,
    pub detail: Option<String>,
}

impl AudiverisStatus {
    pub fn is_ready(&self) -> bool {
        self.kind == READY
    }

    fn unavailable(launcher: &Launcher, kind: &str, detail: &str) -> Self {
        AudiverisStatus {
            kind: kind.to_string(),
            path: launcher.shown_path(),
            launcher: Some(launcher.kind().to_string()),
            version: None,
            source: None,
            ocr_languages: Vec::new(),
            detail: (!detail.is_empty()).then(|| detail.to_string()),
        }
    }

    fn not_configured() -> Self {
        AudiverisStatus {
            kind: NOT_CONFIGURED.to_string(),
            path: None,
            launcher: None,
            version: None,
            source: None,
            ocr_languages: Vec::new(),
            detail: None,
        }
    }

    fn with_source(mut self, source: &str) -> Self {
        self.source = Some(source.to_string());
        self
    }
}

/// How Audiveris is started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launcher {
    Exe(PathBuf),
    Flatpak,
}

impl Launcher {
    fn kind(&self) -> &'static str {
        match self {
            Launcher::Exe(_) => LAUNCHER_EXE,
            Launcher::Flatpak => LAUNCHER_FLATPAK,
        }
    }

    fn shown_path(&self) -> Option<String> {
        match self {
            Launcher::Exe(path) => Some(path.to_string_lossy().to_string()),
            Launcher::Flatpak => Some(FLATPAK_APP_ID.to_string()),
        }
    }

    /// A command for this launcher. `grant` is the one host folder a flatpak
    /// run may read and write.
    fn command(&self, grant: Option<&Path>) -> std::process::Command {
        let mut cmd = match self {
            Launcher::Exe(path) => std::process::Command::new(path),
            Launcher::Flatpak => {
                let mut cmd = std::process::Command::new("flatpak");
                cmd.arg("run");
                if let Some(folder) = grant {
                    cmd.arg(format!("--filesystem={}", folder.display()));
                }
                cmd.arg(FLATPAK_APP_ID);
                cmd
            }
        };
        scrub_environment(&mut cmd, std::env::vars_os(), crate::engine::image_root().as_deref());
        cmd.stdin(std::process::Stdio::null());
        cmd
    }
}

/// Removes what Spectra sets for its own runtimes from a child's environment:
/// Audiveris reads its own OCR data and libraries, never the bundle's.
fn scrub_environment(
    cmd: &mut std::process::Command,
    vars: impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    image: Option<&Path>,
) {
    let image = image.map(|root| root.to_string_lossy().to_string());
    for (name, value) in vars {
        let upper = name.to_string_lossy().to_uppercase();
        let spectra = matches!(
            upper.as_str(),
            "TESSDATA_PREFIX" | "OPENBLAS_NUM_THREADS" | "GS_LIB" | "WEBVIEW2_USER_DATA_FOLDER"
        ) || upper.starts_with("SPECTRAPDF_")
            || upper.starts_with("PYTHON");
        if spectra {
            cmd.env_remove(&name);
            continue;
        }
        let Some(root) = image.as_deref() else {
            continue;
        };
        let text = value.to_string_lossy();
        if upper.starts_with("LD_") {
            cmd.env_remove(&name);
        } else if text.contains(root) {
            let kept: Vec<&str> = text.split(':').filter(|part| !part.contains(root)).collect();
            if kept.is_empty() || !text.contains(':') {
                cmd.env_remove(&name);
            } else {
                cmd.env(&name, kept.join(":"));
            }
        }
    }
}

// ── The cache ─────────────────────────────────────────────────────────────

/// Launcher path, launcher modification time, launcher size, and a digest of
/// the program files beside it: a jpackage launcher stays byte-identical
/// across releases while its `app` folder changes.
type CacheKey = (String, u128, u64, u64);
static CACHE: Mutex<Vec<(CacheKey, AudiverisStatus)>> = Mutex::new(Vec::new());

pub fn clear_cache() {
    if let Ok(mut entries) = CACHE.lock() {
        entries.clear();
    }
}

fn modified_nanos(meta: &std::fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// A digest of the jars a jpackage launcher runs: name, size and
/// modification time of every file in `app/` beside it (Windows) or
/// `../lib/app/` (the Linux package layout).
fn program_digest(exe: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let Some(dir) = exe.parent() else {
        return 0;
    };
    for folder in [dir.join("app"), dir.join("..").join("lib").join("app")] {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        let mut files: Vec<(String, u64, u128)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                meta.is_file().then(|| {
                    (entry.file_name().to_string_lossy().to_string(), meta.len(), modified_nanos(&meta))
                })
            })
            .collect();
        files.sort();
        folder.to_string_lossy().hash(&mut hasher);
        files.hash(&mut hasher);
    }
    hasher.finish()
}

fn cache_key(launcher: &Launcher) -> Option<CacheKey> {
    match launcher {
        Launcher::Exe(path) => {
            let meta = std::fs::metadata(path).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((
                path.to_string_lossy().to_string(),
                modified_nanos(&meta),
                meta.len(),
                program_digest(path),
            ))
        }
        Launcher::Flatpak => flatpak_info().map(|info| (format!("flatpak:{info}"), 0, 0, 0)),
    }
}

fn cached(key: &CacheKey) -> Option<AudiverisStatus> {
    let entries = CACHE.lock().ok()?;
    entries.iter().find(|(k, _)| k == key).map(|(_, status)| status.clone())
}

fn remember(key: CacheKey, status: &AudiverisStatus) {
    if let Ok(mut entries) = CACHE.lock() {
        entries.retain(|(k, _)| k != &key);
        if entries.len() >= MAX_CACHE_ENTRIES {
            entries.remove(0);
        }
        entries.push((key, status.clone()));
    }
}

// ── Paths Audiveris can read ──────────────────────────────────────────────

/// The 8.3 spelling of an existing Windows path, or the path itself where
/// there is none. The Java launcher converts its arguments through the ANSI
/// code page, so a name outside it reaches Audiveris as question marks.
#[cfg(windows)]
pub fn short_path(path: &Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let long = PCWSTR(wide.as_ptr());
    let size = unsafe { GetShortPathNameW(long, None) } as usize;
    if size == 0 {
        return path.to_path_buf();
    }
    let mut buffer = vec![0u16; size];
    let written = unsafe { GetShortPathNameW(long, Some(&mut buffer)) } as usize;
    if written == 0 || written >= size {
        return path.to_path_buf();
    }
    buffer.truncate(written);
    PathBuf::from(std::ffi::OsString::from_wide(&buffer))
}

#[cfg(not(windows))]
pub fn short_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

/// `path` as Audiveris can read it, or None when no spelling of it passes the
/// Windows code page.
pub fn audiveris_argument(path: &Path) -> Option<PathBuf> {
    let spelled = short_path(path);
    (!cfg!(windows) || spelled.to_string_lossy().is_ascii()).then_some(spelled)
}

/// A per-user ASCII folder for probe files when the temporary folder has no
/// ASCII spelling: `%SystemDrive%\ProgramData\spectrapdf\scratch\probe-<user>`.
fn ascii_probe_root() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    let user: String = std::env::var("USERNAME")
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let root = PathBuf::from(format!("{drive}\\"))
        .join("ProgramData")
        .join("spectrapdf")
        .join("scratch")
        .join(format!("probe-{user}"));
    if !root.to_string_lossy().is_ascii() {
        return None;
    }
    std::fs::create_dir_all(&root).ok()?;
    Some(root)
}

// ── The probe ─────────────────────────────────────────────────────────────

/// The version Audiveris reports on its `- Version:` line.
pub fn parse_version_output(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("- Version:").or_else(|| line.strip_prefix("Version:")))
        .map(|rest| rest.trim().to_string())
        .filter(|version| !version.is_empty())
}

fn meets_minimum(version: &str) -> bool {
    crate::gs::parse_version(version).is_some_and(|parsed| parsed >= MINIMUM_VERSION)
}

/// Where a probe stages its files. A flatpak sandbox cannot be given a folder
/// under the host's /tmp, so a flatpak probe stages in the user's cache. On
/// Windows the folder must have an ASCII spelling.
fn probe_dir(launcher: &Launcher) -> std::io::Result<tempfile::TempDir> {
    let builder = || {
        let mut builder = tempfile::Builder::new();
        builder.prefix("spectra-audiveris-probe-");
        builder
    };
    match launcher {
        Launcher::Exe(_) => {
            let dir = builder().tempdir()?;
            if audiveris_argument(dir.path()).is_some() {
                return Ok(dir);
            }
            let _ = dir.close();
            let root = ascii_probe_root().ok_or_else(|| {
                std::io::Error::other(
                    "no folder whose path Audiveris can read: the temporary folder's path uses \
                     characters outside the system code page and has no short name",
                )
            })?;
            builder().tempdir_in(root)
        }
        Launcher::Flatpak => {
            let cache = std::env::var_os("XDG_CACHE_HOME")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
                .ok_or_else(|| std::io::Error::other("no cache folder"))?;
            let root = cache.join("spectrapdf").join("omr");
            std::fs::create_dir_all(&root)?;
            builder().tempdir_in(root)
        }
    }
}

/// Constants every recognition passes: persist nothing, and write one
/// compressed MusicXML file per movement whatever the user's own Audiveris
/// options say.
pub const FIXED_CONSTANTS: [&str; 3] = [
    "org.audiveris.omr.Main.persistBatchCliConstants=false",
    "org.audiveris.omr.sheet.BookManager.useCompression=true",
    "org.audiveris.omr.sheet.BookManager.useOpus=false",
];

fn smoke(launcher: &Launcher, budget: Duration) -> Result<(), String> {
    let dir = probe_dir(launcher).map_err(|e| format!("cannot create a probe folder: {e}"))?;
    let input = dir.path().join("probe.png");
    let output = dir.path().join("out");
    std::fs::write(&input, PROBE_SCORE).map_err(|e| format!("cannot write the probe score: {e}"))?;
    std::fs::create_dir_all(&output).map_err(|e| format!("cannot create a probe folder: {e}"))?;
    let mut cmd = launcher.command(Some(dir.path()));
    cmd.args(["-batch", "-export", "-output"])
        .arg(audiveris_argument(&output).unwrap_or_else(|| output.clone()));
    for constant in FIXED_CONSTANTS {
        cmd.args(["-constant", constant]);
    }
    cmd.arg("--").arg(audiveris_argument(&input).unwrap_or_else(|| input.clone()));
    let verdict = match crate::gs::output_within(cmd, budget) {
        Err(e) => Err(e.to_string()),
        Ok(out) if !out.status.success() => Err(format!(
            "the probe recognition ended with status {}",
            out.status.code().map_or_else(|| "unknown".to_string(), |c| c.to_string())
        )),
        Ok(_) => match std::fs::read(output.join("probe.mxl")) {
            Ok(bytes) if mxl_is_score(&bytes) => Ok(()),
            Ok(_) => Err("the probe recognition wrote no readable score".to_string()),
            Err(_) => Err("the probe recognition wrote no score".to_string()),
        },
    };
    let _ = dir.close();
    verdict
}

/// Validate one launcher. The answer carries no source; `resolve` adds it.
pub fn probe(launcher: &Launcher) -> AudiverisStatus {
    probe_with_budget(launcher, RESOLUTION_BUDGET)
}

/// Every answer is cached under the launcher's key, a failure included when
/// the probe had the whole budget: a broken candidate is not probed again
/// until the launcher or its program files change, or the user asks to check
/// again. A failure decided on a budget an earlier candidate shortened may be
/// the shortened budget's, so it is not kept; only the first discovery
/// candidate has the whole budget, so a failing later candidate is probed
/// again on each resolution.
fn probe_with_budget(launcher: &Launcher, budget: Duration) -> AudiverisStatus {
    let started = Instant::now();
    let Some(key) = cache_key(launcher) else {
        return AudiverisStatus::unavailable(launcher, NOT_EXECUTABLE, "");
    };
    if let Some(hit) = cached(&key) {
        return with_languages(hit, launcher);
    }
    let mut version = launcher.command(None);
    version.arg("-version");
    let status = match crate::gs::output_within(version, budget.min(VERSION_BUDGET)) {
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
            AudiverisStatus::unavailable(launcher, PROBE_FAILED, &e.to_string())
        }
        Err(e) => AudiverisStatus::unavailable(launcher, NOT_EXECUTABLE, &e.to_string()),
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            match parse_version_output(&text) {
                None => AudiverisStatus::unavailable(
                    launcher,
                    PROBE_FAILED,
                    if out.status.success() {
                        "no version was reported"
                    } else {
                        "the version query failed"
                    },
                ),
                Some(found) if !meets_minimum(&found) => AudiverisStatus {
                    version: Some(found),
                    ..AudiverisStatus::unavailable(launcher, VERSION_BELOW_MINIMUM, "")
                },
                Some(found) => {
                    let remaining = budget.saturating_sub(started.elapsed()).min(SMOKE_BUDGET);
                    let verdict = if remaining.is_zero() {
                        Err("the check exceeded its time budget".to_string())
                    } else {
                        smoke(launcher, remaining)
                    };
                    match verdict {
                        Ok(()) => AudiverisStatus {
                            kind: READY.to_string(),
                            version: Some(found),
                            ..AudiverisStatus::unavailable(launcher, READY, "")
                        },
                        Err(detail) => AudiverisStatus {
                            version: Some(found),
                            ..AudiverisStatus::unavailable(launcher, PROBE_FAILED, &detail)
                        },
                    }
                }
            }
        }
    };
    let failed = status.kind == PROBE_FAILED || status.kind == NOT_EXECUTABLE;
    if budget >= RESOLUTION_BUDGET || !failed {
        remember(key, &status);
    }
    with_languages(status, launcher)
}

fn with_languages(mut status: AudiverisStatus, launcher: &Launcher) -> AudiverisStatus {
    status.ocr_languages = tessdata_dir(launcher).map(|dir| ocr_languages(&dir)).unwrap_or_default();
    status
}

/// The folder Audiveris reads OCR languages from once Spectra has removed
/// `TESSDATA_PREFIX` from its environment: `tessdata` in its config folder.
pub fn tessdata_dir(launcher: &Launcher) -> Option<PathBuf> {
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    match launcher {
        Launcher::Flatpak => Some(home()?.join(".var/app").join(FLATPAK_APP_ID).join("config/tessdata")),
        Launcher::Exe(_) if cfg!(windows) => Some(
            PathBuf::from(std::env::var_os("APPDATA")?)
                .join("AudiverisLtd")
                .join("audiveris")
                .join("config")
                .join("tessdata"),
        ),
        Launcher::Exe(_) => {
            let config = std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .or_else(|| home().map(|h| h.join(".config")))?;
            Some(config.join("AudiverisLtd").join("audiveris").join("tessdata"))
        }
    }
}

/// The language codes of the `.traineddata` files in `dir`, sorted. The
/// orientation and equation models are not languages.
pub fn ocr_languages(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.strip_suffix(".traineddata").map(str::to_string)
        })
        .filter(|code| !code.is_empty() && code != "osd" && code != "equ")
        .collect();
    found.sort();
    found.dedup();
    found
}

// ── Reading a MusicXML container ──────────────────────────────────────────

fn le16(bytes: &[u8], at: usize) -> Option<usize> {
    bytes.get(at..at + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize)
}

fn le32(bytes: &[u8], at: usize) -> Option<usize> {
    bytes
        .get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
}

/// Every entry of a zip archive by name, read through its central directory.
fn zip_entries(bytes: &[u8]) -> Option<Vec<(String, Vec<u8>)>> {
    const END: u32 = 0x0605_4b50;
    const CENTRAL: u32 = 0x0201_4b50;
    const LOCAL: u32 = 0x0403_4b50;
    let search_from = bytes.len().saturating_sub(22 + 65_535);
    let end = (search_from..=bytes.len().saturating_sub(22))
        .rev()
        .find(|&at| le32(bytes, at) == Some(END as usize))?;
    let count = le16(bytes, end + 10)?;
    let mut at = le32(bytes, end + 16)?;
    if count > MAX_ZIP_ENTRIES {
        return None;
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        if le32(bytes, at)? != CENTRAL as usize {
            return None;
        }
        let method = le16(bytes, at + 10)?;
        let compressed = le32(bytes, at + 20)?;
        let size = le32(bytes, at + 24)?;
        let name_len = le16(bytes, at + 28)?;
        let extra_len = le16(bytes, at + 30)?;
        let comment_len = le16(bytes, at + 32)?;
        let local = le32(bytes, at + 42)?;
        let name = String::from_utf8_lossy(bytes.get(at + 46..at + 46 + name_len)?).to_string();
        at += 46 + name_len + extra_len + comment_len;
        if le32(bytes, local)? != LOCAL as usize || size as u64 > MAX_ZIP_ENTRY_BYTES {
            return None;
        }
        let start = local + 30 + le16(bytes, local + 26)? + le16(bytes, local + 28)?;
        let data = bytes.get(start..start.checked_add(compressed)?)?;
        let body = match method {
            0 => data.to_vec(),
            8 => {
                let mut inflated = Vec::with_capacity(size);
                flate2::read::DeflateDecoder::new(data)
                    .take(MAX_ZIP_ENTRY_BYTES)
                    .read_to_end(&mut inflated)
                    .ok()?;
                inflated
            }
            _ => return None,
        };
        out.push((name, body));
    }
    Some(out)
}

/// The name of an XML document's root element.
fn root_element(xml: &str) -> Option<&str> {
    let mut rest = xml.trim_start_matches('\u{feff}');
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("<?") {
            rest = &after[after.find("?>")? + 2..];
        } else if let Some(after) = rest.strip_prefix("<!--") {
            rest = &after[after.find("-->")? + 3..];
        } else if let Some(after) = rest.strip_prefix("<!") {
            rest = &after[after.find('>')? + 1..];
        } else if let Some(after) = rest.strip_prefix('<') {
            let end = after.find(|c: char| c.is_whitespace() || c == '>' || c == '/')?;
            return Some(&after[..end]);
        } else {
            return None;
        }
    }
}

/// Whether `bytes` are a compressed MusicXML file whose root file is a score.
pub fn mxl_is_score(bytes: &[u8]) -> bool {
    let Some(entries) = zip_entries(bytes) else {
        return false;
    };
    let find = |name: &str| entries.iter().find(|(n, _)| n == name).map(|(_, body)| body);
    let Some(container) = find("META-INF/container.xml") else {
        return false;
    };
    let container = String::from_utf8_lossy(container);
    let Some(start) = container.find("full-path=\"") else {
        return false;
    };
    let rest = &container[start + "full-path=\"".len()..];
    let Some(end) = rest.find('"') else {
        return false;
    };
    let Some(score) = find(&rest[..end]) else {
        return false;
    };
    matches!(
        root_element(&String::from_utf8_lossy(score)),
        Some("score-partwise" | "score-timewise" | "opus")
    )
}

// ── Discovery ─────────────────────────────────────────────────────────────

/// One candidate launcher and the source it came from.
pub type Candidate = (Launcher, &'static str);

fn ordered_candidates(
    env: Option<&str>,
    registry: Vec<String>,
    default: Option<String>,
    path: Vec<String>,
    opt: Option<String>,
    flatpak: bool,
) -> Vec<Candidate> {
    let mut found: Vec<Candidate> = Vec::new();
    let mut push = |launcher: Launcher, source: &'static str| {
        let seen = found.iter().any(|(l, _)| match (l, &launcher) {
            (Launcher::Exe(a), Launcher::Exe(b)) => {
                a == b || (cfg!(windows) && a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()))
            }
            (Launcher::Flatpak, Launcher::Flatpak) => true,
            _ => false,
        });
        if !seen {
            found.push((launcher, source));
        }
    };
    if let Some(env) = env.map(str::trim).filter(|e| !e.is_empty()) {
        push(Launcher::Exe(PathBuf::from(env)), SOURCE_ENV);
    }
    for path in registry {
        push(Launcher::Exe(PathBuf::from(path)), SOURCE_REGISTRY);
    }
    if let Some(default) = default {
        push(Launcher::Exe(PathBuf::from(default)), SOURCE_DEFAULT);
    }
    for found_path in path {
        push(Launcher::Exe(PathBuf::from(found_path)), SOURCE_PATH);
    }
    if let Some(opt) = opt {
        push(Launcher::Exe(PathBuf::from(opt)), SOURCE_OPT);
    }
    if flatpak {
        push(Launcher::Flatpak, SOURCE_FLATPAK);
    }
    found
}

/// `Audiveris.exe` of each uninstall entry Audiveris's installer writes.
#[cfg(windows)]
pub fn registry_candidates() -> Vec<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let mut found = Vec::new();
    let mut scanned = 0usize;
    let roots = [
        (HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
        (HKEY_LOCAL_MACHINE, "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
        (HKEY_CURRENT_USER, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"),
    ];
    for (hive, path) in roots {
        let Ok(key) = RegKey::predef(hive).open_subkey_with_flags(path, KEY_READ) else {
            continue;
        };
        for name in key.enum_keys().take(MAX_REGISTRY_KEYS.saturating_sub(scanned)) {
            scanned += 1;
            let Ok(name) = name else { continue };
            let Ok(entry) = key.open_subkey_with_flags(&name, KEY_READ) else {
                continue;
            };
            let display: String = entry.get_value("DisplayName").unwrap_or_default();
            let publisher: String = entry.get_value("Publisher").unwrap_or_default();
            if !display.trim().eq_ignore_ascii_case("audiveris")
                && !publisher.trim().eq_ignore_ascii_case("audiveris.org")
            {
                continue;
            }
            let location: String = entry.get_value("InstallLocation").unwrap_or_default();
            let location = location.trim().trim_matches('"');
            if location.is_empty() {
                continue;
            }
            let exe = Path::new(location).join("Audiveris.exe");
            if exe.is_file() {
                found.push(exe.to_string_lossy().to_string());
            }
        }
    }
    found
}

#[cfg(not(windows))]
pub fn registry_candidates() -> Vec<String> {
    Vec::new()
}

/// The documented Windows install path, when its file exists.
fn default_candidate() -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let root = std::env::var_os("ProgramW6432")
        .or_else(|| std::env::var_os("ProgramFiles"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let exe = root.join("Audiveris").join("Audiveris.exe");
    exe.is_file().then(|| exe.to_string_lossy().to_string())
}

fn path_candidates() -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for name in ["audiveris", "Audiveris"] {
        if let Some(hit) = crate::gs::which(name) {
            if !found.contains(&hit) {
                found.push(hit);
            }
        }
    }
    found
}

fn opt_candidate() -> Option<String> {
    let exe = Path::new("/opt/audiveris/bin/Audiveris");
    (cfg!(target_os = "linux") && exe.is_file()).then(|| exe.to_string_lossy().to_string())
}

/// `flatpak info` of the Audiveris package, or None when it is not installed.
fn flatpak_info() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let mut cmd = std::process::Command::new("flatpak");
    cmd.args(["info", FLATPAK_APP_ID]);
    let out = crate::gs::output_within(cmd, FLATPAK_INFO_BUDGET).ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let commit = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("Commit:"))
        .map(|commit| commit.trim().to_string())
        .unwrap_or_default();
    Some(commit)
}

pub fn candidates() -> Vec<Candidate> {
    let env = std::env::var(PATH_ENV_VAR).ok();
    ordered_candidates(
        env.as_deref(),
        registry_candidates(),
        default_candidate(),
        path_candidates(),
        opt_candidate(),
        flatpak_info().is_some(),
    )
}

/// The launcher a configured path names: a file path as it is, a bare name
/// through PATH.
fn explicit_launcher(path: &str) -> Result<Launcher, AudiverisStatus> {
    let path = path.trim();
    if path.contains('/') || path.contains('\\') {
        return Ok(Launcher::Exe(PathBuf::from(path)));
    }
    crate::gs::which(path).map(|hit| Launcher::Exe(PathBuf::from(hit))).ok_or_else(|| {
        AudiverisStatus::unavailable(&Launcher::Exe(PathBuf::from(path)), NOT_EXECUTABLE, "")
    })
}

/// The answer for a configured path, or for what discovery finds. A
/// configured path that fails IS the answer.
pub fn resolve(configured: Option<&str>, configured_source: &'static str) -> AudiverisStatus {
    if let Some(path) = configured.map(str::trim).filter(|p| !p.is_empty()) {
        return match explicit_launcher(path) {
            Ok(launcher) => probe(&launcher).with_source(configured_source),
            Err(status) => status.with_source(configured_source),
        };
    }
    resolve_candidates_with(candidates(), RESOLUTION_BUDGET, probe_with_budget)
}

fn resolve_candidates_with(
    candidates: Vec<Candidate>,
    budget: Duration,
    mut probe_candidate: impl FnMut(&Launcher, Duration) -> AudiverisStatus,
) -> AudiverisStatus {
    let deadline = Instant::now() + budget;
    let mut first_failure: Option<AudiverisStatus> = None;
    for (position, (launcher, source)) in candidates.into_iter().enumerate() {
        let remaining = if position == 0 {
            budget
        } else {
            deadline.saturating_duration_since(Instant::now())
        };
        if remaining.is_zero() {
            break;
        }
        let status = probe_candidate(&launcher, remaining);
        if status.is_ready() {
            return status.with_source(source);
        }
        if first_failure.is_none() {
            first_failure = Some(status.with_source(source));
        }
    }
    first_failure.unwrap_or_else(AudiverisStatus::not_configured)
}

// ── The user's choice ─────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Preference {
    path: Option<String>,
}

/// The preference record, in the folder that holds the app's settings. The
/// command line reads the same file, so a scheduled or watched-folder run
/// uses the Audiveris the user chose in the window.
pub fn preference_file() -> Option<PathBuf> {
    let decision = crate::portable::root_decision().ok()?;
    crate::portable::resolve_root(decision, crate::portable::user_config_dir())
        .map(|root| root.join(PREFERENCE_FILE))
}

pub fn read_preference_at(file: &Path) -> Option<String> {
    let bytes = crate::staging::read_record(file).ok()??;
    let preference: Preference = serde_json::from_slice(&bytes).ok()?;
    preference.path.filter(|p| !p.trim().is_empty())
}

pub fn write_preference_at(file: &Path, path: Option<&str>) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create the settings folder: {e}"))?;
    }
    let body = serde_json::to_vec_pretty(&Preference {
        path: path.map(str::trim).filter(|p| !p.is_empty()).map(str::to_string),
    })
    .map_err(|e| e.to_string())?;
    crate::staging::write_record(file, &body).map_err(|e| format!("Cannot write {}: {e}", file.display()))
}

pub fn read_preference() -> Option<String> {
    read_preference_at(&preference_file()?)
}

/// The window's answer: the Preferences path, else discovery.
pub fn status() -> AudiverisStatus {
    resolve(read_preference().as_deref(), SOURCE_PREFERENCES)
}

/// The command line's answer: `--audiveris-path`, else the Preferences path,
/// else discovery; or the one named refusal.
pub fn resolve_for_cli(explicit: Option<&str>) -> Result<AudiverisStatus, String> {
    let status = match explicit.map(str::trim).filter(|p| !p.is_empty()) {
        Some(path) => resolve(Some(path), SOURCE_EXPLICIT),
        None => status(),
    };
    if status.is_ready() {
        Ok(status)
    } else {
        Err(cli_error(&status))
    }
}

pub fn cli_error(status: &AudiverisStatus) -> String {
    let path = status.path.as_deref().unwrap_or("");
    match status.kind.as_str() {
        NOT_EXECUTABLE => format!("{CLI_REQUIRED} (nothing runnable at {path})"),
        PROBE_FAILED => format!(
            "{CLI_REQUIRED} (the one at {path} did not pass its check: {})",
            status.detail.as_deref().unwrap_or("the probe recognition failed")
        ),
        VERSION_BELOW_MINIMUM => format!(
            "{CLI_REQUIRED} (the one at {path} is {}, older than the {}.{} this build requires)",
            status.version.as_deref().unwrap_or("an unknown version"),
            MINIMUM_VERSION.0,
            MINIMUM_VERSION.1
        ),
        _ => CLI_REQUIRED.to_string(),
    }
}

/// Whether an engine request runs Audiveris: `recognize_music_run`, or a
/// guided run (not a plan) with an `omr` step. None for a method that takes no
/// Audiveris answer.
fn runs_audiveris(request: &serde_json::Value) -> Option<bool> {
    match request.get("method").and_then(serde_json::Value::as_str) {
        Some("recognize_music_run") => Some(true),
        Some("run_action") => {
            let params = request.get("params");
            let plan = params
                .and_then(|p| p.get("plan"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let omr = params
                .and_then(|p| p.get("steps"))
                .and_then(serde_json::Value::as_array)
                .is_some_and(|steps| {
                    steps
                        .iter()
                        .any(|step| step.get("op").and_then(serde_json::Value::as_str) == Some("omr"))
                });
            Some(omr && !plan)
        }
        _ => None,
    }
}

/// Whether the host must answer for Audiveris before `request` is sent.
pub fn wants_answer(request: &serde_json::Value) -> bool {
    runs_audiveris(request) == Some(true)
}

/// Sets the parameters the host owns, replacing whatever the caller sent:
/// `audiveris` (the engine runs the program it names) and, on a publication
/// that keeps the project, `project_id` (the only handle "Open in Audiveris"
/// accepts).
pub fn stamp_request(label: &str, request: &mut serde_json::Value, answer: Option<AudiverisStatus>) {
    let method = request
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let takes_answer = runs_audiveris(request).is_some();
    let Some(params) = request.get_mut("params").and_then(serde_json::Value::as_object_mut) else {
        return;
    };
    if takes_answer {
        params.remove("audiveris");
        if let Some(value) = answer.and_then(|answer| serde_json::to_value(answer).ok()) {
            params.insert("audiveris".to_string(), value);
        }
    }
    if method == "recognize_music_publish" {
        params.remove("project_id");
        if params.get("keep_project").and_then(serde_json::Value::as_bool) == Some(true) {
            let id = uuid::Uuid::new_v4().to_string();
            let mut state = session();
            if state.pending.len() >= MAX_SESSION_ENTRIES {
                state.pending.clear();
            }
            state.pending.insert((label.to_string(), id.clone()));
            params.insert("project_id".to_string(), serde_json::Value::from(id));
        }
    }
}

// ── What this session's recognitions produced ─────────────────────────────

/// One recognized movement as the run reported it: its index and the suffix
/// it adds after the score's name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Movement {
    pub index: u64,
    pub suffix: String,
}

#[derive(Default)]
struct Session {
    /// (window, token) -> the movements of the run, and whether a project can
    /// be published.
    runs: HashMap<(String, String), (Vec<Movement>, bool)>,
    /// (window, project id) stamped on a publication not yet answered.
    pending: HashSet<(String, String)>,
    /// (window, project id) -> the project a publication of that window wrote.
    projects: HashMap<(String, String), PathBuf>,
}

const MAX_SESSION_ENTRIES: usize = 256;

fn session() -> std::sync::MutexGuard<'static, Session> {
    static SESSION: std::sync::OnceLock<Mutex<Session>> = std::sync::OnceLock::new();
    let guard = SESSION
        .get_or_init(|| Mutex::new(Session::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
}

/// Records what an engine answer to `label` says a recognition produced: a
/// run's movements, keyed by its token, and a publication's project, keyed by
/// the id the host stamped on that publication.
pub fn observe_result(label: &str, response: &serde_json::Value) {
    let Some(result) = response.get("result").and_then(serde_json::Value::as_object) else {
        return;
    };
    let mut state = session();
    if let (Some(token), Some(movements)) = (
        result.get("token").and_then(serde_json::Value::as_str),
        result.get("movements").and_then(serde_json::Value::as_array),
    ) {
        let parsed: Vec<Movement> = movements
            .iter()
            .filter_map(|movement| {
                Some(Movement {
                    index: movement.get("index")?.as_u64()?,
                    suffix: movement.get("name")?.as_str()?.to_string(),
                })
            })
            .collect();
        let project = result.get("project").and_then(serde_json::Value::as_bool) == Some(true);
        if state.runs.len() >= MAX_SESSION_ENTRIES {
            state.runs.clear();
        }
        state.runs.insert((label.to_string(), token.to_string()), (parsed, project));
        return;
    }
    let Some(id) = result.get("projectId").and_then(serde_json::Value::as_str) else {
        return;
    };
    let key = (label.to_string(), id.to_string());
    if !state.pending.remove(&key) {
        return;
    }
    let Some(project) = result.get("project").and_then(serde_json::Value::as_str) else {
        return;
    };
    let path = dunce::canonicalize(project).unwrap_or_else(|_| PathBuf::from(project));
    if state.projects.len() >= MAX_SESSION_ENTRIES {
        state.projects.clear();
    }
    state.projects.insert(key, path);
}

/// The name a publication writes under: `_check_name` in
/// `engine/recognize_music.py` strips what Python's `str.strip()` strips, which
/// is Unicode white space plus U+001C..U+001F; `char::is_whitespace` lacks
/// those four.
pub fn score_name(name: &str) -> String {
    name.trim_matches(|c: char| c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c))
        .to_string()
}

/// Every file a publication writes, in the engine's order: each movement,
/// then the project when it is kept and the run produced one.
pub fn target_names(stem: &str, extension: &str, movements: &[Movement], keep_project: bool) -> Vec<String> {
    let mut names: Vec<String> = movements
        .iter()
        .map(|movement| format!("{stem}{}{extension}", movement.suffix))
        .collect();
    if keep_project {
        names.push(format!("{stem}.omr"));
    }
    names
}

/// The exact files a `recognize_music_publish` request of `label` writes, for
/// the output reservation. Refuses a token no run of this window answered.
pub fn publish_targets(label: &str, params: &serde_json::Value) -> Result<Vec<String>, String> {
    let text = |name: &str| params.get(name).and_then(serde_json::Value::as_str).unwrap_or("");
    let folder = Path::new(text("output_dir"));
    if !folder.is_absolute() {
        return Err("An engine output path or folder must be absolute.".to_string());
    }
    let stem = score_name(text("base_name"));
    if stem.is_empty() {
        return Err("Recognize music must name its score.".to_string());
    }
    let extension = if text("format").eq_ignore_ascii_case("musicxml") { ".musicxml" } else { ".mxl" };
    let keep = params.get("keep_project").and_then(serde_json::Value::as_bool) == Some(true);
    let (movements, project) = session()
        .runs
        .get(&(label.to_string(), text("token").to_string()))
        .cloned()
        .ok_or_else(|| "Recognize music has no recognized score for this request.".to_string())?;
    Ok(target_names(&stem, extension, &movements, keep && project)
        .into_iter()
        .map(|name| folder.join(name).to_string_lossy().to_string())
        .collect())
}

/// The project a publication of `label` wrote under `id`, when it is still an
/// `.omr` file.
fn registered_project(label: &str, id: &str) -> Option<PathBuf> {
    let path = session().projects.get(&(label.to_string(), id.to_string()))?.clone();
    let is_omr = path
        .extension()
        .is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("omr"));
    (is_omr && path.is_file()).then_some(path)
}

// ── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn audiveris_status() -> Result<AudiverisStatus, String> {
    tauri::async_runtime::spawn_blocking(status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn audiveris_set_path(path: Option<String>) -> Result<AudiverisStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = preference_file().ok_or_else(|| "Cannot resolve the settings folder.".to_string())?;
        write_preference_at(&file, path.as_deref())?;
        clear_cache();
        Ok(status())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn audiveris_recheck() -> Result<AudiverisStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        clear_cache();
        status()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Opens the project's releases page. Takes no argument, so the webview cannot
/// turn it into a general URL opener.
#[tauri::command]
pub async fn audiveris_open_releases(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    #[allow(deprecated)]
    app.shell().open(RELEASES_URL, None).map_err(|e| e.to_string())
}

pub const OPEN_NOT_PROJECT: &str = "omr.openProjectNotProject";
pub const OPEN_NOT_READY: &str = "omr.openProjectNoAudiveris";
pub const OPEN_UNREADABLE: &str = "omr.openProjectPathUnreadable";

/// Starts the user's Audiveris on a project a publication of this window
/// wrote, for correction there. The window names the project only by the id
/// that publication returned.
#[tauri::command]
pub async fn audiveris_open_project(window: tauri::WebviewWindow, project_id: String) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let project = registered_project(&label, &project_id).ok_or_else(|| OPEN_NOT_PROJECT.to_string())?;
        let answer = status();
        if !answer.is_ready() {
            return Err(OPEN_NOT_READY.to_string());
        }
        let launcher = match answer.launcher.as_deref() {
            Some(LAUNCHER_FLATPAK) => Launcher::Flatpak,
            _ => Launcher::Exe(PathBuf::from(answer.path.unwrap_or_default())),
        };
        let argument = match launcher {
            Launcher::Flatpak => project.clone(),
            Launcher::Exe(_) => audiveris_argument(&project).ok_or_else(|| OPEN_UNREADABLE.to_string())?,
        };
        let mut cmd = launcher.command(project.parent());
        cmd.arg("--").arg(&argument);
        cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exe(path: &str) -> Launcher {
        Launcher::Exe(PathBuf::from(path))
    }

    #[test]
    fn discovery_orders_env_registry_default_path_opt_flatpak() {
        let found = ordered_candidates(
            Some(r"C:\env\Audiveris.exe"),
            vec![r"D:\Apps\Audiveris\Audiveris.exe".to_string()],
            Some(r"C:\Program Files\Audiveris\Audiveris.exe".to_string()),
            vec![r"C:\Users\u\scoop\shims\audiveris.exe".to_string()],
            Some("/opt/audiveris/bin/Audiveris".to_string()),
            true,
        );
        let expected: Vec<Candidate> = vec![
            (exe(r"C:\env\Audiveris.exe"), SOURCE_ENV),
            (exe(r"D:\Apps\Audiveris\Audiveris.exe"), SOURCE_REGISTRY),
            (exe(r"C:\Program Files\Audiveris\Audiveris.exe"), SOURCE_DEFAULT),
            (exe(r"C:\Users\u\scoop\shims\audiveris.exe"), SOURCE_PATH),
            (exe("/opt/audiveris/bin/Audiveris"), SOURCE_OPT),
            (Launcher::Flatpak, SOURCE_FLATPAK),
        ];
        assert_eq!(found, expected);
    }

    #[test]
    fn a_registry_entry_at_the_default_path_is_one_candidate() {
        let at = r"C:\Program Files\Audiveris\Audiveris.exe".to_string();
        let found = ordered_candidates(None, vec![at.clone()], Some(at.clone()), vec![at.clone()], None, false);
        assert_eq!(found, vec![(exe(&at), SOURCE_REGISTRY)]);
    }

    #[test]
    fn an_empty_environment_value_is_no_candidate() {
        assert!(ordered_candidates(Some("  "), vec![], None, vec![], None, false).is_empty());
    }

    #[test]
    fn the_first_ready_candidate_wins_and_reports_its_source() {
        let candidates = vec![
            (exe("broken"), SOURCE_ENV),
            (exe("installed"), SOURCE_REGISTRY),
            (exe("later"), SOURCE_PATH),
        ];
        let mut asked = Vec::new();
        let mut budgets = Vec::new();
        let status = resolve_candidates_with(candidates, Duration::from_secs(10), |launcher, budget| {
            let path = launcher.shown_path().unwrap();
            asked.push(path.clone());
            budgets.push(budget);
            if path == "installed" {
                AudiverisStatus { kind: READY.into(), ..AudiverisStatus::unavailable(launcher, READY, "") }
            } else {
                AudiverisStatus::unavailable(launcher, PROBE_FAILED, "x")
            }
        });
        assert!(status.is_ready());
        assert_eq!(status.path.as_deref(), Some("installed"));
        assert_eq!(status.source.as_deref(), Some(SOURCE_REGISTRY));
        assert_eq!(asked, vec!["broken", "installed"]);
        assert_eq!(budgets[0], Duration::from_secs(10), "the first candidate has the whole budget");
        assert!(budgets[1] <= Duration::from_secs(10));
    }

    #[test]
    fn no_candidate_is_not_configured_and_a_failure_keeps_its_reason() {
        let none = resolve_candidates_with(Vec::new(), Duration::from_secs(10), |l, _| {
            AudiverisStatus::unavailable(l, PROBE_FAILED, "x")
        });
        assert_eq!(none.kind, NOT_CONFIGURED);
        assert_eq!(none.path, None);
        let failed = resolve_candidates_with(vec![(exe("old"), SOURCE_PATH)], Duration::from_secs(10), |l, _| {
            AudiverisStatus::unavailable(l, VERSION_BELOW_MINIMUM, "")
        });
        assert_eq!(failed.kind, VERSION_BELOW_MINIMUM);
        assert_eq!(failed.source.as_deref(), Some(SOURCE_PATH));
    }

    #[test]
    fn a_configured_path_that_fails_is_the_answer() {
        let status = resolve(Some(r"C:\nowhere\Audiveris.exe"), SOURCE_PREFERENCES);
        assert_eq!(status.kind, NOT_EXECUTABLE);
        assert_eq!(status.source.as_deref(), Some(SOURCE_PREFERENCES));
        assert_eq!(status.path.as_deref(), Some(r"C:\nowhere\Audiveris.exe"));
        let bare = resolve(Some("no-such-audiveris-program"), SOURCE_EXPLICIT);
        assert_eq!(bare.kind, NOT_EXECUTABLE);
    }

    #[test]
    fn the_version_line_is_read_and_the_floor_is_5_11() {
        let windows = "INFO  []  TesseractOCR 137  | Creating OCR folder C:\\x\nAudiveris\n- Version:      5.11.0\n- OCR Engine:   Tesseract OCR, version 5.5.2\n";
        assert_eq!(parse_version_output(windows).as_deref(), Some("5.11.0"));
        assert_eq!(parse_version_output("Audiveris\n"), None);
        assert!(meets_minimum("5.11.0"));
        assert!(meets_minimum("5.12"));
        assert!(meets_minimum("6.0.0"));
        assert!(!meets_minimum("5.10.2"));
        assert!(!meets_minimum("5.9.0"));
    }

    #[test]
    fn the_probe_score_is_a_png() {
        assert!(PROBE_SCORE.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    fn stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, body) in entries {
            let offset = out.len() as u32;
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(body);
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend_from_slice(&(body.len() as u32).to_le_bytes());
            central.extend_from_slice(&(body.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let start = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&start.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    const CONTAINER: &[u8] = b"<?xml version=\"1.0\"?><container><rootfiles><rootfile full-path=\"s.xml\" media-type=\"application/vnd.recordare.musicxml+xml\"/></rootfiles></container>";

    #[test]
    fn a_container_whose_root_file_is_a_score_is_a_score() {
        let score = b"<?xml version=\"1.0\"?>\n<!DOCTYPE score-partwise PUBLIC \"-//Recordare//DTD MusicXML 4.0.3 Partwise//EN\" \"http://www.musicxml.org/dtds/partwise.dtd\">\n<!-- c --><score-partwise version=\"4.0.3\"></score-partwise>";
        assert!(mxl_is_score(&stored_zip(&[("META-INF/container.xml", CONTAINER), ("s.xml", score)])));
    }

    #[test]
    fn anything_else_is_not_a_score() {
        let html = b"<html></html>";
        assert!(!mxl_is_score(&stored_zip(&[("META-INF/container.xml", CONTAINER), ("s.xml", html)])));
        assert!(!mxl_is_score(&stored_zip(&[("s.xml", b"<score-partwise/>")])));
        assert!(!mxl_is_score(b"not a zip at all"));
        assert!(!mxl_is_score(&[]));
    }

    #[test]
    fn spectra_variables_never_reach_audiveris() {
        let vars = vec![
            ("TESSDATA_PREFIX", "C:\\spectra\\tessdata"),
            ("SPECTRAPDF_ICC_ASSENT", "1"),
            ("PYTHONUTF8", "1"),
            ("OPENBLAS_NUM_THREADS", "1"),
            ("APPDATA", "C:\\Users\\u\\AppData\\Roaming"),
        ];
        let mut cmd = std::process::Command::new("x");
        scrub_environment(
            &mut cmd,
            vars.iter().map(|(k, v)| (k.into(), v.into())),
            None,
        );
        let removed: Vec<String> = cmd
            .get_envs()
            .filter(|(_, v)| v.is_none())
            .map(|(k, _)| k.to_string_lossy().to_string())
            .collect();
        for name in ["TESSDATA_PREFIX", "SPECTRAPDF_ICC_ASSENT", "PYTHONUTF8", "OPENBLAS_NUM_THREADS"] {
            assert!(removed.iter().any(|r| r.eq_ignore_ascii_case(name)), "{name} kept");
        }
        assert!(!removed.iter().any(|r| r.eq_ignore_ascii_case("APPDATA")));
    }

    #[test]
    fn an_image_entry_leaves_a_list_and_the_loader_variables_go() {
        let vars = vec![
            ("LD_LIBRARY_PATH", "/tmp/.mount_x/lib"),
            ("XDG_DATA_DIRS", "/tmp/.mount_x/share:/usr/share"),
            ("GTK_PATH", "/tmp/.mount_x/lib/gtk"),
            ("HOME", "/home/u"),
        ];
        let mut cmd = std::process::Command::new("x");
        scrub_environment(
            &mut cmd,
            vars.iter().map(|(k, v)| (k.into(), v.into())),
            Some(Path::new("/tmp/.mount_x")),
        );
        let envs: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().to_string(), v.map(|v| v.to_string_lossy().to_string())))
            .collect();
        let get = |name: &str| envs.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).cloned();
        assert_eq!(get("LD_LIBRARY_PATH").unwrap().1, None);
        assert_eq!(get("GTK_PATH").unwrap().1, None);
        assert_eq!(get("XDG_DATA_DIRS").unwrap().1.as_deref(), Some("/usr/share"));
        assert!(get("HOME").is_none());
    }

    #[test]
    fn the_preference_round_trips_and_null_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join(PREFERENCE_FILE);
        assert_eq!(read_preference_at(&file), None);
        write_preference_at(&file, Some(r"C:\Apps\Audiveris\Audiveris.exe")).unwrap();
        assert_eq!(read_preference_at(&file).as_deref(), Some(r"C:\Apps\Audiveris\Audiveris.exe"));
        write_preference_at(&file, None).unwrap();
        assert_eq!(read_preference_at(&file), None);
        write_preference_at(&file, Some("   ")).unwrap();
        assert_eq!(read_preference_at(&file), None);
    }

    #[test]
    fn the_host_answer_replaces_whatever_the_caller_sent() {
        let ready = || AudiverisStatus {
            kind: READY.into(),
            ..AudiverisStatus::unavailable(&exe(r"C:\A\Audiveris.exe"), READY, "")
        };
        let mut request = serde_json::json!({
            "method": "recognize_music_run",
            "params": {"token": "1-x", "audiveris": {"kind": "ready", "launcher": "exe", "path": "C:\\evil.exe"}}
        });
        assert!(wants_answer(&request));
        stamp_request("main", &mut request, Some(ready()));
        assert_eq!(request["params"]["audiveris"]["path"], r"C:\A\Audiveris.exe");

        let mut plan = serde_json::json!({
            "method": "run_action",
            "params": {"steps": [{"op": "omr"}], "plan": true, "audiveris": {"path": "C:\\evil.exe"}}
        });
        assert!(!wants_answer(&plan));
        stamp_request("main", &mut plan, None);
        assert!(plan["params"].get("audiveris").is_none());

        let mut run = serde_json::json!({
            "method": "run_action",
            "params": {"steps": [{"op": "compress"}, {"op": "omr"}]}
        });
        assert!(wants_answer(&run));
        stamp_request("main", &mut run, Some(ready()));
        assert_eq!(run["params"]["audiveris"]["kind"], READY);

        let mut other = serde_json::json!({"method": "compress", "params": {"audiveris": 1}});
        assert!(!wants_answer(&other));
        stamp_request("main", &mut other, None);
        assert_eq!(other["params"]["audiveris"], 1);

        for method in ["recognize_music_prepare", "recognize_music_publish", "recognize_music_attach"] {
            assert!(!wants_answer(&serde_json::json!({"method": method, "params": {}})), "{method}");
        }
    }

    fn run_answer(token: &str, movements: serde_json::Value, project: bool) -> serde_json::Value {
        serde_json::json!({"id": 1, "result": {
            "token": token, "movements": movements, "project": project, "skippedPages": [], "log": null
        }})
    }

    #[test]
    fn a_publication_reserves_exactly_the_files_its_run_produced() {
        let folder = std::env::temp_dir().join("scores");
        let movements = serde_json::json!([
            {"index": 1, "pages": [1], "name": ".mvt1"},
            {"index": 2, "pages": [3], "name": ".mvt2"}
        ]);
        observe_result("win-a", &run_answer("10-a", movements, true));
        let params = |keep: bool, format: &str, base: &str, token: &str| {
            serde_json::json!({
                "token": token, "output_dir": folder.to_string_lossy(), "base_name": base,
                "format": format, "keep_project": keep
            })
        };
        let names = |found: Vec<String>| {
            found
                .iter()
                .map(|path| {
                    assert!(Path::new(path).starts_with(&folder), "{path}");
                    Path::new(path).file_name().unwrap().to_string_lossy().to_string()
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(publish_targets("win-a", &params(true, "mxl", " book ", "10-a")).unwrap()),
            ["book.mvt1.mxl", "book.mvt2.mxl", "book.omr"]
        );
        assert_eq!(
            names(publish_targets("win-a", &params(false, "musicxml", "\u{1f}book", "10-a")).unwrap()),
            ["book.mvt1.musicxml", "book.mvt2.musicxml"]
        );
        observe_result("win-a", &run_answer("10-b", serde_json::json!([{"index": 1, "pages": [1], "name": ""}]), false));
        assert_eq!(
            names(publish_targets("win-a", &params(true, "mxl", "song", "10-b")).unwrap()),
            ["song.mxl"]
        );
        let unknown = publish_targets("win-b", &params(true, "mxl", "book", "10-a")).unwrap_err();
        assert!(unknown.contains("no recognized score"), "{unknown}");
        let blank = publish_targets("win-a", &params(true, "mxl", " \u{1c} ", "10-a")).unwrap_err();
        assert!(blank.contains("name its score"), "{blank}");
        let relative = serde_json::json!({"token": "10-a", "output_dir": "scores", "base_name": "b"});
        assert!(publish_targets("win-a", &relative).unwrap_err().contains("absolute"));
    }

    #[test]
    fn a_project_opens_only_by_the_id_its_own_publication_returned() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("book.omr");
        std::fs::write(&project, b"x").unwrap();
        let mut publish = serde_json::json!({
            "method": "recognize_music_publish",
            "params": {"token": "1-a", "keep_project": true, "project_id": "forged"}
        });
        stamp_request("win-p", &mut publish, None);
        let id = publish["params"]["project_id"].as_str().unwrap().to_string();
        assert_ne!(id, "forged");

        let answer = |id: &str, path: &Path| serde_json::json!({"id": 2, "result": {
            "files": [], "project": path.to_string_lossy(), "projectId": id
        }});
        observe_result("win-p", &answer("forged", &project));
        assert_eq!(registered_project("win-p", "forged"), None);
        observe_result("win-q", &answer(&id, &project));
        assert_eq!(registered_project("win-q", &id), None);
        observe_result("win-p", &answer(&id, &project));
        assert_eq!(
            registered_project("win-p", &id),
            Some(dunce::canonicalize(&project).unwrap())
        );
        assert_eq!(registered_project("win-q", &id), None);

        let mut no_project = serde_json::json!({
            "method": "recognize_music_publish",
            "params": {"token": "1-a", "keep_project": false, "project_id": "forged"}
        });
        stamp_request("win-p", &mut no_project, None);
        assert!(no_project["params"].get("project_id").is_none());

        std::fs::remove_file(&project).unwrap();
        assert_eq!(registered_project("win-p", &id), None);
    }

    #[test]
    fn a_path_audiveris_cannot_read_has_no_argument() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        std::fs::create_dir(&plain).unwrap();
        assert!(audiveris_argument(&plain).is_some());
        let greek = dir.path().join("\u{3a8}\u{3b7}\u{3c6}\u{3af}\u{3bf}");
        std::fs::create_dir(&greek).unwrap();
        let spelled = audiveris_argument(&greek);
        if cfg!(windows) {
            match spelled {
                Some(short) => {
                    assert!(short.to_string_lossy().is_ascii(), "{short:?}");
                    assert!(short.is_dir());
                }
                None => println!("SKIPPED short-name check: this volume makes no 8.3 names"),
            }
        } else {
            assert_eq!(spelled, Some(greek));
        }
    }

    #[test]
    fn the_cache_key_follows_the_program_files() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("Audiveris.exe");
        std::fs::write(&exe, b"launcher").unwrap();
        std::fs::create_dir(dir.path().join("app")).unwrap();
        std::fs::write(dir.path().join("app").join("audiveris.jar"), b"one").unwrap();
        let before = cache_key(&Launcher::Exe(exe.clone())).unwrap();
        std::fs::write(dir.path().join("app").join("audiveris.jar"), b"two!").unwrap();
        let after = cache_key(&Launcher::Exe(exe.clone())).unwrap();
        assert_eq!((before.0.clone(), before.1, before.2), (after.0.clone(), after.1, after.2));
        assert_ne!(before.3, after.3);
    }

    #[test]
    fn a_failed_probe_is_remembered_and_a_launch_failure_is_not_executable() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join("Audiveris.exe");
        std::fs::write(&fake, b"not a program").unwrap();
        let launcher = Launcher::Exe(fake.clone());
        let key = cache_key(&launcher).unwrap();
        let shortened = probe_with_budget(&launcher, Duration::from_secs(5));
        assert_eq!(shortened.kind, NOT_EXECUTABLE, "{shortened:?}");
        assert_eq!(cached(&key), None, "a failure on a shortened budget is not kept");
        let full = probe_with_budget(&launcher, RESOLUTION_BUDGET);
        assert_eq!(full.kind, NOT_EXECUTABLE, "{full:?}");
        assert_eq!(cached(&key).map(|status| status.kind), Some(NOT_EXECUTABLE.to_string()));
    }

    /// The present axis: an Audiveris on this machine must probe ready. A
    /// machine without one prints a SKIPPED line and checks nothing.
    #[test]
    fn an_installed_audiveris_probes_ready_when_installed() {
        let found = resolve(None, SOURCE_EXPLICIT);
        if found.kind == NOT_CONFIGURED {
            println!(
                "SKIPPED an_installed_audiveris_probes_ready_when_installed: \
                 no Audiveris 5.11 or newer is installed"
            );
            return;
        }
        assert!(found.is_ready(), "{found:?}");
        assert!(found.version.as_deref().is_some_and(meets_minimum));
        assert!(found.source.is_some());
        let again = resolve(None, SOURCE_EXPLICIT);
        assert_eq!(again, found);
    }

    #[test]
    fn the_cli_refusal_names_its_own_fixes() {
        assert!(CLI_REQUIRED.contains("--audiveris-path"));
        assert!(CLI_REQUIRED.contains(PATH_ENV_VAR));
        let old = AudiverisStatus {
            version: Some("5.10.2".into()),
            ..AudiverisStatus::unavailable(&exe(r"C:\A\Audiveris.exe"), VERSION_BELOW_MINIMUM, "")
        };
        assert!(cli_error(&old).contains("5.10.2, older than the 5.11"));
    }
}
