#!/bin/sh
# Provisions the Linux x86-64 engine runtime: a relocatable CPython from
# python-build-standalone, the hash-locked manylinux dependency tree, and the
# vendored wheels. POSIX counterpart of setup-python-embed.ps1.
#
#   sh scripts/setup-python-embed.sh
#
# Output: resources/linux-x86_64/python/ (bin/python3, lib/python3.X/...).

. "$(dirname "$0")/posix-common.sh"
require_tool curl sha256sum tar

PYTHON_VERSION="$(head -n1 "$REPO_ROOT/.python-version" | tr -d '[:space:]')"
case "$PYTHON_VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die ".python-version must hold one exact version, not '$PYTHON_VERSION'" ;;
esac

# The release tag and SHA-256 are one pair with the version pin: a pin changed
# without both refuses at the download. python-build-standalone publishes a
# CPython patch after python.org does, so the Linux runtime may trail
# .python-version by patch releases of the SAME minor. The `python-linux` arm
# of scripts/check-toolchains.py fails once a newer build of that minor exists.
PBS_RELEASE="20260924"
PBS_PINNED_VERSION="3.14.7"
PBS_SHA256="bd0d0568ccded07bbf1c87727230dc5dd0187e706a87da23c4de78388a229b78"
pin_minor="${PBS_PINNED_VERSION%.*}"
pin_patch="${PBS_PINNED_VERSION##*.}"
[ "${PYTHON_VERSION%.*}" = "$pin_minor" ] && [ "$pin_patch" -le "${PYTHON_VERSION##*.}" ] ||
  die "setup-python-embed.sh pins $PBS_PINNED_VERSION; .python-version is $PYTHON_VERSION. The Linux runtime must be the same minor at the same or a lower patch."
PBS_NAME="cpython-$PBS_PINNED_VERSION+$PBS_RELEASE-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/$(printf %s "$PBS_NAME" | sed 's/+/%2B/')"

PIP_VERSION="26.2.1"
PIP_WHEEL="pip-$PIP_VERSION-py3-none-any.whl"
PIP_SHA256="71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e"
PIP_URL="https://files.pythonhosted.org/packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/$PIP_WHEEL"

DEST="$LINUX_RESOURCES/python"
PY="$DEST/bin/python3"
LOCK="$REPO_ROOT/scripts/python-requirements-linux.txt"

installed_version() {
  [ -x "$PY" ] || return 0
  "$PY" -B -S -c "import sys; print('%d.%d.%d' % sys.version_info[:3])" 2>/dev/null || true
}

echo "Setting up Python $PBS_PINNED_VERSION (python-build-standalone $PBS_RELEASE; .python-version is $PYTHON_VERSION)..."
if [ "$(installed_version)" != "$PBS_PINNED_VERSION" ]; then
  archive="$(fetch_verified "$PBS_URL" "$PBS_SHA256" "$PBS_NAME")"
  rm -rf "$DEST" "$DEST.tmp"
  mkdir -p "$DEST.tmp"
  tar -xzf "$archive" -C "$DEST.tmp"
  # The archive's single top-level directory is `python/`.
  mv "$DEST.tmp/python" "$DEST"
  rmdir "$DEST.tmp"
else
  echo "Python already present at $DEST"
fi

"$PY" -c 'import sys; assert sys.version_info[:2] >= (3, 14)' || die "$PY does not run"

# The install-only archive carries no notices for the libraries the build
# links (OpenSSL, SQLite, libffi, Tcl/Tk, ...). The full archive of the same
# build does: its licenses/ directory and PYTHON.json (which names each
# linked library and its licence) ship in the runtime as licenses/.
PBS_FULL_NAME="cpython-$PBS_PINNED_VERSION+$PBS_RELEASE-x86_64-unknown-linux-gnu-pgo+lto-full.tar.zst"
PBS_FULL_SHA256="4a4d145c228b59c4e5e615177ea25f07b5c8d08c152f8251e7236f5d15bb6636"
PBS_FULL_URL="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/$(printf %s "$PBS_FULL_NAME" | sed 's/+/%2B/g')"
if [ ! -f "$DEST/licenses/PYTHON.json" ]; then
  full="$(fetch_verified "$PBS_FULL_URL" "$PBS_FULL_SHA256" "$PBS_FULL_NAME")"
  "$PY" - "$full" "$DEST/licenses" <<'EOF'
import compression.zstd, pathlib, shutil, sys, tarfile
archive, dest = sys.argv[1], pathlib.Path(sys.argv[2])
staging = dest.with_name(dest.name + ".staging")
shutil.rmtree(staging, ignore_errors=True)
staging.mkdir(parents=True)
with compression.zstd.open(archive, "rb") as raw, tarfile.open(fileobj=raw, mode="r|") as tar:
    for member in tar:
        name = member.name
        if not member.isfile():
            continue
        if name == "python/PYTHON.json":
            target = staging / "PYTHON.json"
        elif name.startswith("python/licenses/"):
            target = staging / name[len("python/licenses/"):]
        else:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(tar.extractfile(member).read())
if not (staging / "PYTHON.json").is_file() or len(list(staging.iterdir())) < 2:
    sys.exit("the full archive carried no licenses/ directory or PYTHON.json")
