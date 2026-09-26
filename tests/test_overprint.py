"""The overprint walk reports every overprinting paint a page makes."""

import os

import pikepdf
from pikepdf import Dictionary, Name

from engine.overprint import list_overprint


def test_a_form_drawn_again_under_overprint_is_walked_again(tmp_dir):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    font = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica))
    form = pdf.make_stream(b"1 1 1 rg BT /F1 12 Tf 10 10 Td (White) Tj ET")
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = [0, 0, 200, 200]
    form.Resources = Dictionary(Font=Dictionary(F1=font))
    page.obj.Resources = Dictionary(
        XObject=Dictionary(Fm1=form),
        Font=Dictionary(F1=font),
        ExtGState=Dictionary(OP=Dictionary(Type=Name.ExtGState, OP=True, op=True)),
    )
    # The first draw knocks out; the second, under overprint, is the press defect.
    page.Contents = pdf.make_stream(
        b"/Fm1 Do q /OP gs 0 0 0 rg BT /F1 12 Tf 10 50 Td (Black) Tj ET "
        b"q 1 0 0 1 0 100 cm /Fm1 Do Q Q"
    )
    path = os.path.join(tmp_dir, "reuse.pdf")
    pdf.save(path)

    rows = list_overprint(path)["paints"]

    assert [row["zero_tint"] for row in rows] == [False, True]


def test_a_form_that_draws_itself_ends(tmp_dir):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    form = pdf.make_stream(b"/Fm1 Do")
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = [0, 0, 200, 200]
    form = pdf.make_indirect(form)
    form.Resources = Dictionary(XObject=Dictionary(Fm1=form))
    page.obj.Resources = Dictionary(XObject=Dictionary(Fm1=form))
    page.Contents = pdf.make_stream(b"/Fm1 Do")
    path = os.path.join(tmp_dir, "cycle.pdf")
    pdf.save(path)

    report = list_overprint(path)

    assert report["paints"] == []
