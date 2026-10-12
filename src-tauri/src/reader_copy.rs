//! Private byte copies of a working copy for the engine's long readers.
//!
//! A job-class call that reads a working copy for its whole run reads a copy
//! instead, so the working copy's shared lock is held only while the copy is
//! made. The copy is `<working folder>/r<pid>-<8 hex>/<same name>`:
//!
//! - The file name is the working copy's, so every value the engine derives
//!   from the base name is unchanged.
//! - The engine reads a certificate-opened document's grants from the
//!   recipient marker in the file's own folder. The working copy of such a
//!   document is plaintext, so a copy without the marker reads as
//!   unrestricted; the marker is copied with it.
//! - The reader folder inherits the working folder's access list, which is
//!   owner-only for a certificate-opened document.
//! - The folder name is short, and on Windows a copy whose path reaches
//!   `MAX_PATH` is refused: the engine, qpdf and Ghostscript open paths
//!   without the `\\?\` prefix, so a longer path reads as not found.
//! - A launch removes a stopped process's working folder with every reader
//!   folder in it.
//!
//! Each copy is recorded for the window that asked for it. Only that window
//! removes it; the window's destruction removes what is left once the
//! window's engine processes stop holding it.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};

use crate::file_publication::{equal_files, is_stage_name, source_guard};

/// A reader folder is `r<pid>-<8 hex>`.
const READER_PREFIX: &str = "r";
const READER_RANDOM: usize = 8;

/// `MAX_PATH` counts the terminator: an open without the `\\?\` prefix takes
/// a path of at most `MAX_PATH - 1` UTF-16 units.
#[cfg(windows)]
const MAX_PATH: usize = 260;

/// Whether `name` is a reader folder's name, as [`reader_folder_name`] spells it.
fn is_reader_folder(name: &str) -> bool {
    let Some((pid, random)) = name.strip_prefix(READER_PREFIX).and_then(|rest| rest.split_once('-')) else {
        return false;
    };
    random.len() == READER_RANDOM
        && random.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && crate::staging::decimal_pid(pid).is_some()
}

fn reader_folder_name(own: u32) -> String {
    let random = uuid::Uuid::new_v4().simple().to_string();
    format!("{READER_PREFIX}{own}-{}", &random[..READER_RANDOM])
}

#[cfg(windows)]
fn path_units(path: &Path) -> usize {
    path.to_string_lossy().encode_utf16().count()
}

/// Whether the reader copy or its marker would have a path the engine cannot
/// open.
#[cfg(windows)]
fn too_long(reader: &Path, name: &str, marked: bool) -> bool {
    path_units(&reader.join(name)) >= MAX_PATH - 1
        || (marked && path_units(&reader.join(RECIPIENT_MARKER)) >= MAX_PATH - 1)
}

#[cfg(not(windows))]
fn too_long(_reader: &Path, _name: &str, _marked: bool) -> bool {
    false
}

/// `engine/credentials.py` `RECIPIENT_MARKER`.
const RECIPIENT_MARKER: &str = "spectra-recipient.json";

/// `engine/pubkey_crypt.py` `RECIPIENT_SEALED`.
const RECIPIENT_SEALED: &str = "spectra-recipient.sealed";

/// How often a destroyed window's held copies are tried again.
const RETRY_POLL: Duration = Duration::from_millis(250);

/// Added to the engine's drain deadline for the retry bound. It exceeds the
/// grace the engine gives a cancelled write before the kill (`engine.rs`
/// `CANCEL_GRACE`), so the retry outlives every process that can hold a copy.
const KILL_MARGIN: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Records {
    by_window: HashMap<String, Vec<String>>,
    /// Labels are never reused: a copy finished after its window was
    /// destroyed is removed at once.
    closed: HashSet<String>,
}

/// The reader copies of each window, as the paths `create_reader_copy`
/// returned.
#[derive(Default)]
pub struct ReaderCopies(Mutex<Records>);

