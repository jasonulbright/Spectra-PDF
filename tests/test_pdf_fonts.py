"""Tests for the font round-trip capability layer."""

from io import BytesIO

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable, table__c_m_a_p
import pikepdf
from pikepdf import Array, Dictionary, Name
import pytest

import gs_axis

from engine.pdf_fonts import font_capability, _strip_subset_prefix

# HIRAGANA LETTER A — kept as a name so the byte literals below stay ASCII.
KANA = chr(0x3042)


def _tounicode_stream(pdf, mapping: dict[int, str]) -> pikepdf.Object:
    """A minimal, valid ToUnicode CMap covering `mapping` (code → unicode)."""
    entries = []
    for code, uni in mapping.items():
        uni_hex = "".join(f"{ord(c):04x}" for c in uni)
        entries.append(f"<{code:04x}> <{uni_hex}>")
    body = (
        "/CIDInit /ProcSet findresource begin\n"
        "12 dict begin\nbegincmap\n"
        "1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n"
        f"{len(entries)} beginbfchar\n" + "\n".join(entries) + "\nendbfchar\n"
        "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
    )
    return pdf.make_stream(body.encode("ascii"))


def _program_ttf(cmap_subtables, advances, upem=1000):
    """A minimal in-test TrueType (zoo): each subtable is
    (platformID, platEncID, {code: glyphname}); post carries the glyph
    names; hmtx carries `advances` (font units, default 500)."""
    names = sorted({g for _, _, m in cmap_subtables for g in m.values()})
    order = [".notdef"] + [g for g in names if g != ".notdef"]
    fb = FontBuilder(upem, isTTF=True)
    fb.setupGlyphOrder(order)
    glyphs = {}
    for name in order:
        pen = TTGlyphPen(None)
        pen.moveTo((0, 0))
        pen.lineTo((0, 500))
        pen.lineTo((500, 500))
        pen.closePath()
        glyphs[name] = pen.glyph()
    fb.setupGlyf(glyphs)
    cmap = table__c_m_a_p()
    cmap.tableVersion = 0
    cmap.tables = []
    for pid, eid, mapping in cmap_subtables:
        st = CmapSubtable.newSubtable(4)
        st.platformID = pid
        st.platEncID = eid
        st.language = 0
        st.cmap = dict(mapping)
        cmap.tables.append(st)
    fb.font["cmap"] = cmap
    fb.setupHorizontalMetrics({n: (advances.get(n, 500), 0) for n in order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "ZooSym", "styleName": "Regular"})
    fb.setupPost()
    buf = BytesIO()
    fb.save(buf)
    return buf.getvalue()


def _symbolic_program_font(pdf, ttf_bytes, widths=None, first_char=None, tounicode=None):
    """A symbolic TrueType dict (no /Encoding) carrying `ttf_bytes` as its
    embedded FontFile2 — the exact shape the derivation targets."""
    desc = Dictionary(
        Type=Name("/FontDescriptor"),
        FontName=Name("/ZooSym"),
        Flags=4,  # symbolic
        FontFile2=pdf.make_stream(ttf_bytes),
    )
    font = Dictionary(
        Type=Name("/Font"),
        Subtype=Name("/TrueType"),
        BaseFont=Name("/ZooSym"),
        FontDescriptor=desc,
    )
    if widths is not None:
        font["/FirstChar"] = first_char
        font["/Widths"] = Array(widths)
    if tounicode is not None:
        font["/ToUnicode"] = _tounicode_stream(pdf, tounicode)
    return pdf.make_indirect(font)


def _t1_number(value: int) -> bytes:
    """One Type 1 charstring number, per the charstring encoding."""
    value = int(value)
    if -107 <= value <= 107:
        return bytes([value + 139])
    if 108 <= value <= 1131:
        delta = value - 108
        return bytes([(delta >> 8) + 247, delta & 0xFF])
    return b"\xff" + value.to_bytes(4, "big", signed=True)


def _t1_charstring(width: int) -> bytes:
    """`0 <width> hsbw endchar`, eexec-encrypted at lenIV 4 — an empty glyph
    that still declares its advance, which is what the width derivation
    reads."""
    from fontTools.misc import eexec

    HSBW, ENDCHAR = bytes([13]), bytes([14])
    plain = _t1_number(0) + _t1_number(width) + HSBW + ENDCHAR
    encrypted, _r = eexec.encrypt(b"\0\0\0\0" + plain, 4330)
    return encrypted


def _type1_program(
    names_by_code,
    widths,
    *,
    trailer_zeros=512,
    drop_cipher=0,
    len_iv=4,
    clear_extra=(),
    trailer_sep=b"\n",
):
    """A synthesized Type 1 font program → (bytes, Length1, Length2).

    Every byte is generated here — no third-party font is read or
    redistributed, so the fixture carries no licence. The structure is the
    one a real program has: a clear-text dictionary ending in
    `currentfile eexec`, an eexec-encrypted Private/CharStrings section
    ending in `currentfile closefile`, then the trailer.

    `trailer_zeros=0` is the shape a PDF embeds with `/Length3 0`; a smaller
    count is a truncated trailer; `drop_cipher` cuts bytes off the encrypted
    section, which destroys the `closefile` no trailer can restore.
    `len_iv=-1` declares a Private dict t1Lib rejects only AFTER interpreting
    the whole program, and `clear_extra` lines are interpreted in the clear
    text — an undefined name there is a parse failure carrying the document's
    own bytes. `trailer_sep` is the whitespace between the trailer's zero
    lines (the `EEXECEND` regex accepts space/tab/CR/LF); a non-whitespace
    separator makes the run look interrupted.
    """
    from fontTools.misc import eexec

    header = [
        b"%!PS-AdobeFont-1.0: ZooT1 001.001",
        b"11 dict begin",
        b"/FontName /ZooT1 def",
        b"/PaintType 0 def",
        b"/FontType 1 def",
        b"/FontMatrix [0.001 0 0 0.001 0 0] readonly def",
        b"/FontBBox{0 0 600 700}readonly def",
        b"/Encoding 256 array",
        b"0 1 255 {1 index exch /.notdef put} for",
    ]
    for code, name in sorted(names_by_code.items()):
        header.append(b"dup %d /%s put" % (code, name.encode("ascii")))
    header.append(b"readonly def")
    header += list(clear_extra)
    header += [b"currentdict end", b"currentfile eexec", b""]
    clear = b"\n".join(header)

    charstrings = dict(widths)
    charstrings.setdefault(".notdef", 0)
    private = [
        b"dup",
        b"/Private 8 dict dup begin",
        b"/RD{string currentfile exch readstring pop}executeonly def",
        b"/ND{noaccess def}executeonly def",
        b"/NP{noaccess put}executeonly def",
        b"/lenIV %d def" % len_iv,
        b"/Subrs 0 array ND",
        b"2 index /CharStrings %d dict dup begin" % len(charstrings),
    ]
    for name, width in sorted(charstrings.items()):
        blob = _t1_charstring(width)
        private.append(
            b"/%s %d RD " % (name.encode("ascii"), len(blob)) + blob + b" ND"
        )
    private += [
        b"end",
        b"end",
        b"readonly put",
        b"put",
        b"dup/FontName get exch definefont pop",
        b"mark currentfile closefile",
        b"",
    ]
    cipher, _r = eexec.encrypt(b"ZOO!" + b"\n".join(private), 55665)
    if drop_cipher:
        cipher = cipher[:-drop_cipher]
    program = clear + cipher
    if trailer_zeros:
        program += (
            b"\n"
            + (b"0" * 64 + trailer_sep) * (trailer_zeros // 64)
            + b"cleartomark\n"
        )
    return program, len(clear), len(cipher)


#: Sentinel for "omit the entry entirely", distinct from a declared 0.
_OMIT = object()


def _symbolic_type1_font(
    pdf, program, length1, length2, *, length3=None, widths=None, first_char=None
):
    """A symbolic Type1 dict (no /Encoding, no /ToUnicode) carrying `program`
    as its embedded /FontFile — the slot the program derivation targets.
    `/Length3` defaults to what the program's own bytes make it (0 when the
    trailer was dropped, per ISO 32000-2 Table 125); pass a value to declare
    something else, or `_OMIT` to leave all three entries out."""
    stream = pdf.make_stream(program)
    if length3 is not _OMIT:
        stream["/Length1"] = length1
        stream["/Length2"] = length2
        stream["/Length3"] = (
            max(len(program) - length1 - length2, 0) if length3 is None else length3
        )
    desc = Dictionary(
        Type=Name("/FontDescriptor"),
        FontName=Name("/ZooT1"),
        Flags=4,  # symbolic — forces the program-derivation path
        FontFile=stream,
    )
    font = Dictionary(
        Type=Name("/Font"),
        Subtype=Name("/Type1"),
        BaseFont=Name("/ABCDEF+ZooT1"),
        FontDescriptor=desc,
    )
    if widths is not None:
        font["/FirstChar"] = first_char
        font["/Widths"] = Array(widths)
    return pdf.make_indirect(font)


class TestSimpleFonts:
    def test_winansi_round_trip_and_inventory(self):
        pdf = pikepdf.new()
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/TrueType"),
                BaseFont=Name("/Helvetica"),
                Encoding=Name("/WinAnsiEncoding"),
            )
        )
        cap = font_capability(font)
        assert cap.editable
        assert cap.decode(b"Hello") == "Hello"
        assert cap.encode("Hello") == b"Hello"
        inv = cap.encodable()
        assert "A" in inv and "é" in inv  # WinAnsi covers Latin-1 accents
        with pytest.raises(ValueError, match="cannot encode"):
            cap.encode("→")  # arrow is not in WinAnsi

    def test_differences_override(self):
        pdf = pikepdf.new()
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type1"),
                BaseFont=Name("/Helvetica"),
                Encoding=Dictionary(
                    BaseEncoding=Name("/WinAnsiEncoding"),
                    # Code 65 ('A' normally) remapped to Euro.
                    Differences=Array([65, Name("/Euro")]),
                ),
            )
        )
        cap = font_capability(font)
        assert cap.decode(b"\x41") == "€"
        assert cap.encode("€") == b"\x41"
        # 'A' is no longer reachable at 65; encode must refuse it.
        with pytest.raises(ValueError):
            cap.encode("A")

    def test_base14_afm_widths_without_widths_array(self):
        pdf = pikepdf.new()
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type1"),
                BaseFont=Name("/Helvetica"),
                Encoding=Name("/WinAnsiEncoding"),
            )
        )
        cap = font_capability(font)
        assert cap.char_width("A") == 667  # Helvetica AFM
        assert cap.char_width(" ") == 278

    def test_widths_array_takes_precedence(self):
        pdf = pikepdf.new()
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/TrueType"),
                BaseFont=Name("/Helvetica"),
                Encoding=Name("/WinAnsiEncoding"),
                FirstChar=65,
                Widths=Array([600, 650]),  # A=600, B=650
            )
        )
        cap = font_capability(font)
        assert cap.char_width("A") == 600
        assert cap.char_width("B") == 650
        assert cap.text_width("AB") == 1250

    def test_subset_prefix_stripped_for_afm(self):
        assert _strip_subset_prefix("ABCDEF+Helvetica") == "Helvetica"
        assert _strip_subset_prefix("Helvetica") == "Helvetica"
        assert _strip_subset_prefix("AbCdEf+X") == "AbCdEf+X"  # not all-upper

    def test_symbolic_without_encoding_refused_unless_tounicode(self):
        pdf = pikepdf.new()
        base = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/TrueType"),
            BaseFont=Name("/Wingdinglike"),
            FontDescriptor=Dictionary(Flags=4),  # symbolic
        )
        cap = font_capability(pdf.make_indirect(base))
        assert not cap.editable
        assert "encoding" in (cap.reason or "")

        with_tou = Dictionary(base)
        with_tou["/ToUnicode"] = _tounicode_stream(pdf, {0x41: "A"})
        cap2 = font_capability(pdf.make_indirect(with_tou))
        assert cap2.editable
        assert cap2.decode(b"\x41") == "A"


