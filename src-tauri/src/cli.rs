//! CLI / headless mode for Open PDF Studio.
//!
//! When operation flags are present in argv, the app runs headless:
//! no Tauri runtime, no window — just Python engine over JSON-RPC,
//! results on stdout, exit code on completion.

use clap::{Args, Parser, Subcommand};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// ── CLI argument definitions ────────────────────────────────────────────────

#[derive(Parser)]
#[command(
    name = "openpdfstudio",
    version = env!("CARGO_PKG_VERSION"),
    about = "Open PDF Studio — modern PDF manipulation studio",
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
    /// Split a PDF into parts by page ranges
    Split(SplitArgs),
    /// Merge multiple PDFs into one
    Merge(MergeArgs),
    /// Encrypt a PDF with AES-256
    Encrypt(EncryptArgs),
    /// Decrypt a password-protected PDF
    Decrypt(DecryptArgs),
    /// Convert a PDF to PDF/A archival format
    Pdfa(PdfaArgs),
    /// Extract text from a PDF
    ExtractText(ExtractTextArgs),
    /// Delete pages from a PDF
    Delete(DeleteArgs),
    /// Redact (true content removal, not just a visual box) a rectangular region on a page
    Redact(RedactArgs),
    /// Stamp a translucent text watermark across pages
    Watermark(WatermarkArgs),
    /// Add headers, footers, page numbers, and Bates numbering
    HeaderFooter(HeaderFooterArgs),
    /// Crop pages / edit the crop/bleed/trim/art boxes (per-edge insets)
    PageBox(PageBoxArgs),
    /// Set page-number labels (/PageLabels) — front matter as i/ii/iii, etc.
    PageLabels(PageLabelsArgs),
    /// List embedded file attachments (JSON)
    AttachList(AttachListArgs),
    /// Embed a file as an attachment
    AttachAdd(AttachAddArgs),
    /// Extract an embedded attachment to disk
    AttachExtract(AttachExtractArgs),
    /// Remove an embedded attachment
    AttachRemove(AttachRemoveArgs),
    /// List optional-content layers (JSON)
    LayerList(LayerListArgs),
    /// Show or hide a layer by index
    LayerSet(LayerSetArgs),
    /// Run the accessibility checker (JSON report)
    Accessibility(AccessibilityArgs),
    /// List every markup comment in the document (JSON)
    CommentsList(AccessibilityArgs),
    /// Delete all markup comments (keeps links and form fields)
    CommentsDeleteAll(CommentsDeleteArgs),
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
    /// Rebuild a PDF (Tier 2: Ghostscript round-trip — re-render every page)
    Rebuild(RebuildArgs),
    /// Convert a PostScript/EPS file to PDF (the Distiller job, via Ghostscript)
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
    Printers,
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
    /// Number of copies (1-99)
    #[arg(long, default_value_t = 1)]
    pub copies: u32,
    /// Scale mode: "fit" (scale to paper) or "actual" (100%)
    #[arg(long, default_value = "fit")]
    pub fit: String,
}

#[derive(Args)]
pub struct CompressArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Compression quality: screen, ebook, printer, prepress
    #[arg(short, long, default_value = "ebook")]
    pub quality: String,
    /// Custom DPI (72-600). Overrides quality preset when set.
    #[arg(long)]
    pub dpi: Option<u32>,
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
    /// Page ranges, e.g. "1-3,5-7"
    #[arg(short, long)]
    pub ranges: String,
}

#[derive(Args)]
pub struct MergeArgs {
    /// Input PDF files (two or more)
    pub inputs: Vec<PathBuf>,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
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
}

#[derive(Args)]
pub struct WatermarkArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
    /// Watermark text (Latin-1 best-effort — non-Latin glyphs render as '?')
    #[arg(short, long)]
    pub text: String,
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
pub struct CommentsDeleteArgs {
    /// Input PDF file
    pub input: PathBuf,
    /// Output PDF file
    #[arg(short, long)]
    pub output: PathBuf,
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
}

#[derive(Args)]
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
    /// Target PDF version (1.4, 1.5, 1.6, 1.7, 2.0)
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

/// The vendored fallback-fonts DIRECTORY (mirrors `engine::get_edit_font_path`
/// for the GUI). FC1: passed to `fill_form_fields` so the CLI can render form
/// values outside WinAnsi with an embedded Unicode font. Missing (e.g. a dev
/// build without provisioned resources) is handled engine-side — the value is
/// then refused, never crashed.
fn resolve_fonts() -> PathBuf {
    exe_dir().join("fonts")
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
fn abs(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap().join(p)
    }
}

/// Parse comma-separated page numbers into a JSON value.
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
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", dir.display()));
    }
    let mut pdfs: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("Cannot read directory: {}", e))?
        .filter_map(|entry| entry.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .map(|ext| ext.eq_ignore_ascii_case("pdf"))
                .unwrap_or(false)
        })
        .collect();
    pdfs.sort();
    Ok(pdfs)
}

// ── Main CLI entry point ────────────────────────────────────────────────────

