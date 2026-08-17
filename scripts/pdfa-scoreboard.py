"""MAINTENANCE TOOL, not a build step. Runs this product's own readers over
the fetched conformance corpora and writes
`pdfa-corpus/scoreboard.json` (gitignored, like everything else under there).

THIS IS A SCOREBOARD, NOT A TARGET

Passing every file in a conformance suite means agreeing with the judgement of
whoever authored the files, which is not the same as implementing the clause —
BFO marks two of its own cases *contentious*, and the veraPDF corpus ships an
`Undefined/` tree of cases its authors decline to call. So this tool records
what we do against each stated verdict and leaves the interpreting to a person.
A file we agree with that no stated rule explains is FLAGGED, not counted as a
win.

WHAT IT MEASURES, AND WHY THAT IS THE HONEST SET TODAY

There is no PDF/A validator in this tree — that absence is register row O18 and
this tool exists to size it rather than to hide it. The shipped preflight
profiles are press and PDF/X profiles; none of them is PDF/A. What the product
genuinely does with an arbitrary file is therefore what gets measured:

  opens      `validate_pdf` — the door every whole-file op goes through. A
             conformance corpus is deliberately malformed, so this is the one
             pass that can find a defect in OUR code rather than a gap in our
             coverage: an unhandled exception here is a crash on a real file.
  declared   `standards_report.declared_pdfa` — what the file asserts about
             itself. `convert_pdfa` already refuses when this disagrees with
             what was asked for, so it is a shipped decision point.
  checks     the accessibility checks, for the PDF/UA parts, and the preflight
             checks, for the rest. Both report per check, so a fired check can
             be attributed to a clause.

A run records raw outcomes per file. Attributing a check to a clause is a
separate judgement and is NOT done here; the mapping is what the next round
builds, and inventing it inside the measurement would grade our own work.

Run: .venv/Scripts/python.exe scripts/pdfa-scoreboard.py [--limit N] [--part PDF/A-1b]
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from collections import Counter, defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CORPUS = REPO_ROOT / "pdfa-corpus"
INDEX = CORPUS / "clause-index.json"
OUT = CORPUS / "scoreboard.json"

sys.path.insert(0, str(REPO_ROOT / "src"))


def _read_index() -> dict:
    if not INDEX.is_file():
        raise SystemExit(
            "pdfa-corpus/clause-index.json is absent — run "
            "scripts/fetch-pdfa-corpus.py then scripts/pdfa-clause-index.py"
        )
    return json.loads(INDEX.read_text(encoding="utf-8"))


def _measure(path: Path) -> dict:
    """One file, through the doors the product actually uses.

    Every call is caught by name. A raise IS the measurement here — the corpus
    is malformed on purpose, and a reader that dies on a malformed file is a
    defect of ours whatever the file's verdict says.
    """
    from engine import standards_report
    from engine.validate import validate_pdf

    row: dict = {"opens": None, "pages": None, "declared": None, "errors": []}

    try:
        info = validate_pdf(str(path))
        row["opens"] = True
        row["pages"] = info.get("pages")
    except Exception as exc:  # noqa: BLE001 — the point is to name every shape
        row["opens"] = False
        row["errors"].append({"where": "validate_pdf", "error": f"{type(exc).__name__}: {exc}"})

    try:
        row["declared"] = standards_report.declared_pdfa(path) or ""
    except Exception as exc:  # noqa: BLE001
        row["errors"].append({"where": "declared_pdfa", "error": f"{type(exc).__name__}: {exc}"})

    return row


def _accessibility(path: Path) -> dict:
    """The 32 accessibility checks, reduced to what a verdict can be compared to.

    `fired` is the set of checks whose status is `fail`. `needs_review` is kept
    separate and NEVER counted as a fire: this product's fail-open discipline
    says a check that could not decide reports that it could not decide, and
    folding it into either column would throw away the one distinction the
    round before this one was spent creating.
    """
    from engine.accessibility import check_accessibility

    try:
        report = check_accessibility(str(path))
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}
    fired, review = [], []
    for check in report.get("checks", []):
        if check.get("status") == "fail":
            fired.append(check["id"])
        elif check.get("status") == "needs_review":
            review.append(check["id"])
    return {
        "fired": sorted(fired),
        "needs_review": sorted(review),
        "summary": report.get("summary", {}),
        "unreadable": report.get("unreadable", []),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=0, help="stop after N files")
    parser.add_argument("--part", default="", help="only this part, e.g. PDF/A-1b")
    args = parser.parse_args()

    index = _read_index()
    targets: list[dict] = []
    for entry in index["clauses"]:
        if args.part and entry["part"] != args.part:
            continue
        for f in entry["files"]:
            if not f["path"] or not f["verdict"]:
                continue
            targets.append(
                {
                    "part": entry["part"],
                    "clause": entry["clause"],
                    "title": entry["titles"][0] if entry["titles"] else None,
                    "rule": f.get("rule"),
                    "suite": f["suite"],
                    "path": f["path"],
                    "expected": f["verdict"],
                }
            )
    if args.limit:
        targets = targets[: args.limit]

    rows: list[dict] = []
    opens = Counter()
    declared = Counter()
    crashes: list[dict] = []
    for n, target in enumerate(targets, 1):
        path = CORPUS / target["path"]
        try:
            measured = _measure(path)
        except Exception:  # noqa: BLE001 — a raise the per-call guards missed
            measured = {
                "opens": None,
                "pages": None,
                "declared": None,
                "errors": [{"where": "measure", "error": traceback.format_exc(limit=3)}],
            }
        # The accessibility checks are the ONE set this product ships that a
        # conformance corpus can score directly, so the PDF/UA parts get them.
        # Nothing equivalent exists for PDF/A — the shipped preflight profiles
        # are press and PDF/X — and that absence is O18, measured below rather
        # than papered over with a nearby check.
        if target["part"].startswith("PDF/UA"):
            measured["accessibility"] = _accessibility(path)
        row = dict(target, **measured)
        rows.append(row)
        opens[row["opens"]] += 1
        declared[(row["declared"] or "").upper() or "(none)"] += 1
        if row["errors"]:
            crashes.append(row)
        if n % 250 == 0:
            print(f"  {n}/{len(targets)}")

    by_part: dict[str, Counter] = defaultdict(Counter)
    for row in rows:
        by_part[row["part"]][row["expected"]] += 1

    # Agreement, only where a check set exists. Four outcomes, and the two that
    # matter are named rather than summed: a MISS is a clause we do not cover,
    # a FALSE ALARM is a conformant file we would flag — a defect, not a gap.
    agreement: dict[str, Counter] = defaultdict(Counter)
    false_alarms: list[dict] = []
    unexplained_passes: list[dict] = []
    for row in rows:
        access = row.get("accessibility")
        if not access or "error" in access:
            continue
        fired = bool(access["fired"])
        if row["expected"] == "fail":
            agreement[row["part"]]["caught" if fired else "missed"] += 1
        else:
            agreement[row["part"]]["clean" if not fired else "false alarm"] += 1
            if fired:
                false_alarms.append(
                    {"path": row["path"], "clause": row["clause"], "fired": access["fired"]}
                )
        # Agreeing with a file whose clause states no rule is corroboration we
        # cannot explain, which is exactly what this project refuses to count.
        if row["expected"] == "fail" and fired and not row.get("rule"):
            unexplained_passes.append({"path": row["path"], "clause": row["clause"]})

    report = {
        "note": (
            "Generated by scripts/pdfa-scoreboard.py over a gitignored corpus. A "
            "scoreboard, not a target: agreement with a suite is corroboration, "
            "never proof that a clause is implemented."
        ),
        "files": len(rows),
        "opens": {str(k): v for k, v in opens.items()},
        "declared": dict(declared.most_common()),
        "by_part": {part: dict(counts) for part, counts in sorted(by_part.items())},
        "agreement": {part: dict(counts) for part, counts in sorted(agreement.items())},
        "false_alarms": false_alarms,
        "unexplained_agreements": unexplained_passes,
        "reader_errors": crashes,
        "rows": rows,
    }
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"files            {len(rows)}")
    print(f"validate_pdf     " + "  ".join(f"{k}={v}" for k, v in sorted(opens.items(), key=str)))
    print(f"reader errors    {len(crashes)}")
    for part, counts in sorted(by_part.items()):
        print(f"  {part:<10} " + "  ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    if agreement:
        print("accessibility checks vs the suite's verdict (PDF/UA only):")
        for part, counts in sorted(agreement.items()):
            print(f"  {part:<10} " + "  ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        print(f"  false alarms          {len(false_alarms)} (we flag a file the suite passes)")
        print(f"  unexplained agreements {len(unexplained_passes)} (caught, no stated rule)")
    print("declared conformance, top 8:")
    for name, count in list(declared.most_common(8)):
        print(f"    {count:>5}  {name}")
    print(f"written          {OUT.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
