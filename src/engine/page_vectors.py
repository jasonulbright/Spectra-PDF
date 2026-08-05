"""Page-VECTOR editing (the first vector slice).

Lists, selects (via a bbox), and deletes VECTOR path objects on a page — the
drawn rules, boxes, underlines, dividers, and logos that the raster
tools can't touch (the phase-open ceiling: "Vector objects aren't
addressable"). A "vector object" is ONE maximal run of path-CONSTRUCTION
operators (`m l c v y re h`) terminated by a path-PAINTING operator that
DRAWS it (`f F f* S s B B* b b*`). It is the unit the user clicks.

Ids are the depth-first encounter order of PAINTED paths in the page content
stream — its OWN ordinal space, separate from `page_images`' — so the lister
and the delete rewriter agree by construction (both walk in encounter order,
the walker-agreement invariant).

What is NOT a vector object (v1 boundaries — refusals, never broken output):
  - A path terminated by `n` (end-path-no-op), or ANY path that sets a clip
    (`W`/`W*`): a clip region, not a drawn object. This is exactly the shape
    the crop frame emits (`re W n`), so the same rule keeps the tools' own
    frames from listing as phantom user objects. A clip-SETTING fill
    (`re W f`) is excluded too — deleting it would change the clipping of
    everything after it, which is more than "remove this object."
  - Paths inside Form XObjects — v1 lists PAGE-content paths only. Deleting
    into a shared form is copy-on-write complexity this pass
    does not need and will not half-pay for.
  - Shading (`sh`), images (`Do`), and text (shows) — not paths by
    definition.

Delete is strictly simpler than an image delete: DROP the target's
construction ops + its paint op from the page stream (leaving all surrounding
state — a neighbour's colour/CTM is never disturbed, exactly as the image
delete leaves the state around a dropped `Do`). No wrap, no XObject/resource
surgery; a `/Pattern`-filled path that becomes unreachable is swept by the
same `remove_unreferenced_resources` reachability pass the image family uses.

Named successors: vector move/resize/rotate (the image mirror — `matrix`
is listed for it, exactly as the image transform needs the image CTM),
then recolour / line-width, then form-nested paths.
"""

import math
from pathlib import Path

import pikepdf

from engine import color_spaces
from engine.bezier import cubic_bbox_points, flatten_cubic
from engine.content_walk import ClipTracker, DEFAULT_COLOR, GraphicsTextState, mat_mult, transform_point
from engine.page_images import (
    _do_instruction,
    _finalize_page_rewrite,
    _invert_matrix,
    _op,
    _register_xobject,
    _save,
)
from engine.redact import (
    IDENTITY,
    MAX_FORM_DEPTH,
    _as_matrix,
    _copy_resources_for_write,
    _lookup_xobject,
    _resolve_resources,
)

# Path-construction operators and how many (x, y) points each contributes.
# `h` (close) adds no new point; `re` contributes its four corners.
_CONSTRUCT = {"m", "l", "c", "v", "y", "re", "h"}
_CLIP = {"W", "W*"}
# Painting operators that DRAW the path (fill and/or stroke) → a real object.
_PAINT_FILL = {"f", "F", "f*"}
_PAINT_STROKE = {"S", "s"}
_PAINT_BOTH = {"B", "B*", "b", "b*"}
_PAINT_VISIBLE = _PAINT_FILL | _PAINT_STROKE | _PAINT_BOTH
# All painting operators (visible + the no-op `n`) — any of them CLOSES the
# current path (and resets the buffer).
_PAINT_ALL = _PAINT_VISIBLE | {"n"}
# Paint operators that CLOSE the current subpath before painting (§8.5.3.3).
_PAINT_CLOSING = {"s", "b", "b*"}

# The chord tolerance `list_page_geometry` flattens curves to, in
# DEVICE points. 0.25 pt is below a hairline — a snapped endpoint is exact to
# the eye — and it is what bounds the payload on a dense drawing sheet.
GEOMETRY_TOL = 0.25
# Coordinates round to this many decimals: 0.01 pt ≈ 3.5 µm, far below
# anything perceivable, and it makes the payload byte-STABLE for one file.
GEOMETRY_DECIMALS = 2


