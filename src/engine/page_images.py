"""Page-image editing (Phase 7.1 — the first Edit slice).

Lists, deletes, replaces, and extracts IMAGE XObject placements on a page.
A "placement" is one `Do` draw of an image — the unit the user clicks. Ids
are the depth-first visit order of image draws (page stream first, forms
recursed at their `Do` position), so the lister and the rewriter agree by
construction: both walk in encounter order.

Edit semantics are strictly PER-PLACEMENT:
  - delete removes that one `Do`; a shared image XObject drawn elsewhere is
    untouched. Reachability cleanup is `_finalize_page_rewrite` (the
    redact.py recipe): qpdf's `remove_unreferenced_resources` GC plus an
    explicit drop of superseded original FORMS (which the GC leaves) — so
    deleted/replaced image bytes are genuinely absent from the output, not
    merely undrawn.
  - replace registers the new image under a NEW name and renames only that
    `Do` — other placements of the original keep the original. The
    placement CTM is preserved exactly: the new image draws into the old
    box (a different aspect ratio stretches; that is the documented v1
    behavior, matching the phase doc's "reuse the original placement CTM").
  - a placement INSIDE a Form XObject is edited on a COPY of that form
    (registered under a fresh name, only that draw's `Do` rewritten) — the
    `_redact_form` copy-on-edit pattern — so a form stamped on ten pages
    changes only where the user edited it.

Replacement sources (no new engine deps — the WEBVIEW is the decoder, this
module only embeds):
  - ``{"jpeg_path": ...}``: byte passthrough as /DCTDecode (zero quality
    loss). Grayscale and RGB JPEGs only; anything else (CMYK/progressive
    oddities the SOF scan can't bless) raises a specific error the renderer
    answers by re-sending decoded raw pixels.
  - ``{"raw_path": ..., "width": w, "height": h, "channels": 3|4}``: packed
    8-bit pixels from the renderer's canvas decode. channels=4 splits the
    alpha plane into an /SMask.

Inline images (BI/ID/EI) are placements too (9.C4 re-ratified the 7.1
non-goal): they list with `kind: "inline"` in the same depth-first id
order as XObject draws (`kind: "xobject"`), and the wrap/drop family
(delete/transform/crop/opacity) applies to them identically — both draw
the unit square under the live CTM. REPLACE and EXTRACT refuse inline
targets with named reasons (delete + add covers the workflow; the bytes
live in the stream, so a deleted inline draw needs no GC).

Text-run editing (7.2) will consolidate this walker and redact.py's into
one shared interpreter; for this slice the graphics-state tracking is
deliberately duplicated (~40 lines, helpers imported) rather than churning
the security-critical redactor in a release-bound slice — see
docs/architecture/21-phase7-content-editing.md.
"""

import os
import shutil
import stat
import struct
import tempfile
import zlib
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from engine.content_walk import ClipTracker, GraphicsTextState
from engine.redact import (
    IDENTITY,
    MAX_FORM_DEPTH,
    _as_matrix,
    _bbox_of_rect_under_matrix,
    _copy_resources_for_write,
    _drop_replaced_forms,
    _lookup_xobject,
    _mat_mult,
    _resolve_resources,
)

# ── listing ───────────────────────────────────────────────────────────────

# The three wrap shapes `_emit_wrap` emits, keyed by the exact operator
# sequence between the frame's `q` and its inner unit (C3-tail recognition).
_WRAP_SHAPES = {
    ("cm",): "transform",
    ("re", "W", "n"): "crop",
    ("gs",): "opacity",
}


def _recognized_frames(instructions, t, enclosing):
    """The stack of tool-authored wrapper frames enclosing the draw at
    index `t`: the maximal INNERMOST run of enclosing q…Q frames each
    matching one `_emit_wrap` operator shape EXACTLY — prefix ops, then
    exactly the inner unit (the draw, or the previously recognized frame),
    then the closing Q. Anything else in a frame — author clips, arbitrary
    q-frames, a malformed re — stops recognition THERE (fail closed:
    outer frames stay unrecognized and untouched). `enclosing` is the
    open-q input indices around `t`, outermost first. Returns
    [{kind, open, close[, rect]}] innermost first; crop frames carry
    `rect` = the re operands as [cx0, cy0, cx1, cy1] (unit space)."""
    frames = []
    lo, hi = t, t  # input-index span of the current inner unit
    for a in reversed(enclosing):
        prefix = tuple(str(instructions[k].operator) for k in range(a + 1, lo))
        kind = _WRAP_SHAPES.get(prefix)
        b = hi + 1
        if kind is None or b >= len(instructions) or str(instructions[b].operator) != "Q":
            break
        frame = {"kind": kind, "open": a, "close": b}
        if kind == "crop":
            try:
                x, y, w, h = (float(v) for v in instructions[a + 1].operands)
            except (TypeError, ValueError):
                break
            frame["rect"] = [x, y, x + w, y + h]
        frames.append(frame)
        lo, hi = a, b
    return frames


def _listed_crop(instructions, t, enclosing):
    """C3-tail additive listing field: the intersection of RECOGNIZED crop
    frames around the draw at `t` (unit space), None when there are none.
    Plural frames only arise in pre-tail files (the intersect era) — the
    op now collapses to one. Author clips are deliberately unreported
    (unrecognized ⇒ no crop handles ⇒ band-crop UX): handles only where
    the tool can round-trip."""
    rects = [
        f["rect"] for f in _recognized_frames(instructions, t, enclosing) if f["kind"] == "crop"
    ]
    if not rects:
        return None
    return [
        round(max(r[0] for r in rects), 6),
        round(max(r[1] for r in rects), 6),
        round(min(r[2] for r in rects), 6),
        round(min(r[3] for r in rects), 6),
    ]


