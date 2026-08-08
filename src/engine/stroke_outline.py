"""Stroked paths as filled outlines.

The stroke of a path is the set of points within half the line width of it,
extended by the join and cap rules. That set is built here as MANY subpaths —
one quadrilateral per flattened segment, one polygon per join, one per cap —
all wound the same direction and meant to be filled with the NONZERO rule.

Nonzero winding over consistently-wound pieces IS their union: overlapping
pieces accumulate winding at least 1 and fill. So no boolean library is
involved and the result is exact rather than an approximation of a union.

Everything happens in USER space, where the pen is circular of diameter `w`
whatever the CTM does. An anisotropic or skewed CTM then transforms the filled
outline exactly as it transformed the stroke; building in device space would
have needed an elliptical pen.
"""

from __future__ import annotations

import math

from .bezier import flatten_cubic

# Line caps and joins, by their PDF operand values.
CAP_BUTT, CAP_ROUND, CAP_SQUARE = 0, 1, 2
JOIN_MITER, JOIN_ROUND, JOIN_BEVEL = 0, 1, 2

# Arc approximation is bounded by the same tolerance the curve flattening
# uses, between these two segment counts: below 8 a round cap reads as a
# polygon at any size, above 256 the payload grows for a difference no device
# resolves.
_MIN_ARC_SEGMENTS = 8
_MAX_ARC_SEGMENTS = 256

# Two directions closer than this in the cross/dot sense are collinear: no
# join is drawn, because the segment quads already meet flush.
_COLLINEAR = 1e-12


def _norm(vector) -> float:
    return math.hypot(vector[0], vector[1])


def _unit(vector):
    length = _norm(vector)
    if length < 1e-12:
        return None
    return (vector[0] / length, vector[1] / length)


def _left_normal(direction):
    return (-direction[1], direction[0])


def _signed_area(points) -> float:
    total = 0.0
    for i, (x0, y0) in enumerate(points):
        x1, y1 = points[(i + 1) % len(points)]
        total += x0 * y1 - x1 * y0
    return total / 2.0


def _ccw(points):
    """The polygon wound counter-clockwise. Consistent winding is what makes
    the nonzero fill a union; a single reversed piece would punch a hole
    through everything it overlaps."""
    if len(points) < 3:
        return None
    if _signed_area(points) < 0:
        return list(reversed(points))
    return list(points)


def _arc_segments(radius: float, tol: float) -> int:
    """Segments per full circle whose chord sags no more than `tol`."""
    if radius <= 0 or tol <= 0:
        return _MIN_ARC_SEGMENTS
    ratio = 1.0 - min(tol / radius, 1.0)
    if ratio <= -1.0:
        return _MIN_ARC_SEGMENTS
    half = math.acos(max(-1.0, min(1.0, ratio)))
    if half <= 1e-9:
        return _MAX_ARC_SEGMENTS
    count = int(math.ceil(math.pi / half))
    return max(_MIN_ARC_SEGMENTS, min(_MAX_ARC_SEGMENTS, count))


def _disc(centre, radius: float, tol: float):
    """A polygon covering the disc. At a vertex of a round-joined stroke the
    WHOLE disc is inside the stroke — every point within `radius` of the path
    is — so the round join needs no sector arithmetic."""
    count = _arc_segments(radius, tol)
    cx, cy = centre
    return [
        (cx + radius * math.cos(2.0 * math.pi * i / count),
         cy + radius * math.sin(2.0 * math.pi * i / count))
        for i in range(count)
    ]


