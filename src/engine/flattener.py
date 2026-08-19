"""Transparency flattening by REGION.

Ghostscript's only transparency flattener rasterizes the whole page: thirty
lines of live text come back as a single 6120x7920 image carrying no fonts at
all. A raster/vector balance wired to that controls nothing, so the flatten
here is composed from primitives this engine already owns — an object walk that
says what a page paints and where, Ghostscript rasterizing ONE REGION at the
region's own scale, and the page rebuilt with that region's objects dropped and
the raster placed back.

**Region boundaries snap to whole device pixels.** A boundary that falls
mid-pixel makes the region raster resample, and the resampled edge draws a
visible seam against the live content beside it. Snapped, a flattened page
renders pixel-identical to the original; unsnapped at the same resolution the
same edge measures 128 levels of difference over hundreds of pixels.

**Every object intersecting a region is absorbed into it.** That is what makes
z-order irrelevant to the placement: absorbed objects are removed and the
raster is appended, and nothing still live overlaps the area it covers. The
raster/vector balance is the merge aggressiveness — toward vector, many small
regions and more live text survives; toward raster, fewer and larger ones.
"""

from __future__ import annotations

import contextlib
import math
import shutil
import tempfile
from pathlib import Path

import pikepdf

from . import budget
from .content_walk import (
    DEFAULT_COLOR,
    ClipTracker,
    GraphicsTextState,
    bbox_of_corners_under_matrix,
    bbox_of_rect_under_matrix,
    mat_mult,
    transform_point,
)
from .page_images import _save
from .print_layout import _xobject_for
from .redact import (
    IDENTITY,
    MAX_FORM_DEPTH,
    _as_matrix,
    _copy_resources_for_write,
    _lookup_xobject,
    _resolve_resources,
)
from .text_metrics import _FontCache, _run_metrics
from .validate import validate_pdf
from engine.pdf_save import save_pdf

# Path grammar, the same one the vector listing uses: a maximal run of
# construction operators terminated by an operator that DRAWS it.
_CONSTRUCT = frozenset({"m", "l", "c", "v", "y", "re", "h"})
_CLIP = frozenset({"W", "W*"})
_PAINT_FILL = frozenset({"f", "F", "f*"})
_PAINT_STROKE = frozenset({"S", "s"})
_PAINT_BOTH = frozenset({"B", "B*", "b", "b*"})
_PAINT_VISIBLE = _PAINT_FILL | _PAINT_STROKE | _PAINT_BOTH
_PAINT_ALL = _PAINT_VISIBLE | {"n"}
_SHOW_OPS = frozenset({"Tj", "'", '"', "TJ"})

# Blend modes that composite as plain paint. Anything else is transparency.
_OPAQUE_BLENDS = frozenset({"/Normal", "/Compatible", "Normal", "Compatible"})

# The classification the panel highlights by.
CATEGORIES = (
    "transparent",
    "affected",
    "rasterized",
    "outlined_strokes",
    "outlined_text",
    "expanded_patterns",
    "unknown",
)

# The three answers the object walk can give about transparency. UNKNOWN is
# not NO: an object whose analysis will not read may composite, and calling it
# opaque leaves live transparency in a document the flatten reported success
# on. The flatten refuses on UNKNOWN and the classification reports it.
YES = "yes"
NO = "no"
UNKNOWN = "unknown"

# Why an answer is UNKNOWN. The code travels; `_refuse_unknown` is the one
# place it becomes a sentence.
_UNKNOWN_READ = "read"
_UNKNOWN_DEPTH = "depth"
_UNKNOWN_BBOX = "bbox"
_UNKNOWN_GSTATE = "gstate"

# Resolutions the flattener offers. 150 is the working default; the arithmetic
# is resolution-independent, so a higher number buys sharper raster edges at a
# proportional cost in pixels.
DEFAULT_DPI = 150
DEFAULT_BALANCE = 0.5

# The largest region raster the flattener will ask Ghostscript for. A letter
# page at 600 dpi is 5100x6600, so the cap admits a whole page at any offered
# resolution and refuses the runaway that a pathological region would produce.
MAX_REGION_PIXELS = 34_000_000

# Growing a region can pull in more objects, which grows it again. The loop is
# monotone and bounded by the page box, so it terminates; the counter bounds
# the pathological case where each pass admits exactly one more object.
_MAX_REGION_PASSES = 256


# ── geometry ───────────────────────────────────────────────────────────────


def snap_to_pixel(value: float, dpi: int, outward_up: bool) -> float:
    """`value` moved onto the nearest whole device pixel at `dpi`.

    Snapping is OUTWARD — a lower bound floors, an upper bound ceils — so the
    snap only ever grows a region. Growing is safe (the extra strip is
    rasterized content that was going to be rasterized anyway); shrinking would
    leave a sliver of a removed object unpainted.
    """
    pixels = value * dpi / 72.0
    whole = math.ceil(pixels - 1e-9) if outward_up else math.floor(pixels + 1e-9)
    return whole * 72.0 / dpi


def _pixel_extent(rect, dpi: int) -> tuple[int, int]:
    return (
        int(round((rect[2] - rect[0]) * dpi / 72.0)),
        int(round((rect[3] - rect[1]) * dpi / 72.0)),
    )


def _intersects(a, b, pad: float = 0.0) -> bool:
    return not (
        a[2] + pad < b[0] or b[2] + pad < a[0] or a[3] + pad < b[1] or b[3] + pad < a[1]
    )


