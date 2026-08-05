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

F12: a mark this module cannot ACCOUNT FOR refuses, loudly, naming how many
and where. Both entry points read the file through one scanner (`_scan`), so
the listing the canvas seeds from and the save that replaces the stored set
cannot disagree about what the document carries.
"""

import math
import shutil
import tempfile
from pathlib import Path

import pikepdf

from .incremental import finalize_preserving_signatures
from .validate import validate_pdf


def _page_annots(page) -> tuple[list, bool]:
    """The page's /Annots entries, and whether the ARRAY itself resolved.

    A `/Annots` that will not resolve is not an empty page: its contents are
    unaccountable, and under F12 that is reported rather than assumed to hold
    no marks.
    """
    try:
        annots = page.obj.get("/Annots")
        if annots is None:
            return [], True
        return list(annots), True
    except Exception:
        return [], False


def _entry_kind(entry) -> str:
    """`redact` / `other` / `unreadable`, for one /Annots entry.

    A NULL or otherwise non-dictionary entry is `other`, not `unreadable`:
    producers do leave nulls in /Annots, and an entry that is not a dictionary
    carries no /Subtype at all, so it cannot be a redaction mark — a proof,
    not a guess. What is UNREADABLE is a dictionary whose /Subtype will not
    resolve: it might be a mark, and a mark that cannot be accounted for is
    reported, never skipped.
    """
    try:
        if not isinstance(entry, pikepdf.Dictionary):
            return "other"
        return "redact" if entry.get("/Subtype") == pikepdf.Name("/Redact") else "other"
    except Exception:
        return "unreadable"


def _mark_rect(annot) -> list[float] | None:
    """A mark's /Rect as four finite floats, or None when it will not read.

    None is a REFUSAL trigger, never a skip. A non-finite value counts as
    unreadable: it coerces to a float but names no region, so seeding it
    would put a mark nowhere and applying it would redact nothing.
    """
    try:
        raw = [float(v) for v in annot.get("/Rect")]
    except Exception:
        return None
    if len(raw) != 4 or not all(math.isfinite(v) for v in raw):
        return None
    return raw


def _scan(pdf: pikepdf.Pdf) -> list[dict]:
    """Per page: the non-/Redact entries to KEEP, the marks' rects, and how
    many entries could not be accounted for."""
    pages: list[dict] = []
    for page in pdf.pages:
        entries, resolved = _page_annots(page)
        rec = {"kept": [], "marks": [], "unreadable": 0 if resolved else 1}
        for entry in entries:
            kind = _entry_kind(entry)
            if kind == "unreadable":
                rec["unreadable"] += 1
            elif kind == "other":
                rec["kept"].append(entry)
            else:
                rect = _mark_rect(entry)
                if rect is None:
                    rec["unreadable"] += 1
                else:
                    rec["marks"].append(rect)
        pages.append(rec)
    return pages


def _refuse_unreadable(pages: list[dict]) -> None:
    """F12 — REFUSE when the document carries marks we cannot account for.

    This is R2's shape one module over. `_annot_overlaps` was made to fail
    CLOSED because a redaction tool's only tolerable error is removing too
    much; a LISTING has no "too much" available to it, so its fail-closed is
    the refusal. Skipping was the entire defect: the reply's `count` counted
    survivors, so nothing downstream could notice a mark had gone missing —
    a user who saved marks, reopened and applied would permanently keep the
    content they marked, and be told it succeeded.
    """
    where = [str(i + 1) for i, rec in enumerate(pages) if rec["unreadable"]]
    if not where:
        return
    count = sum(int(rec["unreadable"]) for rec in pages)
    # A bare page LIST, not a phrase: the renderer inserts a captured value
    # verbatim, so wording that has to read in eight languages belongs in the
    # message (and its catalog entries), never in the interpolation.
    location = ", ".join(where)
    raise ValueError(
        f"{count} redaction mark(s) in this document cannot be read (page(s) "
        f"{location}). A mark whose annotation or /Rect will not resolve is neither "
        "shown nor applied, so redacting now would leave marked content in place. "
        "Repair the document first."
    )


def _strip_redact_annots(pdf: pikepdf.Pdf, pages: list[dict]) -> int:
    """Replace each page's /Annots with its non-/Redact entries. `pages` is
    `_scan`'s result, already checked by `_refuse_unreadable` — so nothing is
    dropped here that was not classified first."""
    removed = 0
    for page, rec in zip(pdf.pages, pages):
        if not rec["marks"]:
            continue  # per PAGE: an untouched page keeps its own array object
        removed += len(rec["marks"])
        if rec["kept"]:
            page.obj["/Annots"] = pikepdf.Array(rec["kept"])
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
        scanned = _scan(pdf)
        # BEFORE any mutation: a replace over a set we cannot read would drop
        # or keep marks arbitrarily, which is the same silence from the other
        # direction (F12).
        _refuse_unreadable(scanned)
        removed = _strip_redact_annots(pdf, scanned)
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
    """The file's /Redact set — what re-seeds the canvas marks on open.

    Refuses when any mark cannot be accounted for (F12): `count` counts
    survivors, so a partial listing is indistinguishable from a complete one
    at every layer above this — the caller must be told, not handed fewer
    marks than the document holds.
    """
    validate_pdf(file)
    marks = []
    with pikepdf.open(file) as pdf:
        scanned = _scan(pdf)
        _refuse_unreadable(scanned)
        for i, rec in enumerate(scanned):
            for rect in rec["marks"]:
                marks.append({"page": i + 1, "rect": rect})
    return {"marks": marks, "count": len(marks)}
