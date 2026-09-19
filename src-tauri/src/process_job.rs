//! A worker and its descendants cannot outlive the process owning its writes.
use windows::Win32::Foundation::{CloseHandle, HANDLE};

pub struct ProcessJob(usize);

impl ProcessJob {
    pub fn attach(pid: u32) -> Result<Self, String> {
        use std::ffi::c_void;
        use windows::core::PCWSTR;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        unsafe {
            let job = Self(
                CreateJobObjectW(None, PCWSTR::null())
                    .map_err(|e| e.to_string())?
                    .0 as usize,
            );
            let handle = HANDLE(job.0 as *mut c_void);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                std::mem::size_of_val(&limits) as u32,
            )
            .map_err(|e| e.to_string())?;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(|e| e.to_string())?;
            let assigned = AssignProcessToJobObject(handle, process);
            let _ = CloseHandle(process);
            assigned.map_err(|e| e.to_string())?;
            Ok(job)
        }
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(HANDLE(self.0 as *mut _));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, Write};
    use std::process::{Command, Stdio};

    #[test]
    #[ignore]
    fn child_waits() {
        if std::env::var_os("SPECTRA_TEST_JOB_CHILD").is_none() {
            return;
        }
        println!("worker-ready");
        std::io::stdout().flush().unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
    }

    #[test]
    fn dropping_the_owner_terminates_its_worker() {
        use std::os::windows::process::CommandExt;
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process_job::tests::child_waits",
                "--ignored",
                "--nocapture",
            ])
            .env("SPECTRA_TEST_JOB_CHILD", "1")
            .creation_flags(0x0800_0000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let job = ProcessJob::attach(child.id()).unwrap();
        let reader = std::io::BufReader::new(child.stdout.take().unwrap());
        assert!(reader
            .lines()
            .any(|line| line.unwrap().contains("worker-ready")));
        assert!(child.try_wait().unwrap().is_none());
        let scratch = tempfile::tempdir().unwrap();
        let registry = scratch.path().join("claims");
        let roots = vec![scratch.path().join("out").to_string_lossy().into_owned()];
        let lease = crate::folder_claims::claim_in(&registry, &roots).unwrap();
        let remote = lease.retain_in_worker(child.id()).unwrap();
        drop(lease);
        assert!(matches!(
            crate::folder_claims::claim_in(&registry, &roots),
            Err(crate::folder_claims::ClaimError::Busy(_))
        ));
        drop(remote);
        let lease = crate::folder_claims::claim_in(&registry, &roots).unwrap();
        let remote = lease.retain_in_worker(child.id()).unwrap();
        drop(lease);
        drop(job);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let exited = loop {
            if child.try_wait().unwrap().is_some() {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        if !exited {
            let _ = child.kill();
        }
        let _ = child.wait();
        assert!(exited, "the worker outlived its owner");
        assert!(
            crate::folder_claims::claim_in(&registry, &roots).is_ok(),
            "the stopped worker kept its lease"
        );
        drop(remote);
    }
}
