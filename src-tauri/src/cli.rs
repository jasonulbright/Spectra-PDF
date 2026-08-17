//! CLI / headless mode for Spectra PDF.
//!
//! When operation flags are present in argv, the app runs headless:
//! no Tauri runtime, no window — just Python engine over JSON-RPC,
//! results on stdout, exit code on completion.

use clap::{ArgGroup, Args, Parser, Subcommand};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// ── CLI argument definitions ────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "spectrapdf",
    version = env!("CARGO_PKG_VERSION"),
    about = "Spectra PDF — modern PDF manipulation studio",
    long_about = "When invoked without a subcommand, the GUI launches.\n\
                  Use a subcommand to run headless from the command line."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<CliCommand>,

    /// Start the GUI minimized to the system tray (used by Start with Windows).
    #[arg(long)]
    pub minimized: bool,
}

#[derive(Subcommand)]
pub enum CliCommand {
    /// Compress a PDF using Ghostscript
    Compress(CompressArgs),
    /// Rotate pages in a PDF
    Rotate(RotateArgs),
    /// Split a PDF into parts by page ranges, a page count, a file size, or its top-level bookmarks
    Split(SplitArgs),
    /// Merge multiple files into one PDF (non-PDF inputs are converted first)
    Merge(MergeArgs),
    /// Create a PDF from any accepted source: images, Office/text/HTML
    /// documents, PostScript, PDFs and blank pages
    CreatePdf(CreatePdfArgs),
    /// Walk a tree and build ONE PDF from each folder of files, in page-number
    /// order, mirrored into a destination folder
    CreatePdfFolders(CreatePdfFoldersArgs),
    /// Encrypt a PDF with AES-256
    Encrypt(EncryptArgs),
    /// Decrypt a password-protected PDF
    Decrypt(DecryptArgs),
    /// Encrypt a PDF to recipient certificates (no shared password)
    EncryptCerts(EncryptCertsArgs),
    /// Decrypt a certificate-encrypted PDF with a PKCS#12 key file
    DecryptCert(DecryptCertArgs),
    /// Convert a PDF to PDF/A archival format
    Pdfa(PdfaArgs),
    /// Convert a PDF's colour to DeviceCMYK (ICC-managed)
    ConvertCmyk(ConvertCmykArgs),
    /// Produce a PDF/X print master with an output intent
    ConvertPdfx(ConvertPdfxArgs),
    /// Draw printer marks outside the trim (the page grows to hold them)
    PrinterMarks(PrinterMarksArgs),
    /// Remove printer marks and restore the recorded page boxes
    PrinterMarksRemove(PrinterMarksRemoveArgs),
    /// Report each page's boxes, its trim source, and whether it carries
    /// printer marks (JSON; writes nothing)
    PrinterMarksList(AccessibilityArgs),
    /// Report strokes thinner than a threshold on the device (JSON; writes
    /// nothing). Effective width is the `w` operand through the CTM scale
    HairlinesList(HairlinesListArgs),
    /// Raise every hairline stroke to a minimum device width
    HairlinesFix(HairlinesFixArgs),
    /// Report what a transparency flatten would rasterize, and where (JSON;
    /// writes nothing)
    FlattenList(FlattenListArgs),
    /// Flatten transparency by rasterizing only the regions that composite,
    /// leaving text and vectors outside them live
    Flatten(FlattenArgs),
    /// Report what converting text and strokes to outlines would do, and what
    /// it would refuse (JSON; writes nothing)
    OutlinesList(OutlinesListArgs),
    /// Report the in-RIP trapping vocabulary: every parameter, its type, its
    /// range and its initial value (JSON; writes nothing)
    TrapFields,
    /// Report the trapping presets a document carries and its Trapped value
    /// (JSON; writes nothing)
    TrapList(AccessibilityArgs),
    /// Assign an in-RIP trapping preset to a page range and set the Trapped
    /// declaration
    TrapAssign(TrapAssignArgs),
    /// Write the document as DSC PostScript, with each assigned range's
    /// trapping setup in its own page setup
    ExportPostscript(ExportPostscriptArgs),
    /// Extract text from a PDF
    ExtractText(ExtractTextArgs),
    /// Delete pages from a PDF
    Delete(DeleteArgs),
    /// Redact (true content removal, not just a visual box) a rectangular region on a page
    Redact(RedactArgs),
    /// Find a term, a word list or a built-in pattern and report GLYPH-ACCURATE page rectangles
    SearchRegions(SearchRegionsArgs),
    /// Find a term, a word list or a built-in pattern and redact EVERY hit
    /// (no review step exists headlessly). Use `--marks-only` to write
    /// reviewable /Redact annotations instead of removing content
    SearchRedact(SearchRedactArgs),
    /// Stamp a translucent text, image or PDF-page watermark across pages
    Watermark(WatermarkArgs),
    /// Add headers, footers, page numbers, and Bates numbering
    HeaderFooter(HeaderFooterArgs),
    /// Crop pages / edit the crop/bleed/trim/art boxes (per-edge insets)
    PageBox(PageBoxArgs),
    /// Set page-number labels (/PageLabels) — front matter as i/ii/iii, etc.
    PageLabels(PageLabelsArgs),
    /// Export annotations to an XFDF file
    XfdfExport(XfdfExportArgs),
    /// Import annotations from an XFDF file
    XfdfImport(XfdfImportArgs),
    /// Export a count/takeoff summary of the document's count marks as CSV
    CountSummary(CountSummaryArgs),
    /// List embedded file attachments (JSON)
    AttachList(AttachListArgs),
    /// Embed a file as an attachment
    AttachAdd(AttachAddArgs),
    /// Extract an embedded attachment to disk
    AttachExtract(AttachExtractArgs),
    /// Remove an embedded attachment
    AttachRemove(AttachRemoveArgs),
    /// Report whether a PDF is a portfolio + its member list (JSON)
    PortfolioInfo(PortfolioInfoArgs),
    /// Create a NEW PDF portfolio embedding the given files
    PortfolioCreate(PortfolioCreateArgs),
    /// Convert an existing PDF into a portfolio (adds /Collection)
    PortfolioMake(PortfolioMakeArgs),
    /// Replace a portfolio member's bytes from a file
    PortfolioUpdate(PortfolioUpdateArgs),
    /// Make ONE file searchable (invisible OCR text layers)
    OcrFile(OcrFileArgs),
    /// Deskew, despeckle, whiten and re-orient the scanned pages of a document
    EnhanceScan(EnhanceScanArgs),
    /// Run a guided action (a saved step sequence) over a folder of PDFs
    RunAction(RunActionArgs),
    /// List optional-content layers (JSON)
    LayerList(LayerListArgs),
    /// Show or hide a layer by index
    LayerSet(LayerSetArgs),
    /// Run the accessibility checker (JSON report)
    Accessibility(AccessibilityCheckArgs),
    /// Apply the accessibility fixes that need nothing authored. The authored
    /// ones (alt text, a table summary, a language, a field description) have
    /// no headless arm: a command line cannot supply a value it cannot see,
    /// and inventing one writes a placeholder, which is worse than none
    AccessibilityFix(AccessibilityFixArgs),
    /// Run print-production preflight (JSON report)
    Preflight(PreflightArgs),
    /// List the shipped preflight profiles and the check inventory (JSON)
    PreflightProfiles,
    /// Apply a preflight profile's fixups, in the engine's canonical order
    PreflightFix(PreflightFixArgs),
    /// Run a preflight profile over a folder — check it, or fix a mirrored copy
    PreflightSweep(PreflightSweepArgs),
    /// List every markup comment in the document (JSON)
    CommentsList(AccessibilityArgs),
    /// List every comment with its whole review model — dates, subject,
    /// state and reply thread — ordered and narrowed (JSON)
    CommentsReview(CommentsReviewArgs),
    /// Write a comment summary PDF — page images, entries and connector lines
    CommentsSummary(CommentsSummaryArgs),
    /// Delete all markup comments (keeps links and form fields)
    CommentsDeleteAll(CommentsDeleteArgs),
    /// List link regions (JSON)
    LinkList(AccessibilityArgs),
    /// Retarget a link to a URL (by page + index from link-list)
    LinkSet(LinkSetArgs),
    /// Delete a link (by page + index)
    LinkDelete(LinkDeleteArgs),
    /// Create a URL link over a rectangle (PDF user space)
    LinkAdd(LinkAddArgs),
    /// Create links over every web/email address found in the text
    LinkFromUrls(LinkFromUrlsArgs),
    /// List article threads (JSON)
    Articles(ArticlesArgs),
    /// Build the bookmark tree from the document's tagged headings
    OutlineFromStructure(OutlineFromStructureArgs),
    /// List the structure-tag tree (JSON; paths address tags for tags-*)
    TagsList(AccessibilityArgs),
    /// Set a tag's type / title / alt text / actual text / language
    TagsSet(TagsSetArgs),
    /// Move a tag: up, down, indent, outdent, or to a sibling index
    TagsMove(TagsMoveArgs),
    /// Delete a tag and its child tags (content stays, untagged)
    TagsDelete(TagsDeleteArgs),
    /// Create an empty structure tag under a parent
    TagsAdd(TagsAddArgs),
    /// List document-level JavaScript (the /Names /JavaScript tree) as JSON
    DocumentJsList(AccessibilityArgs),
    /// Replace the document-level JavaScript set from a JSON file ('-' = stdin)
    DocumentJsSet(DocumentJsSetArgs),
    /// Export a PDF to Word/HTML/RTF/ODT via bundled LibreOffice
    Export(ExportArgs),
    /// Export every PDF under a folder into a mirror tree (headless; what a
    /// scheduled run invokes)
    ExportFolder(ExportFolderArgs),
    /// Export PDF pages as raster images (PNG/JPEG per page, or multi-page TIFF)
    ExportImages(ExportImagesArgs),
    /// Compare the text of two PDFs (JSON diff report)
    Compare(CompareArgs),
    /// Verify the digital signatures in a PDF (JSON report; read-only)
    VerifySignatures(VerifySignaturesArgs),
    /// Sign a PDF (invisible, or a visible stamp) with a .pfx or PEM signer, written to a new file
    Sign(SignArgs),
    /// Generate a self-signed signing identity (.pfx with a new private key)
    GenerateSigner(GenerateSignerArgs),
    /// List AcroForm fields (JSON), or fill them with --set (and optionally --flatten)
    Forms(FormsArgs),
    /// Report where form fields could be added to a flat form (JSON); writes nothing
    DetectFields(DetectFieldsArgs),
    /// Detect a flat form's fields and CREATE every one of them (no review
    /// step exists headlessly). Use --kinds to narrow what is accepted
    PrepareForms(PrepareFormsArgs),
    /// Inventory the hidden information a PDF carries (JSON report); writes nothing
    Audit(AuditArgs),
    /// Remove the named categories of hidden information, writing a new file
    Sanitize(SanitizeArgs),
    /// Attribute every byte of a PDF to a category (JSON report); writes nothing
    AuditSpace(AuditSpaceArgs),
    /// Read the bookmark tree (JSON), or replace it with --from-json
    Outline(OutlineArgs),
    /// View or set PDF metadata
    Metadata(MetadataArgs),
    /// Convert a PDF to grayscale
    Grayscale(GrayscaleArgs),
    /// Optimize a PDF (linearize, strip metadata, compress streams)
    Optimize(OptimizeArgs),
    /// Set the PDF version
    PdfVersion(PdfVersionArgs),
    /// Repair a PDF (Tier 1: pikepdf/QPDF rewrite — fix xref, streams, page tree)
    Repair(RepairArgs),
    /// Build a structure tree for an UNTAGGED PDF heuristically (headings by
    /// size, paragraphs, figures; refine in the Tags / Reading Order panels)
    Autotag(AutotagArgs),
    /// OCR every PDF under a folder into a searchable mirror (headless; what a
    /// scheduled run invokes)
    BatchOcr(BatchOcrArgs),
    /// Rebuild a PDF (Tier 2: Ghostscript round-trip — re-render every page)
    Rebuild(RebuildArgs),
    /// Convert a PostScript/EPS file to PDF (distilling, via Ghostscript)
    Distill(DistillArgs),
    /// Recover pages from a damaged PDF (Tier 3: per-page salvage extraction)
    Recover(RecoverArgs),
    /// Validate PDF structure without modifying (JSON report)
    Check(CheckArgs),
    /// Process all PDFs in a directory (batch mode)
    Batch(BatchArgs),
    /// Print a PDF to a Windows printer (via bundled Ghostscript)
    Print(PrintArgs),
    /// List installed Windows printers (JSON: names + default)
    Printers(PrintersArgs),
    /// List connected scanners (JSON: ids + names)
    Scanners(ScannersArgs),
    /// Acquire pages from a scanner straight into a PDF
    Scan(ScanArgs),
    /// Apply an edited copy's annotate/fill/add-page changes onto a SIGNED
    /// original as one incremental append (signatures keep verifying)
    IncrementalSave(IncrementalSaveArgs),
}

#[derive(Args)]
pub struct IncrementalSaveArgs {
    /// The signed original PDF
    pub original: PathBuf,
    /// The edited (rewritten) copy whose changes to apply
    pub modified: PathBuf,
    /// Output file (must not be the original)
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct PrintersArgs {
    /// Also report one printer's capabilities (papers/duplex/color) as JSON
    #[arg(long, value_name = "PRINTER")]
    pub capabilities: Option<String>,
}

#[derive(Args)]
pub struct ScannersArgs {
    /// Also report one scanner's sources and settable properties as JSON
    #[arg(long, value_name = "DEVICE_ID")]
    pub capabilities: Option<String>,
}

#[derive(Args)]
pub struct ScanArgs {
    /// Device id from `spectrapdf scanners`. With exactly one scanner
    /// attached it may be omitted; with none or several the run refuses by
    /// name rather than guessing which machine has paper in it.
    #[arg(long, value_name = "DEVICE_ID")]
    pub device: Option<String>,
    /// Resolution in dpi. Omitted leaves the device's own current setting.
    #[arg(long)]
    pub dpi: Option<i32>,
    /// bw | gray | color | auto — offered only where the device lists it
    #[arg(long)]
    pub color: Option<String>,
    /// flatbed | feeder | duplex
    #[arg(long)]
    pub source: Option<String>,
    /// Sheets to take from the feeder; 0 means until it empties
    #[arg(long)]
    pub pages: Option<i32>,
    /// auto | letter | legal | tabloid | a3 | a4 | a5
    #[arg(long, default_value = "auto")]
    pub paper: String,
    /// Output PDF
    #[arg(short, long)]
    pub output: PathBuf,
    /// Resolution assumed for a page whose image stores none (dpi)
    #[arg(long, default_value_t = 300.0)]
    pub image_dpi: f64,
}

#[derive(Args)]
pub struct PrintArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Exact Windows printer name (see the `printers` subcommand)
    #[arg(short, long)]
    pub printer: String,
    /// Page range like "1-3,5" (default: all pages)
    #[arg(long, default_value = "")]
    pub pages: String,
    /// Number of copies (1-999)
    #[arg(long, default_value_t = 1)]
    pub copies: u32,
    /// Scale mode: "fit" (scale to paper), "actual" (100%), or "scale"
    /// (custom percentage via --scale)
    #[arg(long, default_value = "fit")]
    pub fit: String,
    /// Custom scale percentage (with --fit scale)
    #[arg(long, default_value_t = 100.0)]
    pub scale: f64,
    /// Print copies uncollated (1,1,2,2,... instead of 1,2,1,2,...)
    #[arg(long)]
    pub no_collate: bool,
    /// Page subset by document page number: all | odd | even
    #[arg(long, default_value = "all")]
    pub subset: String,
    /// Print back to front
    #[arg(long)]
    pub reverse: bool,
    /// Two-sided printing: printer | simplex | long | short
    #[arg(long, default_value = "printer")]
    pub duplex: String,
    /// Paper by DMPAPER id (see `printers --capabilities`)
    #[arg(long)]
    pub paper: Option<u16>,
    /// Page orientation: auto | portrait | landscape
    #[arg(long, default_value = "auto")]
    pub orientation: String,
    /// Color mode: printer | color | gray
    #[arg(long, default_value = "printer")]
    pub color: String,
    /// Comments & forms: all | document | stamps
    #[arg(long, default_value = "all")]
    pub comments: String,
    /// Rasterize before printing (compatibility mode)
    #[arg(long)]
    pub as_image: bool,
    /// Rasterization resolution for --as-image
    #[arg(long, default_value_t = 300)]
    pub image_dpi: u32,
    /// Page layout: single | nup | booklet | poster
    #[arg(long, default_value = "single")]
    pub layout: String,
    /// Rows per sheet (with --layout nup)
    #[arg(long, default_value_t = 2)]
    pub nup_rows: u32,
    /// Columns per sheet (with --layout nup)
    #[arg(long, default_value_t = 2)]
    pub nup_cols: u32,
    /// Cell order: horizontal | horizontal-reversed | vertical | vertical-reversed
    #[arg(long, default_value = "horizontal")]
    pub nup_order: String,
    /// Draw a border around each placed page
    #[arg(long)]
    pub nup_border: bool,
    /// Disable rotating pages to fit their cells better
    #[arg(long)]
    pub no_nup_auto_rotate: bool,
    /// Booklet sheet subset: both | front | back
    #[arg(long, default_value = "both")]
    pub booklet_subset: String,
    /// Booklet binding edge: left | right
    #[arg(long, default_value = "left")]
    pub booklet_binding: String,
    /// Poster tile scale percentage
    #[arg(long, default_value_t = 100.0)]
    pub poster_scale: f64,
    /// Poster tile overlap in points
    #[arg(long, default_value_t = 0.0)]
    pub poster_overlap: f64,
    /// Draw hairline cut marks on poster tiles
    #[arg(long)]
    pub poster_cut_marks: bool,
    /// Label poster tiles with their grid position
    #[arg(long)]
    pub poster_labels: bool,
    /// Sheet size override "WxH" in points (layout modes; default: the
    /// printer's chosen/default paper via DeviceCapabilities)
    #[arg(long, value_name = "WxH")]
    pub sheet: Option<String>,
}

#[derive(Args)]
pub struct CompressArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Compression quality: screen, ebook, printer, prepress, mrc
    #[arg(short, long, default_value = "ebook")]
    pub quality: String,
    /// Custom DPI (72-600). Overrides quality preset when set.
    #[arg(long)]
    pub dpi: Option<u32>,
    /// MRC preset (--quality mrc only): archival, balanced, smallest
    #[arg(long, default_value = "balanced")]
    pub mrc_preset: String,
    /// Force the MRC stencil codec: jbig2, jbig2-generic, ccitt
    #[arg(long)]
    pub mrc_mask_codec: Option<String>,
    /// Keep every MRC filter inside PDF/A-1's set
    #[arg(long)]
    pub mrc_pdfa_safe: bool,
    /// Recognise every MRC page and REVERT any whose text did not survive
    /// (--quality mrc only)
    #[arg(long)]
    pub mrc_verify_text: bool,
    /// Recognition language for --mrc-verify-text
    #[arg(long, default_value = "eng")]
    pub mrc_lang: String,
}

#[derive(Args)]
pub struct RotateArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Rotation angle (90, 180, 270)
    #[arg(short, long)]
    pub angle: i32,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Comma-separated page numbers (1-based), or "all"
    #[arg(short, long, default_value = "all")]
    pub pages: String,
}

#[derive(Args)]
pub struct SplitArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output directory
    #[arg(short, long)]
    pub output: PathBuf,
    /// How to divide the document: ranges, every-n, size, or bookmarks
    #[arg(long, default_value = "ranges", value_parser = ["ranges", "every-n", "size", "bookmarks"])]
    pub mode: String,
    /// Page ranges, e.g. "1-3,5-7" (ranges mode)
    #[arg(short, long)]
    pub ranges: Option<String>,
    /// Pages per output file (every-n mode)
    #[arg(long)]
    pub every_n: Option<u32>,
    /// Maximum size per output file, in MB (size mode). A page larger than
    /// the cap on its own is written alone and reported as oversize
    #[arg(long)]
    pub max_mb: Option<f64>,
}

