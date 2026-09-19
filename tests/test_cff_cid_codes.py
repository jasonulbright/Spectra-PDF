"""A CID-keyed CFF font draws each code through its own charset.

ISO 32000-2 §9.7.4.2: when a CIDFontType0's CFF program has a Top DICT that
uses CIDFont operators, a reader maps each CID to a glyph through the charset
table in the CFF program; only a program without those operators takes the
CID as the glyph index. The bundled CJK face is such a program. A subset of it
renumbers the glyphs and keeps each glyph's CID, so a show that writes the new
glyph index as its code (Identity-H: code = CID) names a CID the charset does
not hold, and a conforming reader draws `.notdef` boxes where the text was.

The fixtures build their programs with fontTools, independent of the engine's
own embedding code, so a reader under test cannot agree with a writer that is
wrong in the same way.
"""

from __future__ import annotations

import io
import os
import subprocess

import numpy as np
import pikepdf
import pytest
from fontTools import subset as ft_subset
from fontTools.ttLib import TTFont
from pikepdf import Array, Dictionary, Name

FONTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts")
CJK_FACE = os.path.join(FONTS_DIR, "NotoSansCJKsc-Regular.otf")
TEXT = "機密文書"

pytestmark = pytest.mark.skipif(not os.path.isfile(CJK_FACE), reason="bundled CJK face not provisioned")


def _charset(program: bytes) -> list:
    return list(TTFont(io.BytesIO(program))["CFF "].cff.topDictIndex[0].charset)


def _full_names() -> dict:
    """{character: glyph name} in the whole face, where a CID-keyed program
    names each glyph by its CID."""
    face = TTFont(CJK_FACE, lazy=True)
    try:
        cmap = face.getBestCmap()
        return {ch: cmap[ord(ch)] for ch in TEXT}
    finally:
        face.close()


def _conforming_pdf(path: str, to_unicode: bool) -> None:
    """The text in a subset of the face, embedded the way §9.7.4.2 reads it:
    each code is the CID its glyph carries in the subset's charset."""
    options = ft_subset.Options()
    options.notdef_outline = True
    subsetter = ft_subset.Subsetter(options=options)
    subsetter.populate(text=TEXT)
    face = TTFont(CJK_FACE, recalcTimestamp=False)
    subsetter.subset(face)
    buf = io.BytesIO()
    face.save(buf)
    program = buf.getvalue()
    names = _full_names()
    cids = {ch: int(names[ch][3:]) for ch in TEXT}
    assert all(names[ch] in _charset(program) for ch in TEXT)
    assert _charset(program).index(names[TEXT[0]]) != cids[TEXT[0]]

    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 200))
    stream = pdf.make_stream(program)
    stream["/Subtype"] = Name("/OpenType")
    descriptor = pdf.make_indirect(Dictionary(
        Type=Name.FontDescriptor, FontName=Name("/ABCDEF+NotoSansCJKsc"), Flags=4,
        FontBBox=Array([-1000, -300, 2000, 1200]), ItalicAngle=0, Ascent=880, Descent=-120,
        CapHeight=733, StemV=80, FontFile3=stream,
    ))
    w = Array()
    for ch in TEXT:
        w.extend([cids[ch], Array([1000])])
    descendant = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.CIDFontType0, BaseFont=Name("/ABCDEF+NotoSansCJKsc"),
        CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
        FontDescriptor=descriptor, DW=1000, W=w,
    ))
    font = Dictionary(
        Type=Name.Font, Subtype=Name.Type0, BaseFont=Name("/ABCDEF+NotoSansCJKsc"),
        Encoding=Name("/Identity-H"), DescendantFonts=Array([descendant]),
    )
    if to_unicode:
        from test_pdf_fonts import _tounicode_stream

        font["/ToUnicode"] = _tounicode_stream(pdf, {cids[ch]: ch for ch in TEXT})
    page.Resources = Dictionary(Font=Dictionary(F1=pdf.make_indirect(font)))
    shown = b"".join(cids[ch].to_bytes(2, "big") for ch in TEXT)
    page.Contents = pdf.make_stream(b"BT /F1 40 Tf 20 80 Td <" + shown.hex().encode() + b"> Tj ET")
    pdf.save(path)
    pdf.close()


