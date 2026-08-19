"""Headless OCR recognition through the native engine.

This is the app's only recognizer, shared by GUI, CLI, batch, and scheduled
runs. Keeping recognition in the engine supports headless operation and avoids
multiple recognizers disagreeing about the same page.

The pipeline is two external tools, both already required by the product
(tesseract ships with it; Ghostscript is user-supplied and validated before
each raster):

    page -> Ghostscript raster (PNG, 300 dpi) -> tesseract TSV -> word boxes

Coordinates: tesseract reports boxes in IMAGE PIXELS. This returns them
normalized to fractions of the rendered page (x, y, w, h in 0..1, y measured
from the top). Consumers retain responsibility for display-to-PDF conversion.
Doing the PDF-space conversion here instead would have been a second geometry
idiom for the same job; `lib/pdfx-build.displayRectToPdf` stays the one recipe.

That recipe denormalizes against the CROP-INTERSECTED page box —
`lib/pdfx-build.displayRectToPdf` against pdf.js's `page.view`,
`batch_ocr._to_pdf_rects` and `form_detect` against `/CropBox`. The raster is
therefore framed on the CropBox too. Framing it on the MediaBox instead scales
and translates every recognised box by the ratio between the two boxes, so the
invisible text layer written back into the document sits away from the glyphs
it transcribes and no reader's text selection lands on the words.
"""

import csv
import io
import os
import re
import subprocess
import tempfile
from pathlib import Path

from . import budget

# Matches the renderer's old rasterizer (ocr-client.ts): 300 dpi is the density
# tesseract's models are trained around -- materially lower loses small type,
# materially higher costs time for no accuracy.
OCR_DPI = 300

# Tesseract TSV columns. `level` 5 is a WORD row; the coarser levels (page,
# block, paragraph, line) describe layout and are not what we index.
_LEVEL_WORD = 5

# A language string reaches us already validated by ocr/language-selection.ts,
# but this process also serves the CLI, where it arrives straight from a user.
# Tesseract treats the value as a filename stem, so anything outside this set
# could reach the filesystem.
#
# A stem is an ISO 639-2/T code with an optional script/variant suffix. The
# suffix is THREE OR FOUR letters: the vendored tessdata's only suffixed models
# are `chi_sim` and `chi_tra`, and tesseract's own script suffixes elsewhere
# (`_cyrl`, `_latn`, `_vert`) are four. A pattern that admitted only the
# four-letter form rejected both Chinese models -- offered by the picker,
# present in the tree -- with "Invalid recognition language", so Chinese
# recognition could not be reached through this door at all. Widen only to
# real stem shapes: the guard's job is that no separator, dot, or path
# character survives.
_LANG_STEM = r"[a-z]{3}(?:_[a-z]{3,4})?"
_LANG_RE = re.compile(rf"^{_LANG_STEM}(?:\+{_LANG_STEM})*$", re.IGNORECASE)


def _tesseract_exe(tesseract_path: str) -> Path:
    exe = Path(tesseract_path) if tesseract_path else Path()
    if not exe.is_file():
        raise RuntimeError(
            "The OCR engine is not available: no tesseract.exe at "
            f"{tesseract_path or '(no path given)'}. Run scripts/bundle-tesseract.ps1."
        )
    return exe


def _render_page_png(file: str, page: int, gs_path: str, out_png: Path) -> None:
    """Rasterise ONE page with the configured Ghostscript.

    Same device/idiom as image_export.py. -dFirstPage/-dLastPage bound the work
    to the single page being recognised, so a 900-page scan costs one page's
    render per call rather than re-rendering the document.

    -dUseCropBox frames the raster the way every consumer of these coordinates
    denormalizes them (see the module docstring). The device clips page content
    to the CropBox with or without the flag, so the flag changes the frame and
    never what is recognised, and on a page with no CropBox it changes nothing.
    Both the flag and the page box apply /Rotate, so the two agree with no
    further normalization.
    """
    cmd = [
        gs_path,
        "-q",
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        "-sDEVICE=png16m",
        f"-r{OCR_DPI}",
        "-dUseCropBox",
        f"-dFirstPage={page}",
        f"-dLastPage={page}",
        f"-sOutputFile={out_png}",
        str(file),
    ]
    # Through the gs family's door: it validates the executable (a file that
    # exists is not a Ghostscript that runs) and derives the budget. This run
    # previously had no timeout at all, so an interpreter that hung stalled
    # the whole recognition with nothing to report.
    proc = budget.gs(cmd, what=f"Ghostscript (OCR raster, page {page})",
                     path=file, pages=1)
    if proc.returncode != 0 or not out_png.is_file():
        detail = (proc.stderr or proc.stdout or "").strip()[:400]
        raise RuntimeError(f"Could not render page {page} for OCR: {detail}")


