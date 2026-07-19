"""Tests for text-run listing + replacement (Phase 7.2+7.3)."""

import os

import pikepdf
from pikepdf import Array, Dictionary, Name
import pytest
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTChar

from engine.extract_text import extract_text
from engine.text_runs import list_text_runs, replace_text_run


def _helv(pdf) -> pikepdf.Object:
    return pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type1"),
            BaseFont=Name("/Helvetica"),
            Encoding=Name("/WinAnsiEncoding"),
        )
    )


def _page(pdf, content: bytes, fonts: dict):
    page = pdf.add_blank_page(page_size=(612, 792))
    page.obj["/Resources"] = Dictionary(
        Font=Dictionary(**{k.lstrip("/"): v for k, v in fonts.items()})
    )
    page.Contents = pdf.make_stream(content)
    return page


def _char_x0(path: str, ch: str) -> float:
    for layout in extract_pages(path):
        for element in layout:
            for line in getattr(element, "_objs", []):
                for obj in getattr(line, "_objs", []):
                    if isinstance(obj, LTChar) and obj.get_text() == ch:
                        return obj.x0
    raise AssertionError(f"char {ch!r} not found in {path}")


# Helvetica AFM widths: H=722 e=556 l=222 o=556 i=222 (units/1000).
HELLO_W = (722 + 556 + 222 + 222 + 556) / 1000 * 12  # 27.336
HI_W = (722 + 222) / 1000 * 12  # 11.328


class TestListTextRuns:
    def test_lists_word_per_td_runs_with_geometry(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj 40 0 Td (World) Tj ET",
            {"/F1": _helv(pdf)},
        )
        pdf.save(src)
        pdf.close()
        r = list_text_runs(src, 1)
        assert [run["text"] for run in r["runs"]] == ["Hello", "World"]
        assert all(run["editable"] for run in r["runs"])
        h = r["runs"][0]
        assert h["rect"][0] == pytest.approx(72, abs=0.01)
        assert h["rect"][2] == pytest.approx(72 + HELLO_W, abs=0.05)
        assert h["rect"][1] == pytest.approx(700, abs=0.01)
        assert "A" in h["encodable"]
        w = r["runs"][1]
        assert w["rect"][0] == pytest.approx(112, abs=0.01)  # 72 + Td 40

    def test_tj_kerning_narrows_the_width(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td [(He) 500 (llo)] TJ ET",
            {"/F1": _helv(pdf)},
        )
        pdf.save(src)
        pdf.close()
        r = list_text_runs(src, 1)
        assert r["runs"][0]["text"] == "Hello"
        # 500 thousandths of kern REMOVES 6pt at size 12.
        assert r["runs"][0]["rect"][2] - r["runs"][0]["rect"][0] == pytest.approx(
            HELLO_W - 6.0, abs=0.05
        )


