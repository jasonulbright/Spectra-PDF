"""True content redaction: strip text and images under a region from the
actual content stream, then paint a black box over it — not just an overlay.

Approach (per page, per requested region):
  1. Walk the page's content stream, tracking the graphics state (CTM via
     q/Q/cm) and text state (Tm/Td/TD/T*/TL/Tf via BT..ET) closely enough to
     compute the axis-aligned bounding box of every text-showing operator
     (Tj/TJ/'/") and every directly-placed raster image (Do).
     Text is MEASURED THROUGH ITS FONT (`text_metrics.py`, shared with the
     text-run lister): real glyph advances plus TJ kerns, Tc, Tw and Tz, and
     a vertical extent taken from the font's own descriptor. Flat per-byte
     estimates under-cover single-byte fonts and over-cover multi-byte CID
     fonts, causing false negatives or unrelated text removal. Where the font
     cannot measure a run
     (no font resolvable, a refused capability, or a code whose advance is
     only a placeholder) the bbox falls WIDE — 1 em per code — because
     over-removal is the tolerable error for a redaction tool and a narrow
     guess is not.
  2. An image or vector instruction whose bbox intersects ANY requested region
     is dropped entirely from the rebuilt stream (not blanked, not made
     invisible — removed from the instruction list that gets re-serialized).
     A TEXT instruction is SPLIT: the codes whose own boxes meet
     a region go, the rest are re-emitted from the original bytes, and each
     removed stretch becomes a TJ jump carrying exactly the advance it had, so
     every surviving character stays where it was. Removing whole operators
     instead meant marking one name inside a line a generator emitted as a
     single `Tj` deleted the entire line — over-removal the user can see, and
     the dominant shape once marks are word-sized. A run that cannot be
     measured (see 1) still goes whole, and says so in `runs_removed_whole`.
  3. Form XObjects (`Do` on a /Subtype /Form) whose PLACED /BBox intersects a
     region are descended into recursively: a redacted COPY of the form is
     built (intersecting text/images removed, orphaned image resources pruned
     from the copy so their bytes are genuinely gone), registered under a
     fresh name, and this page's `Do` is rewritten to the copy. The ORIGINAL
     form is left intact so other pages/placements that reference it are
     unaffected; it drops out of the saved file if nothing else references it.
  4. A black-filled rectangle is painted over each region on top of the
     rebuilt content, so the redaction is visually obvious even where no
     text/image actually needed stripping.
  5. Annotations whose /Rect intersects a region are removed from /Annots (a
     FreeText/stamp/etc. whose visible box overlaps the mark would otherwise
     survive — content-stream stripping never touches annotation appearances).
  6. `page.remove_unreferenced_resources()` drops the now-orphaned page-level
     image XObjects (and the original forms we replaced) so their bytes aren't
     just invisible but genuinely absent from the saved file.

Remaining limitations (documented; over-redaction, never under-redaction):
  - A glyph's bbox is its ADVANCE box. Ink can overhang the advance by a side
    bearing (an italic `f`, a swash), so a region touching ONLY that overhang
    and no part of the advance box does not remove the glyph. Bounding each
    glyph by the font's /FontBBox instead would be exact and useless — for
    Helvetica that box is 1.166 em wide, four times the advance of an `i`, so
    every mark would take several neighbouring glyphs with it.
  - Form-XObject recursion is depth-capped (MAX_FORM_DEPTH). Beyond the cap an
    intersecting `Do` is DROPPED WHOLE (over-redaction, safe) rather than left
    intact. Only reachable on pathological/cyclic nesting; real documents do
    not nest anywhere near that deep.
"""

import shutil
import tempfile
from pathlib import Path
from typing import NamedTuple

import pikepdf
from pikepdf import Name

from engine.pdf_tree import walk_inheritable
from engine.content_walk import (
    IDENTITY,
    ClipTracker,
    GraphicsTextState,
    Matrix,
    Rect,
    as_matrix,
    bbox_of_corners_under_matrix,
    bbox_of_rect_under_matrix,
    mat_mult,
    transform_point,
)
from engine.text_metrics import (
    _child_state,
    _FontCache,
    _run_metrics,
    cluster_span,
    measurable,
    show_bytes,
    show_clusters,
    show_items,
    wide_width,
)

# Depth cap for Form-XObject recursion — only there to terminate on malformed
# cyclic forms; real documents never approach it.
MAX_FORM_DEPTH = 16

# Matrix/bbox helpers live in content_walk.py (the one-interpreter
# consolidation) — these aliases keep this module's established names (and
# page_images.py's imports) stable.
_mat_mult = mat_mult
_transform_point = transform_point
_bbox_of_rect_under_matrix = bbox_of_rect_under_matrix
_bbox_of_corners_under_matrix = bbox_of_corners_under_matrix
_as_matrix = as_matrix


def _normalize_rect(rect: list[float]) -> Rect:
    x0, y0, x1, y1 = rect
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _intersects(a: Rect, b: Rect) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _intersects_any(bbox: Rect, regions: list[Rect]) -> bool:
    return any(_intersects(bbox, r) for r in regions)


def _lookup_xobject(name, resources, fallback_resources):
    """Resolve a /Do XObject name against this stream's resources, then the
    invoker's resources as a lenient per-name fallback (a form whose own
    /Resources omits a single name). Returns the XObject or None."""
    if not name:
        return None
    for res in (resources, fallback_resources):
        if res is None:
            continue
        xod = res.get("/XObject")
        if xod is not None:
            obj = xod.get(Name(name))
            if obj is not None:
                return obj
    return None


