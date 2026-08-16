"""The point inspector: which object, which colour space, how much ink.

Every wrong answer this feature can give is plausible, so nothing here is
eyeballed: the fixture places five objects at known coordinates in five
colour spaces and each point is asserted against that geometry. The row that
pins the mechanism is the one inside the diagonal stroke's bounding box and
far from the line — a box-only hit test passes every other row of the table
and names the stroke there, where the page paints nothing.

Ghostscript-backed cases carry the `gs_path` skip guard, which tests for the
EXECUTABLE rather than its directory. The colour-space table needs no device
at all and is asserted against the walk directly.
"""

import pytest

import pikepdf

from engine.image_resolution import summarize_image_resolution
from engine.object_inspector import (
    _isolation_pdf,
    _tile,
    _view_box,
    _Walk,
    inspect_point,
    plate_pixel,
)
from engine.separations import composite_separations, ink_statistics, render_separations
from separation_builders import (
    CROPPED_BOX,
    CROPPED_INSIDE,
    CROPPED_MEDIA,
    CROPPED_OUTSIDE,
    cropped_page_pdf,
)
from inspector_builders import (
    IMAGE_PIXELS,
    SPOT_NAME,
    form_stack_pdf,
    inspector_page_pdf,
    unreadable_content_pdf,
)

#: Where the fixture's objects are, and what the readout must say there. The
#: `kind`/`family`/`components` triple is the whole colour readout for a
#: vector or a text run; an image reports its space and its bit depth and no
#: components, because its components live in its samples.
POINTS = {
    "cmyk": (60.0, 320.0),
    "overlap": (100.0, 320.0),
    "spot": (250.0, 325.0),
    "image": (100.0, 100.0),
    "off_the_line": (210.0, 190.0),
    "stroke": (275.0, 125.0),
    "paper": (30.0, 30.0),
}

#: Ink on the sheet at each point, per plate, in percent. Measured off the
#: plates the bundled device writes; the two figures the overlap carries are
#: the whole reason the ink row and the colour row are separate readouts.
INK = {
    "cmyk": {"Cyan": 20.0, "Magenta": 40.0, "Yellow": 90.2, "Black": 0.0,
             SPOT_NAME: 0.0},
    "overlap": {"Cyan": 0.0, "Magenta": 100.0, "Yellow": 100.0, "Black": 0.0,
                SPOT_NAME: 0.0},
    "spot": {"Cyan": 0.0, "Magenta": 0.0, "Yellow": 0.0, "Black": 0.0,
             SPOT_NAME: 100.0},
    "paper": {"Cyan": 0.0, "Magenta": 0.0, "Yellow": 0.0, "Black": 0.0,
              SPOT_NAME: 0.0},
}

INK_TOTAL = {"cmyk": 150.2, "overlap": 200.0, "spot": 100.0, "paper": 0.0}

#: The fixture's image is 8 samples over 100 pt, so its effective resolution
#: is 8 * 72 / 100 = 5.76 on both axes. The measurement rounds to whole
#: numbers, and the cross-check below is what keeps the inspector and the
#: document-wide summary from rounding it two different ways.
IMAGE_DPI_EXACT = IMAGE_PIXELS * 72.0 / 100.0


@pytest.fixture
def oracle(tmp_path, gs_path):
    """The fixture, its plate set, and a reader for one point."""
    src = inspector_page_pdf(tmp_path / "oracle.pdf")
    plates = render_separations(src, page=1, dpi=150, gs_path=gs_path, reuse=False)

    def read(name_or_point, source=src, plate_set=plates):
        x, y = POINTS[name_or_point] if isinstance(name_or_point, str) else name_or_point
        return inspect_point(
            source, page=1, x=x, y=y, plates=plate_set["plates"],
            plates_dir=plate_set["dir"], gs_path=gs_path,
        )

    return src, plates, read


def _ink(result):
    return {entry["name"]: entry["pct"] for entry in result["ink"]["plates"]}


