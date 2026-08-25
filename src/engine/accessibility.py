"""Accessibility checker — 56 checks across seven categories.

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

**A check states which standard it speaks for.** `CHECK_SOURCES` carries the
clause behind every check, and the kind of claim that clause supports: a
`shall` fails, a `should` warns, and a check neither ISO 14289-1 nor
ISO 32000-2 states at all is a practice this checker keeps under its own name
rather than a conformance verdict wearing someone else's authority.

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

import xml.etree.ElementTree as ElementTree

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
    ("role_map", "document"),
    ("suspects", "document"),
    ("structure_nesting", "document"),
    ("reading_order", "document"),
    ("lang", "document"),
    ("title", "document"),
    ("bookmarks", "document"),
    ("contrast", "document"),
    ("optional_content_config", "document"),
    ("embedded_file_names", "document"),
    ("tagged_content", "page_content"),
    ("untagged_graphics", "page_content"),
    ("artifact_judgement", "page_content"),
    ("content_grouping", "page_content"),
    ("content_order", "page_content"),
    ("tagged_annotations", "page_content"),
    ("tab_order", "page_content"),
    ("character_encoding", "page_content"),
    ("unicode_mapping", "page_content"),
    ("tagged_multimedia", "page_content"),
    ("screen_flicker", "page_content"),
    ("scripts", "page_content"),
    ("timed_responses", "page_content"),
    ("navigation_links", "page_content"),
    ("trapnet_annotations", "page_content"),
    ("link_ismap", "page_content"),
    ("media_clip_data", "page_content"),
    ("reference_xobjects", "page_content"),
    ("font_embedding", "page_content"),
    ("font_encodings", "page_content"),
    ("cid_to_gid_map", "page_content"),
    ("tagged_form_fields", "forms"),
    ("field_descriptions", "forms"),
    ("print_field_attributes", "forms"),
    ("dynamic_xfa", "forms"),
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
    ("list_numbering", "lists"),
    ("list_item_structure", "lists"),
    ("list_semantics", "lists"),
    ("heading_nesting", "headings"),
    ("heading_tag_mixing", "headings"),
    ("heading_semantics", "headings"),
)

# id → (source, citation). The SOURCE states what kind of claim the check
# makes, so a report never presents a recommendation as a conformance failure:
#
#   ua      — a `shall` in ISO 14289-1, verdict FAIL when violated.
#   ua_soft — a `should` in ISO 14289-1, verdict WARN when short.
#   wcag    — a WCAG success criterion 14289-1 cites in a NOTE rather than
#             requiring; reported on its own terms, never as PDF/UA.
#   iso     — a structural rule of ISO 32000-2 that 14289-1 tags by reference.
#   practice— neither standard states it; a checklist item kept because it
#             names a real defect, reported at WARN or needs_review only.
#
# Citations are clause numbers of ISO 14289-1:2014 unless prefixed `32000-2`.
CHECK_SOURCES = {
    "permissions": ("ua", "7.16"),
    "image_only": ("ua", "7.1"),
    "tagged": ("ua", "7.1"),
    "role_map": ("ua", "7.1; 32000-2 14.7.4"),
    "suspects": ("ua", "7.1; 32000-2 Table 321"),
    "structure_nesting": ("iso", "32000-2 Table 365"),
    "reading_order": ("ua", "7.1, 7.2"),
    "lang": ("ua", "7.2"),
    "title": ("ua", "7.1"),
    "bookmarks": ("ua_soft", "7.17"),
    "contrast": ("wcag", "7.1 NOTE 4; WCAG 2 1.4.3"),
    "optional_content_config": ("ua", "7.10"),
    "embedded_file_names": ("ua", "7.11, 7.18.7"),
    "tagged_content": ("ua", "7.1"),
    "untagged_graphics": ("ua", "7.1"),
    "artifact_judgement": ("practice", "7.1"),
    "content_grouping": ("practice", "7.1; 32000-2 14.8.4.7.1"),
    "content_order": ("practice", "7.1; 32000-2 14.8.4.2"),
    "tagged_annotations": ("ua", "7.18.1"),
    "tab_order": ("ua", "7.18.3"),
    "character_encoding": ("ua", "7.2"),
    "unicode_mapping": ("ua", "7.2; 32000-2 9.10.2"),
    "tagged_multimedia": ("ua", "7.18.1, 7.18.6"),
    "screen_flicker": ("ua", "7.1"),
    "scripts": ("ua_soft", "7.19"),
    "timed_responses": ("wcag", "WCAG 2 2.2.1"),
    "navigation_links": ("wcag", "WCAG 2 2.4.4"),
    "trapnet_annotations": ("ua", "7.18.2"),
    "link_ismap": ("ua", "7.18.5"),
    "media_clip_data": ("ua", "7.18.6.2"),
    "reference_xobjects": ("ua", "7.20"),
    "font_embedding": ("ua", "7.21.4.1"),
    "font_encodings": ("ua", "7.21.6"),
    "cid_to_gid_map": ("ua", "7.21.3.2"),
    "tagged_form_fields": ("ua", "7.18.4"),
    "field_descriptions": ("ua", "7.18.1"),
    "print_field_attributes": ("ua", "7.14"),
    "dynamic_xfa": ("ua", "7.15"),
    "figures_alt": ("ua", "7.3, 7.7"),
    "nested_alt": ("practice", "32000-2 14.9.3"),
    "alt_no_content": ("practice", "32000-2 14.9.3"),
    "alt_hides_annotation": ("practice", "32000-2 14.9.3"),
    "other_elements_alt": ("ua", "7.18.1, 7.18.5"),
    "table_rows": ("ua", "7.5"),
    "table_cells": ("ua", "7.5"),
    "table_headers": ("ua_soft", "7.5"),
    "table_regularity": ("iso", "32000-2 Table 337"),
    "table_summary": ("practice", "32000-2 Table 355"),
    "list_items": ("ua", "7.6"),
    "list_labels": ("iso", "32000-2 Table 368"),
    "list_numbering": ("ua", "7.6; 32000-2 Table 353"),
    "list_item_structure": ("iso", "32000-2 Table 370"),
    "list_semantics": ("practice", "7.6"),
    "heading_nesting": ("ua", "7.4.2"),
    "heading_tag_mixing": ("ua", "7.4"),
    "heading_semantics": ("practice", "7.4"),
}

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
    "field_descriptions", "trapnet_annotations", "link_ismap",
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
    "role_map", "untagged_graphics", "artifact_judgement", "content_grouping",
    "content_order", "list_numbering", "list_item_structure", "list_semantics",
    "heading_tag_mixing", "heading_semantics", "print_field_attributes",
)

# The three whose FINDINGS are themselves claims about what the tree does not
# contain — an annotation reached by no `/OBJR` the walk saw. An incomplete
# walk cannot support those either way, so their `fail` degrades too.
_TREE_ABSENCE_CHECKS = ("tagged_annotations", "tagged_multimedia", "tagged_form_fields")

# ISO 14289-1 7.18.4: the structure element a widget annotation must be nested
# within, after /RoleMap resolution.
_FORM_ROLE = "Form"

# The checks that read the pages, and cannot answer for one that will not parse.
_PAGE_CHECKS = (
    "image_only", "contrast", "tagged_content", "character_encoding",
    "navigation_links", "reading_order",
    "untagged_graphics", "unicode_mapping", "artifact_judgement",
    "content_grouping", "content_order", "list_numbering", "list_semantics",
    "heading_semantics",
)

# ── ISO 32000-2 Table 353: the list-numbering rosters ─────────────────────
#
# The three unordered classes name a bullet SHAPE; the ordered ones name a
# counting system. `None` states the list is not numbered at all, which is a
# declaration and not a gap. Judging a declared value against the labels the
# document actually draws is decidable only across that split — which counting
# system a label uses is not, because `I.` is a roman numeral and a letter and
# the tree cannot say which the author meant.
_BULLET_NUMBERING = frozenset({"Disc", "Circle", "Square", "Unordered"})
_ORDERED_NUMBERING = frozenset(
    {"Decimal", "Ordered", "UpperRoman", "LowerRoman", "UpperAlpha", "LowerAlpha"}
)
_NO_NUMBERING = "None"

# The bullet characters each unordered class names, as a reader meets them.
# Only these three shapes are decidable: a tick, a dash or a dingbat states no
# class, so a list labelled with one is not judged rather than guessed at.
_BULLET_GLYPHS = {
    "•": "Disc", "●": "Disc", "∙": "Disc",
    "◦": "Circle", "○": "Circle", "⚬": "Circle",
    "▪": "Square", "■": "Square", "□": "Square", "◼": "Square",
}

# What a label's own text can be stripped of before it is classified: the
# punctuation every enumerated list wraps its counter in.
_LABEL_TRIM = " \t().[]:-–—"

_ROMAN_LETTERS = frozenset("IVXLCDMivxlcdm")

# ISO 32000-2 Table 370: `LI` holds a label and a body, and nothing else. The
# roles a conforming list item may hold DIRECTLY, before the transparent
# grouping types of Table 365 are seen through.
_LIST_ITEM_ROLES = frozenset({"Lbl", "LBody"})

# A heading is "visually a heading" when its text is drawn this much larger
# than the document's dominant body size. Evidence for a review, never a
# verdict: the ratio names a candidate, and a person decides.
_HEADING_SIZE_RATIO = 1.15

# How far apart two of one element's own content blocks must sit, as a multiple
# of the line pitch that element itself sets, before it is offered for review
# as two things tagged as one. Measured against the element's OWN leading
# rather than a constant: a paragraph break is a gap wider than the lines
# around it, and what "wider" means is set by the document, not by this file.
_BLOCK_GAP_PITCH = 1.35

# Words at the document's body size that make a declared artifact read as
# prose. A running header or a page number is shorter than this.
_ARTIFACT_PROSE_WORDS = 6

# How close, as a multiple of the line height, two same-role siblings must sit
# before they read as adjacent lines of ONE block rather than as two things a
# line's leading apart. Ordinary paragraph leading is wider than this.
_ONE_BLOCK_GAP = 0.4

# How far apart, as a multiple of the drawn size, two clusters of one marked
# content sequence's runs must sit before the sequence is offered for review as
# one tag spanning two columns.
_COLUMN_GAP_SIZES = 4.0

# How much of a page a figure's own rectangles must cover, and nothing else,
# before it is offered for review as a background rather than a picture.
_FIGURE_BACKGROUND_SHARE = 0.10

# The roles a figure sits INSIDE when it is standing in for a word rather than
# illustrating a block: ISO 32000-2 Tables 366 and 368's block and inline text
# types.
_INLINE_TEXT_ROLES = frozenset({"P", "H", "Span", "Lbl", "Em", "Strong", "Sub",
                                "H1", "H2", "H3", "H4", "H5", "H6", "Title"})

# The roles that hold a block of prose, which is what "are these two things one
# thing" is a question about. A cell or a list item's position in its container
# is fixed by the container, so neither is evidence of anything.
_PROSE_ROLES = frozenset({"P", "H", "Title", "H1", "H2", "H3", "H4", "H5", "H6"})

# How much of their height two runs must share before "the later one starts to
# the left" is a backwards jump rather than the next line.
_SAME_LINE_OVERLAP = 0.5

# Painting operators. A page that executes one of these outside every marked
# content sequence has content that is neither tagged nor declared an artifact.
# `Do` is included because an XObject invocation paints whatever it holds;
# `BI`/`EI` because an inline image is painted by the same stream.
_PAINT_OPS = frozenset({"S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "sh", "Do", "EI"})



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


def _cropboxes(pdf) -> dict:
    """page number → the effective `/CropBox`, for the one exemption ISO
    14289-1 cl. 7.18.1 states in terms of geometry."""
    out: dict = {}
    for i, page in enumerate(pdf.pages):
        try:
            box = page.obj.get("/CropBox") or page.obj.get("/MediaBox")
            values = [float(v) for v in box]
        except Exception:
            continue
        if len(values) != 4:
            continue
        out[i + 1] = (
            min(values[0], values[2]), min(values[1], values[3]),
            max(values[0], values[2]), max(values[1], values[3]),
        )
    return out


def _annotation_in_scope(annot: dict, cropboxes: dict) -> bool:
    """Does ISO 14289-1 cl. 7.18.1 reach this annotation?

    The clause states its own three exemptions and no others: the hidden flag,
    a rectangle outside the CropBox, and subtype Popup (handled by the roster
    the callers filter on). NoView and a zero-area rectangle are NOT among
    them, so neither exempts here — they exempt only where the question is
    whether an object is owed a description a reader would announce.
    """
    if annot["flags"] & _F_HIDDEN:
        return False
    box = cropboxes.get(annot["page"])
    rect = annot["rect"]
    if box is None or rect is None or len(rect) != 4:
        return True
    x0, y0 = min(rect[0], rect[2]), min(rect[1], rect[3])
    x1, y1 = max(rect[0], rect[2]), max(rect[1], rect[3])
    return not (x1 < box[0] or x0 > box[2] or y1 < box[1] or y0 > box[3])


def _draws_text(run: dict) -> bool:
    """Does this run put glyphs on the page?

    Not "did we decode characters from it": a run whose encoding THIS READER
    declines still draws, and skipping it reports "no content here" over
    content that is there. The blank-run case is the one genuine absence.
    """
    if str(run.get("text") or "").strip():
        return True
    return bool(run.get("reader_limit"))


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
    # Runs this reader could not decode. A document made entirely of them has
    # text on every page; what it does not have is a reader here that can read
    # it, and ISO 14289-1 cl. 7.1's raster-image case is not what it is.
    limited = []
    for i in range(len(pdf.pages)):
        page_no = i + 1
        # Both stages, not one: a page whose paint walk did not complete has
        # no coverage to compare, and a missing coverage read as zero is a
        # page reported as "not a scan" without being looked at.
        if not pages.readable(page_no) or page_no not in pages.painted:
            continue
        counted += 1
        for run in pages.runs[page_no]:
            if run.get("reader_limit"):
                limited.append(
                    _finding(
                        _content_address(page_no, int(run.get("index", 0))),
                        "font_encoding_unsupported",
                        rect=run.get("rect"),
                        values={"page": page_no, "font": str(run.get("font_name") or ""),
                                "reason": str(run.get("reason") or "")},
                    )
                )
                break
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
    # A fail reached only because every run's encoding was declined states
    # something false about the document: the glyphs are there and carry the
    # text. It degrades to a review naming the fonts nobody could read.
    if not extractable and limited:
        check.findings = limited
        check.status = REVIEW


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
            if not _draws_text(run):
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
    """The title ISO 14289-1 cl. 7.1 names: `dc:title` in the catalog's
    Metadata stream.

    The document information dictionary is deliberately not consulted. The
    clause admits one in a conforming file and requires a conforming reader to
    IGNORE it, so a document whose only title lives there has not declared one
    for any reader bound by the standard.
    """
    try:
        with pdf.open_metadata() as meta:
            title = meta.get("dc:title")
            if title:
                return str(title).strip()
    except Exception:
        pass
    return ""


def _docinfo_title(pdf) -> str:
    """The title the document information dictionary carries, reported so the
    finding can show what is there rather than only what is missing."""
    try:
        title = pdf.docinfo.get("/Title")
        if title is not None and str(title).strip():
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
        check.findings = [
            _finding(_object_address(), "title_missing", preview=_docinfo_title(pdf))
        ]
        return
    if not shown:
        # cl. 7.1 states DisplayDocTitle=true as a `shall`, alongside the
        # title itself: a title no reader announces is the defect, not a
        # shortfall against a recommendation.
        check.status = FAIL
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
            if not _draws_text(run):
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


def _check_tagged_annotations(check, tree, annots, cropboxes):
    targets = [
        a for a in annots
        if a["subtype"] not in _ANNOT_EXEMPT
        and a["subtype"] not in _MULTIMEDIA
        and _annotation_in_scope(a, cropboxes)
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


def _check_tab_order(check, pdf, annots, cropboxes):
    # cl. 7.18.3 asks only whether a page HAS an annotation, under 7.18.1's
    # three exemptions — not whether that annotation is perceivable.
    pages_with_annots = {
        a["page"] for a in annots
        if a["subtype"] != "/Popup" and _annotation_in_scope(a, cropboxes)
    }
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


def _first_role(roles) -> str:
    """One named role for the finding line. A widget reached by more than one
    `/OBJR` has more than one holding element, and the line names one; the
    verdict does not depend on which."""
    named = sorted(r for r in roles if r)
    return named[0] if named else ""


def _check_tagged_form_fields(check, tree, annots, fields):
    """A widget annotation enclosed in a `Form` structure element.

    ISO 14289-1 7.18.4 requires a widget annotation to be nested within a
    `Form` tag; membership in the structure tree under any other element does
    not satisfy it. NESTED WITHIN is not HELD BY — an enclosing `Form` at any
    ancestor depth satisfies the requirement, so `Form > Span > OBJR`
    conforms while the same `Span` under a `Document` does not. The enclosing
    role is the one `/RoleMap` resolves, so a document tagging its widgets
    with a custom type that maps to `Form` conforms — the mapped role is the
    element's role.
    """
    widget_ogs: set = set()
    for field in fields:
        widget_ogs.update(field["widgets"])
    widgets = [a for a in annots if a["subtype"] == "/Widget" and _visible(a)]
    if not widgets and not widget_ogs:
        check.status = NA
        return
    tagged = tree["tagged_annots"] if tree["tagged"] else set()
    roles = tree["annot_enclosing_roles"] if tree["tagged"] else {}
    holders = tree["annot_roles"] if tree["tagged"] else {}
    findings = []
    for a in widgets:
        if a["objgen"] not in tagged:
            findings.append(
                _finding(
                    _object_address(page=a["page"], annotation=a["index"]),
                    "form_field_not_tagged",
                    rect=a["rect"],
                    values={"page": a["page"]},
                )
            )
            continue
        enclosing = roles.get(a["objgen"], set())
        if _FORM_ROLE in enclosing:
            continue
        findings.append(
            _finding(
                _object_address(page=a["page"], annotation=a["index"]),
                "form_field_not_in_form",
                rect=a["rect"],
                values={
                    "page": a["page"],
                    "role": _first_role(holders.get(a["objgen"], set())),
                },
            )
        )
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
        # The same population the targets were drawn from. ISO 14289-1 cl.
        # 7.18.1 places the alternate description on the annotation the
        # element names, and cl. 7.18.5 on the link annotation's `/Contents`;
        # neither says the naming `/OBJR` must be the element's own kid. An
        # element weighed over its subtree and judged over its own kids would
        # fault a `Form` whose widget carries `/TU` one level down.
        for objr in _named_objects(node):
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
        # A Link's own visible text is NOT the description ISO 14289-1 asks
        # for: cl. 7.18.5 requires the alternate description on the link
        # annotation's Contents key, and cl. 7.18.1 accepts a structure-level
        # alternate description in its place. Visible text satisfies neither,
        # so a link carrying only text is short of the clause.
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
    # cl. 7.5 splits the two questions and does not weigh them alike: tables
    # SHOULD include headers, while a TH whose table is not navigable through
    # Headers and IDs SHALL carry Scope. A table with no header cells is
    # therefore short of a recommendation, and only the missing Scope fails.
    findings = []
    absent = []
    for entry in found:
        table, rows = entry["table"], entry["rows"]
        # Cells are collected from the whole table, not through its rows: a
        # cell nested wrongly is check 26's finding, and reporting "this table
        # has no headers" as well would blame one defect twice.
        cells = [n for n in table.descendants() if n.role in CELLS]
        headers = [c for c in cells if c.role == "TH"]
        if not headers:
            preview, rect = _node_preview(table, mcid_tables)
            absent.append(
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
    check.counted = len(found)
    check.findings = findings + absent
    if findings:
        check.status = FAIL
    elif absent:
        check.status = WARN
    else:
        check.status = PASS


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
    # A list item carrying no `Lbl` is reported by nothing here. ISO 14289-1
    # cl. 7.6 states LI as the requirement and `Lbl` and `LBody` as MAY —
    # not a recommendation short of which a document falls, so an unordered
    # list with no bullet elements is conforming and a warning over it is a
    # claim of shortfall the standard does not make.
    check.counted = len(bodies) + len(items)
    check.findings = misplaced
    if check.counted == 0:
        check.status = NA
    elif misplaced:
        check.status = FAIL
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


def _nesting_page(node):
    """The page a nesting finding names.

    An element carries `/Pg` only where it CHANGES the inherited page, so a
    container whose ancestors never named one has none of its own while
    everything inside it does. Naming no page at all in a sentence that offers
    one is what this reads through.
    """
    if node.page is not None:
        return node.page
    for kid in node.descendants():
        if kid.page is not None:
            return kid.page
    return None


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
        # Two questions per element: where it sits, and — for a type whose own
        # entry states a content model — what it holds. An element either
        # question reaches is judged; only one neither reaches is uncovered.
        placement, _pcite, _prule = struct_nesting.judge(edge)
        content, _ccite, _crule = struct_nesting.judge_content(edge)
        if (placement == struct_nesting.UNCOVERED
                and content == struct_nesting.UNCOVERED):
            uncovered += 1
            continue
        if edge.role in _NESTING_DELEGATED:
            delegated += 1
            continue
        judged += 1
        if struct_nesting.VIOLATION not in (placement, content):
            continue
        page = _nesting_page(edge.node)
        if placement == struct_nesting.VIOLATION:
            findings.append(
                _finding(
                    _struct_address(edge.node),
                    "structure_nesting_violation",
                    values={
                        "child": edge.role,
                        "parent": edge.parent_role,
                        "page": page,
                    },
                )
            )
        if content == struct_nesting.VIOLATION:
            findings.append(
                _finding(
                    _struct_address(edge.node),
                    "structure_nesting_content_model",
                    values={"parent": edge.role, "page": page},
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
        # ISO 14289-1 cl. 7.4.2, first bullet: if any heading tags are used,
        # H1 shall be the first. A document opening at H2 or lower has skipped
        # every level above it, so the first heading is measured against H1
        # exactly as every later one is measured against its predecessor. The
        # floor stays 0 for that first heading; only the reported key differs,
        # because `from` on the opening case would name a level no heading in
        # the document holds.
        floor = 0 if previous is None else previous
        if node.level > floor + 1:
            preview, rect = _node_preview(node, mcid_tables)
            if previous is None:
                finding = _finding(
                    _struct_address(node), "heading_opens_below_h1", preview=preview[:80],
                    rect=rect, values={"level": node.level},
                )
            else:
                finding = _finding(
                    _struct_address(node), "heading_level_skipped", preview=preview[:80],
                    rect=rect, values={"from": floor, "to": node.level},
                )
            findings.append(finding)
        previous = node.level
    _verdict(check, len(headings), findings)


# ── role mapping ──────────────────────────────────────────────────────────


# The standard structure types the PDF 1.7 namespace defines and the PDF 2.0
# one does not (ISO 32000-2 Annex M). The compiled rosters in `struct_nesting`
# are built from the PDF 2.0 tables, and 14.8.6.1 makes the PDF 1.7 namespace
# the DEFAULT — so without this list every document tagged the older way reads
# as carrying private types it never mapped. ISO 32000-1 is the definition and
# this repository does not hold it; Annex M enumerates the difference, and an
# enumeration of names is what this needs.
_PDF_1_7_ONLY_ROLES = frozenset(
    {"Art", "BlockQuote", "TOC", "TOCI", "Index", "Private", "Quote", "Note",
     "Reference", "BibEntry", "Code"}
)


def _is_standard_role(role: str) -> bool:
    """Is this one of the standard structure types either namespace defines?

    `struct_nesting` already compiled the PDF 2.0 rosters from the standard —
    Tables 364-375 into `CATEGORY` and Annex L into `PARENTS_2_0` — so this
    asks THEM rather than keeping a third list that would drift from both, and
    adds only the names Annex M says the older namespace holds alone. `Hn` is
    the name both tables give the numbered headings, which is what
    `heading_family` folds `H4` onto.
    """
    named = struct_nesting.heading_family(role)
    return (
        named in struct_nesting.CATEGORY
        or named in struct_nesting.PARENTS_2_0
        or named in _PDF_1_7_ONLY_ROLES
    )


def _role_map_nonterminating(role_map: dict) -> set:
    """The tags whose `/RoleMap` walk never reaches a name outside the map.

    A map is a chain of substitutions, and ISO 32000-2 14.7.4 states the
    destination as a standard type — so a chain that closes on itself names no
    type at all. The resolver hop-bounds rather than hanging; this is the same
    walk asked whether it TERMINATED, which is the part a verdict needs.
    """
    out: set = set()
    for start in role_map:
        seen: set = set()
        current = start
        while current in role_map:
            if current in seen:
                out.add(start)
                break
            seen.add(current)
            current = role_map[current]
    return out


def _check_role_map(check, tree):
    """Every structure type resolves, through `/RoleMap`, to a standard one.

    ISO 14289-1 cl. 7.1 requires each structure element's type to be one of the
    standard types or to be role mapped to one; ISO 32000-2 14.7.4 is where the
    map itself is defined. A tag neither standard nor mapped names a semantic
    no reader can act on, which is the same as carrying no semantic.

    The count is over distinct TAGS rather than elements: one unmapped private
    type is one defect however many times the document spells it.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    role_map = tree["role_map"] or {}
    circular = _role_map_nonterminating(role_map)
    findings = []
    seen: set = set()
    for node in tree["nodes"]:
        if node.tag in seen:
            continue
        seen.add(node.tag)
        if node.tag in circular:
            findings.append(
                _finding(_struct_address(node), "role_map_does_not_terminate",
                         preview=node.tag, values={"tag": node.tag})
            )
            continue
        if _is_standard_role(node.role):
            continue
        findings.append(
            _finding(_struct_address(node), "role_not_mapped", preview=node.tag,
                     values={"tag": node.tag, "role": node.role})
        )
    _verdict(check, len(seen), findings)


