"""Automatic form-field detection — candidates, never fields.

The door reports CANDIDATE regions for a flat form: ruled fill-in lines, boxed
entry areas, checkboxes and radio options, each with the label it binds to, an
inferred type and a derived field name. It writes nothing. Acceptance — and the
authoring that follows it — is the caller's, which is what makes a heuristic
safe to run: a suggestion that mutates nothing is a suggestion.

Four rules the geometry forces:

1. **One walk, both channels.** `_walk_vectors(..., geometry=True)` emits a
   path's device-space bbox AND its flattened subpaths in a single pass. Both
   are needed and neither substitutes for the other: the bbox carries
   `line_width`, which is the rule test, while a circle and a square list with
   identical bboxes and differ only in their subpaths' point count. Joining the
   two shipped listings instead would mean joining two separate ordinal spaces
   by geometry, i.e. a second implementation of "what is on this page".

2. **Labels come from LINE segments, not from show operators.** One show
   operator can carry two labels separated by nothing but spaces; binding
   per-operator gives one rule the whole string and the other nothing. Runs are
   clustered into lines by the search walk's own clustering, then split where
   the drawn gap exceeds `SEGMENT_GAP_SPACES` space advances.

3. **A rule with no label to its left is not offered.** Rule spacing cannot
   separate a fill-in stack from a table: four fill-in rules 40 pt apart at one
   x-extent have the same signature as three table rules. The label is the
   discriminator. Such rules are COUNTED in `unoffered` — found and withheld is
   a reportable outcome, silence is not.

4. **A group's label direction is decided once for the whole group, and the
   group's question is excluded from the option-label pool.** Per-option
   nearest-label search reuses the previous option's label, and the first
   option of a row takes the question above it; both produce duplicate names,
   which the authoring layer refuses mid-batch.

Comb ticks are absorbed into their enclosing box rather than offered as
vertical-rule candidates, and a region an existing widget already covers is
subtracted here so re-running detection on a half-prepared form does not double
every field.
"""

from __future__ import annotations

import math
import pathlib
import statistics
from typing import NamedTuple, Optional

import pikepdf

from engine.form_detect_vocab import is_date_label, is_signature_label
from engine.page_vectors import _walk_vectors
from engine.redact import _resolve_resources
from engine.search_regions import (
    FALLBACK_SPACE_1000,
    WORD_GAP_FRACTION,
    _collect_runs,
    _order_runs,
    _slice_rect,
)
from engine.validate import validate_pdf

# A drawn line shorter than this is an underscore, a tick or a bullet, not a
# fill-in rule.
MIN_RULE_WIDTH = 24.0
# A stroked path is a rule when its cross-axis extent is within its own stroke
# weight; the constant floors that for the filled-rectangle underline idiom,
# whose reported line width is the stream default rather than its thickness.
RULE_THICKNESS_FLOOR = 2.0
# The largest side a near-square box may have and still be a toggle.
MAX_OPTION_SIDE = 20.0
# A box covering this share of the crop box is the page's border.
BORDER_AREA_FRACTION = 0.60
# A field over a rule stands one line tall; a box taller than this many line
# heights holds more than one line.
LINE_HEIGHT_FACTOR = 1.3
MULTILINE_FACTOR = 2.2
# Space advances between two drawn glyphs that read as separate labels rather
# than as one label containing a wide space.
SEGMENT_GAP_SPACES = 2.5
# Label search budgets, per direction.
RULE_LABEL_MAX_GAP = 200.0
BOX_LABEL_LEFT_MAX_GAP = 200.0
BOX_LABEL_ABOVE_MAX_GAP = 25.0
BOX_LABEL_RIGHT_MAX_GAP = 40.0
# The nearest run above a group's whole bounding box is its question.
QUESTION_MAX_GAP = 30.0
# Comb ticks share their box's top and bottom edges to within this much.
COMB_EDGE_TOLERANCE = 1.0
MIN_COMB_TICKS = 3
# A candidate an existing widget covers by more than this share of its own area
# is already a field.
WIDGET_COVER_FRACTION = 0.5
MAX_CANDIDATES_DEFAULT = 5000
# How many `_2`…`_n` suffixes a colliding name may try.
NAME_SUFFIX_LIMIT = 99
# The line height assumed for a rule whose label carries no measurable size.
DEFAULT_LABEL_SIZE = 11.0
# Characters a derived field name may carry. `.` is the hierarchy separator and
# `/` is a name delimiter; both are dropped rather than escaped.
_NAME_KEEP = set(" _-")
# The shortest dark stroke the raster arm recovers, in points: below a small
# toggle's side, and long enough that no glyph stroke reaches it.
MIN_RASTER_STROKE_PT = 8.0
# A recognised word's ink height as a share of its font size, with and without
# a descender. The raster arm has no font to ask, and a rule's field box is one
# line tall, so the line height is recovered from the ink.
ASCENT_ONLY_EM = 0.72
ASCENT_DESCENT_EM = 0.93
_DESCENDER_CHARS = set("gjpqy")
# A space advance, as a share of a recognised word's ink height.
OCR_SPACE_FRACTION = 0.39
_SCAN_MODES = ("auto", "never", "always")

_SHAPE_KINDS = ("fill", "stroke", "fillstroke")


class _Segment(NamedTuple):
    """A run of drawn text on one line, bounded by wide gaps on both sides."""

    text: str
    rect: tuple
    size: float
    # The resource name the run selected its font with. Resolving it to a face
    # needs the page's resources, which is the caller's to hold.
    font_name: str = ""


class _Shape(NamedTuple):
    """One painted path, reduced to what typing a field needs."""

    rect: tuple
    kind: str
    line_width: float
    nested: bool
    closed: bool
    points: int
    raster: bool = False


