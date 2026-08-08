"""Text-run listing and in-place replacement (Edit Text).

A "run" is one text-showing operator (Tj / ' / " / TJ), the unit the user
clicks. Ids are the DFS show-op encounter order (page stream first, forms
recursed at their Do position) — the same index-agreement discipline as
page_images.py, proven there and pinned here by the same style of tests.

Listing decodes each run through its font's capability (pdf_fonts.py) and
computes REAL geometry: glyph advances from the font's widths (+ TJ kern,
Tc char spacing, Tw word spacing on the single-byte space code, Tz), so
run rects are accurate and the Δwidth math is honest. That measurement now
lives in `text_metrics.py` and REDACTION calls it too — the
flat-estimate era, when the two walkers disagreed about a run's width, ended
with a measured false negative; see that module's docstring.

The listing rect stays the EM box (baseline → baseline + font size): it is
the box the user clicks, and its top/bottom are where a caret belongs. The
INK box (`text_metrics.ink_extent_em`) is a different question and is what
redaction tests against — a lister rect misses 2.48 pt of descender at 12 pt
Helvetica, which is a click-target nicety and a redaction leak.

Replacement (`replace_text_run`) rewrites exactly one show op:
  - the new text re-encoded in the run's own font (ValueError names the
    first character the font cannot express — the renderer validates live
    against the run's `encodable` set, so this is a belt);
  - ' and " targets are expanded to their spec equivalence (T* [+ Tw/Tc
    for "]) followed by a plain Tj, preserving their state side effects;
  - the Δwidth anchor rule (the phase doc's design): text that FLOWS
    (consecutive shows, no repositioning) shifts automatically via the tm
    advance; subsequent SAME-LINE Td/TD anchors (ty == 0) are absolute
    against the line matrix and are shifted by Δ explicitly — the
    word-per-Td generator pattern would overlap a grown word otherwise.
    Any line change (T*, ', ", Td/TD with ty ≠ 0, Tm, BT, ET) stops the
    adjustment. Cross-line reflow belongs to the paragraph layer, deliberately.
  - vertical runs (Identity-V/UCS2-V capabilities) list with
    `vertical: true`, an em-wide column rect spanning the /W2 advance sum
    DOWNWARD, and the anchor rule TRANSPOSED: same-COLUMN Td/TD followers
    (tx == 0) shift by Δadvance in ty (unscaled — Tz never applies
    vertically); a tx change is a column boundary and stops.
  - a run inside a Form XObject edits a COPY of the form for that draw
    (the page_images.py pattern verbatim).

Empty `new_text` is allowed — it deletes the run's text (negative Δ pulls
same-line anchors back).
"""

from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from engine.content_walk import ClipTracker, GraphicsTextState
from engine.page_images import (
    _finalize_page_rewrite,
    _fresh_name,
    _register_xobject,
    _save,
)
from engine.redact import (
    IDENTITY,
    MAX_FORM_DEPTH,
    _as_matrix,
    _bbox_of_corners_under_matrix,
    _bbox_of_rect_under_matrix,
    _copy_resources_for_write,
    _lookup_xobject,
    _mat_mult,
    _resolve_resources,
)

# The measurement half of this module MOVED to text_metrics.py so
# redaction reads the same advances the lister does — one geometry authority,
# not two (redact.py's flat 0.5-em-per-byte estimate was a false negative; the
# module docstring there carries the measurements). Re-exported here because
# text_paragraphs.py and the pytest suite import these names from this module.
from engine.text_metrics import (  # noqa: F401  (_operand_bytes is a re-export)
    _child_state,
    _FontCache,
    _lookup_font,
    _operand_bytes,
    _run_metrics,
    _show_segments,
    _spaces_in,
)

SHOW_OPS = ("Tj", "'", '"', "TJ")


# ── listing ───────────────────────────────────────────────────────────────


def _style_of(state: GraphicsTextState) -> dict:
    """The re-emittable text state at a show op (the span style)."""
    return {
        "font_name": state.font_name,
        "size": state.font_size,
        "h_scale": state.h_scale,
        "char_spacing": state.char_spacing,
        "word_spacing": state.word_spacing,
        "render_mode": state.render_mode,
        "rise": state.rise,
        "fill_color": state.fill_color,
        "stroke_color": state.stroke_color,
    }


