"""Effective image resolution across a document.

A PDF has no DPI. Only an IMAGE has pixels, and its resolution is a property
of the PLACEMENT — the same XObject drawn twice at different scales has two
effective resolutions — so this reports a summary over placements, never one
number attributed to the file.

Placed size comes from the placement CTM's column norms, not from the
device-space bounding box: a rotated placement's bbox is wider than the image
and a bbox-derived DPI under-reports it. (`mrc._classify_page` uses the bbox
form correctly because it has already refused every non-upright placement;
this walk accepts all of them.)

The reported per-placement `dpi` is `min(dpi_x, dpi_y)` — the LIMITING
resolution. A page scanned 300x150 is not a 300 dpi page, and reporting 300
would justify a downsample target the document cannot support.

Reading only: no rasterization, no decode. One content-stream parse per page,
plus one more for each page the placement list shows could be a scan.
"""

import math
from pathlib import Path

import pikepdf

from engine.mrc import _classify_page
from engine.page_images import _walk_placements
from engine.redact import IDENTITY, _resolve_resources

#: Below this a placed edge is not a scale but a collapse — the division
#: would report a resolution no viewer renders.
_MIN_PLACED_POINTS = 1e-6


def _placed_size(matrix) -> tuple[float, float]:
    """The placement's drawn width and height in points. The CTM maps the unit
    square, so its column norms ARE the drawn edges under rotation and skew."""
    try:
        a, b, c, d, _e, _f = (float(v) for v in matrix)
    except (TypeError, ValueError):
        return 0.0, 0.0
    return math.hypot(a, b), math.hypot(c, d)


def _measure(placement: dict) -> dict | None:
    """One raster placement's resolutions, or None when it cannot be measured."""
    try:
        native_w = int(placement.get("native_width") or 0)
        native_h = int(placement.get("native_height") or 0)
    except (TypeError, ValueError):
        return None
    if native_w < 1 or native_h < 1:
        return None
    placed_w, placed_h = _placed_size(placement.get("matrix") or ())
    if placed_w < _MIN_PLACED_POINTS or placed_h < _MIN_PLACED_POINTS:
        return None
    dpi_x = native_w * 72.0 / placed_w
    dpi_y = native_h * 72.0 / placed_h
    return {
        "width": native_w,
        "height": native_h,
        "dpi_x": int(round(dpi_x)),
        "dpi_y": int(round(dpi_y)),
        "dpi": int(round(min(dpi_x, dpi_y))),
    }


def _median(values: list[int]) -> int:
    """The lower of the two middle values at even counts. No interpolation:
    every reported DPI has to be one a placement actually has."""
    ordered = sorted(values)
    return ordered[(len(ordered) - 1) // 2]


def summarize_image_resolution(file: str) -> dict:
    """Effective resolution of every raster image placement in a document.

    Args:
        file: Input PDF path.

    `min_dpi`/`median_dpi`/`max_dpi` are null when the document draws no
    measurable raster image. `unmeasured` counts raster placements whose pixel
    dimensions or placed size are degenerate — zero means the three figures
    describe every raster placement in the file.

    `scan_pages` counts pages the MRC classifier accepts. That classifier is
    the authority on "is this page a scan" because it is what decides what the
    MRC pass would then do to the page; a second opinion here could disagree
    with the operation the user runs next.
    """
    placements: list[dict] = []
    unmeasured = 0
    scan_pages = 0
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        for number, page in enumerate(pdf.pages, start=1):
            try:
                instructions = list(pikepdf.parse_content_stream(page))
            except Exception:
                continue
            resources = _resolve_resources(page)
            found: list[dict] = []
            _walk_placements(pdf, instructions, resources, IDENTITY, 0, None, found, False)
            xobject_images = [
                p for p in found if p.get("kind") == "xobject" and not p.get("clipped")
            ]
            for placement in found:
                # A marked vector form draws no pixels, and a placement wholly
                # outside the clip is invisible — neither has a resolution the
                # page shows.
                if placement.get("kind") not in ("xobject", "inline"):
                    continue
                if placement.get("clipped"):
                    continue
                measured = _measure(placement)
                if measured is None:
                    unmeasured += 1
                    continue
                placements.append(
                    {
                        "page": number,
                        "index": int(placement.get("index", 0)),
                        "kind": str(placement.get("kind")),
                        **measured,
                    }
                )
            # The classifier's own first gate, restated so the extra content
            # parse it costs is paid only where a candidate is possible. The
            # verdict still comes from the classifier.
            if len(xobject_images) == 1:
                candidate, _reason = _classify_page(pdf, page, number)
                if candidate is not None:
                    scan_pages += 1

    values = [p["dpi"] for p in placements]
    return {
        "file": file,
        "pages": total,
        "images": len(placements),
        "unmeasured": unmeasured,
        "min_dpi": min(values) if values else None,
        "median_dpi": _median(values) if values else None,
        "max_dpi": max(values) if values else None,
        "scan_pages": scan_pages,
        "placements": placements,
    }
