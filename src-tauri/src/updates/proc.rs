//! Process, disk and thread facilities the update path needs, outside Tauri.

use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct ProcessImage {
    pub pid: u32,
    pub name: String,
    /// The full image path, when this account may read it.
    pub path: Option<PathBuf>,
}

/// A folder resolved once, for repeated containment checks.
#[derive(Debug, Clone)]
pub struct Folder {
    written: PathBuf,
    resolved: Option<PathBuf>,
}

impl Folder {
    pub fn new(dir: &Path) -> Self {
        Folder {
            written: dir.to_path_buf(),
            resolved: final_path(dir),
        }
    }

    /// Whether `path` lies inside this folder, compared case-insensitively by
    /// component, first as written and then as the final paths the file
    /// system resolves (junctions, symbolic links, substituted drives and
    /// short names), so a process started through another spelling of the
    /// folder still counts.
    pub fn contains(&self, path: &Path) -> bool {
        lexically_within(path, &self.written)
            || self
                .resolved
                .as_deref()
                .is_some_and(|dir| final_path(path).is_some_and(|path| lexically_within(&path, dir)))
    }
}

/// [`Folder::contains`] for one check.
pub fn path_is_within(path: &Path, dir: &Path) -> bool {
    Folder::new(dir).contains(path)
}

fn lexically_within(path: &Path, dir: &Path) -> bool {
    let lower = |p: &Path| -> Vec<String> {
        p.components()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    };
    let path = lower(path);
    let dir = lower(dir);
    path.len() > dir.len() && path[..dir.len()] == dir[..]
}

/// The path the file system resolves for an existing entry.
fn final_path(path: &Path) -> Option<PathBuf> {
    dunce::canonicalize(path).ok()
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};

    pub fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn wait_for_exit(pid: u32, timeout: Duration) -> bool {
        use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        let Ok(process) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }) else {
            return !crate::staging::process_running(pid);
        };
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        let waited = unsafe { WaitForSingleObject(process, millis) };
        unsafe {
            let _ = CloseHandle(process);
        }
        waited == WAIT_OBJECT_0
    }

    fn image_path(pid: u32) -> Option<PathBuf> {
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buffer = vec![0u16; 32 * 1024];
        let mut length = buffer.len() as u32;
        let queried = unsafe {
            QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut length)
        };
        unsafe {
            let _ = CloseHandle(process);
        }
        queried.ok()?;
        Some(PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize])))
    }

    /// The creation time of process `pid` as a FILETIME count, when this
    /// account may query it. A reused pid has a later creation time.
    pub fn creation_time(pid: u32) -> Option<u64> {
        use windows::Win32::Foundation::FILETIME;
        use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let (mut created, mut exited, mut kernel, mut user) =
            (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        let queried = unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) };
        unsafe {
            let _ = CloseHandle(process);
        }
        queried.ok()?;
        Some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    pub fn process_images() -> Option<Vec<ProcessImage>> {
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut images = Vec::new();
        let mut listed = unsafe { Process32FirstW(snapshot, &mut entry) };
        let complete = listed.is_ok();
        while listed.is_ok() {
            let length = entry.szExeFile.iter().position(|&u| u == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
            let pid = entry.th32ProcessID;
            if pid != 0 {
                images.push(ProcessImage { pid, path: image_path(pid), name });
            }
            listed = unsafe { Process32NextW(snapshot, &mut entry) };
        }
        unsafe {
            let _ = CloseHandle(snapshot);
        }
        complete.then_some(images)
    }

    /// Starts a process with no console, outside this process's job when the
    /// job allows it, with null standard handles and the given folder as its
    /// working folder.
    pub fn spawn_detached(exe: &Path, args: &[String], cwd: &Path) -> std::io::Result<u32> {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let build = |flags: u32| {
            let mut command = std::process::Command::new(exe);
            command
                .args(args)
                .current_dir(cwd)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(flags);
            command
        };
        let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        match build(base | CREATE_BREAKAWAY_FROM_JOB).spawn() {
            Ok(child) => Ok(child.id()),
            Err(_) => build(base).spawn().map(|child| child.id()),
        }
    }

    /// Low CPU, I/O and memory priority for the calling thread until the
    /// guard drops.
    pub struct Background(bool);

    impl Background {
        pub fn enter() -> Self {
            use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN};
            Background(unsafe { SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) }.is_ok())
        }
    }

    impl Drop for Background {
        fn drop(&mut self) {
            use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_END};
            if self.0 {
                unsafe {
                    let _ = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_END);
                }
            }
        }
    }

    pub fn free_bytes(path: &Path) -> Option<u64> {
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let mut probe = path.to_path_buf();
        while !probe.exists() {
            probe = probe.parent()?.to_path_buf();
        }
        let wide_path = wide(probe.as_os_str());
        let mut available = 0u64;
        unsafe { GetDiskFreeSpaceExW(PCWSTR(wide_path.as_ptr()), Some(&mut available), None, None) }.ok()?;
        Some(available)
    }

    pub fn running_as_system() -> bool {
        use windows::Win32::Security::{
            GetTokenInformation, IsWellKnownSid, TokenUser, WinLocalSystemSid, TOKEN_QUERY, TOKEN_USER,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        let mut token = HANDLE::default();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.is_err() {
            return false;
        }
        let mut buffer = vec![0u8; 256];
        let mut length = 0u32;
        let read = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                buffer.len() as u32,
                &mut length,
            )
        };
        unsafe {
            let _ = CloseHandle(token);
        }
        if read.is_err() {
            return false;
        }
        let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
        unsafe { IsWellKnownSid(user.User.Sid, WinLocalSystemSid) }.as_bool()
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn wait_for_exit(_pid: u32, _timeout: Duration) -> bool {
        false
    }

    pub fn process_images() -> Option<Vec<ProcessImage>> {
        None
    }

    pub fn creation_time(_pid: u32) -> Option<u64> {
        None
    }

    pub fn spawn_detached(exe: &Path, args: &[String], cwd: &Path) -> std::io::Result<u32> {
        std::process::Command::new(exe)
            .args(args)
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|child| child.id())
    }

    pub struct Background;

    impl Background {
        pub fn enter() -> Self {
            Background
        }
    }

    pub fn free_bytes(_path: &Path) -> Option<u64> {
        None
    }

    pub fn running_as_system() -> bool {
        false
    }
}