class _PathPoints:
    """Device-space bbox points for the path under construction — EXACT for
    curves. Control points are transformed to device space
    FIRST (an affine map of a Bézier is the Bézier of the mapped control
    points — mapping a user-space bbox would be wrong under rotation),
    then the curve's true extrema accumulate via the shared `engine.bezier`
    math. Tracks the current point / subpath start the construction
    grammar needs (`v` reuses the current point as its first control, `y`
    duplicates its endpoint, `h` returns to the subpath start — §8.5.2).
    Malformed operand shapes contribute nothing — a listing never aborts
    on bad geometry.

    An OPT-IN second product: the path's device-space
    SUBPATHS, curves flattened to `GEOMETRY_TOL`. It is opt-in because the
    bbox listing (`list_page_vectors`, every Edit-tool pass) has no use for
    per-vertex geometry and must not pay for flattening it — `geometry=False`
    keeps that walk byte-for-byte the behaviour it always had."""

    def __init__(self, geometry: bool = False):
        self.pts: list = []
        self.cur = None  # user-space current point
        self.start = None  # user-space subpath start
        self.dev_cur = None  # the current point, already in device space
        # Flattened device-space subpaths (opt-in).
        self.geometry = geometry
        self.subpaths: list = []  # finished [[x,y,x,y,…], …]
        self.sub_closed: list = []  # parallel: was the subpath explicitly closed?
        self._sub = None  # the open subpath, or None

    # ── Subpath bookkeeping ──────────────────────────────────────────
    def _flush(self, closed: bool) -> None:
        if self._sub is not None and len(self._sub) >= 4:
            self.subpaths.append(self._sub)
            self.sub_closed.append(closed)
        self._sub = None

    def _open_at(self, dev_pt) -> None:
        self._sub = [dev_pt[0], dev_pt[1]]

    def _extend(self, dev_pts) -> None:
        if self._sub is None:
            # A draw with no explicit `m` (after `re`/`h`, or a malformed
            # stream): resume from the current point when there is one.
            if self.cur is None:
                return
            self._open_at(self.dev_cur)
        for p in dev_pts:
            # Flattening and repeated `l` to the same spot both produce
            # duplicates; a zero-length segment is not a snap candidate.
            if abs(self._sub[-2] - p[0]) > 1e-9 or abs(self._sub[-1] - p[1]) > 1e-9:
                self._sub.extend((p[0], p[1]))

    def feed(self, operator: str, operands: list, ctm) -> None:
        try:
            vals = [float(v) for v in operands]
        except (TypeError, ValueError):
            return
        dev = lambda p: transform_point(ctm, p[0], p[1])  # noqa: E731
        if operator == "m" and len(vals) >= 2:
            self.cur = (vals[0], vals[1])
            self.start = self.cur
            d = dev(self.cur)
            self.dev_cur = d
            self.pts.append(d)
            if self.geometry:
                self._flush(False)
                self._open_at(d)
        elif operator == "l" and len(vals) >= 2:
            end = (vals[0], vals[1])
            d = dev(end)
            self.pts.append(d)
            if self.geometry:
                self._extend([d])
            self.cur = end
            self.dev_cur = d
        elif operator in ("c", "v", "y") and len(vals) >= (6 if operator == "c" else 4):
            if self.cur is None:
                return  # malformed: a curve with no current point
            if operator == "c":
                c1, c2, end = (vals[0], vals[1]), (vals[2], vals[3]), (vals[4], vals[5])
            elif operator == "v":
                c1, c2, end = self.cur, (vals[0], vals[1]), (vals[2], vals[3])
            else:  # y
                c1, c2, end = (vals[0], vals[1]), (vals[2], vals[3]), (vals[2], vals[3])
            d0, d1, d2, d3 = dev(self.cur), dev(c1), dev(c2), dev(end)
            self.pts.extend(cubic_bbox_points(d0, d1, d2, d3))
            if self.geometry:
                # Control points map to device space FIRST — an affine map of
                # a Bézier is the Bézier of the mapped control points, so the
                # tolerance is a DEVICE-space tolerance (what the user sees),
                # not a user-space one scaled by an unknown CTM.
                self._extend(flatten_cubic(d0, d1, d2, d3, GEOMETRY_TOL))
            self.cur = end
            self.dev_cur = d3
        elif operator == "re" and len(vals) >= 4:
            x, y, w, h = vals[0], vals[1], vals[2], vals[3]
            for corner in ((x, y), (x + w, y), (x, y + h), (x + w, y + h)):
                self.pts.append(dev(corner))
            if self.geometry:
                # `re` is `m l l l h` — its own CLOSED subpath, in the winding
                # order the operator defines (not the bbox-corner order above).
                self._flush(False)
                ring: list = []
                for corner in ((x, y), (x + w, y), (x + w, y + h), (x, y + h)):
                    d = dev(corner)
                    ring.extend((d[0], d[1]))
                self.subpaths.append(ring)
                self.sub_closed.append(True)
            self.cur = (x, y)
            self.start = self.cur
            self.dev_cur = dev(self.cur)
        elif operator == "h":
            if self.start is not None:
                self.cur = self.start
                self.dev_cur = dev(self.start)
            if self.geometry:
                self._flush(True)

    def finish(self, implicit_close: bool) -> tuple:
        """The path's subpaths at paint time. `implicit_close` is the paint
        operator's own closing semantics — a FILL closes every subpath by
        definition (the boundary segment is drawn), and `s`/`b`/`b*` close the
        current one; `S` alone closes nothing."""
        self._flush(implicit_close)
        closed = [c or implicit_close for c in self.sub_closed]
        return self.subpaths, closed

    def reset(self) -> None:
        self.pts = []
        self.cur = None
        self.start = None
        self.dev_cur = None
        self.subpaths = []
        self.sub_closed = []
        self._sub = None


def _color_rgb(color_state, resources=None, pdf=None):
    """Best-effort [r, g, b] (0-1) for a captured fill/stroke color, or None
    when it can't be resolved (a pattern, or a space with no evaluable tint).
    `color_state` is content_walk's (space_op, value_op).

    Device colours (`g`/`rg`/`k`, and stroke `G`/`RG`/`K`) resolve inline. A
    `cs`/`scn` in a NON-device space (ICCBased, Indexed, Separation, DeviceN,
    Cal*, Lab) is resolved against `resources`'s `/ColorSpace` by
    `color_spaces.resolve_color`. These used to return None and
    show no swatch. Anything still unresolvable stays None (honest unknown,
    never a wrong colour)."""
    if color_state is None:
        return None
    space_op, value_op = color_state
    if value_op is None:
        # No explicit value and no non-device space selected ⇒ the stream
        # default (device-gray black). A `cs`-only state (space picked, no
        # scn yet) is not device-plain → unknown.
        return [0.0, 0.0, 0.0] if space_op is None else None
    op, vals = value_op
    # Stroke ops (G/RG/K) share the fill ops' operand shapes — normalize so a
    # stroked path's colour is captured too (the blue-line case).
    opl = op.lower()
    if opl in ("g", "rg", "k"):
        try:
            nums = [float(v) for v in vals]
        except (TypeError, ValueError):
            return None
        if opl == "g" and len(nums) == 1:
            v = max(0.0, min(1.0, nums[0]))
            return [v, v, v]
        if opl == "rg" and len(nums) == 3:
            return [max(0.0, min(1.0, c)) for c in nums]
        if opl == "k" and len(nums) == 4:
            c, m, y, k = (max(0.0, min(1.0, n)) for n in nums)
            return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
        return None
    # sc/scn in a named space — resolve via /Resources /ColorSpace.
    return color_spaces.resolve_color(space_op, value_op, resources, pdf)