class TestType0Fonts:
    def _identity_font(self, pdf, mapping, w_array=None, dw=None):
        desc = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/CIDFontType2"),
            BaseFont=Name("/AAAAAA+NotoSans"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
        )
        if w_array is not None:
            desc["/W"] = w_array
        if dw is not None:
            desc["/DW"] = dw
        return pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type0"),
                BaseFont=Name("/AAAAAA+NotoSans"),
                Encoding=Name("/Identity-H"),
                DescendantFonts=Array([pdf.make_indirect(desc)]),
                ToUnicode=_tounicode_stream(pdf, mapping),
            )
        )

    def test_identity_h_round_trip(self):
        pdf = pikepdf.new()
        font = self._identity_font(pdf, {3: "H", 4: "i", 5: "€"})
        cap = font_capability(font)
        assert cap.editable
        assert cap.decode(b"\x00\x03\x00\x04") == "Hi"
        assert cap.encode("Hi") == b"\x00\x03\x00\x04"
        assert cap.encode("€") == b"\x00\x05"
        assert set(cap.encodable()) == {"H", "i", "€"}
        with pytest.raises(ValueError):
            cap.encode("X")  # outside the subset's ToUnicode image

    def test_w_array_widths_both_forms(self):
        pdf = pikepdf.new()
        # [c [w w]] then [c1 c2 w]
        font = self._identity_font(
            pdf,
            {3: "H", 4: "i", 10: "x", 11: "y"},
            w_array=Array([3, Array([600, 300]), 10, 11, 500]),
            dw=750,
        )
        cap = font_capability(font)
        assert cap.char_width("H") == 600
        assert cap.char_width("i") == 300
        assert cap.char_width("x") == 500 and cap.char_width("y") == 500
        # Unlisted CID falls to /DW.
        assert cap.decoded_width(b"\x00\x63") == 750

    def test_ligature_values_keep_single_char_floor_but_round_trip(self):
        # This used to pin an encode REFUSAL for "fi"; the ligature table lifts exactly
        # that (the unambiguous inverse rides the ligature table) while the
        # single-char floor stays byte-identical.
        pdf = pikepdf.new()
        font = self._identity_font(pdf, {7: "fi", 8: "f"})
        cap = font_capability(font)
        assert cap.decode(b"\x00\x07") == "fi"
        # Reverse map is single-char only: 'i' ALONE is still unreachable.
        assert "i" not in cap.encodable()
        with pytest.raises(ValueError):
            cap.encode("i")
        # ...but the pair round-trips through the ligature code.
        assert cap.encode("fi") == b"\x00\x07"
        assert cap.encodable_sequences() == ["fi"]

    def test_refusals(self):
        pdf = pikepdf.new()
        no_tou = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type0"),
            BaseFont=Name("/X"),
            Encoding=Name("/Identity-H"),
        )
        cap = font_capability(pdf.make_indirect(no_tou))
        assert not cap.editable and "ToUnicode" in (cap.reason or "")

        vertical = Dictionary(no_tou)
        vertical["/Encoding"] = Name("/Identity-V")
        cap2 = font_capability(pdf.make_indirect(vertical))
        assert not cap2.editable and "vertical" in (cap2.reason or "")

        t3 = Dictionary(Type=Name("/Font"), Subtype=Name("/Type3"))
        cap3 = font_capability(pdf.make_indirect(t3))
        assert not cap3.editable and "Type3" in (cap3.reason or "")


class TestAnEmbeddedCMapNamesItselfAndNothingElse:
    """`/Encoding` is a NAME or a CMap STREAM (ISO 32000-2, 9.7.5.1).

    The refusal reason reaches the user — it rides `reason` on a text run and
    lands in an accessibility finding — so a stream must contribute a phrase,
    not its object repr. `str()` of a pikepdf Stream is unbounded and carries
    the CMap dictionary's own contents, which is what used to be reported.
    """

    def _stream_encoded_font(self, pdf):
        cmap = pdf.make_stream(
            b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap endcmap end end",
            Type=Name("/CMap"),
            CMapName=Name("/Custom-H"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Korea1", Supplement=2),
            WMode=0,
        )
        desc = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/CIDFontType2"),
                BaseFont=Name("/Embedded"),
                CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Korea1", Supplement=2),
            )
        )
        return pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type0"),
                BaseFont=Name("/Embedded"),
                Encoding=cmap,
                DescendantFonts=Array([desc]),
            )
        )

    def test_the_refusal_names_the_shape_not_the_object(self):
        pdf = pikepdf.new()
        cap = font_capability(self._stream_encoded_font(pdf))
        assert not cap.editable
        assert cap.reason == "unsupported composite-font encoding (embedded CMap)"

    def test_the_refusal_carries_no_object_repr(self):
        pdf = pikepdf.new()
        reason = font_capability(self._stream_encoded_font(pdf)).reason
        # The three shapes a repr leak takes: the class name, the dictionary
        # dump, and the stream bytes.
        assert "pikepdf" not in reason
        assert "CIDSystemInfo" not in reason
        assert chr(10) not in reason
        assert len(reason) < 80


class TestCodesThroughTheCodespace:
    """A composite font's codes are read through its CMap's codespace ranges
    (ISO 32000-2 §9.7.6.2): each byte of a code lies between the range's
    bounds at its position. A code that matches no range is consumed by the
    partial match of §9.7.6.3 and counts as invalid; a string holding one has
    no single width, so it does not measure."""

    def test_a_code_matches_byte_by_byte_not_by_value(self):
        from engine.pdf_fonts import CodeSpace

        space = CodeSpace([(b"\x81\x40", b"\x9f\xfc")])
        assert space.read(b"\x81\x40", 0) == (2, True)
        # 0x81FF lies between 0x8140 and 0x9FFC as a number; its second byte
        # lies outside 0x40..0xFC.
        assert space.read(b"\x81\xff", 0) == (2, False)

    def test_a_first_byte_no_range_starts_with_takes_the_shortest_codes(self):
        from engine.pdf_fonts import CodeSpace

        space = CodeSpace([(b"\x81\x40", b"\x9f\xfc"), (b"\xa1", b"\xdf")])
        assert space.split(b"\x20\xa1") == [(0x20, 1, False), (0xA1, 1, True)]

    def test_the_longest_partial_match_wins_and_a_tie_takes_the_shorter(self):
        from engine.pdf_fonts import CodeSpace

        space = CodeSpace(
            [(b"\x81\x30\x81\x30", b"\xfe\x39\xfe\x39"), (b"\x81\x40", b"\xfe\xfe")]
        )
        # 0x81 starts both ranges and 0x20 continues neither: the tie goes to
        # the two-byte codes.
        assert space.read(b"\x81\x20\x20\x20", 0) == (2, False)
        # 0x81 0x35 continues only the four-byte range.
        assert space.read(b"\x81\x35\x20\x20", 0) == (4, False)

    def _embedded(self, pdf, spaces: bytes, widths=None):
        program = (
            b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap "
            + spaces
            + b" 1 begincidrange <20> <7E> 32 endcidrange"
            b" endcmap CMapName currentdict /CMap defineresource pop end end"
        )
        cmap = pdf.make_stream(program, Type=Name("/CMap"), CMapName=Name("/OneByte"))
        kid = Dictionary(
            Type=Name("/Font"), Subtype=Name("/CIDFontType2"), BaseFont=Name("/Embedded"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
            DW=600,
        )
        if widths is not None:
            kid["/W"] = Array(widths)
        return pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"), Subtype=Name("/Type0"), BaseFont=Name("/Embedded"),
                Encoding=cmap, DescendantFonts=Array([pdf.make_indirect(kid)]),
            )
        )

    def test_an_embedded_cmap_reads_its_own_one_byte_codes(self):
        pdf = pikepdf.new()
        cap = font_capability(
            self._embedded(pdf, b"1 begincodespacerange <00> <FF> endcodespacerange", [0x51, Array([900])])
        )
        assert not cap.editable
        assert cap.codes(b"PQ") == [(0x50, 1), (0x51, 1)]
        # P is CID 0x50 at /DW; Q is CID 0x51 at its own /W entry.
        assert cap.decoded_width(b"PQ") == 600 + 900
        assert cap.measures(b"PQ")

    def test_an_embedded_cmap_font_reads_through_its_tounicode_and_encodes_nothing(self):
        pdf = pikepdf.new()
        font = self._embedded(pdf, b"1 begincodespacerange <00> <FF> endcodespacerange")
        font["/ToUnicode"] = _tounicode_stream(pdf, {0x50: "P", 0x51: "Q"})
        cap = font_capability(font)
        assert not cap.editable
        assert cap.decode(b"PQ") == "PQ"
        with pytest.raises(ValueError):
            cap.encode("P")

    def test_an_embedded_code_outside_every_range_does_not_measure(self):
        pdf = pikepdf.new()
        cap = font_capability(self._embedded(pdf, b"1 begincodespacerange <20> <7E> endcodespacerange"))
        assert cap.measures(b"PQ")
        assert not cap.measures(b"P\x01")

    def test_an_embedded_cmap_built_on_identity_reads_its_two_byte_codes(self):
        from engine.pdf_fonts import EmbeddedCMap

        cmap = EmbeddedCMap(
            b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap "
            b"/Identity-H usecmap 1 begincidchar <0041> 7 endcidchar endcmap end end"
        )
        assert cmap.code_space.split(b"\x00\x41\x00\x42") == [(0x41, 2, True), (0x42, 2, True)]
        assert (cmap.cid(b"\x00\x41"), cmap.cid(b"\x00\x42")) == (7, 0x42)

    def test_a_fixed_two_byte_font_s_odd_last_byte_does_not_measure(self):
        pdf = pikepdf.new()
        kid = Dictionary(
            Type=Name("/Font"), Subtype=Name("/CIDFontType2"), BaseFont=Name("/Identity"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0), DW=600,
        )
        cap = font_capability(
            pdf.make_indirect(
                Dictionary(
                    Type=Name("/Font"), Subtype=Name("/Type0"), BaseFont=Name("/Identity"),
                    Encoding=Name("/Identity-H"), DescendantFonts=Array([pdf.make_indirect(kid)]),
                )
            )
        )
        assert cap.measures(b"\x00\x41")
        assert not cap.measures(b"\x00\x41\x00")

    def test_an_unreadable_embedded_cmap_counts_every_byte_as_a_code(self):
        pdf = pikepdf.new()
        cap = font_capability(self._embedded(pdf, b""))
        assert cap.code_count(b"PQ") == 2
        assert not cap.measures(b"PQ")

    def test_a_predefined_code_that_leaves_the_trie_is_consumed_whole(self):
        pdf = pikepdf.new()
        cap = font_capability(
            TestPredefinedCjkCMaps()._cjk_font(pdf, {0x41: "A", 0x82A0: KANA}, "90ms-RKSJ-H")
        )
        # 0x81 leads a two-byte code; 0x81 0x20 is not one the CMap maps.
        assert cap.codes(b"\x81\x20A") == [(0x8120, 2), (0x41, 1)]
        assert not cap.measures(b"\x81\x20A")
        assert cap.measures(b"A\x82\xa0")

    def test_a_predefined_code_absent_from_tounicode_measures_through_its_cid(self):
        from pdfminer.cmapdb import CMapDB

        pdf = pikepdf.new()
        cid = list(CMapDB.get_cmap("90ms-RKSJ-H").decode(b"\x82\xa0"))[0]
        cap = font_capability(
            TestPredefinedCjkCMaps()._cjk_font(
                pdf, {0x41: "A"}, "90ms-RKSJ-H", cid_widths={cid: 880}, dw=500
            )
        )
        assert cap.decoded_width(b"\x82\xa0") == 880

    def test_word_spacing_finds_the_single_byte_space_of_a_cmap(self):
        from engine.text_metrics import _spaces_in

        pdf = pikepdf.new()
        cap = font_capability(
            TestPredefinedCjkCMaps()._cjk_font(pdf, {0x41: "A", 0x82A0: KANA}, "90ms-RKSJ-H")
        )
        assert _spaces_in(b"A \x82\xa0 A", cap) == 2
        # 0x20 inside a two-byte code is not a space.
        assert _spaces_in(b"\x81\x20", cap) == 0


