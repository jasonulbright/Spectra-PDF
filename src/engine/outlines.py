"""Text and strokes converted to outlines.

Two transforms with one walk. Both are appearance-preserving by construction —
a glyph becomes the font's own contours at the same place, a stroke becomes the
region the pen would have covered — and both destroy something the caller is
told about before it runs: converted text is no longer selectable, searchable
or extractable, and a converted stroke no longer has a line width to change.

The walk rewrites the page stream, every Form XObject reachable from it and
every tiling Pattern, all copy-on-write: a form is routinely shared between
pages, and rewriting one in place would edit its neighbour. Annotation
appearance streams are deliberately untouched — an annotation's appearance is
not page content, and the region flattener excludes annotations for the same
reason.

A font whose glyphs cannot be reached, or a stroke with no fixed width, is a
REFUSAL naming the page. Nothing is skipped quietly: text that cannot be
outlined is text that would disappear.
"""

from __future__ import annotations

import math

import pikepdf

from .content_walk import DEFAULT_COLOR, IDENTITY, as_matrix, mat_mult
from .glyph_outlines import GlyphSource, OutlineRefusal
from .redact import MAX_FORM_DEPTH, _lookup_xobject, _resolve_resources
from .stroke_outline import stroke_outline
from .text_metrics import _child_state, _FontCache, _run_metrics, show_items
from .text_runs import _resource_lookup
from .validate import validate_pdf
from .pdf_tree import key_name, key_text, token_text

_CONSTRUCT = frozenset({"m", "l", "c", "v", "y", "re", "h"})
_CLIP = frozenset({"W", "W*"})
_PAINT_FILL = frozenset({"f", "F", "f*"})
_PAINT_STROKE = frozenset({"S", "s"})
_PAINT_BOTH = frozenset({"B", "B*", "b", "b*"})
_PAINT_ALL = _PAINT_FILL | _PAINT_STROKE | _PAINT_BOTH | {"n"}
_SHOW_OPS = frozenset({"Tj", "'", '"', "TJ"})
_TEXT_STATE_OPS = frozenset({
    "Tf", "Td", "TD", "Tm", "T*", "TL", "Tc", "Tw", "Tz", "Ts", "Tr",
})

# Stroke colour operator → its fill counterpart. A converted stroke paints as
# a FILL, so the colour it painted with has to move spaces with it.
_STROKE_TO_FILL = {
    "G": "g", "RG": "rg", "K": "k", "CS": "cs", "SC": "sc", "SCN": "scn",
}

# Curve flattening budget, in POINTS on the page. A twentieth of a point is
# under a fifth of a device pixel at 300 dpi, so the polyline is below the
# raster grid at every resolution the flattener offers.
_FLATTEN_TOL_PT = 0.05

# Text render modes.
_MODE_INVISIBLE = 3
_MODE_CLIP_ONLY = 7


def _fmt(value: float) -> str:
    if not math.isfinite(value):
        return "0"
    text = f"{value:.5f}".rstrip("0").rstrip(".")
    return text if text and text != "-0" else "0"


