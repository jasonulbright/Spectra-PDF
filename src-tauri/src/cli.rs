//! CLI / headless mode for Spectra PDF.
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
    /// Recover pages from a damaged PDF (Tier 3: per-page salvage extraction)
    Recover(RecoverArgs),
    /// Validate PDF structure without modifying (JSON report)
    Check(CheckArgs),
    /// Process all PDFs in a directory (batch mode)
    Batch(BatchArgs),
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
            engine.call(
                "encrypt",
                json!({
                    "file": abs(&args.input).to_string_lossy(),
                    "output": abs(&args.output).to_string_lossy(),
                    "user_password": args.password,
                    "owner_password": owner,
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