def _union(a, b):
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def _clamp(rect, box):
    return [
        max(rect[0], box[0]),
        max(rect[1], box[1]),
        min(rect[2], box[2]),
        min(rect[3], box[3]),
    ]


def _page_box(page) -> list[float]:
    for key in ("/CropBox", "/MediaBox"):
        try:
            values = [float(v) for v in page.obj.get(key)]
        except (TypeError, ValueError):
            continue
        if len(values) == 4:
            return [
                min(values[0], values[2]), min(values[1], values[3]),
                max(values[0], values[2]), max(values[1], values[3]),
            ]
    raise ValueError("This page has no media box.")


# ── the object walk ────────────────────────────────────────────────────────


class _AlphaState:
    """Soft-mask, blend mode and constant alpha, q/Q-stacked.

    `GraphicsTextState` does not track `gs`, and these four are exactly what
    decides whether an object composites or paints. They are graphics state
    like any other, so they save and restore in lockstep with q/Q — an alpha
    set inside a `q … Q` otherwise leaks onto everything drawn after it.
    """

    def __init__(self) -> None:
        self.fill_alpha = 1.0
        self.stroke_alpha = 1.0
        self.blend = "/Normal"
        self.smask = False
        #: Set when an `/ExtGState` this state was asked to apply would not
        #: read. It stacks with the rest, so a `Q` restores a state that was
        #: readable and everything drawn after it is judgeable again.
        self.unknown = False
        self._stack: list = []

    def push(self) -> None:
        self._stack.append(
            (self.fill_alpha, self.stroke_alpha, self.blend, self.smask, self.unknown)
        )

    def pop(self) -> None:
        if self._stack:
            (self.fill_alpha, self.stroke_alpha, self.blend, self.smask,
             self.unknown) = self._stack.pop()

    def apply(self, ext_gstate) -> str:
        """Apply one `/ExtGState`. Empty when every entry read, a reason code
        when one did not — an entry that will not read leaves the alpha an
        object composites through unknown, and an unknown alpha is not an
        opaque one."""
        if ext_gstate is None:
            return ""
        for key, attr in (("/ca", "fill_alpha"), ("/CA", "stroke_alpha")):
            try:
                value = ext_gstate.get(key)
            except Exception:
                self.unknown = True
                return _UNKNOWN_GSTATE
            if value is not None:
                try:
                    setattr(self, attr, float(value))
                except (TypeError, ValueError):
                    self.unknown = True
                    return _UNKNOWN_GSTATE
        try:
            blend = ext_gstate.get("/BM")
        except Exception:
            self.unknown = True
            return _UNKNOWN_GSTATE
        if blend is not None:
            if isinstance(blend, pikepdf.Array) and len(blend) > 0:
                blend = blend[0]
            self.blend = str(blend)
        try:
            smask = ext_gstate.get("/SMask")
        except Exception:
            self.unknown = True
            return _UNKNOWN_GSTATE
        if smask is not None:
            self.smask = str(smask) != "/None"
        return ""

    def transparent_for(self, kind: str) -> bool:
        if self.smask or self.blend not in _OPAQUE_BLENDS:
            return True
        if kind == "stroke":
            return self.stroke_alpha < 1.0
        if kind == "fillstroke":
            return self.fill_alpha < 1.0 or self.stroke_alpha < 1.0
        return self.fill_alpha < 1.0


def _ext_gstate(resources, name: str):
    """`(state, reason)` for one `gs` name.

    A name the page never defined resolves to None with no reason: nothing
    composites through a state that is not there. A table or an entry that
    will not read carries a reason instead — the state it would have set is
    unknown, and an unknown state is not an opaque one.
    """
    if resources is None or not name.startswith("/"):
        return None, ""
    try:
        table = resources.get("/ExtGState")
    except Exception:
        return None, _UNKNOWN_GSTATE
    if table is None:
        return None, ""
    try:
        return table.get(pikepdf.Name(name)), ""
    except Exception:
        return None, _UNKNOWN_GSTATE


def _form_is_group(xobj) -> str:
    """YES, NO or UNKNOWN — whether the form declares a transparency group."""
    try:
        group = xobj.get("/Group")
    except Exception:
        return UNKNOWN
    if group is None:
        return NO
    try:
        return YES if str(group.get("/S")) == "/Transparency" else NO
    except Exception:
        return UNKNOWN


def _image_is_masked(xobj) -> str:
    """YES, NO or UNKNOWN — whether the image carries a mask of either kind."""
    if xobj is None:
        return UNKNOWN
    try:
        if xobj.get("/SMask") is not None:
            return YES
        return YES if xobj.get("/Mask") is not None else NO
    except Exception:
        return UNKNOWN