def _plain_segments(operator: str, operands: list) -> list:
    """_show_segments detached from pikepdf (bytes/float only) so the
    paragraph analysis can outlive the walk."""
    out: list = []
    for seg in _show_segments(operator, operands):
        out.append(seg if isinstance(seg, float) else bytes(seg))
    return out


def _bdc_mcid(operands: list, resources, fallback):
    """The /MCID a BDC opens, or None when it opens an unnumbered block.

    The property list is either an inline dictionary or a NAME resolving
    through the stream's /Properties resource — both spellings are legal and a
    generator picks whichever it likes, so both are read.
    """
    if len(operands) < 2:
        return None
    props = operands[1]
    if isinstance(props, pikepdf.Name):
        for source in (resources, fallback):
            if source is None:
                continue
            try:
                table = source.get("/Properties")
                if table is None:
                    continue
                found = table.get(str(props))
            except (AttributeError, TypeError):
                continue
            if found is not None:
                props = found
                break
    try:
        value = props.get("/MCID")
    except (AttributeError, TypeError):
        return None
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _walk_runs(pdf, instructions, resources, base_ctm, depth, fallback, out, nested, fonts, parent_state=None, detail=None, stream_path=(), base_clip=None):
    state = _child_state(base_ctm, parent_state)
    # Clip tracking rides ADDITIVELY beside the state machine so a
    # run wholly outside the active clip lists as `clipped` (invisible) and the
    # renderer stops offering it as editable. `base_clip` is the parent stream's
    # device-space clip a nested form inherits (§8.10.2).
    clips = ClipTracker(base_clip)
    # Stream identity for the paragraph layer: the path of LOCAL form ordinals (the nth
    # qualifying Do within its parent stream) from the page down. Local —
    # not a global DFS id — so a rewriter can NAVIGATE to one stream and
    # leave every other form untouched and unvisited.
    local_form_ordinal = 0
    # Marked-content nesting, one entry per open BDC/BMC. A run reports the
    # INNERMOST enclosing /MCID, which is the id a structure element's /K
    # names. Tracked in THIS walk rather than a parallel one so a run and its
    # mark agree by construction (search_regions' rule about run indexes,
    # applied to the other axis). MCIDs are scoped to their content stream:
    # `nested` says whether this run is in the page's own numbering, and a
    # consumer that needs page scope must test it.
    marks: list = []
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        # Fed with the CURRENT ctm BEFORE state.feed (which consumes-and-
        # continues past q/Q/cm) — path-point ops never move the CTM.
        clips.feed(operator, operands, state.ctm)
        if operator in ("BDC", "BMC"):
            marks.append(_bdc_mcid(operands, resources, fallback) if operator == "BDC" else None)
            continue
        if operator == "EMC":
            if marks:
                marks.pop()
            continue
        if state.feed(operator, operands):
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
            cap = fonts.capability(resources, fallback, state.font_name)
            text, raw_width = _run_metrics(operator, operands, cap, state)
            combined = _mat_mult(state.tm, state.ctm)
            vertical = bool(cap is not None and cap.vertical)
            if vertical:
                # v1 rect: a vertical run occupies one em-wide column
                # centered on the pen (the vx = w/2 default) and spans the
                # advance sum DOWNWARD from the start point.
                half = max(state.font_size, 0.01) / 2.0
                x0, y0, x1, y1 = _bbox_of_corners_under_matrix(
                    combined, -half, -max(raw_width, 0.01), half, 0.0
                )
            else:
                x0, y0, x1, y1 = _bbox_of_rect_under_matrix(
                    combined, max(raw_width * state.h_scale, 0.01), max(state.font_size, 0.01)
                )
            editable = bool(cap and cap.editable and text.strip())
            reason = None
            if cap is None:
                reason = "no font is active for this text"
            elif not cap.editable:
                reason = cap.reason
            elif not text.strip():
                reason = "nothing to edit"
            out.append(
                {
                    "index": len(out),
                    "text": text,
                    "rect": [x0, y0, x1, y1],
                    "nested": nested,
                    "font_name": state.font_name,
                    "font_size": state.font_size,
                    "editable": editable,
                    "reason": reason,
                    "encodable": cap.encodable() if (cap and cap.editable) else "",
                    # Additive: the ligature sequences encode() will
                    # round-trip — the renderer's longest-match validation
                    # reads these next to `encodable`. [] when none/refused.
                    "sequences": cap.encodable_sequences() if (cap and cap.editable) else [],
                    # Additive: True when this run's advances/rect
                    # were computed in vertical-writing mode (the surface
                    # reads it). A refused vertical font reports False —
                    # the field describes the geometry actually computed.
                    "vertical": vertical,
                    # Additive: True when the run's bbox is fully
                    # outside the active clip (invisible). The renderer filters
                    # these out so clipped-away text is never offered as
                    # editable; the index space is UNCHANGED (the mutators'
                    # count agreement is untouched).
                    "clipped": clips.clips_away((x0, y0, x1, y1)),
                    # Additive: the innermost enclosing marked-content id, or
                    # None outside any. Scoped to this run's own stream — read
                    # it together with `nested`.
                    "mcid": next((m for m in reversed(marks) if m is not None), None),
                }
            )
            if detail is not None:
                # the rich channel — SAME walk, so run index agreement
                # is by construction, not by parallel implementation.
                detail.append(
                    {
                        "stream": stream_path,
                        "operator": operator,
                        "segments": _plain_segments(operator, operands),
                        "cap": cap,
                        "style": _style_of(state),
                        "tm": state.tm,
                        "ctm": state.ctm,
                        "combined": combined,
                        "raw_width": raw_width,
                        "rect": (x0, y0, x1, y1),
                        # The STREAM-scoped resources this run's font resolves
                        # against (form-scoped when nested), + the invoker's
                        # resources as the fallback — the exact pair the
                        # FontCache used above. the paragraph family
                        # classification needs form scope because a form's `F1`
                        # can differ from the page's `F1`.
                        "resources": resources,
                        "fallback": fallback,
                    }
                )
            state.advance_after_show(raw_width, vertical)
        elif operator == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback)
            subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""
            if xobj is not None and subtype == "/Form" and depth < MAX_FORM_DEPTH:
                form_matrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
                form_res = xobj.get("/Resources")
                child_path = stream_path + (local_form_ordinal,)
                local_form_ordinal += 1
                _walk_runs(
                    pdf,
                    pikepdf.parse_content_stream(xobj),
                    form_res if form_res is not None else resources,
                    _mat_mult(form_matrix, state.ctm),
                    depth + 1,
                    resources,
                    out,
                    True,
                    fonts,
                    parent_state=state,
                    detail=detail,
                    stream_path=child_path,
                    base_clip=clips.clip,
                )
    return out


