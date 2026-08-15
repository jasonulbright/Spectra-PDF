"""Content-stream analysis for text a reader cannot see.

Four things make text invisible without removing it from the file, and an
extractor reads all four exactly as it reads visible text:

  1. a non-painting render mode (``3 Tr``, and ``7 Tr`` which only clips);
  2. a fill colour equal to whatever is painted under the run;
  3. a later opaque object drawn over it;
  4. membership of an optional-content group that is OFF in the default
     configuration.

The walk is one depth-first pass that emits an ORDERED event list — text
shows, painted fills, image placements — because three of the four detectors
are questions about what was painted BEFORE or AFTER a run, and a separate
walk per detector could not answer them consistently. Form XObjects recurse at
their ``Do`` position, so event order is paint order.

Two conservatisms are deliberate, both in the direction of leaving content
alone:

  * a covering object counts only when it is an AXIS-ALIGNED rectangle (or an
    axis-aligned image placement). A general path's bounding box claims more
    coverage than the path paints, and acting on that claim deletes text a
    reader can see.
  * PARTIAL coverage is reported and never removed. The uncovered half is
    content.

Run ids are the depth-first show-operator encounter order. The analysis walk
and the removal walk below share that traversal shape, which is what makes an
id from one addressable by the other.
"""

from typing import NamedTuple, Optional

import pikepdf
from pikepdf import Name

from engine import color_spaces
from engine.content_walk import (
    IDENTITY,
    Matrix,
    Rect,
    as_matrix,
    bbox_of_corners_under_matrix,
    mat_mult,
    transform_point,
)
from engine.redact import (
    MAX_FORM_DEPTH,
    _copy_resources_for_write,
    _drop_replaced_forms,
    _lookup_xobject,
    _referenced_xobject_names,
    _resolve_resources,
    _span_bbox,
    _split_instructions,
    _state_only_instructions,
)
from engine.text_metrics import (
    _child_state,
    _FontCache,
    _lookup_font,
    _run_metrics,
    measurable,
    show_bytes,
    show_clusters,
    show_items,
    wide_width,
)

SHOW_OPS = ("Tj", "'", '"', "TJ")

# Render modes that paint no glyph. 7 adds to the clip path only; 3 paints
# nothing at all.
INVISIBLE_MODES = frozenset({3, 7})
# Render modes whose glyphs are painted with the FILL colour. 1 and 5 stroke
# only, so their visibility is a question about the stroke colour.
FILL_MODES = frozenset({0, 2, 4, 6})

# Per-channel sRGB distance at which two colours are treated as the same. One
# 8-bit step is 1/255; the threshold sits just above it so a rounded-trip
# colour still matches.
COLOR_TOLERANCE = 0.005

# A placement covering at least this fraction of the page box makes the page a
# scan, which is what puts its invisible text in the recognition sub-class.
SCAN_COVERAGE = 0.8

# Below this the geometry is degenerate and containment tests are meaningless.
MIN_EXTENT = 0.01

# The name this tool's own recognition overlay is registered under.
OCR_FORM_NAME = "/SpectraPDFOCR"


class HiddenRun(NamedTuple):
    index: int
    kind: str
    text: str
    rect: Rect


class _Event(NamedTuple):
    """One painting event in depth-first (paint) order."""

    kind: str  # "text" | "cover"
    rect: Rect
    payload: dict


def _axis_aligned(m: Matrix) -> bool:
    """Does this matrix map axis-parallel edges to axis-parallel edges?"""
    return (abs(m[1]) < 1e-9 and abs(m[2]) < 1e-9) or (
        abs(m[0]) < 1e-9 and abs(m[3]) < 1e-9
    )


def _contains(outer: Rect, inner: Rect, slack: float = 0.0) -> bool:
    return (
        outer[0] - slack <= inner[0]
        and outer[1] - slack <= inner[1]
        and outer[2] + slack >= inner[2]
        and outer[3] + slack >= inner[3]
    )


def _intersects(a: Rect, b: Rect) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _area(r: Rect) -> float:
    return max(0.0, r[2] - r[0]) * max(0.0, r[3] - r[1])


def _colors_match(a, b) -> bool:
    if a is None or b is None:
        return False
    return all(abs(float(x) - float(y)) <= COLOR_TOLERANCE for x, y in zip(a, b))


def _color_rgb(color_state, resources, pdf):
    """Best-effort sRGB for a captured colour state. Device operators resolve
    inline; a named space resolves through the stream's /ColorSpace."""
    if color_state is None:
        return None
    space_op, value_op = color_state
    if value_op is None:
        # No value set and no non-device space selected is the stream default,
        # device-gray black.
        return [0.0, 0.0, 0.0] if space_op is None else None
    op, vals = value_op
    opl = op.lower()
    if opl in ("g", "rg", "k"):
        try:
            nums = [float(v) for v in vals]
        except (TypeError, ValueError):
            return None
        if opl == "g" and len(nums) == 1:
            v = min(1.0, max(0.0, nums[0]))
            return [v, v, v]
        if opl == "rg" and len(nums) == 3:
            return [min(1.0, max(0.0, c)) for c in nums]
        if opl == "k" and len(nums) == 4:
            c, m, y, k = (min(1.0, max(0.0, n)) for n in nums)
            return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
        return None
    return color_spaces.resolve_color(space_op, value_op, resources, pdf)


# ── optional content ──────────────────────────────────────────────────────


def _objgen(obj):
    try:
        og = obj.objgen
    except Exception:
        return None
    return og if og != (0, 0) else None


def off_ocg_set(pdf) -> set:
    """The objgens of every optional-content group hidden by the DEFAULT
    configuration. /BaseState /OFF inverts the question: everything is hidden
    except what /ON names."""
    ocp = pdf.Root.get("/OCProperties")
    if not isinstance(ocp, pikepdf.Dictionary):
        return set()
    d = ocp.get("/D")
    if not isinstance(d, pikepdf.Dictionary):
        return set()

    def og_set(key):
        arr = d.get(key)
        out = set()
        if isinstance(arr, pikepdf.Array):
            for el in arr:
                og = _objgen(el)
                if og is not None:
                    out.add(og)
        return out

    base_off = str(d.get("/BaseState", "")) == "/OFF"
    if not base_off:
        return og_set("/OFF")
    everything = set()
    ocgs = ocp.get("/OCGs")
    if isinstance(ocgs, pikepdf.Array):
        for el in ocgs:
            og = _objgen(el)
            if og is not None:
                everything.add(og)
    return everything - og_set("/ON")


def oc_hidden(obj, off_set: set) -> bool:
    """Is this /OC value (an OCG, or an OCMD naming several) hidden in the
    default configuration? An OCMD's /P policy decides; AnyOn is the default."""
    if not isinstance(obj, pikepdf.Dictionary):
        return False
    kind = str(obj.get("/Type", ""))
    if kind == "/OCMD":
        groups = obj.get("/OCGs")
        members = []
        if isinstance(groups, pikepdf.Array):
            members = [g for g in groups]
        elif isinstance(groups, pikepdf.Dictionary):
            members = [groups]
        if not members:
            return False
        states = []
        for g in members:
            og = _objgen(g)
            states.append(og is not None and og in off_set)
        policy = str(obj.get("/P", "/AnyOn"))
        if policy == "/AllOn":
            return any(states)
        if policy == "/AnyOff":
            return not any(states)
        if policy == "/AllOff":
            return not all(states)
        return all(states)  # AnyOn: visible while any member is on
    og = _objgen(obj)
    return og is not None and og in off_set


def _bdc_hidden(operands: list, resources, off_set: set) -> bool:
    """Does this BDC open a hidden optional-content block? The property is
    either an inline dictionary or a name resolved through /Properties."""
    if len(operands) < 2 or str(operands[0]) != "/OC":
        return False
    prop = operands[1]
    if isinstance(prop, pikepdf.Dictionary):
        return oc_hidden(prop, off_set)
    try:
        name = str(prop)
    except Exception:
        return False
    props = resources.get("/Properties") if resources is not None else None
    if not isinstance(props, pikepdf.Dictionary):
        return False
    target = props.get(Name(name))
    return oc_hidden(target, off_set) if target is not None else False


# ── path geometry ─────────────────────────────────────────────────────────


