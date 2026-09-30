//! The platform-neutral half of reading the clipboard as a document source:
//! the result shape, the payload bounds, and the scratch files the payload is
//! written to. Each platform's `clipboard_read` module does the OS reads.
//!
//! The bytes never cross the IPC boundary: a pasted screenshot is megabytes,
//! the engine needs a file anyway, and the caller needs only the path.

use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::scratch::{
    clipboard_dir, clipboard_file_name, clipboard_file_owner, legacy_clipboard_file,
};

/// Clipboard blocks belong to another process. Bound both the copy and the
/// parsing expansion before allocating memory from the advertised size.
pub const MAX_CLIPBOARD_IMAGE_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_CLIPBOARD_TEXT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
pub struct ClipboardSource {
    /// The scratch file written. Its extension is one Create PDF accepts.
    pub path: String,
    /// `image` | `html` | `text` — what the caller shows, not what converts
    /// it (the engine decides that from the extension, as it does for a
    /// picked file).
    pub kind: String,
    /// The clipboard format the payload came from, for the report line.
    pub format: String,
    pub bytes: usize,
    /// Present for `CF_DIB` only: read out of the DIB's own header, so the
    /// caller reports the size the clipboard actually holds.
    pub width: Option<i32>,
    pub height: Option<i32>,
    /// Present for text and HTML: the character count of the payload.
    pub chars: Option<usize>,
    /// `CF_HTML`'s `SourceURL`, recorded for the report. NEVER fetched and
    /// never used as a base href — a relative reference in a fragment
    /// resolves to nothing, which is the offline posture being correct
    /// rather than convenient.
    pub source_url: Option<String>,
    /// Present when the clipboard held copied files (`text/uri-list`): the
    /// local paths, in clipboard order. `path` is then the first of them and
    /// no scratch file exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
}

pub fn checked_clipboard_size(size: usize, limit: usize, kind: &str) -> Result<usize, String> {
    if size > limit {
        return Err(format!(
            "The clipboard {kind} exceeds the {} MiB import limit.",
            limit / (1024 * 1024)
        ));
    }
    Ok(size)
}

/// Wrap a fragment as a standalone document. No base href, deliberately (see
/// `source_url`), and an explicit charset so the converter never guesses.
pub fn html_document(fragment: &str) -> String {
    if fragment.to_ascii_lowercase().contains("<html") {
        return fragment.to_string();
    }
    format!(
        "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"></head>\n\
         <body>\n{fragment}\n</body></html>\n"
    )
}

pub fn scratch_dir() -> Result<PathBuf, String> {
    let dir = clipboard_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create the clipboard scratch folder: {e}"))?;
    Ok(dir)
}

pub fn create_scratch_candidate(candidate: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(candidate)?;
    if let Err(error) = file.write_all(bytes) {
        drop(file);
        let _ = std::fs::remove_file(candidate);
        return Err(error);
    }
    Ok(())
}

