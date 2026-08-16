"""The comment SUMMARY — the review model, and the document that carries it.

Two ops, one model.

`list_comments` reads the whole review model: author, both dates, subject,
state, name, and the reply thread. `list_annotations` returns five fields and
stays exactly as it is — the Comments overview count and the spelling
checker's annotation walk both depend on its shape.

`summarize_comments` authors a NEW PDF: the source page as an image with the
comments laid out beside or beneath it and lines drawn from each comment's
position to its entry. The page image is `watermark._lift_page`, not the
Ghostscript flatten: `-dUseCropBox` translates the origin, so connector math
that read rects from the original and geometry from the flattened copy would
be wrong by the crop origin on every cropped page; and a comment whose /F
lacks the print bit does not survive that flatten in either mode, so a summary
built on it would list a comment and point a line at blank paper.
`_lift_page` folds the crop origin into the form's own /Matrix and draws every
annotation that is neither Hidden nor NoView, which is a review artefact's
semantics rather than a press plate's.

Because the form's /Matrix already folds the crop origin, the placement matrix
is composed with it directly — `sheet = place_in_cell(...) · /Matrix · point`.
The extra crop-origin subtraction an imposition does belongs to a form built
by `Page.as_form_xobject`, whose /Matrix is the identity and whose /BBox
origin is the crop origin; applying it here would shift every cropped page by
its crop origin twice.

The placement math is `print_layout.place_in_cell`; the page lift and the
appearance placement are `watermark`'s. What is new here is a column of
authored text with lines drawn to the artwork beside it.

ORDERING AND FILTERING LIVE HERE, not in a panel: the document author, the
on-screen list and the command line are three readers of one order, and a sort
the on-screen list could not reproduce would be a second answer to "which
comments, in what order".

The reconciliation invariant every summary states and every test asserts:

    found == written + filtered + unmodelled

`found` counts every annotation on a readable page that could be a comment —
everything except /Popup (it rides its parent), /Widget (a form field) and
/Link (a navigation region). `filtered` is what the caller's filter removed;
`unmodelled` is a subtype outside the shipped markup set. Comments written
WITHOUT a badge (no readable /Rect) and comments whose body would not lay out
are counted separately: they are written, so they are already inside
`written`, and the counts say what was lost about them.

The engine never translates. Furniture strings arrive as `labels`, resolved by
the caller from its own catalog; the defaults below are the English the
command line gets. Bodies, author names and subjects are authored content and
are emitted verbatim.
"""

from __future__ import annotations

import re
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from engine.annotations import (
    GROUP,
    REPLY,
    UNKNOWN,
    _MARKUP,
    _rect,
    _str,
    reply_relationship,
)
from engine.create_pdf import PAGE_SIZES
from engine.pdf_save import save_pdf
from engine.print_layout import expand_page_spec, place_in_cell
from engine.redact import _annot_key
from engine.text_authoring import block_height, emit_text_box, layout_text_box
from engine.watermark import _lift_page, _resolve_box, _resolve_rotate, _source_matrix

#: Annotations that are not comments and never enter the count: a popup rides
#: its parent, a widget is a form field, a link is a navigation region.
_NOT_A_COMMENT = frozenset({"/Popup", "/Widget", "/Link"})

SORTS = ("page", "author", "date", "type")
MODES = ("comments_only", "document_and_comments")
PLACEMENTS = ("auto", "beside", "beneath", "separate")
FILTER_KEYS = ("authors", "subtypes", "states", "pages", "has_body")

DEFAULT_GUTTER = 216.0
_PAD = 18.0
_TITLE_SIZE = 13.0
_HEADING_SIZE = 10.0
_ENTRY_SIZE = 9.0
_UNIT_GAP = 7.0
_REPLY_INDENT = 16.0
_BADGE_RADIUS = 7.5
_BADGE_SIZE = 7.0
_CONNECTOR_GRAY = 0.45

#: The furniture, in English. A caller that passes none gets these; a caller
#: that passes some gets those and these for the rest, so a line the caller
#: has not translated yet can never render as an empty string.
DEFAULT_LABELS: dict[str, str] = {
    "title": "Comment summary",
    "document": "Document: {{name}}",
    "pageHeading": "Page {{page}}",
    "pageContinued": "Page {{page}} (continued)",
    "entryHeader": "{{badge}}. {{author}}",
    "entryMeta": "{{date}} · page {{page}} · {{type}}",
    "replyHeader": "Reply — {{author}}",
    "replyMeta": "Replied {{date}}",
    "continued": "{{author}} (continued)",
    "subject": "Subject: {{subject}}",
    "state": "Status: {{state}} ({{model}})",
    "stateNoModel": "Status: {{state}}",
    "groupMember": "Grouped with the entry by {{author}}",
    "relationshipUnknown": "Related to another comment in a way this document does not define",
    "replyOrphan": "In reply to a comment that is not in this document",
    "replyCycle": "This reply chain refers to itself",
    "noPosition": "This comment has no readable position on its page.",
    "noBody": "(no text)",
    "unknownAuthor": "Unknown author",
    "bodyRefused": "This comment's text could not be laid out and is not shown here.",
    "dateMissing": "no date recorded",
    "dateNoOffset": "{{date}} (time zone not recorded)",
    "reconcileHeading": "Reconciliation",
    "reconcileFound": "Comments in the document: {{count}}",
    "reconcileWritten": "Comments in this summary: {{count}}",
    "reconcileFiltered": "Removed by the filter: {{count}}",
    "reconcileUnmodelled": "Annotation types this product does not model: {{count}}",
    "reconcileNoPosition": "Written without a badge (no readable position): {{count}}",
    "reconcileBodyRefused": "Written without their text (it would not lay out): {{count}}",
    "reconcileUnreadable": "Pages whose annotation list could not be read: {{pages}}",
    "reconcileNoBox": "Pages with no media or crop box, listed without an image: {{pages}}",
    "reconcileBalanced": "Every comment in the document is accounted for above.",
    "sortedBy": "Sorted by: {{sort}}",
    "sortPage": "page",
    "sortAuthor": "author",
    "sortDate": "date",
    "sortType": "type",
}

