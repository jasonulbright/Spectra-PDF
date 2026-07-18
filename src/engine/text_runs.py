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
  - a run inside a Form XObject edits a COPY of the form for that draw
    (the page_images.py pattern verbatim).

Empty `new_text` is allowed — it deletes the run's text (negative Δ pulls
same-line anchors back).
"""

from pathlib import Path

import pikepdf
from pikepdf import Name

from engine.content_walk import GraphicsTextState
from engine.pdf_fonts import FontCapability, font_capability
from engine.page_images import _fresh_name, _register_xobject, _save
from engine.redact import (
    IDENTITY,
    MAX_FORM_DEPTH,
    _as_matrix,
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
        try:
            key = font_obj.objgen if font_obj.is_indirect else id(font_obj)
        except AttributeError:
            key = id(font_obj)
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
    font, size, leading, Tz, Tc/Tw are graphics state a form inherits at
    its Do (the _redact_form rule); tm/tlm reset per stream."""
    if parent is None:
        return GraphicsTextState(base_ctm)
    child = GraphicsTextState(
        base_ctm, parent.font_size, parent.leading, parent.h_scale, parent.font_name
    )
    child.char_spacing = parent.char_spacing
    child.word_spacing = parent.word_spacing
    return child


def _walk_runs(pdf, instructions, resources, base_ctm, depth, fallback, out, nested, fonts, parent_state=None):
    state = _child_state(base_ctm, parent_state)
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)
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
                }
            )
            state.advance_after_show(raw_width)
        elif operator == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback)
            subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""
            if xobj is not None and subtype == "/Form" and depth < MAX_FORM_DEPTH:
                form_matrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
                form_res = xobj.get("/Resources")
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
    def __init__(self, target: int, new_text: str):
        self.target = target
        self.new_text = new_text
        self.seen = 0
        self.done = False
        # Set at the edit site; consumed by the same-line anchor pass.
        self.delta_scaled = 0.0  # Δ advance in text-space units incl. Tz


def _instruction(operands: list, operator: str):
    return pikepdf.ContentStreamInstruction(operands, pikepdf.Operator(operator))


def _rewrite_runs(pdf, instructions, resources, depth, fallback, edit, fonts, counter, reserved, parent_state=None):
    """(kept, changed). Mirrors _walk_runs's counting exactly (its OWN
    per-stream state machine, inheriting like the lister — a shared or
    global state across recursion levels would corrupt both the width math
    and the count agreement); applies the edit at the target and Δ-adjusts
    subsequent same-line Td/TD anchors within this stream."""
    gts = _child_state(IDENTITY if parent_state is None else parent_state.ctm, parent_state)
    kept: list = []
    changed = False
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
                    if ty == 0.0:
                        gts.feed(operator, operands)
                        kept.append(
                            _instruction([tx + edit.delta_scaled, ty], operator)
                        )
                        continue
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
                if cap is None:
                    raise ValueError("no font is active for this text run")
                if not cap.editable:
                    raise ValueError(cap.reason or "this text is not editable")
                encoded = cap.encode(edit.new_text)

                _old_text, old_raw = _run_metrics(operator, operands, cap, gts)
                new_raw = (
                    cap.decoded_width(encoded) / 1000.0 * gts.font_size
                    + gts.char_spacing
                    * (len(encoded) if cap._code_bytes == 1 else len(encoded) // 2)
                    + gts.word_spacing * _spaces_in(encoded, cap)
                )
                edit.delta_scaled = (new_raw - old_raw) * gts.h_scale
                kept.append(_instruction([pikepdf.String(encoded)], "Tj"))
                gts.advance_after_show(new_raw)
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
            gts.advance_after_show(raw)
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
                inner_kept, inner_changed = _rewrite_runs(
                    pdf,
                    pikepdf.parse_content_stream(xobj),
                    read_res,
                    depth + 1,
                    resources,
                    edit,
                    fonts,
                    counter,
                    reserved,
                    parent_state=gts,
                )
                if inner_changed:
                    changed = True
                    copy = pdf.make_stream(pikepdf.unparse_content_stream(inner_kept))
                    for key in xobj.keys():
                        if key in ("/Length", "/Filter", "/DecodeParms", "/Resources"):
                            continue
                        copy[key] = xobj[key]
                    copy["/Resources"] = _copy_resources_for_write(pdf, read_res)
                    new_name = _fresh_name(resources, counter, reserved)
                    _register_xobject(pdf, resources, new_name, copy)
                    kept.append(_instruction([Name(new_name)], "Do"))
                    continue
            kept.append(instruction)
            continue

        gts.feed(operator, operands)
        kept.append(instruction)
    return kept, changed


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
        count = len(
            _walk_runs(
                pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False, fonts
            )
        )
        if not (0 <= int(index) < count):
            raise ValueError(f"text run index {index} is out of range (page has {count})")

        edit = _TextEditState(int(index), str(new_text))
        kept, changed = _rewrite_runs(
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
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass
