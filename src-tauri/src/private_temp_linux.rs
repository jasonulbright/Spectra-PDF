//! The app's temp tree on Linux is private to the user.
//!
//! `/tmp` is shared by every account on the machine. A folder there that this
//! app expects to own can be created first by another account with mode 0777,
//! which then reads or swaps what the app stages in it (an attachment between
//! staging and the mail client reading it, a captured page between print and
//! assembly). So every process of the app points `TMPDIR` at a folder only
//! this user can enter, before any thread starts:
//! `$XDG_CACHE_HOME/spectrapdf/scratch` (`~/.cache/spectrapdf/scratch`).
//! `std::env::temp_dir()`, the webview's `$TEMP` file-access scope and every
//! child process then resolve to it. `$XDG_RUNTIME_DIR` is never used: it may
//! be memory-backed, and working copies, scans and OCR batches are large.
//!
//! The folders this app stages in are also created 0700 and checked without
//! following a symbolic link, so a session where `TMPDIR` could not be moved
//! refuses by name instead of staging into a folder another account controls.

use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

/// Permission bits for anyone but the owner.
const OTHERS: u32 = 0o077;

fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

/// The private base for this session. `cache` is `$XDG_CACHE_HOME`; `home`
/// is `$HOME`.
fn private_base(
    cache: Option<std::ffi::OsString>,
    home: Option<PathBuf>,
    uid: u32,
) -> Option<PathBuf> {
    let cache = crate::portable::xdg_base_from(cache, home, ".cache")?;
    let base = cache.join("spectrapdf").join("scratch");
    std::fs::create_dir_all(&cache).ok()?;
    ensure_private_as(&cache, &base, uid).ok()?;
    Some(base)
}

/// Create each folder of `dir` below `base` with mode 0700, and refuse when
/// any of them is a link, not a folder, or owned by another account. A folder
/// this user owns with looser permissions (left by an earlier version) is
/// tightened to 0700.
pub(crate) fn ensure_private_under(base: &Path, dir: &Path) -> io::Result<()> {
    ensure_private_as(base, dir, euid())
}

