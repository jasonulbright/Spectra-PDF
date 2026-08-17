"""MAINTENANCE TOOL, not a build step. Builds the clause index over the
fetched conformance corpora and writes it to gitignored
`pdfa-corpus/clause-index.json`.

WHY THE INDEX IS GENERATED RATHER THAN COMMITTED

It carries BFO's own rule sentences verbatim, and neither upstream declares a
licence (see `fetch-pdfa-corpus.py`). A committed index would republish that
text, so the index is rebuilt from the corpus on the machine that holds it.

WHAT A ROW IS

One clause of one PDF/A part, e.g. `PDF/A-2b 6.1.13`. Each row carries:

  title    the clause title, taken from the veraPDF corpus' own directory
           names — that corpus is organised as the standard's table of
           contents, which is why it can supply a title at all.
  rules    the stated rule per file, where a suite states one. BFO's
           `description.txt` does; veraPDF and Isartor name the clause and
           leave the rule to the standard, so their rows carry no sentence and
           that absence is recorded rather than filled in.
  files    every corpus file bound to the clause, with the verdict its own
           NAME declares (`…-fail-a.pdf` / `…-pass-b.pdf`).

A file whose name declares no verdict is listed under `unverdicted` rather
than assumed to pass — a corpus entry nobody labelled cannot score anything.

Run: .venv/Scripts/python.exe scripts/pdfa-clause-index.py
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CORPUS = REPO_ROOT / "pdfa-corpus"
OUT = CORPUS / "clause-index.json"

# `…-6-1-13-t04-fail-a.pdf` / `…-6-1-13-bfo-t01-pass.pdf`: the clause digits,
# the test number, the verdict, and an optional variant letter.
STEM = re.compile(
    # One level or many, and the two families separate their levels
    # differently: PDF/A writes `6-1-13`, PDF/UA writes `7.21.3.1` (and a
    # top-level `5`). Both are normalized to dots by `_clause_from_stem`.
    r"(?P<clause>\d+(?:[-.]\d+)*)-(?:bfo-)?t(?P<test>\d+)"
    r"(?:-(?P<verdict>fail|pass|undefined))?(?:-(?P<variant>[a-z0-9]+))?$",
    re.IGNORECASE,
)
# `PDF_A-2b` -> `PDF/A-2b`, `PDF_UA-1` -> `PDF/UA-1`; Isartor writes `PDFA-1b`.
# PDF/UA is carried deliberately: ISO 14289-1 is one of the texts this
# repository does not hold, so its corpus is the only corroboration available.
PART_DIR = re.compile(r"^PDF_?(?P<family>A|UA)-(?P<part>\d[a-z]*)$", re.IGNORECASE)
# A veraPDF clause directory: `6.1.2 File header`.
CLAUSE_DIR = re.compile(r"^(?P<number>\d+(?:\.\d+)*)\s+(?P<title>.+)$")
# A BFO file name opens with the part it targets: `pdfa2-…`.
BFO_PART = re.compile(r"^pdfa(?P<digit>\d)-", re.IGNORECASE)


def _clause_from_stem(stem: str) -> tuple[str, str, str | None, str | None] | None:
    match = STEM.search(stem)
    if not match:
        return None
    clause = match.group("clause").replace("-", ".")
    return clause, match.group("test"), match.group("verdict"), match.group("variant")


def _verapdf_rows(root: Path) -> list[dict]:
    """Every veraPDF/Isartor file, with the part and clause its PATH declares.

    The path is the authority here rather than the file name: the name repeats
    the clause digits, but only the directory carries the clause TITLE and the
    conformance level the file is filed under.
    """
    rows: list[dict] = []
    for path in sorted(root.rglob("*.pdf")):
        parts = path.relative_to(root).parts
        part = None
        title = None
        clause_from_path = None
        for segment in parts[:-1]:
            part_match = PART_DIR.match(segment)
            if part_match:
                part = (
                    "PDF/"
                    + part_match.group("family").upper()
                    + "-"
                    + part_match.group("part").lower()
                )
                continue
            clause_match = CLAUSE_DIR.match(segment)
            if clause_match:
                clause_from_path = clause_match.group("number")
                title = clause_match.group("title").strip()
        parsed = _clause_from_stem(path.stem)
        clause = parsed[0] if parsed else clause_from_path
        if clause is None or part is None:
            rows.append(
                {
                    "suite": "isartor" if "Isartor" in parts[0] else "verapdf",
                    "path": str(path.relative_to(CORPUS)).replace("\\", "/"),
                    "part": part,
                    "clause": clause,
                    "title": title,
                    "test": None,
                    "verdict": None,
                    "variant": None,
                }
            )
            continue
        rows.append(
            {
                "suite": "isartor" if "Isartor" in parts[0] else "verapdf",
                "path": str(path.relative_to(CORPUS)).replace("\\", "/"),
                "part": part,
                "clause": clause,
                "title": title,
                # A file whose PATH names the clause but whose NAME follows no
                # convention still belongs to the clause; it simply carries no
                # test number and no verdict, which `unverdicted` records.
                "test": parsed[1] if parsed else None,
                "verdict": parsed[2] if parsed else None,
                "variant": parsed[3] if parsed else None,
            }
        )
    return rows


def _bfo_rules(root: Path) -> dict[str, str]:
    """`description.txt` as {file name: the rule sentence}.

    Tab-separated, one row per file, and the second column is the whole value
    of this suite: it states what the file is FOR, which no other suite here
    does.
    """
    description = root / "description.txt"
    if not description.is_file():
        return {}
    rules: dict[str, str] = {}
    for line in description.read_text(encoding="utf-8", errors="replace").splitlines():
        if "\t" not in line:
            continue
        name, rule = line.split("\t", 1)
        name, rule = name.strip(), rule.strip()
        if name and rule:
            rules[name] = rule
    return rules


def _bfo_rows(root: Path) -> list[dict]:
    rules = _bfo_rules(root)
    rows: list[dict] = []
    seen: set[str] = set()
    for path in sorted(root.rglob("*.pdf")):
        seen.add(path.name)
        parsed = _clause_from_stem(path.stem)
        part_match = BFO_PART.match(path.name)
        rows.append(
            {
                "suite": "bfo",
                "path": str(path.relative_to(CORPUS)).replace("\\", "/"),
                # BFO files name a PART but not a conformance level; `b` is the
                # level every one of its rules is written against.
                "part": f"PDF/A-{part_match.group('digit')}b" if part_match else None,
                "clause": parsed[0] if parsed else None,
                "title": None,
                "test": parsed[1] if parsed else None,
                "verdict": parsed[2] if parsed else None,
                "variant": parsed[3] if parsed else None,
                "rule": rules.get(path.name),
            }
        )
    # A description row naming a file the tree does not carry is a real gap in
    # the suite, not a parse failure, so it is reported rather than dropped.
    described_but_absent = sorted(name for name in rules if name not in seen)
    for name in described_but_absent:
        rows.append(
            {
                "suite": "bfo",
                "path": None,
                "part": None,
                "clause": None,
                "title": None,
                "test": None,
                "verdict": None,
                "variant": None,
                "rule": rules[name],
                "described_but_absent": name,
            }
        )
    return rows


def main() -> int:
    if not CORPUS.is_dir() or not (CORPUS / "manifest.json").is_file():
        print("pdfa-corpus is not fetched — run scripts/fetch-pdfa-corpus.py first")
        return 1

    rows = _bfo_rows(CORPUS / "bfo") + _verapdf_rows(CORPUS / "verapdf")

    clauses: dict[tuple[str, str], dict] = {}
    unbound: list[dict] = []
    unverdicted: list[str] = []
    # The corpus' own `undefined` verdict: cases its authors decline to call.
    # They are held out of every score rather than counted either way, because
    # scoring them would be this repository deciding a question the suite that
    # built the file deliberately left open.
    undecided: list[str] = [
        row["path"]
        for row in rows
        if row.get("verdict") == "undefined" or "-undefined-" in (row.get("path") or "")
    ]
    for row in rows:
        if row.get("verdict") == "undefined" or "-undefined-" in (row.get("path") or ""):
            continue
        if row.get("described_but_absent"):
            unbound.append(row)
            continue
        if not row["part"] or not row["clause"]:
            unbound.append(row)
            continue
        key = (row["part"], row["clause"])
        entry = clauses.setdefault(
            key,
            {"part": row["part"], "clause": row["clause"], "titles": [], "rules": [], "files": []},
        )
        if row.get("title") and row["title"] not in entry["titles"]:
            entry["titles"].append(row["title"])
        if row.get("rule") and row["rule"] not in entry["rules"]:
            entry["rules"].append(row["rule"])
        entry["files"].append(
            {
                "suite": row["suite"],
                "path": row["path"],
                "test": row["test"],
                "verdict": row["verdict"],
                "variant": row["variant"],
                "rule": row.get("rule"),
            }
        )
        if row["verdict"] is None:
            unverdicted.append(row["path"])

    def sort_key(entry: dict) -> tuple:
        return (entry["part"], tuple(int(n) for n in entry["clause"].split(".")))

    ordered = sorted(clauses.values(), key=sort_key)
    index = {
        "note": (
            "Generated from pdfa-corpus by scripts/pdfa-clause-index.py. Neither "
            "source declares a licence; never commit this file. A rule sentence "
            "is the SUITE's wording, not the standard's."
        ),
        "clauses": ordered,
        "unbound": unbound,
        "undecided": sorted(set(p for p in undecided if p)),
        "unverdicted": sorted(set(p for p in unverdicted if p)),
    }
    OUT.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    suites: dict[str, int] = defaultdict(int)
    verdicts: dict[str, int] = defaultdict(int)
    for entry in ordered:
        for f in entry["files"]:
            suites[f["suite"]] += 1
            verdicts[f["verdict"] or "none"] += 1
    parts = sorted({e["part"] for e in ordered})
    with_rule = sum(1 for e in ordered if e["rules"])
    with_title = sum(1 for e in ordered if e["titles"])

    print(f"clauses      {len(ordered)} across {len(parts)} parts: {', '.join(parts)}")
    print(f"  with a stated rule  {with_rule}")
    print(f"  with a clause title {with_title}")
    print(f"files        {sum(suites.values())}  " + "  ".join(f"{k}={v}" for k, v in sorted(suites.items())))
    print(f"verdicts     " + "  ".join(f"{k}={v}" for k, v in sorted(verdicts.items())))
    # `unbound` is mostly not a parse failure — it is the part of the corpus
    # that names no PDF/A or PDF/UA part at all (the base-format ISO 32000
    # cases, the TWG working files, the suite's own manual). Naming the bucket
    # is the difference between "we could not read these" and "these are not
    # ours to score".
    buckets: dict[str, int] = defaultdict(int)
    for row in unbound:
        if row.get("described_but_absent"):
            buckets["described by the suite but absent from it"] += 1
            continue
        path = row.get("path") or ""
        segments = path.split("/")
        buckets[segments[1] if len(segments) > 1 else "no path"] += 1
    print(f"unbound      {len(unbound)}, by directory:")
    for name, count in sorted(buckets.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"    {count:>5}  {name}")
    print(f"undecided    {len(index['undecided'])} (the suite's own `undefined` verdict)")
    print(f"unverdicted  {len(index['unverdicted'])}")
    print(f"written      {OUT.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
