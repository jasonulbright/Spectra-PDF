"""Hairlines: the effective-width measurement and the correction it drives.

The case worth naming is the scaled one — a `1 w` under a tenth-scale
transform draws 0.1 pt and lists as 1.0 — because reading the operand alone
both misses it and, if corrected in operand space, over-corrects it tenfold.
"""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

from engine.hairlines import (
    fix_hairlines,
    hairline_check,
    is_hairline,
    list_hairlines,
    validated_bounds,
)
from engine.page_vectors import list_page_vectors
from hairline_builders import LADDER_WIDTHS as LADDER, hairline_ladder_pdf as _ladder_pdf


def _nested_pdf(path, inner_width=0.1, form_scale=1.0):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    form = pikepdf.Stream(pdf, f"{inner_width} w 10 10 m 90 90 l S".encode())
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = Array([0, 0, 100, 100])
    form.Resources = Dictionary()
    page.Resources = Dictionary(XObject=Dictionary(Fm0=pdf.make_indirect(form)))
    page.Contents = pdf.make_stream(
        f"q {form_scale} 0 0 {form_scale} 20 20 cm /Fm0 Do Q".encode()
    )
    pdf.save(path)
    pdf.close()
    return str(path)


def _interleaved_pdf(path):
    """A stroke with a colour setter interleaved between construction and
    paint — the run a naive wrap would scope away from what follows."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Resources = Dictionary()
    page.Contents = pdf.make_stream(b"\n".join([
        b"0.05 w",
        b"10 10 m 90 90 l",
        b"1 0 0 RG",
        b"S",
        b"1 w 20 20 m 80 80 l S",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def _annotated_pdf(path):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Resources = Dictionary()
    page.Contents = pdf.make_stream(b"1 w 10 10 m 90 90 l S")
    ap = pikepdf.Stream(pdf, b"0 0 1 RG 0.05 w 0 0 60 40 re S")
    ap.Type = Name.XObject
    ap.Subtype = Name.Form
    ap.BBox = Array([0, 0, 60, 40])
    ap.Resources = Dictionary()
    square = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Square, Rect=Array([100, 100, 160, 140]),
        F=4, BS=Dictionary(W=0.1, S=Name.S), AP=Dictionary(N=pdf.make_indirect(ap)),
    ))
    bordered = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Square, Rect=Array([10, 150, 60, 190]),
        F=4, Border=Array([0, 0, 0.1]),
    ))
    borderless = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Square, Rect=Array([120, 10, 190, 60]),
        F=4, Border=Array([0, 0, 0]),
    ))
    page.obj["/Annots"] = Array([square, bordered, borderless])
    pdf.save(path)
    pdf.close()
    return str(path)


def _widths(path, page=1):
    return [
        (v["line_width"], v["effective_line_width"])
        for v in list_page_vectors(path, page)["vectors"]
    ]


class TestEffectiveWidth:
    def test_the_listing_reports_the_operand_and_the_device_width(self, tmp_dir):
        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        rows = _widths(src)
        assert [r[0] for r in rows[: len(LADDER)]] == list(LADDER)
        assert [r[1] for r in rows[: len(LADDER)]] == list(LADDER)

    def test_a_scaled_stroke_reports_its_operand_and_its_real_width(self, tmp_dir):
        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        raw, effective = _widths(src)[-1]
        assert raw == 1.0
        assert effective == pytest.approx(0.1, abs=1e-6)

    def test_the_scaled_stroke_is_found_and_the_unscaled_one_is_not(self, tmp_dir):
        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        report = list_hairlines(src, threshold_pt=0.25)
        # 0, 0.05, 0.1, 0.24 and the scaled 0.1 — five; 0.25 / 0.5 / 1.0 pass.
        assert report["stroke_count"] == 5
        assert [w["effective_pt"] for w in report["widths"]] == [0.0, 0.05, 0.1, 0.24]

    def test_zero_width_is_a_hairline_whatever_the_threshold(self):
        assert is_hairline(0.0, 0.0, 0.001) is True
        assert is_hairline(1.0, 1.0, 0.001) is False
        assert is_hairline(1.0, 0.1, 0.25) is True


class TestBounds:
    def test_a_threshold_of_zero_refuses(self):
        with pytest.raises(ValueError, match="greater than zero"):
            validated_bounds(0, 0.25)

    def test_a_replacement_below_the_threshold_refuses(self):
        with pytest.raises(ValueError, match="at least the hairline threshold"):
            validated_bounds(0.5, 0.25)

    def test_equal_widths_are_allowed(self):
        assert validated_bounds(0.25, 0.25) == (0.25, 0.25)

    def test_the_listing_refuses_a_zero_threshold_too(self, tmp_dir):
        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        with pytest.raises(ValueError, match="greater than zero"):
            list_hairlines(src, threshold_pt=0)


class TestFix:
    def test_every_hairline_lands_on_the_replacement_device_width(self, tmp_dir):
        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "f.pdf")
        result = fix_hairlines(src, out, threshold_pt=0.25, replacement_pt=0.25)
        assert result["fixed_strokes"] == 5
        for _raw, effective in _widths(out):
            assert effective >= 0.25 - 1e-6

    def test_the_scaled_stroke_gets_the_operand_the_scale_demands(self, tmp_dir):
        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "f.pdf")
        fix_hairlines(src, out, threshold_pt=0.25, replacement_pt=0.25)
        raw, effective = _widths(out)[-1]
        # 0.25 pt of DEVICE width under a 0.1 scale is a 2.5 operand — the
        # over-correction an operand-space fix would produce is ten times this.
        assert raw == pytest.approx(2.5, abs=1e-4)
        assert effective == pytest.approx(0.25, abs=1e-6)

    def test_widths_at_or_above_the_threshold_are_left_alone(self, tmp_dir):
        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "f.pdf")
        fix_hairlines(src, out, threshold_pt=0.25, replacement_pt=0.25)
        rows = _widths(out)
        assert rows[5][0] == 0.5 and rows[6][0] == 1.0

    def test_report_and_apply_counts_agree(self, tmp_dir):
        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "f.pdf")
        found = list_hairlines(src, threshold_pt=0.25)["count"]
        applied = fix_hairlines(src, out, threshold_pt=0.25)["fixed"]
        assert found == applied

    def test_a_fixed_document_reports_no_hairlines(self, tmp_dir):
        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "f.pdf")
        fix_hairlines(src, out)
        assert list_hairlines(out)["count"] == 0

    def test_a_larger_replacement_is_honoured(self, tmp_dir):
        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "f.pdf")
        fix_hairlines(src, out, threshold_pt=0.25, replacement_pt=1.0)
        assert _widths(out)[0][1] == pytest.approx(1.0, abs=1e-6)

    def test_an_interleaved_run_is_fixed_and_the_next_stroke_is_untouched(self, tmp_dir):
        src = _interleaved_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "f.pdf")
        assert fix_hairlines(src, out)["fixed_strokes"] == 1
        rows = _widths(out)
        assert rows[0][1] == pytest.approx(0.25, abs=1e-6)
        # The colour the producer set mid-run still reaches the stroke after
        # it: the wrap's Q is followed by a replay of the interleaved ops.
        with pikepdf.open(out) as pdf:
            assert pdf.pages[0].obj["/Contents"].read_bytes().count(b"RG") == 2
        assert list_page_vectors(out, 1)["vectors"][1]["stroke"] == [1.0, 0.0, 0.0]


class TestNesting:
    def test_a_stroke_inside_a_form_is_found_and_fixed(self, tmp_dir):
        src = _nested_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "f.pdf")
        assert list_hairlines(src)["stroke_count"] == 1
        assert fix_hairlines(src, out)["fixed_strokes"] == 1
        assert _widths(out)[0][1] == pytest.approx(0.25, abs=1e-6)
        assert list_hairlines(out)["count"] == 0

    def test_the_form_scale_is_carried_into_the_replacement_operand(self, tmp_dir):
        src = _nested_pdf(os.path.join(tmp_dir, "s.pdf"), inner_width=1.0, form_scale=0.1)
        out = os.path.join(tmp_dir, "f.pdf")
        assert list_hairlines(src)["stroke_count"] == 1
        fix_hairlines(src, out)
        raw, effective = _widths(out)[0]
        assert raw == pytest.approx(2.5, abs=1e-4)
        assert effective == pytest.approx(0.25, abs=1e-6)

    def test_a_form_drawn_elsewhere_keeps_drawing_what_it_drew(self, tmp_dir):
        """The fix copies a form rather than editing it, so a second placement
        of the same form is not silently re-styled through the shared object."""
        src = os.path.join(tmp_dir, "s.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        form = pikepdf.Stream(pdf, b"0.1 w 10 10 m 90 90 l S")
        form.Type = Name.XObject
        form.Subtype = Name.Form
        form.BBox = Array([0, 0, 100, 100])
        form.Resources = Dictionary()
        shared = pdf.make_indirect(form)
        other = pdf.add_blank_page(page_size=(300, 300))
        page.Resources = Dictionary(XObject=Dictionary(Fm0=shared))
        other.Resources = Dictionary(XObject=Dictionary(Fm0=shared))
        page.Contents = pdf.make_stream(b"q 1 0 0 1 0 0 cm /Fm0 Do Q")
        other.Contents = pdf.make_stream(b"q 1 0 0 1 0 0 cm /Fm0 Do Q")
        pdf.save(src)
        pdf.close()

        out = os.path.join(tmp_dir, "f.pdf")
        fix_hairlines(src, out, pages=[1])
        assert _widths(out, 1)[0][1] == pytest.approx(0.25, abs=1e-6)
        assert _widths(out, 2)[0][1] == pytest.approx(0.1, abs=1e-6)


class TestAnnotations:
    def test_border_widths_and_appearance_strokes_are_all_reported(self, tmp_dir):
        src = _annotated_pdf(os.path.join(tmp_dir, "s.pdf"))
        report = list_hairlines(src)
        sources = sorted(a["source"] for a in report["pages"][0]["annotations"])
        assert sources == ["appearance", "border", "bs"]
        assert report["annotation_count"] == 3

    def test_a_zero_border_width_means_no_border_and_is_left_alone(self, tmp_dir):
        src = _annotated_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "f.pdf")
        fix_hairlines(src, out)
        with pikepdf.open(out) as pdf:
            annots = pdf.pages[0].obj["/Annots"]
            assert float(annots[0]["/BS"]["/W"]) == 0.25
            assert float(annots[1]["/Border"][2]) == 0.25
            assert float(annots[2]["/Border"][2]) == 0.0

    def test_the_appearance_stroke_is_raised_on_a_copy(self, tmp_dir):
        src = _annotated_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "f.pdf")
        fix_hairlines(src, out)
        with pikepdf.open(out) as pdf:
            stream = pdf.pages[0].obj["/Annots"][0]["/AP"]["/N"].read_bytes()
        assert b"0.25 w" in stream
        assert list_hairlines(out)["annotation_count"] == 0

    def test_annotations_can_be_left_out_of_both_halves(self, tmp_dir):
        src = _annotated_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "f.pdf")
        assert list_hairlines(src, include_annotations=False)["annotation_count"] == 0
        assert fix_hairlines(src, out, include_annotations=False)["fixed_annotations"] == 0
        with pikepdf.open(out) as pdf:
            assert float(pdf.pages[0].obj["/Annots"][0]["/BS"]["/W"]) == 0.1


class TestPreflightRow:
    def test_preflight_warns_when_a_hairline_is_present(self, tmp_dir):
        from engine.preflight import preflight

        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        row = next(c for c in preflight(src)["checks"] if c["id"] == "hairlines_absent")
        assert row["status"] == "warn"
        assert row["finding_count"] == 5

    def test_preflight_passes_a_document_with_no_thin_strokes(self, tmp_dir):
        from engine.preflight import preflight

        src = os.path.join(tmp_dir, "s.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200, 200))
        page.Resources = Dictionary()
        page.Contents = pdf.make_stream(b"1 w 10 10 m 90 90 l S")
        pdf.save(src)
        pdf.close()
        row = next(c for c in preflight(src)["checks"] if c["id"] == "hairlines_absent")
        assert row["status"] == "pass"

    def test_the_check_helper_reports_the_thinnest_width(self, tmp_dir):
        src = _ladder_pdf(os.path.join(tmp_dir, "s.pdf"))
        assert hairline_check(src)["thinnest_pt"] == 0.0