def list_text_runs(file: str, page: int) -> dict:
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        runs: list[dict] = []
        _walk_runs(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            IDENTITY,
            0,
            None,
            runs,
            False,
            _FontCache(),
        )
        return {"page": int(page), "runs": runs}


# ── replacement ───────────────────────────────────────────────────────────


class _TextEditState:
    def __init__(self, target: int, new_text: str, builder=None):
        self.target = target
        self.new_text = new_text
        # Optional replacement renderer: (pdf, resources, gts, text)
        # -> (instructions, new_raw_width). None = re-encode in the run's
        # own font.
        self.builder = builder
        # Run restyle: an optional size (pt) and/or fill color
        # ([r,g,b] 0..1) applied to THIS run only. The emission wraps the
        # show op in q…Q — font/size/fill are graphics state and revert at
        # Q, while the text matrix (NOT graphics state per spec) keeps the
        # advance — so neighbors are untouched by construction.
        self.style_size: float | None = None
        self.style_color: list | None = None
        self.seen = 0
        self.done = False
        # Set at the edit site; consumed by the same-line anchor pass.
        self.delta_scaled = 0.0  # Δ advance in text-space units incl. Tz
        # True when the edited run's font is vertical — the anchor
        # pass transposes (same-COLUMN followers shift in ty; Tz does not
        # scale delta_scaled).
        self.vertical = False
        # (name, font_dict) the fallback builder produced — registered by the
        # rewriter into the CORRECT resources (page, or the form COPY).
        self.pending_font: tuple[str, object] | None = None
        # Original form names superseded by edit copies — _finalize_page_
        # rewrite drops them when unreferenced (review-measured: without
        # this every nested edit left the prior copy fully embedded, and a
        # convert stranded a whole font subset per orphan).
        self.superseded_forms: set = set()


def _instruction(operands: list, operator: str):
    return pikepdf.ContentStreamInstruction(operands, pikepdf.Operator(operator))


