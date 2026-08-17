"""Accessibility checker — 33 checks, five verdicts, addressed findings.

Every check is pinned TWICE: once on the fixture that fails it and once on the
conforming twin that must not. The `_ok` fixtures are the false-failure guards
— a checker that cries wolf on a well-tagged document is worse than the
six-check one it replaced, because the reader now has 33 reasons to doubt it.
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
        assert len(ids) == 33
        assert ids == [cid for cid, _ in CHECK_INVENTORY]
        assert len(set(ids)) == 33

    def test_categories_partition_the_checks(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "baseline"))
        assert [c["id"] for c in res["categories"]] == list(CATEGORIES)
        flat = [c["id"] for cat in res["categories"] for c in cat["checks"]]
        assert sorted(flat) == sorted(c["id"] for c in res["checks"])

    def test_not_applicable_is_excluded_from_the_pass_tally(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "baseline"))
        s = res["summary"]
        assert s["passed"] + s["failed"] + s["warnings"] + s["needs_review"] + s["not_applicable"] == 33
        assert s["applicable"] == 33 - s["not_applicable"]
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


class TestOneDefectIsReportedOnce:
    """A role two checks could both claim is claimed by exactly one of them.

    Two findings for one missing description read as two defects, and fixing
    the element clears both at once — a reader cannot tell that from the
    report."""

    def test_an_undescribed_formula_is_one_finding_under_figures_alt(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "formula_no_alt"))
        figures = _check(res, "figures_alt")
        assert figures["status"] == "fail"
        assert len(figures["findings"]) == 1
        assert figures["findings"][0]["values"]["role"] == "Formula"

    def test_the_other_alt_check_does_not_weigh_a_formula(self, tmp_dir):
        res = check_accessibility(_build(tmp_dir, "formula_no_alt"))
        other = _check(res, "other_elements_alt")
        assert other["status"] == NA
        assert other["findings"] == []


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

    def test_a_page_whose_paint_walk_did_not_complete_is_not_counted(self, tmp_dir, monkeypatch):
        """The count is what was measured, not what was present.

        No malformed document reaches this: a broken image stream, an image
        with no `/Width`, a broken `/OCProperties`, a `/Resources` that is not
        a dictionary and an `/ExtGState` that is not a dictionary are all
        absorbed by the paint walk. So the stage is broken where the checker
        calls it, as the permissions read is.
        """
        from engine import accessibility

        src = os.path.join(tmp_dir, "paint_stage.pdf")
        pdf = B.new_pdf(pages=2)
        B._one_tagged_paragraph(pdf, pdf.pages[0])
        B.make_conformant(pdf, pdf.pages[0])
        pdf.pages[1].obj[Name.Contents] = pdf.make_stream(
            b"0.5 0.5 0.5 rg 0 0 612 792 re f"
        )
        B.save(pdf, src)

        assert _check(check_accessibility(src), "image_only")["counted"] == 2

        real = accessibility.page_events

        def only_page_one(pdf_, page, off_set):
            if pdf_.pages.index(page) == 1:
                raise RuntimeError("this page's paint walk cannot complete")
            return real(pdf_, page, off_set)

        monkeypatch.setattr(accessibility, "page_events", only_page_one)
        res = check_accessibility(src)
        row = _check(res, "image_only")
        # Two pages present, one measured: counting the unmeasured one put a
        # page in the denominator the check never looked at.
        assert row["counted"] == 1, json.dumps(row, indent=2)
        assert row["status"] == "needs_review"
        assert [u["stage"] for u in res["unreadable"]] == ["paint"]


class TestTwoReadersOfOneDocument:
    """`image_only` used to put the whole-file question to whichever reader
    failed.

    The check walks the pages itself and then, when no page looked like a
    scan, asked `extract_text` whether the document has any text at all. That
    second question ran even when the walk had ALREADY read text off a page,
    so a document the two readers disagree about was reported as having no
    extractable text over text the checker had just extracted. Measured on the
    conformance corpus: 12 files.
    """

    def test_text_the_page_walk_read_settles_it(self, tmp_dir, monkeypatch):
        from engine import accessibility

        src = _build(tmp_dir, "baseline")
        assert _check(check_accessibility(src), "image_only")["status"] == "pass"

        def finds_nothing(_file, **_kw):
            return {"text": ""}

        monkeypatch.setattr(accessibility, "extract_text", finds_nothing)
        row = _check(check_accessibility(src), "image_only")
        assert row["status"] == "pass", json.dumps(row, indent=2)
        assert row["findings"] == []

    def test_a_document_with_no_text_at_all_still_fails(self, tmp_dir, monkeypatch):
        """The guard must not swallow the case the fall-through exists for."""
        from engine import accessibility

        src = os.path.join(tmp_dir, "no_text.pdf")
        pdf = B.new_pdf()
        # Painted, but nothing a reader can read, and far too small a mark to
        # count as a page-covering scan.
        pdf.pages[0].obj[Name.Contents] = pdf.make_stream(b"0 0 0 rg 10 10 4 4 re f")
        B.make_conformant(pdf, pdf.pages[0])
        B.save(pdf, src)

        def finds_nothing(_file, **_kw):
            return {"text": ""}

        monkeypatch.setattr(accessibility, "extract_text", finds_nothing)
        row = _check(check_accessibility(src), "image_only")
        assert row["status"] == "fail", json.dumps(row, indent=2)
        assert [f["detail_key"] for f in row["findings"]] == ["no_extractable_text"]


class TestWhatAnImperceptibleAnnotationIsOwed:
    """A widget the file stops from rendering presents nothing to a reader.

    Two ways a file says so, and neither was honoured by the checks that read
    descriptions off the structure tree: the Hidden and NoView flags (ISO
    32000-2, Table 167), and a `/Rect` whose corners coincide — the shape ISO
    32000-2, Table 166 exempts from carrying an appearance stream. Measured on
    the conformance corpus: 3 files reported a field with no description and 4
    an element with none, over annotations nobody can encounter.
    """

    def _one_field(self, tmp_dir, name, widget_extra=None, form_extra=None):
        src = os.path.join(tmp_dir, f"{name}.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        _root, doc = B._one_tagged_paragraph(pdf, page)
        B._tagged_field(pdf, page, doc, widget_extra=widget_extra, form_extra=form_extra)
        B.make_conformant(pdf, page)
        return check_accessibility(B.save(pdf, src))

    @pytest.mark.parametrize("flag", [2, 32])
    def test_a_flag_that_stops_rendering_exempts_the_field(self, tmp_dir, flag):
        res = self._one_field(tmp_dir, f"flag{flag}", widget_extra={"F": flag})
        assert _statuses(res)["field_descriptions"] == NA
        assert _statuses(res)["other_elements_alt"] == NA

    def test_a_perceivable_widget_is_still_weighed(self, tmp_dir):
        """The guard must not swallow the case the check exists for."""
        res = self._one_field(tmp_dir, "visible", form_extra={"T": String("Name field")})
        assert _statuses(res)["field_descriptions"] == "fail"

    def test_an_alt_over_an_imperceptible_widget_replaces_nothing(self, tmp_dir):
        res = self._one_field(
            tmp_dir, "hidden_described",
            widget_extra={"F": 2, "TU": String("Your full name")},
            form_extra={"Alt": String("Something else entirely")},
        )
        assert _statuses(res)["alt_hides_annotation"] == "pass"

    def test_an_alt_over_a_named_widget_still_replaces_it(self, tmp_dir):
        res = self._one_field(
            tmp_dir, "described",
            widget_extra={"TU": String("Your full name")},
            form_extra={"Alt": String("Something else entirely")},
        )
        row = _check(res, "alt_hides_annotation")
        assert row["status"] == "fail", json.dumps(row, indent=2)
        assert row["findings"][0]["values"]["hidden"] == "Your full name"


class TestATreeThatHoldsNothing:
    """A `/StructTreeRoot` is an entry point, not a structure.

    `/K` is what the hierarchy hangs from (ISO 32000-2 §14.7.2). A root with
    nothing under it defines no reading order and associates no content with
    any element, so `pass` on `tagged` is the claim the check exists to make,
    made over a document that delivers none of it.
    """

    def _empty(self, path, k=None):
        """A root holding no element, over a page whose text is all declared
        artifact — so `tagged` is the only claim the document rests on."""
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B.draw(pdf, page, "/Artifact BMC BT /F1 11 Tf 40 700 Td (Running header.) Tj ET EMC")
        entries = {} if k is None else {"K": k}
        root = pdf.make_indirect(Dictionary(Type=Name.StructTreeRoot, **entries))
        pdf.Root[Name.StructTreeRoot] = root
        pdf.Root[Name.MarkInfo] = Dictionary(Marked=True)
        B.make_conformant(pdf, page)
        return B.save(pdf, path)

    def test_a_root_with_no_kids_is_not_a_tagged_document(self, tmp_dir):
        res = check_accessibility(self._empty(os.path.join(tmp_dir, "no_k.pdf")))
        row = _check(res, "tagged")
        assert row["status"] == "fail", json.dumps(row, indent=2)
        assert [f["detail_key"] for f in row["findings"]] == ["structure_tree_empty"]

    def test_a_kids_array_holding_no_element_is_the_same_answer(self, tmp_dir):
        res = check_accessibility(
            self._empty(os.path.join(tmp_dir, "empty_k.pdf"), k=Array([]))
        )
        assert [f["detail_key"] for f in _check(res, "tagged")["findings"]] == [
            "structure_tree_empty"
        ]

    def test_one_element_is_enough_for_the_twin_to_pass(self, tmp_dir):
        """The false-failure guard: a tree with a single paragraph in it is a
        tagged document and must not be caught by the emptiness rule."""
        res = check_accessibility(_build(tmp_dir, "baseline"))
        row = _check(res, "tagged")
        assert row["status"] == "pass"
        assert row["findings"] == []

    def test_the_three_reasons_stay_distinguished(self, tmp_dir):
        no_root = check_accessibility(_build(tmp_dir, "untagged"))
        assert [f["detail_key"] for f in _check(no_root, "tagged")["findings"]] == [
            "structure_tree_missing"
        ]
        src = os.path.join(tmp_dir, "no_markinfo.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B._one_tagged_paragraph(pdf, page)
        B.make_conformant(pdf, page)
        del pdf.Root[Name.MarkInfo]
        unmarked = check_accessibility(B.save(pdf, src))
        assert [f["detail_key"] for f in _check(unmarked, "tagged")["findings"]] == [
            "mark_info_missing"
        ]


class TestNameTreeShapesTheIterationReadsPast:
    """`pikepdf.NameTree` yields rather than raises on a malformed tree.

    A leaf whose `/Names` array is odd-length drops or mis-pairs its entries;
    a `/Names` that is not an array, a node declaring neither key, and a
    `/Kids` that is not an array each yield nothing at all. Three checks read
    that as "this document has no scripts", so each shape below is pinned to
    the review row it must produce instead.
    """

    def _tree(self, path, build):
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B._one_tagged_paragraph(pdf, page)
        B.make_conformant(pdf, page)
        action = pdf.make_indirect(
            Dictionary(S=Name.JavaScript, JS=String("app.setInterval('tick()', 100);"))
        )
        pdf.Root[Name.Names] = Dictionary(
            JavaScript=pdf.make_indirect(build(pdf, action))
        )
        return B.save(pdf, path)

    SCRIPT_CHECKS = ("scripts", "screen_flicker", "timed_responses")

    UNREADABLE = {
        "lone_value": lambda pdf, a: Dictionary(Names=Array([a])),
        "trailing_key": lambda pdf, a: Dictionary(
            Names=Array([String("boot"), a, String("orphan")])
        ),
        "leading_key": lambda pdf, a: Dictionary(
            Names=Array([String("orphan"), String("boot"), a])
        ),
        "names_not_an_array": lambda pdf, a: Dictionary(Names=pikepdf.Object.parse(b"7")),
        "neither_key": lambda pdf, a: Dictionary(Limits=Array([String("a"), String("z")])),
        "kids_not_an_array": lambda pdf, a: Dictionary(Kids=pikepdf.Object.parse(b"7")),
        "odd_leaf_below_kids": lambda pdf, a: Dictionary(
            Kids=Array([
                pdf.make_indirect(
                    Dictionary(Limits=Array([String("a"), String("z")]),
                               Names=Array([String("boot"), a, String("orphan")]))
                )
            ])
        ),
    }

    @pytest.mark.parametrize("shape", sorted(UNREADABLE))
    def test_a_tree_read_past_is_named_on_every_script_check(self, tmp_dir, shape):
        src = self._tree(os.path.join(tmp_dir, f"nt_{shape}.pdf"), self.UNREADABLE[shape])
        res = check_accessibility(src)
        for cid in self.SCRIPT_CHECKS:
            row = _check(res, cid)
            assert row["status"] == "needs_review", (shape, json.dumps(row, indent=2))
            assert "scripts_unreadable" in {f["detail_key"] for f in row["findings"]}, shape

    def test_a_site_the_iteration_did_reach_still_rides_with_the_gap(self, tmp_dir):
        """An unpaired entry does not stop the iteration: the tree yields one
        site AND is short by one, and the report says both."""
        src = self._tree(os.path.join(tmp_dir, "nt_both.pdf"),
                         self.UNREADABLE["trailing_key"])
        row = _check(check_accessibility(src), "scripts")
        assert sorted({f["detail_key"] for f in row["findings"]}) == [
            "script_site", "scripts_unreadable"
        ]

    WELL_FORMED = {
        "leaf": lambda pdf, a: Dictionary(Names=Array([String("boot"), a])),
        "kid": lambda pdf, a: Dictionary(
            Kids=Array([
                pdf.make_indirect(
                    Dictionary(Limits=Array([String("a"), String("z")]),
                               Names=Array([String("boot"), a]))
                )
            ])
        ),
        # A tree that legitimately holds nothing. An even-length array of
        # length zero is well-formed and must not read as unreadable.
        "empty_leaf": lambda pdf, a: Dictionary(Names=Array([])),
    }

    @pytest.mark.parametrize("shape", sorted(WELL_FORMED))
    def test_a_well_formed_tree_gains_no_review_row(self, tmp_dir, shape):
        src = self._tree(os.path.join(tmp_dir, f"ok_{shape}.pdf"), self.WELL_FORMED[shape])
        res = check_accessibility(src)
        for cid in self.SCRIPT_CHECKS:
            keys = {f["detail_key"] for f in _check(res, cid)["findings"]}
            assert "scripts_unreadable" not in keys, (shape, cid)

    def test_a_catalog_with_no_javascript_tree_is_not_a_gap(self, tmp_dir):
        src = os.path.join(tmp_dir, "other_tree.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B._one_tagged_paragraph(pdf, page)
        B.make_conformant(pdf, page)
        pdf.Root[Name.Names] = Dictionary(
            EmbeddedFiles=pdf.make_indirect(Dictionary(Names=Array([])))
        )
        statuses = _statuses(check_accessibility(B.save(pdf, src)))
        for cid in self.SCRIPT_CHECKS:
            assert statuses[cid] == NA, cid


class TestASpanThatDoesNotRead:
    """A malformed span is a width nobody measured.

    The default of 1 still carries the walk, so a regular table is never
    reported ragged — but the width it produces is not a measurement of THIS
    table, and reporting it as one is a clean claim over an unread value.
    """

    def _table(self, path, extra):
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B._table(
            pdf, page,
            [
                [("Region", {"_role": "TH", "Scope": Name.Column}),
                 ("Revenue", {"_role": "TH", "Scope": Name.Column})],
                [("North", dict(extra)), ("120", {})],
            ],
            table_extra={"Summary": String("Revenue by region")},
        )
        B.make_conformant(pdf, page)
        return B.save(pdf, path)

    UNREADABLE = {
        "a_name": {"ColSpan": Name.Wide},
        "a_string": {"ColSpan": String("two")},
        "zero": {"ColSpan": 0},
        "negative_rowspan": {"RowSpan": -3},
    }

    @pytest.mark.parametrize("shape", sorted(UNREADABLE))
    def test_a_span_that_is_not_a_positive_integer_is_reviewed(self, tmp_dir, shape):
        src = self._table(os.path.join(tmp_dir, f"span_{shape}.pdf"),
                          self.UNREADABLE[shape])
        row = _check(check_accessibility(src), "table_regularity")
        assert row["status"] == "needs_review", (shape, json.dumps(row, indent=2))
        assert [f["detail_key"] for f in row["findings"]] == ["table_span_unreadable"]

    @pytest.mark.parametrize("extra", [{}, {"ColSpan": 1}, {"RowSpan": 1}])
    def test_a_span_that_reads_leaves_the_table_measured(self, tmp_dir, extra):
        src = self._table(os.path.join(tmp_dir, "span_ok.pdf"), extra)
        row = _check(check_accessibility(src), "table_regularity")
        assert row["status"] == "pass", json.dumps(row, indent=2)
        assert row["findings"] == []

    def test_the_spanning_pass_fixtures_still_measure(self, tmp_dir):
        """The two shipped false-failure guards: real spans are measurements
        and must not be swept into the unread class."""
        for name in ("table_colspan_regular_ok", "table_rowspan_regular_ok"):
            row = _check(check_accessibility(_build(tmp_dir, name)), "table_regularity")
            assert row["status"] == "pass", (name, json.dumps(row, indent=2))

    def test_span_of_reports_whether_it_read(self):
        from engine.struct_audit import Node, span_of

        node = Node([0], "TD", "TD", None)
        assert span_of(node, "ColSpan") == (1, True)
        node.attrs = {"ColSpan": 2}
        assert span_of(node, "ColSpan") == (2, True)
        for bad in (0, -3, "two", None):
            node.attrs = {"ColSpan": bad} if bad is not None else {"ColSpan": Name.Wide}
            assert span_of(node, "ColSpan") == (1, False), bad


class TestOneAnnotationReader:
    """`/Annots` is walked once, and the walk names what it could not read.

    Three call sites read that list — the annotation inventory, the script
    inventory and the structure walk's `/OBJR` resolution — and only the first
    reported the gap, so a script site behind an unreadable entry read as a
    document with no scripts.
    """

    def _page_with(self, path, entries):
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B._one_tagged_paragraph(pdf, page)
        B.make_conformant(pdf, page)
        page.obj[Name.Annots] = Array(entries(pdf, page))
        return B.save(pdf, path)

    ANNOTATION_CHECKS = ("tagged_annotations", "tab_order", "tagged_multimedia",
                         "navigation_links", "tagged_form_fields",
                         "alt_hides_annotation", "other_elements_alt")
    SCRIPT_CHECKS = ("scripts", "screen_flicker", "timed_responses")

    def test_an_unreadable_entry_reaches_the_script_checks_too(self, tmp_dir):
        src = self._page_with(
            os.path.join(tmp_dir, "bad_entry.pdf"),
            lambda pdf, page: [String("not an annotation")],
        )
        res = check_accessibility(src)
        for cid in self.ANNOTATION_CHECKS + self.SCRIPT_CHECKS:
            assert _statuses(res)[cid] == "needs_review", cid
        assert {f["detail_key"] for f in _check(res, "scripts")["findings"]} == {
            "scripts_unreadable"
        }

    def test_a_null_entry_stays_silent_on_every_reader(self, tmp_dir):
        """A null entry references no object (ISO 32000-2 §7.3.9): nothing to
        read rather than something left unread, on all three readers."""
        src = self._page_with(
            os.path.join(tmp_dir, "null_entry.pdf"),
            lambda pdf, page: [pikepdf.Object.parse(b"null")],
        )
        statuses = _statuses(check_accessibility(src))
        for cid in ("tagged_annotations", "tab_order", "navigation_links") + self.SCRIPT_CHECKS:
            assert statuses[cid] == NA, cid

    def test_a_script_behind_a_null_entry_is_still_found(self, tmp_dir):
        src = self._page_with(
            os.path.join(tmp_dir, "null_then_script.pdf"),
            lambda pdf, page: [
                pikepdf.Object.parse(b"null"),
                pdf.make_indirect(
                    Dictionary(
                        Type=Name.Annot, Subtype=Name.Link,
                        Rect=Array([40, 400, 200, 420]), F=4,
                        A=Dictionary(S=Name.JavaScript,
                                     JS=String("app.setTimeOut('t()', 10);")),
                    )
                ),
            ],
        )
        row = _check(check_accessibility(src), "timed_responses")
        assert row["status"] == "needs_review"
        assert row["findings"][0]["address"] == {
            "kind": "object", "page": 1, "annotation": 1
        }

    def test_the_structure_walk_addresses_the_same_positions(self, tmp_dir):
        """`/OBJR` resolution and the annotation inventory number the list the
        same way, so a finding that pairs them survives a skipped entry."""
        src = os.path.join(tmp_dir, "objr_after_null.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        root, doc = B._one_tagged_paragraph(pdf, page)
        annot = pdf.make_indirect(
            Dictionary(Type=Name.Annot, Subtype=Name.Square,
                       Rect=Array([40, 500, 200, 560]), F=4,
                       Contents=String("The real note"))
        )
        page.obj[Name.Annots] = Array([pikepdf.Object.parse(b"null"), annot])
        wrapper = B.elem(pdf, "Annot", doc, page=page,
                         Alt=String("Something else entirely"),
                         kids=[Dictionary(Type=Name.OBJR, Obj=annot)])
        doc[Name.K] = Array(list(doc[Name.K]) + [wrapper])
        B.make_conformant(pdf, page)
        res = check_accessibility(B.save(pdf, src))
        row = _check(res, "alt_hides_annotation")
        assert row["status"] == "fail", json.dumps(row, indent=2)
        assert row["findings"][0]["values"]["hidden"] == "The real note"

    def test_the_reader_separates_nothing_from_unread(self, tmp_dir):
        from engine.struct_audit import annots_of

        src = self._page_with(
            os.path.join(tmp_dir, "mixed.pdf"),
            lambda pdf, page: [
                pikepdf.Object.parse(b"null"),
                String("not an annotation"),
                pdf.make_indirect(
                    Dictionary(Type=Name.Annot, Subtype=Name.Square,
                               Rect=Array([40, 500, 200, 560]), F=4)
                ),
            ],
        )
        with pikepdf.open(src) as pdf:
            entries, unread = annots_of(pdf)
        assert [(e["page"], e["index"]) for e in entries] == [(1, 2)]
        assert [u["page"] for u in unread] == [1]
        assert "annotation 1" in unread[0]["reason"]


class TestAReadThatRaisesStillYieldsAReport:
    """A reader that raises is a gap, not the end of the report.

    Fail-loud costs the reader all 32 answers to name one unreadable
    structure; the same failure named as a review row costs one.
    """

    def test_a_catalog_names_that_is_not_a_dictionary_does_not_abort(self, tmp_dir):
        src = os.path.join(tmp_dir, "names_is_an_integer.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B._one_tagged_paragraph(pdf, page)
        B.make_conformant(pdf, page)
        pdf.Root[Name.Names] = pdf.make_indirect(pikepdf.Object.parse(b"7"))
        res = check_accessibility(B.save(pdf, src))
        statuses = _statuses(res)
        assert len(res["checks"]) == 33
        for cid in ("scripts", "screen_flicker", "timed_responses"):
            assert statuses[cid] == "needs_review", cid
        # The other 29 are still answered: one unreadable structure costs one
        # row, not the report.
        assert statuses["tagged"] == "pass"
        assert statuses["lang"] == "pass"
        assert statuses["contrast"] == "pass"

    def test_an_annotation_reader_that_raises_becomes_one_review_row(self, tmp_dir, monkeypatch):
        """The reader's own boundary. A gap it cannot attribute to a page
        carries the key whose sentence names none."""
        from engine import accessibility

        src = _build(tmp_dir, "baseline")

        def raises(pdf):
            raise RuntimeError("the annotation lists cannot be enumerated")

        monkeypatch.setattr(accessibility, "annots_of", raises)
        res = check_accessibility(src)
        assert len(res["checks"]) == 33
        for cid in ("tagged_annotations", "tab_order", "navigation_links",
                    "scripts", "screen_flicker", "timed_responses"):
            assert _statuses(res)[cid] == "needs_review", cid
        assert {f["detail_key"] for f in _check(res, "tab_order")["findings"]} == {
            "annotations_unreadable_document"
        }
        assert _statuses(res)["tagged"] == "pass"

    def test_an_additional_actions_dictionary_that_is_not_one_is_named(self, tmp_dir):
        for where, apply in (
            ("catalog", lambda pdf, page: pdf.Root.__setitem__(
                Name.AA, pdf.make_indirect(Array([String("x")])))),
            ("page", lambda pdf, page: page.obj.__setitem__(
                Name.AA, pdf.make_stream(b"nonsense"))),
        ):
            src = os.path.join(tmp_dir, f"aa_{where}.pdf")
            pdf = B.new_pdf()
            page = pdf.pages[0]
            B._one_tagged_paragraph(pdf, page)
            B.make_conformant(pdf, page)
            apply(pdf, page)
            statuses = _statuses(check_accessibility(B.save(pdf, src)))
            assert statuses["scripts"] == "needs_review", where


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


class TestStructureNesting:
    """Placement, judged against the tables that state it.

    ISO 32000-2 14.8.4.7.1 makes "anywhere" the default, so a finding here has
    to come from a table that says otherwise: Table 370 and Table 371's
    `Internal to` categories, Table 369's content models, Table 372's caption
    rule, and — for an element in the PDF 2.0 standard structure namespace
    alone — Table L.2's parent lists. Everything else is reported as uncovered
    rather than as verified.
    """

    def _nesting(self, tmp_dir, name):
        return _check(check_accessibility(_build(tmp_dir, name)), "structure_nesting")

    def test_a_label_hung_off_the_list_names_child_parent_and_path(self, tmp_dir):
        row = self._nesting(tmp_dir, "lbl_under_l_fails")
        assert row["status"] == "fail", json.dumps(row, indent=2)
        assert [f["detail_key"] for f in row["findings"]] == [
            "structure_nesting_violation"
        ]
        finding = row["findings"][0]
        assert finding["values"] == {"child": "Lbl", "parent": "L", "page": 1}
        assert finding["address"]["kind"] == "struct"
        assert finding["address"]["path"] == [0, 1, 1]

    def test_a_row_group_outside_a_table_is_named(self, tmp_dir):
        row = self._nesting(tmp_dir, "thead_outside_table_fails")
        assert row["status"] == "fail", json.dumps(row, indent=2)
        assert row["findings"][0]["values"]["child"] == "THead"

    def test_the_conforming_twins_report_what_they_checked(self, tmp_dir):
        for name in ("lbl_under_li_ok", "lbl_in_fenote_ok", "toc_link_lbl_ok",
                     "thead_tbody_ok"):
            row = self._nesting(tmp_dir, name)
            assert row["status"] == "pass", (name, json.dumps(row, indent=2))
            assert row["data"]["judged"] > 0, name

    @pytest.mark.parametrize(
        "name,owner",
        [
            ("tr_outside_table", "table_rows"),
            ("td_outside_tr", "table_cells"),
            ("li_outside_l", "list_items"),
            ("li_under_div_under_sect_fails", "list_items"),
            ("lbody_outside_li_fails", "list_labels"),
        ],
    )
    def test_one_defect_is_reported_by_one_check(self, tmp_dir, name, owner):
        """The two check sets divide the world between what an element is and
        where it sits, so a misplaced row is one finding under one id."""
        res = check_accessibility(_build(tmp_dir, name))
        statuses = _statuses(res)
        assert statuses[owner] == "fail", json.dumps(_check(res, owner), indent=2)
        row = _check(res, "structure_nesting")
        assert row["findings"] == [], json.dumps(row, indent=2)
        assert row["data"]["delegated"] > 0

    def test_a_role_mapped_tag_is_judged_as_what_it_maps_to(self, tmp_dir):
        """The walk reads the resolved role, so a private tag mapped to `LI`
        is counted as the list item it maps to rather than as a type no table
        covers."""
        row = self._nesting(tmp_dir, "custom_mapped_to_li_judged_as_li")
        assert row["data"]["delegated"] == 2, json.dumps(row, indent=2)
        assert row["findings"] == []

    def test_a_document_with_no_tree_is_not_applicable(self, tmp_dir):
        row = self._nesting(tmp_dir, "untagged")
        assert row["status"] == NA
        assert row["findings"] == []

    def _tree(self, tmp_dir, name, build):
        """One page, one paragraph, plus whatever `build` hangs off it."""
        src = os.path.join(tmp_dir, f"{name}.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        root, doc = B._one_tagged_paragraph(pdf, page)
        build(pdf, page, root, doc)
        B.make_conformant(pdf, page)
        return check_accessibility(B.save(pdf, src))

    def test_a_namespace_that_will_not_read_is_reviewed_not_passed(self, tmp_dir):
        """Which rule set governs an element is what an unreadable `/NS`
        withholds, so the element is not judged and the check says so."""

        def build(pdf, page, root, doc):
            stray = B.elem(pdf, "THead", doc, page=page,
                           NS=pikepdf.Object.parse(b"7"))
            doc[Name.K] = Array(list(doc[Name.K]) + [stray])

        res = self._tree(tmp_dir, "bad_ns", build)
        row = _check(res, "structure_nesting")
        assert row["status"] == "needs_review", json.dumps(row, indent=2)
        assert [f["detail_key"] for f in row["findings"]] == [
            "structure_nesting_unreadable"
        ]

    def test_a_namespace_no_table_covers_is_uncovered_rather_than_failed(self, tmp_dir):
        """ISO 32000-2 14.8.6.3's MathML namespace, on an element whose
        position the PDF 2.0 tables would refuse. No table reaches it, so the
        check counts it and reports nothing."""

        from engine.struct_nesting import MATHML

        def build(pdf, page, root, doc):
            ns = pdf.make_indirect(
                Dictionary(Type=Name.Namespace, NS=String(MATHML))
            )
            root[Name.Namespaces] = Array([ns])
            stray = B.elem(pdf, "math", doc, page=page, NS=ns)
            doc[Name.K] = Array(list(doc[Name.K]) + [stray])

        res = self._tree(tmp_dir, "mathml_ns", build)
        row = _check(res, "structure_nesting")
        assert row["findings"] == [], json.dumps(row, indent=2)
        assert row["data"]["uncovered"] >= 1

    def test_a_grouping_element_that_inherits_containment_is_read_through(self, tmp_dir):
        """ISO 32000-2 Table 365: `Div` inherits its parent's containment, so
        a list item inside a `Div` inside the list is placed correctly and the
        label beside it is too."""
        src = os.path.join(tmp_dir, "div_between.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B.draw(
            pdf, page,
            "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
            "/Lbl <</MCID 1>> BDC BT /F1 11 Tf 40 660 Td (1.) Tj ET EMC\n"
            "/LBody <</MCID 2>> BDC BT /F1 11 Tf 60 660 Td (An item.) Tj ET EMC",
        )
        root = B.struct_root(pdf)
        ns = B.namespace(pdf, root)
        doc = B.elem(pdf, "Document", root, NS=ns)
        para = B.elem(pdf, "P", doc, page=page, mcid=0, NS=ns)
        lbl = B.elem(pdf, "Lbl", doc, page=page, mcid=1, NS=ns)
        body = B.elem(pdf, "LBody", doc, page=page, mcid=2, NS=ns)
        item = B.elem(pdf, "LI", doc, kids=[lbl, body], NS=ns)
        div = B.elem(pdf, "Div", doc, kids=[item], NS=ns)
        lst = B.elem(pdf, "L", doc, kids=[div], NS=ns)
        doc[Name.K] = Array([para, lst])
        root[Name.K] = doc
        B.parent_tree(pdf, root, page, [para, lbl, body])
        B.make_conformant(pdf, page)
        row = _check(check_accessibility(B.save(pdf, src)), "structure_nesting")
        assert row["findings"] == [], json.dumps(row, indent=2)

    def test_the_list_checks_read_the_same_inheritance(self, tmp_dir):
        """One question, one answer: the list checks judge placement against
        the effective parent the nesting check does, so a list item inside a
        `Div` inside its `L` is placed correctly on every check that looks."""
        res = check_accessibility(_build(tmp_dir, "li_in_div_in_l_ok"))
        statuses = _statuses(res)
        assert statuses["list_items"] == "pass", json.dumps(
            _check(res, "list_items"), indent=2
        )
        assert statuses["list_labels"] == "pass", json.dumps(
            _check(res, "list_labels"), indent=2
        )
        assert _check(res, "structure_nesting")["findings"] == []

    def test_a_grouping_element_does_not_launder_a_misplaced_item(self, tmp_dir):
        """The read-through reaches the real container rather than stopping at
        the first thing that is not a list: a `Sect` is no list, so the item
        under it is misplaced and the finding names the `Sect`."""
        res = check_accessibility(_build(tmp_dir, "li_under_div_under_sect_fails"))
        row = _check(res, "list_items")
        assert row["status"] == "fail", json.dumps(row, indent=2)
        assert [f["detail_key"] for f in row["findings"]] == ["list_item_outside_list"]
        assert row["findings"][0]["values"] == {"parent": "Sect"}

    def test_a_caption_between_the_list_items_is_named(self, tmp_dir):
        """ISO 32000-2 Table 370: a caption inside a list shall be its first or
        its last child."""
        src = os.path.join(tmp_dir, "caption_middle.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B.draw(
            pdf, page,
            "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
            "/LBody <</MCID 1>> BDC BT /F1 11 Tf 60 660 Td (First.) Tj ET EMC\n"
            "/Caption <</MCID 2>> BDC BT /F1 11 Tf 40 630 Td (A caption.) Tj ET EMC\n"
            "/LBody <</MCID 3>> BDC BT /F1 11 Tf 60 600 Td (Second.) Tj ET EMC",
        )
        root = B.struct_root(pdf)
        doc = B.elem(pdf, "Document", root)
        para = B.elem(pdf, "P", doc, page=page, mcid=0)
        first_lbl = B.elem(pdf, "Lbl", doc, page=page)
        first = B.elem(pdf, "LI", doc, kids=[
            first_lbl, B.elem(pdf, "LBody", doc, page=page, mcid=1)])
        caption = B.elem(pdf, "Caption", doc, page=page, mcid=2)
        second_lbl = B.elem(pdf, "Lbl", doc, page=page)
        second = B.elem(pdf, "LI", doc, kids=[
            second_lbl, B.elem(pdf, "LBody", doc, page=page, mcid=3)])
        lst = B.elem(pdf, "L", doc, kids=[first, caption, second])
        doc[Name.K] = Array([para, lst])
        root[Name.K] = doc
        B.parent_tree(pdf, root, page, [para])
        B.make_conformant(pdf, page)
        row = _check(check_accessibility(B.save(pdf, src)), "structure_nesting")
        assert row["status"] == "fail", json.dumps(row, indent=2)
        assert row["findings"][0]["values"]["child"] == "Caption"

    def test_a_caption_at_the_end_of_the_list_is_not(self, tmp_dir):
        """The false-failure twin: the same caption as the list's last child."""
        src = os.path.join(tmp_dir, "caption_last.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        B.draw(
            pdf, page,
            "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
            "/LBody <</MCID 1>> BDC BT /F1 11 Tf 60 660 Td (First.) Tj ET EMC\n"
            "/Caption <</MCID 2>> BDC BT /F1 11 Tf 40 630 Td (A caption.) Tj ET EMC",
        )
        root = B.struct_root(pdf)
        doc = B.elem(pdf, "Document", root)
        para = B.elem(pdf, "P", doc, page=page, mcid=0)
        item = B.elem(pdf, "LI", doc, kids=[
            B.elem(pdf, "Lbl", doc, page=page),
            B.elem(pdf, "LBody", doc, page=page, mcid=1)])
        caption = B.elem(pdf, "Caption", doc, page=page, mcid=2)
        lst = B.elem(pdf, "L", doc, kids=[item, caption])
        doc[Name.K] = Array([para, lst])
        root[Name.K] = doc
        B.parent_tree(pdf, root, page, [para])
        B.make_conformant(pdf, page)
        row = _check(check_accessibility(B.save(pdf, src)), "structure_nesting")
        assert row["findings"] == [], json.dumps(row, indent=2)


