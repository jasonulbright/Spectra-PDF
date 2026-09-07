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

import os
from pathlib import Path

import pikepdf

from engine.font_embedding import font_embedded
from engine.font_inventory import walk_document_fonts

# A page image is checked for stream integrity, not decoded: decoding every
# raster on every open would cost a full render, and a filter that decodes
# here can still fail in the viewer's own decoder. An image whose bytes read
# but whose pixels do not is outside what this boundary can see.
_IMAGE_SUBTYPE = "/Image"

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
    return "structure.repaired"


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
    seen: list[str] = []
    for text in warnings:
        code = _classify_warning(str(text))
        if code is not None and code not in seen:
            seen.append(code)
    if not seen and warnings:
        seen.append("structure.repaired")
    return [_fact("recovered", "warning", "qpdf", code) for code in seen]


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


def _image_facts(page, page_number: int) -> list[dict]:
    """Image XObjects on one page whose stream will not read.

    Raw bytes only — see ``_IMAGE_SUBTYPE``.
    """
    out: list[dict] = []
    try:
        resources = page.obj.get("/Resources")
        xobjects = resources.get("/XObject") if resources is not None else None
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine", "page.resourcesUnreadable",
                      page=page_number, params={"detail": str(exc)})]
    if xobjects is None:
        return out
    try:
        names = list(xobjects.keys())
    except Exception as exc:
        return [_fact("undetermined", "warning", "engine", "page.resourcesUnreadable",
                      page=page_number, params={"detail": str(exc)})]
    for name in names:
        try:
            obj = xobjects[name]
            if str(obj.get("/Subtype", "")) != _IMAGE_SUBTYPE:
                continue
            obj.read_raw_bytes()
        except Exception as exc:
            out.append(_fact("skipped", "warning", "engine", "page.imageUnreadable",
                             page=page_number,
                             params={"name": str(name).lstrip("/"),
                                     "detail": str(exc)}))
    return out


def _page_facts(pdf) -> list[dict]:
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
        out.extend(_image_facts(page, number))
    return out


def _document_facts(pdf) -> list[dict]:
    """Document-level constructs the app does not render as authored."""
    out: list[dict] = []
    try:
        acroform = pdf.Root.get("/AcroForm")
        has_xfa = acroform is not None and acroform.get("/XFA") is not None
    except Exception:
        has_xfa = False
    if has_xfa:
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

    with pdf:
        facts = _qpdf_facts(pdf)
        facts.extend(_document_facts(pdf))
        facts.extend(_page_facts(pdf))
        facts.extend(_font_facts(pdf))

    result["facts"] = facts
    if any(f["kind"] == "undetermined" for f in facts):
        result["status"] = "undetermined"
    return result
