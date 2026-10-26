//! The installed container's update on Windows.
//!
//! The per-machine installer needs administrator rights, so a verified update
//! is applied by a scheduled task that runs as SYSTEM and that every signed-in
//! account may start. The task's action is fixed at registration and takes no
//! input: it reads the inbox, copies each staged installer into a folder only
//! SYSTEM and administrators can reach, verifies the COPY, and runs it.
//!
//! The machine folder is a root of its own under ProgramData. The product's
//! other ProgramData folder is writable by every account, so no SYSTEM write
//! may pass through it.

use std::fs;
#[cfg(windows)]
use std::io::Read;
#[cfg(windows)]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use super::proc;
#[cfg(windows)]
use super::source::Artifact;
#[cfg(windows)]
use super::verify;
use super::version::Version;

pub const TASK_PARENT: &str = "\\Spectra PDF";
pub const TASK_FOLDER: &str = "\\Spectra PDF\\System";
pub const TASK_PATH: &str = "\\Spectra PDF\\System\\Update";
pub const STAGE2_EXE: &str = "spectrapdf-update.exe";
pub const WAITER_EXE: &str = "spectrapdf-update-waiter.exe";
pub const MACHINE_DIR: &str = "Spectra PDF Update";
pub const MAIN_EXE: &str = "spectrapdf.exe";

/// The installer's switches for an unattended in-place update. `/D=` must be
/// last and unquoted.
pub fn installer_arguments(instdir: &Path) -> Vec<String> {
    vec![
        "/S".to_string(),
        "/UPDATE".to_string(),
        "/acceptEULA".to_string(),
        format!("/D={}", instdir.display()),
    ]
}

#[cfg(windows)]
const SDDL_ROOT: &str = "O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200a9;;;AU)";
#[cfg(windows)]
const SDDL_INBOX: &str = "O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200ab;;;AU)(A;OIIO;FA;;;CO)";
#[cfg(windows)]
const SDDL_RESULTS: &str = "O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;AU)";
#[cfg(windows)]
const SDDL_PRIVATE: &str = "O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
#[cfg(windows)]
const SDDL_TASK: &str = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;AU)";

const SID_SYSTEM: &str = "S-1-5-18";
const SID_ADMINISTRATORS: &str = "S-1-5-32-544";
const SID_TRUSTED_INSTALLER: &str = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const SID_CREATOR_OWNER: &str = "S-1-3-0";
const SID_CREATOR_GROUP: &str = "S-1-3-1";

#[derive(Debug, Clone)]
pub struct MachineLayout {
    pub root: PathBuf,
    pub inbox: PathBuf,
    pub results: PathBuf,
    pub system: PathBuf,
    pub verified: PathBuf,
    /// The installer's TEMP and TMP: SYSTEM and Administrators only, created
    /// fresh for each run. SYSTEM's own temp folder can admit other accounts.
    pub installer_temp: PathBuf,
}

impl MachineLayout {
    pub fn under(program_data: &Path) -> Self {
        let root = program_data.join(MACHINE_DIR);
        MachineLayout {
            inbox: root.join("inbox"),
            results: root.join("results"),
            system: root.join("system"),
            verified: root.join("verified"),
            installer_temp: root.join("temp"),
            root,
        }
    }

    pub fn result_path(&self, run_id: &str) -> PathBuf {
        self.results.join(format!("{run_id}.json"))
    }

    pub fn last_result(&self) -> PathBuf {
        self.results.join("last-result.json")
    }

    /// The file stage 2 holds open with no sharing while it runs. The folder
    /// admits only SYSTEM and Administrators, so no other account can hold it
    /// first.
    pub fn stage2_lock(&self) -> PathBuf {
        self.system.join("stage2.lock")
    }
}

/// A run id is 32 lowercase hexadecimal digits.
pub fn is_run_id(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn new_run_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Installed,
    Deferred,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub run_id: String,
    pub outcome: Outcome,
    pub version: String,
    /// Milliseconds since the Unix epoch.
    pub completed_at_ms: u64,
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// What one stage-2 run does with the verified candidates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyPlan {
    /// The candidate to run, the newest one above the installed version.
    pub install: Option<(String, Version)>,
    /// Candidates answered without running anything: refused ones fail, and
    /// ones at or below the installed version are already installed.
    pub settled: Vec<(String, Outcome, String)>,
    /// Older candidates above the installed version; they take the outcome of
    /// the one that runs.
    pub superseded: Vec<String>,
}

pub fn plan_apply(installed: Version, candidates: Vec<(String, Result<Version, String>)>) -> ApplyPlan {
    let mut settled = Vec::new();
    let mut eligible = Vec::new();
    for (id, verdict) in candidates {
        match verdict {
            Err(_) => settled.push((id, Outcome::Failed, String::new())),
            Ok(version) if version <= installed => {
                settled.push((id, Outcome::Installed, installed.to_string()))
            }
            Ok(version) => eligible.push((id, version)),
        }
    }
    eligible.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let mut eligible = eligible.into_iter();
    let install = eligible.next();
    ApplyPlan {
        install,
        settled,
        superseded: eligible.map(|(id, _)| id).collect(),
    }
}

/// The run ids in an inbox listing that have both their installer and their
/// signature.
pub fn inbox_pairs(names: &[String]) -> Vec<String> {
    let mut ids: Vec<String> = names
        .iter()
        .filter_map(|name| name.strip_suffix(".exe"))
        .filter(|id| is_run_id(id))
        .filter(|id| names.iter().any(|n| *n == format!("{id}.sig")))
        .map(str::to_string)
        .collect();
    ids.sort();
    ids
}

/// The ACE rights that let an account change what an elevated process runs.
pub mod risk {
    pub const FILE: u32 = 0x0000_0002 | 0x0000_0004 | 0x0001_0000 | 0x0004_0000 | 0x0008_0000 | 0x1000_0000 | 0x4000_0000;
    pub const INSTALL_DIR: u32 = FILE | 0x0000_0040;
    pub const ANCESTOR: u32 = 0x0000_0040 | 0x0001_0000 | 0x0004_0000 | 0x0008_0000 | 0x1000_0000;
}

/// Whether an allow entry gives a write-capable right to an account outside
/// SYSTEM, Administrators and TrustedInstaller. Inherit-only entries do not
/// apply to the object itself.
pub fn ace_lets_untrusted_write(sid: &str, mask: u32, inherit_only: bool, risky: u32) -> bool {
    if inherit_only || mask & risky == 0 {
        return false;
    }
    !matches!(
        sid,
        SID_SYSTEM | SID_ADMINISTRATORS | SID_TRUSTED_INSTALLER | SID_CREATOR_OWNER | SID_CREATOR_GROUP
    )
}

pub fn owner_is_trusted(sid: &str) -> bool {
    matches!(sid, SID_SYSTEM | SID_ADMINISTRATORS | SID_TRUSTED_INSTALLER)
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn task_xml(exe: &Path) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Installs verified Spectra PDF updates.</Description>
  </RegistrationInfo>
  <Principals>
    <Principal id="System">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="System">
    <Exec>
      <Command>"{}"</Command>
      <Arguments>--system-update</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        xml_escape(&exe.display().to_string())
    )
}

pub fn read_result(path: &Path) -> Option<RunResult> {
    super::portable_update::read_json(path)
}

/// The result at `path` only when it was completed at or after `since_ms`. A
/// run id survives a deferral, so the file can still hold the answer to an
/// earlier attempt.
pub fn fresh_result(path: &Path, since_ms: u64) -> Option<RunResult> {
    read_result(path).filter(|result| result.completed_at_ms >= since_ms)
}

/// Removes the result file of every pair about to be handed to stage 2.
pub fn clear_stale_results(layout: &MachineLayout, pairs: &[String]) {
    for id in pairs {
        let _ = fs::remove_file(layout.result_path(id));
    }
}

/// Removes every `<name>.old-<run id>` folder in `parent`. A folder that
/// still holds an open file stays for a later run.
pub fn remove_set_aside(parent: &Path, name: &str) {
    let prefix = format!("{name}.old-");
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_name) = entry.file_name().into_string() else {
            continue;
        };
        let is_set_aside = file_name.strip_prefix(&prefix).is_some_and(is_run_id);
        let is_plain_dir = entry.file_type().is_ok_and(|t| t.is_dir() && !t.is_symlink());
        if is_set_aside && is_plain_dir {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

// ── Windows implementation ────────────────────────────────────────────────

#[cfg(windows)]
mod win {
    use super::*;
    use windows::core::{BSTR, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetNamedSecurityInfoW, SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        GetAce, GetAclInformation, GetSecurityDescriptorDacl, GetSecurityDescriptorGroup, AclSizeInformation,
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
        GROUP_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    };
    use windows::Win32::System::Variant::VARIANT;

    use super::proc::wide;

    pub fn program_data() -> Result<PathBuf, String> {
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::UI::Shell::{FOLDERID_ProgramData, SHGetKnownFolderPath, KF_FLAG_DEFAULT};
        let path = unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramData, KF_FLAG_DEFAULT, None) }
            .map_err(|e| format!("Cannot resolve ProgramData: {e}"))?;
        let text = unsafe { path.to_string() };
        unsafe { CoTaskMemFree(Some(path.0 as *const core::ffi::c_void)) };
        let text = text.map_err(|_| "ProgramData is not a valid path".to_string())?;
        let dir = PathBuf::from(text);
        if dir.is_absolute() {
            Ok(dir)
        } else {
            Err("ProgramData is not an absolute path".to_string())
        }
    }

    struct Descriptor(PSECURITY_DESCRIPTOR);

    impl Drop for Descriptor {
        fn drop(&mut self) {
            if !self.0 .0.is_null() {
                unsafe {
                    let _ = LocalFree(Some(HLOCAL(self.0 .0)));
                }
            }
        }
    }

    fn descriptor(sddl: &str) -> Result<Descriptor, String> {
        let text = wide(std::ffi::OsStr::new(sddl));
        let mut sd = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(text.as_ptr()), SDDL_REVISION_1, &mut sd, None)
        }
        .map_err(|e| format!("The security descriptor {sddl} cannot be built: {e}"))?;
        Ok(Descriptor(sd))
    }

    pub fn sddl_is_valid(sddl: &str) -> bool {
        descriptor(sddl).is_ok()
    }

    fn sid_string(sid: PSID) -> Option<String> {
        let mut text = PWSTR::null();
        unsafe { ConvertSidToStringSidW(sid, &mut text) }.ok()?;
        let value = unsafe { text.to_string() }.ok();
        unsafe {
            let _ = LocalFree(Some(HLOCAL(text.0.cast())));
        }
        value
    }

    /// The owner SID and the allow entries of `path`'s DACL. `None` for the
    /// entries means a null DACL, which grants everyone everything.
    #[allow(clippy::type_complexity)]
    fn security_of(path: &Path) -> Result<(String, Option<Vec<(String, u32, bool)>>), String> {
        let name = wide(path.as_os_str());
        let mut owner = PSID::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let status = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(name.as_ptr()),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                Some(&mut owner),
                None,
                Some(&mut dacl),
                None,
                &mut sd,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!(
                "Cannot read the permissions of {}: {}",
                path.display(),
                std::io::Error::from_raw_os_error(status.0 as i32)
            ));
        }
        let sd = Descriptor(sd);
        let owner_sid = sid_string(owner).unwrap_or_default();
        if dacl.is_null() {
            drop(sd);
            return Ok((owner_sid, None));
        }
        let mut info = ACL_SIZE_INFORMATION::default();
        unsafe {
            GetAclInformation(
                dacl,
                (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        }
        .map_err(|e| format!("Cannot read the permissions of {}: {e}", path.display()))?;
        let mut entries = Vec::new();
        for index in 0..info.AceCount {
            let mut ace: *mut core::ffi::c_void = std::ptr::null_mut();
            unsafe { GetAce(dacl, index, &mut ace) }
                .map_err(|e| format!("Cannot read the permissions of {}: {e}", path.display()))?;
            let header = unsafe { &*(ace as *const ACE_HEADER) };
            const ACCESS_ALLOWED: u8 = 0;
            const ACCESS_ALLOWED_CALLBACK: u8 = 9;
            if header.AceType != ACCESS_ALLOWED && header.AceType != ACCESS_ALLOWED_CALLBACK {
                continue;
            }
            let allowed = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
            let sid = PSID((&allowed.SidStart as *const u32) as *mut core::ffi::c_void);
            let inherit_only = header.AceFlags & 0x08 != 0;
            entries.push((sid_string(sid).unwrap_or_default(), allowed.Mask, inherit_only));
        }
        drop(sd);
        Ok((owner_sid, Some(entries)))
    }

    fn untrusted_in(path: &Path, risky: u32, found: &mut Vec<String>) -> Result<(), String> {
        let (owner, entries) = security_of(path)?;
        if !owner_is_trusted(&owner) {
            found.push(format!("{} is owned by {owner}", path.display()));
        }
        match entries {
            None => found.push(format!("{} has no access list", path.display())),
            Some(entries) => {
                for (sid, mask, inherit_only) in entries {
                    if ace_lets_untrusted_write(&sid, mask, inherit_only, risky) {
                        found.push(format!("{} lets {sid} change it (0x{mask:08x})", path.display()));
                    }
                }
            }
        }
        Ok(())
    }

    /// Every way an account other than SYSTEM, Administrators or
    /// TrustedInstaller could change what the SYSTEM task runs: the
    /// executable, its folder (a planted library), and every folder above it
    /// (a renamed folder replaced by another).
    pub fn untrusted_writers(exe: &Path) -> Result<Vec<String>, String> {
        let mut found = Vec::new();
        untrusted_in(exe, risk::FILE, &mut found)?;
        let mut dir = exe.parent().map(Path::to_path_buf);
        let mut first = true;
        while let Some(current) = dir {
            if current.parent().is_none() {
                break;
            }
            untrusted_in(&current, if first { risk::INSTALL_DIR } else { risk::ANCESTOR }, &mut found)?;
            first = false;
            dir = current.parent().map(Path::to_path_buf);
        }
        Ok(found)
    }

    fn is_reparse(meta: &fs::Metadata) -> bool {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }

    fn create_with(path: &Path, sddl: &str) -> Result<(), String> {
        use windows::Win32::Storage::FileSystem::CreateDirectoryW;
        let name = wide(path.as_os_str());
        let attempt = |sddl: &str| -> Result<(), windows::core::Error> {
            let sd = descriptor(sddl).map_err(|e| windows::core::Error::new(windows::core::HRESULT(-1), e))?;
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd.0 .0,
                bInheritHandle: false.into(),
            };
            unsafe { CreateDirectoryW(PCWSTR(name.as_ptr()), Some(&attributes)) }
        };
        match attempt(sddl) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == windows::Win32::Foundation::ERROR_INVALID_OWNER.to_hresult() => {
                attempt(sddl.trim_start_matches("O:BA")).map_err(|e| format!("Cannot create {}: {e}", path.display()))
            }
            Err(error) => Err(format!("Cannot create {}: {error}", path.display())),
        }
    }

    fn reassert(path: &Path, sddl: &str) -> Result<(), String> {
        let sd = descriptor(sddl)?;
        let mut present = windows::core::BOOL::default();
        let mut defaulted = windows::core::BOOL::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        unsafe { GetSecurityDescriptorDacl(sd.0, &mut present, &mut dacl, &mut defaulted) }
            .map_err(|e| format!("Cannot read a security descriptor: {e}"))?;
        let mut group = PSID::default();
        let mut group_defaulted = windows::core::BOOL::default();
        unsafe { GetSecurityDescriptorGroup(sd.0, &mut group, &mut group_defaulted) }
            .map_err(|e| format!("Cannot read a security descriptor: {e}"))?;
        let has_group = !group.0.is_null();
        let mut information = DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
        if has_group {
            information |= GROUP_SECURITY_INFORMATION;
        }
        let name = wide(path.as_os_str());
        let status = unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(name.as_ptr()),
                SE_FILE_OBJECT,
                information,
                None,
                has_group.then_some(group),
                Some(dacl),
                None,
            )
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!(
                "Cannot set the permissions of {}: {}",
                path.display(),
                std::io::Error::from_raw_os_error(status.0 as i32)
            ))
        }
    }

    /// Makes `path` a real folder owned by SYSTEM or Administrators with
    /// exactly `sddl`'s access. A link, or a folder another account owns, is
    /// moved aside and removed first, so no handle opened earlier by another
    /// account reaches the folder that is used.
    pub fn secure_dir(path: &Path, sddl: &str) -> Result<(), String> {
        if let Ok(meta) = fs::symlink_metadata(path) {
            let trusted = !is_reparse(&meta)
                && meta.is_dir()
                && security_of(path).map(|(owner, _)| owner_is_trusted(&owner)).unwrap_or(false);
            if trusted {
                return reassert(path, sddl);
            }
            if is_reparse(&meta) {
                fs::remove_dir(path)
                    .or_else(|_| fs::remove_file(path))
                    .map_err(|e| format!("Cannot remove the link {}: {e}", path.display()))?;
            } else {
                let aside = path.with_file_name(format!(
                    "{}.untrusted-{}",
                    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    new_run_id()
                ));
                fs::rename(path, &aside).map_err(|e| format!("Cannot move {} aside: {e}", path.display()))?;
                let _ = if aside.is_dir() { fs::remove_dir_all(&aside) } else { fs::remove_file(&aside) };
            }
        }
        create_with(path, sddl)
    }

    pub fn secure_layout(layout: &MachineLayout) -> Result<(), String> {
        secure_dir(&layout.root, SDDL_ROOT)?;
        secure_dir(&layout.inbox, SDDL_INBOX)?;
        secure_dir(&layout.results, SDDL_RESULTS)?;
        secure_dir(&layout.system, SDDL_PRIVATE)?;
        secure_dir(&layout.verified, SDDL_PRIVATE)
    }

    /// Empties a private folder by recreating it. Earlier copies set aside
    /// that could not be removed then (a file still held) are removed now
    /// when possible.
    pub fn renew_private(path: &Path) -> Result<(), String> {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if fs::symlink_metadata(path).is_ok() {
            let aside = path.with_file_name(format!("{name}.old-{}", new_run_id()));
            fs::rename(path, &aside).map_err(|e| format!("Cannot clear {}: {e}", path.display()))?;
            let _ = fs::remove_dir_all(&aside);
        }
        if let Some(parent) = path.parent() {
            remove_set_aside(parent, &name);
        }
        create_with(path, SDDL_PRIVATE)
    }

    fn with_task_service<T: Send + 'static>(
        work: impl FnOnce(&windows::Win32::System::TaskScheduler::ITaskService) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        std::thread::spawn(move || {
            use windows::Win32::System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            };
            use windows::Win32::System::TaskScheduler::{ITaskService, TaskScheduler};
            unsafe {
                let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let outcome = (|| {
                    let service: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)
                        .map_err(|e| format!("Task Scheduler is unavailable: {}", e.message()))?;
                    service
                        .Connect(&VARIANT::default(), &VARIANT::default(), &VARIANT::default(), &VARIANT::default())
                        .map_err(|e| format!("Cannot connect to Task Scheduler: {}", e.message()))?;
                    work(&service)
                })();
                if init.is_ok() {
                    CoUninitialize();
                }
                outcome
            }
        })
        .join()
        .map_err(|_| "The Task Scheduler thread stopped".to_string())?
    }

    const ERROR_ALREADY_EXISTS_HR: u32 = 0x8007_00B7;

    pub fn register_task(exe: PathBuf) -> Result<(), String> {
        with_task_service(move |service| unsafe {
            use windows::Win32::System::TaskScheduler::{TASK_CREATE_OR_UPDATE, TASK_LOGON_SERVICE_ACCOUNT};
            let root = service
                .GetFolder(&BSTR::from("\\"))
                .map_err(|e| format!("Cannot open the task root: {}", e.message()))?;
            if root.GetFolder(&BSTR::from(TASK_PARENT)).is_err() {
                if let Err(e) = root.CreateFolder(&BSTR::from(TASK_PARENT), &VARIANT::default()) {
                    if e.code().0 as u32 != ERROR_ALREADY_EXISTS_HR {
                        return Err(format!("Cannot create the task folder: {}", e.message()));
                    }
                }
            }
            match root.GetFolder(&BSTR::from(TASK_FOLDER)) {
                Ok(folder) => folder
                    .SetSecurityDescriptor(&BSTR::from(SDDL_TASK), 0)
                    .map_err(|e| format!("Cannot secure the task folder: {}", e.message()))?,
                Err(_) => {
                    root.CreateFolder(&BSTR::from(TASK_FOLDER), &VARIANT::from(SDDL_TASK))
                        .map_err(|e| format!("Cannot create the task folder: {}", e.message()))?;
                }
            }
            root.RegisterTask(
                &BSTR::from(TASK_PATH),
                &BSTR::from(task_xml(&exe).as_str()),
                TASK_CREATE_OR_UPDATE.0,
                &VARIANT::from(SID_SYSTEM),
                &VARIANT::default(),
                TASK_LOGON_SERVICE_ACCOUNT,
                &VARIANT::from(SDDL_TASK),
            )
            .map(|_| ())
            .map_err(|e| format!("Cannot register the update task: {}", e.message()))
        })
    }

    pub fn unregister_task() -> Result<(), String> {
        with_task_service(|service| unsafe {
            let root = service
                .GetFolder(&BSTR::from("\\"))
                .map_err(|e| format!("Cannot open the task root: {}", e.message()))?;
            if let Ok(folder) = root.GetFolder(&BSTR::from(TASK_FOLDER)) {
                let _ = folder.DeleteTask(&BSTR::from("Update"), 0);
            }
            let _ = root.DeleteFolder(&BSTR::from(TASK_FOLDER), 0);
            let _ = root.DeleteFolder(&BSTR::from(TASK_PARENT), 0);
            Ok(())
        })
    }

    pub fn task_present() -> bool {
        with_task_service(|service| unsafe {
            service
                .GetFolder(&BSTR::from(TASK_FOLDER))
                .and_then(|folder| folder.GetTask(&BSTR::from("Update")))
                .map(|_| ())
                .map_err(|e| e.message().to_string())
        })
        .is_ok()
    }

    pub fn run_task() -> Result<(), String> {
        with_task_service(|service| unsafe {
            service
                .GetFolder(&BSTR::from(TASK_FOLDER))
                .and_then(|folder| folder.GetTask(&BSTR::from("Update")))
                .and_then(|task| task.Run(&VARIANT::default()))
                .map(|_| ())
                .map_err(|e| format!("Cannot start the update task: {}", e.message()))
        })
    }

    /// Runs `installer` with the update switches through the elevation
    /// prompt and waits for it. The exit code is the installer's.
    pub fn run_elevated(installer: &Path, instdir: &Path, timeout: Duration) -> Result<u32, String> {
        use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let verb = wide(std::ffi::OsStr::new("runas"));
        let file = wide(installer.as_os_str());
        let parameters = wide(std::ffi::OsStr::new(&installer_arguments(instdir).join(" ")));
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(parameters.as_ptr()),
            nShow: SW_SHOWNORMAL.0,
            ..Default::default()
        };
        unsafe { ShellExecuteExW(&mut info) }.map_err(|e| format!("The installer did not start: {}", e.message()))?;
        if info.hProcess.is_invalid() {
            return Err("The installer did not start".to_string());
        }
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        let waited = unsafe { WaitForSingleObject(info.hProcess, millis) };
        let mut code = 1u32;
        if waited == WAIT_OBJECT_0 {
            let _ = unsafe { GetExitCodeProcess(info.hProcess, &mut code) };
        }
        unsafe {
            let _ = CloseHandle(info.hProcess);
        }
        if waited == WAIT_OBJECT_0 {
            Ok(code)
        } else {
            Err("The installer did not finish in time".to_string())
        }
    }

    /// One instance of stage 2 per machine: the lock file is open with no
    /// sharing for as long as this value lives.
    pub struct MachineLock(#[allow(dead_code)] fs::File);

    impl MachineLock {
        pub fn take(path: &Path) -> Option<Self> {
            use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
            const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
            let file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .share_mode(0)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .ok()?;
            let plain = file
                .metadata()
                .is_ok_and(|m| m.is_file() && m.file_attributes() & 0x400 == 0);
            plain.then_some(MachineLock(file))
        }
    }

    /// Opens a file without following a link and refuses a link, a non-file
    /// and a file with more than one name. While the handle is open, no other
    /// handle can write, rename or delete the file; readers and image loads
    /// still succeed.
    pub fn open_held_file(path: &Path) -> Result<fs::File, String> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_SHARE_READ: u32 = 0x1;
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        let meta = file.metadata().map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        if meta.file_attributes() & 0x400 != 0 || !meta.is_file() {
            return Err(format!("{} is not a plain file", path.display()));
        }
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe {
            GetFileInformationByHandle(windows::Win32::Foundation::HANDLE(file.as_raw_handle()), &mut info)
        }
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
        if info.nNumberOfLinks != 1 {
            return Err(format!("{} has more than one name", path.display()));
        }
        Ok(file)
    }

    /// Copies `source` to `copy` (which must not exist), opens the copy with
    /// [`open_held_file`] and verifies the bytes read through that handle. The
    /// returned handle keeps the verified bytes in place: it must stay open
    /// until every process that runs the copy has ended.
    pub fn hold_verified_copy(
        source: &Path,
        copy: &Path,
        signature: &minisign_verify::Signature,
        key: &minisign_verify::PublicKey,
        expected: &str,
    ) -> Result<fs::File, String> {
        let cap = Artifact::Installer.cap();
        {
            let input = fs::File::open(source).map_err(|e| format!("Cannot read the installer: {e}"))?;
            let mut out = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(copy)
                .map_err(|e| format!("Cannot copy the installer: {e}"))?;
            std::io::copy(&mut input.take(cap + 1), &mut out).map_err(|e| format!("Cannot copy the installer: {e}"))?;
            out.sync_all().map_err(|e| format!("Cannot copy the installer: {e}"))?;
        }
        let held = open_held_file(copy)?;
        let length = held.metadata().map(|m| m.len()).map_err(|e| format!("Cannot read the installer: {e}"))?;
        if length > cap {
            return Err("The installer is larger than an update can be".to_string());
        }
        verify::verify_reader(&held, signature, key, expected).map_err(|e| e.to_string())?;
        Ok(held)
    }
}