@pytest.mark.usefixtures("gs_path")
class TestWhichObject:
    def test_a_process_fill_reports_its_own_device_space(self, oracle):
        _src, _plates, read = oracle
        top = read("cmyk")["objects"][0]
        assert top["kind"] == "fill"
        assert top["colour"]["family"] == "DeviceCMYK"
        assert top["colour"]["components"] == pytest.approx([0.2, 0.4, 0.9, 0.0])
        assert top["resolution"] is None

    def test_the_stack_is_topmost_first_and_keeps_what_is_under_it(self, oracle):
        _src, _plates, read = oracle
        objects = read("overlap")["objects"]
        # "What is on top" and "what is under it" are different questions and
        # a prepress operator asks both, so neither is dropped.
        assert [o["colour"]["family"] for o in objects] == ["DeviceRGB", "DeviceCMYK"]
        assert objects[0]["colour"]["components"] == pytest.approx([1.0, 0.0, 0.0])
        assert objects[0]["index"] > objects[1]["index"]

    def test_a_spot_reports_its_colorant_its_tint_and_its_alternate(self, oracle):
        _src, _plates, read = oracle
        top = read("spot")["objects"][0]
        assert top["colour"]["family"] == "Separation"
        # The colorant name is document content and is never translated.
        assert top["colour"]["colorants"] == [SPOT_NAME]
        assert top["colour"]["alternate"] == "DeviceCMYK"
        assert top["colour"]["components"] == pytest.approx([1.0])
        assert top["colour"]["resource"] == "Cs1"

    def test_an_image_reports_its_space_its_depth_and_its_resolution(self, oracle):
        _src, _plates, read = oracle
        top = read("image")["objects"][0]
        assert top["kind"] == "image"
        assert top["colour"]["family"] == "DeviceRGB"
        # An image's components live in its samples; naming one pixel's worth
        # as "the object's colour" would answer about a pixel nobody picked.
        assert top["colour"]["components"] == []
        assert top["resolution"]["bpc"] == 8
        assert top["resolution"]["width"] == IMAGE_PIXELS
        assert top["resolution"]["height"] == IMAGE_PIXELS
        assert top["resolution"]["dpi"] == round(IMAGE_DPI_EXACT)
        assert top["resolution"]["dpi_x"] == top["resolution"]["dpi_y"]

    def test_a_stroke_reports_the_stroke_colour(self, oracle):
        _src, _plates, read = oracle
        top = read("stroke")["objects"][0]
        assert top["kind"] == "stroke"
        assert top["colour"]["family"] == "DeviceGray"
        assert top["colour"]["components"] == pytest.approx([0.0])

    def test_a_point_inside_a_box_and_off_the_mark_reports_nothing(self, oracle):
        """The regression that pins the mechanism.

        The point is inside the diagonal stroke's bounding box and a hundred
        points from the line. A box index says the stroke is there; the page
        paints nothing. `candidates` is what a box-only implementation would
        have reported, and it is deliberately in the payload so this test can
        prove the box said yes and the raster said no.
        """
        _src, _plates, read = oracle
        result = read("off_the_line")
        assert result["candidates"] == 1
        assert result["objects"] == []

    def test_blank_paper_is_an_answer(self, oracle):
        _src, _plates, read = oracle
        result = read("paper")
        assert result["candidates"] == 0
        assert result["objects"] == []
        # No candidate means no device run at all, and the ink row is still
        # exact — an empty panel would be the wrong shape of answer.
        assert result["ink"]["total"] == pytest.approx(0.0, abs=0.05)


