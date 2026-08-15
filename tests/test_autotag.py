"""Autotag: heuristic structure for untagged PDFs — roles by font
size, figures from image XObjects, full marked-content + ParentTree wiring,
loud refusals, and the no-damage pin (extraction identical before/after)."""

import pikepdf
import pytest

from engine.autotag import autotag
from engine.extract_text import extract_text
from engine.struct_tree import get_struct_tree


def _content_doc(path) -> None:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 400))
    content = (
        b"BT /F1 24 Tf 40 350 Td (AutotagHeading) Tj ET\n"
        b"BT /F1 11 Tf 40 320 Td (Autotag body one) Tj ET\n"
        b"BT /F1 11 Tf 40 300 Td (Autotag body two) Tj ET\n"
        b"q 100 0 0 50 40 200 cm /Im0 Do Q\n"
    )
    page.Contents = pdf.make_stream(content)
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name.Helvetica,
        )
    )
    image = pdf.make_stream(
        b"\x00",
        Type=pikepdf.Name.XObject,
        Subtype=pikepdf.Name.Image,
        Width=1,
        Height=1,
        BitsPerComponent=8,
        ColorSpace=pikepdf.Name.DeviceGray,
    )
    page.Resources = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=font),
        XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image)),
    )
    pdf.save(path)


@pytest.fixture
def content_pdf(tmp_path):
    path = tmp_path / "content.pdf"
    _content_doc(path)
    return str(path)


class TestAutotag:
    def test_builds_roles_in_stream_order_with_full_wiring(self, content_pdf, tmp_path):
        out = tmp_path / "tagged.pdf"
        report = autotag(file=content_pdf, output=str(out))
        assert report == {
            "pages": 1,
            "tagged": 4,
            "headings": 1,
            "paragraphs": 2,
            "figures": 1,
            "artifacts": 0,
        }
        with pikepdf.open(out) as pdf:
            root = pdf.Root.StructTreeRoot
            doc_elem = root.K
            roles = [str(k.S) for k in doc_elem.K]
            assert roles == ["/H1", "/P", "/P", "/Figure"]
            assert bool(pdf.Root.MarkInfo.Marked) is True
            page = pdf.pages[0]
            assert int(page.obj.StructParents) == 0
            nums = root.ParentTree.Nums
            assert int(nums[0]) == 0
            assert len(nums[1]) == 4
            assert int(root.ParentTreeNextKey) == 1
            # The stream really carries the marked-content wrapping.
            ops = [str(op) for _operands, op in pikepdf.parse_content_stream(page)]
            assert ops.count("BDC") == 4
            assert ops.count("EMC") == 4

    def test_extraction_is_unchanged_by_tagging(self, content_pdf, tmp_path):
        before = extract_text(file=content_pdf)["text"]
        out = tmp_path / "tagged.pdf"
        autotag(file=content_pdf, output=str(out))
        after = extract_text(file=str(out))["text"]
        assert "AutotagHeading" in after
        assert after == before

    def test_panel_read_sees_the_tree(self, content_pdf, tmp_path):
        out = tmp_path / "tagged.pdf"
        autotag(file=content_pdf, output=str(out))
        tree = get_struct_tree(file=str(out))
        assert tree["tagged"] is True
        assert tree["count"] >= 5  # Document + the four leaves

    def test_already_tagged_refused(self, content_pdf, tmp_path):
        out = tmp_path / "tagged.pdf"
        autotag(file=content_pdf, output=str(out))
        with pytest.raises(ValueError, match="already tagged"):
            autotag(file=str(out), output=str(tmp_path / "again.pdf"))

    def test_in_place(self, content_pdf):
        autotag(file=content_pdf, output=content_pdf)
        with pikepdf.open(content_pdf) as pdf:
            assert pikepdf.Name.StructTreeRoot in pdf.Root

    def test_nothing_taggable_refused(self, tmp_path):
        path = tmp_path / "blank.pdf"
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(200, 200))
        pdf.save(path)
        with pytest.raises(ValueError, match="Nothing taggable"):
            autotag(file=str(path), output=str(tmp_path / "out.pdf"))


def _distinct_sizes_doc(path) -> None:
    """A page whose blocks all have a DISTINCT size, so no size has a majority
    by block count: a 24 pt title, eleven-point body copy, and an 8 pt folio
    in the bottom margin."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    content = (
        b"BT /F1 24 Tf 40 740 Td (Chapter One) Tj ET\n"
        b"BT /F1 11 Tf 40 640 Td "
        b"(Body copy that carries most of the characters on this page.) Tj ET\n"
        b"BT /F1 8 Tf 300 24 Td (1) Tj ET\n"
    )
    page.Contents = pdf.make_stream(content)
    page.Resources = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(
            F1=pdf.make_indirect(
                pikepdf.Dictionary(
                    Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
                    BaseFont=pikepdf.Name.Helvetica,
                )
            )
        )
    )
    pdf.save(path)


class TestBodySizeVote:
    """The body size is the size most of the document's TEXT is set in.

    A block-count vote makes every block equal, so a page of one title, one
    paragraph and one folio ties three ways — and a tie broken toward the
    smallest size elects the folio, which promotes the body copy to a heading.
    """

    def test_body_copy_stays_a_paragraph_when_every_size_is_distinct(self, tmp_path):
        src = tmp_path / "distinct.pdf"
        _distinct_sizes_doc(src)
        out = tmp_path / "tagged.pdf"
        autotag(file=str(src), output=str(out))
        with pikepdf.open(out) as pdf:
            roles = [str(k.S) for k in pdf.Root.StructTreeRoot.K.K]
        assert roles == ["/H1", "/P"]

    def test_a_folio_in_the_margin_becomes_an_artifact(self, tmp_path):
        src = tmp_path / "distinct.pdf"
        _distinct_sizes_doc(src)
        out = tmp_path / "tagged.pdf"
        report = autotag(file=str(src), output=str(out))
        assert report["artifacts"] == 1
        with pikepdf.open(out) as pdf:
            page = pdf.pages[0]
            ops = [
                (list(operands), str(op))
                for operands, op in pikepdf.parse_content_stream(page)
            ]
        assert any(op == "BMC" and operands and str(operands[0]) == "/Artifact"
                   for operands, op in ops)

    def test_a_title_in_the_top_margin_is_not_an_artifact(self, tmp_path):
        """Both conditions are required. A title sits in the top margin too,
        and it is BIGGER than the body copy, not smaller."""
        src = tmp_path / "toptitle.pdf"
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(
            b"BT /F1 24 Tf 40 770 Td (A Title At The Very Top) Tj ET\n"
            b"BT /F1 11 Tf 40 600 Td "
            b"(Body copy that carries most of the characters here.) Tj ET\n"
        )
        page.Resources = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(
                F1=pdf.make_indirect(
                    pikepdf.Dictionary(
                        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
                        BaseFont=pikepdf.Name.Helvetica,
                    )
                )
            )
        )
        pdf.save(src)
        out = tmp_path / "tagged.pdf"
        report = autotag(file=str(src), output=str(out))
        assert report["artifacts"] == 0
        with pikepdf.open(out) as pdf:
            roles = [str(k.S) for k in pdf.Root.StructTreeRoot.K.K]
        assert roles == ["/H1", "/P"]
