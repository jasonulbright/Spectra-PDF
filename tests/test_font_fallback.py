"""Tests for the replacement-font fallback (Phase 7.4)."""

import os

import pikepdf
from pikepdf import Dictionary, Name
import pytest

from engine.extract_text import extract_text
from engine.text_runs import convert_text_run, list_text_runs

# The vendored fallback font (scripts/sync-edit-fonts.ps1). Skip like the
# gs-backed tests when unprovisioned — and per the punchlist dev-notes
# rule, a recorded gate count must come from a run WITHOUT skips.
FONT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "resources",
    "fonts",
    "LiberationSans-Regular.ttf",
)

pytestmark = pytest.mark.skipif(
    not os.path.isfile(FONT), reason="bundled fallback font not provisioned"
)


def _helv(pdf) -> pikepdf.Object:
    return pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type1"),
            BaseFont=Name("/Helvetica"),
            Encoding=Name("/WinAnsiEncoding"),
        )
    )


def _page(pdf, content: bytes):
    page = pdf.add_blank_page(page_size=(612, 792))
    page.obj["/Resources"] = Dictionary(Font=Dictionary(F1=_helv(pdf)))
    page.Contents = pdf.make_stream(content)
    return page


class TestConvertTextRun:
    def test_converts_unencodable_text_and_stays_extractable(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (Hello) Tj 40 0 Td (World) Tj ET")
        pdf.save(src)
        pdf.close()

        # '→' is not in WinAnsi — the normal replace refuses; convert works.
        convert_text_run(src, out, 1, 0, "A → B", FONT)
        text = extract_text(out)["text"]
        assert "A → B" in text  # ToUnicode round-trips through pdfminer
        assert "World" in text  # the follower survived

    def test_follower_font_is_restored(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (Hello) Tj 40 0 Td (World) Tj ET")
        pdf.save(src)
        pdf.close()
        convert_text_run(src, out, 1, 0, "→", FONT)
        # The follower run still lists under the ORIGINAL font and stays
        # editable in it.
        runs = list_text_runs(out, 1)["runs"]
        world = next(r for r in runs if r["text"] == "World")
        assert world["font_name"] == "/F1"
        assert world["editable"]
        # And the converted run's font is the subset-tagged fallback.
        converted = next(r for r in runs if "→" in r["text"])
        assert converted["font_name"].startswith("/EditFb")

    def test_delta_shifts_the_same_line_anchor(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (Hello) Tj 40 0 Td (World) Tj ET")
        pdf.save(src)
        pdf.close()
        convert_text_run(src, out, 1, 0, "→", FONT)
        runs = list_text_runs(out, 1)["runs"]
        converted = next(r for r in runs if "→" in r["text"])
        world = next(r for r in runs if r["text"] == "World")
        arrow_w = converted["rect"][2] - converted["rect"][0]
        # Hello was 27.336 wide; the follower moved by (arrow_w - 27.336).
        assert world["rect"][0] == pytest.approx(112 + (arrow_w - 27.336), abs=0.35)

    def test_nested_form_convert_touches_one_draw(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        helv = _helv(pdf)
        form = pdf.make_stream(b"BT /F1 12 Tf 0 0 Td (Stamp) Tj ET")
        form["/Type"] = Name("/XObject")
        form["/Subtype"] = Name("/Form")
        form["/BBox"] = pikepdf.Array([0, 0, 200, 20])
        form["/Resources"] = Dictionary(Font=Dictionary(F1=helv))
        form_i = pdf.make_indirect(form)
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = Dictionary(XObject=Dictionary(Fm=form_i))
        page.Contents = pdf.make_stream(
            b"q 1 0 0 1 50 700 cm /Fm Do Q q 1 0 0 1 50 100 cm /Fm Do Q"
        )
        pdf.save(src)
        pdf.close()

        convert_text_run(src, out, 1, 1, "→", FONT)
        runs = list_text_runs(out, 1)["runs"]
        assert runs[0]["text"] == "Stamp"  # first draw untouched
        assert "→" in runs[1]["text"]
        # The ORIGINAL form's resources gained no fallback font (the copy
        # got it) — other documents sharing the form stay byte-identical.
        with pikepdf.open(out) as p2:
            orig_form = p2.pages[0].obj["/Resources"]["/XObject"]["/Fm"]
            form_fonts = {str(k) for k in orig_form["/Resources"]["/Font"].keys()}
            assert form_fonts == {"/F1"}

    def test_fallback_missing_char_fails_closed(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (Hi) Tj ET")
        pdf.save(src)
        pdf.close()
        # Liberation Sans has no CJK coverage — must refuse, naming it.
        with pytest.raises(ValueError, match="fallback font cannot express"):
            convert_text_run(src, os.path.join(tmp_dir, "o.pdf"), 1, 0, "漢", FONT)

    def test_nested_edits_leave_no_orphaned_copies(self, tmp_dir):
        """Resource hygiene (review-MEASURED: every nested edit left the
        prior form copy embedded; converts stranded a font subset each).
        A single-draw form edited twice: the superseded entries and their
        subtrees must be GONE from the saved file."""
        src = os.path.join(tmp_dir, "t.pdf")
        out1 = os.path.join(tmp_dir, "o1.pdf")
        out2 = os.path.join(tmp_dir, "o2.pdf")
        pdf = pikepdf.new()
        helv = _helv(pdf)
        form = pdf.make_stream(b"BT /F1 12 Tf 0 0 Td (One) Tj 30 0 Td (Two) Tj ET")
        form["/Type"] = Name("/XObject")
        form["/Subtype"] = Name("/Form")
        form["/BBox"] = pikepdf.Array([0, 0, 200, 20])
        form["/Resources"] = Dictionary(Font=Dictionary(F1=helv))
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = Dictionary(
            XObject=Dictionary(Fm=pdf.make_indirect(form))
        )
        page.Contents = pdf.make_stream(b"q 1 0 0 1 50 700 cm /Fm Do Q")
        pdf.save(src)
        pdf.close()

        from engine.text_runs import replace_text_run

        replace_text_run(src, out1, 1, 0, "Uno")
        convert_text_run(out1, out2, 1, 1, "→", FONT)
        with pikepdf.open(out2) as p2:
            xo = p2.pages[0].obj["/Resources"]["/XObject"]
            keys = {str(k) for k in xo.keys()}
            # Exactly ONE live form copy; the original /Fm and the first
            # edit's copy are both gone (superseded + unreferenced).
            assert len(keys) == 1, keys
            assert "/Fm" not in keys
            # And exactly one embedded fallback font subset in the file.
            fontfiles = sum(
                1
                for obj in p2.objects
                if isinstance(obj, pikepdf.Stream) and "/Length1" in obj
            )
            assert fontfiles == 1

    def test_two_level_nesting_leaves_outer_original_untouched(self, tmp_dir):
        """Page→FormA→FormB→text: editing inside FormB must not add ANY
        entry to FormA's ORIGINAL resources (review-caught by identity
        trace: the staging rule — copies register into the CALLER'S copy)."""
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        helv = _helv(pdf)
        form_b = pdf.make_stream(b"BT /F1 12 Tf 0 0 Td (Deep) Tj ET")
        form_b["/Type"] = Name("/XObject")
        form_b["/Subtype"] = Name("/Form")
        form_b["/BBox"] = pikepdf.Array([0, 0, 100, 20])
        form_b["/Resources"] = Dictionary(Font=Dictionary(F1=helv))
        form_a = pdf.make_stream(b"q 1 0 0 1 10 0 cm /FB Do Q")
        form_a["/Type"] = Name("/XObject")
        form_a["/Subtype"] = Name("/Form")
        form_a["/BBox"] = pikepdf.Array([0, 0, 120, 20])
        form_a["/Resources"] = Dictionary(XObject=Dictionary(FB=pdf.make_indirect(form_b)))
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = Dictionary(
            XObject=Dictionary(FA=pdf.make_indirect(form_a))
        )
        page.Contents = pdf.make_stream(b"q 1 0 0 1 50 700 cm /FA Do Q")
        pdf.save(src)
        pdf.close()

        convert_text_run(src, out, 1, 0, "→", FONT)
        r = list_text_runs(out, 1)["runs"]
        assert "→" in r[0]["text"]
        with pikepdf.open(out) as p2:
            xo = p2.pages[0].obj["/Resources"]["/XObject"]
            live = [k for k in xo.keys()]
            # One live outer copy at page level; walk into it and assert
            # the chain is copies all the way down, while any surviving
            # ORIGINAL FormA object in the file keeps exactly its original
            # resource set.
            assert len(live) == 1
            # The decisive assertion: no form's resources contain BOTH the
            # original name and an /EditIm sibling (the mutation shape the
            # staging rule forbids).
            for obj in p2.objects:
                if isinstance(obj, pikepdf.Stream) and str(obj.get("/Subtype", "")) == "/Form":
                    res = obj.get("/Resources")
                    inner_xo = res.get("/XObject") if res is not None else None
                    if inner_xo is None:
                        continue
                    keys = {str(k) for k in inner_xo.keys()}
                    assert not (
                        "/FB" in keys and any(k.startswith("/EditIm") for k in keys)
                    ), keys

    def test_astral_chars_refused_before_cmap_generation(self, tmp_dir):
        """Emoji (supplementary plane): Liberation is BMP-only, so the
        coverage refusal must fire — pinned so a future font swap with
        astral coverage revisits the (now-fixed) UTF-16BE CMap path
        consciously."""
        src = os.path.join(tmp_dir, "t.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (Hi) Tj ET")
        pdf.save(src)
        pdf.close()
        with pytest.raises(ValueError, match="cannot express"):
            convert_text_run(src, os.path.join(tmp_dir, "o.pdf"), 1, 0, "😀", FONT)

    def test_convert_with_char_spacing_in_effect(self, tmp_dir):
        """Tc applies per CID code in the fallback math — the follower's
        listed position proves the Δ integrated it."""
        src = os.path.join(tmp_dir, "t.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 2 Tc 72 700 Td (Hello) Tj 60 0 Td (World) Tj ET",
        )
        pdf.save(src)
        pdf.close()
        convert_text_run(src, out, 1, 0, "→→", FONT)
        runs = list_text_runs(out, 1)["runs"]
        converted = next(r for r in runs if "→" in r["text"])
        world = next(r for r in runs if r["text"] == "World")
        conv_w = converted["rect"][2] - converted["rect"][0]
        old_w = (722 + 556 + 222 + 222 + 556) / 1000 * 12 + 2 * 5  # glyphs + Tc*5
        # The follower's Td anchor (72 + 60 = 132) moves by exactly Δ.
        assert world["rect"][0] == pytest.approx(132 + (conv_w - old_w), abs=0.5)

    def test_convert_refuses_uneditable_run(self, tmp_dir):
        """convert_text_run is a registered engine command — it must fail
        CLOSED on a refused-font run like its sibling, never mix an
        estimated old width into Δ (review-caught guard gap)."""
        pdf = pikepdf.new()
        t0 = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type0"),
                BaseFont=Name("/X"),
                Encoding=Name("/Identity-H"),
            )
        )
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = Dictionary(Font=Dictionary(F1=t0))
        page.Contents = pdf.make_stream(b"BT /F1 12 Tf 72 700 Td <00410042> Tj ET")
        src = os.path.join(tmp_dir, "t.pdf")
        pdf.save(src)
        pdf.close()
        with pytest.raises(ValueError, match="ToUnicode|not editable"):
            convert_text_run(src, os.path.join(tmp_dir, "o.pdf"), 1, 0, "X", FONT)

    def test_converted_run_is_normally_editable_again(self, tmp_dir):
        """Round-trip: the fallback embed is Type0+ToUnicode — the converted
        run must list as EDITABLE and accept a plain replace."""
        from engine.text_runs import replace_text_run

        src = os.path.join(tmp_dir, "t.pdf")
        mid = os.path.join(tmp_dir, "m.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (Hello) Tj ET")
        pdf.save(src)
        pdf.close()
        convert_text_run(src, mid, 1, 0, "A→B", FONT)
        runs = list_text_runs(mid, 1)["runs"]
        converted = next(r for r in runs if "→" in r["text"])
        assert converted["editable"]
        assert "→" in converted["encodable"]
        replace_text_run(mid, out, 1, converted["index"], "B→A")
        assert "B→A" in extract_text(out)["text"]

    def test_missing_font_file_fails_closed(self, tmp_dir):
        src = os.path.join(tmp_dir, "t.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (Hi) Tj ET")
        pdf.save(src)
        pdf.close()
        with pytest.raises(ValueError, match="not found"):
            convert_text_run(
                src, os.path.join(tmp_dir, "o.pdf"), 1, 0, "x", os.path.join(tmp_dir, "no.ttf")
            )