def _walk_placements(
    pdf, instructions, resources, base_ctm, depth, fallback_resources, out, nested, base_alpha=1.0, base_clip=None
):
    """Append one dict per image `Do` to `out`, in encounter order. State
    tracking is the shared GraphicsTextState (7.2 consolidation) — the same
    machine the rewriter's DFS order agreement is proven against.

    Fill alpha (the C3 opacity seed) is tracked LOCALLY: the shared state
    machine's feed() has no resources access, and `gs` needs the current
    stream's /ExtGState to resolve — so alpha rides its own q/Q-scoped
    stack here, inherited into forms at their Do like the CTM. The open-q
    index stack rides alongside for `crop` (C3-tail): wrapper frames live
    in the SAME instruction list as their draw (nested edits wrap inside
    the form copy), so per-level recognition sees every tool frame."""
    instructions = list(instructions)
    state = GraphicsTextState(base_ctm)
    # 9-§I.0-S8: clip tracking beside the state machine — a placement wholly
    # outside the active clip lists as `clipped` (invisible) so the renderer
    # stops offering it as editable. `base_clip` is the parent's device-space
    # clip a nested form inherits (§8.10.2).
    clips = ClipTracker(base_clip)
    alpha = float(base_alpha)
    alpha_stack: list[float] = []
    q_open: list[int] = []
    for idx, instruction in enumerate(instructions):
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        # Fed with the CURRENT ctm BEFORE state.feed (which consumes q/Q/cm).
        clips.feed(operator, operands, state.ctm)
        if operator == "q":
            alpha_stack.append(alpha)
            q_open.append(idx)
        elif operator == "Q":
            alpha = alpha_stack.pop() if alpha_stack else float(base_alpha)
            if q_open:
                q_open.pop()
        elif operator == "gs" and operands:
            gs_name = str(operands[0])
            for res in (resources, fallback_resources):
                if res is None:
                    continue
                try:
                    egs = res.get("/ExtGState")
                    if egs is None or Name(gs_name) not in egs:
                        continue
                    ca = egs[Name(gs_name)].get("/ca")
                    if ca is not None:
                        alpha = max(0.0, min(1.0, float(ca)))
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass  # malformed ExtGState: alpha unchanged, never abort a listing
                break
        if state.feed(operator, operands):
            continue
        if operator == "INLINE IMAGE":
            # C4: a BI/ID/EI object occupies ONE stream slot and draws the
            # unit square under the live CTM exactly like an image Do — it
            # is a placement in the SAME depth-first id order (the
            # walker-agreement invariant covers both machines). pikepdf
            # normalizes the abbreviated keys (/W → /Width …).
            obj = instruction.iimage.obj
            x0, y0, x1, y1 = _bbox_of_rect_under_matrix(state.ctm, 1.0, 1.0)
            try:
                nw, nh = int(obj.get("/Width", 0) or 0), int(obj.get("/Height", 0) or 0)
            except (TypeError, ValueError):
                nw = nh = 0
            out.append(
                {
                    "index": len(out),
                    "rect": [x0, y0, x1, y1],
                    "matrix": list(state.ctm),
                    "name": None,
                    "kind": "inline",
                    "nested": nested,
                    "native_width": nw,
                    "native_height": nh,
                    "opacity": round(alpha, 4),
                    "crop": _listed_crop(instructions, idx, q_open),
                    # 9-§I.0-S8: True when this placement is wholly outside the
                    # active clip (invisible); renderer filters it out. Index
                    # space unchanged (mutator count agreement untouched).
                    "clipped": clips.clips_away((x0, y0, x1, y1)),
                }
            )
            continue
        if operator == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback_resources)
            subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""
            if xobj is not None and subtype == "/Image":
                x0, y0, x1, y1 = _bbox_of_rect_under_matrix(state.ctm, 1.0, 1.0)
                out.append(
                    {
                        "index": len(out),
                        "rect": [x0, y0, x1, y1],
                        # The FULL device CTM at this Do (the unit square [0,1]²
                        # maps to the page through it). C1's transform op needs
                        # it to build the delta cm; `rect` is just its bbox.
                        "matrix": list(state.ctm),
                        "name": name,
                        "kind": "xobject",
                        "nested": nested,
                        "native_width": int(xobj.get("/Width", 0)),
                        "native_height": int(xobj.get("/Height", 0)),
                        # C3: effective fill alpha at this draw (the opacity
                        # slider's honest seed).
                        "opacity": round(alpha, 4),
                        # C3-tail: the tool crop rect (crop-handle seed).
                        "crop": _listed_crop(instructions, idx, q_open),
                        # 9-§I.0-S8: True when wholly outside the active clip.
                        "clipped": clips.clips_away((x0, y0, x1, y1)),
                    }
                )
            elif xobj is not None and subtype == "/Form" and depth < MAX_FORM_DEPTH:
                form_matrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
                form_res = xobj.get("/Resources")
                _walk_placements(
                    pdf,
                    pikepdf.parse_content_stream(xobj),
                    form_res if form_res is not None else resources,
                    _mat_mult(form_matrix, state.ctm),
                    depth + 1,
                    resources,
                    out,
                    True,
                    base_alpha=alpha,
                    base_clip=clips.clip,
                )
    return out


def list_page_images(file: str, page: int) -> dict:
    """Image placements on 1-based `page`, in the id order every mutator
    below targets."""
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        placements: list[dict] = []
        _walk_placements(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, placements, False
        )
        return {"page": int(page), "images": placements}


# ── targeted rewriting (delete / replace) ─────────────────────────────────


def _do_instruction(name: str):
    return pikepdf.ContentStreamInstruction([Name(name)], pikepdf.Operator("Do"))


def _op(operands, name: str):
    return pikepdf.ContentStreamInstruction(operands, pikepdf.Operator(name))


