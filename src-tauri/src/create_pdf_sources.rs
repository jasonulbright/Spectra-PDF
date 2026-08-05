//! The Create PDF accepted set, in Rust — ONE copy.
//!
//! The set exists in three processes because three of them need it and none
//! can import the others: Python CONVERTS (`engine/create_pdf.py` +
//! `engine/soffice.py`), TypeScript BADGES (`src/renderer/lib/create-pdf.ts`),
//! and Rust FILTERS — the native source picker and the `batch --operation
//! create-pdf` folder walk. `tests/create-pdf.test.ts` asserts all three agree
//! by parsing the other two, which is what stops them drifting.
//!
//! Rust's copy lives HERE rather than inside the picker command so the CLI's
//! batch walk and the GUI's picker cannot disagree about what is accepted —
//! two copies inside one process would be a drift the cross-process test
//! could not even see.

use std::path::Path;

pub const IMAGES: &[&str] = &[
    "png", "jpg", "jpeg", "jpe", "tif", "tiff", "bmp", "dib", "gif", "webp", "jp2", "j2k", "j2c",
    "jpc", "jpf", "jpx", "avif", "heic", "heif",
];

pub const OFFICE: &[&str] = &[
    "doc", "docx", "docm", "dot", "dotx", "odt", "ott", "fodt", "rtf", "txt", "xls", "xlsx",
    "xlsm", "xlt", "xltx", "ods", "ots", "fods", "csv", "ppt", "pptx", "pptm", "pot", "potx",
    "odp", "otp", "fodp", "odg", "otg", "html", "htm", "xhtml",
];

pub const POSTSCRIPT: &[&str] = &["ps", "eps"];

/// Every extension Create PDF takes, PDF first (it is the pass-through).
pub fn all() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = vec!["pdf"];
    out.extend_from_slice(IMAGES);
    out.extend_from_slice(OFFICE);
    out.extend_from_slice(POSTSCRIPT);
    out
}

/// Does an arm convert this file? Extension-only and case-insensitive, the
/// same question `engine/create_pdf.py`'s `classify` answers — the ENGINE
/// still validates, so this is a filter, never the authority.
pub fn accepts(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let ext = ext.to_ascii_lowercase();
            all().iter().any(|candidate| *candidate == ext)
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn accepts_every_extension_it_offers_regardless_of_case() {
        for ext in all() {
            assert!(accepts(&PathBuf::from(format!("a.{ext}"))), "{ext}");
            assert!(accepts(&PathBuf::from(format!("a.{}", ext.to_uppercase()))), "{ext}");
        }
    }

    #[test]
    fn refuses_what_no_arm_converts() {
        for name in ["a.zip", "b.exe", "c.mp4", "d", ".hidden"] {
            assert!(!accepts(&PathBuf::from(name)), "{name}");
        }
    }

    #[test]
    fn the_set_has_no_duplicates() {
        let mut seen = all();
        let before = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(before, seen.len(), "a suffix is listed twice");
    }
}