def _check_suspects(check, pdf):
    """`/MarkInfo /Suspects` true is the document saying its own tagging may be
    unreliable (ISO 32000-2 Table 321). ISO 14289-1 cl. 7.1 does not admit that
    claim: a conforming file states its structure, it does not disclaim it."""
    mark_info = pdf.Root.get("/MarkInfo")
    if mark_info is None:
        check.status = NA
        return
    check.counted = 1
    try:
        flagged = bool(mark_info.get("/Suspects"))
    except Exception:
        check.status = REVIEW
        check.findings = [_finding(_object_address(), "suspects_unreadable")]
        return
    check.status = FAIL if flagged else PASS
    if flagged:
        check.findings = [_finding(_object_address(), "suspects_flag_set")]


# ── content that is neither tagged nor declared decoration ────────────────


def _paints_outside_marks(pdf) -> tuple:
    """Pages painting outside every marked content sequence, and the pages
    whose stream would not parse.

    Nesting is counted rather than matched: `BDC`/`BMC` open a sequence and
    `EMC` closes one, so a painting operator executed at depth zero is content
    the page has placed under no marked content at all — neither a tagged
    sequence nor an `/Artifact` declaration.
    """
    out: list = []
    unread: list = []
    for i, page in enumerate(pdf.pages):
        page_no = i + 1
        try:
            operations = pikepdf.parse_content_stream(page)
        except Exception as exc:
            unread.append({"page": page_no, "reason": str(exc)})
            continue
        depth = 0
        for _operands, operator in operations:
            name = str(operator)
            if name in ("BDC", "BMC"):
                depth += 1
            elif name == "EMC":
                depth = max(0, depth - 1)
            elif depth == 0 and name in _PAINT_OPS:
                out.append({"page": page_no, "operator": name})
    return out, unread