class TestPredefinedCjkCMaps:
    """Type0 fonts with a named Unicode horizontal CMap."""

    def _cjk_font(self, pdf, chars, encoding, cid_widths=None, dw=500, with_tou=True):
        w_array = None
        if cid_widths:
            items = []
            for cid, w in cid_widths.items():
                items.extend([cid, Array([w])])
            w_array = Array(items)
        desc_d = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/CIDFontType2"),
            BaseFont=Name("/CJKFont"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"GB1", Supplement=2),
            DW=dw,
        )
        if w_array is not None:
            desc_d["/W"] = w_array
        font_d = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type0"),
            BaseFont=Name("/CJKFont"),
            Encoding=Name("/" + encoding),
            DescendantFonts=Array([pdf.make_indirect(desc_d)]),
        )
        if with_tou:
            font_d["/ToUnicode"] = _tounicode_stream(pdf, chars)
        return pdf.make_indirect(font_d)

    def test_ucs2_h_round_trip_and_cmap_remapped_widths(self):
        from pdfminer.cmapdb import CMapDB

        pdf = pikepdf.new()
        # For UniGB-UCS2-H the CODE is the UCS-2 value itself.
        chars = {0x4E2D: "中", 0x6587: "文"}  # noqa: RUF001
        cm = CMapDB.get_cmap("UniGB-UCS2-H")
        cid = {code: list(cm.decode(code.to_bytes(2, "big")))[0] for code in chars}
        # Distinct /W per CID so the code->CID->width remap is observable.
        font = self._cjk_font(
            pdf, chars, "UniGB-UCS2-H", cid_widths={cid[0x4E2D]: 900, cid[0x6587]: 1000}
        )
        cap = font_capability(font)
        assert cap.editable
        assert cap.decode(b"\x4e\x2d\x65\x87") == "中文"  # noqa: RUF001
        assert cap.encode("中文") == b"\x4e\x2d\x65\x87"  # noqa: RUF001
        # Widths came through the CMap remap (NOT read as if code==CID).
        assert cap.char_width("中") == 900  # noqa: RUF001
        assert cap.char_width("文") == 1000  # noqa: RUF001
        assert set(cap.encodable()) == {"中", "文"}  # noqa: RUF001

    def test_vertical_ucs2_without_tounicode_RECOVERS_via_registry(self):
        # INVERSION (was: refusal). This fixture names Adobe-GB1, whose
        # published CID→Unicode table pdfminer bundles — the exact mapping a
        # /ToUnicode would have carried. Recovery makes the font editable;
        # the refusal now only covers fonts with NO recoverable route
        # (test_identity_without_tounicode_or_program below pins that).
        pdf = pikepdf.new()
        cap = font_capability(
            self._cjk_font(pdf, {0x4E2D: "中"}, "UniGB-UCS2-V", with_tou=False)  # noqa: RUF001
        )
        assert cap.editable and cap.vertical
        assert cap.decode(bytes.fromhex("3050")) is not None  # some code decodes

    def test_identity_without_tounicode_or_program_still_refuses(self):
        # The honest floor: Adobe-Identity-0 says nothing and with
        # no embedded program there is nothing to reverse — refusal stands,
        # its reason naming BOTH the missing map and the failed recovery.
        pdf = pikepdf.new()
        desc = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/CIDFontType2"),
            BaseFont=Name("/SubsetFont"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
            DW=1000,
        )
        font_d = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type0"),
            BaseFont=Name("/SubsetFont"),
            Encoding=Name("/Identity-H"),
            DescendantFonts=Array([pdf.make_indirect(desc)]),
        )
        cap = font_capability(pdf.make_indirect(font_d))
        assert not cap.editable
        assert "no recoverable mapping" in (cap.reason or "")

    def test_legacy_vertical_cmap_edits(self):
        # INVERSION (was: "non-Unicode legacy encodings refuse
        # regardless of writing mode"). Both refusals were about CODE WIDTH,
        # not about the encoding family: GBK-EUC mixes 1- and 2-byte codes,
        # which the fixed-2-byte walk could not read. The pipeline now takes
        # the CMap's own trie, so the writing mode is the only thing the
        # -V suffix still decides.
        pdf = pikepdf.new()
        cap = font_capability(self._cjk_font(pdf, {0x41: "A"}, "GBK-EUC-V"))
        assert cap.editable and cap.vertical is True
        assert cap.decode(b"A") == "A"

    def test_legacy_cmap_edits_with_mixed_code_widths(self):
        # INVERSION. Shift-JIS is the shape the fixed walk could never
        # read: ASCII is ONE byte and kana/kanji are TWO, in the same string.
        pdf = pikepdf.new()
        cap = font_capability(
            self._cjk_font(pdf, {0x41: "A", 0x82A0: KANA}, "90ms-RKSJ-H")
        )
        assert cap.editable
        assert cap.decode(b"A") == "A"
        assert cap.decode(b"\x82\xa0") == KANA
        # ...and MIXED in one string, which is the whole point: a fixed-width
        # walk splits this into either three codes or one-and-a-half.
        assert cap.decode(b"A\x82\xa0A") == "A" + KANA + "A"
        assert cap.codes(b"A\x82\xa0") == [(0x41, 1), (0x82A0, 2)]
        assert cap.code_count(b"A\x82\xa0") == 2
        assert cap.encode("A" + KANA) == b"A\x82\xa0"

    def test_legacy_cmap_word_spacing_never_fires_on_a_trail_byte(self):
        # Tw applies to the SINGLE-BYTE code 32 only. A two-byte code whose
        # trail byte happens to be 0x20 must not be counted as a space —
        # `single_byte_codes()` is what keeps a raw byte count from
        # inventing word spacing mid-character.
        pdf = pikepdf.new()
        cap = font_capability(self._cjk_font(pdf, {0x41: "A"}, "90ms-RKSJ-H"))
        assert cap.single_byte_codes() is False
        simple = font_capability(
            pikepdf.Dictionary(
                Type=Name("/Font"), Subtype=Name("/Type1"),
                BaseFont=Name("/Helvetica"), Encoding=Name("/WinAnsiEncoding"),
            )
        )
        assert simple.single_byte_codes() is True

    def test_unicode_cmap_without_tounicode_RECOVERS_via_registry(self):
        # INVERSION (was: refusal) — Adobe-GB1's registry table stands in
        # for the absent /ToUnicode; the code→CID comes from the predefined
        # CMap as before. '中' is CID 2085 in Adobe-GB1; the UniGB-UCS2
        # code for it must round-trip through the recovered mapping.
        pdf = pikepdf.new()
        cap = font_capability(
            self._cjk_font(pdf, {0x4E2D: "中"}, "UniGB-UCS2-H", with_tou=False)  # noqa: RUF001
        )
        assert cap.editable
        assert cap.encode("中") is not None  # noqa: RUF001 — the char is reachable again

    def test_unknown_cmap_name_refuses_cleanly(self):
        pdf = pikepdf.new()
        cap = font_capability(self._cjk_font(pdf, {0x41: "A"}, "UniBogus-XYZ-H"))
        assert not cap.editable and "encoding" in (cap.reason or "")

    @pytest.mark.parametrize("enc", ["UniGB-UTF8-H", "UniGB-UTF16-H", "UniGB-UTF32-H"])
    def test_non_2byte_unicode_cmaps_now_edit(self, enc):
        # INVERSION. These are Uni*-H but NOT fixed-2-byte (UTF-8 is
        # 3 bytes for CJK, UTF-32 is 4, UTF-16 uses surrogate pairs), and
        # the fixed-2-byte pipeline SILENTLY CORRUPTED them — which is why
        # They were refused rather than accept the corruption. The pipeline
        # reads the CMap's own trie now, so the width is no longer
        # something the gate has to promise.
        # The CODE is the character in the CMap's OWN scheme — which is the
        # entire point: it is 3 bytes in UTF-8, 4 in UTF-32, 2 in UTF-16.
        codec = {"UTF8": "utf-8", "UTF16": "utf-16-be", "UTF32": "utf-32-be"}[
            enc.split("-")[1]
        ]
        data = "中".encode(codec)  # noqa: RUF001
        code = int.from_bytes(data, "big")
        pdf = pikepdf.new()
        cap = font_capability(self._cjk_font(pdf, {code: "中"}, enc))  # noqa: RUF001
        assert cap.editable, cap.reason
        assert cap.decode(data) == "中"  # noqa: RUF001
        assert cap.encode("中") == data  # noqa: RUF001
        assert cap.code_count(data) == 1
        assert cap.codes(data) == [(code, len(data))]

    def test_ucs2_hw_variant_still_accepts(self):
        # -UCS2-HW-H (half-width) is also fixed 2-byte — must stay editable.
        pdf = pikepdf.new()
        cap = font_capability(self._cjk_font(pdf, {0x4E2D: "中"}, "UniJIS-UCS2-HW-H"))  # noqa: RUF001
        assert cap.editable


