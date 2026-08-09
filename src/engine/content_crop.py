"""Content-aware crop — trim a page box to what the page actually draws.

The manual crop takes per-edge insets. This one measures instead: it finds the
rectangle the page's own content occupies and writes THAT as the page box,
keeping an optional margin around it. Nothing is deleted — a page box is a
view boundary, and resetting it brings the margin back.

Two sources of a content rectangle, and which one applies is not a guess:

* A **scanned** page (``mrc._classify_page`` says so — the same single answer
  the scan-enhancement pass uses) has one big image covering it, so the union
  of its placements IS the whole page. The rectangle comes from INK instead:
  the placement's own samples, Sauvola-binarized, with speckle-sized specks
  dropped first so one dust mote in a corner cannot hold the margin open.
* A **born-digital** page is the union of what the existing listings already
  report — text runs, painted paths, image placements — plus the rectangles of
  annotations that draw something. Geometry the walk has found clipped away is
  excluded: it is not on the page.

The union is intersected with the page's current box; content outside the
visible box is already not shown and must not pull the crop back out.

A page with nothing on it is SKIPPED with a reason and keeps its full box: a
box around no content is a page a viewer shows as nothing. If no page in the
selection yielded a rectangle, the call refuses rather than writing an output
identical to its input.
"""

import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Array

from engine.content_walk import IDENTITY
from engine.page_boxes import MIN_EXTENT, box_key, effective_box
from engine.pdf_save import save_pdf
from engine.redact import _resolve_resources

#: Annotation subtypes that draw nothing on the page. A /Popup is closed until
#: clicked and a /Link is an invisible hot spot; neither is content, and
#: treating them as such would keep the margin a link happens to reach into.
_INVISIBLE_ANNOTS = {"/Popup", "/Link"}
#: /F bits: 2 = Hidden, 6 = NoView. An annotation carrying either draws
#: nothing in a viewer and is not content either.
_HIDDEN_FLAGS = 0b100010


def _union(boxes) -> tuple | None:
    got = None
    for b in boxes:
        if b is None:
            continue
        x0, y0, x1, y1 = (float(b[0]), float(b[1]), float(b[2]), float(b[3]))
        lo_x, hi_x = min(x0, x1), max(x0, x1)
        lo_y, hi_y = min(y0, y1), max(y0, y1)
        if hi_x <= lo_x or hi_y <= lo_y:
            continue  # a rectangle with no area draws nothing
        got = (
            (lo_x, lo_y, hi_x, hi_y)
            if got is None
            else (min(got[0], lo_x), min(got[1], lo_y), max(got[2], hi_x), max(got[3], hi_y))
        )
    return got


def _annotation_boxes(page) -> list:
    """The rectangles of annotations that actually draw."""
    out = []
    annots = page.obj.get("/Annots")
    if annots is None:
        return out
    try:
        entries = list(annots)
    except TypeError:
        return out
    for annot in entries:
        try:
            subtype = str(annot.get("/Subtype", ""))
            if subtype in _INVISIBLE_ANNOTS:
                continue
            flags = int(annot.get("/F", 0))
            if flags & _HIDDEN_FLAGS:
                continue
            rect = annot.get("/Rect")
            if rect is None:
                continue
            out.append([float(rect[i]) for i in range(4)])
        except (TypeError, ValueError, AttributeError, IndexError):
            continue
    return out


def _drawn_boxes(pdf, page) -> list:
    """Device-space rectangles of everything the page's content stream paints.

    The three existing walkers, one page open, `clipped` honoured — so this
    cannot disagree with what the editors report is on the page.
    """
    from engine.page_images import _walk_placements
    from engine.page_vectors import _walk_vectors
    from engine.text_runs import _FontCache, _walk_runs

    resources = _resolve_resources(page)
    try:
        instructions = list(pikepdf.parse_content_stream(page))
    except Exception:
        return []

    boxes: list = []
    runs: list = []
    _walk_runs(pdf, instructions, resources, IDENTITY, 0, None, runs, False, _FontCache())
    for run in runs:
        # A run of spaces paints nothing; its rectangle is advance width, and
        # trailing whitespace would otherwise hold the right margin open.
        if run.get("clipped") or not str(run.get("text", "")).strip():
            continue
        boxes.append(run.get("rect"))

    placements: list = []
    _walk_placements(pdf, instructions, resources, IDENTITY, 0, None, placements, False)
    for placement in placements:
        if placement.get("clipped"):
            continue
        boxes.append(placement.get("rect"))

    for vector in _walk_vectors(instructions, pdf=pdf, resources=resources):
        if vector.get("clipped"):
            continue
        # A path with no bbox is an unclipped shading: it floods the visible
        # page, so it bounds nothing and must not be treated as a rectangle.
        boxes.append(vector.get("rect"))

    return boxes


