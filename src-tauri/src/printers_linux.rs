//! Linux printer enumeration and capabilities through the system's CUPS.
//!
//! The same shapes the Windows module reports, so the Print dialog and the
//! CLI `printers` arm read one contract. The paper id is the destination's
//! own media keyword (`iso_a4_210x297mm`, `na_letter_8.5x11in`): CUPS selects
//! media by that name, so the engine submits exactly what the dialog showed.

use crate::cups_linux::{self, CupsSize, DestInfo};

#[derive(serde::Serialize)]
pub struct PrinterList {
    /// Destination names (`queue` or `queue/instance`), sorted.
    pub printers: Vec<String>,
    /// The user's default destination, when it is one of `printers`.
    pub default: Option<String>,
}

pub fn enumerate() -> Result<PrinterList, String> {
    let cups = cups_linux::cups()?;
    let dests = cups.destinations()?;
    let mut printers: Vec<String> = dests.iter().map(cups_linux::display_name).collect();
    printers.sort_by_key(|n| n.to_lowercase());
    printers.dedup();
    let default = dests
        .iter()
        .find(|dest| dest.is_default != 0)
        .map(cups_linux::display_name)
        .filter(|d| printers.iter().any(|p| p == d));
    Ok(PrinterList { printers, default })
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct PaperOption {
    /// The destination's media keyword, what the engine submits as `media`.
    pub id: String,
    /// The print system's localized name for the size.
    pub name: String,
    /// Portrait size in PDF points.
    pub width_pt: f64,
    pub height_pt: f64,
}

#[derive(serde::Serialize, Debug)]
pub struct PrinterCapabilities {
    pub papers: Vec<PaperOption>,
    pub default_paper: Option<String>,
    /// `sides` accepts a two-sided value.
    pub duplex: bool,
    /// `print-color-mode` accepts `color`. A destination that reports no
    /// colour modes at all reads as colour, so a query failure never hides a
    /// real control.
    pub color: bool,
    /// `multiple-document-handling` accepts collated copies. Informational:
    /// collation is job sequencing in the engine.
    pub collate: bool,
    /// The upper bound of `copies-supported`. Informational for the same
    /// reason.
    pub max_copies: u32,
}

const HUNDREDTHS_MM_TO_PT: f64 = 72.0 / 2540.0;

/// One reported entry as a dialog row, keyed by its size name, or nothing
/// for an entry that is not a fixed paper: the custom-size range bounds and
/// zero-sized entries.
pub(crate) fn paper_option(
    size: &CupsSize,
    localized: &str,
    size_name: Option<String>,
) -> Option<PaperOption> {
    let keyword = size_name.unwrap_or_else(|| size.media());
    if keyword.is_empty()
        || keyword.starts_with("custom_")
        || size.media().starts_with("custom_")
        || size.width <= 0
        || size.length <= 0
    {
        return None;
    }
    let name = if localized.trim().is_empty() {
        keyword.clone()
    } else {
        localized.to_string()
    };
    Some(PaperOption {
        id: keyword,
        name,
        width_pt: size.width as f64 * HUNDREDTHS_MM_TO_PT,
        height_pt: size.length as f64 * HUNDREDTHS_MM_TO_PT,
    })
}

/// The capability report of one destination's information.
pub(crate) fn capabilities_of(info: &DestInfo<'_>) -> PrinterCapabilities {
    let mut papers: Vec<PaperOption> = Vec::new();
    for (size, localized) in info.media() {
        if let Some(paper) = paper_option(&size, &localized, info.size_name(&size)) {
            // media-col-database lists a size once per source and type; the
            // dialog offers each size once.
            if !papers.iter().any(|p| p.id == paper.id) {
                papers.push(paper);
            }
        }
    }
    let default_paper = info
        .default_size()
        .and_then(|size| info.size_name(&size))
        .filter(|media| papers.iter().any(|p| &p.id == media));
    let duplex = info.supports("sides", "two-sided-long-edge")
        || info.supports("sides", "two-sided-short-edge");
    let reports_colour_modes = info.supports("print-color-mode", "monochrome")
        || info.supports("print-color-mode", "color");
    let color = info.supports("print-color-mode", "color") || !reports_colour_modes;
    let collate = info.supports(
        "multiple-document-handling",
        "separate-documents-collated-copies",
    );
    let max_copies = info
        .range_upper("copies")
        .and_then(|upper| u32::try_from(upper).ok())
        .unwrap_or(1);
    PrinterCapabilities {
        papers,
        default_paper,
        duplex,
        color,
        collate,
        max_copies,
    }
}

/// One destination's paper list and feature flags. Read-only: nothing here
/// opens a job or changes the destination's stored defaults.
pub fn capabilities(name: &str) -> Result<PrinterCapabilities, String> {
    let cups = cups_linux::cups()?;
    let dests = cups.destinations()?;
    let dest = dests
        .find(name)
        .ok_or_else(|| format!("Unknown printer: '{name}'"))?;
    let info = dests.info(dest)?;
    Ok(capabilities_of(&info))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(media: &str, width: i32, length: i32) -> CupsSize {
        let mut size = CupsSize::zeroed();
        for (slot, byte) in size.media.iter_mut().zip(media.bytes()) {
            *slot = byte as std::ffi::c_char;
        }
        size.width = width;
        size.length = length;
        size
    }

    #[test]
    fn a_reported_size_becomes_a_paper_in_points() {
        let a4 = paper_option(&size("iso_a4_210x297mm", 21000, 29700), "A4", None).unwrap();
        assert_eq!(a4.id, "iso_a4_210x297mm");
        assert_eq!(a4.name, "A4");
        assert!((a4.width_pt - 595.2756).abs() < 1e-3);
        assert!((a4.height_pt - 841.8898).abs() < 1e-3);
    }

    #[test]
    fn range_bounds_and_empty_rows_are_not_papers() {
        assert!(paper_option(&size("custom_min_25.4x25.4mm", 2540, 2540), "", None).is_none());
        assert!(paper_option(&size("custom_max_1219x1219mm", 121920, 121920), "", None).is_none());
        assert!(paper_option(&size("iso_a4_210x297mm", 0, 29700), "", None).is_none());
        assert!(paper_option(&size("", 21000, 29700), "", None).is_none());
    }

    #[test]
    fn a_media_key_with_source_and_margins_reports_its_size_name() {
        let tray = paper_option(
            &size("iso_a4_210x297mm_tray-1_stationery_borderless", 21000, 29700),
            "A4 (Borderless, Tray 1)",
            Some("iso_a4_210x297mm".to_string()),
        )
        .unwrap();
        assert_eq!(tray.id, "iso_a4_210x297mm");
    }

    #[test]
    fn a_size_without_a_localized_name_shows_its_keyword() {
        let letter = paper_option(&size("na_letter_8.5x11in", 21590, 27940), " ", None).unwrap();
        assert_eq!(letter.name, "na_letter_8.5x11in");
        assert!((letter.width_pt - 612.0).abs() < 1e-6);
        assert!((letter.height_pt - 792.0).abs() < 1e-6);
    }

    #[test]
    fn enumeration_answers_or_refuses_by_name() {
        // A system without CUPS, or without a running scheduler, refuses with
        // a sentence naming the print system; one with CUPS lists queues.
        match enumerate() {
            Ok(list) => {
                if let Some(default) = &list.default {
                    assert!(list.printers.contains(default));
                }
            }
            Err(message) => assert!(
                message.contains("CUPS") || message.contains("print system"),
                "{message}"
            ),
        }
    }
}
