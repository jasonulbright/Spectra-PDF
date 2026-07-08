"""True content redaction: strip text and images under a region from the
actual content stream, then paint a black box over it — not just an overlay.

Approach (per page, per requested region):
  1. Walk the page's content stream, tracking the graphics state (CTM via
     q/Q/cm) and text state (Tm/Td/Tf via BT..ET) closely enough to compute
     an approximate axis-aligned bounding box for every text-showing
     operator (Tj/TJ/'/") and every directly-placed raster image (Do).
     Text width is estimated the same way the frontend's own annotation
     appearance-stream writer does (~0.5em average advance) — pikepdf has no
     font-metrics API, and exact glyph widths aren't needed for redaction:
     over-including a sliver of intersecting text and dropping the whole
     instruction is the SAFE direction here (a false negative — text that
     should have been redacted but wasn't — is the dangerous failure mode
     for a redaction tool; a false positive just removes slightly more than
     asked).
  2. Any instruction whose bbox intersects ANY requested region on that page
     is dropped entirely from the rebuilt stream (not blanked, not made
     invisible — removed from the instruction list that gets re-serialized).
  3. A black-filled rectangle is painted over each region on top of the
     rebuilt content, so the redaction is visually obvious even where no
     text/image actually needed stripping.
  4. `page.remove_unreferenced_resources()` drops the now-orphaned image
     XObject resource entries so their bytes aren't just invisible but
     genuinely absent from the saved file.

Known limitations (by design, for this first slice):
  - Does not descend into Form XObjects or nested content streams — only
    page-level content and directly-placed raster images are inspected.
    A Form XObject's `Do` call is never stripped, even if its bbox
    intersects a region, to avoid destroying unrelated content packed into
    the same form.
  - Text position tracking ignores `T*`/leading and treats `'`/`"` like a
    plain `Tj` (does not model their implicit next-line move). Multi-line
    text laid out via explicit `Td`/`Tm` per line (the common case) tracks
    correctly; text relying on `TL`/`T*` leading can drift.
  - Does not touch annotations (a FreeText/Popup with visible text inside a
    redacted region survives) — content-stream + raster images only.
"""

import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Name

Matrix = tuple[float, float, float, float, float, float]
Rect = tuple[float, float, float, float]  # x0, y0, x1, y1, x0<x1, y0<y1

IDENTITY: Matrix = (1, 0, 0, 1, 0, 0)

# Rough Helvetica-ish average glyph advance, matching the heuristic already
# used for wrapping freetext/stamp appearance text in the frontend builder.
AVG_CHAR_ADVANCE_EM = 0.5


def _mat_mult(m1: Matrix, m2: Matrix) -> Matrix:
    """Compose two matrices for the convention p' = p * M: applying m1 then
    m2 to a point is equivalent to applying `_mat_mult(m1, m2)` once."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def _transform_point(m: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def _bbox_of_rect_under_matrix(m: Matrix, w: float, h: float) -> Rect:
    corners = [_transform_point(m, x, y) for x, y in ((0, 0), (w, 0), (w, h), (0, h))]
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    return (min(xs), min(ys), max(xs), max(ys))


def _normalize_rect(rect: list[float]) -> Rect:
    x0, y0, x1, y1 = rect
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _intersects(a: Rect, b: Rect) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _intersects_any(bbox: Rect, regions: list[Rect]) -> bool:
    return any(_intersects(bbox, r) for r in regions)


def _text_show_strings(operator: str, operands: list) -> list[str]:
    """Extract the literal string operands of a text-showing operator, for a
    rough width estimate. TJ's array mixes strings and numeric kerning."""
    if operator in ("Tj", "'"):
        return [str(operands[-1])]
    if operator == '"':
        return [str(operands[-1])]
    if operator == "TJ":
        arr = operands[0]
        return [str(el) for el in arr if not isinstance(el, (int, float))]
    return []


def _resolve_resources(page: "pikepdf.Page"):
    """Resources are inheritable via the page tree — a page dict lacking its
    own /Resources takes it from the nearest ancestor /Pages node that has
    one (common output from generators that put a single shared /Resources
    on the /Pages node rather than duplicating it per page). `page.get` only
    ever sees the page's OWN dict, so relying on it alone silently treats
    such a page as having no XObjects at all — a false negative (an image
    that should have been redacted, wasn't), the one failure direction this
    module can't tolerate."""
    node = page.obj
    seen = 0
    while node is not None and seen < 64:
        if "/Resources" in node:
            return node.Resources
        node = node.get("/Parent")
        seen += 1
    return {}


