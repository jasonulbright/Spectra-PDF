"""A vertical advance keeps its sign.

ISO 32000-2 §9.7.4.3: /W2 and /DW2 give each glyph the vertical component
w1y of its displacement vector and a position vector v. A negative w1y puts
the next glyph below the current one; a positive w1y puts it ABOVE. The
position vector places the glyph from the pen whichever way the pen then
moves, so with v = (500, 880) a glyph's em box hangs from the pen down one
em, and in a column that climbs each glyph sits above the one before.

The font below is Identity-V, CIDs 3..5 (あ, い, う), each 1 em UP the column
(w1y = +1000, v = (500, 880)). At 10 pt with the pen at (150, 300): あ draws
from 290 up to 300, い from 300 to 310, う from 310 to 320, each 10 wide,
centred on x 150. Every position is computed from those clauses by hand.
pdfminer reads the same /W2 and confirms where each glyph's pen lands, which
is what a before-and-after comparison of one glyph needs.
"""

from __future__ import annotations

import os
import subprocess

import numpy as np
import pikepdf
import pytest
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTChar
from pikepdf import Array, Dictionary, Name

from test_pdf_fonts import _tounicode_stream

FONTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts")
CJK_FACE = os.path.join(FONTS_DIR, "NotoSansCJKsc-Regular.otf")
_needs_cjk = pytest.mark.skipif(not os.path.isfile(CJK_FACE), reason="bundled CJK face not provisioned")


def _climbing_font(pdf, w1y: int = 1000):
    desc = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.CIDFontType2, BaseFont=Name("/Climb"),
        CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
        W2=Array([3, Array([w1y, 500, 880, w1y, 500, 880, w1y, 500, 880])]),
    ))
    return pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type0, BaseFont=Name("/Climb"),
        Encoding=Name("/Identity-V"), DescendantFonts=Array([desc]),
        ToUnicode=_tounicode_stream(pdf, {3: "あ", 4: "い", 5: "う"}),
    ))


def _write(tmp_dir: str, name: str, content: bytes, w1y: int = 1000) -> str:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page.Resources = Dictionary(Font=Dictionary(FV=_climbing_font(pdf, w1y)))
    page.Contents = pdf.make_stream(content)
    path = os.path.join(tmp_dir, name)
    pdf.save(path)
    pdf.close()
    return path


_COLUMN = b"BT /FV 10 Tf 150 300 Td <000300040005> Tj ET"


def _glyphs(path: str) -> dict:
    """{character: (x0, y0, x1, y1)} of each glyph pdfminer finds on page 1."""
    found: dict = {}

    def visit(obj) -> None:
        if isinstance(obj, LTChar):
            found[obj.get_text()] = (obj.x0, obj.y0, obj.x1, obj.y1)
            return
        for child in getattr(obj, "_objs", None) or []:
            visit(child)

    for layout in extract_pages(path):
        visit(layout)
    return found