def _emit_placement(out: list, xobj, ctm, clips, depth: int, do_chain) -> None:
    """Append the device-space QUAD an XObject (or inline image)
    paints into, as a `"placement"` entry.

    An IMAGE fills the unit square by definition (§8.9.5.2), so its quad is
    the unit square's four corners under the CTM. A FORM instead uses its own
    `/BBox` through its `/Matrix` (§8.10.2), which keeps snap targets aligned
    with the rendered content.
    """
    corners = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
    m = ctm
    if xobj is not None:
        try:
            subtype = str(xobj.get("/Subtype", ""))
        except Exception:
            return
        if subtype == "/Form":
            bbox = xobj.get("/BBox")
            if bbox is None:
                return
            try:
                b = [float(v) for v in bbox]
            except (TypeError, ValueError):
                return
            x0, y0 = min(b[0], b[2]), min(b[1], b[3])
            x1, y1 = max(b[0], b[2]), max(b[1], b[3])
            corners = ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
            m = mat_mult(_as_matrix(xobj.get("/Matrix")) or IDENTITY, ctm)
        elif subtype != "/Image":
            return  # a PostScript XObject paints nothing
    quad: list = []
    for cx, cy in corners:
        px, py = transform_point(m, cx, cy)
        quad.extend((px, py))
    xs = quad[0::2]
    ys = quad[1::2]
    vrect = (min(xs), min(ys), max(xs), max(ys))
    out.append(
        {
            "index": len(out),
            "rect": [vrect[0], vrect[1], vrect[2], vrect[3]],
            "matrix": list(m),
            "kind": "placement",
            "subpaths": [quad],
            "closed": [True],
            "nested": depth > 0,
            "_do_chain": list(do_chain),
            "_edit_depth": depth,
            "clipped": clips.clips_away(vrect),
        }
    )


