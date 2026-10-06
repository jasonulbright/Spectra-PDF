"""The skew estimate does not depend on the number of BLAS threads.

Every engine process runs with ``OPENBLAS_NUM_THREADS=1``. The engine's one
BLAS call is the dot product inside ``enhance_scan`` that scores each trial
angle, and its argmax picks the angle; a sum split across threads could move a
near-tie. This test measures the fixture page in two fresh interpreters, one
with one BLAS thread and one with the library's own default, and requires the
same angle to the last bit.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "scan-skew.pdf"

MEASURE = """
import sys
sys.path.insert(0, sys.argv[1])
import numpy as np
import pikepdf
from engine.enhance_scan import estimate_skew
with pikepdf.open(sys.argv[2]) as pdf:
    page = pdf.pages[0]
    name = next(iter(page.Resources.XObject.keys()))
    image = pikepdf.PdfImage(page.Resources.XObject[name]).as_pil_image()
gray = np.asarray(image.convert("L"), dtype=np.uint8)
print(float(estimate_skew(gray, dpi=300)).hex())
"""


def _measure(threads: str | None) -> str:
    env = {k: v for k, v in os.environ.items() if k != "OPENBLAS_NUM_THREADS"}
    if threads is not None:
        env["OPENBLAS_NUM_THREADS"] = threads
    done = subprocess.run(
        [sys.executable, "-c", MEASURE, str(ROOT / "src"), str(FIXTURE)],
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    return done.stdout.strip()


def test_one_blas_thread_measures_the_same_skew_angle():
    assert FIXTURE.is_file(), "scan-skew.pdf is a tracked fixture"
    one = _measure("1")
    default = _measure(None)
    assert one == default
    assert abs(float.fromhex(one)) > 0.0