#: Which furniture line names each ordering. A table rather than a built key,
#: so a sort with no name fails at import instead of printing its own
#: identifier into a document.
_SORT_LABEL = {
    "page": "sortPage",
    "author": "sortAuthor",
    "date": "sortDate",
    "type": "sortType",
}


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------

_DATE_RE = re.compile(
    r"D:(?P<year>\d{4})(?P<month>\d{2})?(?P<day>\d{2})?(?P<hour>\d{2})?"
    r"(?P<minute>\d{2})?(?P<second>\d{2})?"
    r"(?:(?P<sign>[+\-Z])(?:(?P<oh>\d{2})'?(?:(?P<om>\d{2})'?)?)?)?$"
)


def parse_pdf_date(text: str) -> dict | None:
    """A PDF date string as its own fields, or None when it is not one.

    The offset is DATA and is reported as recorded: a value carrying none
    reports `offset: None` rather than being read as UTC, because the wall
    clock is local time either way and inventing a zone moves a comment across
    a date boundary for every reader who is not in the author's. The trailing
    apostrophe of the pre-2.0 spelling is accepted, as is a bare Z and a Z
    followed by zero offsets.
    """
    if not text:
        return None
    m = _DATE_RE.match(text.strip())
    if m is None:
        return None
    g = m.groupdict()
    out = {
        "year": int(g["year"]),
        "month": int(g["month"] or 1),
        "day": int(g["day"] or 1),
        "hour": int(g["hour"] or 0),
        "minute": int(g["minute"] or 0),
        "second": int(g["second"] or 0),
        "offset": None,
    }
    if not (1 <= out["month"] <= 12 and 1 <= out["day"] <= 31):
        return None
    if out["hour"] > 23 or out["minute"] > 59 or out["second"] > 59:
        return None
    sign = g["sign"]
    if sign == "Z":
        out["offset"] = 0
    elif sign in ("+", "-"):
        minutes = int(g["oh"] or 0) * 60 + int(g["om"] or 0)
        out["offset"] = -minutes if sign == "-" else minutes
    return out


def _date_field(raw: str) -> dict | None:
    """`{raw, …}` for a date entry, or None when the key is absent.

    A /M that is not a date string still renders: the date format is a should,
    and a processor is required to accept and display whatever the string
    holds. An unparseable value keeps `raw` and nothing else, and every reader
    shows it verbatim.
    """
    if not raw:
        return None
    parsed = parse_pdf_date(raw)
    if parsed is None:
        return {"raw": raw}
    out = {"raw": raw}
    out.update(parsed)
    return out


def _date_key(entry: dict | None) -> tuple:
    """A total sort key for a date field. Unparseable and absent sort LAST, so
    a document whose dates are damaged still orders deterministically."""
    if entry is None or "year" not in entry:
        return (1, 0, 0, 0, 0, 0)
    minutes = entry["hour"] * 60 + entry["minute"] - (entry["offset"] or 0)
    return (0, entry["year"], entry["month"], entry["day"], minutes, entry["second"])


def _render_date(entry: dict | None, labels: dict, rendered: dict) -> str:
    """The date as the reader sees it.

    `rendered` maps a raw PDF date string to the caller's own formatting of
    it — the VALUE is the document's, the FORMAT is the reader's. The engine's
    own fallback is the command line's: the recorded wall clock, with the
    recorded offset beside it and never converted to this machine's.
    """
    if entry is None:
        return labels["dateMissing"]
    raw = entry["raw"]
    if raw in rendered:
        return rendered[raw]
    if "year" not in entry:
        return raw
    stamp = (
        f"{entry['year']:04d}-{entry['month']:02d}-{entry['day']:02d} "
        f"{entry['hour']:02d}:{entry['minute']:02d}"
    )
    offset = entry["offset"]
    if offset is None:
        return _fill(labels["dateNoOffset"], {"date": stamp})
    sign = "+" if offset >= 0 else "-"
    return f"{stamp} UTC{sign}{abs(offset) // 60:02d}:{abs(offset) % 60:02d}"


# ---------------------------------------------------------------------------
# Furniture
# ---------------------------------------------------------------------------

_PLACEHOLDER = re.compile(r"\{\{([A-Za-z][A-Za-z0-9_]*)\}\}")


def _fill(template: str, values: dict) -> str:
    """Interpolate `{{name}}` placeholders. A name the caller did not supply
    stays as written rather than becoming a gap the reader cannot account
    for."""
    return _PLACEHOLDER.sub(
        lambda m: str(values[m.group(1)]) if m.group(1) in values else m.group(0),
        template,
    )


def _resolve_labels(labels: dict | None) -> dict:
    out = dict(DEFAULT_LABELS)
    for key, value in (labels or {}).items():
        if key != "types" and isinstance(value, str) and value:
            out[key] = value
    return out


def _type_names(labels: dict | None) -> dict:
    names: dict[str, str] = {}
    supplied = (labels or {}).get("types")
    if isinstance(supplied, dict):
        for key, value in supplied.items():
            if isinstance(value, str) and value:
                names[str(key).lstrip("/").lower()] = value
    return names


class _Digits:
    """Numbers written into the document, in the reader's own digits.

    The engine substitutes numbers into furniture templates, so the digit set
    has to travel with the furniture — otherwise a locale whose numerals are
    not ASCII gets its own headings with Western digits inside them.
    """

    __slots__ = ("table",)

    def __init__(self, digits: str | None):
        self.table = digits if digits and len(digits) == 10 else "0123456789"

    def __call__(self, value) -> str:
        text = str(value)
        if self.table == "0123456789":
            return text
        return "".join(self.table[ord(c) - 48] if "0" <= c <= "9" else c for c in text)


