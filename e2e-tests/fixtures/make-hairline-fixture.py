"""Builds the HAIRLINE fixture.

`hairlines-ladder.pdf` carries one rule at each ladder width plus the case the
raw operand hides — a `1 w` under a tenth-scale transform, which draws 0.1 pt.
Both halves matter end to end: the count the panel reports and the widths it
raises are only evidence because the page was built to carry them.

It comes from the same builder the engine tests use, so the fixture and the
unit measurements cannot describe different pages. Offline, and the CONTENT is
deterministic — a rerun rewrites only the document `/ID`, which qpdf mints per
save, so a regeneration is reviewable as a diff.

Run with the bundled runtime, from the repo root:

    ./resources/python/python.exe e2e-tests/fixtures/make-hairline-fixture.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))

from hairline_builders import hairline_ladder_pdf  # noqa: E402

HERE = Path(__file__).resolve().parent


def main() -> int:
    ladder = hairline_ladder_pdf(HERE / "hairlines-ladder.pdf")
    print(f"wrote {ladder} ({Path(ladder).stat().st_size:,} B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
