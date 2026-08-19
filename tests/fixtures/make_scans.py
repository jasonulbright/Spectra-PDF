"""Deterministic scan fixtures for the MRC pass.

Run it to regenerate; the resulting PDFs are CHECKED IN beside it so a
regeneration is reviewable as a git diff rather than a silent change to what
the size and legibility pins measure.

    .venv/Scripts/python.exe tests/fixtures/make_scans.py

Every step is seeded or exact — the same command on the same Ghostscript
produces the same bytes, which is what lets `tests/test_mrc.py` assert SIZE
bands rather than "smaller than before".

Three fixtures, chosen for what they can each break:

  * `scan-text.pdf`   — clean prose plus an INVISIBLE (`Tr 3`) OCR layer. The
                        OCR layer is the thing a rebuild would destroy, so it
                        is the survival pin.
  * `scan-photo.pdf`  — prose, a continuous-tone photograph and a halftone
                        patch. Neither pictorial region may enter the 1-bit
                        stencil (rule 3).
  * `scan-form.pdf`   — a coloured form scan carrying REAL AcroForm fields
                        over the page image. /AcroForm is what `compress`'s
                        Ghostscript branch has to transplant back; MRC must
                        not disturb it at all.
"""

from __future__ import annotations

import io
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pikepdf
from PIL import Image, ImageFilter
from pikepdf import Array, Dictionary, Name

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

PAGE_W, PAGE_H = 612.0, 792.0
DPI = 300
SEED = 20260804

BODY = [
    "Mixed raster content separates a scanned page into three layers.",
    "The stencil records where ink is, at the resolution of the scan.",
    "A small foreground image carries the colour of that ink, and is",
    "drawn through the stencil so its low resolution never shows.",
    "The background carries the paper, inpainted from paper pixels only,",
    "which is why the text leaves no ghost behind it in the output.",
    "Quick brown foxes jump over the lazy dog, seventeen times daily.",
    "Numerals: 0123456789. Punctuation: ,.;:!? and (parentheses) too.",
    "The window for the local threshold comes from the page itself,",
    "measured as the median height of its own connected components.",
    "A photograph is not text and must never enter a one-bit mask;",
    "neither may a halftone, which would moire on any screen it met.",
    "Every mask is decoded back before it is embedded, through a",
    "different decoder than the one that wrote it, and compared.",
    "Compression that destroys the words is not compression at all.",
]


def _escape(text: str) -> str:
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def _text_pdf(dest: Path) -> None:
    """A plain vector-text page — the thing a scanner would photograph."""
    lines = ["BT /F1 11 Tf 14 TL 60 720 Td"]
    for line in BODY:
        lines.append(f"({_escape(line)}) Tj T*")
    lines.append("T* T*")
    for line in BODY:
        lines.append(f"({_escape(line)}) Tj T*")
    lines.append("ET")
    lines.append("0.6 w 60 300 m 552 300 l S")
    content = "\n".join(lines).encode("latin-1")

    pdf = pikepdf.Pdf.new()
    font = pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type1"),
            BaseFont=Name("/Helvetica"),
            Encoding=Name("/WinAnsiEncoding"),
        )
    )
    page = Dictionary(
        Type=Name("/Page"),
        MediaBox=[0, 0, PAGE_W, PAGE_H],
        Resources=Dictionary(Font=Dictionary(F1=font)),
        Contents=pdf.make_stream(content),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(dest))


def _render(src: Path, dest: Path) -> Image.Image:
    # Fixture regeneration follows the same capability rule as the product:
    # Ghostscript is user-installed, never under resources/ghostscript, and a
    # file's existence alone does not prove it can initialise or render.
    engine_src = str(REPO / "src")
    if engine_src not in sys.path:
        sys.path.insert(0, engine_src)
    from engine.gs_capability import require  # noqa: PLC0415

    gs = require().path
    subprocess.run(
        [
            gs, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
            "-sDEVICE=png16m", f"-r{DPI}", f"-sOutputFile={dest}", str(src),
        ],
        check=True,
        capture_output=True,
        stdin=subprocess.DEVNULL,
    )
    with Image.open(dest) as im:
        return im.convert("RGB")


def _scan_look(page: Image.Image, *, tint: tuple[int, int, int]) -> Image.Image:
    """Tint, blur and noise — a fixed-seed imitation of a real scan."""
    rng = np.random.default_rng(SEED)
    arr = np.asarray(page, dtype=np.float32)
    paper = np.array(tint, dtype=np.float32) / 255.0
    arr = arr * paper[None, None, :]
    out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
    out = out.filter(ImageFilter.GaussianBlur(radius=0.7))
    arr = np.asarray(out, dtype=np.float32)
    arr += rng.normal(0.0, 4.0, arr.shape).astype(np.float32)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def _photograph(size: tuple[int, int]) -> Image.Image:
    """A continuous-tone block: a smooth gradient under fixed-seed grain."""
    w, h = size
    rng = np.random.default_rng(SEED + 1)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    base = 40.0 + 170.0 * (0.5 + 0.5 * np.sin(xx / 90.0) * np.cos(yy / 70.0))
    grain = rng.normal(0.0, 10.0, (h, w)).astype(np.float32)
    r = np.clip(base + grain, 0, 255)
    g = np.clip(base * 0.85 + grain, 0, 255)
    b = np.clip(base * 0.65 + grain, 0, 255)
    return Image.fromarray(np.stack([r, g, b], axis=-1).astype(np.uint8), "RGB")


