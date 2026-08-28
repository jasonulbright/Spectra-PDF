//! The guided scanner checklist runner behind `spectrapdf scan-test`.
//!
//! Doc 71 §7.3 is a checklist most of whose rows cannot be posed on a
//! flatbed-only device. This module is what a tester with the missing
//! hardware runs: the rows that can be judged from the staged pages are
//! judged here, the rows that need a physical act (load the feeder, pull the
//! power, induce a jam) prompt for it and wait, and every row records the same
//! evidence a hand-run checklist would — pixel geometry, resolution read back
//! from the image's own header, bit depth, header integrity and a grayscale
//! histogram verdict separating real content from a blank or uniform page.
//!
//! A file that exists is not evidence. Nothing in the report carries image
//! content: the histogram travels as five aggregate numbers and a verdict,
//! never as pixels, and a staged page leaves the machine only when the tester
//! passes `--attach-scans`.
//!
//! The COM work stays in `scanner.rs`; this module only drives it, so the
//! apartment rule cannot be broken from here.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::scanner::{
    ColorMode, PaperSize, ScanEvent, ScanRefusal, ScanResult, ScanSettings, ScanSourceOption,
    ScannerCapabilities, ScannerSessions, SourceOptionId,
};

/// The report format's own version, so a report from an older build is
/// readable rather than merely parseable.
pub const REPORT_SCHEMA: u32 = 2;

/// What the report says about itself, verbatim, in both renderings.
pub const PRIVACY_NOTE: &str = "This report carries device metadata, the settings each row asked for, \
and measurements of the pages that came back (pixel size, resolution, bit depth, header integrity \
and grayscale histogram statistics). It carries no image content and no page text. Scanned pages \
stay on this machine unless --attach-scans was passed, which copies them beside the report.";

// ── The row table ───────────────────────────────────────────────────────────

/// The hardware a row needs before it can be posed at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowNeed {
    /// A flatbed source.
    Flatbed,
    /// A document feeder.
    Feeder,
    /// A feeder that scans both sides.
    Duplex,
    /// A feeder plus a writable page-count property.
    PageLimit,
    /// A device that LISTS `WIA_DATA_AUTO`.
    Autodetect,
    /// A network-attached device (eSCL/Mopria or WSD) — the tester says which.
    Network,
    /// Any device at all.
    AnyDevice,
}

/// How a row runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowMode {
    /// Runs against the device with no physical act beyond starting it.
    Automatic,
    /// Needs a hand at the device: paper loaded, power pulled, a jam induced.
    Prompted,
}

/// One §7.3 row, as the runner knows it.
#[derive(Debug, Clone, Copy)]
pub struct ChecklistRow {
    /// The §7.3 row number, so a report row and a doc row are the same row.
    pub id: &'static str,
    pub title: &'static str,
    /// What the tester is asked to do, in plain language.
    pub instruction: &'static str,
    pub needs: RowNeed,
    pub mode: RowMode,
    /// Minutes to allow, for a tester deciding whether to start.
    pub minutes: u32,
}

/// Every row this runner can pose, in checklist order.
///
/// Rows 13 and 15 of §7.3 are deliberately absent: both are assembly rows
/// (the enhance-then-OCR chain, and CLI/dialog equivalence through
/// `create_pdf`), and run 1 closed them on a flatbed. This runner is the
/// acquisition half, which is the half the missing hardware gates.
pub const ROWS: &[ChecklistRow] = &[
    ChecklistRow {
        id: "1",
        title: "Flatbed, colour, 300 dpi, Letter",
        instruction: "Put a printed page — text, not a blank sheet — on the glass and close the lid.",
        needs: RowNeed::Flatbed,
        mode: RowMode::Prompted,
        minutes: 3,
    },
    ChecklistRow {
        id: "2",
        title: "Flatbed, black and white, 200 dpi",
        instruction: "Leave the same printed page on the glass.",
        needs: RowNeed::Flatbed,
        mode: RowMode::Prompted,
        minutes: 2,
    },
    ChecklistRow {
        id: "3",
        title: "Autodetect colour: a colour original, then a mono original",
        instruction: "Have one COLOUR page and one BLACK-AND-WHITE page ready; you will be asked for each in turn.",
        needs: RowNeed::Autodetect,
        mode: RowMode::Prompted,
        minutes: 5,
    },
    ChecklistRow {
        id: "4",
        title: "Feeder, every page in the tray, five sheets",
        instruction: "Number five sheets 1 to 5 and load them in the feeder in that order.",
        needs: RowNeed::Feeder,
        mode: RowMode::Prompted,
        minutes: 5,
    },
    ChecklistRow {
        id: "5",
        title: "Feeder, both sides, three double-sided sheets",
        instruction: "Load three sheets printed on BOTH sides, with a different mark on each side.",
        needs: RowNeed::Duplex,
        mode: RowMode::Prompted,
        minutes: 5,
    },
    ChecklistRow {
        id: "6",
        title: "Feeder, stop after two pages, five sheets loaded",
        instruction: "Load FIVE sheets in the feeder. The run asks the scanner for two of them.",
        needs: RowNeed::PageLimit,
        mode: RowMode::Prompted,
        minutes: 4,
    },
    ChecklistRow {
        id: "7",
        title: "Feeder, ten sheets, stopped part-way",
        instruction: "Load about TEN sheets in the feeder. You will press Enter to stop the run part-way through.",
        needs: RowNeed::Feeder,
        mode: RowMode::Prompted,
        minutes: 5,
    },
    ChecklistRow {
        id: "8",
        title: "Feeder empty",
        instruction: "Take ALL paper out of the feeder and leave the tray empty.",
        needs: RowNeed::Feeder,
        mode: RowMode::Prompted,
        minutes: 2,
    },
    ChecklistRow {
        id: "9",
        title: "Paper jam during a feeder run",
        instruction: "Load a few sheets and be ready to cause a misfeed — a folded or badly skewed sheet is the usual way. Do not damage the scanner.",
        needs: RowNeed::Feeder,
        mode: RowMode::Prompted,
        minutes: 4,
    },
    ChecklistRow {
        id: "10",
        title: "Device switched off part-way through a scan",
        instruction: "Be ready to switch the scanner off (or unplug it) while a page is being scanned.",
        needs: RowNeed::AnyDevice,
        mode: RowMode::Prompted,
        minutes: 6,
    },
    ChecklistRow {
        id: "11",
        title: "The device is released when the run ends",
        instruction: "Nothing to do at the scanner; you will be asked to open another scanning program afterwards.",
        needs: RowNeed::AnyDevice,
        mode: RowMode::Automatic,
        minutes: 2,
    },
    ChecklistRow {
        id: "12",
        title: "Flatbed, colour, 600 dpi, A4",
        instruction: "Put a printed page on the glass; A4 if you have one.",
        needs: RowNeed::Flatbed,
        mode: RowMode::Prompted,
        minutes: 3,
    },
    ChecklistRow {
        id: "14",
        title: "A network scanner enumerates and scans",
        instruction: "Run this against a scanner reached over the network (Wi-Fi or Ethernet), with no vendor USB cable in use.",
        needs: RowNeed::Network,
        mode: RowMode::Prompted,
        minutes: 4,
    },
    ChecklistRow {
        id: "16",
        title: "Feeder, both sides, sheet order confirmed page by page",
        instruction: "Number THREE sheets: write 1F on the front of sheet 1 and 1B on its back; write 2F on the front of sheet 2 and LEAVE ITS BACK BLANK; write 3F and 3B on sheet 3. Load all three in the feeder, sheet 1 on top, fronts up.",
        needs: RowNeed::Duplex,
        mode: RowMode::Prompted,
        minutes: 8,
    },
    ChecklistRow {
        id: "17",
        title: "Feeder, one side, sheet order confirmed page by page",
        instruction: "Number THREE sheets 1, 2 and 3 on the front only. Load all three in the feeder, sheet 1 on top, fronts up.",
        needs: RowNeed::Feeder,
        mode: RowMode::Prompted,
        minutes: 5,
    },
];

/// The row for an id, for `--rows`.
pub fn row(id: &str) -> Option<&'static ChecklistRow> {
    ROWS.iter().find(|r| r.id == id)
}

/// Whether a device can pose a row at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Applicability {
    Runnable,
    /// The hardware lacks what the row needs; the reason is the report's.
    Skipped(String),
}

/// Does this device report what the row needs?
///
/// Read from the capability report, never from the device's name: a row
/// skipped because the report says there is no feeder is a fact, and a row
/// skipped because a model number looked consumer-grade is a guess.
pub fn applies(need: RowNeed, caps: &ScannerCapabilities) -> Applicability {
    let has = |id: SourceOptionId| caps.source_options.iter().any(|o| o.id == id);
    let lacking = |what: &str| Applicability::Skipped(format!("this scanner reports no {what}"));
    match need {
        RowNeed::AnyDevice => Applicability::Runnable,
        RowNeed::Flatbed => {
            if has(SourceOptionId::Flatbed) {
                Applicability::Runnable
            } else {
                lacking("flatbed (glass) source")
            }
        }
        RowNeed::Feeder => {
            if has(SourceOptionId::Feeder) {
                Applicability::Runnable
            } else {
                lacking("document feeder")
            }
        }
        RowNeed::Duplex => {
            if has(SourceOptionId::Duplex) {
                Applicability::Runnable
            } else {
                lacking("two-sided (duplex) feeder")
            }
        }
        RowNeed::PageLimit => {
            if !has(SourceOptionId::Feeder) {
                return lacking("document feeder");
            }
            let settable = caps.sources.iter().any(|s| {
                matches!(
                    s.pages,
                    crate::scanner::ControlModel::Choice { .. }
                        | crate::scanner::ControlModel::Span { .. }
                )
            });
            if settable {
                Applicability::Runnable
            } else {
                lacking("page-count setting")
            }
        }
        RowNeed::Autodetect => {
            if caps
                .sources
                .iter()
                .any(|s| s.color_modes.contains(&ColorMode::Auto))
            {
                Applicability::Runnable
            } else {
                lacking("automatic colour detection")
            }
        }
        // Nothing in the WIA report says how a device is attached, so this
        // row is offered and the tester answers. A guess here would close a
        // row that nothing proved.
        RowNeed::Network => Applicability::Runnable,
    }
}

// ── Evidence ────────────────────────────────────────────────────────────────