impl ReaderCopies {
    fn lock(&self) -> MutexGuard<'_, Records> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Record `copy` for `label`. A destroyed window's copy is removed at
    /// once instead, and refused.
    fn record(&self, label: &str, copy: String) -> Result<String, String> {
        let mut records = self.lock();
        if records.closed.contains(label) {
            drop(records);
            if let Err(error) = remove_copy(Path::new(&copy)) {
                eprintln!("[reader copy] a copy for a closed window stays until relaunch: {error}");
            }
            return Err("Failed to make a reader copy: the window is closed".into());
        }
        records.by_window.entry(label.to_string()).or_default().push(copy.clone());
        Ok(copy)
    }

    /// Remove `copy` when `label` recorded it. True when it is gone; false
    /// when the file system refused (a handle still holds it), which keeps
    /// the record for the window's destruction to try again.
    fn remove(&self, label: &str, copy: &str) -> Result<bool, String> {
        {
            let mut records = self.lock();
            let list = records.by_window.get_mut(label);
            let Some(list) = list.filter(|list| list.iter().any(|held| held == copy)) else {
                return Err("Failed to remove a reader copy: this window did not make it".into());
            };
            list.retain(|held| held != copy);
        }
        match remove_copy(Path::new(copy)) {
            Ok(()) => Ok(true),
            Err(error) => {
                eprintln!("[reader copy] removal deferred to the window's close: {error}");
                let mut records = self.lock();
                if records.closed.contains(label) {
                    drop(records);
                    retry_in_background(vec![PathBuf::from(copy)]);
                } else {
                    records.by_window.entry(label.to_string()).or_default().push(copy.to_string());
                }
                Ok(false)
            }
        }
    }

    /// Close `label` and remove its copies. Returns the ones a handle still
    /// holds.
    fn release_label(&self, label: &str) -> Vec<PathBuf> {
        let copies = {
            let mut records = self.lock();
            records.closed.insert(label.to_string());
            records.by_window.remove(label).unwrap_or_default()
        };
        copies
            .into_iter()
            .map(PathBuf::from)
            .filter(|copy| remove_copy(copy).is_err())
            .collect()
    }
}

/// Copy the working copy at `working_path` into a new reader folder beside
/// it. `root` is the temp tree the working folders of process `own` live in.
fn make_copy(root: &Path, own: u32, working_path: &Path) -> io::Result<PathBuf> {
    make_copy_probing(root, own, working_path, &|marker| marker.try_exists())
}

/// [`make_copy`], asking `marked` whether the working folder holds the
/// recipient marker. An error refuses the copy: a certificate-opened copy
/// made without its marker reads as unrestricted.
fn make_copy_probing(
    root: &Path,
    own: u32,
    working_path: &Path,
    marked: &dyn Fn(&Path) -> io::Result<bool>,
) -> io::Result<PathBuf> {
    let refused = || io::Error::new(io::ErrorKind::InvalidInput, "not a working copy of this process");
    let source = dunce::canonicalize(working_path)?;
    let name = source.file_name().and_then(|name| name.to_str()).ok_or_else(refused)?;
    if is_stage_name(name) || name == RECIPIENT_MARKER || name == RECIPIENT_SEALED {
        return Err(refused());
    }
    let folder = source.parent().ok_or_else(refused)?;
    if folder.file_name().and_then(|name| name.to_str()).is_some_and(is_reader_folder) {
        return Err(refused());
    }
    let owned = folder
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(crate::scratch::working_folder_owner)
        == Some(own);
    let in_root = folder
        .parent()
        .is_some_and(|parent| same_file::is_same_file(parent, root).unwrap_or(false));
    if !owned || !in_root {
        return Err(refused());
    }
    let reader = folder.join(reader_folder_name(own));
    let marker = folder.join(RECIPIENT_MARKER);
    let marked = marked(&marker)?;
    // A marker the engine cannot open reads as no marker: the plaintext copy
    // would be unrestricted.
    if too_long(&reader, name, marked) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "the reader copy's path would be too long"));
    }
    let started = Instant::now();
    let _guard = source_guard(&source)?;
    fs::create_dir(&reader)?;
    let made = fill(&marker, marked, &reader, &source, name);
    match &made {
        Ok(_) => eprintln!("[reader copy] made in {} ms", started.elapsed().as_millis()),
        Err(_) => {
            let _ = fs::remove_dir_all(&reader);
        }
    }
    made
}