#[derive(Args)]
pub struct MergeArgs {
    /// Input files (two or more). Anything Create PDF accepts — images,
    /// Word/Excel/PowerPoint, text, HTML, PostScript — is converted on the
    /// way in; a list of PDFs merges exactly as it always did.
    pub inputs: Vec<PathBuf>,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct CreatePdfArgs {
    /// Source files, in the order their pages will appear
    pub sources: Vec<PathBuf>,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Page size: auto (keep each source's own) | first | letter | legal |
    /// tabloid | a3 | a4 | a5
    #[arg(long, default_value = "auto")]
    pub page_size: String,
    /// Orientation: auto (follow the content) | portrait | landscape
    #[arg(long, default_value = "auto")]
    pub orientation: String,
    /// Margin in points kept around placed content when a page size is named
    #[arg(long, default_value_t = 0.0)]
    pub margin: f64,
    /// Resolution assumed for an image that stores none
    #[arg(long, default_value_t = 200.0)]
    pub image_dpi: f64,
    /// Append a blank page after the sources
    #[arg(long)]
    pub blank: bool,
    /// Ghostscript quality preset for PostScript sources:
    /// screen | ebook | printer | prepress | default
    #[arg(long, default_value = "printer")]
    pub quality: String,
    /// Report and skip a source nothing can convert instead of failing the run
    #[arg(long)]
    pub skip_unsupported: bool,
}

#[derive(Args)]
pub struct CreatePdfFoldersArgs {
    /// Folder tree to walk. Each directory holding accepted files becomes one
    /// PDF; a directory with none produces nothing and is not an error
    pub source: PathBuf,
    /// Folder the assembled PDFs are written to (must be outside SOURCE). A
    /// folder at `a/b` becomes `a/b.pdf`
    #[arg(short, long)]
    pub dest: PathBuf,
    /// Which files a folder contributes: images (default) | all
    #[arg(long, default_value = "images")]
    pub sources: String,
    /// Only the named folder itself, not the tree below it
    #[arg(long)]
    pub no_subfolders: bool,
    /// Page size: auto (keep each source's own) | first | letter | legal |
    /// tabloid | a3 | a4 | a5
    #[arg(long, default_value = "auto")]
    pub page_size: String,
    /// Orientation: auto (follow the content) | portrait | landscape
    #[arg(long, default_value = "auto")]
    pub orientation: String,
    /// Margin in points kept around placed content when a page size is named
    #[arg(long, default_value_t = 0.0)]
    pub margin: f64,
    /// Resolution assumed for an image that stores none
    #[arg(long, default_value_t = 200.0)]
    pub image_dpi: f64,
    /// Ghostscript quality preset for PostScript sources:
    /// screen | ebook | printer | prepress | default
    #[arg(long, default_value = "printer")]
    pub quality: String,
    /// Folder for the run log
    #[arg(long)]
    pub log_dir: Option<PathBuf>,
    /// Print per-folder progress
    #[arg(short, long)]
    pub verbose: bool,
}

#[derive(Args)]
pub struct EncryptArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Password to open the document
    #[arg(short, long)]
    pub password: String,
    /// Owner password (defaults to user password)
    #[arg(long)]
    pub owner_password: Option<String>,
    /// Disallow printing (owner permission)
    #[arg(long)]
    pub no_print: bool,
    /// Disallow copying text/graphics
    #[arg(long)]
    pub no_copy: bool,
    /// Disallow changing the document
    #[arg(long)]
    pub no_modify: bool,
    /// Disallow commenting and form filling
    #[arg(long)]
    pub no_annotate: bool,
}

#[derive(Args)]
pub struct DecryptArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Password to decrypt
    #[arg(short, long)]
    pub password: String,
}

#[derive(Args)]
pub struct EncryptCertsArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Recipient certificate file (.cer/.crt/.pem/.der) — repeat for multiple
    #[arg(short = 'c', long = "cert", required = true)]
    pub certs: Vec<PathBuf>,
    /// Disallow printing
    #[arg(long)]
    pub no_print: bool,
    /// Disallow copying text/graphics
    #[arg(long)]
    pub no_copy: bool,
    /// Disallow changing the document
    #[arg(long)]
    pub no_modify: bool,
    /// Disallow commenting and form filling
    #[arg(long)]
    pub no_annotate: bool,
}

#[derive(Args)]
pub struct DecryptCertArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// PKCS#12 key bundle (.pfx/.p12) holding a recipient's private key
    #[arg(long)]
    pub pfx: PathBuf,
    /// Password of the key bundle itself
    #[arg(short, long, default_value = "")]
    pub password: String,
}

#[derive(Args)]
pub struct ConvertCmykArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// ICC rendering intent: perceptual | relative | saturation | absolute
    #[arg(long, default_value = "relative")]
    pub render_intent: String,
    /// Destination ICC profile: a .icc file, or a bundled Ghostscript
    /// profile name like default_cmyk.icc. Omit for the built-in default.
    #[arg(long, default_value = "")]
    pub dest_profile: String,
}

#[derive(Args)]
pub struct ConvertPdfxArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// PDF/X standard: 1 (X-1a), 3 (X-3), 4 (X-4)
    #[arg(long, default_value_t = 3)]
    pub version: u32,
    /// Destination ICC profile to embed in the output intent (.icc file or a
    /// bundled Ghostscript profile name). Omit to name the condition only.
    #[arg(long, default_value = "")]
    pub dest_profile: String,
    /// Human-readable output condition
    #[arg(long, default_value = "Commercial and specialty printing")]
    pub condition: String,
    /// Registered characterization identifier (e.g. CGATS TR001, FOGRA39)
    #[arg(long, default_value = "CGATS TR001")]
    pub identifier: String,
}

#[derive(Args)]
pub struct PdfaArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// PDF/A conformance level: 1b, 2b, 3b
    #[arg(short, long, default_value = "2b")]
    pub level: String,
}

#[derive(Args)]
pub struct ExtractTextArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Comma-separated page numbers (1-based), or "all"
    #[arg(short, long, default_value = "all")]
    pub pages: String,
    /// Write the extracted text to this file (UTF-8, no BOM)
    #[arg(short, long)]
    pub output: Option<PathBuf>,
}

#[derive(Args)]
pub struct DeleteArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Comma-separated page numbers to delete (1-based)
    #[arg(short, long)]
    pub pages: String,
}

#[derive(Args)]
pub struct RedactArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// 1-based page number the region is on
    #[arg(short, long)]
    pub page: u32,
    /// Region rectangle in the page's own /MediaBox point space (not
    /// display-normalized, not rotation-adjusted): "x0,y0,x1,y1"
    #[arg(long)]
    pub rect: String,
    /// Box fill colour as #rrggbb (the /IC key). Default black.
    #[arg(long, default_value = "#000000")]
    pub fill: String,
    /// Text drawn over the box (the /OverlayText key) — e.g. a FOIA exemption
    /// code. Non-Latin-1 text embeds a font rather than being refused.
    #[arg(long, default_value = "")]
    pub overlay_text: String,
    /// Tile the overlay text to fill the box (the /Repeat key)
    #[arg(long, default_value_t = false)]
    pub repeat_overlay: bool,
    /// Overlay alignment (the /Q key): 0 left, 1 centred, 2 right
    #[arg(long, default_value_t = 0)]
    pub overlay_align: u8,
    /// Overlay font size in points; 0 fits the box
    #[arg(long, default_value_t = 0.0)]
    pub overlay_size: f64,
}

#[derive(Args)]
pub struct SearchRegionsArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Search term (combinable with --term and --pattern)
    #[arg(short, long, default_value = "")]
    pub query: String,
    /// A word-list term; repeatable. Terms are OR-ed into one search.
    #[arg(long = "term")]
    pub terms: Vec<String>,
    /// A built-in pattern id; repeatable (phone, email, credit_card, ssn,
    /// date, iban, nhs_uk, sin_ca, url). Additive to --query, never a replacement.
    #[arg(long = "pattern")]
    pub patterns: Vec<String>,
    /// Pages to search, e.g. "1,3,5" or "all"
    #[arg(long, default_value = "all")]
    pub pages: String,
    /// Treat the query as a regular expression
    #[arg(long, default_value_t = false)]
    pub regex: bool,
    /// Match case
    #[arg(long, default_value_t = false)]
    pub case_sensitive: bool,
    /// Match whole words only
    #[arg(long, default_value_t = false)]
    pub whole_word: bool,
    /// What each hit's rectangle covers: match | word | line
    #[arg(long, default_value = "match")]
    pub expand: String,
    /// Stop after this many hits (the result reports the truncation)
    #[arg(long, default_value_t = 50000)]
    pub max_hits: u32,
}

#[derive(Args)]
pub struct SearchRedactArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Search term (combinable with --term and --pattern)
    #[arg(short, long, default_value = "")]
    pub query: String,
    /// A word-list term; repeatable. Terms are OR-ed into one search.
    #[arg(long = "term")]
    pub terms: Vec<String>,
    /// A built-in pattern id; repeatable (phone, email, credit_card, ssn,
    /// date, iban, nhs_uk, sin_ca, url). Additive to --query, never a replacement.
    #[arg(long = "pattern")]
    pub patterns: Vec<String>,
    /// Pages to search, e.g. "1,3,5" or "all"
    #[arg(long, default_value = "all")]
    pub pages: String,
    /// Treat the query as a regular expression
    #[arg(long, default_value_t = false)]
    pub regex: bool,
    /// Match case
    #[arg(long, default_value_t = false)]
    pub case_sensitive: bool,
    /// Match whole words only
    #[arg(long, default_value_t = false)]
    pub whole_word: bool,
    /// What each hit's rectangle covers: match | word | line
    #[arg(long, default_value = "match")]
    pub expand: String,
    /// Stop after this many hits (the result reports the truncation)
    #[arg(long, default_value_t = 50000)]
    pub max_hits: u32,
    /// Write /Redact annotations for review instead of removing content
    #[arg(long, default_value_t = false)]
    pub marks_only: bool,
    /// Proceed on a document whose signatures this edit invalidates. A
    /// certification allowing no changes still refuses.
    #[arg(long, default_value_t = false)]
    pub include_signed: bool,
    /// Box fill colour as #rrggbb (the /IC key). Default black.
    #[arg(long, default_value = "#000000")]
    pub fill: String,
    /// Text drawn over each box (the /OverlayText key) — e.g. an exemption code
    #[arg(long, default_value = "")]
    pub overlay_text: String,
    /// Tile the overlay text to fill the box (the /Repeat key)
    #[arg(long, default_value_t = false)]
    pub repeat_overlay: bool,
    /// Overlay alignment (the /Q key): 0 left, 1 centred, 2 right
    #[arg(long, default_value_t = 0)]
    pub overlay_align: u8,
    /// Overlay font size in points; 0 fits the box
    #[arg(long, default_value_t = 0.0)]
    pub overlay_size: f64,
}

#[derive(Args)]
pub struct WatermarkArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Watermark text; text outside Latin-1 embeds a Unicode face, and is
    /// refused by name when no bundled face covers it — never mapped to '?'.
    /// Exactly one of --text, --image and --pdf-source is the source
    #[arg(short, long)]
    pub text: Option<String>,
    /// Picture to stamp instead of text; it embeds once and every page
    /// references the same image
    #[arg(long)]
    pub image: Option<PathBuf>,
    /// PDF whose page is stamped as VECTOR artwork (a letterhead, a pre-drawn
    /// stamp); the page embeds once and nothing is rasterized
    #[arg(long)]
    pub pdf_source: Option<PathBuf>,
    /// 1-based page of --pdf-source to stamp
    #[arg(long, default_value_t = 1)]
    pub pdf_page: i64,
    /// Fill/stroke alpha, 0 < opacity <= 1
    #[arg(long, default_value_t = 0.15)]
    pub opacity: f64,
    /// Degrees counter-clockwise in the page's DISPLAYED orientation (45 = diagonal)
    #[arg(long, default_value_t = 45.0)]
    pub angle: f64,
    /// Text color as #rrggbb
    #[arg(long, default_value = "#808080")]
    pub color: String,
    /// Font size in points; 0 auto-fits per page
    #[arg(long, default_value_t = 0.0)]
    pub font_size: f64,
    /// "over" (on top of content) or "under" (behind it)
    #[arg(long, default_value = "over")]
    pub layer: String,
    /// Comma-separated 1-based page numbers (omit for all pages)
    #[arg(long)]
    pub pages: Option<String>,
    /// Multiplier on the auto fit (1 = as large as it goes without crowding
    /// the page); above 1 may bleed off the page
    #[arg(long, default_value_t = 1.0)]
    pub scale: f64,
    /// Where the stamp sits, named in the page's displayed orientation
    #[arg(long, default_value = "center", value_parser = [
        "center", "top-left", "top-center", "top-right", "middle-left",
        "middle-right", "bottom-left", "bottom-center", "bottom-right",
    ])]
    pub position: String,
    /// Points inset from the page edge for the non-centred positions
    #[arg(long, default_value_t = 36.0)]
    pub margin: f64,
    /// Repeat the stamp across the whole page; --position is then ignored
    #[arg(long)]
    pub tile: bool,
    /// Points between tiles
    #[arg(long, default_value_t = 24.0)]
    pub tile_gap: f64,
}

#[derive(Args)]
pub struct PageLabelsArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// A label range as "startPage:style[:prefix[:startAt]]" — style is one of
    /// D r R a A none. Repeatable. Omit all to CLEAR the labels.
    #[arg(long = "range")]
    pub ranges: Vec<String>,
}

#[derive(Args)]
pub struct AttachListArgs {
    /// Input PDF file
    pub input: PathBuf,
}

#[derive(Args)]
pub struct PortfolioInfoArgs {
    /// Input PDF file
    pub input: PathBuf,
}

#[derive(Args)]
pub struct OcrFileArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file (may equal the input for in-place)
    #[arg(short, long)]
    pub output: PathBuf,
    /// Tesseract language code (e.g. eng, deu, jpn)
    #[arg(long, default_value = "eng")]
    pub language: String,
    /// OPT-IN: MRC-compress the result AFTER recognition (scanned pages only)
    #[arg(long)]
    pub mrc: bool,
    /// MRC preset (--mrc only): archival, balanced, smallest
    #[arg(long, default_value = "balanced")]
    pub mrc_preset: String,
    /// OPT-IN (--mrc only): recognise each MRC page and revert any whose text
    /// did not survive
    #[arg(long)]
    pub mrc_verify_text: bool,
    /// OPT-IN: deskew, despeckle, whiten and re-orient the scanned pages
    /// BEFORE recognition — enhancement first is what raises OCR accuracy
    #[arg(long)]
    pub enhance: bool,
    /// Skip the orientation pass of --enhance (it needs the OSD model)
    #[arg(long)]
    pub no_orientation: bool,
}

#[derive(Args)]
pub struct EnhanceScanArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file (may equal the input for in-place)
    #[arg(short, long, required_unless_present = "analyze", conflicts_with = "analyze")]
    pub output: Option<PathBuf>,
    /// Report what every selected page measures and change nothing
    #[arg(long)]
    pub analyze: bool,
    /// Pages to work on as comma-separated numbers, e.g. 1,3,5 (default: all)
    #[arg(long)]
    pub pages: Option<String>,
    /// Skip the deskew pass
    #[arg(long)]
    pub no_deskew: bool,
    /// Skip the despeckle pass
    #[arg(long)]
    pub no_despeckle: bool,
    /// Skip the background-whitening pass
    #[arg(long)]
    pub no_background: bool,
    /// Skip the orientation pass (it needs the OSD model)
    #[arg(long)]
    pub no_orientation: bool,
    /// Largest skew to search for, in degrees (0.1-45)
    #[arg(long, default_value_t = 10.0)]
    pub max_skew: f64,
    /// Smallest skew worth rotating for, in degrees — below it the angle is
    /// reported and the page is left unresampled
    #[arg(long, default_value_t = 0.1)]
    pub min_skew: f64,
    /// Largest speck to remove, in inches (0.001-0.05)
    #[arg(long, default_value_t = 0.01)]
    pub speck_size: f64,
    /// A speck must have no other ink within this distance, in inches
    #[arg(long, default_value_t = 0.02)]
    pub speck_gap: f64,
    /// Background whitening strength, 0-1
    #[arg(long, default_value_t = 1.0)]
    pub background_strength: f64,
    /// Orientation confidence floor — a weaker reading is reported, not applied
    #[arg(long, default_value_t = 2.0)]
    pub osd_confidence: f64,
    /// JPEG quality for the re-encoded raster (1-100)
    #[arg(long, default_value_t = 85)]
    pub jpeg_quality: u32,
}

#[derive(Args)]
pub struct RunActionArgs {
    /// Source folder (searched recursively for PDFs; never modified unless --in-place)
    pub source: PathBuf,
    /// Destination folder — processed copies mirror the source tree here
    #[arg(short, long, required_unless_present = "in_place", conflicts_with = "in_place")]
    pub dest: Option<PathBuf>,
    /// DESTRUCTIVE: replace each original with its processed version
    /// (staged beside it, verified, then swapped — no destination folder)
    #[arg(long)]
    pub in_place: bool,
    /// The action as JSON: {"name": "...", "steps": [{"op": "...", "params": {...}}]}
    /// — the same shape the app saves
    #[arg(long)]
    pub action: PathBuf,
    /// OPT-IN: move each processed original into this folder (the watched-
    /// folder In → Out → Done shape; mirror mode only)
    #[arg(long, conflicts_with = "in_place")]
    pub moved: Option<PathBuf>,
    /// Where the run log is written (default: no log from the CLI)
    #[arg(long)]
    pub log_dir: Option<PathBuf>,
}

#[derive(Args)]
pub struct PortfolioCreateArgs {
    /// Member files to embed (at least one)
    #[arg(required = true)]
    pub inputs: Vec<PathBuf>,
    /// Output portfolio PDF
    #[arg(short, long)]
    pub output: PathBuf,
    /// Portfolio title (defaults to the output file name)
    #[arg(long)]
    pub title: Option<String>,
}

#[derive(Args)]
pub struct PortfolioMakeArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct PortfolioUpdateArgs {
    /// Input portfolio PDF
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// The member name to replace (from portfolio-info)
    #[arg(long)]
    pub name: String,
    /// The file whose bytes replace the member's
    #[arg(long)]
    pub source: PathBuf,
    /// New description (omit to keep the existing one)
    #[arg(long)]
    pub description: Option<String>,
}

#[derive(Args)]
pub struct LayerListArgs {
    /// Input PDF file
    pub input: PathBuf,
}

#[derive(Args)]
pub struct AccessibilityArgs {
    /// Input PDF file
    pub input: PathBuf,
}

#[derive(Args)]
pub struct AccessibilityCheckArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Run one category only: document, page_content, forms, alt_text,
    /// tables, lists or headings. Every other check still appears, reporting
    /// not_applicable, so the report has one shape
    #[arg(long)]
    pub category: Option<String>,
}

#[derive(Args)]
pub struct PreflightArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// A shipped profile id (see `preflight-profiles`). Defaults to the
    /// sheetfed offset profile
    #[arg(long)]
    pub profile: Option<String>,
    /// A profile JSON file. Give either this or --profile, never both: two
    /// rules is no rule
    #[arg(long)]
    pub profile_path: Option<PathBuf>,
}

#[derive(Args)]
pub struct PreflightFixArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// A shipped profile id (see `preflight-profiles`). Defaults to the
    /// sheetfed offset profile
    #[arg(long)]
    pub profile: Option<String>,
    /// A profile JSON file. Give either this or --profile, never both
    #[arg(long)]
    pub profile_path: Option<PathBuf>,
    /// A check id (or a fixup id) to repair; repeatable. Omit for every
    /// fixup the profile carries. The ORDER is the engine's either way
    #[arg(long = "fix")]
    pub fixes: Vec<String>,
}

#[derive(Args)]
pub struct PreflightSweepArgs {
    /// Source folder (searched recursively for PDFs; never modified unless
    /// --in-place)
    pub source: PathBuf,
    /// Destination folder — reports, and in fix mode the fixed copies, mirror
    /// the source tree here
    #[arg(short, long, required_unless_present = "in_place", conflicts_with = "in_place")]
    pub dest: Option<PathBuf>,
    /// Repair each mirrored copy with the profile's fixups and re-check it.
    /// Without it the sweep only measures
    #[arg(long)]
    pub fix: bool,
    /// DESTRUCTIVE: replace each original with its fixed version (fix mode
    /// only; staged beside it, verified, then swapped)
    #[arg(long, requires = "fix")]
    pub in_place: bool,
    /// A shipped profile id (see `preflight-profiles`)
    #[arg(long)]
    pub profile: Option<String>,
    /// A profile JSON file. Give either this or --profile, never both
    #[arg(long)]
    pub profile_path: Option<PathBuf>,
    /// OPT-IN: move each processed original into this folder (the watched-
    /// folder In -> Out -> Done shape; fix mode, mirror only)
    #[arg(long, conflicts_with = "in_place", requires = "fix")]
    pub moved: Option<PathBuf>,
    /// Where the run log is written (default: no log from the CLI)
    #[arg(long)]
    pub log_dir: Option<PathBuf>,
}

#[derive(Args)]
pub struct AccessibilityFixArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// A check id to fix; repeatable. Omit for every automatic fix
    #[arg(long = "fix")]
    pub fixes: Vec<String>,
    /// Repair signed documents too. A repair rewrites the file, so it
    /// invalidates every signature it carries — the run has to say so
    #[arg(long)]
    pub allow_signed: bool,
}

#[derive(Args)]
pub struct DocumentJsSetArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// JSON array of {"name","js"} objects, from a file or '-' for stdin.
    /// An empty array removes every document-level script.
    #[arg(long = "from-json")]
    pub from_json: String,
}

#[derive(Args)]
pub struct CommentsDeleteArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct CommentsReviewArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Order: page (default), author, date or type. Ties always break to
    /// document order, so the ordering is total
    #[arg(long, default_value = "page")]
    pub sort: String,
    /// Keep only these authors (repeatable)
    #[arg(long = "author")]
    pub authors: Vec<String>,
    /// Keep only these comment subtypes, e.g. Highlight (repeatable)
    #[arg(long = "type")]
    pub subtypes: Vec<String>,
    /// Keep only these review states, e.g. Accepted (repeatable)
    #[arg(long = "state")]
    pub states: Vec<String>,
    /// Keep only comments on these pages, e.g. 1,3,5-9
    #[arg(long)]
    pub pages: Option<String>,
    /// Keep only comments that carry text
    #[arg(long)]
    pub with_body: bool,
}

