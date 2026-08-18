"""Accessibility checker — 33 checks across seven categories.

A check is a CLAIM, and every claim states how it was reached. Each check
yields one of five verdicts and, when it has something to name, a list of
findings, each carrying an address the app can jump to.

Two rules govern the whole inventory.

**`pass` is never the fallback.** ``not_applicable`` is a state of its own: a
document with no tables has nothing to say about table headers, and reporting
"passed" for a check with nothing to check is how a report earns a score it
did not earn. Those rows are excluded from the pass tally, and the summary
says so by carrying `applicable` separately from `total`.

**A check that can be wrong reports ``needs_review``, never ``fail``.** A
false failure on a conforming document destroys the only thing this tool
sells. Colour contrast over an unresolvable backdrop, a reading order that
merely disagrees with geometry, a script that might flash the screen — each is
reported with its inventory so a human reviews a list rather than a document.

**A read that did not complete is a third state, not a clean one.** A page
whose content stream will not parse lands in ``unreadable``; an annotation
list, a field tree, a script site or a branch of the structure tree that will
not read is named on the checks that consumed it. Every such check degrades to
``needs_review``: "could not read" is never reported as "nothing found", and
an empty inventory that came out of a failed read is never reported as
``not_applicable``.

Every walk here is bounded — the field tree by ``_FIELD_TREE_DEPTH``, the
structure tree by ``struct_tree._MAX_DEPTH`` and its cycle guard — and a bound
that was reached is reported rather than presented as the end of the document.

Addresses come in three kinds, each matching a jump the app already performs:
``struct`` (a structure-tree path in `get_struct_tree`'s numbering),
``content`` ({page, rect} and a run index) and ``object`` ({page,
annotation} or {field}). A path never outlives the tree it was read from, so
the report is re-run on every buffer change and a finding whose address no
longer resolves surfaces a notice rather than retargeting.
"""

from __future__ import annotations

import pikepdf

from engine import struct_audit, struct_nesting
from engine.contrast import page_contrast
from engine.extract_text import extract_text
from engine.redact import IDENTITY, _resolve_resources
from engine.sanitize_content import SCAN_COVERAGE, off_ocg_set, page_events
from engine.struct_audit import (
    CELLS,
    ROW_GROUPS,
    annots_of,
    audit_tree,
    nesting_edges,
    row_cells,
    scope,
    span_of,
)
from engine.text_metrics import _FontCache
from engine.text_runs import NOTHING_TO_EDIT, _walk_runs

PASS = "pass"
FAIL = "fail"
WARN = "warn"
REVIEW = "needs_review"
NA = "not_applicable"

# The category order the report and both emitters render in.
CATEGORIES = (
    "document",
    "page_content",
    "forms",
    "alt_text",
    "tables",
    "lists",
    "headings",
)

# id → category, in report order. The renderer mirrors this list; the parity
# gate is tests/test_accessibility.py, which reads the mirror as source text —
# a check the engine reports and the panel cannot name would render nameless.
CHECK_INVENTORY = (
    ("permissions", "document"),
    ("image_only", "document"),
    ("tagged", "document"),
    ("structure_nesting", "document"),
    ("reading_order", "document"),
    ("lang", "document"),
    ("title", "document"),
    ("bookmarks", "document"),
    ("contrast", "document"),
    ("tagged_content", "page_content"),
    ("tagged_annotations", "page_content"),
    ("tab_order", "page_content"),
    ("character_encoding", "page_content"),
    ("tagged_multimedia", "page_content"),
    ("screen_flicker", "page_content"),
    ("scripts", "page_content"),
    ("timed_responses", "page_content"),
    ("navigation_links", "page_content"),
    ("tagged_form_fields", "forms"),
    ("field_descriptions", "forms"),
    ("figures_alt", "alt_text"),
    ("nested_alt", "alt_text"),
    ("alt_no_content", "alt_text"),
    ("alt_hides_annotation", "alt_text"),
    ("other_elements_alt", "alt_text"),
    ("table_rows", "tables"),
    ("table_cells", "tables"),
    ("table_headers", "tables"),
    ("table_regularity", "tables"),
    ("table_summary", "tables"),
    ("list_items", "lists"),
    ("list_labels", "lists"),
    ("heading_nesting", "headings"),
)

# Long enough that navigating without bookmarks is real work. The shipped
# checker's threshold, kept.
LONG_DOCUMENT_PAGES = 10

# Annotation subtypes handed to a check of their own (widgets to 18,
# multimedia to 13) and the one the spec exempts outright: a /Popup is the
# presentation of its parent's text, never content in its own right. /Link
# stays in the tagged-annotation check — a link outside the tree is exactly
# the finding that check exists for.
_MULTIMEDIA = frozenset({"/Screen", "/Movie", "/RichMedia", "/3D"})
_ANNOT_EXEMPT = frozenset({"/Popup", "/Widget"})

# Structure roles that carry an alternate description of something the reader
# cannot otherwise perceive. The two rosters are disjoint: ISO 32000-2 14.8.4.8.6
# states the alternate-description requirement for `Figure` and `Formula`
# together, so `figures_alt` owns `Formula` and a `Formula` with no description
# yields exactly one finding rather than the same finding under two check ids.
_FIGURE_ROLES = frozenset({"Figure", "Formula"})
_OTHER_ALT_ROLES = frozenset({"Link", "Form", "Annot"})

# Annotation flag bits (1-based positions in /F).
_F_HIDDEN = 1 << 1
_F_NOVIEW = 1 << 5

# JavaScript call shapes that schedule work on a clock. Matched against the
# script BODY, which is why the inventory carries the bodies.
_TIMER_CALLS = ("app.setTimeOut", "app.setInterval")

# How deep the field-name walk descends before it stops and says so.
_FIELD_TREE_DEPTH = 32

# How deep the name-tree shape check descends before it stops and says so.
# Also what bounds a `/Kids` cycle, which descends without ever widening.
_NAME_TREE_DEPTH = 64

# Which checks each bounded or fallible read feeds. A read that did not
# complete degrades every check that consumed it to `needs_review`: the answer
# is not "nothing found", it is "not looked at".
_ANNOTATION_CHECKS = (
    "tagged_annotations", "tab_order", "tagged_multimedia", "navigation_links",
    "tagged_form_fields", "alt_hides_annotation", "other_elements_alt",
    "field_descriptions",
)
_FIELD_CHECKS = (
    "field_descriptions", "tagged_form_fields", "alt_hides_annotation",
    "other_elements_alt",
)
_SCRIPT_CHECKS = ("screen_flicker", "scripts", "timed_responses")

# Every check whose answer is read out of the structure tree.
_STRUCTURE_CHECKS = (
    "reading_order", "tagged_annotations", "tagged_multimedia",
    "tagged_form_fields", "figures_alt", "nested_alt", "alt_no_content",
    "alt_hides_annotation", "other_elements_alt", "field_descriptions",
    "table_rows", "table_cells",
    "table_headers", "table_regularity", "table_summary", "list_items",
    "list_labels", "heading_nesting", "structure_nesting",
)

# The three whose FINDINGS are themselves claims about what the tree does not
# contain — an annotation reached by no `/OBJR` the walk saw. An incomplete
# walk cannot support those either way, so their `fail` degrades too.
_TREE_ABSENCE_CHECKS = ("tagged_annotations", "tagged_multimedia", "tagged_form_fields")

# The checks that read the pages, and cannot answer for one that will not parse.
_PAGE_CHECKS = (
    "image_only", "contrast", "tagged_content", "character_encoding",
    "navigation_links", "reading_order",
)



class _Check:
    def __init__(self, cid: str, category: str):
        self.id = cid
        self.category = category
        self.status = NA
        self.counted = 0
        self.findings: list = []
        self.data: dict = {}

    def to_json(self) -> dict:
        out = {
            "id": self.id,
            "category": self.category,
            "status": self.status,
            "counted": self.counted,
            "findings": self.findings,
        }
        if self.data:
            out["data"] = self.data
        return out


def _struct_address(node, page=None) -> dict:
    return {
        "kind": "struct",
        "path": [int(v) for v in node.path],
        "page": page if page is not None else node.page,
    }


def _content_address(page: int, run: int) -> dict:
    return {"kind": "content", "page": int(page), "run": int(run)}


def _object_address(page=None, annotation=None, field=None) -> dict:
    out: dict = {"kind": "object"}
    if page is not None:
        out["page"] = int(page)
    if annotation is not None:
        out["annotation"] = int(annotation)
    if field is not None:
        out["field"] = str(field)
    return out


def _finding(address: dict, detail_key: str, preview: str = "", rect=None,
             values: dict | None = None) -> dict:
    """One addressed finding. `values` are the measured numbers and names the
    localized detail sentence interpolates — never a rendered sentence, so
    nothing downstream matches on localized text."""
    out = {"address": address, "detail_key": detail_key, "preview": preview}
    if rect is not None:
        out["rect"] = [round(float(v), 2) for v in rect]
    if values:
        out["values"] = values
    return out


def _verdict(check: _Check, counted: int, findings: list, *, none_state=NA,
             clean=PASS, dirty=FAIL) -> None:
    check.counted = counted
    check.findings = findings
    if counted == 0:
        check.status = none_state
        return
    check.status = dirty if findings else clean


def _also_review(check: _Check, findings: list, *, states=(PASS, NA)) -> None:
    """Carry what this check could not read into its verdict.

    A clean claim over a read that did not complete is the one thing a
    conformance report must never make, so a check in one of `states` becomes
    `needs_review` and the findings naming the gap ride with the ones it did
    reach. A `fail` stands: it names something the reader DID see.
    """
    if not findings:
        return
    check.findings = check.findings + findings
    if check.status in states:
        check.status = REVIEW


# ── per-page reading ──────────────────────────────────────────────────────


class _Pages:
    """Everything the checks read off the pages, walked once.

    A page that will not parse is recorded in `unreadable` and contributes no
    runs — every check that consumes runs asks `readable` before claiming a
    clean result.

    The two stages fail independently: a page whose text parses and whose
    paint walk does not has runs but no coverage and no contrast, so `painted`
    is what a check consuming either of those asks. A page absent from
    `scan_cover` was not measured at zero coverage; it was not measured.
    """

    def __init__(self, pdf):
        self.pdf = pdf
        self.runs: dict = {}
        self.contrast: dict = {}
        self.scan_cover: dict = {}
        self.painted: set = set()
        self.unreadable: list = []
        off_set = off_ocg_set(pdf)
        for i, page in enumerate(pdf.pages):
            page_no = i + 1
            try:
                runs: list = []
                _walk_runs(
                    pdf,
                    pikepdf.parse_content_stream(page),
                    _resolve_resources(page),
                    IDENTITY,
                    0,
                    None,
                    runs,
                    False,
                    _FontCache(),
                )
                self.runs[page_no] = runs
            except Exception as exc:
                self.unreadable.append({"page": page_no, "stage": "text", "reason": str(exc)})
                continue
            try:
                self.contrast[page_no] = page_contrast(pdf, page, page_no, off_set)
                self.scan_cover[page_no] = page_events(pdf, page, off_set).scan_cover
                self.painted.add(page_no)
            except Exception as exc:
                self.unreadable.append({"page": page_no, "stage": "paint", "reason": str(exc)})

    def readable(self, page_no: int) -> bool:
        return page_no in self.runs

    @property
    def any_unreadable(self) -> bool:
        return bool(self.unreadable)


def _annotations(entries: list) -> list:
    """`annots_of`'s entries, with everything the checks ask of an annotation
    read off each one: subtype, rect, flags, contents and objgen.

    Which entries exist, and which could not be read, is `annots_of`'s answer
    and not re-decided here.
    """
    out = []
    for entry in entries:
        annot = entry["obj"]
        try:
            subtype = str(annot.get("/Subtype") or "")
        except Exception:
            subtype = ""
        try:
            flags = int(annot.get("/F") or 0)
        except (TypeError, ValueError):
            flags = 0
        try:
            rect = [float(v) for v in annot.get("/Rect")] if annot.get("/Rect") else None
        except (TypeError, ValueError):
            rect = None
        try:
            contents = str(annot.get("/Contents") or "").strip()
        except Exception:
            contents = ""
        try:
            og = annot.objgen
        except Exception:
            og = (0, 0)
        out.append(
            {
                "page": entry["page"],
                "index": entry["index"],
                "subtype": subtype,
                "rect": rect,
                "flags": flags,
                "contents": contents,
                "objgen": og,
                "obj": annot,
            }
        )
    return out


def _visible(annot: dict) -> bool:
    """Can a reader perceive this annotation at all?

    Two ways a file says no, and this is the one place either is decided. The
    Hidden and NoView flags say it outright (ISO 32000-2, Table 167): neither
    renders nor interacts. A `/Rect` whose opposite corners coincide bounds no
    area — the shape ISO 32000-2, Table 166 exempts from carrying an
    appearance stream, because there is nowhere to draw one.

    An imperceptible annotation is owed no accessible name: a description of
    something nobody encounters describes nothing.
    """
    if annot["flags"] & (_F_HIDDEN | _F_NOVIEW):
        return False
    rect = annot["rect"]
    return not (
        rect is not None
        and len(rect) == 4
        and rect[0] == rect[2]
        and rect[1] == rect[3]
    )


def _weighable(records: list, complete: bool) -> bool:
    """Is a target the check must still answer for?

    True unless every object it names resolved AND none of them is
    perceivable. An address the annotation inventory does not hold is a target
    that could not be weighed, so it keeps the element in scope rather than
    exempting it on a read that did not complete.
    """
    return not (records and complete and not any(_visible(r) for r in records))


def _fields(pdf) -> tuple:
    """Terminal form fields, and what of the field tree would not read.

    Each entry carries the fully-qualified name, the `/TU` description and the
    widget objgens. Walked off the raw /AcroForm so an XFA document is read
    without pdf-lib's XFA-deleting side effect.

    The walk is bounded by `_FIELD_TREE_DEPTH`; a branch it stops on and a
    branch it cannot list are both named in the second return, because a
    PARTIAL inventory read as a complete one reports "every field has a
    description" over fields it never reached.
    """
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        return [], []
    roots = acro.get("/Fields")
    if roots is None:
        return [], []
    out: list = []
    unread: list = []
    seen: set = set()

    def walk(node, prefix, depth):
        if depth > _FIELD_TREE_DEPTH:
            unread.append({"reason": f"field tree deeper than {_FIELD_TREE_DEPTH} levels"})
            return
        if not isinstance(node, pikepdf.Dictionary):
            unread.append({"reason": "a field entry is not a dictionary"})
            return
        try:
            og = node.objgen
            if og != (0, 0):
                if og in seen:
                    return
                seen.add(og)
        except Exception:
            pass
        try:
            part = str(node.get("/T") or "")
        except Exception:
            part = ""
        name = f"{prefix}.{part}" if prefix and part else (part or prefix)
        kids = node.get("/Kids")
        children = []
        if kids is not None:
            try:
                children = [k for k in kids if isinstance(k, pikepdf.Dictionary)]
            except Exception as exc:
                children = []
                unread.append({"reason": str(exc)})
        # A kid with its own /T is a field; a kid without one is this field's
        # widget. That distinction is what makes a radio group one field.
        child_fields = [k for k in children if k.get("/T") is not None]
        if child_fields:
            for kid in child_fields:
                walk(kid, name, depth + 1)
            return
        try:
            description = str(node.get("/TU") or "").strip()
        except Exception:
            description = ""
        widgets = children if children else [node]
        widget_ogs = []
        for widget in widgets:
            try:
                if widget.objgen != (0, 0):
                    widget_ogs.append(widget.objgen)
            except Exception:
                continue
        try:
            ftype = str(node.get("/FT") or "")
        except Exception:
            ftype = ""
        out.append(
            {
                "name": name,
                "type": ftype.lstrip("/"),
                "description": description,
                "widgets": widget_ogs,
                "obj": node,
            }
        )

    try:
        for root in roots:
            walk(root, "", 0)
    except Exception as exc:
        unread.append({"reason": str(exc)})
    return out, unread


def _name_tree_gaps(node, depth: int = 0) -> list:
    """The shapes `pikepdf.NameTree` reads PAST rather than refusing.

    A leaf whose `/Names` array is odd-length drops or mis-pairs its entries;
    a `/Names` that is not an array, a node declaring neither `/Names` nor
    `/Kids`, and a `/Kids` that is not an array each yield nothing at all. The
    iteration raises for none of them, so an inventory built from it reports
    "this document has no scripts" for a tree it could not read whole.

    This answers only whether the shape is one the iteration reads whole. It
    resolves no name and no value and produces no site, so it cannot disagree
    with the iteration about what the tree holds.
    """
    if depth > _NAME_TREE_DEPTH:
        return [{"reason": f"name tree deeper than {_NAME_TREE_DEPTH} levels"}]
    if not isinstance(node, pikepdf.Dictionary):
        return [{"reason": "a name tree node is not a dictionary"}]
    try:
        kids = node.get("/Kids")
        names = node.get("/Names")
    except Exception as exc:
        return [{"reason": str(exc)}]
    if kids is not None:
        if not isinstance(kids, pikepdf.Array):
            return [{"reason": "a name tree /Kids is not an array"}]
        out: list = []
        for kid in kids:
            out.extend(_name_tree_gaps(kid, depth + 1))
        return out
    if names is None:
        return [{"reason": "a name tree node declares neither /Kids nor /Names"}]
    if not isinstance(names, pikepdf.Array):
        return [{"reason": "a name tree /Names is not an array"}]
    if len(names) % 2:
        return [{"reason": "a name tree /Names array has an unpaired entry"}]
    return []


