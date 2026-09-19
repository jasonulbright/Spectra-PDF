//! Staging files that a killed process left behind.
//!
//! A writer that stages bytes under a name carrying its own process id cannot
//! remove the file once it is killed between creating it and landing it, and
//! no later write uses that name again. Only another process can reclaim it,
//! and only by asking whether the process the name carries still runs.
//!
//! A stage whose name carries no process id cannot be asked about. It is
//! reclaimed by its age instead, see [`LEGACY_STAGE_AGE`].

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, SystemTime};

/// A process id in the one spelling `u32`'s `Display` produces. A name that
/// only parses as an id (`007`, `+7`) was not written by a writer here.
pub(crate) fn decimal_pid(field: &str) -> Option<u32> {
    let pid: u32 = field.parse().ok()?;
    (pid.to_string() == field).then_some(pid)
}

/// Whether the process `pid` names has not exited.
///
/// Only an open refused with ERROR_INVALID_PARAMETER proves that no such
/// process exists. Any other refusal, access denied for one, comes from a
/// process that exists and reads as running. So does an exit code of
/// STILL_ACTIVE, including a process that exited with that code: a kept
/// orphan costs disk, and a removed live stage costs a write.
#[cfg(windows)]
pub(crate) fn process_running(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let process = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(process) => process,
        Err(error) => return error.code() != ERROR_INVALID_PARAMETER.to_hresult(),
    };
    let mut code = 0u32;
    let queried = unsafe { GetExitCodeProcess(process, &mut code) };
    unsafe {
        let _ = CloseHandle(process);
    }
    queried.is_err() || code == STILL_ACTIVE.0 as u32
}

#[cfg(not(windows))]
pub(crate) fn process_running(_pid: u32) -> bool {
    true
}

/// Whether some handle holds `path` open for its data.
///
/// A process id in a stage's name is asked about on this machine only. In a
/// folder that other machines reach through a share, a stage a remote writer
/// is still filling carries an id this machine does not run, and its open
/// handle is what tells it apart from an orphan. An open that shares nothing
/// is refused while any such handle exists; every refusal except an absent
/// file reads as held.
#[cfg(windows)]
pub(crate) fn held_open(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    match std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(path)
    {
        Ok(_) => false,
        Err(e) => e.kind() != io::ErrorKind::NotFound,
    }
}

#[cfg(not(windows))]
pub(crate) fn held_open(_path: &Path) -> bool {
    false
}