def _invert_matrix(m):
    """Inverse of a PDF affine matrix (a,b,c,d,e,f). Raises on a degenerate
    (det≈0) matrix — a placement collapsed to a line/point can't be inverted
    (and can't have been a real image draw)."""
    a, b, c, d, e, f = (float(v) for v in m)
    det = a * d - b * c
    if abs(det) < 1e-9:
        raise ValueError("image placement matrix is degenerate (not invertible)")
    return (
        d / det,
        -b / det,
        -c / det,
        a / det,
        (c * f - d * e) / det,
        (b * e - a * f) / det,
    )


class _EditState:
    """Mutable cursor shared across the recursive rewrite: counts image
    draws in the SAME order as the lister; applies the action at `target`."""

    def __init__(
        self,
        target: int,
        action: str,
        replacement_name: str | None,
        pending_image=None,
        delta=None,
        crop_rect=None,
        pending_gs=None,
    ):
        self.target = target
        self.action = action  # 'delete' | 'replace' | 'transform' | 'crop' | 'opacity'
        self.replacement_name = replacement_name
        self.pending_image = pending_image
        # 'transform' only: the delta matrix D injected as `q D cm Do Q` at the
        # target draw so the placement's effective CTM becomes the caller's M'.
        self.delta = delta
        # 'crop' only (C3): [cx0, cy0, cx1, cy1] in the image's UNIT space —
        # emitted as a clip path AT the draw, so it rides the same CTM as the
        # unit square at any nesting depth (no matrix math needed).
        self.crop_rect = crop_rect
        # 'transform' only (C3-tail): the intersection of the recognized crop
        # frames the collapse just dropped at the target — re-emitted as the
        # innermost frame INSIDE the new cm, so the clip travels with the
        # move instead of staying in pre-transform space.
        self.carried_crop = None
        # 'opacity' only (C3): the ExtGState dict to register. The NAME is
        # allocated AT the target draw against the resources actually in
        # scope there (a nested target must never shadow the form's own
        # /ExtGState names); `registered_nested` records that a form copy
        # took the registration, so the op function skips the page level.
        self.pending_gs = pending_gs
        self.gs_name: str | None = None
        self.registered_nested = False
        self.seen = 0
        self.done = False
        self.deleted_name: str | None = None
        # Original form names whose Do was rewritten to a copy — their
        # entries must be DROPPED when nothing still draws them (qpdf's GC
        # removes orphaned images/fonts but LEAVES forms; without the drop
        # the superseded form keeps the "deleted" image bytes reachable —
        # review-caught, and redact.py's exact precedent).
        self.superseded_forms: set = set()


def _emit_wrap(kept, instruction, state, resources, fallback_resources, reserved) -> bool:
    """The WRAP actions (transform/crop/opacity) at the target draw —
    shared by Do and inline-image targets (C4): both draw the unit square
    under the live CTM, so the q/Q-bounded prefix is identical. Returns
    True when the action was one of the wraps."""
    if state.action == "transform":
        kept.append(_op([], "q"))
        kept.append(_op([round(float(v), 6) for v in state.delta], "cm"))
        if state.carried_crop is not None:
            # The collapsed crop re-emits as its OWN nested frame
            # (`q re W n <draw> Q`) inside the transform frame — the exact
            # recognized shape, so listings still report it and a later
            # re-crop still collapses it. Innermost = image unit space =
            # the clip stays correct as the placement moves.
            cx0, cy0, cx1, cy1 = state.carried_crop
            kept.append(_op([], "q"))
            kept.append(
                _op(
                    [round(cx0, 6), round(cy0, 6), round(cx1 - cx0, 6), round(cy1 - cy0, 6)],
                    "re",
                )
            )
            kept.append(_op([], "W"))
            kept.append(_op([], "n"))
            kept.append(instruction)
            kept.append(_op([], "Q"))
        else:
            kept.append(instruction)
        kept.append(_op([], "Q"))
        return True
    if state.action == "crop":
        cx0, cy0, cx1, cy1 = state.crop_rect
        kept.append(_op([], "q"))
        kept.append(
            _op(
                [round(cx0, 6), round(cy0, 6), round(cx1 - cx0, 6), round(cy1 - cy0, 6)],
                "re",
            )
        )
        kept.append(_op([], "W"))
        kept.append(_op([], "n"))
        kept.append(instruction)
        kept.append(_op([], "Q"))
        return True
    if state.action == "opacity":
        state.gs_name = _fresh_gs_name(resources, fallback_resources, reserved)
        kept.append(_op([], "q"))
        kept.append(_op([Name(state.gs_name)], "gs"))
        kept.append(instruction)
        kept.append(_op([], "Q"))
        return True
    return False


def _collapse_crop_frames(kept, instructions, t, open_q, skip_q):
    """C3-tail collapse-and-replace: at the target draw, drop every
    RECOGNIZED tool crop frame from the already-emitted `kept` prefix and
    mark its closing Q for skipping, so the ONE fresh innermost frame
    `_emit_wrap` is about to emit REPLACES the old rect instead of
    intersecting it (a re-crop can widen). Recognized transform/opacity
    frames stay byte-identical; an unrecognized frame stops recognition —
    fail closed, the fresh clip then intersects (the pre-tail behavior,
    and the author-clip guarantee). Safe by recognition's exactness: each
    dropped frame's q/re/W/n landed as four CONTIGUOUS kept entries
    (nothing else fits between the q and the inner unit), and recognized
    frames are the innermost run of open_q, so deleting them never shifts
    an outer open frame's recorded position. Returns the dropped frames'
    intersection (None when none dropped): `crop` ignores it (the fresh
    rect is absolute), `transform` re-emits it INSIDE the new cm frame —
    the clip is unit-space, so the innermost slot is the only one that
    stays correct as the placement moves (pre-fix, a crop-then-move left
    the clip in pre-transform space and slivered the moved image)."""
    removals = []
    rects = []
    for frame in _recognized_frames(instructions, t, [i for i, _ in open_q]):
        if frame["kind"] != "crop":
            continue
        kept_at = next((k for i, k in open_q if i == frame["open"]), None)
        if kept_at is None:
            continue
        removals.append(kept_at)
        rects.append(frame["rect"])
        skip_q.add(frame["close"])
    for kept_at in sorted(removals, reverse=True):
        del kept[kept_at : kept_at + 4]
    if not rects:
        return None
    ix0 = max(r[0] for r in rects)
    iy0 = max(r[1] for r in rects)
    ix1 = min(r[2] for r in rects)
    iy1 = min(r[3] for r in rects)
    if ix0 >= ix1 or iy0 >= iy1:
        # DISJOINT frames (pre-tail files): the true intersection is empty.
        # Never return the raw inverted numbers — PDF `re` normalizes
        # negative extents, so an inverted rect clips to the region BETWEEN
        # the crops and un-hides what both hid (round 29 HIGH). A zero-area
        # rect is the honest carry: still nothing visible.
        return [ix0, iy0, ix0, iy0]
    return [ix0, iy0, ix1, iy1]


