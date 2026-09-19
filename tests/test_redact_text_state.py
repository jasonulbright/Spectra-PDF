"""The redaction walker measures text with the font the text state holds.

A redaction removes the glyphs its mark covers, so it has to place every glyph
where a reader draws it, and that takes the font a reader draws with. The text
state holds a font DICTIONARY (ISO 32000-2 §9.3.1): the one `Tf` names in the
stream's resources, or the one an ExtGState /Font entry sets with `gs`
(Table 57); and a form XObject inherits that dictionary from the stream that
invokes it (§8.10.1), whatever its own resources call by the same name. A
composite font's codes are read through its CMap's codespace ranges
(§9.7.6.2), and word spacing applies to every single-byte code 32 (§9.3.3).

Every case draws "PUBLIC SECRET WORDS" from x = 60 at 12 pt with advances of
0.6 em, so character k spans [60 + 7.2k, 67.2 + 7.2k]. The mark covers only
"SECRET". On the saved bytes, the run is re-shown as "PUBLIC " and " WORDS"
with one TJ number standing for exactly the advance "SECRET" had: nothing under
the mark is drawn, and every glyph outside it stays where it was.
"""

from __future__ import annotations

import os
import subprocess

import numpy as np
import pikepdf
from pikepdf import Array, Dictionary, Name, String

from engine.redact import redact

TEXT = b"PUBLIC SECRET WORDS"
SIZE = 12
ADVANCE = 600
# Characters 7..12 ("SECRET") span x = 110.4 .. 153.6.
MARK = [111, 290, 153, 320]
SURVIVORS = [[b"PUBLIC ", -6.0 * ADVANCE, b" WORDS"]]
PAGE = (400, 400)


def _simple_font(doc, width: int, name: str):
    return doc.make_indirect(
        Dictionary(
            Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/" + name),
            FirstChar=32, LastChar=126, Widths=Array([width] * 95),
            Encoding=Name.WinAnsiEncoding,
        )
    )


def _one_byte_cmap_font(doc):
    """A Type0 font whose embedded CMap reads one byte per code: codes 32 to
    126 select CIDs 32 to 126, each 0.6 em wide."""
    program = b"\n".join(
        [
            b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
            b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def",
            b"/CMapName /OneByte def /CMapType 1 def",
            b"1 begincodespacerange <00> <FF> endcodespacerange",
            b"1 begincidrange <20> <7E> 32 endcidrange",
            b"endcmap CMapName currentdict /CMap defineresource pop end end",
        ]
    )
    cmap = doc.make_stream(program)
    cmap["/Type"] = Name.CMap
    cmap["/CMapName"] = Name("/OneByte")
    info = Dictionary(Registry=String("Adobe"), Ordering=String("Identity"), Supplement=0)
    cmap["/CIDSystemInfo"] = info
    descriptor = Dictionary(
        Type=Name.FontDescriptor, FontName=Name("/OneByte"), Flags=32,
        FontBBox=Array([0, -200, 600, 800]), ItalicAngle=0, Ascent=800, Descent=-200,
        CapHeight=700, StemV=80,
    )
    kid = Dictionary(
        Type=Name.Font, Subtype=Name.CIDFontType2, BaseFont=Name("/OneByte"),
        CIDSystemInfo=info, FontDescriptor=descriptor, DW=ADVANCE, CIDToGIDMap=Name.Identity,
    )
    return doc.make_indirect(
        Dictionary(
            Type=Name.Font, Subtype=Name.Type0, BaseFont=Name("/OneByte"),
            Encoding=cmap, DescendantFonts=Array([doc.make_indirect(kid)]),
        )
    )


def _save(doc, directory: str, name: str) -> str:
    path = os.path.join(directory, f"{name}.pdf")
    doc.save(path)
    doc.close()
    return path


def _redacted(directory: str, doc, name: str, mark=None) -> tuple[str, str]:
    src = _save(doc, directory, name)
    out = os.path.join(directory, f"{name}_out.pdf")
    redact(src, out, [{"page": 1, "rect": mark or MARK}])
    return src, out


def _shows(path: str) -> list:
    """Every show operator the saved first page draws, page and forms alike,
    as its strings and TJ numbers."""
    out: list = []
    with pikepdf.open(path) as pdf:
        page = pdf.pages[0]

        def walk(stream, resources, depth):
            for ins in pikepdf.parse_content_stream(stream):
                op = str(ins.operator)
                if op in ("Tj", "'", '"'):
                    out.append([bytes(ins.operands[-1])])
                elif op == "TJ":
                    out.append(
                        [
                            bytes(item) if isinstance(item, pikepdf.String) else float(item)
                            for item in ins.operands[0]
                        ]
                    )
                elif op == "Do" and depth < 8:
                    xobject = resources.get("/XObject", Dictionary()).get(ins.operands[0])
                    if isinstance(xobject, pikepdf.Stream) and xobject.get("/Subtype") == Name.Form:
                        walk(xobject, xobject.get("/Resources", resources), depth + 1)

        walk(page.obj, page.Resources, 0)
    return out


