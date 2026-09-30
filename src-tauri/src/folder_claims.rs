//! Folder writer leases shared by installed, portable and scheduled processes.
//! The registry mutex serializes multi-root claims; each lease's open handle
//! outlives that mutex and is released by the OS even after a process crash.

#[cfg(any(windows, target_os = "linux"))]
use std::fs::{File, OpenOptions};
use std::io;
#[cfg(any(windows, target_os = "linux"))]
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
#[cfg(any(windows, target_os = "linux"))]
use std::time::{Duration, Instant};

#[cfg(any(windows, target_os = "linux"))]
use serde::{Deserialize, Serialize};

#[cfg(windows)]
#[derive(Debug)]
pub struct FolderLease {
    _handle: File,
}

#[cfg(windows)]
fn lease_handle(file: File) -> File {
    file
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
pub struct FolderLease {
    _handle: std::sync::Arc<LockedRecord>,
}

/// The record's open file description, unlocked explicitly when the last
/// in-process holder goes. A child forked concurrently holds a copy of every
/// descriptor until its `exec`; without the explicit unlock that copy would
/// keep a released lease locked for that interval. A crash runs no `Drop`, so
/// the worker's in-flight copy still holds the lock then.
#[cfg(target_os = "linux")]
#[derive(Debug)]
struct LockedRecord(File);

#[cfg(target_os = "linux")]
impl Drop for LockedRecord {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(target_os = "linux")]
fn lease_handle(file: File) -> std::sync::Arc<LockedRecord> {
    std::sync::Arc::new(LockedRecord(file))
}

#[cfg(windows)]
/// The worker holds the same OS lease while it can still write. A parent's
/// crash may close its own lease before the job has terminated its children.
pub struct WorkerLease {
    process: usize,
    handle: usize,
}

#[cfg(windows)]
impl FolderLease {
    pub fn retain_in_worker(&self, pid: u32) -> Result<WorkerLease, String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{
            CloseHandle, DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE,
        };
        use windows::Win32::System::Threading::{
            GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE,
        };
        unsafe {
            let process = OpenProcess(PROCESS_DUP_HANDLE, false, pid).map_err(|e| e.to_string())?;
            let mut remote = HANDLE::default();
            let result = DuplicateHandle(
                GetCurrentProcess(),
                HANDLE(self._handle.as_raw_handle()),
                process,
                &mut remote,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            );
            if let Err(error) = result {
                let _ = CloseHandle(process);
                return Err(error.to_string());
            }
            Ok(WorkerLease {
                process: process.0 as usize,
                handle: remote.0 as usize,
            })
        }
    }
}

#[cfg(windows)]
impl Drop for WorkerLease {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{
            CloseHandle, DuplicateHandle, DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS, HANDLE,
        };
        use windows::Win32::System::Threading::GetCurrentProcess;
        unsafe {
            let process = HANDLE(self.process as *mut _);
            let mut local = HANDLE::default();
            // A dead worker has already closed its handle. The retained
            // process handle prevents PID reuse from naming another worker.
            if DuplicateHandle(
                process,
                HANDLE(self.handle as *mut _),
                GetCurrentProcess(),
                &mut local,
                0,
                false,
                DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS,
            )
            .is_ok()
            {
                let _ = CloseHandle(local);
            }
            let _ = CloseHandle(process);
        }
    }
}

#[derive(Debug)]
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub enum ClaimError {
    Busy(String),
    Unavailable(String),
}

impl From<io::Error> for ClaimError {
    fn from(error: io::Error) -> Self {
        Self::Unavailable(format!("Folder ownership could not be checked: {error}"))
    }
}

#[cfg(any(windows, target_os = "linux"))]
#[derive(Serialize, Deserialize)]
struct Record {
    roots: Vec<String>,
}

#[cfg(any(windows, target_os = "linux"))]
const MAX_LIVE_RECORDS: usize = 4096;
#[cfg(any(windows, target_os = "linux"))]
const MAX_REGISTRY_ENTRIES: usize = MAX_LIVE_RECORDS + 1; // plus registry.lock

#[cfg(windows)]
pub fn registry_path() -> Result<PathBuf, ClaimError> {
    // Task Scheduler can run under another account. ProgramData supplies one
    // machine-wide location; its default inherited Users permissions allow
    // directory creation and reading records written by another account.
    let base = std::env::var_os("ProgramData").ok_or_else(|| {
        ClaimError::Unavailable("The shared application data folder is unavailable.".into())
    })?;
    Ok(PathBuf::from(base)
        .join("Spectra PDF")
        .join("folder-claims"))
}