#[derive(Args)]
pub struct CommentsSummaryArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file — the summary document
    #[arg(short, long)]
    pub output: PathBuf,
    /// comments_only or document_and_comments (default)
    #[arg(long, default_value = "document_and_comments")]
    pub mode: String,
    /// Where the comment column goes: auto (default), beside, beneath or
    /// separate
    #[arg(long, default_value = "auto")]
    pub placement: String,
    /// Draw no lines from a comment's position to its entry
    #[arg(long)]
    pub no_connectors: bool,
    /// Comment column width (or height, beneath) in points
    #[arg(long, default_value = "216")]
    pub gutter: f64,
    /// Sheet size: letter (default), legal, tabloid, a3, a4 or a5
    #[arg(long, default_value = "letter")]
    pub paper: String,
    /// Order: page (default), author, date or type
    #[arg(long, default_value = "page")]
    pub sort: String,
    /// Keep only these authors (repeatable)
    #[arg(long = "author")]
    pub authors: Vec<String>,
    /// Keep only these comment subtypes (repeatable)
    #[arg(long = "type")]
    pub subtypes: Vec<String>,
    /// Keep only these review states (repeatable)
    #[arg(long = "state")]
    pub states: Vec<String>,
    /// Keep only comments on these pages, e.g. 1,3,5-9
    #[arg(long)]
    pub pages: Option<String>,
    /// Keep only comments that carry text
    #[arg(long)]
    pub with_body: bool,
}

#[derive(Args)]
pub struct LinkSetArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// 1-based page
    #[arg(long)]
    pub page: i64,
    /// 0-based link index on the page (from link-list)
    #[arg(long)]
    pub index: i64,
    /// The URL to target
    #[arg(long)]
    pub url: String,
}

/// Tag paths are the comma-separated child indexes tags-list reports,
/// e.g. "0,2,1". An empty string names the tree root (tags-add only).
fn parse_tag_path(spec: &str) -> Result<Vec<u64>, String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    trimmed
        .split(',')
        .map(|part| {
            part.trim()
                .parse::<u64>()
                .map_err(|_| format!("invalid tag path component '{}'", part.trim()))
        })
        .collect()
}

#[derive(Args)]
pub struct TagsSetArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Tag path from tags-list, e.g. "0,2,1"
    #[arg(long)]
    pub path: String,
    /// New tag type (e.g. P, H1, Figure)
    #[arg(long = "type")]
    pub tag_type: Option<String>,
    /// Title (empty string clears)
    #[arg(long)]
    pub title: Option<String>,
    /// Alt text (empty string clears)
    #[arg(long)]
    pub alt: Option<String>,
    /// Actual text (empty string clears)
    #[arg(long)]
    pub actual_text: Option<String>,
    /// Language, e.g. en-US (empty string clears)
    #[arg(long)]
    pub lang: Option<String>,
}

#[derive(Args)]
pub struct TagsMoveArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Tag path from tags-list, e.g. "0,2,1"
    #[arg(long)]
    pub path: String,
    /// Direction: up, down, indent, outdent, to
    #[arg(long)]
    pub direction: String,
    /// Target sibling index (direction "to" only)
    #[arg(long)]
    pub index: Option<u64>,
}

#[derive(Args)]
pub struct TagsDeleteArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Tag path from tags-list, e.g. "0,2,1"
    #[arg(long)]
    pub path: String,
}

#[derive(Args)]
pub struct TagsAddArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Parent tag path ("" = the tree root)
    #[arg(long, default_value = "")]
    pub parent: String,
    /// The new tag's type (e.g. Sect, P, Figure)
    #[arg(long = "type")]
    pub tag_type: String,
    /// Child position under the parent (default: last)
    #[arg(long)]
    pub index: Option<u64>,
}

#[derive(Args)]
pub struct ExportArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output file (extension should match the format)
    #[arg(short, long)]
    pub output: PathBuf,
    /// Target format: docx, rtf, odt, html, xhtml, txt, xlsx, pptx
    #[arg(short, long, default_value = "docx")]
    pub format: String,
    /// Page range like "1,3" or "all" (txt, xlsx, pptx)
    #[arg(long, default_value = "")]
    pub pages: String,
    /// Text ordering: reading or layout (txt only)
    #[arg(long)]
    pub layout: Option<String>,
    /// Write a form feed between pages (txt only)
    #[arg(long)]
    pub page_breaks: bool,
    /// Sheet grouping: table or page (xlsx only)
    #[arg(long)]
    pub sheet_per: Option<String>,
    /// Add a sheet carrying the text no table claimed (xlsx only)
    #[arg(long)]
    pub include_untabled: bool,
    /// Slide dimensions: page, 16:9 or 4:3 (pptx only)
    #[arg(long)]
    pub slide_size: Option<String>,
}

/// Folder-scope export. A folder verb of its own rather than a `batch`
/// operation, and for the reason `batch-ocr` is one: the whole run is ONE
/// engine call, so this, a watched folder and a scheduled run behave and log
/// identically. The engine runs it as a one-step action, so there is a single
/// implementation of the walk, the mirror and the per-file isolation.
#[derive(Args)]
pub struct ExportFolderArgs {
    /// Folder of PDFs to export (searched recursively)
    pub source: PathBuf,
    /// Folder the exports are written to (must be outside SOURCE)
    #[arg(short, long)]
    pub dest: PathBuf,
    /// Target format: docx, rtf, odt, html, xhtml, txt, xlsx, pptx, png, jpeg, tiff
    #[arg(short, long, default_value = "docx")]
    pub format: String,
    /// Page range: "1,3" for the document targets, "1-3,5" for the image ones
    #[arg(long, default_value = "")]
    pub pages: String,
    /// Text ordering: reading or layout (txt only)
    #[arg(long)]
    pub layout: Option<String>,
    /// Write a form feed between pages (txt only)
    #[arg(long)]
    pub page_breaks: bool,
    /// Sheet grouping: table or page (xlsx only)
    #[arg(long)]
    pub sheet_per: Option<String>,
    /// Add a sheet carrying the text no table claimed (xlsx only)
    #[arg(long)]
    pub include_untabled: bool,
    /// Slide dimensions: page, 16:9 or 4:3 (pptx only)
    #[arg(long)]
    pub slide_size: Option<String>,
    /// Render resolution in dpi (image targets only)
    #[arg(long, default_value_t = 150)]
    pub dpi: u32,
    /// Render in grayscale (image targets only)
    #[arg(long)]
    pub gray: bool,
    /// JPEG quality 1-100 (jpeg only)
    #[arg(long, default_value_t = 90)]
    pub quality: u32,
    /// Folder the run log is written to (default: the app's log folder)
    #[arg(long)]
    pub log_dir: Option<PathBuf>,
    /// Print one line per file as the run walks the tree
    #[arg(short, long)]
    pub verbose: bool,
}

#[derive(Args)]
pub struct ExportImagesArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output name (png/jpeg: the per-page naming template; tiff: the one file)
    #[arg(short, long)]
    pub output: PathBuf,
    /// Image format: png, jpeg, tiff
    #[arg(short, long, default_value = "png")]
    pub format: String,
    /// Render resolution in dpi (18-1200)
    #[arg(long, default_value_t = 150)]
    pub dpi: u32,
    /// Page range like "1-3,5" (default: all pages)
    #[arg(long, default_value = "")]
    pub pages: String,
    /// Render in grayscale
    #[arg(long)]
    pub gray: bool,
    /// JPEG quality 1-100
    #[arg(long, default_value_t = 90)]
    pub quality: u32,
}

#[derive(Args)]
pub struct LinkAddArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// 1-based page
    #[arg(long)]
    pub page: i64,
    /// Link rectangle in PDF user space: x0 y0 x1 y1
    #[arg(long, num_args = 4, value_names = ["X0", "Y0", "X1", "Y1"])]
    pub rect: Vec<f64>,
    /// The URL the link opens
    #[arg(long)]
    pub url: String,
}

#[derive(Args)]
pub struct LinkDeleteArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// 1-based page
    #[arg(long)]
    pub page: i64,
    /// 0-based link index on the page
    #[arg(long)]
    pub index: i64,
}

#[derive(Args)]
pub struct LinkFromUrlsArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file (omit with --preview to only report what was found)
    #[arg(short, long, required_unless_present = "preview")]
    pub output: Option<PathBuf>,
    /// Pages to scan, e.g. "1,3,5" or "all"
    #[arg(long, default_value = "all")]
    pub pages: String,
    /// Do not link bare email addresses
    #[arg(long)]
    pub no_emails: bool,
    /// Also link an address an existing link already covers
    #[arg(long)]
    pub relink_existing: bool,
    /// Report what would be linked and write nothing
    #[arg(long)]
    pub preview: bool,
}

#[derive(Args)]
pub struct ArticlesArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file (required with --from-json; omit to just read)
    #[arg(short, long)]
    pub output: Option<PathBuf>,
    /// Replace the articles from a JSON file ('-' reads stdin). Accepts the
    /// same shape `articles <input>` prints ({"threads": [...]} or a bare
    /// array of {title, author, beads: [{page, rect}]} items).
    #[arg(long = "from-json", value_name = "FILE")]
    pub from_json: Option<String>,
}

#[derive(Args)]
pub struct OutlineFromStructureArgs {
    /// Input PDF file (tagged, unless --autotag is given)
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Keep the existing bookmarks and add the derived ones after them
    #[arg(long)]
    pub append: bool,
    /// Deepest heading level to turn into a bookmark (1-6)
    #[arg(long, default_value_t = 6)]
    pub levels: u32,
    /// Tag the document automatically first when it carries no tags
    #[arg(long)]
    pub autotag: bool,
}

#[derive(Args)]
pub struct LayerSetArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// 0-based layer index (from layer-list)
    #[arg(long)]
    pub index: i64,
    /// Show the layer (default hides it)
    #[arg(long)]
    pub show: bool,
}

#[derive(Args)]
pub struct XfdfExportArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output XFDF file
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct XfdfImportArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// The XFDF file whose annotations to add
    #[arg(long)]
    pub xfdf: PathBuf,
}

#[derive(Args)]
pub struct CountSummaryArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output CSV file
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct AttachAddArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Path of the file to embed
    #[arg(short, long)]
    pub source: PathBuf,
    /// Embedded name (defaults to the source's base name)
    #[arg(long)]
    pub name: Option<String>,
    /// Optional description
    #[arg(long)]
    pub description: Option<String>,
}

#[derive(Args)]
pub struct AttachExtractArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Attachment name to extract
    #[arg(long)]
    pub name: String,
    /// Output path for the extracted file
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct AttachRemoveArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Attachment name to remove
    #[arg(long)]
    pub name: String,
}

#[derive(Args)]
pub struct HeaderFooterArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Top-left text (tokens: {page} {pages} {bates})
    #[arg(long)]
    pub tl: Option<String>,
    /// Top-center text
    #[arg(long)]
    pub tc: Option<String>,
    /// Top-right text
    #[arg(long)]
    pub tr: Option<String>,
    /// Bottom-left text
    #[arg(long)]
    pub bl: Option<String>,
    /// Bottom-center text
    #[arg(long)]
    pub bc: Option<String>,
    /// Bottom-right text
    #[arg(long)]
    pub br: Option<String>,
    /// First 1-based page to stamp
    #[arg(long, default_value_t = 1)]
    pub first_page: i64,
    /// Last 1-based page to stamp (omit for the last page)
    #[arg(long)]
    pub last_page: Option<i64>,
    /// Font size in points
    #[arg(long, default_value_t = 10.0)]
    pub font_size: f64,
    /// Inset from the page edges, points
    #[arg(long, default_value_t = 24.0)]
    pub margin: f64,
    /// Text color as #rrggbb
    #[arg(long, default_value = "#000000")]
    pub color: String,
    /// First value of the {bates} counter
    #[arg(long, default_value_t = 1)]
    pub bates_start: i64,
    /// Zero-pad width of the {bates} counter
    #[arg(long, default_value_t = 6)]
    pub bates_digits: i64,
}

#[derive(Args)]
pub struct PrinterMarksArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Comma-separated marks: crop, registration, colorbars, pageinfo
    #[arg(long, default_value = "crop,registration,colorbars,pageinfo")]
    pub marks: String,
    /// Mark style: western or japanese
    #[arg(long, default_value = "western")]
    pub style: String,
    /// Stroke weight in points: 0.125, 0.25 or 0.5
    #[arg(long, default_value_t = 0.25)]
    pub weight: f64,
    /// Gap between the trim edge and the start of a mark, in points
    #[arg(long, default_value_t = 9.0)]
    pub offset: f64,
    /// How far a mark runs outward from the offset, in points. The page grows
    /// by offset + length on every edge
    #[arg(long, default_value_t = 18.0)]
    pub length: f64,
    /// Comma-separated 1-based page numbers (omit for all pages)
    #[arg(long)]
    pub pages: Option<String>,
}

#[derive(Args)]
pub struct PrinterMarksRemoveArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Comma-separated 1-based page numbers (omit for all pages)
    #[arg(long)]
    pub pages: Option<String>,
}

#[derive(Args)]
pub struct HairlinesListArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Strokes thinner than this device width (points) are hairlines
    #[arg(long, default_value_t = 0.25)]
    pub threshold: f64,
    /// Comma-separated 1-based page numbers (omit for all pages)
    #[arg(long)]
    pub pages: Option<String>,
    /// Skip annotation border widths and appearance-stream strokes
    #[arg(long)]
    pub skip_annotations: bool,
}

#[derive(Args)]
pub struct HairlinesFixArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Strokes thinner than this device width (points) are hairlines
    #[arg(long, default_value_t = 0.25)]
    pub threshold: f64,
    /// Device width (points) a corrected stroke lands on; may not be below
    /// the threshold
    #[arg(long, default_value_t = 0.25)]
    pub replacement: f64,
    /// Comma-separated 1-based page numbers (omit for all pages)
    #[arg(long)]
    pub pages: Option<String>,
    /// Skip annotation border widths and appearance-stream strokes
    #[arg(long)]
    pub skip_annotations: bool,
}

#[derive(Args)]
pub struct FlattenListArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Raster/vector balance, 0.0 (most live content) to 1.0 (fewest regions)
    #[arg(long, default_value_t = 0.5)]
    pub balance: f64,
    /// Resolution the regions rasterize at, and snap their edges against
    #[arg(long, default_value_t = 150)]
    pub dpi: i64,
    /// Comma-separated 1-based page numbers (omit for all pages)
    #[arg(long)]
    pub pages: Option<String>,
}

#[derive(Args)]
pub struct OutlinesListArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Comma-separated 1-based page numbers (omit for all pages)
    #[arg(long)]
    pub pages: Option<String>,
}

#[derive(Args)]
pub struct FlattenArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Raster/vector balance, 0.0 (most live content) to 1.0 (fewest regions)
    #[arg(long, default_value_t = 0.5)]
    pub balance: f64,
    /// Resolution the regions rasterize at, and snap their edges against
    #[arg(long, default_value_t = 150)]
    pub dpi: i64,
    /// Comma-separated 1-based page numbers (omit for all pages)
    #[arg(long)]
    pub pages: Option<String>,
    /// Replace every surviving glyph run with its outlines. Converted text can
    /// no longer be selected, searched or extracted
    #[arg(long)]
    pub outline_text: bool,
    /// Replace every surviving stroke with the filled outline of the region
    /// the pen covered
    #[arg(long)]
    pub outline_strokes: bool,
}

#[derive(Args)]
pub struct TrapAssignArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Preset name, as it appears in the document's assignment list
    #[arg(long, default_value = "")]
    pub name: String,
    /// First page of the range
    #[arg(long, default_value_t = 1)]
    pub first: i64,
    /// Last page of the range (defaults to the first)
    #[arg(long)]
    pub last: Option<i64>,
    /// Trapping parameters as a JSON object over the in-RIP vocabulary; see
    /// `trap-fields` for the parameter names, types and ranges
    #[arg(long, default_value = "{}")]
    pub params: String,
    /// The DocInfo Trapped declaration: Unknown, False or True. Assigning a
    /// preset adds no trap network, so True is an assertion about work done
    /// elsewhere
    #[arg(long, default_value = "Unknown")]
    pub trapped: String,
}

#[derive(Args)]
pub struct ExportPostscriptArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output .ps file
    #[arg(short, long)]
    pub output: PathBuf,
    /// PostScript language level, 2 or 3. In-RIP trapping needs level 3
    #[arg(long, default_value_t = 3)]
    pub level: i64,
    /// Comma-separated 1-based page numbers (omit for all pages)
    #[arg(long)]
    pub pages: Option<String>,
    /// Write the PostScript without the document's trapping setup
    #[arg(long)]
    pub no_trapping: bool,
}

#[derive(Args)]
pub struct PageBoxArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Which box to edit: crop, bleed, trim, or art
    #[arg(long = "box", default_value = "crop")]
    pub box_: String,
    /// Points to trim from the top edge (negative expands)
    #[arg(long, default_value_t = 0.0)]
    pub top: f64,
    /// Points to trim from the bottom edge
    #[arg(long, default_value_t = 0.0)]
    pub bottom: f64,
    /// Points to trim from the left edge
    #[arg(long, default_value_t = 0.0)]
    pub left: f64,
    /// Points to trim from the right edge
    #[arg(long, default_value_t = 0.0)]
    pub right: f64,
    /// Comma-separated 1-based page numbers (omit for all pages)
    #[arg(long)]
    pub pages: Option<String>,
    /// Crop to each page's own content instead of by per-edge insets
    #[arg(long)]
    pub auto: bool,
    /// Points of paper to keep around the content (--auto only)
    #[arg(long, default_value_t = 0.0)]
    pub margin: f64,
    /// Report what --auto would write, without writing it
    #[arg(long)]
    pub preview: bool,
}

#[derive(Args)]
pub struct CompareArgs {
    /// First (baseline) PDF file
    pub a: PathBuf,
    /// Second (changed) PDF file
    pub b: PathBuf,
    /// Unchanged lines of context to keep around each change (text mode)
    #[arg(long, default_value_t = 3)]
    pub context: u32,
    /// Visual (pixel) diff instead of text: rasterizes both PDFs (bundled
    /// Ghostscript) and reports per-page-pair diff counts and changed-region
    /// rectangles in PDF points
    #[arg(long)]
    pub visual: bool,
    /// Raster resolution for --visual (36-300; 72 = 1 px per point)
    #[arg(long, default_value_t = 72)]
    pub dpi: u32,
}

#[derive(Args)]
pub struct VerifySignaturesArgs {
    /// PDF file to verify
    pub input: PathBuf,
    /// Trust anchor certificate file(s) (PEM/DER) the signer chain must reach
    /// (repeatable). Without any, and without --system-trust, `trusted` is
    /// deterministically false.
    #[arg(long = "trust-root")]
    pub trust_roots: Vec<PathBuf>,
    /// Also anchor on the operating system's certificate store, respecting the
    /// purpose (EKU) restrictions it records. Off unless given; the store is
    /// not read at all without it.
    #[arg(long)]
    pub system_trust: bool,
    /// Also anchor on the bundled EU trusted-list certificates, per service
    /// purpose. Off unless given; the bundle ships with the app and nothing is
    /// downloaded.
    #[arg(long)]
    pub eutl_trust: bool,
}

#[derive(Args)]
pub struct SignArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file (must differ from the input; signing appends a revision)
    #[arg(short, long)]
    pub output: PathBuf,
    /// PKCS#12 (.pfx/.p12) signer file (key + certificate)
    #[arg(long, conflicts_with_all = ["key", "cert"])]
    pub pfx: Option<PathBuf>,
    /// PEM/DER private key file (use together with --cert)
    #[arg(long, requires = "cert")]
    pub key: Option<PathBuf>,
    /// PEM/DER certificate file — may be a fullchain file (signer first)
    #[arg(long, requires = "key")]
    pub cert: Option<PathBuf>,
    /// Passphrase for the signer (.pfx, or an encrypted PEM key). Omit to
    /// read it from stdin (keeps it out of the shell history and process
    /// list; prefer this for scripts).
    #[arg(long)]
    pub password: Option<String>,
    /// Optional signature reason
    #[arg(long)]
    pub reason: Option<String>,
    /// Optional signature location
    #[arg(long)]
    pub location: Option<String>,
    /// Draw a visible signature stamp on this page (1-based; requires --visible-rect)
    #[arg(long, requires = "visible_rect")]
    pub visible_page: Option<u32>,
    /// Visible stamp rectangle x0,y0,x1,y1 in PDF points (bottom-up, like `redact --rect`)
    #[arg(long, requires = "visible_page")]
    pub visible_rect: Option<String>,
    /// Fill an existing EMPTY signature field by name instead of creating a
    /// new one (the field's own widget rectangle provides the stamp box; a
    /// zero-size field signs invisibly). Refuses missing, non-signature, or
    /// already-signed fields.
    #[arg(long, conflicts_with_all = ["visible_page", "visible_rect"])]
    pub existing_field: Option<String>,
    /// Sign with the PAdES (ETSI.CAdES.detached) profile — B-B baseline
    #[arg(long)]
    pub pades: bool,
    /// RFC 3161 timestamp server URL (PAdES B-T when combined with --pades)
    #[arg(long)]
    pub tsa_url: Option<String>,
    /// Embed certificates + revocation info into the /DSS (PAdES B-LT; requires --pades)
    #[arg(long, requires = "pades")]
    pub embed_revocation: bool,
    /// Add a PAdES B-LTA document timestamp sealing the DSS (requires --pades and --tsa-url)
    #[arg(long, requires_all = ["pades", "tsa_url"])]
    pub lta: bool,
    /// Trust anchor certificate file(s) (PEM/DER) for revocation gathering (repeatable)
    #[arg(long = "trust-root")]
    pub trust_roots: Vec<PathBuf>,
    /// Also anchor revocation gathering on the operating system's certificate
    /// store (used with --embed-revocation)
    #[arg(long)]
    pub system_trust: bool,
    /// Also anchor revocation gathering on the bundled EU trusted-list
    /// certificates (used with --embed-revocation)
    #[arg(long)]
    pub eutl_trust: bool,
    /// PKCS#11 provider module (.dll) — sign with a hardware token/HSM.
    /// Use with --token-label and --cert-label; --password is the PIN.
    #[arg(long, conflicts_with_all = ["pfx", "key", "cert"], requires_all = ["token_label", "cert_label"])]
    pub pkcs11_module: Option<PathBuf>,
    /// Token label on the PKCS#11 module
    #[arg(long, requires = "pkcs11_module")]
    pub token_label: Option<String>,
    /// Certificate label on the token
    #[arg(long, requires = "pkcs11_module")]
    pub cert_label: Option<String>,
    /// Private-key label on the token (defaults to the certificate label)
    #[arg(long, requires = "pkcs11_module")]
    pub key_label: Option<String>,
    /// Apply a CERTIFICATION (author) signature, which records what may change
    /// in the document afterwards. At most one per document, and it must be the
    /// document's first signature.
    #[arg(long)]
    pub certify: bool,
    /// What the certification permits: none (no changes) | form-fill (form
    /// filling and signing) | annotate (form filling, signing and commenting).
    /// Defaults to form-fill.
    #[arg(long, requires = "certify", value_parser = ["none", "form-fill", "annotate"])]
    pub certify_level: Option<String>,
    /// Lock form fields against further change after signing: all | include
    /// (only those named by --lock-field) | exclude (all but those named).
    /// Independent of --certify.
    #[arg(long, value_parser = ["all", "include", "exclude"])]
    pub lock: Option<String>,
    /// A form field the lock names; repeatable. Fully qualified, and a name
    /// that scopes a subtree locks everything beneath it.
    #[arg(long = "lock-field", requires = "lock")]
    pub lock_field: Vec<String>,
}

