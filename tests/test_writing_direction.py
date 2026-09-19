"""Text geometry along the writing direction, held to the standard.

ISO 32000-2 §9.4.4 moves the pen after each glyph by
tx = ((w0 - Tj/1000) × Tfs + Tc + Tw) × Th in horizontal writing and by
ty = (w1 - Tj/1000) × Tfs + Tc + Tw in vertical writing, where w1 is
negative. Along a column, which runs DOWN, a positive TJ number therefore
moves the next glyph down (Table 107) and a positive Tc or Tw moves it up
(§9.3.2, §9.3.3); rise lifts the baseline in either mode (§9.3.7). Tc and Tw
space the glyphs and draw nothing, so a glyph's ink is its own advance from
its own origin.

Every position below is computed from those clauses by hand. pdfminer, an
independent reading of the same clauses, confirms where the source file draws
each glyph, so a test cannot pass on a model that is wrong in the same way on
both sides of a comparison.
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
from test_redact_text_state import _drawn, _shows, _simple_font

FONTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts")
CJK_FACE = os.path.join(FONTS_DIR, "NotoSansCJKsc-Regular.otf")
_needs_cjk = pytest.mark.skipif(not os.path.isfile(CJK_FACE), reason="bundled CJK face not provisioned")


def _column_font(pdf, to_unicode: bool = True):
    """Identity-V, CIDs 1..3 each 1 em down the column (/DW2 [880 -1000])."""
    descendant = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.CIDFontType2, BaseFont=Name("/Column"),
        CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
        DW2=Array([880, -1000]), W=Array([1, 3, 1000]),
    ))
    font = Dictionary(
        Type=Name.Font, Subtype=Name.Type0, BaseFont=Name("/Column"),
        Encoding=Name("/Identity-V"), DescendantFonts=Array([descendant]),
    )
    if to_unicode:
        font["/ToUnicode"] = _tounicode_stream(pdf, {1: "一", 2: "二", 3: "三"})
    return pdf.make_indirect(font)


def _write(tmp_dir: str, name: str, content: bytes, font_of=_column_font, size=(612, 792)) -> str:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=size)
    page.Resources = Dictionary(Font=Dictionary(F1=font_of(pdf)))
    page.Contents = pdf.make_stream(content)
    path = os.path.join(tmp_dir, name)
    pdf.save(path)
    pdf.close()
    return path


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


def _inside(box, rect) -> bool:
    return box[0] <= rect[0] and box[1] <= rect[1] and rect[2] <= box[2] and rect[3] <= box[3]


class TestAVerticalRedactionKeepsTheColumn:
    """Size 12, 1 em per glyph, pen at (300, 700): 一 draws from 700 down to
    688, 二 from 688 to 676 and 三 from 676 to 664 (pdfminer's box sits
    0.12 em higher: the /DW2 position vector puts the glyph origin 880/1000
    em above the pen's baseline point)."""

    def test_the_glyphs_after_a_removed_one_stay_where_they_were(self, tmp_dir):
        from engine.redact import redact

        src = _write(tmp_dir, "column.pdf", b"BT /F1 12 Tf 300 700 Td <000100020003> Tj ET")
        out = os.path.join(tmp_dir, "out.pdf")
        before = _glyphs(src)
        redact(file=src, output=out, regions=[{"page": 1, "rect": [294, 676.5, 306, 687.5]}])
        after = _glyphs(out)
        assert set(after) == {"一", "三"}
        assert after["一"] == pytest.approx(before["一"], abs=0.01)
        assert after["三"] == pytest.approx(before["三"], abs=0.01)

    def test_a_glyph_a_positive_number_moved_down_is_removed(self, tmp_dir):
        from engine.redact import redact

        # [<0001> 1000 <0002>]: after 一 the pen is at 688 and +1000 moves it
        # on to 676, so 二 draws from 676 down to 664.
        src = _write(tmp_dir, "down.pdf", b"BT /F1 12 Tf 300 700 Td [<0001> 1000 <0002>] TJ ET")
        mark = [294, 666, 306, 674]
        assert _inside(_glyphs(src)["二"], mark)
        out = os.path.join(tmp_dir, "out.pdf")
        redact(file=src, output=out, regions=[{"page": 1, "rect": mark}])
        assert _drawn(_shows(out)) == b"\x00\x01"

    def test_an_unmeasured_column_reaches_past_a_forward_number(self, tmp_dir):
        from engine.redact import redact

        # The odd last byte leaves the run unmeasurable, so its box is the
        # generous estimate: 1 em per code, and every forward jump. +3000
        # moves the pen from 688 on to 652, and 二 draws from 652 down to 640.
        src = _write(tmp_dir, "jump.pdf", b"BT /F1 12 Tf 300 700 Td [<0001> 3000 <000200>] TJ ET")
        mark = [294, 642, 306, 650]
        assert _inside(_glyphs(src)["二"], mark)
        out = os.path.join(tmp_dir, "out.pdf")
        result = redact(file=src, output=out, regions=[{"page": 1, "rect": mark}])
        assert result["runs_removed_whole"] == 1
        assert _drawn(_shows(out)) == b""

    def test_a_raised_column_is_found_where_it_draws(self, tmp_dir):
        from engine.redact import redact

        # 6 Ts lifts 一 to draw from 706 down to 694; the mark covers only
        # the part above the unraised pen.
        src = _write(tmp_dir, "raised.pdf", b"BT /F1 12 Tf 300 700 Td 6 Ts <0001> Tj ET")
        mark = [294, 701, 306, 705]
        assert _inside(_glyphs(src)["一"], mark)
        out = os.path.join(tmp_dir, "out.pdf")
        redact(file=src, output=out, regions=[{"page": 1, "rect": mark}])
        assert _drawn(_shows(out)) == b""


class TestAVerticalEditKeepsTheColumn:
    def test_a_follower_moves_by_the_advance_the_edit_adds(self, tmp_dir):
        from engine.text_runs import list_text_runs, replace_text_run

        # 2 Tc at size 12: each glyph moves the pen 12 - 2 = 10 down. The edit
        # adds one glyph, so the same-column follower moves 10 down with it:
        # from the line start 700 - 40 to 650.
        src = _write(tmp_dir, "edit.pdf", b"BT /F1 12 Tf 2 Tc 300 700 Td <0001> Tj 0 -40 Td <0003> Tj ET")
        before = list_text_runs(src, 1)["runs"]
        assert before[1]["rect"][3] == pytest.approx(660.0, abs=0.01)
        out = os.path.join(tmp_dir, "out.pdf")
        replace_text_run(src, out, 1, 0, "一二")
        after = list_text_runs(out, 1)["runs"]
        assert [r["text"] for r in after] == ["一二", "三"]
        assert after[1]["rect"][3] == pytest.approx(650.0, abs=0.01)
        assert _glyphs(out)["三"][3] == pytest.approx(_glyphs(src)["三"][3] - 10.0, abs=0.01)


class TestSpacingDrawsNothing:
    """0.6 em per glyph at 12 pt: each glyph is 7.2 wide, pen at x 60."""

    def test_a_mark_over_the_tail_of_a_tightly_tracked_glyph_removes_it(self, tmp_dir):
        from engine.redact import redact

        # -3 Tc: A draws 60..67.2, B 64.2..71.4, C 68.4..75.6, and the pen
        # ends at 72.6, inside C. The mark covers C's last 2.5.
        src = _write(tmp_dir, "tight.pdf", b"BT /F1 12 Tf 60 300 Td -3 Tc (ABC) Tj ET",
                     font_of=lambda pdf: _simple_font(pdf, 600, "Wide"))
        mark = [73, 290, 75.5, 320]
        assert _glyphs(src)["C"][2] > mark[2]
        out = os.path.join(tmp_dir, "out.pdf")
        redact(file=src, output=out, regions=[{"page": 1, "rect": mark}])
        assert _drawn(_shows(out)) == b"AB"

    def test_a_mark_goes_with_its_base_under_character_spacing(self, tmp_dir):
        from engine.redact import redact

        def with_a_mark(pdf):
            widths = [600] * 95
            widths[ord("m") - 32] = 0
            return pdf.make_indirect(Dictionary(
                Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/Marked"),
                FirstChar=32, LastChar=126, Widths=Array(widths),
                Encoding=Name.WinAnsiEncoding,
            ))

        # `m` has no advance of its own: it is a mark on `b`. Tc still moves
        # the pen after it, as after every glyph.
        src = _write(tmp_dir, "mark.pdf", b"BT /F1 12 Tf 60 300 Td 1 Tc (bmX) Tj ET", font_of=with_a_mark)
        out = os.path.join(tmp_dir, "out.pdf")
        redact(file=src, output=out, regions=[{"page": 1, "rect": [61, 290, 66, 320]}])
        assert _drawn(_shows(out)) == b"X"


class TestSanitizeKeepsTheColumn:
    def test_removing_hidden_vertical_text_leaves_the_next_glyph_in_place(self, tmp_dir):
        from engine.sanitize import sanitize_pdf

        src = _write(tmp_dir, "hidden.pdf", b"BT /F1 12 Tf 300 700 Td 3 Tr <0001> Tj 0 Tr <0002> Tj ET")
        out = os.path.join(tmp_dir, "out.pdf")
        sanitize_pdf(src, out, categories=["hidden_text"])
        assert _drawn(_shows(out)) == b"\x00\x02"
        assert _glyphs(out)["二"] == pytest.approx(_glyphs(src)["二"], abs=0.01)


class TestVerticalParagraphs:
    def test_character_spacing_moves_the_pen_up_the_column(self, tmp_dir):
        from test_text_paragraphs import _apply, _paras, _vpage

        from engine.text_runs import list_text_runs

        # 2 Tc at size 10: each glyph moves the pen 10 - 2 = 8 down. The
        # original column is 16 of pen path; the swapped text fills the same
        # column, and its second glyph draws 10 down from 692 to 682.
        src = _vpage(tmp_dir, b"BT /FV 10 Tf 2 Tc 150 700 Td <00030004> Tj ET")
        para = _paras(src)[0]
        assert para["text"] == "あい"
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, para, "いあ")
        after = list_text_runs(out, 1)["runs"]
        assert [r["text"] for r in after] == ["いあ"]
        assert after[0]["rect"] == pytest.approx([145, 682, 155, 700], abs=0.05)

    def test_character_spacing_rewraps_to_the_same_columns(self, tmp_dir):
        from test_text_paragraphs import _apply, _paras, _vpage

        from engine.text_runs import list_text_runs

        # Two columns 15 apart at 2 Tc: each glyph moves the pen 8 down, so the
        # first column's pen path is 24 and the paragraph's column length holds
        # its three glyphs. Written back unchanged, the text keeps the split.
        src = _vpage(tmp_dir, b"BT /FV 10 Tf 2 Tc 150 700 Td <000300040005> Tj -15 0 Td <00030004> Tj ET")
        para = _paras(src)[0]
        assert para["text"] == "あいうあい"
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, para, para["text"])
        after = list_text_runs(out, 1)["runs"]
        assert [r["text"] for r in after] == ["あいう", "あい"]
        assert after[0]["rect"] == pytest.approx([145, 674, 155, 700], abs=0.05)
        assert after[1]["rect"] == pytest.approx([130, 682, 140, 700], abs=0.05)

    def test_a_refused_column_lists_as_a_vertical_paragraph(self, tmp_dir):
        from engine.text_paragraphs import list_text_paragraphs

        src = _write(tmp_dir, "refused.pdf", b"BT /F1 12 Tf 300 700 Td <000100020003> Tj ET",
                     font_of=lambda pdf: _column_font(pdf, to_unicode=False))
        [para] = list_text_paragraphs(src, 1)["paragraphs"]
        assert para["vertical"] is True
        assert para["editable"] is False

    @_needs_cjk
    def test_an_edit_draws_no_horizontal_pair_kerning_down_a_column(self, tmp_dir):
        from engine.text_authoring import add_text_box
        from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

        # The bundled CJK face kerns い-よ by -20/1000 for HORIZONTAL text. A
        # vertical box is authored with no kerning, and an edit that falls
        # back to the same face draws none either.
        blank = os.path.join(tmp_dir, "blank.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(400, 600))
        pdf.save(blank)
        pdf.close()
        src = os.path.join(tmp_dir, "authored.pdf")
        add_text_box(blank, src, 1, [100, 100, 200, 500], "あてあて", size=20,
                     font_path=FONTS_DIR, writing_mode="vertical")
        para = list_text_paragraphs(src, 1)["paragraphs"][0]
        out = os.path.join(tmp_dir, "edited.pdf")
        new = "いよいよ"
        replace_paragraph_text(src, out, 1, para["index"], new,
                               [{"start": 0, "end": len(new), "run": para["runs"][0]}],
                               para["runs"], para["text"], font_path=FONTS_DIR, convert=True)
        numbers = [part for show in _shows(out) for part in show if not isinstance(part, bytes)]
        assert numbers == []


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
class TestVerticalTextConvertsToOutlinesInPlace:
    """A vertical watermark in the bundled CJK face, filled and then
    stroked, converted to outlines. The glyph's vertical origin is placed in
    ems before the font size scales it (§9.7.4.3); the outlines must land on
    the ink the text drew."""

    @pytest.mark.parametrize("stroked", [False, True], ids=["filled", "stroked"])
    def test_the_outlines_cover_the_text_they_replace(self, tmp_dir, gs_path, stroked):
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
        if stroked:
            with pikepdf.open(src, allow_overwriting_input=True) as pdf:
                for obj in pdf.objects:
                    if isinstance(obj, pikepdf.Stream) and obj.get("/Subtype") == Name.Form:
                        data = obj.read_bytes()
                        if b"BT" in data:
                            obj.write(data.replace(b"BT", b"2 w 1 Tr BT", 1))
                pdf.save(src)
        out = os.path.join(tmp_dir, "outlined.pdf")
        with pikepdf.open(src) as pdf:
            report = outline_page(pdf, pdf.pages[0], 1, FONTS_DIR, True, True)
            pdf.save(out)
        assert report["glyphs"] == 4
        text, paths = _ink(gs_path, src), _ink(gs_path, out)
        overlap = (text & paths).sum() / max((text | paths).sum(), 1)
        assert overlap > 0.75