def _placement(xobj, ctm):
    """`(rect, subtype, reason)` for one placed XObject.

    `rect` is the device box the object paints into: the unit square for an
    image, the form's own `/BBox` through its `/Matrix` for a form. It is None
    with an EMPTY reason when the object paints nothing a region could hold (a
    `/PS` XObject), and None with a REASON when the placement cannot be
    measured. The two are not the same: an object in no region is neither
    flattened nor weighed as preserved, so a placement that could not be read
    has to say so rather than vanish.
    """
    if xobj is None:
        return None, "", _UNKNOWN_READ
    try:
        subtype = str(xobj.get("/Subtype", ""))
    except Exception:
        return None, "", _UNKNOWN_READ
    if subtype == "/Image":
        return list(bbox_of_rect_under_matrix(ctm, 1.0, 1.0)), subtype, ""
    if subtype != "/Form":
        return None, subtype, ""
    try:
        bbox = xobj.get("/BBox")
    except Exception:
        return None, subtype, _UNKNOWN_READ
    if bbox is None:
        return None, subtype, _UNKNOWN_BBOX
    try:
        values = [float(v) for v in bbox]
    except (TypeError, ValueError):
        return None, subtype, _UNKNOWN_BBOX
    if len(values) != 4:
        return None, subtype, _UNKNOWN_BBOX
    try:
        matrix = mat_mult(_as_matrix(xobj.get("/Matrix")) or IDENTITY, ctm)
    except Exception:
        return None, subtype, _UNKNOWN_READ
    return list(bbox_of_corners_under_matrix(
        matrix,
        min(values[0], values[2]), min(values[1], values[3]),
        max(values[0], values[2]), max(values[1], values[3]),
    )), subtype, ""


def _form_transparency(xobj, depth: int = 0) -> tuple[str, str]:
    """`(YES|NO|UNKNOWN, reason)` — whether a form paints transparency.

    A form is transparency-bearing when it declares a transparency group, or
    when anything reachable inside it does. A group nested two forms down
    still composites the page, so the outer `Do` is what has to be absorbed —
    the region flattener removes whole page-level objects, never their
    interiors.

    Every place the walk cannot reach the whole interior answers UNKNOWN: the
    depth cap, a resource table that will not read, an `/ExtGState` entry that
    will not apply, a child whose subtype will not read. Each of those means
    "I could not tell", and reporting it as NO is what leaves live
    transparency behind a flatten that reported success.
    """
    if xobj is None or not isinstance(xobj, (pikepdf.Dictionary, pikepdf.Stream)):
        return UNKNOWN, _UNKNOWN_READ
    if depth > MAX_FORM_DEPTH:
        return UNKNOWN, _UNKNOWN_DEPTH
    group = _form_is_group(xobj)
    if group == YES:
        return YES, ""
    if group == UNKNOWN:
        return UNKNOWN, _UNKNOWN_READ
    try:
        resources = xobj.get("/Resources")
    except Exception:
        return UNKNOWN, _UNKNOWN_READ
    if resources is None:
        return NO, ""
    if not isinstance(resources, (pikepdf.Dictionary, pikepdf.Stream)):
        return UNKNOWN, _UNKNOWN_READ
    try:
        table = resources.get("/ExtGState")
    except Exception:
        return UNKNOWN, _UNKNOWN_GSTATE
    if table is not None:
        try:
            names = list(table.keys())
        except Exception:
            return UNKNOWN, _UNKNOWN_GSTATE
        for key in names:
            try:
                entry = table[key]
            except Exception:
                return UNKNOWN, _UNKNOWN_GSTATE
            state = _AlphaState()
            reason = state.apply(entry)
            if reason:
                return UNKNOWN, reason
            if state.transparent_for("fill") or state.transparent_for("stroke"):
                return YES, ""
    try:
        xobjects = resources.get("/XObject")
    except Exception:
        return UNKNOWN, _UNKNOWN_READ
    if xobjects is not None:
        try:
            names = list(xobjects.keys())
        except Exception:
            return UNKNOWN, _UNKNOWN_READ
        for key in names:
            try:
                child = xobjects[key]
                subtype = str(child.get("/Subtype", ""))
            except Exception:
                return UNKNOWN, _UNKNOWN_READ
            if subtype == "/Image":
                masked = _image_is_masked(child)
                if masked == YES:
                    return YES, ""
                if masked == UNKNOWN:
                    return UNKNOWN, _UNKNOWN_READ
            elif subtype == "/Form":
                state_of_child, reason = _form_transparency(child, depth + 1)
                if state_of_child == YES:
                    return YES, ""
                if state_of_child == UNKNOWN:
                    return UNKNOWN, reason
    return NO, ""


def _refuse_unknown(page: int, reason: str) -> None:
    """Refuse the flatten by name for a page the walk could not judge.

    The parameter is named for the placeholder it becomes: the refusal sweep
    reads this source, and an expression inside an f-string becomes an
    anonymous placeholder no translation can make sense of. The depth message
    is worded exactly as `outlines.py` words its own cap refusal, so one claim
    carries one table row and one translation.
    """
    if reason == _UNKNOWN_DEPTH:
        cap = MAX_FORM_DEPTH
        raise ValueError(
            f"Page {page} nests form XObjects deeper than {cap} levels."
        )
    if reason == _UNKNOWN_BBOX:
        raise ValueError(
            f"Page {page} places a form XObject whose /BBox cannot be "
            "measured, so the area it covers is unknown."
        )
    if reason == _UNKNOWN_GSTATE:
        raise ValueError(
            f"Page {page} names a graphics state this engine cannot read, so "
            "whether it paints transparency is unknown."
        )
    raise ValueError(
        f"Page {page} places a form XObject this engine cannot read, so "
        "whether it paints transparency is unknown."
    )


