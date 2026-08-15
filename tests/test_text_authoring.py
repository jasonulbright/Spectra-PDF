"""Tests for Add Text — authoring a new text object.

gs-independent but font-dependent: gated on the vendored fallback family
(scripts/sync-edit-fonts.ps1), like test_font_fallback."""

import os
import re

import pikepdf
import pytest

from engine.extract_text import extract_text
from engine.text_authoring import add_text_box, measure_text_box
from engine.text_paragraphs import list_text_paragraphs
from engine.text_runs import list_text_runs

FONTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts"
)

pytestmark = pytest.mark.skipif(
    not os.path.isfile(os.path.join(FONTS_DIR, "LiberationSans-Regular.ttf")),
    reason="bundled fonts not provisioned",
)


def _blank(tmp_dir, name="blank.pdf"):
    src = os.path.join(tmp_dir, name)
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(src)
    pdf.close()
    return src


def _page_content(path):
    with pikepdf.open(path) as pdf:
        contents = pdf.pages[0].obj.get("/Contents")
        if isinstance(contents, pikepdf.Array):
            return b"".join(bytes(s.read_bytes()) for s in contents)
        return contents.read_bytes()


class TestAddText:
    def test_authored_text_lists_as_an_editable_run(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(src, out, 1, [72, 680, 400, 720], "Hello authored world", font_path=FONTS_DIR)
        # Searchable...
        assert "Hello authored world" in extract_text(out)["text"]
        # ...and re-editable by the shipped run editor (no special case).
        runs = list_text_runs(out, 1)["runs"]
        run = next(r for r in runs if "Hello authored world" in r["text"])
        assert run["editable"] is True
        # Positioned at the box's left edge, near its top.
        assert run["rect"][0] == pytest.approx(72, abs=1.0)
        assert run["rect"][1] == pytest.approx(720 - 12, abs=3.0)

    def test_wraps_to_multiple_lines_in_a_narrow_box(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        r = add_text_box(
            src, out, 1, [72, 600, 180, 720],  # 108pt-wide box
            "one two three four five six seven eight nine ten",
            size=12, font_path=FONTS_DIR,
        )
        assert r["lines"] > 1
        # The authored text groups as one editable paragraph on re-list.
        paras = list_text_paragraphs(out, 1)["paragraphs"]
        assert any("one two three" in p["text"] for p in paras)

    def test_family_serif_embeds_a_serif_face(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(src, out, 1, [72, 680, 400, 720], "Serif please", font_path=FONTS_DIR, family="serif")
        with pikepdf.open(out) as pdf:
            fonts = pdf.pages[0]["/Resources"]["/Font"]
            names = [str(fonts[k].get("/BaseFont")) for k in fonts.keys()]
        assert any("LiberationSerif" in n for n in names)

    def test_color_is_applied(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [72, 680, 400, 720], "Red text", color=[1.0, 0.0, 0.0], font_path=FONTS_DIR
        )
        with pikepdf.open(out) as pdf:
            contents = pdf.pages[0].obj.get("/Contents")
            if isinstance(contents, pikepdf.Array):
                content = b"".join(bytes(s.read_bytes()) for s in contents)
            else:
                content = contents.read_bytes()
        assert b"1 0 0 rg" in content

    def test_empty_text_refuses(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="no text"):
            add_text_box(src, out, 1, [72, 680, 400, 720], "   ", font_path=FONTS_DIR)

    def test_does_not_disturb_existing_content(self, tmp_dir):
        # Author onto a page that already has text — the original survives.
        src = os.path.join(tmp_dir, "has.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(
                F1=pdf.make_indirect(
                    pikepdf.Dictionary(
                        Type=pikepdf.Name("/Font"),
                        Subtype=pikepdf.Name("/Type1"),
                        BaseFont=pikepdf.Name("/Helvetica"),
                        Encoding=pikepdf.Name("/WinAnsiEncoding"),
                    )
                )
            )
        )
        page.Contents = pdf.make_stream(b"BT /F1 12 Tf 72 700 Td (Original here) Tj ET")
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(src, out, 1, [72, 500, 400, 540], "Added below", font_path=FONTS_DIR)
        text = extract_text(out)["text"]
        assert "Original here" in text
        assert "Added below" in text

    def test_page_out_of_range_refuses(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="out of range"):
            add_text_box(src, out, 5, [72, 680, 400, 720], "x", font_path=FONTS_DIR)

    def test_honours_hard_line_breaks(self, tmp_dir):
        # A WIDE box would keep these on ONE line; the explicit newline must
        # force the break (the entry control is a textarea — collapsing user
        # breaks would silently discard formatting).
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        r = add_text_box(
            src, out, 1, [72, 600, 540, 720],  # 468pt-wide box — no wrap needed
            "First line here\nSecond line here",
            size=12, font_path=FONTS_DIR,
        )
        assert r["lines"] == 2
        text = extract_text(out)["text"]
        assert "First line here" in text
        assert "Second line here" in text

    def test_keeps_wrapped_text_on_the_page(self, tmp_dir):
        # A short box at the page's very bottom + enough text to wrap several
        # lines would descend below y=0 (invisible) without the on-page shift;
        # the block is moved up so every baseline stays on the sheet.
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [72, 8, 300, 40],  # ~32pt-tall box hugging the bottom
            "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda "
            "mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega",
            size=18, font_path=FONTS_DIR,
        )
        runs = list_text_runs(out, 1)["runs"]
        added = [r for r in runs if any(w in r["text"] for w in ("alpha", "omega", "sigma"))]
        assert added, "authored runs not found"
        # Every authored baseline sits on the page (small descender slack). The
        # un-shifted last baseline would be tens of points below zero.
        assert min(r["rect"][1] for r in added) >= -10

    def test_shields_against_a_dangling_ctm_in_prior_content(self, tmp_dir):
        # A page whose content leaves an UNBALANCED `cm` (2x scale, no closing
        # Q) would, without the q/Q shield, transform our appended object by it
        # — the text would land at double scale + offset. The envelope around
        # the original restores the page-initial CTM first, so our rect/Tm land
        # where asked. (Without the shield this run's x reads ~144, not ~72.)
        src = os.path.join(tmp_dir, "dangling.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(b"q 2 0 0 2 0 0 cm")  # note: no closing Q
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(src, out, 1, [72, 680, 400, 720], "Anchored here", font_path=FONTS_DIR)
        runs = list_text_runs(out, 1)["runs"]
        run = next(r for r in runs if "Anchored here" in r["text"])
        assert run["rect"][0] == pytest.approx(72, abs=2.0)
        assert run["rect"][1] == pytest.approx(720 - 12, abs=3.0)


class TestAddTextRotated:
    """Rotated authoring. Every positional test pins its corner
    anchor with the actual matrix arithmetic in a comment — device points
    computed by hand from Tm × frame, never by intuition."""

    def test_rotate_90_first_line_hugs_the_left_edge(self, tmp_dir):
        # Box [100, 500, 160, 700] (W=60, H=200). 90° reads bottom-to-top:
        # frame [0 1 -1 0 160 500] maps local (x, y) -> (160 - y, 500 + x)
        # — local origin on the bottom-RIGHT corner, +x runs UP the page,
        # +y LEFT. Local layout box: l_w=200 (the drawn HEIGHT) by l_h=60;
        # first baseline Tm [1 0 0 1 0 48] (48 = 60 - 12).
        # Combined = Tm x frame = [0 1 -1 0 112 500]; the em-box corners:
        #   (0, 0)  -> (112, 500)     baseline foot at the box bottom edge
        #   (0, 12) -> (100, 500)     ascent face ON the left edge x=100
        #   (w, 12) -> (100, 500+w)   the line advances UP the page
        # => device rect [100, 500, 112, 500+w]: a TALL 12pt-wide strip
        # hugging the left edge (the 0° top edge, carried there by the CCW
        # quarter turn).
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [100, 500, 160, 700], "Vertical label",
            size=12, font_path=FONTS_DIR, rotate=90,
        )
        runs = list_text_runs(out, 1)["runs"]
        run = next(r for r in runs if "Vertical label" in r["text"])
        x0, y0, x1, y1 = run["rect"]
        assert x0 == pytest.approx(100, abs=1.0)
        assert x1 == pytest.approx(112, abs=1.0)
        assert y0 == pytest.approx(500, abs=1.0)
        assert (y1 - y0) > (x1 - x0)  # rotated: tall, not wide
        assert y1 <= 700 + 1.0  # inside the drawn box
        assert run["editable"] is True  # the run surface still edits it
        # INVERSION: an authored rotated label now GROUPS as a
        # paragraph (admission runs in the member's own transposed frame),
        # so the label is editable as text rather than only as a run box.
        # A 90° CCW quarter turn reads UP the page.
        paras = list_text_paragraphs(out, 1)["paragraphs"]
        rotated = next(p for p in paras if "Vertical label" in p["text"])
        assert rotated["orientation"] == "rotated-ccw"
        assert rotated["editable"] is True

    def test_rotate_180_first_line_hugs_the_bottom_edge(self, tmp_dir):
        # Box [72, 500, 372, 540] (W=300, H=40). 180°: frame
        # [-1 0 0 -1 372 540] maps local (x, y) -> (372 - x, 540 - y) —
        # local origin on the top-RIGHT corner. First baseline
        # Tm [1 0 0 1 0 28] (28 = 40 - 12); combined = [-1 0 0 -1 372 512]:
        #   (0, 0)  -> (372, 512)     baseline foot at the box right edge
        #   (0, 12) -> (372, 500)     ascent face ON the bottom edge y=500
        #   (w, 0)  -> (372-w, 512)   reading right-to-left
        # => device rect [372-w, 500, 372, 512]: the 0° top strip carried
        # to the bottom by the half turn (upside-down text).
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [72, 500, 372, 540], "Upside down",
            size=12, font_path=FONTS_DIR, rotate=180,
        )
        runs = list_text_runs(out, 1)["runs"]
        run = next(r for r in runs if "Upside down" in r["text"])
        x0, y0, x1, y1 = run["rect"]
        assert x1 == pytest.approx(372, abs=1.0)
        assert y0 == pytest.approx(500, abs=1.0)
        assert y1 == pytest.approx(512, abs=1.0)
        assert x0 > 72  # one short line: ends well inside the box

    def test_rotate_270_first_line_hugs_the_right_edge(self, tmp_dir):
        # Box [400, 500, 460, 700] (W=60, H=200). 270° reads top-to-bottom:
        # frame [0 -1 1 0 400 700] maps local (x, y) -> (400 + y, 700 - x)
        # — local origin on the top-LEFT corner, +x runs DOWN the page,
        # +y RIGHT. First baseline Tm [1 0 0 1 0 48] (l_h = W = 60);
        # combined = [0 -1 1 0 448 700]:
        #   (0, 0)  -> (448, 700)     baseline foot at the box top edge
        #   (0, 12) -> (460, 700)     ascent face ON the right edge x=460
        #   (w, 0)  -> (448, 700-w)   the line advances DOWN the page
        # => device rect [448, 700-w, 460, 700] hugging the right edge.
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [400, 500, 460, 700], "Downward",
            size=12, font_path=FONTS_DIR, rotate=270,
        )
        runs = list_text_runs(out, 1)["runs"]
        run = next(r for r in runs if "Downward" in r["text"])
        x0, y0, x1, y1 = run["rect"]
        assert x0 == pytest.approx(448, abs=1.0)
        assert x1 == pytest.approx(460, abs=1.0)
        assert y1 == pytest.approx(700, abs=1.0)
        assert y0 >= 500 - 1.0  # inside the drawn box

    def test_rotate_90_wraps_at_the_box_height(self, tmp_dir):
        # A 40pt-WIDE, 300pt-TALL box at 90° wraps at 300 — the dimension
        # ALONG the reading direction — not 40: the same text at 0° in a
        # 300pt-wide box must produce the IDENTICAL line count, and the
        # same 40pt-wide box at 0° a strictly larger one.
        text = (
            "the quick brown fox jumps over the lazy dog and keeps on "
            "running until the sentence is long enough to wrap"
        )
        src = _blank(tmp_dir)
        r90 = add_text_box(
            src, os.path.join(tmp_dir, "a.pdf"), 1, [100, 400, 140, 700],
            text, size=12, font_path=FONTS_DIR, rotate=90,
        )
        r0_wide = add_text_box(
            src, os.path.join(tmp_dir, "b.pdf"), 1, [100, 400, 400, 700],
            text, size=12, font_path=FONTS_DIR,
        )
        r0_narrow = add_text_box(
            src, os.path.join(tmp_dir, "c.pdf"), 1, [100, 400, 140, 700],
            text, size=12, font_path=FONTS_DIR,
        )
        assert r90["lines"] > 1
        assert r90["lines"] == r0_wide["lines"]
        assert r90["lines"] < r0_narrow["lines"]

    def test_rotate_0_is_byte_identical_to_the_shipped_path(self, tmp_dir):
        # The regression pin: rotate=0 takes the EXACT shipped path — same
        # content-stream bytes as a call without the parameter (whole files
        # differ only by pikepdf's random /ID, so streams compare), and no
        # rotation frame (`cm`) anywhere. Center + a hard break exercise
        # the layout arithmetic, not just a single Tm.
        src = _blank(tmp_dir)
        out_a = os.path.join(tmp_dir, "a.pdf")
        out_b = os.path.join(tmp_dir, "b.pdf")
        add_text_box(
            src, out_a, 1, [72, 600, 300, 720],
            "wrap me across a few lines\nhard break",
            size=13, align="center", font_path=FONTS_DIR,
        )
        add_text_box(
            src, out_b, 1, [72, 600, 300, 720],
            "wrap me across a few lines\nhard break",
            size=13, align="center", font_path=FONTS_DIR, rotate=0,
        )
        assert _page_content(out_a) == _page_content(out_b)
        with pikepdf.open(out_a) as pdf:
            ops = {str(i.operator) for i in pikepdf.parse_content_stream(pdf.pages[0])}
        assert "cm" not in ops

    def test_rotate_refuses_non_numbers_and_takes_any_angle(self, tmp_dir):
        # The four-step domain is lifted (this pin used to refuse 45/-90/
        # 360): any finite number of degrees is a rotation now. The
        # STRICTNESS stays — booleans, strings and non-finite values refuse.
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        for bad in ("90", True, float("nan"), float("inf")):
            with pytest.raises(ValueError, match="rotate"):
                add_text_box(
                    src, out, 1, [72, 600, 300, 720], "x",
                    font_path=FONTS_DIR, rotate=bad,
                )
        # -90 normalizes to the 270 STEP path; 360 to the frameless 0 path.
        add_text_box(src, out, 1, [72, 600, 300, 720], "x", font_path=FONTS_DIR, rotate=-90)
        with pikepdf.open(out) as pdf:
            cms = [
                [float(v) for v in i.operands]
                for i in pikepdf.parse_content_stream(pdf.pages[0])
                if str(i.operator) == "cm"
            ]
        assert [0, -1, 1, 0] == cms[0][:4]  # the 270 step frame
        out2 = os.path.join(tmp_dir, "o2.pdf")
        add_text_box(src, out2, 1, [72, 600, 300, 720], "x", font_path=FONTS_DIR, rotate=360)
        with pikepdf.open(out2) as pdf:
            ops = {str(i.operator) for i in pikepdf.parse_content_stream(pdf.pages[0])}
        assert "cm" not in ops  # 360 ≡ 0: the shipped frameless path

    def test_rotate_90_text_extracts(self, tmp_dir):
        # The ToUnicode surface is orientation-blind: every 90° authored
        # glyph round-trips through plain extraction. Character-exact, not
        # substring: pdfminer's layout analysis shatters non-upright chars
        # into per-glyph fragments in device-y order (the phrase comes back
        # reversed with breaks) — that ordering is the extractor's rotated-
        # layout artifact, not the authored mapping under test. The blank
        # page holds nothing else, so the multiset pins right chars, right
        # counts, and no strays.
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [100, 400, 150, 700], "sideways but searchable",
            font_path=FONTS_DIR, rotate=90,
        )
        extracted = extract_text(out)["text"]
        wanted = "sideways but searchable"
        assert sorted(c for c in extracted if not c.isspace()) == sorted(
            c for c in wanted if not c.isspace()
        )

    def test_rotate_90_shift_up_guard_keeps_text_on_the_sheet(self, tmp_dir):
        # 90° overflow marches out the page's RIGHT edge (local "down" is
        # device +x past the box). A box ending at x=600 on the 612-wide
        # sheet leaves 12pt: unshifted, line n sits at device
        # x1 = 600 - (28 - (n-1)*14.4), so from the 4th line on the strip
        # passes 612 — off the sheet. The local-space guard shifts the
        # block "up" (device: leftward), so every strip stays within the
        # page; the last line lands exactly at x1 = 612.
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [560, 400, 600, 700],
            "alpha beta gamma delta epsilon zeta eta theta iota kappa "
            "lambda mu nu xi omicron pi rho sigma tau upsilon phi chi "
            "psi omega and once more around the alphabet to overflow",
            size=12, font_path=FONTS_DIR, rotate=90,
        )
        runs = list_text_runs(out, 1)["runs"]
        added = [
            r for r in runs
            if any(w in r["text"] for w in ("alpha", "omega", "overflow"))
        ]
        assert added, "authored runs not found"
        assert max(r["rect"][2] for r in added) <= 612 + 0.5