fn ensure_private_as(base: &Path, dir: &Path, uid: u32) -> io::Result<()> {
    let relative = dir.strip_prefix(base).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is not inside {}", dir.display(), base.display()),
        )
    })?;
    let mut current = base.to_path_buf();
    for part in relative.components() {
        let Component::Normal(name) = part else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} is not a plain folder path", dir.display()),
            ));
        };
        current.push(name);
        match std::fs::DirBuilder::new().mode(0o700).create(&current) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        let meta = std::fs::symlink_metadata(&current)?;
        if !meta.is_dir() || meta.uid() != uid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{} is not a folder this user owns", current.display()),
            ));
        }
        if meta.mode() & OTHERS != 0 {
            std::fs::set_permissions(&current, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

/// The private base when the cache folder cannot be used (no `HOME`, an
/// unwritable `~/.cache`, a cache folder another account owns):
/// `<temp>/spectrapdf-<euid>` when it is a private folder this user owns,
/// else a fresh folder created 0700 under an unpredictable name.
/// Never the shared temp directory itself.
fn fallback_base(temp: &Path, uid: u32) -> Option<PathBuf> {
    let stable = temp.join(format!("spectrapdf-{uid}"));
    if ensure_private_as(temp, &stable, uid).is_ok() {
        return Some(stable);
    }
    tempfile::Builder::new()
        .prefix("spectrapdf-")
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir_in(temp)
        .ok()
        .map(tempfile::TempDir::keep)
}

/// Point `TMPDIR` at this session's private base. Called first thing in
/// `main`, while the process has one thread.
pub fn adopt() {
    let uid = euid();
    let base = private_base(
        std::env::var_os("XDG_CACHE_HOME"),
        std::env::var_os("HOME").map(PathBuf::from),
        uid,
    )
    .or_else(|| {
        let fallback = fallback_base(&std::env::temp_dir(), uid);
        if let Some(dir) = &fallback {
            eprintln!(
                "The per-user cache folder cannot hold temporary files; using {} instead.",
                dir.display()
            );
        }
        fallback
    });
    match base {
        Some(base) => {
            std::env::set_var("TMPDIR", &base);
            let _ = ensure_private_under(&base, &base.join("spectrapdf"));
        }
        None => eprintln!("No private folder for temporary files could be created."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path).unwrap().mode() & 0o777
    }

    #[test]
    fn every_created_folder_is_private() {
        let base = tempfile::tempdir().unwrap();
        let leaf = base.path().join("spectrapdf").join("send-to");
        ensure_private_under(base.path(), &leaf).unwrap();
        assert_eq!(mode(&base.path().join("spectrapdf")), 0o700);
        assert_eq!(mode(&leaf), 0o700);
        ensure_private_under(base.path(), &leaf).unwrap();
    }

    #[test]
    fn a_loose_folder_of_this_user_is_tightened() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("spectrapdf");
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o777)).unwrap();
        ensure_private_under(base.path(), &root.join("web-capture")).unwrap();
        assert_eq!(mode(&root), 0o700);
    }

    #[test]
    fn a_link_or_a_file_in_place_of_a_folder_is_refused() {
        let base = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let root = base.path().join("spectrapdf");
        std::os::unix::fs::symlink(elsewhere.path(), &root).unwrap();
        let refused = ensure_private_under(base.path(), &root.join("send-to")).unwrap_err();
        assert_eq!(refused.kind(), io::ErrorKind::PermissionDenied);
        assert!(!elsewhere.path().join("send-to").exists(), "the link was followed");

        let other = tempfile::tempdir().unwrap();
        std::fs::write(other.path().join("spectrapdf"), b"").unwrap();
        assert!(ensure_private_under(other.path(), &other.path().join("spectrapdf").join("x")).is_err());
    }

    #[test]
    fn a_folder_outside_the_base_or_with_dot_dot_is_refused() {
        let base = tempfile::tempdir().unwrap();
        assert!(ensure_private_under(base.path(), Path::new("/elsewhere/x")).is_err());
        assert!(ensure_private_under(base.path(), &base.path().join("a").join("..").join("b")).is_err());
    }

    #[test]
    fn without_the_cache_folder_the_base_is_a_private_folder_of_this_user() {
        let uid = euid();
        let temp = tempfile::tempdir().unwrap();
        let stable = temp.path().join(format!("spectrapdf-{uid}"));
        assert_eq!(fallback_base(temp.path(), uid), Some(stable.clone()));
        assert_eq!(mode(&stable), 0o700);

        // A folder of that name another account holds (here: owned by this
        // test's uid, presented as someone else's) is not adopted; a fresh
        // private folder is.
        let other = uid + 1;
        let squatted = temp.path().join(format!("spectrapdf-{other}"));
        std::fs::create_dir(&squatted).unwrap();
        std::fs::set_permissions(&squatted, std::fs::Permissions::from_mode(0o777)).unwrap();
        let fresh = fallback_base(temp.path(), other).unwrap();
        assert_ne!(fresh, squatted);
        assert_ne!(fresh, temp.path());
        assert_eq!(fresh.parent(), Some(temp.path()));
        assert_eq!(mode(&fresh), 0o700);
        assert_eq!(std::fs::symlink_metadata(&fresh).unwrap().uid(), uid);

        // A link in place of the stable folder is not followed.
        let elsewhere = tempfile::tempdir().unwrap();
        let linked = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), linked.path().join(format!("spectrapdf-{uid}")))
            .unwrap();
        let chosen = fallback_base(linked.path(), uid).unwrap();
        assert!(!chosen.starts_with(elsewhere.path()));
        assert_eq!(std::fs::read_dir(elsewhere.path()).unwrap().count(), 0);
    }

    #[test]
    fn the_base_is_the_cache_scratch_folder_and_private_to_this_user() {
        let uid = euid();
        let home = tempfile::tempdir().unwrap();
        let fallback = home.path().join(".cache").join("spectrapdf").join("scratch");
        assert_eq!(private_base(None, Some(home.path().to_path_buf()), uid), Some(fallback.clone()));
        assert_eq!(mode(&fallback), 0o700);
        assert_eq!(mode(fallback.parent().unwrap()), 0o700);

        let cache = tempfile::tempdir().unwrap();
        assert_eq!(
            private_base(Some(cache.path().as_os_str().to_owned()), Some(home.path().to_path_buf()), uid),
            Some(cache.path().join("spectrapdf").join("scratch")),
            "XDG_CACHE_HOME is honoured"
        );
        assert_eq!(
            private_base(Some("relative".into()), Some(home.path().to_path_buf()), uid),
            Some(fallback.clone()),
            "a relative XDG_CACHE_HOME is ignored, as the specification requires"
        );
        assert_eq!(
            private_base(None, Some(home.path().to_path_buf()), uid + 1),
            None,
            "a cache folder owned by another account is not adopted"
        );
        assert_eq!(private_base(None, None, uid), None);
    }
}
