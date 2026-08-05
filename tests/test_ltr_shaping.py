"""Shaping on the LEFT-TO-RIGHT path.

The joining scripts have a shaper because they have no correct
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
from engine.shaping import changed_it as _shaping_changed_it
from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

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
    listed = list_text_paragraphs(str(out), 1)["paragraphs"]
    return _is_shaped(out), (listed[0]["text"] if listed else None)


class TestCombiningMarks:
    """A combining mark must not draw as a spacing glyph."""

    def test_combining_acute_composes_and_round_trips(self, tmp_path):
        shaped, text = _edit(tmp_path, COMBINING)
        assert shaped
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
    """A face carrying `liga` forms its ligatures on an edit."""

    @pytest.mark.skipif(
        not os.path.isfile(LIGA_FACE), reason="Libertinus not provisioned"
    )
    def test_liga_forms_and_still_extracts_as_letters(self, tmp_path):
        # Proven at the face first, so a failure below is about OUR path and
        # not about a font revision that dropped the feature.
        run = shaping.shape(LIGA_FACE, "office", rtl=False)
        assert len(run.glyphs) < len("office"), "face no longer forms ffi"

        shaped, text = _edit(tmp_path, LIGATURE, family=LIGA_FACE)
        assert shaped
        # Drawn as ligatures, extracted as letters — a search for "office"
        # must still find it.
        assert text == LIGATURE

    def test_a_face_without_liga_synthesises_nothing(self, tmp_path):
        """Liberation has no `liga`, so `office` stays six glyphs — and the
        edit must therefore stay on the old per-character path entirely."""
        assert len(shaping.shape(SANS_FACE, "office", rtl=False).glyphs) == 6
        shaped, text = _edit(tmp_path, LIGATURE)
        assert not shaped
        assert text == LIGATURE


class TestTheLineBetweenThem:
    """The gate that keeps ordinary text on the shipped emission."""

    def test_plain_text_does_not_shape(self, tmp_path):
        shaped, text = _edit(tmp_path, "the quick brown fox")
        assert not shaped
        assert text == "the quick brown fox"

    def test_kerning_alone_is_not_a_reason_to_shape(self):
        # `AVATAR` kerns hard in Liberation Sans — a ~297/1000 em GPOS
        # adjustment. It is still one glyph per character with no offsets,
        # and the character path already applies pair kerning from the same
        # font, so shaping it would change the emission for nothing.
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
    """The shaped-measure fix, at the level it went wrong.

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
            # The transposed-frame scalars the width model reads —
            # for a horizontal member they ARE a and d.
            adv = 1.0
            perp = 1.0
            # Only a tate-chu-yoko block is atomic; an ordinary
            # member measures its characters.
            atomic = False
            style = {
                "size": 10.0, "char_spacing": 0.0, "word_spacing": 0.0,
                "h_scale": 1.0, "font_name": "F1", "fill_color": None,
                "stroke_color": None, "render_mode": 0,
            }

        run = shaping.shape(SANS_FACE, "AVATAR", rtl=False)
        st = _StyleRef(_Member(), ("sans", False, False, (), 0), shaped=run)
        got = _char_width_user("AVATAR", st, {}, 0.0)
        assert got == pytest.approx(run.advance_1000 / 1000.0 * 10.0)


class TestAuthoredTextShapes:
    """The AUTHORING surfaces shape left-to-right too.

    Add Text, watermarks and form-field appearances used to gate all shaping
    on `bidi.has_strong_rtl`, so an accent typed into any of them drew as a
    spacing glyph beside its letter while the paragraph editor composed it
    correctly. One document, two answers, decided by which control you used.
    """

    def _blank(self, tmp_path, name="blank.pdf"):
        src = tmp_path / name
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        pdf.save(str(src))
        pdf.close()
        return str(src)

    def test_add_text_composes_a_combining_accent(self, tmp_path):
        from engine.text_authoring import add_text_box

        src = self._blank(tmp_path, "at-src.pdf")
        out = str(tmp_path / "at.pdf")
        add_text_box(
            src, out, 1, [72, 600, 520, 720], COMBINING, size=18.0,
            font_path=FONTS, family="sans",
        )
        assert _is_shaped(out)
        assert [p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"]] == [
            COMBINING
        ]

    def test_plain_add_text_keeps_the_shipped_emission(self, tmp_path):
        from engine.text_authoring import add_text_box

        src = self._blank(tmp_path, "plain-src.pdf")
        out = str(tmp_path / "plain.pdf")
        add_text_box(
            src, out, 1, [72, 600, 520, 720], "the quick brown fox", size=18.0,
            font_path=FONTS, family="sans",
        )
        # No CIDToGIDMap stream means `_prepare_bidi` returned None and the
        # shipped `build_fallback_font` path ran — the byte-identity property.
        assert not _is_shaped(out)

    def test_a_styled_span_composes_too(self, tmp_path):
        """The span path is a second emitter; it must not disagree."""
        from engine.text_authoring import add_text_box

        src = self._blank(tmp_path, "span-src.pdf")
        out = str(tmp_path / "span.pdf")
        add_text_box(
            src, out, 1, [72, 600, 520, 720], COMBINING, size=18.0,
            font_path=FONTS, family="sans",
            spans=[{"start": 0, "end": 5, "color": [0.8, 0.1, 0.1]}],
        )
        assert _is_shaped(out)
        assert [p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"]] == [
            COMBINING
        ]

    def test_a_style_change_inside_a_word_declines_to_shape(self, tmp_path):
        """A shaped word is drawn WHOLLY in one style, so a word split across
        two cannot be shaped. Declining is the correct answer — the accent
        then draws the way it always did rather than in the wrong colour."""
        from engine.text_authoring import add_text_box

        src = self._blank(tmp_path, "split-src.pdf")
        out = str(tmp_path / "split.pdf")
        add_text_box(
            src, out, 1, [72, 600, 520, 720], COMBINING, size=18.0,
            font_path=FONTS, family="sans",
            # Ends INSIDE "café", between the e and its accent.
            spans=[{"start": 0, "end": 4, "color": [0.8, 0.1, 0.1]}],
        )
        assert not _is_shaped(out)


def _is_shaped(path) -> bool:
    """Did shaping actually happen — judged by the OUTCOME, not the plumbing.

    A shaped run produces at least one glyph standing for more than one
    character (a ligature, or a base composed with its combining mark), and
    that shows up in /ToUnicode as a single code mapping to a multi-character
    string. Nothing on the per-character path can produce one.

    Two earlier discriminators were wrong and both hid real defects: "is
    there a Type0 font" is true of `build_fallback_font` too, so it only
    proved a subset was embedded; "is /CIDToGIDMap a stream" is true only of
    TrueType, because a CFF descendant is a CIDFontType0 and cannot carry one
    at all. This asks the question the feature is actually about.
    """
    import re

    with pikepdf.open(str(path)) as pdf:
        # EVERY font in the document, not just the ones page 1's /Resources
        # can reach: a form-field appearance carries its own /Resources on the
        # /AP stream, so a page-scoped walk reported the form fill unshaped
        # when it had composed the accent correctly. Scoping a check more
        # narrowly than the feature is the same mistake in a smaller hat.
        for obj in pdf.objects:
            if not isinstance(obj, pikepdf.Dictionary):
                continue
            if str(obj.get("/Type", "")) != "/Font":
                continue
            tou = obj.get("/ToUnicode")
            if tou is None:
                continue
            data = bytes(tou.read_bytes()).decode("latin-1")
            for _code, dest in re.findall(r"<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>", data):
                try:
                    text = bytes.fromhex(dest).decode("utf-16-be")
                except (ValueError, UnicodeDecodeError):
                    continue
                if len(text) > 1:
                    return True
    return False


