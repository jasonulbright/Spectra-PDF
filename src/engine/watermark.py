"""Text watermark: stamp translucent text across pages.

Approach (per page): author a small Form XObject carrying the text ops and
its OWN private /Resources (standard-14 Helvetica + an /ExtGState with the
requested alpha), then attach it with pikepdf's ``Page.add_overlay`` /
``add_underlay``. Using the library's overlay API instead of hand-editing
``page.Contents`` sidesteps two traps the redaction review taught us:

  - **Inherited /Resources** — assigning ``page.Resources`` to register a
    font would SHADOW a resources dict inherited from an ancestor /Pages
    node (the same generator pattern ``redact._resolve_resources`` walks the
    /Parent chain for). The form carries its font privately, so the page's
    resource dict only ever gains the collision-safely-named form itself.
  - **Unbalanced graphics state** — add_overlay q/Q-shields the stamp from
    whatever state the existing content leaves dangling.

The overlay ``rect`` is passed explicitly as the page's crop box and the
form's BBox has identical dimensions, so add_overlay's fit-scale is exactly
1 — no surprise auto-scaling.

Rotation: viewers apply /Rotate clockwise, and a text matrix rotates
counter-clockwise in user space, so text meant to read at ``angle``° in the
DISPLAYED orientation is drawn at ``angle + /Rotate`` about the crop-box
center (the center is rotation-invariant, so centering needs no correction).
/Rotate and the crop/media boxes are inheritable page attributes — resolved
via pdf_tree.walk_inheritable, the one shared /Parent-chain walk that
redact's resource lookup also uses (one implementation, so a fix propagates
to every consumer).

Deliberately NOT Ghostscript (the roadmap row offers both): a gs pdfwrite
round-trip regenerates the whole file to add one stream per page, and
GS-backed ops don't run in dev until the bundle script has been run. See
docs/architecture/07-phase2e-watermark.md.
"""

import math
import re
import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from engine.pdf_tree import walk_inheritable


# Helvetica metrics moved to pdf_metrics.py (shared with forms.py — Phase 2l);
# the aliases below keep this module's call sites and tests unchanged.
from engine.pdf_metrics import (
    GLYPH_HEIGHT_EM as _GLYPH_HEIGHT_EM,
    HELVETICA_ASCII_WIDTHS as _HELVETICA_ASCII_WIDTHS,
    NON_ASCII_ADVANCE_EM as _NON_ASCII_ADVANCE_EM,
    text_width_em as _text_width_em,
)

MIN_AUTO_FONT_SIZE = 8.0
MAX_AUTO_FONT_SIZE = 144.0
# Fraction of the box's crossing length (along the text direction) the
# auto-sized text should span.
AUTO_FIT_FRACTION = 0.65


def _parse_color(color: str) -> tuple[float, float, float]:
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", color.strip())
    if not m:
        raise ValueError(f"color must be #rrggbb, got: {color!r}")
    v = int(m.group(1), 16)
    return ((v >> 16 & 0xFF) / 255.0, (v >> 8 & 0xFF) / 255.0, (v & 0xFF) / 255.0)


def _escape_pdf_text(text: str) -> str:
    """Best-effort WinAnsi, matching the frontend's appearance streams:
    escape the literal-string specials, map anything past Latin-1 to '?'."""
    out = []
    for ch in text:
        code = ord(ch)
        if ch in ("(", ")", "\\"):
            out.append("\\" + ch)
        elif 32 <= code <= 255:
            out.append(ch)
        else:
            out.append("?")
    return "".join(out)


def _resolve_rotate(page: pikepdf.Page) -> int:
    """/Rotate is inheritable — resolved via the page-tree walk shared with
    redact (pdf_tree.walk_inheritable); page.obj.get alone would misread
    files that hoist it onto an ancestor /Pages node."""
    value = walk_inheritable(page, "/Rotate")
    rotate = int(value) if value is not None else 0
    return ((rotate % 360) + 360) % 360


def _resolve_box(page: pikepdf.Page) -> tuple[float, float, float, float]:
    """The page's crop box (fall back to media box), inheritance-aware,
    normalized to (x0, y0, x1, y1) with x0<x1, y0<y1."""
    box = walk_inheritable(page, "/CropBox")
    if box is None:
        box = walk_inheritable(page, "/MediaBox")
    if box is None:
        raise ValueError("page has no /CropBox or /MediaBox anywhere in its page tree")
    x0, y0, x1, y1 = (float(box[i]) for i in range(4))
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _auto_font_size(text: str, width: float, height: float, rotate: int, angle: float) -> float:
    """Size the text so that BOTH of its axes fit the box.

    Baseline axis: span ~AUTO_FIT_FRACTION of the box's crossing length along
    the text direction — the length of a line through the box center at that
    angle, min(W/|cos|, H/|sin|). NOT the projection extent (W|cos| + H|sin|):
    a centered segment sized to the projection can poke far outside the box
    (dramatically so for wide-short pages) — the overflow the e2e caught.

    Glyph-height axis: the SAME bound rotated 90° — near axis-aligned angles
    the baseline crossing degenerates to inf on one term and stops seeing the
    box dimension PERPENDICULAR to the text run entirely, so a banner-shaped
    box (say 1500×10 at angle 0) would get a size independent of its height
    and clip vertically (review-caught). The perpendicular crossing is
    min(W/|sin|, H/|cos|); the text's vertical extent (ascender+descender)
    must fit the same fraction of it.

    A centered fraction < 1 of each crossing keeps that axis inside the box
    by construction. width/height are user-space crop dims; the DISPLAYED
    dims swap when /Rotate is 90 or 270. MIN_AUTO_FONT_SIZE is a legibility
    floor and wins below it (a box thinner than ~12pt clips rather than
    rendering unreadable dust)."""
    disp_w, disp_h = (height, width) if rotate in (90, 270) else (width, height)
    theta = math.radians(angle)
    cos_a, sin_a = abs(math.cos(theta)), abs(math.sin(theta))
    baseline_crossing = min(
        disp_w / cos_a if cos_a > 1e-9 else math.inf,
        disp_h / sin_a if sin_a > 1e-9 else math.inf,
    )
    perp_crossing = min(
        disp_w / sin_a if sin_a > 1e-9 else math.inf,
        disp_h / cos_a if cos_a > 1e-9 else math.inf,
    )
    advance = max(_text_width_em(text), 0.1)
    fit = min(
        AUTO_FIT_FRACTION * baseline_crossing / advance,
        AUTO_FIT_FRACTION * perp_crossing / _GLYPH_HEIGHT_EM,
    )
    return max(MIN_AUTO_FONT_SIZE, min(MAX_AUTO_FONT_SIZE, fit))


