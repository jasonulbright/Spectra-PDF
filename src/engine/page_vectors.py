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

from pathlib import Path

import pikepdf

from engine.content_walk import GraphicsTextState, transform_point
from engine.page_images import _save
from engine.redact import IDENTITY

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


def _walk_vectors(instructions: list) -> list:
    """One dict per PAINTED, non-clip, top-level path in encounter order.
    Each dict carries the public listing fields PLUS an internal `drop_idxs`
    (the EXACT construction-op indices + the paint index) the delete rewriter
    removes. It's a precise index SET, not a range: a state op (q/Q/cm/colour)
    a producer places BETWEEN a path's construction and its paint is
    transparent to path continuity, so it must survive the delete — a range
    delete would drop it, leaking a neighbour's colour or unbalancing q/Q
    (review round 36 HIGH)."""
    state = GraphicsTextState(IDENTITY)
    out: list = []
    path_start = None  # instruction index of the current path's first construct op
    construct_idxs: list = []  # EXACT indices of this path's construction ops
    pts: list = []  # device-space points accumulated for the bbox
    has_clip = False
    for idx, instruction in enumerate(instructions):
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        if state.feed(operator, operands):
            continue  # q/Q/cm/colour/Tf/BT/Tm/… — state, not a path op
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
                out.append(
                    {
                        "index": len(out),
                        "rect": [min(xs), min(ys), max(xs), max(ys)],
                        "matrix": list(state.ctm),
                        "kind": kind,
                        "fill": _color_rgb(state.fill_color)
                        if operator not in _PAINT_STROKE
                        else None,
                        "stroke": _color_rgb(state.stroke_color)
                        if operator not in _PAINT_FILL
                        else None,
                        "drop_idxs": construct_idxs + [idx],
                    }
                )
            path_start, construct_idxs, pts, has_clip = None, [], [], False
            continue
        # Any other operator (a show, Do, sh, inline image, w/d/gs line-state):
        # not part of a path. A path left unpainted before other content is
        # abandoned (malformed input) — reset so a stale path can't attach.
        path_start, construct_idxs, pts, has_clip = None, [], [], False
    return out


def list_page_vectors(file: str, page: int) -> dict:
    """Vector path objects on 1-based `page`, in the id order `delete_page_vector`
    targets. Page-content paths only (v1); each carries a device-space `rect`
    (bbox for selection), the CTM `matrix` (for a later transform), `kind`
    (fill/stroke/fillstroke), and best-effort `fill`/`stroke` colours."""
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        vectors = _walk_vectors(list(pikepdf.parse_content_stream(p)))
        for v in vectors:
            del v["drop_idxs"]  # internal to the walk; the public listing omits it
        return {"page": int(page), "vectors": vectors}


def delete_page_vector(file: str, output: str, page: int, index: int) -> dict:
    """Remove one vector path object — drop its construction ops + paint op
    from the page content stream (per-object; surrounding state untouched)."""
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        instructions = list(pikepdf.parse_content_stream(p))
        vectors = _walk_vectors(instructions)
        if not (0 <= int(index) < len(vectors)):
            raise ValueError(
                f"vector index {index} is out of range (page has {len(vectors)})"
            )
        drop = set(vectors[int(index)]["drop_idxs"])
        kept = [ins for i, ins in enumerate(instructions) if i not in drop]
        # Drop ONLY this object's construction ops + its paint (the exact index
        # set). Every surrounding op stays — including a state op (q/Q/cm/colour)
        # a producer placed BETWEEN construction and paint: it flows to
        # following content EXACTLY as before, so removing it would change that
        # content or unbalance q/Q (review round 36 HIGH). No resource sweep: a
        # now-unreferenced /Pattern is harmless dead weight, and pruning a
        # possibly-INHERITED /Resources could break a sibling page (the image
        # family's copy-on-write lesson).
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass
