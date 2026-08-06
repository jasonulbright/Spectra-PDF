"""Builds the TRANSPARENCY fixture.

`transparency-page.pdf` is a letter page with thirty lines of live text, one
vector rule, and a single half-transparent square in a corner that overlaps
neither. Both halves matter end to end: what the flattener rasterizes, and
what it leaves alone. Text still being extractable after the flatten is only
evidence because the page was built to carry text nowhere near the square.

It comes from the same builder the engine tests use, so the fixture and the
unit measurements cannot describe different pages. Offline, and the CONTENT is
deterministic — a rerun rewrites only the document `/ID`, which qpdf mints per
save, so a regeneration is reviewable as a diff.

Run with the bundled runtime, from the repo root:

    ./resources/python/python.exe e2e-tests/fixtures/make-transparency-fixture.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))

from transparency_builders import text_and_alpha_square_pdf  # noqa: E402

HERE = Path(__file__).resolve().parent


def main() -> int:
    page = text_and_alpha_square_pdf(HERE / "transparency-page.pdf")
    print(f"wrote {page} ({Path(page).stat().st_size:,} B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
