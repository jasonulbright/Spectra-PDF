"""9.T22/T23 — shaping on the LEFT-TO-RIGHT path.

The joining scripts got a shaper in T3 because they have no correct
per-character rendering at all. Latin does — right up until a combining mark
or a ligature is involved, at which point the per-character emission draws a
diacritic as a spacing glyph beside its letter, and never forms a ligature the
face is holding. These pin the two capabilities and, just as importantly, the
line between them and the text that must keep taking the old path unchanged.
"""

import os

import pikepdf
import pytest

from engine import shaping
from engine.text_paragraphs import (
    _shaping_changed_it,
    list_text_paragraphs,
    replace_paragraph_text,
)

FONTS = os.path.join(os.path.dirname(__file__), "..", "resources", "fonts")
LIGA_FACE = os.path.join(FONTS, "LibertinusSerif-Regular.otf")
SANS_FACE = os.path.join(FONTS, "LiberationSans-Regular.ttf")

# e + COMBINING ACUTE ACCENT — decomposed on purpose. The precomposed é is a
# single cmap lookup and was never the problem.
COMBINING = "café and plain"
LIGATURE = "office affluent fifty"

pytestmark = pytest.mark.skipif(
    not os.path.isfile(SANS_FACE),
    reason="edit fonts not provisioned (scripts/sync-edit-fonts.ps1)",
)


