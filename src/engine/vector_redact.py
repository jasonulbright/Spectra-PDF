"""Remove the part of a painted PATH that lies under a redaction mark.

Text is split glyph by glyph and images pixel by pixel; a path is cut
geometrically, so a signature drawn as strokes, a chart, or text converted to
outlines loses exactly the area under the mark and keeps the rest.

One path object — the construction operators, an optional W/W*, and its
painting operator — is rewritten only when it meets a mark:

  - FILL (f, F, f*, and the fill half of B, B*, b, b*): each subpath the marks
    reach is flattened and the marks are subtracted from it
    (`redact_geometry`), and the pieces are painted with the same fill rule.
    Clipping every subpath to the same convex region keeps every point's
    winding number inside that region, so the nonzero and even-odd results
    are both exact outside the marks and empty inside them.
  - STROKE (S, s, and the stroke half of the B family): each subpath's
    centreline is cut where it enters the marks GROWN by the stroke's reach —
    half the line width times sqrt(2) in device space, which bounds a square
    cap's corner — so no part of the painted stroke body touches a mark. A
    miter join can spike out to half the width times the miter limit; a kept
    vertex that close to a mark ends its piece there instead of joining. A
    dash pattern restarts at each subpath, so each piece gets the phase the
    original stroke had at that point.
  - CLIP (W n, W* n, and a W on a painted path): the clip path loses the marks
    too, so a clip shaped like the redacted content (outlined text used as a
    knockout) does not keep that shape in the file. A clip that loses
    everything becomes an EMPTY clip, never no clip — dropping it would make
    visible whatever it was hiding.
  - A path painted with `n` and no clip draws nothing; one the marks reach
    goes, since its geometry is content under the mark all the same.

Subpaths no mark reaches are emitted with their ORIGINAL operators, curves and
all; only the subpaths a mark touches are flattened (to a twentieth of a device
unit), because a curve cut at a mark has to become lines somewhere and only
there.
"""

from __future__ import annotations

import math
from typing import NamedTuple

import pikepdf

from engine import redact_geometry

_FLATNESS = 0.05
_MAX_DEPTH = 12
PATH_OPS = frozenset({"m", "l", "c", "v", "y", "re", "h"})
PAINT_OPS = frozenset({"S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"})
_FILL = {"f": "f", "F": "f", "f*": "f*", "B": "f", "B*": "f*", "b": "f", "b*": "f*"}
_STROKE = frozenset({"S", "s", "B", "B*", "b", "b*"})
_CLOSES_LAST = frozenset({"s", "b", "b*"})


class StrokeStyle(NamedTuple):
    width: float = 1.0
    cap: int = 0
    join: int = 0
    miter: float = 10.0
    dash: tuple = ()
    phase: float = 0.0


class _Subpath:
    __slots__ = ("ops", "points", "closed", "control")

    def __init__(self):
        self.ops: list = []  # the original instructions, user space
        self.points: list = []  # flattened polyline, device space
        self.closed = False
        self.control: list = []  # every control point, device space


def _op(name: str, *operands):
    return pikepdf.ContentStreamInstruction(list(operands), pikepdf.Operator(name))


def _apply(m, x: float, y: float) -> tuple:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def _invert(m):
    a, b, c, d, e, f = m
    det = a * d - b * c
    if abs(det) < 1e-12:
        return None
    return (d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)