#[derive(Args)]
// A named signature field states an INTENT; setting and clearing are the two,
// and they are exclusive. Grouping them lets the parser refuse a bare
// --sig-field, so no flag combination can clear a lock by omission.
#[command(group(ArgGroup::new("lock_intent").args(["lock", "clear_lock"]).multiple(false)))]
pub struct FormsArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file (required with --set/--flatten; omit to just list fields)
    #[arg(short, long)]
    pub output: Option<PathBuf>,
    /// Fill a field: NAME=VALUE (splits on the FIRST '='; repeatable).
    /// Checkboxes accept true/false/yes/no/on/off.
    #[arg(long = "set", value_name = "NAME=VALUE")]
    pub set: Vec<String>,
    /// Flatten after filling: bake appearances into page content and remove
    /// all form fields (locks the form)
    #[arg(long)]
    pub flatten: bool,
    /// An UNSIGNED signature field whose own field lock is being set — the seed
    /// whoever signs it later is bound by. Needs --lock or --clear-lock.
    #[arg(long = "sig-field", requires = "output", requires = "lock_intent")]
    pub sig_field: Option<String>,
    /// What that field's lock covers: all | include (only those named by
    /// --lock-field) | exclude (all but those named).
    #[arg(long, requires = "sig_field", value_parser = ["all", "include", "exclude"])]
    pub lock: Option<String>,
    /// A form field the lock names; repeatable. Fully qualified, and a name
    /// that scopes a subtree locks everything beneath it.
    #[arg(long = "lock-field", requires = "lock")]
    pub lock_field: Vec<String>,
    /// Remove the field's lock, leaving whoever signs it unbound.
    #[arg(long, requires = "sig_field", conflicts_with = "lock")]
    pub clear_lock: bool,
    /// Restore every field to its default value — the Reset Form action, run
    /// headlessly.
    #[arg(long, requires = "output")]
    pub reset: bool,
    /// Fill from a form-data file (FDF or XFDF). A name the document does not
    /// have is reported, not fatal.
    #[arg(long = "import-data", value_name = "FILE", requires = "output")]
    pub import_data: Option<PathBuf>,
    /// Write this document's field values out as form data — the Submit Form
    /// payload, built in full. Nothing is sent anywhere.
    #[arg(long = "export-data", value_name = "FILE")]
    pub export_data: Option<PathBuf>,
    /// The form-data format --export-data writes: fdf | xfdf | html | pdf.
    #[arg(
        long = "data-format",
        default_value = "fdf",
        value_parser = ["fdf", "xfdf", "html", "pdf"]
    )]
    pub data_format: String,
    /// Include fields with no value in --export-data (the submission flag a
    /// receiver sets when it wants to see the blanks).
    #[arg(long)]
    pub include_empty: bool,
    /// Scope --reset / --import-data / --export-data to these fields;
    /// repeatable. A name covers its children.
    #[arg(long = "field", value_name = "NAME")]
    pub field: Vec<String>,
    /// Invert --field into an exclude list.
    #[arg(long, requires = "field")]
    pub exclude_fields: bool,
}

#[derive(Args)]
pub struct DetectFieldsArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Pages to analyze, e.g. "1,3,5" or "all"
    #[arg(long, default_value = "all")]
    pub pages: String,
    /// Scanned-page handling: auto (recognise a page with nothing readable on
    /// it) | never (stay offline) | always (recognise every page)
    #[arg(long, default_value = "auto")]
    pub scan: String,
    /// Recognition language for scanned pages; '+'-joined for several at once
    #[arg(long, default_value = "eng")]
    pub lang: String,
    /// Stop after this many candidates (the result reports the truncation)
    #[arg(long, default_value_t = 5000)]
    pub max_candidates: u32,
}

#[derive(Args)]
pub struct PrepareFormsArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Pages to analyze, e.g. "1,3,5" or "all"
    #[arg(long, default_value = "all")]
    pub pages: String,
    /// Scanned-page handling: auto (recognise a page with nothing readable on
    /// it) | never (stay offline) | always (recognise every page)
    #[arg(long, default_value = "auto")]
    pub scan: String,
    /// Recognition language for scanned pages; '+'-joined for several at once
    #[arg(long, default_value = "eng")]
    pub lang: String,
    /// Comma-separated field kinds to create: text, checkbox, radio,
    /// signature. Every kind by default.
    #[arg(long, default_value = "")]
    pub kinds: String,
    /// Stop after this many candidates (the result reports the truncation)
    #[arg(long, default_value_t = 5000)]
    pub max_candidates: u32,
    /// Proceed on a document whose signatures this edit invalidates. A
    /// certification allowing no changes still refuses.
    #[arg(long, default_value_t = false)]
    pub include_signed: bool,
}

#[derive(Args)]
pub struct AuditArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Pages the per-page findings report on, e.g. "1,3,5" or "all". Removal
    /// is always document-wide; this scopes the report.
    #[arg(long, default_value = "all")]
    pub pages: String,
    /// Skip the content-stream analysis for text a reader cannot see. The
    /// report says so rather than reporting none.
    #[arg(long)]
    pub no_hidden_text: bool,
}

#[derive(Args)]
pub struct AuditSpaceArgs {
    /// Input PDF file. The report always covers the whole document: a
    /// per-page breakdown could not sum to the file size, and the sum IS the
    /// report's guarantee.
    pub input: PathBuf,
}

#[derive(Args)]
pub struct SanitizeArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    pub output: PathBuf,
    /// Comma-separated category ids to remove (from `audit`). Required unless
    /// --all-removable is given.
    #[arg(long, default_value = "")]
    pub categories: String,
    /// Select every category except the ones that cost the document
    /// something — form fields, the accessibility structure, and the
    /// recognized-text layer. Those must be named explicitly.
    #[arg(long)]
    pub all_removable: bool,
    /// What to do with form fields when they are selected
    #[arg(long, default_value = "remove", value_parser = ["remove", "flatten"])]
    pub form_fields_mode: String,
    /// Also remove the invisible text layer that makes a scan searchable
    #[arg(long)]
    pub include_ocr_layer: bool,
}

#[derive(Args)]
pub struct OutlineArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file (required with --from-json; omit to just read)
    #[arg(short, long)]
    pub output: Option<PathBuf>,
    /// Replace the bookmark tree from a JSON file ('-' reads stdin). Accepts
    /// the same shape `outline <input>` prints ({"outline": [...]} or a bare
    /// array of {title, page, children, action?} items).
    #[arg(long = "from-json", value_name = "FILE")]
    pub from_json: Option<String>,
}

#[derive(Args)]
pub struct GenerateSignerArgs {
    /// Signer display name (certificate common name)
    #[arg(long)]
    pub cn: String,
    /// Output .pfx path
    #[arg(short, long)]
    pub output: PathBuf,
    /// Passphrase protecting the generated .pfx. Omit to read from stdin.
    #[arg(long)]
    pub password: Option<String>,
    /// Optional organization name
    #[arg(long)]
    pub org: Option<String>,
    /// Certificate validity in days (default 3 years)
    #[arg(long, default_value_t = 1095)]
    pub days: u32,
    /// Overwrite an existing file (it may contain a private key — off by default)
    #[arg(long)]
    pub force: bool,
}

#[derive(Args)]
pub struct MetadataArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file (omit to just read metadata)
    #[arg(short, long)]
    pub output: Option<PathBuf>,
    /// Strip all metadata from the PDF
    #[arg(long)]
    pub strip: bool,
    /// Set document title
    #[arg(long)]
    pub title: Option<String>,
    /// Set document author
    #[arg(long)]
    pub author: Option<String>,
    /// Set document subject
    #[arg(long)]
    pub subject: Option<String>,
    /// Set document keywords
    #[arg(long)]
    pub keywords: Option<String>,
}

#[derive(Args)]
pub struct GrayscaleArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct DistillArgs {
    /// Input PostScript (.ps) or EPS (.eps) file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Quality preset: screen | ebook | printer | prepress | default
    #[arg(long, default_value = "printer")]
    pub preset: String,
}

#[derive(Args)]
pub struct OptimizeArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Enable web-optimized (linearized) output
    #[arg(long, default_value_t = true)]
    pub linearize: bool,
    /// Strip all metadata
    #[arg(long)]
    pub strip_metadata: bool,
    /// Compress object streams
    #[arg(long, default_value_t = true)]
    pub compress_streams: bool,
}

#[derive(Args)]
pub struct PdfVersionArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Target PDF version (1.4, 1.5, 1.6, 1.7)
    #[arg(short, long, default_value = "1.7")]
    pub version: String,
}

#[derive(Args)]
pub struct RepairArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct AutotagArgs {
    /// Input PDF file (must be untagged)
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct BatchOcrArgs {
    /// Folder of PDFs to make searchable (searched recursively)
    pub source: PathBuf,
    /// Folder the searchable copies are written to (must be outside SOURCE)
    #[arg(short, long, required_unless_present = "in_place", conflicts_with = "in_place")]
    pub dest: Option<PathBuf>,
    /// DESTRUCTIVE: replace each original with its searchable version
    /// (staged beside it, verified, then swapped — no destination folder)
    #[arg(long)]
    pub in_place: bool,
    /// Recognition language(s); '+'-join several, e.g. eng+fra. Not auto-detection.
    #[arg(short, long, default_value = "eng")]
    pub lang: String,
    /// OPT-IN: move each processed original into this folder (structure preserved)
    #[arg(long)]
    pub moved: Option<PathBuf>,
    /// OPT-IN: move each failed original into this folder (structure preserved)
    #[arg(long)]
    pub errors: Option<PathBuf>,
    /// OPT-IN: try a tier-1 repair on a file that will not open
    #[arg(long)]
    pub repair: bool,
    /// OPT-IN: write the repaired file back over the damaged original
    #[arg(long)]
    pub replace_repaired: bool,
    /// Folder for the run log. REQUIRED when scheduled under another account --
    /// the default app-data folder belongs to whoever ran the batch.
    #[arg(long)]
    pub log_dir: Option<PathBuf>,
    /// OPT-IN: MRC-compress each processed file AFTER recognition (scans only;
    /// a file with no scanned page keeps its bytes and says so)
    #[arg(long)]
    pub mrc: bool,
    /// MRC preset (--mrc only): archival, balanced, smallest
    #[arg(long, default_value = "balanced")]
    pub mrc_preset: String,
    /// OPT-IN (--mrc only): recognise each MRC page and revert any whose text
    /// did not survive
    #[arg(long)]
    pub mrc_verify_text: bool,
    /// OPT-IN: deskew, despeckle and whiten each scan BEFORE recognition, so
    /// what is read is the corrected page rather than the crooked one
    #[arg(long)]
    pub enhance: bool,
    /// --enhance only: leave a sideways page as it is. Orientation detection
    /// runs with --enhance, so this is the flag that turns it off.
    #[arg(long)]
    pub no_enhance_orientation: bool,
    /// Print per-file progress
    #[arg(short, long)]
    pub verbose: bool,
    /// OPT-IN: also OCR loose image files (png/jpg/tif/bmp) into searchable
    /// PDFs. The mirrored name GAINS .pdf, so scan.tif becomes scan.tif.pdf
    /// and cannot collide with a scan.pdf beside it.
    #[arg(long)]
    pub images: bool,
    /// Password for an encrypted source, as FILE=PASSWORD (repeatable).
    /// FILE is the path relative to SOURCE, or just the file name. Supplied
    /// up front because a batch has nobody to prompt -- a scheduled run
    /// under a service account has no desktop.
    #[arg(long = "password", value_name = "FILE=PASSWORD")]
    pub passwords: Vec<String>,
}

#[derive(Args)]
pub struct RebuildArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct RecoverArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
}

#[derive(Args)]
pub struct CheckArgs {
    /// Input PDF file
    pub input: PathBuf,
}

#[derive(Args)]
pub struct BatchArgs {
    /// Input directory containing PDFs
    pub input_dir: PathBuf,
    /// Output directory
    #[arg(short, long)]
    pub output: PathBuf,
    /// Operation to perform on each file
    #[command(subcommand)]
    pub operation: BatchOperation,
}

#[derive(Subcommand)]
pub enum BatchOperation {
    /// Compress all PDFs
    Compress {
        #[arg(short, long, default_value = "ebook")]
        quality: String,
        /// MRC preset (--quality mrc only): archival, balanced, smallest
        #[arg(long, default_value = "balanced")]
        mrc_preset: String,
        /// Force the MRC stencil codec: jbig2, jbig2-generic, ccitt
        #[arg(long)]
        mrc_mask_codec: Option<String>,
        /// Keep every MRC filter inside PDF/A-1's set
        #[arg(long)]
        mrc_pdfa_safe: bool,
        /// Recognise every MRC page and REVERT any whose text did not survive
        #[arg(long)]
        mrc_verify_text: bool,
        /// Recognition language for --mrc-verify-text
        #[arg(long, default_value = "eng")]
        mrc_lang: String,
    },
    /// Rotate all PDFs
    Rotate {
        #[arg(short, long)]
        angle: i32,
        #[arg(short, long, default_value = "all")]
        pages: String,
    },
    /// Convert all PDFs to PDF/A
    Pdfa {
        #[arg(short, long, default_value = "2b")]
        level: String,
    },
    /// Convert all PDFs to grayscale
    Grayscale,
    /// Optimize all PDFs
    Optimize {
        #[arg(long)]
        strip_metadata: bool,
    },
    /// Repair all PDFs (Tier 1)
    Repair,
    /// Rebuild all PDFs (Tier 2)
    Rebuild,
    /// Recover pages from all PDFs (Tier 3)
    Recover,
    /// Convert every accepted source in the folder into a PDF: images,
    /// Word/Excel/PowerPoint, text, HTML, PostScript. This is the ONE batch
    /// operation whose input set is wider than "*.pdf".
    CreatePdf {
        /// Page size: auto | first | letter | legal | tabloid | a3 | a4 | a5
        #[arg(long, default_value = "auto")]
        page_size: String,
        /// Orientation: auto | portrait | landscape
        #[arg(long, default_value = "auto")]
        orientation: String,
        /// Margin in points when a page size is named
        #[arg(long, default_value_t = 0.0)]
        margin: f64,
        /// Resolution assumed for an image that stores none
        #[arg(long, default_value_t = 200.0)]
        image_dpi: f64,
        /// Ghostscript quality preset for PostScript sources
        #[arg(long, default_value = "printer")]
        quality: String,
    },
}

// ── Path resolution (exe-relative, no Tauri runtime) ────────────────────────

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .expect("cannot resolve exe path")
        .parent()
        .expect("exe has no parent dir")
        .to_path_buf()
}

fn resolve_python() -> PathBuf {
    exe_dir().join("python").join("python.exe")
}

fn resolve_engine_script() -> PathBuf {
    exe_dir().join("engine").join("__startup__.py")
}

fn resolve_gs() -> PathBuf {
    exe_dir().join("ghostscript").join("gswin64c.exe")
}

/// The vendored native Tesseract. Mirrors `resolve_gs`:
/// beside the executable in the shipped resource tree. Recognition is a
/// subprocess, which is precisely what lets a scheduled run under a service
/// account work -- a WASM recognizer would need a WebView, and a service
/// account has no interactive desktop to host one in.
fn resolve_tesseract() -> PathBuf {
    exe_dir().join("tesseract").join("tesseract.exe")
}

/// The vendored fallback-fonts DIRECTORY (mirrors `engine::get_edit_font_path`
/// for the GUI). Passed to `fill_form_fields` so the CLI can render form
/// values outside WinAnsi with an embedded Unicode font. Missing (e.g. a dev
/// build without provisioned resources) is handled engine-side — the value is
/// then refused, never crashed.
fn resolve_fonts() -> PathBuf {
    exe_dir().join("fonts")
}

/// The comment filter both comment commands take, as the engine's own shape.
///
/// A condition the caller did not give is ABSENT, never empty: the engine
/// refuses an unknown key and reads an empty list as "no condition", so
/// sending every key with an empty value would narrow nothing while claiming
/// to have been asked to.
fn comment_filter(
    authors: &[String],
    subtypes: &[String],
    states: &[String],
    pages: &Option<String>,
    with_body: bool,
) -> serde_json::Value {
    let mut filter = serde_json::Map::new();
    if !authors.is_empty() {
        filter.insert("authors".into(), json!(authors));
    }
    if !subtypes.is_empty() {
        filter.insert("subtypes".into(), json!(subtypes));
    }
    if !states.is_empty() {
        filter.insert("states".into(), json!(states));
    }
    if let Some(spec) = pages {
        filter.insert("pages".into(), json!(spec));
    }
    if with_body {
        filter.insert("has_body".into(), json!(true));
    }
    serde_json::Value::Object(filter)
}

/// A `--pages` value as 1-based page numbers. An empty list is refused: the
/// engine reads `[]` as "no pages", so an empty flag would silently do nothing
/// where the user meant every page (which is the flag's own absence).
fn parse_page_numbers(pages: &str) -> Result<Vec<i64>, String> {
    let parsed: Vec<i64> = pages
        .split(',')
        .map(|s| s.trim().parse::<i64>())
        .collect::<Result<Vec<i64>, _>>()
        .map_err(|_| format!("--pages requires comma-separated page numbers, got: {pages}"))?;
    if parsed.is_empty() {
        return Err("--pages requires at least one page number".to_string());
    }
    Ok(parsed)
}

/// LibreOffice's `soffice` for Office export. Prefers the vendored copy
/// (resources/libreoffice) and falls back to a standard system install — the
/// runtime is large and assembled by a setup script (gitignored like the gs /
/// python runtimes), so a dev machine without the bundle still exports against
/// an installed LibreOffice. Returns "" when none is found; the engine then
/// refuses the export with a clear message rather than crashing.
fn resolve_soffice() -> String {
    let bundled = exe_dir().join("libreoffice").join("program").join("soffice.exe");
    if bundled.is_file() {
        return bundled.to_string_lossy().to_string();
    }
    soffice_system_fallback()
}

/// Probe the standard LibreOffice install locations. Shared by the CLI and the
/// GUI resolver so both agree on where a system install lives.
pub fn soffice_system_fallback() -> String {
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(base) = std::env::var(var) {
            let cand = PathBuf::from(base)
                .join("LibreOffice")
                .join("program")
                .join("soffice.exe");
            if cand.is_file() {
                return cand.to_string_lossy().to_string();
            }
        }
    }
    String::new()
}

// ── Engine communication ────────────────────────────────────────────────────

struct CliEngine {
    child: std::process::Child,
    reader: BufReader<std::process::ChildStdout>,
}

