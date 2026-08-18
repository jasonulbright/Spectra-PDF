"""Ink aliasing, spot-to-process conversion, and the refusals guarding both.

The aliasing case is measured against GROUND TRUTH — the separation device is
re-run and its plates counted — rather than against this module's own report
of what it renamed.
"""

import os
import shutil
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
    unconvertible_shading_pdf,
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


def _shading_bytes(path):
    """Each first-page shading serialised, keyed by its resource name.

    The fixture's unconvertible shadings are built out of DIRECT objects, so
    the serialisation carries the whole shading and a difference is a content
    difference rather than a renumbering.
    """
    with pikepdf.open(path) as pdf:
        table = pdf.pages[0].obj.Resources.Shading
        return {str(key): bytes(table[key].unparse()) for key in list(table.keys())}


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
        # The control on the report: every route on this page converts, so a
        # whole conversion says so by naming nothing.
        assert result["skipped"] == []
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


class TestShadingsTheCompositionCannotDescribe:
    """Composing the tint transform onto a shading's function samples ONE
    input. Where that does not describe the shading's colour, the shading is
    left exactly as it was and named — the alternative measured here is a
    conversion that invents colour and says nothing.
    """

    def test_a_function_based_shading_survives_byte_identical(self, tmp_path):
        src = unconvertible_shading_pdf(tmp_path / "planar.pdf")
        out = str(tmp_path / "process.pdf")
        spot_to_process(src, out, ["Warm Red"])
        assert _shading_bytes(out)["/ShPlanar"] == _shading_bytes(src)["/ShPlanar"]

    def test_a_background_carrier_survives_byte_identical(self, tmp_path):
        # Converting it would leave a one-component /Background in a
        # four-component space: components naming a colorant that is gone.
        src = unconvertible_shading_pdf(tmp_path / "background.pdf")
        out = str(tmp_path / "process.pdf")
        spot_to_process(src, out, ["Warm Red"])
        assert _shading_bytes(out)["/ShBg"] == _shading_bytes(src)["/ShBg"]

    def test_both_are_named_in_the_report_with_their_colorant(self, tmp_path):
        src = unconvertible_shading_pdf(tmp_path / "both.pdf")
        result = spot_to_process(src, str(tmp_path / "process.pdf"), ["Warm Red"])
        assert [entry["colorants"] for entry in result["skipped"]] == [
            ["Warm Red"], ["Warm Red"],
        ]
        assert sorted(entry["reason"] for entry in result["skipped"]) == sorted([
            "the shading maps a point in the plane, not one parametric value",
            "the shading states a background colour in the colorant's own space",
        ])
        assert len({entry["shading"] for entry in result["skipped"]}) == 2

    def test_the_convertible_shading_beside_them_still_converts(self, tmp_path):
        # The partial-success shape: one gradient that cannot convert costs
        # that gradient and nothing else.
        src = unconvertible_shading_pdf(tmp_path / "partial.pdf")
        out = str(tmp_path / "process.pdf")
        result = spot_to_process(src, out, ["Warm Red"])
        assert result["shadings"] == 1
        assert result["paints"] >= 1
        with pikepdf.open(out) as pdf:
            table = pdf.pages[0].obj.Resources.Shading
            assert str(table["/ShOk"].ColorSpace) == "/DeviceCMYK"
            assert str(table["/ShPlanar"].ColorSpace[0]) == "/Separation"
            assert str(table["/ShBg"].ColorSpace[0]) == "/Separation"

    def test_the_colorant_stays_live_in_what_was_skipped(self, tmp_path):
        # The ink is not reported converted out of a document that still
        # paints with it.
        src = unconvertible_shading_pdf(tmp_path / "live.pdf")
        out = str(tmp_path / "process.pdf")
        spot_to_process(src, out, ["Warm Red"])
        with pikepdf.open(out) as pdf:
            table = pdf.pages[0].obj.Resources.Shading
            names = {str(table[key].ColorSpace[1]).lstrip("/")
                     for key in list(table.keys())
                     if isinstance(table[key].ColorSpace, pikepdf.Array)}
        assert names == {"Warm Red"}