/// What a staged page's own bytes say about it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PageEvidence {
    /// The staged file's NAME, never its full path — the path names a folder
    /// on the tester's machine and says nothing about the scan.
    pub file: String,
    pub format: String,
    pub bytes: u64,
    pub width_px: Option<u32>,
    pub height_px: Option<u32>,
    pub bits_per_pixel: Option<u16>,
    pub dpi_x: Option<f64>,
    pub dpi_y: Option<f64>,
    pub integrity: String,
    pub content: ContentVerdict,
    /// Aggregate grayscale statistics — five numbers over the whole page,
    /// which is what separates a real scan from a blank or black one. Not
    /// image content and not reversible into any.
    pub histogram: Option<HistogramStats>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentVerdict {
    /// The page carries real ink.
    RealContent,
    /// All but a few stray pixels are one tone.
    NearUniform,
    /// One tone: a blank sheet, a black page, or a transfer that produced
    /// nothing.
    Blank,
    /// No decoder here for this format; the page is reported, not judged.
    Unverifiable,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct HistogramStats {
    pub min: u8,
    pub max: u8,
    pub mean: f64,
    /// The fraction of samples below 200 — ink coverage, near enough.
    pub dark_fraction: f64,
    /// The tonal spread of the middle 99.8% of samples, so a handful of
    /// stray pixels cannot make a blank page look like content.
    pub spread: u16,
}

/// How many samples the histogram takes at most, per page.
const HISTOGRAM_SAMPLE_TARGET: u64 = 1_000_000;

/// Read one staged page back and report what its own bytes say.
pub fn page_evidence(path: &Path) -> PageEvidence {
    let file = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let integrity = match crate::scanner::page_integrity(path) {
        crate::scanner::PageIntegrity::Complete => "complete".to_string(),
        crate::scanner::PageIntegrity::Truncated { declared, actual } => {
            format!("truncated ({actual} of {declared} bytes)")
        }
        crate::scanner::PageIntegrity::Unverifiable => "unverifiable".to_string(),
    };
    let mut evidence = PageEvidence {
        file,
        format: "unknown".to_string(),
        bytes,
        width_px: None,
        height_px: None,
        bits_per_pixel: None,
        dpi_x: None,
        dpi_y: None,
        integrity,
        content: ContentVerdict::Unverifiable,
        histogram: None,
    };
    let mut head = [0u8; 128];
    let Ok(mut file) = std::fs::File::open(path) else {
        return evidence;
    };
    let read = file.read(&mut head).unwrap_or(0);
    let head = &head[..read];
    if let Some(bmp) = bmp_header(head) {
        evidence.format = "bmp".to_string();
        evidence.width_px = Some(bmp.width);
        evidence.height_px = Some(bmp.height);
        evidence.bits_per_pixel = Some(bmp.bits);
        evidence.dpi_x = bmp.dpi_x;
        evidence.dpi_y = bmp.dpi_y;
        if let Some(stats) = bmp_histogram(&mut file, &bmp) {
            evidence.content = verdict(&stats);
            evidence.histogram = Some(stats);
        }
    } else if let Some(png) = png_header(head) {
        evidence.format = "png".to_string();
        evidence.width_px = Some(png.width);
        evidence.height_px = Some(png.height);
        evidence.bits_per_pixel = Some(png.bits);
        evidence.dpi_x = png.dpi_x;
        evidence.dpi_y = png.dpi_y;
    } else if head.starts_with(b"II*\0") || head.starts_with(b"MM\0*") {
        evidence.format = "tiff".to_string();
    }
    evidence
}

/// Blank / near-uniform / real, on the same thresholds the checklist's own
/// verification probe used: a page whose whole tonal range is under eight
/// levels is one tone however that happened.
pub fn verdict(stats: &HistogramStats) -> ContentVerdict {
    if stats.max.saturating_sub(stats.min) < 8 {
        ContentVerdict::Blank
    } else if stats.spread < 8 {
        ContentVerdict::NearUniform
    } else {
        ContentVerdict::RealContent
    }
}

#[derive(Debug, Clone)]
struct BmpHeader {
    width: u32,
    height: u32,
    bits: u16,
    dpi_x: Option<f64>,
    dpi_y: Option<f64>,
    pixel_offset: u64,
    stride: u64,
    /// Bottom-up rows are the format's default; a negative height is top-down.
    palette: Option<Vec<[u8; 3]>>,
    palette_offset: u64,
    palette_len: u32,
    compression: u32,
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn i32_at(bytes: &[u8], at: usize) -> i32 {
    i32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn bmp_header(head: &[u8]) -> Option<BmpHeader> {
    if head.len() < 54 || &head[0..2] != b"BM" {
        return None;
    }
    let pixel_offset = u32_at(head, 10) as u64;
    let dib_size = u32_at(head, 14) as u64;
    let width = i32_at(head, 18);
    let height = i32_at(head, 22);
    let bits = u16::from_le_bytes([head[28], head[29]]);
    let compression = u32_at(head, 30);
    if width <= 0 || height == 0 || bits == 0 {
        return None;
    }
    // Pixels per metre, the only resolution a BMP carries. Zero means the
    // encoder wrote none, which is a different thing from zero dpi.
    let ppm = |at: usize| -> Option<f64> {
        let v = i32_at(head, at);
        (v > 0).then_some(v as f64 * 0.0254)
    };
    let width = width as u32;
    let stride = (width as u64 * bits as u64).div_ceil(32) * 4;
    let palette_len = if bits <= 8 {
        let used = u32_at(head, 46);
        if used == 0 {
            1u32 << bits
        } else {
            used
        }
    } else {
        0
    };
    Some(BmpHeader {
        width,
        height: height.unsigned_abs(),
        bits,
        dpi_x: ppm(38),
        dpi_y: ppm(42),
        pixel_offset,
        stride,
        palette: None,
        palette_offset: 14 + dib_size,
        palette_len,
        compression,
    })
}

/// The grayscale histogram of an uncompressed BMP, sampled.
///
/// Sampled rather than exhaustive because an uncompressed 600-dpi colour A3
/// page is roughly 400 MB and the verdict does not need every pixel: the
/// question is whether the page is one tone, and a million samples answers it.
fn bmp_histogram(file: &mut std::fs::File, head: &BmpHeader) -> Option<HistogramStats> {
    if head.compression != 0 {
        return None;
    }
    let mut header = head.clone();
    if header.palette_len > 0 {
        header.palette = read_palette(file, &header);
        header.palette.as_ref()?;
    }
    let pixels = header.width as u64 * header.height as u64;
    let step = ((pixels / HISTOGRAM_SAMPLE_TARGET.max(1)) as f64).sqrt().ceil() as u64;
    let step = step.max(1);
    let mut counts = [0u64; 256];
    let mut row = vec![0u8; header.stride as usize];
    let mut y = 0u64;
    while y < header.height as u64 {
        let at = header.pixel_offset + y * header.stride;
        if file.seek(SeekFrom::Start(at)).is_err() {
            break;
        }
        if file.read_exact(&mut row).is_err() {
            break;
        }
        let mut x = 0u64;
        while x < header.width as u64 {
            if let Some(level) = sample(&row, x as usize, &header) {
                counts[level as usize] += 1;
            }
            x += step;
        }
        y += step;
    }
    stats(&counts)
}

fn read_palette(file: &mut std::fs::File, head: &BmpHeader) -> Option<Vec<[u8; 3]>> {
    let len = head.palette_len.min(256) as usize;
    let mut raw = vec![0u8; len * 4];
    file.seek(SeekFrom::Start(head.palette_offset)).ok()?;
    file.read_exact(&mut raw).ok()?;
    Some(
        raw.chunks_exact(4)
            .map(|e| [e[2], e[1], e[0]])
            .collect::<Vec<_>>(),
    )
}

/// One pixel's luminance, in the BMP's own channel order (blue first).
fn sample(row: &[u8], x: usize, head: &BmpHeader) -> Option<u8> {
    let luma = |r: u8, g: u8, b: u8| -> u8 {
        ((299 * r as u32 + 587 * g as u32 + 114 * b as u32) / 1000).min(255) as u8
    };
    match head.bits {
        24 | 32 => {
            let per = (head.bits / 8) as usize;
            let at = x * per;
            let px = row.get(at..at + 3)?;
            Some(luma(px[2], px[1], px[0]))
        }
        8 => {
            let index = *row.get(x)? as usize;
            match &head.palette {
                Some(p) => p.get(index).map(|c| luma(c[0], c[1], c[2])),
                None => Some(index as u8),
            }
        }
        4 | 1 => {
            let per_byte = (8 / head.bits) as usize;
            let byte = *row.get(x / per_byte)?;
            let shift = 8 - head.bits as usize * (x % per_byte + 1);
            let mask = (1u16 << head.bits) - 1;
            let index = ((byte as u16 >> shift) & mask) as usize;
            match &head.palette {
                Some(p) => p.get(index).map(|c| luma(c[0], c[1], c[2])),
                // A palette-less 1-bit image is 0 = black, 1 = white.
                None => Some(if index == 0 { 0 } else { 255 }),
            }
        }
        _ => None,
    }
}

/// Min, max, mean, ink coverage and the 99.8% spread of a sampled histogram.
pub fn stats(counts: &[u64; 256]) -> Option<HistogramStats> {
    let total: u64 = counts.iter().sum();
    if total == 0 {
        return None;
    }
    let min = counts.iter().position(|c| *c > 0)? as u8;
    let max = counts.iter().rposition(|c| *c > 0)? as u8;
    let sum: u64 = counts
        .iter()
        .enumerate()
        .map(|(i, c)| i as u64 * *c)
        .sum();
    let dark: u64 = counts.iter().take(200).sum();
    let cut = (total as f64 * 0.001).ceil() as u64;
    let mut run = 0u64;
    let mut low = 0usize;
    for (i, c) in counts.iter().enumerate() {
        run += *c;
        if run >= cut {
            low = i;
            break;
        }
    }
    run = 0;
    let mut high = 255usize;
    for i in (0..256).rev() {
        run += counts[i];
        if run >= cut {
            high = i;
            break;
        }
    }
    Some(HistogramStats {
        min,
        max,
        mean: sum as f64 / total as f64,
        dark_fraction: dark as f64 / total as f64,
        spread: high.saturating_sub(low) as u16,
    })
}

struct PngHeader {
    width: u32,
    height: u32,
    bits: u16,
    dpi_x: Option<f64>,
    dpi_y: Option<f64>,
}

fn png_header(head: &[u8]) -> Option<PngHeader> {
    const SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if head.len() < 33 || !head.starts_with(SIGNATURE) || &head[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes([head[16], head[17], head[18], head[19]]);
    let height = u32::from_be_bytes([head[20], head[21], head[22], head[23]]);
    let depth = head[24] as u16;
    let channels = match head[25] {
        0 => 1,
        2 => 3,
        3 => 1,
        4 => 2,
        6 => 4,
        _ => return None,
    };
    // pHYs, when it is early enough to be in the bytes already read.
    let mut dpi = (None, None);
    let mut at = 8usize;
    while at + 8 <= head.len() {
        let len = u32::from_be_bytes([head[at], head[at + 1], head[at + 2], head[at + 3]]) as usize;
        let kind = &head[at + 4..at + 8];
        if kind == b"pHYs" && at + 8 + 9 <= head.len() {
            let body = &head[at + 8..at + 17];
            if body[8] == 1 {
                let x = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                let y = u32::from_be_bytes([body[4], body[5], body[6], body[7]]);
                dpi = (
                    (x > 0).then_some(x as f64 * 0.0254),
                    (y > 0).then_some(y as f64 * 0.0254),
                );
            }
            break;
        }
        if kind == b"IDAT" {
            break;
        }
        at += 12 + len;
    }
    Some(PngHeader {
        width,
        height,
        bits: depth * channels,
        dpi_x: dpi.0,
        dpi_y: dpi.1,
    })
}

// ── Judging a row ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowStatus {
    Pass,
    Fail,
    /// The hardware cannot pose the row.
    Skipped,
    /// The tester chose not to run it.
    NotRun,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RowVerdict {
    pub status: RowStatus,
    pub notes: Vec<String>,
}

impl RowVerdict {
    fn pass(note: String) -> Self {
        Self {
            status: RowStatus::Pass,
            notes: vec![note],
        }
    }
    fn fail(note: String) -> Self {
        Self {
            status: RowStatus::Fail,
            notes: vec![note],
        }
    }
}

/// How many pages a row expects back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CountRule {
    Exactly(usize),
    AtLeast(usize),
    Between(usize, usize),
}

impl CountRule {
    fn holds(self, n: usize) -> bool {
        match self {
            CountRule::Exactly(k) => n == k,
            CountRule::AtLeast(k) => n >= k,
            CountRule::Between(lo, hi) => n >= lo && n <= hi,
        }
    }
    fn describe(self) -> String {
        match self {
            CountRule::Exactly(k) => format!("exactly {k}"),
            CountRule::AtLeast(k) => format!("at least {k}"),
            CountRule::Between(lo, hi) => format!("between {lo} and {hi}"),
        }
    }
}

/// What a row asked the device for, and therefore what its pages must show.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageExpectation {
    pub count: CountRule,
    /// The requested resolution; the pages' own headers must agree within a
    /// dpi. A driver that clamped the request reports its own value back and
    /// this is what catches the disagreement.
    pub dpi: Option<i32>,
    /// The requested paper size, checked against pixels ÷ dpi. A shortfall
    /// inside a percent is the bed clamp, which is the design working.
    pub paper: Option<PaperSize>,
    /// An upper bound on bit depth, for the black-and-white row: one bit per
    /// component makes a colour fringe impossible rather than merely absent.
    pub max_bits_per_pixel: Option<u16>,
    pub require_content: bool,
}

impl PageExpectation {
    fn new(count: CountRule) -> Self {
        Self {
            count,
            dpi: None,
            paper: None,
            max_bits_per_pixel: None,
            require_content: true,
        }
    }
}

/// The verdict on a row that expected pages back.
///
/// A pure function over the evidence, so every rule below is posed in a test
/// without a scanner — the `judge_transfer` seam, one layer up.
pub fn judge_pages(expect: &PageExpectation, pages: &[PageEvidence]) -> RowVerdict {
    let mut notes = Vec::new();
    let mut ok = true;
    if !expect.count.holds(pages.len()) {
        ok = false;
        notes.push(format!(
            "expected {} page(s), got {}",
            expect.count.describe(),
            pages.len()
        ));
    } else {
        notes.push(format!("{} page(s) came back", pages.len()));
    }
    for page in pages {
        if page.integrity.starts_with("truncated") {
            ok = false;
            notes.push(format!("{}: {}", page.file, page.integrity));
        }
        if expect.require_content {
            match page.content {
                ContentVerdict::RealContent => {}
                ContentVerdict::Unverifiable => notes.push(format!(
                    "{}: {} carries no histogram this runner can read; judge it by eye",
                    page.file, page.format
                )),
                other => {
                    ok = false;
                    notes.push(format!("{}: the page is {:?}", page.file, other));
                }
            }
        }
        if let (Some(want), Some(bits)) = (expect.max_bits_per_pixel, page.bits_per_pixel) {
            if bits > want {
                ok = false;
                notes.push(format!(
                    "{}: {bits} bits per pixel, more than the {want} this row asked for",
                    page.file
                ));
            }
        }
        if let Some(want) = expect.dpi {
            match page.dpi_x {
                Some(actual) if (actual - want as f64).abs() <= 1.0 => {}
                Some(actual) => {
                    ok = false;
                    notes.push(format!(
                        "{}: the image reports {actual:.1} dpi, not the {want} dpi requested",
                        page.file
                    ));
                }
                None => notes.push(format!(
                    "{}: the image carries no resolution of its own",
                    page.file
                )),
            }
        }
        if let (Some(paper), Some(dpi)) = (expect.paper, page.dpi_x.or(expect.dpi.map(f64::from))) {
            if let (Some((w_in, h_in)), Some(w_px), Some(h_px)) =
                (paper.dimensions_in(), page.width_px, page.height_px)
            {
                for (axis, want_in, got_px) in
                    [("width", w_in, w_px as f64), ("height", h_in, h_px as f64)]
                {
                    let want_px = want_in * dpi;
                    let off = got_px - want_px;
                    if off.abs() > (want_px * 0.01).max(2.0) {
                        ok = false;
                        notes.push(format!(
                            "{}: {axis} is {got_px:.0} px where {want_px:.0} px was asked for",
                            page.file
                        ));
                    } else if off < -2.0 {
                        notes.push(format!(
                            "{}: {axis} is {} px short of the sheet — the scanner's own bed limit",
                            page.file,
                            (-off).round()
                        ));
                    }
                }
            }
        }
    }
    RowVerdict {
        status: if ok { RowStatus::Pass } else { RowStatus::Fail },
        notes,
    }
}

/// The verdict on a row whose whole point is a named refusal.
///
/// The accepted keys are a SET rather than one key: an empty feeder reaches
/// `scan.feederEmpty` on one driver and `scan.needsAttention` on another, and
/// both are the row passing. What fails the row is a hang, a success, or the
/// generic hex-carrying fallback — the last being exactly the "not a hex code"
/// the checklist asks about.
pub fn judge_refusal(
    accepted: &[&str],
    outcome: &Result<ScanResult, ScanRefusal>,
    elapsed_secs: u64,
    bound_secs: u64,
) -> RowVerdict {
    match outcome {
        Ok(result) => RowVerdict::fail(format!(
            "the run reported success with {} page(s); a named refusal was expected",
            result.pages.len()
        )),
        Err(refusal) if accepted.contains(&refusal.key) => {
            let mut verdict = RowVerdict::pass(format!(
                "refused by name: {} (\"{}\") after {elapsed_secs}s",
                refusal.key, refusal.message
            ));
            if elapsed_secs > bound_secs {
                verdict.status = RowStatus::Fail;
                verdict
                    .notes
                    .push(format!("that took longer than the {bound_secs}s this row allows"));
            }
            verdict
        }
        Err(refusal) => {
            let code = refusal
                .code
                .as_deref()
                .map(|c| format!(" [{c}]"))
                .unwrap_or_default();
            RowVerdict::fail(format!(
                "refused with {}{code} (\"{}\"), which is not one of the expected refusals: {}",
                refusal.key,
                refusal.message,
                accepted.join(", ")
            ))
        }
    }
}

/// What a sheet-order row expects back, and what the tester may answer.
///
/// The duplex plan leaves sheet 2's back blank on purpose: a feeder that
/// drops blank sides looks correct on three fully printed sheets and is
/// caught only by a batch that contains one.
pub struct OrderPlan {
    /// The marks, in the order the pages must come back.
    pub expected: &'static [&'static str],
    /// Every answer the tester may give for one page.
    pub vocabulary: &'static [&'static str],
}

