//! Watched folders — drop a PDF into an intake folder and a saved
//! guided action runs over it automatically: processed copies mirror into a
//! destination and the originals file into a processed folder. The
//! intake → out → done shape is what makes the watch idempotent: the intake
//! only ever holds unprocessed work.
//!
//! Watching is POLLING, on purpose: a 5-second scan of one directory is
//! negligible, and it needs no filesystem-event dependency. A file must hold the SAME SIZE across two
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
    let dir = crate::portable::config_root(app)?;
    Ok(dir.join(CONFIG_FILE))
}

/// The folders the config at `path` lists. No file lists none. A file that
/// exists but cannot be read or parsed is an error rather than an empty list,
/// so no save can write a shorter list over folders nobody read.
fn read_config_at(path: &Path) -> Result<Vec<WatchedFolder>, String> {
    match crate::staging::read_record(path) {
        Ok(None) => Ok(vec![]),
        Ok(Some(bytes)) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("{} is not valid: {e}", path.display())),
        Err(e) => Err(format!("Cannot read {}: {e}", path.display())),
    }
}

fn write_config_at(path: &Path, folders: &[WatchedFolder]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create the config folder: {e}"))?;
    }
    let body = serde_json::to_string_pretty(folders).map_err(|e| e.to_string())?;
    crate::staging::write_record(path, body.as_bytes())
        .map_err(|e| format!("Cannot write {}: {e}", path.display()))
}

fn read_config(app: &AppHandle) -> Result<Vec<WatchedFolder>, String> {
    read_config_at(&config_path(app)?)
}

/// Held across each read-modify-write of the config. Two saves that each read
/// the list and write it back would otherwise keep only the later change.
static CONFIG_EDIT: Mutex<()> = Mutex::new(());

/// Add `folder`, or replace the entry with its id, in the config at `path`.
fn upsert_at(path: &Path, folder: &WatchedFolder) -> Result<(), String> {
    let _editing = CONFIG_EDIT.lock().unwrap_or_else(|e| e.into_inner());
    let mut folders = read_config_at(path)?;
    if let Some(existing) = folders.iter_mut().find(|f| f.id == folder.id) {
        *existing = folder.clone();
    } else {
        folders.push(folder.clone());
    }
    write_config_at(path, &folders)
}

