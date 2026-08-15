"""Binding existing content and annotations into the structure tree.

The one door in the accessibility round that rewrites a content stream, so the
things pinned here are the four rules § 4.3 names — MCIDs allocated above the
page's maximum, an artifact that creates no element, a form-XObject run refused
by name, and the annotation half written in BOTH directions — plus the property
that makes them worth having: the check the finding came from stops failing,
and the document still validates.
"""

import json
import os

import pikepdf
import pytest
from pikepdf import Name

import a11y_builders as B
from engine.accessibility import check_accessibility
from engine.accessibility_fixes import apply_accessibility_fixes
from engine.check import check as validate
from engine.struct_tree import get_struct_tree
from engine.tag_content import tag_page_content
from engine.text_runs import list_text_runs

_BENIGN = ("pass", "not_applicable")


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


def _build(tmp_dir, name):
    return B.ROSTER[name][0](os.path.join(tmp_dir, f"{name}.pdf"))


def _statuses(path) -> dict:
    return {c["id"]: c["status"] for c in check_accessibility(path)["checks"]}


def _untagged_runs(path, page=1) -> list:
    return [
        r["index"]
        for r in list_text_runs(path, page)["runs"]
        if r["mcid"] is None and not r["artifact"] and str(r["text"]).strip()
    ]


def _parent_tree(pdf) -> dict:
    nums = pdf.Root["/StructTreeRoot"]["/ParentTree"]["/Nums"]
    return {int(nums[i]): nums[i + 1] for i in range(0, len(nums) - 1, 2)}


class TestBindingText:
    def test_an_untagged_run_becomes_a_paragraph(self, tmp_dir):
        src = _build(tmp_dir, "untagged_content")
        before = _statuses(src)
        assert before["tagged_content"] == "fail"
        runs = _untagged_runs(src)
        assert len(runs) == 1
        res = tag_page_content(src, src, 1, [{"run": runs[0]}], "P")
        assert res["tagged"] == [{"run": runs[0], "mcid": 1, "role": "P"}]
        after = _statuses(src)
        assert after["tagged_content"] == "pass"
        for key, was in before.items():
            if key == "tagged_content":
                continue
            assert after[key] in _BENIGN or after[key] == was, (key, was, after[key])
        assert validate(src)["summary"]["errors"] == 0

    def test_the_new_element_is_in_the_tree_and_names_its_content(self, tmp_dir):
        src = _build(tmp_dir, "untagged_content")
        run = _untagged_runs(src)[0]
        tag_page_content(src, src, 1, [{"run": run}], "P")
        tree = get_struct_tree(src)
        kids = tree["root"][0]["children"]
        assert [k["type"] for k in kids] == ["P", "P"]
        assert kids[1]["content"] == [{"page": 1, "mcid": 1}]

    def test_the_mcid_is_allocated_above_the_page_maximum(self, tmp_dir):
        """Re-using an MCID silently retargets an existing tag."""
        src = _build(tmp_dir, "untagged_content")
        run = _untagged_runs(src)[0]
        res = tag_page_content(src, src, 1, [{"run": run}], "P")
        assert res["tagged"][0]["mcid"] == 1
        # The paragraph that was already tagged still owns MCID 0.
        runs = list_text_runs(src, 1)["runs"]
        assert sorted(r["mcid"] for r in runs) == [0, 1]

    def test_the_parent_tree_indexes_the_element_by_its_mcid(self, tmp_dir):
        src = _build(tmp_dir, "untagged_content")
        run = _untagged_runs(src)[0]
        tag_page_content(src, src, 1, [{"run": run}], "P")
        with pikepdf.open(src) as pdf:
            key = int(pdf.pages[0].obj["/StructParents"])
            entries = _parent_tree(pdf)[key]
            assert len(entries) == 2
            assert str(entries[1]["/S"]) == "/P"

    def test_an_artifact_creates_no_element_and_takes_no_mcid(self, tmp_dir):
        src = _build(tmp_dir, "untagged_content")
        run = _untagged_runs(src)[0]
        before = len(get_struct_tree(src)["root"][0]["children"])
        res = tag_page_content(src, src, 1, [{"run": run}], "Artifact")
        assert res["tagged"] == [{"run": run, "mcid": None, "role": "Artifact"}]
        assert len(get_struct_tree(src)["root"][0]["children"]) == before
        # `text_runs` reads the declaration back: this content is NOT content.
        runs = {r["index"]: r for r in list_text_runs(src, 1)["runs"]}
        assert runs[run]["artifact"] is True
        assert runs[run]["mcid"] is None
        assert _statuses(src)["tagged_content"] == "pass"

    def test_a_new_element_lands_in_stream_order(self, tmp_dir):
        """A paragraph bound here reads where it is DRAWN. The fixture draws
        the untagged run after the tagged one, so the new element is second."""
        src = _build(tmp_dir, "untagged_content")
        run = _untagged_runs(src)[0]
        tag_page_content(src, src, 1, [{"run": run}], "P")
        kids = get_struct_tree(src)["root"][0]["children"]
        assert kids[0]["content"] == [{"page": 1, "mcid": 0}]
        assert kids[1]["content"] == [{"page": 1, "mcid": 1}]


