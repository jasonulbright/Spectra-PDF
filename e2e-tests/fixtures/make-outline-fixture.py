"""Builds the OUTLINE-REFUSAL fixture.

`type3-text.pdf` draws one glyph in a Type 3 font, whose glyph procedures are
content streams rather than outlines. It is the one document shape the outline
conversion cannot convert, so it is what proves the panel states a NAMED
refusal instead of failing bare.

It comes from the same builder the engine tests use, so the fixture and the
unit measurements cannot describe different pages. Offline, and the CONTENT is
deterministic — a rerun rewrites only the document `/ID`, which qpdf mints per
save, so a regeneration is reviewable as a diff.

Run with the bundled runtime, from the repo root:

    ./resources/python/python.exe e2e-tests/fixtures/make-outline-fixture.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))

from outline_builders import type3_text_pdf  # noqa: E402

HERE = Path(__file__).resolve().parent


def main() -> int:
    page = type3_text_pdf(HERE / "type3-text.pdf")
    print(f"wrote {page} ({Path(page).stat().st_size:,} B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