class TestTheCompiledTable:
    """The data the check reads, checked against the clauses it cites."""

    def test_every_entry_cites_the_table_it_came_from(self):
        from engine.struct_nesting import CATEGORY, CONTAINMENT, CONTENT_MODEL

        for role, rule in CONTAINMENT.items():
            assert rule.cite, role
            assert (rule.parents is None) != (not rule.ancestor), role
        for role, (allowed, cite) in CONTENT_MODEL.items():
            assert allowed and cite, role
        for role, (category, cite) in CATEGORY.items():
            assert category and cite, role

    def test_the_annex_whitelist_agrees_with_the_per_type_statements(self):
        """Two readings of one standard: Table 370 and Table 371 name the
        container in the Category column, Table L.2 lists the same containers
        among the type's parents. A disagreement is a compiled-table error."""
        from engine.struct_nesting import CONTAINMENT, PARENTS_2_0

        for role, rule in CONTAINMENT.items():
            if rule.parents is None:
                continue
            assert rule.parents <= PARENTS_2_0[role], role

    def test_a_numbered_heading_is_read_as_the_family_the_tables_name(self):
        from engine.struct_nesting import heading_family

        assert heading_family("H1") == "Hn"
        assert heading_family("H12") == "Hn"
        assert heading_family("H") == "H"
        # Table 366 forbids a leading zero and any prefix or postfix, so these
        # are not headings and must not be judged as one.
        for bad in ("H07", "H-7", "h7", "Hx", "Head"):
            assert heading_family(bad) == bad, bad


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
        assert len(res["checks"]) == 33
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
