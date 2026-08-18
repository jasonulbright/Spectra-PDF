"""The ink inventory, the separation raster, and the ink arithmetic.

Every Ghostscript-backed case carries the `gs_path` skip guard, which tests
for the EXECUTABLE: the release workflow creates empty resource directories,
so an `isdir` check would pass on a box with no Ghostscript at all.
"""

import os
from pathlib import Path

import pytest

import pikepdf

from engine.separations import (
    MAX_SPOTS_CEILING,
    composite_separations,
    ink_kind,
    ink_statistics,
    list_inks,
    list_simulation_profiles,
    plate_name_escape,
    render_separations,
)
from separation_builders import (
    cmyk_spot_pdf,
    cropped_page_pdf,
    device_rgb_pdf,
    form_appearance_pdf,
    inks_everywhere_pdf,
    many_spots_pdf,
    nested_separation_spot_pdf,
    overprint_pdf,
    rgb_alternate_spot_pdf,
    tac_ladder_pdf,
    unreadable_colorspace_table_pdf,
)

# The vendored fallback faces (Rust `get_edit_font_path` at run time, threaded
# to the engine as `font_dir`). Only the non-WinAnsi pins need them.
FONTS_DIR = Path(__file__).resolve().parent.parent / "resources" / "fonts"
_HAS_CJK_FACE = (FONTS_DIR / "NotoSansCJKsc-Regular.otf").is_file()
from transparency_builders import (
    over_depth_forms_pdf,
    unreadable_child_subtype_pdf,
    unreadable_form_gstate_pdf,
    unreadable_form_resources_pdf,
    unreadable_page_gstate_pdf,
)

np = pytest.importorskip("numpy")
Image = pytest.importorskip("PIL.Image")


def _plate(result, name):
    """One plate's ink coverage in 0…1. Polarity is inverted on the wire."""
    match = next(p for p in result["plates"] if p["name"] == name)
    with Image.open(match["file"]) as im:
        return (255.0 - np.asarray(im.convert("L")).astype(np.float32)) / 255.0


class TestInkInventory:
    def test_finds_a_colorant_through_every_resource_route(self, tmp_path):
        src = inks_everywhere_pdf(tmp_path / "everywhere.pdf")
        names = {e["name"]: e for e in list_inks(src)["inks"]}
        for expected in ("PageSpot", "FormSpot", "ImageSpot", "ShadingSpot",
                         "PatternSpot", "AnnotSpot"):
            assert expected in names, f"{expected} was not found"
        assert names["PageSpot"]["pages"] == [1]
        assert names["ImageSpot"]["used_in"] == ["image"]
        assert names["ShadingSpot"]["used_in"] == ["shading"]
        assert names["AnnotSpot"]["used_in"] == ["annotation"]

    def test_all_and_none_are_their_own_kinds(self, tmp_path):
        src = inks_everywhere_pdf(tmp_path / "everywhere.pdf")
        names = {e["name"]: e for e in list_inks(src)["inks"]}
        assert names["All"]["kind"] == "all"
        assert names["None"]["kind"] == "none"
        # Neither is a spot, so neither inflates the ceiling check.
        assert names["All"]["name"] not in [
            e["name"] for e in list_inks(src)["inks"] if e["kind"] == "spot"
        ]

    def test_display_colour_resolves_through_the_tint_transform(self, tmp_path):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        spot = next(e for e in list_inks(src)["inks"] if e["name"] == "PANTONE 185 C")
        # 0 1 0.75 0 CMYK at full tint is a red, not a grey.
        assert spot["display_rgb"][0] > 200
        assert spot["display_rgb"][1] < 60
        assert spot["alternate"] == "DeviceCMYK"

    def test_devicen_components_are_listed_individually(self, tmp_path):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        names = {e["name"] for e in list_inks(src)["inks"]}
        assert "Warm Red" in names

    def test_a_page_outside_the_document_refuses(self, tmp_path):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        with pytest.raises(ValueError, match="not in this document"):
            list_inks(src, pages=[7])

    def test_kind_classification(self):
        assert ink_kind("Cyan") == "process"
        assert ink_kind("PANTONE 185 C") == "spot"
        assert ink_kind("All") == "all"
        assert ink_kind("None") == "none"

    def test_a_document_read_whole_reports_nothing_unknown(self, tmp_path):
        src = inks_everywhere_pdf(tmp_path / "everywhere.pdf")
        assert list_inks(src)["unknown"] == []


class TestInventoryReportsWhatItCouldNotRead:
    """An ink inventory answers with what it found AND what it could not look at.

    Every case here used to return an ink list alone: the walk skipped the
    branch, the colorant it could have held never arrived, and the panel
    rendered the absence as the document's whole plate set — with the
    total-ink figures measured over that same short set.
    """

    def test_an_unreadable_colorspace_table_is_reported_beside_the_inks(self, tmp_path):
        src = unreadable_colorspace_table_pdf(tmp_path / "broken.pdf")
        result = list_inks(src)
        # The ink it DID reach is still returned — the read degrades, it does
        # not refuse.
        assert "PANTONE 185 C" in {e["name"] for e in result["inks"]}
        assert len(result["unknown"]) == 1
        assert "Page 1" in result["unknown"][0]
        assert "cannot all be established" in result["unknown"][0]

    def test_the_page_named_is_the_page_the_branch_is_on(self, tmp_path):
        src = unreadable_colorspace_table_pdf(tmp_path / "p2.pdf", pages=2, broken_on=2)
        assert "Page 2" in list_inks(src)["unknown"][0]

    def test_only_the_requested_pages_are_reported(self, tmp_path):
        src = unreadable_colorspace_table_pdf(tmp_path / "p2.pdf", pages=2, broken_on=2)
        assert list_inks(src, pages=[1])["unknown"] == []

    @pytest.mark.parametrize("builder", [
        unreadable_form_resources_pdf,
        unreadable_child_subtype_pdf,
        over_depth_forms_pdf,
    ])
    def test_a_subtree_that_will_not_read_could_hold_a_colorant(self, tmp_path, builder):
        src = builder(str(tmp_path / f"{builder.__name__}.pdf"))
        assert list_inks(src)["unknown"], builder.__name__

    @pytest.mark.parametrize("builder", [
        unreadable_form_gstate_pdf,
        unreadable_page_gstate_pdf,
    ])
    def test_an_unreadable_graphics_state_hides_no_ink(self, tmp_path, builder):
        """A skip only clouds the answers that read from it — a graphics state
        carries alpha, never a colorant."""
        src = builder(str(tmp_path / f"{builder.__name__}.pdf"))
        assert list_inks(src)["unknown"] == [], builder.__name__

    def test_the_render_still_runs_over_the_plates_that_are_known(self, tmp_path):
        """The preview is not withheld: plates that ARE known stay honest, and
        the panel states what could not be read alongside them."""
        src = unreadable_colorspace_table_pdf(tmp_path / "broken.pdf")
        result = list_inks(src, pages=[1])
        assert result["spot_count"] == 1
        assert result["pages"] == [1]
        assert result["unknown"]


