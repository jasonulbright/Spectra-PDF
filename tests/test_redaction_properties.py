"""Redaction properties: `/IC`, `/OverlayText`, `/Repeat`, `/Q`
and the size/colour half of `/DA`, on BOTH the mark writer and the applier.

Until this slice the fill was hard-coded `0 0 0 rg` in `redact.py` and
hard-coded `[0,0,0]` in `redact_marks.py` — two copies of a decision the user
never got to make, on a tool where the exemption code printed in the box is
the whole point of the redaction for the person receiving the file.
"""

import os

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine.redact import properties_of, redact
from engine.redact_marks import list_redact_annotations, save_redaction_marks


def _text_pdf(path: str, text: str = "SECRET NAME HERE") -> str:
    doc = pikepdf.new()
    page = doc.add_blank_page(page_size=(400, 400))
    font = doc.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
                   Encoding=Name.WinAnsiEncoding)
    )
    page.Resources = Dictionary(Font=Dictionary(F1=font))
    page.Contents = doc.make_stream(
        f"BT /F1 12 Tf 50 300 Td ({text}) Tj ET".encode("latin-1")
    )
    doc.save(path)
    doc.close()
    return path


def _page_content(path: str) -> bytes:
    with pikepdf.open(path) as pdf:
        return pikepdf.Page(pdf.pages[0]).obj["/Contents"].read_bytes()


class TestPropertiesParsing:
    def test_defaults_are_todays_shipped_look(self):
        props = properties_of({"page": 1, "rect": [0, 0, 1, 1]})
        assert props.fill == (0.0, 0.0, 0.0)
        assert props.overlay_text == ""
        assert props.repeat is False
        assert props.align == 0
        assert props.font_size == 0.0

    def test_text_colour_defaults_by_contrast_not_by_a_fixed_choice(self):
        """A fixed default would draw white on white the first time someone
        chooses a white box — an overlay nobody can read is the same as no
        overlay, on a surface whose job is saying WHY content was removed."""
        assert properties_of({"fill": [0, 0, 0]}).text_color == (1.0, 1.0, 1.0)
        assert properties_of({"fill": [1, 1, 1]}).text_color == (0.0, 0.0, 0.0)
        # An explicit choice always wins over the contrast default.
        assert properties_of({"fill": [0, 0, 0], "text_color": [1, 0, 0]}).text_color == (
            1.0, 0.0, 0.0
        )

    def test_a_bad_alignment_or_size_refuses_by_name(self):
        with pytest.raises(ValueError):
            properties_of({"align": 7})
        with pytest.raises(ValueError):
            properties_of({"font_size": -1})


class TestApplyDrawsTheProperties:
    def test_no_properties_paints_the_plain_black_box_it_always_did(self, tmp_dir):
        src = _text_pdf(os.path.join(tmp_dir, "a.pdf"))
        out = os.path.join(tmp_dir, "a_out.pdf")
        redact(file=src, output=out, regions=[{"page": 1, "rect": [40, 290, 200, 320]}])
        content = _page_content(out)
        assert b"0 0 0 rg" in content
        assert b"BT" not in content.split(b"re f Q")[-1]

    def test_the_fill_colour_reaches_the_page(self, tmp_dir):
        src = _text_pdf(os.path.join(tmp_dir, "b.pdf"))
        out = os.path.join(tmp_dir, "b_out.pdf")
        redact(
            file=src,
            output=out,
            regions=[{"page": 1, "rect": [40, 290, 200, 320], "fill": [1, 1, 1]}],
        )
        assert b"1 1 1 rg" in _page_content(out)

    def test_overlay_text_is_drawn_and_the_content_is_still_gone(self, tmp_dir):
        src = _text_pdf(os.path.join(tmp_dir, "c.pdf"))
        out = os.path.join(tmp_dir, "c_out.pdf")
        result = redact(
            file=src,
            output=out,
            regions=[
                {
                    "page": 1,
                    "rect": [40, 290, 200, 320],
                    "overlay_text": "(b)(6)",
                    "align": 1,
                }
            ],
        )
        assert result["text_runs_removed"] >= 1
        content = _page_content(out)
        assert b"((b)(6)) Tj" not in content  # the parens are escaped
        assert rb"\(b\)\(6\)" in content
        # The overlay is CLIPPED to its own box, so a long code cannot spill
        # over the neighbouring text it was never meant to cover.
        assert b"re W n" in content
        # And the redaction itself still happened.
        from pdfminer.high_level import extract_text

        assert "SECRET" not in extract_text(out)

    def test_repeat_tiles_the_text_over_several_lines(self, tmp_dir):
        src = _text_pdf(os.path.join(tmp_dir, "d.pdf"))
        out = os.path.join(tmp_dir, "d_out.pdf")
        redact(
            file=src,
            output=out,
            regions=[
                {
                    "page": 1,
                    "rect": [40, 200, 360, 340],
                    "overlay_text": "REDACTED ",
                    "repeat_overlay": True,
                    "font_size": 10,
                }
            ],
        )
        content = _page_content(out)
        assert content.count(b"Tm") > 3, "a repeated overlay draws several lines"
        assert content.count(b"REDACTED") >= 2

    def test_an_unknown_alignment_refuses_before_anything_is_written(self, tmp_dir):
        src = _text_pdf(os.path.join(tmp_dir, "e.pdf"))
        out = os.path.join(tmp_dir, "e_out.pdf")
        with pytest.raises(ValueError):
            redact(
                file=src,
                output=out,
                regions=[{"page": 1, "rect": [40, 290, 200, 320], "align": 9}],
            )
        assert not os.path.exists(out)

    def test_non_latin1_overlay_without_a_font_dir_refuses_rather_than_drawing_question_marks(
        self, tmp_dir
    ):
        """the precedent: a code printed as '?' tells the reader nothing, so
        the honest answer is the refusal (and with a font directory it
        embeds)."""
        src = _text_pdf(os.path.join(tmp_dir, "f.pdf"))
        out = os.path.join(tmp_dir, "f_out.pdf")
        with pytest.raises(ValueError):
            redact(
                file=src,
                output=out,
                regions=[
                    {"page": 1, "rect": [40, 290, 200, 320], "overlay_text": "機密"}
                ],
            )


