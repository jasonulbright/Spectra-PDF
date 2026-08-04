"""Count & takeoff summary export (N11 slice C).

A count mark is a real `/Stamp` annotation carrying `/IT /Count`, its group in
`/Subj`, `"<group> <seq>"` in `/Contents`, and the private `/SpectraSymbol`
naming the marker's vector symbol (the shipped `/SpectraMask` precedent). This
module reads those marks straight out of a file and writes the takeoff summary
as CSV.

Two properties are load-bearing:

* **The tally is DERIVED, never stored.** Nothing in the document records a
  total; a total is counted, here, from the marks that exist. Storing one is
  how a total goes stale.
* **`/IT /Count` is the whole gate.** A `/Stamp` without it is somebody's
  APPROVED stamp, not a count mark, and must not be tallied — asserted by a
  pytest that puts both in one file.

Column headers are generated ENGLISH at the writer, like every other engine
output; the group names in the rows are the user's own text and pass through
verbatim (the `measure.ts` format-string rule, N12 slice C).
"""

from __future__ import annotations

import csv
from pathlib import Path

import pikepdf

COUNT_INTENT = "/Count"

#: CSV header, English at the engine (see the module docstring).
COLUMNS = ["Group", "Symbol", "Page", "Count"]

#: What a mark whose `/Subj` is missing or empty is filed under. A mark we
#: wrote always has one; a foreign `/IT /Count` stamp might not, and dropping
#: it would under-report a total the file plainly contains.
UNGROUPED = "Ungrouped"


def _text(value) -> str:
    if value is None:
        return ""
    try:
        return str(value)
    except Exception:
        return ""


def _symbol(annot) -> str:
    """The private `/SpectraSymbol` marker id, or "" when absent.

    A `/Name` renders as "/circle"; strip the solidus so the CSV carries the
    id the app uses rather than the PDF spelling of it.
    """
    raw = _text(annot.get("/SpectraSymbol"))
    return raw[1:] if raw.startswith("/") else raw


def _is_count_mark(annot) -> bool:
    try:
        if _text(annot.get("/Subtype")) != "/Stamp":
            return False
        return _text(annot.get("/IT")) == COUNT_INTENT
    except Exception:
        return False


def collect_count_marks(file: str) -> list[dict]:
    """Every count mark in the file, in page order.

    Separated from the CSV writer so the grouping is testable without a
    filesystem round trip.
    """
    marks: list[dict] = []
    with pikepdf.open(file) as pdf:
        for page_index, page in enumerate(pdf.pages):
            annots = page.obj.get("/Annots")
            if annots is None:
                continue
            for annot in annots:
                if not _is_count_mark(annot):
                    continue
                group = _text(annot.get("/Subj")).strip() or UNGROUPED
                marks.append(
                    {
                        "group": group,
                        "symbol": _symbol(annot),
                        "page": page_index + 1,  # 1-based: the CSV is for humans
                        "contents": _text(annot.get("/Contents")),
                    }
                )
    return marks


def summarize_counts(marks: list[dict]) -> list[dict]:
    """Group × page rows, ordered by group name then page number.

    The symbol reported for a group is the FIRST one seen in it: a group has
    one marker by construction, and a file hand-edited into disagreeing with
    itself should still report a row rather than nothing.
    """
    buckets: dict[tuple[str, int], dict] = {}
    for mark in marks:
        key = (mark["group"], mark["page"])
        row = buckets.get(key)
        if row is None:
            buckets[key] = {
                "group": mark["group"],
                "symbol": mark["symbol"],
                "page": mark["page"],
                "count": 1,
            }
        else:
            row["count"] += 1
            if not row["symbol"]:
                row["symbol"] = mark["symbol"]
    return sorted(buckets.values(), key=lambda r: (r["group"], r["page"]))


def export_count_summary(file: str, output: str) -> dict:
    """Write the takeoff summary of `file`'s count marks to `output` as CSV.

    Columns `Group, Symbol, Page, Count`, one row per group per page, plus a
    `Total` row. A file with no count marks writes the header and the zero
    total — an empty takeoff is an answer, not an error.
    """
    marks = collect_count_marks(file)
    rows = summarize_counts(marks)
    total = sum(row["count"] for row in rows)
    out_path = Path(output)
    if out_path.parent and not out_path.parent.exists():
        raise ValueError(f"Output folder does not exist: {out_path.parent}")
    # newline="" is the csv module's contract on Windows — without it every
    # record ends \r\r\n and half the spreadsheet importers show blank rows.
    with out_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(COLUMNS)
        for row in rows:
            writer.writerow([row["group"], row["symbol"], row["page"], row["count"]])
        writer.writerow(["Total", "", "", total])
    return {
        "output": str(out_path),
        "groups": len({row["group"] for row in rows}),
        "rows": len(rows),
        "total": total,
    }
