"""Exact polygon arithmetic for redaction: convex clipping and the difference
of a polygon and a set of axis-aligned rectangles.

Redaction regions are axis-aligned rectangles in page space. Everything the
redactor removes from — a pixel's footprint, a placed image's unit square, a
filled path — becomes a polygon in that same space, and the questions asked of
it are "is any of this outside the marks?" and "what is left once the marks are
taken out?". Both reduce to one operation: subtracting a rectangle from a
polygon.

The complement of a rectangle is the disjoint union of four convex regions —
everything left of it, everything right of it, and the parts of the middle
column below and above it — so `P minus R` is `P` clipped to each of the four
in turn. Sutherland–Hodgman clipping against a convex region preserves every
point's winding number inside that region, so clipping each subpath of a
compound path and keeping its fill rule leaves the fill correct under both the
nonzero and the even-odd rule.
"""

from __future__ import annotations

from typing import Iterable, Sequence

Point = tuple[float, float]
Polygon = list[Point]
Rect = tuple[float, float, float, float]

# A clipped piece with less area than this fraction of its source is floating
# point residue on a shared edge, not a region anything could be drawn in.
_AREA_EPSILON = 1e-12


def area(poly: Sequence[Point]) -> float:
    """Unsigned shoelace area."""
    count = len(poly)
    if count < 3:
        return 0.0
    total = 0.0
    for index in range(count):
        x0, y0 = poly[index - 1]
        x1, y1 = poly[index]
        total += x0 * y1 - x1 * y0
    return abs(total) / 2.0


def signed_area(poly: Sequence[Point]) -> float:
    count = len(poly)
    total = 0.0
    for index in range(count):
        x0, y0 = poly[index - 1]
        x1, y1 = poly[index]
        total += x0 * y1 - x1 * y0
    return total / 2.0


def bbox(points: Iterable[Point]) -> Rect | None:
    xs: list[float] = []
    ys: list[float] = []
    for x, y in points:
        xs.append(x)
        ys.append(y)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def _clip_half_plane(poly: Polygon, inside, crossing) -> Polygon:
    """One Sutherland–Hodgman step. `inside(p)` tests the kept side;
    `crossing(p, q)` is the intersection of segment pq with the boundary."""
    if not poly:
        return []
    out: Polygon = []
    previous = poly[-1]
    previous_in = inside(previous)
    for current in poly:
        current_in = inside(current)
        if current_in:
            if not previous_in:
                out.append(crossing(previous, current))
            out.append(current)
        elif previous_in:
            out.append(crossing(previous, current))
        previous, previous_in = current, current_in
    return out


def _at_x(value: float):
    def crossing(p: Point, q: Point) -> Point:
        t = (value - p[0]) / (q[0] - p[0])
        return (value, p[1] + t * (q[1] - p[1]))

    return crossing


def _at_y(value: float):
    def crossing(p: Point, q: Point) -> Point:
        t = (value - p[1]) / (q[1] - p[1])
        return (p[0] + t * (q[0] - p[0]), value)

    return crossing


def clip_to_rect(poly: Polygon, rect: Rect) -> Polygon:
    """The part of `poly` inside `rect` (closed)."""
    x0, y0, x1, y1 = rect
    out = _clip_half_plane(poly, lambda p: p[0] >= x0, _at_x(x0))
    out = _clip_half_plane(out, lambda p: p[0] <= x1, _at_x(x1))
    out = _clip_half_plane(out, lambda p: p[1] >= y0, _at_y(y0))
    out = _clip_half_plane(out, lambda p: p[1] <= y1, _at_y(y1))
    return out


