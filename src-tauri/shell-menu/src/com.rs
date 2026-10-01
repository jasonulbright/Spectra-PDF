//! The COM half: the two command classes, their class factory, and the DLL
//! exports. Kept to path collection, one file write and one process start.

#![allow(non_snake_case)]

use crate::ids::Verb;
use crate::{exe_from_module, handoff_dir_in, handoff_json, handoff_name, invoke_accepts, label};
use crate::{pick_language, shipped_locales, verb_state, VerbState, INSPECTED_ITEMS};
use std::ffi::c_void;
use std::path::PathBuf;
use std::sync::atomic::{AtomicIsize, Ordering};
use windows::core::{implement, Interface, Ref, BOOL, GUID, HRESULT, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, CLASS_E_CLASSNOTAVAILABLE, CLASS_E_NOAGGREGATION, E_FAIL, E_NOTIMPL, E_POINTER,
    HMODULE, S_FALSE, S_OK,
};
use windows::Win32::System::Com::{CoCreateGuid, CoTaskMemFree, IBindCtx, IClassFactory, IClassFactory_Impl};
use windows::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
};
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
    UpdateProcThreadAttribute, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROCESS_CREATION_FLAGS, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY,
    STARTUPINFOEXW, STARTUPINFOW,
};
use windows::Win32::UI::Shell::{
    IExplorerCommand, IExplorerCommand_Impl, IEnumExplorerCommand, IShellItem, IShellItemArray,
    FOLDERID_LocalAppData, SHGetKnownFolderPath, SHStrDupW, KF_FLAG_DEFAULT, ECF_DEFAULT, ECS_ENABLED, ECS_HIDDEN, SIGDN, SIGDN_FILESYSPATH, SIGDN_NORMALDISPLAY,
    SIGDN_PARENTRELATIVEPARSING,
};
use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};

/// Live command objects, live class factories and server locks; the DLL may
/// unload only at zero.
static REFERENCES: AtomicIsize = AtomicIsize::new(0);

fn guard<T>(body: impl FnOnce() -> windows::core::Result<T>) -> windows::core::Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(result) => result,
        Err(_) => Err(E_FAIL.into()),
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn co_string(text: &str) -> windows::core::Result<PWSTR> {
    let buffer = wide(text);
    unsafe { SHStrDupW(PCWSTR(buffer.as_ptr())) }
}

fn take_co_string(text: PWSTR) -> String {
    let value = unsafe { text.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(text.0 as *const c_void)) };
    value
}

fn module_path() -> Option<PathBuf> {
    let mut module = HMODULE::default();
    let anchor = module_path as *const ();
    unsafe {
        GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            PCWSTR(anchor as *const u16),
            &mut module,
        )
    }
    .ok()?;
    let mut buffer = vec![0u16; 32768];
    let length = unsafe { GetModuleFileNameW(Some(module), &mut buffer) } as usize;
    if length == 0 || length >= buffer.len() {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..length])))
}

fn exe_path() -> Option<PathBuf> {
    module_path().as_deref().and_then(exe_from_module)
}

fn reg_dword(root: HKEY, key: &str, value: &str) -> Option<u32> {
    let (key, value) = (wide(key), wide(value));
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            root,
            PCWSTR(key.as_ptr()),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut c_void),
            Some(&mut size),
        )
    };
    (status.0 == 0).then_some(data)
}

fn reg_string(root: HKEY, key: &str, value: &str) -> Option<String> {
    let (key, value) = (wide(key), wide(value));
    let mut buffer = vec![0u16; 256];
    let mut size = (buffer.len() * 2) as u32;
    let status = unsafe {
        RegGetValueW(
            root,
            PCWSTR(key.as_ptr()),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr() as *mut c_void),
            Some(&mut size),
        )
    };
    if status.0 != 0 {
        return None;
    }
    let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

/// The machine policy and the user's own switch, read on every query so a
/// change applies without re-registering.
fn hidden_by_switches() -> bool {
    reg_dword(HKEY_LOCAL_MACHINE, "SOFTWARE\\Spectra PDF", "DisableExplorerMenu") == Some(1)
        || reg_dword(HKEY_CURRENT_USER, "Software\\Spectra PDF", "ExplorerMenu") == Some(0)
}

