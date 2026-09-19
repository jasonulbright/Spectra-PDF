"""A redacted character leaves the font that drew it.

Text removed from a content stream keeps its glyph programs, and every table
naming its codes, in the embedded font unless the font is cut: redact "QZXJ"
and an uncut font still draws Q, Z, X and J. These tests hold, on saved bytes
and for every embedded program type: what only the removed text drew is gone
from the program and from every table that names it; what any surviving text
draws — on another page, in a form, an annotation appearance, invisible text,
a field value — stays and draws exactly what it drew; and a font that cannot
be cut refuses the redaction by name without writing.

Fixtures are cut in-test from the bundled faces to the handful of glyphs each
property needs. "Draws what it drew" is checked glyph by glyph through each
program type's own lookup, and, where Ghostscript is configured, as pixels.
"""

from __future__ import annotations

import io
import os
import re
import subprocess
import zlib

import pikepdf
import pytest
from fontTools import subset
from fontTools.misc import eexec
from fontTools.pens.recordingPen import DecomposingRecordingPen, RecordingPen
from fontTools.ttLib import TTFont
from pdfminer.high_level import extract_text
from pikepdf import Array, Dictionary, Name, String

from engine import redact_fonts
from engine.redact import redact

FONTS = os.path.join(os.path.dirname(__file__), "..", "resources", "fonts")
SANS = os.path.join(FONTS, "LiberationSans-Regular.ttf")
SERIF_CFF = os.path.join(FONTS, "LibertinusSerif-Regular.otf")
CJK = os.path.join(FONTS, "NotoSansCJKsc-Regular.otf")

KEPT = "public"
SECRET = "QZXJ"
# The kept word sits at x=10, the secret at x=200; the mark covers only the
# secret.
MARK = [195, 40, 300, 70]
PAGE = (300, 100)


def _line(font_name: str, x: float, shown: bytes, size: int = 12) -> bytes:
    return b"BT /%s %d Tf %g 50 Td <%s> Tj ET\n" % (
        font_name.encode(), size, x, shown.hex().encode()
    )


def _save(doc, path: str) -> str:
    doc.save(path)
    doc.close()
    return path


def _redact(tmp_dir, doc, rect=None, name="in"):
    src = _save(doc, os.path.join(tmp_dir, f"{name}.pdf"))
    out = os.path.join(tmp_dir, f"{name}_out.pdf")
    redact(src, out, [{"page": 1, "rect": rect or MARK}])
    return src, out


def _font(path: str, page: int = 0, name: str = "/F1"):
    pdf = pikepdf.open(path)
    return pdf, pdf.pages[page].Resources.Font[name]


def _tounicode(doc, pairs) -> pikepdf.Stream:
    """A ToUnicode CMap from (code bytes, text) pairs."""
    width = len(pairs[0][0])
    lines = [
        b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
        b"/CMapName /Test-UCS def /CMapType 2 def",
        b"1 begincodespacerange <%s> <%s> endcodespacerange"
        % (b"00" * width, b"FF" * width),
        b"%d beginbfchar" % len(pairs),
    ]
    lines += [
        b"<%s> <%s>" % (code.hex().encode(), text.encode("utf-16-be").hex().encode())
        for code, text in pairs
    ]
    lines += [b"endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"]
    return doc.make_stream(b"\n".join(lines))


def _tounicode_map(font) -> dict:
    from pdfminer.cmapdb import CMapParser, FileUnicodeMap

    table = FileUnicodeMap()
    CMapParser(table, io.BytesIO(bytes(font.ToUnicode.read_bytes()))).run()
    return dict(table.cid2unichr)


def _cut(face: str, text: str = "", retain: bool = False, gids=None) -> bytes:
    """`face` cut to `text` (or glyph ids) — the program a writer embeds."""
    options = subset.Options()
    options.notdef_outline = True
    options.glyph_names = True
    options.retain_gids = retain
    options.drop_tables += ["FFTM"]
    font = TTFont(face, lazy=True, recalcTimestamp=False)
    cutter = subset.Subsetter(options)
    if gids is not None:
        cutter.populate(gids=gids)
    else:
        cutter.populate(text=text)
    cutter.subset(font)
    buffer = io.BytesIO()
    font.save(buffer)
    return buffer.getvalue()


def _outline(glyph_set, name):
    pen = DecomposingRecordingPen(glyph_set)
    glyph_set[name].draw(pen)
    return pen.value


def _win_ansi_glyph(tt, code: int):
    """The glyph a WinAnsi code draws through a (3, 1) cmap (§9.6.5.4)."""
    from pdfminer.encodingdb import EncodingDB

    char = EncodingDB.win2unicode.get(code)
    return tt.getBestCmap().get(ord(char)) if char else None


# ── simple TrueType ───────────────────────────────────────────────────────


def _truetype_font(doc, program: bytes, text: str, tounicode: bool = False, name=b"ABCDEF+LiberationSans"):
    tt = TTFont(io.BytesIO(program))
    scale = 1000.0 / tt["head"].unitsPerEm
    widths = []
    for code in range(32, 127):
        glyph = _win_ansi_glyph(tt, code)
        widths.append(round(tt["hmtx"][glyph][0] * scale) if glyph else 0)
    desc = Dictionary(
        Type=Name("/FontDescriptor"), FontName=Name("/" + name.decode()), Flags=32,
        FontBBox=Array([-200, -300, 1200, 1000]), ItalicAngle=0, Ascent=900,
        Descent=-200, CapHeight=700, StemV=80, FontFile2=doc.make_stream(program),
    )
    font = Dictionary(
        Type=Name("/Font"), Subtype=Name("/TrueType"), BaseFont=Name("/" + name.decode()),
        FirstChar=32, LastChar=126, Widths=Array(widths),
        Encoding=Name("/WinAnsiEncoding"), FontDescriptor=desc,
    )
    if tounicode:
        font["/ToUnicode"] = _tounicode(doc, [(bytes([ord(ch)]), ch) for ch in sorted(set(text))])
    return doc.make_indirect(font)


def _truetype_doc(pages, program=None, tounicode=False):
    """A document whose pages show `pages[i]` (a list of (x, text)) in one
    TrueType font embedded as a subset of every character they show."""
    text = "".join(t for page in pages for _x, t in page)
    program = program or _cut(SANS, text)
    doc = pikepdf.new()
    font = _truetype_font(doc, program, text, tounicode)
    for lines in pages:
        page = doc.add_blank_page(page_size=PAGE)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(
            b"".join(_line("F1", x, t.encode("latin-1")) for x, t in lines)
        )
    return doc, program


def _truetype_drawn(path: str, codes: str, page: int = 0):
    """code → (outline, width) as a reader draws it from the saved file."""
    pdf, font = _font(path, page)
    with pdf:
        tt = TTFont(io.BytesIO(bytes(font.FontDescriptor.FontFile2.read_bytes())))
        glyphs = tt.getGlyphSet()
        first = int(font.FirstChar)
        out = {}
        for ch in codes:
            glyph = _win_ansi_glyph(tt, ord(ch))
            width = float(font.Widths[ord(ch) - first])
            out[ch] = (_outline(glyphs, glyph) if glyph else None, width)
        return out


def _truetype_chars(path: str, page: int = 0) -> set:
    pdf, font = _font(path, page)
    with pdf:
        tt = TTFont(io.BytesIO(bytes(font.FontDescriptor.FontFile2.read_bytes())))
        return {chr(point) for point in tt.getBestCmap()}


class TestTheProbeShape:
    """The common shape of the leak: a TrueType subset of the page's
    characters, WinAnsi-encoded, and a mark over one word of it."""

    def test_glyphs_only_the_removed_text_drew_leave_the_program(self, tmp_dir):
        doc, program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        _src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT)
        pdf, font = _font(out)
        with pdf:
            data = bytes(font.FontDescriptor.FontFile2.read_bytes())
            assert data != program
            assert int(font.FontDescriptor.FontFile2.Length1) == len(data)
            names = TTFont(io.BytesIO(data)).getGlyphOrder()
        assert not set(SECRET) & set(names)

    def test_the_surviving_word_draws_exactly_what_it_drew(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        src, out = _redact(tmp_dir, doc)
        assert _truetype_drawn(out, KEPT) == _truetype_drawn(src, KEPT)
        assert KEPT in extract_text(out)
        assert not set(SECRET) & set(extract_text(out))

    def test_widths_span_only_the_surviving_codes(self, tmp_dir):
        # The range is the survivors' own: Q, X and Z sat at its top, and a
        # range kept whole would still end at them.
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        src, out = _redact(tmp_dir, doc)
        with pikepdf.open(src) as pdf:
            before = [float(w) for w in pdf.pages[0].Resources.Font.F1.Widths]
        pdf, font = _font(out)
        with pdf:
            after = [float(w) for w in font.Widths]
            first, last = int(font.FirstChar), int(font.LastChar)
        assert (first, last) == (ord(min(KEPT)), ord(max(KEPT)))
        assert len(after) == last - first + 1
        for index, width in enumerate(after):
            char = chr(first + index)
            assert width == (before[first + index - 32] if char in KEPT else 0), char
        assert _truetype_drawn(out, KEPT) == _truetype_drawn(src, KEPT)

    def test_a_glyf_program_embedded_as_opentype_is_cut_the_same_way(self, tmp_dir):
        doc, program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        desc = doc.pages[0].Resources.Font.F1.FontDescriptor
        stream = desc.FontFile2
        del desc["/FontFile2"]
        stream["/Subtype"] = Name("/OpenType")
        desc["/FontFile3"] = stream
        _src, out = _redact(tmp_dir, doc)
        pdf, font = _font(out)
        with pdf:
            data = bytes(font.FontDescriptor.FontFile3.read_bytes())
        assert {chr(point) for point in TTFont(io.BytesIO(data)).getBestCmap()} == set(KEPT)

    def test_a_glyph_record_of_zero_contours_without_instructions_is_cut(self, tmp_dir):
        # Some writers store an empty glyph as a bare ten-byte header: zero
        # contours, no instruction length. It draws nothing, and the cut must
        # read it as a reader does instead of refusing the font.
        from fontTools.ttLib.tables._g_l_y_f import Glyph

        tt = TTFont(io.BytesIO(_cut(SANS, KEPT + SECRET)), recalcBBoxes=False)
        tt["glyf"].glyphs[".notdef"] = Glyph(b"\x00" * 10)
        tt["glyf"].padding = 1
        buffer = io.BytesIO()
        tt.save(buffer)
        program = buffer.getvalue()
        reread = TTFont(io.BytesIO(program), lazy=True)
        assert reread["glyf"].glyphs[".notdef"].data == b"\x00" * 10
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]], program=program)
        _src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT)

    def test_a_font_the_marks_never_reached_is_untouched(self, tmp_dir):
        doc, program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        other = _cut(SANS, "other")
        font2 = _truetype_font(doc, other, "other", name=b"GHIJKL+LiberationSans")
        page = doc.pages[0]
        page.Resources.Font["/F2"] = font2
        page.Contents = doc.make_stream(
            bytes(page.Contents.read_bytes()) + _line("F2", 10, b"other").replace(b"50 Td", b"20 Td")
        )
        _src, out = _redact(tmp_dir, doc)
        pdf, font = _font(out, name="/F2")
        with pdf:
            assert bytes(font.FontDescriptor.FontFile2.read_bytes()) == other


