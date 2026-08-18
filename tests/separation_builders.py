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


def unreadable_colorspace_table_pdf(path, spot: str = "PANTONE 185 C",
                                    pages: int = 1, broken_on: int = 1):
    """`pages` pages painting one readable spot; `broken_on` also carries a
    Form XObject whose `/ColorSpace` table is a number.

    The readable spot is what makes the case bite. The inventory still returns
    an ink list and the preview still rasters, so the failure this guards is
    not a crash — it is the branch that will not enumerate being rendered as
    "no further inks", which is exactly where a second spot would hide.
    """
    pdf = pikepdf.new()
    for number in range(1, int(pages) + 1):
        page = pdf.add_blank_page(page_size=(300, 300))
        resources = Dictionary(ColorSpace=Dictionary(
            CS0=separation_space(pdf, spot, (0.0, 1.0, 0.75, 0.0)),
        ))
        body = [b"/CS0 cs 1 scn 10 250 80 30 re f"]
        if number == int(broken_on):
            form = pikepdf.Stream(pdf, b"0 0 40 40 re f")
            form.Type = Name.XObject
            form.Subtype = Name.Form
            form.BBox = Array([0, 0, 40, 40])
            form.Resources = Dictionary(ColorSpace=17)
            resources[Name("/XObject")] = Dictionary(Fm0=pdf.make_indirect(form))
            body.append(b"q 1 0 0 1 10 100 cm /Fm0 Do Q")
        page.Resources = resources
        page.Contents = pdf.make_stream(b"\n".join(body))
    pdf.save(path)
    pdf.close()
    return str(path)


