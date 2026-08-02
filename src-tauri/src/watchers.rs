//! Watched folders (O7) — drop a PDF into an intake folder and a saved
//! guided action runs over it automatically: processed copies mirror into a
//! destination and the originals file into a processed folder (Distiller's
//! classic In → Out → Done shape, which is also what makes the watch
//! idempotent: the intake only ever holds unprocessed work).
//!
//! Watching is POLLING, on purpose: Distiller's own watched folders poll,
//! a 5-second scan of one directory is negligible, and it needs no
//! filesystem-event dependency. A file must hold the SAME SIZE across two
//! consecutive ticks before it counts as arrived — a half-copied file never
//! triggers a run (and if it slips through anyway, the run's per-file
//! isolation reports it and leaves it in the intake for the next tick).
//!
//! Each run SPAWNS THE CLI (`spectrapdf run-action … --moved …`): the
//! exact process a scheduled task runs, so watched runs and scheduled runs
//! cannot disagree — and no engine-pipe sharing with the webview. Runs are
//! logged through the same action-run logs. Watchers live only while the
//! app runs (tray-residency counts); that is the honest in-app posture — no
//! background service, same as everything else.
//!
//! The action is FROZEN into the config at save time (the scheduled-actions
//! lesson): a watcher must not depend on the GUI's localStorage. Config is
//! Rust-owned JSON under the app config dir.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "watched-folders.json";
const POLL_SECS: u64 = 5;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WatchedFolder {
    pub id: String,
    pub name: String,
    /// The intake folder being watched.
    pub source: String,
    /// Where processed copies land (mirrored).
    pub dest: String,
    /// Where processed ORIGINALS file to — required: it is what keeps the
    /// intake holding only unprocessed work.
    pub processed_root: String,
    /// The frozen `{name, steps}` action body (the export construction — can
    /// never carry a password; ask-at-run actions are refused at save).
    pub action: serde_json::Value,
    /// Resolved log folder for the runs ('' = no logs).
    #[serde(default)]
    pub log_dir: String,
    pub enabled: bool,
}

pub struct WatcherState {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(HashMap::new()),
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cannot resolve the config folder: {e}"))?;
    Ok(dir.join(CONFIG_FILE))
}

fn read_config(app: &AppHandle) -> Result<Vec<WatchedFolder>, String> {
    let path = config_path(app)?;
    if !path.is_file() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read {CONFIG_FILE}: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("{CONFIG_FILE} is not valid: {e}"))
}

fn write_config(app: &AppHandle, folders: &[WatchedFolder]) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create the config folder: {e}"))?;
    }
    let body = serde_json::to_string_pretty(folders).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("Cannot write {CONFIG_FILE}: {e}"))
}

/// Canonicalize as far as the path actually EXISTS, then re-append the rest.
/// `canonical_path` returns its input untouched when it cannot resolve, and a
/// destination/processed folder legitimately does not exist yet at save time —
/// so canonicalizing the whole path would silently do nothing for exactly the
/// paths this check exists to compare.
fn canonical_prefix(p: &Path) -> PathBuf {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    loop {
        if cur.exists() {
            let mut base = PathBuf::from(crate::commands::canonical_path(&cur.to_string_lossy()));
            for part in tail.iter().rev() {
                base.push(part);
            }
            return base;
        }
        match cur.file_name() {
            Some(n) => tail.push(n.to_os_string()),
            None => return p.to_path_buf(),
        }
        if !cur.pop() {
            return p.to_path_buf();
        }
    }
}

/// True when `candidate` is at or inside `root`.
///
/// `Path::starts_with` is component-wise but lexical and case-sensitive, so
/// source `C:\Watch` with dest `C:\watch\out` passes it: processed output then
/// lands back in the intake and is reprocessed every tick. Windows spells one
/// directory many ways, so this canonicalizes at the Rust boundary and compares
/// identity rather than strings, as the rest of the app does.
fn inside(root: &Path, candidate: &Path) -> bool {
    // True identity first: catches UNC-vs-mapped-drive and junction aliases
    // that no amount of string canonicalization can see. Needs both to exist,
    // so a not-yet-created folder falls through to the comparison below.
    if same_file::is_same_file(root, candidate).unwrap_or(false) {
        return true;
    }
    let r = canonical_prefix(root);
    let c = canonical_prefix(candidate);
    let lower = |p: &Path| -> Vec<String> {
        p.components()
            .map(|x| x.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    };
    let (rc, cc) = (lower(&r), lower(&c));
    // Case-insensitive because this app is Windows-only (register row P13).
    cc.len() >= rc.len() && rc.iter().zip(cc.iter()).all(|(a, b)| a == b)
}

/// A watcher id becomes a filename (`watched-actions/{id}.json`), so it is a
/// path-injection surface. Enforced inside `action_file_for` rather than at
/// each caller, so every call site is covered by construction.
///
/// The UI generates UUIDs; this accepts those and nothing exotic.
pub fn validate_watcher_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err("A watched folder's id must be 1-64 characters of letters, digits, '-' or '_'.".into())
    }
}

pub fn validate_folder(f: &WatchedFolder) -> Result<(), String> {
    if f.id.trim().is_empty() || f.name.trim().is_empty() {
        return Err("A watched folder needs a name.".into());
    }
    validate_watcher_id(f.id.trim())?;
    let source = Path::new(&f.source);
    if !source.is_dir() {
        return Err(format!("Watch folder not found: {}", f.source));
    }
    if f.dest.trim().is_empty() || f.processed_root.trim().is_empty() {
        return Err(
            "A watched folder needs a destination AND a processed-originals folder — \
             moving processed files out of the intake is what stops them being \
             processed again."
                .into(),
        );
    }
    for (label, dir) in [("destination", &f.dest), ("processed-originals", &f.processed_root)] {
        if inside(source, Path::new(dir)) {
            return Err(format!(
                "The {label} folder must be outside the watched folder."
            ));
        }
    }
    if inside(Path::new(&f.dest), Path::new(&f.processed_root))
        || inside(Path::new(&f.processed_root), Path::new(&f.dest))
    {
        return Err("The destination and processed-originals folders must be separate.".into());
    }
    let steps = f.action.get("steps").and_then(|s| s.as_array());
    if steps.map_or(true, |s| s.is_empty()) {
        return Err("The watcher's action has no steps.".into());
    }
    Ok(())
}

/// The stable-PDF snapshot of an intake folder: (name, size) pairs for files
/// whose size held across two ticks are compared by the caller.
fn scan_pdfs(dir: &Path) -> HashMap<String, u64> {
    let mut out = HashMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_pdf = path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false);
        if !is_pdf || !path.is_file() {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            out.insert(entry.file_name().to_string_lossy().to_string(), meta.len());
        }
    }
    out
}

/// The ONE place a watcher id becomes a path. Validation lives here so every
/// caller — present and future — is covered by construction; a per-call-site
/// check only ever covers the call sites you thought of.
fn action_file_for(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    validate_watcher_id(id)?;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cannot resolve the config folder: {e}"))?
        .join("watched-actions");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create the actions folder: {e}"))?;
    let file = dir.join(format!("{id}.json"));
    // Belt and braces: even with the charset check above, assert the result
    // really is a direct child of the actions folder before anyone writes or
    // deletes through it.
    if file.parent() != Some(dir.as_path()) {
        return Err("Refusing a watched-folder id that escapes its folder.".into());
    }
    Ok(file)
}

