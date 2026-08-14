"""Emitter: an authored format/validate/calculate choice -> the stock `/JS`
bodies, plus the `/CO` order those calculations run in.

The Python half of the authoring twin; ``src/renderer/lib/af-emit.ts`` is the
same table and the same ordering rule, and the two are pinned string for string
against ``tests/fixtures/af-corpus.json``'s ``emit`` section.

Two properties this module exists to hold:

* **Byte compatibility.** The bodies written here are the call shapes the
  ecosystem writes, so every other viewer executes what this app authors. The
  templates are literal per kind -- never assembled from a computation -- and
  every emitted body is fed back through ``engine.afscript.recognize`` by the
  corpus, so a body this app writes is always a body this app runs.
* **A declared calculation order.** ``/CO`` is the author's order and a
  conforming viewer runs it once. It is derived here by a topological sort over
  the dependency graph, never by appending: a field placed before the fields it
  reads computes a stale value in every viewer.

Pure over plain values: no ``pikepdf``, no file paths. The writers translate
what comes back into objects.
"""

from engine.afcalc import as_stored, make_number
from engine.afscript import ENTRY_POINTS, recognize, sfn_fields

#: Format and Validate belong to the kinds that carry a typed value; Calculate
#: writes one, which only a text field can hold.
FORMAT_TYPES = ("text", "dropdown")
VALIDATE_TYPES = ("text", "dropdown")
CALCULATE_TYPES = ("text",)

#: `AFSimple_Calculate`'s functions, in the reference's own spelling.
CALC_FUNCTIONS = ("SUM", "PRD", "AVG", "MIN", "MAX")

FORMAT_KINDS = ("number", "percent", "date", "time", "special", "mask")

#: `AFSpecial_Format` / `AFSpecial_Keystroke`'s fixed masks, by index.
SPECIAL_KINDS = (0, 1, 2, 3)

SEP_STYLES = (0, 1, 2, 3, 4)
NEG_STYLES = (0, 1, 2, 3)

#: The format a DETECTED date field is authored with. Detection says only that
#: a label announces a date; the mask is a choice, and this is the one the
#: ecosystem writes by default. The reviewer can change it before creating.
DETECTED_DATE_FORMAT = {"kind": "date", "mask": "mm/dd/yy"}

#: Beyond this the reference's own printf spec stops producing a number.
MAX_DECIMALS = 15


class EmitError(ValueError):
    """An authored action that cannot become a script.

    ``problems`` is the same list-of-strings shape ``FieldSpecError`` carries,
    so a batch reports every problem at once whichever half found it.
    """

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = list(problems)


class CycleError(ValueError):
    """A calculation that depends on itself, with the chain that proves it."""

    def __init__(self, chain: list[str]):
        super().__init__(" -> ".join(chain))
        self.chain = list(chain)


# -- literals --------------------------------------------------------------


def js_string(text: str) -> str:
    """A JavaScript string literal in the escaping the recognizer accepts.

    Double quotes throughout: that is what the ecosystem writes, and a name
    carrying an apostrophe then needs no escape at all.
    """
    out = ['"']
    for ch in str(text):
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def js_number(value) -> str:
    """A numeric literal, through the same Number->String rule the evaluator
    stores values by, so both halves of the twin spell 2.5 the same way."""
    number = make_number(value)
    if number is None:
        raise EmitError([f"{value!r} is not a number"])
    return as_stored(number)


def _int_in(value, allowed, label: str) -> int:
    number = make_number(value)
    if number is None or int(number) != number or int(number) not in allowed:
        raise EmitError([f"{label} must be one of {', '.join(str(a) for a in allowed)}"])
    return int(number)


# -- format ----------------------------------------------------------------


