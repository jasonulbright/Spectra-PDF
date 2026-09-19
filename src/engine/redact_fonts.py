"""What a font keeps after a redaction: exactly what the surviving text draws.

Taking text out of a content stream is half of removing it. The font that drew
the text still holds the glyph program of every character it drew, and the
tables around the program name those characters by code, by glyph and by
Unicode value. A file that lost "QZXJ" from its page but still carries glyph
programs for Q, Z, X and J, with nothing left that draws them, states which
characters the redaction removed. ISO 32000-2 §12.5.6.23 requires every trace
of the removed content to go.

The cut is to the survivors, never by the removed: every font whose use shrank
keeps precisely what the remaining text draws. Taking out only the glyphs the
removed text used would leave, in a font embedded whole, a gap exactly the
shape of the removed text.

Use is measured, not inferred from the page walk. A scan before the walk and a
scan after it record, for every font in reach of the marked pages and every
font sharing a program or a table with one, the codes the document draws with
it: page content, forms, tiling patterns, soft-mask groups, the Type 3 glyph
procedures of the codes drawn, annotation appearances in every state, content
the file keeps that nothing draws, and the field and free-text strings a reader
draws from a default appearance. Invisible text (render mode 3, an OCR layer)
is drawn text. A font whose set of codes shrank is cut to what survives; a
program or a table it shares with other fonts keeps the union of all their
survivors, and a font drawing through a program whose glyph ids moved is
remapped whether or not its own use shrank.

Programs (ISO 32000-2 §9.9, Table 124):
  - TrueType and OpenType (`/FontFile2`, `/FontFile3 /OpenType`) and bare CFF
    (`/FontFile3 /Type1C` and `/CIDFontType0C`) go through fontTools'
    subsetter with layout closure off: a ligature or an alternate only the
    removed text drew is not brought back by the letters it joins. Glyph ids
    are compacted and /CIDToGIDMap is rewritten to the new ids, except where a
    code or a CID IS the glyph id — a simple TrueType font without a cmap
    (§9.6.5.4), a CFF without CID operators under a CIDFontType0 (§9.7.4.2).
    There the ids stay, every glyph not kept is emptied, and its name becomes
    one derived from its id, so a removed glyph and a never-drawn one cannot be
    told apart.
  - Type 1 (`/FontFile`): the /CharStrings entries not kept go, every
    subroutine only they called becomes `return`, and the built-in encoding
    stops naming them. Every other byte of the clear text and of the decrypted
    section is unchanged.
  - Type 3: the glyph procedures not kept leave /CharProcs, and the font's
    /Resources becomes its own copy pruned to what the remaining procedures use.
Every cut program is parsed back, and each kept glyph's outline compared with
the original's, before the file is written.

Tables: /Widths runs from the lowest code the survivors draw to the highest,
/FirstChar and /LastChar bounding it, and every code in that range the
survivors do not draw gets width 0; /Encoding /Differences, /ToUnicode and an
embedded CMap keep only the codes the survivors draw; CID /W and /W2 only their
CIDs; /CIDToGIDMap sends every other CID to glyph 0; /CIDSet and /CharSet list
only what the program still holds. A table several fonts share keeps the union
of their survivors. Each descriptor's /FontBBox is kept.

A font that cannot be cut safely refuses the redaction by name through
`image_redact.refuse`, before anything is written.
"""

from __future__ import annotations

import hashlib
import io
import re
from typing import Optional

import pikepdf
from pikepdf import Array, Dictionary, Name, Stream

from engine import image_redact, pdf_fonts, redact_document
from engine.pdf_tree import token_text

# ── limits ────────────────────────────────────────────────────────────────

#: The largest font program cut, in bytes after the stream's filters. The
#: largest single face measured on hand, `simsunb.ttf`, is 21,894,056 bytes.
#: A larger program refuses by name before it is parsed.
MAX_FONT_PROGRAM_BYTES = 64 * 1024 * 1024

#: The largest ToUnicode map read. A two-byte map written as one `bfchar`
#: line for each of its 65,536 codes is under 1.3 MB.
MAX_MAP_BYTES = 8 * 1024 * 1024

#: Content operators one scan interprets, counting only the operators it reads
#: (`_SCANNED_OPERATORS`). The scan runs twice per redaction, before the page
#: walk and after it; the 1,023 pages of the ISO 32000-2 text hold 995,116 of
#: them. Past this count the redaction refuses rather than cut a font on an
#: incomplete count.
MAX_SCAN_OPERATORS = 20_000_000

#: Operators the scan keeps, once read, for the scan after the page walk to
#: read again without a second parse. The 1,023 pages of the ISO 32000-2 text
#: keep 1,002,287. Past this count, the content read later is read again.
MAX_KEPT_OPERATORS = 2_000_000

#: Nesting of forms, patterns, soft masks and Type 3 glyph procedures one scan
#: follows. A cycle stops at its first repeat, so only a chain of this many
#: distinct streams reaches it.
MAX_SCAN_DEPTH = 64

#: Subroutine nesting a traced Type 1 charstring may use. The bound stops a
#: subroutine that calls itself, directly or through others.
MAX_SUBR_DEPTH = 32

_MAX_LABEL = 64
_FONT_SUBTYPES = frozenset({"/Type1", "/MMType1", "/TrueType", "/Type3", "/Type0"})
_SHOW_OPERATORS = frozenset({"Tj", "TJ", "'", '"'})
# Every operator that sets the font, shows text or reaches other content;
# the parser returns nothing else.
_SCANNED_OPERATORS = "q Q Tf Tj TJ ' \" gs Do scn SCN"
_PROGRAM_KEYS = ("/FontFile", "/FontFile2", "/FontFile3")
_APPEARANCE_STATES = ("/N", "/R", "/D")
_FIELD_STRINGS = ("/V", "/DV", "/Opt")
_CAPTIONS = ("/CA", "/RC", "/AC")
_MAP_BLOCK = 100
_SFNT_TAGS = (b"\x00\x01\x00\x00", b"OTTO", b"true", b"typ1")
_ANY = object()
_STRING = pikepdf.ObjectType.string
_ARRAY = pikepdf.ObjectType.array


# ── identity and naming ───────────────────────────────────────────────────


def _key(obj):
    try:
        if obj is not None and obj.is_indirect:
            return tuple(obj.objgen)
    except Exception:
        pass
    return None


def _owned_key(obj, owner, slot: str):
    """`obj`'s objgen, or for a direct object the slot it fills in its owner:
    a direct object has exactly one owner."""
    key = _key(obj)
    if key is not None:
        return key
    owner_key = _key(owner)
    return ("in", owner_key, slot) if owner_key is not None else None


def _text(name) -> str:
    """A name's spelling, solidus included. `str()` decodes UTF-8 and raises
    on the other byte sequences a name may hold (§7.3.5); Latin-1 keeps every
    byte, and font programs spell their glyph names the same way."""
    return bytes(name).decode("latin-1")


def _name(spelled: str):
    """The name object `_text` spells. `Name()` takes UTF-8 text only and
    refuses the empty name; a parsed token of escaped bytes holds any name."""
    raw = spelled.encode("latin-1")[1:]
    return pikepdf.Object.parse(b"/" + b"".join(b"#%02X" % byte for byte in raw))


def _key_text(key: str) -> str:
    """`_text` of a dictionary key as `keys()` hands it over: decoded as UTF-8
    with every other byte escaped to a surrogate."""
    return key.encode("utf-8", "surrogateescape").decode("latin-1")


def _subtype(obj) -> str:
    try:
        value = obj.get("/Subtype")
    except Exception:
        return ""
    return _text(value) if isinstance(value, Name) else ""


def _descendant(font):
    if _subtype(font) != "/Type0":
        return None
    kids = font.get("/DescendantFonts")
    if isinstance(kids, Array) and len(kids) and isinstance(kids[0], Dictionary):
        return kids[0]
    return None


def _descriptor(font):
    owner = _descendant(font) if _subtype(font) == "/Type0" else font
    if owner is None:
        return None
    desc = owner.get("/FontDescriptor")
    return desc if isinstance(desc, Dictionary) else None


def _program_of(descriptor):
    """(`/FontFile*` key, stream) of the embedded program, or (None, None)."""
    if descriptor is None:
        return None, None
    for slot in _PROGRAM_KEYS:
        value = descriptor.get(slot)
        if isinstance(value, Stream):
            return slot, value
    return None, None


def _label(font) -> str:
    """The font's name as a refusal states it: printable ASCII, bounded."""
    text = ""
    for owner in (font, _descendant(font)):
        if owner is None:
            continue
        name = owner.get("/BaseFont")
        if not isinstance(name, Name):
            name = owner.get("/Name")
        if isinstance(name, Name):
            text = _text(name)[1:]
            break
    clean = "".join(ch if 32 < ord(ch) < 127 else "?" for ch in text)[:_MAX_LABEL]
    return clean or "(no name)"


def _refuse(font, reason: str):
    image_redact.refuse(reason, font=_label(font))


def _is_font(obj) -> bool:
    if not isinstance(obj, Dictionary) or _subtype(obj) not in _FONT_SUBTYPES:
        return False
    kind = obj.get("/Type")
    return kind is None or kind == Name("/Font")


def _parts(font) -> list:
    """The objects a font is made of that another font can share. Two fonts
    sharing any of them are cut together."""
    out = []

    def add(value):
        key = _key(value)
        if key is not None:
            out.append(key)

    add(font)
    for slot in ("/ToUnicode", "/Encoding", "/Widths", "/CharProcs"):
        add(font.get(slot))
    desc = _descriptor(font)
    add(desc)
    if desc is not None:
        for slot in _PROGRAM_KEYS + ("/CIDSet",):
            add(desc.get(slot))
    kid = _descendant(font)
    add(kid)
    if kid is not None:
        for slot in ("/CIDToGIDMap", "/W", "/W2"):
            add(kid.get(slot))
    return out


# ── bounded reads ─────────────────────────────────────────────────────────


class _Oversize(Exception):
    """A stream that decodes past the bound it is read under."""


def _read(stream, limit: int, strict: bool = False) -> Optional[bytes]:
    """The stream's decoded bytes (`pdf_fonts.bounded_read`); None when they
    cannot be decoded, and past `limit` None too, or `_Oversize` when
    `strict`."""
    data, too_large = pdf_fonts.bounded_read(stream, limit)
    if too_large and strict:
        raise _Oversize
    return data


# ── encodings (ISO 32000-2 Annex D) ───────────────────────────────────────


def _latin_table(column: int) -> list:
    """code → every glyph name the extraction reader's Latin table gives it."""
    from pdfminer.latin_enc import ENCODING

    table: list = [set() for _ in range(256)]
    for row in ENCODING:
        code = row[column]
        if code is not None:
            table[code].add(row[0])
    return table


def _win_ansi() -> list:
    """WinAnsiEncoding with the second codes Annex D.2 gives (notes 3, 5 and
    6): space at 160, hyphen at 173, and the bullet at every unused code
    above 32."""
    table = _latin_table(3)
    table[160].add("space")
    table[173].add("hyphen")
    for code in range(33, 256):
        if not table[code]:
            table[code].add("bullet")
    return table


def _mac_roman() -> list:
    """MacRomanEncoding with space also at 202 (Annex D.2, note 6)."""
    table = _latin_table(2)
    table[202].add("space")
    return table


def _standard_names() -> list:
    from fontTools.encodings.StandardEncoding import StandardEncoding

    return list(StandardEncoding)


_STANDARD = _latin_table(1)
_MAC_ROMAN = _mac_roman()
_WIN_ANSI = _win_ansi()
# A program whose built-in encoding is StandardEncoding, as a code → name list.
_STANDARD_BUILTIN_NAMES = _standard_names()
_BASE_TABLES = {
    "/StandardEncoding": _STANDARD,
    "/MacRomanEncoding": _MAC_ROMAN,
    "/WinAnsiEncoding": _WIN_ANSI,
}


def _mac_os_roman() -> dict:
    """Glyph name → code in the Mac OS standard Roman encoding, through which a
    (1, 0) cmap subtable is read (§9.6.5.4, Table 113)."""
    from fontTools.encodings.MacRoman import MacRoman

    out: dict = {}
    for code, name in enumerate(MacRoman):
        if name and name != ".notdef":
            out.setdefault(name, code)
    return out


