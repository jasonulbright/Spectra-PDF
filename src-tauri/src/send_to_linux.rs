//! Send by email on Linux: `xdg-email --attach`, which opens the user's
//! preferred mail client's compose window with the staged copy attached
//! (xdg-utils, xdg-email(1)). The preferred client is the default handler of
//! `x-scheme-handler/mailto` (`xdg-mime query default`); with none registered
//! the command refuses by name rather than letting xdg-email fall back to a
//! web browser that cannot attach a file.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

/// How long xdg-email has to fail before the hand-over counts as done. Most
/// clients keep the process running while the compose window is open.
const HANDOVER_WAIT: Duration = Duration::from_secs(3);

pub const XDG_EMAIL_MISSING: &str =
    "Sending by email needs xdg-email from xdg-utils, which is not installed on this computer.";
pub const NO_MAIL_CLIENT: &str = "No email app is set up to handle email on this computer. \
     Install one and make it the default email app, then try again.";

/// Why xdg-email failed, from its documented exit codes.
fn exit_reason(code: Option<i32>) -> String {
    match code {
        Some(1) => "xdg-email rejected its arguments".to_string(),
        Some(2) => "the attachment could not be found".to_string(),
        Some(3) => "a tool the email app needs is not installed".to_string(),
        Some(4) => "the email app could not be started".to_string(),
        Some(5) => "the email app has no permission to read the attachment".to_string(),
        Some(other) => format!("xdg-email returned {other}"),
        None => "xdg-email was stopped by a signal".to_string(),
    }
}

/// The desktop file of the default `mailto:` handler, if one is registered.
fn default_mail_client() -> Result<Option<String>, String> {
    let output = match Command::new("xdg-mime")
        .args(["query", "default", "x-scheme-handler/mailto"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(XDG_EMAIL_MISSING.to_string())
        }
        Err(e) => return Err(format!("Could not ask which email app is the default: {e}")),
    };
    let handler = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((output.status.success() && !handler.is_empty()).then_some(handler))
}

fn xdg_email_command(staged: &Path) -> Command {
    let subject = staged
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut cmd = Command::new("xdg-email");
    cmd.arg("--attach").arg(staged);
    if !subject.is_empty() {
        cmd.arg("--subject").arg(subject);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd
}

/// Hand `staged` to the default mail client. Same result contract as the
/// Windows path: a fast failure is an error; a compose window still open
/// after [`HANDOVER_WAIT`] is a hand-over, and the process is reaped on a
/// thread of its own when the client returns.
pub fn send(staged: &Path) -> Result<(), String> {
    if default_mail_client()?.is_none() {
        return Err(NO_MAIL_CLIENT.to_string());
    }
    let mut child = match xdg_email_command(staged).spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(XDG_EMAIL_MISSING.to_string())
        }
        Err(e) => return Err(format!("Could not start xdg-email: {e}")),
    };
    let deadline = std::time::Instant::now() + HANDOVER_WAIT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!(
                    "Could not hand the file to the email app — {}.",
                    exit_reason(status.code())
                ))
            }
            Ok(None) if std::time::Instant::now() >= deadline => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("Could not follow xdg-email: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_attaches_the_staged_copy_with_its_name_as_subject() {
        let cmd = xdg_email_command(Path::new("/tmp/spectrapdf/send-to/Q3 report.pdf"));
        assert_eq!(cmd.get_program(), "xdg-email");
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(
            args,
            ["--attach", "/tmp/spectrapdf/send-to/Q3 report.pdf", "--subject", "Q3 report"]
        );
    }

    #[test]
    fn every_documented_exit_code_is_named() {
        for code in 1..=5 {
            assert!(!exit_reason(Some(code)).contains("returned"), "{code}");
        }
        assert!(exit_reason(Some(9)).contains('9'));
        assert!(exit_reason(None).contains("signal"));
    }
}
