"""Form DATA interchange: FDF and XFDF field values, and the HTML encoding.

The payload half of `/ImportData` and `/SubmitForm`. Both actions carry a file
or a URL and a format; this module turns a document's field values into that
format and reads one back.

**FDF is parsed here rather than through pikepdf.** An FDF file is PDF SYNTAX
without a page tree, and qpdf refuses it for exactly that reason
(``root of pages tree has no /Kids array``), so the object grammar is walked
directly. The parser accepts what an FDF actually contains -- dictionaries,
arrays, names, numbers, booleans, null, literal and hexadecimal strings, and
indirect references -- and treats anything it cannot read as absent rather than
guessing at it.

**What the transport is, and is not.** Building a submission is the whole of
`/SubmitForm` except the request. This app performs no outbound request and
opens no external address: the submission is written to a file the user names,
and the destination is reported and offered to the clipboard, which is the same
posture the `/URI` action has always had here.
"""

from __future__ import annotations

import re
from urllib.parse import quote
from xml.etree.ElementTree import Element, fromstring
from xml.sax.saxutils import escape

#: The XFDF namespace, shared with `engine.xfdf`'s annotation arm.
XFDF_NS = "http://ns.adobe.com/xfdf/"

#: Where PDFDocEncoding departs from Latin-1. Every other code point is the
#: same in both, so a text string with no byte-order mark decodes through this
#: table and Latin-1 together.
_PDFDOC_HIGH = (
    "\u2022\u2020\u2021\u2026\u2014\u2013\u0192\u2044\u2039\u203a\u2212\u2030"
    "\u201e\u201c\u201d\u2018\u2019\u201a\u2122\ufb01\ufb02\u0141\u0152\u0160"
    "\u0178\u017d\u0131\u0142\u0153\u0161\u017e\ufffd"
)

_WHITESPACE = b"\x00\t\n\x0c\r "
_DELIMITERS = b"()<>[]{}/%"


class FormDataError(ValueError):
    """A data file this module cannot read as form data."""


# ── the FDF object grammar ────────────────────────────────────────────────


class _Ref:
    """An indirect reference, resolved against the object table on demand."""

    __slots__ = ("num", "gen")

    def __init__(self, num: int, gen: int):
        self.num = num
        self.gen = gen

    def __repr__(self) -> str:  # pragma: no cover - diagnostics only
        return f"<ref {self.num} {self.gen}>"


class _Name(str):
    """A `/Name`, kept distinct from a string so a checkbox value written as
    `/Yes` is not confused with the text "Yes" typed into a text field."""

    __slots__ = ()


def _decode_text(raw: bytes) -> str:
    if raw[:2] == b"\xfe\xff":
        return raw[2:].decode("utf-16-be", "replace")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw[3:].decode("utf-8", "replace")
    return "".join(
        _PDFDOC_HIGH[b - 0x80] if 0x80 <= b <= 0x9F else chr(b) for b in raw
    )