class TestAddTextStyleAndMeasure:
    """Authoring style toggles (bold/italic through the
    styled face ladder) + `measure_text_box` (the card's fit indicator, run
    through the SAME `_layout_box` pass as the commit so they can never
    disagree)."""

    @pytest.mark.parametrize(
        "kw,suffix",
        [
            ({"bold": True}, "-Bold"),
            ({"italic": True}, "-Italic"),
            ({"bold": True, "italic": True}, "-BoldItalic"),
        ],
    )
    def test_style_embeds_the_styled_face(self, tmp_dir, kw, suffix):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [72, 660, 400, 720], "Styled words",
            font_path=FONTS_DIR, family="serif", **kw,
        )
        with pikepdf.open(out) as pdf:
            fonts = pdf.pages[0]["/Resources"]["/Font"]
            names = [str(fonts[k].get("/BaseFont")) for k in fonts.keys()]
        # The subset tag (ABCDEF+) prefixes the face name; the style
        # suffix rides the family, e.g. ABCDEF+LiberationSerif-Bold.
        assert any(f"LiberationSerif{suffix}" in n for n in names), names

    def test_default_style_is_byte_identical_to_the_shipped_path(self, tmp_dir):
        # bold=False/italic=False resolve style_key "regular" — the shipped
        # default — so the no-style call is byte-identical to one passing
        # the explicit False pair (streams compare; whole files differ only
        # by pikepdf's random /ID).
        src = _blank(tmp_dir)
        out_a = os.path.join(tmp_dir, "a.pdf")
        out_b = os.path.join(tmp_dir, "b.pdf")
        add_text_box(src, out_a, 1, [72, 600, 300, 720], "plain words here", size=13, font_path=FONTS_DIR)
        add_text_box(
            src, out_b, 1, [72, 600, 300, 720], "plain words here",
            size=13, font_path=FONTS_DIR, bold=False, italic=False,
        )
        assert _page_content(out_a) == _page_content(out_b)

    def test_style_refuses_non_booleans(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="bold"):
            add_text_box(src, out, 1, [72, 600, 300, 720], "x", font_path=FONTS_DIR, bold=1)
        with pytest.raises(ValueError, match="italic"):
            add_text_box(src, out, 1, [72, 600, 300, 720], "x", font_path=FONTS_DIR, italic="yes")

    @pytest.mark.parametrize(
        "rect,text,kw",
        [
            # plain wrap
            ([72, 400, 260, 720], "one two three four five six seven eight nine ten", {}),
            # rotated (wrap width = box HEIGHT under transposition)
            ([100, 300, 150, 700], "sideways one two three four five six seven eight", {"rotate": 90}),
            # bold (styled widths change the wrap point)
            ([72, 400, 220, 720], "bold one two three four five six seven eight nine", {"bold": True}),
        ],
    )
    def test_measure_line_count_matches_the_authored_output(self, tmp_dir, rect, text, kw):
        # THE agreement pin: measure_text_box reports exactly the line count
        # the authored output actually lists — one shared layout pass, so a
        # divergence is impossible by construction.
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        m = measure_text_box(src, 1, rect, text, size=14, font_path=FONTS_DIR, **kw)
        r = add_text_box(src, out, 1, rect, text, size=14, font_path=FONTS_DIR, **kw)
        assert m["lines"] == r["lines"]

    def test_fits_flips_exactly_at_the_boundary(self, tmp_dir):
        # A wide box so the text stays one line: text_height = 1 * leading =
        # 14 * 1.2 = 16.8. A box exactly 16.8 tall fits (<=); 16.7 does not.
        src = _blank(tmp_dir)
        just = measure_text_box(src, 1, [72, 600, 500, 616.8], "one line", size=14, font_path=FONTS_DIR)
        assert just["lines"] == 1
        assert just["text_height"] == pytest.approx(16.8, abs=0.01)
        assert just["fits"] is True
        under = measure_text_box(src, 1, [72, 600, 500, 616.7], "one line", size=14, font_path=FONTS_DIR)
        assert under["fits"] is False

    def test_measure_refuses_empty_text_and_bad_rotate(self, tmp_dir):
        src = _blank(tmp_dir)
        with pytest.raises(ValueError, match="no text"):
            measure_text_box(src, 1, [72, 600, 300, 720], "   ", font_path=FONTS_DIR)
        with pytest.raises(ValueError, match="rotate"):
            measure_text_box(src, 1, [72, 600, 300, 720], "x", font_path=FONTS_DIR, rotate="45")
        with pytest.raises(ValueError, match="out of range"):
            measure_text_box(src, 9, [72, 600, 300, 720], "x", font_path=FONTS_DIR)

    def test_input_validation_precedes_page_range(self, tmp_dir):
        # Round-31 LOW: the refactor must keep the pre-refactor precedence —
        # a doubly-invalid call surfaces the INPUT-shape error, not the page
        # error (cheap validation before I/O position). Both ops match.
        src = _blank(tmp_dir)  # 1 page
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="no text"):
            add_text_box(src, out, 9, [72, 600, 300, 720], "   ", font_path=FONTS_DIR)
        with pytest.raises(ValueError, match="rotate"):
            add_text_box(src, out, 9, [72, 600, 300, 720], "x", font_path=FONTS_DIR, rotate="45")
        with pytest.raises(ValueError, match="no text"):
            measure_text_box(src, 9, [72, 600, 300, 720], "   ", font_path=FONTS_DIR)


