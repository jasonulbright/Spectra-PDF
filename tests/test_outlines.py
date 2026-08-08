"""Text and strokes converted to outlines.

The measurement the design rests on is `_deep_interior`. Ghostscript rasterizes
a glyph and a filled path through different code paths — one grid-fits and
guards against dropout, the other applies a fill allowance — so a converted
page can never be byte-identical to the original and asserting that it is would
pin the RIP rather than the geometry. What CAN be asserted absolutely is that
no pixel INTERIOR to the ink in both renders differs: a glyph in the wrong
place, at the wrong size or with the wrong contour direction puts disagreeing
pixels away from the boundary, and none appear at any resolution.

The second half of the pin is the ink-area difference, which is measured rather
than assumed and must SHRINK as resolution rises — the signature of a fixed
sub-pixel edge allowance, not of a geometry error. Measured on the embedded
fixture: +5.6 % at 150 dpi, +3.0 % at 300, +1.3 % at 600, +0.5 % at 1200.

The substituted-face path (a font the document does not embed) is measured the
same way and NOT asserted as equivalence: it is the reader's own substitution
made permanent, and its numbers are recorded here rather than pinned —
+1.6 % at 150 dpi and −2.3 % at 300 against Ghostscript's own substitute.
"""

import os
import subprocess

import pikepdf
import pytest

from engine.extract_text import extract_text
from engine.flattener import flatten_transparency
from engine.glyph_outlines import GlyphSource, OutlineRefusal
from engine.outlines import list_outlines, outline_page
from engine.stroke_outline import (
    CAP_BUTT,
    CAP_ROUND,
    CAP_SQUARE,
    JOIN_BEVEL,
    JOIN_MITER,
    JOIN_ROUND,
    dash_polyline,
    flatten_subpath,
    stroke_outline,
    stroke_polyline,
)
from outline_builders import (
    FONT_DIR,
    composite_text_pdf,
    embedded_text_pdf,
    escape,
    fonts_available,
    mixed_modes_pdf,
    page_pdf,
    shared_form_pdf,
    text_clip_pdf,
    text_over_alpha_pdf,
    type3_text_pdf,
    unembedded_text_pdf,
)

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


@pytest.fixture
def font_dir():
    if not fonts_available():
        pytest.skip("bundled fonts not provisioned")
    return os.path.abspath(FONT_DIR)


# ── measurement helpers ────────────────────────────────────────────────────


def _render(gs_path, source, target, dpi):
    subprocess.run(
        [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=png16m",
         f"-r{dpi}", "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4",
         "-o", str(target), str(source)],
        check=True, stdin=subprocess.DEVNULL, capture_output=True,
    )


def _ink(path):
    import numpy as np
    from PIL import Image

    with Image.open(path) as image:
        return np.asarray(image.convert("L")).astype(np.int16) < 128


def _shrink(mask):
    """The ink minus its own boundary — the pixels a one-pixel edge treatment
    cannot reach."""
    grown = ~mask
    out = grown.copy()
    out[1:, :] |= grown[:-1, :]
    out[:-1, :] |= grown[1:, :]
    out[:, 1:] |= grown[:, :-1]
    out[:, :-1] |= grown[:, 1:]
    return mask & ~out


def _compare(gs_path, tmp_dir, before, after, dpi, tag):
    left = os.path.join(tmp_dir, f"{tag}-before-{dpi}.png")
    right = os.path.join(tmp_dir, f"{tag}-after-{dpi}.png")
    _render(gs_path, before, left, dpi)
    _render(gs_path, after, right, dpi)
    a, b = _ink(left), _ink(right)
    assert a.shape == b.shape
    deep = int(((a != b) & _shrink(a) & _shrink(b)).sum())
    area = int(a.sum())
    delta = (int(b.sum()) - area) / max(1, area)
    return deep, delta


def _convert(source, target, font_dir, text=True, strokes=True):
    with pikepdf.open(source) as pdf:
        results = [
            outline_page(pdf, pdf.pages[n - 1], n, font_dir, text, strokes)
            for n in range(1, len(pdf.pages))
        ] or [outline_page(pdf, pdf.pages[0], 1, font_dir, text, strokes)]
        pdf.save(target)
    return results


def _convert_all(source, target, font_dir, text=True, strokes=True):
    with pikepdf.open(source) as pdf:
        results = [
            outline_page(pdf, pdf.pages[n - 1], n, font_dir, text, strokes)
            for n in range(1, len(pdf.pages) + 1)
        ]
        pdf.save(target)
    return results


# ── glyph sources, per program shape ───────────────────────────────────────


def test_embedded_truetype_yields_contours(tmp_dir, font_dir):
    source = embedded_text_pdf(os.path.join(tmp_dir, "a.pdf"))
    with pikepdf.open(source) as pdf:
        font = pdf.pages[0].Resources["/Font"]["/F0"]
        from engine.pdf_fonts import font_capability

        glyphs = GlyphSource(font, font_capability(font), font_dir, 1)
        contours = glyphs.contours(ord("H"), b"H")
    assert glyphs.substituted is None
    assert contours, "the capital H drew no contour"
    xs = [point[0] for contour in contours for segment in contour
          if segment[0] in ("m", "l") for point in (segment[1],)]
    ys = [point[1] for contour in contours for segment in contour
          if segment[0] in ("m", "l") for point in (segment[1],)]
    # Em-normalized: an H is roughly two thirds of an em tall and never
    # reaches the full em box.
    assert 0.6 < max(ys) - min(ys) < 0.9
    assert 0.0 <= min(xs) < max(xs) < 1.0


def test_composite_identity_h_yields_contours(tmp_dir, font_dir):
    source = composite_text_pdf(os.path.join(tmp_dir, "a.pdf"))
    report = list_outlines(source, font_dir=font_dir)
    assert report["refusals"] == []
    # The space draws no contour and contributes no path; every other code in
    # the run does.
    assert report["pages"][0]["glyphs"] == len("Composite Wave".replace(" ", ""))


def test_type3_refuses_by_name(tmp_dir, font_dir):
    source = type3_text_pdf(os.path.join(tmp_dir, "a.pdf"))
    report = list_outlines(source, font_dir=font_dir)
    assert len(report["refusals"]) == 1
    assert "Type 3" in report["refusals"][0]
    assert report["refusals"][0].startswith("Page 1 ")


def test_type3_refusal_raises_on_apply(tmp_dir, font_dir):
    source = type3_text_pdf(os.path.join(tmp_dir, "a.pdf"))
    with pikepdf.open(source) as pdf:
        with pytest.raises(OutlineRefusal) as caught:
            outline_page(pdf, pdf.pages[0], 1, font_dir, True, False)
    assert "content streams rather than outlines" in str(caught.value)


def test_unembedded_font_substitutes_and_says_so(tmp_dir, font_dir):
    source = unembedded_text_pdf(os.path.join(tmp_dir, "a.pdf"))
    report = list_outlines(source, font_dir=font_dir)
    assert report["refusals"] == []
    assert report["substituted"] == ["LiberationSans-Regular.ttf"]
    assert report["pages"][0]["substituted"] == {
        "Helvetica": "LiberationSans-Regular.ttf"
    }


def test_unembedded_font_without_bundled_faces_refuses(tmp_dir):
    source = unembedded_text_pdf(os.path.join(tmp_dir, "a.pdf"))
    report = list_outlines(source, font_dir="")
    assert len(report["refusals"]) == 1
    assert "not embedded in this document" in report["refusals"][0]


def test_missing_font_resource_refuses(tmp_dir, font_dir):
    source = page_pdf(os.path.join(tmp_dir, "a.pdf"),
                      b"BT /F9 12 Tf 1 0 0 1 20 20 Tm (x) Tj ET")
    report = list_outlines(source, font_dir=font_dir)
    assert len(report["refusals"]) == 1
    assert "the page does not define" in report["refusals"][0]


# ── the rendering-equivalence pin ──────────────────────────────────────────


def test_converted_text_renders_equivalently(tmp_dir, font_dir, gs_path):
    pytest.importorskip("numpy")
    pytest.importorskip("PIL")
    source = embedded_text_pdf(os.path.join(tmp_dir, "a.pdf"))
    target = os.path.join(tmp_dir, "b.pdf")
    _convert_all(source, target, font_dir)

    measured = {}
    for dpi in (150, 300):
        deep, delta = _compare(gs_path, tmp_dir, source, target, dpi, "text")
        measured[dpi] = (deep, delta)
        assert deep == 0, (
            f"{deep} pixels interior to the ink in BOTH renders differ at "
            f"{dpi} dpi — the outline geometry has moved, which no edge "
            f"treatment can explain"
        )
    assert abs(measured[150][1]) < 0.20, measured
    assert abs(measured[300][1]) < 0.10, measured
    # The allowance is a fixed fraction of a device pixel, so its share of the
    # ink halves as the ink grows. A difference that does NOT shrink is a
    # geometry error wearing an edge treatment's clothes.
    assert abs(measured[300][1]) < abs(measured[150][1]), measured


def test_converted_text_leaves_nothing_to_extract(tmp_dir, font_dir):
    source = embedded_text_pdf(os.path.join(tmp_dir, "a.pdf"))
    target = os.path.join(tmp_dir, "b.pdf")
    assert "Hamburgefonstiv" in extract_text(source)["text"]
    _convert_all(source, target, font_dir)
    assert extract_text(target)["text"].strip("\n\x0c ") == ""


def test_kerning_scaling_and_rise_survive(tmp_dir, font_dir, gs_path):
    pytest.importorskip("numpy")
    source = mixed_modes_pdf(os.path.join(tmp_dir, "a.pdf"))
    target = os.path.join(tmp_dir, "b.pdf")
    result = _convert_all(source, target, font_dir)[0]
    assert result["text_runs"] == 4
    assert result["invisible_runs"] == 1
    deep, delta = _compare(gs_path, tmp_dir, source, target, 300, "modes")
    assert deep == 0
    assert abs(delta) < 0.10
    assert extract_text(target)["text"].strip("\n\x0c ") == ""


def test_invisible_text_is_removed_and_counted(tmp_dir, font_dir):
    pdf = pikepdf.new()
    from outline_builders import embed_truetype

    page = pdf.add_blank_page(page_size=(300.0, 100.0))
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F0=embed_truetype(pdf)))
    page.Contents = pdf.make_stream(
        b"BT /F0 12 Tf 3 Tr 1 0 0 1 20 40 Tm " + escape(b"scanned words") + b" Tj ET")
    source = os.path.join(tmp_dir, "a.pdf")
    pdf.save(source)
    pdf.close()
    target = os.path.join(tmp_dir, "b.pdf")
    result = _convert_all(source, target, font_dir)[0]
    assert result["invisible_runs"] == 1
    assert result["glyphs"] == 0
    with pikepdf.open(target) as out:
        body = bytes(out.pages[0].Contents.read_bytes())
    assert b"Tj" not in body and b"BT" not in body


def test_text_clip_mode_still_clips(tmp_dir, font_dir, gs_path):
    pytest.importorskip("numpy")
    source = text_clip_pdf(os.path.join(tmp_dir, "a.pdf"))
    target = os.path.join(tmp_dir, "b.pdf")
    _convert_all(source, target, font_dir)
    deep, delta = _compare(gs_path, tmp_dir, source, target, 300, "clip")
    assert deep == 0
    assert abs(delta) < 0.20
    with pikepdf.open(target) as out:
        body = bytes(out.pages[0].Contents.read_bytes())
    assert b"W n" in body


# ── forms ──────────────────────────────────────────────────────────────────


def test_form_conversion_is_copy_on_write(tmp_dir, font_dir):
    source = shared_form_pdf(os.path.join(tmp_dir, "a.pdf"))
    target = os.path.join(tmp_dir, "b.pdf")
    with pikepdf.open(source) as pdf:
        outline_page(pdf, pdf.pages[0], 1, font_dir, True, True)
        pdf.save(target)
    assert extract_text(target, pages=[1])["text"].strip("\n\x0c ") == ""
    assert "Inside a form" in extract_text(target, pages=[2])["text"]


# ── strokes ────────────────────────────────────────────────────────────────


STROKE_CASES = {
    "miter": b"0 0 1 RG 12 w 0 j 10 M 60 60 m 200 320 l 340 60 l S",
    "round-join": b"1 0 0 RG 16 w 1 j 60 60 m 200 320 l 340 60 l S",
    "bevel": b"0 0.5 0 RG 16 w 2 j 60 60 m 200 320 l 340 60 l S",
    "butt-cap": b"0 G 20 w 0 J 60 200 m 340 200 l S",
    "round-cap": b"0 G 20 w 1 J 60 200 m 340 200 l S",
    "square-cap": b"0 G 20 w 2 J 60 200 m 340 200 l S",
    "dash": b"0 G 8 w 0 J [16 10] 0 d 40 200 m 360 200 l S",
    "dash-phase": b"0 G 8 w 1 J [20 8] 7 d 40 200 m 360 200 l S",
    "dotted-round": b"0 G 8 w 1 J [0 14] 0 d 40 200 m 360 200 l S",
    "dotted-square": b"0 G 8 w 2 J [0 14] 0 d 40 200 m 360 200 l S",
    "curve": b"0 0 1 RG 10 w 1 J 40 80 m 120 360 280 40 360 320 c S",
    "closed-rect": b"0 G 14 w 0 j 80 80 240 240 re S",
    "closed-subpath": b"0 G 14 w 1 j 80 80 m 320 80 l 320 320 l h S",
    "fill-and-stroke": b"1 1 0 rg 0 0 1 RG 12 w 80 80 240 240 re B",
    "anisotropic-ctm": b"q 3 0 0 1 0 0 cm 0 G 10 w 20 200 m 120 200 l 120 300 l S Q",
    "degenerate-round": b"0 G 24 w 1 J 200 200 m 200 200 l S",
    "miter-over-limit": b"0 G 12 w 0 j 2 M 60 200 m 200 210 l 340 200 l S",
}