class TestMarksRoundTripTheProperties:
    def test_every_property_survives_save_then_list(self, tmp_dir):
        src = _text_pdf(os.path.join(tmp_dir, "m.pdf"))
        save_redaction_marks(
            src,
            src,
            [
                {
                    "page": 1,
                    "rect": [40, 290, 200, 320],
                    "fill": [0.2, 0.4, 0.6],
                    "overlay_text": "(b)(6)",
                    "repeat_overlay": True,
                    "align": 2,
                    "font_size": 9,
                    "text_color": [1, 1, 0],
                }
            ],
        )
        mark = list_redact_annotations(src)["marks"][0]
        assert mark["fill"] == [0.2, 0.4, 0.6]
        assert mark["overlay_text"] == "(b)(6)"
        assert mark["repeat_overlay"] is True
        assert mark["align"] == 2
        assert mark["font_size"] == 9.0
        assert mark["text_color"] == [1.0, 1.0, 0.0]

    def test_no_overlay_is_not_an_overlay_of_nothing(self, tmp_dir):
        """The reader must not invent the keys the file did not state: an
        absent /OverlayText and an empty one are different claims, and
        defaulting one into the other loses the user's choice on the next
        round trip."""
        src = _text_pdf(os.path.join(tmp_dir, "n.pdf"))
        save_redaction_marks(src, src, [{"page": 1, "rect": [40, 290, 200, 320]}])
        mark = list_redact_annotations(src)["marks"][0]
        assert "overlay_text" not in mark
        assert "repeat_overlay" not in mark
        assert "align" not in mark
        with pikepdf.open(src) as pdf:
            annot = pdf.pages[0].obj["/Annots"][0]
            assert "/OverlayText" not in annot
            assert "/Q" not in annot
            assert "/DA" not in annot

    def test_the_DA_string_is_read_by_operator_not_by_position(self, tmp_dir):
        """A producer writes /DA's operators in whatever order it likes; a
        positional read would take a colour component for a size."""
        from engine.redact_marks import _parse_da

        assert _parse_da("1 0 0 rg /Helv 14 Tf") == {
            "font_size": 14.0,
            "text_color": [1.0, 0.0, 0.0],
        }
        assert _parse_da("/Helv 8 Tf 0.5 g")["text_color"] == [0.5, 0.5, 0.5]

    def test_a_saved_mark_applies_with_the_properties_it_was_saved_with(self, tmp_dir):
        """The point of the round trip: mark, save, reopen, apply — and the
        box the reader sees is the one the marker chose."""
        src = _text_pdf(os.path.join(tmp_dir, "p.pdf"))
        save_redaction_marks(
            src,
            src,
            [
                {
                    "page": 1,
                    "rect": [40, 290, 200, 320],
                    "fill": [1, 1, 1],
                    "overlay_text": "(b)(6)",
                }
            ],
        )
        listed = list_redact_annotations(src)["marks"]
        out = os.path.join(tmp_dir, "p_out.pdf")
        redact(file=src, output=out, regions=listed)
        content = _page_content(out)
        assert b"1 1 1 rg" in content
        assert rb"\(b\)\(6\)" in content
