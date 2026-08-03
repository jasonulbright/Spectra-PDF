"""Tests for the SVG → Form XObject compiler (P7 slice F)."""

import math

import pikepdf
import pytest

from engine.svg_pdf import (
    SvgUnsupported,
    compile_svg,
    parse_color,
    parse_path,
    parse_transform,
    path_bbox,
)


def _svg(body: bytes, viewbox: bytes = b"0 0 100 100") -> bytes:
    return (
        b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + viewbox + b'">' + body + b"</svg>"
    )


def _ops(form):
    def plain(v):
        if isinstance(v, pikepdf.Name):
            return str(v)
        if isinstance(v, pikepdf.Array):
            return [float(x) for x in v]
        return float(v)

    return [
        (str(i.operator), [plain(v) for v in i.operands])
        for i in pikepdf.parse_content_stream(form)
    ]


def _compile(body: bytes, viewbox: bytes = b"0 0 100 100"):
    """Compile against a Pdf KEPT ALIVE by the returned tuple — a dropped
    Pdf destroys every object created on it (the first run's whole failure
    mode: 'object of type destroyed')."""
    pdf = pikepdf.new()
    form, vw, vh = compile_svg(pdf, _svg(body, viewbox))
    return form, vw, vh, pdf


class TestPathData:
    def test_absolute_and_relative_commands(self):
        segs = parse_path("M 10 20 l 5 5 H 30 v -10 Z")
        assert segs == [
            ("M", 10, 20),
            ("L", 15, 25),
            ("L", 30, 25),
            ("L", 30, 15),
            ("Z",),
        ]

    def test_smooth_cubic_reflects_the_previous_control(self):
        segs = parse_path("M 0 0 C 10 0 20 0 30 0 S 50 10 60 0")
        assert segs[1] == ("C", 10, 0, 20, 0, 30, 0)
        # S reflects (20,0) about (30,0) → (40,0).
        assert segs[2] == ("C", 40, 0, 50, 10, 60, 0)

    def test_quadratics_elevate_to_cubics(self):
        segs = parse_path("M 0 0 Q 15 30 30 0")
        assert segs[1][0] == "C"
        # Elevation: c1 = p0 + 2/3(q−p0) = (10,20); c2 = p + 2/3(q−p) = (20,20).
        assert segs[1][1:] == (10, 20, 20, 20, 30, 0)

    def test_implicit_lineto_after_moveto(self):
        segs = parse_path("M 0 0 10 10 20 0")
        assert segs == [("M", 0, 0), ("L", 10, 10), ("L", 20, 0)]

    def test_arc_converts_to_cubics_and_lands_on_the_endpoint(self):
        segs = parse_path("M 0 0 A 50 50 0 0 1 100 0")
        assert all(s[0] == "C" for s in segs[1:])
        assert segs[-1][-2:] == pytest.approx((100, 0), abs=1e-9)

    def test_malformed_data_refuses(self):
        with pytest.raises(SvgUnsupported, match="path"):
            parse_path("M 10")
        with pytest.raises(SvgUnsupported, match="moveto"):
            parse_path("10 20 L 5 5")

    def test_bbox_includes_cubic_extrema(self):
        # A bulge whose apex lies between control points: control-point
        # bbox would say y max 30; the true curve peaks at 22.5.
        segs = parse_path("M 0 0 C 30 30 70 30 100 0")
        x0, y0, x1, y1 = path_bbox(segs)
        assert (x0, y0, x1) == (0, 0, 100)
        assert y1 == pytest.approx(22.5)


class TestTransforms:
    def test_list_composes_left_to_right(self):
        # translate then scale: the point (1,0) → scale first? No — SVG
        # applies LEFT first to the coordinate system, so the point maps
        # translate(10) ∘ scale(2): p·(scale then translate) = (12, 0).
        m = parse_transform("translate(10) scale(2)")
        from engine.svg_pdf import _apply

        assert _apply(m, 1, 0) == (12, 0)

    def test_rotate_about_a_center(self):
        m = parse_transform("rotate(90 10 10)")
        from engine.svg_pdf import _apply

        x, y = _apply(m, 20, 10)
        assert (round(x, 6), round(y, 6)) == (10, 20)

    def test_garbage_refuses(self):
        with pytest.raises(SvgUnsupported):
            parse_transform("translate(10) wobble(3)")


class TestColors:
    def test_hex_names_rgb(self):
        assert parse_color("#ff0000") == (1, 0, 0)
        assert parse_color("#0f0") == (0, 1, 0)
        assert parse_color("rebeccapurple") == (102 / 255, 51 / 255, 153 / 255)
        assert parse_color("rgb(0, 128, 255)") == (0, 128 / 255, 1)
        assert parse_color("rgb(50%, 0%, 100%)") == (0.5, 0, 1)

    def test_currentcolor_resolves_inherited(self):
        assert parse_color("currentColor", (0.1, 0.2, 0.3)) == (0.1, 0.2, 0.3)

    def test_unknown_refuses(self):
        with pytest.raises(SvgUnsupported):
            parse_color("chucknorris")


class TestCompile:
    def test_viewbox_normalizes_with_y_flip(self):
        form, vw, vh, _pdf = _compile(b'<rect x="0" y="0" width="100" height="50"/>', b"0 0 100 50")
        assert (vw, vh) == (100, 50)
        assert [float(v) for v in form["/BBox"]] == [0, 0, 1, 1]
        ops = _ops(form)
        # First cm is the normalization: [1/100, 0, 0, -1/50, 0, 1].
        cm = next(o for o in ops if o[0] == "cm")
        assert cm[1] == pytest.approx([0.01, 0, 0, -0.02, 0, 1])

    def test_offset_viewbox_translates(self):
        form, _, _, _pdf = _compile(b"<rect width='10' height='10'/>", b"-50 -25 100 50")
        cm = next(o for o in _ops(form) if o[0] == "cm")
        # (x−minx)/vw → +0.5; (miny+vh−y)/vh → maxy 25 → e=0.5, f=0.5.
        assert cm[1] == pytest.approx([0.01, 0, 0, -0.02, 0.5, 0.5])

    def test_marker_carries_the_viewbox(self):
        form, _, _, _pdf = _compile(b"<circle cx='5' cy='5' r='2'/>", b"0 0 10 20")
        vb = [float(v) for v in form["/SpectraVector"]["/ViewBox"]]
        assert vb == [0, 0, 10, 20]

    def test_css_class_and_id_beat_type_and_presentation(self):
        form, _, _, _pdf = _compile(
            b"<style>rect{fill:#0000ff}.hot{fill:#00ff00}#one{fill:#ff0000}</style>"
            b"<rect id='one' class='hot' width='10' height='10' fill='black'/>"
            b"<rect class='hot' width='10' height='10' fill='black'/>"
            b"<rect width='10' height='10' fill='black'/>"
        )
        rgs = [o[1] for o in _ops(form) if o[0] == "rg"]
        assert rgs[0] == pytest.approx([1, 0, 0])  # id wins
        assert rgs[1] == pytest.approx([0, 1, 0])  # class beats type
        assert rgs[2] == pytest.approx([0, 0, 1])  # type beats presentation

    def test_inline_style_beats_css(self):
        form, _, _, _pdf = _compile(
            b"<style>#x{fill:#00ff00}</style>"
            b"<rect id='x' width='4' height='4' style='fill:#ff0000'/>"
        )
        rg = next(o for o in _ops(form) if o[0] == "rg")
        assert rg[1] == pytest.approx([1, 0, 0])

    def test_fill_and_stroke_opacity_set_one_gs(self):
        form, _, _, _pdf = _compile(
            b"<rect width='10' height='10' fill='red' fill-opacity='0.5' "
            b"stroke='blue' stroke-opacity='0.25'/>"
        )
        egs = form["/Resources"]["/ExtGState"]
        entries = [egs[k] for k in egs.keys()]
        assert len(entries) == 1
        assert float(entries[0]["/ca"]) == pytest.approx(0.5)
        assert float(entries[0]["/CA"]) == pytest.approx(0.25)
        ops = [o[0] for o in _ops(form)]
        assert "B" in ops  # fill+stroke paints once

    def test_group_opacity_builds_a_transparency_group(self):
        form, _, _, _pdf = _compile(
            b"<g opacity='0.5'><rect width='10' height='10' fill='red' stroke='black'/></g>"
        )
        xo = form["/Resources"]["/XObject"]
        inner = xo[next(iter(xo.keys()))]
        assert str(inner["/Group"]["/S"]) == "/Transparency"
        ops = [o[0] for o in _ops(form)]
        assert "Do" in ops and "gs" in ops

    def test_evenodd_uses_star_operators(self):
        form, _, _, _pdf = _compile(
            b"<path d='M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z' fill-rule='evenodd' fill='black'/>"
        )
        assert "f*" in [o[0] for o in _ops(form)]

    def test_use_resolves_defs_with_translate(self):
        form, _, _, _pdf = _compile(
            b"<defs><rect id='u' width='5' height='5' fill='red'/></defs>"
            b"<use href='#u' x='20' y='30'/>"
        )
        cms = [o[1] for o in _ops(form) if o[0] == "cm"]
        assert any(c == pytest.approx([1, 0, 0, 1, 20, 30]) for c in cms)

    def test_use_cycle_refuses(self):
        svg = (
            b"<defs><g id='a'><use href='#b'/></g><g id='b'><use href='#a'/></g></defs>"
            b"<use href='#a'/>"
        )
        with pytest.raises(SvgUnsupported, match="cycle"):
            _compile(svg)

    def test_linear_gradient_clips_then_shades(self):
        form, _, _, _pdf = _compile(
            b"<defs><linearGradient id='g'>"
            b"<stop offset='0' stop-color='black'/><stop offset='1' stop-color='white'/>"
            b"</linearGradient></defs>"
            b"<rect x='10' y='20' width='40' height='20' fill='url(#g)'/>"
        )
        ops = _ops(form)
        names = [o[0] for o in ops]
        assert "sh" in names and "W" in names
        sh_res = form["/Resources"]["/Shading"]
        shading = sh_res[next(iter(sh_res.keys()))]
        assert int(shading["/ShadingType"]) == 2
        # objectBoundingBox: a cm maps unit→bbox [40,0,0,20,10,20] before sh.
        cms = [o[1] for o in ops if o[0] == "cm"]
        assert any(c == pytest.approx([40, 0, 0, 20, 10, 20]) for c in cms)

    def test_multi_stop_gradient_stitches(self):
        form, _, _, _pdf = _compile(
            b"<defs><linearGradient id='g' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='100' y2='0'>"
            b"<stop offset='0' stop-color='red'/><stop offset='0.5' stop-color='lime'/>"
            b"<stop offset='1' stop-color='blue'/></linearGradient></defs>"
            b"<rect width='100' height='10' fill='url(#g)'/>"
        )
        sh_res = form["/Resources"]["/Shading"]
        fn = sh_res[next(iter(sh_res.keys()))]["/Function"]
        assert int(fn["/FunctionType"]) == 3
        assert [float(v) for v in fn["/Bounds"]] == [0.5]

    def test_radial_gradient_href_template(self):
        form, _, _, _pdf = _compile(
            b"<defs><linearGradient id='stops'>"
            b"<stop offset='0' stop-color='red'/><stop offset='1' stop-color='blue'/>"
            b"</linearGradient>"
            b"<radialGradient id='g' href='#stops' cx='0.5' cy='0.5' r='0.5'/></defs>"
            b"<circle cx='50' cy='50' r='40' fill='url(#g)'/>"
        )
        sh_res = form["/Resources"]["/Shading"]
        shading = sh_res[next(iter(sh_res.keys()))]
        assert int(shading["/ShadingType"]) == 3

    def test_clip_path_emits_a_clip(self):
        form, _, _, _pdf = _compile(
            b"<defs><clipPath id='c'><circle cx='50' cy='50' r='20'/></clipPath></defs>"
            b"<rect width='100' height='100' fill='red' clip-path='url(#c)'/>"
        )
        names = [o[0] for o in _ops(form)]
        w_at = names.index("W")
        assert names[w_at + 1] == "n"

    def test_dasharray_caps_joins(self):
        form, _, _, _pdf = _compile(
            b"<line x1='0' y1='0' x2='10' y2='10' stroke='black' "
            b"stroke-linecap='round' stroke-linejoin='bevel' stroke-dasharray='3 1'/>"
        )
        ops = _ops(form)
        assert next(o[1] for o in ops if o[0] == "J") == [1]
        assert next(o[1] for o in ops if o[0] == "j") == [2]
        assert "d" in [o[0] for o in ops]

    def test_display_none_and_visibility_hidden_drop(self):
        form, _, _, _pdf = _compile(
            b"<rect width='5' height='5' display='none' fill='red'/>"
            b"<rect width='5' height='5' visibility='hidden' fill='red'/>"
        )
        assert [o for o in _ops(form) if o[0] in ("f", "B", "S")] == []

    def test_animation_elements_are_ignored(self):
        form, _, _, _pdf = _compile(
            b"<rect width='5' height='5' fill='red'>"
            b"<animate attributeName='x' from='0' to='10' dur='1s'/></rect>"
        )
        assert "f" in [o[0] for o in _ops(form)]