def _rewrite(pdf, instructions, resources, depth, fallback_resources, state, name_counter, reserved):
    """Return (kept_instructions, changed, new_forms). Recurses into forms;
    when the target draw lies inside one, the form is COPIED (fresh name,
    rewritten stream) and only this draw's Do is renamed to the copy.

    `new_forms` ({name: stream}) are copies created AT THIS LEVEL, for the
    CALLER to register into its own fresh resources — the redact.py
    new_forms pattern. Registering into the passed-in `resources` directly
    mutated the ENCLOSING form's ORIGINAL, shared resources for 2-level
    nesting (review-caught by object-identity trace: a letterhead form
    reused across pages gained stray edit-copy references).

    Ordinal counting (`state.seen`) is untouched by the C3-tail frame
    bookkeeping: q/Q only ride the open_q/skip_q locals, draws increment
    exactly as the lister counts them, and collapse edits only the OUTPUT
    (`kept` + skipped Q's), never the iteration."""
    instructions = list(instructions)
    kept = []
    changed = False
    new_forms: dict = {}
    open_q: list[tuple[int, int]] = []  # (input index, kept index) of open q's
    skip_q: set[int] = set()  # input indices of dropped crop frames' closing Q's
    for i, instruction in enumerate(instructions):
        operator = str(instruction.operator)
        if operator == "q":
            kept.append(instruction)
            open_q.append((i, len(kept) - 1))
            continue
        if operator == "Q":
            if open_q:
                open_q.pop()
            if i in skip_q:
                continue
            kept.append(instruction)
            continue
        if operator == "INLINE IMAGE":
            # C4: inline draws share the ordinal stream with image Do's —
            # the lister counts both, so the rewriter must too (a later
            # inline draw still occupies its counted slot after the edit
            # is done).
            if not state.done and state.seen == state.target:
                state.done = True
                changed = True
                if state.action == "crop":
                    _collapse_crop_frames(kept, instructions, i, open_q, skip_q)
                elif state.action == "transform":
                    state.carried_crop = _collapse_crop_frames(
                        kept, instructions, i, open_q, skip_q
                    )
                if state.action == "delete":
                    pass  # dropped — inline bytes live in the stream itself
                elif not _emit_wrap(
                    kept, instruction, state, resources, fallback_resources, reserved
                ):
                    # replace targets an XObject draw; the op refuses
                    # upstream — this is the belt.
                    raise ValueError("an inline image cannot be replaced")
            else:
                kept.append(instruction)
            state.seen += 1
            continue
        operands = list(instruction.operands)
        if operator != "Do" or state.done:
            kept.append(instruction)
            continue
        name = str(operands[0]) if operands else None
        xobj = _lookup_xobject(name, resources, fallback_resources)
        subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""
        if xobj is not None and subtype == "/Image":
            if state.seen == state.target:
                state.done = True
                changed = True
                if state.action == "crop":
                    _collapse_crop_frames(kept, instructions, i, open_q, skip_q)
                elif state.action == "transform":
                    state.carried_crop = _collapse_crop_frames(
                        kept, instructions, i, open_q, skip_q
                    )
                if state.action == "delete":
                    state.deleted_name = name
                    # drop the instruction
                elif _emit_wrap(kept, instruction, state, resources, fallback_resources, reserved):
                    # transform: q D cm — effective D·M_cur = M' at any depth.
                    # crop (C3-tail): the clip rect rides the image's own unit
                    # space; recognized old crop frames were just collapsed,
                    # so this fresh innermost frame REPLACES (absolute rect).
                    # opacity (C3): gs name allocated AT the draw against the
                    # resources in scope (never shadows a form's own names).
                    pass
                else:
                    kept.append(_do_instruction(state.replacement_name))
            else:
                kept.append(instruction)
            state.seen += 1
        elif xobj is not None and subtype == "/Form" and depth < MAX_FORM_DEPTH:
            form_res = xobj.get("/Resources")
            read_res = form_res if form_res is not None else resources
            inner_kept, inner_changed, inner_new_forms = _rewrite(
                pdf,
                pikepdf.parse_content_stream(xobj),
                read_res,
                depth + 1,
                resources,
                state,
                name_counter,
                reserved,
            )
            if inner_changed:
                changed = True
                copy = pdf.make_stream(pikepdf.unparse_content_stream(inner_kept))
                # Rebuilt content is UNCOMPRESSED — never inherit /Filter or
                # /DecodeParms (the redact.py lesson); /Length is recomputed.
                for key in xobj.keys():
                    if key in ("/Length", "/Filter", "/DecodeParms", "/Resources"):
                        continue
                    copy[key] = xobj[key]
                copy_res = _copy_resources_for_write(pdf, read_res)
                # Deeper-level copies register into THIS copy's resources —
                # never into the original's (the staging rule above).
                for nm, st in inner_new_forms.items():
                    copy_res["/XObject"][Name(nm)] = pdf.make_indirect(st)
                if state.action == "replace" and state.replacement_name:
                    # The renamed Do resolves against the COPY's resources.
                    copy_res["/XObject"][Name(state.replacement_name)] = pdf.make_indirect(
                        state.pending_image
                    )
                if state.action == "opacity" and state.gs_name and not state.registered_nested:
                    # The `gs` resolves against the copy holding the draw —
                    # the INNERMOST copy (first unwind) takes it; outer
                    # frames skip. /ExtGState gets a FRESH subdict: the
                    # copied resources share it by reference, and mutating
                    # the shared one is the C2 sibling-leak class.
                    src_egs = copy_res.get("/ExtGState")
                    fresh_egs = Dictionary()
                    if src_egs is not None:
                        for k in src_egs.keys():
                            fresh_egs[k] = src_egs[k]
                    fresh_egs[Name(state.gs_name)] = pdf.make_indirect(state.pending_gs)
                    copy_res["/ExtGState"] = fresh_egs
                    state.registered_nested = True
                copy["/Resources"] = copy_res
                new_name = _fresh_name(resources, name_counter, reserved)
                new_forms[new_name] = copy
                kept.append(_do_instruction(new_name))
                if name:
                    state.superseded_forms.add(name)
            else:
                kept.append(instruction)
        else:
            kept.append(instruction)
    return kept, changed, new_forms


