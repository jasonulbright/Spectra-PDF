"""Constructed fixtures for the outline conversions.

Every page is built in code, the discipline `transparency_builders.py` set:
how many glyphs a run draws, which font program carries them and what a stroke
covers are all known before anything runs, so "the outline matched" is evidence
rather than a claim.
"""

from __future__ import annotations

import os
from io import BytesIO

import pikepdf
from pikepdf import Array, Dictionary, Name

FONT_DIR = os.path.join(os.path.dirname(__file__), "..", "resources", "fonts")
SANS = os.path.join(FONT_DIR, "LiberationSans-Regular.ttf")
SERIF = os.path.join(FONT_DIR, "LiberationSerif-Regular.ttf")


def fonts_available() -> bool:
    return os.path.isfile(SANS)


def _face(path: str = SANS):
    from fontTools.ttLib import TTFont

    raw = open(path, "rb").read()
    return raw, TTFont(BytesIO(raw), lazy=True)


def embed_truetype(pdf, path: str = SANS, name: str = "/LibSans"):
    """A simple TrueType font with WinAnsi encoding over the whole face."""
    raw, tt = _face(path)
    upem = tt["head"].unitsPerEm
    cmap = tt.getBestCmap()
    hmtx = tt["hmtx"]
    widths = [
        round(hmtx[cmap[code]][0] * 1000 / upem) if cmap.get(code) else 0
        for code in range(32, 127)
    ]
    program = pdf.make_stream(raw)
    program["/Length1"] = len(raw)
    descriptor = pdf.make_indirect(Dictionary(
        Type=Name.FontDescriptor, FontName=Name(name), Flags=32,
        FontBBox=Array([-200, -300, 1200, 1000]), ItalicAngle=0,
        Ascent=900, Descent=-200, CapHeight=700, StemV=80,
        FontFile2=pdf.make_indirect(program)))
    return pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.TrueType, BaseFont=Name(name),
        FirstChar=32, LastChar=126, Widths=Array(widths),
        Encoding=Name("/WinAnsiEncoding"), FontDescriptor=descriptor))


def embed_identity_h(pdf, text: str, path: str = SANS, name: str = "/LibSansCID"):
    """A Type0/Identity-H CIDFontType2 over the same face, plus the byte string
    that draws `text` through it. Codes ARE glyph ids."""
    raw, tt = _face(path)
    upem = tt["head"].unitsPerEm
    cmap = tt.getBestCmap()
    hmtx = tt["hmtx"]
    order = tt.getGlyphOrder()
    gids = [order.index(cmap[ord(ch)]) for ch in text]
    widths: list = []
    for gid in gids:
        widths.append(gid)
        widths.append(Array([round(hmtx[order[gid]][0] * 1000 / upem)]))
    program = pdf.make_stream(raw)
    program["/Length1"] = len(raw)
    descriptor = pdf.make_indirect(Dictionary(
        Type=Name.FontDescriptor, FontName=Name(name), Flags=4,
        FontBBox=Array([-200, -300, 1200, 1000]), ItalicAngle=0,
        Ascent=900, Descent=-200, CapHeight=700, StemV=80,
        FontFile2=pdf.make_indirect(program)))
    descendant = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name("/CIDFontType2"), BaseFont=Name(name),
        CIDSystemInfo=Dictionary(Registry="Adobe", Ordering="Identity", Supplement=0),
        FontDescriptor=descriptor, DW=600, W=Array(widths),
        CIDToGIDMap=Name("/Identity")))
    font = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type0, BaseFont=Name(name),
        Encoding=Name("/Identity-H"), DescendantFonts=Array([descendant])))
    return font, b"".join(gid.to_bytes(2, "big") for gid in gids)


def helvetica(pdf):
    """The standard-14 face no document embeds."""
    return pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/Helvetica")))


def escape(data: bytes) -> bytes:
    out = bytearray(b"(")
    for byte in data:
        if byte in (0x28, 0x29, 0x5C):
            out.append(0x5C)
        out.append(byte)
    out.append(0x29)
    return bytes(out)


def page_pdf(path, body: bytes, resources=None, size=(400.0, 400.0)):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=size)
    page.Resources = resources if resources is not None else Dictionary()
    page.Contents = pdf.make_stream(body)
    pdf.save(path)
    pdf.close()
    return str(path)


def stroke_pdf(path, body: bytes, size=(400.0, 400.0)):
    return page_pdf(path, body, None, size)


