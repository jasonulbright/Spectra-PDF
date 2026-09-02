#!/bin/sh
# ci-parity-gates.sh — run LOCALLY before every push, so CI's gates fail on
# this machine (seconds) instead of on the runner (an hour, tokens, a red tag).
#
# WHY THIS EXISTS: an audit of 22 CI/Release failures (2026-08-25) found ~86%
# were catchable locally — the top buckets were the two dependency audits, the
# test-axis provisioning gate, and the tag/version-consistency check, none of
# which the old local battery ran. Six hours of runner time in two days went to
# failures a five-second local check would have caught.
#
# This is NOT the full battery (tsc/lint/vitest/pytest — run those too). This
# is the set of CI gates the battery historically OMITTED. Run BOTH.
#
# Exit non-zero on any gate failure. Each gate logs to its own *.local.log.
R="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$R/ci-parity.results.local.txt"
: > "$OUT"
fail=0

gate() {
  name="$1"; shift
  ( cd "$R" && "$@" ) > "$R/ci-parity.$name.local.log" 2>&1
  code=$?
  echo "$name EXIT=$code" >> "$OUT"
  [ "$code" -ne 0 ] && fail=1
  return 0
}

# --- CI job: Dependency Audit (the #1 self-inflicted CI failure bucket) ---
gate npm-audit npm audit --production --audit-level=high
gate cargo-audit sh -c 'cd src-tauri && cargo audit'

# --- Release job: version consistency (tag == package.json == tauri.conf == Cargo.toml) ---
# Not tag-aware here (no tag yet at push time); instead assert the four surfaces AGREE.
gate version-consistency "$R/.venv/Scripts/python.exe" - <<'PY'
import json, re, sys, pathlib
root = pathlib.Path(".")
pkg   = json.loads((root/"package.json").read_text())["version"]
conf  = json.loads((root/"src-tauri/tauri.conf.json").read_text())["version"]
cargo = re.search(r'^version\s*=\s*"([^"]+)"', (root/"src-tauri/Cargo.toml").read_text(), re.M).group(1)
lock  = json.loads((root/"package-lock.json").read_text())["version"]
vals = {"package.json": pkg, "tauri.conf.json": conf, "Cargo.toml": cargo, "package-lock.json": lock}
if len(set(vals.values())) != 1:
    print("VERSION SURFACES DISAGREE:", vals); sys.exit(1)
print("all four surfaces at", pkg)
PY

# --- Release check: changelog has an entry for the current version + headings intact ---
gate changelog "$R/.venv/Scripts/python.exe" - <<'PY'
import json, re, pathlib
root = pathlib.Path(".")
ver = json.loads((root/"package.json").read_text())["version"]
cl = (root/"CHANGELOG.md").read_text(encoding="utf-8")
if f"## {ver}" not in cl:
    print(f"CHANGELOG.md has no '## {ver}' section"); raise SystemExit(1)
heads = re.findall(r'^## ', cl, re.M)
print(f"changelog OK: '## {ver}' present, {len(heads)} version headings")
PY

# --- CI gate: portable payload notice map covers every declared resource ---
# (PowerShell-only; skip on non-Windows shells, run on Windows.)
if command -v powershell >/dev/null 2>&1; then
  gate portable-checkmap powershell -ExecutionPolicy Bypass -File scripts/build-portable-zip.ps1 -CheckMap
fi

# --- CI gate: the engine payload is exactly the manifested tree. A `resources`
#     directory entry is copied whole, so a checkout's ignored __pycache__ or
#     untracked scratch rides into the installer and the portable zip. The
#     manifest is the contract build.rs stages from; --check refuses a source
#     change that did not regenerate it. ---
gate engine-manifest "$R/.venv/Scripts/python.exe" scripts/gen-engine-payload-manifest.py --check
gate engine-payload "$R/.venv/Scripts/python.exe" scripts/check-engine-payload.py

# --- Corpus provisioning contract: a test axis with no CI provisioning is the
#     "added tests, forgot the workflow" failure class. This asserts the fetch
#     scripts still --check clean if the corpora are present (skips if absent). ---
for suite in fetch-ghent-suite fetch-processing-steps-suite fetch-pdfa-corpus; do
  if [ -f "$R/scripts/$suite.py" ]; then
    gate "$suite-check" "$R/.venv/Scripts/python.exe" "scripts/$suite.py" --check || true
  fi
done

# --- Workflow-contract tests: the only local reader of .github/workflows/*.
#     A workflow edit that breaks the contract otherwise surfaces on the runner
#     (CI #144: the Ghostscript step moved into a script and the contract test's
#     substring lookup raised). Cheap enough to run on every push. ---
gate workflow-contract "$R/.venv/Scripts/python.exe" -m pytest \
  tests/test_ci_capability_setup.py -q

# --- corpus-pin-vs-index: a tracked PDF added anywhere in the repo joins the
#     preflight corpus universe; committing one without regenerating the pin
#     fails only on the runner's full suite (~40 min). Recurred twice
#     (xfa fixtures, truncated.pdf). Sub-second locally. ---
gate corpus-pin "$R/.venv/Scripts/python.exe" -m pytest \
  "tests/test_preflight.py::TestCorpusGate::test_the_corpus_is_the_git_index_not_a_glob" -q

# --- CI job: Verify runs the Rust suite. Warm it is a few seconds, and the
#     Rust tests exercise process-, handle-, and window-level behaviour whose
#     failures are runner-timing sensitive — the class that only ever appeared
#     on CI. Cheap enough to belong here. ---
gate cargo-test sh -c 'cd src-tauri && cargo test'

echo "CI-PARITY DONE" >> "$OUT"
if [ "$fail" -ne 0 ]; then
  echo "CI-PARITY: FAILURES — read ci-parity.*.local.log before pushing." >> "$OUT"
  cat "$OUT"
  exit 1
fi
cat "$OUT"
