//! The Ghostscript each CLI leg asks for, with the real binary.
//!
//! A command asks for Ghostscript only when the work for its input needs it:
//! always (`pdfa`), per input (`create-pdf` of a PostScript source, a batch
//! file), per the engine's plan (a `run-action`, a `create-pdf-folders` run),
//! or never (`rotate`). An optional leg (a `search_redact` step,
//! `search-redact`, `redact`) runs without one, and needs one only for a JBIG2
//! image under a partial mark. Every refusal, the resolver's before a run and
//! the engine's for one input, names the command line's fix, `--gs-path` and
//! `SPECTRAPDF_GS_PATH`.
//!
//! An explicit `--gs-path` is the whole answer: an optional leg that meets such
//! an image refuses by that path's name, and never decodes it with a
//! Ghostscript found elsewhere on the machine. Without `--gs-path`, every
//! command takes the answer of the CLI's one resolver, which also reads the
//! registry. Every child therefore sees `SPECTRAPDF_GS_PATH` naming a working
//! Ghostscript whenever this machine resolves one, so a leg that searched
//! would find it.
//!
//! Each run launches the real binary beside its provisioned `python/` and
//! `engine/`, the layout `cli_bytecode.rs` launches. An unprovisioned checkout
//! skips; with `SPECTRAPDF_REQUIRE_LIVE_CLI=1` the absence is a failure.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::OnceLock;

const EXE: &str = env!("CARGO_BIN_EXE_spectrapdf");
const REQUIRE_LIVE: &str = "SPECTRAPDF_REQUIRE_LIVE_CLI";
const SCAN: &str = "scan.pdf";

fn provisioned() -> bool {
    let exe = PathBuf::from(EXE);
    let exe_dir = exe.parent().expect("exe dir");
    let python = exe_dir.join("python").join("python.exe");
    let startup = exe_dir.join("engine").join("__startup__.py");
    if python.is_file() && startup.is_file() {
        return true;
    }
    assert!(
        std::env::var_os(REQUIRE_LIVE).map_or(true, |v| v != "1"),
        "{REQUIRE_LIVE}=1 but no provisioned python/engine beside {} (python: {}, engine: {})",
        exe.display(),
        python.is_file(),
        startup.is_file()
    );
    eprintln!("skipped: no provisioned python/engine beside {}", exe.display());
    false
}

/// A working Ghostscript this machine resolves without `--gs-path`.
fn discoverable() -> Option<String> {
    static FOUND: OnceLock<Option<String>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            let answer = spectrapdf_lib::gs::resolve(None, None);
            answer.available.then_some(answer.path)
        })
        .clone()
}

// ── A JBIG2 scan ─────────────────────────────────────────────────────────────

const PAGE_INFORMATION: u8 = 48;
const END_OF_PAGE: u8 = 49;

/// One JBIG2 segment: its number, its type, no referred-to segments, page 1,
/// and the length of its data.
fn segment(number: u32, kind: u8, data: &[u8]) -> Vec<u8> {
    let mut out = number.to_be_bytes().to_vec();
    out.extend_from_slice(&[kind, 0, 1]);
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(data);
    out
}

/// A 16 x 16 page with no region segments. It passes the structure check that
/// runs before any decoder, so a redaction reaches the Ghostscript decode.
fn jbig2_page() -> Vec<u8> {
    let mut info = Vec::new();
    for field in [16u32, 16, 0, 0] {
        info.extend_from_slice(&field.to_be_bytes());
    }
    info.push(0);
    info.extend_from_slice(&0u16.to_be_bytes());
    let mut data = segment(0, PAGE_INFORMATION, &info);
    data.extend(segment(1, END_OF_PAGE, &[]));
    data
}

fn stream(dictionary: &str, data: &[u8]) -> Vec<u8> {
    let mut out = format!("<< {dictionary} /Length {} >>\nstream\n", data.len()).into_bytes();
    out.extend_from_slice(data);
    out.extend_from_slice(b"\nendstream");
    out
}