class TestTheFontsAdvance:
    @pytest.mark.parametrize("w1y, advance", [(1000, -1000.0), (-1000, 1000.0), (600, -600.0)])
    def test_the_advance_down_the_column_is_minus_w1y(self, tmp_dir, w1y, advance):
        from engine.pdf_fonts import font_capability

        with pikepdf.open(_write(tmp_dir, "font.pdf", _COLUMN, w1y)) as pdf:
            cap = font_capability(pdf.pages[0].Resources.Font.FV)
            assert cap.decoded_width(b"\x00\x04") == advance

    def test_the_default_advance_keeps_its_sign(self, tmp_dir):
        from engine.pdf_fonts import font_capability

        pdf = pikepdf.new()
        pdf.add_blank_page()
        desc = pdf.make_indirect(Dictionary(
            Type=Name.Font, Subtype=Name.CIDFontType2, BaseFont=Name("/Climb"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
            DW2=Array([880, 1000]),
        ))
        font = Dictionary(Type=Name.Font, Subtype=Name.Type0, BaseFont=Name("/Climb"),
                          Encoding=Name("/Identity-V"), DescendantFonts=Array([desc]),
                          ToUnicode=_tounicode_stream(pdf, {3: "あ"}))
        assert font_capability(font).decoded_width(b"\x00\x03") == -1000.0


class TestMeasurement:
    def test_the_run_box_spans_the_pen_path_and_every_glyph(self, tmp_dir):
        from engine.text_runs import list_text_runs

        [run] = list_text_runs(_write(tmp_dir, "c.pdf", _COLUMN), 1)["runs"]
        # The pen climbs from 300 to 330; the glyphs cover 290..320.
        assert run["rect"] == pytest.approx([145, 290, 155, 330], abs=0.01)

    def test_a_search_hit_sits_on_the_glyph_it_found(self, tmp_dir):
        from engine.search_regions import search_text_regions

        src = _write(tmp_dir, "c.pdf", _COLUMN)
        for char, rect in (("い", [145, 300, 155, 310]), ("う", [145, 310, 155, 320])):
            [hit] = search_text_regions(src, char)["hits"]
            assert hit["rects"][0]["rect"] == pytest.approx(rect, abs=0.01), char

    def test_read_aloud_highlights_each_character_where_it_draws(self, tmp_dir):
        from engine.read_aloud import read_aloud_page

        [block] = read_aloud_page(_write(tmp_dir, "c.pdf", _COLUMN), 1)["blocks"]
        assert block["text"] == "あいう"
        [span] = block["spans"]
        expected = [[145, 290, 155, 300], [145, 300, 155, 310], [145, 310, 155, 320]]
        assert len(span["chars"]) == len(expected)
        for got, want in zip(span["chars"], expected):
            assert got == pytest.approx(want, abs=0.01)


class TestRedaction:
    def test_a_mark_over_a_climbing_glyph_removes_it_and_leaves_the_rest(self, tmp_dir):
        from engine.redact import redact

        src = _write(tmp_dir, "c.pdf", _COLUMN)
        out = os.path.join(tmp_dir, "out.pdf")
        before = _glyphs(src)
        redact(file=src, output=out, regions=[{"page": 1, "rect": [144, 301, 156, 309]}])
        after = _glyphs(out)
        assert set(after) == {"あ", "う"}
        assert after["あ"] == pytest.approx(before["あ"], abs=0.01)
        assert after["う"] == pytest.approx(before["う"], abs=0.01)

    def test_removing_hidden_text_leaves_the_next_glyph_where_it_climbed_to(self, tmp_dir):
        from engine.sanitize import sanitize_pdf

        src = _write(tmp_dir, "hidden.pdf", b"BT /FV 10 Tf 150 300 Td 3 Tr <0003> Tj 0 Tr <0004> Tj ET")
        out = os.path.join(tmp_dir, "out.pdf")
        sanitize_pdf(src, out, categories=["hidden_text"])
        after = _glyphs(out)
        assert set(after) == {"い"}
        assert after["い"] == pytest.approx(_glyphs(src)["い"], abs=0.01)


class TestEdits:
    def test_a_run_edit_measures_the_column_it_writes(self, tmp_dir):
        from engine.text_runs import list_text_runs, replace_text_run

        src = _write(tmp_dir, "c.pdf", _COLUMN)
        out = os.path.join(tmp_dir, "out.pdf")
        replace_text_run(src, out, 1, 0, "あいうあ")
        [run] = list_text_runs(out, 1)["runs"]
        assert run["text"] == "あいうあ"
        assert run["rect"] == pytest.approx([145, 290, 155, 340], abs=0.01)

    def test_a_climbing_column_stays_on_the_run_surface(self, tmp_dir):
        from engine.text_paragraphs import list_text_paragraphs

        # Every paragraph frame reads down the page, so none reads a column
        # that climbs: an edit that rewrapped it would lay it out downward.
        src = _write(tmp_dir, "two.pdf",
                     b"BT /FV 10 Tf 150 300 Td <000300040005> Tj -14 0 Td <00030004> Tj ET")
        assert list_text_paragraphs(src, 1)["paragraphs"] == []

    def test_a_descending_column_still_forms_a_paragraph(self, tmp_dir):
        from engine.text_paragraphs import list_text_paragraphs

        src = _write(tmp_dir, "down.pdf", _COLUMN, w1y=-1000)
        [para] = list_text_paragraphs(src, 1)["paragraphs"]
        assert (para["text"], para["vertical"], para["editable"]) == ("あいう", True, True)


def _ink(gs_path: str, path: str) -> np.ndarray:
    target = path + ".png"
    subprocess.run(
        [gs_path, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pnggray", "-r72",
         f"-sOutputFile={target}", path],
        check=True, stdin=subprocess.DEVNULL, capture_output=True,
    )
    from PIL import Image

    with Image.open(target) as image:
        return np.asarray(image.convert("L")) < 250


@_needs_cjk
class TestOutlines:
    """A vertical watermark in the bundled CJK face, its /W2 and /DW2 turned
    to climb, drawn as one show from y 100 at 60 pt. Ghostscript draws the
    column upward from there; the outlines must land on that ink."""

    def test_the_outlines_cover_the_climbing_text_they_replace(self, tmp_dir, gs_path):
        from engine.outlines import outline_page
        from engine.watermark import watermark

        blank = os.path.join(tmp_dir, "blank.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(400, 800))
        pdf.save(blank)
        pdf.close()
        src = os.path.join(tmp_dir, "marked.pdf")
        watermark(file=blank, output=src, text="機密文書", font_dir=FONTS_DIR, angle=0,
                  opacity=1.0, writing_mode="vertical")
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            for obj in pdf.objects:
                if isinstance(obj, pikepdf.Dictionary) and obj.get("/W2") is not None:
                    climbed = []
                    for entry in obj.W2:
                        if isinstance(entry, pikepdf.Array):
                            values = [float(v) for v in entry]
                            for i in range(0, len(values), 3):
                                values[i] = -values[i]
                            climbed.append(Array(values))
                        else:
                            climbed.append(entry)
                    obj.W2 = Array(climbed)
                    obj.DW2 = Array([880, 1000])
                if isinstance(obj, pikepdf.Stream) and obj.get("/Subtype") == Name.Form:
                    data = obj.read_bytes()
                    obj.write(data.replace(b"/F0 130 Tf 1 0 0 1 0 260 Tm",
                                           b"/F0 60 Tf 1 0 0 1 0 -300 Tm"))
            pdf.save(src)
        out = os.path.join(tmp_dir, "outlined.pdf")
        with pikepdf.open(src) as pdf:
            report = outline_page(pdf, pdf.pages[0], 1, FONTS_DIR, True, True)
            pdf.save(out)
        assert report["glyphs"] == 4
        text, paths = _ink(gs_path, src), _ink(gs_path, out)
        text_rows = np.where(text.any(axis=1))[0]
        path_rows = np.where(paths.any(axis=1))[0]
        # The pen starts at y 100 (row 700) and climbs: the column's top lies
        # more than an em (60) above it. A descending column would run off
        # the page below.
        assert text_rows.min() < 800 - 100 - 60
        assert abs(int(path_rows.min()) - int(text_rows.min())) <= 2
        assert abs(int(path_rows.max()) - int(text_rows.max())) <= 2
        overlap = (text & paths).sum() / max((text | paths).sum(), 1)
        assert overlap > 0.7


class TestReadAloudSpeaksTheRunSurface:
    def test_text_set_at_an_angle_is_a_block_of_its_own(self, tmp_dir):
        from engine.read_aloud import read_aloud_page

        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Resources = Dictionary(Font=Dictionary(F1=Dictionary(
            Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)))
        page.Contents = pdf.make_stream(
            b"BT /F1 12 Tf 100 500 Td (Level words) Tj ET "
            b"BT /F1 12 Tf 0.7071 0.7071 -0.7071 0.7071 100 100 Tm (Words at an angle) Tj ET")
        src = os.path.join(tmp_dir, "angle.pdf")
        pdf.save(src)
        pdf.close()
        blocks = read_aloud_page(src, 1)["blocks"]
        assert [b["text"] for b in blocks] == ["Level words", "Words at an angle"]
        assert blocks[1]["spans"][0]["exact"] is True

    def test_text_drawn_at_no_size_is_not_read(self, tmp_dir):
        from engine.read_aloud import read_aloud_page

        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Resources = Dictionary(Font=Dictionary(F1=Dictionary(
            Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)))
        page.Contents = pdf.make_stream(
            b"BT /F1 12 Tf 100 500 Td (Level words) Tj ET "
            b"BT /F1 1 Tf 0 0 0 0 396 474 Tm (Unseen words) Tj ET "
            b"BT /F1 12 Tf 0.7071 0.7071 -0.7071 0.7071 100 100 Tm (Words at an angle) Tj ET")
        src = os.path.join(tmp_dir, "unseen.pdf")
        pdf.save(src)
        pdf.close()
        assert [b["text"] for b in read_aloud_page(src, 1)["blocks"]] == ["Level words", "Words at an angle"]

    def test_a_climbing_column_is_read_in_the_structure_order(self, tmp_dir):
        from engine.read_aloud import read_aloud_page

        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Resources = Dictionary(Font=Dictionary(
            F1=Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica),
            FV=_climbing_font(pdf)))
        page.Contents = pdf.make_stream(
            b"/P << /MCID 0 >> BDC BT /F1 12 Tf 100 500 Td (Level words) Tj ET EMC "
            b"/P << /MCID 1 >> BDC BT /FV 10 Tf 150 300 Td <000300040005> Tj ET EMC")
        page.obj.StructParents = 0
        root = pdf.make_indirect(Dictionary(Type=Name.StructTreeRoot))
        document = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.Document, P=root))
        column = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.P, P=document, Pg=page.obj, K=1))
        level = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.P, P=document, Pg=page.obj, K=0))
        document.K = Array([column, level])
        root.K = document
        root.ParentTree = Dictionary(Nums=Array([0, Array([level, column])]))
        pdf.Root.StructTreeRoot = root
        pdf.Root.MarkInfo = Dictionary(Marked=True)
        src = os.path.join(tmp_dir, "tagged.pdf")
        pdf.save(src)
        pdf.close()
        result = read_aloud_page(src, 1)
        assert result["order"] == "structure"
        assert [b["text"] for b in result["blocks"]] == ["あいう", "Level words"]
