#!/bin/sh
# Vendors the platform-neutral half of the Finnish spelling engine into
# resources/dictionaries/fi/: the rows of scripts/voikko.tsv whose platform is
# `all` (the voikko-fi transducer, the libvoikko.py binding and the notices).
# POSIX counterpart of the data half of bundle-voikko.ps1, from the same pinned
# official packages. Files are rewritten only when missing or off their pin
# and are never pruned, so a checkout shared with a Windows host keeps its
# DLL rows.
#
# The `linux` rows (libvoikko.so.1 and the C++ runtime it loads) are a
# prebuilt artifact provisioned into resources/linux-x86_64/voikko/; this
# script does not build them.
#
#   sh scripts/bundle-voikko.sh

. "$(dirname "$0")/posix-common.sh"
require_tool curl sha256sum dpkg-deb
# The MSYS2 package is zstd-compressed; the Linux runtime (Python 3.14,
# scripts/setup-python-embed.sh) reads it without a zstd tool.
PY="$LINUX_RESOURCES/python/bin/python3"
[ -x "$PY" ] || die "run scripts/setup-python-embed.sh first; its Python reads the zstd package"

DICT_URL="https://deb.debian.org/debian/pool/main/v/voikko-fi/voikko-fi_2.5-2_amd64.deb"
DICT_SHA256="e85564a1be3bf8c45d6d63b0928699ef3283f5299be8ee2d6662e6a59e816bdd"
ENGINE_URL="https://repo.msys2.org/mingw/mingw64/mingw-w64-x86_64-libvoikko-4.3.3-3-any.pkg.tar.zst"
ENGINE_SHA256="46e048d8579271704969b0dfe688e9cd40e904adc0936addeee2c39f0a34e107"
MANIFEST="$REPO_ROOT/scripts/voikko.tsv"
DEST="$RESOURCES_ROOT/dictionaries/fi"

work="$LINUX_RESOURCES/.voikko-work"
rm -rf "$work"
mkdir -p "$work"
dict="$(fetch_verified "$DICT_URL" "$DICT_SHA256" "voikko-fi_2.5-2_amd64.deb")"
engine="$(fetch_verified "$ENGINE_URL" "$ENGINE_SHA256" "mingw-w64-x86_64-libvoikko-4.3.3-3-any.pkg.tar.zst")"
dpkg-deb -x "$dict" "$work/dict"

# The binding and libvoikko's notices come from the same package the Windows
# script reads; the pinned hashes in the manifest decide the bytes.
"$PY" - "$MANIFEST" "$DEST" "$work" "$engine" <<'EOF'
import hashlib, pathlib, shutil, sys, tarfile

manifest, dest, work, engine = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[4]
import compression.zstd as zstd
with zstd.open(engine, "rb") as raw, tarfile.open(fileobj=raw, mode="r|") as tar:
    for member in tar:
        name = member.name
        if member.isfile() and (name.endswith("/libvoikko.py") or "/licenses/" in name
                                or name.endswith("/LICENSE.CORE")):
            target = work / "engine" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tar.extractfile(member).read())

rows, seen = [], False
for line in open(manifest, encoding="utf-8").read().splitlines():
    if line.startswith("#") or not line.strip():
        continue
    if not seen:
        seen = line.startswith("file\t")
        continue
    c = line.split("\t")
    if (c[7].strip() if len(c) >= 8 and c[7].strip() else "all") == "all":
        rows.append((c[0].strip(), c[3].strip()))

def find(root, leaf, under=""):
    hits = sorted(p for p in root.rglob(leaf) if p.is_file() and under in str(p))
    if not hits:
        sys.exit(f"{leaf} not found in the extracted packages -- the upstream layout changed")
    return hits[0]

def source(file):
    if file == "libvoikko.py":
        return find(work / "engine", "libvoikko.py")
    if file == "notices/COPYING":
        return find(work / "engine", "COPYING", "licenses")
    if file == "notices/LICENSE.CORE":
        return find(work / "engine", "LICENSE.CORE")
    if file == "notices/copyright-voikko-fi":
        return find(work / "dict", "copyright", "voikko-fi")
    return find(work / "dict", pathlib.PurePosixPath(file).name, "voikko")

sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
written = 0
for file, pin in rows:
    target = dest / file
    if target.is_file() and (pin == "-" or sha(target) == pin):
        continue
    src = source(file)
    if pin != "-" and sha(src) != pin:
        sys.exit(f"{file}: sha256 {sha(src)} does not match the pinned {pin}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, target)
    written += 1
print(f"Done. Finnish dictionary data: {len(rows)} rows verified, {written} written in {dest}")
EOF
rm -rf "$work"
