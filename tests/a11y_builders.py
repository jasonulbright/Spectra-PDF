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


# The glyphs every synthesized program below defines. Small enough to compile
# in milliseconds, wide enough to spell the fixture text.
_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.:, "

# A fixed timestamp in the compiled program. The face's own `head.modified`
# travels into the file, so leaving it at the run's clock would make two builds
# of the same fixture differ in bytes for no reason a reader could name.
_EPOCH = 0


def _glyph_name(character: str) -> str:
    from fontTools.agl import UV2AGL

    return UV2AGL.get(ord(character), "")


def _character_map() -> dict:
    """codepoint → the Adobe Glyph List name for it. Cl. 7.21.6 makes AGL
    membership a requirement in its own right, so the fixtures' glyphs are
    named from the list rather than invented."""
    return {ord(c): _glyph_name(c) for c in _CHARACTERS if _glyph_name(c)}


_GLYPHS = [".notdef"] + sorted(set(_character_map().values()))


def _outline(pen) -> None:
    """One filled box. What the glyph LOOKS like is not what any of these
    fixtures are about; that it has an outline at all is."""
    pen.moveTo((50, 0))
    pen.lineTo((450, 0))
    pen.lineTo((450, 700))
    pen.lineTo((50, 700))
    pen.closePath()


def _builder(is_ttf: bool):
    from fontTools.fontBuilder import FontBuilder

    fb = FontBuilder(1000, isTTF=is_ttf)
    fb.setupGlyphOrder(_GLYPHS)
    return fb


def _finish(fb, family: str) -> None:
    fb.setupHorizontalMetrics({name: (500, 50) for name in _GLYPHS})
    fb.setupHorizontalHeader(ascent=750, descent=-250)
    fb.setupNameTable({"familyName": family, "styleName": "Regular",
                       "psName": family, "fullName": family})


_PROGRAMS: dict = {}


def type1c_program(family="TestSerif") -> bytes:
    """A compact font format program, as a `/FontFile3` of subtype Type1C
    carries it — the bare `CFF ` table, not the OpenType wrapper."""
    from io import BytesIO

    from fontTools.pens.t2CharStringPen import T2CharStringPen
    from fontTools.ttLib import TTFont

    key = ("cff", family)
    if key in _PROGRAMS:
        return _PROGRAMS[key]
    fb = _builder(is_ttf=False)
    fb.setupCharacterMap(_character_map())
    charstrings = {}
    for name in _GLYPHS:
        pen = T2CharStringPen(500, None)
        if name not in (".notdef", "space"):
            _outline(pen)
        charstrings[name] = pen.getCharString()
    fb.setupCFF(family, {"FullName": family}, charstrings, {})
    _finish(fb, family)
    fb.setupOS2()
    fb.setupPost()
    fb.font["head"].created = fb.font["head"].modified = _EPOCH
    buf = BytesIO()
    fb.save(buf)
    buf.seek(0)
    _PROGRAMS[key] = TTFont(buf).reader["CFF "]
    return _PROGRAMS[key]


def truetype_program(subtables=((3, 1),), family="TestSans", characters=None) -> bytes:
    """A TrueType program whose `cmap` holds exactly the (platform, encoding)
    subtables asked for — the fact ISO 14289-1 cl. 7.21.6 turns on. An empty
    roster produces a program with no `cmap` table at all, which is the shape
    an embedded CIDFont program takes."""
    from io import BytesIO

    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from fontTools.ttLib import TTFont

    key = ("ttf", family, tuple(subtables), characters)
    if key in _PROGRAMS:
        return _PROGRAMS[key]
    fb = _builder(is_ttf=True)
    glyphs = {}
    for name in _GLYPHS:
        pen = TTGlyphPen(None)
        if name not in (".notdef", "space"):
            _outline(pen)
        glyphs[name] = pen.glyph()
    fb.setupGlyf(glyphs)
    _finish(fb, family)
    mapping = _character_map()
    if characters is not None:
        mapping = {code: name for code, name in mapping.items()
                   if chr(code) in characters}
    fb.setupCharacterMap(mapping)
    fb.setupOS2()
    fb.setupPost()
    fb.font["head"].created = fb.font["head"].modified = _EPOCH
    built = fb.font["cmap"].tables
    template = built[0]
    wanted = []
    for platform_id, encoding_id in subtables:
        import copy

        subtable = copy.deepcopy(template)
        subtable.platformID = platform_id
        subtable.platEncID = encoding_id
        subtable.language = 0
        wanted.append(subtable)
    if wanted:
        fb.font["cmap"].tables = wanted
    else:
        del fb.font["cmap"]
    buf = BytesIO()
    fb.save(buf)
    _PROGRAMS[key] = buf.getvalue()
    return _PROGRAMS[key]


def symbol_type1c_program(family="TestSymbol") -> bytes:
    """A compact-font-format program that states nothing about characters: its
    glyphs are named `g1`…`gN`, which are not Adobe Glyph List names, and it
    carries no character map at all.

    That is what a genuine symbol font looks like, and it is why a font like
    this needs a `/ToUnicode` before anything can read the text it draws.
    """
    from io import BytesIO

    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.t2CharStringPen import T2CharStringPen
    from fontTools.ttLib import TTFont

    key = ("symbol", family)
    if key in _PROGRAMS:
        return _PROGRAMS[key]
    names = [".notdef"] + [f"g{i}" for i in range(1, 5)]
    fb = FontBuilder(1000, isTTF=False)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({})
    charstrings = {}
    for name in names:
        pen = T2CharStringPen(500, None)
        if name != ".notdef":
            _outline(pen)
        charstrings[name] = pen.getCharString()
    fb.setupCFF(family, {"FullName": family}, charstrings, {})
    fb.setupHorizontalMetrics({name: (500, 50) for name in names})
    fb.setupHorizontalHeader(ascent=750, descent=-250)
    fb.setupNameTable({"familyName": family, "styleName": "Regular",
                       "psName": family, "fullName": family})
    fb.setupOS2()
    fb.setupPost()
    fb.font["head"].created = fb.font["head"].modified = _EPOCH
    buf = BytesIO()
    fb.save(buf)
    buf.seek(0)
    _PROGRAMS[key] = TTFont(buf).reader["CFF "]
    return _PROGRAMS[key]


def _font(pdf, base="Helvetica"):
    """The fixtures' body font, EMBEDDED.

    ISO 14289-1 cl. 7.21.4.1 NOTE 5 states there is no exemption from the
    embedding requirement for the 14 standard Type 1 fonts, so a fixture whose
    text is drawn with an unembedded Helvetica is not the conforming baseline
    the rest of this file assumes. The dictionary still describes the standard
    font, with standard metrics; the program behind it is a synthesized Type1C
    with the same advance width for every glyph.
    """
    program = pdf.make_stream(type1c_program())
    program[Name.Subtype] = Name("/Type1C")
    return pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name("/" + base),
            Encoding=Name.WinAnsiEncoding,
            FontDescriptor=pdf.make_indirect(
                Dictionary(Type=Name.FontDescriptor, FontName=Name("/" + base),
                           Flags=32, ItalicAngle=0, Ascent=750, Descent=-250,
                           CapHeight=700, StemV=80,
                           FontBBox=Array([0, -250, 1000, 750]),
                           FontFile3=program)
            ),
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


def _one_tagged_paragraph(pdf, page, text="Readable body copy at eleven points.",
                          role_map=None):
    draw(pdf, page, f"/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td ({text}) Tj ET EMC")
    root = struct_root(pdf, role_map=role_map)
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
        "/Artifact <</Type /Background>> BDC 0.85 0.85 0.85 rg 40 600 400 20 re f EMC\n"
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
        # The backdrop is decoration and says so: ISO 14289-1 cl. 7.1 divides
        # content into real content and artifacts, and an image painted under
        # neither is its own defect this fixture is not about.
        b"/Artifact <</Type /Background>> BDC q 400 0 0 40 40 590 cm /Im0 Do Q EMC\n"
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
    map to no character, so the text reads as nothing.

    The program IS embedded, so cl. 7.21.4.1 is satisfied and the only thing
    this document is missing is the statement of what its bytes spell. It is
    a Type 1 font because cl. 7.21.6's encoding rules are written for TrueType
    fonts: a symbolic TrueType would carry a second conformance question, and
    a fixture that failed two checks could not attribute either.
    """
    pdf = new_pdf()
    page = pdf.pages[0]
    program = pdf.make_stream(symbol_type1c_program())
    program[Name.Subtype] = Name("/Type1C")
    font = pdf.make_indirect(
        Dictionary(
            Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/Private"),
            FirstChar=65, LastChar=67, Widths=Array([500, 500, 500]),
            FontDescriptor=pdf.make_indirect(
                Dictionary(Type=Name.FontDescriptor, FontName=Name("/Private"),
                           Flags=4, ItalicAngle=0, Ascent=700, Descent=-200,
                           CapHeight=700, StemV=80,
                           FontBBox=Array([0, -200, 1000, 700]),
                           FontFile3=program)
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


def _tagged_field(pdf, page, doc, widget_extra=None, form_extra=None, tag="Form"):
    field = _annot(pdf, page, "Widget", [300, 500, 500, 520], FT=Name.Tx,
                   T=String("name"), **(widget_extra or {}))
    tagged = elem(pdf, tag, doc, page=page,
                  kids=[Dictionary(Type=Name.OBJR, Obj=field)], **(form_extra or {}))
    doc[Name.K] = Array(list(doc[Name.K]) + [tagged])
    pdf.Root[Name.AcroForm] = pdf.make_indirect(
        Dictionary(Fields=Array([field]), DA=String("/Helv 0 Tf 0 g"))
    )
    return field, tagged


def field_in_form_ok(path):
    """PASS fixture — ISO 14289-1 7.18.4: the widget is nested within a `Form`
    tag, which is what the requirement asks for."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    _tagged_field(pdf, page, doc, widget_extra={"TU": String("Your full name")})
    make_conformant(pdf, page)
    return save(pdf, path)


def field_tagged_outside_form(path):
    """The widget IS in the structure tree — under a `P`. Tree membership is
    not the requirement; ISO 14289-1 7.18.4 asks for a `Form` tag."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    _tagged_field(pdf, page, doc, tag="P",
                  widget_extra={"TU": String("Your full name")})
    make_conformant(pdf, page)
    return save(pdf, path)


def field_in_role_mapped_form_ok(path):
    """PASS fixture — the enclosing element's type is a custom name that
    `/RoleMap` maps to `Form`, so the element's role IS `Form`."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page, role_map={"Formulier": "Form"})
    _tagged_field(pdf, page, doc, tag="Formulier",
                  widget_extra={"TU": String("Your full name")})
    make_conformant(pdf, page)
    return save(pdf, path)


def _nested_tagged_field(pdf, page, doc, outer, inner, widget_extra=None):
    """A widget held by an `inner` element that is itself inside `outer`.

    The `outer` element carries a TITLE, not a description: it keeps that
    element's own alt-text check quiet so the only verdict these fixtures move
    is the nesting one.
    """
    field = _annot(pdf, page, "Widget", [300, 500, 500, 520], FT=Name.Tx,
                   T=String("name"), **(widget_extra or {}))
    outer_elem = elem(pdf, outer, doc, page=page, T=String("Name field"))
    held = elem(pdf, inner, outer_elem, page=page,
                kids=[Dictionary(Type=Name.OBJR, Obj=field)])
    outer_elem[Name.K] = Array([held])
    doc[Name.K] = Array(list(doc[Name.K]) + [outer_elem])
    pdf.Root[Name.AcroForm] = pdf.make_indirect(
        Dictionary(Fields=Array([field]), DA=String("/Helv 0 Tf 0 g"))
    )
    return field


def field_in_form_via_span_ok(path):
    """PASS fixture — ISO 14289-1 7.18.4 asks for the widget to be NESTED
    WITHIN a `Form`, not held directly by one: the `Span` between them does
    not move the widget out of the `Form`."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    _nested_tagged_field(pdf, page, doc, "Form", "Span",
                         widget_extra={"TU": String("Your full name")})
    make_conformant(pdf, page)
    return save(pdf, path)


def field_in_p_inside_form_ok(path):
    """PASS fixture — the same `P` that fails under a `Document`
    (`field_tagged_outside_form`) passes inside a `Form`. What the check
    reads is the enclosure, not the holder's own role."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    _nested_tagged_field(pdf, page, doc, "Form", "P",
                         widget_extra={"TU": String("Your full name")})
    make_conformant(pdf, page)
    return save(pdf, path)


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


def form_description_on_nested_widget_ok(path):
    """PASS fixture — the `Form` names its widget through a `Span`, and the
    widget carries `/TU`. ISO 14289-1 cl. 7.18.1 puts the description on the
    named annotation; it does not require the naming `/OBJR` to be the
    element's own kid. The `Form` carries no `/T` of its own, so the only
    thing that can answer the check is the widget's `/TU`."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    field = _annot(pdf, page, "Widget", [300, 500, 500, 520], FT=Name.Tx,
                   T=String("name"), TU=String("Your full name"))
    form = elem(pdf, "Form", doc, page=page)
    span = elem(pdf, "Span", form, page=page,
                kids=[Dictionary(Type=Name.OBJR, Obj=field)])
    form[Name.K] = Array([span])
    doc[Name.K] = Array(list(doc[Name.K]) + [form])
    pdf.Root[Name.AcroForm] = pdf.make_indirect(
        Dictionary(Fields=Array([field]), DA=String("/Helv 0 Tf 0 g"))
    )
    make_conformant(pdf, page)
    return save(pdf, path)


def link_no_alt_nested_objr(path):
    """A `Link` naming its annotation through a `Span`, with no description
    anywhere: reaching through descendants must not silence a real defect."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    annot = _annot(pdf, page, "Link", [400, 400, 500, 420],
                   A=Dictionary(S=Name.URI, URI=String("https://example.test/")))
    link = elem(pdf, "Link", doc, page=page)
    span = elem(pdf, "Span", link, page=page,
                kids=[Dictionary(Type=Name.OBJR, Obj=annot)])
    link[Name.K] = Array([span])
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


def ordered_list_attrs():
    """The `/ListNumbering` a list drawing numeric labels has to declare.

    ISO 32000-2 Table 353. Every list fixture below labels its items `1.`, so
    each of them declares the numbering that matches — otherwise the fixture
    for one check would carry a second, real defect, and its verdict could no
    longer be attributed to the check it is about.
    """
    return Dictionary(O=Name.List, ListNumbering=Name.Decimal)


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
    lst[Name.A] = ordered_list_attrs()
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
    outer = elem(pdf, container, doc, kids=[div],
                 **({"A": ordered_list_attrs()} if container == "L" else {}))
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
    lst = elem(pdf, "L", doc, kids=kids, NS=ns, A=ordered_list_attrs())
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
    lst = elem(pdf, "L", doc, kids=[item, body], A=ordered_list_attrs())
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


# ── role mapping, and the flag a document raises against itself ───────────


def _one_paragraph_doc(pdf, page, tag="P", role_map=None, size=11, text="Body copy."):
    """One tagged paragraph and nothing else, under a tag of the caller's
    choosing. The smallest document the structure checks have anything to say
    about."""
    draw(pdf, page, f"/{tag} <</MCID 0>> BDC BT /F1 {size} Tf 40 700 Td ({text}) Tj ET EMC")
    root = struct_root(pdf, role_map)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, tag, doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    return root, doc, para


def unmapped_custom_tag(path):
    """ISO 14289-1 cl. 7.1 with ISO 32000-2 14.8.6.2: a private structure type
    reaches a reader only through a role map, and this document ships none."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_paragraph_doc(pdf, page, tag="Alinea")
    make_conformant(pdf, page)
    return save(pdf, path)


def rolemap_chain_ok(path):
    """PASS fixture — 14.8.6.2 states the mapping may be applied transitively,
    so a tag reaching a standard type in two hops has reached one."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_paragraph_doc(pdf, page, tag="Alinea",
                       role_map={"Alinea": "Bodytext", "Bodytext": "P"})
    make_conformant(pdf, page)
    return save(pdf, path)


def rolemap_pdf_1_7_type_ok(path):
    """PASS fixture — `BlockQuote` is a standard type of the PDF 1.7 namespace
    (ISO 32000-2 Annex M) and the default namespace IS that one, so a document
    using it has mapped nothing and needs to map nothing."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(pdf, page, "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Quoted copy.) Tj ET EMC")
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    quote = elem(pdf, "BlockQuote", doc, kids=[para])
    doc[Name.K] = Array([quote])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def rolemap_cycle(path):
    """A role map that closes on itself reaches no standard type at all, so
    every tag it governs names a semantic no reader can act on."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_paragraph_doc(pdf, page, tag="Alinea",
                       role_map={"Alinea": "Bodytext", "Bodytext": "Alinea"})
    make_conformant(pdf, page)
    return save(pdf, path)


def suspects_flag(path):
    """ISO 32000-2 Table 321: `/Suspects` true is the file disclaiming its own
    tagging, which cl. 7.1 does not admit."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_paragraph_doc(pdf, page)
    pdf.Root[Name.MarkInfo] = Dictionary(Marked=True, Suspects=True)
    make_conformant(pdf, page)
    return save(pdf, path)


def suspects_false_ok(path):
    """PASS fixture — the flag PRESENT and false is a document stating its
    tagging is reliable, which is the opposite of the defect."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_paragraph_doc(pdf, page)
    pdf.Root[Name.MarkInfo] = Dictionary(Marked=True, Suspects=False)
    make_conformant(pdf, page)
    return save(pdf, path)


# ── graphics outside every marked content sequence ────────────────────────


def graphics_outside_marks(path):
    """ISO 14289-1 cl. 7.1: a fill painted under neither a tag nor an
    `/Artifact` declaration is content no reader reaches under any name."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        # `q`/`Q` around the fill: without them the grey stays the fill colour
        # for the text below it, and the fixture would carry a contrast defect
        # as well as the one it is about.
        "q 0.5 0.5 0.5 rg 40 500 120 60 re f Q\n"
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def graphics_in_artifact_ok(path):
    """PASS fixture — the same fill, declared decoration. The declaration is
    the whole difference and the check must see it."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/Artifact <</Type /Layout>> BDC q 0.5 0.5 0.5 rg 40 500 120 60 re f Q EMC\n"
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


# ── Unicode mapping correctness ───────────────────────────────────────────


def _type0_font(pdf, tounicode: str, encoding: str = "/Identity-H",
                subtables=()):
    """A composite font whose only statement about what its one code spells is
    the `/ToUnicode` the caller writes.

    By default the embedded program carries NO `cmap` table, which is the shape
    a CIDFont program takes and is what keeps this the only statement: a Unicode
    cmap would be a second one, and the check that compares the two would then
    be reading a fixture about something else. `subtables` adds that second
    statement deliberately, and `encoding` names the CMap the codes run through.
    """
    program = pdf.make_stream(truetype_program(subtables))
    descriptor = pdf.make_indirect(
        Dictionary(Type=Name.FontDescriptor, FontName=Name("/ABCDEF+Test"),
                   Flags=4, ItalicAngle=0, Ascent=750, Descent=-250,
                   CapHeight=700, StemV=80, FontBBox=Array([0, -250, 1000, 750]),
                   FontFile2=program)
    )
    descendant = pdf.make_indirect(
        Dictionary(
            Type=Name.Font, Subtype=Name.CIDFontType2,
            BaseFont=Name("/ABCDEF+Test"), CIDToGIDMap=Name.Identity,
            CIDSystemInfo=Dictionary(Registry=String("Adobe"),
                                     Ordering=String("Identity"), Supplement=0),
            FontDescriptor=descriptor, DW=1000,
        )
    )
    return pdf.make_indirect(
        Dictionary(
            Type=Name.Font, Subtype=Name.Type0, BaseFont=Name("/ABCDEF+Test"),
            Encoding=Name(encoding), DescendantFonts=Array([descendant]),
            ToUnicode=pdf.make_stream(tounicode.encode("ascii")),
        )
    )


def _tounicode(target: str) -> str:
    return (
        "/CIDInit /ProcSet findresource begin\n"
        "12 dict begin\n"
        "begincmap\n"
        "/CIDSystemInfo\n"
        "<< /Registry (Adobe)\n"
        "/Ordering (UCS)\n"
        "/Supplement 0\n"
        ">> def\n"
        "/CMapName /Adobe-Identity-UCS def\n"
        "/CMapType 2 def\n"
        "1 begincodespacerange\n"
        "<0000> <FFFF>\n"
        "endcodespacerange\n"
        "1 beginbfchar\n"
        f"<0001> <{target}>\n"
        "endbfchar\n"
        "endcmap\n"
        "CMapName currentdict /CMap defineresource pop\n"
        "end\n"
        "end"
    )


def _type0_page(pdf, page, target: str, encoding: str = "/Identity-H",
                subtables=()):
    page.obj[Name.Resources] = Dictionary(
        Font=Dictionary(
            F1=_font(pdf),
            C0=_type0_font(pdf, _tounicode(target), encoding, subtables),
        )
    )
    page.obj[Name.Contents] = pdf.make_stream(
        b"/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Body copy.) Tj ET EMC\n"
        b"/Span <</MCID 1>> BDC BT /C0 11 Tf 40 660 Td <0001> Tj ET EMC"
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    span = elem(pdf, "Span", doc, page=page, mcid=1)
    doc[Name.K] = Array([para, span])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para, span])


def tounicode_maps_to_nothing(path):
    """ISO 32000-2 9.10.2: `/ToUnicode` states what a code spells, and U+0000
    is not a character any glyph spells — the entry is present and wrong,
    which is the question `character_encoding` does not ask."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _type0_page(pdf, page, "0000")
    make_conformant(pdf, page)
    return save(pdf, path)


def tounicode_maps_to_a_character_ok(path):
    """PASS fixture — the identical font with a real codepoint. Only the four
    hex digits differ, so a moved verdict can only be about them."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _type0_page(pdf, page, "0041")
    make_conformant(pdf, page)
    return save(pdf, path)


def tounicode_under_a_predefined_cmap_ok(path):
    """PASS fixture — a composite font whose `/Encoding` is a predefined CMap
    rather than Identity-H.

    Code <0001> declares U+0042, and the embedded program's Unicode cmap maps
    U+0041 to glyph 1. Those two only contradict each other if the code IS the
    glyph id, which a predefined CMap is exactly what denies: it maps codes to
    CIDs by its own table. Reading the code as a glyph id here reports a
    conforming CJK document as broken.
    """
    pdf = new_pdf()
    page = pdf.pages[0]
    _type0_page(pdf, page, "0042", encoding="/UniGB-UCS2-H",
                subtables=((3, 1),))
    make_conformant(pdf, page)
    return save(pdf, path)


def tounicode_contradicts_the_program(path):
    """FAIL fixture — the SAME disagreement under `/Identity-H`, where the code
    is the glyph id and the two statements really do contradict."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _type0_page(pdf, page, "0042", subtables=((3, 1),))
    make_conformant(pdf, page)
    return save(pdf, path)


# ── the list checks added with the technique corpus ───────────────────────


def _simple_list(pdf, page, labels, numbering=None, item_kids=None):
    """One list, one item per label, each with a label and a body."""
    parts = ["/P <</MCID 0>> BDC BT /F1 11 Tf 40 740 Td (Body copy.) Tj ET EMC"]
    mcid = 1
    for i, label in enumerate(labels):
        y = 700 - i * 20
        parts.append(
            f"/Lbl <</MCID {mcid}>> BDC BT /F1 11 Tf 40 {y} Td ({label}) Tj ET EMC"
        )
        parts.append(
            f"/LBody <</MCID {mcid + 1}>> BDC BT /F1 11 Tf 60 {y} Td (An item.) Tj ET EMC"
        )
        mcid += 2
    draw(pdf, page, "\n".join(parts))
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    order = [para]
    items = []
    mcid = 1
    for _label in labels:
        lbl = elem(pdf, "Lbl", doc, page=page, mcid=mcid)
        body = elem(pdf, "LBody", doc, page=page, mcid=mcid + 1)
        kids = [lbl, body] if item_kids is None else item_kids(pdf, doc, page, lbl, body)
        items.append(elem(pdf, "LI", doc, kids=kids))
        order += [lbl, body]
        mcid += 2
    extra = {}
    if numbering is not None:
        extra["A"] = Dictionary(O=Name.List, ListNumbering=Name("/" + numbering))
    lst = elem(pdf, "L", doc, kids=items, **extra)
    doc[Name.K] = Array([para, lst])
    root[Name.K] = doc
    parent_tree(pdf, root, page, order)
    return root, doc, lst


def numbered_list_declared_as_bullets(path):
    """ISO 32000-2 Table 353: the items count `1.` `2.` `3.` and the list
    declares a bullet shape, so a reader announces the count as decoration."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _simple_list(pdf, page, ["1.", "2.", "3."], numbering="Disc")
    make_conformant(pdf, page)
    return save(pdf, path)


def bullet_list_no_numbering_ok(path):
    """PASS fixture — bullets and no `/ListNumbering`. The entry is optional
    and `not numbered` is TRUE of this list, so its absence is not a defect."""
    pdf = new_pdf()
    page = pdf.pages[0]
    # WinAnsi 0x95 is U+2022, which is what the run walk decodes it back to.
    _simple_list(pdf, page, [chr(0x95)] * 3)
    make_conformant(pdf, page)
    return save(pdf, path)


def word_labelled_list_ok(path):
    """PASS fixture — a description list's terms are its labels. They belong
    to no numbering system, so the check has nothing to judge and must not
    invent an answer."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _simple_list(pdf, page, ["Alpha:", "Beta:", "Gamma:"], numbering="None")
    make_conformant(pdf, page)
    return save(pdf, path)


def _paragraph_in_item(pdf, doc, page, lbl, body):
    return [lbl, elem(pdf, "P", doc, kids=[body])]


def list_item_holding_a_paragraph(path):
    """ISO 32000-2 Table 370: a list item holds a label and a body. This one
    holds a paragraph, so the item's body is somewhere no reader looks."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _simple_list(pdf, page, ["1.", "2."], numbering="Decimal",
                 item_kids=_paragraph_in_item)
    make_conformant(pdf, page)
    return save(pdf, path)


def _nested_list_in_body(pdf, doc, page, lbl, body):
    inner_lbl = elem(pdf, "Lbl", doc)
    inner_body = elem(pdf, "LBody", doc)
    inner = elem(pdf, "LI", doc, kids=[inner_lbl, inner_body])
    nested = elem(pdf, "L", doc, kids=[inner],
                  A=Dictionary(O=Name.List, ListNumbering=Name.Decimal))
    # The sub-list goes INSIDE the body, alongside the content that body
    # already tags, so the item still holds exactly a label and a body.
    body[Name.K] = Array([body[Name.K], nested])
    return [lbl, body]


def nested_list_inside_lbody_ok(path):
    """PASS fixture — a sub-list nested INSIDE the body it belongs to, which
    is where Table 370 puts it. The item still holds exactly a label and a
    body."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _simple_list(pdf, page, ["1.", "2."], numbering="Decimal",
                 item_kids=_nested_list_in_body)
    make_conformant(pdf, page)
    return save(pdf, path)


def list_labels_left_in_the_body(path):
    """The labels are drawn, and they are inside the bodies rather than in
    `Lbl` elements. Whether the author meant them as labels is a judgement, so
    the check reports and does not decide."""
    pdf = new_pdf()
    page = pdf.pages[0]
    parts = ["/P <</MCID 0>> BDC BT /F1 11 Tf 40 740 Td (Body copy.) Tj ET EMC"]
    for i in range(3):
        parts.append(
            f"/LBody <</MCID {i + 1}>> BDC BT /F1 11 Tf 40 {700 - i * 20} Td "
            f"({i + 1}. An item.) Tj ET EMC"
        )
    draw(pdf, page, "\n".join(parts))
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    items = []
    order = [para]
    for i in range(3):
        body = elem(pdf, "LBody", doc, page=page, mcid=i + 1)
        items.append(elem(pdf, "LI", doc, kids=[body]))
        order.append(body)
    lst = elem(pdf, "L", doc, kids=items, A=Dictionary(O=Name.List, ListNumbering=Name.Decimal))
    doc[Name.K] = Array([para, lst])
    root[Name.K] = doc
    parent_tree(pdf, root, page, order)
    make_conformant(pdf, page)
    return save(pdf, path)


# ── the judgement checks: evidence, never a verdict ───────────────────────


def artifact_sentence(path):
    """A sentence's worth of words, at the body size, declared decoration.
    Whether it is decoration is the author's answer, so this is a review."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td "
        "(This paragraph is body copy and reads as body copy.) Tj ET EMC\n"
        "/Artifact <</Type /Layout>> BDC BT /F1 11 Tf 40 660 Td "
        "(This paragraph is body copy too but it is artifacted.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def short_artifact_ok(path):
    """PASS fixture — a page number, declared decoration. Every document has
    one, and a checker that offered each for review would offer the whole
    document."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td "
        "(This paragraph is body copy and reads as body copy.) Tj ET EMC\n"
        "/Artifact <</Type /Pagination>> BDC BT /F1 11 Tf 300 40 Td (12) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def _lines_paragraph(pdf, page, gaps, mcids=None):
    """One paragraph's lines down the page, with the caller's vertical gaps.

    `mcids` says which marked content sequence each line belongs to, so a
    fixture can put two visual blocks under one element or two.
    """
    y = 700
    parts = []
    ys = []
    for i, gap in enumerate([0] + list(gaps)):
        y -= gap
        ys.append(y)
        mcid = 0 if mcids is None else mcids[i]
        parts.append(
            f"/P <</MCID {mcid}>> BDC BT /F1 11 Tf 40 {y} Td (Line {i + 1} of the copy.) Tj ET EMC"
        )
    draw(pdf, page, "\n".join(parts))
    return ys


def element_holds_two_blocks(path):
    """One `P` over two blocks of lines set further apart than the lines
    inside them. Whether that is one paragraph is the author's answer."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _lines_paragraph(pdf, page, [14, 14, 30, 14])
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def evenly_leaded_paragraph_ok(path):
    """PASS fixture — the same five lines, evenly leaded. A paragraph is not
    two paragraphs because it is long."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _lines_paragraph(pdf, page, [14, 14, 14, 14])
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    para = elem(pdf, "P", doc, page=page, mcid=0)
    doc[Name.K] = Array([para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [para])
    make_conformant(pdf, page)
    return save(pdf, path)


def sequence_out_of_order(path):
    """One marked content sequence drawing its own words right to left. A
    rotated or bidirectional layout draws that way legitimately, so this is
    reported with its count and never failed."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 740 Td (Body copy.) Tj ET EMC\n"
        "/P <</MCID 1>> BDC BT /F1 11 Tf 300 700 Td (second half) Tj "
        "1 0 0 1 60 700 Tm (first half ) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    first = elem(pdf, "P", doc, page=page, mcid=0)
    second = elem(pdf, "P", doc, page=page, mcid=1)
    doc[Name.K] = Array([first, second])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [first, second])
    make_conformant(pdf, page)
    return save(pdf, path)


def sequence_in_order_ok(path):
    """PASS fixture — the same two halves drawn left to right."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 11 Tf 40 740 Td (Body copy.) Tj ET EMC\n"
        "/P <</MCID 1>> BDC BT /F1 11 Tf 60 700 Td (first half ) Tj "
        "1 0 0 1 110 700 Tm (second half) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    first = elem(pdf, "P", doc, page=page, mcid=0)
    second = elem(pdf, "P", doc, page=page, mcid=1)
    doc[Name.K] = Array([first, second])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [first, second])
    make_conformant(pdf, page)
    return save(pdf, path)


def paragraph_set_like_a_heading(path):
    """A line set half again as large as the body, tagged `P`. Size is the
    only signal a file carries and a size is not a semantic, so the check
    reports the measurement and a person decides."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/P <</MCID 0>> BDC BT /F1 20 Tf 40 740 Td (A Section Title) Tj ET EMC\n"
        "/P <</MCID 1>> BDC BT /F1 11 Tf 40 700 Td "
        "(This paragraph is ordinary body copy set at eleven points.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    big = elem(pdf, "P", doc, page=page, mcid=0)
    para = elem(pdf, "P", doc, page=page, mcid=1)
    doc[Name.K] = Array([big, para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [big, para])
    make_conformant(pdf, page)
    return save(pdf, path)


def heading_set_larger_ok(path):
    """PASS fixture — the same page with the large line tagged `H1`, which is
    what it looks like. Nothing here is worth anyone's time."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/H1 <</MCID 0>> BDC BT /F1 20 Tf 40 740 Td (A Section Title) Tj ET EMC\n"
        "/P <</MCID 1>> BDC BT /F1 11 Tf 40 700 Td "
        "(This paragraph is ordinary body copy set at eleven points.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    head = elem(pdf, "H1", doc, page=page, mcid=0)
    para = elem(pdf, "P", doc, page=page, mcid=1)
    doc[Name.K] = Array([head, para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [head, para])
    make_conformant(pdf, page)
    return save(pdf, path)


def h_and_hn_together(path):
    """ISO 14289-1 cl. 7.4 states the numbered and unnumbered heading
    conventions as alternatives; a document using both leaves its outline with
    two answers about the same level."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/H1 <</MCID 0>> BDC BT /F1 20 Tf 40 740 Td (A Numbered Heading) Tj ET EMC\n"
        "/H <</MCID 1>> BDC BT /F1 16 Tf 40 700 Td (An Unnumbered Heading) Tj ET EMC\n"
        "/P <</MCID 2>> BDC BT /F1 11 Tf 40 660 Td "
        "(This paragraph is ordinary body copy set at eleven points.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    numbered = elem(pdf, "H1", doc, page=page, mcid=0)
    generic = elem(pdf, "H", doc, page=page, mcid=1)
    para = elem(pdf, "P", doc, page=page, mcid=2)
    doc[Name.K] = Array([numbered, generic, para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [numbered, generic, para])
    make_conformant(pdf, page)
    return save(pdf, path)


def generic_headings_only_ok(path):
    """PASS fixture — `H` throughout, nested. One convention, consistently."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/H <</MCID 0>> BDC BT /F1 20 Tf 40 740 Td (A Section Heading) Tj ET EMC\n"
        "/H <</MCID 1>> BDC BT /F1 16 Tf 40 700 Td (A Subsection Heading) Tj ET EMC\n"
        "/P <</MCID 2>> BDC BT /F1 11 Tf 40 660 Td "
        "(This paragraph is ordinary body copy set at eleven points.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    outer = elem(pdf, "H", doc, page=page, mcid=0)
    inner_head = elem(pdf, "H", doc, page=page, mcid=1)
    para = elem(pdf, "P", doc, page=page, mcid=2)
    inner = elem(pdf, "Sect", doc, kids=[inner_head, para])
    doc[Name.K] = Array([outer, inner])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [outer, inner_head, para])
    make_conformant(pdf, page)
    return save(pdf, path)


def figure_over_the_page(path):
    """A field of colour covering a seventh of the page, tagged as a figure.
    A full-bleed illustration measures the same, so this is a review."""
    pdf = new_pdf()
    page = pdf.pages[0]
    draw(
        pdf, page,
        "/Figure <</MCID 0>> BDC q 0.74 0.84 0.93 rg 50 620 490 140 re f Q EMC\n"
        "/P <</MCID 1>> BDC BT /F1 11 Tf 60 700 Td (Body copy.) Tj ET EMC",
    )
    root = struct_root(pdf)
    doc = elem(pdf, "Document", root)
    fig = elem(pdf, "Figure", doc, page=page, mcid=0, Alt=String("Blue background"))
    para = elem(pdf, "P", doc, page=page, mcid=1)
    doc[Name.K] = Array([fig, para])
    root[Name.K] = doc
    parent_tree(pdf, root, page, [fig, para])
    make_conformant(pdf, page)
    return save(pdf, path)


# ── the by-design gaps: annotations, media, XObjects, fonts, forms ────────


def trapnet_annotation(path):
    """ISO 14289-1 cl. 7.18.2 forbids the subtype outright, with no exemption
    of its own. The hidden flag is set so cl. 7.18.1's own exemption keeps
    every OTHER annotation check off it — the only verdict that can move is
    the unconditional one."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _annot(pdf, page, "TrapNet", [0, 0, 612, 792], F=2)
    make_conformant(pdf, page)
    return save(pdf, path)


def _tagged_link(pdf, page, doc, action):
    annot = _annot(pdf, page, "Link", [400, 400, 500, 420], A=action,
                   Contents=String("The example site"))
    link = elem(pdf, "Link", doc, page=page,
                kids=[Dictionary(Type=Name.OBJR, Obj=annot)])
    doc[Name.K] = Array(list(doc[Name.K]) + [link])
    page.obj[Name.Tabs] = Name.S
    return annot


def annotation_not_trapnet_ok(path):
    """PASS fixture — an annotation is present and it is not a trap network,
    so cl. 7.18.2 is answered rather than skipped."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _root, doc = _one_tagged_paragraph(pdf, page)
    _tagged_link(pdf, page, doc,
                 Dictionary(S=Name.URI, URI=String("https://example.test/")))
    make_conformant(pdf, page)
    return save(pdf, path)


def link_uri_is_map(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _root, doc = _one_tagged_paragraph(pdf, page)
    _tagged_link(pdf, page, doc,
                 Dictionary(S=Name.URI, URI=String("https://example.test/"),
                            IsMap=True))
    make_conformant(pdf, page)
    return save(pdf, path)


def link_uri_no_ismap_ok(path):
    """PASS fixture — a URI action with no `/IsMap` at all. The clause is about
    the key being present with the value true, so its absence is a pass and
    not a document with nothing to check."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _root, doc = _one_tagged_paragraph(pdf, page)
    _tagged_link(pdf, page, doc,
                 Dictionary(S=Name.URI, URI=String("https://example.test/")))
    make_conformant(pdf, page)
    return save(pdf, path)


def _screen_with_clip(pdf, page, doc, clip_extra):
    """A tagged Screen annotation whose rendition action carries one media clip
    data dictionary — the only place ISO 14289-1 cl. 7.18.6.2 applies."""
    clip = pdf.make_indirect(
        Dictionary(Type=Name("/MediaClip"), S=Name("/MCD"),
                   D=Dictionary(Type=Name.Filespec, F=String("clip.mp4"),
                                UF=String("clip.mp4")),
                   **clip_extra)
    )
    rendition = pdf.make_indirect(
        Dictionary(Type=Name("/Rendition"), S=Name("/MR"), C=clip)
    )
    annot = _annot(pdf, page, "Screen", [40, 300, 300, 460],
                   Contents=String("A short clip"),
                   A=Dictionary(S=Name("/Rendition"), R=rendition, OP=0))
    # The description lives on the ANNOTATION (`/Contents`), never on the
    # element naming it: an `/Alt` here would replace the annotation rather
    # than describe it.
    node = elem(pdf, "Annot", doc, page=page,
                kids=[Dictionary(Type=Name.OBJR, Obj=annot)])
    doc[Name.K] = Array(list(doc[Name.K]) + [node])
    page.obj[Name.Tabs] = Name.S
    return clip


def media_clip_no_ct_alt(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _root, doc = _one_tagged_paragraph(pdf, page)
    _screen_with_clip(pdf, page, doc, {})
    make_conformant(pdf, page)
    return save(pdf, path)


def media_clip_ct_alt_ok(path):
    """PASS fixture — ISO 32000 calls `/CT` and `/Alt` optional; cl. 7.18.6.2
    requires them, and this clip carries both."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _root, doc = _one_tagged_paragraph(pdf, page)
    _screen_with_clip(pdf, page, doc,
                      {"CT": String("video/mp4"),
                       "Alt": Array([String("en-US"), String("A short clip")])})
    make_conformant(pdf, page)
    return save(pdf, path)


def _form_xobject(pdf, page, extra=None):
    """A Form XObject drawn inside the page's tagged sequence, so the paint it
    performs is content the structure tree already reaches."""
    xobj = pdf.make_stream(b"0 0 0 rg 10 10 40 40 re f")
    xobj[Name.Type] = Name.XObject
    xobj[Name.Subtype] = Name.Form
    xobj[Name.BBox] = Array([0, 0, 60, 60])
    xobj[Name.Resources] = Dictionary()
    for key, value in (extra or {}).items():
        xobj[Name("/" + key)] = value
    page.obj[Name.Resources][Name.XObject] = Dictionary(Fx=xobj)
    page.obj[Name.Contents] = pdf.make_stream(
        b"/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Readable body copy at eleven points.) Tj ET\n"
        b"q 1 0 0 1 400 600 cm /Fx Do Q EMC"
    )
    return xobj


def reference_xobject(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _form_xobject(pdf, page, {
        "Ref": Dictionary(F=Dictionary(Type=Name.Filespec, F=String("other.pdf"),
                                       UF=String("other.pdf")),
                          Page=0),
    })
    make_conformant(pdf, page)
    return save(pdf, path)


def form_xobject_ok(path):
    """PASS fixture — an ordinary Form XObject. Cl. 7.20 forbids the REFERENCE
    kind; a form that carries its own content is what the same clause then asks
    to be incorporated into the structure tree, which this one is."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _form_xobject(pdf, page)
    make_conformant(pdf, page)
    return save(pdf, path)


def font_not_embedded(path):
    """A second font, with no font program behind it, drawn in a tagged span.
    The baseline's own font IS embedded, so the only new thing here is the
    unembedded one."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    page.obj[Name.Resources][Name.Font][Name("/F2")] = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/Courier"),
                   Encoding=Name.WinAnsiEncoding)
    )
    page.obj[Name.Contents] = pdf.make_stream(
        b"/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Readable body copy at eleven points.) Tj ET EMC\n"
        b"/Span <</MCID 1>> BDC BT /F2 11 Tf 40 660 Td (Second line.) Tj ET EMC"
    )
    span = elem(pdf, "Span", doc, page=page, mcid=1)
    doc[Name.K] = Array(list(doc[Name.K]) + [span])
    parent_tree(pdf, root, page, [doc[Name.K][0], span])
    make_conformant(pdf, page)
    return save(pdf, path)


def font_rendering_mode_three_ok(path):
    """PASS fixture — the same unembedded font, referenced SOLELY in text
    rendering mode 3. ISO 14289-1 cl. 7.21.4.1 NOTE 2 exempts it: mode 3
    neither strokes, fills nor clips, so nothing is rendered and there is no
    substitution to prevent."""
    pdf = new_pdf()
    page = pdf.pages[0]
    root, doc = _one_tagged_paragraph(pdf, page)
    page.obj[Name.Resources][Name.Font][Name("/F2")] = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/Courier"),
                   Encoding=Name.WinAnsiEncoding)
    )
    page.obj[Name.Contents] = pdf.make_stream(
        b"/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Readable body copy at eleven points.) Tj ET EMC\n"
        b"/Artifact BMC q BT 3 Tr /F2 11 Tf 40 660 Td (Invisible.) Tj ET Q EMC"
    )
    parent_tree(pdf, root, page, [doc[Name.K][0]])
    make_conformant(pdf, page)
    return save(pdf, path)


def _truetype_font(pdf, symbolic: bool, subtables, encoding=None):
    raw = truetype_program(subtables)
    program = pdf.make_stream(raw)
    program[Name("/Length1")] = len(raw)
    descriptor = pdf.make_indirect(
        Dictionary(Type=Name.FontDescriptor, FontName=Name("/TestSans"),
                   Flags=4 if symbolic else 32, ItalicAngle=0, Ascent=750,
                   Descent=-250, CapHeight=700, StemV=80,
                   FontBBox=Array([0, -250, 1000, 750]), FontFile2=program)
    )
    d = Dictionary(Type=Name.Font, Subtype=Name.TrueType, BaseFont=Name("/TestSans"),
                   FirstChar=32, LastChar=122,
                   Widths=Array([500] * (122 - 32 + 1)),
                   FontDescriptor=descriptor)
    if encoding is not None:
        d[Name.Encoding] = encoding
    return pdf.make_indirect(d)


def _truetype_page(pdf, page, font):
    root, doc = _one_tagged_paragraph(pdf, page)
    page.obj[Name.Resources][Name.Font][Name("/F2")] = font
    page.obj[Name.Contents] = pdf.make_stream(
        b"/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Readable body copy at eleven points.) Tj ET EMC\n"
        b"/Span <</MCID 1>> BDC BT /F2 11 Tf 40 660 Td (abc) Tj ET EMC"
    )
    span = elem(pdf, "Span", doc, page=page, mcid=1)
    doc[Name.K] = Array(list(doc[Name.K]) + [span])
    parent_tree(pdf, root, page, [doc[Name.K][0], span])
    return root, doc


def nonsymbolic_truetype_no_base_encoding(path):
    """Cl. 7.21.6: a non-symbolic TrueType font shall name MacRomanEncoding or
    WinAnsiEncoding. This one names neither."""
    pdf = new_pdf()
    page = pdf.pages[0]
    font = _truetype_font(pdf, symbolic=False, subtables=((3, 1),), encoding=None)
    _truetype_page(pdf, page, font)
    make_conformant(pdf, page)
    return save(pdf, path)


def symbolic_truetype_no_encoding_ok(path):
    """PASS fixture — a SYMBOLIC TrueType font, with no `/Encoding` entry and a
    Microsoft Symbol (3,0) subtable in its program. Cl. 7.21.6 states exactly
    that shape for symbolic fonts, and a check that applied the non-symbolic
    encoding rule to it would fail a conforming file."""
    pdf = new_pdf()
    page = pdf.pages[0]
    font = _truetype_font(pdf, symbolic=True, subtables=((3, 0),), encoding=None)
    _truetype_page(pdf, page, font)
    make_conformant(pdf, page)
    return save(pdf, path)


def _cid_font(pdf, cid_to_gid):
    program = pdf.make_stream(truetype_program(()))
    descriptor = pdf.make_indirect(
        Dictionary(Type=Name.FontDescriptor, FontName=Name("/ABCDEF+TestCID"),
                   Flags=4, ItalicAngle=0, Ascent=750, Descent=-250,
                   CapHeight=700, StemV=80,
                   FontBBox=Array([0, -250, 1000, 750]), FontFile2=program)
    )
    descendant = Dictionary(
        Type=Name.Font, Subtype=Name.CIDFontType2, BaseFont=Name("/ABCDEF+TestCID"),
        CIDSystemInfo=Dictionary(Registry=String("Adobe"),
                                 Ordering=String("Identity"), Supplement=0),
        FontDescriptor=descriptor, DW=1000,
    )
    if cid_to_gid is not None:
        descendant[Name("/CIDToGIDMap")] = cid_to_gid
    return pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type0,
                   BaseFont=Name("/ABCDEF+TestCID"), Encoding=Name("/Identity-H"),
                   DescendantFonts=Array([pdf.make_indirect(descendant)]))
    )


def cid_font_no_cid_to_gid_map(path):
    """An embedded Type 2 CIDFont with no `/CIDToGIDMap`. It is declared as a
    page resource and never drawn with, which is what keeps the embedding check
    — whose question is about RENDERED fonts — out of this fixture."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    page.obj[Name.Resources][Name.Font][Name("/C0")] = _cid_font(pdf, None)
    make_conformant(pdf, page)
    return save(pdf, path)


def cid_font_identity_ok(path):
    """PASS fixture — the same font with `/CIDToGIDMap /Identity`, which is one
    of the two values ISO 14289-1 cl. 7.21.3.2 admits."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    page.obj[Name.Resources][Name.Font][Name("/C0")] = _cid_font(pdf, Name.Identity)
    make_conformant(pdf, page)
    return save(pdf, path)


def _optional_content(pdf, page, configs, default_extra=None):
    group = pdf.make_indirect(
        Dictionary(Type=Name.OCG, Name=String("A layer"))
    )
    default = Dictionary(Name=String("Default"), OFF=Array([]), ON=Array([group]))
    for key, value in (default_extra or {}).items():
        default[Name("/" + key)] = value
    built = []
    for extra in configs:
        config = Dictionary(ON=Array([group]))
        for key, value in extra.items():
            config[Name("/" + key)] = value
        built.append(pdf.make_indirect(config))
    properties = Dictionary(OCGs=Array([group]), D=pdf.make_indirect(default))
    if built:
        properties[Name.Configs] = Array(built)
    pdf.Root[Name.OCProperties] = properties


def oc_config_no_name(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _optional_content(pdf, page, [{}])
    make_conformant(pdf, page)
    return save(pdf, path)


def oc_config_has_as(path):
    """The other half of cl. 7.10: `/AS` shall not appear in any optional
    content configuration dictionary. This one is named, so only the `/AS`
    prohibition can move the verdict."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _optional_content(
        pdf, page, [{"Name": String("Print")}],
        default_extra={"AS": Array([Dictionary(Event=Name("/View"),
                                               Category=Array([Name("/View")]),
                                               OCGs=Array([]))])},
    )
    make_conformant(pdf, page)
    return save(pdf, path)


def oc_config_named_ok(path):
    """PASS fixture — a `/Configs` array holding one named configuration, and a
    named default, with no `/AS` anywhere."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _optional_content(pdf, page, [{"Name": String("Print")}])
    make_conformant(pdf, page)
    return save(pdf, path)


def _embedded_file(pdf, spec_extra):
    stream = pdf.make_stream(b"attached bytes")
    stream[Name.Type] = Name("/EmbeddedFile")
    spec = Dictionary(Type=Name.Filespec, EF=Dictionary(F=stream))
    for key, value in spec_extra.items():
        spec[Name("/" + key)] = value
    spec = pdf.make_indirect(spec)
    pdf.Root[Name.Names] = Dictionary(
        EmbeddedFiles=Dictionary(Names=Array([String("attachment"), spec]))
    )


def embedded_file_no_names(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _embedded_file(pdf, {})
    make_conformant(pdf, page)
    return save(pdf, path)


def embedded_file_no_unicode_name(path):
    """One half of the name pair present. This is the shape the automatic fix
    repairs: `/UF` is the same name `/F` already carries, so nothing has to be
    authored to supply it."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _embedded_file(pdf, {"F": String("notes.txt")})
    make_conformant(pdf, page)
    return save(pdf, path)


def embedded_file_no_system_name(path):
    """One half of the pair present, and it is the Unicode half carrying a name
    no host encoding spells. `/F` cannot be written from it without inventing an
    encoding the document never states, so the automatic fix leaves it absent."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _embedded_file(pdf, {"UF": String("réunion-中文.txt")})
    make_conformant(pdf, page)
    return save(pdf, path)


def embedded_file_no_system_name_ascii(path):
    """The same shape with an ASCII name, which every host encoding agrees on
    and the fix therefore can write."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _embedded_file(pdf, {"UF": String("notes.txt")})
    make_conformant(pdf, page)
    return save(pdf, path)


def embedded_file_named_ok(path):
    """PASS fixture — the file specification carries both `/F` and `/UF`."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _embedded_file(pdf, {"F": String("notes.txt"), "UF": String("notes.txt")})
    make_conformant(pdf, page)
    return save(pdf, path)


def _print_field_form(pdf, page, attrs=None):
    root, doc = _one_tagged_paragraph(pdf, page)
    page.obj[Name.Contents] = pdf.make_stream(
        b"/P <</MCID 0>> BDC BT /F1 11 Tf 40 700 Td (Readable body copy at eleven points.) Tj ET EMC\n"
        b"/Form <</MCID 1>> BDC BT /F1 11 Tf 40 660 Td (Name:) Tj ET EMC"
    )
    form = elem(pdf, "Form", doc, page=page, mcid=1, T=String("Name field"),
                **(attrs or {}))
    doc[Name.K] = Array(list(doc[Name.K]) + [form])
    parent_tree(pdf, root, page, [doc[Name.K][0], form])
    return root, doc, form


def form_tag_without_print_field(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _print_field_form(pdf, page)
    make_conformant(pdf, page)
    return save(pdf, path)


def form_tag_with_print_field_ok(path):
    """PASS fixture — the same non-interactive form, carrying the PrintField
    attribute owner ISO 14289-1 cl. 7.14 asks for."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _print_field_form(pdf, page, attrs={
        "A": Dictionary(O=Name("/PrintField"), Role=Name("/tv")),
    })
    make_conformant(pdf, page)
    return save(pdf, path)


_XDP = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">'
    "<config xmlns=\"http://www.xfa.org/schema/xci/2.6/\">"
    "<acrobat><acrobat7><dynamicRender>{value}</dynamicRender></acrobat7></acrobat>"
    "</config></xdp:xdp>"
)


def _xfa(pdf, value):
    packet = pdf.make_stream(_XDP.format(value=value).encode("utf-8"))
    pdf.Root[Name.AcroForm] = pdf.make_indirect(
        Dictionary(Fields=Array([]), DA=String("/Helv 0 Tf 0 g"),
                   XFA=Array([String("config"), packet]))
    )


def dynamic_xfa_form(path):
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _xfa(pdf, "required")
    make_conformant(pdf, page)
    return save(pdf, path)


def static_xfa_form_ok(path):
    """PASS fixture — an XFA form whose `dynamicRender` says `forbidden`. Cl.
    7.15 permits static XFA; only the value "required" makes a form dynamic,
    so a checker that failed on the presence of `/XFA` would be wrong."""
    pdf = new_pdf()
    page = pdf.pages[0]
    _one_tagged_paragraph(pdf, page)
    _xfa(pdf, "forbidden")
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
    # Where a list item's parts sit is ONE fact, asked from two ends: an
    # `LBody` outside its item and an item with no body are the same misplaced
    # element seen from either side, so a fixture for either moves both.
    frozenset({"list_labels", "list_item_structure"}),
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
    "field_in_form_ok": (field_in_form_ok, "tagged_form_fields", "pass"),
    "field_tagged_outside_form": (field_tagged_outside_form, "tagged_form_fields", "fail"),
    "field_in_role_mapped_form_ok": (
        field_in_role_mapped_form_ok, "tagged_form_fields", "pass"),
    "field_in_form_via_span_ok": (
        field_in_form_via_span_ok, "tagged_form_fields", "pass"),
    "field_in_p_inside_form_ok": (
        field_in_p_inside_form_ok, "tagged_form_fields", "pass"),
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
    "link_no_alt_nested_objr": (link_no_alt_nested_objr, "other_elements_alt", "fail"),
    "form_description_on_nested_widget_ok": (
        form_description_on_nested_widget_ok, "other_elements_alt", "pass",
    ),
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
    "unmapped_custom_tag": (unmapped_custom_tag, "role_map", "fail"),
    "rolemap_chain_ok": (rolemap_chain_ok, "role_map", "pass"),
    "rolemap_pdf_1_7_type_ok": (rolemap_pdf_1_7_type_ok, "role_map", "pass"),
    "rolemap_cycle": (rolemap_cycle, "role_map", "fail"),
    "suspects_flag": (suspects_flag, "suspects", "fail"),
    "suspects_false_ok": (suspects_false_ok, "suspects", "pass"),
    "graphics_outside_marks": (graphics_outside_marks, "untagged_graphics", "fail"),
    "graphics_in_artifact_ok": (graphics_in_artifact_ok, "untagged_graphics", "pass"),
    "tounicode_maps_to_nothing": (tounicode_maps_to_nothing, "unicode_mapping", "fail"),
    "tounicode_maps_to_a_character_ok": (
        tounicode_maps_to_a_character_ok, "unicode_mapping", "pass"),
    "tounicode_contradicts_the_program": (
        tounicode_contradicts_the_program, "unicode_mapping", "fail"),
    "tounicode_under_a_predefined_cmap_ok": (
        tounicode_under_a_predefined_cmap_ok, "unicode_mapping", "pass"),
    "numbered_list_declared_as_bullets": (
        numbered_list_declared_as_bullets, "list_numbering", "fail"),
    "bullet_list_no_numbering_ok": (
        bullet_list_no_numbering_ok, "list_numbering", "pass"),
    "word_labelled_list_ok": (word_labelled_list_ok, "list_numbering", "not_applicable"),
    "list_item_holding_a_paragraph": (
        list_item_holding_a_paragraph, "list_item_structure", "fail"),
    "nested_list_inside_lbody_ok": (
        nested_list_inside_lbody_ok, "list_item_structure", "pass"),
    "list_labels_left_in_the_body": (
        list_labels_left_in_the_body, "list_semantics", "needs_review"),
    "artifact_sentence": (artifact_sentence, "artifact_judgement", "needs_review"),
    "short_artifact_ok": (short_artifact_ok, "artifact_judgement", "pass"),
    "figure_over_the_page": (figure_over_the_page, "artifact_judgement", "needs_review"),
    "element_holds_two_blocks": (
        element_holds_two_blocks, "content_grouping", "needs_review"),
    "evenly_leaded_paragraph_ok": (
        evenly_leaded_paragraph_ok, "content_grouping", "pass"),
    "sequence_out_of_order": (sequence_out_of_order, "content_order", "needs_review"),
    "sequence_in_order_ok": (sequence_in_order_ok, "content_order", "pass"),
    "paragraph_set_like_a_heading": (
        paragraph_set_like_a_heading, "heading_semantics", "needs_review"),
    "heading_set_larger_ok": (heading_set_larger_ok, "heading_semantics", "pass"),
    "h_and_hn_together": (h_and_hn_together, "heading_tag_mixing", "fail"),
    "generic_headings_only_ok": (generic_headings_only_ok, "heading_tag_mixing", "pass"),
    "trapnet_annotation": (trapnet_annotation, "trapnet_annotations", "fail"),
    "annotation_not_trapnet_ok": (
        annotation_not_trapnet_ok, "trapnet_annotations", "pass"),
    "link_uri_is_map": (link_uri_is_map, "link_ismap", "needs_review"),
    "link_uri_no_ismap_ok": (link_uri_no_ismap_ok, "link_ismap", "pass"),
    "media_clip_no_ct_alt": (media_clip_no_ct_alt, "media_clip_data", "fail"),
    "media_clip_ct_alt_ok": (media_clip_ct_alt_ok, "media_clip_data", "pass"),
    "reference_xobject": (reference_xobject, "reference_xobjects", "fail"),
    "form_xobject_ok": (form_xobject_ok, "reference_xobjects", "pass"),
    "font_not_embedded": (font_not_embedded, "font_embedding", "fail"),
    "font_rendering_mode_three_ok": (
        font_rendering_mode_three_ok, "font_embedding", "pass"),
    "nonsymbolic_truetype_no_base_encoding": (
        nonsymbolic_truetype_no_base_encoding, "font_encodings", "fail"),
    "symbolic_truetype_no_encoding_ok": (
        symbolic_truetype_no_encoding_ok, "font_encodings", "pass"),
    "cid_font_no_cid_to_gid_map": (
        cid_font_no_cid_to_gid_map, "cid_to_gid_map", "fail"),
    "cid_font_identity_ok": (cid_font_identity_ok, "cid_to_gid_map", "pass"),
    "oc_config_no_name": (oc_config_no_name, "optional_content_config", "fail"),
    "oc_config_has_as": (oc_config_has_as, "optional_content_config", "fail"),
    "oc_config_named_ok": (oc_config_named_ok, "optional_content_config", "pass"),
    "embedded_file_no_names": (
        embedded_file_no_names, "embedded_file_names", "fail"),
    "embedded_file_no_unicode_name": (
        embedded_file_no_unicode_name, "embedded_file_names", "fail"),
    "embedded_file_no_system_name": (
        embedded_file_no_system_name, "embedded_file_names", "fail"),
    "embedded_file_no_system_name_ascii": (
        embedded_file_no_system_name_ascii, "embedded_file_names", "fail"),
    "embedded_file_named_ok": (embedded_file_named_ok, "embedded_file_names", "pass"),
    "form_tag_without_print_field": (
        form_tag_without_print_field, "print_field_attributes", "needs_review"),
    "form_tag_with_print_field_ok": (
        form_tag_with_print_field_ok, "print_field_attributes", "pass"),
    "dynamic_xfa_form": (dynamic_xfa_form, "dynamic_xfa", "fail"),
    "static_xfa_form_ok": (static_xfa_form_ok, "dynamic_xfa", "pass"),
}
