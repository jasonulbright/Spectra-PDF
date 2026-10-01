"""Reading order of a page's text across text orientations.

Every engine path that turns a page into ordered text reads it through this
module: the pdfminer layout path (`extract_text`), the run walk
(`search_regions`, and through it form detection and document redaction) and
the read-aloud blocks.

A unit of text (a character, a show operator, a block) reads in the direction
its pen advances. That direction is the glyph x axis of the text rendering
matrix for a horizontal font and the glyph -y axis for a font in vertical
writing mode (ISO 32000-2 §9.4.4, §9.7.4.3; the writing mode is the CMap's
WMode, §9.7.5). The page's /Rotate turns the page clockwise for display
(§7.7.3.3, Table 31) and is inheritable (§7.7.3.4), so an angle in user space
less the rotation is the angle the reader sees. Table 31 requires a multiple
of 90; any other value reads as no rotation, as the renderer displays it.

Units are partitioned by display orientation. Each partition is laid out in
its own upright frame: the frame where its pen advances along +x and its lines
stack toward -y. The partition that carries the most characters reads first;
equal counts read in ascending display angle, then unreflected before
reflected. Right-to-left paragraphs are not reordered here: a frame is a
geometric rotation and leaves the visual-to-logical boundary to `bidi`.

`src/renderer/search/text-order.ts` applies the same rule to pdf.js text
items; `tests/fixtures/reading-order-corpus.json` holds both to one table.
"""

from __future__ import annotations

import math
from decimal import Decimal
from typing import Callable, Iterable, Sequence, TypeVar

T = TypeVar("T")
Key = tuple[float, bool]

AXIS_TOLERANCE = 3.0
"""Degrees within which an angle counts as the nearest multiple of 90: a
deskewed scan's text layer leans by a fraction of a degree per line."""

CHAIN_TOLERANCE = 8.0
"""Degrees between neighbouring off-axis angles that still read as one
orientation: text set on an arc turns a few degrees per glyph."""

MIN_ORIENTED_CHARS = 3
"""An off-axis orientation with fewer characters reads with the upright text,
so a stray glyph costs no layout pass of its own."""

LINE_TOL_EM = 0.12
"""Ems of the larger unit within which two baselines share a line: the
paragraph lister's own same-baseline window."""

UPRIGHT: Key = (0.0, False)


def rotation_degrees(value) -> int:
    """A /Rotate value as the clockwise display rotation in {0, 90, 180,
    270}. A value that is not a number, or not a whole multiple of 90, is
    0: the renderer displays such a page unrotated, and every reader of the
    page's text takes the rotation the user sees."""
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        return 0
    try:
        if value % 90 != 0:
            return 0
        return int(value) % 360
    except (ArithmeticError, ValueError):
        return 0


def page_rotation(page) -> int:
    """The page's `rotation_degrees`, its /Rotate inherited through /Parent
    when the page object omits it. `page` is a page dictionary or a pikepdf
    page."""
    node = getattr(page, "obj", page)
    seen = 0
    while node is not None and seen < 64:
        try:
            value = node.get("/Rotate")
        except Exception:
            return 0
        if value is not None:
            return rotation_degrees(value)
        try:
            node = node.get("/Parent")
        except Exception:
            return 0
        seen += 1
    return 0


def orientation(a: float, b: float, c: float, d: float, vertical: bool = False, rotate: int = 0) -> Key:
    """The display-space direction a unit's pen advances, in degrees
    counter-clockwise in [0, 360), and whether its glyph space is reflected.

    (a, b, c, d) is the linear part of the text rendering matrix in user space
    (or in device space with `rotate` 0, when the matrix already carries the
    page rotation)."""
    vx, vy = (-c, -d) if vertical else (a, b)
    if vx == 0 and vy == 0:
        return float(-rotate % 360), False
    angle = (math.degrees(math.atan2(vy, vx)) - rotate) % 360.0
    return angle, a * d - b * c < 0


def user_frame(key: Key, rotate: int) -> Key:
    """The user-space frame of the display orientation `key`."""
    return (key[0] + rotate) % 360.0, key[1]


def _circular_mean(angles: list[float]) -> float:
    x = sum(math.cos(math.radians(angle)) for angle in angles)
    y = sum(math.sin(math.radians(angle)) for angle in angles)
    return round(math.degrees(math.atan2(y, x)) % 360.0, 6)