def _check_untagged_graphics(check, pdf, tree):
    """ISO 14289-1 cl. 7.1: content is tagged as real content or declared an
    artifact. Text with neither is `tagged_content`'s finding; this is the
    other half — a fill, a stroke, an image or a shading painted outside every
    marked content sequence, which no reader reaches under any name."""
    if not tree["tagged"]:
        check.status = NA
        return
    painted, unread = _paints_outside_marks(pdf)
    counted = len(pdf.pages)
    if counted == 0:
        check.status = NA
        return
    by_page: dict = {}
    for hit in painted:
        by_page.setdefault(hit["page"], []).append(hit["operator"])
    findings = [
        _finding(_content_address(page_no, 0), "graphics_outside_marked_content",
                 values={"page": page_no, "operations": len(ops)})
        for page_no, ops in sorted(by_page.items())
    ]
    _verdict(check, counted, findings)
    _also_review(
        check,
        [
            _finding(_object_address(page=u["page"]), "page_unreadable",
                     values={"page": u["page"]})
            for u in unread
        ],
    )


# ── Unicode mapping, beyond presence ──────────────────────────────────────

# Codepoints a `/ToUnicode` entry may never name as the text a glyph spells:
# the null character, the two permanent noncharacters at the end of the BMP and
# the replacement character, which is what a decoder writes when it FAILED.
_NEVER_MAPPED = frozenset({0x0000, 0xFFFD, 0xFFFE, 0xFFFF})


def _program_preimages(font_obj) -> dict:
    """glyph id → every codepoint the embedded program's Unicode cmap maps to
    it, or {} where there is no such statement to read.

    Only a UNICODE cmap subtable is read — (3,1) and (3,10) on Windows, and the
    Unicode platform's own. A symbolic (3,0) subtable maps a private code page
    rather than characters, so reading it as Unicode would manufacture the very
    disagreement this looks for.
    """
    descendants = font_obj.get("/DescendantFonts")
    if descendants is None or len(descendants) == 0:
        return {}
    descendant = descendants[0]
    # Anything but an identity CID→GID mapping means the code this check holds
    # is not the glyph id, and re-deriving that mapping here would be a second
    # implementation of what `pdf_fonts` already owns.
    c2g = descendant.get("/CIDToGIDMap")
    if c2g is not None and str(c2g) != "/Identity":
        return {}
    descriptor = descendant.get("/FontDescriptor")
    if descriptor is None:
        return {}
    program = descriptor.get("/FontFile2") or descriptor.get("/FontFile3")
    if program is None:
        return {}
    try:
        from io import BytesIO

        from fontTools.ttLib import TTFont

        face = TTFont(BytesIO(program.read_bytes()), fontNumber=0, lazy=True)
        subtables = [
            st for st in face["cmap"].tables
            if (st.platformID, st.platEncID) in ((3, 1), (3, 10), (0, 3), (0, 4), (0, 6))
        ]
    except Exception:
        return {}
    out: dict = {}
    for subtable in subtables:
        try:
            items = list(subtable.cmap.items())
        except Exception:
            continue
        for codepoint, glyph_name in items:
            try:
                gid = face.getGlyphID(glyph_name)
            except Exception:
                continue
            out.setdefault(gid, set()).add(int(codepoint))
    return out


def _unicode_conflicts(pdf) -> tuple:
    """Codes whose `/ToUnicode` contradicts what the document ITSELF says the
    glyph is, and the fonts that would not read.

    ISO 32000-2 9.10.2 makes `/ToUnicode` the statement of what a code spells.
    An embedded font program carrying a Unicode cmap states the same thing a
    second time, from the other direction, so where the two disagree the
    document contradicts itself and one of the statements is wrong whichever
    one the author meant. That is decidable without seeing the glyph, which is
    what separates it from "does this shape look like that letter".
    """
    from engine.pdf_fonts import _parse_tounicode

    out: list = []
    unread: list = []
    seen: set = set()
    weighed = 0
    for i, page in enumerate(pdf.pages):
        page_no = i + 1
        try:
            fonts = _resolve_resources(page).get("/Font")
        except Exception as exc:
            unread.append({"page": page_no, "reason": str(exc)})
            continue
        if fonts is None:
            continue
        try:
            items = list(fonts.items())
        except Exception as exc:
            unread.append({"page": page_no, "reason": str(exc)})
            continue
        for name, font_obj in items:
            try:
                key = font_obj.objgen
            except Exception:
                key = None
            if key is not None and key != (0, 0):
                if key in seen:
                    continue
                seen.add(key)
            try:
                if str(font_obj.get("/Subtype") or "") != "/Type0":
                    continue
                raw = font_obj.get("/ToUnicode")
                if raw is None:
                    continue
                declared = _parse_tounicode(raw.read_bytes())
            except Exception as exc:
                unread.append({"page": page_no, "reason": str(exc)})
                continue
            weighed += 1
            preimages = _program_preimages(font_obj)
            for code, text in sorted(declared.items()):
                if len(text) != 1:
                    # A code spelling a sequence is a ligature or a composed
                    # form; the cmap states single characters and has nothing
                    # to say about it either way.
                    continue
                point = ord(text)
                if point in _NEVER_MAPPED:
                    out.append(
                        {"page": page_no, "font": str(name), "code": int(code),
                         "declared": point, "program": None}
                    )
                    continue
                expected = preimages.get(int(code))
                if not expected or point in expected:
                    continue
                out.append(
                    {"page": page_no, "font": str(name), "code": int(code),
                     "declared": point, "program": min(expected)}
                )
    return out, unread, weighed


def _u(point) -> str:
    return "" if point is None else f"U+{int(point):04X}"


def _check_unicode_mapping(check, pdf):
    """Whether the Unicode a font DECLARES is the Unicode its glyphs are.

    `character_encoding` asks whether a mapping exists at all — its finding is
    text that reads as nothing. This asks the next question ISO 14289-1 cl. 7.2
    states, which is whether the mapping is the right one, and it answers only
    where the document contradicts itself.
    """
    conflicts, unread, weighed = _unicode_conflicts(pdf)
    # The count is the FONTS this could answer for: a document whose fonts
    # state their mapping once and nowhere else has nothing here to agree or
    # disagree with, and reporting `pass` over it would be a claim about a
    # comparison that never happened.
    if weighed == 0 and not unread:
        check.status = NA
        return
    findings = [
        _finding(
            _content_address(c["page"], 0),
            "unicode_never_mapped" if c["program"] is None else "unicode_contradicts_font",
            preview=_u(c["declared"]),
            values={
                "page": c["page"], "font": c["font"].lstrip("/"),
                "code": c["code"], "declared": _u(c["declared"]),
                "program": _u(c["program"]),
            },
        )
        for c in conflicts
    ]
    _verdict(check, weighed, findings)
    _also_review(
        check,
        [_finding(_object_address(page=u["page"]), "font_program_unreadable",
                  values={"page": u["page"]}) for u in unread],
    )


# ── judgements this checker states rather than makes ──────────────────────


def _runs_by_mcid(pages) -> dict:
    """(page, mcid) → the runs that drew it, in draw order."""
    out: dict = {}
    for page_no, runs in pages.runs.items():
        for run in runs:
            mcid = run.get("mcid")
            if mcid is None or run.get("nested"):
                continue
            out.setdefault((page_no, int(mcid)), []).append(run)
    return out


def _node_runs(node, by_mcid: dict) -> list:
    out: list = []
    for ref in node.mcids:
        if ref.get("form"):
            continue
        out.extend(by_mcid.get((ref["page"], ref["mcid"])) or [])
    for kid in node.descendants():
        for ref in kid.mcids:
            if ref.get("form"):
                continue
            out.extend(by_mcid.get((ref["page"], ref["mcid"])) or [])
    return out


def _size_of(runs: list) -> float:
    """The largest size an element's own text is drawn at, rounded the same way
    `_body_size` rounds — the two are compared, and a tenth of a point of
    difference between 11.039 and 11.0 is not a difference in how the page
    looks."""
    sizes = [round(float(r.get("font_size") or 0.0), 1) for r in runs if _draws_text(r)]
    sizes = [s for s in sizes if s > 0]
    return max(sizes) if sizes else 0.0


def _body_size(pages) -> float:
    """The size the document sets most of its text in, by drawn length.

    The comparison every "is this visually a heading" question needs. Weighted
    by characters rather than by run count so a page of headings does not
    become the body.
    """
    weight: dict = {}
    for runs in pages.runs.values():
        for run in runs:
            size = round(float(run.get("font_size") or 0.0), 1)
            text = str(run.get("text") or "").strip()
            if size <= 0 or not text:
                continue
            weight[size] = weight.get(size, 0) + len(text)
    if not weight:
        return 0.0
    return max(weight.items(), key=lambda kv: (kv[1], -kv[0]))[0]


def _prose_size(pages, tree, by_mcid: dict) -> float:
    """The size the document sets its NON-heading text in.

    `_body_size` weights every run, which on a document of short sections makes
    the headings themselves the dominant size and then reports every one of
    them as set like body text. The structure tree already says which content
    is a heading, so the comparison is drawn against what is left. A document
    whose tagged text is headings only has no such measurement, and falls back
    to the whole-page one rather than reporting nothing.
    """
    weight: dict = {}
    for node in tree["nodes"]:
        if node.level is not None:
            continue
        for run in _node_runs(node, by_mcid):
            size = round(float(run.get("font_size") or 0.0), 1)
            text = str(run.get("text") or "").strip()
            if size <= 0 or not text:
                continue
            weight[size] = weight.get(size, 0) + len(text)
    if not weight:
        return _body_size(pages)
    return max(weight.items(), key=lambda kv: (kv[1], -kv[0]))[0]