class _Lexer:
    """Just enough of the PDF object grammar for an FDF.

    Deliberately not a general PDF reader: there is no cross-reference table
    to follow, no object streams to expand and no filters to apply, because an
    FDF carries none of them where its field values live.
    """

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def skip(self) -> None:
        data = self.data
        while self.pos < len(data):
            ch = data[self.pos]
            if ch in _WHITESPACE:
                self.pos += 1
                continue
            if ch == 0x25:  # '%' — a comment runs to the end of the line
                end = data.find(b"\n", self.pos)
                self.pos = len(data) if end < 0 else end + 1
                continue
            return

    def _literal_string(self) -> bytes:
        data = self.data
        self.pos += 1
        depth = 1
        out = bytearray()
        while self.pos < len(data):
            ch = data[self.pos]
            if ch == 0x5C:  # backslash
                self.pos += 1
                if self.pos >= len(data):
                    break
                esc = data[self.pos]
                mapped = {0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12}.get(esc)
                if mapped is not None:
                    out.append(mapped)
                    self.pos += 1
                elif 0x30 <= esc <= 0x37:  # octal, up to three digits
                    digits = ""
                    while self.pos < len(data) and len(digits) < 3 and 0x30 <= data[self.pos] <= 0x37:
                        digits += chr(data[self.pos])
                        self.pos += 1
                    out.append(int(digits, 8) & 0xFF)
                elif esc == 0x0A:  # a line continuation contributes nothing
                    self.pos += 1
                elif esc == 0x0D:
                    self.pos += 1
                    if self.pos < len(data) and data[self.pos] == 0x0A:
                        self.pos += 1
                else:
                    out.append(esc)
                    self.pos += 1
                continue
            if ch == 0x28:
                depth += 1
            elif ch == 0x29:
                depth -= 1
                if depth == 0:
                    self.pos += 1
                    return bytes(out)
            out.append(ch)
            self.pos += 1
        return bytes(out)

    def _hex_string(self) -> bytes:
        data = self.data
        self.pos += 1
        end = data.find(b">", self.pos)
        if end < 0:
            end = len(data)
        digits = re.sub(rb"[^0-9A-Fa-f]", b"", data[self.pos : end])
        self.pos = end + 1
        if len(digits) % 2:
            digits += b"0"
        try:
            return bytes.fromhex(digits.decode("ascii"))
        except ValueError:
            return b""

    def _name(self) -> _Name:
        data = self.data
        self.pos += 1
        start = self.pos
        while self.pos < len(data) and data[self.pos] not in _WHITESPACE and data[self.pos] not in _DELIMITERS:
            self.pos += 1
        raw = data[start : self.pos]
        # '#xx' is the format's own escape for a byte a name cannot spell.
        decoded = re.sub(rb"#([0-9A-Fa-f]{2})", lambda m: bytes([int(m.group(1), 16)]), raw)
        return _Name(decoded.decode("utf-8", "replace"))

    def _keyword(self) -> bytes:
        data = self.data
        start = self.pos
        while self.pos < len(data) and data[self.pos] not in _WHITESPACE and data[self.pos] not in _DELIMITERS:
            self.pos += 1
        if self.pos == start:  # an unexpected delimiter: step over it
            self.pos += 1
        return data[start : self.pos]

    def value(self, depth: int = 0):
        """The next object, or ``None`` at the end of the input."""
        if depth > 64:
            raise FormDataError("this data file nests too deeply to read")
        self.skip()
        data = self.data
        if self.pos >= len(data):
            return None
        ch = data[self.pos]
        if ch == 0x28:
            return _decode_text(self._literal_string())
        if ch == 0x2F:
            return self._name()
        if ch == 0x3C:
            if data[self.pos : self.pos + 2] == b"<<":
                return self._dictionary(depth)
            return _decode_text(self._hex_string())
        if ch == 0x5B:
            self.pos += 1
            out = []
            while True:
                self.skip()
                if self.pos >= len(data):
                    break
                if data[self.pos] == 0x5D:
                    self.pos += 1
                    break
                item = self.value(depth + 1)
                if item is _END:
                    break
                out.append(item)
            return out
        if ch == 0x5D or ch == 0x3E:  # a stray closer: consumed by the caller
            return _END
        keyword = self._keyword()
        if keyword == b"true":
            return True
        if keyword == b"false":
            return False
        if keyword == b"null":
            return None
        number = _number(keyword)
        if number is None:
            # A keyword this grammar does not carry (`endobj`, a producer's
            # own marker) is nothing rather than a guess.
            return None
        # `N G R` is an indirect reference. The lookahead is undone unless the
        # `R` is actually there, so a bare number followed by another number
        # stays two numbers.
        save = self.pos
        if isinstance(number, int):
            self.skip()
            gen = _number(self._keyword())
            if isinstance(gen, int):
                self.skip()
                if self._keyword() == b"R":
                    return _Ref(number, gen)
        self.pos = save
        return number

    def _dictionary(self, depth: int) -> dict:
        self.pos += 2
        out: dict = {}
        data = self.data
        while True:
            self.skip()
            if self.pos >= len(data):
                break
            if data[self.pos : self.pos + 2] == b">>":
                self.pos += 2
                break
            if data[self.pos] != 0x2F:
                # A key that is not a name means the dictionary is unreadable
                # from here; stop rather than resynchronize onto values.
                item = self.value(depth + 1)
                if item is _END or item is None:
                    break
                continue
            key = self._name()
            value = self.value(depth + 1)
            if value is _END:
                break
            # Keys carry their slash so a dictionary reads the way every other
            # module in this engine spells one (`node["/Fields"]`).
            out["/" + str(key)] = value
        return out


class _End:
    __slots__ = ()


_END = _End()


def _number(word: bytes):
    if not word:
        return None
    try:
        return int(word)
    except ValueError:
        pass
    try:
        return float(word)
    except ValueError:
        return None


_OBJ = re.compile(rb"(?<![0-9])(\d+)\s+(\d+)\s+obj\b")


def _object_table(data: bytes) -> dict:
    """``{(num, gen): offset}`` by scanning for object headers.

    A scan rather than a cross-reference read: an FDF's xref is optional in
    practice, producers write it inconsistently, and every object in the file
    is reachable by scanning. Later definitions win, which is what an
    incremental update means.
    """
    table: dict = {}
    for match in _OBJ.finditer(data):
        table[(int(match.group(1)), int(match.group(2)))] = match.end()
    return table


