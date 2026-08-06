"""Ink aliasing, spot-to-process conversion, and the refusals guarding both.

The aliasing case is measured against GROUND TRUTH — the separation device is
re-run and its plates counted — rather than against this module's own report
of what it renamed.
"""

import subprocess

import pikepdf
import pytest

from engine.ink_manager import (
    alias_ink,
    compare_tint_transforms,
    ink_settings_defaults,
    spot_to_process,
)
from engine.separations import render_separations
from separation_builders import (
    cmyk_spot_pdf,
    spot_in_every_paint_pdf,
    two_spots_pdf,
)

np = pytest.importorskip("numpy")
Image = pytest.importorskip("PIL.Image")


def _render_rgb(src, dest, gs_path):
    """The page as the screen device draws it — the frame an appearance claim
    has to be made in, since total ink is a different measurement."""
    subprocess.run(
        [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=png16m",
         "-r72", "-o", str(dest), str(src)],
        check=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=300,
    )
    with Image.open(dest) as im:
        return np.asarray(im.convert("RGB"))


def _plate_names(src, gs_path):
    result = render_separations(src, page=1, dpi=36, gs_path=gs_path, reuse=False)
    return sorted(p["name"] for p in result["plates"])


def _colorant_names(path):
    names = set()
    with pikepdf.open(path) as pdf:
        table = pdf.pages[0].obj.Resources.get("/ColorSpace")
        if table is None:
            return names
        for key in list(table.keys()):
            cs = table[key]
            if isinstance(cs, pikepdf.Array) and str(cs[0]) == "/Separation":
                names.add(str(cs[1]).lstrip("/"))
    return names


class TestTintComparison:
    def test_identical_transforms_match(self, tmp_path):
        src = two_spots_pdf(tmp_path / "same.pdf", "PANTONE 185 C", "Pantone 185C",
                            (0.0, 1.0, 0.75, 0.0), (0.0, 1.0, 0.75, 0.0))
        result = compare_tint_transforms(src, "PANTONE 185 C", "Pantone 185C")
        assert result["match"] is True
        assert result["diverges_at"] is None

    def test_a_different_curve_diverges_where_it_diverges(self, tmp_path):
        # Same endpoints, different exponent: 0.0 and 1.0 agree exactly and
        # every tint between them does not.
        src = two_spots_pdf(tmp_path / "curve.pdf", "Spot A", "Spot B",
                            (0.0, 1.0, 0.75, 0.0), (0.0, 1.0, 0.75, 0.0),
                            first_exponent=1.0, second_exponent=2.0)
        result = compare_tint_transforms(src, "Spot A", "Spot B")
        assert result["match"] is False
        assert result["reason"] == "transform"
        assert result["diverges_at"] == pytest.approx(0.1, abs=1e-9)

    def test_different_components_diverge(self, tmp_path):
        src = two_spots_pdf(tmp_path / "colour.pdf", "Spot A", "Spot B",
                            (0.0, 1.0, 0.75, 0.0), (1.0, 0.0, 0.0, 0.0))
        result = compare_tint_transforms(src, "Spot A", "Spot B")
        assert result["match"] is False
        assert result["max_delta"] > 0.5

    def test_an_absent_ink_refuses(self, tmp_path):
        src = two_spots_pdf(tmp_path / "same.pdf", "Spot A", "Spot B",
                            (0, 1, 0.75, 0), (0, 1, 0.75, 0))
        with pytest.raises(ValueError, match="is not used in this document"):
            compare_tint_transforms(src, "Spot A", "Nowhere")