def _walk_vectors(
    instructions: list,
    pdf=None,
    resources=None,
    base_ctm=IDENTITY,
    depth: int = 0,
    do_chain=(),
    base_line_width: float = 1.0,
    base_fill=DEFAULT_COLOR,
    base_stroke=DEFAULT_COLOR,
    out=None,
    base_clip=None,
    geometry: bool = False,
) -> list:
    """One dict per PAINTED, non-clip path in depth-first encounter order.
    Recurses into Form XObjects when `pdf`/`resources` are supplied, so
    nested paths list too (a page-content-only walk passes neither and stays
    flat). Each dict carries the public listing fields plus internals the
    editors use: `drop_idxs` (the EXACT construction-op indices + the paint
    index — a precise SET so a state op interleaved into the path survives a
    delete) and, for a nested path, `_form_name` (the DIRECT
    page-level form to copy-on-write) + `_root_do_idx` (the page `Do` to swap)
    + `_edit_depth` (only depth-1 nesting edits in v1; deeper lists but refuses
    the edit — copying a chain of forms is out of scope).

    `geometry=True` (`list_page_geometry` only) additionally
    attaches each painted path's flattened device-space `subpaths`/`closed`
    and emits a `"placement"` entry per `Do`/inline image — the unit square
    (image) or the form's /BBox, mapped through the live CTM. It is OPT-IN so
    the shipped bbox listing's output and cost are untouched: with it off,
    `out`'s entries and their INDICES are exactly what they always were, which
    is what the editors' object ids depend on."""
    if out is None:
        out = []
    state = GraphicsTextState(base_ctm, fill_color=base_fill, stroke_color=base_stroke)
    # Ambient clip tracking beside the state machine. page_vectors
    # already EXCLUDES a path that itself sets a clip (`has_clip`); this catches
    # the other half — a PAINTED path drawn wholly outside an EARLIER clip lists
    # as `clipped` (invisible). `base_clip` is the parent form's device-space
    # clip (§8.10.2).
    clips = ClipTracker(base_clip)
    path_start = None  # instruction index of the current path's first construct op
    start_ctm = None  # CTM at the first construction op (the wrap-start space)
    construct_idxs: list = []  # EXACT indices of this path's construction ops
    path_pts = _PathPoints(geometry)  # device-space bbox points (curve-exact)
    has_clip = False
    line_width = base_line_width  # `w` (PDF default 1.0) — a form inherits the caller's
    w_stack: list = []  # line width IS graphics state — q/Q-scoped like the rest
    q_meta: list = []  # Open-frame metadata for `sh` recognition
    for idx, instruction in enumerate(instructions):
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        # Ambient clip fed with the CURRENT ctm BEFORE state.feed (which
        # consumes q/Q/cm). Its own path buffer is independent of `pts` below.
        clips.feed(operator, operands, state.ctm)
        # Line width is graphics state; GraphicsTextState doesn't track it, so
        # save/restore it in lockstep with q/Q here (a `w` set
        # inside a q…Q otherwise leaked forward and mis-inflated later strokes).
        if operator == "q":
            w_stack.append(line_width)
            # Per-frame metadata for `sh` recognition. A frame is
            # CLEAN while it contains only pure state (constructs, clips, gs,
            # cm/colour/text-state, w) — the gradient-fill idiom's exact
            # ingredient list. Opening a NESTED frame makes the parent
            # unclean (the idiom has none).
            if q_meta:
                q_meta[-1]["clean"] = False
            q_meta.append(
                {"idx": idx, "ctm": tuple(state.ctm), "clean": True, "saw_sh": False}
            )
        elif operator == "Q":
            if w_stack:
                line_width = w_stack.pop()
            if q_meta:
                q_meta.pop()
        if state.feed(operator, operands):
            continue  # q/Q/cm/colour/Tf/BT/Tm/… — state, not a path op
        if operator == "w":
            try:
                line_width = float(operands[0])
            except (TypeError, ValueError, IndexError):
                pass
            continue  # a line-state op, NOT a path op — never resets the path
        if operator in _CONSTRUCT:
            if path_start is None:
                path_start = idx
                # The CTM live at the FIRST construction op — the
                # transform wrap opens HERE, so its conjugated matrix must be
                # built against THIS space, not the paint-time CTM (they
                # differ exactly when a `cm` interleaves into the path; a cm
                # pre-multiplies, so the insert's effect propagates X·M·C0
                # for every interior composition X, and M = C0·T·C0⁻¹ is
                # what makes every piece land on target).
                start_ctm = tuple(state.ctm)
            construct_idxs.append(idx)
            path_pts.feed(operator, operands, state.ctm)
            continue
        if operator in _CLIP:
            has_clip = True  # this path sets a clip → excluded when painted
            continue
        if operator in _PAINT_ALL:
            visible = operator in _PAINT_VISIBLE
            if visible and not has_clip and path_start is not None and path_pts.pts:
                xs = [p[0] for p in path_pts.pts]
                ys = [p[1] for p in path_pts.pts]
                if operator in _PAINT_FILL:
                    kind = "fill"
                elif operator in _PAINT_STROKE:
                    kind = "stroke"
                else:
                    kind = "fillstroke"
                # D-tail: a stroke paints ±half the line width AROUND the path,
                # so a thin line (zero-extent construction box) still gets a
                # real, grab-able bbox. Half-width scales into device space by
                # the CTM's geometric mean scale (√|det|).
                hw = 0.0
                if operator not in _PAINT_FILL:
                    c = state.ctm
                    scale = math.sqrt(abs(c[0] * c[3] - c[1] * c[2]))
                    hw = max(0.0, line_width) / 2.0 * scale
                vrect = (min(xs) - hw, min(ys) - hw, max(xs) + hw, max(ys) + hw)
                geom = {}
                if geometry:
                    subs, sub_closed = path_pts.finish(
                        operator in _PAINT_FILL
                        or operator in _PAINT_BOTH
                        or operator in _PAINT_CLOSING
                    )
                    geom = {"subpaths": subs, "closed": sub_closed}
                out.append(
                    {
                        "index": len(out),
                        **geom,
                        "rect": [vrect[0], vrect[1], vrect[2], vrect[3]],
                        "matrix": list(state.ctm),
                        "_start_ctm": list(start_ctm if start_ctm is not None else state.ctm),
                        "kind": kind,
                        "fill": _color_rgb(state.fill_color, resources, pdf)
                        if operator not in _PAINT_STROKE
                        else None,
                        "stroke": _color_rgb(state.stroke_color, resources, pdf)
                        if operator not in _PAINT_FILL
                        else None,
                        # The effective line width (the width control's seed);
                        # meaningful for a stroke/fillstroke, informational for a fill.
                        "line_width": round(line_width, 4),
                        "nested": depth > 0,
                        "drop_idxs": construct_idxs + [idx],
                        # The FULL Do chain (page-outward) —
                        # [(form name, Do index in its PARENT's stream), …];
                        # the chain copy-on-write edits any depth.
                        "_do_chain": list(do_chain),
                        "_edit_depth": depth,
                        # True when wholly outside the ambient clip.
                        "clipped": clips.clips_away(vrect),
                    }
                )
            path_start, start_ctm, construct_idxs, has_clip = None, None, [], False
            path_pts.reset()
            continue
        # Recurse into a Form XObject so its paths list too (page walk
        # only — `pdf` is None for the flat page-content walks the editors run
        # on their own instruction list). The page-level `Do` index + the form
        # name ride down so a nested edit knows which form to copy and which
        # `Do` to swap.
        if operator == "Do" and pdf is not None and operands and depth < MAX_FORM_DEPTH:
            fname = str(operands[0])
            xobj = _lookup_xobject(fname, resources, resources)
            if geometry:
                # An image's (or form's) placement QUAD is a snap target
                # in both references — corners, edge midpoints, centre. The
                # walk already holds the CTM at the `Do`, so it costs nothing.
                _emit_placement(out, xobj, state.ctm, clips, depth, do_chain)
            # A MARKED vector-graphic form (a placed SVG) is one
            # unit owned by the IMAGE-placement machinery — listing its
            # interior paths here would offer per-path edits that fork a
            # copy away from the marker and fight the placement selection.
            if (
                xobj is not None
                and str(xobj.get("/Subtype", "")) == "/Form"
                and xobj.get("/SpectraVector") is None
            ):
                fmatrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
                fres = xobj.get("/Resources")
                # A form inherits the caller's graphics state (§8.10.2): thread
                # the live CTM, line width, and fill/stroke into the recursion
                # so a form whose own content sets none lists with the right
                # colour/width/bbox. Enclosing resources are the
                # fallback for a form whose /Resources omits a nested name.
                _walk_vectors(
                    list(pikepdf.parse_content_stream(xobj)),
                    pdf=pdf,
                    resources=fres if fres is not None else resources,
                    base_ctm=mat_mult(fmatrix, state.ctm),
                    depth=depth + 1,
                    do_chain=tuple(do_chain) + ((fname, idx),),
                    base_line_width=line_width,
                    base_fill=state.fill_color,
                    base_stroke=state.stroke_color,
                    out=out,
                    base_clip=clips.clip,
                    geometry=geometry,
                )
        if operator == "sh":
            # A shading paint is an object whose extent is the ambient clip at
            # the operation. The frame's own clip already fed the tracker, so
            # `clips.clip`
            # IS the visible box (None = unclipped: the lister substitutes
            # the page box). Frame recognition gates transform + whole-frame
            # delete: the enclosing q-frame is CLEAN (pure state + this one
            # sh) and closes immediately after — then dropping [q..Q] removes
            # the paint AND its orphan clip with zero state leakage (a
            # complete balanced frame scopes everything it contains).
            frame = q_meta[-1] if q_meta else None
            recognized = (
                frame is not None
                and frame["clean"]
                and not frame["saw_sh"]
                and idx + 1 < len(instructions)
                and str(instructions[idx + 1].operator) == "Q"
            )
            if frame is not None:
                frame["saw_sh"] = True
            rect = list(clips.clip) if clips.clip is not None else None
            out.append(
                {
                    "index": len(out),
                    "rect": rect,
                    "matrix": list(state.ctm),
                    "_start_ctm": list(frame["ctm"] if recognized else state.ctm),
                    "kind": "shading",
                    "fill": None,
                    "stroke": None,
                    "line_width": 0,
                    "nested": depth > 0,
                    "drop_idxs": (
                        list(range(frame["idx"], idx + 2)) if recognized else [idx]
                    ),
                    "_do_chain": list(do_chain),
                    "_edit_depth": depth,
                    "_sh_frame": {"open": frame["idx"]} if recognized else None,
                    "_sh_name": str(operands[0]) if operands else None,
                    "clipped": clips.clips_away(tuple(rect)) if rect else False,
                }
            )
            path_start, start_ctm, construct_idxs, has_clip = None, None, [], False
            path_pts.reset()
            continue
        if operator == "gs":
            # Pure graphics state — clean-preserving for `sh` frames, but
            # still a path-buffer reset like every non-path op.
            path_start, start_ctm, construct_idxs, has_clip = None, None, [], False
            path_pts.reset()
            continue
        if geometry and operator == "INLINE IMAGE":
            # An inline image (`BI … ID … EI`) paints the unit square under the
            # live CTM exactly like an image `Do` — same quad, same snap
            # targets. Excluding it would make a scanned detail snappable or
            # not depending on how the producer embedded it.
            _emit_placement(out, None, state.ctm, clips, depth, do_chain)
        # Any other operator (a show, Do, inline image, d line-state): not
        # part of a path — and not part of a clean `sh` frame either. A path
        # left unpainted before other content is abandoned (malformed input)
        # — reset so a stale path can't attach.
        if q_meta:
            q_meta[-1]["clean"] = False
        path_start, start_ctm, construct_idxs, has_clip = None, None, [], False
        path_pts.reset()
    return out