def _effective_size(run) -> float:
    a, b = run.combined[0], run.combined[1]
    scale = math.hypot(a, b) or 1.0
    return float(run.state.font_size) * scale


def _page_segments(pdf, page) -> list[_Segment]:
    """The page's text as LABEL segments, in the search walk's line clustering.

    A segment is what a human reads as one caption: consecutive drawn glyphs on
    one line whose internal gaps stay below `SEGMENT_GAP_SPACES` space
    advances. Splitting inside a show operator is required — a generator is
    free to draw `"First name:            Last name:"` as one operator over two
    separate rules.
    """
    runs, _listing = _collect_runs(pdf, page)
    segments: list[_Segment] = []
    for line in _order_runs(runs):
        chars: list[str] = []
        rects: list[tuple] = []
        sizes: list[float] = []
        faces: list[str] = []

        def flush() -> None:
            text = "".join(chars).strip()
            if text and rects:
                xs = [r[0] for r in rects] + [r[2] for r in rects]
                ys = [r[1] for r in rects] + [r[3] for r in rects]
                segments.append(
                    _Segment(
                        text,
                        (min(xs), min(ys), max(xs), max(ys)),
                        max(sizes) if sizes else DEFAULT_LABEL_SIZE,
                        faces[0] if faces else "",
                    )
                )
            chars.clear()
            rects.clear()
            sizes.clear()
            faces.clear()

        previous = None
        for run in line:
            size = _effective_size(run)
            if previous is not None:
                gap = run.along0 - previous.along1
                if gap >= SEGMENT_GAP_SPACES * previous.space_w:
                    flush()
                elif gap >= WORD_GAP_FRACTION * previous.space_w and chars:
                    chars.append(" ")
            previous = run
            if run.state.font_name:
                faces.append(str(run.state.font_name))
            cap = run.cap
            if not run.measured or cap is None:
                text = run.text.strip()
                if text:
                    chars.append(text)
                    rects.append(tuple(run.full_rect))
                    sizes.append(size)
                continue
            space_1000 = cap.char_width(" ") if cap.can_encode(" ") else FALLBACK_SPACE_1000
            space_w = space_1000 / 1000.0 * run.state.font_size
            piece_first: Optional[int] = None
            piece_last = 0
            pending = 0.0

            def close_piece() -> None:
                nonlocal piece_first
                if piece_first is not None:
                    rects.append(tuple(_slice_rect(run, piece_first, piece_last)))
                    sizes.append(size)
                    piece_first = None

            for index, item in enumerate(run.items):
                if item.kern:
                    if item.advance > 0:
                        pending += item.advance
                    continue
                text = cap.decode(item.data)
                if not text.strip():
                    pending += max(item.advance, 0.0)
                    continue
                if space_w > 0 and pending >= SEGMENT_GAP_SPACES * space_w:
                    close_piece()
                    flush()
                elif space_w > 0 and pending >= WORD_GAP_FRACTION * space_w and chars:
                    chars.append(" ")
                pending = 0.0
                chars.append(text)
                if piece_first is None:
                    piece_first = index
                piece_last = index
            close_piece()
        flush()
    return segments