/// One page whose word `SECRET` lies over part of a JBIG2 image that fills
/// the page: redacting the word marks the image in part.
fn jbig2_scan() -> Vec<u8> {
    let objects: [Vec<u8>; 6] = [
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] \
           /Resources << /Font << /F1 4 0 R >> /XObject << /Im0 5 0 R >> >> \
           /Contents 6 0 R >>"
            .to_vec(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_vec(),
        stream(
            "/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray \
             /BitsPerComponent 1 /Filter /JBIG2Decode",
            &jbig2_page(),
        ),
        stream(
            "",
            b"q 200 0 0 200 0 0 cm /Im0 Do Q BT /F1 24 Tf 20 20 Td (SECRET) Tj ET",
        ),
    ];
    let mut pdf = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        pdf.extend_from_slice(body);
        pdf.extend_from_slice(b"\nendobj\n");
    }
    let xref = pdf.len();
    let size = objects.len() + 1;
    pdf.extend_from_slice(format!("xref\n0 {size}\n0000000000 65535 f \n").as_bytes());
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    pdf
}

// ── Other inputs ─────────────────────────────────────────────────────────────

/// A 2 x 2 white 24-bit BMP: the file header, a BITMAPINFOHEADER, and rows
/// padded to four bytes. Create PDF wraps an image without Ghostscript.
fn white_bmp() -> Vec<u8> {
    let (width, height) = (2u32, 2u32);
    let pixels = (width * 3).div_ceil(4) * 4 * height;
    let mut out = b"BM".to_vec();
    for field in [54 + pixels, 0, 54, 40, width, height] {
        out.extend_from_slice(&field.to_le_bytes());
    }
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(&[0; 24]);
    out.resize(out.len() + pixels as usize, 0xFF);
    out
}

/// One page of PostScript. Create PDF distills it through Ghostscript.
const POSTSCRIPT_PAGE: &str =
    "%!PS-Adobe-3.0\n/Helvetica findfont 24 scalefont setfont\n72 720 moveto (page) show\nshowpage\n";

// ── A run ────────────────────────────────────────────────────────────────────

/// A source folder holding one document, a destination that does not exist
/// yet, and room for the action file and single-file outputs.
struct Run {
    scratch: tempfile::TempDir,
}

impl Run {
    fn empty() -> Self {
        let scratch = tempfile::tempdir().expect("scratch dir");
        fs::create_dir_all(scratch.path().join("in")).expect("create source");
        Run { scratch }
    }

    /// The sample document, which has no image a redaction could mark.
    fn new() -> Self {
        let run = Run::empty();
        let sample = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("sample.pdf");
        fs::copy(&sample, run.source().join("sample.pdf")).expect("copy the sample");
        run
    }

    fn scan() -> Self {
        let run = Run::empty();
        fs::write(run.source().join(SCAN), jbig2_scan()).expect("write the scan");
        run
    }

    fn source(&self) -> PathBuf {
        self.scratch.path().join("in")
    }

    fn dest(&self) -> PathBuf {
        self.scratch.path().join("out")
    }

    fn output(&self) -> PathBuf {
        self.scratch.path().join("redacted.pdf")
    }

    fn sample(&self) -> PathBuf {
        self.source().join("sample.pdf")
    }

    /// A path in the scratch folder, outside the source folder.
    fn named(&self, name: &str) -> PathBuf {
        self.scratch.path().join(name)
    }

    /// The images and PostScript a Create PDF run can take, in their own folder.
    fn sources(&self) -> (PathBuf, PathBuf) {
        let folder = self.named("sources");
        fs::create_dir_all(&folder).expect("create the sources folder");
        let image = folder.join("white.bmp");
        let postscript = folder.join("page.ps");
        fs::write(&image, white_bmp()).expect("write the image");
        fs::write(&postscript, POSTSCRIPT_PAGE).expect("write the PostScript");
        (image, postscript)
    }

    /// Writes `bytes` at `rel` under the source folder.
    fn put(&self, rel: &str, bytes: impl AsRef<[u8]>) {
        let path = self.source().join(rel);
        fs::create_dir_all(path.parent().expect("a parent")).expect("create the folder");
        fs::write(&path, bytes).expect("write a source");
    }

    fn missing_gs(&self) -> String {
        let path = self.scratch.path().join("no-gs").join("gswin64c.exe");
        path.to_string_lossy().into_owned()
    }

    /// The binary, with `--gs-path` only when `gs_path` names one.
    fn cli(&self, gs_path: Option<&str>) -> Command {
        let mut command = Command::new(EXE);
        if let Some(found) = discoverable() {
            command.env(spectrapdf_lib::gs::PATH_ENV_VAR, found);
        }
        if let Some(path) = gs_path {
            command.arg("--gs-path").arg(path);
        }
        command
    }

