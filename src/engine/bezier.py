"""Exact cubic-Bézier extents + flattening (P8 slice A / N11 slice A — shared math).

An affine map of a Bézier is the Bézier of the mapped control points, so a
TIGHT device-space bbox comes from transforming the four control points
first and finding the axis extrema there — never from transforming a
user-space bbox (wrong under rotation) and never from raw control points
(over-boxes every bulge). Shared by `page_vectors` (listing bboxes and the N11 geometry probe) and
`svg_pdf` (objectBoundingBox gradients); one implementation, one behavior.
"""

# N11 slice A: recursion cap for `flatten_cubic`. Flatness improves roughly
# fourfold per subdivision, so a curve needing more than this is degenerate
# (a cusp, or control points at astronomical coordinates) — bail with the
# chord rather than spending 2^n segments on it. A listing never aborts on
# bad geometry (the `_PathPoints` rule).
_FLATTEN_MAX_DEPTH = 12


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


def _chord_deviation(P0, P1, P2, P3) -> float:
    """An UPPER BOUND on the curve's maximum distance from the chord P0→P3.

    The control points' distances from the chord bound the curve's own: for a
    cubic, max|curve − chord| ≤ ¾·max(d1, d2) (the Bézier convex-hull /
    Bernstein bound). Using the bound rather than sampling is what makes
    `flatten_cubic`'s tolerance a GUARANTEE instead of an estimate — the
    pytest chord check measures the real deviation against it.

    A degenerate chord (P0 == P3, a loop) has no line to measure against, so
    the control points' distance from the shared endpoint is used instead.
    """
    ax, ay = P0
    bx, by = P3
    dx, dy = bx - ax, by - ay
    span = (dx * dx + dy * dy) ** 0.5
    if span < 1e-12:
        d1 = ((P1[0] - ax) ** 2 + (P1[1] - ay) ** 2) ** 0.5
        d2 = ((P2[0] - ax) ** 2 + (P2[1] - ay) ** 2) ** 0.5
    else:
        d1 = abs((P1[0] - ax) * dy - (P1[1] - ay) * dx) / span
        d2 = abs((P2[0] - ax) * dy - (P2[1] - ay) * dx) / span
    return 0.75 * max(d1, d2)


def _split_cubic(P0, P1, P2, P3):
    """de Casteljau at t = ½ — the two halves, exactly."""
    mid = lambda A, B: ((A[0] + B[0]) / 2.0, (A[1] + B[1]) / 2.0)  # noqa: E731
    A = mid(P0, P1)
    B = mid(P1, P2)
    C = mid(P2, P3)
    D = mid(A, B)
    E = mid(B, C)
    F = mid(D, E)
    return (P0, A, D, F), (F, E, C, P3)


def flatten_cubic(P0, P1, P2, P3, tol: float = 0.25, _depth: int = 0) -> list:
    """The cubic as a polyline, EXCLUDING P0 and INCLUDING P3, every point on
    the true curve and never more than `tol` away from it (N11 slice A).

    Recursive subdivision against `_chord_deviation`'s bound. The default
    0.25 pt is below a hairline — a snapped endpoint is exact to the eye —
    while keeping the payload bounded on a drawing sheet.
    """
    if _depth >= _FLATTEN_MAX_DEPTH or _chord_deviation(P0, P1, P2, P3) <= tol:
        return [P3]
    left, right = _split_cubic(P0, P1, P2, P3)
    return flatten_cubic(*left, tol=tol, _depth=_depth + 1) + flatten_cubic(
        *right, tol=tol, _depth=_depth + 1
    )
