"""Page-VECTOR editing (Phase 9.D1 — the first vector slice).

Lists, selects (via a bbox), and deletes VECTOR path objects on a page — the
drawn rules, boxes, underlines, dividers, and logos that Track C's raster
tools can't touch (the phase-open ceiling: "Vector objects aren't
addressable"). A "vector object" is ONE maximal run of path-CONSTRUCTION
operators (`m l c v y re h`) terminated by a path-PAINTING operator that
DRAWS it (`f F f* S s B B* b b*`). It is the unit the user clicks.

Ids are the depth-first encounter order of PAINTED paths in the page content
stream — its OWN ordinal space, separate from `page_images`' — so the lister
and the delete rewriter agree by construction (both walk in encounter order,
the walker-agreement invariant Phase 7 established).

What is NOT a vector object (v1 boundaries — refusals, never broken output):
  - A path terminated by `n` (end-path-no-op), or ANY path that sets a clip
    (`W`/`W*`): a clip region, not a drawn object. This is exactly the shape
    C3's crop frame emits (`re W n`), so the same rule keeps the tools' own
    frames from listing as phantom user objects. A clip-SETTING fill
    (`re W f`) is excluded too — deleting it would change the clipping of
    everything after it, which is more than "remove this object."
  - Paths inside Form XObjects — v1 lists PAGE-content paths only. Deleting
    into a shared form is the copy-on-write complexity Track C paid for; D1
    doesn't need it and won't half-pay it.
  - Shading (`sh`), images (`Do`), and text (shows) — not paths by
    definition.

Delete is strictly simpler than an image delete: DROP the target's
construction ops + its paint op from the page stream (leaving all surrounding
state — a neighbour's colour/CTM is never disturbed, exactly as the image
delete leaves the state around a dropped `Do`). No wrap, no XObject/resource
surgery; a `/Pattern`-filled path that becomes unreachable is swept by the
same `remove_unreferenced_resources` reachability pass the image family uses.

Named successors: D2 vector move/resize/rotate (the C1 mirror — `matrix` is
listed for it, exactly as C1 needed the image CTM), then recolour /
line-width, then form-nested paths.
"""

import math
from pathlib import Path

import pikepdf

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


def _points_of(operator: str, operands: list) -> list:
    """The (x, y) control/corner points a construction op contributes, in
    USER space (the caller transforms them under the live CTM). Malformed
    operand shapes yield nothing — a listing never aborts on bad geometry."""
    try:
        vals = [float(v) for v in operands]
    except (TypeError, ValueError):
        return []
    if operator in ("m", "l") and len(vals) >= 2:
        return [(vals[0], vals[1])]
    if operator == "c" and len(vals) >= 6:
        return [(vals[0], vals[1]), (vals[2], vals[3]), (vals[4], vals[5])]
    if operator in ("v", "y") and len(vals) >= 4:
        return [(vals[0], vals[1]), (vals[2], vals[3])]
    if operator == "re" and len(vals) >= 4:
        x, y, w, h = vals[0], vals[1], vals[2], vals[3]
        return [(x, y), (x + w, y), (x, y + h), (x + w, y + h)]
    return []


def _color_rgb(color_state):
    """Best-effort [r, g, b] (0-1) for a captured fill/stroke color, or None
    when the space isn't a plain device one (sc/scn/pattern/ICC — never
    guessed). `color_state` is content_walk's (space_op, value_op)."""
    if color_state is None:
        return None
    space_op, value_op = color_state
    if value_op is None:
        # No explicit value and no non-device space selected ⇒ the stream
        # default (device-gray black). A `cs`-only state (space picked, no
        # scn yet) is not device-plain → unknown.
        return [0.0, 0.0, 0.0] if space_op is None else None
    op, vals = value_op
    try:
        nums = [float(v) for v in vals]
    except (TypeError, ValueError):
        return None
    # Stroke ops (G/RG/K) share the fill ops' operand shapes — normalize so a
    # stroked path's colour is captured too (the blue-line case).
    op = op.lower()
    if op == "g" and len(nums) == 1:
        v = max(0.0, min(1.0, nums[0]))
        return [v, v, v]
    if op == "rg" and len(nums) == 3:
        return [max(0.0, min(1.0, c)) for c in nums]
    if op == "k" and len(nums) == 4:
        c, m, y, k = (max(0.0, min(1.0, n)) for n in nums)
        return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
    return None  # sc/scn/pattern/shading — honest unknown, never a wrong colour