class TestByteEmittersShape:
    """The two surfaces that write appearance-stream BYTES by hand.

    Watermarks and form-field appearances share `engine/rtl_text.py`, which
    used to return None for anything left-to-right. Both are claimed in the
    release notes, so both get a pin: a claim without one is how the first
    two 1.0.12 releases got cancelled.
    """

    def _fixture(self, tmp_path):
        from pikepdf import Dictionary, Name

        src = tmp_path / "wm-src.pdf"
        doc = pikepdf.new()
        font = doc.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1,
                       BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
        )
        page = doc.add_blank_page(page_size=(400, 400))
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(b"BT /F1 12 Tf 50 300 Td (ORIGINAL) Tj ET")
        doc.save(str(src))
        doc.close()
        return str(src)

    def test_a_watermark_composes_a_combining_accent(self, tmp_path):
        from engine.watermark import watermark

        src = self._fixture(tmp_path)
        out = str(tmp_path / "wm.pdf")
        watermark(file=src, output=out, text="cafe\u0301", font_dir=FONTS, angle=0)
        assert _is_shaped(out)

    def test_a_plain_watermark_is_byte_identical(self, tmp_path):
        """The other half, and the reason this is safe to apply everywhere:
        an ordinary stamp must not enter the shaping path at all."""
        from engine.watermark import watermark

        src = self._fixture(tmp_path)
        a = str(tmp_path / "a.pdf")
        watermark(file=src, output=a, text="CONFIDENTIAL", font_dir=FONTS, angle=0)
        assert not _is_shaped(a)

    def test_a_form_value_composes_a_combining_accent(self, tmp_path):
        from engine.forms import fill_form_fields

        form = os.path.join(
            os.path.dirname(__file__), "fixtures", "form-pdflib.pdf"
        )
        if not os.path.isfile(form):
            pytest.skip("form fixture not present")
        out = str(tmp_path / "filled.pdf")
        fill_form_fields(form, out, {"applicant.name": "cafe\u0301"}, font_dir=FONTS)
        assert _is_shaped(out)

    def test_a_plain_form_value_is_byte_identical(self, tmp_path):
        from engine.forms import fill_form_fields

        form = os.path.join(
            os.path.dirname(__file__), "fixtures", "form-pdflib.pdf"
        )
        if not os.path.isfile(form):
            pytest.skip("form fixture not present")
        out = str(tmp_path / "plain.pdf")
        fill_form_fields(form, out, {"applicant.name": "Jane Doe"}, font_dir=FONTS)
        assert not _is_shaped(out)


# ── the one joining script that is not right-to-left ─────────────────────

MONGOLIAN_FACE = os.path.join(FONTS, "NotoSansMongolian-Regular.ttf")
MONGOL_WORD = "ᠮᠣᠩᠭᠣᠯ"