def _script_sites(pdf, annot_entries: list) -> tuple:
    """Every place this document carries JavaScript or a page action, and what
    of that inventory would not read.

    Four kinds, where a catalog-name-tree read alone reports one: the name
    tree, /OpenAction, page /AA, and field or annotation /AA. Each site
    carries its body so the panel can show the script rather than a paraphrase
    of it.

    A name tree that will not enumerate yields NO sites and a body that will
    not decode yields an EMPTY one — the first reads as "this document has no
    scripts" and the second as "no script here schedules work on a clock". An
    action dictionary that will not read is a third. All are named in the
    second return instead.
    """
    sites: list = []
    unread: list = []

    def body_of(action) -> str:
        if not isinstance(action, pikepdf.Dictionary):
            return ""
        js = action.get("/JS")
        if js is None:
            return ""
        try:
            if isinstance(js, pikepdf.Stream):
                return bytes(js.read_bytes()).decode("utf-8", "replace")
            return str(js)
        except Exception as exc:
            unread.append({"reason": str(exc)})
            return ""

    def is_js(action) -> bool:
        try:
            return isinstance(action, pikepdf.Dictionary) and str(action.get("/S") or "") == "/JavaScript"
        except Exception:
            return False

    def actions_of(owner, what: str, address: dict):
        """One `/AA` dictionary's entries. A present `/AA` that is not a
        dictionary holds actions this walk cannot enumerate, so it is a gap
        rather than an absence."""
        try:
            aa = owner.get("/AA")
        except Exception as exc:
            unread.append(dict(address, reason=str(exc)))
            return []
        if aa is None:
            return []
        if not isinstance(aa, pikepdf.Dictionary):
            unread.append(dict(address, reason=f"the {what} /AA is not a dictionary"))
            return []
        try:
            return list(aa.items())
        except Exception as exc:
            unread.append(dict(address, reason=str(exc)))
            return []

    try:
        names = pdf.Root.get("/Names")
    except Exception as exc:
        names = None
        unread.append({"reason": str(exc)})
    tree = None
    if names is not None:
        if not isinstance(names, pikepdf.Dictionary):
            unread.append({"reason": "the catalog /Names is not a dictionary"})
        else:
            try:
                tree = names.get("/JavaScript")
            except Exception as exc:
                unread.append({"reason": str(exc)})
    if tree is not None:
        unread.extend(_name_tree_gaps(tree))
        try:
            for key, value in pikepdf.NameTree(tree).items():
                sites.append(
                    {
                        "kind": "document",
                        "name": str(key),
                        "body": body_of(value),
                        "address": _object_address(),
                    }
                )
        except Exception as exc:
            unread.append({"reason": str(exc)})

    try:
        opener = pdf.Root.get("/OpenAction")
    except Exception as exc:
        opener = None
        unread.append({"reason": str(exc)})
    if is_js(opener):
        sites.append(
            {"kind": "open", "name": "", "body": body_of(opener), "address": _object_address()}
        )

    for key, value in actions_of(pdf.Root, "catalog", {}):
        if is_js(value):
            sites.append(
                {
                    "kind": "document_event",
                    "name": str(key).lstrip("/"),
                    "body": body_of(value),
                    "address": _object_address(),
                }
            )

    for i, page in enumerate(pdf.pages):
        for key, value in actions_of(page.obj, "page", {"page": i + 1}):
            sites.append(
                {
                    "kind": "page_event",
                    "name": str(key).lstrip("/"),
                    "body": body_of(value) if is_js(value) else "",
                    "address": _object_address(page=i + 1),
                }
            )

    for entry in annot_entries:
        annot, page_no, index = entry["obj"], entry["page"], entry["index"]
        try:
            action = annot.get("/A")
        except Exception as exc:
            action = None
            unread.append({"page": page_no, "reason": str(exc)})
        if is_js(action):
            sites.append(
                {
                    "kind": "annotation",
                    "name": "",
                    "body": body_of(action),
                    "address": _object_address(page=page_no, annotation=index),
                }
            )
        for key, value in actions_of(annot, "annotation", {"page": page_no}):
            if is_js(value):
                sites.append(
                    {
                        "kind": "field_event",
                        "name": str(key).lstrip("/"),
                        "body": body_of(value),
                        "address": _object_address(page=page_no, annotation=index),
                    }
                )
    return sites, unread


def _link_target(annot) -> str:
    """A link's destination as one comparable string."""
    action = annot.get("/A")
    if isinstance(action, pikepdf.Dictionary):
        uri = action.get("/URI")
        if uri is not None:
            try:
                return "uri:" + str(uri)
            except Exception:
                return "uri:?"
        dest = action.get("/D")
        if dest is not None:
            try:
                return "dest:" + str(dest)
            except Exception:
                return "dest:?"
        try:
            return "action:" + str(action.get("/S") or "")
        except Exception:
            return "action:?"
    dest = annot.get("/Dest")
    if dest is not None:
        try:
            return "dest:" + str(dest)
        except Exception:
            return "dest:?"
    return ""


def _rect_text(runs: list, rect) -> str:
    """The visible text under a rect — a link's own label."""
    if not rect:
        return ""
    x0, y0, x1, y1 = min(rect[0], rect[2]), min(rect[1], rect[3]), max(rect[0], rect[2]), max(rect[1], rect[3])
    parts = []
    for run in runs:
        r = run.get("rect")
        if not r:
            continue
        if r[2] < x0 or r[0] > x1 or r[3] < y0 or r[1] > y1:
            continue
        text = str(run.get("text") or "").strip()
        if text:
            parts.append(text)
    return " ".join(parts).strip()


def _mcid_text(runs: list) -> dict:
    """MCID → (text, rect) for one page, from the runs already walked."""
    table: dict = {}
    for run in runs:
        mcid = run.get("mcid")
        if mcid is None or run.get("nested"):
            continue
        text = str(run.get("text") or "")
        rect = [float(v) for v in run.get("rect") or [0.0, 0.0, 0.0, 0.0]]
        previous = table.get(mcid)
        if previous is None:
            table[mcid] = (text, rect)
            continue
        joined = previous[0]
        if joined and text and not joined.endswith(" ") and not text.startswith(" "):
            joined += " "
        box = previous[1]
        table[mcid] = (
            joined + text,
            [min(box[0], rect[0]), min(box[1], rect[1]), max(box[2], rect[2]), max(box[3], rect[3])],
        )
    return table


def _node_preview(node, mcid_tables: dict) -> tuple:
    """(text, rect) of the content one element tags, from the page walk."""
    parts: list = []
    box = None
    for ref in node.mcids:
        if ref.get("form"):
            continue
        table = mcid_tables.get(ref["page"]) or {}
        found = table.get(ref["mcid"])
        if found is None:
            continue
        if found[0].strip():
            parts.append(found[0].strip())
        rect = found[1]
        box = (
            list(rect)
            if box is None
            else [min(box[0], rect[0]), min(box[1], rect[1]), max(box[2], rect[2]), max(box[3], rect[3])]
        )
    return " ".join(parts).strip(), box


# ── the checks ────────────────────────────────────────────────────────────


def _check_permissions(check, pdf):
    check.counted = 1
    try:
        allowed = bool(pdf.allow.accessibility)
    except Exception:
        # Permissions that will not read are not permissions that allow: a
        # document whose encryption dictionary cannot be interpreted has an
        # unknown answer, and reporting the permissive one as measured is how
        # a blocked document reads as clean.
        check.status = REVIEW
        check.findings = [_finding(_object_address(), "permissions_unreadable")]
        return
    check.status = PASS if allowed else FAIL
    if not allowed:
        check.findings = [_finding(_object_address(), "permission_blocks_extraction")]


def _check_image_only(check, pdf, pages, file):
    counted = 0
    findings = []
    any_text = False
    for i in range(len(pdf.pages)):
        page_no = i + 1
        # Both stages, not one: a page whose paint walk did not complete has
        # no coverage to compare, and a missing coverage read as zero is a
        # page reported as "not a scan" without being looked at.
        if not pages.readable(page_no) or page_no not in pages.painted:
            continue
        counted += 1
        has_text = any(str(r.get("text") or "").strip() for r in pages.runs[page_no])
        if has_text:
            any_text = True
            continue
        if pages.scan_cover[page_no] >= SCAN_COVERAGE:
            findings.append(
                _finding(_content_address(page_no, 0), "page_is_an_image", values={"page": page_no})
            )
    if counted == 0:
        check.status = NA
        return
    check.counted = counted
    check.findings = findings
    if findings:
        check.status = FAIL
        return
    if any_text:
        # This module's own page walk already READ text off a page. Asking a
        # second reader whether the document has any would be putting the
        # question to whichever reader failed: the two disagree on documents
        # whose fonts one of them declines, and the answer "no extractable
        # text" over text we just extracted is a false statement, not a
        # stricter one.
        check.status = PASS
        return
    # No page carried text, and no page is covered by an image either. The
    # shipped extractable-text measurement decides the whole-file answer in
    # that case, which is the one case it was written for.
    try:
        extractable = bool(extract_text(file)["text"].strip())
    except Exception:
        extractable = False
    check.status = PASS if extractable else FAIL
    if not extractable:
        check.findings = [_finding(_object_address(), "no_extractable_text")]


def _check_tagged(check, pdf, tree):
    """A `/StructTreeRoot` holding no structure element is not a tagged
    document.

    The root is the entry point to the structure hierarchy and `/K` is what
    the hierarchy hangs from (ISO 32000-2 §14.7.2); a root with nothing under
    it defines no reading order, associates no content with any element and
    carries no alternate description. Reporting `pass` for it is the claim
    this check exists to make, made over a document that delivers none of it.
    """
    marked = False
    mark_info = pdf.Root.get("/MarkInfo")
    if mark_info is not None:
        try:
            marked = bool(mark_info.get("/Marked"))
        except Exception:
            marked = False
    populated = bool(tree["tagged"]) and bool(tree["nodes"])
    check.counted = 1
    check.status = PASS if populated and marked else FAIL
    if not (populated and marked):
        if not tree["tagged"]:
            detail = "structure_tree_missing"
        elif not tree["nodes"]:
            detail = "structure_tree_empty"
        else:
            detail = "mark_info_missing"
        check.findings = [_finding(_object_address(), detail)]


