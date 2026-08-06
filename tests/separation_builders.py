"""Constructed CMYK / spot / overprint / total-ink fixtures.

Shared by the separation-preview and ink-manager tests: both measure against
documents whose ink content is known by construction, because "the plate says
340 %" is only evidence if the page was built to carry 340 %.
"""

from __future__ import annotations

import pikepdf
from pikepdf import Array, Dictionary, Name


def separation_space(pdf, ink: str, alternate_cmyk, exponent: float = 1.0):
    """`[/Separation /ink /DeviceCMYK tint]` with a type-2 tint transform."""
    fn = pdf.make_indirect(Dictionary(
        FunctionType=2, Domain=Array([0, 1]), N=exponent,
        C0=Array([0, 0, 0, 0]), C1=Array(list(alternate_cmyk)),
        Range=Array([0, 1, 0, 1, 0, 1, 0, 1]),
    ))
    return pdf.make_indirect(Array([Name.Separation, Name("/" + ink), Name.DeviceCMYK, fn]))


def devicen_space(pdf, inks, alternate_map):
    """A DeviceN duotone whose components route to distinct CMYK channels."""
    fn = pdf.make_indirect(pikepdf.Stream(
        pdf, b"{ exch dup 0.9 mul exch pop exch dup 0.8 mul exch 0.2 mul 0 }",
        FunctionType=4, Domain=Array([0, 1] * len(inks)), Range=Array([0, 1] * 4),
    ))
    attrs = Dictionary(Subtype=Name.NChannel, Colorants=Dictionary(**{
        ink: separation_space(pdf, ink, alternate_map[ink]) for ink in inks
    }))
    names = Array([Name("/" + ink) for ink in inks])
    return pdf.make_indirect(Array([Name.DeviceN, names, Name.DeviceCMYK, fn, attrs]))


