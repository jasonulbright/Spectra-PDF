//! The pinned Windows XPS interpreter used by the held-job printer queue.
//!
//! The Windows in-box class driver stores XPS packages in retained jobs.
//! Ghostscript does not read XPS, so these jobs use the separately shipped
//! GhostXPS command-line build. The process is contained with the same bounded
//! process-tree runner as the other interpreters, receives a clean environment,
//! and runs only while its exact executable and DLL remain open and hash-pinned.

use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const GXPS_EXE_SHA256: &str = "082d9755d3631ff574e6d7fcb547262afbcea0f23d7bd36ecad2bb46ff1d8ebf";
const GXPS_DLL_SHA256: &str = "a3ce6db95e1e8913695868288b21258e8b7d6ea7d328aa713e1ac6a267e68a16";
const GXPS_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const MAX_PDF_TAIL: u64 = 4096;

fn bundled_program() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("cannot resolve the app path: {error}"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| "the app executable has no parent directory".to_string())?;
    Ok(crate::platform::resource_root_for(directory)
        .join("ghostxps")
        .join("gxpswin64.exe"))
}

fn open_pinned(path: &Path, expected: &str) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;

    // Allow the loader to read the already-open file, while refusing any
    // writer or rename/delete until the child has exited.
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(path)
        .map_err(|error| format!("cannot open the pinned GhostXPS file: {error}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("cannot verify the pinned GhostXPS file: {error}"))?;
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected {
        return Err(format!(
            "the bundled GhostXPS file has an unexpected SHA-256 ({actual})"
        ));
    }
    Ok(file)
}

pub(crate) fn convert_bundled(input: &Path, output: &Path) -> Result<(), String> {
    let program = bundled_program()?;
    convert_with_program(&program, input, output)
}

pub(crate) fn convert_with_program(
    program: &Path,
    input: &Path,
    output: &Path,
) -> Result<(), String> {
    let directory = program
        .parent()
        .ok_or_else(|| "the GhostXPS program has no parent directory".to_string())?;
    let _exe = open_pinned(program, GXPS_EXE_SHA256)?;
    let _dll = open_pinned(&directory.join("gxpsdll64.dll"), GXPS_DLL_SHA256)?;

    let mut command = Command::new(program);
    command
        .current_dir(directory)
        .args([
            "-dBATCH",
            "-dNOPAUSE",
            "-dSAFER",
            "-dPDFSETTINGS=/printer",
            "-sDEVICE=pdfwrite",
        ])
        .arg(format!("-sOutputFile={}", output.display()))
        .arg(input)
        .env_clear()
        .env("GS_LIB", crate::gs::BUNDLED_GS_LIB);
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }
    let temp = std::env::temp_dir();
    command.env("TEMP", &temp).env("TMP", temp);

    let result = crate::gs::output_within(command, GXPS_TIMEOUT)
        .map_err(|error| format!("GhostXPS did not finish: {error}"))?;
    if !result.status.success() {
        let detail = String::from_utf8_lossy(&result.stderr);
        let detail = detail.trim();
        return Err(if detail.is_empty() {
            format!("GhostXPS exited with {}", result.status)
        } else {
            detail.to_string()
        });
    }
    validate_pdf(output)
}

fn validate_pdf(path: &Path) -> Result<(), String> {
    let mut file =
        File::open(path).map_err(|error| format!("GhostXPS produced no PDF: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("cannot inspect the GhostXPS output: {error}"))?
        .len();
    if length < 8 {
        return Err("GhostXPS produced an empty or truncated PDF".to_string());
    }
    let mut header = [0u8; 5];
    file.read_exact(&mut header)
        .map_err(|error| format!("cannot read the GhostXPS PDF header: {error}"))?;
    if &header != b"%PDF-" {
        return Err("GhostXPS output does not have a PDF header".to_string());
    }
    file.seek(SeekFrom::End(-(length.min(MAX_PDF_TAIL) as i64)))
        .map_err(|error| format!("cannot inspect the GhostXPS PDF trailer: {error}"))?;
    let mut tail = Vec::with_capacity(length.min(MAX_PDF_TAIL) as usize);
    file.read_to_end(&mut tail)
        .map_err(|error| format!("cannot read the GhostXPS PDF trailer: {error}"))?;
    if !tail.windows(5).any(|window| window == b"%%EOF") {
        return Err("GhostXPS output has no PDF end marker".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_program_uses_the_ghostxps_resource_folder() {
        let executable = Path::new(r"C:\app\spectrapdf.exe");
        let directory = executable.parent().unwrap();
        assert_eq!(
            crate::platform::resource_root_for(directory)
                .join("ghostxps")
                .join("gxpswin64.exe"),
            Path::new(r"C:\app\ghostxps\gxpswin64.exe")
        );
    }
}
