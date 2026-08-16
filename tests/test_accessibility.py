"""Accessibility checker — 32 checks, five verdicts, addressed findings.

Every check is pinned TWICE: once on the fixture that fails it and once on the
conforming twin that must not. The `_ok` fixtures are the false-failure guards
— a checker that cries wolf on a well-tagged document is worse than the
six-check one it replaced, because the reader now has 32 reasons to doubt it.
"""

import json
import os
import pathlib

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.accessibility import (
    CATEGORIES,
    CHECK_INVENTORY,
    NA,
    check_accessibility,
)
from engine.contrast import contrast_ratio, relative_luminance, required_ratio

import a11y_builders as B

REPO = pathlib.Path(__file__).resolve().parent.parent


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


def _statuses(res) -> dict:
    return {c["id"]: c["status"] for c in res["checks"]}


def _check(res, cid) -> dict:
    return next(c for c in res["checks"] if c["id"] == cid)


def _build(tmp_dir, name):
    builder = B.ROSTER[name][0]
    return builder(os.path.join(tmp_dir, f"{name}.pdf"))


class TestReportShape:
    def test_every_check_is_reported_exactly_once(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "baseline"))
        ids = [c["id"] for c in res["checks"]]
        assert len(ids) == 32
        assert ids == [cid for cid, _ in CHECK_INVENTORY]
        assert len(set(ids)) == 32

    def test_categories_partition_the_checks(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "baseline"))
        assert [c["id"] for c in res["categories"]] == list(CATEGORIES)
        flat = [c["id"] for cat in res["categories"] for c in cat["checks"]]
        assert sorted(flat) == sorted(c["id"] for c in res["checks"])

    def test_not_applicable_is_excluded_from_the_pass_tally(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "baseline"))
        s = res["summary"]
        assert s["passed"] + s["failed"] + s["warnings"] + s["needs_review"] + s["not_applicable"] == 32
        assert s["applicable"] == 32 - s["not_applicable"]
        # A document with no tables reports all five table checks as
        # not_applicable and none of them counts as passed.
        for cid in ("table_rows", "table_cells", "table_headers", "table_regularity",
                    "table_summary"):
            assert _statuses(res)[cid] == NA
        assert s["passed"] < s["total"]

    def test_baseline_document_fails_nothing(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "baseline"))
        failing = {c["id"]: c["status"] for c in res["checks"]
                   if c["status"] in ("fail", "warn", "needs_review")}
        assert failing == {}

    def test_every_finding_carries_an_address_and_a_detail_key(self, tmp_dir):
        for name in B.ROSTER:
            res = check_accessibility(_build(tmp_dir, name))
            for check in res["checks"]:
                for finding in check["findings"]:
                    assert finding["address"]["kind"] in ("struct", "content", "object"), (
                        name, check["id"]
                    )
                    assert finding["detail_key"], (name, check["id"])
                    if finding["address"]["kind"] == "struct":
                        assert isinstance(finding["address"]["path"], list)


class TestPerCheckVerdicts:
    @pytest.mark.parametrize("name", [n for n in B.ROSTER if B.ROSTER[n][1]])
    def test_fixture_reports_its_own_verdict(self, tmp_dir, name):
        _builder, cid, expected = B.ROSTER[name]
        res = check_accessibility(_build(tmp_dir, name))
        assert _statuses(res)[cid] == expected, json.dumps(_check(res, cid), indent=2)

    @pytest.mark.parametrize("name", [n for n in B.ROSTER if n.endswith("_ok")])
    def test_pass_fixtures_fail_nothing(self, tmp_dir, name):
        """The false-failure guard. A conforming shape may legitimately need
        review, but it must never FAIL a check."""
        res = check_accessibility(_build(tmp_dir, name))
        failed = [c["id"] for c in res["checks"] if c["status"] == "fail"]
        assert failed == [], json.dumps(
            [c for c in res["checks"] if c["status"] == "fail"], indent=2
        )

    def test_a_failing_fixture_moves_only_its_own_check(self, tmp_dir):
        """One fixture, one moved verdict — otherwise a verdict change cannot
        be attributed to the check that owns it."""
        base = _statuses(check_accessibility(_build(tmp_dir, "baseline")))
        for name, (_builder, cid, expected) in B.ROSTER.items():
            if cid is None or name.endswith("_ok"):
                continue
            statuses = _statuses(check_accessibility(_build(tmp_dir, name)))
            moved = {
                k for k in statuses
                if statuses[k] != base[k] and statuses[k] in ("fail", "warn", "needs_review")
            }
            assert cid in moved, (name, cid, sorted(moved))
            assert moved <= B.moves_with(cid), (name, cid, sorted(moved))