#[cfg(windows)]
pub use win::{
    hold_verified_copy, open_held_file, program_data, register_task, renew_private, run_elevated, run_task, sddl_is_valid,
    secure_layout, task_present, unregister_task, untrusted_writers, MachineLock,
};

#[cfg(windows)]
pub fn machine_layout() -> Result<MachineLayout, String> {
    Ok(MachineLayout::under(&program_data()?))
}

#[cfg(not(windows))]
pub fn machine_layout() -> Result<MachineLayout, String> {
    Err(crate::platform::Unsupported::new(crate::platform::feature::AUTOMATIC_UPDATES).to_string())
}

#[cfg(not(windows))]
pub fn task_present() -> bool {
    false
}

// ── The CLI modes ─────────────────────────────────────────────────────────

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_UNSAFE_FOLDER: i32 = 3;
pub const EXIT_NOT_SYSTEM: i32 = 5;

#[cfg(windows)]
fn write_result(layout: &MachineLayout, result: &RunResult) {
    let _ = super::portable_update::write_json(&layout.result_path(&result.run_id), result);
    let _ = super::portable_update::write_json(&layout.last_result(), result);
}

#[cfg(windows)]
fn settle(layout: &MachineLayout, ids: &[String], outcome: Outcome, version: &str) {
    for id in ids {
        write_result(
            layout,
            &RunResult {
                run_id: id.clone(),
                outcome,
                version: version.to_string(),
                completed_at_ms: now_millis(),
            },
        );
    }
}

