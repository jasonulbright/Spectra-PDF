"""The accessibility fixes — every one applied, re-checked, and validated.

The clause that matters is the last one in each round trip: **no OTHER check's
verdict moved**. A fix that repairs one check by breaking another is exactly
what a per-check test cannot see, and it is the failure mode a repair tool has
to be proved against before it is offered as one click.

Where a cascade IS legitimate it is pinned BY NAME rather than tolerated: a
document with no alt text left has nothing for the alt-text checks to apply to,
and giving a form field the description it lacked is what makes a tag's
overriding `/Alt` a finding. Each of those is a claim the checker is right to
make, and each is written down here so a future change to either side has to
disturb a test.
"""

import json
import os

import pytest
from pikepdf import Name

import a11y_builders as B
from engine.accessibility import check_accessibility
from engine.accessibility_fixes import (
    AUTHORED_CHECKS,
    AUTOMATIC_CHECKS,
    apply_accessibility_fixes,
)
from engine.check import check as validate
from engine.doc_properties import (
    set_document_language,
    set_document_title,
    set_page_tab_order,
    validate_language_tag,
)
from engine.form_authoring import set_field_description
from engine.forms import read_form_fields
from engine.struct_fix import set_table_headers
from engine.struct_tree import get_struct_tree, set_struct_props

# A verdict moving TO one of these is never a regression: the document lost the
# thing the check applied to, or gained something that now passes.
_BENIGN = ("pass", "not_applicable")


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


def _build(tmp_dir, name):
    return B.ROSTER[name][0](os.path.join(tmp_dir, f"{name}.pdf"))


def _statuses(path) -> dict:
    return {c["id"]: c["status"] for c in check_accessibility(path)["checks"]}


def _check(path, cid) -> dict:
    return next(c for c in check_accessibility(path)["checks"] if c["id"] == cid)


def _moved(before: dict, after: dict, own: str) -> dict:
    return {
        k: (before[k], after[k])
        for k in before
        if k != own and before[k] != after[k]
    }


def _round_trip(path, cid, apply, *, allow_moves=()):
    """Apply → re-check → the check no longer fails, the document still
    validates, and nothing else regressed."""
    before = _statuses(path)
    assert before[cid] in ("fail", "warn"), (cid, before[cid])
    apply(path)
    after = _statuses(path)
    assert after[cid] in _BENIGN, json.dumps(_check(path, cid), indent=2)
    moved = _moved(before, after, cid)
    for key, (was, now) in moved.items():
        if key in allow_moves:
            continue
        assert now in _BENIGN, (cid, key, was, now)
    report = validate(path)
    assert report["summary"]["errors"] == 0, json.dumps(report["issues"], indent=2)
    return moved


class TestTheTwoFixLists:
    def test_every_automatic_check_has_a_door(self):
        from engine.accessibility_fixes import _DOORS

        assert sorted(_DOORS) == sorted(AUTOMATIC_CHECKS)

    def test_title_is_the_only_check_in_both_lists(self):
        both = set(AUTOMATIC_CHECKS) & set(AUTHORED_CHECKS)
        assert both == {"title"}

    def test_an_unknown_check_refuses_by_name(self, tmp_dir):
        src = _build(tmp_dir, "baseline")
        with pytest.raises(ValueError, match="no automatic accessibility fix exists"):
            apply_accessibility_fixes(src, src, checks=["contrast"])

    def test_a_named_fix_with_nothing_to_repair_says_so(self, tmp_dir):
        src = _build(tmp_dir, "baseline")
        with pytest.raises(ValueError, match="nothing here for that fix"):
            apply_accessibility_fixes(src, src, checks=["tab_order"])


