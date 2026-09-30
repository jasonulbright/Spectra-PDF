"""The ONE graphics/text-state machine for content-stream walkers.

One interpreter, two clients, no drift: redaction (`redact.py`), image editing (`page_images.py`), and text
editing all walk content streams tracking the same PDF graphics state —
CTM (q/Q/cm), text matrices (BT, Tm/Td/TD/T*), and text parameters
(Tf or ExtGState font and size, TL leading, Tz horizontal scale). Before this
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

import math
import sys
from typing import Callable, NamedTuple, Optional

import pikepdf

from engine.pdf_tree import key_text

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


def rects_intersect(a: Rect, b: Rect) -> bool:
    """True when two axis-aligned rects overlap. Edge-touch (zero-area) counts
    as NON-overlapping (`<=`), matching redact.py's long-standing predicate so
    every clip/region test in the walkers agrees on the boundary case."""
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


# Finite so it serializes as JSON; no finite rect intersects it, and
# intersecting it with any clip leaves it unchanged.
EMPTY_CLIP: Rect = (sys.float_info.max, sys.float_info.max, -sys.float_info.max, -sys.float_info.max)


def clip_has_area(clip: Rect) -> bool:
    return clip[0] < clip[2] and clip[1] < clip[3]


Point = tuple[float, float]


class ClipRegion(NamedTuple):
    """A device-space clip region: convex, so the intersection of two stays
    convex. `poly` is None when the region is exactly the axis-aligned
    `rect`; otherwise it lists the region's vertices and `rect` is their
    bounding box. An empty region has `rect` without area (or `poly` with
    fewer than three vertices): it clips everything away."""

    rect: Rect
    poly: Optional[tuple[Point, ...]] = None

    @property
    def empty(self) -> bool:
        return not clip_has_area(self.rect) or (self.poly is not None and len(self.poly) < 3)


EMPTY_REGION = ClipRegion(EMPTY_CLIP, ())


def _cross(o: Point, a: Point, b: Point) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _hull(points) -> list:
    """Convex hull, counter-clockwise, collinear vertices dropped."""
    pts = sorted(set(points))
    if len(pts) < 3:
        return []
    lower: list = []
    for p in pts:
        while len(lower) >= 2 and _cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list = []
    for p in reversed(pts):
        while len(upper) >= 2 and _cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = lower[:-1] + upper[:-1]
    return hull if len(hull) >= 3 else []


def _rect_poly(rect: Rect) -> list:
    x0, y0, x1, y1 = rect
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def _bbox(points) -> Rect:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


def _region_of_points(points) -> ClipRegion:
    """The convex hull of `points` as a region. The hull contains every path
    (and every Bezier curve) built on those points, so it is never smaller
    than the true clip."""
    hull = _hull(points)
    if not hull:
        return EMPTY_REGION
    box = _bbox(hull)
    if len(hull) == 4 and all(x in (box[0], box[2]) and y in (box[1], box[3]) for x, y in hull):
        return ClipRegion(box)
    return ClipRegion(box, tuple(hull))


def _convex_intersection(subject: list, clipper: list) -> list:
    """Sutherland-Hodgman: `subject` clipped by the convex CCW `clipper`."""
    out = list(subject)
    for i in range(len(clipper)):
        if not out:
            break
        a, b = clipper[i], clipper[(i + 1) % len(clipper)]
        points, out = out, []
        for j in range(len(points)):
            cur, prev = points[j], points[j - 1]
            cur_in = _cross(a, b, cur) >= 0
            prev_in = _cross(a, b, prev) >= 0
            if cur_in != prev_in:
                dx, dy = cur[0] - prev[0], cur[1] - prev[1]
                ex, ey = b[0] - a[0], b[1] - a[1]
                denom = ex * dy - ey * dx
                if denom != 0:
                    t = (ex * (a[1] - prev[1]) - ey * (a[0] - prev[0])) / denom
                    out.append((prev[0] + t * dx, prev[1] + t * dy))
            if cur_in:
                out.append(cur)
    return out


def intersect_regions(region: Optional[ClipRegion], other: ClipRegion) -> ClipRegion:
    """`region` narrowed by `other` (None = unbounded)."""
    if region is None:
        return other
    if region.empty or other.empty:
        return EMPTY_REGION
    if region.poly is None and other.poly is None:
        a, b = region.rect, other.rect
        return ClipRegion((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))
    subject = list(region.poly) if region.poly is not None else _rect_poly(region.rect)
    clipper = list(other.poly) if other.poly is not None else _rect_poly(other.rect)
    return _region_of_points(_convex_intersection(subject, clipper))


def _separated(poly, bbox: Rect) -> bool:
    """Separating-axis test of a convex polygon against an axis-aligned box.
    Touching projections count as separated, as in `rects_intersect`."""
    box = _rect_poly(bbox)
    axes = [(1.0, 0.0), (0.0, 1.0)]
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        axes.append((a[1] - b[1], b[0] - a[0]))
    for ax, ay in axes:
        pa = [ax * x + ay * y for x, y in poly]
        pb = [ax * x + ay * y for x, y in box]
        if max(pa) <= min(pb) or max(pb) <= min(pa):
            return True
    return False


def form_region(xobj, ctm: Matrix, region: Optional[ClipRegion]) -> Optional[ClipRegion]:
    """The device-space clip a Form XObject's content runs under: the invoking
    `region` narrowed by the form's /BBox mapped through /Matrix and `ctm`
    (ISO 32000-2 §8.10.1; /BBox and /Matrix per Table 93). A rotated or skewed
    BBox maps to a parallelogram and narrows by that parallelogram, not its
    bounding box. A composed matrix that overflows or is singular maps the
    form onto no area, so nothing it draws is visible. An unreadable /Matrix
    or /BBox leaves `region` unchanged."""
    composed = mat_mult(as_matrix(xobj.get("/Matrix")) or IDENTITY, ctm)
    if not all(math.isfinite(v) for v in composed):
        return EMPTY_REGION
    a, b, c, d, _, _ = composed
    if a * d - b * c == 0:
        return EMPTY_REGION
    try:
        bx0, by0, bx1, by1 = (float(v) for v in xobj.get("/BBox"))
    except (TypeError, ValueError):
        return region
    corners = [transform_point(composed, x, y) for x, y in
               ((bx0, by0), (bx1, by0), (bx1, by1), (bx0, by1))]
    if not all(math.isfinite(v) for p in corners for v in p):
        return region
    if (b == 0 and c == 0) or (a == 0 and d == 0):
        box = ClipRegion(_bbox(corners))
    else:
        box = _region_of_points(corners)
    return intersect_regions(region, box)


class TextStateSnapshot(NamedTuple):
    """The text-state values a form inherits at its invoking Do."""

    font_size: float
    leading: float
    h_scale: float
    font_name: Optional[str]
    font: object = None


# One captured color-setting instruction, normalized for comparison and
# replay: (operator, (operand, ...)) with numeric operands as floats and
# anything else (pattern/colorspace names) as strings, or as the name object
# where the name is not UTF-8.
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
            try:
                out.append(str(el))
            except UnicodeDecodeError:
                # A name need not be UTF-8 (ISO 32000-2 §7.3.5): it rides as
                # the name object itself, which replays byte for byte.
                out.append(el)
    return tuple(out)


class GraphicsTextState:
    """Track CTM + text state across one instruction stream.

    `feed(operator, operands)` applies a state-bearing operator and
    returns True; anything else (shows, Do, paints…) returns False and
    the CALLER decides what to do with it, reading `ctm`, `tm`,
    `font_size`, `leading`, `h_scale`, `font_name`, `font` and using
    `next_line()` (the '/" implicit advance) and `advance_after_show()`.

    q/Q save/restore the CTM AND the text parameters — all elements of
    the PDF graphics state; restoring only the CTM left a stale font
    size after `q .. Tf .. Q` (the under-redaction leak redact.py's
    comment records). `font_name` and `font` ride the same stack.

    `font` is the font DICTIONARY the text state holds (ISO 32000-2 §9.3.1),
    tracked when the caller gives `lookup`, its stream's resource resolver
    `(category, name object) -> object or None`. `Tf` resolves its name there;
    a `gs` whose ExtGState has a /Font entry sets the font and the size as
    `Tf` does (Table 57) and still returns False, its other parameters being
    the caller's. A form inherits the dictionary, not the name: the form's
    own resources may give that name to another font.
    """

    def __init__(
        self,
        base_ctm: Matrix,
        font_size: float = 12.0,
        leading: float = 0.0,
        h_scale: float = 1.0,
        font_name: Optional[str] = None,
        fill_color: ColorState = DEFAULT_COLOR,
        stroke_color: ColorState = DEFAULT_COLOR,
        font=None,
        lookup: Optional[Callable] = None,
    ):
        self.ctm: Matrix = base_ctm
        self.tm: Matrix = IDENTITY
        self.tlm: Matrix = IDENTITY
        self.font_size = font_size
        self.leading = leading
        self.h_scale = h_scale
        self.font_name = font_name
        self.font = font
        self.lookup = lookup
        # Tc/Tw (char/word spacing) — tracked for the text-editing walkers'
        # REAL width math; redaction's estimate never needed them.
        self.char_spacing = 0.0
        self.word_spacing = 0.0
        # Paragraph-layer additions, all q/Q-stacked like the rest: render mode (Tr —
        # OCR's invisible text is Tr 3 and MUST survive re-emission), rise
        # (Ts — superscripts), and fill/stroke color as OPAQUE captures of
        # the most recent color-setting instruction(s). Colors are replayed,
        # never interpreted — link-blue spans survive without a color-space
        # model. sc/scn keep their cs/CS prefix; g/rg/k stand alone.
        # Fill/stroke seed the INVOKING state when a Form XObject inherits
        # the caller's colour (a form runs in the caller's graphics state, ISO
        # 32000 §8.10.2); default DEFAULT_COLOR keeps every existing caller
        # (redact/page_images/text) byte-identical.
        self.render_mode = 0
        self.rise = 0.0
        self.fill_color: ColorState = fill_color
        self.stroke_color: ColorState = stroke_color
        self._stack: list = []

    def snapshot(self) -> TextStateSnapshot:
        return TextStateSnapshot(
            self.font_size, self.leading, self.h_scale, self.font_name, self.font
        )

    def _resolve(self, category: str, name):
        if self.lookup is None or not isinstance(name, pikepdf.Name):
            return None
        try:
            return self.lookup(category, name)
        except Exception:
            return None

    def next_line(self) -> None:
        self.tlm = mat_mult((1, 0, 0, 1, 0, -self.leading), self.tlm)
        self.tm = self.tlm

    def advance_after_show(self, raw_width: float, vertical: bool = False) -> None:
        """Advance tm by a show's estimated width (the actual h-scale is
        applied here so subsequent same-line runs stay positioned).
        A vertical show advances tm F DOWNWARD instead — Tz never
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
                    self.font,
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
                    self.font,
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
                self.font_name = key_text(operands[0])
            found = self._resolve("/Font", operands[0] if operands else None)
            self.font = found if isinstance(found, pikepdf.Dictionary) else None
            return True
        if operator == "gs":
            state = self._resolve("/ExtGState", operands[0] if operands else None)
            chosen = state.get("/Font") if isinstance(state, pikepdf.Dictionary) else None
            if (
                isinstance(chosen, pikepdf.Array)
                and len(chosen) >= 2
                and isinstance(chosen[0], pikepdf.Dictionary)
            ):
                try:
                    size = float(chosen[1])
                except (TypeError, ValueError):
                    size = None
                if size is not None:
                    self.font = chosen[0]
                    self.font_size = size
                    self.font_name = None
            return False
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


