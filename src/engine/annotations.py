"""Comment/markup annotation overview and bulk delete.

The canvas edits the four annotation kinds it authors (Square/FreeText/Ink/
Stamp). This module works at the whole-document level over EVERY markup
annotation — including native Highlight/Underline/StrikeOut/Text/Link the editor
doesn't import inline — to (a) summarise what comments a document carries and
(b) delete them all. It is a
whole-file op: the renderer routes it through the snapshot/commit flow and
re-indexes afterward, so it never fights the inline annotation lifecycle.

Form fields (/Widget) and links (/Link) are not comments and are kept.
"""

import re
import shutil
import tempfile
from pathlib import Path
from typing import NamedTuple

import pikepdf
from pikepdf import Array, Name
from engine.pdf_save import save_pdf

# Subtypes that count as a "comment"/markup annotation (everything except the
# structural Widget/Link/Popup — Popup rides its parent and is swept with it).
_MARKUP = {
    "/Text", "/FreeText", "/Line", "/Square", "/Circle", "/Polygon", "/PolyLine",
    "/Highlight", "/Underline", "/Squiggly", "/StrikeOut", "/Stamp", "/Caret",
    "/Ink", "/FileAttachment", "/Sound", "/Redact",
}
_SWEEP = _MARKUP | {"/Popup"}


def _rect(annot):
    try:
        r = [float(v) for v in annot.get("/Rect")]
        if len(r) == 4:
            return [min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3])]
    except (TypeError, ValueError):
        pass
    return None


def _str(annot, key):
    try:
        v = annot.get(key)
        return str(v) if v is not None else ""
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# The relationship an /IRT names
# ---------------------------------------------------------------------------

#: The two relationships the format defines, and the third state.
#:
#: /R and /Group are not spellings of one idea: a group moves, cuts and copies
#: as a single unit while a reply displays as a threaded comment, so naming one
#: where the document holds the other is a wrong artifact rather than a
#: differently worded one. UNKNOWN is what a reader answers when the document
#: names a relationship outside the pair or will not yield one at all; it is
#: never folded into REPLY, because REPLY is also what an absent /RT means and
#: the two callers could not then be told apart.
REPLY = "reply"
GROUP = "group"
UNKNOWN = "unknown"

_RELATIONSHIP = {"/R": REPLY, "/Group": GROUP}

#: A /RT spelling that survives the trip back into a PDF name. Anything else
#: cannot be transcribed and the write refuses on it.
_NAME_TOKEN = re.compile(r"[A-Za-z0-9_.\-]+")


class Relationship(NamedTuple):
    """What one annotation's /IRT and /RT say, without deciding for the caller.

    `kind` is None only when there is no target at all — /RT is meaningful
    only beside an /IRT, so a lone /RT names no relationship and is reported
    through `name` instead. `name` is the raw /RT spelling without its slash,
    so a caller that TRANSCRIBES carries what the document holds while a caller
    that CLASSIFIES sees UNKNOWN; those are different jobs and this type serves
    both without either guessing. `readable` is False when a key would not
    read, which is the state a write must refuse on rather than resolve.
    """

    target: object | None
    kind: str | None
    name: str | None
    readable: bool


def reply_relationship(annot) -> Relationship:
    """The /IRT target and the /RT relationship for one annotation.

    An /IRT with no /RT is a reply: the format supplies that default, so it is
    an answer rather than an absence.
    """
    try:
        target = annot.get("/IRT")
    except Exception:
        return Relationship(None, UNKNOWN, None, False)
    try:
        raw = annot.get("/RT")
    except Exception:
        return Relationship(target, UNKNOWN, None, False)
    if target is None:
        name = None
        if raw is not None:
            spelling = str(raw)
            if spelling.startswith("/"):
                name = spelling[1:]
        return Relationship(None, None, name, True)
    if raw is None:
        return Relationship(target, REPLY, None, True)
    if not isinstance(raw, pikepdf.Name):
        return Relationship(target, UNKNOWN, None, False)
    spelling = str(raw)
    kind = _RELATIONSHIP.get(spelling, UNKNOWN)
    return Relationship(target, kind, spelling[1:], True)


def relationship_name(kind: str | None, name: str | None) -> str | None:
    """The /RT spelling to write for a relationship, or None when there is
    none to write. A REPLY with no recorded spelling writes the default's own
    name, so a file this product authors never leaves the next reader to
    supply it."""
    if name is not None:
        return name
    if kind == REPLY:
        return "R"
    return None