class TestVerticalWriting:
    """Identity-V / Uni*-UCS2-V vertical twins: the same
    ToUnicode round-trip as their -H counterparts, with /W2//DW2 VERTICAL
    advances (|w1y|, 1000/em) served by the width methods and vertical=True
    on the capability; horizontal fonts stay byte-identical."""

    def _identity_v_font(self, pdf, mapping, w2=None, dw2=None, with_tou=True):
        desc = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/CIDFontType2"),
            BaseFont=Name("/AAAAAA+VertFace"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
        )
        if w2 is not None:
            desc["/W2"] = w2
        if dw2 is not None:
            desc["/DW2"] = Array(dw2)
        font = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type0"),
            BaseFont=Name("/AAAAAA+VertFace"),
            Encoding=Name("/Identity-V"),
            DescendantFonts=Array([pdf.make_indirect(desc)]),
        )
        if with_tou:
            font["/ToUnicode"] = _tounicode_stream(pdf, mapping)
        return pdf.make_indirect(font)

    def test_identity_v_round_trip_and_w2_both_forms(self):
        pdf = pikepdf.new()
        # Triplet form `c [w1y vx vy …]` covers CIDs 3,4; range form
        # `cfirst clast w1y vx vy` covers 5..6; CID 9 is unlisted (DW2
        # default). Advances are |w1y|.
        font = self._identity_v_font(
            pdf,
            {3: "あ", 4: "い", 5: "う", 6: "え", 9: "お"},
            w2=Array([3, Array([-900, 500, 880, -800, 450, 880]), 5, 6, -750, 500, 880]),
        )
        cap = font_capability(font)
        assert cap.editable and cap.reason is None
        assert cap.vertical is True
        # The round-trip is Identity-H's twin — decode/encode ride ToUnicode.
        assert cap.decode(b"\x00\x03\x00\x04") == "あい"
        assert cap.encode("あい") == b"\x00\x03\x00\x04"
        assert set(cap.encodable()) == {"あ", "い", "う", "え", "お"}
        with pytest.raises(ValueError):
            cap.encode("X")
        # Vertical advances: triplet form...
        assert cap.char_width("あ") == 900
        assert cap.char_width("い") == 800
        # ...range form...
        assert cap.char_width("う") == 750 and cap.char_width("え") == 750
        # ...and the spec DW2 default ([880 -1000] → 1000) for unlisted CIDs.
        assert cap.decoded_width(b"\x00\x09") == 1000
        assert cap.text_width("あい") == 1700

    def test_explicit_dw2_overrides_the_default_advance(self):
        pdf = pikepdf.new()
        font = self._identity_v_font(pdf, {3: "あ"}, dw2=[880, -500])
        cap = font_capability(font)
        assert cap.editable and cap.vertical is True
        assert cap.char_width("あ") == 500
        assert cap.decoded_width(b"\x00\x63") == 500

    def test_ucs2_v_accepts_with_remapped_vertical_advances(self):
        from pdfminer.cmapdb import CMapDB

        pdf = pikepdf.new()
        chars = {0x4E2D: "中", 0x6587: "文"}  # noqa: RUF001
        # The -V CMap carries its own code->CID (incl. vertical-variant
        # CIDs), so /W2 is keyed by ITS cids — the same remap discipline
        # as the horizontal test.
        cm = CMapDB.get_cmap("UniGB-UCS2-V")
        assert cm.is_vertical()
        cid = {code: list(cm.decode(code.to_bytes(2, "big")))[0] for code in chars}
        desc = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/CIDFontType2"),
            BaseFont=Name("/CJKVert"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"GB1", Supplement=2),
            W2=Array(
                [
                    cid[0x4E2D],
                    Array([-900, 500, 880]),
                    cid[0x6587],
                    Array([-950, 500, 880]),
                ]
            ),
        )
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type0"),
                BaseFont=Name("/CJKVert"),
                Encoding=Name("/UniGB-UCS2-V"),
                DescendantFonts=Array([pdf.make_indirect(desc)]),
                ToUnicode=_tounicode_stream(pdf, chars),
            )
        )
        cap = font_capability(font)
        assert cap.editable and cap.reason is None
        assert cap.vertical is True
        assert cap.decode(b"\x4e\x2d\x65\x87") == "中文"  # noqa: RUF001
        assert cap.encode("中文") == b"\x4e\x2d\x65\x87"  # noqa: RUF001
        # Widths came through the -V CMap's code->CID remap of /W2.
        assert cap.char_width("中") == 900  # noqa: RUF001
        assert cap.char_width("文") == 950  # noqa: RUF001

    def test_horizontal_font_is_byte_identical_and_ignores_w2(self):
        # The vertical=False guard: an Identity-H capability is untouched
        # by the vertical path even when the descendant carries /W2//DW2 — widths stay
        # the /W table's, the flag stays False.
        pdf = pikepdf.new()
        desc = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/CIDFontType2"),
            BaseFont=Name("/AAAAAA+Face"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
            W=Array([3, Array([600, 300])]),
            DW=750,
            W2=Array([3, Array([-900, 500, 880, -800, 450, 880])]),
            DW2=Array([880, -500]),
        )
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type0"),
                BaseFont=Name("/AAAAAA+Face"),
                Encoding=Name("/Identity-H"),
                DescendantFonts=Array([pdf.make_indirect(desc)]),
                ToUnicode=_tounicode_stream(pdf, {3: "H", 4: "i"}),
            )
        )
        cap = font_capability(font)
        assert cap.vertical is False
        assert cap.char_width("H") == 600  # /W, not /W2's 900
        assert cap.char_width("i") == 300
        assert cap.decoded_width(b"\x00\x63") == 750  # /DW, not /DW2's 500
        # Simple fonts default the flag too.
        simple = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type1"),
                BaseFont=Name("/Helvetica"),
                Encoding=Name("/WinAnsiEncoding"),
            )
        )
        assert font_capability(simple).vertical is False

    def test_vertical_without_tounicode_keeps_refusing(self):
        # The lifted classes are ToUnicode-bearing ONLY; the vertical
        # refusal (naming the class) survives without one — the pin the
        # old blanket-refusal test carried forward.
        pdf = pikepdf.new()
        cap = font_capability(self._identity_v_font(pdf, {}, with_tou=False))
        assert not cap.editable
        assert "vertical" in (cap.reason or "") and "ToUnicode" in (cap.reason or "")


