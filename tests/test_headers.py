"""Headers, footers, and Bates numbering."""

import os

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine.extract_text import extract_text
from engine.headers import _anchor, _display_to_user, add_header_footer


def _pdf(path: str, n_pages: int, rotate: int = 0) -> None:
    doc = pikepdf.new()
    for _ in range(n_pages):
        page = doc.add_blank_page(page_size=(600, 800))
        if rotate:
            page.obj["/Rotate"] = rotate
    doc.save(path)
    doc.close()


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


class TestDisplayToUser:
    # The displayed bottom-left corner maps to a different USER corner per
    # /Rotate — this pins the rotation convention the whole feature rests on.
    # Box W=600, H=800.
    @pytest.mark.parametrize(
        "rotate,expected",
        [(0, (0.0, 0.0)), (90, (600.0, 0.0)), (180, (600.0, 800.0)), (270, (0.0, 800.0))],
    )
    def test_displayed_bottom_left_maps_per_rotation(self, rotate, expected):
        ux, uy = _display_to_user(0.0, 0.0, 600.0, 800.0, rotate)
        assert abs(ux - expected[0]) < 1e-6 and abs(uy - expected[1]) < 1e-6

    def test_round_trip_center_is_fixed(self):
        # The centre maps to itself at every rotation.
        for r in (0, 90, 180, 270):
            ux, uy = _display_to_user(300.0, 400.0, 600.0, 800.0, r) if r in (0, 180) \
                else _display_to_user(400.0, 300.0, 600.0, 800.0, r)
            assert abs(ux - 300.0) < 1e-6 and abs(uy - 400.0) < 1e-6


class TestAnchor:
    # Displayed-space baseline anchors: top rows sit high, bottom rows low;
    # left/center/right order left→right. dw=600, dh=800, margin=24, size=10.
    def test_placement_grid(self):
        tw, size, dw, dh, m = 100.0, 10.0, 600.0, 800.0, 24.0
        pos = {p: _anchor(p, tw, size, dw, dh, m) for p in
               ("tl", "tc", "tr", "bl", "bc", "br")}
        # Vertical: top above bottom.
        for col in ("l", "c", "r"):
            assert pos[f"t{col}"][1] > pos[f"b{col}"][1]
        # Horizontal: left < center < right (same for top and bottom rows).
        for row in ("t", "b"):
            assert pos[f"{row}l"][0] < pos[f"{row}c"][0] < pos[f"{row}r"][0]
        # Left is at the margin; right is margin-in from the far edge.
        assert abs(pos["tl"][0] - m) < 1e-6
        assert abs(pos["tr"][0] - (dw - m - tw)) < 1e-6
        assert abs(pos["tc"][0] - (dw - tw) / 2) < 1e-6
        # Bottom baseline sits at the margin.
        assert abs(pos["bl"][1] - m) < 1e-6

    def test_top_inset_follows_the_embedded_face_height(self):
        # A taller embedded face reserves more room at the top, so its
        # ascenders stay inside the margin instead of riding into it. The
        # bottom anchor is a baseline and does not move; the default keeps the
        # standard-14 placement exactly where it was.
        args = (100.0, 10.0, 600.0, 800.0, 24.0)
        assert _anchor("tl", *args, 1.117)[1] < _anchor("tl", *args)[1]
        assert _anchor("bl", *args, 1.117)[1] == _anchor("bl", *args)[1]