# ---------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------

def _validate_filter(spec: dict | None, page_count: int) -> dict:
    """The filter, normalized. An unknown key or an unknown subtype refuses BY
    NAME: a silently-coerced selection reports a success that narrowed
    something other than what was asked for."""
    if not spec:
        return {}
    if not isinstance(spec, dict):
        raise ValueError("a comment filter is a set of named conditions")
    unknown = sorted(str(k) for k in spec if k not in FILTER_KEYS)
    if unknown:
        names = ", ".join(unknown)
        raise ValueError(f"not a comment filter: {names}")
    out: dict = {}
    if spec.get("authors"):
        out["authors"] = {str(a) for a in spec["authors"]}
    if spec.get("subtypes"):
        wanted = {f"/{str(s).lstrip('/')}" for s in spec["subtypes"]}
        bad = sorted(s for s in wanted if s not in _MARKUP)
        if bad:
            subtypes = ", ".join(s.lstrip("/") for s in bad)
            raise ValueError(
                f"not a comment subtype the summary can filter on: {subtypes}"
            )
        out["subtypes"] = wanted
    if spec.get("states"):
        out["states"] = {str(s) for s in spec["states"]}
    if spec.get("pages"):
        pages = str(spec["pages"])
        if not re.fullmatch(r"\d+(-\d+)?(,\d+(-\d+)?)*", pages):
            raise ValueError(f"not a page range the summary can read: {pages}")
        out["pages"] = {i + 1 for i in expand_page_spec(pages, page_count)}
    if spec.get("has_body") is not None:
        out["has_body"] = bool(spec["has_body"])
    return out


def _keeps(comment: dict, spec: dict) -> bool:
    if "authors" in spec and comment["author"] not in spec["authors"]:
        return False
    if "subtypes" in spec and f"/{comment['subtype']}" not in spec["subtypes"]:
        return False
    if "states" in spec and comment["state"] not in spec["states"]:
        return False
    if "pages" in spec and comment["page"] not in spec["pages"]:
        return False
    if "has_body" in spec and bool(comment["contents"].strip()) != spec["has_body"]:
        return False
    return True


def _read(pdf) -> tuple[list[dict], dict, list[dict], int]:
    """Every candidate comment in document order, plus what could not be read.

    `by_key` maps `redact._annot_key` to the comment, so an /IRT — an object
    reference — resolves across the WHOLE document. A conforming file keeps a
    reply on its target's page; a file that does not is exactly the file this
    walk exists to survive, and the fixture's orphan points at an object that
    is on no page at all.
    """
    comments: list[dict] = []
    by_key: dict = {}
    unreadable: list[dict] = []
    unmodelled = 0
    for index, page in enumerate(pdf.pages):
        number = index + 1
        try:
            annots = page.obj.get("/Annots")
            if annots is None:
                entries = []
            elif isinstance(annots, pikepdf.Array):
                entries = list(annots)
            else:
                # An /Annots that is not an array carries no readable comment
                # list. Iterating it yields nothing, which would report a clean
                # page — the third state a caller must not be able to mistake
                # for "this page has no comments".
                unreadable.append({"page": number, "reason": "Annots"})
                continue
        except Exception as exc:
            unreadable.append({"page": number, "reason": type(exc).__name__})
            continue
        for annot in entries:
            try:
                subtype = str(annot.get("/Subtype"))
            except Exception:
                unreadable.append({"page": number, "reason": "Subtype"})
                continue
            if subtype in _NOT_A_COMMENT:
                continue
            if subtype not in _MARKUP:
                unmodelled += 1
                continue
            relationship = reply_relationship(annot)
            reply_key = (
                _annot_key(relationship.target)
                if relationship.target is not None
                else None
            )
            reply_type = relationship.kind
            comment = {
                "id": f"c{len(comments) + 1}",
                "page": number,
                "subtype": subtype.lstrip("/"),
                "rect": _rect(annot),
                "contents": _str(annot, "/Contents"),
                "author": _str(annot, "/T"),
                "subject": _str(annot, "/Subj"),
                "created": _date_field(_str(annot, "/CreationDate")),
                "modified": _date_field(_str(annot, "/M")),
                "state": _str(annot, "/State"),
                "state_model": _str(annot, "/StateModel"),
                "name": _str(annot, "/NM"),
                "reply_to": None,
                "reply_type": reply_type,
                "children": [],
                "orphan": False,
                "cycle": False,
                "order": len(comments),
                "reply_key": reply_key,
            }
            by_key[_annot_key(annot)] = comment
            comments.append(comment)
    return comments, by_key, unreadable, unmodelled


def _link_threads(comments: list[dict], by_key: dict) -> None:
    """Resolve every /IRT against the surviving set.

    An orphan is PROMOTED, never dropped: the target may be absent, may not be
    a markup annotation, or may have been filtered away, and in all three
    cases the text is a reviewer's. A cycle is promoted the same way, every
    member of it, and both promotions are marked so the entry can say so.
    """
    alive = {id(c) for c in comments}
    for comment in comments:
        key = comment["reply_key"]
        if key is None:
            continue
        parent = by_key.get(key)
        if parent is None or id(parent) not in alive:
            comment["orphan"] = True
            continue
        comment["reply_to"] = parent["id"]

    by_id = {c["id"]: c for c in comments}
    for comment in comments:
        seen = [comment["id"]]
        walker = comment
        while walker["reply_to"] is not None:
            walker = by_id.get(walker["reply_to"])
            if walker is None:
                break
            if walker["id"] in seen:
                for member in seen:
                    by_id[member]["cycle"] = True
                    by_id[member]["reply_to"] = None
                break
            seen.append(walker["id"])

    for comment in comments:
        parent_id = comment["reply_to"]
        if parent_id is not None and comment["reply_type"] == REPLY:
            by_id[parent_id]["children"].append(comment["id"])