_MAC_OS_ROMAN = _mac_os_roman()


class _Unmapped(Exception):
    """A code whose glyph name depends on an encoding this pass does not hold."""


class _Unreadable(Exception):
    """A structure this pass cannot follow; its caller refuses by name."""


def _differences(encoding) -> list:
    """[(code, glyph name)] in array order; a later entry for a code wins."""
    if not isinstance(encoding, Dictionary):
        return []
    array = encoding.get("/Differences")
    if not isinstance(array, Array):
        return []
    out = []
    code = None
    for item in array:
        if isinstance(item, Name):
            if code is not None and 0 <= code < 256:
                out.append((code, _text(item)[1:]))
            if code is not None:
                code += 1
            continue
        try:
            code = int(item)
        except (TypeError, ValueError):
            code = None
    return out


def _agl_codepoint(name: str) -> Optional[int]:
    from fontTools import agl

    try:
        text = agl.toUnicode(name)
    except Exception:
        return None
    return ord(text) if len(text) == 1 else None


def _recovered(name: str) -> Optional[str]:
    """The standard name for a non-standard one spelling the same character
    (`uni0041` → `A`); some readers look that name up instead."""
    from fontTools import agl

    point = _agl_codepoint(name)
    if point is None:
        return None
    standard = agl.UV2AGL.get(point)
    return standard if standard and standard != name else None


def _symbolic(font) -> bool:
    """The descriptor's Symbolic flag (bit 3, §9.8.2, Table 121)."""
    desc = _descriptor(font)
    try:
        return bool(int(desc.get("/Flags", 0)) & 4) if desc is not None else False
    except (TypeError, ValueError):
        return False


def _code_names(font, code: int, builtin: Optional[list], truetype: bool) -> set:
    """Every glyph name a reader can take code `code` of a simple font to.

    The union over the readings in use: /Differences overrides; otherwise a
    named base encoding; with none, a symbolic font's own built-in encoding
    alone, and for a nonsymbolic one the built-in encoding and the Standard
    encoding (§9.6.5.1, Table 112) and, for TrueType, the WinAnsi and
    MacRoman encodings readers assume for a TrueType font with no base."""
    encoding = font.get("/Encoding")
    diffs = dict(_differences(encoding))
    if code in diffs:
        name = diffs[code]
        out = {name}
        recovered = _recovered(name)
        if recovered:
            out.add(recovered)
        return out
    base = None
    if isinstance(encoding, Name):
        base = encoding
    elif isinstance(encoding, Dictionary) and isinstance(encoding.get("/BaseEncoding"), Name):
        base = encoding.get("/BaseEncoding")
    out: set = set()
    if base is not None:
        table = _BASE_TABLES.get(_text(base))
        if table is None:
            raise _Unmapped(_text(base))
        out |= table[code]
        if truetype and not table[code]:
            out |= _STANDARD[code]
        return out
    if builtin is not None and code < len(builtin):
        name = builtin[code]
        if isinstance(name, str) and name and name != ".notdef":
            out.add(name)
    if _symbolic(font):
        return out
    out |= _STANDARD[code]
    if truetype:
        out |= _WIN_ANSI[code] | _MAC_ROMAN[code]
    return out


def _type3_names(font, code: int) -> set:
    """The glyph name a Type 3 font gives a code (§9.6.5.3)."""
    encoding = font.get("/Encoding")
    diffs = dict(_differences(encoding))
    if code in diffs:
        return {diffs[code]}
    base = encoding.get("/BaseEncoding") if isinstance(encoding, Dictionary) else None
    if isinstance(base, Name):
        table = _BASE_TABLES.get(_text(base))
        if table is None:
            raise _Unmapped(_text(base))
        return set(table[code])
    return set()


def _type3_table(font) -> dict:
    """code → glyph names for all 256 codes of a Type 3 font; a code whose
    name comes from an encoding this pass does not hold names nothing here."""
    encoding = font.get("/Encoding")
    diffs = dict(_differences(encoding))
    base = encoding.get("/BaseEncoding") if isinstance(encoding, Dictionary) else None
    table = _BASE_TABLES.get(_text(base)) if isinstance(base, Name) else None
    out = {}
    for code in range(256):
        if code in diffs:
            out[code] = {diffs[code]}
        elif table is not None:
            out[code] = set(table[code])
        else:
            out[code] = set()
    return out


# ── codespaces (ISO 32000-2 §9.7.5) ───────────────────────────────────────


class _Codespace:
    """How a font's show strings split into codes, and the CID of each: one
    byte per code for a simple font, two for Identity-H/V, or a CMap's code
    space (`pdf_fonts.CodeSpace`) for any other composite font."""

    def __init__(self, width: int = 0, space=None, cid=None):
        self.width = width
        self.space = space
        self._cid = cid

    def split(self, data: bytes) -> list:
        """Every code a reader can draw from `data`. Readers differ on where
        an invalid code ends (§9.7.6.3): a string holding one also yields the
        codes a reader that reads it as one byte finds."""
        if self.width == 1:
            return [data[i : i + 1] for i in range(len(data))]
        if self.width == 2:
            return [data[i : i + 2] for i in range(0, len(data) - 1, 2)]
        out = []
        pos = 0
        valid = True
        for _code, size, ok in self.space.split(data):
            out.append(data[pos : pos + size])
            pos += size
            valid = valid and ok
        if not valid:
            pos = 0
            while pos < len(data):
                size, ok = self.space.read(data, pos)
                size = size if ok else 1
                out.append(data[pos : pos + size])
                pos += size
        return out

    def cid(self, code: bytes) -> Optional[int]:
        if self.width == 2:
            return int.from_bytes(code, "big")
        if self.width == 1:
            return code[0] if code else None
        return self._cid(code)


def _codespace(font) -> Optional[_Codespace]:
    """The font's codespace, or None when this pass cannot read it."""
    if _subtype(font) != "/Type0":
        return _Codespace(width=1)
    encoding = font.get("/Encoding")
    if isinstance(encoding, Name):
        name = _text(encoding)[1:]
        if name in ("Identity-H", "Identity-V"):
            return _Codespace(width=2)
        try:
            from pdfminer.cmapdb import CMapDB

            trie = getattr(CMapDB.get_cmap(name), "code2cid", None)
        except Exception:
            return None
        if not trie:
            return None
        return _Codespace(space=pdf_fonts.trie_code_space(trie), cid=pdf_fonts._trie_cid(trie))
    if isinstance(encoding, Stream):
        cmap = pdf_fonts.embedded_cmap(encoding)
        return _Codespace(space=cmap.code_space, cid=cmap.cid) if cmap is not None else None
    return None


# ── where fonts can be drawn ──────────────────────────────────────────────


def _appearance_streams(annot) -> list:
    appearance = annot.get("/AP") if isinstance(annot, Dictionary) else None
    if not isinstance(appearance, Dictionary):
        return []
    out = []
    for state in _APPEARANCE_STATES:
        value = appearance.get(state)
        if isinstance(value, Stream):
            out.append(value)
        elif isinstance(value, Dictionary):
            out.extend(sub for sub in value.values() if isinstance(sub, Stream))
    return out


def _page_resources(page_obj):
    """(resources, key) of a page: its own, or its nearest ancestor's."""
    node = page_obj
    for _ in range(64):
        if not isinstance(node, Dictionary):
            break
        value = node.get("/Resources")
        if isinstance(value, Dictionary):
            return value, _owned_key(value, node, "/Resources")
        node = node.get("/Parent")
    return None, None


def _form_defaults(pdf):
    """(the /AcroForm dictionary, its /DR, the /DR's key)."""
    acroform = pdf.Root.get("/AcroForm")
    if not isinstance(acroform, Dictionary):
        return None, None, None
    dr = acroform.get("/DR")
    if not isinstance(dr, Dictionary):
        return acroform, None, None
    return acroform, dr, _owned_key(dr, acroform, "/DR")


def _fonts_in(resources, found: set, seen: set, depth: int) -> None:
    """Every font a resource dictionary can draw with, through its forms,
    tiling patterns, graphics states and Type 3 fonts."""
    if not isinstance(resources, Dictionary) or depth > MAX_SCAN_DEPTH:
        return
    marker = _key(resources)
    if marker is not None:
        if marker in seen:
            return
        seen.add(marker)

    def font(value):
        if not isinstance(value, Dictionary):
            return
        key = _key(value)
        if key is not None:
            found.add(key)
            if ("font", key) in seen:
                return
            seen.add(("font", key))
        if _subtype(value) == "/Type3":
            _fonts_in(value.get("/Resources"), found, seen, depth + 1)

    fonts = resources.get("/Font")
    if isinstance(fonts, Dictionary):
        for value in fonts.values():
            font(value)
    for category in ("/XObject", "/Pattern"):
        table = resources.get(category)
        if not isinstance(table, Dictionary):
            continue
        for value in table.values():
            if not isinstance(value, Stream):
                continue
            key = _key(value)
            if key is not None:
                if ("stream", key) in seen:
                    continue
                seen.add(("stream", key))
            _fonts_in(value.get("/Resources"), found, seen, depth + 1)
    states = resources.get("/ExtGState")
    if isinstance(states, Dictionary):
        for state in states.values():
            if not isinstance(state, Dictionary):
                continue
            chosen = state.get("/Font")
            if isinstance(chosen, Array) and len(chosen):
                font(chosen[0])
            mask = state.get("/SMask")
            group = mask.get("/G") if isinstance(mask, Dictionary) else None
            if isinstance(group, Stream):
                _fonts_in(group.get("/Resources"), found, seen, depth + 1)


def _indirect_fonts(pdf, reachable: set) -> bool:
    """Every font dictionary held DIRECTLY in a /Font table or in an ExtGState
    /Font entry becomes an indirect object in its place, so that each font has
    one identity from the scan before the page walk to the cut after it.
    Returns whether any did."""
    holders = []
    for obj in pdf.objects:
        if _key(obj) not in reachable or not isinstance(obj, (Dictionary, Stream)):
            continue
        for candidate in (obj, obj.get("/Resources"), obj.get("/DR")):
            if isinstance(candidate, Dictionary):
                holders.append(candidate)
    changed = False
    for resources in holders:
        fonts = resources.get("/Font")
        if isinstance(fonts, Dictionary):
            for key in list(fonts.keys()):
                name = _name(_key_text(key))
                value = fonts.get(name)
                if _is_font(value) and not value.is_indirect:
                    fonts[name] = pdf.make_indirect(value)
                    changed = True
        states = resources.get("/ExtGState")
        if isinstance(states, Dictionary):
            for state in states.values():
                chosen = state.get("/Font") if isinstance(state, Dictionary) else None
                if isinstance(chosen, Array) and len(chosen) and _is_font(chosen[0]):
                    if not chosen[0].is_indirect:
                        chosen[0] = pdf.make_indirect(chosen[0])
                        changed = True
    return changed


def _reachable_fonts(pdf, reachable: set) -> dict:
    return {
        _key(obj): obj for obj in pdf.objects if _key(obj) in reachable and _is_font(obj)
    }


def _groups(fonts: dict) -> dict:
    """Font key → the key standing for its group; fonts sharing a part share
    a group."""
    parent: dict = {}

    def find(item):
        root = item
        while parent[root] != root:
            root = parent[root]
        while parent[item] != root:
            parent[item], item = root, parent[item]
        return root

    for key, font in fonts.items():
        parent.setdefault(key, key)
        for part in _parts(font):
            parent.setdefault(part, part)
            a, b = find(key), find(part)
            if a != b:
                parent[a] = b
    return {key: find(key) for key in fonts}


def _in_reach(pdf, pages) -> set:
    """Every font the marked pages can draw with: their resources, their
    annotations' appearances, and the form's default resources."""
    found: set = set()
    seen: set = set()
    for page in pages:
        resources, _ = _page_resources(page.obj)
        _fonts_in(resources, found, seen, 0)
        annots = page.obj.get("/Annots")
        if isinstance(annots, Array):
            for annot in annots:
                for stream in _appearance_streams(annot):
                    _fonts_in(stream.get("/Resources"), found, seen, 0)
    _acroform, dr, _ = _form_defaults(pdf)
    _fonts_in(dr, found, seen, 0)
    return found


# ── what a document draws ─────────────────────────────────────────────────


