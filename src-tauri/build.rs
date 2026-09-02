use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Source of the engine payload and the staged tree the bundler reads.
///
/// The bundler cannot express an exclusion: a `resources` entry naming a
/// directory is walked with `walkdir` and every file under it is copied, and
/// the glob form has no negation. `src/engine` in any checkout that has run
/// the engine carries ignored `__pycache__/*.pyc` and may carry any other
/// untracked file, so pointing the bundle at it ships whatever the working
/// tree happens to hold. The bundle points at this staging instead, and the
/// staging is built from an exact checked-in manifest -- a file with no row
/// cannot enter the payload, and a row whose bytes do not match its recorded
/// size and SHA-256 fails the build.
const ENGINE_SOURCE: &str = "../src/engine";
const ENGINE_STAGING: &str = "engine-payload";
const MANIFEST: &str = "../src/engine/PAYLOAD-MANIFEST.tsv";
const MANIFEST_HEADER: &str = "path\tsize\tsha256";

struct Row {
    path: String,
    size: u64,
    sha256: String,
}

/// A row path names a file under the staging root and nothing else: relative,
/// forward-slashed, no `..`, no drive letter, no root escape.
fn validate_row_path(path: &str) {
    if path.is_empty() {
        panic!("engine payload manifest: empty path");
    }
    if path.contains('\\') {
        panic!("engine payload manifest: backslash in path: {path}");
    }
    if path.contains(':') {
        panic!("engine payload manifest: drive letter or colon in path: {path}");
    }
    if path.starts_with('/') {
        panic!("engine payload manifest: absolute path: {path}");
    }
    for component in path.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            panic!("engine payload manifest: path escapes the payload root: {path}");
        }
    }
}

fn read_manifest(manifest: &Path) -> Vec<Row> {
    let text = fs::read_to_string(manifest)
        .unwrap_or_else(|e| panic!("read {}: {e}", manifest.display()));
    let mut lines = text.lines();
    match lines.next() {
        Some(header) if header == MANIFEST_HEADER => {}
        other => panic!("engine payload manifest header is {other:?}; expected {MANIFEST_HEADER:?}"),
    }

    let mut rows: Vec<Row> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() != 3 {
            panic!("engine payload manifest: malformed row: {line}");
        }
        let path = fields[0].to_string();
        validate_row_path(&path);
        if !seen.insert(path.clone()) {
            panic!("engine payload manifest: duplicate path: {path}");
        }
        let size: u64 = fields[1]
            .parse()
            .unwrap_or_else(|e| panic!("engine payload manifest: bad size for {path}: {e}"));
        let sha256 = fields[2].to_ascii_lowercase();
        if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            panic!("engine payload manifest: bad sha256 for {path}");
        }
        rows.push(Row { path, size, sha256 });
    }
    if rows.is_empty() {
        panic!("engine payload manifest lists no files");
    }
    rows
}

fn stage_row(source_root: &Path, staging: &Path, row: &Row) {
    let source = source_root.join(&row.path);
    let meta = fs::symlink_metadata(&source)
        .unwrap_or_else(|e| panic!("engine payload source missing: {}: {e}", source.display()));
    if meta.file_type().is_symlink() {
        panic!("engine payload source is a symlink: {}", source.display());
    }
    if !meta.is_file() {
        panic!("engine payload source is not a file: {}", source.display());
    }

    let bytes = fs::read(&source).unwrap_or_else(|e| panic!("read {}: {e}", source.display()));
    if bytes.len() as u64 != row.size {
        panic!(
            "engine payload size mismatch for {}: manifest {} bytes, source {} bytes",
            row.path,
            row.size,
            bytes.len()
        );
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != row.sha256 {
        panic!(
            "engine payload sha256 mismatch for {}: manifest {}, source {}",
            row.path, row.sha256, digest
        );
    }

    let target = staging.join(&row.path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).unwrap_or_else(|e| panic!("create {}: {e}", parent.display()));
    }
    fs::write(&target, &bytes).unwrap_or_else(|e| panic!("write {}: {e}", target.display()));
}

fn collect_staged(dir: &Path, prefix: &str, found: &mut BTreeSet<String>) {
    for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display())) {
        let entry = entry.expect("read staged entry");
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let file_type = entry.file_type().expect("stat staged entry");
        if file_type.is_symlink() {
            panic!("staged engine payload carries a symlink: {rel}");
        }
        if file_type.is_dir() {
            collect_staged(&entry.path(), &rel, found);
        } else {
            found.insert(rel);
        }
    }
}

/// Refuses the build rather than letting cached bytecode reach a bundle.
fn assert_no_bytecode(staged: &BTreeSet<String>) {
    for rel in staged {
        if rel.split('/').any(|c| c == "__pycache__") || rel.ends_with(".pyc") || rel.ends_with(".pyo")
        {
            panic!("staged engine payload carries {rel}");
        }
    }
}

/// The resource copy into `target/<profile>/engine` is additive: a file the
/// manifest no longer lists survives there from an earlier build and rides
/// into the portable staging, which is cut from that tree. Pruning runs before
/// the copy, so the tree ends up as exactly the manifest set.
fn prune_copied_resources(expected: &BTreeSet<String>) {
    let out_dir = match std::env::var("OUT_DIR") {
        Ok(value) => PathBuf::from(value),
        Err(_) => return,
    };
    // target/<profile>/build/<crate>-<hash>/out
    let profile_dir = match out_dir.ancestors().nth(3) {
        Some(dir) => dir.to_path_buf(),
        None => return,
    };
    let copied = profile_dir.join("engine");
    if !copied.is_dir() {
        return;
    }
    let mut present = BTreeSet::new();
    collect_staged(&copied, "", &mut present);
    for stale in present.difference(expected) {
        let path = copied.join(stale);
        let _ = fs::remove_file(&path);
    }
}

fn stage_engine_payload() {
    let source = PathBuf::from(ENGINE_SOURCE);
    let staging = PathBuf::from(ENGINE_STAGING);
    let manifest = PathBuf::from(MANIFEST);
    println!("cargo:rerun-if-changed={ENGINE_SOURCE}");
    println!("cargo:rerun-if-changed={MANIFEST}");

    let rows = read_manifest(&manifest);

    if staging.exists() {
        fs::remove_dir_all(&staging)
            .unwrap_or_else(|e| panic!("clear {}: {e}", staging.display()));
    }
    fs::create_dir_all(&staging)
        .unwrap_or_else(|e| panic!("create {}: {e}", staging.display()));
    for row in &rows {
        stage_row(&source, &staging, row);
    }

    let mut staged = BTreeSet::new();
    collect_staged(&staging, "", &mut staged);
    let expected: BTreeSet<String> = rows.iter().map(|r| r.path.clone()).collect();
    for extra in staged.difference(&expected) {
        panic!("staged engine payload carries an unmanifested file: {extra}");
    }
    for missing in expected.difference(&staged) {
        panic!("staged engine payload is missing a manifest row: {missing}");
    }
    assert_no_bytecode(&staged);
    prune_copied_resources(&expected);
}

fn main() {
    stage_engine_payload();
    tauri_build::build()
}
