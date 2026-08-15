"""Overprint — the graphics-state flag nothing in this app read.

`/ExtGState /OP`, `/op` and `/OPM` decide whether a paint knocks out what is
under it or lays down on top of it. The only occurrence of those keys anywhere
else in the engine WRITES one, for the colour bar's own control patch; nothing
reported them, so an overprinting white headline — a real and expensive press
defect — passed preflight silently.

**A verdict here is only ever as certain as the ink.** "White text set to
overprint" is determinate exactly where the ink is provably zero-tint in a
space that resolved: a tint of 0 in a `/Separation` is white, a `/DeviceN` at
0 across its components is white, `0 0 0 0 k` is white — and an ICC, indexed
or otherwise unresolvable value is NOT knowable. Reporting one of those as
white would fail a design that is correct, so `zero_tint` is a third state and
the caller reports `needs_review` for it rather than `fail`.

The walk is this module's own and it is small: no CTM, no text matrix, no
glyph metrics. It tracks the graphics-state stack, the colour in force and the
paint operators, because that is the whole question. It is NOT a second copy
of `sanitize_content`'s analysis walk — that walk emits a paint event only
where the paint can serve as a BACKDROP (opaque, axis-aligned), which is the
wrong filter here: an overprinting white headline is precisely the paint it
discards.

A form XObject is walked with its own resources; a stream that will not parse
is reported through `unreadable` and never counted as clean.
"""

from __future__ import annotations

import pikepdf

from engine.color_spaces import build_resolver

_MAX_DEPTH = 8
_EPS = 1e-6

#: Operators that lay ink down. A path-painting operator that only clips
#: (`n`, `W n`) paints nothing and is not an overprint question.
_FILL_OPS = frozenset({"f", "F", "f*", "B", "B*", "b", "b*"})
_STROKE_OPS = frozenset({"S", "s", "B", "B*", "b", "b*"})
_TEXT_OPS = frozenset({"Tj", "TJ", "'", '"'})

#: Text render modes that lay fill ink down (0 fill, 2 fill+stroke, 4/6 with
#: clipping). 3 and 7 paint nothing; 1 and 5 stroke only.
_TEXT_FILL_MODES = frozenset({0, 2, 4, 6})
_TEXT_STROKE_MODES = frozenset({1, 2, 5, 6})


def _family_of(cs) -> str:
    """The colour-space FAMILY name, which is what decides whether a tint of
    zero means "no ink" — the sRGB the resolver produces cannot say."""
    if isinstance(cs, (str, pikepdf.Name)):
        return str(cs).lstrip("/")
    if isinstance(cs, pikepdf.Array) and len(cs) > 0:
        try:
            return str(cs[0]).lstrip("/")
        except Exception:
            return ""
    return ""


def resolve_ink(space_op, value_op, resources) -> tuple:
    """`(family, components)` for a captured colour state, or `("", None)`.

    Device operators (`g`/`rg`/`k`) name their family outright; `cs` + `scn`
    resolves the name against the stream's `/ColorSpace`. A pattern operand is
    not a flat colour and reports unknown.
    """
    if value_op is None:
        # Nothing set and no non-device space selected is the stream default,
        # device-gray black — which is ink, not white.
        return ("DeviceGray", [0.0]) if space_op is None else ("", None)
    op, vals = value_op
    lowered = str(op).lower()
    if lowered in ("g", "rg", "k"):
        try:
            nums = [float(v) for v in vals]
        except (TypeError, ValueError):
            return ("", None)
        family = {"g": "DeviceGray", "rg": "DeviceRGB", "k": "DeviceCMYK"}[lowered]
        expected = {"DeviceGray": 1, "DeviceRGB": 3, "DeviceCMYK": 4}[family]
        return (family, nums) if len(nums) == expected else ("", None)
    if lowered not in ("sc", "scn"):
        return ("", None)
    if space_op is None:
        return ("", None)
    sname_op, sname_vals = space_op[0], space_op[1]
    if str(sname_op).lower() != "cs" or not sname_vals:
        return ("", None)
    name = sname_vals[0]
    if not isinstance(name, str):
        return ("", None)
    if any(isinstance(v, str) for v in vals):
        return ("", None)  # a pattern operand — not a flat colour
    comps = [float(v) for v in vals if isinstance(v, (int, float))]
    family = name.lstrip("/")
    if family not in ("DeviceGray", "DeviceRGB", "DeviceCMYK"):
        target = None
        if resources is not None:
            try:
                table = resources.get("/ColorSpace")
                if table is not None:
                    target = table.get(pikepdf.Name(name))
            except Exception:
                target = None
        if target is None:
            return ("", None)
        family = _family_of(target)
    return (family, comps) if family else ("", None)


