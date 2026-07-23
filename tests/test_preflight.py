"""§ I.6/I.3 — preflight print-production checks."""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.preflight import preflight


def _page(doc, resources):
    page = doc.add_blank_page(page_size=(300, 300))
    page.Resources = resources
    page.Contents = doc.make_stream(b"BT /F1 12 Tf 20 20 Td (x) Tj ET")
    return page


def _nonembedded_font(doc):
    # A base-14 Type1 with a FontDescriptor but NO FontFile → not embedded.
    fd = doc.make_indirect(Dictionary(Type=Name.FontDescriptor, FontName=Name.Helvetica, Flags=32))
    return doc.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1,
                                        BaseFont=Name.Helvetica, FontDescriptor=fd))


def _embedded_font(doc):
    ff = doc.make_stream(b"\x00\x01\x02")  # stand-in font program
    ff["/Length1"] = 3
    fd = doc.make_indirect(Dictionary(Type=Name.FontDescriptor, FontName=Name("/ABCDEF+Emb"), Flags=32, FontFile2=ff))
    return doc.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.TrueType,
                                        BaseFont=Name("/ABCDEF+Emb"), FontDescriptor=fd))


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


def _ids(res):
    return {c["id"]: c["status"] for c in res["checks"]}


class TestPreflight:
    def test_nonembedded_font_fails(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_nonembedded_font(doc))))
        doc.save(src); doc.close()
        r = preflight(src)
        assert _ids(r)["fonts_embedded"] == "fail"
        fonts = next(c for c in r["checks"] if c["id"] == "fonts_embedded")
        assert "Helvetica" in fonts["detail"]

    def test_embedded_font_passes(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_embedded_font(doc))))
        doc.save(src); doc.close()
        assert _ids(preflight(src))["fonts_embedded"] == "pass"

    def test_rgb_warns_cmyk_passes(self, tmp_dir):
        rgb = os.path.join(tmp_dir, "rgb.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_embedded_font(doc)),
                              ColorSpace=Dictionary(CS0=Name.DeviceRGB)))
        doc.save(rgb); doc.close()
        assert _ids(preflight(rgb))["rgb_color"] == "warn"

        cmyk = os.path.join(tmp_dir, "cmyk.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_embedded_font(doc)),
                              ColorSpace=Dictionary(CS0=Name.DeviceCMYK)))
        doc.save(cmyk); doc.close()
        assert _ids(preflight(cmyk))["rgb_color"] == "pass"

    def test_transparency_from_extgstate(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        gs = doc.make_indirect(Dictionary(Type=Name.ExtGState, ca=0.5))
        _page(doc, Dictionary(Font=Dictionary(F1=_embedded_font(doc)), ExtGState=Dictionary(GS0=gs)))
        doc.save(src); doc.close()
        assert _ids(preflight(src))["transparency"] == "warn"

    def test_font_inside_form_xobject_found(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        form = doc.make_stream(b"BT /FF 10 Tf (y) Tj ET")
        form["/Type"] = Name.XObject
        form["/Subtype"] = Name.Form
        form["/BBox"] = Array([0, 0, 50, 50])
        form["/Resources"] = Dictionary(Font=Dictionary(FF=_nonembedded_font(doc)))
        _page(doc, Dictionary(XObject=Dictionary(Fm0=form)))
        doc.save(src); doc.close()
        # The non-embedded font used only inside the form is still caught.
        assert _ids(preflight(src))["fonts_embedded"] == "fail"

    def test_clean_document_all_pass(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_embedded_font(doc)),
                              ColorSpace=Dictionary(CS0=Name.DeviceCMYK)))
        doc.save(src); doc.close()
        r = preflight(src)
        assert r["failed"] == 0 and r["warnings"] == 0

    def test_summary_counts(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_embedded_font(doc))))
        doc.save(src); doc.close()
        r = preflight(src)
        assert r["passed"] + r["warnings"] + r["failed"] == r["total"]
