"""Comment overview + delete-all-comments."""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.annotations import delete_all_annotations, list_annotations


def _annot(pdf, subtype, rect, contents="", author="", extra=None):
    d = Dictionary(Type=Name.Annot, Subtype=Name(subtype), Rect=rect)
    if contents:
        d.Contents = String(contents)
    if author:
        d.T = String(author)
    if extra:
        for k, v in extra.items():
            d[k] = v
    return pdf.make_indirect(d)


def _pdf(path, annots_spec, pages=1):
    """annots_spec: list of (subtype, contents, author) put on page 0."""
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(300, 300))
    if annots_spec:
        arr = [_annot(pdf, s, [10, 10, 60, 60], c, a) for s, c, a in annots_spec]
        pdf.pages[0].obj["/Annots"] = Array(arr)
    pdf.save(path)
    pdf.close()


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


class TestListAnnotations:
    def test_lists_markup_with_type_and_content(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, [
            ("/Highlight", "important", "Ada"),
            ("/Text", "a note", "Grace"),
            ("/StrikeOut", "", ""),
        ])
        r = list_annotations(src)
        assert r["count"] == 3
        assert r["by_type"] == {"Highlight": 1, "Text": 1, "StrikeOut": 1}
        hi = next(a for a in r["annotations"] if a["subtype"] == "Highlight")
        assert hi["page"] == 1 and hi["contents"] == "important" and hi["author"] == "Ada"

    def test_ignores_widgets_and_links(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, [("/Link", "", ""), ("/Widget", "", ""), ("/Highlight", "keep-count", "")])
        r = list_annotations(src)
        assert r["count"] == 1 and r["by_type"] == {"Highlight": 1}

    def test_no_annotations(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, [])
        assert list_annotations(src) == {"annotations": [], "count": 0, "by_type": {}}


class TestDeleteAll:
    def test_removes_markup_keeps_links_and_widgets(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, [
            ("/Highlight", "", ""), ("/Text", "", ""), ("/StrikeOut", "", ""),
            ("/Link", "", ""), ("/Widget", "", ""),
        ])
        r = delete_all_annotations(src, out)
        assert r["removed"] == 3
        # Links + widgets survive.
        with pikepdf.open(out) as pdf:
            subs = {str(a.get("/Subtype")) for a in pdf.pages[0].obj.get("/Annots")}
            assert subs == {"/Link", "/Widget"}
        assert list_annotations(out)["count"] == 0

    def test_sweeps_popup(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, [("/Text", "note", ""), ("/Popup", "", "")])
        r = delete_all_annotations(src, out)
        assert r["removed"] == 2  # the note AND its popup
        with pikepdf.open(out) as pdf:
            assert "/Annots" not in pdf.pages[0].obj  # page had only comments → dropped

    def test_only_markup_page_drops_annots_key(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, [("/Highlight", "", "")])
        delete_all_annotations(src, out)
        with pikepdf.open(out) as pdf:
            assert "/Annots" not in pdf.pages[0].obj

    def test_in_place(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, [("/Highlight", "", "")])
        delete_all_annotations(src, src)
        assert list_annotations(src)["count"] == 0


class TestNarrowedSweep:
    """The two parameters the preflight fixup carries. Their DEFAULTS keep the
    shipped sweep byte-identical: an empty subtype list is every comment, and
    `printing_only` is off unless a caller asks for it."""

    def _with_print_flags(self, path, rows):
        """rows: [(subtype, prints)]. `/F` bit 3 is the print flag."""
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(300, 300))
        pdf.pages[0].obj["/Annots"] = Array([
            _annot(pdf, subtype, [10, 10, 60, 60], extra={"/F": 4 if prints else 0})
            for subtype, prints in rows
        ])
        pdf.save(path)
        pdf.close()

    def test_printing_only_keeps_the_note_that_never_reaches_a_plate(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        self._with_print_flags(src, [("/Text", True), ("/Square", False)])
        result = delete_all_annotations(src, out, printing_only=True)
        assert result["removed"] == 1
        with pikepdf.open(out) as pdf:
            subs = [str(a.get("/Subtype")) for a in pdf.pages[0].obj.get("/Annots")]
            assert subs == ["/Square"]

    def test_a_named_subtype_leaves_the_others_standing(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, [("/Text", "note", ""), ("/Square", "", ""), ("/Link", "", "")])
        result = delete_all_annotations(src, out, subtypes=["Text"])
        assert result["removed"] == 1
        with pikepdf.open(out) as pdf:
            subs = {str(a.get("/Subtype")) for a in pdf.pages[0].obj.get("/Annots")}
            assert subs == {"/Square", "/Link"}

    def test_a_popup_goes_with_the_parent_whatever_its_own_flags_say(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(300, 300))
        popup = _annot(pdf, "/Popup", [10, 10, 60, 60], extra={"/F": 0})
        note = _annot(pdf, "/Text", [10, 10, 60, 60],
                      extra={"/F": 4, "/Popup": popup})
        pdf.pages[0].obj["/Annots"] = Array([note, popup])
        pdf.save(src)
        pdf.close()
        result = delete_all_annotations(src, out, printing_only=True)
        # An orphan popup is a comment with nothing to open.
        assert result["removed"] == 2
        with pikepdf.open(out) as pdf:
            assert "/Annots" not in pdf.pages[0].obj

    def test_a_subtype_that_is_not_a_comment_refuses_by_name(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, [("/Text", "note", "")])
        with pytest.raises(ValueError, match="not a comment annotation subtype"):
            delete_all_annotations(src, os.path.join(tmp_dir, "o.pdf"),
                                   subtypes=["Widget"])