def _fresh_font_name(resources, counter: list, reserved: set) -> str:
    taken = set(reserved)
    fonts = resources.get("/Font") if resources is not None else None
    if fonts is not None:
        taken |= {str(k) for k in fonts.keys()}
    while True:
        name = f"/EditFb{counter[0]}"
        counter[0] += 1
        if name not in taken:
            reserved.add(name)
            return name


def _register_font(pdf, resources, name: str, font_dict) -> None:
    fonts = resources.get("/Font")
    if fonts is None:
        fonts = Dictionary()
        resources["/Font"] = fonts
    fonts[Name(name)] = font_dict


def _rewrite_runs(pdf, instructions, resources, depth, fallback, edit, fonts, counter, reserved, base_ctm=IDENTITY, parent_state=None):
    """(kept, changed). Mirrors _walk_runs's counting exactly (its OWN
    per-stream state machine, inheriting like the lister — a shared or
    global state across recursion levels would corrupt both the width math
    and the count agreement); applies the edit at the target and Δ-adjusts
    subsequent same-line Td/TD anchors within this stream. `base_ctm` is
    form-matrix-composed like the lister's — nothing here READS ctm today
    (all Δ math is text-space; review-verified inert), but a divergent ctm
    is exactly the latent trap the next rewriter feature would fall into."""
    gts = _child_state(base_ctm, parent_state)
    kept: list = []
    changed = False
    new_forms: dict = {}  # copies made at THIS level, for the caller (staging rule)
    adjusting = False  # True after the edit, until a line boundary
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)

        if adjusting:
            if operator in ("T*", "'", '"', "Tm", "BT", "ET"):
                adjusting = False
            elif operator in ("Td", "TD"):
                try:
                    tx, ty = float(operands[0]), float(operands[1])
                except (TypeError, ValueError, IndexError):
                    adjusting = False
                else:
                    if edit.vertical:
                        # The same-line rule TRANSPOSED — a
                        # same-COLUMN follower (tx == 0) shifts DOWN by
                        # Δadvance (ty − Δ; a shrink pulls it back up);
                        # any tx change is a column boundary and stops.
                        # One adjustment only, same rationale as below.
                        if tx == 0.0:
                            gts.feed(operator, operands)
                            kept.append(
                                _instruction([tx, ty - edit.delta_scaled], operator)
                            )
                            adjusting = False
                            continue
                        adjusting = False
                    elif ty == 0.0:
                        # Δ is applied to the FIRST same-line anchor ONLY:
                        # Td translations are RELATIVE to the previous line
                        # matrix, so the one adjustment propagates through
                        # the rest of the chain automatically — adjusting
                        # every subsequent Td compounds the shift: word 3 moves
                        # 2Δ and word 4 moves 3Δ.
                        gts.feed(operator, operands)
                        kept.append(
                            _instruction([tx + edit.delta_scaled, ty], operator)
                        )
                        adjusting = False
                        continue
                    else:
                        adjusting = False

        if operator in SHOW_OPS and not edit.done:
            if edit.seen == edit.target:
                edit.done = True
                changed = True
                if operator in ("'", '"'):
                    gts.next_line()
                # Spec equivalences, preserving state side effects: ' is
                # T* Tj; " is aw Tw ac Tc T* Tj.
                if operator == '"' and len(operands) >= 3:
                    kept.append(_instruction([operands[0]], "Tw"))
                    kept.append(_instruction([operands[1]], "Tc"))
                    try:
                        gts.word_spacing = float(operands[0])
                        gts.char_spacing = float(operands[1])
                    except (TypeError, ValueError):
                        pass
                if operator in ("'", '"'):
                    kept.append(_instruction([], "T*"))

                cap = fonts.capability(resources, fallback, gts.font_name)
                # BOTH paths fail closed on an unusable run font — the
                # builder path previously skipped the guard, so a direct
                # convert_text_run call on a refused-font run mixed an
                # estimated width into Δ and misplace followers. The UI does
                # not currently reach this path, but the contract still holds.
                if cap is None:
                    raise ValueError("no font is active for this text run")
                if not cap.editable:
                    raise ValueError(cap.reason or "this text is not editable")
                edit.vertical = bool(cap.vertical)
                if edit.vertical and edit.builder is not None:
                    # The fallback builder embeds a HORIZONTAL
                    # Identity-H face — dropped into a vertical column it
                    # would render on the wrong axis. Fail closed (the
                    # builder-path guard discipline above).
                    raise ValueError(
                        "vertical text cannot be converted to the fallback font"
                    )
                _old_text, old_raw = _run_metrics(operator, operands, cap, gts)
                if edit.builder is not None:
                    # Fallback path: the builder renders the replacement
                    # its own way (new embedded font + restore Tf); it owns
                    # registration against THIS stream's resources.
                    new_instructions, new_raw = edit.builder(
                        pdf, resources, gts, edit.new_text
                    )
                    kept.extend(new_instructions)
                else:
                    encoded = cap.encode(edit.new_text)
                    eff_size = (
                        edit.style_size if edit.style_size is not None else gts.font_size
                    )
                    new_raw = (
                        cap.decoded_width(encoded) / 1000.0 * eff_size
                        + gts.char_spacing * cap.code_count(encoded)
                        + gts.word_spacing * _spaces_in(encoded, cap)
                    )
                    styled = edit.style_size is not None or edit.style_color is not None
                    if styled:
                        kept.append(_instruction([], "q"))
                        if edit.style_color is not None:
                            kept.append(
                                _instruction(
                                    [round(float(c), 4) for c in edit.style_color], "rg"
                                )
                            )
                        if edit.style_size is not None and gts.font_name:
                            kept.append(
                                _instruction(
                                    [Name(gts.font_name), round(float(eff_size), 4)], "Tf"
                                )
                            )
                    kept.append(_instruction([pikepdf.String(encoded)], "Tj"))
                    if styled:
                        kept.append(_instruction([], "Q"))
                # Tz never scales vertical advances, so the vertical
                # Δ is unscaled.
                edit.delta_scaled = (new_raw - old_raw) * (
                    1.0 if edit.vertical else gts.h_scale
                )
                gts.advance_after_show(new_raw, edit.vertical)
                adjusting = True
                edit.seen += 1
                continue
            # Not the target: replay state effects exactly like the lister.
            if operator in ("'", '"'):
                gts.next_line()
                if operator == '"' and len(operands) >= 2:
                    try:
                        gts.word_spacing = float(operands[0])
                        gts.char_spacing = float(operands[1])
                    except (TypeError, ValueError):
                        pass
            cap = fonts.capability(resources, fallback, gts.font_name)
            _text, raw = _run_metrics(operator, operands, cap, gts)
            gts.advance_after_show(raw, bool(cap is not None and cap.vertical))
            kept.append(instruction)
            edit.seen += 1
            continue

        if operator == "Do" and not edit.done:
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback)
            subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""
            if xobj is not None and subtype == "/Form" and depth < MAX_FORM_DEPTH:
                form_res = xobj.get("/Resources")
                read_res = form_res if form_res is not None else resources
                form_matrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
                inner_kept, inner_changed, inner_new_forms = _rewrite_runs(
                    pdf,
                    pikepdf.parse_content_stream(xobj),
                    read_res,
                    depth + 1,
                    resources,
                    edit,
                    fonts,
                    counter,
                    reserved,
                    base_ctm=_mat_mult(form_matrix, gts.ctm),
                    parent_state=gts,
                )
                if inner_changed:
                    changed = True
                    copy = pdf.make_stream(pikepdf.unparse_content_stream(inner_kept))
                    for key in xobj.keys():
                        if key in ("/Length", "/Filter", "/DecodeParms", "/Resources"):
                            continue
                        copy[key] = xobj[key]
                    copy_res = _copy_resources_for_write(pdf, read_res)
                    for nm, st in inner_new_forms.items():
                        copy_res["/XObject"][Name(nm)] = pdf.make_indirect(st)
                    if edit.pending_font is not None:
                        # The fallback font registers against the form
                        # COPY's resources — and /Font must be DEEP-copied
                        # first: _copy_resources_for_write only deep-copies
                        # /XObject (redaction never wrote fonts) and shares
                        # everything else BY REFERENCE, so registering into
                        # the shared dict mutated the ORIGINAL form every
                        # other draw still uses (test-caught live).
                        src_fonts = copy_res.get("/Font")
                        fresh_fonts = Dictionary()
                        if src_fonts is not None:
                            for k in src_fonts.keys():
                                fresh_fonts[k] = src_fonts[k]
                        copy_res["/Font"] = fresh_fonts
                        fname, fdict = edit.pending_font
                        _register_font(pdf, copy_res, fname, fdict)
                    copy["/Resources"] = copy_res
                    new_name = _fresh_name(resources, counter, reserved)
                    new_forms[new_name] = copy
                    kept.append(_instruction([Name(new_name)], "Do"))
                    if name:
                        edit.superseded_forms.add(name)
                    continue
            kept.append(instruction)
            continue

        gts.feed(operator, operands)
        kept.append(instruction)
    return kept, changed, new_forms


