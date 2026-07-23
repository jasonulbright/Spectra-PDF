"""Headers, footers, and Bates numbering (§ I.5 P5).

Stamps short text at up to six page positions (top/bottom × left/center/right)
across a page range, with token substitution — `{page}` (1-based page number),
`{pages}` (total), and `{bates}` (a zero-padded auto-incrementing counter, the
Bates-numbering primitive). Any surrounding literal text (a prefix/suffix, a
date the caller pre-formats) is drawn as-is.

Placement is rotation-aware: the text reads UPRIGHT at the requested VISUAL
corner regardless of the page's `/Rotate`, using `_display_to_user` to map a
displayed-space anchor back to the form's user space and the same rotate-
composed text matrix the watermark stamp uses. Non-Latin-1 text embeds a
subsetted Unicode font (the S4 machinery); a pure-Latin-1 stamp uses standard-14
Helvetica/WinAnsi. Reuses watermark's colour/box/rotate/escaping helpers so the
two stampers can't drift.
"""

import math
import re
import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from engine.pdf_metrics import (
    GLYPH_HEIGHT_EM as _GLYPH_HEIGHT_EM,
    flatten_control_chars as _flatten_control_chars,
    text_width_em as _text_width_em,
)
from engine.watermark import (
    _escape_pdf_text,
    _face_glyph_height_em,
    _n,
    _parse_color,
    _resolve_box,
    _resolve_rotate,
    _unicode_watermark_face,
)

_POSITIONS = ("tl", "tc", "tr", "bl", "bc", "br")
_MIN_FONT_SIZE = 4.0


def _display_dims(width: float, height: float, rotate: int) -> tuple[float, float]:
    """The page's DISPLAYED width/height (the axes swap at 90/270)."""
    return (height, width) if rotate in (90, 270) else (width, height)


def _display_to_user(dx: float, dy: float, width: float, height: float, rotate: int):
    """Map a point in DISPLAYED space (origin bottom-left of the on-screen page,
    dims from `_display_dims`) to the form's user space [0,W]×[0,H].

    A viewer rotates the page CLOCKWISE by `/Rotate`; the inverse (displayed →
    user) is a COUNTER-clockwise rotation by the same angle about the two boxes'
    centres. Verified per corner in the tests (e.g. R=90 maps displayed
    bottom-left → user bottom-RIGHT)."""
    dw, dh = _display_dims(width, height, rotate)
    xr, yr = dx - dw / 2.0, dy - dh / 2.0
    rad = math.radians(rotate % 360)
    c, s = math.cos(rad), math.sin(rad)
    ux = xr * c - yr * s + width / 2.0
    uy = xr * s + yr * c + height / 2.0
    return ux, uy


def _bates_value(text: str, start: int, digits: int, index: int) -> str:
    n = start + index
    return f"{n:0{max(1, int(digits))}d}"


def _substitute(text: str, page_no: int, total: int, bates: str) -> str:
    return (
        text.replace("{page}", str(page_no))
        .replace("{pages}", str(total))
        .replace("{bates}", bates)
    )


def _anchor(position: str, text_w: float, size: float, dw: float, dh: float, margin: float):
    """(baseline-start x, y) in DISPLAYED space for `position`. Horizontal
    alignment uses the text width; vertical uses a cap-height inset at the top
    and the margin at the bottom (baseline)."""
    cap = size * _GLYPH_HEIGHT_EM
    if position[1] == "l":
        dx = margin
    elif position[1] == "c":
        dx = (dw - text_w) / 2.0
    else:  # "r"
        dx = dw - margin - text_w
    dx = max(margin if position[1] != "c" else 0.0, dx)
    if position[0] == "t":
        dy = dh - margin - cap
    else:  # bottom — baseline sits `margin` above the edge
        dy = margin
    return dx, dy


