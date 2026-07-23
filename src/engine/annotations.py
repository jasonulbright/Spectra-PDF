"""Comment/markup annotation overview and bulk delete (§ I.2 / I.6).

The canvas edits the four annotation kinds it authors (Square/FreeText/Ink/
Stamp). This module works at the whole-document level over EVERY markup
annotation — including native Highlight/Underline/StrikeOut/Text/Link the editor
doesn't import inline — to (a) summarise what comments a document carries and
(b) delete them all ("Delete All Comments", an Acrobat staple). It is a
whole-file op: the renderer routes it through the snapshot/commit flow and
re-indexes afterward, so it never fights the inline annotation lifecycle.

Form fields (/Widget) and links (/Link) are NOT comments and are kept, matching
the king's "Delete All Comments".
"""

import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Array, Name

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


def delete_all_annotations(file: str, output: str) -> dict:
    """Remove every markup annotation (and its popup). Keeps form fields and
    links. A page left with no annotations drops its /Annots entirely."""
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    removed = 0
    with pikepdf.open(file) as pdf:
        for page in pdf.pages:
            annots = page.obj.get("/Annots")
            if annots is None:
                continue
            kept = []
            for a in annots:
                try:
                    subtype = str(a.get("/Subtype"))
                except Exception:
                    kept.append(a)
                    continue
                if subtype in _SWEEP:
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
            pdf.save(tmp_path)
        else:
            pdf.save(output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {"output": str(output_path), "removed": removed}