def _n(v: float) -> str:
    """Compact stable numeric formatting for content-stream operands."""
    return f"{v:.4f}".rstrip("0").rstrip(".") or "0"


def _make_watermark_form(
    pdf: pikepdf.Pdf,
    text: str,
    size: float,
    rgb: tuple[float, float, float],
    opacity: float,
    theta: float,
    width: float,
    height: float,
) -> pikepdf.Object:
    """Form XObject with the stamp drawn about the center of a [0 0 W H] box,
    baseline direction rotated by theta (radians, user space)."""
    cx, cy = width / 2.0, height / 2.0
    est_width = _text_width_em(text) * size
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    # Start of the baseline: back from center by half the text width along
    # the baseline direction, and down by ~half the cap height along the
    # rotated up-vector so the text is vertically centered too.
    tx = cx - (est_width / 2.0) * cos_t + (0.35 * size) * sin_t
    ty = cy - (est_width / 2.0) * sin_t - (0.35 * size) * cos_t
    r, g, b = rgb
    content = (
        f"q /GS0 gs {_n(r)} {_n(g)} {_n(b)} rg "
        f"BT /F0 {_n(size)} Tf "
        f"{_n(cos_t)} {_n(sin_t)} {_n(-sin_t)} {_n(cos_t)} {_n(tx)} {_n(ty)} Tm "
        f"({_escape_pdf_text(text)}) Tj ET Q"
    ).encode("latin-1")

    font = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name.Helvetica,
            Encoding=Name.WinAnsiEncoding,
        )
    )
    gs = pdf.make_indirect(Dictionary(Type=Name.ExtGState, ca=opacity, CA=opacity))
    form = pdf.make_stream(content)
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.FormType = 1
    form.BBox = pikepdf.Array([0, 0, width, height])
    form.Resources = Dictionary(
        Font=Dictionary(F0=font),
        ExtGState=Dictionary(GS0=gs),
    )
    return form


def watermark(
    file: str,
    output: str,
    text: str,
    opacity: float = 0.15,
    angle: float = 45.0,
    color: str = "#808080",
    font_size: float = 0.0,
    layer: str = "over",
    pages: list | None = None,
) -> dict:
    """Stamp translucent text across pages.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal ``file`` for in-place).
        text: Watermark text. Latin-1 best-effort (WinAnsi Helvetica).
        opacity: Fill/stroke alpha, 0 < opacity <= 1.
        angle: Degrees counter-clockwise in the page's DISPLAYED orientation
            (45 = classic diagonal).
        color: ``#rrggbb``.
        font_size: Points; 0 auto-fits per page (~65% of the displayed
            extent along the text direction).
        layer: ``"over"`` (default — survives scans/opaque fills) or
            ``"under"`` (classic behind-the-text watermark).
        pages: 1-based page numbers; None = all pages, an explicit empty
            list = ZERO pages (matching rotate.py's convention — an empty
            selection must never silently widen to the whole document; the
            CLI's --pages parse rejects garbage for the same reason).
            Out-of-range entries are ignored (same convention as redact).
    """
    if not text or not text.strip():
        raise ValueError("watermark text must not be empty")
    if not 0 < float(opacity) <= 1:
        raise ValueError(f"opacity must be in (0, 1], got {opacity}")
    if layer not in ("over", "under"):
        raise ValueError(f'layer must be "over" or "under", got {layer!r}')
    rgb = _parse_color(color)

    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    wanted: set[int] | None = None
    if pages is not None:
        wanted = {int(p) for p in pages}

    pages_watermarked = 0
    font_size_applied = 0.0
    with pikepdf.open(file) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            if wanted is not None and index not in wanted:
                continue
            rotate = _resolve_rotate(page)
            x0, y0, x1, y1 = _resolve_box(page)
            width, height = x1 - x0, y1 - y0
            if width <= 0 or height <= 0:
                continue
            size = float(font_size) if float(font_size) > 0 else _auto_font_size(
                text, width, height, rotate, angle
            )
            # Drawn angle composes the requested display angle with /Rotate —
            # viewers rotate the page clockwise by /Rotate, the text matrix
            # rotates counter-clockwise, so they add.
            theta = math.radians(angle + rotate)
            form = _make_watermark_form(pdf, text, size, rgb, float(opacity), theta, width, height)
            rect = pikepdf.Rectangle(x0, y0, x1, y1)
            if layer == "over":
                page.add_overlay(form, rect)
            else:
                page.add_underlay(form, rect)
            if pages_watermarked == 0:
                font_size_applied = size
            pages_watermarked += 1

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
        "pages_watermarked": pages_watermarked,
        "font_size_applied": round(font_size_applied, 2),
        "layer": layer,
    }