    /// The binary with no `--gs-path`, no `SPECTRAPDF_GS_PATH` and no
    /// Ghostscript on PATH: the engine's own search finds nothing, and the
    /// CLI's resolver still reads the registry.
    fn cli_off_the_engine_search(&self) -> Command {
        let mut command = Command::new(EXE);
        command.env_remove(spectrapdf_lib::gs::PATH_ENV_VAR);
        let path = std::env::var_os("PATH").unwrap_or_default();
        let kept: Vec<PathBuf> = std::env::split_paths(&path)
            .filter(|dir| {
                !["gswin64c.exe", "gswin32c.exe", "gs.exe"]
                    .iter()
                    .any(|exe| dir.join(exe).is_file())
            })
            .collect();
        command.env("PATH", std::env::join_paths(kept).expect("a PATH"));
        command
    }

    fn run(&self, steps: Value, gs_path: Option<&str>) -> Output {
        let action = self.scratch.path().join("action.json");
        let body = json!({ "name": "gs demand", "steps": steps });
        fs::write(&action, serde_json::to_vec(&body).expect("action json")).expect("write action");
        self.cli(gs_path)
            .arg("run-action")
            .arg(self.source())
            .arg("--dest")
            .arg(self.dest())
            .arg("--action")
            .arg(&action)
            .output()
            .expect("spawn spectrapdf run-action")
    }

    /// One PDF per folder of the source tree, taking every accepted file.
    fn create_pdf_folders(&self, gs_path: Option<&str>) -> Output {
        self.cli(gs_path)
            .arg("create-pdf-folders")
            .arg(self.source())
            .arg("-d")
            .arg(self.dest())
            .arg("--sources")
            .arg("all")
            .output()
            .expect("spawn spectrapdf create-pdf-folders")
    }

    fn search_redact(&self, gs_path: Option<&str>) -> Output {
        self.search_redact_by(self.cli(gs_path))
    }

    fn search_redact_by(&self, mut command: Command) -> Output {
        command
            .arg("search-redact")
            .arg(self.source().join(SCAN))
            .arg("-o")
            .arg(self.output())
            .arg("-q")
            .arg("SECRET")
            .output()
            .expect("spawn spectrapdf search-redact")
    }

    fn redact(&self, gs_path: Option<&str>) -> Output {
        self.redact_by(self.cli(gs_path))
    }