fn run_once(exe: &Path, folder: &WatchedFolder, action_file: &Path) {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("run-action")
        .arg(&folder.source)
        .arg("--dest")
        .arg(&folder.dest)
        .arg("--moved")
        .arg(&folder.processed_root)
        .arg("--action")
        .arg(action_file);
    if !folder.log_dir.is_empty() {
        cmd.arg("--log-dir").arg(&folder.log_dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // The run's own report lives in the action-run log; a spawn failure has
    // nowhere better than stderr (the watcher keeps ticking either way).
    match cmd.output() {
        Ok(out) if !out.status.success() => {
            eprintln!(
                "watched folder '{}': run-action exited {:?}",
                folder.name,
                out.status.code()
            );
        }
        Err(e) => eprintln!("watched folder '{}': could not spawn the runner: {e}", folder.name),
        _ => {}
    }
}

fn spawn_watcher(app: &AppHandle, folder: WatchedFolder) {
    let state = app.state::<WatcherState>();
    let stop = Arc::new(AtomicBool::new(false));
    state
        .running
        .lock()
        .unwrap()
        .insert(folder.id.clone(), stop.clone());

    let Ok(exe) = std::env::current_exe() else {
        eprintln!("watched folder '{}': cannot resolve the app path", folder.name);
        return;
    };
    let Ok(action_file) = action_file_for(app, &folder.id) else {
        return;
    };
    // Freeze the action beside the config (idempotent — upsert rewrites it).
    if std::fs::write(
        &action_file,
        serde_json::to_string_pretty(&folder.action).unwrap_or_default(),
    )
    .is_err()
    {
        eprintln!("watched folder '{}': could not write its action file", folder.name);
        return;
    }

    std::thread::spawn(move || {
        let source = PathBuf::from(&folder.source);
        let mut previous: HashMap<String, u64> = HashMap::new();
        // What the last run LEFT BEHIND (failed files stay in the intake).
        // A tick whose stable set equals this snapshot must not re-trigger —
        // a permanently-broken file would otherwise re-run every interval.
        let mut last_failures: Option<HashSet<(String, u64)>> = None;
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_secs(POLL_SECS));
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let current = scan_pdfs(&source);
            let stable: HashSet<(String, u64)> = current
                .iter()
                .filter(|(name, size)| previous.get(*name) == Some(size))
                .map(|(name, size)| (name.clone(), *size))
                .collect();
            previous = current;
            if stable.is_empty() {
                last_failures = None;
                continue;
            }
            if last_failures.as_ref() == Some(&stable) {
                continue; // only the leftovers from the failed run — wait for new work
            }
            run_once(&exe, &folder, &action_file);
            let after = scan_pdfs(&source);
            let leftovers: HashSet<(String, u64)> = after
                .iter()
                .map(|(name, size)| (name.clone(), *size))
                .collect();
            last_failures = if leftovers.is_empty() { None } else { Some(leftovers) };
            previous = after;
        }
    });
}

fn stop_watcher(app: &AppHandle, id: &str) {
    let state = app.state::<WatcherState>();
    let removed = state.running.lock().unwrap().remove(id);
    if let Some(stop) = removed {
        stop.store(true, Ordering::Relaxed);
    }
}

/// Start every enabled watcher — the app-setup hook.
pub fn start_all(app: &AppHandle) {
    let Ok(folders) = read_config(app) else { return };
    for folder in folders.into_iter().filter(|f| f.enabled) {
        if validate_folder(&folder).is_ok() {
            spawn_watcher(app, folder);
        }
        // An entry that no longer validates (folder deleted on disk) simply
        // does not start; the dialog shows it and the user fixes or removes it.
    }
}

#[tauri::command]
pub async fn list_watched_folders(app: AppHandle) -> Result<Vec<WatchedFolder>, String> {
    read_config(&app)
}