class TestSymbolicProgramDerivedEncoding:
    """A symbolic simple font with no usable /Encoding and no
    ToUnicode derives its code map from the embedded program instead of
    refusing; the refusal survives only when nothing derives."""

    def test_win_unicode_cmap_round_trip(self):
        pdf = pikepdf.new()
        data = _program_ttf(
            [(3, 1, {0x41: "glyphA", 0x42: "glyphB"})],
            {"glyphA": 600, "glyphB": 650},
        )
        font = _symbolic_program_font(pdf, data, widths=[601, 651], first_char=65)
        cap = font_capability(font)
        assert cap.editable and cap.reason is None
        assert cap.decode(b"\x41\x42") == "AB"
        assert cap.encode("AB") == b"\x41\x42"
        assert set(cap.encodable()) == {"A", "B"}
        # /Widths (601/651) beats the program's hmtx (600/650).
        assert cap.char_width("A") == 601
        assert cap.char_width("B") == 651
        with pytest.raises(ValueError, match="cannot encode"):
            cap.encode("C")

    def test_symbol_cmap_derives_via_glyph_names(self):
        pdf = pikepdf.new()
        data = _program_ttf(
            [(3, 0, {0xF041: "alpha", 0xF042: "uni2318", 0x43: "beta", 0xF044: "orn001"})],
            {"alpha": 700, "uni2318": 800, "beta": 550, "orn001": 420},
        )
        cap = font_capability(_symbolic_program_font(pdf, data))
        assert cap.editable
        assert cap.decode(b"\x41") == "α"  # AGL name
        assert cap.decode(b"\x42") == "⌘"  # uniXXXX-form name
        assert cap.decode(b"\x43") == "β"  # bare-code (non-F000) entry
        assert cap.decode(b"\x44") == "�"  # underivable name stays unmapped
        assert cap.encode("α⌘β") == b"\x41\x42\x43"
        assert set(cap.encodable()) == {"α", "⌘", "β"}
        # No /Widths → the program's hmtx (upem 1000: advances pass through).
        assert cap.char_width("α") == 700
        assert cap.char_width("⌘") == 800
        # The unmapped-but-real glyph still carries its true advance by CODE.
        assert cap.decoded_width(b"\x44") == 420

    def test_underivable_program_still_refuses_with_stated_reason(self):
        pdf = pikepdf.new()
        data = _program_ttf([(3, 0, {0xF041: "orn001", 0xF042: "orn002"})], {})
        cap = font_capability(_symbolic_program_font(pdf, data))
        assert not cap.editable
        assert cap.reason == "no resolvable encoding (symbolic font without ToUnicode)"

    def test_tounicode_takes_precedence_over_program(self):
        pdf = pikepdf.new()
        data = _program_ttf([(3, 1, {0x41: "glyphA"})], {"glyphA": 600})
        font = _symbolic_program_font(pdf, data, tounicode={0x41: "Z"})
        cap = font_capability(font)
        assert cap.editable
        assert cap.decode(b"\x41") == "Z"  # ToUnicode, not the program's "A"
        assert cap.encode("Z") == b"\x41"
        assert set(cap.encodable()) == {"Z"}
        with pytest.raises(ValueError):
            cap.encode("A")
        # Byte-identical to today: no program widths harvested on this path.
        assert cap.char_width("Z") == 500.0

    def test_mac_cmap_and_hmtx_width_scaling(self):
        pdf = pikepdf.new()
        data = _program_ttf(
            [(1, 0, {0x41: "alpha", 0x42: "beta"})],
            {"alpha": 1024, "beta": 512},
            upem=2048,
        )
        cap = font_capability(_symbolic_program_font(pdf, data))
        assert cap.editable
        assert cap.decode(b"\x41\x42") == "αβ"
        assert cap.encode("β") == b"\x42"
        assert cap.char_width("α") == 500.0  # 1024 × 1000/2048
        assert cap.char_width("β") == 250.0
        assert cap.text_width("αβ") == 750.0

    def test_bare_cff_fontfile3_refuses_cleanly(self):
        # Bare CFF (Type1C) is not SFNT — fontTools TTFont rejects it, and
        # the refusal must stand (cffLib derivation is a scoped-out tail).
        pdf = pikepdf.new()
        desc = Dictionary(
            Type=Name("/FontDescriptor"),
            FontName=Name("/ZooCff"),
            Flags=4,
            FontFile3=pdf.make_stream(b"\x01\x00\x04\x02" + b"\x00" * 64),
        )
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type1"),
                BaseFont=Name("/ZooCff"),
                FontDescriptor=desc,
            )
        )
        cap = font_capability(font)
        assert not cap.editable
        assert cap.reason == "no resolvable encoding (symbolic font without ToUnicode)"

class TestWidthsGuardHardening:
    """Review round: the /Widths subset guard vs degenerate arrays."""

    def test_empty_widths_array_does_not_collapse_encodability(self):
        # regression: /Widths [] inverted the guard range and
        # emptied the encode map while char_width fell to the default —
        # editable=True with nothing encodable and every advance wrong.
        import pikepdf
        from pikepdf import Array, Dictionary, Name

        pdf = pikepdf.new()
        data = _program_ttf([(3, 1, {0x41: "A", 0x42: "B", 0x43: "C"})], {"A": 600, "B": 650, "C": 700})
        ff = pdf.make_stream(data)
        font = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/TrueType"),
            BaseFont=Name("/AAAAAA+Sym"),
            FirstChar=65,
            Widths=Array([]),
            FontDescriptor=Dictionary(Type=Name("/FontDescriptor"), Flags=4, FontFile2=ff),
        )
        cap = font_capability(font)
        assert cap.editable is True
        assert set(cap.encodable()) == {"A", "B", "C"}
        assert cap.encode("A") == b"A"
        assert cap.char_width("A") == pytest.approx(600.0)

    def test_partial_widths_merge_keeps_program_advances(self):
        # regression: a partial /Widths discarded real hmtx advances
        # for uncovered codes (decoded_width fell to the 500 default).
        # Declared entries still win per-code; the rest keep hmtx truth.
        import pikepdf
        from pikepdf import Array, Dictionary, Name

        pdf = pikepdf.new()
        data = _program_ttf([(3, 1, {0x41: "A", 0x42: "B", 0x43: "C"})], {"A": 600, "B": 650, "C": 700})
        ff = pdf.make_stream(data)
        font = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/TrueType"),
            BaseFont=Name("/AAAAAA+Sym"),
            FirstChar=65,
            Widths=Array([601]),
            FontDescriptor=Dictionary(Type=Name("/FontDescriptor"), Flags=4, FontFile2=ff),
        )
        cap = font_capability(font)
        assert cap.decoded_width(b"A") == pytest.approx(601.0)  # declared wins
        assert cap.decoded_width(b"B") == pytest.approx(650.0)  # hmtx kept
        assert cap.decoded_width(b"C") == pytest.approx(700.0)


class TestLigatureRoundTrip:
    """Multi-char ligature mappings round-trip through encode
    where the inverse is unambiguous; ambiguity and the /Widths subset
    guard keep the refusal; the single-char floor never widens."""

    def _identity_font(self, pdf, mapping, w_array=None, dw=None):
        desc = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/CIDFontType2"),
            BaseFont=Name("/AAAAAA+LigFace"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
        )
        if w_array is not None:
            desc["/W"] = w_array
        if dw is not None:
            desc["/DW"] = dw
        return pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type0"),
                BaseFont=Name("/AAAAAA+LigFace"),
                Encoding=Name("/Identity-H"),
                DescendantFonts=Array([pdf.make_indirect(desc)]),
                ToUnicode=_tounicode_stream(pdf, mapping),
            )
        )

    def test_tounicode_ligature_round_trips_at_the_ligature_width(self):
        pdf = pikepdf.new()
        font = self._identity_font(
            pdf,
            {1: "a", 2: "b", 7: "fi"},
            w_array=Array([1, Array([400]), 2, Array([450]), 7, Array([800])]),
        )
        cap = font_capability(font)
        assert cap.decode(b"\x00\x07") == "fi"
        assert cap.encode("fi") == b"\x00\x07"
        # Mixed text: singles + the sequence, matched mid-string.
        assert cap.encode("afib") == b"\x00\x01\x00\x07\x00\x02"
        # The pair consumes the LIGATURE code's width, not two defaults.
        assert cap.text_width("fi") == 800
        assert cap.text_width("afib") == 400 + 800 + 450
        # Inventory: the single-char floor is untouched; sequences are the
        # additive layer.
        assert set(cap.encodable()) == {"a", "b"}
        assert not cap.can_encode("f")
        assert cap.encodable_sequences() == ["fi"]

    def test_simple_font_tounicode_ligature_round_trips(self):
        # The SIMPLE-font construction site (ToUnicode-named symbolic) gets
        # the same table — both _reverse sites carry ligatures.
        pdf = pikepdf.new()
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/TrueType"),
                BaseFont=Name("/LigSym"),
                FontDescriptor=Dictionary(Flags=4),
                ToUnicode=_tounicode_stream(pdf, {0x41: "A", 0x4C: "ffl"}),
            )
        )
        cap = font_capability(font)
        assert cap.decode(b"\x4c") == "ffl"
        assert cap.encode("Affl") == b"\x41\x4c"
        assert cap.encodable_sequences() == ["ffl"]

    def test_ambiguous_double_mapping_refuses_the_sequence(self):
        pdf = pikepdf.new()
        font = self._identity_font(pdf, {1: "a", 7: "fi", 9: "fi"})
        cap = font_capability(font)
        # Both codes still DECODE...
        assert cap.decode(b"\x00\x07") == "fi"
        assert cap.decode(b"\x00\x09") == "fi"
        # ...but the inverse is ambiguous — never guess which code.
        assert cap.encodable_sequences() == []
        with pytest.raises(ValueError, match="cannot encode"):
            cap.encode("fi")
        # Unrelated singles are untouched by the exclusion.
        assert cap.encode("a") == b"\x00\x01"

    def test_widths_subset_guard_excludes_out_of_range_ligature(self):
        # Codes 65..66 declared by /Widths; the ligature lives at 200 —
        # outside the declared subset, so it must NOT encode. Decode stays
        # broad: bytes already in the document still read back.
        pdf = pikepdf.new()
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/TrueType"),
                BaseFont=Name("/ABCDEF+LigSub"),
                FontDescriptor=Dictionary(Flags=4),
                FirstChar=65,
                Widths=Array([600, 650]),
                ToUnicode=_tounicode_stream(pdf, {65: "A", 66: "B", 200: "fi"}),
            )
        )
        cap = font_capability(font)
        assert cap.decode(bytes([200])) == "fi"
        assert cap.encodable_sequences() == []
        with pytest.raises(ValueError, match="cannot encode"):
            cap.encode("fi")
        assert cap.encode("AB") == b"AB"

    def test_longest_match_precedence_ff_vs_ffi(self):
        pdf = pikepdf.new()
        font = self._identity_font(
            pdf,
            {1: "f", 2: "ff", 3: "ffi", 4: "x"},
            w_array=Array(
                [1, Array([300]), 2, Array([550]), 3, Array([760]), 4, Array([500])]
            ),
        )
        cap = font_capability(font)
        assert set(cap.encodable_sequences()) == {"ff", "ffi"}
        # "ffi" wins over "ff" (+ anything) at the same position.
        assert cap.encode("ffix") == b"\x00\x03\x00\x04"
        # Without the 'i', the next-longest listed sequence matches.
        assert cap.encode("ffx") == b"\x00\x02\x00\x04"
        # Greedy tail: "fff" = "ff" + single 'f'.
        assert cap.encode("fff") == b"\x00\x02\x00\x01"
        assert cap.text_width("ffix") == 760 + 500
        assert cap.text_width("ffx") == 550 + 500

    def test_program_derived_agl_ligature_feeds_the_table(self):
        # The program-derived decode map feeds the SAME
        # construction site, so an AGL component name (f_i → "fi") lands in
        # the ligature table like any ToUnicode multi-char string. Pinned:
        # the table DOES apply to the path.
        pdf = pikepdf.new()
        data = _program_ttf(
            [(3, 0, {0xF041: "f", 0xF042: "i", 0xF043: "f_i"})],
            {"f": 300, "i": 250, "f_i": 500},
        )
        cap = font_capability(_symbolic_program_font(pdf, data))
        assert cap.editable
        assert cap.decode(b"\x43") == "fi"
        assert cap.encodable_sequences() == ["fi"]
        # Longest-first: the ligature code beats the two singles...
        assert cap.encode("fi") == b"\x43"
        # ...which stay independently reachable outside the sequence.
        assert cap.encode("if") == b"\x42\x41"
        assert cap.text_width("fi") == 500  # the ligature code's hmtx advance
        assert cap.text_width("if") == 250 + 300



