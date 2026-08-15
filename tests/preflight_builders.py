"""Documents that fail exactly one preflight check, and the twins that must not.

Built rather than checked in, on the `hairline_builders` / `separation_builders`
precedent: these are small pikepdf documents whose contents are known before
anything runs, so a failure is a defect in the code under test rather than a
question about an artifact nobody can read.

Every check is pinned TWICE — once on a document that fails it and once on a
document that must not. The second half is the one that keeps the checker from
crying wolf, and a false failure on a conforming press file is the failure mode
this whole inventory would be turned off over.
"""

from __future__ import annotations

import os
import zlib

import pikepdf
from pikepdf import Array, Dictionary, Name, String

LETTER = (612, 792)

#: A stand-in font program. Nothing decodes it: the checks read whether a
#: `/FontFile*` is PRESENT, never what is in one.
_PROGRAM = b"\x00\x01\x02\x03"


def _stream_font(doc, base: str) -> pikepdf.Object:
    program = doc.make_stream(_PROGRAM)
    program["/Length1"] = len(_PROGRAM)
    descriptor = doc.make_indirect(Dictionary(
        Type=Name.FontDescriptor, FontName=Name(f"/{base}"), Flags=32,
        FontFile2=program,
    ))
    return doc.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.TrueType, BaseFont=Name(f"/{base}"),
        FontDescriptor=descriptor,
    ))


def embedded_font(doc):
    """A subset-embedded face — the six-letter tag is what marks it a subset."""
    return _stream_font(doc, "ABCDEF+Emb")


def full_font(doc):
    """Embedded, but the WHOLE face: no subset tag."""
    return _stream_font(doc, "FullFace")


def nonembedded_font(doc):
    descriptor = doc.make_indirect(Dictionary(
        Type=Name.FontDescriptor, FontName=Name.Helvetica, Flags=32,
    ))
    return doc.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
        FontDescriptor=descriptor,
    ))


def standard_font(doc):
    """A base-14 face with no descriptor at all — what the text walk needs to
    resolve widths, and what a viewer draws without embedding anything."""
    return doc.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
        Encoding=Name.WinAnsiEncoding,
    ))


def type3_font(doc):
    glyph = doc.make_stream(b"10 0 0 0 10 10 d0 0 0 10 10 re f")
    return doc.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type3,
        FontBBox=Array([0, 0, 10, 10]), FontMatrix=Array([0.001, 0, 0, 0.001, 0, 0]),
        CharProcs=Dictionary(a=glyph), Encoding=Dictionary(
            Type=Name.Encoding, Differences=Array([97, Name("/a")])
        ),
        FirstChar=97, LastChar=97, Widths=Array([10]),
    ))


