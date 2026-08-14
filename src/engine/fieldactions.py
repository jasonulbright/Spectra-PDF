"""The `/AA` and `/A` action kinds that are DATA rather than code.

`engine.afscript` reads the `/JavaScript` half of a field's actions; this
module reads and writes the other half -- the action dictionaries that carry a
destination, a URL, a field subset, a visibility change or a file to import.
None of them is a script, so all of them can be both reported and RUN without a
JavaScript engine.

The wire shape is one classified dict per action, and it is the same vocabulary
the renderer speaks (``src/renderer/lib/field-actions.ts``)::

    {"kind": "goto",   "page": int | None}
    {"kind": "uri",    "uri": str}
    {"kind": "reset",  "fields": [str] | None, "exclude": bool}
    {"kind": "submit", "url": str, "format": "fdf"|"html"|"xfdf"|"pdf",
                       "method": "post"|"get", "fields": [str] | None,
                       "exclude": bool, "include_empty": bool}
    {"kind": "hide",   "targets": [str], "hide": bool}
    {"kind": "import", "file": str}
    {"kind": "named",  "name": str}
    {"kind": "javascript"}
    {"kind": "remote", "file": str, "page": int | None}
    {"kind": "other",  "action": str}

``javascript``, ``remote`` and ``other`` are REPORTED and never run: the first
because this app runs no arbitrary form scripts, the second because it reaches
another document, the third because nothing here can say what it does. Every
one of them keeps its bytes.

Triggers. ``A`` is the widget's activation action -- what a pushbutton does
when it is clicked, and the key every producer writes for one. The rest are
`/AA` keys: ``D`` mouse down, ``U`` mouse up, ``E`` pointer enter, ``X``
pointer exit, ``Fo`` focus, ``Bl`` blur. The four value triggers (`/K` `/V`
`/C` `/F`) belong to `engine.afscript` and are deliberately absent here -- a
value trigger carrying a non-script action is not one this app runs.
"""

from __future__ import annotations

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from engine.acroform import fq_field_name

#: Widget action triggers, in the order a document declares them. ``A`` is the
#: activation action and lives on the widget itself; the rest are `/AA` keys.
TRIGGERS = ("A", "D", "U", "E", "X", "Fo", "Bl")

#: The trigger a button's action is authored on when nothing else is said.
DEFAULT_TRIGGER = "A"

#: The action kinds this app AUTHORS. Reading covers more (a `/GoToR`, a
#: `/Named`, a script) because a document may carry anything; writing is
#: restricted to what this app can also run or honestly explain.
AUTHORED_KINDS = ("goto", "uri", "reset", "submit", "hide", "import")

#: The kinds that RUN, as opposed to being reported. `submit` runs as far as
#: building the submission; the transport is the user's (see the module
#: docstring of `engine.formdata`).
RUNNABLE_KINDS = ("goto", "uri", "reset", "submit", "hide", "import")

#: `/SubmitForm` `/Flags`, by bit position (PDF 32000-1 table 237).
SUBMIT_EXCLUDE = 1 << 0  # bit 1  Include/Exclude
SUBMIT_INCLUDE_EMPTY = 1 << 1  # bit 2  IncludeNoValueFields
SUBMIT_HTML = 1 << 2  # bit 3  ExportFormat
SUBMIT_GET = 1 << 3  # bit 4  GetMethod
SUBMIT_XFDF = 1 << 5  # bit 6  XFDF
SUBMIT_PDF = 1 << 8  # bit 9  SubmitPDF

#: `/ResetForm` `/Flags` bit 1: the field list is an EXCLUDE list.
RESET_EXCLUDE = 1 << 0

#: `/F` bit 2 -- the annotation flag `/Hide` sets and clears.
ANNOT_HIDDEN = 1 << 1

#: The submission formats, most specific first. A document setting more than
#: one bit gets the most specific reading, which is the order a conforming
#: consumer resolves them in.
SUBMIT_FORMATS = ("pdf", "xfdf", "html", "fdf")


