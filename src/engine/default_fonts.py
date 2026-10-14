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
A field /DA (12.7.4.3) names its font in the same dictionary, so one
allocator, `_name_for`, gives the names for fields and annotations alike.
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


_NAME_ESCAPE = re.compile(rb"#([0-9A-Fa-f]{2})")
_TOKEN_PLAIN = frozenset(range(33, 127)) - frozenset(b"#/[]()<>{}%")


def font_key(name: str) -> str | None:
    """The dictionary key of the font a /DA token names.

    A name is its bytes (ISO 32000-2 7.3.5): the token's `#xx` pairs are
    decoded, and a byte that is not UTF-8 is spelled the way `keys()` spells
    it. Such a key is taken by membership and indexing only; `.get` and
    `Name` refuse it. None for a token that names no key."""
    try:
        raw = _NAME_ESCAPE.sub(lambda match: bytes([int(match.group(1), 16)]), name.encode("latin-1"))
    except UnicodeEncodeError:
        return None
    if not raw or b"\x00" in raw:
        return None
    return "/" + raw.decode("utf-8", "surrogateescape")


def font_token(key: str) -> str:
    """The /DA token, without the solidus, that names the dictionary key
    ``key`` (a `keys()` spelling)."""
    raw = key[1:].encode("utf-8", "surrogateescape")
    return "".join(chr(byte) if byte in _TOKEN_PLAIN else f"#{byte:02X}" for byte in raw)


def held_font(fonts, name: str):
    """The font ``fonts`` holds under the /DA token ``name``, or None."""
    key = font_key(name)
    if fonts is None or key is None or key not in fonts:
        return None
    return fonts[key]


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
                held = held_font(fonts, name)
                if held is not None:
                    kept[font_key(name)] = held
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
        held = held_font(fonts, name)
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
    if held_font(fonts, name) is None:
        font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/" + base_font))
        if encoding:
            font["/Encoding"] = Name("/" + encoding)
        fonts[font_key(name)] = pdf.make_indirect(font)
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


def _node_key(node):
    return ("object", node.objgen) if node.is_indirect else ("direct", id(node))


def _field_nodes(roots):
    """Every dictionary of the field trees under ``roots``, each once."""
    seen = set()
    pending = [root for root in roots if isinstance(root, Dictionary)]
    while pending:
        node = pending.pop()
        key = _node_key(node)
        if key in seen:
            continue
        seen.add(key)
        yield node
        kids = node.get("/Kids")
        pending.extend(kid for kid in (kids if isinstance(kids, Array) else ()) if isinstance(kid, Dictionary))


def _appearance_streams(annotation):
    appearance = annotation.get("/AP")
    if not isinstance(appearance, Dictionary):
        return
    for key in ("/N", "/D", "/R"):
        entry = appearance.get(key)
        if isinstance(entry, pikepdf.Stream):
            yield entry
        elif isinstance(entry, Dictionary):
            for state in entry.keys():
                stream = entry[state]
                if isinstance(stream, pikepdf.Stream):
                    yield stream


def _hold_fallback_fonts(stream, moved: dict) -> None:
    """Give an appearance stream each font of ``moved`` (old name to font)
    that its own resources do not hold. A stream with no entry for a name
    takes the font from the default resources in some readers; after the
    font moved to another name, the old name there is another font."""
    resources = stream.get("/Resources")
    fonts = resources.get("/Font") if isinstance(resources, Dictionary) else None
    lacking = {
        name: font for name, font in moved.items()
        if not isinstance(fonts, Dictionary) or held_font(fonts, name) is None
    }
    if not lacking:
        return
    own_fonts = Dictionary(fonts) if isinstance(fonts, Dictionary) else Dictionary()
    for name, font in lacking.items():
        own_fonts[font_key(name)] = font
    own = Dictionary(resources) if isinstance(resources, Dictionary) else Dictionary()
    own["/Font"] = own_fonts
    stream["/Resources"] = own