class _PathBox:
    """The device-space box of the path under construction, plus whether that
    path is a single axis-aligned rectangle. Only a rectangle is trusted as a
    cover: a bounding box over a general path claims coverage the path does
    not paint."""

    def __init__(self):
        self.reset()

    def reset(self) -> None:
        self.points: list = []
        self.subpaths = 0
        self.rect_only = True
        self._current: list = []

    def _push(self, pt) -> None:
        self.points.append(pt)
        self._current.append(pt)

    def rect(self, operands: list, ctm: Matrix) -> None:
        try:
            x, y, w, h = (float(v) for v in operands[:4])
        except (TypeError, ValueError, IndexError):
            self.rect_only = False
            return
        self._end_sub()
        self.subpaths += 1
        for cx, cy in ((x, y), (x + w, y), (x + w, y + h), (x, y + h)):
            self._push(transform_point(ctm, cx, cy))
        if not _axis_aligned(ctm):
            self.rect_only = False
        self._end_sub()

    def move(self, operands: list, ctm: Matrix) -> None:
        self._end_sub()
        self.subpaths += 1
        try:
            self._push(transform_point(ctm, float(operands[0]), float(operands[1])))
        except (TypeError, ValueError, IndexError):
            self.rect_only = False

    def line(self, operands: list, ctm: Matrix) -> None:
        try:
            self._push(transform_point(ctm, float(operands[0]), float(operands[1])))
        except (TypeError, ValueError, IndexError):
            self.rect_only = False

    def curve(self, operands: list, ctm: Matrix) -> None:
        # A curve is never a rectangle edge; its control points still bound it.
        self.rect_only = False
        for i in range(0, len(operands) - 1, 2):
            try:
                self._push(transform_point(ctm, float(operands[i]), float(operands[i + 1])))
            except (TypeError, ValueError):
                return

    def _end_sub(self) -> None:
        pts = self._current
        self._current = []
        if not pts:
            return
        if len(pts) == 5 and _same_point(pts[0], pts[4]):
            pts = pts[:4]
        if len(pts) != 4 or not _is_axis_rect(pts):
            self.rect_only = False

    def finish(self) -> tuple:
        self._end_sub()
        if not self.points:
            return None, False
        xs = [p[0] for p in self.points]
        ys = [p[1] for p in self.points]
        box = (min(xs), min(ys), max(xs), max(ys))
        return box, bool(self.rect_only and self.subpaths == 1)


def _same_point(a, b) -> bool:
    return abs(a[0] - b[0]) < 1e-6 and abs(a[1] - b[1]) < 1e-6


def _is_axis_rect(pts: list) -> bool:
    closed = list(pts) + [pts[0]]
    for i in range(4):
        dx = abs(closed[i + 1][0] - closed[i][0])
        dy = abs(closed[i + 1][1] - closed[i][1])
        if dx > 1e-6 and dy > 1e-6:
            return False
    return True


_CONSTRUCT_MOVE = ("m",)
_CONSTRUCT_LINE = ("l",)
_CONSTRUCT_CURVE = ("c", "v", "y")
_CONSTRUCT_RECT = ("re",)
_CLOSE = ("h",)
_PAINT = ("f", "F", "f*", "B", "B*", "b", "b*", "S", "s", "n")
_PAINT_FILLS = ("f", "F", "f*", "B", "B*", "b", "b*")
_CLIP_OPS = ("W", "W*")


# ── graphics-state alpha ──────────────────────────────────────────────────


def _gs_opacity(resources, name) -> Optional[dict]:
    """The fill alpha, soft mask and blend mode an /ExtGState names, or None
    when the resource cannot be resolved."""
    if resources is None:
        return None
    egs = resources.get("/ExtGState")
    if not isinstance(egs, pikepdf.Dictionary):
        return None
    entry = egs.get(Name(str(name)))
    if not isinstance(entry, pikepdf.Dictionary):
        return None
    out: dict = {}
    if "/ca" in entry:
        try:
            out["ca"] = float(entry["/ca"])
        except (TypeError, ValueError):
            pass
    if "/SMask" in entry:
        out["smask"] = str(entry["/SMask"]) != "/None"
    if "/BM" in entry:
        bm = entry["/BM"]
        first = str(bm[0]) if isinstance(bm, pikepdf.Array) and len(bm) else str(bm)
        out["blend"] = first
    return out


class _AlphaState:
    """Fill alpha, soft mask and blend mode, stacked with q/Q the way every
    other graphics-state parameter is."""

    def __init__(self, alpha: float = 1.0, smask: bool = False, blend: str = "/Normal"):
        self.alpha = alpha
        self.smask = smask
        self.blend = blend
        self._stack: list = []

    def push(self) -> None:
        self._stack.append((self.alpha, self.smask, self.blend))

    def pop(self) -> None:
        if self._stack:
            self.alpha, self.smask, self.blend = self._stack.pop()

    def apply(self, info: Optional[dict]) -> None:
        if not info:
            return
        if "ca" in info:
            self.alpha = info["ca"]
        if "smask" in info:
            self.smask = info["smask"]
        if "blend" in info:
            self.blend = info["blend"]

    @property
    def opaque(self) -> bool:
        return (
            self.alpha >= 1.0 - 1e-6
            and not self.smask
            and self.blend in ("/Normal", "/Compatible")
        )


def _image_is_opaque(xobj) -> bool:
    if not isinstance(xobj, pikepdf.Stream):
        return False
    if "/SMask" in xobj:
        return False
    mask = xobj.get("/Mask")
    return mask is None


# ── the analysis walk ─────────────────────────────────────────────────────


class _Analysis:
    def __init__(self, pdf, off_set: set, page_box: Rect):
        self.pdf = pdf
        self.off_set = off_set
        self.page_box = page_box
        self.events: list = []
        self.fonts = _FontCache()
        self.run_index = 0
        self.layer_blocks = 0
        self.scan_cover = 0.0


