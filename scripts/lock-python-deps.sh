#!/bin/sh
# Regenerates scripts/python-requirements-linux.txt: the same top-level pins as
# the Windows lock (scripts/python-requirements.in), resolved against the
# Linux runtime so every hash is a manylinux or pure-Python wheel. POSIX
# counterpart of lock-python-deps.ps1.
#
#   sh scripts/setup-python-embed.sh   (once, for the interpreter)
#   sh scripts/lock-python-deps.sh
#
# Every package both locks name must carry the same version; this script
# refuses otherwise. A package only one platform needs (a platform marker,
# such as tzdata on Windows) may appear in one lock alone.

. "$(dirname "$0")/posix-common.sh"
github_token_unexport

PY="$LINUX_RESOURCES/python/bin/python3"
IN="$REPO_ROOT/scripts/python-requirements.in"
OUT="$REPO_ROOT/scripts/python-requirements-linux.txt"
WINDOWS_LOCK="$REPO_ROOT/scripts/python-requirements.txt"
PIP_VERSION="26.2.1"
PIP_WHEEL="pip-$PIP_VERSION-py3-none-any.whl"
PIP_SHA256="71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e"
PIP_URL="https://files.pythonhosted.org/packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/$PIP_WHEEL"

[ -x "$PY" ] || die "Linux runtime missing -- run scripts/setup-python-embed.sh first; it extracts the interpreter before it reads the lock"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pip_wheel="$(fetch_verified "$PIP_URL" "$PIP_SHA256" "$PIP_WHEEL")"

# The Windows lock's versions constrain the resolution, so the two platforms
# ship one dependency set; only platform-marker packages may differ.
sed -n 's/^\([A-Za-z0-9._-]*==[^ ]*\) .*/\1/p' "$WINDOWS_LOCK" > "$work/constraints.txt"
# pip runs from its own wheel, so the runtime is left as it was found.
PYTHONPATH="$pip_wheel" "$PY" -m pip install --dry-run --ignore-installed \
  --only-binary :all: --report "$work/report.json" -r "$IN" -c "$work/constraints.txt" --quiet
"$PY" "$REPO_ROOT/scripts/lockgen.py" "$work/report.json" "$OUT" \
  "Linux x86_64 (manylinux)" "scripts/lock-python-deps.sh" "setup-python-embed.sh"

"$PY" - "$WINDOWS_LOCK" "$OUT" <<'EOF'
import re, sys
def pins(path):
    out = {}
    for line in open(path, encoding="utf-8"):
        m = re.match(r"^([A-Za-z0-9._-]+)==(\S+)", line)
        if m:
            out[re.sub(r"[-_.]+", "-", m.group(1)).lower()] = m.group(2)
    return out
win, lin = pins(sys.argv[1]), pins(sys.argv[2])
diff = sorted(k for k in win.keys() & lin.keys() if win[k] != lin[k])
if diff:
    sys.exit("the Linux lock resolves differently from the Windows lock: " +
             ", ".join(f"{k} {win.get(k, '-')} vs {lin.get(k, '-')}" for k in diff))
EOF
echo "Done. Review the diff to scripts/python-requirements-linux.txt before committing."