impl CliEngine {
    fn start() -> Result<Self, String> {
        let python = resolve_python();
        let script = resolve_engine_script();

        if !python.exists() {
            return Err(format!("Python not found at {}", python.display()));
        }
        if !script.exists() {
            return Err(format!("Engine script not found at {}", script.display()));
        }

        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let mut child = Command::new(&python)
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // UTF-8 by contract on the JSON-RPC channel (see engine.rs — the
            // engine reconfigures its own stdio too; both halves shipped
            // together after a live mojibake repro on non-ASCII form values).
            .env("PYTHONUTF8", "1")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to start engine: {}", e))?;

        let stdout = child.stdout.take().expect("stdout not captured");
        let reader = BufReader::new(stdout);

        // Drain stderr in background (engine prints "engine: ready" + debug info)
        let stderr = child.stderr.take().expect("stderr not captured");
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        eprintln!("[engine] {}", trimmed);
                    }
                }
            }
        });

        Ok(Self { child, reader })
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let request = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": 1
        });

        let stdin = self.child.stdin.as_mut().expect("stdin not captured");
        let msg = serde_json::to_string(&request).unwrap();
        stdin
            .write_all(msg.as_bytes())
            .map_err(|e| format!("Write error: {}", e))?;
        stdin
            .write_all(b"\n")
            .map_err(|e| format!("Write error: {}", e))?;
        stdin.flush().map_err(|e| format!("Flush error: {}", e))?;

        // Read response lines until we get valid JSON
        let mut line = String::new();
        loop {
            line.clear();
            let bytes = self
                .reader
                .read_line(&mut line)
                .map_err(|e| format!("Read error: {}", e))?;
            if bytes == 0 {
                return Err("Engine exited unexpectedly".to_string());
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(response) = serde_json::from_str::<Value>(trimmed) {
                if let Some(err) = response.get("error") {
                    let msg = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Unknown engine error");
                    return Err(msg.to_string());
                }
                return Ok(response
                    .get("result")
                    .cloned()
                    .unwrap_or(Value::Null));
            }
        }
    }

    fn shutdown(mut self) {
        if let Some(stdin) = self.child.stdin.take() {
            drop(stdin); // close stdin → engine reads EOF → exits
        }
        let _ = self.child.wait();
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Resolve a path to absolute (relative to cwd).
/// The device a headless run scans from.
///
/// There is no device-selection dialog headlessly: with exactly one scanner
/// attached it is the one, and with none or several the run refuses by name.
/// Guessing which of two machines has paper in its feeder is not a decision
/// software gets to make.
fn resolve_scan_device(requested: Option<&str>) -> Result<String, String> {
    if let Some(id) = requested {
        return Ok(id.to_string());
    }
    let list = crate::scanner::enumerate(None).map_err(|e| e.to_string())?;
    match list.scanners.len() {
        0 => Err("No scanners found.".to_string()),
        1 => Ok(list.scanners[0].id.clone()),
        _ => {
            let names: Vec<String> = list
                .scanners
                .iter()
                .map(|d| format!("{} ({})", d.name, d.id))
                .collect();
            Err(format!(
                "Several scanners are attached; name one with --device: {}",
                names.join(", ")
            ))
        }
    }
}

/// Turn the command line into the settings the device is written with.
///
/// The source rows come from the capability report, the same list the dialog
/// picks from — a second derivation here would be a run whose CLI and whose
/// dialog disagree about which side of a sheet "duplex" means.
fn scan_settings(
    capabilities: &crate::scanner::ScannerCapabilities,
    args: &ScanArgs,
) -> Result<crate::scanner::ScanSettings, String> {
    use crate::scanner::{ColorMode, PaperSize, SourceOptionId};
    let mut settings = crate::scanner::ScanSettings {
        dpi: args.dpi,
        ..Default::default()
    };
    let wanted = match args.source.as_deref() {
        None => None,
        Some("flatbed") => Some(SourceOptionId::Flatbed),
        Some("feeder") => Some(SourceOptionId::Feeder),
        Some("duplex") => Some(SourceOptionId::Duplex),
        Some(other) => {
            return Err(format!(
                "--source must be flatbed, feeder or duplex, not '{other}'"
            ))
        }
    };
    let option = match wanted {
        Some(id) => Some(
            capabilities
                .source_options
                .iter()
                .find(|o| o.id == id)
                .ok_or_else(|| {
                    let offered: Vec<String> = capabilities
                        .source_options
                        .iter()
                        .map(|o| format!("{:?}", o.id).to_lowercase())
                        .collect();
                    format!(
                        "This scanner does not offer that source; it offers: {}",
                        offered.join(", ")
                    )
                })?,
        ),
        None => capabilities.source_options.first(),
    };
    if let Some(option) = option {
        settings.item_name = Some(option.item_name.clone());
        settings.document_handling = option.document_handling;
        // A page count means nothing on a source that cannot feed sheets.
        if option.feeds {
            settings.pages = args.pages;
        }
    }
    if let Some(color) = args.color.as_deref() {
        let mode = match color {
            "bw" => ColorMode::BlackAndWhite,
            "gray" | "grey" => ColorMode::Grayscale,
            "color" | "colour" => ColorMode::Color,
            "auto" => ColorMode::Auto,
            other => {
                return Err(format!(
                    "--color must be bw, gray, color or auto, not '{other}'"
                ))
            }
        };
        // Offered only where the device lists it: writing a mode the driver
        // never reported is how a run comes back in the wrong colour.
        let offered = capabilities
            .sources
            .iter()
            .any(|s| s.color_modes.contains(&mode));
        if !offered {
            return Err(format!("This scanner does not offer the '{color}' colour mode."));
        }
        settings.color_mode = Some(mode);
    }
    let paper = PaperSize::parse(&args.paper)
        .ok_or_else(|| format!("--paper does not name a paper size: '{}'", args.paper))?;
    if paper != PaperSize::Auto {
        settings.paper = Some(paper);
    }
    Ok(settings)
}

fn abs(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap().join(p)
    }
}

/// Parse comma-separated page numbers into a JSON value.
/// `#rrggbb` (or `rrggbb`) → [r, g, b] in 0..1 — the redaction fill and any
/// other colour a CLI flag names. Strict: a malformed colour REFUSES rather
/// than falling back to a default the caller did not ask for.
fn parse_hex_rgb(value: &str) -> Result<Vec<f64>, String> {
    let hex = value.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("'{}' is not a colour — use #rrggbb", value));
    }
    let component = |i: usize| {
        u8::from_str_radix(&hex[i..i + 2], 16).map(|v| f64::from(v) / 255.0)
    };
    Ok(vec![
        component(0).map_err(|e| e.to_string())?,
        component(2).map_err(|e| e.to_string())?,
        component(4).map_err(|e| e.to_string())?,
    ])
}

/// A `--from-json` argument's bytes: a file, or stdin when it is `-`.
fn read_json_source(source: &str) -> Result<String, String> {
    if source == "-" {
        use std::io::Read;
        let mut s = String::new();
        std::io::stdin()
            .read_to_string(&mut s)
            .map_err(|e| format!("failed to read JSON from stdin: {}", e))?;
        Ok(s)
    } else {
        std::fs::read_to_string(source).map_err(|e| format!("failed to read {}: {}", source, e))
    }
}

fn parse_pages(pages: &str) -> Value {
    if pages.eq_ignore_ascii_case("all") {
        json!("all")
    } else {
        let nums: Vec<i64> = pages
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        json!(nums)
    }
}

/// Collect all .pdf files in a directory.
fn collect_pdfs(dir: &Path) -> Result<Vec<PathBuf>, String> {
    collect_batch_inputs(dir, |p| {
        p.extension()
            .map(|ext| ext.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false)
    })
}

/// Collect every file in a directory an arm of Create PDF converts.
/// The one batch operation whose input set is wider than `*.pdf`.
fn collect_create_pdf_sources(dir: &Path) -> Result<Vec<PathBuf>, String> {
    collect_batch_inputs(dir, |p| crate::create_pdf_sources::accepts(p))
}