def list_page_vectors(file: str, page: int) -> dict:
    """Vector path objects on 1-based `page`, in the id order the editors
    target. Page-content AND form-nested paths; each carries a
    device-space `rect` (bbox for selection), the CTM `matrix` (for a
    transform), `kind` (fill/stroke/fillstroke), best-effort `fill`/`stroke`
    colours, `line_width`, and `nested` (inside a Form XObject)."""
    _INTERNAL = ("drop_idxs", "_do_chain", "_edit_depth", "_start_ctm", "_sh_frame", "_sh_name")
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        vectors = _walk_vectors(
            list(pikepdf.parse_content_stream(p)), pdf=pdf, resources=_resolve_resources(p)
        )
        # An UNCLIPPED shading floods the visible page — its
        # honest extent is the page's crop (or media) box.
        page_box = None
        try:
            crop = p.obj.get("/CropBox", p.obj.get("/MediaBox"))
            bx = [float(v) for v in crop]
            page_box = [min(bx[0], bx[2]), min(bx[1], bx[3]), max(bx[0], bx[2]), max(bx[1], bx[3])]
        except (TypeError, ValueError):
            page_box = [0.0, 0.0, 612.0, 792.0]
        for v in vectors:
            if v["rect"] is None:
                v["rect"] = list(page_box)
            for k in _INTERNAL:
                v.pop(k, None)  # internal to the walk; the public listing omits them
        return {"page": int(page), "vectors": vectors}


def list_page_geometry(file: str, page: int) -> dict:
    """The SNAP GEOMETRY of 1-based `page` — device-space
    subpaths per painted path, plus a quad per placed image/form.

    Why a second listing rather than a field on `list_page_vectors`: that one
    returns a per-path BBOX, and a polyline's interior vertices, a diagonal's
    true endpoints, a ring's centre and every intersection are not derivable
    from a bbox. This one reuses the SAME walk — CTM composition, the
    form-XObject chain, the `v`/`y` grammar, `ClipTracker` — so there is one
    answer to "what geometry is on this page", never two that disagree.

    Payload shape, per entry:
      `index`  its own ordinal in THIS listing (placements interleave, so it
               is deliberately NOT the `list_page_vectors` object id — the two
               listings are separate ordinal spaces and nothing cross-refers);
      `kind`   fill | stroke | fillstroke | placement;
      `subpaths` flat [x,y,x,y,…] device-space polylines, curves flattened to
               `GEOMETRY_TOL`, rounded to `GEOMETRY_DECIMALS`;
      `closed` parallel flags — a closed subpath has the last→first segment
               and contributes a CENTRE candidate.

    Same device frame as `list_page_vectors`' `rect`, so `pdfRectToDisplay`'s
    projection applies unchanged. Clipped-away geometry is excluded (the clip
    rule the walk already applies). Per page, on demand — never whole-document;
    that is what bounds the payload on a 60-sheet drawing set.
    """
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        walked = _walk_vectors(
            list(pikepdf.parse_content_stream(p)),
            pdf=pdf,
            resources=_resolve_resources(p),
            geometry=True,
        )
        r = GEOMETRY_DECIMALS
        paths: list = []
        for item in walked:
            if item.get("clipped"):
                continue
            subs = item.get("subpaths") or []
            closed = item.get("closed") or []
            rounded: list = []
            keep_closed: list = []
            for sub, is_closed in zip(subs, closed):
                if len(sub) < 4:
                    continue  # a lone moveto draws nothing
                rounded.append([round(float(v), r) for v in sub])
                keep_closed.append(bool(is_closed))
            if not rounded:
                continue
            paths.append(
                {
                    "index": len(paths),
                    "kind": item["kind"],
                    "closed": keep_closed,
                    "subpaths": rounded,
                }
            )
        return {"page": int(page), "paths": paths}


def _sh_names_used(content_source, resources) -> set:
    """Every name any reachable `sh` still draws — the page/form stream plus
    every form reachable from `resources` (cycle-guarded, depth-bounded;
    OVER-collecting is safe, an unused name kept = dead weight, not a leak).
    The `_sweep_orphan_edit_gs` recipe, for /Shading — qpdf's GC leaves
    that table alone too (probe-verified), and a swept gradient's /Function
    can be a large sampled stream, the removed-bytes-still-embedded class."""
    used: set = set()
    seen: set = set()

    def collect_stream(obj):
        try:
            for ins in pikepdf.parse_content_stream(obj):
                if str(ins.operator) == "sh" and ins.operands:
                    used.add(str(ins.operands[0]))
        except Exception:
            pass

    def collect_forms(res, depth):
        if res is None or depth > MAX_FORM_DEPTH:
            return
        try:
            xo = res.get("/XObject")
        except Exception:
            return
        if xo is None:
            return
        for k in xo.keys():
            try:
                obj = xo[k]
                if str(obj.get("/Subtype", "")) != "/Form":
                    continue
                og = obj.objgen
                if og != (0, 0):
                    if og in seen:
                        continue
                    seen.add(og)
                collect_stream(obj)
                collect_forms(obj.get("/Resources"), depth + 1)
            except Exception:
                continue

    collect_stream(content_source)
    collect_forms(resources, 0)
    return used


