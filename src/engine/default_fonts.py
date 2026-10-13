"""The font a default appearance string names.

/DA of a free text annotation (ISO 32000-2 12.5.6.6, Table 177) and of a
redaction annotation that has /OverlayText (12.5.6.23, Table 195) is a
variable-text default appearance string. The font its Tf operator names is a
resource name in /Font of the interactive form's default resources, /DR
(12.7.4.3, Table 224); the annotation has no resource dictionary of its own
for /DA. A file that holds such an annotation therefore holds /AcroForm /DR
/Font with that name, form fields or not. /Fields is the dictionary's one
required entry and is then empty.

One name is one font. A name that another font holds is not reused: the font
goes under the first free name of the family ``Name``, ``Name_1``,
``Name_2`` and the /DA is written with that name. Two fonts share a name
only when they are one object or interchangeable (`interchangeable_key`).
The renderer applies the same rule (`lib/annotation-default-resources.ts`).
"""

import re

import pikepdf
from pikepdf import Array, Dictionary, Name

STANDARD_NAME = "Helv"

# Simple fonts are the only kinds a dictionary comparison can call equal: a
# composite font keeps its program under /DescendantFonts and a Type 3 font
# is its /CharProcs.
_SIMPLE_SUBTYPES = frozenset({"/Type1", "/TrueType", "/MMType1"})
_STANDARD_KEY = "/Type1 /Helvetica /WinAnsiEncoding"

_DELIMITER = r"\s/\[\]()<>{}%"
_FONT_SELECTION = re.compile(
    rf"/([^{_DELIMITER}]+)\s+[-+]?(?:\d+\.?\d*|\.\d+)\s+Tf(?=[{_DELIMITER}]|$)"
)


def interchangeable_key(font) -> str | None:
    """What makes two /DR font entries interchangeable, as one text: both are
    simple fonts with no font program, and their subtype, base font and
    encoding name agree. None for a font interchangeable with no other: an
    embedded program, a dictionary encoding (a /Differences remap is another
    glyph map), a composite or Type 3 font."""
    if not isinstance(font, Dictionary):
        return None
    subtype = font.get("/Subtype")
    if not isinstance(subtype, Name) or str(subtype) not in _SIMPLE_SUBTYPES:
        return None
    if font.get("/FontDescriptor") is not None:
        return None
    encoding = font.get("/Encoding")
    if encoding is not None and not isinstance(encoding, Name):
        return None
    base = font.get("/BaseFont")
    if not isinstance(base, Name):
        return None
    return f"{subtype} {base} {encoding if encoding is not None else ''}"


def appearance_fonts(text: str) -> list[str]:
    """The font resource names the Tf operators of a default appearance
    string select, without the solidus."""
    return [match.group(1) for match in _FONT_SELECTION.finditer(text)]


def rewrite_fonts(text: str, renames: dict) -> str:
    """Replace each renamed font name of a default appearance string, in one
    pass: a new name that is itself an old name is not replaced again."""
    renames = {old: new for old, new in renames.items() if old != new}
    if not renames:
        return text
    names = "|".join(re.escape(name) for name in sorted(renames, key=len, reverse=True))
    return re.sub(
        rf"/({names})(?=[{_DELIMITER}]|$)", lambda match: "/" + renames[match.group(1)], text
    )


def formats_text(annotation) -> bool:
    """Whether a reader formats text with the annotation's /DA."""
    if not isinstance(annotation, Dictionary):
        return False
    subtype = annotation.get("/Subtype")
    if subtype == Name.FreeText:
        return True
    return subtype == Name.Redact and annotation.get("/OverlayText") is not None


def default_fonts(pdf: pikepdf.Pdf, create: bool = False):
    """/AcroForm /DR /Font, or None. With ``create`` the dictionaries that do
    not exist are made, the form dictionary with an empty /Fields."""
    form = pdf.Root.get("/AcroForm")
    if not isinstance(form, Dictionary):
        if not create:
            return None
        pdf.Root["/AcroForm"] = pdf.make_indirect(Dictionary(Fields=Array()))
        form = pdf.Root["/AcroForm"]
    resources = form.get("/DR")
    if not isinstance(resources, Dictionary):
        if not create:
            return None
        form["/DR"] = Dictionary()
        resources = form["/DR"]
    fonts = resources.get("/Font")
    if not isinstance(fonts, Dictionary):
        if not create:
            return None
        resources["/Font"] = Dictionary()
        fonts = resources["/Font"]
    return fonts


def _page_uses(pdf: pikepdf.Pdf):
    """(annotation, /DA text, font names) for each annotation of a page whose
    /DA a reader formats text with."""
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        for annotation in annots if isinstance(annots, Array) else ():
            if not formats_text(annotation):
                continue
            da = annotation.get("/DA")
            if not isinstance(da, pikepdf.String):
                continue
            text = bytes(da).decode("latin-1")
            names = appearance_fonts(text)
            if names:
                yield annotation, text, names


def is_font_holder(form) -> bool:
    """Whether a form dictionary is no form: it registers no field and holds
    no XFA, so all it can serve is the /DA font of an annotation."""
    if not isinstance(form, Dictionary) or form.get("/XFA") is not None:
        return False
    fields = form.get("/Fields")
    return fields is None or (isinstance(fields, Array) and len(fields) == 0)


def release_form(pdf: pikepdf.Pdf) -> None:
    """Remove the interactive form dictionary. The /DR /Font entries a free
    text or redaction /DA of a page still names stay, in a form dictionary
    with an empty /Fields: the annotation's font is no part of the form that
    is removed."""
    fonts = default_fonts(pdf)
    kept = Dictionary()
    if fonts is not None:
        for _, _, names in _page_uses(pdf):
            for name in names:
                held = fonts.get("/" + name)
                if held is not None:
                    kept["/" + name] = held
    if "/AcroForm" in pdf.Root:
        del pdf.Root["/AcroForm"]
    if len(kept.keys()) > 0:
        pdf.Root["/AcroForm"] = pdf.make_indirect(
            Dictionary(Fields=Array(), DR=Dictionary(Font=kept))
        )


def _name_for(fonts, base: str, accepts) -> str:
    """The first name of the family ``base``, ``base_1``, ... that is free or
    whose font ``accepts``."""
    count = 0
    while True:
        name = base if count == 0 else f"{base}_{count}"
        held = fonts.get("/" + name) if fonts is not None else None
        if held is None or accepts(held):
            return name
        count += 1


def hold_simple_font(
    pdf: pikepdf.Pdf, fonts, base: str, base_font: str, encoding: str | None = None
) -> str:
    """Bind the Type 1 font ``base_font`` with the encoding name ``encoding``
    (or none) to a name of the font dictionary ``fonts`` and return that
    name: ``base`` when it is free or holds that font; otherwise the first of
    ``base_1``, ``base_2``, ... that is free or holds it. A name that holds
    another font is never taken and never rebound."""
    key = f"/Type1 /{base_font} {'/' + encoding if encoding else ''}"
    name = _name_for(fonts, base, lambda held: interchangeable_key(held) == key)
    if fonts.get("/" + name) is None:
        font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/" + base_font))
        if encoding:
            font["/Encoding"] = Name("/" + encoding)
        fonts["/" + name] = pdf.make_indirect(font)
    return name


def hold_standard_font(pdf: pikepdf.Pdf) -> str:
    """Bind the standard Helvetica face to a name of /AcroForm /DR /Font and
    return that name: the font a /DA written by the engine selects. `Helv`
    when it is free or holds that face; otherwise the first of `Helv_1`,
    `Helv_2`, ... that is free or holds it."""
    return hold_simple_font(
        pdf, default_fonts(pdf, create=True), STANDARD_NAME, "Helvetica", "WinAnsiEncoding"
    )


def _same_object(a, b) -> bool:
    try:
        return a.is_indirect and b.is_indirect and a.objgen == b.objgen
    except Exception:
        return False


def bind_carried_fonts(dst: pikepdf.Pdf, src: pikepdf.Pdf, annotations) -> int:
    """Bind the /DA fonts of annotations copied from ``src`` into ``dst``.

    ``annotations`` are the copies as they sit in ``dst``. Each font name a
    free text or redaction /DA selects is bound to the font ``src`` held under
    it: under the same name when the name is free in ``dst`` or holds that
    font, and otherwise under a new name, with the /DA rewritten. A name
    ``src`` did not hold stays as written, except `Helv`, which takes the
    standard face. Returns how many /DA strings were rewritten."""
    uses = []
    for annotation in annotations:
        if not formats_text(annotation):
            continue
        da = annotation.get("/DA")
        if not isinstance(da, pikepdf.String):
            continue
        text = bytes(da).decode("latin-1")
        names = appearance_fonts(text)
        if names:
            uses.append((annotation, text, names))
    if not uses:
        return 0
    source_fonts = default_fonts(src)
    renames: dict = {}
    for name in dict.fromkeys(name for _, _, names in uses for name in names):
        intended = source_fonts.get("/" + name) if source_fonts is not None else None
        if intended is None:
            if name == STANDARD_NAME:
                renames[name] = hold_standard_font(dst)
            continue
        key = interchangeable_key(intended)
        copied = None

        def copy():
            nonlocal copied
            if copied is None:
                handle = intended if intended.is_indirect else src.make_indirect(intended)
                copied = dst.copy_foreign(handle)
            return copied

        def accepts(held, key=key, copy=copy):
            if key is not None:
                return interchangeable_key(held) == key
            return _same_object(held, copy())

        fonts = default_fonts(dst, create=True)
        target = _name_for(fonts, name, accepts)
        if fonts.get("/" + target) is None:
            fonts["/" + target] = copy()
        renames[name] = target
    rewritten = 0
    for annotation, text, _ in uses:
        changed = rewrite_fonts(text, renames)
        if changed != text:
            annotation["/DA"] = pikepdf.String(changed.encode("latin-1"))
            rewritten += 1
    return rewritten