class ClipTracker:
    """Track the active clip region across one instruction stream, ADDITIVELY
    alongside `GraphicsTextState` (never inside its `feed()` — the state machine
    5 walkers depend on stays byte-for-byte untouched).

    Extracted from the tracker `redact.py` grew for its `sh`
    leak fix: every content walker that lists or strips content
    needs to know whether a bbox is CLIPPED AWAY (invisible), not just where it
    sits. Before this, clipped-invisible text/images/vectors still listed as
    editable everywhere the shared walk is used.

    Each clip path is approximated by the CONVEX HULL of its points, which is
    always a SUPERSET of the true clip region (a path and its Bezier curves lie
    inside the hull of their points), and nested clips intersect as convex
    polygons. So `clips_away(bbox)` returning True — the content's bbox does
    not overlap the region — means the content is DEFINITELY invisible; a
    False can still be clipped by a non-convex path, so callers err toward
    KEEPING content, the safe direction for a listing and for redaction alike.
    A region without area clips everything away.

    `feed(operator, operands, ctm)` mirrors redact's original inline tracker:
    q pushes / Q pops the clip (it is graphics state), W|W* arm a pending clip,
    the path-construction ops accumulate device-space points under `ctm`, and a
    path-ending op intersects the accumulated path's hull into the clip. `ctm`
    is the CTM in effect at THIS operator — path-point ops never change the CTM,
    so passing the current `GraphicsTextState.ctm` (fed BEFORE its own `feed`)
    is correct. The clip is stored in DEVICE space, so q/Q save/restore need no
    re-transformation (the clip on the physical page does not move when the CTM
    is popped).

    `base_clip` (a `ClipRegion`, or a Rect) seeds the clip a nested Form XObject INHERITS from its invoking
    `Do` (a form runs in the caller's graphics state, ISO 32000 §8.10.2). The
    listers pass the parent's device-space clip so a form drawn wholly outside
    it flags its content clipped; redaction keeps the default None (unbounded)
    per stream — its `sh` then "covers everything" and is removed, redaction's
    safe over-removal direction and its long-pinned behaviour.
    """

    _PATH_PT_OPS = ("m", "l", "c", "v", "y", "re", "h")
    _PATH_END_OPS = ("n", "f", "F", "f*", "S", "s", "B", "B*", "b", "b*")

    def __init__(self, base_clip=None):
        # None = unbounded (no clip set); a bare Rect seeds an exact rectangle.
        if base_clip is not None and not isinstance(base_clip, ClipRegion):
            base_clip = ClipRegion(tuple(base_clip))
        self.region: Optional[ClipRegion] = base_clip
        self._stack: list = []
        self._pending = False  # a W/W* seen, awaiting the path-ending op
        self._pts: list = []  # path construction points, device space

    @property
    def clip(self) -> Optional[Rect]:
        """The region's bounding box; without area when the region is empty."""
        return None if self.region is None else self.region.rect

    def for_form(self, xobj, ctm: Matrix) -> Optional[ClipRegion]:
        """The region a Form XObject invoked here runs under."""
        return form_region(xobj, ctm, self.region)

    @staticmethod
    def _pts_under_ctm(op: str, operands: list, ctm: Matrix) -> list:
        """Device-space points contributed by a path-construction operator."""
        try:
            nums = [float(v) for v in operands]
        except (TypeError, ValueError):
            return []
        if op == "re" and len(nums) >= 4:
            x, y, w, h = nums[:4]
            corners = ((x, y), (x + w, y), (x + w, y + h), (x, y + h))
        else:
            corners = tuple(zip(nums[0::2], nums[1::2]))
        a, b, c, d, e, f = ctm
        return [(a * px + c * py + e, b * px + d * py + f) for px, py in corners]

    def feed(self, operator: str, operands: list, ctm: Matrix) -> None:
        if operator == "q":
            self._stack.append(self.region)
        elif operator == "Q":
            self.region = self._stack.pop() if self._stack else None
        elif operator in self._PATH_PT_OPS:
            self._pts.extend(self._pts_under_ctm(operator, operands, ctm))
        elif operator in ("W", "W*"):
            self._pending = True
        elif operator in self._PATH_END_OPS:
            if self._pending and self._pts and all(
                    math.isfinite(v) for p in self._pts for v in p):
                self.region = intersect_regions(self.region, _region_of_points(self._pts))
            self._pending = False
            self._pts = []

    def clips_away(self, bbox: Rect) -> bool:
        """True iff `bbox` is fully outside the current clip, i.e. the content is
        DEFINITELY invisible. An unbounded clip (None) never clips anything
        away. Uses the shared `rects_intersect` predicate so the boundary case
        agrees with every other clip/region test."""
        if self.region is None:
            return False
        if self.region.empty:
            return True
        if self.region.poly is None:
            return not rects_intersect(bbox, self.region.rect)
        return _separated(self.region.poly, bbox)
