"""One vertical text block, as content-stream BYTES.

The sibling of `rtl_text` for the other axis, and for the same two callers:
the watermark stamp and the form-field appearance both assemble appearance
streams by hand rather than through pikepdf instructions, and both need
exactly the same four things to lay a column down — the writing frame, the
face, the column break rule and the anchor untranspose.

Nothing here decides any of those. The frame and the column direction come
from `text_authoring.resolve_writing`, the face from
`text_authoring.vertical_face`, the breaks from `text_authoring.wrap_text`
and the untranspose from `text_paragraphs._t_inv` — the same four the
authored box runs through, so a stamp, a field and an authored box cannot
disagree about what a column is. What this module owns is the byte
emission, which is the one thing the instruction-based emitters cannot
share.

Two legal vertical representations, and `upright` says which one a face
took: an `/Identity-V` embed of the face's own vertical forms, whose CMap
advances the pen down the page (the CJK majority), or a HORIZONTAL shaped
subset drawn under a quarter-turn `Tm` (the Mongolian family, whose faces
state no vertical advance worth embedding as `/W2`). `glyph_lin` is that
difference and is the only linear part a caller ever writes.

The contract a caller must honour: `text` is the DRAWN text with layout
controls already flattened, and columns are wrapped through `wrap` rather
than by hand — a column broken anywhere else breaks the kinsoku rule the
reflow would re-apply.
"""

from engine.text_authoring import (
    _LEADING_EM,
    frame_rect,
    resolve_writing,
    vertical_face,
    wrap_text,
)
from engine.text_paragraphs import _t, _t_inv

#: The column pitch, in em — the authored box's leading, so a stamp and a
#: box put their columns the same distance apart.
LEADING_EM = _LEADING_EM


def _n(v: float) -> str:
    """Compact stable numeric formatting for content-stream operands."""
    return f"{v:.4f}".rstrip("0").rstrip(".") or "0"