class TestMongolianShaping:
    """Direction is a property of the TEXT, and a COLUMN gets the
    face's own upright punctuation.

    Before this, every shaping site derived direction as `joins or
    has_strong_rtl`, which is right for thirteen of the fourteen joining
    scripts and hands back a REVERSED glyph stream for Mongolian.
    """

    def test_direction_comes_from_the_text(self):
        assert shaping.shapes_right_to_left("مرحبا") is True  # Arabic
        assert shaping.shapes_right_to_left("שלום") is True  # Hebrew, joins nothing
        assert shaping.shapes_right_to_left(MONGOL_WORD) is False  # joins, LTR
        assert shaping.shapes_right_to_left("plain") is False

    def test_the_column_direction_evidence_is_a_text_test(self):
        assert shaping.sets_columns_left_to_right(MONGOL_WORD) is True
        assert shaping.sets_columns_left_to_right("ꡀ") is True  # Phags-pa
        assert shaping.sets_columns_left_to_right("日本語") is False
        assert shaping.sets_columns_left_to_right("2026") is False

    @pytest.mark.skipif(
        not os.path.isfile(MONGOLIAN_FACE),
        reason="edit fonts not provisioned (scripts/sync-edit-fonts.ps1)",
    )
    def test_the_vert_map_is_read_from_gsub_and_covers_punctuation(self):
        # Measured, not assumed (`vert-harvest.local.py`): neither Mongolian
        # face's `vert` touches a single LETTER — both cover only punctuation
        # and brackets. Harvesting the map from a second `ttb` SHAPING pass was
        # proposed on an observation that a letter
        # changed under `ttb`; that difference is the cursive shaper picking
        # other positional forms, not `vert`, and in this face the two passes
        # do not even have the same glyph COUNT (a ligature forms under `ltr`
        # and not under `ttb`). The feature is what we want, so the feature
        # is what we read.
        vmap = shaping.vertical_forms(MONGOLIAN_FACE)
        assert vmap
        for name in shaping.shape(MONGOLIAN_FACE, MONGOL_WORD, rtl=False).glyph_names:
            assert name not in vmap

    @pytest.mark.skipif(
        not os.path.isfile(MONGOLIAN_FACE),
        reason="edit fonts not provisioned (scripts/sync-edit-fonts.ps1)",
    )
    def test_a_column_gets_the_upright_punctuation_and_letters_untouched(self):
        flat = shaping.shape(MONGOLIAN_FACE, "、", rtl=False)
        side = shaping.shape_sideways(MONGOLIAN_FACE, "、")
        assert flat.glyph_names != side.glyph_names
        assert side.glyph_names[0].endswith(".vert")
        # ...and the substituted glyph's advance is the FONT's, not invented.
        assert side.advance_1000 > 0

        letters = shaping.shape(MONGOLIAN_FACE, MONGOL_WORD, rtl=False)
        sideways = shaping.shape_sideways(MONGOLIAN_FACE, MONGOL_WORD)
        assert sideways.glyph_names == letters.glyph_names
        assert sideways.advance_1000 == pytest.approx(letters.advance_1000)

    @pytest.mark.skipif(
        not os.path.isfile(MONGOLIAN_FACE),
        reason="edit fonts not provisioned (scripts/sync-edit-fonts.ps1)",
    )
    def test_the_face_measurement_that_accepted_it(self):
        # The round-trip conditions, as a pin rather than a memory:
        # one ADVANCING glyph per cluster, no `.notdef`, and real per-glyph
        # advances. A face that decomposed a letter into two advancing glyphs
        # could not be spelled back by a per-code /ToUnicode, which is exactly
        # why Noto Sans Arabic lost the comparison.
        for word in (MONGOL_WORD, "ᠨᠠᠷᠠᠨ", "2026", "Latin"):
            run = shaping.shape(MONGOLIAN_FACE, word, rtl=False)
            assert run.glyphs, word
            spelled = [spells for _n, spells in run.clusters if spells]
            advancing = [1 for _n, adv, _x, _y in run.glyphs if adv]
            assert len(advancing) == len(spelled), word
        # Real per-letter advances, not one synthesized number.
        advs = {round(a, 1) for _n, a, _x, _y in shaping.shape(
            MONGOLIAN_FACE, "ᠨᠠᠷᠠᠨ", rtl=False
        ).glyphs}
        assert len(advs) > 1

    @pytest.mark.skipif(
        not os.path.isfile(MONGOLIAN_FACE),
        reason="edit fonts not provisioned (scripts/sync-edit-fonts.ps1)",
    )
    def test_a_vertical_form_with_no_advance_refuses_rather_than_guessing(
        self, monkeypatch
    ):
        # The harvest's one refusal: `vert` names a glyph the face has no
        # `hmtx` entry for. The column's LENGTH is measured from that number,
        # and inventing it is the defect wearing a different hat.
        monkeypatch.setattr(
            shaping, "vertical_forms", lambda _p: {
                n: "nosuchglyph"
                for n in shaping.shape(MONGOLIAN_FACE, MONGOL_WORD, rtl=False).glyph_names
            }
        )
        with pytest.raises(ValueError, match="has no advance"):
            shaping.shape_sideways(MONGOLIAN_FACE, MONGOL_WORD)