def add_header_footer(
    file: str,
    output: str,
    placements: list[dict],
    first_page: int = 1,
    last_page: int | None = None,
    font_size: float = 10.0,
    margin: float = 24.0,
    color: str = "#000000",
    bates_start: int = 1,
    bates_digits: int = 6,
    font_dir: str = "",
) -> dict:
    """Stamp header/footer/Bates text across a page range.

    Args:
        placements: [{position: one of tl/tc/tr/bl/bc/br, text: str}]. `text`
            may contain {page}, {pages}, {bates}.
        first_page/last_page: 1-based inclusive range (last_page None = end).
        font_size: points (fixed; > 0).
        margin: inset from the page edges, points.
        color: #rrggbb.
        bates_start/bates_digits: the {bates} counter's first value and zero-pad
            width; the counter increments once per STAMPED page.
        font_dir: bundled fallback-fonts dir for non-Latin-1 text (S4). Empty →
            Latin-1 only ('?' for anything past it, matching watermark).
    """
    if not placements:
        raise ValueError("at least one placement is required")
    for pl in placements:
        pos = str(pl.get("position", ""))
        if pos not in _POSITIONS:
            raise ValueError(f"position must be one of {_POSITIONS}, got {pos!r}")
    size = float(font_size)
    if size < _MIN_FONT_SIZE:
        raise ValueError(f"font_size must be >= {_MIN_FONT_SIZE}")
    rgb = _parse_color(color)
    r, g, b = rgb

    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    stamped = 0
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        lo = max(1, int(first_page))
        hi = total if last_page is None else min(total, int(last_page))

        # Resolve the Unicode face ONCE if any placement text (post-substitution
        # can only shrink the character set for {page}/{pages}/{bates}, which are
        # ASCII) has a non-Latin-1 char in its literal parts. Build the embedded
        # font lazily per (page, distinct string) — headers vary per page, so
        # unlike the watermark we can't share one font object across pages.
        literal = "".join(str(pl.get("text", "")) for pl in placements)
        needs_unicode = False
        face = ""
        try:
            literal.encode("latin-1")
        except UnicodeEncodeError:
            needs_unicode = True
            face = _unicode_watermark_face(font_dir)
            if not face:
                raise ValueError(
                    "text contains characters outside Latin-1 and no fallback font "
                    "is available"
                )

        glyph_h = _face_glyph_height_em(face) if needs_unicode else _GLYPH_HEIGHT_EM

        bates_index = 0
        for index, page in enumerate(pdf.pages, start=1):
            if index < lo or index > hi:
                continue
            rotate = _resolve_rotate(page)
            x0, y0, x1, y1 = _resolve_box(page)
            width, height = x1 - x0, y1 - y0
            if width <= 0 or height <= 0:
                continue
            dw, dh = _display_dims(width, height, rotate)
            bates = _bates_value("", bates_start, bates_digits, bates_index)

            drew_any = False
            for pl in placements:
                raw = _substitute(str(pl.get("text", "")), index, total, bates)
                draw = _flatten_control_chars(raw, keep_newline=False)
                if draw == "":
                    continue
                form = _stamp_form(
                    pdf, draw, pl["position"], size, (r, g, b),
                    width, height, dw, dh, rotate, margin, glyph_h,
                    face if needs_unicode else "",
                )
                if form is not None:
                    page.add_overlay(form, pikepdf.Rectangle(x0, y0, x1, y1))
                    drew_any = True
            if drew_any:
                stamped += 1
            bates_index += 1

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

    return {"output": str(output_path), "pages_stamped": stamped}


def _stamp_form(
    pdf, text, position, size, rgb, width, height, dw, dh, rotate, margin, glyph_h, face
):
    """A form XObject drawing `text` at `position`, upright in the displayed
    orientation. `face` non-empty → embed a subsetted Unicode font for it."""
    if face:
        from engine.font_fallback import build_fallback_font

        font_obj, encode, width_1000 = build_fallback_font(pdf, face, text)
        em_width = width_1000(text) / 1000.0
        show = b"<" + encode(text).hex().encode("ascii") + b"> Tj"
    else:
        em_width = _text_width_em(text)
        show = b"(" + _escape_pdf_text(text).encode("latin-1") + b") Tj"
        font_obj = pdf.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
                       Encoding=Name.WinAnsiEncoding))
    text_w = em_width * size
    dx, dy = _anchor(position, text_w, size, dw, dh, margin)
    ux, uy = _display_to_user(dx, dy, width, height, rotate)
    rad = math.radians(rotate % 360)
    c, s = math.cos(rad), math.sin(rad)
    r, g, b = rgb
    content = (
        f"q {_n(r)} {_n(g)} {_n(b)} rg BT /F0 {_n(size)} Tf "
        f"{_n(c)} {_n(s)} {_n(-s)} {_n(c)} {_n(ux)} {_n(uy)} Tm "
    ).encode("latin-1") + show + b" ET Q"
    form = pdf.make_stream(content)
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.FormType = 1
    form.BBox = pikepdf.Array([0, 0, width, height])
    form.Resources = Dictionary(Font=Dictionary(F0=font_obj))
    return form