def is_zero_tint(family: str, components) -> bool | None:
    """True when the ink is provably nothing, False when it is provably
    something, None when the space could not say.

    None is the discriminator the whole check rests on: it is what keeps a
    correct design out of the failure list.
    """
    if not family or components is None:
        return None
    values = [float(v) for v in components]
    if family in ("DeviceGray", "CalGray"):
        return values[0] >= 1.0 - _EPS if len(values) == 1 else None
    if family in ("DeviceRGB", "CalRGB"):
        return all(v >= 1.0 - _EPS for v in values) if len(values) == 3 else None
    if family == "DeviceCMYK":
        return all(v <= _EPS for v in values) if len(values) == 4 else None
    if family in ("Separation", "DeviceN"):
        return all(v <= _EPS for v in values) if values else None
    return None


def ink_count(family: str, components, resources=None) -> int | None:
    """How many inks this colour lays down, or None where the space cannot
    say. `DeviceCMYK` is the case check 24 exists for: a rich black resolves
    to the same sRGB as a K-only one and reads identically on screen, while
    only one of the two holds registration on a press."""
    if not family or components is None:
        return None
    values = [float(v) for v in components]
    if family in ("DeviceGray", "CalGray"):
        return 0 if values and values[0] >= 1.0 - _EPS else 1
    if family == "DeviceCMYK":
        return sum(1 for v in values if v > _EPS) if len(values) == 4 else None
    if family in ("Separation", "DeviceN"):
        return sum(1 for v in values if v > _EPS)
    return None


class _State:
    """The graphics state this walk cares about, stacked with q/Q."""

    __slots__ = ("fill_op", "fill_value", "stroke_op", "stroke_value",
                 "fill_over", "stroke_over", "opm", "mode")

    def __init__(self):
        self.fill_op = None
        self.fill_value = None
        self.stroke_op = None
        self.stroke_value = None
        self.fill_over = False
        self.stroke_over = False
        self.opm = 0
        self.mode = 0

    def copy(self) -> "_State":
        out = _State()
        for slot in self.__slots__:
            setattr(out, slot, getattr(self, slot))
        return out


def _gs_overprint(resources, name) -> dict:
    """The overprint entries of one `/ExtGState`, or an empty answer."""
    try:
        table = resources.get("/ExtGState") if resources is not None else None
        entry = table.get(pikepdf.Name(str(name))) if table is not None else None
    except Exception:
        return {}
    if entry is None:
        return {}
    out: dict = {}
    try:
        if "/OP" in entry:
            out["OP"] = bool(entry["/OP"])
        if "/op" in entry:
            out["op"] = bool(entry["/op"])
        if "/OPM" in entry:
            out["OPM"] = int(entry["/OPM"])
    except Exception:
        return {}
    return out