class _Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.table = _object_table(data)
        self.cache: dict = {}

    def resolve(self, value, depth: int = 0):
        if not isinstance(value, _Ref) or depth > 32:
            return value
        key = (value.num, value.gen)
        if key in self.cache:
            return self.cache[key]
        offset = self.table.get(key)
        if offset is None:
            return None
        lexer = _Lexer(self.data)
        lexer.pos = offset
        parsed = lexer.value()
        if parsed is _END:
            parsed = None
        self.cache[key] = parsed
        return self.resolve(parsed, depth + 1)

    def get(self, node, key: str, depth: int = 0):
        if not isinstance(node, dict):
            return None
        return self.resolve(node.get(key), depth)


# ── FDF: reading ──────────────────────────────────────────────────────────


def _value_of(reader: _Reader, node):
    """One field's `/V`, as the wire vocabulary the fill already speaks: a
    name becomes its bare text (a checkbox's ``Yes``/``Off``, a radio's option),
    an array becomes a list (a multi-select), anything else becomes text."""
    value = reader.get(node, "/V")
    if value is None:
        return None
    if isinstance(value, _Name):
        return str(value)
    if isinstance(value, list):
        return [str(reader.resolve(v)) for v in value]
    if isinstance(value, bool):
        return "Yes" if value else "Off"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _walk_fdf_fields(reader: _Reader, entries, prefix: str, out: dict, depth: int) -> None:
    if depth > 32 or not isinstance(entries, list):
        return
    for entry in entries:
        node = reader.resolve(entry)
        if not isinstance(node, dict):
            continue
        title = reader.get(node, "/T")
        name = prefix
        if title is not None:
            part = str(title)
            name = f"{prefix}.{part}" if prefix else part
        kids = reader.get(node, "/Kids")
        if isinstance(kids, list) and kids:
            _walk_fdf_fields(reader, kids, name, out, depth + 1)
            continue
        if not name:
            continue
        value = _value_of(reader, node)
        if value is not None:
            out[name] = value


def parse_fdf(data: bytes) -> dict:
    """``{fully-qualified field name: value}`` from FDF bytes."""
    reader = _Reader(data)
    root = None
    match = re.search(rb"trailer\b", data)
    if match:
        lexer = _Lexer(data)
        lexer.pos = match.end()
        trailer = lexer.value()
        if isinstance(trailer, dict):
            root = reader.resolve(trailer.get("/Root"))
    if not isinstance(root, dict):
        # A producer that wrote no trailer still wrote the /FDF dictionary;
        # find it among the objects rather than refusing a readable file.
        for key in reader.table:
            candidate = reader.resolve(_Ref(*key))
            if isinstance(candidate, dict) and "/FDF" in candidate:
                root = candidate
                break
    fdf = reader.get(root, "/FDF") if isinstance(root, dict) else None
    if not isinstance(fdf, dict):
        raise FormDataError("this file carries no form data")
    out: dict = {}
    _walk_fdf_fields(reader, reader.get(fdf, "/Fields"), "", out, 0)
    return out


# ── FDF: writing ──────────────────────────────────────────────────────────


def _fdf_string(text: str) -> bytes:
    """A text string in the encoding the value needs: a literal string while
    it is representable without one, a UTF-16BE hexadecimal string otherwise.
    Byte-identical to what the ecosystem writes for the ASCII case."""
    try:
        raw = text.encode("ascii")
    except UnicodeEncodeError:
        return b"<" + (b"\xfe\xff" + text.encode("utf-16-be")).hex().upper().encode("ascii") + b">"
    escaped = raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    escaped = escaped.replace(b"\r", b"\\r").replace(b"\n", b"\\n")
    return b"(" + escaped + b")"


def _fdf_name(text: str) -> bytes:
    out = bytearray(b"/")
    for byte in str(text).encode("utf-8"):
        if byte in _WHITESPACE or byte in _DELIMITERS or byte == 0x23 or byte > 0x7E:
            out += b"#%02X" % byte
        else:
            out.append(byte)
    return bytes(out)


def _fdf_value(value) -> bytes:
    if isinstance(value, bool):
        return _fdf_name("Yes" if value else "Off")
    if isinstance(value, (list, tuple)):
        return b"[" + b" ".join(_fdf_string(str(v)) for v in value) + b"]"
    return _fdf_string(str(value))