class TestWhatSurvivesElsewhere:
    """A glyph stays for as long as any text the saved file keeps draws it."""

    def test_a_glyph_another_page_draws_stays(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)], [(10, "Quiz")]])
        src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT) | set("Quiz")
        assert _truetype_drawn(out, "Quiz", page=1) == _truetype_drawn(src, "Quiz", page=1)
        assert extract_text(out, page_numbers=[1]) == extract_text(src, page_numbers=[1])

    def test_the_shared_font_keeps_every_survivors_glyph_across_pages(self, tmp_dir):
        doc, _program = _truetype_doc(
            [[(10, KEPT), (200, SECRET)], [(10, "Jazz")], [(10, "lucid")]]
        )
        _src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT) | set("Jazz") | set("lucid")
        assert "Q" not in _truetype_chars(out) and "X" not in _truetype_chars(out)

    def test_invisible_text_keeps_its_glyphs(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)], [(10, "QZ")]])
        page = doc.pages[1]
        page.Contents = doc.make_stream(b"3 Tr " + bytes(page.Contents.read_bytes()))
        _src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT) | set("QZ")

    def test_a_form_on_another_page_keeps_its_glyphs(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)], []])
        font = doc.pages[0].Resources.Font.F1
        form = doc.make_stream(_line("F1", 10, b"XJ"))
        form["/Type"] = Name("/XObject")
        form["/Subtype"] = Name("/Form")
        form["/BBox"] = Array([0, 0, 300, 100])
        form["/Resources"] = Dictionary(Font=Dictionary(F1=font))
        page = doc.pages[1]
        page.Resources = Dictionary(XObject=Dictionary(Fm0=doc.make_indirect(form)))
        page.Contents = doc.make_stream(b"/Fm0 Do")
        _src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT) | set("XJ")

    def test_an_annotation_appearance_keeps_its_glyphs(self, tmp_dir):
        # Appearance streams often carry no /Subtype /Form; they are drawn
        # because an annotation names them, not because of what they say.
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        font = doc.pages[0].Resources.Font.F1
        appearance = doc.make_stream(b"BT /F1 12 Tf 2 2 Td (ZX) Tj ET")
        appearance["/BBox"] = Array([0, 0, 40, 20])
        appearance["/Resources"] = Dictionary(Font=Dictionary(F1=font))
        annot = Dictionary(
            Type=Name("/Annot"), Subtype=Name("/Square"), Rect=Array([10, 70, 50, 90]),
            AP=Dictionary(N=Dictionary(On=appearance)),
        )
        doc.pages[0].Annots = doc.make_indirect(Array([doc.make_indirect(annot)]))
        _src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT) | set("ZX")

    def test_a_form_nothing_draws_keeps_its_glyphs_while_the_file_holds_it(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)], [(10, "lucid")]])
        font = doc.pages[0].Resources.Font.F1
        form = doc.make_stream(_line("F1", 10, b"XJ"))
        form["/Type"] = Name("/XObject")
        form["/Subtype"] = Name("/Form")
        form["/BBox"] = Array([0, 0, 300, 100])
        form["/Resources"] = Dictionary(Font=Dictionary(F1=font))
        doc.pages[1].Resources["/XObject"] = Dictionary(Unused=doc.make_indirect(form))
        _src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT) | set("lucid") | set("XJ")

    def test_an_annotation_under_the_mark_takes_its_glyphs_with_it(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, "ZX")]])
        font = doc.pages[0].Resources.Font.F1
        appearance = doc.make_stream(b"BT /F1 12 Tf 2 2 Td (QJ) Tj ET")
        appearance["/Type"] = Name("/XObject")
        appearance["/Subtype"] = Name("/Form")
        appearance["/BBox"] = Array([0, 0, 40, 20])
        appearance["/Resources"] = Dictionary(Font=Dictionary(F1=font))
        annot = Dictionary(
            Type=Name("/Annot"), Subtype=Name("/FreeText"), Rect=Array([250, 45, 290, 65]),
            AP=Dictionary(N=appearance),
        )
        doc.pages[0].Annots = doc.make_indirect(Array([doc.make_indirect(annot)]))
        _src, out = _redact(tmp_dir, doc, name="annot")
        assert _truetype_chars(out) == set(KEPT)

    def test_a_field_value_drawn_from_the_default_appearance_keeps_its_glyphs(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        font = doc.pages[0].Resources.Font.F1
        field = doc.make_indirect(
            Dictionary(FT=Name("/Tx"), T=String("name"), V=String("JZ"), DA=String("/F1 0 Tf 0 g"))
        )
        doc.Root.AcroForm = Dictionary(
            Fields=Array([field]), DR=Dictionary(Font=Dictionary(F1=font)), NeedAppearances=True
        )
        _src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT) | set("JZ")

    def _type3_drawing(self, glyph: str = "g"):
        """Page 2 shows one glyph of a Type 3 font whose procedure draws "XJ"
        with the TrueType font the mark reaches."""
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)], []])
        font = doc.pages[0].Resources.Font.F1
        type3 = doc.make_indirect(Dictionary(
            Type=Name("/Font"), Subtype=Name("/Type3"), FontBBox=Array([0, 0, 1000, 1000]),
            FontMatrix=Array([0.001, 0, 0, 0.001, 0, 0]),
            CharProcs=Dictionary({"/" + glyph: doc.make_stream(b"600 0 d0 BT /F1 1 Tf (XJ) Tj ET")}),
            Encoding=Dictionary(Type=Name("/Encoding"), Differences=Array([65, Name("/" + glyph)])),
            FirstChar=65, LastChar=65, Widths=Array([600]),
            Resources=Dictionary(Font=Dictionary(F1=font)),
        ))
        page = doc.pages[1]
        page.Resources = Dictionary(Font=Dictionary(F3=type3))
        page.Contents = doc.make_stream(b"BT /F3 12 Tf 10 50 Td (A) Tj ET")
        return doc

    def test_a_type3_glyph_procedure_keeps_the_glyphs_it_draws(self, tmp_dir):
        _src, out = _redact(tmp_dir, self._type3_drawing())
        assert _truetype_chars(out) == set(KEPT) | set("XJ")

    def test_a_procedure_named_by_the_empty_name_is_read_like_any_other(self, tmp_dir):
        # §7.3.5 allows the empty name `/`, which pikepdf cannot write as a
        # key: the saved file is patched in place, byte for byte.
        src = _save(self._type3_drawing("Gz"), os.path.join(tmp_dir, "in.pdf"))
        data = open(src, "rb").read()
        assert data.count(b"/Gz ") == 2
        with open(src, "wb") as handle:
            handle.write(data.replace(b"/Gz ", b"/   "))
        out = os.path.join(tmp_dir, "in_out.pdf")
        redact(src, out, [{"page": 1, "rect": MARK}])
        assert _truetype_chars(out) == set(KEPT) | set("XJ")

    def test_a_ligature_only_the_removed_text_drew_goes_though_its_letters_stay(self, tmp_dir):
        # An OpenType program keeps the face's `liga` feature, which joins f
        # and i: a cut with layout closure on would bring the ligature back
        # for the letters that survive.
        program = _cut(SERIF_CFF, "fifth")
        assert "f_i" in TTFont(io.BytesIO(program)).getGlyphOrder()
        doc = pikepdf.new()
        stream = doc.make_stream(program)
        stream["/Subtype"] = Name("/OpenType")
        desc = Dictionary(
            Type=Name("/FontDescriptor"), FontName=Name("/ABCDEF+LibertinusSerif"), Flags=32,
            FontBBox=Array([-200, -300, 1200, 1000]), ItalicAngle=0, Ascent=900,
            Descent=-200, CapHeight=700, StemV=80, FontFile3=stream,
        )
        font = doc.make_indirect(
            Dictionary(
                Type=Name("/Font"), Subtype=Name("/Type1"), BaseFont=Name("/ABCDEF+LibertinusSerif"),
                FirstChar=1, LastChar=126, Widths=Array([500] * 126), FontDescriptor=desc,
                Encoding=Dictionary(
                    Type=Name("/Encoding"), BaseEncoding=Name("/WinAnsiEncoding"),
                    Differences=Array([1, Name("/f_i")]),
                ),
            )
        )
        page = doc.add_blank_page(page_size=PAGE)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(_line("F1", 10, b"fifth") + _line("F1", 200, b"\x01"))
        _src, out = _redact(tmp_dir, doc)
        pdf, saved = _font(out)
        with pdf:
            names = set(TTFont(io.BytesIO(bytes(saved.FontDescriptor.FontFile3.read_bytes()))).getGlyphOrder())
            differences = list(saved.Encoding.Differences)
        assert "f_i" not in names
        assert {"f", "i", "t", "h"} <= names
        assert differences == []


class TestTables:
    """Every table that names a code or a glyph names only the survivors."""

    def test_tounicode_keeps_the_survivors_and_reads_them_as_before(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]], tounicode=True)
        src, out = _redact(tmp_dir, doc)
        with pikepdf.open(src) as pdf:
            before = _tounicode_map(pdf.pages[0].Resources.Font.F1)
        pdf, font = _font(out)
        with pdf:
            after = _tounicode_map(font)
        assert after == {code: text for code, text in before.items() if text in KEPT}
        assert extract_text(out).strip() == KEPT

    def test_differences_keep_only_the_codes_the_survivors_draw(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        font = doc.pages[0].Resources.Font.F1
        font["/Encoding"] = Dictionary(
            Type=Name("/Encoding"), BaseEncoding=Name("/WinAnsiEncoding"),
            Differences=Array([74, Name("/J"), 81, Name("/Q"), 98, Name("/b"), Name("/c")]),
        )
        src, out = _redact(tmp_dir, doc)
        pdf, saved = _font(out)
        with pdf:
            assert list(saved.Encoding.Differences) == [98, Name("/b"), Name("/c")]
        assert _truetype_drawn(out, KEPT) == _truetype_drawn(src, KEPT)

    def test_a_widths_array_two_fonts_share_moves_both_ranges(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)], [(10, "Quiz")]])
        font = doc.pages[0].Resources.Font.F1
        shared = doc.make_indirect(Array(list(font.Widths)))
        font["/Widths"] = shared
        twin = doc.make_indirect(Dictionary({key: font[key] for key in font.keys()}))
        doc.pages[1].Resources = Dictionary(Font=Dictionary(F1=twin))
        src, out = _redact(tmp_dir, doc)
        with pikepdf.open(out) as pdf:
            one = pdf.pages[0].Resources.Font.F1
            two = pdf.pages[1].Resources.Font.F1
            assert one.Widths.objgen == two.Widths.objgen
            spans = [(int(f.FirstChar), int(f.LastChar)) for f in (one, two)]
        survivors = set(KEPT) | set("Quiz")
        assert spans == [(ord(min(survivors)), ord(max(survivors)))] * 2
        assert _truetype_drawn(out, "Quiz", page=1) == _truetype_drawn(src, "Quiz", page=1)
        assert _truetype_drawn(out, KEPT) == _truetype_drawn(src, KEPT)

    def test_the_empty_name_survives_the_rebuilt_differences(self, tmp_dir):
        # §7.3.5 allows the empty name `/`, which `pikepdf.Name()` cannot build.
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        font = doc.pages[0].Resources.Font.F1
        font["/Encoding"] = Dictionary(
            Type=Name("/Encoding"), BaseEncoding=Name("/WinAnsiEncoding"),
            Differences=pikepdf.Object.parse(b"[74 /J 81 /Q 117 / ]"),
        )
        src, out = _redact(tmp_dir, doc)
        pdf, saved = _font(out)
        with pdf:
            assert saved.Encoding.Differences.unparse() == b"[ 117 / ]"
        assert _truetype_drawn(out, KEPT) == _truetype_drawn(src, KEPT)


class TestMalformedShowOperands:
    """Readers disagree on a show operator with the wrong operands: a string
    any of them can draw keeps its glyph, and a name or a number keeps none."""

    def test_every_string_a_reader_can_draw_keeps_its_glyph(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)], []])
        doc.pages[1].Contents = doc.make_stream(
            b"BT /F1 12 Tf 10 50 Td (Q) TJ (Z) (X) Tj [(J)] Tj ET"
        )
        _src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT) | set(SECRET)

    def test_a_name_or_a_number_where_a_string_belongs_keeps_no_glyph(self, tmp_dir):
        # `bytes()` of a name is its spelling, so /QZ read as codes keeps Q
        # and Z.
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)], []])
        doc.pages[1].Contents = doc.make_stream(
            b"BT /F1 12 Tf 10 50 Td 5 TJ 5 Tj [/QZ 5] TJ /XJ Tj ET"
        )
        _src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT)


# ── bare CFF (Type1C) ─────────────────────────────────────────────────────


def _cff_program(text: str) -> bytes:
    return TTFont(io.BytesIO(_cut(SERIF_CFF, text))).getTableData("CFF ")


def _type1c_doc(pages, charset: bool = True, extra: str = ""):
    text = "".join(t for page in pages for _x, t in page)
    program = _cff_program(text + extra)
    doc = pikepdf.new()
    stream = doc.make_stream(program)
    stream["/Subtype"] = Name("/Type1C")
    names = [n for n in _cff_top(program).charset if n != ".notdef"]
    desc = Dictionary(
        Type=Name("/FontDescriptor"), FontName=Name("/ABCDEF+LibertinusSerif"), Flags=32,
        FontBBox=Array([-200, -300, 1200, 1000]), ItalicAngle=0, Ascent=900,
        Descent=-200, CapHeight=700, StemV=80, FontFile3=stream,
    )
    if charset:
        desc["/CharSet"] = String("".join("/" + n for n in names))
    font = doc.make_indirect(
        Dictionary(
            Type=Name("/Font"), Subtype=Name("/Type1"), BaseFont=Name("/ABCDEF+LibertinusSerif"),
            FirstChar=32, LastChar=126, Widths=Array([500] * 95),
            Encoding=Name("/WinAnsiEncoding"), FontDescriptor=desc,
        )
    )
    for lines in pages:
        page = doc.add_blank_page(page_size=PAGE)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(
            b"".join(_line("F1", x, t.encode("latin-1")) for x, t in lines)
        )
    return doc, program


def _cff_top(program: bytes):
    return redact_fonts._cff_font(program)["CFF "].cff.topDictIndex[0]


def _cff_drawn(program: bytes, names) -> dict:
    top = _cff_top(program)
    out = {}
    for name in names:
        pen = RecordingPen()
        top.CharStrings[name].draw(pen)
        out[name] = (pen.value, top.CharStrings[name].width)
    return out


class TestType1C:
    def test_glyphs_only_the_removed_text_drew_leave_the_program(self, tmp_dir):
        doc, program = _type1c_doc([[(10, KEPT), (200, SECRET)], [(10, "Quiz")]])
        src, out = _redact(tmp_dir, doc)
        pdf, font = _font(out)
        with pdf:
            saved = bytes(font.FontDescriptor.FontFile3.read_bytes())
            charset = bytes(font.FontDescriptor.CharSet)
        names = set(_cff_top(saved).charset)
        assert names == {".notdef"} | set(KEPT) | set("Quiz")
        assert not {"Z", "X", "J"} & names
        survivors = sorted(set(KEPT) | set("Quiz"))
        assert _cff_drawn(saved, survivors) == _cff_drawn(program, survivors)
        assert set(re.findall(rb"/([^/]+)", charset)) == {n.encode() for n in names - {".notdef"}}
        assert extract_text(out, page_numbers=[1]) == extract_text(src, page_numbers=[1])

    def test_a_program_without_a_charset_operator_is_cut(self, tmp_dir):
        # A Top DICT without the charset operator declares the ISOAdobe
        # charset, glyph id i named by its i-th string.
        from fontTools.cffLib import cffISOAdobeStrings
        from fontTools.fontBuilder import FontBuilder
        from fontTools.pens.t2CharStringPen import T2CharStringPen

        order = list(cffISOAdobeStrings[:60])
        builder = FontBuilder(1000, isTTF=False)
        builder.setupGlyphOrder(order)
        charstrings = {}
        for gid, name in enumerate(order):
            pen = T2CharStringPen(600, None)
            pen.moveTo((0, 0))
            pen.lineTo((0, 100 + gid))
            pen.lineTo((500, 100 + gid))
            pen.closePath()
            charstrings[name] = pen.getCharString()
        builder.setupCFF("NoCharset", {}, charstrings, {})
        top = builder.font["CFF "].cff.topDictIndex[0]
        _ = top.CharStrings
        del top.charset
        top.order = [op for op in top.order if op != "charset"]
        program = builder.font["CFF "].compile(builder.font)
        from fontTools.cffLib import CFFFontSet

        bare = CFFFontSet()
        bare.decompile(io.BytesIO(program), None)
        assert not hasattr(bare.topDictIndex[0], "charset")
        doc, _p = _type1c_doc([[(10, "AB"), (200, "QZ")]])
        doc.pages[0].Resources.Font.F1.FontDescriptor.FontFile3.write(program)
        _src, out = _redact(tmp_dir, doc)
        pdf, font = _font(out)
        with pdf:
            saved = bytes(font.FontDescriptor.FontFile3.read_bytes())
        names = set(_cff_top(saved).charset)
        assert {"A", "B"} <= names and not {"Q", "Z"} & names
        assert _cff_drawn(saved, ["A", "B"]) == _cff_drawn(program, ["A", "B"])

    def test_an_unused_winansi_code_keeps_the_bullet_it_draws(self, tmp_dir):
        # Annex D.2, note 3: every unused WinAnsiEncoding code above 32 draws
        # the bullet, so a list bullet shown as code 127 survives on its own.
        doc, program = _type1c_doc([[(10, KEPT), (200, SECRET)]], extra="•")
        assert "bullet" in _cff_top(program).charset
        doc.pages[0].Contents = doc.make_stream(
            _line("F1", 10, KEPT.encode() + b"\x7f") + _line("F1", 200, SECRET.encode())
        )
        _src, out = _redact(tmp_dir, doc)
        pdf, font = _font(out)
        with pdf:
            saved = bytes(font.FontDescriptor.FontFile3.read_bytes())
        assert "bullet" in _cff_top(saved).charset
        assert _cff_drawn(saved, ["bullet"]) == _cff_drawn(program, ["bullet"])


# ── Type 1 ────────────────────────────────────────────────────────────────


def _t1_number(value: int) -> bytes:
    if -107 <= value <= 107:
        return bytes([value + 139])
    if 108 <= value <= 1131:
        value -= 108
        return bytes([(value >> 8) + 247, value & 0xFF])
    if -1131 <= value <= -108:
        value = -value - 108
        return bytes([(value >> 8) + 251, value & 0xFF])
    return b"\xff" + value.to_bytes(4, "big", signed=True)


def _t1(*items) -> bytes:
    """A charstring: ints are numbers, strings name the operators used here."""
    ops = {
        "hsbw": b"\x0d", "rmoveto": b"\x15", "rlineto": b"\x05", "closepath": b"\x09",
        "endchar": b"\x0e", "callsubr": b"\x0a", "return": b"\x0b",
        "callothersubr": b"\x0c\x10", "pop": b"\x0c\x11", "setcurrentpoint": b"\x0c\x21",
    }
    return b"".join(_t1_number(item) if isinstance(item, int) else ops[item] for item in items)


def _box(width: int, height: int) -> list:
    return [0, 0, "rmoveto", width, 0, "rlineto", 0, height, "rlineto", -width, 0, "rlineto", "closepath"]


# Subrs 0-3 are the conventional flex and hint-replacement subroutines; 4 is
# only Q's, 5 is shared by Q and p, 6 is nobody's.
_T1_SUBRS = [
    _t1(3, 0, "callothersubr", "pop", "pop", "setcurrentpoint", "return"),
    _t1(0, 1, "callothersubr", "return"),
    _t1(0, 2, "callothersubr", "return"),
    _t1("return"),
    _t1(40, 40, "rmoveto", 30, 0, "rlineto", 0, -90, "rlineto", "closepath", "return"),
    _t1(10, 10, "rmoveto", 20, 0, "rlineto", 0, 20, "rlineto", "closepath", "return"),
    _t1(5, 5, "rmoveto", 5, 0, "rlineto", "closepath", "return"),
]
_T1_GLYPHS = {
    ".notdef": _t1(0, 250, "hsbw", "endchar"),
    "Q": _t1(0, 700, "hsbw", *_box(600, 700), 4, "callsubr", 5, "callsubr", "endchar"),
    "Z": _t1(0, 600, "hsbw", *_box(500, 700), "endchar"),
    "X": _t1(0, 650, "hsbw", *_box(550, 700), "endchar"),
    "J": _t1(0, 400, "hsbw", *_box(300, 700), "endchar"),
    "p": _t1(0, 550, "hsbw", *_box(450, 500), 5, "callsubr", "endchar"),
    "u": _t1(0, 560, "hsbw", *_box(460, 500), "endchar"),
    "b": _t1(0, 570, "hsbw", *_box(470, 700), "endchar"),
    "l": _t1(0, 280, "hsbw", *_box(180, 700), "endchar"),
    "i": _t1(0, 290, "hsbw", *_box(190, 650), "endchar"),
    "c": _t1(0, 480, "hsbw", *_box(380, 500), "endchar"),
}


def _type1_program(encoding=None) -> tuple:
    clear = [
        b"%!PS-AdobeFont-1.0: RdxType1 001.001",
        b"11 dict begin",
        b"/FontName /RdxType1 def",
        b"/PaintType 0 def",
        b"/FontType 1 def",
        b"/FontMatrix [0.001 0 0 0.001 0 0] readonly def",
        b"/FontBBox{0 -200 1000 900}readonly def",
        b"/Encoding 256 array",
        b"0 1 255 {1 index exch /.notdef put} for",
    ]
    if encoding is None:
        encoding = {ord(n): n for n in _T1_GLYPHS if n != ".notdef"}
    for code, name in sorted(encoding.items()):
        clear.append(b"dup %d /%s put" % (code, name.encode()))
    clear += [b"readonly def", b"currentdict end", b"currentfile eexec", b""]
    clear_bytes = b"\n".join(clear)
    private = [
        b"dup /Private 8 dict dup begin",
        b"/RD{string currentfile exch readstring pop}executeonly def",
        b"/ND{noaccess def}executeonly def",
        b"/NP{noaccess put}executeonly def",
        b"/lenIV 4 def",
        b"/Subrs %d array" % len(_T1_SUBRS),
    ]
    for index, body in enumerate(_T1_SUBRS):
        blob = eexec.encrypt(b"\x01\x02\x03\x04" + body, 4330)[0]
        private.append(b"dup %d %d RD " % (index, len(blob)) + blob + b" NP")
    private += [b"ND", b"2 index /CharStrings %d dict dup begin" % len(_T1_GLYPHS)]
    for name, body in _T1_GLYPHS.items():
        blob = eexec.encrypt(b"\x05\x06\x07\x08" + body, 4330)[0]
        private.append(b"/%s %d RD " % (name.encode(), len(blob)) + blob + b" ND")
    private += [
        b"end", b"end", b"readonly put", b"noaccess put",
        b"dup/FontName get exch definefont pop", b"mark currentfile closefile", b"",
    ]
    cipher = eexec.encrypt(b"T1!!" + b"\n".join(private), 55665)[0]
    trailer = b"\n" + (b"0" * 64 + b"\n") * 8 + b"cleartomark\n"
    return clear_bytes + cipher + trailer, len(clear_bytes), len(cipher), len(trailer)


def _type1_doc(pages, encoding=None):
    program, length1, length2, length3 = _type1_program(encoding)
    doc = pikepdf.new()
    stream = doc.make_stream(program)
    stream["/Length1"] = length1
    stream["/Length2"] = length2
    stream["/Length3"] = length3
    names = sorted(n for n in _T1_GLYPHS if n != ".notdef")
    desc = Dictionary(
        Type=Name("/FontDescriptor"), FontName=Name("/ABCDEF+RdxType1"), Flags=4,
        FontBBox=Array([0, -200, 1000, 900]), ItalicAngle=0, Ascent=900, Descent=-200,
        CapHeight=700, StemV=80, FontFile=stream, CharSet=String("".join("/" + n for n in names)),
    )
    widths = [0] * 95
    for name in names:
        widths[ord(name) - 32] = 500
    font = doc.make_indirect(
        Dictionary(
            Type=Name("/Font"), Subtype=Name("/Type1"), BaseFont=Name("/ABCDEF+RdxType1"),
            FirstChar=32, LastChar=126, Widths=Array(widths), FontDescriptor=desc,
        )
    )
    for lines in pages:
        page = doc.add_blank_page(page_size=PAGE)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(
            b"".join(_line("F1", x, t.encode("latin-1")) for x, t in lines)
        )
    return doc, program


def _type1_glyphs(program: bytes) -> dict:
    return redact_fonts._type1_outlines(None, program)


def _type1_decrypted(program: bytes) -> bytes:
    start = program.find(b"currentfile eexec") + len(b"currentfile eexec") + 1
    end = program.find(b"0" * 64)
    return eexec.decrypt(program[start:end].rstrip(b"\n"), 55665)[0]


def _type1_subr(plain: bytes, index: int) -> bytes:
    match = re.search(rb"dup %d (\d+) RD " % index, plain)
    start = match.end()
    return eexec.decrypt(plain[start : start + int(match.group(1))], 4330)[0][4:]


class TestType1:
    def _saved(self, out):
        pdf, font = _font(out)
        with pdf:
            stream = font.FontDescriptor.FontFile
            return (
                bytes(stream.read_bytes()),
                (int(stream.Length1), int(stream.Length2), int(stream.Length3)),
                bytes(font.FontDescriptor.CharSet),
            )

    def test_charstrings_only_the_removed_text_drew_leave_the_program(self, tmp_dir):
        doc, program = _type1_doc([[(10, KEPT), (200, SECRET)], [(10, "Z")]])
        _src, out = _redact(tmp_dir, doc)
        saved, lengths, charset = self._saved(out)
        glyphs = _type1_glyphs(saved)
        assert set(glyphs) == {".notdef", "Z"} | set(KEPT)
        before = _type1_glyphs(program)
        assert all(glyphs[name] == before[name] for name in glyphs)
        assert sum(lengths) == len(saved)
        assert set(re.findall(rb"/([^/]+)", charset)) == {b"Z"} | {c.encode() for c in KEPT}

    def test_the_built_in_encoding_stops_naming_them(self, tmp_dir):
        doc, _program = _type1_doc([[(10, KEPT), (200, SECRET)]])
        _src, out = _redact(tmp_dir, doc)
        saved, lengths, _charset = self._saved(out)
        clear = saved[: lengths[0]]
        named = set(re.findall(rb"dup \d+ /(\S+) put", clear))
        assert named == {c.encode() for c in KEPT}

    def test_a_symbolic_font_is_read_through_its_own_encoding_only(self, tmp_dir):
        # Symbolic, no /Encoding: every code takes its name from the built-in
        # encoding (§9.6.5.2, Table 112). Here code 0x51, "Q" under the
        # Standard encoding, draws "u", and "Q" is drawn only as code 0x41,
        # under the mark.
        encoding = {ord(n): n for n in _T1_GLYPHS if n not in (".notdef", "Q", "u")}
        encoding[0x41] = "Q"
        encoding[0x51] = "u"
        doc, _program = _type1_doc([[(10, "pQbl"), (200, "A")]], encoding=encoding)
        _src, out = _redact(tmp_dir, doc)
        glyphs = _type1_glyphs(self._saved(out)[0])
        assert "Q" not in glyphs
        assert {"p", "u", "b", "l"} <= set(glyphs)

    def test_a_subroutine_only_removed_glyphs_called_becomes_return(self, tmp_dir):
        doc, _program = _type1_doc([[(10, KEPT), (200, SECRET)]])
        _src, out = _redact(tmp_dir, doc)
        plain = _type1_decrypted(self._saved(out)[0])
        assert _type1_subr(plain, 4) == b"\x0b"
        assert _type1_subr(plain, 6) == b"\x0b"
        assert _type1_subr(plain, 5) == _T1_SUBRS[5]
        for index in range(4):
            assert _type1_subr(plain, index) == _T1_SUBRS[index]


# ── Type 3 ────────────────────────────────────────────────────────────────


def _type3_doc(pages):
    doc = pikepdf.new()
    image = doc.make_stream(b"\xff" * 4)
    image["/Type"] = Name("/XObject")
    image["/Subtype"] = Name("/Image")
    image["/Width"] = 2
    image["/Height"] = 2
    image["/ColorSpace"] = Name("/DeviceGray")
    image["/BitsPerComponent"] = 8
    procs = Dictionary()
    names = sorted(set(KEPT + SECRET))
    for index, name in enumerate(names):
        body = b"600 0 0 0 500 700 d1 0 0 %d 700 re f" % (100 + index * 10)
        if name == "Q":
            body += b" q 100 0 0 100 0 0 cm /ImQ Do Q"
        procs[Name("/" + name)] = doc.make_stream(body)
    widths = [0] * 95
    for name in names:
        widths[ord(name) - 32] = 600
    font = doc.make_indirect(
        Dictionary(
            Type=Name("/Font"), Subtype=Name("/Type3"), FontBBox=Array([0, 0, 1000, 1000]),
            FontMatrix=Array([0.001, 0, 0, 0.001, 0, 0]), CharProcs=procs,
            Encoding=Dictionary(
                Type=Name("/Encoding"),
                Differences=Array([item for name in names for item in (ord(name), Name("/" + name))]),
            ),
            FirstChar=32, LastChar=126, Widths=Array(widths),
            Resources=Dictionary(XObject=Dictionary(ImQ=doc.make_indirect(image))),
            ToUnicode=_tounicode(doc, [(bytes([ord(n)]), n) for n in names]),
        )
    )
    for lines in pages:
        page = doc.add_blank_page(page_size=PAGE)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(
            b"".join(_line("F1", x, t.encode("latin-1")) for x, t in lines)
        )
    return doc