fn preferred_ui_languages() -> Vec<String> {
    use windows::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    let mut count = 0u32;
    let mut length = 0u32;
    if unsafe { GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut length) }.is_err()
        || length == 0
    {
        return Vec::new();
    }
    let mut buffer = vec![0u16; length as usize];
    if unsafe {
        GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, Some(PWSTR(buffer.as_mut_ptr())), &mut length)
    }
    .is_err()
    {
        return Vec::new();
    }
    buffer
        .split(|c| *c == 0)
        .filter(|s| !s.is_empty())
        .map(String::from_utf16_lossy)
        .collect()
}

fn language() -> String {
    let app = reg_string(HKEY_CURRENT_USER, "Software\\Spectra PDF\\ExplorerMenu", "Language");
    pick_language(app.as_deref(), &preferred_ui_languages(), &shipped_locales())
}

fn display_name(item: &IShellItem, form: SIGDN) -> Option<String> {
    unsafe { item.GetDisplayName(form) }.ok().map(take_co_string)
}

fn inspected_names(items: &IShellItemArray) -> (Vec<Option<String>>, usize) {
    let count = unsafe { items.GetCount() }.unwrap_or(0) as usize;
    let names = (0..count.min(INSPECTED_ITEMS))
        .map(|index| {
            let item = unsafe { items.GetItemAt(index as u32) }.ok()?;
            display_name(&item, SIGDN_PARENTRELATIVEPARSING)
                .or_else(|| display_name(&item, SIGDN_NORMALDISPLAY))
        })
        .collect();
    (names, count)
}

fn local_app_data() -> std::io::Result<PathBuf> {
    let path = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, None) }
        .map_err(std::io::Error::other)?;
    Ok(PathBuf::from(take_co_string(path)))
}

fn write_handoff(json: &str) -> std::io::Result<PathBuf> {
    use std::io::Write;
    let dir = handoff_dir_in(&local_app_data()?);
    std::fs::create_dir_all(&dir)?;
    let id = unsafe { CoCreateGuid() }.map_err(std::io::Error::other)?.to_u128();
    let path = dir.join(handoff_name(id));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(json.as_bytes())?;
    Ok(path)
}

fn launch(exe: &std::path::Path, handoff: &std::path::Path) -> windows::core::Result<()> {
    let application = wide(&exe.display().to_string());
    let mut command = wide(&format!(
        "\"{}\" --shell-action \"{}\"",
        exe.display(),
        handoff.display()
    ));
    let folder = exe.parent().map(|p| wide(&p.display().to_string()));
    let folder = folder
        .as_ref()
        .map_or(PCWSTR::null(), |f| PCWSTR(f.as_ptr()));
    let mut process = PROCESS_INFORMATION::default();
    let _ = unsafe { AllowSetForegroundWindow(ASFW_ANY) };

    // PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY with
    // PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_ENABLE_PROCESS_TREE (0x01): the
    // app's own children are created outside the desktop app runtime
    // environment even when the packaged surrogate set the opposite policy.
    // A Windows build without the attribute gets the plain launch.
    let mut size = 0usize;
    let _ = unsafe { InitializeProcThreadAttributeList(None, 1, None, &mut size) };
    let mut storage = vec![0u8; size.max(1)];
    let list = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr() as *mut c_void);
    let policy: u32 = 0x01;
    let attributed = size > 0
        && unsafe { InitializeProcThreadAttributeList(Some(list), 1, None, &mut size) }.is_ok()
        && {
            let updated = unsafe {
                UpdateProcThreadAttribute(
                    list,
                    0,
                    PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY as usize,
                    Some(&policy as *const u32 as *const c_void),
                    std::mem::size_of::<u32>(),
                    None,
                    None,
                )
            };
            if updated.is_err() {
                unsafe { DeleteProcThreadAttributeList(list) };
            }
            updated.is_ok()
        };

    let created = if attributed {
        let startup = STARTUPINFOEXW {
            StartupInfo: STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOEXW>() as u32,
                ..Default::default()
            },
            lpAttributeList: list,
        };
        let result = unsafe {
            CreateProcessW(
                PCWSTR(application.as_ptr()),
                Some(PWSTR(command.as_mut_ptr())),
                None,
                None,
                false,
                EXTENDED_STARTUPINFO_PRESENT,
                None,
                folder,
                &startup.StartupInfo,
                &mut process,
            )
        };
        unsafe { DeleteProcThreadAttributeList(list) };
        result
    } else {
        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        unsafe {
            CreateProcessW(
                PCWSTR(application.as_ptr()),
                Some(PWSTR(command.as_mut_ptr())),
                None,
                None,
                false,
                PROCESS_CREATION_FLAGS(0),
                None,
                folder,
                &startup,
                &mut process,
            )
        }
    };
    created?;
    unsafe {
        let _ = CloseHandle(process.hThread);
        let _ = CloseHandle(process.hProcess);
    }
    Ok(())
}