def _resolve_resources(page: "pikepdf.Page"):
    """Resources are inheritable via the page tree — a page dict lacking its
    own /Resources takes it from the nearest ancestor /Pages node that has
    one (common output from generators that put a single shared /Resources
    on the /Pages node rather than duplicating it per page). `page.get` only
    ever sees the page's OWN dict, so relying on it alone silently treats
    such a page as having no XObjects at all — a false negative (an image
    that should have been redacted, wasn't), the one failure direction this
    module can't tolerate. The walk itself is shared with watermark.py via
    pdf_tree.walk_inheritable."""
    resources = walk_inheritable(page, "/Resources")
    return resources if resources is not None else {}


def _span_bbox(
    combined: Matrix,
    x0: float,
    x1: float,
    vertical: bool,
    state: GraphicsTextState,
    ink: tuple[float, float],
) -> Rect:
    """The device-space box of a stretch of one show operator's INK.

    Horizontal: the stretch runs from `x0` to `x1` along the pen's sweep
    (pre-Tz text space, scaled here), and the ink reaches `below` under the
    baseline and `above` over it — the font's own descent/ascent, not the em
    box. `Ts` (rise) lifts it.

    Vertical: the run occupies one em-wide column centred on the pen
    and spans its advance sum DOWNWARD, the lister's convention; Tz never
    applies vertically.
    """
    below, above = ink
    size = max(state.font_size, 0.01)
    if vertical:
        half = size / 2.0
        lo, hi = min(x0, x1), max(x0, x1)
        if hi - lo < 0.01:
            hi = lo + 0.01
        return _bbox_of_corners_under_matrix(combined, -half, -hi, half, -lo)
    lo, hi = sorted((x0 * state.h_scale, x1 * state.h_scale))
    if hi - lo < 0.01:
        hi = lo + 0.01
    y0 = state.rise - below * size
    y1 = state.rise + above * size
    if y1 - y0 < 0.01:
        y1 = y0 + 0.01
    return _bbox_of_corners_under_matrix(combined, lo, y0, hi, y1)


def _run_bbox(
    combined: Matrix,
    raw_width: float,
    slack: float,
    vertical: bool,
    state: GraphicsTextState,
    ink: tuple[float, float],
) -> Rect:
    """The whole run's box. `slack` grows it BACKWARD by however far an earlier
    unmeasurable run on this line may have over-advanced (upward, vertically)."""
    if vertical:
        return _span_bbox(combined, -slack, max(raw_width, 0.01), True, state, ink)
    return _span_bbox(
        combined, -slack / max(state.h_scale, 1e-9), raw_width, False, state, ink
    )


def _merge_tj_parts(parts: list) -> list:
    """Collapse a TJ operand list: adjacent strings concatenate, adjacent
    numbers add, and a zero number drops. Byte-for-byte equivalent to the
    unmerged form and much easier to read in a dumped stream."""
    out: list = []
    for part in parts:
        if isinstance(part, bytes):
            if out and isinstance(out[-1], bytes):
                out[-1] = out[-1] + part
            else:
                out.append(part)
            continue
        if out and isinstance(out[-1], float):
            out[-1] = out[-1] + part
        else:
            out.append(float(part))
    return [p for p in out if not (isinstance(p, float) and abs(p) < 1e-9)]


def _state_only_instructions(operator: str, operands: list) -> list:
    """The state side effects of a show operator that is being removed WHOLE.
    `'` is `T* Tj` and `"` is `aw Tw ac Tc T* Tj`, so dropping either outright
    swallowed a line advance and moved every following line up the page."""
    out: list = []
    if operator == '"' and len(operands) >= 3:
        out.append(pikepdf.ContentStreamInstruction([operands[0]], pikepdf.Operator("Tw")))
        out.append(pikepdf.ContentStreamInstruction([operands[1]], pikepdf.Operator("Tc")))
    if operator in ("'", '"'):
        out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("T*")))
    return out


def _split_instructions(
    operator: str,
    operands: list,
    items: list,
    clusters: list,
    removed: set,
    state: GraphicsTextState,
) -> list:
    """Re-emit a show operator with the marked clusters GONE and every
    surviving glyph still where it was.

    Each removed cluster becomes ONE TJ number carrying exactly the advance it
    contributed, so the pen arrives at the next surviving glyph at the same
    place it always did — `-N/1000 × Tfs` is the displacement a TJ number
    makes, and Tz multiplies that and the glyph advances alike, so it cancels.
    Tc and Tw ride INSIDE the removed advance and are absorbed by the number;
    surviving glyphs keep their own because their own bytes are re-shown.

    The surviving bytes are SLICED from the original operands, never
    re-encoded: a round trip through decode/encode could substitute a
    different code for the same character (the ligature table is filtered
    to unambiguous inverses, so it cannot be relied on to give a byte back),
    and there is nothing to gain from asking.

    `'` and `"` are expanded to their spec equivalences first (T*, and the
    `aw Tw ac Tc` prefix) so their state side effects outlive the rewrite —
    dropping a `'` outright, as the whole-run path did, silently swallowed the
    line advance and shifted every following line up the page.
    """
    out: list = []
    if operator == '"' and len(operands) >= 3:
        out.append(pikepdf.ContentStreamInstruction([operands[0]], pikepdf.Operator("Tw")))
        out.append(pikepdf.ContentStreamInstruction([operands[1]], pikepdf.Operator("Tc")))
    if operator in ("'", '"'):
        out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("T*")))

    parts: list = []
    for index, cluster in enumerate(clusters):
        if index in removed:
            total = sum(items[i].advance for i in cluster)
            parts.append(-total * 1000.0 / state.font_size)
            continue
        for i in cluster:
            item = items[i]
            parts.append(item.number if item.kern else item.data)

    merged = _merge_tj_parts(parts)
    array = pikepdf.Array(
        [
            pikepdf.String(p) if isinstance(p, bytes) else round(p, 6)
            for p in merged
        ]
    )
    out.append(pikepdf.ContentStreamInstruction([array], pikepdf.Operator("TJ")))
    return out