def _walk_analysis(
    an: _Analysis,
    instructions,
    resources,
    fallback,
    base_ctm: Matrix,
    depth: int,
    parent_state=None,
    hidden_depth: int = 0,
    in_ocr_form: bool = False,
) -> None:
    state = _child_state(base_ctm, parent_state)
    alpha = _AlphaState()
    path = _PathBox()
    pending_clip = False
    # Nesting depth of marked-content sections, and the depth at which the
    # outermost HIDDEN optional-content section opened. A run is off-layer
    # while that marker stands.
    mc_depth = 0
    hidden_at = None if hidden_depth == 0 else 0

    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)

        if operator == "q":
            alpha.push()
        elif operator == "Q":
            alpha.pop()
        elif operator == "gs" and operands:
            alpha.apply(_gs_opacity(resources, operands[0]))

        if operator == "BDC" or operator == "BMC":
            mc_depth += 1
            if (
                hidden_at is None
                and operator == "BDC"
                and _bdc_hidden(operands, resources, an.off_set)
            ):
                hidden_at = mc_depth
                an.layer_blocks += 1
            continue
        if operator == "EMC":
            if hidden_at is not None and mc_depth == hidden_at:
                hidden_at = None
            mc_depth = max(0, mc_depth - 1)
            continue

        if state.feed(operator, operands):
            continue

        if operator in _CONSTRUCT_RECT:
            path.rect(operands, state.ctm)
            continue
        if operator in _CONSTRUCT_MOVE:
            path.move(operands, state.ctm)
            continue
        if operator in _CONSTRUCT_LINE:
            path.line(operands, state.ctm)
            continue
        if operator in _CONSTRUCT_CURVE:
            path.curve(operands, state.ctm)
            continue
        if operator in _CLOSE:
            continue
        if operator in _CLIP_OPS:
            pending_clip = True
            continue
        if operator in _PAINT:
            box, is_rect = path.finish()
            if (
                operator in _PAINT_FILLS
                and box is not None
                and not pending_clip
                and hidden_at is None
                and alpha.opaque
            ):
                an.events.append(
                    _Event(
                        "cover",
                        box,
                        {
                            "rgb": _color_rgb(state.fill_color, resources, an.pdf),
                            "trusted": is_rect,
                        },
                    )
                )
            path.reset()
            pending_clip = False
            continue

        if operator in SHOW_OPS:
            if operator in ("'", '"'):
                state.next_line()
                if operator == '"' and len(operands) >= 2:
                    try:
                        state.word_spacing = float(operands[0])
                        state.char_spacing = float(operands[1])
                    except (TypeError, ValueError):
                        pass
            cap = an.fonts.capability(resources, fallback, state.font_name)
            data = show_bytes(operator, operands)
            if measurable(cap, data):
                text, raw_width = _run_metrics(operator, operands, cap, state)
            else:
                text, raw_width = "", wide_width(operator, operands, cap, state)
            vertical = bool(cap is not None and cap.writes_vertical)
            combined = mat_mult(state.tm, state.ctm)
            ink = an.fonts.ink_extent(resources, fallback, state.font_name)
            if vertical:
                rect = _span_bbox(combined, 0.0, max(raw_width, MIN_EXTENT), True, state, ink)
            else:
                rect = _span_bbox(combined, 0.0, raw_width, False, state, ink)
            an.events.append(
                _Event(
                    "text",
                    rect,
                    {
                        "index": an.run_index,
                        "text": text,
                        "mode": state.render_mode,
                        "rgb": _color_rgb(state.fill_color, resources, an.pdf),
                        "off_layer": hidden_at is not None,
                        "ocr_form": in_ocr_form,
                        "empty": not text.strip(),
                        # The rendered size and the font's own name. Read by
                        # the contrast check, whose threshold is a function of
                        # both (WCAG's large-text rule). The size is the Tf
                        # operand scaled by the text+CTM matrix's vertical
                        # magnitude, so a run scaled by its matrix reports the
                        # size it is painted at.
                        "size": _rendered_size(state, combined),
                        "font": _base_font(state.font_name, resources, fallback),
                    },
                )
            )
            an.run_index += 1
            state.advance_after_show(raw_width, vertical)
            continue

        if operator == "INLINE IMAGE":
            box = bbox_of_corners_under_matrix(state.ctm, 0.0, 0.0, 1.0, 1.0)
            if hidden_at is None and alpha.opaque:
                an.events.append(
                    _Event("cover", box, {"rgb": None, "trusted": _axis_aligned(state.ctm)})
                )
            _note_scan(an, box)
            continue

        if operator == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback)
            subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""
            xobj_hidden = xobj is not None and oc_hidden(xobj.get("/OC"), an.off_set)
            if subtype == "/Image":
                box = bbox_of_corners_under_matrix(state.ctm, 0.0, 0.0, 1.0, 1.0)
                if hidden_at is None and not xobj_hidden and alpha.opaque and _image_is_opaque(xobj):
                    an.events.append(
                        _Event("cover", box, {"rgb": None, "trusted": _axis_aligned(state.ctm)})
                    )
                _note_scan(an, box)
            elif subtype == "/Form" and depth < MAX_FORM_DEPTH:
                if xobj_hidden and hidden_at is None:
                    an.layer_blocks += 1
                form_matrix = as_matrix(xobj.get("/Matrix")) or IDENTITY
                form_res = xobj.get("/Resources")
                _walk_analysis(
                    an,
                    pikepdf.parse_content_stream(xobj),
                    form_res if form_res is not None else resources,
                    resources,
                    mat_mult(form_matrix, state.ctm),
                    depth + 1,
                    parent_state=state,
                    hidden_depth=1 if (hidden_at is not None or xobj_hidden) else 0,
                    in_ocr_form=in_ocr_form or name == OCR_FORM_NAME,
                )
            continue

        # Anything else abandons the path under construction.
        path.reset()
        pending_clip = False