def format_scripts(fmt: dict) -> dict:
    """``{"F": body, "K": body}`` for a format choice.

    The Format and Keystroke halves are written as a PAIR: a `/F` with no `/K`
    leaves input validation off in every viewer, which is not what the author
    chose. ``mask`` is the one keystroke-only kind -- an arbitrary mask
    constrains typing and has no display form.
    """
    kind = str((fmt or {}).get("kind", ""))
    if kind not in FORMAT_KINDS:
        raise EmitError([f"unknown format {kind or '(none)'}"])
    if kind == "number":
        decimals = _int_in(fmt.get("decimals", 2), range(0, MAX_DECIMALS + 1), "decimals")
        sep = _int_in(fmt.get("sep_style", 0), SEP_STYLES, "separator style")
        neg = _int_in(fmt.get("neg_style", 0), NEG_STYLES, "negative style")
        currency = js_string(fmt.get("currency", "") or "")
        prepend = "true" if fmt.get("currency_prepend") else "false"
        # currStyle (the fourth argument) is legacy and ignored by the
        # reference; the ecosystem writes 0 and so do we.
        args = f"{decimals}, {sep}, {neg}, 0, {currency}, {prepend}"
        return {"F": f"AFNumber_Format({args});", "K": f"AFNumber_Keystroke({args});"}
    if kind == "percent":
        decimals = _int_in(fmt.get("decimals", 2), range(0, MAX_DECIMALS + 1), "decimals")
        sep = _int_in(fmt.get("sep_style", 0), SEP_STYLES, "separator style")
        # The third argument is written only when it is chosen: two arguments
        # is the shape the ecosystem writes, and the reference defaults it.
        tail = ", true" if fmt.get("prepend") else ""
        return {
            "F": f"AFPercent_Format({decimals}, {sep}{tail});",
            "K": f"AFPercent_Keystroke({decimals}, {sep});",
        }
    if kind in ("date", "time"):
        mask = str(fmt.get("mask", "") or "")
        if not mask:
            raise EmitError([f"a {kind} format needs a mask"])
        # The Ex forms carry the mask literally. The index form
        # (`AFDate_Format(n)`) is accepted on read and never written: it
        # depends on a table index a future reader might number differently.
        prefix = "AFDate" if kind == "date" else "AFTime"
        return {
            "F": f"{prefix}_FormatEx({js_string(mask)});",
            "K": f"{prefix}_KeystrokeEx({js_string(mask)});",
        }
    if kind == "special":
        psf = _int_in(fmt.get("psf", 0), SPECIAL_KINDS, "special format")
        return {
            "F": f"AFSpecial_Format({psf});",
            "K": f"AFSpecial_Keystroke({psf});",
        }
    mask = str(fmt.get("mask", "") or "")
    if not mask:
        raise EmitError(["a mask format needs a mask"])
    return {"K": f"AFSpecial_KeystrokeEx({js_string(mask)});"}


# -- validate --------------------------------------------------------------


def validate_script(rule: dict) -> str:
    """``AFRange_Validate`` for a min, a max, or both.

    Neither bound REFUSES rather than emitting ``(false, 0, false, 0)``: the
    reference's final branch is unguarded, so that call rejects every value
    above zero -- a script that silently means something else.
    """
    rule = rule or {}
    low = rule.get("min")
    high = rule.get("max")
    has_low = low is not None and low != ""
    has_high = high is not None and high != ""
    if not has_low and not has_high:
        raise EmitError(["a range needs a smallest value, a largest value, or both"])
    low_number = make_number(low) if has_low else None
    high_number = make_number(high) if has_high else None
    if has_low and low_number is None:
        raise EmitError(["the smallest value must be a number"])
    if has_high and high_number is None:
        raise EmitError(["the largest value must be a number"])
    if low_number is not None and high_number is not None and low_number > high_number:
        raise EmitError(["the smallest value must not be larger than the largest"])
    low_text = js_number(low_number) if low_number is not None else "0"
    high_text = js_number(high_number) if high_number is not None else "0"
    return (
        f"AFRange_Validate({'true' if has_low else 'false'}, {low_text}, "
        f"{'true' if has_high else 'false'}, {high_text});"
    )


# -- calculate -------------------------------------------------------------


def calculate_script(calc: dict) -> str:
    """``AFSimple_Calculate`` over a field list, or the expanded Simplified
    Field Notation assignment.

    SFN has no encoding of its own in the format -- a producer expands it into
    a `/JS` body at authoring time, and so do we.
    """
    calc = calc or {}
    if "sfn" in calc:
        text = str(calc.get("sfn") or "").strip()
        if not text:
            raise EmitError(["an expression is needed"])
        body = f"event.value = {text};"
        if recognize(body) is None:
            raise EmitError([f"this expression cannot be read: {text}"])
        return body
    op = str(calc.get("op") or "")
    if op not in CALC_FUNCTIONS:
        raise EmitError([f"unknown calculation {op or '(none)'}"])
    fields = [str(f).strip() for f in (calc.get("fields") or []) if str(f).strip()]
    if not fields:
        raise EmitError(["a calculation needs at least one field"])
    names = ",".join(js_string(f) for f in fields)
    return f'AFSimple_Calculate("{op}", new Array({names}));'


def calculate_inputs(calc: dict) -> list[str]:
    """The field names a calculation reads, in first-appearance order."""
    calc = calc or {}
    if "sfn" in calc:
        script = recognize(f"event.value = {str(calc.get('sfn') or '').strip()};")
        if script is None:
            return []
        return sfn_fields(script["expr"])
    out: list[str] = []
    for raw in calc.get("fields") or []:
        name = str(raw).strip()
        if name and name not in out:
            out.append(name)
    return out