def _walk_vectors(
    instructions: list,
    pdf=None,
    resources=None,
    base_ctm=IDENTITY,
    depth: int = 0,
    root_do_idx=None,
    form_name=None,
    base_line_width: float = 1.0,
    base_fill=DEFAULT_COLOR,
    base_stroke=DEFAULT_COLOR,
    out=None,
    base_clip=None,
) -> list:
    """One dict per PAINTED, non-clip path in depth-first encounter order.
    Recurses into Form XObjects (9.D4) when `pdf`/`resources` are supplied, so
    nested paths list too (a page-content-only walk passes neither and stays
    flat). Each dict carries the public listing fields plus internals the
    editors use: `drop_idxs` (the EXACT construction-op indices + the paint
    index — a precise SET so a state op interleaved into the path survives a
    delete, round-36 HIGH) and, for a nested path, `_form_name` (the DIRECT
    page-level form to copy-on-write) + `_root_do_idx` (the page `Do` to swap)
    + `_edit_depth` (only depth-1 nesting edits in v1; deeper lists but refuses
    the edit — copying a chain of forms is out of scope)."""
    if out is None:
        out = []
    state = GraphicsTextState(base_ctm, fill_color=base_fill, stroke_color=base_stroke)
    # 9-§I.0-S8: ambient clip tracking beside the state machine. page_vectors
    # already EXCLUDES a path that itself sets a clip (`has_clip`); this catches
    # the other half — a PAINTED path drawn wholly outside an EARLIER clip lists
    # as `clipped` (invisible). `base_clip` is the parent form's device-space
    # clip (§8.10.2).
    clips = ClipTracker(base_clip)
    path_start = None  # instruction index of the current path's first construct op
    construct_idxs: list = []  # EXACT indices of this path's construction ops
    pts: list = []  # device-space points accumulated for the bbox
    has_clip = False
    line_width = base_line_width  # `w` (PDF default 1.0) — a form inherits the caller's
    w_stack: list = []  # line width IS graphics state — q/Q-scoped like the rest
    for idx, instruction in enumerate(instructions):
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        # Ambient clip fed with the CURRENT ctm BEFORE state.feed (which
        # consumes q/Q/cm). Its own path buffer is independent of `pts` below.
        clips.feed(operator, operands, state.ctm)
        # Line width is graphics state; GraphicsTextState doesn't track it, so
        # save/restore it in lockstep with q/Q here (round-37 HIGH: a `w` set
        # inside a q…Q otherwise leaked forward and mis-inflated later strokes).
        if operator == "q":
            w_stack.append(line_width)
        elif operator == "Q" and w_stack:
            line_width = w_stack.pop()
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
            construct_idxs.append(idx)
            for px, py in _points_of(operator, operands):
                pts.append(transform_point(state.ctm, px, py))
            continue
        if operator in _CLIP:
            has_clip = True  # this path sets a clip → excluded when painted
            continue
        if operator in _PAINT_ALL:
            visible = operator in _PAINT_VISIBLE
            if visible and not has_clip and path_start is not None and pts:
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]
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
                out.append(
                    {
                        "index": len(out),
                        "rect": [vrect[0], vrect[1], vrect[2], vrect[3]],
                        "matrix": list(state.ctm),
                        "kind": kind,
                        "fill": _color_rgb(state.fill_color)
                        if operator not in _PAINT_STROKE
                        else None,
                        "stroke": _color_rgb(state.stroke_color)
                        if operator not in _PAINT_FILL
                        else None,
                        # D3: the effective line width (the width control's seed);
                        # meaningful for a stroke/fillstroke, informational for a fill.
                        "line_width": round(line_width, 4),
                        "nested": depth > 0,
                        "drop_idxs": construct_idxs + [idx],
                        "_form_name": form_name,
                        "_root_do_idx": root_do_idx,
                        "_edit_depth": depth,
                        # 9-§I.0-S8: True when wholly outside the ambient clip.
                        "clipped": clips.clips_away(vrect),
                    }
                )
            path_start, construct_idxs, pts, has_clip = None, [], [], False
            continue
        # 9.D4: recurse into a Form XObject so its paths list too (page walk
        # only — `pdf` is None for the flat page-content walks the editors run
        # on their own instruction list). The page-level `Do` index + the form
        # name ride down so a nested edit knows which form to copy and which
        # `Do` to swap.
        if operator == "Do" and pdf is not None and operands and depth < MAX_FORM_DEPTH:
            fname = str(operands[0])
            xobj = _lookup_xobject(fname, resources, resources)
            if xobj is not None and str(xobj.get("/Subtype", "")) == "/Form":
                fmatrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
                fres = xobj.get("/Resources")
                # A form inherits the caller's graphics state (§8.10.2): thread
                # the live CTM, line width, and fill/stroke into the recursion
                # so a form whose own content sets none lists with the right
                # colour/width/bbox (round-39 MED). Enclosing resources are the
                # fallback for a form whose /Resources omits a nested name.
                _walk_vectors(
                    list(pikepdf.parse_content_stream(xobj)),
                    pdf=pdf,
                    resources=fres if fres is not None else resources,
                    base_ctm=mat_mult(fmatrix, state.ctm),
                    depth=depth + 1,
                    root_do_idx=idx if depth == 0 else root_do_idx,
                    form_name=fname if depth == 0 else form_name,
                    base_line_width=line_width,
                    base_fill=state.fill_color,
                    base_stroke=state.stroke_color,
                    out=out,
                    base_clip=clips.clip,
                )
        # Any other operator (a show, Do, sh, inline image, w/d/gs line-state):
        # not part of a path. A path left unpainted before other content is
        # abandoned (malformed input) — reset so a stale path can't attach.
        path_start, construct_idxs, pts, has_clip = None, [], [], False
    return out