def _png_size(path: Path) -> tuple[int, int]:
    """Width/height straight out of the PNG IHDR.

    Deliberately not Pillow: the normalisation below divides by these numbers,
    so reading them from the file we just wrote keeps the denominator exact and
    avoids a decode of a 300-dpi page purely to learn its dimensions.
    """
    with open(path, "rb") as fh:
        header = fh.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError("OCR rasteriser did not produce a PNG")
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    if width <= 0 or height <= 0:
        raise RuntimeError("OCR rasteriser produced a zero-sized page image")
    return width, height


def _parse_tsv(tsv_text: str, width: int, height: int) -> tuple[str, list[dict]]:
    """TSV -> (plain text, normalised word boxes).

    Rows are tab-separated and the `text` column may itself contain spaces, so
    this uses a real TSV reader rather than splitting -- a naive split drops the
    right-hand columns of any multi-space word and silently shortens the text.
    """
    words: list[dict] = []
    reader = csv.DictReader(io.StringIO(tsv_text), delimiter="\t", quoting=csv.QUOTE_NONE)
    for row in reader:
        try:
            if int(row.get("level", "0")) != _LEVEL_WORD:
                continue
        except (TypeError, ValueError):
            continue
        text = (row.get("text") or "").strip()
        if not text:
            continue
        try:
            left = float(row["left"])
            top = float(row["top"])
            w = float(row["width"])
            h = float(row["height"])
        except (KeyError, TypeError, ValueError):
            continue
        if w <= 0 or h <= 0:
            continue
        words.append(
            {
                "text": text,
                "x": left / width,
                "y": top / height,
                "w": w / width,
                "h": h / height,
            }
        )
    # The plain text is the words in reading order -- the same thing the search
    # index consumed from tesseract.js's `text`.
    return " ".join(word["text"] for word in words), words


def _validated_lang(lang: str) -> str:
    lang = (lang or "eng").strip()
    if not _LANG_RE.match(lang):
        raise ValueError(f"Invalid recognition language: {lang!r}")
    return lang


def _tessdata_for(exe: Path) -> Path:
    """tessdata sits beside the executable in the vendored tree.

    Passing it explicitly means recognition does not depend on TESSDATA_PREFIX
    being set in whatever environment the run happens in -- which for a
    SCHEDULED run under a service account is an environment nobody configured.
    """
    tessdata = exe.parent / "tessdata"
    if not tessdata.is_dir():
        raise RuntimeError(f"No tessdata beside {exe}; run scripts/bundle-tesseract.ps1.")
    return tessdata


class _TesseractFailure(Exception):
    """The recognizer failed; the caller owns the WORDING.

    Deliberately not a formatted RuntimeError raised here: the refusal table
    (`locales/engine-messages.tsv`) matches a message by SHAPE, and folding
    "page 3" or "the page image" into one `{{what}}` placeholder would leave
    an English fragment sitting inside every translated sentence. Two call
    sites, two literal messages, two translatable rows.
    """

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


