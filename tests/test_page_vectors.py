"""Phase 9.D1 — vector-object addressability (list + select + delete).

A vector object is a path-construction run (m/l/c/re/…) terminated by a
DRAWING paint (f/S/B/…); clip-only/clip-setting paths, form-nested paths,
text, and images are non-objects (v1 boundaries). Delete drops the target's
geometry + paint, nothing else.
"""

import os

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine.page_vectors import delete_page_vector, list_page_vectors


def _pdf(tmp_dir, content: bytes, name="v.pdf", resources=None) -> str:
    path = os.path.join(tmp_dir, name)
    pdf = pikepdf.new()
    pg = pdf.add_blank_page(page_size=(612, 792))
    pg.Contents = pdf.make_stream(content)
    if resources is not None:
        pg.Resources = resources
    pdf.save(path)
    pdf.close()
    return path


def _vecs(path):
    return list_page_vectors(path, 1)["vectors"]


def _body(path) -> bytes:
    with pikepdf.open(path) as pdf:
        return bytes(pdf.pages[0].Contents.read_bytes())


def _ops(path) -> list:
    with pikepdf.open(path) as pdf:
        return [str(i.operator) for i in pikepdf.parse_content_stream(pdf.pages[0])]


class TestListVectors:
    def test_lists_fill_and_stroke_in_draw_order(self, tmp_dir):
        src = _pdf(
            tmp_dir,
            b"1 0 0 rg 50 50 100 80 re f\n"
            b"0 0 1 RG 200 200 m 300 250 l 260 300 l S\n",
        )
        vs = _vecs(src)
        assert [v["kind"] for v in vs] == ["fill", "stroke"]
        # The fill rect's bbox is exact; the stroke's spans its points.
        assert vs[0]["rect"] == [50.0, 50.0, 150.0, 130.0]
        assert vs[1]["rect"] == [200.0, 200.0, 300.0, 300.0]

    def test_clip_and_crop_frame_and_clip_fill_excluded(self, tmp_dir):
        # `re W n` (a clip / a C3 crop frame) and `re W f` (a clip-SETTING
        # fill) are NOT objects — the phantom-object guard that keeps the
        # tools' own frames from listing.
        src = _pdf(
            tmp_dir,
            b"10 10 590 780 re W n\n"       # clip frame
            b"5 5 20 20 re W f\n"           # clip-setting fill
            b"40 40 60 60 re f\n",          # the ONE real object
        )
        vs = _vecs(src)
        assert len(vs) == 1
        assert vs[0]["rect"] == [40.0, 40.0, 100.0, 100.0]

    def test_text_and_image_not_listed(self, tmp_dir):
        fd = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
        pdf = pikepdf.new()
        pg = pdf.add_blank_page(page_size=(612, 792))
        img = pdf.make_stream(
            b"\x00",
            Type=Name.XObject,
            Subtype=Name.Image,
            Width=1,
            Height=1,
            ColorSpace=Name.DeviceGray,
            BitsPerComponent=8,
        )
        pg.Contents = pdf.make_stream(
            b"BT /F1 12 Tf 72 400 Td (hello) Tj ET\n"
            b"q 20 0 0 20 100 100 cm /Im Do Q\n"
            b"300 300 40 40 re f\n"  # the only vector
        )
        pg.Resources = Dictionary(
            Font=Dictionary(F1=fd),
            XObject=Dictionary(Im=pdf.make_indirect(img)),
        )
        path = os.path.join(tmp_dir, "ti.pdf")
        pdf.save(path)
        pdf.close()
        vs = _vecs(path)
        assert len(vs) == 1
        assert vs[0]["kind"] == "fill"

    def test_bbox_reflects_ctm(self, tmp_dir):
        # 0 0 10 10 re under [2 0 0 2 100 100] → device corners (100,100)-(120,120).
        src = _pdf(tmp_dir, b"q 2 0 0 2 100 100 cm 0 0 10 10 re f Q\n")
        vs = _vecs(src)
        assert vs[0]["rect"] == [100.0, 100.0, 120.0, 120.0]
        assert vs[0]["matrix"] == [2.0, 0.0, 0.0, 2.0, 100.0, 100.0]

    def test_curve_bbox_uses_control_points(self, tmp_dir):
        # A Bézier's control points are a superset of the curve → a box never
        # too small for hit-testing (the v1 approximation).
        src = _pdf(tmp_dir, b"100 100 m 120 400 300 400 320 100 c S\n")
        vs = _vecs(src)
        # min x = 100 (start), max x = 320 (end); y spans 100..400 (controls).
        assert vs[0]["rect"] == [100.0, 100.0, 320.0, 400.0]

    def test_colours_captured(self, tmp_dir):
        src = _pdf(
            tmp_dir,
            b"1 0 0 rg 0 0 10 10 re f\n"          # fill red
            b"0 1 0 RG 20 20 m 30 30 l S\n"        # stroke green
            b"0 0 0 0 k 40 40 10 10 re f\n",       # CMYK white-ish → rgb
        )
        vs = _vecs(src)
        assert vs[0]["fill"] == [1.0, 0.0, 0.0]
        assert vs[1]["stroke"] == [0.0, 1.0, 0.0]
        assert vs[2]["fill"] == [1.0, 1.0, 1.0]  # k=(0,0,0,0) → white

    def test_pattern_fill_colour_is_none_not_wrong(self, tmp_dir):
        # A /Pattern scn fill lists (the geometry is real) but its colour is an
        # honest None — never a guessed rgb.
        src = _pdf(
            tmp_dir,
            b"/Pattern cs /P1 scn 10 10 50 50 re f\n",
            resources=Dictionary(Pattern=Dictionary(P1=Dictionary(PatternType=1))),
        )
        vs = _vecs(src)
        assert len(vs) == 1
        assert vs[0]["fill"] is None

    def test_form_nested_paths_not_listed_v1(self, tmp_dir):
        # A path inside a Form XObject is NOT listed in v1 (page-content only —
        # a pinned boundary; a later D-slice that lifts it is a visible diff).
        pdf = pikepdf.new()
        pg = pdf.add_blank_page(page_size=(612, 792))
        form = pikepdf.Stream(
            pdf,
            b"5 5 30 30 re f\n",
            Type=Name.XObject,
            Subtype=Name.Form,
            BBox=[0, 0, 40, 40],
        )
        pg.Contents = pdf.make_stream(
            b"100 100 40 40 re f\n"      # page-level object (listed)
            b"q /Fm Do Q\n"             # form draw — its inner path NOT listed
        )
        pg.Resources = Dictionary(XObject=Dictionary(Fm=pdf.make_indirect(form)))
        path = os.path.join(tmp_dir, "fm.pdf")
        pdf.save(path)
        pdf.close()
        vs = _vecs(path)
        assert len(vs) == 1
        assert vs[0]["rect"] == [100.0, 100.0, 140.0, 140.0]