def list_page_vectors(file: str, page: int) -> dict:
    """Vector path objects on 1-based `page`, in the id order the editors
    target. Page-content AND form-nested paths (9.D4); each carries a
    device-space `rect` (bbox for selection), the CTM `matrix` (for a
    transform), `kind` (fill/stroke/fillstroke), best-effort `fill`/`stroke`
    colours, `line_width`, and `nested` (inside a Form XObject)."""
    _INTERNAL = ("drop_idxs", "_form_name", "_root_do_idx", "_edit_depth")
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        vectors = _walk_vectors(
            list(pikepdf.parse_content_stream(p)), pdf=pdf, resources=_resolve_resources(p)
        )
        for v in vectors:
            for k in _INTERNAL:
                v.pop(k, None)  # internal to the walk; the public listing omits them
        return {"page": int(page), "vectors": vectors}


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


def _edit_nested_vector(pdf, p, obj, rewrite) -> None:
    """9.D4: edit a vector object INSIDE a Form XObject on a COPY of that form
    (fresh name, rewritten stream), swapping only THIS `Do` — a form stamped
    elsewhere is untouched (the image copy-on-edit pattern). `rewrite` runs on
    the FORM's instruction list and may raise (validation) before any mutation.
    Only ONE level of nesting edits (v1); deeper is refused by the caller."""
    resources = _copy_resources_for_write(pdf, _resolve_resources(p))
    p.obj["/Resources"] = resources
    form = _lookup_xobject(obj["_form_name"], resources, None)
    if form is None or str(form.get("/Subtype", "")) != "/Form":
        raise ValueError("the form for this nested vector object was not found")
    new_form_instrs = rewrite(list(pikepdf.parse_content_stream(form)))
    new_form = pdf.make_stream(pikepdf.unparse_content_stream(new_form_instrs))
    # Copy every key off the original EXCEPT the stream-encoding ones (a
    # BLOCKLIST like redact.py/page_images — an allowlist silently dropped
    # keys the edited form needs, e.g. /OC layer membership; round-39 HIGH).
    for key in form.keys():
        if str(key) in ("/Length", "/Filter", "/DecodeParms"):
            continue
        new_form[key] = form[key]
    new_name = _fresh_vec_name(resources)
    _register_xobject(pdf, resources, new_name, new_form)
    page_instrs = list(pikepdf.parse_content_stream(p))
    page_instrs[obj["_root_do_idx"]] = _do_instruction(new_name)
    p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(page_instrs))
    # Reclaim the form we just superseded — otherwise the OLD form (incl. a
    # "deleted" path's geometry) stays embedded + reachable forever, and
    # repeated edits grow the file unbounded (round-39 HIGH). Only drops it
    # when nothing in the rewritten page still draws it (a form Do'd twice on
    # the page keeps its other occurrence — the reachability check handles it).
    _finalize_page_rewrite(p, page_instrs, {obj["_form_name"]})