fn invoke(verb: Verb, items: &IShellItemArray) -> windows::core::Result<()> {
    if hidden_by_switches() {
        return Ok(());
    }
    let count = unsafe { items.GetCount() }?;
    let mut paths = Vec::new();
    let mut skipped: u32 = 0;
    for index in 0..count {
        let path = unsafe { items.GetItemAt(index) }
            .ok()
            .and_then(|item| display_name(&item, SIGDN_FILESYSPATH));
        match path {
            Some(path) if invoke_accepts(verb, &path) => paths.push(path),
            _ => skipped = skipped.saturating_add(1),
        }
    }
    if paths.is_empty() && skipped == 0 {
        return Ok(());
    }
    let exe = exe_path().ok_or_else(|| windows::core::Error::from(E_FAIL))?;
    let handoff = write_handoff(&handoff_json(verb, &paths, skipped))
        .map_err(|_| windows::core::Error::from(E_FAIL))?;
    if let Err(error) = launch(&exe, &handoff) {
        let _ = std::fs::remove_file(&handoff);
        return Err(error);
    }
    Ok(())
}

#[implement(IExplorerCommand)]
struct Command {
    verb: Verb,
}

impl Command {
    fn new(verb: Verb) -> Self {
        REFERENCES.fetch_add(1, Ordering::SeqCst);
        Self { verb }
    }
}

impl Drop for Command {
    fn drop(&mut self) {
        REFERENCES.fetch_sub(1, Ordering::SeqCst);
    }
}

impl IExplorerCommand_Impl for Command_Impl {
    fn GetTitle(&self, _items: Ref<IShellItemArray>) -> windows::core::Result<PWSTR> {
        guard(|| co_string(&label(self.verb, &language())))
    }

    fn GetIcon(&self, _items: Ref<IShellItemArray>) -> windows::core::Result<PWSTR> {
        guard(|| {
            let exe = exe_path().ok_or_else(|| windows::core::Error::from(E_FAIL))?;
            co_string(&format!("{},0", exe.display()))
        })
    }

    fn GetToolTip(&self, _items: Ref<IShellItemArray>) -> windows::core::Result<PWSTR> {
        Err(E_NOTIMPL.into())
    }

    fn GetCanonicalName(&self) -> windows::core::Result<GUID> {
        Ok(GUID::from_u128(self.verb.clsid_u128()))
    }

    fn GetState(&self, items: Ref<IShellItemArray>, _slow: BOOL) -> windows::core::Result<u32> {
        guard(|| {
            if hidden_by_switches() || !exe_path().is_some_and(|exe| exe.is_file()) {
                return Ok(ECS_HIDDEN.0 as u32);
            }
            let Some(items) = items.as_ref() else {
                return Ok(ECS_HIDDEN.0 as u32);
            };
            let (names, count) = inspected_names(items);
            Ok(match verb_state(self.verb, &names, count) {
                VerbState::Enabled => ECS_ENABLED.0 as u32,
                VerbState::Hidden => ECS_HIDDEN.0 as u32,
            })
        })
    }

    fn Invoke(&self, items: Ref<IShellItemArray>, _bind: Ref<IBindCtx>) -> windows::core::Result<()> {
        guard(|| match items.as_ref() {
            Some(items) => invoke(self.verb, items),
            None => Ok(()),
        })
    }

    fn GetFlags(&self) -> windows::core::Result<u32> {
        Ok(ECF_DEFAULT.0 as u32)
    }

    fn EnumSubCommands(&self) -> windows::core::Result<IEnumExplorerCommand> {
        Err(E_NOTIMPL.into())
    }
}

#[implement(IClassFactory)]
struct Factory {
    verb: Verb,
}

impl Factory {
    fn new(verb: Verb) -> Self {
        REFERENCES.fetch_add(1, Ordering::SeqCst);
        Self { verb }
    }
}

impl Drop for Factory {
    fn drop(&mut self) {
        REFERENCES.fetch_sub(1, Ordering::SeqCst);
    }
}

impl IClassFactory_Impl for Factory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<windows::core::IUnknown>,
        riid: *const GUID,
        object: *mut *mut c_void,
    ) -> windows::core::Result<()> {
        guard(|| {
            if object.is_null() || riid.is_null() {
                return Err(E_POINTER.into());
            }
            unsafe { *object = std::ptr::null_mut() };
            if !outer.is_null() {
                return Err(CLASS_E_NOAGGREGATION.into());
            }
            let command: IExplorerCommand = Command::new(self.verb).into();
            unsafe { command.query(riid, object) }.ok()
        })
    }

    fn LockServer(&self, lock: BOOL) -> windows::core::Result<()> {
        if lock.as_bool() {
            REFERENCES.fetch_add(1, Ordering::SeqCst);
        } else {
            REFERENCES.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

fn verb_for(clsid: &GUID) -> Option<Verb> {
    Verb::ALL
        .into_iter()
        .find(|verb| *clsid == GUID::from_u128(verb.clsid_u128()))
}

/// # Safety
/// Called by COM with valid `rclsid`, `riid` and `ppv` pointers or null.
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    let result = std::panic::catch_unwind(|| {
        if ppv.is_null() || rclsid.is_null() || riid.is_null() {
            return E_POINTER;
        }
        unsafe { *ppv = std::ptr::null_mut() };
        let Some(verb) = verb_for(unsafe { &*rclsid }) else {
            return CLASS_E_CLASSNOTAVAILABLE;
        };
        let factory: IClassFactory = Factory::new(verb).into();
        unsafe { factory.query(riid, ppv) }
    });
    result.unwrap_or(E_FAIL)
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    if REFERENCES.load(Ordering::SeqCst) <= 0 {
        S_OK
    } else {
        S_FALSE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_class_objects_answer_for_both_clsids_and_no_other() {
        for verb in Verb::ALL {
            let clsid = GUID::from_u128(verb.clsid_u128());
            let mut factory: *mut c_void = std::ptr::null_mut();
            let hr = unsafe { DllGetClassObject(&clsid, &IClassFactory::IID, &mut factory) };
            assert_eq!(hr, S_OK);
            let factory = unsafe { IClassFactory::from_raw(factory) };
            // A live class factory alone keeps the module loaded.
            assert_eq!(DllCanUnloadNow(), S_FALSE);
            let command: IExplorerCommand = unsafe { factory.CreateInstance(None) }.unwrap();
            drop(factory);
            assert_eq!(DllCanUnloadNow(), S_FALSE);
            assert_eq!(unsafe { command.GetCanonicalName() }.unwrap(), clsid);
            assert_eq!(unsafe { command.GetFlags() }.unwrap(), ECF_DEFAULT.0 as u32);
            assert_eq!(unsafe { command.GetState(None, false) }.unwrap(), ECS_HIDDEN.0 as u32);
            let title = take_co_string(unsafe { command.GetTitle(None) }.unwrap());
            assert!(title.contains("Spectra PDF"), "{title}");
            drop(command);
            assert_eq!(DllCanUnloadNow(), S_OK);
        }
        let unknown = GUID::from_u128(0x1234);
        let mut factory: *mut c_void = std::ptr::null_mut();
        assert_eq!(
            unsafe { DllGetClassObject(&unknown, &IClassFactory::IID, &mut factory) },
            CLASS_E_CLASSNOTAVAILABLE
        );
        assert!(factory.is_null());
    }
}
