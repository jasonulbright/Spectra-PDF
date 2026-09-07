"""Read-only health facts about one document, for the health ledger.

Observability only: nothing here writes, and the document is never saved.
Every fact is something a boundary REPORTED — a qpdf warning raised while the
file was being opened, or a traversal here that would not read — never an
inference from how a page happens to look.

Two boundaries answer, and a fact says which one it came from:

``qpdf``
    ``Pdf.get_warnings()`` — the recovery record for the open that just
    happened. qpdf emits no codes, only English sentences, so they are
    classified HERE (at the engine, in English) into stable codes; the raw
    sentence never reaches the UI, because it carries the working-copy path.

``engine``
    The traversals this repo already owns: the font walk
    (``font_inventory.walk_document_fonts`` plus ``font_embedding
    .font_embedded``, the same pair ``check.py`` uses, so the two cannot
    disagree about which fonts a document reaches), the page dictionaries, and
    the content and image streams.

A fact carries a stable ``code`` and a ``params`` mapping; the renderer owns
the sentence. ``kind`` sorts a fact into the classes the ledger groups by, and
``undetermined`` is one of them: a font whose embedding will not read, a
resource branch that will not parse, or a traversal that stopped at its own
bound, is never folded into a clean answer.

NO EXCEPTION TEXT LEAVES THIS MODULE. A pikepdf message names the working
copy's path and the byte offset of the object it failed on, and both would
cross the IPC boundary inside a fact. ``_error_params`` is the one route from
an exception to fact parameters: it transmits a stable category plus a digest
of the scrubbed sentence — enough to tell two different failures apart, never
enough to reconstruct either.

The op has two spellings of one traversal. ``document_health`` runs it whole;
``document_health_begin`` / ``_step`` / ``_end`` run it against a run token, a
bounded step at a time, so a caller that no longer wants a run can drop it at a
step boundary. Both drive the same code, so they cannot report a document
differently.

A STEP is bounded by items, decoded bytes and time, and it suspends where it
stands — mid-page if need be, because the traversal's position is data the run
holds rather than an interpreter stack. Reaching a step's bound is not a
finding; it is the next step's starting point. Reaching the RUN's bound IS a
finding (``document.inspectionBudget``): the document cost more than this
process spends on an observation nobody asked for, and what was not inspected
is reported as not inspected.

The bound of LAST resort is not here. One ``pikepdf.open`` of a damaged file,
or one enormous stream's decode, can cost more than any check written inside
this process can interrupt, so the op runs in a worker process the app can
kill (``src-tauri/src/health_engine.rs``). These budgets keep an ordinary
document's steps short; that deadline is what holds over a hostile one.
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import time
from collections import OrderedDict, deque
from pathlib import Path

import pikepdf

from engine import xfa
from engine.font_embedding import font_embedded
from engine.font_inventory import walk_document_fonts

_IMAGE_SUBTYPE = "/Image"

# An image stream is decoded through qpdf's GENERALIZED level: every general
# filter (Flate, LZW, RunLength, ASCII) is applied, so a stream whose filter
# chain is broken or unknown raises here instead of reading back as intact raw
# bytes. Specialized PIXEL codecs are not applied at that level and are not
# applied anywhere in this process, so whether their pixels decode is NOT
# determined here; that is reported as its own fact rather than folded into a
# clean answer.
_SPECIALIZED_FILTERS = frozenset(
    {"/DCTDecode", "/JPXDecode", "/JBIG2Decode", "/CCITTFaxDecode"}
)

# A resource graph can be cyclic (a Form XObject whose resources reach itself)
# and can nest arbitrarily. Indirect objects are deduplicated by objgen; the
# depth cap bounds a chain built only from direct dictionaries, which carry no
# objgen to deduplicate on. Reaching either bound is REPORTED — see
# ``_note_limit``. The object cap is per PAGE and is tested before every item,
# never on entering a branch: one dictionary can hold more entries than the
# whole cap, and a check that only runs per recursive call never sees them.
_MAX_RESOURCE_DEPTH = 32
_MAX_RESOURCE_OBJECTS = 4096

# Pages inspected per ``document_health_step`` call — the CEILING, not the
# unit. The unit is one item, and the budgets below stop a step mid-page.
_STEP_PAGES = 4

# What ONE step may spend before it suspends where it stands. These bound the
# request, not the document: exceeding one is not a finding, it is the next
# step's starting point.
_STEP_OBJECTS = 512
_STEP_DECODED_BYTES = 32 * 1024 * 1024
_STEP_SECONDS = 0.5

# What one RUN may spend in total. Exceeding one of these IS a finding: the
# document cost more than this process spends on a passive observation, and
# what was not inspected is reported as not inspected
# (``document.inspectionBudget``). Seconds are INSPECTION seconds — the sum of
# the steps' own durations — because a run spans idle time that belongs to
# whatever else the machine was doing.
_RUN_DECODED_BYTES = 2 * 1024 * 1024 * 1024
_RUN_SECONDS = 90.0

# Run tokens held open at once. A caller that abandons a run without ending it
# must not be able to keep this process's file handles open indefinitely, so
# the oldest is closed when a new one would exceed this.
_MAX_RUNS = 4

# qpdf's recovery sentences, matched at the engine because qpdf reports no
# codes.
_QPDF_RULES: tuple[tuple[str, str], ...] = (
    ("attempting to reconstruct cross-reference", "xref.reconstructed"),
    ("xref not found", "xref.reconstructed"),
    ("object stream", "structure.repaired"),
    ("stream length", "structure.repaired"),
)

# qpdf announces "file is damaged" once, as the preamble to whichever specific
# recovery follows. It names no defect of its own, so it stands as a fact only
# when nothing more specific was classified — otherwise one repair reads as
# two.
_QPDF_PREAMBLE = "file is damaged"

# A warning no rule matches. qpdf stated SOMETHING and this build cannot say
# what, which is undetermined; classifying it as a repair would claim a repair
# qpdf never described.
_QPDF_UNCLASSIFIED = "qpdf.unclassifiedWarning"

# Everything a sentence can carry that identifies the machine it ran on:
# quoted spans, path-shaped tokens, and offsets. What survives is hashed, so a
# fact distinguishes two different failures without carrying either sentence or
# any path to the UI.
_WARNING_NOISE = re.compile(r"""["'].*?["']|\S*[\\/]\S*|\b\d+\b""")

# The categories an exception is transmitted as. They name the KIND of failure
# and nothing about the document or the machine.
_UNFILTERABLE = "unfilterable-stream"
_PARSE_ERROR = "parse-error"
_IO_ERROR = "io-error"
_TYPE_ERROR = "type-error"


def _fact(kind: str, severity: str, boundary: str, code: str, *,
          page: int | None = None, params: dict | None = None) -> dict:
    return {
        "kind": kind,
        "severity": severity,
        "boundary": boundary,
        "code": code,
        # 1-BASED page number, or null where the fact belongs to the document.
        # The renderer converts to an index against its own current page list.
        "page": page,
        "params": params or {},
    }


def _digest(text: str) -> str:
    normal = " ".join(_WARNING_NOISE.sub(" ", text.lower()).split())
    return hashlib.sha1(normal.encode("utf-8", "replace")).hexdigest()[:8]


def _error_category(exc: BaseException) -> str:
    if isinstance(exc, OSError):
        return _IO_ERROR
    if isinstance(exc, (TypeError, KeyError, AttributeError, IndexError)):
        return _TYPE_ERROR
    if "unfilterable" in str(exc).lower():
        return _UNFILTERABLE
    return _PARSE_ERROR


def _error_params(exc: BaseException) -> dict:
    """The only route from an exception to a fact's parameters.

    ``error`` is a stable category a reader could branch on; ``id`` separates
    two different failures of the same category without carrying the sentence
    that told them apart. Neither is reversible, and neither can hold a path.
    """
    return {"error": _error_category(exc), "id": _digest(str(exc))}


def _classify_warning(text: str) -> str | None:
    low = text.lower()
    for needle, code in _QPDF_RULES:
        if needle in low:
            return code
    if _QPDF_PREAMBLE in low:
        return None
    return _QPDF_UNCLASSIFIED


def _warning_id(text: str) -> str:
    return _digest(text)


def _qpdf_facts(pdf) -> list[dict]:
    """One fact per DISTINCT code the open's warnings classify to.

    A reconstruction emits three sentences for one event, so reporting them
    one-for-one would read as three separate defects.
    """
    try:
        warnings = list(pdf.get_warnings())
    except Exception as exc:
        return [_fact("undetermined", "warning", "qpdf", "warnings.unreadable",
                      params=_error_params(exc))]
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for text in warnings:
        sentence = str(text)
        code = _classify_warning(sentence)
        if code is None:
            continue
        marker = _warning_id(sentence) if code == _QPDF_UNCLASSIFIED else ""
        if (code, marker) in seen:
            continue
        seen.add((code, marker))
        if code == _QPDF_UNCLASSIFIED:
            out.append(_fact("undetermined", "warning", "qpdf", code,
                             params={"warning": marker}))
        else:
            out.append(_fact("recovered", "warning", "qpdf", code))
    if not out and warnings:
        # Only the preamble arrived: qpdf named damage and no recovery. Which
        # recovery ran is unknown, and unknown is not "repaired".
        out.append(_fact("undetermined", "warning", "qpdf", _QPDF_UNCLASSIFIED,
                         params={"warning": _warning_id(str(warnings[0]))}))
    return out


def _font_label(font_obj, resource_name) -> str:
    try:
        base = font_obj.get("/BaseFont")
        if base is not None:
            return str(base).lstrip("/")
    except Exception:
        pass
    return str(resource_name)


def _budget_fact() -> dict:
    """The run spent its inspection budget before it finished.

    A traversal that stopped at a budget has not inspected what lies past it,
    so the run is UNDETERMINED — the same verdict as any other traversal that
    stopped part-way, and never a clean answer covering objects nothing read.
    """
    return _fact("undetermined", "warning", "engine", "document.inspectionBudget")


class _RunSpent(BaseException):
    """Raised out of any item once the RUN's budget is gone.

    Not an ``Exception``: it is raised from inside traversals whose own
    handlers catch ``Exception`` broadly to turn a damaged branch into a fact,
    and one of those would swallow it and let the run continue past its budget.
    ``document_health_step`` is the only handler, and it converts this to
    ``document.inspectionBudget`` and ends the run."""


def _now() -> float:
    """The inspection clock. Module-level so a test can state time."""
    return time.monotonic()


class _Budget:
    """What one run may spend, and what one step may spend before it yields.

    Two bounds, and they mean different things. The STEP bound is a yield: the
    traversal suspends where it stands and the next step resumes it, which is
    what keeps one request short. The RUN bound is a verdict: the document
    cost more than this process will spend on a passive observation, and what
    was not inspected is reported as not inspected.

    Time is charged as INSPECTION time — the sum of the steps' own durations —
    never wall-clock across the whole run, because the gaps between steps
    belong to whatever else the machine was doing.
    """

    __slots__ = ("run_seconds_left", "run_bytes_left", "step_started",
                 "step_objects_left", "step_bytes_left")

    def __init__(self) -> None:
        self.run_seconds_left = _RUN_SECONDS
        self.run_bytes_left = _RUN_DECODED_BYTES
        self.step_started = 0.0
        self.step_objects_left = 0
        self.step_bytes_left = 0

    def start_step(self) -> None:
        self.step_started = _now()
        self.step_objects_left = _STEP_OBJECTS
        self.step_bytes_left = _STEP_DECODED_BYTES

    def end_step(self) -> None:
        self.run_seconds_left -= max(_now() - self.step_started, 0.0)

    def step_spent(self) -> bool:
        return (self.step_objects_left <= 0
                or self.step_bytes_left <= 0
                or _now() - self.step_started >= _STEP_SECONDS)

    def take_item(self) -> None:
        """Charge ONE inspected item. Called before the item is read."""
        if self.run_seconds_left - (_now() - self.step_started) <= 0.0:
            raise _RunSpent()
        if self.run_bytes_left <= 0:
            raise _RunSpent()
        self.step_objects_left -= 1

    def take_bytes(self, count: int) -> None:
        self.run_bytes_left -= count
        self.step_bytes_left -= count
        if self.run_bytes_left <= 0:
            raise _RunSpent()


def _font_facts(pdf, run=None, pages=None, include_dr: bool = True) -> list[dict]:
    """Fonts the document draws with whose program is absent or unreadable.

    Counted once per indirect object, like ``check.py``'s survey: one font
    program referenced from forty pages is one substitution, not forty. The
    page it was first reached on is kept so the panel can link to it.

    ``run`` carries the dedup sets and the budget across a stepped traversal,
    so driving this one page-batch at a time reports what one whole-document
    call reports. Without one it is the whole document at once, which is what
    the CLI and the tests ask for.
    """
    out: list[dict] = []
    seen: set = run.font_objects if run is not None else set()
    notes: set = run.font_notes if run is not None else set()
    resources: set = run.font_resources if run is not None else set()
    budget = run.budget if run is not None else None

    def on_font(font_obj, page_number, resource_name) -> None:
        if budget is not None:
            budget.take_item()
        objgen = getattr(font_obj, "objgen", (0, 0))
        if objgen != (0, 0):
            if objgen in seen:
                return
            seen.add(objgen)
        page = page_number if page_number > 0 else None
        try:
            label = _font_label(font_obj, resource_name)
            state = font_embedded(font_obj)
        except Exception as exc:
            out.append(_fact("undetermined", "warning", "engine", "font.unreadable",
                             page=page, params={"font": str(resource_name),
                                                **_error_params(exc)}))
            return
        if state is False:
            out.append(_fact("font", "warning", "engine", "font.notEmbedded",
                             page=page, params={"font": label}))
        elif state is None:
            out.append(_fact("undetermined", "warning", "engine", "font.unreadable",
                             page=page, params={"font": label}))

    def on_unreadable(page_number, resource_name, detail) -> None:
        page = page_number if page_number and page_number > 0 else None
        params = {"font": str(resource_name or ""), "error": _PARSE_ERROR,
                  "id": _digest(str(detail))}
        # Deduped for the same reason a font is: a stepped run re-enters the
        # page batch it suspended in, and one unreadable table must not read
        # as two.
        marker = (page, params["font"], params["id"])
        if marker in notes:
            return
        notes.add(marker)
        out.append(_fact("undetermined", "warning", "engine", "font.unreadable",
                         page=page, params=params))

    try:
        walk_document_fonts(pdf, on_font, on_unreadable, pages=pages,
                            seen=resources, include_dr=include_dr)
    except Exception as exc:
        out.append(_fact("undetermined", "warning", "engine", "fonts.unenumerable",
                         params=_error_params(exc)))
    return out


def _filter_names(obj) -> list[str]:
    """The filter names on one stream, single or chained; empty when none."""
    try:
        entry = obj.get("/Filter")
    except Exception:
        return []
    if entry is None:
        return []
    if isinstance(entry, pikepdf.Array):
        return [str(item) for item in entry]
    return [str(entry)]


def _identity(obj):
    """An identity to visit an object once by.

    ``objgen`` for an indirect object; a direct dictionary has ``(0, 0)`` for
    every one of them, so it identifies by address instead and the depth cap
    carries the rest.
    """
    objgen = getattr(obj, "objgen", (0, 0))
    return objgen if objgen != (0, 0) else ("direct", id(obj))


# The frames one page's traversal is made of. Each is ONE item the budget is
# charged for before it is read, which is the property the object cap rests
# on: a bound checked on entering a recursive call is not checked again for
# the 4 097th entry of the dictionary that call is looping over.
_RESOURCES = "resources"
_ENTRY = "entry"
_APPEARANCE = "appearance"


class _Walk:
    """One page's traversal, suspendable between any two items.

    ``frames`` is the work not yet done, so a step that runs out of budget
    returns with it non-empty and the next step resumes exactly there. A
    recursive traversal cannot do that: its position lives on the interpreter
    stack, which does not survive returning.

    ``limited`` holds the page numbers that already reported an incomplete
    traversal, so a wide graph that hits the bound in forty branches reports it
    once.
    """

    __slots__ = ("out", "page", "page_number", "frames", "visited",
                 "not_decoded", "limited", "budget", "annotations_queued")

    def __init__(self, out: list[dict], page_number: int, not_decoded: set,
                 limited: set, budget) -> None:
        self.out = out
        self.page = None
        self.page_number = page_number
        self.frames: deque = deque()
        self.visited: set = set()
        self.not_decoded = not_decoded
        self.limited = limited
        self.budget = budget
        self.annotations_queued = False

    def push(self, frames) -> None:
        self.frames.extendleft(reversed(frames))


def _note_limit(walk: _Walk) -> None:
    """The traversal stopped at its own bound.

    What lies beyond it was never inspected, so the branch is UNDETERMINED. A
    bound reached silently publishes a partial traversal as a complete one — a
    clean answer covering objects nothing read.
    """
    if walk.page_number in walk.limited:
        return
    walk.limited.add(walk.page_number)
    walk.out.append(_fact("undetermined", "warning", "engine",
                          "page.traversalLimit", page=walk.page_number))


def _read_stream(walk: _Walk, obj, level=None) -> bytes:
    """Read one stream and charge the run for what it decoded to."""
    data = obj.read_raw_bytes() if level is None else obj.read_bytes(level)
    if walk.budget is not None:
        walk.budget.take_bytes(len(data))
    return data


def _check_image(obj, name, walk: _Walk) -> None:
    """One image XObject: whether its stream reads, and whether it decoded."""
    specialized = [f for f in _filter_names(obj) if f in _SPECIALIZED_FILTERS]
    try:
        if specialized:
            # A chain ending in a pixel codec is unfilterable at every decode
            # level qpdf offers, so the general layers under it cannot be
            # exercised either. Only the presence of the bytes is checked.
            _read_stream(walk, obj)
        else:
            _read_stream(walk, obj, pikepdf.StreamDecodeLevel.generalized)
    except Exception as exc:
        walk.out.append(_fact("skipped", "warning", "engine", "page.imageUnreadable",
                              page=walk.page_number,
                              params={"name": str(name).lstrip("/"),
                                      **_error_params(exc)}))
        return
    if specialized:
        walk.not_decoded.add(_identity(obj))


def _check_content(obj, name, code: str, walk: _Walk) -> None:
    """One content-bearing stream: whether it decodes AND whether it parses.

    Both halves are required and they fail differently. A Form XObject whose
    filter chain is broken yields no bytes at all; one whose bytes are not a
    token sequence yields bytes that draw nothing. Visiting only the object's
    nested ``/Resources`` — which is all a resource walk does — reports a page
    that executes such a Form as clean.
    """
    try:
        _read_stream(walk, obj, pikepdf.StreamDecodeLevel.generalized)
        pikepdf.parse_content_stream(obj)
    except Exception as exc:
        params = _error_params(exc)
        if name:
            params["name"] = str(name).lstrip("/")
        walk.out.append(_fact("skipped", "warning", "engine", code,
                              page=walk.page_number, params=params))


def _unreadable(walk: _Walk, exc: BaseException) -> None:
    walk.out.append(_fact("undetermined", "warning", "engine",
                          "page.resourcesUnreadable", page=walk.page_number,
                          params=_error_params(exc)))


def _expand_resources(resources, depth: int, walk: _Walk) -> None:
    """Queue one resource dictionary's content-bearing entries.

    A page draws through its own resources, through the Form XObjects and
    patterns those name, and through the appearance streams of its annotations
    — each of which is itself a content stream carrying resources of its own.
    Checking only the page's direct ``/XObject`` entries reports a document as
    clean whose only damaged object sits one Form deep.
    """
    if resources is None:
        return
    if depth > _MAX_RESOURCE_DEPTH:
        _note_limit(walk)
        return
    queued = []
    for category in ("/XObject", "/Pattern"):
        try:
            entries = resources.get(category)
            names = list(entries.keys()) if entries is not None else []
        except Exception as exc:
            _unreadable(walk, exc)
            continue
        for name in names:
            queued.append((_ENTRY, entries, name, depth))
    walk.push(queued)


def _visit_entry(entries, name, depth: int, walk: _Walk) -> None:
    try:
        obj = entries[name]
        key = _identity(obj)
        if key in walk.visited:
            return
        walk.visited.add(key)
        subtype = str(obj.get("/Subtype", ""))
    except Exception as exc:
        _unreadable(walk, exc)
        return
    if subtype == _IMAGE_SUBTYPE:
        _check_image(obj, name, walk)
        return
    # A Form XObject and a tiling pattern are both content streams with
    # resources of their own; a shading pattern is a dictionary with neither,
    # and drops out of both branches here.
    if isinstance(obj, pikepdf.Stream):
        _check_content(obj, name, "page.formUnreadable", walk)
    try:
        nested = obj.get("/Resources")
    except Exception as exc:
        _unreadable(walk, exc)
        return
    if nested is not None:
        walk.push([(_RESOURCES, nested, None, depth + 1)])


def _annotation_appearances(page, walk: _Walk) -> list:
    """The normal appearance streams the page renders its annotations through.

    Only ``/AP`` ``/N`` — the appearance a page draws with. Down and rollover
    appearances are drawn during interaction, not as part of the page. A
    sub-dictionary holds one stream per appearance STATE and each of them is an
    appearance this page can draw, so all of them are returned.
    """
    found: list = []
    if page is None:
        return found
    try:
        annots = page.obj.get("/Annots")
        items = list(annots) if annots is not None else []
    except Exception as exc:
        _unreadable(walk, exc)
        return found
    for annot in items:
        try:
            appearance = annot.get("/AP")
            normal = appearance.get("/N") if appearance is not None else None
            if normal is None:
                continue
            if isinstance(normal, pikepdf.Dictionary) and "/Subtype" not in normal:
                states = [(str(key).lstrip("/"), normal[key]) for key in normal.keys()]
            else:
                states = [("", normal)]
            for state_name, stream in states:
                found.append((_APPEARANCE, stream, state_name, 1))
        except Exception as exc:
            _unreadable(walk, exc)
    return found


def _visit_appearance(appearance, name, depth: int, walk: _Walk) -> None:
    key = _identity(appearance)
    if key in walk.visited:
        return
    walk.visited.add(key)
    if isinstance(appearance, pikepdf.Stream):
        _check_content(appearance, name, "page.appearanceUnreadable", walk)
    try:
        nested = appearance.get("/Resources")
    except Exception as exc:
        _unreadable(walk, exc)
        return
    if nested is not None:
        walk.push([(_RESOURCES, nested, None, depth)])


def _advance_page(walk: _Walk) -> bool:
    """Run one page's queued items until they are done or the STEP is spent.

    True when the walk suspended with work left; False when the page is
    finished. Raises ``_RunSpent`` when the RUN's budget is gone.
    """
    # A step must make progress. Suspending before the first item would let a
    # slow enough machine — or a step budget smaller than one item costs —
    # return "suspended" forever, and the run would never finish.
    moved = False
    while True:
        if not walk.frames:
            if walk.annotations_queued:
                return False
            walk.annotations_queued = True
            walk.push(_annotation_appearances(walk.page, walk))
            if not walk.frames:
                return False
        if moved and walk.budget is not None and walk.budget.step_spent():
            return True
        # Checked BEFORE the item, not on entering a branch: a dictionary with
        # 4 097 direct entries is 4 097 items, and a cap tested once per
        # recursive call never sees the 4 097th.
        if len(walk.visited) >= _MAX_RESOURCE_OBJECTS:
            _note_limit(walk)
            walk.frames.clear()
            return False
        if walk.budget is not None:
            walk.budget.take_item()
        kind, obj, name, depth = walk.frames.popleft()
        moved = True
        if kind == _RESOURCES:
            _expand_resources(obj, depth, walk)
        elif kind == _ENTRY:
            _visit_entry(obj, name, depth, walk)
        else:
            _visit_appearance(obj, name, depth, walk)


def _start_page(pdf, index: int, out: list[dict], not_decoded: set, limited: set,
                budget):
    """Open one page, report what the page dictionary itself says, and queue
    its resource traversal. None when the page cannot be reached at all."""
    number = index + 1
    walk = _Walk(out, number, not_decoded, limited, budget)
    try:
        page = pdf.pages[index]
    except Exception as exc:
        out.append(_fact("undetermined", "warning", "engine", "page.unreadable",
                         page=number, params=_error_params(exc)))
        return None
    try:
        if page.get("/MediaBox") is None:
            out.append(_fact("skipped", "warning", "engine", "page.mediaBoxMissing",
                             page=number))
    except Exception as exc:
        out.append(_fact("undetermined", "warning", "engine", "page.unreadable",
                         page=number, params=_error_params(exc)))
        return None
    try:
        # Catches a content stream whose FILTER will not decode — the case
        # where nothing on the page can be drawn. It does not catch a
        # malformed operator sequence: qpdf's tokenizer stops at the first
        # unparseable token and reports what it read, which is a partial
        # read the reader recovers from rather than a stream that fails.
        pikepdf.parse_content_stream(page)
    except Exception as exc:
        out.append(_fact("skipped", "warning", "engine", "page.contentUnreadable",
                         page=number, params=_error_params(exc)))
    try:
        resources = page.obj.get("/Resources")
    except Exception as exc:
        out.append(_fact("undetermined", "warning", "engine",
                         "page.resourcesUnreadable", page=number,
                         params=_error_params(exc)))
        resources = None
    walk.page = page
    walk.push([(_RESOURCES, resources, None, 0)])
    return walk


def _document_facts(pdf) -> list[dict]:
    """Document-level constructs the app does not render as authored."""
    out: list[dict] = []
    try:
        acroform = pdf.Root.get("/AcroForm")
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine",
                      "document.acroFormUnreadable", params=_error_params(exc))]
    if acroform is None:
        return out
    if not isinstance(acroform, pikepdf.Dictionary):
        # A wrong-typed /AcroForm answers the /XFA question with None rather
        # than raising, so the type is checked instead of relied on: whatever
        # this document declares as its form could not be read, and that is
        # undetermined rather than "no form".
        return [_fact("undetermined", "warning", "engine",
                      "document.acroFormUnreadable",
                      params=_error_params(TypeError(type(acroform).__name__)))]
    try:
        # ONE strict reading of the declaration, typed against the clauses that
        # give each of its values a type. Absent, malformed and dynamic are
        # three different answers and only one of them is "no form".
        found = xfa.inspect(pdf)
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine",
                      "document.xfaUnreadable", params=_error_params(exc))]
    if found.form_class == xfa.UNDETERMINED:
        # `shape` is a constant of `xfa`, never text from the document, so the
        # digest separates two malformations without carrying either.
        return [_fact("undetermined", "warning", "engine",
                      "document.xfaUnreadable",
                      params=_error_params(TypeError(found.shape)))]
    if found.form_class == xfa.DYNAMIC:
        out.append(_fact("skipped", "info", "engine", "document.xfa"))
    return out