def _apply(matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = matrix
    return (a * x + c * y + e, b * x + d * y + f)


def _matrix_scale(matrix) -> float:
    a, b, c, d = matrix[0], matrix[1], matrix[2], matrix[3]
    return math.sqrt(abs(a * d - b * c)) or 1.0


def _polygon_ops(polygons) -> list[str]:
    ops: list[str] = []
    for polygon in polygons:
        if len(polygon) < 3:
            continue
        ops.append(f"{_fmt(polygon[0][0])} {_fmt(polygon[0][1])} m")
        for point in polygon[1:]:
            ops.append(f"{_fmt(point[0])} {_fmt(point[1])} l")
        ops.append("h")
    return ops


def _contour_ops(contours, matrix, shift: tuple[float, float]) -> list[str]:
    """Em-normalized glyph contours, placed by `matrix` after a `shift` in
    ems (`_glyph_shift`), as PDF path construction operators."""
    dx, dy = shift
    ops: list[str] = []
    for contour in contours:
        for segment in contour:
            kind = segment[0]
            if kind == "h":
                ops.append("h")
                continue
            if kind == "c":
                points = [_apply(matrix, p[0] + dx, p[1] + dy) for p in segment[1]]
                ops.append(" ".join(f"{_fmt(p[0])} {_fmt(p[1])}" for p in points) + " c")
                continue
            x, y = _apply(matrix, segment[1][0] + dx, segment[1][1] + dy)
            ops.append(f"{_fmt(x)} {_fmt(y)} {'m' if kind == 'm' else 'l'}")
    return ops


def _glyph_shift(source, capability, item, code: int, size: float) -> tuple[float, float]:
    """Where one glyph of a show sits, in ems from the run's start: the pen
    offset along the writing direction, and for vertical writing the glyph's
    position vector too, which puts its vertical origin on the pen (ISO
    32000-2 §9.7.4.3). Ems, because `matrix` applies the font size."""
    if capability.writes_vertical:
        origin = source.vertical_origin(code, item.data)
        return (-origin[0], -origin[1] - item.x / size)
    return (item.x / size, 0.0)


def _colour_ops(capture) -> list[str]:
    """A `GraphicsTextState` colour capture replayed as operators, translated
    from the stroking space into the filling one. The untouched default is
    device-gray black (ISO 32000-2 §8.6.4.1), whatever the fill colour is."""
    if capture == DEFAULT_COLOR:
        return ["0 g"]
    ops: list[str] = []
    for part in capture:
        if part is None:
            continue
        operator, operands = part
        target = _STROKE_TO_FILL.get(operator, operator)
        text = " ".join(_operand_text(value) for value in operands)
        ops.append(f"{text} {target}".strip())
    return ops


def _operand_text(value) -> str:
    """One captured colour operand as content-stream syntax. A name is written
    with its escapes (ISO 32000-2 §7.3.5): the capture spells a UTF-8 name as
    text and keeps any other name as the name object, and neither text nor a
    name's bytes are ASCII in general."""
    if isinstance(value, pikepdf.Name):
        return value.unparse().decode("ascii")
    if isinstance(value, str):
        return key_name(value).unparse().decode("ascii") if value.startswith("/") else value
    try:
        return _fmt(float(value))
    except (TypeError, ValueError):
        return str(value)


class _StrokeState:
    """Line width, cap, join, miter limit and dash — the parameters that decide
    what a stroke covers. `GraphicsTextState` does not track them, and they are
    graphics state like any other, so they save and restore with q/Q."""

    def __init__(self, parent: "_StrokeState | None" = None) -> None:
        self.width = 1.0
        self.cap = 0
        self.join = 0
        self.miter = 10.0
        self.dash: tuple = ()
        self.phase = 0.0
        if parent is not None:
            (self.width, self.cap, self.join, self.miter, self.dash,
             self.phase) = parent.values()
        self._stack: list = []

    def values(self) -> tuple:
        return (self.width, self.cap, self.join, self.miter, self.dash, self.phase)

    def push(self) -> None:
        self._stack.append(
            (self.width, self.cap, self.join, self.miter, self.dash, self.phase)
        )

    def pop(self) -> None:
        if self._stack:
            (self.width, self.cap, self.join, self.miter, self.dash,
             self.phase) = self._stack.pop()

    def feed(self, operator: str, operands: list) -> None:
        try:
            if operator == "w":
                self.width = float(operands[0])
            elif operator == "J":
                self.cap = int(float(operands[0]))
            elif operator == "j":
                self.join = int(float(operands[0]))
            elif operator == "M":
                self.miter = float(operands[0])
            elif operator == "d":
                self.dash = tuple(float(v) for v in operands[0])
                self.phase = float(operands[1])
        except (TypeError, ValueError, IndexError):
            pass

    def apply_ext_gstate(self, ext_gstate) -> None:
        if ext_gstate is None:
            return
        for key, attr, cast in (
            ("/LW", "width", float), ("/LC", "cap", int),
            ("/LJ", "join", int), ("/ML", "miter", float),
        ):
            try:
                value = ext_gstate.get(key)
            except Exception:
                value = None
            if value is not None:
                try:
                    setattr(self, attr, cast(float(value)))
                except (TypeError, ValueError):
                    pass
        try:
            dash = ext_gstate.get("/D")
        except Exception:
            dash = None
        if dash is not None:
            try:
                self.dash = tuple(float(v) for v in dash[0])
                self.phase = float(dash[1])
            except (TypeError, ValueError, IndexError):
                pass


class _Report:
    def __init__(self) -> None:
        self.text_runs = 0
        self.invisible_runs = 0
        self.glyphs = 0
        self.strokes = 0
        self.substituted: dict[str, str] = {}
        self.fonts: set[str] = set()


class _Context:
    """What the rewrite of one page shares across its nested streams."""

    def __init__(self, pdf, number: int, font_dir: str, outline_text: bool,
                 outline_strokes: bool, report: _Report):
        self.pdf = pdf
        self.number = number
        self.font_dir = font_dir
        self.outline_text = outline_text
        self.outline_strokes = outline_strokes
        self.report = report
        self.fonts = _FontCache()
        self._sources: dict = {}
        # A rewritten form per (form, the state its Do hands it): the same
        # form drawn in two states converts to two different drawings.
        self.forms: dict = {}
        self._held: list = []

    def font_key(self, font_obj):
        """A key that names one font dictionary for the life of the page. A
        direct dictionary has no object number, and its wrapper's id is reused
        once the wrapper is collected, so the wrapper is held."""
        if font_obj is None:
            return None
        try:
            if font_obj.is_indirect:
                return ("obj", font_obj.objgen)
        except AttributeError:
            return None
        self._held.append(font_obj)
        return ("held", id(font_obj))

    def source(self, font_obj) -> GlyphSource:
        """The glyph source of the font dictionary the text state holds."""
        key = self.font_key(font_obj)
        cached = self._sources.get(key)
        if cached is not None:
            if isinstance(cached, OutlineRefusal):
                raise cached
            return cached
        capability = self.fonts.capability_of(font_obj)
        try:
            source = GlyphSource(font_obj, capability, self.font_dir, self.number)
        except OutlineRefusal as exc:
            self._sources[key] = exc
            raise
        self._sources[key] = source
        self.report.fonts.add(source.name)
        if source.substituted:
            self.report.substituted[source.name] = source.substituted
        return source


def _inherited(ctx: _Context, state, strokes: _StrokeState, ctm) -> tuple:
    """Everything a form's rewrite reads from the Do that invokes it: the text
    parameters, the stroke colour and parameters, and the scale its curves
    flatten at."""
    return (
        ctx.font_key(state.font), state.font_name, state.font_size, state.leading,
        state.h_scale, state.char_spacing, state.word_spacing, state.render_mode,
        state.rise, repr(state.stroke_color), strokes.values(), _matrix_scale(ctm),
    )


# ── the rewriter ───────────────────────────────────────────────────────────


def rewrite_instructions(instructions, resources, ctx: _Context, base_ctm=IDENTITY,
                         fallback=None, parent_state=None, parent_strokes=None,
                         depth: int = 0):
    """One content stream rewritten, or None when nothing in it changed.

    `parent_state` and `parent_strokes` are the graphics state the stream
    starts in, None for a page. `resources` is this stream's own forked
    dictionary: a converted form registers there under a fresh name, and a
    name no kept Do draws any more leaves it, so the unconverted form is not
    reachable from the converted stream.
    """
    lookup = _resource_lookup(resources, fallback)
    state = _child_state(base_ctm, parent_state, lookup=lookup)
    strokes = _StrokeState(parent_strokes)
    out: list[bytes] = []
    changed = False

    construct: list[list] = []      # subpaths, in the construction grammar
    current: list = []
    held: list = []                 # the construction's own instructions
    clip_pending = False
    in_text = False
    clip_ops: list[str] = []
    replaced: set = set()
    drawn: set = set()

    def keep(instruction) -> None:
        out.append(pikepdf.unparse_content_stream([instruction]))

    def keep_held() -> None:
        for instruction in held:
            keep(instruction)

    def emit(lines: list[str]) -> None:
        if lines:
            out.append("\n".join(lines).encode("ascii"))

    def reset_path() -> None:
        nonlocal current, clip_pending
        construct.clear()
        current = []
        held.clear()
        clip_pending = False

    for instruction in instructions:
        operator = token_text(instruction.operator)
        operands = list(instruction.operands)

        if operator == "q":
            strokes.push()
        elif operator == "Q":
            strokes.pop()
        elif operator in ("w", "J", "j", "M", "d"):
            strokes.feed(operator, operands)
        elif operator == "gs" and operands:
            strokes.apply_ext_gstate(lookup("/ExtGState", operands[0]))

        if in_text:
            if operator in _TEXT_STATE_OPS:
                state.feed(operator, operands)
                continue
            if operator in _SHOW_OPS:
                changed = True
                clip_ops.extend(_emit_text(out, operator, operands, state, strokes, ctx))
                continue
            if operator == "ET":
                if clip_ops:
                    emit(clip_ops + ["W n"])
                elif state.render_mode >= 4:
                    # A clipping text block that drew no glyph clips to
                    # nothing, and a degenerate path is how that is written.
                    emit(["0 0 m", "W n"])
                clip_ops = []
                in_text = False
                continue
            state.feed(operator, operands)
            keep(instruction)
            continue

        if operator == "BT":
            state.feed(operator, operands)
            if ctx.outline_text:
                in_text = True
                clip_ops = []
                continue
            keep(instruction)
            continue

        if ctx.outline_strokes:
            if operator in _CONSTRUCT:
                held.append(instruction)
                _feed_construction(construct, operator, operands)
                continue
            if operator in _CLIP:
                held.append(instruction)
                clip_pending = True
                continue
            if operator in _PAINT_ALL:
                lines, did = _emit_paint(operator, construct, state, strokes, ctx)
                if did:
                    changed = True
                    if clip_pending:
                        # The clip takes effect only AFTER the painting
                        # operator, so the converted stroke paints first and
                        # the original path then sets the clip.
                        emit(lines)
                        keep_held()
                        emit(["n"])
                    else:
                        emit(lines)
                else:
                    keep_held()
                    keep(instruction)
                reset_path()
                continue

        if operator == "Do" and operands:
            name = _placed_form(operands[0], resources, fallback, state, strokes, ctx, depth)
            if name is not None:
                changed = True
                replaced.add(key_text(operands[0]))
                drawn.add(key_text(name))
                keep(pikepdf.ContentStreamInstruction([name], pikepdf.Operator("Do")))
                continue
            drawn.add(key_text(operands[0]))

        state.feed(operator, operands)
        keep(instruction)

    table = resources.get("/XObject") if resources is not None else None
    if table is not None:
        for name in replaced - drawn:
            if name in table:
                del table[name]
    return (out if changed else None)


def _placed_form(name, resources, fallback, state, strokes, ctx: _Context, depth: int):
    """The name a converted copy of the form this Do draws is registered
    under in `resources`, or None when the Do draws something else or the
    form converts to nothing different.

    The form runs in the graphics state of its Do (ISO 32000-2 §8.10.1): its
    text draws in the font the invoker selected, whatever its own resources
    call by that name, and its strokes in the invoker's width and colour. So
    it converts once per state it is drawn in, never once for every state.
    """
    form = _lookup_xobject(name, resources, fallback)
    try:
        if not isinstance(form, pikepdf.Stream) or str(form.get("/Subtype", "")) != "/Form":
            return None
        ctm = mat_mult(as_matrix(form.get("/Matrix")) or IDENTITY, state.ctm)
    except Exception:
        return None
    key = (form.objgen, _inherited(ctx, state, strokes, ctm))
    if key not in ctx.forms:
        ctx.forms[key] = _rewrite_child(
            ctx.pdf, form, resources, ctx, depth + 1, ctm, state, strokes,
        )
    copy = ctx.forms[key]
    if copy is None:
        return None
    table = resources.get("/XObject")
    if table is None:
        table = pikepdf.Dictionary()
        resources["/XObject"] = table
    for existing in table.keys():
        try:
            if table[existing].objgen == copy.objgen:
                return pikepdf.Name(str(existing))
        except Exception:
            continue
    taken = {str(k) for k in table.keys()}
    index = 0
    while f"/OlFm{index}" in taken:
        index += 1
    fresh = pikepdf.Name(f"/OlFm{index}")
    table[fresh] = copy
    return fresh


def _feed_construction(construct: list, operator: str, operands: list) -> None:
    try:
        values = [float(v) for v in operands]
    except (TypeError, ValueError):
        values = []
    if operator == "m" and len(values) >= 2:
        construct.append([("m", (values[0], values[1]))])
        return
    if operator == "re" and len(values) >= 4:
        x, y, w, h = values[:4]
        construct.append([
            ("m", (x, y)), ("l", (x + w, y)), ("l", (x + w, y + h)),
            ("l", (x, y + h)), ("h",),
        ])
        return
    if not construct:
        return
    subpath = construct[-1]
    if operator == "l" and len(values) >= 2:
        subpath.append(("l", (values[0], values[1])))
    elif operator == "c" and len(values) >= 6:
        subpath.append(("c", ((values[0], values[1]), (values[2], values[3]),
                              (values[4], values[5]))))
    elif operator == "v" and len(values) >= 4:
        start = _last_point(subpath)
        subpath.append(("c", (start, (values[0], values[1]), (values[2], values[3]))))
    elif operator == "y" and len(values) >= 4:
        subpath.append(("c", ((values[0], values[1]), (values[2], values[3]),
                              (values[2], values[3]))))
    elif operator == "h":
        subpath.append(("h",))


def _last_point(subpath):
    for segment in reversed(subpath):
        if segment[0] == "c":
            return segment[1][-1]
        if segment[0] in ("m", "l"):
            return segment[1]
    return (0.0, 0.0)


def _emit_paint(operator, construct, state, strokes, ctx: _Context):
    """The painting operator's replacement lines, and whether it was replaced."""
    if operator not in (_PAINT_STROKE | _PAINT_BOTH) or not construct:
        return [], False
    if abs(float(strokes.width)) <= 0:
        page = ctx.number
        raise OutlineRefusal(
            f"Page {page} draws a zero-width line, which has no fixed width "
            f"to outline."
        )
    subpaths = [list(sub) for sub in construct]
    if operator in ("s", "b", "b*"):
        for subpath in subpaths:
            if not subpath or subpath[-1][0] != "h":
                subpath.append(("h",))
    tolerance = _FLATTEN_TOL_PT / _matrix_scale(state.ctm)
    polygons = stroke_outline(
        subpaths, strokes.width, strokes.cap, strokes.join, strokes.miter,
        strokes.dash, strokes.phase, tolerance,
    )
    ctx.report.strokes += 1
    lines: list[str] = []
    if operator in _PAINT_BOTH:
        fill_rule = "f*" if operator in ("B*", "b*") else "f"
        lines.extend(_path_ops_from(subpaths))
        lines.append(fill_rule)
    if polygons:
        lines.append("q")
        lines.extend(_colour_ops(state.stroke_color))
        lines.extend(_polygon_ops(polygons))
        lines.append("f")
        lines.append("Q")
    return lines, True


def _path_ops_from(subpaths) -> list[str]:
    ops: list[str] = []
    for subpath in subpaths:
        for segment in subpath:
            if segment[0] == "h":
                ops.append("h")
            elif segment[0] == "c":
                ops.append(" ".join(
                    f"{_fmt(p[0])} {_fmt(p[1])}" for p in segment[1]) + " c")
            else:
                ops.append(f"{_fmt(segment[1][0])} {_fmt(segment[1][1])} "
                           f"{'m' if segment[0] == 'm' else 'l'}")
    return ops


def _emit_text(out: list, operator: str, operands: list, state, strokes,
               ctx: _Context) -> list[str]:
    """One show operator as paths. Returns the clip contribution, if any."""
    if operator == '"':
        try:
            state.word_spacing = float(operands[0])
            state.char_spacing = float(operands[1])
        except (TypeError, ValueError, IndexError):
            pass
    if operator in ("'", '"'):
        state.next_line()

    capability = ctx.fonts.capability_of(state.font)
    if capability is None:
        page, name = ctx.number, state.font_name
        if name:
            raise OutlineRefusal(
                f"Page {page} draws text through the font resource {name}, "
                f"which the page does not define."
            )
        raise OutlineRefusal(f"Page {page} draws text with no font selected.")
    source = ctx.source(state.font)

    size = float(state.font_size)
    scale = float(state.h_scale)
    mode = int(state.render_mode)
    ctx.report.text_runs += 1
    if mode == _MODE_INVISIBLE:
        ctx.report.invisible_runs += 1

    if size == 0.0 or mode == _MODE_INVISIBLE:
        _advance(operator, operands, capability, state)
        return []

    matrix = mat_mult((size * scale, 0.0, 0.0, size, 0.0, float(state.rise)), state.tm)
    ops: list[str] = []
    for item in show_items(operator, operands, capability, state):
        if item.kern:
            continue
        codes = capability.codes(item.data)
        if not codes:
            continue
        contours = source.contours(codes[0][0], item.data)
        if not contours:
            continue
        ctx.report.glyphs += 1
        ops.extend(_contour_ops(contours, matrix,
                                _glyph_shift(source, capability, item, codes[0][0], size)))

    _advance(operator, operands, capability, state)
    if not ops:
        return []
    if mode == _MODE_CLIP_ONLY:
        return ops
    paint = {0: "f", 1: "S", 2: "B", 4: "f", 5: "S", 6: "B"}.get(mode, "f")
    if paint != "f" and ctx.outline_strokes:
        tolerance = _FLATTEN_TOL_PT / _matrix_scale(state.ctm)
        polygons = stroke_outline(
            _contours_to_subpaths(source, matrix, operator, operands, capability, state),
            strokes.width, strokes.cap, strokes.join, strokes.miter,
            strokes.dash, strokes.phase, tolerance,
        )
        out.append(("\n".join(
            ([*ops, "f"] if paint == "B" else [])
            + ["q", *_colour_ops(state.stroke_color), *_polygon_ops(polygons), "f", "Q"]
        )).encode("ascii"))
        return ops if mode >= 4 else []
    out.append(("\n".join(ops + [paint])).encode("ascii"))
    return ops if mode >= 4 else []


def _contours_to_subpaths(source, matrix, operator, operands, capability, state):
    """The glyph run's outline as construction subpaths in user space — what a
    stroking render mode strokes when strokes are being converted too."""
    subpaths: list[list] = []
    size = float(state.font_size) or 1.0
    for item in show_items(operator, operands, capability, state):
        if item.kern:
            continue
        codes = capability.codes(item.data)
        if not codes:
            continue
        dx, dy = _glyph_shift(source, capability, item, codes[0][0], size)
        for contour in source.contours(codes[0][0], item.data):
            built: list = []
            for segment in contour:
                if segment[0] == "h":
                    built.append(("h",))
                elif segment[0] == "c":
                    built.append(("c", tuple(
                        _apply(matrix, p[0] + dx, p[1] + dy) for p in segment[1])))
                else:
                    point = _apply(matrix, segment[1][0] + dx, segment[1][1] + dy)
                    built.append((segment[0], point))
            if built:
                subpaths.append(built)
    return subpaths


def _advance(operator: str, operands: list, capability, state) -> None:
    _text, width = _run_metrics(operator, operands, capability, state)
    state.advance_after_show(width, bool(capability.writes_vertical))


# ── stream plumbing ────────────────────────────────────────────────────────


_STREAM_ENCODING_KEYS = ("/Length", "/Filter", "/DecodeParms")


def _fork_resources(pdf, resources):
    """A resources dictionary whose FORM and PATTERN tables are fresh.

    Both are the tables the rewrite replaces entries in, and both are routinely
    shared between pages; forking them is what keeps a rewrite from editing a
    page the caller never named. Everything else is shared by reference,
    because nothing else is written.
    """
    new = pikepdf.Dictionary()
    if resources is not None:
        for key in resources.keys():
            new[key] = resources[key]
    for key in ("/XObject", "/Pattern"):
        source = resources.get(key) if resources is not None else None
        if source is None:
            continue
        fresh = pikepdf.Dictionary()
        for name in source.keys():
            fresh[name] = source[name]
        new[key] = fresh
    return new


def _rewrite_patterns(pdf, resources, ctx: _Context, depth: int, base_ctm,
                      parent_state=None, parent_strokes=None) -> bool:
    """Rewrite every tiling Pattern the resources name, onto COPIES registered
    in this (already forked) resources dictionary.

    A pattern cell draws in the graphics state in effect at the BEGINNING of
    the stream that owns it as a resource, with the pattern matrix applied to
    that stream's initial CTM (ISO 32000-2 §8.7.2, §8.7.3.1): `base_ctm`,
    `parent_state` and `parent_strokes` are that stream's own starting state,
    not the state at the operator that paints with the pattern."""
    if resources is None:
        return False
    try:
        table = resources.get("/Pattern")
    except Exception:
        table = None
    if table is None:
        return False
    changed = False
    for name in list(table.keys()):
        try:
            obj = table[name]
            if not isinstance(obj, pikepdf.Stream):
                continue
            kind = obj.get("/PatternType")
            if kind is None or int(kind) != 1:
                continue
            ctm = mat_mult(as_matrix(obj.get("/Matrix")) or IDENTITY, base_ctm)
        except Exception:
            continue
        replacement = _rewrite_child(
            pdf, obj, resources, ctx, depth + 1, ctm, parent_state, parent_strokes,
        )
        if replacement is not None:
            table[name] = replacement
            changed = True
    return changed


def _rewrite_child(pdf, obj, parent_resources, ctx: _Context, depth: int, base_ctm,
                   parent_state=None, parent_strokes=None):
    """A rewritten COPY of one nested stream, or None when nothing changed.
    `base_ctm`, `parent_state` and `parent_strokes` are the state the stream
    starts in: a form's is the state at its Do, a pattern cell's the starting
    state of the stream that owns it."""
    if depth > MAX_FORM_DEPTH:
        page, cap = ctx.number, MAX_FORM_DEPTH
        raise OutlineRefusal(
            f"Page {page} nests form XObjects deeper than {cap} levels."
        )
    try:
        own = obj.get("/Resources")
    except Exception:
        own = None
    try:
        instructions = list(pikepdf.parse_content_stream(obj))
    except Exception:
        return None
    resources = _fork_resources(pdf, own if own is not None else parent_resources)
    nested = _rewrite_patterns(
        pdf, resources, ctx, depth, base_ctm, parent_state, parent_strokes,
    )
    rewritten = rewrite_instructions(
        instructions, resources, ctx, base_ctm, parent_resources,
        parent_state, parent_strokes, depth,
    )
    if rewritten is None and not nested:
        return None
    body = (b"\n".join(rewritten) if rewritten is not None
            else pikepdf.unparse_content_stream(instructions))
    copy = pdf.make_stream(body)
    for key in obj.keys():
        if str(key) in _STREAM_ENCODING_KEYS:
            continue
        copy[key] = obj[key]
    copy["/Resources"] = resources
    return copy


def outline_page(pdf, page, number: int, font_dir: str, outline_text: bool,
                 outline_strokes: bool) -> dict:
    """Convert one page in place. Returns what it converted."""
    report = _Report()
    ctx = _Context(pdf, number, font_dir, outline_text, outline_strokes, report)
    resources = _fork_resources(pdf, _resolve_resources(page))
    page.obj["/Resources"] = resources
    nested = _rewrite_patterns(pdf, resources, ctx, 1, IDENTITY)
    instructions = list(pikepdf.parse_content_stream(page))
    rewritten = rewrite_instructions(instructions, resources, ctx, depth=1)
    if rewritten is not None:
        page.Contents = pdf.make_stream(b"\n".join(rewritten))
    return {
        "page": number,
        "text_runs": report.text_runs,
        "invisible_runs": report.invisible_runs,
        "glyphs": report.glyphs,
        "strokes": report.strokes,
        "fonts": sorted(report.fonts),
        "substituted": dict(sorted(report.substituted.items())),
        "changed": bool(rewritten is not None or nested),
    }


def _page_numbers(pdf, pages) -> list[int]:
    total = len(pdf.pages)
    if pages is None:
        return list(range(1, total + 1))
    if isinstance(pages, int):
        pages = [pages]
    wanted: list[int] = []
    for value in pages:
        number = int(value)
        if number < 1 or number > total:
            raise ValueError(f"Page {number} is not in this document.")
        if number not in wanted:
            wanted.append(number)
    return wanted


def list_outlines(file: str, pages=None, font_dir: str = "") -> dict:
    """What converting this document's text and strokes to outlines would do.

    Args:
        file: Input PDF path.
        pages: 1-based page numbers, or None for the whole document.
        font_dir: Directory of bundled faces, for text whose font the document
            does not embed.

    Writes nothing. A page whose conversion would refuse reports the refusal
    against that page instead of raising, so the panel can state every problem
    at once rather than one per attempt.
    """
    validate_pdf(file)
    report: list[dict] = []
    with pikepdf.open(file) as pdf:
        for number in _page_numbers(pdf, pages):
            entry = _dry_run(pdf, number, font_dir)
            report.append(entry)
    return {
        "pages": report,
        "text_runs": sum(page["text_runs"] for page in report),
        "strokes": sum(page["strokes"] for page in report),
        "invisible_runs": sum(page["invisible_runs"] for page in report),
        "refusals": [page["error"] for page in report if page["error"]],
        "substituted": sorted({
            face for page in report for face in page["substituted"].values()
        }),
    }


def _dry_run(pdf, number: int, font_dir: str) -> dict:
    """One page counted without writing. The rewrite runs against a throwaway
    copy of the page so the count and the apply can never disagree about what
    converts — one implementation, asked twice."""
    scratch = pikepdf.new()
    scratch.pages.append(pdf.pages[number - 1])
    page = scratch.pages[0]
    entry = {
        "page": number, "text_runs": 0, "invisible_runs": 0, "glyphs": 0,
        "strokes": 0, "fonts": [], "substituted": {}, "error": None,
    }
    try:
        result = outline_page(scratch, page, number, font_dir, True, True)
    except (OutlineRefusal, ValueError) as exc:
        entry["error"] = str(exc)
        return entry
    except Exception as exc:  # a stream this engine cannot parse is reported
        entry["error"] = f"Page {number} could not be read: {exc}"
        return entry
    finally:
        scratch.close()
    entry.update({key: result[key] for key in
                  ("text_runs", "invisible_runs", "glyphs", "strokes",
                   "fonts", "substituted")})
    return entry