    fn redact_by(&self, mut command: Command) -> Output {
        command
            .arg("redact")
            .arg(self.source().join(SCAN))
            .arg("-o")
            .arg(self.output())
            .arg("-p")
            .arg("1")
            .arg("--rect")
            .arg("10,10,50,50")
            .output()
            .expect("spawn spectrapdf redact")
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The JSON result on stdout of a command that succeeded.
fn succeeded(output: &Output) -> Value {
    let stdout = text(&output.stdout);
    assert!(
        output.status.success(),
        "the command failed ({:?}): {stdout}\n{}",
        output.status.code(),
        text(&output.stderr)
    );
    let start = stdout.find('{').unwrap_or_else(|| panic!("no result on stdout: {stdout}"));
    serde_json::from_str(&stdout[start..]).expect("the result parses")
}

/// The run's report, after asserting that the run processed the one document
/// with every step applied.
fn processed(output: &Output, steps: u64) -> Value {
    let report = succeeded(output);
    assert_eq!(report["ok"], 1, "{report}");
    assert_eq!(report["failed"], 0, "{report}");
    assert_eq!(report["results"][0]["steps_applied"], steps, "{report}");
    report
}

/// The stderr of a command that refused with exit code 1 and wrote nothing.
fn refused(output: &Output, written: &Path) -> String {
    let stderr = text(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{}\n{stderr}", text(&output.stdout));
    assert!(!written.exists(), "the refused command wrote {}", written.display());
    stderr
}

fn redact_the_word() -> Value {
    json!([{ "op": "search_redact", "params": { "query": "SECRET" } }])
}

/// A refusal the command line shows: it names the flag and the variable that
/// fix it, and not the window's Preferences.
fn names_the_command_lines_fix(text: &str) {
    assert!(
        text.contains("--gs-path") && text.contains(spectrapdf_lib::gs::PATH_ENV_VAR),
        "{text}"
    );
    assert!(!text.contains("Preferences"), "{text}");
}

/// The `error` of the report row for `rel`.
fn row_error(report: &Value, rel: &str) -> String {
    report["results"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["rel"] == rel))
        .map(|row| row["error"].as_str().unwrap_or_default().to_string())
        .unwrap_or_else(|| panic!("no row for {rel}: {report}"))
}

// ── Required and optional steps ──────────────────────────────────────────────

#[test]
fn an_action_without_a_ghostscript_step_runs_with_none_configured() {
    if !provisioned() {
        return;
    }
    let run = Run::new();
    let output = run.run(json!([{ "op": "optimize", "params": {} }]), Some(&run.missing_gs()));
    processed(&output, 1);
    assert!(run.dest().join("sample.pdf").is_file());
}

#[test]
fn a_required_step_refuses_before_any_step_runs() {
    if !provisioned() {
        return;
    }
    let run = Run::new();
    let missing = run.missing_gs();
    let output = run.run(
        json!([
            { "op": "optimize", "params": {} },
            { "op": "grayscale", "params": {} }
        ]),
        Some(&missing),
    );
    let stderr = text(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains(spectrapdf_lib::gs::CLI_REQUIRED), "{stderr}");
    assert!(stderr.contains(&missing), "{stderr}");
    names_the_command_lines_fix(&stderr);
    assert!(!run.dest().exists(), "a step ran before the refusal");
}

#[test]
fn an_optional_step_runs_without_ghostscript() {
    if !provisioned() {
        return;
    }
    let run = Run::new();
    let steps = json!([{ "op": "search_redact", "params": { "query": "Spectra" } }]);
    processed(&run.run(steps, Some(&run.missing_gs())), 1);
    assert!(run.dest().join("sample.pdf").is_file());
}

#[test]
fn an_optional_step_runs_with_ghostscript() {
    if !provisioned() {
        return;
    }
    let Some(found) = discoverable() else {
        eprintln!("skipped: no Ghostscript resolves on this machine");
        return;
    };
    let run = Run::new();
    let steps = json!([{ "op": "search_redact", "params": { "query": "Spectra" } }]);
    processed(&run.run(steps, Some(&found)), 1);
    assert!(run.dest().join("sample.pdf").is_file());
}

// ── A configured path is the whole answer ────────────────────────────────────

#[test]
fn an_optional_step_refuses_a_jbig2_input_by_the_configured_path() {
    if !provisioned() {
        return;
    }
    let run = Run::scan();
    let missing = run.missing_gs();
    let report = succeeded(&run.run(redact_the_word(), Some(&missing)));
    assert_eq!(report["failed"], 1, "{report}");
    let error = report["results"][0]["error"].as_str().unwrap_or_default();
    assert!(error.contains("Ghostscript") && error.contains(&missing), "{report}");
    names_the_command_lines_fix(error);
    assert!(!run.dest().join(SCAN).exists(), "the refused input left an output");
}

#[test]
fn search_redact_refuses_a_jbig2_input_by_the_configured_path() {
    if !provisioned() {
        return;
    }
    let run = Run::scan();
    let missing = run.missing_gs();
    let stderr = refused(&run.search_redact(Some(&missing)), &run.output());
    assert!(stderr.contains("Ghostscript") && stderr.contains(&missing), "{stderr}");
    names_the_command_lines_fix(&stderr);
}

#[test]
fn redact_refuses_a_jbig2_input_by_the_configured_path() {
    if !provisioned() {
        return;
    }
    let run = Run::scan();
    let missing = run.missing_gs();
    let stderr = refused(&run.redact(Some(&missing)), &run.output());
    assert!(stderr.contains("Ghostscript") && stderr.contains(&missing), "{stderr}");
    names_the_command_lines_fix(&stderr);
}

#[test]
fn without_a_configured_path_an_optional_leg_decodes_with_what_it_finds() {
    if !provisioned() {
        return;
    }
    if discoverable().is_none() {
        eprintln!("skipped: no Ghostscript resolves on this machine");
        return;
    }
    let run = Run::scan();
    processed(&run.run(redact_the_word(), None), 1);
    assert!(run.dest().join(SCAN).is_file());

    let searched = succeeded(&run.search_redact(None));
    assert_eq!(searched["images_modified"], 1, "{searched}");
    fs::remove_file(run.output()).expect("clear the output");

    let redacted = succeeded(&run.redact(None));
    assert_eq!(redacted["images_modified"], 1, "{redacted}");
}

// ── What each command asks for, with Ghostscript unresolvable ────────────────

/// The stderr of a command the CLI's resolver refused by the configured path.
fn refused_by_the_resolver(output: &Output, written: &Path, missing: &str) {
    let stderr = refused(output, written);
    assert!(
        stderr.contains(spectrapdf_lib::gs::CLI_REQUIRED) && stderr.contains(missing),
        "{stderr}"
    );
    names_the_command_lines_fix(&stderr);
}

#[test]
fn a_command_that_always_needs_ghostscript_refuses_before_it_runs() {
    if !provisioned() {
        return;
    }
    let run = Run::new();
    let missing = run.missing_gs();
    let out = run.named("pdfa.pdf");
    let output = run
        .cli(Some(&missing))
        .arg("pdfa")
        .arg(run.sample())
        .arg("-o")
        .arg(&out)
        .output()
        .expect("spawn spectrapdf pdfa");
    refused_by_the_resolver(&output, &out, &missing);
}

#[test]
fn create_pdf_asks_only_for_a_postscript_source() {
    if !provisioned() {
        return;
    }
    let run = Run::empty();
    let missing = run.missing_gs();
    let (image, postscript) = run.sources();

    let from_image = run.named("image.pdf");
    let made = succeeded(
        &run.cli(Some(&missing))
            .arg("create-pdf")
            .arg(&image)
            .arg("-o")
            .arg(&from_image)
            .output()
            .expect("spawn spectrapdf create-pdf"),
    );
    assert_eq!(made["pages"], 1, "{made}");
    assert!(from_image.is_file());

    let from_postscript = run.named("postscript.pdf");
    let output = run
        .cli(Some(&missing))
        .arg("create-pdf")
        .arg(&image)
        .arg(&postscript)
        .arg("-o")
        .arg(&from_postscript)
        .output()
        .expect("spawn spectrapdf create-pdf");
    refused_by_the_resolver(&output, &from_postscript, &missing);
}

#[test]
fn a_batch_asks_only_for_the_operations_and_files_that_need_it() {
    if !provisioned() {
        return;
    }
    let run = Run::new();
    let missing = run.missing_gs();
    let batch = |source: &Path, dest: &Path, operation: &[&str]| {
        run.cli(Some(&missing))
            .arg("batch")
            .arg(source)
            .arg("-o")
            .arg(dest)
            .args(operation)
            .output()
            .expect("spawn spectrapdf batch")
    };

    let rotated = run.named("rotated");
    let report = succeeded(&batch(&run.source(), &rotated, &["rotate", "--angle", "90"]));
    assert_eq!((report["succeeded"].clone(), report["failed"].clone()), (json!(1), json!(0)));
    assert!(rotated.join("sample.pdf").is_file());

    let compressed = run.named("compressed");
    let output = batch(&run.source(), &compressed, &["compress"]);
    refused_by_the_resolver(&output, &compressed.join("sample.pdf"), &missing);

    let (image, _postscript) = run.sources();
    let created = run.named("created");
    let report = succeeded(&batch(image.parent().expect("the sources folder"), &created, &["create-pdf"]));
    assert_eq!((report["succeeded"].clone(), report["failed"].clone()), (json!(1), json!(1)));
    assert!(created.join("white.bmp.pdf").is_file());
    assert!(!created.join("page.ps.pdf").exists());
    let refusal = report["results"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["file"] == "page.ps"))
        .map(|row| row["error"].as_str().unwrap_or_default().to_string())
        .unwrap_or_default();
    assert!(
        refusal.contains(spectrapdf_lib::gs::CLI_REQUIRED) && refusal.contains(&missing),
        "{report}"
    );
    names_the_command_lines_fix(&refusal);
}

#[test]
fn a_command_whose_content_decides_runs_without_ghostscript() {
    if !provisioned() {
        return;
    }
    let run = Run::new();
    let missing = run.missing_gs();
    let report = succeeded(
        &run.cli(Some(&missing))
            .arg("preflight")
            .arg(run.sample())
            .output()
            .expect("spawn spectrapdf preflight"),
    );
    assert!(report["checks"].as_array().is_some_and(|checks| !checks.is_empty()), "{report}");
}

#[test]
fn export_asks_only_for_the_slide_format() {
    if !provisioned() {
        return;
    }
    let run = Run::scan();
    let missing = run.missing_gs();
    let export = |format: &str, out: &Path| {
        run.cli(Some(&missing))
            .arg("export")
            .arg(run.source().join(SCAN))
            .arg("-o")
            .arg(out)
            .arg("--format")
            .arg(format)
            .output()
            .expect("spawn spectrapdf export")
    };
    let text = run.named("scan.txt");
    succeeded(&export("txt", &text));
    assert!(fs::read_to_string(&text).expect("the text").contains("SECRET"));
    let slides = run.named("scan.pptx");
    refused_by_the_resolver(&export("pptx", &slides), &slides, &missing);
}

#[test]
fn a_command_that_never_needs_ghostscript_never_asks() {
    if !provisioned() {
        return;
    }
    let run = Run::new();
    let rotated = run.named("rotated.pdf");
    succeeded(
        &run.cli(Some(&run.missing_gs()))
            .arg("rotate")
            .arg(run.sample())
            .arg("-o")
            .arg(&rotated)
            .arg("--angle")
            .arg("90")
            .output()
            .expect("spawn spectrapdf rotate"),
    );
    assert!(rotated.is_file());
}

#[test]
fn without_a_configured_path_every_command_takes_the_resolvers_answer() {
    if !provisioned() {
        return;
    }
    let registered = spectrapdf_lib::gs::registry_candidates()
        .into_iter()
        .any(|(path, _, _)| spectrapdf_lib::gs::probe(&path).available);
    if !registered {
        eprintln!("skipped: no working Ghostscript is registered on this machine");
        return;
    }
    let run = Run::scan();
    let redacted = succeeded(&run.redact_by(run.cli_off_the_engine_search()));
    assert_eq!(redacted["images_modified"], 1, "{redacted}");
    fs::remove_file(run.output()).expect("clear the output");
    let searched = succeeded(&run.search_redact_by(run.cli_off_the_engine_search()));
    assert_eq!(searched["images_modified"], 1, "{searched}");
}

// ── What the engine's plan decides ───────────────────────────────────────────

#[test]
fn a_step_whose_parameter_needs_ghostscript_refuses_before_the_run_starts() {
    if !provisioned() {
        return;
    }
    let run = Run::scan();
    let missing = run.missing_gs();
    let export = |fmt: &str| json!([{ "op": "export_document", "params": { "fmt": fmt } }]);
    refused_by_the_resolver(&run.run(export("pptx"), Some(&missing)), &run.dest(), &missing);
    processed(&run.run(export("txt"), Some(&missing)), 1);
    assert!(run.dest().join("scan.txt").is_file());
}

#[test]
fn a_folder_whose_every_file_needs_ghostscript_refuses_before_the_run_starts() {
    if !provisioned() {
        return;
    }
    let run = Run::empty();
    let missing = run.missing_gs();
    run.put("page.ps", POSTSCRIPT_PAGE);
    let create = json!([{ "op": "create_pdf", "params": {} }]);
    refused_by_the_resolver(&run.run(create.clone(), Some(&missing)), &run.dest(), &missing);

    run.put("white.bmp", white_bmp());
    let report = succeeded(&run.run(create, Some(&missing)));
    assert_eq!((report["ok"].clone(), report["failed"].clone()), (json!(1), json!(1)), "{report}");
    assert!(run.dest().join("white.bmp.pdf").is_file());
    assert!(!run.dest().join("page.ps.pdf").exists());
    let refusal = row_error(&report, "page.ps");
    assert!(refusal.contains("Ghostscript") && refusal.contains(&missing), "{report}");
    names_the_command_lines_fix(&refusal);
}

#[test]
fn a_folder_of_folders_is_decided_per_folder() {
    if !provisioned() {
        return;
    }
    let run = Run::empty();
    let missing = run.missing_gs();
    run.put("postscript/page.ps", POSTSCRIPT_PAGE);
    refused_by_the_resolver(&run.create_pdf_folders(Some(&missing)), &run.dest(), &missing);

    run.put("images/white.bmp", white_bmp());
    let report = succeeded(&run.create_pdf_folders(Some(&missing)));
    assert_eq!((report["ok"].clone(), report["failed"].clone()), (json!(1), json!(1)), "{report}");
    assert!(run.dest().join("images.pdf").is_file());
    assert!(!run.dest().join("postscript.pdf").exists());
    let refusal = row_error(&report, "postscript");
    assert!(refusal.contains("Ghostscript") && refusal.contains(&missing), "{report}");
    names_the_command_lines_fix(&refusal);
}