class TestHeaderFooter:
    def test_page_and_total_tokens_per_page(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 3)
        r = add_header_footer(
            src, out,
            [{"position": "bc", "text": "Page {page} of {pages}"}],
        )
        assert r["pages_stamped"] == 3
        for p in (1, 2, 3):
            txt = extract_text(out, pages=[p])["text"]
            assert f"Page {p} of 3" in txt

    def test_bates_increments_and_pads(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 3)
        add_header_footer(
            src, out,
            [{"position": "br", "text": "ACME-{bates}"}],
            bates_start=41, bates_digits=6,
        )
        assert "ACME-000041" in extract_text(out, pages=[1])["text"]
        assert "ACME-000043" in extract_text(out, pages=[3])["text"]

    def test_page_range_limits_stamping(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 4)
        r = add_header_footer(
            src, out,
            [{"position": "tc", "text": "HDR{page}"}],
            first_page=2, last_page=3,
        )
        assert r["pages_stamped"] == 2
        assert "HDR1" not in extract_text(out, pages=[1])["text"]
        assert "HDR2" in extract_text(out, pages=[2])["text"]
        assert "HDR3" in extract_text(out, pages=[3])["text"]
        assert "HDR4" not in extract_text(out, pages=[4])["text"]

    def test_bates_counter_follows_range_not_doc(self, tmp_dir):
        # The counter increments once per STAMPED page — page 2 is the first
        # stamped, so it gets bates_start.
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 3)
        add_header_footer(
            src, out, [{"position": "bl", "text": "{bates}"}],
            first_page=2, bates_start=100, bates_digits=3,
        )
        assert "100" in extract_text(out, pages=[2])["text"]
        assert "101" in extract_text(out, pages=[3])["text"]

    def test_multiple_placements_all_drawn(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1)
        add_header_footer(
            src, out,
            [
                {"position": "tl", "text": "TOPLEFT"},
                {"position": "br", "text": "BOTRIGHT"},
            ],
        )
        txt = extract_text(out, pages=[1])["text"]
        assert "TOPLEFT" in txt and "BOTRIGHT" in txt

    def test_rotated_page_still_stamps_extractable_text(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1, rotate=90)
        r = add_header_footer(src, out, [{"position": "bc", "text": "ROT{page}"}])
        assert r["pages_stamped"] == 1
        assert "ROT1" in extract_text(out, pages=[1])["text"]

    def test_bad_position_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 1)
        with pytest.raises(ValueError, match="position"):
            add_header_footer(src, os.path.join(tmp_dir, "o.pdf"),
                              [{"position": "middle", "text": "x"}])

    def test_empty_placements_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 1)
        with pytest.raises(ValueError, match="placement"):
            add_header_footer(src, os.path.join(tmp_dir, "o.pdf"), [])

    def test_in_place_output(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 1)
        r = add_header_footer(src, src, [{"position": "bc", "text": "INPLACE"}])
        assert r["pages_stamped"] == 1
        assert "INPLACE" in extract_text(src, pages=[1])["text"]


_FONTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts"
)
# Guarded on the FACE FILES, never on the directory: release.yml's Verify job
# creates an empty `resources/fonts` stub, so an isdir check passes on a bundle
# that has no fonts at all (the v1.0.18 dead-tag lesson).
_HAS_LATIN = os.path.isfile(os.path.join(_FONTS_DIR, "LiberationSans-Regular.ttf"))
_HAS_CJK = os.path.isfile(os.path.join(_FONTS_DIR, "NotoSansCJKsc-Regular.otf"))
_HAS_ARABIC = os.path.isfile(os.path.join(_FONTS_DIR, "IBMPlexSansArabic-Regular.ttf"))
_HAS_HEBREW = os.path.isfile(os.path.join(_FONTS_DIR, "NotoSansHebrew-Regular.ttf"))


def _form_font(path: str, page: int = 1):
    """(/F0's /Subtype, /F0's objgen, the form's content bytes) for the stamp
    on `page` (1-based). Read INSIDE the open Pdf — a pikepdf object outlives
    its Pdf only as a destroyed handle."""
    with pikepdf.open(path) as pdf:
        xo = pdf.pages[page - 1].obj["/Resources"]["/XObject"]
        form = next(xo[k] for k in xo.keys())
        font = form["/Resources"]["/Font"]["/F0"]
        return str(font["/Subtype"]), font.objgen, form.read_bytes()