def write_fdf(values: dict, source: str = "") -> bytes:
    """FDF bytes carrying ``values``.

    ``source`` is the document the data belongs to; it rides in `/F` so a
    consumer that opens the FDF alone knows which form to fill. Fields are
    written FLAT under their fully-qualified names, which every consumer
    resolves and which keeps the file readable by eye.
    """
    fields = bytearray(b"[")
    for name in sorted(values):
        fields += b" << /T " + _fdf_string(str(name))
        fields += b" /V " + _fdf_value(values[name]) + b" >>"
    fields += b" ]"
    body = bytearray(b"<< /Fields ")
    body += fields
    if source:
        body += b" /F " + _fdf_string(source)
    body += b" >>"
    return (
        b"%FDF-1.2\n"
        b"1 0 obj\n<< /FDF " + bytes(body) + b" >>\nendobj\n"
        b"trailer\n<< /Root 1 0 R >>\n%%EOF\n"
    )


# ── XFDF form data ────────────────────────────────────────────────────────


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _walk_xfdf_fields(node: Element, prefix: str, out: dict, depth: int) -> None:
    if depth > 32:
        return
    for child in node:
        if _local(child.tag) != "field":
            continue
        part = (child.get("name") or "").strip()
        name = f"{prefix}.{part}" if prefix and part else (part or prefix)
        values = [v for v in child if _local(v.tag) == "value"]
        nested = [v for v in child if _local(v.tag) == "field"]
        if nested:
            _walk_xfdf_fields(child, name, out, depth + 1)
        if not values or not name:
            continue
        texts = [v.text or "" for v in values]
        out[name] = texts if len(texts) > 1 else texts[0]


def parse_xfdf_fields(text: str) -> dict:
    """``{fully-qualified field name: value}`` from XFDF form data."""
    try:
        root = fromstring(text)
    except Exception as exc:  # noqa: BLE001 - any XML failure is one condition
        raise FormDataError("this file is not readable XFDF") from exc
    fields = None
    for child in root:
        if _local(child.tag) == "fields":
            fields = child
            break
    if fields is None:
        raise FormDataError("this file carries no form data")
    out: dict = {}
    _walk_xfdf_fields(fields, "", out, 0)
    return out


def write_xfdf_fields(values: dict, source: str = "") -> bytes:
    """XFDF bytes carrying ``values``. Flat names, matching the FDF half.

    Written as text rather than through an ``ElementTree`` serializer, which
    is the shape ``engine.xfdf`` already writes its annotation arm in: the
    root carries an unqualified ``xml:space`` that a default-namespace
    serialization refuses, and the byte layout is worth pinning anyway.
    """
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<xfdf xmlns="{XFDF_NS}" xml:space="preserve">',
    ]
    if source:
        parts.append(f'<f href="{escape(source, {chr(34): "&quot;"})}"/>')
    parts.append("<fields>")
    for name in sorted(values):
        raw = values[name]
        items = raw if isinstance(raw, (list, tuple)) else [raw]
        body = "".join(f"<value>{escape(_as_text(item))}</value>" for item in items)
        parts.append(f'<field name="{escape(str(name), {chr(34): "&quot;"})}">{body}</field>')
    parts.append("</fields>")
    parts.append("</xfdf>")
    return ("\n".join(parts) + "\n").encode("utf-8")


def _as_text(value) -> str:
    if isinstance(value, bool):
        return "Yes" if value else "Off"
    return str(value)


# ── the HTML encoding ─────────────────────────────────────────────────────


def write_html_form_data(values: dict) -> bytes:
    """`application/x-www-form-urlencoded`, which is what a `/SubmitForm`
    with the export-format flag means by "HTML"."""
    parts = []
    for name in sorted(values):
        raw = values[name]
        items = raw if isinstance(raw, (list, tuple)) else [raw]
        for item in items:
            parts.append(f"{quote(str(name), safe='')}={quote(_as_text(item), safe='')}")
    return "&".join(parts).encode("ascii")


#: What each submission format is written as, by extension.
FORMAT_EXTENSION = {"fdf": ".fdf", "xfdf": ".xfdf", "html": ".txt", "pdf": ".pdf"}


def parse_form_data(path: str) -> dict:
    """Read a data file as ``{field name: value}``, choosing the reader by
    what the file CONTAINS rather than by what it is called -- an FDF saved
    under an .xfdf name is still an FDF."""
    with open(path, "rb") as handle:
        data = handle.read()
    head = data[:1024].lstrip()
    if head.startswith(b"%FDF") or (b"/FDF" in data[:4096] and not head.startswith(b"<")):
        return parse_fdf(data)
    if head.startswith(b"<"):
        return parse_xfdf_fields(data.decode("utf-8", "replace"))
    if head.startswith(b"%PDF"):
        raise FormDataError("a PDF is a form, not form data — open it instead")
    raise FormDataError("this file is neither FDF nor XFDF form data")
