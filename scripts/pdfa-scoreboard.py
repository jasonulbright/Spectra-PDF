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
separate judgement and is NOT made here: the judgement lives in
`engine/clause_map.py`, next to the checks it is about, and this tool only
measures it. Inventing the mapping inside the measurement would grade our own
work with our own answer key.

WHAT THE CLAUSE SECTIONS REPORT

  coverage    per part: how many of the part's clauses ANY shipped check
              decides. The denominator is the corpus' clause count for that
              part, which is what the suite covers rather than what the
              standard contains, so the figure is a floor on the gap and never
              a ceiling on it. The uncited checks are listed alongside — a
              coverage figure that hides its own gaps is the thing the map
              exists to stop.
  scoring     per cited clause: the cited checks are run over that clause's
              corpus files and compared to the verdict each file's name
              declares. Two outcomes are findings rather than scores.

              FLAGGED ON PASS — a cited check fails a file the suite passes.
              It is a CANDIDATE false alarm and never called one here: a
              suite's pass verdict is per TEST, so it says the file satisfies
              the rule that test targets, not that the file satisfies every
              requirement of the clause the test is filed under. Deciding
              which of the two a case is takes a person, and the three
              adjudicated so far are recorded in `engine/clause_map.py` and
              the punchlist rather than in a counter.

              UNEVIDENCED CITATION — no fire on any of the clause's failing
              files, so the corpus supports the citation with nothing.

Run: .venv/Scripts/python.exe scripts/pdfa-scoreboard.py [--limit N] [--part PDF/A-1b]
                                                          [--per-clause N] [--skip-clauses]
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


def _clause_coverage(index: dict) -> dict:
    """Per part: which of its clauses any shipped check decides.

    The denominator is the corpus' clause count for the part — what the suite
    covers, not what the standard contains. Stated here because a percentage
    over an unstated denominator is the kind of conformance claim this row
    exists to remove.
    """
    from engine import clause_map

    citations = clause_map.all_citations()
    by_part: dict[str, dict] = defaultdict(lambda: {"cited": {}, "clauses": 0})
    for citation in citations:
        rows = by_part[citation.part]["cited"].setdefault(citation.clause, [])
        rows.append(citation.to_json())

    out: dict[str, dict] = {}
    for entry in index["clauses"]:
        part = entry["part"]
        out.setdefault(part, {"clauses": 0, "cited_clauses": 0, "cited": {}})
        out[part]["clauses"] += 1
        cited = by_part.get(part, {}).get("cited", {}).get(entry["clause"])
        if cited:
            out[part]["cited_clauses"] += 1
            out[part]["cited"][entry["clause"]] = cited

    # A citation naming a clause the corpus does not carry, split by where the
    # citation came from. For a `held` citation this is ordinary — the suite
    # simply carries no file for that clause of a standard we can read. For a
    # `corpus` citation the corpus IS the only source, so a clause it does not
    # carry means the citation rests on nothing.
    known = {(e["part"], e["clause"]) for e in index["clauses"]}
    unsupported: list[dict] = []
    uncarried: list[dict] = []
    for citation in citations:
        if (citation.part, citation.clause) in known:
            continue
        (unsupported if citation.source == "corpus" else uncarried).append(citation.to_json())

    return {
        "by_part": {part: {k: v for k, v in row.items()} for part, row in sorted(out.items())},
        "uncited_preflight_checks": list(clause_map.unmapped_preflight_checks()),
        "uncited_accessibility_checks": list(clause_map.unmapped_accessibility_checks()),
        "citations_with_no_source": unsupported,
        "held_citations_the_corpus_omits": uncarried,
    }


def _pdfa_clause_scoring(index: dict, per_clause: int, part_filter: str) -> dict:
    """Run the cited preflight checks over the clauses they cite.

    One profile per part, built by `clause_map.measurement_profile` from the
    citations' own parameters — this tool never chooses them, so a citation is
    scored against the rule it actually claimed.
    """
    from engine import clause_map
    from engine.preflight import preflight

    parts: dict[str, list] = defaultdict(list)
    for citation in clause_map.PREFLIGHT_CLAUSES:
        parts[citation.part].append(citation)

    files_by_clause: dict[tuple, list] = defaultdict(list)
    for entry in index["clauses"]:
        for f in entry["files"]:
            if f["path"] and f["verdict"] in ("pass", "fail"):
                files_by_clause[(entry["part"], entry["clause"])].append(f)

    results: dict[str, dict] = {}
    findings: list[dict] = []
    for part, citations in sorted(parts.items()):
        if part_filter and part != part_filter:
            continue
        profile = clause_map.measurement_profile(part)
        by_clause: dict[str, Counter] = defaultdict(Counter)
        evidence: dict[str, set] = defaultdict(set)
        for citation in citations:
            key = (part, citation.clause)
            rows = files_by_clause.get(key, [])
            # Bounded on purpose: one clause carries 372 corpus files and the
            # figure it produces does not improve past a sample.
            for f in rows[:per_clause] if per_clause else rows:
                path = CORPUS / f["path"]
                try:
                    report = preflight(str(path), profile=profile, gs_path="")
                except Exception as exc:  # noqa: BLE001 — a reader that dies is our defect
                    by_clause[citation.clause]["unreadable"] += 1
                    findings.append({
                        "kind": "reader_error", "part": part, "clause": citation.clause,
                        "path": f["path"], "error": f"{type(exc).__name__}: {exc}",
                    })
                    continue
                fired = {
                    row["id"] for row in report["checks"]
                    if row["status"] == "fail" and row["id"] == citation.check
                }
                if f["verdict"] == "fail":
                    if fired:
                        by_clause[citation.clause]["caught"] += 1
                        evidence[citation.clause].add(citation.check)
                    else:
                        by_clause[citation.clause]["missed"] += 1
                else:
                    if fired:
                        by_clause[citation.clause]["flagged on pass"] += 1
                        findings.append({
                            "kind": "flagged_on_pass", "part": part,
                            "clause": citation.clause, "check": citation.check,
                            "path": f["path"],
                        })
                    else:
                        by_clause[citation.clause]["clean"] += 1
        for citation in citations:
            if citation.check not in evidence.get(citation.clause, set()):
                findings.append({
                    "kind": "unevidenced_citation", "part": part,
                    "clause": citation.clause, "check": citation.check,
                    "coverage": citation.coverage,
                })
        results[part] = {clause: dict(counts) for clause, counts in sorted(by_clause.items())}
    return {"by_part": results, "findings": findings}