def _marked_paint(pdf) -> dict:
    """(page, mcid) → what that marked content sequence paints.

    `{"share": the fraction of the page its declared rectangles cover,
    "images": XObject and inline-image invocations, "text": text-showing
    operators}`. The rectangles are `re` operands under the current
    translation and scale; rotation and skew are not modelled, so this is a
    measurement of what the stream DECLARES rather than of the rendered page —
    which is why nothing here decides anything, only reports.
    """
    out: dict = {}
    for i, page in enumerate(pdf.pages):
        page_no = i + 1
        try:
            box = [float(v) for v in (page.obj.get("/CropBox") or page.obj.get("/MediaBox"))]
            area = abs(box[2] - box[0]) * abs(box[3] - box[1])
            operations = pikepdf.parse_content_stream(page)
        except Exception:
            continue
        if area <= 0:
            continue
        stack: list = [(1.0, 1.0)]
        marks: list = []
        for operands, operator in operations:
            name = str(operator)
            if name == "q":
                stack.append(stack[-1])
            elif name == "Q" and len(stack) > 1:
                stack.pop()
            elif name == "cm" and len(operands) >= 4:
                try:
                    scale = (abs(float(operands[0])), abs(float(operands[3])))
                except (TypeError, ValueError):
                    scale = (1.0, 1.0)
                stack[-1] = (stack[-1][0] * scale[0], stack[-1][1] * scale[1])
            elif name in ("BDC", "BMC"):
                mcid = None
                if len(operands) >= 2 and isinstance(operands[1], pikepdf.Dictionary):
                    value = operands[1].get("/MCID")
                    if value is not None:
                        try:
                            mcid = int(value)
                        except (TypeError, ValueError):
                            mcid = None
                marks.append(mcid)
                if mcid is not None:
                    out.setdefault((page_no, mcid), {"share": 0.0, "images": 0, "text": 0})
            elif name == "EMC" and marks:
                marks.pop()
            elif not marks or marks[-1] is None:
                continue
            elif name == "re" and len(operands) >= 4:
                try:
                    width = abs(float(operands[2])) * stack[-1][0]
                    height = abs(float(operands[3])) * stack[-1][1]
                except (TypeError, ValueError):
                    continue
                out[(page_no, marks[-1])]["share"] += (width * height) / area
            elif name in ("Do", "EI"):
                out[(page_no, marks[-1])]["images"] += 1
            elif name in ("Tj", "TJ", "'", '"'):
                out[(page_no, marks[-1])]["text"] += 1
    return out


def _check_artifact_judgement(check, pdf, tree, pages, mcid_tables):
    """Content declared decoration that reads like content, and content tagged
    as a figure that paints no figure.

    ISO 14289-1 cl. 7.1 divides every piece of content into real content and
    artifacts, and NOTHING in the file records which one the author meant — so
    this check never decides. It reports the two shapes where the division is
    worth a person's look, each with what it measured.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    body = _body_size(pages)
    findings = []
    counted = 0
    for page_no in sorted(pages.runs):
        runs = [r for r in pages.runs[page_no] if _draws_text(r) and not r.get("nested")]
        tagged = [r for r in runs if r.get("mcid") is not None and not r.get("artifact")]
        counted += len(runs)
        for run in runs:
            if not run.get("artifact"):
                continue
            rect = run.get("rect") or [0, 0, 0, 0]
            size = float(run.get("font_size") or 0.0)
            # Contiguity with real content: the same baseline band, the same
            # drawn size, and no horizontal gap wider than one em. Text that
            # continues a tagged sentence is the artifact declaration worth
            # doubting; a running header sits on a line of its own.
            for neighbour in tagged:
                other = neighbour.get("rect") or [0, 0, 0, 0]
                if abs(other[1] - rect[1]) > 1.0:
                    continue
                if size and abs(float(neighbour.get("font_size") or 0.0) - size) > 0.5:
                    continue
                gap = min(abs(rect[0] - other[2]), abs(other[0] - rect[2]))
                if gap > max(size, 1.0):
                    continue
                findings.append(
                    _finding(
                        _content_address(page_no, int(run.get("index", 0))),
                        "artifact_continues_real_content",
                        preview=str(run.get("text") or "")[:80],
                        rect=run.get("rect"),
                        values={"page": page_no,
                                "neighbour": str(neighbour.get("text") or "")[:40]},
                    )
                )
                break
            else:
                # Prose, declared decoration. A running header or a page number
                # is short and set apart; a sentence's worth of words at the
                # size the document sets its body in is the shape where the
                # declaration is worth doubting on its own.
                words = str(run.get("text") or "").split()
                if len(words) < _ARTIFACT_PROSE_WORDS:
                    continue
                if body <= 0 or abs(size - body) > 0.5:
                    continue
                findings.append(
                    _finding(
                        _content_address(page_no, int(run.get("index", 0))),
                        "artifact_reads_as_prose",
                        preview=str(run.get("text") or "")[:80],
                        rect=run.get("rect"),
                        values={"page": page_no, "words": len(words)},
                    )
                )
    by_mcid = _runs_by_mcid(pages)
    painted = _marked_paint(pdf)
    for node in tree["nodes"]:
        if node.role not in _FIGURE_ROLES:
            continue
        counted += 1
        preview, rect = _node_preview(node, mcid_tables)
        # A figure standing INSIDE a run of text is a picture in the position
        # a word occupies — the shape a graphic that spells text takes.
        parent = struct_nesting.effective_parent(node)
        if parent is not None and parent.role in _INLINE_TEXT_ROLES:
            findings.append(
                _finding(_struct_address(node), "figure_inline_in_text",
                         preview=preview[:80], rect=rect,
                         values={"role": node.role, "parent": parent.role})
            )
            continue
        # A figure that paints nothing but a large field of colour is the
        # shape a page background takes when it is tagged rather than declared
        # decoration. Reported, never decided: a full-bleed illustration is the
        # same measurement and is real content.
        share = 0.0
        for ref in node.mcids:
            if ref.get("form"):
                continue
            record = painted.get((ref["page"], ref["mcid"]))
            if record is None or record["images"] or record["text"]:
                share = 0.0
                break
            share += record["share"]
        if share < _FIGURE_BACKGROUND_SHARE:
            continue
        findings.append(
            _finding(_struct_address(node), "figure_covers_the_page",
                     preview=preview[:80], rect=rect,
                     values={"role": node.role, "share": round(share * 100)})
        )
    if counted == 0:
        check.status = NA
        return
    check.counted = counted
    check.findings = findings
    check.status = REVIEW if findings else PASS


def _blocks_of(runs: list) -> list:
    """One element's drawn text as vertical blocks: (top, bottom, height)."""
    lines: dict = {}
    for run in runs:
        rect = run.get("rect")
        if not rect or not _draws_text(run):
            continue
        key = round(float(rect[1]), 1)
        box = lines.get(key)
        rect = [float(v) for v in rect]
        lines[key] = rect if box is None else [
            min(box[0], rect[0]), min(box[1], rect[1]),
            max(box[2], rect[2]), max(box[3], rect[3]),
        ]
    return [lines[k] for k in sorted(lines, reverse=True)]


def _check_content_grouping(check, tree, pages, mcid_tables):
    """Elements whose content is not one visual thing, and neighbours that are.

    Whether two paragraphs are one paragraph is the author's answer and no
    file records it, so this check states evidence and never a verdict: an
    element whose own content sits in blocks separated by more than a line, a
    figure tagged inside a run of text, and consecutive same-role siblings that
    occupy adjacent lines of one block.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    by_mcid = _runs_by_mcid(pages)
    findings = []
    counted = 0
    for node in tree["nodes"]:
        # Content this element tags ITSELF. A container's subtree is many
        # things by construction, and measuring the gaps in it would offer
        # every document's body for review under its root element.
        runs: list = []
        for ref in node.mcids:
            if not ref.get("form"):
                runs.extend(by_mcid.get((ref["page"], ref["mcid"])) or [])
        if not runs:
            continue
        counted += 1
        blocks = _blocks_of(runs)
        if len(blocks) < 3:
            # Two lines set no pitch of their own, so there is nothing to
            # measure a gap against and nothing this can say.
            continue
        pitches = sorted(a[1] - b[1] for a, b in zip(blocks, blocks[1:]))
        pitch = pitches[len(pitches) // 2]
        if pitch <= 0:
            continue
        for earlier, later in zip(blocks, blocks[1:]):
            if earlier[1] - later[1] < pitch * _BLOCK_GAP_PITCH:
                continue
            preview, rect = _node_preview(node, mcid_tables)
            findings.append(
                _finding(_struct_address(node), "element_spans_separated_blocks",
                         preview=preview[:80], rect=rect,
                         values={"role": node.role, "blocks": len(blocks)})
            )
            break
    for node in tree["nodes"]:
        siblings = node.children
        for index in range(len(siblings) - 1):
            first, second = siblings[index], siblings[index + 1]
            # Prose blocks only. Cells sit side by side and list items sit one
            # under the next BY CONSTRUCTION, so measuring those positions
            # would report the shape of every table and every list.
            if first.role != second.role or first.role not in _PROSE_ROLES:
                continue
            first_blocks = _blocks_of(_node_runs(first, by_mcid))
            second_blocks = _blocks_of(_node_runs(second, by_mcid))
            if not first_blocks or not second_blocks:
                continue
            lower, upper = first_blocks[-1], second_blocks[0]
            height = max(lower[3] - lower[1], 1.0)
            stacked = (
                0 <= lower[1] - upper[3] <= height * _ONE_BLOCK_GAP
                and abs(lower[0] - upper[0]) <= height
            )
            # Side by side: horizontally clear of each other and level with
            # each other. Two columns of one flow are tagged as one element
            # or as two, and which the author meant is not in the file.
            top, bottom = second_blocks[0], second_blocks[-1]
            beside = (
                (lower[2] <= upper[0] or lower[0] >= upper[2])
                and min(first_blocks[0][3], top[3]) - max(first_blocks[-1][1], bottom[1]) > 0
            )
            if not (stacked or beside):
                continue
            preview, rect = _node_preview(second, mcid_tables)
            findings.append(
                _finding(
                    _struct_address(second),
                    "siblings_share_one_block" if stacked else "siblings_sit_side_by_side",
                    preview=preview[:80], rect=rect, values={"role": second.role},
                )
            )
    # A figure sitting between two elements whose text runs on through it.
    for node in tree["nodes"]:
        for index, child in enumerate(node.children):
            if child.role not in _FIGURE_ROLES:
                continue
            before = node.children[index - 1] if index else None
            after = node.children[index + 1] if index + 1 < len(node.children) else None
            if before is None or after is None:
                continue
            if before.role != after.role or before.role in _FIGURE_ROLES:
                continue
            preview, rect = _node_preview(child, mcid_tables)
            findings.append(
                _finding(_struct_address(child), "figure_splits_one_unit",
                         preview=preview[:80], rect=rect,
                         values={"role": child.role, "around": before.role})
            )
    if counted == 0:
        check.status = NA
        return
    check.counted = counted
    check.findings = findings
    check.status = REVIEW if findings else PASS


def _horizontal_clusters(runs: list) -> list:
    """One sequence's runs grouped by horizontal band, widest gap first.

    Returns the groups' (left, right) extents, left to right. A sequence whose
    runs fall into bands with a wide clear gap between them is a tag reaching
    across a column boundary — which a page-wide top-to-bottom sort cannot see,
    because it reads the two columns as one.
    """
    spans = sorted(
        (float(r["rect"][0]), float(r["rect"][2])) for r in runs if r.get("rect")
    )
    if not spans:
        return []
    groups = [list(spans[0])]
    for left, right in spans[1:]:
        if left <= groups[-1][1]:
            groups[-1][1] = max(groups[-1][1], right)
            continue
        groups.append([left, right])
    return groups


def _check_content_order(check, tree, pages, mcid_tables):
    """The two order questions `reading_order`'s band sort cannot ask.

    That sort works over merged marked-content boxes, top to bottom across the
    whole page, so it reads a two-column page as one column and never sees
    inside a sequence at all. Both questions are evidence rather than verdicts
    — a layout is not a reading order, and the author's is the one that counts.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    by_mcid = _runs_by_mcid(pages)
    findings = []
    counted = 0
    for (page_no, mcid), runs in sorted(by_mcid.items()):
        drawn = [r for r in runs if _draws_text(r) and r.get("rect")]
        if len(drawn) < 2:
            continue
        counted += 1
        size = max([float(r.get("font_size") or 0.0) for r in drawn] + [1.0])
        clusters = _horizontal_clusters(drawn)
        if len(clusters) > 1 and any(
            later[0] - earlier[1] > size * _COLUMN_GAP_SIZES
            for earlier, later in zip(clusters, clusters[1:])
        ):
            findings.append(
                _finding(
                    _content_address(page_no, int(drawn[0].get("index", 0))),
                    "sequence_spans_columns",
                    preview=str(drawn[0].get("text") or "")[:80],
                    rect=drawn[0].get("rect"),
                    values={"page": page_no, "mcid": mcid, "bands": len(clusters)},
                )
            )
        backwards = 0
        for earlier, later in zip(drawn, drawn[1:]):
            first, second = [float(v) for v in earlier["rect"]], [float(v) for v in later["rect"]]
            overlap = min(first[3], second[3]) - max(first[1], second[1])
            height = min(first[3] - first[1], second[3] - second[1])
            if height <= 0 or overlap < height * _SAME_LINE_OVERLAP:
                continue
            # Two runs sharing a line, and the later one starts left of the
            # earlier one: the sequence draws its own text out of order.
            if second[0] + 0.5 < first[0]:
                backwards += 1
        if not backwards:
            continue
        findings.append(
            _finding(
                _content_address(page_no, int(drawn[0].get("index", 0))),
                "sequence_draws_backwards",
                preview=str(drawn[0].get("text") or "")[:80],
                rect=drawn[0].get("rect"),
                values={"page": page_no, "mcid": mcid, "jumps": backwards},
            )
        )
    if counted == 0:
        check.status = NA
        return
    check.counted = counted
    check.findings = findings
    check.status = REVIEW if findings else PASS