/// Three sheets, front and back, sheet 2's back blank.
pub const DUPLEX_ORDER: OrderPlan = OrderPlan {
    expected: &["1f", "1b", "2f", "blank", "3f", "3b"],
    vocabulary: &["1f", "1b", "2f", "2b", "3f", "3b", "blank"],
};

/// Three numbered sheets, fronts only.
pub const SIMPLEX_ORDER: OrderPlan = OrderPlan {
    expected: &["1", "2", "3"],
    vocabulary: &["1", "2", "3", "blank"],
};

/// The sequence with every pair swapped: what a feeder that reads the back
/// before the front produces.
fn backs_first(expected: &[&str]) -> Vec<String> {
    expected
        .chunks(2)
        .flat_map(|pair| pair.iter().rev().map(|s| s.to_string()))
        .collect()
}

/// Is `claimed` `whole` with zero or more entries left out, in order?
fn is_subsequence(claimed: &[String], whole: &[&str]) -> bool {
    let mut it = whole.iter();
    claimed
        .iter()
        .all(|want| it.any(|have| have.eq_ignore_ascii_case(want)))
}

/// The verdict on a sheet-order row: what the tester says each captured page
/// shows, against what the sheets they loaded must produce.
///
/// A mismatch is NAMED where the shape is a known feeder bug — reversed
/// backs, dropped blanks, only one side per sheet, a reversed batch — because
/// "the order was wrong" sends a report back that nobody can act on, and the
/// four shapes are separate bugs with separate fixes.
pub fn judge_order(plan: &OrderPlan, claimed: &[String]) -> RowVerdict {
    let expected = plan.expected;
    let shown = |seq: &[String]| seq.join(", ");
    let same = |a: &[String], b: &[String]| {
        a.len() == b.len()
            && a.iter()
                .zip(b.iter())
                .all(|(x, y)| x.eq_ignore_ascii_case(y))
    };
    let as_owned = |seq: &[&str]| seq.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let expected_owned = as_owned(expected);

    if same(claimed, &expected_owned) {
        return RowVerdict::pass(format!(
            "the pages came back in sheet order: {}",
            shown(&expected_owned)
        ));
    }

    let mut notes = vec![
        format!("expected: {}", shown(&expected_owned)),
        format!("the tester read back: {}", shown(claimed)),
    ];
    if claimed.len() != expected.len() {
        notes.push(format!(
            "{} page(s) came back where {} were expected",
            claimed.len(),
            expected.len()
        ));
    }

    let reversed: Vec<String> = expected_owned.iter().rev().cloned().collect();
    let without_blanks: Vec<String> = expected_owned
        .iter()
        .filter(|m| !m.eq_ignore_ascii_case("blank"))
        .cloned()
        .collect();
    let fronts: Vec<String> = expected_owned
        .iter()
        .step_by(2)
        .cloned()
        .collect();

    let named = if same(claimed, &reversed) {
        Some("REVERSED BATCH: the sheets came back last-to-first".to_string())
    } else if expected.len() % 2 == 0 && same(claimed, &backs_first(expected)) {
        Some("REVERSED BACKS: each sheet's back came back before its front".to_string())
    } else if expected_owned.len() != without_blanks.len() && same(claimed, &without_blanks) {
        Some("DROPPED BLANKS: the blank side was left out instead of scanned".to_string())
    } else if expected.len() % 2 == 0 && same(claimed, &fronts) {
        Some("ONE SIDE PER SHEET: only the fronts came back, so the run scanned simplex".to_string())
    } else if is_subsequence(claimed, expected) {
        let missing: Vec<String> = expected_owned
            .iter()
            .filter(|m| !claimed.iter().any(|c| c.eq_ignore_ascii_case(m)))
            .cloned()
            .collect();
        Some(format!("DROPPED PAGES: {} never came back", missing.join(", ")))
    } else {
        None
    };
    notes.push(named.unwrap_or_else(|| {
        "the order matches no known feeder fault; the two sequences above are the evidence"
            .to_string()
    }));
    RowVerdict {
        status: RowStatus::Fail,
        notes,
    }
}

/// The verdict on row 9: a jam is a clean partial, never a corrupt success.
///
/// Two shapes pass. A jam with nothing whole behind it refuses BY NAME, which
/// is the same bar row 8 sets. A jam part-way through a batch comes back as a
/// result whose `interrupted` names the jam and whose pages are the sheets
/// that finished — every one of them integrity-passing, because the runner
/// judges the staged pages. What fails is a silent success (a jam the run
/// never mentions), a hex-carrying `scan.failed`, and any page that came back
/// torn.
pub fn judge_jam(
    accepted: &[&str],
    outcome: &Result<ScanResult, ScanRefusal>,
    pages: &[PageEvidence],
    elapsed_secs: u64,
    bound_secs: u64,
) -> RowVerdict {
    let Ok(result) = outcome else {
        return judge_refusal(accepted, outcome, elapsed_secs, bound_secs);
    };
    let Some(fault) = &result.interrupted else {
        return RowVerdict::fail(format!(
            "the run reported a clean success with {} page(s); a jam must be named",
            result.pages.len()
        ));
    };
    if !accepted.contains(&fault.key) {
        let code = fault
            .code
            .as_deref()
            .map(|c| format!(" [{c}]"))
            .unwrap_or_default();
        return RowVerdict::fail(format!(
            "the run stopped on {}{code} (\"{}\"), which is not one of the expected feeder faults: {}",
            fault.key,
            fault.message,
            accepted.join(", ")
        ));
    }
    let mut verdict = RowVerdict::pass(format!(
        "the batch stopped on {} (\"{}\") and kept the {} page(s) that finished first",
        fault.key,
        fault.message,
        pages.len()
    ));
    if pages.is_empty() {
        verdict.status = RowStatus::Fail;
        verdict.notes.push(
            "the run reported success with no pages at all; that is a refusal, not a partial"
                .to_string(),
        );
    }
    for page in pages {
        if page.integrity.starts_with("truncated") {
            verdict.status = RowStatus::Fail;
            verdict.notes.push(format!(
                "{}: {} — a page the jam tore must never be offered",
                page.file, page.integrity
            ));
        }
    }
    verdict
}

/// The verdict on row 7: a run stopped part-way offers what completed.
pub fn judge_cancel(loaded: usize, result: &ScanResult, pages: &[PageEvidence]) -> RowVerdict {
    let mut verdict = judge_pages(&PageExpectation::new(CountRule::Between(1, loaded)), pages);
    if !result.cancelled {
        verdict.status = RowStatus::Fail;
        verdict
            .notes
            .push("the run did not report that it was stopped".to_string());
    }
    if pages.len() >= loaded {
        verdict.status = RowStatus::Fail;
        verdict.notes.push(format!(
            "every one of the {loaded} sheet(s) was scanned, so nothing was actually stopped part-way"
        ));
    }
    verdict
}

// ── The report ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct RefusalRecord {
    pub key: String,
    pub message: String,
    pub code: Option<String>,
}

