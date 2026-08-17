"""Tests for the font round-trip capability layer."""

from io import BytesIO

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable, table__c_m_a_p
import pikepdf
from pikepdf import Array, Dictionary, Name
import pytest

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
        import os
        pfa = os.path.join(
            os.path.dirname(__file__), "..", "resources", "ghostscript",
            "Resource", "Font", "NimbusRoman-Regular",
        )
        if not os.path.isfile(pfa):
            pytest.skip("bundled gs Type1 fonts not provisioned")
        with open(pfa, "rb") as f:
            raw = f.read()
        pdf = pikepdf.new()
        font = self._font_with_program(pdf, "/FontFile", raw, "/Type1")
        cap = font_capability(font)
        assert cap.editable
        assert cap.decode(b"\x41") == "A"
        assert cap.char_width("A") > 0


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
