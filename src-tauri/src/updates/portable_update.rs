//! The portable container's update: the verified archive is extracted into a
//! staging tree beside the payload, and after the app has exited a helper
//! moves each payload entry aside and the staged entry into its place.
//!
//! Only names the new archive carries are touched. The data root, the update
//! folder and the install record are reserved names an archive may not carry,
//! so a user's records never move.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const UPDATE_DIR: &str = ".spectra-update";
pub const MAIN_EXE: &str = "spectrapdf.exe";
pub const HELPER_EXE: &str = "spectrapdf-update-helper.exe";

const RESERVED_TOP_LEVEL: [&str; 4] = [
    crate::portable::PORTABLE_DATA_DIR,
    UPDATE_DIR,
    crate::portable::INSTALL_RECORD,
    "install-record.json.tmp",
];

const MAX_ENTRIES: usize = 250_000;
const MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_NAME_BYTES: usize = 1024;

/// Every path the portable update uses, under one root.
#[derive(Debug, Clone)]
pub struct Layout {
    pub root: PathBuf,
    pub dir: PathBuf,
    pub download: PathBuf,
    pub staging: PathBuf,
    pub staged: PathBuf,
    pub staged_record: PathBuf,
    pub backup: PathBuf,
    pub helper: PathBuf,
    pub last_apply: PathBuf,
    /// The version whose apply failed ([`super::FailedRecord`]).
    pub failed: PathBuf,
    /// The swap journal ([`SwapRecord`]).
    pub swap_record: PathBuf,
    /// The executable's copy on its way to `backup` or `staged`.
    exe_copy: PathBuf,
    /// Root executables a rollback renamed aside because they were running;
    /// a running image can be renamed but not replaced or deleted.
    pub retired: PathBuf,
}

impl Layout {
    pub fn new(root: &Path) -> Self {
        let dir = root.join(UPDATE_DIR);
        Layout {
            root: root.to_path_buf(),
            download: dir.join("download"),
            staging: dir.join("staged.tmp"),
            staged: dir.join("staged"),
            staged_record: dir.join("staged.json"),
            backup: dir.join("backup"),
            helper: dir.join("helper"),
            last_apply: dir.join("last-apply.json"),
            failed: dir.join("failed.json"),
            swap_record: dir.join("swap.json"),
            exe_copy: dir.join("exe-copy.tmp"),
            retired: dir.join("retired"),
            dir,
        }
    }

    /// Written by the new executable's self-check; its presence is what the
    /// helper waits for, and what lets the new version's first start remove
    /// the backup.
    pub fn started_marker(&self, version: &str) -> PathBuf {
        self.dir.join(format!("started-{version}"))
    }

    /// Removes every retired executable whose process has ended. One that
    /// still runs cannot be deleted and stays for a later start.
    pub fn clear_retired(&self) {
        let Ok(entries) = fs::read_dir(&self.retired) else {
            return;
        };
        for entry in entries.flatten() {
            let _ = fs::remove_file(entry.path());
        }
        let _ = fs::remove_dir(&self.retired);
    }
}

fn is_reserved_top_level(name: &str) -> bool {
    RESERVED_TOP_LEVEL.iter().any(|r| r.eq_ignore_ascii_case(name))
}

fn is_device_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or("").trim_end();
    let upper = stem.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") {
        return true;
    }
    let mut chars = stem.chars();
    let prefix: String = chars.by_ref().take(3).collect::<String>().to_ascii_uppercase();
    let rest: String = chars.collect();
    (prefix == "COM" || prefix == "LPT")
        && (matches!(rest.as_str(), "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            || matches!(rest.as_str(), "\u{b9}" | "\u{b2}" | "\u{b3}"))
}

/// The components of one archive entry name and whether it names a folder.
/// Refuses every name that could leave the staging tree or that Windows would
/// read as something other than the plain relative path it spells.
pub fn entry_components(name: &str) -> Result<(Vec<String>, bool), String> {
    let refuse = |why: &str| Err(format!("The archive entry {name:?} {why}"));
    if name.is_empty() || name.len() > MAX_NAME_BYTES {
        return refuse("has no usable name");
    }
    if name.contains('\\') {
        return refuse("uses a backslash");
    }
    if name.contains(':') {
        return refuse("names a drive or a stream");
    }
    if name.starts_with('/') {
        return refuse("is an absolute path");
    }
    let is_dir = name.ends_with('/');
    let body = name.strip_suffix('/').unwrap_or(name);
    let mut components = Vec::new();
    for component in body.split('/') {
        if component.is_empty() {
            return refuse("has an empty path segment");
        }
        if component == "." || component == ".." {
            return refuse("leaves its folder");
        }
        if component.ends_with('.') || component.ends_with(' ') {
            return refuse("ends a segment with a dot or a space");
        }
        if component
            .chars()
            .any(|c| (c as u32) < 0x20 || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
        {
            return refuse("holds a character a file name cannot hold");
        }
        if is_device_name(component) {
            return refuse("names a device");
        }
        components.push(component.to_string());
    }
    if is_reserved_top_level(&components[0]) {
        return refuse("is outside the application files");
    }
    Ok((components, is_dir))
}

const S_IFMT: u32 = 0o170000;
const S_IFREG: u32 = 0o100000;
const S_IFDIR: u32 = 0o040000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Dir,
}

/// The checked archive: its total uncompressed size and entry count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    pub total: u64,
    pub entries: usize,
}

