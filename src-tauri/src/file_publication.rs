//! Checked sibling staging for single-file Save/restore, for writes to a path
//! the user chose, and for unique undo copies.
//! A copy/sync/verification failure never touches the existing destination.
//! Publication is one same-volume rename, never a copy into the live file.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

pub(crate) fn equal_files(a: &Path, b: &Path) -> io::Result<bool> {
    let (mut a, mut b) = (File::open(a)?, File::open(b)?);
    if a.metadata()?.len() != b.metadata()?.len() {
        return Ok(false);
    }
    let (mut left, mut right) = ([0_u8; 65536], [0_u8; 65536]);
    loop {
        let n = a.read(&mut left)?;
        if n == 0 {
            return Ok(true);
        }
        b.read_exact(&mut right[..n])?;
        if left[..n] != right[..n] {
            return Ok(false);
        }
    }
}

fn source_guard(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1); // FILE_SHARE_READ: no writer/delete during the copy
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::other("source is not a regular file"));
    }
    Ok(file)
}

const STAGE_PREFIX: &str = "document-stage-";
const STAGE_SUFFIX: &str = ".pdf";

/// The process a stage name was created under: `Stage::new` names each stage
/// `document-stage-<pid>-<random>.pdf`.
fn stage_owner(entry: &str) -> Option<u32> {
    let (pid, random) = entry
        .strip_prefix(STAGE_PREFIX)?
        .strip_suffix(STAGE_SUFFIX)?
        .split_once('-')?;
    if random.is_empty() || !random.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    crate::staging::decimal_pid(pid)
}

/// Remove the stages that processes killed mid-copy left in `dir`.
fn reclaim_stages(dir: &Path, own: u32, running: impl Fn(u32) -> bool) -> usize {
    crate::staging::reclaim(dir, own, stage_owner, running)
}