@pytest.mark.parametrize("name", sorted(STROKE_CASES))
def test_stroke_conversion_renders_equivalently(name, tmp_dir, font_dir, gs_path):
    pytest.importorskip("numpy")
    source = page_pdf(os.path.join(tmp_dir, f"{name}.pdf"), STROKE_CASES[name])
    target = os.path.join(tmp_dir, f"{name}-out.pdf")
    _convert_all(source, target, font_dir, text=False, strokes=True)
    for dpi, bound in ((150, 0.05), (300, 0.02)):
        deep, delta = _compare(gs_path, tmp_dir, source, target, dpi, name)
        assert deep == 0, f"{name} at {dpi} dpi moved {deep} interior pixels"
        assert abs(delta) < bound, f"{name} at {dpi} dpi: ink delta {delta:.4f}"
    with pikepdf.open(target) as out:
        body = bytes(out.pages[0].Contents.read_bytes())
    assert b" S\n" not in body and not body.rstrip().endswith(b" S")


def test_zero_width_stroke_refuses(tmp_dir, font_dir):
    source = page_pdf(os.path.join(tmp_dir, "a.pdf"), b"0 G 0 w 40 100 m 160 100 l S")
    report = list_outlines(source, font_dir=font_dir)
    assert len(report["refusals"]) == 1
    assert "zero-width line" in report["refusals"][0]


def test_dash_becomes_separate_pieces():
    points = [(0.0, 0.0), (100.0, 0.0)]
    pieces = dash_polyline(points, False, (10.0, 10.0), 0.0)
    assert len(pieces) == 5
    assert all(not closed for _piece, closed in pieces)
    lengths = [piece[-1][0] - piece[0][0] for piece, _closed in pieces]
    assert all(abs(length - 10.0) < 1e-6 for length in lengths)


def test_dash_phase_skips_into_the_pattern():
    pieces = dash_polyline([(0.0, 0.0), (100.0, 0.0)], False, (10.0, 10.0), 5.0)
    assert pieces[0][0][0][0] == 0.0
    assert abs(pieces[0][0][-1][0] - 5.0) < 1e-6


def test_no_dash_leaves_the_polyline_whole():
    pieces = dash_polyline([(0.0, 0.0), (10.0, 0.0)], False, (), 0.0)
    assert pieces == [([(0.0, 0.0), (10.0, 0.0)], False)]


def test_closed_polyline_joins_every_corner():
    square = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]
    closed = stroke_polyline(square, True, 2.0, CAP_BUTT, JOIN_MITER, 10.0, 0.01)
    open_ring = stroke_polyline(square, False, 2.0, CAP_BUTT, JOIN_MITER, 10.0, 0.01)
    # Four segments and four joins closed; the open ring has three segments
    # and two joins. A closed path whose first vertex went unjoined would tie
    # with the open one.
    assert len(closed) == 8
    assert len(open_ring) == 5


def test_degenerate_subpath_answers_per_cap():
    point = [(5.0, 5.0)]
    assert stroke_polyline(point, False, 4.0, CAP_BUTT, JOIN_MITER, 10.0, 0.01) == []
    assert len(stroke_polyline(point, False, 4.0, CAP_ROUND, JOIN_MITER, 10.0, 0.01)) == 1
    square = stroke_polyline(point, False, 4.0, CAP_SQUARE, JOIN_MITER, 10.0, 0.01)
    assert len(square) == 1 and len(square[0]) == 4