# ── lists ─────────────────────────────────────────────────────────────────


def _numbering_of(node) -> str:
    value = node.attrs.get("ListNumbering")
    if value is None:
        return ""
    try:
        return str(value).lstrip("/")
    except Exception:
        return ""


def _label_class(text: str) -> str:
    """A label's own class: a bullet shape's name, `Ordered`, or "" for a label
    that decides nothing.

    Only the three bullet shapes ISO 32000-2 Table 353 names are read as
    bullets; a tick, a dash or a dingbat is a label this cannot classify, and a
    list labelled with one is left alone rather than guessed at. `Ordered` is
    deliberately coarse — WHICH counting system a label uses is not decidable
    (`I.` is a roman numeral and a letter), and only the ordered/unordered
    split is what a declared value can be judged against.
    """
    body = text.strip()
    if not body:
        return ""
    if body in _BULLET_GLYPHS:
        return _BULLET_GLYPHS[body]
    body = body.strip(_LABEL_TRIM)
    if not body:
        return ""
    if body.isdigit():
        return "Ordered"
    if len(body) == 1 and body.isalpha():
        return "Ordered"
    if all(c in _ROMAN_LETTERS for c in body):
        return "Ordered"
    return ""


def _list_label_class(node, mcid_tables) -> str:
    """The class every one of a list's OWN item labels agrees on, or "".

    A list whose direct items disagree, or whose items carry no label at all,
    states nothing this can judge a declaration against. Labels inside a nested
    list belong to that list and are not read here.
    """
    classes: set = set()
    for item in node.children:
        if item.role != "LI":
            continue
        for kid in item.children:
            if kid.role != "Lbl":
                continue
            found = _label_class(_node_preview(kid, mcid_tables)[0])
            if not found:
                return ""
            classes.add(found)
    if len(classes) != 1:
        return ""
    return classes.pop()


def _check_list_numbering(check, tree, mcid_tables):
    """A list's `/ListNumbering` against the labels the document draws.

    ISO 14289-1 cl. 7.6 requires list structure to reflect the list, and ISO
    32000-2 Table 353 makes `/ListNumbering` the statement of which kind of
    list it is. Numbered items under a bullet declaration, or none at all, are
    announced as an unordered list; bullets under a numbering system are
    counted aloud. Both are decidable from the document's own two statements —
    which counting system is right is not, and is not asked.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    lists = [n for n in tree["nodes"] if n.role == "L"]
    if not lists:
        check.status = NA
        return
    counted = 0
    findings = []
    for node in lists:
        drawn = _list_label_class(node, mcid_tables)
        if not drawn:
            continue
        counted += 1
        declared = _numbering_of(node)
        preview, rect = _node_preview(node, mcid_tables)
        if drawn == "Ordered":
            if declared in _ORDERED_NUMBERING:
                continue
            findings.append(
                _finding(_struct_address(node), "list_numbering_not_ordered",
                         preview=preview[:80], rect=rect,
                         values={"declared": declared or _NO_NUMBERING})
            )
            continue
        # A bullet list: `None` and an absent entry both state "not numbered",
        # which is true of it. A numbering system is wrong, and so is a bullet
        # shape that is not the shape drawn.
        if not declared or declared == _NO_NUMBERING or declared == drawn:
            continue
        findings.append(
            _finding(
                _struct_address(node),
                "list_numbering_ordered" if declared in _ORDERED_NUMBERING
                else "list_numbering_wrong_bullet",
                preview=preview[:80], rect=rect,
                values={"declared": declared, "drawn": drawn},
            )
        )
    _verdict(check, counted, findings)


def _check_list_item_structure(check, tree, mcid_tables):
    """What a list item is allowed to hold.

    ISO 32000-2 Table 370 states `LBody` as internal to `LI` and `Lbl` as the
    item's label; a list item holds those and nothing else. An item holding a
    paragraph directly, a nested list beside its body rather than inside it, or
    page content of its own has put the item's body somewhere no reader looks
    for it. `structure_nesting` delegates `LI` here rather than reporting the
    same placement twice.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    items = [n for n in tree["nodes"] if n.role == "LI"]
    if not items:
        check.status = NA
        return
    findings = []
    for node in items:
        preview, rect = _node_preview(node, mcid_tables)
        stray = [c.role for c in node.children if c.role not in _LIST_ITEM_ROLES]
        if stray:
            findings.append(
                _finding(_struct_address(node), "list_item_holds_other_roles",
                         preview=preview[:80], rect=rect,
                         values={"roles": ", ".join(sorted(set(stray)))})
            )
            continue
        if node.mcids or node.objrs:
            findings.append(
                _finding(_struct_address(node), "list_item_holds_content_directly",
                         preview=preview[:80], rect=rect, values={"role": node.role})
            )
            continue
        if not any(c.role == "LBody" for c in node.children):
            findings.append(
                _finding(_struct_address(node), "list_item_has_no_body",
                         preview=preview[:80], rect=rect, values={"role": node.role})
            )
    _verdict(check, len(items), findings)


def _check_list_semantics(check, tree, pages, mcid_tables):
    """Lists the tree does not say are lists, and lists it says twice.

    Whether a run of paragraphs IS a list, and whether two lists are one list
    split, are the author's answers. Both leave a trace worth showing: content
    carrying list labels under no list element, an item whose label was left
    inside its own body, and consecutive lists on one page whose declarations
    agree. Each is reported with what was measured; none is a verdict.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    by_mcid = _runs_by_mcid(pages)
    findings = []
    counted = 0
    for node in tree["nodes"]:
        if node.role != "L":
            continue
        counted += 1
        # A list whose items carry no `Lbl` while their bodies OPEN with one.
        for item in node.children:
            if item.role != "LI" or any(c.role == "Lbl" for c in item.children):
                continue
            # Read through the item's own subtree: an `LI` carries its text on
            # the `LBody` below it, and the whole point here is that the label
            # was left down there with it.
            text = " ".join(
                str(r.get("text") or "") for r in _node_runs(item, by_mcid)
            ).strip()
            head = text.split(" ", 1)[0] if text else ""
            if not _label_class(head):
                continue
            findings.append(
                _finding(_struct_address(item), "list_label_inside_body",
                         preview=text[:80], values={"label": head[:16]})
            )
    # Sibling lists that declare the same numbering: one list, tagged as two.
    for node in tree["nodes"]:
        siblings = [c for c in node.children if c.role == "L"]
        if len(siblings) < 2:
            continue
        for first, second in zip(siblings, siblings[1:]):
            if _numbering_of(first) != _numbering_of(second):
                continue
            if not _numbering_of(first):
                continue
            preview, rect = _node_preview(second, mcid_tables)
            findings.append(
                _finding(_struct_address(second), "adjacent_lists_declare_alike",
                         preview=preview[:80], rect=rect,
                         values={"numbering": _numbering_of(second)})
            )
    # Content that carries list labels while no list element tags it.
    for node in tree["nodes"]:
        run_of = 0
        for child in node.children:
            if child.role != "P":
                run_of = 0
                continue
            runs = _node_runs(child, by_mcid)
            text = " ".join(str(r.get("text") or "") for r in runs).strip()
            head = text.split(" ", 1)[0] if text else ""
            if not _label_class(head):
                run_of = 0
                continue
            run_of += 1
            if run_of != 2:
                continue
            preview, rect = _node_preview(child, mcid_tables)
            findings.append(
                _finding(_struct_address(child), "labelled_paragraphs_are_not_a_list",
                         preview=preview[:80], rect=rect, values={"label": head[:16]})
            )
    if counted == 0 and not findings:
        check.status = NA
        return
    check.counted = max(counted, len(findings))
    check.findings = findings
    check.status = REVIEW if findings else PASS


# ── headings ──────────────────────────────────────────────────────────────


def _check_heading_tag_mixing(check, tree, mcid_tables):
    """`H` and `Hn` in one document.

    ISO 14289-1 cl. 7.4 states the two heading conventions as alternatives: a
    document either nests unnumbered `H` elements or numbers them, and mixing
    the two leaves the outline with two answers about the same level. The
    finding names the `H` elements, because the numbered ones already state
    their level and the unnumbered ones are what stops being readable.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    generic = [n for n in tree["nodes"] if n.role == "H"]
    numbered = [n for n in tree["nodes"] if n.role in ("H1", "H2", "H3", "H4", "H5", "H6")]
    if not generic and not numbered:
        check.status = NA
        return
    findings = []
    if generic and numbered:
        for node in generic:
            preview, rect = _node_preview(node, mcid_tables)
            findings.append(
                _finding(_struct_address(node), "heading_conventions_mixed",
                         preview=preview[:80], rect=rect,
                         values={"numbered": len(numbered), "generic": len(generic)})
            )
    _verdict(check, len(generic) + len(numbered), findings)


