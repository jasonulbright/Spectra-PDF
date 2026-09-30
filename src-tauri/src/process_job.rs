//! A worker and its descendants cannot outlive the process owning its writes.
use windows::Win32::Foundation::{CloseHandle, HANDLE};

pub struct ProcessJob(usize);

/// Bind a running process to this one's lifetime.
pub fn contain(pid: u32) -> Result<Option<ProcessJob>, String> {
    ProcessJob::attach(pid).map(Some)
}

impl ProcessJob {
    /// Attach to an already running process. Descendants created before this
    /// call are not captured; use `spawn` when the child can create them early.
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

    /// Start a process suspended, assign it to a kill-on-close job, then let
    /// its first thread run. Assigning after an ordinary spawn leaves a race:
    /// the child can create descendants before it joins the job.
    pub fn spawn(
        mut command: std::process::Command,
        creation_flags: u32,
    ) -> std::io::Result<(std::process::Child, Self)> {
        use std::os::windows::process::CommandExt;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;

        command.creation_flags(creation_flags | CREATE_SUSPENDED);
        let mut child = command.spawn()?;
        #[cfg(test)]
        tests::run_after_create_hook(child.id());
        let job = match Self::attach(child.id()) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::other(format!(
                    "could not contain the child process: {error}"
                )));
            }
        };
        if let Err(error) = resume_initial_thread(child.id()) {
            drop(job);
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other(format!(
                "could not resume the contained child process: {error}"
            )));
        }
        Ok((child, job))
    }
}

