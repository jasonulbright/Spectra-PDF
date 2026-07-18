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

    def test_index_out_of_range_fails_closed(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (Hi) Tj ET", {"/F1": _helv(pdf)})
        pdf.save(src)
        pdf.close()
        with pytest.raises(ValueError, match="out of range"):
            replace_text_run(src, os.path.join(tmp_dir, "o.pdf"), 1, 5, "X")
