"""The clause map — what a check may claim, and what proves it.

Two halves. The first runs anywhere: a citation names a real check, states
parameters that check actually takes, carries a coverage label and a source
kind, and hides no check from the coverage figure.

The second needs the conformance corpus, which is gitignored and fetched by
`scripts/fetch-pdfa-corpus.py`, so it skips when the corpus is absent rather
than passing vacuously. It is the half that matters: a citation whose check
fails a file the suite passes is either a defect or a wrong claim, and either
way it may not sit in the map unexamined.
"""

import os

import pytest

import pdfa_conformance_corpus as corpus_axis
from engine import clause_map
from engine.accessibility import CHECK_SOURCES
from engine.preflight_profiles import CHECK_IDS, validate_profile

CORPUS = str(corpus_axis.CORPUS)

corpus_required = pytest.mark.skipif(
    not corpus_axis.corpus_present(),
    reason=corpus_axis.PDFA_CORPUS_AXIS_SKIP,
)

#: Files scored per clause. The whole corpus is what the maintenance
#: scoreboard is for; a suite this long does not belong in the gate, and the
#: cases that discriminate sit at the front of every clause's list.
_SAMPLE = 8


def _index():
    return corpus_axis.load_index()


class TestCitationShape:
    def test_every_check_exists(self):
        for citation in clause_map.PREFLIGHT_CLAUSES:
            assert citation.check in CHECK_IDS, citation.check
        for citation in clause_map.accessibility_clauses():
            assert citation.check in CHECK_SOURCES, citation.check

    def test_labels_are_known(self):
        for citation in clause_map.all_citations():
            assert citation.coverage in (clause_map.FULL, clause_map.PARTIAL)
            assert citation.source in (clause_map.HELD, clause_map.CORPUS)
            assert citation.condition.strip()

    def test_pdfa_citations_declare_their_second_hand_source(self):
        """ISO 19005 is not in the normative set, so no PDF/A citation may
        present itself as read from the standard."""
        for citation in clause_map.PREFLIGHT_CLAUSES:
            assert citation.part.startswith("PDF/A")
            assert citation.source == clause_map.CORPUS, citation.clause

    def test_pdfua_citations_come_from_the_held_text(self):
        for citation in clause_map.accessibility_clauses():
            assert citation.source == clause_map.HELD

    def test_params_are_that_check_s_own(self):
        for citation in clause_map.PREFLIGHT_CLAUSES:
            entry = dict(citation.params)
            entry["severity"] = "fail"
            validate_profile({
                "schema": 1, "id": "clause-map-test", "name": "",
                "checks": {citation.check: entry}, "fixups": [],
            })

    def test_no_check_is_hidden_from_the_coverage_figure(self):
        cited = clause_map.cited_preflight_checks()
        unmapped = set(clause_map.unmapped_preflight_checks())
        assert cited | unmapped == set(CHECK_IDS)
        assert not cited & unmapped

        ua_cited = {c.check for c in clause_map.accessibility_clauses()}
        ua_unmapped = set(clause_map.unmapped_accessibility_checks())
        assert ua_cited | ua_unmapped == set(CHECK_SOURCES)
        assert not ua_cited & ua_unmapped

    def test_measurement_profile_runs_only_the_cited_checks(self):
        for part in sorted({c.part for c in clause_map.PREFLIGHT_CLAUSES}):
            profile = clause_map.measurement_profile(part)
            enabled = {
                cid for cid in CHECK_IDS
                if profile["checks"].get(cid, {}).get("enabled", True)
            }
            assert enabled == {
                c.check for c in clause_map.PREFLIGHT_CLAUSES if c.part == part
            }

    def test_a_part_no_check_cites_refuses(self):
        with pytest.raises(ValueError):
            clause_map.measurement_profile("PDF/A-1a")

    def test_ua_clause_parse_drops_other_standards(self):
        # `role_map` cites 14289-1 7.1 and 32000-2 14.7.4; only the first is
        # PDF/UA's numbering, and counting the second would inflate coverage
        # with another document's clauses.
        assert clause_map._ua_clauses("7.1; 32000-2 14.7.4") == ["7.1"]
        assert clause_map._ua_clauses("WCAG 2 2.2.1") == []
        assert clause_map._ua_clauses("7.18.1, 7.18.6") == ["7.18.1", "7.18.6"]


@corpus_required
class TestAgainstTheCorpus:
    def test_every_cited_clause_exists(self):
        index = _index()
        known = {(e["part"], e["clause"]) for e in index["clauses"]}
        for citation in clause_map.PREFLIGHT_CLAUSES:
            assert (citation.part, citation.clause) in known, (
                f"{citation.part} {citation.clause} is cited by "
                f"{citation.check} and the corpus — its only source — does "
                "not carry it."
            )

    def test_no_cited_check_fails_a_file_its_clause_passes(self):
        """The rule the map states, enforced.

        A `pass` verdict is per test rather than per clause, so a hit here is
        a candidate rather than a proven false alarm — and a candidate is
        adjudicated in `engine/clause_map.py`, not left standing in the map.
        """
        from engine.preflight import preflight

        index = _index()
        files = {
            (e["part"], e["clause"]): e["files"] for e in index["clauses"]
        }
        offenders = []
        for part in sorted({c.part for c in clause_map.PREFLIGHT_CLAUSES}):
            profile = clause_map.measurement_profile(part)
            for citation in clause_map.PREFLIGHT_CLAUSES:
                if citation.part != part:
                    continue
                rows = [
                    f for f in files.get((part, citation.clause), [])
                    if f["path"] and f["verdict"] == "pass"
                ]
                for entry in rows[:_SAMPLE]:
                    path = os.path.join(CORPUS, entry["path"])
                    report = preflight(path, profile=profile, gs_path="")
                    for row in report["checks"]:
                        if row["id"] == citation.check and row["status"] == "fail":
                            offenders.append(
                                f"{part} {citation.clause} {citation.check} "
                                f"← {entry['path']}"
                            )
        assert not offenders, offenders