def _drawn(shows: list) -> bytes:
    return b"".join(part for show in shows for part in show if isinstance(part, bytes))


def _render(gs_path: str, path: str):
    """The first page at 72 dpi, one device pixel per point, no smoothing."""
    from PIL import Image

    target = path + ".png"
    subprocess.run(
        [gs_path, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pnggray", "-r72",
         "-dTextAlphaBits=1", "-dGraphicsAlphaBits=1", f"-sOutputFile={target}", path],
        check=True, stdin=subprocess.DEVNULL, capture_output=True,
    )
    with Image.open(target) as image:
        return np.asarray(image.convert("L")).astype(int)


def _outside_the_mark_is_unchanged(gs_path: str, src: str, out: str) -> None:
    before, after = _render(gs_path, src), _render(gs_path, out)
    height = before.shape[0]
    rows = slice(height - 320, height - 280)
    # The kept words: x 60 .. 110 and 154 .. 200, clear of the mark by a pixel.
    for columns in (slice(56, 110), slice(154, 204)):
        assert (before[rows, columns] < 128).any(), "the fixture drew nothing there"
        assert np.array_equal(before[rows, columns], after[rows, columns])


def _page(doc, resources, content: bytes):
    page = doc.add_blank_page(page_size=PAGE)
    page.Resources = resources
    page.Contents = doc.make_stream(content)
    return page


# ── the font an ExtGState sets ────────────────────────────────────────────


def _gs_font_doc(before: bytes = b""):
    doc = pikepdf.new()
    wide = _simple_font(doc, ADVANCE, "Wide")
    _page(
        doc,
        Dictionary(
            Font=Dictionary(F2=_simple_font(doc, ADVANCE, "Other")),
            ExtGState=Dictionary(GS1=Dictionary(Type=Name.ExtGState, Font=Array([wide, SIZE]))),
        ),
        b"BT " + before + b"/GS1 gs 60 300 Td (" + TEXT + b") Tj ET",
    )
    return doc


class TestTheFontAnExtGStateSets:
    def test_with_no_tf_only_the_marked_glyphs_go(self, tmp_dir):
        _src, out = _redacted(tmp_dir, _gs_font_doc(), "gs")
        assert _shows(out) == SURVIVORS

    def test_after_a_tf_of_another_font_and_size_the_gs_font_measures(self, tmp_dir):
        _src, out = _redacted(tmp_dir, _gs_font_doc(b"/F2 1 Tf "), "gs_after_tf")
        assert _shows(out) == SURVIVORS

    def test_a_gs_font_inside_q_q_is_gone_after_q(self, tmp_dir):
        # The ExtGState font is 50/1000 em wide; Tf's font, which Q restores,
        # draws the run.
        doc = pikepdf.new()
        narrow = _simple_font(doc, 50, "Narrow")
        _page(
            doc,
            Dictionary(
                Font=Dictionary(F1=_simple_font(doc, ADVANCE, "Wide")),
                ExtGState=Dictionary(GS1=Dictionary(Type=Name.ExtGState, Font=Array([narrow, SIZE]))),
            ),
            b"BT /F1 12 Tf ET q /GS1 gs Q BT 60 300 Td (" + TEXT + b") Tj ET",
        )
        _src, out = _redacted(tmp_dir, doc, "gs_in_q")
        assert _shows(out) == SURVIVORS

    def test_the_text_outside_the_mark_draws_as_before(self, tmp_dir, gs_path):
        src, out = _redacted(tmp_dir, _gs_font_doc(), "gs_pixels")
        _outside_the_mark_is_unchanged(gs_path, src, out)

    def test_the_gs_font_s_own_ink_extent_bounds_the_run(self, tmp_dir):
        # The font's ink rises 0.7 em, to y = 308.4 at 12 pt. A mark from
        # y = 309 misses it; a font assumed at 1 em would reach 312.
        doc = pikepdf.new()
        inked = _simple_font(doc, ADVANCE, "Inked")
        inked["/FontDescriptor"] = Dictionary(
            Type=Name.FontDescriptor, FontName=Name("/Inked"), Flags=32,
            FontBBox=Array([0, -200, 600, 700]), ItalicAngle=0, Ascent=700, Descent=-200,
            CapHeight=700, StemV=80,
        )
        _page(
            doc,
            Dictionary(ExtGState=Dictionary(GS1=Dictionary(Type=Name.ExtGState, Font=Array([inked, SIZE])))),
            b"BT /GS1 gs 60 300 Td (" + TEXT + b") Tj ET",
        )
        _src, out = _redacted(tmp_dir, doc, "gs_ink", mark=[60, 309, 200, 330])
        assert _shows(out) == [[TEXT]]


# ── names that are not UTF-8 ──────────────────────────────────────────────