class TestT8ProgramCmapRecovery:
    """Route 2: an Adobe-Identity-0 subset with NO /ToUnicode recovers
    through the embedded program's own cmap table reversed via /CIDToGIDMap
    — the modern subset majority the registry route cannot serve."""

    def test_identity_subset_with_embedded_program_recovers(self):
        import os
        ttf = os.path.join(
            os.path.dirname(__file__), "..", "resources", "fonts",
            "LiberationSans-Regular.ttf",
        )
        if not os.path.isfile(ttf):
            pytest.skip("bundled edit fonts not provisioned")
        from fontTools.ttLib import TTFont

        tt = TTFont(ttf, lazy=True)
        gid_A = tt.getGlyphID(tt.getBestCmap()[ord("A")])
        with open(ttf, "rb") as f:
            program = f.read()

        pdf = pikepdf.new()
        desc = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/CIDFontType2"),
            BaseFont=Name("/AAAAAA+LiberationSans"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
            DW=1000,
            CIDToGIDMap=Name("/Identity"),
            FontDescriptor=pdf.make_indirect(
                Dictionary(
                    Type=Name("/FontDescriptor"),
                    FontName=Name("/AAAAAA+LiberationSans"),
                    Flags=4,
                    FontFile2=pdf.make_stream(program),
                )
            ),
        )
        font_d = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type0"),
            BaseFont=Name("/AAAAAA+LiberationSans"),
            Encoding=Name("/Identity-H"),
            DescendantFonts=Array([pdf.make_indirect(desc)]),
        )
        cap = font_capability(pdf.make_indirect(font_d))
        assert cap.editable
        # Identity: code == CID == GID; the program's cmap names gid_A as 'A'.
        assert cap.decode(int(gid_A).to_bytes(2, "big")) == "A"


class TestT9BareProgramFonts:
    """Bare-CFF FontFile3 (Type1C) and Type1 /FontFile — both former
    refusals lift via the program's OWN encoding + charstring widths
    (cffLib / t1Lib). The symbolic-no-encoding shape is the exact slot the
    program derivation targets."""

    def _font_with_program(self, pdf, key, raw, subtype_name):
        desc = Dictionary(
            Type=Name("/FontDescriptor"),
            FontName=Name("/BareProg"),
            Flags=4,  # symbolic — forces the program-derivation path
        )
        desc[key] = pdf.make_stream(raw)
        return pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name(subtype_name),
                BaseFont=Name("/BareProg"),
                FontDescriptor=desc,
            )
        )

    def _bare_cff(self):
        """A real bare CFF built with fontTools: 'A' at its standard code."""
        from fontTools.fontBuilder import FontBuilder
        from fontTools.pens.t2CharStringPen import T2CharStringPen

        fb = FontBuilder(1000, isTTF=False)
        fb.setupGlyphOrder([".notdef", "A"])
        fb.setupCharacterMap({ord("A"): "A"})
        charstrings = {}
        for name in (".notdef", "A"):
            pen = T2CharStringPen(600, None)
            pen.moveTo((0, 0))
            pen.lineTo((0, 500))
            pen.lineTo((500, 500))
            pen.closePath()
            charstrings[name] = pen.getCharString()
        fb.setupCFF("BareProg", {}, charstrings, {})
        fb.setupHorizontalMetrics({".notdef": (600, 0), "A": (600, 0)})
        fb.setupHorizontalHeader(ascent=800, descent=-200)
        fb.setupNameTable({"familyName": "BareProg", "styleName": "Regular"})
        fb.setupOS2()
        fb.setupPost()
        # Extract the bare CFF table from the built OTF.
        return fb.font.getTableData("CFF ")

    def test_bare_cff_fontfile3_recovers(self):
        pdf = pikepdf.new()
        font = self._font_with_program(pdf, "/FontFile3", self._bare_cff(), "/Type1")
        cap = font_capability(font)
        assert cap.editable
        # CFF standard encoding puts 'A' at code 65; width from the charstring.
        assert cap.decode(b"\x41") == "A"
        assert cap.char_width("A") == 600

    def test_type1_fontfile_recovers(self):
        # A real Type1 program to read, taken from the Ghostscript the
        # AUTHORITY resolved — the same `Resource/Font` tree every install
        # carries. Sourcing it from a vendored directory would make this
        # test disappear the moment the distribution stops shipping one,
        # and what is under test here is the Type1 reader, not packaging.
        import os
        pfa = ""
        if gs_axis.GS_PATH:
            pfa = os.path.join(
                os.path.dirname(os.path.dirname(gs_axis.GS_PATH)),
                "Resource", "Font", "NimbusRoman-Regular",
            )
        if not pfa or not os.path.isfile(pfa):
            pytest.skip(f"{gs_axis.PRESENT_AXIS_SKIP} (its Type1 fonts are the fixture)")
        with open(pfa, "rb") as f:
            raw = f.read()
        pdf = pikepdf.new()
        font = self._font_with_program(pdf, "/FontFile", raw, "/Type1")
        cap = font_capability(font)
        assert cap.editable
        assert cap.decode(b"\x41") == "A"
        assert cap.char_width("A") > 0


