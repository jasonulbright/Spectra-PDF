"""Documents whose standards conversion provably loses something.

Each builder isolates one class of content a PDF/A or PDF/X producer cannot
carry, so a test can assert on the loss by name rather than on a size delta.
"""

from __future__ import annotations

import pikepdf
from pikepdf import Array, Dictionary, Name, Stream, String

TEXT = "Archival body text"


def _helvetica(pdf):
    return pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica))


def _page(pdf, content, resources=None):
    res = Dictionary(Font=Dictionary(F1=_helvetica(pdf)))
    for key, value in (resources or {}).items():
        res["/" + key] = value
    return pdf.make_indirect(Dictionary(
        Type=Name.Page,
        MediaBox=Array([0, 0, 612, 792]),
        Contents=Stream(pdf, content.encode("latin-1")),
        Resources=res,
    ))


def plain_pdf(path):
    """Nothing here needs removing to reach any conformance level."""
    pdf = pikepdf.new()
    pdf.pages.append(pikepdf.Page(_page(pdf, f"BT /F1 24 Tf 72 700 Td ({TEXT}) Tj ET")))
    pdf.save(str(path))
    pdf.close()
    return str(path)


def pdfua_declared_pdf(path):
    """Conformant content, plus an XMP declaration of a SECOND standard.

    ISO 14289-1 5 declares PDF/UA conformance through `pdfuaid:part`. Nothing
    on the page needs removing, so the only thing a conversion can cost this
    document is that declaration.
    """
    pdf = pikepdf.new()
    pdf.pages.append(pikepdf.Page(_page(pdf, f"BT /F1 24 Tf 72 700 Td ({TEXT}) Tj ET")))
    with pdf.open_metadata() as meta:
        meta["dc:title"] = "Two standards"
        meta["pdfuaid:part"] = "1"
    pdf.save(str(path))
    pdf.close()
    return str(path)


def transparent_pdf(path):
    """Text beside a constant-alpha fill. PDF/A-1 admits no transparency."""
    pdf = pikepdf.new()
    gs = pdf.make_indirect(Dictionary(Type=Name.ExtGState, ca=0.5, CA=0.5))
    content = (
        f"q /GS0 gs 1 0 0 rg 72 400 200 200 re f Q\n"
        f"BT /F1 24 Tf 72 700 Td ({TEXT}) Tj ET"
    )
    pdf.pages.append(pikepdf.Page(
        _page(pdf, content, {"ExtGState": Dictionary(GS0=gs)})))
    pdf.save(str(path))
    pdf.close()
    return str(path)


def launch_action_pdf(path):
    """A link whose action launches an external program."""
    pdf = pikepdf.new()
    page = _page(pdf, f"BT /F1 24 Tf 72 700 Td ({TEXT}) Tj ET")
    page.Annots = Array([pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Link,
        Rect=Array([72, 690, 400, 720]), Border=Array([0, 0, 0]),
        A=Dictionary(Type=Name.Action, S=Name.Launch, F=String("notepad.exe")),
    ))])
    pdf.pages.append(pikepdf.Page(page))
    pdf.save(str(path))
    pdf.close()
    return str(path)


def scripted_pdf(path):
    """Document-level JavaScript, reachable from the name tree and on open."""
    pdf = pikepdf.new()
    pdf.pages.append(pikepdf.Page(_page(pdf, f"BT /F1 24 Tf 72 700 Td ({TEXT}) Tj ET")))
    js = pdf.make_indirect(Stream(pdf, b"app.alert('hello');"))
    action = pdf.make_indirect(Dictionary(Type=Name.Action, S=Name.JavaScript, JS=js))
    pdf.Root.OpenAction = action
    pdf.Root.Names = Dictionary(
        JavaScript=Dictionary(Names=Array([String("doc"), action])))
    pdf.save(str(path))
    pdf.close()
    return str(path)


def layered_pdf(path):
    """An optional content group. PDF/A-1 has no layers."""
    pdf = pikepdf.new()
    ocg = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Draft stamp")))
    content = (
        "/OC /MC0 BDC 1 0 0 rg BT /F1 48 Tf 100 400 Td (DRAFT) Tj ET EMC\n"
        f"BT /F1 24 Tf 72 700 Td ({TEXT}) Tj ET"
    )
    pdf.pages.append(pikepdf.Page(
        _page(pdf, content, {"Properties": Dictionary(MC0=ocg)})))
    pdf.Root.OCProperties = Dictionary(
        OCGs=Array([ocg]), D=Dictionary(Order=Array([ocg]), ON=Array([ocg])))
    pdf.save(str(path))
    pdf.close()
    return str(path)


def encrypted_pdf(path):
    """Encryption, which no conformance level permits."""
    pdf = pikepdf.new()
    pdf.pages.append(pikepdf.Page(_page(pdf, f"BT /F1 24 Tf 72 700 Td ({TEXT}) Tj ET")))
    pdf.save(str(path), encryption=pikepdf.Encryption(owner="owner", user="", R=6))
    pdf.close()
    return str(path)


def tagged_form_pdf(path):
    """A tagged document carrying a filled field and an outline."""
    pdf = pikepdf.new()
    page = _page(pdf, f"/P <</MCID 0>> BDC BT /F1 24 Tf 72 700 Td ({TEXT}) Tj ET EMC")
    widget = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx, T=String("Name"),
        V=String("filled in"), Rect=Array([72, 600, 300, 630]),
        DA=String("/Helv 12 Tf 0 g"), F=4,
    ))
    page.Annots = Array([widget])
    pdf.pages.append(pikepdf.Page(page))
    widget.P = page

    para = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.P, Pg=page, K=0))
    doc = pdf.make_indirect(Dictionary(Type=Name.StructElem, S=Name.Document,
                                       K=Array([para])))
    para.P = doc
    root = pdf.make_indirect(Dictionary(Type=Name.StructTreeRoot, K=Array([doc])))
    doc.P = root
    pdf.Root.StructTreeRoot = root
    pdf.Root.MarkInfo = Dictionary(Marked=True)
    pdf.Root.Lang = String("en-US")
    pdf.Root.AcroForm = Dictionary(Fields=Array([widget]), DA=String("/Helv 0 Tf 0 g"))
    pdf.save(str(path))
    pdf.close()
    return str(path)