def script_inputs(js: str) -> list[str]:
    """The names an EXISTING calculate body reads, or an empty list when the
    body is not one this app recognizes -- an unrecognized script constrains
    no order, because nothing here can say what it reads."""
    script = recognize(js)
    if script is None:
        return []
    if script.get("fn") == "SFN":
        return sfn_fields(script["expr"])
    if script.get("fn") == "AFSimple_Calculate":
        raw = script["args"][1]
        names = [str(n) for n in raw] if isinstance(raw, list) else str(raw).split(",")
        out: list[str] = []
        for name in names:
            cleaned = name.strip()
            if cleaned and cleaned not in out:
                out.append(cleaned)
        return out
    return []


# -- the calculation order -------------------------------------------------


def resolves(name: str, known) -> bool:
    """Whether a calculation may name this field: a field of the document (or
    of the batch), or a parent whose terminal children are among them."""
    if name in known:
        return True
    prefix = name + "."
    return any(str(k).startswith(prefix) for k in known)


def calculation_order(
    existing_order: list,
    existing_inputs: dict,
    new_entries: list,
) -> list[str]:
    """The `/CO` a document carries after this batch is authored.

    ``existing_order`` is the document's own `/CO` and is NEVER re-sorted: the
    author declared it and it may encode intent the graph does not show. Each
    new entry is inserted at the earliest position that satisfies its
    dependencies, with ties broken on authoring order, so a form laid out
    top-to-bottom keeps its natural order.

    ``new_entries`` is ``[(name, [input names])]``. Raises ``CycleError`` when
    a cycle passes through one of them; a cycle wholly inside the document's
    own `/CO` is the document's and is evaluated one pass, not refused here.
    """
    order = [str(n) for n in existing_order]
    entries = [(str(name), [str(i) for i in inputs]) for name, inputs in new_entries]
    batch = {name for name, _ in entries}
    edges = {name: list(inputs) for name, inputs in entries}
    for name in order:
        edges.setdefault(name, list(existing_inputs.get(name) or []))

    _refuse_cycles(edges, batch)

    # A stable topological pass over the batch alone: an entry that reads
    # another entry of the same batch must be placed after it.
    placed: list[tuple[str, list[str]]] = []
    remaining = list(entries)
    while remaining:
        pending = {n for n, _ in remaining}
        progressed = False
        for index, (name, inputs) in enumerate(remaining):
            if any(i in pending and i != name for i in inputs):
                continue
            placed.append(remaining.pop(index))
            progressed = True
            break
        if not progressed:
            # Unreachable: _refuse_cycles has already refused every cycle that
            # touches the batch, so a stall can only mean one.
            raise CycleError([name for name, _ in remaining])

    cursor = 0
    for name, inputs in placed:
        if name in order:
            order.remove(name)
        want = cursor
        for dep in inputs:
            if dep in order:
                want = max(want, order.index(dep) + 1)
        order.insert(want, name)
        cursor = want + 1
    return order


def _refuse_cycles(edges: dict, batch: set) -> None:
    """Depth-first over the dependency graph; the first cycle that passes
    through a field this batch authors refuses, naming the chain."""
    state: dict = {}
    stack: list[str] = []

    def walk(name: str) -> None:
        if state.get(name) == "done":
            return
        if state.get(name) == "open":
            chain = stack[stack.index(name):] + [name]
            if any(n in batch for n in chain):
                raise CycleError(chain)
            return
        state[name] = "open"
        stack.append(name)
        for dep in edges.get(name, ()):
            if dep in edges:
                walk(dep)
        stack.pop()
        state[name] = "done"

    for name in list(edges):
        walk(name)


def emitted_scripts(spec: dict) -> dict:
    """Every `/AA` body one spec carries, by trigger.

    ``format`` writes `/F` + `/K`, ``validate`` writes `/V`, ``calculate``
    writes `/C`. A spec carrying none returns an empty mapping and the field
    gets no `/AA` at all.
    """
    out: dict = {}
    fmt = spec.get("format")
    if fmt is not None:
        out.update(format_scripts(fmt))
    rule = spec.get("validate")
    if rule is not None:
        out["V"] = validate_script(rule)
    calc = spec.get("calculate")
    if calc is not None:
        out["C"] = calculate_script(calc)
    return out


def recognizable(js: str) -> bool:
    """Whether a body this module wrote reads back as the call it was built
    from. The corpus asserts it for every template; the writers assert it for
    everything they emit, so a body this app writes is never one it refuses."""
    script = recognize(js)
    if script is None:
        return False
    fn = script.get("fn")
    return fn == "SFN" or fn in ENTRY_POINTS