#[tauri::command]
pub async fn upsert_watched_folder(app: AppHandle, folder: WatchedFolder) -> Result<(), String> {
    validate_folder(&folder)?;
    let mut folders = read_config(&app)?;
    stop_watcher(&app, &folder.id);
    if let Some(existing) = folders.iter_mut().find(|f| f.id == folder.id) {
        *existing = folder.clone();
    } else {
        folders.push(folder.clone());
    }
    write_config(&app, &folders)?;
    if folder.enabled {
        spawn_watcher(&app, folder);
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_watched_folder(app: AppHandle, id: String) -> Result<(), String> {
    // A renderer-supplied string otherwise reaches `remove_file` unchecked.
    validate_watcher_id(&id)?;
    stop_watcher(&app, &id);
    let mut folders = read_config(&app)?;
    folders.retain(|f| f.id != id);
    write_config(&app, &folders)?;
    if let Ok(file) = action_file_for(&app, &id) {
        let _ = std::fs::remove_file(file);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(source: &str, dest: &str, processed: &str) -> WatchedFolder {
        WatchedFolder {
            id: "w1".into(),
            name: "Intake".into(),
            source: source.into(),
            dest: dest.into(),
            processed_root: processed.into(),
            action: serde_json::json!({"name": "Strip", "steps": [{"op": "strip_metadata", "params": {}}]}),
            log_dir: String::new(),
            enabled: true,
        }
    }

    #[test]
    fn validation_names_every_refusal() {
        let tmp = std::env::temp_dir().join("opdfs-watch-test");
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("in");
        std::fs::create_dir_all(&src).unwrap();
        let s = src.to_string_lossy().to_string();

        let ok = folder(&s, &format!("{}\\out", tmp.display()), &format!("{}\\done", tmp.display()));
        assert!(validate_folder(&ok).is_ok());

        let mut inside_src = ok.clone();
        inside_src.dest = format!("{s}\\out");
        assert!(validate_folder(&inside_src).unwrap_err().contains("outside the watched"));

        let mut no_done = ok.clone();
        no_done.processed_root = String::new();
        assert!(validate_folder(&no_done).unwrap_err().contains("processed-originals"));

        let mut stepless = ok.clone();
        stepless.action = serde_json::json!({"name": "x", "steps": []});
        assert!(validate_folder(&stepless).unwrap_err().contains("no steps"));

        let mut missing = ok;
        missing.source = format!("{s}\\nope");
        assert!(validate_folder(&missing).unwrap_err().contains("not found"));
    }

    #[test]
    fn watcher_ids_cannot_escape_their_folder() {
        // The UI's shape must keep working.
        assert!(validate_watcher_id("3f2b9c1e-4a55-4d7e-9f11-0a1b2c3d4e5f").is_ok());
        assert!(validate_watcher_id("w1").is_ok());
        assert!(validate_watcher_id("a_b-C9").is_ok());

        // Each of these would resolve to a path outside watched-actions/.
        for bad in [
            "",
            "..",
            "../x",
            "..\\x",
            "a/b",
            "a\\b",
            "C:\\evil",
            "\\\\server\\share\\x",
            "x.json",
            "a b",
        ] {
            assert!(
                validate_watcher_id(bad).is_err(),
                "id {bad:?} should be refused"
            );
        }
        assert!(validate_watcher_id(&"a".repeat(65)).is_err(), "over-long id");
        assert!(validate_watcher_id(&"a".repeat(64)).is_ok(), "64 is allowed");
    }

    #[test]
    fn containment_survives_windows_spelling() {
        let tmp = std::env::temp_dir().join("opdfs-watch-case");
        let _ = std::fs::remove_dir_all(&tmp);
        let src = tmp.join("Watch");
        std::fs::create_dir_all(&src).unwrap();

        // The live bug: `starts_with` is case-SENSITIVE, so this passed
        // validation, processed output landed back in the intake, and the
        // watcher reprocessed its own output every tick.
        let differing_case = tmp.join("watch").join("out");
        assert!(
            inside(&src, &differing_case),
            "a differently-cased child must still count as inside"
        );

        // A sibling whose name merely starts with the same letters is NOT
        // inside — the component-wise property that must not regress.
        assert!(!inside(&src, &tmp.join("Watching").join("out")));

        // Same directory, spelled with a redundant traversal.
        std::fs::create_dir_all(tmp.join("other")).unwrap();
        assert!(inside(&src, &tmp.join("other").join("..").join("Watch")));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stable_scan_sees_only_pdfs() {
        let tmp = std::env::temp_dir().join("opdfs-watch-scan");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("a.pdf"), b"12345").unwrap();
        std::fs::write(tmp.join("b.PDF"), b"123").unwrap();
        std::fs::write(tmp.join("notes.txt"), b"x").unwrap();
        let scan = scan_pdfs(&tmp);
        assert_eq!(scan.len(), 2);
        assert_eq!(scan.get("a.pdf"), Some(&5));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