pub fn write_scratch_at(
    dir: &std::path::Path,
    extension: &str,
    bytes: &[u8],
    stamp: u128,
) -> Result<String, String> {
    for n in 0..1_000u32 {
        let name = clipboard_file_name(stamp, n, std::process::id(), extension)
            .ok_or_else(|| "The clipboard scratch filename is invalid".to_string())?;
        let candidate = dir.join(name);
        match create_scratch_candidate(&candidate, bytes) {
            Ok(()) => return Ok(candidate.to_string_lossy().to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create the clipboard file: {error}")),
        }
    }
    Err("could not allocate a clipboard scratch file".to_string())
}

pub fn write_scratch(extension: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = scratch_dir()?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    write_scratch_at(&dir, extension, bytes, stamp)
}

pub fn discard_scratch_at(dir: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    let scratch = dir
        .canonicalize()
        .map_err(|e| format!("Cannot locate the clipboard scratch folder: {e}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "The clipboard scratch path is invalid".to_string())?
        .canonicalize()
        .map_err(|e| format!("Cannot locate the clipboard scratch file: {e}"))?;
    if parent != scratch {
        return Err("The path is outside the clipboard scratch folder".to_string());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The clipboard scratch filename is invalid".to_string())?;
    if clipboard_file_owner(name).is_none() && !legacy_clipboard_file(name) {
        return Err("The path is not a clipboard scratch file".to_string());
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err("The clipboard scratch path is not a regular file".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect clipboard scratch file: {error}")),
    }
    std::fs::remove_file(path).map_err(|e| format!("Could not remove clipboard scratch file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::{
        checked_clipboard_size, create_scratch_candidate, discard_scratch_at, html_document,
        write_scratch_at,
    };
    use std::sync::{mpsc, Arc, Barrier};

    #[test]
    fn clipboard_payload_sizes_stop_at_their_memory_bound() {
        let limit = 16 * 1024 * 1024;
        assert_eq!(checked_clipboard_size(limit, limit, "text").unwrap(), limit);
        assert!(checked_clipboard_size(limit + 1, limit, "text")
            .unwrap_err()
            .contains("16 MiB"));
    }

    #[test]
    fn simultaneous_scratch_writes_cannot_replace_one_another() {
        let dir = tempfile::tempdir().unwrap();
        let start = Arc::new(Barrier::new(3));
        let (paths_tx, paths_rx) = mpsc::channel();
        let workers: Vec<_> = [b"first".as_slice(), b"second".as_slice()]
            .into_iter()
            .map(|bytes| {
                let dir = dir.path().to_path_buf();
                let start = Arc::clone(&start);
                let paths_tx = paths_tx.clone();
                std::thread::spawn(move || {
                    start.wait();
                    let path = write_scratch_at(&dir, "txt", bytes, 7).unwrap();
                    paths_tx.send((path, bytes.to_vec())).unwrap();
                })
            })
            .collect();
        start.wait();
        drop(paths_tx);

        let results: Vec<_> = paths_rx.into_iter().collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(results.len(), 2);
        assert_ne!(results[0].0, results[1].0);
        for (path, expected) in results {
            assert_eq!(std::fs::read(path).unwrap(), expected);
        }
    }

    #[test]
    fn clipboard_scratch_names_include_the_owning_process() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_scratch_at(dir.path(), "txt", b"private", 7).unwrap();
        let name = std::path::Path::new(&path)
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(name, format!("clipboard-7-0.{}.txt", std::process::id()));
    }

    #[test]
    fn a_scratch_candidate_is_created_by_only_one_concurrent_writer() {
        let dir = tempfile::tempdir().unwrap();
        let candidate = dir
            .path()
            .join(format!("clipboard-7-0.{}.txt", std::process::id()));
        let start = Arc::new(Barrier::new(3));
        let (result_tx, result_rx) = mpsc::channel();
        let writers: Vec<_> = [b"first".as_slice(), b"second".as_slice()]
            .into_iter()
            .map(|bytes| {
                let start = Arc::clone(&start);
                let result_tx = result_tx.clone();
                let candidate = candidate.clone();
                std::thread::spawn(move || {
                    start.wait();
                    result_tx
                        .send((create_scratch_candidate(&candidate, bytes), bytes.to_vec()))
                        .unwrap();
                })
            })
            .collect();
        start.wait();
        drop(result_tx);

        let results: Vec<_> = result_rx.into_iter().collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(results.len(), 2);
        assert_eq!(results.iter().filter(|(result, _)| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|(result, _)| result.as_ref().err())
                .next()
                .unwrap()
                .kind(),
            std::io::ErrorKind::AlreadyExists
        );
        let expected = results
            .iter()
            .find(|(result, _)| result.is_ok())
            .unwrap()
            .1
            .clone();
        assert_eq!(std::fs::read(candidate).unwrap(), expected);
    }

    #[test]
    fn clipboard_scratch_release_removes_only_its_own_file() {
        let dir = tempfile::tempdir().unwrap();
        let scratch = dir
            .path()
            .join(format!("clipboard-7-0.{}.txt", std::process::id()));
        std::fs::write(&scratch, b"private clipboard text").unwrap();
        discard_scratch_at(dir.path(), &scratch).unwrap();
        assert!(!scratch.exists());
        // Releasing twice is safe when close and row-removal race.
        discard_scratch_at(dir.path(), &scratch).unwrap();

        let legacy = dir.path().join("clipboard-7-1.txt");
        std::fs::write(&legacy, b"legacy clipboard text").unwrap();
        discard_scratch_at(dir.path(), &legacy).unwrap();
        assert!(!legacy.exists());
    }

    #[test]
    fn clipboard_scratch_release_refuses_paths_outside_its_folder() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let protected = outside
            .path()
            .join(format!("clipboard-7-0.{}.txt", std::process::id()));
        std::fs::write(&protected, b"keep").unwrap();
        assert!(discard_scratch_at(dir.path(), &protected).is_err());
        assert_eq!(std::fs::read(protected).unwrap(), b"keep");

        let unrelated = dir.path().join("important.txt");
        std::fs::write(&unrelated, b"keep").unwrap();
        assert!(discard_scratch_at(dir.path(), &unrelated).is_err());
        assert_eq!(std::fs::read(unrelated).unwrap(), b"keep");
    }

    #[test]
    fn clipboard_scratch_release_refuses_unowned_names() {
        let dir = tempfile::tempdir().unwrap();
        let unrelated = dir.path().join("clipboard-important.txt");
        std::fs::write(&unrelated, b"keep").unwrap();
        assert!(discard_scratch_at(dir.path(), &unrelated).is_err());
        assert_eq!(std::fs::read(unrelated).unwrap(), b"keep");
    }

    #[test]
    fn a_bare_fragment_is_wrapped_but_a_document_is_not() {
        assert!(html_document("<p>x</p>").contains("<meta charset=\"utf-8\">"));
        let whole = "<html><body>x</body></html>";
        assert_eq!(html_document(whole), whole);
    }
}
