"""Tests for the font round-trip capability layer (Phase 7.2)."""

from io import BytesIO

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable, table__c_m_a_p
import pikepdf
from pikepdf import Array, Dictionary, Name
import pytest

from engine.pdf_fonts import font_capability, _strip_subset_prefix


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
    """A minimal in-test TrueType (9.B3 zoo): each subtable is
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
    embedded FontFile2 — the exact shape the 9.B3 derivation targets."""
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

    def test_ligature_values_decode_but_do_not_encode(self):
        pdf = pikepdf.new()
        font = self._identity_font(pdf, {7: "fi", 8: "f"})
        cap = font_capability(font)
        assert cap.decode(b"\x00\x07") == "fi"
        # Reverse map is single-char only: 'i' is unreachable.
        assert "i" not in cap.encodable()
        with pytest.raises(ValueError):
            cap.encode("fi")

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


class TestPredefinedCjkCMaps:
    """Phase 9.B2 — Type0 fonts with a named Unicode horizontal CMap."""

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

    def test_vertical_named_cmap_refuses(self):
        pdf = pikepdf.new()
        cap = font_capability(self._cjk_font(pdf, {0x4E2D: "中"}, "UniGB-UCS2-V"))  # noqa: RUF001
        assert not cap.editable and "vertical" in (cap.reason or "")

    def test_non_unicode_legacy_cmap_refuses(self):
        pdf = pikepdf.new()
        cap = font_capability(self._cjk_font(pdf, {0x41: "A"}, "GBK-EUC-H"))
        assert not cap.editable and "encoding" in (cap.reason or "")

    def test_unicode_cmap_without_tounicode_refuses(self):
        pdf = pikepdf.new()
        cap = font_capability(
            self._cjk_font(pdf, {0x4E2D: "中"}, "UniGB-UCS2-H", with_tou=False)  # noqa: RUF001
        )
        assert not cap.editable and "ToUnicode" in (cap.reason or "")

    def test_unknown_cmap_name_refuses_cleanly(self):
        pdf = pikepdf.new()
        cap = font_capability(self._cjk_font(pdf, {0x41: "A"}, "UniBogus-XYZ-H"))
        assert not cap.editable and "encoding" in (cap.reason or "")

    @pytest.mark.parametrize("enc", ["UniGB-UTF8-H", "UniGB-UTF16-H", "UniGB-UTF32-H"])
    def test_non_2byte_unicode_cmaps_refuse_not_corrupt(self, enc):
        # Review-caught CRITICAL: these are Uni*-H but NOT fixed-2-byte
        # (UTF8=3B for CJK, UTF32=4B, UTF16=surrogates), so the 2-byte
        # pipeline would SILENTLY CORRUPT them. Accept boundary is now
        # UCS2-only — they must refuse, never reach editable=True.
        pdf = pikepdf.new()
        cap = font_capability(self._cjk_font(pdf, {0x4E2D: "中"}, enc))  # noqa: RUF001
        assert not cap.editable
        assert "encoding" in (cap.reason or "")

    def test_ucs2_hw_variant_still_accepts(self):
        # -UCS2-HW-H (half-width) is also fixed 2-byte — must stay editable.
        pdf = pikepdf.new()
        cap = font_capability(self._cjk_font(pdf, {0x4E2D: "中"}, "UniJIS-UCS2-HW-H"))  # noqa: RUF001
        assert cap.editable


class TestSymbolicProgramDerivedEncoding:
    """Phase 9.B3 — a symbolic simple font with no usable /Encoding and no
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
    """9.B3 review round: the /Widths subset guard vs degenerate arrays."""

    def test_empty_widths_array_does_not_collapse_encodability(self):
        # Review-caught HIGH: /Widths [] inverted the guard range and
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
        # Review-caught: a partial /Widths discarded real hmtx advances
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