fn resume_initial_thread(pid: u32) -> Result<(), String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    unsafe {
        let snapshot =
            OwnedHandle(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(|e| e.to_string())?);
        let mut entry = THREADENTRY32::default();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut more = Thread32First(snapshot.0, &mut entry).is_ok();
        while more {
            if entry.th32OwnerProcessID == pid {
                let thread = OwnedHandle(
                    OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                        .map_err(|e| e.to_string())?,
                );
                let previous_count = ResumeThread(thread.0);
                if previous_count == u32::MAX {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                if previous_count != 1 {
                    return Err(format!(
                        "expected the initial thread suspend count to be 1, got {previous_count}"
                    ));
                }
                return Ok(());
            }
            more = Thread32Next(snapshot.0, &mut entry).is_ok();
        }
    }
    Err(format!("no initial thread found for process {pid}"))
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
    use std::cell::RefCell;
    use std::io::{BufRead, Write};
    use std::process::{Command, Stdio};

    thread_local! {
        static AFTER_CREATE: RefCell<Option<Box<dyn Fn(u32)>>> = const { RefCell::new(None) };
    }

    /// Runs between process creation and job assignment in `ProcessJob::spawn`.
    pub(super) fn run_after_create_hook(pid: u32) {
        AFTER_CREATE.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                hook(pid);
            }
        });
    }

    /// The suspend count of the process's first listed thread, read by
    /// suspending and immediately resuming it.
    fn first_thread_suspend_count(pid: u32) -> Option<u32> {
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
            THREADENTRY32,
        };
        use windows::Win32::System::Threading::{
            OpenThread, ResumeThread, SuspendThread, THREAD_SUSPEND_RESUME,
        };
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).ok()?;
            let mut entry = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut more = Thread32First(snapshot, &mut entry).is_ok();
            let mut count = None;
            while more {
                if entry.th32OwnerProcessID == pid {
                    if let Ok(thread) = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                    {
                        let previous = SuspendThread(thread);
                        if previous != u32::MAX {
                            ResumeThread(thread);
                            count = Some(previous);
                        }
                        let _ = CloseHandle(thread);
                    }
                    break;
                }
                more = Thread32Next(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
            count
        }
    }

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
    #[ignore]
    fn spawn_job_tree_helper() {
        match std::env::var("SPECTRA_TEST_JOB_TREE_RACE").as_deref() {
            Ok("owner") => {
                let exe = std::env::current_exe().unwrap();
                let started = std::env::var_os("SPECTRA_TEST_JOB_STARTED_MARKER").unwrap();
                let marker = std::env::var_os("SPECTRA_TEST_JOB_DESCENDANT_MARKER").unwrap();
                let _descendant = Command::new(exe)
                    .args([
                        "process_job::tests::spawn_job_tree_helper",
                        "--ignored",
                        "--nocapture",
                    ])
                    .env("SPECTRA_TEST_JOB_TREE_RACE", "descendant")
                    .env("SPECTRA_TEST_JOB_STARTED_MARKER", started)
                    .env("SPECTRA_TEST_JOB_DESCENDANT_MARKER", marker)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                while !std::path::Path::new(
                    &std::env::var_os("SPECTRA_TEST_JOB_STARTED_MARKER").unwrap(),
                )
                .exists()
                    && std::time::Instant::now() < deadline
                {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                assert!(std::path::Path::new(
                    &std::env::var_os("SPECTRA_TEST_JOB_STARTED_MARKER").unwrap()
                )
                .exists());
                std::thread::sleep(std::time::Duration::from_secs(30));
            }
            Ok("descendant") => {
                let started = std::env::var_os("SPECTRA_TEST_JOB_STARTED_MARKER").unwrap();
                let marker = std::env::var_os("SPECTRA_TEST_JOB_DESCENDANT_MARKER").unwrap();
                std::fs::write(started, b"started").unwrap();
                std::thread::sleep(std::time::Duration::from_millis(500));
                std::fs::write(marker, b"survived").unwrap();
            }
            _ => {}
        }
    }

    #[test]
    fn suspended_spawn_contains_descendants_from_the_first_instruction() {
        let scratch = tempfile::tempdir().unwrap();
        let started = scratch.path().join("descendant-started");
        let marker = scratch.path().join("descendant-survived");
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "process_job::tests::spawn_job_tree_helper",
                "--ignored",
                "--nocapture",
            ])
            .env("SPECTRA_TEST_JOB_TREE_RACE", "owner")
            .env("SPECTRA_TEST_JOB_STARTED_MARKER", &started)
            .env("SPECTRA_TEST_JOB_DESCENDANT_MARKER", &marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Holds job assignment until the child is proven unable to run, or
        // until it has already started its descendant. A spawn that lets the
        // child run before assignment therefore always assigns too late,
        // whatever the scheduler does.
        let hook_started = started.clone();
        AFTER_CREATE.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move |pid| {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                loop {
                    if first_thread_suspend_count(pid).is_some_and(|count| count > 0) {
                        return;
                    }
                    if hook_started.exists() {
                        return;
                    }
                    assert!(
                        std::time::Instant::now() < deadline,
                        "the child neither stayed suspended nor started its descendant"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }));
        });
        let spawned = ProcessJob::spawn(command, 0);
        AFTER_CREATE.with(|hook| hook.borrow_mut().take());
        let (mut owner, job) = spawned.unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !started.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(started.exists(), "the helper did not start its descendant");

        drop(job);
        let _ = owner.wait();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            !marker.exists(),
            "a child started before job assignment escaped the owner's job"
        );
    }

    #[test]
    fn attaching_does_not_capture_descendants_created_before_attachment() {
        let scratch = tempfile::tempdir().unwrap();
        let started = scratch.path().join("descendant-started");
        let marker = scratch.path().join("descendant-survived");
        let mut owner = Command::new(std::env::current_exe().unwrap())
            .args([
                "process_job::tests::spawn_job_tree_helper",
                "--ignored",
                "--nocapture",
            ])
            .env("SPECTRA_TEST_JOB_TREE_RACE", "owner")
            .env("SPECTRA_TEST_JOB_STARTED_MARKER", &started)
            .env("SPECTRA_TEST_JOB_DESCENDANT_MARKER", &marker)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !started.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(started.exists(), "the helper did not start its descendant");

        let job = ProcessJob::attach(owner.id()).unwrap();
        drop(job);
        let _ = owner.wait();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !marker.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(
            marker.exists(),
            "the control descendant should remain outside a job attached after it started"
        );
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
