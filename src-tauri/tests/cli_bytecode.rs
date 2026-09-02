//! A headless CLI run leaves no bytecode in the engine payload.
//!
//! The windowed engine spawn and the CLI's spawn are two code paths onto one
//! interpreter; a regression in either writes `__pycache__` beside every
//! imported engine module, so an install grows files no uninstall removes.
//! The unit tests in `cli.rs` cover argument parsing; this is the only test
//! that launches the real binary and reads the tree it leaves behind.
//!
//! The binary resolves `python/` and `engine/` beside itself, so the run is
//! made against a copy: the exe and a fresh copy of the engine tree in a
//! scratch directory, with `python/` reached through a directory junction
//! (the runtime is hundreds of megabytes and this test never writes into it).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const EXE: &str = env!("CARGO_BIN_EXE_spectrapdf");

fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap_or_else(|e| panic!("create {}: {e}", to.display()));
    for entry in fs::read_dir(from).unwrap_or_else(|e| panic!("read {}: {e}", from.display())) {
        let entry = entry.expect("read engine entry");
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type().expect("stat engine entry").is_dir() {
            copy_tree(&src, &dst);
        } else {
            fs::copy(&src, &dst).unwrap_or_else(|e| panic!("copy {}: {e}", src.display()));
        }
    }
}

fn bytecode_under(dir: &Path, hits: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display())) {
        let entry = entry.expect("read scratch entry");
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().expect("stat scratch entry").is_dir();
        if name == "__pycache__" || name.ends_with(".pyc") || name.ends_with(".pyo") {
            hits.push(path.clone());
        }
        if is_dir {
            bytecode_under(&path, hits);
        }
    }
}

fn junction(link: &Path, target: &Path) {
    let status = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .status()
        .expect("spawn cmd for mklink");
    assert!(status.success(), "mklink /J {} -> {}", link.display(), target.display());
}

#[test]
fn check_writes_no_bytecode_into_the_engine_payload() {
    let exe = PathBuf::from(EXE);
    let exe_dir = exe.parent().expect("exe dir");
    let python = exe_dir.join("python").join("python.exe");
    let engine = exe_dir.join("engine");
    if !python.is_file() || !engine.join("__startup__.py").is_file() {
        eprintln!(
            "skipped: no provisioned python/engine beside {} (see punchlist § Dev environment notes)",
            exe.display()
        );
        return;
    }

    let scratch = exe_dir.join(format!("cli-bytecode-test-{}", std::process::id()));
    if scratch.exists() {
        fs::remove_dir_all(&scratch).expect("clear scratch");
    }
    fs::create_dir_all(&scratch).expect("create scratch");
    let scratch_exe = scratch.join("spectrapdf.exe");
    fs::copy(&exe, &scratch_exe).expect("copy exe");
    copy_tree(&engine, &scratch.join("engine"));
    junction(&scratch.join("python"), &exe_dir.join("python"));

    let mut before = Vec::new();
    bytecode_under(&scratch.join("engine"), &mut before);
    assert!(before.is_empty(), "copied engine tree already carries {before:?}");

    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("sample.pdf");
    let output = Command::new(&scratch_exe)
        .arg("check")
        .arg(&fixture)
        .env_remove("PYTHONDONTWRITEBYTECODE")
        .output()
        .expect("spawn spectrapdf check");

    let mut after = Vec::new();
    bytecode_under(&scratch.join("engine"), &mut after);

    // The junction is removed as a directory entry, never followed.
    fs::remove_dir(scratch.join("python")).expect("remove python junction");
    fs::remove_dir_all(&scratch).expect("remove scratch");

    assert!(
        output.status.success(),
        "spectrapdf check failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("\"valid\": true"), "unexpected check output: {stdout}");
    assert!(after.is_empty(), "the CLI run wrote bytecode into the payload: {after:?}");
}
