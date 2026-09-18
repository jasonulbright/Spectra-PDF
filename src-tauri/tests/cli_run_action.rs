//! `run-action` asks for Ghostscript only when a step of the action needs it.
//!
//! Each run launches the real binary beside its provisioned `python/` and
//! `engine/`, the layout `cli_bytecode.rs` launches. An unprovisioned checkout
//! skips; with `SPECTRAPDF_REQUIRE_LIVE_CLI=1` the absence is a failure.
//!
//! "No Ghostscript" is an explicit `--gs-path` that names nothing: an explicit
//! path is the whole answer, so an install elsewhere on the machine cannot
//! stand in for it.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const EXE: &str = env!("CARGO_BIN_EXE_spectrapdf");
const REQUIRE_LIVE: &str = "SPECTRAPDF_REQUIRE_LIVE_CLI";

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

/// A source folder holding one copy of the sample document, a destination
/// that does not exist yet, and the action file.
struct Run {
    scratch: tempfile::TempDir,
}

impl Run {
    fn new() -> Self {
        let scratch = tempfile::tempdir().expect("scratch dir");
        let source = scratch.path().join("in");
        fs::create_dir_all(&source).expect("create source");
        let sample = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("sample.pdf");
        fs::copy(&sample, source.join("sample.pdf")).expect("copy the sample");
        Run { scratch }
    }

    fn dest(&self) -> PathBuf {
        self.scratch.path().join("out")
    }

    fn missing_gs(&self) -> String {
        let path = self.scratch.path().join("no-gs").join("gswin64c.exe");
        path.to_string_lossy().into_owned()
    }

    fn run(&self, steps: Value, gs_path: &str) -> Output {
        let action = self.scratch.path().join("action.json");
        let body = json!({ "name": "gs demand", "steps": steps });
        fs::write(&action, serde_json::to_vec(&body).expect("action json")).expect("write action");
        Command::new(EXE)
            .arg("--gs-path")
            .arg(gs_path)
            .arg("run-action")
            .arg(self.scratch.path().join("in"))
            .arg("--dest")
            .arg(self.dest())
            .arg("--action")
            .arg(&action)
            .output()
            .expect("spawn spectrapdf run-action")
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The run's report, after asserting that the run succeeded and processed the
/// one document with every step applied.
fn processed(output: &Output, steps: u64) -> Value {
    let stdout = text(&output.stdout);
    assert!(
        output.status.success(),
        "run-action failed ({:?}): {stdout}\n{}",
        output.status.code(),
        text(&output.stderr)
    );
    let start = stdout.find('{').unwrap_or_else(|| panic!("no report on stdout: {stdout}"));
    let report: Value = serde_json::from_str(&stdout[start..]).expect("the report parses");
    assert_eq!(report["ok"], 1, "{report}");
    assert_eq!(report["failed"], 0, "{report}");
    assert_eq!(report["results"][0]["steps_applied"], steps, "{report}");
    report
}

#[test]
fn an_action_without_a_ghostscript_step_runs_with_none_configured() {
    if !provisioned() {
        return;
    }
    let run = Run::new();
    let output = run.run(json!([{ "op": "optimize", "params": {} }]), &run.missing_gs());
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
        &missing,
    );
    let stderr = text(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains(spectrapdf_lib::gs::CLI_REQUIRED), "{stderr}");
    assert!(stderr.contains(&missing), "{stderr}");
    assert!(!run.dest().exists(), "a step ran before the refusal");
}

#[test]
fn an_optional_step_runs_without_ghostscript() {
    if !provisioned() {
        return;
    }
    let run = Run::new();
    let steps = json!([{ "op": "search_redact", "params": { "query": "Spectra" } }]);
    processed(&run.run(steps, &run.missing_gs()), 1);
    assert!(run.dest().join("sample.pdf").is_file());
}

#[test]
fn an_optional_step_runs_with_ghostscript() {
    if !provisioned() {
        return;
    }
    let found = spectrapdf_lib::gs::resolve(None, None);
    if !found.available {
        eprintln!("skipped: no Ghostscript resolves on this machine ({})", found.reason);
        return;
    }
    let run = Run::new();
    let steps = json!([{ "op": "search_redact", "params": { "query": "Spectra" } }]);
    processed(&run.run(steps, &found.path), 1);
    assert!(run.dest().join("sample.pdf").is_file());
}