def minus_rect(poly: Polygon, rect: Rect) -> list[Polygon]:
    """`poly` with `rect` taken out, as up to four pieces.

    The pieces are the polygon clipped to the four disjoint convex parts of the
    rectangle's complement. For a convex `poly` every piece is convex; for a
    non-convex (or self-intersecting) subpath each piece keeps the winding of
    every point inside its part, which is what a fill rule reads.
    """
    x0, y0, x1, y1 = rect
    pieces: list[Polygon] = []
    left = _clip_half_plane(poly, lambda p: p[0] <= x0, _at_x(x0))
    right = _clip_half_plane(poly, lambda p: p[0] >= x1, _at_x(x1))
    middle = _clip_half_plane(poly, lambda p: p[0] >= x0, _at_x(x0))
    middle = _clip_half_plane(middle, lambda p: p[0] <= x1, _at_x(x1))
    below = _clip_half_plane(middle, lambda p: p[1] <= y0, _at_y(y0))
    above = _clip_half_plane(middle, lambda p: p[1] >= y1, _at_y(y1))
    reference = max(area(poly), 1e-300)
    for piece in (left, right, below, above):
        if len(piece) >= 3 and area(piece) > _AREA_EPSILON * reference:
            pieces.append(piece)
    return pieces


def minus_rects(poly: Polygon, rects: Sequence[Rect]) -> list[Polygon]:
    """`poly` with every rectangle taken out.

    Pieces are only split against a rectangle they actually meet, so the piece
    count grows with the rectangles that cut the polygon rather than
    exponentially with how many there are.
    """
    pieces = [poly]
    for rect in rects:
        next_pieces: list[Polygon] = []
        for piece in pieces:
            box = bbox(piece)
            if box is None:
                continue
            if box[2] <= rect[0] or rect[2] <= box[0] or box[3] <= rect[1] or rect[3] <= box[1]:
                next_pieces.append(piece)
                continue
            next_pieces.extend(minus_rect(piece, rect))
        pieces = next_pieces
        if not pieces:
            break
    return pieces


def covered(poly: Polygon, rects: Sequence[Rect]) -> bool:
    """Is every point of `poly` inside the union of `rects`?"""
    return not minus_rects(poly, rects)


def point_in_rects(x: float, y: float, rects: Sequence[Rect]) -> bool:
    return any(r[0] <= x <= r[2] and r[1] <= y <= r[3] for r in rects)


def segment_outside_rects(p: Point, q: Point, rects: Sequence[Rect]) -> list[tuple[float, float]]:
    """The parameter intervals of segment pq (t in [0, 1]) that lie OUTSIDE
    every rectangle — the parts of a stroked segment that survive the marks.

    Liang–Barsky per rectangle gives the inside interval; the outside set is
    the complement of their union.
    """
    inside: list[tuple[float, float]] = []
    dx = q[0] - p[0]
    dy = q[1] - p[1]
    for x0, y0, x1, y1 in rects:
        t0, t1 = 0.0, 1.0
        ok = True
        for pk, qk in ((-dx, p[0] - x0), (dx, x1 - p[0]), (-dy, p[1] - y0), (dy, y1 - p[1])):
            if pk == 0.0:
                if qk < 0.0:
                    ok = False
                    break
                continue
            r = qk / pk
            if pk < 0.0:
                if r > t1:
                    ok = False
                    break
                if r > t0:
                    t0 = r
            else:
                if r < t0:
                    ok = False
                    break
                if r < t1:
                    t1 = r
        if ok and t1 > t0:
            inside.append((t0, t1))
    if not inside:
        return [(0.0, 1.0)]
    inside.sort()
    merged: list[list[float]] = []
    for lo, hi in inside:
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    outside: list[tuple[float, float]] = []
    cursor = 0.0
    for lo, hi in merged:
        if lo > cursor:
            outside.append((cursor, lo))
        cursor = max(cursor, hi)
    if cursor < 1.0:
        outside.append((cursor, 1.0))
    return [(lo, hi) for lo, hi in outside if hi - lo > 1e-12]


def expand(rect: Rect, by: float) -> Rect:
    return (rect[0] - by, rect[1] - by, rect[2] + by, rect[3] + by)
