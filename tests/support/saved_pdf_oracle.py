"""qpdf's reading of one saved PDF, printed as JSON.

argv: the file, then the texts to search for.

  problems     qpdf's syntax check.
  found        the texts any object qpdf lists holds, decoded streams included.
  pages        the page count.
  unreachable  objects qpdf lists that the trailer does not reach. Object-stream
               containers and cross-reference streams are file structure and
               are not listed.
  missing      a resource a content stream names that its resource dictionary
               does not resolve: a font, an XObject, a graphics state or a
               shading, for each page and each annotation appearance stream,
               through nested form XObjects. An embedded font program that is
               not a readable stream is listed too. For the form: a font that
               the default appearance string of the interactive form
               dictionary or of a field names and the form's default resource
               dictionary does not hold (ISO 32000-2 12.7.4.3 allows no other
               place), and a default resource entry that is not an object.
               The same for the default appearance string of each free text
               annotation (12.5.6.6 reads it by 12.7.4.3) and of each
               redaction annotation that has overlay text (12.5.6.23,
               Table 195, reads it by 12.7.4.3 too). A default
               appearance string that starts with a byte order mark is listed:
               its content is content-stream syntax, read byte by byte.
  default_fonts  the entries of `missing` that name a default appearance font
               the default resources do not hold. Each names the form, a field
               by its full name, a free text annotation or a redaction, and no page or
               position, so the reading of a file and of the file a commit
               made from it can be compared.
  used         how many names resolved, so a caller can require that a check
               ran on something.
"""

import json
import sys

import pikepdf

OPERATOR_TABLE = {"Tf": "/Font", "Do": "/XObject", "gs": "/ExtGState", "sh": "/Shading"}
FONT_PROGRAM_KEYS = ("/FontFile", "/FontFile2", "/FontFile3")
STRUCTURE_STREAMS = ("/ObjStm", "/XRef")


def spellings(text):
    utf16 = text.encode("utf-16-be")
    plain = text.encode("latin-1")
    return [s.lower() for s in (plain, utf16, plain.hex().encode(), utf16.hex().encode())]


def held_texts(pdf, needles):
    parts = []
    for obj in pdf.objects:
        if isinstance(obj, pikepdf.Stream):
            parts.append(obj.stream_dict.unparse(resolved=True))
            try:
                parts.append(obj.read_bytes())
            except Exception:
                parts.append(obj.read_raw_bytes())
        elif isinstance(obj, pikepdf.Object):
            parts.append(obj.unparse(resolved=True))
    data = b"\n".join(parts).lower()
    return [n for n in needles if any(s in data for s in spellings(n))]


def children(obj):
    if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
        return [obj[key] for key in obj.keys()]
    if isinstance(obj, pikepdf.Array):
        return list(obj)
    return []


def unreachable_objects(pdf):
    reached = set()
    stack = [pdf.trailer]
    while stack:
        obj = stack.pop()
        if not isinstance(obj, pikepdf.Object):
            continue
        if obj.is_indirect:
            if obj.objgen in reached:
                continue
            reached.add(obj.objgen)
        stack.extend(children(obj))
    out = []
    for obj in pdf.objects:
        if not isinstance(obj, pikepdf.Object) or obj.objgen in reached:
            continue
        if isinstance(obj, pikepdf.Stream) and str(obj.get("/Type", "")) in STRUCTURE_STREAMS:
            continue
        out.append("%d %d" % obj.objgen)
    return sorted(out)