def _unknown_message(page: int, reason: str) -> str:
    """The sentence the refusal carries, for the report that must not raise.

    Asking the refusal itself keeps one wording: a classification that
    described an unjudgeable object differently from the refusal it predicts
    would be two claims about one document.
    """
    try:
        _refuse_unknown(page, reason)
    except ValueError as exc:
        return str(exc)
    return ""


def _text_rect(state, cap, raw_width: float) -> list[float]:
    combined = mat_mult(state.tm, state.ctm)
    return list(bbox_of_rect_under_matrix(
        combined,
        max(raw_width * state.h_scale, 0.01),
        max(state.font_size, 0.01),
    ))


def page_objects(pdf, page) -> tuple[list[dict], list[str]]:
    """`(objects, unknown reasons)` for everything the PAGE stream paints.

    One entry per painted path, per BT…ET text block, per placed XObject or
    inline image, and per shading, in encounter (paint) order. Each carries
    its device `rect`, the exact page-level instruction indices that draw it
    (`drop_idxs`), whether it participates in transparency, whether it paints
    through a pattern, and whether the walk could judge it at all.

    The second half is the page's UNKNOWN reasons, deduplicated in encounter
    order. A page that carries one cannot be flattened honestly: the flatten
    refuses by name and the classification reports the same sentence.

    The unit is deliberately PAGE-level: a form's interior is not addressed,
    because a region flatten removes whole objects and a half-removed form
    would draw its remainder through a raster that already contains it.
    """
    instructions = list(pikepdf.parse_content_stream(page))
    resources = _resolve_resources(page)
    state = GraphicsTextState(IDENTITY)
    alpha = _AlphaState()
    clips = ClipTracker(None)
    fonts = _FontCache()
    box = _page_box(page)

    out: list[dict] = []
    unknowns: list[str] = []
    construct: list[int] = []
    points: list[tuple[float, float]] = []
    has_clip = False
    line_width = 1.0
    width_stack: list[float] = []
    fill_is_pattern = False
    pattern_stack: list[bool] = []
    text_open: int | None = None
    text_rect: list[float] | None = None

    def note(reason: str) -> None:
        if reason and reason not in unknowns:
            unknowns.append(reason)

    def emit(kind: str, rect, drop_idxs, transparent: bool, pattern: bool,
             unknown: bool = False) -> None:
        if rect is None:
            rect = list(box)
        out.append({
            "index": len(out),
            "kind": kind,
            "rect": [float(v) for v in rect],
            "drop_idxs": sorted(set(drop_idxs)),
            "transparent": bool(transparent),
            "pattern": bool(pattern),
            "clipped": bool(clips.clips_away(tuple(rect))),
            "unknown": bool(unknown or alpha.unknown),
        })

    for idx, instruction in enumerate(instructions):
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        clips.feed(operator, operands, state.ctm)
        if operator == "q":
            width_stack.append(line_width)
            pattern_stack.append(fill_is_pattern)
            alpha.push()
        elif operator == "Q":
            if width_stack:
                line_width = width_stack.pop()
            if pattern_stack:
                fill_is_pattern = pattern_stack.pop()
            alpha.pop()
        if operator == "cs" and operands:
            fill_is_pattern = str(operands[0]) == "/Pattern"
        elif operator in ("g", "rg", "k"):
            # A device fill colour leaves the pattern space, so the next fill
            # is not a pattern fill. Without this the flag survives the whole
            # stream and every later fill claims to expand a pattern.
            fill_is_pattern = False
        if operator == "gs" and operands:
            ext_gstate, reason = _ext_gstate(resources, str(operands[0]))
            if reason:
                alpha.unknown = True
                note(reason)
            else:
                note(alpha.apply(ext_gstate))
            continue
        # BT/ET are text-state operators the state machine consumes, so the
        # block's extent is recorded BEFORE it is fed — a check after `feed`
        # never sees either one and every text block goes unlisted.
        if operator == "BT":
            text_open, text_rect = idx, None
        elif operator == "ET" and text_open is not None:
            emit("text", text_rect, range(text_open, idx + 1),
                 alpha.transparent_for("fill"), False)
            text_open, text_rect = None, None
        if state.feed(operator, operands):
            continue
        if operator == "w":
            try:
                line_width = float(operands[0])
            except (TypeError, ValueError, IndexError):
                pass
            continue
        if operator in _SHOW_OPS:
            if operator in ("'", '"'):
                state.next_line()
            cap = fonts.capability(resources, resources, state.font_name)
            _text, raw_width = _run_metrics(operator, operands, cap, state)
            rect = _text_rect(state, cap, raw_width)
            text_rect = rect if text_rect is None else _union(text_rect, rect)
            state.advance_after_show(raw_width, bool(cap is not None and cap.vertical))
            continue
        if operator in _CONSTRUCT:
            construct.append(idx)
            for point in _path_points(operator, operands, state.ctm):
                points.append(point)
            continue
        if operator in _CLIP:
            has_clip = True
            continue
        if operator in _PAINT_ALL:
            if operator in _PAINT_VISIBLE and not has_clip and points:
                if operator in _PAINT_FILL:
                    kind = "fill"
                elif operator in _PAINT_STROKE:
                    kind = "stroke"
                else:
                    kind = "fillstroke"
                ctm = state.ctm
                scale = math.sqrt(abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]))
                half = 0.0 if operator in _PAINT_FILL else max(0.0, line_width) / 2.0 * scale
                xs = [p[0] for p in points]
                ys = [p[1] for p in points]
                emit(
                    kind,
                    [min(xs) - half, min(ys) - half, max(xs) + half, max(ys) + half],
                    construct + [idx],
                    alpha.transparent_for(kind),
                    fill_is_pattern and operator not in _PAINT_STROKE,
                )
            construct, points, has_clip = [], [], False
            continue
        if operator == "Do" and operands:
            name = str(operands[0])
            xobj = _lookup_xobject(name, resources, resources)
            rect, subtype, reason = _placement(xobj, state.ctm)
            if reason:
                note(reason)
                # The rect defaults to the whole page box: an object whose
                # placement could not be measured is somewhere on this page,
                # and saying nothing is the failure this branch exists to end.
                emit("form" if subtype == "/Form" else "image", rect, [idx],
                     alpha.transparent_for("fill"), False, unknown=True)
            elif rect is not None:
                if subtype == "/Form":
                    inner, inner_reason = _form_transparency(xobj)
                    note(inner_reason)
                    emit("form", rect, [idx],
                         alpha.transparent_for("fill") or inner == YES, False,
                         unknown=inner == UNKNOWN)
                else:
                    masked = _image_is_masked(xobj)
                    if masked == UNKNOWN:
                        note(_UNKNOWN_READ)
                    emit("image", rect, [idx],
                         alpha.transparent_for("fill") or masked == YES, False,
                         unknown=masked == UNKNOWN)
            construct, points, has_clip = [], [], False
            continue
        if operator == "INLINE IMAGE":
            emit("image", list(bbox_of_rect_under_matrix(state.ctm, 1.0, 1.0)), [idx],
                 alpha.transparent_for("fill"), False)
            construct, points, has_clip = [], [], False
            continue
        if operator == "sh":
            rect = list(clips.clip) if clips.clip is not None else list(box)
            emit("shading", rect, [idx], alpha.transparent_for("fill"), False)
            construct, points, has_clip = [], [], False
            continue
        construct, points, has_clip = [], [], False
    return out, unknowns


