"""The ONE graphics/text-state machine for content-stream walkers (7.2).

Promised at Phase 7.1 ("one interpreter, two clients, no drift") and
delivered here at 7.2, exactly when text editing needed the text-state
half: redaction (`redact.py`), image editing (`page_images.py`), and text
editing all walk content streams tracking the same PDF graphics state —
CTM (q/Q/cm), text matrices (BT, Tm/Td/TD/T*), and text parameters
(Tf size + RESOURCE NAME, TL leading, Tz horizontal scale). Before this
module each walker re-derived the tracking; a divergence between them is
exactly the class of bug that edits the wrong thing.

The seam is deliberately narrow: `GraphicsTextState.feed()` consumes
STATE-BEARING operators and reports whether it did; every client keeps
its own control flow (what to keep, drop, rewrite, recurse) and handles
show/Do operators itself using the state's fields and helpers. Feeding
never rewrites — this is a tracker, not a transformer.

The no-drift proof is redact.py's full pytest suite running unchanged
against the refactored `_walk`: the security-critical client is the
regression harness for the seam.
"""

from typing import NamedTuple, Optional

Matrix = tuple[float, float, float, float, float, float]
Rect = tuple[float, float, float, float]

IDENTITY: Matrix = (1, 0, 0, 1, 0, 0)


def mat_mult(m1: Matrix, m2: Matrix) -> Matrix:
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