class withheld_default_fonts:
    """Takes /AcroForm /DR /Font out of ``pdf`` for the length of a block.

    qpdf's field copy merges the source /DR into the destination and, for a
    font name both hold, always writes the source font under ``Name_1``, an
    entry of an earlier source included. With the source fonts withheld the
    copy writes no font entry and rewrites no /DA; `bind_carried_fonts` is
    then the one writer of destination font names."""

    def __init__(self, pdf: pikepdf.Pdf):
        self._resources = None
        self._fonts = None
        form = pdf.Root.get("/AcroForm")
        resources = form.get("/DR") if isinstance(form, Dictionary) else None
        if isinstance(resources, Dictionary) and resources.get("/Font") is not None:
            self._resources = resources
            self._fonts = resources.get("/Font")

    def __enter__(self):
        if self._resources is not None:
            del self._resources["/Font"]
        return self

    def __exit__(self, *exc):
        if self._resources is not None:
            self._resources["/Font"] = self._fonts
        return False


def bind_carried_fonts(dst: pikepdf.Pdf, src: pikepdf.Pdf, annotations, fields=()) -> int:
    """Bind the /DA fonts of annotations and fields copied from ``src`` into
    ``dst``. This is the only writer of /DR /Font names for a page copy.

    ``annotations`` are the copied page annotations and ``fields`` the copied
    field roots, as they sit in ``dst``. Each font name a free text /DA, a
    redaction /DA or the /DA of any node of a field tree selects is bound to
    the font ``src`` held under it: under the same name when the name is free
    in ``dst`` or holds that font, and otherwise under the next free name of
    the family, with every such /DA rewritten. With a field among the copies
    every font of the source /DR travels, used by a /DA or not. A name
    ``src`` did not hold stays as written, except `Helv`, which takes the
    standard face. An entry ``dst`` already holds is never replaced or moved.
    Returns how many /DA strings were rewritten."""
    uses = []
    seen = set()
    nodes = list(_field_nodes(fields))
    for holder in [*(a for a in annotations if formats_text(a)), *nodes]:
        key = _node_key(holder)
        if key in seen:
            continue
        seen.add(key)
        da = holder.get("/DA")
        if not isinstance(da, pikepdf.String):
            continue
        text = bytes(da).decode("latin-1")
        names = appearance_fonts(text)
        if names:
            uses.append((holder, text, names))
    source_fonts = default_fonts(src)
    wanted = [name for _, _, names in uses for name in names]
    if nodes and source_fonts is not None:
        wanted.extend(font_token(key) for key in source_fonts.keys())
    if not wanted:
        return 0
    renames: dict = {}
    moved: dict = {}
    for name in dict.fromkeys(wanted):
        intended = held_font(source_fonts, name)
        if intended is None:
            if name == STANDARD_NAME:
                renames[name] = hold_standard_font(dst)
            continue
        if not intended.is_indirect:
            source_fonts[font_key(name)] = src.make_indirect(intended)
            intended = source_fonts[font_key(name)]
        key = interchangeable_key(intended)
        copied = None

        def copy(intended=intended):
            nonlocal copied
            if copied is None:
                copied = dst.copy_foreign(intended)
            return copied

        def accepts(held, key=key, copy=copy):
            if key is not None:
                return interchangeable_key(held) == key
            return _same_object(held, copy())

        fonts = default_fonts(dst, create=True)
        target = _name_for(fonts, name, accepts)
        if held_font(fonts, target) is None:
            fonts[font_key(target)] = copy()
        renames[name] = target
        if target != name:
            moved[name] = fonts[font_key(target)]
    rewritten = 0
    for holder, text, _ in uses:
        changed = rewrite_fonts(text, renames)
        if changed != text:
            holder["/DA"] = pikepdf.String(changed.encode("latin-1"))
            rewritten += 1
    if moved:
        seen = set()
        for holder in [*(a for a in annotations if isinstance(a, Dictionary)), *nodes]:
            key = _node_key(holder)
            if key in seen:
                continue
            seen.add(key)
            for stream in _appearance_streams(holder):
                _hold_fallback_fonts(stream, moved)
    return rewritten
