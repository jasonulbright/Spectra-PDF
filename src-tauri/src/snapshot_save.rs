//! The platform-neutral half of the snapshot tool: the raw-body request
//! checks and the PNG file save. Each platform's `snapshot` module publishes
//! the image to its own clipboard.

use tauri::ipc::{InvokeBody, Request};

pub fn header_number(request: &Request<'_>, name: &str) -> Result<usize, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .ok_or_else(|| format!("snapshot request is missing its {name} header"))
}

/// The eight-byte PNG signature. The write below refuses anything else.
pub const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Write the captured PNG to a path the user chose in the save dialog.
///
/// A raw body again (the same raster, megabytes of it), with the destination
/// percent-encoded in a header. Deliberately NOT a general "write these bytes
/// anywhere" door: the path must name a `.png` and the body must carry the
/// PNG signature, so the command can only ever do the one thing it exists for.
/// It overwrites, because the save dialog already asked.
pub fn save(request: &Request<'_>) -> Result<String, String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("snapshot image must be sent as a raw body".to_string()),
    };
    write_png(body, || {
        let encoded = request
            .headers()
            .get("snapshot-path")
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| "snapshot request is missing its snapshot-path header".to_string())?;
        percent_decode(encoded)
    })
}

/// The body must carry the PNG signature and the path must name a `.png`.
/// The file is published as an export (see
/// [`crate::file_publication::export_bytes`]): an existing file the save
/// dialog offered to overwrite stays whole until the new one lands.
pub(crate) fn write_png(body: &[u8], path: impl FnOnce() -> Result<String, String>) -> Result<String, String> {
    if body.len() < PNG_SIGNATURE.len() || body[..PNG_SIGNATURE.len()] != PNG_SIGNATURE {
        return Err("snapshot body is not a PNG".to_string());
    }
    let path = path()?;
    if !std::path::Path::new(&path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("png"))
    {
        return Err(format!("a snapshot is saved as a .png file, not {path}"));
    }
    crate::file_publication::export_bytes(body, std::path::Path::new(&path))
        .map_err(|e| format!("Could not write {path}: {e}"))?;
    Ok(path)
}

/// Percent-decoding for the path header. Headers are ASCII, and a Windows
/// path can hold anything; `encodeURIComponent` on the way in and this on the
/// way out is the same convention the filesystem plugin uses.
fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("snapshot-path header is not valid percent-encoding".to_string());
            }
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                .map_err(|_| "snapshot-path header is not valid percent-encoding".to_string())?;
            out.push(
                u8::from_str_radix(hex, 16)
                    .map_err(|_| "snapshot-path header is not valid percent-encoding".to_string())?,
            );
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "snapshot-path header is not valid UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(tail: &[u8]) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(tail);
        bytes
    }

    #[test]
    fn a_snapshot_replaces_the_chosen_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("shot.png");
        std::fs::write(&target, png(b"the previous shot")).unwrap();
        let path = target.to_string_lossy().to_string();

        assert_eq!(write_png(&png(b"a new shot"), || Ok(path.clone())).unwrap(), path);

        assert_eq!(std::fs::read(&target).unwrap(), png(b"a new shot"));
        let beside: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(beside, vec![std::ffi::OsString::from("shot.png")]);
    }

    /// The refusals come before the path is even read, in the order the
    /// request is checked, and none of them touches an existing file.
    #[test]
    fn a_refused_snapshot_leaves_the_chosen_file_alone() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("shot.png");
        std::fs::write(&target, png(b"the previous shot")).unwrap();
        let path = target.to_string_lossy().to_string();

        let not_png = write_png(b"GIF89a", || panic!("the path is read after the body"));
        assert_eq!(not_png.unwrap_err(), "snapshot body is not a PNG");
        let jpg = dir.path().join("shot.jpg").to_string_lossy().to_string();
        assert!(write_png(&png(b"x"), || Ok(jpg)).unwrap_err().contains(".png file"));
        assert!(write_png(&png(b"x"), || Err("no header".to_string())).is_err());

        assert_eq!(std::fs::read(&target).unwrap(), png(b"the previous shot"));
        assert!(write_png(&png(b"x"), || Ok(path)).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn a_snapshot_lands_through_the_checked_stage() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .unwrap();
        writer.wait().unwrap();
        let orphan = dir
            .path()
            .join(format!("document-stage-{}-abc123.pdf", writer.id()));
        std::fs::write(&orphan, b"a killed save's stage").unwrap();
        let path = dir.path().join("shot.png").to_string_lossy().to_string();

        write_png(&png(b"a shot"), || Ok(path)).unwrap();

        assert!(!orphan.exists());
    }

    /// A folder that lets the user change the chosen picture but not create a
    /// file beside it: the snapshot refuses and leaves the picture whole.
    #[cfg(windows)]
    #[test]
    fn a_snapshot_refuses_untouched_where_the_folder_refuses_a_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("shot.png");
        let earlier = png(b"the previous shot, longer than the new one");
        std::fs::write(&target, &earlier).unwrap();
        let id = crate::staging::file_id(&target);
        let path = target.to_string_lossy().to_string();

        {
            let _denied = crate::staging::Denied::create(dir.path(), &[&target]);
            let refused = write_png(&png(b"a new shot"), || Ok(path.clone())).unwrap_err();
            assert!(refused.contains("replaced safely"), "{refused}");
        }

        assert_eq!(std::fs::read(&target).unwrap(), earlier);
        assert_eq!(crate::staging::file_id(&target), id);
        let beside: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(beside, vec![std::ffi::OsString::from("shot.png")]);
    }
}
