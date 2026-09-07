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
``document_health_begin`` / ``_step`` / ``_end`` run it a bounded batch at a
time against a run token, so a caller can hand this process a user's request
between batches. Both drive the same code, so they cannot report a document
differently.
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
from collections import OrderedDict
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
# ``_note_limit``.
_MAX_RESOURCE_DEPTH = 32
_MAX_RESOURCE_OBJECTS = 4096

# Pages inspected per ``document_health_step`` call. The bound is what lets a
# user's request reach this process between batches; it is small because the
# guarantee it buys is "waits at most one batch".
_STEP_PAGES = 4

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


def _font_facts(pdf) -> list[dict]:
    """Fonts the document draws with whose program is absent or unreadable.

    Counted once per indirect object, like ``check.py``'s survey: one font
    program referenced from forty pages is one substitution, not forty. The
    page it was first reached on is kept so the panel can link to it.
    """
    out: list[dict] = []
    seen: set = set()

    def on_font(font_obj, page_number, resource_name) -> None:
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
        out.append(_fact("undetermined", "warning", "engine", "font.unreadable",
                         page=page,
                         params={"font": str(resource_name or ""),
                                 "error": _PARSE_ERROR,
                                 "id": _digest(str(detail))}))

    try:
        walk_document_fonts(pdf, on_font, on_unreadable)
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


class _Walk:
    """The state one page's resource traversal carries.

    ``limited`` holds the page numbers that already reported an incomplete
    traversal, so a wide graph that hits the bound in forty branches reports it
    once.
    """

    __slots__ = ("out", "visited", "not_decoded", "limited")

    def __init__(self, out: list[dict], not_decoded: set, limited: set) -> None:
        self.out = out
        self.visited: set = set()
        self.not_decoded = not_decoded
        self.limited = limited


def _note_limit(walk: _Walk, page_number: int) -> None:
    """The traversal stopped at its own bound.

    What lies beyond it was never inspected, so the branch is UNDETERMINED. A
    bound reached silently publishes a partial traversal as a complete one — a
    clean answer covering objects nothing read.
    """
    if page_number in walk.limited:
        return
    walk.limited.add(page_number)
    walk.out.append(_fact("undetermined", "warning", "engine",
                          "page.traversalLimit", page=page_number))


def _check_image(obj, name, page_number: int, walk: _Walk) -> None:
    """One image XObject: whether its stream reads, and whether it decoded."""
    specialized = [f for f in _filter_names(obj) if f in _SPECIALIZED_FILTERS]
    try:
        if specialized:
            # A chain ending in a pixel codec is unfilterable at every decode
            # level qpdf offers, so the general layers under it cannot be
            # exercised either. Only the presence of the bytes is checked.
            obj.read_raw_bytes()
        else:
            obj.read_bytes(pikepdf.StreamDecodeLevel.generalized)
    except Exception as exc:
        walk.out.append(_fact("skipped", "warning", "engine", "page.imageUnreadable",
                              page=page_number,
                              params={"name": str(name).lstrip("/"),
                                      **_error_params(exc)}))
        return
    if specialized:
        walk.not_decoded.add(_identity(obj))


def _check_content(obj, name, page_number: int, code: str, walk: _Walk) -> None:
    """One content-bearing stream: whether it decodes AND whether it parses.

    Both halves are required and they fail differently. A Form XObject whose
    filter chain is broken yields no bytes at all; one whose bytes are not a
    token sequence yields bytes that draw nothing. Visiting only the object's
    nested ``/Resources`` — which is all a resource walk does — reports a page
    that executes such a Form as clean.
    """
    try:
        obj.read_bytes(pikepdf.StreamDecodeLevel.generalized)
        pikepdf.parse_content_stream(obj)
    except Exception as exc:
        params = _error_params(exc)
        if name:
            params["name"] = str(name).lstrip("/")
        walk.out.append(_fact("skipped", "warning", "engine", code,
                              page=page_number, params=params))


def _walk_resources(resources, page_number: int, walk: _Walk, depth: int) -> None:
    """Content streams and images reachable from one resource dictionary.

    A page draws through its own resources, through the Form XObjects and
    patterns those name, and through the appearance streams of its annotations
    — each of which is itself a content stream carrying resources of its own.
    Checking only the page's direct ``/XObject`` entries reports a document as
    clean whose only damaged object sits one Form deep.
    """
    if resources is None:
        return
    if depth > _MAX_RESOURCE_DEPTH or len(walk.visited) >= _MAX_RESOURCE_OBJECTS:
        _note_limit(walk, page_number)
        return
    for category in ("/XObject", "/Pattern"):
        try:
            entries = resources.get(category)
            names = list(entries.keys()) if entries is not None else []
        except Exception as exc:
            walk.out.append(_fact("undetermined", "warning", "engine",
                                  "page.resourcesUnreadable", page=page_number,
                                  params=_error_params(exc)))
            continue
        for name in names:
            try:
                obj = entries[name]
                key = _identity(obj)
                if key in walk.visited:
                    continue
                walk.visited.add(key)
                subtype = str(obj.get("/Subtype", ""))
            except Exception as exc:
                walk.out.append(_fact("undetermined", "warning", "engine",
                                      "page.resourcesUnreadable", page=page_number,
                                      params=_error_params(exc)))
                continue
            if subtype == _IMAGE_SUBTYPE:
                _check_image(obj, name, page_number, walk)
                continue
            # A Form XObject and a tiling pattern are both content streams with
            # resources of their own; a shading pattern is a dictionary with
            # neither, and drops out of both branches here.
            if isinstance(obj, pikepdf.Stream):
                _check_content(obj, name, page_number, "page.formUnreadable", walk)
            try:
                nested = obj.get("/Resources")
            except Exception as exc:
                walk.out.append(_fact("undetermined", "warning", "engine",
                                      "page.resourcesUnreadable", page=page_number,
                                      params=_error_params(exc)))
                continue
            _walk_resources(nested, page_number, walk, depth + 1)


