#!/usr/bin/env python3
"""Refuses a bundle whose engine payload carries cached bytecode.

The bundler copies a `resources` directory entry whole -- no negation, no
exclusion -- so pointing it at `src/engine` ships whatever `__pycache__`
a checkout has accumulated. `src-tauri/build.rs` stages a clean tree and the
bundle declaration names that staging; this gate asserts both halves: the
declaration still points at the staging, and every engine tree a build has
produced is free of `.pyc`/`.pyo`/`__pycache__`.
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
STAGING = "engine-payload"

# Engine trees a build or a bundle step writes. Absent ones are skipped: this
# gate runs on a clean checkout as well as after a release build.
BUILD_OUTPUTS = [
    "src-tauri/engine-payload",
    "src-tauri/target/debug/engine",
    "src-tauri/target/release/engine",
    "src-tauri/target/release/bundle/portable/tree.staging/engine",
]


def offenders(tree: pathlib.Path) -> list[str]:
    hits = []
    for path in tree.rglob("*"):
        if path.name == "__pycache__" or path.suffix in (".pyc", ".pyo"):
            hits.append(str(path.relative_to(ROOT)))
    return hits


def main() -> int:
    bad = []

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

    if bad:
        print("engine payload gate refused:")
        for line in bad[:20]:
            print("  " + line)
        if len(bad) > 20:
            print(f"  ... and {len(bad) - 20} more")
        return 1

    print(f"engine payload OK: declaration points at {STAGING}, {checked} built tree(s) clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