def _refuse_offpage_retype(pdf, p, resources, fonts, kept, index, old_rect):
    """Round-30 guard: a retype re-anchors at the ORIGINAL position, so a
    longer text marches past the page edge — silently invisible, with a
    success result (worst for rotated authored runs, which have no
    paragraph-editor fallback). Walk the REWRITTEN instructions and refuse
    when the target's new rect exits the visible box (cropbox, mediabox
    fallback — the authoring guard's convention) on a side the OLD rect
    respected: an already-off-page run stays editable (quirky documents
    must not regress), and each side is judged independently so fixing
    one overflow can't be blocked by another. Skipped if the rewrite
    changed the run COUNT (no honest index mapping — the fallback-builder
    path never does today)."""
    new_runs = _walk_runs(pdf, kept, resources, IDENTITY, 0, None, [], False, fonts)
    if index >= len(new_runs):
        return
    new_rect = new_runs[index]["rect"]
    try:
        vbox = [float(v) for v in p.cropbox]
    except Exception:
        vbox = None
    if not vbox:
        try:
            vbox = [float(v) for v in p.mediabox]
        except Exception:
            return
    x0, y0, x1, y1 = min(vbox[0], vbox[2]), min(vbox[1], vbox[3]), max(vbox[0], vbox[2]), max(vbox[1], vbox[3])
    eps = 0.5
    exits = (
        (new_rect[0] < x0 - eps and old_rect[0] >= x0 - eps)
        or (new_rect[1] < y0 - eps and old_rect[1] >= y0 - eps)
        or (new_rect[2] > x1 + eps and old_rect[2] <= x1 + eps)
        or (new_rect[3] > y1 + eps and old_rect[3] <= y1 + eps)
    )
    if exits:
        raise ValueError(
            "the new text would extend off the page — shorten it or reduce the size"
        )