class TestAliasing:
    def test_renames_the_source_onto_the_target(self, tmp_path):
        src = two_spots_pdf(tmp_path / "same.pdf", "PANTONE 185 C", "Pantone 185C",
                            (0.0, 1.0, 0.75, 0.0), (0.0, 1.0, 0.75, 0.0))
        out = str(tmp_path / "aliased.pdf")
        result = alias_ink(src, out, "Pantone 185C", "PANTONE 185 C")
        assert result["renamed"] == 1
        assert _colorant_names(out) == {"PANTONE 185 C"}

    def test_a_disagreeing_transform_refuses_without_consent(self, tmp_path):
        src = two_spots_pdf(tmp_path / "curve.pdf", "Spot A", "Spot B",
                            (0.0, 1.0, 0.75, 0.0), (1.0, 0.0, 0.0, 0.0))
        out = str(tmp_path / "aliased.pdf")
        with pytest.raises(ValueError, match="describe different colours"):
            alias_ink(src, out, "Spot B", "Spot A")
        result = alias_ink(src, out, "Spot B", "Spot A", accept_target_transform=True)
        assert result["transforms_matched"] is False
        assert _colorant_names(out) == {"Spot A"}

    def test_a_process_ink_never_moves_onto_a_spot(self, tmp_path):
        src = two_spots_pdf(tmp_path / "proc.pdf", "Cyan", "Spot B",
                            (1.0, 0, 0, 0), (1.0, 0, 0, 0))
        with pytest.raises(ValueError, match="Process inks cannot be aliased"):
            alias_ink(src, str(tmp_path / "o.pdf"), "Cyan", "Spot B")

    def test_an_absent_source_refuses(self, tmp_path):
        src = two_spots_pdf(tmp_path / "same.pdf", "Spot A", "Spot B",
                            (0, 1, 0.75, 0), (0, 1, 0.75, 0))
        with pytest.raises(ValueError, match="is not used in this document"):
            alias_ink(src, str(tmp_path / "o.pdf"), "Nowhere", "Spot A")

    def test_a_devicen_component_is_renamed_with_its_colorants_entry(self, tmp_path):
        src = cmyk_spot_pdf(tmp_path / "duo.pdf")
        out = str(tmp_path / "aliased.pdf")
        alias_ink(src, out, "Warm Red", "PANTONE 185 C", accept_target_transform=True)
        with pikepdf.open(out) as pdf:
            duo = pdf.pages[0].obj.Resources.ColorSpace["/CS1"]
            names = [str(n).lstrip("/") for n in duo[1]]
            colorants = duo[4].get("/Colorants")
            assert "Warm Red" not in names
            assert "PANTONE 185 C" in names
            assert pikepdf.Name("/Warm Red") not in colorants
            assert pikepdf.Name("/PANTONE 185 C") in colorants

    @pytest.mark.usefixtures("gs_path")
    def test_an_alias_folds_two_plates_into_one(self, tmp_path, gs_path):
        src = two_spots_pdf(tmp_path / "same.pdf", "PANTONE 185 C", "Pantone 185C",
                            (0.0, 1.0, 0.75, 0.0), (0.0, 1.0, 0.75, 0.0))
        before = _plate_names(src, gs_path)
        assert "PANTONE 185 C" in before and "Pantone 185C" in before

        out = str(tmp_path / "aliased.pdf")
        alias_ink(src, out, "Pantone 185C", "PANTONE 185 C")
        after = _plate_names(out, gs_path)
        assert "Pantone 185C" not in after
        assert "PANTONE 185 C" in after
        assert len(after) == len(before) - 1