def _check_heading_semantics(check, tree, pages, mcid_tables):
    """Text that looks like a heading and is not tagged as one, and the reverse.

    ISO 14289-1 cl. 7.4 requires headings to be tagged as headings, and nothing
    in a file says which text IS one — the drawn size is the only signal, and a
    size is not a semantic. So this reports candidates with their measurements
    and never decides: a paragraph set larger than the body, a heading set no
    larger than it, and a document opening with more than one top-level
    heading.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    by_mcid = _runs_by_mcid(pages)
    body = _prose_size(pages, tree, by_mcid)
    if body <= 0:
        check.status = NA
        return
    findings = []
    counted = 0
    for node in tree["nodes"]:
        if node.role != "P" and node.level is None:
            continue
        runs = _node_runs(node, by_mcid)
        size = _size_of(runs)
        if size <= 0:
            continue
        counted += 1
        preview, rect = _node_preview(node, mcid_tables)
        if node.level is None and size >= body * _HEADING_SIZE_RATIO:
            findings.append(
                _finding(_struct_address(node), "paragraph_is_set_like_a_heading",
                         preview=preview[:80], rect=rect,
                         values={"size": round(size, 1), "body": round(body, 1)})
            )
            continue
        if node.level is not None and size <= body:
            findings.append(
                _finding(_struct_address(node), "heading_is_set_like_body_text",
                         preview=preview[:80], rect=rect,
                         values={"level": node.level, "size": round(size, 1),
                                 "body": round(body, 1)})
            )
    # More than one `H1` is NOT reported. A document with a top-level heading
    # per section is the ordinary shape, and a checker that offered every one
    # of them for review would be handing the reader the document back.
    if counted == 0:
        check.status = NA
        return
    check.counted = counted
    check.findings = findings
    check.status = REVIEW if findings else PASS


# ── annotation subtypes, links and media (cl. 7.18.2, 7.18.5, 7.18.6.2) ───


def _check_trapnet_annotations(check, annots):
    """ISO 14289-1 cl. 7.18.2: annotations of subtype TrapNet shall not be
    permitted. Trapping instructions describe a press run, not the document;
    nothing in one is content a reader could reach under any name, so the
    clause states the prohibition flatly and this check reports it the same
    way."""
    if not annots:
        check.status = NA
        return
    findings = [
        _finding(
            _object_address(page=a["page"], annotation=a["index"]),
            "trapnet_annotation",
            rect=a["rect"],
            values={"page": a["page"]},
        )
        for a in annots
        if a["subtype"] == "/TrapNet"
    ]
    _verdict(check, len(annots), findings)


# An action chain is a linked list through `/Next` (ISO 32000-2 12.6.1); the
# bound is what keeps a file that links one to itself from walking forever.
_ACTION_CHAIN_DEPTH = 8


def _uri_actions(annot) -> list:
    """Every URI action reachable from an annotation's `/A`, following the
    `/Next` chain and the array spelling of it."""
    out: list = []
    seen: set = set()
    try:
        first = annot.get("/A")
    except Exception:
        return out
    if first is None:
        return out
    stack = [(first, 0)]
    while stack:
        action, depth = stack.pop()
        if depth > _ACTION_CHAIN_DEPTH:
            continue
        try:
            items = list(action) if isinstance(action, pikepdf.Array) else [action]
        except Exception:
            continue
        for item in items:
            if not isinstance(item, pikepdf.Dictionary):
                continue
            try:
                og = item.objgen
            except Exception:
                og = (0, 0)
            if og != (0, 0):
                if og in seen:
                    continue
                seen.add(og)
            try:
                if str(item.get("/S") or "") == "/URI":
                    out.append(item)
                nxt = item.get("/Next")
            except Exception:
                continue
            if nxt is not None:
                stack.append((nxt, depth + 1))
    return out


def _check_link_ismap(check, annots):
    """ISO 14289-1 cl. 7.18.5: `/IsMap` shall not be present with the value
    true in a URI action dictionary UNLESS its functionality is also provided
    in an equivalent manner elsewhere in the content without an `/IsMap` key.

    A server-side image map sends a click COORDINATE to a server, so a reader
    that cannot point at a pixel cannot use the link at all. The clause's
    exception turns on whether some other link, widget or script does the same
    job somewhere else in the document — the standard's own NOTE lists three
    ways of providing it — and that is a question about what the rest of the
    document MEANS, not a fact in the file. A set flag is therefore reported
    with its address for a person to answer, never failed.
    """
    counted = 0
    findings = []
    for annot in annots:
        if annot["subtype"] != "/Link":
            continue
        for action in _uri_actions(annot["obj"]):
            counted += 1
            try:
                is_map = bool(action.get("/IsMap"))
            except Exception:
                is_map = False
            if is_map:
                findings.append(
                    _finding(
                        _object_address(page=annot["page"], annotation=annot["index"]),
                        "link_uri_ismap",
                        rect=annot["rect"],
                        values={"page": annot["page"]},
                    )
                )
    _verdict(check, counted, findings, dirty=REVIEW)


def _typed_dictionaries(pdf, type_name: str, subtype: str = "") -> tuple:
    """Every indirect dictionary in the file carrying `/Type` (and, where
    given, `/S`), and the reads that did not complete.

    Read off the object table rather than by walking down from the catalog:
    the dictionaries these clauses govern hang off several different owners —
    a rendition action, a rendition, a `/RichMediaContent` — and a walk that
    knew only the routes this reader thought of would report a clean claim
    over the ones it did not.
    """
    out: list = []
    unread: list = []
    try:
        objects = list(pdf.objects)
    except Exception as exc:
        return [], [str(exc)]
    for obj in objects:
        if not isinstance(obj, pikepdf.Dictionary):
            continue
        try:
            if str(obj.get("/Type") or "") != type_name:
                continue
            if subtype and str(obj.get("/S") or "") != subtype:
                continue
        except Exception as exc:
            unread.append(str(exc))
            continue
        out.append(obj)
    return out, unread


def _check_media_clip_data(check, pdf):
    """ISO 14289-1 cl. 7.18.6.2: in the media clip data dictionary the `/CT`
    and `/Alt` keys, optional in ISO 32000, ARE REQUIRED.

    `/CT` is the content type, which is what tells a reader what the clip even
    is before it plays; `/Alt` is the text a reader announces in place of
    playing it. A clip missing either is media nothing can describe.
    """
    clips, unread = _typed_dictionaries(pdf, "/MediaClip", "/MCD")
    if not clips and not unread:
        check.status = NA
        return
    findings = []
    for clip in clips:
        try:
            has_ct = clip.get("/CT") is not None
            has_alt = clip.get("/Alt") is not None
        except Exception as exc:
            unread.append(str(exc))
            continue
        if not has_ct:
            findings.append(_finding(_object_address(), "media_clip_no_content_type"))
        if not has_alt:
            findings.append(_finding(_object_address(), "media_clip_no_alt"))
    _verdict(check, len(clips), findings)
    _also_review(
        check, [_finding(_object_address(), "media_clip_unreadable") for _ in unread]
    )


def _check_reference_xobjects(check, pdf):
    """ISO 14289-1 cl. 7.20: Reference XObjects shall not be used.

    A reference XObject imports its content from ANOTHER file at render time
    (ISO 32000-2 8.10.4). Nothing in the importing file's structure tree can
    describe content that is not in it, and the proxy it falls back to is not
    what the page claims to show — so the clause forbids the construction
    outright rather than asking for it to be tagged.
    """
    forms: list = []
    unread: list = []
    try:
        objects = list(pdf.objects)
    except Exception as exc:
        objects = []
        unread.append(str(exc))
    for obj in objects:
        if not isinstance(obj, pikepdf.Stream):
            continue
        try:
            if str(obj.get("/Subtype") or "") != "/Form":
                continue
            forms.append((obj, obj.get("/Ref") is not None))
        except Exception as exc:
            unread.append(str(exc))
    if not forms and not unread:
        check.status = NA
        return
    findings = [
        _finding(_object_address(), "reference_xobject")
        for _obj, referenced in forms
        if referenced
    ]
    _verdict(check, len(forms), findings)
    _also_review(
        check, [_finding(_object_address(), "xobjects_unreadable") for _ in unread]
    )


# ── fonts (cl. 7.21) ──────────────────────────────────────────────────────

# ISO 32000-2 9.4.3. The four text-showing operators; everything else in a
# text object positions or styles, and positioning alone renders no glyph.
_TEXT_SHOWING = frozenset({"Tj", "TJ", "'", '"'})

# ISO 32000-2 9.3.6: mode 3 neither strokes, fills nor clips. ISO 14289-1
# cl. 7.21.1 NOTE and cl. 7.21.4.1 NOTE 2 both exempt a font referenced solely
# in it from every requirement that bears on rendering.
_INVISIBLE_TEXT = 3

_CONTENT_DEPTH = 8

# ISO 32000-2 Table 121. Bit 3 is the symbolic flag and bit 6 the non-symbolic
# one, numbered from 1.
_FLAG_SYMBOLIC = 1 << 2
_FLAG_NONSYMBOLIC = 1 << 5

_FONT_PROGRAM_KEYS = ("/FontFile", "/FontFile2", "/FontFile3")

# The two encodings ISO 14289-1 cl. 7.21.6 admits for a non-symbolic TrueType
# font, in the font dictionary's `/Encoding` or in its `/BaseEncoding`.
_TRUETYPE_ENCODINGS = frozenset({"/MacRomanEncoding", "/WinAnsiEncoding"})


def _rendered_fonts(pdf) -> tuple:
    """objgen → the font dictionary of every font a text-showing operator
    actually draws with, plus the streams that would not parse.

    ISO 14289-1 cl. 7.21.4.1 defines a font as USED when at least one of its
    glyphs is referenced from a content stream, and cl. 7.21.1 exempts a font
    referenced solely in text rendering mode 3. Both turn on what the stream
    does, so the answer is taken from the operators rather than from the
    resource table — a font a resource dictionary declares and nothing draws
    with is not a font this clause governs, and reporting it would be a false
    failure on a conforming file.

    `q`/`Q` save and restore the selected font and the rendering mode with the
    rest of the graphics state (ISO 32000-2 8.4.2, Table 51), so both travel
    on the stack here rather than being read as if a stream were flat.
    """
    out: dict = {}
    unread: list = []

    def walk(owner, resources, page_no: int, depth: int, seen: set) -> None:
        if depth > _CONTENT_DEPTH:
            return
        try:
            operations = pikepdf.parse_content_stream(owner)
        except Exception as exc:
            unread.append({"page": page_no, "reason": str(exc)})
            return
        fonts = None
        xobjects = None
        if isinstance(resources, pikepdf.Dictionary):
            try:
                fonts = resources.get("/Font")
                xobjects = resources.get("/XObject")
            except Exception as exc:
                unread.append({"page": page_no, "reason": str(exc)})
        mode = 0
        font = None
        stack: list = []
        for operands, operator in operations:
            name = str(operator)
            if name == "q":
                stack.append((mode, font))
            elif name == "Q":
                if stack:
                    mode, font = stack.pop()
            elif name == "Tf" and operands:
                font = None
                if isinstance(fonts, pikepdf.Dictionary):
                    try:
                        font = fonts.get(str(operands[0]))
                    except Exception:
                        font = None
            elif name == "Tr" and operands:
                try:
                    mode = int(operands[0])
                except Exception:
                    mode = 0
            elif name in _TEXT_SHOWING:
                if mode != _INVISIBLE_TEXT and isinstance(font, pikepdf.Dictionary):
                    try:
                        out[font.objgen] = font
                    except Exception:
                        pass
            elif name == "Do" and operands and isinstance(xobjects, pikepdf.Dictionary):
                try:
                    xobj = xobjects.get(str(operands[0]))
                except Exception:
                    continue
                if not isinstance(xobj, pikepdf.Stream):
                    continue
                try:
                    if str(xobj.get("/Subtype") or "") != "/Form":
                        continue
                    og = xobj.objgen
                    nested = xobj.get("/Resources")
                except Exception as exc:
                    unread.append({"page": page_no, "reason": str(exc)})
                    continue
                if og in seen:
                    continue
                seen.add(og)
                walk(xobj, nested if nested is not None else resources,
                     page_no, depth + 1, seen)

    for i, page in enumerate(pdf.pages):
        page_no = i + 1
        try:
            resources = page.resources
        except Exception:
            try:
                resources = page.obj.get("/Resources")
            except Exception as exc:
                unread.append({"page": page_no, "reason": str(exc)})
                continue
        walk(page, resources, page_no, 0, set())
        # An appearance stream renders too: the glyphs in a widget's `/AP /N`
        # are on the page as much as the ones in its content stream.
        try:
            entries = list(page.obj.get("/Annots") or [])
        except Exception:
            entries = []
        for annot in entries:
            if not isinstance(annot, pikepdf.Dictionary):
                continue
            try:
                normal = (annot.get("/AP") or {}).get("/N")
            except Exception:
                continue
            streams = []
            if isinstance(normal, pikepdf.Stream):
                streams = [normal]
            elif isinstance(normal, pikepdf.Dictionary):
                try:
                    streams = [s for s in normal.values() if isinstance(s, pikepdf.Stream)]
                except Exception:
                    streams = []
            for stream in streams:
                try:
                    nested = stream.get("/Resources")
                except Exception:
                    nested = None
                walk(stream, nested, page_no, 1, set())
    return out, unread


def _descriptor_of(font_obj):
    """(the font descriptor, the font's `/Subtype`, the descendant CIDFont).

    A composite font carries neither its descriptor nor its program: both hang
    off the descendant CIDFont (ISO 32000-2 9.7.4), so the two cases are
    resolved here once instead of at every reader.
    """
    try:
        subtype = str(font_obj.get("/Subtype") or "")
    except Exception:
        return None, "", None
    if subtype != "/Type0":
        try:
            return font_obj.get("/FontDescriptor"), subtype, None
        except Exception:
            return None, subtype, None
    try:
        descendants = font_obj.get("/DescendantFonts")
        descendant = descendants[0] if descendants is not None and len(descendants) else None
    except Exception:
        descendant = None
    if not isinstance(descendant, pikepdf.Dictionary):
        return None, subtype, None
    try:
        return descendant.get("/FontDescriptor"), subtype, descendant
    except Exception:
        return None, subtype, descendant


def _is_embedded(descriptor) -> bool:
    if not isinstance(descriptor, pikepdf.Dictionary):
        return False
    for key in _FONT_PROGRAM_KEYS:
        try:
            if descriptor.get(key) is not None:
                return True
        except Exception:
            continue
    return False


def _base_font(font_obj) -> str:
    try:
        return str(font_obj.get("/BaseFont") or "").lstrip("/")
    except Exception:
        return ""


def _check_font_embedding(check, rendered, unread):
    """ISO 14289-1 cl. 7.21.4.1: the font programs for all fonts used for
    rendering shall be embedded, and NOTE 5 states there is no exemption for
    the 14 standard Type 1 fonts. A substituted face draws different glyphs at
    different widths, which is exactly what cl. 7.21.1 says the whole subclause
    exists to prevent.

    Type 3 fonts are not counted. Their glyphs ARE content streams inside the
    font dictionary (ISO 32000-2 9.6.5), so there is no font program to embed
    and no substitution to guard against.

    SCOPED OUT, and named: cl. 7.21.4.1's further requirement that an embedded
    font "define all glyphs referenced for rendering" is not answered here —
    deciding it means resolving every code the file draws through its encoding
    into the program's glyph set, which is `unicode_mapping`'s machinery
    pointed at a different question and is not attempted under this row.
    """
    counted = 0
    findings = []
    for font_obj in rendered.values():
        descriptor, subtype, _descendant = _descriptor_of(font_obj)
        if subtype == "/Type3":
            continue
        counted += 1
        if _is_embedded(descriptor):
            continue
        findings.append(
            _finding(
                _object_address(),
                "font_not_embedded",
                preview=_base_font(font_obj),
                values={"font": _base_font(font_obj)},
            )
        )
    _verdict(check, counted, findings)
    _also_review(check, _font_gaps(unread))


def _font_gaps(unread: list) -> list:
    """A stream the font walk could not parse, as findings. A gap the walk
    could attribute to a page names it; one it could not is a key of its own
    rather than a sentence rendering an uninterpolated page number."""
    out = []
    for gap in unread:
        page = gap.get("page") if isinstance(gap, dict) else None
        if page is None:
            out.append(_finding(_object_address(), "fonts_unreadable"))
            continue
        out.append(
            _finding(_object_address(page=page), "page_unreadable",
                     values={"page": page})
        )
    return out


def _cmap_subtables(descriptor) -> tuple:
    """The (platform id, encoding id) pairs of the embedded TrueType program's
    `cmap` table, and whether the program could be read at all."""
    if not isinstance(descriptor, pikepdf.Dictionary):
        return [], False
    try:
        program = descriptor.get("/FontFile2")
    except Exception:
        return [], False
    if program is None:
        return [], False
    try:
        from io import BytesIO

        from fontTools.ttLib import TTFont

        face = TTFont(BytesIO(program.read_bytes()), fontNumber=0, lazy=True)
        return [(int(st.platformID), int(st.platEncID)) for st in face["cmap"].tables], True
    except Exception:
        return [], False


def _differences_names(encoding) -> list:
    """The glyph names a `/Differences` array assigns, in order. The integers
    interleaved with them are the codes they start at, not names."""
    if not isinstance(encoding, pikepdf.Dictionary):
        return []
    try:
        differences = encoding.get("/Differences")
        items = list(differences) if differences is not None else []
    except Exception:
        return []
    out = []
    for item in items:
        if isinstance(item, pikepdf.Name):
            out.append(str(item).lstrip("/"))
    return out


def _check_font_encodings(check, rendered, unread):
    """ISO 14289-1 cl. 7.21.6, the TrueType half, for fonts used for rendering.

    Four requirements, each decidable from the file:

    — a symbolic TrueType font shall not carry an `/Encoding` entry in the font
      dictionary, and its program's `cmap` shall either hold exactly one
      encoding or hold at least the Microsoft Symbol (3,0) one;
    — a non-symbolic TrueType font shall name MacRomanEncoding or
      WinAnsiEncoding, as `/Encoding` or as the `/BaseEncoding` inside it;
    — a non-symbolic TrueType font shall not define a `/Differences` array
      unless every glyph name in it is listed in the Adobe Glyph List AND the
      program's `cmap` holds at least the Microsoft Unicode (3,1) encoding;
    — the program of a non-symbolic TrueType font shall contain non-symbolic
      `cmap` entries.

    SCOPED OUT, and named: the clause qualifies that last one with "such that
    all necessary glyph lookups can be carried out", and the closing sentence
    requires that character codes "be able to be mapped to glyphs … without the
    use of a non-standard mapping chosen by the conforming reader". Both are
    statements about the codes THIS file draws, resolved one at a time through
    the encoding into the program — a per-code resolution this check does not
    perform. Presence of a non-symbolic subtable is the mechanical half and is
    all that is claimed here.

    A font whose program will not read contributes a gap, not a verdict: a
    `cmap` nobody could parse is not a `cmap` that is wrong.
    """
    counted = 0
    findings = []
    gaps = []
    for font_obj in rendered.values():
        descriptor, subtype, _descendant = _descriptor_of(font_obj)
        if subtype != "/TrueType":
            continue
        counted += 1
        name = _base_font(font_obj)
        try:
            flags = int(descriptor.get("/Flags") or 0) if descriptor is not None else 0
        except Exception:
            flags = 0
        symbolic = bool(flags & _FLAG_SYMBOLIC) and not (flags & _FLAG_NONSYMBOLIC)
        try:
            encoding = font_obj.get("/Encoding")
        except Exception:
            encoding = None
        subtables, program_read = _cmap_subtables(descriptor)
        if symbolic:
            if encoding is not None:
                findings.append(
                    _finding(_object_address(), "symbolic_truetype_has_encoding",
                             preview=name, values={"font": name})
                )
            if not program_read:
                if _is_embedded(descriptor):
                    gaps.append(
                        _finding(_object_address(), "font_program_cmap_unreadable",
                                 preview=name, values={"font": name})
                    )
                continue
            if len(subtables) != 1 and (3, 0) not in subtables:
                findings.append(
                    _finding(_object_address(), "symbolic_truetype_cmap_ambiguous",
                             preview=name, values={"font": name})
                )
            continue
        base = ""
        if isinstance(encoding, pikepdf.Name):
            base = str(encoding)
        elif isinstance(encoding, pikepdf.Dictionary):
            try:
                raw = encoding.get("/BaseEncoding")
            except Exception:
                raw = None
            base = str(raw) if raw is not None else ""
        if base not in _TRUETYPE_ENCODINGS:
            findings.append(
                _finding(_object_address(), "nonsymbolic_truetype_bad_encoding",
                         preview=name, values={"font": name})
            )
        if not program_read:
            if _is_embedded(descriptor):
                gaps.append(
                    _finding(_object_address(), "font_program_cmap_unreadable",
                             preview=name, values={"font": name})
                )
            continue
        if not [pair for pair in subtables if pair != (3, 0)]:
            findings.append(
                _finding(_object_address(), "nonsymbolic_truetype_no_cmap",
                         preview=name, values={"font": name})
            )
        names = _differences_names(encoding)
        if names:
            from fontTools.agl import AGL2UV

            unlisted = sorted({g for g in names if g not in AGL2UV})
            if unlisted:
                findings.append(
                    _finding(_object_address(), "nonsymbolic_truetype_unlisted_glyph_name",
                             preview=unlisted[0],
                             values={"font": name, "glyph": unlisted[0]})
                )
            if (3, 1) not in subtables:
                findings.append(
                    _finding(_object_address(),
                             "nonsymbolic_truetype_differences_no_unicode_cmap",
                             preview=name, values={"font": name})
                )
    _verdict(check, counted, findings)
    _also_review(check, gaps + _font_gaps(unread))


def _check_cid_to_gid_map(check, pdf):
    """ISO 14289-1 cl. 7.21.3.2 makes normative what ISO 32000-1 Table 117
    requires: every embedded Type 2 CIDFont shall carry a `/CIDToGIDMap` entry
    that is either a stream mapping CIDs to glyph indices or the name
    `/Identity`.

    Without it there is no statement of which glyph a CID selects, so the same
    file renders differently depending on what the reader assumes — the exact
    outcome cl. 7.21.1 says the font requirements exist to prevent. The check
    is document-wide rather than restricted to rendered fonts: the clause
    governs embedded CIDFonts, not drawn ones.
    """
    fonts, unread = _typed_dictionaries(pdf, "/Font")
    counted = 0
    findings = []
    for font_obj in fonts:
        descriptor, subtype, descendant = _descriptor_of(font_obj)
        if subtype != "/Type0" or not isinstance(descendant, pikepdf.Dictionary):
            continue
        try:
            if str(descendant.get("/Subtype") or "") != "/CIDFontType2":
                continue
        except Exception as exc:
            unread.append(str(exc))
            continue
        if not _is_embedded(descriptor):
            continue
        counted += 1
        try:
            mapping = descendant.get("/CIDToGIDMap")
        except Exception as exc:
            unread.append(str(exc))
            continue
        if isinstance(mapping, pikepdf.Stream):
            continue
        if isinstance(mapping, pikepdf.Name) and str(mapping) == "/Identity":
            continue
        name = _base_font(font_obj)
        findings.append(
            _finding(_object_address(), "cid_font_no_cid_to_gid_map",
                     preview=name, values={"font": name})
        )
    if counted == 0 and not unread:
        check.status = NA
        return
    _verdict(check, counted, findings)
    _also_review(
        check, [_finding(_object_address(), "fonts_unreadable") for _ in unread]
    )


# ── optional content, embedded files, forms (cl. 7.10, 7.11, 7.14, 7.15) ──


def _check_optional_content_config(check, pdf):
    """ISO 14289-1 cl. 7.10, both of its sentences.

    `/Name` is required in EVERY optional content configuration dictionary,
    the default one included, but only when the catalog's `/OCProperties`
    carries a `/Configs` entry holding at least one configuration — the
    condition the clause states, and the reason a document with only a default
    configuration is not failed for the missing name.

    `/AS` shall not appear in ANY configuration dictionary, unconditionally.
    ISO 14289-1's NOTE 1 gives the reason: `/AS` is what lets a reader adjust
    optional content state automatically from usage information, and a state
    the document did not choose is a page whose content nobody can predict.
    """
    try:
        properties = pdf.Root.get("/OCProperties")
    except Exception:
        properties = None
    if not isinstance(properties, pikepdf.Dictionary):
        check.status = NA
        return
    unread = []
    try:
        default = properties.get("/D")
        raw_configs = properties.get("/Configs")
        configs = [c for c in list(raw_configs)] if raw_configs is not None else []
    except Exception as exc:
        check.status = REVIEW
        check.findings = [_finding(_object_address(), "optional_content_unreadable",
                                   values={"reason": str(exc)})]
        return
    listed = [c for c in configs if isinstance(c, pikepdf.Dictionary)]
    unread += [c for c in configs if not isinstance(c, pikepdf.Dictionary)]
    every = ([default] if isinstance(default, pikepdf.Dictionary) else []) + listed
    if not every:
        check.status = NA
        return
    name_required = bool(listed)
    findings = []
    for config in every:
        try:
            has_as = config.get("/AS") is not None
            title = str(config.get("/Name") or "").strip()
        except Exception as exc:
            unread.append(exc)
            continue
        if name_required and not title:
            findings.append(_finding(_object_address(), "oc_config_no_name"))
        if has_as:
            findings.append(_finding(_object_address(), "oc_config_has_as"))
    _verdict(check, len(every), findings)
    _also_review(
        check,
        [
            _finding(_object_address(), "optional_content_unreadable",
                     values={"reason": "a configuration entry is not a dictionary"})
            for _ in unread
        ],
    )


def _check_embedded_file_names(check, pdf):
    """ISO 14289-1 cl. 7.11: the file specification dictionary for an embedded
    file shall contain the `/F` and `/UF` keys. Cl. 7.18.7 extends the same
    requirement to file attachment annotations.

    `/F` is the name in the system's own encoding and `/UF` the Unicode one;
    between them they are the only thing that tells anybody what an attachment
    IS before opening it. Only specifications carrying `/EF` are counted — a
    file specification with no embedded file stream names something outside
    the document, which is not what this clause governs.

    SCOPED OUT, and named: the same sentence adds that the dictionary SHOULD
    contain `/Desc`. That is a recommendation, not a requirement, and it is not
    reported here — a missing `/Desc` would have to warn rather than fail, and
    folding a `should` into a `shall` row would make one verdict answer two
    different kinds of question.
    """
    specs, unread = _typed_dictionaries(pdf, "/Filespec")
    counted = 0
    findings = []
    for spec in specs:
        try:
            if spec.get("/EF") is None:
                continue
            has_f = spec.get("/F") is not None
            has_uf = spec.get("/UF") is not None
        except Exception as exc:
            unread.append(str(exc))
            continue
        counted += 1
        if not has_f:
            findings.append(_finding(_object_address(), "embedded_file_no_f"))
        if not has_uf:
            findings.append(_finding(_object_address(), "embedded_file_no_uf"))
    if counted == 0 and not unread:
        check.status = NA
        return
    _verdict(check, counted, findings)
    _also_review(
        check,
        [_finding(_object_address(), "embedded_files_unreadable") for _ in unread],
    )


def _check_print_field_attributes(check, tree):
    """ISO 14289-1 cl. 7.14: non-interactive forms shall be tagged using the
    PrintField attributes of ISO 32000-1 14.8.5.6.

    SCOPED, and the scope is the point. Whether a region of a page IS a
    non-interactive form — a printed box someone fills in with a pen, a ruled
    line above a caption, a row of boxes for one character each — is a
    judgement about what the drawn content MEANS. No fact in the file decides
    it, so a checker that guessed would manufacture failures on every ruled
    table in every document.

    What IS decidable is the case the document itself has already declared: an
    element the file tags `Form` that reaches no annotation. A `Form` tag exists
    to hold a widget (cl. 7.18.4); one holding none is the document saying
    "form" about content that has no interactive control, which is the shape a
    non-interactive form takes. Those elements are reported for review when
    they carry no PrintField attribute owner, and pass when they do. Content
    the document never tagged `Form` at all is outside what this can see, and
    is not claimed either way.
    """
    if not tree["tagged"]:
        check.status = NA
        return
    candidates = [
        node for node in tree["nodes"]
        if node.role == _FORM_ROLE and not node.objrs
    ]
    if not candidates:
        check.status = NA
        return
    findings = [
        _finding(_struct_address(node), "print_field_attributes_missing",
                 preview=node.tag, values={"tag": node.tag})
        for node in candidates
        if "/PrintField" not in node.attr_owners
    ]
    _verdict(check, len(candidates), findings, dirty=REVIEW)


# ISO 14289-1 cl. 7.15 names the element and the value verbatim; the packet is
# XML, so the element is matched on its local name and any namespace it was
# authored in.
_DYNAMIC_RENDER = "dynamicRender"
_DYNAMIC_REQUIRED = "required"


def _xfa_packets(xfa) -> list:
    """The XFA packet streams, from either spelling of `/XFA`: a single stream
    holding the whole XDP, or an array alternating packet names with the
    streams that hold them."""
    if isinstance(xfa, pikepdf.Stream):
        return [xfa]
    if not isinstance(xfa, pikepdf.Array):
        return []
    try:
        return [item for item in xfa if isinstance(item, pikepdf.Stream)]
    except Exception:
        return []


def _check_dynamic_xfa(check, pdf):
    """ISO 14289-1 cl. 7.15: an `/XFA` key in `/AcroForm` whose value is an
    array or a stream makes the file an XFA-based form. Static XFA forms may be
    used; DYNAMIC XFA forms shall not be.

    The clause states the test itself: a conforming reader locates the
    `dynamicRender` element and compares its value to "required"; equal means
    dynamic. The NOTE gives its position — a child of `acrobat7`, inside
    `acrobat`, inside `config`, inside the root `xdp` element. That is a fact
    in the packet, so this check decides it rather than reviewing it.

    The packets are parsed as XML, not scanned as bytes: `dynamicRender`
    appearing inside a comment, an attribute or a CDATA section is not the
    element the clause names, and a reader that matched text would call a
    static form dynamic. A packet that will not parse is a gap — but a packet
    that DID parse and said "required" is a failure that stands, because the
    file has already answered.
    """
    try:
        acroform = pdf.Root.get("/AcroForm")
        xfa = acroform.get("/XFA") if isinstance(acroform, pikepdf.Dictionary) else None
    except Exception:
        xfa = None
    if not isinstance(xfa, (pikepdf.Array, pikepdf.Stream)):
        check.status = NA
        return
    check.counted = 1
    packets = _xfa_packets(xfa)
    dynamic = False
    gaps = []
    for packet in packets:
        try:
            root = ElementTree.fromstring(packet.read_bytes())
        except Exception:
            gaps.append(_finding(_object_address(), "xfa_packet_unreadable"))
            continue
        for element in root.iter():
            tag = str(element.tag)
            if tag.rsplit("}", 1)[-1] != _DYNAMIC_RENDER:
                continue
            if (element.text or "").strip() == _DYNAMIC_REQUIRED:
                dynamic = True
    if not packets:
        gaps.append(_finding(_object_address(), "xfa_packet_unreadable"))
    check.status = FAIL if dynamic else PASS
    if dynamic:
        check.findings = [_finding(_object_address(), "dynamic_xfa_form")]
    _also_review(check, gaps)


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
    "role_map": (
        "Every tag resolves to a standard type",
        "A private tag name means nothing to a reader unless the role map translates it.",
    ),
    "suspects": (
        "The document does not disclaim its own tagging",
        "The suspects flag tells readers the structure may not match the content.",
    ),
    "optional_content_config": (
        "Optional content configurations are named, and set no automatic state",
        "A configuration with no name, or one that adjusts itself, hides content unpredictably.",
    ),
    "embedded_file_names": (
        "Attached files carry both of their names",
        "An attachment with no file name tells nobody what it is before they open it.",
    ),
    "trapnet_annotations": (
        "No trapping annotations are present",
        "Trap networks describe a printing press, not anything a reader can reach.",
    ),
    "link_ismap": (
        "Links do not depend on a server-side image map",
        "A link that sends a click coordinate cannot be used by anyone who cannot point.",
    ),
    "media_clip_data": (
        "Media clips state their type and their alternate text",
        "A clip with no content type and no alternate text can only be played, never described.",
    ),
    "reference_xobjects": (
        "No page imports its content from another file",
        "Content that lives in another file is content this document cannot describe.",
    ),
    "font_embedding": (
        "Every font that draws text is embedded",
        "A substituted face draws different shapes at different widths than the file intends.",
    ),
    "font_encodings": (
        "TrueType fonts use encodings a reader can follow",
        "A font whose encoding rules are not met leaves the reader guessing which glyph is meant.",
    ),
    "cid_to_gid_map": (
        "Composite fonts say which glyph each identifier selects",
        "Without that mapping the same file renders differently in different readers.",
    ),
    "print_field_attributes": (
        "Printed form fields are tagged as form fields",
        "A box drawn for a pen is announced as a box unless PrintField attributes say otherwise.",
    ),
    "dynamic_xfa": (
        "The document is not a dynamic XFA form",
        "A dynamic form builds its own pages, so the tagged content is not what is shown.",
    ),
    "untagged_graphics": (
        "All page graphics are tagged or declared decoration",
        "A fill, image or shading outside every marked sequence is reached by nobody.",
    ),
    "artifact_judgement": (
        "Decoration and content are told apart",
        "Text declared decoration that continues a sentence needs a person to look.",
    ),
    "content_grouping": (
        "Content is grouped as it reads",
        "One paragraph split in two, or two joined into one, changes what is announced.",
    ),
    "content_order": (
        "Order holds inside columns and sequences",
        "Columns and the order within one tag are what a page-wide sort cannot see.",
    ),
    "unicode_mapping": (
        "Characters map to the right text",
        "A font whose own glyph table contradicts its character map spells words wrong.",
    ),
    "list_numbering": (
        "List numbering matches the labels",
        "A numbered list announced as bullets loses the count the labels show.",
    ),
    "list_item_structure": (
        "List items hold a label and a body",
        "An item holding anything else has put its body where no reader looks for it.",
    ),
    "list_semantics": (
        "Lists are tagged as lists",
        "Labelled paragraphs, and one list tagged as two, each need a person to look.",
    ),
    "heading_tag_mixing": (
        "One heading convention, not two",
        "Numbered and unnumbered heading tags together give the outline two answers.",
    ),
    "heading_semantics": (
        "Headings are the text that reads as headings",
        "Size is a signal and not a semantic, so each candidate needs a person to look.",
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
    nothing does, so the answer to "is this document accessible" is 55 checks
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
        cropboxes = _cropboxes(pdf)
        rendered, font_unread = read(lambda: _rendered_fonts(pdf))
        if not isinstance(rendered, dict):
            rendered = {}

        run = {
            "permissions": lambda c: _check_permissions(c, pdf),
            "image_only": lambda c: _check_image_only(c, pdf, pages, file),
            "tagged": lambda c: _check_tagged(c, pdf, tree),
            "role_map": lambda c: _check_role_map(c, tree),
            "suspects": lambda c: _check_suspects(c, pdf),
            "structure_nesting": lambda c: _check_structure_nesting(c, tree),
            "reading_order": lambda c: _check_reading_order(c, tree, pages, mcid_tables),
            "lang": lambda c: _check_lang(c, pdf, tree, pages),
            "title": lambda c: _check_title(c, pdf),
            "bookmarks": lambda c: _check_bookmarks(c, pdf, tree),
            "contrast": lambda c: _check_contrast(c, pages),
            "optional_content_config": lambda c: _check_optional_content_config(c, pdf),
            "embedded_file_names": lambda c: _check_embedded_file_names(c, pdf),
            "tagged_content": lambda c: _check_tagged_content(c, tree, pages),
            "untagged_graphics": lambda c: _check_untagged_graphics(c, pdf, tree),
            "artifact_judgement": lambda c: _check_artifact_judgement(c, pdf, tree, pages, mcid_tables),
            "content_grouping": lambda c: _check_content_grouping(c, tree, pages, mcid_tables),
            "content_order": lambda c: _check_content_order(c, tree, pages, mcid_tables),
            "tagged_annotations": lambda c: _check_tagged_annotations(c, tree, annots, cropboxes),
            "tab_order": lambda c: _check_tab_order(c, pdf, annots, cropboxes),
            "character_encoding": lambda c: _check_character_encoding(c, pages),
            "unicode_mapping": lambda c: _check_unicode_mapping(c, pdf),
            "tagged_multimedia": lambda c: _check_tagged_multimedia(c, tree, annots),
            "screen_flicker": lambda c: _check_screen_flicker(c, sites),
            "scripts": lambda c: _check_scripts(c, sites),
            "timed_responses": lambda c: _check_timed_responses(c, sites),
            "navigation_links": lambda c: _check_navigation_links(c, annots, pages),
            "trapnet_annotations": lambda c: _check_trapnet_annotations(c, annots),
            "link_ismap": lambda c: _check_link_ismap(c, annots),
            "media_clip_data": lambda c: _check_media_clip_data(c, pdf),
            "reference_xobjects": lambda c: _check_reference_xobjects(c, pdf),
            "font_embedding": lambda c: _check_font_embedding(c, rendered, font_unread),
            "font_encodings": lambda c: _check_font_encodings(c, rendered, font_unread),
            "cid_to_gid_map": lambda c: _check_cid_to_gid_map(c, pdf),
            "tagged_form_fields": lambda c: _check_tagged_form_fields(c, tree, annots, fields),
            "field_descriptions": lambda c: _check_field_descriptions(c, tree, annots, fields),
            "print_field_attributes": lambda c: _check_print_field_attributes(c, tree),
            "dynamic_xfa": lambda c: _check_dynamic_xfa(c, pdf),
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
            "list_numbering": lambda c: _check_list_numbering(c, tree, mcid_tables),
            "list_item_structure": lambda c: _check_list_item_structure(c, tree, mcid_tables),
            "list_semantics": lambda c: _check_list_semantics(c, tree, pages, mcid_tables),
            "heading_nesting": lambda c: _check_heading_nesting(c, tree, mcid_tables),
            "heading_tag_mixing": lambda c: _check_heading_tag_mixing(c, tree, mcid_tables),
            "heading_semantics": lambda c: _check_heading_semantics(c, tree, pages, mcid_tables),
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
        # same 56 rows in the same order, each carrying the English name and
        # sentence a caller with no catalog of its own renders (the CLI, and
        # the panel until it reads `categories`).
        "checks": [_with_english(c.to_json()) for c in ordered],
    }