def _note_scan(an: _Analysis, box: Rect) -> None:
    page_area = _area(an.page_box)
    if page_area <= 0:
        return
    an.scan_cover = max(an.scan_cover, _area(box) / page_area)


def _base_font(name, resources, fallback) -> str:
    """The /BaseFont of the font a /Tf name resolves to, or "" — the weight the
    large-text contrast threshold reads is spelled in that name, not in the
    resource key."""
    try:
        font = _lookup_font(name, resources, fallback)
    except Exception:
        return ""
    if font is None:
        return ""
    try:
        base = font.get("/BaseFont")
        return str(base) if base is not None else ""
    except Exception:
        return ""


def _rendered_size(state, combined: Matrix) -> float:
    """The run's font size in page units: the /Tf operand carried through the
    text and current transformation matrices' vertical magnitude."""
    try:
        size = float(state.font_size)
    except (TypeError, ValueError):
        return 0.0
    try:
        scale = (float(combined[2]) ** 2 + float(combined[3]) ** 2) ** 0.5
    except (TypeError, ValueError, IndexError):
        scale = 1.0
    # The /Tf operand is applied OUTSIDE the text matrix, so the two multiply.
    # A degenerate matrix leaves the declared size alone rather than reporting
    # a zero-point run.
    return abs(size) * (scale if scale > MIN_EXTENT else 1.0)


def backdrop_under(events: list, position: int, rect: Rect) -> tuple:
    """(sRGB, trusted) of what is painted under the event at `position`.

    The last cover CONTAINING the rect wins, and the answer is trusted only
    when that cover is one this walk trusts (an axis-aligned rectangle or
    image placement). An untrusted cover — a general path, a shading, an image
    whose colour this walk never resolved — still ANSWERS, and answers
    untrusted: the run is over something, and what it is over is unknown.
    White is the page's own default, and it is trusted.
    """
    rgb = [1.0, 1.0, 1.0]
    trusted = True
    for i, event in enumerate(events):
        if i > position:
            break
        if event.kind != "cover":
            continue
        if not _contains(event.rect, rect):
            continue
        payload = event.payload
        if payload["trusted"] and payload["rgb"] is not None:
            rgb = payload["rgb"]
            trusted = True
        else:
            # An opaque cover whose colour is unknowable (an image, a shading)
            # or whose shape is not a rectangle: it IS the backdrop, and it is
            # not measurable.
            trusted = False
    return rgb, trusted


def _classify(an: _Analysis) -> list:
    """Turn the ordered event list into the hidden runs. Background is the last
    trusted cover painted UNDER the run; concealment is any trusted cover
    painted OVER it."""
    covers = [(i, e) for i, e in enumerate(an.events) if e.kind == "cover"]
    out: list = []
    for position, event in enumerate(an.events):
        if event.kind != "text":
            continue
        info = event.payload
        if info["empty"]:
            continue
        rect = event.rect
        if info["off_layer"]:
            out.append(HiddenRun(info["index"], "off_layer", info["text"], rect))
            continue
        if info["mode"] in INVISIBLE_MODES:
            kind = (
                "ocr_layer"
                if info["ocr_form"] or an.scan_cover >= SCAN_COVERAGE
                else "invisible"
            )
            out.append(HiddenRun(info["index"], kind, info["text"], rect))
            continue
        if info["mode"] in FILL_MODES:
            # The hidden-text question and the contrast question read the SAME
            # backdrop: one walk, one answer about what is painted under a run.
            # An untrusted answer withholds the claim entirely — a run over an
            # image or a general path may be perfectly legible, and matching it
            # against the trusted cover further down would delete visible text.
            background, trusted = backdrop_under(an.events, position, rect)
            if trusted and _colors_match(info["rgb"], background):
                out.append(HiddenRun(info["index"], "background_fill", info["text"], rect))
                continue
        covered = False
        partial = False
        for i, cover in covers:
            if i <= position or not cover.payload["trusted"]:
                continue
            if _contains(cover.rect, rect):
                covered = True
                break
            if _intersects(cover.rect, rect):
                partial = True
        if covered:
            out.append(HiddenRun(info["index"], "covered", info["text"], rect))
        elif partial:
            out.append(HiddenRun(info["index"], "partially_covered", info["text"], rect))
    return out


