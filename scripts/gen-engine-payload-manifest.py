#!/usr/bin/env python3
"""Generates and verifies `src/engine/PAYLOAD-MANIFEST.tsv`.

The manifest is the exact contract for the shipped engine payload: one row per
file, `path\tsize\tsha256`, paths relative to `src/engine` with forward
slashes, sorted by path. `src-tauri/build.rs` stages only these rows and
refuses any byte that does not match, so a source file added, removed, or
edited without regenerating the manifest fails `--check` rather than silently
changing what ships.

The row set is `git ls-files src/engine` minus `*.local.*` scratch files and
the manifest itself -- an untracked or ignored file under `src/engine` has no
row and therefore cannot enter the payload.
"""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import subprocess
import sys

MANIFEST_NAME = "PAYLOAD-MANIFEST.tsv"
HEADER = "path\tsize\tsha256"


def tracked_engine_files(root: pathlib.Path) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z", "--", "src/engine"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    rels = []
    for entry in out.split("\0"):
        if not entry:
            continue
        rel = entry[len("src/engine/"):]
        if ".local." in pathlib.PurePosixPath(rel).name:
            continue
        if rel == MANIFEST_NAME:
            continue
        rels.append(rel)
    return sorted(rels)


def render(root: pathlib.Path) -> str:
    lines = [HEADER]
    engine = root / "src/engine"
    for rel in tracked_engine_files(root):
        data = (engine / rel).read_bytes()
        lines.append(f"{rel}\t{len(data)}\t{hashlib.sha256(data).hexdigest()}")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="regenerate and diff; exit non-zero when the manifest is stale",
    )
    parser.add_argument(
        "--root",
        default=pathlib.Path(__file__).resolve().parent.parent,
        type=pathlib.Path,
        help="checkout whose src/engine is manifested (default: this repository)",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    manifest = root / "src/engine" / MANIFEST_NAME

    expected = render(root)
    if not args.check:
        manifest.write_text(expected, encoding="utf-8", newline="")
        rows = expected.count("\n") - 1
        print(f"wrote {manifest.relative_to(root).as_posix()}: {rows} row(s)")
        return 0

    actual = manifest.read_text(encoding="utf-8") if manifest.exists() else ""
    if actual == expected:
        rows = expected.count("\n") - 1
        print(f"engine payload manifest OK: {rows} row(s)")
        return 0

    def rows_of(text: str) -> dict[str, str]:
        table = {}
        for line in text.splitlines()[1:]:
            if line:
                table[line.split("\t", 1)[0]] = line
        return table

    have, want = rows_of(actual), rows_of(expected)
    bad = []
    if actual.splitlines()[:1] != [HEADER]:
        bad.append(f"header must be {HEADER!r}")
    for path in sorted(set(want) - set(have)):
        bad.append(f"missing row: {path}")
    for path in sorted(set(have) - set(want)):
        bad.append(f"stale row: {path}")
    for path in sorted(set(have) & set(want)):
        if have[path] != want[path]:
            bad.append(f"size/sha256 drift: {path}")
    if not bad:
        bad.append("byte-level difference (line endings or ordering)")

    print("engine payload manifest is stale -- run scripts/gen-engine-payload-manifest.py:")
    for line in bad[:20]:
        print("  " + line)
    if len(bad) > 20:
        print(f"  ... and {len(bad) - 20} more")
    return 1


if __name__ == "__main__":
    sys.exit(main())