/// Reads the whole central directory and refuses the archive before anything
/// is written when any entry fails a rule.
pub fn plan<R: Read + std::io::Seek>(archive: &mut zip::ZipArchive<R>) -> Result<Plan, String> {
    if archive.len() > MAX_ENTRIES {
        return Err(format!("The archive holds more than {MAX_ENTRIES} entries"));
    }
    let mut seen: HashMap<String, Kind> = HashMap::new();
    let mut total = 0u64;
    let mut has_exe = false;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|e| format!("The archive cannot be read: {e}"))?;
        if entry.encrypted() {
            return Err("The archive holds an encrypted entry".to_string());
        }
        if entry.is_symlink() {
            return Err(format!("The archive entry {:?} is a link", entry.name_raw()));
        }
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & S_IFMT;
            if kind != 0 && kind != S_IFREG && kind != S_IFDIR {
                return Err("The archive holds an entry that is not a file or a folder".to_string());
            }
        }
        let name = entry
            .name()
            .map_err(|e| format!("The archive holds an unreadable name: {e}"))?
            .into_owned();
        let (components, is_dir) = entry_components(&name)?;
        let is_dir = is_dir || entry.is_dir();
        let mut key = String::new();
        for (depth, component) in components.iter().enumerate() {
            if depth > 0 {
                key.push('/');
            }
            key.push_str(&component.to_lowercase());
            let last = depth + 1 == components.len();
            let kind = if last && !is_dir { Kind::File } else { Kind::Dir };
            match seen.get(&key) {
                None => {
                    seen.insert(key.clone(), kind);
                }
                Some(Kind::Dir) if kind == Kind::Dir => {}
                Some(_) => return Err(format!("The archive names {name:?} twice")),
            }
        }
        if !is_dir {
            total = total
                .checked_add(entry.size())
                .filter(|t| *t <= MAX_TOTAL_BYTES)
                .ok_or_else(|| "The archive is larger than an update can be".to_string())?;
            if components.len() == 1 && components[0].eq_ignore_ascii_case(MAIN_EXE) {
                has_exe = true;
            }
        }
    }
    if !has_exe {
        return Err(format!("The archive carries no {MAIN_EXE}"));
    }
    Ok(Plan {
        total,
        entries: archive.len(),
    })
}

/// Extracts a checked archive into `dest`, which must not exist. Every file is
/// created new; the decompressor's checksum and the declared size are both
/// required to match.
pub fn extract(
    archive_path: &Path,
    dest: &Path,
    mut admit: impl FnMut(Plan) -> Result<(), String>,
) -> Result<Plan, String> {
    let file = fs::File::open(archive_path)
        .map_err(|e| format!("Cannot open {}: {e}", archive_path.display()))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("The archive cannot be read: {e}"))?;
    let plan = plan(&mut archive)?;
    admit(plan)?;
    fs::create_dir(dest).map_err(|e| format!("Cannot create {}: {e}", dest.display()))?;
    let result = (|| {
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|e| format!("The archive cannot be read: {e}"))?;
            let name = entry
                .name()
                .map_err(|e| format!("The archive holds an unreadable name: {e}"))?
                .into_owned();
            let (components, is_dir) = entry_components(&name)?;
            let mut target = dest.to_path_buf();
            for component in &components {
                target.push(component);
            }
            if is_dir || entry.is_dir() {
                fs::create_dir_all(&target)
                    .map_err(|e| format!("Cannot create {}: {e}", target.display()))?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
            }
            let out = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|e| format!("Cannot create {}: {e}", target.display()))?;
            let mut writer = std::io::BufWriter::with_capacity(256 * 1024, out);
            let written = std::io::copy(&mut entry, &mut writer)
                .map_err(|e| format!("Cannot extract {name}: {e}"))?;
            if written != entry.size() {
                return Err(format!("{name} is not the size the archive declares"));
            }
            writer
                .into_inner()
                .map_err(|e| format!("Cannot write {}: {}", target.display(), e.error()))?
                .sync_all()
                .map_err(|e| format!("Cannot write {}: {e}", target.display()))?;
        }
        Ok(plan)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(dest);
    }
    result
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SwapError {
    /// The swap failed and every moved entry is back where it was.
    RolledBack(String),
    /// The swap failed and at least one entry could not be moved back; the
    /// message names what is where. The swap record stays for the next try.
    Incomplete(String),
}