@pytest.mark.usefixtures("gs_path")
class TestHowMuchInk:
    @pytest.mark.parametrize("point", sorted(INK))
    def test_the_ink_row_is_the_plates_at_that_pixel(self, oracle, point):
        _src, _plates, read = oracle
        assert _ink(read(point)) == pytest.approx(INK[point], abs=0.5)

    @pytest.mark.parametrize("point", sorted(INK_TOTAL))
    def test_the_total_is_the_sum_of_every_plate(self, oracle, point):
        _src, _plates, read = oracle
        assert read(point)["ink"]["total"] == pytest.approx(INK_TOTAL[point], abs=0.5)

    def test_the_ink_and_the_object_disagree_where_the_object_is_not_cmyk(self, oracle):
        """Two labelled rows, never one blended number.

        The topmost object is authored in DeviceRGB and the sheet at that
        pixel carries magenta and yellow. These are not two roundings of one
        number — they are different units, and a readout that printed one of
        them as "the colour here" would state something the press does not do.
        """
        _src, _plates, read = oracle
        result = read("overlap")
        assert result["objects"][0]["colour"]["family"] == "DeviceRGB"
        assert _ink(result)["Cyan"] == pytest.approx(0.0, abs=0.5)
        assert _ink(result)["Magenta"] == pytest.approx(100.0, abs=0.5)

    def test_the_ink_and_the_object_agree_where_the_object_is_cmyk(self, oracle):
        _src, _plates, read = oracle
        result = read("cmyk")
        authored = result["objects"][0]["colour"]["components"]
        measured = _ink(result)
        for value, name in zip(authored, ("Cyan", "Magenta", "Yellow", "Black")):
            # The residue is the plate's 8-bit quantisation and nothing else.
            assert measured[name] == pytest.approx(value * 100.0, abs=0.5)

    def test_the_heaviest_pixel_agrees_with_the_alarm(self, oracle):
        """One quantity, two readouts.

        The alarm names a total and the inspector finds where it is; a drift
        between them would make them two claims about one sheet.
        """
        _src, plates, read = oracle
        stats = ink_statistics([p["file"] for p in plates["plates"]])
        assert read("overlap")["ink"]["total"] == pytest.approx(stats["max_tac"], abs=0.5)

    def test_hiding_a_plate_and_proofing_leave_the_ink_row_alone(self, oracle, gs_path):
        """A hidden plate is still an ink on the sheet.

        Both the visible subset and the press profile are choices made when
        the plates are COMPOSITED; the sheet is the plate set. Reading the
        subset would report a page that prints without cyan.
        """
        _src, plates, read = oracle
        before = _ink(read("overlap"))
        composite_separations(
            plates["dir"],
            inks=[
                {"name": p["name"], "display_rgb": p["display_rgb"],
                 "density": 1.0, "shown_as": p["name"]}
                for p in plates["plates"] if p["name"] != "Cyan"
            ],
            simulation={"source": "bundled"},
            gs_path=gs_path,
        )
        assert _ink(read("overlap")) == pytest.approx(before, abs=0.001)


@pytest.mark.usefixtures("gs_path")
class TestTheFrame:
    """A crop and a quarter turn move the projection, never user space.

    The caller hands over a user-space point, so every answer below must be
    the plain page's answer. A frame that leaked into the point would move
    the object, the plate pixel and the ink together.
    """

    @pytest.mark.parametrize("point", sorted(INK))
    def test_a_cropped_page_answers_what_the_plain_page_answers(
        self, tmp_path, gs_path, point
    ):
        src = inspector_page_pdf(tmp_path / "crop.pdf", crop=(20.0, 20.0, 380.0, 380.0))
        plates = render_separations(src, page=1, dpi=150, gs_path=gs_path, reuse=False)
        x, y = POINTS[point]
        result = inspect_point(src, page=1, x=x, y=y, plates=plates["plates"],
                               plates_dir=plates["dir"], gs_path=gs_path)
        assert (result["ink"]["width"], result["ink"]["height"]) == (750, 750)
        assert _ink(result) == pytest.approx(INK[point], abs=0.5)

    @pytest.mark.parametrize("rotate", [90, 180, 270])
    def test_a_turned_page_answers_what_the_upright_page_answers(
        self, tmp_path, gs_path, rotate
    ):
        src = inspector_page_pdf(tmp_path / f"rot{rotate}.pdf", rotate=rotate)
        plates = render_separations(src, page=1, dpi=150, gs_path=gs_path, reuse=False)
        for point in sorted(INK):
            x, y = POINTS[point]
            result = inspect_point(src, page=1, x=x, y=y, plates=plates["plates"],
                                   plates_dir=plates["dir"], gs_path=gs_path)
            assert _ink(result) == pytest.approx(INK[point], abs=0.5), point

    def test_a_turned_page_still_names_the_object_the_point_is_on(
        self, tmp_path, gs_path
    ):
        src = inspector_page_pdf(tmp_path / "rot90.pdf", rotate=90)
        plates = render_separations(src, page=1, dpi=150, gs_path=gs_path, reuse=False)
        x, y = POINTS["spot"]
        result = inspect_point(src, page=1, x=x, y=y, plates=plates["plates"],
                               plates_dir=plates["dir"], gs_path=gs_path)
        assert result["objects"][0]["colour"]["colorants"] == [SPOT_NAME]


#: The middle of the bar that sits inside the cropped fixture's window.
CROP_INSIDE_POINT = (CROPPED_INSIDE[0] + CROPPED_INSIDE[2] / 2,
                     CROPPED_INSIDE[1] + CROPPED_INSIDE[3] / 2)
#: Inside the window and off every bar.
CROP_BLANK_POINT = (CROPPED_BOX[0] + 20.0, CROPPED_BOX[1] + 20.0)
#: The middle of the bar the window hides.
CROP_HIDDEN_POINT = (CROPPED_OUTSIDE[0] + CROPPED_OUTSIDE[2] / 2,
                     CROPPED_OUTSIDE[1] + CROPPED_OUTSIDE[3] / 2)