def rgb_alternate_spot_pdf(path, spot: str = "RGB Spot"):
    """A spot whose alternate space is DeviceRGB.

    A device space carries no ICC description, so a proof of this colorant
    has to assume a source profile. The fixture exists so the assumption is
    stated back rather than taken silently.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    fn = pdf.make_indirect(Dictionary(
        FunctionType=2, Domain=Array([0, 1]), N=1,
        C0=Array([1, 1, 1]), C1=Array([0.9, 0.1, 0.15]),
        Range=Array([0, 1, 0, 1, 0, 1]),
    ))
    space = pdf.make_indirect(Array([
        Name.Separation, Name("/" + spot), Name.DeviceRGB, fn,
    ]))
    page.Resources = Dictionary(ColorSpace=Dictionary(CS0=space))
    page.Contents = pdf.make_stream(b"\n".join([
        b"0 0 0 1 k 10 10 60 60 re f",
        b"/CS0 cs 1 scn 100 10 60 60 re f",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def nested_separation_spot_pdf(path, spot: str = "Nested Spot",
                               inner: str = "Inner Spot"):
    """A spot whose alternate is itself a /Separation.

    There is no space a colour engine could describe the result in, so the
    proof refuses it by name instead of rendering one colorant through a
    different model from its neighbours.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    inner_space = separation_space(pdf, inner, (0.0, 1.0, 0.75, 0.0))
    fn = pdf.make_indirect(Dictionary(
        FunctionType=2, Domain=Array([0, 1]), N=1,
        C0=Array([0]), C1=Array([1]), Range=Array([0, 1]),
    ))
    space = pdf.make_indirect(Array([
        Name.Separation, Name("/" + spot), inner_space, fn,
    ]))
    page.Resources = Dictionary(ColorSpace=Dictionary(CS0=space))
    page.Contents = pdf.make_stream(b"\n".join([
        b"0 0 0 1 k 10 10 60 60 re f",
        b"/CS0 cs 1 scn 100 10 60 60 re f",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


#: The cropped fixture's geometry, in points. The MediaBox is letter; the
#: CropBox is a 300x200 window whose lower-left corner is (100, 500). One bar
#: sits wholly inside that window and one wholly outside it, so a raster of
#: the wrong box differs in its dimensions, in where the inside bar lands, and
#: in what fraction of the page that bar covers.
CROPPED_MEDIA = (612.0, 792.0)
CROPPED_BOX = (100.0, 500.0, 400.0, 700.0)
CROPPED_INSIDE = (150.0, 600.0, 100.0, 50.0)
CROPPED_OUTSIDE = (20.0, 20.0, 100.0, 50.0)


def cropped_page_pdf(path, rotate: int = 0, rgb: bool = False):
    """A page whose CropBox is a window on a larger MediaBox.

    One bar paints inside the window and one outside it. The window is both
    the frame the viewer shows and a clip on the page's content, so the plates
    that describe this page carry the inside bar at a known place and carry
    nothing at all from the outside one.

    `rgb` paints both bars through DeviceRGB instead, which is the page that
    has to be colour-managed before it is separated: the frame then has to
    survive a staged intermediate as well as the device.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=CROPPED_MEDIA)
    page.Resources = Dictionary()
    page.obj[Name("/CropBox")] = Array(list(CROPPED_BOX))
    if rotate:
        page.obj[Name("/Rotate")] = int(rotate)
    inside, outside = (
        (b"0 0 1 rg", b"0 1 0 rg") if rgb else (b"1 0 0 0 k", b"0 1 0 0 k")
    )
    page.Contents = pdf.make_stream(b"\n".join([
        inside + b" %g %g %g %g re f" % CROPPED_INSIDE,
        outside + b" %g %g %g %g re f" % CROPPED_OUTSIDE,
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def device_rgb_pdf(path):
    """A page painted only through inline DeviceRGB operators.

    It declares no colour space at all: the resource walk alone reports it as
    carrying no colour, which is exactly the page whose plates came from
    Ghostscript's compiled-in default rather than from any chosen press.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Resources = Dictionary()
    page.Contents = pdf.make_stream(
        b"1 0 0 rg 10 10 100 100 re f\n0 0 1 rg 50 50 40 40 re f"
    )
    pdf.save(path)
    pdf.close()
    return str(path)


def spot_shading_pdf(path, spot: str = "PANTONE 185 C",
                     pattern_spot: str = "PatternSpot"):
    """Every route a GRADIENT takes into a colour conversion, on one page.

    A colorant `sh`, a colorant shading worn by a shading pattern, a
    DeviceCMYK `sh` beside them (the control that says whether a loss is
    about colorants or about shadings), a DeviceN duotone fill and a DeviceRGB
    fill that must come out CMYK. The shading coordinates are USER space and
    no `cm` intervenes, so each ramp spans the band it paints — a gradient
    running off the page would lay down no ink and make "the plate is
    unchanged" mean nothing.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    spot_cs = separation_space(pdf, spot, (0.0, 1.0, 0.75, 0.0))
    duo = devicen_space(pdf, ["Warm Red", "Deep Black"], {
        "Warm Red": (0.0, 0.9, 0.8, 0.0), "Deep Black": (0, 0, 0, 1.0),
    })
    ramp = Dictionary(FunctionType=2, Domain=Array([0, 1]), N=1,
                      C0=Array([0.2]), C1=Array([1]))
    spot_sh = pdf.make_indirect(Dictionary(
        ShadingType=2, ColorSpace=spot_cs, Coords=Array([10, 0, 390, 0]),
        Function=ramp, Extend=Array([True, True])))
    cmyk_sh = pdf.make_indirect(Dictionary(
        ShadingType=2, ColorSpace=Name.DeviceCMYK, Coords=Array([10, 0, 390, 0]),
        Function=Dictionary(FunctionType=2, Domain=Array([0, 1]), N=1,
                            C0=Array([0, 0, 0, 0]), C1=Array([0, 1, 1, 0])),
        Extend=Array([True, True])))
    pattern_cs = separation_space(pdf, pattern_spot, (0.0, 0.5, 1.0, 0.0))
    pattern = pdf.make_indirect(Dictionary(
        Type=Name.Pattern, PatternType=2,
        Shading=Dictionary(
            ShadingType=2, ColorSpace=pattern_cs, Coords=Array([10, 0, 390, 0]),
            Function=ramp, Extend=Array([True, True]))))
    page.Resources = Dictionary(
        ColorSpace=Dictionary(CS0=spot_cs, CS1=duo),
        Pattern=Dictionary(P0=pattern),
        Shading=Dictionary(ShSpot=spot_sh, ShCmyk=cmyk_sh))
    page.Contents = pdf.make_stream(b"\n".join([
        b"/CS0 cs 1 scn 10 340 180 50 re f",
        b"/CS1 cs 0.8 0.4 scn 210 340 180 50 re f",
        b"1 0 0 rg 10 270 180 50 re f",
        b"0 0 0 1 k 210 270 180 50 re f",
        b"q 10 190 380 60 re W n /ShSpot sh Q",
        b"q 10 110 380 60 re W n /ShCmyk sh Q",
        b"/Pattern cs /P0 scn 120 20 270 30 re f",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def _direct_separation_space(ink: str, alternate_cmyk):
    """`separation_space` with nothing made indirect.

    A shading built out of direct objects serialises whole, so a byte compare
    of it reads a content change rather than a renumbering.
    """
    return Array([Name.Separation, Name("/" + ink), Name.DeviceCMYK, Dictionary(
        FunctionType=2, Domain=Array([0, 1]), N=1,
        C0=Array([0, 0, 0, 0]), C1=Array(list(alternate_cmyk)),
        Range=Array([0, 1, 0, 1, 0, 1, 0, 1]),
    )])


def unconvertible_shading_pdf(path, spot: str = "Warm Red"):
    """One colorant painted by three gradients: one the tint transform composes
    onto, one function-based, and one carrying a `/Background`.

    The function-based shading's own function takes ONE input, so a composition
    driven by that input SUCCEEDS and yields colour the shading does not have —
    the wrongness the guard exists to stop. A function the composition could
    not evaluate would be left alone for a different reason and would prove
    nothing about the guard.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    space = separation_space(pdf, spot, (0.0, 0.9, 0.8, 0.0))

    convertible = pdf.make_indirect(Dictionary(
        ShadingType=2, ColorSpace=space, Coords=Array([10, 0, 390, 0]),
        Function=Dictionary(FunctionType=2, Domain=Array([0, 1]), N=1,
                            C0=Array([0.2]), C1=Array([1]), Range=Array([0, 1])),
        Extend=Array([True, True])))
    planar = Dictionary(
        ShadingType=1, ColorSpace=_direct_separation_space(spot, (0.0, 0.9, 0.8, 0.0)),
        Domain=Array([0, 1, 0, 1]),
        Function=Dictionary(FunctionType=2, Domain=Array([0, 1, 0, 1]), N=1,
                            C0=Array([0.1]), C1=Array([1]), Range=Array([0, 1])))
    background = Dictionary(
        ShadingType=2, ColorSpace=_direct_separation_space(spot, (0.0, 0.9, 0.8, 0.0)),
        Coords=Array([10, 0, 390, 0]), Background=Array([0.4]),
        Function=Dictionary(FunctionType=2, Domain=Array([0, 1]), N=1,
                            C0=Array([0.2]), C1=Array([1]), Range=Array([0, 1])),
        Extend=Array([False, False]))

    page.Resources = Dictionary(
        ColorSpace=Dictionary(CS0=space),
        Shading=Dictionary(ShOk=convertible, ShPlanar=planar, ShBg=background))
    page.Contents = pdf.make_stream(b"\n".join([
        b"/CS0 cs 1 scn 10 340 380 50 re f",
        b"q 10 250 380 60 re W n /ShOk sh Q",
        b"q 10 160 380 60 re W n /ShPlanar sh Q",
        b"q 10 70 380 60 re W n /ShBg sh Q",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)


def _appearance_stream(pdf, space, rect):
    """A form XObject painting a colorant gradient across its whole BBox."""
    width, height = rect[2] - rect[0], rect[3] - rect[1]
    shading = pdf.make_indirect(Dictionary(
        ShadingType=2, ColorSpace=space, Coords=Array([0, 0, width, 0]),
        Function=Dictionary(FunctionType=2, Domain=Array([0, 1]), N=1,
                            C0=Array([0.2]), C1=Array([1])),
        Extend=Array([True, True])))
    stream = pikepdf.Stream(
        pdf, f"q 0 0 {width} {height} re W n /Sh sh Q".encode("ascii"))
    stream.Type = Name.XObject
    stream.Subtype = Name.Form
    stream.BBox = Array([0, 0, width, height])
    stream.Resources = Dictionary(Shading=Dictionary(Sh=shading))
    return pdf.make_indirect(stream)


#: Each appearance gets its OWN alternate: identical staged shadings merge into
#: one object in the producer's output, where only the first can be put back
#: (the swap's documented guard), and the fixture would then measure the merge.
APPEARANCE_GRADIENTS = {
    "Stamp Gradient": (0.0, 1.0, 0.75, 0.0),
    "Hidden Gradient": (0.0, 0.4, 1.0, 0.0),
    "NoView Gradient": (1.0, 0.0, 0.3, 0.0),
    "NoPrint Gradient": (0.2, 0.0, 1.0, 0.1),
    "Rollover Gradient": (0.3, 1.0, 0.0, 0.0),
    "Down Gradient": (0.6, 0.0, 0.9, 0.0),
    "Widget Gradient": (0.0, 0.7, 0.2, 0.0),
}

#: ISO 32000-2 12.5.3 annotation flags, by bit position.
ANNOT_PRINT = 4
ANNOT_HIDDEN = 2
ANNOT_NOVIEW = 32


def appearance_shading_pdf(path):
    """Colorant gradients that live only in annotation APPEARANCE streams.

    A printable stamp (the plain case), the same thing behind each flag
    setting whose rendering differs — Hidden, NoView, no Print — a stamp
    carrying `/N`, `/R` and `/D`, and a form field whose widget appearance the
    conversion reattaches from the original instead of converting. The page
    itself paints a DeviceRGB rectangle, the control that says the conversion
    ran at all.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 460))
    page.Resources = Dictionary()
    page.Contents = pdf.make_stream(b"1 0 0 rg 10 10 380 30 re f")

    def stamp(ink, flags, rect, faces=None):
        space = separation_space(pdf, ink, APPEARANCE_GRADIENTS[ink])
        appearance = Dictionary(N=_appearance_stream(pdf, space, rect))
        for face, face_ink in (faces or {}).items():
            appearance[face] = _appearance_stream(
                pdf, separation_space(pdf, face_ink,
                                      APPEARANCE_GRADIENTS[face_ink]), rect)
        return pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Stamp, Rect=Array(list(rect)),
            F=flags, T=ink, AP=appearance))

    annots = [
        stamp("Stamp Gradient", ANNOT_PRINT, (10, 400, 390, 450)),
        stamp("Hidden Gradient", ANNOT_HIDDEN | ANNOT_PRINT, (10, 340, 390, 390)),
        stamp("NoView Gradient", ANNOT_NOVIEW | ANNOT_PRINT, (10, 280, 390, 330)),
        stamp("NoPrint Gradient", 0, (10, 220, 390, 270)),
        stamp("Rollover Gradient", ANNOT_PRINT, (10, 160, 390, 210),
              faces={"/D": "Down Gradient"}),
    ]
    widget_rect = (10, 100, 390, 150)
    widget = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx,
        Rect=Array(list(widget_rect)), F=ANNOT_PRINT, T="field1", V="",
        DA="/Helv 0 Tf 0 g",
        AP=Dictionary(N=_appearance_stream(
            pdf, separation_space(pdf, "Widget Gradient",
                                  APPEARANCE_GRADIENTS["Widget Gradient"]),
            widget_rect))))
    annots.append(widget)
    pdf.Root.AcroForm = pdf.make_indirect(Dictionary(
        Fields=Array([widget]), DA="/Helv 0 Tf 0 g", DR=Dictionary()))
    page.Annots = Array(annots)
    pdf.save(path)
    pdf.close()
    return str(path)


def dropped_annotation_shading_pdf(path, spot: str = "Mark Gradient"):
    """A `/PrinterMark` whose appearance paints a colorant gradient.

    The producer does not carry this annotation into its output at all — it
    flattens the appearance into the page content it came from — so the plate
    survives or dies at the page tier, on the strength of the bracket the
    appearance was staged with.
    """
    rect = (10, 300, 190, 350)
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    page.Resources = Dictionary()
    page.Contents = pdf.make_stream(b"1 0 0 rg 10 10 180 20 re f")
    page.Annots = Array([pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.PrinterMark, Rect=Array(list(rect)),
        F=ANNOT_PRINT, T=spot,
        AP=Dictionary(N=_appearance_stream(
            pdf, separation_space(pdf, spot, (0.0, 1.0, 0.75, 0.0)), rect))))])
    pdf.save(path)
    pdf.close()
    return str(path)


#: The stamp rectangle every `appearance_pattern_pdf` variant uses.
APPEARANCE_RECT = (10, 300, 390, 350)


def appearance_pattern_pdf(path, kind: str):
    """A stamp appearance that paints through a pattern, in process colour.

    Nothing here is in a colorant space, so a colour conversion has nothing to
    carry and nothing to lose: what these measure is the appearance's own
    coordinate space, which a pattern matrix is stated in (ISO 32000-2 8.7.2).

    ``shading`` a DeviceCMYK gradient, ``tiling`` a DeviceCMYK tile, ``skewed``
    a gradient under a non-uniform BBox-to-Rect map and an internal `cm` (so
    the appearance's space, the page's and the paint's are three different
    spaces), and ``plain`` a flat fill that uses no pattern at all.
    """
    rect = APPEARANCE_RECT
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    page.Resources = Dictionary()
    page.Contents = pdf.make_stream(b"1 0 0 rg 10 10 380 20 re f")
    width, height = rect[2] - rect[0], rect[3] - rect[1]

    def gradient(span):
        return pdf.make_indirect(Dictionary(
            ShadingType=2, ColorSpace=Name.DeviceCMYK,
            Coords=Array([0, 0, span, 0]),
            Function=Dictionary(FunctionType=2, Domain=Array([0, 1]), N=1,
                                C0=Array([0, 0, 0, 0]),
                                C1=Array([0, 1, 0.75, 0])),
            Extend=Array([True, True])))

    if kind == "shading":
        body = f"q 0 0 {width} {height} re W n /Sh sh Q".encode("ascii")
        bbox, resources = (0, 0, width, height), Dictionary(
            Shading=Dictionary(Sh=gradient(width)))
    elif kind == "skewed":
        body = b"q 2 0 0 2 0 0 cm 0 0 50 50 re W n /Sh sh Q"
        bbox, resources = (0, 0, 100, 100), Dictionary(
            Shading=Dictionary(Sh=gradient(50)))
    elif kind == "tiling":
        cell = pikepdf.Stream(pdf, b"0 1 0.75 0 k 0 0 5 5 re f")
        cell.Type = Name.Pattern
        cell.PatternType = 1
        cell.PaintType = 1
        cell.TilingType = 1
        cell.BBox = Array([0, 0, 10, 10])
        cell.XStep = 10
        cell.YStep = 10
        cell.Resources = Dictionary()
        body = b"/Pattern cs /P0 scn 0 0 100 100 re f"
        bbox, resources = (0, 0, 100, 100), Dictionary(
            Pattern=Dictionary(P0=pdf.make_indirect(cell)))
    elif kind == "plain":
        body = f"0 1 0.75 0 k 0 0 {width} {height} re f".encode("ascii")
        bbox, resources = (0, 0, width, height), Dictionary()
    else:
        raise ValueError(f"unknown appearance kind: {kind}")

    ap = pikepdf.Stream(pdf, body)
    ap.Type = Name.XObject
    ap.Subtype = Name.Form
    ap.BBox = Array(list(bbox))
    ap.Resources = resources
    page.Annots = Array([pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Stamp, Rect=Array(list(rect)),
        F=ANNOT_PRINT, T=kind, AP=Dictionary(N=pdf.make_indirect(ap))))])
    pdf.save(path)
    pdf.close()
    return str(path)


#: The page's own paint in every `form_appearance_pdf`, and what a CMYK
#: conversion makes of it: the control that says the conversion ran.
FORM_PAGE_RGB = b"0 0 1 rg"
FORM_PAGE_CMYK = b"0.875 0.769 0 0 k"

#: The field appearance's own paints, and their converted operands. A flattened
#: copy of the appearance is found by looking for these in the PAGE content —
#: which is exactly where they used to be.
FORM_FILL_RGB = b"1 0 0 rg"
FORM_FILL_CMYK = b"0 0.996 1 0 k"
FORM_TEXT_RGB = b"0 1 0 rg"
FORM_TEXT_CMYK = b"0.624 0 1 0 k"

#: The `/D` and `/Off` faces of the `states` fixture, which the producer never
#: flattens because they are not the face `/AS` selects.
FORM_OFF_RGB = b"0 1 1 rg"
FORM_DOWN_RGB = b"1 0 1 rg"

FORM_FIELD_RECT = (20, 100, 280, 140)


def _form_face(pdf, body: bytes, bbox, font=None):
    stream = pikepdf.Stream(pdf, body)
    stream.Type = Name.XObject
    stream.Subtype = Name.Form
    stream.BBox = Array(list(bbox))
    stream.Resources = (Dictionary(Font=Dictionary(Helv=font)) if font is not None
                        else Dictionary())
    return pdf.make_indirect(stream)


def form_appearance_pdf(path, kind: str = "text"):
    """A form field whose appearance paints in DeviceRGB.

    The producer drops the widget and flattens its appearance into the page,
    and the field reattach puts the widget back — so a conversion that does not
    account for both paints the field twice, the second time in the colour it
    was told to convert away from.

    ``text`` one filled text field; ``states`` a checkbox carrying `/N` and
    `/D` state dictionaries, only one face of which the producer ever draws;
    ``bare`` a filled field with NO appearance, which the producer synthesizes
    one for; ``shared`` two widgets wearing one appearance stream.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 200))
    page.Resources = Dictionary()
    page.Contents = pdf.make_stream(FORM_PAGE_RGB + b" 10 10 280 20 re f")
    helv = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
        Encoding=Name.WinAnsiEncoding))

    def text_face(fill: bytes, text: bytes):
        return _form_face(pdf, (
            b"/Tx BMC q " + fill + b" 0 0 260 40 re f BT /Helv 12 Tf "
            + text + b" 2 14 Td (Hello) Tj ET Q EMC"), (0, 0, 260, 40), helv)

    if kind == "states":
        def box(fill: bytes):
            return _form_face(pdf, fill + b" 0 0 40 40 re f", (0, 0, 40, 40))

        widget = pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Widget, FT=Name.Btn,
            Rect=Array([20, 100, 60, 140]), F=4, T="check", V=Name("/On"),
            AS=Name("/On"),
            AP=Dictionary(
                N=Dictionary(On=box(FORM_FILL_RGB), Off=box(FORM_OFF_RGB)),
                D=Dictionary(On=box(FORM_DOWN_RGB), Off=box(FORM_TEXT_RGB)))))
        widgets = [widget]
    elif kind == "bare":
        widgets = [pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx,
            Rect=Array(list(FORM_FIELD_RECT)), F=4, T="bare", V="Hello",
            DA=pikepdf.String("/Helv 12 Tf 0 0 1 rg")))]
    elif kind == "shared":
        face = text_face(FORM_FILL_RGB, FORM_TEXT_RGB)
        widgets = [pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx,
            Rect=Array(list(rect)), F=4, T=name, V="Hello",
            DA=pikepdf.String("/Helv 12 Tf 0 1 0 rg"), AP=Dictionary(N=face)))
            for name, rect in (("first", FORM_FIELD_RECT),
                               ("second", (20, 50, 280, 90)))]
    elif kind == "text":
        widgets = [pdf.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx,
            Rect=Array(list(FORM_FIELD_RECT)), F=4, T="field1", V="Hello",
            DA=pikepdf.String("/Helv 12 Tf 0 1 0 rg"),
            AP=Dictionary(N=text_face(FORM_FILL_RGB, FORM_TEXT_RGB))))]
    else:
        raise ValueError(f"unknown form appearance kind: {kind}")

    page.Annots = Array(widgets)
    pdf.Root.AcroForm = pdf.make_indirect(Dictionary(
        Fields=Array(widgets), DA=pikepdf.String("/Helv 0 Tf 0 g"),
        DR=Dictionary(Font=Dictionary(Helv=helv))))
    pdf.save(path)
    pdf.close()
    return str(path)