def _page_box(page) -> Rect:
    for key in ("/CropBox", "/MediaBox"):
        try:
            arr = page.obj.get(key)
            if arr is None:
                continue
            v = [float(x) for x in arr]
            return (min(v[0], v[2]), min(v[1], v[3]), max(v[0], v[2]), max(v[1], v[3]))
        except (TypeError, ValueError, IndexError):
            continue
    return (0.0, 0.0, 612.0, 792.0)


def analyze_page(pdf, page, off_set: set) -> dict:
    """Hidden runs on one page, plus how many hidden optional-content blocks
    its streams carry."""
    an = page_events(pdf, page, off_set)
    return {"runs": _classify(an), "layer_blocks": an.layer_blocks}


def page_events(pdf, page, off_set: set) -> _Analysis:
    """The raw ordered paint-event walk of one page.

    `analyze_page`'s sibling: the same walk, stopping before the hidden-text
    classification, so a second question about paint order (contrast against
    the backdrop) is answered from the same events rather than from a second
    traversal.
    """
    resources = _resolve_resources(page)
    an = _Analysis(pdf, off_set, _page_box(page))
    _walk_analysis(an, pikepdf.parse_content_stream(page), resources, None, IDENTITY, 0)
    return an


# ── removing hidden optional content ──────────────────────────────────────


def _balancing(buffer: list) -> list:
    """The save/restore operators a dropped block must keep.

    Marked-content sequences are required to nest properly with the graphics
    state stack, so a well-formed block saves and restores in equal measure and
    dropping all of it leaves the stack where it was. A malformed block that
    does not balance keeps its `q`/`Q` operators, so the stack depth after the
    removal still matches what the rest of the stream expects."""
    saves = sum(1 for i in buffer if str(i.operator) == "q")
    restores = sum(1 for i in buffer if str(i.operator) == "Q")
    if saves == restores:
        return []
    return [i for i in buffer if str(i.operator) in ("q", "Q")]


def _prune_hidden_xobjects(resources, kept: list, dropped: set) -> None:
    """Drop the XObject entries whose only draws were removed. Without this the
    stream no longer paints them and their bytes are still in the file, which
    is the difference between hiding and removing."""
    if not dropped or not isinstance(resources, pikepdf.Dictionary):
        return
    table = resources.get("/XObject")
    if not isinstance(table, pikepdf.Dictionary):
        return
    still_drawn = {
        str(i.operands[0]) for i in kept if str(i.operator) == "Do" and i.operands
    }
    for name in dropped - still_drawn:
        if Name(name) in table:
            del table[Name(name)]


def _strip_hidden(pdf, instructions, resources, fallback, off_set, stats, depth, seen) -> tuple:
    """Rebuild one instruction list with every hidden optional-content block
    and every hidden XObject draw gone. Returns (kept, dropped XObject names)."""
    kept: list = []
    dropped: set = set()
    buffer: list = []
    mc_depth = 0
    drop_at = None
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)

        if operator in ("BDC", "BMC"):
            mc_depth += 1
            if drop_at is not None:
                buffer.append(instruction)
                continue
            if operator == "BDC" and _bdc_hidden(operands, resources, off_set):
                drop_at = mc_depth
                stats["blocks"] += 1
                buffer = []
                continue
            kept.append(instruction)
            continue
        if operator == "EMC":
            if drop_at is not None and mc_depth == drop_at:
                kept.extend(_balancing(buffer))
                buffer = []
                drop_at = None
                mc_depth -= 1
                continue
            mc_depth = max(0, mc_depth - 1)
            (buffer if drop_at is not None else kept).append(instruction)
            continue
        if drop_at is not None:
            buffer.append(instruction)
            continue

        if operator == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback)
            if xobj is not None and oc_hidden(xobj.get("/OC"), off_set):
                stats["blocks"] += 1
                if name:
                    dropped.add(name)
                continue
            if (
                xobj is not None
                and str(xobj.get("/Subtype", "")) == "/Form"
                and depth < MAX_FORM_DEPTH
            ):
                _strip_hidden_form(pdf, xobj, resources, off_set, stats, depth + 1, seen)
            kept.append(instruction)
            continue

        kept.append(instruction)
    if drop_at is not None:
        # An unterminated block: everything after it was hidden, so it stays
        # dropped, and its save/restore operators still have to balance.
        kept.extend(_balancing(buffer))
    return kept, dropped