class VerticalText:
    """A body of vertical text over ONE face, measurable and drawable.

    Built once for the whole value so a single subset carries every glyph
    any column will draw, then asked for each column's advance and show
    bytes. `advance_em` is the column's LENGTH along the reading axis — for
    an upright column that is the sum of the face's own `/W2` advances,
    which is the number the viewer will actually walk down the page.
    """

    __slots__ = (
        "font_obj", "face", "columns", "upright", "wframe", "glyph_lin",
        "_width_1000", "_show", "_cross", "_mid",
    )

    def __init__(self, pdf, face: str, text: str, wframe, columns: str, upright: bool):
        self.face = face
        self.wframe = wframe
        self.columns = columns
        self.upright = upright
        if upright:
            from engine.font_fallback import build_vertical_font

            font_obj, encode, width_1000 = build_vertical_font(pdf, face, text)
            self.font_obj = font_obj
            self._width_1000 = width_1000

            def show(line: str, _size: float = 1.0, _e=encode) -> bytes:
                return b"<" + _e(line).hex().encode("ascii") + b"> Tj"

            self._show = show
            # The /W2 advances are stated against the em square, so an
            # upright column's pitch IS one em with nothing to measure.
            self._cross = 1.0
            self._mid = 0.0
            self.glyph_lin = (1, 0, 0, 1)
            return
        # Horizontal glyphs laid down a column: the quarter turn is what
        # makes them a column, and the advance is the ordinary horizontal
        # one because that is the axis the turned pen walks.
        from engine import rtl_text
        from engine.font_fallback import build_fallback_font

        built = rtl_text.build(pdf, face, text)
        if built is not None:
            self.font_obj = built.font_obj
            self._width_1000 = built.width_1000
            self._show = built.show
        else:
            font_obj, encode, width_1000 = build_fallback_font(pdf, face, text)
            self.font_obj = font_obj
            self._width_1000 = width_1000

            def show(line: str, _size: float = 1.0, _e=encode) -> bytes:
                return b"<" + _e(line).hex().encode("ascii") + b"> Tj"

            self._show = show
        self._cross, self._mid = _face_vmetrics(face)
        self.glyph_lin = (0, -1, 1, 0)

    # -- measure ----------------------------------------------------------
    def advance_em(self, column: str) -> float:
        """How far down the reading axis `column` runs, in em."""
        return self._width_1000(column) / 1000.0

    @property
    def cross_em(self) -> float:
        """The extent ACROSS one column, in em."""
        return self._cross

    @property
    def cross_offset_em(self) -> float:
        """Where the pen sits relative to the column's own centre line, in
        em — what a caller adds to `across` to centre the drawn body.

        An upright column's pen IS its centre: `/W2`'s position vector puts
        the vertical origin at the glyph's horizontal middle. A turned
        column's pen is on the glyph BASELINE instead, so the body centres
        by moving against the glyphs' own up direction, which is read off
        the linear part rather than assumed."""
        if self.upright:
            return 0.0
        up_across = _t(self.wframe, self.glyph_lin[2], self.glyph_lin[3])[1]
        return -up_across * self._mid

    def wrap(self, text: str, size: float, max_length: float) -> list[str]:
        """`text` broken into columns no longer than `max_length` points."""
        return wrap_text(text, self._width_1000, size, max_length)

    # -- place ------------------------------------------------------------
    def box(self, x0: float, y0: float, x1: float, y1: float) -> tuple:
        """A page-space rect in the writing frame: (left, right, top,
        bottom), where left→right is the READING axis and top→bottom the
        column-stacking one. The single boundary into the frame."""
        return frame_rect(self.wframe, x0, y0, x1, y1)

    def anchor(self, along: float, across: float) -> tuple[float, float]:
        """The page-space pen for a point in the writing frame — `along` on
        the reading axis, `across` on the column-stacking one.

        The single boundary out of the frame. Everything above it is
        direction-agnostic and everything below it is page geometry."""
        return _t_inv(self.wframe, along, across)

    def matrix(self, along: float, across: float) -> bytes:
        """The `Tm` placing a column's first glyph at that frame point."""
        tx, ty = self.anchor(along, across)
        a, b, c, d = self.glyph_lin
        return (
            f"{_n(a)} {_n(b)} {_n(c)} {_n(d)} {_n(tx)} {_n(ty)} Tm"
        ).encode("ascii")

    # -- emit -------------------------------------------------------------
    def show(self, column: str, size: float = 1.0) -> bytes:
        """The column's show operators. `size` scales a shaped mark's rise
        into the caller's text space, as `rtl_text.show` does."""
        return self._show(column, size)


def _face_vmetrics(face_path: str) -> tuple[float, float]:
    """(ascent-to-descent extent, baseline-to-body-middle) in em.

    The width a turned column occupies and where its baseline sits inside
    it. Any read failure falls back to one em on a centred baseline, which
    is the geometry the upright representation has; a column pitch is a
    layout heuristic and is never what makes the text correct."""
    from fontTools.ttLib import TTFont

    from engine.font_fallback import _font_metrics

    try:
        ttf = TTFont(face_path, fontNumber=0, lazy=True)
    except (OSError, ValueError, KeyError):
        return (1.0, 0.0)
    try:
        metrics = _font_metrics(ttf)
    except (OSError, ValueError, KeyError):
        return (1.0, 0.0)
    finally:
        ttf.close()
    ascent, descent = metrics["ascent"], metrics["descent"]
    return (
        max((ascent - descent) / 1000.0, 0.1),
        (ascent + descent) / 2000.0,
    )


def build(
    pdf,
    font_dir: str,
    text: str,
    writing_mode: str = "vertical",
    family=None,
    style: str = "regular",
) -> VerticalText:
    """A `VerticalText` for `text` in `writing_mode`.

    Refuses by name for a horizontal mode: a caller that reaches here has
    already decided the block is a column, and silently returning a
    horizontal builder would draw the line the caller asked not to draw.
    The column DIRECTION is derived from the text by the same evidence the
    re-listing uses, so a stamp and the paragraph that re-reads it cannot
    disagree about which way its columns run.
    """
    wframe, columns, vertical = resolve_writing(writing_mode, text)
    if not vertical:
        raise ValueError("this text block is not vertical")
    face, upright = vertical_face(font_dir, family, style, text, columns)
    return VerticalText(pdf, face, text, wframe, columns, upright)
