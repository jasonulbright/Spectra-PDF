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
``undetermined`` is one of them: a font whose embedding will not read, or a
resource branch that will not parse, is never folded into a clean answer.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

import pikepdf

from engine import xfa
from engine.font_embedding import font_embedded
from engine.font_inventory import walk_document_fonts

_IMAGE_SUBTYPE = "/Image"
_FORM_SUBTYPE = "/Form"

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
# objgen to deduplicate on.
_MAX_RESOURCE_DEPTH = 32

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

# Everything a qpdf sentence can carry that identifies the machine it ran on:
# quoted spans, path-shaped tokens, and offsets. What survives is hashed, so
# the fact distinguishes two different unknown warnings without carrying either
# sentence or any path to the UI.
_WARNING_NOISE = re.compile(r"""["'].*?["']|\S*[\\/]\S*|\b\d+\b""")


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


def _classify_warning(text: str) -> str | None:
    low = text.lower()
    for needle, code in _QPDF_RULES:
        if needle in low:
            return code
    if _QPDF_PREAMBLE in low:
        return None
    return _QPDF_UNCLASSIFIED


def _warning_id(text: str) -> str:
    normal = " ".join(_WARNING_NOISE.sub(" ", text.lower()).split())
    return hashlib.sha1(normal.encode("utf-8", "replace")).hexdigest()[:8]


def _qpdf_facts(pdf) -> list[dict]:
    """One fact per DISTINCT code the open's warnings classify to.

    A reconstruction emits three sentences for one event, so reporting them
    one-for-one would read as three separate defects.
    """
    try:
        warnings = list(pdf.get_warnings())
    except Exception as exc:
        return [_fact("undetermined", "warning", "qpdf", "warnings.unreadable",
                      params={"detail": str(exc)})]
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
                                                "detail": str(exc)}))
            return
        if state is False:
            out.append(_fact("font", "warning", "engine", "font.notEmbedded",
                             page=page, params={"font": label}))
        elif state is None:
            out.append(_fact("undetermined", "warning", "engine", "font.unreadable",
                             page=page, params={"font": label, "detail": ""}))

    def on_unreadable(page_number, resource_name, detail) -> None:
        page = page_number if page_number and page_number > 0 else None
        out.append(_fact("undetermined", "warning", "engine", "font.unreadable",
                         page=page,
                         params={"font": str(resource_name or ""),
                                 "detail": str(detail)}))

    try:
        walk_document_fonts(pdf, on_font, on_unreadable)
    except Exception as exc:
        out.append(_fact("undetermined", "warning", "engine", "fonts.unenumerable",
                         params={"detail": str(exc)}))
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


def _check_image(obj, name, page_number: int, out: list[dict],
                 not_decoded: set) -> None:
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
        out.append(_fact("skipped", "warning", "engine", "page.imageUnreadable",
                         page=page_number,
                         params={"name": str(name).lstrip("/"),
                                 "detail": str(exc)}))
        return
    if specialized:
        not_decoded.add(_identity(obj))


def _walk_resources(resources, page_number: int, out: list[dict],
                    visited: set, not_decoded: set, depth: int) -> None:
    """Images reachable from one resource dictionary, at any nesting.

    A page draws through its own resources, through the Form XObjects and
    patterns those name, and through the appearance streams of its annotations
    — each of which carries resources of its own. Checking only the page's
    direct ``/XObject`` entries reports a document as clean whose only damaged
    image sits one Form deep.
    """
    if resources is None or depth > _MAX_RESOURCE_DEPTH:
        return
    for category in ("/XObject", "/Pattern"):
        try:
            entries = resources.get(category)
            names = list(entries.keys()) if entries is not None else []
        except Exception as exc:
            out.append(_fact("undetermined", "warning", "engine",
                             "page.resourcesUnreadable", page=page_number,
                             params={"detail": str(exc)}))
            continue
        for name in names:
            try:
                obj = entries[name]
                key = _identity(obj)
                if key in visited:
                    continue
                visited.add(key)
                subtype = str(obj.get("/Subtype", ""))
            except Exception as exc:
                out.append(_fact("undetermined", "warning", "engine",
                                 "page.resourcesUnreadable", page=page_number,
                                 params={"detail": str(exc)}))
                continue
            if subtype == _IMAGE_SUBTYPE:
                _check_image(obj, name, page_number, out, not_decoded)
                continue
            # A Form XObject and a tiling pattern are both content streams with
            # resources of their own; a shading pattern has neither and drops
            # out here.
            try:
                nested = obj.get("/Resources")
            except Exception as exc:
                out.append(_fact("undetermined", "warning", "engine",
                                 "page.resourcesUnreadable", page=page_number,
                                 params={"detail": str(exc)}))
                continue
            _walk_resources(nested, page_number, out, visited, not_decoded,
                            depth + 1)


def _annotation_resources(page, page_number: int, out: list[dict]) -> list:
    """The normal appearance streams the page renders its annotations through.

    Only ``/AP`` ``/N`` — the appearance a page draws with. Down and rollover
    appearances are drawn during interaction, not as part of the page.
    """
    found: list = []
    try:
        annots = page.obj.get("/Annots")
        items = list(annots) if annots is not None else []
    except Exception as exc:
        out.append(_fact("undetermined", "warning", "engine",
                         "page.resourcesUnreadable", page=page_number,
                         params={"detail": str(exc)}))
        return found
    for annot in items:
        try:
            appearance = annot.get("/AP")
            normal = appearance.get("/N") if appearance is not None else None
            if normal is None:
                continue
            if isinstance(normal, pikepdf.Dictionary) and "/Subtype" not in normal:
                # An appearance SUB-DICTIONARY: one stream per appearance
                # state, keyed by state name.
                states = [normal[key] for key in normal.keys()]
            else:
                states = [normal]
            for state in states:
                found.append(state)
        except Exception as exc:
            out.append(_fact("undetermined", "warning", "engine",
                             "page.resourcesUnreadable", page=page_number,
                             params={"detail": str(exc)}))
    return found


