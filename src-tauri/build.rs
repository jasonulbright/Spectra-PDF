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

/// Any reparse point, not only a symlink: a junction or mount point under the
/// payload redirects the walk (and the bundler's copy) outside the tree.
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
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
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)
            .unwrap_or_else(|e| panic!("stat {}: {e}", path.display()));
        if is_reparse_point(&meta) {
            panic!("engine payload tree carries a reparse point: {}", path.display());
        }
        if meta.is_dir() {
            collect_staged(&path, &rel, found);
        } else {
            found.insert(rel);
        }
    }
}

/// Removes every directory under `dir` that holds no file, deepest first.
/// Returns whether `dir` itself is empty afterwards; the root is left to the
/// caller.
fn remove_empty_dirs(dir: &Path) -> bool {
    let mut empty = true;
    for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display())) {
        let entry = entry.expect("read copied entry");
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)
            .unwrap_or_else(|e| panic!("stat {}: {e}", path.display()));
        if is_reparse_point(&meta) {
            panic!("engine payload tree carries a reparse point: {}", path.display());
        }
        if meta.is_dir() {
            if remove_empty_dirs(&path) {
                fs::remove_dir(&path)
                    .unwrap_or_else(|e| panic!("remove stale directory {}: {e}", path.display()));
            } else {
                empty = false;
            }
        } else {
            empty = false;
        }
    }
    empty
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

/// `target/<profile>/engine`: where `tauri_build::build()` copies the staged
/// payload for a dev run, and the tree the portable bundle is cut from.
fn copied_resources_dir() -> Option<PathBuf> {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").ok()?);
    // target/<profile>/build/<crate>-<hash>/out
    let profile_dir = out_dir.ancestors().nth(3)?;
    let copied = profile_dir.join("engine");
    copied.is_dir().then_some(copied)
}

/// The resource copy into `target/<profile>/engine` is additive: a file the
/// manifest no longer lists survives there from an earlier build and rides
/// into the portable staging, which is cut from that tree. Pruning runs before
/// the copy, so the tree ends up as exactly the manifest set. A deletion that
/// fails is fatal: a stale file left in place is exactly the leak this
/// prevents, and an empty `__pycache__` left behind is still a rejected path.
fn prune_copied_resources(expected: &BTreeSet<String>) {
    let Some(copied) = copied_resources_dir() else {
        return;
    };
    let mut present = BTreeSet::new();
    collect_staged(&copied, "", &mut present);
    for stale in present.difference(expected) {
        let path = copied.join(stale);
        fs::remove_file(&path)
            .unwrap_or_else(|e| panic!("remove stale payload file {}: {e}", path.display()));
    }
    remove_empty_dirs(&copied);
}

/// The copied tree after `tauri_build::build()` is exactly the manifest, by
/// path set and by bytes. The prune and the copy each assume the other did
/// its half; this is the check that neither assumption went unmet.
fn verify_copied_resources(rows: &[Row]) {
    let Some(copied) = copied_resources_dir() else {
        return;
    };
    let mut present = BTreeSet::new();
    collect_staged(&copied, "", &mut present);
    let expected: BTreeSet<String> = rows.iter().map(|r| r.path.clone()).collect();
    for extra in present.difference(&expected) {
        panic!("copied engine payload carries an unmanifested file: {extra}");
    }
    for missing in expected.difference(&present) {
        panic!("copied engine payload is missing a manifest row: {missing}");
    }
    assert_no_bytecode(&present);
    for row in rows {
        let path = copied.join(&row.path);
        let bytes = fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let digest = format!("{:x}", Sha256::digest(&bytes));
        if bytes.len() as u64 != row.size || digest != row.sha256 {
            panic!(
                "copied engine payload bytes differ from the manifest for {}: manifest {} bytes {}, copied {} bytes {}",
                row.path,
                row.size,
                row.sha256,
                bytes.len(),
                digest
            );
        }
    }
}

fn stage_engine_payload() -> Vec<Row> {
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
    rows
}

fn main() {
    let rows = stage_engine_payload();
    tauri_build::build();
    verify_copied_resources(&rows);
}
