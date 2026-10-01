#!/bin/sh
# Supplemental release metadata checks. Run once with local candidate validation.
# Functional suites already run in that validation.
# Do not rerun this script at each commit, push, and tag boundary.
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

# The release runner follows the newest stable Rust, the Python pin, and the
# newest patch of the configured Node major. Prove the validated local tools
# match those moving inputs once before tagging.
gate rust-toolchain "$R/.venv/Scripts/python.exe" scripts/check-toolchains.py rust
gate python-toolchain "$R/.venv/Scripts/python.exe" scripts/check-toolchains.py python
gate node-toolchain "$R/.venv/Scripts/python.exe" scripts/check-toolchains.py node

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

# --- Release job: the File Explorer command handler builds, and both package
#     manifests render with the committed publisher and pass MakeAppx's schema
#     validation. The release job runs the same script (-CompileOnly before
#     the signing window, the full build inside `tauri build`). The ARM64
#     compile runs here only where that Rust target is installed; the log says
#     when it did not. (PowerShell-only.) ---
if command -v powershell >/dev/null 2>&1; then
  gate shell-menu powershell -ExecutionPolicy Bypass -File scripts/build-shell-menu.ps1 -Check
fi

# --- CI gate: the engine payload is exactly the manifested tree. A `resources`
#     directory entry is copied whole, so a checkout's ignored __pycache__ or
#     untracked scratch rides into the installer and the portable zip. The
#     manifest is the contract build.rs stages from; --check refuses a source
#     change that did not regenerate it. ---
gate engine-manifest "$R/.venv/Scripts/python.exe" scripts/gen-engine-payload-manifest.py --check
gate engine-payload "$R/.venv/Scripts/python.exe" scripts/check-engine-payload.py

# --- CI audit job: pip-audit over both engine locks, from the hash-pinned tool
#     lock. The tool venv is rebuilt whenever that lock changes. ---
AUDIT_VENV="$R/.pip-audit.local"
AUDIT_PY="$AUDIT_VENV/Scripts/python.exe"
AUDIT_LOCK_SHA="$(sha256sum "$R/scripts/pip-audit-requirements.txt" | cut -d' ' -f1)"
if [ ! -x "$AUDIT_PY" ] || [ "$(cat "$AUDIT_VENV/.lock-sha256" 2>/dev/null)" != "$AUDIT_LOCK_SHA" ]; then
  rm -rf "$AUDIT_VENV"
  gate pip-audit-install sh -c '"$1" -m venv "$2" && "$2/Scripts/python.exe" -m pip install --require-hashes --only-binary :all: -r scripts/pip-audit-requirements.txt && printf "%s\n" "$3" > "$2/.lock-sha256"' \
    sh "$R/.venv/Scripts/python.exe" "$AUDIT_VENV" "$AUDIT_LOCK_SHA"
fi
gate pip-audit-windows "$AUDIT_PY" -m pip_audit -r scripts/python-requirements.txt --no-deps
gate pip-audit-linux "$AUDIT_PY" -m pip_audit -r scripts/python-requirements-linux.txt --no-deps --disable-pip

# Inspect the production renderer already built by candidate validation.
gate release-bundle "$R/.venv/Scripts/python.exe" scripts/check-release-bundle.py

# --- Release job: the release body is the changelog section for the version
#     the four surfaces carry. A missing, empty, or banned-term section fails
#     the release run AFTER a full build; here it fails before any build. ---
gate release-notes "$R/.venv/Scripts/python.exe" - <<'PY'
import json, pathlib, subprocess, sys
version = json.loads(pathlib.Path("package.json").read_text())["version"]
run = subprocess.run(
    [sys.executable, "scripts/release-notes-from-changelog.py", version],
    capture_output=True,
)
sys.stderr.write(run.stderr.decode())
sys.stdout.write(run.stdout.decode())
sys.exit(run.returncode)
PY

echo "CI-PARITY DONE" >> "$OUT"
if [ "$fail" -ne 0 ]; then
  echo "CI-PARITY: FAILURES — read ci-parity.*.local.log before pushing." >> "$OUT"
  cat "$OUT"
  exit 1
fi
cat "$OUT"
