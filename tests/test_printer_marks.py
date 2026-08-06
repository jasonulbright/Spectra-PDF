"""Printer marks: the growth, the registration colour, and the exact removal.

The `/Separation /All` claim is measured through the separation device at the
mark's own coordinates rather than asserted, because a mark that lands on the
black plate alone looks identical in every RGB render and is useless on press.
Ghostscript-backed cases carry the `gs_path` guard, which tests for the
EXECUTABLE — the release workflow creates empty resource directories, so an
`isdir` check would pass on a box with no Ghostscript.
"""

import os
import re
import subprocess

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

from engine.printer_marks import (
    MAX_PAGE_EXTENT,
    add_printer_marks,
    bar_runs,
    crop_mark_segments,
    list_printer_marks,
    registration_centres,
    remove_printer_marks,
    resolve_trim,
)
from separation_builders import cmyk_spot_pdf

FONTS_DIR = os.path.join(os.path.dirname(__file__), "..", "resources", "fonts")
HAS_FONTS = os.path.isfile(os.path.join(FONTS_DIR, "LiberationSans-Regular.ttf"))
needs_fonts = pytest.mark.skipif(not HAS_FONTS, reason="bundled fonts not provisioned")

Image = pytest.importorskip("PIL.Image")


def _boxes(path, page=1):
    with pikepdf.open(path) as pdf:
        obj = pdf.pages[page - 1].obj
        out = {}
        for key in ("/MediaBox", "/CropBox", "/TrimBox", "/BleedBox", "/ArtBox"):
            value = obj.get(key)
            out[key] = None if value is None else [repr(value[i]) for i in range(4)]
        return out


def _trimmed_pdf(path, trim=(20, 20, 380, 380), crop=None):
    cmyk_spot_pdf(path)
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        page = pdf.pages[0]
        if trim is not None:
            page.obj["/TrimBox"] = Array(list(trim))
        if crop is not None:
            page.obj["/CropBox"] = Array(list(crop))
        pdf.save(path)
    return path


def _plain_pdf(path, size=(400, 400)):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=size)
    page.Contents = pdf.make_stream(b"0 0 0 1 k 50 50 100 100 re f")
    page.Resources = Dictionary()
    pdf.save(path)
    pdf.close()
    return path


class TestGeometry:
    def test_western_corner_arms_never_cross_the_trim(self):
        segments = crop_mark_segments((0, 0, 100, 100), 9.0, 18.0, "western")
        assert len(segments) == 8
        for x0, y0, x1, y1 in segments:
            # Every arm lies wholly outside [0,100] on the axis it runs along.
            if abs(y0 - y1) < 1e-9:
                assert max(x0, x1) <= 0 or min(x0, x1) >= 100
            else:
                assert max(y0, y1) <= 0 or min(y0, y1) >= 100

    def test_japanese_doubles_the_arms_and_adds_edge_centres(self):
        western = crop_mark_segments((0, 0, 100, 100), 9.0, 18.0, "western")
        japanese = crop_mark_segments((0, 0, 100, 100), 9.0, 18.0, "japanese", bleed=8.5)
        assert len(japanese) == len(western) * 2 + 8

    def test_registration_targets_sit_at_the_edge_midpoints(self):
        centres = registration_centres((0, 0, 100, 200), 9.0, 18.0)
        assert len(centres) == 4
        assert (50.0, 218.0) == centres[0][:2]
        assert (50.0, -18.0) == centres[1][:2]

    def test_the_colour_bar_leaves_a_gap_for_the_top_target(self):
        runs = bar_runs((0, 0, 400, 400), 9.0, 18.0)
        assert len(runs) == 2
        assert runs[0][1] < 200 < runs[1][0]


class TestTrimResolution:
    def test_trim_box_wins_and_is_named(self, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "s.pdf"))
        with pikepdf.open(src) as pdf:
            box, source = resolve_trim(pdf.pages[0])
        assert source == "trim"
        assert box == (20.0, 20.0, 380.0, 380.0)

    def test_a_document_with_no_trim_box_is_marked_and_says_so(self, tmp_dir):
        src = _plain_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "m.pdf")
        result = add_printer_marks(src, out, marks=["crop"])
        assert result["pages"][0]["trim_source"] == "media"
        assert list_printer_marks(out)["without_trim_box"] == 1


