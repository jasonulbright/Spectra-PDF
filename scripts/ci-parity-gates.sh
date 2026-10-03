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

# --- Release job (Linux): runs when .github/release-platforms.txt lists linux,
#     the same switch the release workflows read from the tag's tree. The
#     Linux Python runtime may trail .python-version by patches of the same
#     minor until python-build-standalone publishes the matching patch.
#     scripts/ci-parity-linux.sh mirrors the Linux build job's compile, notice
#     gates and glibc floor. A Linux host runs it directly. Any other host runs
#     the untracked hook scripts/ci-parity-linux-host.local.sh, which must run
#     the mirror in a Linux environment and exit with its status. A host with
#     neither fails the gate. ---
LINUX_RELEASE="$(cd "$R" && "$R/.venv/Scripts/python.exe" scripts/release_platforms.py)"
LINUX_HOOK="scripts/ci-parity-linux-host.local.sh"
case "$LINUX_RELEASE" in
  linux=true)
    gate python-linux-toolchain "$R/.venv/Scripts/python.exe" scripts/check-toolchains.py python-linux
    if [ "$(uname -s)" = "Linux" ]; then
      gate linux sh scripts/ci-parity-linux.sh
    elif [ -f "$R/$LINUX_HOOK" ]; then
      gate linux sh "$LINUX_HOOK"
    else
      gate linux sh -c 'echo "the Linux gates need a Linux environment; run scripts/ci-parity-linux.sh on a Linux host"; exit 1'
    fi
    ;;
  linux=false)
    echo "linux SKIPPED (.github/release-platforms.txt lists windows only)" >> "$OUT"
    ;;
  *)
    gate release-platforms "$R/.venv/Scripts/python.exe" scripts/release_platforms.py
    ;;
esac

# --- CI audit job: npm audit and cargo audit, same flags and directories.
#     cargo audit reads its ignore list from src-tauri/.cargo/audit.toml, so it
#     runs from src-tauri. ---
gate npm-audit npm audit --production --audit-level=high
gate cargo-audit sh -c 'cd src-tauri && cargo audit'

# --- Release job: version consistency (tag == package.json == tauri.conf == Cargo.toml) ---
# Not tag-aware here (no tag yet at push time); instead assert the four surfaces
# AGREE, and that the version is either already tagged (tree not bumped since
# that release) or the next YYYY.MDD.N release after the local tags -- the
# release run's verify job applies the same rule to the pushed tag.
gate version-consistency "$R/.venv/Scripts/python.exe" - <<'PY'
import json, re, subprocess, sys, pathlib
sys.path.insert(0, "scripts")
import release_version
root = pathlib.Path(".")
pkg   = json.loads((root/"package.json").read_text())["version"]
conf  = json.loads((root/"src-tauri/tauri.conf.json").read_text())["version"]
cargo = re.search(r'^version\s*=\s*"([^"]+)"', (root/"src-tauri/Cargo.toml").read_text(), re.M).group(1)
lock  = json.loads((root/"package-lock.json").read_text())["version"]
vals = {"package.json": pkg, "tauri.conf.json": conf, "Cargo.toml": cargo, "package-lock.json": lock}
if len(set(vals.values())) != 1:
    print("VERSION SURFACES DISAGREE:", vals); sys.exit(1)
tags = subprocess.run(["git", "tag", "--list", "v*"], capture_output=True, text=True, check=True).stdout.split()
try:
    print(release_version.check_surfaces(pkg, tags))
except ValueError as exc:
    print(f"VERSION: {exc}"); sys.exit(1)
print("all four surfaces at", pkg)
PY

# --- Release check: changelog has an entry for the current version + headings intact ---
gate changelog "$R/.venv/Scripts/python.exe" - <<'PY'
import json, pathlib, sys
sys.path.insert(0, "scripts")
import release_version
ver = json.loads(pathlib.Path("package.json").read_text())["version"]
try:
    count = release_version.check_changelog(pathlib.Path("CHANGELOG.md").read_text(encoding="utf-8"), ver)
except ValueError as exc:
    print(exc); sys.exit(1)
print(f"changelog OK: '## {ver}' present, {count} version headings")
PY

# --- CI gate: portable payload notice map covers every declared resource ---
# (PowerShell-only; skip on non-Windows shells, run on Windows.)
if command -v powershell >/dev/null 2>&1; then
  gate portable-checkmap powershell -ExecutionPolicy Bypass -File scripts/build-portable-zip.ps1 -CheckMap
fi

# --- Release job: the vendored Ghostscript tree ships only its two binaries
#     and its licence file, and THIRD-PARTY-LICENSES.md carries the pinned
#     version's Ghostscript section. The release job runs the same gate inside
#     scripts/bundle-ghostscript.ps1. (PowerShell-only.) ---
if command -v powershell >/dev/null 2>&1; then
  gate gs-notice powershell -ExecutionPolicy Bypass -File scripts/bundle-ghostscript.ps1 -GateOnly
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

# --- CI audit job: the wheels committed under vendor/wheels/ install from the
#     repository, so the lock audits above cannot see them. Same selection as
#     CI: rows after the header whose role is `wheel`, audited as name==version. ---
gate pip-audit-vendored "$AUDIT_PY" - <<'PY'
import pathlib, subprocess, sys
req, seen = [], False
for line in pathlib.Path("scripts/vendored-wheels.tsv").read_text(encoding="utf-8").splitlines():
    if not seen:
        seen = line.startswith("package\t")
        continue
    if not line.strip():
        continue
    c = line.split("\t")
    if c[2].strip() == "wheel":
        req.append(f"{c[0].strip()}=={c[1].strip()}")
if not seen:
    print("vendored-wheels.tsv has no header row"); sys.exit(1)
out = pathlib.Path("vendored-audit-requirements.local.txt")
out.write_text("\n".join(req) + "\n", encoding="utf-8")
print("auditing", req)
sys.exit(subprocess.run([sys.executable, "-m", "pip_audit", "-r", str(out), "--no-deps"]).returncode)
PY

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