def form_pattern_appearance_pdf(path):
    """A field whose appearance paints through a shading pattern.

    The gradient is DeviceCMYK, which the producer carries AS a gradient — a
    gradient it must colour-convert comes back a picture instead (the whole
    reason the colorant carve-out exists), and a picture measures nothing about
    coordinate space. What this measures is that a converted appearance stays
    anchored in the space the producer wrote its pattern matrix in (ISO 32000-2
    8.7.2), which is not the annotation rectangle's.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 200))
    page.Resources = Dictionary()
    page.Contents = pdf.make_stream(FORM_PAGE_RGB + b" 10 10 280 20 re f")
    shading = pdf.make_indirect(Dictionary(
        ShadingType=2, ColorSpace=Name.DeviceCMYK, Coords=Array([0, 0, 260, 0]),
        Function=Dictionary(FunctionType=2, Domain=Array([0, 1]), N=1,
                            C0=Array([0, 0, 0, 0]), C1=Array([0, 1, 0.75, 0])),
        Extend=Array([True, True])))
    face = pikepdf.Stream(pdf, b"q 0 0 260 40 re W n /Sh sh Q")
    face.Type = Name.XObject
    face.Subtype = Name.Form
    face.BBox = Array([0, 0, 260, 40])
    face.Resources = Dictionary(Shading=Dictionary(Sh=shading))
    widget = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx,
        Rect=Array(list(FORM_FIELD_RECT)), F=4, T="patterned", V="",
        DA=pikepdf.String("/Helv 0 Tf 0 g"),
        AP=Dictionary(N=pdf.make_indirect(face))))
    page.Annots = Array([widget])
    pdf.Root.AcroForm = pdf.make_indirect(Dictionary(
        Fields=Array([widget]), DA=pikepdf.String("/Helv 0 Tf 0 g"),
        DR=Dictionary()))
    pdf.save(path)
    pdf.close()
    return str(path)


def rgb_alternate_appearance_pdf(path, spot: str = "RGB Appearance Spot"):
    """A stamp appearance whose gradient is in a spot with a DeviceRGB
    alternate — the appearance-tier twin of `rgb_alternate_shading_pdf`, the
    branch that must go through the producer and REPORT the loss."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.Resources = Dictionary()
    page.Contents = pdf.make_stream(b"1 0 0 rg 10 10 180 20 re f")
    fn = pdf.make_indirect(Dictionary(
        FunctionType=2, Domain=Array([0, 1]), N=1,
        C0=Array([1, 1, 1]), C1=Array([0.9, 0.1, 0.15]),
        Range=Array([0, 1, 0, 1, 0, 1])))
    space = pdf.make_indirect(Array([
        Name.Separation, Name("/" + spot), Name.DeviceRGB, fn]))
    rect = (10, 100, 190, 160)
    page.Annots = Array([pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Stamp, Rect=Array(list(rect)),
        F=ANNOT_PRINT, T=spot,
        AP=Dictionary(N=_appearance_stream(pdf, space, rect))))])
    pdf.save(path)
    pdf.close()
    return str(path)


def rgb_alternate_shading_pdf(path, spot: str = "RGB Spot"):
    """A GRADIENT in a spot whose alternate is DeviceRGB.

    The colorant cannot be described in a CMYK destination without running
    the transform, so this is the shading a conversion genuinely has to
    convert — the branch that must report a loss rather than hide one.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    fn = pdf.make_indirect(Dictionary(
        FunctionType=2, Domain=Array([0, 1]), N=1,
        C0=Array([1, 1, 1]), C1=Array([0.9, 0.1, 0.15]),
        Range=Array([0, 1, 0, 1, 0, 1]),
    ))
    space = pdf.make_indirect(Array([
        Name.Separation, Name("/" + spot), Name.DeviceRGB, fn,
    ]))
    shading = pdf.make_indirect(Dictionary(
        ShadingType=2, ColorSpace=space, Coords=Array([10, 0, 190, 0]),
        Function=Dictionary(FunctionType=2, Domain=Array([0, 1]), N=1,
                            C0=Array([0.2]), C1=Array([1])),
        Extend=Array([True, True])))
    page.Resources = Dictionary(Shading=Dictionary(ShRgb=shading))
    page.Contents = pdf.make_stream(
        b"q 10 40 180 120 re W n /ShRgb sh Q")
    pdf.save(path)
    pdf.close()
    return str(path)