def _path_points(operator: str, operands: list, ctm) -> list[tuple[float, float]]:
    try:
        values = [float(v) for v in operands]
    except (TypeError, ValueError):
        return []
    if operator == "re" and len(values) >= 4:
        x, y, w, h = values[0], values[1], values[2], values[3]
        return [transform_point(ctm, cx, cy) for cx, cy in
                ((x, y), (x + w, y), (x, y + h), (x + w, y + h))]
    points = []
    for i in range(0, len(values) - 1, 2):
        points.append(transform_point(ctm, values[i], values[i + 1]))
    return points


# ── regions ────────────────────────────────────────────────────────────────


# How fast the merge gap opens as the balance moves. The gap must span "only
# what a region actually overlaps" to "the whole page", and spreading that
# range LINEARLY over the control makes almost all of it useless: half a page
# diagonal already merges everything on a letter page, so every setting above
# about a tenth rasterizes the lot. Growing it geometrically puts the
# distances a user cares about — a few points to an inch or two — across the
# middle of the travel, which is where a control's positions should mean
# something.
_MERGE_CURVE = 6.0


def merge_gap(balance: float, diagonal: float) -> float:
    """The distance at which two regions, or a region and an object, merge.

    Zero at one end (nothing merges that does not already overlap) and the
    page's own diagonal at the other (everything merges), with the useful
    distances spread across the middle rather than crushed into the first tenth.
    """
    balance = max(0.0, min(1.0, float(balance)))
    if balance <= 0.0:
        return 0.0
    if balance >= 1.0:
        return diagonal
    span = math.expm1(_MERGE_CURVE) or 1.0
    return diagonal * math.expm1(_MERGE_CURVE * balance) / span


def compute_regions(objects: list[dict], page_box, balance: float, dpi: int) -> dict:
    """The regions that will rasterize, and which object goes into each.

    `balance` is the raster/vector control, 0…1. It is the merge gap as a
    fraction of the page diagonal: at 0 a region grows only over what it
    genuinely overlaps, and at 1 the gap spans the page, so every region and
    every object merge into one. Between the two it trades seams for live
    content, which is the trade the control exists to expose.

    The loop is a fixed point because absorbing an object grows a region, a
    grown region can reach further, and the snap grows it again. It is monotone
    and bounded by the page box, so it settles.
    """
    balance = max(0.0, min(1.0, float(balance)))
    diagonal = math.hypot(page_box[2] - page_box[0], page_box[3] - page_box[1])
    gap = merge_gap(balance, diagonal)

    # An object the walk could not judge is neither a seed nor a member: it
    # cannot be claimed transparent, and letting it grow a region would draw a
    # plan the flatten refuses to carry out.
    seeds = [dict(rect=list(o["rect"]), members=set())
             for o in objects
             if o["transparent"] and not o["clipped"] and not o.get("unknown")]
    if not seeds:
        return {"regions": [], "members": [], "whole_page": False, "passes": 0}

    passes = 0
    for passes in range(1, _MAX_REGION_PASSES + 1):
        changed = False
        for region in seeds:
            for obj in objects:
                if obj["index"] in region["members"] or obj["clipped"]:
                    continue
                if obj.get("unknown"):
                    continue
                if _intersects(region["rect"], obj["rect"], gap):
                    region["members"].add(obj["index"])
                    grown = _union(region["rect"], obj["rect"])
                    if grown != region["rect"]:
                        region["rect"] = grown
                    changed = True
        merged: list[dict] = []
        for region in seeds:
            for other in merged:
                if _intersects(other["rect"], region["rect"], gap):
                    other["rect"] = _union(other["rect"], region["rect"])
                    other["members"] |= region["members"]
                    changed = True
                    break
            else:
                merged.append(region)
        seeds = merged
        for region in seeds:
            snapped = _clamp([
                snap_to_pixel(region["rect"][0], dpi, False),
                snap_to_pixel(region["rect"][1], dpi, False),
                snap_to_pixel(region["rect"][2], dpi, True),
                snap_to_pixel(region["rect"][3], dpi, True),
            ], page_box)
            if snapped != region["rect"]:
                region["rect"] = snapped
                changed = True
        if not changed:
            break

    # "The whole page" is every object participating, not a region that
    # happens to reach the page edges: a margin nothing paints into is not
    # content the flatten spared.
    live = {o["index"] for o in objects
            if not o["clipped"] and not o.get("unknown")}
    absorbed: set[int] = set()
    for region in seeds:
        absorbed |= region["members"]
    whole_page = bool(live) and live <= absorbed
    return {
        "regions": [region["rect"] for region in seeds],
        "members": [sorted(region["members"]) for region in seeds],
        "whole_page": whole_page,
        "passes": passes,
    }


