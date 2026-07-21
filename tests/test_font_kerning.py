"""Phase 9.K1/K1b — pair-kerning extraction.

K1 shipped bundled-faces-only. K1b reverses that (DECISIONS #37): editing a
paragraph in the document's OWN font was DESTROYING its kerning — a stream
carrying `[(A) 74 (V) 74 (A) 55 (T) 40 (AR)] TJ` came back as a plain `Tj`
after a no-op re-type — so kerning must come from whatever font the text
actually uses.
"""

import os
from io import BytesIO

import pytest

FONTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts"
)

pytestmark = pytest.mark.skipif(
    not os.path.isfile(os.path.join(FONTS_DIR, "LiberationSans-Regular.ttf")),
    reason="bundled fonts not provisioned",
)

WINDOWS_FONTS = r"C:\Windows\Fonts"


def _system_font(name):
    p = os.path.join(WINDOWS_FONTS, name)
    return p if os.path.isfile(p) else None


def _strip_legacy_kern(path):
    """The font's program with its legacy `kern` table removed, forcing the
    GPOS path — i.e. exactly what a GPOS-only font looks like."""
    from fontTools.ttLib import TTFont

    font = TTFont(path, fontNumber=0, lazy=False)
    if "kern" in font:
        del font["kern"]
    buf = BytesIO()
    font.save(buf)
    font.close()
    return buf.getvalue()


class TestBundledFaces:
    def test_pairs_are_scaled_to_1000ths_of_an_em(self):
        from engine.font_kerning import kern_pairs

        pairs = kern_pairs(os.path.join(FONTS_DIR, "LiberationSerif-Regular.ttf"))
        # Raw A|V is -264 at upem 2048 => -128.90625 per 1000.
        assert pairs[("A", "V")] == pytest.approx(-264 * 1000.0 / 2048.0, abs=0.01)

    def test_a_monospace_face_has_no_pairs(self):
        from engine.font_kerning import kern_pairs

        assert kern_pairs(os.path.join(FONTS_DIR, "LiberationMono-Regular.ttf")) == {}

    def test_a_missing_or_broken_face_degrades_to_no_kerning(self, tmp_dir):
        from engine.font_kerning import kern_pairs

        assert kern_pairs(os.path.join(tmp_dir, "nope.ttf")) == {}
        junk = os.path.join(tmp_dir, "junk.ttf")
        with open(junk, "wb") as fh:
            fh.write(b"not a font")
        assert kern_pairs(junk) == {}


class TestGposExtensionLookups:
    """The K1b catch, and the sharpest one in this module.

    Large fonts routinely hide kerning behind Extension Positioning
    (LookupType 9): the lookup's subtables are thin wrappers whose real
    content is `ExtSubTable`. Reading `sub.Format` off the wrapper yields the
    EXTENSION's format (always 1), so an unwrapped reader mistakes every
    extension subtable for a PairPos format 1, finds no Coverage, and
    extracts NOTHING — silently. Measured: Calibri's entire `kern` feature is
    LookupType 9 wrapping inner PairPos of BOTH formats, and it only appeared
    to work because it also ships a legacy table that takes precedence.
    """

    @pytest.mark.skipif(not _system_font("calibri.ttf"), reason="Calibri not installed")
    def test_gpos_only_font_behind_extension_lookups_still_kerns(self):
        from engine.font_kerning import _EMBEDDED_CACHE, _pairs_from_program

        _EMBEDDED_CACHE.clear()
        pairs = _pairs_from_program(_strip_legacy_kern(_system_font("calibri.ttf")))
        # Without extension unwrapping this is EMPTY, not merely smaller.
        assert len(pairs) > 1000
        assert pairs[("A", "V")] < 0  # tightens
        assert pairs[("T", "o")] < 0

    @pytest.mark.skipif(not _system_font("constan.ttf"), reason="Constantia not installed")
    def test_a_second_gpos_only_font_agrees(self):
        from engine.font_kerning import _EMBEDDED_CACHE, _pairs_from_program

        _EMBEDDED_CACHE.clear()
        pairs = _pairs_from_program(_strip_legacy_kern(_system_font("constan.ttf")))
        assert len(pairs) > 1000
        assert pairs[("A", "V")] < 0


class TestCoverageBits:
    """Legacy `kern` coverage: 0x1 horizontal, 0x2 minimum, 0x4 cross-stream.
    Only horizontal, additive pair kerning may reach a `TJ`."""

    class _Sub:
        def __init__(self, coverage, table):
            self.coverage = coverage
            self.kernTable = table

    class _Font:
        def __init__(self, subs):
            self._subs = subs

        def __getitem__(self, key):
            if key == "kern":
                return type("K", (), {"kernTables": self._subs})()
            raise KeyError(key)

    def _run(self, coverage):
        from engine.font_kerning import _legacy_kern

        font = self._Font([self._Sub(coverage, {("A", "V"): -500})])
        return _legacy_kern(font, {"A": "A", "V": "V"})

    def test_horizontal_additive_accepted(self):
        assert self._run(0x01) == {("A", "V"): -500}

    @pytest.mark.parametrize(
        "coverage,why",
        [(0x05, "cross-stream"), (0x00, "vertical"), (0x03, "minimum")],
    )
    def test_non_horizontal_or_non_additive_excluded(self, coverage, why):
        assert self._run(coverage) == {}, why