def replace_text_run(file: str, output: str, page: int, index: int, new_text: str) -> dict:
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        fonts = _FontCache()
        pre_runs = _walk_runs(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False, fonts
        )
        count = len(pre_runs)
        if not (0 <= int(index) < count):
            raise ValueError(f"text run index {index} is out of range (page has {count})")

        edit = _TextEditState(int(index), str(new_text))
        kept, changed, new_forms = _rewrite_runs(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            0,
            None,
            edit,
            fonts,
            [0],
            set(),
        )
        if not changed:
            raise ValueError("edit did not apply (run not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        # After registration — a NESTED target's rewritten form resolves only
        # once its fresh name is in resources; walking before it would miss
        # the run (or compare the wrong one) and the guard would no-op.
        _refuse_offpage_retype(pdf, p, resources, fonts, kept, int(index), pre_runs[int(index)]["rect"])
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, edit.superseded_forms)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def restyle_text_run(
    file: str,
    output: str,
    page: int,
    index: int,
    size: float | None = None,
    color: list | None = None,
) -> dict:
    """Restyle ONE run — size (pt) and/or fill color — text unchanged.

    Rides the replace machinery end to end (same targeting, Δ math for the
    size-driven advance change, same-line anchors, form copy-on-edit); the
    emission wraps the re-shown run in q…Q so font/size/fill revert after it
    (graphics state) while the advance stays (the text matrix is not part of
    the saved state). FAMILY stays out deliberately: switching a run's font
    is the paragraph machinery's job — this surface is the fallback for text
    that cannot take that machinery, and size+color are what it can carry
    honestly.
    """
    if size is None and color is None:
        raise ValueError("nothing to restyle — give a size and/or a color")
    if size is not None:
        size = float(size)
        if not (0.1 <= size <= 1000):
            raise ValueError("size must be between 0.1 and 1000 points")
    if color is not None:
        color = [float(c) for c in color]
        if len(color) != 3 or any(c < 0 or c > 1 for c in color):
            raise ValueError("color must be [r, g, b] with components in 0..1")

    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        fonts = _FontCache()
        pre_runs = _walk_runs(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False, fonts
        )
        count = len(pre_runs)
        if not (0 <= int(index) < count):
            raise ValueError(f"text run index {index} is out of range (page has {count})")

        # Same text, new style — the edit state re-encodes the run's own
        # decoded text through its own font, so encodability is a no-op.
        edit = _TextEditState(int(index), str(pre_runs[int(index)]["text"]))
        edit.style_size = size
        edit.style_color = color
        kept, changed, new_forms = _rewrite_runs(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            0,
            None,
            edit,
            fonts,
            [0],
            set(),
        )
        if not changed:
            raise ValueError("restyle did not apply (run not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, edit.superseded_forms)
        _save(pdf, input_path, output_path)
        return {
            "output": str(output_path),
            "page": int(page),
            "index": int(index),
            **({"size": size} if size is not None else {}),
            **({"color": color} if color is not None else {}),
        }
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def convert_text_run(
    file: str, output: str, page: int, index: int, new_text: str, font_path: str
) -> dict:
    """Replace one run's text RENDERED IN THE BUNDLED FALLBACK FONT —
    the path the UI offers when the run's own font cannot express the typed
    characters. Same targeting, Δ math, anchors, and form copy-on-edit as
    `replace_text_run`; only the replacement renderer differs (a subsetted
    Type0/Identity-H embed + a Tf restoring the original font after)."""
    from engine.font_fallback import build_fallback_font, resolve_fallback_font

    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        fonts = _FontCache()
        pre_runs = _walk_runs(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False, fonts
        )
        count = len(pre_runs)
        if not (0 <= int(index) < count):
            raise ValueError(f"text run index {index} is out of range (page has {count})")

        counter = [0]
        reserved: set = set()
        holder: dict = {}

        def builder(pdf_, stream_resources, gts, text):
            # Pick the fallback FACE matching the run's own
            # font (serif/sans/mono) so a serif document's converted text
            # stays serif. `font_path` is the vendored fonts DIR from the
            # app; a concrete .ttf (tests) passes through untouched. The
            # page `resources` back the lookup when a nested form's font
            # lives there.
            original = _lookup_font(gts.font_name, stream_resources, resources)
            face = resolve_fallback_font(font_path, original, text=text)
            font_dict, encode, width_1000 = build_fallback_font(pdf_, face, text)
            fname = _fresh_font_name(stream_resources, counter, reserved)
            holder["edit"].pending_font = (fname, font_dict)
            encoded = encode(text)
            # CID font: Tw never applies (no single-byte space); Tc applies
            # per code (2-byte codes).
            new_raw = (
                width_1000(text) / 1000.0 * gts.font_size
                + gts.char_spacing * (len(encoded) // 2)
            )
            instructions = [
                _instruction([Name(fname), gts.font_size], "Tf"),
                _instruction([pikepdf.String(encoded)], "Tj"),
            ]
            if gts.font_name:
                # Restore the run's original font — subsequent runs must be
                # byte-untouched by the fallback.
                instructions.append(_instruction([Name(gts.font_name), gts.font_size], "Tf"))
            return instructions, new_raw

        edit = _TextEditState(int(index), str(new_text), builder=builder)
        holder["edit"] = edit
        kept, changed, new_forms = _rewrite_runs(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            0,
            None,
            edit,
            fonts,
            counter,
            reserved,
        )
        if not changed:
            raise ValueError("edit did not apply (run not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, edit.superseded_forms)
        # A TOP-LEVEL target's font registers against the page resources —
        # the nested case already registered into the form COPY. Detect by
        # the Tf name appearing in the page-level instructions.
        if edit.pending_font is not None:
            fname, fdict = edit.pending_font
            if any(
                str(i.operator) == "Tf" and i.operands and str(i.operands[0]) == fname
                for i in kept
            ):
                _register_font(pdf, resources, fname, fdict)
        # Guard AFTER font+form registration — the walk needs the fallback
        # face resolvable to width the new run (fresh cache: the rewrite
        # registered new names this page-scoped cache has never seen).
        _refuse_offpage_retype(
            pdf, p, resources, _FontCache(), kept, int(index), pre_runs[int(index)]["rect"]
        )
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass
