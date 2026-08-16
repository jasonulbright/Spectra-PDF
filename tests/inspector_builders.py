"""Fixtures for the point inspector.

The page is built object by object at KNOWN coordinates in KNOWN colour
spaces, because every wrong answer this feature can give is plausible: an
eyeball cannot tell a readout that named the object under the pointer from one
that named its neighbour. The geometry constants below are the oracle the
assertions read, so a fixture edit that moved a rectangle would move the
expectations with it rather than silently invalidating them.

One placement is load-bearing beyond its own row. The diagonal stroke's
bounding box covers a large triangle the line itself never enters, so a point
inside that box and far from the line is where a box-only hit test names an
object the page paints nothing of.
"""

import pikepdf
from pikepdf import Array, Dictionary, Name, Stream

#: The page's own size, in points. Square so a quarter turn is visible in the
#: content's position rather than only in the frame's extents.
PAGE = (400.0, 400.0)

#: The process-colour rectangle: x, y, width, height.
CMYK_RECT = (50.0, 300.0, 100.0, 50.0)
#: Its authored components, in the order `k` takes them.
CMYK_COMPONENTS = (0.2, 0.4, 0.9, 0.0)

#: The spot rectangle, painted at full tint through its own colorant.
SPOT_RECT = (200.0, 300.0, 100.0, 50.0)
SPOT_NAME = "PANTONE 185 C"

#: The process rectangle's overlap: authored in DeviceRGB and drawn AFTER it,
#: so the topmost object's own colour and the ink on the sheet disagree here.
RGB_RECT = (90.0, 310.0, 40.0, 20.0)

#: The image: 8x8 samples placed over 100x100 pt, so its effective resolution
#: is 8 * 72 / 100 on both axes.
IMAGE_PIXELS = 8
IMAGE_PLACEMENT = (100.0, 0.0, 0.0, 100.0, 50.0, 50.0)

#: The stroke, and the width that decides how far its box reaches past it.
STROKE_FROM = (200.0, 50.0)
STROKE_TO = (350.0, 200.0)
STROKE_WIDTH = 4.0

#: A tint transform that carries the colorant into its alternate space. The
#: separation device gives a colorant it can plate its own plate and ignores
#: this, so the function decides nothing the plate assertions read — it exists
#: because the space is malformed without one.
_TINT = b"{ dup 0.0 mul exch dup 0.75 mul exch dup 0.9 mul exch 0.0 mul }"


def _separation_space(pdf):
    tint = Stream(pdf, _TINT)
    tint.FunctionType = 4
    tint.Domain = [0.0, 1.0]
    tint.Range = [0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0]
    return Array([Name.Separation, Name("/" + SPOT_NAME), Name.DeviceCMYK, tint])


def _image(pdf):
    samples = bytes([255, 128, 0]) * (IMAGE_PIXELS * IMAGE_PIXELS)
    image = Stream(pdf, samples)
    image.Type = Name.XObject
    image.Subtype = Name.Image
    image.Width = IMAGE_PIXELS
    image.Height = IMAGE_PIXELS
    image.ColorSpace = Name.DeviceRGB
    image.BitsPerComponent = 8
    return image


def _content() -> bytes:
    return b"\n".join([
        b"q %g %g %g %g k %g %g %g %g re f Q" % (CMYK_COMPONENTS + CMYK_RECT),
        b"q /Cs1 cs 1.0 scn %g %g %g %g re f Q" % SPOT_RECT,
        b"q 1 0 0 rg %g %g %g %g re f Q" % RGB_RECT,
        b"q %g %g %g %g %g %g cm /Im1 Do Q" % IMAGE_PLACEMENT,
        b"q 0 G %g w %g %g m %g %g l S Q"
        % ((STROKE_WIDTH,) + STROKE_FROM + STROKE_TO),
    ])


def inspector_page_pdf(path, rotate: int = 0, crop=None):
    """The oracle page: five objects, five colour spaces, known coordinates.

    `rotate` and `crop` leave the content and its user-space coordinates
    untouched and change only how the page is framed and turned — which is the
    point of exercising them, since user space is what the inspector is handed
    and a frame that leaked into it would move every answer.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=PAGE)
    page.Resources = Dictionary(
        XObject=Dictionary(Im1=_image(pdf)),
        ColorSpace=Dictionary(Cs1=_separation_space(pdf)),
    )
    page.Contents = pdf.make_stream(_content())
    if rotate:
        page.obj[Name("/Rotate")] = int(rotate)
    if crop is not None:
        page.obj[Name("/CropBox")] = Array([float(v) for v in crop])
    pdf.save(path)
    pdf.close()
    return str(path)


def unreadable_content_pdf(path):
    """A page whose content stream will not decode.

    The stream declares a filter its bytes are not encoded with, which is the
    shape a truncated or mis-declared producer leaves behind: the page has
    content, and nothing on it can be identified.
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=PAGE)
    page.Resources = Dictionary()
    stream = Stream(pdf, b"\xff\xfe these bytes are not encoded \x00\x01")
    stream.Filter = Name.FlateDecode
    page.obj[Name("/Contents")] = pdf.make_indirect(stream)
    pdf.save(path)
    pdf.close()
    return str(path)


def form_stack_pdf(path):
    """Two painted rectangles inside ONE form XObject, overlapping.

    A form isolates whole, so a point both rectangles cover is the case the
    raster cannot resolve on its own and the readout has to say so.
    """
    pdf = pikepdf.new()
    form = Stream(pdf, b"\n".join([
        b"q 0 0 1 0 k 100 100 200 200 re f Q",
        b"q 0 1 0 0 k 150 150 100 100 re f Q",
    ]))
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = Array([0.0, 0.0, 400.0, 400.0])
    form.Resources = Dictionary()
    page = pdf.add_blank_page(page_size=PAGE)
    page.Resources = Dictionary(XObject=Dictionary(Fm1=form))
    page.Contents = pdf.make_stream(b"q /Fm1 Do Q")
    pdf.save(path)
    pdf.close()
    return str(path)