#[cfg(windows)]
fn exclusive(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    // Only READ access is needed to acquire an exclusive OS sharing lease.
    // Another account can read a ProgramData file it did not create.
    OpenOptions::new().read(true).share_mode(0).open(path)
}

#[cfg(windows)]
fn live_record(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    // Readers may inspect the record; nobody may replace, delete or write it
    // while this run (or its worker's duplicate handle) remains alive. The OS
    // deletes it when the final handle closes, including after a crash, so a
    // later account never needs deletion rights on someone else's stale file.
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .access_mode(0x8000_0000 | 0x4000_0000 | 0x0001_0000)
        .share_mode(1)
        .custom_flags(0x0400_0000)
        .open(path)
}

#[cfg(windows)]
fn sharing_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(32 | 33))
}

#[cfg(any(windows, target_os = "linux"))]
fn registry_lock(path: &Path) -> Result<File, ClaimError> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => drop(file),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match exclusive(path) {
            Ok(handle) => return Ok(handle),
            Err(error) if sharing_error(&error) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.into()),
        }
    }
}

/// Resolve an existing ancestor too: destinations need not exist yet.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub fn normalized_root(path: &str) -> Result<PathBuf, ClaimError> {
    let raw = Path::new(path);
    if !raw.is_absolute() {
        return Err(ClaimError::Unavailable(
            "A folder claim needs an absolute path.".into(),
        ));
    }
    let mut clean = PathBuf::new();
    for part in raw.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other.as_os_str()),
        }
    }
    for ancestor in clean.ancestors() {
        if let Ok(canonical) = dunce::canonicalize(ancestor) {
            return Ok(canonical.join(clean.strip_prefix(ancestor).unwrap()));
        }
    }
    Err(ClaimError::Unavailable(format!(
        "The folder cannot be resolved: {}",
        clean.display()
    )))
}

#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn prefix(a: &str, b: &str) -> bool {
    a == b
        || b.strip_prefix(a)
            .is_some_and(|rest| rest.starts_with(['\\', '/']))
}

#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub fn roots_conflict(a: &Path, b: &Path) -> bool {
    let fold = |p: &Path| {
        p.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    let (left, right) = (fold(a), fold(b));
    if prefix(&left, &right) || prefix(&right, &left) {
        return true;
    }
    // A mapped drive, UNC name or directory alias can spell the same physical
    // ancestor differently. Compare suffixes only after proving that identity.
    for aa in a.ancestors() {
        if !aa.exists() {
            continue;
        }
        for bb in b.ancestors() {
            if same_file::is_same_file(aa, bb).unwrap_or(false) {
                let ar = fold(a.strip_prefix(aa).unwrap());
                let br = fold(b.strip_prefix(bb).unwrap());
                return ar.is_empty() || br.is_empty() || prefix(&ar, &br) || prefix(&br, &ar);
            }
        }
    }
    false
}


/// A lease the worker holds through its lease channel
/// (`process_job::LEASE_FD_ENV`). A parent's crash closes this process's
/// copies; the worker's in-flight copy keeps the same open file description,
/// and therefore its `flock`, until the worker exits.
#[cfg(target_os = "linux")]
pub struct WorkerLease {
    carrier: std::sync::Arc<crate::process_job::LeaseCarrier>,
    id: u64,
    _record: std::sync::Arc<LockedRecord>,
}

#[cfg(target_os = "linux")]
impl FolderLease {
    pub fn retain_in_worker(&self, pid: u32) -> Result<WorkerLease, String> {
        use std::os::fd::AsFd;
        let carrier = crate::process_job::lease_carrier(pid)
            .ok_or_else(|| "The worker process has no folder lease channel.".to_string())?;
        let id = carrier
            .hold(self._handle.0.as_fd())
            .map_err(|error| format!("The folder lease could not be shared with the worker: {error}"))?;
        Ok(WorkerLease {
            carrier,
            id,
            _record: self._handle.clone(),
        })
    }
}

#[cfg(target_os = "linux")]
impl Drop for WorkerLease {
    fn drop(&mut self) {
        self.carrier.release(self.id);
    }
}