class TestAutomaticFixes:
    """Each automatic fix, on the fixture that fails the check it repairs."""

    def test_permissions(self, tmp_dir):
        src = _build(tmp_dir, "perm_blocked")
        _round_trip(src, "permissions", lambda p: apply_accessibility_fixes(p, p, ["permissions"]))
        import pikepdf

        with pikepdf.open(src) as pdf:
            # The encryption is REWRITTEN, not dropped, and every other
            # permission the document declared is still declared.
            assert pdf.is_encrypted
            assert pdf.allow.accessibility
            assert not pdf.allow.extract

    def test_permissions_refuses_behind_an_owner_password(self, tmp_dir):
        src = _build(tmp_dir, "perm_blocked_owner_password")
        assert _statuses(src)["permissions"] == "fail"
        with pytest.raises(RuntimeError, match="owner password"):
            apply_accessibility_fixes(src, src, ["permissions"])
        assert _statuses(src)["permissions"] == "fail"

    def test_tagged(self, tmp_dir):
        src = _build(tmp_dir, "untagged")
        # Autotagging gives every structure check something to answer, which
        # is a document gaining checks rather than losing a verdict.
        _round_trip(src, "tagged", lambda p: apply_accessibility_fixes(p, p, ["tagged"]))
        assert get_struct_tree(src)["tagged"]

    def test_suspects(self, tmp_dir):
        src = _build(tmp_dir, "suspects_flag")
        _round_trip(src, "suspects", lambda p: apply_accessibility_fixes(p, p, ["suspects"]))
        import pikepdf

        with pikepdf.open(src) as pdf:
            # Written false rather than deleted: ISO 32000-2 Table 321 makes
            # false the default, and a document that once carried the flag is
            # clearer for saying it no longer holds.
            assert pdf.Root[Name.MarkInfo][Name("/Suspects")] is False
            assert bool(pdf.Root[Name.MarkInfo][Name.Marked])

    def test_embedded_file_names(self, tmp_dir):
        src = _build(tmp_dir, "embedded_file_no_unicode_name")
        _round_trip(src, "embedded_file_names",
                    lambda p: apply_accessibility_fixes(p, p, ["embedded_file_names"]))
        import pikepdf

        with pikepdf.open(src) as pdf:
            spec = pdf.Root[Name.Names][Name("/EmbeddedFiles")][Name.Names][1]
            # The same name, not a new one: the two keys differ only in the
            # encoding they are written in.
            assert str(spec[Name("/UF")]) == str(spec[Name("/F")]) == "notes.txt"

    def test_embedded_file_names_transcodes_rather_than_copying_bytes(self, tmp_dir):
        src = _build(tmp_dir, "embedded_file_no_system_name_ascii")
        _round_trip(src, "embedded_file_names",
                    lambda p: apply_accessibility_fixes(p, p, ["embedded_file_names"]))
        import pikepdf

        with pikepdf.open(src) as pdf:
            spec = pdf.Root[Name.Names][Name("/EmbeddedFiles")][Name.Names][1]
            # `/F` is a BYTE string: an ASCII name is written as those bytes,
            # never as the UTF-16 the text key may hold.
            assert bytes(spec[Name("/F")]) == b"notes.txt"
            assert str(spec[Name("/UF")]) == "notes.txt"

    def test_embedded_file_names_will_not_write_a_name_no_encoding_spells(self, tmp_dir):
        src = _build(tmp_dir, "embedded_file_no_system_name")
        with pytest.raises(ValueError, match="nothing here for that fix"):
            apply_accessibility_fixes(src, src, ["embedded_file_names"])
        import pikepdf

        with pikepdf.open(src) as pdf:
            spec = pdf.Root[Name.Names][Name("/EmbeddedFiles")][Name.Names][1]
            # Absent, not mojibake: copying the `/UF` bytes would have written
            # a `/F` reading as UTF-16 code units run through a byte encoding.
            assert Name("/F") not in spec
        assert _statuses(src)["embedded_file_names"] == "fail"

    def test_embedded_file_names_refuses_when_there_is_no_name_to_copy(self, tmp_dir):
        src = _build(tmp_dir, "embedded_file_no_names")
        with pytest.raises(ValueError, match="nothing here for that fix"):
            apply_accessibility_fixes(src, src, ["embedded_file_names"])
        assert _statuses(src)["embedded_file_names"] == "fail"

    def test_title_display_flag(self, tmp_dir):
        src = _build(tmp_dir, "title_not_displayed")
        _round_trip(src, "title", lambda p: apply_accessibility_fixes(p, p, ["title"]))

    def test_title_refuses_to_invent_a_missing_one(self, tmp_dir):
        src = _build(tmp_dir, "no_title")
        with pytest.raises(ValueError, match="nothing here for that fix"):
            apply_accessibility_fixes(src, src, ["title"])
        assert _statuses(src)["title"] == "fail"

    def test_bookmarks(self, tmp_dir):
        src = _build(tmp_dir, "no_bookmarks_long_with_headings")
        _round_trip(src, "bookmarks", lambda p: apply_accessibility_fixes(p, p, ["bookmarks"]))

    def test_bookmarks_refuses_with_no_headings_to_derive_from(self, tmp_dir):
        src = _build(tmp_dir, "no_bookmarks_long")
        assert _check(src, "bookmarks")["data"]["headings"] == 0
        with pytest.raises(RuntimeError, match="[Hh]eadings"):
            apply_accessibility_fixes(src, src, ["bookmarks"])

    def test_tab_order(self, tmp_dir):
        src = _build(tmp_dir, "no_tabs")
        _round_trip(src, "tab_order", lambda p: apply_accessibility_fixes(p, p, ["tab_order"]))
        import pikepdf

        with pikepdf.open(src) as pdf:
            assert str(pdf.pages[0].obj[Name.Tabs]) == "/S"

    def test_heading_nesting(self, tmp_dir):
        src = _build(tmp_dir, "heading_skip")
        _round_trip(
            src, "heading_nesting", lambda p: apply_accessibility_fixes(p, p, ["heading_nesting"])
        )
        levels = [n["type"] for n in get_struct_tree(src)["root"][0]["children"]]
        assert "H3" not in levels

    def test_table_headers(self, tmp_dir):
        src = _build(tmp_dir, "table_no_headers")
        _round_trip(
            src, "table_headers", lambda p: apply_accessibility_fixes(p, p, ["table_headers"])
        )

    def test_nested_alt(self, tmp_dir):
        src = _build(tmp_dir, "nested_alt")
        _round_trip(src, "nested_alt", lambda p: apply_accessibility_fixes(p, p, ["nested_alt"]))
        # The figure is still described — by the ancestor whose /Alt swallowed
        # it — so clearing the inner one must not turn into an alt-text
        # failure. That was a live false positive this round closed.
        assert _statuses(src)["figures_alt"] in _BENIGN

    def test_alt_hides_annotation(self, tmp_dir):
        src = _build(tmp_dir, "alt_hides_annot")
        _round_trip(
            src,
            "alt_hides_annotation",
            lambda p: apply_accessibility_fixes(p, p, ["alt_hides_annotation"]),
        )

    def test_a_whole_document_sweep_repairs_everything_it_can(self, tmp_dir):
        src = _build(tmp_dir, "no_tabs")
        res = apply_accessibility_fixes(src, src)
        assert [a["check"] for a in res["applied"]] == ["tab_order"]
        # A check the document passes is skipped, never refused.
        assert {s["check"] for s in res["skipped"]} >= {"tagged", "heading_nesting"}
        assert res["refused"] == []


class TestAuthoredFixes:
    def test_document_language(self, tmp_dir):
        src = _build(tmp_dir, "no_lang")
        _round_trip(src, "lang", lambda p: set_document_language(p, p, "en-GB"))
        assert _check(src, "lang")["data"]["lang"] == "en-GB"

    def test_document_title(self, tmp_dir):
        src = _build(tmp_dir, "no_title")
        _round_trip(src, "title", lambda p: set_document_title(p, p, "Quarterly report", True))
        data = _check(src, "title")["data"]
        assert data["title"] == "Quarterly report"
        assert data["display_doc_title"] is True

    def test_field_description(self, tmp_dir):
        src = _build(tmp_dir, "field_no_tu")
        name = _check(src, "field_descriptions")["findings"][0]["address"]["field"]
        _round_trip(
            src,
            "field_descriptions",
            lambda p: set_field_description(p, p, name, "Your full legal name"),
        )
        fields = {f["name"]: f for f in read_form_fields(src)["fields"]}
        assert fields[name]["description"] == "Your full legal name"

    def test_figure_alt(self, tmp_dir):
        src = _build(tmp_dir, "figure_no_alt")
        path = _check(src, "figures_alt")["findings"][0]["address"]["path"]
        _round_trip(
            src,
            "figures_alt",
            lambda p: set_struct_props(p, p, path, {"alt": "A bar chart of revenue"}),
        )

    def test_table_summary(self, tmp_dir):
        src = _build(tmp_dir, "table_no_summary")
        path = _check(src, "table_summary")["findings"][0]["address"]["path"]
        _round_trip(
            src,
            "table_summary",
            lambda p: set_struct_props(p, p, path, {"summary": "Revenue by region"}),
        )