/// A stage named the way versions without a process id in the name named
/// them: `document-stage-`, the six ASCII letters and digits `tempfile`
/// draws, `.pdf`.
fn legacy_stage(entry: &str) -> bool {
    entry
        .strip_prefix(STAGE_PREFIX)
        .and_then(|rest| rest.strip_suffix(STAGE_SUFFIX))
        .is_some_and(|random| {
            random.len() == 6 && random.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

struct Stage(Option<tempfile::NamedTempFile>);
impl Stage {
    fn file(&self) -> &tempfile::NamedTempFile {
        self.0.as_ref().unwrap()
    }
    /// A process killed between creating a stage and publishing it cannot
    /// remove it, and a Save As puts that stage beside the user's document.
    /// Each new stage first removes the ones left in the same folder by
    /// processes that no longer run, and the ones without a process id once
    /// they are older than any stage can legitimately live.
    fn new(parent: &Path) -> io::Result<Self> {
        let own = std::process::id();
        reclaim_stages(parent, own, crate::staging::process_running);
        crate::staging::reclaim_aged(
            parent,
            legacy_stage,
            crate::staging::LEGACY_STAGE_AGE,
            std::time::SystemTime::now(),
        );
        Ok(Self(Some(
            tempfile::Builder::new()
                .prefix(&format!("{STAGE_PREFIX}{own}-"))
                .suffix(STAGE_SUFFIX)
                .tempfile_in(parent)?,
        )))
    }
    fn publish(mut self, destination: &Path, overwrite: bool) -> io::Result<()> {
        let stage = self.0.take().unwrap();
        let result = if overwrite {
            stage.persist(destination)
        } else {
            stage.persist_noclobber(destination)
        };
        match result {
            Ok(_) => Ok(()),
            Err(error) => {
                self.0 = Some(error.file); // Drop also handles copied read-only attributes
                Err(error.error)
            }
        }
    }
    fn retain(mut self) -> io::Result<PathBuf> {
        match self.0.take().unwrap().keep() {
            Ok((_, path)) => Ok(path),
            Err(error) => {
                self.0 = Some(error.file);
                Err(error.error)
            }
        }
    }
}
impl Drop for Stage {
    fn drop(&mut self) {
        // This is only our newly created stage, never the user's destination.
        #[cfg(windows)]
        if let Some(stage) = &self.0 {
            if let Ok(meta) = stage.as_file().metadata() {
                let mut permissions = meta.permissions();
                if permissions.readonly() {
                    permissions.set_readonly(false);
                    let _ = stage.as_file().set_permissions(permissions);
                }
            }
        }
    }
}

type Copier<'a> = dyn Fn(&Path, &Path) -> io::Result<u64> + 'a;
fn checked_copy(source: &Path, stage: &Stage, copy: &Copier<'_>) -> io::Result<()> {
    let count = copy(source, stage.file().path())?;
    stage.file().as_file().sync_all()?;
    if count != fs::metadata(source)?.len() || !equal_files(source, stage.file().path())? {
        return Err(io::Error::other("copy verification failed"));
    }
    Ok(())
}

pub(crate) fn snapshot(source: &Path) -> io::Result<PathBuf> {
    let source = dunce::canonicalize(source)?;
    let _guard = source_guard(&source)?;
    // Exclusive creation, not clock-derived naming: earlier undo bytes can
    // never be overwritten by a second snapshot, even in the same millisecond.
    let stage = Stage::new(
        source
            .parent()
            .ok_or_else(|| io::Error::other("missing parent"))?,
    )?;
    checked_copy(&source, &stage, &|a, b| fs::copy(a, b))?;
    stage.retain()
}

pub(crate) fn replace_copy(source: &Path, destination: &Path) -> io::Result<()> {
    replace_with(source, destination, &|a, b| fs::copy(a, b))
}

/// Publish `bytes` at `destination` through the same checked stage as a Save.
pub(crate) fn replace_bytes(bytes: &[u8], destination: &Path) -> io::Result<()> {
    publish_at(destination, None, &|stage| {
        let mut file = stage.file().as_file();
        file.write_all(bytes)?;
        file.sync_all()
    })
}

fn replace_with(source: &Path, destination: &Path, copy: &Copier<'_>) -> io::Result<()> {
    let source = dunce::canonicalize(source)?;
    let _source = source_guard(&source)?;
    publish_at(destination, Some(&source), &|stage| {
        checked_copy(&source, stage, copy)
    })
}

type Filler<'a> = dyn Fn(&Stage) -> io::Result<()> + 'a;

/// Fill a stage beside `destination` and rename it over the destination.
/// `source` is the file the bytes come from, when there is one: a destination
/// that is that same file is already what it would become.
fn publish_at(destination: &Path, source: Option<&Path>, fill: &Filler<'_>) -> io::Result<()> {
    // Resolve an existing symlink to its target; do not replace the link itself.
    // Only a genuinely absent leaf permits a new destination. Permission and
    // broken-link errors must not be converted into absence.
    let destination = match fs::symlink_metadata(destination) {
        Ok(_) => dunce::canonicalize(destination)?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let parent = destination
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            dunce::canonicalize(parent)?.join(
                destination
                    .file_name()
                    .ok_or_else(|| io::Error::other("missing filename"))?,
            )
        }
        Err(e) => return Err(e),
    };
    let existing = match fs::metadata(&destination) {
        Ok(meta) => {
            if !meta.is_file() {
                return Err(io::Error::other("destination is not a regular file"));
            }
            if let Some(source) = source {
                if same_file::is_same_file(source, &destination)? {
                    return Ok(());
                }
            }
            if meta.permissions().readonly() {
                return Err(io::Error::other("destination is read-only"));
            }
            // Prove write permission without truncation; retain the real file
            // handle for its access-control template and identity check.
            let file = OpenOptions::new()
                .write(true)
                .open(&destination)
                .map_err(|e| io::Error::other(format!("destination write check: {e}")))?;
            Some(file)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    let stage = Stage::new(
        destination
            .parent()
            .ok_or_else(|| io::Error::other("missing parent"))?,
    )?;
    if let Some(original) = &existing {
        #[cfg(windows)]
        {
            use std::os::windows::{ffi::OsStrExt, fs::MetadataExt};
            // Never silently remove filesystem encryption from an existing
            // destination merely because its working copy is unencrypted.
            if original.metadata()?.file_attributes() & 0x4000 != 0 {
                // Encrypt the EMPTY stage before copying any document bytes.
                let encrypted_path = fs::canonicalize(stage.file().path())?;
                let wide: Vec<u16> = encrypted_path
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect();
                unsafe {
                    windows::Win32::Storage::FileSystem::EncryptFileW(windows::core::PCWSTR(
                        wide.as_ptr(),
                    ))
                }
                .map_err(io::Error::other)?;
            }
        }
    }
    fill(&stage)?;
    if let Some(original) = &existing {
        preserve_access(original, stage.file())
            .map_err(|e| io::Error::other(format!("preserve access: {e}")))?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if original.metadata()?.file_attributes() & 0x4000 != 0
                && stage.file().as_file().metadata()?.file_attributes() & 0x4000 == 0
            {
                return Err(io::Error::other(
                    "staged file did not retain filesystem encryption",
                ));
            }
        }
        if same_file::Handle::from_file(original.try_clone()?)?
            != same_file::Handle::from_path(&destination)?
        {
            return Err(io::Error::other("destination changed during save"));
        }
    } else if destination.try_exists()? {
        return Err(io::Error::other("destination appeared during save"));
    }
    let overwrite = existing.is_some();
    // Windows can refuse replacement while the old writable handle is live.
    // It has served its permission/template/identity checks; close it now.
    drop(existing);
    stage
        .publish(&destination, overwrite)
        .map_err(|e| io::Error::other(format!("publish stage: {e}")))
}

#[cfg(windows)]
fn descriptor(file: &File) -> io::Result<Vec<u32>> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Security::{GetKernelObjectSecurity, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR},
    };
    let handle = HANDLE(file.as_raw_handle());
    let mut bytes = 0;
    let _ = unsafe {
        GetKernelObjectSecurity(handle, DACL_SECURITY_INFORMATION.0, None, 0, &mut bytes)
    };
    if bytes == 0 {
        return Err(io::Error::last_os_error());
    }
    // A security descriptor requires DWORD alignment, not merely Vec<u8>.
    let mut data = vec![0_u32; (bytes as usize).div_ceil(4)];
    unsafe {
        GetKernelObjectSecurity(
            handle,
            DACL_SECURITY_INFORMATION.0,
            Some(PSECURITY_DESCRIPTOR(data.as_mut_ptr().cast())),
            bytes,
            &mut bytes,
        )
    }
    .map_err(io::Error::other)?;
    Ok(data)
}

#[cfg(windows)]
fn preserve_access(original: &File, replacement: &tempfile::NamedTempFile) -> io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{Foundation::HANDLE, Security::*};
    let mut flags = 0;
    unsafe {
        windows::Win32::Storage::FileSystem::GetVolumeInformationByHandleW(
            HANDLE(original.as_raw_handle()),
            None,
            None,
            None,
            Some(&mut flags),
            None,
        )
    }
    .map_err(io::Error::other)?;
    // FAT/exFAT removable destinations do not have a persistent DACL to carry.
    // An actual query failure on an ACL-capable filesystem is still a refusal.
    if flags & 0x8 == 0 {
        return Ok(());
    } // FILE_PERSISTENT_ACLS
    let mut data = descriptor(original)?;
    let sd = PSECURITY_DESCRIPTOR(data.as_mut_ptr().cast());
    let (mut control, mut revision) = (0, 0);
    unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) }
        .map_err(io::Error::other)?;
    let inheritance = if control & SE_DACL_PROTECTED.0 != 0 {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    let security = OpenOptions::new()
        .access_mode(0x0004_0000)
        .open(replacement.path())?; // WRITE_DAC
    unsafe {
        SetKernelObjectSecurity(
            HANDLE(security.as_raw_handle()),
            DACL_SECURITY_INFORMATION | inheritance,
            sd,
        )
    }
    .map_err(io::Error::other)
}

