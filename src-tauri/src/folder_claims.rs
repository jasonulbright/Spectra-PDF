//! Folder writer leases shared by installed, portable and scheduled processes.
//! The registry mutex serializes multi-root claims; each lease's open handle
//! outlives that mutex and is released by the OS even after a process crash.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug)]
pub struct FolderLease {
    _handle: File,
}

/// The worker holds the same OS lease while it can still write. A parent's
/// crash may close its own lease before the job has terminated its children.
pub struct WorkerLease {
    process: usize,
    handle: usize,
}

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
pub enum ClaimError {
    Busy(String),
    Unavailable(String),
}

impl From<io::Error> for ClaimError {
    fn from(error: io::Error) -> Self {
        Self::Unavailable(format!("Folder ownership could not be checked: {error}"))
    }
}

#[derive(Serialize, Deserialize)]
struct Record {
    roots: Vec<String>,
}

pub fn registry_path() -> Result<PathBuf, ClaimError> {
    // Task Scheduler can run under another account. ProgramData supplies one
    // machine-wide location; its default inherited Users permissions allow
    // directory creation and reading records written by another account.
    let base = std::env::var_os("ProgramData").ok_or_else(|| {
        ClaimError::Unavailable("The shared application data folder is unavailable.".into())
    })?;
    Ok(PathBuf::from(base).join("Spectra PDF").join("folder-claims"))
}

fn exclusive(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    // Only READ access is needed to acquire an exclusive OS sharing lease.
    // Another account can read a ProgramData file it did not create.
    OpenOptions::new().read(true).share_mode(0).open(path)
}

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

fn sharing_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(32 | 33))
}

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

fn prefix(a: &str, b: &str) -> bool {
    a == b
        || b.strip_prefix(a)
            .is_some_and(|rest| rest.starts_with(['\\', '/']))
}

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

pub fn claim(roots: &[String]) -> Result<FolderLease, ClaimError> {
    claim_in(&registry_path()?, roots)
}

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
    let mut count = 0;
    for entry in std::fs::read_dir(registry)? {
        let path = entry?.path();
        if path.extension().map_or(true, |ext| ext != "json") {
            continue;
        }
        count += 1;
        if count > 4096 {
            return Err(ClaimError::Unavailable(
                "The folder ownership registry is too large.".into(),
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
    Ok(FolderLease { _handle: file })
}

#[cfg(test)]
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
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().join("out").to_string_lossy().into_owned();
        let registry = scratch.path().join("claims");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "folder_claims::tests::child_holds_folder",
                "--ignored",
                "--nocapture",
            ])
            .env("SPECTRA_TEST_CLAIM_REGISTRY", &registry)
            .env("SPECTRA_TEST_CLAIM_ROOT", &root)
            .creation_flags(0x0800_0000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
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
}
