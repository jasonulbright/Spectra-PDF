"""Shared object-model helpers: inheritable page attributes, and name bytes.

Several page attributes (/Resources, /Rotate, /MediaBox, /CropBox) are
inheritable per the PDF spec: a page dict lacking its own entry takes it
from the nearest ancestor /Pages node that has one — common output from
generators that hoist a single shared dict onto the tree rather than
duplicating it per page. ``page.obj.get`` alone only ever sees the page's
OWN dict, which silently misreads such files (an inherited /Resources is a
redaction false negative; watermark needs the same walk for /Rotate and the
boxes). One implementation here so a future fix propagates to every consumer.

A name is its byte sequence (ISO 32000-2 §7.3.5): two names whose bytes
differ are different objects. A name shown as text — a colourant name, a
font name — should be read as UTF-8, and a producer can still write any other
byte into one. `str()` of a pikepdf name decodes strictly and raises on such
a byte, and `keys()` spells a dictionary key with each such byte as a lone
surrogate, which the JSON reader on the host side of the engine rejects
along with the whole response line. So the bytes stay the identity, and text
is derived from them only to be shown.
"""

import pikepdf


def walk_inheritable(page: "pikepdf.Page", key: str):
    """Resolve an inheritable page attribute via the /Parent chain.

    Returns the first value found walking from the page up through its
    ancestor /Pages nodes, or None if absent everywhere. The depth cap only
    exists to terminate on malformed cyclic trees.
    """
    node = page.obj
    seen = 0
    while node is not None and seen < 64:
        value = node.get(key)
        if value is not None:
            return value
        node = node.get("/Parent")
        seen += 1
    return None


def name_bytes(obj) -> bytes | None:
    """The bytes a name holds, solidus excluded, or None for anything else.

    A dictionary key as `keys()` spells it is a name too: a `str` starting
    with the solidus, whose lone surrogates stand for the bytes that are not
    UTF-8.
    """
    if isinstance(obj, pikepdf.Name):
        raw = bytes(obj)
    elif isinstance(obj, str) and obj.startswith("/"):
        raw = obj.encode("utf-8", "surrogateescape")
    else:
        return None
    return raw[1:] if raw.startswith(b"/") else raw


def name_label(raw: bytes) -> str:
    """The text a name's bytes are shown as.

    UTF-8 text when the bytes are UTF-8. Otherwise each byte that does not
    decode is written `#XX` and each `#` as `#23`, the escape a name is
    written with in the file, so two names that differ only in such bytes are
    shown apart. The text is never an identity: a UTF-8 name can spell the
    same characters as another name's escapes.
    """
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    out: list[str] = []
    for char in raw.decode("utf-8", "surrogateescape"):
        code = ord(char)
        if 0xDC80 <= code <= 0xDCFF:
            out.append(f"#{code - 0xDC00:02X}")
        elif char == "#":
            out.append("#23")
        else:
            out.append(char)
    return "".join(out)


def name_text(obj) -> str:
    """`name_label` of a name, solidus excluded; `str(obj)` of anything else."""
    raw = name_bytes(obj)
    return name_label(raw) if raw is not None else str(obj)


def key_text(obj) -> str:
    """A name as `keys()` spells a dictionary key: solidus included, its
    bytes read as UTF-8, each other byte a lone surrogate. Membership and
    indexing take this spelling for any name; `Name()` and `.get()` take
    UTF-8 text only. `str(obj)` of anything else.

    It is identity, not text to show: a lone surrogate reaches no response
    as it is (`ipc.encode_response`)."""
    if isinstance(obj, pikepdf.Name):
        return bytes(obj).decode("utf-8", "surrogateescape")
    return str(obj)


def key_name(spelling: str):
    """The name object `key_text` spells, solidus optional."""
    raw = spelling.encode("utf-8", "surrogateescape")
    return name_object(raw[1:] if raw.startswith(b"/") else raw)