def _check_reading_order(check, tree, pages, mcid_tables):
    """Tree order against geometric order, per page.

    Computable; whether a disagreement is WRONG is not, so this check is
    `needs_review` whenever it has anything to say and never fails.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    per_page: dict = {}
    for node in tree["nodes"]:
        for ref in node.mcids:
            if ref.get("form"):
                continue
            table = mcid_tables.get(ref["page"]) or {}
            found = table.get(ref["mcid"])
            if found is None:
                continue
            per_page.setdefault(ref["page"], []).append((node, found[1]))
    findings = []
    counted = 0
    for page_no in sorted(per_page):
        items = per_page[page_no]
        if len(items) < 2:
            continue
        counted += 1
        # Geometric order is top-to-bottom then left-to-right, rounded into
        # bands so a baseline wobble is not a disagreement.
        order = sorted(range(len(items)), key=lambda i: (-round(items[i][1][3] / 4.0), items[i][1][0]))
        inversions = sum(1 for a in range(len(order)) for b in range(a + 1, len(order)) if order[a] > order[b])
        if inversions == 0:
            continue
        node = items[order[0]][0]
        findings.append(
            _finding(
                _struct_address(node, page_no),
                "reading_order_disagrees",
                rect=items[order[0]][1],
                values={"page": page_no, "inversions": inversions, "items": len(items)},
            )
        )
    check.counted = counted
    if counted == 0:
        check.status = NA
        return
    findings.sort(key=lambda f: -f["values"]["inversions"])
    check.findings = findings
    check.status = REVIEW if findings else PASS


def _effective_langs(tree) -> dict:
    """(page, mcid) → the language in effect for that marked content.

    ISO 32000-2, 14.9.2.3: a structure element's `/Lang` overrides the
    document default, and an element without one inherits from the nearest
    ancestor that has one. Only marked content the structure hierarchy reaches
    can be answered here; everything else is the caller's problem.
    """
    covered: dict = {}
    for node in tree["nodes"]:
        lang = str(node.lang or "").strip()
        if not lang:
            for ancestor in node.ancestors():
                lang = str(ancestor.lang or "").strip()
                if lang:
                    break
        if not lang:
            continue
        for ref in node.mcids:
            covered[(ref["page"], ref["mcid"])] = lang
    return covered


def _check_lang(check, pdf, tree, pages):
    """Whether every piece of text has a natural language in effect.

    The question is NOT "does the catalog carry `/Lang`". ISO 32000-2 14.9.2.3
    makes the catalog entry the DEFAULT for all text in the document and lets a
    structure element override it, inheriting from an ancestor when it declares
    none — so a document that declares a language on every content-bearing
    element has declared one for that content. Reading the catalog alone told
    those readers "The document declares no language" about a document that
    does, which is the false-statement class rather than a strictness choice.

    14.9.2.2: the empty text string means the language is UNKNOWN. It is not a
    declaration and is not accepted as one, at any level.

    The remedy the panel offers is unchanged and still right: setting the
    catalog default covers everything no element overrides.
    """
    try:
        value = pdf.Root.get("/Lang")
        default = str(value).strip() if value is not None else ""
    except Exception:
        default = ""
    check.data = {"lang": default}

    if default:
        check.counted = 1
        check.status = PASS
        return

    covered = _effective_langs(tree) if tree["tagged"] else {}
    if not covered:
        # Nothing declares a language anywhere, so no text has one.
        check.counted = 1
        check.status = FAIL
        check.findings = [_finding(_object_address(), "document_language_missing")]
        return

    counted = 0
    findings = []
    for page_no in sorted(pages.runs):
        for run in pages.runs[page_no]:
            if not str(run.get("text") or "").strip():
                continue
            if run.get("artifact"):
                continue
            if run.get("nested"):
                # A run inside a form XObject carries that stream's own MCID
                # numbering, which the page-keyed map cannot answer for — the
                # same exclusion `tagged_content` makes, for the same reason.
                continue
            counted += 1
            mcid = run.get("mcid")
            if mcid is not None and (page_no, int(mcid)) in covered:
                continue
            findings.append(
                _finding(
                    _content_address(page_no, int(run.get("index", 0))),
                    "document_language_missing",
                    preview=str(run.get("text") or "")[:80],
                    rect=run.get("rect"),
                    values={"page": page_no},
                )
            )
    if counted == 0:
        # Declared languages but no text to apply them to.
        check.counted = 1
        check.status = PASS
        return
    check.counted = counted
    check.findings = findings
    check.status = FAIL if findings else PASS


def _meta_title(pdf) -> str:
    try:
        title = pdf.docinfo.get("/Title")
        if title is not None and str(title).strip():
            return str(title).strip()
    except Exception:
        pass
    try:
        with pdf.open_metadata() as meta:
            title = meta.get("dc:title")
            if title:
                return str(title).strip()
    except Exception:
        pass
    return ""


def _check_title(check, pdf):
    title = _meta_title(pdf)
    shown = False
    prefs = pdf.Root.get("/ViewerPreferences")
    if prefs is not None:
        try:
            shown = bool(prefs.get("/DisplayDocTitle"))
        except Exception:
            shown = False
    check.counted = 1
    check.data = {"title": title, "display_doc_title": shown}
    if not title:
        check.status = FAIL
        check.findings = [_finding(_object_address(), "title_missing")]
        return
    if not shown:
        check.status = WARN
        check.findings = [_finding(_object_address(), "title_not_displayed", preview=title)]
        return
    check.status = PASS


def _has_outline_items(pdf) -> bool:
    """Does the outline hierarchy hold at least one item?

    The presence of `/Outlines` is not the presence of bookmarks: the root of
    an empty hierarchy is a legal dictionary with no `/First` (ISO 32000-2
    §12.3.3), and a document carrying one navigates exactly as badly as a
    document carrying none.
    """
    outlines = pdf.Root.get("/Outlines")
    if outlines is None:
        return False
    try:
        return outlines.get("/First") is not None
    except Exception:
        return False


def _check_bookmarks(check, pdf, tree):
    total = len(pdf.pages)
    if total < LONG_DOCUMENT_PAGES:
        check.status = NA
        return
    check.counted = 1
    if _has_outline_items(pdf):
        check.status = PASS
        return
    check.status = WARN
    # `headings` is what decides whether deriving bookmarks is offered at all:
    # `outline_from_structure` refuses a document with none, and a fix button
    # that can only refuse is worse than a route to the panel that can.
    headings = sum(1 for n in tree["nodes"] if n.level is not None) if tree["tagged"] else 0
    check.data = {"pages": total, "tagged": bool(tree["tagged"]), "headings": headings}
    check.findings = [_finding(_object_address(), "no_bookmarks", values={"pages": total})]


def _check_contrast(check, pages):
    measured = []
    for page_no in sorted(pages.contrast):
        measured.extend(pages.contrast[page_no])
    if not measured:
        check.status = NA
        return
    check.counted = len(measured)
    failed = [m for m in measured if m["status"] == "fail"]
    review = [m for m in measured if m["status"] == "review"]
    findings = []
    for m in failed + review:
        findings.append(
            _finding(
                _content_address(m["page"], m["index"]),
                "contrast_below_threshold" if m["status"] == "fail" else "contrast_unknown_backdrop",
                preview=m["text"][:80],
                rect=m["rect"],
                values={
                    "page": m["page"],
                    "ratio": m["ratio"],
                    "required": m["required"],
                    "ink": m["ink"],
                    "background": m["background"],
                },
            )
        )
    check.findings = findings
    if failed:
        check.status = FAIL
    elif review:
        check.status = REVIEW
    else:
        check.status = PASS


def _check_tagged_content(check, tree, pages):
    """A run with no MCID and no /Artifact declaration is untagged content."""
    if not tree["tagged"]:
        check.status = NA
        return
    counted = 0
    findings = []
    for page_no in sorted(pages.runs):
        for run in pages.runs[page_no]:
            if not str(run.get("text") or "").strip():
                continue
            if run.get("nested"):
                # A run inside a form XObject carries that stream's numbering;
                # the page's tagged-MCID set cannot answer for it.
                continue
            counted += 1
            if run.get("artifact"):
                continue
            if run.get("mcid") is not None:
                continue
            findings.append(
                _finding(
                    _content_address(page_no, int(run.get("index", 0))),
                    "content_not_tagged",
                    preview=str(run.get("text") or "")[:80],
                    rect=run.get("rect"),
                    values={"page": page_no},
                )
            )
    check.counted = counted
    check.findings = findings
    if counted == 0:
        check.status = NA
        return
    check.status = FAIL if findings else PASS


def _check_tagged_annotations(check, tree, annots):
    targets = [
        a for a in annots
        if a["subtype"] not in _ANNOT_EXEMPT
        and a["subtype"] not in _MULTIMEDIA
        and _visible(a)
    ]
    if not targets:
        check.status = NA
        return
    tagged = tree["tagged_annots"] if tree["tagged"] else set()
    findings = []
    for annot in targets:
        if annot["objgen"] in tagged:
            continue
        findings.append(
            _finding(
                _object_address(page=annot["page"], annotation=annot["index"]),
                "annotation_not_tagged",
                preview=annot["contents"][:80],
                rect=annot["rect"],
                values={"subtype": annot["subtype"].lstrip("/"), "page": annot["page"]},
            )
        )
    _verdict(check, len(targets), findings)


def _check_tab_order(check, pdf, annots):
    pages_with_annots = {a["page"] for a in annots if _visible(a)}
    if not pages_with_annots:
        check.status = NA
        return
    findings = []
    for page_no in sorted(pages_with_annots):
        page = pdf.pages[page_no - 1]
        try:
            tabs = page.obj.get("/Tabs")
            value = str(tabs).lstrip("/") if tabs is not None else ""
        except Exception:
            value = ""
        if value == "S":
            continue
        findings.append(
            _finding(
                _object_address(page=page_no),
                "tab_order_missing" if not value else "tab_order_not_structure",
                values={"page": page_no, "tabs": value},
            )
        )
    _verdict(check, len(pages_with_annots), findings)


def _check_character_encoding(check, pages):
    """A run whose bytes cannot be mapped to Unicode reads as nothing.

    A run the font decoded to whitespace is NOT that, and it used to be
    reported as that: the old guard skipped a blank run only when it was
    `editable`, and `text_runs` clears `editable` for every blank run by
    construction, so the guard could never fire and every space between two
    words was reported as a font with no Unicode mapping. The reason is
    compared against the constant rather than the sentence.

    A run whose font THIS READER declines is not that either. `reader_limit`
    separates "the document carries no mapping for these bytes", which is a
    defect in the file and a `fail`, from "this build does not implement that
    encoding", which is a gap in us and can only be `needs_review` — reporting
    the second as the first states something false about the reader's document.
    """
    counted = 0
    findings = []
    gaps = []
    seen_fonts: set = set()
    for page_no in sorted(pages.runs):
        for run in pages.runs[page_no]:
            reason = str(run.get("reason") or "")
            if reason == NOTHING_TO_EDIT:
                continue
            counted += 1
            if run.get("editable"):
                continue
            key = (page_no, str(run.get("font_name") or ""), reason)
            if key in seen_fonts:
                continue
            seen_fonts.add(key)
            finding = _finding(
                _content_address(page_no, int(run.get("index", 0))),
                "font_encoding_unsupported" if run.get("reader_limit")
                else "font_has_no_unicode_mapping",
                preview=str(run.get("text") or "")[:80],
                rect=run.get("rect"),
                values={"page": page_no, "font": str(run.get("font_name") or ""),
                        "reason": reason},
            )
            (gaps if run.get("reader_limit") else findings).append(finding)
    _verdict(check, counted, findings)
    # A font we could not read cannot support a clean claim over the text it
    # draws, so a pass becomes a review and the gaps ride with it. A fail
    # stands: it names bytes the DOCUMENT maps to nothing.
    _also_review(check, gaps)


def _check_tagged_multimedia(check, tree, annots):
    targets = [a for a in annots if a["subtype"] in _MULTIMEDIA]
    if not targets:
        check.status = NA
        return
    tagged = tree["tagged_annots"] if tree["tagged"] else set()
    findings = [
        _finding(
            _object_address(page=a["page"], annotation=a["index"]),
            "multimedia_not_tagged",
            rect=a["rect"],
            values={"subtype": a["subtype"].lstrip("/"), "page": a["page"]},
        )
        for a in targets
        if a["objgen"] not in tagged
    ]
    _verdict(check, len(targets), findings)


def _script_findings(sites: list, kinds=None, bodies=None) -> list:
    out = []
    for site in sites:
        if kinds is not None and site["kind"] not in kinds:
            continue
        if bodies is not None and not any(call in site["body"] for call in bodies):
            continue
        out.append(
            _finding(
                site["address"],
                "script_site",
                preview=site["body"][:200],
                values={"kind": site["kind"], "name": site["name"]},
            )
        )
    return out


def _check_screen_flicker(check, sites):
    targets = _script_findings(sites)
    if not targets:
        check.status = NA
        return
    check.counted = len(targets)
    check.findings = targets
    check.status = REVIEW


def _check_scripts(check, sites):
    targets = _script_findings(sites, kinds={"document", "open", "document_event", "annotation", "field_event"})
    if not targets:
        check.status = NA
        return
    check.counted = len(targets)
    check.findings = targets
    check.status = REVIEW


def _check_timed_responses(check, sites):
    targets = _script_findings(sites, bodies=_TIMER_CALLS)
    if not targets:
        check.status = NA
        return
    check.counted = len(targets)
    check.findings = targets
    check.status = REVIEW


def _check_navigation_links(check, annots, pages):
    links = [a for a in annots if a["subtype"] == "/Link" and _visible(a)]
    if not links:
        check.status = NA
        return
    by_label: dict = {}
    by_target: dict = {}
    for link in links:
        runs = pages.runs.get(link["page"]) or []
        label = _rect_text(runs, link["rect"])
        target = _link_target(link["obj"])
        link["label"] = label
        link["target"] = target
        if label:
            by_label.setdefault(label, []).append(link)
        if target:
            by_target.setdefault(target, []).append(link)
    findings = []
    for label, group in sorted(by_label.items()):
        targets = {g["target"] for g in group}
        if len(group) > 1 and len(targets) > 1:
            first = group[0]
            findings.append(
                _finding(
                    _object_address(page=first["page"], annotation=first["index"]),
                    "same_label_different_targets",
                    preview=label[:80],
                    rect=first["rect"],
                    values={"count": len(group), "targets": len(targets)},
                )
            )
    for target, group in sorted(by_target.items()):
        pages_used = {g["page"] for g in group}
        if len(group) > 1 and len(pages_used) > 1:
            first = group[0]
            findings.append(
                _finding(
                    _object_address(page=first["page"], annotation=first["index"]),
                    "repeated_target_across_pages",
                    preview=(first.get("label") or "")[:80],
                    rect=first["rect"],
                    values={"count": len(group), "pages": len(pages_used)},
                )
            )
    check.counted = len(links)
    check.findings = findings
    check.status = REVIEW if findings else PASS


def _check_tagged_form_fields(check, tree, annots, fields):
    widget_ogs: set = set()
    for field in fields:
        widget_ogs.update(field["widgets"])
    widgets = [a for a in annots if a["subtype"] == "/Widget" and _visible(a)]
    if not widgets and not widget_ogs:
        check.status = NA
        return
    tagged = tree["tagged_annots"] if tree["tagged"] else set()
    findings = [
        _finding(
            _object_address(page=a["page"], annotation=a["index"]),
            "form_field_not_tagged",
            rect=a["rect"],
            values={"page": a["page"]},
        )
        for a in widgets
        if a["objgen"] not in tagged
    ]
    _verdict(check, len(widgets), findings)


def _named_objects(node) -> list:
    """Every `/OBJR` address this element and its descendants name.

    An `/Alt` substitutes for the whole element (ISO 32000-2, 14.9.3), so what
    it reaches is the subtree, not the one node that carries it.
    """
    return list(node.objrs) + [o for d in node.descendants() for o in d.objrs]


def _described_objects(tree, annots) -> set:
    """Objgens an element's own `/Alt` already describes.

    ISO 32000-2, 14.9.3: the alternate description is a whole word or phrase
    substitution for the element, and a reader announcing it does not descend.
    A form field tagged by a `Form` element carrying the field's accessible
    name is therefore described — the same shape `_check_alt_hides_annotation`
    declines to fault.
    """
    og_of = {(a["page"], a["index"]): a["objgen"] for a in annots}
    out: set = set()
    for node in tree["nodes"]:
        if not node.alt:
            continue
        for objr in _named_objects(node):
            og = og_of.get((objr.get("page"), objr.get("index")))
            if og is not None:
                out.add(og)
    return out


def _check_field_descriptions(check, tree, annots, fields):
    """A field with no accessible name a reader can reach.

    `/TU` is the field's own alternative name (ISO 32000-2, 14.9.3). Where it
    is absent the name may still arrive through the structure tree, so a field
    an `/Alt` covers is named; and a field whose widgets are all imperceptible
    is owed no name at all.
    """
    if not fields:
        check.status = NA
        return
    by_og = {a["objgen"]: a for a in annots}
    described = _described_objects(tree, annots) if tree["tagged"] else set()
    weighed = 0
    findings = []
    for field in fields:
        records = [by_og[og] for og in field["widgets"] if og in by_og]
        if not _weighable(records, len(records) == len(field["widgets"])):
            continue
        weighed += 1
        if field["description"] or any(og in described for og in field["widgets"]):
            continue
        findings.append(
            _finding(_object_address(field=field["name"]), "field_has_no_description",
                     preview=field["name"], values={"type": field["type"]})
        )
    _verdict(check, weighed, findings)


def _described_by_ancestor(node) -> bool:
    """Is this element covered by an ancestor's own alternate description?

    An `/Alt` describes the element AND everything it tags (ISO 32000
    §14.9.4): a reader that announces it does not descend. So a figure inside
    an alt-carrying ancestor IS described, and reporting it as undescribed is
    the false-failure class this checker exists not to be — it is check 21's
    finding, once, on the nesting itself.
    """
    return any(a.alt for a in node.ancestors())


def _check_figures_alt(check, tree, mcid_tables):
    if not tree["tagged"]:
        check.status = NA
        return
    figures = [n for n in tree["nodes"] if n.role in _FIGURE_ROLES]
    if not figures:
        check.status = NA
        return
    findings = []
    for node in figures:
        # `/ActualText` present and EMPTY is a replacement that states the
        # content has no text equivalent (ISO 32000-2, 14.9.4) — a declaration,
        # not an absence. An empty `/Alt` is neither a word nor a phrase and so
        # describes nothing (14.9.3), which is why only one of the two is
        # tested for presence.
        if node.alt or node.has_actual_text or _described_by_ancestor(node):
            continue
        preview, rect = _node_preview(node, mcid_tables)
        findings.append(
            _finding(_struct_address(node), "figure_missing_alt", preview=preview[:80],
                     rect=rect, values={"role": node.role})
        )
    _verdict(check, len(figures), findings)


def _check_nested_alt(check, tree, mcid_tables):
    if not tree["tagged"]:
        check.status = NA
        return
    with_alt = [n for n in tree["nodes"] if n.alt]
    if not with_alt:
        check.status = NA
        return
    findings = []
    for node in with_alt:
        if not any(a.alt for a in node.ancestors()):
            continue
        preview, rect = _node_preview(node, mcid_tables)
        findings.append(
            _finding(_struct_address(node), "alt_nested_inside_alt", preview=node.alt[:80], rect=rect)
        )
    _verdict(check, len(with_alt), findings)


def _check_alt_no_content(check, tree, mcid_tables):
    if not tree["tagged"]:
        check.status = NA
        return
    with_alt = [n for n in tree["nodes"] if n.alt]
    if not with_alt:
        check.status = NA
        return
    findings = [
        _finding(_struct_address(n), "alt_references_no_content", preview=n.alt[:80])
        for n in with_alt
        if not n.has_content()
    ]
    _verdict(check, len(with_alt), findings)


def _check_alt_hides_annotation(check, tree, annots, fields):
    """An element whose `/Alt` replaces an annotation's OWN description.

    The finding requires the annotation to HAVE a description of its own:
    where it has none, the `/Alt` is the only description there is, and
    clearing it would leave the reader with nothing. Tagging every `/Alt` over
    an OBJR would fail the conforming shape a form field uses — a `Form`
    element carrying the field's accessible name.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    with_alt = [n for n in tree["nodes"] if n.alt]
    if not with_alt:
        check.status = NA
        return
    described: dict = {}
    for annot in annots:
        # An imperceptible annotation's description reaches nobody, so an
        # `/Alt` over it replaces nothing.
        if annot["contents"] and _visible(annot):
            described[(annot["page"], annot["index"])] = annot["contents"]
    by_og = {(a["page"], a["index"]): a["objgen"] for a in annots}
    visible_og = {a["objgen"] for a in annots if _visible(a)}
    widget_desc: dict = {}
    for field in fields:
        for og in field["widgets"]:
            if field["description"] and og in visible_og:
                widget_desc[og] = field["description"]
    findings = []
    for node in with_alt:
        objrs = _named_objects(node)
        hidden = ""
        for objr in objrs:
            key = (objr.get("page"), objr.get("index"))
            own = described.get(key) or widget_desc.get(by_og.get(key))
            if own:
                hidden = own
                break
        if not hidden:
            continue
        findings.append(
            _finding(_struct_address(node), "alt_replaces_annotation", preview=node.alt[:80],
                     values={"hidden": hidden[:80]})
        )
    _verdict(check, len(with_alt), findings)


