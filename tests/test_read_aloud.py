"""Read Out Loud's page listing: order, artifacts, and character geometry."""

import os

import pikepdf
import pytest

from engine.read_aloud import read_aloud_page

from derived_nav_builders import (
    attach,
    blank_pdf,
    draw_marked,
    elem,
    simple_headed_doc,
    struct_root,
    untagged_text_doc,
    wire_parent_tree,
)


def _font(pdf):
    return pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name.Helvetica,
        )
    )


def _write(pdf, page, body: str):
    page.obj[pikepdf.Name.Contents] = pdf.make_stream(body.encode("ascii"))
    page.obj[pikepdf.Name.Resources] = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=_font(pdf))
    )


@pytest.fixture
def tagged(tmp_dir):
    path = os.path.join(tmp_dir, "tagged.pdf")
    simple_headed_doc(path)
    return path


@pytest.fixture
def plain(tmp_dir):
    path = os.path.join(tmp_dir, "plain.pdf")
    untagged_text_doc(path)
    return path


class TestOrder:
    def test_tagged_page_reads_in_structure_order(self, tagged):
        result = read_aloud_page(tagged, 1)
        assert result["order"] == "structure"
        assert result["reason"] is None
        assert [b["text"] for b in result["blocks"]] == ["Alpha", "Beta", "Gamma"]
        assert [b["role"] for b in result["blocks"]] == ["H1", "H2", "H3"]

    def test_structure_order_wins_over_position_on_the_page(self, tmp_dir):
        # The tree declares Second before First while the page draws First
        # higher. Structure order is the author's, and it is what is read.
        path = os.path.join(tmp_dir, "reordered.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        draw_marked(pdf, page, [(0, "Upper", 500, 12), (1, "Lower", 400, 12)])
        root = struct_root(pdf)
        lower = elem(pdf, "P", root, page=page, mcid=1)
        upper = elem(pdf, "P", root, page=page, mcid=0)
        attach(root, [lower, upper])
        wire_parent_tree(pdf, root, [(page, [lower, upper])])
        pdf.save(path)
        result = read_aloud_page(path, 1)
        assert result["order"] == "structure"
        assert [b["text"] for b in result["blocks"]] == ["Lower", "Upper"]

    def test_untagged_page_reads_in_layout_order_and_says_so(self, plain):
        result = read_aloud_page(plain, 1)
        assert result["order"] == "layout"
        assert result["reason"] == "not tagged"
        assert [b["text"] for b in result["blocks"]] == [
            "Chapter One",
            "Body text on the page.",
        ]

    def test_partly_tagged_page_falls_back_whole(self, tmp_dir):
        # Half a page in one order and half in the other would be an order that
        # is neither, with nothing to tell the listener which sentences moved.
        path = os.path.join(tmp_dir, "partial.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        body = "\n".join(
            [
                "/P <</MCID 0>> BDC BT /F1 12 Tf 50 500 Td (Tagged line) Tj ET EMC",
                "BT /F1 12 Tf 50 460 Td (Untagged line) Tj ET",
            ]
        )
        _write(pdf, page, body)
        root = struct_root(pdf)
        kid = elem(pdf, "P", root, page=page, mcid=0)
        attach(root, [kid])
        wire_parent_tree(pdf, root, [(page, [kid])])
        pdf.save(path)
        result = read_aloud_page(path, 1)
        assert result["order"] == "layout"
        assert result["reason"] == "page content outside the structure tree"
        assert len(result["blocks"]) == 2


class TestArtifacts:
    def test_artifact_content_is_never_read(self, tmp_dir):
        path = os.path.join(tmp_dir, "artifact.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        body = "\n".join(
            [
                "/Artifact BMC BT /F1 9 Tf 50 560 Td (Running header) Tj ET EMC",
                "BT /F1 12 Tf 50 500 Td (Real body text.) Tj ET",
                "/Artifact <</Type /Pagination>> BDC "
                "BT /F1 9 Tf 50 40 Td (Page 1) Tj ET EMC",
            ]
        )
        _write(pdf, page, body)
        pdf.save(path)
        result = read_aloud_page(path, 1)
        assert result["artifacts"] == 2
        assert [b["text"] for b in result["blocks"]] == ["Real body text."]

    def test_nested_artifact_still_counts(self, tmp_dir):
        path = os.path.join(tmp_dir, "nested-artifact.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        body = (
            "/Artifact BMC /Span BMC BT /F1 9 Tf 50 560 Td (Deep furniture) Tj ET "
            "EMC EMC\nBT /F1 12 Tf 50 500 Td (Body.) Tj ET"
        )
        _write(pdf, page, body)
        pdf.save(path)
        result = read_aloud_page(path, 1)
        assert result["artifacts"] == 1
        assert [b["text"] for b in result["blocks"]] == ["Body."]

    def test_an_artifact_does_not_join_the_paragraph_below_it(self, tmp_dir):
        # A running header sitting one line above the body would cluster INTO
        # the first paragraph if it reached the grouper, and there would be no
        # span left to exclude.
        path = os.path.join(tmp_dir, "close-artifact.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        body = "\n".join(
            [
                "/Artifact BMC BT /F1 12 Tf 50 514 Td (Chapter heading furniture) "
                "Tj ET EMC",
                "BT /F1 12 Tf 50 500 Td (First body line.) Tj ET",
            ]
        )
        _write(pdf, page, body)
        pdf.save(path)
        result = read_aloud_page(path, 1)
        assert all("furniture" not in b["text"] for b in result["blocks"])


class TestGeometry:
    def test_every_character_gets_its_own_rectangle(self, plain):
        block = read_aloud_page(plain, 1)["blocks"][0]
        span = block["spans"][0]
        assert span["exact"] is True
        assert len(span["chars"]) == span["e"] - span["s"] == len("Chapter One")
        # Left to right, each starting where the last ended.
        xs = [rect[0] for rect in span["chars"]]
        assert xs == sorted(xs)
        for earlier, later in zip(span["chars"], span["chars"][1:]):
            assert later[0] == pytest.approx(earlier[2], abs=0.01)

    def test_the_span_rect_is_the_union_of_its_characters(self, plain):
        span = read_aloud_page(plain, 1)["blocks"][0]["spans"][0]
        assert span["rect"][0] == pytest.approx(span["chars"][0][0])
        assert span["rect"][2] == pytest.approx(span["chars"][-1][2])

    def test_a_wrapped_paragraph_reports_one_span_per_run(self, tmp_dir):
        path = os.path.join(tmp_dir, "wrapped.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        body = "\n".join(
            [
                "BT /F1 12 Tf 50 500 Td (The first line of the paragraph) Tj ET",
                "BT /F1 12 Tf 50 486 Td (and the second line of it.) Tj ET",
            ]
        )
        _write(pdf, page, body)
        pdf.save(path)
        blocks = read_aloud_page(path, 1)["blocks"]
        assert len(blocks) == 1
        runs = {span["run"] for span in blocks[0]["spans"]}
        assert len(runs) == 2
        # The join is a space the lister emitted, not a character any run drew;
        # the span it rides still lines up with its own codes.
        assert " " in blocks[0]["text"]
        assert all(span["exact"] for span in blocks[0]["spans"])

    def test_spans_tile_the_block_text_without_gaps(self, tmp_dir):
        path = os.path.join(tmp_dir, "tiled.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        body = "\n".join(
            [
                "BT /F1 12 Tf 50 500 Td (One line here) Tj ET",
                "BT /F1 12 Tf 50 486 Td (and another one) Tj ET",
            ]
        )
        _write(pdf, page, body)
        pdf.save(path)
        block = read_aloud_page(path, 1)["blocks"][0]
        at = 0
        for span in block["spans"]:
            assert span["s"] == at
            at = span["e"]
        assert at == len(block["text"])


class TestRefusals:
    def test_page_out_of_range_refuses_by_name(self, plain):
        with pytest.raises(ValueError, match="out of range"):
            read_aloud_page(plain, 7)
        with pytest.raises(ValueError, match="out of range"):
            read_aloud_page(plain, 0)

    def test_a_page_with_no_text_reports_it_rather_than_failing(self, tmp_dir):
        path = os.path.join(tmp_dir, "blank.pdf")
        pdf = blank_pdf(1)
        pdf.save(path)
        result = read_aloud_page(path, 1)
        assert result["blocks"] == []
        assert result["reason"] == "no readable text"

    def test_a_page_of_only_artifacts_has_nothing_to_read(self, tmp_dir):
        path = os.path.join(tmp_dir, "all-furniture.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        _write(
            pdf,
            page,
            "/Artifact BMC BT /F1 9 Tf 50 40 Td (Page 1) Tj ET EMC",
        )
        pdf.save(path)
        result = read_aloud_page(path, 1)
        assert result["blocks"] == []
        assert result["artifacts"] == 1


class TestRunListing:
    def test_the_artifact_flag_rides_the_shared_walk(self, tmp_dir):
        # `artifact` is additive on the run listing every text consumer reads;
        # this pins that it is reported there, not only inside read_aloud.
        from engine.text_runs import list_text_runs

        path = os.path.join(tmp_dir, "flagged.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        body = "\n".join(
            [
                "/Artifact BMC BT /F1 9 Tf 50 560 Td (Furniture) Tj ET EMC",
                "BT /F1 12 Tf 50 500 Td (Body) Tj ET",
            ]
        )
        _write(pdf, page, body)
        pdf.save(path)
        runs = list_text_runs(path, 1)["runs"]
        assert [r["artifact"] for r in runs] == [True, False]