def _page_shapes(pdf, page) -> tuple[list[_Shape], bool]:
    """Every painted, visible path on the page, and whether it places anything.

    The placement flag is what separates a SCAN from a genuinely blank page:
    both draw no paths and carry no text, and only one of them is worth
    rasterising and recognising.
    """
    walked = _walk_vectors(
        list(pikepdf.parse_content_stream(page)),
        pdf=pdf,
        resources=_resolve_resources(page),
        geometry=True,
    )
    shapes: list[_Shape] = []
    placed = False
    for item in walked:
        if item.get("kind") == "placement":
            placed = True
            continue
        if item.get("kind") not in _SHAPE_KINDS:
            continue
        if item.get("clipped"):
            continue
        rect = item.get("rect")
        if not rect:
            continue
        subpaths = item.get("subpaths") or []
        closed_flags = item.get("closed") or []
        points = max((len(s) // 2 for s in subpaths), default=0)
        shapes.append(
            _Shape(
                rect=(float(rect[0]), float(rect[1]), float(rect[2]), float(rect[3])),
                kind=str(item["kind"]),
                line_width=float(item.get("line_width") or 0.0),
                nested=bool(item.get("nested")),
                closed=any(bool(c) for c in closed_flags),
                points=points,
            )
        )
    return shapes, placed


def _display_point_to_pdf(u: float, v: float, page_box: tuple, rotate: int) -> tuple:
    """A raster-normalized point (origin top-left) mapped into user space.

    The rasteriser applies the page's `/Rotate`, so the image is in DISPLAY
    orientation while every rect this module produces — and every widget
    `/Rect` a candidate becomes — is in unrotated user space.
    """
    mx, my = page_box[0], page_box[1]
    width, height = page_box[2] - page_box[0], page_box[3] - page_box[1]
    angle = int(rotate) % 360
    if angle == 90:
        return (mx + v * width, my + u * height)
    if angle == 180:
        return (mx + (1.0 - u) * width, my + v * height)
    if angle == 270:
        return (mx + (1.0 - v) * width, my + (1.0 - u) * height)
    return (mx + u * width, my + (1.0 - v) * height)


def _display_rect_to_pdf(box: tuple, page_box: tuple, rotate: int) -> tuple:
    """`box` is (u, v, w, h) in raster-normalized coordinates."""
    u, v, w, h = box
    first = _display_point_to_pdf(u, v, page_box, rotate)
    second = _display_point_to_pdf(u + w, v + h, page_box, rotate)
    return (
        min(first[0], second[0]),
        min(first[1], second[1]),
        max(first[0], second[0]),
        max(first[1], second[1]),
    )


def _row_runs(mask, min_length: int) -> list:
    """Maximal runs of dark pixels per row of `mask`, at least `min_length`."""
    import numpy as np

    runs: list = []
    for row in range(mask.shape[0]):
        line = mask[row]
        if not line.any():
            continue
        edges = np.flatnonzero(
            np.diff(np.concatenate(([0], line.view(np.int8), [0])))
        )
        for start, end in zip(edges[::2], edges[1::2]):
            if end - start >= min_length:
                runs.append((row, int(start), int(end)))
    return runs


def _collapse_runs(runs: list, row_gap: int, edge_tol: int) -> list:
    """Runs on adjacent rows with the same extent are one drawn stroke."""
    bands: list = []
    for row, start, end in runs:
        for band in bands:
            if (
                row - band["row1"] <= row_gap
                and abs(start - band["x0"]) <= edge_tol
                and abs(end - band["x1"]) <= edge_tol
            ):
                band["row1"] = row
                band["x0"] = min(band["x0"], start)
                band["x1"] = max(band["x1"], end)
                break
        else:
            bands.append({"row0": row, "row1": row, "x0": start, "x1": end})
    return bands


def _raster_strokes(mask, min_length: int) -> tuple[list, list]:
    """Horizontal and vertical dark strokes, as pixel rectangles.

    A vertical stroke is the same computation on the transposed mask, so both
    axes come from one implementation and cannot drift apart.
    """
    horizontal = [
        (band["x0"], band["row0"], band["x1"], band["row1"] + 1)
        for band in _collapse_runs(_row_runs(mask, min_length), 2, 6)
    ]
    vertical = [
        (band["row0"], band["x0"], band["row1"] + 1, band["x1"])
        for band in _collapse_runs(_row_runs(mask.T, min_length), 2, 6)
    ]
    return horizontal, vertical


def _pair_boxes(horizontal: list, vertical: list, min_side: int) -> tuple[list, set]:
    """Rectangles closed by two horizontal and two vertical strokes.

    Pairing rather than thresholding is what keeps a glyph stem out of the
    result: a stroke only becomes an edge when three other strokes meet it at
    the corners.
    """
    boxes: list = []
    consumed: set = set()
    for i, top in enumerate(horizontal):
        for j, bottom in enumerate(horizontal):
            if j <= i:
                continue
            upper, lower = (top, bottom) if top[1] < bottom[1] else (bottom, top)
            if abs(upper[0] - lower[0]) > 4 or abs(upper[2] - lower[2]) > 4:
                continue
            if lower[1] - upper[3] < min_side:
                continue
            span0, span1 = upper[1], lower[3]

            def touches(edge_x: float) -> bool:
                for side in vertical:
                    centre = (side[0] + side[2]) / 2.0
                    if abs(centre - edge_x) > 4:
                        continue
                    if side[1] <= span0 + 4 and side[3] >= span1 - 4:
                        return True
                return False

            if touches(upper[0]) and touches(upper[2]):
                boxes.append((upper[0], upper[1], lower[2], lower[3]))
                consumed.add(i)
                consumed.add(j)
    return boxes, consumed


def _page_rotate(page) -> int:
    try:
        return int(page.obj.get("/Rotate", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _raster_shapes(file: str, page, page_number: int, gs_path: str) -> list[_Shape]:
    """Rules, boxes and comb ticks recovered from the page's own raster."""
    import tempfile

    import numpy as np
    from PIL import Image

    from engine.recognize import OCR_DPI, _render_page_png

    with tempfile.TemporaryDirectory(prefix="spectrapdf-detect-") as tmp:
        png = pathlib.Path(tmp) / "page.png"
        _render_page_png(file, page_number, gs_path, png)
        with Image.open(png) as image:
            mask = np.asarray(image.convert("L")) < 128
    height_px, width_px = mask.shape
    if height_px < 2 or width_px < 2:
        return []
    min_length = max(int(MIN_RASTER_STROKE_PT * OCR_DPI / 72.0), 4)
    horizontal, vertical = _raster_strokes(mask, min_length)
    boxes, consumed = _pair_boxes(horizontal, vertical, min_length)
    page_box = _crop_box(page)
    rotate = _page_rotate(page)

    def to_pdf(px_rect: tuple) -> tuple:
        x0, y0, x1, y1 = px_rect
        return _display_rect_to_pdf(
            (x0 / width_px, y0 / height_px, (x1 - x0) / width_px, (y1 - y0) / height_px),
            page_box,
            rotate,
        )

    shapes: list[_Shape] = []
    for rect in boxes:
        shapes.append(
            _Shape(
                rect=to_pdf(rect),
                kind="stroke",
                line_width=0.0,
                nested=False,
                closed=True,
                points=4,
                raster=True,
            )
        )
    for index, rect in enumerate(horizontal):
        if index in consumed:
            continue
        shapes.append(
            _Shape(
                rect=to_pdf(rect),
                kind="stroke",
                line_width=0.0,
                nested=False,
                closed=False,
                points=2,
                raster=True,
            )
        )
    for rect in vertical:
        shapes.append(
            _Shape(
                rect=to_pdf(rect),
                kind="stroke",
                line_width=0.0,
                nested=False,
                closed=False,
                points=2,
                raster=True,
            )
        )
    return shapes


def _ocr_segments(
    file: str,
    page,
    page_number: int,
    lang: str,
    tesseract_path: str,
    gs_path: str,
    drawn: list[_Shape],
) -> list[_Segment]:
    """Recognised words assembled into the same label segments the walk emits.

    Word boxes arrive normalised to the rendered page with y measured from the
    top; they are mapped through the same display-to-user-space rule every
    other consumer of recognition uses, so a scanned page's labels land in the
    space a widget rectangle is written in.

    A recogniser reads the FORM's own lines and boxes as characters — an empty
    square comes back as `[]` or `[J`, glued onto the option's real label by the
    line assembly. A word sitting on a recovered stroke is that stroke, so it is
    dropped before any label is built.
    """
    from engine.recognize import recognize

    words = recognize(file, page_number, lang, tesseract_path, gs_path)["words"]
    page_box = _crop_box(page)
    rotate = _page_rotate(page)
    strokes = [shape.rect for shape in drawn]
    placed: list[tuple] = []
    for word in words:
        text = str(word.get("text") or "").strip()
        if not text or not any(ch.isalnum() for ch in text):
            continue
        rect = _display_rect_to_pdf(
            (float(word["x"]), float(word["y"]), float(word["w"]), float(word["h"])),
            page_box,
            rotate,
        )
        if _covered(rect, strokes):
            continue
        ink = rect[3] - rect[1]
        em = ASCENT_DESCENT_EM if any(c in _DESCENDER_CHARS for c in text) else ASCENT_ONLY_EM
        placed.append((text, rect, ink / em if em > 0 else ink))
    if not placed:
        return []
    lines: list[list[tuple]] = []
    for item in sorted(placed, key=lambda p: -(p[1][1] + p[1][3]) / 2.0):
        centre = (item[1][1] + item[1][3]) / 2.0
        height = item[1][3] - item[1][1]
        for line in lines:
            ref = line[0]
            if abs(centre - (ref[1][1] + ref[1][3]) / 2.0) <= 0.5 * max(height, 1.0):
                line.append(item)
                break
        else:
            lines.append([item])
    segments: list[_Segment] = []
    for line in lines:
        line.sort(key=lambda p: p[1][0])
        chunk: list[tuple] = []
        for item in line:
            if chunk:
                gap = item[1][0] - chunk[-1][1][2]
                budget = SEGMENT_GAP_SPACES * OCR_SPACE_FRACTION * (item[1][3] - item[1][1])
                if gap >= budget:
                    segments.append(_merge_words(chunk))
                    chunk = []
            chunk.append(item)
        if chunk:
            segments.append(_merge_words(chunk))
    return segments


def _merge_words(chunk: list) -> _Segment:
    xs = [w[1][0] for w in chunk] + [w[1][2] for w in chunk]
    ys = [w[1][1] for w in chunk] + [w[1][3] for w in chunk]
    return _Segment(
        " ".join(w[0] for w in chunk),
        (min(xs), min(ys), max(xs), max(ys)),
        max(w[2] for w in chunk),
    )


def _crop_box(page) -> tuple:
    try:
        box = page.obj.get("/CropBox", page.obj.get("/MediaBox"))
        values = [float(v) for v in box]
    except (TypeError, ValueError):
        return (0.0, 0.0, 612.0, 792.0)
    return (
        min(values[0], values[2]),
        min(values[1], values[3]),
        max(values[0], values[2]),
        max(values[1], values[3]),
    )


def _near_square(width: float, height: float) -> bool:
    return abs(width - height) <= max(2.0, 0.25 * max(width, height))


def _classify_shapes(shapes: list[_Shape], page_box: tuple) -> tuple[list, list, list]:
    """Split painted paths into horizontal rules, vertical rules and boxes."""
    page_area = max((page_box[2] - page_box[0]) * (page_box[3] - page_box[1]), 1.0)
    rules: list[_Shape] = []
    ticks: list[_Shape] = []
    boxes: list[_Shape] = []
    for shape in shapes:
        x0, y0, x1, y1 = shape.rect
        width, height = x1 - x0, y1 - y0
        if width <= 0 or height <= 0:
            continue
        if width * height >= page_area * BORDER_AREA_FRACTION:
            continue  # the page border, not a field
        thin = max(shape.line_width * 1.5, RULE_THICKNESS_FLOOR)
        if height <= thin and width >= MIN_RULE_WIDTH:
            rules.append(shape)
            continue
        if width <= thin and height >= 3.0:
            ticks.append(shape)
            continue
        if shape.kind == "fill":
            continue  # a filled shape is decoration, not an outline
        if not shape.closed:
            continue
        if shape.points == 4:
            boxes.append(shape)
            continue
        if shape.points > 8 and _near_square(width, height) and max(width, height) <= MAX_OPTION_SIDE:
            boxes.append(shape)
    return rules, ticks, boxes


def _absorb_combs(boxes: list[_Shape], ticks: list[_Shape]) -> dict:
    """Which boxes are comb fields, and how many cells each has.

    Evenly spaced vertical strokes that span a box's full height are that box's
    comb divisions. Offered as candidates they would be five spurious fields
    around one real one.
    """
    combs: dict[int, int] = {}
    for box_index, box in enumerate(boxes):
        bx0, by0, bx1, by1 = box.rect
        inner = []
        for tick in ticks:
            tx0, ty0, tx1, ty1 = tick.rect
            centre = (tx0 + tx1) / 2.0
            if not (bx0 + 1.0 < centre < bx1 - 1.0):
                continue
            if abs(ty0 - by0) > COMB_EDGE_TOLERANCE or abs(ty1 - by1) > COMB_EDGE_TOLERANCE:
                continue
            inner.append(centre)
        if len(inner) < MIN_COMB_TICKS:
            continue
        inner.sort()
        deltas = [b - a for a, b in zip(inner, inner[1:])]
        pitch = statistics.median(deltas)
        if pitch <= 0 or any(abs(d - pitch) > COMB_EDGE_TOLERANCE for d in deltas):
            continue
        combs[box_index] = len(inner) + 1
    return combs


def _label_left(rect: tuple, segments, budget: float, band: float):
    """The nearest segment ending to the left of `rect` on the same band."""
    x0, y0, _x1, y1 = rect
    centre = (y0 + y1) / 2.0
    best, best_gap = None, budget
    for segment in segments:
        sx0, sy0, sx1, sy1 = segment.rect
        if sx1 > x0 + 2.0:
            continue
        s_centre = (sy0 + sy1) / 2.0
        if abs(s_centre - centre) > band * max(sy1 - sy0, 1.0):
            continue
        gap = x0 - sx1
        if 0.0 <= gap < best_gap:
            best, best_gap = segment, gap
    return best, best_gap


def _label_right(rect: tuple, segments, budget: float):
    _x0, y0, x1, y1 = rect
    centre = (y0 + y1) / 2.0
    best, best_gap = None, budget
    for segment in segments:
        sx0, sy0, sx1, sy1 = segment.rect
        if sx0 < x1 - 2.0:
            continue
        s_centre = (sy0 + sy1) / 2.0
        if abs(s_centre - centre) > max(sy1 - sy0, 1.0) * 1.2:
            continue
        gap = sx0 - x1
        if 0.0 <= gap < best_gap:
            best, best_gap = segment, gap
    return best, best_gap


def _label_above(rect: tuple, segments, budget: float):
    x0, _y0, x1, y1 = rect
    best, best_gap = None, budget
    for segment in segments:
        sx0, sy0, sx1, _sy1 = segment.rect
        if sy0 < y1 - 1.0:
            continue
        if sx1 < x0 - 1.0 or sx0 > x1 + 1.0:
            continue
        gap = sy0 - y1
        if 0.0 <= gap < best_gap:
            best, best_gap = segment, gap
    return best, best_gap


def _label_below(rect: tuple, segments, budget: float):
    x0, y0, x1, _y1 = rect
    best, best_gap = None, budget
    for segment in segments:
        sx0, _sy0, sx1, sy1 = segment.rect
        if sy1 > y0 + 1.0:
            continue
        if sx1 < x0 - 1.0 or sx0 > x1 + 1.0:
            continue
        gap = y0 - sy1
        if 0.0 <= gap < best_gap:
            best, best_gap = segment, gap
    return best, best_gap


def _bind_rule_label(rect: tuple, segments):
    return _label_left(rect, segments, RULE_LABEL_MAX_GAP, 1.6)


def _bind_box_label(rect: tuple, segments):
    """Left, then above, then right — the order a boxed form is written in."""
    segment, gap = _label_left(rect, segments, BOX_LABEL_LEFT_MAX_GAP, 1.0)
    if segment is not None:
        return segment, gap, "left"
    segment, gap = _label_above(rect, segments, BOX_LABEL_ABOVE_MAX_GAP)
    if segment is not None:
        return segment, gap, "above"
    segment, gap = _label_right(rect, segments, BOX_LABEL_RIGHT_MAX_GAP)
    if segment is not None:
        return segment, gap, "right"
    return None, 0.0, None


def _axis_key(rects: list[tuple], horizontal: bool):
    """Position along a group's own layout axis, increasing in reading order."""
    if horizontal:
        return lambda i: rects[i][0]
    return lambda i: -rects[i][3]


def _cluster_options(
    options: list[int], rects: list[tuple], horizontal: bool
) -> list[list[int]]:
    """Equal-sized options sharing a row (horizontal) or a column."""
    axis = 1 if horizontal else 0
    clusters: list[list[int]] = []
    for index in options:
        rect = rects[index]
        width, height = rect[2] - rect[0], rect[3] - rect[1]
        for cluster in clusters:
            ref = rects[cluster[0]]
            if abs(width - (ref[2] - ref[0])) > 1.0 or abs(height - (ref[3] - ref[1])) > 1.0:
                continue
            if abs(rect[axis] - ref[axis]) <= 2.0:
                cluster.append(index)
                break
        else:
            clusters.append([index])
    return clusters


def _consistent_pitch(cluster: list[int], rects: list[tuple], horizontal: bool):
    """The cluster's spacing, or None when the spacing varies.

    A varying gap is a layout coincidence rather than an answer set, so the
    cluster is dissolved into single options instead of being offered as a
    group whose members are not siblings.
    """
    key = _axis_key(rects, horizontal)
    coords = sorted(key(i) for i in cluster)
    deltas = [b - a for a, b in zip(coords, coords[1:])]
    if not deltas:
        return None
    pitch = statistics.median(deltas)
    if pitch <= 0 or any(abs(d - pitch) > max(2.0, 0.25 * pitch) for d in deltas):
        return None
    return pitch


def _group_options(options: list[int], rects: list[tuple]) -> list[tuple]:
    """Option regions split into answer sets, each with its layout pitch.

    Rows are resolved before columns and a member never belongs to both: two
    stacked rows of toggles share left edges, so a column pass run first (or
    run over everything) merges unrelated rows into one nonsense group.
    """
    out: list[tuple] = []
    leftovers: list[int] = []
    for cluster in _cluster_options(options, rects, True):
        pitch = _consistent_pitch(cluster, rects, True) if len(cluster) >= 2 else None
        if pitch is None:
            leftovers.extend(cluster)
            continue
        out.append((sorted(cluster, key=_axis_key(rects, True)), pitch, True))
    remaining: list[int] = []
    for cluster in _cluster_options(leftovers, rects, False):
        pitch = _consistent_pitch(cluster, rects, False) if len(cluster) >= 2 else None
        if pitch is None:
            remaining.extend(cluster)
            continue
        out.append((sorted(cluster, key=_axis_key(rects, False)), pitch, False))
    for index in remaining:
        out.append(([index], RULE_LABEL_MAX_GAP, True))
    return out


def _group_question(group: list[int], rects: list[tuple], segments):
    x0 = min(rects[i][0] for i in group)
    x1 = max(rects[i][2] for i in group)
    y1 = max(rects[i][3] for i in group)
    return _label_above((x0, 0.0, x1, y1), segments, QUESTION_MAX_GAP)


def _group_option_labels(group: list[int], rects: list[tuple], segments, pitch: float):
    """One direction for the whole group, or nothing.

    A label further from its box than the inter-option pitch belongs to a
    different option, so the pitch is the budget. A direction is accepted only
    when every member gets a label and no two members share one.
    """
    finders = (
        ("right", lambda rect, budget: _label_right(rect, segments, budget)),
        ("left", lambda rect, budget: _label_left(rect, segments, budget, 1.0)),
        ("above", lambda rect, budget: _label_above(rect, segments, budget)),
        ("below", lambda rect, budget: _label_below(rect, segments, budget)),
    )
    for source, finder in finders:
        found = []
        for index in group:
            segment, gap = finder(rects[index], pitch)
            if segment is None:
                break
            found.append((segment, gap))
        if len(found) != len(group):
            continue
        texts = [f[0].text for f in found]
        if len(set(texts)) != len(texts):
            continue
        return source, found
    return None, []


def _sanitize_name(label: str) -> str:
    """A label reduced to what a field name may carry."""
    kept = [ch for ch in (label or "").strip() if ch.isalnum() or ch in _NAME_KEEP]
    collapsed = "_".join("".join(kept).split())
    return collapsed.strip("_")


def _widget_rects(page) -> list[tuple]:
    rects: list[tuple] = []
    try:
        annots = page.obj.get("/Annots")
    except Exception:
        return rects
    if annots is None:
        return rects
    for annot in annots:
        try:
            if str(annot.get("/Subtype", "")) != "/Widget":
                continue
            values = [float(v) for v in annot.get("/Rect")]
        except (AttributeError, TypeError, ValueError):
            continue
        if len(values) < 4:
            continue
        rects.append(
            (
                min(values[0], values[2]),
                min(values[1], values[3]),
                max(values[0], values[2]),
                max(values[1], values[3]),
            )
        )
    return rects


def _covered(rect: tuple, widgets: list[tuple]) -> bool:
    area = max((rect[2] - rect[0]) * (rect[3] - rect[1]), 1e-6)
    for widget in widgets:
        ox = min(rect[2], widget[2]) - max(rect[0], widget[0])
        oy = min(rect[3], widget[3]) - max(rect[1], widget[1])
        if ox > 0 and oy > 0 and (ox * oy) / area > WIDGET_COVER_FRACTION:
            return True
    return False


def _existing_field_names(pdf) -> set:
    names: set = set()
    try:
        acro = pdf.Root.get("/AcroForm")
        fields = acro.get("/Fields") if acro is not None else None
    except Exception:
        return names
    if fields is None:
        return names
    for field in fields:
        try:
            title = field.get("/T")
        except AttributeError:
            continue
        if title is not None:
            names.add(str(title))
    return names


def _page_numbers(pages, pdf) -> list[int]:
    """The 1-based pages to analyze.

    Spelled with `page_no` and `len(pdf.pages)` deliberately: the out-of-range
    refusal is a shared row in the engine-message table, and a differently named
    local would rename the interpolations of a message several modules raise.
    """
    if pages is None or pages == "all":
        return list(range(1, len(pdf.pages) + 1))
    if isinstance(pages, str):
        raise ValueError('pages must be a list of page numbers or "all"')
    out: list[int] = []
    for value in pages:
        page_no = int(value)
        if not (1 <= page_no <= len(pdf.pages)):
            raise ValueError(f"page {page_no} is out of range (1-{len(pdf.pages)})")
        if page_no not in out:
            out.append(page_no)
    return sorted(out)


def _round_rect(rect: tuple) -> list:
    return [round(float(v), 2) for v in rect]


def _field_rect_for_rule(shape_rect: tuple, size: float) -> tuple:
    """A rule's field box: the rule's own span, one line tall, above the rule."""
    x0, _y0, x1, y1 = shape_rect
    height = max(size, DEFAULT_LABEL_SIZE * 0.5) * LINE_HEIGHT_FACTOR
    return (x0, y1, x1, y1 + height)


def _stroke_half(shape: _Shape) -> float:
    """Half the stroke weight the listing added around the drawn path.

    A fill has none: its bbox already IS the painted area, so insetting it would
    shrink the field away from the mark the user drew.
    """
    if shape.kind == "fill":
        return 0.0
    return max(shape.line_width, 0.0) / 2.0


def _field_rect_for_box(shape: _Shape) -> tuple:
    half = _stroke_half(shape)
    x0, y0, x1, y1 = shape.rect
    return (x0 + half, y0 + half, x1 - half, y1 - half)


def _text_format(kind: str, label: Optional[str]) -> Optional[str]:
    """The value shape a text candidate's label announces.

    A date is an ordinary text field in the format — the vocabulary only names
    what the field is for, so the review surface can say so.
    """
    if kind != "text" or not label:
        return None
    return "date" if is_date_label(label) else None


def _infer_text_kind(rect: tuple, size: float, comb: Optional[int]) -> dict:
    height = rect[3] - rect[1]
    line = max(size, DEFAULT_LABEL_SIZE * 0.5) * LINE_HEIGHT_FACTOR
    out = {"kind": "text", "multiline": False, "comb": None, "max_len": None}
    if comb:
        out["comb"] = comb
        out["max_len"] = comb
        return out
    if height > MULTILINE_FACTOR * line:
        out["multiline"] = True
    return out


class _Raw(NamedTuple):
    """A candidate before naming and truncation."""

    page: int
    kind: str
    rect: tuple
    label: Optional[str]
    label_source: Optional[str]
    label_gap: float
    evidence: str
    nested: bool
    group_id: Optional[str]
    group_label: Optional[str]
    export: Optional[str]
    multiline: bool
    comb: Optional[int]
    max_len: Optional[int]
    text_format: Optional[str]
    warnings: list


def _evidence(shape: _Shape, base: str) -> str:
    return f"raster-{base}" if shape.raster else base


def _page_candidates(
    pdf,
    page,
    page_number: int,
    unoffered: dict,
    file: str,
    scan: str,
    lang: str,
    tesseract_path: str,
    gs_path: str,
) -> tuple[list[_Raw], str]:
    """This page's candidates, and which arm produced them.

    The arm is chosen by a decidable test, not by a guess: a page with no
    painted paths and no text runs carries nothing a walk can read, and that is
    exactly what a scan looks like. Both arms then feed the same candidate
    builder, so a raster candidate and a vector candidate are the same object.
    """
    page_box = _crop_box(page)
    segments = _page_segments(pdf, page)
    shapes, placed = _page_shapes(pdf, page)
    unreadable = not shapes and not segments and placed
    raster = scan == "always" or (scan == "auto" and unreadable)
    if raster:
        shapes = _raster_shapes(file, page, page_number, gs_path)
        rules, ticks, boxes = _classify_shapes(shapes, page_box)
        # Only the CLASSIFIED strokes mask recognised words: the page border is
        # a recovered rectangle too, and masking against it would cover every
        # word on the page.
        segments = _ocr_segments(
            file, page, page_number, lang, tesseract_path, gs_path, rules + ticks + boxes
        )
        arm = "raster"
    elif unreadable:
        # Told not to recognise: the page is reported as the image it is, so
        # nothing reads as "this page has no fields on it".
        return [], "image"
    elif not shapes and not segments:
        return [], "empty"
    else:
        arm = "vector"
        rules, ticks, boxes = _classify_shapes(shapes, page_box)
    combs = _absorb_combs(boxes, ticks)
    widgets = _widget_rects(page)

    raw: list[_Raw] = []

    def bump(reason: str) -> None:
        unoffered[reason] = unoffered.get(reason, 0) + 1

    # Rules → single-line text fields. An unlabelled rule is a table border.
    for shape in rules:
        segment, gap = _bind_rule_label(shape.rect, segments)
        if segment is None:
            bump("rule_without_label")
            continue
        rect = _field_rect_for_rule(shape.rect, segment.size)
        half = _stroke_half(shape)
        rect = (rect[0] + half, rect[1], rect[2] - half, rect[3])
        if _covered(rect, widgets):
            bump("covered_by_existing_field")
            continue
        kind = "signature" if is_signature_label(segment.text) else "text"
        raw.append(
            _Raw(
                page=page_number,
                kind=kind,
                rect=rect,
                label=segment.text,
                label_source="left",
                label_gap=gap,
                evidence=_evidence(shape, "rule"),
                nested=shape.nested,
                group_id=None,
                group_label=None,
                export=None,
                multiline=False,
                comb=None,
                max_len=None,
                text_format=_text_format(kind, segment.text),
                warnings=[],
            )
        )

    option_indices = []
    plain_boxes = []
    for index, shape in enumerate(boxes):
        x0, y0, x1, y1 = shape.rect
        width, height = x1 - x0, y1 - y0
        if _near_square(width, height) and max(width, height) <= MAX_OPTION_SIDE:
            option_indices.append(index)
        else:
            plain_boxes.append(index)

    for index in plain_boxes:
        shape = boxes[index]
        rect = _field_rect_for_box(shape)
        if _covered(rect, widgets):
            bump("covered_by_existing_field")
            continue
        segment, gap, box_source = _bind_box_label(shape.rect, segments)
        label = segment.text if segment is not None else None
        size = segment.size if segment is not None else DEFAULT_LABEL_SIZE
        typing = _infer_text_kind(rect, size, combs.get(index))
        kind = "signature" if (label and is_signature_label(label)) else typing["kind"]
        warnings = [] if label else ["unlabeled"]
        raw.append(
            _Raw(
                page=page_number,
                kind=kind,
                rect=rect,
                label=label,
                label_source=box_source,
                label_gap=gap,
                evidence=_evidence(shape, "box"),
                nested=shape.nested,
                group_id=None,
                group_label=None,
                export=None,
                multiline=bool(typing["multiline"]) and kind == "text",
                comb=typing["comb"] if kind == "text" else None,
                max_len=typing["max_len"] if kind == "text" else None,
                text_format=_text_format(kind, label),
                warnings=warnings,
            )
        )

    # Options: grouped first, so a group's question can be excluded from the
    # option-label pool before any member binds a label.
    box_rects = [shape.rect for shape in boxes]
    for ordinal, (group, pitch, _horizontal) in enumerate(
        _group_options(option_indices, box_rects)
    ):
        question, _question_gap = _group_question(group, box_rects, segments)
        pool = [s for s in segments if s is not question]
        direction, found = (
            _group_option_labels(group, box_rects, pool, pitch)
            if len(group) >= 2
            else (None, [])
        )
        round_shape = all(boxes[i].points > 8 for i in group)
        # A named answer set is a radio group; the same set with no question
        # above it is that many independent toggles, because the members would
        # have no name to share. A round option is a radio whatever labels it.
        radio = len(group) >= 2 and direction is not None and (question is not None or round_shape)
        if len(group) >= 2 and question is not None and direction is None:
            bump("radio_demoted")
        group_label = question.text if (radio and question is not None) else None
        for position, member in enumerate(group):
            shape = boxes[member]
            rect = _field_rect_for_box(shape)
            if _covered(rect, widgets):
                bump("covered_by_existing_field")
                continue
            if direction is not None:
                segment, gap = found[position]
                label, label_source = segment.text, direction
            else:
                segment, gap, label_source = _bind_box_label(shape.rect, segments)
                label = segment.text if segment is not None else None
            raw.append(
                _Raw(
                    page=page_number,
                    kind="radio" if radio else "checkbox",
                    rect=rect,
                    label=label,
                    label_source=label_source,
                    label_gap=gap,
                    evidence=_evidence(shape, "box-round" if shape.points > 8 else "box"),
                    nested=shape.nested,
                    group_id=f"{page_number}:{ordinal}" if radio else None,
                    group_label=group_label,
                    export=label if radio else None,
                    multiline=False,
                    comb=None,
                    max_len=None,
                    text_format=None,
                    warnings=[] if label else ["unlabeled"],
                )
            )
    return raw, arm


_NAME_STEM = {
    "text": "Text",
    "checkbox": "Check",
    "radio": "Radio",
    "signature": "Sig",
}


def _assign_names(raw: list[_Raw], taken: set) -> list[dict]:
    """Derive each candidate's field name and make it unique.

    A group's members share the group's name and differ by export value; every
    other candidate takes its own label. An unlabelled candidate takes a
    positional name rather than an empty one, because an empty name is refused
    at authoring time and a batch that aborts part-way is worse than a name the
    user rewrites.
    """
    out: list[dict] = []
    assigned: dict[str, str] = {}
    used = set(taken)
    positional = 0
    for index, item in enumerate(raw):
        if item.group_id is not None and item.group_id in assigned:
            name = assigned[item.group_id]
        else:
            base = _sanitize_name(item.group_label or item.label or "")
            if item.group_id is not None and not item.group_label:
                base = ""
            if not base:
                positional += 1
                base = f"{_NAME_STEM.get(item.kind, 'Field')}_p{item.page}_{positional}"
            name = base
            if name in used:
                for suffix in range(2, NAME_SUFFIX_LIMIT + 1):
                    candidate = f"{base}_{suffix}"
                    if candidate not in used:
                        name = candidate
                        break
                else:
                    raise ValueError(
                        f"cannot name the detected field {base}: too many fields already "
                        "carry that name"
                    )
            used.add(name)
            if item.group_id is not None:
                assigned[item.group_id] = name
        out.append(
            {
                "page": item.page,
                "index": index,
                "kind": item.kind,
                "rect": _round_rect(item.rect),
                "label": item.label,
                "label_source": item.label_source,
                "label_gap": round(float(item.label_gap), 2),
                "name": name,
                "evidence": item.evidence,
                "nested": item.nested,
                "group": name if item.group_id is not None else None,
                "export": item.export,
                "multiline": item.multiline,
                "comb": item.comb,
                "max_len": item.max_len,
                "format": item.text_format,
                "warnings": list(item.warnings),
            }
        )
    return out


def detect_form_fields(
    file: str,
    pages="all",
    scan: str = "auto",
    lang: str = "eng",
    tesseract_path: str = "",
    gs_path: str = "",
    max_candidates: int = MAX_CANDIDATES_DEFAULT,
) -> dict:
    """Field candidates for a flat form.

    Returns ``{candidates, pages_analyzed, pages_by_source, unoffered,
    existing_fields, truncated}``. A candidate carries its page, its page-space
    ``rect``, the inferred ``kind``, the bound ``label`` with the direction it
    came from, a derived ``name``, and — for a radio option — its ``group`` and
    ``export``. Nothing is written; the caller decides what becomes a field.

    ``scan`` chooses the arm: ``auto`` reads a page's own content and uses the
    raster arm only where there is none, ``never`` keeps the run offline, and
    ``always`` forces recognition. A page that needs the raster arm and has no
    recogniser available REFUSES by name — an empty result would read as a page
    with nothing on it.
    """
    if int(max_candidates) <= 0:
        raise ValueError("max_candidates must be a positive number")
    if scan not in _SCAN_MODES:
        raise ValueError('scan must be "auto", "never" or "always"')
    validate_pdf(file)
    with pikepdf.open(file) as pdf:
        wanted = _page_numbers(pages, pdf)
        existing = _existing_field_names(pdf)
        raw: list[_Raw] = []
        by_source: dict[str, str] = {}
        unoffered_by_page: dict[int, dict] = {}
        truncated = False
        for page_number in wanted:
            page = pdf.pages[page_number - 1]
            counts: dict = {}
            found, arm = _page_candidates(
                pdf,
                page,
                page_number,
                counts,
                file,
                scan,
                lang,
                tesseract_path,
                gs_path,
            )
            unoffered_by_page[page_number] = counts
            by_source[str(page_number)] = arm
            for item in found:
                if len(raw) >= int(max_candidates):
                    truncated = True
                    break
                raw.append(item)
            if truncated:
                break
        candidates = _assign_names(raw, existing)
    unoffered = []
    for page_number in wanted:
        for reason, count in sorted(unoffered_by_page.get(page_number, {}).items()):
            unoffered.append({"page": page_number, "reason": reason, "count": count})
    return {
        "candidates": candidates,
        "pages_analyzed": wanted,
        "pages_by_source": by_source,
        "unoffered": unoffered,
        "existing_fields": len(existing),
        "truncated": truncated,
    }
