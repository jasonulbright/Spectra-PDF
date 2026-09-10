//! All-file publication for renderer page edits. Originals are backed up before
//! the first replacement; failed/uncertain publication can always be aborted by
//! its window-bound id. An abort also seals an id that has not arrived yet, so
//! a lost IPC reply cannot let a delayed publish run after recovery.
//!
//! Backups are retained until the renderer acknowledges its state update, or
//! confirms a restored abort. This is failure atomicity within the running app,
//! not a filesystem-wide transaction or application crash/session recovery.

use crate::file_publication::equal_files;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, WebviewWindow};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub working_path: String,
    pub staged_path: String,
    pub expected_working_sha256: Option<String>,
    pub expected_staged_sha256: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Committed,
    RolledBack,
    RecoveryRequired,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub status: Status,
    pub snapshots: Vec<String>,
    pub detail: String,
}

#[derive(Debug)]
struct Transaction {
    entries: Vec<Entry>,
    backups: Vec<PathBuf>,
    attempted: usize,
    reply: Reply,
}

type Key = (String, Uuid);

#[derive(Default)]
struct Transactions {
    live: HashMap<Key, Transaction>,
    // Sealed ids are small and retained for this process lifetime. Removing an
    // acknowledged/aborted id would let a delayed duplicate publish run again.
    sealed: HashSet<Key>,
}

#[derive(Clone, Default)]
pub struct PageCommitState(Arc<Mutex<Transactions>>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    BeforeSnapshot,
    AfterSnapshot,
    BeforeReplace,
    AfterReplace,
    BeforeRestore,
    AfterRestore,
}

fn backup(path: &Path) -> io::Result<PathBuf> {
    crate::file_publication::snapshot(path)
}

fn restore(source: &Path, destination: &Path) -> io::Result<()> {
    crate::file_publication::replace_copy(source, destination)
}

fn check_digest(path: &Path, expected: Option<&str>) -> io::Result<()> {
    let Some(expected) = expected else {
        return Ok(());
    };
    if expected.len() != 64
        || !expected
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(io::Error::other("invalid expected revision digest"));
    }
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != expected {
        return Err(io::Error::other(
            "file bytes no longer match the selected revision",
        ));
    }
    Ok(())
}

fn checked_path(root: &Path, value: &str) -> io::Result<PathBuf> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(io::Error::other("page commit requires absolute paths"));
    }
    // Canonical containment rejects junction escapes; reject reparse nodes as
    // well, including a symlink that happens to resolve inside the workspace.
    let canonical = dunce::canonicalize(path)?;
    if !canonical.starts_with(root) || !fs::metadata(&canonical)?.is_file() {
        return Err(io::Error::other(
            "page commit path is outside the working-copy tree",
        ));
    }
    for part in path.ancestors() {
        let meta = fs::symlink_metadata(part)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(io::Error::other("reparse path refused"));
            }
        }
        if meta.file_type().is_symlink() {
            return Err(io::Error::other("symlink path refused"));
        }
    }
    Ok(canonical)
}

fn validate(root: &Path, entries: &[Entry]) -> io::Result<()> {
    if entries.is_empty() {
        return Err(io::Error::other("empty page commit"));
    }
    let root = dunce::canonicalize(root)?;
    let mut paths: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let working = checked_path(&root, &entry.working_path)?;
        let staged = checked_path(&root, &entry.staged_path)?;
        if working.parent() != staged.parent() {
            return Err(io::Error::other("stage is not beside working file"));
        }
        for path in [working, staged] {
            for previous in &paths {
                if same_file::is_same_file(previous, &path)? {
                    return Err(io::Error::other("duplicate or aliased page commit path"));
                }
            }
            paths.push(path);
        }
    }
    Ok(())
}

