//! Machine policy on Linux: one administrator-owned JSON file.
//!
//! `/etc/spectrapdf/policies.json` holds an object whose keys are the policy
//! names the Windows build reads from `HKLM\SOFTWARE\Spectra PDF`
//! (`DisableAutoUpdate`, `DisableFieldScripts`, ...). A policy is set when its
//! value is the number 1 or `true`; any other value, and a missing key, is
//! unset, as an absent or non-DWORD registry value is on Windows.
//!
//! Only root can write the policy: the file and its directory must be owned
//! by root and writable by no one else, or the file is not a machine policy
//! and is ignored. A user therefore cannot set, clear or replace a policy, and
//! a policy outranks the user's preference in the one direction it allows.

use std::os::unix::fs::MetadataExt;
use std::path::Path;

pub const POLICY_FILE: &str = "/etc/spectrapdf/policies.json";

/// Group- and other-write permission bits.
const WRITABLE_BY_OTHERS: u32 = 0o022;

fn administrator_owned(meta: &std::fs::Metadata) -> bool {
    meta.uid() == 0 && meta.mode() & WRITABLE_BY_OTHERS == 0
}

/// The policy text at `path` when the file and its directory are
/// administrator-owned. `trusted` decides ownership so tests need no root.
fn read_trusted(path: &Path, trusted: impl Fn(&std::fs::Metadata) -> bool) -> Option<String> {
    let dir = std::fs::metadata(path.parent()?).ok()?;
    let file = std::fs::metadata(path).ok()?;
    if !dir.is_dir() || !file.is_file() || !trusted(&dir) || !trusted(&file) {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Whether the policy text sets `name`.
fn sets(text: &str, name: &str) -> bool {
    let Ok(serde_json::Value::Object(policies)) = serde_json::from_str::<serde_json::Value>(text)
    else {
        return false;
    };
    match policies.get(name) {
        Some(serde_json::Value::Bool(set)) => *set,
        Some(serde_json::Value::Number(n)) => n.as_u64() == Some(1),
        _ => false,
    }
}

/// Whether an administrator set the machine policy `name`.
pub fn machine_policy_set(name: &str) -> bool {
    read_trusted(Path::new(POLICY_FILE), administrator_owned).is_some_and(|text| sets(&text, name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_policy_is_set_by_one_or_true_only() {
        let text = r#"{"DisableAutoUpdate": 1, "DisableFieldScripts": true,
            "A": 0, "B": "1", "C": 2, "D": false, "E": 1.0, "F": null}"#;
        assert!(sets(text, "DisableAutoUpdate"));
        assert!(sets(text, "DisableFieldScripts"));
        for unset in ["A", "B", "C", "D", "E", "F", "DisableExplorerMenu"] {
            assert!(!sets(text, unset), "{unset}");
        }
        assert!(!sets("[1]", "DisableAutoUpdate"));
        assert!(!sets("not json", "DisableAutoUpdate"));
        assert!(!sets("", "DisableAutoUpdate"));
    }

    #[test]
    fn a_file_that_is_not_administrator_owned_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("policies.json");
        assert_eq!(read_trusted(&path, |_| true), None);
        std::fs::write(&path, br#"{"DisableAutoUpdate": 1}"#).unwrap();
        assert!(read_trusted(&path, |_| true).is_some_and(|t| sets(&t, "DisableAutoUpdate")));
        assert_eq!(read_trusted(&path, |_| false), None);
        assert_eq!(read_trusted(&path, |meta| meta.is_dir()), None);
        assert_eq!(read_trusted(&path, |meta| meta.is_file()), None);
    }

    #[test]
    fn ownership_needs_root_and_no_foreign_write_bit() {
        let dir = tempfile::tempdir().unwrap();
        let meta = std::fs::metadata(dir.path()).unwrap();
        let root = unsafe { libc::geteuid() } == 0;
        assert_eq!(administrator_owned(&meta), root && meta.mode() & WRITABLE_BY_OTHERS == 0);
        let etc = std::fs::metadata("/etc").unwrap();
        assert!(administrator_owned(&etc));
    }
}