class TestType1EexecTrailerRecovery:
    """A PDF-embedded Type 1 program normally carries NO eexec trailer: ISO
    32000-2:2020, 9.9.1, Table 125 lets `/Length3 0` declare that the 512
    zeros and `cleartomark` were left out for the processor to add. fontTools
    bounds the encrypted section by scanning for exactly those zeros, so
    without them an otherwise complete program does not parse. Regression:
    that failure was swallowed into an empty derivation, and every such font
    — all TeX output, whose CM faces embed this way — reported as having no
    resolvable encoding.

    Each t1Lib parse is a full PostScript interpretation of untrusted bytes,
    so HOW MANY parses, of WHICH bytes, is behaviour under test here, observed
    through the `parses` spy."""

    NAMES = {0x0B: "ff", 0x41: "alpha", 0x42: "beta"}
    WIDTHS = {"ff": 620, "alpha": 700, "beta": 550}
    # code → what the builtin encoding + AGL must yield. 0x41 is NOT "A": the
    # map comes from the font's own /Encoding array, never from the code's
    # ASCII meaning.
    DECODED = {0x0B: "\ufb00", 0x41: "\u03b1", 0x42: "\u03b2"}
    REASON = "no resolvable encoding (symbolic font without ToUnicode)"
    # Written out here rather than imported: a test that reads the constant
    # under test cannot notice the constant changing. No leading separator —
    # the completion appends the fixed content directly (see the newline
    # decision in `_type1_encoding_map`).
    TABLE_125_TRAILER = (b"0" * 64 + b"\n") * 8 + b"cleartomark\n"

    @pytest.fixture
    def parses(self, monkeypatch):
        """Every program handed to t1Lib, in order."""
        from engine import pdf_fonts

        seen: list[bytes] = []
        real = pdf_fonts._parse_type1_program

        def spy(raw):
            seen.append(raw)
            return real(raw)

        monkeypatch.setattr(pdf_fonts, "_parse_type1_program", spy)
        return seen

    def _program(self, **kwargs):
        return _type1_program(self.NAMES, self.WIDTHS, **kwargs)

    def _cap_of(self, program, length1=0, length2=0, **font_kwargs):
        pdf = pikepdf.new()
        return font_capability(
            _symbolic_type1_font(pdf, program, length1, length2, **font_kwargs)
        )

    def _cap(self, program_kwargs=None, **font_kwargs):
        program, length1, length2 = self._program(**(program_kwargs or {}))
        return self._cap_of(program, length1, length2, **font_kwargs), program

    def _assert_derived(self, cap):
        assert cap.editable and cap.reason is None and cap.diagnostic is None
        for code, expected in self.DECODED.items():
            assert cap.decode(bytes([code])) == expected
            assert cap.encode(expected) == bytes([code])
        assert set(cap.encodable()) == set(self.DECODED.values())
        # Charstring advances, keyed by the derived codes (upem 1000).
        assert cap.char_width("\u03b1") == 700
        assert cap.char_width("\u03b2") == 550
        assert cap.char_width("\ufb00") == 620

    # ── which program is parsed: decided by the bytes ─────────────────────

    def test_program_with_its_trailer_parses_as_embedded(self, parses):
        cap, program = self._cap()
        self._assert_derived(cap)
        assert parses == [program]

    def test_program_without_its_trailer_parses_completed(self, parses):
        # The shape a TeX-produced PDF embeds (`/Length3 0`, no trailer). One
        # parse, of exactly the program plus Table 125's fixed content.
        cap, program = self._cap({"trailer_zeros": 0})
        self._assert_derived(cap)
        assert parses == [program + self.TABLE_125_TRAILER]

    def test_truncated_trailer_parses_completed(self, parses):
        # 128 zeros is no zero run fontTools accepts; the leftovers ride along
        # and are discarded past the decrypted `closefile`.
        cap, program = self._cap({"trailer_zeros": 128})
        self._assert_derived(cap)
        assert parses == [program + self.TABLE_125_TRAILER]

    @pytest.mark.parametrize(
        "declared",
        [
            pytest.param(0, id="length3-zero"),
            pytest.param(533, id="length3-positive"),
            pytest.param(_OMIT, id="undeclared"),
        ],
    )
    def test_declared_length3_never_changes_which_program_is_parsed(
        self, parses, declared
    ):
        # The bytes answer what /Length3 only declares. Trusting a false
        # `/Length3 0` would complete a program that kept its trailer — whose
        # second `cleartomark` then fails the parse — and trusting a positive
        # one over a missing trailer would parse a program that cannot parse.
        trailerless, _l1, _l2 = self._program(trailer_zeros=0)
        self._assert_derived(self._cap_of(trailerless, length3=declared))
        assert parses == [trailerless + self.TABLE_125_TRAILER]
        parses.clear()
        complete, _l1, _l2 = self._program()
        self._assert_derived(self._cap_of(complete, length3=declared))
        assert parses == [complete]

    def test_pfb_program_is_never_completed(self, parses):
        # PFB segment headers bound the encrypted part, so t1Lib never scans
        # for the zero run and a segmented program needs no trailer. Nor may
        # one be appended: past the last segment it is not a segment.
        program, length1, length2 = self._program(trailer_zeros=0)
        clear, cipher = program[:length1], program[length1:length1 + length2]
        pfb = (
            b"\x80\x01" + len(clear).to_bytes(4, "little") + clear
            + b"\x80\x02" + len(cipher).to_bytes(4, "little") + cipher
            + b"\x80\x03"
        )
        self._assert_derived(self._cap_of(pfb, length1, length2, length3=0))
        assert parses == [pfb]

    def test_program_without_an_eexec_section_is_not_completed(self, parses):
        raw = b"%!PS-AdobeFont-1.0: NoSection\n/FontType 1 def\n"
        cap = self._cap_of(raw)
        assert parses == [raw]
        assert not cap.editable and cap.reason == self.REASON
        assert cap.diagnostic == (
            "the embedded Type 1 program will not parse "
            "(T1Error: not an encrypted Type 1 font)"
        )

    # ── bounds on work done for untrusted bytes ───────────────────────────

    @pytest.mark.parametrize("over", [0, 1], ids=["at-the-bound", "one-byte-over"])
    def test_program_size_bound(self, parses, monkeypatch, over):
        # The smallest input that proves the bound: the real comparison runs
        # against a lowered limit, so no oversized fixture is needed. Over
        # the bound NOTHING is interpreted — the refusal cannot hang.
        from engine import pdf_fonts

        program, length1, length2 = self._program(trailer_zeros=0)
        monkeypatch.setattr(pdf_fonts, "MAX_TYPE1_PROGRAM_BYTES", len(program) - over)
        cap = self._cap_of(program, length1, length2, widths=[601, 602], first_char=0x41)
        if not over:
            assert cap.editable
            assert len(parses) == 1
            return
        assert parses == []
        assert not cap.editable and cap.reason == self.REASON
        assert cap.diagnostic == (
            f"the embedded Type 1 program is larger than {len(program) - 1} "
            "bytes and was not parsed"
        )
        # /Widths needs no encoding, so the advances survive the refusal.
        assert cap.decoded_width(bytes([0x41])) == pytest.approx(601.0)
        assert cap.decoded_width(bytes([0x42])) == pytest.approx(602.0)

    @pytest.mark.parametrize("with_trailer", [False, True], ids=["trailerless", "with-trailer"])
    @pytest.mark.parametrize("blocks", [64, 65], ids=["at-the-bound", "one-block-over"])
    def test_zero_run_screen(self, parses, with_trailer, blocks):
        # fontTools' own end-of-section scan is quadratic in every zero run
        # shorter than 512, so runs of that kind are counted before it runs:
        # 16-zero blocks outside whole 512-runs, past 64 of them refused
        # unscanned. The two-kilobyte input is the smallest that crosses the
        # bound. A whole trailer's own 32 blocks do not count against it, and
        # the junk sits where a truncated trailer's leftovers would: after
        # the cipher, discarded past `closefile`, so admitted means derived.
        program, length1, length2 = self._program(trailer_zeros=0)
        junk = (b"0" * 16 + b"x") * blocks
        program += junk + (self.TABLE_125_TRAILER if with_trailer else b"")
        cap = self._cap_of(program, length1, length2, widths=[601], first_char=0x41)
        if blocks <= 64:
            self._assert_derived_within_widths(cap)
            expected = program if with_trailer else program + self.TABLE_125_TRAILER
            assert parses == [expected]
            return
        assert parses == []
        assert not cap.editable and cap.reason == self.REASON
        assert cap.diagnostic == (
            "the embedded Type 1 program was not parsed: its encrypted "
            "section holds zero runs no encrypted section has"
        )
        assert cap.decoded_width(bytes([0x41])) == pytest.approx(601.0)

    def _assert_derived_within_widths(self, cap):
        # /Widths [601] from 0x41 restricts ENCODING to that one code.
        assert cap.editable and cap.diagnostic is None
        for code, expected in self.DECODED.items():
            assert cap.decode(bytes([code])) == expected
        assert set(cap.encodable()) == {"\u03b1"}

    # ── the refusal, and what it says ─────────────────────────────────────

    def test_unparseable_program_refuses_naming_the_completion(self, parses):
        # The encrypted section is cut short, so the decrypted
        # `currentfile closefile` no trailer can restore is gone.
        cap, _program = self._cap(
            {"trailer_zeros": 0, "drop_cipher": 400},
            widths=[601, 602],
            first_char=0x41,
        )
        assert len(parses) == 1
        assert not cap.editable and cap.reason == self.REASON
        assert cap.diagnostic == (
            "the embedded Type 1 program will not parse once completed "
            "(T1Error: can't find end of eexec part)"
        )
        # /Widths needs no encoding, so the advances survive the refusal.
        assert cap.decoded_width(bytes([0x41])) == pytest.approx(601.0)

    @pytest.mark.parametrize(
        "trailer_zeros, expected",
        [
            pytest.param(
                512,
                "the embedded Type 1 program will not parse (AssertionError)",
                id="as-embedded",
            ),
            pytest.param(
                0,
                "the embedded Type 1 program will not parse once completed (AssertionError)",
                id="completed",
            ),
        ],
    )
    def test_failure_after_interpretation_names_its_type_only(
        self, parses, trailer_zeros, expected
    ):
        # t1Lib interprets the whole program and only THEN rejects the
        # negative lenIV — an argument-less AssertionError, named by its type
        # with no dangling colon. The clause says whether the program was
        # completed, which separates a failed completion from a program that
        # failed as embedded.
        cap, _program = self._cap({"trailer_zeros": trailer_zeros, "len_iv": -1})
        assert len(parses) == 1
        assert not cap.editable and cap.reason == self.REASON
        assert cap.diagnostic == expected

    def test_diagnostic_never_repeats_the_documents_own_bytes(self, parses):
        # psLib's name error splices the undefined token — the document's
        # bytes — into its message. The TYPE is what travels.
        secret = b"ClientName_Q4_Acquisition_DO_NOT_DISCLOSE"
        cap, _program = self._cap({"trailer_zeros": 0, "clear_extra": [secret]})
        assert not cap.editable and cap.reason == self.REASON
        assert cap.diagnostic == (
            "the embedded Type 1 program will not parse once completed (PSError)"
        )

    @pytest.mark.parametrize(
        "exc, expected",
        [
            pytest.param(
                PermissionError(
                    13, "Permission denied", r"C:\Users\someone\AppData\Local\Temp\tmp1.pfa"
                ),
                "PermissionError",
                id="local-path",
            ),
            pytest.param(ValueError("bad chunk code: b'\\x07'"), "ValueError", id="document-byte"),
            pytest.param(AssertionError(), "AssertionError", id="no-message"),
            pytest.param(
                RuntimeError("dictstack underflow"),
                "RuntimeError: dictstack underflow",
                id="library-constant",
            ),
            pytest.param(
                __import__("binascii").Error("Non-hexadecimal digit found"),
                "binascii.Error",
                id="generic-name-qualified-by-module",
            ),
        ],
    )
    def test_parser_failure_carries_the_type_and_only_constant_text(self, exc, expected):
        from engine.pdf_fonts import _parser_failure

        assert _parser_failure(exc) == expected

    def test_diagnostic_is_clipped(self):
        from engine.pdf_fonts import FontCapability

        cap = FontCapability(False, "r", {}, {}, {}, 500.0, 1, diagnostic="x" * 5000)
        assert cap.diagnostic == "x" * 200 + "…"

    # ── the public surface ────────────────────────────────────────────────

    def _page_pdf(self, tmp_path, name, program_kwargs):
        program, length1, length2 = self._program(**program_kwargs)
        pdf = pikepdf.new()
        font = _symbolic_type1_font(pdf, program, length1, length2)
        page = pdf.add_blank_page(page_size=(200, 200))
        page.obj["/Resources"] = Dictionary(Font=Dictionary(F1=font))
        page.obj["/Contents"] = pdf.make_stream(b"BT /F1 12 Tf 10 100 Td (AB) Tj ET")
        path = tmp_path / name
        pdf.save(path)
        return str(path)

    def test_trailerless_program_lists_editable_through_the_engine_reply(self, tmp_path):
        from engine.text_paragraphs import list_text_paragraphs

        path = self._page_pdf(tmp_path, "derived.pdf", {"trailer_zeros": 0})
        listing = list_text_paragraphs(path, 1)
        assert [(p["text"], p["editable"]) for p in listing["paragraphs"]] == [
            ("\u03b1\u03b2", True)
        ]

    def test_refusal_through_the_engine_reply_carries_no_diagnostic(self, tmp_path):
        # The diagnostic is engine-internal: the reply carries the catalog
        # reason and nothing a surface does not render.
        from engine.text_paragraphs import list_text_paragraphs

        path = self._page_pdf(
            tmp_path, "refused.pdf", {"trailer_zeros": 0, "drop_cipher": 400}
        )
        listing = list_text_paragraphs(path, 1)
        assert len(listing["runs"]) == 1
        run = listing["runs"][0]
        assert run["editable"] is False and run["reason"] == self.REASON
        assert "diagnostic" not in run
        assert all(not p["editable"] for p in listing["paragraphs"])

    def test_declared_widths_win_and_program_widths_fill_the_rest(self):
        cap, _program = self._cap({"trailer_zeros": 0}, widths=[601], first_char=0x41)
        assert cap.editable
        assert cap.decoded_width(bytes([0x41])) == pytest.approx(601.0)  # declared
        assert cap.decoded_width(bytes([0x42])) == pytest.approx(550.0)  # charstring
        # The /Widths subset guard still restricts ENCODING to the declared
        # range, unchanged by the derivation source.
        assert set(cap.encodable()) == {"\u03b1"}


    # ── the interpreter is bounded (a Type 1 program is a PostScript program) ─

    def _hostile(self, body, **kw):
        # A program whose CLEAR TEXT runs `body`, with declared /Widths so the
        # refusal's advances can be checked to survive.
        program, length1, length2 = self._program(
            clear_extra=[body], trailer_zeros=0, **kw
        )
        pdf = pikepdf.new()
        return self._cap_of(
            program, length1, length2, widths=[601, 602], first_char=0x41
        )

    def _assert_bounded_refusal(self, body, expected_diag, **kw):
        import time

        start = time.perf_counter()
        cap = self._hostile(body, **kw)
        elapsed = time.perf_counter() - start
        # Bounded return: the working bound trips in well under a second; the
        # ceiling is generous so a slow machine never flakes. A REMOVED bound
        # does not reach here — it never returns — which is a CI-visible fail,
        # not a silent pass.
        assert elapsed < 8.0, f"took {elapsed:.1f}s"
        assert not cap.editable and cap.reason == self.REASON
        assert cap.diagnostic == expected_diag
        # /Widths needs no encoding, so the advances survive the refusal.
        assert cap.decoded_width(bytes([0x41])) == pytest.approx(601.0)
        assert cap.decoded_width(bytes([0x42])) == pytest.approx(602.0)
        return cap

    def test_infinite_loop_refuses_by_step_budget(self):
        # `0 0 -1 {pop} for` never returns on an unbounded interpreter (the
        # increment is 0, so the counter never reaches the limit).
        self._assert_bounded_refusal(
            b"0 0 -1 {pop} for",
            "the embedded Type 1 program exceeded the interpreter step budget "
            "and was not parsed",
        )

    def test_empty_body_loop_refuses_by_stack_bound(self):
        # `0 0 -1 {} for` calls no `handle_object` (empty body), so only the
        # per-iteration `call_procedure` tick and the operand-stack growth
        # bound it; the stack cap trips first.
        self._assert_bounded_refusal(
            b"0 0 -1 {} for",
            "the embedded Type 1 program overflowed the interpreter stack and "
            "was not parsed",
        )

    def test_array_allocation_bomb_refuses(self):
        self._assert_bounded_refusal(
            b"50000000 array pop",
            "the embedded Type 1 program requested more interpreter memory "
            "than allowed and was not parsed",
        )

    def test_string_allocation_bomb_refuses(self):
        self._assert_bounded_refusal(
            b"400000000 string pop",
            "the embedded Type 1 program requested more interpreter memory "
            "than allowed and was not parsed",
        )

    def test_a_real_font_stays_well_inside_the_budget(self):
        # The guard against a false refusal: the reporter's own program (95
        # glyphs) derives, so the budget is not brushing real work.
        cap, _p = self._cap()
        assert cap.editable and cap.diagnostic is None
        assert len(cap.encodable()) == 3

    # ── the trailer's own whitespace (EEXECEND accepts space/tab/CR/LF) ────

    @pytest.mark.parametrize(
        "sep", [b" ", b"\t", b"\r", b"\r\n"],
        ids=["space", "tab", "cr", "crlf"],
    )
    def test_trailer_whitespace_is_recognized_so_the_program_is_not_completed(
        self, parses, sep
    ):
        # A real trailer's 512 zeros may be split by any of these. If the
        # section screen dropped one from its strip set, the run would look
        # interrupted, the program would be completed, and the second trailer
        # would fail the parse. So: recognized, parsed AS EMBEDDED.
        cap, program = self._cap({"trailer_sep": sep})
        self._assert_derived(cap)
        assert parses == [program]

    # ── a parse that succeeds but maps nothing is not silent ──────────────

    def test_parsed_but_no_mappable_glyph_says_so(self, parses):
        # Real TeX subsets whose glyph names are outside the AGL (e.g. CMEX10's
        # math glyphs) parse but derive no code. That must be distinguishable
        # from "no program", which is the whole point of the diagnostic. Both
        # names here are non-AGL and not uniXXXX forms, so nothing maps.
        program, length1, length2 = _type1_program(
            {0x41: "zzundefinedone", 0x42: "zzundefinedtwo"},
            {"zzundefinedone": 500, "zzundefinedtwo": 500},
            trailer_zeros=0,
        )
        pdf = pikepdf.new()
        cap = font_capability(_symbolic_type1_font(pdf, program, length1, length2))
        assert len(parses) == 1  # it PARSED (one interpretation), then mapped nothing
        assert not cap.editable and cap.reason == self.REASON
        assert cap.diagnostic == (
            "the embedded Type 1 program parsed but names no character "
            "the Adobe Glyph List maps"
        )

    # ── the completion appends no separator (decided on the reviewer's data) ─

    def test_completion_appends_the_fixed_content_with_no_separator(self, parses):
        # Dropping the leading newline is never worse on the corpus and
        # recovers a program cut exactly at its zero run whose last cipher byte
        # is 0x30; the exact-bytes pins across this class already encode it, and
        # this states it directly.
        cap, program = self._cap({"trailer_zeros": 0})
        self._assert_derived(cap)
        assert parses == [program + self.TABLE_125_TRAILER]
        assert parses[0][len(program):len(program) + 1] != b"\n"


