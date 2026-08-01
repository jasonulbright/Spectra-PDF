"""Persistent redaction marks (F10): real /Redact annotations.

The canvas's pending marks are TRANSIENT view state by invariant (positional
ids + a destructive tool — see lib/redaction.ts). Persistence therefore
lives in the FILE, in the format's own vocabulary: the /Redact annotation
subtype, the mark-then-apply object Acrobat writes. Save replaces the file's
/Redact set with the current marks (idempotent — saving twice is saving
once); on open or reload the renderer lists them and re-seeds its transient
marks; APPLYING redactions consumes them naturally, because the redaction
engine removes every annotation overlapping an applied region (fail-closed,
the R2 rule) — an applied mark cannot survive its own application.

The annotations carry an appearance (red outline box) so OTHER viewers show
the marks; /F stays 0 — a pending redaction mark must never PRINT as if it
were content. Saving onto a SIGNED document lands as an incremental append
like the rest of the annotation tier (O5b).
"""

import shutil
import tempfile
from pathlib import Path

import pikepdf

from .incremental import finalize_preserving_signatures
from .validate import validate_pdf


def _strip_redact_annots(pdf: pikepdf.Pdf) -> int:
    removed = 0
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if annots is None:
            continue
        kept = []
        for a in annots:
            try:
                is_redact = a.get("/Subtype") == pikepdf.Name("/Redact")
            except Exception:
                is_redact = False
            if is_redact:
                removed += 1
            else:
                kept.append(a)
        if removed:
            if kept:
                page.obj["/Annots"] = pikepdf.Array(kept)
            elif "/Annots" in page.obj:
                del page.obj["/Annots"]
    return removed


def save_redaction_marks(file: str, output: str, regions: list) -> dict:
    """Write the current marks as the file's /Redact annotation set.

    ``regions``: [{page (1-based), rect [x0,y0,x1,y1] in PDF user space}] —
    the exact payload shape the redaction APPLY sends, so the two flows
    cannot disagree about geometry. Replaces any existing /Redact set.
    """
    validate_pdf(file)
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    with pikepdf.open(file) as pdf:
        removed = _strip_redact_annots(pdf)
        added = 0
        for spec in regions or []:
            page_no = int(spec["page"])
            if not (1 <= page_no <= len(pdf.pages)):
                raise ValueError(f"page {page_no} is out of range (1-{len(pdf.pages)})")
            raw = [float(v) for v in spec["rect"]]
            if len(raw) != 4:
                raise ValueError("rect must be [x0, y0, x1, y1]")
            x0, y0 = min(raw[0], raw[2]), min(raw[1], raw[3])
            x1, y1 = max(raw[0], raw[2]), max(raw[1], raw[3])
            if x1 - x0 <= 0 or y1 - y0 <= 0:
                raise ValueError("rect must have a positive width and height")
            w, h = x1 - x0, y1 - y0
            ap = pdf.make_stream(
                f"1 0 0 RG 1.5 w 0.75 0.75 {w - 1.5:.2f} {h - 1.5:.2f} re S".encode("ascii")
            )
            ap.stream_dict["/Type"] = pikepdf.Name("/XObject")
            ap.stream_dict["/Subtype"] = pikepdf.Name("/Form")
            ap.stream_dict["/BBox"] = pikepdf.Array([0, 0, w, h])
            annot = pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name("/Annot"),
                Subtype=pikepdf.Name("/Redact"),
                Rect=pikepdf.Array([x0, y0, x1, y1]),
                # /IC: the fill applied redactions get (the format's black).
                IC=pikepdf.Array([0, 0, 0]),
                C=pikepdf.Array([1, 0, 0]),
                F=0,  # visible on screen, never printed as if it were content
                AP=pikepdf.Dictionary(N=ap),
            ))
            page = pdf.pages[page_no - 1]
            existing = page.obj.get("/Annots")
            page.obj["/Annots"] = (
                pikepdf.Array([*existing, annot]) if existing is not None else pikepdf.Array([annot])
            )
            added += 1

        if same_file:
            with tempfile.NamedTemporaryFile(
                suffix=".pdf", delete=False, dir=str(input_path.parent)
            ) as tmp:
                tmp_path = tmp.name
            pdf.save(tmp_path)
        else:
            pdf.save(output_path)

    landed = tmp_path if same_file else str(output_path)
    preserved = finalize_preserving_signatures(str(input_path), landed)
    if same_file:
        shutil.move(tmp_path, str(output_path))

    out = {"output": str(output_path), "saved": added, "removed_previous": removed}
    if preserved.get("preserved"):
        out["signatures_preserved"] = True
    return out


def list_redact_annotations(file: str) -> dict:
    """The file's /Redact set — what re-seeds the canvas marks on open."""
    validate_pdf(file)
    marks = []
    with pikepdf.open(file) as pdf:
        for i, page in enumerate(pdf.pages):
            annots = page.obj.get("/Annots")
            if annots is None:
                continue
            for a in annots:
                try:
                    if a.get("/Subtype") != pikepdf.Name("/Redact"):
                        continue
                    rect = [float(v) for v in a.get("/Rect")]
                except Exception:
                    continue
                if len(rect) != 4:
                    continue
                marks.append({"page": i + 1, "rect": rect})
    return {"marks": marks, "count": len(marks)}
