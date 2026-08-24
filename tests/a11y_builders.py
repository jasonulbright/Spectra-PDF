"""Fixtures for the accessibility checker, built in code.

The `derived_nav_builders` discipline: every document here is small enough to
read in one screen and fails EXACTLY ONE check, so a verdict that moves can
only have come from the check that owns it. The documents whose names end in
`_ok` are the false-failure guards — each is a CONFORMING shape a naive
implementation of its check reports as broken.

One conformance question per file also means the pass fixture and the fail
fixture differ by one edit, which is what makes a diff between them readable.
"""

from __future__ import annotations

import pikepdf
from pikepdf import Array, Dictionary, Name, String

PAGE = (612, 792)


def _font(pdf, base="Helvetica"):
    return pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name("/" + base),
            Encoding=Name.WinAnsiEncoding,
        )
    )


def new_pdf(pages=1, size=PAGE):
    pdf = pikepdf.Pdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=size)
    return pdf


def draw(pdf, page, content: str, base="Helvetica"):
    page.obj[Name.Contents] = pdf.make_stream(content.encode("latin-1"))
    page.obj[Name.Resources] = Dictionary(Font=Dictionary(F1=_font(pdf, base)))


def struct_root(pdf, role_map=None):
    root = pdf.make_indirect(Dictionary(Type=Name.StructTreeRoot))
    if role_map:
        root[Name.RoleMap] = Dictionary(
            **{k.lstrip("/"): Name("/" + v) for k, v in role_map.items()}
        )
    pdf.Root[Name.StructTreeRoot] = root
    pdf.Root[Name.MarkInfo] = Dictionary(Marked=True)
    return root


# ISO 32000-2 14.8.6.1. An element with no `/NS` is in the PDF 1.7 namespace,
# so a fixture that wants the PDF 2.0 reading has to say so on every element.
SSN_2_0 = "http://iso.org/pdf2/ssn"


def namespace(pdf, root, uri=SSN_2_0):
    """A namespace dictionary, registered in the root's `/Namespaces` array."""
    ns = pdf.make_indirect(Dictionary(Type=Name.Namespace, NS=String(uri)))
    root[Name.Namespaces] = Array([ns])
    return ns


def elem(pdf, tag, parent, page=None, mcid=None, kids=None, **extra):
    d = Dictionary(Type=Name.StructElem, S=Name("/" + tag), P=parent)
    if page is not None:
        d[Name.Pg] = page.obj
    if mcid is not None:
        d[Name.K] = mcid
    if kids is not None:
        d[Name.K] = Array(kids)
    for key, value in extra.items():
        d[Name("/" + key)] = value
    return pdf.make_indirect(d)


def parent_tree(pdf, root, page, elements):
    page.obj[Name.StructParents] = 0
    root[Name.ParentTree] = pdf.make_indirect(
        Dictionary(Nums=Array([0, pdf.make_indirect(Array(elements))]))
    )
    root[Name.ParentTreeNextKey] = 1


def make_conformant(pdf, page=None):
    """Everything the document-level checks look at, satisfied.

    Applied to every fixture below so the one thing each is about is the only
    thing that fails.
    """
    pdf.Root[Name.Lang] = String("en-US")
    pdf.Root[Name.ViewerPreferences] = Dictionary(DisplayDocTitle=True)
    with pdf.open_metadata() as meta:
        meta["dc:title"] = "A Test Document"
    if page is not None:
        page.obj[Name.Tabs] = Name.S


def save(pdf, path):
    pdf.save(str(path))
    pdf.close()
    return str(path)


# ── document ──────────────────────────────────────────────────────────────


def _one_tagged_paragraph(pdf, page, text="Readable body copy at eleven points."):
    draw(pdf, page, f"/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td ({text}) Tj ET EMC")
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    return root, doc


def baseline(path):
    """A document that passes every applicable check."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    make_conformant(pdf, page)
    return save(pdf, path)


def untagged(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(pdf, page, "BT /F1 11 Tf 40 700 Td (Untagged body copy.) Tj ET")
    make_conformant(pdf, page)
    return save(pdf, path)


def perm_blocked(path):
    """Encryption whose permissions forbid extraction for accessibility.

    R3 deliberately: from revision 4 the accessibility bit is ignored by every
    writer (and by qpdf), so a document that actually blocks assistive
    technology is an OLD one — which is exactly the document a checker has to
    catch. The passwords are empty, so the permission is the whole restriction.
    """
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    make_conformant(pdf, page)
    pdf.save(
        str(path),
        encryption=pikepdf.Encryption(
            owner="",
            user="",
            R=3,
            aes=False,
            metadata=False,
            allow=pikepdf.Permissions(accessibility=False, extract=False),
        ),
    )
    pdf.close()
    return str(path)


def perm_blocked_owner_password(path):
    """The same restriction, held by an owner password this app does not have.

    The fix REFUSES here: the permissions cannot be rewritten without
    reproducing that password, and replacing it with one nobody chose — or
    dropping the encryption — is not a repair.
    """
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    make_conformant(pdf, page)
    pdf.save(
        str(path),
        encryption=pikepdf.Encryption(
            owner="the-owner",
            user="",
            R=3,
            aes=False,
            metadata=False,
            allow=pikepdf.Permissions(accessibility=False, extract=False),
        ),
    )
    pdf.close()
    return str(path)


def no_lang(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    make_conformant(pdf, page)
    del pdf.Root[Name.Lang]
    return save(pdf, path)


def lang_on_elements_ok(path):
    """No catalog /Lang; every content-bearing structure element declares one.

    ISO 32000-2 14.9.2.3 makes the catalog entry a DEFAULT that a structure
    element overrides, so this document HAS declared a language for its text.
    The checker used to read the catalog alone and tell the reader the document
    declares no language, which was false for exactly this shape.
    """
    pdf = new_pdf()
    page = pdf.pages[0]
    _root, _doc = _one_tagged_paragraph(pdf, page)
    make_conformant(pdf, page)
    del pdf.Root[Name.Lang]
    para = pdf.Root[Name.StructTreeRoot][Name.K][Name.K][0]
    para[Name.Lang] = String("en-US")
    return save(pdf, path)


def lang_inherited_ok(path):
    """The language is declared on an ANCESTOR only.

    14.9.2.3: an element with no /Lang inherits from the nearest parent that
    has one, so the paragraph's text is covered by the Document element's
    declaration.
    """
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    make_conformant(pdf, page)
    del pdf.Root[Name.Lang]
    pdf.Root[Name.StructTreeRoot][Name.K][Name.Lang] = String("en-US")
    return save(pdf, path)


def lang_empty_is_unknown(path):
    """A present but EMPTY /Lang.

    14.9.2.2: the empty text string states that the language is UNKNOWN, so it
    is not a declaration and must not be accepted as one.
    """
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    make_conformant(pdf, page)
    pdf.Root[Name.Lang] = String("")
    return save(pdf, path)


def no_title(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    pdf.Root[Name.Lang] = String("en-US")
    pdf.Root[Name.ViewerPreferences] = Dictionary(DisplayDocTitle=True)
    page.obj[Name.Tabs] = Name.S
    return save(pdf, path)


def title_not_displayed(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    make_conformant(pdf, page)
    pdf.Root[Name.ViewerPreferences] = Dictionary(DisplayDocTitle=False)
    return save(pdf, path)


def title_docinfo_only(path):
    """ISO 14289-1 cl. 7.1 requires dc:title in the catalog's Metadata stream
    and requires a conforming reader to ignore the document information
    dictionary, so a title carried only there declares nothing."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    make_conformant(pdf, page)
    with pdf.open_metadata() as meta:
        del meta["dc:title"]
    pdf.docinfo[Name.Title] = String("A Test Document")
    return save(pdf, path)


def no_bookmarks_long(path):
    pdf = new_pdf(pages=12)
    for page in pdf.pages:
        draw(pdf, page, "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC")
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    kids = []
    nums = Array()
    for i, page in enumerate(pdf.pages):
        para = elem(pdf, "P", doc, page=page, mcid=0)
        kids.append(para)
        page.obj[Name.StructParents] = i
        nums.append(i)
        nums.append(pdf.make_indirect(Array([para])))
    doc[Name.K] = Array(kids)
    root[Name.K] = doc
    root[Name.ParentTree] = pdf.make_indirect(Dictionary(Nums=nums))
    root[Name.ParentTreeNextKey] = len(pdf.pages)
    make_conformant(pdf, pdf.pages[0])
    return save(pdf, path)


def no_bookmarks_long_with_headings(path):
    """The same warning, on a document bookmarks CAN be derived from.

    `no_bookmarks_long` has no headings, so `outline_from_structure` refuses
    it — which is the route case, not the fix case. This is the twin the
    automatic fix is measured on.
    """
    pdf = new_pdf(pages=12)
    for page in pdf.pages:
        draw(
            pdf,
            page,
            "/H1 <</MCID 0>> BDC BT /F1 20 Tf 40 720 Td (A section heading) Tj ET EMC\n"
            "/P <</MCID 1>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC",
        )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    kids = []
    nums = Array()
    for i, page in enumerate(pdf.pages):
        head = elem(pdf, "H1", doc, page=page, mcid=0)
        para = elem(pdf, "P", doc, page=page, mcid=1)
        kids.extend([head, para])
        page.obj[Name.StructParents] = i
        nums.append(i)
        nums.append(pdf.make_indirect(Array([head, para])))
    doc[Name.K] = Array(kids)
    root[Name.K] = doc
    root[Name.ParentTree] = pdf.make_indirect(Dictionary(Nums=nums))
    root[Name.ParentTreeNextKey] = len(pdf.pages)
    make_conformant(pdf, pdf.pages[0])
    return save(pdf, path)