def _ink_box(pdf, page, page_number: int, file: str, gs_path: str) -> tuple:
    """`(box, measured)` — the scanned page's ink extent, in page space.

    `measured` says the ink path ANSWERED: a scan whose raster was read and
    carries no marks is a blank page, and must not fall through to the union
    of its placements — that union is the scan's own rectangle, i.e. the whole
    page, which would report a crop that crops nothing. `measured` is False
    only when this is not a scan at all, or when the raster could not be read,
    where falling back to the placements is the honest degradation.

    The stencil is `mrc.segment`'s — the shipped one, with its pictorial
    exclusion and its measured window — and the specks it drops are
    `enhance_scan.find_specks`', with the same three conditions. Neither is
    re-derived here: a second opinion about what counts as ink would let the
    crop and the scan enhancement disagree about the same page.
    """
    import numpy as np

    from engine import mrc
    from engine.enhance_scan import SEGMENT_K, find_specks

    candidate, _reason = mrc._classify_page(pdf, page, page_number)
    if candidate is None:
        return None, False
    image = mrc._lift_image(pdf, page, candidate)
    if image is None:
        try:
            image = mrc._rasterize_placement(file, candidate, page, gs_path)
        except Exception:
            return None, False
    gray = np.asarray(image.convert("L"), dtype=np.uint8)
    if gray.size == 0:
        return None, False
    ink, pictorial, stats = mrc.segment(gray, dpi=candidate.source_dpi, k=SEGMENT_K)
    specks, _count = find_specks(
        gray, pictorial, int(stats["window"]), dpi=candidate.source_dpi
    )
    # A photograph is content even where it is not ink-dark, so the pictorial
    # mask rejoins the extent; only the specks come out.
    marks = (ink | pictorial) & ~specks
    if not marks.any():
        return None, True
    rows = np.any(marks, axis=1)
    cols = np.any(marks, axis=0)
    top = int(np.argmax(rows))
    bottom = int(len(rows) - np.argmax(rows[::-1]))
    left = int(np.argmax(cols))
    right = int(len(cols) - np.argmax(cols[::-1]))

    # Image pixels back into page space through the placement's own rectangle:
    # the classifier already refused a rotated or skewed placement, so the map
    # is a scale plus a translation, and the image's y grows DOWNWARD.
    rx0, ry0, rx1, ry1 = candidate.rect
    h, w = marks.shape
    sx = (rx1 - rx0) / float(w)
    sy = (ry1 - ry0) / float(h)
    return (rx0 + left * sx, ry1 - bottom * sy, rx0 + right * sx, ry1 - top * sy), True


def page_content_box(pdf, page, page_number: int, file: str, gs_path: str = "gs") -> tuple:
    """`(box, source)` for one page — `box` is None when the page draws nothing.

    `source` names which measurement answered: ``ink`` for a scan, ``content``
    for a born-digital page.
    """
    ink, measured = _ink_box(pdf, page, page_number, file, gs_path)
    if measured:
        return ink, "ink"
    return _union(_drawn_boxes(pdf, page) + _annotation_boxes(page)), "content"


def content_crop(
    file: str,
    output: str,
    box: str = "crop",
    margin: float = 0.0,
    pages: list | None = None,
    preview: bool = False,
    gs_path: str = "gs",
) -> dict:
    """Crop a page box to each page's own content.

    Args:
        box: one of crop/bleed/trim/art — the box to write.
        margin: points of paper to keep around the content, on all four edges.
        pages: 1-based page numbers; None = all, [] = none (the empty selection
            never widens to all — `set_page_boxes`' convention).
        preview: measure and report without writing anything.
        gs_path: Ghostscript, for a scan whose codestream cannot be decoded
            in-process.
    """
    key = box_key(box)
    try:
        keep = float(margin)
    except (TypeError, ValueError):
        raise ValueError(f"margin must be a number, got {margin!r}")
    if keep < 0:
        raise ValueError("margin must be zero or more points")

    wanted = None if pages is None else {int(p) for p in pages}

    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve() if not preview else False

    changed = 0
    measured: list[dict] = []
    skipped: list[dict] = []
    with pikepdf.open(file) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            if wanted is not None and index not in wanted:
                continue
            media = effective_box(page, "/MediaBox")
            if media is None:
                skipped.append({"page": index, "reason": "no media box"})
                continue
            current = effective_box(page, key) or media
            content, source = page_content_box(pdf, page, index, file, gs_path)
            if content is None:
                skipped.append({"page": index, "reason": "the page has no content to crop to"})
                continue
            nx0 = max(content[0] - keep, current[0])
            ny0 = max(content[1] - keep, current[1])
            nx1 = min(content[2] + keep, current[2])
            ny1 = min(content[3] + keep, current[3])
            if nx1 - nx0 < MIN_EXTENT or ny1 - ny0 < MIN_EXTENT:
                skipped.append({"page": index, "reason": "resulting box is degenerate"})
                continue
            measured.append(
                {
                    "page": index,
                    "source": source,
                    "box": [nx0, ny0, nx1, ny1],
                    "trimmed": {
                        "left": nx0 - current[0],
                        "bottom": ny0 - current[1],
                        "right": current[2] - nx1,
                        "top": current[3] - ny1,
                    },
                }
            )
            if not preview:
                page.obj[key] = Array([nx0, ny0, nx1, ny1])
            changed += 1

        if changed == 0:
            raise ValueError("no page in the selection has content to crop to")

        if preview:
            return {
                "box": str(box).lower(),
                "margin": keep,
                "changed": changed,
                "pages": measured,
                "skipped": skipped,
                "preview": True,
            }

        if same_file:
            with tempfile.NamedTemporaryFile(
                suffix=".pdf", delete=False, dir=str(input_path.parent)
            ) as tmp:
                tmp_path = tmp.name
            save_pdf(pdf, tmp_path)
        else:
            save_pdf(pdf, output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {
        "output": str(output_path),
        "box": str(box).lower(),
        "margin": keep,
        "changed": changed,
        "pages": measured,
        "skipped": skipped,
        "preview": False,
    }