def _image_facts(page, page_number: int, not_decoded: set | None = None) -> list[dict]:
    """Images one page reaches whose stream will not read.

    ``not_decoded`` collects the images whose pixel codec this process does not
    apply; the caller reports them once for the document rather than once per
    image.
    """
    out: list[dict] = []
    sink = not_decoded if not_decoded is not None else set()
    visited: set = set()
    try:
        resources = page.obj.get("/Resources")
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine", "page.resourcesUnreadable",
                      page=page_number, params={"detail": str(exc)})]
    _walk_resources(resources, page_number, out, visited, sink, 0)
    for appearance in _annotation_resources(page, page_number, out):
        try:
            nested = appearance.get("/Resources")
        except Exception as exc:
            out.append(_fact("undetermined", "warning", "engine",
                             "page.resourcesUnreadable", page=page_number,
                             params={"detail": str(exc)}))
            continue
        _walk_resources(nested, page_number, out, visited, sink, 1)
    return out


def _page_facts(pdf, not_decoded: set) -> list[dict]:
    out: list[dict] = []
    try:
        pages = list(pdf.pages)
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine", "pages.unreadable",
                      params={"detail": str(exc)})]
    for index, page in enumerate(pages):
        number = index + 1
        try:
            if page.get("/MediaBox") is None:
                out.append(_fact("skipped", "warning", "engine", "page.mediaBoxMissing",
                                 page=number))
        except Exception as exc:
            out.append(_fact("undetermined", "warning", "engine", "page.unreadable",
                             page=number, params={"detail": str(exc)}))
            continue
        try:
            # Catches a content stream whose FILTER will not decode — the case
            # where nothing on the page can be drawn. It does not catch a
            # malformed operator sequence: qpdf's tokenizer stops at the first
            # unparseable token and reports what it read, which is a partial
            # read the reader recovers from rather than a stream that fails.
            pikepdf.parse_content_stream(page)
        except Exception as exc:
            out.append(_fact("skipped", "warning", "engine", "page.contentUnreadable",
                             page=number, params={"detail": str(exc)}))
        out.extend(_image_facts(page, number, not_decoded))
    return out


def _document_facts(pdf) -> list[dict]:
    """Document-level constructs the app does not render as authored."""
    out: list[dict] = []
    try:
        acroform = pdf.Root.get("/AcroForm")
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine",
                      "document.acroFormUnreadable", params={"detail": str(exc)})]
    if acroform is None:
        return out
    if not isinstance(acroform, pikepdf.Dictionary):
        # A wrong-typed /AcroForm answers the /XFA question with None rather
        # than raising, so the type is checked instead of relied on: whatever
        # this document declares as its form could not be read, and that is
        # undetermined rather than "no form".
        return [_fact("undetermined", "warning", "engine",
                      "document.acroFormUnreadable",
                      params={"detail": type(acroform).__name__})]
    try:
        has_xfa = acroform.get("/XFA") is not None
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine",
                      "document.acroFormUnreadable", params={"detail": str(exc)})]
    if not has_xfa:
        return out
    try:
        # The same classification the XFA editing path uses, so the ledger
        # cannot call skipped a form the product fills. Only a form whose
        # fields exist solely in the XML is outside what is rendered.
        form_class = xfa.classify(pdf)
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine",
                      "document.xfaUnreadable", params={"detail": str(exc)})]
    if form_class == xfa.DYNAMIC:
        out.append(_fact("skipped", "info", "engine", "document.xfa"))
    return out


def document_health(file: str) -> dict:
    """Collect health facts for one document without modifying it.

    Never raises for a damaged document: unreadability is a RESULT
    (``status`` of ``undetermined`` plus the fact that says so), because a
    refusal here would be indistinguishable, in a ledger that stores only
    facts, from a document that had nothing to report.

    Args:
        file: Input PDF path.
    """
    input_path = Path(file)
    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {file}")

    result: dict = {
        "file": str(input_path),
        "size_bytes": os.path.getsize(file),
        # "collected" means every traversal ran to the end. "undetermined"
        # means at least one could not, and the ledger must not read the
        # facts that did arrive as a complete answer.
        "status": "collected",
        "facts": [],
    }

    try:
        pdf = pikepdf.open(file, suppress_warnings=True)
    except pikepdf.PasswordError:
        result["status"] = "undetermined"
        result["facts"].append(
            _fact("undetermined", "info", "engine", "document.encrypted")
        )
        return result
    except Exception as exc:
        result["status"] = "undetermined"
        result["facts"].append(
            _fact("undetermined", "warning", "engine", "document.unreadable",
                  params={"detail": str(exc)})
        )
        return result

    not_decoded: set = set()
    with pdf:
        facts = _qpdf_facts(pdf)
        facts.extend(_document_facts(pdf))
        facts.extend(_page_facts(pdf, not_decoded))
        facts.extend(_font_facts(pdf))
    if not_decoded:
        # Stated once for the document: these images' bytes are present and
        # their pixels were never decoded here. Reported so the ledger cannot
        # be read as having checked them, at info severity because nothing was
        # found wrong — an unchecked image is not a damaged one.
        facts.append(_fact("skipped", "info", "engine", "document.imagesNotDecoded",
                           params={"count": len(not_decoded)}))

    result["facts"] = facts
    if any(f["kind"] == "undetermined" for f in facts):
        result["status"] = "undetermined"
    return result
