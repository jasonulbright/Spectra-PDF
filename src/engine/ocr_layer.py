"""Apply an INVISIBLE OCR text layer (the persistence half of Phase 2m).

The renderer's tesseract.js worker recognizes scanned pages and converts the
word boxes to PDF user-space rects (the same displayRectToPdf recipe as
redaction/signature placement); this handler writes them into the file as an
invisible-text overlay so the document becomes genuinely searchable ON DISK —
pdfminer/pdf.js/Acrobat all extract it. Recognition itself is renderer-side
by explicit roadmap assignment (§C); see
docs/architecture/15-phase2m-ocr-find.md for the CLI scope boundary.

Construction — the standard "OCR under" text layer:
  - One Form XObject per page, tagged with a private resource name
    (``/OpenPDFStudioOCR``) so re-applying REPLACES this tool's own layer instead
    of stacking duplicates (idempotence), and never touches text from any
    other source.
  - Inside: ``Tr 3`` (invisible text rendering mode), one text run per word,
    Helvetica metrics (shared pdf_metrics) sizing each run to its box
    (width-fit capped by box height) at the box baseline. The page's visual
    appearance is unchanged — the overlay draws nothing.
  - Content is ADDITIVE: the original content stream is untouched; the
    overlay is appended as ``q /OpenPDFStudioOCR Do Q``.

Fail-closed: all edits validated first (page range, rect shape, encodable
text); output written only after every page succeeds; in-place via
temp+rename.
"""

import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from engine.pdf_metrics import text_width_em

OCR_XOBJECT_NAME = "/OpenPDFStudioOCR"
MIN_WORD_FONT = 1.0
MAX_WORD_FONT = 144.0


def _fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".") or "0"


def _escape_text(value: str) -> bytes:
    """cp1252 with PDF escapes — same encoding class as the forms layer; the
    caller pre-validates so this never raises mid-write."""
    raw = value.encode("cp1252")
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _build_layer_stream(pdf: pikepdf.Pdf, words: list[dict], media: tuple[float, float, float, float]):
    """The invisible-text Form XObject for one page."""
    x0, y0, x1, y1 = media
    parts = [b"q", b"BT", b"3 Tr"]
    for word in words:
        wx0, wy0, wx1, wy1 = word["rect"]
        box_w = max(wx1 - wx0, 0.01)
        box_h = max(wy1 - wy0, 0.01)
        text = word["text"]
        width_em = max(text_width_em(text), 0.05)
        size = min(box_w / width_em, box_h)
        size = max(MIN_WORD_FONT, min(MAX_WORD_FONT, size))
        # Baseline a bit above the box bottom (descent share).
        baseline = wy0 + 0.2 * size
        parts.append(f"/F0 {_fmt(size)} Tf".encode("ascii"))
        parts.append(f"1 0 0 1 {_fmt(wx0)} {_fmt(baseline)} Tm".encode("ascii"))
        parts.append(b"(" + _escape_text(text) + b") Tj")
    parts.extend([b"ET", b"Q"])

    font = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name.Helvetica,
            Encoding=Name.WinAnsiEncoding,
        )
    )
    stream = pdf.make_stream(b"\n".join(parts))
    stream["/Type"] = Name.XObject
    stream["/Subtype"] = Name.Form
    stream["/BBox"] = pikepdf.Array([x0, y0, x1, y1])
    stream["/Resources"] = Dictionary(Font=Dictionary(F0=font))
    return stream


def _page_media(page) -> tuple[float, float, float, float]:
    box = page.obj.get("/MediaBox")
    if box is None:
        from engine.pdf_tree import walk_inheritable

        box = walk_inheritable(page, "/MediaBox")
    if box is None:
        return (0.0, 0.0, 612.0, 792.0)
    vals = [float(v) for v in box]
    return (min(vals[0], vals[2]), min(vals[1], vals[3]), max(vals[0], vals[2]), max(vals[1], vals[3]))


def apply_ocr_layer(file: str, output: str, pages: list[dict]) -> dict:
    """Write invisible OCR text layers.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal input — temp+rename).
        pages: ``[{page: <1-based>, words: [{text, rect: [x0,y0,x1,y1]}]}]``,
            rects in PDF user-space points (bottom-up).
    """
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        # Validate EVERYTHING before mutating anything.
        problems: list[str] = []
        plan: list[tuple[int, list[dict]]] = []
        for entry in pages or []:
            try:
                page_num = int(entry["page"])
            except (KeyError, TypeError, ValueError):
                problems.append("page entry without a valid page number")
                continue
            if not (1 <= page_num <= total):
                problems.append(f"page {page_num} is out of range (1-{total})")
                continue
            words_in = entry.get("words") or []
            words: list[dict] = []
            for w in words_in:
                try:
                    text = str(w["text"]).strip()
                    rx0, ry0, rx1, ry1 = (float(v) for v in w["rect"])
                except (KeyError, TypeError, ValueError):
                    problems.append(f"page {page_num}: malformed word entry")
                    break
                if not text:
                    continue
                try:
                    text.encode("cp1252")
                except UnicodeEncodeError:
                    # OCR output outside WinAnsi (rare for the shipped Latin
                    # languages) — skip the word rather than fail the page:
                    # a partially-searchable page beats an unsearchable one,
                    # and the count is reported honestly below.
                    continue
                words.append(
                    {"text": text, "rect": (min(rx0, rx1), min(ry0, ry1), max(rx0, rx1), max(ry0, ry1))}
                )
            else:
                if words:
                    plan.append((page_num, words))
        if problems:
            raise ValueError("; ".join(problems))
        if not plan:
            raise ValueError("No OCR words to apply.")

        words_applied = 0
        for page_num, words in plan:
            page = pdf.pages[page_num - 1]
            media = _page_media(page)
            stream = _build_layer_stream(pdf, words, media)

            resources = page.obj.get("/Resources")
            if resources is None:
                resources = Dictionary()
                page.obj["/Resources"] = resources
            xobjects = resources.get("/XObject")
            if xobjects is None:
                xobjects = Dictionary()
                resources["/XObject"] = xobjects

            replaced = Name(OCR_XOBJECT_NAME) in xobjects
            xobjects[Name(OCR_XOBJECT_NAME)] = pdf.make_indirect(stream)

            if not replaced:
                # First application on this page: append the overlay draw.
                # (On re-application the existing draw already points at the
                # name we just swapped — REPLACE semantics, no stacking.)
                existing = pikepdf.parse_content_stream(page)
                content = pikepdf.unparse_content_stream(existing)
                content += f"\nq {OCR_XOBJECT_NAME} Do Q".encode("ascii")
                page.Contents = pdf.make_stream(content)
            words_applied += len(words)

        if same_file:
            with tempfile.NamedTemporaryFile(
                suffix=".pdf", delete=False, dir=str(input_path.parent)
            ) as tmp:
                tmp_path = tmp.name
            pdf.save(tmp_path)
        else:
            pdf.save(output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {
        "output": str(output_path),
        "pages_applied": len(plan),
        "words_applied": words_applied,
    }