def _check_other_elements_alt(check, tree, annots, fields, mcid_tables):
    """`Link`, `Form` and `Annot` elements with no description of their own and
    none on the object they name.

    An element whose every named object is imperceptible is not weighed at
    all: nothing reaches the reader there to describe.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    by_address = {(a["page"], a["index"]): a for a in annots}
    targets = []
    for node in tree["nodes"]:
        if node.role not in _OTHER_ALT_ROLES:
            continue
        objrs = _named_objects(node)
        named = [
            by_address[key]
            for key in ((o.get("page"), o.get("index")) for o in objrs)
            if key in by_address
        ]
        if _weighable(named, len(named) == len(objrs)):
            targets.append(node)
    if not targets:
        check.status = NA
        return
    contents_by_address = {(a["page"], a["index"]): a["contents"] for a in annots}
    widget_desc: dict = {}
    for field in fields:
        for og in field["widgets"]:
            widget_desc[og] = field["description"]
    og_address = {(a["page"], a["index"]): a["objgen"] for a in annots}
    findings = []
    for node in targets:
        if node.alt or node.has_actual_text or node.title or _described_by_ancestor(node):
            continue
        described = False
        for objr in node.objrs:
            key = (objr.get("page"), objr.get("index"))
            if contents_by_address.get(key):
                described = True
                break
            og = og_address.get(key)
            if og is not None and widget_desc.get(og):
                described = True
                break
        if described:
            continue
        preview, rect = _node_preview(node, mcid_tables)
        # A Link element whose own text describes the destination is the
        # normal, conforming shape — text IS the accessible name there.
        if node.role == "Link" and preview.strip():
            continue
        findings.append(
            _finding(_struct_address(node), "element_missing_description",
                     preview=preview[:80], rect=rect, values={"role": node.role})
        )
    _verdict(check, len(targets), findings)


def _check_table_rows(check, tree):
    if not tree["tagged"]:
        check.status = NA
        return
    rows = [n for n in tree["nodes"] if n.role == "TR"]
    if not rows:
        check.status = NA
        return
    findings = []
    for row in rows:
        parent = row.parent
        parent_role = parent.role if parent is not None else ""
        if parent_role == "Table":
            continue
        if parent_role in ROW_GROUPS and parent.parent is not None and parent.parent.role == "Table":
            continue
        findings.append(
            _finding(_struct_address(row), "row_outside_table", values={"parent": parent_role})
        )
    _verdict(check, len(rows), findings)


def _check_table_cells(check, tree):
    if not tree["tagged"]:
        check.status = NA
        return
    cells = [n for n in tree["nodes"] if n.role in CELLS]
    if not cells:
        check.status = NA
        return
    findings = []
    for cell in cells:
        if any(a.role == "TR" for a in cell.ancestors()):
            continue
        findings.append(
            _finding(
                _struct_address(cell),
                "cell_outside_row",
                values={"parent": cell.parent.role if cell.parent else ""},
            )
        )
    _verdict(check, len(cells), findings)


def _check_table_headers(check, tree, mcid_tables):
    if not tree["tagged"]:
        check.status = NA
        return
    found = struct_audit.tables(tree["nodes"])
    if not found:
        check.status = NA
        return
    referenced = struct_audit.headers_referenced(tree["nodes"])
    findings = []
    for entry in found:
        table, rows = entry["table"], entry["rows"]
        # Cells are collected from the whole table, not through its rows: a
        # cell nested wrongly is check 26's finding, and reporting "this table
        # has no headers" as well would blame one defect twice.
        cells = [n for n in table.descendants() if n.role in CELLS]
        headers = [c for c in cells if c.role == "TH"]
        if not headers:
            preview, rect = _node_preview(table, mcid_tables)
            findings.append(
                _finding(_struct_address(table), "table_has_no_header_cells", preview=preview[:80],
                         rect=rect, values={"rows": len(rows), "cells": len(cells)})
            )
            continue
        for header in headers:
            if scope(header):
                continue
            if header.sid is not None and header.sid in referenced:
                continue
            preview, rect = _node_preview(header, mcid_tables)
            findings.append(
                _finding(_struct_address(header), "header_cell_has_no_scope", preview=preview[:80],
                         rect=rect)
            )
    _verdict(check, len(found), findings)


def _check_table_regularity(check, tree, mcid_tables):
    """Column counts per row, summing `/ColSpan` and carrying `/RowSpan`
    forward. A regular table with spans read as ragged is the single most
    likely false failure this checker could ship, so the arithmetic is the
    spec's own and a table it cannot model reports nothing."""
    if not tree["tagged"]:
        check.status = NA
        return
    found = struct_audit.tables(tree["nodes"])
    if not found:
        check.status = NA
        return
    findings = []
    unmodellable = []
    unread_spans = []
    for entry in found:
        table, rows = entry["table"], entry["rows"]
        if len(rows) < 2:
            continue
        widths = []
        carried: dict = {}
        modellable = True
        spans_read = True
        for row in rows:
            cells = row_cells(row)
            if not cells:
                modellable = False
                break
            column = 0
            width = 0
            # Cells carried down from an earlier row's /RowSpan occupy their
            # columns before this row's own cells are placed.
            while carried.get(column, 0) > 0:
                carried[column] -= 1
                column += 1
                width += 1
            for cell in cells:
                colspan, col_read = span_of(cell, "ColSpan")
                rowspan, row_read = span_of(cell, "RowSpan")
                # A span that is not a positive integer states nothing about
                # how many columns its cell occupies. The arithmetic carries
                # the spec's default so the walk completes, but a width summed
                # over a default that stood in for an unread value is not a
                # measurement of this table.
                spans_read = spans_read and col_read and row_read
                for offset in range(colspan):
                    if rowspan > 1:
                        carried[column + offset] = rowspan - 1
                column += colspan
                width += colspan
                while carried.get(column, 0) > 0:
                    carried[column] -= 1
                    column += 1
                    width += 1
            widths.append(width)
        if not modellable or len(widths) < 2:
            # A table the arithmetic cannot model is not a regular table; it is
            # a table with no measurement, and silence here reads as one that
            # measured clean.
            preview, rect = _node_preview(table, mcid_tables)
            unmodellable.append(
                _finding(_struct_address(table), "table_not_modellable",
                         preview=preview[:80], rect=rect)
            )
            continue
        if not spans_read:
            preview, rect = _node_preview(table, mcid_tables)
            unread_spans.append(
                _finding(_struct_address(table), "table_span_unreadable",
                         preview=preview[:80], rect=rect)
            )
            continue
        if len(set(widths)) == 1:
            continue
        preview, rect = _node_preview(table, mcid_tables)
        findings.append(
            _finding(_struct_address(table), "table_rows_have_different_widths",
                     preview=preview[:80], rect=rect,
                     values={"widths": sorted(set(widths))})
        )
    _verdict(check, len(found), findings)
    _also_review(check, unmodellable + unread_spans)