def partition(
    items: Sequence[T],
    key_of: Callable[[T], Key],
    weight_of: Callable[[T], int],
    min_chars: int = MIN_ORIENTED_CHARS,
) -> list[tuple[Key, list[T]]]:
    """`items` grouped by orientation, in reading order of the groups, each
    group keeping the input order of its members.

    An angle within `AXIS_TOLERANCE` of a multiple of 90 is that multiple.
    Other angles of one reflection sort around the circle and chain while
    neighbours lie within `CHAIN_TOLERANCE`; a chain reads in the frame of its
    mean angle. A chain weighing under `min_chars` joins the upright group."""
    parts: dict[Key, list[int]] = {}
    loose: dict[bool, list[tuple[float, int]]] = {}
    for index, item in enumerate(items):
        angle, reflected = key_of(item)
        axis = (round(angle / 90.0) * 90) % 360
        if abs(((angle - axis + 180.0) % 360.0) - 180.0) <= AXIS_TOLERANCE:
            parts.setdefault((float(axis), reflected), []).append(index)
        else:
            loose.setdefault(reflected, []).append((angle, index))
    strays: list[int] = []
    for reflected in sorted(loose):
        entries = sorted(loose[reflected], key=lambda entry: entry[0])
        chains = [[entries[0]]]
        for entry in entries[1:]:
            if entry[0] - chains[-1][-1][0] <= CHAIN_TOLERANCE:
                chains[-1].append(entry)
            else:
                chains.append([entry])
        if len(chains) > 1 and entries[0][0] + 360.0 - entries[-1][0] <= CHAIN_TOLERANCE:
            chains[0] = chains.pop() + chains[0]
        for chain in chains:
            members = [index for _angle, index in chain]
            if sum(weight_of(items[index]) for index in members) < min_chars:
                strays.extend(members)
                continue
            key = (_circular_mean([angle for angle, _index in chain]), reflected)
            parts.setdefault(key, []).extend(members)
    if strays:
        parts.setdefault(UPRIGHT, []).extend(strays)
    grouped = {key: [items[index] for index in sorted(indexes)] for key, indexes in parts.items()}
    weights = {key: sum(weight_of(item) for item in members) for key, members in grouped.items()}
    order = sorted(grouped, key=lambda key: (-weights[key], key[0], key[1]))
    return [(key, grouped[key]) for key in order]


_QUARTER = {0.0: (1.0, 0.0), 90.0: (0.0, 1.0), 180.0: (-1.0, 0.0), 270.0: (0.0, -1.0)}
"""Exact cosine and sine of the axis angles, so an axis frame maps
coordinates without rounding residue."""


def to_frame_point(x: float, y: float, frame: Key) -> tuple[float, float]:
    """(x, y) in the frame where text of orientation `frame` advances along
    +x with its glyph tops up: rotated by -angle, then mirrored top to bottom
    when the glyph space is reflected."""
    cos, sin = _QUARTER.get(frame[0]) or (math.cos(math.radians(frame[0])), math.sin(math.radians(frame[0])))
    u = x * cos + y * sin
    v = -x * sin + y * cos
    return u, (-v if frame[1] else v)


def from_frame_point(u: float, v: float, frame: Key) -> tuple[float, float]:
    """The inverse of `to_frame_point`."""
    cos, sin = _QUARTER.get(frame[0]) or (math.cos(math.radians(frame[0])), math.sin(math.radians(frame[0])))
    if frame[1]:
        v = -v
    return u * cos - v * sin, u * sin + v * cos


def to_frame(box: Sequence[float], frame: Key) -> tuple[float, float, float, float]:
    """The axis-aligned bounds of `box`'s corners in `frame`."""
    us, vs = [], []
    for x, y in ((box[0], box[1]), (box[0], box[3]), (box[2], box[1]), (box[2], box[3])):
        u, v = to_frame_point(x, y, frame)
        us.append(u)
        vs.append(v)
    return min(us), min(vs), max(us), max(vs)


def line_tolerance(size: float, c: float, d: float) -> float:
    """The across-line window of a unit set at text size `size` under a
    matrix whose glyph y axis is (c, d): `LINE_TOL_EM` of that axis's
    length, the em across a horizontal line and along a vertical column."""
    return LINE_TOL_EM * max(size * math.hypot(c, d), 0.01)


def cluster_lines(
    placed: Iterable[tuple[T, float, float, float]],
) -> list[list[tuple[T, float, float]]]:
    """Units of one frame grouped into lines and ordered for reading.

    `placed` holds (unit, along, across, tolerance) in the frame. A unit
    joins the first line whose first unit lies within the larger of the two
    tolerances across; lines read in descending across (top to bottom in the
    frame) and units within a line in ascending along."""
    entries = sorted(placed, key=lambda entry: -entry[2])
    clusters: list[list[tuple[T, float, float, float]]] = []
    for entry in entries:
        for cluster in clusters:
            ref = cluster[0]
            if abs(entry[2] - ref[2]) <= max(ref[3], entry[3]):
                cluster.append(entry)
                break
        else:
            clusters.append([entry])
    lines = []
    for cluster in clusters:
        cluster.sort(key=lambda entry: entry[1])
        lines.append([(unit, along, across) for unit, along, across, _tol in cluster])
    lines.sort(key=lambda line: -max(across for _unit, _along, across in line))
    return lines


def order_lines(
    units: Sequence[T],
    key_of: Callable[[T], Key],
    weight_of: Callable[[T], int],
    place: Callable[[T, Key], tuple[float, float, float]],
    rotate: int = 0,
) -> list[tuple[Key, list[list[tuple[T, float, float]]]]]:
    """`units` as lines in reading order, per orientation part.

    `key_of` gives a unit's display orientation, `place(unit, frame)` its
    (along, across, tolerance) in the user-space `frame` of its part. Each
    entry of the result is (display key, lines), a line being
    [(unit, along, across)]."""
    out = []
    for key, members in partition(units, key_of, weight_of):
        frame = user_frame(key, rotate)
        placed = [(unit, *place(unit, frame)) for unit in members]
        out.append((key, cluster_lines(placed)))
    return out
