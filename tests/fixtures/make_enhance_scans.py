"""Deterministic scan-enhancement fixtures.

Run it to regenerate; the resulting PDFs are CHECKED IN beside it so a
regeneration is reviewable as a git diff rather than a silent change to what
the accuracy and count pins measure.

    .venv/Scripts/python.exe tests/fixtures/make_enhance_scans.py

Every step is seeded or exact, and each fixture is built by taking the SAME
rendered text page `make_scans.py` uses and applying ONE known defect, so the
measured number the test asserts has a known true value to be compared against:

  * `scan-skew.pdf`     — the page rotated by exactly +2.75°, so the deskew
                          estimator has a ground truth to be scored against.
  * `scan-speckle.pdf`  — 900 injected 1-2 px specks at a fixed seed, so the
                          despeckle count is a pin rather than a range.
  * `scan-dim.pdf`      — photographed on grey paper under a corner shadow, so
                          the background arm has a gradient to remove rather
                          than a level to lift.
  * `scan-sideways.pdf` — the page turned 90°, so OSD has something to detect
                          and the /Rotate result has a known answer.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import io

import numpy as np
import pikepdf
from PIL import Image, ImageFilter
from pikepdf import Dictionary, Name

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from make_scans import _render, _text_pdf  # noqa: E402

SEED = 20260808
DPI = 300
PAPER = (252, 250, 244)

#: The angle `scan-skew.pdf` is built at. The test compares the estimator's
#: answer to THIS number, so the two must not drift apart.
SKEW_DEGREES = 2.75
#: How many specks `scan-speckle.pdf` carries. Not the number the despeckler
#: removes — some land on glyphs and merge, which is the point of injecting
#: them onto a text page rather than onto blank paper.
SPECKLE_COUNT = 900


def _page_pdf(scan: Image.Image, dest: Path) -> None:
    """One JPEG page image on a MediaBox sized from it at `DPI`.

    Deliberately not `make_scans._jpeg_page_pdf`: that one hard-codes a
    612x792 portrait box, which would squash the sideways fixture into the
    wrong aspect ratio and give the geometry pins a distortion to measure
    instead of a rotation.
    """
    buf = io.BytesIO()
    scan.save(buf, format="JPEG", quality=80, progressive=False)

    pdf = pikepdf.Pdf.new()
    img = pikepdf.Stream(pdf, buf.getvalue())
    img["/Type"] = Name("/XObject")
    img["/Subtype"] = Name("/Image")
    img["/Width"] = scan.width
    img["/Height"] = scan.height
    img["/ColorSpace"] = Name("/DeviceRGB")
    img["/BitsPerComponent"] = 8
    img["/Filter"] = Name("/DCTDecode")
    img = pdf.make_indirect(img)

    w = scan.width * 72.0 / DPI
    h = scan.height * 72.0 / DPI
    page = Dictionary(
        Type=Name("/Page"),
        MediaBox=[0, 0, w, h],
        Resources=Dictionary(XObject=Dictionary(Im0=img)),
        Contents=pdf.make_stream(f"q {w:.2f} 0 0 {h:.2f} 0 0 cm /Im0 Do Q".encode("latin-1")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(dest))


def base_page() -> Image.Image:
    with tempfile.TemporaryDirectory(prefix="spectrapdf_enhfix_") as work:
        wd = Path(work)
        src = wd / "text.pdf"
        _text_pdf(src)
        return _render(src, wd / "page.png")


def scan_look(page: Image.Image, *, tint=(250, 247, 236), noise: float = 4.0) -> Image.Image:
    """Tint, blur and noise — `make_scans._scan_look`'s treatment, with the
    tint and the grain amplitude opened up so a dim fixture can be built."""
    rng = np.random.default_rng(SEED)
    arr = np.asarray(page, dtype=np.float32) * (np.array(tint, np.float32) / 255.0)
    out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
    out = out.filter(ImageFilter.GaussianBlur(radius=0.7))
    arr = np.asarray(out, dtype=np.float32)
    arr += rng.normal(0.0, noise, arr.shape).astype(np.float32)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def skewed(page: Image.Image) -> Image.Image:
    return scan_look(
        page.rotate(SKEW_DEGREES, resample=Image.BICUBIC, expand=False, fillcolor=PAPER)
    )


def speckled(page: Image.Image) -> Image.Image:
    rng = np.random.default_rng(SEED + 7)
    arr = np.asarray(scan_look(page), dtype=np.uint8).copy()
    h, w, _ = arr.shape
    ys = rng.integers(0, h - 3, SPECKLE_COUNT)
    xs = rng.integers(0, w - 3, SPECKLE_COUNT)
    for y, x in zip(ys, xs):
        side = int(rng.integers(1, 3))
        arr[y : y + side, x : x + side] = (28, 26, 24)
    return Image.fromarray(arr, "RGB")


def dimmed(page: Image.Image) -> Image.Image:
    """Grey paper under a corner shadow — a GRADIENT, which is what separates a
    background correction from a brightness slider."""
    scan = scan_look(page, tint=(206, 196, 172))
    arr = np.asarray(scan, dtype=np.float32)
    h, w, _ = arr.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    shade = 1.0 - 0.28 * np.clip(1.0 - (xx / w + yy / h), 0.0, 1.0)
    return Image.fromarray(np.clip(arr * shade[..., None], 0, 255).astype(np.uint8), "RGB")


def sideways(page: Image.Image) -> Image.Image:
    return scan_look(page).rotate(90, expand=True)


def build() -> None:
    page = base_page()
    for name, image in (
        ("scan-skew.pdf", skewed(page)),
        ("scan-speckle.pdf", speckled(page)),
        ("scan-dim.pdf", dimmed(page)),
        ("scan-sideways.pdf", sideways(page)),
    ):
        _page_pdf(image, HERE / name)
        print(f"{name:20} {(HERE / name).stat().st_size / 1024:8.1f} KB")


if __name__ == "__main__":
    sys.exit(build())