class TestReplaceTextRun:
    def test_replace_shifts_same_line_td_anchor(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj 40 0 Td (World) Tj ET",
            {"/F1": _helv(pdf)},
        )
        pdf.save(src)
        pdf.close()

        replace_text_run(src, out, 1, 0, "Hi")
        assert "Hi" in extract_text(out)["text"]
        assert "Hello" not in extract_text(out)["text"]
        # World's Td anchor pulled back by exactly Δ = HI_W - HELLO_W.
        delta = HI_W - HELLO_W
        assert _char_x0(out, "W") == pytest.approx(112 + delta, abs=0.05)

    def test_delta_applies_once_and_propagates_through_the_td_chain(self, tmp_dir):
        """Td anchors are RELATIVE: one Δ on the first same-line anchor
        carries through the whole chain. Adjusting every Td compounded the
        shift (End moved 2Δ) — proven live pre-fix; pinned here."""
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj 40 0 Td (Mid) Tj 40 0 Td (End) Tj ET",
            {"/F1": _helv(pdf)},
        )
        pdf.save(src)
        pdf.close()
        replace_text_run(src, out, 1, 0, "Hi")
        delta = HI_W - HELLO_W
        assert _char_x0(out, "M") == pytest.approx(112 + delta, abs=0.05)
        assert _char_x0(out, "E") == pytest.approx(152 + delta, abs=0.05)  # ONE delta

    def test_line_change_stops_the_adjustment(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        # Second Td moves DOWN a line (ty != 0) — its anchor must NOT shift.
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj 0 -20 Td (Below) Tj ET",
            {"/F1": _helv(pdf)},
        )
        pdf.save(src)
        pdf.close()
        replace_text_run(src, out, 1, 0, "Hi")
        assert _char_x0(out, "B") == pytest.approx(72, abs=0.05)

    def test_tz_scales_the_delta(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 200 Tz 72 700 Td (Hello) Tj 80 0 Td (World) Tj ET",
            {"/F1": _helv(pdf)},
        )
        pdf.save(src)
        pdf.close()
        replace_text_run(src, out, 1, 0, "Hi")
        delta = (HI_W - HELLO_W) * 2.0  # Tz 200 doubles advances
        assert _char_x0(out, "W") == pytest.approx(72 + 2 * HELLO_W + 80 + delta - 2 * HELLO_W, abs=0.1)

    def test_encoding_refusal_names_the_char(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (Hi) Tj ET", {"/F1": _helv(pdf)})
        pdf.save(src)
        pdf.close()
        with pytest.raises(ValueError, match="cannot encode"):
            replace_text_run(src, os.path.join(tmp_dir, "o.pdf"), 1, 0, "→")

    def test_empty_text_deletes_and_pulls_anchors_back(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj 40 0 Td (World) Tj ET",
            {"/F1": _helv(pdf)},
        )
        pdf.save(src)
        pdf.close()
        replace_text_run(src, out, 1, 0, "")
        assert "Hello" not in extract_text(out)["text"]
        assert _char_x0(out, "W") == pytest.approx(112 - HELLO_W, abs=0.05)

    def test_quote_operator_expands_to_equivalence(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 14 TL 72 700 Td (One) Tj (Two) ' ET",
            {"/F1": _helv(pdf)},
        )
        pdf.save(src)
        pdf.close()
        r = list_text_runs(src, 1)
        assert [run["text"] for run in r["runs"]] == ["One", "Two"]
        replace_text_run(src, out, 1, 1, "Six")
        text = extract_text(out)["text"]
        assert "Six" in text and "Two" not in text
        # The ' advanced a line before showing — the replacement must sit on
        # that same next line (700 - TL 14), not on One's line.
        with pikepdf.open(out) as p2:
            content = pikepdf.unparse_content_stream(
                pikepdf.parse_content_stream(p2.pages[0])
            )
            assert b"T*" in content  # the equivalence-preserving expansion
        r2 = list_text_runs(out, 1)
        assert r2["runs"][1]["rect"][1] == pytest.approx(700 - 14, abs=0.05)

    def test_nested_form_replace_touches_one_draw(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        helv = _helv(pdf)
        form = pdf.make_stream(b"BT /F1 12 Tf 0 0 Td (Stamp) Tj ET")
        form["/Type"] = Name("/XObject")
        form["/Subtype"] = Name("/Form")
        form["/BBox"] = Array([0, 0, 200, 20])
        form["/Resources"] = Dictionary(Font=Dictionary(F1=helv))
        form_i = pdf.make_indirect(form)
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = Dictionary(XObject=Dictionary(Fm=form_i))
        page.Contents = pdf.make_stream(
            b"q 1 0 0 1 50 700 cm /Fm Do Q q 1 0 0 1 50 100 cm /Fm Do Q"
        )
        pdf.save(src)
        pdf.close()

        r = list_text_runs(src, 1)
        assert [run["text"] for run in r["runs"]] == ["Stamp", "Stamp"]
        assert all(run["nested"] for run in r["runs"])
        replace_text_run(src, out, 1, 1, "Draft")
        r2 = list_text_runs(out, 1)
        assert [run["text"] for run in r2["runs"]] == ["Stamp", "Draft"]
        # First draw's geometry untouched.
        assert r2["runs"][0]["rect"][1] == pytest.approx(700, abs=0.05)
        assert r2["runs"][1]["rect"][1] == pytest.approx(100, abs=0.05)

    def test_direct_font_dicts_never_serve_a_stale_capability(self, tmp_dir):
        """DIRECT (non-indirect) /Font entries: the capability cache keyed
        transient wrapper id()s and served the WRONG font's tables —
        review-measured at 22.6% wrong lookups, and a replace would write
        the wrong font's bytes into the file. Alternating direct fonts
        across many runs pins the stable-key fix."""
        src = os.path.join(tmp_dir, "t.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        plain = Dictionary(
            Type=Name("/Font"), Subtype=Name("/Type1"),
            BaseFont=Name("/Helvetica"), Encoding=Name("/WinAnsiEncoding"),
        )
        remapped = Dictionary(
            Type=Name("/Font"), Subtype=Name("/Type1"),
            BaseFont=Name("/Helvetica"),
            Encoding=Dictionary(
                BaseEncoding=Name("/WinAnsiEncoding"),
                Differences=Array([65, Name("/Euro")]),  # 'A' code shows €
            ),
        )
        # DIRECT dicts, deliberately not make_indirect.
        page.obj["/Resources"] = Dictionary(Font=Dictionary(F1=plain, F2=remapped))
        parts = [b"BT "]
        for i in range(30):
            font = b"/F1" if i % 2 == 0 else b"/F2"
            parts.append(font + b" 12 Tf 10 %d Td (A) Tj " % (700 - i * 20))
        parts.append(b"ET")
        page.Contents = pdf.make_stream(b"".join(parts))
        pdf.save(src)
        pdf.close()
        runs = list_text_runs(src, 1)["runs"]
        assert len(runs) == 30
        for i, run in enumerate(runs):
            expected = "A" if i % 2 == 0 else "€"
            assert run["text"] == expected, f"run {i} decoded {run['text']!r}"

    def test_subset_widths_range_gates_encoding(self, tmp_dir):
        """A subset-embedded simple font (narrow /Widths range) must REFUSE
        characters outside the declared range — encode() succeeding for a
        never-subsetted glyph writes .notdef boxes silently (review-caught;
        the phase doc's own glyph-availability promise)."""
        from engine.pdf_fonts import font_capability

        pdf = pikepdf.new()
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"), Subtype=Name("/TrueType"),
                BaseFont=Name("/ABCDEF+Helvetica"),
                Encoding=Name("/WinAnsiEncoding"),
                FirstChar=72,  # 'H'..'I' only
                Widths=Array([722, 222]),
            )
        )
        cap = font_capability(font)
        assert cap.encode("HI") == b"HI"
        with pytest.raises(ValueError, match="cannot encode"):
            cap.encode("z")
        assert "z" not in cap.encodable()
        assert "H" in cap.encodable()

    def test_doublequote_operator_as_edit_target(self, tmp_dir):
        """The \" operator's aw/ac (word/char spacing) must persist through
        the expansion and into the Δ math."""
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(
            pdf,
            b'BT /F1 12 Tf 14 TL 72 700 Td (One) Tj 1 0.5 (Two) " ET',
            {"/F1": _helv(pdf)},
        )
        pdf.save(src)
        pdf.close()
        replace_text_run(src, out, 1, 1, "Six")
        text = extract_text(out)["text"]
        assert "Six" in text and "Two" not in text
        with pikepdf.open(out) as p2:
            content = pikepdf.unparse_content_stream(
                pikepdf.parse_content_stream(p2.pages[0])
            )
            assert b"Tw" in content and b"Tc" in content and b"T*" in content
        r2 = list_text_runs(out, 1)
        assert r2["runs"][1]["rect"][1] == pytest.approx(700 - 14, abs=0.05)

    def test_tj_as_edit_target_delta_includes_original_kern(self, tmp_dir):
        """Replacing a KERNED TJ run: Δ must be computed from the TJ's real
        old width (glyphs + kern), so the follower lands exactly."""
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td [(He) -50 (llo)] TJ 40 0 Td (World) Tj ET",
            {"/F1": _helv(pdf)},
        )
        pdf.save(src)
        pdf.close()
        replace_text_run(src, out, 1, 0, "Hi")
        # Old width = HELLO_W + 50/1000*12 (negative kern WIDENS: -(-50)).
        old_w = HELLO_W + 0.6
        delta = HI_W - old_w
        assert _char_x0(out, "W") == pytest.approx(72 + old_w + 40 + delta - old_w, abs=0.05)

    def test_scaled_form_matrix_replace_shifts_in_device_scale(self, tmp_dir):
        """A form with /Matrix [2 0 0 2 ...]: a Δ inside the form lands 2×
        in device space — the follower's listed rect proves it."""
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        helv = _helv(pdf)
        form = pdf.make_stream(
            b"BT /F1 12 Tf 0 0 Td (Hello) Tj 40 0 Td (World) Tj ET"
        )
        form["/Type"] = Name("/XObject")
        form["/Subtype"] = Name("/Form")
        form["/BBox"] = Array([0, 0, 300, 20])
        form["/Matrix"] = Array([2, 0, 0, 2, 0, 0])
        form["/Resources"] = Dictionary(Font=Dictionary(F1=helv))
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = Dictionary(
            XObject=Dictionary(Fm=pdf.make_indirect(form))
        )
        page.Contents = pdf.make_stream(b"q 1 0 0 1 50 500 cm /Fm Do Q")
        pdf.save(src)
        pdf.close()

        before = list_text_runs(src, 1)["runs"]
        assert before[1]["rect"][0] == pytest.approx(50 + 2 * (40), abs=0.05)
        replace_text_run(src, out, 1, 0, "Hi")
        after = list_text_runs(out, 1)["runs"]
        delta_device = 2 * (HI_W - HELLO_W)
        assert after[1]["rect"][0] == pytest.approx(before[1]["rect"][0] + delta_device, abs=0.1)

    def test_tounicode_encoding_merge_reverse_prefers_lowest_code(self, tmp_dir):
        """The same char reachable via the baseline encoding AND a ToUnicode
        entry at a higher code: encode uses the LOWEST (deterministic)."""
        from engine.pdf_fonts import font_capability
        from tests.test_pdf_fonts import _tounicode_stream

        pdf = pikepdf.new()
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"), Subtype=Name("/Type1"),
                BaseFont=Name("/Helvetica"),
                Encoding=Name("/WinAnsiEncoding"),
            )
        )
        font["/ToUnicode"] = _tounicode_stream(pdf, {200: "A"})
        cap = font_capability(font)
        assert cap.encode("A") == b"A"  # 65 wins over 200
        assert cap.decode(bytes([200])) == "A"  # ...but 200 still decodes

    def test_index_out_of_range_fails_closed(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (Hi) Tj ET", {"/F1": _helv(pdf)})
        pdf.save(src)
        pdf.close()
        with pytest.raises(ValueError, match="out of range"):
            replace_text_run(src, os.path.join(tmp_dir, "o.pdf"), 1, 5, "X")


class TestPredefinedCjkEditing:
    """Phase 9.B2 — end-to-end edit of CJK text under a named Unicode CMap."""

    def _cjk_page(self, pdf, chars, content):
        from tests.test_pdf_fonts import _tounicode_stream

        desc = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/CIDFontType2"),
                BaseFont=Name("/CJKFont"),
                CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"GB1", Supplement=2),
                DW=1000,
            )
        )
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type0"),
                BaseFont=Name("/CJKFont"),
                Encoding=Name("/UniGB-UCS2-H"),
                DescendantFonts=Array([desc]),
                ToUnicode=_tounicode_stream(pdf, chars),
            )
        )
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = Dictionary(Font=Dictionary(F1=font))
        page.Contents = pdf.make_stream(content)
        return page

    def test_lists_and_replaces_cjk_text(self, tmp_dir):
        src = os.path.join(tmp_dir, "cjk.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        # 中 U+4E2D, 文 U+6587, 编 U+7F16, 辑 U+8F91 — all in the ToUnicode.
        chars = {0x4E2D: "中", 0x6587: "文", 0x7F16: "编", 0x8F91: "辑"}  # noqa: RUF001
        # Show "中文" (codes 4e2d 6587).
        self._cjk_page(pdf, chars, b"BT /F1 12 Tf 72 700 Td <4e2d6587> Tj ET")
        pdf.save(src)
        pdf.close()

        runs = list_text_runs(src, 1)["runs"]
        assert runs[0]["text"] == "中文"  # noqa: RUF001
        assert runs[0]["editable"] is True

        # Replace with "编辑" (both in the encodable set). Verification is
        # the RE-LIST round-trip: our encode emits the exact ToUnicode
        # codes for the new chars, which our decode reads back — proving
        # the output's bytes are the correct codes (a real Adobe-GB1
        # viewer then maps them code->CID->glyph via UniGB-UCS2-H).
        # pdfminer's extract_text is NOT used here: for a synthetic
        # glyphless font it renders named-CMap codes as (cid:N), which
        # tests pdfminer's extraction, not our edit.
        replace_text_run(src, out, 1, 0, "编辑")  # noqa: RUF001
        relisted = list_text_runs(out, 1)["runs"]
        assert relisted[0]["text"] == "编辑"  # noqa: RUF001
        assert relisted[0]["editable"] is True
        # The emitted codes ARE the reversed-ToUnicode 2-byte UCS2 values
        # (pikepdf serializes the non-printable string as a hex literal).
        with pikepdf.open(out) as opened:
            content = opened.pages[0].Contents.read_bytes()
        assert b"7f168f91" in content.replace(b" ", b"").lower()