@pytest.mark.usefixtures("gs_path")
class TestTheIsolationFrame:
    """The hit test's raster and the plate read describe the SAME region.

    The plates frame the page's displayed box. If the isolation raster framed
    the media box instead, the alpha that decides "does this object paint
    here" would be sampled at a different point from the ink, and the two
    halves of one readout would answer about two regions of one page — a
    disagreement that shows up on no page whose boxes are equal, which is
    almost every fixture.

    The isolation page carries neither box of the original: both are set to
    the click tile, and the tile is clamped into the displayed box, so the
    frame is the same one either way and content the crop hides cannot paint
    into the window. The `/Rotate` goes with them, so the raster maps user
    space with one scale and one flip.
    """

    def test_the_isolation_page_carries_the_tile_as_both_boxes(self, tmp_path):
        src = cropped_page_pdf(tmp_path / "crop.pdf")
        with pikepdf.open(src) as pdf:
            page = pdf.pages[0]
            box = _view_box(page)
            tile = _tile(CROP_INSIDE_POINT[0], CROP_INSIDE_POINT[1], box)
            walk = _Walk(pdf, page)
            walk.run()
            units = []
            for entry in walk.objects:
                if entry["unit"] not in units:
                    units.append(entry["unit"])
            _isolation_pdf(pdf, page, units, units[:1], tile, tmp_path / "iso.pdf")
        assert box == list(CROPPED_BOX)
        with pikepdf.open(tmp_path / "iso.pdf") as iso:
            page = iso.pages[0]
            media = [float(v) for v in page.obj["/MediaBox"]]
            crop = [float(v) for v in page.obj["/CropBox"]]
        # Equal boxes make the device's box choice a no-op, which is what
        # keeps this raster out of the frame argument entirely.
        assert media == crop == [float(v) for v in tile]
        assert "/Rotate" not in page.obj
        # And the tile is inside the displayed box, so nothing the crop hides
        # can paint into the window and be reported as visible.
        assert tile[0] >= box[0] and tile[1] >= box[1]
        assert tile[2] <= box[2] and tile[3] <= box[3]

    def _read(self, src, point, gs_path):
        plates = render_separations(src, page=1, dpi=72, gs_path=gs_path, reuse=False)
        result = inspect_point(src, page=1, x=point[0], y=point[1],
                               plates=plates["plates"], plates_dir=plates["dir"],
                               gs_path=gs_path)
        return plates, result

    def test_a_cropped_page_names_the_object_the_viewer_would_click(
        self, tmp_path, gs_path
    ):
        src = cropped_page_pdf(tmp_path / "crop.pdf")
        plates, result = self._read(src, CROP_INSIDE_POINT, gs_path)
        assert (plates["width"], plates["height"]) == (300, 200)
        assert [o["kind"] for o in result["objects"]] == ["fill"]
        assert result["objects"][0]["colour"]["family"] == "DeviceCMYK"
        assert result["objects"][0]["colour"]["components"] == pytest.approx(
            [1.0, 0.0, 0.0, 0.0])
        # The bar's own ink, read at the pixel the click maps to. A media-box
        # mapping lands 33 rows higher on this page, where the plate is blank.
        assert _ink(result)["Cyan"] == pytest.approx(100.0, abs=0.5)
        assert result["ink"]["pixel"] == [100, 75]

    def test_the_uncropped_control_answers_the_same(self, tmp_path, gs_path):
        src = cropped_page_pdf(tmp_path / "crop.pdf")
        control = tmp_path / "nocrop.pdf"
        with pikepdf.open(src) as pdf:
            del pdf.pages[0].obj["/CropBox"]
            pdf.save(control)
        plates, result = self._read(str(control), CROP_INSIDE_POINT, gs_path)
        assert (plates["width"], plates["height"]) == (
            int(CROPPED_MEDIA[0]), int(CROPPED_MEDIA[1]))
        # Same user-space point, same object, same ink — a crop moves the
        # projection and never the content.
        assert result["objects"][0]["colour"]["components"] == pytest.approx(
            [1.0, 0.0, 0.0, 0.0])
        assert _ink(result)["Cyan"] == pytest.approx(100.0, abs=0.5)

    @pytest.mark.parametrize("rotate", [0, 90, 180, 270])
    def test_a_turned_cropped_page_answers_the_same(self, tmp_path, gs_path, rotate):
        src = cropped_page_pdf(tmp_path / f"crop{rotate}.pdf", rotate=rotate)
        _plates, result = self._read(src, CROP_INSIDE_POINT, gs_path)
        assert [o["kind"] for o in result["objects"]] == ["fill"]
        assert _ink(result)["Cyan"] == pytest.approx(100.0, abs=0.5)

    def test_blank_medium_inside_the_window_is_blank(self, tmp_path, gs_path):
        src = cropped_page_pdf(tmp_path / "crop.pdf")
        _plates, result = self._read(src, CROP_BLANK_POINT, gs_path)
        assert result["candidates"] == 0
        assert result["objects"] == []
        assert result["ink"]["total"] == pytest.approx(0.0, abs=0.05)

    def test_a_point_the_crop_hides_is_off_the_page(self, tmp_path, gs_path):
        src = cropped_page_pdf(tmp_path / "crop.pdf")
        plates = render_separations(src, page=1, dpi=72, gs_path=gs_path, reuse=False)
        with pytest.raises(ValueError, match="not on this page"):
            inspect_point(src, page=1, x=CROP_HIDDEN_POINT[0], y=CROP_HIDDEN_POINT[1],
                          plates=plates["plates"], plates_dir=plates["dir"],
                          gs_path=gs_path)

    def test_the_same_point_on_an_uncropped_page_is_on_it(self, tmp_path, gs_path):
        src = cropped_page_pdf(tmp_path / "crop.pdf")
        control = tmp_path / "nocrop.pdf"
        with pikepdf.open(src) as pdf:
            del pdf.pages[0].obj["/CropBox"]
            pdf.save(control)
        _plates, result = self._read(str(control), CROP_HIDDEN_POINT, gs_path)
        # Without the window the second bar is on the page and is named. That
        # is what makes the refusal above a frame statement rather than a
        # coincidence of geometry.
        assert result["objects"][0]["colour"]["components"] == pytest.approx(
            [0.0, 1.0, 0.0, 0.0])

    def test_a_media_framed_mapping_would_sample_a_different_pixel(self):
        """The assertion above is load-bearing, stated as arithmetic.

        Reading the same user-space point against the media box instead of
        the displayed box lands somewhere else on the plate, so an inspector
        that framed the media box could not pass the cropped cases.
        """
        view = list(CROPPED_BOX)
        media = [0.0, 0.0, CROPPED_MEDIA[0], CROPPED_MEDIA[1]]
        width = int(CROPPED_BOX[2] - CROPPED_BOX[0])
        height = int(CROPPED_BOX[3] - CROPPED_BOX[1])
        framed = plate_pixel(*CROP_INSIDE_POINT, view, 0, width, height)
        wrong = plate_pixel(*CROP_INSIDE_POINT, media, 0, width, height)
        assert framed == (100, 75)
        assert wrong == (98, 42)
        assert framed != wrong