class TestDocumentFonts:
    """K1b: the source is whatever font the text actually uses."""

    def _pdf_font(self, embedded=None, base="/Helvetica"):
        import pikepdf
        from pikepdf import Dictionary, Name

        pdf = pikepdf.new()
        desc = None
        if embedded is not None:
            stream = pdf.make_stream(embedded)
            desc = pdf.make_indirect(
                Dictionary(Type=Name("/FontDescriptor"), FontName=Name(base), FontFile2=stream)
            )
        d = {"Type": Name("/Font"), "Subtype": Name("/TrueType"), "BaseFont": Name(base)}
        if desc is not None:
            d["FontDescriptor"] = desc
        return pdf, pdf.make_indirect(Dictionary(**d))

    def test_embedded_program_is_the_kern_source(self):
        from engine.font_kerning import kern_pairs_for_font

        with open(os.path.join(FONTS_DIR, "LiberationSerif-Regular.ttf"), "rb") as fh:
            raw = fh.read()
        pdf, font = self._pdf_font(embedded=raw, base="/Whatever")
        try:
            pairs = kern_pairs_for_font(font, FONTS_DIR)
            # The EMBEDDED serif face's value, not the sans metric twin's.
            assert pairs[("A", "V")] == pytest.approx(-128.9, abs=0.5)
        finally:
            pdf.close()

    def test_non_embedded_standard14_falls_back_to_its_metric_twin(self):
        # Helvetica ships no program and our Core14 metrics carry no kern
        # pairs, so the kerning its METRICS imply comes from Liberation Sans
        # — the face B1 vendored for exactly that compatibility.
        from engine.font_kerning import kern_pairs, kern_pairs_for_font

        pdf, font = self._pdf_font(base="/Helvetica")
        try:
            pairs = kern_pairs_for_font(font, FONTS_DIR)
            twin = kern_pairs(os.path.join(FONTS_DIR, "LiberationSans-Regular.ttf"))
            assert pairs[("A", "V")] == pytest.approx(twin[("A", "V")], abs=0.01)
        finally:
            pdf.close()

    def test_a_serif_standard14_picks_the_serif_twin(self):
        from engine.font_kerning import kern_pairs, kern_pairs_for_font

        pdf, font = self._pdf_font(base="/Times-Roman")
        try:
            pairs = kern_pairs_for_font(font, FONTS_DIR)
            serif = kern_pairs(os.path.join(FONTS_DIR, "LiberationSerif-Regular.ttf"))
            assert pairs[("A", "V")] == pytest.approx(serif[("A", "V")], abs=0.01)
        finally:
            pdf.close()

    def test_a_courier_standard14_gets_no_kerning(self):
        # Its twin is Liberation Mono, which correctly has none.
        from engine.font_kerning import kern_pairs_for_font

        pdf, font = self._pdf_font(base="/Courier")
        try:
            assert kern_pairs_for_font(font, FONTS_DIR) == {}
        finally:
            pdf.close()

    def test_a_damaged_embedded_program_falls_back_rather_than_raising(self):
        from engine.font_kerning import kern_pairs_for_font

        pdf, font = self._pdf_font(embedded=b"not a font at all", base="/Helvetica")
        try:
            pairs = kern_pairs_for_font(font, FONTS_DIR)
            assert pairs  # fell through to the metric twin
        finally:
            pdf.close()

    def test_no_font_dir_and_no_program_means_no_kerning(self):
        from engine.font_kerning import kern_pairs_for_font

        pdf, font = self._pdf_font(base="/Helvetica")
        try:
            assert kern_pairs_for_font(font, "") == {}
        finally:
            pdf.close()


class TestSignAndMeasure:
    def test_tj_offset_negates_so_a_tightening_pair_moves_the_glyph_left(self):
        from engine.font_kerning import tj_offset

        # A TJ number is SUBTRACTED from the displacement, so a POSITIVE
        # number pulls the next glyph left. Kerns are negative to tighten.
        assert tj_offset(-128.9) == pytest.approx(128.9)
        assert tj_offset(0.0) == 0.0

    def test_kerned_width_sums_only_adjacent_pairs(self):
        from engine.font_kerning import kerned_width

        pairs = {("A", "V"): -100.0, ("V", "A"): -50.0}
        assert kerned_width(pairs, "AVA") == pytest.approx(-150.0)
        assert kerned_width(pairs, "A") == 0.0
        assert kerned_width(pairs, "") == 0.0
        assert kerned_width({}, "AVA") == 0.0