def _walk(pdf, instructions, resources, state, depth, page_no, rows, unreadable,
          seen) -> None:
    stack: list = []
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)

        if operator == "q":
            stack.append(state.copy())
            continue
        if operator == "Q":
            if stack:
                restored = stack.pop()
                for slot in _State.__slots__:
                    setattr(state, slot, getattr(restored, slot))
            continue
        if operator == "gs" and operands:
            entries = _gs_overprint(resources, operands[0])
            if "OP" in entries:
                state.stroke_over = entries["OP"]
                # /op defaults to /OP's value until /op is given its own.
                if "op" not in entries:
                    state.fill_over = entries["OP"]
            if "op" in entries:
                state.fill_over = entries["op"]
            if "OPM" in entries:
                state.opm = entries["OPM"]
            continue
        lowered = operator.lower()
        if operator in ("g", "rg", "k"):
            state.fill_op, state.fill_value = None, (operator, operands)
            continue
        if operator in ("G", "RG", "K"):
            state.stroke_op, state.stroke_value = None, (operator, operands)
            continue
        if operator == "cs":
            state.fill_op, state.fill_value = ("cs", operands), None
            continue
        if operator == "CS":
            state.stroke_op, state.stroke_value = ("cs", operands), None
            continue
        if lowered in ("sc", "scn"):
            if operator.islower():
                state.fill_value = (operator, operands)
            else:
                state.stroke_value = (operator, operands)
            continue
        if operator == "Tr" and operands:
            try:
                state.mode = int(operands[0])
            except (TypeError, ValueError):
                state.mode = 0
            continue

        if operator == "Do" and operands:
            if depth >= _MAX_DEPTH:
                unreadable.append(
                    f"page {page_no}: a form nests deeper than {_MAX_DEPTH} levels"
                )
                continue
            try:
                table = resources.get("/XObject") if resources is not None else None
                xobj = table.get(pikepdf.Name(str(operands[0]))) if table is not None else None
                if xobj is None or str(xobj.get("/Subtype")) != "/Form":
                    continue
                ident = xobj.objgen if getattr(xobj, "is_indirect", False) else id(xobj)
                if ident in seen:
                    continue
                seen.add(ident)
                inner = xobj.get("/Resources") or resources
                _walk(pdf, pikepdf.parse_content_stream(xobj), inner, state.copy(),
                      depth + 1, page_no, rows, unreadable, seen)
            except Exception as exc:
                unreadable.append(f"page {page_no}: a form will not read: {exc}")
            continue

        painting_fill = operator in _FILL_OPS
        painting_stroke = operator in _STROKE_OPS
        if operator in _TEXT_OPS:
            painting_fill = state.mode in _TEXT_FILL_MODES
            painting_stroke = state.mode in _TEXT_STROKE_MODES
        if not (painting_fill or painting_stroke):
            continue
        text = operator in _TEXT_OPS
        if painting_fill and state.fill_over:
            rows.append(_row(page_no, "fill", text, state.fill_op,
                             state.fill_value, resources, state.opm))
        if painting_stroke and state.stroke_over:
            rows.append(_row(page_no, "stroke", text, state.stroke_op,
                             state.stroke_value, resources, state.opm))


def _row(page_no, channel, text, space_op, value_op, resources, opm) -> dict:
    family, components = resolve_ink(space_op, value_op, resources)
    zero = is_zero_tint(family, components)
    return {
        "page": page_no,
        "channel": channel,
        "text": bool(text),
        "family": family,
        "components": [round(float(v), 4) for v in components] if components else [],
        # True = provably no ink, False = provably ink, None = the space could
        # not say and the caller must not guess.
        "zero_tint": zero,
        "opm": int(opm),
    }


def list_overprint(file: str, pages=None) -> dict:
    """Every overprinting paint in the document, with the ink in force.

    `states` is the fail-closed half: a `/ExtGState` that turns overprint on
    exists whether or not this walk reached the stream that applies it, so a
    document with states and no paints has not been shown to be clean.
    """
    rows: list = []
    unreadable: list = []
    states: list = []
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        numbers = (
            list(range(1, total + 1))
            if pages is None
            else [int(p) for p in pages if 1 <= int(p) <= total]
        )
        for number in numbers:
            page = pdf.pages[number - 1]
            states.extend(_declared_states(page, number, unreadable))
            try:
                resources = page.obj.get("/Resources")
                instructions = pikepdf.parse_content_stream(page)
            except Exception as exc:
                unreadable.append(f"page {number} will not parse: {exc}")
                continue
            try:
                _walk(pdf, instructions, resources, _State(), 0, number, rows,
                      unreadable, set())
            except Exception as exc:
                unreadable.append(f"page {number} will not parse: {exc}")
    return {
        "file": file,
        "paints": rows,
        "states": states,
        "count": len(rows),
        "unreadable": unreadable,
    }


def _declared_states(page, number: int, unreadable: list) -> list:
    """The `/ExtGState` entries on this page that turn overprint on.

    Read through the shared resource walk, so a state reached only through a
    nested form, a pattern or an annotation appearance is still found.
    """
    from engine.preflight import TRANSPARENCY, walk_page_resources

    found: list = []

    def on_extgstate(gs, _category) -> None:
        try:
            on = bool(gs.get("/OP")) or bool(gs.get("/op"))
        except Exception as exc:
            unreadable.append(f"page {number}: a graphics state will not read: {exc}")
            return
        if on:
            found.append({"page": number})

    def on_unreadable(facts, reason) -> None:
        if TRANSPARENCY in facts:
            unreadable.append(f"page {number}: {reason}")

    walk_page_resources(page, on_extgstate=on_extgstate, on_unreadable=on_unreadable)
    return found