class WalkResult(NamedTuple):
    kept: list
    text_runs_removed: int
    text_runs_split: int  # runs that lost SOME codes and kept the rest
    runs_removed_whole: int  # runs removed entire because they could not be split
    images_removed: int
    dropped_image_names: set
    surviving_image_names: set
    new_forms: dict  # name(str) -> redacted form Stream to register in this scope
    replaced_form_names: set  # original form names whose Do was rewritten/dropped
    forms_dropped_at_cap: int  # intersecting form Dos dropped whole at the depth cap


def _do_instruction(name: str):
    return pikepdf.ContentStreamInstruction([Name(name)], pikepdf.Operator("Do"))


def _existing_xobject_names(resources) -> set:
    xo = resources.get("/XObject") if resources is not None else None
    return {str(k) for k in xo.keys()} if xo is not None else set()


def _new_form_name(name_counter: list, taken: set) -> str:
    while True:
        name = f"/RdxFm{name_counter[0]}"
        name_counter[0] += 1
        if name not in taken:
            taken.add(name)
            return name


def _walk(
    pdf: "pikepdf.Pdf",
    instructions,
    resources,
    regions: list[Rect],
    base_ctm: Matrix,
    depth: int,
    name_counter: list,
    fonts: "_FontCache",
    parent_state: "GraphicsTextState | None" = None,
    fallback_resources=None,
) -> WalkResult:
    """Redact one content-stream instruction list, recursing into Form
    XObjects. `base_ctm` is the device CTM in effect at the start of this
    stream (IDENTITY for a page; form-matrix∘Do-CTM for a form), so every
    computed bbox is in page/device space where `regions` live.
    `parent_state` is the text state in effect at the invoking `Do` (text
    state — font, size, leading, Tz, Tc/Tw, Ts — is part of the graphics state
    a form inherits; `_child_state` is the shared inheritance rule the lister
    uses). `fonts` is the per-call capability cache; `fallback_resources` are
    the invoker's resources, consulted for an XObject name a form's own
    /Resources omits (a lenient per-name fallback)."""
    # The state machine lives in content_walk.GraphicsTextState (the
    # one-interpreter consolidation): q/Q save/restore CTM AND text-state
    # parameters — all elements of the graphics state per the PDF spec;
    # restoring only the CTM left a stale font size after `q .. Tf .. Q`,
    # under-sizing a later bbox → an under-redaction leak (that comment and
    # its fix now live in the shared machine).
    state = _child_state(base_ctm, parent_state)

    # ── clip tracking (for `sh`) ──────────────────────────────────────────
    # `sh` paints a shading across the CURRENT CLIP, so bounding it needs the
    # clip — which the shared GraphicsTextState does not track. Without this
    # an `sh` fell through to the final `else` and was kept, the third leak of
    # the same family as the inline-image one.
    #
    # The tracker (originally local here) is now the shared
    # `content_walk.ClipTracker` — this module is its regression
    # harness. FRESH per stream (base_clip default None = unbounded): a form's
    # `sh` then "covers everything" and is removed, redaction's safe
    # over-removal direction. `clips.clip is None` means the shading covers the
    # whole page, so it genuinely covers any region and MUST go — correctness,
    # not over-removal.
    clips = ClipTracker()

    # How far the pen position may LAG what we have tracked, in scaled
    # text-space units, accumulated since the last repositioning operator.
    # A run whose font cannot measure it advances the text matrix by the WIDE
    # estimate, so everything after it on the same line may really sit up to
    # that much to the LEFT of where the walk thinks. Rather than pretend, the
    # following runs' boxes are grown leftward by the accumulated slack — the
    # same fail-wide direction as the width itself. Any operator that re-anchors
    # the pen (Td/TD/Tm/T*/BT/'/") clears it, because the position then comes
    # from the line matrix rather than from an accumulated advance.
    slack = 0.0

    kept: list = []
    text_runs_removed = 0
    text_runs_split = 0
    runs_removed_whole = 0
    images_removed = 0
    dropped_image_names: set = set()
    surviving_image_names: set = set()
    new_forms: dict = {}
    replaced_form_names: set = set()
    forms_dropped_at_cap = 0
    taken_names = _existing_xobject_names(resources)

    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)

        # Clip bookkeeping rides alongside the shared state machine (fed with
        # the CURRENT ctm, BEFORE state.feed applies this op's own effect —
        # path-point ops never move the CTM, so pre-feed ctm is correct): q/Q
        # save/restore the clip, W/W* arm it until the path-ending op.
        clips.feed(operator, operands, state.ctm)

        if operator in ("Td", "TD", "Tm", "T*", "BT", "ET"):
            slack = 0.0

        if state.feed(operator, operands):
            kept.append(instruction)
        elif operator == "sh":
            # A shading paints the current clip. Unclipped (`clip is None`) it
            # covers the page, so it covers every region — remove it.
            if clips.clip is None or _intersects_any(clips.clip, regions):
                images_removed += 1
            else:
                kept.append(instruction)
        elif operator in ("Tj", "'", '"', "TJ"):
            # ' and " implicitly advance to the next line BEFORE showing, and
            # " sets Tw/Tc BEFORE showing — both affect this run's own width.
            if operator in ("'", '"'):
                state.next_line()
                slack = 0.0
                if operator == '"' and len(operands) >= 2:
                    try:
                        state.word_spacing = float(operands[0])
                        state.char_spacing = float(operands[1])
                    except (TypeError, ValueError):
                        pass
            cap = fonts.capability(resources, fallback_resources, state.font_name)
            data = show_bytes(operator, operands)
            measured = measurable(cap, data)
            if measured:
                _text, raw_width = _run_metrics(operator, operands, cap, state)
            else:
                raw_width = wide_width(operator, operands, cap, state)
            # `writes_vertical`, not `vertical`: a REFUSED Identity-V font
            # still draws its column downward, and measuring it on the
            # horizontal axis would leave that column unprotected.
            vertical = bool(cap is not None and cap.writes_vertical)
            combined = _mat_mult(state.tm, state.ctm)
            ink = fonts.ink_extent(resources, fallback_resources, state.font_name)
            bbox = _run_bbox(combined, raw_width, slack, vertical, state, ink)
            if not _intersects_any(bbox, regions):
                kept.append(instruction)
            else:
                # Keep the codes OUTSIDE the region and drop the ones
                # inside. Whole-operator removal turned a mark on one name into
                # the loss of the whole line a generator happened to emit as one
                # Tj — over-removal the user can see, and the dominant shape once
                # marks come from a search rather than a hand-drawn band.
                emitted = None
                if measured and state.font_size > 0 and slack == 0.0:
                    items = show_items(operator, operands, cap, state)
                    clusters = show_clusters(items)
                    removed_clusters = {
                        index
                        for index, cluster in enumerate(clusters)
                        if _intersects_any(
                            _span_bbox(
                                combined, *cluster_span(items, cluster),
                                vertical, state, ink,
                            ),
                            regions,
                        )
                    }
                    if removed_clusters:
                        emitted = _split_instructions(
                            operator, operands, items, clusters,
                            removed_clusters, state,
                        )
                        if len(removed_clusters) < len(clusters):
                            text_runs_split += 1
                    else:
                        # The run's box meets a region but no GLYPH does — the
                        # mark sits in a kerning gap. Nothing to remove.
                        kept.append(instruction)
                        emitted = []
                if emitted is None:
                    # Unmeasurable (or the slack has already blurred where this
                    # run sits): the whole operator goes, the over-removing
                    # direction, counted so the result says it happened. The
                    # ADVANCE cannot be preserved — we do not know it — but the
                    # line-advance side effect of ' and " can be, and must be.
                    runs_removed_whole += 1
                    text_runs_removed += 1
                    kept.extend(_state_only_instructions(operator, operands))
                elif emitted:
                    kept.extend(emitted)
                    text_runs_removed += 1
            # Advance the text matrix so subsequent same-line Tj/TJ calls
            # (common when a generator emits one call per word/run) don't
            # all collapse onto the same origin point.
            state.advance_after_show(raw_width, vertical)
            if not measured:
                slack += raw_width if vertical else raw_width * state.h_scale
        elif operator == "INLINE IMAGE":
            # A BI/ID/EI object draws the unit square under the live CTM
            # exactly as an image `Do` does (page_images.py treats them as
            # placements in the same DFS order). Without this branch it fell
            # through to the final `else` and was KEPT VERBATIM — redaction
            # drew a black box over it and reported success with
            # images_removed=0, while the pixels stayed in the content
            # stream for anyone to extract. That is the false negative this
            # module's docstring calls the dangerous failure mode.
            #
            # Dropping the instruction removes the DATA as well: unlike an
            # XObject image there is no resource to prune, because the bytes
            # live inline in the stream we are rewriting.
            bbox = _bbox_of_rect_under_matrix(state.ctm, 1.0, 1.0)
            if _intersects_any(bbox, regions):
                images_removed += 1
            else:
                kept.append(instruction)
        elif operator == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback_resources)
            subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""

            if xobj is not None and subtype == "/Image":
                bbox = _bbox_of_rect_under_matrix(state.ctm, 1.0, 1.0)
                if _intersects_any(bbox, regions):
                    images_removed += 1
                    if name:
                        dropped_image_names.add(name)
                else:
                    if name:
                        surviving_image_names.add(name)
                    kept.append(instruction)
            elif xobj is not None and subtype == "/Form":
                form_matrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
                form_ctm = _mat_mult(form_matrix, state.ctm)
                bbox_arr = xobj.get("/BBox")
                placed = None
                if bbox_arr is not None:
                    try:
                        bx0, by0, bx1, by1 = (float(v) for v in bbox_arr)
                        placed = _bbox_of_corners_under_matrix(form_ctm, bx0, by0, bx1, by1)
                    except (TypeError, ValueError):
                        placed = None
                intersects = placed is None or _intersects_any(placed, regions)
                if not intersects:
                    kept.append(instruction)
                elif depth >= MAX_FORM_DEPTH:
                    # Past the recursion cap we cannot safely inspect the form,
                    # and it DOES overlap a region — drop the whole form draw
                    # (over-redaction, the secrecy-safe direction) rather than
                    # leak whatever it contains. Only reachable on pathological
                    # (e.g. cyclic) nesting; real documents never get here.
                    # Record it (counter + name to prune) so this counts as a
                    # real change: otherwise an all-zero WalkResult makes an
                    # enclosing _redact_form bottom-out and keep the pristine
                    # original, reverting redaction all the way up the branch.
                    forms_dropped_at_cap += 1
                    if name:
                        replaced_form_names.add(name)
                else:
                    copy, sub = _redact_form(
                        pdf, xobj, resources, regions, form_ctm, depth + 1,
                        name_counter, fonts, state,
                    )
                    if copy is not None:
                        new_name = _new_form_name(name_counter, taken_names)
                        new_forms[new_name] = copy
                        if name:
                            replaced_form_names.add(name)
                        kept.append(_do_instruction(new_name))
                        text_runs_removed += sub[0]
                        text_runs_split += sub[1]
                        runs_removed_whole += sub[2]
                        images_removed += sub[3]
                    else:
                        kept.append(instruction)
            else:
                # Non-image/non-form — pass through.
                kept.append(instruction)
        else:
            kept.append(instruction)

    return WalkResult(
        kept,
        text_runs_removed,
        text_runs_split,
        runs_removed_whole,
        images_removed,
        dropped_image_names,
        surviving_image_names,
        new_forms,
        replaced_form_names,
        forms_dropped_at_cap,
    )


def _referenced_xobject_names(instructions) -> set:
    return {
        str(ins.operands[0])
        for ins in instructions
        if str(ins.operator) == "Do" and ins.operands
    }


def _drop_replaced_forms(xobjects, referenced: set, replaced: set) -> None:
    """Delete the original form entries we rewrote to redacted copies, but only
    where no surviving Do still references them. Removing the last reference
    makes the original (secret-bearing) form unreachable, so it — and any image
    it alone held — is dropped on save. Erring toward removal is the
    secrecy-safe direction this module already commits to."""
    if xobjects is None:
        return
    for nm in replaced:
        if nm not in referenced and Name(nm) in xobjects:
            del xobjects[Name(nm)]


def _copy_resources_for_write(pdf: "pikepdf.Pdf", resources):
    """A fresh /Resources dict for a redacted form copy: /XObject is a NEW
    subdict (so pruning orphaned images / registering nested copies never
    touches the original form's resources); other entries (fonts, etc.) are
    shared by reference since we only read them."""
    new = pikepdf.Dictionary()
    if resources is not None:
        for key in resources.keys():
            new[key] = resources[key]
    src_xo = resources.get("/XObject") if resources is not None else None
    new_xo = pikepdf.Dictionary()
    if src_xo is not None:
        for key in src_xo.keys():
            new_xo[key] = src_xo[key]
    new["/XObject"] = new_xo
    return new