#[cfg(windows)]
fn inbox_names(layout: &MachineLayout) -> Vec<String> {
    fs::read_dir(&layout.inbox)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(windows)]
fn remove_inbox_run(layout: &MachineLayout, id: &str) {
    let _ = fs::remove_file(layout.inbox.join(format!("{id}.exe")));
    let _ = fs::remove_file(layout.inbox.join(format!("{id}.sig")));
}

/// Inbox entries that are no run's pair and older than two days, and result
/// files older than thirty days, are removed.
#[cfg(windows)]
fn prune(layout: &MachineLayout, pairs: &[String]) {
    let now = SystemTime::now();
    let older_than = |path: &Path, age: Duration| {
        fs::symlink_metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|d| d > age)
    };
    for name in inbox_names(layout) {
        let id = name.split('.').next().unwrap_or("");
        if pairs.iter().any(|p| p == id) {
            continue;
        }
        let path = layout.inbox.join(&name);
        if older_than(&path, Duration::from_secs(2 * 24 * 3600)) {
            let _ = fs::remove_file(&path);
        }
    }
    if let Ok(entries) = fs::read_dir(&layout.results) {
        for entry in entries.flatten() {
            let path = entry.path();
            if older_than(&path, Duration::from_secs(30 * 24 * 3600)) {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

#[cfg(windows)]
fn policy_disabled() -> bool {
    crate::commands::machine_policy_set("DisableAutoUpdate")
}

/// `--register-update-task`, run elevated by the installer.
#[cfg(windows)]
pub fn register_cli() -> i32 {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(e) => {
            eprintln!("Cannot resolve this executable: {e}");
            return EXIT_FAILED;
        }
    };
    match untrusted_writers(&exe) {
        Ok(found) if found.is_empty() => {}
        Ok(found) => {
            eprintln!("The update task was not registered: {}", found.join("; "));
            return EXIT_UNSAFE_FOLDER;
        }
        Err(e) => {
            eprintln!("The update task was not registered: {e}");
            return EXIT_FAILED;
        }
    }
    let outcome = machine_layout()
        .and_then(|layout| secure_layout(&layout))
        .and_then(|()| register_task(exe));
    match outcome {
        Ok(()) => EXIT_OK,
        Err(e) => {
            eprintln!("{e}");
            EXIT_FAILED
        }
    }
}

/// `--unregister-update-task`, run elevated by the uninstaller.
#[cfg(windows)]
pub fn unregister_cli() -> i32 {
    let task = unregister_task();
    let folder = machine_layout().and_then(|layout| match fs::remove_dir_all(&layout.root) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot remove {}: {e}", layout.root.display())),
    });
    match task.and(folder) {
        Ok(()) => EXIT_OK,
        Err(e) => {
            eprintln!("{e}");
            EXIT_FAILED
        }
    }
}

/// `--system-update` stage 1: runs from the install folder as SYSTEM, copies
/// itself into the private folder and starts that copy, so the install folder
/// holds no running image while the installer replaces it.
#[cfg(windows)]
pub fn stage1() -> i32 {
    if !proc::running_as_system() {
        return EXIT_NOT_SYSTEM;
    }
    let run = || -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let instdir = exe.parent().ok_or("no install folder")?.to_path_buf();
        let layout = machine_layout()?;
        secure_layout(&layout)?;
        if policy_disabled() {
            let pairs = inbox_pairs(&inbox_names(&layout));
            settle_claimed(&layout, &pairs, Outcome::Failed);
            for id in &pairs {
                remove_inbox_run(&layout, id);
            }
            return Ok(());
        }
        clear_stale_results(&layout, &inbox_pairs(&inbox_names(&layout)));
        renew_private(&layout.system)?;
        let copy = layout.system.join(STAGE2_EXE);
        fs::copy(&exe, &copy).map_err(|e| format!("Cannot copy the update program: {e}"))?;
        let args = vec![
            "--system-update-stage2".to_string(),
            "--instdir".to_string(),
            instdir.display().to_string(),
        ];
        proc::spawn_detached(&copy, &args, &layout.system)
            .map(|_| ())
            .map_err(|e| format!("Cannot start the update program: {e}"))
    };
    match run() {
        Ok(()) => EXIT_OK,
        Err(_) => EXIT_FAILED,
    }
}

