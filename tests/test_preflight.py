"""Preflight print-production checks."""

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
        assert (r["passed"] + r["warnings"] + r["failed"]
                + r["needs_review"]) == r["total"]


def _broken_stream_page(doc):
    """A page whose content stream will not decode — nothing that reads it can
    report what it paints."""
    page = doc.add_blank_page(page_size=(300, 300))
    page.Resources = Dictionary(Font=Dictionary(F1=_embedded_font(doc)))
    stream = doc.make_stream(b"not flate data at all")
    stream.stream_dict[Name.Filter] = Name.FlateDecode
    page.obj[Name.Contents] = stream
    return page


class TestUnreadableIsNotAPass:
    """A check that could not look everywhere reports `needs_review`.

    Every case here used to report `pass`: the walk swallowed the branch, the
    fact it was carrying never arrived, and the absence was rendered as a
    clean document. A positive finding is still certain, so `warn` and `fail`
    stand whatever else could not be read.
    """

    def test_an_unreadable_colorspace_table_cannot_pass_the_rgb_check(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_embedded_font(doc)), ColorSpace=17))
        doc.save(src); doc.close()
        res = preflight(src)
        assert _ids(res)["rgb_color"] == "needs_review"
        assert res["unreadable"], "the skipped branch must be named"
        assert res["needs_review"] == 1

    def test_an_unreadable_font_cannot_pass_the_embedding_check(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=5)))
        doc.save(src); doc.close()
        assert _ids(preflight(src))["fonts_embedded"] == "needs_review"

    def test_an_unreadable_graphics_state_cannot_pass_the_transparency_check(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_embedded_font(doc)),
                              ExtGState=Dictionary(GS0=9)))
        doc.save(src); doc.close()
        assert _ids(preflight(src))["transparency"] == "needs_review"

    def test_an_unreadable_xobject_clouds_every_check_it_could_have_carried(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_embedded_font(doc)),
                              XObject=Dictionary(Fm0=3)))
        doc.save(src); doc.close()
        statuses = _ids(preflight(src))
        # A form XObject can hold a font, a colorant and a transparency group.
        assert statuses["fonts_embedded"] == "needs_review"
        assert statuses["rgb_color"] == "needs_review"
        assert statuses["transparency"] == "needs_review"

    def test_an_unparseable_page_cannot_pass_the_hairline_check(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _broken_stream_page(doc)
        doc.save(src); doc.close()
        assert _ids(preflight(src))["hairlines"] == "needs_review"

    def test_a_positive_finding_still_stands(self, tmp_dir):
        """RGB found is RGB found — an unreadable branch elsewhere never
        downgrades a warning into a question."""
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_nonembedded_font(doc)),
                              ColorSpace=Dictionary(CS0=Name.DeviceRGB),
                              XObject=Dictionary(Fm0=3)))
        doc.save(src); doc.close()
        statuses = _ids(preflight(src))
        assert statuses["rgb_color"] == "warn"
        assert statuses["fonts_embedded"] == "fail"

    def test_a_readable_document_reviews_nothing(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_embedded_font(doc)),
                              ColorSpace=Dictionary(CS0=Name.DeviceCMYK)))
        doc.save(src); doc.close()
        res = preflight(src)
        assert res["needs_review"] == 0
        assert res["unreadable"] == []

    def test_one_broken_table_never_sinks_the_walk(self, tmp_dir):
        """The enumeration used to run unguarded: a table that is not a
        dictionary raised out of the walk and took the whole report with it."""
        src = os.path.join(tmp_dir, "s.pdf")
        doc = pikepdf.new()
        _page(doc, Dictionary(Font=Dictionary(F1=_nonembedded_font(doc)),
                              ColorSpace=17))
        doc.save(src); doc.close()
        res = preflight(src)
        assert res["total"] == 5
        assert _ids(res)["fonts_embedded"] == "fail"