/// Per user: no scheduled run under another account exists here. The runtime
/// directory is the per-login tmpfs the XDG base directory specification
/// defines for exactly this kind of lock file; the state directory is its
/// persistent stand-in when a session has none.
#[cfg(target_os = "linux")]
pub fn registry_path() -> Result<PathBuf, ClaimError> {
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(crate::portable::xdg_state_home)
        .ok_or_else(|| {
            ClaimError::Unavailable("The per-user state folder is unavailable.".into())
        })?;
    Ok(base.join("spectrapdf").join("folder-claims"))
}

#[cfg(target_os = "linux")]
fn try_flock(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// The lock lives on the open file description, so every descriptor that
/// shares it (a `dup`, an in-flight `SCM_RIGHTS` copy) holds it, and it is
/// released only when the last of them closes.
#[cfg(target_os = "linux")]
fn exclusive(path: &Path) -> io::Result<File> {
    let file = File::open(path)?;
    try_flock(&file)?;
    Ok(file)
}

/// Linux has no delete-on-close: a finished run's record stays until the next
/// claim finds its lock free and removes it under the registry mutex.
/// Read-only mode stops another account, not this user, from rewriting it.
#[cfg(target_os = "linux")]
fn live_record(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o444)
        .open(path)?;
    try_flock(&file)?;
    Ok(file)
}

#[cfg(target_os = "linux")]
fn sharing_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
}

#[cfg(any(windows, target_os = "linux"))]
pub fn claim(roots: &[String]) -> Result<FolderLease, ClaimError> {
    claim_in(&registry_path()?, roots)
}