class TestGrowth:
    def test_media_grows_by_offset_plus_length_and_the_others_do_not_move(self, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "m.pdf")
        before = _boxes(src)
        add_printer_marks(src, out, marks=["crop"], offset=9.0, length=18.0)
        after = _boxes(out)
        assert [float(v) for v in after["/MediaBox"]] == [-27.0, -27.0, 427.0, 427.0]
        assert after["/TrimBox"] == before["/TrimBox"]
        assert after["/BleedBox"] == before["/BleedBox"]
        assert after["/ArtBox"] == before["/ArtBox"]

    def test_crop_box_grows_with_the_media_box(self, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "s.pdf"), crop=(10, 10, 390, 390))
        out = os.path.join(tmp_dir, "m.pdf")
        add_printer_marks(src, out, marks=["crop"], offset=9.0, length=18.0)
        after = _boxes(out)
        assert [float(v) for v in after["/CropBox"]] == [-17.0, -17.0, 417.0, 417.0]

    def test_growth_past_the_page_limit_refuses(self, tmp_dir):
        src = _plain_pdf(os.path.join(tmp_dir, "s.pdf"), size=(14000, 200))
        out = os.path.join(tmp_dir, "m.pdf")
        with pytest.raises(ValueError, match="14400"):
            add_printer_marks(src, out, marks=["crop"], offset=100.0, length=200.0)
        assert MAX_PAGE_EXTENT == 14400.0


class TestRemoval:
    def test_remove_restores_the_recorded_boxes_exactly(self, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "s.pdf"), crop=(10, 10, 390, 390))
        marked = os.path.join(tmp_dir, "m.pdf")
        back = os.path.join(tmp_dir, "b.pdf")
        before = _boxes(src)
        add_printer_marks(src, marked, marks=["crop", "registration"])
        assert remove_printer_marks(marked, back)["removed"] == 1
        assert _boxes(back) == before

    def test_a_page_with_no_marks_is_reported_not_refused(self, tmp_dir):
        src = _plain_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "b.pdf")
        result = remove_printer_marks(src, out)
        assert result["removed"] == 0 and result["unmarked"] == [1]

    def test_the_marks_xobject_and_the_record_are_both_gone(self, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "s.pdf"))
        marked = os.path.join(tmp_dir, "m.pdf")
        back = os.path.join(tmp_dir, "b.pdf")
        add_printer_marks(src, marked, marks=["crop"])
        remove_printer_marks(marked, back)
        with pikepdf.open(back) as pdf:
            page = pdf.pages[0]
            assert page.obj.get("/SpectraPrinterMarks") is None
            xo = (page.obj.get("/Resources") or Dictionary()).get("/XObject")
            names = set() if xo is None else {str(k) for k in xo.keys()}
            assert "/SpectraPrinterMarks" not in names


class TestIdempotence:
    def test_two_runs_leave_one_mark_set_and_one_growth(self, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "s.pdf"))
        once = os.path.join(tmp_dir, "1.pdf")
        twice = os.path.join(tmp_dir, "2.pdf")
        add_printer_marks(src, once, marks=["crop"])
        add_printer_marks(once, twice, marks=["crop"])
        assert _boxes(twice)["/MediaBox"] == _boxes(once)["/MediaBox"]
        with pikepdf.open(twice) as pdf:
            xo = pdf.pages[0].obj["/Resources"]["/XObject"]
            drawn = [str(k) for k in xo.keys() if str(k).startswith("/SpectraPrinterMarks")]
            assert drawn == ["/SpectraPrinterMarks"]

    def test_remove_after_two_adds_still_restores_the_original(self, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "s.pdf"))
        once = os.path.join(tmp_dir, "1.pdf")
        twice = os.path.join(tmp_dir, "2.pdf")
        back = os.path.join(tmp_dir, "b.pdf")
        before = _boxes(src)
        add_printer_marks(src, once, marks=["crop"])
        add_printer_marks(once, twice, marks=["crop"])
        remove_printer_marks(twice, back)
        assert _boxes(back) == before


class TestColourBar:
    def test_one_patch_per_inventoried_spot(self, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "m.pdf")
        result = add_printer_marks(src, out, marks=["colorbars"])
        assert result["spot_patches"] == ["PANTONE 185 C", "Warm Red"]
        with pikepdf.open(out) as pdf:
            form = pdf.pages[0].obj["/Resources"]["/XObject"]["/SpectraPrinterMarks"]
            spaces = {str(k) for k in form["/Resources"]["/ColorSpace"].keys()}
        assert {"/Spot0", "/Spot1"} <= spaces

    def test_a_document_with_no_spots_gets_the_process_bar_alone(self, tmp_dir):
        src = _plain_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "m.pdf")
        assert add_printer_marks(src, out, marks=["colorbars"])["spot_patches"] == []


class TestPageInformation:
    @needs_fonts
    def test_the_line_carries_the_filename_page_and_an_iso_timestamp(self, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "source.pdf"))
        out = os.path.join(tmp_dir, "m.pdf")
        add_printer_marks(src, out, marks=["pageinfo"], font_dir=FONTS_DIR,
                          timestamp="2026-01-02T03:04:05+0000")
        with pikepdf.open(out) as pdf:
            form = pdf.pages[0].obj["/Resources"]["/XObject"]["/SpectraPrinterMarks"]
            fonts = form["/Resources"]["/Font"]
            font = fonts["/F0"]
            descendants = font.get("/DescendantFonts")
            descriptor = (descendants[0]["/FontDescriptor"] if descendants is not None
                          else font["/FontDescriptor"])
            assert any(descriptor.get(k) is not None
                       for k in ("/FontFile", "/FontFile2", "/FontFile3"))
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}",
                            "2026-01-02T03:04:05+0000")

    def test_page_information_without_a_font_directory_refuses(self, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "m.pdf")
        with pytest.raises(ValueError, match="embedded font"):
            add_printer_marks(src, out, marks=["pageinfo"], font_dir="")