impl std::fmt::Display for SwapError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SwapError::RolledBack(m) | SwapError::Incomplete(m) => f.write_str(m),
        }
    }
}

/// The swap journal. It is written before the first move and removed only
/// when the swap is complete or fully undone, so a swap cut off by a crash or
/// a power loss is finished or rolled back at the next start or apply.
///
/// Every move is one rename, and the state of each name is read back from
/// the three folders, so the record holds no per-move progress:
/// - another entry: placed when `staged/<name>` is gone; set aside when
///   `backup/<name>` exists.
/// - the executable: copied to `backup/` and then renamed over the old one,
///   so the root never lacks an executable; placed when `staged/<exe>` is
///   gone.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapRecord {
    pub version: String,
    pub helper_pid: u32,
    /// The helper's creation time ([`super::proc::creation_time`]); 0 when
    /// unknown. A process with this pid and another creation time is not the
    /// helper.
    #[serde(default)]
    pub helper_started: u64,
    /// Top-level names in move order; the executable is last.
    pub names: Vec<String>,
    pub rolling_back: bool,
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn retried(mut step: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match step() {
            Ok(()) => return Ok(()),
            Err(error) if attempt < 4 && error.kind() != std::io::ErrorKind::NotFound => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(error) => return Err(error),
        }
    }
}

/// A rename that never replaces: a scanner or indexer briefly holding a fresh
/// file is waited out a bounded number of times.
fn move_entry(from: &Path, to: &Path) -> std::io::Result<()> {
    if exists(to) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("{} already exists", to.display()),
        ));
    }
    retried(|| fs::rename(from, to))
}

/// A rename over an existing file in one step.
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    retried(|| fs::rename(from, to))
}

/// Copies `from` to `to` through `scratch`, flushed to disk before the final
/// rename, so `to` never holds a partial copy.
fn copy_durably(from: &Path, to: &Path, scratch: &Path) -> std::io::Result<()> {
    let _ = fs::remove_file(scratch);
    fs::copy(from, scratch)?;
    fs::OpenOptions::new().write(true).open(scratch)?.sync_all()?;
    move_entry(scratch, to)
}

/// Whether two files hold the same bytes; false when either cannot be read.
fn same_contents(a: &Path, b: &Path) -> bool {
    let (Ok(mut a), Ok(mut b)) = (fs::File::open(a), fs::File::open(b)) else {
        return false;
    };
    if a.metadata().map(|m| m.len()).ok() != b.metadata().map(|m| m.len()).ok() {
        return false;
    }
    let mut left = vec![0u8; 64 * 1024];
    let mut right = vec![0u8; 64 * 1024];
    loop {
        let Ok(n) = read_full(&mut a, &mut left) else { return false };
        let Ok(m) = read_full(&mut b, &mut right) else { return false };
        if n != m || left[..n] != right[..m] {
            return false;
        }
        if n == 0 {
            return true;
        }
    }
}