class TestKerning:
    """Pair kerning for text WE lay out in a bundled face.

    Scope note that is load-bearing, not timidity: only bundled faces kern.
    Text kept in a document's own embedded font already carries its kerning
    in the original TJ arrays, and the A-track's byte-identity pins would
    break by construction if every emission kerned.
    """

    def _show_ops(self, path):
        """[(operator, [adjustment numbers])] for the page's show ops."""
        out = []
        with pikepdf.open(path) as pdf:
            for instr in pikepdf.parse_content_stream(pdf.pages[0]):
                op = str(instr.operator)
                if op == "Tj":
                    out.append(("Tj", []))
                elif op == "TJ":
                    nums = []
                    for o in instr.operands[0]:
                        try:
                            nums.append(round(float(o), 1))
                        except (TypeError, ValueError):
                            pass
                    out.append(("TJ", nums))
        return out

    def _author(self, tmp_dir, name, text="AVATAR", family="serif", **kw):
        src = _blank(tmp_dir, name + "-in.pdf")
        out = os.path.join(tmp_dir, name + ".pdf")
        add_text_box(src, out, 1, [72, 600, 500, 700], text, size=24,
                     font_path=FONTS_DIR, family=family, **kw)
        return out

    def test_kerned_pairs_match_the_face_and_pull_left(self, tmp_dir):
        from engine.font_kerning import kern_pairs

        out = self._author(tmp_dir, "kerned")
        ops = self._show_ops(out)
        assert [o for o, _ in ops] == ["TJ"]
        pairs = kern_pairs(os.path.join(FONTS_DIR, "LiberationSerif-Regular.ttf"))
        seq = "AVATAR"
        expected = [
            round(-pairs[(seq[i], seq[i + 1])], 1)
            for i in range(len(seq) - 1)
            if pairs.get((seq[i], seq[i + 1]))
        ]
        assert ops[0][1] == expected
        # Every adjustment is POSITIVE here: a TJ number moves the next glyph
        # LEFT, and these pairs all tighten. The sign trap, pinned.
        assert all(v > 0 for v in ops[0][1])

    def test_kern_false_emits_the_shipped_plain_show(self, tmp_dir):
        out = self._author(tmp_dir, "plain", kern=False)
        assert [o for o, _ in self._show_ops(out)] == ["Tj"]

    def test_kern_false_is_byte_identical_to_the_shipped_path(self, tmp_dir):
        # The guard: opting out reproduces un-kerned output exactly, so the
        # feature can never perturb a caller that did not ask for it.
        a = self._author(tmp_dir, "a", kern=False)
        b = self._author(tmp_dir, "b", kern=False)
        assert _page_content(a) == _page_content(b)
        kerned = self._author(tmp_dir, "c")
        assert _page_content(kerned) != _page_content(a)

    def test_a_monospace_face_never_kerns(self, tmp_dir):
        # Liberation Mono genuinely ships no pairs — no special case needed.
        out = self._author(tmp_dir, "mono", family="mono")
        assert [o for o, _ in self._show_ops(out)] == ["Tj"]

    def test_text_with_no_kern_pairs_stays_a_plain_show(self, tmp_dir):
        out = self._author(tmp_dir, "nopairs", text="IIIIIIII")
        assert [o for o, _ in self._show_ops(out)] == ["Tj"]

    def test_kerned_text_is_still_extractable_and_editable(self, tmp_dir):
        # The whole point of TJ over per-glyph placement: the run stays ONE
        # searchable, re-editable text object.
        out = self._author(tmp_dir, "roundtrip", text="AVATAR To Yo")
        assert "AVATAR" in extract_text(out)["text"]
        runs = list_text_runs(out, 1)["runs"]
        assert any("AVATAR" in r["text"] for r in runs)

    def test_measure_agrees_with_the_kerned_layout(self, tmp_dir):
        # Measurement MUST include the kern or wrapping/centring would
        # disagree with what is drawn. A kerned line is narrower, so a width
        # that just fits when kerned may not fit unkerned.
        src = _blank(tmp_dir, "measure-in.pdf")
        text = "AVATAR AVATAR AVATAR"
        kerned = measure_text_box(src, 1, [72, 600, 260, 700], text, size=24,
                                  font_path=FONTS_DIR, family="serif", kern=True)
        plain = measure_text_box(src, 1, [72, 600, 260, 700], text, size=24,
                                 font_path=FONTS_DIR, family="serif", kern=False)
        # Kerning tightens, so it can never need MORE lines than unkerned.
        assert kerned["lines"] <= plain["lines"]

    def test_kern_must_be_a_real_boolean(self, tmp_dir):
        src = _blank(tmp_dir, "strict-in.pdf")
        out = os.path.join(tmp_dir, "strict.pdf")
        with pytest.raises(ValueError, match="kern must be"):
            add_text_box(src, out, 1, [72, 600, 500, 700], "AV", size=24,
                         font_path=FONTS_DIR, family="serif", kern="yes")