class TestThePlatePixel:
    """The mapping from user space to a plate pixel, in isolation.

    The scale comes from the plate's measured extent rather than from the
    resolution the device was asked for: 400 pt at 150 dpi is 833.33 pixels
    and the device writes 833, so a point on the far edge would index past
    the end of a plate sized from the arithmetic.
    """

    BOX = (0.0, 0.0, 400.0, 400.0)

    def test_the_upright_mapping_flips_only_the_vertical(self):
        assert plate_pixel(0.0, 400.0, self.BOX, 0, 833, 833) == (0, 0)
        assert plate_pixel(400.0, 0.0, self.BOX, 0, 833, 833) == (832, 832)

    def test_a_quarter_turn_sends_the_vertical_axis_across(self):
        assert plate_pixel(0.0, 0.0, self.BOX, 90, 833, 833) == (0, 0)
        assert plate_pixel(0.0, 400.0, self.BOX, 90, 833, 833) == (832, 0)

    def test_the_far_edge_clamps_rather_than_indexing_past_the_end(self):
        assert plate_pixel(400.0, 400.0, self.BOX, 0, 833, 833) == (832, 0)
        assert plate_pixel(400.0, 400.0, self.BOX, 180, 833, 833) == (0, 832)
        assert plate_pixel(400.0, 400.0, self.BOX, 270, 833, 833) == (0, 0)


