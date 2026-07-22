"""Phase 9.S5 — ICC-managed CMYK conversion for prepress (Ghostscript)."""

import os

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
        # a silent no-op (round-42 gauntlet). Perceptual / relative / absolute
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
        # gauntlet. Pin it so a strategy change can't silently start flattening.
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