impl Transaction {
    fn rollback(&mut self, hook: &mut impl FnMut(Phase, usize) -> io::Result<()>) {
        let mut failures = Vec::new();
        for i in 0..self.attempted {
            let result = (|| {
                hook(Phase::BeforeRestore, i)?;
                let destination = Path::new(&self.entries[i].working_path);
                if !equal_files(&self.backups[i], destination).unwrap_or(false) {
                    restore(&self.backups[i], destination)?;
                }
                hook(Phase::AfterRestore, i)
            })();
            if let Err(e) = result {
                failures.push(format!("{}: {e}", self.entries[i].working_path));
            }
        }
        if failures.is_empty() {
            self.attempted = 0;
            self.reply.status = Status::RolledBack;
        } else {
            self.reply.status = Status::RecoveryRequired;
            self.reply.detail = format!(
                "Originals retained; restoration required: {}",
                failures.join("; ")
            );
        }
    }
}

impl Transactions {
    fn publish(
        &mut self,
        key: Key,
        root: &Path,
        entries: Vec<Entry>,
        hook: &mut impl FnMut(Phase, usize) -> io::Result<()>,
    ) -> Reply {
        if let Some(tx) = self.live.get(&key) {
            // Repeated delivery never performs another publication.
            // A sealed id may still need recovery: retain that real status,
            // never turn a failed rollback into an apparent clean abort.
            return if tx.entries == entries {
                tx.reply.clone()
            } else {
                Reply {
                    status: Status::RecoveryRequired,
                    snapshots: vec![],
                    detail: "transaction id reused with different entries".into(),
                }
            };
        }
        if self.sealed.contains(&key) {
            return rolled_back("transaction id was sealed");
        }
        // Do not allow another transaction to touch paths still awaiting
        // acknowledgement/recovery. The renderer already serializes per window.
        if self.live.iter().any(|(owner, tx)| {
            owner.0 == key.0
                || tx.entries.iter().any(|old| {
                    entries.iter().any(|new| {
                        same_file::is_same_file(&old.working_path, &new.working_path)
                            .unwrap_or(true)
                    })
                })
        }) {
            self.sealed.insert(key);
            return rolled_back("another page commit still needs acknowledgement or recovery");
        }
        let mut tx = Transaction {
            entries,
            backups: vec![],
            attempted: 0,
            reply: rolled_back(""),
        };
        let result = (|| {
            validate(root, &tx.entries)?;
            for (i, entry) in tx.entries.iter().enumerate() {
                hook(Phase::BeforeSnapshot, i)?;
                tx.backups.push(backup(Path::new(&entry.working_path))?);
                hook(Phase::AfterSnapshot, i)?;
            }
            for (entry, snapshot) in tx.entries.iter().zip(&tx.backups) {
                check_digest(snapshot, entry.expected_working_sha256.as_deref())?;
                check_digest(
                    Path::new(&entry.staged_path),
                    entry.expected_staged_sha256.as_deref(),
                )?;
                if !equal_files(Path::new(&entry.working_path), snapshot)? {
                    return Err(io::Error::other(
                        "working copy changed while snapshots were prepared",
                    ));
                }
            }
            for (i, entry) in tx.entries.iter().enumerate() {
                // Include this destination BEFORE the call: an error after a
                // replacement is indistinguishable from an error before it.
                tx.attempted = i + 1;
                hook(Phase::BeforeReplace, i)?;
                fs::rename(&entry.staged_path, &entry.working_path)?;
                hook(Phase::AfterReplace, i)?;
            }
            Ok::<_, io::Error>(())
        })();
        match result {
            Ok(()) => tx.reply.status = Status::Committed,
            Err(e) => {
                tx.reply.detail = e.to_string();
                tx.rollback(hook);
            }
        }
        tx.reply.snapshots = tx
            .backups
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let reply = tx.reply.clone();
        self.live.insert(key, tx);
        reply
    }

    fn abort(&mut self, key: Key, hook: &mut impl FnMut(Phase, usize) -> io::Result<()>) -> Reply {
        // Install the fence even when publish has not arrived. The same mutex
        // orders an in-flight publisher ahead of this rollback.
        self.sealed.insert(key.clone());
        if let Some(tx) = self.live.get_mut(&key) {
            tx.rollback(hook);
            tx.reply.clone()
        } else {
            rolled_back("transaction did not publish")
        }
    }