def _half_disc(end, direction, radius: float, tol: float):
    """A round cap: the half-disc beyond `end` in `direction`, closed across
    the stroke's own width."""
    count = max(2, _arc_segments(radius, tol) // 2)
    base = math.atan2(direction[1], direction[0])
    points = []
    for i in range(count + 1):
        angle = base - math.pi / 2.0 + math.pi * i / count
        points.append((end[0] + radius * math.cos(angle),
                       end[1] + radius * math.sin(angle)))
    return points


# ── flattening ─────────────────────────────────────────────────────────────


def flatten_subpath(segments, tol: float):
    """A constructed subpath as a polyline.

    `segments` is the grammar the content walk produces: ("m", pt), ("l", pt),
    ("c", (p1, p2, p3)), ("h",). The returned polyline carries no duplicate
    consecutive points, because a zero-length segment has no direction and
    would poison every normal computed from it.
    """
    points: list[tuple[float, float]] = []
    closed = False

    def push(point):
        if points and abs(point[0] - points[-1][0]) < 1e-12 and abs(point[1] - points[-1][1]) < 1e-12:
            return
        points.append((float(point[0]), float(point[1])))

    for segment in segments:
        kind = segment[0]
        if kind == "m":
            push(segment[1])
        elif kind == "l":
            push(segment[1])
        elif kind == "c":
            if not points:
                continue
            for point in flatten_cubic(points[-1], *segment[1], tol=tol):
                push(point)
        elif kind == "h":
            closed = True
    if closed and len(points) > 1:
        first, last = points[0], points[-1]
        if abs(first[0] - last[0]) < 1e-12 and abs(first[1] - last[1]) < 1e-12:
            points.pop()
    return points, closed


# ── dashes ─────────────────────────────────────────────────────────────────


def dash_polyline(points, closed: bool, pattern, phase: float):
    """The polyline cut into the dash pattern's ON pieces.

    Segmenting by arc length is what PRESERVES the dash: the pattern is spent
    here and the outline that follows knows nothing about it, so each dash gets
    its own caps exactly as the stroked original did.
    """
    values = [abs(float(v)) for v in pattern if float(v) >= 0]
    if not values or sum(values) <= 0:
        return [(list(points), closed)]
    walk = list(points) + ([points[0]] if closed and len(points) > 1 else [])
    if len(walk) < 2:
        return [(list(points), False)]

    index = 0
    on = True
    remaining = values[0]
    offset = float(phase) % (sum(values) * (2 if len(values) % 2 else 1))
    while offset > 0:
        step = min(offset, remaining)
        remaining -= step
        offset -= step
        if remaining <= 1e-12:
            index = (index + 1) % len(values)
            remaining = values[index]
            on = not on

    out: list[tuple[list, bool]] = []
    current: list = [walk[0]] if on else []
    for i in range(len(walk) - 1):
        start, end = walk[i], walk[i + 1]
        length = math.hypot(end[0] - start[0], end[1] - start[1])
        travelled = 0.0
        while length - travelled > 1e-12:
            step = min(remaining, length - travelled)
            travelled += step
            remaining -= step
            point = (start[0] + (end[0] - start[0]) * travelled / length,
                     start[1] + (end[1] - start[1]) * travelled / length)
            if on:
                current.append(point)
            if remaining <= 1e-12:
                if on and len(current) > 0:
                    out.append((current, False))
                index = (index + 1) % len(values)
                remaining = values[index]
                on = not on
                current = [point] if on else []
    # A trailing piece needs two points. The pattern can toggle ON exactly at
    # the polyline's last point, which opens a piece with no extent inside the
    # path — a phantom dot under round caps. A zero-length dash written INTO
    # the pattern (`[0 6] 0 d`, the dotted-line idiom) is a different thing and
    # is emitted inside the loop above, where its dot is real.
    if on and len(current) >= 2:
        out.append((current, False))
    return out


# ── the outline ────────────────────────────────────────────────────────────


def _join_polygons(vertex, incoming, outgoing, half: float, join: int,
                   miter_limit: float, tol: float):
    """The polygon(s) closing the wedge two segments leave on their outer side."""
    d1, d2 = _unit(incoming), _unit(outgoing)
    if d1 is None or d2 is None:
        return []
    cross = d1[0] * d2[1] - d1[1] * d2[0]
    dot = d1[0] * d2[0] + d1[1] * d2[1]
    if abs(cross) < _COLLINEAR and dot > 0:
        return []  # straight through: the quads already meet
    if join == JOIN_ROUND:
        return [_disc(vertex, half, tol)]
    n1 = _left_normal(d1)
    n2 = _left_normal(d2)
    sign = -1.0 if cross > 0 else 1.0
    o1 = (sign * n1[0] * half, sign * n1[1] * half)
    o2 = (sign * n2[0] * half, sign * n2[1] * half)
    p1 = (vertex[0] + o1[0], vertex[1] + o1[1])
    p2 = (vertex[0] + o2[0], vertex[1] + o2[1])
    bevel = [vertex, p1, p2]
    if join == JOIN_BEVEL:
        return [bevel]
    bisector = _unit((o1[0] + o2[0], o1[1] + o2[1]))
    if bisector is None:
        # A 180° reversal has no miter; the spec's own answer is the bevel,
        # which here is degenerate, so the cusp is closed by the two quads.
        return [bevel]
    unit_o1 = _unit(o1)
    cos_half = unit_o1[0] * bisector[0] + unit_o1[1] * bisector[1]
    if cos_half <= 1e-9 or 1.0 / cos_half > float(miter_limit):
        return [bevel]
    length = half / cos_half
    tip = (vertex[0] + bisector[0] * length, vertex[1] + bisector[1] * length)
    return [[vertex, p1, tip, p2]]


def _cap_polygon(end, direction, half: float, cap: int, tol: float):
    if cap == CAP_BUTT:
        return []
    if cap == CAP_ROUND:
        return [_half_disc(end, direction, half, tol)]
    normal = _left_normal(direction)
    a = (end[0] + normal[0] * half, end[1] + normal[1] * half)
    b = (a[0] + direction[0] * half, a[1] + direction[1] * half)
    d = (end[0] - normal[0] * half, end[1] - normal[1] * half)
    c = (d[0] + direction[0] * half, d[1] + direction[1] * half)
    return [[a, b, c, d]]


def _degenerate(point, half: float, cap: int, tol: float):
    """A subpath with no length. Round caps draw a dot, projecting caps a
    square, butt caps nothing — the spec's three answers, all three here."""
    if cap == CAP_ROUND:
        return [_disc(point, half, tol)]
    if cap == CAP_SQUARE:
        x, y = point
        return [[(x - half, y - half), (x + half, y - half),
                 (x + half, y + half), (x - half, y + half)]]
    return []


def stroke_polyline(points, closed: bool, width: float, cap: int, join: int,
                    miter_limit: float, tol: float):
    """One polyline's stroke, as consistently-wound polygons."""
    half = abs(float(width)) / 2.0
    if half <= 0:
        return []
    # Consecutive duplicates carry no direction, and a dash piece routinely
    # arrives as two copies of one point (the `[0 6] 0 d` dotted idiom). Left
    # in, every normal computed from them is undefined and the piece draws
    # nothing at all.
    unique: list = []
    for point in points:
        if unique and abs(point[0] - unique[-1][0]) < 1e-12 \
                and abs(point[1] - unique[-1][1]) < 1e-12:
            continue
        unique.append(point)
    if len(unique) < 2:
        return _degenerate(unique[0], half, cap, tol) if unique else []

    polygons: list[list] = []
    ring = list(unique) + ([unique[0]] if closed else [])
    for i in range(len(ring) - 1):
        start, end = ring[i], ring[i + 1]
        direction = _unit((end[0] - start[0], end[1] - start[1]))
        if direction is None:
            continue
        normal = _left_normal(direction)
        offset = (normal[0] * half, normal[1] * half)
        polygons.append([
            (start[0] + offset[0], start[1] + offset[1]),
            (end[0] + offset[0], end[1] + offset[1]),
            (end[0] - offset[0], end[1] - offset[1]),
            (start[0] - offset[0], start[1] - offset[1]),
        ])

    count = len(ring) - 1
    first = 0 if closed else 1
    for i in range(first, count):
        vertex = ring[i]
        # A closed ring repeats its first point, so `ring[i - 1]` at i = 0 is
        # the vertex itself: a zero-length incoming direction, no join, and a
        # square corner silently missing from every closed stroke.
        previous = ring[i - 1] if i > 0 else unique[-1]
        following = ring[i + 1]
        polygons.extend(_join_polygons(
            vertex,
            (vertex[0] - previous[0], vertex[1] - previous[1]),
            (following[0] - vertex[0], following[1] - vertex[1]),
            half, join, miter_limit, tol,
        ))

    if not closed:
        start_direction = _unit((unique[0][0] - unique[1][0], unique[0][1] - unique[1][1]))
        end_direction = _unit((unique[-1][0] - unique[-2][0], unique[-1][1] - unique[-2][1]))
        if start_direction is not None:
            polygons.extend(_cap_polygon(unique[0], start_direction, half, cap, tol))
        if end_direction is not None:
            polygons.extend(_cap_polygon(unique[-1], end_direction, half, cap, tol))

    out = []
    for polygon in polygons:
        wound = _ccw(polygon)
        if wound is not None:
            out.append(wound)
    return out


def stroke_outline(subpaths, width: float, cap: int, join: int,
                   miter_limit: float, dash, phase: float, tol: float):
    """Every subpath's stroke, as polygons ready to be filled nonzero.

    `subpaths` is the construction grammar (§ `flatten_subpath`). The returned
    polygons are in the same user space the construction was in.
    """
    polygons: list[list] = []
    for segments in subpaths:
        points, closed = flatten_subpath(segments, tol)
        if not points:
            continue
        for piece, piece_closed in dash_polyline(points, closed, dash or (), phase):
            polygons.extend(stroke_polyline(
                piece, piece_closed, width, cap, join, miter_limit, tol
            ))
    return polygons