class TestType3:
    def test_procedures_only_the_removed_text_drew_leave_the_font(self, tmp_dir):
        doc = _type3_doc([[(10, KEPT), (200, SECRET)], [(10, "X")]])
        src, out = _redact(tmp_dir, doc)
        with pikepdf.open(src) as pdf:
            before = {
                str(k)[1:]: bytes(v.read_bytes())
                for k, v in pdf.pages[0].Resources.Font.F1.CharProcs.items()
            }
        pdf, font = _font(out)
        with pdf:
            after = {str(k)[1:]: bytes(v.read_bytes()) for k, v in font.CharProcs.items()}
            differences = list(font.Encoding.Differences)
            tounicode = _tounicode_map(font)
            resources = font.Resources
            images = list(resources.XObject.keys()) if "/XObject" in resources else []
            widths = [float(w) for w in font.Widths]
            first = int(font.FirstChar)
        assert set(after) == set(KEPT) | {"X"}
        assert all(after[name] == before[name] for name in after)
        named = {str(item)[1:] for item in differences if isinstance(item, Name)}
        assert named == set(KEPT) | {"X"}
        assert set(tounicode.values()) == set(KEPT) | {"X"}
        assert images == []
        assert {chr(first + i) for i, w in enumerate(widths) if w} == set(KEPT) | {"X"}

    def test_a_resource_a_kept_procedure_names_stays_by_its_bytes(self, tmp_dir):
        # §7.3.5: a name need not be UTF-8. Q's image goes with Q; p's stays.
        doc = _type3_doc([[(10, KEPT), (200, SECRET)]])
        font = doc.pages[0].Resources.Font.F1
        font.Resources.XObject[pikepdf.Object.parse(b"/Im#C3")] = font.Resources.XObject.ImQ
        proc = font.CharProcs.p
        proc.write(bytes(proc.read_bytes()) + b" q 100 0 0 100 0 0 cm /Im#C3 Do Q")
        _src, out = _redact(tmp_dir, doc)
        pdf, saved = _font(out)
        with pdf:
            names = [key.encode("utf-8", "surrogateescape") for key in saved.Resources.XObject.keys()]
        assert names == [b"/Im\xc3"]

    def test_a_procedure_named_by_the_empty_name_goes_like_any_other(self, tmp_dir):
        # §7.3.5 allows the empty name `/`, which pikepdf cannot write as a
        # key: the saved file is patched in place, byte for byte.
        doc = _type3_doc([[(10, KEPT), (200, SECRET)]])
        src = _save(doc, os.path.join(tmp_dir, "in.pdf"))
        data = open(src, "rb").read()
        assert data.count(b"/Q ") == 2
        with open(src, "wb") as handle:
            handle.write(data.replace(b"/Q ", b"/  "))
        with pikepdf.open(src) as pdf:
            assert "/" in pdf.pages[0].Resources.Font.F1.CharProcs
        out = os.path.join(tmp_dir, "in_out.pdf")
        redact(src, out, [{"page": 1, "rect": MARK}])
        pdf, font = _font(out)
        with pdf:
            assert set(font.CharProcs.keys()) == {"/" + ch for ch in KEPT}


# ── composite fonts ───────────────────────────────────────────────────────


def _cid_set(cids) -> bytes:
    bits = bytearray((max(cids) >> 3) + 1)
    for cid in cids:
        bits[cid >> 3] |= 0x80 >> (cid & 7)
    return bytes(bits)


def _cid_set_members(data: bytes) -> set:
    return {i for i in range(len(data) * 8) if data[i >> 3] & (0x80 >> (i & 7))}


def _cid_widths(items) -> dict:
    from pdfminer.pdffont import get_widths

    return get_widths([list(x) if isinstance(x, Array) else int(x) for x in items])


def _type0(doc, kid_subtype, program_slot, program, cids_by_char, cid_to_gid=None):
    """A Type0 Identity-H font over a CIDFont whose codes are its CIDs."""
    desc = Dictionary(
        Type=Name("/FontDescriptor"), FontName=Name("/ABCDEF+Composite"), Flags=4,
        FontBBox=Array([-200, -300, 1200, 1000]), ItalicAngle=0, Ascent=900, Descent=-200,
        CapHeight=700, StemV=80, CIDSet=doc.make_stream(_cid_set(set(cids_by_char.values()) | {0})),
    )
    desc[program_slot] = program
    widths = []
    for cid in sorted(cids_by_char.values()):
        widths += [cid, Array([500 + cid % 7])]
    kid = Dictionary(
        Type=Name("/Font"), Subtype=Name(kid_subtype), BaseFont=Name("/ABCDEF+Composite"),
        CIDSystemInfo=Dictionary(Registry=String("Adobe"), Ordering=String("Identity"), Supplement=0),
        FontDescriptor=desc, DW=1000, W=Array(widths),
    )
    if cid_to_gid is not None:
        kid["/CIDToGIDMap"] = cid_to_gid
    return doc.make_indirect(
        Dictionary(
            Type=Name("/Font"), Subtype=Name("/Type0"), BaseFont=Name("/ABCDEF+Composite"),
            Encoding=Name("/Identity-H"), DescendantFonts=Array([doc.make_indirect(kid)]),
            ToUnicode=_tounicode(doc, [(cid.to_bytes(2, "big"), ch) for ch, cid in sorted(cids_by_char.items())]),
        )
    )


def _show_cids(cids_by_char, text: str) -> bytes:
    return b"".join(cids_by_char[ch].to_bytes(2, "big") for ch in text)


def _composite_pages(doc, font, cids_by_char, pages):
    for lines in pages:
        page = doc.add_blank_page(page_size=PAGE)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(
            b"".join(_line("F1", x, _show_cids(cids_by_char, t)) for x, t in lines)
        )