def _check_table_summary(check, tree, mcid_tables):
    if not tree["tagged"]:
        check.status = NA
        return
    found = struct_audit.tables(tree["nodes"])
    if not found:
        check.status = NA
        return
    findings = []
    for entry in found:
        table = entry["table"]
        summary = table.attrs.get("Summary")
        if summary is not None and str(summary).strip():
            continue
        preview, rect = _node_preview(table, mcid_tables)
        findings.append(
            _finding(_struct_address(table), "table_has_no_summary", preview=preview[:80], rect=rect)
        )
    # A summary is a recommendation, and a table that does not need one is
    # common: this check warns and never fails.
    _verdict(check, len(found), findings, dirty=WARN)


def _check_list_items(check, tree):
    if not tree["tagged"]:
        check.status = NA
        return
    items = [n for n in tree["nodes"] if n.role == "LI"]
    if not items:
        check.status = NA
        return
    # The parent a placement is judged against is the EFFECTIVE one (ISO
    # 32000-2 Table 365), read through the one implementation `struct_nesting`
    # owns: a grouping element that inherits its parent's containment is not a
    # container of its own, so a `LI` reached through one is still in its list.
    parents = [struct_nesting.effective_parent(n) for n in items]
    findings = [
        _finding(_struct_address(n), "list_item_outside_list",
                 values={"parent": p.role if p is not None else ""})
        for n, p in zip(items, parents)
        if not (p is not None and p.role == "L")
    ]
    _verdict(check, len(items), findings)