def _segments(operands) -> list:
    """The strings a show operator can draw, each a whole number of codes.

    Readers disagree on a malformed operand list (a TJ string, a Tj array, an
    extra operand), so every string operand and every string in an array
    operand counts. A name or a number draws nothing, and `bytes()` of a name
    is its spelling, not codes. The parser hands numbers over as Python
    numbers, never as pikepdf objects."""
    out = []
    for operand in operands:
        if type(operand) is not pikepdf.Object:
            continue
        kind = operand._type_code
        if kind == _STRING:
            out.append(bytes(operand))
        elif kind == _ARRAY:
            for index in range(len(operand)):
                item = operand[index]
                if type(item) is pikepdf.Object and item._type_code == _STRING:
                    out.append(bytes(item))
    return out


def _content_key(obj) -> Optional[tuple]:
    """What a content stream, or a page's /Contents, holds: each stream's
    object number and a digest of its raw bytes and filters. A stream written
    over in place gets a new key; a direct stream gets none."""
    contents = obj if isinstance(obj, Stream) else obj.get("/Contents")
    if isinstance(contents, Stream):
        streams = [contents]
    elif isinstance(contents, Array):
        streams = list(contents)
    else:
        return None
    parts = []
    try:
        for stream in streams:
            if not isinstance(stream, Stream) or not stream.is_indirect:
                return None
            digest = hashlib.blake2b(bytes(stream.read_raw_bytes()), digest_size=16)
            for slot in ("/Filter", "/DecodeParms"):
                value = stream.get(slot)
                digest.update(value.unparse(resolved=True) if value is not None else b"-")
            parts.append((tuple(stream.objgen), digest.digest()))
    except Exception:
        return None
    return tuple(parts)


_OTHER, _PUSH, _POP, _TF, _SHOW, _GS, _DO, _SCN = range(8)
_OPCODES = {"q": _PUSH, "Q": _POP, "Tf": _TF, "gs": _GS, "Do": _DO, "scn": _SCN, "SCN": _SCN}
for _op in _SHOW_OPERATORS:
    _OPCODES[_op] = _SHOW


def _compact(instructions, names: dict) -> tuple:
    """The operators the scan reads, as `(opcodes, operands)`: one byte per
    operator, and beside it the name a `Tf`, `gs`, `Do` or pattern selection
    names (one object per spelling, shared through `names`), the strings a
    show operator draws, or None."""
    codes = bytearray()
    values: list = []
    for instruction in instructions:
        code = _OPCODES.get(str(instruction.operator), _OTHER)
        codes.append(code)
        if code == _SHOW:
            segments = _segments(instruction.operands)
            values.append(segments[0] if len(segments) == 1 else tuple(segments))
        elif code == _TF or code == _GS or code == _DO or code == _SCN:
            operands = instruction.operands
            name = operands[-1 if code == _SCN else 0] if len(operands) else None
            if isinstance(name, Name):
                name = names.setdefault(bytes(name), name)
            else:
                name = None
            values.append(name)
        else:
            values.append(None)
    return bytes(codes), values


class _Face:
    """A font as the scan tracks it through the graphics state."""

    __slots__ = ("font", "key", "type3")

    def __init__(self, font):
        self.font = font
        self.key = _key(font)
        self.type3 = _subtype(font) == "/Type3"


def _strings(values) -> list:
    out = []
    for value in values:
        if isinstance(value, pikepdf.String):
            try:
                out.append(str(value))
            except UnicodeDecodeError:
                # A text string marked as UTF-8 (§7.9.2.2) need not hold UTF-8
                # after its mark; the characters it does spell still draw.
                data = bytes(value)
                if data.startswith(b"\xef\xbb\xbf"):
                    data = data[3:]
                out.append(data.decode("utf-8", "replace"))
        elif isinstance(value, Array):
            out.extend(_strings(list(value)))
    return out


class _Scan:
    """The codes a document draws with each font in `scope`.

    A stream is walked once for each resource dictionary it reads, font it
    inherits and dictionary it falls back to for a name its own resources
    lack — and once for all of them when it neither draws with an inherited
    font nor falls back."""

    def __init__(self, pdf, scope: set, label: str, contents: Optional[dict] = None):
        self.pdf = pdf
        self.scope = scope
        self.label = label
        # `_content_key` to `_compact` of that content: the scan after the
        # page walk reads every stream the walk left alone from the scan
        # before it, not from a second parse, up to `MAX_KEPT_OPERATORS`.
        self.contents: dict = contents if contents is not None else {}
        self.kept = sum(len(codes) for codes, _values in self.contents.values())
        self.names: dict = {}
        self.codes: dict = {}
        self.raw: dict = {}
        self.spaces: dict = {}
        self.capabilities: dict = {}
        self.memo: dict = {}
        self.walked: set = set()
        self.mentioned: dict = {}
        self.type3_tables: dict = {}
        self.type3_done: dict = {}
        self.faces: dict = {}
        self.named: dict = {}
        self.ops_left = MAX_SCAN_OPERATORS
        _acroform, self.dr, self.dr_key = _form_defaults(pdf)

    def run(self, reachable: set) -> "_Scan":
        for page in self.pdf.pages:
            self._page(page.obj)
        self._fields()
        self._sweep(reachable)
        return self

    def _refuse(self, reason: str):
        image_redact.refuse(reason, font=self.label)

    # — records —

    def _face(self, font) -> Optional[_Face]:
        if not isinstance(font, Dictionary):
            return None
        key = _key(font)
        if key is None:
            return _Face(font)
        face = self.faces.get(key)
        if face is None:
            face = self.faces[key] = _Face(font)
        return face

    def _font(self, name, res, res_key, fallback, fallback_key, ctx) -> Optional[_Face]:
        """The face `Tf name` selects, looked up once per resource scope."""
        spelled = _text(name) if isinstance(name, Name) else None
        memo = (res_key, fallback_key, spelled) if res_key is not None else None
        if memo is not None and memo in self.named:
            face, fell_back = self.named[memo]
        else:
            local = {"fallback": False}
            face = self._face(self._lookup("/Font", name, res, fallback, local))
            fell_back = local["fallback"]
            if memo is not None:
                self.named[memo] = (face, fell_back)
        if fell_back:
            ctx["fallback"] = True
        return face

    def _record(self, key, font, segments: list) -> None:
        if key not in self.scope:
            return
        if key not in self.spaces:
            self.spaces[key] = _codespace(font)
        space = self.spaces[key]
        if space is None:
            self.raw.setdefault(key, set()).update(segments)
            return
        codes = self.codes.setdefault(key, set())
        for segment in segments:
            codes.update(space.split(segment))

    def _mentions(self, resources, key) -> bool:
        """Can this resource dictionary draw with a font in scope?"""
        if not isinstance(resources, Dictionary):
            return False
        if key is not None and key in self.mentioned:
            return self.mentioned[key]
        found: set = set()
        _fonts_in(resources, found, set(), 0)
        answer = bool(found & self.scope)
        if key is not None:
            self.mentioned[key] = answer
        return answer

    # — streams —

    def _lookup(self, category, name, res, fallback, ctx):
        if not isinstance(name, Name):
            return None
        table = res.get(category) if isinstance(res, Dictionary) else None
        found = table.get(name) if isinstance(table, Dictionary) else None
        if found is not None:
            return found
        ctx["fallback"] = True
        table = fallback.get(category) if isinstance(fallback, Dictionary) else None
        return table.get(name) if isinstance(table, Dictionary) else None

    def walk(self, stream, res, res_key, fallback, fallback_key, inherited, depth) -> bool:
        """Walk one content stream; True when it drew with the face it inherits."""
        stream_key = _key(stream)
        memo_key = (stream_key, res_key)
        inherited_key = inherited.key if inherited is not None else None
        for entry in self.memo.get(memo_key, ()):
            if (entry[0] is _ANY or entry[0] == inherited_key) and (
                entry[1] is _ANY or entry[1] == fallback_key
            ):
                return entry[2]
        if depth > MAX_SCAN_DEPTH:
            self._refuse("its text is nested deeper than this check follows")
        entry = [inherited_key, fallback_key, False]
        self.memo.setdefault(memo_key, []).append(entry)
        if stream_key is not None:
            self.walked.add(stream_key)
        try:
            instructions = self._instructions(stream)
        except Exception:
            if (
                inherited_key in self.scope
                or self._mentions(res, res_key)
                or self._mentions(fallback, fallback_key)
            ):
                self._refuse("content that cannot be read may draw with it")
            return False
        ctx = {"fallback": False, "inherited": False}
        self._interpret(instructions, res, res_key, fallback, fallback_key, inherited, depth, ctx)
        entry[0] = inherited_key if ctx["inherited"] else _ANY
        entry[1] = fallback_key if ctx["fallback"] else _ANY
        entry[2] = ctx["inherited"]
        return ctx["inherited"]

    def _instructions(self, stream) -> tuple:
        key = _content_key(stream)
        found = self.contents.get(key) if key is not None else None
        if found is None:
            found = _compact(pikepdf.parse_content_stream(stream, _SCANNED_OPERATORS), self.names)
            if key is not None and self.kept + len(found[0]) <= MAX_KEPT_OPERATORS:
                self.contents[key] = found
                self.kept += len(found[0])
        return found

    def _interpret(self, instructions, res, res_key, fallback, fallback_key, inherited, depth, ctx):
        font = inherited
        own = False
        stack = []
        scope = self.scope
        codes, values = instructions
        self.ops_left -= len(codes)
        if self.ops_left < 0:
            self._refuse(
                f"the document holds more than {MAX_SCAN_OPERATORS} content operators to check"
            )
        for op, value in zip(codes, values):
            if op == _OTHER:
                continue
            if op == _PUSH:
                stack.append((font, own))
                continue
            if op == _POP:
                if stack:
                    font, own = stack.pop()
                continue
            if op == _TF:
                font = self._font(value, res, res_key, fallback, fallback_key, ctx)
                own = True
            elif op == _SHOW:
                if not own:
                    ctx["inherited"] = True
                if font is not None and (font.type3 or font.key in scope):
                    self._show(font, value if type(value) is tuple else (value,), res, res_key, depth)
            elif op == _GS:
                state = self._lookup("/ExtGState", value, res, fallback, ctx)
                if not isinstance(state, Dictionary):
                    continue
                chosen = state.get("/Font")
                if isinstance(chosen, Array) and len(chosen) and isinstance(chosen[0], Dictionary):
                    font = self._face(chosen[0])
                    own = True
                mask = state.get("/SMask")
                group = mask.get("/G") if isinstance(mask, Dictionary) else None
                if isinstance(group, Stream) and self._invoke(group, res, res_key, font, depth):
                    if not own:
                        ctx["inherited"] = True
            elif op == _DO:
                xobject = self._lookup("/XObject", value, res, fallback, ctx)
                if isinstance(xobject, Stream) and _subtype(xobject) == "/Form":
                    if self._invoke(xobject, res, res_key, font, depth) and not own:
                        ctx["inherited"] = True
            elif op == _SCN and value is not None:
                # A pattern cell starts in the state in effect at the start of
                # the stream that owns it (ISO 32000-2 §8.7.3.1 b), so it
                # draws with this stream's inherited face, not the current one.
                pattern = self._lookup("/Pattern", value, res, fallback, ctx)
                if isinstance(pattern, Stream) and self._invoke(pattern, res, res_key, inherited, depth):
                    ctx["inherited"] = True

    def _invoke(self, stream, res, res_key, font, depth) -> bool:
        own = stream.get("/Resources")
        if isinstance(own, Dictionary):
            child, child_key = own, _owned_key(own, stream, "/Resources")
        else:
            child, child_key = res, res_key
        return self.walk(stream, child, child_key, res, res_key, font, depth + 1)

    def _show(self, face, segments, res, res_key, depth) -> None:
        self._record(face.key, face.font, segments)
        if not face.type3:
            return
        font = face.font
        procs = font.get("/CharProcs")
        if not isinstance(procs, Dictionary):
            return
        own = font.get("/Resources")
        if isinstance(own, Dictionary):
            proc_res, proc_key = own, _owned_key(own, font, "/Resources")
        else:
            proc_res, proc_key = res, res_key
        if not self._mentions(proc_res, proc_key):
            return
        done = self.type3_done.setdefault((face.key, proc_key, res_key), set())
        codes = set().union(*segments) - done if segments else set()
        if not codes:
            return
        done |= codes
        table = self.type3_tables.get(face.key)
        if table is None:
            table = self.type3_tables[face.key] = _type3_table(font)
        names: set = set()
        for code in codes:
            names |= table[code]
        for name in sorted(names):
            proc = procs.get(_name("/" + name))
            if isinstance(proc, Stream):
                self.walk(proc, proc_res, proc_key, res, res_key, face, depth + 1)

    # — the document —

    def _page(self, page_obj) -> None:
        res, res_key = _page_resources(page_obj)
        # A page reaches a font only through its resources: one whose
        # resources name no font in scope draws none, and is not read.
        if page_obj.get("/Contents") is not None and self._mentions(res, res_key):
            self.walk(page_obj, res, res_key, None, None, None, 0)
        annots = page_obj.get("/Annots")
        if isinstance(annots, Array):
            for annot in annots:
                self._annotation(annot)

    def _annotation(self, annot) -> None:
        if not isinstance(annot, Dictionary):
            return
        for stream in _appearance_streams(annot):
            own = stream.get("/Resources")
            if isinstance(own, Dictionary):
                res, res_key = own, _owned_key(own, stream, "/Resources")
            else:
                res, res_key = self.dr, self.dr_key
            self.walk(stream, res, res_key, self.dr, self.dr_key, None, 1)
        if annot.get("/Subtype") == Name("/FreeText"):
            self._drawn_from(annot.get("/DA"), [annot.get("/Contents")])

    def _drawn_from(self, da, values) -> None:
        """Strings a reader draws with the font of a default appearance string
        whenever it rebuilds a field or a free-text annotation."""
        if self.dr is None or not isinstance(da, pikepdf.String):
            return
        match = re.search(rb"/([^\s/\[\]()<>{}%]+)\s+[-+.\d]+\s+Tf", bytes(da))
        fonts = self.dr.get("/Font")
        if match is None or not isinstance(fonts, Dictionary):
            return
        font = fonts.get(_name("/" + match.group(1).decode("latin-1")))
        key = _key(font)
        if not isinstance(font, Dictionary) or key not in self.scope:
            return
        if key not in self.capabilities:
            try:
                self.capabilities[key] = pdf_fonts.font_capability(font)
            except Exception:
                self.capabilities[key] = None
        capability = self.capabilities[key]
        if capability is None:
            return
        segments = []
        for text in _strings(values):
            for ch in text:
                try:
                    segments.append(capability.encode(ch))
                except ValueError:
                    continue
        self._record(key, font, segments)

    def _fields(self) -> None:
        acroform, _dr, _ = _form_defaults(self.pdf)
        fields = acroform.get("/Fields") if acroform is not None else None
        if not isinstance(fields, Array):
            return
        stack = [(field, acroform.get("/DA"), 0) for field in fields]
        seen: set = set()
        while stack:
            node, da, depth = stack.pop()
            if not isinstance(node, Dictionary) or depth > MAX_SCAN_DEPTH:
                continue
            key = _key(node)
            if key is not None:
                if key in seen:
                    continue
                seen.add(key)
            da = node.get("/DA", da)
            values = [node.get(slot) for slot in _FIELD_STRINGS]
            captions = node.get("/MK")
            if isinstance(captions, Dictionary):
                values += [captions.get(slot) for slot in _CAPTIONS]
            self._drawn_from(da, values)
            kids = node.get("/Kids")
            if isinstance(kids, Array):
                stack.extend((kid, da, depth + 1) for kid in kids)

    def _sweep(self, reachable: set) -> None:
        """Content the file keeps that no page draws: forms and tiling patterns
        nothing invokes, pages outside the page tree, annotations on no page."""
        tree = {_key(page.obj) for page in self.pdf.pages}
        for obj in self.pdf.objects:
            key = _key(obj)
            if key is None or key not in reachable or key in self.walked:
                continue
            if isinstance(obj, Stream):
                drawable = _subtype(obj) == "/Form" or obj.get("/PatternType") == 1
                own = obj.get("/Resources")
                if drawable and isinstance(own, Dictionary):
                    own_key = _owned_key(own, obj, "/Resources")
                    if self._mentions(own, own_key):
                        self.walk(obj, own, own_key, None, None, None, 1)
            elif isinstance(obj, Dictionary):
                kind = obj.get("/Type")
                if kind in (Name("/Page"), Name("/Template")):
                    if key not in tree:
                        self._page(obj)
                elif "/AP" in obj or obj.get("/Subtype") == Name("/FreeText"):
                    self._annotation(obj)


# ── the before and after ──────────────────────────────────────────────────


class FontBaseline:
    """The codes the document drew with every font in reach of the marks,
    taken before the page walk changed anything, and the content it read."""

    def __init__(self, scope: set, label: str, codes: dict, raw: dict, contents: dict):
        self.scope = scope
        self.label = label
        self.codes = codes
        self.raw = raw
        self.contents = contents


def baseline(pdf, pages) -> Optional[FontBaseline]:
    """The scan before the page walk; None when nothing in reach draws text."""
    reachable = redact_document.reachable_from_trailer(pdf)
    if _indirect_fonts(pdf, reachable):
        reachable = redact_document.reachable_from_trailer(pdf)
    fonts = _reachable_fonts(pdf, reachable)
    seeds = _in_reach(pdf, pages) & set(fonts)
    if not seeds:
        return None
    groups = _groups(fonts)
    roots = {groups[key] for key in seeds}
    scope = {key for key, root in groups.items() if root in roots}
    label = sorted(_label(fonts[key]) for key in scope)[0]
    scan = _Scan(pdf, scope, label).run(reachable)
    return FontBaseline(scope, label, scan.codes, scan.raw, scan.contents)


def prune(pdf, before: Optional[FontBaseline]) -> None:
    """The scan after the page walk, then the cut of every program and table a
    font whose use shrank draws with."""
    if before is None:
        return
    reachable = redact_document.reachable_from_trailer(pdf)
    after = _Scan(pdf, before.scope, before.label, before.contents).run(reachable)
    fonts = {}
    for key in before.scope:
        try:
            fonts[key] = pdf.get_object(key)
        except Exception:
            continue
    touched = set()
    for key, font in fonts.items():
        if after.codes.get(key, set()) != before.codes.get(key, set()):
            touched.add(key)
        if after.raw.get(key, set()) != before.raw.get(key, set()):
            touched.add(key)
            if key in reachable:
                _refuse(font, "its character map cannot be read")
    if not touched:
        return
    groups = _groups(fonts)
    roots = {groups[key] for key in touched}
    live = {
        key: font
        for key, font in fonts.items()
        if groups[key] in roots and key in reachable
    }
    _Cut(pdf, live, after.codes, reachable, touched).run()


# ── the cut ───────────────────────────────────────────────────────────────


class _Cut:
    """Cut every program and table of `fonts` that a font in `touched` uses to
    the codes in `codes`, the union of its users' where it is shared."""

    def __init__(self, pdf, fonts: dict, codes: dict, reachable: set, touched: set):
        self.pdf = pdf
        self.fonts = fonts
        self.codes = codes
        self.reachable = reachable
        self.touched = touched
        self.remaps: dict = {}
        self.glyph_counts: dict = {}
        self.kept_names: dict = {}
        self.spaces: dict = {}

    def surviving(self, font) -> set:
        return self.codes.get(_key(font), set())

    def simple_codes(self, font) -> set:
        return {code[0] for code in self.surviving(font) if len(code) == 1}

    def cids(self, font) -> set:
        key = _key(font)
        if key not in self.spaces:
            self.spaces[key] = _codespace(font)
        space = self.spaces[key]
        if space is None:
            _refuse(font, "its character map cannot be read")
        out = set()
        for code in self.surviving(font):
            cid = space.cid(code)
            if cid is not None:
                out.add(cid)
        return out

    def cid_to_gid(self, font):
        kid = _descendant(font)
        value = kid.get("/CIDToGIDMap") if kid is not None else None
        if not isinstance(value, Stream):
            return lambda cid: cid
        table = _read(value, 2 * 65536 + 2)
        if table is None:
            _refuse(font, "its CIDToGIDMap cannot be read")

        def lookup(cid):
            if 2 * cid + 1 >= len(table):
                return 0
            return (table[2 * cid] << 8) | table[2 * cid + 1]

        return lookup

    def touches(self, users) -> bool:
        """Does any of `users` draw less than it did? Only then does a program
        or a table they share change."""
        return any(_key(user) in self.touched for user in users)

    def run(self) -> None:
        programs: dict = {}
        for font in self.fonts.values():
            slot, stream = _program_of(_descriptor(font))
            if stream is None or _key(stream) not in self.reachable:
                continue
            programs.setdefault(_key(stream), (slot, stream, []))[2].append(font)
        for program_key, (slot, stream, users) in programs.items():
            if self.touches(users):
                try:
                    with pdf_fonts._CharStringWork().guard():
                        self._program(program_key, slot, stream, users)
                except pdf_fonts._CharStringBudget:
                    _refuse(users[0], "its font program cannot be cut")
        self._widths()
        self._encodings()
        self._type3()
        self._cid_metrics()
        self._cid_maps()
        self._embedded_cmaps()
        self._tounicode()
        self._descriptors()

    # — programs —

    def _program(self, program_key, slot, stream, users) -> None:
        font = users[0]
        try:
            data = _read(stream, MAX_FONT_PROGRAM_BYTES, strict=True)
        except _Oversize:
            _refuse(font, f"its font program is larger than {MAX_FONT_PROGRAM_BYTES} bytes")
        if data is None:
            _refuse(font, "its font program cannot be read")
        if slot == "/FontFile":
            self._type1(program_key, stream, data, users)
        elif data[:4] == b"ttcf":
            _refuse(font, "its font program is a font collection")
        elif data[:4] in _SFNT_TAGS:
            self._sfnt(program_key, slot, stream, data, users)
        elif slot == "/FontFile3" and data[:1] == b"\x01":
            self._bare_cff(program_key, stream, data, users)
        else:
            _refuse(font, "its font program is in a form this redaction cannot cut")

    def _sfnt(self, program_key, slot, stream, data, users) -> None:
        from fontTools.ttLib import TTFont

        font = users[0]
        try:
            tt = TTFont(io.BytesIO(data), lazy=True, recalcTimestamp=False, recalcBBoxes=False)
            cmaps, reverse, count = _sfnt_tables(tt)
            top = tt["CFF "].cff.topDictIndex[0] if "CFF " in tt else None
            # A Top DICT decompiles on first access, so a damaged one fails here.
            cid_keyed = top is not None and hasattr(top, "ROS")
            builtin = _cff_builtin(top) if top is not None and not cid_keyed else None
        except Exception:
            _refuse(font, "its font program cannot be read")
        kept = {0}
        retain = False
        simple: list = []
        for user in users:
            if _subtype(user) == "/Type0":
                cids = self.cids(user)
                if top is None:
                    lookup = self.cid_to_gid(user)
                    kept |= {lookup(cid) for cid in cids}
                elif cid_keyed:
                    kept |= {reverse[n] for n in (f"cid{c:05d}" for c in cids) if n in reverse}
                else:
                    retain = True
                    kept |= cids
                continue
            if not cmaps and top is None:
                retain = True
            paths = _sfnt_simple_paths(user, self.simple_codes(user), cmaps, reverse, count, builtin)
            simple.append((user, paths))
            kept |= {gid for found in paths.values() for gid in found.values()}
        kept = {gid for gid in kept if 0 <= gid < count}
        if len(kept) == count:
            self.kept_names[program_key] = list(reverse)
            return
        new_data, remap, names = _subset_sfnt(font, data, kept, retain)
        _verify_sfnt_paths(font, new_data, simple, remap)
        self.remaps[program_key] = remap
        self.glyph_counts[program_key] = count
        self.kept_names[program_key] = names
        _write_program(stream, slot, new_data)

    def _bare_cff(self, program_key, stream, data, users) -> None:
        font = users[0]
        try:
            top = _cff_font(data)["CFF "].cff.topDictIndex[0]
            order = list(top.charset)
            cid_keyed = hasattr(top, "ROS")
            builtin = None if cid_keyed else _cff_builtin(top)
        except Exception:
            _refuse(font, "its font program cannot be read")
        reverse = {name: gid for gid, name in enumerate(order)}
        kept = {0}
        retain = False
        simple: list = []
        for user in users:
            if _subtype(user) == "/Type0":
                cids = self.cids(user)
                if cid_keyed:
                    kept |= {reverse[n] for n in (f"cid{c:05d}" for c in cids) if n in reverse}
                else:
                    retain = True
                    kept |= cids
                continue
            paths = self.name_paths(user, builtin)
            simple.append((user, paths))
            kept |= {reverse[n] for found in paths.values() for n in found if n in reverse}
        kept = {gid for gid in kept if 0 <= gid < len(order)}
        if len(kept) == len(order):
            self.kept_names[program_key] = order
            return
        new_data, remap, names = _subset_bare_cff(font, data, kept, retain)
        try:
            new_top = _cff_font(new_data)["CFF "].cff.topDictIndex[0]
            new_names = set(new_top.charset)
            new_builtin = _cff_builtin(new_top)
        except Exception:
            _refuse(font, "its cut font program could not be verified")
        for user, paths in simple:
            for code, found in self.name_paths(user, new_builtin).items():
                if {n for n in found if n in new_names} != {n for n in paths[code] if n in reverse}:
                    _refuse(font, "its cut font program could not be verified")
        self.remaps[program_key] = remap
        self.kept_names[program_key] = names
        _write_program(stream, "/FontFile3", new_data)

    def name_paths(self, font, builtin) -> dict:
        """code → the glyph names a reader can take it to, for a program that
        selects glyphs by name (§9.6.5.2)."""
        out: dict = {}
        try:
            for code in self.simple_codes(font):
                out[code] = _code_names(font, code, builtin, False)
        except _Unmapped:
            _refuse(font, "its encoding cannot be read")
        return out

    def _type1(self, program_key, stream, data, users) -> None:
        font = users[0]
        program = _Type1(font, data)
        wanted = {".notdef"}
        paths = [(user, self.name_paths(user, program.builtin)) for user in users]
        for _user, found in paths:
            wanted |= {name for names in found.values() for name in names}
        kept = program.closure(wanted & set(program.glyphs))
        if kept >= set(program.glyphs):
            self.kept_names[program_key] = list(program.glyphs)
            return
        clear, cipher, trailer = program.cut(kept)
        new_data = clear + cipher + trailer
        builtin = _type1_builtin(clear)
        for user, found in paths:
            for code, names in self.name_paths(user, builtin).items():
                if names & kept != found[code] & kept:
                    _refuse(font, "its cut font program could not be verified")
        _verify_type1(font, data, new_data, kept)
        stream.write(new_data)
        stream["/Length1"] = len(clear)
        stream["/Length2"] = len(cipher)
        stream["/Length3"] = len(trailer)
        self.kept_names[program_key] = [name for name in program.glyphs if name in kept]

    # — simple-font tables —

    def _widths(self) -> None:
        """/Widths runs from the lowest code the survivors draw to the highest,
        each drawn code's width as it was and every other code's 0, and
        /FirstChar and /LastChar bound that range. An array fonts share is cut
        to the union of their codes, each font's range moving with it. With
        no drawn code inside the range, one entry of width 0 remains, at the
        lowest code no survivor draws."""
        arrays: dict = {}
        for font in self.fonts.values():
            array = font.get("/Widths")
            if _subtype(font) == "/Type0" or not isinstance(array, Array):
                continue
            try:
                first = int(font.get("/FirstChar", 0))
            except (TypeError, ValueError):
                first = 0
            entry = arrays.setdefault(
                _owned_key(array, font, "/Widths"), [array, set(), [], set()]
            )
            codes = self.simple_codes(font)
            entry[1] |= {code - first for code in codes}
            entry[2].append((font, first))
            entry[3] |= codes
        for array, indices, users, drawn in arrays.values():
            if not self.touches([font for font, _first in users]):
                continue
            values = list(array)
            inside = sorted(index for index in indices if 0 <= index < len(values))
            if inside:
                low = inside[0]
                kept = [values[i] if i in indices else 0 for i in range(low, inside[-1] + 1)]
                spans = [(first + low, first + low + len(kept) - 1) for _font, first in users]
            else:
                free = 0
                while free in drawn:
                    free += 1
                kept = [0]
                spans = [(free, free) for _user in users]
            new = Array(kept)
            if array.is_indirect:
                new = self.pdf.make_indirect(new)
            for (font, _first), (first_char, last_char) in zip(users, spans):
                font["/Widths"] = new
                font["/FirstChar"] = first_char
                font["/LastChar"] = last_char

    def _encodings(self) -> None:
        encodings: dict = {}
        for font in self.fonts.values():
            encoding = font.get("/Encoding")
            if _subtype(font) == "/Type0" or not isinstance(encoding, Dictionary):
                continue
            if not isinstance(encoding.get("/Differences"), Array):
                continue
            entry = encodings.setdefault(_owned_key(encoding, font, "/Encoding"), [encoding, set(), []])
            entry[1] |= self.simple_codes(font)
            entry[2].append(font)
        for encoding, codes, users in encodings.values():
            if not self.touches(users):
                continue
            pairs = _differences(encoding)
            kept = [(code, name) for code, name in pairs if code in codes]
            if len(kept) == len(pairs):
                continue
            spelled = {_text(item): item for item in encoding["/Differences"] if isinstance(item, Name)}
            rebuilt: list = []
            previous = None
            for code, name in kept:
                if previous is None or code != previous + 1:
                    rebuilt.append(code)
                rebuilt.append(spelled["/" + name])
                previous = code
            encoding["/Differences"] = Array(rebuilt)

    def _type3(self) -> None:
        tables: dict = {}
        for font in self.fonts.values():
            procs = font.get("/CharProcs")
            if _subtype(font) != "/Type3" or not isinstance(procs, Dictionary):
                continue
            names: set = set()
            try:
                for code in self.simple_codes(font):
                    names |= _type3_names(font, code)
            except _Unmapped:
                _refuse(font, "its encoding cannot be read")
            entry = tables.setdefault(_owned_key(procs, font, "/CharProcs"), [procs, set(), []])
            entry[1] |= names
            entry[2].append(font)
        for procs, names, owners in tables.values():
            if not self.touches(owners):
                continue
            for spelled in [_key_text(k) for k in procs.keys()]:
                if spelled[1:] not in names:
                    del procs[_name(spelled)]
            for font in owners:
                _prune_type3_resources(font)

    # — composite tables —

    def _kids(self) -> dict:
        """Descendant key → [descendant, the union of its users' CIDs, its users]."""
        kids: dict = {}
        for font in self.fonts.values():
            kid = _descendant(font)
            if kid is None:
                continue
            entry = kids.setdefault(_owned_key(kid, font, "/DescendantFonts"), [kid, set(), []])
            entry[1] |= self.cids(font)
            entry[2].append(font)
        return kids

    def _cid_metrics(self) -> None:
        kids = self._kids()
        for slot, group in (("/W", 1), ("/W2", 3)):
            arrays: dict = {}
            for kid, cids, users in kids.values():
                array = kid.get(slot)
                if isinstance(array, Array):
                    entry = arrays.setdefault(_owned_key(array, kid, slot), [array, set(), [], []])
                    entry[1] |= cids
                    entry[2].append(kid)
                    entry[3].extend(users)
            for array, cids, owners, users in arrays.values():
                if not self.touches(users):
                    continue
                rebuilt = _filter_cid_metrics(list(array), cids, group)
                if rebuilt is None:
                    continue
                for kid in owners:
                    kid[slot] = Array(rebuilt)

    def _cid_maps(self) -> None:
        """/CIDToGIDMap for every TrueType CIDFont whose program was cut or
        whose own use shrank. A CIDFont over a program another font's cut
        compacted is remapped whatever its own use: its glyph ids moved. A
        touched one maps its survivors' CIDs only; an untouched one keeps every
        CID whose glyph is still in the program."""
        for kid, cids, users in self._kids().values():
            _slot, program = _program_of(_descriptor(users[0]))
            value = kid.get("/CIDToGIDMap")
            glyf = _subtype(kid) == "/CIDFontType2"
            remap = self.remaps.get(_key(program)) if glyf and program is not None else None
            touched = self.touches(users)
            if not touched and remap is None:
                continue
            if isinstance(value, Stream):
                lookup = self.cid_to_gid(users[0])
                domain = range(len(_read(value, 2 * 65536 + 2) or b"") // 2)
            elif glyf and remap is not None:
                lookup = int
                domain = range(self.glyph_counts.get(_key(program), 0))
            else:
                continue
            for cid in cids:
                if remap is not None and lookup(cid) not in remap:
                    _refuse(users[0], "its cut font program could not be verified")
            if touched:
                present = cids | {0}
            else:
                present = {cid for cid in domain if remap.get(lookup(cid)) is not None} | {0}
            out = bytearray(2 * (max(present) + 1))
            for cid in present:
                gid = lookup(cid)
                if remap is not None:
                    gid = remap.get(gid, 0)
                out[2 * cid] = (gid >> 8) & 0xFF
                out[2 * cid + 1] = gid & 0xFF
            if isinstance(value, Stream) and _read(value, 2 * 65536 + 2) == bytes(out):
                continue
            kid["/CIDToGIDMap"] = self.pdf.make_stream(bytes(out))

    def _embedded_cmaps(self) -> None:
        maps: dict = {}
        for font in self.fonts.values():
            encoding = font.get("/Encoding")
            if _subtype(font) == "/Type0" and isinstance(encoding, Stream):
                entry = maps.setdefault(_key(encoding), [encoding, set(), []])
                entry[1] |= self.surviving(font)
                entry[2].append(font)
        for stream, codes, users in maps.values():
            if self.touches(users):
                _rewrite_embedded_cmap(users[0], stream, codes)

    # — every font —

    def _tounicode(self) -> None:
        maps: dict = {}
        for font in self.fonts.values():
            stream = font.get("/ToUnicode")
            if isinstance(stream, Stream):
                entry = maps.setdefault(_key(stream), [stream, set(), []])
                entry[1] |= self.surviving(font)
                entry[2].append(font)
        for stream, codes, users in maps.values():
            if self.touches(users):
                _rewrite_tounicode(users[0], stream, codes)

    def _descriptors(self) -> None:
        descriptors: dict = {}
        for font in self.fonts.values():
            desc = _descriptor(font)
            if desc is None:
                continue
            key = _owned_key(desc, font, "/FontDescriptor")
            entry = descriptors.setdefault(key, [desc, set(), False, []])
            entry[3].append(font)
            if _subtype(font) == "/Type0":
                entry[1] |= self.cids(font)
                entry[2] = True
        for desc, cids, composite, users in descriptors.values():
            if not self.touches(users):
                continue
            _slot, program = _program_of(desc)
            names = self.kept_names.get(_key(program)) if program is not None else None
            charset = desc.get("/CharSet")
            if names is not None and isinstance(charset, pikepdf.String):
                listed = re.findall(rb"/([^\s/]+)", bytes(charset))
                keep = set(names)
                filtered = [n for n in listed if n.decode("latin-1") in keep]
                if len(filtered) != len(listed):
                    desc["/CharSet"] = pikepdf.String(b"".join(b"/" + n for n in filtered))
            cid_set = desc.get("/CIDSet")
            if composite and isinstance(cid_set, Stream):
                present = cids | {0}
                bits = bytearray((max(present) >> 3) + 1)
                for cid in present:
                    bits[cid >> 3] |= 0x80 >> (cid & 7)
                if _read(cid_set, 65536) != bytes(bits):
                    desc["/CIDSet"] = self.pdf.make_stream(bytes(bits))


# ── sfnt and CFF programs ─────────────────────────────────────────────────


def _cff_builtin(top) -> Optional[list]:
    encoding = getattr(top, "Encoding", None)
    if isinstance(encoding, str):
        return list(_STANDARD_BUILTIN_NAMES) if encoding == "StandardEncoding" else None
    return list(encoding) if encoding else None


def _sfnt_code_paths(font, code: int, cmaps: dict, reverse: dict, count: int, builtin, tounicode) -> dict:
    """Every way a reader can take code `code` of a simple font to a glyph of
    an sfnt program (§9.6.5.4), as path → glyph id: by glyph name through each
    Unicode subtable, through the (1, 0) subtable and through the names
    themselves; through the (3, 0) subtable at each of its four code ranges;
    through the (1, 0) and Unicode subtables at the code itself and at its
    /ToUnicode value; and, where the program has no cmap at all, at the glyph
    id equal to the code."""
    out: dict = {}

    def add(path, name):
        gid = reverse.get(name) if name is not None else None
        if gid is not None:
            out[path] = gid

    try:
        names = _code_names(font, code, builtin, True)
    except _Unmapped:
        _refuse(font, "its encoding cannot be read")
    for name in names:
        for candidate in (name, _recovered(name)):
            if candidate is None:
                continue
            add(("name", candidate), candidate)
            point = _agl_codepoint(candidate)
            for (platform, encoding), table in cmaps.items():
                if point is not None and (platform == 0 or (platform, encoding) in ((3, 1), (3, 10))):
                    add(("unicode", platform, encoding, candidate), table.get(point))
            roman = _MAC_OS_ROMAN.get(candidate)
            if roman is not None and (1, 0) in cmaps:
                add(("roman", candidate), cmaps[(1, 0)].get(roman))
    for (platform, encoding), table in cmaps.items():
        if (platform, encoding) == (3, 0):
            for high in (0x0000, 0xF000, 0xF100, 0xF200):
                add(("symbol", high), table.get(high | code))
        elif (platform, encoding) == (1, 0) or platform == 0 or (platform, encoding) in ((3, 1), (3, 10)):
            add(("code", platform, encoding), table.get(code))
            text = tounicode.get(code)
            if text and len(text) == 1:
                add(("tounicode", platform, encoding), table.get(ord(text)))
    if not cmaps and code < count:
        out[("id",)] = code
    return out


def _sfnt_simple_paths(font, codes: set, cmaps: dict, reverse: dict, count: int, builtin) -> dict:
    """code → its paths, for every code of `codes`."""
    tounicode = _tounicode_map(font)
    return {
        code: _sfnt_code_paths(font, code, cmaps, reverse, count, builtin, tounicode)
        for code in codes
    }


def _sfnt_tables(tt) -> tuple:
    """(cmap subtables by (platform, encoding), glyph name → id, glyph count)."""
    order = list(tt.getGlyphOrder())
    cmaps: dict = {}
    if "cmap" in tt:
        for table in tt["cmap"].tables:
            cmaps.setdefault((table.platformID, table.platEncID), dict(table.cmap))
    return cmaps, {name: gid for gid, name in enumerate(order)}, len(order)


def _tounicode_map(font) -> dict:
    stream = font.get("/ToUnicode")
    if not isinstance(stream, Stream):
        return {}
    data = _read(stream, MAX_MAP_BYTES)
    return pdf_fonts._parse_tounicode(data) if data is not None else {}


def _subset_options(retain: bool):
    from fontTools import subset

    options = subset.Options()
    options.retain_gids = retain
    options.notdef_outline = True
    options.notdef_glyph = True
    options.glyph_names = True
    # A reader reaches a simple font's glyphs through the (3, 0) and (1, 0)
    # subtables (§9.6.5.4); the defaults drop both.
    options.symbol_cmap = True
    options.legacy_cmap = True
    options.legacy_kern = True
    options.layout_features = []
    options.layout_closure = False
    options.bidi_closure = False
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.name_legacy = True
    options.hinting = True
    options.desubroutinize = False
    options.ignore_missing_glyphs = True
    options.ignore_missing_unicodes = True
    options.recalc_bounds = False
    options.recalc_timestamp = False
    options.recalc_average_width = False
    options.prune_unicode_ranges = False
    options.prune_codepage_ranges = False
    # Embedded bitmaps are glyphs too: cut with the outlines, never dropped.
    options.drop_tables = [tag for tag in options.drop_tables if tag not in ("EBDT", "EBLC", "EBSC")]
    options.no_subset_tables = list(options.no_subset_tables) + ["EBSC"]
    return options


def _neutral_names(order: list, emptied: set) -> dict:
    """A name derived from its id for every emptied glyph, unique in `order`."""
    taken = set(order)
    out = {}
    for gid, name in enumerate(order):
        if name not in emptied:
            continue
        candidate = f"gid{gid:05d}"
        suffix = 0
        while candidate in taken:
            suffix += 1
            candidate = f"gid{gid:05d}.{suffix}"
        taken.add(candidate)
        out[name] = candidate
    return out


def _rename_cff(cff, renames: dict) -> None:
    for fontname in cff.keys():
        top = cff[fontname]
        top.charset = [renames.get(name, name) for name in top.charset]
        charstrings = top.CharStrings
        charstrings.charStrings = {
            renames.get(name, name): value for name, value in charstrings.charStrings.items()
        }


def _cut_result(order: list, retained: set, retain: bool):
    """(old id → new id, or None where ids stay; the ids kept)."""
    if retain:
        return None, {gid for gid, name in enumerate(order) if name in retained}
    survivors = [gid for gid, name in enumerate(order) if name in retained]
    return {old: new for new, old in enumerate(survivors)}, set(survivors)


def _subset_sfnt(font, data: bytes, kept: set, retain: bool):
    """(program bytes, id map, the kept glyphs' names)."""
    from fontTools import subset
    from fontTools.ttLib import TTFont

    try:
        tt = TTFont(io.BytesIO(data), lazy=True, recalcTimestamp=False, recalcBBoxes=False)
        _expand_empty_glyphs(tt)
        order = list(tt.getGlyphOrder())
        byte_tables = [
            (table.platformID, table.platEncID, table.language, dict(table.cmap))
            for table in (tt["cmap"].tables if "cmap" in tt else [])
            if table.format == 0
        ]
        subsetter = subset.Subsetter(_subset_options(retain))
        subsetter.populate(gids=sorted(kept))
        subsetter.subset(tt)
        retained = set(subsetter.glyphs_retained)
        _restore_byte_tables(tt, byte_tables, retained)
        if retain:
            renames = _neutral_names(order, {name for name in order if name not in retained})
            if "CFF " in tt:
                _rename_cff(tt["CFF "].cff, renames)
            if "post" in tt:
                tt["post"].extraNames = []
                tt["post"].mapping = dict(renames)
        buffer = io.BytesIO()
        tt.save(buffer)
        new_data = buffer.getvalue()
    except Exception:
        _refuse(font, "its font program cannot be cut")
    remap, keep_ids = _cut_result(order, retained, retain)
    _verify_sfnt(font, data, new_data, keep_ids, remap)
    return new_data, remap, [order[gid] for gid in sorted(keep_ids)]


def _expand_empty_glyphs(tt) -> None:
    """Decompile every glyph record of zero contours. Such a record draws
    nothing, but one that ends before its instruction length cannot be trimmed
    in raw form, and the subsetter trims every glyph it keeps."""
    if "glyf" not in tt:
        return
    glyf = tt["glyf"]
    for glyph in glyf.glyphs.values():
        data = getattr(glyph, "data", None)
        if data and len(data) >= 2 and int.from_bytes(data[:2], "big", signed=True) == 0:
            glyph.expand(glyf)


def _restore_byte_tables(tt, byte_tables: list, retained: set) -> None:
    """Put back the format 0 cmap subtables, cut to the kept glyphs. The
    subsetter drops every format 0 subtable, and the (1, 0) Mac Roman one is
    how a reader reaches a symbolic font's glyphs (§9.6.5.4)."""
    from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

    if not byte_tables:
        return
    if "cmap" not in tt:
        from fontTools.ttLib import newTable

        tt["cmap"] = newTable("cmap")
        tt["cmap"].tableVersion = 0
        tt["cmap"].tables = []
    present = {(t.platformID, t.platEncID, t.language) for t in tt["cmap"].tables}
    for platform, encoding, language, mapping in byte_tables:
        kept = {code: name for code, name in mapping.items() if name in retained}
        if not kept or (platform, encoding, language) in present:
            continue
        table = CmapSubtable.newSubtable(0)
        table.platformID, table.platEncID, table.language = platform, encoding, language
        table.cmap = kept
        tt["cmap"].tables.append(table)
    tt["cmap"].tables.sort(key=lambda t: (t.platformID, t.platEncID, t.language))


def _cff_font(data: bytes):
    """A bare CFF program inside an otherwise empty font: the shape the
    subsetter cuts."""
    from fontTools.ttLib import TTFont, newTable

    from fontTools.cffLib import cffISOAdobeStrings

    font = TTFont(recalcBBoxes=False, recalcTimestamp=False)
    table = newTable("CFF ")
    table.decompile(data, font)
    font["CFF "] = table
    for name in table.cff.keys():
        top = table.cff[name]
        if not hasattr(top, "charset"):
            # A Top DICT without a charset operator declares the ISOAdobe
            # charset; cffLib raises instead of applying that default.
            top.charset = list(cffISOAdobeStrings[: top.numGlyphs])
    return font


def _subset_bare_cff(font, data: bytes, kept: set, retain: bool):
    from fontTools import subset

    try:
        wrapper = _cff_font(data)
        order = list(wrapper["CFF "].cff.topDictIndex[0].charset)
        subsetter = subset.Subsetter(_subset_options(retain))
        subsetter.populate(gids=sorted(kept))
        subsetter.subset(wrapper)
        retained = set(subsetter.glyphs_retained)
        if retain:
            emptied = {name for name in order if name not in retained}
            _rename_cff(wrapper["CFF "].cff, _neutral_names(order, emptied))
        new_data = wrapper["CFF "].compile(wrapper)
    except Exception:
        _refuse(font, "its font program cannot be cut")
    remap, keep_ids = _cut_result(order, retained, retain)
    _verify_cff(font, data, new_data, keep_ids, remap)
    return new_data, remap, [order[gid] for gid in sorted(keep_ids)]


def _decomposed(glyph_set, name):
    from fontTools.pens.recordingPen import DecomposingRecordingPen

    pen = DecomposingRecordingPen(glyph_set)
    glyph_set[name].draw(pen)
    return pen.value


def _verify_sfnt(font, old: bytes, new: bytes, keep_ids: set, remap) -> None:
    """Every kept glyph draws what it drew, and no other glyph draws anything."""
    from fontTools.ttLib import TTFont

    try:
        before = TTFont(io.BytesIO(old), lazy=True)
        after = TTFont(io.BytesIO(new), lazy=True)
        old_order = before.getGlyphOrder()
        new_order = after.getGlyphOrder()
        old_set = before.getGlyphSet()
        new_set = after.getGlyphSet()
        expected = len(keep_ids) if remap is not None else max(keep_ids) + 1
        ok = len(new_order) == expected
        for gid in sorted(keep_ids) if ok else ():
            new_gid = remap[gid] if remap is not None else gid
            if _decomposed(old_set, old_order[gid]) != _decomposed(new_set, new_order[new_gid]):
                ok = False
                break
        if ok and remap is None:
            ok = not any(
                _decomposed(new_set, name)
                for gid, name in enumerate(new_order)
                if gid not in keep_ids
            )
    except Exception:
        ok = False
    if not ok:
        _refuse(font, "its cut font program could not be verified")


def _verify_sfnt_paths(font, new: bytes, simple: list, remap) -> None:
    """Every surviving code of every simple font reaches, by every path a
    reader takes, the glyph it reached before."""
    from fontTools.ttLib import TTFont

    try:
        tt = TTFont(io.BytesIO(new), lazy=True)
        cmaps, reverse, count = _sfnt_tables(tt)
        top = tt["CFF "].cff.topDictIndex[0] if "CFF " in tt else None
        builtin = _cff_builtin(top) if top is not None and not hasattr(top, "ROS") else None
        ok = True
        for user, paths in simple:
            tounicode = _tounicode_map(user)
            for code, before in paths.items():
                after = _sfnt_code_paths(user, code, cmaps, reverse, count, builtin, tounicode)
                expected = {
                    path: (remap.get(gid) if remap is not None else gid)
                    for path, gid in before.items()
                }
                if after != expected:
                    ok = False
    except Exception:
        ok = False
    if not ok:
        _refuse(font, "its cut font program could not be verified")


def _cff_outline(top, name):
    from fontTools.pens.recordingPen import RecordingPen

    pen = RecordingPen()
    charstring = top.CharStrings[name]
    charstring.draw(pen)
    return pen.value, charstring.width


def _verify_cff(font, old: bytes, new: bytes, keep_ids: set, remap) -> None:
    try:
        old_top = _cff_font(old)["CFF "].cff.topDictIndex[0]
        new_top = _cff_font(new)["CFF "].cff.topDictIndex[0]
        old_order = list(old_top.charset)
        new_order = list(new_top.charset)
        expected = len(keep_ids) if remap is not None else max(keep_ids) + 1
        ok = len(new_order) == expected
        for gid in sorted(keep_ids) if ok else ():
            new_gid = remap[gid] if remap is not None else gid
            if _cff_outline(old_top, old_order[gid]) != _cff_outline(new_top, new_order[new_gid]):
                ok = False
                break
        if ok and remap is None:
            ok = not any(
                _cff_outline(new_top, name)[0]
                for gid, name in enumerate(new_order)
                if gid not in keep_ids
            )
    except Exception:
        ok = False
    if not ok:
        _refuse(font, "its cut font program could not be verified")


def _write_program(stream, slot: str, data: bytes) -> None:
    stream.write(data)
    if slot == "/FontFile2" or "/Length1" in stream:
        stream["/Length1"] = len(data)
    for stale in ("/Length2", "/Length3"):
        if stale in stream:
            del stream[stale]


# ── Type 1 programs ───────────────────────────────────────────────────────

_EEXEC = b"currentfile eexec"
_TOKEN = re.compile(rb"[ \t\r\n\f\x00]*([^ \t\r\n\f\x00]+)")
_SUBR = re.compile(rb"[ \t\r\n\f\x00]*dup[ \t\r\n]+(\d+)[ \t\r\n]+(\d+)[ \t\r\n]+[^ \t\r\n]+[ \t\r\n]")
_GLYPH = re.compile(
    rb"[ \t\r\n\f\x00]*/([^ \t\r\n\f\x00/\[\]{}()<>%]+)[ \t\r\n]+(\d+)[ \t\r\n]+[^ \t\r\n]+[ \t\r\n]"
)
_CHARSTRINGS = re.compile(rb"/CharStrings[ \t\r\n]+(\d+)[ \t\r\n]+dict[ \t\r\n]+dup[ \t\r\n]+begin")
_BUILTIN_ENTRY = re.compile(rb"dup[ \t\r\n]+(\d+)[ \t\r\n]*/([^ \t\r\n\f/\[\]{}()<>%]+)[ \t\r\n]+put")


class _Type1:
    """A Type 1 program in its three sections (ISO 32000-2 Table 125), its
    encrypted section decrypted and its CharStrings and Subrs located by byte
    span, so a cut rewrites those spans and nothing else."""

    def __init__(self, font, raw: bytes):
        from fontTools.misc import eexec

        self.font = font
        if len(raw) > pdf_fonts.MAX_TYPE1_PROGRAM_BYTES:
            _refuse(font, f"its Type 1 program is larger than {pdf_fonts.MAX_TYPE1_PROGRAM_BYTES} bytes")
        if raw[:1] == b"\x80":
            raw = _unsegment(font, raw)
        marker = raw.find(_EEXEC)
        if marker < 0:
            _refuse(font, "its Type 1 program cannot be read")
        zeros = raw.find(b"0" * 64, marker)
        end = len(raw) if zeros < 0 else zeros
        length1 = _int(font, "/Length1")
        starts = [marker + len(_EEXEC) + 1, marker + len(_EEXEC) + 2]
        if length1 is not None and marker < length1 < end:
            starts.insert(0, length1)
        for begin in starts:
            cipher = raw[begin:end]
            if cipher[:4] and re.fullmatch(rb"[0-9A-Fa-f]{4}", cipher[:4]):
                from fontTools.t1Lib import deHexString

                try:
                    cipher = deHexString(cipher)
                except ValueError:
                    continue
            plain = eexec.decrypt(cipher, 55665)[0]
            if _CHARSTRINGS.search(plain) and b"closefile" in plain:
                break
        else:
            _refuse(font, "its Type 1 program cannot be read")
        self.clear = raw[:begin]
        self.trailer = raw[end:]
        self.iv = plain[:4]
        self.plain = plain[4:]
        match = re.search(rb"/lenIV[ \t\r\n]+(-?\d+)", self.plain)
        self.len_iv = int(match.group(1)) if match else 4
        self.subrs: dict = {}
        self.glyphs: dict = {}
        self._locate_subrs()
        self._locate_glyphs()
        self.builtin = _type1_builtin(self.clear)
        self.used_subrs: set = set()

    def _locate_subrs(self) -> None:
        head = re.search(rb"/Subrs[ \t\r\n]+(\d+)[ \t\r\n]+array", self.plain)
        if head is None:
            return
        pos = head.end()
        for _ in range(int(head.group(1))):
            match = _SUBR.match(self.plain, pos)
            for _ in range(3):
                if match is not None:
                    break
                skipped = _TOKEN.match(self.plain, pos)
                if skipped is None or skipped.group(1) == b"dup":
                    break
                pos = skipped.end()
                match = _SUBR.match(self.plain, pos)
            if match is None:
                break
            start = match.end()
            stop = start + int(match.group(2))
            if stop > len(self.plain):
                _refuse(self.font, "its Type 1 program cannot be read")
            self.subrs[int(match.group(1))] = (match.start(2), match.end(2), start, stop)
            pos = stop

    def _locate_glyphs(self) -> None:
        head = _CHARSTRINGS.search(self.plain)
        self.count_span = (head.start(1), head.end(1))
        pos = head.end()
        while True:
            match = _GLYPH.match(self.plain, pos)
            if match is None:
                break
            start = match.end()
            stop = start + int(match.group(2))
            if stop > len(self.plain):
                _refuse(self.font, "its Type 1 program cannot be read")
            pos = stop
            for _ in range(3):
                token = _TOKEN.match(self.plain, pos)
                if token is None or token.group(1).startswith(b"/") or token.group(1) == b"end":
                    break
                pos = token.end()
            self.glyphs[match.group(1).decode("latin-1")] = (match.start(), pos, start, stop)
        token = _TOKEN.match(self.plain, pos)
        if token is None or token.group(1) != b"end" or ".notdef" not in self.glyphs:
            _refuse(self.font, "its Type 1 program cannot be read")

    def charstring(self, span) -> bytes:
        from fontTools.misc import eexec

        data = self.plain[span[2] : span[3]]
        if self.len_iv < 0:
            return data
        return eexec.decrypt(data, 4330)[0][self.len_iv :]

    def closure(self, kept: set) -> set:
        """`kept` and every glyph an accented one among them is built from;
        the subroutines they call are left on `used_subrs`."""
        from fontTools.misc.psCharStrings import T1CharString, T1OutlineExtractor
        from fontTools.pens.basePen import NullPen

        subrs: list = []
        for index in range(max(self.subrs) + 1 if self.subrs else 0):
            span = self.subrs.get(index)
            subrs.append(T1CharString(self.charstring(span), subrs=subrs) if span else None)
        used: set = set()
        components: set = set()

        class Pen(NullPen):
            def addComponent(self, glyph_name, transformation):
                components.add(glyph_name)

        class Tracer(T1OutlineExtractor):
            def reset(self):
                super().reset()
                self.nesting = 0

            def op_callsubr(self, index):
                number = int(self.pop())
                if not 0 <= number < len(self.subrs) or self.subrs[number] is None:
                    raise _Unreadable
                if self.nesting >= MAX_SUBR_DEPTH:
                    raise _Unreadable
                used.add(number)
                self.nesting += 1
                try:
                    self.execute(self.subrs[number])
                finally:
                    self.nesting -= 1

            def op_callothersubr(self, index):
                if int(self.operandStack[-1]) not in (0, 1, 2, 3):
                    raise _Unreadable
                super().op_callothersubr(index)

        pending = set(kept)
        done: set = set()
        try:
            while pending:
                name = pending.pop()
                if name in done or name not in self.glyphs:
                    continue
                done.add(name)
                components.clear()
                glyph = T1CharString(self.charstring(self.glyphs[name]), subrs=subrs)
                Tracer(Pen(), subrs).execute(glyph)
                pending |= components - done
        except Exception:
            _refuse(self.font, "its Type 1 subroutine calls cannot be traced")
        self.used_subrs = used
        return done | {".notdef"}

    def cut(self, kept: set):
        """(clear text, encrypted section, trailer) holding only `kept`."""
        from fontTools.misc import eexec

        edits = [
            (span[0], span[1], b"") for name, span in self.glyphs.items() if name not in kept
        ]
        for index, (count_start, count_end, start, stop) in self.subrs.items():
            if index < 4 or index in self.used_subrs:
                continue
            if self.len_iv < 0:
                body = b"\x0b"
            else:
                seed = eexec.decrypt(self.plain[start:stop], 4330)[0][: self.len_iv]
                body = eexec.encrypt(seed.ljust(self.len_iv, b"\x00") + b"\x0b", 4330)[0]
            edits.append((count_start, count_end, str(len(body)).encode("ascii")))
            edits.append((start, stop, body))
        count = sum(1 for name in self.glyphs if name in kept)
        edits.append((self.count_span[0], self.count_span[1], str(count).encode("ascii")))
        plain = self.plain
        for start, stop, replacement in sorted(edits, reverse=True):
            plain = plain[:start] + replacement + plain[stop:]
        cipher = eexec.encrypt(self.iv + plain, 55665)[0]
        return _cut_builtin(self.clear, kept), cipher, self.trailer


def _int(font, slot: str) -> Optional[int]:
    _slot, stream = _program_of(_descriptor(font))
    try:
        return int(stream.get(slot)) if stream is not None and stream.get(slot) is not None else None
    except (TypeError, ValueError):
        return None


def _unsegment(font, raw: bytes) -> bytes:
    """A PFB-segmented program as the byte sequence its segments hold."""
    out = bytearray()
    pos = 0
    while pos + 1 < len(raw) and raw[pos] == 0x80:
        kind = raw[pos + 1]
        if kind == 3:
            break
        if pos + 6 > len(raw):
            _refuse(font, "its Type 1 program cannot be read")
        length = int.from_bytes(raw[pos + 2 : pos + 6], "little")
        out += raw[pos + 6 : pos + 6 + length]
        pos += 6 + length
    return bytes(out)


_STANDARD_BUILTIN = re.compile(rb"/Encoding[ \t\r\n]+StandardEncoding[ \t\r\n]+def")


def _builtin_entries(clear: bytes) -> list:
    """The `dup code /name put` statements of the built-in encoding: the run
    of them that follows `/Encoding`, up to the `def` that closes it."""
    start = clear.find(b"/Encoding")
    if start < 0 or _STANDARD_BUILTIN.match(clear, start):
        return []
    out: list = []
    end = start
    for match in _BUILTIN_ENTRY.finditer(clear, start):
        if out and re.search(rb"(?<![A-Za-z])def(?![A-Za-z])", clear[end : match.start()]):
            break
        out.append(match)
        end = match.end()
    return out


def _type1_builtin(clear: bytes) -> Optional[list]:
    start = clear.find(b"/Encoding")
    if start >= 0 and _STANDARD_BUILTIN.match(clear, start):
        return list(_STANDARD_BUILTIN_NAMES)
    entries = _builtin_entries(clear)
    if not entries:
        return None
    table = [".notdef"] * 256
    for match in entries:
        code = int(match.group(1))
        if 0 <= code < 256:
            table[code] = match.group(2).decode("latin-1")
    return table


def _cut_builtin(clear: bytes, kept: set) -> bytes:
    """The clear text with the built-in encoding naming only `kept`."""
    out = clear
    for match in reversed(_builtin_entries(clear)):
        if match.group(2).decode("latin-1") not in kept:
            out = out[: match.start()] + out[match.end() :]
    return out


def _verify_type1(font, old: bytes, new: bytes, kept: set) -> None:
    """The cut program parses, holds exactly `kept`, and every kept glyph
    draws what it drew."""
    try:
        before = _type1_outlines(font, old)
        after = _type1_outlines(font, new)
        ok = set(after) == set(kept) and all(after[name] == before.get(name) for name in kept)
    except Exception:
        ok = False
    if not ok:
        _refuse(font, "its cut font program could not be verified")


def _type1_outlines(font, raw: bytes) -> dict:
    """Glyph name → (outline, advance), parsed on the bounded interpreter the
    capability reader uses."""
    import os
    import tempfile

    from fontTools.misc import psLib
    from fontTools.pens.recordingPen import RecordingPen
    from fontTools.t1Lib import T1Font

    if raw[:1] == b"\x80":
        raw = _unsegment(font, raw)
    marker = raw.find(_EEXEC)
    section = raw[marker + len(_EEXEC) + 1 :].translate(None, pdf_fonts._T1_WHITESPACE)
    if pdf_fonts._T1_ZERO_RUN not in section:
        raw = raw + pdf_fonts._T1_TRAILER
    handle, path = tempfile.mkstemp(suffix=".pfa")
    original = psLib.PSInterpreter
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(raw)
        program = T1Font(path)
        psLib.PSInterpreter = pdf_fonts._bounded_t1_interpreter()
        try:
            program.parse()
        finally:
            psLib.PSInterpreter = original
        glyphs = program["CharStrings"]
        result = {}
        for name in glyphs.keys():
            pen = RecordingPen()
            glyphs[name].draw(pen)
            result[name] = (pen.value, glyphs[name].width)
        return result
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


# ── Type 3 resources ──────────────────────────────────────────────────────


_NAMED_BY = {
    "Do": ("/XObject", 0),
    "gs": ("/ExtGState", 0),
    "sh": ("/Shading", 0),
    "Tf": ("/Font", 0),
    "BDC": ("/Properties", 1),
}
_TYPE3_PRUNED = ("/XObject", "/Pattern", "/ExtGState", "/Shading", "/Properties", "/Font")


def _type3_references(font, resources) -> dict:
    """Category → the spellings the font's glyph procedures name in its
    /Resources, with those of every form drawn through it that has no
    /Resources of its own and so resolves names in the same dictionary."""
    used: dict = {category: set() for category in _TYPE3_PRUNED}
    procs = font.get("/CharProcs")
    xobjects = resources.get("/XObject")
    pending = [(proc, 0) for proc in procs.values() if isinstance(proc, Stream)]
    seen: set = set()
    while pending:
        stream, depth = pending.pop()
        key = _key(stream)
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        try:
            if depth > MAX_SCAN_DEPTH:
                raise _Unreadable
            instructions = pikepdf.parse_content_stream(stream)
        except Exception:
            _refuse(font, "a glyph procedure it keeps cannot be read")
        for ins in instructions:
            op = token_text(ins.operator)
            operands = ins.operands
            if op in _NAMED_BY:
                category, index = _NAMED_BY[op]
            elif op in ("scn", "SCN") and len(operands):
                category, index = "/Pattern", len(operands) - 1
            else:
                continue
            if len(operands) <= index or not isinstance(operands[index], Name):
                continue
            spelled = _text(operands[index])
            used[category].add(spelled)
            if category != "/XObject" or not isinstance(xobjects, Dictionary):
                continue
            form = xobjects.get(_name(spelled))
            if isinstance(form, Stream) and _subtype(form) == "/Form" and form.get("/Resources") is None:
                pending.append((form, depth + 1))
    return used


def _prune_type3_resources(font) -> None:
    """The font's /Resources as its own copy, each category a glyph procedure
    names from pruned to the names the remaining procedures use."""
    resources = font.get("/Resources")
    if not isinstance(resources, Dictionary) or not isinstance(font.get("/CharProcs"), Dictionary):
        return
    used = _type3_references(font, resources)
    own = Dictionary()
    for key in list(resources.keys()):
        category = _key_text(key)
        slot = _name(category)
        value = resources.get(slot)
        if category in used and isinstance(value, Dictionary):
            table = Dictionary()
            for entry in list(value.keys()):
                spelled = _key_text(entry)
                if spelled in used[category]:
                    table[_name(spelled)] = value.get(_name(spelled))
            value = table
        own[slot] = value
    font["/Resources"] = own


# ── CID metrics ───────────────────────────────────────────────────────────


def _filter_cid_metrics(items: list, keep: set, group: int) -> Optional[list]:
    """A /W (`group` 1) or /W2 (`group` 3) array describing only the CIDs in
    `keep`, each exactly as before and in the same order, so a CID listed
    twice resolves as it did (§9.7.4.3). None when nothing leaves."""
    out: list = []
    changed = False
    index = 0
    while index < len(items):
        try:
            start = int(items[index])
        except (TypeError, ValueError):
            return None
        if index + 1 < len(items) and isinstance(items[index + 1], Array):
            values = list(items[index + 1])
            run_start = None
            run: list = []
            for offset in range(len(values) // group):
                cid = start + offset
                if cid in keep:
                    if run_start is None:
                        run_start = cid
                    run.extend(values[offset * group : (offset + 1) * group])
                    continue
                changed = True
                if run_start is not None:
                    out.extend([run_start, Array(run)])
                    run_start, run = None, []
            if run_start is not None:
                out.extend([run_start, Array(run)])
            index += 2
            continue
        if index + 2 + group > len(items):
            return None
        try:
            last = int(items[index + 1])
        except (TypeError, ValueError):
            return None
        values = items[index + 2 : index + 2 + group]
        inside = sorted(cid for cid in keep if start <= cid <= last)
        if len(inside) != last - start + 1:
            changed = True
        run_start = previous = None
        for cid in inside:
            if run_start is not None and cid == previous + 1:
                previous = cid
                continue
            if run_start is not None:
                out.extend([run_start, previous, *values])
            run_start = previous = cid
        if run_start is not None:
            out.extend([run_start, previous, *values])
        index += 2 + group
    return out if changed else None


# ── ToUnicode and embedded CMaps ──────────────────────────────────────────


def _codespace_ranges(text: bytes) -> list:
    out = []
    for block in re.finditer(rb"begincodespacerange(.*?)endcodespacerange", text, re.S):
        for low, high in re.findall(rb"<([0-9A-Fa-f\s]*)>\s*<([0-9A-Fa-f\s]*)>", block.group(1)):
            try:
                low = bytes.fromhex(re.sub(rb"\s", b"", low).decode("ascii"))
                high = bytes.fromhex(re.sub(rb"\s", b"", high).decode("ascii"))
            except ValueError:
                continue
            if low and len(low) == len(high):
                out.append((low, high))
    return out


def _hex(data: bytes) -> bytes:
    return b"<" + data.hex().upper().encode("ascii") + b">"


def _rewrite_tounicode(font, stream, codes: set) -> None:
    """Keep the survivors' entries only, each mapping to exactly what the
    extraction reader read from it before."""
    from pdfminer.cmapdb import CMapParser, FileUnicodeMap

    data = _read(stream, MAX_MAP_BYTES)
    if data is None:
        _refuse(font, "its ToUnicode map cannot be read")
    if stream.get("/UseCMap") is not None or re.search(rb"usecmap", data):
        _refuse(font, "its ToUnicode map is built on another map")
    # The parsed map is keyed by a code's value, not its bytes: codespace
    # ranges of two widths over the same values (<41> and <0041>) would merge
    # two codes into one entry.
    spans = [(len(lo), int.from_bytes(lo, "big"), int.from_bytes(hi, "big")) for lo, hi in _codespace_ranges(data)]
    for width, low, high in spans:
        if any(other != width and low <= top and bottom <= high for other, bottom, top in spans):
            _refuse(font, "its ToUnicode map cannot be read")
    table = FileUnicodeMap()
    try:
        CMapParser(table, io.BytesIO(data)).run()
    except Exception:
        _refuse(font, "its ToUnicode map cannot be read")
    mapping = dict(table.cid2unichr)
    if not mapping:
        if re.search(rb"begin(?:bfchar|bfrange)", data):
            _refuse(font, "its ToUnicode map cannot be read")
        return
    wanted = {int.from_bytes(code, "big"): code for code in codes if code}
    if set(mapping) <= set(wanted):
        return
    entries = sorted((code, mapping[value]) for value, code in wanted.items() if value in mapping)
    ranges = _codespace_ranges(data)
    if not ranges:
        widths = sorted({len(code) for code, _text in entries} or {1})
        ranges = [(b"\x00" * width, b"\xff" * width) for width in widths]
    lines = [
        b"/CIDInit /ProcSet findresource begin",
        b"12 dict begin",
        b"begincmap",
        b"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        b"/CMapName /Adobe-Identity-UCS def",
        b"/CMapType 2 def",
        b"%d begincodespacerange" % len(ranges),
    ]
    lines += [_hex(low) + b" " + _hex(high) for low, high in ranges]
    lines.append(b"endcodespacerange")
    for start in range(0, len(entries), _MAP_BLOCK):
        block = entries[start : start + _MAP_BLOCK]
        lines.append(b"%d beginbfchar" % len(block))
        lines += [_hex(code) + b" " + _hex(text.encode("utf-16-be")) for code, text in block]
        lines.append(b"endbfchar")
    lines += [
        b"endcmap",
        b"CMapName currentdict /CMap defineresource pop",
        b"end",
        b"end",
    ]
    stream.write(b"\n".join(lines) + b"\n")


def _ps_string(data: bytes) -> bytes:
    return b"(" + data.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)") + b")"


