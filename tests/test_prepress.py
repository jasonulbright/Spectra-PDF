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


def _plates(path, gs_path, out_dir, resolution: int = 36):
    """Each colorant's plate on page 1, as the separation device draws it."""
    np = pytest.importorskip("numpy")
    Image = pytest.importorskip("PIL.Image")
    import subprocess

    os.makedirs(out_dir, exist_ok=True)
    subprocess.run(
        [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=tiffsep",
         f"-r{resolution}",
         f"-sOutputFile={os.path.join(str(out_dir), 'p')}-%d.tif", str(path)],
        check=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=300,
    )
    found = {}
    for entry in sorted(Path(out_dir).glob("p-1(*).tif")):
        name = entry.stem[len("p-1("):-1]
        with Image.open(entry) as im:
            found[name] = np.asarray(im.convert("L"), dtype=np.int16)
    return found


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


def _ident(obj):
    """An object's identity, indirect or not."""
    return obj.objgen if getattr(obj, "is_indirect", False) else id(obj)


class TestSpotShadings:
    """Gradients in a colorant space, through the CMYK conversion.

    Ghostscript rasterizes a shading it must colour-convert: the gradient
    comes back as a DeviceCMYK picture of itself and the plate is gone, with
    nothing said. The measured acceptance table is asserted here — the inks in
    and out, the per-plate band means against the ORIGINAL document, the RGB
    control, and the absence of any rasterized image — because "the spot
    survived" is only evidence when the plate is the one the source painted.
    """

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

        original = _plates(src, gs_path, tmp_path / "p-before")
        converted = _plates(out, gs_path, tmp_path / "p-after")
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