def _status(facts: list[dict]) -> str:
    return ("undetermined" if any(f["kind"] == "undetermined" for f in facts)
            else "collected")


class _Run:
    """One stepped traversal: the open document and how far it has been read."""

    __slots__ = ("pdf", "pages", "cursor", "not_decoded", "limited", "fonts_done",
                 "document_done", "walk", "budget", "font_objects", "font_notes",
                 "font_resources")

    def __init__(self, pdf, pages: int) -> None:
        self.pdf = pdf
        self.pages = pages
        self.cursor = 0
        self.not_decoded: set = set()
        self.limited: set = set()
        self.fonts_done = False
        self.document_done = False
        self.walk = None
        self.budget = _Budget()
        self.font_objects: set = set()
        self.font_notes: set = set()
        self.font_resources: set = set()


_RUNS: "OrderedDict[str, _Run]" = OrderedDict()


def _drop(token: str) -> bool:
    run = _RUNS.pop(token, None)
    if run is None:
        return False
    try:
        run.pdf.close()
    except Exception:
        pass
    return True


def _register(run: _Run) -> str:
    while len(_RUNS) >= _MAX_RUNS:
        # A caller that abandoned a run without ending it must not be able to
        # hold this process's file handles open. The oldest goes.
        _drop(next(iter(_RUNS)))
    token = secrets.token_hex(8)
    _RUNS[token] = run
    return token