def _strip_hidden_form(pdf, form, parent_resources, off_set, stats, depth, seen) -> None:
    """Rewrite a Form XObject in place. The group is going away document-wide,
    so every placement of the form loses it — a copy per placement would leave
    the original reachable and its content in the file."""
    try:
        og = form.objgen
    except Exception:
        og = None
    if og is not None and og in seen:
        return
    if og is not None:
        seen.add(og)
    form_res = form.get("/Resources")
    read_res = form_res if form_res is not None else parent_resources
    before = stats["blocks"]
    kept, dropped = _strip_hidden(
        pdf, pikepdf.parse_content_stream(form), read_res, parent_resources,
        off_set, stats, depth, seen,
    )
    if stats["blocks"] == before:
        return
    _prune_hidden_xobjects(form_res, kept, dropped)
    form.write(pikepdf.unparse_content_stream(kept))


def remove_hidden_layer_content(pdf, off_set: set) -> int:
    """Drop the content every hidden optional-content group draws, then the
    annotations it owns. Moving a group between the ON and OFF arrays only
    changes what a viewer paints; the words stay in the stream and every
    extractor still reads them."""
    stats = {"blocks": 0}
    seen: set = set()
    for page in pdf.pages:
        resources = _resolve_resources(page)
        kept, dropped = _strip_hidden(
            pdf, pikepdf.parse_content_stream(page), resources, None, off_set, stats, 0, seen
        )
        _prune_hidden_xobjects(resources, kept, dropped)
        page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        survivors = []
        for annot in annots:
            if isinstance(annot, pikepdf.Dictionary) and oc_hidden(annot.get("/OC"), off_set):
                stats["blocks"] += 1
                continue
            survivors.append(annot)
        if survivors:
            page.obj["/Annots"] = pikepdf.Array(survivors)
        elif "/Annots" in page.obj:
            del page.obj["/Annots"]
    return stats["blocks"]


class _Removal:
    """The run ids still to remove, and what happened to them.

    Ids are the depth-first show-operator encounter order — the same counter
    the analysis walk assigns, which is what makes an id from one addressable
    by the other. Both walks recurse into a Form XObject at its `Do`, so the
    agreement is a property of the traversal rather than of two lists that have
    to be kept in step.
    """

    def __init__(self, targets: set):
        self.targets = targets
        self.index = 0
        self.removed = 0
        self.whole = 0
        self.fonts = _FontCache()
        self.name_counter = 0

    def fresh_name(self, taken: set) -> str:
        while True:
            name = f"/SanFm{self.name_counter}"
            self.name_counter += 1
            if name not in taken:
                taken.add(name)
                return name


def _remove_show(operator: str, operands: list, cap, state, removal: _Removal) -> list:
    """Re-emit one show operator with nothing drawn and the pen left exactly
    where it was.

    Every cluster is marked removed, so the split emits a single displacement
    carrying the run's whole advance: surviving text later on the line keeps its
    position to the point. A run whose font cannot measure it has no advance to
    carry, so it goes whole and says so.
    """
    data = show_bytes(operator, operands)
    if not measurable(cap, data) or state.font_size <= 0:
        removal.whole += 1
        return _state_only_instructions(operator, operands)
    items = show_items(operator, operands, cap, state)
    clusters = show_clusters(items)
    if not clusters:
        removal.whole += 1
        return _state_only_instructions(operator, operands)
    return _split_instructions(
        operator, operands, items, clusters, set(range(len(clusters))), state
    )