def _categorize(objects: list[dict], members: list[list[int]]) -> None:
    """Attach each object's categories in place.

    An object can carry several: a transparent object inside a region is both
    `transparent` and `rasterized`, and saying so is the point — the panel
    highlights by category and a single label would hide one of the two.
    """
    in_region = {index for group in members for index in group}
    for obj in objects:
        categories: list[str] = []
        if obj.get("unknown"):
            categories.append("unknown")
        if obj["transparent"]:
            categories.append("transparent")
        rasterized = obj["index"] in in_region
        if rasterized:
            categories.append("rasterized")
            if obj["kind"] == "text":
                categories.append("outlined_text")
            elif obj["kind"] in ("stroke", "fillstroke"):
                categories.append("outlined_strokes")
            if obj["pattern"]:
                categories.append("expanded_patterns")
        if not obj["transparent"] and _affected(obj, objects):
            categories.append("affected")
        obj["categories"] = categories


def _affected(obj: dict, objects: list[dict]) -> bool:
    """True when a transparent object drawn ABOVE this one overlaps it — the
    class the commercial preview calls "objects affected by transparency".
    Encounter order IS paint order, so "above" is a higher index."""
    for other in objects:
        if other["index"] <= obj["index"] or not other["transparent"]:
            continue
        if other["clipped"] or other.get("unknown"):
            continue
        if _intersects(obj["rect"], other["rect"]):
            return True
    return False


def _counts(objects: list[dict]) -> dict:
    counts = {name: 0 for name in CATEGORIES}
    for obj in objects:
        for category in obj.get("categories", ()):
            counts[category] = counts.get(category, 0) + 1
    return counts


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


def _public(obj: dict) -> dict:
    return {key: value for key, value in obj.items() if key != "drop_idxs"}


def list_transparency(
    file: str,
    pages=None,
    balance: float = DEFAULT_BALANCE,
    dpi: int = DEFAULT_DPI,
) -> dict:
    """What a page paints, classified, plus the regions a flatten would raster.

    Args:
        file: Input PDF path.
        pages: 1-based page numbers, or None for the whole document.
        balance: Raster/vector balance, 0…1 — the region merge aggressiveness.
        dpi: Resolution the region boundaries snap against.

    The classification is the report the panel highlights from, and it is
    produced WITHOUT writing anything: a user decides what to rasterize by
    seeing what would be rasterized, not by reading the result afterwards.

    A page carries `unknown`: the refusal sentences a flatten of it would
    raise, one per distinct reason. The panel states them before the apply,
    so the refusal is never the first the user hears of it.
    """
    validate_pdf(file)
    dpi = max(1, int(dpi))
    report: list[dict] = []
    with pikepdf.open(file) as pdf:
        for number in _page_numbers(pdf, pages):
            page = pdf.pages[number - 1]
            try:
                objects, unknowns = page_objects(pdf, page)
                box = _page_box(page)
            except ValueError:
                raise
            except Exception as exc:
                report.append({
                    "page": number, "error": str(exc), "objects": [], "regions": [],
                    "counts": {name: 0 for name in CATEGORIES}, "whole_page": False,
                    "unknown": [],
                })
                continue
            plan = compute_regions(objects, box, balance, dpi)
            _categorize(objects, plan["members"])
            report.append({
                "page": number,
                "error": None,
                "page_box": box,
                "objects": [_public(o) for o in objects],
                "regions": plan["regions"],
                "region_members": plan["members"],
                "region_pixels": [_pixel_extent(r, dpi) for r in plan["regions"]],
                "whole_page": plan["whole_page"],
                "counts": _counts(objects),
                "unknown": [_unknown_message(number, reason) for reason in unknowns],
            })
    return {
        "pages": report,
        "balance": max(0.0, min(1.0, float(balance))),
        "dpi": dpi,
        "transparent_pages": [p["page"] for p in report if p["counts"]["transparent"]],
        "unknown_pages": [p["page"] for p in report if p["unknown"]],
    }


# ── the apply ──────────────────────────────────────────────────────────────


