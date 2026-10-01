//! Identities shared by the File Explorer command handler and the app's
//! registration code. Both crates mount this file with `#[path]`, and both
//! mount the Create PDF accepted set as `crate::create_pdf_sources`, so the
//! handler, the package manifest and the classic registry keys read one list.

pub const PACKAGE_NAME: &str = "SpectraPDF.ExplorerCommands";
pub const PACKAGE_DISPLAY_NAME: &str = "Spectra PDF";
pub const APP_NAME: &str = "Spectra PDF";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Verb {
    Convert,
    Combine,
}

impl Verb {
    pub const ALL: [Verb; 2] = [Verb::Convert, Verb::Combine];

    /// Registry spelling, without braces.
    pub const fn clsid(self) -> &'static str {
        match self {
            Verb::Convert => "9A90E15E-F7FA-4166-A6A4-DD16727F4DD1",
            Verb::Combine => "1E6E88CC-5B6A-4904-BFB0-DACAD020EA49",
        }
    }

    pub const fn clsid_u128(self) -> u128 {
        match self {
            Verb::Convert => 0x9A90E15E_F7FA_4166_A6A4_DD16727F4DD1,
            Verb::Combine => 0x1E6E88CC_5B6A_4904_BFB0_DACAD020EA49,
        }
    }

    /// The classic verb's registry key name.
    pub const fn verb_id(self) -> &'static str {
        match self {
            Verb::Convert => "SpectraPDF.Convert",
            Verb::Combine => "SpectraPDF.Combine",
        }
    }

    /// The package manifest's verb id, which the schema limits to letters
    /// and digits.
    pub const fn package_verb_id(self) -> &'static str {
        match self {
            Verb::Convert => "SpectraPDFConvert",
            Verb::Combine => "SpectraPDFCombine",
        }
    }

    /// The `action` field of the handoff file.
    pub const fn action(self) -> &'static str {
        match self {
            Verb::Convert => "convert",
            Verb::Combine => "combine",
        }
    }

    pub const fn label_key(self) -> &'static str {
        match self {
            Verb::Convert => "shell.verb.convert",
            Verb::Combine => "shell.verb.combine",
        }
    }

    /// The label a classic verb shows when the handler cannot be asked for
    /// one. Pinned against the English catalog by the handler's tests.
    pub const fn english_label(self) -> &'static str {
        match self {
            Verb::Convert => "Convert to PDF with Spectra PDF",
            Verb::Combine => "Combine into one PDF with Spectra PDF",
        }
    }

    /// Lowercase, without the dot. PostScript is never offered: it needs a
    /// user-supplied Ghostscript that a default install does not have.
    pub fn extensions(self) -> Vec<&'static str> {
        let mut out: Vec<&'static str> = Vec::new();
        if self == Verb::Combine {
            out.push("pdf");
        }
        out.extend_from_slice(crate::create_pdf_sources::IMAGES);
        out.extend_from_slice(crate::create_pdf_sources::OFFICE);
        out
    }

    pub fn accepts_extension(self, extension: &str) -> bool {
        let lower = extension.to_ascii_lowercase();
        self.extensions().iter().any(|e| *e == lower)
    }

    /// The fewest items the verb is shown for.
    pub const fn min_items(self) -> usize {
        match self {
            Verb::Convert => 1,
            Verb::Combine => 2,
        }
    }
}

/// Every extension either verb is registered on, in a stable order.
pub fn registered_extensions() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for verb in Verb::ALL {
        for ext in verb.extensions() {
            if !out.contains(&ext) {
                out.push(ext);
            }
        }
    }
    out
}
