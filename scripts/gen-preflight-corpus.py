#!/usr/bin/env python3
"""Writes `tests/fixtures/preflight-corpus.json`: the preflight verdict of every
PDF in the tree, per profile.

A maintenance tool, not a build step. Run it when a checker change is meant to
move a verdict, review the resulting diff, and commit it.
`tests/test_preflight.py::TestCorpusGate` fails when a verdict moves on a
document nobody edited, and this file turns that move into a reviewable diff.

Total area coverage is DISABLED here. Running Ghostscript `tiffsep` over every
page of every document times nine profiles would make the gate the slowest
thing in the repo, and the guard the corpus exists to provide is about verdict
DRIFT, which the other checks give. The coverage check is pinned separately
over constructed fixtures.

    .venv/Scripts/python.exe scripts/gen-preflight-corpus.py
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "preflight-corpus.json"
SUMMARY_KEYS = ("passed", "failed", "warnings", "needs_review", "not_applicable")

NOTE = [
    "The preflight verdict of every PDF in the tree, pinned per profile.",
    "The full verdict map is the default profile; the other eight are"
    " pinned as their summary tuple (passed/failed/warnings/"
    "needs_review/not_applicable).",
    "Total area coverage is disabled here and pinned separately over"
    " constructed fixtures.",
    "Regenerate with scripts/gen-preflight-corpus.py and review the diff.",
]


def corpus_profile(profiles: dict, pid: str) -> dict:
    profile = json.loads(json.dumps(profiles[pid]))
    profile["checks"].setdefault("ink_coverage_max", {})["enabled"] = False
    return profile


def candidates() -> list[pathlib.Path]:
    """Every TRACKED PDF. Git's index is the definition of "in the tree"."""
    listed = subprocess.run(
        ["git", "ls-files", "-z", "*.pdf", "*.PDF"],
        cwd=str(ROOT), capture_output=True, check=True,
    ).stdout.decode("utf8")
    return sorted(
        ROOT / name for name in listed.split("\0")
        # See tests/test_preflight.py: the PDF/UA techniques corpus is
        # accessibility material with its own gate, not preflight subjects.
        if name and not name.startswith("tests/fixtures/pdfua-techniques/")
    )


def main() -> int:
    sys.path.insert(0, str(ROOT / "src"))
    from engine.preflight import preflight
    from engine.preflight_profiles import (
        DEFAULT_PROFILE_ID,
        SHIPPED_PROFILE_IDS,
        SHIPPED_PROFILES,
    )

    documents = []
    for path in candidates():
        rel = path.relative_to(ROOT).as_posix()
        try:
            report = preflight(
                str(path), profile=corpus_profile(SHIPPED_PROFILES, DEFAULT_PROFILE_ID)
            )
        except Exception as exc:  # noqa: BLE001
            # The refusal names the file by the path it was opened with; the
            # checkout's own location is replaced so that a regeneration in
            # any other clone writes the same bytes.
            refusal = str(exc).replace(str(path), rel)
            print(f"  refused  {rel}: {refusal}")
            documents.append({"path": rel, "refused": refusal})
            continue
        entry = {
            "path": rel,
            "verdicts": {c["id"]: c["status"] for c in report["checks"]},
            "summaries": {},
        }
        for pid in SHIPPED_PROFILE_IDS:
            other = preflight(str(path), profile=corpus_profile(SHIPPED_PROFILES, pid))
            entry["summaries"][pid] = [other["summary"][k] for k in SUMMARY_KEYS]
        documents.append(entry)
        summary = report["summary"]
        print(
            f"  {summary['passed']:2} pass  {summary['failed']:2} fail  "
            f"{summary['warnings']:2} warn  {summary['needs_review']:2} review  "
            f"{summary['not_applicable']:2} n/a   {rel}"
        )
    payload = {
        "note": NOTE,
        "default_profile": DEFAULT_PROFILE_ID,
        "profiles": list(SHIPPED_PROFILE_IDS),
        "summary_keys": list(SUMMARY_KEYS),
        "documents": documents,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf8")
    print(f"wrote {OUT.relative_to(ROOT).as_posix()}: {len(documents)} documents")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