shutil.rmtree(dest, ignore_errors=True)
staging.rename(dest)
EOF
fi

echo "Installing pinned pip..."
pip_wheel="$(fetch_verified "$PIP_URL" "$PIP_SHA256" "$PIP_WHEEL")"
"$PY" "$pip_wheel/pip" install --no-index --force-reinstall --no-warn-script-location "$pip_wheel" >/dev/null

[ -f "$LOCK" ] || die "$LOCK is missing; run scripts/lock-python-deps.sh"
echo "Installing hash-pinned dependencies from $(basename "$LOCK")..."
# The wheels are cached beside the other downloads; a run whose cache already
# holds every locked wheel never contacts the index. --require-hashes applies
# to the cached files as well.
WHEEL_CACHE="$FETCH_CACHE/wheels"
mkdir -p "$WHEEL_CACHE"
if ! "$PY" -m pip install --require-hashes --only-binary :all: --no-index \
    --find-links "$WHEEL_CACHE" --no-warn-script-location -r "$LOCK" >/dev/null 2>&1; then
  "$PY" -m pip download --require-hashes --only-binary :all: -d "$WHEEL_CACHE" -r "$LOCK"
  "$PY" -m pip install --require-hashes --only-binary :all: --no-index \
    --find-links "$WHEEL_CACHE" --no-warn-script-location -r "$LOCK"
fi

sh "$REPO_ROOT/scripts/install-vendored-wheels.sh" "$PY"

# The shipped set is exactly the two manifests; anything else installed in the
# tree (a package dropped from them, a leftover from an earlier provision) is
# uninstalled and proven gone.
SITE="$("$PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
"$PY" - "$LOCK" "$REPO_ROOT/scripts/vendored-wheels.tsv" "$SITE" <<'EOF'
import pathlib, re, subprocess, sys
lock, vendored, site = map(pathlib.Path, sys.argv[1:4])
norm = lambda s: re.sub(r"[-_.]+", "-", s).lower()
shipped = {"pip", "setuptools", "wheel"}
for line in lock.read_text(encoding="utf-8").splitlines():
    m = re.match(r"^([A-Za-z0-9._-]+)\s*==", line)
    if m:
        shipped.add(norm(m.group(1)))
seen_header = False
for line in vendored.read_text(encoding="utf-8").splitlines():
    if line.startswith("package\t"):
        seen_header = True
        continue
    if seen_header and line.strip():
        shipped.add(norm(line.split("\t")[0]))
def stale():
    return sorted(d.name[: -len(".dist-info")].rsplit("-", 1)[0]
                  for d in site.glob("*.dist-info")
                  if norm(d.name[: -len(".dist-info")].rsplit("-", 1)[0]) not in shipped)
found = stale()
for dist in found:
    subprocess.run([sys.executable, "-m", "pip", "uninstall", "-y", dist], check=True)
left = stale()
if left:
    sys.exit(f"stale packages survived the uninstall: {', '.join(left)}")
if found:
    print(f"Removed {len(found)} package(s) no longer in the shipped set: {', '.join(found)}")
EOF

echo "Cleaning up..."
"$PY" -m pip uninstall -y pip >/dev/null
# dist-info directories keep METADATA, RECORD and every licence text: the
# notices of permissively licensed wheels must accompany redistributed copies.
"$PY" - "$DEST" <<'EOF'
import pathlib, re, shutil, sys
root = pathlib.Path(sys.argv[1])
keep = re.compile(r"^(METADATA|RECORD|DELVEWHEEL|LICEN[CS]E.*|COPYING.*|COPYRIGHT.*|NOTICE.*|AUTHORS.*|LEGAL.*)$")
for d in list(root.rglob("*.dist-info")):
    for f in d.iterdir():
        if f.is_dir():
            if f.name != "licenses":
                shutil.rmtree(f)
        elif not keep.match(f.name):
            f.unlink()
for d in sorted(root.rglob("__pycache__"), key=lambda p: len(p.parts), reverse=True):
    shutil.rmtree(d, ignore_errors=True)
for d in sorted(root.rglob("tests"), key=lambda p: len(p.parts), reverse=True):
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)
EOF
rm -f "$DEST"/bin/pip "$DEST"/bin/pip3 "$DEST"/bin/pip3.*
# _dbm statically links Berkeley DB, whose licence obliges source for every
# program that uses it. Nothing in the engine opens a dbm database, so the
# extension does not ship; `dbm` falls back to its SQLite backend.
rm -f "$DEST"/lib/python3.*/lib-dynload/_dbm.*
# The archive's terminfo database carries symlinks whose targets it does not
# include; the bundler refuses a resource tree with a dangling link.
dangling="$(find "$DEST" -type l ! -exec test -e {} \; -print)"
if [ -n "$dangling" ]; then
  printf '%s\n' "$dangling" | while IFS= read -r link; do rm -f "$link"; done
  echo "Removed $(printf '%s\n' "$dangling" | wc -l | tr -d ' ') dangling symlink(s)"
fi
left="$(find "$DEST" -type l ! -exec test -e {} \; -print)"
[ -z "$left" ] || die "dangling symlinks remain under $DEST:
$left"

echo "Done. Linux Python runtime: $(tree_size "$DEST") at $DEST"
