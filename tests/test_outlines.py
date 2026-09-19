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
    embed_truetype,
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
from text_state_shapes import SHAPES, TEXT, shape_pdf

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


# ── the state a run and a form draw in ─────────────────────────────────────


def _rgb_ink(gs_path, source, target, rows, cols):
    """The mean colour of the inked pixels in one window of a 72 dpi render,
    and how many there are."""
    import numpy as np
    from PIL import Image

    subprocess.run(
        [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=png16m",
         "-r72", "-o", str(target), str(source)],
        check=True, stdin=subprocess.DEVNULL, capture_output=True,
    )
    with Image.open(target) as image:
        window = np.asarray(image.convert("RGB")).astype(int)[rows, cols].reshape(-1, 3)
    inked = window[(window < 200).any(axis=1)]
    return (inked.mean(axis=0) if len(inked) else None), len(inked)


def _direct(font):
    """A direct copy of an indirect font dictionary: no object number of its
    own, the way some producers write a resource."""
    return pikepdf.Dictionary({key: font[key] for key in font.keys()})


def _state_doc(label: str, sans, serif, pdf):
    """Shapes A, A2 and B drawn in embedded faces: the text state's font is
    the sans face at 24 pt, and the name the stream would resolve gives the
    serif face (A2 at 1 pt)."""
    text = b"(Hamburgefonstiv) Tj"
    page = pdf.add_blank_page(page_size=(400.0, 200.0))
    gs = pikepdf.Dictionary(Type=pikepdf.Name.ExtGState, Font=pikepdf.Array([sans, 24]))
    if label == "A":
        page.Resources = pikepdf.Dictionary(ExtGState=pikepdf.Dictionary(GS1=gs))
        page.Contents = pdf.make_stream(b"BT /GS1 gs 1 0 0 1 30 80 Tm " + text + b" ET")
    elif label == "A2":
        page.Resources = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F2=serif), ExtGState=pikepdf.Dictionary(GS1=gs))
        page.Contents = pdf.make_stream(
            b"BT /F2 1 Tf /GS1 gs 1 0 0 1 30 80 Tm " + text + b" ET")
    else:
        form = pdf.make_stream(b"BT 1 0 0 1 30 80 Tm " + text + b" ET")
        form["/Type"] = pikepdf.Name.XObject
        form["/Subtype"] = pikepdf.Name.Form
        form["/BBox"] = pikepdf.Array([0, 0, 400, 200])
        form["/Resources"] = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=serif))
        page.Resources = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F1=sans),
            XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(form)))
        page.Contents = pdf.make_stream(b"BT /F1 24 Tf ET /Fm0 Do")


class TestTheTextState:
    """A run converts with the font the text state holds (ISO 32000-2
    §9.3.1): the one an ExtGState /Font entry sets (Table 57), or the one a
    form inherits from its Do (§8.10.1), whatever the form's own resources
    call by that name. A form's strokes convert in the width and colour it
    inherits, and it converts once per state it is drawn in."""

    @pytest.mark.parametrize("label", SHAPES)
    def test_the_shared_shapes_convert_with_the_drawn_font(self, tmp_dir, font_dir, label):
        report = list_outlines(shape_pdf(tmp_dir, label), font_dir=font_dir)
        assert report["refusals"] == []
        page = report["pages"][0]
        assert page["fonts"] == ["Wide"]
        assert page["glyphs"] == len(TEXT.replace(b" ", b""))

    @pytest.mark.parametrize("label", SHAPES)
    def test_the_drawn_font_converts_and_renders_equivalently(
        self, tmp_dir, font_dir, gs_path, label
    ):
        pytest.importorskip("numpy")
        from outline_builders import SERIF

        pdf = pikepdf.new()
        _state_doc(label, embed_truetype(pdf), embed_truetype(pdf, SERIF, "/LibSerif"), pdf)
        source = os.path.join(tmp_dir, f"{label}.pdf")
        pdf.save(source)
        pdf.close()
        target = os.path.join(tmp_dir, f"{label}-out.pdf")
        result = _convert_all(source, target, font_dir)[0]
        assert result["fonts"] == ["LibSans"]
        deep, delta = _compare(gs_path, tmp_dir, source, target, 300, label)
        assert deep == 0
        assert abs(delta) < 0.10
        assert extract_text(target)["text"].strip("\n\x0c ") == ""

    def test_two_direct_font_dictionaries_keep_their_own_glyphs(
        self, tmp_dir, font_dir, gs_path
    ):
        pytest.importorskip("numpy")
        from outline_builders import SERIF

        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400.0, 200.0))
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(
            F1=_direct(embed_truetype(pdf)),
            F2=_direct(embed_truetype(pdf, SERIF, "/LibSerif"))))
        page.Contents = pdf.make_stream(
            b"BT /F1 24 Tf 1 0 0 1 30 130 Tm (Hamburg) Tj ET "
            b"BT /F2 24 Tf 1 0 0 1 30 50 Tm (Hamburg) Tj ET")
        source = os.path.join(tmp_dir, "direct.pdf")
        pdf.save(source)
        pdf.close()
        target = os.path.join(tmp_dir, "direct-out.pdf")
        result = _convert_all(source, target, font_dir)[0]
        assert result["fonts"] == ["LibSans", "LibSerif"]
        deep, _delta = _compare(gs_path, tmp_dir, source, target, 300, "direct")
        assert deep == 0

    def test_one_form_drawn_in_two_fonts_converts_once_for_each(
        self, tmp_dir, font_dir, gs_path
    ):
        pytest.importorskip("numpy")
        from outline_builders import SERIF

        pdf = pikepdf.new()
        form = pdf.make_stream(b"BT 1 0 0 1 20 20 Tm (Wave) Tj ET")
        form["/Type"] = pikepdf.Name.XObject
        form["/Subtype"] = pikepdf.Name.Form
        form["/BBox"] = pikepdf.Array([0, 0, 400, 100])
        form["/Resources"] = pikepdf.Dictionary()
        page = pdf.add_blank_page(page_size=(400.0, 200.0))
        page.Resources = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F1=embed_truetype(pdf), F2=embed_truetype(pdf, SERIF, "/LibSerif")),
            XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(form)))
        page.Contents = pdf.make_stream(
            b"BT /F1 24 Tf ET /Fm0 Do BT /F2 24 Tf ET q 1 0 0 1 0 100 cm /Fm0 Do Q")
        source = os.path.join(tmp_dir, "twice.pdf")
        pdf.save(source)
        pdf.close()
        target = os.path.join(tmp_dir, "twice-out.pdf")
        result = _convert_all(source, target, font_dir)[0]
        assert result["fonts"] == ["LibSans", "LibSerif"]
        deep, _delta = _compare(gs_path, tmp_dir, source, target, 300, "twice")
        assert deep == 0
        with pikepdf.open(target) as out:
            drawn = [str(i.operands[0]) for i in pikepdf.parse_content_stream(out.pages[0])
                     if str(i.operator) == "Do"]
            names = [str(name) for name in out.pages[0].Resources.XObject.keys()]
        assert len(set(drawn)) == 2
        # The converted page does not reach the unconverted form.
        assert "/Fm0" not in names

    def test_a_pattern_cell_in_a_form_draws_in_the_form_s_starting_state(
        self, tmp_dir, font_dir
    ):
        # §8.7.3.1 b: the cell starts in the state in effect at the beginning
        # of the stream that owns the pattern, here the form, which starts in
        # the state of its Do.
        pdf = pikepdf.new()
        cell = pdf.make_stream(b"BT 1 0 0 1 10 40 Tm (Wave) Tj ET")
        cell["/Type"] = pikepdf.Name.Pattern
        cell["/PatternType"] = 1
        cell["/PaintType"] = 1
        cell["/TilingType"] = 1
        cell["/BBox"] = pikepdf.Array([0, 0, 100, 100])
        cell["/XStep"] = 100
        cell["/YStep"] = 100
        cell["/Resources"] = pikepdf.Dictionary()
        form = pdf.make_stream(b"/Pattern cs /P0 scn 0 0 200 200 re f")
        form["/Type"] = pikepdf.Name.XObject
        form["/Subtype"] = pikepdf.Name.Form
        form["/BBox"] = pikepdf.Array([0, 0, 200, 200])
        form["/Resources"] = pikepdf.Dictionary(Pattern=pikepdf.Dictionary(P0=pdf.make_indirect(cell)))
        page = pdf.add_blank_page(page_size=(200.0, 200.0))
        page.Resources = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F1=embed_truetype(pdf)),
            XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(form)))
        page.Contents = pdf.make_stream(b"BT /F1 24 Tf ET /Fm0 Do")
        source = os.path.join(tmp_dir, "cell.pdf")
        pdf.save(source)
        pdf.close()
        report = list_outlines(source, font_dir=font_dir)
        assert report["refusals"] == []
        assert report["pages"][0]["fonts"] == ["LibSans"]
        assert report["pages"][0]["glyphs"] == 4

    def test_text_drawn_before_any_font_refuses_by_name(self, tmp_dir, font_dir):
        source = page_pdf(os.path.join(tmp_dir, "nofont.pdf"),
                          b"BT 1 0 0 1 20 20 Tm (x) Tj ET")
        report = list_outlines(source, font_dir=font_dir)
        assert report["refusals"] == ["Page 1 draws text with no font selected."]

    def test_the_default_stroke_colour_converts_black_under_any_fill(
        self, tmp_dir, font_dir, gs_path
    ):
        pytest.importorskip("numpy")
        source = page_pdf(os.path.join(tmp_dir, "black.pdf"),
                          b"1 0 0 rg 10 w 50 200 m 350 200 l S")
        target = os.path.join(tmp_dir, "black-out.pdf")
        _convert_all(source, target, font_dir)
        window = (slice(190, 211), slice(60, 340))
        before, count = _rgb_ink(gs_path, source, os.path.join(tmp_dir, "b.png"), *window)
        after, converted = _rgb_ink(gs_path, target, os.path.join(tmp_dir, "a.png"), *window)
        assert count > 0 and converted > 0
        assert list(before) == pytest.approx([0, 0, 0], abs=1)
        assert list(after) == pytest.approx([0, 0, 0], abs=1)

    def test_a_form_stroke_converts_in_the_width_and_colour_it_inherits(
        self, tmp_dir, font_dir, gs_path
    ):
        pytest.importorskip("numpy")
        pdf = pikepdf.new()
        form = pdf.make_stream(b"50 200 m 350 200 l S")
        form["/Type"] = pikepdf.Name.XObject
        form["/Subtype"] = pikepdf.Name.Form
        form["/BBox"] = pikepdf.Array([0, 0, 400, 400])
        form["/Resources"] = pikepdf.Dictionary()
        page = pdf.add_blank_page(page_size=(400.0, 400.0))
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(form)))
        page.Contents = pdf.make_stream(b"20 w 1 0 0 RG 0 0 1 rg /Fm0 Do")
        source = os.path.join(tmp_dir, "inherit.pdf")
        pdf.save(source)
        pdf.close()
        target = os.path.join(tmp_dir, "inherit-out.pdf")
        _convert_all(source, target, font_dir)
        deep, _delta = _compare(gs_path, tmp_dir, source, target, 150, "inherit")
        assert deep == 0
        colour, count = _rgb_ink(gs_path, target, os.path.join(tmp_dir, "i.png"),
                                 slice(185, 216), slice(60, 340))
        assert count > 5000
        assert list(colour) == pytest.approx([255, 0, 0], abs=1)

    def test_one_form_drawn_under_one_name_in_two_fonts_converts_once_for_each(
        self, tmp_dir, font_dir, gs_path
    ):
        # The page's /F1 is the sans face and the outer form's own /F1 the
        # serif one: one name, two fonts, and the inner form draws in each.
        pytest.importorskip("numpy")
        from outline_builders import SERIF

        pdf = pikepdf.new()

        def form(content, resources):
            stream = pdf.make_stream(content)
            stream["/Type"] = pikepdf.Name.XObject
            stream["/Subtype"] = pikepdf.Name.Form
            stream["/BBox"] = pikepdf.Array([0, 0, 400, 200])
            stream["/Resources"] = resources
            return pdf.make_indirect(stream)

        inner = form(b"BT 1 0 0 1 20 20 Tm (Wave) Tj ET", pikepdf.Dictionary())
        outer = form(
            b"BT /F1 24 Tf ET q 1 0 0 1 0 100 cm /Fm0 Do Q",
            pikepdf.Dictionary(
                Font=pikepdf.Dictionary(F1=embed_truetype(pdf, SERIF, "/LibSerif")),
                XObject=pikepdf.Dictionary(Fm0=inner)),
        )
        page = pdf.add_blank_page(page_size=(400.0, 200.0))
        page.Resources = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F1=embed_truetype(pdf)),
            XObject=pikepdf.Dictionary(Fm0=inner, Fo=outer))
        page.Contents = pdf.make_stream(b"BT /F1 24 Tf ET /Fm0 Do /Fo Do")
        source = os.path.join(tmp_dir, "one-name.pdf")
        pdf.save(source)
        pdf.close()
        target = os.path.join(tmp_dir, "one-name-out.pdf")
        result = _convert_all(source, target, font_dir)[0]
        assert result["fonts"] == ["LibSans", "LibSerif"]
        deep, _delta = _compare(gs_path, tmp_dir, source, target, 300, "one-name")
        assert deep == 0