class TestAddresses:
    def test_struct_findings_address_the_element_by_path(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "figure_no_alt"))
        finding = _check(res, "figures_alt")["findings"][0]
        assert finding["address"] == {"kind": "struct", "path": [0, 1], "page": 1}

    def test_content_findings_address_a_page_and_a_run(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "untagged_content"))
        finding = _check(res, "tagged_content")["findings"][0]
        assert finding["address"]["kind"] == "content"
        assert finding["address"]["page"] == 1
        assert "tagged by nothing" in finding["preview"]
        assert len(finding["rect"]) == 4

    def test_object_findings_address_the_owning_surface(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "field_no_tu"))
        finding = _check(res, "field_descriptions")["findings"][0]
        assert finding["address"] == {"kind": "object", "field": "name"}

        res = check_accessibility(_build(tmp_dir, "untagged_annotation"))
        finding = _check(res, "tagged_annotations")["findings"][0]
        assert finding["address"] == {"kind": "object", "page": 1, "annotation": 0}


class TestContrastMaths:
    def test_relative_luminance_at_the_ends(self):
        assert relative_luminance([0, 0, 0]) == pytest.approx(0.0)
        assert relative_luminance([1, 1, 1]) == pytest.approx(1.0)

    def test_black_on_white_is_the_maximum_ratio(self):
        assert contrast_ratio([0, 0, 0], [1, 1, 1]) == pytest.approx(21.0, abs=0.01)

    def test_ratio_is_symmetric(self):
        assert contrast_ratio([0.2, 0.3, 0.4], [1, 1, 1]) == pytest.approx(
            contrast_ratio([1, 1, 1], [0.2, 0.3, 0.4])
        )

    def test_large_text_takes_the_lower_threshold(self):
        assert required_ratio(11.0, "/Helvetica") == 4.5
        assert required_ratio(18.0, "/Helvetica") == 3.0
        assert required_ratio(14.0, "/Helvetica-Bold") == 3.0
        assert required_ratio(14.0, "/Helvetica") == 4.5

    def test_an_unknowable_backdrop_is_reviewed_not_failed(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "contrast_over_image_ok"))
        check = _check(res, "contrast")
        assert check["status"] == "needs_review"
        assert all(f["detail_key"] == "contrast_unknown_backdrop" for f in check["findings"])
        assert all(f["values"]["background"] is None for f in check["findings"])

    def test_a_measured_failure_carries_its_numbers(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "low_contrast"))
        finding = _check(res, "contrast")["findings"][0]
        assert finding["detail_key"] == "contrast_below_threshold"
        assert finding["values"]["ratio"] < finding["values"]["required"]
        assert finding["values"]["background"] is not None


