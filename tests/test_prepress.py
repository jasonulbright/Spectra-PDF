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

    def test_every_render_intent_runs(self, tmp_dir, gs_path):
        src = _rgb_pdf(os.path.join(tmp_dir, "rgb.pdf"))
        for intent in ("perceptual", "relative", "saturation", "absolute"):
            out = os.path.join(tmp_dir, f"{intent}.pdf")
            r = convert_cmyk(src, out, render_intent=intent, gs_path=gs_path)
            assert r["render_intent"] == intent
            assert os.path.isfile(out)

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
