use std::fs;
use std::path::{Path, PathBuf};

/// Source of the engine payload and the staged tree the bundler reads.
///
/// The bundler cannot express an exclusion: a `resources` entry naming a
/// directory is walked with `walkdir` and every file under it is copied, and
/// the glob form has no negation. `src/engine` in any checkout that has run
/// the engine carries ignored `__pycache__/*.pyc`, so pointing the bundle at
/// it ships cached bytecode. The bundle points here instead, and this staging
/// carries exactly the source files.
const ENGINE_SOURCE: &str = "../src/engine";
const ENGINE_STAGING: &str = "engine-payload";

fn is_excluded(name: &str, is_dir: bool) -> bool {
    if is_dir {
        return name == "__pycache__";
    }
    name.ends_with(".pyc") || name.ends_with(".pyo") || name.contains(".local.")
}

fn stage_dir(source: &Path, dest: &Path) {
    fs::create_dir_all(dest).unwrap_or_else(|e| panic!("create {}: {e}", dest.display()));
    for entry in fs::read_dir(source).unwrap_or_else(|e| panic!("read {}: {e}", source.display())) {
        let entry = entry.expect("read engine source entry");
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = entry.file_type().expect("stat engine source entry");
        if is_excluded(&name, file_type.is_dir()) {
            continue;
        }
        let target = dest.join(&name);
        if file_type.is_dir() {
            stage_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target)
                .unwrap_or_else(|e| panic!("copy to {}: {e}", target.display()));
        }
    }
}

/// Refuses the build rather than letting cached bytecode reach a bundle.
fn assert_no_bytecode(dir: &Path) {
    for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display())) {
        let entry = entry.expect("read staged entry");
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().expect("stat staged entry").is_dir() {
            if name == "__pycache__" {
                panic!("staged engine payload carries {}", path.display());
            }
            assert_no_bytecode(&path);
        } else if name.ends_with(".pyc") || name.ends_with(".pyo") {
            panic!("staged engine payload carries {}", path.display());
        }
    }
}

fn stage_engine_payload() {
    let source = PathBuf::from(ENGINE_SOURCE);
    let staging = PathBuf::from(ENGINE_STAGING);
    println!("cargo:rerun-if-changed={ENGINE_SOURCE}");

    if staging.exists() {
        fs::remove_dir_all(&staging)
            .unwrap_or_else(|e| panic!("clear {}: {e}", staging.display()));
    }
    stage_dir(&source, &staging);
    assert_no_bytecode(&staging);
}

fn main() {
    stage_engine_payload();
    tauri_build::build()
}