class TestWritingBackOverTheInput:
    """One path as BOTH input and output — the only shape the real callers use.

    The panel hands the open document's path twice, and the preflight fixup
    chain feeds each door the file the door before it wrote. A write that
    refuses that shape surfaces a library refusal at the button, and inside a
    profile run it degrades to a refusal row that reads as nothing happening.
    """

    def _pair(self, tmp_path, build, name: str):
        """The same bytes at two paths: one converted to a fresh output, the
        other converted over itself.

        `save_pdf` derives the trailer `/ID` from the written bytes, so one
        input has exactly one output — which makes "in place did the same
        thing" a byte comparison rather than an assertion.
        """
        source = build(tmp_path / name)
        control = tmp_path / "control.pdf"
        subject = tmp_path / "subject.pdf"
        shutil.copy2(source, subject)
        return source, control, subject

    def _besides(self, tmp_path, *expected: str) -> list:
        return sorted(
            p.name for p in tmp_path.iterdir() if p.name not in expected
        )

    def test_spot_to_process_converts_over_its_own_input(self, tmp_path):
        source, control, subject = self._pair(
            tmp_path, spot_in_every_paint_pdf, "source.pdf")
        expected = spot_to_process(source, str(control), ["Warm Red"])
        result = spot_to_process(str(subject), str(subject), ["Warm Red"])
        assert result == expected
        assert subject.read_bytes() == control.read_bytes()
        assert "Warm Red" not in _colorant_names(str(subject))

    def test_alias_ink_renames_over_its_own_input(self, tmp_path):
        source, control, subject = self._pair(
            tmp_path,
            lambda path: two_spots_pdf(path, "PANTONE 185 C", "Pantone 185C",
                                       (0.0, 1.0, 0.75, 0.0), (0.0, 1.0, 0.75, 0.0)),
            "source.pdf",
        )
        expected = alias_ink(source, str(control), "Pantone 185C", "PANTONE 185 C")
        result = alias_ink(str(subject), str(subject), "Pantone 185C",
                           "PANTONE 185 C")
        assert result == expected
        assert subject.read_bytes() == control.read_bytes()
        assert _colorant_names(str(subject)) == {"PANTONE 185 C"}

    def test_a_partial_conversion_in_place_still_reports_what_it_kept(self, tmp_path):
        # The shading the composition cannot describe is the case a profile run
        # has to read as partial, and a profile run is always in place.
        source, control, subject = self._pair(
            tmp_path, unconvertible_shading_pdf, "source.pdf")
        expected = spot_to_process(source, str(control), ["Warm Red"])
        result = spot_to_process(str(subject), str(subject), ["Warm Red"])
        assert result["skipped"] == expected["skipped"] != []
        assert subject.read_bytes() == control.read_bytes()

    def test_the_write_leaves_nothing_staged_beside_the_document(self, tmp_path):
        source = spot_in_every_paint_pdf(tmp_path / "source.pdf")
        spot_to_process(source, source, ["Warm Red"])
        assert self._besides(tmp_path, "source.pdf") == []

    def test_a_write_that_dies_leaves_the_input_whole_and_nothing_staged(
        self, tmp_path, monkeypatch,
    ):
        from engine import ink_manager

        source = tmp_path / "source.pdf"
        spot_in_every_paint_pdf(source)
        before = source.read_bytes()

        targets: list = []

        def die(_pdf, target, **_kwargs):
            targets.append(str(target))
            raise OSError("the volume went away mid-write")

        monkeypatch.setattr(ink_manager, "save_pdf", die)
        with pytest.raises(OSError):
            ink_manager.spot_to_process(str(source), str(source), ["Warm Red"])
        # The write that died was the STAGED one. Without that clause the
        # assertions below hold for a write that never began.
        assert targets and targets[0] != str(source)
        # The whole point of staging: the document the user still has open is
        # the document they had.
        assert source.read_bytes() == before
        assert self._besides(tmp_path, "source.pdf") == []

    def test_an_output_hardlinked_to_the_input_is_recognised_as_the_input(
        self, tmp_path,
    ):
        source = tmp_path / "source.pdf"
        spot_in_every_paint_pdf(source)
        alias = tmp_path / "alias.pdf"
        try:
            os.link(str(source), str(alias))
        except (AttributeError, NotImplementedError, OSError) as exc:
            pytest.skip(f"this filesystem does not make hard links: {exc}")

        spot_to_process(str(source), str(alias), ["Warm Red"])
        assert "Warm Red" not in _colorant_names(str(alias))
        # Two names for one file resolve differently and ARE one file, so only
        # the identity test reaches the staged branch. The other name still
        # reading as it did is what says the staged file replaced the NAME
        # rather than being written into the file pikepdf held open.
        assert "Warm Red" in _colorant_names(str(source))


class TestInkSettings:
    def test_defaults_order_process_first_and_say_where_they_live(self, tmp_path):
        src = cmyk_spot_pdf(tmp_path / "spot.pdf")
        defaults = ink_settings_defaults(src)
        assert defaults["stored_in_document"] is False
        assert defaults["sequence"][0] == "Black"
        assert all(value == 1.0 for value in defaults["density"].values())
        assert set(defaults["density"]) == set(defaults["sequence"])