class TestCIDFontType2:
    """TrueType under Identity-H with the codes as glyph ids: the ids are
    compacted, so /CIDToGIDMap turns from /Identity into a stream that sends
    every surviving CID to its glyph's new id."""

    def _doc(self, pages):
        text = "".join(t for page in pages for _x, t in page)
        program = _cut(SANS, text)
        tt = TTFont(io.BytesIO(program))
        order = tt.getGlyphOrder()
        cids = {ch: order.index(tt.getBestCmap()[ord(ch)]) for ch in sorted(set(text))}
        doc = pikepdf.new()
        stream = doc.make_stream(program)
        stream["/Length1"] = len(program)
        font = _type0(doc, "/CIDFontType2", "/FontFile2", stream, cids, Name("/Identity"))
        _composite_pages(doc, font, cids, pages)
        return doc, program, cids

    def _drawn(self, path, cids_by_char, text, page=0):
        pdf, font = _font(path, page)
        with pdf:
            kid = font.DescendantFonts[0]
            tt = TTFont(io.BytesIO(bytes(kid.FontDescriptor.FontFile2.read_bytes())))
            order, glyphs = tt.getGlyphOrder(), tt.getGlyphSet()
            table = kid.CIDToGIDMap
            widths = _cid_widths(list(kid.W))
            out = {}
            for ch in text:
                cid = cids_by_char[ch]
                if isinstance(table, pikepdf.Stream):
                    data = bytes(table.read_bytes())
                    gid = (data[2 * cid] << 8) | data[2 * cid + 1]
                else:
                    gid = cid
                out[ch] = (_outline(glyphs, order[gid]), widths.get(cid))
            return out

    def test_glyphs_go_and_every_survivor_draws_what_it_drew(self, tmp_dir):
        doc, program, cids = self._doc([[(10, KEPT), (200, SECRET)], [(10, "Quiz")]])
        src, out = _redact(tmp_dir, doc)
        survivors = set(KEPT) | set("Quiz")
        assert self._drawn(out, cids, KEPT) == self._drawn(src, cids, KEPT)
        assert self._drawn(out, cids, "Quiz", page=1) == self._drawn(src, cids, "Quiz", page=1)
        pdf, font = _font(out)
        with pdf:
            kid = font.DescendantFonts[0]
            data = bytes(kid.FontDescriptor.FontFile2.read_bytes())
            tt = TTFont(io.BytesIO(data))
            assert len(tt.getGlyphOrder()) == len(survivors) + 1
            assert not {"Z", "X", "J"} & set(tt.getGlyphOrder())
            table = bytes(kid.CIDToGIDMap.read_bytes())
            mapped = {cid for cid in range(len(table) // 2) if table[2 * cid] or table[2 * cid + 1]}
            assert mapped == {cids[ch] for ch in survivors}
            assert set(_cid_widths(list(kid.W))) == {cids[ch] for ch in survivors}
            assert _cid_set_members(bytes(kid.FontDescriptor.CIDSet.read_bytes())) == {0} | mapped
            assert set(_tounicode_map(font).values()) == survivors
        assert extract_text(out, page_numbers=[1]) == extract_text(src, page_numbers=[1])


class TestAProgramTwoFontsShare:
    """One TrueType program under a simple font and under a Type0 font, the
    shape several writers emit. The simple font's cut compacts the glyph ids,
    so the Type0 font, whose own text no mark reached, draws through a
    rewritten /CIDToGIDMap and still draws exactly what it drew."""

    def test_the_untouched_composite_font_still_draws_every_glyph(self, tmp_dir):
        text = KEPT + SECRET + "Quizlucid"
        program = _cut(SANS, text)
        tt = TTFont(io.BytesIO(program))
        order = tt.getGlyphOrder()
        gids = {ch: order.index(tt.getBestCmap()[ord(ch)]) for ch in sorted(set(text))}
        doc = pikepdf.new()
        simple = _truetype_font(doc, program, text)
        shared = simple.FontDescriptor.FontFile2
        composite = _type0(doc, "/CIDFontType2", "/FontFile2", shared, gids, Name("/Identity"))
        first = doc.add_blank_page(page_size=PAGE)
        first.Resources = Dictionary(Font=Dictionary(F1=simple))
        first.Contents = doc.make_stream(_line("F1", 10, KEPT.encode()) + _line("F1", 200, SECRET.encode()))
        _composite_pages(doc, composite, gids, [[(10, "Quizlucid")]])
        src, out = _redact(tmp_dir, doc)
        drawn = TestCIDFontType2()._drawn
        assert drawn(out, gids, "Quizlucid", page=1) == drawn(src, gids, "Quizlucid", page=1)
        with pikepdf.open(out) as pdf:
            kid = pdf.pages[1].Resources.Font.F1.DescendantFonts[0]
            assert isinstance(kid.CIDToGIDMap, pikepdf.Stream)
            names = TTFont(io.BytesIO(bytes(kid.FontDescriptor.FontFile2.read_bytes()))).getGlyphOrder()
        assert not {"Z", "X", "J"} & set(names)


class TestCIDFontType0C:
    """A CID-keyed CFF: the charset names each glyph's CID, so compacting the
    glyph ids leaves every CID drawing its own glyph."""

    CHARS = "公开秘密漢字"
    KEEP = "公开"
    HIDE = "秘密"

    def _doc(self):
        cff = TTFont(io.BytesIO(_cut(CJK, self.CHARS))).getTableData("CFF ")
        top = _cff_top(cff)
        tt = TTFont(io.BytesIO(_cut(CJK, self.CHARS)))
        cmap = tt.getBestCmap()
        cids = {ch: int(cmap[ord(ch)][3:]) for ch in self.CHARS}
        assert all(f"cid{c:05d}" in top.charset for c in cids.values())
        doc = pikepdf.new()
        stream = doc.make_stream(cff)
        stream["/Subtype"] = Name("/CIDFontType0C")
        font = _type0(doc, "/CIDFontType0", "/FontFile3", stream, cids)
        _composite_pages(doc, font, cids, [[(10, self.KEEP), (200, self.HIDE)], [(10, "漢字")]])
        return doc, cff, cids

    def test_cids_only_the_removed_text_drew_leave_the_program(self, tmp_dir):
        doc, cff, cids = self._doc()
        src, out = _redact(tmp_dir, doc)
        pdf, font = _font(out)
        with pdf:
            kid = font.DescendantFonts[0]
            saved = bytes(kid.FontDescriptor.FontFile3.read_bytes())
            cid_set = _cid_set_members(bytes(kid.FontDescriptor.CIDSet.read_bytes()))
            widths = set(_cid_widths(list(kid.W)))
            tounicode = set(_tounicode_map(font).values())
        survivors = self.KEEP + "漢字"
        charset = set(_cff_top(saved).charset)
        assert charset == {".notdef"} | {f"cid{cids[ch]:05d}" for ch in survivors}
        names = [f"cid{cids[ch]:05d}" for ch in survivors]
        assert _cff_drawn(saved, names) == _cff_drawn(cff, names)
        assert cid_set == {0} | {cids[ch] for ch in survivors}
        assert widths == {cids[ch] for ch in survivors}
        assert tounicode == set(survivors)
        assert extract_text(out, page_numbers=[1]) == extract_text(src, page_numbers=[1])


class TestOpenTypeCFFWhereTheCIDIsTheGlyphId:
    """A CFF without CID operators under a CIDFontType0 draws glyph id = CID
    (§9.7.4.2). The ids stay; every glyph not kept is emptied and loses the
    name that said what it was."""

    def _doc(self):
        base = TTFont(SERIF_CFF, lazy=True)
        order = base.getGlyphOrder()
        cmap = base.getBestCmap()
        chars = sorted(set(KEPT + SECRET + "Quiz"))
        gids = {ch: order.index(cmap[ord(ch)]) for ch in chars}
        program = _cut(SERIF_CFF, retain=True, gids=[0] + sorted(gids.values()))
        doc = pikepdf.new()
        stream = doc.make_stream(program)
        stream["/Subtype"] = Name("/OpenType")
        font = _type0(doc, "/CIDFontType0", "/FontFile3", stream, gids)
        _composite_pages(doc, font, gids, [[(10, KEPT), (200, SECRET)], [(10, "Quiz")]])
        return doc, program, gids

    def test_a_bare_cff_keeps_its_ids_and_empties_the_rest(self, tmp_dir):
        doc, program, gids = self._doc()
        bare = TTFont(io.BytesIO(program)).getTableData("CFF ")
        stream = doc.pages[0].Resources.Font.F1.DescendantFonts[0].FontDescriptor.FontFile3
        stream.write(bare)
        stream["/Subtype"] = Name("/CIDFontType0C")
        _src, out = _redact(tmp_dir, doc)
        pdf, font = _font(out)
        with pdf:
            saved = bytes(font.DescendantFonts[0].FontDescriptor.FontFile3.read_bytes())
        before, after = _cff_top(bare), _cff_top(saved)
        names = list(after.charset)
        for ch in set(KEPT) | set("Quiz"):
            gid = gids[ch]
            assert names[gid] == before.charset[gid]
            assert _cff_drawn(saved, [names[gid]]) == _cff_drawn(bare, [names[gid]])
        for ch in "ZXJ":
            gid = gids[ch]
            assert names[gid] == f"gid{gid:05d}"
            assert _cff_drawn(saved, [names[gid]])[names[gid]][0] == []
        assert not {"Z", "X", "J"} & set(names)

    def test_removed_glyphs_are_emptied_in_place_and_renamed(self, tmp_dir):
        doc, program, gids = self._doc()
        _src, out = _redact(tmp_dir, doc)
        pdf, font = _font(out)
        with pdf:
            saved = bytes(font.DescendantFonts[0].FontDescriptor.FontFile3.read_bytes())
        before = TTFont(io.BytesIO(program))
        after = TTFont(io.BytesIO(saved))
        names = after.getGlyphOrder()
        assert not {"Z", "X", "J"} & set(names)
        glyphs_before, glyphs_after = before.getGlyphSet(), after.getGlyphSet()
        for ch in set(KEPT) | set("Quiz"):
            gid = gids[ch]
            assert names[gid] == before.getGlyphOrder()[gid]
            assert _outline(glyphs_after, names[gid]) == _outline(glyphs_before, names[gid])
        for ch in "ZXJ":
            gid = gids[ch]
            assert names[gid] == f"gid{gid:05d}"
            assert _outline(glyphs_after, names[gid]) == []


class TestEmbeddedCMap:
    """A Type0 font whose /Encoding is an embedded CMap: the CMap names every
    code it maps, so it keeps only the survivors' (§9.7.5.3)."""

    def test_the_cmap_keeps_only_the_codes_the_survivors_draw(self, tmp_dir):
        text = KEPT + SECRET
        program = _cut(SANS, text)
        tt = TTFont(io.BytesIO(program))
        order = tt.getGlyphOrder()
        cids = {ch: order.index(tt.getBestCmap()[ord(ch)]) for ch in sorted(set(text))}
        doc = pikepdf.new()
        stream = doc.make_stream(program)
        font = _type0(doc, "/CIDFontType2", "/FontFile2", stream, cids, Name("/Identity"))
        body = b"\n".join(
            [
                b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
                b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def",
                b"/CMapName /Test-Embedded def /CMapType 1 def",
                b"1 begincodespacerange <00> <FF> endcodespacerange",
                b"%d begincidchar" % len(cids),
                *[b"<%02X> %d" % (ord(ch), cid) for ch, cid in sorted(cids.items())],
                b"endcidchar endcmap CMapName currentdict /CMap defineresource pop end end",
            ]
        )
        cmap = doc.make_stream(body)
        cmap["/Type"] = Name("/CMap")
        cmap["/CMapName"] = Name("/Test-Embedded")
        cmap["/CIDSystemInfo"] = Dictionary(
            Registry=String("Adobe"), Ordering=String("Identity"), Supplement=0
        )
        font["/Encoding"] = cmap
        font["/ToUnicode"] = _tounicode(doc, [(bytes([ord(ch)]), ch) for ch in sorted(cids)])
        page = doc.add_blank_page(page_size=PAGE)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(
            _line("F1", 10, KEPT.encode()) + _line("F1", 200, SECRET.encode())
        )
        src, out = _redact(tmp_dir, doc)
        pdf, saved = _font(out)
        with pdf:
            text = bytes(saved.Encoding.read_bytes())
            kid = saved.DescendantFonts[0]
            names = TTFont(io.BytesIO(bytes(kid.FontDescriptor.FontFile2.read_bytes()))).getGlyphOrder()
        blocks = b"".join(re.findall(rb"begincidchar(.*?)endcidchar", text, re.S))
        mapped = {bytes.fromhex(code.decode()): int(cid) for code, cid in re.findall(rb"<([0-9A-Fa-f]+)>\s+(\d+)", blocks)}
        assert b"cidrange" not in text and b"notdef" not in text
        assert mapped == {ch.encode(): cids[ch] for ch in KEPT}
        assert not {"Q", "Z", "X", "J"} & set(names)
        pdf, saved = _font(out)
        with pdf:
            assert _tounicode_map(saved) == {ord(ch): ch for ch in KEPT}

    def test_a_cmap_built_on_identity_is_rewritten_on_its_own(self, tmp_dir):
        # The CMap states no codespace; it reads two-byte codes through
        # Identity-H, which its /UseCMap entry names.
        text = KEPT + SECRET
        program = _cut(SANS, text)
        tt = TTFont(io.BytesIO(program))
        order = tt.getGlyphOrder()
        cids = {ch: order.index(tt.getBestCmap()[ord(ch)]) for ch in sorted(set(text))}
        doc = pikepdf.new()
        font = _type0(doc, "/CIDFontType2", "/FontFile2", doc.make_stream(program), cids, Name("/Identity"))
        cmap = doc.make_stream(
            b"\n".join(
                [
                    b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
                    b"/CMapName /Test-Built-On def /CMapType 1 def",
                    b"%d begincidchar" % len(cids),
                    *[b"<%04X> %d" % (ord(ch), cid) for ch, cid in sorted(cids.items())],
                    b"endcidchar endcmap CMapName currentdict /CMap defineresource pop end end",
                ]
            )
        )
        cmap["/Type"] = Name("/CMap")
        cmap["/UseCMap"] = Name("/Identity-H")
        font["/Encoding"] = cmap
        font["/ToUnicode"] = _tounicode(doc, [(ord(ch).to_bytes(2, "big"), ch) for ch in sorted(cids)])
        page = doc.add_blank_page(page_size=PAGE)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        codes = {ch: ord(ch) for ch in cids}
        page.Contents = doc.make_stream(
            _line("F1", 10, _show_cids(codes, KEPT)) + _line("F1", 200, _show_cids(codes, SECRET))
        )
        _src, out = _redact(tmp_dir, doc)
        pdf, saved = _font(out)
        with pdf:
            assert "/UseCMap" not in saved.Encoding
            body = bytes(saved.Encoding.read_bytes())
            data = bytes(saved.DescendantFonts[0].FontDescriptor.FontFile2.read_bytes())
        assert b"<0000> <FFFF>" in body
        blocks = b"".join(re.findall(rb"begincidchar(.*?)endcidchar", body, re.S))
        mapped = {int(code, 16) for code, _cid in re.findall(rb"<([0-9A-Fa-f]+)>\s+(\d+)", blocks)}
        assert mapped == {ord(ch) for ch in KEPT}
        assert not set(SECRET) & set(TTFont(io.BytesIO(data)).getGlyphOrder())

    def test_a_code_readers_split_apart_keeps_every_glyph_they_draw(self, tmp_dir):
        # 0x81 0x32 starts a two-byte range and ends outside it. By §9.7.6.3
        # it is one invalid code; a reader that falls back to one byte draws
        # 0x81 and then "2", so the glyph for "2" survives the cut.
        text = "A2BQZ"
        program = _cut(SANS, text)
        tt = TTFont(io.BytesIO(program))
        order = tt.getGlyphOrder()
        cids = {ch: order.index(tt.getBestCmap()[ord(ch)]) for ch in text}
        doc = pikepdf.new()
        font = _type0(doc, "/CIDFontType2", "/FontFile2", doc.make_stream(program), cids, Name("/Identity"))
        cmap = doc.make_stream(
            b"\n".join(
                [
                    b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
                    b"/CMapName /Test-Embedded def /CMapType 1 def",
                    b"2 begincodespacerange <20> <7E> <8140> <9FFC> endcodespacerange",
                    b"%d begincidchar" % len(cids),
                    *[b"<%02X> %d" % (ord(ch), cid) for ch, cid in sorted(cids.items())],
                    b"endcidchar endcmap CMapName currentdict /CMap defineresource pop end end",
                ]
            )
        )
        cmap["/Type"] = Name("/CMap")
        font["/Encoding"] = cmap
        font["/ToUnicode"] = _tounicode(doc, [(bytes([ord(ch)]), ch) for ch in sorted(cids)])
        page = doc.add_blank_page(page_size=PAGE)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(_line("F1", 10, b"A\x812B") + _line("F1", 200, b"QZ"))
        _src, out = _redact(tmp_dir, doc)
        pdf, saved = _font(out)
        with pdf:
            data = bytes(saved.DescendantFonts[0].FontDescriptor.FontFile2.read_bytes())
        names = set(TTFont(io.BytesIO(data)).getGlyphOrder())
        assert {"A", "B", "two"} <= names
        assert not {"Q", "Z"} & names


class TestVerticalMetrics:
    def test_w2_keeps_only_the_survivors(self, tmp_dir):
        text = KEPT + SECRET
        program = _cut(SANS, text)
        tt = TTFont(io.BytesIO(program))
        order = tt.getGlyphOrder()
        cids = {ch: order.index(tt.getBestCmap()[ord(ch)]) for ch in sorted(set(text))}
        doc = pikepdf.new()
        font = _type0(doc, "/CIDFontType2", "/FontFile2", doc.make_stream(program), cids, Name("/Identity"))
        font["/Encoding"] = Name("/Identity-V")
        kid = font.DescendantFonts[0]
        low, high = min(cids.values()), max(cids.values())
        kid["/W2"] = Array([low, high, -1000, 250, 880])
        page = doc.add_blank_page(page_size=PAGE)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(
            b"BT /F1 12 Tf 10 90 Td <%s> Tj ET\n" % _show_cids(cids, KEPT).hex().encode()
            + b"BT /F1 12 Tf 250 66 Td <%s> Tj ET\n" % _show_cids(cids, SECRET).hex().encode()
        )
        _src, out = _redact(tmp_dir, doc, rect=[200, 0, 300, 70])
        pdf, saved = _font(out)
        with pdf:
            w2 = list(saved.DescendantFonts[0].W2)
        covered = set()
        for index in range(0, len(w2), 5):
            covered |= set(range(int(w2[index]), int(w2[index + 1]) + 1))
            assert [float(v) for v in w2[index + 2 : index + 5]] == [-1000, 250, 880]
        assert covered == {cids[ch] for ch in KEPT}


class TestTheScanReadsEachStreamOnce:
    """The scan after the page walk reads again only the content the walk
    changed: a stream it left alone is read from the scan before it."""

    def test_content_written_over_in_place_is_read_again(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        src = _save(doc, os.path.join(tmp_dir, "in.pdf"))
        with pikepdf.open(src) as pdf:
            before = redact_fonts.baseline(pdf, [pdf.pages[0]])
            contents = pdf.pages[0].Contents
            assert contents.get("/Filter") == Name("/FlateDecode")
            # Same object, same filter: only the bytes change.
            contents.write(zlib.compress(_line("F1", 10, KEPT.encode())), filter=Name("/FlateDecode"))
            redact_fonts.prune(pdf, before)
            data = bytes(pdf.pages[0].Resources.Font.F1.FontDescriptor.FontFile2.read_bytes())
        assert {chr(point) for point in TTFont(io.BytesIO(data)).getBestCmap()} == set(KEPT)

    def test_past_the_kept_bound_the_content_is_read_again(self, tmp_dir, monkeypatch):
        monkeypatch.setattr(redact_fonts, "MAX_KEPT_OPERATORS", 0)
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)], [(10, "Quiz")]])
        src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT) | set("Quiz")
        with pikepdf.open(src) as pdf:
            assert redact_fonts.baseline(pdf, [pdf.pages[0]]).contents == {}


