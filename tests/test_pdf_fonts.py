"""Tests for the font round-trip capability layer (Phase 7.2)."""

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
