"""N11 slice A — `list_page_geometry`, the snap-geometry probe.

Per painted, unclipped path: its device-space SUBPATHS (curves flattened to a
0.25 pt chord tolerance) plus a `closed` flag per subpath; per placed image or
form, a `"placement"` quad. Reuses `_walk_vectors`' traversal, so the CTM
composition, the form-XObject chain, the `v`/`y` grammar and the clip
exclusion are the SAME code the bbox listing uses — these tests exist to prove
the second product agrees with that one walk, not to re-test the walk.
"""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

from engine.bezier import cubic_axis_value, flatten_cubic
from engine.page_vectors import list_page_geometry, list_page_vectors


def _pdf(tmp_dir, content: bytes, name="g.pdf", resources=None) -> str:
    path = os.path.join(tmp_dir, name)
    pdf = pikepdf.new()
    pg = pdf.add_blank_page(page_size=(612, 792))
    pg.Contents = pdf.make_stream(content)
    if resources is not None:
        pg.Resources = resources
    pdf.save(path)
    pdf.close()
    return path


def _paths(path):
    return list_page_geometry(path, 1)["paths"]


def _pts(sub):
    return [(sub[i], sub[i + 1]) for i in range(0, len(sub), 2)]


def _dist_to_segment(p, a, b) -> float:
    px, py = p
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    span = dx * dx + dy * dy
    if span < 1e-15:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / span))
    qx, qy = ax + t * dx, ay + t * dy
    return ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5


class TestFlattening:
    def test_bulging_cubic_stays_inside_the_chord_bound(self):
        # A deliberately fat curve: control points far off the chord, so a
        # naive "just use the endpoints" would be wrong by ~100 pt.
        P0, P1, P2, P3 = (0.0, 0.0), (0.0, 200.0), (400.0, 200.0), (400.0, 0.0)
        poly = [P0] + flatten_cubic(P0, P1, P2, P3, 0.25)
        # Measure the REAL deviation: sample the true curve densely and ask
        # how far each sample is from the polyline we would snap to.
        worst = 0.0
        for i in range(2001):
            t = i / 2000.0
            c = (
                cubic_axis_value(P0[0], P1[0], P2[0], P3[0], t),
                cubic_axis_value(P0[1], P1[1], P2[1], P3[1], t),
            )
            worst = max(
                worst,
                min(_dist_to_segment(c, poly[j], poly[j + 1]) for j in range(len(poly) - 1)),
            )
        assert worst <= 0.25 + 1e-9
        # …and it does not achieve that by emitting thousands of points.
        assert 4 <= len(poly) <= 64

    def test_endpoints_are_exact_not_approximated(self):
        P0, P1, P2, P3 = (10.0, 20.0), (30.0, 90.0), (70.0, 90.0), (90.0, 20.0)
        poly = flatten_cubic(P0, P1, P2, P3, 0.25)
        assert poly[-1] == P3

    def test_a_straight_cubic_needs_no_subdivision(self):
        # Control points ON the chord: one segment, the chord itself.
        assert flatten_cubic((0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0), 0.25) == [
            (3.0, 0.0)
        ]

    def test_a_degenerate_loop_still_terminates(self):
        # P0 == P3 (no chord to measure against) with control points far away.
        poly = flatten_cubic((0.0, 0.0), (0.0, 300.0), (300.0, 300.0), (0.0, 0.0), 0.25)
        assert poly[-1] == (0.0, 0.0)
        assert len(poly) < 5000


class TestSubpaths:
    def test_polyline_interior_vertices_survive(self, tmp_dir):
        # The whole reason this call exists: a bbox cannot spell these.
        src = _pdf(tmp_dir, b"200 200 m 300 250 l 260 300 l S\n")
        (p,) = _paths(src)
        assert p["kind"] == "stroke"
        assert p["closed"] == [False]
        assert _pts(p["subpaths"][0]) == [(200.0, 200.0), (300.0, 250.0), (260.0, 300.0)]

    def test_re_gives_four_corners_and_closes(self, tmp_dir):
        src = _pdf(tmp_dir, b"50 50 100 80 re f\n")
        (p,) = _paths(src)
        assert p["closed"] == [True]
        assert _pts(p["subpaths"][0]) == [
            (50.0, 50.0),
            (150.0, 50.0),
            (150.0, 130.0),
            (50.0, 130.0),
        ]

    def test_h_closes_the_subpath_S_alone_does_not(self, tmp_dir):
        closed = _paths(_pdf(tmp_dir, b"10 10 m 60 10 l 60 60 l h S\n", name="c.pdf"))
        opened = _paths(_pdf(tmp_dir, b"10 10 m 60 10 l 60 60 l S\n", name="o.pdf"))
        assert closed[0]["closed"] == [True]
        assert opened[0]["closed"] == [False]

    def test_a_fill_closes_every_subpath_implicitly(self, tmp_dir):
        # `f` paints the region, so the last→first boundary segment IS drawn
        # even without an `h` — and is therefore a snap target.
        src = _pdf(tmp_dir, b"10 10 m 60 10 l 60 60 l f\n")
        assert _paths(src)[0]["closed"] == [True]

    def test_multiple_subpaths_report_independently(self, tmp_dir):
        src = _pdf(tmp_dir, b"10 10 m 60 10 l h 100 100 m 160 100 l S\n")
        (p,) = _paths(src)
        assert len(p["subpaths"]) == 2
        assert p["closed"] == [True, False]

    def test_v_and_y_expand_to_the_right_curve(self, tmp_dir):
        # `v` reuses the CURRENT point as its first control; `y` duplicates
        # its endpoint as the second. Both must end where the operands say.
        src = _pdf(tmp_dir, b"100 100 m 200 200 300 100 v 400 200 500 100 y S\n")
        (p,) = _paths(src)
        pts = _pts(p["subpaths"][0])
        assert pts[0] == (100.0, 100.0)
        assert pts[-1] == (500.0, 100.0)
        # The `v` segment's own endpoint appears in the middle of the run.
        assert (300.0, 100.0) in pts

    def test_a_lone_moveto_contributes_nothing(self, tmp_dir):
        src = _pdf(tmp_dir, b"10 10 m 300 300 m 360 300 l S\n")
        (p,) = _paths(src)
        assert len(p["subpaths"]) == 1
        assert _pts(p["subpaths"][0])[0] == (300.0, 300.0)

    def test_clipped_away_paths_are_absent(self, tmp_dir):
        # The S8 rule the walk already applies: a path wholly outside the
        # ambient clip is invisible, so it is not a snap target either.
        src = _pdf(
            tmp_dir,
            b"q 0 0 100 100 re W n 400 400 m 500 500 l S Q\n"
            b"10 10 m 60 60 l S\n",
        )
        paths = _paths(src)
        assert len(paths) == 1
        assert _pts(paths[0]["subpaths"][0])[0] == (10.0, 10.0)

    def test_indices_are_contiguous_after_exclusions(self, tmp_dir):
        src = _pdf(
            tmp_dir,
            b"q 0 0 10 10 re W n 400 400 m 500 500 l S Q\n"
            b"10 10 m 60 60 l S\n"
            b"20 20 m 70 70 l S\n",
        )
        assert [p["index"] for p in _paths(src)] == [0, 1]


class TestTransforms:
    def test_a_rotated_ctm_reports_device_points(self, tmp_dir):
        # 90° rotation: user (10,0) lands at device (0,10). Transforming a
        # user-space bbox would be wrong here — the points themselves map.
        src = _pdf(tmp_dir, b"q 0 1 -1 0 0 0 cm 0 0 m 10 0 l S Q\n")
        (p,) = _paths(src)
        assert _pts(p["subpaths"][0]) == [(0.0, 0.0), (0.0, 10.0)]

    def test_nested_form_ctm_composes_through_the_chain(self, tmp_dir):
        # Depth 2 (the P8 slice-C chain): page cm ∘ outer /Matrix ∘ inner
        # /Matrix must all compose onto the emitted points.
        path = os.path.join(tmp_dir, "nested.pdf")
        pdf = pikepdf.new()
        pg = pdf.add_blank_page(page_size=(612, 792))
        inner = pdf.make_stream(b"0 0 m 10 0 l S\n")
        inner.Subtype = Name("/Form")
        inner.BBox = Array([0, 0, 100, 100])
        inner.Matrix = Array([1, 0, 0, 1, 5, 0])  # +5 in x
        outer = pdf.make_stream(b"/In Do\n")
        outer.Subtype = Name("/Form")
        outer.BBox = Array([0, 0, 100, 100])
        outer.Matrix = Array([1, 0, 0, 1, 0, 7])  # +7 in y
        outer.Resources = Dictionary(XObject=Dictionary(In=inner))
        pg.Contents = pdf.make_stream(b"q 1 0 0 1 100 200 cm /Out Do Q\n")
        pg.Resources = Dictionary(XObject=Dictionary(Out=outer))
        pdf.save(path)
        pdf.close()
        strokes = [p for p in list_page_geometry(path, 1)["paths"] if p["kind"] == "stroke"]
        assert len(strokes) == 1
        assert _pts(strokes[0]["subpaths"][0]) == [(105.0, 207.0), (115.0, 207.0)]