/// The version an inbox pair's signature names, read without verifying the
/// signature: a result reports it, and nothing runs on it. Empty when the
/// signature cannot be read or names no installer of this product.
#[cfg(windows)]
fn claimed_version(layout: &MachineLayout, id: &str) -> String {
    let mut text = String::new();
    let read = open_held_file(&layout.inbox.join(format!("{id}.sig")))
        .and_then(|file| file.take(4096).read_to_string(&mut text).map_err(|e| e.to_string()));
    if read.is_err() {
        return String::new();
    }
    verify::signature(&text)
        .ok()
        .and_then(|signature| {
            verify::signed_file_name(&signature).and_then(|name| Artifact::Installer.version_of_signed_name(name))
        })
        .map(|version| version.to_string())
        .unwrap_or_default()
}

/// [`settle`] for pairs that were never verified, each with the version its
/// signature names.
#[cfg(windows)]
fn settle_claimed(layout: &MachineLayout, ids: &[String], outcome: Outcome) {
    for id in ids {
        settle(layout, std::slice::from_ref(id), outcome, &claimed_version(layout, id));
    }
}

/// Copies one inbox pair into the private folder and verifies the copy.
#[cfg(windows)]
fn take_candidate(layout: &MachineLayout, id: &str, key: &minisign_verify::PublicKey) -> Result<Version, String> {
    let mut sig_text = String::new();
    open_held_file(&layout.inbox.join(format!("{id}.sig")))?
        .take(4096)
        .read_to_string(&mut sig_text)
        .map_err(|e| format!("Cannot read the signature: {e}"))?;
    let signature = verify::signature(&sig_text)?;
    let name = verify::signed_file_name(&signature).ok_or("The signature names no file")?;
    let version = Artifact::Installer
        .version_of_signed_name(name)
        .ok_or_else(|| format!("{name} is not an installer of this product"))?;
    let mut source = open_held_file(&layout.inbox.join(format!("{id}.exe")))?;
    let target = layout.verified.join(format!("{id}.exe"));
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("Cannot copy the installer: {e}"))?;
    std::io::copy(&mut (&mut source).take(Artifact::Installer.cap() + 1), &mut out)
        .map_err(|e| format!("Cannot copy the installer: {e}"))?;
    out.flush().and_then(|()| out.sync_all()).map_err(|e| format!("Cannot copy the installer: {e}"))?;
    drop(out);
    if fs::metadata(&target).map(|m| m.len()).unwrap_or(u64::MAX) > Artifact::Installer.cap() {
        return Err("The installer is larger than an update can be".to_string());
    }
    verify::verify_file(&target, &signature, key, &Artifact::Installer.signed_name(version))
        .map_err(|e| e.to_string())?;
    Ok(version)
}

/// The environment entries the installer runs with: its temp folder is the
/// private one, never the inherited one.
pub fn installer_environment(temp: &Path) -> [(&'static str, PathBuf); 2] {
    [("TEMP", temp.to_path_buf()), ("TMP", temp.to_path_buf())]
}

/// Runs the installer inside a kill-on-close job and waits at most
/// `timeout`. On a timeout every process of the job is ended and waited for
/// before this returns, so the temp folder is free and the stage-2 lock is
/// never released while an installer still runs.
#[cfg(windows)]
fn run_installer(installer: &Path, instdir: &Path, temp: &Path, timeout: Duration) -> Result<i32, String> {
    use std::os::windows::process::CommandExt;
    let mut args = installer_arguments(instdir);
    let target = args.pop().unwrap_or_default();
    let mut command = std::process::Command::new(installer);
    command
        .args(&args)
        .raw_arg(target)
        .envs(installer_environment(temp))
        .current_dir(installer.parent().unwrap_or(Path::new(".")))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    watch_in_job(command, timeout)
}

/// Starts `command` in a kill-on-close job and waits at most `timeout` for
/// it. On a timeout, or when the child cannot be watched, every process of the
/// job is ended and waited for. Processes the child left behind end when the
/// job closes.
#[cfg(windows)]
fn watch_in_job(command: std::process::Command, timeout: Duration) -> Result<i32, String> {
    let (mut child, job) = crate::process_job::ProcessJob::spawn(command, 0)
        .map_err(|e| format!("The installer did not start: {e}"))?;
    let deadline = Instant::now() + timeout;
    let failure = loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.code().unwrap_or(1)),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(500)),
            Ok(None) => break "The installer did not finish in time".to_string(),
            Err(e) => break format!("The installer could not be watched: {e}"),
        }
    };
    let emptied = job.terminate_and_wait(Duration::from_secs(60));
    let _ = child.wait();
    if emptied {
        Err(failure)
    } else {
        Err(format!("{failure}, and its processes did not end"))
    }
}