/// The marker goes in first: the copy never exists without it.
///
/// The copy is written under its own name, with no stage: the reader folder
/// is new and private, and its path is returned only once the bytes are
/// verified. A stage's longer name would cross `MAX_PATH` below the copy's
/// own limit, and `tempfile`'s rename opens it without the long-path prefix.
fn fill(marker: &Path, marked: bool, reader: &Path, source: &Path, name: &str) -> io::Result<PathBuf> {
    if marked {
        fs::copy(marker, reader.join(RECIPIENT_MARKER))?;
    }
    let copy = reader.join(name);
    let count = fs::copy(source, &copy)?;
    if count != fs::metadata(source)?.len() || !equal_files(source, &copy)? {
        return Err(io::Error::other("copy verification failed"));
    }
    Ok(copy)
}

/// Remove the copy, then its folder. The copy goes first, so a copy a handle
/// still holds keeps its marker.
fn remove_copy(copy: &Path) -> io::Result<()> {
    let reader = copy
        .parent()
        .filter(|folder| folder.file_name().and_then(|n| n.to_str()).is_some_and(is_reader_folder))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a reader copy"))?;
    if let Ok(meta) = fs::symlink_metadata(copy) {
        let mut permissions = meta.permissions();
        if permissions.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            fs::set_permissions(copy, permissions)?;
        }
    }
    match fs::remove_file(copy) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    match fs::remove_dir_all(reader) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// Try `left` again every `poll` until every copy is gone or `deadline`
/// passes. Returns what is still there.
fn retry_until(mut left: Vec<PathBuf>, deadline: Instant, poll: Duration) -> Vec<PathBuf> {
    loop {
        left.retain(|copy| remove_copy(copy).is_err());
        let now = Instant::now();
        if left.is_empty() || now >= deadline {
            return left;
        }
        std::thread::sleep(poll.min(deadline - now));
    }
}

fn retry_in_background(left: Vec<PathBuf>) {
    let deadline = Instant::now() + crate::engine::engine_drain_deadline() + KILL_MARGIN;
    std::thread::spawn(move || {
        let kept = retry_until(left, deadline, RETRY_POLL);
        if !kept.is_empty() {
            eprintln!("[reader copy] {} copies stay until relaunch", kept.len());
        }
    });
}

/// Remove a destroyed window's reader copies. Runs after the window's engine
/// processes are retired: a copy one of them still reads is tried again until
/// the engine has stopped them.
pub fn on_window_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(copies) = app.try_state::<ReaderCopies>() else {
        return;
    };
    let left = copies.release_label(label);
    if !left.is_empty() {
        retry_in_background(left);
    }
}

