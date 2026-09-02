#!/usr/bin/env python3
"""Refuses a bundle whose engine payload is not exactly the expected tree.

The bundler copies a `resources` directory entry whole -- no negation, no
exclusion -- so pointing it at `src/engine` ships whatever `__pycache__` or
untracked scratch a checkout has accumulated. This gate asserts that every
engine tree a build has produced matches the expected row set by path AND
SHA-256 (extras, missing files and hash drift all fail), and that no tree
carries cached bytecode.

Two regimes decide where the expected rows come from:

* manifest (default): `src/engine/PAYLOAD-MANIFEST.tsv`, the contract
  `src-tauri/build.rs` stages from. The bundle declaration must map `engine`
  from that staging.
* legacy (`--legacy-rev REV`): a tag that predates the manifest bundled
  `src/engine` directly, so the expected rows are that revision's tracked
  `src/engine` blobs minus `*.local.*` scratch. The declaration must map
  `engine` from `../src/engine`. Nothing is invented for such a tag: it never
  carried a manifest and the verifier does not write one.

`--root` names the checkout whose build outputs are verified; the release-redo
publisher runs this file from the workflow's own revision against a checkout
of an older tag, so the two must not be assumed to coincide.
"""

import argparse
import hashlib
import json
import pathlib
import subprocess
import sys

STAGING = "engine-payload"
LEGACY_SOURCE = "../src/engine"
MANIFEST_REL = "src/engine/PAYLOAD-MANIFEST.tsv"
MANIFEST_NAME = "PAYLOAD-MANIFEST.tsv"
MANIFEST_HEADER = "path\tsize\tsha256"

# Engine trees a build or a bundle step writes. Absent ones are skipped: this
# gate runs on a clean checkout as well as after a release build.
BUILD_OUTPUTS = [
    "src-tauri/engine-payload",
    "src-tauri/target/debug/engine",
    "src-tauri/target/release/engine",
    "src-tauri/target/release/bundle/portable/tree.staging/engine",
]


def read_manifest(manifest: pathlib.Path) -> dict[str, tuple[int, str]]:
    text = manifest.read_text(encoding="utf-8")
    lines = text.split("\n")
    if not lines or lines[0] != MANIFEST_HEADER:
        raise SystemExit(f"{manifest} header is not {MANIFEST_HEADER!r}")
    rows: dict[str, tuple[int, str]] = {}
    for line in lines[1:]:
        if not line:
            continue
        fields = line.split("\t")
        if len(fields) != 3:
            raise SystemExit(f"{manifest} malformed row: {line!r}")
        path, size, digest = fields
        if path in rows:
            raise SystemExit(f"{manifest} duplicate path: {path}")
        rows[path] = (int(size), digest.lower())
    if not rows:
        raise SystemExit(f"{manifest} lists no files")
    return rows


def legacy_rows(root: pathlib.Path, rev: str) -> dict[str, tuple[int, str]]:
    """The files `rev` tracks under `src/engine`, minus scratch, as checked out.

    Names come from the revision; bytes come from the checkout, which is what
    a pre-manifest bundler copied. The checkout must be clean for `src/engine`
    or the bytes are not the revision's -- an unclean tree is refused rather
    than hashed. Working-tree bytes, not blob bytes, so a checkout that
    normalises line endings compares against what it actually shipped.
    """
    dirty = subprocess.run(
        ["git", "status", "--porcelain", "--", "src/engine"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    if dirty.strip():
        raise SystemExit(f"src/engine is not a clean checkout of {rev}:\n{dirty}")
    head = subprocess.run(
        ["git", "rev-parse", "--verify", f"{rev}^{{commit}}"],
        cwd=root, capture_output=True, text=True, check=True,
    ).stdout.strip()
    at = subprocess.run(
        ["git", "rev-parse", "--verify", "HEAD^{commit}"],
        cwd=root, capture_output=True, text=True, check=True,
    ).stdout.strip()
    if head != at:
        raise SystemExit(f"checkout is at {at}, not {rev} ({head})")
    listing = subprocess.run(
        ["git", "ls-tree", "-r", "-z", rev, "--", "src/engine"],
        cwd=root,
        capture_output=True,
        check=True,
    ).stdout
    rows: dict[str, tuple[int, str]] = {}
    for entry in listing.split(b"\0"):
        if not entry:
            continue
        meta, path = entry.decode("utf-8").split("\t", 1)
        _mode, kind, _blob = meta.split(" ")
        if kind != "blob":
            raise SystemExit(f"{rev}: {path} is a {kind}, not a file")
        rel = path[len("src/engine/"):]
        if ".local." in pathlib.PurePosixPath(rel).name or rel == MANIFEST_NAME:
            continue
        data = (root / "src/engine" / rel).read_bytes()
        rows[rel] = (len(data), hashlib.sha256(data).hexdigest())
    if not rows:
        raise SystemExit(f"{rev} tracks no files under src/engine")
    return rows


def offenders(tree: pathlib.Path, root: pathlib.Path) -> list[str]:
    hits = []
    for path in tree.rglob("*"):
        if path.name == "__pycache__" or path.suffix in (".pyc", ".pyo"):
            hits.append(path.relative_to(root).as_posix())
    return hits


def compare(tree: pathlib.Path, rows: dict[str, tuple[int, str]], rel: str) -> list[str]:
    bad = []
    present = {
        p.relative_to(tree).as_posix() for p in tree.rglob("*") if p.is_file()
    }
    for extra in sorted(present - set(rows)):
        bad.append(f"{rel}: file not in the expected payload: {extra}")
    for missing in sorted(set(rows) - present):
        bad.append(f"{rel}: expected payload row missing from the built tree: {missing}")
    for name in sorted(present & set(rows)):
        size, digest = rows[name]
        data = (tree / name).read_bytes()
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            bad.append(f"{rel}: payload bytes differ from the expected payload: {name}")
    return bad


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        default=pathlib.Path(__file__).resolve().parent.parent,
        type=pathlib.Path,
        help="checkout whose build outputs are verified (default: this repository)",
    )
    parser.add_argument(
        "--legacy-rev",
        metavar="REV",
        help="verify against REV's tracked src/engine instead of the manifest",
    )
    args = parser.parse_args()
    root = args.root.resolve()

    bad = []
    if args.legacy_rev:
        regime = f"legacy ({args.legacy_rev} src/engine)"
        rows = legacy_rows(root, args.legacy_rev)
        expected_source = LEGACY_SOURCE
    else:
        regime = "manifest"
        rows = read_manifest(root / MANIFEST_REL)
        expected_source = STAGING

    conf = json.loads((root / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    resources = conf["bundle"]["resources"]
    sources = [src for src, dest in resources.items() if dest == "engine"]
    if sources != [expected_source]:
        bad.append(
            f"bundle.resources maps 'engine' from {sources!r}; expected "
            f"['{expected_source}'] for the {regime} regime"
        )

    checked = 0
    for rel in BUILD_OUTPUTS:
        tree = root / rel
        if not tree.is_dir():
            continue
        checked += 1
        for hit in offenders(tree, root):
            bad.append(f"cached bytecode in the engine payload: {hit}")
        bad.extend(compare(tree, rows, rel))

    if bad:
        print(f"engine payload gate refused ({regime}):")
        for line in bad[:20]:
            print("  " + line)
        if len(bad) > 20:
            print(f"  ... and {len(bad) - 20} more")
        return 1

    print(
        f"engine payload OK ({regime}): declaration points at {expected_source}, "
        f"{checked} built tree(s) match {len(rows)} expected row(s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