class TestCffDefaultCharset:
    """A bare-CFF (Type1C) Top DICT may omit the charset operator, which
    declares the CFF default charset, ISOAdobe. cffLib applies that default
    only when the operator is present with value 0; absent, reading the charset
    raises `AttributeError`, and so does building the CharStrings. The reader
    supplies the default instead of refusing."""

    def _cff_without_charset(self):
        # Every byte generated here; no third-party font is read. FontBuilder
        # always writes a charset operator, so it is removed at the object
        # level before recompiling — the shape a subsetter that relies on the
        # default produces.
        from fontTools.cffLib import CFFFontSet  # noqa: F401
        from fontTools.fontBuilder import FontBuilder
        from fontTools.pens.t2CharStringPen import T2CharStringPen

        order = [".notdef", "A", "B"]
        fb = FontBuilder(1000, isTTF=False)
        fb.setupGlyphOrder(order)
        fb.setupCharacterMap({0x41: "A", 0x42: "B"})
        charstrings = {}
        for name in order:
            pen = T2CharStringPen(600, None)
            pen.moveTo((0, 0))
            pen.lineTo((0, 500))
            pen.lineTo((500, 500))
            pen.closePath()
            charstrings[name] = pen.getCharString()
        fb.setupCFF("BareProg", {}, charstrings, {})
        fb.setupHorizontalMetrics({n: (600, 0) for n in order})
        fb.setupHorizontalHeader(ascent=800, descent=-200)
        fb.setupNameTable({"familyName": "BareProg", "styleName": "Regular"})
        fb.setupOS2()
        fb.setupPost()
        cff = fb.font["CFF "].cff
        top = cff[cff.fontNames[0]]
        _ = top.CharStrings  # realize before mutating
        del top.charset
        top.order = [op for op in top.order if op != "charset"]
        return fb.font.getTableData("CFF ")

    def test_cff_map_recovers_via_the_isoadobe_default(self):
        from engine.pdf_fonts import _cff_encoding_map

        raw = self._cff_without_charset()
        code2uni, widths, diag = _cff_encoding_map(raw)
        # Without a charset, glyphs ARE named by ISOAdobe order, so codes map
        # through it rather than crashing.
        assert diag is None
        assert code2uni  # non-empty
        assert all(isinstance(v, str) and v for v in code2uni.values())

    def test_font_capability_editable_for_a_charsetless_type1c(self):
        pdf = pikepdf.new()
        desc = Dictionary(
            Type=Name("/FontDescriptor"),
            FontName=Name("/BareProg"),
            Flags=4,  # symbolic — forces the program-derivation path
            FontFile3=pdf.make_stream(self._cff_without_charset()),
        )
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type1"),
                BaseFont=Name("/BareProg"),
                FontDescriptor=desc,
            )
        )
        cap = font_capability(font)
        assert cap.editable and cap.reason is None


class TestT7Type3Fonts:
    """Type3 glyph-procedure fonts — the text model is a simple font's;
    widths scale through /FontMatrix (glyph space, not per-mille)."""

    def _type3(self, pdf, *, matrix=(0.01, 0, 0, 0.01, 0, 0), base=None,
               diffs=(65, "/A", "/B"), widths=(60, 55), first=65, tou=None):
        proc = pdf.make_stream(b"60 0 0 0 60 60 d1")
        enc = Dictionary()
        if base is not None:
            enc["/BaseEncoding"] = Name(base)
        if diffs is not None:
            enc["/Differences"] = Array(
                [d if isinstance(d, int) else Name(d) for d in diffs]
            )
        font = Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type3"),
            FontBBox=Array([0, 0, 100, 100]),
            FontMatrix=Array(list(matrix)),
            CharProcs=Dictionary(A=proc, B=proc),
            Encoding=enc,
            FirstChar=first,
            LastChar=first + len(widths) - 1,
            Widths=Array(list(widths)),
        )
        if tou is not None:
            font["/ToUnicode"] = _tounicode_stream(pdf, tou)
        return pdf.make_indirect(font)

    def test_type3_edits_with_matrix_scaled_widths(self):
        pdf = pikepdf.new()
        cap = font_capability(self._type3(pdf))
        assert cap.editable
        assert cap.decode(b"AB") == "AB"
        assert cap.encode("AB") == b"AB"
        # 60 glyph units × (0.01 × 1000) = 600 per-mille.
        assert cap.char_width("A") == 600
        assert cap.char_width("B") == 550

    def test_baseless_differences_never_overclaim(self):
        # Codes OUTSIDE the /Differences must not decode via a Standard
        # fallback the font never declared.
        pdf = pikepdf.new()
        cap = font_capability(self._type3(pdf))
        assert cap.editable
        assert cap.decode(b"\x43") == "�"  # 'C' is not defined here
        with pytest.raises(ValueError):
            cap.encode("C")

    def test_unresolvable_encoding_refuses_then_tounicode_recovers(self):
        # NB: names like /g0 resolve via pdfminer's digit-strip heuristic
        # ('g0'→'g') — the same rule every simple font already gets. These
        # names have no such fallback and genuinely resolve to nothing.
        pdf = pikepdf.new()
        cap = font_capability(self._type3(pdf, diffs=(65, "/qqz1", "/qqz2")))
        assert not cap.editable and "Type3" in (cap.reason or "")
        # The same font WITH a ToUnicode recovers.
        cap2 = font_capability(
            self._type3(pdf, diffs=(65, "/qqz1", "/qqz2"), tou={65: "A", 66: "B"})
        )
        assert cap2.editable
        assert cap2.decode(b"A") == "A"

    def test_malformed_fontmatrix_refuses(self):
        pdf = pikepdf.new()
        font = self._type3(pdf)
        del font["/FontMatrix"]
        cap = font_capability(font)
        assert not cap.editable and "FontMatrix" in (cap.reason or "")
