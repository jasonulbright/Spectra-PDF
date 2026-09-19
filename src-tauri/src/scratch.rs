//! The app's own temp tree, `%TEMP%\spectrapdf`, and what each launch removes
//! from it.
//!
//! Two kinds of entry belong to one process of the app: the working folder
//! each open makes (`<uuid>.<pid>`), and the payloads and responses of the
//! network client (`net\<stem>-<millis>-<8 hex>.<pid>.<ext>`). A process that
//! is killed cannot remove them, so each launch removes the ones whose process
//! no longer runs.
//!
//! A working folder named `<uuid>` and a network file named
//! `<stem>-<millis>-<8 hex>.<ext>` carry no process id, so nothing in the name
//! says whose they are. They are removed by age, only when nothing in them is
//! held open, and only while no other process of the app runs on the machine:
//! a live window of another process is the one user they can still have.
//!
//! Other folders in the tree belong to their own features and are never
//! entered here.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::staging::{decimal_pid, held_open, reclaim, reclaim_aged, LEGACY_STAGE_AGE};

/// The image name every process of the app runs under.
const APP_IMAGE: &str = "spectrapdf.exe";

const NET: &str = "net";

pub(crate) fn root() -> PathBuf {
    std::env::temp_dir().join("spectrapdf")
}

/// Where the network client keeps payloads and responses.
pub(crate) fn net_dir() -> PathBuf {
    root().join(NET)
}

// ── Names ─────────────────────────────────────────────────────────────────

/// A new working folder's name: a fresh id, then the process that owns it.
pub(crate) fn working_folder_name(pid: u32) -> String {
    format!("{}.{pid}", uuid::Uuid::new_v4())
}

/// A version 4 UUID in the one spelling `Uuid`'s `Display` produces.
fn canonical_v4(text: &str) -> bool {
    uuid::Uuid::try_parse(text).is_ok_and(|id| id.get_version_num() == 4 && id.to_string() == text)
}

/// The process a working folder's name carries.
pub(crate) fn working_folder_owner(name: &str) -> Option<u32> {
    let (id, pid) = name.split_once('.')?;
    if !canonical_v4(id) {
        return None;
    }
    decimal_pid(pid)
}

/// A working folder named without a process id.
fn legacy_working_folder(name: &str) -> bool {
    canonical_v4(name)
}

/// A network scratch file's name: `<stem>-<millis>-<8 hex>.<pid>.<ext>`.
/// `stem` and `extension` arrive sanitized by the network client.
pub(crate) fn net_file_name(stem: &str, pid: u32, extension: &str) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let unique = uuid::Uuid::new_v4().simple().to_string();
    format!("{stem}-{stamp}-{}.{pid}.{extension}", &unique[..8])
}