def low_contrast(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf,
        page,
        "0.85 0.85 0.85 rg 40 600 400 20 re f\n"
        "/P <</MCID 0>> BDC BT 0.9 0.9 0.9 rg /F1 11 Tf 44 606 Td "
        "(Pale text on a pale box.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def contrast_over_image_ok(path):
    """PASS fixture — pale text over an IMAGE. The backdrop is unknowable, so
    the honest verdict is needs-review, never fail."""
    pdf = new_pdf()
    page = pdf.pages[0]
    image = pdf.make_stream(
        b"\xff\x00\x00" * 4,
        Type=Name.XObject, Subtype=Name.Image, Width=2, Height=2,
        ColorSpace=Name.DeviceRGB, BitsPerComponent=8,
    )
    page.obj[Name.Resources] = Dictionary(
        Font=Dictionary(F1=_font(pdf)), XObject=Dictionary(Im0=image)
    )
    page.obj[Name.Contents] = pdf.make_stream(
        b"q 400 0 0 40 40 590 cm /Im0 Do Q\n"
        b"/P <</MCID 0>> BDC BT 0.9 0.9 0.9 rg /F1 11 Tf 44 600 Td "
        b"(Pale text over a photograph.) Tj ET EMC"
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def large_text_contrast_ok(path):
    """PASS fixture — 24 pt text at 3.9:1. WCAG's large-text threshold is 3:1,
    and applying the small-text one to a heading is a false failure."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf,
        page,
        "/H1 <</MCID 0>> BDC BT 0.5 0.5 0.5 rg /F1 24 Tf 40 700 Td (A Grey Heading) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    head = elem(pdf, "H1", doc, page=page, mcid=0)
    doc[Name.K] = Array([head])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [head])
    make_conformant(pdf, page)
    return save(pdf, path)


# ── page content ──────────────────────────────────────────────────────────


def untagged_content(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf,
        page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Tagged body copy.) Tj ET EMC\n"
        "BT /F1 11 Tf 40 660 Td (This paragraph is tagged by nothing.) Tj ET",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def artifact_declared_ok(path):
    """PASS fixture — the running footer is DECLARED an artifact, which is a
    positive statement that it is not content. Reading it as untagged content
    is the most common false failure this check could ship."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf,
        page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Tagged body copy.) Tj ET EMC\n"
        "/Artifact BMC BT /F1 8 Tf 40 40 Td (page 1) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def _annot(pdf, page, subtype, rect, **extra):
    d = Dictionary(Type=Name.Annot, Subtype=Name("/" + subtype), Rect=Array(rect), F=4)
    for key, value in extra.items():
        d[Name("/" + key)] = value
    annot = pdf.make_indirect(d)
    existing = page.obj.get(Name.Annots)
    page.obj[Name.Annots] = Array(list(existing) + [annot]) if existing is not None else Array([annot])
    return annot


def untagged_annotation(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _annot(pdf, page, "Square", [40, 500, 200, 560], Contents=String("A note"))
    make_conformant(pdf, page)
    return save(pdf, path)


def no_tabs(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    annot = _annot(pdf, page, "Square", [40, 500, 200, 560], Contents=String("A note"))
    tagged = elem(pdf, "Annot", doc, page=page,
                  kids=[Dictionary(Type=Name.OBJR, Obj=annot)])
    doc[Name.K] = Array(list(doc[Name.K]) + [tagged])
    make_conformant(pdf)
    return save(pdf, path)


def blank_runs_ok(path):
    """A tagged paragraph whose show ops include runs that draw only spaces.

    The font decodes every byte; two of the runs simply hold whitespace, which
    is a statement about the TEXT and none at all about the mapping. The
    checker used to report each of them as a font with no Unicode mapping,
    because its skip guard required a blank run to be `editable` and
    `text_runs` clears `editable` for exactly those runs.
    """
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf,
        page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Readable body copy) Tj "
        "( ) Tj (at eleven points.) Tj ( ) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def bad_encoding(path):
    """A font with no /ToUnicode and a symbolic built-in encoding: its bytes
    map to no character, so the text reads as nothing."""
    pdf = new_pdf()
    page = pdf.pages[0]
    font = pdf.make_indirect(
        Dictionary(
            Type=Name.Font, Subtype=Name.TrueType, BaseFont=Name("/Private"),
            FirstChar=65, LastChar=67, Widths=Array([500, 500, 500]),
            FontDescriptor=pdf.make_indirect(
                Dictionary(Type=Name.FontDescriptor, FontName=Name("/Private"),
                           Flags=4, ItalicAngle=0, Ascent=700, Descent=-200,
                           CapHeight=700, StemV=80,
                           FontBBox=Array([0, -200, 1000, 700]))
            ),
        )
    )
    page.obj[Name.Resources] = Dictionary(Font=Dictionary(F1=font))
    page.obj[Name.Contents] = pdf.make_stream(
        b"/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (ABC) Tj ET EMC"
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def untagged_multimedia(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _annot(pdf, page, "Screen", [40, 400, 300, 560])
    make_conformant(pdf, page)
    return save(pdf, path)


def has_scripts(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    make_conformant(pdf, page)
    action = pdf.make_indirect(
        Dictionary(S=Name.JavaScript, JS=String("app.setTimeOut('app.alert(1)', 500);"))
    )
    pdf.Root[Name.Names] = Dictionary(
        JavaScript=Dictionary(Names=Array([String("boot"), action]))
    )
    return save(pdf, path)


def repetitive_links(path):
    """Two pages whose links read the same and go somewhere different. Each
    link element carries its own text, its OBJR and the annotation's own
    /Contents — the conforming shape; the only thing wrong with this document
    is the labelling."""
    pdf = new_pdf(pages=2)
    for page in pdf.pages:
        draw(
            pdf, page,
            "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
            "/Link <</MCID 1>> BDC BT /F1 11 Tf 40 660 Td (Read more) Tj ET EMC",
        )
        page.obj[Name.Tabs] = Name.S
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    kids = []
    nums = Array()
    for i, page in enumerate(pdf.pages):
        para = elem(pdf, "P", doc, page=page, mcid=0)
        annot = _annot(
            pdf, page, "Link", [40, 655, 120, 675],
            A=Dictionary(S=Name.URI, URI=String(f"https://example.test/{i}")),
            Contents=String("Read more"),
        )
        link = elem(pdf, "Link", doc, page=page,
                    kids=[1, Dictionary(Type=Name.OBJR, Obj=annot)])
        kids.extend([para, link])
        page.obj[Name.StructParents] = i
        nums.append(i)
        nums.append(pdf.make_indirect(Array([para, link])))
    doc[Name.K] = Array(kids)
    root[Name.K] = doc
    root[Name.ParentTree] = pdf.make_indirect(Dictionary(Nums=nums))
    root[Name.ParentTreeNextKey] = len(pdf.pages)
    make_conformant(pdf)
    return save(pdf, path)


# ── forms ─────────────────────────────────────────────────────────────────


def untagged_field(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    field = _annot(pdf, page, "Widget", [300, 500, 500, 520],
                   FT=Name.Tx, T=String("name"), TU=String("Your full name"))
    pdf.Root[Name.AcroForm] = pdf.make_indirect(
        Dictionary(Fields=Array([field]), DA=String("/Helv 0 Tf 0 g"))
    )
    make_conformant(pdf, page)
    return save(pdf, path)


def _tagged_field(pdf, page, doc, widget_extra=None, form_extra=None):
    field = _annot(pdf, page, "Widget", [300, 500, 500, 520], FT=Name.Tx,
                   T=String("name"), **(widget_extra or {}))
    tagged = elem(pdf, "Form", doc, page=page,
                  kids=[Dictionary(Type=Name.OBJR, Obj=field)], **(form_extra or {}))
    doc[Name.K] = Array(list(doc[Name.K]) + [tagged])
    pdf.Root[Name.AcroForm] = pdf.make_indirect(
        Dictionary(Fields=Array([field]), DA=String("/Helv 0 Tf 0 g"))
    )
    return field, tagged


def field_no_tu(path):
    """The `Form` element carries a TITLE, not a description: it keeps the
    element's own check quiet while leaving the field unnamed, so the one
    verdict that moves is the field's."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    _tagged_field(pdf, page, doc, form_extra={"T": String("Name field")})
    make_conformant(pdf, page)
    return save(pdf, path)


def field_named_by_element_ok(path):
    """PASS fixture — a field with no `/TU` whose tagging `Form` element
    carries the accessible name is named."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    _tagged_field(pdf, page, doc, form_extra={"Alt": String("Your full name")})
    make_conformant(pdf, page)
    return save(pdf, path)


def hidden_field_ok(path):
    """PASS fixture — a widget the Hidden flag stops from rendering is owed no
    accessible name."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    _tagged_field(pdf, page, doc, widget_extra={"F": 2})
    make_conformant(pdf, page)
    return save(pdf, path)


def zero_area_field_ok(path):
    """PASS fixture — a widget whose `/Rect` corners coincide bounds no area
    and presents nothing to name."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    field = _annot(pdf, page, "Widget", [800, 800, 800, 800], FT=Name.Tx, T=String("name"))
    tagged = elem(pdf, "Form", doc, page=page,
                  kids=[Dictionary(Type=Name.OBJR, Obj=field)])
    doc[Name.K] = Array(list(doc[Name.K]) + [tagged])
    pdf.Root[Name.AcroForm] = pdf.make_indirect(
        Dictionary(Fields=Array([field]), DA=String("/Helv 0 Tf 0 g"))
    )
    make_conformant(pdf, page)
    return save(pdf, path)


# ── alternate text ────────────────────────────────────────────────────────


def _figure_page(pdf, page, alt=None, actual=None):
    draw(
        pdf,
        page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
        "/Figure <</MCID 1>> BDC 0.5 0.5 0.5 rg 40 500 120 60 re f EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    extra = {}
    if alt is not None:
        extra["Alt"] = String(alt)
    if actual is not None:
        extra["ActualText"] = String(actual)
    fig = elem(pdf, "Figure", doc, page=page, mcid=1, **extra)
    doc[Name.K] = Array([para, fig])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, fig])
    return root, doc, fig


def figure_no_alt(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _figure_page(pdf, page)
    make_conformant(pdf, page)
    return save(pdf, path)


def figure_actual_text_ok(path):
    """PASS fixture — a figure described by /ActualText rather than /Alt is
    described."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _figure_page(pdf, page, actual="Quarterly revenue, 2026")
    make_conformant(pdf, page)
    return save(pdf, path)


def figure_empty_actual_text_ok(path):
    """PASS fixture — `/ActualText` present and empty states the figure's text
    equivalent IS nothing, which is a declaration rather than a missing one."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _figure_page(pdf, page, actual="")
    make_conformant(pdf, page)
    return save(pdf, path)


def formula_no_alt(path):
    """An undescribed `Formula` — the role both alt-text rosters could claim.

    `figures_alt` owns it, so this fixture must move that check and only that
    check: a second finding under `other_elements_alt` is the same defect
    reported twice.
    """
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf,
        page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
        "/Formula <</MCID 1>> BDC BT /F1 11 Tf 40 500 Td (E = mc2) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    formula = elem(pdf, "Formula", doc, page=page, mcid=1)
    doc[Name.K] = Array([para, formula])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, formula])
    make_conformant(pdf, page)
    return save(pdf, path)


def nested_alt(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc, fig = _figure_page(pdf, page, alt="A chart")
    doc[Name.Alt] = String("The whole document")
    make_conformant(pdf, page)
    return save(pdf, path)


def alt_no_content(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    empty = elem(pdf, "Figure", doc, page=page, Alt=String("A chart that is not there"))
    doc[Name.K] = Array(list(doc[Name.K]) + [empty])
    make_conformant(pdf, page)
    return save(pdf, path)


def alt_hides_annot(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    annot = _annot(pdf, page, "Square", [40, 500, 200, 560], Contents=String("The real note"))
    wrapper = elem(pdf, "Annot", doc, page=page, Alt=String("Something else entirely"),
                   kids=[Dictionary(Type=Name.OBJR, Obj=annot)])
    doc[Name.K] = Array(list(doc[Name.K]) + [wrapper])
    make_conformant(pdf, page)
    return save(pdf, path)


def link_no_alt(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    annot = _annot(pdf, page, "Link", [400, 400, 500, 420],
                   A=Dictionary(S=Name.URI, URI=String("https://example.test/")))
    link = elem(pdf, "Link", doc, page=page, kids=[Dictionary(Type=Name.OBJR, Obj=annot)])
    doc[Name.K] = Array(list(doc[Name.K]) + [link])
    make_conformant(pdf, page)
    return save(pdf, path)


# ── tables ────────────────────────────────────────────────────────────────


def _table_content(pdf, page, cells):
    parts = ["/P <</MCID 0>> BDC BT /F1 11 Tf 40 740 Td (Body copy.) Tj ET EMC"]
    for i, (text, x, y) in enumerate(cells, start=1):
        parts.append(
            f"/TD <</MCID {i}>> BDC BT /F1 11 Tf {x} {y} Td ({text}) Tj ET EMC"
        )
    draw(pdf, page, "\n".join(parts))


def _table(pdf, page, rows, table_extra=None, cell_kind="TD"):
    """`rows` is a list of lists of (text, extra-dict)."""
    flat = []
    for r, row in enumerate(rows):
        for c, (text, _extra) in enumerate(row):
            flat.append((text, 40 + c * 120, 680 - r * 30))
    _table_content(pdf, page, flat)
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    order = [para]
    row_elems = []
    mcid = 1
    for row in rows:
        cells = []
        for text, extra in row:
            kind = extra.pop("_role", cell_kind)
            cell = elem(pdf, kind, doc, page=page, mcid=mcid, **extra)
            cells.append(cell)
            order.append(cell)
            mcid += 1
        row_elems.append(elem(pdf, "TR", doc, kids=cells))
    table = elem(pdf, "Table", doc, kids=row_elems, **(table_extra or {}))
    doc[Name.K] = Array([para, table])
    root[Name.K] = doc
    parent_tree(pdf, root, page, order)
    return root, doc, table, row_elems


def tr_outside_table(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _table_content(pdf, page, [("Region", 40, 680), ("Revenue", 160, 680)])
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    c1 = elem(pdf, "TH", doc, page=page, mcid=1, Scope=Name.Column)
    c2 = elem(pdf, "TH", doc, page=page, mcid=2, Scope=Name.Column)
    row = elem(pdf, "TR", doc, kids=[c1, c2])
    doc[Name.K] = Array([para, row])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, c1, c2])
    make_conformant(pdf, page)
    return save(pdf, path)


def td_outside_tr(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _table_content(pdf, page, [("Region", 40, 680), ("Revenue", 160, 680)])
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    c1 = elem(pdf, "TH", doc, page=page, mcid=1, Scope=Name.Column)
    c2 = elem(pdf, "TH", doc, page=page, mcid=2, Scope=Name.Column)
    table = elem(pdf, "Table", doc, kids=[c1, c2],
                 Summary=String("Revenue by region"))
    doc[Name.K] = Array([para, table])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, c1, c2])
    make_conformant(pdf, page)
    return save(pdf, path)


def table_no_headers(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _table(pdf, page, [[("Region", {}), ("Revenue", {})], [("North", {}), ("120", {})]],
           table_extra={"Summary": String("Revenue by region")})
    make_conformant(pdf, page)
    return save(pdf, path)


def table_headers_ok(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _table(
        pdf, page,
        [
            [("Region", {"_role": "TH", "Scope": Name.Column}),
             ("Revenue", {"_role": "TH", "Scope": Name.Column})],
            [("North", {}), ("120", {})],
        ],
        table_extra={"Summary": String("Revenue by region")},
    )
    make_conformant(pdf, page)
    return save(pdf, path)


def th_no_scope(path):
    """ISO 14289-1 cl. 7.5: where a table's structure is not determinable via
    Headers and IDs, TH elements shall carry Scope. Missing headers is the
    clause's `should`; a header with no scope is its `shall`."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _table(
        pdf, page,
        [
            [("Region", {"_role": "TH"}), ("Revenue", {"_role": "TH"})],
            [("North", {}), ("120", {})],
        ],
        table_extra={"Summary": String("Revenue by region")},
    )
    make_conformant(pdf, page)
    return save(pdf, path)


def table_ragged(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _table(
        pdf, page,
        [
            [("Region", {"_role": "TH", "Scope": Name.Column}),
             ("Revenue", {"_role": "TH", "Scope": Name.Column})],
            [("North", {})],
        ],
        table_extra={"Summary": String("Revenue by region")},
    )
    make_conformant(pdf, page)
    return save(pdf, path)


def table_colspan_regular_ok(path):
    """PASS fixture — a regular table whose first row is one spanning cell.
    Span arithmetic read as raggedness is the single most likely false failure
    this checker could ship."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _table(
        pdf, page,
        [
            [("Revenue by region", {"_role": "TH", "Scope": Name.Column,
                                    "ColSpan": 2})],
            [("North", {}), ("120", {})],
            [("South", {}), ("90", {})],
        ],
        table_extra={"Summary": String("Revenue by region")},
    )
    make_conformant(pdf, page)
    return save(pdf, path)


def table_rowspan_regular_ok(path):
    """PASS fixture — the /RowSpan half of the same arithmetic."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _table(
        pdf, page,
        [
            [("Region", {"_role": "TH", "Scope": Name.Column, "RowSpan": 2}),
             ("2025", {"_role": "TH", "Scope": Name.Column})],
            [("2026", {"_role": "TH", "Scope": Name.Column})],
            [("North", {}), ("120", {})],
        ],
        table_extra={"Summary": String("Revenue by region")},
    )
    make_conformant(pdf, page)
    return save(pdf, path)


def table_no_summary(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _table(
        pdf, page,
        [
            [("Region", {"_role": "TH", "Scope": Name.Column}),
             ("Revenue", {"_role": "TH", "Scope": Name.Column})],
            [("North", {}), ("120", {})],
        ],
    )
    make_conformant(pdf, page)
    return save(pdf, path)


# ── lists ─────────────────────────────────────────────────────────────────


def li_outside_l(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
        "/LBody <</MCID 1>> BDC BT /F1 11 Tf 60 660 Td (An item.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    lbl = elem(pdf, "Lbl", doc, page=page)
    body = elem(pdf, "LBody", doc, page=page, mcid=1)
    item = elem(pdf, "LI", doc, kids=[lbl, body])
    doc[Name.K] = Array([para, item])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, body])
    make_conformant(pdf, page)
    return save(pdf, path)


def lbody_no_lbl_ok(path):
    """PASS fixture — ISO 14289-1 cl. 7.6 makes Lbl and LBody MAY, so a list
    item with a body and no label is conforming."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
        "/LBody <</MCID 1>> BDC BT /F1 11 Tf 60 660 Td (An item.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    body = elem(pdf, "LBody", doc, page=page, mcid=1)
    item = elem(pdf, "LI", doc, kids=[body])
    lst = elem(pdf, "L", doc, kids=[item])
    doc[Name.K] = Array([para, lst])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, body])
    make_conformant(pdf, page)
    return save(pdf, path)


def lbl_outside_list_item_ok(path):
    """PASS fixture — a footnote's `Lbl` is a label on something that is not a
    list item, alongside a well-formed list so the check still has work."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
        "/Lbl <</MCID 1>> BDC BT /F1 11 Tf 40 660 Td (1.) Tj ET EMC\n"
        "/LBody <</MCID 2>> BDC BT /F1 11 Tf 60 660 Td (An item.) Tj ET EMC\n"
        "/Lbl <</MCID 3>> BDC BT /F1 9 Tf 40 100 Td (a) Tj ET EMC\n"
        "/P <</MCID 4>> BDC BT /F1 9 Tf 52 100 Td (A footnote.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    lbl = elem(pdf, "Lbl", doc, page=page, mcid=1)
    body = elem(pdf, "LBody", doc, page=page, mcid=2)
    item = elem(pdf, "LI", doc, kids=[lbl, body])
    lst = elem(pdf, "L", doc, kids=[item])
    note_lbl = elem(pdf, "Lbl", doc, page=page, mcid=3)
    note_body = elem(pdf, "P", doc, page=page, mcid=4)
    note = elem(pdf, "Note", doc, kids=[note_lbl, note_body])
    doc[Name.K] = Array([para, lst, note])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, lbl, body, note_lbl, note_body])
    make_conformant(pdf, page)
    return save(pdf, path)


def _div_wrapped_item(pdf, page, container):
    """A well-formed list item inside a `Div` inside `container`.

    ISO 32000-2 Table 365 makes `Div` inherit its parent's containment, so the
    item's placement is the container's to answer. `container` is what decides
    whether that is legal: an `L` places the item correctly, anything else does
    not, and the `Div` does not change the answer either way.
    """
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
        "/Lbl <</MCID 1>> BDC BT /F1 11 Tf 40 660 Td (1.) Tj ET EMC\n"
        "/LBody <</MCID 2>> BDC BT /F1 11 Tf 60 660 Td (An item.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    lbl = elem(pdf, "Lbl", doc, page=page, mcid=1)
    body = elem(pdf, "LBody", doc, page=page, mcid=2)
    item = elem(pdf, "LI", doc, kids=[lbl, body])
    div = elem(pdf, "Div", doc, kids=[item])
    outer = elem(pdf, container, doc, kids=[div])
    doc[Name.K] = Array([para, outer])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, lbl, body])


def li_in_div_in_l_ok(path):
    """PASS fixture — the list item is inside the list, reached through the
    `Div` that inherits the list's containment."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _div_wrapped_item(pdf, page, "L")
    make_conformant(pdf, page)
    return save(pdf, path)


def li_under_div_under_sect_fails(path):
    """The same `Div` over a `Sect`, which is no list: reading through a
    grouping element reaches the real container rather than laundering the
    violation, so the item is still misplaced."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _div_wrapped_item(pdf, page, "Sect")
    make_conformant(pdf, page)
    return save(pdf, path)


# ── structure nesting ─────────────────────────────────────────────────────


def _ns_list_page(pdf, page, extra_lbl=False, link_lbl=False, footnote=False):
    """One list in the PDF 2.0 standard structure namespace, with the three
    shapes the nesting rules disagree about switched on individually.

    `extra_lbl` hangs a second `Lbl` off the `L` itself, which is the position
    ISO 32000-2 Table L.2 does not list for `Lbl`; the other two are positions
    it does list.
    """
    parts = [
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC",
        "/Lbl <</MCID 1>> BDC BT /F1 11 Tf 40 660 Td (1.) Tj ET EMC",
        "/LBody <</MCID 2>> BDC BT /F1 11 Tf 60 660 Td (An item.) Tj ET EMC",
        "/Lbl <</MCID 3>> BDC BT /F1 11 Tf 40 620 Td (a) Tj ET EMC",
    ]
    draw(pdf, page, "\n".join(parts))
    root = struct_root(pdf)
    ns = namespace(pdf, root)
    doc = elem(pdf, "Document", root, NS=ns)
    para = elem(pdf, "P", doc, page=page, mcid=0, NS=ns)
    lbl = elem(pdf, "Lbl", doc, page=page, mcid=1, NS=ns)
    order = [para, lbl]
    body_kids = None
    if link_lbl:
        # ISO 14289-1 cl. 7.18.1 asks every Link for an alternate description;
        # this fixture is about where the label sits, so it carries one.
        link = elem(pdf, "Link", doc, page=page, NS=ns, Alt=String("Contents entry"))
        inner = elem(pdf, "Lbl", link, page=page, mcid=3, NS=ns)
        # The link's own content sits alongside the label it encloses, so the
        # element has text of its own to be named by.
        link[Name.K] = Array([2, inner])
        body_kids = [link]
        order += [link, inner]
    body = elem(pdf, "LBody", doc, page=page, mcid=None if body_kids else 2,
                kids=body_kids, NS=ns)
    if not link_lbl:
        order.append(body)
    item = elem(pdf, "LI", doc, kids=[lbl, body], NS=ns)
    kids = [item]
    if extra_lbl:
        stray = elem(pdf, "Lbl", doc, page=page, mcid=3, NS=ns)
        kids.append(stray)
        order.append(stray)
    lst = elem(pdf, "L", doc, kids=kids, NS=ns)
    top = [para, lst]
    if footnote:
        note_lbl = elem(pdf, "Lbl", doc, page=page, mcid=3, NS=ns)
        note = elem(pdf, "FENote", doc, kids=[note_lbl], NS=ns)
        top.append(note)
        order.append(note_lbl)
    doc[Name.K] = Array(top)
    root[Name.K] = doc
    parent_tree(pdf, root, page, order)
    return root, doc, lst


def lbl_under_li_ok(path):
    """PASS fixture — the ordinary list label, in the namespace whose table
    lists `LI` among `Lbl`'s parents."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _ns_list_page(pdf, page)
    make_conformant(pdf, page)
    return save(pdf, path)


def lbl_in_fenote_ok(path):
    """PASS fixture — a footnote's label. `FENote` is the PDF 2.0 footnote
    type, and Table L.2 lists it among `Lbl`'s parents."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _ns_list_page(pdf, page, footnote=True)
    make_conformant(pdf, page)
    return save(pdf, path)


def toc_link_lbl_ok(path):
    """PASS fixture — a table-of-contents entry, whose label sits inside the
    entry's `Link`."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _ns_list_page(pdf, page, link_lbl=True)
    make_conformant(pdf, page)
    return save(pdf, path)


def lbl_under_l_fails(path):
    """A second `Lbl` hung off the `L` itself rather than off a list item —
    the position no shipped check reported and the one this row was opened
    for."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _ns_list_page(pdf, page, extra_lbl=True)
    make_conformant(pdf, page)
    return save(pdf, path)


def _row_group_table(pdf, page, stray_row_group=False):
    """A two-column table whose rows sit in `THead` and `TBody`.

    `stray_row_group` hangs an EMPTY second `THead` off the document. Empty
    keeps the one thing under test to the row group's own position: a stray
    group carrying rows would move the row and header checks as well.
    """
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 740 Td (Body copy.) Tj ET EMC\n"
        "/TH <</MCID 1>> BDC BT /F1 11 Tf 40 700 Td (Region) Tj ET EMC\n"
        "/TH <</MCID 2>> BDC BT /F1 11 Tf 160 700 Td (Revenue) Tj ET EMC\n"
        "/TD <</MCID 3>> BDC BT /F1 11 Tf 40 670 Td (North) Tj ET EMC\n"
        "/TD <</MCID 4>> BDC BT /F1 11 Tf 160 670 Td (120) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    h1 = elem(pdf, "TH", doc, page=page, mcid=1, Scope=Name.Column)
    h2 = elem(pdf, "TH", doc, page=page, mcid=2, Scope=Name.Column)
    d1 = elem(pdf, "TD", doc, page=page, mcid=3)
    d2 = elem(pdf, "TD", doc, page=page, mcid=4)
    head_row = elem(pdf, "TR", doc, kids=[h1, h2])
    body_row = elem(pdf, "TR", doc, kids=[d1, d2])
    head = elem(pdf, "THead", doc, kids=[head_row])
    body = elem(pdf, "TBody", doc, kids=[body_row])
    table = elem(pdf, "Table", doc, kids=[head, body],
                 Summary=String("Revenue by region"))
    top = [para, table]
    if stray_row_group:
        top.append(elem(pdf, "THead", doc, page=page))
    doc[Name.K] = Array(top)
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, h1, h2, d1, d2])


def thead_tbody_ok(path):
    """PASS fixture — the row groups a real table uses, correctly nested."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _row_group_table(pdf, page)
    make_conformant(pdf, page)
    return save(pdf, path)


def thead_outside_table_fails(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _row_group_table(pdf, page, stray_row_group=True)
    make_conformant(pdf, page)
    return save(pdf, path)


def lbody_outside_li_fails(path):
    """An `LBody` hung off the `L` rather than off a list item. Placement of
    `LBody` is `list_labels`' answer, so this fixture pins that the nesting
    check judges it and reports nothing."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
        "/Lbl <</MCID 1>> BDC BT /F1 11 Tf 40 660 Td (1.) Tj ET EMC\n"
        "/LBody <</MCID 2>> BDC BT /F1 11 Tf 60 660 Td (An item.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    lbl = elem(pdf, "Lbl", doc, page=page, mcid=1)
    body = elem(pdf, "LBody", doc, page=page, mcid=2)
    item = elem(pdf, "LI", doc, kids=[lbl])
    lst = elem(pdf, "L", doc, kids=[item, body])
    doc[Name.K] = Array([para, lst])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, lbl, body])
    make_conformant(pdf, page)
    return save(pdf, path)


def custom_mapped_to_li_judged_as_li(path):
    """A private tag role mapped to `LI`, outside any list. The nesting walk
    reads the resolved role, so this is judged as the list item it maps to
    rather than as a type no table covers."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
        "/LBody <</MCID 1>> BDC BT /F1 11 Tf 60 660 Td (An item.) Tj ET EMC",
    )
    root = struct_root(pdf, role_map={"Punkt": "LI"})
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    lbl = elem(pdf, "Lbl", doc, page=page)
    body = elem(pdf, "LBody", doc, page=page, mcid=1)
    item = elem(pdf, "Punkt", doc, kids=[lbl, body])
    doc[Name.K] = Array([para, item])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, body])
    make_conformant(pdf, page)
    return save(pdf, path)


def _inline_assembly(pdf, page, container, tags):
    """One `Ruby` or `Warichu` assembly holding `tags` in the order given.

    Each child is drawn on its own line down the page in tree order, so tag
    order and page order agree and the only thing that can move is the content
    model of the container. Real ruby sets its annotation beside the base text;
    a fixture that did would move the reading-order check as well.
    """
    parts = ["/P <</MCID 0>> BDC BT /F1 11 Tf 40 740 Td (Body copy.) Tj ET EMC"]
    for i, tag in enumerate(tags):
        parts.append(
            f"/{tag} <</MCID {i + 1}>> BDC BT /F1 11 Tf 40 {700 - i * 30} Td "
            f"(Text {i + 1}) Tj ET EMC"
        )
    draw(pdf, page, "\n".join(parts))
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    kids = [elem(pdf, tag, doc, page=page, mcid=i + 1) for i, tag in enumerate(tags)]
    assembly = elem(pdf, container, doc, kids=kids)
    doc[Name.K] = Array([para, assembly])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, *kids])


def ruby_rb_rt_ok(path):
    """PASS fixture — ISO 32000-2 Table 369's shorter ruby: one `RB` followed
    by an `RT`."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _inline_assembly(pdf, page, "Ruby", ["RB", "RT"])
    make_conformant(pdf, page)
    return save(pdf, path)


def ruby_four_child_ok(path):
    """PASS fixture — Table 369's other ruby: one `RB` followed by the
    three-element sequence `RP`, `RT`, `RP`. A check that only counted
    children, or only read the first two, would fail this."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _inline_assembly(pdf, page, "Ruby", ["RB", "RP", "RT", "RP"])
    make_conformant(pdf, page)
    return save(pdf, path)


def warichu_wp_wt_wp_ok(path):
    """PASS fixture — Table 369's warichu sequence, complete."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _inline_assembly(pdf, page, "Warichu", ["WP", "WT", "WP"])
    make_conformant(pdf, page)
    return save(pdf, path)


def ruby_annotation_before_base_fails(path):
    """The right children in the wrong order: Table 369 puts the `RB` first."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _inline_assembly(pdf, page, "Ruby", ["RT", "RB"])
    make_conformant(pdf, page)
    return save(pdf, path)


def ruby_two_bases_fails(path):
    """The right children in the right order, one too many: Table 369 admits
    ONE `RB`."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _inline_assembly(pdf, page, "Ruby", ["RB", "RB", "RT"])
    make_conformant(pdf, page)
    return save(pdf, path)


def warichu_unclosed_fails(path):
    """A warichu missing its closing punctuation. Every child is one Table 369
    admits, so a membership-only reading calls this conformant."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _inline_assembly(pdf, page, "Warichu", ["WP", "WT"])
    make_conformant(pdf, page)
    return save(pdf, path)


# ── headings ──────────────────────────────────────────────────────────────


def _headings(pdf, page, tags, role_map=None):
    """Headings down the page, then the body copy below them — tree order and
    page order agree, so the reading-order check has nothing to say and the
    only thing under test is the heading levelling."""
    parts = []
    for i, tag in enumerate(tags):
        parts.append(
            f"/{tag} <</MCID {i}>> BDC BT /F1 {20 - i} Tf 40 {740 - i * 40} Td "
            f"(Heading {i + 1}) Tj ET EMC"
        )
    body_mcid = len(tags)
    parts.append(
        f"/P <</MCID {body_mcid}>> BDC BT /F1 11 Tf 40 500 Td (Body copy.) Tj ET EMC"
    )
    draw(pdf, page, "\n".join(parts))
    root = struct_root(pdf, role_map)
    doc = elem(pdf, "Document", root)
    kids = []
    for i, tag in enumerate(tags):
        kids.append(elem(pdf, tag, doc, page=page, mcid=i))
    kids.append(elem(pdf, "P", doc, page=page, mcid=body_mcid))
    doc[Name.K] = Array(kids)
    root[Name.K] = doc
    parent_tree(pdf, root, page, kids)


def heading_skip(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _headings(pdf, page, ["H1", "H3"])
    make_conformant(pdf, page)
    return save(pdf, path)


def heading_starts_at_h2_fails(path):
    """ISO 14289-1 cl. 7.4.2: where any heading tags are used, H1 shall be
    the first. A document opening at H2 has skipped the level above it."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _headings(pdf, page, ["H2", "H3"])
    make_conformant(pdf, page)
    return save(pdf, path)


def rolemap_custom_tags_ok(path):
    """PASS fixture — private tag names mapped to standard roles through
    /RoleMap must not fail anything a standard-named document passes."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _headings(pdf, page, ["Kop1", "Kop2"],
              role_map={"Kop1": "H1", "Kop2": "H2", "Alinea": "P"})
    make_conformant(pdf, page)
    return save(pdf, path)


# ── the roster the tests walk ─────────────────────────────────────────────

# Checks that share ONE inventory and therefore move together. Screen flicker,
# scripts and timed responses are three questions about the same list of
# script sites, so a document carrying one script moves all three; a fixture
# for any of them cannot isolate the other two, and pretending otherwise would
# mean building three documents that differ in nothing that matters.
SHARED_INVENTORY = (
    frozenset({"screen_flicker", "scripts", "timed_responses"}),
)


def moves_with(check_id: str) -> frozenset:
    """Every check a fixture for `check_id` is allowed to move."""
    for group in SHARED_INVENTORY:
        if check_id in group:
            return group
    return frozenset({check_id})


# name → (builder, the check it is about, the verdict that check must report).
# A `_ok` name is a PASS fixture: a conforming shape whose check must NOT
# report a failure.
ROSTER = {
    "baseline": (baseline, None, None),
    "untagged": (untagged, "tagged", "fail"),
    "perm_blocked": (perm_blocked, "permissions", "fail"),
    "perm_blocked_owner_password": (perm_blocked_owner_password, "permissions", "fail"),
    "no_lang": (no_lang, "lang", "fail"),
    "lang_on_elements_ok": (lang_on_elements_ok, "lang", "pass"),
    "lang_inherited_ok": (lang_inherited_ok, "lang", "pass"),
    "lang_empty_is_unknown": (lang_empty_is_unknown, "lang", "fail"),
    "no_title": (no_title, "title", "fail"),
    "title_not_displayed": (title_not_displayed, "title", "fail"),
    "title_docinfo_only": (title_docinfo_only, "title", "fail"),
    "no_bookmarks_long": (no_bookmarks_long, "bookmarks", "warn"),
    "no_bookmarks_long_with_headings": (no_bookmarks_long_with_headings, "bookmarks", "warn"),
    "low_contrast": (low_contrast, "contrast", "fail"),
    "contrast_over_image_ok": (contrast_over_image_ok, "contrast", "needs_review"),
    "large_text_contrast_ok": (large_text_contrast_ok, "contrast", "pass"),
    "untagged_content": (untagged_content, "tagged_content", "fail"),
    "artifact_declared_ok": (artifact_declared_ok, "tagged_content", "pass"),
    "untagged_annotation": (untagged_annotation, "tagged_annotations", "fail"),
    "no_tabs": (no_tabs, "tab_order", "fail"),
    "bad_encoding": (bad_encoding, "character_encoding", "fail"),
    "blank_runs_ok": (blank_runs_ok, "character_encoding", "pass"),
    "untagged_multimedia": (untagged_multimedia, "tagged_multimedia", "fail"),
    "has_scripts": (has_scripts, "scripts", "needs_review"),
    "repetitive_links": (repetitive_links, "navigation_links", "needs_review"),
    "untagged_field": (untagged_field, "tagged_form_fields", "fail"),
    "field_no_tu": (field_no_tu, "field_descriptions", "fail"),
    "field_named_by_element_ok": (field_named_by_element_ok, "field_descriptions", "pass"),
    "hidden_field_ok": (hidden_field_ok, "field_descriptions", "not_applicable"),
    "zero_area_field_ok": (zero_area_field_ok, "field_descriptions", "not_applicable"),
    "figure_no_alt": (figure_no_alt, "figures_alt", "fail"),
    "figure_actual_text_ok": (figure_actual_text_ok, "figures_alt", "pass"),
    "figure_empty_actual_text_ok": (figure_empty_actual_text_ok, "figures_alt", "pass"),
    "formula_no_alt": (formula_no_alt, "figures_alt", "fail"),
    "nested_alt": (nested_alt, "nested_alt", "fail"),
    "alt_no_content": (alt_no_content, "alt_no_content", "fail"),
    "alt_hides_annot": (alt_hides_annot, "alt_hides_annotation", "fail"),
    "link_no_alt": (link_no_alt, "other_elements_alt", "fail"),
    "tr_outside_table": (tr_outside_table, "table_rows", "fail"),
    "td_outside_tr": (td_outside_tr, "table_cells", "fail"),
    "table_no_headers": (table_no_headers, "table_headers", "warn"),
    "th_no_scope": (th_no_scope, "table_headers", "fail"),
    "table_headers_ok": (table_headers_ok, "table_headers", "pass"),
    "table_ragged": (table_ragged, "table_regularity", "fail"),
    "table_colspan_regular_ok": (table_colspan_regular_ok, "table_regularity", "pass"),
    "table_rowspan_regular_ok": (table_rowspan_regular_ok, "table_regularity", "pass"),
    "table_no_summary": (table_no_summary, "table_summary", "warn"),
    "li_outside_l": (li_outside_l, "list_items", "fail"),
    "lbody_no_lbl_ok": (lbody_no_lbl_ok, "list_labels", "pass"),
    "lbl_outside_list_item_ok": (lbl_outside_list_item_ok, "list_labels", "pass"),
    "li_in_div_in_l_ok": (li_in_div_in_l_ok, "list_items", "pass"),
    "li_under_div_under_sect_fails": (li_under_div_under_sect_fails, "list_items", "fail"),
    "lbl_under_li_ok": (lbl_under_li_ok, "structure_nesting", "pass"),
    "lbl_in_fenote_ok": (lbl_in_fenote_ok, "structure_nesting", "pass"),
    "toc_link_lbl_ok": (toc_link_lbl_ok, "structure_nesting", "pass"),
    "thead_tbody_ok": (thead_tbody_ok, "structure_nesting", "pass"),
    "lbl_under_l_fails": (lbl_under_l_fails, "structure_nesting", "fail"),
    "thead_outside_table_fails": (thead_outside_table_fails, "structure_nesting", "fail"),
    "ruby_rb_rt_ok": (ruby_rb_rt_ok, "structure_nesting", "pass"),
    "ruby_four_child_ok": (ruby_four_child_ok, "structure_nesting", "pass"),
    "warichu_wp_wt_wp_ok": (warichu_wp_wt_wp_ok, "structure_nesting", "pass"),
    "ruby_annotation_before_base_fails": (
        ruby_annotation_before_base_fails, "structure_nesting", "fail",
    ),
    "ruby_two_bases_fails": (ruby_two_bases_fails, "structure_nesting", "fail"),
    "warichu_unclosed_fails": (warichu_unclosed_fails, "structure_nesting", "fail"),
    "lbody_outside_li_fails": (lbody_outside_li_fails, "list_labels", "fail"),
    "custom_mapped_to_li_judged_as_li": (
        custom_mapped_to_li_judged_as_li, "list_items", "fail",
    ),
    "heading_skip": (heading_skip, "heading_nesting", "fail"),
    "heading_starts_at_h2_fails": (heading_starts_at_h2_fails, "heading_nesting", "fail"),
    "rolemap_custom_tags_ok": (rolemap_custom_tags_ok, "heading_nesting", "pass"),
}