/// Run the CLI. Returns the exit code.
pub fn run(command: CliCommand) -> i32 {
    // Printer enumeration is pure winspool — no Python engine to spawn.
    if matches!(command, CliCommand::Printers) {
        return match crate::printers::enumerate() {
            Ok(list) => {
                println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                    "printers": list.printers,
                    "default": list.default,
                })).unwrap());
                0
            }
            Err(msg) => {
                eprintln!("error: {}", msg);
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
            });
            if let Some(dpi) = args.dpi {
                params["dpi"] = json!(dpi);
            }
            engine.call("compress", params)
        }

        CliCommand::Print(args) => {
            let gs = resolve_gs();
            engine.call(
                "print",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "printer": args.printer,
                    "pages": args.pages,
                    "copies": args.copies,
                    "fit": args.fit,
                    "gs_path": gs.to_string_lossy(),
                }),
            )
        }

        // Handled in run() before the engine spawns.
        CliCommand::Printers => unreachable!("printers is dispatched before engine start"),

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
            engine.call(
                "split",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "ranges": args.ranges,
                    "output_dir": out_dir.to_string_lossy(),
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
            engine.call(
                "merge",
                json!({
                    "files": files,
                    "output": abs(&args.output).to_string_lossy(),
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

        CliCommand::ExtractText(args) => {
            engine.call(
                "extract_text",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "pages": parse_pages(&args.pages),
                }),
            )
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
            engine.call(
                "redact",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "regions": [{"page": args.page, "rect": rect}],
                }),
            )
        }

        CliCommand::Watermark(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "text": args.text,
                "opacity": args.opacity,
                "angle": args.angle,
                "color": args.color,
                "font_size": args.font_size,
                "layer": args.layer,
                // S4: the vendored fonts dir lets the engine embed a Unicode
                // font for non-Latin-1 stamps (else refused, never "?"-mapped).
                "font_dir": resolve_fonts().to_string_lossy().to_string(),
            });
            if let Some(pages) = &args.pages {
                // Strict parse (like --rect): silently dropping bad tokens
                // would send an empty list — and an empty page selection must
                // never widen to "all pages", nor should a typo quietly
                // shrink the selection. Review-caught.
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
                // Embed a Unicode font for non-Latin-1 text (S4), as watermark does.
                "font_dir": resolve_fonts().to_string_lossy().to_string(),
            });
            if let Some(last) = args.last_page {
                params["last_page"] = json!(last);
            }
            engine.call("add_header_footer", params)
        }

        CliCommand::PageBox(args) => {
            let mut params = json!({
                "file": abs(&args.input).to_string_lossy(),
                "output": abs(&args.output).to_string_lossy(),
                "box": args.box_,
                "top": args.top,
                "bottom": args.bottom,
                "left": args.left,
                "right": args.right,
            });
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
            engine.call("set_page_boxes", params)
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

        CliCommand::LayerList(args) => engine.call(
            "list_layers",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::Accessibility(args) => engine.call(
            "check_accessibility",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

        CliCommand::CommentsList(args) => engine.call(
            "list_annotations",
            json!({ "file": abs(&args.input).to_string_lossy() }),
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

        CliCommand::VerifySignatures(args) => engine.call(
            "verify_signatures",
            json!({ "file": abs(&args.input).to_string_lossy() }),
        ),

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
                "password": password,
            });
            // Signer source: --pfx, or --key + --cert (clap enforces the
            // pairing/conflicts; the engine re-validates).
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
            // Fill an existing empty signature field (2n.4d) — clap already
            // forbids combining this with the visible-stamp flags.
            if let Some(field) = &args.existing_field {
                params["existing_field"] = json!(field);
            }
            engine.call("sign_pdf", params)
        }

        CliCommand::Forms(args) => {
            let input = abs(&args.input).to_string_lossy().to_string();
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
                    let raw = if source == "-" {
                        use std::io::Read;
                        let mut s = String::new();
                        std::io::stdin()
                            .read_to_string(&mut s)
                            .map_err(|e| format!("failed to read JSON from stdin: {}", e))?;
                        s
                    } else {
                        std::fs::read_to_string(source)
                            .map_err(|e| format!("failed to read {}: {}", source, e))?
                    };
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

    let pdfs = collect_pdfs(&input_dir)?;
    if pdfs.is_empty() {
        return Err(format!("No PDF files found in {}", input_dir.display()));
    }

    let gs = resolve_gs();
    let total = pdfs.len();
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut results: Vec<Value> = Vec::new();

    for (i, pdf) in pdfs.iter().enumerate() {
        let filename = pdf.file_name().unwrap().to_string_lossy().to_string();
        let out_path = output_dir.join(&filename);

        eprintln!("[{}/{}] {}", i + 1, total, filename);

        let result = match &args.operation {
            BatchOperation::Compress { quality } => engine.call(
                "compress",
                json!({
                    "file": pdf.to_string_lossy(),
                    "output": out_path.to_string_lossy(),
                    "quality": quality,
                    "gs_path": gs.to_string_lossy(),
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