@pytest.mark.usefixtures("gs_path")
class TestTheResolutionHasOneImplementation:
    def test_the_point_and_the_document_summary_report_one_number(self, oracle):
        """Both come from one measurement; this is what keeps them from
        becoming two."""
        src, _plates, read = oracle
        summary = summarize_image_resolution(src)["placements"]
        top = read("image")["objects"][0]
        match = next(p for p in summary if p["page"] == 1
                     and p["index"] == top["image_index"])
        assert (top["resolution"]["dpi"], top["resolution"]["dpi_x"],
                top["resolution"]["dpi_y"]) == (
            match["dpi"], match["dpi_x"], match["dpi_y"])


@pytest.mark.usefixtures("gs_path")
class TestAFormIsolatesWhole:
    def test_two_objects_under_one_point_inside_a_form_say_so(self, tmp_path, gs_path):
        src = form_stack_pdf(tmp_path / "forms.pdf")
        plates = render_separations(src, page=1, dpi=72, gs_path=gs_path, reuse=False)
        result = inspect_point(src, page=1, x=200.0, y=200.0, plates=plates["plates"],
                               plates_dir=plates["dir"], gs_path=gs_path)
        kinds = [o["kind"] for o in result["objects"]]
        assert kinds.count("fill") == 2
        # The form is named as the isolated unit rather than competing inside
        # it, and the ambiguity is stated rather than resolved by a guess.
        assert "form" in kinds
        assert result["ambiguous"] is True
        assert all(o["form"] == "/Fm1" for o in result["objects"] if o["nested"])

    def test_one_object_under_the_point_inside_a_form_is_unambiguous(
        self, tmp_path, gs_path
    ):
        src = form_stack_pdf(tmp_path / "forms.pdf")
        plates = render_separations(src, page=1, dpi=72, gs_path=gs_path, reuse=False)
        result = inspect_point(src, page=1, x=120.0, y=120.0, plates=plates["plates"],
                               plates_dir=plates["dir"], gs_path=gs_path)
        assert [o["kind"] for o in result["objects"]].count("fill") == 1
        assert result["ambiguous"] is False


@pytest.mark.usefixtures("gs_path")
class TestTheRefusals:
    def test_a_point_off_the_page_refuses_by_name(self, oracle):
        _src, _plates, read = oracle
        with pytest.raises(ValueError, match="not on this page"):
            read((500.0, 500.0))

    def test_a_point_outside_the_crop_is_off_the_page(self, tmp_path, gs_path):
        src = inspector_page_pdf(tmp_path / "crop.pdf", crop=(100.0, 100.0, 300.0, 300.0))
        plates = render_separations(src, page=1, dpi=150, gs_path=gs_path, reuse=False)
        with pytest.raises(ValueError, match="not on this page"):
            inspect_point(src, page=1, x=60.0, y=320.0, plates=plates["plates"],
                          plates_dir=plates["dir"], gs_path=gs_path)

    def test_a_retired_plate_set_refuses_with_the_wording_it_already_has(
        self, tmp_path, gs_path
    ):
        src = inspector_page_pdf(tmp_path / "oracle.pdf")
        with pytest.raises(ValueError, match="no longer available"):
            inspect_point(src, page=1, x=60.0, y=320.0, plates=[],
                          plates_dir=str(tmp_path / "gone"), gs_path=gs_path)

    def test_a_page_whose_content_will_not_read_refuses_by_name(
        self, tmp_path, gs_path
    ):
        src = inspector_page_pdf(tmp_path / "oracle.pdf")
        plates = render_separations(src, page=1, dpi=150, gs_path=gs_path, reuse=False)
        broken = unreadable_content_pdf(tmp_path / "broken.pdf")
        with pytest.raises(ValueError, match="will not read"):
            inspect_point(broken, page=1, x=60.0, y=320.0,
                          plates=plates["plates"], plates_dir=plates["dir"],
                          gs_path=gs_path)

    def test_a_raster_that_writes_nothing_refuses_by_name(
        self, oracle, monkeypatch
    ):
        from engine import object_inspector

        class _Failed:
            returncode = 1
            stdout = ""
            stderr = "the device refused"

        _src, _plates, read = oracle
        monkeypatch.setattr(object_inspector.budget, "gs", lambda *a, **k: _Failed())
        with pytest.raises(RuntimeError, match="could not be isolated for measurement"):
            read("cmyk")

    def test_an_object_that_cannot_be_re_emitted_refuses_by_name(
        self, oracle, monkeypatch
    ):
        from engine import object_inspector

        def _boom(_kept):
            raise RuntimeError("unrepresentable")

        _src, _plates, read = oracle
        monkeypatch.setattr(
            object_inspector.pikepdf, "unparse_content_stream", _boom
        )
        with pytest.raises(ValueError, match="cannot be isolated on its own"):
            read("cmyk")

    def test_a_page_out_of_range_refuses_by_name(self, oracle):
        src, plates, _read = oracle
        with pytest.raises(ValueError, match="not in this document"):
            inspect_point(src, page=7, x=60.0, y=320.0, plates=plates["plates"],
                          plates_dir=plates["dir"])


