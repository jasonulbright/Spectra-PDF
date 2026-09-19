#!/usr/bin/env python3
"""Writes `tests/fixtures/a11y-corpus.json`: the accessibility verdict of every
PDF in the tree.

A maintenance tool, not a build step. Run it when a checker change is meant to
move a verdict, review the resulting diff, and commit it.
`tests/test_accessibility.py::TestCorpusGate` fails when a verdict moves on a
document nobody edited, and this file turns that move into a reviewable diff.

    .venv/Scripts/python.exe scripts/gen-a11y-corpus.py
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "a11y-corpus.json"

NOTE = [
    "The accessibility verdict of every PDF in the tree, pinned.",
    "Regenerate with scripts/gen-a11y-corpus.py and review the diff — a",
    "verdict that moves on a document nobody edited is a checker",
    "regression, and this file is where it shows up.",
]


def candidates() -> list[pathlib.Path]:
    """Every TRACKED PDF. Git's index is the definition of "in the tree": a
    scratch probe folder is not a document anybody edits, and pinning one
    would make the gate fail on a fresh checkout that never had it."""
    listed = subprocess.run(
        ["git", "ls-files", "-z", "*.pdf", "*.PDF"],
        cwd=str(ROOT), capture_output=True, check=True,
    ).stdout.decode("utf8")
    return sorted(
        ROOT / name for name in listed.split("\0")
        # The PDF/UA techniques corpus has a gate of its own whose expectations
        # come from upstream. Pinning it here too would answer a verdict move
        # in two places and let the weaker answer be the one somebody updates.
        if name and "tests/fixtures/pdfua-techniques/" not in name
    )


def main() -> int:
    sys.path.insert(0, str(ROOT / "src"))
    from engine.accessibility import check_accessibility

    documents = []
    for path in candidates():
        rel = path.relative_to(ROOT).as_posix()
        try:
            res = check_accessibility(str(path))
        except Exception as exc:
            # The refusal names the file by the path it was opened with; the
            # checkout's own location is replaced so that a regeneration in
            # any other clone writes the same bytes.
            refusal = str(exc).replace(str(path), rel)
            print(f"  refused  {rel}: {refusal}")
            documents.append({"path": rel, "refused": refusal})
            continue
        verdicts = {c["id"]: c["status"] for c in res["checks"]}
        summary = res["summary"]
        documents.append({"path": rel, "verdicts": verdicts, "summary": summary})
        print(
            f"  {summary['passed']:2} pass  {summary['failed']:2} fail  "
            f"{summary['warnings']:2} warn  {summary['needs_review']:2} review  "
            f"{summary['not_applicable']:2} n/a   {rel}"
        )
    payload = {"note": NOTE, "documents": documents}
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf8")
    print(f"\nwrote {OUT.relative_to(ROOT).as_posix()} — {len(documents)} documents")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