def _swept_shading_table(pdf, resources, sh_name: str, used: set):
    """A FRESH /Shading subdict without `sh_name` when nothing still draws
    it (the caller guarantees `resources` is page-local/copy-local — the
    shared table is never mutated, the sibling rule)."""
    if sh_name in used:
        return
    try:
        table = resources.get("/Shading")
    except Exception:
        return
    if table is None or sh_name not in {str(k) for k in table.keys()}:
        return
    from pikepdf import Dictionary as _Dict, Name as _Name

    fresh = _Dict()
    for k in table.keys():
        if str(k) != sh_name:
            fresh[k] = table[k]
    resources["/Shading"] = fresh


def _fresh_vec_name(resources) -> str:
    """An XObject name (with the leading `/`) not already in `resources`."""
    xo = resources.get("/XObject")
    existing = set()
    if xo is not None:
        try:
            existing = {str(k) for k in xo.keys()}
        except AttributeError:
            existing = set()
    n = 0
    while f"/EditVec{n}" in existing:
        n += 1
    return f"/EditVec{n}"


def _edit_nested_vector(pdf, p, obj, rewrite, sweep_shading=None) -> None:
    """Generalized to ANY depth ≤ MAX_FORM_DEPTH: edit a
    vector object inside a CHAIN of Form XObjects on COPIES of every form
    along the chain — the innermost form's stream takes `rewrite`, then each
    ancestor is copied with its child's `Do` renamed to the child's copy,
    and finally the page-level `Do` swaps. A form stamped elsewhere (at any
    level) is untouched — each copy registers fresh-named on its PARENT's
    copied resources (the sibling rule at every level), and each
    superseded original is dropped when nothing in the rewritten parent
    still draws it (qpdf's GC leaves forms at page level, and the SVG
    placement precedent applies on copies). `rewrite` runs on the INNERMOST
    form's instruction list and may raise (validation) before any mutation.
    A chain of length 1 is exactly the shipped depth-1 behavior."""
    from engine.page_images import _drop_replaced_forms, _names_drawn

    resources = _copy_resources_for_write(pdf, _resolve_resources(p))
    p.obj["/Resources"] = resources
    chain = obj["_do_chain"]
    if not chain:
        raise ValueError("nested vector object carries no form chain")
    # Resolve the form objects along the chain, tracking each level's
    # resource SCOPE exactly as the walk resolved names (own /Resources,
    # else the enclosing scope as fallback).
    forms: list = []
    scopes: list = []
    res_scope = resources
    for name, _do_idx in chain:
        scopes.append(res_scope)
        form = _lookup_xobject(name, res_scope, res_scope)
        if form is None or str(form.get("/Subtype", "")) != "/Form":
            raise ValueError("the form chain for this nested vector object was not found")
        forms.append(form)
        fres = form.get("/Resources")
        res_scope = fres if fres is not None else res_scope

    # Innermost rewrite FIRST — a validation raise lands before any mutation.
    new_inner_instrs = rewrite(list(pikepdf.parse_content_stream(forms[-1])))

    def make_copy(orig, instrs):
        # Copy every key off the original EXCEPT the stream-encoding ones (a
        # BLOCKLIST like redact.py/page_images — an allowlist silently dropped
        # keys the edited form needs, e.g. /OC layer membership).
        stream = pdf.make_stream(pikepdf.unparse_content_stream(instrs))
        for key in orig.keys():
            if str(key) in ("/Length", "/Filter", "/DecodeParms"):
                continue
            stream[key] = orig[key]
        return stream

    child_copy = make_copy(forms[-1], new_inner_instrs)
    if sweep_shading:
        # A nested shading delete sweeps the entry off the INNER
        # copy's own (COW'd) table — the original form's shared resources
        # are never mutated (the rule at this level too).
        inner_own = forms[-1].get("/Resources")
        inner_res = _copy_resources_for_write(
            pdf, inner_own if inner_own is not None else scopes[-1]
        )
        _swept_shading_table(
            pdf, inner_res, sweep_shading, _sh_names_used(child_copy, inner_res)
        )
        child_copy["/Resources"] = inner_res
    # Outward: each parent copy renames the child's Do and adopts the copy.
    for level in range(len(chain) - 1, 0, -1):
        parent = forms[level - 1]
        parent_own = parent.get("/Resources")
        parent_res = _copy_resources_for_write(
            pdf, parent_own if parent_own is not None else scopes[level - 1]
        )
        new_name = _fresh_vec_name(parent_res)
        parent_instrs = list(pikepdf.parse_content_stream(parent))
        parent_instrs[chain[level][1]] = _do_instruction(new_name)
        parent_copy = make_copy(parent, parent_instrs)
        _register_xobject(pdf, parent_res, new_name, child_copy)
        # The copy's /XObject still references the superseded ORIGINAL child
        # — drop it when the rewritten stream no longer draws it.
        _drop_replaced_forms(
            parent_res.get("/XObject"), _names_drawn(parent_instrs), {chain[level][0]}
        )
        parent_copy["/Resources"] = parent_res
        child_copy = parent_copy

    new_name = _fresh_vec_name(resources)
    _register_xobject(pdf, resources, new_name, child_copy)
    page_instrs = list(pikepdf.parse_content_stream(p))
    page_instrs[chain[0][1]] = _do_instruction(new_name)
    p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(page_instrs))
    # Reclaim the page-level form we just superseded — otherwise the OLD form
    # (incl. a "deleted" path's geometry) stays embedded + reachable forever,
    # and repeated edits grow the file unbounded. Only drops
    # when nothing in the rewritten page still draws it (a form Do'd twice on
    # the page keeps its other occurrence — the reachability check handles it).
    _finalize_page_rewrite(p, page_instrs, {chain[0][0]})


def _resolve_target(pdf, p, index):
    """The walked object at `index` (recursive listing). Raises on
    out-of-range. An unclipped shading's rect falls back to the page box —
    the SAME substitution the public lister makes, so the transform math
    sees the rect the renderer targeted."""
    instructions = list(pikepdf.parse_content_stream(p))
    vectors = _walk_vectors(instructions, pdf=pdf, resources=_resolve_resources(p))
    if not (0 <= int(index) < len(vectors)):
        raise ValueError(f"vector index {index} is out of range (page has {len(vectors)})")
    obj = vectors[int(index)]
    if obj.get("rect") is None:
        try:
            crop = p.obj.get("/CropBox", p.obj.get("/MediaBox"))
            bx = [float(v) for v in crop]
            obj["rect"] = [
                min(bx[0], bx[2]), min(bx[1], bx[3]), max(bx[0], bx[2]), max(bx[1], bx[3])
            ]
        except (TypeError, ValueError):
            obj["rect"] = [0.0, 0.0, 612.0, 792.0]
    return instructions, obj