fn collect_batch_inputs(
    dir: &Path,
    wanted: impl Fn(&Path) -> bool,
) -> Result<Vec<PathBuf>, String> {
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("Cannot read directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && wanted(p))
        .collect();
    found.sort();
    Ok(found)
}

/// Sheet size in points for the print layout modes: an explicit "WxH"
/// override wins; otherwise the chosen (or default) paper's size from the
/// printer's own capability report.
fn resolve_sheet(
    printer: &str,
    paper: Option<u16>,
    sheet: Option<&str>,
) -> Result<(f64, f64), String> {
    if let Some(spec) = sheet {
        let (w, h) = spec
            .split_once(['x', 'X'])
            .ok_or_else(|| format!("--sheet expects WxH in points, got '{spec}'"))?;
        let w: f64 = w.trim().parse().map_err(|_| format!("Bad sheet width '{w}'"))?;
        let h: f64 = h.trim().parse().map_err(|_| format!("Bad sheet height '{h}'"))?;
        return Ok((w, h));
    }
    let caps = crate::printers::capabilities(printer)?;
    let id = paper.or(caps.default_paper);
    if let Some(id) = id {
        if let Some(p) = caps.papers.iter().find(|p| p.id == id) {
            return Ok((p.width_pt, p.height_pt));
        }
    }
    if let Some(p) = caps.papers.first() {
        return Ok((p.width_pt, p.height_pt));
    }
    Err("Could not resolve the paper size for this layout; pass --sheet WxH (points)".into())
}

// ── Main CLI entry point ────────────────────────────────────────────────────

/// Run the CLI. Returns the exit code.
pub fn run(command: CliCommand) -> i32 {
    // Printer enumeration/capabilities are pure winspool — no Python engine
    // to spawn.
    if let CliCommand::Printers(args) = &command {
        let result = match &args.capabilities {
            Some(name) => crate::printers::capabilities(name)
                .map(|caps| serde_json::to_string_pretty(&caps).unwrap()),
            None => crate::printers::enumerate().map(|list| {
                serde_json::to_string_pretty(&serde_json::json!({
                    "printers": list.printers,
                    "default": list.default,
                }))
                .unwrap()
            }),
        };
        return match result {
            Ok(json) => {
                println!("{}", json);
                0
            }
            Err(msg) => {
                eprintln!("error: {}", msg);
                1
            }
        };
    }

    // Scanner enumeration/capabilities are pure WIA — no Python engine to
    // spawn, and the session store closes its devices when it drops here.
    if let CliCommand::Scanners(args) = &command {
        let result = match &args.capabilities {
            Some(device_id) => crate::scanner::ScannerSessions::new()
                .capabilities(device_id)
                .map(|caps| serde_json::to_string_pretty(&caps).unwrap()),
            None => crate::scanner::enumerate(None)
                .map(|list| serde_json::to_string_pretty(&list.scanners).unwrap()),
        };
        return match result {
            Ok(json) => {
                println!("{}", json);
                0
            }
            Err(refusal) => {
                eprintln!("error: {}", refusal);
                1
            }
        };
    }

    let mut engine = match CliEngine::start() {
        Ok(e) => e,
        Err(msg) => {
            eprintln!("error: {}", msg);
            return 2;
        }
    };

    let result = dispatch(&mut engine, &command);
    engine.shutdown();

    match result {
        Ok(output) => {
            // Print JSON result to stdout
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
            0
        }
        Err(msg) => {
            eprintln!("error: {}", msg);
            1
        }
    }
}

fn dispatch(engine: &mut CliEngine, command: &CliCommand) -> Result<Value, String> {
    match command {
        CliCommand::Compress(args) => {
            let gs = resolve_gs();
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "quality": args.quality,
                "gs_path": gs.to_string_lossy(),
                // Ignored by the Ghostscript branch, read by the MRC one.
                // One op, one dispatch — a second subcommand is how a surface
                // gets left behind.
                "mrc_preset": args.mrc_preset,
                "mrc_mask_codec": args.mrc_mask_codec.clone().unwrap_or_default(),
                "mrc_pdfa_safe": args.mrc_pdfa_safe,
                "mrc_verify_text": args.mrc_verify_text,
                "mrc_lang": args.mrc_lang,
                "tesseract_path": resolve_tesseract().to_string_lossy(),
            });
            if let Some(dpi) = args.dpi {
                params["dpi"] = json!(dpi);
            }
            engine.call("compress", params)
        }

        CliCommand::Print(args) => {
            let gs = resolve_gs();
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "printer": args.printer,
                "pages": args.pages,
                "copies": args.copies,
                "fit": args.fit,
                "gs_path": gs.to_string_lossy(),
                "collate": !args.no_collate,
                "subset": args.subset,
                "reverse": args.reverse,
                "duplex": args.duplex,
                "orientation": args.orientation,
                "color": args.color,
                "annots": args.comments,
                "as_image": args.as_image,
                "image_dpi": args.image_dpi,
                "layout": args.layout,
            });
            if let Some(paper) = args.paper {
                params["paper"] = json!(paper);
            }
            if args.fit == "scale" {
                params["scale_percent"] = json!(args.scale);
            }
            match args.layout.as_str() {
                "nup" => {
                    params["nup_rows"] = json!(args.nup_rows);
                    params["nup_cols"] = json!(args.nup_cols);
                    params["nup_order"] = json!(args.nup_order);
                    params["nup_border"] = json!(args.nup_border);
                    params["nup_auto_rotate"] = json!(!args.no_nup_auto_rotate);
                }
                "booklet" => {
                    params["booklet_subset"] = json!(args.booklet_subset);
                    params["booklet_binding"] = json!(args.booklet_binding);
                }
                "poster" => {
                    params["poster_scale"] = json!(args.poster_scale);
                    params["poster_overlap"] = json!(args.poster_overlap);
                    params["poster_cut_marks"] = json!(args.poster_cut_marks);
                    params["poster_labels"] = json!(args.poster_labels);
                }
                _ => {}
            }
            // The layout modes need real sheet geometry; resolve it the
            // same way the dialog does (chosen paper -> capabilities ->
            // default paper), with --sheet as the explicit override.
            if args.layout != "single" || args.fit == "scale" {
                let (w, h) = resolve_sheet(&args.printer, args.paper, args.sheet.as_deref())?;
                params["sheet_width"] = json!(w);
                params["sheet_height"] = json!(h);
            }
            engine.call("print", params)
        }

        CliCommand::IncrementalSave(args) => engine.call(
            "transplant_incremental",
            json!({
                "original": abs(&args.original).to_string_lossy(),
                "modified": abs(&args.modified).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
            }),
        ),

        // Handled in run() before the engine spawns.
        CliCommand::Printers(_) => unreachable!("printers is dispatched before engine start"),
        CliCommand::Scanners(_) => unreachable!("scanners is dispatched before engine start"),

        CliCommand::Rotate(args) => {
            engine.call(
                "rotate",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "angle": args.angle,
                    "pages": parse_pages(&args.pages),
                }),
            )
        }

        CliCommand::Split(args) => {
            let out_dir = abs(&args.output);
            std::fs::create_dir_all(&out_dir)
                .map_err(|e| format!("Cannot create output dir: {}", e))?;
            // The mode names its own required option and refuses the others.
            // Accepting an ignored --ranges alongside --mode size would let a
            // caller believe a selection was honoured that never reached the
            // engine.
            let mode = args.mode.replace('-', "_");
            let wrong = |flag: &str| {
                Err(format!(
                    "--{flag} does not apply to --mode {}",
                    args.mode
                ))
            };
            match mode.as_str() {
                "ranges" => {
                    if args.every_n.is_some() {
                        return wrong("every-n");
                    }
                    if args.max_mb.is_some() {
                        return wrong("max-mb");
                    }
                    if args.ranges.is_none() {
                        return Err("--ranges is required with --mode ranges".to_string());
                    }
                }
                "every_n" => {
                    if args.ranges.is_some() {
                        return wrong("ranges");
                    }
                    if args.max_mb.is_some() {
                        return wrong("max-mb");
                    }
                    if args.every_n.is_none() {
                        return Err("--every-n is required with --mode every-n".to_string());
                    }
                }
                "size" => {
                    if args.ranges.is_some() {
                        return wrong("ranges");
                    }
                    if args.every_n.is_some() {
                        return wrong("every-n");
                    }
                    if args.max_mb.is_none() {
                        return Err("--max-mb is required with --mode size".to_string());
                    }
                }
                _ => {
                    if args.ranges.is_some() {
                        return wrong("ranges");
                    }
                    if args.every_n.is_some() {
                        return wrong("every-n");
                    }
                    if args.max_mb.is_some() {
                        return wrong("max-mb");
                    }
                }
            }
            engine.call(
                "split",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output_dir": out_dir.to_string_lossy(),
                    "mode": mode,
                    "ranges": args.ranges.clone().unwrap_or_default(),
                    "every_n": args.every_n.unwrap_or(0),
                    "max_mb": args.max_mb.unwrap_or(0.0),
                }),
            )
        }

        CliCommand::Merge(args) => {
            let files: Vec<String> = args
                .inputs
                .iter()
                .map(|p| abs(p).to_string_lossy().to_string())
                .collect();
            if files.len() < 2 {
                return Err("Merge requires at least 2 input files".to_string());
            }
            // A non-PDF input routes the whole list through the
            // ONE `create_pdf` door, whose assembly IS this same merge — so
            // convert-then-merge comes for free and the AcroForm / outline /
            // struct carries cannot be forgotten on the way.
            //
            // An all-PDF list still calls `merge` DIRECTLY. Not laziness: the
            // standing rule is that a widening must not change existing
            // default output, and the merge is what that path has always run.
            let needs_conversion = args
                .inputs
                .iter()
                .any(|p| !matches!(p.extension().and_then(|e| e.to_str()),
                                   Some(e) if e.eq_ignore_ascii_case("pdf")));
            if needs_conversion {
                let sources: Vec<Value> = files.iter().map(|f| json!({ "path": f })).collect();
                return engine.call(
                    "create_pdf",
                    json!({
                        "sources": sources,
                        "output": abs(&args.output).to_string_lossy(),
                        "gs_path": resolve_gs().to_string_lossy(),
                        "soffice_path": resolve_soffice(),
                    }),
                );
            }
            engine.call(
                "merge",
                json!({
                    "files": files,
                    "output": abs(&args.output).to_string_lossy(),
                }),
            )
        }

        CliCommand::CreatePdf(args) => {
            if args.sources.is_empty() && !args.blank {
                return Err("Create PDF needs at least one source (or --blank)".to_string());
            }
            let mut sources: Vec<Value> = args
                .sources
                .iter()
                .map(|p| json!({ "path": abs(p).to_string_lossy() }))
                .collect();
            if args.blank {
                sources.push(json!({ "kind": "blank" }));
            }
            engine.call(
                "create_pdf",
                json!({
                    "sources": sources,
                    "output": abs(&args.output).to_string_lossy(),
                    "page_size": args.page_size,
                    "orientation": args.orientation,
                    "margin_pt": args.margin,
                    "image_dpi_default": args.image_dpi,
                    "distill_preset": args.quality,
                    "on_unsupported": if args.skip_unsupported { "skip" } else { "refuse" },
                    "gs_path": resolve_gs().to_string_lossy(),
                    "soffice_path": resolve_soffice(),
                }),
            )
        }

        CliCommand::Scan(args) => {
            let sessions = crate::scanner::ScannerSessions::new();
            let device = resolve_scan_device(args.device.as_deref())?;
            let capabilities = sessions.capabilities(&device).map_err(|e| e.to_string())?;
            let settings = scan_settings(&capabilities, args)?;
            // A line per page on stderr, so stdout stays the JSON result.
            let sink: crate::scanner::EventSink = Box::new(|event| {
                if let crate::scanner::ScanEvent::PageFinished { index, .. } = event {
                    eprintln!("page {}", index + 1);
                }
            });
            let scratch = crate::scanner::new_scan_scratch().map_err(|e| e.to_string())?;
            let result = sessions
                .acquire(&device, settings, scratch.clone(), sink)
                .map_err(|e| {
                    let _ = crate::scanner::discard_scan_scratch(&scratch);
                    e.to_string()
                })?;
            if result.pages.is_empty() {
                let _ = crate::scanner::discard_scan_scratch(&scratch);
                return Err("The scan produced no pages.".to_string());
            }
            let sources: Vec<Value> = result
                .pages
                .iter()
                .map(|path| json!({ "path": path }))
                .collect();
            let built = engine.call(
                "create_pdf",
                json!({
                    "sources": sources,
                    "output": abs(&args.output).to_string_lossy(),
                    "page_size": "auto",
                    "orientation": "auto",
                    "margin_pt": 0,
                    // The resolution the device REPORTED BACK, so a driver
                    // that clamped the request still sizes its pages right.
                    "image_dpi_default": if result.dpi > 0 { result.dpi as f64 } else { args.image_dpi },
                    "gs_path": resolve_gs().to_string_lossy(),
                    "soffice_path": resolve_soffice(),
                }),
            );
            let _ = crate::scanner::discard_scan_scratch(&scratch);
            built
        }

        CliCommand::CreatePdfFolders(args) => {
            // The whole tree in ONE engine call: the walk, the grouping, the
            // ordering and the log all live engine-side, so this arm, a guided
            // action and a scheduled run assemble folders identically.
            engine.call(
                "create_pdf_folders",
                json!({
                    "source": abs(&args.source).to_string_lossy(),
                    "dest": abs(&args.dest).to_string_lossy(),
                    "sources": args.sources,
                    "include_subfolders": !args.no_subfolders,
                    "page_size": args.page_size,
                    "orientation": args.orientation,
                    "margin_pt": args.margin,
                    "image_dpi_default": args.image_dpi,
                    "distill_preset": args.quality,
                    "log_dir": args.log_dir.as_ref().map(|p| abs(p).to_string_lossy().to_string()).unwrap_or_default(),
                    "progress": args.verbose,
                    "gs_path": resolve_gs().to_string_lossy(),
                    "soffice_path": resolve_soffice(),
                }),
            )
        }

        CliCommand::Encrypt(args) => {
            let owner = args
                .owner_password
                .as_deref()
                .unwrap_or(&args.password);
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "user_password": args.password,
                "owner_password": owner,
            });
            if args.no_print || args.no_copy || args.no_modify || args.no_annotate {
                params["permissions"] = json!({
                    "print": !args.no_print,
                    "copy": !args.no_copy,
                    "modify": !args.no_modify,
                    "annotate": !args.no_annotate,
                });
            }
            engine.call("encrypt", params)
        }

        CliCommand::EncryptCerts(args) => {
            let certs: Vec<String> = args
                .certs
                .iter()
                .map(|p| abs(p).to_string_lossy().to_string())
                .collect();
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "certs": certs,
            });
            if args.no_print || args.no_copy || args.no_modify || args.no_annotate {
                params["permissions"] = json!({
                    "print": !args.no_print,
                    "copy": !args.no_copy,
                    "modify": !args.no_modify,
                    "annotate": !args.no_annotate,
                });
            }
            engine.call("encrypt_pubkey", params)
        }

        CliCommand::DecryptCert(args) => {
            engine.call(
                "decrypt_pubkey",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "pfx": abs(&args.pfx).to_string_lossy(),
                    "password": args.password,
                }),
            )
        }

        CliCommand::Decrypt(args) => {
            engine.call(
                "decrypt",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "password": args.password,
                }),
            )
        }

        CliCommand::Pdfa(args) => {
            let gs = resolve_gs();
            engine.call(
                "convert_pdfa",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "level": args.level,
                    "gs_path": gs.to_string_lossy(),
                }),
            )
        }

        CliCommand::ConvertCmyk(args) => {
            let gs = resolve_gs();
            // A bare bundled-profile name passes through; a path is absolutized.
            let profile = if args.dest_profile.is_empty()
                || !(args.dest_profile.contains('/') || args.dest_profile.contains('\\'))
            {
                args.dest_profile.clone()
            } else {
                abs(&PathBuf::from(&args.dest_profile)).to_string_lossy().to_string()
            };
            engine.call(
                "convert_cmyk",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "render_intent": args.render_intent,
                    "dest_profile": profile,
                    "gs_path": gs.to_string_lossy(),
                }),
            )
        }

        CliCommand::ConvertPdfx(args) => {
            let gs = resolve_gs();
            let profile = if args.dest_profile.is_empty()
                || !(args.dest_profile.contains('/') || args.dest_profile.contains('\\'))
            {
                args.dest_profile.clone()
            } else {
                abs(&PathBuf::from(&args.dest_profile)).to_string_lossy().to_string()
            };
            engine.call(
                "convert_pdfx",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "version": args.version,
                    "dest_profile": profile,
                    "condition": args.condition,
                    "identifier": args.identifier,
                    "gs_path": gs.to_string_lossy(),
                }),
            )
        }

        CliCommand::ExtractText(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "pages": parse_pages(&args.pages),
            });
            if let Some(output) = &args.output {
                params["output"] = json!(abs(output).to_string_lossy());
            }
            engine.call("extract_text", params)
        }

        CliCommand::Delete(args) => {
            let pages: Vec<i64> = args
                .pages
                .split(',')
                .filter_map(|s| s.trim().parse().ok())
                .collect();
            engine.call(
                "delete",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "pages": pages,
                }),
            )
        }

        CliCommand::Redact(args) => {
            let rect: Vec<f64> = args
                .rect
                .split(',')
                .map(|s| s.trim().parse::<f64>())
                .collect::<Result<Vec<f64>, _>>()
                .map_err(|_| "--rect requires exactly 4 comma-separated numbers: x0,y0,x1,y1".to_string())?;
            if rect.len() != 4 {
                return Err("--rect requires exactly 4 comma-separated numbers: x0,y0,x1,y1".to_string());
            }
            let fill = parse_hex_rgb(&args.fill)?;
            engine.call(
                "redact",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "regions": [{
                        "page": args.page,
                        "rect": rect,
                        "fill": fill,
                        "overlay_text": args.overlay_text,
                        "repeat_overlay": args.repeat_overlay,
                        "align": args.overlay_align,
                        "font_size": args.overlay_size,
                    }],
                    // An overlay whose text is not Latin-1
                    // EMBEDS through the bundled faces rather than drawing
                    // '?' — a redaction code printed as question marks tells
                    // the reader nothing.
                    "font_dir": resolve_fonts().to_string_lossy().to_string(),
                }),
            )
        }

        CliCommand::SearchRegions(args) => {
            // Read-only: it reports rectangles, it never writes a file. The
            // rects it returns are in the page's own point space — the space
            // `redact --rect` and `save_redaction_marks` already take — so a
            // script can pipe one into the other.
            engine.call(
                "search_text_regions",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "query": args.query,
                    "terms": args.terms,
                    "patterns": args.patterns,
                    "pages": parse_pages(&args.pages),
                    "regex": args.regex,
                    "case_sensitive": args.case_sensitive,
                    "whole_word": args.whole_word,
                    "expand": args.expand,
                    "max_hits": args.max_hits,
                }),
            )
        }

        CliCommand::SearchRedact(args) => {
            // Only the properties the caller actually set are sent: "no
            // overlay" and "an overlay of nothing" stay distinguishable
            // through the file, and the engine refuses a key it does not know
            // rather than dropping it.
            let mut properties = json!({});
            let fill = parse_hex_rgb(&args.fill)?;
            if args.fill.trim().to_ascii_lowercase() != "#000000" {
                properties["fill"] = json!(fill);
            }
            if !args.overlay_text.is_empty() {
                properties["overlay_text"] = json!(args.overlay_text);
                properties["repeat_overlay"] = json!(args.repeat_overlay);
                properties["align"] = json!(args.overlay_align);
                properties["font_size"] = json!(args.overlay_size);
            }
            engine.call(
                "search_and_redact",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "query": args.query,
                    "terms": args.terms,
                    "patterns": args.patterns,
                    "pages": parse_pages(&args.pages),
                    "regex": args.regex,
                    "case_sensitive": args.case_sensitive,
                    "whole_word": args.whole_word,
                    "expand": args.expand,
                    "max_hits": args.max_hits,
                    "marks_only": args.marks_only,
                    "allow_signed": args.include_signed,
                    "properties": properties,
                    "font_dir": resolve_fonts().to_string_lossy().to_string(),
                }),
            )
        }

        CliCommand::Watermark(args) => {
            // Exactly one source. Passing two would silently honour one of
            // them; passing none has no stamp to draw.
            let sources = usize::from(args.text.is_some())
                + usize::from(args.image.is_some())
                + usize::from(args.pdf_source.is_some());
            if sources > 1 {
                return Err(
                    "--text, --image and --pdf-source are alternatives, not a set".to_string()
                );
            }
            if sources == 0 {
                return Err("--text, --image or --pdf-source is required".to_string());
            }
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "text": args.text.clone().unwrap_or_default(),
                "image": args.image.as_ref()
                    .map(|p| abs(p).to_string_lossy().to_string())
                    .unwrap_or_default(),
                "pdf_source": args.pdf_source.as_ref()
                    .map(|p| abs(p).to_string_lossy().to_string())
                    .unwrap_or_default(),
                "pdf_page": args.pdf_page,
                "opacity": args.opacity,
                "angle": args.angle,
                "color": args.color,
                "font_size": args.font_size,
                "layer": args.layer,
                "scale": args.scale,
                "position": args.position,
                "margin": args.margin,
                "tile": args.tile,
                "tile_gap": args.tile_gap,
                // The vendored fonts dir lets the engine embed a Unicode
                // font for non-Latin-1 stamps (else refused, never "?"-mapped).
                "font_dir": resolve_fonts().to_string_lossy().to_string(),
            });
            if let Some(pages) = &args.pages {
                // Strict parse (like --rect): silently dropping bad tokens
                // would send an empty list — and an empty page selection must
                // never widen to "all pages", nor should a typo quietly
                // shrink the selection.
                let parsed: Vec<i64> = pages
                    .split(',')
                    .map(|s| s.trim().parse::<i64>())
                    .collect::<Result<Vec<i64>, _>>()
                    .map_err(|_| {
                        format!("--pages requires comma-separated page numbers, got: {pages}")
                    })?;
                if parsed.is_empty() {
                    return Err("--pages requires at least one page number".to_string());
                }
                params["pages"] = json!(parsed);
            }
            engine.call("watermark", params)
        }

        CliCommand::HeaderFooter(args) => {
            let mut placements: Vec<serde_json::Value> = Vec::new();
            for (pos, text) in [
                ("tl", &args.tl), ("tc", &args.tc), ("tr", &args.tr),
                ("bl", &args.bl), ("bc", &args.bc), ("br", &args.br),
            ] {
                if let Some(t) = text {
                    placements.push(json!({ "position": pos, "text": t }));
                }
            }
            if placements.is_empty() {
                return Err("at least one of --tl/--tc/--tr/--bl/--bc/--br is required".to_string());
            }
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "placements": placements,
                "first_page": args.first_page,
                "font_size": args.font_size,
                "margin": args.margin,
                "color": args.color,
                "bates_start": args.bates_start,
                "bates_digits": args.bates_digits,
                // Embed a Unicode font for non-Latin-1 text, as watermark does.
                "font_dir": resolve_fonts().to_string_lossy().to_string(),
            });
            if let Some(last) = args.last_page {
                params["last_page"] = json!(last);
            }
            engine.call("add_header_footer", params)
        }

        CliCommand::PrinterMarks(args) => {
            let marks: Vec<String> = args
                .marks
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "marks": marks,
                "style": args.style,
                "weight": args.weight,
                "offset": args.offset,
                "length": args.length,
                "font_dir": resolve_fonts().to_string_lossy().to_string(),
            });
            if let Some(pages) = &args.pages {
                params["pages"] = json!(parse_page_numbers(pages)?);
            }
            engine.call("add_printer_marks", params)
        }

        CliCommand::PrinterMarksRemove(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
            });
            if let Some(pages) = &args.pages {
                params["pages"] = json!(parse_page_numbers(pages)?);
            }
            engine.call("remove_printer_marks", params)
        }

        CliCommand::PrinterMarksList(args) => engine.call(
            "list_printer_marks",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::HairlinesList(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "threshold_pt": args.threshold,
                "include_annotations": !args.skip_annotations,
            });
            if let Some(pages) = &args.pages {
                params["pages"] = json!(parse_page_numbers(pages)?);
            }
            engine.call("list_hairlines", params)
        }

        CliCommand::HairlinesFix(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "threshold_pt": args.threshold,
                "replacement_pt": args.replacement,
                "include_annotations": !args.skip_annotations,
            });
            if let Some(pages) = &args.pages {
                params["pages"] = json!(parse_page_numbers(pages)?);
            }
            engine.call("fix_hairlines", params)
        }

        CliCommand::FlattenList(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "balance": args.balance,
                "dpi": args.dpi,
            });
            if let Some(pages) = &args.pages {
                params["pages"] = json!(parse_page_numbers(pages)?);
            }
            engine.call("list_transparency", params)
        }

        CliCommand::Flatten(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "balance": args.balance,
                "dpi": args.dpi,
                "gs_path": resolve_gs().to_string_lossy(),
                "outline_text": args.outline_text,
                "outline_strokes": args.outline_strokes,
                "font_dir": resolve_fonts().to_string_lossy().to_string(),
            });
            if let Some(pages) = &args.pages {
                params["pages"] = json!(parse_page_numbers(pages)?);
            }
            engine.call("flatten_transparency", params)
        }

        CliCommand::OutlinesList(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "font_dir": resolve_fonts().to_string_lossy().to_string(),
            });
            if let Some(pages) = &args.pages {
                params["pages"] = json!(parse_page_numbers(pages)?);
            }
            engine.call("list_outlines", params)
        }

        CliCommand::TrapFields => engine.call("trap_preset_defaults", json!({})),

        CliCommand::TrapList(args) => engine.call(
            "list_trap_presets",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::TrapAssign(args) => {
            let preset: serde_json::Value = serde_json::from_str(&args.params)
                .map_err(|e| format!("--params must be a JSON object of trapping parameters: {e}"))?;
            engine.call(
                "assign_trap_presets",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "trapped": args.trapped,
                    "assignments": [{
                        "first": args.first,
                        "last": args.last.unwrap_or(args.first),
                        "name": args.name,
                        "preset": preset,
                    }],
                }),
            )
        }

        CliCommand::ExportPostscript(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "level": args.level,
                "trapping": !args.no_trapping,
                "gs_path": resolve_gs().to_string_lossy(),
            });
            if let Some(pages) = &args.pages {
                let numbers = parse_page_numbers(pages)?;
                let list: Vec<String> = numbers.iter().map(|n| n.to_string()).collect();
                params["pages"] = json!(list.join(","));
            }
            engine.call("export_postscript", params)
        }

        CliCommand::PageBox(args) => {
            // An automatic crop and a typed inset are two different requests;
            // accepting both in one call would silently apply one of them.
            let typed = args.top != 0.0 || args.bottom != 0.0 || args.left != 0.0 || args.right != 0.0;
            if args.auto && typed {
                return Err(
                    "--auto crops to the page's content; it cannot be combined with \
                     --top/--bottom/--left/--right"
                        .to_string(),
                );
            }
            if !args.auto && (args.margin != 0.0 || args.preview) {
                return Err("--margin and --preview apply to --auto only".to_string());
            }
            let mut params = if args.auto {
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "box": args.box_,
                    "margin": args.margin,
                    "preview": args.preview,
                    "gs_path": resolve_gs().to_string_lossy(),
                })
            } else {
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "box": args.box_,
                    "top": args.top,
                    "bottom": args.bottom,
                    "left": args.left,
                    "right": args.right,
                })
            };
            if let Some(pages) = &args.pages {
                let parsed: Vec<i64> = pages
                    .split(',')
                    .map(|s| s.trim().parse::<i64>())
                    .collect::<Result<Vec<i64>, _>>()
                    .map_err(|_| format!("--pages requires comma-separated page numbers, got: {pages}"))?;
                if parsed.is_empty() {
                    return Err("--pages requires at least one page number".to_string());
                }
                params["pages"] = json!(parsed);
            }
            engine.call(if args.auto { "content_crop" } else { "set_page_boxes" }, params)
        }

        CliCommand::PageLabels(args) => {
            let mut ranges: Vec<serde_json::Value> = Vec::new();
            for spec in &args.ranges {
                let parts: Vec<&str> = spec.split(':').collect();
                let start = parts
                    .first()
                    .and_then(|s| s.trim().parse::<i64>().ok())
                    .filter(|n| *n >= 1)
                    .ok_or_else(|| format!("--range needs a 1-based start page, got: {spec}"))?;
                let style = parts.get(1).map(|s| s.trim()).filter(|s| !s.is_empty()).unwrap_or("D");
                let prefix = parts.get(2).map(|s| s.to_string()).unwrap_or_default();
                let start_at = parts.get(3).and_then(|s| s.trim().parse::<i64>().ok()).unwrap_or(1);
                ranges.push(json!({
                    "start": start - 1, // engine takes 0-based
                    "style": style,
                    "prefix": prefix,
                    "start_at": start_at,
                }));
            }
            engine.call(
                "set_page_labels",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "ranges": ranges,
                }),
            )
        }

        CliCommand::AttachList(args) => engine.call(
            "list_attachments",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::XfdfExport(args) => engine.call(
            "export_xfdf",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
            }),
        ),

        CliCommand::XfdfImport(args) => engine.call(
            "import_xfdf",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "xfdf": abs(&args.xfdf).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
            }),
        ),

        CliCommand::CountSummary(args) => engine.call(
            "export_count_summary",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
            }),
        ),

        CliCommand::AttachAdd(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "source": abs(&args.source).to_string_lossy(),
            });
            if let Some(name) = &args.name {
                params["name"] = json!(name);
            }
            if let Some(desc) = &args.description {
                params["description"] = json!(desc);
            }
            engine.call("add_attachment", params)
        }

        CliCommand::AttachExtract(args) => engine.call(
            "extract_attachment",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "name": args.name,
                "output": abs(&args.output).to_string_lossy(),
            }),
        ),

        CliCommand::AttachRemove(args) => engine.call(
            "remove_attachment",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "name": args.name,
            }),
        ),

        CliCommand::PortfolioInfo(args) => engine.call(
            "get_portfolio",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::OcrFile(args) => {
            let gs = resolve_gs();
            let tesseract = resolve_tesseract();
            engine.call(
                "ocr_file",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "language": args.language,
                    "tesseract_path": tesseract.to_string_lossy(),
                    "gs_path": gs.to_string_lossy(),
                    "mrc": args.mrc,
                    "mrc_preset": args.mrc_preset,
                    "mrc_verify_text": args.mrc_verify_text,
                    "enhance": args.enhance,
                    "enhance_orientation": !args.no_orientation,
                }),
            )
        }

        CliCommand::EnhanceScan(args) => {
            // ONE params object for both arms: the analysis and the pass take
            // the same settings, and the preview is only meaningful if it
            // measures with exactly what the pass would apply.
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "pages": match &args.pages {
                    Some(p) => Value::from(parse_page_numbers(p)?),
                    None => json!("all"),
                },
                "deskew": !args.no_deskew,
                "despeckle": !args.no_despeckle,
                "background": !args.no_background,
                "orientation": !args.no_orientation,
                "max_skew_deg": args.max_skew,
                "min_skew_deg": args.min_skew,
                "speck_size_in": args.speck_size,
                "speck_gap_in": args.speck_gap,
                "background_strength": args.background_strength,
                "osd_confidence": args.osd_confidence,
                "jpeg_quality": args.jpeg_quality,
                "gs_path": resolve_gs().to_string_lossy(),
                "tesseract_path": resolve_tesseract().to_string_lossy(),
            });
            if args.analyze {
                return engine.call("analyze_scan", params);
            }
            let output = args
                .output
                .as_ref()
                .ok_or_else(|| "enhance-scan needs an --output".to_string())?;
            params["output"] = json!(abs(output).to_string_lossy());
            engine.call("enhance_scan", params)
        }

        CliCommand::RunAction(args) => {
            let raw = std::fs::read_to_string(&args.action)
                .map_err(|e| format!("Cannot read action file {}: {e}", args.action.display()))?;
            let parsed: serde_json::Value = serde_json::from_str(&raw)
                .map_err(|e| format!("Action file is not valid JSON: {e}"))?;
            let steps = parsed
                .get("steps")
                .cloned()
                .ok_or_else(|| "Action file has no \"steps\"".to_string())?;
            let name = parsed
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let mut params = json!({
                "source": abs(&args.source).to_string_lossy(),
                "dest": args.dest.as_ref().map(|p| abs(p).to_string_lossy().to_string()).unwrap_or_default(),
                "steps": steps,
                "action_name": name,
                "gs_path": resolve_gs().to_string_lossy(),
                "tesseract_path": resolve_tesseract().to_string_lossy(),
                // An action may START with a create_pdf step, so
                // the LibreOffice arm has to be reachable from a scheduled run
                // and a watched folder too — both invoke this same subcommand.
                "soffice_path": resolve_soffice(),
                "font_dir": resolve_fonts().to_string_lossy(),
                "write_log": args.log_dir.is_some(),
                "progress": true,
                "in_place": args.in_place,
                "move_processed_root": args.moved.as_ref().map(|p| abs(p).to_string_lossy().to_string()).unwrap_or_default(),
            });
            if let Some(dir) = &args.log_dir {
                params["log_dir"] = json!(abs(dir).to_string_lossy());
            }
            engine.call("run_action", params)
        }

        CliCommand::PortfolioCreate(args) => {
            let sources: Vec<String> = args
                .inputs
                .iter()
                .map(|p| abs(p).to_string_lossy().into_owned())
                .collect();
            let mut params = json!({
                "output": abs(&args.output).to_string_lossy(),
                "sources": sources,
            });
            if let Some(title) = &args.title {
                params["title"] = json!(title);
            }
            engine.call("create_portfolio", params)
        }

        CliCommand::PortfolioMake(args) => engine.call(
            "make_portfolio",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
            }),
        ),

        CliCommand::PortfolioUpdate(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "name": args.name,
                "source": abs(&args.source).to_string_lossy(),
            });
            if let Some(desc) = &args.description {
                params["description"] = json!(desc);
            }
            engine.call("update_portfolio_member", params)
        }

        CliCommand::LayerList(args) => engine.call(
            "list_layers",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::Accessibility(args) => engine.call(
            "check_accessibility",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "category": args.category,
            }),
        ),

        CliCommand::AccessibilityFix(args) => engine.call(
            "apply_accessibility_fixes",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "checks": if args.fixes.is_empty() { None } else { Some(args.fixes.clone()) },
                "allow_signed": args.allow_signed,
            }),
        ),

        CliCommand::Preflight(args) => engine.call(
            "preflight",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "profile": args.profile,
                "profile_path": args.profile_path.as_ref()
                    .map(|p| abs(p).to_string_lossy().into_owned())
                    .unwrap_or_default(),
                // The bundled device. Total area coverage is the one check
                // that needs it, and a missing one is reported by the check
                // rather than refused by the run.
                "gs_path": resolve_gs().to_string_lossy(),
            }),
        ),

        CliCommand::PreflightProfiles => engine.call("list_preflight_profiles", json!({})),

        CliCommand::PreflightFix(args) => engine.call(
            "apply_preflight_fixups",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "profile": args.profile,
                "profile_path": args.profile_path.as_ref()
                    .map(|p| abs(p).to_string_lossy().into_owned())
                    .unwrap_or_default(),
                "checks": if args.fixes.is_empty() { None } else { Some(args.fixes.clone()) },
                "gs_path": resolve_gs().to_string_lossy(),
                "font_dir": resolve_fonts().to_string_lossy(),
                "tesseract_path": resolve_tesseract().to_string_lossy(),
            }),
        ),

        CliCommand::PreflightSweep(args) => {
            let mut params = json!({
                "source": abs(&args.source).to_string_lossy(),
                "dest": args.dest.as_ref()
                    .map(|p| abs(p).to_string_lossy().to_string())
                    .unwrap_or_default(),
                "mode": if args.fix { "fix" } else { "check" },
                "profile": args.profile,
                "profile_path": args.profile_path.as_ref()
                    .map(|p| abs(p).to_string_lossy().into_owned())
                    .unwrap_or_default(),
                "gs_path": resolve_gs().to_string_lossy(),
                "font_dir": resolve_fonts().to_string_lossy(),
                "tesseract_path": resolve_tesseract().to_string_lossy(),
                "write_log": args.log_dir.is_some(),
                "progress": true,
                "in_place": args.in_place,
                "move_processed_root": args.moved.as_ref()
                    .map(|p| abs(p).to_string_lossy().to_string())
                    .unwrap_or_default(),
            });
            if let Some(dir) = &args.log_dir {
                params["log_dir"] = json!(abs(dir).to_string_lossy());
            }
            engine.call("run_preflight_sweep", params)
        }

        CliCommand::CommentsList(args) => engine.call(
            "list_annotations",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::CommentsReview(args) => engine.call(
            "list_comments",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "sort": args.sort,
                "filter": comment_filter(
                    &args.authors, &args.subtypes, &args.states, &args.pages,
                    args.with_body,
                ),
            }),
        ),

        // The furniture stays the engine's English here: a command line has no
        // UI language to resolve it from, and inventing one would put a second
        // answer in the product for what a summary's headings say.
        CliCommand::CommentsSummary(args) => engine.call(
            "summarize_comments",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "mode": args.mode,
                "placement": args.placement,
                "connectors": !args.no_connectors,
                "gutter": args.gutter,
                "paper": args.paper,
                "sort": args.sort,
                "filter": comment_filter(
                    &args.authors, &args.subtypes, &args.states, &args.pages,
                    args.with_body,
                ),
                "font_path": resolve_fonts().to_string_lossy(),
            }),
        ),

        CliCommand::LinkList(args) => engine.call(
            "list_links",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::LinkSet(args) => engine.call(
            "set_link_url",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "page": args.page,
                "index": args.index,
                "url": args.url,
            }),
        ),

        CliCommand::TagsList(args) => engine.call(
            "get_struct_tree",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::TagsSet(args) => {
            let mut props = serde_json::Map::new();
            if let Some(v) = &args.tag_type {
                props.insert("type".into(), json!(v));
            }
            if let Some(v) = &args.title {
                props.insert("title".into(), json!(v));
            }
            if let Some(v) = &args.alt {
                props.insert("alt".into(), json!(v));
            }
            if let Some(v) = &args.actual_text {
                props.insert("actual_text".into(), json!(v));
            }
            if let Some(v) = &args.lang {
                props.insert("lang".into(), json!(v));
            }
            engine.call(
                "set_struct_props",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "path": parse_tag_path(&args.path)?,
                    "props": props,
                }),
            )
        }

        CliCommand::TagsMove(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "path": parse_tag_path(&args.path)?,
                "direction": args.direction,
            });
            if let Some(index) = args.index {
                params["index"] = json!(index);
            }
            engine.call("move_struct_node", params)
        }

        CliCommand::TagsDelete(args) => engine.call(
            "delete_struct_node",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "path": parse_tag_path(&args.path)?,
            }),
        ),

        CliCommand::TagsAdd(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "parent_path": parse_tag_path(&args.parent)?,
                "stype": args.tag_type,
            });
            if let Some(index) = args.index {
                params["index"] = json!(index);
            }
            engine.call("add_struct_node", params)
        }

        CliCommand::Export(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "fmt": args.format,
                "soffice_path": resolve_soffice(),
                "gs_path": resolve_gs().to_string_lossy(),
            });
            // An omitted option stays absent rather than defaulting here: the
            // engine refuses an option the target does not take, and a value
            // sent unasked would turn every such refusal into a false one.
            if !args.pages.trim().is_empty() {
                params["pages"] = parse_pages(&args.pages);
            }
            if let Some(layout) = &args.layout {
                params["layout"] = json!(layout);
            }
            if args.page_breaks {
                params["page_breaks"] = json!(true);
            }
            if let Some(sheet_per) = &args.sheet_per {
                params["sheet_per"] = json!(sheet_per);
            }
            if args.include_untabled {
                params["include_untabled"] = json!(true);
            }
            if let Some(slide_size) = &args.slide_size {
                params["slide_size"] = json!(slide_size);
            }
            engine.call("export_document", params)
        }

        CliCommand::ExportFolder(args) => {
            // An omitted option stays absent rather than defaulting here: the
            // engine refuses an option the target does not take, and a value
            // sent unasked would turn every such refusal into a false one.
            let image = matches!(args.format.as_str(), "png" | "jpeg" | "tiff");
            let mut params = serde_json::Map::new();
            params.insert("fmt".into(), json!(args.format));
            if !args.pages.trim().is_empty() {
                params.insert(
                    "pages".into(),
                    if image { json!(args.pages.trim()) } else { parse_pages(&args.pages) },
                );
            }
            if image {
                params.insert("dpi".into(), json!(args.dpi));
                params.insert("gray".into(), json!(args.gray));
                if args.format == "jpeg" {
                    params.insert("quality".into(), json!(args.quality));
                }
            } else {
                if let Some(layout) = &args.layout {
                    params.insert("layout".into(), json!(layout));
                }
                if args.page_breaks {
                    params.insert("page_breaks".into(), json!(true));
                }
                if let Some(sheet_per) = &args.sheet_per {
                    params.insert("sheet_per".into(), json!(sheet_per));
                }
                if args.include_untabled {
                    params.insert("include_untabled".into(), json!(true));
                }
                if let Some(slide_size) = &args.slide_size {
                    params.insert("slide_size".into(), json!(slide_size));
                }
            }
            let op = if image { "export_images" } else { "export_document" };
            engine.call(
                "run_action",
                json!({
                    "source": abs(&args.source).to_string_lossy(),
                    "dest": abs(&args.dest).to_string_lossy(),
                    "steps": [{ "op": op, "params": serde_json::Value::Object(params) }],
                    "action_name": format!("Export folder to {}", args.format),
                    "gs_path": resolve_gs().to_string_lossy(),
                    "soffice_path": resolve_soffice(),
                    "log_dir": args
                        .log_dir
                        .as_ref()
                        .map(|p| abs(p).to_string_lossy().to_string())
                        .unwrap_or_default(),
                    "progress": args.verbose,
                }),
            )
        }

        CliCommand::ExportImages(args) => {
            let gs = resolve_gs();
            engine.call(
                "export_images",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "fmt": args.format,
                    "dpi": args.dpi,
                    "pages": args.pages,
                    "gray": args.gray,
                    "quality": args.quality,
                    "gs_path": gs.to_string_lossy(),
                }),
            )
        }

        CliCommand::LinkAdd(args) => engine.call(
            "add_links",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "links": [{ "page": args.page, "rect": args.rect, "url": args.url }],
            }),
        ),

        CliCommand::LinkDelete(args) => engine.call(
            "delete_link",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "page": args.page,
                "index": args.index,
            }),
        ),

        CliCommand::LinkFromUrls(args) => {
            let input = abs(&args.input).to_string_lossy().to_string();
            let pages = parse_pages(&args.pages);
            if args.preview {
                return engine.call(
                    "find_url_links",
                    json!({ "file": input, "pages": pages, "emails": !args.no_emails }),
                );
            }
            let output = match &args.output {
                Some(p) => abs(p).to_string_lossy().to_string(),
                None => return Err("link-from-urls: -o/--output is required".to_string()),
            };
            engine.call(
                "create_links_from_urls",
                json!({
                    "file": input,
                    "output": output,
                    "pages": pages,
                    "emails": !args.no_emails,
                    "skip_existing": !args.relink_existing,
                }),
            )
        }

        CliCommand::Articles(args) => {
            let input = abs(&args.input).to_string_lossy().to_string();
            match &args.from_json {
                None => engine.call("list_threads", json!({ "file": input })),
                Some(source) => {
                    let output = match &args.output {
                        Some(p) => abs(p).to_string_lossy().to_string(),
                        None => {
                            return Err(
                                "articles: -o/--output is required with --from-json".to_string()
                            )
                        }
                    };
                    let raw = read_json_source(source)?;
                    let parsed: Value = serde_json::from_str(&raw)
                        .map_err(|e| format!("invalid articles JSON: {}", e))?;
                    // Accept both the `articles <input>` output shape and a
                    // bare array, the `outline --from-json` convention.
                    let threads = match parsed {
                        Value::Array(items) => Value::Array(items),
                        Value::Object(ref map) => match map.get("threads") {
                            Some(Value::Array(items)) => Value::Array(items.clone()),
                            _ => {
                                return Err(
                                    "invalid articles JSON: expected an array or {\"threads\": [...]}"
                                        .to_string(),
                                )
                            }
                        },
                        _ => {
                            return Err(
                                "invalid articles JSON: expected an array or {\"threads\": [...]}"
                                    .to_string(),
                            )
                        }
                    };
                    engine.call(
                        "set_threads",
                        json!({ "file": input, "threads": threads, "output": output }),
                    )
                }
            }
        }

        CliCommand::OutlineFromStructure(args) => engine.call(
            "outline_from_structure",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "mode": if args.append { "append" } else { "replace" },
                "max_level": args.levels,
                "tag_if_untagged": args.autotag,
            }),
        ),

        CliCommand::CommentsDeleteAll(args) => engine.call(
            "delete_all_annotations",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
            }),
        ),

        CliCommand::LayerSet(args) => engine.call(
            "set_layer_visibility",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "index": args.index,
                "visible": args.show,
            }),
        ),

        CliCommand::Compare(args) => {
            if args.visual {
                let gs = resolve_gs();
                engine.call(
                    "compare_visual",
                    json!({
                        "file_a": abs(&args.a).to_string_lossy(),
                        "file_b": abs(&args.b).to_string_lossy(),
                        "dpi": args.dpi,
                        "gs_path": gs.to_string_lossy(),
                    }),
                )
            } else {
                engine.call(
                    "compare_text",
                    json!({
                        "file_a": abs(&args.a).to_string_lossy(),
                        "file_b": abs(&args.b).to_string_lossy(),
                        "context": args.context,
                    }),
                )
            }
        }

        CliCommand::VerifySignatures(args) => {
            let mut params = json!({ "file": abs(&args.input).to_string_lossy() });
            if !args.trust_roots.is_empty() {
                let roots: Vec<String> = args
                    .trust_roots
                    .iter()
                    .map(|p| abs(p).to_string_lossy().to_string())
                    .collect();
                params["trust_roots"] = json!(roots);
            }
            if args.system_trust {
                params["system_trust"] = json!(true);
            }
            if args.eutl_trust {
                params["eutl_trust"] = json!(true);
            }
            engine.call("verify_signatures", params)
        }

        CliCommand::Sign(args) => {
            // Password from --password, else read one line from stdin (so a
            // script can pipe it without it landing in the process arg list or
            // shell history).
            let password = match &args.password {
                Some(p) => p.clone(),
                None => {
                    use std::io::Read;
                    let mut s = String::new();
                    std::io::stdin()
                        .read_to_string(&mut s)
                        .map_err(|e| format!("failed to read password from stdin: {}", e))?;
                    s.trim_end_matches(['\r', '\n']).to_string()
                }
            };
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
            });
            // A PKCS#11 source takes the password as its PIN; the
            // file-based sources take it as the passphrase.
            if args.pkcs11_module.is_some() {
                params["pkcs11_pin"] = json!(password);
            } else {
                params["password"] = json!(password);
            }
            // Signer source: --pfx, --key + --cert, or a PKCS#11 token
            // (clap enforces the pairing/conflicts; the engine re-validates).
            if let Some(module) = &args.pkcs11_module {
                params["pkcs11_module"] = json!(abs(module).to_string_lossy());
                params["pkcs11_token"] = json!(args.token_label.as_deref().unwrap_or(""));
                params["pkcs11_cert_label"] = json!(args.cert_label.as_deref().unwrap_or(""));
                if let Some(kl) = &args.key_label {
                    params["pkcs11_key_label"] = json!(kl);
                }
            }
            if let Some(pfx) = &args.pfx {
                params["pfx_path"] = json!(abs(pfx).to_string_lossy());
            }
            if let Some(key) = &args.key {
                params["key_path"] = json!(abs(key).to_string_lossy());
            }
            if let Some(cert) = &args.cert {
                params["cert_path"] = json!(abs(cert).to_string_lossy());
            }
            if let Some(reason) = &args.reason {
                params["reason"] = json!(reason);
            }
            if let Some(location) = &args.location {
                params["location"] = json!(location);
            }
            // Visible stamp: --visible-page N --visible-rect x0,y0,x1,y1
            // (rect parsing matches the redact --rect convention).
            if let (Some(page), Some(rect_str)) = (&args.visible_page, &args.visible_rect) {
                let nums: Result<Vec<f64>, _> =
                    rect_str.split(',').map(|s| s.trim().parse::<f64>()).collect();
                let nums = nums.map_err(|_| {
                    "invalid --visible-rect: expected four comma-separated numbers x0,y0,x1,y1"
                        .to_string()
                })?;
                if nums.len() != 4 {
                    return Err(
                        "invalid --visible-rect: expected exactly four numbers x0,y0,x1,y1"
                            .to_string(),
                    );
                }
                params["appearance"] = json!({ "page": page, "rect": nums });
            }
            // Fill an existing empty signature field — clap already
            // forbids combining this with the visible-stamp flags.
            if let Some(field) = &args.existing_field {
                params["existing_field"] = json!(field);
            }
            if args.pades {
                params["pades"] = json!(true);
            }
            if let Some(tsa) = &args.tsa_url {
                params["tsa_url"] = json!(tsa);
            }
            if args.embed_revocation {
                params["embed_revocation"] = json!(true);
            }
            if args.lta {
                params["lta"] = json!(true);
            }
            // The wire carries level NAMES; clap's value_parser rejects any
            // other spelling, and the engine re-validates.
            if args.certify {
                params["certify"] = json!(true);
            }
            if let Some(level) = &args.certify_level {
                params["certify_level"] = json!(level);
            }
            if let Some(action) = &args.lock {
                params["lock"] = json!(action);
                params["lock_fields"] = json!(args.lock_field);
            }
            if !args.trust_roots.is_empty() {
                let roots: Vec<String> = args
                    .trust_roots
                    .iter()
                    .map(|p| abs(p).to_string_lossy().to_string())
                    .collect();
                params["trust_roots"] = json!(roots);
            }
            if args.system_trust {
                params["system_trust"] = json!(true);
            }
            if args.eutl_trust {
                params["eutl_trust"] = json!(true);
            }
            engine.call("sign_pdf", params)
        }

        CliCommand::Forms(args) => {
            let input = abs(&args.input).to_string_lossy().to_string();
            if let Some(field) = &args.sig_field {
                // The parser guarantees an --output and exactly one of
                // --lock / --clear-lock; --clear-lock is the null lock.
                let output = abs(args.output.as_ref().unwrap()).to_string_lossy().to_string();
                let mut params = json!({
                    "file": input,
                    "output": output,
                    "field": field,
                });
                if let Some(action) = &args.lock {
                    params["lock"] = json!(action);
                    params["lock_fields"] = json!(args.lock_field);
                }
                return engine.call("set_field_lock", params);
            }
            // The scope every data arm shares: a field list, optionally
            // inverted, exactly as /ResetForm and /SubmitForm encode it.
            let scope = |params: &mut serde_json::Value| {
                if !args.field.is_empty() {
                    params["fields"] = json!(args.field);
                    params["exclude"] = json!(args.exclude_fields);
                }
            };
            if let Some(target) = &args.export_data {
                // Read-only against the document: the payload lands in its own
                // file and nothing is transmitted.
                let mut params = json!({
                    "file": input,
                    "output": abs(target).to_string_lossy().to_string(),
                    "format": args.data_format,
                    "include_empty": args.include_empty,
                });
                scope(&mut params);
                return engine.call("export_form_data", params);
            }
            if args.reset || args.import_data.is_some() {
                let output = abs(args.output.as_ref().unwrap()).to_string_lossy().to_string();
                let fonts = resolve_fonts().to_string_lossy().to_string();
                let mut params = json!({
                    "file": input,
                    "output": output,
                    "font_dir": fonts,
                });
                scope(&mut params);
                if let Some(data) = &args.import_data {
                    params["data"] = json!(abs(data).to_string_lossy().to_string());
                    return engine.call("import_form_data", params);
                }
                return engine.call("reset_form_fields", params);
            }
            if args.set.is_empty() && !args.flatten {
                return engine.call("read_form_fields", json!({ "file": input }));
            }
            let output = match &args.output {
                Some(p) => abs(p).to_string_lossy().to_string(),
                None => {
                    return Err(
                        "forms: -o/--output is required when filling (--set) or flattening"
                            .to_string(),
                    )
                }
            };
            let mut edits = serde_json::Map::new();
            for pair in &args.set {
                match pair.split_once('=') {
                    Some((name, value)) if !name.is_empty() => {
                        edits.insert(name.to_string(), json!(value));
                    }
                    _ => {
                        return Err(format!(
                            "invalid --set {:?}: expected NAME=VALUE",
                            pair
                        ))
                    }
                }
            }
            engine.call(
                "fill_form_fields",
                json!({
                    "file": input,
                    "output": output,
                    "edits": edits,
                    "flatten": args.flatten,
                    "font_dir": resolve_fonts().to_string_lossy().to_string(),
                }),
            )
        }

        CliCommand::DetectFields(args) => {
            // Read-only: it reports where fields COULD go and writes nothing.
            // Field creation itself stays an interactive canvas gesture, the
            // same class as annotations and redaction marks; a report is not.
            engine.call(
                "detect_form_fields",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "pages": parse_pages(&args.pages),
                    "scan": args.scan,
                    "lang": args.lang,
                    "tesseract_path": resolve_tesseract().to_string_lossy(),
                    "gs_path": resolve_gs().to_string_lossy(),
                    "max_candidates": args.max_candidates,
                }),
            )
        }

        CliCommand::PrepareForms(args) => {
            // A headless run has no reviewer, so every candidate the detector
            // offers becomes a field; `--kinds` is the only narrowing.
            let kinds: Vec<String> = args
                .kinds
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "pages": parse_pages(&args.pages),
                "scan": args.scan,
                "lang": args.lang,
                "tesseract_path": resolve_tesseract().to_string_lossy(),
                "gs_path": resolve_gs().to_string_lossy(),
                "max_candidates": args.max_candidates,
                "allow_signed": args.include_signed,
                "font_dir": resolve_fonts().to_string_lossy().to_string(),
            });
            if !kinds.is_empty() {
                params["kinds"] = json!(kinds);
            }
            engine.call("prepare_form_fields", params)
        }

        CliCommand::Audit(args) => engine.call(
            "audit_hidden_information",
            json!({
                "file": abs(&args.input).to_string_lossy(),
                "pages": parse_pages(&args.pages),
                "deep_text": !args.no_hidden_text,
            }),
        ),

        CliCommand::AuditSpace(args) => engine.call(
            "audit_space_usage",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::Sanitize(args) => {
            let categories: Vec<String> = args
                .categories
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            engine.call(
                "sanitize_pdf",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "categories": categories,
                    "all_removable": args.all_removable,
                    "form_fields_mode": args.form_fields_mode,
                    "hidden_text_ocr": args.include_ocr_layer,
                }),
            )
        }

        CliCommand::DocumentJsList(args) => engine.call(
            "list_document_js",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::DocumentJsSet(args) => {
            let raw = if args.from_json == "-" {
                use std::io::Read;
                let mut s = String::new();
                std::io::stdin()
                    .read_to_string(&mut s)
                    .map_err(|e| format!("failed to read JSON from stdin: {}", e))?;
                s
            } else {
                std::fs::read_to_string(&args.from_json)
                    .map_err(|e| format!("failed to read {}: {}", args.from_json, e))?
            };
            let parsed: Value = serde_json::from_str(&raw)
                .map_err(|e| format!("invalid document-JavaScript JSON: {}", e))?;
            // An empty array is meaningful (remove every script), so only a
            // non-array is refused.
            if !parsed.is_array() {
                return Err("document-js-set: the JSON must be an array of {name, js}".to_string());
            }
            engine.call(
                "set_document_js",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "scripts": parsed,
                }),
            )
        }

        CliCommand::Outline(args) => {
            let input = abs(&args.input).to_string_lossy().to_string();
            match &args.from_json {
                None => engine.call("get_outline", json!({ "file": input })),
                Some(source) => {
                    let output = match &args.output {
                        Some(p) => abs(p).to_string_lossy().to_string(),
                        None => {
                            return Err(
                                "outline: -o/--output is required with --from-json".to_string()
                            )
                        }
                    };
                    let raw = read_json_source(source)?;
                    let parsed: Value = serde_json::from_str(&raw)
                        .map_err(|e| format!("invalid outline JSON: {}", e))?;
                    // Accept both the `outline <input>` output shape and a bare array.
                    let tree = match parsed {
                        Value::Array(items) => Value::Array(items),
                        Value::Object(ref map) => match map.get("outline") {
                            Some(Value::Array(items)) => Value::Array(items.clone()),
                            _ => {
                                return Err(
                                    "invalid outline JSON: expected an array or {\"outline\": [...]}"
                                        .to_string(),
                                )
                            }
                        },
                        _ => {
                            return Err(
                                "invalid outline JSON: expected an array or {\"outline\": [...]}"
                                    .to_string(),
                            )
                        }
                    };
                    engine.call(
                        "set_outline",
                        json!({ "file": input, "outline": tree, "output": output }),
                    )
                }
            }
        }

        CliCommand::GenerateSigner(args) => {
            let password = match &args.password {
                Some(p) => p.clone(),
                None => {
                    use std::io::Read;
                    let mut s = String::new();
                    std::io::stdin()
                        .read_to_string(&mut s)
                        .map_err(|e| format!("failed to read password from stdin: {}", e))?;
                    s.trim_end_matches(['\r', '\n']).to_string()
                }
            };
            let mut params = json!({
                "common_name": args.cn,
                "output": abs(&args.output).to_string_lossy(),
                "password": password,
                "valid_days": args.days,
                "overwrite": args.force,
            });
            if let Some(org) = &args.org {
                params["org"] = json!(org);
            }
            engine.call("generate_signer", params)
        }

        CliCommand::Metadata(args) => {
            let input = abs(&args.input);
            let input_str = input.to_string_lossy().to_string();

            // Strip mode
            if args.strip {
                let output = args
                    .output
                    .as_ref()
                    .map(|p| abs(p))
                    .unwrap_or_else(|| input.clone());
                return engine.call(
                    "strip_metadata",
                    json!({
                        "file": input_str,
                        "output": output.to_string_lossy(),
                    }),
                );
            }

            // If no output and no set-fields → read-only
            if args.output.is_none()
                && args.title.is_none()
                && args.author.is_none()
                && args.subject.is_none()
                && args.keywords.is_none()
            {
                return engine.call("get_metadata", json!({ "file": input_str }));
            }

            // Build set_metadata params
            let output = args
                .output
                .as_ref()
                .map(|p| abs(p))
                .unwrap_or_else(|| input.clone());
            let mut params = json!({
                "file": input_str,
                "output": output.to_string_lossy(),
            });
            if let Some(ref t) = args.title {
                params["title"] = json!(t);
            }
            if let Some(ref a) = args.author {
                params["author"] = json!(a);
            }
            if let Some(ref s) = args.subject {
                params["subject"] = json!(s);
            }
            if let Some(ref k) = args.keywords {
                params["keywords"] = json!(k);
            }
            engine.call("set_metadata", params)
        }

        CliCommand::Grayscale(args) => {
            let gs = resolve_gs();
            engine.call(
                "grayscale",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "gs_path": gs.to_string_lossy(),
                }),
            )
        }

        CliCommand::Distill(args) => {
            let gs = resolve_gs();
            engine.call(
                "distill",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "preset": args.preset,
                    "gs_path": gs.to_string_lossy(),
                }),
            )
        }

        CliCommand::Optimize(args) => {
            engine.call(
                "optimize",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "linearize": args.linearize,
                    "strip_metadata": args.strip_metadata,
                    "compress_streams": args.compress_streams,
                }),
            )
        }

        CliCommand::PdfVersion(args) => {
            engine.call(
                "set_pdf_version",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "version": args.version,
                }),
            )
        }

        CliCommand::Repair(args) => {
            engine.call(
                "repair",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                }),
            )
        }

        CliCommand::Autotag(args) => {
            engine.call(
                "autotag",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                }),
            )
        }

        CliCommand::BatchOcr(args) => {
            // The whole tree in ONE engine call: the loop, the filing and the
            // log all live engine-side (engine/batch_ocr.py) so the CLI and a
            // scheduled run behave identically to each other -- and log
            // identically to the GUI.
            let gs = resolve_gs();
            engine.call(
                "batch_ocr",
                json!({
                    "source": abs(&args.source).to_string_lossy(),
                    "dest": args.dest.as_ref().map(|p| abs(p).to_string_lossy().to_string()).unwrap_or_default(),
                    "lang": args.lang,
                    "tesseract_path": resolve_tesseract().to_string_lossy(),
                    "gs_path": gs.to_string_lossy(),
                    "moved_root": args.moved.as_ref().map(|p| abs(p).to_string_lossy().to_string()).unwrap_or_default(),
                    "error_root": args.errors.as_ref().map(|p| abs(p).to_string_lossy().to_string()).unwrap_or_default(),
                    "repair_damaged": args.repair,
                    "replace_repaired_originals": args.replace_repaired,
                    "log_dir": args.log_dir.as_ref().map(|p| abs(p).to_string_lossy().to_string()).unwrap_or_default(),
                    "progress": args.verbose,
                    "in_place": args.in_place,
                    "include_images": args.images,
                    "mrc": args.mrc,
                    "mrc_preset": args.mrc_preset,
                    "mrc_verify_text": args.mrc_verify_text,
                    "enhance": args.enhance,
                    "enhance_orientation": !args.no_enhance_orientation,
                    "passwords": args
                        .passwords
                        .iter()
                        .filter_map(|entry| {
                            // FIRST '=' only: a password may itself contain one.
                            entry.split_once('=').map(|(file, pw)| {
                                (file.to_string(), serde_json::Value::from(pw))
                            })
                        })
                        .collect::<serde_json::Map<_, _>>(),
                }),
            )
        }

        CliCommand::Rebuild(args) => {
            let gs = resolve_gs();
            engine.call(
                "rebuild",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "gs_path": gs.to_string_lossy(),
                }),
            )
        }

        CliCommand::Recover(args) => {
            engine.call(
                "recover",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                }),
            )
        }

        CliCommand::Check(args) => {
            engine.call(
                "check",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                }),
            )
        }

        CliCommand::Batch(args) => run_batch(engine, args),
    }
}

