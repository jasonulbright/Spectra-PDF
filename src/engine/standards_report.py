"""What a standards conversion changed, per document.

Ghostscript reaches PDF/A and PDF/X conformance partly by DELETING content it
cannot make conformant, and it is a producer rather than a validator: nothing
it emits certifies that its output conforms to the standard. Two facts shape
this module.

Its diagnostics are NECESSARY. A conversion that abandons the standard says so
in one line on stderr and nowhere else — the file it writes can still carry a
conformance key, because that key is written by the caller's own preamble and
the producer's retreat does not remove it. Suppressing or discarding that line
leaves a false claim as the only surviving evidence.

Its diagnostics are NOT SUFFICIENT. The sharpest alterations carry no message
at all: a page whose transparency cannot be represented at the requested
conformance level is rasterized whole, so every glyph on it stops being text,
and the producer reports nothing. An interactive form loses every field and
its registration with no message either.

So a report is built from both halves — the captured diagnostics and a
structural comparison of the two documents — and ``altered`` is empty only
when every check ran and every check found nothing. A check that could not run
leaves a row carrying ``undetermined``, which no caller can read as clean.
Producer text that matches no known shape is carried verbatim rather than
dropped, so a producer upgrade that rewords a message degrades to "here is
what it said" instead of to silence.
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

import pikepdf

#: Per-row detail entries kept; a row past this reports `detail_truncated`.
DETAIL_CAP = 50

#: Verbatim producer lines kept; the list reports `notices_truncated` past it.
NOTICE_CAP = 200

#: Nesting depth for the Form XObject walk the image census performs.
_MAX_FORM_DEPTH = 12

_TEXT_SHOWING = frozenset({"Tj", "TJ", "'", '"'})
_PATH_PAINTING = frozenset({"S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "sh"})

_BANNER = re.compile(r"^GPL Ghostscript [\d.]+ \(")
_PAGE_PROGRESS = re.compile(r"^Page \d+$")
_PROGRESS_PREFIXES = (
    "Copyright (C) ",
    "This software is supplied under",
    "see the file COPYING",
    "Processing pages ",
)

_SUBSTITUTE_MARK = " (or substitute) from "

#: Producer text → alteration kind, most severe first. The retreat marker must
#: be tested before the removal marker: one notice carries both, and a
#: conversion that abandoned the standard is not merely one dropped feature.
_NOTICE_KINDS = (
    ("reverting to normal PDF output", "conformance_abandoned"),
    ("aborting conversion", "conformance_abandoned"),
    ("not permitted in PDF/", "producer_removed_feature"),
    ("has not validated this embedded file", "embedded_file_unvalidated"),
)


# ── the structural census ─────────────────────────────────────────────────


class _Facts:
    """Named facts about one document, each either read or unreadable.

    A fact that raised is absent from `values` and present in `reasons`, so a
    comparison against it yields `undetermined` instead of a false verdict.
    """

    def __init__(self) -> None:
        self.values: dict = {}
        self.reasons: dict = {}

    def probe(self, name: str, fn) -> None:
        try:
            self.values[name] = fn()
        except Exception as exc:  # noqa: BLE001 — the failure IS the report
            self.reasons[name] = f"{type(exc).__name__}: {exc}"

    def unreadable(self, names, reason: str) -> None:
        for name in names:
            self.reasons[name] = reason


FACT_NAMES = (
    "pages",
    "annotations",
    "form_fields",
    "attachments",
    "document_scripts",
    "optional_content",
    "tagged_structure",
    "outline",
    "encryption",
    "page_marks",
    "images",
)


def _annotation_census(pdf) -> Counter:
    seen: Counter = Counter()
    for page in pdf.pages:
        for annot in page.get("/Annots", []) or []:
            seen[str(annot.get("/Subtype", "/Unknown")).lstrip("/")] += 1
    return seen


def _field_count(pdf) -> int:
    acroform = pdf.Root.get("/AcroForm")
    if not isinstance(acroform, pikepdf.Dictionary):
        return 0
    return len(acroform.get("/Fields", []) or [])


def _attachment_names(pdf) -> list:
    names = pdf.Root.get("/Names")
    if not isinstance(names, pikepdf.Dictionary):
        return []
    tree = names.get("/EmbeddedFiles")
    if not isinstance(tree, pikepdf.Dictionary):
        return []
    found: list = []
    stack = [tree]
    depth = 0
    while stack and depth < 4096:
        depth += 1
        node = stack.pop()
        if not isinstance(node, pikepdf.Dictionary):
            continue
        entries = node.get("/Names", []) or []
        for i in range(0, len(entries) - 1, 2):
            found.append(str(entries[i]))
        stack.extend(node.get("/Kids", []) or [])
    return sorted(found)


def _has_document_scripts(pdf) -> bool:
    names = pdf.Root.get("/Names")
    if isinstance(names, pikepdf.Dictionary) and "/JavaScript" in names:
        return True
    action = pdf.Root.get("/OpenAction")
    if isinstance(action, pikepdf.Dictionary):
        return str(action.get("/S", "")) == "/JavaScript"
    return False


def _tagging(pdf) -> dict:
    root = pdf.Root
    return {
        "struct_tree": "/StructTreeRoot" in root,
        "mark_info": "/MarkInfo" in root,
        "lang": str(root.get("/Lang", "")),
    }


def _outline_present(pdf) -> bool:
    outlines = pdf.Root.get("/Outlines")
    return isinstance(outlines, pikepdf.Dictionary) and "/First" in outlines


def _marks_of(stream_owner, resources, visited: set, depth: int) -> set:
    """Which kinds of mark a content stream paints: text, vector, image.

    The kinds are what distinguishes a page from a picture OF that page. A
    conversion that cannot represent a page's transparency at the requested
    level rasterizes the whole page, and the tell is that everything the page
    used to paint has become a single image draw.
    """
    marks: set = set()
    if depth > _MAX_FORM_DEPTH:
        return marks
    xobjects = resources.get("/XObject") if isinstance(resources, pikepdf.Dictionary) else None
    for instruction in pikepdf.parse_content_stream(stream_owner):
        op = str(instruction.operator)
        if op in _TEXT_SHOWING:
            marks.add("text")
        elif op in _PATH_PAINTING:
            marks.add("vector")
        elif op == "INLINE IMAGE" or op == "BI":
            marks.add("image")
        elif op == "Do" and isinstance(xobjects, pikepdf.Dictionary):
            name = str(instruction.operands[0]) if instruction.operands else ""
            target = xobjects.get(name)
            if not isinstance(target, pikepdf.Stream):
                continue
            subtype = str(target.get("/Subtype", ""))
            if subtype == "/Image":
                marks.add("image")
            elif subtype == "/Form":
                key = getattr(target, "objgen", None)
                if key is not None and key != (0, 0):
                    if key in visited:
                        continue
                    visited.add(key)
                marks |= _marks_of(target, target.get("/Resources", resources),
                                   visited, depth + 1)
    return marks


def _page_marks(pdf) -> list:
    return [
        sorted(_marks_of(page, page.get("/Resources"), set(), 0))
        for page in pdf.pages
    ]


def _image_count(pdf) -> int:
    total = 0
    for page in pdf.pages:
        total += _images_in(page.get("/Resources"), set(), 0)
    return total


def _images_in(resources, visited: set, depth: int) -> int:
    if depth > _MAX_FORM_DEPTH or not isinstance(resources, pikepdf.Dictionary):
        return 0
    xobjects = resources.get("/XObject")
    if not isinstance(xobjects, pikepdf.Dictionary):
        return 0
    total = 0
    for xobj in xobjects.values():
        key = getattr(xobj, "objgen", None)
        if key is not None and key != (0, 0):
            if key in visited:
                continue
            visited.add(key)
        subtype = str(xobj.get("/Subtype", ""))
        if subtype == "/Image":
            total += 1
        elif subtype == "/Form":
            total += _images_in(xobj.get("/Resources"), visited, depth + 1)
    return total


def census(path: str | Path) -> _Facts:
    """Every structural fact the comparison needs, read from one document."""
    facts = _Facts()
    try:
        pdf = pikepdf.open(str(path))
    except Exception as exc:  # noqa: BLE001
        facts.unreadable(FACT_NAMES, f"{type(exc).__name__}: {exc}")
        return facts
    with pdf:
        facts.probe("pages", lambda: len(pdf.pages))
        facts.probe("annotations", lambda: _annotation_census(pdf))
        facts.probe("form_fields", lambda: _field_count(pdf))
        facts.probe("attachments", lambda: _attachment_names(pdf))
        facts.probe("document_scripts", lambda: _has_document_scripts(pdf))
        facts.probe("optional_content", lambda: "/OCProperties" in pdf.Root)
        facts.probe("tagged_structure", lambda: _tagging(pdf))
        facts.probe("outline", lambda: _outline_present(pdf))
        facts.probe("encryption", lambda: bool(pdf.is_encrypted))
        facts.probe("page_marks", lambda: _page_marks(pdf))
        facts.probe("images", lambda: _image_count(pdf))
    return facts


# ── the comparison ────────────────────────────────────────────────────────


def _row(kind: str, count: int, detail: list) -> dict:
    row = {"kind": kind, "count": int(count), "detail": list(detail)[:DETAIL_CAP]}
    if len(detail) > DETAIL_CAP:
        row["detail_truncated"] = True
    return row


def _undetermined(kind: str, reason: str) -> dict:
    return {"kind": kind, "count": 0, "detail": [], "undetermined": True,
            "reason": reason}


def _compare_annotations(before: Counter, after: Counter):
    lost = {k: before[k] - after.get(k, 0) for k in before if before[k] > after.get(k, 0)}
    if not lost:
        return None
    detail = [{"subtype": k, "removed": v} for k, v in sorted(lost.items())]
    return _row("annotations_removed", sum(lost.values()), detail)


def _compare_names(before: list, after: list):
    lost = [n for n in before if n not in set(after)]
    if not lost:
        return None
    return _row("attachments_removed", len(lost), [{"name": n} for n in lost])


def _compare_tagging(before: dict, after: dict):
    lost = []
    if before["struct_tree"] and not after["struct_tree"]:
        lost.append({"part": "structure tree"})
    if before["mark_info"] and not after["mark_info"]:
        lost.append({"part": "mark information"})
    if before["lang"] and not after["lang"]:
        lost.append({"part": "document language", "was": before["lang"]})
    if not lost:
        return None
    return _row("tagged_structure_removed", len(lost), lost)


def _compare_marks(before: list, after: list):
    """Pages whose text or vector art came back as nothing but a picture."""
    detail = []
    for i, was in enumerate(before):
        if i >= len(after):
            break
        if not ({"text", "vector"} & set(was)):
            continue
        if set(after[i]) <= {"image"} and after[i]:
            detail.append({"page": i + 1, "was": list(was)})
    if not detail:
        return None
    return _row("page_content_rasterized", len(detail), detail)


def colorants_lost(before: list, after: list):
    """The plates a colour conversion did not carry through, by name.

    A colorant is the one thing a colour conversion can destroy without
    removing a page, an annotation or an image: the marks stay, they simply
    print on process plates that a spot job does not run. Nothing in a
    producer's diagnostics says so, so the row is built from the two ink
    lists.
    """
    lost = [name for name in before if name not in set(after)]
    if not lost:
        return None
    return _row("colorants_removed", len(lost), [{"name": n} for n in lost])


def colorant_shadings_lost(colorants: list):
    """Gradients whose colorant space the producer could not carry.

    A shading in a colorant space that the destination cannot describe
    without a transform comes back as a picture of itself in process colour.
    The gradient still looks right and the plate is gone, which is why it is
    named here rather than left to the ink list alone: the colorant may still
    print elsewhere on the page.
    """
    names = sorted({str(n) for n in colorants})
    if not names:
        return None
    return _row("colorant_shadings_rasterized", len(names),
                [{"name": n} for n in names])


def compare(before: _Facts, after: _Facts) -> list:
    """One row per fact that changed for the worse, or could not be read.

    Only losses are reported. A conversion that adds an output intent or
    re-encodes an image to a permitted filter has done its job; a conversion
    that ends with fewer pages, fewer annotations, no form, no attachments, no
    tags, or a page whose text became a picture has changed the document.
    """
    rows: list = []
    for name in FACT_NAMES:
        if name in before.reasons or name in after.reasons:
            reason = before.reasons.get(name) or after.reasons.get(name, "")
            rows.append(_undetermined(name, reason))
            continue
        b, a = before.values[name], after.values[name]
        row = None
        if name == "pages" and a < b:
            row = _row("pages_removed", b - a, [{"before": b, "after": a}])
        elif name == "annotations":
            row = _compare_annotations(b, a)
        elif name == "form_fields" and a < b:
            row = _row("form_fields_removed", b - a, [{"before": b, "after": a}])
        elif name == "attachments":
            row = _compare_names(b, a)
        elif name == "document_scripts" and b and not a:
            row = _row("document_scripts_removed", 1, [])
        elif name == "optional_content" and b and not a:
            row = _row("optional_content_removed", 1, [])
        elif name == "tagged_structure":
            row = _compare_tagging(b, a)
        elif name == "outline" and b and not a:
            row = _row("outline_removed", 1, [])
        elif name == "encryption" and b and not a:
            row = _row("encryption_removed", 1, [])
        elif name == "page_marks":
            row = _compare_marks(b, a)
        elif name == "images" and a < b:
            row = _row("images_removed", b - a, [{"before": b, "after": a}])
        if row is not None:
            rows.append(row)
    return rows


# ── the producer's own diagnostics ────────────────────────────────────────


def notices(*streams: str) -> list:
    """Producer output split into logical notices, progress lines dropped.

    A notice can span lines: the continuation is indented, so a line starting
    with whitespace belongs to the notice above it rather than being its own.
    """
    joined: list = []
    for stream in streams:
        for raw in (stream or "").splitlines():
            if not raw.strip():
                continue
            if raw[:1].isspace() and joined:
                joined[-1] = f"{joined[-1].rstrip()} {raw.strip()}"
                continue
            joined.append(raw.rstrip())
    return [line for line in joined if not _is_progress(line)]


def _is_progress(line: str) -> bool:
    if _BANNER.match(line) or _PAGE_PROGRESS.match(line):
        return True
    return line.startswith(_PROGRESS_PREFIXES)


def _substitution(line: str):
    if _SUBSTITUTE_MARK not in line or not line.startswith("Loading font "):
        return None
    requested, _, source = line[len("Loading font "):].partition(_SUBSTITUTE_MARK)
    used = source.replace("\\", "/").rsplit("/", 1)[-1]
    return {"requested": requested.strip(), "used": used.strip()}


def classify(lines: list) -> tuple:
    """Alteration rows the producer named, and the lines nothing recognised."""
    substitutions: list = []
    by_kind: dict = {}
    unmatched: list = []
    for line in lines:
        sub = _substitution(line)
        if sub is not None:
            substitutions.append(sub)
            continue
        for marker, kind in _NOTICE_KINDS:
            if marker in line:
                by_kind.setdefault(kind, []).append({"message": line})
                break
        else:
            unmatched.append(line)
    rows: list = []
    if substitutions:
        rows.append(_row("fonts_substituted", len(substitutions), substitutions))
    for kind in dict.fromkeys(kind for _, kind in _NOTICE_KINDS):
        detail = by_kind.get(kind)
        if detail:
            rows.append(_row(kind, len(detail), detail))
    return rows, unmatched


# ── the report ────────────────────────────────────────────────────────────


def build(source: _Facts, produced: str | Path, *streams: str) -> dict:
    """The alteration report for one conversion.

    ``source`` is a census taken BEFORE the conversion ran: an in-place
    conversion has one path for both documents, so a census deferred until
    afterwards would compare the result against itself.

    ``altered`` is empty only when every check ran and found nothing, so a
    caller may read an empty list as "nothing was lost" and nothing else can
    produce one.
    """
    rows = compare(source, census(produced))
    lines = notices(*streams)
    named, unmatched = classify(lines)
    report = {"altered": rows + named, "producer_notices": unmatched[:NOTICE_CAP]}
    if len(unmatched) > NOTICE_CAP:
        report["notices_truncated"] = True
    return report


def abandoned(report: dict) -> bool:
    """The producer said it stopped producing a conformant file."""
    return any(row["kind"] == "conformance_abandoned" for row in report["altered"])


def declared_pdfa(path: str | Path) -> str:
    """The PDF/A level the file itself declares, as ``PDF/A-2B``, or ``""``.

    This reads the document's own assertion. It is not a conformance check and
    a file that declares a level may still fail validation against it.
    """
    try:
        with pikepdf.open(str(path)) as pdf:
            with pdf.open_metadata() as meta:
                part = str(meta.get("pdfaid:part", "")).strip()
                conformance = str(meta.get("pdfaid:conformance", "")).strip()
    except Exception:  # noqa: BLE001
        return ""
    if not part:
        return ""
    return f"PDF/A-{part}{conformance.upper()}"
