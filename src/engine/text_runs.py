"""Text-run listing and in-place replacement (Phase 7.2+7.3 — Edit Text).

A "run" is one text-showing operator (Tj / ' / " / TJ), the unit the user
clicks. Ids are the DFS show-op encounter order (page stream first, forms
recursed at their Do position) — the same index-agreement discipline as
page_images.py, proven there and pinned here by the same style of tests.

Listing decodes each run through its font's capability (pdf_fonts.py) and
computes REAL geometry: glyph advances from the font's widths (+ TJ kern,
Tc char spacing, Tw word spacing on the single-byte space code, Tz), so
run rects are accurate and the Δwidth math is honest — unlike redaction's
deliberately-wide estimate, editing must know actual widths.

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
    adjustment. Cross-line reflow is 7.5, deliberately.
  - vertical runs (9.B4a — Identity-V/UCS2-V capabilities) list with
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
from engine.pdf_fonts import FontCapability, font_capability
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

SHOW_OPS = ("Tj", "'", '"', "TJ")


# ── font resolution (cached per call) ─────────────────────────────────────


class _FontCache:
    def __init__(self):
        self._by_key: dict = {}

    def capability(self, resources, fallback_resources, name) -> FontCapability | None:
        if not name:
            return None
        font_obj = _lookup_font(name, resources, fallback_resources)
        if font_obj is None:
            return None
        # Key on stable identity ONLY. `objgen` is value-based for indirect
        # fonts; a DIRECT font dict's wrapper is a fresh pikepdf object per
        # access, so id(font_obj) recycles across GC and served a STALE
        # OTHER FONT's capability — review-measured at 22.6% wrong lookups
        # in an alternating-font walk, and on replace it would encode the
        # user's text with the wrong font's table into the saved file. The
        # resources dicts are stable Python references for the whole walk
        # scope, so (resources ids + name) is a sound direct-font key.
        try:
            is_indirect = bool(font_obj.is_indirect)
        except AttributeError:
            is_indirect = False
        key = (
            ("obj", font_obj.objgen)
            if is_indirect
            else ("direct", id(resources), id(fallback_resources), str(name))
        )
        if key not in self._by_key:
            try:
                self._by_key[key] = font_capability(font_obj)
            except Exception as exc:  # a malformed font dict refuses, never crashes
                self._by_key[key] = FontCapability(
                    False, f"unreadable font ({exc})", {}, {}, {}, 500.0, 1
                )
        return self._by_key[key]


def _lookup_font(name, resources, fallback_resources):
    for res in (resources, fallback_resources):
        if res is None:
            continue
        fonts = res.get("/Font")
        if fonts is not None and Name(name) in fonts:
            return fonts[Name(name)]
    return None


# ── show-op decoding + width ──────────────────────────────────────────────


def _operand_bytes(el) -> bytes:
    try:
        return bytes(el)
    except (TypeError, ValueError):
        return b""


def _show_segments(operator: str, operands: list) -> list:
    """The show op's content as [bytes | float] — strings and (for TJ)
    kern numbers, in order."""
    if operator == "TJ":
        arr = operands[0] if operands else []
        out: list = []
        try:
            for el in arr:
                try:
                    out.append(float(el))
                except (TypeError, ValueError):
                    out.append(_operand_bytes(el))
        except TypeError:
            return []
        return out
    return [_operand_bytes(operands[-1])] if operands else []


def _spaces_in(data: bytes, cap: FontCapability) -> int:
    # Tw applies to the SINGLE-BYTE code 32 only (spec) — never CID fonts.
    if cap._code_bytes != 1:
        return 0
    return data.count(0x20)


def _run_metrics(
    operator: str, operands: list, cap: FontCapability | None, state: GraphicsTextState
) -> tuple[str, float]:
    """(decoded_text, raw_width) where raw_width is in TEXT-SPACE units
    BEFORE Tz (advance_after_show applies h_scale)."""
    text_parts: list[str] = []
    width = 0.0
    for seg in _show_segments(operator, operands):
        if isinstance(seg, float):
            width -= seg / 1000.0 * state.font_size
            continue
        if cap is not None:
            text_parts.append(cap.decode(seg))
            width += cap.decoded_width(seg) / 1000.0 * state.font_size
            n_codes = len(seg) if cap._code_bytes == 1 else len(seg) // 2
            width += state.char_spacing * n_codes
            width += state.word_spacing * _spaces_in(seg, cap)
        else:
            width += len(seg) * state.font_size * 0.5  # redact's estimate
    return "".join(text_parts), width


# ── listing ───────────────────────────────────────────────────────────────


def _child_state(base_ctm, parent: GraphicsTextState | None) -> GraphicsTextState:
    """A form's stream starts with the INVOKING stream's text parameters —
    font, size, leading, Tz, Tc/Tw (and 7.5's Tr/Ts/colors) are graphics
    state a form inherits at its Do (the _redact_form rule); tm/tlm reset
    per stream."""
    if parent is None:
        return GraphicsTextState(base_ctm)
    child = GraphicsTextState(
        base_ctm, parent.font_size, parent.leading, parent.h_scale, parent.font_name
    )
    child.char_spacing = parent.char_spacing
    child.word_spacing = parent.word_spacing
    child.render_mode = parent.render_mode
    child.rise = parent.rise
    child.fill_color = parent.fill_color
    child.stroke_color = parent.stroke_color
    return child


def _style_of(state: GraphicsTextState) -> dict:
    """The re-emittable text state at a show op (7.5's span style)."""
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
    """_show_segments detached from pikepdf (bytes/float only) so 7.5's
    analysis can outlive the walk."""
    out: list = []
    for seg in _show_segments(operator, operands):
        out.append(seg if isinstance(seg, float) else bytes(seg))
    return out


def _walk_runs(pdf, instructions, resources, base_ctm, depth, fallback, out, nested, fonts, parent_state=None, detail=None, stream_path=(), base_clip=None):
    state = _child_state(base_ctm, parent_state)
    # 9-§I.0-S8: clip tracking rides ADDITIVELY beside the state machine so a
    # run wholly outside the active clip lists as `clipped` (invisible) and the
    # renderer stops offering it as editable. `base_clip` is the parent stream's
    # device-space clip a nested form inherits (§8.10.2).
    clips = ClipTracker(base_clip)
    # Stream identity for 7.5: the path of LOCAL form ordinals (the nth
    # qualifying Do within its parent stream) from the page down. Local —
    # not a global DFS id — so a rewriter can NAVIGATE to one stream and
    # leave every other form untouched and unvisited.
    local_form_ordinal = 0
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        # Fed with the CURRENT ctm BEFORE state.feed (which consumes-and-
        # continues past q/Q/cm) — path-point ops never move the CTM.
        clips.feed(operator, operands, state.ctm)
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
                # 9.B4a v1 rect: a vertical run occupies one em-wide column
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
                    # 9.B5, additive: the ligature sequences encode() will
                    # round-trip — the renderer's longest-match validation
                    # reads these next to `encodable`. [] when none/refused.
                    "sequences": cap.encodable_sequences() if (cap and cap.editable) else [],
                    # 9.B4a, additive: True when this run's advances/rect
                    # were computed in vertical-writing mode (B4b's surface
                    # reads it). A refused vertical font reports False —
                    # the field describes the geometry actually computed.
                    "vertical": vertical,
                    # 9-§I.0-S8, additive: True when the run's bbox is fully
                    # outside the active clip (invisible). The renderer filters
                    # these out so clipped-away text is never offered as
                    # editable; the index space is UNCHANGED (the mutators'
                    # count agreement is untouched).
                    "clipped": clips.clips_away((x0, y0, x1, y1)),
                }
            )
            if detail is not None:
                # 7.5's rich channel — SAME walk, so run index agreement
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
                        # FontCache used above. 9.B1's paragraph family
                        # classification needs form scope: a form's `F1` can
                        # differ from the page's `F1` (review-caught).
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
        # Optional replacement renderer (7.4): (pdf, resources, gts, text)
        # -> (instructions, new_raw_width). None = re-encode in the run's
        # own font (7.2's path).
        self.builder = builder
        self.seen = 0
        self.done = False
        # Set at the edit site; consumed by the same-line anchor pass.
        self.delta_scaled = 0.0  # Δ advance in text-space units incl. Tz
        # 9.B4a: True when the edited run's font is vertical — the anchor
        # pass transposes (same-COLUMN followers shift in ty; Tz does not
        # scale delta_scaled).
        self.vertical = False
        # (name, font_dict) a 7.4 builder produced — registered by the
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
                        # 9.B4a: the same-line rule TRANSPOSED — a
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
                        # every subsequent Td compounded the shift (word 3
                        # moved 2Δ, word 4 moved 3Δ — proven live with a
                        # three-word probe before the fix).
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
                # ESTIMATED old width into Δ and misplaced followers
                # (review-caught; the UI never reaches it, the contract
                # must hold anyway).
                if cap is None:
                    raise ValueError("no font is active for this text run")
                if not cap.editable:
                    raise ValueError(cap.reason or "this text is not editable")
                edit.vertical = bool(cap.vertical)
                if edit.vertical and edit.builder is not None:
                    # 9.B4a: the 7.4 fallback builder embeds a HORIZONTAL
                    # Identity-H face — dropped into a vertical column it
                    # would render on the wrong axis. Fail closed (the
                    # builder-path guard discipline above).
                    raise ValueError(
                        "vertical text cannot be converted to the fallback font"
                    )
                _old_text, old_raw = _run_metrics(operator, operands, cap, gts)
                if edit.builder is not None:
                    # 7.4 fallback path: the builder renders the replacement
                    # its own way (new embedded font + restore Tf); it owns
                    # registration against THIS stream's resources.
                    new_instructions, new_raw = edit.builder(
                        pdf, resources, gts, edit.new_text
                    )
                    kept.extend(new_instructions)
                else:
                    encoded = cap.encode(edit.new_text)
                    new_raw = (
                        cap.decoded_width(encoded) / 1000.0 * gts.font_size
                        + gts.char_spacing
                        * (len(encoded) if cap._code_bytes == 1 else len(encoded) // 2)
                        + gts.word_spacing * _spaces_in(encoded, cap)
                    )
                    kept.append(_instruction([pikepdf.String(encoded)], "Tj"))
                # 9.B4a: Tz never scales vertical advances, so the vertical
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


def convert_text_run(
    file: str, output: str, page: int, index: int, new_text: str, font_path: str
) -> dict:
    """Replace one run's text RENDERED IN THE BUNDLED FALLBACK FONT (7.4) —
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
            # Phase 9.B1: pick the fallback FACE matching the run's own
            # font (serif/sans/mono) so a serif document's converted text
            # stays serif. `font_path` is the vendored fonts DIR from the
            # app; a concrete .ttf (tests) passes through untouched. The
            # page `resources` back the lookup when a nested form's font
            # lives there.
            original = _lookup_font(gts.font_name, stream_resources, resources)
            face = resolve_fallback_font(font_path, original)
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