def image(doc, width: int, height: int, *, bpc: int = 8,
          colorspace=Name.DeviceCMYK, components: int = 4,
          filter_name=None):
    """A raster XObject. The pixels are zeros — every image check reads the
    dictionary, never the samples."""
    raw = b"\x00" * (width * height * components * bpc // 8 or 1)
    stream = doc.make_stream(zlib.compress(raw))
    stream["/Type"] = Name.XObject
    stream["/Subtype"] = Name.Image
    stream["/Width"] = width
    stream["/Height"] = height
    stream["/BitsPerComponent"] = bpc
    stream["/ColorSpace"] = colorspace
    stream["/Filter"] = filter_name if filter_name is not None else Name.FlateDecode
    return doc.make_indirect(stream)


def separation(doc, name: str, alternate=Name.DeviceCMYK, components: int = 4):
    """One `/Separation` colorant with a workable tint transform."""
    function = doc.make_indirect(Dictionary(
        FunctionType=2, Domain=Array([0, 1]), N=1,
        C0=Array([0] * components), C1=Array([1] * components),
    ))
    return doc.make_indirect(
        Array([Name.Separation, Name(f"/{name}"), alternate, function])
    )


def add_page(doc, resources, content: bytes, size=LETTER, boxes=None):
    page = doc.add_blank_page(page_size=size)
    page.Resources = resources
    page.Contents = doc.make_stream(content)
    for key, value in (boxes or {}).items():
        page.obj[Name(key)] = Array(value)
    return page


def _base_resources(doc):
    return Dictionary(
        Font=Dictionary(F1=embedded_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceCMYK),
    )


def _full_boxes(size=LETTER, bleed: float = 18.0):
    w, h = size
    return {
        "/TrimBox": [bleed, bleed, w - bleed, h - bleed],
        "/BleedBox": [0, 0, w, h],
    }


def _set_title(doc, title: str = "Preflight fixture") -> None:
    with doc.open_metadata(set_pikepdf_as_editor=False) as meta:
        meta["dc:title"] = title
    doc.docinfo[Name.Title] = String(title)


# ── the builders ──────────────────────────────────────────────────────────


def _baseline(doc) -> None:
    add_page(doc, _base_resources(doc), b"/CS0 cs 0.1 0.1 0.1 0.1 scn 0 0 10 10 re f",
             boxes=_full_boxes())


def _version_too_new(doc) -> None:
    _baseline(doc)


def _print_denied(doc) -> None:
    _baseline(doc)


def _no_output_intent(doc) -> None:
    _baseline(doc)


def _with_output_intent(doc, identifier="CGATS TR 001", embedded=True) -> None:
    _baseline(doc)
    intent = Dictionary(
        Type=Name.OutputIntent, S=Name("/GTS_PDFX"),
        OutputConditionIdentifier=String(identifier),
        OutputCondition=String(identifier),
    )
    if embedded:
        profile = doc.make_stream(b"acsp-stand-in")
        profile["/N"] = 4
        intent["/DestOutputProfile"] = profile
    doc.Root["/OutputIntents"] = Array([doc.make_indirect(intent)])


def _wrong_pdfx_claim(doc) -> None:
    _with_output_intent(doc)
    doc.docinfo[Name("/GTS_PDFXVersion")] = String("PDF/X-4")


def _right_pdfx_claim(doc) -> None:
    _with_output_intent(doc)
    doc.docinfo[Name("/GTS_PDFXVersion")] = String("PDF/X-1a:2001")


def _trapped_absent(doc) -> None:
    _baseline(doc)


def _trapped_declared(doc) -> None:
    _baseline(doc)
    doc.docinfo[Name("/Trapped")] = Name("/False")


def _gray_content(doc) -> None:
    """One plate only — nothing a second plate would be needed for."""
    add_page(doc, Dictionary(
        Font=Dictionary(F1=embedded_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceGray),
    ), b"/CS0 cs 0.5 scn 0 0 10 10 re f", boxes=_full_boxes())


def _has_attachment(doc) -> None:
    _baseline(doc)
    spec = pikepdf.AttachedFileSpec(doc, b"payload", mime_type="text/plain")
    doc.attachments["note.txt"] = spec


def _mixed_page_sizes(doc) -> None:
    _baseline(doc)
    add_page(doc, _base_resources(doc), b"", size=(842, 1191), boxes=_full_boxes((842, 1191)))


def _wrong_page_size(doc) -> None:
    add_page(doc, _base_resources(doc), b"", size=(595, 842),
             boxes=_full_boxes((595, 842)))


def _no_trim_box(doc) -> None:
    add_page(doc, _base_resources(doc), b"")


def _trim_equals_media(doc) -> None:
    """A document whose TrimBox equals its MediaBox HAS a trim box. It has no
    bleed, which is a different row."""
    w, h = LETTER
    add_page(doc, _base_resources(doc), b"",
             boxes={"/TrimBox": [0, 0, w, h]})


def _bleed_too_small(doc) -> None:
    w, h = LETTER
    add_page(doc, _base_resources(doc), b"", boxes={
        "/TrimBox": [2, 2, w - 2, h - 2], "/BleedBox": [0, 0, w, h],
    })


def _page_count_odd(doc) -> None:
    for _ in range(3):
        add_page(doc, _base_resources(doc), b"", boxes=_full_boxes())


def _rgb_content(doc) -> None:
    add_page(doc, Dictionary(
        Font=Dictionary(F1=embedded_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceRGB),
    ), b"", boxes=_full_boxes())


def _rgb_image_only(doc) -> None:
    """RGB reached ONLY through an image. "RGB is present" and "an image is
    RGB" are different rows, and the category is what tells them apart."""
    img = image(doc, 300, 300, colorspace=Name.DeviceRGB, components=3)
    add_page(doc, Dictionary(
        Font=Dictionary(F1=embedded_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceCMYK),
        XObject=Dictionary(Im0=img),
    ), b"q 72 0 0 72 0 0 cm /Im0 Do Q", boxes=_full_boxes())


def _lab_colour(doc) -> None:
    lab = doc.make_indirect(Array([
        Name.Lab, Dictionary(WhitePoint=Array([0.9505, 1.0, 1.089]),
                             Range=Array([-100, 100, -100, 100])),
    ]))
    add_page(doc, Dictionary(
        Font=Dictionary(F1=embedded_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceCMYK, CS1=lab),
    ), b"", boxes=_full_boxes())


def _six_spots(doc) -> None:
    spaces = Dictionary(CS0=Name.DeviceCMYK)
    for index in range(6):
        spaces[f"/S{index}"] = separation(doc, f"Spot{index}")
    add_page(doc, Dictionary(Font=Dictionary(F1=embedded_font(doc)),
                             ColorSpace=spaces), b"", boxes=_full_boxes())


def _spot_named_all(doc) -> None:
    """`/Separation /All` paints every plate; it is not a sixth plate."""
    spaces = Dictionary(CS0=Name.DeviceCMYK, S0=separation(doc, "All"))
    add_page(doc, Dictionary(Font=Dictionary(F1=embedded_font(doc)),
                             ColorSpace=spaces), b"", boxes=_full_boxes())


def _unlisted_spot(doc) -> None:
    spaces = Dictionary(CS0=Name.DeviceCMYK, S0=separation(doc, "HouseGreen"))
    add_page(doc, Dictionary(Font=Dictionary(F1=embedded_font(doc)),
                             ColorSpace=spaces), b"", boxes=_full_boxes())


def _tac_360(doc) -> None:
    add_page(doc, _base_resources(doc),
             b"0.9 0.9 0.9 0.9 k 0 0 612 792 re f", boxes=_full_boxes())


def _tac_under(doc) -> None:
    add_page(doc, _base_resources(doc),
             b"0.2 0.2 0.2 0.2 k 0 0 612 792 re f", boxes=_full_boxes())


def _overprint_page(doc, colour: bytes) -> None:
    gs = doc.make_indirect(Dictionary(
        Type=Name.ExtGState, OP=True, op=True, OPM=1,
    ))
    add_page(doc, Dictionary(
        Font=Dictionary(F1=embedded_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceCMYK),
        ExtGState=Dictionary(GSop=gs),
    ), b"q /GSop gs " + colour + b" 10 10 100 100 re f Q", boxes=_full_boxes())


def _overprint_white_text(doc) -> None:
    # Zero tint in DeviceCMYK is white, and white set to overprint disappears.
    _overprint_page(doc, b"0 0 0 0 k")


def _overprint_black_text(doc) -> None:
    """Overprinting BLACK is correct practice and must never fail."""
    _overprint_page(doc, b"0 0 0 1 k")


def _overprint_ordinary(doc) -> None:
    _overprint_page(doc, b"0.2 0.4 0.1 0 k")


def _font_not_embedded(doc) -> None:
    add_page(doc, Dictionary(
        Font=Dictionary(F1=nonembedded_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceCMYK),
    ), b"", boxes=_full_boxes())


def _font_full_not_subset(doc) -> None:
    add_page(doc, Dictionary(
        Font=Dictionary(F1=full_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceCMYK),
    ), b"", boxes=_full_boxes())


def _type3_font_doc(doc) -> None:
    add_page(doc, Dictionary(
        Font=Dictionary(F1=type3_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceCMYK),
    ), b"BT /F1 12 Tf 20 20 Td (a) Tj ET", boxes=_full_boxes())


def _type3_in_annotation_appearance(doc) -> None:
    """A Type 3 font inside an appearance stream is not page content."""
    appearance = doc.make_stream(b"BT /F1 12 Tf 2 2 Td (a) Tj ET")
    appearance["/Type"] = Name.XObject
    appearance["/Subtype"] = Name.Form
    appearance["/BBox"] = Array([0, 0, 20, 20])
    appearance["/Resources"] = Dictionary(Font=Dictionary(F1=type3_font(doc)))
    page = add_page(doc, _base_resources(doc), b"", boxes=_full_boxes())
    page.obj["/Annots"] = Array([doc.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Square, Rect=Array([0, 0, 20, 20]),
        F=0, AP=Dictionary(N=appearance),
    ))])


def _text_page(doc, size_pt: float, colour: bytes, backdrop: bytes | None = None) -> None:
    content = b""
    if backdrop is not None:
        content += backdrop + b" 0 0 612 792 re f "
    content += (
        b"BT /F1 " + str(size_pt).encode("ascii")
        + b" Tf " + colour + b" 40 700 Td (Sample text) Tj ET"
    )
    add_page(doc, Dictionary(
        Font=Dictionary(F1=standard_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceCMYK),
    ), content, boxes=_full_boxes())


def _type_2pt(doc) -> None:
    _text_page(doc, 2.0, b"0 0 0 1 k")


def _type_5pt_reversed(doc) -> None:
    _text_page(doc, 5.0, b"0 0 0 0 k", backdrop=b"0 0 0 1 k")


def _type_12pt(doc) -> None:
    _text_page(doc, 12.0, b"0 0 0 1 k")


def _rich_black_small_text(doc) -> None:
    _text_page(doc, 8.0, b"0.6 0.4 0.4 1 k")


def _k_only_small_text(doc) -> None:
    _text_page(doc, 8.0, b"0 0 0 1 k")


def _placed_image(doc, native: int, placed: float, *, bpc: int = 8,
                  colorspace=Name.DeviceCMYK, components: int = 4,
                  filter_name=None, matrix: bytes | None = None,
                  clip: bool = False) -> None:
    img = image(doc, native, native, bpc=bpc, colorspace=colorspace,
                components=components, filter_name=filter_name)
    cm = matrix or (
        str(placed).encode("ascii") + b" 0 0 " + str(placed).encode("ascii") + b" 40 40"
    )
    body = b"q "
    if clip:
        body += b"0 0 1 1 re W n "
    body += cm + b" cm /Im0 Do Q"
    add_page(doc, Dictionary(
        Font=Dictionary(F1=embedded_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceCMYK),
        XObject=Dictionary(Im0=img),
    ), body, boxes=_full_boxes())


def _image_72dpi(doc) -> None:
    _placed_image(doc, 100, 100.0)  # 100 px over 100 pt = 72 dpi


def _image_400dpi(doc) -> None:
    _placed_image(doc, 400, 72.0)  # 400 px over 1 inch


def _bitonal_300dpi(doc) -> None:
    _placed_image(doc, 300, 72.0, bpc=1, colorspace=Name.DeviceGray, components=1)


def _image_1200dpi(doc) -> None:
    _placed_image(doc, 1200, 72.0)


def _jpeg2000_image(doc) -> None:
    _placed_image(doc, 600, 72.0, filter_name=Name.JPXDecode)


def _image_clipped_out(doc) -> None:
    """A placement wholly outside the clip has no resolution the page shows."""
    _placed_image(doc, 10, 200.0, clip=True)


def _rotated_placement(doc) -> None:
    """A rotated placement's dpi comes from the CTM column norms, not from the
    bounding box. A bbox-derived figure under-reports and fails a conforming
    image."""
    _placed_image(doc, 600, 0.0, matrix=b"0 72 -72 0 300 300")


def _live_transparency(doc) -> None:
    gs = doc.make_indirect(Dictionary(Type=Name.ExtGState, ca=0.5))
    add_page(doc, Dictionary(
        Font=Dictionary(F1=embedded_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceCMYK),
        ExtGState=Dictionary(GS0=gs),
    ), b"", boxes=_full_boxes())


def _hairline_015(doc) -> None:
    add_page(doc, _base_resources(doc),
             b"0.15 w 0 0 0 1 K 10 10 m 200 200 l S", boxes=_full_boxes())


def _has_layers(doc) -> None:
    ocg = doc.make_indirect(Dictionary(Type=Name.OCG, Name=String("Print layer")))
    doc.Root["/OCProperties"] = Dictionary(
        OCGs=Array([ocg]), D=Dictionary(Order=Array([ocg]), ON=Array([ocg])),
    )
    add_page(doc, _base_resources(doc), b"", boxes=_full_boxes())


def _printing_annotation(doc) -> None:
    page = add_page(doc, _base_resources(doc), b"", boxes=_full_boxes())
    page.obj["/Annots"] = Array([doc.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Text, Rect=Array([10, 10, 30, 30]),
        F=4, Contents=String("Please check"),
    ))])


def _hidden_annotation(doc) -> None:
    """A non-printing note never reaches the plate."""
    page = add_page(doc, _base_resources(doc), b"", boxes=_full_boxes())
    page.obj["/Annots"] = Array([doc.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Text, Rect=Array([10, 10, 30, 30]),
        F=0, Contents=String("Please check"),
    ))])


def _has_form_fields(doc) -> None:
    page = add_page(doc, _base_resources(doc), b"", boxes=_full_boxes())
    field = doc.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx, T=String("name"),
        Rect=Array([10, 10, 200, 30]), F=4,
    ))
    field["/P"] = page.obj
    page.obj["/Annots"] = Array([field])
    doc.Root["/AcroForm"] = Dictionary(Fields=Array([field]))


def _no_title(doc) -> None:
    _baseline(doc)


def _titled(doc) -> None:
    _baseline(doc)
    _set_title(doc)


def _has_document_js(doc) -> None:
    _baseline(doc)
    action = doc.make_indirect(Dictionary(
        S=Name.JavaScript, JS=String("app.alert('hello');"),
    ))
    doc.Root["/Names"] = Dictionary(JavaScript=Dictionary(
        Names=Array([String("greet"), action])
    ))


def _no_xmp(doc) -> None:
    _baseline(doc)


def _with_xmp(doc) -> None:
    _baseline(doc)
    _set_title(doc)


def _unreadable_colorspace(doc) -> None:
    """A `/ColorSpace` that is not a dictionary at all — the branch the walk
    cannot enumerate, whose skip must reach the verdict."""
    add_page(doc, Dictionary(Font=Dictionary(F1=embedded_font(doc)), ColorSpace=17),
             b"", boxes=_full_boxes())


def _unreadable_font(doc) -> None:
    add_page(doc, Dictionary(Font=Dictionary(F1=5),
                             ColorSpace=Dictionary(CS0=Name.DeviceCMYK)),
             b"", boxes=_full_boxes())


def _unreadable_extgstate(doc) -> None:
    add_page(doc, Dictionary(Font=Dictionary(F1=embedded_font(doc)),
                             ColorSpace=Dictionary(CS0=Name.DeviceCMYK),
                             ExtGState=Dictionary(GS0=9)),
             b"", boxes=_full_boxes())


def _unreadable_xobject(doc) -> None:
    add_page(doc, Dictionary(Font=Dictionary(F1=embedded_font(doc)),
                             ColorSpace=Dictionary(CS0=Name.DeviceCMYK),
                             XObject=Dictionary(Fm0=3)),
             b"", boxes=_full_boxes())


def _unparseable_page(doc) -> None:
    page = doc.add_blank_page(page_size=LETTER)
    page.Resources = _base_resources(doc)
    stream = doc.make_stream(b"not flate data at all")
    stream.stream_dict[Name.Filter] = Name.FlateDecode
    page.obj[Name.Contents] = stream
    for key, value in _full_boxes().items():
        page.obj[Name(key)] = Array(value)


def _rgb_and_unreadable_xobject(doc) -> None:
    add_page(doc, Dictionary(
        Font=Dictionary(F1=nonembedded_font(doc)),
        ColorSpace=Dictionary(CS0=Name.DeviceRGB),
        XObject=Dictionary(Fm0=3),
    ), b"", boxes=_full_boxes())


def _font_inside_form(doc) -> None:
    form = doc.make_stream(b"BT /FF 10 Tf (y) Tj ET")
    form["/Type"] = Name.XObject
    form["/Subtype"] = Name.Form
    form["/BBox"] = Array([0, 0, 50, 50])
    form["/Resources"] = Dictionary(Font=Dictionary(FF=nonembedded_font(doc)))
    add_page(doc, Dictionary(XObject=Dictionary(Fm0=form),
                             ColorSpace=Dictionary(CS0=Name.DeviceCMYK)),
             b"", boxes=_full_boxes())


BUILDERS = {
    "baseline": _baseline,
    "version_too_new": _version_too_new,
    "print_denied": _print_denied,
    "no_output_intent": _no_output_intent,
    "with_output_intent": _with_output_intent,
    "wrong_pdfx_claim": _wrong_pdfx_claim,
    "right_pdfx_claim": _right_pdfx_claim,
    "trapped_absent": _trapped_absent,
    "trapped_declared": _trapped_declared,
    "gray_content": _gray_content,
    "has_attachment": _has_attachment,
    "mixed_page_sizes": _mixed_page_sizes,
    "wrong_page_size": _wrong_page_size,
    "no_trim_box": _no_trim_box,
    "trim_equals_media": _trim_equals_media,
    "bleed_too_small": _bleed_too_small,
    "page_count_odd": _page_count_odd,
    "rgb_content": _rgb_content,
    "rgb_image_only": _rgb_image_only,
    "lab_colour": _lab_colour,
    "six_spots": _six_spots,
    "spot_named_all": _spot_named_all,
    "unlisted_spot": _unlisted_spot,
    "tac_360": _tac_360,
    "tac_under": _tac_under,
    "overprint_white_text": _overprint_white_text,
    "overprint_black_text": _overprint_black_text,
    "overprint_ordinary": _overprint_ordinary,
    "font_not_embedded": _font_not_embedded,
    "font_full_not_subset": _font_full_not_subset,
    "type3_font": _type3_font_doc,
    "type3_in_annotation_appearance": _type3_in_annotation_appearance,
    "type_2pt": _type_2pt,
    "type_5pt_reversed": _type_5pt_reversed,
    "type_12pt": _type_12pt,
    "rich_black_small_text": _rich_black_small_text,
    "k_only_small_text": _k_only_small_text,
    "image_72dpi": _image_72dpi,
    "image_400dpi": _image_400dpi,
    "bitonal_300dpi": _bitonal_300dpi,
    "image_1200dpi": _image_1200dpi,
    "jpeg2000_image": _jpeg2000_image,
    "image_clipped_out": _image_clipped_out,
    "rotated_placement": _rotated_placement,
    "live_transparency": _live_transparency,
    "hairline_015": _hairline_015,
    "has_layers": _has_layers,
    "printing_annotation": _printing_annotation,
    "hidden_annotation": _hidden_annotation,
    "has_form_fields": _has_form_fields,
    "no_title": _no_title,
    "titled": _titled,
    "has_document_js": _has_document_js,
    "no_xmp": _no_xmp,
    "with_xmp": _with_xmp,
    "unreadable_colorspace": _unreadable_colorspace,
    "unreadable_font": _unreadable_font,
    "unreadable_extgstate": _unreadable_extgstate,
    "unreadable_xobject": _unreadable_xobject,
    "unparseable_page": _unparseable_page,
    "rgb_and_unreadable_xobject": _rgb_and_unreadable_xobject,
    "font_inside_form": _font_inside_form,
}


#: Facts a document carries in its HEADER or its encryption dictionary rather
#: than in its objects, so they are set at save time and not by a builder.
SAVE_OPTIONS = {
    "version_too_new": {"min_version": "2.0", "force_version": "2.0"},
    "print_denied": {"encryption": pikepdf.Encryption(
        owner="owner", user="", allow=pikepdf.Permissions(
            print_lowres=False, print_highres=False,
        ),
    )},
}


def build(kind: str, directory: str, name: str | None = None) -> str:
    """One fixture on disk. `kind` is a key of `BUILDERS`."""
    builder = BUILDERS.get(kind)
    if builder is None:
        raise KeyError(f"no preflight fixture called {kind!r}")
    path = os.path.join(directory, f"{name or kind}.pdf")
    doc = pikepdf.new()
    builder(doc)
    doc.save(path, **SAVE_OPTIONS.get(kind, {}))
    doc.close()
    return path


def build_damaged(directory: str) -> str:
    """A file whose header is buried under junk. qpdf recovers it; the
    structural check reports the damage, which is the row under test."""
    good = build("baseline", directory, name="damaged-source")
    path = os.path.join(directory, "damaged_xref.pdf")
    with open(good, "rb") as handle:
        body = handle.read()
    with open(path, "wb") as handle:
        handle.write(b"\x00" * 64 + body)
    return path