class TestNamesThatAreNotUtf8:
    """§7.3.5: a name is a byte sequence, and a byte sequence need not be
    UTF-8. The walker reads such names as the bytes they are."""

    def test_a_font_resource_under_such_a_name_measures(self, tmp_dir):
        doc = pikepdf.new()
        fonts = Dictionary()
        fonts[pikepdf.Object.parse(b"/F#C3")] = _simple_font(doc, ADVANCE, "Wide")
        _page(doc, Dictionary(Font=fonts), b"BT /F#C3 12 Tf 60 300 Td (" + TEXT + b") Tj ET")
        _src, out = _redacted(tmp_dir, doc, "name_font")
        assert _shows(out) == SURVIVORS

    def test_a_colour_space_under_such_a_name_does_not_stop_the_walk(self, tmp_dir):
        doc = pikepdf.new()
        spaces = Dictionary()
        spaces[pikepdf.Object.parse(b"/CS#C3")] = Name.DeviceRGB
        _page(
            doc,
            Dictionary(Font=Dictionary(F1=_simple_font(doc, ADVANCE, "Wide")), ColorSpace=spaces),
            b"/CS#C3 cs 0 0 1 scn BT /F1 12 Tf 60 300 Td (" + TEXT + b") Tj ET",
        )
        _src, out = _redacted(tmp_dir, doc, "name_colour")
        assert _shows(out) == SURVIVORS


# ── the font a form inherits ──────────────────────────────────────────────


def _form_doc():
    """The page selects a 0.6 em font as F1 and draws a form whose own
    resources name a 0.05 em font F1; the form's text has no Tf."""
    doc = pikepdf.new()
    form = doc.make_stream(b"BT 60 300 Td (" + TEXT + b") Tj ET")
    form["/Type"] = Name.XObject
    form["/Subtype"] = Name.Form
    form["/BBox"] = Array([0, 0, 400, 400])
    form["/Resources"] = Dictionary(Font=Dictionary(F1=_simple_font(doc, 50, "Narrow")))
    _page(
        doc,
        Dictionary(
            Font=Dictionary(F1=_simple_font(doc, ADVANCE, "Wide")),
            XObject=Dictionary(Fm0=doc.make_indirect(form)),
        ),
        b"BT /F1 12 Tf ET /Fm0 Do",
    )
    return doc


class TestTheFontAFormInherits:
    def test_the_inherited_dictionary_measures_not_the_name(self, tmp_dir):
        _src, out = _redacted(tmp_dir, _form_doc(), "form")
        assert _shows(out) == SURVIVORS

    def test_the_text_outside_the_mark_draws_as_before(self, tmp_dir, gs_path):
        src, out = _redacted(tmp_dir, _form_doc(), "form_pixels")
        _outside_the_mark_is_unchanged(gs_path, src, out)


# ── codes through the CMap's own codespace ────────────────────────────────


class TestAnEmbeddedCMap:
    def test_one_byte_codes_are_read_as_one_byte_codes(self, tmp_dir):
        doc = pikepdf.new()
        _page(
            doc,
            Dictionary(Font=Dictionary(F1=_one_byte_cmap_font(doc))),
            b"BT /F1 12 Tf 60 300 Td (" + TEXT + b") Tj ET",
        )
        _src, out = _redacted(tmp_dir, doc, "cmap")
        assert _shows(out) == SURVIVORS

    def test_word_spacing_moves_the_text_after_a_single_byte_space(self, tmp_dir):
        # §9.3.3: Tw applies to the single-byte code 32 of a composite font
        # whose CMap defines one. 10 units after "PUBLIC " move "SECRET" to
        # x = 120.4 .. 163.6, and the mark follows it there.
        doc = pikepdf.new()
        _page(
            doc,
            Dictionary(Font=Dictionary(F1=_one_byte_cmap_font(doc))),
            b"BT /F1 12 Tf 10 Tw 60 300 Td (" + TEXT + b") Tj ET",
        )
        _src, out = _redacted(tmp_dir, doc, "cmap_tw", mark=[121, 290, 163, 320])
        assert _shows(out) == SURVIVORS

    def test_a_string_with_a_code_outside_every_range_goes_whole(self, tmp_dir):
        # Readers differ on where an invalid code ends (§9.7.6.3), so the
        # run has no single width: it is removed whole.
        doc = pikepdf.new()
        font = _one_byte_cmap_font(doc)
        font.Encoding.write(
            bytes(font.Encoding.read_bytes()).replace(
                b"1 begincodespacerange <00> <FF> endcodespacerange",
                b"1 begincodespacerange <20> <7E> endcodespacerange",
            )
        )
        _page(
            doc,
            Dictionary(Font=Dictionary(F1=font)),
            b"BT /F1 12 Tf 60 300 Td (" + TEXT + b"\x01) Tj ET",
        )
        _src, out = _redacted(tmp_dir, doc, "cmap_invalid")
        assert _drawn(_shows(out)) == b""