def _halftone(size: tuple[int, int]) -> Image.Image:
    """A regular dot field — dense, high-frequency, and NOT text."""
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w]
    pitch = 8
    dot = ((xx % pitch) - pitch // 2) ** 2 + ((yy % pitch) - pitch // 2) ** 2 <= 4
    arr = np.where(dot, 30, 245).astype(np.uint8)
    return Image.fromarray(np.stack([arr] * 3, axis=-1), "RGB")


def _jpeg_page_pdf(scan: Image.Image, dest: Path, *, ocr_text: bool, form: bool) -> None:
    """Wrap `scan` as one JPEG page image, optionally with an OCR layer/form."""
    buf = io.BytesIO()
    scan.save(buf, format="JPEG", quality=80, progressive=False)
    data = buf.getvalue()

    pdf = pikepdf.Pdf.new()
    img = pikepdf.Stream(pdf, data)
    img["/Type"] = Name("/XObject")
    img["/Subtype"] = Name("/Image")
    img["/Width"] = scan.width
    img["/Height"] = scan.height
    img["/ColorSpace"] = Name("/DeviceRGB")
    img["/BitsPerComponent"] = 8
    img["/Filter"] = Name("/DCTDecode")
    img = pdf.make_indirect(img)

    content = [f"q {PAGE_W:.2f} 0 0 {PAGE_H:.2f} 0 0 cm /Im0 Do Q"]
    resources = Dictionary(XObject=Dictionary(Im0=img))
    if ocr_text:
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type1"),
                BaseFont=Name("/Helvetica"),
                Encoding=Name("/WinAnsiEncoding"),
            )
        )
        resources["/Font"] = Dictionary(F1=font)
        # Tr 3 — the invisible OCR layer. The classifier must ACCEPT this and
        # the surgery must leave it byte-identical.
        lines = ["BT 3 Tr /F1 11 Tf 14 TL 60 720 Td"]
        for line in BODY:
            lines.append(f"({_escape(line)}) Tj T*")
        lines.append("ET")
        content.append("\n".join(lines))
    page_dict = Dictionary(
        Type=Name("/Page"),
        MediaBox=[0, 0, PAGE_W, PAGE_H],
        Resources=resources,
        Contents=pdf.make_stream("\n".join(content).encode("latin-1")),
    )
    page_obj = pdf.make_indirect(page_dict)
    pdf.pages.append(pikepdf.Page(page_obj))

    if form:
        helv = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type1"),
                BaseFont=Name("/Helvetica"),
                Encoding=Name("/WinAnsiEncoding"),
            )
        )
        fields = []
        annots = []
        for i, (name, value) in enumerate(
            (("applicant", "Ada Lovelace"), ("reference", "MRC-0001"), ("notes", ""))
        ):
            y = 240 - i * 40
            widget = pdf.make_indirect(
                Dictionary(
                    Type=Name("/Annot"),
                    Subtype=Name("/Widget"),
                    FT=Name("/Tx"),
                    T=pikepdf.String(name),
                    V=pikepdf.String(value),
                    DA=pikepdf.String("/Helv 10 Tf 0 g"),
                    F=4,
                    Rect=Array([200, y, 480, y + 22]),
                    P=page_obj,
                )
            )
            fields.append(widget)
            annots.append(widget)
        page_obj["/Annots"] = Array(annots)
        pdf.Root["/AcroForm"] = pdf.make_indirect(
            Dictionary(
                Fields=Array(fields),
                DA=pikepdf.String("/Helv 10 Tf 0 g"),
                DR=Dictionary(Font=Dictionary(Helv=helv)),
                NeedAppearances=True,
            )
        )

    pdf.save(str(dest))


def build() -> None:
    with tempfile.TemporaryDirectory(prefix="spectrapdf_scanfix_") as work:
        wd = Path(work)
        source = wd / "text.pdf"
        _text_pdf(source)
        page = _render(source, wd / "page.png")

        # 1 — clean text scan, with an invisible OCR layer.
        _jpeg_page_pdf(
            _scan_look(page, tint=(250, 247, 236)),
            HERE / "scan-text.pdf",
            ocr_text=True,
            form=False,
        )

        # 2 — text plus a photograph and a halftone patch.
        mixed = page.copy()
        photo_box = (300, 900, 1900, 1900)
        mixed.paste(
            _photograph((photo_box[2] - photo_box[0], photo_box[3] - photo_box[1])),
            photo_box[:2],
        )
        half_box = (300, 2000, 1500, 2500)
        mixed.paste(
            _halftone((half_box[2] - half_box[0], half_box[3] - half_box[1])),
            half_box[:2],
        )
        _jpeg_page_pdf(
            _scan_look(mixed, tint=(248, 246, 240)),
            HERE / "scan-photo.pdf",
            ocr_text=False,
            form=False,
        )

        # 3 — a coloured form scan carrying real AcroForm fields.
        _jpeg_page_pdf(
            _scan_look(page, tint=(236, 240, 252)),
            HERE / "scan-form.pdf",
            ocr_text=False,
            form=True,
        )

    for name in ("scan-text.pdf", "scan-photo.pdf", "scan-form.pdf"):
        path = HERE / name
        print(f"{name:16} {path.stat().st_size / 1024:8.1f} KB")


if __name__ == "__main__":
    sys.exit(build())