def document_health_begin(file: str) -> dict:
    """Open one document and report what the open itself said.

    Returns a run ``token`` the caller steps with, or an empty token and
    ``done`` when there is nothing to step: an unopenable document is already a
    complete answer.

    The open is ALL this does. Reading what the document declares — the form,
    its packets — is a traversal like any other and is charged to the first
    step, so no one request carries both an open and an inspection.

    Args:
        file: Input PDF path.
    """
    input_path = Path(file)
    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {file}")

    head: dict = {
        "file": str(input_path),
        "size_bytes": os.path.getsize(file),
        "token": "",
        "pages": 0,
        "done": True,
        "status": "collected",
        "facts": [],
    }

    try:
        pdf = pikepdf.open(file, suppress_warnings=True)
    except pikepdf.PasswordError:
        head["status"] = "undetermined"
        head["facts"] = [_fact("undetermined", "info", "engine", "document.encrypted")]
        return head
    except Exception as exc:
        head["status"] = "undetermined"
        head["facts"] = [_fact("undetermined", "warning", "engine",
                               "document.unreadable", params=_error_params(exc))]
        return head

    facts = _qpdf_facts(pdf)
    # The open above succeeded with NO password, so this is not the
    # user-password case above (that one never reaches here — pikepdf raises
    # ``PasswordError`` before a ``Pdf`` object exists). A document can still
    # be encrypted with only an owner password: opening it needs nothing, but
    # the file IS protected, and that is a document-level fact a health ledger
    # is exactly the place to surface. Distinct code from ``document.encrypted``
    # (which means "did not open") — this one means "opened, and is
    # encrypted" — so the two are never confused by a reader that groups facts
    # by code. Info severity: an owner-only lock is not itself something
    # wrong with the document.
    if getattr(pdf, "is_encrypted", False):
        facts.append(_fact("skipped", "info", "engine", "document.encryptedOwner"))
    try:
        pages = len(pdf.pages)
    except Exception as exc:
        facts.append(_fact("undetermined", "warning", "engine", "pages.unreadable",
                           params=_error_params(exc)))
        try:
            pdf.close()
        except Exception:
            pass
        head["facts"] = facts
        head["status"] = _status(facts)
        return head

    head["token"] = _register(_Run(pdf, pages))
    head["pages"] = pages
    head["done"] = False
    head["facts"] = facts
    head["status"] = _status(facts)
    return head


