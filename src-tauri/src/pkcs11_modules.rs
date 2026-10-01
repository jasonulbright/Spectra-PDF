//! The PKCS#11 modules this system has registered with p11-kit, for the
//! signer's token source.
//!
//! p11-kit registers a module with one `<name>.module` file (pkcs11.conf(5)):
//! package files in `/usr/share/p11-kit/modules`, administrator files in
//! `/etc/pkcs11/modules`, and the user's own in
//! `$XDG_CONFIG_HOME/pkcs11/modules`. A file of the same name in a later
//! directory replaces the earlier one, and `user-config:` in
//! `/etc/pkcs11/pkcs11.conf` says whether the user's files count (`none`,
//! `merge`, `only`). A `module:` value is an absolute path or a name in
//! p11-kit's module directory. The trust module (`trust-policy: yes`) holds
//! anchors and no keys, and a module p11-kit only reaches over a `remote:`
//! transport has no library to load, so neither is offered.
//!
//! The modules are the system's own; nothing here installs or bundles one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const PACKAGE_DIR: &str = "/usr/share/p11-kit/modules";
const SYSTEM_DIR: &str = "/etc/pkcs11/modules";
const SYSTEM_CONF: &str = "/etc/pkcs11/pkcs11.conf";
const PROGRAM: &str = "spectrapdf";

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Pkcs11Module {
    /// The registration's file name without `.module`.
    pub name: String,
    pub path: String,
}

/// The directories p11-kit builds resolve a relative `module:` name in.
fn module_dirs() -> Vec<PathBuf> {
    let triplet = match std::env::consts::ARCH {
        "x86_64" => "x86_64-linux-gnu",
        "aarch64" => "aarch64-linux-gnu",
        "x86" => "i386-linux-gnu",
        "arm" => "arm-linux-gnueabihf",
        other => other,
    };
    vec![
        PathBuf::from(format!("/usr/lib/{triplet}/pkcs11")),
        PathBuf::from("/usr/lib64/pkcs11"),
        PathBuf::from("/usr/lib/pkcs11"),
        PathBuf::from("/usr/local/lib/pkcs11"),
    ]
}

/// The `key: value` pairs of a p11-kit configuration file.
fn config_values(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect()
}

fn listed(values: &BTreeMap<String, String>, key: &str, program: &str) -> Option<bool> {
    values
        .get(key)
        .map(|list| list.split(',').any(|p| p.trim() == program))
}

/// Which module directories count, highest priority last.
fn registration_dirs(system_conf: Option<&str>, user_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mode = system_conf
        .map(config_values)
        .and_then(|values| values.get("user-config").cloned())
        .unwrap_or_else(|| "merge".to_string());
    let system = vec![PathBuf::from(PACKAGE_DIR), PathBuf::from(SYSTEM_DIR)];
    match (mode.as_str(), user_dir) {
        ("none", _) | (_, None) => system,
        ("only", Some(user)) => vec![user],
        (_, Some(user)) => system.into_iter().chain([user]).collect(),
    }
}

/// The library a registration loads, or `None` when it is not offered.
fn module_library(
    text: &str,
    dirs: &[PathBuf],
    exists: &impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let values = config_values(text);
    if values
        .get("trust-policy")
        .is_some_and(|v| v.eq_ignore_ascii_case("yes"))
        || listed(&values, "disable-in", PROGRAM) == Some(true)
        || listed(&values, "enable-in", PROGRAM) == Some(false)
    {
        return None;
    }
    let module = PathBuf::from(values.get("module")?);
    if module.is_absolute() {
        return exists(&module).then_some(module);
    }
    dirs.iter().map(|dir| dir.join(&module)).find(|p| exists(p))
}

fn registered_in(
    registration: &[PathBuf],
    read_dir: impl Fn(&Path) -> Vec<(String, String)>,
    library_dirs: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> Vec<Pkcs11Module> {
    let mut by_name: BTreeMap<String, String> = BTreeMap::new();
    for dir in registration {
        for (file, text) in read_dir(dir) {
            let Some(name) = file.strip_suffix(".module") else {
                continue;
            };
            match module_library(&text, library_dirs, &exists) {
                Some(path) => by_name.insert(name.to_string(), path.to_string_lossy().into_owned()),
                None => by_name.remove(name),
            };
        }
    }
    by_name
        .into_iter()
        .map(|(name, path)| Pkcs11Module { name, path })
        .collect()
}

fn read_registrations(dir: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            let text = std::fs::read_to_string(entry.path()).ok()?;
            Some((name, text))
        })
        .collect()
}