class TestTheNewDoorsRefuse:
    def test_a_malformed_language_tag_names_what_is_wrong(self, tmp_dir):
        src = _build(tmp_dir, "no_lang")
        with pytest.raises(ValueError, match="empty subtag"):
            set_document_language(src, src, "en--GB")
        with pytest.raises(ValueError, match="letters and digits"):
            set_document_language(src, src, "en-$")
        with pytest.raises(ValueError, match="two to eight letters"):
            set_document_language(src, src, "e")
        with pytest.raises(ValueError, match="longer than eight"):
            set_document_language(src, src, "abcdefghij")
        with pytest.raises(ValueError, match="Name the language"):
            validate_language_tag("   ")
        # Nothing was written by any of them.
        assert _statuses(src)["lang"] == "fail"

    def test_an_empty_language_clears_the_declaration(self, tmp_dir):
        """"This document declares no language" is a VALUE, not a refusal —
        the door is total over the property it owns."""
        src = _build(tmp_dir, "baseline")
        assert _statuses(src)["lang"] == "pass"
        set_document_language(src, src, "")
        assert _statuses(src)["lang"] == "fail"

    @pytest.mark.parametrize(
        "tag", ["en", "en-GB", "zh-Hant-TW", "de-CH-1901", "haw", "x-private",
                "en-US-u-va-posix", "zh-cmn-Hans-CN", "es-419"]
    )
    def test_a_well_formed_tag_is_accepted(self, tag):
        assert validate_language_tag(tag) == tag

    def test_tab_order_refuses_a_document_with_nothing_to_order(self, tmp_dir):
        src = _build(tmp_dir, "baseline")
        with pytest.raises(ValueError, match="no tab order to declare"):
            set_page_tab_order(src, src)

    def test_tab_order_refuses_an_order_it_does_not_know(self, tmp_dir):
        src = _build(tmp_dir, "no_tabs")
        with pytest.raises(ValueError, match="tab order must be"):
            set_page_tab_order(src, src, order="Z")

    def test_field_description_names_a_field_the_document_lacks(self, tmp_dir):
        src = _build(tmp_dir, "field_no_tu")
        with pytest.raises(ValueError, match="no form field named"):
            set_field_description(src, src, "nope", "x")

    def test_field_description_needs_a_field(self, tmp_dir):
        src = _build(tmp_dir, "field_no_tu")
        with pytest.raises(ValueError, match="Name the form field"):
            set_field_description(src, src, "", "x")

    def test_scope_outside_the_vocabulary_names_the_accepted_values(self, tmp_dir):
        src = _build(tmp_dir, "table_headers_ok")
        header = next(
            f for f in check_accessibility(src)["checks"] if f["id"] == "table_headers"
        )
        del header
        with pytest.raises(ValueError, match="Row, Column or Both"):
            set_struct_props(src, src, [0, 1], {"scope": "Sideways"})

    def test_summary_on_something_that_is_not_a_table_refuses(self, tmp_dir):
        src = _build(tmp_dir, "table_no_summary")
        # [0, 0] is the paragraph, not the table.
        with pytest.raises(ValueError, match="/Summary belongs on a Table"):
            set_struct_props(src, src, [0, 0], {"summary": "no"})

    def test_scope_on_something_that_is_not_a_header_cell_refuses(self, tmp_dir):
        src = _build(tmp_dir, "table_no_summary")
        with pytest.raises(ValueError, match="/Scope belongs on a TH"):
            set_struct_props(src, src, [0, 0], {"scope": "Column"})

    def test_set_table_headers_refuses_a_path_that_is_not_a_table(self, tmp_dir):
        src = _build(tmp_dir, "table_no_headers")
        with pytest.raises(ValueError, match="not a table"):
            set_table_headers(src, src, [0, 0])

    def test_set_table_headers_refuses_the_tree_root(self, tmp_dir):
        src = _build(tmp_dir, "table_no_headers")
        with pytest.raises(ValueError, match="must name a table"):
            set_table_headers(src, src, [])