def _run_tesseract(png: Path, lang: str, exe: Path, tessdata: Path) -> tuple[str, list[dict]]:
    """One tesseract invocation over one PNG -> (text, normalised word boxes).

    The ONE place the recognizer is spawned. `recognize` (page of a PDF) and
    `recognize_image` (a raster somebody else produced -- the MRC text-
    verification gate) differ only in how the PNG arrives; two invocations
    that could drift apart in flags or parsing would be two recognizers, which
    is the silent-degradation class this module exists to have exactly one of.
    """
    width, height = _png_size(png)
    cmd = [
        str(exe),
        str(png),
        "stdout",
        "-l",
        lang,
        "--tessdata-dir",
        str(tessdata),
        "tsv",
    ]
    env = dict(os.environ)
    env["TESSDATA_PREFIX"] = str(tessdata)
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=env)
    if proc.returncode != 0:
        raise _TesseractFailure((proc.stderr or "").strip()[:400])
    # A missing configs/tsv makes tesseract print PLAIN TEXT, exit 0, and
    # only mention it on stderr. That would parse as zero words and read as
    # "this page has no text" -- the exact silent degradation this program
    # refuses. Fail loudly instead.
    if "Can't open tsv" in (proc.stderr or ""):
        raise RuntimeError(
            "OCR produced no word boxes: tessdata/configs/tsv is missing from the "
            "vendored Tesseract. Re-run scripts/bundle-tesseract.ps1."
        )
    return _parse_tsv(proc.stdout or "", width, height)


def recognize_image(
    image: str,
    lang: str = "eng",
    tesseract_path: str = "",
) -> dict:
    """Recognise an already-rasterised page image (PNG) -- ``{text, words}``.

    The MRC text-verification gate compares what the SOURCE page
    says against what the RECONSTRUCTED page says, and both sides are rasters
    the pass already holds in memory -- there is no PDF to render, and writing
    one purely to be re-rendered would put a second (lossy, differently-scaled)
    step between the thing measured and the measurement. Coordinates are
    normalised exactly as `recognize` normalises them.
    """
    exe = _tesseract_exe(tesseract_path)
    png = Path(image)
    if not png.is_file():
        raise FileNotFoundError(f"File not found: {image}")
    try:
        text, words = _run_tesseract(png, _validated_lang(lang), exe, _tessdata_for(exe))
    except _TesseractFailure as exc:
        # Bound to a local named `detail` deliberately: the refusal table names
        # its placeholder after the expression it interpolates, so raising
        # `exc.detail` inline would rewrite `{{detail}}` to `{{v0}}` and orphan
        # every translation of the row.
        detail = exc.detail
        raise RuntimeError(f"OCR failed on the page image: {detail}") from exc
    return {"text": text, "words": words}


def recognize(
    file: str,
    page: int,
    lang: str = "eng",
    tesseract_path: str = "",
    gs_path: str = "",
) -> dict:
    """Recognise ONE page and return ``{text, words}``.

    Args:
        file: PDF path.
        page: 1-based page number.
        lang: Tesseract language string; '+'-joined for several at once
            (e.g. ``eng+fra``). NOT auto-detection -- each model is loaded and
            run, which is slower and slightly less accurate on a page that is
            only one of them.
        tesseract_path: Path to the vendored tesseract.exe.
        gs_path: Path to the Ghostscript to drive ("" resolves one).

    Returns:
        ``{"text": str, "words": [{text, x, y, w, h}]}`` with coordinates
        normalised to the rendered page (y from the top) -- the tesseract.js
        contract, unchanged.
    """
    if page < 1:
        raise ValueError("page must be 1-based")
    lang = _validated_lang(lang)

    exe = _tesseract_exe(tesseract_path)
    input_path = Path(file)
    if not input_path.is_file():
        raise FileNotFoundError(f"File not found: {file}")

    tessdata = _tessdata_for(exe)

    with tempfile.TemporaryDirectory(prefix="opdfs-ocr-") as tmp:
        png = Path(tmp) / "page.png"
        _render_page_png(str(input_path), page, gs_path, png)
        try:
            text, words = _run_tesseract(png, lang, exe, tessdata)
        except _TesseractFailure as exc:
            detail = exc.detail  # see recognize_image — the placeholder's name
            raise RuntimeError(f"OCR failed on page {page}: {detail}") from exc

    return {"text": text, "words": words}