def _redact_page(pdf: "pikepdf.Pdf", page: "pikepdf.Page", regions: list[Rect]) -> dict:
    instructions = pikepdf.parse_content_stream(page)
    resources = _resolve_resources(page)

    ctm: Matrix = IDENTITY
    ctm_stack: list[Matrix] = []
    tm: Matrix = IDENTITY
    tlm: Matrix = IDENTITY
    font_size = 12.0

    kept = []
    text_runs_removed = 0
    images_removed = 0
    removed_xobject_names: set[str] = set()

    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)

        if operator == "q":
            ctm_stack.append(ctm)
            kept.append(instruction)
        elif operator == "Q":
            if ctm_stack:
                ctm = ctm_stack.pop()
            kept.append(instruction)
        elif operator == "cm":
            m = tuple(float(v) for v in operands)  # type: ignore[assignment]
            ctm = _mat_mult(m, ctm)
            kept.append(instruction)
        elif operator == "Tf":
            try:
                font_size = float(operands[-1])
            except (TypeError, ValueError, IndexError):
                pass
            kept.append(instruction)
        elif operator == "BT":
            tm = IDENTITY
            tlm = IDENTITY
            kept.append(instruction)
        elif operator in ("Td", "TD"):
            tx, ty = float(operands[0]), float(operands[1])
            tlm = _mat_mult((1, 0, 0, 1, tx, ty), tlm)
            tm = tlm
            kept.append(instruction)
        elif operator == "Tm":
            m = tuple(float(v) for v in operands)  # type: ignore[assignment]
            tm = m
            tlm = m
            kept.append(instruction)
        elif operator in ("Tj", "'", '"', "TJ"):
            strings = _text_show_strings(operator, operands)
            est_width = sum(len(s) for s in strings) * font_size * AVG_CHAR_ADVANCE_EM
            combined = _mat_mult(tm, ctm)
            bbox = _bbox_of_rect_under_matrix(combined, max(est_width, 0.01), max(font_size, 0.01))
            if _intersects_any(bbox, regions):
                text_runs_removed += 1
            else:
                kept.append(instruction)
            # Advance the text matrix so subsequent same-line Tj/TJ calls
            # (common when a generator emits one call per word/run) don't
            # all collapse onto the same origin point.
            tm = _mat_mult((1, 0, 0, 1, est_width, 0), tm)
        elif operator == "Do":
            name = str(operands[0]) if operands else None
            xobj_dict = resources.get("/XObject", {}) if name else {}
            xobj = xobj_dict.get(Name(name)) if name else None
            subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""
            if xobj is not None and subtype == "/Image":
                bbox = _bbox_of_rect_under_matrix(ctm, 1.0, 1.0)
                if _intersects_any(bbox, regions):
                    images_removed += 1
                    if name:
                        removed_xobject_names.add(name)
                else:
                    kept.append(instruction)
            else:
                # Form XObjects (and anything unrecognized) pass through
                # untouched — see module docstring's known limitations.
                kept.append(instruction)
        else:
            kept.append(instruction)

    new_bytes = pikepdf.unparse_content_stream(kept)
    overlay = b"".join(
        f"q 0 0 0 rg {r[0]} {r[1]} {r[2] - r[0]} {r[3] - r[1]} re f Q\n".encode("ascii")
        for r in regions
    )
    page.Contents = pdf.make_stream(new_bytes + b"\n" + overlay)

    if removed_xobject_names:
        page.remove_unreferenced_resources()

    return {
        "text_runs_removed": text_runs_removed,
        "images_removed": images_removed,
    }


def redact(file: str, output: str, regions: list[dict]) -> dict:
    """Strip content under one or more rectangular regions and black them out.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        regions: List of `{"page": <1-based int>, "rect": [x0, y0, x1, y1]}`,
            rect in the page's own /MediaBox point space (i.e. the same
            coordinate system the page's content stream already uses —
            callers are responsible for accounting for /Rotate themselves).
    """
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    by_page: dict[int, list[Rect]] = {}
    for region in regions:
        page_num = int(region["page"])
        by_page.setdefault(page_num, []).append(_normalize_rect(region["rect"]))

    stats = {"text_runs_removed": 0, "images_removed": 0}
    pages_redacted = 0
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        for page_num, rects in by_page.items():
            if not (1 <= page_num <= total):
                continue
            page_stats = _redact_page(pdf, pdf.pages[page_num - 1], rects)
            stats["text_runs_removed"] += page_stats["text_runs_removed"]
            stats["images_removed"] += page_stats["images_removed"]
            pages_redacted += 1

        if same_file:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, dir=str(input_path.parent)) as tmp:
                tmp_path = tmp.name
            pdf.save(tmp_path)
        else:
            pdf.save(output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {
        "output": str(output_path),
        "pages_redacted": pages_redacted,
        "regions_applied": len(regions),
        **stats,
    }