fn read_full(file: &mut fs::File, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match file.read(&mut buffer[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

fn is_exe(name: &str) -> bool {
    name.eq_ignore_ascii_case(MAIN_EXE)
}

fn staged_names(staged: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    for entry in fs::read_dir(staged).map_err(|e| format!("Cannot read {}: {e}", staged.display()))? {
        let entry = entry.map_err(|e| format!("Cannot read {}: {e}", staged.display()))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "A staged entry has a name that is not text".to_string())?;
        if is_reserved_top_level(&name) {
            return Err(format!("The staged tree carries {name}, which is not application files"));
        }
        names.push(name);
    }
    if !names.iter().any(|n| is_exe(n)) {
        return Err(format!("The staged tree carries no {MAIN_EXE}"));
    }
    names.sort();
    let exe = names.iter().position(|n| is_exe(n)).unwrap_or(0);
    let exe = names.remove(exe);
    names.push(exe);
    Ok(names)
}

fn place(layout: &Layout, name: &str) -> Result<(), String> {
    let current = layout.root.join(name);
    if is_exe(name) {
        if exists(&current) {
            copy_durably(&current, &layout.backup.join(name), &layout.exe_copy)
                .map_err(|e| format!("{} could not be set aside: {e}", current.display()))?;
        }
        return replace_file(&layout.staged.join(name), &current)
            .map_err(|e| format!("{} could not be put in place: {e}", current.display()));
    }
    if exists(&current) {
        move_entry(&current, &layout.backup.join(name))
            .map_err(|e| format!("{} could not be set aside: {e}", current.display()))?;
    }
    move_entry(&layout.staged.join(name), &current)
        .map_err(|e| format!("{} could not be put in place: {e}", current.display()))
}

/// Puts the backed-up executable back in the root. A rename over the current
/// one is tried first, so the root never lacks an executable. When the current
/// one is a running image, which no rename can replace, it is renamed into
/// `retired` first and the backup is moved into the free name.
fn restore_exe(layout: &Layout, backup: &Path, current: &Path) -> std::io::Result<()> {
    let replaced = match replace_file(backup, current) {
        Ok(()) => return Ok(()),
        Err(error) if exists(current) => error,
        Err(error) => return Err(error),
    };
    fs::create_dir_all(&layout.retired)?;
    let aside = layout.retired.join(format!(
        "{}-{MAIN_EXE}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ));
    if fs::rename(current, &aside).is_err() {
        return Err(replaced);
    }
    if let Err(error) = retried(|| fs::rename(backup, current)) {
        let _ = fs::rename(&aside, current);
        return Err(error);
    }
    Ok(())
}

/// Puts every name back from what the three folders show, last name first.
/// Each step runs only when its own state is found, so a second run after an
/// interruption finishes the first. Returns what could not be moved back.
fn roll_back(layout: &Layout, names: &[String]) -> Vec<String> {
    let mut failures = Vec::new();
    for name in names.iter().rev() {
        let current = layout.root.join(name);
        let staged = layout.staged.join(name);
        let backup = layout.backup.join(name);
        if is_exe(name) {
            // Cut off after the backup copy and before the rename: the root
            // still holds the old executable, possibly as the running image,
            // and the backup is a duplicate of it. A rollback cut off after
            // copying the new executable back to `staged` has the same three
            // entries, but the root then holds the new bytes.
            if exists(&staged) && exists(&backup) && same_contents(&current, &backup) {
                if let Err(e) = fs::remove_file(&backup) {
                    failures.push(format!("{} could not be removed: {e}", backup.display()));
                }
                continue;
            }
            if !exists(&staged) && exists(&current) {
                if let Err(e) = copy_durably(&current, &staged, &layout.exe_copy) {
                    failures.push(format!("{} could not move back to {}: {e}", current.display(), staged.display()));
                    continue;
                }
            }
            if exists(&backup) {
                if let Err(e) = restore_exe(layout, &backup, &current) {
                    failures.push(format!("{} could not move back to {}: {e}", backup.display(), current.display()));
                }
            }
            continue;
        }
        if !exists(&staged) && exists(&current) {
            if let Err(e) = move_entry(&current, &staged) {
                failures.push(format!("{} could not move back to {}: {e}", current.display(), staged.display()));
                continue;
            }
        }
        if exists(&backup) && !exists(&current) {
            if let Err(e) = move_entry(&backup, &current) {
                failures.push(format!("{} could not move back to {}: {e}", backup.display(), current.display()));
            }
        }
    }
    failures
}

fn undo(layout: &Layout, record: &mut SwapRecord) -> Vec<String> {
    record.rolling_back = true;
    if let Err(e) = write_json(&layout.swap_record, record) {
        return vec![e];
    }
    let failures = roll_back(layout, &record.names);
    if failures.is_empty() {
        let _ = fs::remove_file(&layout.swap_record);
    }
    failures
}

/// Moves every staged entry into the root, setting aside what it replaces in
/// `backup` (which must exist and be empty), then runs `self_check` against
/// the new tree. Any failure, the self-check included, moves everything back.
/// The swap record is written before the first move and removed when the swap
/// is complete or undone.
pub fn swap(
    layout: &Layout,
    version: &str,
    helper_pid: u32,
    helper_started: u64,
    self_check: impl FnOnce() -> Result<(), String>,
) -> Result<(), SwapError> {
    if exists(&layout.swap_record) {
        return Err(SwapError::Incomplete("An earlier swap is not finished".to_string()));
    }
    let names = staged_names(&layout.staged).map_err(SwapError::RolledBack)?;
    let mut record = SwapRecord {
        version: version.to_string(),
        helper_pid,
        helper_started,
        names,
        rolling_back: false,
    };
    write_json(&layout.swap_record, &record).map_err(SwapError::RolledBack)?;
    let mut failure = record.names.iter().find_map(|name| place(layout, name).err());
    if failure.is_none() {
        if let Err(error) = self_check() {
            failure = Some(format!("The new version did not start: {error}"));
        }
    }
    let Some(failure) = failure else {
        let _ = fs::remove_file(&layout.swap_record);
        return Ok(());
    };
    let undone = undo(layout, &mut record);
    if undone.is_empty() {
        Err(SwapError::RolledBack(failure))
    } else {
        Err(SwapError::Incomplete(format!("{failure}; {}", undone.join("; "))))
    }
}

/// What [`recover`] found and did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recovery {
    /// No swap record.
    None,
    /// The helper that wrote the record is still running.
    Busy,
    /// Every entry was in place and the new version had started; the record
    /// is removed.
    Finished(String),
    /// Every entry is back where it was; the record is removed.
    RolledBack(String),
    /// At least one entry could not be moved back; the record stays.
    Incomplete(String),
}

/// Finishes or rolls back a swap that a crash or a power loss cut off.
/// `running` is the version of the calling executable when that executable
/// is the root's own one: a running new executable proves the swap placed
/// it. `helper_alive` says whether the helper the record names still runs.
pub fn recover(layout: &Layout, running: Option<&str>, helper_alive: impl FnOnce(&SwapRecord) -> bool) -> Recovery {
    let Some(mut record) = read_json::<SwapRecord>(&layout.swap_record) else {
        if exists(&layout.swap_record) {
            return Recovery::Incomplete("The swap record cannot be read".to_string());
        }
        return Recovery::None;
    };
    if helper_alive(&record) {
        return Recovery::Busy;
    }
    let complete = !record.rolling_back && record.names.iter().all(|n| !exists(&layout.staged.join(n)));
    let started = layout.started_marker(&record.version).is_file() || running == Some(record.version.as_str());
    if complete && started {
        let _ = fs::remove_file(&layout.swap_record);
        return Recovery::Finished(record.version);
    }
    let failures = undo(layout, &mut record);
    if failures.is_empty() {
        Recovery::RolledBack(record.version)
    } else {
        Recovery::Incomplete(failures.join("; "))
    }
}

/// Empties `backup` for a new swap. Refuses while a swap record exists, so a
/// backup that a cut-off swap still needs is never removed.
pub fn renew_backup(layout: &Layout) -> Result<(), String> {
    if exists(&layout.swap_record) {
        return Err("An earlier swap is not finished".to_string());
    }
    let _ = fs::remove_dir_all(&layout.backup);
    fs::create_dir_all(&layout.backup).map_err(|e| format!("Cannot create {}: {e}", layout.backup.display()))
}

/// The record of what is staged, written after extraction completes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StagedRecord {
    pub version: String,
    /// Prepared without an Install click.
    #[serde(default = "super::automatic_by_default")]
    pub automatic: bool,
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let text = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temp).map_err(|e| format!("Cannot write {}: {e}", temp.display()))?;
    file.write_all(&text)
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("Cannot write {}: {e}", temp.display()))?;
    drop(file);
    fs::rename(&temp, path).map_err(|e| format!("Cannot write {}: {e}", path.display()))
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(64 * 1024)
        .read_to_string(&mut text)
        .ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Seek;

    fn zip_of(entries: &[(&str, &[u8])]) -> zip::ZipArchive<std::io::Cursor<Vec<u8>>> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in entries {
            if name.ends_with('/') {
                writer.add_directory(*name, options).unwrap();
            } else {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
        }
        let mut cursor = writer.finish().unwrap();
        cursor.rewind().unwrap();
        zip::ZipArchive::new(cursor).unwrap()
    }

    #[test]
    fn entry_names_that_leave_the_tree_or_alias_another_path_are_refused() {
        for name in [
            "", "/spectrapdf.exe", "../spectrapdf.exe", "engine/../../x", "engine/./x",
            "engine\\x.py", "C:/Windows/x", "C:x", "engine/x.py:stream", "engine//x",
            "engine/x.", "engine/x ", "engine/CON", "engine/nul.txt", "engine/COM1.log",
            "engine/lpt9", "engine/a*b", "engine/a?b", "engine/a\u{1}b", "data/settings.json",
            "DATA/x", ".spectra-update/staged/x", "install-record.json", "Install-Record.json",
        ] {
            assert!(entry_components(name).is_err(), "{name:?} was accepted");
        }
    }

    #[test]
    fn ordinary_payload_names_are_accepted() {
        assert_eq!(
            entry_components("engine/sub/main.py").unwrap(),
            (vec!["engine".into(), "sub".into(), "main.py".into()], false)
        );
        assert_eq!(entry_components("fonts/").unwrap(), (vec!["fonts".into()], true));
        assert!(entry_components("spectrapdf.exe").is_ok());
        assert!(entry_components("python/Lib/site-packages/console.py").is_ok());
        assert!(entry_components("dictionaries/data.dic").is_ok());
    }

    #[test]
    fn an_archive_with_a_link_a_duplicate_or_no_executable_is_refused_before_writing() {
        assert!(plan(&mut zip_of(&[("spectrapdf.exe", b"x"), ("engine/a.py", b"1")])).is_ok());
        assert!(plan(&mut zip_of(&[("engine/a.py", b"1")])).unwrap_err().contains("no spectrapdf.exe"));
        assert!(plan(&mut zip_of(&[("spectrapdf.exe", b"x"), ("Engine/A.py", b"1"), ("engine/a.py", b"2")]))
            .unwrap_err()
            .contains("twice"));
        assert!(plan(&mut zip_of(&[("spectrapdf.exe", b"x"), ("engine", b"1"), ("engine/a.py", b"2")]))
            .unwrap_err()
            .contains("twice"));
        assert!(plan(&mut zip_of(&[("spectrapdf.exe", b"x"), ("../evil.exe", b"1")])).is_err());

        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer.start_file("spectrapdf.exe", options).unwrap();
        writer.write_all(b"x").unwrap();
        writer.add_symlink("engine", "C:/Windows", options).unwrap();
        let mut cursor = writer.finish().unwrap();
        cursor.rewind().unwrap();
        let error = plan(&mut zip::ZipArchive::new(cursor).unwrap()).unwrap_err();
        assert!(error.contains("is a link"), "{error}");
    }

    #[test]
    fn the_signed_fixture_archive_extracts_into_a_fresh_tree() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("update.zip");
        fs::write(&archive, crate::updates::verify::fixtures::PORTABLE).unwrap();
        let dest = temp.path().join("staged.tmp");
        let plan = extract(&archive, &dest, |_| Ok(())).unwrap();
        assert!(plan.entries >= 3);
        assert_eq!(
            fs::read_to_string(dest.join("spectrapdf.exe")).unwrap().trim(),
            "new executable 2026.1101.160"
        );
        assert!(dest.join("engine").join("main.py").is_file());
        assert!(extract(&archive, &dest, |_| Ok(())).is_err(), "an existing destination is refused");
    }

    #[test]
    fn an_admission_refusal_writes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("update.zip");
        fs::write(&archive, crate::updates::verify::fixtures::PORTABLE).unwrap();
        let dest = temp.path().join("staged.tmp");
        let error = extract(&archive, &dest, |_| Err("no space".to_string())).unwrap_err();
        assert_eq!(error, "no space");
        assert!(!dest.exists());
    }

    struct Tree {
        _temp: tempfile::TempDir,
        root: PathBuf,
        layout: Layout,
    }

    fn tree() -> Tree {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Spectra PDF");
        let layout = Layout::new(&root);
        fs::create_dir_all(root.join("engine")).unwrap();
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join(MAIN_EXE), "old exe").unwrap();
        fs::write(root.join("engine").join("main.py"), "old engine").unwrap();
        fs::write(root.join("notes.txt"), "old notes").unwrap();
        fs::write(root.join("data").join("settings.json"), "user settings").unwrap();
        fs::create_dir_all(layout.staged.join("engine")).unwrap();
        fs::create_dir_all(layout.staged.join("fonts")).unwrap();
        fs::write(layout.staged.join(MAIN_EXE), "new exe").unwrap();
        fs::write(layout.staged.join("engine").join("main.py"), "new engine").unwrap();
        fs::write(layout.staged.join("notes.txt"), "new notes").unwrap();
        fs::write(layout.staged.join("fonts").join("a.ttf"), "font").unwrap();
        fs::create_dir_all(&layout.backup).unwrap();
        Tree { _temp: temp, root, layout }
    }

    fn read(path: PathBuf) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn a_swap_puts_every_staged_entry_in_place_and_keeps_user_data() {
        let t = tree();
        swap(&t.layout, V, 0, 0, || Ok(())).unwrap();
        assert!(!t.layout.swap_record.exists());
        assert_eq!(read(t.root.join(MAIN_EXE)), "new exe");
        assert_eq!(read(t.root.join("engine").join("main.py")), "new engine");
        assert_eq!(read(t.root.join("notes.txt")), "new notes");
        assert_eq!(read(t.root.join("fonts").join("a.ttf")), "font");
        assert_eq!(read(t.root.join("data").join("settings.json")), "user settings");
        assert_eq!(read(t.layout.backup.join(MAIN_EXE)), "old exe");
        assert_eq!(read(t.layout.backup.join("engine").join("main.py")), "old engine");
    }

    #[test]
    fn a_swap_keeps_the_color_profile_answer_and_every_root_entry_the_archive_does_not_carry() {
        let t = tree();
        let assent = t.root.join(crate::portable::PORTABLE_DATA_DIR).join(crate::portable::ICC_ASSENT_FILE);
        fs::write(&assent, "{\"adobeIccEulaAccepted\": true}").unwrap();
        fs::write(t.root.join("my-notes.pdf"), "user file").unwrap();
        fs::create_dir_all(t.root.join("exports")).unwrap();
        fs::write(t.root.join("exports").join("a.pdf"), "export").unwrap();
        fs::write(t.layout.dir.join("keep.txt"), "update folder file").unwrap();
        swap(&t.layout, V, 0, 0, || Ok(())).unwrap();
        assert_eq!(read(assent.clone()), "{\"adobeIccEulaAccepted\": true}");
        assert_eq!(read(t.root.join("my-notes.pdf")), "user file");
        assert_eq!(read(t.root.join("exports").join("a.pdf")), "export");
        assert_eq!(read(t.layout.dir.join("keep.txt")), "update folder file");
        assert_eq!(read(t.root.join("data").join("settings.json")), "user settings");
        assert!(!t.layout.backup.join("my-notes.pdf").exists());
        assert!(!t.layout.backup.join(crate::portable::PORTABLE_DATA_DIR).exists());
    }

    fn assert_old_tree(t: &Tree) {
        assert_eq!(read(t.root.join(MAIN_EXE)), "old exe");
        assert_eq!(read(t.root.join("engine").join("main.py")), "old engine");
        assert_eq!(read(t.root.join("notes.txt")), "old notes");
        assert!(!t.root.join("fonts").exists());
        assert_eq!(read(t.root.join("data").join("settings.json")), "user settings");
        assert_eq!(read(t.layout.staged.join(MAIN_EXE)), "new exe");
        assert_eq!(read(t.layout.staged.join("fonts").join("a.ttf")), "font");
        assert_eq!(fs::read_dir(&t.layout.backup).unwrap().count(), 0);
        assert!(!t.layout.swap_record.exists());
        assert!(!t.layout.exe_copy.exists());
    }

    #[test]
    fn a_failed_self_check_rolls_the_whole_tree_back() {
        let t = tree();
        let error = swap(&t.layout, V, 0, 0, || {
            assert_eq!(read(t.root.join(MAIN_EXE)), "new exe");
            assert!(t.layout.swap_record.exists(), "the record covers the self-check");
            Err("exit 1".to_string())
        })
        .unwrap_err();
        assert!(matches!(error, SwapError::RolledBack(ref m) if m.contains("exit 1")), "{error:?}");
        assert_old_tree(&t);
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_payload_file_rolls_the_swap_back() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = tree();
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(t.root.join("notes.txt"))
            .unwrap();
        let error = swap(&t.layout, V, 0, 0, || Ok(())).unwrap_err();
        drop(held);
        assert!(
            matches!(error, SwapError::RolledBack(ref m) if m.contains("notes.txt")),
            "{error:?}"
        );
        assert_old_tree(&t);
    }

    #[test]
    fn a_staged_tree_carrying_a_reserved_name_is_refused_untouched() {
        let t = tree();
        fs::create_dir_all(t.layout.staged.join("data")).unwrap();
        let error = swap(&t.layout, V, 0, 0, || Ok(())).unwrap_err();
        assert!(matches!(error, SwapError::RolledBack(_)));
        assert_eq!(read(t.root.join(MAIN_EXE)), "old exe");
    }

    const V: &str = "2026.1101.160";

    fn begin(t: &Tree, rolling_back: bool) -> Vec<String> {
        let names = staged_names(&t.layout.staged).unwrap();
        let record = SwapRecord {
            version: V.to_string(),
            helper_pid: 0,
            helper_started: 0,
            names: names.clone(),
            rolling_back,
        };
        write_json(&t.layout.swap_record, &record).unwrap();
        names
    }

    #[test]
    fn a_swap_cut_off_between_two_moves_is_rolled_back_from_its_record() {
        let t = tree();
        begin(&t, false);
        place(&t.layout, "engine").unwrap();
        move_entry(&t.root.join("notes.txt"), &t.layout.backup.join("notes.txt")).unwrap();
        assert_eq!(recover(&t.layout, None, |_| false), Recovery::RolledBack(V.to_string()));
        assert_old_tree(&t);
    }

    #[test]
    fn a_swap_cut_off_inside_the_executable_step_never_leaves_the_root_without_one() {
        let t = tree();
        let names = begin(&t, false);
        for name in &names[..names.len() - 1] {
            place(&t.layout, name).unwrap();
        }
        copy_durably(&t.root.join(MAIN_EXE), &t.layout.backup.join(MAIN_EXE), &t.layout.exe_copy).unwrap();
        assert_eq!(read(t.root.join(MAIN_EXE)), "old exe");
        assert_eq!(recover(&t.layout, None, |_| false), Recovery::RolledBack(V.to_string()));
        assert_old_tree(&t);

        let t = tree();
        let names = begin(&t, false);
        for name in &names {
            place(&t.layout, name).unwrap();
        }
        assert_eq!(read(t.root.join(MAIN_EXE)), "new exe");
        assert_eq!(
            recover(&t.layout, None, |_| false),
            Recovery::RolledBack(V.to_string()),
            "a swap the self-check never confirmed is undone"
        );
        assert_old_tree(&t);
    }

    #[cfg(windows)]
    #[test]
    fn a_swap_cut_off_before_the_executable_rename_rolls_back_under_the_running_old_executable() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        let t = tree();
        let names = begin(&t, false);
        for name in &names[..names.len() - 1] {
            place(&t.layout, name).unwrap();
        }
        copy_durably(&t.root.join(MAIN_EXE), &t.layout.backup.join(MAIN_EXE), &t.layout.exe_copy).unwrap();
        // The old executable runs the start-up recovery, so its image cannot
        // be renamed over.
        let running = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(t.root.join(MAIN_EXE))
            .unwrap();
        let recovery = recover(&t.layout, Some("2026.1014.156"), |_| false);
        drop(running);
        assert_eq!(recovery, Recovery::RolledBack(V.to_string()));
        assert_old_tree(&t);
    }

    #[cfg(windows)]
    #[test]
    fn a_rollback_under_the_running_new_executable_renames_it_aside_and_restores_the_old_one() {
        let t = tree();
        let system = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let new_exe = fs::read(system.join("System32").join("PING.EXE")).unwrap();
        fs::write(t.layout.staged.join(MAIN_EXE), &new_exe).unwrap();
        let names = begin(&t, false);
        for name in &names {
            place(&t.layout, name).unwrap();
        }
        // The new executable runs from the root, as at the start that follows
        // a rollback which copied it back to `staged` and then could not
        // rename over it.
        let mut running = std::process::Command::new(t.root.join(MAIN_EXE))
            .args(["-n", "60", "127.0.0.1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        copy_durably(&t.root.join(MAIN_EXE), &t.layout.staged.join(MAIN_EXE), &t.layout.exe_copy).unwrap();
        let mut record: SwapRecord = read_json(&t.layout.swap_record).unwrap();
        record.rolling_back = true;
        write_json(&t.layout.swap_record, &record).unwrap();
        assert!(
            replace_file(&t.layout.backup.join(MAIN_EXE), &t.root.join(MAIN_EXE)).is_err(),
            "a running image cannot be replaced"
        );

        let recovery = recover(&t.layout, Some(V), |_| false);
        assert_eq!(recovery, Recovery::RolledBack(V.to_string()));
        assert_eq!(read(t.root.join(MAIN_EXE)), "old exe");
        assert_eq!(read(t.root.join("engine").join("main.py")), "old engine");
        assert_eq!(read(t.root.join("notes.txt")), "old notes");
        assert!(!t.root.join("fonts").exists());
        assert_eq!(fs::read(t.layout.staged.join(MAIN_EXE)).unwrap(), new_exe);
        assert_eq!(read(t.layout.staged.join("engine").join("main.py")), "new engine");
        assert_eq!(fs::read_dir(&t.layout.backup).unwrap().count(), 0);
        assert!(!t.layout.swap_record.exists());
        assert_eq!(fs::read_dir(&t.layout.retired).unwrap().count(), 1, "the running image was renamed aside");

        t.layout.clear_retired();
        assert!(t.layout.retired.exists(), "a running retired image stays");
        running.kill().unwrap();
        running.wait().unwrap();
        t.layout.clear_retired();
        assert!(!t.layout.retired.exists(), "a later start removes it");
    }

    #[test]
    fn a_rollback_cut_off_halfway_is_finished_by_the_next_recovery() {
        let t = tree();
        let names = begin(&t, false);
        for name in &names {
            place(&t.layout, name).unwrap();
        }
        let mut record: SwapRecord = read_json(&t.layout.swap_record).unwrap();
        record.rolling_back = true;
        write_json(&t.layout.swap_record, &record).unwrap();
        copy_durably(&t.root.join(MAIN_EXE), &t.layout.staged.join(MAIN_EXE), &t.layout.exe_copy).unwrap();
        assert_eq!(recover(&t.layout, Some(V), |_| false), Recovery::RolledBack(V.to_string()));
        assert_old_tree(&t);
    }

    #[test]
    fn a_swap_that_placed_everything_and_started_is_finished_not_undone() {
        let t = tree();
        let names = begin(&t, false);
        for name in &names {
            place(&t.layout, name).unwrap();
        }
        assert_eq!(recover(&t.layout, Some(V), |_| false), Recovery::Finished(V.to_string()));
        assert!(!t.layout.swap_record.exists());
        assert_eq!(read(t.root.join(MAIN_EXE)), "new exe");
        assert_eq!(read(t.layout.backup.join(MAIN_EXE)), "old exe");
    }

    #[test]
    fn a_running_helper_keeps_its_swap_and_its_backup() {
        let t = tree();
        begin(&t, false);
        place(&t.layout, "engine").unwrap();
        assert_eq!(recover(&t.layout, None, |_| true), Recovery::Busy);
        assert!(t.layout.swap_record.exists());
        assert!(renew_backup(&t.layout).is_err());
        assert_eq!(read(t.layout.backup.join("engine").join("main.py")), "old engine");
        assert!(matches!(swap(&t.layout, V, 0, 0, || Ok(())), Err(SwapError::Incomplete(_))));
        assert_eq!(read(t.layout.backup.join("engine").join("main.py")), "old engine");
    }

    #[test]
    fn the_executable_moves_last() {
        let t = tree();
        let names = staged_names(&t.layout.staged).unwrap();
        assert_eq!(names.last().map(String::as_str), Some(MAIN_EXE));
    }
}