impl From<&ScanRefusal> for RefusalRecord {
    fn from(r: &ScanRefusal) -> Self {
        Self {
            key: r.key.to_string(),
            message: r.message.clone(),
            code: r.code.clone(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TesterAnswer {
    pub question: String,
    pub answer: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RowRecord {
    pub id: String,
    pub title: String,
    pub status: RowStatus,
    pub notes: Vec<String>,
    pub settings: Option<serde_json::Value>,
    pub pages: Vec<PageEvidence>,
    pub refusal: Option<RefusalRecord>,
    /// The feeder fault a partial batch stopped on. Distinct from `refusal`:
    /// this run produced pages and they are in `pages`.
    pub interrupted: Option<RefusalRecord>,
    /// A sheet-order row's marks, in the order they had to come back.
    pub expected_order: Vec<String>,
    /// What the tester said each captured page actually shows.
    pub claimed_order: Vec<String>,
    pub adjustments: Vec<serde_json::Value>,
    pub tester_answers: Vec<TesterAnswer>,
    pub elapsed_secs: u64,
    pub attached_scans: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Report {
    pub schema: u32,
    pub tool: String,
    pub app_version: String,
    pub windows_build: String,
    pub started_unix_secs: u64,
    pub device_id: String,
    pub device_name: String,
    /// The device's whole capability report: sources, categories, every
    /// property's kind and legal values. Driver-shaped data, no document
    /// content.
    pub capabilities: serde_json::Value,
    pub rows: Vec<RowRecord>,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub not_run: usize,
    pub privacy: String,
}

impl Report {
    fn tally(&mut self) {
        self.passed = self.count(RowStatus::Pass);
        self.failed = self.count(RowStatus::Fail);
        self.skipped = self.count(RowStatus::Skipped);
        self.not_run = self.count(RowStatus::NotRun);
    }
    fn count(&self, status: RowStatus) -> usize {
        self.rows.iter().filter(|r| r.status == status).count()
    }

    /// The human-readable rendering, for a tester who wants to read what they
    /// are about to send before they send it.
    pub fn to_text(&self) -> String {
        let mut out = String::new();
        let line = |out: &mut String, s: &str| {
            out.push_str(s);
            out.push('\n');
        };
        line(&mut out, "Spectra PDF — scanner checklist report");
        line(&mut out, "======================================");
        line(&mut out, &format!("Tool          {}", self.tool));
        line(&mut out, &format!("App version   {}", self.app_version));
        line(&mut out, &format!("Windows build {}", self.windows_build));
        line(&mut out, &format!("Scanner       {}", self.device_name));
        line(&mut out, &format!("Device id     {}", self.device_id));
        line(
            &mut out,
            &format!(
                "Result        {} passed · {} failed · {} skipped (hardware) · {} not run",
                self.passed, self.failed, self.skipped, self.not_run
            ),
        );
        line(&mut out, "");
        for row in &self.rows {
            line(
                &mut out,
                &format!(
                    "Row {} — {} — {}",
                    row.id,
                    row.title,
                    match row.status {
                        RowStatus::Pass => "PASS",
                        RowStatus::Fail => "FAIL",
                        RowStatus::Skipped => "SKIPPED (this scanner cannot do it)",
                        RowStatus::NotRun => "NOT RUN",
                    }
                ),
            );
            for note in &row.notes {
                line(&mut out, &format!("    - {note}"));
            }
            for (label, record) in [("refusal", &row.refusal), ("stopped on", &row.interrupted)] {
                if let Some(refusal) = record {
                    line(
                        &mut out,
                        &format!(
                            "    {label}: {} \"{}\"{}",
                            refusal.key,
                            refusal.message,
                            refusal
                                .code
                                .as_deref()
                                .map(|c| format!(" [{c}]"))
                                .unwrap_or_default()
                        ),
                    );
                }
            }
            if !row.expected_order.is_empty() {
                line(
                    &mut out,
                    &format!("    sheet order expected: {}", row.expected_order.join(", ")),
                );
                line(
                    &mut out,
                    &format!("    sheet order read back: {}", row.claimed_order.join(", ")),
                );
            }
            for page in &row.pages {
                let dpi = page
                    .dpi_x
                    .map(|d| format!("{d:.1} dpi"))
                    .unwrap_or_else(|| "no dpi in header".to_string());
                line(
                    &mut out,
                    &format!(
                        "    page {}: {} {}×{} px, {} bpp, {dpi}, {}, {:?}",
                        page.file,
                        page.format,
                        page.width_px.unwrap_or(0),
                        page.height_px.unwrap_or(0),
                        page.bits_per_pixel.unwrap_or(0),
                        page.integrity,
                        page.content
                    ),
                );
                if let Some(h) = &page.histogram {
                    line(
                        &mut out,
                        &format!(
                            "        tones min {} max {} mean {:.1} ink {:.2}% spread {}",
                            h.min,
                            h.max,
                            h.mean,
                            h.dark_fraction * 100.0,
                            h.spread
                        ),
                    );
                }
            }
            for answer in &row.tester_answers {
                line(&mut out, &format!("    Q {}", answer.question));
                line(&mut out, &format!("    A {}", answer.answer));
            }
            line(&mut out, "");
        }
        line(&mut out, "Privacy");
        line(&mut out, "-------");
        line(&mut out, &self.privacy);
        out
    }
}

// ── Talking to the tester ───────────────────────────────────────────────────

/// The runner's console, behind a trait so a test can script the answers.
pub trait Console {
    fn say(&self, line: &str);
    /// One line of input. `Some("")` is Enter; `None` is end-of-input or an
    /// unreadable stdin, which no amount of re-prompting can turn into an
    /// answer — every prompt treats it as give up, never as a retry.
    fn ask(&self, prompt: &str) -> Option<String>;
}

/// Why a row that needed an answer did not get one.
pub const NO_CONSOLE: &str = "no interactive console";

/// How many unusable answers one question takes before it gives up. A piped
/// stdin can supply an endless stream of answers that are neither y nor n.
const MAX_INVALID: u32 = 3;

pub struct StdioConsole;

impl Console for StdioConsole {
    fn say(&self, line: &str) {
        println!("{line}");
    }
    fn ask(&self, prompt: &str) -> Option<String> {
        print!("{prompt}");
        let _ = std::io::stdout().flush();
        let mut answer = String::new();
        match std::io::stdin().read_line(&mut answer) {
            Ok(0) | Err(_) => None,
            Ok(_) => Some(answer.trim().to_string()),
        }
    }
}

fn yes(console: &dyn Console, question: &str) -> Option<bool> {
    let mut invalid = 0;
    loop {
        let answer = console.ask(&format!("{question} [y/n] "))?;
        match answer.to_ascii_lowercase().as_str() {
            "y" | "yes" => return Some(true),
            "n" | "no" => return Some(false),
            _ => {
                invalid += 1;
                if invalid >= MAX_INVALID {
                    console.say("No usable answer; giving up on this question.");
                    return None;
                }
                console.say("Please answer y or n.");
            }
        }
    }
}

fn enter(console: &dyn Console, what: &str) -> Option<()> {
    console.ask(&format!("{what} Press Enter when ready. "))?;
    Some(())
}

/// A row that asked the tester something and got no answer at all.
fn abandoned(record: &mut RowRecord) {
    record.status = RowStatus::Skipped;
    record.notes.push(NO_CONSOLE.to_string());
}

// ── The run ─────────────────────────────────────────────────────────────────

/// What the CLI arm hands the runner.
pub struct Options {
    pub device: Option<String>,
    /// Row ids to run; empty runs every applicable row.
    pub rows: Vec<String>,
    /// Where the two report files go. The directory must exist.
    pub out: PathBuf,
    /// Copy the staged pages beside the report. Off by default: a scan is the
    /// tester's document, and a report is diagnosable without it.
    pub attach_scans: bool,
}

/// The row table as plain text, for `--list` and for the tester guide.
pub fn list_rows() -> String {
    let mut out = String::from(
        "Row  Needs                     Time  What it checks\n\
         ---  ------------------------  ----  ---------------------------------------------\n",
    );
    for row in ROWS {
        out.push_str(&format!(
            "{:<4} {:<25} {:<5} {}\n",
            row.id,
            match row.needs {
                RowNeed::Flatbed => "a flatbed (glass)",
                RowNeed::Feeder => "a document feeder",
                RowNeed::Duplex => "a two-sided feeder",
                RowNeed::PageLimit => "a feeder + page count",
                RowNeed::Autodetect => "automatic colour",
                RowNeed::Network => "a network scanner",
                RowNeed::AnyDevice => "any scanner",
            },
            format!("{}m", row.minutes),
            row.title
        ));
    }
    out.push_str(&format!(
        "\nTotal, on a scanner that can pose every row: about {} minutes.\n",
        ROWS.iter().map(|r| r.minutes).sum::<u32>()
    ));
    out
}

/// Run the checklist and return the report.
pub fn run(options: &Options, console: &dyn Console) -> Result<Report, String> {
    let sessions = ScannerSessions::new();
    let device = resolve_device(options.device.as_deref(), console)?;
    let capabilities = sessions.capabilities(&device).map_err(|e| e.to_string())?;

    console.say("");
    console.say(&format!("Scanner: {}", capabilities.device_name));
    console.say(&format!(
        "Sources: {}",
        capabilities
            .source_options
            .iter()
            .map(|o| format!("{:?}", o.id))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    console.say("");
    console.say(
        "Rows this scanner cannot pose are marked SKIPPED, which is a result, not a failure.",
    );
    console.say("Nothing is sent anywhere: the report is written to a file you choose to send.");
    console.say("");

    let mut report = Report {
        schema: REPORT_SCHEMA,
        tool: "spectrapdf scan-test".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        windows_build: windows_build(),
        started_unix_secs: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        device_id: capabilities.device_id.clone(),
        device_name: capabilities.device_name.clone(),
        capabilities: serde_json::to_value(&capabilities).unwrap_or(serde_json::Value::Null),
        rows: Vec::new(),
        passed: 0,
        failed: 0,
        skipped: 0,
        not_run: 0,
        privacy: PRIVACY_NOTE.to_string(),
    };

    for row in ROWS {
        if !options.rows.is_empty() && !options.rows.iter().any(|r| r == row.id) {
            continue;
        }
        let mut record = RowRecord {
            id: row.id.to_string(),
            title: row.title.to_string(),
            status: RowStatus::NotRun,
            notes: Vec::new(),
            settings: None,
            pages: Vec::new(),
            refusal: None,
            interrupted: None,
            expected_order: Vec::new(),
            claimed_order: Vec::new(),
            adjustments: Vec::new(),
            tester_answers: Vec::new(),
            elapsed_secs: 0,
            attached_scans: Vec::new(),
        };
        if let Applicability::Skipped(why) = applies(row.needs, &capabilities) {
            record.status = RowStatus::Skipped;
            record.notes.push(why.clone());
            console.say(&format!("Row {} — {} — SKIPPED: {why}", row.id, row.title));
            report.rows.push(record);
            continue;
        }
        console.say("");
        console.say(&format!("Row {} — {}", row.id, row.title));
        console.say(&format!("  About {} minutes. {}", row.minutes, row.instruction));
        match yes(console, "  Run this row now?") {
            Some(true) => {}
            Some(false) => {
                record.notes.push("the tester skipped this row".to_string());
                console.say("  Skipped for now.");
                report.rows.push(record);
                continue;
            }
            None => {
                abandoned(&mut record);
                console.say(&format!("  Skipped: {NO_CONSOLE}."));
                report.rows.push(record);
                continue;
            }
        }
        let started = Instant::now();
        run_row(
            row,
            &capabilities,
            &sessions,
            options,
            console,
            &mut record,
        );
        record.elapsed_secs = started.elapsed().as_secs();
        console.say(&format!("  → {:?}", record.status));
        for note in &record.notes {
            console.say(&format!("    {note}"));
        }
        report.rows.push(record);
    }

    sessions.close(&device);
    report.tally();
    Ok(report)
}

/// Which device the checklist runs against.
///
/// The headless rule (`cli.rs`'s `choose_scan_device`) does not apply here:
/// the tester is standing at the machine, so several scanners is a question
/// to ask rather than a refusal.
fn resolve_device(requested: Option<&str>, console: &dyn Console) -> Result<String, String> {
    if let Some(id) = requested {
        return Ok(id.to_string());
    }
    let list = crate::scanner::enumerate(None).map_err(|e| e.to_string())?;
    match list.scanners.len() {
        0 => Err("No scanners found. Check that the scanner is switched on and connected, then run this again.".to_string()),
        1 => Ok(list.scanners[0].id.clone()),
        _ => {
            console.say("Several scanners are attached:");
            for (i, device) in list.scanners.iter().enumerate() {
                console.say(&format!("  {}) {}", i + 1, device.name));
            }
            let mut invalid = 0;
            loop {
                let Some(answer) = console.ask("Which one is this run for? ") else {
                    return Err(format!(
                        "Several scanners are attached and there is {NO_CONSOLE} to choose one. Re-run with --device."
                    ));
                };
                match answer.trim().parse::<usize>() {
                    Ok(n) if n >= 1 && n <= list.scanners.len() => {
                        return Ok(list.scanners[n - 1].id.clone())
                    }
                    _ => {
                        invalid += 1;
                        if invalid >= MAX_INVALID {
                            return Err(format!(
                                "No usable answer for which scanner to use ({NO_CONSOLE}). Re-run with --device."
                            ));
                        }
                        console.say("Please type one of the numbers above.");
                    }
                }
            }
        }
    }
}

fn source(caps: &ScannerCapabilities, id: SourceOptionId) -> Option<&ScanSourceOption> {
    caps.source_options.iter().find(|o| o.id == id)
}

fn settings_for(
    caps: &ScannerCapabilities,
    id: SourceOptionId,
    color: ColorMode,
    dpi: i32,
    paper: PaperSize,
    pages: Option<i32>,
) -> Option<ScanSettings> {
    let option = source(caps, id)?;
    Some(ScanSettings {
        item_name: Some(option.item_name.clone()),
        dpi: Some(dpi),
        color_mode: Some(color),
        paper: Some(paper),
        pages: pages.filter(|_| option.feeds),
        document_handling: option.document_handling,
        brightness: None,
        contrast: None,
    })
}

/// One acquisition, with its scratch swept whatever happened.
fn acquire(
    sessions: &ScannerSessions,
    device: &str,
    settings: ScanSettings,
    console: &dyn Console,
    options: &Options,
    record: &mut RowRecord,
    stop_when_told: bool,
) -> Result<ScanResult, ScanRefusal> {
    record.settings = serde_json::to_value(SettingsRecord::from(&settings)).ok();
    let scratch = crate::scanner::new_scan_scratch()?;
    // The sink cannot carry the console: it is called from the scan thread and
    // must be Send + Sync, which a `&dyn Console` is not.
    let sink: crate::scanner::EventSink = Box::new(|event| {
        if let ScanEvent::PageFinished { index, .. } = event {
            println!("    page {} scanned", index + 1);
        }
    });

    let staging = scratch.clone();
    let outcome = std::thread::scope(|scope| {
        let run = scope.spawn(move || sessions.acquire(device, settings, staging, sink));
        if stop_when_told {
            enter(
                console,
                "  Let a few sheets go through, then stop the run.",
            );
            sessions.cancel(device);
        }
        run.join().unwrap_or_else(|_| {
            Err(ScanRefusal {
                key: "scan.failed",
                message: "The scan did not finish.".to_string(),
                code: None,
                folder: None,
            })
        })
    });

    match &outcome {
        Ok(result) => {
            record.pages = result.pages.iter().map(|p| page_evidence(Path::new(p))).collect();
            record.interrupted = result.interrupted.as_ref().map(RefusalRecord::from);
            record.adjustments = result
                .adjusted
                .iter()
                .filter_map(|a| serde_json::to_value(a).ok())
                .collect();
            if options.attach_scans {
                record.attached_scans = attach(&result.pages, &options.out, &record.id, console);
            }
        }
        Err(refusal) => record.refusal = Some(RefusalRecord::from(refusal)),
    }
    let _ = crate::scanner::discard_scan_scratch(&scratch);
    outcome
}

/// The settings a row asked for, as the report records them.
#[derive(serde::Serialize)]
struct SettingsRecord {
    item_name: Option<String>,
    dpi: Option<i32>,
    color_mode: Option<ColorMode>,
    paper: Option<PaperSize>,
    pages: Option<i32>,
    document_handling: Option<i32>,
}

impl From<&ScanSettings> for SettingsRecord {
    fn from(s: &ScanSettings) -> Self {
        Self {
            item_name: s.item_name.clone(),
            dpi: s.dpi,
            color_mode: s.color_mode,
            paper: s.paper,
            pages: s.pages,
            document_handling: s.document_handling,
        }
    }
}

fn attach(pages: &[String], out: &Path, row: &str, console: &dyn Console) -> Vec<String> {
    let dir = out.join("scan-test-scans").join(format!("row-{row}"));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        console.say(&format!("  Could not save the scans beside the report: {e}"));
        return Vec::new();
    }
    let mut saved = Vec::new();
    for page in pages {
        let from = Path::new(page);
        let Some(name) = from.file_name() else { continue };
        let to = dir.join(name);
        match std::fs::copy(from, &to) {
            Ok(_) => saved.push(to.to_string_lossy().to_string()),
            Err(e) => console.say(&format!("  Could not copy {}: {e}", from.display())),
        }
    }
    saved
}

/// Fold one verdict into a row.
///
/// A row judged twice — pages first, then the order the tester read back —
/// keeps the FAIL: a later pass cannot clear an earlier failure, or a row
/// that came back with a truncated page would report itself green because the
/// marks were in the right order.
fn apply(record: &mut RowRecord, verdict: RowVerdict) {
    if record.status != RowStatus::Fail || verdict.status == RowStatus::Fail {
        record.status = verdict.status;
    }
    record.notes.extend(verdict.notes);
}

/// One answer out of a fixed vocabulary, case-insensitively, normalised to
/// the vocabulary's own spelling so the report reads the same however the
/// tester typed it.
fn pick(console: &dyn Console, question: &str, allowed: &[&str]) -> Option<String> {
    let mut invalid = 0;
    loop {
        let answer = console.ask(&format!("{question} ({}) ", allowed.join("/")))?;
        if let Some(hit) = allowed
            .iter()
            .find(|a| a.eq_ignore_ascii_case(answer.trim()))
        {
            return Some(hit.to_string());
        }
        invalid += 1;
        if invalid >= MAX_INVALID {
            console.say("No usable answer; giving up on this question.");
            return None;
        }
        console.say(&format!("Please answer one of: {}", allowed.join(", ")));
    }
}

fn ask_confirm(console: &dyn Console, record: &mut RowRecord, question: &str) {
    let Some(answered) = yes(console, &format!("  {question}")) else {
        return abandoned(record);
    };
    record.tester_answers.push(TesterAnswer {
        question: question.to_string(),
        answer: if answered { "yes" } else { "no" }.to_string(),
    });
    if !answered {
        record.status = RowStatus::Fail;
        record
            .notes
            .push(format!("the tester answered no to: {question}"));
    }
}

fn run_row(
    row: &ChecklistRow,
    caps: &ScannerCapabilities,
    sessions: &ScannerSessions,
    options: &Options,
    console: &dyn Console,
    record: &mut RowRecord,
) {
    let device = caps.device_id.clone();
    let missing = |record: &mut RowRecord| {
        record.status = RowStatus::Skipped;
        record
            .notes
            .push("this scanner does not offer the source this row needs".to_string());
    };
    match row.id {
        "1" | "12" => {
            let (dpi, paper) = if row.id == "1" {
                (300, PaperSize::Letter)
            } else {
                (600, PaperSize::A4)
            };
            let Some(settings) =
                settings_for(caps, SourceOptionId::Flatbed, ColorMode::Color, dpi, paper, None)
            else {
                return missing(record);
            };
            if enter(console, "  Page on the glass?").is_none() {
                return abandoned(record);
            }
            let outcome = acquire(sessions, &device, settings, console, options, record, false);
            match outcome {
                Ok(_) => {
                    let mut expect = PageExpectation::new(CountRule::Exactly(1));
                    expect.dpi = Some(dpi);
                    expect.paper = Some(paper);
                    let verdict = judge_pages(&expect, &record.pages);
                    apply(record, verdict);
                }
                Err(_) => {
                    let verdict = refused(record);
                    apply(record, verdict);
                }
            }
        }
        "2" => {
            let Some(settings) = settings_for(
                caps,
                SourceOptionId::Flatbed,
                ColorMode::BlackAndWhite,
                200,
                PaperSize::Letter,
                None,
            ) else {
                return missing(record);
            };
            if enter(console, "  Page on the glass?").is_none() {
                return abandoned(record);
            }
            match acquire(sessions, &device, settings, console, options, record, false) {
                Ok(_) => {
                    let mut expect = PageExpectation::new(CountRule::Exactly(1));
                    expect.dpi = Some(200);
                    expect.max_bits_per_pixel = Some(8);
                    let verdict = judge_pages(&expect, &record.pages);
                    apply(record, verdict);
                }
                Err(_) => {
                    let verdict = refused(record);
                    apply(record, verdict);
                }
            }
        }
        "3" => {
            let id = if source(caps, SourceOptionId::Flatbed).is_some() {
                SourceOptionId::Flatbed
            } else {
                SourceOptionId::Feeder
            };
            let mut all = Vec::new();
            for original in ["a COLOUR page", "a BLACK-AND-WHITE page"] {
                let Some(settings) =
                    settings_for(caps, id, ColorMode::Auto, 300, PaperSize::Auto, None)
                else {
                    return missing(record);
                };
                if enter(console, &format!("  Load {original}.")).is_none() {
                    return abandoned(record);
                }
                match acquire(sessions, &device, settings, console, options, record, false) {
                    Ok(_) => all.extend(record.pages.clone()),
                    Err(_) => {
                        let verdict = refused(record);
                        return apply(record, verdict);
                    }
                }
            }
            record.pages = all;
            let verdict = judge_pages(&PageExpectation::new(CountRule::Exactly(2)), &record.pages);
            apply(record, verdict);
            ask_confirm(
                console,
                record,
                "Open both scans: did the mono original come back as a sensible mono/grey scan rather than a colour one?",
            );
        }
        "4" => {
            let Some(settings) = settings_for(
                caps,
                SourceOptionId::Feeder,
                ColorMode::Color,
                300,
                PaperSize::Auto,
                Some(0),
            ) else {
                return missing(record);
            };
            if enter(console, "  Five numbered sheets in the feeder?").is_none() {
                return abandoned(record);
            }
            match acquire(sessions, &device, settings, console, options, record, false) {
                Ok(_) => {
                    let verdict =
                        judge_pages(&PageExpectation::new(CountRule::Exactly(5)), &record.pages);
                    apply(record, verdict);
                }
                Err(_) => {
                    let verdict = refused(record);
                    apply(record, verdict);
                }
            }
            if record.status == RowStatus::Pass {
                ask_confirm(
                    console,
                    record,
                    "Were the five pages in sheet order 1 to 5, with none missing or repeated?",
                );
            }
        }
        "5" => {
            let Some(settings) = settings_for(
                caps,
                SourceOptionId::Duplex,
                ColorMode::Color,
                300,
                PaperSize::Auto,
                Some(0),
            ) else {
                return missing(record);
            };
            if enter(console, "  Three double-sided sheets in the feeder?").is_none() {
                return abandoned(record);
            }
            match acquire(sessions, &device, settings, console, options, record, false) {
                Ok(_) => {
                    let verdict =
                        judge_pages(&PageExpectation::new(CountRule::Exactly(6)), &record.pages);
                    apply(record, verdict);
                }
                Err(_) => {
                    let verdict = refused(record);
                    apply(record, verdict);
                }
            }
            if record.status == RowStatus::Pass {
                ask_confirm(
                    console,
                    record,
                    "Were the six sides in order — sheet 1 front, sheet 1 back, sheet 2 front, and so on?",
                );
            }
        }
        "6" => {
            let Some(settings) = settings_for(
                caps,
                SourceOptionId::Feeder,
                ColorMode::Color,
                300,
                PaperSize::Auto,
                Some(2),
            ) else {
                return missing(record);
            };
            if enter(console, "  Five sheets in the feeder?").is_none() {
                return abandoned(record);
            }
            match acquire(sessions, &device, settings, console, options, record, false) {
                Ok(_) => {
                    let verdict =
                        judge_pages(&PageExpectation::new(CountRule::Exactly(2)), &record.pages);
                    apply(record, verdict);
                }
                Err(_) => {
                    let verdict = refused(record);
                    apply(record, verdict);
                }
            }
            ask_confirm(
                console,
                record,
                "Are the three remaining sheets still in the feeder tray?",
            );
        }
        "7" => {
            let Some(settings) = settings_for(
                caps,
                SourceOptionId::Feeder,
                ColorMode::Color,
                300,
                PaperSize::Auto,
                Some(0),
            ) else {
                return missing(record);
            };
            if enter(console, "  About ten sheets in the feeder?").is_none() {
                return abandoned(record);
            }
            match acquire(sessions, &device, settings, console, options, record, true) {
                Ok(result) => {
                    let verdict = judge_cancel(10, &result, &record.pages);
                    apply(record, verdict);
                }
                Err(_) => {
                    let verdict = refused(record);
                    apply(record, verdict);
                }
            }
        }
        "8" => {
            let Some(settings) = settings_for(
                caps,
                SourceOptionId::Feeder,
                ColorMode::Color,
                300,
                PaperSize::Auto,
                Some(0),
            ) else {
                return missing(record);
            };
            if enter(console, "  Feeder tray completely empty?").is_none() {
                return abandoned(record);
            }
            let started = Instant::now();
            let outcome = acquire(sessions, &device, settings, console, options, record, false);
            apply(
                record,
                judge_refusal(
                    &[
                        "scan.feederEmpty",
                        "scan.paperProblem",
                        "scan.needsAttention",
                        "scan.cancelledAtDevice",
                    ],
                    &outcome,
                    started.elapsed().as_secs(),
                    180,
                ),
            );
        }
        "9" => {
            let Some(settings) = settings_for(
                caps,
                SourceOptionId::Feeder,
                ColorMode::Color,
                300,
                PaperSize::Auto,
                Some(0),
            ) else {
                return missing(record);
            };
            if enter(
                console,
                "  Sheets loaded so that one will misfeed? Do not force anything.",
            )
            .is_none()
            {
                return abandoned(record);
            }
            let started = Instant::now();
            let outcome = acquire(sessions, &device, settings, console, options, record, false);
            // A jam that comes after a sheet or two has already gone through
            // is a PARTIAL, not a failure: the run keeps what finished and
            // names the jam. A jam on the first sheet has nothing to keep and
            // refuses by name. Both pass; a silent success does not.
            let pages = record.pages.clone();
            apply(
                record,
                judge_jam(
                    &[
                        "scan.paperJam",
                        "scan.paperProblem",
                        "scan.needsAttention",
                        "scan.deviceLost",
                    ],
                    &outcome,
                    &pages,
                    started.elapsed().as_secs(),
                    300,
                ),
            );
            ask_confirm(
                console,
                record,
                "Did a jam (or misfeed) actually happen at the scanner?",
            );
        }
        "10" => {
            let id = source(caps, SourceOptionId::Flatbed)
                .map(|o| o.id)
                .or_else(|| source(caps, SourceOptionId::Feeder).map(|o| o.id))
                .unwrap_or(SourceOptionId::Flatbed);
            let Some(settings) = settings_for(caps, id, ColorMode::Color, 600, PaperSize::Auto, None)
            else {
                return missing(record);
            };
            if enter(
                console,
                "  A page ready to scan? Switch the scanner OFF once it starts moving.",
            )
            .is_none()
            {
                return abandoned(record);
            }
            let started = Instant::now();
            let outcome = acquire(sessions, &device, settings, console, options, record, false);
            apply(
                record,
                judge_refusal(
                    &[
                        "scan.deviceLost",
                        "scan.notResponding",
                        "scan.deviceOffline",
                        "scan.deviceBusy",
                    ],
                    &outcome,
                    started.elapsed().as_secs(),
                    300,
                ),
            );
            if record.status == RowStatus::Pass && !record.pages.is_empty() {
                record.status = RowStatus::Fail;
                record.notes.push(
                    "the run offered pages; a run that lost its device has no honest partial"
                        .to_string(),
                );
            }
            console.say("  Switch the scanner back on and give it a moment to settle.");
            if enter(console, "  Back on?").is_none() {
                record
                    .notes
                    .push(format!("the recovery scan was not attempted: {NO_CONSOLE}"));
                return;
            }
            if let Some(settings) =
                settings_for(caps, id, ColorMode::Color, 300, PaperSize::Auto, None)
            {
                let mut recovery = RowRecord {
                    pages: Vec::new(),
                    ..record.clone()
                };
                match acquire(
                    sessions,
                    &device,
                    settings,
                    console,
                    options,
                    &mut recovery,
                    false,
                ) {
                    Ok(_) => record
                        .notes
                        .push("the scanner scanned normally again afterwards".to_string()),
                    Err(refusal) => {
                        record.status = RowStatus::Fail;
                        record.notes.push(format!(
                            "the scanner would not scan again afterwards: {} (\"{}\")",
                            refusal.key, refusal.message
                        ));
                    }
                }
            }
        }
        "11" => {
            // The in-process half is automatable: close the session and read
            // the device again. A leaked item would fail the second read.
            sessions.close(&device);
            match sessions.capabilities(&device) {
                Ok(_) => record
                    .notes
                    .push("the device could be opened again straight after the run".to_string()),
                Err(refusal) => {
                    record.status = RowStatus::Fail;
                    record.notes.push(format!(
                        "the device could not be re-opened: {} (\"{}\")",
                        refusal.key, refusal.message
                    ));
                }
            }
            sessions.close(&device);
            if record.status != RowStatus::Fail {
                record.status = RowStatus::Pass;
            }
            ask_confirm(
                console,
                record,
                "Open another scanning program (the one that came with Windows will do) and try this scanner: does it open the device?",
            );
        }
        "14" => {
            let Some(network) = yes(
                console,
                "  Is this scanner reached over the network rather than by USB?",
            ) else {
                return abandoned(record);
            };
            record.tester_answers.push(TesterAnswer {
                question: "Is this scanner reached over the network rather than by USB?".to_string(),
                answer: if network { "yes" } else { "no" }.to_string(),
            });
            if !network {
                record.status = RowStatus::Skipped;
                record
                    .notes
                    .push("this scanner is attached by USB, so the network row cannot be posed"
                        .to_string());
                return;
            }
            let Some(kind) = console.ask(
                "  Which kind is it — type 'escl' for AirScan/Mopria, 'wsd' for WSD, or 'unsure': ",
            ) else {
                return abandoned(record);
            };
            record.tester_answers.push(TesterAnswer {
                question: "Which kind of network scanner is it?".to_string(),
                answer: kind,
            });
            let id = source(caps, SourceOptionId::Flatbed)
                .map(|o| o.id)
                .or_else(|| source(caps, SourceOptionId::Feeder).map(|o| o.id))
                .unwrap_or(SourceOptionId::Flatbed);
            let Some(settings) = settings_for(caps, id, ColorMode::Color, 300, PaperSize::Auto, None)
            else {
                return missing(record);
            };
            if enter(console, "  A page ready to scan?").is_none() {
                return abandoned(record);
            }
            match acquire(sessions, &device, settings, console, options, record, false) {
                Ok(_) => {
                    let verdict =
                        judge_pages(&PageExpectation::new(CountRule::AtLeast(1)), &record.pages);
                    apply(record, verdict);
                }
                Err(_) => {
                    let verdict = refused(record);
                    apply(record, verdict);
                }
            }
        }
        "16" | "17" => {
            let (plan, id, sheets) = if row.id == "16" {
                (&DUPLEX_ORDER, SourceOptionId::Duplex, "three double-sided")
            } else {
                (&SIMPLEX_ORDER, SourceOptionId::Feeder, "three numbered")
            };
            let Some(settings) =
                settings_for(caps, id, ColorMode::Color, 300, PaperSize::Auto, Some(0))
            else {
                return missing(record);
            };
            record.expected_order = plan.expected.iter().map(|m| m.to_string()).collect();
            if enter(
                console,
                &format!("  The {sheets} sheets are in the feeder, sheet 1 on top?"),
            )
            .is_none()
            {
                return abandoned(record);
            }
            if acquire(sessions, &device, settings, console, options, record, false).is_err() {
                let verdict = refused(record);
                return apply(record, verdict);
            }
            // Blank is an EXPECTED page here (sheet 2's back), so content is
            // recorded rather than required. The per-page verdicts travel in
            // the report beside the tester's answers, and the two are checked
            // against each other below.
            let mut expect = PageExpectation::new(CountRule::AtLeast(1));
            expect.require_content = false;
            let pages = record.pages.clone();
            apply(record, judge_pages(&expect, &pages));

            console.say(&format!(
                "  Open the {} page(s) that came back and read each one in turn.",
                record.pages.len()
            ));
            let total = record.pages.len();
            let mut claimed = Vec::with_capacity(total);
            for index in 0..total {
                let Some(answer) = pick(
                    console,
                    &format!(
                        "  Page {} of {total} — which mark is on it?",
                        index + 1
                    ),
                    plan.vocabulary,
                ) else {
                    return abandoned(record);
                };
                claimed.push(answer);
            }
            record.claimed_order = claimed.clone();
            apply(record, judge_order(plan, &claimed));

            // The histogram already knows which pages carry no ink. A page
            // the tester called blank that reads as real content (or the
            // reverse) means one of the two is wrong about which page is
            // which, which is worth saying out loud in the report.
            for (index, page) in record.pages.iter().enumerate() {
                let Some(mark) = claimed.get(index) else { continue };
                let empty = matches!(
                    page.content,
                    ContentVerdict::Blank | ContentVerdict::NearUniform
                );
                if mark.eq_ignore_ascii_case("blank") != empty
                    && page.content != ContentVerdict::Unverifiable
                {
                    record.notes.push(format!(
                        "{}: the tester read it as '{mark}' but its own tones say {:?}",
                        page.file, page.content
                    ));
                }
            }
        }
        other => {
            record.status = RowStatus::Fail;
            record.notes.push(format!("no runner for row {other}"));
        }
    }
}

/// A row that expected pages and got a refusal instead.
fn refused(record: &RowRecord) -> RowVerdict {
    match &record.refusal {
        Some(refusal) => RowVerdict::fail(format!(
            "the scan refused: {} (\"{}\")",
            refusal.key, refusal.message
        )),
        None => RowVerdict::fail("the scan did not finish".to_string()),
    }
}

fn windows_build() -> String {
    let version = windows_version::OsVersion::current();
    format!(
        "{}.{}.{}",
        version.major, version.minor, version.build
    )
}

/// Write both renderings beside each other and report where they went.
pub fn write_report(report: &Report, out: &Path) -> Result<(PathBuf, PathBuf), String> {
    std::fs::create_dir_all(out).map_err(|e| format!("Could not create {}: {e}", out.display()))?;
    let json_path = out.join("scan-test-report.json");
    let text_path = out.join("scan-test-report.txt");
    let json = serde_json::to_string_pretty(report).map_err(|e| e.to_string())?;
    std::fs::write(&json_path, json).map_err(|e| format!("Could not write the report: {e}"))?;
    std::fs::write(&text_path, report.to_text())
        .map_err(|e| format!("Could not write the report: {e}"))?;
    Ok((json_path, text_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::{
        ControlModel, DocumentHandling, DuplexMode, ScanSourceReport, SourceCategory,
    };

    fn evidence(width: u32, height: u32, dpi: f64, bits: u16, content: ContentVerdict) -> PageEvidence {
        PageEvidence {
            file: "page-0000.bmp".to_string(),
            format: "bmp".to_string(),
            bytes: 1024,
            width_px: Some(width),
            height_px: Some(height),
            bits_per_pixel: Some(bits),
            dpi_x: Some(dpi),
            dpi_y: Some(dpi),
            integrity: "complete".to_string(),
            content,
            histogram: None,
        }
    }

    fn source_report(category: SourceCategory, modes: Vec<ColorMode>, pages: ControlModel) -> ScanSourceReport {
        ScanSourceReport {
            item_name: format!("{category:?}"),
            category,
            properties: Vec::new(),
            resolution: ControlModel::Span {
                min: 50,
                max: 600,
                step: 1,
                current: Some(300),
            },
            optical_resolution: Some(600),
            color_modes: modes,
            brightness: ControlModel::Absent,
            contrast: ControlModel::Absent,
            pages,
            document_handling_select: ControlModel::Absent,
        }
    }

    fn caps(options: Vec<SourceOptionId>, modes: Vec<ColorMode>, pages: ControlModel) -> ScannerCapabilities {
        ScannerCapabilities {
            device_id: "dev".to_string(),
            device_name: "Test Scanner".to_string(),
            document_handling: DocumentHandling {
                capabilities: 0,
                flatbed: true,
                feeder: options.contains(&SourceOptionId::Feeder),
                duplex: options.contains(&SourceOptionId::Duplex),
                advanced_duplex: false,
                duplex_mode: DuplexMode::None,
                flatbed_select: 2,
                feeder_select: 1,
                duplex_select: 5,
            },
            source_options: options
                .iter()
                .map(|id| ScanSourceOption {
                    id: *id,
                    item_name: format!("{id:?}"),
                    document_handling: None,
                    feeds: *id != SourceOptionId::Flatbed,
                })
                .collect(),
            max_scan_time_ms: None,
            sources: vec![source_report(
                SourceCategory::Flatbed,
                modes,
                pages,
            )],
        }
    }

    #[test]
    fn every_row_is_named_once_and_carries_a_time_estimate() {
        let mut seen = std::collections::HashSet::new();
        for row in ROWS {
            assert!(seen.insert(row.id), "row {} appears twice", row.id);
            assert!(!row.title.is_empty());
            assert!(!row.instruction.is_empty(), "row {} has no instruction", row.id);
            assert!(row.minutes > 0, "row {} has no time estimate", row.id);
            assert!(super::row(row.id).is_some());
        }
        // The rows the owner's flatbed could not close are all here: this is
        // the reason the runner exists.
        for id in ["3", "4", "5", "6", "7", "8", "9", "10", "14"] {
            assert!(seen.contains(id), "row {id} is missing from the runner");
        }
    }

    #[test]
    fn a_flatbed_only_device_skips_every_feeder_row() {
        let flatbed = caps(
            vec![SourceOptionId::Flatbed],
            vec![ColorMode::Color, ColorMode::Grayscale],
            ControlModel::Absent,
        );
        for need in [
            RowNeed::Feeder,
            RowNeed::Duplex,
            RowNeed::PageLimit,
            RowNeed::Autodetect,
        ] {
            assert!(
                matches!(applies(need, &flatbed), Applicability::Skipped(_)),
                "{need:?} should be skipped on a flatbed"
            );
        }
        assert_eq!(applies(RowNeed::Flatbed, &flatbed), Applicability::Runnable);
        assert_eq!(applies(RowNeed::AnyDevice, &flatbed), Applicability::Runnable);
        // Nothing in the report says how the device is attached, so the
        // network row is offered and the tester answers it.
        assert_eq!(applies(RowNeed::Network, &flatbed), Applicability::Runnable);
    }

    #[test]
    fn a_feeder_without_a_page_count_skips_only_the_page_limit_row() {
        let feeder = caps(
            vec![SourceOptionId::Flatbed, SourceOptionId::Feeder],
            vec![ColorMode::Color, ColorMode::Auto],
            ControlModel::Absent,
        );
        assert_eq!(applies(RowNeed::Feeder, &feeder), Applicability::Runnable);
        assert_eq!(applies(RowNeed::Autodetect, &feeder), Applicability::Runnable);
        assert!(matches!(
            applies(RowNeed::PageLimit, &feeder),
            Applicability::Skipped(_)
        ));
        let counted = caps(
            vec![SourceOptionId::Flatbed, SourceOptionId::Feeder],
            vec![ColorMode::Color],
            ControlModel::Span {
                min: 0,
                max: 100,
                step: 1,
                current: Some(0),
            },
        );
        assert_eq!(applies(RowNeed::PageLimit, &counted), Applicability::Runnable);
        assert!(matches!(
            applies(RowNeed::Duplex, &counted),
            Applicability::Skipped(_)
        ));
    }

    #[test]
    fn the_page_judge_reads_count_resolution_depth_and_geometry() {
        let mut expect = PageExpectation::new(CountRule::Exactly(1));
        expect.dpi = Some(300);
        expect.paper = Some(PaperSize::Letter);
        let good = vec![evidence(2550, 3300, 300.0, 24, ContentVerdict::RealContent)];
        assert_eq!(judge_pages(&expect, &good).status, RowStatus::Pass);

        // A driver that clamped the request reports its own resolution back.
        let clamped = vec![evidence(2550, 3300, 150.0, 24, ContentVerdict::RealContent)];
        assert_eq!(judge_pages(&expect, &clamped).status, RowStatus::Fail);

        // A blank page satisfies "the file exists" and proves nothing.
        let blank = vec![evidence(2550, 3300, 300.0, 24, ContentVerdict::Blank)];
        assert_eq!(judge_pages(&expect, &blank).status, RowStatus::Fail);

        // A page short of the sheet because the glass is shorter than the
        // sheet is the bed clamp working, not a failed row — it is named and
        // the row still passes.
        let a4 = {
            let mut e = expect;
            e.paper = Some(PaperSize::A4);
            e
        };
        let exact = vec![evidence(2480, 3507, 300.0, 24, ContentVerdict::RealContent)];
        assert_eq!(judge_pages(&a4, &exact).status, RowStatus::Pass);
        let clamped = vec![evidence(2480, 3490, 300.0, 24, ContentVerdict::RealContent)];
        let verdict = judge_pages(&a4, &clamped);
        assert_eq!(verdict.status, RowStatus::Pass);
        assert!(verdict.notes.iter().any(|n| n.contains("bed limit")), "{verdict:?}");
        // Far enough off and it is not a clamp, it is a wrong-size page.
        let wrong = vec![evidence(2480, 2000, 300.0, 24, ContentVerdict::RealContent)];
        assert_eq!(judge_pages(&a4, &wrong).status, RowStatus::Fail);

        // Bit depth is the black-and-white row's whole assertion.
        let mut mono = PageExpectation::new(CountRule::Exactly(1));
        mono.max_bits_per_pixel = Some(8);
        let colour = vec![evidence(1700, 2200, 200.0, 24, ContentVerdict::RealContent)];
        assert_eq!(judge_pages(&mono, &colour).status, RowStatus::Fail);
        let bilevel = vec![evidence(1700, 2200, 200.0, 1, ContentVerdict::RealContent)];
        assert_eq!(judge_pages(&mono, &bilevel).status, RowStatus::Pass);
    }

    #[test]
    fn a_truncated_page_fails_its_row_however_many_came_back() {
        let mut page = evidence(2550, 3300, 300.0, 24, ContentVerdict::RealContent);
        page.integrity = "truncated (100 of 5000 bytes)".to_string();
        let verdict = judge_pages(&PageExpectation::new(CountRule::Exactly(1)), &[page]);
        assert_eq!(verdict.status, RowStatus::Fail);
    }

    #[test]
    fn the_refusal_judge_takes_a_named_row_and_refuses_a_hex_fallback() {
        let empty: Result<ScanResult, ScanRefusal> = Err(ScanRefusal {
            key: "scan.feederEmpty",
            message: "Put paper in the feeder.".to_string(),
            code: None,
            folder: None,
        });
        let accepted = ["scan.feederEmpty", "scan.needsAttention"];
        assert_eq!(
            judge_refusal(&accepted, &empty, 4, 180).status,
            RowStatus::Pass
        );
        // Named, but too slow to be anything but a hang.
        assert_eq!(
            judge_refusal(&accepted, &empty, 400, 180).status,
            RowStatus::Fail
        );
        // The generic fallback carrying a hex code is exactly what the row
        // asks NOT to see.
        let generic: Result<ScanResult, ScanRefusal> = Err(ScanRefusal {
            key: "scan.failed",
            message: "The scan failed.".to_string(),
            code: Some("0x80210016".to_string()),
            folder: None,
        });
        let verdict = judge_refusal(&accepted, &generic, 4, 180);
        assert_eq!(verdict.status, RowStatus::Fail);
        assert!(verdict.notes[0].contains("0x80210016"), "{verdict:?}");
        // A success is a failure of a row whose point is the refusal.
        let ok: Result<ScanResult, ScanRefusal> = Ok(ScanResult {
            pages: vec!["page-0000.bmp".to_string()],
            cancelled: false,
            interrupted: None,
            scratch: String::new(),
            dpi: 300,
            adjusted: Vec::new(),
            bytes: 0,
        });
        assert_eq!(judge_refusal(&accepted, &ok, 4, 180).status, RowStatus::Fail);
    }

    fn partial(interrupted: Option<&'static str>, pages: usize) -> Result<ScanResult, ScanRefusal> {
        Ok(ScanResult {
            pages: vec![String::new(); pages],
            cancelled: false,
            interrupted: interrupted.map(|key| ScanRefusal {
                key,
                message: "Clear the paper jam, then scan again.".to_string(),
                code: None,
                folder: None,
            }),
            scratch: String::new(),
            dpi: 300,
            adjusted: Vec::new(),
            bytes: 0,
        })
    }

    #[test]
    fn the_jam_judge_takes_a_clean_partial_and_refuses_a_silent_one() {
        let accepted = ["scan.paperJam", "scan.paperProblem"];
        let good: Vec<PageEvidence> = (0..3)
            .map(|_| evidence(2550, 3300, 300.0, 24, ContentVerdict::RealContent))
            .collect();

        // The row's point: three sheets went through, the fourth jammed, the
        // three are kept and the jam is named.
        let verdict = judge_jam(&accepted, &partial(Some("scan.paperJam"), 3), &good, 20, 300);
        assert_eq!(verdict.status, RowStatus::Pass, "{verdict:?}");
        assert!(verdict.notes[0].contains("scan.paperJam"), "{verdict:?}");

        // A jam on the very first sheet has nothing to keep and refuses by
        // name — the same bar row 8 sets.
        let refused: Result<ScanResult, ScanRefusal> = Err(ScanRefusal {
            key: "scan.paperJam",
            message: "Clear the paper jam, then scan again.".to_string(),
            code: None,
            folder: None,
        });
        assert_eq!(
            judge_jam(&accepted, &refused, &[], 20, 300).status,
            RowStatus::Pass
        );

        // A run that jammed and said nothing about it is the failure this row
        // exists to catch: pages that stop part-way through, reported as a
        // complete batch.
        assert_eq!(
            judge_jam(&accepted, &partial(None, 3), &good, 20, 300).status,
            RowStatus::Fail
        );

        // A jam that named an unexpected key, and one whose kept pages are
        // torn, both fail.
        assert_eq!(
            judge_jam(&accepted, &partial(Some("scan.failed"), 3), &good, 20, 300).status,
            RowStatus::Fail
        );
        let mut torn = good.clone();
        torn[2].integrity = "truncated: 4000 of 9000 bytes".to_string();
        let verdict = judge_jam(&accepted, &partial(Some("scan.paperJam"), 3), &torn, 20, 300);
        assert_eq!(verdict.status, RowStatus::Fail, "{verdict:?}");

        // And a "partial" holding no pages is a refusal wearing a result's
        // clothes.
        assert_eq!(
            judge_jam(&accepted, &partial(Some("scan.paperJam"), 0), &[], 20, 300).status,
            RowStatus::Fail
        );
    }

    fn read_back(marks: &[&str]) -> Vec<String> {
        marks.iter().map(|m| m.to_string()).collect()
    }

    #[test]
    fn the_order_judge_names_each_feeder_bug_rather_than_saying_wrong_order() {
        // Sheet 2's back is blank on purpose: it is the only sheet that can
        // catch a feeder dropping blank sides.
        let right = judge_order(&DUPLEX_ORDER, &read_back(&["1f", "1b", "2f", "blank", "3f", "3b"]));
        assert_eq!(right.status, RowStatus::Pass, "{right:?}");
        // However the tester typed it.
        assert_eq!(
            judge_order(&DUPLEX_ORDER, &read_back(&["1F", "1B", "2F", "BLANK", "3F", "3B"])).status,
            RowStatus::Pass
        );

        let named = |claimed: &[&str], fault: &str| {
            let verdict = judge_order(&DUPLEX_ORDER, &read_back(claimed));
            assert_eq!(verdict.status, RowStatus::Fail, "{verdict:?}");
            assert!(
                verdict.notes.iter().any(|n| n.contains(fault)),
                "expected {fault} in {verdict:?}"
            );
        };
        named(&["1b", "1f", "blank", "2f", "3b", "3f"], "REVERSED BACKS");
        named(&["1f", "1b", "2f", "3f", "3b"], "DROPPED BLANKS");
        named(&["1f", "2f", "3f"], "ONE SIDE PER SHEET");
        named(&["3b", "3f", "blank", "2f", "1b", "1f"], "REVERSED BATCH");
        named(&["1f", "1b", "blank", "3f", "3b"], "DROPPED PAGES");
        // A shape no known bug produces still reports both sequences rather
        // than guessing at a cause.
        let odd = judge_order(&DUPLEX_ORDER, &read_back(&["2f", "1f", "1b", "blank", "3b", "3f"]));
        assert_eq!(odd.status, RowStatus::Fail);
        assert!(odd.notes.iter().any(|n| n.contains("no known feeder fault")), "{odd:?}");

        // The simplex variant, for a feeder that scans one side.
        assert_eq!(
            judge_order(&SIMPLEX_ORDER, &read_back(&["1", "2", "3"])).status,
            RowStatus::Pass
        );
        let reversed = judge_order(&SIMPLEX_ORDER, &read_back(&["3", "2", "1"]));
        assert!(
            reversed.notes.iter().any(|n| n.contains("REVERSED BATCH")),
            "{reversed:?}"
        );
        let dropped = judge_order(&SIMPLEX_ORDER, &read_back(&["1", "3"]));
        assert!(
            dropped.notes.iter().any(|n| n.contains("DROPPED PAGES: 2")),
            "{dropped:?}"
        );
        // The count is reported in its own right, so a report says how many
        // pages came back even when the shape is unclassifiable.
        assert!(
            dropped.notes.iter().any(|n| n.contains("2 page(s) came back where 3")),
            "{dropped:?}"
        );
    }

    #[test]
    fn the_cancel_judge_wants_a_partial_offer_and_nothing_else() {
        let pages: Vec<PageEvidence> = (0..4)
            .map(|_| evidence(2550, 3300, 300.0, 24, ContentVerdict::RealContent))
            .collect();
        let stopped = ScanResult {
            pages: vec![String::new(); 4],
            cancelled: true,
            interrupted: None,
            scratch: String::new(),
            dpi: 300,
            adjusted: Vec::new(),
            bytes: 0,
        };
        assert_eq!(judge_cancel(10, &stopped, &pages).status, RowStatus::Pass);

        // A run that reported no stop stopped nothing.
        let ran_on = ScanResult {
            cancelled: false,
            ..stopped.clone()
        };
        assert_eq!(judge_cancel(10, &ran_on, &pages).status, RowStatus::Fail);

        // Every sheet scanned means the stop never landed.
        let all: Vec<PageEvidence> = (0..10)
            .map(|_| evidence(2550, 3300, 300.0, 24, ContentVerdict::RealContent))
            .collect();
        assert_eq!(judge_cancel(10, &stopped, &all).status, RowStatus::Fail);

        // Nothing at all is not a partial offer.
        assert_eq!(judge_cancel(10, &stopped, &[]).status, RowStatus::Fail);
    }

    /// A 4×2 24-bit BMP with two tones, written by hand so the reader is
    /// tested against the format rather than against another writer.
    fn bmp(width: u32, height: u32, dpi: f64, fill: &dyn Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
        let stride = (width as usize * 24).div_ceil(32) * 4;
        let pixels = stride * height as usize;
        let mut out = Vec::new();
        out.extend_from_slice(b"BM");
        out.extend_from_slice(&((54 + pixels) as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&54u32.to_le_bytes());
        out.extend_from_slice(&40u32.to_le_bytes());
        out.extend_from_slice(&(width as i32).to_le_bytes());
        out.extend_from_slice(&(height as i32).to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&24u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(pixels as u32).to_le_bytes());
        let ppm = (dpi / 0.0254).round() as i32;
        out.extend_from_slice(&ppm.to_le_bytes());
        out.extend_from_slice(&ppm.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for y in 0..height {
            let mut row = Vec::with_capacity(stride);
            for x in 0..width {
                let [r, g, b] = fill(x, y);
                row.extend_from_slice(&[b, g, r]);
            }
            row.resize(stride, 0);
            out.extend_from_slice(&row);
        }
        out
    }

    #[test]
    fn a_bmp_reports_its_own_geometry_resolution_and_tone() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let content = dir.path().join("page-0000.bmp");
        std::fs::write(
            &content,
            bmp(64, 32, 300.0, &|x, _| {
                if x % 4 == 0 {
                    [0, 0, 0]
                } else {
                    [255, 255, 255]
                }
            }),
        )
        .expect("write");
        let evidence = page_evidence(&content);
        assert_eq!(evidence.format, "bmp");
        assert_eq!(evidence.width_px, Some(64));
        assert_eq!(evidence.height_px, Some(32));
        assert_eq!(evidence.bits_per_pixel, Some(24));
        assert!((evidence.dpi_x.unwrap() - 300.0).abs() < 1.0, "{evidence:?}");
        assert_eq!(evidence.integrity, "complete");
        assert_eq!(evidence.content, ContentVerdict::RealContent);
        let histogram = evidence.histogram.expect("a histogram");
        assert!(histogram.dark_fraction > 0.1, "{histogram:?}");

        // A page of one tone is what a failed transfer looks like when the
        // file's existence is the only thing checked.
        let blank = dir.path().join("blank.bmp");
        std::fs::write(&blank, bmp(64, 32, 300.0, &|_, _| [255, 255, 255])).expect("write");
        assert_eq!(page_evidence(&blank).content, ContentVerdict::Blank);

        // A black page is equally uniform, and equally not a scan.
        let black = dir.path().join("black.bmp");
        std::fs::write(&black, bmp(64, 32, 300.0, &|_, _| [0, 0, 0])).expect("write");
        assert_eq!(page_evidence(&black).content, ContentVerdict::Blank);
    }

    #[test]
    fn a_page_cut_short_is_reported_as_truncated_not_as_a_scan() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let path = dir.path().join("page-0000.bmp");
        let mut bytes = bmp(64, 32, 300.0, &|_, _| [0, 128, 255]);
        bytes.truncate(bytes.len() / 2);
        std::fs::write(&path, bytes).expect("write");
        let evidence = page_evidence(&path);
        assert!(evidence.integrity.starts_with("truncated"), "{evidence:?}");
    }

    #[test]
    fn a_png_reports_geometry_and_resolution_without_a_histogram() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let path = dir.path().join("page-0000.png");
        let mut png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&2550u32.to_be_bytes());
        png.extend_from_slice(&3300u32.to_be_bytes());
        png.extend_from_slice(&[8, 2, 0, 0, 0]);
        png.extend_from_slice(&0u32.to_be_bytes()); // CRC placeholder
        png.extend_from_slice(&9u32.to_be_bytes());
        png.extend_from_slice(b"pHYs");
        let ppm = (300.0f64 / 0.0254).round() as u32;
        png.extend_from_slice(&ppm.to_be_bytes());
        png.extend_from_slice(&ppm.to_be_bytes());
        png.push(1);
        png.extend_from_slice(&0u32.to_be_bytes());
        std::fs::write(&path, png).expect("write");
        let evidence = page_evidence(&path);
        assert_eq!(evidence.format, "png");
        assert_eq!(evidence.width_px, Some(2550));
        assert_eq!(evidence.bits_per_pixel, Some(24));
        assert!((evidence.dpi_x.unwrap() - 300.0).abs() < 1.0, "{evidence:?}");
        assert_eq!(evidence.content, ContentVerdict::Unverifiable);
    }

    #[test]
    fn a_report_renders_both_ways_and_carries_no_page_content() {
        let mut report = Report {
            schema: REPORT_SCHEMA,
            tool: "spectrapdf scan-test".to_string(),
            app_version: "1.0.0".to_string(),
            windows_build: "10.0.26200".to_string(),
            started_unix_secs: 0,
            device_id: "dev".to_string(),
            device_name: "Test Scanner".to_string(),
            capabilities: serde_json::Value::Null,
            rows: vec![
                RowRecord {
                    id: "1".to_string(),
                    title: "Flatbed".to_string(),
                    status: RowStatus::Pass,
                    notes: vec!["1 page(s) came back".to_string()],
                    settings: None,
                    pages: vec![evidence(2550, 3300, 300.0, 24, ContentVerdict::RealContent)],
                    refusal: None,
                    interrupted: None,
                    expected_order: Vec::new(),
                    claimed_order: Vec::new(),
                    adjustments: Vec::new(),
                    tester_answers: Vec::new(),
                    elapsed_secs: 12,
                    attached_scans: Vec::new(),
                },
                RowRecord {
                    id: "4".to_string(),
                    title: "Feeder".to_string(),
                    status: RowStatus::Skipped,
                    notes: vec!["this scanner reports no document feeder".to_string()],
                    settings: None,
                    pages: Vec::new(),
                    refusal: None,
                    interrupted: None,
                    expected_order: Vec::new(),
                    claimed_order: Vec::new(),
                    adjustments: Vec::new(),
                    tester_answers: Vec::new(),
                    elapsed_secs: 0,
                    attached_scans: Vec::new(),
                },
            ],
            passed: 0,
            failed: 0,
            skipped: 0,
            not_run: 0,
            privacy: PRIVACY_NOTE.to_string(),
        };
        report.tally();
        assert_eq!((report.passed, report.skipped), (1, 1));
        let text = report.to_text();
        assert!(text.contains("Row 1"), "{text}");
        assert!(text.contains("SKIPPED"), "{text}");
        assert!(text.contains("no image content"), "{text}");
        let json = serde_json::to_string(&report).expect("serialises");
        // The report names files, never their bytes: a page's own path would
        // leak a folder on the tester's machine and its content is never in
        // here at all.
        assert!(json.contains("page-0000.bmp"));
        assert!(!json.contains("scan-scratch"));
    }

    /// A console whose answers are scripted; `None` once the script runs out,
    /// which is what a closed stdin looks like.
    struct ScriptedConsole {
        answers: std::sync::Mutex<std::collections::VecDeque<String>>,
        /// A script of one answer that repeats — a pipe that never closes.
        repeat: Option<String>,
        said: std::sync::Mutex<Vec<String>>,
        asked: std::sync::atomic::AtomicUsize,
    }

    impl ScriptedConsole {
        fn new(answers: &[&str]) -> Self {
            Self {
                answers: std::sync::Mutex::new(
                    answers.iter().map(|a| a.to_string()).collect(),
                ),
                repeat: None,
                said: std::sync::Mutex::new(Vec::new()),
                asked: std::sync::atomic::AtomicUsize::new(0),
            }
        }
        fn eof() -> Self {
            Self::new(&[])
        }
        fn repeating(answer: &str) -> Self {
            Self {
                repeat: Some(answer.to_string()),
                ..Self::new(&[])
            }
        }
        fn asks(&self) -> usize {
            self.asked.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn transcript(&self) -> String {
            self.said.lock().expect("said").join("\n")
        }
    }

    impl Console for ScriptedConsole {
        fn say(&self, line: &str) {
            self.said.lock().expect("said").push(line.to_string());
        }
        fn ask(&self, _prompt: &str) -> Option<String> {
            self.asked
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some(answer) = self.repeat.clone() {
                return Some(answer);
            }
            self.answers.lock().expect("answers").pop_front()
        }
    }

    fn blank_record() -> RowRecord {
        RowRecord {
            id: "4".to_string(),
            title: "Feeder".to_string(),
            status: RowStatus::NotRun,
            notes: Vec::new(),
            settings: None,
            pages: Vec::new(),
            refusal: None,
            interrupted: None,
            expected_order: Vec::new(),
            claimed_order: Vec::new(),
            adjustments: Vec::new(),
            tester_answers: Vec::new(),
            elapsed_secs: 0,
            attached_scans: Vec::new(),
        }
    }

    #[test]
    fn a_closed_stdin_gives_up_on_the_question_instead_of_re_prompting() {
        let console = ScriptedConsole::eof();
        assert_eq!(yes(&console, "Run this row now?"), None);
        assert_eq!(enter(&console, "Page on the glass?"), None);
        assert_eq!(console.asks(), 2, "each question asks exactly once at EOF");
        assert!(
            !console.transcript().contains("Please answer"),
            "{}",
            console.transcript()
        );
    }

    #[test]
    fn an_unanswerable_confirmation_marks_the_row_skipped_with_its_reason() {
        let console = ScriptedConsole::eof();
        let mut record = blank_record();
        ask_confirm(&console, &mut record, "Were the five pages in order?");
        assert_eq!(record.status, RowStatus::Skipped);
        assert!(record.notes.contains(&NO_CONSOLE.to_string()), "{record:?}");
        assert!(
            record.tester_answers.is_empty(),
            "an answer nobody gave is never recorded"
        );
    }

    #[test]
    fn a_report_of_rows_nobody_could_answer_still_tallies_and_renders() {
        let console = ScriptedConsole::eof();
        let mut rows = Vec::new();
        for id in ["1", "4"] {
            let mut record = blank_record();
            record.id = id.to_string();
            ask_confirm(&console, &mut record, "Did that look right?");
            rows.push(record);
        }
        let mut report = Report {
            schema: REPORT_SCHEMA,
            tool: "spectrapdf scan-test".to_string(),
            app_version: "1.0.0".to_string(),
            windows_build: "10.0.26200".to_string(),
            started_unix_secs: 0,
            device_id: "dev".to_string(),
            device_name: "Test Scanner".to_string(),
            capabilities: serde_json::Value::Null,
            rows,
            passed: 0,
            failed: 0,
            skipped: 0,
            not_run: 0,
            privacy: PRIVACY_NOTE.to_string(),
        };
        report.tally();
        assert_eq!((report.passed, report.failed, report.skipped), (0, 0, 2));
        let text = report.to_text();
        assert!(text.contains(NO_CONSOLE), "{text}");
    }

    #[test]
    fn an_endless_stream_of_unusable_answers_stops_at_the_cap() {
        let console = ScriptedConsole::repeating("maybe");
        assert_eq!(yes(&console, "Run this row now?"), None);
        assert_eq!(console.asks(), MAX_INVALID as usize);
        let transcript = console.transcript();
        assert_eq!(
            transcript.matches("Please answer y or n.").count(),
            MAX_INVALID as usize - 1,
            "{transcript}"
        );
    }

    #[test]
    fn a_tester_at_a_terminal_still_answers_y_and_n() {
        let console = ScriptedConsole::new(&["maybe", "Y", "no", ""]);
        assert_eq!(yes(&console, "one?"), Some(true));
        assert_eq!(yes(&console, "two?"), Some(false));
        assert_eq!(enter(&console, "ready?"), Some(()));
        let mut record = blank_record();
        let refusing = ScriptedConsole::new(&["n"]);
        ask_confirm(&refusing, &mut record, "Did that look right?");
        assert_eq!(record.status, RowStatus::Fail);
        assert_eq!(record.tester_answers.len(), 1);
    }

    #[test]
    fn the_row_listing_names_every_row_with_what_it_needs() {
        let listing = list_rows();
        for row in ROWS {
            assert!(listing.contains(row.title), "{listing}");
        }
        assert!(listing.contains("document feeder"), "{listing}");
        assert!(listing.contains("minutes"), "{listing}");
    }
}