def _page(path):
    """A one-line Helvetica page — the ordinary starting point for an edit."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page.Contents = pdf.make_stream(
        b"BT /F1 14 Tf 1 0 0 1 72 700 Tm (placeholder text) Tj ET"
    )
    page.Resources = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(
            F1=pikepdf.Dictionary(
                Type=pikepdf.Name("/Font"),
                Subtype=pikepdf.Name("/Type1"),
                BaseFont=pikepdf.Name("/Helvetica"),
            )
        )
    )
    pdf.save(str(path))
    pdf.close()


def _edit(tmp_path, text, family=None):
    src = tmp_path / "src.pdf"
    out = tmp_path / "out.pdf"
    _page(src)
    para = list_text_paragraphs(str(src), 1)["paragraphs"][0]
    replace_paragraph_text(
        str(src), str(out), 1, para["index"], text,
        [{"start": 0, "end": len(text), "run": para["runs"][0]}],
        para["runs"], para["text"], convert=True, font_path=FONTS,
        **({"family": family} if family else {}),
    )
    with pikepdf.open(str(out)) as pdf:
        fonts = pdf.pages[0]["/Resources"]["/Font"]
        subtypes = {str(k): str(fonts[k].get("/Subtype")) for k in fonts.keys()}
    listed = list_text_paragraphs(str(out), 1)["paragraphs"]
    return subtypes, (listed[0]["text"] if listed else None)


class TestCombiningMarks:
    """T22 — a combining mark must not draw as a spacing glyph."""

    def test_combining_acute_composes_and_round_trips(self, tmp_path):
        subtypes, text = _edit(tmp_path, COMBINING)
        # A shaped subset is a Type0 font: the (glyph, cluster) coding needs
        # two-byte codes and a CIDToGIDMap, which a simple font has no room
        # for. Its presence is the observable proof the shaper ran.
        assert "/Type0" in subtypes.values()
        # And the round trip is exact — the decomposed sequence comes back
        # decomposed. A shaped edit that could not be re-listed would be a
        # one-way trip, which is the whole reason clusters carry spellings.
        assert text == COMBINING

    def test_a_second_edit_of_shaped_text_still_works(self, tmp_path):
        """The output of a shaped edit is an ordinary editable paragraph."""
        src = tmp_path / "src.pdf"
        mid = tmp_path / "mid.pdf"
        out = tmp_path / "out.pdf"
        _page(src)
        para = list_text_paragraphs(str(src), 1)["paragraphs"][0]
        replace_paragraph_text(
            str(src), str(mid), 1, para["index"], COMBINING,
            [{"start": 0, "end": len(COMBINING), "run": para["runs"][0]}],
            para["runs"], para["text"], convert=True, font_path=FONTS,
        )
        p2 = list_text_paragraphs(str(mid), 1)["paragraphs"][0]
        assert p2["text"] == COMBINING
        again = "naïve too"
        replace_paragraph_text(
            str(mid), str(out), 1, p2["index"], again,
            [{"start": 0, "end": len(again), "run": p2["runs"][0]}],
            p2["runs"], p2["text"], convert=True, font_path=FONTS,
        )
        assert list_text_paragraphs(str(out), 1)["paragraphs"][0]["text"] == again


class TestLigatureSynthesis:
    """T23 — a face carrying `liga` forms its ligatures on an edit."""

    @pytest.mark.skipif(
        not os.path.isfile(LIGA_FACE), reason="Libertinus not provisioned"
    )
    def test_liga_forms_and_still_extracts_as_letters(self, tmp_path):
        # Proven at the face first, so a failure below is about OUR path and
        # not about a font revision that dropped the feature.
        run = shaping.shape(LIGA_FACE, "office", rtl=False)
        assert len(run.glyphs) < len("office"), "face no longer forms ffi"

        subtypes, text = _edit(tmp_path, LIGATURE, family=LIGA_FACE)
        assert "/Type0" in subtypes.values()
        # Drawn as ligatures, extracted as letters — a search for "office"
        # must still find it.
        assert text == LIGATURE

    def test_a_face_without_liga_synthesises_nothing(self, tmp_path):
        """Liberation has no `liga`, so `office` stays six glyphs — and the
        edit must therefore stay on the old per-character path entirely."""
        assert len(shaping.shape(SANS_FACE, "office", rtl=False).glyphs) == 6
        subtypes, text = _edit(tmp_path, LIGATURE)
        assert "/Type0" not in subtypes.values()
        assert text == LIGATURE


class TestTheLineBetweenThem:
    """The gate that keeps ordinary text on the shipped emission."""

    def test_plain_text_does_not_shape(self, tmp_path):
        subtypes, text = _edit(tmp_path, "the quick brown fox")
        assert "/Type0" not in subtypes.values()
        assert text == "the quick brown fox"

    def test_kerning_alone_is_not_a_reason_to_shape(self):
        # `AVATAR` kerns hard in Liberation Sans — a ~297/1000 em GPOS
        # adjustment. It is still one glyph per character with no offsets,
        # and the character path already applies pair kerning from the same
        # font (9.K1b), so shaping it would change the emission for nothing.
        run = shaping.shape(SANS_FACE, "AVATAR", rtl=False)
        assert len(run.glyphs) == 6
        assert not _shaping_changed_it(run, "AVATAR")

    def test_a_formed_ligature_is_a_reason_to_shape(self):
        if not os.path.isfile(LIGA_FACE):
            pytest.skip("Libertinus not provisioned")
        run = shaping.shape(LIGA_FACE, "office", rtl=False)
        assert _shaping_changed_it(run, "office")

    def test_a_combining_mark_is_a_reason_to_shape(self):
        run = shaping.shape(SANS_FACE, "café", rtl=False)
        assert _shaping_changed_it(run, "café")

    def test_plain_words_report_no_change(self):
        for word in ("hello", "brown", "fox", "Wave"):
            run = shaping.shape(SANS_FACE, word, rtl=False)
            assert not _shaping_changed_it(run, word), word


class TestShapedMeasureMatchesTheDraw:
    """The 9.T22 measure fix, at the level it went wrong.

    `_pieces` writes each shaped glyph as [-x_off, glyph, x_off + width -
    advance], so the pen's NET movement is the shaper's advance. The width
    model has to sum the same number or wrapping and justification disagree
    with what is actually drawn — and it used to sum the /W widths instead,
    which differs by exactly the GPOS advance deltas.
    """

    def test_the_shaper_advance_differs_from_the_raw_widths(self):
        """The premise: without this, the bug would be invisible."""
        from fontTools.ttLib import TTFont

        run = shaping.shape(SANS_FACE, "AVATAR", rtl=False)
        tt = TTFont(SANS_FACE, fontNumber=0, lazy=True)
        try:
            scale = 1000.0 / tt["head"].unitsPerEm
            raw = sum(round(tt["hmtx"][n][0] * scale, 2) for n, _a, _x, _y in run.glyphs)
        finally:
            tt.close()
        assert abs(run.advance_1000 - raw) > 1.0, "face no longer kerns AVATAR"

    def test_width_model_sums_the_shaper_advance(self):
        from engine.text_paragraphs import _StyleRef, _char_width_user

        class _Member:
            index = 0
            vertical = False
            a = 1.0
            d = 1.0
            style = {
                "size": 10.0, "char_spacing": 0.0, "word_spacing": 0.0,
                "h_scale": 1.0, "font_name": "F1", "fill_color": None,
                "stroke_color": None, "render_mode": 0,
            }

        run = shaping.shape(SANS_FACE, "AVATAR", rtl=False)
        st = _StyleRef(_Member(), ("sans", False, False, (), 0), shaped=run)
        got = _char_width_user("AVATAR", st, {}, 0.0)
        assert got == pytest.approx(run.advance_1000 / 1000.0 * 10.0)