def _fresh_gs_name(resources, fallback_resources, reserved: set) -> str:
    """A /ExtGState name unused by the resources in scope at the target
    draw AND by this op's prior allocations. Separate from `_fresh_name`
    (which scans /XObject): the two live in different namespaces."""
    taken = set(reserved)
    for res in (resources, fallback_resources):
        if res is None:
            continue
        try:
            egs = res.get("/ExtGState")
            if egs is not None:
                taken.update(str(k) for k in egs.keys())
        except (TypeError, ValueError, AttributeError):
            pass
    i = 0
    while True:
        name = f"/EditGS{i}"
        if name not in taken:
            reserved.add(name)
            return name
        i += 1


def _fresh_name(resources, name_counter, reserved: set) -> str:
    """A name unused by `resources` AND by every allocation this op already
    made (`reserved`) — one op allocates from one counter+set, so the
    replacement-image name and any form-copy names can never collide even
    though registration happens later."""
    taken = set(reserved)
    xo = resources.get("/XObject") if resources is not None else None
    if xo is not None:
        taken |= {str(k) for k in xo.keys()}
    while True:
        name = f"/EditIm{name_counter[0]}"
        name_counter[0] += 1
        if name not in taken:
            reserved.add(name)
            return name


def _register_xobject(pdf, resources, name: str, obj) -> None:
    xo = resources.get("/XObject")
    if xo is None:
        xo = Dictionary()
        resources["/XObject"] = xo
    xo[Name(name)] = pdf.make_indirect(obj)


def _names_drawn(instructions) -> set:
    names = set()
    for instruction in instructions:
        if str(instruction.operator) == "Do" and instruction.operands:
            names.add(str(instruction.operands[0]))
    return names


def _finalize_page_rewrite(page, kept, superseded_forms: set) -> None:
    """Post-rewrite reachability cleanup — the redact.py recipe, exactly:
    `page.remove_unreferenced_resources()` (qpdf's real GC) drops orphaned
    image/font entries at every level, but LEAVES unreferenced Form
    XObjects in place, so a form whose Do was superseded by an edit copy is
    dropped explicitly — only when nothing in the rewritten stream still
    draws it, and only from the page's OWN /Resources (an inherited/shared
    dict is left intact: sibling pages may reference the original there).
    Once the form entry is gone its whole subtree — including a "deleted"
    image that lived only in the form's own resources — is unreachable and
    is not written on save."""
    page.remove_unreferenced_resources()
    if superseded_forms:
        own_res = page.obj.get("/Resources")
        if own_res is not None:
            _drop_replaced_forms(own_res.get("/XObject"), _names_drawn(kept), superseded_forms)


def _save(pdf, input_path: Path, output_path: Path) -> None:
    """Same save semantics as ocr_layer: identity-aware same-file takes
    temp+rename; a distinct read-only output is made writable first."""
    same_file = input_path.resolve() == output_path.resolve() or (
        output_path.exists() and os.path.samefile(input_path, output_path)
    )
    if same_file:
        with tempfile.NamedTemporaryFile(
            suffix=".pdf", delete=False, dir=str(input_path.parent)
        ) as tmp:
            tmp_path = tmp.name
        pdf.save(tmp_path)
        pdf.close()
        shutil.move(tmp_path, str(output_path))
    else:
        if output_path.exists() and not os.access(output_path, os.W_OK):
            os.chmod(output_path, stat.S_IWRITE)
        pdf.save(output_path)