class TestKernCoverageBits:
    """The legacy `kern` subtable coverage filter.

    Bits (kern format 0): 0x1 horizontal, 0x2 minimum, 0x4 cross-stream,
    0x8 override. Only horizontal, additive pair kerning may reach a `TJ`
    array. The test must exercise the cross-stream and horizontal bits so a
    cross-stream or vertical-only subtable cannot pass through.
    """

    class _Sub:
        def __init__(self, coverage, table):
            self.coverage = coverage
            self.kernTable = table

    class _Kern:
        def __init__(self, subs):
            self.kernTables = subs

    class _Font:
        def __init__(self, kern):
            self._kern = kern

        def __getitem__(self, key):
            if key == "kern":
                return self._kern
            raise KeyError(key)

    def _run(self, coverage):
        from engine.font_kerning import _legacy_kern

        sub = self._Sub(coverage, {("A", "V"): -500})
        font = self._Font(self._Kern([sub]))
        return _legacy_kern(font, {"A": "A", "V": "V"})

    def test_horizontal_additive_is_accepted(self):
        assert self._run(0x01) == {("A", "V"): -500}

    def test_cross_stream_is_excluded(self):
        # 0x4 is cross-stream: perpendicular movement (accent placement).
        # Folding it into a horizontal TJ would displace the wrong axis.
        assert self._run(0x05) == {}

    def test_vertical_only_is_excluded(self):
        # Horizontal bit clear = vertical kerning.
        assert self._run(0x00) == {}

    def test_minimum_is_excluded(self):
        # 0x2 is a spacing FLOOR, not an additive delta — summing it is
        # meaningless.
        assert self._run(0x03) == {}

    def test_shipped_faces_are_all_plain_horizontal(self):
        # The reason the bug was inert: pin it so a resync that changes it
        # fails here rather than silently mis-kerning.
        from fontTools.ttLib import TTFont
        import glob

        for path in glob.glob(os.path.join(FONTS_DIR, "*.ttf")):
            font = TTFont(path, fontNumber=0, lazy=True)
            try:
                if "kern" not in font:
                    continue
                for sub in font["kern"].kernTables:
                    assert sub.coverage & 0x1, f"{path}: non-horizontal kern subtable"
                    assert not (sub.coverage & 0x6), f"{path}: minimum/cross-stream kern"
            finally:
                font.close()


def test_kern_validation_runs_before_font_work(tmp_dir):
    """Round-41 LOW: input-shape checks run FIRST, so an invalid `kern`
    reports itself rather than surfacing whatever the font machinery hits
    on the way (the precedent this had broken)."""
    src = _blank(tmp_dir, "precedence-in.pdf")
    out = os.path.join(tmp_dir, "precedence.pdf")
    with pytest.raises(ValueError, match="kern must be"):
        add_text_box(src, out, 1, [72, 600, 500, 700], "unencodable \U0001F600",
                     size=24, font_path=FONTS_DIR, family="serif", kern="yes")