def _sort_key(sort: str, comment: dict):
    """Ties always break to document order, so the ordering is total and two
    runs of one sort cannot differ."""
    if sort == "author":
        return (comment["author"].casefold(), comment["order"])
    if sort == "date":
        return (_date_key(comment["modified"] or comment["created"]), comment["order"])
    if sort == "type":
        return (comment["subtype"], comment["order"])
    return (comment["page"], comment["order"])


def _thread_order(comment: dict, by_id: dict) -> list[dict]:
    """One thread, flattened: the parent, then its replies in /CreationDate,
    then /M, then document order — never /IRT depth, because a flat chain and
    a tree both occur and depth ordering scrambles the flat one."""
    out = [comment]
    children = [by_id[c] for c in comment["children"] if c in by_id]
    children.sort(
        key=lambda c: (_date_key(c["created"]), _date_key(c["modified"]), c["order"])
    )
    for child in children:
        out.extend(_thread_order(child, by_id))
    return out


def build_model(pdf, sort: str = "page", filter: dict | None = None) -> dict:
    """The ordered, narrowed review model for an already-open document."""
    if sort not in SORTS:
        raise ValueError(f"not a way to sort comments: {sort}")
    comments, by_key, unreadable, unmodelled = _read(pdf)
    found = len(comments) + unmodelled
    spec = _validate_filter(filter, len(pdf.pages))

    authors = sorted({c["author"] for c in comments if c["author"]})
    subtypes = sorted({c["subtype"] for c in comments})
    states = sorted({c["state"] for c in comments if c["state"]})

    kept = [c for c in comments if _keeps(c, spec)]
    filtered = len(comments) - len(kept)
    survivors = {id(c) for c in kept}
    _link_threads(kept, {k: c for k, c in by_key.items() if id(c) in survivors})

    by_id = {c["id"]: c for c in kept}
    # Anything that is not a REPLY is its own top-level entry naming its
    # target, never nested under it: R and Group are different relationships,
    # and rendering a grouped shape as a reply to a note is a wrong document,
    # not a missing feature. A relationship the format does not define nests
    # nowhere either — nesting it would assert the one relationship the
    # document declined to name.
    roots = [c for c in kept if c["reply_to"] is None or c["reply_type"] != REPLY]
    roots.sort(key=lambda c: _sort_key(sort, c))

    ordered: list[dict] = []
    seen: set = set()
    for root in roots:
        for member in _thread_order(root, by_id):
            if id(member) in seen:
                continue
            seen.add(id(member))
            ordered.append(member)
    # A reply hanging off a group member is reachable only through it, and a
    # reply whose whole chain was promoted may not be reachable at all. Nothing
    # kept may be lost between the filter and the page.
    for comment in kept:
        if id(comment) not in seen:
            seen.add(id(comment))
            ordered.append(comment)

    return {
        "comments": ordered,
        "count": len(ordered),
        "found": found,
        "authors": authors,
        "subtypes": subtypes,
        "states": states,
        "excluded": {"filtered": filtered, "unmodelled": unmodelled},
        "unreadable": unreadable,
        "sort": sort,
    }


def list_comments(file: str, sort: str = "page", filter: dict | None = None) -> dict:
    """Every comment with its whole review model, ordered and narrowed.

    A pure read: it never touches the file's bytes, which is why the renderer
    may re-request it on a control change without flushing pending page edits.
    """
    with pikepdf.open(file) as pdf:
        model = build_model(pdf, sort, filter)
    by_type: dict[str, int] = {}
    for comment in model["comments"]:
        comment.pop("order", None)
        comment.pop("reply_key", None)
        by_type[comment["subtype"]] = by_type.get(comment["subtype"], 0) + 1
    model["by_type"] = by_type
    return model


# ---------------------------------------------------------------------------
# Sheet geometry
# ---------------------------------------------------------------------------

def _paper(paper: str, size: list | None) -> tuple[float, float]:
    if size is not None:
        try:
            width, height = (float(v) for v in size)
        except (TypeError, ValueError):
            raise ValueError("a summary sheet size is a width and a height in points") from None
        if width <= 0 or height <= 0:
            raise ValueError("a summary sheet size is a width and a height in points")
        return width, height
    name = str(paper or "letter").lower()
    if name not in PAGE_SIZES:
        raise ValueError(f"not a paper size this summary can use: {paper}")
    return PAGE_SIZES[name]


def _cells(placement: str, paper_w: float, paper_h: float, gutter: float):
    """(sheet size, image cell, column rect) for one placement.

    The sheet's orientation follows the COLUMN's edge: `beside` turns the
    sheet landscape, `beneath` keeps it portrait, so the column always takes a
    short edge and the page image lands at one size whichever way its source
    page was turned. Holding the sheet portrait and choosing the edge by scale
    instead makes `beside` unreachable for every ordinary document.
    """
    if placement == "beside":
        sheet_w, sheet_h = paper_h, paper_w
        cell = (0.0, 0.0, sheet_w - gutter, sheet_h)
        column = (sheet_w - gutter + _PAD, _PAD, sheet_w - _PAD, sheet_h - _PAD)
        return (sheet_w, sheet_h), cell, column
    if placement == "beneath":
        sheet_w, sheet_h = paper_w, paper_h
        cell = (0.0, gutter, sheet_w, sheet_h - gutter)
        column = (_PAD, _PAD, sheet_w - _PAD, gutter - _PAD)
        return (sheet_w, sheet_h), cell, column
    sheet_w, sheet_h = paper_w, paper_h
    cell = (0.0, 0.0, sheet_w, sheet_h)
    column = (_PAD, _PAD, sheet_w - _PAD, sheet_h - _PAD)
    return (sheet_w, sheet_h), cell, column