/// Remove each entry of `dir` that `owner` attributes to a process that is
/// neither `own` nor `running`, and that no handle holds open. Returns how
/// many were removed.
///
/// `own` is never asked about: a file under this process's id is one it is
/// writing now or still holds.
pub(crate) fn reclaim(
    dir: &Path,
    own: u32,
    owner: impl Fn(&str) -> Option<u32>,
    running: impl Fn(u32) -> bool,
) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(&owner) else {
            continue;
        };
        if pid == own || running(pid) || held_open(&entry.path()) {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ── Records ───────────────────────────────────────────────────────────────

/// Where the process `pid` stages a replacement for `record`: beside it, so
/// landing is a rename inside one directory, and under the writer's id, so two
/// processes never share a stage.
pub(crate) fn stage_path(record: &Path, pid: u32) -> PathBuf {
    let mut name = record.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{pid}.tmp"));
    record.with_file_name(name)
}

/// The record name and the process id that a [`stage_path`] name carries.
pub(crate) fn split_stage(entry: &str) -> Option<(&str, u32)> {
    let (record, pid) = entry.strip_suffix(".tmp")?.rsplit_once('.')?;
    Some((record, decimal_pid(pid)?))
}

/// The process whose [`stage_path`] for the record named `record` produced
/// `entry`.
pub(crate) fn stage_owner(record: &str, entry: &str) -> Option<u32> {
    split_stage(entry).and_then(|(staged, pid)| (staged == record).then_some(pid))
}

/// Remove each stage of `record` that a process neither `own` nor `running`
/// left beside it.
pub(crate) fn reclaim_record_stages(
    record: &Path,
    own: u32,
    running: impl Fn(u32) -> bool,
) -> usize {
    let (Some(dir), Some(name)) = (record.parent(), record.file_name().and_then(|n| n.to_str()))
    else {
        return 0;
    };
    reclaim(dir, own, |entry| stage_owner(name, entry), running)
}

/// The lock this process holds while it stages and lands `record`. Every
/// thread of one process stages a record under the same name, so two
/// unserialized writers would fill one stage together.
fn record_lock(record: &Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    locks.retain(|_, held| held.strong_count() > 0);
    if let Some(lock) = locks.get(record).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(record.to_path_buf(), Arc::downgrade(&lock));
    lock
}

/// Stage `record` with `fill`, then `land` the stage under the record's name.
///
/// `fill` writes the stage path it is given, flushes it to the disk and hands
/// back an open handle to it. The handle stays open until the stage has
/// landed, so [`held_open`] never finds an unfinished stage free. A failure at
/// either step removes the stage and leaves the record as it was.
fn stage_and_land(
    record: &Path,
    fill: impl FnOnce(&Path) -> io::Result<File>,
    land: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let lock = record_lock(record);
    let _serialized = lock.lock().unwrap_or_else(|e| e.into_inner());
    let own = std::process::id();
    reclaim_record_stages(record, own, process_running);
    let staged = stage_path(record, own);
    // A stage of this process that an earlier failure could not remove.
    let _ = std::fs::remove_file(&staged);
    let landed = fill(&staged).and_then(|held| {
        let landed = land(&staged, record);
        drop(held);
        landed
    });
    if landed.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    landed
}

/// Replace `record` in one step: the stage takes the record's name by rename,
/// so a reader finds the whole previous record or the whole new one, and a
/// writer killed at any point leaves the previous record intact.
pub(crate) fn replace_record(
    record: &Path,
    fill: impl FnOnce(&Path) -> io::Result<File>,
) -> io::Result<()> {
    stage_and_land(record, fill, |staged, record| std::fs::rename(staged, record))
}

/// Create `record` in one step. The stage lands only where nothing has the
/// record's name; otherwise the call refuses with `AlreadyExists`.
pub(crate) fn create_record(
    record: &Path,
    fill: impl FnOnce(&Path) -> io::Result<File>,
) -> io::Result<()> {
    stage_and_land(record, fill, rename_no_clobber)
}

/// Write `bytes` at the stage path `staged` and flush them to the disk.
pub(crate) fn write_stage(staged: &Path, bytes: &[u8]) -> io::Result<File> {
    let mut file = File::create(staged)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(file)
}

/// Replace `record` with `bytes` through [`replace_record`].
pub(crate) fn write_record(record: &Path, bytes: &[u8]) -> io::Result<()> {
    replace_record(record, |staged| write_stage(staged, bytes))
}

/// Copy `source` to the stage path `staged` and flush it to the disk. Returns
/// the byte count the copy reports.
///
/// The copy keeps what `fs::copy` carries: the source's attributes, its write
/// time and its alternate streams. The handle is taken before the copy, which
/// writes into the same file: the stage is held from its creation, and the
/// handle keeps the write access the flush needs when the copy makes the
/// stage read-only.
pub(crate) fn copy_to_stage(source: &Path, staged: &Path) -> io::Result<(u64, File)> {
    let held = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(staged)?;
    let copied = std::fs::copy(source, staged)?;
    held.sync_all()?;
    Ok((copied, held))
}

/// Replace `record` with a copy of `source` through [`replace_record`].
pub(crate) fn copy_record(source: &Path, record: &Path) -> io::Result<u64> {
    let mut copied = 0;
    replace_record(record, |staged| {
        let (count, held) = copy_to_stage(source, staged)?;
        copied = count;
        Ok(held)
    })?;
    Ok(copied)
}

// ── Exports ──────────────────────────────────────────────────────────────

#[cfg(windows)]
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

/// Whether an open of `path` that asks for `access` alone is refused for lack
/// of that access. A path held by another handle, or gone, is not refused.
#[cfg(windows)]
fn access_refused(path: &Path, access: u32, flags: u32) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    matches!(
        std::fs::OpenOptions::new()
            .access_mode(access)
            .custom_flags(flags)
            .open(path),
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied
    )
}

/// Whether the folder `dir` refuses this process a new file.
#[cfg(windows)]
pub(crate) fn create_denied(dir: &Path) -> bool {
    const FILE_ADD_FILE: u32 = 0x0002;
    access_refused(dir, FILE_ADD_FILE, FILE_FLAG_BACKUP_SEMANTICS)
}

#[cfg(not(windows))]
pub(crate) fn create_denied(_dir: &Path) -> bool {
    false
}

/// Whether this process may not replace `target` by renaming another file
/// over it. The rename needs DELETE on `target`, which the file's own access
/// list grants or its folder's delete-child right grants, so an open that asks
/// for DELETE alone answers for both.
#[cfg(windows)]
pub(crate) fn replace_denied(target: &Path) -> bool {
    const DELETE: u32 = 0x0001_0000;
    access_refused(target, DELETE, 0)
}

#[cfg(not(windows))]
pub(crate) fn replace_denied(_target: &Path) -> bool {
    false
}

/// Whether `record` exists and this process may not replace it by a rename.
fn replace_refused(record: &Path) -> bool {
    record.is_file() && replace_denied(record)
}

/// Whether a stage that could not be created in `dir` was refused because
/// `dir` denies this process a new file. A name taken by a folder, a full
/// disk or a folder that is gone is not that refusal.
pub(crate) fn refused_for_create(refused: &io::Error, dir: &Path) -> bool {
    refused.kind() == io::ErrorKind::PermissionDenied && create_denied(dir)
}

/// Write the existing `record` in place through `fill`, under the record's
/// lock. A record that does not open for writing leaves `refusal` standing.
fn rewrite_existing(
    record: &Path,
    refusal: io::Error,
    fill: impl FnOnce(&mut File) -> io::Result<()>,
) -> io::Result<()> {
    let lock = record_lock(record);
    let _serialized = lock.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(mut file) = std::fs::OpenOptions::new().write(true).open(record) else {
        return Err(refusal);
    };
    file.set_len(0)?;
    fill(&mut file)?;
    file.sync_all()
}