class TestT15SpanStyling:
    """Per-span size/colour/bold/italic on the Add-Text box. The span
    path shares _layout_box's entry (same validation precedence) and the
    whole-box path stays byte-identical when spans is absent."""

    def test_spans_emit_multiple_styles_and_extract_whole(self, tmp_dir, sample_pdf):
        out = os.path.join(tmp_dir, "spans.pdf")
        text = "Big red small blue"
        r = add_text_box(
            sample_pdf, out, 1, [72, 600, 500, 700], text,
            size=12, font_path=FONTS_DIR,
            spans=[
                {"start": 0, "end": 7, "size": 24, "color": [1, 0, 0], "bold": True},
                {"start": 14, "end": 18, "color": [0, 0, 1]},
            ],
        )
        assert r["styles"] >= 3  # default + big-red-bold + blue
        content = _page_content(out)
        assert b"1 0 0 rg" in content and b"0 0 1 rg" in content
        assert b" 24 Tf" in content and b" 12 Tf" in content
        # The authored text still extracts as ONE readable string.
        extracted = extract_text(out, pages=[1])["text"]
        for word in ("Big", "red", "small", "blue"):
            assert word in extracted

    def test_measure_agrees_with_commit_on_mixed_sizes(self, tmp_dir, sample_pdf):
        from engine.text_authoring import measure_text_box

        text = "one two three four five six seven eight"
        spans = [{"start": 0, "end": 13, "size": 28}]
        m = measure_text_box(
            sample_pdf, 1, [72, 600, 260, 700], text,
            size=12, font_path=FONTS_DIR, spans=spans,
        )
        out = os.path.join(tmp_dir, "mixed.pdf")
        r = add_text_box(
            sample_pdf, out, 1, [72, 600, 260, 700], text,
            size=12, font_path=FONTS_DIR, spans=spans,
        )
        assert m["lines"] == r["lines"]  # ONE layout pass, two consumers
        # Mixed sizes ⇒ the 28pt line's leading dominates its row: the
        # text_height must exceed a uniform-12pt stack of the same lines.
        assert m["text_height"] > m["lines"] * 12 * 1.2 - 0.01

    def test_bad_spans_refused(self, tmp_dir, sample_pdf):
        out = os.path.join(tmp_dir, "no.pdf")
        with pytest.raises(ValueError, match="out of range"):
            add_text_box(sample_pdf, out, 1, [72, 600, 500, 700], "short",
                         font_path=FONTS_DIR, spans=[{"start": 0, "end": 99}])
        with pytest.raises(ValueError, match="ascending"):
            add_text_box(sample_pdf, out, 1, [72, 600, 500, 700], "overlap here",
                         font_path=FONTS_DIR,
                         spans=[{"start": 3, "end": 8}, {"start": 5, "end": 10}])
        with pytest.raises(ValueError, match="span color"):
            add_text_box(sample_pdf, out, 1, [72, 600, 500, 700], "bad color",
                         font_path=FONTS_DIR,
                         spans=[{"start": 0, "end": 3, "color": [2, 0, 0]}])

    def test_authored_spans_reedit_as_runs(self, tmp_dir, sample_pdf):
        from engine.text_runs import list_text_runs

        out = os.path.join(tmp_dir, "reedit.pdf")
        add_text_box(
            sample_pdf, out, 1, [72, 600, 500, 700], "Alpha beta",
            size=12, font_path=FONTS_DIR,
            spans=[{"start": 0, "end": 5, "size": 20}],
        )
        runs = list_text_runs(out, 1)["runs"]
        texts = [r["text"] for r in runs]
        assert any("Alpha" in t for t in texts) and any("beta" in t for t in texts)
        assert all(r["editable"] for r in runs if "Alpha" in r["text"] or "beta" in r["text"])


class TestT5CjkAuthoring:
    """CJK text authors via the vendored Noto Sans CJK face — a
    TEXT-driven switch, never a substitution for text Liberation covers."""

    _needs_cjk = pytest.mark.skipif(
        not os.path.isfile(os.path.join(FONTS_DIR, "NotoSansCJKsc-Regular.otf")),
        reason="Noto Sans CJK not provisioned (scripts/sync-edit-fonts.ps1)",
    )

    @_needs_cjk
    def test_cjk_text_authors_and_reedits(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "cjk.pdf")
        add_text_box(src, out, 1, [72, 600, 500, 700], "中文测试 mixed Latin",
                     size=14, font_path=FONTS_DIR)
        text = extract_text(out)["text"]
        assert "中文测试" in text and "mixed Latin" in text
        runs = list_text_runs(out, 1)["runs"]
        assert any("中文测试" in r["text"] and r["editable"] for r in runs)
        # The embedded face is the CJK one (Latin included — one face,
        # no mid-string font split).
        with pikepdf.open(out) as pdf:
            fonts = pdf.pages[0]["/Resources"]["/Font"]
            names = [str(fonts[k].get("/BaseFont")) for k in fonts.keys()]
        assert any("NotoSansCJK" in n for n in names)

    @_needs_cjk
    def test_latin_text_never_switches_to_cjk(self, tmp_dir):
        # The switch is text-DRIVEN: coverage Liberation has stays on
        # Liberation (the no-silent-substitution property).
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "latin.pdf")
        add_text_box(src, out, 1, [72, 600, 500, 700], "Plain Latin only",
                     font_path=FONTS_DIR)
        with pikepdf.open(out) as pdf:
            fonts = pdf.pages[0]["/Resources"]["/Font"]
            names = [str(fonts[k].get("/BaseFont")) for k in fonts.keys()]
        assert all("NotoSansCJK" not in n for n in names)
        assert any("Liberation" in n for n in names)


def _drawn_gids(pdf_path, content: str):
    """The GLYPH ids the content stream actually draws, resolved through the
    embedded font's /CIDToGIDMap.

    A shaped subset addresses glyphs by CID, not by glyph id — several
    CIDs may point at ONE glyph, which is how a base glyph spells one cluster
    under one code and a different cluster under another. A test that wants to
    know which GLYPHS were drawn therefore has to go through the map;
    comparing codes to source glyph ids only worked before the map existed."""
    import pikepdf

    codes = [int(h, 16) for h in re.findall(r"<([0-9a-fA-F]{4})>", content)]
    table = None
    with pikepdf.open(pdf_path) as pdf:
        for obj in pdf.objects:
            if not isinstance(obj, pikepdf.Dictionary):
                continue
            if str(obj.get("/Subtype", "")) != "/CIDFontType2":
                continue
            c2g = obj.get("/CIDToGIDMap")
            if c2g is not None and not isinstance(c2g, pikepdf.Name):
                table = bytes(c2g.read_bytes())
                break
    if table is None:
        return codes  # /Identity: the code IS the glyph id
    return [
        (table[c * 2] << 8) | table[c * 2 + 1]
        for c in codes
        if c * 2 + 1 < len(table)
    ]


def _contains_run(haystack, needle) -> bool:
    n = len(needle)
    return any(haystack[i : i + n] == needle for i in range(len(haystack) - n + 1))


