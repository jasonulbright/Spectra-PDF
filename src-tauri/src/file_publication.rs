//! Checked sibling staging for single-file Save/restore and unique undo copies.
//! A copy/sync/verification failure never touches the existing destination.
//! Publication is one same-volume rename, never a copy into the live file.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
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

struct Stage(Option<tempfile::NamedTempFile>);
impl Stage {
    fn file(&self) -> &tempfile::NamedTempFile {
        self.0.as_ref().unwrap()
    }
    fn new(parent: &Path) -> io::Result<Self> {
        Ok(Self(Some(
            tempfile::Builder::new()
                .prefix("document-stage-")
                .suffix(".pdf")
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

fn replace_with(source: &Path, destination: &Path, copy: &Copier<'_>) -> io::Result<()> {
    let source = dunce::canonicalize(source)?;
    let _source = source_guard(&source)?;
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
            if same_file::is_same_file(&source, &destination)? {
                return Ok(());
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
    checked_copy(&source, &stage, copy)?;
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