def _redact_form(pdf, form, parent_resources, regions, form_ctm, depth, name_counter, fonts, parent_state=None):
    """Build a redacted COPY of a Form XObject, or return (None, None) if
    nothing inside it intersects a region (caller then keeps the original Do).
    `parent_state` is the text state active at the invoking Do (forms inherit
    it). Returns (copy_stream, (text_removed, text_split, removed_whole,
    images_removed))."""
    form_res = form.get("/Resources")
    read_res = form_res if form_res is not None else parent_resources
    result = _walk(
        pdf,
        pikepdf.parse_content_stream(form),
        read_res,
        regions,
        form_ctm,
        depth,
        name_counter,
        fonts,
        parent_state=parent_state,
        fallback_resources=parent_resources,
    )
    if (
        result.text_runs_removed == 0
        and result.images_removed == 0
        and not result.new_forms
        and result.forms_dropped_at_cap == 0
    ):
        return None, None

    copy = pdf.make_stream(pikepdf.unparse_content_stream(result.kept))
    # make_stream stores the rebuilt content UNCOMPRESSED with no filter, so we
    # must NOT copy the original's /Filter or /DecodeParms — inheriting a
    # /FlateDecode over raw bytes yields a stream no reader can inflate,
    # corrupting the copy (and any legitimate content it was meant to keep).
    # /Length is likewise recomputed by pikepdf on write. /Resources is set
    # below from a pruned copy.
    for key in form.keys():
        if key in ("/Length", "/Filter", "/DecodeParms", "/Resources"):
            continue
        copy[key] = form[key]

    copy_res = _copy_resources_for_write(pdf, read_res)
    xo = copy_res["/XObject"]
    # Prune image XObjects whose only draws were removed — otherwise their
    # bytes stay reachable (a leak: "redacted" image still embedded).
    for orphan in result.dropped_image_names - result.surviving_image_names:
        if Name(orphan) in xo:
            del xo[Name(orphan)]
    # Drop original nested forms we replaced with redacted copies.
    _drop_replaced_forms(xo, _referenced_xobject_names(result.kept), result.replaced_form_names)
    # Register nested redacted-form copies produced one level down.
    for nm, st in result.new_forms.items():
        xo[Name(nm)] = st
    copy["/Resources"] = copy_res

    return copy, (
        result.text_runs_removed,
        result.text_runs_split,
        result.runs_removed_whole,
        result.images_removed,
    )


# ── redaction properties: the overlay a region is painted with ──
#
# The format's own vocabulary, and `save_redaction_marks` already writes three
# of its neighbours: `/IC` is the fill, `/OverlayText` the text drawn over it,
# `/Repeat` tiles that text to fill the box, `/Q` aligns it and `/DA` carries
# the font, size and colour. Until now the fill was hard-coded `0 0 0 rg` here
# and hard-coded `[0,0,0]` there — two copies of a decision the user never got
# to make, on a tool where a FOIA exemption code printed in the box is the
# whole point of the redaction for the reader who receives the file.


