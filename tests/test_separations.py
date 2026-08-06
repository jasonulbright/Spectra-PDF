"""The ink inventory, the separation raster, and the ink arithmetic.

Every Ghostscript-backed case carries the `gs_path` skip guard, which tests
for the EXECUTABLE: the release workflow creates empty resource directories,
so an `isdir` check would pass on a box with no Ghostscript at all.
"""

import os

import pytest

from engine.separations import (
    MAX_SPOTS_CEILING,
    composite_separations,
    ink_kind,
    ink_statistics,
    list_inks,
    plate_name_escape,
    render_separations,
)
from separation_builders import (
    cmyk_spot_pdf,
    inks_everywhere_pdf,
    many_spots_pdf,
    overprint_pdf,
    tac_ladder_pdf,
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
