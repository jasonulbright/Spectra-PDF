#!/bin/sh
# Stages the bundled ICC colour profiles into resources/icc/. POSIX
# counterpart of bundle-icc.ps1: the same committed sources (vendor/icc/), the
# same manifest (scripts/icc-profiles.tsv) and the same notice gate, checked
# before anything is read. Nothing is fetched.
#
#   sh scripts/bundle-icc.sh [--manifest FILE] [--dest-dir DIR] [--notices FILE]

. "$(dirname "$0")/posix-common.sh"
require_tool python3

SOURCE_DIR="$REPO_ROOT/vendor/icc"
DEST="$RESOURCES_ROOT/icc"
MANIFEST="$REPO_ROOT/scripts/icc-profiles.tsv"
NOTICES="$REPO_ROOT/THIRD-PARTY-LICENSES.md"
while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; shift 2 ;;
    --dest-dir) DEST="$2"; shift 2 ;;
    --notices) NOTICES="$2"; shift 2 ;;
    --source-dir) SOURCE_DIR="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

python3 - "$SOURCE_DIR" "$DEST" "$MANIFEST" "$NOTICES" <<'EOF'
import hashlib, os, pathlib, shutil, sys

source, dest, manifest, notices = map(pathlib.Path, sys.argv[1:5])
license_text = source / "Adobe-Color-Profile-License.txt"
license_name = "Adobe-Color-Profile-License.txt"

rows, seen = [], False
for line in manifest.read_text(encoding="utf-8").splitlines():
    if not seen:
        seen = line.startswith("description\t")
        continue
    if not line.strip():
        continue
    c = line.split("\t")
    if len(c) < 6:
        sys.exit(f"malformed manifest row: {line}")
    rows.append(dict(zip(("description", "role", "member", "sha256", "condition", "copyright"),
                         (x.strip() for x in c[:6]))))
if not seen:
    sys.exit(f"manifest {manifest} has no header row")

bad = []
if not license_text.is_file():
    bad.append(f"the end-user licence text is missing: {license_text}")
elif not license_text.read_text(encoding="utf-8", errors="replace").strip():
    bad.append(f"the end-user licence text is empty: {license_text}")
if notices.is_file():
    body = notices.read_text(encoding="utf-8")
else:
    bad.append(f"the notice inventory is missing: {notices}")
    body = ""
for r in rows:
    if not r["description"]:
        bad.append(f"{r['member']}: no ICC description string")
    if not r["member"]:
        bad.append(f"{r['description']}: no upstream member")
    if not r["copyright"]:
        bad.append(f"{r['description']}: no copyright notice")
    if r["role"] not in ("cmyk", "rgb"):
        bad.append(f"{r['description']}: unknown role '{r['role']}'")
    if body and r["description"] not in body:
        bad.append(f"{r['description']}: ships with no row in THIRD-PARTY-LICENSES.md")
names = [r["description"] for r in rows]
for d in sorted({n for n in names if names.count(n) > 1}):
    bad.append(f"{d}: two rows claim one description string")
if not any(r["role"] == "cmyk" for r in rows):
    bad.append("no CMYK profile in the manifest: the destination-profile default has no source")
if bad:
    sys.exit("ICC notice gate refused:\n  " + "\n  ".join(bad))

def src(member):
    return source / member.replace("\\", "/").rsplit("/", 1)[-1]

missing = [f"{r['description']}: {src(r['member'])}" for r in rows if not src(r["member"]).is_file()]
if missing:
    sys.exit("committed profiles missing:\n  " + "\n  ".join(missing))
for r in rows:
    if not r["sha256"]:
        sys.exit(f"{r['description']}: no sha256 in the manifest -- run bundle-icc.ps1 -WriteManifest")

sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
staging = dest.with_name(dest.name + ".staging")
shutil.rmtree(staging, ignore_errors=True)
staging.mkdir(parents=True)
for r in rows:
    got = sha(src(r["member"]))
    if got != r["sha256"]:
        sys.exit(f"{r['member']}: sha256 {got} does not match the pinned {r['sha256']}")
    shutil.copyfile(src(r["member"]), staging / src(r["member"]).name)
shutil.copyfile(license_text, staging / license_name)

# The PDF/A sRGB profile: an ICC registry profile under the ICC's own terms,
# kept in a subdirectory the description-keyed listing never reads.
SRGB = {
    "description": "sRGB2014",
    "file": "sRGB2014.icc",
    "url": "https://registry.color.org/rgb-registry/profiles/sRGB2014.icc",
    "sha256": "384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a",
    "size": 3024,
    "terms": "ICC-Profile-Terms.txt",
}
srgb_source = source / SRGB["file"]
srgb_terms = source / SRGB["terms"]
if not srgb_terms.is_file():
    sys.exit(f"the ICC profile terms text is missing: {srgb_terms}")
if SRGB["description"] not in body:
    sys.exit(f"{SRGB['description']}: ships with no row in THIRD-PARTY-LICENSES.md")
if not srgb_source.is_file():
    sys.exit(f"committed profile missing: {srgb_source} (pinned from {SRGB['url']})")
srgb_dir = staging / "srgb"
srgb_dir.mkdir()
shutil.copyfile(srgb_source, srgb_dir / SRGB["file"])
for path in (srgb_source, srgb_dir / SRGB["file"]):
    data = path.read_bytes()
    got = hashlib.sha256(data).hexdigest()
    if got != SRGB["sha256"] or len(data) != SRGB["size"]:
        sys.exit(f"{path}: sha256 {got} / {len(data)} bytes does not match the pinned "
                 f"{SRGB['sha256']} / {SRGB['size']}")
shutil.copyfile(srgb_terms, srgb_dir / SRGB["terms"])
for r in rows:
    if sha(staging / src(r["member"]).name) != r["sha256"]:
        sys.exit(f"{src(r['member']).name}: written bytes do not match the pinned {r['sha256']}")
shutil.rmtree(dest, ignore_errors=True)
os.replace(staging, dest)
cmyk = sum(r["role"] == "cmyk" for r in rows)
print(f"Done. {cmyk} CMYK + {len(rows) - cmyk} RGB profiles in {dest}")
EOF