def _region_source(pdf, number: int, region, work: Path, ordinal: int) -> Path:
    """A one-page PDF whose page box IS the region.

    Annotations are dropped: an annotation's appearance is not page content,
    and rasterizing it into the page would bake a live annotation into the
    paper it is drawn over.
    """
    out = work / f"region-{number}-{ordinal}.pdf"
    single = pikepdf.new()
    single.pages.append(pdf.pages[number - 1])
    page = single.pages[0]
    page.obj["/MediaBox"] = pikepdf.Array([region[0], region[1], region[2], region[3]])
    page.obj["/CropBox"] = pikepdf.Array([region[0], region[1], region[2], region[3]])
    if "/Annots" in page.obj:
        del page.obj["/Annots"]
    save_pdf(single, out)
    single.close()
    return out


def _rasterize_region(source: Path, target: Path, dpi: int, gs_path: str, what: str) -> None:
    cmd = [
        gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q",
        "-sDEVICE=pdfimage24", f"-r{int(dpi)}",
        "-dFirstPage=1", "-dLastPage=1",
        "-o", str(target).replace("%", "%%"), str(source),
    ]
    result = budget.gs(cmd, what=what, path=source, pages=1)
    if result.returncode != 0 or not target.is_file():
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"Ghostscript region rasterization failed: {detail}")


_PAINTING = _PAINT_VISIBLE | _SHOW_OPS | {"Do", "sh", "INLINE IMAGE"}


def drop_dead_frames(instructions: list) -> list:
    """Remove every balanced `q … Q` frame whose interior paints nothing.

    Dropping an object's construction and paint operators leaves the frame a
    producer wrapped it in — typically `q /GA gs 1 0 0 rg Q`, which still
    NAMES the soft mask or the alpha the flatten was asked to remove. A frame
    that paints nothing has no effect outside itself (its `Q` restores
    everything its interior set), so removing it is exact, and it is what lets
    the resource sweep reach the transparency constructs afterwards.

    Repeated to a fixed point: emptying an inner frame can empty its parent.
    """
    current = list(instructions)
    for _ in range(MAX_FORM_DEPTH + 2):
        opens: list[int] = []
        painted: list[bool] = []
        dead: set[int] = set()
        for index, instruction in enumerate(current):
            operator = str(instruction.operator)
            if operator == "q":
                opens.append(index)
                painted.append(False)
                continue
            if operator == "Q":
                if not opens:
                    continue
                start = opens.pop()
                drew = painted.pop()
                if drew:
                    if painted:
                        painted[-1] = True
                else:
                    dead.update(range(start, index + 1))
                continue
            if operator in _PAINTING and painted:
                painted[-1] = True
        if not dead:
            return current
        current = [ins for i, ins in enumerate(current) if i not in dead]
    return current


def _prune_resources(pdf, page, kept: list, extra_names: set) -> None:
    """Drop the resource entries the rebuilt stream no longer names.

    A flatten that leaves `/ca 0.5` sitting in the page's resources has not
    removed the document's transparency constructs — it has only stopped
    drawing through them, and the next reader still finds live transparency.
    The tables are rebuilt on a COPY of the resources dictionary, because a
    page's `/Resources` can be the neighbouring page's too.
    """
    resources = _copy_resources_for_write(pdf, _resolve_resources(page))
    page.obj["/Resources"] = resources
    used: dict[str, set[str]] = {
        "/ExtGState": set(), "/XObject": set(extra_names),
        "/Shading": set(), "/Pattern": set(),
    }
    for instruction in kept:
        operator = str(instruction.operator)
        operands = instruction.operands
        if not operands:
            continue
        if operator == "gs":
            used["/ExtGState"].add(str(operands[0]))
        elif operator == "Do":
            used["/XObject"].add(str(operands[0]))
        elif operator == "sh":
            used["/Shading"].add(str(operands[0]))
        elif operator in ("scn", "SCN"):
            name = str(operands[-1])
            if name.startswith("/"):
                used["/Pattern"].add(name)
    for key, live in used.items():
        table = resources.get(key)
        if table is None:
            continue
        fresh = pikepdf.Dictionary()
        for name in list(table.keys()):
            if str(name) in live:
                fresh[name] = table[name]
        resources[key] = fresh


def _fresh_name(resources, stem: str) -> str:
    try:
        existing = {str(k) for k in resources.get("/XObject").keys()}
    except Exception:
        existing = set()
    n = 0
    while f"/{stem}{n}" in existing:
        n += 1
    return f"/{stem}{n}"


def _fmt(value: float) -> str:
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    return text if text else "0"


def _outline(pdf, page, number: int, outline_text: bool, outline_strokes: bool,
             font_dir: str) -> dict:
    """The outline conversion's contribution to one page's report entry.

    Imported at call time: the conversion is an optional half of this door, and
    a module-level import would make every flatten pay for machinery most
    flattens never reach.
    """
    if not outline_text and not outline_strokes:
        return {}
    from .outlines import outline_page

    result = outline_page(pdf, page, number, font_dir, outline_text, outline_strokes)
    return {key: result[key] for key in
            ("text_runs", "invisible_runs", "glyphs", "strokes", "substituted")}