@pytest.mark.usefixtures("gs_path")
class TestSpotToProcess:
    def test_the_spot_loses_its_plate(self, tmp_path, gs_path):
        src = spot_in_every_paint_pdf(tmp_path / "spot.pdf")
        out = str(tmp_path / "process.pdf")
        spot_to_process(src, out, ["Warm Red"])
        assert "Warm Red" in _plate_names(src, gs_path)
        assert "Warm Red" not in _plate_names(out, gs_path)

    def test_the_appearance_survives_the_conversion(self, tmp_path, gs_path):
        src = spot_in_every_paint_pdf(tmp_path / "spot.pdf")
        out = str(tmp_path / "process.pdf")
        spot_to_process(src, out, ["Warm Red"])
        difference = np.abs(
            _render_rgb(src, tmp_path / "before.png", gs_path).astype(np.int16)
            - _render_rgb(out, tmp_path / "after.png", gs_path).astype(np.int16)
        )
        # The colorant's own tint transform is what produced the process
        # values, so every route — fill, stroke, image, shading, pattern —
        # lands on the colour it already had.
        assert difference.max() <= 1

    def test_total_ink_rises_where_one_plate_became_four(self, tmp_path, gs_path):
        # The consequence a press operator has to be told about: a spot at
        # 60 % is 60 % total ink, and the same colour built from process
        # components is the SUM of them.
        src = spot_in_every_paint_pdf(tmp_path / "spot.pdf")
        out = str(tmp_path / "process.pdf")
        spot_to_process(src, out, ["Warm Red"])

        def peak(path):
            result = render_separations(path, page=1, dpi=72, gs_path=gs_path, reuse=False)
            layers = []
            for plate in result["plates"]:
                with Image.open(plate["file"]) as im:
                    layers.append(255.0 - np.asarray(im.convert("L")).astype(np.float32))
            return float(np.sum(np.stack(layers), axis=0).max()) * 100.0 / 255.0

        assert peak(out) > peak(src) + 50.0

    def test_content_streams_no_longer_name_the_space(self, tmp_path, gs_path):
        src = spot_in_every_paint_pdf(tmp_path / "spot.pdf")
        out = str(tmp_path / "process.pdf")
        result = spot_to_process(src, out, ["Warm Red"])
        assert result["paints"] >= 2
        assert result["images"] == 1
        assert result["shadings"] == 1
        with pikepdf.open(out) as pdf:
            page = pdf.pages[0]
            content = bytes(page.Contents.read_bytes())
            assert b"/CS0 cs" not in content
            assert b"/DeviceCMYK cs" in content
            image = page.Resources.XObject["/Im0"]
            assert str(image.ColorSpace) == "/DeviceCMYK"
            shading = page.Resources.Shading["/Sh0"]
            assert str(shading.ColorSpace) == "/DeviceCMYK"

    def test_a_tiling_pattern_converts_too(self, tmp_path, gs_path):
        src = spot_in_every_paint_pdf(tmp_path / "spot.pdf")
        out = str(tmp_path / "process.pdf")
        spot_to_process(src, out, ["Warm Red"])
        with pikepdf.open(out) as pdf:
            tile = pdf.pages[0].obj.Resources.Pattern["/P0"]
            assert b"/TCS cs" not in bytes(tile.read_bytes())

    def test_an_image_sample_converts_through_the_transform(self, tmp_path, gs_path):
        src = spot_in_every_paint_pdf(tmp_path / "spot.pdf")
        out = str(tmp_path / "process.pdf")
        spot_to_process(src, out, ["Warm Red"])
        with pikepdf.open(out) as pdf:
            image = pdf.pages[0].obj.Resources.XObject["/Im0"]
            samples = np.frombuffer(image.read_bytes(), dtype=np.uint8)
            assert samples.size == 2 * 2 * 4
            # Full tint maps to 0 0.9 0.8 0 CMYK.
            assert list(samples[:4]) == [0, 230, 204, 0]
            # Zero tint maps to no ink at all.
            assert list(samples[-4:]) == [0, 0, 0, 0]

    def test_a_devicen_converts_whole_and_names_what_went_with_it(self, tmp_path, gs_path):
        src = cmyk_spot_pdf(tmp_path / "duo.pdf")
        out = str(tmp_path / "process.pdf")
        result = spot_to_process(src, out, ["Warm Red"])
        assert "Black" in result["carried"]
        assert "Warm Red" not in _plate_names(out, gs_path)

    def test_an_absent_ink_refuses(self, tmp_path):
        src = spot_in_every_paint_pdf(tmp_path / "spot.pdf")
        with pytest.raises(ValueError, match="is not used in this document"):
            spot_to_process(src, str(tmp_path / "o.pdf"), ["Nowhere"])

    def test_naming_no_ink_refuses(self, tmp_path):
        src = spot_in_every_paint_pdf(tmp_path / "spot.pdf")
        with pytest.raises(ValueError, match="at least one ink"):
            spot_to_process(src, str(tmp_path / "o.pdf"), [])


class TestInkSettings:
    def test_defaults_order_process_first_and_say_where_they_live(self, tmp_path):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        defaults = ink_settings_defaults(src)
        assert defaults["stored_in_document"] is False
        assert defaults["sequence"][0] == "Black"
        assert all(value == 1.0 for value in defaults["density"].values())
        assert set(defaults["density"]) == set(defaults["sequence"])