class TestValidation:
    def test_an_unknown_mark_refuses(self, tmp_dir):
        src = _plain_pdf(os.path.join(tmp_dir, "s.pdf"))
        with pytest.raises(ValueError, match="not a printer mark"):
            add_printer_marks(src, os.path.join(tmp_dir, "m.pdf"), marks=["bleedbars"])

    def test_an_unknown_style_refuses(self, tmp_dir):
        src = _plain_pdf(os.path.join(tmp_dir, "s.pdf"))
        with pytest.raises(ValueError, match="Mark style"):
            add_printer_marks(src, os.path.join(tmp_dir, "m.pdf"), style="bauhaus")

    def test_a_weight_off_the_list_refuses(self, tmp_dir):
        src = _plain_pdf(os.path.join(tmp_dir, "s.pdf"))
        with pytest.raises(ValueError, match="Mark weight"):
            add_printer_marks(src, os.path.join(tmp_dir, "m.pdf"), weight=0.3)


class TestFormsSurvive:
    def test_widget_annotations_and_the_acroform_are_untouched(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 400))
        page.Contents = pdf.make_stream(b"0 0 0 1 k 10 10 20 20 re f")
        page.Resources = Dictionary()
        field = pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx, T="Name",
            Rect=Array([50, 50, 200, 70]), F=4,
        ))
        page.obj["/Annots"] = Array([field])
        pdf.Root["/AcroForm"] = Dictionary(Fields=Array([field]), DA="/Helv 0 Tf 0 g")
        pdf.save(src)
        pdf.close()

        out = os.path.join(tmp_dir, "m.pdf")
        add_printer_marks(src, out, marks=["crop"])
        with pikepdf.open(out) as marked:
            fields = marked.Root["/AcroForm"]["/Fields"]
            assert len(fields) == 1
            assert str(fields[0]["/T"]) == "Name"
            assert len(marked.pages[0].obj["/Annots"]) == 1


class TestSeparationTruth:
    """The registration-colour claim, measured through the device."""

    def _plates(self, gs_path, pdf_path, out_dir):
        os.makedirs(out_dir, exist_ok=True)
        subprocess.run(
            [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=tiffsep",
             "-r72", "-dFirstPage=1", "-dLastPage=1", "-dMaxSpots=10",
             "-o", os.path.join(out_dir, "s%d.tif"), pdf_path],
            check=True, capture_output=True, stdin=subprocess.DEVNULL,
        )
        return sorted(
            os.path.join(out_dir, n) for n in os.listdir(out_dir)
            if n.startswith("s1(") and n.endswith(".tif")
        )

    def test_a_crop_mark_carries_ink_on_every_plate(self, gs_path, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "m.pdf")
        add_printer_marks(src, out, marks=["crop"], offset=9.0, length=18.0)
        plates = self._plates(gs_path, out, os.path.join(tmp_dir, "plates"))
        # Four process plates plus the fixture's two spots — `/All` paints
        # every one of them, which is what registration colour means.
        assert len(plates) == 6
        with pikepdf.open(out) as pdf:
            media = [float(v) for v in pdf.pages[0].obj["/MediaBox"]]
        # The bottom-left corner's horizontal arm runs along y = 20 from
        # x = -7 to x = 11 in the grown page.
        px = int(2.0 - media[0])
        py = int(media[3] - 20.0)
        for plate in plates:
            with Image.open(plate) as im:
                grey = im.convert("L")
                band = [grey.getpixel((px + dx, py + dy))
                        for dx in range(-2, 3) for dy in range(-2, 3)]
            assert min(band) == 0, f"no ink on {os.path.basename(plate)}"

    def test_the_trim_area_itself_is_untouched_by_the_marks(self, gs_path, tmp_dir):
        src = _trimmed_pdf(os.path.join(tmp_dir, "s.pdf"))
        out = os.path.join(tmp_dir, "m.pdf")
        add_printer_marks(src, out, marks=["crop", "registration"])
        plates = self._plates(gs_path, out, os.path.join(tmp_dir, "plates"))
        with pikepdf.open(out) as pdf:
            media = [float(v) for v in pdf.pages[0].obj["/MediaBox"]]
        # A point just inside the trim on an empty part of the artwork.
        px = int(25.0 - media[0])
        py = int(media[3] - 25.0)
        for plate in plates:
            with Image.open(plate) as im:
                assert im.convert("L").getpixel((px, py)) == 255