def _scale_of(matrix) -> float:
    return max(abs(matrix[0]), abs(matrix[1]))


def _auto_placement(disp_w: float, disp_h: float, paper_w: float, paper_h: float,
                    gutter: float) -> str:
    """Which edge the column takes, decided by the placed image's own scale.
    Ties go to `beside`, so the answer is total."""
    _, beside_cell, _ = _cells("beside", paper_w, paper_h, gutter)
    _, beneath_cell, _ = _cells("beneath", paper_w, paper_h, gutter)
    beside, _ = place_in_cell(disp_w, disp_h, 0, beside_cell, False)
    beneath, _ = place_in_cell(disp_w, disp_h, 0, beneath_cell, False)
    return "beneath" if _scale_of(beneath) > _scale_of(beside) else "beside"


def _anchor(rect: list, placement: str) -> tuple[float, float]:
    """The /Rect edge midpoint facing the column, in the source page's own USER
    space — right-middle beside the column, bottom-middle beneath it.

    The rect is the raw one, normalized min/max. Display normalization and its
    rotation projection are a canvas concern for a workspace annotation the
    user is turning; this reads committed bytes and composes through the page's
    own matrix, so the two coordinate systems never meet.
    """
    x0, y0, x1, y1 = rect
    if placement == "beside":
        return (x1, (y0 + y1) / 2.0)
    return ((x0 + x1) / 2.0, y0)