class Resources:
    def __init__(self):
        self.missing = []
        self.used = {"fonts": 0, "embedded_fonts": 0, "images": 0, "forms": 0, "graphics_states": 0, "shadings": 0,
                     "form_fonts": 0, "form_resources": 0}
        self.default_fonts = []
        self.entered = set()
        # Holds the streams a default appearance string is parsed through, so
        # the file under test gains no object.
        self.scratch = pikepdf.new()

    def font(self, where, font):
        if not isinstance(font, pikepdf.Dictionary):
            self.missing.append("%s: font is not a dictionary" % where)
            return
        self.used["fonts"] += 1
        holders = [font]
        descendants = font.get("/DescendantFonts")
        if isinstance(descendants, pikepdf.Array):
            holders.extend(d for d in descendants if isinstance(d, pikepdf.Dictionary))
        for holder in holders:
            descriptor = holder.get("/FontDescriptor")
            if not isinstance(descriptor, pikepdf.Dictionary):
                continue
            for key in FONT_PROGRAM_KEYS:
                if key not in descriptor:
                    continue
                program = descriptor[key]
                if isinstance(program, pikepdf.Stream) and len(program.read_bytes()) > 0:
                    self.used["embedded_fonts"] += 1
                else:
                    self.missing.append("%s: font program %s is not a readable stream" % (where, key))

    def content(self, where, holder, resources, depth=0):
        if depth > 16:
            self.missing.append("%s: form XObjects nest too deep" % where)
            return
        try:
            instructions = pikepdf.parse_content_stream(holder)
        except Exception as error:
            self.missing.append("%s: content does not parse: %s" % (where, error))
            return
        for instruction in instructions:
            kind = OPERATOR_TABLE.get(str(instruction.operator))
            if kind is None or not instruction.operands:
                continue
            name = instruction.operands[0]
            if not isinstance(name, pikepdf.Name):
                continue
            table = resources.get(kind) if isinstance(resources, pikepdf.Dictionary) else None
            target = table.get(str(name)) if isinstance(table, pikepdf.Dictionary) else None
            if target is None:
                self.missing.append("%s: %s %s" % (where, kind, name))
                continue
            if kind == "/Font":
                self.font("%s %s" % (where, name), target)
            elif kind == "/ExtGState":
                self.used["graphics_states"] += 1
            elif kind == "/Shading":
                self.used["shadings"] += 1
            elif not isinstance(target, pikepdf.Stream):
                self.missing.append("%s: XObject %s is not a stream" % (where, name))
            elif str(target.get("/Subtype", "")) == "/Image":
                if len(target.read_raw_bytes()) == 0:
                    self.missing.append("%s: image %s holds no data" % (where, name))
                else:
                    self.used["images"] += 1
            else:
                self.used["forms"] += 1
                if target.is_indirect and target.objgen in self.entered:
                    continue
                if target.is_indirect:
                    self.entered.add(target.objgen)
                own = target.get("/Resources")
                self.content("%s %s" % (where, name), target, own if own is not None else resources, depth + 1)


    def default_appearance(self, where, holder, fonts):
        text = holder.get("/DA")
        if text is None:
            return
        if not isinstance(text, pikepdf.String):
            self.missing.append("%s /DA: not a string" % where)
            return
        if bytes(text).startswith((bytes([0xFE, 0xFF]), bytes([0xFF, 0xFE]), bytes([0xEF, 0xBB, 0xBF]))):
            self.missing.append("%s /DA: starts with a byte order mark" % where)
            return
        try:
            instructions = pikepdf.parse_content_stream(pikepdf.Stream(self.scratch, bytes(text)))
        except Exception as error:
            self.missing.append("%s /DA: does not parse: %s" % (where, error))
            return
        for instruction in instructions:
            if str(instruction.operator) != "Tf" or not instruction.operands:
                continue
            name = instruction.operands[0]
            if not isinstance(name, pikepdf.Name):
                continue
            # A name is its bytes: one that is not UTF-8 is a key by membership
            # and indexing only, and is reported by its bytes.
            key = bytes(name).decode("utf-8", "surrogateescape")
            shown = bytes(name).decode("latin-1")
            target = fonts[key] if isinstance(fonts, pikepdf.Dictionary) and key in fonts else None
            if target is None:
                self.missing.append("%s /DA: /Font %s" % (where, shown))
                self.default_fonts.append("%s /DA: /Font %s" % (where, shown))
                continue
            if isinstance(target, pikepdf.Dictionary):
                self.used["form_fonts"] += 1
            else:
                self.missing.append("%s /DA: font %s is not a dictionary" % (where, shown))

    def free_text(self, pdf):
        form = pdf.Root.get("/AcroForm")
        defaults = form.get("/DR") if isinstance(form, pikepdf.Dictionary) else None
        fonts = defaults.get("/Font") if isinstance(defaults, pikepdf.Dictionary) else None
        for page in pdf.pages:
            annotations = page.obj.get("/Annots")
            if not isinstance(annotations, pikepdf.Array):
                continue
            for annotation in annotations:
                if not isinstance(annotation, pikepdf.Dictionary):
                    continue
                subtype = str(annotation.get("/Subtype", ""))
                if subtype == "/FreeText":
                    self.default_appearance("free text", annotation, fonts)
                elif subtype == "/Redact" and annotation.get("/OverlayText") is not None:
                    self.default_appearance("redaction", annotation, fonts)

    def form(self, pdf):
        form = pdf.Root.get("/AcroForm")
        if not isinstance(form, pikepdf.Dictionary):
            return
        defaults = form.get("/DR")
        if defaults is not None and not isinstance(defaults, pikepdf.Dictionary):
            self.missing.append("form /DR: not a dictionary")
            defaults = None
        if defaults is not None:
            for kind in defaults.keys():
                table = defaults[kind]
                if isinstance(table, pikepdf.Array):
                    continue
                if not isinstance(table, pikepdf.Dictionary):
                    self.missing.append("form /DR %s: not a dictionary" % kind)
                    continue
                for name in table.keys():
                    if isinstance(table[name], (pikepdf.Dictionary, pikepdf.Stream, pikepdf.Array, pikepdf.Name)):
                        self.used["form_resources"] += 1
                    else:
                        self.missing.append("form /DR %s %s: not an object" % (kind, name))
        fonts = defaults.get("/Font") if defaults is not None else None
        self.default_appearance("form", form, fonts)
        seen = set()
        stack = [(field, "") for field in reversed(list(form.get("/Fields", [])))]
        while stack:
            field, prefix = stack.pop()
            if not isinstance(field, pikepdf.Dictionary):
                continue
            if field.is_indirect:
                if field.objgen in seen:
                    continue
                seen.add(field.objgen)
            partial = field.get("/T")
            name = prefix + ("." if prefix and partial is not None else "") + (str(partial) if partial is not None else "")
            self.default_appearance("field %s" % name, field, fonts)
            kids = field.get("/Kids")
            if isinstance(kids, pikepdf.Array):
                stack.extend((kid, name) for kid in reversed(list(kids)))