pub use imp::*;

/// Whether `process` counts as using `dir`: its image is inside `dir` and
/// outside every folder in `except`. `name` decides only for a process whose
/// image path this account cannot read, so a process of the same name that
/// runs from another folder never counts.
pub fn uses_dir(process: &ProcessImage, dir: &Folder, except: &[Folder], name: Option<&str>) -> bool {
    match process.path.as_deref() {
        Some(path) => dir.contains(path) && !except.iter().any(|e| e.contains(path)),
        None => name.is_some_and(|n| process.name.eq_ignore_ascii_case(n)),
    }
}

/// Processes other than this one that use `dir` ([`uses_dir`]), in every
/// session. `None` when the list cannot be taken.
pub fn processes_using(dir: &Path, except: &[PathBuf], name: Option<&str>) -> Option<Vec<ProcessImage>> {
    let except: Vec<Folder> = except.iter().map(|e| Folder::new(e)).collect();
    processes_using_folder(&Folder::new(dir), &except, name)
}

fn processes_using_folder(dir: &Folder, except: &[Folder], name: Option<&str>) -> Option<Vec<ProcessImage>> {
    let own = std::process::id();
    Some(
        process_images()?
            .into_iter()
            .filter(|p| p.pid != own)
            .filter(|p| uses_dir(p, dir, except, name))
            .collect(),
    )
}

/// Polls until no process uses `dir`, for at most `timeout`. The folders are
/// resolved once, before the first poll.
pub fn wait_until_unused(dir: &Path, except: &[PathBuf], name: Option<&str>, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    let dir = Folder::new(dir);
    let except: Vec<Folder> = except.iter().map(|e| Folder::new(e)).collect();
    loop {
        match processes_using_folder(&dir, &except, name) {
            Some(users) if users.is_empty() => return true,
            _ if std::time::Instant::now() >= deadline => return false,
            _ => std::thread::sleep(Duration::from_millis(500)),
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn containment_compares_components_without_case() {
        let dir = Path::new(r"C:\Program Files\Spectra PDF");
        assert!(path_is_within(Path::new(r"c:\program files\spectra pdf\python\python.exe"), dir));
        assert!(path_is_within(Path::new(r"C:\Program Files\Spectra PDF\spectrapdf.exe"), dir));
        assert!(!path_is_within(Path::new(r"C:\Program Files\Spectra PDF Other\x.exe"), dir));
        assert!(!path_is_within(dir, dir));
        assert!(!path_is_within(Path::new(r"C:\Program Files\x.exe"), dir));
    }

    #[cfg(windows)]
    #[test]
    fn containment_sees_through_a_junction_to_the_folder() {
        let base = std::env::temp_dir().join(format!("spectra-within-{}", std::process::id()));
        let real = base.join("real");
        let link = base.join("link");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(real.join("python")).unwrap();
        std::fs::write(real.join("python").join("python.exe"), b"").unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(made.success(), "the junction");
        let through_link = link.join("python").join("python.exe");
        assert!(path_is_within(&through_link, &real), "an image started through the junction");
        assert!(path_is_within(&real.join("python").join("python.exe"), &link), "the folder named through the junction");
        assert!(!path_is_within(&base.join("other.exe"), &real));
        std::fs::remove_dir(&link).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_process_of_the_same_name_counts_only_when_it_runs_from_the_folder() {
        let dir = &Folder::new(Path::new(r"C:\Program Files\Spectra PDF"));
        let image = |path: Option<&str>| ProcessImage {
            pid: 1,
            name: "spectrapdf.exe".to_string(),
            path: path.map(PathBuf::from),
        };
        let name = Some("spectrapdf.exe");
        assert!(!uses_dir(&image(Some(r"C:\Users\a\Downloads\spectrapdf.exe")), dir, &[], name));
        assert!(uses_dir(&image(Some(r"C:\Program Files\Spectra PDF\spectrapdf.exe")), dir, &[], name));
        assert!(uses_dir(&image(Some(r"C:\Program Files\Spectra PDF\python\python.exe")), dir, &[], name));
        assert!(uses_dir(&image(None), dir, &[], name), "an unreadable image of that name still counts");
        assert!(!uses_dir(&image(None), dir, &[], None));
    }

    #[cfg(windows)]
    #[test]
    fn this_test_process_is_listed_and_never_counts_as_a_user() {
        let images = process_images().expect("the process list");
        let own = std::process::id();
        let me = images.iter().find(|p| p.pid == own).expect("this process");
        let exe = std::env::current_exe().unwrap();
        assert_eq!(
            me.path.as_deref().map(|p| p.to_string_lossy().to_lowercase()),
            Some(exe.to_string_lossy().to_lowercase())
        );
        let users = processes_using(exe.parent().unwrap(), &[], None).unwrap();
        assert!(users.iter().all(|p| p.pid != own));
    }
}