class ActionError(ValueError):
    """An authored action that cannot become an action dictionary.

    ``problems`` is the list-of-strings shape ``FieldSpecError`` and
    ``EmitError`` already carry, so a batch reports every problem at once
    whichever half found it.
    """

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = list(problems)


# ── reading ───────────────────────────────────────────────────────────────


def _text(value) -> str:
    return "" if value is None else str(value)


def _flags(node, key: str = "/Flags") -> int:
    try:
        return int(node.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _page_index_of(pdf: pikepdf.Pdf, ref) -> int | None:
    try:
        target = ref.objgen
    except AttributeError:
        return None
    for index, page in enumerate(pdf.pages):
        try:
            if page.obj.objgen == target:
                return index
        except AttributeError:
            continue
    return None


def _named_destination(pdf: pikepdf.Pdf, name):
    """A destination named by string or name: the `/Names /Dests` name tree
    first, then the legacy `/Dests` dictionary."""
    key = str(name).lstrip("/")
    names = pdf.Root.get("/Names")
    if names is not None:
        dests = names.get("/Dests")
        if dests is not None:
            try:
                found = pikepdf.NameTree(dests).get(key)
            except (TypeError, ValueError, KeyError, RuntimeError):
                found = None
            if found is not None:
                return found
    legacy = pdf.Root.get("/Dests")
    if legacy is not None:
        try:
            found = legacy.get("/" + key)
        except (TypeError, ValueError, AttributeError):
            found = None
        if found is not None:
            return found
    return None


def destination_page(pdf: pikepdf.Pdf, dest, depth: int = 0) -> int | None:
    """The 0-based page a destination lands on, or None.

    An explicit array names its page directly; a dictionary keeps the array
    under `/D`; a name or string is looked up in the document's destination
    tree. A destination naming a page the tree no longer has resolves to None
    rather than guessing -- the action is then reported without a target
    instead of navigating somewhere the author never wrote.
    """
    if depth > 8 or dest is None:
        return None
    if isinstance(dest, pikepdf.Array):
        return _page_index_of(pdf, dest[0]) if len(dest) > 0 else None
    if isinstance(dest, Dictionary):
        return destination_page(pdf, dest.get("/D"), depth + 1)
    if isinstance(dest, (pikepdf.Name, pikepdf.String)):
        return destination_page(pdf, _named_destination(pdf, dest), depth + 1)
    return None


def _field_names(pdf: pikepdf.Pdf, entries) -> list[str]:
    """A `/Fields` array as fully-qualified names.

    An entry is either a text string naming a field or an indirect reference
    to the field itself; both are resolved to a NAME, because a name is what
    the fill and the reset both address a field by. An entry that resolves to
    neither is dropped -- a scope that cannot be read is narrower than the
    document declared, so it is reported as the names that survived.
    """
    names: list[str] = []
    if entries is None:
        return names
    try:
        items = list(entries)
    except TypeError:
        return names
    for entry in items:
        if isinstance(entry, pikepdf.String):
            name = str(entry)
        elif isinstance(entry, Dictionary):
            name = fq_field_name(entry)
        else:
            name = None
        if name and name not in names:
            names.append(name)
    return names


def _hide_targets(pdf: pikepdf.Pdf, node) -> list[str]:
    """`/Hide`'s `/T`: a field name, an annotation dictionary, or an array of
    either. An annotation resolves to the name of the field it is a widget of;
    an annotation belonging to no field is dropped, since there is no name to
    address it by."""
    raw = node.get("/T")
    if raw is None:
        return []
    items = list(raw) if isinstance(raw, Array) else [raw]
    return _field_names(pdf, items)


def _submit_format(flags: int) -> str:
    if flags & SUBMIT_PDF:
        return "pdf"
    if flags & SUBMIT_XFDF:
        return "xfdf"
    if flags & SUBMIT_HTML:
        return "html"
    return "fdf"


def _file_spec(value) -> str:
    """A file specification as its path string. Both the plain-string form and
    the dictionary form (`/F`, or `/UF` when the producer wrote Unicode)."""
    if value is None:
        return ""
    if isinstance(value, pikepdf.String):
        return str(value)
    if isinstance(value, Dictionary):
        for key in ("/UF", "/F"):
            inner = value.get(key)
            if inner is not None:
                return str(inner)
    return ""


def classify(pdf: pikepdf.Pdf, node) -> dict | None:
    """One action dictionary, classified. None when it is not one."""
    if not isinstance(node, Dictionary):
        return None
    try:
        subtype = str(node.get("/S"))
    except (TypeError, ValueError):
        return {"kind": "other", "action": ""}
    if subtype == "/GoTo":
        return {"kind": "goto", "page": destination_page(pdf, node.get("/D"))}
    if subtype in ("/GoToR", "/GoToE"):
        return {
            "kind": "remote",
            "file": _file_spec(node.get("/F")),
            "page": None,
        }
    if subtype == "/URI":
        return {"kind": "uri", "uri": _text(node.get("/URI"))}
    if subtype == "/ResetForm":
        names = _field_names(pdf, node.get("/Fields"))
        return {
            "kind": "reset",
            "fields": names or None,
            "exclude": bool(_flags(node) & RESET_EXCLUDE),
        }
    if subtype == "/SubmitForm":
        flags = _flags(node)
        names = _field_names(pdf, node.get("/Fields"))
        return {
            "kind": "submit",
            "url": _file_spec(node.get("/F")),
            "format": _submit_format(flags),
            "method": "get" if flags & SUBMIT_GET else "post",
            "fields": names or None,
            "exclude": bool(flags & SUBMIT_EXCLUDE),
            "include_empty": bool(flags & SUBMIT_INCLUDE_EMPTY),
        }
    if subtype == "/Hide":
        # /H defaults to TRUE, and true means HIDE -- an /H the producer left
        # out is a hide, not a show.
        raw = node.get("/H")
        hide = True if raw is None else bool(raw)
        return {"kind": "hide", "targets": _hide_targets(pdf, node), "hide": hide}
    if subtype == "/ImportData":
        return {"kind": "import", "file": _file_spec(node.get("/F"))}
    if subtype == "/Named":
        return {"kind": "named", "name": _text(node.get("/N")).lstrip("/")}
    if subtype == "/JavaScript":
        return {"kind": "javascript"}
    return {"kind": "other", "action": subtype.lstrip("/")}


def widget_nodes(node) -> list:
    """The widget dictionaries an action may hang off: the field's own
    dictionary when it merges its widget, else the `/Kids` that carry no `/T`
    of their own. A field with neither is its own only node -- writing there
    is still the honest answer, since that is where a consumer looks."""
    try:
        if node.get("/Subtype") == Name.Widget:
            return [node]
        kids = node.get("/Kids")
    except AttributeError:
        return [node]
    if kids is None:
        return [node]
    out = []
    for kid in kids:
        try:
            if kid.get("/T") is None:
                out.append(kid)
        except AttributeError:
            continue
    return out or [node]


def read_actions(pdf: pikepdf.Pdf, node) -> dict:
    """``{trigger: classified action}`` for a field dictionary.

    Read off the field dictionary first and then its widgets, so a merged
    field/widget and a split one report the same thing. The FIRST node that
    carries a trigger wins: a radio group whose kids carry different actions
    is reported by the group's first answer rather than silently merged into
    one that belongs to no widget.
    """
    out: dict = {}
    nodes = [node]
    for widget in widget_nodes(node):
        if widget is not node:
            nodes.append(widget)
    for node in nodes:
        try:
            activation = node.get("/A")
        except AttributeError:
            continue
        if "A" not in out:
            classified = classify(pdf, activation)
            if classified is not None:
                out["A"] = classified
        aa = node.get("/AA")
        if not isinstance(aa, Dictionary):
            continue
        for trigger in TRIGGERS:
            if trigger == "A" or trigger in out:
                continue
            classified = classify(pdf, aa.get("/" + trigger))
            if classified is not None:
                out[trigger] = classified
    return out


# ── writing ───────────────────────────────────────────────────────────────


def _name_array(pdf: pikepdf.Pdf, names) -> Array:
    return Array([String(str(n)) for n in names])


def _int_page(spec: dict, page_count: int) -> int:
    raw = spec.get("page")
    try:
        index = int(raw)
    except (TypeError, ValueError):
        raise ActionError(["a go-to action needs a page"]) from None
    if index < 0 or index >= page_count:
        raise ActionError([f"page {index + 1} is outside this document ({page_count} pages)"])
    return index


def action_dictionary(pdf: pikepdf.Pdf, spec: dict):
    """An authored action as an indirect action dictionary.

    Only the kinds in ``AUTHORED_KINDS`` are written. The shapes are the ones
    the ecosystem writes, so another viewer performs what this app authored.
    """
    kind = str((spec or {}).get("kind", ""))
    if kind not in AUTHORED_KINDS:
        raise ActionError([f"unknown action {kind or '(none)'}"])
    if kind == "goto":
        index = _int_page(spec, len(pdf.pages))
        # An explicit XYZ destination with null coordinates: the page, at
        # whatever zoom the reader is already using. A destination carrying
        # coordinates would move the reader's view for a reason the author
        # never stated.
        dest = Array([pdf.pages[index].obj, Name("/XYZ"), None, None, None])
        return pdf.make_indirect(Dictionary(S=Name("/GoTo"), D=dest))
    if kind == "uri":
        uri = str(spec.get("uri") or "").strip()
        if not uri:
            raise ActionError(["a link action needs an address"])
        return pdf.make_indirect(Dictionary(S=Name("/URI"), URI=String(uri)))
    if kind == "reset":
        node = Dictionary(S=Name("/ResetForm"))
        names = [str(n) for n in (spec.get("fields") or []) if str(n).strip()]
        if names:
            node["/Fields"] = _name_array(pdf, names)
            if spec.get("exclude"):
                node["/Flags"] = RESET_EXCLUDE
        elif spec.get("exclude"):
            raise ActionError(
                ["a reset that excludes fields has to name the fields it excludes"]
            )
        return pdf.make_indirect(node)
    if kind == "submit":
        url = str(spec.get("url") or "").strip()
        if not url:
            raise ActionError(["a submit action needs an address"])
        fmt = str(spec.get("format") or "fdf")
        if fmt not in SUBMIT_FORMATS:
            raise ActionError([f"unknown submission format {fmt}"])
        flags = 0
        if fmt == "pdf":
            flags |= SUBMIT_PDF
        elif fmt == "xfdf":
            flags |= SUBMIT_XFDF
        elif fmt == "html":
            flags |= SUBMIT_HTML
        if str(spec.get("method") or "post") == "get":
            flags |= SUBMIT_GET
        if spec.get("include_empty"):
            flags |= SUBMIT_INCLUDE_EMPTY
        names = [str(n) for n in (spec.get("fields") or []) if str(n).strip()]
        if spec.get("exclude"):
            if not names:
                raise ActionError(
                    ["a submission that excludes fields has to name the fields it excludes"]
                )
            flags |= SUBMIT_EXCLUDE
        node = Dictionary(S=Name("/SubmitForm"), F=String(url))
        if names:
            node["/Fields"] = _name_array(pdf, names)
        if flags:
            node["/Flags"] = flags
        return pdf.make_indirect(node)
    if kind == "hide":
        targets = [str(n) for n in (spec.get("targets") or []) if str(n).strip()]
        if not targets:
            raise ActionError(["a show-or-hide action needs a field to act on"])
        node = Dictionary(S=Name("/Hide"), T=_name_array(pdf, targets))
        # /H true HIDES. It is written either way: a reader that defaults it
        # would read a show action as a hide.
        node["/H"] = bool(spec.get("hide", True))
        return pdf.make_indirect(node)
    path = str(spec.get("file") or "").strip()
    if not path:
        raise ActionError(["an import action needs a file to import"])
    return pdf.make_indirect(Dictionary(S=Name("/ImportData"), F=String(path)))


def write_actions(pdf: pikepdf.Pdf, node, actions) -> None:
    """Rewrite every trigger this app authors from ``actions``.

    TOTAL, the same contract ``set_field_actions`` already holds for the value
    triggers: a trigger absent from the list is REMOVED rather than left
    behind, so a button whose action was taken away no longer does the old
    thing. Every other `/AA` key -- a value trigger, a script this app does
    not run -- is untouched.

    The action lands on the widget the user clicks. A field with kids carries
    it on every kid, because each of them is a click surface; a merged
    field/widget carries it on itself.
    """
    by_trigger: dict = {}
    for entry in actions or ():
        trigger = str((entry or {}).get("trigger") or DEFAULT_TRIGGER)
        by_trigger[trigger] = entry
    for target in widget_nodes(node):
        if "A" in by_trigger:
            target["/A"] = action_dictionary(pdf, by_trigger["A"])
        elif target.get("/A") is not None and classify(pdf, target.get("/A")) is not None:
            del target["/A"]
        aa = target.get("/AA")
        if not isinstance(aa, Dictionary):
            aa = None
        for trigger in TRIGGERS:
            if trigger == "A":
                continue
            key = "/" + trigger
            if trigger in by_trigger:
                if aa is None:
                    aa = Dictionary()
                    target["/AA"] = aa
                aa[key] = action_dictionary(pdf, by_trigger[trigger])
            elif aa is not None and key in aa:
                del aa[key]
        if aa is not None and len(aa.keys()) == 0:
            del target["/AA"]


def action_problems(actions, known_names, page_count: int) -> list[str]:
    """Every problem an authored action list carries, in the engine's own
    English -- checked BEFORE anything is written, so a batch reports them all
    at once and nothing lands half-authored."""
    problems: list[str] = []
    seen: set = set()
    for entry in actions or ():
        if not isinstance(entry, dict):
            problems.append("not an action description")
            continue
        trigger = str(entry.get("trigger") or DEFAULT_TRIGGER)
        if trigger not in TRIGGERS:
            problems.append(f"unknown trigger {trigger}")
        elif trigger in seen:
            problems.append(f"two actions on the same trigger {trigger}")
        else:
            seen.add(trigger)
        kind = str(entry.get("kind", ""))
        if kind not in AUTHORED_KINDS:
            problems.append(f"unknown action {kind or '(none)'}")
            continue
        if kind == "goto":
            raw = entry.get("page")
            if not isinstance(raw, int) or raw < 0 or raw >= page_count:
                got = raw + 1 if isinstance(raw, int) else "(none)"
                problems.append(
                    f"a go-to action names page {got}, which is outside this "
                    f"document ({page_count} pages)"
                )
        for key in ("fields", "targets"):
            for name in entry.get(key) or ():
                if str(name) not in known_names:
                    problems.append(
                        f'an action names "{name}", which this document does not have'
                    )
        if kind == "hide" and not (entry.get("targets") or ()):
            problems.append("a show-or-hide action needs a field to act on")
        if kind in ("uri", "submit"):
            address = str(entry.get("uri") or entry.get("url") or "").strip()
            if not address:
                problems.append(f"a {kind} action needs an address")
        if kind == "submit":
            fmt = str(entry.get("format") or "fdf")
            if fmt not in SUBMIT_FORMATS:
                problems.append(f"unknown submission format {fmt}")
        if kind == "import" and not str(entry.get("file") or "").strip():
            problems.append("an import action needs a file to import")
    return problems


def set_widget_hidden(node, hide: bool) -> int:
    """Set or clear `/F` Hidden on every widget of a field. Returns how many
    widgets changed, so a caller can report a no-op as one."""
    changed = 0
    for widget in widget_nodes(node):
        try:
            flags = int(widget.get("/F", 0))
        except (TypeError, ValueError):
            flags = 0
        wanted = flags | ANNOT_HIDDEN if hide else flags & ~ANNOT_HIDDEN
        if wanted != flags:
            widget["/F"] = wanted
            changed += 1
    return changed