def inherited_resources(page):
    node = page
    for _ in range(64):
        if not isinstance(node, pikepdf.Dictionary):
            return None
        if "/Resources" in node:
            return node["/Resources"]
        node = node.get("/Parent")
    return None


def appearance_streams(annotation):
    appearance = annotation.get("/AP")
    if not isinstance(appearance, pikepdf.Dictionary):
        return
    for key in ("/N", "/D", "/R"):
        entry = appearance.get(key)
        if isinstance(entry, pikepdf.Stream):
            yield key, entry
        elif isinstance(entry, pikepdf.Dictionary):
            for state in entry.keys():
                if isinstance(entry[state], pikepdf.Stream):
                    yield "%s%s" % (key, state), entry[state]


def main():
    pdf = pikepdf.open(sys.argv[1])
    needles = sys.argv[2:]
    check = getattr(pdf, "check_pdf_syntax", None) or pdf.check
    resources = Resources()
    for number, page in enumerate(pdf.pages, start=1):
        where = "page %d" % number
        if "/Contents" in page.obj:
            resources.content(where, page.obj, inherited_resources(page.obj))
        annotations = page.obj.get("/Annots")
        if not isinstance(annotations, pikepdf.Array):
            continue
        for index, annotation in enumerate(annotations):
            if not isinstance(annotation, pikepdf.Dictionary):
                continue
            annotation.get("/Subtype")
            for label, stream in appearance_streams(annotation):
                resources.content("%s annotation %d %s" % (where, index, label), stream, stream.get("/Resources"))
    resources.form(pdf)
    resources.free_text(pdf)
    print(json.dumps({
        "problems": [str(problem) for problem in check()],
        "found": held_texts(pdf, needles),
        "pages": len(pdf.pages),
        "unreachable": unreachable_objects(pdf),
        "missing": resources.missing,
        "default_fonts": resources.default_fonts,
        "used": resources.used,
    }))


main()