/// `<stem>-<millis>-<8 hex>`, with the stem the network client's sanitizer
/// produces: 1 to 48 ASCII letters, digits, hyphens and underscores.
fn net_base(base: &str) -> bool {
    let Some((rest, unique)) = base.rsplit_once('-') else {
        return false;
    };
    let Some((stem, stamp)) = rest.rsplit_once('-') else {
        return false;
    };
    (1..=48).contains(&stem.len())
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && !stamp.is_empty()
        && stamp.bytes().all(|b| b.is_ascii_digit())
        && unique.len() == 8
        && unique
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn net_extension(extension: &str) -> bool {
    (1..=8).contains(&extension.len()) && extension.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// The process a network scratch file's name carries.
pub(crate) fn net_file_owner(name: &str) -> Option<u32> {
    let mut parts = name.split('.');
    let (base, pid, extension) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || !net_base(base) || !net_extension(extension) {
        return None;
    }
    decimal_pid(pid)
}

/// A network scratch file named without a process id.
fn legacy_net_file(name: &str) -> bool {
    name.split_once('.')
        .is_some_and(|(base, extension)| net_base(base) && net_extension(extension))
}

/// Remove `path` when it is a network scratch file directly in `dir`: a
/// payload is built for one request, so its request's end is its end. Any
/// other path is left alone. Returns whether a file was removed.
pub(crate) fn release_net_file(path: &Path, dir: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if net_file_owner(name).is_none() && !legacy_net_file(name) {
        return false;
    }
    let inside = path
        .parent()
        .is_some_and(|parent| same_file::is_same_file(parent, dir).unwrap_or(false));
    inside && std::fs::remove_file(path).is_ok()
}

// ── The launch reclaim ───────────────────────────────────────────────────

/// What one pass over the tree removed.
#[derive(Debug, Default, PartialEq, Eq)]
struct Reclaimed {
    folders: usize,
    net: usize,
    legacy_folders: usize,
    legacy_net: usize,
}

/// Remove what processes of the app that no longer run left in the temp
/// tree. Runs once per launch, off the main thread.
pub(crate) fn reclaim_at_startup() {
    let own = std::process::id();
    reclaim_tree(
        &root(),
        own,
        crate::staging::process_running,
        || alone(image_runs_elsewhere(APP_IMAGE, own)),
        SystemTime::now(),
    );
}

/// Entries without a process id go only when the process list was read and
/// named no other process of the app.
fn alone(elsewhere: Option<bool>) -> bool {
    elsewhere == Some(false)
}

/// One pass over `root`. `alone` is asked once, and only for the entries that
/// carry no process id.
fn reclaim_tree(
    root: &Path,
    own: u32,
    running: impl Fn(u32) -> bool,
    alone: impl FnOnce() -> bool,
    now: SystemTime,
) -> Reclaimed {
    let net = root.join(NET);
    let mut done = Reclaimed {
        folders: reclaim_folders(root, own, working_folder_owner, &running),
        net: reclaim(&net, own, net_file_owner, &running),
        ..Reclaimed::default()
    };
    if alone() {
        done.legacy_folders =
            reclaim_aged_folders(root, legacy_working_folder, LEGACY_STAGE_AGE, now);
        done.legacy_net = reclaim_aged(&net, legacy_net_file, LEGACY_STAGE_AGE, now);
    }
    done
}

/// A folder entry itself, not a link to one.
fn plain_folder(entry: &std::fs::DirEntry) -> bool {
    entry.file_type().is_ok_and(|kind| kind.is_dir())
}

/// Remove each folder in `dir` that `owner` attributes to a process that is
/// neither `own` nor `running`, and that nothing holds open.
fn reclaim_folders(
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
        if pid == own || running(pid) || !plain_folder(&entry) || held_open_tree(&entry.path()) {
            continue;
        }
        if std::fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Remove each folder in `dir` whose name `legacy` accepts, which was created
/// at least `age` before `now`, and which nothing holds open. A folder whose
/// creation time cannot be read, or lies after `now`, is kept.
fn reclaim_aged_folders(
    dir: &Path,
    legacy: impl Fn(&str) -> bool,
    age: Duration,
    now: SystemTime,
) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        if !entry.file_name().to_str().is_some_and(&legacy) || !plain_folder(&entry) {
            continue;
        }
        let Some(existed) = std::fs::symlink_metadata(entry.path())
            .and_then(|meta| meta.created())
            .ok()
            .and_then(|born| now.duration_since(born).ok())
        else {
            continue;
        };
        if existed >= age
            && !held_open_tree(&entry.path())
            && std::fs::remove_dir_all(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

/// How many folder levels below a working folder are walked. A working
/// folder is flat; a deeper tree reads as held, which keeps the walk's stack
/// bounded whatever someone else built under the name.
const MAX_DEPTH: usize = 16;

/// Whether some handle holds `dir`, a folder under it or a file under it
/// open. A tree that cannot be read to the end, or that is deeper than
/// [`MAX_DEPTH`], reads as held.
fn held_open_tree(dir: &Path) -> bool {
    held_open_below(dir, 0)
}

fn held_open_below(dir: &Path, depth: usize) -> bool {
    if depth > MAX_DEPTH || held_open_folder(dir) {
        return true;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return true;
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return true;
        };
        let held = if plain_folder(&entry) {
            held_open_below(&entry.path(), depth + 1)
        } else {
            held_open(&entry.path())
        };
        if held {
            return true;
        }
    }
    false
}

/// [`held_open`] for a folder: an open that shares nothing is refused while
/// any other handle to the folder exists, a process's working directory
/// among them.
#[cfg(windows)]
fn held_open_folder(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    match std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
    {
        Ok(_) => false,
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

#[cfg(not(windows))]
fn held_open_folder(_path: &Path) -> bool {
    false
}

/// Whether a process other than `own` runs an image named `image`. `None`
/// when the process list cannot be read.
fn image_runs_elsewhere(image: &str, own: u32) -> Option<bool> {
    Some(named_elsewhere(&process_images()?, image, own))
}

/// Whether `processes` (id, image name) holds a process other than `own`
/// whose image is `image`, matched without regard to case.
fn named_elsewhere(processes: &[(u32, String)], image: &str, own: u32) -> bool {
    processes
        .iter()
        .any(|(pid, name)| *pid != own && name.eq_ignore_ascii_case(image))
}

/// Every process on the machine, other accounts' included, with the file
/// name of its image. `None` when the list cannot be taken whole.
#[cfg(windows)]
fn process_images() -> Option<Vec<(u32, String)>> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut listed = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut processes = listed.is_ok().then(Vec::new);
    while listed.is_ok() {
        let length = entry
            .szExeFile
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
        if let Some(processes) = processes.as_mut() {
            processes.push((entry.th32ProcessID, name));
        }
        listed = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    processes
}

#[cfg(not(windows))]
fn process_images() -> Option<Vec<(u32, String)>> {
    None
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

    fn uuid() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    /// A working folder with a document in it, named for `pid`.
    fn working_folder(root: &Path, pid: u32) -> PathBuf {
        let folder = root.join(format!("{}.{pid}", uuid()));
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("document.pdf"), b"%PDF-1.7").unwrap();
        folder
    }

    fn legacy_folder(root: &Path) -> PathBuf {
        let folder = root.join(uuid());
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("document.pdf"), b"%PDF-1.7").unwrap();
        folder
    }

    fn net_file(root: &Path, name: &str) -> PathBuf {
        let net = root.join(NET);
        std::fs::create_dir_all(&net).unwrap();
        let file = net.join(name);
        std::fs::write(&file, b"field=value").unwrap();
        file
    }

    #[test]
    fn a_working_folder_name_carries_exactly_its_process() {
        let name = working_folder_name(OWN);
        assert_eq!(working_folder_owner(&name), Some(OWN));
        assert!(!legacy_working_folder(&name));
        let id = uuid();
        assert!(legacy_working_folder(&id));
        assert_eq!(working_folder_owner(&id), None);
        let upper = id.to_uppercase();
        let braced = format!("{{{id}}}");
        let simple = uuid::Uuid::new_v4().simple().to_string();
        let version_one = "c232ab00-9414-11ec-b3c8-9e6bdeced846".to_string();
        for other in [
            format!("{upper}.4100"),
            format!("{braced}.4100"),
            format!("{simple}.4100"),
            format!("{version_one}.4100"),
            format!("{id}.04100"),
            format!("{id}.4100.1"),
            format!("{id}.x"),
            format!("{id}4100"),
            "batch-scratch".to_string(),
            "net".to_string(),
        ] {
            assert_eq!(working_folder_owner(&other), None, "{other}");
        }
        for other in [upper, braced, simple, version_one, format!("{id}.4100")] {
            assert!(!legacy_working_folder(&other), "{other}");
        }
    }

    #[test]
    fn a_network_file_name_carries_exactly_its_process() {
        let name = net_file_name("form_1-submission", OWN, "fdf");
        assert_eq!(net_file_owner(&name), Some(OWN));
        assert!(!legacy_net_file(&name));
        assert!(legacy_net_file("doc-1789169309945-ae0175af.pdf"));
        assert!(legacy_net_file("form_1--submission-0-0123abcd.XFDF"));
        assert_eq!(
            net_file_owner("doc-1789169309945-ae0175af.4100.pdf"),
            Some(4100)
        );
        for other in [
            "doc-1789169309945-ae0175af.04100.pdf",
            "doc-1789169309945-ae0175af.4100.pdf.bak",
            "doc-1789169309945-ae0175af.4100.",
            "doc-1789169309945-ae0175af.4100.toolongext",
            "doc-1789169309945-AE0175AF.4100.pdf",
            "doc-1789169309945-ae0175a.4100.pdf",
            "doc-17891a9309945-ae0175af.4100.pdf",
            "doc--ae0175af.4100.pdf",
            "-1789169309945-ae0175af.4100.pdf",
            "d.c-1789169309945-ae0175af.4100.pdf",
            "notes.4100.txt",
        ] {
            assert_eq!(net_file_owner(other), None, "{other}");
        }
        let long_stem = format!("{}-1-0123abcd.pdf", "s".repeat(49));
        for other in [
            "doc-1789169309945-ae0175af",
            "doc-1789169309945-ae0175af.p-f",
            "doc-1789169309945-ae0175af.4100.pdf",
            "notes.txt",
            long_stem.as_str(),
        ] {
            assert!(!legacy_net_file(other), "{other}");
        }
    }

    #[test]
    fn a_launch_removes_only_what_stopped_processes_left() {
        let root = tempfile::tempdir().unwrap();
        let own = working_folder(root.path(), OWN);
        let live = working_folder(root.path(), LIVE);
        let dead = working_folder(root.path(), DEAD);
        let read_only = dead.join("document.pdf");
        let mut permissions = std::fs::metadata(&read_only).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&read_only, permissions).unwrap();
        std::fs::create_dir(dead.join("nested")).unwrap();
        std::fs::write(dead.join("nested").join("stage.pdf"), b"%PDF").unwrap();
        let not_a_folder = root.path().join(format!("{}.{DEAD}", uuid()));
        std::fs::write(&not_a_folder, b"a file under a folder's name").unwrap();
        for other in ["batch-scratch", "web-capture", "e2e-combine-out-0qs6Vp"] {
            std::fs::create_dir(root.path().join(other)).unwrap();
        }
        let net_own = net_file(root.path(), &net_file_name("a", OWN, "fdf"));
        let net_live = net_file(root.path(), &net_file_name("a", LIVE, "fdf"));
        let net_dead = net_file(root.path(), &net_file_name("a", DEAD, "pdf"));
        let net_other = net_file(root.path(), "notes.4300.txt");
        let before = names(root.path());

        let done = reclaim_tree(
            root.path(),
            OWN,
            |pid| pid == LIVE,
            || false,
            SystemTime::now(),
        );

        assert_eq!(
            done,
            Reclaimed {
                folders: 1,
                net: 1,
                ..Reclaimed::default()
            }
        );
        let mut kept = before;
        kept.remove(dead.file_name().unwrap().to_str().unwrap());
        assert_eq!(names(root.path()), kept);
        assert!(own.exists() && live.exists() && not_a_folder.exists());
        assert!(net_own.exists() && net_live.exists() && net_other.exists());
        assert!(!net_dead.exists());
    }

    #[test]
    fn a_folder_or_file_without_a_process_id_goes_only_by_age_and_only_alone() {
        let root = tempfile::tempdir().unwrap();
        let folder = legacy_folder(root.path());
        let file = net_file(root.path(), "doc-1789169309945-ae0175af.pdf");
        let now = SystemTime::now();
        let later = now + LEGACY_STAGE_AGE + Duration::from_secs(60);
        let asked = std::cell::Cell::new(0);

        let with_company = reclaim_tree(root.path(), OWN, |_| false, || false, later);
        assert_eq!(with_company, Reclaimed::default());
        let too_young = reclaim_tree(root.path(), OWN, |_| false, || true, now);
        assert_eq!(too_young, Reclaimed::default());
        assert!(folder.exists() && file.exists());

        let done = reclaim_tree(
            root.path(),
            OWN,
            |_| false,
            || {
                asked.set(asked.get() + 1);
                true
            },
            later,
        );
        assert_eq!(
            done,
            Reclaimed {
                legacy_folders: 1,
                legacy_net: 1,
                ..Reclaimed::default()
            }
        );
        assert_eq!(asked.get(), 1);
        assert!(!folder.exists() && !file.exists());
    }

    #[test]
    fn a_legacy_folder_goes_only_once_it_has_existed_the_full_age() {
        let root = tempfile::tempdir().unwrap();
        let folder = legacy_folder(root.path());
        let created = std::fs::metadata(&folder).unwrap().created().unwrap();
        let age = Duration::from_secs(3600);
        let just_short = created + age - Duration::from_nanos(100);
        assert_eq!(
            reclaim_aged_folders(root.path(), legacy_working_folder, age, just_short),
            0
        );
        let before_it = created - Duration::from_secs(1);
        assert_eq!(
            reclaim_aged_folders(root.path(), legacy_working_folder, age, before_it),
            0
        );
        assert!(folder.exists());
        assert_eq!(
            reclaim_aged_folders(root.path(), legacy_working_folder, age, created + age),
            1
        );
        assert!(!folder.exists());
    }

    /// A process that holds the folder, a folder under it or a file in it is
    /// still using it, whatever the name says.
    #[cfg(windows)]
    #[test]
    fn a_folder_anything_holds_open_is_never_removed() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        let root = tempfile::tempdir().unwrap();
        let file_held = working_folder(root.path(), DEAD);
        let nested_held = working_folder(root.path(), DEAD);
        std::fs::create_dir(nested_held.join("nested")).unwrap();
        let legacy_held = legacy_folder(root.path());
        let later = SystemTime::now() + LEGACY_STAGE_AGE + Duration::from_secs(60);

        let file = std::fs::File::open(file_held.join("document.pdf")).unwrap();
        let nested = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(nested_held.join("nested"))
            .unwrap();
        let legacy = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&legacy_held)
            .unwrap();
        assert_eq!(
            reclaim_tree(root.path(), OWN, |_| false, || true, later),
            Reclaimed::default()
        );
        assert!(file_held.exists() && nested_held.exists() && legacy_held.exists());

        drop((file, nested, legacy));
        assert_eq!(
            reclaim_tree(root.path(), OWN, |_| false, || true, later),
            Reclaimed {
                folders: 2,
                legacy_folders: 1,
                ..Reclaimed::default()
            }
        );
        assert!(names(root.path()).is_empty());
    }

    /// A link under a working folder's name is not the folder; removing it
    /// could never be the right call.
    #[cfg(windows)]
    #[test]
    fn a_link_under_a_working_folder_name_is_left_alone() {
        let root = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        std::fs::write(target.path().join("keep.pdf"), b"%PDF").unwrap();
        let link = root.path().join(format!("{}.{DEAD}", uuid()));
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(target.path())
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(made.success());
        assert_eq!(
            reclaim_tree(root.path(), OWN, |_| false, || true, SystemTime::now()),
            Reclaimed::default()
        );
        assert!(link.exists());
        assert!(target.path().join("keep.pdf").exists());
        std::fs::remove_dir(&link).unwrap();
    }

    #[test]
    fn a_tree_deeper_than_a_working_folder_can_be_is_kept() {
        let root = tempfile::tempdir().unwrap();
        let shallow = working_folder(root.path(), DEAD);
        let deep = working_folder(root.path(), DEAD);
        std::fs::create_dir_all(shallow.join(["d"; MAX_DEPTH].join("\\"))).unwrap();
        std::fs::create_dir_all(deep.join(["d"; MAX_DEPTH + 1].join("\\"))).unwrap();

        let done = reclaim_tree(root.path(), OWN, |_| false, || false, SystemTime::now());

        assert_eq!(done.folders, 1);
        assert!(!shallow.exists());
        assert!(deep.exists());
    }

    #[test]
    fn a_missing_tree_reclaims_nothing() {
        let root = tempfile::tempdir().unwrap();
        let absent = root.path().join("absent");
        assert_eq!(
            reclaim_tree(&absent, OWN, |_| false, || true, SystemTime::now()),
            Reclaimed::default()
        );
    }

    #[test]
    fn only_a_process_list_that_names_no_other_process_means_alone() {
        assert!(alone(Some(false)));
        assert!(!alone(Some(true)));
        assert!(!alone(None));
    }

    #[cfg(windows)]
    #[test]
    fn the_process_list_holds_this_process_and_a_child_under_their_images() {
        use std::process::{Command, Stdio};
        let exe = std::env::current_exe().unwrap();
        let image = exe.file_name().unwrap().to_str().unwrap().to_string();
        let own = std::process::id();
        let mut child = Command::new("cmd")
            .arg("/Q")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let listed = process_images().unwrap();
        let absent = format!("no-such-image-{own}.exe");
        let elsewhere = image_runs_elsewhere(&absent, own);
        drop(child.stdin.take());
        child.wait().unwrap();

        assert!(
            listed
                .iter()
                .any(|(pid, name)| *pid == own && name.eq_ignore_ascii_case(&image)),
            "this process is not listed"
        );
        assert!(listed
            .iter()
            .any(|(pid, name)| *pid == child.id() && name.eq_ignore_ascii_case("cmd.exe")));
        assert_eq!(elsewhere, Some(false));
    }

    #[test]
    fn only_another_process_under_the_image_counts_in_any_case() {
        const APP: &str = "spectrapdf.exe";
        let listed = |entries: &[(u32, &str)]| -> Vec<(u32, String)> {
            entries
                .iter()
                .map(|(pid, name)| (*pid, name.to_string()))
                .collect()
        };
        assert!(!named_elsewhere(&listed(&[(OWN, APP)]), APP, OWN));
        assert!(!named_elsewhere(
            &listed(&[(LIVE, "notepad.exe")]),
            APP,
            OWN
        ));
        assert!(!named_elsewhere(&listed(&[]), APP, OWN));
        assert!(named_elsewhere(
            &listed(&[(OWN, APP), (LIVE, "SpectraPDF.EXE")]),
            APP,
            OWN
        ));
    }

    #[test]
    fn a_payload_is_released_only_from_the_scratch_folder_and_only_by_its_name() {
        let root = tempfile::tempdir().unwrap();
        let scratch = root.path().join(NET);
        let payload = net_file(root.path(), &net_file_name("form-submission", OWN, "fdf"));
        let legacy = net_file(root.path(), "form-submission-1789169309945-ae0175af.fdf");
        let foreign = net_file(root.path(), "notes.txt");
        let elsewhere = tempfile::tempdir().unwrap();
        let outside = elsewhere.path().join(payload.file_name().unwrap());
        std::fs::write(&outside, b"a user's file").unwrap();

        assert!(release_net_file(&payload, &scratch));
        assert!(release_net_file(&legacy, &scratch));
        assert!(!release_net_file(&foreign, &scratch));
        assert!(!release_net_file(&outside, &scratch));
        assert!(!release_net_file(&payload, &scratch));
        assert!(!payload.exists() && !legacy.exists());
        assert!(foreign.exists() && outside.exists());
    }
}
