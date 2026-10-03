//! Start with the system on Linux: one XDG autostart entry.
//!
//! The entry is `$XDG_CONFIG_HOME/autostart/com.spectrapdf.app.desktop`
//! (`~/.config/autostart` when the variable is unset or not absolute), the
//! user-level autostart directory of the XDG Autostart specification. A
//! session starts every entry there whose `Hidden` key is not true; GNOME
//! also skips one whose `X-GNOME-Autostart-enabled` key is false.
//!
//! An AppImage runs from a mount point that changes with every launch, so the
//! entry names the image file itself (`$APPIMAGE`), not the running
//! executable. An update can replace the image under another name, which
//! leaves the entry naming a file that is gone; each launch rewrites such an
//! entry to name the copy that is running.

use std::path::{Path, PathBuf};

const ENTRY_FILE: &str = "com.spectrapdf.app.desktop";
const MINIMIZED: &str = "--minimized";

/// The autostart directory of this session.
fn autostart_dir() -> Result<PathBuf, String> {
    config_home(
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
    .map(|config| config.join("autostart"))
    .ok_or_else(|| "Cannot locate the autostart folder: HOME is not set".to_string())
}

/// `$XDG_CONFIG_HOME`, or `$HOME/.config` when it is unset or relative, as
/// the XDG Base Directory specification requires.
pub(crate) fn config_home(xdg: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    match xdg.filter(|p| p.is_absolute()) {
        Some(config) => Some(config),
        None => home
            .filter(|p| p.is_absolute())
            .map(|home| home.join(".config")),
    }
}

/// The program a launch of this copy runs: the AppImage file when running
/// from one, else this executable.
pub(crate) fn launch_target() -> Result<PathBuf, String> {
    launch_target_for(crate::portable::appimage(), std::env::current_exe())
}

/// The image file wins over the executable: inside an AppImage the executable
/// sits in a mount that disappears when the image exits.
pub(crate) fn launch_target_for(
    image: Option<PathBuf>,
    exe: std::io::Result<PathBuf>,
) -> Result<PathBuf, String> {
    match image {
        Some(image) => Ok(image),
        None => exe.map_err(|e| format!("Cannot resolve this application's path: {e}")),
    }
}

/// One argument of an `Exec` value: quoted, field-code escaped, then escaped
/// for a string value, in that order (Desktop Entry Specification, "The Exec
/// key" and "Possible value types").
fn exec_argument(arg: &str) -> Result<String, String> {
    if arg.chars().any(char::is_control) {
        return Err(format!("An autostart entry cannot name a path with control characters: {arg:?}"));
    }
    let mut quoted = String::from("\"");
    for ch in arg.chars() {
        if matches!(ch, '"' | '`' | '$' | '\\') {
            quoted.push('\\');
        }
        quoted.push(ch);
    }
    quoted.push('"');
    Ok(quoted.replace('%', "%%").replace('\\', "\\\\"))
}

/// The `Exec` value that launches `program`.
fn exec_value(program: &Path, minimized: bool) -> Result<String, String> {
    let mut value = exec_argument(&program.to_string_lossy())?;
    if minimized {
        value.push(' ');
        value.push_str(MINIMIZED);
    }
    Ok(value)
}

/// Undo the string-value escapes of a desktop entry value.
fn unescape_value(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// The arguments of an `Exec` value, quoting and field-code escapes undone.
fn exec_arguments(value: &str) -> Vec<String> {
    let unescaped = unescape_value(value);
    let mut args = Vec::new();
    let mut chars = unescaped.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| *c == ' ' || *c == '\t') {
            chars.next();
        }
        let Some(&first) = chars.peek() else {
            break;
        };
        let mut arg = String::new();
        if first == '"' {
            chars.next();
            while let Some(ch) = chars.next() {
                match ch {
                    '"' => break,
                    '\\' => {
                        if let Some(next) = chars.next() {
                            arg.push(next);
                        }
                    }
                    other => arg.push(other),
                }
            }
        } else {
            while let Some(&ch) = chars.peek() {
                if ch == ' ' || ch == '\t' {
                    break;
                }
                arg.push(ch);
                chars.next();
            }
        }
        args.push(arg.replace("%%", "%"));
    }
    args
}

/// The value of `key` in the `[Desktop Entry]` group of `text`.
fn entry_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let mut in_entry = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry || line.starts_with('#') {
            continue;
        }
        if let Some((name, value)) = line.split_once('=') {
            if name.trim() == key {
                return Some(value.trim());
            }
        }
    }
    None
}

/// Whether a session starts the entry `text`.
fn entry_enabled(text: &str) -> bool {
    !entry_value(text, "Hidden").is_some_and(|v| v == "true")
        && !entry_value(text, "X-GNOME-Autostart-enabled").is_some_and(|v| v == "false")
}

fn entry_text(program: &Path, minimized: bool) -> Result<String, String> {
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName=Spectra PDF\nExec={}\nTerminal=false\n",
        exec_value(program, minimized)?
    ))
}

/// What a launch must do to the entry it found, by the same rule the Windows
/// Run value follows: an entry naming a program that still exists is left
/// alone, one naming a missing program is rewritten to name `program`, and
/// the minimized choice travels unchanged.
#[derive(Debug, PartialEq, Eq)]
enum EntryAction {
    Keep,
    Rewrite(String),
}

fn entry_action(
    text: &str,
    program: &Path,
    exists: impl Fn(&Path) -> bool,
) -> Result<EntryAction, String> {
    let Some(exec) = entry_value(text, "Exec") else {
        return Ok(EntryAction::Keep);
    };
    let args = exec_arguments(exec);
    let Some(recorded) = args.first() else {
        return Ok(EntryAction::Keep);
    };
    if Path::new(recorded) == program || exists(Path::new(recorded)) {
        return Ok(EntryAction::Keep);
    }
    let minimized = args.iter().skip(1).any(|a| a == MINIMIZED);
    Ok(EntryAction::Rewrite(entry_text(program, minimized)?))
}

fn read_entry(path: &Path) -> Result<Option<String>, String> {
    crate::staging::read_record(path)
        .map(|bytes| bytes.map(|b| String::from_utf8_lossy(&b).into_owned()))
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))
}

fn state_at(dir: &Path) -> Result<(bool, bool), String> {
    let Some(text) = read_entry(&dir.join(ENTRY_FILE))? else {
        return Ok((false, false));
    };
    let minimized = entry_value(&text, "Exec")
        .is_some_and(|exec| exec_arguments(exec).iter().skip(1).any(|a| a == MINIMIZED));
    Ok((entry_enabled(&text), minimized))
}

fn write_at(dir: &Path, program: &Path, enabled: bool, minimized: bool) -> Result<(), String> {
    let path = dir.join(ENTRY_FILE);
    if !enabled {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Failed to remove the autostart entry: {e}")),
        };
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create the autostart folder: {e}"))?;
    crate::staging::write_record(&path, entry_text(program, minimized)?.as_bytes())
        .map_err(|e| format!("Failed to write the autostart entry: {e}"))
}

fn refresh_at(dir: &Path, program: &Path) -> Result<(), String> {
    let path = dir.join(ENTRY_FILE);
    let Some(text) = read_entry(&path)? else {
        return Ok(());
    };
    match entry_action(&text, program, |p| p.is_file())? {
        EntryAction::Keep => Ok(()),
        EntryAction::Rewrite(text) => crate::staging::write_record(&path, text.as_bytes())
            .map_err(|e| format!("Failed to rewrite the autostart entry: {e}")),
    }
}

/// (enabled, minimized) of this user's autostart entry.
pub fn state() -> Result<(bool, bool), String> {
    state_at(&autostart_dir()?)
}

/// Write or remove this user's autostart entry.
pub fn write(enabled: bool, minimized: bool) -> Result<(), String> {
    write_at(&autostart_dir()?, &launch_target()?, enabled, minimized)
}

/// The launch-time correction.
pub fn refresh() -> Result<(), String> {
    refresh_at(&autostart_dir()?, &launch_target()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_home_falls_back_to_home_dot_config() {
        let home = Some(PathBuf::from("/home/u"));
        assert_eq!(config_home(Some("/x".into()), home.clone()), Some("/x".into()));
        assert_eq!(config_home(Some("rel".into()), home.clone()), Some("/home/u/.config".into()));
        assert_eq!(config_home(None, home), Some("/home/u/.config".into()));
        assert_eq!(config_home(None, None), None);
        assert_eq!(config_home(None, Some("rel".into())), None);
    }

    #[test]
    fn a_launch_from_an_image_names_the_image_not_its_mount() {
        let image = PathBuf::from("/home/u/Apps/Spectra_PDF.AppImage");
        let mounted = Ok(PathBuf::from("/tmp/.mount_SpectrXYZ/usr/bin/spectrapdf"));
        assert_eq!(launch_target_for(Some(image.clone()), mounted), Ok(image));
        assert_eq!(
            launch_target_for(None, Ok(PathBuf::from("/usr/bin/spectrapdf"))),
            Ok(PathBuf::from("/usr/bin/spectrapdf"))
        );
        assert!(launch_target_for(None, Err(std::io::Error::other("gone"))).is_err());
    }

    #[test]
    fn exec_arguments_round_trip_through_every_escape_layer() {
        for path in [
            "/opt/Spectra PDF/spectrapdf",
            r#"/home/u/a "quoted" $HOME `tick` back\slash 100%.AppImage"#,
            "/home/ü/Ünïcode.AppImage",
        ] {
            let value = exec_value(Path::new(path), true).unwrap();
            assert_eq!(exec_arguments(&value), vec![path.to_string(), MINIMIZED.to_string()]);
            let value = exec_value(Path::new(path), false).unwrap();
            assert_eq!(exec_arguments(&value), vec![path.to_string()]);
        }
        assert_eq!(
            exec_value(Path::new(r"/a\b%c"), false).unwrap(),
            r#""/a\\\\b%%c""#
        );
        assert!(exec_value(Path::new("/a\nb"), false).is_err());
    }

    #[test]
    fn hidden_and_gnome_disabled_entries_do_not_start() {
        let entry = entry_text(Path::new("/opt/s"), false).unwrap();
        assert!(entry_enabled(&entry));
        assert!(!entry_enabled(&format!("{entry}Hidden=true\n")));
        assert!(!entry_enabled(&format!("{entry}X-GNOME-Autostart-enabled=false\n")));
        assert!(entry_enabled(&format!("{entry}Hidden=false\n")));
        assert!(entry_enabled(&format!("{entry}\n[Other]\nHidden=true\n")));
    }

    #[test]
    fn a_missing_program_is_replaced_and_the_minimized_choice_kept() {
        let program = Path::new("/new/Spectra.AppImage");
        let old = entry_text(Path::new("/old/Spectra.AppImage"), true).unwrap();
        let rewritten = entry_text(program, true).unwrap();
        assert_eq!(
            entry_action(&old, program, |_| false).unwrap(),
            EntryAction::Rewrite(rewritten)
        );
        assert_eq!(entry_action(&old, program, |_| true).unwrap(), EntryAction::Keep);
        let current = entry_text(program, false).unwrap();
        assert_eq!(entry_action(&current, program, |_| false).unwrap(), EntryAction::Keep);
        assert_eq!(entry_action("[Desktop Entry]\n", program, |_| false).unwrap(), EntryAction::Keep);
    }

    #[test]
    fn the_entry_is_written_read_refreshed_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let autostart = dir.path().join("autostart");
        let program = dir.path().join("spectrapdf");
        std::fs::write(&program, b"").unwrap();
        assert_eq!(state_at(&autostart).unwrap(), (false, false));
        write_at(&autostart, &program, true, true).unwrap();
        assert_eq!(state_at(&autostart).unwrap(), (true, true));
        write_at(&autostart, &program, true, false).unwrap();
        assert_eq!(state_at(&autostart).unwrap(), (true, false));

        let moved = dir.path().join("moved");
        std::fs::write(&moved, b"").unwrap();
        refresh_at(&autostart, &moved).unwrap();
        let text = std::fs::read_to_string(autostart.join(ENTRY_FILE)).unwrap();
        assert!(text.contains(&program.to_string_lossy().to_string()));
        std::fs::remove_file(&program).unwrap();
        refresh_at(&autostart, &moved).unwrap();
        let text = std::fs::read_to_string(autostart.join(ENTRY_FILE)).unwrap();
        assert_eq!(exec_arguments(entry_value(&text, "Exec").unwrap()), vec![moved.to_string_lossy().to_string()]);

        write_at(&autostart, &moved, false, false).unwrap();
        assert!(!autostart.join(ENTRY_FILE).exists());
        write_at(&autostart, &moved, false, false).unwrap();
        refresh_at(&autostart, &moved).unwrap();
        assert!(!autostart.join(ENTRY_FILE).exists());
    }
}