def document_health_step(token: str) -> dict:
    """Inspect the next bounded batch of one run.

    A step reads at most ``_STEP_PAGES`` pages and stops sooner than that at
    its object, decoded-byte or time budget — mid-page if need be, because the
    traversal's position is data the run holds rather than an interpreter
    stack. ``done`` true means the run finished and has already been closed;
    no ``end`` is needed after it.

    Args:
        token: Run token from ``document_health_begin``.
    """
    run = _RUNS.get(token)
    if run is None:
        # The run was evicted, ended, or never existed. What it would have
        # inspected was not inspected, and that is undetermined.
        return {"token": token, "done": True, "status": "undetermined",
                "facts": [_fact("undetermined", "warning", "engine",
                                "health.runLost")]}
    facts: list[dict] = []
    done = False
    run.budget.start_step()
    try:
        if not run.document_done:
            run.document_done = True
            facts.extend(_document_facts(run.pdf))
        if run.cursor < run.pages:
            read = 0
            while run.cursor < run.pages and read < _STEP_PAGES:
                if run.walk is None:
                    run.walk = _start_page(run.pdf, run.cursor, facts,
                                           run.not_decoded, run.limited, run.budget)
                    if run.walk is None:
                        run.cursor += 1
                        read += 1
                        continue
                else:
                    # A page resumed from an earlier step reports into THIS
                    # step's facts.
                    run.walk.out = facts
                if _advance_page(run.walk):
                    break
                facts.extend(_font_facts(run.pdf, run, pages=[run.cursor],
                                         include_dr=False))
                run.walk = None
                run.cursor += 1
                read += 1
                if run.budget.step_spent():
                    break
        elif not run.fonts_done:
            run.fonts_done = True
            # The document-level leg of the font walk: ``/AcroForm /DR``, which
            # belongs to no page and is therefore run once, here.
            facts.extend(_font_facts(run.pdf, run, pages=[], include_dr=True))
            if run.not_decoded:
                # Stated once for the document: these images' bytes are present
                # and their pixels were never decoded here. Reported so the
                # ledger cannot be read as having checked them, at info
                # severity because nothing was found wrong — an unchecked image
                # is not a damaged one.
                facts.append(_fact("skipped", "info", "engine",
                                   "document.imagesNotDecoded",
                                   params={"count": len(run.not_decoded)}))
            done = True
        else:
            done = True
    except _RunSpent:
        facts.append(_budget_fact())
        done = True
    except Exception as exc:
        facts.append(_fact("undetermined", "warning", "engine", "pages.unreadable",
                           params=_error_params(exc)))
        done = True
    finally:
        run.budget.end_step()
    if done:
        _drop(token)
    return {"token": token, "done": done, "status": _status(facts), "facts": facts}


def document_health_end(token: str) -> dict:
    """Abandon a run: close its document and forget it. Idempotent.

    Args:
        token: Run token from ``document_health_begin``.
    """
    return {"token": token, "ended": _drop(token)}


def document_health(file: str) -> dict:
    """Collect health facts for one document without modifying it.

    Never raises for a damaged document: unreadability is a RESULT
    (``status`` of ``undetermined`` plus the fact that says so), because a
    refusal here would be indistinguishable, in a ledger that stores only
    facts, from a document that had nothing to report.

    Args:
        file: Input PDF path.
    """
    head = document_health_begin(file)
    facts: list[dict] = list(head["facts"])
    token = head["token"]
    done = bool(head["done"])
    try:
        while not done:
            chunk = document_health_step(token)
            facts.extend(chunk["facts"])
            done = bool(chunk["done"])
    finally:
        document_health_end(token)
    return {
        "file": head["file"],
        "size_bytes": head["size_bytes"],
        # "collected" means every traversal ran to the end. "undetermined"
        # means at least one could not, and the ledger must not read the facts
        # that did arrive as a complete answer.
        "status": _status(facts),
        "facts": facts,
    }
