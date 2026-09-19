//! Staging files that a killed process left behind.
//!
//! A writer that stages bytes under a name carrying its own process id cannot
//! remove the file once it is killed between creating it and landing it, and
//! no later write uses that name again. Only another process can reclaim it,
//! and only by asking whether the process the name carries still runs.

use std::path::Path;

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

/// Remove each entry of `dir` that `owner` attributes to a process that is
/// neither `own` nor `running`. Returns how many were removed.
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
        if pid == own || running(pid) {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
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
}