/// Every module the system registered, by name.
pub fn registered() -> Vec<Pkcs11Module> {
    let user_dir = crate::autostart_linux::config_home(
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
    .map(|config| config.join("pkcs11").join("modules"));
    let system_conf = std::fs::read_to_string(SYSTEM_CONF).ok();
    registered_in(
        &registration_dirs(system_conf.as_deref(), user_dir),
        read_registrations,
        &module_dirs(),
        |p| p.is_file(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs() -> Vec<PathBuf> {
        vec![PathBuf::from("/lib/a/pkcs11"), PathBuf::from("/lib/b/pkcs11")]
    }

    #[test]
    fn relative_and_absolute_module_names_resolve_to_existing_libraries() {
        let exists = |p: &Path| {
            p == Path::new("/lib/b/pkcs11/opensc-pkcs11.so") || p == Path::new("/opt/x.so")
        };
        assert_eq!(
            module_library("module: opensc-pkcs11.so\n", &dirs(), &exists),
            Some(PathBuf::from("/lib/b/pkcs11/opensc-pkcs11.so"))
        );
        assert_eq!(
            module_library("# comment\nmodule:/opt/x.so", &dirs(), &exists),
            Some(PathBuf::from("/opt/x.so"))
        );
        assert_eq!(module_library("module: gone.so", &dirs(), &exists), None);
        assert_eq!(module_library("remote: |ssh host p11-kit remote", &dirs(), &exists), None);
    }

    #[test]
    fn trust_and_program_scoped_registrations_are_not_offered() {
        let exists = |_: &Path| true;
        assert_eq!(module_library("module: p11-kit-trust.so\ntrust-policy: yes", &dirs(), &exists), None);
        assert_eq!(module_library("module: a.so\ndisable-in: spectrapdf, x", &dirs(), &exists), None);
        assert_eq!(module_library("module: a.so\nenable-in: firefox", &dirs(), &exists), None);
        assert!(module_library("module: a.so\nenable-in: firefox,spectrapdf", &dirs(), &exists).is_some());
        assert!(module_library("module: a.so\ndisable-in: firefox", &dirs(), &exists).is_some());
    }

    #[test]
    fn user_config_mode_decides_whether_the_users_files_count() {
        let user = Some(PathBuf::from("/home/u/.config/pkcs11/modules"));
        let all = registration_dirs(None, user.clone());
        assert_eq!(all.len(), 3);
        assert_eq!(all[2], user.clone().unwrap());
        assert_eq!(registration_dirs(Some("user-config: none"), user.clone()).len(), 2);
        assert_eq!(
            registration_dirs(Some("user-config: only"), user.clone()),
            vec![user.clone().unwrap()]
        );
        assert_eq!(registration_dirs(Some("user-config: merge"), None).len(), 2);
    }

    #[test]
    fn a_later_directory_replaces_or_withdraws_a_registration_of_the_same_name() {
        let registration = vec![PathBuf::from("/pkg"), PathBuf::from("/etc")];
        let read = |dir: &Path| -> Vec<(String, String)> {
            match dir.to_str().unwrap() {
                "/pkg" => vec![
                    ("opensc.module".into(), "module: opensc.so".into()),
                    ("softhsm2.module".into(), "module: softhsm2.so".into()),
                    ("notes.txt".into(), "module: x.so".into()),
                ],
                "/etc" => vec![
                    ("opensc.module".into(), "module: /opt/opensc.so".into()),
                    ("softhsm2.module".into(), "module: softhsm2.so\ndisable-in: spectrapdf".into()),
                ],
                _ => vec![],
            }
        };
        let found = registered_in(&registration, read, &dirs(), |_| true);
        assert_eq!(
            found,
            vec![Pkcs11Module { name: "opensc".into(), path: "/opt/opensc.so".into() }]
        );
    }
}