def flatten_transparency(
    file: str,
    output: str,
    pages=None,
    balance: float = DEFAULT_BALANCE,
    dpi: int = DEFAULT_DPI,
    gs_path: str = "",
    outline_text: bool = False,
    outline_strokes: bool = False,
    font_dir: str = "",
) -> dict:
    """Flatten each page's transparency by rasterizing only its regions.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        pages: 1-based page numbers, or None for the whole document.
        balance: Raster/vector balance, 0…1 — the region merge aggressiveness.
        dpi: Resolution the regions rasterize at, and snap against.
        gs_path: Path to the Ghostscript executable.
        outline_text: Replace every surviving glyph run with its outlines.
        outline_strokes: Replace every surviving stroke with its filled outline.
        font_dir: Directory of bundled faces, for text whose font the document
            does not embed.

    Content outside every region is untouched: live text stays live text, and
    a vector stays a vector. A page with no transparency is reported and left
    exactly as it was rather than rewritten to no effect.

    The two outline conversions run AFTER the region rebuild, on what is still
    live: content a region absorbed is already gone, so nothing is outlined
    only to be covered by a raster.

    A page carrying an object the walk could not judge REFUSES by name and
    writes nothing. The alternative is a success report over surviving
    transparency, which is the one outcome this door must never produce.
    """
    validate_pdf(file)
    dpi = max(1, int(dpi))
    work = Path(tempfile.mkdtemp(prefix="spectrapdf-flatten-"))
    report: list[dict] = []
    try:
        with contextlib.ExitStack() as stack:
            pdf = stack.enter_context(pikepdf.open(file))
            numbers = _page_numbers(pdf, pages)
            for number in numbers:
                page = pdf.pages[number - 1]
                box = _page_box(page)
                try:
                    objects, unknowns = page_objects(pdf, page)
                except Exception as exc:
                    report.append({"page": number, "regions": 0, "removed": 0,
                                   "error": str(exc)})
                    continue
                if unknowns:
                    _refuse_unknown(number, unknowns[0])
                plan = compute_regions(objects, box, balance, dpi)
                regions = plan["regions"]
                if not regions:
                    entry = {"page": number, "regions": 0, "removed": 0,
                             "error": None}
                    entry.update(_outline(pdf, page, number, outline_text,
                                          outline_strokes, font_dir))
                    report.append(entry)
                    continue
                for ordinal, region in enumerate(regions):
                    width, height = _pixel_extent(region, dpi)
                    if width * height > MAX_REGION_PIXELS:
                        # The ordinal is a named local because the refusal
                        # sweep reads the engine's source: an expression inside
                        # an f-string becomes an anonymous placeholder that no
                        # translation can make sense of.
                        region_number = ordinal + 1
                        raise ValueError(
                            f"Flattening region {region_number} at {dpi} dpi would "
                            f"need {width}x{height} pixels."
                        )
                instructions = list(pikepdf.parse_content_stream(page))
                drop: set[int] = set()
                for group in plan["members"]:
                    for index in group:
                        drop.update(objects[index]["drop_idxs"])
                kept = drop_dead_frames(
                    [ins for i, ins in enumerate(instructions) if i not in drop]
                )
                rasters: list[tuple[str, object]] = []
                for ordinal, region in enumerate(regions):
                    source = _region_source(pdf, number, region, work, ordinal)
                    raster = work / f"raster-{number}-{ordinal}.pdf"
                    _rasterize_region(source, raster, dpi, gs_path,
                                      f"Transparency flattening (page {number})")
                    raster_pdf = stack.enter_context(pikepdf.open(raster))
                    rasters.append((f"/FlatR{ordinal}", _xobject_for(pdf, raster_pdf, 0, {})))
                _prune_resources(pdf, page, kept, {name for name, _ in rasters})
                resources = page.obj["/Resources"]
                if "/XObject" not in resources:
                    resources["/XObject"] = pikepdf.Dictionary()
                placements: list[str] = []
                for (name, xobj), region in zip(rasters, regions):
                    resources["/XObject"][pikepdf.Name(name)] = xobj
                    # The raster page's box starts at 0,0 and already measures
                    # the region in points, so the placement is a pure
                    # translation — no scale can creep in to resample it.
                    placements.append(
                        f"q 1 0 0 1 {_fmt(region[0])} {_fmt(region[1])} cm {name} Do Q"
                    )
                body = pikepdf.unparse_content_stream(kept)
                page.Contents = pdf.make_stream(
                    body + b"\n" + "\n".join(placements).encode("ascii")
                )
                entry = {
                    "page": number,
                    "regions": len(regions),
                    "removed": sum(len(group) for group in plan["members"]),
                    "whole_page": plan["whole_page"],
                    "error": None,
                }
                entry.update(_outline(pdf, page, number, outline_text,
                                      outline_strokes, font_dir))
                report.append(entry)
            # Same-file output takes temp-and-rename: pikepdf refuses to save
            # over the file it is reading, and the panel's apply routes the
            # working file back onto itself.
            _save(pdf, Path(file), Path(output))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {
        "output": str(output),
        "pages": report,
        "balance": max(0.0, min(1.0, float(balance))),
        "dpi": dpi,
        "regions": sum(entry["regions"] for entry in report),
        "outlined_text_runs": sum(entry.get("text_runs", 0) for entry in report),
        "outlined_strokes": sum(entry.get("strokes", 0) for entry in report),
        "substituted": sorted({
            face
            for entry in report
            for face in (entry.get("substituted") or {}).values()
        }),
    }