/// `--system-update-stage2`: runs as SYSTEM from the private folder.
#[cfg(windows)]
pub fn stage2(instdir: &Path) -> i32 {
    if !proc::running_as_system() {
        return EXIT_NOT_SYSTEM;
    }
    let Ok(layout) = machine_layout() else {
        return EXIT_FAILED;
    };
    let in_private = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .is_some_and(|dir| {
            dir.to_string_lossy().to_lowercase() == layout.system.to_string_lossy().to_lowercase()
        });
    if !in_private || !instdir.join(MAIN_EXE).is_file() {
        return EXIT_USAGE;
    }
    let Some(_lock) = MachineLock::take(&layout.stage2_lock()) else {
        return EXIT_OK;
    };
    if secure_layout(&layout).is_err() {
        return EXIT_FAILED;
    }
    let pairs = inbox_pairs(&inbox_names(&layout));
    prune(&layout, &pairs);
    if pairs.is_empty() {
        return EXIT_OK;
    }
    if policy_disabled() {
        settle_claimed(&layout, &pairs, Outcome::Failed);
        for id in &pairs {
            remove_inbox_run(&layout, id);
        }
        return EXIT_OK;
    }
    if renew_private(&layout.verified).is_err() {
        return EXIT_FAILED;
    }
    let key = match super::source::source().and_then(|s| verify::public_key(&s.public_key)) {
        Ok(key) => key,
        Err(_) => {
            settle_claimed(&layout, &pairs, Outcome::Failed);
            return EXIT_FAILED;
        }
    };
    let candidates: Vec<(String, Result<Version, String>)> = pairs
        .iter()
        .map(|id| (id.clone(), take_candidate(&layout, id, &key)))
        .collect();
    let plan = plan_apply(Version::running(), candidates);
    for (id, outcome, version) in &plan.settled {
        settle(&layout, std::slice::from_ref(id), *outcome, version);
        remove_inbox_run(&layout, id);
    }
    if let Some((id, version)) = &plan.install {
        let mut everyone = plan.superseded.clone();
        everyone.push(id.clone());
        // The in-use check runs after every copy is verified, so the installer
        // starts right after the check passes.
        if !proc::wait_until_unused(instdir, &[], Some(MAIN_EXE), Duration::from_secs(120)) {
            settle(&layout, &everyone, Outcome::Deferred, &version.to_string());
            let _ = renew_private(&layout.verified);
            return EXIT_OK;
        }
        let installer = layout.verified.join(format!("{id}.exe"));
        let outcome = match renew_private(&layout.installer_temp)
            .and_then(|()| run_installer(&installer, instdir, &layout.installer_temp, Duration::from_secs(3600)))
        {
            Ok(0) => Outcome::Installed,
            _ => Outcome::Failed,
        };
        let _ = renew_private(&layout.installer_temp);
        settle(&layout, &everyone, outcome, &version.to_string());
    }
    for id in &pairs {
        remove_inbox_run(&layout, id);
    }
    let _ = renew_private(&layout.verified);
    EXIT_OK
}

/// The arguments of `--await-update`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AwaitArgs {
    pub run_id: String,
    pub parent: u32,
    pub instdir: PathBuf,
    pub staged: PathBuf,
    pub version: String,
    pub state_dir: PathBuf,
    pub relaunch: bool,
}

impl AwaitArgs {
    pub fn to_args(&self) -> Vec<String> {
        let mut args = vec![
            "--await-update".to_string(),
            "--run-id".to_string(),
            self.run_id.clone(),
            "--parent".to_string(),
            self.parent.to_string(),
            "--instdir".to_string(),
            self.instdir.display().to_string(),
            "--staged".to_string(),
            self.staged.display().to_string(),
            "--version".to_string(),
            self.version.clone(),
            "--state-dir".to_string(),
            self.state_dir.display().to_string(),
        ];
        if self.relaunch {
            args.push("--relaunch".to_string());
        }
        args
    }

    pub fn parse(args: &[String]) -> Option<Self> {
        let flags = super::cli::Flags::parse(args)?;
        let run_id = flags.value("--run-id")?.to_string();
        if !is_run_id(&run_id) {
            return None;
        }
        Some(AwaitArgs {
            run_id,
            parent: flags.value("--parent")?.parse().ok()?,
            instdir: PathBuf::from(flags.value("--instdir")?),
            staged: PathBuf::from(flags.value("--staged")?),
            version: Version::parse(flags.value("--version")?)?.to_string(),
            state_dir: PathBuf::from(flags.value("--state-dir")?),
            relaunch: flags.has("--relaunch"),
        })
    }
}

/// What the waiter records for the next start of the app.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastApply {
    pub run_id: String,
    pub outcome: Outcome,
    pub version: String,
}

pub const LAST_APPLY_FILE: &str = "last-apply.json";
pub const PENDING_RUN_FILE: &str = "pending-run.json";
pub const FAILED_FILE: &str = "failed-update.json";

#[cfg(windows)]
fn stage2_running() -> bool {
    proc::process_images()
        .map(|images| images.iter().any(|p| p.name.eq_ignore_ascii_case(STAGE2_EXE)))
        .unwrap_or(true)
}