def usable_relationship_name(value: str) -> str | None:
    """A `replyType` from an interchange file as a PDF name, or None when it
    cannot be one. The two defined relationships match without regard to case
    — producers write them lowercase — and everything else is carried through
    exactly as written."""
    text = (value or "").strip().lstrip("/")
    if not text or _NAME_TOKEN.fullmatch(text) is None:
        return None
    for spelling in _RELATIONSHIP:
        if text.casefold() == spelling[1:].casefold():
            return spelling[1:]
    return text


def list_annotations(file: str) -> dict:
    """Every markup annotation, with page, subtype, rect, and its text/author."""
    with pikepdf.open(file) as pdf:
        out = []
        by_type: dict[str, int] = {}
        for i, page in enumerate(pdf.pages):
            annots = page.obj.get("/Annots")
            if annots is None:
                continue
            for a in annots:
                try:
                    subtype = str(a.get("/Subtype"))
                except Exception:
                    continue
                if subtype not in _MARKUP:
                    continue
                kind = subtype.lstrip("/")
                by_type[kind] = by_type.get(kind, 0) + 1
                out.append({
                    "page": i + 1,
                    "subtype": kind,
                    "rect": _rect(a),
                    "contents": _str(a, "/Contents"),
                    "author": _str(a, "/T"),
                })
        return {"annotations": out, "count": len(out), "by_type": by_type}


#: /F bit position 3 — "print". An annotation without it never reaches a
#: plate, which is why a preflight sweep can be narrowed to the ones that do.
_PRINT_FLAG = 1 << 2


def _prints(annot) -> bool:
    try:
        return bool(int(annot.get("/F", 0)) & _PRINT_FLAG)
    except (TypeError, ValueError, AttributeError):
        return False


def _sweep_set(subtypes) -> set:
    """The subtypes one call removes. An empty selection is the shipped markup
    set, never nothing — an empty list would silently remove no annotation and
    report a success."""
    if not subtypes:
        return set(_SWEEP)
    wanted = {f"/{str(s).lstrip('/')}" for s in subtypes}
    unknown = sorted(s for s in wanted if s not in _MARKUP)
    if unknown:
        raise ValueError(
            "not a comment annotation subtype: "
            f"{', '.join(s.lstrip('/') for s in unknown)}"
        )
    # A popup rides its parent, so it is swept with whatever it belongs to
    # rather than needing to be named.
    return wanted


def delete_all_annotations(file: str, output: str, subtypes: list | None = None,
                           printing_only: bool = False) -> dict:
    """Remove markup annotations (and their popups). Keeps form fields and
    links. A page left with no annotations drops its /Annots entirely.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        subtypes: Restrict the sweep to these comment subtypes; empty = all.
        printing_only: Remove only annotations flagged to print. A note that
            never reaches a plate is not what a press job is asking about, and
            removing it would take a comment the reader wanted to keep.
    """
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    wanted = _sweep_set(subtypes)
    removed = 0
    with pikepdf.open(file) as pdf:
        for page in pdf.pages:
            annots = page.obj.get("/Annots")
            if annots is None:
                continue
            # A popup whose parent is swept goes with it whatever its own
            # flags say — an orphan popup is a comment with nothing to open.
            doomed_popups: set = set()
            for a in annots:
                try:
                    if str(a.get("/Subtype")) not in wanted:
                        continue
                    if printing_only and not _prints(a):
                        continue
                    popup = a.get("/Popup")
                except Exception:
                    continue
                if popup is not None:
                    try:
                        doomed_popups.add(popup.objgen)
                    except AttributeError:
                        pass
            kept = []
            for a in annots:
                try:
                    subtype = str(a.get("/Subtype"))
                except Exception:
                    kept.append(a)
                    continue
                try:
                    is_doomed_popup = a.objgen in doomed_popups
                except AttributeError:
                    is_doomed_popup = False
                if is_doomed_popup or (
                    subtype in wanted and not (printing_only and not _prints(a))
                ):
                    removed += 1
                    continue
                kept.append(a)
            if kept:
                page.obj["/Annots"] = Array(kept)
            elif "/Annots" in page.obj:
                del page.obj["/Annots"]

        if same_file:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, dir=str(input_path.parent)) as tmp:
                tmp_path = tmp.name
            save_pdf(pdf, tmp_path)
        else:
            save_pdf(pdf, output_path)

    # On a signed input the landed bytes become an incremental append
    # (original verbatim + one revision), so sweeping comments never breaks
    # the signature. The staged/landed rewrite stands when not applicable.
    from engine.incremental import finalize_preserving_signatures

    landed = tmp_path if same_file else str(output_path)
    preserved = finalize_preserving_signatures(str(input_path), landed)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    out = {"output": str(output_path), "removed": removed}
    if preserved.get("preserved"):
        out["signatures_preserved"] = True
    return out