def _resolve_target(pdf, p, index):
    """The walked object at `index` (recursive listing) + a validated nested
    edit-depth. Raises on out-of-range or a too-deeply-nested object."""
    instructions = list(pikepdf.parse_content_stream(p))
    vectors = _walk_vectors(instructions, pdf=pdf, resources=_resolve_resources(p))
    if not (0 <= int(index) < len(vectors)):
        raise ValueError(f"vector index {index} is out of range (page has {len(vectors)})")
    obj = vectors[int(index)]
    if obj["nested"] and obj["_edit_depth"] != 1:
        raise ValueError(
            "this vector object is nested more than one form deep and cannot be edited"
        )
    return instructions, obj


def delete_page_vector(file: str, output: str, page: int, index: int) -> dict:
    """Remove one vector path object — drop its construction ops + paint op
    (per-object; surrounding state untouched). A NESTED path is dropped on a
    copy of its form (9.D4)."""
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
        # content or unbalance q/Q (review round 36 HIGH). No resource sweep: a
        # now-unreferenced /Pattern is harmless dead weight.
        drop = set(obj["drop_idxs"])

        def rewrite(instrs):
            return [ins for i, ins in enumerate(instrs) if i not in drop]

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


def transform_page_vector(file: str, output: str, page: int, index: int, matrix: list) -> dict:
    """Move / resize / rotate ONE vector object (Phase 9.D2) by wrapping its
    path run in `q <cm> … Q` — the C1 mirror.

    `matrix` is the DESIRED absolute placement M' of the object's bbox as a
    unit-square matrix [a,b,c,d,e,f] in DEVICE space — what the canvas gesture
    produced from `list_page_vectors`' `rect` (bbox → [w,0,0,h,x0,y0]). The op
    recomputes the object's CURRENT bbox → M_cur, the device-space delta
    D = M'·M_cur⁻¹, and the insert `cm = C·D·C⁻¹` (C = the object's own CTM) so
    D acts in DEVICE space even under a nested CTM, then wraps the object's
    contiguous op run. REFUSES an object whose path has graphics-state
    operators interleaved into it (non-contiguous — a wrap's `Q` would scope
    them, the round-36 hazard) or a degenerate (zero-area) bbox."""
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
        drop = obj["drop_idxs"]
        first, last = drop[0], drop[-1]
        if drop != list(range(first, last + 1)):
            raise ValueError(
                "vector object has interleaved graphics-state operators and cannot be transformed"
            )
        bx0, by0, bx1, by1 = obj["rect"]
        bw, bh = bx1 - bx0, by1 - by0
        if abs(bw) < 1e-6 or abs(bh) < 1e-6:
            raise ValueError("vector object bbox is degenerate and cannot be transformed")
        c = tuple(obj["matrix"])
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
            kept: list = []
            for i, ins in enumerate(instrs):
                if i == first:
                    kept.append(_op([], "q"))
                    kept.append(cm)
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
    """Recolour / re-width ONE vector object (Phase 9.D3) by wrapping its path
    run in `q <state ops> … Q`.

    The new fill (`rg`), stroke (`RG`), and/or line width (`w`) are injected
    INSIDE the wrap, BEFORE the object's existing run, so they apply to THIS
    object and the `Q` scopes them (a neighbour that inherits the surrounding
    colour is untouched — the object's own paint just uses the new state).
    `fill`/`stroke` are [r,g,b] 0-1 (clamped); `line_width` is a number ≥ 0.
    REFUSES an object with interleaved graphics-state operators (non-contiguous
    run — a wrap's `Q` would scope them, the round-36 hazard) or a request that
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
        drop = obj["drop_idxs"]
        first, last = drop[0], drop[-1]
        if drop != list(range(first, last + 1)):
            raise ValueError(
                "vector object has interleaved graphics-state operators and cannot be restyled"
            )

        def rewrite(instrs):
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