class TestNonLatinStamps:
    """Headers, footers and Bates numbering in CJK and RTL.

    The face was resolved with NO text (`_unicode_watermark_face(font_dir)`),
    so `resolve_fallback_font`'s text-driven steps never ran: CJK fell to
    Liberation Sans and died at `fallbackFontCannotExpress`, and RTL never
    reached its face at all. Three sibling emitters — the watermark stamp,
    the form-field appearance and Add Text — already passed both the text and
    the `rtl_ok` opt-in; this surface simply had not been lifted.
    """

    @pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
    def test_cjk_header_embeds_a_covering_face_and_extracts(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 2)
        r = add_header_footer(
            src, out, [{"position": "tc", "text": "第{page}頁 機密"}],
            font_dir=_FONTS_DIR,
        )
        assert r["pages_stamped"] == 2
        assert "第1頁 機密" in extract_text(out, pages=[1])["text"]
        assert "第2頁 機密" in extract_text(out, pages=[2])["text"]
        subtype, _, body = _form_font(out)
        # Type0 = the subsetted embed, and the show is a hex string of real
        # glyph codes — a tofu run would still be Type0, so the extraction
        # above (which reads /ToUnicode) is the half that proves the glyphs.
        assert subtype == "/Type0"
        assert b"> Tj" in body

    @pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
    def test_cjk_bates_stamps(self, tmp_dir):
        # A Bates number on a CJK legal set: the probe substitutes digits for
        # the token, so the face is chosen against the digits too.
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 2)
        add_header_footer(
            src, out, [{"position": "br", "text": "甲事件-{bates}"}],
            bates_start=7, bates_digits=4, font_dir=_FONTS_DIR,
        )
        assert "甲事件-0007" in extract_text(out, pages=[1])["text"]
        assert "甲事件-0008" in extract_text(out, pages=[2])["text"]

    @pytest.mark.skipif(not _HAS_ARABIC, reason="bundled Arabic face not provisioned")
    def test_rtl_header_round_trips_through_the_bidi_lister(self, tmp_dir):
        # Checked through the BIDI-AWARE lister, like the watermark's RTL pin:
        # a plain extractor returns the drawn (visual) order, which is what
        # every real RTL PDF stores. The lister is the reader that undoes it.
        from engine.text_paragraphs import list_text_paragraphs

        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1)
        text = "سري للغاية"
        add_header_footer(src, out, [{"position": "bc", "text": text}],
                          font_dir=_FONTS_DIR)
        listed = [p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"]]
        assert text in listed, listed
        # The joining script is SHAPED and permuted — a TJ array with the
        # shaper's corrections, not the per-character `Tj` this module used to
        # emit for every script.
        _, _, body = _form_font(out)
        assert b"TJ" in body

    @pytest.mark.skipif(not _HAS_HEBREW, reason="bundled Hebrew face not provisioned")
    def test_rtl_non_joining_header_round_trips(self, tmp_dir):
        from engine.text_paragraphs import list_text_paragraphs

        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1)
        add_header_footer(src, out, [{"position": "bc", "text": "סודי"}],
                          font_dir=_FONTS_DIR)
        listed = [p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"]]
        assert "סודי" in listed, listed

    @pytest.mark.skipif(not _HAS_ARABIC, reason="bundled Arabic face not provisioned")
    def test_bates_inside_rtl_text_is_an_ordinary_mixed_line(self, tmp_dir):
        # The numbers are left-to-right runs inside a right-to-left line: the
        # bidi algorithm places them, nothing here invents a rule for it.
        from engine.text_paragraphs import list_text_paragraphs

        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 2)
        add_header_footer(
            src, out, [{"position": "bl", "text": "سري {bates} من {pages}"}],
            bates_start=12, bates_digits=3, font_dir=_FONTS_DIR,
        )
        for page, bates in ((1, "012"), (2, "013")):
            listed = [p["text"] for p in list_text_paragraphs(out, page)["paragraphs"]]
            assert f"سري {bates} من 2" in listed, listed

    @pytest.mark.skipif(
        not (_HAS_CJK and _HAS_ARABIC), reason="bundled faces not provisioned"
    )
    def test_two_placements_resolve_two_faces(self, tmp_dir):
        # One call, a Japanese header and an Arabic footer: no single bundled
        # face expresses both, which is why resolution is per PLACEMENT.
        from engine.text_paragraphs import list_text_paragraphs

        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1)
        add_header_footer(
            src, out,
            [{"position": "tc", "text": "秘密文書"}, {"position": "bc", "text": "سري"}],
            font_dir=_FONTS_DIR,
        )
        assert "秘密文書" in extract_text(out, pages=[1])["text"]
        listed = [p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"]]
        assert "سري" in listed, listed

    @pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
    def test_static_text_embeds_one_font_for_the_document(self, tmp_dir):
        # A static footer draws the same string on every page; one subset for
        # the document, not one per page.
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 3)
        add_header_footer(src, out, [{"position": "bc", "text": "機密"}],
                          font_dir=_FONTS_DIR)
        _, first, _ = _form_font(out, 1)
        _, third, _ = _form_font(out, 3)
        assert first == third

    @pytest.mark.skipif(not _HAS_LATIN, reason="bundled fonts not provisioned")
    def test_latin1_emission_is_unchanged(self, tmp_dir):
        # The whole non-Latin-1 path is gated the way it always was: an
        # ordinary stamp keeps standard-14 Helvetica and its literal-string
        # show, even with a fonts dir passed.
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1)
        add_header_footer(src, out, [{"position": "bc", "text": "Page {page}"}],
                          font_dir=_FONTS_DIR)
        subtype, _, body = _form_font(out)
        assert subtype == "/Type1"
        assert b") Tj" in body and b"TJ" not in body

    def test_non_latin1_without_font_dir_is_still_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1)
        with pytest.raises(ValueError, match="no fallback font is available"):
            add_header_footer(src, out, [{"position": "bc", "text": "第{page}頁"}],
                              font_dir="")
        assert not os.path.exists(out)