def transform_point(m: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def bbox_of_rect_under_matrix(m: Matrix, w: float, h: float) -> Rect:
    return bbox_of_corners_under_matrix(m, 0.0, 0.0, w, h)


def bbox_of_corners_under_matrix(
    m: Matrix, x0: float, y0: float, x1: float, y1: float
) -> Rect:
    pts = [
        transform_point(m, x0, y0),
        transform_point(m, x1, y0),
        transform_point(m, x0, y1),
        transform_point(m, x1, y1),
    ]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def as_matrix(arr) -> Optional[Matrix]:
    try:
        vals = [float(v) for v in arr]
    except (TypeError, ValueError):
        return None
    if len(vals) != 6:
        return None
    return (vals[0], vals[1], vals[2], vals[3], vals[4], vals[5])


class TextStateSnapshot(NamedTuple):
    """The text-state values a form inherits at its invoking Do."""

    font_size: float
    leading: float
    h_scale: float
    font_name: Optional[str]


# One captured color-setting instruction, normalized for comparison and
# replay: (operator, (operand, ...)) with numeric operands as floats and
# anything else (pattern/colorspace names) as strings.
ColorOp = tuple[str, tuple]
# A color state: (space-selecting op | None, value-setting op | None).
# g/rg/k select their device space implicitly, so they stand alone with no
# cs/CS prefix; (None, None) is the stream default (device-gray black).
ColorState = tuple[Optional[ColorOp], Optional[ColorOp]]

DEFAULT_COLOR: ColorState = (None, None)


def color_equal(a: ColorState, b: ColorState, stroke: bool) -> bool:
    """Captured-color equality with ONE semantic identity: the untouched
    default ≡ an explicit device-gray black (`0 g` / `0 G`) — the op a
    rewriter injects to RESTORE the default. Without this, a restored
    default reads as a different state forever."""

    def norm(c: ColorState) -> ColorState:
        if c == (None, None):
            return (None, ("G" if stroke else "g", (0.0,)))
        return c

    return norm(a) == norm(b)


def _color_operands(operands: list) -> tuple:
    out = []
    for el in operands:
        try:
            out.append(float(el))
        except (TypeError, ValueError):
            out.append(str(el))
    return tuple(out)


class GraphicsTextState:
    """Track CTM + text state across one instruction stream.

    `feed(operator, operands)` applies a state-bearing operator and
    returns True; anything else (shows, Do, paints…) returns False and
    the CALLER decides what to do with it, reading `ctm`, `tm`,
    `font_size`, `leading`, `h_scale`, `font_name` and using
    `next_line()` (the '/" implicit advance) and `advance_after_show()`.

    q/Q save/restore the CTM AND the text parameters — all elements of
    the PDF graphics state; restoring only the CTM left a stale font
    size after `q .. Tf .. Q` (the under-redaction leak redact.py's
    comment records). `font_name` rides the same stack.
    """

    def __init__(
        self,
        base_ctm: Matrix,
        font_size: float = 12.0,
        leading: float = 0.0,
        h_scale: float = 1.0,
        font_name: Optional[str] = None,
    ):
        self.ctm: Matrix = base_ctm
        self.tm: Matrix = IDENTITY
        self.tlm: Matrix = IDENTITY
        self.font_size = font_size
        self.leading = leading
        self.h_scale = h_scale
        self.font_name = font_name
        # Tc/Tw (char/word spacing) — tracked for the text-editing walkers'
        # REAL width math (7.2); redaction's estimate never needed them.
        self.char_spacing = 0.0
        self.word_spacing = 0.0
        # 7.5 additions, all q/Q-stacked like the rest: render mode (Tr —
        # OCR's invisible text is Tr 3 and MUST survive re-emission), rise
        # (Ts — superscripts), and fill/stroke color as OPAQUE captures of
        # the most recent color-setting instruction(s). Colors are replayed,
        # never interpreted — link-blue spans survive without a color-space
        # model. sc/scn keep their cs/CS prefix; g/rg/k stand alone.
        self.render_mode = 0
        self.rise = 0.0
        self.fill_color: ColorState = DEFAULT_COLOR
        self.stroke_color: ColorState = DEFAULT_COLOR
        self._stack: list = []

    def snapshot(self) -> TextStateSnapshot:
        return TextStateSnapshot(self.font_size, self.leading, self.h_scale, self.font_name)

    def next_line(self) -> None:
        self.tlm = mat_mult((1, 0, 0, 1, 0, -self.leading), self.tlm)
        self.tm = self.tlm

    def advance_after_show(self, raw_width: float, vertical: bool = False) -> None:
        """Advance tm by a show's estimated width (the actual h-scale is
        applied here so subsequent same-line runs stay positioned).
        9.B4a: a vertical show advances tm F DOWNWARD instead — Tz never
        scales vertical advances (spec 9.4.4: Th applies to tx only);
        Tc/Tw ride inside `raw_width`, composed by the caller either way.
        Callers pass the active font capability's `vertical`; the default
        keeps every horizontal call site bit-identical."""
        if vertical:
            self.tm = mat_mult((1, 0, 0, 1, 0, -raw_width), self.tm)
            return
        self.tm = mat_mult((1, 0, 0, 1, raw_width * self.h_scale, 0), self.tm)

    def feed(self, operator: str, operands: list) -> bool:
        if operator == "q":
            self._stack.append(
                (
                    self.ctm,
                    self.font_size,
                    self.leading,
                    self.h_scale,
                    self.font_name,
                    self.char_spacing,
                    self.word_spacing,
                    self.render_mode,
                    self.rise,
                    self.fill_color,
                    self.stroke_color,
                )
            )
            return True
        if operator == "Q":
            if self._stack:
                (
                    self.ctm,
                    self.font_size,
                    self.leading,
                    self.h_scale,
                    self.font_name,
                    self.char_spacing,
                    self.word_spacing,
                    self.render_mode,
                    self.rise,
                    self.fill_color,
                    self.stroke_color,
                ) = self._stack.pop()
            return True
        if operator == "Tr":
            try:
                self.render_mode = int(float(operands[0]))
            except (TypeError, ValueError, IndexError):
                pass
            return True
        if operator == "Ts":
            try:
                self.rise = float(operands[0])
            except (TypeError, ValueError, IndexError):
                pass
            return True
        if operator in ("g", "rg", "k"):
            self.fill_color = (None, (operator, _color_operands(operands)))
            return True
        if operator in ("G", "RG", "K"):
            self.stroke_color = (None, (operator, _color_operands(operands)))
            return True
        if operator == "cs":
            # Selecting a space resets the value to that space's initial —
            # a later sc/scn fills the second slot.
            self.fill_color = ((operator, _color_operands(operands)), None)
            return True
        if operator == "CS":
            self.stroke_color = ((operator, _color_operands(operands)), None)
            return True
        if operator in ("sc", "scn"):
            self.fill_color = (self.fill_color[0], (operator, _color_operands(operands)))
            return True
        if operator in ("SC", "SCN"):
            self.stroke_color = (self.stroke_color[0], (operator, _color_operands(operands)))
            return True
        if operator == "Tc":
            try:
                self.char_spacing = float(operands[0])
            except (TypeError, ValueError, IndexError):
                pass
            return True
        if operator == "Tw":
            try:
                self.word_spacing = float(operands[0])
            except (TypeError, ValueError, IndexError):
                pass
            return True
        if operator == "cm":
            m = as_matrix(operands)
            if m is not None:
                self.ctm = mat_mult(m, self.ctm)
            return True
        if operator == "Tf":
            try:
                self.font_size = float(operands[-1])
            except (TypeError, ValueError, IndexError):
                pass
            if operands:
                try:
                    self.font_name = str(operands[0])
                except (TypeError, ValueError):
                    pass
            return True
        if operator == "TL":
            try:
                self.leading = float(operands[0])
            except (TypeError, ValueError, IndexError):
                pass
            return True
        if operator == "Tz":
            try:
                self.h_scale = float(operands[0]) / 100.0
            except (TypeError, ValueError, IndexError):
                pass
            return True
        if operator == "BT":
            self.tm = IDENTITY
            self.tlm = IDENTITY
            return True
        if operator in ("Td", "TD"):
            try:
                tx, ty = float(operands[0]), float(operands[1])
            except (TypeError, ValueError, IndexError):
                # Malformed positioning: state untouched, but it IS a
                # state operator — the caller keeps it either way.
                return True
            if operator == "TD":
                self.leading = -ty
            self.tlm = mat_mult((1, 0, 0, 1, tx, ty), self.tlm)
            self.tm = self.tlm
            return True
        if operator == "Tm":
            m = as_matrix(operands)
            if m is not None:
                self.tm = m
                self.tlm = m
            return True
        if operator == "T*":
            self.next_line()
            return True
        return False