class TestDeleteVector:
    def test_drops_only_target_siblings_untouched(self, tmp_dir):
        src = _pdf(
            tmp_dir,
            b"50 50 100 80 re f\n"                     # obj0
            b"0 0 1 RG 200 200 m 300 250 l 260 300 l S\n"  # obj1 (delete this)
            b"400 400 30 30 re f\n",                   # obj2
        )
        out = os.path.join(tmp_dir, "o.pdf")
        delete_page_vector(src, out, 1, 1)
        vs = _vecs(out)
        assert len(vs) == 2
        assert [v["kind"] for v in vs] == ["fill", "fill"]
        body = _body(out)
        assert b"300 250 l" not in body          # the polyline is gone
        assert b"100 80 re" in body              # obj0 survived
        assert b"400 400 30 30 re" in body       # obj2 survived

    def test_delete_leaves_text_untouched(self, tmp_dir):
        fd = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
        src = _pdf(
            tmp_dir,
            b"BT /F1 12 Tf 72 400 Td (keepme) Tj ET\n"
            b"10 10 50 50 re f\n",
            resources=Dictionary(Font=Dictionary(F1=fd)),
        )
        out = os.path.join(tmp_dir, "o.pdf")
        delete_page_vector(src, out, 1, 0)
        assert _vecs(out) == []
        assert b"keepme" in _body(out)

    def test_delete_preserves_a_preceding_state_op(self, tmp_dir):
        # A colour set before the deleted path stays (it flows to following
        # content exactly as before — removing it would change that content).
        src = _pdf(tmp_dir, b"1 0 0 rg 10 10 20 20 re f\n0 0 0 rg 40 40 20 20 re f\n")
        out = os.path.join(tmp_dir, "o.pdf")
        delete_page_vector(src, out, 1, 0)  # drop the red rect
        body = _body(out)
        assert b"1 0 0 rg" in body           # the colour op is preserved
        assert b"10 10 20 20 re" not in body  # the geometry is gone
        assert len(_vecs(out)) == 1           # only the black rect remains

    def test_delete_preserves_interleaved_state_op_colour(self, tmp_dir):
        # Round-36 HIGH: a colour op issued BETWEEN a path's construction and
        # its paint — which a LATER object inherits — must survive the delete.
        # A range delete would drop it and silently re-blacken the neighbour.
        src = _pdf(
            tmp_dir,
            b"10 10 m 50 50 l\n"
            b"1 0 0 rg\n"           # red, issued mid-construction of object A
            b"90 90 l f\n"          # object A, painted red
            b"10 10 m 70 70 l f\n",  # object B — inherits the red (sets none)
        )
        assert [v["fill"] for v in _vecs(src)] == [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]]
        out = os.path.join(tmp_dir, "o.pdf")
        delete_page_vector(src, out, 1, 0)  # delete object A
        remaining = _vecs(out)
        assert len(remaining) == 1
        assert remaining[0]["fill"] == [1.0, 0.0, 0.0]  # B is STILL red
        assert b"1 0 0 rg" in _body(out)  # the interleaved colour op survived

    def test_delete_keeps_qQ_balanced(self, tmp_dir):
        # Round-36 HIGH: a q/Q pair straddling a path (legal — the current
        # path is not part of the graphics state) stays balanced after the
        # delete; a range delete would drop the Q and orphan the q.
        src = _pdf(
            tmp_dir,
            b"q 10 10 m 50 50 l Q f\n"   # object A, q..Q around its construction
            b"200 200 20 20 re f\n",     # object B
        )
        out = os.path.join(tmp_dir, "o.pdf")
        delete_page_vector(src, out, 1, 0)
        ops = _ops(out)
        assert ops.count("q") == ops.count("Q")  # balanced
        assert len(_vecs(out)) == 1  # object B survived

    def test_delete_out_of_range_raises(self, tmp_dir):
        src = _pdf(tmp_dir, b"10 10 20 20 re f\n")
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="out of range"):
            delete_page_vector(src, out, 1, 5)

    def test_page_out_of_range_raises(self, tmp_dir):
        src = _pdf(tmp_dir, b"10 10 20 20 re f\n")
        with pytest.raises(ValueError, match="out of range"):
            list_page_vectors(src, 9)
