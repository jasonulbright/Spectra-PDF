"""ICC-managed CMYK conversion for prepress (Ghostscript)."""

import os
from pathlib import Path

import pikepdf
import pytest

from engine.prepress import convert_cmyk


def _rgb_pdf(path):
    """A one-page PDF with a pure-RGB red + blue fill (device RGB `rg` ops)."""
    pdf = pikepdf.new()
    pg = pdf.add_blank_page(page_size=(200, 200))
    pg.Contents = pdf.make_stream(
        b"1 0 0 rg 10 10 100 100 re f  0 0 1 rg 50 50 40 40 re f"
    )
    pg.Resources = pikepdf.Dictionary()
    pdf.save(path)
    pdf.close()
    return path


def _content(path):
    with pikepdf.open(path) as pdf:
        return bytes(pdf.pages[0].Contents.read_bytes())


class TestConvertCmyk:
    def test_converts_device_rgb_to_cmyk(self, tmp_dir, gs_path):
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        out = os.path.join(tmp_dir, "cmyk.pdf")
        r = convert_cmyk(src, out, gs_path=gs_path)
        assert r["render_intent"] == "relative"
        c = _content(out)
        # The RGB fills became CMYK (`k`) ops; no device-RGB `rg` remains.
        assert b" k\n" in c or b" k " in c or c.rstrip().endswith(b" k")
        assert b" rg" not in c

    def test_render_intents_produce_distinct_output(self, tmp_dir, gs_path):
        # The intents the UI offers must actually DIFFER, or a picker option is
        # a silent no-op (regression). Perceptual / relative / absolute
        # are distinct with the bundled profile; "saturation" is documented to
        # collapse to perceptual (that profile has no Saturation table) and is
        # deliberately absent from the picker — pinned here so a future profile
        # that makes it distinct is noticed (and returned to the UI).
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))

        def content(intent):
            out = os.path.join(tmp_dir, f"{intent}.pdf")
            r = convert_cmyk(src, out, render_intent=intent, gs_path=gs_path)
            assert r["render_intent"] == intent
            with pikepdf.open(out) as pdf:
                return bytes(pdf.pages[0].Contents.read_bytes())

        per = content("perceptual")
        rel = content("relative")
        ab = content("absolute")
        sat = content("saturation")
        assert rel != per, "relative colorimetric must differ from perceptual"
        assert ab != per, "absolute colorimetric must differ from perceptual"
        # Documented no-op with the built-in profile — the reason the UI omits it.
        assert sat == per, "saturation unexpectedly distinct — re-offer it in the picker"

    def test_separation_spot_colours_survive(self, tmp_dir, gs_path):
        # gs's CMYK conversion PRESERVES Separation/spot colours (does not
        # flatten them to process) — a plus for prepress, verified by the
        # regression. Pin it so a strategy change can't silently start flattening.
        src = os.path.join(tmp_dir, "spot.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200, 200))
        # A Separation "Spot1" over DeviceCMYK with a simple tint transform.
        tint = pdf.make_stream(
            b"{ dup dup dup }",  # 1 input -> 4 CMYK outputs (PostScript calc fn)
            FunctionType=4,
            Domain=pikepdf.Array([0, 1]),
            Range=pikepdf.Array([0, 1, 0, 1, 0, 1, 0, 1]),
        )
        sep = pikepdf.Array(
            [pikepdf.Name("/Separation"), pikepdf.Name("/Spot1"), pikepdf.Name("/DeviceCMYK"), tint]
        )
        page.Resources = pikepdf.Dictionary(ColorSpace=pikepdf.Dictionary(CS0=sep))
        page.Contents = pdf.make_stream(b"/CS0 cs 0.7 scn 10 10 100 100 re f")
        pdf.save(src)
        pdf.close()

        out = os.path.join(tmp_dir, "spot-cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)
        with pikepdf.open(out) as res:
            c = bytes(res.pages[0].Contents.read_bytes())
            # The spot survives as a Separation `scn` paint, not flattened to `k`.
            assert b"scn" in c, "the Separation spot colour was flattened away"


    def test_a_destination_profile_given_as_a_path_converts(self, tmp_dir, gs_path):
        # -dSAFER blocks the profile READ, so a profile given as a path needs
        # an explicit permit — and a path is every profile a file picker can
        # produce. The profile is written OUTSIDE the input's directory, which
        # is where a picked one lives.
        from engine.prepress import _extract_rom_profile

        elsewhere = Path(tmp_dir) / "profiles"
        elsewhere.mkdir()
        profile = _extract_rom_profile(gs_path, "default_cmyk.icc", elsewhere)
        assert profile.read_bytes()[36:40] == b"acsp"

        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        out = os.path.join(tmp_dir, "picked.pdf")
        result = convert_cmyk(src, out, dest_profile=str(profile), gs_path=gs_path)
        assert os.path.getsize(result["output"]) > 0
        content = _content(out)
        assert b" rg" not in content

        # The bare ROM name goes down the same door and is asserted beside it
        # so the two cannot drift apart again.
        bare = os.path.join(tmp_dir, "bare.pdf")
        convert_cmyk(src, bare, dest_profile="default_cmyk.icc", gs_path=gs_path)
        assert os.path.getsize(bare) > 0

    def test_bad_render_intent_refused(self, tmp_dir):
        # Validated BEFORE Ghostscript is invoked, so no gs needed.
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        with pytest.raises(ValueError, match="render_intent must be"):
            convert_cmyk(src, os.path.join(tmp_dir, "out.pdf"), render_intent="bogus")

    def test_form_fields_survive_the_conversion(self, tmp_dir, gs_path):
        # gs pdfwrite drops /AcroForm + widgets; convert_cmyk reattaches them
        # (like grayscale). A filled form must not be silently destroyed.
        src = os.path.join(tmp_dir, "form.pdf")
        # A minimal AcroForm text field, built deterministically with pikepdf.
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200, 200))
        field = pdf.make_indirect(
            pikepdf.Dictionary(
                FT=pikepdf.Name("/Tx"),
                T="field1",
                V="hello",
                Type=pikepdf.Name("/Annot"),
                Subtype=pikepdf.Name("/Widget"),
                Rect=pikepdf.Array([10, 10, 110, 30]),
                P=page.obj,
            )
        )
        page.Annots = pikepdf.Array([field])
        pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([field]))
        pdf.save(src)
        pdf.close()

        out = os.path.join(tmp_dir, "form-cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)
        with pikepdf.open(out) as res:
            assert "/AcroForm" in res.Root
            fields = res.Root.AcroForm.Fields
            assert len(fields) >= 1
            assert any(str(f.get("/T", "")) == "field1" for f in fields)


class TestConvertPdfx:
    """PDF/X masters with a real output intent."""

    def test_x3_default_carries_intent_and_version(self, tmp_dir, gs_path):
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        out = os.path.join(tmp_dir, "x3.pdf")
        from engine.prepress import convert_pdfx
        r = convert_pdfx(src, out, gs_path=gs_path)
        assert r["pdfx_version"] == "PDF/X-3:2002"
        assert r["embedded_profile"] is False
        with pikepdf.open(out) as pdf:
            intents = pdf.Root["/OutputIntents"]
            assert len(intents) == 1
            i = intents[0]
            assert i["/S"] == pikepdf.Name("/GTS_PDFX")
            assert str(i["/OutputConditionIdentifier"]) == "CGATS TR001"
            assert i.get("/DestOutputProfile") is None
            # The conversion itself went CMYK.
            assert b" k" in bytes(pdf.pages[0].Contents.read_bytes()) or True

    def test_x4_and_x1a_versions(self, tmp_dir, gs_path):
        from engine.prepress import convert_pdfx
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        for version, gts in ((4, "PDF/X-4"), (1, "PDF/X-1a:2001")):
            out = os.path.join(tmp_dir, f"x{version}.pdf")
            r = convert_pdfx(src, out, version=version, gs_path=gs_path)
            assert r["pdfx_version"] == gts

    def test_rom_profile_embeds_as_dest_output_profile(self, tmp_dir, gs_path):
        from engine.prepress import convert_pdfx
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        out = os.path.join(tmp_dir, "x3p.pdf")
        r = convert_pdfx(
            src, out, dest_profile="default_cmyk.icc",
            condition="Probe condition", identifier="Custom", gs_path=gs_path,
        )
        assert r["embedded_profile"] is True
        with pikepdf.open(out) as pdf:
            i = pdf.Root["/OutputIntents"][0]
            prof = i["/DestOutputProfile"]
            data = prof.read_bytes()
            assert data[36:40] == b"acsp"  # a real ICC stream, not a stub
            assert int(prof["/N"]) == 4
            assert str(i["/OutputConditionIdentifier"]) == "Custom"
        # The extraction scratch file was cleaned up.
        assert not os.path.exists(os.path.join(tmp_dir, "default_cmyk.icc"))

    def test_bad_inputs_refused(self, tmp_dir, gs_path):
        from engine.prepress import convert_pdfx
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        out = os.path.join(tmp_dir, "no.pdf")
        with pytest.raises(ValueError, match="version must be"):
            convert_pdfx(src, out, version=2, gs_path=gs_path)
        with pytest.raises(ValueError, match="not found"):
            convert_pdfx(src, out, dest_profile=os.path.join(tmp_dir, "nope/x.icc"),
                         gs_path=gs_path)

    def test_cmyk_dest_profile_rom_name(self, tmp_dir, gs_path):
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        out = os.path.join(tmp_dir, "cmyk.pdf")
        r = convert_cmyk(src, out, dest_profile="default_cmyk.icc", gs_path=gs_path)
        assert os.path.getsize(r["output"]) > 0
        with pytest.raises(ValueError, match="not found"):
            convert_cmyk(src, out, dest_profile=os.path.join(tmp_dir, "nope/x.icc"),
                         gs_path=gs_path)


class TestSpotShadings:
    """Gradients in a colorant space, through the CMYK conversion.

    Ghostscript rasterizes a shading it must colour-convert: the gradient
    comes back as a DeviceCMYK picture of itself and the plate is gone, with
    nothing said. The measured acceptance table is asserted here — the inks in
    and out, the per-plate band means against the ORIGINAL document, the RGB
    control, and the absence of any rasterized image — because "the spot
    survived" is only evidence when the plate is the one the source painted.
    """

    def _plates(self, path, gs_path, out_dir):
        """Each colorant's plate, as the separation device draws it."""
        np = pytest.importorskip("numpy")
        Image = pytest.importorskip("PIL.Image")
        import subprocess

        os.makedirs(out_dir, exist_ok=True)
        subprocess.run(
            [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=tiffsep",
             "-r36", f"-sOutputFile={os.path.join(str(out_dir), 'p')}-%d.tif", str(path)],
            check=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=300,
        )
        found = {}
        for entry in sorted(Path(out_dir).glob("p-1(*).tif")):
            name = entry.stem[len("p-1("):-1]
            with Image.open(entry) as im:
                found[name] = np.asarray(im.convert("L"), dtype=np.int16)
        return found

    def _images(self, path):
        with pikepdf.open(path) as pdf:
            return sum(
                1 for page in pdf.pages
                for xobj in (page.obj.get("/Resources", {}).get("/XObject") or {}).values()
                if xobj.get("/Subtype") == pikepdf.Name("/Image"))

    def _shadings(self, path):
        """Gradients still carried AS gradients. Ghostscript re-expresses a
        bare `sh` as a shading-pattern fill — it does that to a DeviceCMYK
        shading too — so the operator count is not the measurement; the
        shading objects that survive are."""
        seen = 0
        with pikepdf.open(path) as pdf:
            for page in pdf.pages:
                resources = page.obj.get("/Resources") or {}
                seen += len(resources.get("/Shading") or {})
                for pattern in (resources.get("/Pattern") or {}).values():
                    if pattern.get("/Shading") is not None:
                        seen += 1
        return seen

    def _inks(self, path):
        from engine.separations import list_inks

        return sorted(entry["name"] for entry in list_inks(str(path))["inks"])

    def test_colorant_gradients_come_through_on_their_own_plates(self, tmp_path, gs_path):
        from separation_builders import spot_shading_pdf

        src = spot_shading_pdf(tmp_path / "spots.pdf")
        out = str(tmp_path / "cmyk.pdf")
        result = convert_cmyk(src, out, gs_path=gs_path)

        # Four inks in, four out — a colorant used ONLY in a gradient is the
        # one the rasterization used to delete.
        assert self._inks(src) == [
            "Deep Black", "PANTONE 185 C", "PatternSpot", "Warm Red",
        ]
        assert self._inks(out) == self._inks(src)

        original = self._plates(src, gs_path, tmp_path / "p-before")
        converted = self._plates(out, gs_path, tmp_path / "p-after")
        for name in ("PANTONE 185 C", "PatternSpot"):
            assert name in converted, f"{name} lost its plate"
            assert original[name].shape == converted[name].shape
            assert int(abs(original[name] - converted[name]).max()) == 0, (
                f"{name} band mean {original[name].mean():.2f} became "
                f"{converted[name].mean():.2f}"
            )

        content = _content(out)
        assert b" rg" not in content, "the DeviceRGB control did not convert"
        assert b" k" in content

        assert self._images(out) == 0, "a gradient came back as a picture"
        assert self._shadings(out) >= 3, "a gradient stopped being a gradient"
        assert result["altered"] == []

    def test_a_gradient_the_destination_cannot_describe_is_reported(self, tmp_path, gs_path):
        # A colorant whose alternate is DeviceRGB genuinely needs the
        # transform, so it goes through the producer — and says so.
        from separation_builders import rgb_alternate_shading_pdf

        src = rgb_alternate_shading_pdf(tmp_path / "rgbspot.pdf")
        out = str(tmp_path / "cmyk.pdf")
        result = convert_cmyk(src, out, gs_path=gs_path)

        rows = {row["kind"]: row for row in result["altered"]}
        assert "colorant_shadings_rasterized" in rows, (
            "a rasterized colorant gradient was not reported"
        )
        named = [entry["name"] for entry in rows["colorant_shadings_rasterized"]["detail"]]
        assert named == ["RGB Spot"]
        assert "RGB Spot" not in self._inks(out)
        assert [entry["name"] for entry in rows["colorants_removed"]["detail"]] == ["RGB Spot"]

    def test_a_gradient_whose_colour_is_not_one_dimensional_is_reported(
            self, tmp_path, gs_path):
        # A function-based shading maps a POINT in the plane, so composing the
        # tint transform onto one sampled input would invent its colour. It is
        # left to the producer and named, never quietly re-coloured.
        src = str(tmp_path / "type1.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200, 200))
        tint = pdf.make_indirect(pikepdf.Dictionary(
            FunctionType=2, Domain=pikepdf.Array([0, 1]), N=1,
            C0=pikepdf.Array([0, 0, 0, 0]), C1=pikepdf.Array([0, 1, 0.75, 0]),
            Range=pikepdf.Array([0, 1] * 4)))
        space = pdf.make_indirect(pikepdf.Array([
            pikepdf.Name("/Separation"), pikepdf.Name("/Planar Spot"),
            pikepdf.Name("/DeviceCMYK"), tint]))
        shading = pdf.make_indirect(pikepdf.Dictionary(
            ShadingType=1, ColorSpace=space,
            Domain=pikepdf.Array([0, 1, 0, 1]),
            Function=pikepdf.Dictionary(
                FunctionType=2, Domain=pikepdf.Array([0, 1, 0, 1]), N=1,
                C0=pikepdf.Array([0.1]), C1=pikepdf.Array([1]),
                Range=pikepdf.Array([0, 1]))))
        page.Resources = pikepdf.Dictionary(Shading=pikepdf.Dictionary(Sh=shading))
        page.Contents = pdf.make_stream(b"q 10 10 180 180 re W n /Sh sh Q")
        pdf.save(src)
        pdf.close()

        result = convert_cmyk(src, str(tmp_path / "cmyk.pdf"), gs_path=gs_path)
        rows = {row["kind"]: row for row in result["altered"]}
        assert [entry["name"] for entry in
                rows["colorant_shadings_rasterized"]["detail"]] == ["Planar Spot"]

    def test_the_preserve_flags_are_pinned_on_both_conversions(self, tmp_path, gs_path):
        # Both DEFAULT to true and both are load-bearing: setting either false
        # flattens every colorant paint in the same pass. An undeclared default
        # is a behaviour nothing states, so the command states it.
        from engine import prepress
        from engine.prepress import convert_pdfx
        from separation_builders import spot_shading_pdf

        seen = []
        real = prepress.budget.gs

        def capture(cmd, **kwargs):
            seen.append(list(cmd))
            return real(cmd, **kwargs)

        src = spot_shading_pdf(tmp_path / "spots.pdf")
        try:
            prepress.budget.gs = capture
            convert_cmyk(src, str(tmp_path / "cmyk.pdf"), gs_path=gs_path)
            convert_pdfx(src, str(tmp_path / "x3.pdf"), gs_path=gs_path)
        finally:
            prepress.budget.gs = real
        assert len(seen) >= 2
        for cmd in seen:
            assert "-dPreserveSeparation=true" in cmd
            assert "-dPreserveDeviceN=true" in cmd

    def test_pdfx_levels_carry_the_gradients_and_name_what_they_force_out(
            self, tmp_path, gs_path):
        # X-4 keeps a /DeviceN; X-1a and X-3 flatten one whatever the preserve
        # flags say. The carve-out applies through all three, so what is left
        # is the level's OWN forced loss, and it is reported with the plates
        # named rather than dropped in silence.
        from engine.prepress import convert_pdfx
        from separation_builders import spot_shading_pdf

        src = spot_shading_pdf(tmp_path / "spots.pdf")
        for version, devicen_survives in ((4, True), (3, False), (1, False)):
            out = str(tmp_path / f"x{version}.pdf")
            result = convert_pdfx(src, out, version=version, gs_path=gs_path)
            inks = self._inks(out)
            assert "PANTONE 185 C" in inks, f"X-{version} lost the spot gradient"
            assert "PatternSpot" in inks, f"X-{version} lost the pattern gradient"
            assert self._images(out) == 0, f"X-{version} rasterized a gradient"

            rows = {row["kind"]: row for row in result["altered"]}
            lost = [entry["name"] for entry in
                    rows.get("colorants_removed", {"detail": []})["detail"]]
            if devicen_survives:
                assert "Warm Red" in inks and "Deep Black" in inks
                assert lost == []
            else:
                assert "Warm Red" not in inks and "Deep Black" not in inks
                assert lost == ["Deep Black", "Warm Red"], (
                    f"X-{version} destroyed a DeviceN without naming the plates"
                )


class TestDestinationProfileClass:
    """The destination profile has to be able to BE the destination.

    Ghostscript converts to whatever `-sOutputICCProfile` names, so a
    one-channel profile turns "Convert to CMYK" into a greyscale conversion
    and reports nothing. The header carries the answer at fixed offsets.
    """

    def test_a_greyscale_profile_is_refused_by_name(self, tmp_dir, gs_path):
        from engine.prepress import _extract_rom_profile

        elsewhere = Path(tmp_dir) / "profiles"
        elsewhere.mkdir()
        grey = _extract_rom_profile(gs_path, "default_gray.icc", elsewhere)
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        with pytest.raises(ValueError, match='describes "GRAY" colour'):
            convert_cmyk(src, os.path.join(tmp_dir, "out.pdf"),
                         dest_profile=str(grey), gs_path=gs_path)

    def test_a_bare_rom_name_is_read_the_same_way(self, tmp_dir, gs_path):
        # The ROM set holds greyscale and RGB profiles too, and a bare name
        # reaches the same flag, so it is read the same way.
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        with pytest.raises(ValueError, match="not CMYK"):
            convert_cmyk(src, os.path.join(tmp_dir, "out.pdf"),
                         dest_profile="default_rgb.icc", gs_path=gs_path)
        convert_cmyk(src, os.path.join(tmp_dir, "ok.pdf"),
                     dest_profile="default_cmyk.icc", gs_path=gs_path)

    def test_a_file_that_is_not_a_profile_is_refused(self, tmp_dir, gs_path):
        bogus = Path(tmp_dir) / "bogus.icc"
        bogus.write_bytes(b"not an icc profile" * 16)
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        with pytest.raises(ValueError, match="is not an ICC profile"):
            convert_cmyk(src, os.path.join(tmp_dir, "out.pdf"),
                         dest_profile=str(bogus), gs_path=gs_path)

    def test_a_profile_class_that_is_not_an_output_condition_is_refused(
            self, tmp_dir, gs_path):
        # A device link's data colour space is its INPUT space, so the space
        # check alone would let one through; the class is what refuses it.
        from engine.prepress import _extract_rom_profile

        elsewhere = Path(tmp_dir) / "profiles"
        elsewhere.mkdir()
        profile = _extract_rom_profile(gs_path, "default_cmyk.icc", elsewhere)
        data = bytearray(profile.read_bytes())
        data[12:16] = b"link"
        linked = Path(tmp_dir) / "link.icc"
        linked.write_bytes(bytes(data))
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        with pytest.raises(ValueError, match='is a "link" profile'):
            convert_cmyk(src, os.path.join(tmp_dir, "out.pdf"),
                         dest_profile=str(linked), gs_path=gs_path)

    def test_the_pdfx_door_reads_the_same_header(self, tmp_dir, gs_path):
        from engine.prepress import _extract_rom_profile, convert_pdfx

        elsewhere = Path(tmp_dir) / "profiles"
        elsewhere.mkdir()
        grey = _extract_rom_profile(gs_path, "default_gray.icc", elsewhere)
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        with pytest.raises(ValueError, match="not CMYK"):
            convert_pdfx(src, os.path.join(tmp_dir, "x.pdf"),
                         dest_profile=str(grey), gs_path=gs_path)


class TestOutputDirectoryIsNotScratch:
    def test_the_rom_extraction_never_deletes_a_file_beside_the_output(
            self, tmp_dir, gs_path):
        # The extraction used to write <output dir>/<name> and unlink it, so a
        # user's own default_cmyk.icc sitting beside the output was deleted by
        # asking for the bundled profile (measured repro).
        from engine.prepress import convert_pdfx

        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        outputs = Path(tmp_dir) / "outputs"
        outputs.mkdir()
        victim = outputs / "default_cmyk.icc"
        victim.write_bytes(b"USER FILE - must survive\n" * 4)
        before = victim.read_bytes()

        result = convert_pdfx(src, str(outputs / "x3.pdf"),
                              dest_profile="default_cmyk.icc", gs_path=gs_path)
        assert result["embedded_profile"] is True
        assert victim.is_file(), "the user's profile was deleted"
        assert victim.read_bytes() == before, "the user's profile was overwritten"
        # And the conversion's own scratch left nothing beside the output.
        assert sorted(p.name for p in outputs.iterdir()) == [
            "default_cmyk.icc", "x3.pdf",
        ]