def test_every_polygon_is_wound_the_same_way():
    """Nonzero winding over consistently-wound pieces IS their union. One
    reversed piece would punch a hole through everything it overlaps."""
    subpaths = [[("m", (0.0, 0.0)), ("l", (50.0, 10.0)), ("l", (80.0, 60.0))]]
    for join in (JOIN_MITER, JOIN_ROUND, JOIN_BEVEL):
        for cap in (CAP_BUTT, CAP_ROUND, CAP_SQUARE):
            polygons = stroke_outline(subpaths, 6.0, cap, join, 10.0, (), 0.0, 0.05)
            assert polygons
            for polygon in polygons:
                area = 0.0
                for i, (x0, y0) in enumerate(polygon):
                    x1, y1 = polygon[(i + 1) % len(polygon)]
                    area += x0 * y1 - x1 * y0
                assert area > 0, (join, cap)


def test_flatten_subpath_reports_closure_without_duplicating_the_point():
    points, closed = flatten_subpath(
        [("m", (0.0, 0.0)), ("l", (10.0, 0.0)), ("l", (10.0, 10.0)), ("h",)], 0.05)
    assert closed is True
    assert points == [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]


def test_miter_over_its_limit_falls_back_to_bevel():
    # A near-reversal: the miter would run far past the vertex, which is
    # exactly the case the limit exists to cut off.
    sharp = [(0.0, 0.0), (100.0, 0.0), (2.0, 6.0)]
    tight = stroke_polyline(sharp, False, 10.0, CAP_BUTT, JOIN_MITER, 1.5, 0.01)
    loose = stroke_polyline(sharp, False, 10.0, CAP_BUTT, JOIN_MITER, 100.0, 0.01)
    assert [p for p in tight if len(p) == 3], "the limit did not degrade to a bevel"
    assert [p for p in loose if len(p) == 4], "a permitted miter was not drawn"


def test_zero_length_dash_still_draws_its_dot():
    """`[0 6] 0 d` with round caps is the dotted-line idiom: the ON phase has
    no length and the cap is the whole mark."""
    pieces = dash_polyline([(0.0, 0.0), (30.0, 0.0)], False, (0.0, 6.0), 0.0)
    assert [piece[0][0] for piece, _closed in pieces] == [0.0, 6.0, 12.0, 18.0, 24.0]
    dots = stroke_polyline(pieces[0][0], False, 8.0, CAP_ROUND, JOIN_MITER, 10.0, 0.05)
    assert len(dots) == 1 and len(dots[0]) > 8, "the dot lost its cap"


# ── the flatten door ───────────────────────────────────────────────────────


def test_flatten_door_carries_both_conversions(tmp_dir, font_dir, gs_path):
    source = text_over_alpha_pdf(os.path.join(tmp_dir, "a.pdf"))
    target = os.path.join(tmp_dir, "b.pdf")
    result = flatten_transparency(
        source, target, gs_path=gs_path, outline_text=True, outline_strokes=True,
        font_dir=font_dir,
    )
    assert result["regions"] >= 1
    assert result["outlined_text_runs"] >= 1
    assert extract_text(target)["text"].strip("\n\x0c ") == ""


def test_flatten_without_the_options_leaves_text_live(tmp_dir, gs_path):
    source = text_over_alpha_pdf(os.path.join(tmp_dir, "a.pdf"))
    target = os.path.join(tmp_dir, "b.pdf")
    result = flatten_transparency(source, target, gs_path=gs_path)
    assert result["outlined_text_runs"] == 0
    assert "Live text" in extract_text(target)["text"]


def test_conversion_runs_on_a_page_with_no_transparency(tmp_dir, font_dir, gs_path):
    source = embedded_text_pdf(os.path.join(tmp_dir, "a.pdf"))
    target = os.path.join(tmp_dir, "b.pdf")
    result = flatten_transparency(
        source, target, gs_path=gs_path, outline_text=True, font_dir=font_dir,
    )
    assert result["regions"] == 0
    assert result["outlined_text_runs"] == 1
    assert extract_text(target)["text"].strip("\n\x0c ") == ""


def test_list_outlines_writes_nothing(tmp_dir, font_dir):
    source = embedded_text_pdf(os.path.join(tmp_dir, "a.pdf"))
    before = open(source, "rb").read()
    list_outlines(source, font_dir=font_dir)
    assert open(source, "rb").read() == before


def test_list_outlines_rejects_a_page_out_of_range(tmp_dir, font_dir):
    source = embedded_text_pdf(os.path.join(tmp_dir, "a.pdf"))
    with pytest.raises(ValueError, match="not in this document"):
        list_outlines(source, pages=[7], font_dir=font_dir)