#[cfg(any(windows, target_os = "linux"))]
pub fn claim_in(registry: &Path, roots: &[String]) -> Result<FolderLease, ClaimError> {
    if roots.len() > 64 {
        return Err(ClaimError::Unavailable(
            "Too many folders were requested in one run.".into(),
        ));
    }
    let wanted = roots
        .iter()
        .map(|root| normalized_root(root))
        .collect::<Result<Vec<_>, _>>()?;
    std::fs::create_dir_all(registry)?;
    let _mutex = registry_lock(&registry.join("registry.lock"))?;
    let mut entry_count = 0;
    let mut record_count = 0;
    for entry in std::fs::read_dir(registry)? {
        let path = entry?.path();
        entry_count += 1;
        if entry_count > MAX_REGISTRY_ENTRIES {
            return Err(ClaimError::Unavailable(
                "The folder ownership registry has too many entries.".into(),
            ));
        }
        if path.extension().map_or(true, |ext| ext != "json") {
            continue;
        }
        record_count += 1;
        if record_count > MAX_LIVE_RECORDS {
            return Err(ClaimError::Unavailable(
                "The folder ownership registry has too many live records.".into(),
            ));
        }
        match exclusive(&path) {
            Ok(handle) => {
                // No run holds this record. New records disappear on close;
                // an abandoned file from an interrupted older build is inert.
                drop(handle);
                let _ = std::fs::remove_file(&path);
                continue;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) if sharing_error(&error) => {}
            Err(error) => return Err(error.into()),
        }
        let mut bytes = Vec::new();
        let reader = match File::open(&path) {
            Ok(reader) => reader,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        reader.take(64 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 64 * 1024 {
            return Err(ClaimError::Unavailable(
                "A folder ownership record is too large.".into(),
            ));
        }
        let record: Record = serde_json::from_slice(&bytes).map_err(|e| {
            ClaimError::Unavailable(format!("A folder ownership record cannot be read: {e}"))
        })?;
        if record.roots.len() > 64 {
            return Err(ClaimError::Unavailable(
                "A folder ownership record contains too many folders.".into(),
            ));
        }
        for root in &wanted {
            if record
                .roots
                .iter()
                .any(|held| roots_conflict(root, Path::new(held)))
            {
                return Err(ClaimError::Busy(root.to_string_lossy().into_owned()));
            }
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let record = Record {
        roots: wanted
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    };
    let bytes = serde_json::to_vec(&record).map_err(|e| ClaimError::Unavailable(e.to_string()))?;
    let mut file = live_record(&registry.join(format!("{id}.json")))?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(FolderLease {
        _handle: lease_handle(file),
    })
}

/// No lease backend exists here yet: nothing can hold a lease, so every claim
/// refuses by name and a folder tool never runs unprotected.
#[cfg(not(any(windows, target_os = "linux")))]
mod unsupported {
    use std::path::Path;

    use super::ClaimError;
    use crate::platform::{feature, Unsupported};

    /// Uninhabited: no lease can be taken.
    #[derive(Debug)]
    pub enum FolderLease {}

    /// Uninhabited: no lease can be retained.
    pub enum WorkerLease {}

    impl FolderLease {
        pub fn retain_in_worker(&self, _pid: u32) -> Result<WorkerLease, String> {
            match *self {}
        }
    }

    fn refusal() -> ClaimError {
        ClaimError::Unavailable(Unsupported::new(feature::FOLDER_LEASES).to_string())
    }

    pub fn claim(_roots: &[String]) -> Result<FolderLease, ClaimError> {
        Err(refusal())
    }

    pub fn claim_in(_registry: &Path, _roots: &[String]) -> Result<FolderLease, ClaimError> {
        Err(refusal())
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
pub use unsupported::{claim, claim_in, FolderLease, WorkerLease};

#[cfg(all(test, any(windows, target_os = "linux")))]
mod tests {
    use super::*;

    #[test]
    fn all_folders_are_claimed_together_and_released_by_the_handle() {
        let scratch = tempfile::tempdir().unwrap();
        let registry = scratch.path().join("claims");
        let a = scratch.path().join("out");
        let b = scratch.path().join("other");
        let strings = |paths: &[&Path]| {
            paths
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let first = claim_in(&registry, &strings(&[&a])).unwrap();
        assert!(matches!(
            claim_in(&registry, &strings(&[&b, &a.join("child")])),
            Err(ClaimError::Busy(_))
        ));
        let other = claim_in(&registry, &strings(&[&b])).unwrap();
        assert!(matches!(
            claim_in(&registry, &strings(&[scratch.path()])),
            Err(ClaimError::Busy(_))
        ));
        drop(first);
        assert!(claim_in(&registry, &strings(&[&a])).is_ok());
        drop(other);
    }

    #[test]
    fn missing_destinations_resolve_through_existing_ancestors() {
        let scratch = tempfile::tempdir().unwrap();
        let a =
            normalized_root(&scratch.path().join("unused/../out/sub").to_string_lossy()).unwrap();
        let b = normalized_root(&scratch.path().join("out").to_string_lossy()).unwrap();
        assert!(roots_conflict(&a, &b));
        assert!(!roots_conflict(&a, &scratch.path().join("outside")));
    }

    #[cfg(windows)]
    #[test]
    fn live_records_are_readable_but_cannot_be_changed_or_removed() {
        let scratch = tempfile::tempdir().unwrap();
        let registry = scratch.path().join("claims");
        let root = scratch.path().join("out").to_string_lossy().into_owned();
        let lease = claim_in(&registry, std::slice::from_ref(&root)).unwrap();
        let record = std::fs::read_dir(&registry)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.extension().is_some_and(|ext| ext == "json"))
            .unwrap();
        assert!(std::fs::read_to_string(&record).unwrap().contains("out"));
        assert!(std::fs::write(&record, b"{}").is_err());
        assert!(std::fs::remove_file(&record).is_err());
        drop(lease);
        assert!(
            !record.exists(),
            "the OS must remove a finished run's record"
        );

        // ProgramData grants other users read access to an existing mutex
        // file. Acquiring it must not ask for write access to that file.
        let mutex = registry.join("registry.lock");
        let mut permissions = std::fs::metadata(&mutex).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&mutex, permissions.clone()).unwrap();
        let locked = registry_lock(&mutex);
        let acquired = locked.is_ok();
        drop(locked);
        permissions.set_readonly(false);
        std::fs::set_permissions(&mutex, permissions).unwrap();
        assert!(acquired);
    }

    #[test]
    fn ignored_registry_entries_cannot_bypass_the_scan_limit() {
        let scratch = tempfile::tempdir().unwrap();
        let registry = scratch.path().join("claims");
        std::fs::create_dir_all(&registry).unwrap();
        for index in 0..MAX_REGISTRY_ENTRIES {
            std::fs::write(registry.join(format!("ignored-{index}.tmp")), []).unwrap();
        }

        let root = scratch.path().join("out").to_string_lossy().into_owned();
        assert!(matches!(
            claim_in(&registry, &[root]),
            Err(ClaimError::Unavailable(_))
        ));
    }

    // Invoked by a second test process; its OS handle is independent of this
    // process's Rust state, as a scheduled run's is.
    #[test]
    #[ignore]
    fn child_holds_folder() {
        let Some(registry) = std::env::var_os("SPECTRA_TEST_CLAIM_REGISTRY") else {
            return;
        };
        let root = std::env::var("SPECTRA_TEST_CLAIM_ROOT").unwrap();
        let _lease = claim_in(Path::new(&registry), &[root]).unwrap();
        println!("folder-lease-ready");
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
    }

    #[test]
    fn another_process_blocks_a_claim_and_crash_releases_it() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().join("out").to_string_lossy().into_owned();
        let registry = scratch.path().join("claims");
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "folder_claims::tests::child_holds_folder",
                "--ignored",
                "--nocapture",
            ])
            .env("SPECTRA_TEST_CLAIM_REGISTRY", &registry)
            .env("SPECTRA_TEST_CLAIM_ROOT", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn().unwrap();
        let mut reader = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut ready = false;
        for line in reader.by_ref().lines() {
            if line.unwrap().contains("folder-lease-ready") {
                ready = true;
                break;
            }
        }
        assert!(ready);
        let blocked = claim_in(&registry, std::slice::from_ref(&root));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(matches!(blocked, Err(ClaimError::Busy(_))));
        assert!(claim_in(&registry, &[root]).is_ok());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_finished_runs_record_is_removed_by_the_next_claim() {
        let scratch = tempfile::tempdir().unwrap();
        let registry = scratch.path().join("claims");
        let root = scratch.path().join("out").to_string_lossy().into_owned();
        let records = |registry: &Path| {
            std::fs::read_dir(registry)
                .unwrap()
                .filter(|entry| {
                    entry.as_ref().unwrap().path().extension().is_some_and(|ext| ext == "json")
                })
                .count()
        };
        drop(claim_in(&registry, std::slice::from_ref(&root)).unwrap());
        assert_eq!(records(&registry), 1);
        let held = claim_in(&registry, std::slice::from_ref(&root)).unwrap();
        assert_eq!(records(&registry), 1);
        drop(held);
    }

    // Invoked by a second test process: it claims a folder, retains the lease
    // in a bound worker, and is then killed.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore]
    fn child_retains_folder_in_a_worker() {
        let Some(registry) = std::env::var_os("SPECTRA_TEST_CLAIM_REGISTRY") else {
            return;
        };
        let root = std::env::var("SPECTRA_TEST_CLAIM_ROOT").unwrap();
        let lease = claim_in(Path::new(&registry), &[root]).unwrap();
        let mut command = std::process::Command::new("sleep");
        command.arg("60");
        let (worker, job) = crate::process_job::spawn_bound(
            command,
            crate::process_job::Binding { lease_channel: true, memory_limit: None },
        )
        .unwrap();
        let retained = lease.retain_in_worker(worker.id()).unwrap();
        println!("worker={}", worker.id());
        std::io::stdout().flush().unwrap();
        std::mem::forget((lease, retained, job));
        std::thread::sleep(Duration::from_secs(60));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_crashed_runs_lease_is_held_until_its_worker_is_gone() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().join("out").to_string_lossy().into_owned();
        let registry = scratch.path().join("claims");
        let mut parent = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "folder_claims::tests::child_retains_folder_in_a_worker",
                "--ignored",
                "--nocapture",
            ])
            .env("SPECTRA_TEST_CLAIM_REGISTRY", &registry)
            .env("SPECTRA_TEST_CLAIM_ROOT", &root)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let reader = std::io::BufReader::new(parent.stdout.take().unwrap());
        let mut worker = None;
        for line in reader.lines() {
            if let Some(pid) = line.unwrap().strip_prefix("worker=") {
                worker = Some(pid.trim().parse::<u32>().unwrap());
                break;
            }
        }
        let worker = worker.expect("the worker was spawned");
        assert!(matches!(
            claim_in(&registry, std::slice::from_ref(&root)),
            Err(ClaimError::Busy(_))
        ));
        parent.kill().unwrap();
        parent.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let claimed = claim_in(&registry, std::slice::from_ref(&root));
            match claimed {
                Ok(_) => {
                    assert!(!worker_running(worker), "claimed while the worker still ran");
                    break;
                }
                Err(ClaimError::Busy(_)) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(other) => panic!("the lease was never released: {other:?}"),
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn worker_running(pid: u32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|stat| {
                stat.rsplit(')')
                    .next()
                    .and_then(|rest| rest.split_whitespace().next())
                    .is_some_and(|state| state != "Z")
            })
            .unwrap_or(false)
    }
}