def _interleaved_indices(instrs, drop: list) -> list:
    """The NON-path ops a producer placed inside the object's
    [first..last] span. A wrap used to refuse these outright (the
    wrap's `Q` would scope them away from following content); the lift keeps
    them in place INSIDE the wrap and REPLAYS them after the closing `Q` —
    exact, because `Q` restores the pre-frame state, so the replay composes
    from precisely the state the unwrapped ops composed from (true even for
    `cm`, which re-applies onto the restored CTM). The one still-refused
    shape is interior UNBALANCED q/Q: the object's own CTM then varies
    mid-path with no single frame to wrap, and no one conjugated matrix
    transforms it."""
    dropped = set(drop)
    first, last = drop[0], drop[-1]
    interleaved = [i for i in range(first, last + 1) if i not in dropped]
    balance = 0
    for i in interleaved:
        op = str(instrs[i].operator)
        if op == "q":
            balance += 1
        elif op == "Q":
            balance -= 1
            if balance < 0:
                raise ValueError(
                    "vector object spans unbalanced q/Q graphics-state frames "
                    "and cannot be edited as one unit"
                )
    if balance != 0:
        raise ValueError(
            "vector object spans unbalanced q/Q graphics-state frames "
            "and cannot be edited as one unit"
        )
    return interleaved


def delete_page_vector(file: str, output: str, page: int, index: int) -> dict:
    """Remove one vector path object — drop its construction ops + paint op
    (per-object; surrounding state untouched). A NESTED path is dropped on a
    copy of its form."""
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        instructions, obj = _resolve_target(pdf, p, index)
        # Drop ONLY this object's construction ops + its paint (the exact index
        # set). Every surrounding op stays — including a state op (q/Q/cm/colour)
        # a producer placed BETWEEN construction and paint: it flows to
        # following content EXACTLY as before, so removing it would change that
        # content or unbalance q/Q. No resource sweep for
        # a /Pattern (small dead weight); a deleted SHADING's entry IS swept
        # (its /Function can be a large sampled stream, and qpdf's
        # GC leaves /Shading alone, probe-verified).
        drop = set(obj["drop_idxs"])

        def rewrite(instrs):
            return [ins for i, ins in enumerate(instrs) if i not in drop]

        sweep_name = obj.get("_sh_name") if obj["kind"] == "shading" else None
        if obj["nested"]:
            _edit_nested_vector(pdf, p, obj, rewrite, sweep_shading=sweep_name)
        else:
            kept = rewrite(instructions)
            p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
            if sweep_name:
                # COW the page resources before touching the table (the
                # shared dict is every sibling's — the rule).
                resources = _copy_resources_for_write(pdf, _resolve_resources(p))
                p.obj["/Resources"] = resources
                _swept_shading_table(
                    pdf, resources, sweep_name, _sh_names_used(p, resources)
                )
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def transform_page_vector(file: str, output: str, page: int, index: int, matrix: list) -> dict:
    """Move / resize / rotate ONE vector object by wrapping its
    path run in `q <cm> … Q`.

    `matrix` is the DESIRED absolute placement M' of the object's bbox as a
    unit-square matrix [a,b,c,d,e,f] in DEVICE space — what the canvas gesture
    produced from `list_page_vectors`' `rect` (bbox → [w,0,0,h,x0,y0]). The op
    recomputes the object's CURRENT bbox → M_cur, the device-space delta
    D = M'·M_cur⁻¹, and the insert `cm = C·D·C⁻¹` (C = the object's own CTM) so
    D acts in DEVICE space even under a nested CTM, then wraps the object's
    contiguous op run. REFUSES an object whose path has graphics-state
    operators interleaved into it (non-contiguous — a wrap's `Q` would scope
    them, the hazard) or a degenerate (zero-area) bbox."""
    m_target = _as_matrix(matrix)
    if m_target is None:
        raise ValueError("matrix must be [a, b, c, d, e, f]")
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        instructions, obj = _resolve_target(pdf, p, index)
        if obj["kind"] == "shading" and not obj.get("_sh_frame"):
            # A bare `sh` outside the gradient-fill idiom: a cm on the sh
            # alone would slide the gradient beneath its stationary clip
            # window — refused by name; delete still works.
            raise ValueError(
                "this shading is not in a recognized gradient-fill frame and cannot be transformed"
            )
        drop = obj["drop_idxs"]
        first, last = drop[0], drop[-1]
        bx0, by0, bx1, by1 = obj["rect"]
        bw, bh = bx1 - bx0, by1 - by0
        if abs(bw) < 1e-6 or abs(bh) < 1e-6:
            raise ValueError("vector object bbox is degenerate and cannot be transformed")
        c = tuple(obj.get("_start_ctm") or obj["matrix"])
        if abs(c[0] * c[3] - c[1] * c[2]) < 1e-9:
            # A rank-deficient object CTM (a shear collapsing the path onto a
            # line) survives the bbox guard but can't be inverted for the
            # conjugation — a vector-specific message (not the image one).
            raise ValueError("vector object's transform matrix is degenerate and cannot be transformed")
        m_cur = (bw, 0.0, 0.0, bh, bx0, by0)
        # T maps a DEVICE point in the current bbox to the target bbox
        # (unlike the image delta M'·M_cur⁻¹, which acts in unit-square space —
        # a vector's path coords are device coords, not a unit square). Then
        # `cm = C·T·C⁻¹` so T acts in device space even under a nested CTM C —
        # so a NESTED path (wrapped inside its form's stream) transforms in
        # device space too, exactly like a top-level one.
        t_dev = mat_mult(_invert_matrix(m_cur), tuple(m_target))
        m_insert = mat_mult(mat_mult(c, t_dev), _invert_matrix(c))
        cm = _op([round(float(v), 6) for v in m_insert], "cm")

        def rewrite(instrs):
            # Interleaved state ops no longer refuse — validated
            # (balanced q/Q) and replayed after the wrap's Q. Computed HERE
            # because `instrs` is the FORM's list for a nested object and the
            # page's for a top-level one — drop_idxs are stream-local, and
            # `_edit_nested_vector` runs this before any mutation, so the
            # validation raise still lands pre-write.
            interleaved = _interleaved_indices(instrs, drop)
            kept: list = []
            for i, ins in enumerate(instrs):
                if i == first:
                    kept.append(_op([], "q"))
                    kept.append(cm)
                kept.append(ins)
                if i == last:
                    kept.append(_op([], "Q"))
                    # The interleave replay: re-apply the ops the wrap's Q
                    # just scoped away, in original order, so the content
                    # AFTER this object sees the exact state it always saw.
                    # Contiguous runs replay nothing.
                    for j in interleaved:
                        kept.append(instrs[j])
            return kept

        if obj["nested"]:
            _edit_nested_vector(pdf, p, obj, rewrite)
        else:
            p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(rewrite(instructions)))
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def _rgb3(v, name):
    try:
        c = [max(0.0, min(1.0, float(x))) for x in v]
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be [r, g, b]") from None
    if len(c) != 3:
        raise ValueError(f"{name} must be [r, g, b]")
    return [round(x, 6) for x in c]


