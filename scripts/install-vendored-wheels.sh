#!/bin/sh
# Installs the Linux wheels named in scripts/vendored-wheels.tsv into the given
# interpreter, from vendor/wheels/ with --no-index, after the same manifest
# gate and SHA-256 check as install-vendored-wheels.ps1.
#
#   sh scripts/install-vendored-wheels.sh <python>

. "$(dirname "$0")/posix-common.sh"
github_token_unexport

PY="${1:?usage: install-vendored-wheels.sh <python>}"
MANIFEST="$REPO_ROOT/scripts/vendored-wheels.tsv"
VENDOR="$REPO_ROOT/vendor/wheels"

wheels="$("$PY" - "$MANIFEST" "$VENDOR" <<'EOF'
import hashlib, pathlib, re, sys
manifest, vendor = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
rows, seen = [], False
for line in manifest.read_text(encoding="utf-8").splitlines():
    if not seen:
        seen = line.startswith("package\t")
        continue
    if not line.strip():
        continue
    c = [x.strip() for x in line.split("\t")]
    if len(c) < 7:
        sys.exit(f"malformed manifest row: {line}")
    rows.append(dict(zip(("package", "version", "role", "file", "sha256", "spdx", "upstream"), c)))
if not seen:
    sys.exit(f"manifest {manifest} has no header row")
bad = []
for r in rows:
    if r["role"] not in ("wheel", "sdist"):
        bad.append(f"{r['file']}: unknown role '{r['role']}'")
    for key in ("sha256", "spdx", "upstream"):
        if not r[key]:
            bad.append(f"{r['file']}: no {key}")
for w in (r for r in rows if r["role"] == "wheel"):
    if not any(s["role"] == "sdist" and s["package"] == w["package"] and s["version"] == w["version"] for s in rows):
        bad.append(f"{w['package']} {w['version']}: a wheel row with no sdist row")
if bad:
    sys.exit("vendored-wheel gate refused:\n  " + "\n  ".join(bad))
for r in rows:
    path = vendor / r["file"]
    if not path.is_file():
        sys.exit(f"{r['file']}: not present in {vendor}")
    got = hashlib.sha256(path.read_bytes()).hexdigest()
    if got != r["sha256"]:
        sys.exit(f"{r['file']}: sha256 {got} does not match the pinned {r['sha256']}")
linux = [str(vendor / r["file"]) for r in rows
         if r["role"] == "wheel" and re.search(r"(manylinux[^-]*_x86_64|-none-any)\.whl$", r["file"])]
print("\n".join(linux))
EOF
)"

[ -n "$wheels" ] || { echo "No Linux vendored wheels to install."; exit 0; }
echo "Installing vendored wheel(s) into $PY..."
# shellcheck disable=SC2086
"$PY" -m pip install --no-index --no-deps --force-reinstall --no-warn-script-location $wheels
echo "Done. Vendored wheels installed."
