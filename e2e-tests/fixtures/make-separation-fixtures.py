"""Builds the two SEPARATION-PREVIEW fixtures.

`separations-spot.pdf` carries process patches, a `/Separation` spot at two
tints and a `/DeviceN` duotone — the ink inventory the preview lists and
toggles.

`separations-tac.pdf` is the total-ink ladder: five patches of KNOWN total ink
(0 / 100 / 200 / 300 / 340 %). The alarm assertion is only evidence because
the page was built to carry 340 %.

Both come from the same builders the engine tests use, so the fixture and the
unit measurements cannot describe different pages. Deterministic and offline;
a rerun produces the same PDFs and a regeneration is reviewable as a diff.

Run with the bundled runtime, from the repo root:

    ./resources/python/python.exe e2e-tests/fixtures/make-separation-fixtures.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))

from separation_builders import cmyk_spot_pdf, tac_ladder_pdf  # noqa: E402

HERE = Path(__file__).resolve().parent


def main() -> int:
    spot = cmyk_spot_pdf(HERE / "separations-spot.pdf")
    ladder = tac_ladder_pdf(HERE / "separations-tac.pdf")
    for path in (spot, ladder):
        print(f"wrote {path} ({Path(path).stat().st_size:,} B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