def embedded_text_pdf(path, text: str = "Hamburgefonstiv 0123 WAVE",
                      size: float = 36.0):
    """Live text in an embedded TrueType face — the equivalence fixture."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(500.0, 260.0))
    page.Resources = Dictionary(Font=Dictionary(F0=embed_truetype(pdf)))
    page.Contents = pdf.make_stream(
        f"BT /F0 {size} Tf 1 0 0 1 40 120 Tm ".encode("ascii")
        + escape(text.encode("latin-1")) + b" Tj ET")
    pdf.save(path)
    pdf.close()
    return str(path)


def mixed_modes_pdf(path):
    """One page exercising TJ kerning, Tz, Tc, Ts and the invisible render
    mode, so a placement regression shows up as a moved glyph rather than as a
    missing feature."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(500.0, 300.0))
    page.Resources = Dictionary(Font=Dictionary(F0=embed_truetype(pdf)))
    page.Contents = pdf.make_stream(
        b"BT /F0 24 Tf 2 Tc 90 Tz 1 0 0 1 40 220 Tm "
        b"[(Kerned) -220 (Text) 400 (Run)] TJ "
        b"0 Tc 100 Tz 1 0 0 1 40 160 Tm 6 Ts (Raised) Tj 0 Ts "
        b"1 0 0 1 40 100 Tm 3 Tr (Invisible) Tj "
        b"1 0 0 1 40 50 Tm 0 Tr (Plain) Tj ET")
    pdf.save(path)
    pdf.close()
    return str(path)


def composite_text_pdf(path, text: str = "Composite Wave"):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(500.0, 300.0))
    font, data = embed_identity_h(pdf, text)
    page.Resources = Dictionary(Font=Dictionary(F0=font))
    page.Contents = pdf.make_stream(
        b"BT /F0 26 Tf 1 0 0 1 40 150 Tm " + escape(data) + b" Tj ET")
    pdf.save(path)
    pdf.close()
    return str(path)


def unembedded_text_pdf(path, text: str = "Substituted Wave"):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(500.0, 300.0))
    page.Resources = Dictionary(Font=Dictionary(F0=helvetica(pdf)))
    page.Contents = pdf.make_stream(
        b"BT /F0 28 Tf 1 0 0 1 40 150 Tm " + escape(text.encode("latin-1")) + b" Tj ET")
    pdf.save(path)
    pdf.close()
    return str(path)


def type3_text_pdf(path):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200.0, 200.0))
    proc = pdf.make_stream(b"10 0 0 0 10 10 d1 0 0 10 10 re f")
    font = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type3, FontBBox=Array([0, 0, 10, 10]),
        FontMatrix=Array([0.1, 0, 0, 0.1, 0, 0]),
        CharProcs=Dictionary(square=proc),
        Encoding=Dictionary(Type=Name.Encoding, Differences=Array([97, Name("/square")])),
        FirstChar=97, LastChar=97, Widths=Array([10])))
    page.Resources = Dictionary(Font=Dictionary(F0=font))
    page.Contents = pdf.make_stream(b"BT /F0 20 Tf 20 100 Td (a) Tj ET")
    pdf.save(path)
    pdf.close()
    return str(path)


def shared_form_pdf(path):
    """Two pages drawing ONE form that carries text. Converting page 1 must
    leave page 2's text live — the copy-on-write proof."""
    pdf = pikepdf.new()
    font = embed_truetype(pdf)
    form = pdf.make_stream(b"BT /F0 24 Tf 1 0 0 1 20 40 Tm (Inside a form) Tj ET")
    form["/Type"] = Name.XObject
    form["/Subtype"] = Name.Form
    form["/BBox"] = Array([0, 0, 300, 100])
    form["/Resources"] = Dictionary(Font=Dictionary(F0=font))
    form = pdf.make_indirect(form)
    for _ in range(2):
        page = pdf.add_blank_page(page_size=(400.0, 200.0))
        page.Resources = Dictionary(XObject=Dictionary(Fx=form))
        page.Contents = pdf.make_stream(b"q 1 0 0 1 40 60 cm /Fx Do Q")
    pdf.save(path)
    pdf.close()
    return str(path)


def text_clip_pdf(path):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400.0, 200.0))
    page.Resources = Dictionary(Font=Dictionary(F0=embed_truetype(pdf)))
    page.Contents = pdf.make_stream(
        b"q BT /F0 48 Tf 1 0 0 1 30 80 Tm 7 Tr (CLIP) Tj ET "
        b"1 0 0 rg 0 0 400 200 re f Q")
    pdf.save(path)
    pdf.close()
    return str(path)


def text_over_alpha_pdf(path):
    """Live text beside a half-transparent square: the region flatten absorbs
    the square's neighbourhood and the conversion takes what is left."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(500.0, 300.0))
    page.Resources = Dictionary(
        ExtGState=Dictionary(GA=pdf.make_indirect(
            Dictionary(Type=Name.ExtGState, ca=0.5))),
        Font=Dictionary(F0=embed_truetype(pdf)))
    page.Contents = pdf.make_stream(b"\n".join([
        b"BT /F0 18 Tf 1 0 0 1 40 250 Tm (Live text well away from it) Tj ET",
        b"q /GA gs 1 0 0 rg 380 40 90 90 re f Q",
    ]))
    pdf.save(path)
    pdf.close()
    return str(path)