/// Replace `record` with `bytes` like [`write_record`], for a file written to
/// a folder the user chose.
///
/// A folder can let a user change a file and still refuse to create one
/// beside it, or refuse to replace it by a rename. When `record` exists and
/// opens for writing, and its folder refuses the stage for the first reason
/// (see [`refused_for_create`]) or its replacement for the second (see
/// [`replace_denied`], asked before any stage exists), the bytes are written
/// into it in place.
pub(crate) fn export_record(record: &Path, bytes: &[u8]) -> io::Result<()> {
    if replace_refused(record) {
        let refusal = io::Error::from(io::ErrorKind::PermissionDenied);
        return rewrite_existing(record, refusal, |file| file.write_all(bytes));
    }
    let mut create_refused = false;
    let staged = replace_record(record, |staged| {
        let mut file = File::create(staged).inspect_err(|e| {
            create_refused = staged.parent().is_some_and(|dir| refused_for_create(e, dir));
        })?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(file)
    });
    match staged {
        Err(refusal) if create_refused => {
            rewrite_existing(record, refusal, |file| file.write_all(bytes))
        }
        landed => landed,
    }
}

/// Replace `record` with a copy of `source` like [`copy_record`], with the
/// in-place write [`export_record`] falls back to. Returns the byte count.
pub(crate) fn export_copy(source: &Path, record: &Path) -> io::Result<u64> {
    if replace_refused(record) {
        let refusal = io::Error::from(io::ErrorKind::PermissionDenied);
        return copy_in_place(source, record, refusal);
    }
    let mut copied = 0;
    let mut create_refused = false;
    let staged = replace_record(record, |staged| {
        let (count, held) = copy_to_stage(source, staged).inspect_err(|e| {
            create_refused = staged.parent().is_some_and(|dir| refused_for_create(e, dir));
        })?;
        copied = count;
        Ok(held)
    });
    match staged {
        Ok(()) => Ok(copied),
        Err(refusal) if create_refused => copy_in_place(source, record, refusal),
        Err(refusal) => Err(refusal),
    }
}

/// Copy `source` into the existing `record` through [`rewrite_existing`].
/// Returns the byte count.
fn copy_in_place(source: &Path, record: &Path, refusal: io::Error) -> io::Result<u64> {
    let mut copied = 0;
    rewrite_existing(record, refusal, |file| {
        copied = io::copy(&mut File::open(source)?, file)?;
        Ok(())
    })?;
    Ok(copied)
}

/// A record's bytes, or `None` when no record exists. Every other failure is
/// an error: a record that exists but cannot be read is not an absent one.
pub(crate) fn read_record(record: &Path) -> io::Result<Option<Vec<u8>>> {
    match std::fs::read(record) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Rename `from` to `to`, refusing with `AlreadyExists` when `to` exists.
#[cfg(windows)]
pub(crate) fn rename_no_clobber(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::WIN32_ERROR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS};

    let wide =
        |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (from, to) = (wide(from), wide(to));
    unsafe { MoveFileExW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr()), MOVE_FILE_FLAGS(0)) }.map_err(
        |error| match WIN32_ERROR::from_error(&error) {
            Some(code) => io::Error::from_raw_os_error(code.0 as i32),
            None => io::Error::other(error),
        },
    )
}

#[cfg(not(windows))]
pub(crate) fn rename_no_clobber(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::hard_link(from, to)?;
    std::fs::remove_file(from)
}

/// Move a record that could not be read or parsed out of the way, so that no
/// later write replaces bytes nothing has read. It lands at the first free
/// name of `<record>.unreadable`, `<record>.unreadable-2`, and so on, which no
/// reclaim here matches. Returns where it went.
pub(crate) fn set_aside(record: &Path) -> io::Result<PathBuf> {
    let name = record
        .file_name()
        .ok_or_else(|| io::Error::other("a record path must name a file"))?;
    for n in 1..1000u32 {
        let mut aside = name.to_os_string();
        if n == 1 {
            aside.push(".unreadable");
        } else {
            aside.push(format!(".unreadable-{n}"));
        }
        let aside = record.with_file_name(aside);
        match rename_no_clobber(record, &aside) {
            Ok(()) => return Ok(aside),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "every name to set the record aside under is taken",
    ))
}

// ── Stages that carry no process id ──────────────────────────────────────

