"""Constructed transparency fixtures.

Every page is built in code so that "the flattener kept the text live" is
evidence rather than a claim: the number of live text blocks, where the
transparent object sits, and what it overlaps are all known before anything
runs.
"""

from __future__ import annotations

import pikepdf
from pikepdf import Array, Dictionary, Name

PAGE_W, PAGE_H = 612.0, 792.0
SQUARE = (400.0, 640.0, 80.0, 80.0)


def _helvetica(pdf):
    return pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/Helvetica")))


def text_and_alpha_square_pdf(path, lines: int = 30):
    """The classic flattener case: live text, a vector rule, and one
    half-transparent square in a corner that overlaps neither."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page.Resources = Dictionary(
        ExtGState=Dictionary(GA=pdf.make_indirect(
            Dictionary(Type=Name.ExtGState, ca=0.5, CA=0.5))),
        Font=Dictionary(F0=_helvetica(pdf)),
    )
    body = [b"q 0 0 1 RG 2 w 48 96 m 560 96 l S Q"]
    for i in range(lines):
        y = 600 - i * 18
        body.append(
            f"BT /F0 11 Tf 1 0 0 1 48 {y} Tm (Line {i:02d} of live text) Tj ET".encode()
        )
    x, y, w, h = SQUARE
    body.append(f"q /GA gs 1 0 0 rg {x} {y} {w} {h} re f Q".encode())
    page.Contents = pdf.make_stream(b"\n".join(body))
    pdf.save(path)
    pdf.close()
    return str(path)


def stacked_alpha_pdf(path):
    """An opaque bar with a half-transparent square drawn OVER it, and a
    second opaque bar the square never reaches — the affected-underneath
    class, with a control that must not be classified."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400.0, 400.0))
    page.Resources = Dictionary(ExtGState=Dictionary(GA=pdf.make_indirect(
        Dictionary(Type=Name.ExtGState, ca=0.4))))
    page.Contents = pdf.make_stream(b"\n".join([
        b"0 0 1 rg 40 300 120 60 re f",
        b"0 1 0 rg 40 40 120 60 re f",
        b"q /GA gs 1 0 0 rg 60 280 120 100 re f Q",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def blend_mode_pdf(path, blend: str = "Multiply"):
    """Full alpha, non-Normal blend mode — transparency with no `ca` at all."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300.0, 300.0))
    page.Resources = Dictionary(ExtGState=Dictionary(BM0=pdf.make_indirect(
        Dictionary(Type=Name.ExtGState, BM=Name("/" + blend)))))
    page.Contents = pdf.make_stream(b"\n".join([
        b"0 0 1 rg 20 20 100 100 re f",
        b"q /BM0 gs 1 0 0 rg 60 60 100 100 re f Q",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def soft_mask_pdf(path):
    """A soft mask in the ExtGState — transparency by `/SMask`, not by alpha."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300.0, 300.0))
    luminosity = pikepdf.Stream(pdf, b"0.5 g 0 0 100 100 re f")
    luminosity.Type = Name.XObject
    luminosity.Subtype = Name.Form
    luminosity.BBox = Array([0, 0, 100, 100])
    luminosity.Group = Dictionary(S=Name("/Transparency"), CS=Name.DeviceGray,
                                  Type=Name("/Group"))
    mask = pdf.make_indirect(Dictionary(
        Type=Name.Mask, S=Name("/Luminosity"), G=pdf.make_indirect(luminosity)))
    page.Resources = Dictionary(ExtGState=Dictionary(SM0=pdf.make_indirect(
        Dictionary(Type=Name.ExtGState, SMask=mask))))
    page.Contents = pdf.make_stream(b"\n".join([
        b"q /SM0 gs 1 0 0 rg 40 40 100 100 re f Q",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def transparency_group_form_pdf(path):
    """A Form XObject declaring a transparency group, plus live text outside
    it — the case where the transparent thing is a whole placed object."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400.0, 400.0))
    inner = pikepdf.Stream(pdf, b"1 0 0 rg 0 0 60 60 re f")
    inner.Type = Name.XObject
    inner.Subtype = Name.Form
    inner.BBox = Array([0, 0, 60, 60])
    inner.Group = Dictionary(S=Name("/Transparency"), CS=Name.DeviceRGB,
                             Type=Name("/Group"))
    page.Resources = Dictionary(
        XObject=Dictionary(Fm0=pdf.make_indirect(inner)),
        Font=Dictionary(F0=_helvetica(pdf)),
    )
    page.Contents = pdf.make_stream(b"\n".join([
        b"BT /F0 12 Tf 1 0 0 1 20 40 Tm (bottom left, clear of the group) Tj ET",
        b"q 1 0 0 1 300 320 cm /Fm0 Do Q",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def pattern_under_alpha_pdf(path):
    """A tiling-pattern fill that a transparent square overlaps — the
    expanded-pattern class."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300.0, 300.0))
    tile = pikepdf.Stream(pdf, b"0 0 1 rg 0 0 5 5 re f")
    tile.Type = Name.Pattern
    tile.PatternType = 1
    tile.PaintType = 1
    tile.TilingType = 1
    tile.BBox = Array([0, 0, 10, 10])
    tile.XStep = 10
    tile.YStep = 10
    tile.Resources = Dictionary()
    page.Resources = Dictionary(
        Pattern=Dictionary(P0=pdf.make_indirect(tile)),
        ExtGState=Dictionary(GA=pdf.make_indirect(
            Dictionary(Type=Name.ExtGState, ca=0.5))),
    )
    page.Contents = pdf.make_stream(b"\n".join([
        b"/Pattern cs /P0 scn 40 40 120 120 re f",
        b"q /GA gs 1 0 0 rg 100 100 80 80 re f Q",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def two_alpha_squares_pdf(path):
    """Two half-transparent squares at opposite corners, and live text between
    them — the merge control's test case: separate regions at one end of the
    balance, one region swallowing the text at the other."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page.Resources = Dictionary(
        ExtGState=Dictionary(GA=pdf.make_indirect(
            Dictionary(Type=Name.ExtGState, ca=0.5))),
        Font=Dictionary(F0=_helvetica(pdf)),
    )
    page.Contents = pdf.make_stream(b"\n".join([
        b"q /GA gs 1 0 0 rg 40 700 60 60 re f Q",
        b"BT /F0 12 Tf 1 0 0 1 220 400 Tm (between the two squares) Tj ET",
        b"q /GA gs 0 0 1 rg 500 40 60 60 re f Q",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def opaque_only_pdf(path):
    """No transparency anywhere — the flatten must leave it alone."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300.0, 300.0))
    page.Resources = Dictionary(Font=Dictionary(F0=_helvetica(pdf)))
    page.Contents = pdf.make_stream(b"\n".join([
        b"0 0 1 rg 20 20 100 100 re f",
        b"BT /F0 12 Tf 1 0 0 1 20 200 Tm (all opaque) Tj ET",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)