class TestIdentityOfAFont:
    def test_a_font_held_directly_in_the_resources_is_cut(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        font = doc.pages[0].Resources.Font.F1
        direct = Dictionary({key: font[key] for key in font.keys()})
        doc.pages[0].Resources = Dictionary(Font=Dictionary(F1=direct))
        _src, out = _redact(tmp_dir, doc)
        assert _truetype_chars(out) == set(KEPT)

    def test_names_that_are_not_utf8_are_read_byte_for_byte(self, tmp_dir):
        # §7.3.5: a name is a byte sequence, and a byte sequence need not be
        # UTF-8. The font is held directly under such a name and draws by it.
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        font = doc.pages[0].Resources.Font.F1
        direct = Dictionary({key: font[key] for key in font.keys()})
        direct["/BaseFont"] = pikepdf.Object.parse(b"/ABCDEF+Liberation#C3Sans")
        fonts = Dictionary()
        fonts[pikepdf.Object.parse(b"/F#C3")] = direct
        doc.pages[0].Resources = Dictionary(Font=fonts)
        doc.pages[0].Contents = doc.make_stream(
            bytes(doc.pages[0].Contents.read_bytes()).replace(b"/F1 ", b"/F#C3 ")
        )
        _src, out = _redact(tmp_dir, doc)
        with pikepdf.open(out) as pdf:
            (saved,) = list(pdf.pages[0].Resources.Font.values())
            data = bytes(saved.FontDescriptor.FontFile2.read_bytes())
            assert bytes(saved.BaseFont) == b"/ABCDEF+Liberation\xc3Sans"
        assert {chr(point) for point in TTFont(io.BytesIO(data)).getBestCmap()} == set(KEPT)

    def test_a_font_left_listed_with_nothing_drawing_it_keeps_no_glyph(self, tmp_dir):
        doc, _program = _truetype_doc([[(200, SECRET)]])
        font = doc.pages[0].Resources.Font.F1
        doc.Root.AcroForm = Dictionary(Fields=Array([]), DR=Dictionary(Font=Dictionary(F1=font)))
        _src, out = _redact(tmp_dir, doc)
        with pikepdf.open(out) as pdf:
            listed = pdf.Root.AcroForm.DR.Font.F1
            data = bytes(listed.FontDescriptor.FontFile2.read_bytes())
            widths = [float(w) for w in listed.Widths]
            span = (int(listed.FirstChar), int(listed.LastChar))
        assert TTFont(io.BytesIO(data)).getGlyphOrder() == [".notdef"]
        assert widths == [0] and span == (0, 0)


class TestSymbolicTrueType:
    """A symbolic TrueType font draws through its (3, 0) subtable at 0xF000 +
    code, or its (1, 0) subtable at the code (§9.6.5.4). Both survive the cut,
    and both still take every surviving code to its glyph."""

    def _doc(self):
        from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

        text = KEPT + SECRET + "Quiz"
        tt = TTFont(io.BytesIO(_cut(SANS, text)))
        glyph_of = tt.getBestCmap()
        symbol = CmapSubtable.newSubtable(4)
        symbol.platformID, symbol.platEncID, symbol.language = 3, 0, 0
        symbol.cmap = {0xF000 | ord(ch): glyph_of[ord(ch)] for ch in text}
        roman = CmapSubtable.newSubtable(0)
        roman.platformID, roman.platEncID, roman.language = 1, 0, 0
        roman.cmap = {ord(ch): glyph_of[ord(ch)] for ch in text}
        tt["cmap"].tables = [roman, symbol]
        buffer = io.BytesIO()
        tt.save(buffer)
        program = buffer.getvalue()
        doc = pikepdf.new()
        desc = Dictionary(
            Type=Name("/FontDescriptor"), FontName=Name("/ABCDEF+Symbolic"), Flags=4,
            FontBBox=Array([-200, -300, 1200, 1000]), ItalicAngle=0, Ascent=900,
            Descent=-200, CapHeight=700, StemV=80, FontFile2=doc.make_stream(program),
        )
        font = doc.make_indirect(
            Dictionary(
                Type=Name("/Font"), Subtype=Name("/TrueType"), BaseFont=Name("/ABCDEF+Symbolic"),
                FirstChar=32, LastChar=126, Widths=Array([550] * 95), FontDescriptor=desc,
            )
        )
        for lines in ([(10, KEPT), (200, SECRET)], [(10, "Quiz")]):
            page = doc.add_blank_page(page_size=PAGE)
            page.Resources = Dictionary(Font=Dictionary(F1=font))
            page.Contents = doc.make_stream(
                b"".join(_line("F1", x, t.encode("latin-1")) for x, t in lines)
            )
        return doc

    def _drawn(self, path, chars):
        pdf, font = _font(path)
        with pdf:
            tt = TTFont(io.BytesIO(bytes(font.FontDescriptor.FontFile2.read_bytes())))
        tables = {(t.platformID, t.platEncID): t.cmap for t in tt["cmap"].tables}
        glyphs = tt.getGlyphSet()
        return {
            ch: (
                _outline(glyphs, tables[(3, 0)][0xF000 | ord(ch)]),
                _outline(glyphs, tables[(1, 0)][ord(ch)]),
            )
            for ch in chars
        }, tables

    def test_both_subtables_survive_and_draw_every_survivor_as_before(self, tmp_dir):
        src, out = _redact(tmp_dir, self._doc())
        survivors = set(KEPT) | set("Quiz")
        after, tables = self._drawn(out, survivors)
        before, _ = self._drawn(src, survivors)
        assert after == before
        assert {code & 0xFF for code in tables[(3, 0)]} == {ord(ch) for ch in survivors}
        assert set(tables[(1, 0)]) == {ord(ch) for ch in survivors}


class TestTrueTypeWithoutACmap:
    """A simple TrueType font with no cmap draws glyph id = code: the ids
    stay, and a glyph not kept is emptied and renamed like every other."""

    def test_removed_glyphs_are_emptied_in_place_and_renamed(self, tmp_dir):
        full = TTFont(SANS, lazy=True)
        order = full.getGlyphOrder()
        cmap = full.getBestCmap()
        wanted = sorted({order.index(cmap[ord(ch)]) for ch in KEPT + SECRET})
        base = TTFont(io.BytesIO(_cut(SANS, gids=[0] + wanted)))
        base_order = base.getGlyphOrder()
        base_cmap = base.getBestCmap()
        code_of = {ch: base_order.index(base_cmap[ord(ch)]) for ch in KEPT + SECRET}
        del base["cmap"]
        buffer = io.BytesIO()
        base.save(buffer)
        program = buffer.getvalue()
        doc = pikepdf.new()
        desc = Dictionary(
            Type=Name("/FontDescriptor"), FontName=Name("/ABCDEF+NoCmap"), Flags=4,
            FontBBox=Array([-200, -300, 1200, 1000]), ItalicAngle=0, Ascent=900,
            Descent=-200, CapHeight=700, StemV=80, FontFile2=doc.make_stream(program),
        )
        font = doc.make_indirect(
            Dictionary(
                Type=Name("/Font"), Subtype=Name("/TrueType"), BaseFont=Name("/ABCDEF+NoCmap"),
                FirstChar=0, LastChar=63, Widths=Array([600] * 64), FontDescriptor=desc,
            )
        )
        page = doc.add_blank_page(page_size=PAGE)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(
            _line("F1", 10, bytes(code_of[ch] for ch in KEPT))
            + _line("F1", 200, bytes(code_of[ch] for ch in SECRET))
        )
        _src, out = _redact(tmp_dir, doc)
        pdf, saved = _font(out)
        with pdf:
            data = bytes(saved.FontDescriptor.FontFile2.read_bytes())
        before, after = TTFont(io.BytesIO(program)), TTFont(io.BytesIO(data))
        names = after.getGlyphOrder()
        for ch in KEPT:
            gid = code_of[ch]
            assert names[gid] == ch
            assert _outline(after.getGlyphSet(), ch) == _outline(before.getGlyphSet(), ch)
        for ch in SECRET:
            gid = code_of[ch]
            assert gid >= len(names) or (
                names[gid] == f"gid{gid:05d}" and _outline(after.getGlyphSet(), names[gid]) == []
            )
        assert not set(SECRET) & set(names)


# ── refusals ──────────────────────────────────────────────────────────────


def _garbage_truetype_doc(data: bytes):
    doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
    font = doc.pages[0].Resources.Font.F1
    font.FontDescriptor.FontFile2.write(data)
    return doc


class TestRefusals:
    """A font the redaction cannot cut stops it, by name, before anything is
    written: no output appears, and a redaction in place leaves the input's
    bytes as they were."""

    def _refused(self, tmp_dir, doc, expected: str):
        src = _save(doc, os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError) as caught:
            redact(src, out, [{"page": 1, "rect": MARK}])
        assert str(caught.value) == expected
        assert not os.path.exists(out)
        before = open(src, "rb").read()
        with pytest.raises(ValueError):
            redact(src, src, [{"page": 1, "rect": MARK}])
        assert open(src, "rb").read() == before

    def test_an_unreadable_program(self, tmp_dir):
        self._refused(
            tmp_dir,
            _garbage_truetype_doc(b"\x00\x01\x00\x00" + b"\x00" * 64),
            "The redacted characters cannot be removed from the font "
            "ABCDEF+LiberationSans (its font program cannot be read).",
        )

    def test_a_font_named_by_bytes_that_are_not_utf8(self, tmp_dir):
        doc = _garbage_truetype_doc(b"\x00\x01\x00\x00" + b"\x00" * 64)
        font = doc.pages[0].Resources.Font.F1
        font["/BaseFont"] = pikepdf.Object.parse(b"/ABCDEF+Liberation#C3Sans")
        self._refused(
            tmp_dir,
            doc,
            "The redacted characters cannot be removed from the font "
            "ABCDEF+Liberation?Sans (its font program cannot be read).",
        )

    def test_a_font_collection(self, tmp_dir):
        self._refused(
            tmp_dir,
            _garbage_truetype_doc(b"ttcf" + b"\x00" * 64),
            "The redacted characters cannot be removed from the font "
            "ABCDEF+LiberationSans (its font program is a font collection).",
        )

    def test_a_program_in_no_form_this_redaction_cuts(self, tmp_dir):
        self._refused(
            tmp_dir,
            _garbage_truetype_doc(b"%PDF-not-a-font"),
            "The redacted characters cannot be removed from the font "
            "ABCDEF+LiberationSans (its font program is in a form this redaction cannot cut).",
        )

    def test_a_program_past_the_size_bound(self, tmp_dir, monkeypatch):
        monkeypatch.setattr(redact_fonts, "MAX_FONT_PROGRAM_BYTES", 64)
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        self._refused(
            tmp_dir,
            doc,
            "The redacted characters cannot be removed from the font "
            "ABCDEF+LiberationSans (its font program is larger than 64 bytes).",
        )

    def test_an_unreadable_tounicode_map(self, tmp_dir):
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]], tounicode=True)
        doc.pages[0].Resources.Font.F1.ToUnicode.write(b"not a zlib stream", filter=Name("/FlateDecode"))
        self._refused(
            tmp_dir,
            doc,
            "The redacted characters cannot be removed from the font "
            "ABCDEF+LiberationSans (its ToUnicode map cannot be read).",
        )

    def test_a_tounicode_map_whose_code_widths_share_values(self, tmp_dir):
        # <41> and <0041> are two codes with one value.
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]], tounicode=True)
        stream = doc.pages[0].Resources.Font.F1.ToUnicode
        stream.write(
            bytes(stream.read_bytes()).replace(
                b"1 begincodespacerange <00> <FF>", b"2 begincodespacerange <00> <FF> <0000> <00FF>"
            )
        )
        self._refused(
            tmp_dir,
            doc,
            "The redacted characters cannot be removed from the font "
            "ABCDEF+LiberationSans (its ToUnicode map cannot be read).",
        )

    def test_a_character_map_this_reader_does_not_hold(self, tmp_dir):
        text = KEPT + SECRET
        program = _cut(SANS, text)
        tt = TTFont(io.BytesIO(program))
        order = tt.getGlyphOrder()
        cids = {ch: order.index(tt.getBestCmap()[ord(ch)]) for ch in sorted(set(text))}
        doc = pikepdf.new()
        stream = doc.make_stream(program)
        font = _type0(doc, "/CIDFontType2", "/FontFile2", stream, cids, Name("/Identity"))
        font["/Encoding"] = Name("/Unknown-Encoding-H")
        _composite_pages(doc, font, cids, [[(10, KEPT), (200, SECRET)]])
        self._refused(
            tmp_dir,
            doc,
            "The redacted characters cannot be removed from the font "
            "ABCDEF+Composite (its character map cannot be read).",
        )

    def test_a_type3_encoding_this_pass_does_not_hold(self, tmp_dir):
        # `p` survives and is not in /Differences, so its glyph name comes from
        # a base encoding this pass holds no table for.
        doc = _type3_doc([[(10, KEPT), (200, SECRET)]])
        font = doc.pages[0].Resources.Font.F1
        font.Encoding["/BaseEncoding"] = Name("/MacExpertEncoding")
        font.Encoding["/Differences"] = Array(
            [item for item in font.Encoding.Differences if item != Name("/p") and item != ord("p")]
        )
        font["/Name"] = Name("/RdxType3")
        self._refused(
            tmp_dir,
            doc,
            "The redacted characters cannot be removed from the font "
            "RdxType3 (its encoding cannot be read).",
        )

    def test_a_type1_subroutine_call_that_cannot_be_traced(self, tmp_dir, monkeypatch):
        glyphs = dict(_T1_GLYPHS)
        glyphs["p"] = _t1(0, 550, "hsbw", *_box(450, 500), 0, 0, 12, "callothersubr", "endchar")
        monkeypatch.setattr(__import__(__name__), "_T1_GLYPHS", glyphs)
        doc, _program = _type1_doc([[(10, KEPT), (200, SECRET)]])
        self._refused(
            tmp_dir,
            doc,
            "The redacted characters cannot be removed from the font "
            "ABCDEF+RdxType1 (its Type 1 subroutine calls cannot be traced).",
        )

    def test_content_that_cannot_be_read_where_the_font_is_in_reach(self, tmp_dir, monkeypatch):
        original = pikepdf.parse_content_stream

        def parse(stream, operators=""):
            if operators:
                raise pikepdf.PdfError("unreadable content")
            return original(stream)

        monkeypatch.setattr(redact_fonts.pikepdf, "parse_content_stream", parse)
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        self._refused(
            tmp_dir,
            doc,
            "The redacted characters cannot be removed from the font "
            "ABCDEF+LiberationSans (content that cannot be read may draw with it).",
        )

    def test_a_scan_past_the_operator_bound(self, tmp_dir, monkeypatch):
        monkeypatch.setattr(redact_fonts, "MAX_SCAN_OPERATORS", 3)
        doc, _program = _truetype_doc([[(10, KEPT), (200, SECRET)]])
        self._refused(
            tmp_dir,
            doc,
            "The redacted characters cannot be removed from the font "
            "ABCDEF+LiberationSans (the document holds more than 3 content operators to check).",
        )


