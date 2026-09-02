#!/usr/bin/env python3
"""Refuses a renderer build that carries the e2e test harness.

`src/renderer/testHarness.ts` installs `window.__SPECTRA_TEST__`, a raw
dispatcher that bypasses the commit gate and the file lock. It is compiled out
by `TEST_HARNESS_ENABLED = import.meta.env.VITE_E2E === '1'`; a release built
in an environment where VITE_E2E leaked would ship the dispatcher, and nothing
else in the pipeline reads the bundle. This gate scans every file of the built
renderer tree for the marker string. The window property name survives
minification because it is a property access; the installer function's name
does not, so it is not a usable marker.

The tree scanned is `dist/renderer`, the `frontendDist` the Tauri binary
embeds at compile time. The embedded copy inside the executable is compressed,
so the executable itself is not a scannable surface: the gate runs against the
tree the build embedded, and nothing in the release job rebuilds that tree
between the Tauri build and this step. Extra roots may be passed positionally.
"""

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_ROOTS = ["dist/renderer"]
MARKERS = [b"__SPECTRA_TEST__"]


def scan(tree: pathlib.Path) -> list[str]:
    hits = []
    for path in sorted(tree.rglob("*")):
        if not path.is_file():
            continue
        data = path.read_bytes()
        for marker in MARKERS:
            count = data.count(marker)
            if count:
                hits.append(f"{path.as_posix()}: {marker.decode()} x{count}")
    return hits


def main(argv: list[str]) -> int:
    roots = argv or DEFAULT_ROOTS
    bad = []
    scanned = 0
    for rel in roots:
        tree = pathlib.Path(rel)
        if not tree.is_absolute():
            tree = ROOT / rel
        if not tree.is_dir():
            bad.append(f"{rel}: not a directory (build the renderer first)")
            continue
        scanned += 1
        bad.extend(scan(tree))
    if bad:
        print("release bundle gate refused (renderer built with VITE_E2E=1 must NOT be shipped):")
        for line in bad[:20]:
            print("  " + line)
        if len(bad) > 20:
            print(f"  ... and {len(bad) - 20} more")
        return 1
    print(f"release bundle OK: {scanned} tree(s) carry no test harness marker")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
