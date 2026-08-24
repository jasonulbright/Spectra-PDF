"""The PDF Association's Techniques for Accessible PDF, as a gate.

Expected results this repo did not author. Each technique is one minimal
document with an upstream verdict: a `Pass` file conforms to PDF/UA-1, a `Fail`
file violates exactly what its name states. Two claims are asserted.

**No PASS file may fail any check.** A false failure on a document the standard's
own publisher calls conforming is the one result an accessibility report cannot
survive, so this is asserted across the whole inventory rather than only the
checks a technique is about. `needs_review` is not a failure — it is this
checker saying it did not decide.

**A covered FAIL file must be reported by the check that owns its defect.**
`COVERAGE.json` names which check, and at which status. A technique testing
something no check answers is recorded there as `uncovered` with its Matterhorn
checkpoints — a list that feeds the register, never a silent drop.

The corpus is pinned: every file's SHA-256 is in `MANIFEST.json`, and a file
that is present but unlisted, or listed but absent, fails here rather than
changing what the gate means.
"""

from __future__ import annotations

import hashlib
import json
import pathlib

import pytest

from engine.accessibility import CHECK_INVENTORY, CHECK_SOURCES, check_accessibility

CORPUS = pathlib.Path(__file__).parent / "fixtures" / "pdfua-techniques"
MANIFEST = json.loads((CORPUS / "MANIFEST.json").read_text(encoding="utf-8"))
COVERAGE = json.loads((CORPUS / "COVERAGE.json").read_text(encoding="utf-8"))
_CHECK_IDS = {cid for cid, _ in CHECK_INVENTORY}

_TECHNIQUES = sorted(MANIFEST["techniques"])


def _statuses(technique: str) -> dict:
    path = CORPUS / MANIFEST["techniques"][technique]["file"]
    return {c["id"]: c["status"] for c in check_accessibility(str(path))["checks"]}


def test_every_check_states_the_clause_it_speaks_for():
    """A check with no source row makes a conformance claim on nobody's
    authority, and one whose source is unknown to this list is a kind of claim
    the report has no way to render honestly."""
    assert set(CHECK_SOURCES) == _CHECK_IDS
    for cid, (source, citation) in CHECK_SOURCES.items():
        assert source in ("ua", "ua_soft", "wcag", "iso", "practice"), cid
        assert citation.strip(), cid


def test_manifest_and_corpus_agree():
    listed = set(MANIFEST["sha256"])
    present = {p.name for p in CORPUS.glob("*.pdf")}
    assert listed == present
    assert listed == {t["file"] for t in MANIFEST["techniques"].values()}


def test_every_file_matches_its_pinned_digest():
    for name, digest in sorted(MANIFEST["sha256"].items()):
        assert hashlib.sha256((CORPUS / name).read_bytes()).hexdigest() == digest, name


def test_coverage_table_names_every_technique():
    assert set(COVERAGE) == set(MANIFEST["techniques"])
    for technique, row in COVERAGE.items():
        assert ("covered" in row) != ("uncovered" in row), technique
        for cid, status in (row.get("covered") or {}).items():
            assert cid in _CHECK_IDS, (technique, cid)
            assert status in ("fail", "warn"), (technique, cid, status)


def test_every_covered_technique_is_a_failure_technique():
    """A covered row asserts a defect is REPORTED, so it can only sit on a file
    that carries one. A pass file's guarantee is the blanket one below."""
    for technique, row in COVERAGE.items():
        if "covered" in row:
            assert MANIFEST["techniques"][technique]["expectation"] == "Fail", technique


@pytest.mark.parametrize(
    "technique",
    [t for t in _TECHNIQUES if MANIFEST["techniques"][t]["expectation"] == "Pass"],
)
def test_conforming_technique_fails_nothing(technique):
    statuses = _statuses(technique)
    reported = {cid: s for cid, s in statuses.items() if s in ("fail", "warn")}
    assert reported == {}, f"{technique}: {MANIFEST['techniques'][technique]['title']}"


@pytest.mark.parametrize(
    "technique", [t for t in _TECHNIQUES if "covered" in COVERAGE[t]]
)
def test_failing_technique_is_reported_by_its_check(technique):
    statuses = _statuses(technique)
    for cid, expected in COVERAGE[technique]["covered"].items():
        assert statuses[cid] == expected, f"{technique}/{cid}"


def test_uncovered_inventory_is_named_not_dropped():
    """The gate states its own reach: every uncovered row carries the upstream
    checkpoints it tests, so what this checker does not answer is a readable
    list rather than an absence."""
    uncovered = {t: r["uncovered"] for t, r in COVERAGE.items() if "uncovered" in r}
    assert uncovered
    for technique, row in uncovered.items():
        assert row["expectation"] in ("Pass", "Fail"), technique
        assert isinstance(row["matterhorn"], list), technique
