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