/// How long a stage whose name carries no process id must have existed before
/// it is reclaimed.
///
/// Such a stage lives from its creation to its rename: one checked copy of one
/// document for a `document-stage-<random>.pdf`, one task registration for a
/// `<task>.json.new`. Neither step waits on a person or on a timer, so a stage
/// that has existed this long is not in flight.
pub(crate) const LEGACY_STAGE_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Remove each file in `dir` whose name `legacy` accepts, which was created at
/// least `age` before `now`, and which no handle holds open. Returns how many
/// were removed.
///
/// Age is creation time, never write time: `fs::copy` gives a copy its
/// source's write time, so a stage filled a moment ago can carry one years
/// old. An entry whose creation time cannot be read, or lies after `now`, is
/// kept.
pub(crate) fn reclaim_aged(
    dir: &Path,
    legacy: impl Fn(&str) -> bool,
    age: Duration,
    now: SystemTime,
) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        if !entry.file_name().to_str().is_some_and(&legacy) {
            continue;
        }
        let Some(existed) = std::fs::symlink_metadata(entry.path())
            .and_then(|meta| meta.created())
            .ok()
            .and_then(|born| now.duration_since(born).ok())
        else {
            continue;
        };
        if existed >= age && !held_open(&entry.path()) && std::fs::remove_file(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

/// Denials in the access lists of the current user, set up with `icacls` so
/// every refusal comes from the file system itself, and removed when the
/// value is dropped.
#[cfg(all(test, windows))]
pub(crate) struct Denied {
    paths: Vec<PathBuf>,
    sid: String,
}

#[cfg(all(test, windows))]
impl Denied {
    fn current_user() -> Self {
        let who = std::process::Command::new("whoami")
            .args(["/user", "/fo", "csv", "/nh"])
            .output()
            .unwrap();
        assert!(who.status.success(), "whoami failed");
        let text = String::from_utf8_lossy(&who.stdout).to_string();
        let sid = text.trim().rsplit(',').next().unwrap().trim_matches('"').to_string();
        assert!(sid.starts_with("S-1-"), "no SID in {text:?}");
        Self {
            paths: Vec::new(),
            sid,
        }
    }

    fn icacls(&mut self, target: &Path, action: &str, rights: &str) {
        let status = std::process::Command::new("icacls")
            .arg(target)
            .arg(action)
            .arg(format!("*{}:{rights}", self.sid))
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "icacls {action} on {}", target.display());
        if action == "/deny" {
            self.paths.push(target.to_path_buf());
        }
    }

    /// `dir` refuses a new file; the files in `writable` stay writable.
    pub(crate) fn create(dir: &Path, writable: &[&Path]) -> Self {
        let mut denied = Self::current_user();
        denied.icacls(dir, "/deny", "(WD)");
        for file in writable {
            denied.icacls(file, "/grant", "(W)");
        }
        let probe = dir.join("a-new-file.probe");
        assert_eq!(
            File::create(&probe).map(drop).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied,
            "the folder still accepts a new file"
        );
        denied
    }

    /// `rights` are refused on `path`, and nothing else.
    pub(crate) fn only(path: &Path, rights: &str) -> Self {
        let mut denied = Self::current_user();
        denied.icacls(path, "/deny", rights);
        denied
    }

    /// Nothing may replace `target` in `dir` by a rename: deleting `target`
    /// and deleting a child of `dir` are refused. New files and writes stay
    /// allowed.
    pub(crate) fn replace(dir: &Path, target: &Path) -> Self {
        let mut denied = Self::current_user();
        denied.icacls(target, "/deny", "(DE)");
        denied.icacls(dir, "/deny", "(DC)");
        let probe = dir.join("a-replacement.probe");
        std::fs::write(&probe, b"probe").unwrap();
        let refused = std::fs::rename(&probe, target).unwrap_err();
        std::fs::remove_file(&probe).unwrap();
        assert_eq!(refused.kind(), io::ErrorKind::PermissionDenied);
        denied
    }
}

/// The volume and index that name the file at `path`, read through a handle
/// that is closed again: a rename over a file some handle holds is refused.
#[cfg(all(test, windows))]
pub(crate) fn file_id(path: &Path) -> (u32, u32, u32) {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let file = File::open(path).unwrap();
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.unwrap();
    (
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    )
}

#[cfg(all(test, windows))]
impl Drop for Denied {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = std::process::Command::new("icacls")
                .arg(path)
                .arg("/remove:d")
                .arg(format!("*{}", self.sid))
                .stdout(std::process::Stdio::null())
                .status();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const OWN: u32 = 4100;
    const LIVE: u32 = 4200;
    const DEAD: u32 = 4300;