class TestTheEmbedWritesCids:
    def test_each_code_names_the_cid_of_the_glyph_it_draws(self):
        from engine.font_fallback import build_fallback_font

        pdf = pikepdf.new()
        font, encode, _width = build_fallback_font(pdf, CJK_FACE, TEXT)
        program = font.DescendantFonts[0].FontDescriptor.FontFile3.read_bytes()
        charset = _charset(program)
        names = _full_names()
        for ch in TEXT:
            code = int.from_bytes(encode(ch), "big")
            assert f"cid{code:05d}" == names[ch]
            assert names[ch] in charset

    def test_widths_and_text_are_keyed_by_the_same_codes(self):
        from engine.font_fallback import build_fallback_font
        from engine.pdf_fonts import font_capability

        pdf = pikepdf.new()
        font, encode, width_1000 = build_fallback_font(pdf, CJK_FACE, TEXT)
        capability = font_capability(font)
        drawn = encode(TEXT)
        assert capability.decode(drawn) == TEXT
        assert capability.decoded_width(drawn) == pytest.approx(width_1000(TEXT), abs=0.01)


    def test_a_column_writes_cids_from_a_face_whose_charset_is_not_its_glyph_order(self, tmp_dir):
        from engine import shaping
        from engine.font_fallback import build_vertical_font

        # A face already cut to a few glyphs keeps each glyph's CID with a new
        # index: the vertical builder, which keeps the face's own indexes,
        # still has to write the CID.
        options = ft_subset.Options()
        options.notdef_outline = True
        options.layout_features = ["*"]
        subsetter = ft_subset.Subsetter(options=options)
        subsetter.populate(text=TEXT)
        face = TTFont(CJK_FACE, recalcTimestamp=False)
        subsetter.subset(face)
        cut = os.path.join(tmp_dir, "cut.otf")
        face.save(cut)
        pdf = pikepdf.new()
        _font, encode, _width = build_vertical_font(pdf, cut, TEXT)
        for ch in TEXT:
            name, _advance = shaping.shape_vertical(cut, ch)
            code = int.from_bytes(encode(ch), "big")
            assert f"cid{code:05d}" == name


class TestReadersFollowTheCharset:
    def test_outlines_are_the_glyphs_the_charset_names(self, tmp_dir):
        from engine.glyph_outlines import GlyphSource
        from engine.pdf_fonts import font_capability

        path = os.path.join(tmp_dir, "conforming.pdf")
        _conforming_pdf(path, to_unicode=True)
        names = _full_names()
        face = TTFont(CJK_FACE, lazy=True)
        try:
            glyphs = face.getGlyphSet()
            with pikepdf.open(path) as pdf:
                font = pdf.pages[0].Resources.Font.F1
                source = GlyphSource(font, font_capability(font))
                for ch in TEXT:
                    cid = int(names[ch][3:])
                    contours = source.contours(cid, cid.to_bytes(2, "big"))
                    assert contours, ch
                    from fontTools.pens.recordingPen import RecordingPen

                    pen = RecordingPen()
                    glyphs[names[ch]].draw(pen)
                    assert sum(1 for op, _ in pen.value if op == "closePath") == len(contours), ch
        finally:
            face.close()

    def test_a_font_without_tounicode_reads_through_the_charset(self, tmp_dir):
        from engine.pdf_fonts import font_capability

        path = os.path.join(tmp_dir, "conforming.pdf")
        _conforming_pdf(path, to_unicode=False)
        names = _full_names()
        with pikepdf.open(path) as pdf:
            capability = font_capability(pdf.pages[0].Resources.Font.F1)
            drawn = b"".join(int(names[ch][3:]).to_bytes(2, "big") for ch in TEXT)
            assert capability.decode(drawn) == TEXT


def _ink(gs_path: str, path: str) -> np.ndarray:
    from PIL import Image

    target = path + ".png"
    subprocess.run(
        [gs_path, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pnggray", "-r144",
         f"-sOutputFile={target}", path],
        check=True, stdin=subprocess.DEVNULL, capture_output=True,
    )
    with Image.open(target) as image:
        return np.asarray(image.convert("L")) < 250


class TestAConformingReaderDrawsTheText:
    def test_an_authored_box_renders_as_its_glyphs(self, tmp_dir, gs_path):
        from engine.outlines import outline_page
        from engine.text_authoring import add_text_box

        blank = os.path.join(tmp_dir, "blank.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(400, 200))
        pdf.save(blank)
        pdf.close()
        src = os.path.join(tmp_dir, "authored.pdf")
        add_text_box(blank, src, 1, [20, 40, 380, 160], TEXT, size=40, font_path=FONTS_DIR)
        # The conforming control: the same file with its text converted to
        # paths, drawn from the glyph each code names. A filled path takes
        # every pixel it touches and hinted text does not, so the two inks
        # differ at the stroke edges; a `.notdef` box differs everywhere.
        control = os.path.join(tmp_dir, "control.pdf")
        with pikepdf.open(src) as pdf:
            outline_page(pdf, pdf.pages[0], 1, FONTS_DIR, True, False)
            pdf.save(control)
        text, paths = _ink(gs_path, src), _ink(gs_path, control)
        assert text.sum() > 0
        assert (text & paths).sum() / max((text | paths).sum(), 1) > 0.7