// ── Batch mode ──────────────────────────────────────────────────────────────

fn run_batch(engine: &mut CliEngine, args: &BatchArgs) -> Result<Value, String> {
    let input_dir = abs(&args.input_dir);
    let output_dir = abs(&args.output);
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Cannot create output dir: {}", e))?;

    // Create PDF is the one operation whose inputs are not PDFs — a folder of
    // Word files is the whole point of it.
    let creating = matches!(args.operation, BatchOperation::CreatePdf { .. });
    let pdfs = if creating {
        collect_create_pdf_sources(&input_dir)?
    } else {
        collect_pdfs(&input_dir)?
    };
    if pdfs.is_empty() {
        return Err(if creating {
            format!("No convertible files found in {}", input_dir.display())
        } else {
            format!("No PDF files found in {}", input_dir.display())
        });
    }

    let gs = resolve_gs();
    let total = pdfs.len();
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut results: Vec<Value> = Vec::new();

    for (i, pdf) in pdfs.iter().enumerate() {
        let filename = pdf.file_name().unwrap().to_string_lossy().to_string();
        // A converted source's output name GAINS `.pdf` rather than replacing
        // the extension: `invoice.docx` and `invoice.pdf` in one folder must
        // not collide, and the original name stays legible.
        let out_name = if creating && !filename.to_ascii_lowercase().ends_with(".pdf") {
            format!("{filename}.pdf")
        } else {
            filename.clone()
        };
        let out_path = output_dir.join(&out_name);

        eprintln!("[{}/{}] {}", i + 1, total, filename);

        let result = match &args.operation {
            BatchOperation::Compress {
                quality,
                mrc_preset,
                mrc_mask_codec,
                mrc_pdfa_safe,
                mrc_verify_text,
                mrc_lang,
            } => engine.call(
                "compress",
                json!({
                    "file": pdf.to_string_lossy(),
                    "output": out_path.to_string_lossy(),
                    "quality": quality,
                    "gs_path": gs.to_string_lossy(),
                    "mrc_preset": mrc_preset,
                    "mrc_mask_codec": mrc_mask_codec.clone().unwrap_or_default(),
                    "mrc_pdfa_safe": mrc_pdfa_safe,
                    "mrc_verify_text": mrc_verify_text,
                    "mrc_lang": mrc_lang,
                    "tesseract_path": resolve_tesseract().to_string_lossy(),
                }),
            ),
            BatchOperation::Rotate { angle, pages } => engine.call(
                "rotate",
                json!({
                    "file": pdf.to_string_lossy(),
                    "output": out_path.to_string_lossy(),
                    "angle": angle,
                    "pages": parse_pages(pages),
                }),
            ),
            BatchOperation::Pdfa { level } => engine.call(
                "convert_pdfa",
                json!({
                    "file": pdf.to_string_lossy(),
                    "output": out_path.to_string_lossy(),
                    "level": level,
                    "gs_path": gs.to_string_lossy(),
                }),
            ),
            BatchOperation::Grayscale => engine.call(
                "grayscale",
                json!({
                    "file": pdf.to_string_lossy(),
                    "output": out_path.to_string_lossy(),
                    "gs_path": gs.to_string_lossy(),
                }),
            ),
            BatchOperation::Optimize { strip_metadata } => engine.call(
                "optimize",
                json!({
                    "file": pdf.to_string_lossy(),
                    "output": out_path.to_string_lossy(),
                    "linearize": true,
                    "strip_metadata": strip_metadata,
                    "compress_streams": true,
                }),
            ),
            BatchOperation::Repair => engine.call(
                "repair",
                json!({
                    "file": pdf.to_string_lossy(),
                    "output": out_path.to_string_lossy(),
                }),
            ),
            BatchOperation::Rebuild => {
                let gs = resolve_gs();
                engine.call(
                    "rebuild",
                    json!({
                        "file": pdf.to_string_lossy(),
                        "output": out_path.to_string_lossy(),
                        "gs_path": gs.to_string_lossy(),
                    }),
                )
            }
            BatchOperation::Recover => engine.call(
                "recover",
                json!({
                    "file": pdf.to_string_lossy(),
                    "output": out_path.to_string_lossy(),
                }),
            ),
            BatchOperation::CreatePdf {
                page_size,
                orientation,
                margin,
                image_dpi,
                quality,
            } => engine.call(
                "create_pdf",
                json!({
                    "sources": [{ "path": pdf.to_string_lossy() }],
                    "output": out_path.to_string_lossy(),
                    "page_size": page_size,
                    "orientation": orientation,
                    "margin_pt": margin,
                    "image_dpi_default": image_dpi,
                    "distill_preset": quality,
                    "gs_path": gs.to_string_lossy(),
                    "soffice_path": resolve_soffice(),
                }),
            ),
        };

        match result {
            Ok(val) => {
                succeeded += 1;
                results.push(json!({ "file": filename, "status": "ok", "result": val }));
            }
            Err(msg) => {
                failed += 1;
                eprintln!("  error: {}", msg);
                results.push(json!({ "file": filename, "status": "error", "error": msg }));
            }
        }
    }

    eprintln!(
        "\nBatch complete: {} succeeded, {} failed, {} total",
        succeeded, failed, total
    );

    Ok(json!({
        "total": total,
        "succeeded": succeeded,
        "failed": failed,
        "results": results,
    }))
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// The CLI's own half of Create PDF is ARGUMENT PARSING and a
// folder walk — the conversion itself is the engine's, and pytest covers it.
// What can go wrong here is a subcommand that does not parse the way its help
// text claims, and a batch walk that picks up the wrong files.
#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn parse(args: &[&str]) -> Cli {
        Cli::try_parse_from(args).expect("should parse")
    }

    fn scan_capabilities() -> crate::scanner::ScannerCapabilities {
        use crate::scanner::*;
        let feeder = ScanSourceReport {
            item_name: "Root\\feeder".into(),
            category: SourceCategory::Feeder,
            properties: Vec::new(),
            resolution: ControlModel::Absent,
            optical_resolution: None,
            color_modes: vec![ColorMode::Grayscale, ColorMode::Color],
            brightness: ControlModel::Absent,
            contrast: ControlModel::Absent,
            pages: ControlModel::Span {
                min: 0,
                max: 99,
                step: 1,
                current: Some(0),
            },
            document_handling_select: ControlModel::Flags {
                valid: 7,
                current: Some(1),
            },
        };
        ScannerCapabilities {
            device_id: "dev".into(),
            device_name: "A Scanner".into(),
            document_handling: DocumentHandling {
                capabilities: 5,
                flatbed: false,
                feeder: true,
                duplex: true,
                advanced_duplex: false,
                duplex_mode: DuplexMode::DuplexBit,
                flatbed_select: 2,
                feeder_select: 1,
                duplex_select: 5,
            },
            source_options: vec![
                ScanSourceOption {
                    id: SourceOptionId::Feeder,
                    item_name: "Root\\feeder".into(),
                    document_handling: Some(1),
                    feeds: true,
                },
                ScanSourceOption {
                    id: SourceOptionId::Duplex,
                    item_name: "Root\\feeder".into(),
                    document_handling: Some(5),
                    feeds: true,
                },
            ],
            max_scan_time_ms: Some(60_000),
            sources: vec![feeder],
        }
    }

    fn scan_args(extra: &[&str]) -> ScanArgs {
        let mut argv: Vec<&str> = vec!["spectrapdf", "scan", "-o", "out.pdf"];
        argv.extend_from_slice(extra);
        match parse(&argv).command {
            Some(CliCommand::Scan(args)) => args,
            _ => panic!("scan should parse"),
        }
    }

    #[test]
    fn scan_takes_the_documented_flags() {
        let args = scan_args(&[
            "--device", "dev", "--dpi", "600", "--color", "gray", "--source", "duplex", "--pages",
            "0", "--paper", "a4",
        ]);
        assert_eq!(args.device.as_deref(), Some("dev"));
        assert_eq!(args.dpi, Some(600));
        assert_eq!(args.color.as_deref(), Some("gray"));
        assert_eq!(args.source.as_deref(), Some("duplex"));
        assert_eq!(args.pages, Some(0));
        assert_eq!(args.paper, "a4");
        // Omitted settings stay absent: they leave the device's own value
        // alone, which is not the same as writing a default over it.
        let bare = scan_args(&[]);
        assert_eq!(bare.dpi, None);
        assert_eq!(bare.color, None);
        assert_eq!(bare.paper, "auto");
    }

    #[test]
    fn scan_settings_come_from_the_reported_source_rows() {
        let caps = scan_capabilities();
        let settings = scan_settings(&caps, &scan_args(&["--source", "duplex", "--pages", "3"]))
            .expect("duplex is offered");
        assert_eq!(settings.item_name.as_deref(), Some("Root\\feeder"));
        assert_eq!(settings.document_handling, Some(5));
        assert_eq!(settings.pages, Some(3));
        // No --source takes the first row the device reported, never a guess.
        let settings = scan_settings(&caps, &scan_args(&[])).expect("a first row exists");
        assert_eq!(settings.document_handling, Some(1));
    }

    #[test]
    fn scan_refuses_a_source_or_a_colour_the_device_does_not_offer() {
        let caps = scan_capabilities();
        // This device reports no flatbed row, so asking for one is refused
        // rather than silently scanned from the feeder.
        let refusal = scan_settings(&caps, &scan_args(&["--source", "flatbed"]))
            .expect_err("a flatbed row is not offered");
        assert!(refusal.contains("does not offer that source"), "{refusal}");
        // A colour mode the device never listed would come back in the wrong
        // colour, so it is refused too.
        let refusal = scan_settings(&caps, &scan_args(&["--color", "bw"]))
            .expect_err("black and white is not listed");
        assert!(refusal.contains("colour mode"), "{refusal}");
        // And the vocabularies themselves are checked by name.
        assert!(scan_settings(&caps, &scan_args(&["--source", "film"])).is_err());
        assert!(scan_settings(&caps, &scan_args(&["--color", "sepia"])).is_err());
        assert!(scan_settings(&caps, &scan_args(&["--paper", "foolscap"])).is_err());
    }

    #[test]
    fn a_page_count_is_dropped_on_a_source_that_cannot_feed_sheets() {
        use crate::scanner::{ScanSourceOption, SourceOptionId};
        let mut caps = scan_capabilities();
        caps.source_options = vec![ScanSourceOption {
            id: SourceOptionId::Flatbed,
            item_name: "Root\\flatbed".into(),
            document_handling: Some(2),
            feeds: false,
        }];
        let settings = scan_settings(&caps, &scan_args(&["--pages", "5"])).expect("flatbed row");
        assert_eq!(settings.pages, None);
    }

    #[test]
    fn a_headless_run_refuses_to_pick_between_scanners() {
        // A named device is taken as given; the enumeration only decides when
        // none was named, and this box has no scanner.
        assert_eq!(resolve_scan_device(Some("dev")).as_deref(), Ok("dev"));
        let refusal = resolve_scan_device(None).expect_err("no scanner is attached here");
        assert!(refusal.contains("No scanners found"), "{refusal}");
    }

    #[test]
    fn create_pdf_takes_an_ordered_source_list_and_the_documented_flags() {
        let cli = parse(&[
            "spectrapdf",
            "create-pdf",
            "cover.png",
            "body.docx",
            "-o",
            "out.pdf",
            "--page-size",
            "a4",
            "--orientation",
            "landscape",
            "--margin",
            "18",
            "--image-dpi",
            "150",
            "--blank",
            "--quality",
            "prepress",
        ]);
        match cli.command {
            Some(CliCommand::CreatePdf(args)) => {
                assert_eq!(
                    args.sources,
                    vec![PathBuf::from("cover.png"), PathBuf::from("body.docx")]
                );
                assert_eq!(args.output, PathBuf::from("out.pdf"));
                assert_eq!(args.page_size, "a4");
                assert_eq!(args.orientation, "landscape");
                assert_eq!(args.margin, 18.0);
                assert_eq!(args.image_dpi, 150.0);
                assert!(args.blank);
                assert_eq!(args.quality, "prepress");
                assert!(!args.skip_unsupported);
            }
            _ => panic!("not the create-pdf arm"),
        }
    }

    #[test]
    fn create_pdf_defaults_change_nothing_about_the_sources() {
        let cli = parse(&["spectrapdf", "create-pdf", "a.png", "-o", "out.pdf"]);
        match cli.command {
            Some(CliCommand::CreatePdf(args)) => {
                // `auto` on both is "keep every source's own geometry" — the
                // default must never silently reformat what it was given.
                assert_eq!(args.page_size, "auto");
                assert_eq!(args.orientation, "auto");
                assert_eq!(args.margin, 0.0);
                assert_eq!(args.image_dpi, 200.0);
                assert!(!args.blank);
            }
            _ => panic!("not the create-pdf arm"),
        }
    }

    #[test]
    fn merge_still_takes_a_plain_input_list() {
        let cli = parse(&["spectrapdf", "merge", "a.pdf", "b.docx", "-o", "out.pdf"]);
        match cli.command {
            Some(CliCommand::Merge(args)) => {
                assert_eq!(args.inputs.len(), 2);
                assert_eq!(args.output, PathBuf::from("out.pdf"));
            }
            _ => panic!("not the merge arm"),
        }
    }

    #[test]
    fn batch_create_pdf_parses_with_its_own_flags() {
        let cli = parse(&[
            "spectrapdf",
            "batch",
            "in",
            "-o",
            "out",
            "create-pdf",
            "--page-size",
            "letter",
        ]);
        match cli.command {
            Some(CliCommand::Batch(args)) => match args.operation {
                BatchOperation::CreatePdf { page_size, .. } => assert_eq!(page_size, "letter"),
                _ => panic!("not the create-pdf batch operation"),
            },
            _ => panic!("not the batch arm"),
        }
    }

    #[test]
    fn the_create_pdf_batch_walk_takes_more_than_pdfs_and_the_others_do_not() {
        let dir = std::env::temp_dir().join(format!("spectra-cli-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["a.pdf", "b.docx", "c.PNG", "d.zip"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let names = |paths: Vec<PathBuf>| {
            let mut out: Vec<String> = paths
                .iter()
                .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
                .collect();
            out.sort();
            out
        };
        assert_eq!(names(collect_pdfs(&dir).unwrap()), vec!["a.pdf"]);
        // Case-insensitive, and `.zip` is not in any arm's set.
        assert_eq!(
            names(collect_create_pdf_sources(&dir).unwrap()),
            vec!["a.pdf", "b.docx", "c.PNG"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn forms_seeds_a_signature_fields_own_lock() {
        let cli = parse(&[
            "spectrapdf",
            "forms",
            "in.pdf",
            "-o",
            "out.pdf",
            "--sig-field",
            "Signature1",
            "--lock",
            "include",
            "--lock-field",
            "applicant",
            "--lock-field",
            "reviewer",
        ]);
        match cli.command {
            Some(CliCommand::Forms(args)) => {
                assert_eq!(args.sig_field.as_deref(), Some("Signature1"));
                assert_eq!(args.lock.as_deref(), Some("include"));
                assert_eq!(args.lock_field, vec!["applicant", "reviewer"]);
                assert!(!args.clear_lock);
            }
            _ => panic!("not the forms arm"),
        }
    }

    #[test]
    fn a_named_signature_field_states_exactly_one_lock_intent() {
        // A bare --sig-field would clear the lock by omission.
        assert!(
            Cli::try_parse_from(["spectrapdf", "forms", "in.pdf", "-o", "out.pdf", "--sig-field", "S"])
                .is_err()
        );
        // Setting and clearing are exclusive.
        assert!(Cli::try_parse_from([
            "spectrapdf", "forms", "in.pdf", "-o", "out.pdf", "--sig-field", "S", "--lock", "all",
            "--clear-lock",
        ])
        .is_err());
        // Clearing needs no field names and no action.
        let cli = parse(&[
            "spectrapdf", "forms", "in.pdf", "-o", "out.pdf", "--sig-field", "S", "--clear-lock",
        ]);
        match cli.command {
            Some(CliCommand::Forms(args)) => {
                assert!(args.clear_lock);
                assert!(args.lock.is_none());
            }
            _ => panic!("not the forms arm"),
        }
        // Listing a document's fields still takes no lock flags at all.
        assert!(Cli::try_parse_from(["spectrapdf", "forms", "in.pdf"]).is_ok());
    }

    /// The scan-enhancement pair. It exists on this arm because the GUI's
    /// Batch OCR dialog offers it and a scheduled run is that dialog with
    /// nobody watching -- a setting the dialog can express and the command
    /// line cannot is a schedule that runs a different job.
    #[test]
    fn batch_ocr_carries_the_enhancement_pair() {
        let cli = parse(&["spectrapdf", "batch-ocr", "scans", "--dest", "out", "--enhance"]);
        match cli.command {
            Some(CliCommand::BatchOcr(args)) => {
                assert!(args.enhance);
                // Orientation detection runs WITH --enhance; only the explicit
                // flag turns it off, so its absence must read as on.
                assert!(!args.no_enhance_orientation);
            }
            _ => panic!("not the batch-ocr arm"),
        }
        let cli = parse(&[
            "spectrapdf", "batch-ocr", "scans", "--in-place", "--enhance",
            "--no-enhance-orientation",
        ]);
        match cli.command {
            Some(CliCommand::BatchOcr(args)) => {
                assert!(args.in_place && args.enhance && args.no_enhance_orientation);
                assert!(args.dest.is_none());
            }
            _ => panic!("not the batch-ocr arm"),
        }
        // In-place and a destination are still mutually exclusive.
        assert!(Cli::try_parse_from([
            "spectrapdf", "batch-ocr", "scans", "--in-place", "--dest", "out",
        ])
        .is_err());
    }
}