class RedactionProperties(NamedTuple):
    """One region's appearance. Every field has a format key behind it."""

    fill: tuple  # /IC — the box colour, RGB 0..1
    overlay_text: str  # /OverlayText
    repeat: bool  # /Repeat — tile the text to fill the box
    align: int  # /Q — 0 left, 1 centred, 2 right
    font_size: float  # /DA — 0 = fit the box
    text_color: tuple  # /DA


DEFAULT_FILL = (0.0, 0.0, 0.0)
# Leading as a multiple of the font size, for a repeated/tiled overlay.
OVERLAY_LINE_EM = 1.15
MIN_OVERLAY_SIZE = 4.0
MAX_OVERLAY_SIZE = 72.0
# The overlay is inset from the box edge so a glyph never touches the border.
OVERLAY_PAD_EM = 0.15


def _rgb(value, fallback: tuple) -> tuple:
    try:
        parts = [float(v) for v in value]
    except (TypeError, ValueError):
        return fallback
    if len(parts) != 3:
        return fallback
    return tuple(min(max(p, 0.0), 1.0) for p in parts)


def _auto_text_color(fill: tuple) -> tuple:
    """White on a dark fill, black on a light one.

    A DEFAULT, not a decision taken from the user: `text_color` given
    explicitly always wins. Defaulting to a fixed colour instead would make
    the common "white box, coded overlay" case draw white on white — an
    overlay nobody can read is the same as no overlay, on a surface whose job
    is telling the reader WHY something was removed.
    """
    r, g, b = fill
    luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return (0.0, 0.0, 0.0) if luminance > 0.55 else (1.0, 1.0, 1.0)


def properties_of(spec: dict) -> RedactionProperties:
    """Read one region's properties, defaulting to today's shipped look — a
    plain black box with no overlay, so a caller that sends none gets exactly
    the bytes it got before redaction properties existed."""
    fill = _rgb(spec.get("fill"), DEFAULT_FILL)
    text = str(spec.get("overlay_text") or "")
    align = spec.get("align", 0)
    try:
        align = int(align)
    except (TypeError, ValueError):
        align = 0
    if align not in (0, 1, 2):
        raise ValueError("align must be 0 (left), 1 (centred) or 2 (right)")
    try:
        size = float(spec.get("font_size") or 0.0)
    except (TypeError, ValueError):
        size = 0.0
    if size < 0:
        raise ValueError("font size must not be negative")
    color = (
        _rgb(spec.get("text_color"), _auto_text_color(fill))
        if spec.get("text_color") is not None
        else _auto_text_color(fill)
    )
    return RedactionProperties(fill, text, bool(spec.get("repeat_overlay")), align, size, color)


class _OverlayFace(NamedTuple):
    """A face that can DRAW and MEASURE one line of overlay text."""

    obj: object
    show: object  # (text) -> the complete show-operator bytes
    width_em: object  # (text) -> advance in ems


def _helvetica_face(pdf) -> _OverlayFace:
    from engine.pdf_metrics import text_width_em

    obj = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type1"),
            BaseFont=Name("/Helvetica"),
            Encoding=Name("/WinAnsiEncoding"),
        )
    )

    def show(text: str) -> bytes:
        escaped = "".join(
            ("\\" + ch) if ch in ("(", ")", "\\") else (ch if 32 <= ord(ch) <= 255 else "?")
            for ch in text
        )
        return b"(" + escaped.encode("latin-1") + b") Tj"

    return _OverlayFace(obj, show, text_width_em)


def _overlay_face(pdf, text: str, font_dir: str) -> _OverlayFace:
    """The face to draw `text` with.

    Latin-1 keeps the standard-14 Helvetica emission byte for byte (so an
    ASCII overlay adds no font program to the file). Anything else EMBEDS
    through the bundled fallback — the precedent: a non-Latin-1 overlay is
    not a refusal and is never `?`-mapped, because a redaction code printed as
    question marks tells the reader nothing. A right-to-left overlay goes
    through `rtl_text`, the builder the watermark and the field appearances
    already share — a per-character `Tj` would draw a joining script
    disconnected and reversed.
    """
    if not text or all(ord(ch) <= 255 for ch in text):
        return _helvetica_face(pdf)
    if not font_dir:
        # No fonts directory to embed from. Refuse rather than draw '?' — an
        # overlay that lies about what it says is worse than the refusal.
        raise ValueError(
            "this overlay text needs an embedded font and no font directory was given"
        )
    from engine.font_fallback import build_fallback_font, resolve_fallback_font

    try:
        from engine import bidi

        rtl = bidi.has_strong_rtl(text)
    except Exception:
        rtl = False
    face = resolve_fallback_font(font_dir, text=text, rtl_ok=rtl)
    if rtl:
        from engine import rtl_text

        built = rtl_text.build(pdf, face, text)
        if built is not None:
            return _OverlayFace(
                built.font_obj,
                lambda t: built.show(t, 1.0),
                lambda t: built.width_em(t),
            )
    font_dict, encode, width_1000 = build_fallback_font(pdf, face, text)
    return _OverlayFace(
        font_dict,
        lambda t: b"<" + encode(t).hex().encode("ascii") + b"> Tj",
        lambda t: width_1000(t) / 1000.0,
    )


def _fit_size(props: RedactionProperties, face: _OverlayFace, w: float, h: float) -> float:
    if props.font_size > 0:
        return props.font_size
    advance = max(face.width_em(props.overlay_text), 0.01)
    inner = max(w - 2 * OVERLAY_PAD_EM * 12.0, 1.0)
    by_width = inner / advance
    by_height = h / OVERLAY_LINE_EM
    return max(MIN_OVERLAY_SIZE, min(MAX_OVERLAY_SIZE, min(by_width, by_height)))


