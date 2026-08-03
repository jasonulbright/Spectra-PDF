"""Exact cubic-Bézier extents (P8 slice A — shared math).

An affine map of a Bézier is the Bézier of the mapped control points, so a
TIGHT device-space bbox comes from transforming the four control points
first and finding the axis extrema there — never from transforming a
user-space bbox (wrong under rotation) and never from raw control points
(over-boxes every bulge). Shared by `page_vectors` (listing bboxes) and
`svg_pdf` (objectBoundingBox gradients); one implementation, one behavior.
"""


def cubic_axis_extrema(p0: float, p1: float, p2: float, p3: float) -> list[float]:
    """Interior parameter values t ∈ (0,1) where d/dt of the cubic's axis
    component vanishes — 0, 1, or 2 of them."""
    a = -p0 + 3 * p1 - 3 * p2 + p3
    b = 2 * (p0 - 2 * p1 + p2)
    c = p1 - p0
    roots: list[float] = []
    if abs(a) < 1e-12:
        if abs(b) > 1e-12:
            roots = [-c / b]
    else:
        disc = b * b - 4 * a * c
        if disc >= 0:
            sq = disc ** 0.5
            roots = [(-b + sq) / (2 * a), (-b - sq) / (2 * a)]
    return [t for t in roots if 0 < t < 1]


def cubic_axis_value(p0: float, p1: float, p2: float, p3: float, t: float) -> float:
    mt = 1 - t
    return (
        mt * mt * mt * p0
        + 3 * mt * mt * t * p1
        + 3 * mt * t * t * p2
        + t * t * t * p3
    )


def cubic_bbox_points(P0, P1, P2, P3) -> list[tuple[float, float]]:
    """The 2D points that bound the cubic exactly: both ENDPOINTS plus the
    curve points at every interior axis extremum. Control points P1/P2
    steer but never appear — that's the whole point."""
    pts: list[tuple[float, float]] = [P0, P3]
    for t in set(
        cubic_axis_extrema(P0[0], P1[0], P2[0], P3[0])
        + cubic_axis_extrema(P0[1], P1[1], P2[1], P3[1])
    ):
        pts.append(
            (
                cubic_axis_value(P0[0], P1[0], P2[0], P3[0], t),
                cubic_axis_value(P0[1], P1[1], P2[1], P3[1], t),
            )
        )
    return pts