def _ua_clause_scoring(rows: list) -> dict:
    """The PDF/UA-1 half, attributed by clause.

    No second run: the accessibility report is already measured per file
    above, so this only asks whether a check CITED against the file's clause
    is among the ones that fired. A different check firing is not evidence
    about this clause and is not counted as one.
    """
    from engine import clause_map

    cited: dict[str, set] = defaultdict(set)
    advisory: dict[str, set] = defaultdict(set)
    for citation in clause_map.accessibility_clauses():
        cited[citation.clause].add(citation.check)
        if citation.coverage == clause_map.PARTIAL:
            advisory[citation.clause].add(citation.check)

    by_clause: dict[str, Counter] = defaultdict(Counter)
    for row in rows:
        if row["part"] != "PDF/UA-1":
            continue
        access = row.get("accessibility")
        if not access or "error" in access:
            continue
        owners = cited.get(row["clause"])
        if not owners:
            by_clause[row["clause"]]["uncited"] += 1
            continue
        fired = owners & set(access["fired"])
        if row["expected"] == "fail":
            by_clause[row["clause"]]["caught" if fired else "missed"] += 1
        elif not fired:
            by_clause[row["clause"]]["clean"] += 1
        elif fired <= advisory.get(row["clause"], set()):
            # Only a `should` fired. A file that declines a recommendation is
            # conformant, so this is not a finding against the clause.
            by_clause[row["clause"]]["advisory"] += 1
        else:
            by_clause[row["clause"]]["flagged on pass"] += 1
    return {clause: dict(counts) for clause, counts in sorted(by_clause.items())}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=0, help="stop after N files")
    parser.add_argument("--part", default="", help="only this part, e.g. PDF/A-1b")
    parser.add_argument("--per-clause", type=int, default=25,
                        help="cap the files scored per cited clause (0 = all)")
    parser.add_argument("--skip-clauses", action="store_true",
                        help="skip the per-clause scoring run (coverage still reported)")
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

    coverage = _clause_coverage(index)
    ua_clauses = _ua_clause_scoring(rows)
    pdfa_clauses = (
        {"by_part": {}, "findings": [], "skipped": True}
        if args.skip_clauses
        else _pdfa_clause_scoring(index, args.per_clause, args.part)
    )

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
        "clause_coverage": coverage,
        "clause_scoring_pdfa": pdfa_clauses,
        "clause_scoring_pdfua": ua_clauses,
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
    print("clause coverage (cited / clauses the corpus carries):")
    for part, row in coverage["by_part"].items():
        print(f"  {part:<10} {row['cited_clauses']:>3} / {row['clauses']:<3}")
    print(f"  preflight checks citing no PDF/A clause      "
          f"{len(coverage['uncited_preflight_checks'])}")
    print(f"  accessibility checks citing no PDF/UA clause {len(coverage['uncited_accessibility_checks'])}")
    print(f"  held citations the corpus carries no file for  "
          f"{len(coverage['held_citations_the_corpus_omits'])}")
    if coverage["citations_with_no_source"]:
        print(f"  CITATIONS RESTING ON NOTHING                 "
              f"{len(coverage['citations_with_no_source'])}")
    if ua_clauses:
        print("PDF/UA-1, per cited clause:")
        for clause, counts in ua_clauses.items():
            print(f"  {clause:<10} " + "  ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    if not pdfa_clauses.get("skipped"):
        print("PDF/A, per cited clause (cited checks only):")
        for part, clauses in pdfa_clauses["by_part"].items():
            for clause, counts in clauses.items():
                print(f"  {part:<9} {clause:<10} "
                      + "  ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        for finding in pdfa_clauses["findings"]:
            print(f"  {finding['kind'].upper():<22} {finding.get('part','')} "
                  f"{finding.get('clause','')} {finding.get('check', finding.get('path',''))}")
    print("declared conformance, top 8:")
    for name, count in list(declared.most_common(8)):
        print(f"    {count:>5}  {name}")
    print(f"written          {OUT.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