# ── as pixels ─────────────────────────────────────────────────────────────


def _render(gs_path: str, source: str, target: str, page: int) -> None:
    subprocess.run(
        [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=pnggray", "-r144",
         f"-dFirstPage={page}", f"-dLastPage={page}", "-o", target, source],
        check=True, stdin=subprocess.DEVNULL, capture_output=True,
    )


@pytest.mark.parametrize("kind", ["truetype", "type1c", "type1", "cidtype2"])
def test_surviving_text_renders_pixel_for_pixel(kind, tmp_dir, gs_path):
    """The page no mark reached renders the same pixels from the cut font, and
    so does the kept word on the marked page."""
    pages = [[(10, KEPT), (200, SECRET)], [(10, "Quiz lucid")]]
    if kind == "truetype":
        doc, _p = _truetype_doc(pages)
    elif kind == "type1c":
        doc, _p = _type1c_doc(pages)
    elif kind == "type1":
        doc, _p = _type1_doc([[(10, KEPT), (200, SECRET)], [(10, "Z publicZ")]])
    else:
        doc, _p, _cids = TestCIDFontType2()._doc(pages)
    src, out = _redact(tmp_dir, doc, name=kind)
    from PIL import Image

    for page, box in ((2, None), (1, (0, 0, 380, 200))):
        a = os.path.join(tmp_dir, f"{kind}_{page}_in.png")
        b = os.path.join(tmp_dir, f"{kind}_{page}_out.png")
        _render(gs_path, src, a, page)
        _render(gs_path, out, b, page)
        with Image.open(a) as left, Image.open(b) as right:
            if box is not None:
                left, right = left.crop(box), right.crop(box)
            assert left.tobytes() == right.tobytes(), (kind, page)