def _check_list_labels(check, tree):
    if not tree["tagged"]:
        check.status = NA
        return
    # `Lbl` is a GENERAL inline label (ISO 32000-2, Table 368): it enumerates a
    # section heading, a footnote, a definition term, a table-of-contents entry
    # or a form field's label just as legitimately as a list item's bullet, so
    # its parent is no business of a list check. `LBody` is the one that is
    # bound to lists — its category is internal to `LI` structure elements.
    bodies = [n for n in tree["nodes"] if n.role == "LBody"]
    items = [n for n in tree["nodes"] if n.role == "LI"]
    if not bodies and not items:
        check.status = NA
        return
    # Same effective-parent read as `list_items`, for the same reason: Table
    # 365's grouping elements carry their parent's containment, so an `LBody`
    # reached through one is still inside its list item.
    parents = [struct_nesting.effective_parent(n) for n in bodies]
    misplaced = [
        _finding(_struct_address(n), "label_outside_list_item",
                 values={"role": n.role, "parent": p.role if p is not None else ""})
        for n, p in zip(bodies, parents)
        if not (p is not None and p.role == "LI")
    ]
    unlabelled = [
        _finding(_struct_address(n), "list_item_has_no_label")
        for n in items
        if any(c.role == "LBody" for c in n.children) and not any(c.role == "Lbl" for c in n.children)
    ]
    check.counted = len(bodies) + len(items)
    check.findings = misplaced + unlabelled
    if check.counted == 0:
        check.status = NA
    elif misplaced:
        check.status = FAIL
    elif unlabelled:
        # An unnumbered list legitimately has no labels.
        check.status = WARN
    else:
        check.status = PASS


# Placement of these roles is the answer of the check that already owns the
# role, so this check judges them and reports nothing: one defect reported
# under two ids is noise, and the two check sets divide the world between what
# an element IS and where it sits.
_NESTING_DELEGATED = {
    "TR": "table_rows",
    "TH": "table_cells",
    "TD": "table_cells",
    "LI": "list_items",
    "LBody": "list_labels",
}


def _check_structure_nesting(check, tree):
    if not tree["tagged"]:
        check.status = NA
        return
    edges, unread = nesting_edges(tree)
    judged = 0
    delegated = 0
    uncovered = 0
    findings = []
    for edge in edges:
        verdict, _cite, _rule = struct_nesting.judge(edge)
        if verdict == struct_nesting.UNCOVERED:
            uncovered += 1
            continue
        if edge.role in _NESTING_DELEGATED:
            delegated += 1
            continue
        judged += 1
        if verdict != struct_nesting.VIOLATION:
            continue
        findings.append(
            _finding(
                _struct_address(edge.node),
                "structure_nesting_violation",
                values={
                    "child": edge.role,
                    "parent": edge.parent_role,
                    "page": edge.node.page,
                },
            )
        )
    # What was checked is stated alongside the verdict: a type the compiled
    # tables hold no rule for is counted, never reported as verified.
    check.data = {"judged": judged, "delegated": delegated, "uncovered": uncovered}
    _verdict(check, judged, findings)
    _also_review(
        check,
        [
            _finding(
                {"kind": "struct", "path": list(u["path"]), "page": u["page"]},
                "structure_nesting_unreadable",
                values={"reason": u["reason"]},
            )
            for u in unread
        ],
    )


def _check_heading_nesting(check, tree, mcid_tables):
    if not tree["tagged"]:
        check.status = NA
        return
    headings = [n for n in tree["nodes"] if n.level is not None]
    if not headings:
        check.status = NA
        return
    findings = []
    previous = None
    for node in headings:
        if previous is not None and node.level > previous + 1:
            preview, rect = _node_preview(node, mcid_tables)
            findings.append(
                _finding(_struct_address(node), "heading_level_skipped", preview=preview[:80],
                         rect=rect, values={"from": previous, "to": node.level})
            )
        # A document that legitimately starts at H2 does not fail: the first
        # heading sets the baseline rather than being measured against H1.
        previous = node.level
    _verdict(check, len(headings), findings)


# ── the English surface ───────────────────────────────────────────────────

# Every check's name and its one-line explanation, in English.
#
# Refusals stay English at the engine and are mapped at the bridge; a check
# NAME is the same kind of thing, so it lives here and a UI with a catalog of
# its own renders the catalog entry keyed by the check id instead. A caller
# with no catalog — the command line, and any reader of the flat `checks`
# array — gets a readable report rather than a list of identifiers.
_ENGLISH = {
    "permissions": (
        "Assistive technology may read the document",
        "Encryption permissions must allow text extraction for accessibility.",
    ),
    "image_only": (
        "Pages are not image-only",
        "A scanned page with no recognized text has nothing to read aloud.",
    ),
    "tagged": (
        "Document is tagged",
        "Structure tags let assistive technology read content in a defined order.",
    ),
    "structure_nesting": (
        "Structure types are nested where the standard allows",
        "A tag inside a parent the standard does not allow it in breaks the structure it describes.",
    ),
    "reading_order": (
        "Reading order follows the page",
        "Tag order is what is read; where it disagrees with the layout, a person decides.",
    ),
    "lang": (
        "Document language is set",
        "A declared language is what picks the right pronunciation.",
    ),
    "title": (
        "Document has a title, and shows it",
        "The title names the document in the window bar instead of the file name.",
    ),
    "bookmarks": (
        "Long document has bookmarks",
        "Bookmarks are how a long document is navigated without reading it through.",
    ),
    "contrast": (
        "Text has sufficient colour contrast",
        "Text must stand out from what is painted under it, at the published ratio.",
    ),
    "tagged_content": (
        "All page content is tagged",
        "Text covered by no tag and not declared decoration is never read.",
    ),
    "tagged_annotations": (
        "Annotations are tagged",
        "An annotation outside the structure tree has no place in the reading order.",
    ),
    "tab_order": (
        "Pages with annotations declare a tab order",
        "Without a structure tab order, keyboard focus follows the order of the file.",
    ),
    "character_encoding": (
        "Characters map to readable text",
        "A font whose bytes map to no character cannot be read aloud or searched.",
    ),
    "tagged_multimedia": (
        "Multimedia is tagged",
        "Sound and video annotations need a place in the structure like any content.",
    ),
    "screen_flicker": (
        "Nothing flashes the screen",
        "Page actions and scripts can flash the screen; each site needs a look.",
    ),
    "scripts": (
        "Scripts are accessible",
        "A script that changes the page must not leave assistive technology behind.",
    ),
    "timed_responses": (
        "Nothing is on a timer",
        "A response the reader has to give before a clock runs out needs a way out.",
    ),
    "navigation_links": (
        "Navigation links are distinguishable",
        "Links reading alike but going elsewhere cannot be told apart out of context.",
    ),
    "tagged_form_fields": (
        "Form fields are tagged",
        "A field outside the structure tree is not reached in the reading order.",
    ),
    "field_descriptions": (
        "Form fields have descriptions",
        "A field with no description is announced by its internal name, or not at all.",
    ),
    "figures_alt": (
        "Figures have alternate text",
        "A figure with no description conveys nothing to a reader who cannot see it.",
    ),
    "nested_alt": (
        "No alternate text inside alternate text",
        "A description inside another description is never read.",
    ),
    "alt_no_content": (
        "Alternate text is attached to content",
        "A description on an element that tags nothing describes nothing.",
    ),
    "alt_hides_annotation": (
        "Alternate text does not hide an annotation",
        "A description on a tag wrapping an annotation replaces the annotation's own.",
    ),
    "other_elements_alt": (
        "Links, forms and annotations are described",
        "These elements need a description of their own or one on the object they name.",
    ),
    "table_rows": (
        "Rows are inside a table",
        "A row outside a table is not read as part of one.",
    ),
    "table_cells": (
        "Cells are inside a row",
        "A cell outside a row has no position in the table.",
    ),
    "table_headers": (
        "Tables have header cells",
        "Header cells and their scope are what associate a value with what it means.",
    ),
    "table_regularity": (
        "Table rows have the same width",
        "Rows of different widths cannot be navigated cell by cell.",
    ),
    "table_summary": (
        "Tables have a summary",
        "A summary states what a complex table shows before it is read cell by cell.",
    ),
    "list_items": (
        "List items are inside a list",
        "An item outside a list is not announced as part of one.",
    ),
    "list_labels": (
        "Labels and bodies are inside a list item",
        "A label or body outside its item loses the item it belongs to.",
    ),
    "heading_nesting": (
        "Heading levels are not skipped",
        "Headings are how a document is skimmed; a skipped level breaks the outline.",
    ),
}

_STATUS_ENGLISH = {
    PASS: "Passed",
    FAIL: "Failed",
    WARN: "Short of the recommendation",
    REVIEW: "Needs review",
    NA: "Not applicable — the document has nothing this check applies to",
}


def _with_english(row: dict) -> dict:
    label, explanation = _ENGLISH[row["id"]]
    detail = f"{_STATUS_ENGLISH[row['status']]}. {explanation}"
    findings = len(row["findings"])
    if findings:
        detail += f" {findings} of {row['counted']} checked."
    row["label"] = label
    row["detail"] = detail
    return row


# ── assembly ──────────────────────────────────────────────────────────────


def check_accessibility(file: str, category: str | None = None) -> dict:
    """Run the accessibility inventory over one document.

    `category` restricts the run to one of `CATEGORIES`; every other check
    still appears, reporting `not_applicable` for "not run", which keeps the
    report shape one shape.

    Each inventory read is fail-OPEN at its own boundary. A read that raises
    where nothing anticipated it becomes the same gap a read that returned
    nothing does, so the answer to "is this document accessible" is 31 checks
    and one review row rather than no report at all.
    """
    if category is not None and category not in CATEGORIES:
        raise ValueError(
            f"unknown accessibility category '{category}' "
            f"(expected one of: {', '.join(CATEGORIES)})"
        )
    checks = {cid: _Check(cid, cat) for cid, cat in CHECK_INVENTORY}

    def read(inventory):
        """An inventory and its gaps, where a raise IS a gap."""
        try:
            return inventory()
        except Exception as exc:
            return [], [{"reason": str(exc)}]

    with pikepdf.open(file) as pdf:
        pages = _Pages(pdf)
        entries, annots_unread = read(lambda: annots_of(pdf))
        tree = audit_tree(pdf, entries)
        annots, annots_gaps = read(lambda: (_annotations(entries), []))
        annots_unread = annots_unread + annots_gaps
        fields, fields_unread = read(lambda: _fields(pdf))
        sites, sites_unread = read(lambda: _script_sites(pdf, entries))
        mcid_tables = {p: _mcid_text(runs) for p, runs in pages.runs.items()}

        run = {
            "permissions": lambda c: _check_permissions(c, pdf),
            "image_only": lambda c: _check_image_only(c, pdf, pages, file),
            "tagged": lambda c: _check_tagged(c, pdf, tree),
            "structure_nesting": lambda c: _check_structure_nesting(c, tree),
            "reading_order": lambda c: _check_reading_order(c, tree, pages, mcid_tables),
            "lang": lambda c: _check_lang(c, pdf, tree, pages),
            "title": lambda c: _check_title(c, pdf),
            "bookmarks": lambda c: _check_bookmarks(c, pdf, tree),
            "contrast": lambda c: _check_contrast(c, pages),
            "tagged_content": lambda c: _check_tagged_content(c, tree, pages),
            "tagged_annotations": lambda c: _check_tagged_annotations(c, tree, annots),
            "tab_order": lambda c: _check_tab_order(c, pdf, annots),
            "character_encoding": lambda c: _check_character_encoding(c, pages),
            "tagged_multimedia": lambda c: _check_tagged_multimedia(c, tree, annots),
            "screen_flicker": lambda c: _check_screen_flicker(c, sites),
            "scripts": lambda c: _check_scripts(c, sites),
            "timed_responses": lambda c: _check_timed_responses(c, sites),
            "navigation_links": lambda c: _check_navigation_links(c, annots, pages),
            "tagged_form_fields": lambda c: _check_tagged_form_fields(c, tree, annots, fields),
            "field_descriptions": lambda c: _check_field_descriptions(c, tree, annots, fields),
            "figures_alt": lambda c: _check_figures_alt(c, tree, mcid_tables),
            "nested_alt": lambda c: _check_nested_alt(c, tree, mcid_tables),
            "alt_no_content": lambda c: _check_alt_no_content(c, tree, mcid_tables),
            "alt_hides_annotation": lambda c: _check_alt_hides_annotation(c, tree, annots, fields),
            "other_elements_alt": lambda c: _check_other_elements_alt(c, tree, annots, fields, mcid_tables),
            "table_rows": lambda c: _check_table_rows(c, tree),
            "table_cells": lambda c: _check_table_cells(c, tree),
            "table_headers": lambda c: _check_table_headers(c, tree, mcid_tables),
            "table_regularity": lambda c: _check_table_regularity(c, tree, mcid_tables),
            "table_summary": lambda c: _check_table_summary(c, tree, mcid_tables),
            "list_items": lambda c: _check_list_items(c, tree),
            "list_labels": lambda c: _check_list_labels(c, tree),
            "heading_nesting": lambda c: _check_heading_nesting(c, tree, mcid_tables),
        }
        for cid, check in checks.items():
            if category is not None and check.category != category:
                continue
            run[cid](check)

        unreadable = list(pages.unreadable)
        truncated = list(tree.get("truncated") or [])

    # Fail-closed, five reads: a page, an annotation list, a field tree, a
    # script site or a branch of the structure tree that would not read cannot
    # support a clean claim from any check that consumed it.
    for cid in _PAGE_CHECKS:
        _also_review(
            checks[cid],
            [
                _finding(_object_address(page=u["page"]), "page_unreadable",
                         values={"page": u["page"]})
                for u in unreadable
            ],
        )
    for cid in _ANNOTATION_CHECKS:
        _also_review(
            checks[cid],
            [
                _finding(_object_address(page=u["page"]), "annotations_unreadable",
                         values={"page": u["page"]})
                if u.get("page")
                # A gap the reader could not attribute to a page: its sentence
                # cannot name one, so it is a key of its own rather than one
                # rendering an uninterpolated page number.
                else _finding(_object_address(), "annotations_unreadable_document")
                for u in annots_unread
            ],
        )
    for cid in _FIELD_CHECKS:
        _also_review(
            checks[cid],
            [_finding(_object_address(), "fields_unreadable") for _ in fields_unread],
        )
    # An annotation the reader could not reach is a script site nobody looked
    # at: /A and /AA are read off the same entries, so the script inventory is
    # short by exactly what the annotation inventory is short by.
    for cid in _SCRIPT_CHECKS:
        _also_review(
            checks[cid],
            [
                _finding(
                    _object_address(page=u["page"]) if u.get("page") else _object_address(),
                    "scripts_unreadable",
                )
                for u in sites_unread + annots_unread
            ],
        )
    tree_gaps = [
        _finding(
            {"kind": "struct", "path": list(t["path"]), "page": t["page"]},
            "structure_truncated",
            values={"reason": t["reason"]},
        )
        for t in truncated
    ]
    for cid in _STRUCTURE_CHECKS:
        _also_review(
            checks[cid],
            tree_gaps,
            states=(PASS, NA, FAIL) if cid in _TREE_ABSENCE_CHECKS else (PASS, NA),
        )

    ordered = [checks[cid] for cid, _ in CHECK_INVENTORY]
    by_category = []
    for cat in CATEGORIES:
        rows = [c.to_json() for c in ordered if c.category == cat]
        applicable = sum(1 for r in rows if r["status"] != NA)
        by_category.append(
            {
                "id": cat,
                "checks": rows,
                "passed": sum(1 for r in rows if r["status"] == PASS),
                "applicable": applicable,
            }
        )
    summary = {
        "passed": sum(1 for c in ordered if c.status == PASS),
        "failed": sum(1 for c in ordered if c.status == FAIL),
        "warnings": sum(1 for c in ordered if c.status == WARN),
        "needs_review": sum(1 for c in ordered if c.status == REVIEW),
        "not_applicable": sum(1 for c in ordered if c.status == NA),
        "applicable": sum(1 for c in ordered if c.status != NA),
        "total": len(ordered),
    }
    return {
        "categories": by_category,
        "summary": summary,
        "unreadable": unreadable,
        # The flat list, for a reader that has no notion of a category — the
        # same 32 rows in the same order, each carrying the English name and
        # sentence a caller with no catalog of its own renders (the CLI, and
        # the panel until it reads `categories`).
        "checks": [_with_english(c.to_json()) for c in ordered],
    }