class TestBindingAnnotations:
    def test_an_untagged_annotation_gains_an_objr_and_a_structparent(self, tmp_dir):
        """Both directions. One without the other is a tree that reads
        correctly and reverse-maps wrongly."""
        src = _build(tmp_dir, "untagged_annotation")
        assert _statuses(src)["tagged_annotations"] == "fail"
        tag_page_content(src, src, 1, [{"annot": 0}], "Annot")
        assert _statuses(src)["tagged_annotations"] == "pass"
        with pikepdf.open(src) as pdf:
            annot = pdf.pages[0].obj["/Annots"][0]
            key = int(annot["/StructParent"])
            element = _parent_tree(pdf)[key]
            assert str(element["/S"]) == "/Annot"
            objr = element["/K"]
            assert str(objr["/Type"]) == "/OBJR"
            assert objr["/Obj"].objgen == annot.objgen
        assert validate(src)["summary"]["errors"] == 0

    def test_a_widget_is_bound_as_a_form_element(self, tmp_dir):
        src = _build(tmp_dir, "untagged_field")
        assert _statuses(src)["tagged_form_fields"] == "fail"
        apply_accessibility_fixes(src, src, ["tagged_form_fields"])
        assert _statuses(src)["tagged_form_fields"] == "pass"
        with pikepdf.open(src) as pdf:
            annot = pdf.pages[0].obj["/Annots"][0]
            element = _parent_tree(pdf)[int(annot["/StructParent"])]
            assert str(element["/S"]) == "/Form"

    def test_multimedia_is_bound_too(self, tmp_dir):
        src = _build(tmp_dir, "untagged_multimedia")
        before = _statuses(src)
        apply_accessibility_fixes(src, src, ["tagged_multimedia"])
        after = _statuses(src)
        assert after["tagged_multimedia"] == "pass"
        # An Annot element with no description of its own, over an annotation
        # with no /Contents, is check 24's finding — correctly, and only
        # visible once the annotation is IN the tree. Pinned by name rather
        # than tolerated: the fixture's media annotation carries no
        # description, and PDF/UA requires one.
        assert before["other_elements_alt"] == "not_applicable"
        assert after["other_elements_alt"] == "fail"

    def test_an_annotation_already_in_the_tree_refuses(self, tmp_dir):
        src = _build(tmp_dir, "untagged_annotation")
        tag_page_content(src, src, 1, [{"annot": 0}], "Annot")
        with pytest.raises(ValueError, match="already in the structure tree"):
            tag_page_content(src, src, 1, [{"annot": 0}], "Annot")

    def test_an_annotation_cannot_be_declared_an_artifact(self, tmp_dir):
        src = _build(tmp_dir, "untagged_annotation")
        with pytest.raises(ValueError, match="cannot be declared an artifact"):
            tag_page_content(src, src, 1, [{"annot": 0}], "Artifact")


class TestRefusals:
    def test_a_run_already_inside_a_tag_refuses(self, tmp_dir):
        src = _build(tmp_dir, "untagged_content")
        with pytest.raises(ValueError, match="already inside a tag"):
            tag_page_content(src, src, 1, [{"run": 0}], "P")

    def test_a_run_index_out_of_range_names_the_count(self, tmp_dir):
        src = _build(tmp_dir, "untagged_content")
        with pytest.raises(ValueError, match="it has 2 runs"):
            tag_page_content(src, src, 1, [{"run": 99}], "P")

    def test_a_run_inside_a_form_xobject_is_refused_by_name(self, tmp_dir):
        """MCIDs are scoped to their content stream, so a page-scoped tag
        cannot address one. The refusal NAMES the form."""
        src = os.path.join(tmp_dir, "in_form.pdf")
        pdf = B.new_pdf()
        page = pdf.pages[0]
        form = pdf.make_stream(b"BT /F1 11 Tf 40 600 Td (Inside a form.) Tj ET")
        form[Name.Type] = Name.XObject
        form[Name.Subtype] = Name.Form
        form[Name.BBox] = pikepdf.Array([0, 0, 612, 792])
        form[Name.Resources] = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=B._font(pdf)))
        B.draw(pdf, page, "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Page text.) Tj ET EMC\n/Fx Do")
        page.obj[Name.Resources][Name.XObject] = pikepdf.Dictionary(Fx=pdf.make_indirect(form))
        root = B.struct_root(pdf)
        doc = B.elem(pdf, "Document", root)
        para = B.elem(pdf, "P", doc, page=page, mcid=0)
        doc[Name.K] = pikepdf.Array([para])
        root[Name.K] = doc
        B.parent_tree(pdf, root, page, [para])
        B.make_conformant(pdf, page)
        B.save(pdf, src)

        runs = list_text_runs(src, 1)["runs"]
        nested = [r["index"] for r in runs if r["nested"]]
        assert nested, json.dumps(runs, indent=2, default=str)
        with pytest.raises(ValueError, match="form XObject /Fx"):
            tag_page_content(src, src, 1, [{"run": nested[0]}], "P")

    def test_an_untagged_document_refuses(self, tmp_dir):
        src = _build(tmp_dir, "untagged")
        with pytest.raises(ValueError, match="untagged"):
            tag_page_content(src, src, 1, [{"run": 0}], "P")

    def test_a_role_outside_the_standard_set_refuses(self, tmp_dir):
        src = _build(tmp_dir, "untagged_content")
        run = _untagged_runs(src)[0]
        with pytest.raises(ValueError, match="not a structure type"):
            tag_page_content(src, src, 1, [{"run": run}], "Whatever")

    def test_no_targets_refuses(self, tmp_dir):
        src = _build(tmp_dir, "untagged_content")
        with pytest.raises(ValueError, match="at least one run"):
            tag_page_content(src, src, 1, [], "P")

    def test_a_target_naming_neither_refuses(self, tmp_dir):
        src = _build(tmp_dir, "untagged_content")
        with pytest.raises(ValueError, match="names a"):
            tag_page_content(src, src, 1, [{"nonsense": 0}], "P")

    def test_a_page_out_of_range_refuses(self, tmp_dir):
        src = _build(tmp_dir, "untagged_content")
        with pytest.raises(ValueError, match="out of range"):
            tag_page_content(src, src, 9, [{"run": 0}], "P")