def _flatten_cubic(p0, p1, p2, p3, out: list, depth: int = 0) -> None:
    dx, dy = p3[0] - p0[0], p3[1] - p0[1]
    length = math.hypot(dx, dy)
    if length > 0:
        d1 = abs((p1[0] - p0[0]) * dy - (p1[1] - p0[1]) * dx) / length
        d2 = abs((p2[0] - p0[0]) * dy - (p2[1] - p0[1]) * dx) / length
    else:
        d1 = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        d2 = math.hypot(p2[0] - p0[0], p2[1] - p0[1])
    if max(d1, d2) <= _FLATNESS or depth >= _MAX_DEPTH:
        out.append(p3)
        return
    m01 = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    m12 = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
    m23 = ((p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2)
    a = ((m01[0] + m12[0]) / 2, (m01[1] + m12[1]) / 2)
    b = ((m12[0] + m23[0]) / 2, (m12[1] + m23[1]) / 2)
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    _flatten_cubic(p0, m01, a, mid, out, depth + 1)
    _flatten_cubic(mid, b, m23, p3, out, depth + 1)


def build_subpaths(instructions, ctm) -> list:
    """The path's subpaths, each with its own operators and a device-space
    polyline. A lone moveto paints nothing and is left out."""
    subpaths: list = []
    current = None
    start_user = None
    point_user = None

    def begin(point):
        nonlocal current, start_user, point_user
        current = _Subpath()
        subpaths.append(current)
        point_user = point
        start_user = point
        device = _apply(ctm, *point)
        current.points.append(device)
        current.control.append(device)

    for instruction in instructions:
        op = str(instruction.operator)
        args = [float(v) for v in instruction.operands]
        if op == "m":
            begin((args[0], args[1]))
            current.ops.append(instruction)
        elif op == "re":
            x, y, w, h = args
            begin((x, y))
            current.points = [_apply(ctm, *p) for p in ((x, y), (x + w, y), (x + w, y + h), (x, y + h))]
            current.control = list(current.points)
            current.closed = True
            current.ops.append(instruction)
            current = None
        elif op in ("l", "c", "v", "y"):
            if current is None:
                begin(point_user if point_user is not None else (args[0], args[1]))
                current.ops.append(_op("m", point_user[0], point_user[1]))
            current.ops.append(instruction)
            if op == "l":
                point_user = (args[0], args[1])
                device = _apply(ctm, *point_user)
                current.points.append(device)
                current.control.append(device)
                continue
            if op == "c":
                c1, c2, end = (args[0], args[1]), (args[2], args[3]), (args[4], args[5])
            elif op == "v":
                c1, c2, end = point_user, (args[0], args[1]), (args[2], args[3])
            else:
                c1, c2, end = (args[0], args[1]), (args[2], args[3]), (args[2], args[3])
            d0 = _apply(ctm, *point_user)
            d1, d2, d3 = _apply(ctm, *c1), _apply(ctm, *c2), _apply(ctm, *end)
            current.control.extend((d1, d2, d3))
            _flatten_cubic(d0, d1, d2, d3, current.points)
            point_user = end
        elif op == "h":
            if current is not None:
                current.ops.append(instruction)
                current.closed = True
                # After h the current point is the subpath's start, and a
                # segment that follows begins a new subpath there.
                point_user = start_user
                current = None
    return [sp for sp in subpaths if not (len(sp.ops) == 1 and str(sp.ops[0].operator) == "m")]


def _meets(box, rects) -> bool:
    if box is None:
        return False
    return any(not (box[2] < r[0] or r[2] < box[0] or box[3] < r[1] or r[3] < box[1]) for r in rects)


def _scale(ctm) -> float:
    """An upper bound on how far the CTM stretches a unit length."""
    a, b, c, d, _e, _f = ctm
    return math.sqrt(a * a + b * b + c * c + d * d)


def _half_width(style: StrokeStyle, ctm) -> float:
    # Width 0 is "the thinnest line the device can draw"; one unit covers it
    # on any device coarser than 72 dpi and over-removes a hair on finer ones.
    return max(style.width * _scale(ctm), 1.0) / 2.0


def _stroke_reach(style: StrokeStyle, ctm) -> float:
    return _half_width(style, ctm) * math.sqrt(2.0)


def _join_reach(style: StrokeStyle, ctm) -> float:
    if style.join != 0:
        return _stroke_reach(style, ctm)
    return _half_width(style, ctm) * max(style.miter, math.sqrt(2.0))


def _distance_to_rect(p, rect) -> float:
    dx = max(rect[0] - p[0], 0.0, p[0] - rect[2])
    dy = max(rect[1] - p[1], 0.0, p[1] - rect[3])
    return math.hypot(dx, dy)


def _fmt(value: float) -> float:
    rounded = round(value, 6)
    return 0.0 if rounded == 0 else rounded


def _emit_polyline(points_user, closed: bool) -> list:
    out = [_op("m", _fmt(points_user[0][0]), _fmt(points_user[0][1]))]
    for x, y in points_user[1:]:
        out.append(_op("l", _fmt(x), _fmt(y)))
    if closed:
        out.append(_op("h"))
    return out


def _to_user(points, inverse):
    return [_apply(inverse, x, y) for x, y in points]


def _fill_body(subpaths, rects, inverse):
    """Instructions for the filled area outside the marks; whether any
    subpath was cut."""
    out: list = []
    cut = False
    for subpath in subpaths:
        if not _meets(redact_geometry.bbox(subpath.control), rects):
            out.extend(subpath.ops)
            continue
        cut = True
        if len(subpath.points) < 3:
            continue
        for piece in redact_geometry.minus_rects(list(subpath.points), rects):
            out.extend(_emit_polyline(_to_user(piece, inverse), True))
    return out, cut


def _stroke_body(subpaths, rects, style: StrokeStyle, ctm, inverse):
    """`(pieces, cut)`. A piece is `(instructions, dash offset)`, the offset
    None for a subpath kept whole."""
    reach = _stroke_reach(style, ctm)
    join = _join_reach(style, ctm)
    grown = [redact_geometry.expand(r, reach) for r in rects]
    pieces: list = []
    cut = False
    for subpath in subpaths:
        box = redact_geometry.bbox(subpath.control)
        if box is None or not _meets(redact_geometry.expand(box, max(reach, join)), rects):
            pieces.append((list(subpath.ops), None))
            continue
        cut = True
        points = list(subpath.points)
        if subpath.closed and points[0] != points[-1]:
            points.append(points[0])
        if len(points) == 1:
            points = points * 2
        run: list = []
        run_start = 0.0
        travelled = 0.0
        unbroken = True

        def flush():
            nonlocal run
            if len(run) > 1:
                pieces.append((_emit_polyline(_to_user(run, inverse), False), run_start))
            run = []

        last_index = len(points) - 2
        for index in range(len(points) - 1):
            p, q = points[index], points[index + 1]
            # The dash pattern is measured along the path in USER space, so
            # the distance travelled is taken there.
            dx, dy = q[0] - p[0], q[1] - p[1]
            length = math.hypot(inverse[0] * dx + inverse[2] * dy, inverse[1] * dx + inverse[3] * dy)
            intervals = redact_geometry.segment_outside_rects(p, q, grown)
            if intervals != [(0.0, 1.0)]:
                unbroken = False
            for t0, t1 in intervals:
                a = (p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0)
                b = (p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1)
                if t0 > 0.0 and run:
                    flush()
                if not run:
                    run = [a]
                    run_start = travelled + length * t0
                run.append(b)
                if t1 < 1.0:
                    flush()
            travelled += length
            if run and index < last_index:
                vertex = points[index + 1]
                if any(_distance_to_rect(vertex, r) <= join for r in rects):
                    unbroken = False
                    flush()
        if unbroken and subpath.closed and len(run) > 1:
            # The centreline never met a mark: keep the loop's closing join.
            pieces.append((_emit_polyline(_to_user(run[:-1], inverse), True), run_start))
            run = []
        flush()
    return pieces, cut


def control_box(construction, ctm):
    """The device-space box of every point the path's operators name — a
    superset of the path, since a Bezier lies inside its control points."""
    points = []
    for instruction in construction:
        args = [float(v) for v in instruction.operands]
        if str(instruction.operator) == "re" and len(args) == 4:
            x, y, w, h = args
            points.extend(_apply(ctm, px, py) for px, py in ((x, y), (x + w, y), (x + w, y + h), (x, y + h)))
            continue
        for index in range(0, len(args) - 1, 2):
            points.append(_apply(ctm, args[index], args[index + 1]))
    return redact_geometry.bbox(points)


def redact_path(construction, paint, clip, ctm, style: StrokeStyle, rects):
    """Replacement instructions for one path object, or None to keep it.

    `construction` are its m/l/c/v/y/re/h instructions, `paint` the painting
    instruction, `clip` the W or W* between them (or None).
    """
    paint_op = str(paint.operator)
    quick = control_box(construction, ctm)
    if quick is None:
        return None
    margin = 0.0
    if paint_op in _STROKE:
        margin = max(_stroke_reach(style, ctm), _join_reach(style, ctm))
    if not _meets(redact_geometry.expand(quick, margin), rects):
        return None
    subpaths = build_subpaths(construction, ctm)
    if paint_op in _CLOSES_LAST and subpaths and not subpaths[-1].closed:
        # `s`, `b` and `b*` close the LAST subpath only.
        subpaths[-1].ops.append(_op("h"))
        subpaths[-1].closed = True
    box = redact_geometry.bbox(p for sp in subpaths for p in sp.control)
    if box is None:
        return None
    reach = 0.0
    if paint_op in _STROKE:
        reach = max(_stroke_reach(style, ctm), _join_reach(style, ctm))
    if not _meets(redact_geometry.expand(box, reach), rects):
        return None
    inverse = _invert(ctm)
    if inverse is None:
        # A singular CTM paints a line at most; the path goes whole.
        return []
    if paint_op == "n" and clip is None:
        return []

    out: list = []
    changed = False
    if paint_op in _FILL:
        body, cut = _fill_body(subpaths, rects, inverse)
        changed |= cut
        if body:
            out.extend(body)
            out.append(_op(_FILL[paint_op]))
    if paint_op in _STROKE:
        pieces, cut = _stroke_body(subpaths, rects, style, ctm, inverse)
        changed |= cut
        if pieces:
            if style.dash:
                for ops, offset in pieces:
                    if offset is None:
                        out.extend(ops)
                        out.append(_op("S"))
                        continue
                    out.append(_op("q"))
                    out.append(
                        _op("d", pikepdf.Array([_fmt(v) for v in style.dash]), _fmt(style.phase + offset))
                    )
                    out.extend(ops)
                    out.append(_op("S"))
                    out.append(_op("Q"))
            else:
                for ops, _offset in pieces:
                    out.extend(ops)
                out.append(_op("S"))
    if clip is not None:
        body, cut = _fill_body(subpaths, rects, inverse)
        changed |= cut
        out.extend(body if body else [_op("re", 0, 0, 0, 0)])
        out.append(_op(str(clip.operator)))
        out.append(_op("n"))
    if not changed:
        return None
    return out