def _annotation_appearances(page, page_number: int,
                            walk: _Walk) -> list[tuple[str, object]]:
    """The normal appearance streams the page renders its annotations through.

    Only ``/AP`` ``/N`` — the appearance a page draws with. Down and rollover
    appearances are drawn during interaction, not as part of the page. A
    sub-dictionary holds one stream per appearance STATE and each of them is an
    appearance this page can draw, so all of them are returned.
    """
    found: list[tuple[str, object]] = []
    try:
        annots = page.obj.get("/Annots")
        items = list(annots) if annots is not None else []
    except Exception as exc:
        walk.out.append(_fact("undetermined", "warning", "engine",
                              "page.resourcesUnreadable", page=page_number,
                              params=_error_params(exc)))
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
            for state in states:
                found.append(state)
        except Exception as exc:
            walk.out.append(_fact("undetermined", "warning", "engine",
                                  "page.resourcesUnreadable", page=page_number,
                                  params=_error_params(exc)))
    return found


def _image_facts(page, page_number: int, not_decoded: set | None = None,
                 limited: set | None = None) -> list[dict]:
    """Everything one page reaches through its resources that will not read.

    ``not_decoded`` collects the images whose pixel codec this process does not
    apply; the caller reports them once for the document rather than once per
    image.
    """
    out: list[dict] = []
    walk = _Walk(out, not_decoded if not_decoded is not None else set(),
                 limited if limited is not None else set())
    try:
        resources = page.obj.get("/Resources")
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine", "page.resourcesUnreadable",
                      page=page_number, params=_error_params(exc))]
    _walk_resources(resources, page_number, walk, 0)
    for name, appearance in _annotation_appearances(page, page_number, walk):
        key = _identity(appearance)
        if key in walk.visited:
            continue
        walk.visited.add(key)
        if isinstance(appearance, pikepdf.Stream):
            _check_content(appearance, name, page_number,
                           "page.appearanceUnreadable", walk)
        try:
            nested = appearance.get("/Resources")
        except Exception as exc:
            out.append(_fact("undetermined", "warning", "engine",
                             "page.resourcesUnreadable", page=page_number,
                             params=_error_params(exc)))
            continue
        _walk_resources(nested, page_number, walk, 1)
    return out


def _one_page_facts(pdf, index: int, not_decoded: set, limited: set) -> list[dict]:
    """Facts for ONE page, by index — the unit both spellings step through."""
    out: list[dict] = []
    number = index + 1
    try:
        page = pdf.pages[index]
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine", "page.unreadable",
                      page=number, params=_error_params(exc))]
    try:
        if page.get("/MediaBox") is None:
            out.append(_fact("skipped", "warning", "engine", "page.mediaBoxMissing",
                             page=number))
    except Exception as exc:
        out.append(_fact("undetermined", "warning", "engine", "page.unreadable",
                         page=number, params=_error_params(exc)))
        return out
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
    out.extend(_image_facts(page, number, not_decoded, limited))
    return out


def _page_facts(pdf, not_decoded: set, limited: set | None = None) -> list[dict]:
    out: list[dict] = []
    marks = limited if limited is not None else set()
    try:
        count = len(pdf.pages)
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine", "pages.unreadable",
                      params=_error_params(exc))]
    for index in range(count):
        out.extend(_one_page_facts(pdf, index, not_decoded, marks))
    return out


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
    state, _entry = xfa.xfa_entry_checked(pdf)
    if state == xfa.MALFORMED:
        # The key IS there and does not hold what Annex K describes. Absent and
        # malformed are different answers and only one of them is "no XFA".
        return [_fact("undetermined", "warning", "engine",
                      "document.xfaUnreadable",
                      params=_error_params(TypeError(xfa.MALFORMED)))]
    if state == xfa.ABSENT:
        return out
    try:
        # The same classification the XFA editing path uses, so the ledger
        # cannot call skipped a form the product fills. Only a form whose
        # fields exist solely in the XML is outside what is rendered.
        form_class = xfa.classify(pdf)
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine",
                      "document.xfaUnreadable", params=_error_params(exc))]
    if form_class == xfa.DYNAMIC:
        out.append(_fact("skipped", "info", "engine", "document.xfa"))
    return out


def _status(facts: list[dict]) -> str:
    return ("undetermined" if any(f["kind"] == "undetermined" for f in facts)
            else "collected")


class _Run:
    """One stepped traversal: the open document and how far it has been read."""

    __slots__ = ("pdf", "pages", "cursor", "not_decoded", "limited", "fonts_done")

    def __init__(self, pdf, pages: int) -> None:
        self.pdf = pdf
        self.pages = pages
        self.cursor = 0
        self.not_decoded: set = set()
        self.limited: set = set()
        self.fonts_done = False


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
    facts.extend(_document_facts(pdf))
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

    A step reads at most ``_STEP_PAGES`` pages, or performs the single font
    walk once the pages are done. ``done`` true means the run finished and has
    already been closed; no ``end`` is needed after it.

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
    try:
        if run.cursor < run.pages:
            stop = min(run.cursor + _STEP_PAGES, run.pages)
            for index in range(run.cursor, stop):
                facts.extend(_one_page_facts(run.pdf, index, run.not_decoded,
                                             run.limited))
            run.cursor = stop
        elif not run.fonts_done:
            run.fonts_done = True
            facts.extend(_font_facts(run.pdf))
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
    except Exception as exc:
        facts.append(_fact("undetermined", "warning", "engine", "pages.unreadable",
                           params=_error_params(exc)))
        done = True
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