class TestPlateNameEscape:
    @pytest.mark.parametrize("name,expected", [
        ("plain", "plain"),
        ("PANTONE 185 C", "PANTONE 185 C"),
        ("Spot(paren)", "Spot(paren)"),
        ("a#b", "a#b"),
        ("br[ack]et", "br[ack]et"),
        ("amp&plus+", "amp&plus+"),
        ("tilde~eq=", "tilde~eq="),
        ("pct%sign", "pct%25sign"),
        ("slash/name", "slash%2Fname"),
        ("back\\slash", "back%5Cslash"),
        ("col:on", "col%3Aon"),
        ("star*q?", "star%2Aq%3F"),
        ('quo"te', "quo%22te"),
        ("lt<gt>", "lt%3Cgt%3E"),
        ("pipe|x", "pipe%7Cx"),
        ("tab\tchar", "tab%09char"),
        ("del\x7fchar", "del%7Fchar"),
        ("Grün", "Gr%C3%BCn"),
        ("日本", "%E6%97%A5%E6%9C%AC"),
        ("high\xa0nbsp", "high%C2%A0nbsp"),
    ])
    def test_predicts_the_device_spelling(self, name, expected):
        assert plate_name_escape(name) == expected


@pytest.mark.usefixtures("gs_path")
class TestSeparationRaster:
    def test_plate_polarity_is_inverted(self, tmp_path, gs_path):
        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        black = _plate(result, "Black")
        height, width = black.shape
        row = height // 2
        # The ladder's first patch carries no ink and its second carries a
        # solid black. The device writes full ink as 0 and no ink as 255, so
        # the inversion is what makes these read 0.0 and 1.0.
        assert black[row][int(50 * width / 500)] == pytest.approx(0.0, abs=0.01)
        assert black[row][int(150 * width / 500)] == pytest.approx(1.0, abs=0.01)

    def test_the_four_process_plates_always_exist(self, tmp_path, gs_path):
        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        assert [p["name"] for p in result["plates"]] == [
            "Cyan", "Magenta", "Yellow", "Black",
        ]

    def test_spot_plates_are_paired_with_the_inventory(self, tmp_path, gs_path):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        by_name = {p["name"]: p for p in result["plates"]}
        assert by_name["PANTONE 185 C"]["kind"] == "spot"
        assert os.path.isfile(by_name["PANTONE 185 C"]["file"])
        assert by_name["PANTONE 185 C"]["display_rgb"][0] > 200

    def test_total_ink_matches_the_constructed_ladder(self, tmp_path, gs_path):
        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        layers = [_plate(result, n) for n in ("Cyan", "Magenta", "Yellow", "Black")]
        total = np.sum(np.stack(layers), axis=0) * 100.0
        height, width = total.shape
        row = height // 2
        for centre, expected in ((50, 0), (150, 100), (250, 200), (350, 300), (450, 340)):
            column = int(centre * width / 500)
            assert total[row][column] == pytest.approx(expected, abs=1.0)

    def test_max_total_ink_is_not_the_coverage_average(self, tmp_path, gs_path):
        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        stats = ink_statistics([p["file"] for p in result["plates"]], 300.0)
        average = sum(result["coverage"].values()) * 100.0
        assert stats["max_tac"] == pytest.approx(340, abs=1.0)
        assert average == pytest.approx(200, abs=1.0)

    def test_opm_zero_knocks_out_and_opm_one_preserves(self, tmp_path, gs_path):
        for opm, under_the_bar in ((0, 0.0), (1, 1.0)):
            src = overprint_pdf(tmp_path / f"op{opm}.pdf", opm=opm)
            result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
            yellow = _plate(result, "Yellow")
            height, width = yellow.shape
            assert yellow[height // 2][width // 4] == pytest.approx(under_the_bar, abs=0.01)
            # The knocking-out bar removes the yellow under it either way.
            assert yellow[height // 2][3 * width // 4] == pytest.approx(0.0, abs=0.01)

    def test_disabling_overprint_flips_the_simulation_off(self, tmp_path, gs_path):
        src = overprint_pdf(tmp_path / "op1.pdf", opm=1)
        off = render_separations(src, page=1, dpi=72, gs_path=gs_path, overprint=False)
        yellow = _plate(off, "Yellow")
        height, width = yellow.shape
        assert yellow[height // 2][width // 4] == pytest.approx(0.0, abs=0.01)

    def test_a_single_page_run_writes_the_first_output_index(self, tmp_path, gs_path):
        src = tac_ladder_pdf(tmp_path / "one.pdf")
        result = render_separations(src, page=1, dpi=36, gs_path=gs_path)
        for plate in result["plates"]:
            assert os.path.basename(plate["file"]).startswith("s1(")

    def test_the_spot_ceiling_refuses_rather_than_folding(self, tmp_path, gs_path):
        src = many_spots_pdf(tmp_path / "many.pdf", MAX_SPOTS_CEILING + 1)
        with pytest.raises(ValueError, match="separation preview supports"):
            render_separations(src, page=1, dpi=36, gs_path=gs_path)

    def test_the_ceiling_itself_still_renders(self, tmp_path, gs_path):
        src = many_spots_pdf(tmp_path / "sixty.pdf", MAX_SPOTS_CEILING)
        result = render_separations(src, page=1, dpi=36, gs_path=gs_path)
        spots = [p for p in result["plates"] if p["kind"] == "spot"]
        assert len(spots) == MAX_SPOTS_CEILING

    def test_the_plate_set_is_reused_rather_than_re_rendered(self, tmp_path, gs_path):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        first = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        second = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        assert first["dir"] == second["dir"]
        assert [p["file"] for p in first["plates"]] == [p["file"] for p in second["plates"]]

    def test_a_different_overprint_setting_is_a_different_plate_set(self, tmp_path, gs_path):
        src = overprint_pdf(tmp_path / "op1.pdf", opm=1)
        on = render_separations(src, page=1, dpi=72, gs_path=gs_path, overprint=True)
        off = render_separations(src, page=1, dpi=72, gs_path=gs_path, overprint=False)
        assert on["dir"] != off["dir"]


@pytest.mark.usefixtures("gs_path")
class TestTheRasterFrame:
    """The plates carry the frame the viewer shows, not the MediaBox.

    The canvas overlays the composite on a page cell sized from the CropBox, so
    a MediaBox raster is stretched over a region the page never displays — and
    the ink list, the per-ink coverage, the total-area alarm and the soft proof
    are then all honest answers about an area nobody is looking at.

    Every expectation below is the fixture's geometry: a 300x200 pt CropBox at
    (100, 500) on a 612x792 pt MediaBox, one 100x50 pt bar inside it at
    (150, 600) and one outside it at (20, 20). At 72 dpi one point is one
    pixel, so the right answers are integers rather than tolerances, and the
    MediaBox answers are different integers.
    """

    def test_the_raster_is_the_crop_box(self, tmp_path, gs_path):
        src = cropped_page_pdf(tmp_path / "crop.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        # 400 - 100 by 700 - 500. The MediaBox would give 612x792.
        assert (result["width"], result["height"]) == (300, 200)
        assert _plate(result, "Cyan").shape == (200, 300)

    def test_the_ink_lands_where_the_crop_box_puts_it(self, tmp_path, gs_path):
        src = cropped_page_pdf(tmp_path / "crop.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        cyan = _plate(result, "Cyan")
        rows, columns = np.nonzero(cyan > 0.5)
        # The bar's left edge is 150 - 100 = 50 pt right of the frame's left
        # edge, and its top edge is 700 - 650 = 50 pt below the frame's top.
        assert (int(columns.min()), int(columns.max())) == (50, 149)
        assert (int(rows.min()), int(rows.max())) == (50, 99)
        assert int((cyan > 0.5).sum()) == 100 * 50

    def test_ink_outside_the_crop_box_is_clipped_away(self, tmp_path, gs_path):
        src = cropped_page_pdf(tmp_path / "crop.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        # The magenta bar's top edge is at y = 70 and the frame's bottom edge
        # is at y = 500. The CropBox clips page content as well as framing it,
        # so this bar is off the plates under either framing — which is why a
        # MediaBox raster of a cropped page is wrong about geometry and about
        # every area-relative figure, and never about which inks are present.
        assert float(_plate(result, "Magenta").max()) == 0.0

    def test_coverage_is_a_fraction_of_the_cropped_area(self, tmp_path, gs_path):
        src = cropped_page_pdf(tmp_path / "crop.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        # 100 x 50 pt of solid cyan in a 300 x 200 pt frame. Measured over the
        # MediaBox the same bar is 5000 / 484704 of the page — 1.03 %, a
        # coverage figure for an area the plates do not cover.
        assert result["coverage"]["Cyan"] == pytest.approx(5000 / 60000, abs=1e-4)

    def test_the_device_applies_rotate_the_way_the_viewport_does(self, tmp_path, gs_path):
        src = cropped_page_pdf(tmp_path / "rot90.pdf", rotate=90)
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        # A viewport swaps the frame's extents under /Rotate 90; so does the
        # device. Disagreement here is a raster displayed on its side.
        assert (result["width"], result["height"]) == (200, 300)
        rows, columns = np.nonzero(_plate(result, "Cyan") > 0.5)
        # A quarter turn clockwise sends the frame's y axis to the raster's x
        # axis and the frame's x axis to the raster's downward axis, so the
        # bar's y span 100…150 becomes its columns and its x span 50…150 its
        # rows.
        assert (int(columns.min()), int(columns.max())) == (100, 149)
        assert (int(rows.min()), int(rows.max())) == (50, 149)

    def test_a_staged_separation_keeps_the_frame(self, tmp_path, gs_path):
        # A page carrying RGB is colour-managed to the press profile before it
        # is separated. The intermediate is a second document, and a frame the
        # device honours on the original but not on the intermediate would put
        # the soft proof alone in the wrong box.
        src = cropped_page_pdf(tmp_path / "rgbcrop.pdf", rgb=True)
        result = render_separations(
            src, page=1, dpi=72, gs_path=gs_path, simulation={"source": "bundled"})
        assert (result["width"], result["height"]) == (300, 200)
        total = np.sum(np.stack([
            _plate(result, name) for name in ("Cyan", "Magenta", "Yellow", "Black")
        ]), axis=0)
        rows, columns = np.nonzero(total > 0.02)
        assert (int(columns.min()), int(columns.max())) == (50, 149)
        assert (int(rows.min()), int(rows.max())) == (50, 99)


@pytest.mark.usefixtures("gs_path")
class TestComposite:
    def test_hiding_an_ink_changes_the_image(self, tmp_path, gs_path):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        every = composite_separations(
            result["dir"], result["plates"], output=str(tmp_path / "all.png"))
        without = composite_separations(
            result["dir"],
            [p for p in result["plates"] if p["kind"] != "spot"],
            output=str(tmp_path / "process.png"))
        assert len(every["inks"]) > len(without["inks"])
        with Image.open(every["png"]) as a, Image.open(without["png"]) as b:
            left = np.asarray(a.convert("RGB")).astype(np.int16)
            right = np.asarray(b.convert("RGB")).astype(np.int16)
        assert np.abs(left - right).max() > 0

    def test_hiding_every_ink_leaves_blank_paper(self, tmp_path, gs_path):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        blank = composite_separations(result["dir"], [], output=str(tmp_path / "none.png"))
        assert blank["inks"] == []
        assert blank["max_tac"] == 0.0

    def test_statistics_measure_only_the_visible_plates(self, tmp_path, gs_path):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        black_only = composite_separations(
            result["dir"],
            [p for p in result["plates"] if p["name"] == "Black"],
            output=str(tmp_path / "k.png"))
        assert black_only["max_tac"] <= 100.5

    def test_the_alarm_only_paints_when_something_exceeds_the_limit(self, tmp_path, gs_path):
        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        tripped = composite_separations(
            result["dir"], result["plates"], limit_pct=300.0, alarm=True,
            output=str(tmp_path / "hot.png"))
        clear = composite_separations(
            result["dir"], result["plates"], limit_pct=400.0, alarm=True,
            output=str(tmp_path / "cool.png"))
        assert tripped["over_pixels"] > 0
        assert clear["over_pixels"] == 0
        with Image.open(tripped["png"]) as a, Image.open(clear["png"]) as b:
            assert np.abs(
                np.asarray(a.convert("RGB")).astype(np.int16)
                - np.asarray(b.convert("RGB")).astype(np.int16)
            ).max() > 0

    def test_density_scales_how_dark_an_ink_renders(self, tmp_path, gs_path):
        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        light = composite_separations(
            result["dir"],
            [{"name": p["name"], "display_rgb": p["display_rgb"], "density": 0.2}
             for p in result["plates"]],
            output=str(tmp_path / "light.png"))
        heavy = composite_separations(
            result["dir"],
            [{"name": p["name"], "display_rgb": p["display_rgb"], "density": 1.0}
             for p in result["plates"]],
            output=str(tmp_path / "heavy.png"))
        with Image.open(light["png"]) as a, Image.open(heavy["png"]) as b:
            assert np.asarray(a.convert("L")).mean() > np.asarray(b.convert("L")).mean()

    def test_a_missing_plate_directory_refuses(self, tmp_path):
        with pytest.raises(ValueError, match="no longer available"):
            composite_separations(str(tmp_path / "gone"), [])


# ── the soft proof ─────────────────────────────────────────────────────────


def _patch_plates(directory, patches):
    """A plate set carrying known CMYK patches and nothing else.

    Written straight to disk rather than rendered: what an oracle pins has to
    be a value the page was BUILT to carry, and rastering a page would put
    Ghostscript's own conversion between the number and the assertion.
    """
    for index, ink in enumerate(("Cyan", "Magenta", "Yellow", "Black")):
        row = np.array(
            [[255 - round(patch[index] * 255) for patch in patches]], dtype=np.uint8
        )
        Image.fromarray(row, mode="L").save(os.path.join(directory, f"s1({ink}).tif"))


#: paper, C, M, Y, K, all four at 100 %, 50 % of C+M+Y, a 300 % rich black.
ORACLE_PATCHES = (
    (0.0, 0.0, 0.0, 0.0),
    (1.0, 0.0, 0.0, 0.0),
    (0.0, 1.0, 0.0, 0.0),
    (0.0, 0.0, 1.0, 0.0),
    (0.0, 0.0, 0.0, 1.0),
    (1.0, 1.0, 1.0, 1.0),
    (128 / 255, 128 / 255, 128 / 255, 0.0),
    (0.6, 0.4, 0.4, 1.0),
)

#: sRGB per patch, keyed by (rendering intent, black-point compensation).
#: Deterministic for a pinned profile and a pinned LittleCMS, which is what
#: makes them assertable rather than approximate.
ORACLE_SRGB = {
    ("relative", False): [
        (255, 255, 255), (0, 176, 240), (237, 39, 144), (255, 242, 21),
        (55, 53, 53), (32, 31, 31), (146, 133, 129), (36, 38, 40),
    ],
    ("relative", True): [
        (255, 255, 255), (0, 174, 239), (236, 0, 140), (255, 242, 0),
        (35, 31, 32), (0, 0, 0), (143, 128, 124), (0, 0, 0),
    ],
    ("absolute", False): [
        (225, 223, 216), (0, 153, 203), (207, 33, 121), (230, 212, 0),
        (47, 45, 44), (27, 25, 24), (128, 115, 108), (30, 32, 32),
    ],
}


def _proof_row(directory, tmp_path, gs_path, paper_white, black_ink, tag):
    result = composite_separations(
        directory,
        output=str(tmp_path / f"proof-{tag}.png"),
        simulation={"source": "bundled", "paper_white": paper_white,
                    "black_ink": black_ink},
        gs_path=gs_path,
    )
    with Image.open(result["png"]) as im:
        row = [tuple(int(v) for v in px) for px in np.asarray(im.convert("RGB"))[0]]
    return result["simulation"], row


@pytest.mark.usefixtures("gs_path")
class TestSoftProofOracle:
    """A soft proof is a rendering claim, so "it looks right" is not evidence."""

    def test_every_patch_matches_the_pinned_value_per_intent(self, tmp_path, gs_path):
        plates = tmp_path / "plates"
        plates.mkdir()
        _patch_plates(str(plates), ORACLE_PATCHES)
        for (intent, bpc), expected in ORACLE_SRGB.items():
            record, row = _proof_row(
                str(plates), tmp_path, gs_path,
                paper_white=intent == "absolute", black_ink=not bpc,
                tag=f"{intent}-{int(bpc)}")
            assert record["intent"] == intent
            assert record["black_point_compensation"] is bpc
            assert row == expected

    def test_compensation_is_a_no_op_under_absolute(self, tmp_path, gs_path):
        # The UI forces the black-ink switch on under paper white, and this is
        # why: the intent already carries both endpoints of the medium, so
        # leaving the switch live would ship a control that visibly does
        # nothing. A LittleCMS that broke this would break the rule silently.
        plates = tmp_path / "plates"
        plates.mkdir()
        _patch_plates(str(plates), ORACLE_PATCHES)
        plain, without = _proof_row(str(plates), tmp_path, gs_path, True, True, "abs-a")
        asked, with_bpc = _proof_row(str(plates), tmp_path, gs_path, True, False, "abs-b")
        assert without == with_bpc
        # The request is normalized rather than passed through, and the record
        # reports what was used.
        assert plain["black_point_compensation"] is False
        assert asked["black_point_compensation"] is False

    def test_compensation_is_not_a_no_op_under_relative(self, tmp_path, gs_path):
        plates = tmp_path / "plates"
        plates.mkdir()
        _patch_plates(str(plates), ORACLE_PATCHES)
        _plain_record, plain = _proof_row(str(plates), tmp_path, gs_path, False, True, "rel-a")
        _bpc_record, bpc = _proof_row(str(plates), tmp_path, gs_path, False, False, "rel-b")
        assert plain != bpc

    def test_the_proof_disagrees_with_the_multiply_model_on_overprints(
        self, tmp_path, gs_path
    ):
        plates = tmp_path / "plates"
        plates.mkdir()
        _patch_plates(str(plates), ORACLE_PATCHES)
        plain = composite_separations(str(plates), output=str(tmp_path / "plain.png"))
        with Image.open(plain["png"]) as im:
            row = [tuple(int(v) for v in px) for px in np.asarray(im.convert("RGB"))[0]]
        # Solid process inks agree to a few counts; the OVERPRINTS do not, and
        # an overprint is what a prepress operator opens the panel for.
        _record, proofed = _proof_row(str(plates), tmp_path, gs_path, False, True, "cmp")
        assert row[5] == (0, 0, 0)
        assert proofed[5] == (32, 31, 31)


@pytest.mark.usefixtures("gs_path")
class TestSoftProofCrossEngine:
    """The one check that does not grade its own work.

    The patch oracle is LittleCMS asserting about LittleCMS. This renders the
    same patches through a different ICC implementation of the same profile —
    Ghostscript's own colour engine, through its proof profile knob — and
    requires agreement. The properties that disqualify that path in the
    product (it is a whole separate raster, and it is slow) cost nothing in a
    test.
    """

    @staticmethod
    def _lab(rgb):
        value = np.asarray(rgb, dtype=np.float64) / 255.0
        value = np.where(value > 0.04045, ((value + 0.055) / 1.055) ** 2.4, value / 12.92)
        matrix = np.array([[0.4124, 0.3576, 0.1805],
                           [0.2126, 0.7152, 0.0722],
                           [0.0193, 0.1192, 0.9505]])
        xyz = value @ matrix.T / np.array([0.95047, 1.0, 1.08883])
        f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
        return np.array([116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])])

    @classmethod
    def _delta_e(cls, first, second):
        return float(np.sqrt(((cls._lab(first) - cls._lab(second)) ** 2).sum()))

    def _render_both(self, tmp_path, gs_path, intent, gs_intent):
        import subprocess

        from engine import soft_proof

        patches = [(0.0, 0.0, 0.0, 0.0), (1.0, 0.0, 0.0, 0.0), (0.0, 1.0, 0.0, 0.0),
                   (0.0, 0.0, 1.0, 0.0), (0.0, 0.0, 0.0, 1.0), (1.0, 1.0, 1.0, 1.0)]
        doc = tmp_path / "patches.pdf"
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(len(patches) * 40, 40))
        page.Resources = pikepdf.Dictionary()
        page.Contents = pdf.make_stream(b"\n".join(
            f"{c} {m} {y} {k} k {i * 40} 0 40 40 re f".encode()
            for i, (c, m, y, k) in enumerate(patches)
        ))
        pdf.save(doc)
        pdf.close()

        plates = render_separations(str(doc), page=1, dpi=72, gs_path=gs_path)
        proofed = composite_separations(
            plates["dir"], output=str(tmp_path / f"mine-{intent}.png"),
            # Ghostscript's proof path compensates the black point, and its
            # values match this side's compensated ones rather than its
            # uncompensated ones. Compensation is left on here so the two
            # engines are asked the same question.
            simulation={"source": "bundled", "paper_white": intent == "absolute",
                        "black_ink": False},
            gs_path=gs_path)
        with Image.open(proofed["png"]) as im:
            mine = np.asarray(im.convert("RGB"))

        profile = soft_proof.rom_profile(gs_path, soft_proof.BUNDLED_PROFILE_NAME)
        out = tmp_path / f"gs-{intent}.png"
        run = subprocess.run(
            [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=png16m",
             "-r72", "-dFirstPage=1", "-dLastPage=1", f"-sProofProfile={profile}",
             f"--permit-file-read={profile}", f"-dRenderIntent={gs_intent}",
             "-o", str(out), str(doc)],
            capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
        assert run.returncode == 0, run.stderr or run.stdout
        with Image.open(out) as im:
            theirs = np.asarray(im.convert("RGB"))
        centres = [(mine.shape[0] // 2, i * 40 + 20) for i in range(len(patches))]
        return [(mine[y, x], theirs[y, x]) for y, x in centres]

    def test_relative_agrees_with_ghostscripts_own_engine(self, tmp_path, gs_path):
        for mine, theirs in self._render_both(tmp_path, gs_path, "relative", 1):
            assert self._delta_e(mine, theirs) <= 1.0

    def test_absolute_agrees_on_every_ink_and_diverges_only_on_bare_paper(
        self, tmp_path, gs_path
    ):
        # Ghostscript paints an unpainted page its device white and does not
        # proof it, so the two engines cannot agree there — and that
        # difference is the whole point of simulating paper white. Every patch
        # carrying ink still has to agree, which is what makes the divergence
        # a rendering-model boundary rather than a colour disagreement.
        rows = self._render_both(tmp_path, gs_path, "absolute", 3)
        paper_mine, paper_theirs = rows[0]
        assert tuple(int(v) for v in paper_mine) == (225, 223, 216)
        assert tuple(int(v) for v in paper_theirs) == (255, 255, 255)
        for mine, theirs in rows[1:]:
            assert self._delta_e(mine, theirs) <= 1.0


@pytest.mark.usefixtures("gs_path")
class TestSoftProofComposition:
    def test_no_profile_leaves_the_composite_byte_identical(self, tmp_path, gs_path):
        # The gate that lets a change to the composite's arithmetic land:
        # every existing assertion about the multiply model keeps its meaning
        # by construction.
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        plain = composite_separations(
            result["dir"], result["plates"], output=str(tmp_path / "plain.png"))
        asked = composite_separations(
            result["dir"], result["plates"], output=str(tmp_path / "asked.png"),
            simulation={"source": "none", "paper_white": True, "black_ink": True},
            gs_path=gs_path)
        with open(plain["png"], "rb") as a, open(asked["png"], "rb") as b:
            assert a.read() == b.read()
        assert plain["simulation"]["source"] == "none"
        assert plain["simulation"]["refusal"] == ""

    def test_the_total_ink_figures_are_the_same_with_and_without_a_proof(
        self, tmp_path, gs_path
    ):
        # No display transform changes how much ink is on the sheet.
        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        plain = composite_separations(
            result["dir"], result["plates"], output=str(tmp_path / "plain.png"))
        proofed = composite_separations(
            result["dir"], result["plates"], output=str(tmp_path / "proof.png"),
            simulation={"source": "bundled"}, gs_path=gs_path)
        assert proofed["max_tac"] == plain["max_tac"]
        assert proofed["over_pixels"] == plain["over_pixels"]

    def test_a_hidden_plate_contributes_nothing_to_the_buffer(self, tmp_path, gs_path):
        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        every = composite_separations(
            result["dir"], result["plates"], output=str(tmp_path / "all.png"),
            simulation={"source": "bundled"}, gs_path=gs_path)
        without = composite_separations(
            result["dir"], [p for p in result["plates"] if p["name"] != "Black"],
            output=str(tmp_path / "nok.png"),
            simulation={"source": "bundled"}, gs_path=gs_path)
        assert every["simulation"]["source"] == "bundled"
        assert without["simulation"]["source"] == "bundled"
        with Image.open(every["png"]) as a, Image.open(without["png"]) as b:
            assert np.abs(
                np.asarray(a.convert("RGB")).astype(np.int16)
                - np.asarray(b.convert("RGB")).astype(np.int16)
            ).max() > 0

    def test_a_spot_proofs_through_its_own_declared_alternate(self, tmp_path, gs_path):
        # `display_rgb` is the ink SWATCH — an identity colour for the list —
        # and it must not become the proof's answer, or the swatch and the
        # page would have to change colour together when the press changed.
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        spot = [p for p in result["plates"] if p["name"] == "PANTONE 185 C"]
        proofed = composite_separations(
            result["dir"], spot + [p for p in result["plates"] if p["kind"] == "process"],
            output=str(tmp_path / "spot-proof.png"),
            simulation={"source": "bundled"}, gs_path=gs_path)
        assert proofed["simulation"]["refusal"] == ""
        assert proofed["simulation"]["source"] == "bundled"
        with Image.open(proofed["png"]) as im:
            arr = np.asarray(im.convert("RGB"))
        height, width = arr.shape[:2]
        # The full-tint spot band sits between y=200 and y=250 on a 400 pt page.
        sample = arr[int(height * (1 - 225 / 400))][int(width * 0.2)]
        assert tuple(int(v) for v in sample) != tuple(spot[0]["display_rgb"])

    def test_a_spot_shown_as_another_ink_lands_in_that_inks_channel(
        self, tmp_path, gs_path
    ):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        cyan = next(p for p in result["plates"] if p["name"] == "Cyan")

        def request(shown_as):
            return [{"name": "PANTONE 185 C", "display_rgb": cyan["display_rgb"],
                     "density": 1.0, "shown_as": shown_as},
                    {"name": "Cyan", "display_rgb": cyan["display_rgb"], "density": 1.0}]

        as_cyan = composite_separations(
            result["dir"], request("Cyan"), output=str(tmp_path / "as-cyan.png"),
            simulation={"source": "bundled"}, gs_path=gs_path)
        as_itself = composite_separations(
            result["dir"], request("PANTONE 185 C"), output=str(tmp_path / "as-self.png"),
            simulation={"source": "bundled"}, gs_path=gs_path)
        assert as_cyan["simulation"]["refusal"] == ""
        with Image.open(as_cyan["png"]) as a, Image.open(as_itself["png"]) as b:
            assert np.abs(
                np.asarray(a.convert("RGB")).astype(np.int16)
                - np.asarray(b.convert("RGB")).astype(np.int16)
            ).max() > 0

    def test_a_device_alternate_names_the_source_space_it_assumed(
        self, tmp_path, gs_path
    ):
        src = rgb_alternate_spot_pdf(tmp_path / "rgbspot.pdf")
        result = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        proofed = composite_separations(
            result["dir"], result["plates"], output=str(tmp_path / "rgbspot.png"),
            simulation={"source": "bundled"}, gs_path=gs_path)
        assert proofed["simulation"]["refusal"] == ""
        assert proofed["simulation"]["assumed"] == ["sRGB"]


@pytest.mark.usefixtures("gs_path")
class TestSoftProofRefusals:
    """Each of these makes the feature say no by name rather than render
    something wrong, and each is REPORTED: the composite still produces the
    multiply image, with the reason and a `none` source beside it."""

    def _plates(self, tmp_path, gs_path):
        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        return render_separations(src, page=1, dpi=36, gs_path=gs_path)

    def test_a_file_that_is_not_a_profile_refuses(self, tmp_path, gs_path):
        bogus = tmp_path / "bogus.icc"
        bogus.write_bytes(b"this is not a colour profile" * 8)
        result = composite_separations(
            self._plates(tmp_path, gs_path)["dir"], output=str(tmp_path / "a.png"),
            simulation={"source": "file", "profile": str(bogus)}, gs_path=gs_path)
        assert result["simulation"]["source"] == "none"
        assert "not a colour profile this engine can read" in result["simulation"]["refusal"]
        assert os.path.isfile(result["png"])

    def test_a_display_profile_refuses_by_name(self, tmp_path, gs_path):
        from engine import soft_proof

        rgb = soft_proof.rom_profile(gs_path, "default_rgb.icc")
        result = composite_separations(
            self._plates(tmp_path, gs_path)["dir"], output=str(tmp_path / "b.png"),
            simulation={"source": "file", "profile": str(rgb)}, gs_path=gs_path)
        assert result["simulation"]["source"] == "none"
        assert result["simulation"]["refusal"] == (
            "that profile describes a RGB device, not a printing press"
        )

    def test_an_intent_that_embeds_no_profile_refuses(self, tmp_path, gs_path):
        from engine.prepress import convert_pdfx

        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        named = str(tmp_path / "named.pdf")
        convert_pdfx(src, named, version=3, gs_path=gs_path)
        plates = render_separations(named, page=1, dpi=36, gs_path=gs_path)
        result = composite_separations(
            plates["dir"], output=str(tmp_path / "c.png"),
            simulation={"source": "document"}, gs_path=gs_path)
        assert result["simulation"]["source"] == "none"
        assert "embeds no profile" in result["simulation"]["refusal"]
        assert "CGATS TR001" in result["simulation"]["refusal"]

    def test_a_spot_whose_alternate_is_a_spot_refuses_by_name(self, tmp_path, gs_path):
        # The separation device declines to plate this colorant too — it folds
        # into the inner one — so the sentence is reached through the table
        # rather than through a composite. What it guards is a described plate
        # the proof has no space for, which would otherwise be drawn through
        # the multiply model beside managed inks.
        from engine import soft_proof

        src = nested_separation_spot_pdf(tmp_path / "nested.pdf")
        alternates = soft_proof.page_alternates(src, 1)
        assert alternates["Nested Spot"]["family"] == "Separation"
        profile = soft_proof.rom_profile(gs_path, soft_proof.BUNDLED_PROFILE_NAME)
        tables, assumed, refusal = soft_proof.spot_tables(
            ["Nested Spot"], alternates, str(profile), gs_path)
        assert tables == {}
        assert assumed == []
        assert refusal == (
            "the colorant Nested Spot converts to Separation, which is not a "
            "space this proof can describe"
        )

    def test_a_spot_the_alternates_cannot_describe_refuses_rather_than_falling_back(
        self, tmp_path, gs_path
    ):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        plates = render_separations(src, page=1, dpi=36, gs_path=gs_path)
        # The document moved out from under the plate set, so its tint
        # transforms can no longer be read. Drawing the spot through the
        # multiply model beside managed process inks would put two colour
        # models in one image with nothing saying so.
        for leftover in ("source.json", "alternates.json"):
            path = os.path.join(plates["dir"], leftover)
            if os.path.isfile(path):
                os.unlink(path)
        result = composite_separations(
            plates["dir"], plates["plates"], output=str(tmp_path / "d2.png"),
            simulation={"source": "bundled"}, gs_path=gs_path)
        assert result["simulation"]["source"] == "none"
        assert "is not a space this proof can describe" in result["simulation"]["refusal"]

    def test_a_spot_only_view_has_nothing_for_the_press_to_describe(
        self, tmp_path, gs_path
    ):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        plates = render_separations(src, page=1, dpi=36, gs_path=gs_path)
        spots = [p for p in plates["plates"] if p["kind"] == "spot"]
        result = composite_separations(
            plates["dir"], spots, output=str(tmp_path / "e.png"),
            simulation={"source": "bundled"}, gs_path=gs_path)
        assert result["simulation"]["source"] == "none"
        assert result["simulation"]["refusal"] == (
            "no process plate is showing, so there is nothing for the press "
            "profile to describe"
        )


@pytest.mark.usefixtures("gs_path")
class TestStagedSeparation:
    def test_a_page_of_device_cmyk_and_spots_needs_no_staging(self, tmp_path):
        from engine import soft_proof

        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        families = list_inks(src)["color_families"]
        assert set(families) == {"DeviceCMYK", "DeviceN", "Separation"}
        assert soft_proof.staging_applies(families) is False

    def test_an_inline_device_colour_is_reported_though_it_names_no_resource(
        self, tmp_path
    ):
        from engine import soft_proof

        src = device_rgb_pdf(tmp_path / "rgb.pdf")
        families = list_inks(src)["color_families"]
        assert families == ["DeviceRGB"]
        assert soft_proof.staging_applies(families) is True

    def test_the_profile_splits_the_plate_cache_only_where_staging_applies(
        self, tmp_path, gs_path
    ):
        rgb = device_rgb_pdf(tmp_path / "rgb.pdf")
        cmyk = tac_ladder_pdf(tmp_path / "tac.pdf")
        for src, splits in ((rgb, True), (cmyk, False)):
            plain = render_separations(src, page=1, dpi=36, gs_path=gs_path)
            proofed = render_separations(
                src, page=1, dpi=36, gs_path=gs_path,
                simulation={"source": "bundled"})
            assert (plain["dir"] != proofed["dir"]) is splits

    def test_the_staged_plates_reproduce_the_page(self, tmp_path, gs_path):
        # The bundled press profile IS the one Ghostscript separates through
        # by default, so staging the page through it must return the same ink
        # amounts: the assertion is that the extra conversion carries the page
        # rather than disturbing it.
        src = device_rgb_pdf(tmp_path / "rgb.pdf")
        plain = render_separations(src, page=1, dpi=36, gs_path=gs_path)
        staged = render_separations(
            src, page=1, dpi=36, gs_path=gs_path, simulation={"source": "bundled"})
        for name in ("Cyan", "Magenta", "Yellow", "Black"):
            assert np.abs(_plate(plain, name) - _plate(staged, name)).max() <= 2 / 255


class TestThePreviewRastersTheAppearanceTheFillWouldDraw:
    """A widget carrying no `/AP` gets one BEFORE the device reads the page.

    Without that, the device synthesizes an appearance from `/V` through the
    form's own WinAnsi Helvetica (ISO 32000-2 7.9.2.2) and rasters THAT — which
    for a value outside WinAnsi is the string's UTF-16BE bytes read as Latin
    glyphs. The plates then describe ink the document never states, and every
    figure measured off them describes it too.

    The instrument is a band compare against a CONTROL whose field carries a
    real appearance, drawn by the same emitters through the same face: the
    fixed preview has to reproduce it, not merely differ from the defect.
    """

    #: The fixture's page is 300x200 pt and its field rect is (20, 100, 280,
    #: 140). At 72 dpi one point is one pixel, so the band is stated in rows.
    BAND = (60, 100)

    def _band(self, result):
        """Each plate's ink over the field band, by ink name."""
        return {plate["name"]: _plate(result, plate["name"])[self.BAND[0]:self.BAND[1]]
                for plate in result["plates"]}

    @classmethod
    def _delta(cls, first, second):
        """Total mean absolute ink difference over the band, plate for plate.

        Zero is "these two rasters carry the same ink in the same places",
        which is the only claim strong enough to say the preview draws what
        the fill would draw.
        """
        assert set(first) == set(second)
        return sum(float(np.abs(first[name] - second[name]).mean()) for name in first)

    def _control(self, tmp_path, src):
        """The same document with the appearance already authored."""
        from engine.widget_faces import regenerate_appearances_file

        regenerated = regenerate_appearances_file(
            Path(src), tmp_path, str(FONTS_DIR))
        assert regenerated is not None
        return str(regenerated)

    @pytest.mark.skipif(not _HAS_CJK_FACE, reason="bundled CJK face not provisioned")
    def test_the_plates_match_a_real_appearance(self, tmp_path, gs_path):
        src = form_appearance_pdf(tmp_path / "bare-unicode.pdf", "bare-unicode")
        control = self._control(tmp_path, src)

        fixed = render_separations(src, page=1, dpi=72, gs_path=gs_path,
                                   font_dir=str(FONTS_DIR))
        wanted = self._band(render_separations(control, page=1, dpi=72,
                                               gs_path=gs_path))
        assert self._delta(self._band(fixed), wanted) == 0.0

    @pytest.mark.skipif(not _HAS_CJK_FACE, reason="bundled CJK face not provisioned")
    def test_the_profiled_arm_stages_the_same_document(self, tmp_path, gs_path):
        # The staged arm reads the page a second time, through the press
        # conversion. Preparing only the arm that rasters directly would leave
        # the soft proof showing the synthesis on its own.
        src = form_appearance_pdf(tmp_path / "bare-unicode.pdf", "bare-unicode")
        control = self._control(tmp_path, src)
        simulation = {"source": "bundled"}

        fixed = render_separations(src, page=1, dpi=72, gs_path=gs_path,
                                   simulation=simulation, font_dir=str(FONTS_DIR))
        assert os.path.isfile(os.path.join(fixed["dir"], "staged.pdf"))
        wanted = self._band(render_separations(control, page=1, dpi=72,
                                               gs_path=gs_path,
                                               simulation=simulation))
        assert self._delta(self._band(fixed), wanted) == 0.0

    @pytest.mark.skipif(not _HAS_CJK_FACE, reason="bundled CJK face not provisioned")
    def test_without_a_font_dir_the_device_synthesis_is_what_ships(
        self, tmp_path, gs_path
    ):
        # The degenerate is MEASURED, not hidden: no face can spell this value,
        # so the widget keeps no appearance and the plates carry the device's
        # own synthesis — exactly what the preview showed before the fix. The
        # same assertion is the mutation proof for the test above.
        src = form_appearance_pdf(tmp_path / "bare-unicode.pdf", "bare-unicode")
        wanted = self._band(render_separations(
            self._control(tmp_path, src), page=1, dpi=72, gs_path=gs_path))

        bare = render_separations(src, page=1, dpi=72, gs_path=gs_path, font_dir="")
        assert self._delta(self._band(bare), wanted) > 0.01

    @pytest.mark.skipif(not _HAS_CJK_FACE, reason="bundled CJK face not provisioned")
    def test_a_different_font_dir_is_a_different_plate_set(self, tmp_path, gs_path):
        # A set rendered without the fallback faces must not be served to a
        # caller that supplied them — the plates differ, so the cache entry has
        # to as well.
        src = form_appearance_pdf(tmp_path / "bare-unicode.pdf", "bare-unicode")
        without = render_separations(src, page=1, dpi=72, gs_path=gs_path,
                                     font_dir="")
        with_faces = render_separations(src, page=1, dpi=72, gs_path=gs_path,
                                        font_dir=str(FONTS_DIR))
        assert without["dir"] != with_faces["dir"]
        assert self._delta(self._band(without), self._band(with_faces)) > 0.01

    def test_a_document_with_no_form_field_keeps_one_cache_entry(
        self, tmp_path, gs_path
    ):
        # An appearance can only be regenerated in a document that carries a
        # form field, so on every other document the parameter changes nothing
        # and must not split the cache by a choice that changes nothing.
        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        plain = render_separations(src, page=1, dpi=36, gs_path=gs_path)
        with_faces = render_separations(src, page=1, dpi=36, gs_path=gs_path,
                                        font_dir=str(FONTS_DIR))
        assert plain["dir"] == with_faces["dir"]

    def test_a_field_that_already_has_an_appearance_rasters_identically(
        self, tmp_path, gs_path
    ):
        # The acceptance the fix must not disturb: there is nothing to
        # regenerate, so every plate comes back pixel for pixel. The compare
        # is on the RASTER rather than the file — the device writes its own
        # clock into the TIFF's DateTime tag, so two runs a second apart
        # differ in bytes over identical ink.
        src = form_appearance_pdf(tmp_path / "text.pdf", "text")
        plain = render_separations(src, page=1, dpi=72, gs_path=gs_path)
        with_faces = render_separations(src, page=1, dpi=72, gs_path=gs_path,
                                        font_dir=str(FONTS_DIR))
        assert [p["name"] for p in plain["plates"]] == [
            p["name"] for p in with_faces["plates"]]
        for name in [p["name"] for p in plain["plates"]]:
            assert np.array_equal(_plate(plain, name), _plate(with_faces, name)), name
        assert plain["coverage"] == with_faces["coverage"]

    @pytest.mark.skipif(not _HAS_CJK_FACE, reason="bundled CJK face not provisioned")
    def test_the_coverage_describes_the_document_the_plates_came_from(
        self, tmp_path, gs_path
    ):
        # Coverage is measured on the prepared copy, not the original: the
        # panel prints it beside the plates, and a figure taken from a file
        # the device never read is a number about a different page.
        src = form_appearance_pdf(tmp_path / "bare-unicode.pdf", "bare-unicode")
        control = render_separations(self._control(tmp_path, src), page=1,
                                     dpi=72, gs_path=gs_path)

        result = render_separations(src, page=1, dpi=72, gs_path=gs_path,
                                    font_dir=str(FONTS_DIR))
        assert os.path.isfile(os.path.join(result["dir"], "regenerated.pdf"))
        assert result["coverage"] == control["coverage"]

        bare = render_separations(src, page=1, dpi=72, gs_path=gs_path, font_dir="")
        assert bare["coverage"] != control["coverage"]


@pytest.mark.usefixtures("gs_path")
class TestSimulationProfilesOffered:
    def test_a_document_with_no_intent_offers_only_the_bundled_press(
        self, tmp_path, gs_path
    ):
        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        offered = list_simulation_profiles(src, gs_path)
        assert offered["document"]["present"] is False
        assert offered["document"]["embedded"] is False
        assert offered["bundled"]["present"] is True
        assert offered["bundled"]["name"] == "Artifex CMYK SWOP Profile"

    def test_an_embedded_intent_is_offered_by_its_own_description(
        self, tmp_path, gs_path
    ):
        from engine.prepress import convert_pdfx

        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        out = str(tmp_path / "pdfx.pdf")
        convert_pdfx(src, out, version=3, dest_profile="default_cmyk.icc",
                     gs_path=gs_path)
        offered = list_simulation_profiles(out, gs_path)
        assert offered["document"]["present"] is True
        assert offered["document"]["embedded"] is True
        assert offered["document"]["name"] == "Artifex CMYK SWOP Profile"

    def test_an_identifier_only_intent_is_present_but_not_embeddable(
        self, tmp_path, gs_path
    ):
        from engine.prepress import convert_pdfx

        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        out = str(tmp_path / "named.pdf")
        convert_pdfx(src, out, version=3, gs_path=gs_path)
        offered = list_simulation_profiles(out, gs_path)
        assert offered["document"]["present"] is True
        assert offered["document"]["embedded"] is False
        assert offered["document"]["identifier"] == "CGATS TR001"

    def test_the_documents_own_profile_proofs_the_page(self, tmp_path, gs_path):
        from engine.prepress import convert_pdfx

        src = tac_ladder_pdf(tmp_path / "tac.pdf")
        out = str(tmp_path / "pdfx.pdf")
        convert_pdfx(src, out, version=3, dest_profile="default_cmyk.icc",
                     gs_path=gs_path)
        plates = render_separations(out, page=1, dpi=36, gs_path=gs_path)
        result = composite_separations(
            plates["dir"], output=str(tmp_path / "doc.png"),
            simulation={"source": "document"}, gs_path=gs_path)
        assert result["simulation"]["source"] == "document"
        assert result["simulation"]["name"] == "Artifex CMYK SWOP Profile"
        assert result["simulation"]["refusal"] == ""