def restyle_page_vector(
    file: str,
    output: str,
    page: int,
    index: int,
    fill=None,
    stroke=None,
    line_width=None,
) -> dict:
    """Recolour / re-width ONE vector object by wrapping its path
    run in `q <state ops> … Q`.

    The new fill (`rg`), stroke (`RG`), and/or line width (`w`) are injected
    INSIDE the wrap, BEFORE the object's existing run, so they apply to THIS
    object and the `Q` scopes them (a neighbour that inherits the surrounding
    colour is untouched — the object's own paint just uses the new state).
    `fill`/`stroke` are [r,g,b] 0-1 (clamped); `line_width` is a number ≥ 0.
    REFUSES an object with interleaved graphics-state operators (non-contiguous
    run — a wrap's `Q` would scope them, the hazard) or a request that
    sets nothing."""
    ops: list = []
    if fill is not None:
        ops.append(_op(_rgb3(fill, "fill"), "rg"))
    if stroke is not None:
        ops.append(_op(_rgb3(stroke, "stroke"), "RG"))
    if line_width is not None:
        try:
            lw = float(line_width)
        except (TypeError, ValueError):
            raise ValueError("line_width must be a number") from None
        if lw < 0:
            raise ValueError("line_width must be >= 0")
        ops.append(_op([round(lw, 6)], "w"))
    if not ops:
        raise ValueError("restyle requires at least one of fill, stroke, line_width")
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        instructions, obj = _resolve_target(pdf, p, index)
        if obj["kind"] == "shading":
            raise ValueError("a shading has no stroke or fill to restyle")
        drop = obj["drop_idxs"]
        first, last = drop[0], drop[-1]
        contiguous = drop == list(range(first, last + 1))

        def rewrite(instrs):
            # An INTERLEAVED run restyles too — wrap + replay
            # (validated balanced), with the new setters injected right
            # BEFORE the paint op, where they beat any interleaved colour a
            # producer set mid-run (setters at the wrap head would silently
            # lose to them). The merge recognition stays
            # CONTIGUOUS-only — its `q setters run Q` shape can't exist
            # around an interleaved run, and repeated interleaved restyles
            # nest bounded by each wrap's own Q (the outer Q discards the
            # inner replay's state, so downstream stays exact).
            interleaved = _interleaved_indices(instrs, drop)
            if not contiguous:
                kept: list = []
                for i, ins in enumerate(instrs):
                    if i == first:
                        kept.append(_op([], "q"))
                    if i == last:
                        kept.extend(ops)  # the new setters, at paint time
                    kept.append(ins)
                    if i == last:
                        kept.append(_op([], "Q"))
                        for j in interleaved:
                            kept.append(instrs[j])
                return kept
            # Round-38 MED: if a PRIOR restyle already wrapped this object in
            # `q <state setters> run Q`, MERGE into that wrap (replace the
            # setters this request overrides, keep the rest) rather than nesting
            # another layer — repeated restyles otherwise grew the stream / q-Q
            # depth without bound. The setters we recognise are the pure
            # colour/width ops.
            new_ops = list(ops)
            _SETTERS = {"rg", "RG", "g", "G", "k", "K", "w"}
            wrap_start = first
            old_setters: list = []
            j = first - 1
            while j >= 0 and str(instrs[j].operator) in _SETTERS:
                old_setters.insert(0, instrs[j])
                j -= 1
            enclosed = (
                old_setters
                and j >= 0
                and str(instrs[j].operator) == "q"
                and last + 1 < len(instrs)
                and str(instrs[last + 1].operator) == "Q"
            )
            if enclosed:
                wrap_start = j  # the existing `q`
                has_fill = fill is not None
                has_stroke = stroke is not None
                has_w = line_width is not None
                merged: list = []
                for op in old_setters:
                    name = str(op.operator)
                    if name in ("rg", "g", "k") and has_fill:
                        continue
                    if name in ("RG", "G", "K") and has_stroke:
                        continue
                    if name == "w" and has_w:
                        continue
                    merged.append(op)  # a setter this request doesn't override — keep it
                merged.extend(ops)  # the new setters
                new_ops = merged
            kept: list = []
            for i, ins in enumerate(instrs):
                if enclosed:
                    if i == wrap_start:
                        kept.append(_op([], "q"))  # re-open the (merged) wrap
                        kept.extend(new_ops)
                        continue  # drop the ORIGINAL `q`
                    if wrap_start < i < first:
                        continue  # drop the old setters (merged into `new_ops`)
                    if i == last + 1:
                        continue  # drop the old outer `Q` (our own is emitted below)
                elif i == first:
                    kept.append(_op([], "q"))
                    kept.extend(new_ops)
                kept.append(ins)
                if i == last:
                    kept.append(_op([], "Q"))
            return kept

        if obj["nested"]:
            _edit_nested_vector(pdf, p, obj, rewrite)
        else:
            p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(rewrite(instructions)))
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass
