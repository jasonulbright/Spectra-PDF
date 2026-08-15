"""Fixtures for the accessibility checker, built in code.

The `derived_nav_builders` discipline: every document here is small enough to
read in one screen and fails EXACTLY ONE check, so a verdict that moves can
only have come from the check that owns it. The four documents whose names end
in `_ok` are the false-failure guards — each is a CONFORMING shape a naive
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


def no_lang(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    make_conformant(pdf, page)
    del pdf.Root[Name.Lang]
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
    link element carries its own text AND its OBJR, which is the conforming
    shape — the only thing wrong with this document is the labelling."""
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


def field_no_tu(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    field = _annot(pdf, page, "Widget", [300, 500, 500, 520], FT=Name.Tx, T=String("name"))
    tagged = elem(pdf, "Form", doc, page=page,
                  kids=[Dictionary(Type=Name.OBJR, Obj=field)], Alt=String("Name field"))
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


def lbody_no_lbl(path):
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


def heading_starts_at_h2_ok(path):
    """PASS fixture — a section extracted from a larger document legitimately
    starts at H2."""
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
    "no_lang": (no_lang, "lang", "fail"),
    "no_title": (no_title, "title", "fail"),
    "title_not_displayed": (title_not_displayed, "title", "warn"),
    "no_bookmarks_long": (no_bookmarks_long, "bookmarks", "warn"),
    "low_contrast": (low_contrast, "contrast", "fail"),
    "contrast_over_image_ok": (contrast_over_image_ok, "contrast", "needs_review"),
    "large_text_contrast_ok": (large_text_contrast_ok, "contrast", "pass"),
    "untagged_content": (untagged_content, "tagged_content", "fail"),
    "artifact_declared_ok": (artifact_declared_ok, "tagged_content", "pass"),
    "untagged_annotation": (untagged_annotation, "tagged_annotations", "fail"),
    "no_tabs": (no_tabs, "tab_order", "fail"),
    "bad_encoding": (bad_encoding, "character_encoding", "fail"),
    "untagged_multimedia": (untagged_multimedia, "tagged_multimedia", "fail"),
    "has_scripts": (has_scripts, "scripts", "needs_review"),
    "repetitive_links": (repetitive_links, "navigation_links", "needs_review"),
    "untagged_field": (untagged_field, "tagged_form_fields", "fail"),
    "field_no_tu": (field_no_tu, "field_descriptions", "fail"),
    "figure_no_alt": (figure_no_alt, "figures_alt", "fail"),
    "figure_actual_text_ok": (figure_actual_text_ok, "figures_alt", "pass"),
    "nested_alt": (nested_alt, "nested_alt", "fail"),
    "alt_no_content": (alt_no_content, "alt_no_content", "fail"),
    "alt_hides_annot": (alt_hides_annot, "alt_hides_annotation", "fail"),
    "link_no_alt": (link_no_alt, "other_elements_alt", "fail"),
    "tr_outside_table": (tr_outside_table, "table_rows", "fail"),
    "td_outside_tr": (td_outside_tr, "table_cells", "fail"),
    "table_no_headers": (table_no_headers, "table_headers", "fail"),
    "table_headers_ok": (table_headers_ok, "table_headers", "pass"),
    "table_ragged": (table_ragged, "table_regularity", "fail"),
    "table_colspan_regular_ok": (table_colspan_regular_ok, "table_regularity", "pass"),
    "table_rowspan_regular_ok": (table_rowspan_regular_ok, "table_regularity", "pass"),
    "table_no_summary": (table_no_summary, "table_summary", "warn"),
    "li_outside_l": (li_outside_l, "list_items", "fail"),
    "lbody_no_lbl": (lbody_no_lbl, "list_labels", "warn"),
    "heading_skip": (heading_skip, "heading_nesting", "fail"),
    "heading_starts_at_h2_ok": (heading_starts_at_h2_ok, "heading_nesting", "pass"),
    "rolemap_custom_tags_ok": (rolemap_custom_tags_ok, "heading_nesting", "pass"),
}