def delete_page_image(file: str, output: str, page: int, index: int) -> dict:
    """Remove one image placement (per-placement — see module docstring)."""
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        # Copy-on-write a page-LOCAL /Resources (the C2 review fix, applied to
        # every page-level image op): qpdf flattens inherited /Resources onto
        # each page's own dict BY REFERENCE, so registering an edit's new
        # XObject / form copies on the resolved dict would leak them into every
        # sibling page sharing it. `_copy_resources_for_write` gives a fresh
        # /XObject; existing draws resolve against the copied (shared-by-ref)
        # entries.
        resources = _copy_resources_for_write(pdf, _resolve_resources(p))
        p.obj["/Resources"] = resources
        count = len(
            _walk_placements(
                pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False
            )
        )
        if not (0 <= int(index) < count):
            raise ValueError(f"image index {index} is out of range (page has {count})")

        state = _EditState(int(index), "delete", None)
        kept, changed, new_forms = _rewrite(
            pdf, pikepdf.parse_content_stream(p), resources, 0, None, state, [1], set()
        )
        if not changed:
            raise ValueError("edit did not apply (placement not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, state.superseded_forms)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def transform_page_image(file: str, output: str, page: int, index: int, matrix: list) -> dict:
    """Move/resize/rotate ONE image placement by rewriting the CTM at its Do
    (Phase 9.C1) — the image bytes are never touched.

    `matrix` is the DESIRED absolute placement matrix M' [a,b,c,d,e,f] in page
    user space — what `list_page_images` reports as `matrix` for this
    placement, after the canvas gesture. The op finds the placement's CURRENT
    device CTM M_cur (the same DFS walk the lister uses), computes the delta
    D = M'·M_cur⁻¹, and wraps the draw as `q D cm Do Q`, so the effective
    transform D·M_cur becomes M'. Per-placement like delete/replace: a shared
    XObject drawn elsewhere is untouched; a placement inside a form is
    transformed on a COPY of that form."""
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
        # Copy-on-write a page-LOCAL /Resources — nested-placement transforms
        # register a form COPY, which on a shared (qpdf-flattened) /Resources
        # would leak into sibling pages (the C2 review fix, uniform across the
        # page-level image ops).
        resources = _copy_resources_for_write(pdf, _resolve_resources(p))
        p.obj["/Resources"] = resources
        placements = _walk_placements(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False
        )
        if not (0 <= int(index) < len(placements)):
            raise ValueError(
                f"image index {index} is out of range (page has {len(placements)})"
            )
        m_cur = tuple(placements[int(index)]["matrix"])
        delta = _mat_mult(m_target, _invert_matrix(m_cur))

        state = _EditState(int(index), "transform", None, delta=delta)
        kept, changed, new_forms = _rewrite(
            pdf, pikepdf.parse_content_stream(p), resources, 0, None, state, [1], set()
        )
        if not changed:
            raise ValueError("edit did not apply (placement not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, state.superseded_forms)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def crop_page_image(file: str, output: str, page: int, index: int, rect: list) -> dict:
    """Crop ONE image placement to `rect` = [cx0, cy0, cx1, cy1] in the
    image's UNIT space ([0,0] = bottom-left of the drawn image, [1,1] =
    top-right) — Phase 9.C3. Display-only: the draw is wrapped in a q/Q
    clip (`re W n`) at the target Do, the image bytes stay untouched, and
    the visible region stays exactly where it was on the page
    (crop-in-place). Re-crop is COLLAPSE-AND-REPLACE (C3-tail): every
    RECOGNIZED tool crop frame around the draw is dropped and ONE fresh
    innermost frame carries the new ABSOLUTE rect — so a re-crop can
    WIDEN. Recognition is exact-shape over `_emit_wrap`'s three wrappers;
    author clips and arbitrary q-frames stop it and stay untouched (the
    fresh clip then intersects naturally — the pre-tail behavior).
    Per-placement like every sibling op: shared XObjects elsewhere and
    other pages are untouched; a nested placement crops on a COPY of its
    form (the wrapper frames live in that copy)."""
    try:
        cx0, cy0, cx1, cy1 = (float(v) for v in rect)
    except (TypeError, ValueError):
        raise ValueError("rect must be [cx0, cy0, cx1, cy1]") from None
    lo_x, hi_x = min(cx0, cx1), max(cx0, cx1)
    lo_y, hi_y = min(cy0, cy1), max(cy0, cy1)
    eps = 1e-6
    if lo_x < -eps or lo_y < -eps or hi_x > 1 + eps or hi_y > 1 + eps:
        raise ValueError("crop rect must lie within the image (unit coordinates 0..1)")
    lo_x, lo_y = max(lo_x, 0.0), max(lo_y, 0.0)
    hi_x, hi_y = min(hi_x, 1.0), min(hi_y, 1.0)
    if (hi_x - lo_x) < 1e-4 or (hi_y - lo_y) < 1e-4:
        raise ValueError("crop rect is degenerate (nothing would remain visible)")
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        # Page-local /Resources copy-on-write (the C2 sibling-leak rule,
        # uniform across the page-image op family).
        resources = _copy_resources_for_write(pdf, _resolve_resources(p))
        p.obj["/Resources"] = resources
        placements = _walk_placements(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False
        )
        if not (0 <= int(index) < len(placements)):
            raise ValueError(
                f"image index {index} is out of range (page has {len(placements)})"
            )
        state = _EditState(int(index), "crop", None, crop_rect=(lo_x, lo_y, hi_x, hi_y))
        kept, changed, new_forms = _rewrite(
            pdf, pikepdf.parse_content_stream(p), resources, 0, None, state, [1], set()
        )
        if not changed:
            raise ValueError("edit did not apply (placement not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, state.superseded_forms)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def set_image_opacity(file: str, output: str, page: int, index: int, opacity: float) -> dict:
    """Set ONE image placement's opacity — Phase 9.C3. The draw is wrapped
    as `q /EditGSn gs Do Q` with a page-local (or form-copy-local, for a
    nested target) /ExtGState carrying `/ca` and `/CA` = `opacity`
    (clamped 0..1). Non-destructive and per-placement; the gs name is
    allocated against the resources in scope at the draw so it can never
    shadow an existing entry."""
    try:
        alpha = float(opacity)
    except (TypeError, ValueError):
        raise ValueError("opacity must be a number between 0 and 1") from None
    if not (0.0 <= alpha <= 1.0):
        raise ValueError("opacity must be between 0 and 1")
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _copy_resources_for_write(pdf, _resolve_resources(p))
        p.obj["/Resources"] = resources
        placements = _walk_placements(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False
        )
        if not (0 <= int(index) < len(placements)):
            raise ValueError(
                f"image index {index} is out of range (page has {len(placements)})"
            )
        gs_dict = Dictionary(
            Type=Name("/ExtGState"), ca=round(alpha, 4), CA=round(alpha, 4)
        )
        state = _EditState(int(index), "opacity", None, pending_gs=gs_dict)
        kept, changed, new_forms = _rewrite(
            pdf, pikepdf.parse_content_stream(p), resources, 0, None, state, [1], set()
        )
        if not changed:
            raise ValueError("edit did not apply (placement not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        if state.gs_name and not state.registered_nested:
            # Top-level target: register on the page's resources — with a
            # FRESH /ExtGState subdict (the copied resources share the old
            # one by reference; mutating it is the C2 sibling-leak class).
            src_egs = resources.get("/ExtGState")
            fresh_egs = Dictionary()
            if src_egs is not None:
                for k in src_egs.keys():
                    fresh_egs[k] = src_egs[k]
            fresh_egs[Name(state.gs_name)] = pdf.make_indirect(gs_dict)
            resources["/ExtGState"] = fresh_egs
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, state.superseded_forms)
        _save(pdf, input_path, output_path)
        return {
            "output": str(output_path),
            "page": int(page),
            "index": int(index),
            "opacity": round(alpha, 4),
        }
    finally:
        try:
            pdf.close()
        except Exception:
            pass


# ── replacement image construction ────────────────────────────────────────


def _jpeg_info(data: bytes) -> tuple[int, int, int]:
    """(width, height, components) from the SOF marker. Raises ValueError on
    anything that isn't a baseline/progressive JFIF this embedder blesses."""
    if len(data) < 4 or data[0:2] != b"\xff\xd8":
        raise ValueError("not a JPEG file")
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        # Collapse 0xFF fill runs — spec-legal padding before any marker
        # (T.81 B.1.1.2); reading a fill byte as the marker code misparsed
        # the following payload bytes as a segment length (review-caught).
        while i + 1 < len(data) and data[i + 1] == 0xFF:
            i += 1
        if i + 4 > len(data):
            break
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):  # SOF0/1/2
            if i + 10 > len(data):
                raise ValueError("truncated JPEG (SOF cut short)")
            height, width = struct.unpack(">HH", data[i + 5 : i + 9])
            components = data[i + 9]
            return width, height, components
        if marker == 0xD8 or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        (seglen,) = struct.unpack(">H", data[i + 2 : i + 4])
        i += 2 + seglen
    raise ValueError("no SOF marker found (unsupported JPEG)")


def _image_from_source(pdf, source: dict):
    """Build the replacement image XObject (a pikepdf Stream) from either a
    passthrough JPEG or renderer-decoded raw pixels."""
    if "jpeg_path" in source:
        data = Path(source["jpeg_path"]).read_bytes()
        width, height, components = _jpeg_info(data)
        if components == 3:
            colorspace = Name("/DeviceRGB")
        elif components == 1:
            colorspace = Name("/DeviceGray")
        else:
            # The renderer answers this error by decoding to raw itself.
            raise ValueError(f"unsupported JPEG ({components} components); send raw pixels")
        stream = pdf.make_stream(data)
        stream["/Type"] = Name("/XObject")
        stream["/Subtype"] = Name("/Image")
        stream["/Width"] = width
        stream["/Height"] = height
        stream["/ColorSpace"] = colorspace
        stream["/BitsPerComponent"] = 8
        stream["/Filter"] = Name("/DCTDecode")
        return stream

    raw_path = source.get("raw_path")
    width = int(source.get("width", 0))
    height = int(source.get("height", 0))
    channels = int(source.get("channels", 0))
    if not raw_path or width <= 0 or height <= 0 or channels not in (3, 4):
        raise ValueError("raw source needs raw_path, width, height, channels in (3, 4)")
    data = Path(raw_path).read_bytes()
    expected = width * height * channels
    if len(data) != expected:
        raise ValueError(f"raw pixel data is {len(data)} bytes; expected {expected}")

    if channels == 4:
        # Strided slice assignment runs at C speed — a per-pixel Python loop
        # over a camera-sized image costs seconds.
        rgb = bytearray(width * height * 3)
        rgb[0::3] = data[0::4]
        rgb[1::3] = data[1::4]
        rgb[2::3] = data[2::4]
        pixel_bytes, alpha_bytes = bytes(rgb), bytes(data[3::4])
    else:
        pixel_bytes, alpha_bytes = data, None

    stream = pdf.make_stream(zlib.compress(pixel_bytes, 6))
    stream["/Type"] = Name("/XObject")
    stream["/Subtype"] = Name("/Image")
    stream["/Width"] = width
    stream["/Height"] = height
    stream["/ColorSpace"] = Name("/DeviceRGB")
    stream["/BitsPerComponent"] = 8
    stream["/Filter"] = Name("/FlateDecode")
    if alpha_bytes is not None:
        smask = pdf.make_stream(zlib.compress(alpha_bytes, 6))
        smask["/Type"] = Name("/XObject")
        smask["/Subtype"] = Name("/Image")
        smask["/Width"] = width
        smask["/Height"] = height
        smask["/ColorSpace"] = Name("/DeviceGray")
        smask["/BitsPerComponent"] = 8
        smask["/Filter"] = Name("/FlateDecode")
        stream["/SMask"] = pdf.make_indirect(smask)
    return stream


def replace_page_image(file: str, output: str, page: int, index: int, source: dict) -> dict:
    """Swap one placement's image for a new one (per-placement; CTM kept)."""
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        image_obj = _image_from_source(pdf, source)
    except Exception:
        pdf.close()
        raise
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        # Copy-on-write a page-LOCAL /Resources (the C2 review fix, applied to
        # every page-level image op): qpdf flattens inherited /Resources onto
        # each page's own dict BY REFERENCE, so registering an edit's new
        # XObject / form copies on the resolved dict would leak them into every
        # sibling page sharing it. `_copy_resources_for_write` gives a fresh
        # /XObject; existing draws resolve against the copied (shared-by-ref)
        # entries.
        resources = _copy_resources_for_write(pdf, _resolve_resources(p))
        p.obj["/Resources"] = resources
        placements = _walk_placements(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False
        )
        count = len(placements)
        if not (0 <= int(index) < count):
            raise ValueError(f"image index {index} is out of range (page has {count})")
        if placements[int(index)].get("kind") == "inline":
            # C4 v1 boundary: replacing would need inline re-encoding whose
            # value is near-zero for this rare class; delete + add covers it.
            raise ValueError(
                "an inline image cannot be replaced — delete it and add an image instead"
            )
        name_counter = [0]
        reserved: set = set()
        state = _EditState(
            int(index), "replace", _fresh_name(resources, name_counter, reserved), image_obj
        )
        kept, changed, new_forms = _rewrite(
            pdf, pikepdf.parse_content_stream(p), resources, 0, None, state, name_counter, reserved
        )
        if not changed:
            raise ValueError("edit did not apply (placement not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        if state.replacement_name in _names_drawn(kept):
            _register_xobject(pdf, resources, state.replacement_name, image_obj)
        # The superseded ORIGINAL (image or form) must not stay embedded —
        # replace previously never pruned at all (review-caught): a replaced
        # image's full bytes rode along in every output forever.
        _finalize_page_rewrite(p, kept, state.superseded_forms)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def add_page_image(file: str, output: str, page: int, rect: list, source: dict) -> dict:
    """Embed a NEW image at `rect` (Phase 9.C2) — pure authoring, no rewrite of
    existing content.

    `rect` is [x0, y0, x1, y1] in USER-space points (the drawn box). `source`
    is the SAME shape 7.1 replace takes ({jpeg_path} passthrough |
    {raw_path,width,height,channels} decoded), embedded by the SAME
    `_image_from_source`. The image is appended as `q <cm> /Name Do Q` with
    `cm` mapping the unit image square onto the box (stretch-to-box, replace's
    v1 rule), so the added image is an ORDINARY placement afterward —
    list/delete/replace/transform (C1) all see it with no special case."""
    try:
        x0, y0, x1, y1 = (float(v) for v in rect)
    except (TypeError, ValueError):
        raise ValueError("rect must be [x0, y0, x1, y1]") from None
    left, right = min(x0, x1), max(x0, x1)
    bottom, top = min(y0, y1), max(y0, y1)
    w, h = right - left, top - bottom
    if w < 1e-3 or h < 1e-3:
        raise ValueError("image box is too small")

    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        image_obj = _image_from_source(pdf, source)
    except Exception:
        pdf.close()
        raise
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]

        # Register the XObject on a page-LOCAL /Resources so the draw lands on
        # THIS page only. QPDF flattens inherited /Resources onto every page's
        # OWN dict BY REFERENCE, so a page's "own" /Resources + /XObject is
        # frequently the SAME object shared with siblings (the shared-/Pages-
        # /Resources shape this targets, and review-confirmed even for pages
        # that already have an own dict). Registering directly would leak the
        # entry into every sibling — so copy-on-write a fresh /Resources with a
        # NEW /XObject (redact.py's `_copy_resources_for_write`, the module's
        # established guard); existing content still resolves against the
        # copied (shared-by-ref) entries, and `_fresh_name` avoids them all.
        res = _copy_resources_for_write(pdf, _resolve_resources(p))
        p.obj["/Resources"] = res
        name = _fresh_name(res, [0], set())
        _register_xobject(pdf, res, name, image_obj)

        cm = [round(w, 4), 0, 0, round(h, 4), round(left, 4), round(bottom, 4)]
        content = pikepdf.unparse_content_stream(
            [_op([], "q"), _op(cm, "cm"), _do_instruction(name), _op([], "Q")]
        )
        # Shield the EXISTING content in its own q/Q (the A2 lesson): a dangling
        # `cm` in prior content must not transform our appended draw.
        p.contents_add(b"q\n", prepend=True)
        p.contents_add(b"\nQ\n" + content, prepend=False)

        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def extract_page_image(file: str, page: int, index: int, output_prefix: str) -> dict:
    """Save one placement's image bytes out (placement-independent — the
    XObject's own encoded data; pikepdf picks the natural format)."""
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        placements: list[dict] = []
        _walk_placements(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, placements, False
        )
        if not (0 <= int(index) < len(placements)):
            raise ValueError(f"image index {index} is out of range (page has {len(placements)})")
        target = placements[int(index)]
        if target.get("kind") == "inline":
            # C4 v1 boundary: inline extraction needs its own decode
            # machinery; the class is rare and the honest refusal names it.
            raise ValueError("an inline image cannot be extracted")

        # Re-walk to the owning xobject: the lister records the NAME and
        # nesting; resolve the actual object by replaying the same order.
        # Inline draws occupy listing slots (C4) — placehold them so
        # holder[index] stays aligned with the listing on mixed pages.
        holder: list = []

        def _collect(instructions, res, depth, fallback):
            for instruction in instructions:
                if str(instruction.operator) == "INLINE IMAGE":
                    holder.append(None)
                    continue
                if str(instruction.operator) != "Do" or not instruction.operands:
                    continue
                nm = str(instruction.operands[0])
                xobj = _lookup_xobject(nm, res, fallback)
                st = str(xobj.get("/Subtype", "")) if xobj is not None else ""
                if xobj is not None and st == "/Image":
                    holder.append(xobj)
                elif xobj is not None and st == "/Form" and depth < MAX_FORM_DEPTH:
                    fres = xobj.get("/Resources")
                    _collect(
                        pikepdf.parse_content_stream(xobj),
                        fres if fres is not None else res,
                        depth + 1,
                        res,
                    )

        _collect(pikepdf.parse_content_stream(p), resources, 0, None)
        xobj = holder[int(index)]
        image = pikepdf.PdfImage(xobj)
        out_path = image.extract_to(fileprefix=output_prefix)
        return {
            "output": out_path,
            "name": target["name"],
            "width": target["native_width"],
            "height": target["native_height"],
        }