def _apply(matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = matrix
    return (a * x + c * y + e, b * x + d * y + f)


def _fmt(value: float) -> str:
    text = f"{value:.4f}".rstrip("0").rstrip(".")
    return text if text else "0"


# ---------------------------------------------------------------------------
# Entry text
# ---------------------------------------------------------------------------

def _entry_lines(comment: dict, badge, labels: dict, types: dict, digits: _Digits,
                 rendered: dict, leader: dict | None) -> list[str]:
    """One comment as its own block of lines. Each line is a whole furniture
    template with its values interpolated; nothing is glued together from
    fragments.

    The AUTHOR takes a line of its own, away from the date and the page
    reference. A right-to-left name on the same line as a date is not a
    cosmetic problem: the bidi algorithm re-types the digits that FOLLOW an
    Arabic-letter run as Arabic numbers and lays them out right to left, so
    2026-08-14 correctly — and unreadably — comes out as 14-08-2026. Keeping
    each line to one direction is what stops that, and a narrow column wants
    the break anyway.
    """
    author = comment["author"] or labels["unknownAuthor"]
    date = _render_date(comment["modified"] or comment["created"], labels, rendered)
    lines: list[str] = []
    if badge is None:
        lines.append(_fill(labels["replyHeader"], {"author": author}))
        lines.append(_fill(labels["replyMeta"], {"date": date}))
    else:
        lines.append(_fill(labels["entryHeader"], {
            "badge": digits(badge), "author": author,
        }))
        lines.append(_fill(labels["entryMeta"], {
            "date": date,
            "page": digits(comment["page"]),
            "type": types.get(comment["subtype"].lower(), comment["subtype"]),
        }))
    if comment["subject"]:
        lines.append(_fill(labels["subject"], {"subject": comment["subject"]}))
    if comment["state"]:
        if comment["state_model"]:
            lines.append(_fill(labels["state"], {
                "state": comment["state"], "model": comment["state_model"],
            }))
        else:
            lines.append(_fill(labels["stateNoModel"], {"state": comment["state"]}))
    if comment["reply_type"] == GROUP and leader is not None:
        lines.append(_fill(labels["groupMember"], {
            "author": leader["author"] or labels["unknownAuthor"],
        }))
    if comment["reply_type"] == UNKNOWN:
        lines.append(labels["relationshipUnknown"])
    if comment["orphan"]:
        lines.append(labels["replyOrphan"])
    if comment["cycle"]:
        lines.append(labels["replyCycle"])
    if comment["rect"] is None:
        lines.append(labels["noPosition"])
    body = comment["contents"].replace("\r\n", "\n").replace("\r", "\n").strip()
    lines.append(body if body else labels["noBody"])
    return lines


# ---------------------------------------------------------------------------
# The builder
# ---------------------------------------------------------------------------

class _Sheet:
    """One output page under construction.

    `matrix` is the page image's placement matrix on THIS sheet, or None when
    the sheet carries no image — a badge is drawn against the sheet its entry
    landed on, so a thread that split across sheets cannot draw its badge on a
    sheet the reader is no longer looking at.
    """

    __slots__ = ("page", "ops", "column", "cursor", "empty", "matrix", "number")

    def __init__(self, page, column, number: int):
        self.page = page
        self.ops: list[str] = []
        self.column = column
        self.cursor = column[3]
        self.empty = True
        self.matrix = None
        self.number = number


class _Builder:
    """Sheets, text placement, and the drawing that surrounds it."""

    def __init__(self, out, font_path: str, labels: dict, digits: _Digits, align: str):
        self.out = out
        self.font_path = font_path
        self.labels = labels
        self.digits = digits
        self.align = align
        self.sheets: list[_Sheet] = []
        self.marks: list[dict] = []
        self.refused = 0

    def new_sheet(self, sheet_w: float, sheet_h: float, column) -> _Sheet:
        page = self.out.add_blank_page(page_size=(sheet_w, sheet_h))
        page.obj["/Resources"] = Dictionary(XObject=Dictionary())
        sheet = _Sheet(page, column, len(self.sheets) + 1)
        self.sheets.append(sheet)
        return sheet

    def layout(self, text: str, left: float, right: float, size: float):
        return layout_text_box(
            self.out, [left, 0.0, right, 1000.0], text, size,
            self.font_path, "sans", 0, False, False,
        )

    def place(self, sheet: _Sheet, lay, size: float) -> float:
        """Emit a prepared block at the sheet's cursor; returns its first
        baseline. The block was measured at this width, so a pure vertical
        placement reproduces the measured wrap exactly — which is why the
        layout is never re-run at the final position."""
        baseline = sheet.cursor - size
        emit_text_box(self.out, sheet.page, lay, None, self.align, baseline)
        sheet.cursor = baseline - (len(lay.lines) - 1) * lay.leading - _UNIT_GAP
        sheet.empty = False
        return baseline

    def finish(self) -> None:
        """Prepend each sheet's own drawing to whatever the text emitter
        appended, so the artwork sits under the entries."""
        for sheet in self.sheets:
            if sheet.ops:
                sheet.page.contents_add(
                    (" ".join(sheet.ops) + "\n").encode("latin-1"), prepend=True
                )


def _connector_ops(x0: float, y0: float, x1: float, y1: float) -> str:
    g = _fmt(_CONNECTOR_GRAY)
    return (
        f"q {g} {g} {g} RG 0.6 w {_fmt(x0)} {_fmt(y0)} m "
        f"{_fmt(x1)} {_fmt(y1)} l S Q"
    )


def _badge_ops(x: float, y: float) -> str:
    """A filled disc at the anchor, drawn as the four Béziers a circle takes."""
    k = _BADGE_RADIUS * 0.5523
    r = _BADGE_RADIUS
    return (
        f"q 1 1 1 rg 0.1 0.1 0.1 RG 0.8 w {_fmt(x + r)} {_fmt(y)} m "
        f"{_fmt(x + r)} {_fmt(y + k)} {_fmt(x + k)} {_fmt(y + r)} {_fmt(x)} {_fmt(y + r)} c "
        f"{_fmt(x - k)} {_fmt(y + r)} {_fmt(x - r)} {_fmt(y + k)} {_fmt(x - r)} {_fmt(y)} c "
        f"{_fmt(x - r)} {_fmt(y - k)} {_fmt(x - k)} {_fmt(y - r)} {_fmt(x)} {_fmt(y - r)} c "
        f"{_fmt(x + k)} {_fmt(y - r)} {_fmt(x + r)} {_fmt(y - k)} {_fmt(x + r)} {_fmt(y)} c B Q"
    )


class _Column:
    """A run of entry blocks poured into successive sheets.

    A block that will not fit the remaining space moves to a fresh sheet; a
    block that will not fit a WHOLE sheet splits at a line boundary, and the
    remainder carries a continuation heading. Splitting on the wrapped lines
    and re-laying them out as hard breaks reproduces the original wrap
    exactly, so a split can never re-flow the text it splits.
    """

    def __init__(self, builder: _Builder, make_sheet, size: float):
        self.builder = builder
        self.make_sheet = make_sheet
        self.size = size
        self.sheet: _Sheet | None = None

    def add(self, text: str, indent: float, heading: str | None) -> tuple:
        """Place `text`, splitting across sheets as needed. Returns the sheet
        and first baseline of its FIRST piece — what a connector attaches to."""
        remaining = text
        continued = False
        first: tuple | None = None
        while remaining is not None:
            if self.sheet is None:
                self.sheet = self.make_sheet(continued)
            left = self.sheet.column[0] + indent
            right = self.sheet.column[2]
            if right - left < 36.0:
                left = self.sheet.column[0]
            lay = self.builder.layout(remaining, left, right, self.size)
            available = self.sheet.cursor - self.sheet.column[1]
            if block_height(lay) <= available:
                baseline = self.builder.place(self.sheet, lay, self.size)
                if first is None:
                    first = (self.sheet, baseline)
                break
            if not self.sheet.empty:
                self.sheet = None
                continued = True
                continue
            fit = int(available // lay.leading)
            if fit >= len(lay.lines):
                fit = len(lay.lines) - 1
            head = list(lay.lines[:fit])
            if not any(line.strip() for line in head):
                # Not even one drawable line fits a whole sheet: draw it and
                # let it overflow rather than loop forever on a sheet that can
                # never hold it.
                baseline = self.builder.place(self.sheet, lay, self.size)
                if first is None:
                    first = (self.sheet, baseline)
                break
            piece = self.builder.layout("\n".join(head), left, right, self.size)
            baseline = self.builder.place(self.sheet, piece, self.size)
            if first is None:
                first = (self.sheet, baseline)
            tail = list(lay.lines[fit:])
            remaining = "\n".join(tail) if any(t.strip() for t in tail) else None
            if remaining is not None and heading is not None:
                remaining = heading + "\n" + remaining
            self.sheet = None
            continued = True
        return first


def _entry_text(comment, badge, labels, types, digits, rendered, leader) -> str:
    return "\n".join(
        _entry_lines(comment, badge, labels, types, digits, rendered, leader)
    )


# ---------------------------------------------------------------------------
# The document
# ---------------------------------------------------------------------------

class _PageImage:
    """One source page lifted once and placed many times."""

    __slots__ = ("form", "disp_w", "disp_h", "source_matrix")

    def __init__(self, form, disp_w, disp_h, source_matrix):
        self.form = form
        self.disp_w = disp_w
        self.disp_h = disp_h
        self.source_matrix = source_matrix


def _page_image(out, source, index: int, cache: dict) -> _PageImage:
    """The source page as a placeable form, cached so a continuation sheet
    costs one `Do` rather than a second lift."""
    if index not in cache:
        page = source.pages[index]
        x0, y0, x1, y1 = _resolve_box(page)
        matrix, _ = _source_matrix(x0, y0, x1 - x0, y1 - y0, _resolve_rotate(page))
        form, disp_w, disp_h = _lift_page(source, index, "", index + 1)
        cache[index] = _PageImage(out.copy_foreign(form), disp_w, disp_h, matrix)
    return cache[index]


def _draw_image(sheet: _Sheet, image: _PageImage, cell) -> None:
    """Place the lifted page into `cell`.

    The form's own /Matrix has already folded the crop origin and turned the
    page, so the placement matrix composes with it directly. An imposition
    subtracts the crop origin here because its form comes from
    `Page.as_form_xobject` — identity /Matrix, /BBox at the crop origin — and
    doing the same to this form would fold that origin twice.
    """
    name = "/Pg0"
    sheet.page.obj["/Resources"]["/XObject"][Name(name)] = image.form
    matrix, _ = place_in_cell(image.disp_w, image.disp_h, 0, cell, False)
    a, b, c, d, e, f = matrix
    sheet.ops.append(
        f"q {_fmt(a)} {_fmt(b)} {_fmt(c)} {_fmt(d)} {_fmt(e)} {_fmt(f)} cm {name} Do Q"
    )
    sheet.matrix = matrix


def summarize_comments(
    file: str,
    output: str,
    mode: str = "document_and_comments",
    placement: str = "auto",
    connectors: bool = True,
    gutter: float = DEFAULT_GUTTER,
    paper: str = "letter",
    size: list | None = None,
    sort: str = "page",
    filter: dict | None = None,
    labels: dict | None = None,
    dates: dict | None = None,
    digits: str | None = None,
    lang: str = "en",
    direction: str = "ltr",
    font_path: str = "",
    document_name: str = "",
) -> dict:
    """Write a comment summary PDF and report what it accounts for.

    `mode` is `comments_only` (entry sheets grouped by source page) or
    `document_and_comments` (each source page's image with its entries).
    `placement` and `connectors` are orthogonal: four documents fall out of two
    fields, which is what keeps "connectors off" from being a fifth layout.
    `separate` gives the image a whole sheet and the entries their own, and
    carries badges without connectors by construction.
    """
    if mode not in MODES:
        raise ValueError(f"not a comment summary mode: {mode}")
    if placement not in PLACEMENTS:
        raise ValueError(f"not a comment column placement: {placement}")
    paper_w, paper_h = _paper(paper, size)
    try:
        gutter = float(gutter)
    except (TypeError, ValueError):
        raise ValueError("the comment column width is a number of points") from None
    if not (72.0 <= gutter <= min(paper_w, paper_h) - 144.0):
        raise ValueError(f"the comment column does not fit the sheet: {gutter}")

    labels_text = _resolve_labels(labels)
    types = _type_names(labels)
    digit = _Digits(digits)
    rendered = {str(k): str(v) for k, v in (dates or {}).items()}
    align = "right" if direction == "rtl" else "left"
    name = document_name or Path(file).name

    with pikepdf.open(file) as source:
        model = build_model(source, sort, filter)
        comments = model["comments"]
        if not comments:
            raise ValueError("this document has no comments to summarize")

        out = pikepdf.new()
        builder = _Builder(out, font_path, labels_text, digit, align)
        by_id = {c["id"]: c for c in comments}

        # Badge numbers follow the ordered sequence, so the number a reader
        # sees on a page image is the number its entry carries. A reply has no
        # badge of its own: it is part of its parent's entry.
        badges: dict[str, int] = {}
        for comment in comments:
            if comment["reply_to"] is None or comment["reply_type"] != REPLY:
                badges[comment["id"]] = len(badges) + 1

        no_position = sum(1 for c in comments if c["rect"] is None)
        no_box: list[int] = []
        cache: dict = {}

        # Sheets are grouped by the SOURCE PAGE a thread's top-level entry sits
        # on, in page order; the caller's sort orders the entries within a
        # group. A reply that lives on another page rides its thread and says
        # so in its own header.
        groups: dict[int, list[dict]] = {}
        current: list[dict] | None = None
        for comment in comments:
            if comment["id"] in badges or current is None:
                current = groups.setdefault(comment["page"], [])
            current.append(comment)

        for page_number in sorted(groups):
            _write_group(
                builder, source, out, page_number, groups[page_number], by_id, badges,
                mode, placement, connectors, gutter, paper_w, paper_h, labels_text,
                types, digit, rendered, cache, no_box,
            )

        _write_reconciliation(
            builder, model, comments, no_position, no_box, paper_w, paper_h,
            labels_text, digit, name, sort,
        )
        builder.finish()

        out.Root["/Lang"] = pikepdf.String(lang or "en")
        if direction == "rtl":
            out.Root["/ViewerPreferences"] = Dictionary(Direction=Name("/R2L"))
        save_pdf(out, output)
        sheet_count = len(out.pages)

    written = len(comments)
    excluded = {
        "filtered": model["excluded"]["filtered"],
        "unmodelled": model["excluded"]["unmodelled"],
        "no_position": no_position,
        "body_refused": builder.refused,
    }
    return {
        "output": str(output),
        "sheets": sheet_count,
        "found": model["found"],
        "written": written,
        "excluded": excluded,
        "unreadable": model["unreadable"],
        "no_box_pages": no_box,
        "reconciles": model["found"]
        == written + excluded["filtered"] + excluded["unmodelled"],
        "marks": builder.marks,
        "placement": placement,
        "mode": mode,
    }


def _write_group(builder, source, out, page_number, members, by_id, badges, mode,
                 placement, connectors, gutter, paper_w, paper_h, labels, types,
                 digit, rendered, cache, no_box) -> None:
    """Every entry whose thread sits on one source page, with that page's image
    repeated on each continuation sheet.

    Continuing on an image-less sheet would break the mode's own promise for
    every entry past the first sheetful, silently and only on heavily reviewed
    pages; repeating costs one `Do` against a cached form.
    """
    image = None
    resolved = placement
    if mode == "document_and_comments":
        try:
            image = _page_image(out, source, page_number - 1, cache)
        except (ValueError, IndexError):
            no_box.append(page_number)
    if image is None:
        # No image to place: the entries take whole sheets of their own, and a
        # sheet with no artwork can carry no connector.
        resolved = "separate"
        connectors = False
    elif placement == "auto":
        resolved = _auto_placement(image.disp_w, image.disp_h, paper_w, paper_h, gutter)
    if resolved == "separate":
        connectors = False

    (sheet_w, sheet_h), cell, column = _cells(resolved, paper_w, paper_h, gutter)
    badge_sheet: _Sheet | None = None

    if image is not None and resolved == "separate":
        # The artwork gets a whole sheet of its own; the entries follow on
        # theirs, linked by badge number alone.
        badge_sheet = builder.new_sheet(sheet_w, sheet_h, column)
        _draw_image(badge_sheet, image, cell)

    def make_sheet(continued: bool) -> _Sheet:
        sheet = builder.new_sheet(sheet_w, sheet_h, column)
        if image is not None and resolved != "separate":
            _draw_image(sheet, image, cell)
        key = "pageContinued" if continued else "pageHeading"
        heading = builder.layout(
            _fill(labels[key], {"page": digit(page_number)}),
            column[0], column[2], _HEADING_SIZE,
        )
        builder.place(sheet, heading, _HEADING_SIZE)
        return sheet

    column_run = _Column(builder, make_sheet, _ENTRY_SIZE)
    for comment in members:
        badge = badges.get(comment["id"])
        leader = by_id.get(comment["reply_to"]) if comment["reply_type"] == GROUP else None
        author = comment["author"] or labels["unknownAuthor"]
        continuation = _fill(labels["continued"], {"author": author})
        indent = 0.0 if badge is not None else _REPLY_INDENT
        try:
            text = _entry_text(comment, badge, labels, types, digit, rendered, leader)
            placed = column_run.add(text, indent, continuation)
        except Exception:
            # An unprovable right-to-left paragraph refuses rather than emit a
            # scrambled line. The entry is still written, by page and author,
            # with its body withheld — and the run continues.
            builder.refused += 1
            withheld = dict(comment)
            withheld["contents"] = labels["bodyRefused"]
            text = _entry_text(withheld, badge, labels, types, digit, rendered, leader)
            placed = column_run.add(text, indent, continuation)
        if placed is None or badge is None or comment["rect"] is None:
            continue
        entry_sheet, baseline = placed
        target = badge_sheet if badge_sheet is not None else entry_sheet
        _mark(builder, target, resolved, comment, badge, image, digit, page_number)
        if connectors and target is entry_sheet and target.matrix is not None:
            x, y = _sheet_point(target, image, comment, resolved)
            target.ops.append(
                _connector_ops(x, y, entry_sheet.column[0] - 4.0,
                               baseline + _ENTRY_SIZE * 0.3)
            )


def _sheet_point(sheet: _Sheet, image: _PageImage, comment: dict, resolved: str):
    """`place_in_cell(...) · /Matrix · anchor` — where the comment's own
    position lands on this sheet."""
    ax, ay = _anchor(comment["rect"], resolved)
    dx, dy = _apply(image.source_matrix, ax, ay)
    return _apply(sheet.matrix, dx, dy)


def _mark(builder, sheet: _Sheet, resolved, comment, badge, image, digit,
          page_number) -> None:
    """Draw the numbered badge at the comment's own position on the image."""
    if sheet.matrix is None or image is None:
        return
    x, y = _sheet_point(sheet, image, comment, resolved)
    sheet.ops.append(_badge_ops(x, y))
    lay = builder.layout(digit(badge), x - _BADGE_RADIUS, x + _BADGE_RADIUS, _BADGE_SIZE)
    emit_text_box(builder.out, sheet.page, lay, None, "center", y - _BADGE_SIZE * 0.35)
    builder.marks.append({
        "badge": badge,
        "page": page_number,
        "comment": comment["id"],
        "sheet": sheet.number,
        "x": round(x, 4),
        "y": round(y, 4),
    })


def _write_reconciliation(builder, model, comments, no_position, no_box, paper_w,
                          paper_h, labels, digit, name, sort) -> None:
    """The block every summary ends with. "0 comments" and "40 comments you
    filtered away" are different documents, so every count prints even when it
    is zero-valued and benign."""
    column = (_PAD, _PAD, paper_w - _PAD, paper_h - _PAD)
    sheet = builder.new_sheet(paper_w, paper_h, column)
    excluded = model["excluded"]
    lines = [
        labels["reconcileHeading"],
        _fill(labels["document"], {"name": name}),
        _fill(labels["sortedBy"], {"sort": labels[_SORT_LABEL[sort]]}),
        _fill(labels["reconcileFound"], {"count": digit(model["found"])}),
        _fill(labels["reconcileWritten"], {"count": digit(len(comments))}),
        _fill(labels["reconcileFiltered"], {"count": digit(excluded["filtered"])}),
        _fill(labels["reconcileUnmodelled"], {"count": digit(excluded["unmodelled"])}),
        _fill(labels["reconcileNoPosition"], {"count": digit(no_position)}),
        _fill(labels["reconcileBodyRefused"], {"count": digit(builder.refused)}),
    ]
    unreadable = [str(digit(u["page"])) for u in model["unreadable"]]
    if unreadable:
        lines.append(_fill(labels["reconcileUnreadable"], {"pages": ", ".join(unreadable)}))
    if no_box:
        lines.append(_fill(labels["reconcileNoBox"], {
            "pages": ", ".join(str(digit(p)) for p in no_box),
        }))
    if model["found"] == len(comments) + excluded["filtered"] + excluded["unmodelled"]:
        lines.append(labels["reconcileBalanced"])
    title = builder.layout(labels["title"], column[0], column[2], _TITLE_SIZE)
    builder.place(sheet, title, _TITLE_SIZE)
    body = builder.layout("\n".join(lines), column[0], column[2], _ENTRY_SIZE)
    builder.place(sheet, body, _ENTRY_SIZE)