class TestRightToLeftAuthoring:
    """Add Text authors right-to-left scripts.

    Until this, the bundled Liberation faces could not express them, so
    `build_fallback_font` refused BY NAME. That refusal was honest but it
    meant the paragraph editor could reflow Arabic while the Add Text card
    could not write a word of it.
    """

    AR = "مرحبا بالعالم"
    HE = "שלום עולם"
    MIXED = "قال PDF ثم توقف"

    def _round_trip(self, tmp_dir, text, name):
        from engine.text_paragraphs import list_text_paragraphs

        src = _blank(tmp_dir, name + "-src.pdf")
        out = os.path.join(tmp_dir, name + ".pdf")
        add_text_box(
            src, out, 1, [72, 600, 520, 720], text, size=18.0,
            font_path=FONTS_DIR, family="sans",
        )
        return [p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"]]

    def test_arabic_authors_and_extracts_back(self, tmp_dir):
        assert self._round_trip(tmp_dir, self.AR, "ar") == [self.AR]

    def test_hebrew_authors_and_extracts_back(self, tmp_dir):
        # No shaping — Hebrew does not join — but the LINE still has to be
        # reordered, so this is the reorder-only path.
        assert self._round_trip(tmp_dir, self.HE, "he") == [self.HE]

    def test_mixed_direction_keeps_the_latin_run_readable(self, tmp_dir):
        got = self._round_trip(tmp_dir, self.MIXED, "mixed")
        assert got == [self.MIXED]
        assert "PDF" in got[0]  # not "FDP"

    def test_arabic_is_drawn_JOINED(self, tmp_dir):
        # The point of shaping: an unshaped emission would extract back to
        # the same letters, so only the drawn glyph ids can tell.
        import re

        from fontTools.ttLib import TTFont

        from engine import shaping

        face = os.path.join(FONTS_DIR, "IBMPlexSansArabic-Regular.ttf")
        if not os.path.isfile(face):
            pytest.skip("RTL faces not provisioned")
        src = _blank(tmp_dir, "joined-src.pdf")
        out = os.path.join(tmp_dir, "joined.pdf")
        add_text_box(
            src, out, 1, [72, 600, 520, 720], "مرحبا", size=18.0,
            font_path=FONTS_DIR, family="sans",
        )
        gid_of = {n: i for i, n in enumerate(TTFont(face, lazy=True).getGlyphOrder())}
        joined = [gid_of[n] for n in shaping.shape(face, "مرحبا").glyph_names]
        isolated = [
            gid_of[shaping.shape(face, ch).glyph_names[0]] for ch in reversed("مرحبا")
        ]
        assert joined != isolated  # the premise
        drawn = _drawn_gids(out, _page_content(out).decode("latin-1"))
        assert _contains_run(drawn, joined)
        assert not _contains_run(drawn, isolated)

    def test_wrapping_measures_what_it_draws(self, tmp_dir):
        # A box too narrow for one line must wrap AND still round-trip: the
        # wrap measures shaped words by the shaper's positioned advance,
        # which is exactly what the emitted TJ corrections produce.
        from engine.text_paragraphs import list_text_paragraphs

        long_ar = "مرحبا بالعالم لغة عربية جميلة ونص طويل يحتاج الى اكثر من سطر"
        src = _blank(tmp_dir, "wrap-src.pdf")
        out = os.path.join(tmp_dir, "wrap.pdf")
        res = add_text_box(
            src, out, 1, [72, 560, 320, 720], long_ar, size=16.0,
            font_path=FONTS_DIR, family="sans",
        )
        assert res["lines"] > 1
        assert [p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"]] == [long_ar]

    def test_measure_agrees_with_the_commit(self, tmp_dir):
        # The single-layout discipline: the card's fit indicator runs the
        # same pass the commit runs, so a right-to-left box cannot report a
        # line count it then fails to draw.
        from engine.text_authoring import measure_text_box

        long_ar = "مرحبا بالعالم لغة عربية جميلة ونص طويل يحتاج الى اكثر من سطر"
        src = _blank(tmp_dir, "measure-src.pdf")
        out = os.path.join(tmp_dir, "measure.pdf")
        m = measure_text_box(
            src, 1, [72, 560, 320, 720], long_ar, size=16.0,
            font_path=FONTS_DIR, family="sans",
        )
        c = add_text_box(
            src, out, 1, [72, 560, 320, 720], long_ar, size=16.0,
            font_path=FONTS_DIR, family="sans",
        )
        assert m["lines"] == c["lines"]

    def test_per_span_styling_on_whole_words(self, tmp_dir):
        # Styling a whole word — what the card's selection actually
        # produces — reorders and shapes like the rest of the line.
        from engine.text_paragraphs import list_text_paragraphs

        src = _blank(tmp_dir, "spans-src.pdf")
        out = os.path.join(tmp_dir, "spans.pdf")
        res = add_text_box(
            src, out, 1, [72, 600, 520, 720], self.AR, size=18.0,
            font_path=FONTS_DIR, family="sans",
            spans=[{"start": 0, "end": 5, "bold": True, "color": [1.0, 0.0, 0.0]}],
        )
        assert res["styles"] == 2  # the box's own style plus the span's
        assert [p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"]] == [self.AR]

    def test_a_style_change_inside_a_joined_word_refuses(self, tmp_dir):
        # The one thing per-span styling cannot do in a cursive script: the
        # two halves would embed in two different subsets and each take its
        # own initial/final joining forms, so the word would break open at
        # the seam. Refuse by name rather than draw the hole.
        src = _blank(tmp_dir, "split-src.pdf")
        out = os.path.join(tmp_dir, "split.pdf")
        with pytest.raises(ValueError, match="joined word"):
            add_text_box(
                src, out, 1, [72, 600, 520, 720], self.AR, size=18.0,
                font_path=FONTS_DIR, family="sans",
                spans=[{"start": 0, "end": 3, "bold": True}],
            )

    def test_spans_wrap_and_keep_every_word(self, tmp_dir):
        # Wrapping under per-span styling measures shaped words by the
        # shaper's advance, so the drawn lines and the text agree. The
        # RE-LISTING may report two paragraphs rather than one — a per-span
        # size can make the styled word the WIDEST on its line, which trips
        # the grouper's dominant-size break — so assert the TEXT, which is
        # what must survive, not the grouping heuristic's verdict.
        from engine.text_paragraphs import list_text_paragraphs

        long_ar = "مرحبا بالعالم لغة عربية جميلة ونص طويل يحتاج الى اكثر من سطر"
        src = _blank(tmp_dir, "spanwrap-src.pdf")
        out = os.path.join(tmp_dir, "spanwrap.pdf")
        res = add_text_box(
            src, out, 1, [72, 540, 330, 720], long_ar, size=16.0,
            font_path=FONTS_DIR, family="sans",
            spans=[{"start": 0, "end": 5, "size": 24.0}],
        )
        assert res["lines"] > 1
        got = " ".join(p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"])
        assert got == long_ar

    def test_a_style_change_inside_a_HEBREW_word_is_fine(self, tmp_dir):
        # Hebrew does not join, so there is no seam to break — the refusal
        # above is about cursive joining, not about direction.
        from engine.text_paragraphs import list_text_paragraphs

        src = _blank(tmp_dir, "hesplit-src.pdf")
        out = os.path.join(tmp_dir, "hesplit.pdf")
        add_text_box(
            src, out, 1, [72, 600, 520, 720], self.HE, size=18.0,
            font_path=FONTS_DIR, family="sans",
            spans=[{"start": 0, "end": 2, "color": [0.0, 0.0, 1.0]}],
        )
        assert [p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"]] == [self.HE]

    def test_a_left_to_right_box_is_untouched_by_any_of_this(self, tmp_dir):
        # The gate is `has_strong_rtl`, so an ordinary box never enters the
        # bidi path at all — asserted through the drawn bytes, not the API.
        src = _blank(tmp_dir, "ltr-src.pdf")
        out = os.path.join(tmp_dir, "ltr.pdf")
        add_text_box(
            src, out, 1, [72, 680, 400, 720], "Hello authored world",
            font_path=FONTS_DIR,
        )
        content = _page_content(out)
        assert b"Ts" not in content  # the rise op only the shaped path emits


class TestFreeRotation:
    """Arbitrary-angle authoring keeps layout local and angle-blind. One
    free-rotation frame turns the drawn box about its own center. Step angles
    keep the shipped frames byte-for-byte (pinned above)."""

    def test_37_degree_frame_is_exact(self, tmp_dir):
        import math as _math

        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        rect = [72, 600, 300, 720]
        add_text_box(src, out, 1, rect, "angled", font_path=FONTS_DIR, rotate=37)
        with pikepdf.open(out) as pdf:
            cms = [
                [float(v) for v in i.operands]
                for i in pikepdf.parse_content_stream(pdf.pages[0])
                if str(i.operator) == "cm"
            ]
        assert len(cms) == 1
        a, b, c, d, e, f = cms[0]
        th = _math.radians(37)
        assert (a, b, c, d) == pytest.approx(
            (_math.cos(th), _math.sin(th), -_math.sin(th), _math.cos(th)), abs=1e-5
        )
        # The frame maps the LOCAL box center onto the DRAWN box center —
        # the rotate-in-place property.
        l_w, l_h = 300 - 72, 720 - 600
        cx = l_w / 2 * a + l_h / 2 * c + e
        cy = l_w / 2 * b + l_h / 2 * d + f
        assert (cx, cy) == pytest.approx(((72 + 300) / 2, (600 + 720) / 2), abs=1e-3)

    def test_measure_is_angle_blind(self, tmp_dir):
        src = _blank(tmp_dir)
        rect = [72, 600, 300, 720]
        flat = measure_text_box(src, 1, rect, "measure me", font_path=FONTS_DIR, rotate=0)
        angled = measure_text_box(src, 1, rect, "measure me", font_path=FONTS_DIR, rotate=37)
        assert flat["fits"] == angled["fits"]
        assert flat["lines"] == angled["lines"]
        assert flat["text_height"] == pytest.approx(angled["text_height"])

    def test_free_angle_with_spans_carries_the_frame(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [72, 600, 300, 720], "styled angle",
            font_path=FONTS_DIR, rotate=200,
            spans=[{"start": 0, "end": 6, "color": [1, 0, 0]}],
        )
        with pikepdf.open(out) as pdf:
            cms = [
                [float(v) for v in i.operands]
                for i in pikepdf.parse_content_stream(pdf.pages[0])
                if str(i.operator) == "cm"
            ]
        assert len(cms) == 1
        import math as _math

        assert cms[0][0] == pytest.approx(_math.cos(_math.radians(200)), abs=1e-5)


CJK_FACE = os.path.join(FONTS_DIR, "NotoSansCJKsc-Regular.otf")
MONGOLIAN_FACE = os.path.join(FONTS_DIR, "NotoSansMongolian-Regular.ttf")
_HAS_CJK = os.path.isfile(CJK_FACE)
_HAS_MONGOLIAN = os.path.isfile(MONGOLIAN_FACE)

# Mongolian, and a Japanese sentence long enough to need more than one column.
_MONGOL = "\u182e\u1823\u1829\u182d\u1823\u182f"
_NARAN = "\u1828\u1820\u1837\u1820\u1828"
_JA = (
    "\u65e5\u672c\u8a9e\u306e\u7e26\u66f8\u304d\u3067\u3059\u3002"
    "\u3053\u308c\u306f\u9577\u3044\u6bb5\u843d\u3002"
)


def _tms(path):
    """Every Tm the authored object writes, in emission order."""
    with pikepdf.open(path) as pdf:
        return [
            [float(v) for v in i.operands]
            for i in pikepdf.parse_content_stream(pdf.pages[0])
            if str(i.operator) == "Tm"
        ]


def _ops(path, name):
    with pikepdf.open(path) as pdf:
        return [
            [float(v) for v in i.operands]
            for i in pikepdf.parse_content_stream(pdf.pages[0])
            if str(i.operator) == name
        ]


class TestVerticalAuthoring:
    """Authoring a column. Two boundaries carry it (the box enters the
    writing frame, the anchor leaves it); everything between is the
    horizontal layout, which is why a horizontal box stays byte-identical."""

    def test_horizontal_writing_mode_is_the_shipped_bytes(self, tmp_dir):
        src = _blank(tmp_dir)
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        add_text_box(src, a, 1, [72, 600, 400, 720], "control text", font_path=FONTS_DIR)
        add_text_box(
            src, b, 1, [72, 600, 400, 720], "control text", font_path=FONTS_DIR,
            writing_mode="horizontal",
        )
        assert _page_content(a) == _page_content(b)

    def test_rejects_a_writing_mode_it_does_not_know(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        for bad in ("sideways", "", None, 90, True):
            with pytest.raises(ValueError, match="writing_mode must be"):
                add_text_box(
                    src, out, 1, [72, 600, 400, 720], "x", font_path=FONTS_DIR,
                    writing_mode=bad,
                )

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_vertical_embeds_identity_v_with_w2(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [380, 400, 460, 720], _JA, size=14, font_path=FONTS_DIR,
            writing_mode="vertical",
        )
        with pikepdf.open(out) as pdf:
            fonts = pdf.pages[0].obj["/Resources"]["/Font"]
            font = next(iter(fonts.values()))
            assert str(font["/Encoding"]) == "/Identity-V"
            desc = font["/DescendantFonts"][0]
            # The advances the CMap walks DOWN have to be stated.
            assert "/W2" in desc or "/DW2" in desc

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_columns_advance_leftward_and_start_one_em_in(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        # Short enough on the READING axis (the drawn height) to force a
        # second column — which is the thing being measured.
        add_text_box(
            src, out, 1, [380, 560, 460, 720], _JA, size=14, font_path=FONTS_DIR,
            writing_mode="vertical",
        )
        tms = _tms(out)
        assert len(tms) > 1, "the column never wrapped"
        # Upright glyphs: the CMap advances the pen, so the matrix is the
        # identity and only the anchor moves.
        assert all(t[:4] == [1.0, 0.0, 0.0, 1.0] for t in tms)
        xs = [t[4] for t in tms]
        assert xs == sorted(xs, reverse=True), "columns did not advance leftward"
        # Every column starts at the box top, one em in from its right edge —
        # the transposed reading of "one em below the box top".
        assert all(t[5] == pytest.approx(720, abs=0.01) for t in tms)
        assert xs[0] == pytest.approx(460 - 14, abs=0.01)

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_the_authored_column_lists_back_as_a_column(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [380, 400, 460, 720], _JA, size=14, font_path=FONTS_DIR,
            writing_mode="vertical",
        )
        para = next(
            p for p in list_text_paragraphs(out, 1)["paragraphs"] if _JA in p["text"]
        )
        assert para["orientation"] == "vertical-rl"
        assert para["columns"] == "rtl"
        assert para["vertical"] is True
        assert para["editable"] is True

    @pytest.mark.skipif(not _HAS_MONGOLIAN, reason="Mongolian face not provisioned")
    def test_mongolian_authors_left_to_right_columns(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [200, 500, 260, 720], _MONGOL + " " + _NARAN, size=14,
            font_path=FONTS_DIR, writing_mode="vertical",
        )
        tms = _tms(out)
        # A Mongolian face states no vertical advance, so it embeds
        # HORIZONTALLY and the column is that run turned a quarter.
        assert all(t[:4] == [0.0, -1.0, 1.0, 0.0] for t in tms)
        if len(tms) > 1:
            xs = [t[4] for t in tms]
            assert xs == sorted(xs), "columns did not advance rightward"
        para = next(
            p for p in list_text_paragraphs(out, 1)["paragraphs"] if _MONGOL in p["text"]
        )
        assert para["orientation"] == "vertical-lr"
        assert para["columns"] == "ltr"

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_an_explicit_direction_the_text_contradicts_refuses(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="sets columns right to left"):
            add_text_box(
                src, out, 1, [380, 400, 460, 720], _JA, size=14, font_path=FONTS_DIR,
                writing_mode="vertical-lr",
            )

    @pytest.mark.skipif(not _HAS_MONGOLIAN, reason="Mongolian face not provisioned")
    def test_mongolian_refuses_right_to_left_columns(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="sets columns left to right"):
            add_text_box(
                src, out, 1, [200, 500, 260, 720], _MONGOL, size=14,
                font_path=FONTS_DIR, writing_mode="vertical-rl",
            )

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_direction_free_text_takes_the_request(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        # Digits carry no column evidence, so the explicit spelling stands
        # rather than refusing — the re-listing's own tiebreak discipline.
        add_text_box(
            src, out, 1, [380, 400, 460, 720], "2026", size=14, font_path=FONTS_DIR,
            writing_mode="vertical-lr",
        )
        assert _tms(out)

    def test_a_rotated_box_cannot_be_vertical(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        for angle in (90, 180, 270, 37):
            with pytest.raises(ValueError, match="rotated box cannot also"):
                add_text_box(
                    src, out, 1, [380, 400, 460, 720], "x", font_path=FONTS_DIR,
                    writing_mode="vertical", rotate=angle,
                )

    def test_a_latin_face_on_a_vertical_request_refuses_by_name(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        # The metrics gate, reached from the authoring side: a face with no
        # `vmtx` can never reach an /Identity-V embed, whose /W2 would
        # otherwise have to be invented.
        with pytest.raises(ValueError, match="no vertical metrics"):
            add_text_box(
                src, out, 1, [380, 400, 460, 720], "Hello", size=14,
                font_path=FONTS_DIR, writing_mode="vertical",
                family=os.path.join(FONTS_DIR, "LiberationSans-Regular.ttf"),
            )

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_features_do_not_apply_to_a_column(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="do not apply to vertical text"):
            add_text_box(
                src, out, 1, [380, 400, 460, 720], _JA, size=14, font_path=FONTS_DIR,
                writing_mode="vertical", features=["small_caps"],
            )

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_measure_agrees_with_the_commit_in_a_column(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        rect = [380, 400, 460, 720]
        m = measure_text_box(
            src, 1, rect, _JA, size=14, font_path=FONTS_DIR, writing_mode="vertical"
        )
        r = add_text_box(
            src, out, 1, rect, _JA, size=14, font_path=FONTS_DIR,
            writing_mode="vertical",
        )
        assert m["lines"] == r["lines"]
        # `box_height` is the extent ACROSS the reading direction, which for
        # a column is the drawn WIDTH.
        assert m["box_height"] == pytest.approx(460 - 380)


class TestNoSpaceWrap:
    """A no-space script must wrap. Breaking only at spaces made a Japanese
    sentence one word — one line, straight off the page — in every writing
    mode, and a column is nothing but wrapping."""

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_cjk_wraps_horizontally(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        r = add_text_box(
            src, out, 1, [72, 600, 232, 720], _JA, size=14, font_path=FONTS_DIR
        )
        assert r["lines"] > 1

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_no_space_is_invented_at_a_cjk_break(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [72, 600, 232, 720], _JA, size=14, font_path=FONTS_DIR
        )
        # The wrap is a layout decision, never a text one.
        assert " " not in extract_text(out)["text"].replace("\n", "")

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_a_closing_character_never_starts_a_line(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        text = "\u3042\u3044\u3046\u3048\u304a\u3002" * 4
        add_text_box(
            src, out, 1, [72, 600, 160, 720], text, size=14, font_path=FONTS_DIR
        )
        lines = [ln for ln in extract_text(out)["text"].splitlines() if ln]
        assert lines
        assert not any(ln.startswith("\u3002") for ln in lines)

    def test_latin_wrapping_is_unchanged(self, tmp_dir):
        src = _blank(tmp_dir)
        a = os.path.join(tmp_dir, "a.pdf")
        add_text_box(
            src, a, 1, [72, 600, 200, 720],
            "one two three four five six seven eight", size=12, font_path=FONTS_DIR,
        )
        text = extract_text(a)["text"]
        assert "one two" in text and "eight" in text


class TestAuthoredTateChuYoko:
    """The construct, made from creation. The edit machinery could reflow a
    tate-chu-yoko block and nothing could produce one — the same shape as the
    defect the vertical restyle surface carried before it was fixed."""

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_the_block_is_condensed_and_the_state_restored(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [400, 300, 460, 720], "\u5e73\u62102026\u5e74",
            size=14, font_path=FONTS_DIR, writing_mode="vertical",
            spans=[{"start": 2, "end": 6, "tcy": True}],
        )
        tzs = _ops(out, "Tz")
        # Condensed to one em across the column, then back to 100 — Tz is
        # text state and would otherwise follow the column down the page.
        assert len(tzs) == 2
        assert tzs[0][0] < 100
        assert tzs[1][0] == 100

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_a_longer_year_takes_the_same_column_pitch(self, tmp_dir):
        src = _blank(tmp_dir)
        two = os.path.join(tmp_dir, "two.pdf")
        four = os.path.join(tmp_dir, "four.pdf")
        rect = [400, 300, 460, 720]
        add_text_box(
            src, two, 1, rect, "\u5e73\u621026\u5e74\u306e\u8a18\u9332", size=14,
            font_path=FONTS_DIR, writing_mode="vertical",
            spans=[{"start": 2, "end": 4, "tcy": True}],
        )
        add_text_box(
            src, four, 1, rect, "\u5e73\u62102026\u5e74\u306e\u8a18\u9332", size=14,
            font_path=FONTS_DIR, writing_mode="vertical",
            spans=[{"start": 2, "end": 6, "tcy": True}],
        )
        # The block consumes ONE column em whatever it says, so the text
        # after it starts at exactly the same place.
        assert _tms(two)[-1][5] == pytest.approx(_tms(four)[-1][5])

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_the_block_is_read_back_inside_its_column(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        text = "\u5e73\u62102026\u5e74\u306e\u8a18\u9332"
        add_text_box(
            src, out, 1, [400, 300, 460, 720], text, size=14, font_path=FONTS_DIR,
            writing_mode="vertical", spans=[{"start": 2, "end": 6, "tcy": True}],
        )
        paras = list_text_paragraphs(out, 1)["paragraphs"]
        # ONE paragraph carrying the year in reading position: the block the
        # emission wrote is the block the absorption recognises.
        assert len(paras) == 1
        assert paras[0]["text"] == text
        assert paras[0]["orientation"] == "vertical-rl"
        assert paras[0]["editable"] is True

    def test_refuses_outside_a_column(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="only applies inside a vertical column"):
            add_text_box(
                src, out, 1, [72, 600, 300, 720], "abc 2026 def", size=14,
                font_path=FONTS_DIR, spans=[{"start": 4, "end": 8, "tcy": True}],
            )

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_refuses_a_block_with_a_space_in_it(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="cannot contain spaces"):
            add_text_box(
                src, out, 1, [400, 300, 460, 720], "\u5e73\u621020 26\u5e74", size=14,
                font_path=FONTS_DIR, writing_mode="vertical",
                spans=[{"start": 2, "end": 7, "tcy": True}],
            )

    @pytest.mark.skipif(not _HAS_CJK, reason="CJK face not provisioned")
    def test_refuses_joining_characters(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="joining characters"):
            add_text_box(
                src, out, 1, [400, 300, 460, 720],
                "\u5e73\u6210\u0645\u0631\u062d\u5e74",
                size=14, font_path=FONTS_DIR, writing_mode="vertical",
                spans=[{"start": 2, "end": 5, "tcy": True}],
            )