# A PostScript name token has no escapes: a PDF name holding white space, a
# delimiter or a byte outside printable ASCII cannot be written into a CMap as
# one token.
_PS_NAME = re.compile(rb"/[^\x00-\x20\x7f-\xff()<>\[\]{}/%]+")


def _rewrite_embedded_cmap(font, stream, codes: set) -> None:
    """An embedded CMap mapping the survivors' codes and nothing else: the same
    codespace, each survivor to the CID it resolved to (§9.7.5.3). Every other
    code falls to CID 0, which no surviving text draws."""
    cmap = pdf_fonts.embedded_cmap(stream)
    if cmap is None:
        _refuse(font, "its character map cannot be read")
    spaces = cmap.spaces
    if not spaces and cmap.base in ("Identity-H", "Identity-V"):
        spaces = [(b"\x00\x00", b"\xff\xff")]
    if not spaces:
        # The codes read through a predefined CMap's codespace, which the
        # bundled tables do not state as ranges.
        _refuse(font, "its character map cannot be read")
    entries = sorted((code, cmap.cid(code)) for code in codes if code)
    if (
        not cmap.ranges
        and not cmap.notdef_chars
        and not cmap.notdef_ranges
        and cmap.base is None
        and set(cmap.chars) == {code for code, _cid in entries}
        and all(cmap.chars[code] == cid for code, cid in entries)
    ):
        return
    info = stream.get("/CIDSystemInfo")
    registry, ordering, supplement = b"Adobe", b"Identity", 0
    if isinstance(info, Dictionary):
        registry = bytes(info.get("/Registry", pikepdf.String(registry)))
        ordering = bytes(info.get("/Ordering", pikepdf.String(ordering)))
        try:
            supplement = int(info.get("/Supplement", 0))
        except (TypeError, ValueError):
            supplement = 0
    name = _text(stream.get("/CMapName")).encode("latin-1") if isinstance(stream.get("/CMapName"), Name) else b""
    if not _PS_NAME.fullmatch(name):
        name = b"/Redacted"
    wmode = stream.get("/WMode")
    try:
        wmode = int(wmode) if wmode is not None else cmap.wmode
    except (TypeError, ValueError):
        wmode = cmap.wmode
    lines = [
        b"/CIDInit /ProcSet findresource begin",
        b"12 dict begin",
        b"begincmap",
        b"/CIDSystemInfo 3 dict dup begin",
        b"/Registry " + _ps_string(registry) + b" def",
        b"/Ordering " + _ps_string(ordering) + b" def",
        b"/Supplement %d def" % supplement,
        b"end def",
        b"/CMapName " + name + b" def",
        b"/CMapType 1 def",
    ]
    if wmode is not None:
        lines.append(b"/WMode %d def" % wmode)
    lines.append(b"%d begincodespacerange" % len(spaces))
    lines += [_hex(low) + b" " + _hex(high) for low, high in spaces]
    lines.append(b"endcodespacerange")
    for start in range(0, len(entries), _MAP_BLOCK):
        block = entries[start : start + _MAP_BLOCK]
        lines.append(b"%d begincidchar" % len(block))
        lines += [_hex(code) + b" %d" % cid for code, cid in block]
        lines.append(b"endcidchar")
    lines += [
        b"endcmap",
        b"CMapName currentdict /CMap defineresource pop",
        b"end",
        b"end",
    ]
    stream.write(b"\n".join(lines) + b"\n")
    if "/UseCMap" in stream:
        # Every surviving code is mapped in full above; the CMap no longer
        # builds on another.
        del stream["/UseCMap"]