    fn names(dir: &Path) -> BTreeSet<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect()
    }

    fn tagged(name: &str) -> Option<u32> {
        decimal_pid(name.strip_prefix("stage.")?)
    }

    #[test]
    fn only_the_canonical_decimal_spelling_is_a_process_id() {
        assert_eq!(decimal_pid("4300"), Some(4300));
        assert_eq!(decimal_pid("0"), Some(0));
        assert_eq!(decimal_pid(&u32::MAX.to_string()), Some(u32::MAX));
        for field in [
            "",
            "04300",
            "+4300",
            "-4300",
            " 4300",
            "4300 ",
            "43a0",
            "4294967296",
        ] {
            assert_eq!(decimal_pid(field), None, "{field:?}");
        }
    }

    #[test]
    fn only_an_attributed_entry_of_a_stopped_process_is_removed() {
        let dir = tempfile::tempdir().unwrap();
        for name in [
            "stage.4100",
            "stage.4200",
            "stage.4300",
            "stage.x",
            "record",
        ] {
            std::fs::write(dir.path().join(name), name).unwrap();
        }
        // An entry that is not a file cannot be taken, whatever its name says.
        std::fs::create_dir(dir.path().join("stage.4304")).unwrap();

        let asked = std::cell::RefCell::new(Vec::new());
        let removed = reclaim(dir.path(), OWN, tagged, |pid| {
            asked.borrow_mut().push(pid);
            pid == LIVE
        });

        assert_eq!(removed, 1);
        let kept: BTreeSet<String> = [
            "record",
            "stage.4100",
            "stage.4200",
            "stage.4304",
            "stage.x",
        ]
        .map(String::from)
        .into();
        assert_eq!(names(dir.path()), kept);
        let mut asked = asked.into_inner();
        asked.sort();
        assert_eq!(asked, vec![LIVE, DEAD, 4304]);
    }

    /// A stage copied from a read-only source carries the attribute, and the
    /// reclaim relies on `remove_file` deleting a read-only file on Windows.
    #[test]
    fn a_read_only_orphan_is_still_removed() {
        let dir = tempfile::tempdir().unwrap();
        let orphan = dir.path().join("stage.4300");
        std::fs::write(&orphan, b"copied from a read-only source").unwrap();
        let mut permissions = std::fs::metadata(&orphan).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&orphan, permissions).unwrap();

        assert_eq!(reclaim(dir.path(), OWN, tagged, |_| false), 1);
        assert!(!orphan.exists());
    }

    /// A remote writer's stage carries an id this machine does not run. Its
    /// open handle is what keeps it, and closing the handle frees it.
    #[cfg(windows)]
    #[test]
    fn a_file_some_handle_holds_open_is_never_reclaimed() {
        let dir = tempfile::tempdir().unwrap();
        let stage = dir.path().join("stage.4300");
        let legacy_stage = dir.path().join("legacy-held");
        std::fs::write(&stage, b"still being filled").unwrap();
        std::fs::write(&legacy_stage, b"still being filled").unwrap();
        let held = std::fs::OpenOptions::new().write(true).open(&stage).unwrap();
        let legacy_held = std::fs::OpenOptions::new()
            .write(true)
            .open(&legacy_stage)
            .unwrap();
        let later = SystemTime::now() + LEGACY_STAGE_AGE + Duration::from_secs(60);

        assert_eq!(reclaim(dir.path(), OWN, tagged, |_| false), 0);
        assert_eq!(reclaim_aged(dir.path(), legacy, LEGACY_STAGE_AGE, later), 0);
        assert!(stage.exists() && legacy_stage.exists());

        drop((held, legacy_held));
        assert_eq!(reclaim(dir.path(), OWN, tagged, |_| false), 1);
        assert_eq!(reclaim_aged(dir.path(), legacy, LEGACY_STAGE_AGE, later), 1);
        assert!(!stage.exists() && !legacy_stage.exists());
    }

    #[test]
    fn a_missing_directory_reclaims_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            reclaim(&dir.path().join("absent"), OWN, tagged, |_| false),
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_child_runs_until_it_exits_and_this_process_runs() {
        use std::process::{Command, Stdio};

        assert!(process_running(std::process::id()));

        let mut child = Command::new("cmd")
            .arg("/Q")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(process_running(child.id()));

        drop(child.stdin.take());
        child.wait().unwrap();
        // `child` still holds its handle, so the id cannot be reused while it
        // is asked about.
        assert!(!process_running(child.id()));
    }

    #[cfg(windows)]
    #[test]
    fn an_id_no_process_can_hold_is_not_running() {
        assert!(!process_running(0));
        assert!(!process_running(u32::MAX));
    }

    /// A process id that no running process holds while the returned child is
    /// alive: the child has exited, and its handle keeps the id from reuse.
    #[cfg(windows)]
    fn stopped_process() -> (std::process::Child, u32) {
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        child.wait().unwrap();
        let pid = child.id();
        (child, pid)
    }

    // ── Records ───────────────────────────────────────────────────────────

    #[test]
    fn a_stage_name_carries_exactly_its_record_and_its_process() {
        let record = Path::new("C:\\data").join("watched-folders.json");
        let staged = stage_path(&record, 4300);
        assert_eq!(staged, Path::new("C:\\data").join("watched-folders.json.4300.tmp"));
        let name = staged.file_name().unwrap().to_str().unwrap();
        assert_eq!(split_stage(name), Some(("watched-folders.json", 4300)));
        assert_eq!(stage_owner("watched-folders.json", name), Some(4300));
        // A name with no extension stages the same way.
        assert_eq!(split_stage("record.7.tmp"), Some(("record", 7)));
        for other in [
            "watched-folders.json",
            "watched-folders.json.tmp",
            "watched-folders.json..tmp",
            "watched-folders.json.abc.tmp",
            "watched-folders.json.04300.tmp",
            "watched-folders.json.4300.tmp.bak",
            "watched-folders.json4300.tmp",
            "watched-folders.json.4300.TMP",
            ".4300.tmp",
            "other.json.4300.tmp",
        ] {
            assert_eq!(stage_owner("watched-folders.json", other), None, "{other}");
        }
    }

    #[test]
    fn a_record_is_replaced_whole_and_no_stage_is_left() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record.json");
        write_record(&record, b"{\"n\":1}").unwrap();
        assert_eq!(std::fs::read(&record).unwrap(), b"{\"n\":1}");
        write_record(&record, b"{\"n\":2}").unwrap();
        assert_eq!(std::fs::read(&record).unwrap(), b"{\"n\":2}");
        assert_eq!(
            names(dir.path()),
            BTreeSet::from(["record.json".to_string()])
        );
    }

    /// The property a write straight over the file lacks: while the new bytes
    /// are still arriving, the record holds all of the previous ones.
    #[test]
    fn the_previous_record_stands_until_the_new_one_lands() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record.json");
        write_record(&record, b"previous record").unwrap();
        replace_record(&record, |staged| {
            std::fs::write(staged, b"half a new rec")?;
            assert_eq!(std::fs::read(&record).unwrap(), b"previous record");
            write_stage(staged, b"a new record")
        })
        .unwrap();
        assert_eq!(std::fs::read(&record).unwrap(), b"a new record");
    }

    /// A reclaim run from another machine asks the stage's handle, so the
    /// writer keeps it open until the rename has happened.
    #[cfg(windows)]
    #[test]
    fn a_stage_stays_held_until_it_has_landed() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record.json");
        stage_and_land(
            &record,
            |staged| write_stage(staged, b"a new record"),
            |staged, record| {
                assert!(held_open(staged), "a stage must be held while it lands");
                std::fs::rename(staged, record)
            },
        )
        .unwrap();
        assert_eq!(std::fs::read(&record).unwrap(), b"a new record");
        assert!(!held_open(&record));
    }

    #[cfg(windows)]
    #[test]
    fn a_copied_stage_is_held_from_its_creation_until_it_lands() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.pdf");
        std::fs::write(&source, b"%PDF-1.7").unwrap();
        let record = dir.path().join("mirror.pdf");
        stage_and_land(
            &record,
            |staged| {
                let (copied, held) = copy_to_stage(&source, staged)?;
                assert_eq!(copied, 8);
                Ok(held)
            },
            |staged, record| {
                assert!(held_open(staged), "a copied stage must be held while it lands");
                std::fs::rename(staged, record)
            },
        )
        .unwrap();
        assert_eq!(std::fs::read(&record).unwrap(), b"%PDF-1.7");
    }

    #[test]
    fn a_failed_write_keeps_the_previous_record_and_removes_its_stage() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record.json");
        write_record(&record, b"previous record").unwrap();
        let failed = replace_record(&record, |staged| {
            std::fs::write(staged, b"half a new rec")?;
            Err(io::Error::other("the disk filled"))
        });
        assert!(failed.is_err());
        assert_eq!(std::fs::read(&record).unwrap(), b"previous record");
        assert_eq!(
            names(dir.path()),
            BTreeSet::from(["record.json".to_string()])
        );

        // A stage that cannot even be created fails the same way.
        std::fs::create_dir(stage_path(&record, std::process::id())).unwrap();
        assert!(write_record(&record, b"new record").is_err());
        assert_eq!(std::fs::read(&record).unwrap(), b"previous record");
    }

    #[test]
    fn a_stage_this_process_left_is_replaced_not_landed() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record.json");
        let leftover = stage_path(&record, std::process::id());
        std::fs::write(&leftover, b"bytes from a failed write").unwrap();
        let mut permissions = std::fs::metadata(&leftover).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&leftover, permissions).unwrap();

        write_record(&record, b"new record").unwrap();
        assert_eq!(std::fs::read(&record).unwrap(), b"new record");
        assert!(!leftover.exists());
    }

    #[cfg(windows)]
    #[test]
    fn a_write_reclaims_the_stages_that_stopped_writers_left() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record.json");
        let (_child, dead) = stopped_process();
        let orphan = stage_path(&record, dead);
        let other_record = stage_path(&dir.path().join("other.json"), dead);
        std::fs::write(&orphan, b"a stage a killed writer left").unwrap();
        std::fs::write(&other_record, b"another record's stage").unwrap();

        write_record(&record, b"new record").unwrap();

        assert!(!orphan.exists());
        assert!(other_record.exists(), "only this record's stages are taken");
        assert_eq!(std::fs::read(&record).unwrap(), b"new record");
    }

    #[test]
    fn writers_in_one_process_never_mix_their_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let record = Arc::new(dir.path().join("record.bin"));
        let payloads: Arc<Vec<Vec<u8>>> = Arc::new(
            (0..6u8)
                .map(|n| vec![b'a' + n; 256 * 1024 + usize::from(n)])
                .collect(),
        );
        let writers: Vec<_> = (0..payloads.len())
            .map(|n| {
                let (record, payloads) = (record.clone(), payloads.clone());
                std::thread::spawn(move || {
                    for _ in 0..12 {
                        write_record(&record, &payloads[n]).unwrap();
                        let seen = std::fs::read(&*record).unwrap();
                        assert!(payloads.contains(&seen), "a record of {} mixed bytes", seen.len());
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert!(payloads.contains(&std::fs::read(&*record).unwrap()));
    }

    #[test]
    fn a_copy_lands_whole_and_keeps_a_read_only_attribute() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.pdf");
        let record = dir.path().join("mirror.pdf");
        std::fs::write(&source, b"%PDF-1.7 the whole source").unwrap();
        let mut permissions = std::fs::metadata(&source).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&source, permissions).unwrap();

        assert_eq!(copy_record(&source, &record).unwrap(), 25);
        assert_eq!(std::fs::read(&record).unwrap(), b"%PDF-1.7 the whole source");
        assert!(std::fs::metadata(&record).unwrap().permissions().readonly());
        assert_eq!(
            names(dir.path()),
            BTreeSet::from(["mirror.pdf".to_string(), "source.pdf".to_string()])
        );
    }

    #[test]
    fn a_created_record_never_lands_over_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("moved.pdf");
        create_record(&record, |staged| write_stage(staged, b"first")).unwrap();
        assert_eq!(std::fs::read(&record).unwrap(), b"first");

        let refused = create_record(&record, |staged| write_stage(staged, b"second"));
        assert_eq!(refused.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&record).unwrap(), b"first");
        assert_eq!(names(dir.path()), BTreeSet::from(["moved.pdf".to_string()]));
    }

    #[test]
    fn a_missing_record_reads_as_absent_and_an_unreadable_one_as_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record.json");
        assert_eq!(read_record(&record).unwrap(), None);
        std::fs::write(&record, b"{}").unwrap();
        assert_eq!(read_record(&record).unwrap(), Some(b"{}".to_vec()));
        let folder = dir.path().join("folder.json");
        std::fs::create_dir(&folder).unwrap();
        assert!(read_record(&folder).is_err());
    }

    #[test]
    fn a_rename_that_would_clobber_refuses_and_moves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("from");
        let to = dir.path().join("to");
        std::fs::write(&from, b"from").unwrap();
        std::fs::write(&to, b"to").unwrap();
        let refused = rename_no_clobber(&from, &to).unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read(&from).unwrap(), b"from");
        assert_eq!(std::fs::read(&to).unwrap(), b"to");

        let free = dir.path().join("free");
        rename_no_clobber(&from, &free).unwrap();
        assert!(!from.exists());
        assert_eq!(std::fs::read(&free).unwrap(), b"from");
    }

    #[test]
    fn an_unreadable_record_is_set_aside_and_never_over_another() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("startup.json");
        std::fs::write(&record, b"{\"startMinim").unwrap();
        let first = set_aside(&record).unwrap();
        assert_eq!(first, dir.path().join("startup.json.unreadable"));
        assert!(!record.exists());

        std::fs::write(&record, b"\x00\x00").unwrap();
        let second = set_aside(&record).unwrap();
        assert_eq!(second, dir.path().join("startup.json.unreadable-2"));
        assert_eq!(std::fs::read(&first).unwrap(), b"{\"startMinim");
        assert_eq!(std::fs::read(&second).unwrap(), b"\x00\x00");

        // Nothing to set aside is an error, not a success.
        assert!(set_aside(&record).is_err());
    }

    // ── Stages that carry no process id ───────────────────────────────────

    fn legacy(name: &str) -> bool {
        name.starts_with("legacy-")
    }

    fn born(path: &Path) -> SystemTime {
        std::fs::metadata(path).unwrap().created().unwrap()
    }

    #[test]
    fn a_legacy_stage_goes_only_once_it_has_existed_the_full_age() {
        let dir = tempfile::tempdir().unwrap();
        let stage = dir.path().join("legacy-stage");
        std::fs::write(&stage, b"x").unwrap();
        let age = Duration::from_secs(3600);
        let created = born(&stage);

        let just_short = created + age - Duration::from_nanos(100);
        assert_eq!(reclaim_aged(dir.path(), legacy, age, just_short), 0);
        assert!(stage.exists());
        // A clock that reads before the file's creation proves nothing.
        assert_eq!(
            reclaim_aged(dir.path(), legacy, age, created - Duration::from_secs(1)),
            0
        );
        assert!(stage.exists());

        assert_eq!(reclaim_aged(dir.path(), legacy, age, created + age), 1);
        assert!(!stage.exists());
    }

    #[test]
    fn only_a_file_the_legacy_pattern_names_is_reclaimed_by_age() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["legacy-a", "legacy-b", "document.pdf", "record.json"] {
            std::fs::write(dir.path().join(name), name).unwrap();
        }
        std::fs::create_dir(dir.path().join("legacy-folder")).unwrap();
        let later = SystemTime::now() + LEGACY_STAGE_AGE + Duration::from_secs(60);

        assert_eq!(reclaim_aged(dir.path(), legacy, LEGACY_STAGE_AGE, later), 2);
        assert_eq!(
            names(dir.path()),
            ["document.pdf", "legacy-folder", "record.json"]
                .map(String::from)
                .into()
        );
        assert_eq!(
            reclaim_aged(&dir.path().join("absent"), legacy, LEGACY_STAGE_AGE, later),
            0
        );
    }

    /// A copy carries its source's write time. A stage filled a moment ago
    /// from an old document reads as old by that clock and is still in flight.
    #[test]
    fn age_is_counted_from_creation_not_from_the_last_write() {
        let dir = tempfile::tempdir().unwrap();
        let stage = dir.path().join("legacy-fresh-copy");
        let file = std::fs::File::create(&stage).unwrap();
        let long_ago = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
        file.set_modified(long_ago).unwrap();
        drop(file);
        assert_eq!(std::fs::metadata(&stage).unwrap().modified().unwrap(), long_ago);

        let now = born(&stage) + Duration::from_secs(60);
        assert_eq!(reclaim_aged(dir.path(), legacy, LEGACY_STAGE_AGE, now), 0);
        assert!(stage.exists());
    }

    // ── Exports ───────────────────────────────────────────────────────────

    #[cfg(windows)]
    #[test]
    fn only_a_folder_that_denies_a_new_file_reads_as_denying_creation() {
        let dir = tempfile::tempdir().unwrap();
        let open = dir.path().join("open");
        let closed = dir.path().join("closed");
        std::fs::create_dir(&open).unwrap();
        std::fs::create_dir(&closed).unwrap();
        assert!(!create_denied(&open));
        assert!(!create_denied(&dir.path().join("absent")));

        let _denied = Denied::create(&closed, &[]);
        assert!(create_denied(&closed));
        let access = io::Error::from(io::ErrorKind::PermissionDenied);
        assert!(refused_for_create(&access, &closed));
        assert!(!refused_for_create(&access, &open));
        let taken = io::Error::from(io::ErrorKind::AlreadyExists);
        assert!(!refused_for_create(&taken, &closed));
    }

    #[cfg(windows)]
    #[test]
    fn an_export_is_rewritten_in_place_where_the_folder_refuses_a_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let report = dir.path().join("scan-test-report.json");
        let scan = dir.path().join("page-0000.bmp");
        std::fs::write(&report, b"an earlier and longer report").unwrap();
        std::fs::write(&scan, b"BM an earlier and longer page").unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let page = elsewhere.path().join("page-0000.bmp");
        std::fs::write(&page, b"BM this run").unwrap();

        {
            let _denied = Denied::create(dir.path(), &[&report, &scan]);
            export_record(&report, b"this report").unwrap();
            assert_eq!(export_copy(&page, &scan).unwrap(), 11);
            let new = dir.path().join("new-report.json");
            let refused = export_record(&new, b"needs a new file").unwrap_err();
            assert_eq!(refused.kind(), io::ErrorKind::PermissionDenied);
            assert!(write_record(&report, b"not an export").is_err());
        }

        assert_eq!(std::fs::read(&report).unwrap(), b"this report");
        assert_eq!(std::fs::read(&scan).unwrap(), b"BM this run");
        assert_eq!(
            names(dir.path()),
            ["page-0000.bmp", "scan-test-report.json"].map(String::from).into()
        );
    }

    /// A folder under the stage's name refuses the stage for access too, in a
    /// folder that accepts new files. Nothing is written in place.
    #[test]
    fn an_export_refused_for_another_reason_leaves_the_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("scan-test-report.json");
        std::fs::write(&record, b"the earlier report").unwrap();
        let source = dir.path().join("source.bin");
        std::fs::write(&source, b"the new bytes").unwrap();
        std::fs::create_dir(stage_path(&record, std::process::id())).unwrap();

        assert!(export_record(&record, b"a new report").is_err());
        assert!(export_copy(&source, &record).is_err());
        assert_eq!(std::fs::read(&record).unwrap(), b"the earlier report");
    }

    #[cfg(windows)]
    #[test]
    fn only_a_refused_delete_of_the_file_and_of_its_folder_s_child_denies_a_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("report.json");
        std::fs::write(&target, b"{}").unwrap();
        assert!(!replace_denied(&target));
        assert!(!replace_denied(&dir.path().join("absent.json")));
        {
            let _file_only = Denied::only(&target, "(DE)");
            assert!(!replace_denied(&target));
        }
        {
            let _folder_only = Denied::only(dir.path(), "(DC)");
            assert!(!replace_denied(&target));
        }
        let _both = Denied::replace(dir.path(), &target);
        assert!(replace_denied(&target));
    }

    #[cfg(windows)]
    #[test]
    fn an_export_is_rewritten_in_place_where_the_folder_refuses_its_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let report = dir.path().join("scan-test-report.json");
        let scan = dir.path().join("page-0000.bmp");
        std::fs::write(&report, b"an earlier and longer report").unwrap();
        std::fs::write(&scan, b"BM an earlier and longer page").unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let page = elsewhere.path().join("page-0000.bmp");
        std::fs::write(&page, b"BM this run").unwrap();
        let (report_file, scan_file) = (file_id(&report), file_id(&scan));

        {
            let _report = Denied::replace(dir.path(), &report);
            let _scan = Denied::only(&scan, "(DE)");
            export_record(&report, b"this report").unwrap();
            assert_eq!(export_copy(&page, &scan).unwrap(), 11);
            assert!(write_record(&report, b"not an export").is_err());
        }

        assert_eq!(std::fs::read(&report).unwrap(), b"this report");
        assert_eq!(std::fs::read(&scan).unwrap(), b"BM this run");
        assert_eq!(file_id(&report), report_file, "the report was not written in place");
        assert_eq!(file_id(&scan), scan_file, "the scan was not written in place");
        assert_eq!(
            names(dir.path()),
            ["page-0000.bmp", "scan-test-report.json"].map(String::from).into()
        );
    }

    #[test]
    fn an_export_lands_through_the_stage_where_the_folder_allows_it() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("scan-test-report.txt");
        let source = dir.path().join("source.bin");
        std::fs::write(&source, b"copied bytes").unwrap();
        export_record(&record, b"first").unwrap();
        #[cfg(windows)]
        let first = file_id(&record);
        export_record(&record, b"second").unwrap();
        #[cfg(windows)]
        assert_ne!(file_id(&record), first, "written in place, not through the stage");
        assert_eq!(std::fs::read(&record).unwrap(), b"second");
        let copy = dir.path().join("copy.bin");
        assert_eq!(export_copy(&source, &copy).unwrap(), 12);
        assert_eq!(std::fs::read(&copy).unwrap(), b"copied bytes");
        assert_eq!(
            names(dir.path()),
            ["copy.bin", "scan-test-report.txt", "source.bin"]
                .map(String::from)
                .into()
        );
    }
}
