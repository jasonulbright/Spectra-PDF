#!/usr/bin/env python3
"""Refuses a bundle whose engine payload is not exactly the manifested tree.

The bundler copies a `resources` directory entry whole -- no negation, no
exclusion -- so pointing it at `src/engine` ships whatever `__pycache__` or
untracked scratch a checkout has accumulated. `src-tauri/build.rs` stages the
rows of `src/engine/PAYLOAD-MANIFEST.tsv` and nothing else; this gate asserts
the declaration still points at that staging, that every engine tree a build
has produced matches the manifest by path AND SHA-256 (extras, missing files
and hash drift all fail), and that no tree carries cached bytecode.
"""

import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
STAGING = "engine-payload"
MANIFEST = ROOT / "src/engine/PAYLOAD-MANIFEST.tsv"
MANIFEST_HEADER = "path\tsize\tsha256"

# Engine trees a build or a bundle step writes. Absent ones are skipped: this
# gate runs on a clean checkout as well as after a release build.
BUILD_OUTPUTS = [
    "src-tauri/engine-payload",
    "src-tauri/target/debug/engine",
    "src-tauri/target/release/engine",
    "src-tauri/target/release/bundle/portable/tree.staging/engine",
]


def read_manifest() -> dict[str, tuple[int, str]]:
    text = MANIFEST.read_text(encoding="utf-8")
    lines = text.split("\n")
    if not lines or lines[0] != MANIFEST_HEADER:
        raise SystemExit(f"{MANIFEST} header is not {MANIFEST_HEADER!r}")
    rows: dict[str, tuple[int, str]] = {}
    for line in lines[1:]:
        if not line:
            continue
        fields = line.split("\t")
        if len(fields) != 3:
            raise SystemExit(f"{MANIFEST} malformed row: {line!r}")
        path, size, digest = fields
        if path in rows:
            raise SystemExit(f"{MANIFEST} duplicate path: {path}")
        rows[path] = (int(size), digest.lower())
    if not rows:
        raise SystemExit(f"{MANIFEST} lists no files")
    return rows


def offenders(tree: pathlib.Path) -> list[str]:
    hits = []
    for path in tree.rglob("*"):
        if path.name == "__pycache__" or path.suffix in (".pyc", ".pyo"):
            hits.append(str(path.relative_to(ROOT)))
    return hits


def compare(tree: pathlib.Path, rows: dict[str, tuple[int, str]], rel: str) -> list[str]:
    bad = []
    present = {
        p.relative_to(tree).as_posix() for p in tree.rglob("*") if p.is_file()
    }
    for extra in sorted(present - set(rows)):
        bad.append(f"{rel}: file not in the payload manifest: {extra}")
    for missing in sorted(set(rows) - present):
        bad.append(f"{rel}: manifest row missing from the built tree: {missing}")
    for name in sorted(present & set(rows)):
        size, digest = rows[name]
        data = (tree / name).read_bytes()
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            bad.append(f"{rel}: payload bytes differ from the manifest: {name}")
    return bad


def main() -> int:
    bad = []
    rows = read_manifest()

    conf = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    resources = conf["bundle"]["resources"]
    sources = [src for src, dest in resources.items() if dest == "engine"]
    if sources != [STAGING]:
        bad.append(
            f"bundle.resources maps 'engine' from {sources!r}; expected ['{STAGING}'] "
            "-- a source outside the staging is unfiltered and ships __pycache__"
        )

    checked = 0
    for rel in BUILD_OUTPUTS:
        tree = ROOT / rel
        if not tree.is_dir():
            continue
        checked += 1
        for hit in offenders(tree):
            bad.append(f"cached bytecode in the engine payload: {hit}")
        bad.extend(compare(tree, rows, rel))

    if bad:
        print("engine payload gate refused:")
        for line in bad[:20]:
            print("  " + line)
        if len(bad) > 20:
            print(f"  ... and {len(bad) - 20} more")
        return 1

    print(
        f"engine payload OK: declaration points at {STAGING}, "
        f"{checked} built tree(s) match {len(rows)} manifest row(s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