#[cfg(not(windows))]
fn preserve_access(original: &File, replacement: &tempfile::NamedTempFile) -> io::Result<()> {
    replacement
        .as_file()
        .set_permissions(original.metadata()?.permissions())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> std::collections::BTreeSet<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect()
    }

    #[test]
    fn a_stage_is_named_for_the_process_that_created_it() {
        let root = tempfile::tempdir().unwrap();
        let stage = Stage::new(root.path()).unwrap();
        let name = stage
            .file()
            .path()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert_eq!(stage_owner(&name), Some(std::process::id()));
        for other in [
            "document-stage-abc123.pdf",
            "document-stage-4300-.pdf",
            "document-stage-4300-ab_c12.pdf",
            "document-stage-04300-abc123.pdf",
            "document-stage-4300-abc123.PDF",
            "document-stage-4300-abc123.pdf.bak",
            "report-4300-abc123.pdf",
        ] {
            assert_eq!(stage_owner(other), None, "{other}");
        }
    }

    #[test]
    fn only_the_stages_of_stopped_processes_are_reclaimed() {
        const OWN: u32 = 4100;
        const LIVE: u32 = 4200;
        let root = tempfile::tempdir().unwrap();
        let kept = [
            "document-stage-4100-abc123.pdf",
            "document-stage-4200-abc123.pdf",
            "document-stage-abc123.pdf",
            "document-stage-4300-abc123.pdf.bak",
            "report.pdf",
        ];
        let reclaimed = [
            "document-stage-4300-abc123.pdf",
            "document-stage-4304-XYZ789.pdf",
        ];
        for name in kept.iter().chain(&reclaimed) {
            fs::write(root.path().join(name), b"%PDF").unwrap();
        }
        assert_eq!(reclaim_stages(root.path(), OWN, |pid| pid == LIVE), 2);
        let kept: std::collections::BTreeSet<String> = kept.map(String::from).into();
        assert_eq!(names(root.path()), kept);
    }

    #[cfg(windows)]
    #[test]
    fn a_save_reclaims_the_stage_a_killed_save_left_beside_the_document() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("working.pdf");
        let dest = root.path().join("out.pdf");
        fs::write(&source, b"new").unwrap();
        fs::write(&dest, b"original").unwrap();
        let mut writer = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        writer.wait().unwrap();
        // `writer` holds its handle, so its id stays unused while it is asked
        // about.
        let orphan = root.path().join(format!(
            "{STAGE_PREFIX}{}-abc123{STAGE_SUFFIX}",
            writer.id()
        ));
        fs::write(&orphan, b"a copy that never published").unwrap();

        replace_copy(&source, &dest).unwrap();

        assert!(!orphan.exists());
        assert_eq!(fs::read(&dest).unwrap(), b"new");
        let expected: std::collections::BTreeSet<String> =
            ["out.pdf", "working.pdf"].map(String::from).into();
        assert_eq!(names(root.path()), expected);
    }

    #[test]
    fn only_the_six_character_tempfile_name_is_a_legacy_stage() {
        for legacy in [
            "document-stage-abc123.pdf",
            "document-stage-AB12cd.pdf",
            "document-stage-000000.pdf",
        ] {
            assert!(legacy_stage(legacy), "{legacy}");
        }
        for other in [
            "document-stage-4300-abc123.pdf",
            "document-stage-abc12.pdf",
            "document-stage-abc1234.pdf",
            "document-stage-abc_12.pdf",
            "document-stage-abc-12.pdf",
            "document-stage-\u{e1}bc12.pdf",
            "document-stage-abc123.PDF",
            "Document-stage-abc123.pdf",
            "document-stage-abc123.pdf.bak",
            "document-stage-.pdf",
            "report-abc123.pdf",
        ] {
            assert!(!legacy_stage(other), "{other}");
        }
    }

    #[cfg(windows)]
    fn created_long_ago(path: &Path) {
        use std::os::windows::fs::FileTimesExt;
        let past = std::time::SystemTime::now()
            - crate::staging::LEGACY_STAGE_AGE
            - std::time::Duration::from_secs(3600);
        OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_created(past))
            .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_save_reclaims_an_aged_legacy_stage_and_nothing_else() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("working.pdf");
        let dest = root.path().join("out.pdf");
        fs::write(&source, b"new").unwrap();
        fs::write(&dest, b"original").unwrap();
        let aged_legacy = root.path().join("document-stage-abc123.pdf");
        let young_legacy = root.path().join("document-stage-XYZ789.pdf");
        let aged_document = root.path().join("draft-abc123.pdf");
        for path in [&aged_legacy, &young_legacy, &aged_document] {
            fs::write(path, b"%PDF").unwrap();
        }
        created_long_ago(&aged_legacy);
        created_long_ago(&aged_document);

        replace_copy(&source, &dest).unwrap();

        assert!(!aged_legacy.exists());
        assert!(young_legacy.exists(), "a legacy stage may still be in flight");
        assert!(aged_document.exists());
        assert_eq!(fs::read(&dest).unwrap(), b"new");
    }

    #[test]
    fn bytes_publish_whole_and_a_refusal_keeps_the_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("report.html");
        replace_bytes(b"<p>first</p>", &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"<p>first</p>");
        replace_bytes(b"<p>second</p>", &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"<p>second</p>");
        let only: std::collections::BTreeSet<String> = ["report.html"].map(String::from).into();
        assert_eq!(names(root.path()), only);

        let mut perms = fs::metadata(&dest).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&dest, perms.clone()).unwrap();
        assert!(replace_bytes(b"<p>third</p>", &dest).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"<p>second</p>");
        assert_eq!(names(root.path()), only);
        perms.set_readonly(false);
        fs::set_permissions(&dest, perms).unwrap();
    }

    #[test]
    fn a_new_destination_race_never_overwrites_the_arriving_file() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.pdf");
        let dest = root.path().join("out.pdf");
        fs::write(&source, b"new").unwrap();
        assert!(replace_with(&source, &dest, &|a, b| {
            let count = fs::copy(a, b)?;
            fs::write(&dest, b"arrived externally")?;
            Ok(count)
        })
        .is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"arrived externally");
        // Also pin the final syscall after the last existence check.
        let stage = Stage::new(root.path()).unwrap();
        fs::write(stage.file().path(), b"staged").unwrap();
        assert!(stage.publish(&dest, false).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"arrived externally");
    }
    #[test]
    fn missing_source_and_nonfile_destinations_refuse_without_mutation() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.pdf");
        let dest = root.path().join("out.pdf");
        fs::write(&dest, b"original").unwrap();
        assert!(replace_copy(&source, &dest).is_err());
        assert!(replace_copy(root.path(), &dest).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"original");
        fs::write(&source, b"source").unwrap();
        assert!(replace_copy(&source, root.path()).is_err());
        assert!(replace_copy(&source, &root.path().join("missing/out.pdf")).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"source");
    }
    #[test]
    fn copy_errors_short_writes_and_corruption_leave_existing_and_absent_destinations_untouched() {
        for existed in [false, true] {
            for mode in ["partial-error", "short-ok", "corrupt-ok", "empty-error"] {
                let root = tempfile::tempdir().unwrap();
                let source = root.path().join("source.pdf");
                let destination = root.path().join("output.pdf");
                fs::write(&source, b"new full bytes").unwrap();
                if existed {
                    fs::write(&destination, b"old full bytes").unwrap();
                }
                let result = replace_with(&source, &destination, &|_, stage| {
                    fs::write(
                        stage,
                        if mode == "corrupt-ok" {
                            &b"bad full bytes"[..]
                        } else if mode == "empty-error" {
                            &b""[..]
                        } else {
                            &b"new"[..]
                        },
                    )?;
                    match mode {
                        "short-ok" => Ok(3),
                        "corrupt-ok" => Ok(14),
                        _ => Err(io::Error::other("injected copy error")),
                    }
                });
                assert!(result.is_err(), "{mode}/{existed}");
                if existed {
                    assert_eq!(fs::read(&destination).unwrap(), b"old full bytes");
                } else {
                    assert!(!destination.exists());
                }
                assert_eq!(fs::read(&source).unwrap(), b"new full bytes");
                assert_eq!(
                    fs::read_dir(root.path()).unwrap().count(),
                    if existed { 2 } else { 1 }
                );
            }
        }
    }
    #[test]
    fn snapshots_are_unique_and_keep_every_revision() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.pdf");
        let mut copies = Vec::new();
        for n in 0..200 {
            let bytes = format!("revision {n}");
            fs::write(&source, &bytes).unwrap();
            copies.push((snapshot(&source).unwrap(), bytes));
        }
        assert_eq!(
            copies
                .iter()
                .map(|(p, _)| p)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            200
        );
        for (path, bytes) in copies {
            assert_eq!(fs::read_to_string(path).unwrap(), bytes);
        }
    }
    #[test]
    fn new_existing_self_and_hardlink_controls() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.pdf");
        let dest = root.path().join("out.pdf");
        fs::write(&source, b"complete new PDF").unwrap();
        replace_copy(&source, &dest).unwrap();
        fs::write(&dest, b"existing").unwrap();
        replace_copy(&source, &dest).unwrap();
        replace_copy(&source, &source).unwrap();
        let alias = root.path().join("hardlink.pdf");
        fs::hard_link(&source, &alias).unwrap();
        replace_copy(&source, &alias).unwrap();
        for p in [source, dest, alias] {
            assert_eq!(fs::read(p).unwrap(), b"complete new PDF");
        }
    }
    #[cfg(windows)]
    #[test]
    fn locked_or_readonly_destination_survives_and_retry_works() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.pdf");
        let dest = root.path().join("out.pdf");
        fs::write(&source, b"new").unwrap();
        fs::write(&dest, b"original").unwrap();
        let lock = OpenOptions::new()
            .read(true)
            .share_mode(1 | 2)
            .open(&dest)
            .unwrap();
        assert!(replace_copy(&source, &dest).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"original");
        drop(lock);
        let mut perms = fs::metadata(&dest).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&dest, perms.clone()).unwrap();
        assert!(replace_copy(&source, &dest).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"original");
        perms.set_readonly(false);
        fs::set_permissions(&dest, perms).unwrap();
        replace_copy(&source, &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"new");
    }
    #[cfg(windows)]
    #[test]
    fn replacement_keeps_the_existing_protected_dacl() {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{Foundation::HANDLE, Security::*};
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.pdf");
        let dest = root.path().join("out.pdf");
        fs::write(&source, b"new").unwrap();
        fs::write(&dest, b"original").unwrap();
        let original = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&dest)
            .unwrap();
        let mut sd = descriptor(&original).unwrap();
        // Use a handle explicitly granted WRITE_DAC for changing the fixture.
        use std::os::windows::fs::OpenOptionsExt;
        let security = OpenOptions::new()
            .access_mode(0x0004_0000)
            .open(&dest)
            .unwrap();
        unsafe {
            SetKernelObjectSecurity(
                HANDLE(security.as_raw_handle()),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                PSECURITY_DESCRIPTOR(sd.as_mut_ptr().cast()),
            )
        }
        .unwrap();
        let before = descriptor(&original).unwrap();
        drop(security);
        drop(original);
        replace_copy(&source, &dest).unwrap();
        assert_eq!(descriptor(&File::open(&dest).unwrap()).unwrap(), before);
        assert_eq!(fs::read(&dest).unwrap(), b"new");
    }
}