#[tauri::command]
pub async fn create_reader_copy(
    app: AppHandle,
    window: tauri::WebviewWindow,
    working_path: String,
) -> Result<String, String> {
    let copy = tauri::async_runtime::spawn_blocking(move || {
        make_copy(&crate::scratch::root(), std::process::id(), Path::new(&working_path))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Failed to make a reader copy: {e}"))?;
    app.state::<ReaderCopies>()
        .record(window.label(), copy.to_string_lossy().into_owned())
}

/// True when the copy is gone; false when a handle still holds it and the
/// window's close removes it.
#[tauri::command]
pub async fn remove_reader_copy(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<bool, String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || app.state::<ReaderCopies>().remove(&label, &path))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn names(dir: &Path) -> BTreeSet<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect()
    }

    /// A temp tree with one working folder of `owner` holding `name`.
    fn working(root: &Path, owner: u32, name: &str, bytes: &[u8]) -> PathBuf {
        let folder = root.join(crate::scratch::working_folder_name(owner));
        fs::create_dir(&folder).unwrap();
        let path = folder.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn reader_folders(folder: &Path) -> Vec<String> {
        names(folder).into_iter().filter(|n| is_reader_folder(n)).collect()
    }

    #[test]
    fn a_copy_lands_byte_equal_under_the_same_name_in_a_reader_folder() {
        let root = tempfile::tempdir().unwrap();
        let own = std::process::id();
        let bytes: Vec<u8> = (0..200_000u32).map(|n| (n % 251) as u8).collect();
        let work = working(root.path(), own, "Quarterly report.pdf", &bytes);

        let copy = make_copy(root.path(), own, &work).unwrap();

        assert_eq!(copy.file_name(), work.file_name());
        let reader = copy.parent().unwrap();
        let folder_name = reader.file_name().unwrap().to_str().unwrap();
        let random = folder_name.strip_prefix(&format!("r{own}-")).unwrap();
        assert_eq!(random.len(), 8, "{folder_name}");
        assert!(random.bytes().all(|b| b.is_ascii_hexdigit()), "{folder_name}");
        assert!(same_file::is_same_file(reader.parent().unwrap(), work.parent().unwrap()).unwrap());
        assert_eq!(fs::read(&copy).unwrap(), bytes);
        assert_eq!(names(reader), BTreeSet::from(["Quarterly report.pdf".to_string()]));

        let second = make_copy(root.path(), own, &work).unwrap();
        assert_ne!(second.parent(), copy.parent());
        assert_eq!(reader_folders(work.parent().unwrap()).len(), 2);
    }

    /// The engine opens paths without the long-path prefix: a copy it cannot
    /// open is refused so the caller reads the working copy instead.
    #[cfg(windows)]
    #[test]
    fn a_copy_whose_path_would_reach_max_path_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let own = std::process::id();
        let name = "doc.pdf";
        let below_root = 1
            + crate::scratch::working_folder_name(own).len()
            + 1
            + reader_folder_name(own).len()
            + 1
            + name.len();
        for (length, accepted) in [(MAX_PATH - 2, true), (MAX_PATH - 1, false)] {
            let root = base.join("a".repeat(length - path_units(&base) - 1 - below_root));
            fs::create_dir(&root).unwrap();
            let work = working(&root, own, name, b"%PDF");
            assert!(path_units(&work) < MAX_PATH - 1);

            let made = make_copy(&root, own, &work);

            if accepted {
                assert_eq!(path_units(&made.unwrap()), length);
                assert_eq!(reader_folders(work.parent().unwrap()).len(), 1);
            } else {
                assert_eq!(made.unwrap_err().kind(), io::ErrorKind::InvalidInput);
                assert!(reader_folders(work.parent().unwrap()).is_empty());
            }
        }
    }

    /// A short document name puts the marker's path past the copy's: a marker
    /// the engine cannot open would leave the copy unrestricted.
    #[cfg(windows)]
    #[test]
    fn a_copy_whose_marker_path_would_reach_max_path_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let own = std::process::id();
        let name = "a.pdf";
        let below_root = 1
            + crate::scratch::working_folder_name(own).len()
            + 1
            + reader_folder_name(own).len()
            + 1
            + RECIPIENT_MARKER.len();
        let root = base.join("a".repeat(MAX_PATH - 1 - path_units(&base) - 1 - below_root));
        fs::create_dir(&root).unwrap();
        let work = working(&root, own, name, b"%PDF");

        let unmarked = make_copy(&root, own, &work).unwrap();
        assert!(path_units(&unmarked) < MAX_PATH - 1);
        assert_eq!(path_units(&unmarked.parent().unwrap().join(RECIPIENT_MARKER)), MAX_PATH - 1);

        fs::write(work.parent().unwrap().join(RECIPIENT_MARKER), b"{}").unwrap();
        let refused = make_copy(&root, own, &work).unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(reader_folders(work.parent().unwrap()).len(), 1, "only the unmarked copy exists");
    }

    /// A marker whose presence cannot be read refuses the copy rather than
    /// leave a certificate-opened copy without its grants.
    #[test]
    fn a_marker_that_cannot_be_probed_refuses_the_copy() {
        let root = tempfile::tempdir().unwrap();
        let own = std::process::id();
        let work = working(root.path(), own, "doc.pdf", b"%PDF plaintext");
        fs::write(work.parent().unwrap().join(RECIPIENT_MARKER), b"{}").unwrap();

        let refused = make_copy_probing(root.path(), own, &work, &|_| {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "access denied"))
        })
        .unwrap_err();

        assert_eq!(refused.kind(), io::ErrorKind::PermissionDenied);
        assert!(reader_folders(work.parent().unwrap()).is_empty());
        let copy = make_copy_probing(root.path(), own, &work, &|marker| marker.try_exists()).unwrap();
        assert!(copy.parent().unwrap().join(RECIPIENT_MARKER).exists());
    }

    #[test]
    fn a_reader_folder_name_is_exact() {
        let own = std::process::id();
        assert!(is_reader_folder(&reader_folder_name(own)));
        assert!(is_reader_folder("r4100-0123abcd"));
        for other in [
            "r4100-0123ABCD",
            "r4100-0123abc",
            "r4100-0123abcde",
            "r04100-0123abcd",
            "rx-0123abcd",
            "r-0123abcd",
            "reader-4100-0123abcd",
            "R4100-0123abcd",
            "r4100_0123abcd",
        ] {
            assert!(!is_reader_folder(other), "{other}");
        }
    }

    #[test]
    fn only_a_working_copy_of_this_process_is_copied() {
        let root = tempfile::tempdir().unwrap();
        let own = std::process::id();
        let work = working(root.path(), own, "doc.pdf", b"%PDF-1.7 working");
        let folder = work.parent().unwrap().to_path_buf();
        let other_process = working(root.path(), own.wrapping_add(1).max(1), "doc.pdf", b"%PDF other");
        let elsewhere = tempfile::tempdir().unwrap();
        let outside = elsewhere.path().join("doc.pdf");
        fs::write(&outside, b"%PDF a user's file").unwrap();
        let at_root = root.path().join("doc.pdf");
        fs::write(&at_root, b"%PDF").unwrap();
        let other_root = tempfile::tempdir().unwrap();
        let other_tree = working(other_root.path(), own, "doc.pdf", b"%PDF");
        let stage = crate::file_publication::snapshot(&work).unwrap();
        let legacy_stage = folder.join("document-stage-abc123.pdf");
        fs::write(&legacy_stage, b"%PDF").unwrap();
        let marker = folder.join(RECIPIENT_MARKER);
        fs::write(&marker, b"{}").unwrap();
        let sealed = folder.join(RECIPIENT_SEALED);
        fs::write(&sealed, b"%PDF sealed").unwrap();
        let reader_copy = make_copy(root.path(), own, &work).unwrap();
        let before = names(&folder);

        for refused in [
            &other_process,
            &outside,
            &at_root,
            &other_tree,
            &stage,
            &legacy_stage,
            &marker,
            &sealed,
            &reader_copy,
            &folder,
            &folder.join("missing.pdf"),
        ] {
            assert!(make_copy(root.path(), own, refused).is_err(), "{}", refused.display());
        }

        assert_eq!(names(&folder), before);
        assert!(reader_folders(other_process.parent().unwrap()).is_empty());
        assert!(reader_folders(other_tree.parent().unwrap()).is_empty());
        assert_eq!(names(elsewhere.path()), BTreeSet::from(["doc.pdf".to_string()]));
    }

    #[test]
    fn the_recipient_marker_is_copied_only_when_present() {
        let root = tempfile::tempdir().unwrap();
        let own = std::process::id();
        let plain = working(root.path(), own, "plain.pdf", b"%PDF plain");
        let marked = working(root.path(), own, "marked.pdf", b"%PDF marked");
        let record = br#"{"permissions": {"print": true}, "p": -3900}"#;
        fs::write(marked.parent().unwrap().join(RECIPIENT_MARKER), record).unwrap();

        let plain_copy = make_copy(root.path(), own, &plain).unwrap();
        let marked_copy = make_copy(root.path(), own, &marked).unwrap();

        assert_eq!(names(plain_copy.parent().unwrap()), BTreeSet::from(["plain.pdf".to_string()]));
        assert_eq!(
            names(marked_copy.parent().unwrap()),
            BTreeSet::from(["marked.pdf".to_string(), RECIPIENT_MARKER.to_string()])
        );
        assert_eq!(fs::read(marked_copy.parent().unwrap().join(RECIPIENT_MARKER)).unwrap(), record);
    }

    #[test]
    fn a_read_only_working_copy_gives_a_copy_that_still_removes() {
        let root = tempfile::tempdir().unwrap();
        let own = std::process::id();
        let work = working(root.path(), own, "doc.pdf", b"%PDF read-only");
        let mut permissions = fs::metadata(&work).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&work, permissions).unwrap();
        let copies = ReaderCopies::default();
        let copy = copies.record("main", make_copy(root.path(), own, &work).unwrap().to_string_lossy().into_owned()).unwrap();

        assert_eq!(copies.remove("main", &copy), Ok(true));
        assert!(reader_folders(work.parent().unwrap()).is_empty());
    }

    #[test]
    fn only_the_window_that_made_a_copy_removes_it() {
        let root = tempfile::tempdir().unwrap();
        let own = std::process::id();
        let work = working(root.path(), own, "doc.pdf", b"%PDF");
        let copies = ReaderCopies::default();
        let copy = copies.record("main", make_copy(root.path(), own, &work).unwrap().to_string_lossy().into_owned()).unwrap();

        assert!(copies.remove("doc-1", &copy).is_err());
        assert!(Path::new(&copy).exists());
        assert!(copies.remove("main", &work.to_string_lossy()).is_err());
        assert!(work.exists());

        assert_eq!(copies.remove("main", &copy), Ok(true));
        assert!(!Path::new(&copy).exists());
        assert!(copies.remove("main", &copy).is_err(), "a removed copy is no longer recorded");
        assert_eq!(names(work.parent().unwrap()), BTreeSet::from(["doc.pdf".to_string()]));
    }

    /// A copy the window's job process still reads cannot be removed before
    /// the engine retires that process.
    #[test]
    fn the_destroy_hook_runs_after_the_engine_retires_the_window() {
        let source = include_str!("app_windows.rs");
        let start = source.find("pub fn on_window_destroyed(").expect("the destroy hook");
        let end = start + source[start..].find("\n}").expect("the end of the destroy hook");
        let body = &source[start..end];
        let retired = body.find("crate::engine::retire_window(app, label);").expect("the engine retirement");
        let removed = body.find("crate::reader_copy::on_window_destroyed(app, label);").expect("the reader-copy sweep");
        assert!(retired < removed);
    }

    #[test]
    fn a_window_destroyed_removes_its_copies_and_refuses_later_ones() {
        let root = tempfile::tempdir().unwrap();
        let own = std::process::id();
        let work = working(root.path(), own, "doc.pdf", b"%PDF");
        let copies = ReaderCopies::default();
        let mine = copies.record("doc-1", make_copy(root.path(), own, &work).unwrap().to_string_lossy().into_owned()).unwrap();
        let theirs = copies.record("main", make_copy(root.path(), own, &work).unwrap().to_string_lossy().into_owned()).unwrap();

        assert!(copies.release_label("doc-1").is_empty());

        assert!(!Path::new(&mine).exists());
        assert!(Path::new(&theirs).exists());
        let late = make_copy(root.path(), own, &work).unwrap();
        assert!(copies.record("doc-1", late.to_string_lossy().into_owned()).is_err());
        assert!(!late.exists());
        assert_eq!(reader_folders(work.parent().unwrap()).len(), 1);
    }

    /// A process reading the copy holds it without delete sharing, as the
    /// engine does: removal waits for the handle to close.
    #[cfg(windows)]
    #[test]
    fn a_held_copy_fails_removal_quietly_and_goes_with_the_window() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        let own = std::process::id();
        let work = working(root.path(), own, "doc.pdf", b"%PDF held");
        fs::write(work.parent().unwrap().join(RECIPIENT_MARKER), b"{}").unwrap();
        let copies = ReaderCopies::default();
        let copy = copies.record("doc-2", make_copy(root.path(), own, &work).unwrap().to_string_lossy().into_owned()).unwrap();
        let reader = Path::new(&copy).parent().unwrap().to_path_buf();
        let held = fs::OpenOptions::new().read(true).share_mode(1).open(&copy).unwrap();

        assert_eq!(copies.remove("doc-2", &copy), Ok(false));
        assert!(Path::new(&copy).exists());
        assert!(reader.join(RECIPIENT_MARKER).exists(), "a held copy keeps its marker");
        assert_eq!(copies.remove("doc-2", &copy), Ok(false), "the record is kept");

        let left = copies.release_label("doc-2");
        assert_eq!(left, vec![PathBuf::from(&copy)]);
        assert!(Path::new(&copy).exists());

        let retry = std::thread::spawn(move || {
            retry_until(left, Instant::now() + Duration::from_secs(30), Duration::from_millis(10))
        });
        std::thread::sleep(Duration::from_millis(100));
        drop(held);
        assert!(retry.join().unwrap().is_empty());
        assert!(!reader.exists());
        assert_eq!(names(work.parent().unwrap()), BTreeSet::from(["doc.pdf".to_string(), RECIPIENT_MARKER.to_string()]));
    }

    #[cfg(windows)]
    fn wide(path: &Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// The DACL of `path` in SDDL form.
    #[cfg(windows)]
    fn dacl(path: &Path) -> String {
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
        use windows::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW, SDDL_REVISION_1,
            SE_FILE_OBJECT,
        };
        use windows::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};
        let path = wide(path);
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let status = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                None,
                None,
                &mut sd,
            )
        };
        assert_eq!(status, ERROR_SUCCESS);
        let mut text = PWSTR::null();
        unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                sd,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                None,
            )
        }
        .unwrap();
        let sddl = unsafe { text.to_string() }.unwrap();
        unsafe {
            let _ = LocalFree(Some(HLOCAL(text.0.cast())));
            let _ = LocalFree(Some(HLOCAL(sd.0)));
        }
        sddl
    }

    /// The control flags and the entries of an SDDL DACL.
    #[cfg(windows)]
    fn aces(sddl: &str) -> (String, Vec<String>) {
        let body = sddl.strip_prefix("D:").unwrap_or_else(|| panic!("{sddl}"));
        let (flags, entries) = body.split_once('(').unwrap_or((body, ""));
        let entries = entries
            .split('(')
            .map(|entry| entry.trim_end_matches(')').to_string())
            .filter(|entry| !entry.is_empty())
            .collect();
        (flags.to_string(), entries)
    }

    /// The protected owner-only DACL `engine/credentials.py`
    /// `restrict_to_owner` gives a certificate-opened working folder.
    #[cfg(windows)]
    fn restrict_to_owner(folder: &Path, sid: &str) {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
        use windows::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SDDL_REVISION_1,
            SE_FILE_OBJECT,
        };
        use windows::Win32::Security::{
            GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
            PSECURITY_DESCRIPTOR,
        };
        let sddl: Vec<u16> = format!("O:{sid}D:P(A;OICI;FA;;;{sid})").encode_utf16().chain(Some(0)).collect();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .unwrap();
        let mut present = windows::core::BOOL::default();
        let mut defaulted = windows::core::BOOL::default();
        let mut acl: *mut ACL = std::ptr::null_mut();
        unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted) }.unwrap();
        let path = wide(folder);
        let status = unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(acl),
                None,
            )
        };
        unsafe {
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        }
        assert_eq!(status, ERROR_SUCCESS);
    }

    #[cfg(windows)]
    #[test]
    fn a_reader_folder_under_a_restricted_working_folder_is_owner_only() {
        let root = tempfile::tempdir().unwrap();
        let own = std::process::id();
        let sid = crate::scheduler::current_user_sid().expect("this process has a user SID");
        let work = working(root.path(), own, "doc.pdf", b"%PDF plaintext");
        let folder = work.parent().unwrap();
        fs::write(folder.join(RECIPIENT_MARKER), b"{}").unwrap();
        restrict_to_owner(folder, &sid);
        let (flags, entries) = aces(&dacl(folder));
        assert!(flags.contains('P'), "{flags}");
        assert_eq!(entries, vec![format!("A;OICI;FA;;;{sid}")]);

        let copy = make_copy(root.path(), own, &work).unwrap();

        let reader = copy.parent().unwrap();
        assert_eq!(aces(&dacl(reader)).1, vec![format!("A;OICIID;FA;;;{sid}")]);
        for file in [copy.clone(), reader.join(RECIPIENT_MARKER)] {
            assert_eq!(aces(&dacl(&file)).1, vec![format!("A;ID;FA;;;{sid}")], "{}", file.display());
        }
    }
}