/// Drop the entry with `id` from the config at `path`.
fn remove_at(path: &Path, id: &str) -> Result<(), String> {
    let _editing = CONFIG_EDIT.lock().unwrap_or_else(|e| e.into_inner());
    let mut folders = read_config_at(path)?;
    folders.retain(|f| f.id != id);
    write_config_at(path, &folders)
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
    // Case-insensitive because this app is Windows-only.
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
    let dir = crate::portable::config_root(app)?.join("watched-actions");
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

/// Write the frozen action a watcher's runs read. A run the replaced watcher
/// spawned may be reading the file while it is rewritten.
fn freeze_action(action_file: &Path, action: &serde_json::Value) -> std::io::Result<()> {
    let body = serde_json::to_string_pretty(action).map_err(std::io::Error::other)?;
    crate::staging::write_record(action_file, body.as_bytes())
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
    if let Err(e) = freeze_action(&action_file, &folder.action) {
        eprintln!(
            "watched folder '{}': could not write its action file: {e}",
            folder.name
        );
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
///
/// A config that cannot be read starts nothing and is left as it is; the
/// dialog reports the same error when it lists the folders.
pub fn start_all(app: &AppHandle) {
    let folders = match read_config(app) {
        Ok(folders) => folders,
        Err(e) => {
            eprintln!("watched folders: none started: {e}");
            return;
        }
    };
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
    upsert_at(&config_path(&app)?, &folder)?;
    stop_watcher(&app, &folder.id);
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
    remove_at(&config_path(&app)?, &id)?;
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

        // `starts_with` is case-sensitive, so path containment must account
        // for Windows' case-insensitive filesystem semantics.
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

    fn entry(id: &str, name: &str) -> WatchedFolder {
        let mut entry = folder("C:\\in", "C:\\out", "C:\\done");
        entry.id = id.into();
        entry.name = name.into();
        entry
    }

    fn listed(path: &Path) -> Vec<(String, String)> {
        read_config_at(path)
            .unwrap()
            .into_iter()
            .map(|f| (f.id, f.name))
            .collect()
    }

    #[test]
    fn an_absent_config_lists_nothing_and_an_unreadable_one_refuses_every_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CONFIG_FILE);
        assert!(read_config_at(&path).unwrap().is_empty());

        let torn = b"[{\"id\":\"w1\",\"name\":\"Int";
        std::fs::write(&path, torn).unwrap();
        let refused = read_config_at(&path).unwrap_err();
        assert!(refused.contains(&path.display().to_string()), "{refused}");
        assert!(upsert_at(&path, &entry("w2", "Second")).is_err());
        assert!(remove_at(&path, "w1").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), torn);

        // A config that exists but cannot be opened is not an absent one.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(read_config_at(&path).is_err());
        assert!(upsert_at(&path, &entry("w2", "Second")).is_err());
    }

    #[test]
    fn a_save_replaces_the_config_whole_and_keeps_the_other_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config").join(CONFIG_FILE);
        upsert_at(&path, &entry("a", "First")).unwrap();
        upsert_at(&path, &entry("b", "Second")).unwrap();
        upsert_at(&path, &entry("a", "Renamed")).unwrap();
        assert_eq!(
            listed(&path),
            vec![
                ("a".to_string(), "Renamed".to_string()),
                ("b".to_string(), "Second".to_string())
            ]
        );
        remove_at(&path, "a").unwrap();
        assert_eq!(listed(&path), vec![("b".to_string(), "Second".to_string())]);
        let beside: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(beside, vec![std::ffi::OsString::from(CONFIG_FILE)]);
    }

    /// Both records go through the staged writer, which is also what reclaims
    /// the stage a writer killed mid-write left beside each of them.
    #[cfg(windows)]
    #[test]
    fn the_config_and_the_frozen_action_land_through_the_staged_writer() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join(CONFIG_FILE);
        let action_file = dir.path().join("w1.json");
        let mut writer = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        writer.wait().unwrap();
        let orphans = [
            crate::staging::stage_path(&config, writer.id()),
            crate::staging::stage_path(&action_file, writer.id()),
        ];
        for orphan in &orphans {
            std::fs::write(orphan, b"[{\"id\":\"w1\"").unwrap();
        }

        upsert_at(&config, &entry("w1", "Intake")).unwrap();
        let action = serde_json::json!({"name": "Strip", "steps": [{"op": "strip_metadata"}]});
        freeze_action(&action_file, &action).unwrap();

        assert!(orphans.iter().all(|orphan| !orphan.exists()));
        assert_eq!(listed(&config), vec![("w1".to_string(), "Intake".to_string())]);
        let frozen: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&action_file).unwrap()).unwrap();
        assert_eq!(frozen, action);
    }

    #[test]
    fn saves_that_overlap_keep_every_folder() {
        let dir = tempfile::tempdir().unwrap();
        let path = Arc::new(dir.path().join(CONFIG_FILE));
        let savers: Vec<_> = (0..8)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for k in 0..4 {
                        upsert_at(&path, &entry(&format!("w{n}-{k}"), "Intake")).unwrap();
                    }
                })
            })
            .collect();
        for saver in savers {
            saver.join().unwrap();
        }
        let mut ids: Vec<String> = listed(&path).into_iter().map(|(id, _)| id).collect();
        ids.sort();
        let mut expected: Vec<String> = (0..8)
            .flat_map(|n| (0..4).map(move |k| format!("w{n}-{k}")))
            .collect();
        expected.sort();
        assert_eq!(ids, expected);
    }
}