class TestPlacements:
    def test_an_image_Do_yields_its_unit_square_quad(self, tmp_dir):
        path = os.path.join(tmp_dir, "img.pdf")
        pdf = pikepdf.new()
        pg = pdf.add_blank_page(page_size=(612, 792))
        img = pdf.make_stream(b"\x00\x00\x00")
        img.Subtype = Name("/Image")
        img.Width = 1
        img.Height = 1
        img.ColorSpace = Name("/DeviceRGB")
        img.BitsPerComponent = 8
        pg.Contents = pdf.make_stream(b"q 200 0 0 100 50 60 cm /Im Do Q\n")
        pg.Resources = Dictionary(XObject=Dictionary(Im=img))
        pdf.save(path)
        pdf.close()
        placements = [
            p for p in list_page_geometry(path, 1)["paths"] if p["kind"] == "placement"
        ]
        assert len(placements) == 1
        assert placements[0]["closed"] == [True]
        assert _pts(placements[0]["subpaths"][0]) == [
            (50.0, 60.0),
            (250.0, 60.0),
            (250.0, 160.0),
            (50.0, 160.0),
        ]

    def test_a_form_Do_uses_its_BBox_not_the_unit_square(self, tmp_dir):
        # A form's extent is /BBox through /Matrix; the unit square would put
        # snap targets on a 1×1 box that has nothing to do with the drawing.
        path = os.path.join(tmp_dir, "form.pdf")
        pdf = pikepdf.new()
        pg = pdf.add_blank_page(page_size=(612, 792))
        form = pdf.make_stream(b"0 0 m 10 10 l S\n")
        form.Subtype = Name("/Form")
        form.BBox = Array([0, 0, 40, 20])
        pg.Contents = pdf.make_stream(b"q 1 0 0 1 100 100 cm /Fm Do Q\n")
        pg.Resources = Dictionary(XObject=Dictionary(Fm=form))
        pdf.save(path)
        pdf.close()
        placements = [
            p for p in list_page_geometry(path, 1)["paths"] if p["kind"] == "placement"
        ]
        assert _pts(placements[0]["subpaths"][0]) == [
            (100.0, 100.0),
            (140.0, 100.0),
            (140.0, 120.0),
            (100.0, 120.0),
        ]


class TestStability:
    def test_same_file_yields_a_byte_identical_payload(self, tmp_dir):
        import json

        src = _pdf(
            tmp_dir,
            b"1 0 0 rg 50 50 100 80 re f\n"
            b"100 400 m 150 500 250 500 300 400 c S\n"
            b"q 0.3 0.9 -0.9 0.3 20 30 cm 0 0 m 40 10 l S Q\n",
        )
        a = json.dumps(list_page_geometry(src, 1), sort_keys=True)
        b = json.dumps(list_page_geometry(src, 1), sort_keys=True)
        assert a == b
        # Rounding is real: no coordinate carries float noise past 2 dp.
        for p in list_page_geometry(src, 1)["paths"]:
            for sub in p["subpaths"]:
                for v in sub:
                    assert round(v, 2) == v

    def test_page_range_is_validated(self, tmp_dir):
        src = _pdf(tmp_dir, b"10 10 m 60 60 l S\n")
        with pytest.raises(ValueError):
            list_page_geometry(src, 2)
        with pytest.raises(ValueError):
            list_page_geometry(src, 0)

    def test_the_bbox_listing_is_untouched_by_the_geometry_arm(self, tmp_dir):
        # The geometry walk is OPT-IN precisely so the editors' object ids
        # cannot shift: an image `Do` emits a placement over there and
        # nothing at all here.
        path = os.path.join(tmp_dir, "both.pdf")
        pdf = pikepdf.new()
        pg = pdf.add_blank_page(page_size=(612, 792))
        img = pdf.make_stream(b"\x00\x00\x00")
        img.Subtype = Name("/Image")
        img.Width = 1
        img.Height = 1
        img.ColorSpace = Name("/DeviceRGB")
        img.BitsPerComponent = 8
        pg.Contents = pdf.make_stream(
            b"q 20 0 0 20 0 0 cm /Im Do Q\n10 10 m 60 60 l S\n"
        )
        pg.Resources = Dictionary(XObject=Dictionary(Im=img))
        pdf.save(path)
        pdf.close()
        vectors = list_page_vectors(path, 1)["vectors"]
        assert [v["kind"] for v in vectors] == ["stroke"]
        assert "subpaths" not in vectors[0]
        assert [p["kind"] for p in list_page_geometry(path, 1)["paths"]] == [
            "placement",
            "stroke",
        ]