class TestRefusals:
    def refuse(self, body, match, viewbox=b"0 0 100 100"):
        with pytest.raises(SvgUnsupported, match=match):
            _compile(body, viewbox)

    def test_named_refusals(self):
        self.refuse(b"<text x='0' y='0'>hi</text>", "text")
        self.refuse(b"<image href='x.png' width='5' height='5'/>", "image")
        self.refuse(b"<foreignObject width='5' height='5'/>", "foreignObject")
        self.refuse(b"<switch><rect width='5' height='5'/></switch>", "switch")
        self.refuse(
            b"<defs><filter id='f'><feGaussianBlur/></filter></defs>"
            b"<rect width='5' height='5' filter='url(#f)'/>",
            "filter",
        )

    def test_doctype_refuses(self):
        with pytest.raises(SvgUnsupported, match="DOCTYPE"):
            compile_svg(
                pikepdf.new(),
                b'<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
            )

    def test_gradient_stroke_refuses(self):
        self.refuse(
            b"<defs><linearGradient id='g'><stop offset='0' stop-color='red'/>"
            b"<stop offset='1' stop-color='blue'/></linearGradient></defs>"
            b"<line x1='0' y1='0' x2='9' y2='9' stroke='url(#g)'/>",
            "gradient strokes",
        )

    def test_stop_opacity_refuses(self):
        self.refuse(
            b"<defs><linearGradient id='g'><stop offset='0' stop-color='red' stop-opacity='0.5'/>"
            b"<stop offset='1' stop-color='blue'/></linearGradient></defs>"
            b"<rect width='5' height='5' fill='url(#g)'/>",
            "stop-opacity",
        )

    def test_pattern_paint_refuses(self):
        self.refuse(
            b"<defs><pattern id='p' width='4' height='4'/></defs>"
            b"<rect width='5' height='5' fill='url(#p)'/>",
            "pattern",
        )

    def test_css_beyond_the_simple_grammar_refuses(self):
        self.refuse(b"<style>@media print{rect{fill:red}}</style><rect width='5' height='5'/>", "CSS")
        self.refuse(b"<style>g rect{fill:red}</style><rect width='5' height='5'/>", "CSS")

    def test_physical_units_refuse(self):
        self.refuse(b"<rect width='5cm' height='5'/>", "length")

    def test_marker_property_refuses(self):
        self.refuse(
            b"<defs><marker id='m'/></defs>"
            b"<path d='M0 0 L9 9' stroke='black' marker-end='url(#m)'/>",
            "marker",
        )

    def test_missing_viewbox_and_size_refuses(self):
        with pytest.raises(SvgUnsupported, match="viewBox"):
            compile_svg(pikepdf.new(), b'<svg xmlns="http://www.w3.org/2000/svg"/>')

    def test_broken_reference_refuses(self):
        self.refuse(b"<use href='#nope'/>", "missing")
        self.refuse(b"<rect width='5' height='5' fill='url(#nope)'/>", "nothing")


class TestWidthHeightFallback:
    def test_width_height_without_viewbox(self):
        pdf = pikepdf.new()
        form, vw, vh = compile_svg(
            pdf,
            b'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">'
            b'<rect width="80" height="40" fill="black"/></svg>',
        )
        assert (vw, vh) == (80, 40)
        cm = next(
            o
            for o in [
                (str(i.operator), [float(v) for v in i.operands])
                for i in pikepdf.parse_content_stream(form)
                if str(i.operator) == "cm"
            ]
        )
        assert cm[1] == pytest.approx([1 / 80, 0, 0, -1 / 40, 0, 1])