#[cfg(windows)]
fn await_task_result(layout: &MachineLayout, run_id: &str, since_ms: u64) -> Option<Outcome> {
    let started = Instant::now();
    let path = layout.result_path(run_id);
    let mut idle_since: Option<Instant> = None;
    while started.elapsed() < Duration::from_secs(90 * 60) {
        if let Some(result) = fresh_result(&path, since_ms) {
            return Some(result.outcome);
        }
        if started.elapsed() > Duration::from_secs(20) && !stage2_running() {
            let since = *idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() > Duration::from_secs(10) {
                return fresh_result(&path, since_ms).map(|r| r.outcome).or(Some(Outcome::Failed));
            }
        } else {
            idle_since = None;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    Some(Outcome::Failed)
}

/// The elevation-prompt path for a machine whose task is missing: the staged
/// pair is copied into this account's own folder, verified there, and run
/// through the prompt.
#[cfg(windows)]
fn apply_through_prompt(args: &AwaitArgs) -> Outcome {
    let run = || -> Result<Outcome, String> {
        let version = Version::parse(&args.version).ok_or("bad version")?;
        if version <= Version::running() {
            return Err("The staged version is not newer".to_string());
        }
        let dir = args.state_dir.join("fallback");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let installer = dir.join(format!("{}.exe", args.run_id));
        let mut sig_text = String::new();
        fs::File::open(args.staged.with_extension("sig"))
            .map_err(|e| format!("Cannot read the signature: {e}"))?
            .take(4096)
            .read_to_string(&mut sig_text)
            .map_err(|e| format!("Cannot read the signature: {e}"))?;
        let signature = verify::signature(&sig_text)?;
        let key = verify::public_key(&super::source::source()?.public_key)?;
        let held = hold_verified_copy(
            &args.staged,
            &installer,
            &signature,
            &key,
            &Artifact::Installer.signed_name(version),
        )?;
        if !proc::wait_until_unused(&args.instdir, &[], Some(MAIN_EXE), Duration::from_secs(60)) {
            return Ok(Outcome::Deferred);
        }
        let code = run_elevated(&installer, &args.instdir, Duration::from_secs(3600));
        drop(held);
        let code = code?;
        let _ = fs::remove_dir_all(&dir);
        Ok(if code == 0 { Outcome::Installed } else { Outcome::Failed })
    };
    run().unwrap_or(Outcome::Failed)
}

/// `--await-update`: runs in the user's session from a copy outside the
/// install folder. Waits for the app to exit, starts the task (or the prompt
/// path), waits for the outcome, records it and relaunches when asked.
#[cfg(windows)]
pub fn await_update(args: &AwaitArgs) -> i32 {
    proc::wait_for_exit(args.parent, Duration::from_secs(600));
    let layout = machine_layout().ok();
    let in_inbox = layout
        .as_ref()
        .is_some_and(|l| proc::path_is_within(&args.staged, &l.inbox));
    let mut outcome = None;
    if let (true, Some(layout)) = (in_inbox, layout.as_ref()) {
        let since_ms = now_millis();
        if run_task().is_ok() {
            outcome = await_task_result(layout, &args.run_id, since_ms);
        }
    }
    let outcome = outcome.unwrap_or_else(|| apply_through_prompt(args));
    let _ = super::portable_update::write_json(
        &args.state_dir.join(LAST_APPLY_FILE),
        &LastApply {
            run_id: args.run_id.clone(),
            outcome,
            version: args.version.clone(),
        },
    );
    if args.relaunch {
        let _ = proc::spawn_detached(&args.instdir.join(MAIN_EXE), &[], &args.instdir);
    }
    EXIT_OK
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    fn id(n: u8) -> String {
        format!("{:032x}", n)
    }

    #[test]
    fn the_installer_switches_are_silent_in_place_with_the_folder_last() {
        assert_eq!(
            installer_arguments(Path::new(r"C:\Program Files\Spectra PDF")),
            vec!["/S", "/UPDATE", "/acceptEULA", r"/D=C:\Program Files\Spectra PDF"]
        );
    }

    #[test]
    fn run_ids_are_exactly_32_lowercase_hex_digits() {
        assert!(is_run_id(&new_run_id()));
        assert!(is_run_id(&id(7)));
        for bad in ["", "abc", &"A".repeat(32), &"g".repeat(32), &"0".repeat(33), "../../../../../../../../../../x"] {
            assert!(!is_run_id(bad), "{bad}");
        }
    }

    #[test]
    fn only_complete_pairs_with_run_ids_are_candidates() {
        let names: Vec<String> = [
            format!("{}.exe", id(1)),
            format!("{}.sig", id(1)),
            format!("{}.exe", id(2)),
            format!("{}.exe.part", id(3)),
            format!("{}.sig", id(3)),
            "evil.exe".to_string(),
            "evil.sig".to_string(),
        ]
        .into_iter()
        .collect();
        assert_eq!(inbox_pairs(&names), vec![id(1)]);
    }

    #[test]
    fn the_newest_eligible_candidate_runs_and_older_ones_follow_it() {
        let plan = plan_apply(
            v("2026.1014.156"),
            vec![
                (id(1), Ok(v("2026.1101.160"))),
                (id(2), Ok(v("2026.1020.158"))),
                (id(3), Ok(v("2026.1014.156"))),
                (id(4), Err("bad signature".to_string())),
            ],
        );
        assert_eq!(plan.install, Some((id(1), v("2026.1101.160"))));
        assert_eq!(plan.superseded, vec![id(2)]);
        assert_eq!(
            plan.settled,
            vec![
                (id(3), Outcome::Installed, "2026.1014.156".to_string()),
                (id(4), Outcome::Failed, String::new()),
            ]
        );
    }

    #[test]
    fn nothing_runs_when_no_candidate_is_newer() {
        let plan = plan_apply(v("2026.1101.160"), vec![(id(1), Ok(v("2026.1014.156")))]);
        assert_eq!(plan.install, None);
        assert_eq!(plan.settled, vec![(id(1), Outcome::Installed, "2026.1101.160".to_string())]);
    }

    #[test]
    fn write_rights_of_other_accounts_are_found_and_inherit_only_entries_are_not() {
        const WRITE_DATA: u32 = 0x2;
        const READ_EXECUTE: u32 = 0x1200a9;
        const DELETE_CHILD: u32 = 0x40;
        assert!(ace_lets_untrusted_write("S-1-5-11", WRITE_DATA, false, risk::FILE));
        assert!(ace_lets_untrusted_write("S-1-5-32-545", 0x1301bf, false, risk::INSTALL_DIR));
        assert!(ace_lets_untrusted_write("S-1-5-21-1-2-3-1001", DELETE_CHILD, false, risk::INSTALL_DIR));
        assert!(!ace_lets_untrusted_write("S-1-5-21-1-2-3-1001", DELETE_CHILD, false, risk::FILE));
        assert!(!ace_lets_untrusted_write("S-1-5-11", 0x1301bf, true, risk::INSTALL_DIR));
        assert!(!ace_lets_untrusted_write("S-1-5-32-545", READ_EXECUTE, false, risk::INSTALL_DIR));
        assert!(!ace_lets_untrusted_write("S-1-5-11", 0x4, false, risk::ANCESTOR));
        for trusted in [SID_SYSTEM, SID_ADMINISTRATORS, SID_TRUSTED_INSTALLER, SID_CREATOR_OWNER] {
            assert!(!ace_lets_untrusted_write(trusted, 0x1f01ff, false, risk::INSTALL_DIR));
        }
        assert!(owner_is_trusted(SID_ADMINISTRATORS));
        assert!(!owner_is_trusted("S-1-5-21-1-2-3-1001"));
    }

    #[test]
    fn the_task_runs_the_fixed_action_as_system() {
        let xml = task_xml(Path::new(r"C:\Program Files\Spectra & Co\spectrapdf.exe"));
        assert!(xml.contains("<UserId>S-1-5-18</UserId>"));
        assert!(xml.contains(r#"<Command>"C:\Program Files\Spectra &amp; Co\spectrapdf.exe"</Command>"#));
        assert!(xml.contains("<Arguments>--system-update</Arguments>"));
        assert!(!xml.contains("<Triggers>"));
    }

    #[cfg(windows)]
    #[test]
    fn the_system_installer_gets_a_private_temp_folder() {
        let layout = MachineLayout::under(Path::new(r"C:\ProgramData"));
        assert_eq!(layout.installer_temp, Path::new(r"C:\ProgramData\Spectra PDF Update\temp"));
        let env = installer_environment(&layout.installer_temp);
        assert_eq!(env[0], ("TEMP", layout.installer_temp.clone()));
        assert_eq!(env[1], ("TMP", layout.installer_temp.clone()));
        let source = include_str!("system.rs").replace("\r\n", "\n");
        let run = &source[source.find("fn run_installer(").unwrap()..];
        let run = &run[..run.find("
}
").unwrap()];
        assert!(run.contains(".envs(installer_environment(temp))"));
        let stage2 = &source[source.find("pub fn stage2(").unwrap()..];
        let renew = stage2.find("renew_private(&layout.installer_temp)").expect("a fresh temp folder per run");
        assert!(renew < stage2.find("run_installer(&installer").unwrap());
    }

    #[cfg(windows)]
    #[test]
    fn every_security_descriptor_parses() {
        for sddl in [SDDL_ROOT, SDDL_INBOX, SDDL_RESULTS, SDDL_PRIVATE, SDDL_TASK] {
            assert!(sddl_is_valid(sddl), "{sddl}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_this_account_owns_is_reported_as_unsafe_for_the_task() {
        let temp = tempfile::tempdir().unwrap();
        let exe = temp.path().join(MAIN_EXE);
        fs::write(&exe, b"x").unwrap();
        let found = untrusted_writers(&exe).unwrap();
        assert!(!found.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn a_linked_or_second_named_inbox_file_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a.exe");
        fs::write(&file, b"x").unwrap();
        assert!(open_held_file(&file).is_ok());
        fs::hard_link(&file, temp.path().join("b.exe")).unwrap();
        assert!(open_held_file(&file).unwrap_err().contains("more than one name"));
        assert!(open_held_file(temp.path()).is_err());
    }

    fn result(run_id: &str, outcome: Outcome, completed_at_ms: u64) -> RunResult {
        RunResult {
            run_id: run_id.to_string(),
            outcome,
            version: String::new(),
            completed_at_ms,
        }
    }

    #[test]
    fn a_result_from_an_earlier_attempt_of_the_same_run_is_not_this_attempts_answer() {
        let temp = tempfile::tempdir().unwrap();
        let layout = MachineLayout::under(temp.path());
        fs::create_dir_all(&layout.results).unwrap();
        let path = layout.result_path(&id(1));
        super::super::portable_update::write_json(&path, &result(&id(1), Outcome::Deferred, 1_000)).unwrap();
        assert_eq!(fresh_result(&path, 2_000), None);
        super::super::portable_update::write_json(&path, &result(&id(1), Outcome::Installed, 2_000)).unwrap();
        assert_eq!(fresh_result(&path, 2_000).map(|r| r.outcome), Some(Outcome::Installed));
    }

    #[test]
    fn stage_one_clears_the_results_of_the_pairs_it_hands_on() {
        let temp = tempfile::tempdir().unwrap();
        let layout = MachineLayout::under(temp.path());
        fs::create_dir_all(&layout.results).unwrap();
        for n in [1, 2] {
            super::super::portable_update::write_json(
                &layout.result_path(&id(n)),
                &result(&id(n), Outcome::Deferred, 1),
            )
            .unwrap();
        }
        clear_stale_results(&layout, &[id(1)]);
        assert!(!layout.result_path(&id(1)).exists());
        assert!(layout.result_path(&id(2)).exists());
    }

    #[cfg(windows)]
    #[test]
    fn only_one_holder_takes_the_stage_two_lock() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("stage2.lock");
        let first = MachineLock::take(&path).expect("the first holder");
        assert!(MachineLock::take(&path).is_none());
        assert!(fs::OpenOptions::new().read(true).open(&path).is_err(), "no reader shares the lock");
        drop(first);
        assert!(MachineLock::take(&path).is_some());
    }

    #[cfg(windows)]
    #[test]
    fn a_held_verified_copy_cannot_be_replaced_while_the_installer_runs() {
        use crate::updates::verify::{self, fixtures};
        let temp = tempfile::tempdir().unwrap();
        let staged = temp.path().join("staged.exe");
        fs::write(&staged, fixtures::INSTALLER).unwrap();
        let signature = verify::signature(&verify::signature_text(fixtures::INSTALLER_SIG).unwrap()).unwrap();
        let key = verify::public_key(fixtures::PUBLIC_KEY).unwrap();
        let expected = Artifact::Installer.signed_name(v("2026.1101.160"));
        let copy = temp.path().join("copy.exe");
        let held = hold_verified_copy(&staged, &copy, &signature, &key, &expected).unwrap();
        assert!(fs::OpenOptions::new().write(true).open(&copy).is_err(), "a writer is shut out");
        assert!(fs::rename(&copy, temp.path().join("moved.exe")).is_err(), "a rename is shut out");
        assert!(fs::remove_file(&copy).is_err(), "a delete is shut out");
        assert!(fs::File::open(&copy).is_ok(), "the installer can still open it");
        drop(held);
        assert!(fs::remove_file(&copy).is_ok());

        let mut tampered = fixtures::INSTALLER.to_vec();
        tampered[0] ^= 1;
        fs::write(&staged, tampered).unwrap();
        assert!(hold_verified_copy(&staged, &copy, &signature, &key, &expected).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn every_machine_folder_fixes_its_owner_and_primary_group() {
        for sddl in [SDDL_ROOT, SDDL_INBOX, SDDL_RESULTS, SDDL_PRIVATE] {
            assert!(sddl.starts_with("O:BAG:SYD:P"), "{sddl}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_timed_out_installer_and_every_process_it_started_end_before_the_wait_returns() {
        let temp = tempfile::tempdir().unwrap();
        let work = temp.path().join("temp");
        fs::create_dir_all(&work).unwrap();
        let mut command = std::process::Command::new("cmd.exe");
        command
            .args(["/d", "/c", "ping -n 60 127.0.0.1 > held.txt"])
            .current_dir(&work)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let error = watch_in_job(command, Duration::from_millis(1500)).unwrap_err();
        assert!(error.contains("did not finish in time"), "{error}");
        fs::remove_dir_all(&work).expect("no process of the job still holds the temp folder");

        let mut quick = std::process::Command::new("cmd.exe");
        quick.args(["/d", "/c", "exit 3"]).stdin(std::process::Stdio::null());
        assert_eq!(watch_in_job(quick, Duration::from_secs(30)), Ok(3));
    }

    #[test]
    fn set_aside_private_folders_are_removed_on_a_later_run() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join(format!("temp.old-{}", id(1)));
        let other = temp.path().join(format!("verified.old-{}", id(2)));
        let unrelated = temp.path().join("temp.old-notarunid");
        for dir in [&old, &other, &unrelated] {
            fs::create_dir_all(dir.join("nsis")).unwrap();
            fs::write(dir.join("nsis").join("a.dll"), b"x").unwrap();
        }
        remove_set_aside(temp.path(), "temp");
        assert!(!old.exists());
        assert!(other.exists(), "another folder's copies stay");
        assert!(unrelated.exists(), "a name that is not a set-aside copy stays");
    }

    #[cfg(windows)]
    #[test]
    fn results_of_unverified_pairs_carry_the_version_their_signature_names() {
        use crate::updates::verify::{self, fixtures};
        let temp = tempfile::tempdir().unwrap();
        let layout = MachineLayout::under(temp.path());
        fs::create_dir_all(&layout.inbox).unwrap();
        fs::create_dir_all(&layout.results).unwrap();
        fs::write(layout.inbox.join(format!("{}.sig", id(1))), verify::signature_text(fixtures::INSTALLER_SIG).unwrap())
            .unwrap();
        fs::write(layout.inbox.join(format!("{}.sig", id(2))), "not a signature").unwrap();
        settle_claimed(&layout, &[id(1), id(2)], Outcome::Failed);
        assert_eq!(read_result(&layout.result_path(&id(1))).unwrap().version, "2026.1101.160");
        assert_eq!(read_result(&layout.result_path(&id(2))).unwrap().version, "");
        let source = include_str!("system.rs").replace("\r\n", "\n");
        let stage2 = &source[source.find("pub fn stage2(").unwrap()..];
        let stage2 = &stage2[..stage2.find("\n}\n").unwrap()];
        assert!(!stage2.contains("Outcome::Failed, \"\""), "no failure result leaves the version out");
        assert!(stage2.contains("Outcome::Deferred, &version.to_string()"));
    }

    #[test]
    fn waiter_arguments_round_trip() {
        let args = AwaitArgs {
            run_id: id(9),
            parent: 4242,
            instdir: PathBuf::from(r"C:\Program Files\Spectra PDF"),
            staged: PathBuf::from(r"C:\ProgramData\Spectra PDF Update\inbox\x.exe"),
            version: "2026.1101.160".to_string(),
            state_dir: PathBuf::from(r"C:\Users\a\AppData\Local\com.spectrapdf.app\updates"),
            relaunch: true,
        };
        let argv = args.to_args();
        assert_eq!(argv[0], "--await-update");
        assert_eq!(AwaitArgs::parse(&argv[1..]), Some(args.clone()));
        let mut bad = argv[1..].to_vec();
        bad[1] = "nothex".to_string();
        assert_eq!(AwaitArgs::parse(&bad), None);
    }
}