class TestTheColourSpaceRow:
    """What each colour space reports, read off the walk alone.

    A device is not involved: the question is what the DOCUMENT declares, and
    resolving it through a renderer is exactly what this row exists not to do.
    """

    def _walk(self, tmp_path, content: bytes, resources: dict):
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200.0, 200.0))
        page.Resources = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(**resources))
        page.Contents = pdf.make_stream(content)
        walk = _Walk(pdf, page)
        walk.run()
        return walk.objects

    def test_a_device_space_reports_its_operands_verbatim(self, tmp_path):
        objects = self._walk(tmp_path, b"0.1 0.2 0.3 0.4 k 0 0 10 10 re f", {})
        assert objects[0]["colour"]["family"] == "DeviceCMYK"
        assert objects[0]["colour"]["components"] == pytest.approx([0.1, 0.2, 0.3, 0.4])

    def test_the_stream_default_is_device_gray_black(self, tmp_path):
        objects = self._walk(tmp_path, b"0 0 10 10 re f", {})
        assert objects[0]["colour"]["family"] == "DeviceGray"
        assert objects[0]["colour"]["components"] == pytest.approx([0.0])

    def test_an_icc_space_reports_its_component_count(self, tmp_path):
        pdf = pikepdf.new()
        profile = pikepdf.Stream(pdf, b"not a profile")
        profile.N = 3
        profile.Alternate = pikepdf.Name.DeviceRGB
        space = pikepdf.Array([pikepdf.Name.ICCBased, profile])
        page = pdf.add_blank_page(page_size=(200.0, 200.0))
        page.Resources = pikepdf.Dictionary(
            ColorSpace=pikepdf.Dictionary(Cs1=space)
        )
        page.Contents = pdf.make_stream(b"/Cs1 cs 0.2 0.4 0.6 scn 0 0 10 10 re f")
        walk = _Walk(pdf, page)
        walk.run()
        colour = walk.objects[0]["colour"]
        assert colour["family"] == "ICCBased"
        assert colour["n"] == 3
        assert colour["alternate"] == "DeviceRGB"
        assert colour["resource"] == "Cs1"
        assert colour["components"] == pytest.approx([0.2, 0.4, 0.6])

    def test_an_indexed_space_reports_its_base_and_the_index(self, tmp_path):
        pdf = pikepdf.new()
        lookup = pikepdf.Stream(pdf, bytes([255, 0, 0, 0, 255, 0, 0, 0, 255]))
        space = pikepdf.Array(
            [pikepdf.Name.Indexed, pikepdf.Name.DeviceRGB, 2, lookup]
        )
        page = pdf.add_blank_page(page_size=(200.0, 200.0))
        page.Resources = pikepdf.Dictionary(
            ColorSpace=pikepdf.Dictionary(Cs1=space)
        )
        page.Contents = pdf.make_stream(b"/Cs1 cs 1 scn 0 0 10 10 re f")
        walk = _Walk(pdf, page)
        walk.run()
        colour = walk.objects[0]["colour"]
        assert colour["family"] == "Indexed"
        assert colour["base"] == "DeviceRGB"
        assert colour["hival"] == 2
        # The index IS the component: it names a row of the lookup table, not
        # an amount of anything.
        assert colour["components"] == pytest.approx([1.0])

    def test_a_lab_space_reports_its_family_and_its_components(self, tmp_path):
        pdf = pikepdf.new()
        space = pikepdf.Array([
            pikepdf.Name.Lab,
            pikepdf.Dictionary(WhitePoint=[0.9642, 1.0, 0.8249],
                               Range=[-100, 100, -100, 100]),
        ])
        page = pdf.add_blank_page(page_size=(200.0, 200.0))
        page.Resources = pikepdf.Dictionary(
            ColorSpace=pikepdf.Dictionary(Cs1=space)
        )
        page.Contents = pdf.make_stream(b"/Cs1 cs 50 20 -30 scn 0 0 10 10 re f")
        walk = _Walk(pdf, page)
        walk.run()
        colour = walk.objects[0]["colour"]
        assert colour["family"] == "Lab"
        assert colour["components"] == pytest.approx([50.0, 20.0, -30.0])

    def test_a_devicen_space_reports_every_colorant_and_its_tints(self, tmp_path):
        pdf = pikepdf.new()
        tint = pikepdf.Stream(pdf, b"{ 0 0 3 -1 roll 0 }")
        tint.FunctionType = 4
        tint.Domain = [0.0, 1.0, 0.0, 1.0]
        tint.Range = [0.0, 1.0] * 4
        space = pikepdf.Array([
            pikepdf.Name.DeviceN,
            pikepdf.Array([pikepdf.Name("/Ink A"), pikepdf.Name("/Ink B")]),
            pikepdf.Name.DeviceCMYK,
            tint,
        ])
        page = pdf.add_blank_page(page_size=(200.0, 200.0))
        page.Resources = pikepdf.Dictionary(
            ColorSpace=pikepdf.Dictionary(Cs1=space)
        )
        page.Contents = pdf.make_stream(b"/Cs1 cs 0.25 0.75 scn 0 0 10 10 re f")
        walk = _Walk(pdf, page)
        walk.run()
        colour = walk.objects[0]["colour"]
        assert colour["family"] == "DeviceN"
        assert colour["colorants"] == ["Ink A", "Ink B"]
        assert colour["alternate"] == "DeviceCMYK"
        assert colour["components"] == pytest.approx([0.25, 0.75])

    def test_a_pattern_reports_a_pattern_and_no_colour(self, tmp_path):
        pdf = pikepdf.new()
        pattern = pikepdf.Stream(pdf, b"0 0 1 rg 0 0 5 5 re f")
        pattern.Type = pikepdf.Name.Pattern
        pattern.PatternType = 1
        pattern.PaintType = 1
        pattern.TilingType = 1
        pattern.BBox = pikepdf.Array([0, 0, 5, 5])
        pattern.XStep = 5
        pattern.YStep = 5
        pattern.Resources = pikepdf.Dictionary()
        page = pdf.add_blank_page(page_size=(200.0, 200.0))
        page.Resources = pikepdf.Dictionary(
            ColorSpace=pikepdf.Dictionary(Cs1=pikepdf.Name.Pattern),
            Pattern=pikepdf.Dictionary(P1=pattern),
        )
        page.Contents = pdf.make_stream(b"/Cs1 cs /P1 scn 0 0 10 10 re f")
        walk = _Walk(pdf, page)
        walk.run()
        colour = walk.objects[0]["colour"]
        assert colour["family"] == "Pattern"
        assert colour["pattern_type"] == 1
        # Inventing a colour for a pattern is the wrong-colour failure the
        # resolver refuses; no swatch is offered rather than a plausible one.
        assert colour["rgb"] is None
        assert colour["components"] == []

    def test_an_unreadable_space_carries_the_third_state(self, tmp_path):
        objects = self._walk(tmp_path, b"/Missing cs 0.5 scn 0 0 10 10 re f", {})
        assert objects[0]["colour"]["unknown"] is True
        assert objects[0]["unknown"] is True

    def test_a_placement_the_walk_cannot_read_is_reported_not_dropped(self, tmp_path):
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200.0, 200.0))
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary())
        page.Contents = pdf.make_stream(b"q /Missing Do Q")
        walk = _Walk(pdf, page)
        walk.run()
        # Never "nothing here": a walk that could not judge an object has to
        # say so, or the reader takes silence for a clean answer.
        assert walk.unknown
        assert walk.objects[0]["unknown"] is True

    def test_text_reports_the_colour_the_run_is_painted_in(self, tmp_path):
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200.0, 200.0))
        page.Resources = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(
                F1=pikepdf.Dictionary(
                    Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
                    BaseFont=pikepdf.Name.Helvetica,
                )
            )
        )
        page.Contents = pdf.make_stream(
            b"BT 0 0 1 rg /F1 12 Tf 20 20 Td (hello) Tj ET"
        )
        walk = _Walk(pdf, page)
        walk.run()
        assert walk.objects[0]["kind"] == "text"
        assert walk.objects[0]["colour"]["family"] == "DeviceRGB"
        assert walk.objects[0]["colour"]["components"] == pytest.approx([0.0, 0.0, 1.0])