def _rewrite_runs(
    pdf, instructions, resources, fallback, base_ctm, depth, removal, parent_state=None
) -> tuple:
    """(kept, changed, new form copies). The walk mirrors the analysis walk's
    show-op counting exactly, so a target id addresses the run the analysis
    named."""
    state = _child_state(base_ctm, parent_state)
    kept: list = []
    changed = False
    new_forms: dict = {}
    replaced: set = set()
    taken = {str(k) for k in (resources.get("/XObject") or {}).keys()} if resources else set()

    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)

        if state.feed(operator, operands):
            kept.append(instruction)
            continue

        if operator in SHOW_OPS:
            if operator in ("'", '"'):
                state.next_line()
                if operator == '"' and len(operands) >= 2:
                    try:
                        state.word_spacing = float(operands[0])
                        state.char_spacing = float(operands[1])
                    except (TypeError, ValueError):
                        pass
            cap = removal.fonts.capability(resources, fallback, state.font_name)
            data = show_bytes(operator, operands)
            if measurable(cap, data):
                _text, raw_width = _run_metrics(operator, operands, cap, state)
            else:
                raw_width = wide_width(operator, operands, cap, state)
            if removal.index in removal.targets:
                kept.extend(_remove_show(operator, operands, cap, state, removal))
                removal.removed += 1
                changed = True
            else:
                kept.append(instruction)
            removal.index += 1
            state.advance_after_show(raw_width, bool(cap is not None and cap.writes_vertical))
            continue

        if operator == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback)
            if (
                xobj is not None
                and str(xobj.get("/Subtype", "")) == "/Form"
                and depth < MAX_FORM_DEPTH
            ):
                form_matrix = as_matrix(xobj.get("/Matrix")) or IDENTITY
                form_res = xobj.get("/Resources")
                read_res = form_res if form_res is not None else resources
                inner, inner_changed, inner_forms = _rewrite_runs(
                    pdf,
                    pikepdf.parse_content_stream(xobj),
                    read_res,
                    resources,
                    mat_mult(form_matrix, state.ctm),
                    depth + 1,
                    removal,
                    parent_state=state,
                )
                if inner_changed:
                    changed = True
                    # A COPY per placement: the same form can be drawn twice,
                    # and a run hidden at one placement is not hidden at the
                    # other. Rewriting the original would remove both.
                    copy = pdf.make_stream(pikepdf.unparse_content_stream(inner))
                    for key in xobj.keys():
                        if key in ("/Length", "/Filter", "/DecodeParms", "/Resources"):
                            continue
                        copy[key] = xobj[key]
                    copy_res = _copy_resources_for_write(pdf, read_res)
                    for nested_name, nested in inner_forms.items():
                        copy_res["/XObject"][Name(nested_name)] = nested
                    copy["/Resources"] = copy_res
                    fresh = removal.fresh_name(taken)
                    new_forms[fresh] = copy
                    if name:
                        replaced.add(name)
                    kept.append(
                        pikepdf.ContentStreamInstruction(
                            [Name(fresh)], pikepdf.Operator("Do")
                        )
                    )
                    continue
            kept.append(instruction)
            continue

        kept.append(instruction)
    if replaced and isinstance(resources, pikepdf.Dictionary):
        _drop_replaced_forms(resources.get("/XObject"), _referenced_xobject_names(kept), replaced)
    return kept, changed, new_forms


def remove_runs(pdf, page, targets: set) -> int:
    """Remove the named runs from one page, leaving every surviving glyph where
    it was."""
    resources = _resolve_resources(page)
    removal = _Removal(targets)
    kept, changed, new_forms = _rewrite_runs(
        pdf, pikepdf.parse_content_stream(page), resources, None, IDENTITY, 0, removal
    )
    if not changed:
        return 0
    if new_forms:
        table = resources.get("/XObject")
        if table is None:
            table = pikepdf.Dictionary()
            resources["/XObject"] = table
        for name, stream in new_forms.items():
            table[Name(name)] = stream
    page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
    return removal.removed


def drop_optional_content_groups(pdf, off_set: set) -> int:
    """Remove the hidden groups themselves from /OCProperties, and the whole
    dictionary once no group is left. A group left behind would keep reporting
    as a hidden layer over content that is no longer there."""
    ocp = pdf.Root.get("/OCProperties")
    if not isinstance(ocp, pikepdf.Dictionary):
        return 0
    removed = 0

    def survivors(arr):
        out = []
        for el in arr or []:
            og = _objgen(el)
            if og is not None and og in off_set:
                continue
            out.append(el)
        return out

    groups = ocp.get("/OCGs")
    if isinstance(groups, pikepdf.Array):
        kept = survivors(groups)
        removed = len(groups) - len(kept)
        ocp["/OCGs"] = pikepdf.Array(kept)
    config = ocp.get("/D")
    if isinstance(config, pikepdf.Dictionary):
        for key in ("/ON", "/OFF", "/Order", "/AS", "/Locked"):
            value = config.get(key)
            if isinstance(value, pikepdf.Array):
                config[key] = pikepdf.Array(survivors(value))
    if not isinstance(groups, pikepdf.Array) or not len(ocp["/OCGs"]):
        del pdf.Root["/OCProperties"]
    for page in pdf.pages:
        resources = page.obj.get("/Resources")
        props = resources.get("/Properties") if isinstance(resources, pikepdf.Dictionary) else None
        if not isinstance(props, pikepdf.Dictionary):
            continue
        for key in [str(k) for k in props.keys()]:
            if oc_hidden(props.get(Name(key)), off_set):
                del props[Name(key)]
    return removed