class TestFailClosed:
    def test_an_unparseable_page_is_named_and_downgrades_the_clean_claims(self, tmp_dir):
        src = os.path.join(tmp_dir, "broken.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B._one_tagged_paragraph(pdf, page)
        B.make_conformant(pdf, page)
        broken = pdf.add_blank_page(page_size=B.PAGE)
        # A stream that declares a compression it does not carry: the decode
        # fails, which is the "cannot read this page" case rather than the
        # "this page draws nothing" one.
        stream = pdf.make_stream(b"not actually deflate data at all")
        stream.stream_dict[Name.Filter] = Name.FlateDecode
        broken.obj[Name.Contents] = stream
        pdf.save(src)
        pdf.close()
        res = check_accessibility(src)
        assert res["unreadable"], "a page that will not parse must be named"
        assert res["unreadable"][0]["page"] == 2
        # "Could not read" is never reported as "nothing found".
        assert _statuses(res)["tagged_content"] == "needs_review"


class TestReadsThatDidNotComplete:
    """A read that did not complete is `needs_review`, never a clean claim.

    Each fixture below breaks ONE of the checker's own reads and pins that the
    checks fed by it say so. Every one of them reported `not_applicable` or
    `pass` before — an empty inventory that came out of a failed read, rendered
    as a document with nothing to check.
    """

    def _statuses_of(self, tmp_dir, name, build) -> dict:
        src = os.path.join(tmp_dir, f"{name}.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B._one_tagged_paragraph(pdf, page)
        B.make_conformant(pdf, page)
        build(pdf, page)
        return _statuses(check_accessibility(B.save(pdf, src)))

    def test_permissions_that_will_not_read_are_not_permissions_that_allow(self):
        from engine.accessibility import REVIEW, _Check, _check_permissions

        class _Unreadable:
            @property
            def allow(self):
                raise RuntimeError("this encryption dictionary cannot be interpreted")

        check = _Check("permissions", "document")
        _check_permissions(check, _Unreadable())
        assert check.status == REVIEW
        assert [f["detail_key"] for f in check.findings] == ["permissions_unreadable"]

    def test_an_annots_entry_that_is_not_an_annotation_downgrades_its_checks(self, tmp_dir):
        def build(pdf, page):
            page.obj[Name.Annots] = Array([String("not an annotation")])

        statuses = self._statuses_of(tmp_dir, "bad_annot_entry", build)
        for cid in ("tagged_annotations", "tab_order", "tagged_multimedia",
                    "navigation_links", "tagged_form_fields"):
            assert statuses[cid] == "needs_review", cid

    def test_a_null_annots_entry_is_nothing_rather_than_something_unread(self, tmp_dir):
        """The conforming twin: a null entry references no object, so a page
        carrying one has no annotations rather than an unreadable list."""

        def build(pdf, page):
            page.obj[Name.Annots] = Array([pikepdf.Object.parse(b"null")])

        statuses = self._statuses_of(tmp_dir, "null_annot_entry", build)
        for cid in ("tagged_annotations", "tab_order", "navigation_links"):
            assert statuses[cid] == NA, cid

    def test_a_javascript_entry_that_is_not_a_name_tree_downgrades_its_checks(self, tmp_dir):
        def build(pdf, page):
            pdf.Root[Name.Names] = Dictionary(JavaScript=pikepdf.Object.parse(b"7"))

        statuses = self._statuses_of(tmp_dir, "bad_js_tree", build)
        for cid in ("scripts", "screen_flicker", "timed_responses"):
            assert statuses[cid] == "needs_review", cid

    def test_a_script_body_that_will_not_decode_is_not_a_script_without_a_timer(self, tmp_dir):
        def build(pdf, page):
            stream = pdf.make_stream(b"app.setTimeOut('tick', 100)")
            stream.stream_dict[Name.Filter] = Name.FlateDecode
            pdf.Root[Name.OpenAction] = Dictionary(S=Name.JavaScript, JS=stream)

        statuses = self._statuses_of(tmp_dir, "bad_js_body", build)
        assert statuses["timed_responses"] == "needs_review"

    def test_a_field_tree_that_will_not_enumerate_downgrades_its_checks(self, tmp_dir):
        def build(pdf, page):
            pdf.Root[Name.AcroForm] = Dictionary(
                Fields=pdf.make_indirect(pikepdf.Object.parse(b"7"))
            )

        statuses = self._statuses_of(tmp_dir, "bad_field_tree", build)
        assert statuses["field_descriptions"] == "needs_review"
        assert statuses["tagged_form_fields"] == "needs_review"

    def test_a_table_the_span_arithmetic_cannot_model_is_reviewed_not_passed(self, tmp_dir):
        src = os.path.join(tmp_dir, "unmodellable_table.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B.draw(pdf, page, "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (body) Tj ET EMC")
        root = B.struct_root(pdf)
        doc = B.elem(pdf, "Document", root)
        table = B.elem(pdf, "Table", doc)
        header = B.elem(pdf, "TR", table, kids=[
            B.elem(pdf, "TH", table, page=page, Scope=Name.Column),
            B.elem(pdf, "TH", table, page=page, Scope=Name.Column),
        ])
        # A row holding no cells at all: the column arithmetic has nothing to
        # place, so the table's width is not a measurement.
        table[Name.K] = Array([header, B.elem(pdf, "TR", table)])
        para = B.elem(pdf, "P", doc, page=page, mcid=0)
        doc[Name.K] = Array([para, table])
        root[Name.K] = doc
        B.parent_tree(pdf, root, page, [para])
        B.make_conformant(pdf, page)
        res = check_accessibility(B.save(pdf, src))
        row = _check(res, "table_regularity")
        assert row["status"] == "needs_review", json.dumps(row, indent=2)
        assert [f["detail_key"] for f in row["findings"]] == ["table_not_modellable"]

    def test_an_outline_with_no_items_is_not_a_document_with_bookmarks(self, tmp_dir):
        src = os.path.join(tmp_dir, "empty_outline.pdf")
        pdf = B.new_pdf(pages=12)
        page = pdf.pages[0]
        B._one_tagged_paragraph(pdf, page)
        B.make_conformant(pdf, page)
        pdf.Root[Name.Outlines] = pdf.make_indirect(
            Dictionary(Type=Name.Outlines, Count=0)
        )
        res = check_accessibility(B.save(pdf, src))
        assert _statuses(res)["bookmarks"] == "warn"


class TestBoundedWalksSayTheyAreBounded:
    """A walk that stopped short is not a document that ended there."""

    def _deep_tree(self, path, depth):
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B.draw(
            pdf, page,
            "/Figure <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (a figure) Tj ET EMC",
        )
        root = B.struct_root(pdf)
        doc = B.elem(pdf, "Document", root)
        node = doc
        for _ in range(depth):
            kid = B.elem(pdf, "Div", node)
            node[Name.K] = Array([kid])
            node = kid
        # A figure with no /Alt, placed below the walk's depth cap.
        figure = B.elem(pdf, "Figure", node, page=page, mcid=0)
        node[Name.K] = Array([figure])
        root[Name.K] = doc
        B.parent_tree(pdf, root, page, [figure])
        B.make_conformant(pdf, page)
        return B.save(pdf, path)

    def test_the_audit_names_the_element_whose_children_it_did_not_reach(self, tmp_dir):
        import pikepdf as _pikepdf

        from engine.struct_audit import audit_tree

        src = self._deep_tree(os.path.join(tmp_dir, "deep.pdf"), 70)
        with _pikepdf.open(src) as pdf:
            tree = audit_tree(pdf)
        assert tree["truncated"], "a walk that stopped short must name where"
        assert tree["truncated"][0]["reason"] == "depth"

    def test_a_tree_walked_to_its_end_reports_no_truncation(self, tmp_dir):
        import pikepdf as _pikepdf

        from engine.struct_audit import audit_tree

        src = self._deep_tree(os.path.join(tmp_dir, "shallow.pdf"), 3)
        with _pikepdf.open(src) as pdf:
            tree = audit_tree(pdf)
        assert tree["truncated"] == []

    def test_a_truncated_tree_never_reports_a_structure_check_as_clean(self, tmp_dir):
        src = self._deep_tree(os.path.join(tmp_dir, "deep_report.pdf"), 70)
        res = check_accessibility(src)
        statuses = _statuses(res)
        # The figure with no /Alt is below the cap: the check that owns it
        # cannot see it, and `not_applicable` would claim the document has no
        # figures at all.
        for cid in ("figures_alt", "heading_nesting", "table_rows",
                    "alt_no_content", "list_items", "reading_order"):
            assert statuses[cid] == "needs_review", cid
        assert any(
            f["detail_key"] == "structure_truncated"
            for f in _check(res, "figures_alt")["findings"]
        )

    def test_the_shallow_twin_is_clean(self, tmp_dir):
        """The false-failure guard: an ordinary tree must not be reviewed."""
        src = self._deep_tree(os.path.join(tmp_dir, "shallow_report.pdf"), 3)
        statuses = _statuses(check_accessibility(src))
        assert statuses["figures_alt"] == "fail"
        for cid in ("table_rows", "list_items", "alt_no_content"):
            assert statuses[cid] == NA, cid


class TestCorpusGate:
    """Every PDF already in the tree, with its verdict pinned.

    A verdict that moves on a document nobody edited is a regression, and this
    is what catches it. Regenerate with `f24-corpus-build.local.py` and review
    the diff.
    """

    CORPUS = REPO / "tests" / "fixtures" / "a11y-corpus.json"

    def test_the_corpus_is_pinned(self):
        assert self.CORPUS.exists(), "run f24-corpus-build.local.py"
        pinned = json.loads(self.CORPUS.read_text(encoding="utf8"))
        assert pinned["documents"], "the corpus found no PDFs to pin"

    def test_no_document_in_the_tree_moved(self):
        pinned = json.loads(self.CORPUS.read_text(encoding="utf8"))
        moved = []
        for entry in pinned["documents"]:
            path = REPO / entry["path"]
            if not path.exists():
                continue
            try:
                res = check_accessibility(str(path))
            except Exception as exc:
                # A document the checker cannot open at all is pinned as a
                # refusal; it becoming READABLE is as much a change as a
                # verdict moving.
                if "refused" not in entry:
                    moved.append({"path": entry["path"], "error": str(exc)})
                continue
            if "refused" in entry:
                moved.append({"path": entry["path"], "now_opens": True})
                continue
            now = {c["id"]: c["status"] for c in res["checks"]}
            if now != entry["verdicts"]:
                diff = {k: (entry["verdicts"].get(k), now.get(k))
                        for k in set(now) | set(entry["verdicts"])
                        if now.get(k) != entry["verdicts"].get(k)}
                moved.append({"path": entry["path"], "diff": diff})
        assert moved == [], json.dumps(moved, indent=2)


class TestShippedShapeStillReadable:
    """The flat `checks` array, for a reader with no notion of a category."""

    def test_the_flat_list_is_the_categorized_one(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "baseline"))
        flat = [(c["id"], c["status"]) for c in res["checks"]]
        nested = [
            (c["id"], c["status"])
            for cat in res["categories"]
            for c in cat["checks"]
        ]
        assert flat == nested


class TestCategoryFilter:
    def test_one_category_runs_and_the_shape_is_unchanged(self, tmp_dir):
        src = _build(tmp_dir, "figure_no_alt")
        res = check_accessibility(src, category="alt_text")
        assert len(res["checks"]) == 32
        assert _statuses(res)["figures_alt"] == "fail"
        assert _statuses(res)["heading_nesting"] == NA

    def test_an_unknown_category_refuses_by_name(self, tmp_dir):
        src = _build(tmp_dir, "baseline")
        with pytest.raises(ValueError, match="unknown accessibility category"):
            check_accessibility(src, category="nonsense")


class TestEnglishSurface:
    """The flat rows carry an English name and sentence, so a caller with no
    catalog of its own reads a report rather than a list of identifiers."""

    def test_every_check_carries_a_name_and_a_sentence(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "figure_no_alt"))
        for check in res["checks"]:
            assert check["label"], check["id"]
            assert check["detail"], check["id"]

    def test_the_sentence_states_the_verdict_and_the_count(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "figure_no_alt"))
        row = _check(res, "figures_alt")
        assert row["detail"].startswith("Failed.")
        assert "1 of 1 checked." in row["detail"]

    def test_a_not_applicable_row_says_so(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "baseline"))
        assert "Not applicable" in _check(res, "table_rows")["detail"]

    def test_the_english_table_covers_the_inventory_exactly(self):
        from engine.accessibility import _ENGLISH

        assert sorted(_ENGLISH) == sorted(cid for cid, _ in CHECK_INVENTORY)
