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
    pdf,
    instructions,
    resources,
    base_ctm,
    depth,
    fallback_resources,
    out,
    nested,
    base_alpha=1.0,
    base_clip=None,
    base_blend="Normal",
    base_mask=None,
):
    """Append one dict per image `Do` to `out`, in encounter order. State
    tracking is the shared GraphicsTextState (7.2 consolidation) — the same
    machine the rewriter's DFS order agreement is proven against.

    Fill alpha (the C3 opacity seed) and the blend mode (P7's seed) are
    tracked LOCALLY: the shared state machine's feed() has no resources
    access, and `gs` needs the current stream's /ExtGState to resolve — so
    both ride their own q/Q-scoped stack here, inherited into forms at
    their Do like the CTM. The open-q index stack rides alongside for
    `crop` (C3-tail): wrapper frames live in the SAME instruction list as
    their draw (nested edits wrap inside the form copy), so per-level
    recognition sees every tool frame."""
    instructions = list(instructions)
    state = GraphicsTextState(base_ctm)
    # 9-§I.0-S8: clip tracking beside the state machine — a placement wholly
    # outside the active clip lists as `clipped` (invisible) so the renderer
    # stops offering it as editable. `base_clip` is the parent's device-space
    # clip a nested form inherits (§8.10.2).
    clips = ClipTracker(base_clip)
    alpha = float(base_alpha)
    blend = str(base_blend)
    mask: dict | None = base_mask
    gs_stack: list[tuple[float, str, dict | None]] = []
    q_open: list[int] = []
    for idx, instruction in enumerate(instructions):
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        # Fed with the CURRENT ctm BEFORE state.feed (which consumes q/Q/cm).
        clips.feed(operator, operands, state.ctm)
        if operator == "q":
            gs_stack.append((alpha, blend, mask))
            q_open.append(idx)
        elif operator == "Q":
            alpha, blend, mask = (
                gs_stack.pop() if gs_stack else (float(base_alpha), str(base_blend), base_mask)
            )
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
                    entry = egs[Name(gs_name)]
                    ca = entry.get("/ca")
                    if ca is not None:
                        alpha = max(0.0, min(1.0, float(ca)))
                    bm = entry.get("/BM")
                    if bm is not None:
                        # /BM may be a name or an array of names (first wins).
                        try:
                            bm_name = (
                                str(bm[0]) if isinstance(bm, pikepdf.Array) else str(bm)
                            )
                        except (IndexError, TypeError):
                            bm_name = ""
                        if bm_name.startswith("/") and bm_name[1:] in BLEND_MODES:
                            blend = bm_name[1:]
                    sm = entry.get("/SMask")
                    if sm is not None:
                        # P7 slice E: seed OUR gradient mask; /None clears;
                        # an author's soft mask seeds nothing (mask: null —
                        # there is no tool mask to re-edit).
                        mask = None if str(sm) == "/None" else _mask_params_of(sm)
                except (TypeError, ValueError, AttributeError, KeyError):
                    pass  # malformed ExtGState: state unchanged, never abort a listing
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
                    # P7: the effective blend mode at this draw (seed).
                    "blend": blend,
                    # P7 slice E: the tool gradient mask in scope (seed).
                    "mask": mask,
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
            vector_marker = (
                xobj.get("/SpectraVector") if xobj is not None and subtype == "/Form" else None
            )
            if xobj is not None and (subtype == "/Image" or vector_marker is not None):
                # P7 slice F convergence: a MARKED vector-graphic form is a
                # LEAF placement in the same ordinal space as image draws —
                # it draws the unit square under the live CTM (BBox [0,0,1,1]
                # by construction), so every wrap-family edit applies to it
                # verbatim and the walker never recurses into it.
                x0, y0, x1, y1 = _bbox_of_rect_under_matrix(state.ctm, 1.0, 1.0)
                if vector_marker is not None:
                    try:
                        vb = [float(v) for v in vector_marker.get("/ViewBox")]
                        nw, nh = int(round(vb[2])), int(round(vb[3]))
                    except (TypeError, ValueError, IndexError):
                        nw = nh = 0
                else:
                    nw = int(xobj.get("/Width", 0))
                    nh = int(xobj.get("/Height", 0))
                out.append(
                    {
                        "index": len(out),
                        "rect": [x0, y0, x1, y1],
                        # The FULL device CTM at this Do (the unit square [0,1]²
                        # maps to the page through it). C1's transform op needs
                        # it to build the delta cm; `rect` is just its bbox.
                        "matrix": list(state.ctm),
                        "name": name,
                        "kind": "vector" if vector_marker is not None else "xobject",
                        "nested": nested,
                        "native_width": nw,
                        "native_height": nh,
                        # C3: effective fill alpha at this draw (the opacity
                        # slider's honest seed).
                        "opacity": round(alpha, 4),
                        # P7: the effective blend mode at this draw (seed).
                        "blend": blend,
                        # P7 slice E: the tool gradient mask in scope (seed).
                        "mask": mask,
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
                    base_blend=blend,
                    base_mask=mask,
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
    draws in the SAME order as the lister; applies the action at every
    ordinal in `targets` (P7: a dict — multi-select group ops run as ONE
    rewrite pass; the single-placement ops pass a one-entry dict).

    Per-target payloads carry what differs between targets (today: the
    transform delta). Safe by `_recognized_frames`' exactness: a recognized
    frame's body is exactly [prefix, inner unit, Q], so a recognized frame
    encloses exactly ONE draw — a per-target collapse/fold can never touch
    a frame that also encloses another target, and surviving open_q kept
    indices stay valid across a collapse (dropped frames are the innermost
    run, so every surviving open frame's kept position precedes them)."""

    def __init__(
        self,
        targets: dict[int, dict],
        action: str,
        replacement_name: str | None,
        pending_image=None,
        crop_rect=None,
        pending_gs=None,
        replace_fit=None,
    ):
        self.targets = dict(targets)
        # 'delete' | 'replace' | 'layers' | 'transform' | 'crop' | 'opacity'
        self.action = action
        self.replacement_name = replacement_name
        self.pending_image = pending_image
        # 'layers' only (O8/MRC): SEVERAL images drawn in order at the target's
        # own CTM, in place of the one Do. Same surgery as 'replace' — the page
        # OBJECT survives, so /Annots, /AcroForm, the structure tree, page
        # labels and bookmarks are untouched BY CONSTRUCTION rather than
        # carried back afterwards. `layer_names` is draw order (background
        # first); `layer_images` is what each name registers to.
        self.layer_names: tuple[str, ...] = ()
        self.layer_images: dict[str, object] = {}
        # 'replace' with fit="contain" (P7): a LOCAL aspect-correction matrix
        # [sx,0,0,sy,tx,ty] wrapped around the renamed draw as the RECOGNIZED
        # transform shape `q cm Do Q` — so the letterbox folds under a later
        # transform exactly like any tool frame. None = stretch (7.1 shipped
        # behavior, byte-stable).
        self.replace_fit = replace_fit
        # 'transform' only: the CURRENT target's delta matrix D, injected as
        # `q D cm Do Q` at its draw so the placement's effective CTM becomes
        # the caller's M'. Assigned per hit from the target's payload.
        self.delta = None
        # 'crop' only (C3): [cx0, cy0, cx1, cy1] in the image's UNIT space —
        # emitted as a clip path AT the draw, so it rides the same CTM as the
        # unit square at any nesting depth (no matrix math needed).
        self.crop_rect = crop_rect
        # 'transform' only (C3-tail): the intersection of the recognized crop
        # frames the collapse just dropped at the CURRENT target — re-emitted
        # as the innermost frame INSIDE the new cm, so the clip travels with
        # the move instead of staying in pre-transform space.
        self.carried_crop = None
        # 'opacity' only (C3; P7-widened): the caller's REQUEST
        # ({opacity: float|None, blend: str|None}) — the registered dict is
        # BUILT at the target draw, where the collapse has just surfaced the
        # dropped frames' state to merge under it. The NAME is allocated AT
        # the draw against the resources in scope there (a nested target
        # must never shadow the form's own /ExtGState names);
        # `registered_nested` records that a form copy took the
        # registration, so the op function skips the page level.
        self.gs_request = pending_gs
        self.pending_gs = None
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

    def take(self, ordinal: int) -> dict | None:
        """Consume and return the payload when `ordinal` is a target."""
        payload = self.targets.pop(ordinal, None)
        if payload is not None and not self.targets:
            self.done = True
        return payload

    def build_pending_gs(self, pdf, dropped: dict) -> None:
        """Compose the gs dict to register: the collapse's merged state
        under the request's explicit values (request wins per key; a mask
        request of kind "none" CLEARS a carried mask). Called at the target
        draw, before `_emit_wrap` allocates the name. `pdf` builds the
        fresh /SMask group when a mask survives the merge."""
        request = self.gs_request or {}
        ca = request.get("opacity")
        if ca is None:
            ca = dropped.get("ca")
        bm = request.get("blend")
        if bm is None:
            bm = dropped.get("bm")
        mask = request.get("mask")
        if mask is None:
            mask = dropped.get("mask")
        elif mask.get("kind") == "none":
            mask = None
        gs = Dictionary(Type=Name("/ExtGState"))
        if ca is not None:
            gs["/ca"] = round(float(ca), 4)
            gs["/CA"] = round(float(ca), 4)
        if bm is not None:
            gs["/BM"] = Name("/" + str(bm))
        if mask is not None:
            gs["/SMask"] = _build_gradient_smask(pdf, mask)
        self.pending_gs = gs

    def emit_replacement(self, kept) -> None:
        """The renamed draw, wrapped in the aspect-correction frame when
        fit="contain" asked for one (the frame is `_WRAP_SHAPES`' transform
        shape, so listings and later folds treat it as an ordinary tool
        frame)."""
        if self.action == "layers":
            # One Do per layer, all under the CTM already in force at the
            # replaced draw — every layer image is the unit square, so no
            # matrix is emitted and the placement geometry is preserved
            # exactly (the same argument the crop clip rides on).
            for nm in self.layer_names:
                kept.append(_do_instruction(nm))
            return
        if self.replace_fit is not None:
            kept.append(_op([], "q"))
            kept.append(_op([round(float(v), 6) for v in self.replace_fit], "cm"))
            kept.append(_do_instruction(self.replacement_name))
            kept.append(_op([], "Q"))
        else:
            kept.append(_do_instruction(self.replacement_name))


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
    return _intersect_crop_rects(rects)


def _collapse_for_transform(kept, instructions, t, open_q, skip_q, delta):
    """9-§I.5 P9 — the transform action's collapse: crop frames come out (to
    be re-emitted inside the new `cm`, where the clip stays in unit space)
    AND every tool-written transform frame folds into the one fresh matrix.
    Returns `(carried crop or None, folded delta)`.

    Repeatedly moving a placement used to leave a `q cm … Q` per move nested
    around the draw — ten nudges, ten frames. Folding is exact, not an
    approximation: with frames M1 (innermost) … Mk (outermost) the CTM at
    the draw is M1·M2·…·Mk·base, and the new innermost frame makes it
    delta·M1·…·Mk·base; one frame carrying `delta·M1·…·Mk` over the SAME
    base is the identical matrix. `base` never has to be known, which is
    what makes this correct at any nesting depth and inside forms.

    The OUTERMOST recognized transform frame is deliberately KEPT. It is
    almost always the document's own placement (`q 100 0 0 80 72 640 cm
    /Im0 Do Q` is how every producer draws an image), and shape alone
    cannot tell it from one of ours. Folding it would be rendering-neutral
    but would dissolve the author's structure for no gain; leaving it means
    the FIRST edit emits exactly the shape this file has always emitted,
    and the frame count stops at two instead of growing without bound.

    Deletions run in ONE reverse-ordered pass over `kept` because the kinds
    interleave: dropping an OUTER crop frame shifts every inner frame's
    recorded position, so two independent passes would delete the wrong
    entries (`_collapse_crop_frames`'s own batch is safe only because it
    sorts its removals)."""
    frames = _recognized_frames(instructions, t, [i for i, _ in open_q])
    kept_index = {i: k for i, k in open_q}
    transforms = [f for f in frames if f["kind"] == "transform"]
    outermost = transforms[-1] if transforms else None
    removals: list[int] = []
    rects: list[list[float]] = []
    composed = None
    for frame in frames:
        kept_at = kept_index.get(frame["open"])
        if kept_at is None:
            continue
        if frame["kind"] == "crop":
            removals.append(kept_at)
            rects.append(frame["rect"])
            skip_q.add(frame["close"])
        elif frame["kind"] == "transform" and frame is not outermost:
            try:
                m = tuple(float(v) for v in instructions[frame["open"] + 1].operands)
            except (TypeError, ValueError):
                m = ()
            if len(m) != 6:
                break  # unreadable: this frame and everything outside it stay
            removals.append(kept_at)
            skip_q.add(frame["close"])
            composed = m if composed is None else _mat_mult(composed, m)
    for kept_at in sorted(removals, reverse=True):
        # Every wrap shape this drops is `q` + ONE prefix op for transform,
        # `q re W n` (four) for crop.
        span = 4 if kept[kept_at + 1].operator == pikepdf.Operator("re") else 2
        del kept[kept_at : kept_at + span]
    if composed is not None:
        delta = _mat_mult(tuple(delta), composed)
    return _intersect_crop_rects(rects), delta


def _intersect_crop_rects(rects):
    """The intersection of dropped crop rects (None when none), zero-area
    when they are DISJOINT — never the raw inverted numbers, because PDF
    `re` normalizes negative extents and an inverted rect would clip to the
    region BETWEEN the crops and un-hide what both hid (round 29 HIGH)."""
    if not rects:
        return None
    ix0 = max(r[0] for r in rects)
    iy0 = max(r[1] for r in rects)
    ix1 = min(r[2] for r in rects)
    iy1 = min(r[3] for r in rects)
    if ix0 >= ix1 or iy0 >= iy1:
        return [ix0, iy0, ix0, iy0]
    return [ix0, iy0, ix1, iy1]


# The 16 standard-separable + nonseparable blend modes (§11.3.5 / 11.13.2).
BLEND_MODES = (
    "Normal",
    "Multiply",
    "Screen",
    "Overlay",
    "Darken",
    "Lighten",
    "ColorDodge",
    "ColorBurn",
    "HardLight",
    "SoftLight",
    "Difference",
    "Exclusion",
    "Hue",
    "Saturation",
    "Color",
    "Luminosity",
)


def _mask_params_of(smask) -> dict | None:
    """The P7 gradient-mask params carried by a TOOL-BUILT /SMask (the
    private /SpectraMask key on its /G form — the lossless round-trip
    record; parsing shading floats back would be archaeology). None for an
    author's soft mask, which is exactly what gates the collapse."""
    try:
        if smask is None or str(smask.get("/S", "")) != "/Luminosity":
            return None
        g = smask.get("/G")
        marker = g.get("/SpectraMask") if g is not None else None
        if marker is None:
            return None
        kind = str(marker.get("/Kind", ""))[1:].lower()
        if kind not in ("linear", "radial"):
            return None
        frm = [float(v) for v in marker.get("/From")]
        to = [float(v) for v in marker.get("/To")]
        return {
            "kind": kind,
            "from": frm,
            "to": to,
            "start_alpha": float(marker.get("/A0")),
            "end_alpha": float(marker.get("/A1")),
        }
    except Exception:
        return None


def _tool_gs_state(name, resources, fallback_resources):
    """The {ca, bm, mask} a TOOL-OWNED gs frame carries, or None when the
    frame is not provably ours. Ownership takes BOTH tests (P7 widening):
    the name is a `_fresh_gs_name` allocation (/EditGS…) AND the dict
    carries nothing beyond alpha/blend/our-mask. The old alpha-only content
    test alone stopped being enough the moment frames can carry different
    keys — dropping an author's frame whose state the fresh frame didn't
    re-emit would change the page, and shape alone can't prove authorship
    (the P9 outermost-transform lesson, applied to gs). An author's
    pure-alpha frame now simply SURVIVES with our frame nested inside — the
    inner value wins per key, so rendering is unchanged and author
    structure stays intact. An /SMask additionally requires OUR marker on
    its /G (slice E): an author's soft mask is never collapsible."""
    if not str(name).startswith("/EditGS"):
        return None
    try:
        gs = None
        for res in (resources, fallback_resources):
            if res is None:
                continue
            table = res.get("/ExtGState")
            if table is None or name not in table:
                continue
            gs = table[name]
            break
        if gs is None:
            return None
        keys = {str(k) for k in gs.keys()}
        if not keys or not keys <= {"/Type", "/ca", "/CA", "/BM", "/SMask"}:
            return None
        state: dict = {}
        ca = gs.get("/ca")
        if ca is not None:
            state["ca"] = max(0.0, min(1.0, float(ca)))
        bm = gs.get("/BM")
        if bm is not None:
            # /BM may be a name or an array of names — first entry rules.
            try:
                bm_name = str(bm[0]) if isinstance(bm, pikepdf.Array) else str(bm)
            except (IndexError, TypeError):
                bm_name = ""
            if bm_name.startswith("/"):
                state["bm"] = bm_name[1:]
        smask = gs.get("/SMask")
        if smask is not None:
            mask = _mask_params_of(smask)
            if mask is None:
                return None  # a soft mask that isn't ours: fail closed
            state["mask"] = mask
        return state
    except Exception:
        return None


def _collapse_opacity_frames(kept, instructions, t, open_q, skip_q, resources, fallback_resources):
    """9-§I.5 P9 (P7-widened) — drop the RECOGNIZED tool gs frames around
    the target so a re-set leaves ONE frame, and return their MERGED
    {ca, bm} state (innermost wins per key). The merge is the widening's
    safety proof: the fresh frame re-emits every dropped key it doesn't
    override, so collapsing can never lose rendered state (the old
    "innermost gs already won" argument only held while every frame
    carried the same key). A frame that isn't provably ours stops the
    collapse there — everything outside it stays, fail closed."""
    kept_index = {i: k for i, k in open_q}
    removals: list[int] = []
    merged: dict = {}
    for frame in _recognized_frames(instructions, t, [i for i, _ in open_q]):
        if frame["kind"] != "opacity":
            continue
        try:
            name = str(instructions[frame["open"] + 1].operands[0])
        except (IndexError, TypeError):
            break
        gs_state = _tool_gs_state(name, resources, fallback_resources)
        if gs_state is None:
            break  # fail closed: this frame and everything outside it stay
        kept_at = kept_index.get(frame["open"])
        if kept_at is None:
            continue
        removals.append(kept_at)
        skip_q.add(frame["close"])
        for key, value in gs_state.items():
            merged.setdefault(key, value)  # innermost-first: first seen wins
    for kept_at in sorted(removals, reverse=True):
        del kept[kept_at : kept_at + 2]  # the `q` and its `gs`
    return merged


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
            payload = state.take(state.seen)
            if payload is not None:
                changed = True
                if state.action == "crop":
                    _collapse_crop_frames(kept, instructions, i, open_q, skip_q)
                elif state.action == "transform":
                    # P9: crop frames come out FIRST (they re-emit inside the
                    # new cm, where the clip stays in unit space), then the
                    # transform frames fold into the one matrix about to be
                    # written — folding first would leave a dropped crop's
                    # rect measured against a space that no longer exists.
                    state.carried_crop, state.delta = _collapse_for_transform(
                        kept, instructions, i, open_q, skip_q, payload["delta"]
                    )
                elif state.action == "opacity":
                    state.build_pending_gs(
                        pdf,
                        _collapse_opacity_frames(
                            kept, instructions, i, open_q, skip_q, resources, fallback_resources
                        ),
                    )
                if state.action == "delete":
                    pass  # dropped — inline bytes live in the stream itself
                elif not _emit_wrap(
                    kept, instruction, state, resources, fallback_resources, reserved
                ):
                    # P6: replace PROMOTES the inline draw to an XObject Do —
                    # one instruction for one instruction, so every later
                    # placement keeps its counted slot, and the new image is
                    # an ordinary placement afterward (list/delete/replace/
                    # transform all see it with no special case). The old
                    # inline bytes vanish with the dropped instruction.
                    # (P7: fit="contain" wraps the promoted draw too — the
                    # frame is balanced, so the slot arithmetic is unmoved.)
                    state.emit_replacement(kept)
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
        # P7 slice F: marked vector-graphic forms are LEAF placements — they
        # occupy a counted ordinal slot exactly as the lister counts them
        # (walker agreement), take every wrap-family edit, and are never
        # recursed into. Replace refuses vectors at the op entry (kind check).
        vector_leaf = (
            subtype == "/Form" and xobj is not None and xobj.get("/SpectraVector") is not None
        )
        if xobj is not None and (subtype == "/Image" or vector_leaf):
            payload = state.take(state.seen)
            if payload is not None:
                changed = True
                if state.action == "crop":
                    _collapse_crop_frames(kept, instructions, i, open_q, skip_q)
                elif state.action == "transform":
                    # P9: see the inline-image branch — crops out first, then
                    # the transform frames fold into the one fresh matrix.
                    state.carried_crop, state.delta = _collapse_for_transform(
                        kept, instructions, i, open_q, skip_q, payload["delta"]
                    )
                elif state.action == "opacity":
                    state.build_pending_gs(
                        pdf,
                        _collapse_opacity_frames(
                            kept, instructions, i, open_q, skip_q, resources, fallback_resources
                        ),
                    )
                if state.action == "delete":
                    state.deleted_name = name
                    if vector_leaf and name:
                        # qpdf's GC drops orphaned IMAGES but leaves forms —
                        # a deleted vector graphic's form must be dropped
                        # explicitly (only when nothing still draws it; the
                        # shared-draw check is _drop_replaced_forms' rule).
                        state.superseded_forms.add(name)
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
                    state.emit_replacement(kept)
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
                if state.action == "layers":
                    # Same rule as replace, for each layer: the Do's the
                    # emit just wrote resolve against the copy holding them.
                    drawn = _names_drawn(inner_kept)
                    for nm, obj in state.layer_images.items():
                        if nm in drawn:
                            copy_res["/XObject"][Name(nm)] = pdf.make_indirect(obj)
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
                    # Sweep superseded /EditGS entries off the COPY's fresh
                    # table (the collapse just dropped their frames).
                    _sweep_orphan_edit_gs(copy, copy_res)
                # A vector-leaf DELETE inside this form: the copy's own
                # /XObject still references the dead form — drop it here
                # (page-level entries are finalize's job; qpdf GC only
                # prunes images).
                _drop_replaced_forms(
                    copy_res.get("/XObject"), _names_drawn(inner_kept), state.superseded_forms
                )
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


def _build_gradient_smask(pdf, mask: dict):
    """The /SMask dict for a P7 gradient mask: a LUMINOSITY soft mask whose
    /G is a gray Form XObject over BBox [0,0,1,1] — the wrap sits inside
    the placement's cm, so unit space IS image space and the group lands
    exactly over the drawn image at any nesting depth (the crop-clip
    argument, applied to masking). The gradient is painted with `sh`
    (current-space, placement-relative), NEVER a fill pattern — pattern
    space is page-anchored, which would pin the fade to the page while the
    image moves. The /G carries the exact request under /SpectraMask so the
    lister seeds losslessly and the collapse can re-emit it."""
    kind = mask["kind"]
    fx, fy = (float(v) for v in mask["from"])
    tx, ty = (float(v) for v in mask["to"])
    a0 = float(mask["start_alpha"])
    a1 = float(mask["end_alpha"])
    func = Dictionary(
        FunctionType=2,
        Domain=pikepdf.Array([0, 1]),
        C0=pikepdf.Array([round(a0, 4)]),
        C1=pikepdf.Array([round(a1, 4)]),
        N=1,
    )
    if kind == "linear":
        coords = pikepdf.Array([round(fx, 6), round(fy, 6), round(tx, 6), round(ty, 6)])
        shading = Dictionary(
            ShadingType=2,
            ColorSpace=Name("/DeviceGray"),
            Coords=coords,
            Function=func,
            Extend=pikepdf.Array([True, True]),
        )
    else:  # radial: from = center, |to − from| = the fade radius
        radius = ((tx - fx) ** 2 + (ty - fy) ** 2) ** 0.5
        coords = pikepdf.Array(
            [round(fx, 6), round(fy, 6), 0, round(fx, 6), round(fy, 6), round(radius, 6)]
        )
        shading = Dictionary(
            ShadingType=3,
            ColorSpace=Name("/DeviceGray"),
            Coords=coords,
            Function=func,
            Extend=pikepdf.Array([True, True]),
        )
    g = pdf.make_stream(b"/Sh0 sh")
    g["/Type"] = Name("/XObject")
    g["/Subtype"] = Name("/Form")
    g["/BBox"] = pikepdf.Array([0, 0, 1, 1])
    g["/Group"] = Dictionary(
        Type=Name("/Group"), S=Name("/Transparency"), CS=Name("/DeviceGray")
    )
    g["/Resources"] = Dictionary(Shading=Dictionary(Sh0=shading))
    g["/SpectraMask"] = Dictionary(
        Kind=Name("/Linear" if kind == "linear" else "/Radial"),
        From=pikepdf.Array([round(fx, 6), round(fy, 6)]),
        To=pikepdf.Array([round(tx, 6), round(ty, 6)]),
        A0=round(a0, 4),
        A1=round(a1, 4),
    )
    return Dictionary(S=Name("/Luminosity"), G=pdf.make_indirect(g))


def _sweep_orphan_edit_gs(content_source, resources) -> None:
    """Drop TOOL-ALLOCATED (/EditGS*) /ExtGState entries nothing references
    any more. qpdf's `remove_unreferenced_resources` leaves /ExtGState
    alone (verified — the pin that forced this sweep), so a collapse's or a
    clear's superseded entry would otherwise stay registered forever — and
    a gradient mask's entry keeps a whole Form XObject reachable, the exact
    "removed bytes still embedded" class `_finalize_page_rewrite` exists
    for. Reference collection walks the source's content stream AND every
    form reachable from `resources` (cycle-guarded, depth-bounded);
    OVER-collecting is safe (an unused name kept = no harm), so forms are
    scanned whether or not anything still draws them. The caller guarantees
    `resources`' /ExtGState is safe to mutate (page-local COW or a fresh
    form-copy dict — never a shared table, the C2 sibling rule)."""
    used: set = set()
    seen: set = set()

    def collect_stream(obj):
        try:
            for ins in pikepdf.parse_content_stream(obj):
                if str(ins.operator) == "gs" and ins.operands:
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
    try:
        egs = resources.get("/ExtGState")
    except Exception:
        return
    if egs is None:
        return
    for k in [str(k) for k in egs.keys()]:
        if k.startswith("/EditGS") and k not in used:
            del egs[Name(k)]


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


def delete_page_images(file: str, output: str, page: int, indexes: list) -> dict:
    """Remove SEVERAL image placements in ONE atomic rewrite (P7 multi-select
    group delete): one pass, one save, one undoable operation. `indexes` are
    distinct lister ordinals; per-placement semantics are identical to the
    single delete (a shared XObject drawn elsewhere is untouched, nested
    targets edit form copies, reachability GC runs once at the end)."""
    try:
        idxs = sorted({int(i) for i in (indexes or [])})
    except (TypeError, ValueError):
        raise ValueError("indexes must be a list of integers") from None
    if not idxs:
        raise ValueError("indexes must name at least one placement")
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
        for idx in idxs:
            if not (0 <= idx < count):
                raise ValueError(f"image index {idx} is out of range (page has {count})")

        state = _EditState({idx: {} for idx in idxs}, "delete", None)
        kept, changed, new_forms = _rewrite(
            pdf, pikepdf.parse_content_stream(p), resources, 0, None, state, [1], set()
        )
        if not changed or state.targets:
            raise ValueError("edit did not apply (placement not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, state.superseded_forms)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "indexes": idxs}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def delete_page_image(file: str, output: str, page: int, index: int) -> dict:
    """Remove one image placement (per-placement — see module docstring).
    Thin wrapper over the multi op: ONE implementation, no behavior drift."""
    delete_page_images(file, output, page, [int(index)])
    return {"output": str(Path(output)), "page": int(page), "index": int(index)}


def transform_page_images(file: str, output: str, page: int, targets: list) -> dict:
    """Move/resize/rotate/skew SEVERAL image placements in ONE atomic rewrite
    (P7 multi-select group transform). `targets` is [{"index": i, "matrix":
    [a,b,c,d,e,f]}, ...] — each placement's CTM is rewritten to its own
    ABSOLUTE M' exactly as the single transform does, in one pass with one
    save, so a group gesture is one undoable operation. Deltas are computed
    per target from ONE pre-rewrite walk; that stays sound because each
    wrap touches only its own draw (and `_recognized_frames`' exactness
    means no foldable frame can enclose two targets)."""
    parsed: dict[int, tuple] = {}
    for t in list(targets or []):
        if not isinstance(t, dict):
            raise ValueError("each target must be {index, matrix}")
        try:
            idx = int(t.get("index"))
        except (TypeError, ValueError):
            raise ValueError("each target needs an integer index") from None
        m = _as_matrix(t.get("matrix"))
        if m is None:
            raise ValueError("each target matrix must be [a, b, c, d, e, f]")
        if idx in parsed:
            raise ValueError(f"duplicate target index {idx}")
        parsed[idx] = m
    if not parsed:
        raise ValueError("targets must name at least one placement")
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
        for idx in parsed:
            if not (0 <= idx < len(placements)):
                raise ValueError(
                    f"image index {idx} is out of range (page has {len(placements)})"
                )
        edit_targets = {
            idx: {"delta": _mat_mult(m_target, _invert_matrix(tuple(placements[idx]["matrix"])))}
            for idx, m_target in parsed.items()
        }

        state = _EditState(edit_targets, "transform", None)
        kept, changed, new_forms = _rewrite(
            pdf, pikepdf.parse_content_stream(p), resources, 0, None, state, [1], set()
        )
        if not changed or state.targets:
            raise ValueError("edit did not apply (placement not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, state.superseded_forms)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "indexes": sorted(parsed)}
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
    transformed on a COPY of that form. Thin wrapper over the multi op —
    ONE implementation, no behavior drift."""
    if _as_matrix(matrix) is None:
        raise ValueError("matrix must be [a, b, c, d, e, f]")
    transform_page_images(file, output, page, [{"index": int(index), "matrix": matrix}])
    return {"output": str(Path(output)), "page": int(page), "index": int(index)}


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
        state = _EditState({int(index): {}}, "crop", None, crop_rect=(lo_x, lo_y, hi_x, hi_y))
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


def _validated_mask(mask) -> dict | None:
    """Normalize/validate the P7 mask request. {kind:"none"} passes through
    (an explicit clear); linear/radial need unit-space from/to (distinct
    points — a zero axis has no direction) and 0..1 alphas."""
    if mask is None:
        return None
    if not isinstance(mask, dict):
        raise ValueError("mask must be an object")
    kind = str(mask.get("kind", "")).lower()
    if kind == "none":
        return {"kind": "none"}
    if kind not in ("linear", "radial"):
        raise ValueError('mask kind must be "linear", "radial" or "none"')
    try:
        fx, fy = (float(v) for v in mask.get("from"))
        tx, ty = (float(v) for v in mask.get("to"))
        a0 = float(mask.get("start_alpha"))
        a1 = float(mask.get("end_alpha"))
    except (TypeError, ValueError):
        raise ValueError("mask needs from [x,y], to [x,y], start_alpha, end_alpha") from None
    for v in (fx, fy, tx, ty):
        if not (-0.5 <= v <= 1.5):  # unit space with a working margin
            raise ValueError("mask points are unit-space coordinates (0..1)")
    if abs(fx - tx) < 1e-6 and abs(fy - ty) < 1e-6:
        raise ValueError("mask from/to must be distinct points")
    if not (0.0 <= a0 <= 1.0 and 0.0 <= a1 <= 1.0):
        raise ValueError("mask alphas must be between 0 and 1")
    return {"kind": kind, "from": [fx, fy], "to": [tx, ty], "start_alpha": a0, "end_alpha": a1}


def set_image_opacity(
    file: str,
    output: str,
    page: int,
    index: int,
    opacity: float | None = None,
    blend: str | None = None,
    mask: dict | None = None,
) -> dict:
    """Set ONE image placement's opacity, blend mode and/or gradient soft
    mask (Phase 9.C3; P7 adds `blend` + `mask`). The draw is wrapped as
    `q /EditGSn gs Do Q` with a page-local (or form-copy-local, for a
    nested target) /ExtGState carrying `/ca`+`/CA`, `/BM` and/or a
    luminosity /SMask (image-unit-space gradient; see
    `_build_gradient_smask`). A re-set collapses the tool's own earlier
    frames and MERGES their state under the new values, so one frame always
    carries the placement's full alpha+blend+mask and nothing set earlier
    is lost; `mask={"kind": "none"}` explicitly clears a carried mask.
    Non-destructive and per-placement; the gs name is allocated against the
    resources in scope at the draw so it can never shadow an existing
    entry."""
    mask_req = _validated_mask(mask)
    if opacity is None and blend is None and mask_req is None:
        raise ValueError("at least one of opacity / blend / mask is required")
    alpha = None
    if opacity is not None:
        try:
            alpha = float(opacity)
        except (TypeError, ValueError):
            raise ValueError("opacity must be a number between 0 and 1") from None
        if not (0.0 <= alpha <= 1.0):
            raise ValueError("opacity must be between 0 and 1")
    if blend is not None and blend not in BLEND_MODES:
        raise ValueError(
            "blend must be one of: " + ", ".join(BLEND_MODES)
        )
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
        state = _EditState(
            {int(index): {}},
            "opacity",
            None,
            pending_gs={"opacity": alpha, "blend": blend, "mask": mask_req},
        )
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
            fresh_egs[Name(state.gs_name)] = pdf.make_indirect(state.pending_gs)
            resources["/ExtGState"] = fresh_egs
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        if state.gs_name and not state.registered_nested:
            # The collapse superseded earlier /EditGS entries; the fresh
            # page-local table is safe to sweep (never the shared one).
            _sweep_orphan_edit_gs(p, resources)
        _finalize_page_rewrite(p, kept, state.superseded_forms)
        _save(pdf, input_path, output_path)
        result = {"output": str(output_path), "page": int(page), "index": int(index)}
        if alpha is not None:
            result["opacity"] = round(alpha, 4)
        if blend is not None:
            result["blend"] = blend
        if mask_req is not None:
            result["mask"] = mask_req
        return result
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


def _contain_fit_matrix(matrix, img_w: int, img_h: int):
    """The LOCAL letterbox matrix [sx,0,0,sy,tx,ty] that fits an img_w×img_h
    image inside the placement box drawn by `matrix`, aspect preserved and
    centered (P7 fit="contain"). The drawn box's proportions are the CTM's
    column lengths |(a,b)| × |(c,d)| — rotation/skew-honest, since a local
    scale composes inside whatever orientation the CTM applies. Returns None
    (= keep stretch) when nothing sane exists: a degenerate box or image, or
    an aspect already matching."""
    try:
        a, b, c, d, _e, _f = (float(v) for v in matrix)
    except (TypeError, ValueError):
        return None
    box_w = (a * a + b * b) ** 0.5
    box_h = (c * c + d * d) ** 0.5
    if box_w < 1e-9 or box_h < 1e-9 or img_w <= 0 or img_h <= 0:
        return None
    img_aspect = img_w / img_h
    sx, sy = 1.0, 1.0
    sy_for_full_width = box_w / (box_h * img_aspect)
    if sy_for_full_width <= 1.0:
        sy = sy_for_full_width  # image proportionally wider: pillar the height
    else:
        sx = (box_h * img_aspect) / box_w  # proportionally taller: box the width
    if abs(sx - 1.0) < 1e-6 and abs(sy - 1.0) < 1e-6:
        return None  # aspects already agree — no frame needed
    return (sx, 0.0, 0.0, sy, (1.0 - sx) / 2.0, (1.0 - sy) / 2.0)


def replace_page_image(
    file: str, output: str, page: int, index: int, source: dict, fit: str = "stretch"
) -> dict:
    """Swap one placement's image for a new one (per-placement; CTM kept).
    P7: fit="contain" letterboxes the new image inside the old box (aspect
    preserved, centered) via a recognized transform frame; the default
    "stretch" is the 7.1 shipped behavior, byte-stable."""
    if fit not in ("stretch", "contain"):
        raise ValueError('fit must be "stretch" or "contain"')
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
        if placements[int(index)].get("kind") == "vector":
            raise ValueError(
                "a vector graphic placement cannot be replaced with a raster image; "
                "delete it and add a new graphic"
            )
        name_counter = [0]
        reserved: set = set()
        replace_fit = (
            _contain_fit_matrix(
                placements[int(index)]["matrix"],
                int(image_obj["/Width"]),
                int(image_obj["/Height"]),
            )
            if fit == "contain"
            else None
        )
        state = _EditState(
            {int(index): {}},
            "replace",
            _fresh_name(resources, name_counter, reserved),
            image_obj,
            replace_fit=replace_fit,
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


def replace_placement_with_layers(pdf, page, index: int, layers: list) -> list[str]:
    """Replace ONE image placement's `Do` with SEVERAL draws at the same CTM.

    The MRC assembly primitive (O8 § 3.4), and deliberately the ONLY thing in
    this module that takes an already-open `Pdf`: an MRC run rewrites every
    scanned page of a document in ONE open/save pair, so the file-in/file-out
    shape every other op here has would force a re-open per page.

    WHAT THIS BUYS, stated because it is the reason MRC is surgery and not a
    rebuild: the page OBJECT survives. Only its content stream and its own
    /Resources change, so /Annots (links, comments, widgets), /AcroForm and
    its field tree, /StructTreeRoot and the marked-content ids the drawn
    layers now sit inside, /PieceInfo, page labels and the outline all carry
    through untouched — there is nothing to re-attach afterwards, which is
    what `compress`'s gs branch has to do and cannot do for structure.

    `layers` are image XObject STREAMS already made in `pdf`, in draw order
    (background first). Each is drawn as the unit square under the CTM the
    replaced placement had, so the geometry is preserved exactly. Returns the
    names allocated, in the same order.
    """
    if not layers:
        raise ValueError("a layered replacement needs at least one layer image")
    resources = _copy_resources_for_write(pdf, _resolve_resources(page))
    page.obj["/Resources"] = resources
    placements = _walk_placements(
        pdf, pikepdf.parse_content_stream(page), resources, IDENTITY, 0, None, [], False
    )
    count = len(placements)
    if not (0 <= int(index) < count):
        raise ValueError(f"image index {index} is out of range (page has {count})")
    name_counter = [0]
    reserved: set = set()
    names = [_fresh_name(resources, name_counter, reserved) for _ in layers]
    state = _EditState({int(index): {}}, "layers", None)
    state.layer_names = tuple(names)
    state.layer_images = dict(zip(names, layers))
    kept, changed, new_forms = _rewrite(
        pdf, pikepdf.parse_content_stream(page), resources, 0, None, state, name_counter, reserved
    )
    if not changed:
        raise ValueError("edit did not apply (placement not found)")
    for nm, st in new_forms.items():
        _register_xobject(pdf, resources, nm, st)
    page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
    drawn = _names_drawn(kept)
    for nm, obj in zip(names, layers):
        if nm in drawn:
            _register_xobject(pdf, resources, nm, obj)
    # The superseded scan image must not stay embedded — the whole point of
    # the pass is that its bytes are gone, not merely undrawn.
    _finalize_page_rewrite(page, kept, state.superseded_forms)
    return names


def _resolve_placement_box(p, left, bottom, w, h, at, fit, natural_w, natural_h):
    """The final user-space box for an ADD placement — shared by raster and
    vector adds so the two can never drift (P7 slice F). `rect` mode arrives
    as (left,bottom,w,h); fit="contain" shrinks the box around its center to
    the natural aspect. `at` mode is the natural-size click-place: natural
    units as points (1px/1 viewBox unit = 1pt), centered on the click,
    scaled DOWN (never up) to fit the page's visible box and shifted
    inside it."""
    if at is None:
        if fit == "contain" and natural_w > 0 and natural_h > 0:
            box_aspect = w / h
            nat_aspect = natural_w / natural_h
            if nat_aspect > box_aspect:
                new_h = w / nat_aspect
                bottom += (h - new_h) / 2.0
                h = new_h
            elif nat_aspect < box_aspect:
                new_w = h * nat_aspect
                left += (w - new_w) / 2.0
                w = new_w
        return left, bottom, w, h
    try:
        ax, ay = (float(v) for v in at)
    except (TypeError, ValueError):
        raise ValueError("at must be [x, y]") from None
    if natural_w <= 0 or natural_h <= 0:
        raise ValueError("image has no natural size")
    # The page's visible box (CropBox falls back to MediaBox).
    crop = p.obj.get("/CropBox", p.obj.get("/MediaBox"))
    try:
        pcx0, pcy0, pcx1, pcy1 = (float(v) for v in crop)
    except (TypeError, ValueError):
        pcx0, pcy0, pcx1, pcy1 = 0.0, 0.0, 612.0, 792.0
    page_w = abs(pcx1 - pcx0)
    page_h = abs(pcy1 - pcy0)
    scale = min(1.0, page_w / natural_w, page_h / natural_h)
    w = natural_w * scale
    h = natural_h * scale
    left = ax - w / 2.0
    bottom = ay - h / 2.0
    # Shift inside the visible box (the click may hug an edge).
    lo_x, hi_x = min(pcx0, pcx1), max(pcx0, pcx1)
    lo_y, hi_y = min(pcy0, pcy1), max(pcy0, pcy1)
    left = min(max(left, lo_x), hi_x - w)
    bottom = min(max(bottom, lo_y), hi_y - h)
    return left, bottom, w, h


def add_page_image(
    file: str,
    output: str,
    page: int,
    rect: list | None = None,
    source: dict | None = None,
    fit: str = "stretch",
    at: list | None = None,
) -> dict:
    """Embed a NEW image (Phase 9.C2; P7 widened) — pure authoring, no rewrite
    of existing content.

    Placement is ONE of:
      - `rect` = [x0, y0, x1, y1] USER-space points (the drawn box). With the
        default fit="stretch" the unit image square maps onto the box exactly
        (the 7.1 rule, byte-stable); fit="contain" first shrinks the box
        around its center to the source's aspect, so nothing distorts.
      - `at` = [x, y]: natural-size click-place — the image lands at its own
        pixel dimensions in points (1px = 1pt, the 72-dpi identity), centered
        on the click, scaled DOWN (never up) to fit the page's visible box
        and shifted inside it.

    `source` is the SAME shape 7.1 replace takes ({jpeg_path} passthrough |
    {raw_path,width,height,channels} decoded), embedded by the SAME
    `_image_from_source`. The image is appended as `q <cm> /Name Do Q`, so
    the added image is an ORDINARY placement afterward —
    list/delete/replace/transform all see it with no special case."""
    if fit not in ("stretch", "contain"):
        raise ValueError('fit must be "stretch" or "contain"')
    if (rect is None) == (at is None):
        raise ValueError("exactly one of rect / at is required")
    if source is None:
        raise ValueError("source is required")
    left = bottom = w = h = 0.0
    if rect is not None:
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
        left, bottom, w, h = _resolve_placement_box(
            p,
            left,
            bottom,
            w,
            h,
            at,
            fit,
            int(image_obj["/Width"]),
            int(image_obj["/Height"]),
        )

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


def add_page_vector_graphic(
    file: str,
    output: str,
    page: int,
    rect: list | None = None,
    svg_path: str | None = None,
    fit: str = "contain",
    at: list | None = None,
) -> dict:
    """Place an SVG as REAL vector content (P7 slice F) — compiled by
    `engine.svg_pdf` into a unit-square Form XObject and appended as
    `q cm /Name Do Q`, so the placed graphic is an ordinary PLACEMENT
    afterward: list/transform/skew/delete/opacity/blend/mask/crop all apply
    verbatim (kind "vector"; replace/extract refuse by name). Placement
    geometry is the raster add's exact arithmetic (`_resolve_placement_box`
    — contain by default since a vector's aspect IS its meaning; `at` =
    natural size, one viewBox unit per point). Refusals from the compiler
    (`SvgUnsupported`) surface verbatim — they name what the file uses."""
    from engine.svg_pdf import compile_svg

    if fit not in ("stretch", "contain"):
        raise ValueError('fit must be "stretch" or "contain"')
    if (rect is None) == (at is None):
        raise ValueError("exactly one of rect / at is required")
    if not svg_path:
        raise ValueError("svg_path is required")
    svg_bytes = Path(svg_path).read_bytes()
    left = bottom = w = h = 0.0
    if rect is not None:
        try:
            x0, y0, x1, y1 = (float(v) for v in rect)
        except (TypeError, ValueError):
            raise ValueError("rect must be [x0, y0, x1, y1]") from None
        left, right = min(x0, x1), max(x0, x1)
        bottom, top = min(y0, y1), max(y0, y1)
        w, h = right - left, top - bottom
        if w < 1e-3 or h < 1e-3:
            raise ValueError("placement box is too small")

    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        form, view_w, view_h = compile_svg(pdf, svg_bytes)
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        left, bottom, w, h = _resolve_placement_box(
            p, left, bottom, w, h, at, fit, view_w, view_h
        )

        # Page-local /Resources copy-on-write — the add_page_image rationale
        # verbatim (the C2 sibling-leak rule).
        res = _copy_resources_for_write(pdf, _resolve_resources(p))
        p.obj["/Resources"] = res
        name = _fresh_name(res, [0], set())
        _register_xobject(pdf, res, name, form)

        cm = [round(w, 4), 0, 0, round(h, 4), round(left, 4), round(bottom, 4)]
        content = pikepdf.unparse_content_stream(
            [_op([], "q"), _op(cm, "cm"), _do_instruction(name), _op([], "Q")]
        )
        # Shield the EXISTING content in its own q/Q (the A2 lesson).
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
        if target.get("kind") == "vector":
            raise ValueError(
                "a vector graphic placement has no image bytes to extract"
            )

        # Re-walk to the owning object: the lister records the NAME and
        # nesting; resolve the actual object by replaying the same order.
        # Inline draws occupy listing slots (C4) and carry their own image
        # object (P6 — pikepdf's PdfInlineImage), so holder[index] stays
        # aligned with the listing on mixed pages AND inline targets extract.
        # P7: marked vector forms occupy their counted slot too (never a
        # valid extract target — refused above — but later indexes shift
        # without the placeholder).
        holder: list = []

        def _collect(instructions, res, depth, fallback):
            for instruction in instructions:
                if str(instruction.operator) == "INLINE IMAGE":
                    holder.append(instruction.iimage)
                    continue
                if str(instruction.operator) != "Do" or not instruction.operands:
                    continue
                nm = str(instruction.operands[0])
                xobj = _lookup_xobject(nm, res, fallback)
                st = str(xobj.get("/Subtype", "")) if xobj is not None else ""
                if xobj is not None and st == "/Image":
                    holder.append(xobj)
                elif xobj is not None and st == "/Form":
                    if xobj.get("/SpectraVector") is not None:
                        holder.append(xobj)  # counted slot, not extractable
                    elif depth < MAX_FORM_DEPTH:
                        fres = xobj.get("/Resources")
                        _collect(
                            pikepdf.parse_content_stream(xobj),
                            fres if fres is not None else res,
                            depth + 1,
                            res,
                        )

        if target.get("kind") == "inline":
            # P6: qpdf's own inline→XObject externalization (min_size=0 —
            # inline images are small BY nature; a size floor here would
            # re-refuse the exact class this serves) rewrites the draw as an
            # ordinary /Do in the SAME slot, so the collection below finds a
            # real stream there and the standard extraction takes over —
            # natural format picking included. The mutation lives on this
            # PRIVATE read-only open; nothing saves it.
            p.externalize_inline_images(min_size=0)
            resources = _resolve_resources(p)  # the new /XObject entry lives here
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