def cmyk_spot_pdf(path, spot: str = "PANTONE 185 C"):
    """Process patches, a spot at two tints, a DeviceN duotone, and a
    340 % total-ink patch, on one 400×400 page."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    spot_cs = separation_space(pdf, spot, (0.0, 1.0, 0.75, 0.0))
    duo = devicen_space(pdf, ["Warm Red", "Black"], {
        "Warm Red": (0.0, 0.9, 0.8, 0.0), "Black": (0, 0, 0, 1.0),
    })
    page.Resources = Dictionary(ColorSpace=Dictionary(CS0=spot_cs, CS1=duo))
    page.Contents = pdf.make_stream(b"\n".join([
        b"1 0 0 0 k 10 340 80 50 re f",
        b"0 1 0 0 k 100 340 80 50 re f",
        b"0 0 1 0 k 190 340 80 50 re f",
        b"0 0 0 1 k 280 340 80 50 re f",
        b"0.9 0.85 0.85 0.8 k 10 270 350 50 re f",
        b"/CS0 cs 1 scn 10 200 160 50 re f",
        b"/CS0 cs 0.5 scn 190 200 160 50 re f",
        b"/CS1 cs 0.8 0.4 scn 10 130 350 50 re f",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def tac_ladder_pdf(path):
    """Five patches of KNOWN total ink: 0 / 100 / 200 / 300 / 340 %."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(500, 100))
    page.Resources = Dictionary()
    page.Contents = pdf.make_stream(b"\n".join([
        b"0 0 0 0 k 0 0 100 100 re f",
        b"0 0 0 1 k 100 0 100 100 re f",
        b"1 0 0 1 k 200 0 100 100 re f",
        b"1 1 0 1 k 300 0 100 100 re f",
        b"0.9 0.85 0.85 0.8 k 400 0 100 100 re f",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def overprint_pdf(path, opm: int):
    """Full-page yellow; a cyan bar overprinting on the left and knocking out
    on the right. With `OPM 0` a DeviceCMYK fill paints all four components,
    so even the overprinting bar knocks the yellow out."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 100))
    on = pdf.make_indirect(Dictionary(Type=Name.ExtGState, OP=True, op=True, OPM=opm))
    off = pdf.make_indirect(Dictionary(Type=Name.ExtGState, OP=False, op=False, OPM=opm))
    page.Resources = Dictionary(ExtGState=Dictionary(ON=on, OFF=off))
    page.Contents = pdf.make_stream(b"\n".join([
        b"0 0 1 0 k 0 0 200 100 re f",
        b"/ON gs 1 0 0 0 k 20 20 60 60 re f",
        b"/OFF gs 1 0 0 0 k 120 20 60 60 re f",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def many_spots_pdf(path, count: int):
    """`count` distinct Separation colorants, each painted once."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 40 + 16 * count))
    spaces, content = {}, []
    for i in range(count):
        spaces[f"S{i:02d}"] = separation_space(
            pdf, f"Spot{i:02d}", (i / count, 1 - i / count, 0.5, 0.0)
        )
        content.append(f"/S{i:02d} cs 1 scn 10 {10 + i * 16} 170 12 re f".encode())
    page.Resources = Dictionary(ColorSpace=Dictionary(**spaces))
    page.Contents = pdf.make_stream(b"\n".join(content))
    pdf.save(path)
    pdf.close()
    return str(path)


def two_spots_pdf(path, first: str, second: str, first_cmyk, second_cmyk,
                  first_exponent: float = 1.0, second_exponent: float = 1.0):
    """Two Separation colorants, each painted once. Give them the same
    alternate components and exponent for an alias that changes nothing;
    change either for one that does."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Resources = Dictionary(ColorSpace=Dictionary(
        A=separation_space(pdf, first, first_cmyk, first_exponent),
        B=separation_space(pdf, second, second_cmyk, second_exponent),
    ))
    page.Contents = pdf.make_stream(b"\n".join([
        b"/A cs 1 scn 10 110 180 80 re f",
        b"/B cs 1 scn 10 10 180 80 re f",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def spot_in_every_paint_pdf(path, spot: str = "Warm Red"):
    """One spot painted through a fill, a stroke, an image, a shading and a
    tiling pattern — the five routes a conversion has to reach."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 300))
    space = separation_space(pdf, spot, (0.0, 0.9, 0.8, 0.0))

    image = pikepdf.Stream(pdf, bytes([255, 128, 64, 0]))
    image.Type = Name.XObject
    image.Subtype = Name.Image
    image.Width = 2
    image.Height = 2
    image.BitsPerComponent = 8
    image.ColorSpace = space
    image_ref = pdf.make_indirect(image)

    shading = pdf.make_indirect(Dictionary(
        ShadingType=2, ColorSpace=space, Coords=Array([0, 0, 300, 0]),
        Function=Dictionary(FunctionType=2, Domain=Array([0, 1]), N=1,
                            C0=Array([0]), C1=Array([1])),
        Extend=Array([True, True]),
    ))

    tile = pikepdf.Stream(pdf, b"/TCS cs 0.6 scn 0 0 10 10 re f")
    tile.Type = Name.Pattern
    tile.PatternType = 1
    tile.PaintType = 1
    tile.TilingType = 1
    tile.BBox = Array([0, 0, 20, 20])
    tile.XStep = 20
    tile.YStep = 20
    tile.Resources = Dictionary(ColorSpace=Dictionary(TCS=space))
    pattern = pdf.make_indirect(tile)

    page.Resources = Dictionary(
        ColorSpace=Dictionary(CS0=space),
        XObject=Dictionary(Im0=image_ref),
        Shading=Dictionary(Sh0=shading),
        Pattern=Dictionary(P0=pattern),
    )
    page.Contents = pdf.make_stream(b"\n".join([
        b"/CS0 cs 1 scn 10 250 120 40 re f",
        b"/CS0 CS 0.5 SCN 4 w 150 250 m 290 250 l S",
        b"q 100 0 0 60 10 170 cm /Im0 Do Q",
        # `sh` paints the whole CLIP, so an unclipped one would cover the
        # page in the shading's edge colour and hide everything above it.
        b"q 10 110 200 40 re W n 200 0 0 40 10 110 cm /Sh0 sh Q",
        b"/Pattern cs /P0 scn 10 20 260 70 re f",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def inks_everywhere_pdf(path):
    """One spot per resource route: a page colour space, a nested Form
    XObject, an image, a shading, a tiling pattern, and an annotation
    appearance stream — plus `/All` and `/None`."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 300))

    inner = pikepdf.Stream(pdf, b"/FCS cs 1 scn 0 0 40 40 re f")
    inner.Type = Name.XObject
    inner.Subtype = Name.Form
    inner.BBox = Array([0, 0, 40, 40])
    inner.Resources = Dictionary(ColorSpace=Dictionary(
        FCS=separation_space(pdf, "FormSpot", (0.1, 0.2, 0.3, 0.0)),
    ))
    form = pdf.make_indirect(inner)

    image = pikepdf.Stream(pdf, bytes([200, 100, 50, 25]))
    image.Type = Name.XObject
    image.Subtype = Name.Image
    image.Width = 2
    image.Height = 2
    image.BitsPerComponent = 8
    image.ColorSpace = separation_space(pdf, "ImageSpot", (0.0, 0.4, 0.9, 0.0))
    image_ref = pdf.make_indirect(image)

    shading = pdf.make_indirect(Dictionary(
        ShadingType=2,
        ColorSpace=separation_space(pdf, "ShadingSpot", (0.5, 0.0, 0.5, 0.0)),
        Coords=Array([0, 0, 300, 300]),
        Function=Dictionary(FunctionType=2, Domain=Array([0, 1]), N=1,
                            C0=Array([0]), C1=Array([1])),
    ))

    tile = pikepdf.Stream(pdf, b"/PCS cs 1 scn 0 0 10 10 re f")
    tile.Type = Name.Pattern
    tile.PatternType = 1
    tile.PaintType = 1
    tile.TilingType = 1
    tile.BBox = Array([0, 0, 20, 20])
    tile.XStep = 20
    tile.YStep = 20
    tile.Resources = Dictionary(ColorSpace=Dictionary(
        PCS=separation_space(pdf, "PatternSpot", (0.2, 0.2, 0.2, 0.0)),
    ))
    pattern = pdf.make_indirect(tile)

    page.Resources = Dictionary(
        ColorSpace=Dictionary(
            CS0=separation_space(pdf, "PageSpot", (0.0, 1.0, 0.75, 0.0)),
            ALL=separation_space(pdf, "All", (1.0, 1.0, 1.0, 1.0)),
            NONE=separation_space(pdf, "None", (0, 0, 0, 0)),
        ),
        XObject=Dictionary(Fm0=form, Im0=image_ref),
        Shading=Dictionary(Sh0=shading),
        Pattern=Dictionary(P0=pattern),
    )
    page.Contents = pdf.make_stream(b"\n".join([
        b"/CS0 cs 1 scn 10 250 80 30 re f",
        b"/ALL cs 1 scn 100 250 30 30 re f",
        b"/NONE cs 1 scn 140 250 30 30 re f",
        b"q 1 0 0 1 10 200 cm /Fm0 Do Q",
        b"q 60 0 0 60 10 120 cm /Im0 Do Q",
        b"q 120 120 100 60 re W n 100 0 0 60 120 120 cm /Sh0 sh Q",
        b"/Pattern cs /P0 scn 10 20 200 60 re f",
    ]))

    appearance = pikepdf.Stream(pdf, b"/ACS cs 1 scn 0 0 30 20 re f")
    appearance.Type = Name.XObject
    appearance.Subtype = Name.Form
    appearance.BBox = Array([0, 0, 30, 20])
    appearance.Resources = Dictionary(ColorSpace=Dictionary(
        ACS=separation_space(pdf, "AnnotSpot", (0.9, 0.1, 0.0, 0.0)),
    ))
    annot = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Square, Rect=Array([240, 240, 270, 260]),
        F=4, AP=Dictionary(N=pdf.make_indirect(appearance)),
    ))
    page.Annots = Array([annot])

    pdf.save(path)
    pdf.close()
    return str(path)