    fn acknowledge(&mut self, key: Key) -> Result<(), String> {
        if self
            .live
            .get(&key)
            .is_some_and(|tx| tx.reply.status == Status::RecoveryRequired)
        {
            return Err("cannot discard originals while recovery is required".into());
        }
        self.sealed.insert(key.clone());
        if let Some(tx) = self.live.remove(&key) {
            // Committed backups belong to undo history now. Aborted ones have
            // served their purpose; cleanup failure may leave harmless copies.
            if tx.reply.status == Status::RolledBack {
                for path in tx.backups {
                    let _ = fs::remove_file(path);
                }
            }
        }
        Ok(())
    }
}

fn rolled_back(detail: &str) -> Reply {
    Reply {
        status: Status::RolledBack,
        snapshots: vec![],
        detail: detail.into(),
    }
}

fn key(window: &WebviewWindow, id: &str) -> Result<Key, String> {
    Ok((
        window.label().into(),
        Uuid::parse_str(id).map_err(|_| "invalid page commit id")?,
    ))
}

#[tauri::command]
pub async fn publish_page_commit(
    window: WebviewWindow,
    id: String,
    entries: Vec<Entry>,
) -> Result<Reply, String> {
    let key = key(&window, &id)?;
    let state = window.state::<PageCommitState>().inner().clone();
    let root = std::env::temp_dir().join("spectrapdf");
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = state
            .0
            .lock()
            .map_err(|_| "page transaction lock poisoned")?;
        Ok(state.publish(key, &root, entries, &mut |_, _| Ok(())))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn abort_page_commit(window: WebviewWindow, id: String) -> Result<Reply, String> {
    let key = key(&window, &id)?;
    let state = window.state::<PageCommitState>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut state = state
            .0
            .lock()
            .map_err(|_| "page transaction lock poisoned")?;
        Ok(state.abort(key, &mut |_, _| Ok(())))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn acknowledge_page_commit(window: WebviewWindow, id: String) -> Result<(), String> {
    let key = key(&window, &id)?;
    let state = window.state::<PageCommitState>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        state
            .0
            .lock()
            .map_err(|_| "page transaction lock poisoned")?
            .acknowledge(key)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Vec<Entry>) {
        let root = tempfile::tempdir().unwrap();
        let entries = (0..3)
            .map(|i| {
                let working = root.path().join(format!("{i}.pdf"));
                let staged = root.path().join(format!("{i}.staged"));
                fs::write(&working, format!("original {i}")).unwrap();
                fs::write(&staged, format!("changed {i}")).unwrap();
                Entry {
                    working_path: working.to_str().unwrap().into(),
                    staged_path: staged.to_str().unwrap().into(),
                    expected_working_sha256: None,
                    expected_staged_sha256: None,
                }
            })
            .collect();
        (root, entries)
    }

    fn key_for(owner: &str) -> Key {
        (owner.into(), Uuid::new_v4())
    }

    #[test]
    fn history_revision_hashes_bind_both_the_working_and_published_bytes() {
        for boundary in ["working", "staged", "malformed", "control"] {
            let (root, mut entries) = fixture();
            entries.truncate(1);
            let entry = &mut entries[0];
            entry.expected_working_sha256 = Some(format!("{:x}", Sha256::digest(b"original 0")));
            entry.expected_staged_sha256 = Some(format!("{:x}", Sha256::digest(b"changed 0")));
            match boundary {
                "working" => fs::write(&entry.working_path, b"another operation").unwrap(),
                "staged" => fs::write(&entry.staged_path, b"unvalidated bytes").unwrap(),
                "malformed" => entry.expected_working_sha256 = Some("bad digest".into()),
                _ => {}
            }
            let before = fs::read(&entries[0].working_path).unwrap();
            let mut state = Transactions::default();
            let id = key_for("window");
            let reply = state.publish(id.clone(), root.path(), entries.clone(), &mut |_, _| Ok(()));
            assert_eq!(
                reply.status,
                if boundary == "control" {
                    Status::Committed
                } else {
                    Status::RolledBack
                }
            );
            assert_eq!(
                fs::read(&entries[0].working_path).unwrap(),
                if boundary == "control" {
                    b"changed 0".to_vec()
                } else {
                    before
                }
            );
            state.acknowledge(id).unwrap();
        }
    }
    fn unchanged(entries: &[Entry]) {
        for (i, entry) in entries.iter().enumerate() {
            assert_eq!(
                fs::read_to_string(&entry.working_path).unwrap(),
                format!("original {i}")
            );
        }
    }

    #[test]
    fn every_snapshot_and_replace_failure_restores_all_originals() {
        for phase in [
            Phase::BeforeSnapshot,
            Phase::AfterSnapshot,
            Phase::BeforeReplace,
            Phase::AfterReplace,
        ] {
            for index in 0..3 {
                let (root, entries) = fixture();
                let mut state = Transactions::default();
                let key = key_for("main");
                let answer =
                    state.publish(key.clone(), root.path(), entries.clone(), &mut |p, i| {
                        if (p, i) == (phase, index) {
                            Err(io::Error::other("injected"))
                        } else {
                            Ok(())
                        }
                    });
                assert_eq!(
                    answer.status,
                    Status::RolledBack,
                    "{phase:?}/{index}: {answer:?}"
                );
                unchanged(&entries);
                state.acknowledge(key).unwrap();
            }
        }
    }

    #[test]
    fn rollback_failure_retains_originals_and_retry_restores_every_destination() {
        for phase in [Phase::BeforeRestore, Phase::AfterRestore] {
            for index in 0..3 {
                let (root, entries) = fixture();
                let mut state = Transactions::default();
                let key = key_for("main");
                let answer =
                    state.publish(key.clone(), root.path(), entries.clone(), &mut |p, i| {
                        if (p, i) == (Phase::AfterReplace, 2) || (p, i) == (phase, index) {
                            Err(io::Error::other("injected"))
                        } else {
                            Ok(())
                        }
                    });
                assert_eq!(answer.status, Status::RecoveryRequired);
                assert!(state.acknowledge(key.clone()).is_err());
                // Abort can itself fail and seals the id before doing so.
                assert_eq!(
                    state
                        .abort(key.clone(), &mut |_, _| Err(io::Error::other(
                            "still locked"
                        )))
                        .status,
                    Status::RecoveryRequired
                );
                assert_eq!(
                    state
                        .publish(
                            key.clone(),
                            root.path(),
                            entries.clone(),
                            &mut |_, _| panic!("replayed write")
                        )
                        .status,
                    Status::RecoveryRequired
                );
                for (i, path) in answer.snapshots.iter().enumerate() {
                    assert_eq!(fs::read_to_string(path).unwrap(), format!("original {i}"));
                }
                assert_eq!(
                    state.abort(key.clone(), &mut |_, _| Ok(())).status,
                    Status::RolledBack
                );
                unchanged(&entries);
                state.acknowledge(key).unwrap();
            }
        }
    }

    #[test]
    fn lost_success_reply_can_be_aborted_and_id_cannot_publish_again() {
        let (root, entries) = fixture();
        let mut state = Transactions::default();
        let key = key_for("main");
        assert_eq!(
            state
                .publish(
                    key.clone(),
                    root.path(),
                    entries.clone(),
                    &mut |_, _| Ok(())
                )
                .status,
            Status::Committed
        );
        assert_eq!(
            state.abort(key.clone(), &mut |_, _| Ok(())).status,
            Status::RolledBack
        );
        unchanged(&entries);
        state.acknowledge(key.clone()).unwrap();
        assert_eq!(
            state
                .publish(key, root.path(), entries.clone(), &mut |_, _| panic!(
                    "replayed write"
                ))
                .status,
            Status::RolledBack
        );
        unchanged(&entries);
    }

    #[test]
    fn abort_before_delayed_publish_seals_the_id() {
        let (root, entries) = fixture();
        let mut state = Transactions::default();
        let key = key_for("main");
        assert_eq!(
            state.abort(key.clone(), &mut |_, _| Ok(())).status,
            Status::RolledBack
        );
        state.acknowledge(key.clone()).unwrap();
        assert_eq!(
            state
                .publish(key, root.path(), entries.clone(), &mut |_, _| panic!(
                    "late write"
                ))
                .status,
            Status::RolledBack
        );
        unchanged(&entries);
    }

    #[test]
    fn success_has_original_snapshots_and_is_idempotent_until_acknowledged() {
        let (root, entries) = fixture();
        let mut state = Transactions::default();
        let key = key_for("main");
        let answer = state.publish(
            key.clone(),
            root.path(),
            entries.clone(),
            &mut |_, _| Ok(()),
        );
        assert_eq!(answer.status, Status::Committed, "{answer:?}");
        let duplicate = state.publish(key.clone(), root.path(), entries.clone(), &mut |_, _| {
            panic!("duplicate write")
        });
        assert_eq!(duplicate.snapshots, answer.snapshots);
        // A different window cannot cancel or acknowledge this window's id.
        let foreign = ("doc-other".into(), key.1);
        assert_eq!(
            state.abort(foreign.clone(), &mut |_, _| Ok(())).status,
            Status::RolledBack
        );
        state.acknowledge(foreign).unwrap();
        state.acknowledge(key).unwrap();
        for (i, (entry, snap)) in entries.iter().zip(answer.snapshots).enumerate() {
            assert_eq!(fs::read_to_string(snap).unwrap(), format!("original {i}"));
            assert_eq!(
                fs::read_to_string(&entry.working_path).unwrap(),
                format!("changed {i}")
            );
        }
    }

    #[test]
    fn original_drift_before_publication_never_overwrites_the_new_bytes() {
        let (root, entries) = fixture();
        let mut state = Transactions::default();
        let answer = state.publish(
            key_for("main"),
            root.path(),
            entries.clone(),
            &mut |phase, index| {
                if (phase, index) == (Phase::AfterSnapshot, 2) {
                    fs::write(&entries[0].working_path, b"external edit")?;
                }
                Ok(())
            },
        );
        assert_eq!(answer.status, Status::RolledBack);
        assert_eq!(
            fs::read(&entries[0].working_path).unwrap(),
            b"external edit"
        );
    }

    #[test]
    fn invalid_duplicate_alias_outside_and_missing_paths_cannot_publish() {
        for mode in [
            "duplicate",
            "alias",
            "outside",
            "missing",
            "self",
            "relative",
            "empty",
        ] {
            let (root, mut entries) = fixture();
            let outside = tempfile::tempdir().unwrap();
            let original = entries.clone();
            match mode {
                "duplicate" => entries.push(entries[0].clone()),
                "alias" => {
                    let path = root.path().join("alias");
                    fs::hard_link(&entries[0].working_path, &path).unwrap();
                    entries[1].working_path = path.to_str().unwrap().into();
                }
                "outside" => {
                    let p = outside.path().join("file");
                    fs::write(&p, b"outside").unwrap();
                    entries[0].working_path = p.to_str().unwrap().into();
                }
                "missing" => entries[0].staged_path.push_str("missing"),
                "self" => entries[0].staged_path = entries[0].working_path.clone(),
                "relative" => entries[0].working_path = "relative.pdf".into(),
                "empty" => entries.clear(),
                _ => unreachable!(),
            }
            let answer = Transactions::default().publish(
                key_for("main"),
                root.path(),
                entries,
                &mut |_, _| panic!("invalid request wrote bytes"),
            );
            assert_eq!(answer.status, Status::RolledBack, "{mode}");
            unchanged(&original);
        }
    }
}