class TestTheAttributesLandWhereAReaderLooks:
    """`/Summary` and `/Scope` go into the element's `/Table` attribute
    dictionary — the spec's own place, and the one the audit reads LAST. A
    direct element key would be overridden by any attribute dictionary the
    producer already left behind, so the fix would not clear the check."""

    def test_summary_lands_in_an_attribute_dictionary(self, tmp_dir):
        import pikepdf

        src = _build(tmp_dir, "table_no_summary")
        path = _check(src, "table_summary")["findings"][0]["address"]["path"]
        set_struct_props(src, src, path, {"summary": "Revenue by region"})
        with pikepdf.open(src) as pdf:
            from engine.struct_tree import _walk_path

            elem = _walk_path(pdf, path)[-1]
            assert "/Summary" not in elem
            attrs = elem["/A"]
            attrs = attrs if isinstance(attrs, pikepdf.Dictionary) else attrs[0]
            assert str(attrs["/O"]) == "/Table"
            assert str(attrs["/Summary"]) == "Revenue by region"

    def test_an_existing_attribute_dictionary_is_extended_not_replaced(self, tmp_dir):
        import pikepdf

        src = _build(tmp_dir, "table_colspan_regular_ok")
        # Give the table an /A dictionary carrying something else first.
        with pikepdf.open(src) as pdf:
            from engine.struct_tree import _walk_path

            elem = _walk_path(pdf, [0, 1])[-1]
            elem[Name.A] = pdf.make_indirect(
                pikepdf.Dictionary(O=Name.Table, Summary=pikepdf.String("old"))
            )
            pdf.save(src + ".2.pdf")
        src = src + ".2.pdf"
        set_struct_props(src, src, [0, 1], {"summary": "new"})
        with pikepdf.open(src) as pdf:
            from engine.struct_tree import _walk_path

            elem = _walk_path(pdf, [0, 1])[-1]
            assert str(elem["/A"]["/Summary"]) == "new"

    def test_clearing_an_attribute_removes_it(self, tmp_dir):
        import pikepdf

        src = _build(tmp_dir, "table_no_summary")
        path = _check(src, "table_summary")["findings"][0]["address"]["path"]
        set_struct_props(src, src, path, {"summary": "Revenue"})
        assert _statuses(src)["table_summary"] == "pass"
        set_struct_props(src, src, path, {"summary": ""})
        assert _statuses(src)["table_summary"] == "warn"
        with pikepdf.open(src) as pdf:
            from engine.struct_tree import _walk_path

            elem = _walk_path(pdf, path)[-1]
            assert "/Summary" not in elem

    def test_promoting_a_header_row_writes_the_scope_where_the_audit_reads_it(self, tmp_dir):
        src = _build(tmp_dir, "table_no_headers")
        path = _check(src, "table_headers")["findings"][0]["address"]["path"]
        res = set_table_headers(src, src, path)
        assert res["scope"] == "Column"
        assert len(res["promoted"]) >= 1
        assert _statuses(src)["table_headers"] == "pass"


class TestNothingIsInventedForTheUser:
    def test_a_field_description_is_never_written_from_the_field_name(self, tmp_dir):
        src = _build(tmp_dir, "field_no_tu")
        apply_accessibility_fixes(src, src)
        # The whole-document sweep touches everything it can, and a field
        # description is not among them: a description that repeats the
        # internal name is the same failure wearing a different key.
        assert _statuses(src)["field_descriptions"] == "fail"

    def test_a_figure_never_gains_invented_alt_text(self, tmp_dir):
        src = _build(tmp_dir, "figure_no_alt")
        apply_accessibility_fixes(src, src)
        assert _statuses(src)["figures_alt"] == "fail"

    def test_a_language_is_never_guessed(self, tmp_dir):
        src = _build(tmp_dir, "no_lang")
        apply_accessibility_fixes(src, src)
        assert _statuses(src)["lang"] == "fail"
