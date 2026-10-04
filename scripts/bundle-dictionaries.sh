#!/bin/sh
# Vendors the Hunspell spelling dictionaries into
# resources/linux-x86_64/dictionaries/. POSIX counterpart of
# bundle-dictionaries.ps1: the same pinned upstream commit, the same manifest
# (scripts/dictionaries.tsv) and the same notice gate. Every file is fetched
# once into the download cache and verified by SHA-256 before it is written. A
# tree that already carries every row at its pin is left as is.
#
#   sh scripts/bundle-dictionaries.sh
#
# The Linux bundle maps this tree, not resources/dictionaries/: the Windows
# script writes the Finnish analyser's DLLs into the shared tree, and a Linux
# package built from a shared checkout would ship them. The Finnish analyser
# (dictionaries/fi/ here) is written by bundle-voikko.sh and is kept.

. "$(dirname "$0")/posix-common.sh"
require_tool curl python3

COMMIT="f2ff99058268502bdcf4cad25c1ca2935ad8aa7d"
BASE="https://raw.githubusercontent.com/LibreOffice/dictionaries/$COMMIT"
MANIFEST="$REPO_ROOT/scripts/dictionaries.tsv"
DEST="$LINUX_RESOURCES/dictionaries"

python3 - "$MANIFEST" "$DEST" "$FETCH_CACHE/dictionaries-$COMMIT" "$BASE" "$REPO_ROOT/scripts" <<'EOF'
import hashlib, os, pathlib, shutil, sys, time

manifest, dest, cache, base = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[4]
sys.path.insert(0, sys.argv[5])
import github_auth
rows, seen = [], False
for line in open(manifest, encoding="utf-8").read().splitlines():
    if not seen:
        seen = line.startswith("tag\t")
        continue
    if not line.strip():
        continue
    c = line.split("\t")
    if len(c) < 6:
        sys.exit(f"malformed manifest row: {line}")
    rows.append(dict(zip(("tag", "role", "upstream", "sha256", "spdx", "source"), (x.strip() for x in c[:6]))))
if not seen:
    sys.exit(f"manifest {manifest} has no header row")

bad = []
tags = {}
for r in rows:
    tags.setdefault(r["tag"], set()).add(r["role"])
for tag, roles in sorted(tags.items()):
    if ("aff" in roles) != ("dic" in roles):
        bad.append(f"{tag}: an aff row and a dic row must come together")
    if "aff" in roles and "notice" not in roles:
        bad.append(f"{tag}: ships a dictionary with no notice row")
for r in rows:
    if not r["spdx"]:
        bad.append(f"{r['tag']}/{r['upstream']}: no SPDX expression")
    if not r["source"]:
        bad.append(f"{r['tag']}/{r['upstream']}: no source URL")
    if r["role"] not in ("aff", "dic", "notice"):
        bad.append(f"{r['tag']}/{r['upstream']}: unknown role '{r['role']}'")
    if not r["sha256"]:
        bad.append(f"{r['tag']}/{r['upstream']}: no sha256 in the manifest")
if bad:
    sys.exit("dictionary notice gate refused:\n  " + "\n  ".join(bad))

def target(root, r):
    tag_dir = root / r["tag"]
    if r["role"] == "notice":
        return tag_dir / "notices" / r["upstream"].rsplit("/", 1)[-1]
    return tag_dir / f"{r['tag']}.{r['role']}"

sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
if all(target(dest, r).is_file() and sha(target(dest, r)) == r["sha256"] for r in rows):
    print(f"All {sum(r['role'] == 'aff' for r in rows)} dictionaries present and verified in {dest}")
    sys.exit(0)

cache.mkdir(parents=True, exist_ok=True)
def fetch(r):
    local = cache / r["upstream"].replace("/", "_")
    if local.is_file() and sha(local) == r["sha256"]:
        return local
    for attempt in range(1, 5):
        try:
            with github_auth.urlopen(f"{base}/{r['upstream']}", timeout=300) as resp:
                local.write_bytes(resp.read())
            break
        except OSError:
            if attempt == 4:
                raise
            time.sleep(attempt * 3)
    got = sha(local)
    if got != r["sha256"]:
        local.unlink()
        sys.exit(f"{r['upstream']}: sha256 {got} does not match the pinned {r['sha256']}")
    return local

staging = dest.with_name(dest.name + ".staging")
shutil.rmtree(staging, ignore_errors=True)
for r in rows:
    out = target(staging, r)
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(fetch(r), out)
voikko = dest / "fi"
if voikko.is_dir():
    shutil.copytree(voikko, staging / "fi", dirs_exist_ok=True)
shutil.rmtree(dest, ignore_errors=True)
os.replace(staging, dest)
print(f"Done. {sum(r['role'] == 'aff' for r in rows)} dictionaries in {dest}")
EOF