def _overlay_lines(props: RedactionProperties, face: _OverlayFace, size: float, w: float, h: float):
    """(text, x, y) baselines for the overlay, in the box's own coordinates.

    `/Repeat` tiles the text to FILL the box — horizontally by repeating it
    within a line, vertically by drawing as many lines as fit. Without it, one
    line, vertically centred, which is what a single exemption code wants.
    """
    unit = max(face.width_em(props.overlay_text) * size, 0.01)
    pad = OVERLAY_PAD_EM * size
    inner = max(w - 2 * pad, 0.01)
    line_h = OVERLAY_LINE_EM * size
    if props.repeat:
        per_line = max(int(inner // unit), 1)
        text = props.overlay_text * per_line
        rows = max(int(h // line_h), 1)
    else:
        text = props.overlay_text
        rows = 1
    width = face.width_em(text) * size
    if props.align == 1:
        x = (w - width) / 2.0
    elif props.align == 2:
        x = w - pad - width
    else:
        x = pad
    out = []
    if props.repeat:
        # Top-down, so the first line sits where a reader starts.
        top = h - line_h
        for row in range(rows):
            out.append((text, x, top - row * line_h + 0.25 * size))
    else:
        out.append((text, x, (h - size * 0.7) / 2.0 + 0.02 * size))
    return out


def _overlay_stream(
    pdf, specs: list, font_dir: str
) -> tuple[bytes, dict]:
    """The content painted OVER the rebuilt page: one filled box per region,
    plus its overlay text clipped to that box. Returns (bytes, fonts to
    register), where an empty font map means the standard-14 path was enough.
    """
    parts: list[bytes] = []
    fonts: dict = {}
    counter = 0
    for spec in specs:
        rect = spec["rect"]
        props = spec["props"]
        x0, y0, x1, y1 = rect
        w, h = x1 - x0, y1 - y0
        r, g, b = props.fill
        parts.append(
            f"q {r:.6g} {g:.6g} {b:.6g} rg {x0} {y0} {w} {h} re f Q\n".encode("ascii")
        )
        if not props.overlay_text or w <= 0 or h <= 0:
            continue
        face = _overlay_face(pdf, props.overlay_text, font_dir)
        name = f"/RdxOv{counter}"
        counter += 1
        fonts[name] = face.obj
        size = _fit_size(props, face, w, h)
        tr, tg, tb = props.text_color
        body = [
            f"q {x0} {y0} {w} {h} re W n {tr:.6g} {tg:.6g} {tb:.6g} rg BT "
            f"{name} {size:.6g} Tf\n".encode("ascii")
        ]
        for text, tx, ty in _overlay_lines(props, face, size, w, h):
            body.append(f"1 0 0 1 {x0 + tx:.6g} {y0 + ty:.6g} Tm ".encode("ascii"))
            body.append(face.show(text))
            body.append(b"\n")
        body.append(b"ET Q\n")
        parts.append(b"".join(body))
    return b"".join(parts), fonts


def _annot_key(obj):
    """Identity key for an annotation object, so /Popup /Parent /IRT references
    can be matched against /Annots entries. Indirect objects key on objgen;
    the rare inline annotation falls back to Python identity."""
    try:
        if obj.is_indirect:
            num, gen = obj.objgen
            return ("i", num, gen)
    except Exception:
        pass
    return ("d", id(obj))


# Keys whose values can carry an annotation's visible/textual content.
_ANNOT_CONTENT_KEYS = ("/Contents", "/RC", "/DS", "/AP", "/T", "/Subj", "/CA", "/RT")


def _scrub_annotation(annot) -> None:
    """Strip content-bearing keys from a removed annotation object, so that any
    OTHER surviving reference to it (a structure-tree entry, an AcroForm field,
    a reference we didn't model) cannot expose what it held."""
    for key in _ANNOT_CONTENT_KEYS:
        try:
            if key in annot:
                del annot[key]
        except Exception:
            pass


def _annot_overlaps(annot, regions: list[Rect]) -> bool:
    """Does this annotation touch a redaction region?

    FAILS CLOSED. An annotation whose `/Rect` cannot be read is treated as
    OVERLAPPING, so it is removed. Redaction is a security tool: the only
    tolerable error is removing too much. This previously returned False on
    an unreadable `/Rect` — an annotation with a damaged or broken-indirect
    rect sitting on top of a redacted region SURVIVED, silently, in a
    function whose whole job is to decide what must not survive.
    """
    try:
        rect = annot.get("/Rect")
    except Exception:
        return True  # unreadable — assume it overlaps
    if rect is None:
        # No /Rect at all: it has no position to compare, so it cannot be
        # shown to be clear of the regions. Remove it.
        return True
    try:
        r = _normalize_rect([float(v) for v in rect])
    except (TypeError, ValueError):
        return True  # non-numeric — assume it overlaps
    return _intersects_any(r, regions)


def _strip_annotations(page: "pikepdf.Page", regions: list[Rect]) -> int:
    """Remove annotations whose /Rect intersects a region — and cascade to
    their companions (a /Popup, or an /IRT reply) which commonly sit at a
    non-overlapping /Rect but reference the removed annotation via /Parent or
    /IRT, keeping its (secret-bearing) object reachable if left behind.
    Removed objects are also content-scrubbed as a belt-and-suspenders against
    any reference we don't model. /Rect is in page user space, like `regions`."""
    annots = page.obj.get("/Annots")
    if annots is None:
        return 0
    entries = list(annots)
    present = {_annot_key(a) for a in entries}

    remove = {_annot_key(a) for a in entries if _annot_overlaps(a, regions)}
    if not remove:
        return 0

    # Cascade: pull in each removed annot's /Popup, and any entry whose /Parent
    # or /IRT resolves to something already slated for removal. Iterate to a
    # fixed point so reply-chains are fully collected.
    changed = True
    while changed:
        changed = False
        for a in entries:
            key = _annot_key(a)
            if key in remove:
                for companion_key in ("/Popup",):
                    try:
                        companion = a.get(companion_key)
                    except Exception:
                        companion = None
                    if companion is not None:
                        ck = _annot_key(companion)
                        if ck in present and ck not in remove:
                            remove.add(ck)
                            changed = True
                continue
            for ref_key in ("/Parent", "/IRT"):
                try:
                    ref = a.get(ref_key)
                except Exception:
                    ref = None
                if ref is not None and _annot_key(ref) in remove:
                    remove.add(key)
                    changed = True
                    break

    kept = []
    removed = 0
    for a in entries:
        if _annot_key(a) in remove:
            removed += 1
            _scrub_annotation(a)
        else:
            kept.append(a)
    if kept:
        page.obj["/Annots"] = pikepdf.Array(kept)
    else:
        del page.obj["/Annots"]
    return removed


def _redact_page(
    pdf: "pikepdf.Pdf", page: "pikepdf.Page", specs: list, font_dir: str = ""
) -> dict:
    resources = _resolve_resources(page)
    regions: list[Rect] = [spec["rect"] for spec in specs]
    name_counter = [0]
    result = _walk(
        pdf, pikepdf.parse_content_stream(page), resources, regions, IDENTITY, 0,
        name_counter, _FontCache(),
    )

    new_bytes = pikepdf.unparse_content_stream(result.kept)
    overlay, overlay_fonts = _overlay_stream(pdf, specs, font_dir)
    page.Contents = pdf.make_stream(new_bytes + b"\n" + overlay)

    # Register redacted form copies on this page's effective /Resources.
    if result.new_forms:
        xo = resources.get("/XObject")
        if xo is None:
            xo = pikepdf.Dictionary()
            resources["/XObject"] = xo
        for nm, st in result.new_forms.items():
            xo[Name(nm)] = st
    if overlay_fonts:
        # The overlay draws in the PAGE's content stream, so its font lives in
        # the page's own /Resources — registered BEFORE the unreferenced-
        # resource sweep below, which would otherwise drop a font nothing had
        # referenced yet.
        fonts = resources.get("/Font")
        if fonts is None:
            fonts = pikepdf.Dictionary()
            resources["/Font"] = fonts
        for nm, obj in overlay_fonts.items():
            fonts[Name(nm)] = obj

    # remove_unreferenced_resources drops orphaned images/fonts but leaves
    # unreferenced FORM XObjects in place; explicitly drop the originals we
    # replaced so their (secret-bearing) bytes go unreachable. Only touch the
    # page's OWN /Resources — an inherited/shared dict is left intact because
    # sibling pages still legitimately reference the original there.
    if (result.dropped_image_names - result.surviving_image_names) or result.new_forms:
        page.remove_unreferenced_resources()
    own_res = page.obj.get("/Resources")
    if own_res is not None and result.replaced_form_names:
        _drop_replaced_forms(
            own_res.get("/XObject"),
            _referenced_xobject_names(result.kept),
            result.replaced_form_names,
        )

    annotations_removed = _strip_annotations(page, regions)

    return {
        "text_runs_removed": result.text_runs_removed,
        "text_runs_split": result.text_runs_split,
        "runs_removed_whole": result.runs_removed_whole,
        "images_removed": result.images_removed,
        "annotations_removed": annotations_removed,
    }


def redact(file: str, output: str, regions: list[dict], font_dir: str = "") -> dict:
    """Strip content under one or more rectangular regions and black them out.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        regions: List of `{"page": <1-based int>, "rect": [x0, y0, x1, y1]}`,
            rect in the page's own /MediaBox point space (i.e. the same
            coordinate system the page's content stream already uses —
            callers are responsible for accounting for /Rotate themselves).
            Each region may also carry its REDACTION PROPERTIES,
            in the format's own vocabulary: `fill` (`/IC`), `overlay_text`
            (`/OverlayText`), `repeat_overlay` (`/Repeat`), `align` (`/Q`),
            `font_size` and `text_color` (`/DA`). Omitting them all paints the
            plain black box this function has always painted, byte for byte.
        font_dir: The bundled fonts directory, for an overlay whose text is
            not Latin-1 — it EMBEDS rather than refusing or drawing '?'.
    """
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    by_page: dict[int, list[dict]] = {}
    for region in regions:
        page_num = int(region["page"])
        by_page.setdefault(page_num, []).append(
            {"rect": _normalize_rect(region["rect"]), "props": properties_of(region)}
        )

    stats = {
        "text_runs_removed": 0,
        "text_runs_split": 0,
        "runs_removed_whole": 0,
        "images_removed": 0,
        "annotations_removed": 0,
    }
    pages_redacted = 0
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        for page_num, specs in by_page.items():
            if not (1 <= page_num <= total):
                continue
            page_stats = _redact_page(pdf, pdf.pages[page_num - 1], specs, font_dir)
            for key in stats:
                stats[key] += page_stats[key]
            pages_redacted += 1

        if same_file:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, dir=str(input_path.parent)) as tmp:
                tmp_path = tmp.name
            pdf.save(tmp_path)
        else:
            pdf.save(output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {
        "output": str(output_path),
        "pages_redacted": pages_redacted,
        "regions_applied": len(regions),
        **stats,
    }