def token_text(obj) -> str:
    """`str(obj)`, which never raises.

    A name reads as its solidus and `name_label`, an operator as its bytes'
    `name_label`: the text `str()` gives for every UTF-8 token, and for any
    other one a text no keyword and no standard name spells, so a comparison
    against one takes its "unknown" branch. A content-stream operator is a
    keyword (ISO 32000-2 §7.8.2) of regular characters, and every byte that
    is not a delimiter or white space is regular (§7.2.3), so a damaged
    stream can hold an operator of bytes that are not UTF-8.

    `str()` of a dictionary or an array decodes every name it holds the same
    strict way, so a container holding such a name reads as the syntax
    `unparse()` writes for it, which spells no name.
    """
    if isinstance(obj, pikepdf.Name):
        return "/" + name_label(bytes(obj)[1:])
    if isinstance(obj, pikepdf.Operator):
        return name_label(bytes(obj))
    try:
        return str(obj)
    except UnicodeDecodeError:
        if not isinstance(obj, pikepdf.Object):
            raise
        return obj.unparse().decode("latin-1")


def name_object(raw: bytes):
    """A name object holding exactly `raw`.

    `Name()` takes UTF-8 text only and refuses the empty name; a parsed token
    with every byte escaped holds any name.
    """
    return pikepdf.Object.parse(b"/" + b"".join(b"#%02X" % byte for byte in raw))


_HEX_DIGITS = frozenset(b"0123456789ABCDEFabcdef")


def exact_pyhanko_names() -> None:
    """Make pyHanko read and write each name as its own bytes.

    pyHanko reads a name whose bytes are not UTF-8 as Latin-1 text and writes
    every name as the UTF-8 encoding of its text, so each such name leaves a
    pyHanko writer with other bytes: in a signed revision, an appended
    revision, a certificate-encrypted copy. It also writes a byte below 10h
    as a one-digit escape, where the escape takes two hexadecimal digits
    (ISO 32000-2 §7.3.5). After this call a name reads as `key_text` spells
    it and writes back as the bytes it was read from; the read keeps
    pyHanko's own refusals of a malformed name. Idempotent, and global to the
    process, which serves one request at a time.
    """
    from pyhanko.pdf_utils import generic, misc

    if getattr(generic.NameObject, "exact_bytes", False):
        return

    def read_from_stream(stream):
        if stream.read(1) != b"/":
            raise misc.PdfReadError("Name object should start with /")
        token = misc.read_until_delimiter(stream)
        raw = bytearray(b"/")
        index = 0
        while index < len(token):
            byte = token[index]
            if byte == 0x23:
                digits = token[index + 1:index + 3]
                if len(digits) < 2:
                    raise misc.PdfReadError(f"Unterminated escape in PDF name /{bytes(token)!r}")
                if not all(digit in _HEX_DIGITS for digit in digits):
                    raise misc.PdfReadError("Numeric escape in PDF name must use hexadecimal digits")
                raw.append(int(digits, 16))
                index += 3
                continue
            if not (0x21 <= byte <= 0x7E) or not misc.is_regular_character(byte):
                raise misc.PdfReadError(f"Byte (0x{byte:02x}) must be escaped in a PDF name")
            raw.append(byte)
            index += 1
        return generic.NameObject(bytes(raw).decode("utf-8", "surrogateescape"))

    def write_to_stream(self, stream, handler=None, container_ref=None):
        raw = self.encode("utf-8", "surrogateescape")
        if not raw.startswith(b"/"):
            raise misc.PdfWriteError(f"Could not serialise name object {self!r}, must start with /")
        stream.write(b"/" + b"".join(
            bytes((byte,)) if 0x21 <= byte <= 0x7E and byte != 0x23 and misc.is_regular_character(byte)
            else b"#%02X" % byte
            for byte in raw[1:]
        ))

    generic.NameObject.read_from_stream = staticmethod(read_from_stream)
    generic.NameObject.write_to_stream = write_to_stream
    generic.NameObject.exact_bytes = True