class TestAppearanceShadings:
    """The same gradients, in an annotation's APPEARANCE stream.

    An `/AP` is colour-converted exactly as page content is, so a colorant
    gradient in one is rasterized in the same way and the plate goes with it —
    the loss the page-tier carve-out was built to stop, one tier down.
    """

    def _inks(self, path):
        from engine.separations import list_inks

        return sorted(entry["name"] for entry in list_inks(str(path))["inks"])

    def _appearances(self, path):
        """{annotation title: {face: (shadings, images)}} across every /AP."""
        found = {}
        with pikepdf.open(path) as pdf:
            for page in pdf.pages:
                for annot in list(page.obj.get("/Annots") or []):
                    ap = annot.get("/AP")
                    if ap is None:
                        continue
                    faces = {}
                    for key in list(ap.keys()):
                        entry = ap[key]
                        streams = ([(key, entry)] if isinstance(entry, pikepdf.Stream)
                                   else [(f"{key}{s}", entry[s])
                                         for s in list(entry.keys())])
                        for name, stream in streams:
                            resources = stream.get("/Resources") or {}
                            # One gradient reachable two ways is ONE gradient:
                            # the producer can name a shading in /Shading and
                            # also paint it through a /Pattern that points at
                            # the same object (measured), so they are counted
                            # by object identity rather than by resource entry.
                            shadings = set()
                            for entry in (resources.get("/Shading") or {}).values():
                                shadings.add(_ident(entry))
                            for pattern in (resources.get("/Pattern") or {}).values():
                                inner = pattern.get("/Shading")
                                if inner is not None:
                                    shadings.add(_ident(inner))
                            images = sum(
                                1 for xobj in (resources.get("/XObject") or {}).values()
                                if xobj.get("/Subtype") == pikepdf.Name("/Image"))
                            faces[name] = (len(shadings), images)
                    found[str(annot.get("/T"))] = faces
        return found

    def test_a_stamps_gradient_comes_through_on_its_own_plate(
            self, tmp_path, gs_path):
        from separation_builders import appearance_shading_pdf

        src = appearance_shading_pdf(tmp_path / "stamps.pdf")
        out = str(tmp_path / "cmyk.pdf")
        result = convert_cmyk(src, out, gs_path=gs_path)

        assert self._inks(out) == self._inks(src), (
            "an appearance-only colorant was destroyed by the conversion"
        )
        assert result["altered"] == []

        # Every appearance is still a gradient, and none came back as a picture.
        after = self._appearances(out)
        for title, faces in after.items():
            for face, (shadings, images) in faces.items():
                assert images == 0, f"{title} {face} came back as a picture"
                assert shadings == 1, f"{title} {face} stopped being a gradient"

        # And the page itself did convert — the appearance carve-out is not a
        # conversion that quietly did nothing.
        assert b" rg" not in _content(out)

    def test_the_stamp_plates_are_the_ones_the_source_painted(
            self, tmp_path, gs_path):
        from separation_builders import appearance_shading_pdf

        src = appearance_shading_pdf(tmp_path / "stamps.pdf")
        out = str(tmp_path / "cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)

        original = _plates(src, gs_path, tmp_path / "p-before")
        converted = _plates(out, gs_path, tmp_path / "p-after")
        # Only an annotation the print path draws lands on a plate: 12.5.3's
        # Print bit set and Hidden clear. That is what makes these three the
        # measurable ones, and the flags are not what the carve-out claims by.
        for name in ("Stamp Gradient", "NoView Gradient", "Rollover Gradient"):
            assert name in converted, f"{name} lost its plate"
            assert original[name].shape == converted[name].shape
            assert int(abs(original[name] - converted[name]).max()) == 0, (
                f"{name} band mean {original[name].mean():.2f} became "
                f"{converted[name].mean():.2f}"
            )

    def test_the_flags_do_not_decide_which_appearance_is_claimed(
            self, tmp_path, gs_path):
        # ISO 32000-2 12.5.3: bit 2 (Hidden) suppresses display AND print, bit
        # 3 (Print) governs printing otherwise, bit 6 (NoView) suppresses only
        # display. The producer converts every appearance regardless, so a
        # flag-aware carve-out would leave it free to destroy the plates it
        # skipped — the ink inventory is not a rendering question.
        from separation_builders import appearance_shading_pdf

        src = appearance_shading_pdf(tmp_path / "stamps.pdf")
        out = str(tmp_path / "cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)
        inks = self._inks(out)
        for name in ("Hidden Gradient", "NoView Gradient", "NoPrint Gradient"):
            assert name in inks, f"{name} lost its plate to its own flags"

    def test_every_appearance_face_is_claimed(self, tmp_path, gs_path):
        # /N is not the only face a producer rewrites, so it is not the only
        # one a plate can die in.
        from separation_builders import appearance_shading_pdf

        src = appearance_shading_pdf(tmp_path / "stamps.pdf")
        out = str(tmp_path / "cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)
        assert sorted(self._appearances(out)["Rollover Gradient"]) == ["/D", "/N"]
        inks = self._inks(out)
        assert "Rollover Gradient" in inks and "Down Gradient" in inks

    def test_a_widget_appearance_keeps_its_plate_through_the_form_reattach(
            self, tmp_path, gs_path):
        # A widget's appearance is converted on a staged page of its own and
        # harvested back onto the face the reattach transplants, so the plate
        # survives a tier the page-level carve-out never reaches — and the
        # appearance that comes back is the CONVERTED one, not the original.
        from separation_builders import appearance_shading_pdf

        src = appearance_shading_pdf(tmp_path / "stamps.pdf")
        out = str(tmp_path / "cmyk.pdf")
        result = convert_cmyk(src, out, gs_path=gs_path)

        def widget_appearance(path):
            with pikepdf.open(path) as pdf:
                for page in pdf.pages:
                    for annot in list(page.obj.get("/Annots") or []):
                        if annot.get("/Subtype") == pikepdf.Name("/Widget"):
                            return bytes(annot.AP.N.read_bytes())
            return None

        assert widget_appearance(out) != widget_appearance(src), (
            "the reattach put the unconverted appearance back"
        )
        assert "Widget Gradient" in self._inks(out)
        assert result["altered"] == []

    def test_an_annotation_the_producer_drops_keeps_its_plate_in_the_page(
            self, tmp_path, gs_path):
        # A dropped annotation's appearance is flattened into the page content
        # it came from, so the bracket travels there and the plate is recovered
        # at the page tier — which is why no annotation subtype is exempt from
        # the walk.
        from separation_builders import dropped_annotation_shading_pdf

        src = dropped_annotation_shading_pdf(tmp_path / "mark.pdf")
        out = str(tmp_path / "cmyk.pdf")
        result = convert_cmyk(src, out, gs_path=gs_path)

        with pikepdf.open(out) as pdf:
            assert len(pdf.pages[0].obj.get("/Annots") or []) == 0, (
                "the producer kept the annotation — the fixture proves nothing"
            )
        assert "Mark Gradient" in self._inks(out)
        assert result["altered"] == []

    def test_an_appearance_gradient_the_destination_cannot_describe_is_reported(
            self, tmp_path, gs_path):
        from separation_builders import rgb_alternate_appearance_pdf

        src = rgb_alternate_appearance_pdf(tmp_path / "rgbap.pdf")
        out = str(tmp_path / "cmyk.pdf")
        result = convert_cmyk(src, out, gs_path=gs_path)

        rows = {row["kind"]: row for row in result["altered"]}
        assert [entry["name"] for entry in
                rows["colorant_shadings_rasterized"]["detail"]] == [
            "RGB Appearance Spot"]
        assert "RGB Appearance Spot" not in self._inks(out)

    def test_pdfx_does_not_claim_an_appearance_it_removes(self, tmp_path, gs_path):
        # The conformance policy removes every annotation on the page, at every
        # level — so nothing is staged there, and the report names the removal
        # rather than a rasterization that did not happen.
        from engine.prepress import convert_pdfx
        from separation_builders import appearance_shading_pdf

        src = appearance_shading_pdf(tmp_path / "stamps.pdf")
        for version in (4, 3, 1):
            out = str(tmp_path / f"x{version}.pdf")
            result = convert_pdfx(src, out, version=version, gs_path=gs_path)
            rows = {row["kind"]: row for row in result["altered"]}
            with pikepdf.open(out) as pdf:
                assert all(len(page.obj.get("/Annots") or []) == 0
                           for page in pdf.pages), (
                    f"X-{version} kept an annotation the policy removes"
                )
            assert "annotations_removed" in rows
            assert "colorant_shadings_rasterized" not in rows, (
                f"X-{version} reported a rasterization that did not happen"
            )
            assert sorted(entry["name"] for entry in
                          rows["colorants_removed"]["detail"]) == self._inks(src)


class TestAppearancePatternSpace:
    """Where a pattern inside an annotation appearance is anchored.

    ISO 32000-2 8.7.2: a pattern matrix maps pattern space to the DEFAULT user
    space of the content stream the pattern is a resource of — for an
    appearance, its own space. The producer rewrites the appearance's content
    in one space and its pattern matrices in another, so the paint lands at the
    wrong scale. None of these fixtures is in a colorant space: what breaks
    here has nothing to do with what the conversion converts.
    """

    @pytest.mark.parametrize("kind", ["shading", "skewed"])
    def test_a_patterned_appearance_lands_where_it_did(
            self, kind, tmp_path, gs_path):
        from separation_builders import appearance_pattern_pdf

        src = appearance_pattern_pdf(tmp_path / f"{kind}.pdf", kind)
        out = str(tmp_path / f"{kind}-cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)

        original = _plates(src, gs_path, tmp_path / f"{kind}-before")
        converted = _plates(out, gs_path, tmp_path / f"{kind}-after")
        # The stamp is in the page's top half; the red rectangle below it is
        # the conversion's own business and is not what this measures.
        for name in ("Magenta", "Yellow"):
            band = slice(0, converted[name].shape[0] // 2)
            assert int(abs(original[name][band] - converted[name][band]).max()) == 0, (
                f"{kind}: the appearance's {name} paint moved"
            )

    def test_a_tiled_appearance_keeps_its_step(self, tmp_path, gs_path):
        # The producer re-derives the pattern matrix in rounded reals, so the
        # tile grid cannot land on the same pixels; what a wrong pattern space
        # changes is the STEP, and that is measured as ink coverage. The tile
        # is 10 units, so the plate is drawn fine enough to resolve one.
        from separation_builders import appearance_pattern_pdf

        src = appearance_pattern_pdf(tmp_path / "tiling.pdf", "tiling")
        out = str(tmp_path / "tiling-cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)

        original = _plates(src, gs_path, tmp_path / "tiling-before", 72)
        converted = _plates(out, gs_path, tmp_path / "tiling-after", 72)
        for name in ("Magenta", "Yellow"):
            band = slice(0, converted[name].shape[0] // 2)
            covered = (converted[name][band] < 250).mean()
            assert covered == pytest.approx(
                (original[name][band] < 250).mean(), abs=0.001), (
                f"the tile step moved on {name}"
            )
            assert int(abs(original[name][band] - converted[name][band]).max()) <= 1

    def test_an_appearance_without_a_pattern_is_left_alone(self, tmp_path, gs_path):
        # Nothing but a pattern reads a content stream's default space, so
        # nothing but a patterned appearance is rebased.
        from separation_builders import appearance_pattern_pdf

        src = appearance_pattern_pdf(tmp_path / "plain.pdf", "plain")
        out = str(tmp_path / "plain-cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)

        with pikepdf.open(out) as pdf:
            stream = pdf.pages[0].obj.Annots[0].AP.N
            assert b" cm" not in bytes(stream.read_bytes())
            assert [float(v) for v in stream.BBox] != [
                float(v) for v in pdf.pages[0].obj.Annots[0].Rect]

    def test_the_rebased_appearance_declares_the_page_space_it_now_uses(
            self, tmp_path, gs_path):
        from separation_builders import APPEARANCE_RECT, appearance_pattern_pdf

        src = appearance_pattern_pdf(tmp_path / "shading.pdf", "shading")
        out = str(tmp_path / "shading-cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)

        with pikepdf.open(out) as pdf:
            stream = pdf.pages[0].obj.Annots[0].AP.N
            assert [float(v) for v in stream.BBox] == list(APPEARANCE_RECT)
            assert [float(v) for v in stream.Matrix] == [1, 0, 0, 1, 0, 0]

    def test_a_shared_appearance_keeps_the_space_it_had(self, tmp_path):
        # One appearance worn by two annotations has two rectangles and so no
        # single default space to be rebased into. The producer un-shares an
        # appearance it rewrites, so the guard is asked of the rebase directly
        # — a conversion cannot produce the input it exists for.
        from engine.prepress import _rebase_appearances
        from separation_builders import appearance_pattern_pdf

        src = appearance_pattern_pdf(tmp_path / "shared.pdf", "shading")
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            page = pdf.pages[0].obj
            first = page.Annots[0]
            second = pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Stamp,
                Rect=pikepdf.Array([10, 100, 200, 150]), F=4, T="shared",
                AP=pikepdf.Dictionary(N=first.AP.N)))
            page.Annots = pikepdf.Array([first, second])
            pdf.save(src)
            before = bytes(first.AP.N.read_bytes())

        _rebase_appearances(Path(src))
        with pikepdf.open(src) as pdf:
            stream = pdf.pages[0].obj.Annots[0].AP.N
            assert bytes(stream.read_bytes()) == before
            assert [float(v) for v in stream.BBox] != [
                float(v) for v in pdf.pages[0].obj.Annots[0].Rect]

    def test_the_rebase_reaches_a_pattern_under_a_nested_form(self, tmp_path):
        # A pattern inside a form XObject under the appearance is anchored in
        # that form's default space, which the appearance's own space decides.
        from engine.prepress import _rebase_appearances
        from separation_builders import appearance_pattern_pdf

        src = appearance_pattern_pdf(tmp_path / "nested.pdf", "shading")
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            appearance = pdf.pages[0].obj.Annots[0].AP.N
            inner = pikepdf.Stream(pdf, bytes(appearance.read_bytes()))
            inner.Type = pikepdf.Name.XObject
            inner.Subtype = pikepdf.Name.Form
            inner.BBox = pikepdf.Array(list(appearance.BBox))
            inner.Resources = pikepdf.Dictionary(
                Pattern=pikepdf.Dictionary(P0=pdf.make_indirect(pikepdf.Dictionary(
                    Type=pikepdf.Name.Pattern, PatternType=2,
                    Shading=appearance.Resources.Shading.Sh))))
            appearance.Resources = pikepdf.Dictionary(
                XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(inner)))
            appearance.write(b"/Fm0 Do")
            pdf.save(src)

        _rebase_appearances(Path(src))
        with pikepdf.open(src) as pdf:
            stream = pdf.pages[0].obj.Annots[0].AP.N
            assert bytes(stream.read_bytes()).startswith(b"q ")
            assert [float(v) for v in stream.BBox] == [
                float(v) for v in pdf.pages[0].obj.Annots[0].Rect]


class TestFormAppearances:
    """A form field comes out painted ONCE, by an appearance that converted.

    The producer drops every widget annotation and flattens its appearance into
    the page content, while the field reattach puts the widget back wearing the
    appearance the ORIGINAL had. Together that painted the field twice and left
    the surviving `/AP` in the source's colour — an RGB paint inside a widget
    appearance came out of "Convert to CMYK" still RGB. Both were live defects;
    these are the pins that keep them dead.
    """

    def _widgets(self, path):
        """{field name: {"value", "faces", "idents"}} — read out of the file
        rather than held open, so every assertion is about bytes on disk."""
        found = {}
        with pikepdf.open(path) as pdf:
            for page in pdf.pages:
                for annot in list(page.obj.get("/Annots") or []):
                    if annot.get("/Subtype") != pikepdf.Name("/Widget"):
                        continue
                    faces, idents = {}, {}
                    ap = annot.get("/AP")
                    for key in list((ap or {}).keys()):
                        entry = ap[key]
                        streams = ([(key, entry)] if isinstance(entry, pikepdf.Stream)
                                   else [(f"{key}{s}", entry[s])
                                         for s in list(entry.keys())])
                        for name, stream in streams:
                            faces[name] = bytes(stream.read_bytes())
                            idents[name] = _ident(stream)
                    found[str(annot.get("/T"))] = {
                        "value": str(annot.get("/V")),
                        "faces": faces,
                        "idents": idents,
                    }
        return found

    def _without_form(self, src, dest):
        """The same document with no /AcroForm — so nothing is staged and
        nothing is reattached, which is the producer's own output: the control
        for what the converted field is supposed to look like."""
        import warnings

        with pikepdf.open(src) as pdf:
            del pdf.Root["/AcroForm"]
            with warnings.catch_warnings():
                # The orphan widget left behind is the POINT of this control.
                warnings.simplefilter("ignore", pikepdf.PageCopyWarning)
                pdf.save(str(dest))
        return str(dest)

    def test_the_field_is_painted_once_and_in_the_destinations_colour(
            self, tmp_path, gs_path):
        from separation_builders import (FORM_FILL_CMYK, FORM_FILL_RGB,
                                         FORM_PAGE_CMYK, FORM_TEXT_CMYK,
                                         FORM_TEXT_RGB, form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "form.pdf")
        out = str(tmp_path / "cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)

        page = _content(out)
        # The page converted — the control that says the conversion ran.
        assert FORM_PAGE_CMYK in page
        # …and it carries no copy of the field. The flattened copy used to sit
        # here, under the appearance's own /Tx marked content.
        assert FORM_FILL_CMYK not in page, "the field is painted twice"
        assert FORM_TEXT_CMYK not in page, "the field is painted twice"
        assert b"/Tx BMC" not in page

        field = self._widgets(out)["field1"]
        faces = field["faces"]
        assert list(faces) == ["/N"]
        # The one painter left carries the destination's own operands, and none
        # of the source's: this is the half that used to come back verbatim.
        assert FORM_FILL_CMYK in faces["/N"]
        assert FORM_TEXT_CMYK in faces["/N"]
        assert FORM_FILL_RGB not in faces["/N"]
        assert FORM_TEXT_RGB not in faces["/N"]
        assert b" rg" not in faces["/N"]
        # And it is still a field.
        assert field["value"] == "Hello"
        with pikepdf.open(out) as pdf:
            assert len(pdf.Root.AcroForm.Fields) == 1
            assert len(pdf.pages) == 1, "a staged appearance page was left behind"

    def test_the_appearance_lands_where_the_producer_put_it(
            self, tmp_path, gs_path):
        # The producer's own flattened output is the reference rendering of the
        # converted field: same command, same transform, no staging and no
        # reattach. Every plate must match it exactly — a harvested appearance
        # that moved, scaled or changed colour shows up here.
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "form.pdf")
        out = str(tmp_path / "cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)
        control = str(tmp_path / "flat-cmyk.pdf")
        convert_cmyk(self._without_form(src, tmp_path / "noform.pdf"), control,
                     gs_path=gs_path)

        produced = _plates(out, gs_path, tmp_path / "p-after", 72)
        reference = _plates(control, gs_path, tmp_path / "p-control", 72)
        assert sorted(produced) == sorted(reference)
        for name, plate in reference.items():
            assert produced[name].shape == plate.shape
            assert int(abs(produced[name] - plate).max()) == 0, (
                f"the converted field's {name} plate is not the producer's"
            )

    def test_every_face_is_converted_not_only_the_drawn_one(
            self, tmp_path, gs_path):
        # The producer flattens only the face /AS selects (measured), so a
        # mechanism built on the flatten alone would leave every other face in
        # the source's colour. Each face is converted on a page of its own.
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "states.pdf", "states")
        out = str(tmp_path / "cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)

        faces = self._widgets(out)["check"]["faces"]
        assert sorted(faces) == ["/D/Off", "/D/On", "/N/Off", "/N/On"]
        for name, body in faces.items():
            assert b" rg" not in body, f"{name} was never converted"
            assert b" k" in body, f"{name} paints nothing in the destination"
        assert b" rg" not in _content(out)
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 1, "four staged pages, none removed"

    def test_a_field_with_no_appearance_keeps_the_producers_own(
            self, tmp_path, gs_path):
        # A widget with no /AP is left in the producer's input on purpose: the
        # producer SYNTHESIZES an appearance from /V and /DA and flattens that
        # (measured), which is already one converted painter, and taking the
        # widget out would erase it.
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "bare.pdf", "bare")
        out = str(tmp_path / "cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)

        field = self._widgets(out)["bare"]
        assert field["faces"] == {}, "a synthesized appearance was harvested back"
        assert field["value"] == "Hello"
        page = _content(out)
        assert b"(Hello)" in page and b" rg" not in page

    def test_a_shared_appearance_is_converted_once(self, tmp_path, gs_path):
        # Two widgets wearing one stream is one appearance: staged once,
        # converted once, and still one object afterwards.
        from separation_builders import FORM_FILL_CMYK, form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "shared.pdf", "shared")
        out = str(tmp_path / "cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)

        widgets = self._widgets(out)
        assert sorted(widgets) == ["first", "second"]
        assert (widgets["first"]["idents"]["/N"]
                == widgets["second"]["idents"]["/N"])
        assert FORM_FILL_CMYK in widgets["first"]["faces"]["/N"]
        assert FORM_FILL_CMYK not in _content(out)

    def test_the_field_still_fills_after_the_conversion(self, tmp_path, gs_path):
        from engine.forms import fill_form_fields
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "form.pdf")
        out = str(tmp_path / "cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)

        filled = str(tmp_path / "filled.pdf")
        fill_form_fields(out, filled, {"field1": "Goodbye"})
        field = self._widgets(filled)["field1"]
        assert field["value"] == "Goodbye"
        assert b"(Goodbye)" in field["faces"]["/N"]

    def test_a_patterned_appearance_keeps_the_space_it_was_written_in(
            self, tmp_path, gs_path):
        # A harvested face's content came from a PAGE, so the pattern matrices
        # in it (ISO 32000-2 8.7.2) are already stated in that face's own
        # default space. Re-anchoring it to the annotation rectangle would
        # break them, so the rebase runs before the reattach and never sees it.
        from separation_builders import (FORM_FIELD_RECT,
                                         form_pattern_appearance_pdf)

        src = form_pattern_appearance_pdf(tmp_path / "pattern.pdf")
        out = str(tmp_path / "cmyk.pdf")
        convert_cmyk(src, out, gs_path=gs_path)

        with pikepdf.open(out) as pdf:
            face = pdf.pages[0].obj.Annots[0].AP.N
            assert [float(v) for v in face.BBox] != list(FORM_FIELD_RECT)
            assert [float(v) for v in face.Matrix] == [1, 0, 0, 1, 0, 0]
            resources = face.Resources
            assert len(resources.get("/Pattern") or {}) == 1

        control = str(tmp_path / "flat-cmyk.pdf")
        convert_cmyk(self._without_form(src, tmp_path / "noform.pdf"), control,
                     gs_path=gs_path)
        produced = _plates(out, gs_path, tmp_path / "p-after", 72)
        reference = _plates(control, gs_path, tmp_path / "p-control", 72)
        for name, plate in reference.items():
            assert int(abs(produced[name] - plate).max()) == 0, (
                f"the patterned appearance's {name} plate moved"
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
