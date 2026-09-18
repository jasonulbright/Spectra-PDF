"""Per-font round-trip capability for text editing.

For a pikepdf font dictionary, answers the four questions editing needs:
decode (bytes → unicode), encode (unicode → bytes, refusing characters the
font cannot express; multi-char ligature sequences with an
unambiguous inverse round-trip longest-match-first), the finite ENCODABLE
character inventory (the live edit-box validation set; sequences are the
additive `encodable_sequences()` layer on top of that single-char floor),
and per-character advance widths (1000/em) for the Δwidth anchor math.

Leverages pdfminer.six's own tables and parsers (it is already the bundled
extraction engine) rather than re-deriving them — the verified,
document-free subset:
  - `EncodingDB.get_encoding(base, differences)` for simple-font code maps
    (Differences glyph names must be `PSLiteral` — plain strings are
    silently skipped).
  - `CMapParser` + `FileUnicodeMap` fed the RAW ToUnicode bytes via
    BytesIO — never through `stream_value`, which silently returns an
    EMPTY map for non-PDFStream input.
  - `FONT_METRICS` for base-14 widths (keyed by unicode CHAR, not code).
  - `get_widths` for the CID /W array (standalone, takes a plain list).

Editability taxonomy (every run is LISTED; refusal carries the reason):
  - Simple Type1/TrueType with a resolvable encoding → editable.
  - Symbolic simple fonts without one: ToUnicode when present, else a map
    DERIVED from the embedded program's cmap + glyph names; refused
    only when neither yields a single code. An embedded Type 1 program
    whose fixed-content portion was left out — which ISO 32000-2:2020,
    9.9.1, Table 125 permits and hands to the processor to add — is
    COMPLETED before its one bounded parse; a program that fails records
    WHY in `FontCapability.diagnostic` (engine-internal, English, and free
    of document bytes by construction).
  - Type0 + Identity-H + ToUnicode → editable (the copy-paste capability
    bar: text you can extract is text you can re-enter). Identity-V and
    Uni*-UCS2-V are their vertical twins: same 2-byte codes, same
    ToUnicode round-trip; the capability carries `vertical=True` and its
    widths are the /W2//DW2 VERTICAL advances (|w1y|, 1000/em) — callers
    apply the downward direction.
  - Type3 ("glyphs are procedures"), Type0 without ToUnicode or with a
    non-Identity CMap, and fonts with no resolvable encoding → refused,
    with that reason. These are the rare classes; the replacement-font
    fallback lifts coverage refusals for the editable ones.
"""

from io import BytesIO
from typing import Optional

import pikepdf
from pdfminer.cmapdb import CMapParser, FileUnicodeMap
from pdfminer.encodingdb import EncodingDB
from pdfminer.fontmetrics import FONT_METRICS
from pdfminer.psparser import LIT

DEFAULT_WIDTH = 500.0


def _strip_subset_prefix(base_font: str) -> str:
    # "ABCDEF+Helvetica" → "Helvetica" (six uppercase letters + '+').
    if len(base_font) > 7 and base_font[6] == "+" and base_font[:6].isalpha() and base_font[:6].isupper():
        return base_font[7:]
    return base_font


#: Parser failures whose text is a FIXED string in the library that raises it.
#: Repeating one of these cannot disclose anything, because no part of it came
#: from the document or from this machine. Every other failure contributes its
#: exception TYPE and nothing else: `PSError("name error: " + name)` splices in
#: the font program's own bytes, `T1Error("bad chunk code: " + repr(code))` a
#: byte from it, and an OSError its local filesystem path — and a diagnostic is
#: exactly the string a reporter pastes into a public issue. Exact match, so a
#: message that grows an interpolation upstream degrades to the type name
#: rather than starting to leak.
_SAFE_PARSER_FAILURES = frozenset({
    "can't find end of eexec part",
    "corrupt LWFN file",
    "corrupt PFB file",
    "dictstack underflow",
    "index may not be negative",
    "invalid end of eexec part",
    "not a PostScript font",
    "not a Type 1 font",
    "not an encrypted Type 1 font",
    "stack underflow",
})


def _parser_failure(exc: BaseException) -> str:
    """One font-program failure as a disclosure-free line.

    The TYPE always travels: it is the part that distinguishes a program this
    reader cannot open from one it opened and could not describe, and it is a
    short identifier by construction. A generically named type is qualified
    with its module, so `binascii.Error` does not read as a bare `Error` while
    `T1Error` and `PSError` stay as they are. The message travels only when it
    is one the library states literally."""
    cls = type(exc)
    name = cls.__name__
    if name in ("Error", "error") and cls.__module__ not in ("builtins", None):
        name = f"{cls.__module__}.{name}"
    message = str(exc).strip()
    return f"{name}: {message}" if message in _SAFE_PARSER_FAILURES else name


#: How much text a capability's `diagnostic` may carry. Enough for any line
#: this module composes; not enough to carry a payload. The same bound and the
#: same clip as `csc._MAX_PROVIDER_DETAIL`.
_MAX_DIAGNOSTIC = 200


def _clip(text: str) -> str:
    """Bound a diagnostic before it is stored."""
    if len(text) <= _MAX_DIAGNOSTIC:
        return text
    return text[:_MAX_DIAGNOSTIC].rstrip() + "…"


def _code_lengths(trie: dict) -> dict[int, int]:
    """{code integer → its byte length} for a CMap trie. The length is a
    property of the code's PREFIX, so it has to be read off the trie rather
    than assumed — that is the whole difference between these encodings and
    the fixed-width ones."""
    out: dict[int, int] = {}

    def walk(node, prefix: int, depth: int) -> None:
        for byte, value in node.items():
            code = (prefix << 8) | byte
            if isinstance(value, dict):
                walk(value, code, depth + 1)
            else:
                out[code] = depth + 1

    walk(trie, 0, 0)
    return out


def _split_codes(data: bytes, trie: dict) -> list[tuple[int, int]]:
    """[(code integer, byte length)] for `data` under a CMap trie.

    A byte sequence that falls off the trie is emitted as a ONE-BYTE code —
    the same recovery pdfminer makes, and the honest one: the alternative is
    to resynchronize by guessing a length, which silently shifts every later
    code in the string."""
    out: list[tuple[int, int]] = []
    i = 0
    n = len(data)
    while i < n:
        node = trie
        code = 0
        length = 0
        matched = None
        j = i
        while j < n:
            value = node.get(data[j])
            code = (code << 8) | data[j]
            length += 1
            j += 1
            if value is None:
                break
            if isinstance(value, dict):
                node = value
                continue
            matched = (code, length)
            break
        if matched is None:
            out.append((data[i], 1))
            i += 1
        else:
            out.append(matched)
            i += matched[1]
    return out


class FontCapability:
    """One font's round-trip surface. Immutable after construction."""

    def __init__(
        self,
        editable: bool,
        reason: Optional[str],
        code2uni: dict[int, str],
        uni2code: dict[str, int],
        widths: dict[int, float],
        default_width: float,
        code_bytes: int,
        sequences: Optional[dict[str, int]] = None,
        vertical: bool = False,
        code_trie: Optional[dict] = None,
        default_declared: bool = False,
        writes_vertical: Optional[bool] = None,
        reader_limit: bool = False,
        diagnostic: Optional[str] = None,
    ):
        self.editable = editable
        self.reason = reason
        # Why the EMBEDDED PROGRAM yielded nothing, when a refusal came from
        # a program derivation that failed rather than from a font that
        # declares nothing. `reason` names the class and is the string the
        # message catalog matches; this names the mechanism, and a swallowed
        # parse error is what made this whole class indistinguishable from a
        # font that really is symbolic.
        #
        # ENGINE-INTERNAL: it is not localized and it does not ride any run,
        # paragraph or report payload. Triage reads it off the capability for
        # the font in hand. A field on the wire that no surface renders is
        # dead weight, and this one is assembled from parser failures, so
        # keeping it off the wire is also what bounds its blast radius.
        # Clipped HERE, at the one place every producer's text passes.
        self.diagnostic = _clip(diagnostic) if diagnostic is not None else None
        # Does `reason` describe the DOCUMENT or THIS READER? A font that
        # carries no mapping is a defect in the file; an encoding this build
        # does not implement is a gap in us, and a check that reports the
        # second as the first tells the reader something false about their
        # document. Only the sites that genuinely mean "we cannot read this"
        # set it — see `_refused`.
        self.reader_limit = reader_limit
        self._code2uni = code2uni
        self._uni2code = uni2code
        self._widths = widths
        self._default_width = default_width
        # Is `default_width` DECLARED by the document, or a placeholder?
        # A composite font's /DW (default 1000 per spec) genuinely states the
        # advance of every CID its /W omits, so a code outside /W is measured,
        # not guessed. The simple/Type3 paths have no such declaration — their
        # default is the 500 placeholder, and a placeholder that comes out
        # NARROW is a redaction false negative. `measures()` is the only reader.
        self._default_declared = default_declared
        self._code_bytes = code_bytes  # 1 (simple) or 2 (Identity-H CID)
        # A VARIABLE-WIDTH codespace, as pdfminer's CMap trie —
        # `{byte: cid | {byte: ...}}`, so a code is 1..4 bytes and its length
        # is a property of its prefix, not of the font. Present for the
        # legacy CJK encodings (Shift-JIS/EUC/Big5/GBK, where ASCII is one
        # byte and everything else is two) and for the UTF-8/16/32 Unicode
        # CMaps. None keeps the fixed `_code_bytes` walk, byte for byte —
        # which is every simple font and every Identity-H one.
        self._code_trie = code_trie
        # Byte-length per code, for the encode side: unicode → the exact
        # bytes. Built alongside `uni2code` by the caller.
        self._code_len: dict[int, int] = {}
        if code_trie is not None:
            self._code_len = _code_lengths(code_trie)
        # Multi-char sequence → its single ligature code (len 2..4,
        # unambiguous inverse, encode-guard-filtered — see _ligatures).
        # encode()/text_width() match these longest-first; encodable()/
        # can_encode stay the single-char conservative floor.
        self._sequences = sequences or {}
        # Vertical writing mode. When True, `widths`/`default_width`
        # ARE the vertical advances (|w1y| from /W2//DW2, 1000/em), so
        # char_width/text_width/decoded_width return the vertical advance
        # magnitude unchanged — callers apply the downward direction.
        # `vertical` describes the GEOMETRY THIS CAPABILITY COMPUTES, so a
        # refused vertical font reports False (the run listing's documented
        # contract — the field describes what was actually computed).
        # `writes_vertical` describes the FONT: a -V encoding writes downward
        # whether or not its text can be re-entered. A walker measuring
        # INK must ask this one — a refused Identity-V run measured on the
        # horizontal axis leaves its whole column unprotected.
        self.vertical = vertical
        self.writes_vertical = vertical if writes_vertical is None else writes_vertical

    # -- decode ------------------------------------------------------------
    def decode_units(self, data: bytes) -> list[str]:
        """One string per CODE — the true unit boundaries of the drawn text.

        `decode` joins these, and a caller that then has to re-split
        them can only guess (the `_sequences` table is deliberately filtered
        to UNAMBIGUOUS inverses, so a ligature also expressible as separate
        codes is absent from it). The bidi reorder must not guess: reversing
        the two characters of a `لا` ligature that the font drew as ONE glyph
        turns `الله` into `لاله`. The codes know; this reports what they
        said."""
        return [self._code2uni.get(code, "�") for code, _n in self.codes(data)]

    def codes(self, data: bytes) -> list[tuple[int, int]]:
        """[(code integer, byte length)] — the ONE place the codespace is
        interpreted, so every measure/decode/count path agrees about where a
        code begins."""
        if self._code_trie is not None:
            return _split_codes(data, self._code_trie)
        if self._code_bytes == 1:
            return [(b, 1) for b in data]
        return [
            ((data[i] << 8) | data[i + 1], 2) for i in range(0, len(data) - 1, 2)
        ]

    def code_count(self, data: bytes) -> int:
        """How many GLYPHS `data` draws — what `Tc` multiplies. A fixed-width
        font can divide; a variable-width one has to walk."""
        if self._code_trie is None:
            return len(data) if self._code_bytes == 1 else len(data) // 2
        return len(self.codes(data))

    def single_byte_codes(self) -> bool:
        """Whether code 32 in the byte stream is the SPACE `Tw` applies to.
        Spec: word spacing applies to the single-byte code 32 only — never a
        CID font, and never a multi-byte code that happens to contain 0x20."""
        return self._code_trie is None and self._code_bytes == 1

    def decode(self, data: bytes) -> str:
        return "".join(self.decode_units(data))

    # -- encode ------------------------------------------------------------
    def _sequence_at(self, text: str, i: int) -> Optional[str]:
        # The longest listed ligature sequence starting at i (4→3→2),
        # else None — the ONE matcher encode() and text_width() share, so
        # emitted bytes and measured widths can never tokenize differently.
        for n in (4, 3, 2):
            seq = text[i : i + n]
            if len(seq) == n and seq in self._sequences:
                return seq
        return None

    def encode(self, text: str) -> bytes:
        """unicode → bytes, longest-match-first: a listed ligature
        sequence consumes its single code before the single-char map; a
        char reachable neither way refuses, naming it."""
        out = bytearray()
        i = 0
        while i < len(text):
            seq = self._sequence_at(text, i)
            if seq is not None:
                code = self._sequences[seq]
                i += len(seq)
            else:
                ch = text[i]
                code = self._uni2code.get(ch)
                if code is None:
                    raise ValueError(f"font cannot encode {ch!r}")
                i += 1
            out += self._code_bytes_for(code)
        return bytes(out)

    def _code_bytes_for(self, code: int) -> bytes:
        """A code as the bytes that spell it. Variable-width codes carry
        their own length (from the trie); fixed-width ones use the font's."""
        n = self._code_len.get(code) if self._code_trie is not None else None
        if n is None:
            n = self._code_bytes
        return code.to_bytes(n, "big")

    def encodable(self) -> str:
        """The finite character inventory, sorted — the edit box's local
        validation set. SINGLE-CHAR only (the conservative floor:
        sequences are the additive encodable_sequences() layer)."""
        return "".join(sorted(self._uni2code.keys()))

    def encodable_sequences(self) -> list[str]:
        """The multi-char sequences encode() round-trips via one unambiguous
        ligature code, sorted — the run listing's `sequences` field."""
        return sorted(self._sequences.keys())

    def can_encode(self, ch: str) -> bool:
        """True when the font can express `ch` (uses this to decide
        real-space-glyph vs kern-gap emission — char_width's default is a
        width, not an existence claim)."""
        return ch in self._uni2code

    # -- widths ------------------------------------------------------------
    def char_width(self, ch: str) -> float:
        code = self._uni2code.get(ch)
        if code is None:
            return self._default_width
        return self._widths.get(code, self._default_width)

    def text_width(self, text: str) -> float:
        """Sum of glyph advances in 1000/em units (no size/Tz/Tc applied —
        the walker composes those). Longest-match like encode(): a
        matched sequence consumes its LIGATURE code's width, not the sum
        of its chars' widths."""
        total = 0.0
        i = 0
        while i < len(text):
            seq = self._sequence_at(text, i)
            if seq is not None:
                total += self._widths.get(self._sequences[seq], self._default_width)
                i += len(seq)
            else:
                total += self.char_width(text[i])
                i += 1
        return total

    def decoded_width(self, data: bytes) -> float:
        """Advance of already-encoded bytes — by CODE, so it works even for
        codes with no unicode mapping."""
        total = 0.0
        for code, _n in self.codes(data):
            total += self._widths.get(code, self._default_width)
        return total

    def measures(self, data: bytes) -> bool:
        """True when `decoded_width(data)` is DECLARED rather than defaulted
        Redaction asks this before trusting a width: the placeholder
        default is 0.5 em, which is exactly the estimate whose narrowness left
        the tail of every monospace line unprotected. A composite font's /DW is
        a real declaration and answers for every code its /W omits; a simple
        font's placeholder answers for none."""
        if self._default_declared:
            return True
        if not self._widths:
            return False
        return all(code in self._widths for code, _n in self.codes(data))


def _refused(
    reason: str,
    code_bytes: int = 1,
    widths: Optional[dict[int, float]] = None,
    default_width: float = DEFAULT_WIDTH,
    default_declared: bool = False,
    writes_vertical: bool = False,
    reader_limit: bool = False,
    diagnostic: Optional[str] = None,
) -> FontCapability:
    """A non-editable capability. `code_bytes` must still be RIGHT (2 for
    composite fonts): the run LISTER measures refused runs' widths for
    their locked overlays, and 1-byte iteration over 2-byte CIDs doubled
    every refused-Type0 rect (review-measured).

    The WIDTHS are right too wherever the document declares them.
    Whether text can be DECODED and how wide it is are independent questions —
    /Widths and /W//DW state the advance of every code regardless of whether
    any /ToUnicode names it — and throwing them away meant every refused run
    measured at the 0.5 em placeholder. For redaction that is the same false
    negative the flat estimate was (narrow) or its over-removing mirror
    (2× on an Identity-H subset of Latin glyphs). Callers pass them wherever
    the codespace is known; where it is not, the placeholder stands and the
    caller falls wide."""
    return FontCapability(
        False,
        reason,
        {},
        {},
        widths or {},
        default_width,
        code_bytes,
        default_declared=default_declared,
        writes_vertical=writes_vertical,
        reader_limit=reader_limit,
        diagnostic=diagnostic,
    )


def _reverse(code2uni: dict[int, str]) -> dict[str, int]:
    """unicode → code; single-char values only (multi-char decode strings
    ride the ligature table instead — this floor stays byte-identical);
    collisions keep the LOWEST code (deterministic)."""
    uni2code: dict[str, int] = {}
    for code in sorted(code2uni.keys()):
        u = code2uni[code]
        if len(u) == 1 and u not in uni2code:
            uni2code[u] = code
    return uni2code


def _ligatures(code2uni: dict[int, str], encode_map: dict[int, str]) -> dict[str, int]:
    """sequence → code: multi-char decode strings (len 2..4) whose
    inverse is UNAMBIGUOUS — exactly one code in the full DECODE map
    produces the string; two codes = excluded, never guess — and whose code
    survives the same subset-/Widths encode guard as single chars
    (`encode_map` is the guarded map; an out-of-range ligature code must
    not encode, though its bytes still decode). Round-trip only, never
    synthesis: text encodes via a ligature exactly when the document's own
    font already encodes that sequence as one code."""
    by_seq: dict[str, list[int]] = {}
    for code, u in code2uni.items():
        if 2 <= len(u) <= 4:
            by_seq.setdefault(u, []).append(code)
    return {
        u: codes[0]
        for u, codes in by_seq.items()
        if len(codes) == 1 and codes[0] in encode_map
    }


def _parse_tounicode(raw: bytes) -> dict[int, str]:
    umap = FileUnicodeMap()
    try:
        CMapParser(umap, BytesIO(raw)).run()
    except Exception:
        return {}
    return dict(umap.cid2unichr)


def _simple_encoding_map(font_obj) -> Optional[dict[int, str]]:
    """code → unicode for a simple font's /Encoding (name, or dict with
    /BaseEncoding + /Differences), or None when unresolvable."""
    enc = font_obj.get("/Encoding")
    base = "StandardEncoding"
    differences = None
    if enc is None:
        # No /Encoding: non-symbolic fonts default to Standard; symbolic
        # fonts use the font program's builtin, which we cannot read here.
        flags = 0
        desc = font_obj.get("/FontDescriptor")
        if desc is not None:
            try:
                flags = int(desc.get("/Flags", 0))
            except (TypeError, ValueError):
                flags = 0
        if flags & 4:  # Symbolic
            return None
    else:
        try:
            # REAL type check: every pikepdf Object `hasattr('keys')` (the
            # method exists class-wide and raises for non-dicts), so duck
            # typing routes a plain /WinAnsiEncoding Name into the dict
            # branch and silently falls back to StandardEncoding.
            if isinstance(enc, pikepdf.Dictionary):
                be = enc.get("/BaseEncoding")
                if be is not None:
                    base = str(be).lstrip("/")
                diffs = enc.get("/Differences")
                if diffs is not None:
                    differences = []
                    for el in diffs:
                        try:
                            differences.append(int(el))
                        except (TypeError, ValueError):
                            # Glyph names MUST be PSLiteral for pdfminer —
                            # plain strings are silently skipped.
                            differences.append(LIT(str(el).lstrip("/")))
            else:
                base = str(enc).lstrip("/")
        except (TypeError, ValueError):
            return None
    try:
        return dict(EncodingDB.get_encoding(base, differences))
    except Exception:
        return None


def _hmtx_code_widths(tt, code2glyph: dict[int, str]) -> dict[int, float]:
    """hmtx advances × (1000/unitsPerEm), keyed by the derived codes."""
    try:
        hmtx = tt["hmtx"]
        upem = int(tt["head"].unitsPerEm)
    except Exception:
        return {}
    if upem <= 0:
        return {}
    scale = 1000.0 / upem
    out: dict[int, float] = {}
    for code, glyph in code2glyph.items():
        try:
            out[code] = float(hmtx[glyph][0]) * scale
        except Exception:
            continue
    return out


def _glyph_names_to_maps(
    names_by_code: dict[int, str],
    width_of,
) -> tuple[dict[int, str], dict[int, float]]:
    """code→glyphName + a width callback → (code2uni via AGL, code2width)."""
    from fontTools import agl

    code2uni: dict[int, str] = {}
    code2width: dict[int, float] = {}
    for code, gname in names_by_code.items():
        if not gname or gname == ".notdef":
            continue
        u = agl.toUnicode(gname)
        if u:
            code2uni[code] = u
        try:
            w = width_of(gname)
        except Exception:
            w = None
        if w is not None:
            code2width[code] = float(w)
    return code2uni, code2width


def _cff_encoding_map(raw: bytes) -> tuple[dict[int, str], dict[int, float], Optional[str]]:
    """Bare-CFF FontFile3 (Type1C). The CFF carries its OWN encoding
    (code→glyph name) and every charstring encodes its advance — cffLib
    exposes both, so 'two refusals, zero justification' had a two-parser
    answer. CID-keyed CFF has no encoding and returns empty (a CID program
    in a SIMPLE font slot is malformed; the caller keeps the refusal).

    The third element states why an empty derivation is empty; it never
    changes the refusal, only records its mechanism."""
    try:
        from fontTools.cffLib import CFFFontSet
        from fontTools.pens.basePen import NullPen

        cff = CFFFontSet()
        cff.decompile(BytesIO(raw), None)
        td = cff[cff.fontNames[0]]
        if hasattr(td, "ROS"):
            # CID-keyed — no builtin encoding to honor
            return {}, {}, "the embedded CFF program is CID-keyed and carries no encoding"
        if not hasattr(td, "charset") or td.charset is None:
            # A Top DICT that omits the charset operator declares the default
            # charset, ISOAdobe — the Compact Font Format specification (Adobe
            # Technical Note #5176; NOT held in `pdfa/`, so cited second-hand
            # as a RECORDED GAP), charset operator, default 0 = ISOAdobe.
            # cffLib applies that default only when the operator is present with
            # value 0; when it is absent, reading `charset` raises, and building
            # CharStrings below would raise with it. Supply the same list cffLib
            # would, truncated to the glyph count as it truncates it.
            from fontTools.cffLib import cffISOAdobeStrings

            td.charset = list(cffISOAdobeStrings[: td.numGlyphs])
        # cffLib hands back the STRING 'StandardEncoding'/'ExpertEncoding'
        # for the predefined encodings and a 256-list only for custom ones —
        # enumerating the string mapped code 0→'S', 1→'t', … and ACCEPTED
        # the garbage (pin-caught). Expand predefined names to their lists.
        encoding = td.Encoding
        if isinstance(encoding, str):
            if encoding == "StandardEncoding":
                from fontTools.encodings.StandardEncoding import StandardEncoding

                encoding = list(StandardEncoding)
            else:
                # ExpertEncoding — ornament sets, no honest text map
                return {}, {}, f"the embedded CFF program uses {encoding}"
        charstrings = td.CharStrings
        upem = 1.0 / float(td.FontMatrix[0]) if td.FontMatrix[0] else 1000.0
    except Exception as exc:
        return {}, {}, f"the embedded CFF program will not parse ({_parser_failure(exc)})"

    def width_of(gname: str):
        if gname not in charstrings:
            return None
        cs = charstrings[gname]
        cs.draw(NullPen())  # sets .width (nominal/default applied)
        return cs.width * (1000.0 / upem)

    # Only glyphs the font actually HAS: a predefined encoding names the
    # full standard set, but claiming a char whose glyph is absent would
    # decode text the font cannot show.
    names_by_code = {
        c: n
        for c, n in enumerate(encoding)
        if n and n != ".notdef" and n in charstrings
    }
    code2uni, code2width = _glyph_names_to_maps(names_by_code, width_of)
    return code2uni, code2width, None


_T1_EEXEC = b"currentfile eexec"
#: The fixed-content portion ISO 32000-2:2020, 9.9.1, Table 125 names: 512
#: ASCII zeros (conventionally eight 64-byte lines) and `cleartomark`. The
#: clause names both, so both are written — `cleartomark` is not what bounds
#: the section for fontTools (the zero run is), but a program this reader
#: completes is completed to what the standard describes.
_T1_TRAILER = (b"0" * 64 + b"\n") * 8 + b"cleartomark\n"

#: A Type 1 font program above this is refused unparsed. It bounds the BYTES
#: read and scanned, not the interpretation — a small program can still loop or
#: allocate without limit, which `_T1_MAX_INTERP_STEPS` and `_T1_MAX_INTERP_CELLS`
#: bound instead. The format is a 256-code simple font: a full, unsubsetted text
#: face with hinting is under 200 KB and an embedded subset tens of KB. A font
#: stream is untrusted input whose compressed size bounds nothing (a 42 KB Flate
#: stream expands past 17 MB). Same shape and order of magnitude as
#: `csc.MAX_RESPONSE_BYTES`; checked after the stream's filters are decoded, as
#: `xfa` checks its own.
MAX_TYPE1_PROGRAM_BYTES = 4 * 1024 * 1024

#: A Type 1 program is a PostScript program, and t1Lib runs it on an
#: interpreter (`fontTools.misc.psLib`) that has no step or allocation limit of
#: its own: `0 0 -1 {pop} for` never returns, and `50000000 array` reaches
#: hundreds of MB, in a 700-byte font. The engine answers one request at a time
#: (`ipc.py`) with no per-request timeout, so one such font stalls every later
#: request until restart. Bytes do not bound this — the work is set by the
#: program's LOOPS, not its length — so the interpreter is bounded directly, the
#: way `document_health` bounds its own in-process walk with `_STEP_OBJECTS` and
#: `color_spaces` caps its Type 4 calculator: a wall-clock or address-space
#: limit is not portably available in-process on the shipped target, and a
#: subprocess per font is the wrong shape when the parse is already in-process.
#:
#: The budgets are FLAT, not tied to program size: a size-tied budget lets a
#: larger crafted program buy more work, and the largest real program measured
#: needs the same order of magnitude as the smallest. Calibrated against every
#: real Type 1 program on hand (max 21,091 executed steps, 147,751 allocated
#: cells): ~24x and ~54x margin. A breach refuses by name with `/Widths`
#: surviving, in bounded time — a pure loop trips in a second or two on a
#: current machine, an oversized allocation before it happens at all.
_T1_MAX_INTERP_STEPS = 500_000
#: List slots + string bytes the interpreter may allocate in one program.
#: 8M cells is about 64 MB of pointers worst case, the scale of `xfa`'s own
#: resource cap and far under the 382 MB an unbounded `array` reaches.
_T1_MAX_INTERP_CELLS = 8_000_000
#: Operand-stack depth. A loop with an empty body grows the stack without
#: allocating an array or string, so the step budget alone would let it reach
#: hundreds of MB of stacked objects before it trips; this bounds that. The
#: deepest real stack measured is 279, so 65,536 is ~235x margin.
_T1_MAX_INTERP_STACK = 65_536


class _T1InterpreterBudget(Exception):
    """A Type 1 program that outran the interpreter's step or allocation
    budget. Its message is a fixed, disclosure-free string set at the raise
    site — the caller reports it verbatim, never through `_parser_failure`."""


def _bounded_t1_interpreter():
    """A `psLib.PSInterpreter` subclass that refuses a program which executes
    more than `_T1_MAX_INTERP_STEPS` objects or allocates more than
    `_T1_MAX_INTERP_CELLS` cells. Built lazily so importing this module does
    not import `psLib`.

    Every executed object passes through `handle_object`, and every loop
    iteration through `call_procedure` (an empty-procedure `for` loop calls no
    `handle_object` at all), so both are counted. `array`/`string` allocate
    whatever count the program states, so their operand is checked before the
    allocation happens rather than after."""
    from fontTools.misc import psLib

    class _Bounded(psLib.PSInterpreter):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._steps_left = _T1_MAX_INTERP_STEPS
            self._cells_left = _T1_MAX_INTERP_CELLS

        def _tick(self):
            self._steps_left -= 1
            if self._steps_left < 0:
                raise _T1InterpreterBudget(
                    "the embedded Type 1 program exceeded the interpreter step "
                    "budget and was not parsed"
                )
            if len(self.stack) > _T1_MAX_INTERP_STACK:
                raise _T1InterpreterBudget(
                    "the embedded Type 1 program overflowed the interpreter "
                    "stack and was not parsed"
                )

        def _charge(self):
            # The operand `array`/`string` will consume, peeked before the
            # allocation. A non-integer operand is left for the base method to
            # reject as a type error.
            try:
                count = int(self.stack[-1].value)
            except (IndexError, AttributeError, TypeError, ValueError):
                return
            if count < 0 or count > self._cells_left:
                raise _T1InterpreterBudget(
                    "the embedded Type 1 program requested more interpreter "
                    "memory than allowed and was not parsed"
                )
            self._cells_left -= count

        def handle_object(self, obj):
            self._tick()
            super().handle_object(obj)

        def call_procedure(self, proc):
            self._tick()
            super().call_procedure(proc)

        def ps_array(self):
            self._charge()
            super().ps_array()

        def ps_string(self):
            self._charge()
            super().ps_string()

    return _Bounded

#: The whitespace fontTools lets interrupt the trailer's zeros (`t1Lib.EEXECEND`).
_T1_WHITESPACE = b" \t\r\n"
_T1_ZERO_RUN = b"0" * 512
_T1_ZERO_BLOCK = b"0" * 16
#: fontTools finds the end of the encrypted section with a regular expression
#: that re-scans every run of zeros SHORTER than 512 from each position in it —
#: quadratic in the run: 13 s for 4 MB of crafted 511-zero runs, against 0.04 s
#: for 4 MB of cipher text. A real encrypted section has no such runs (sixteen
#: zeros in a row are about 2^-128 likely in binary cipher text and 2^-64 in
#: hex), and a real program has at most one trailer's worth, 31 blocks when it
#: is truncated. Past this many 16-zero blocks outside whole 512-zero runs the
#: program is refused rather than scanned.
_T1_MAX_SHORT_ZERO_BLOCKS = 64


def _parse_type1_program(raw: bytes) -> tuple[dict[int, str], dict[int, float]]:
    """One t1Lib pass over a Type 1 program: its builtin encoding through the
    AGL plus charstring advances, the same way the CFF path derives them.
    RAISES on a program t1Lib cannot read — the caller decides whether that
    is final — and `_T1InterpreterBudget` on a program that loops or allocates
    past the budget.

    The dictionary parse runs on the bounded interpreter. `suckfont`
    constructs `psLib.PSInterpreter` by that module-global name, so the bound
    is installed by rebinding it for the duration of the parse and restoring it
    in `finally`; the engine is single-threaded (`ipc.py`), so the rebinding
    cannot race. The later charstring `draw` is a separate, non-looping
    interpreter (`psCharStrings`) bounded by the program's own length and
    Python's recursion limit."""
    import os
    import tempfile

    from fontTools.misc import psLib

    # t1Lib's API is path-based and `T1Font(path)` dispatches on the
    # EXTENSION: `.pfa` routes to `readOther`, which is the reader a plain
    # (non-segmented) /FontFile stream needs, so `kind` stays defaulted.
    fd, tmp = tempfile.mkstemp(suffix=".pfb" if raw[:1] == b"\x80" else ".pfa")
    original_interpreter = psLib.PSInterpreter
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        from fontTools.pens.basePen import NullPen
        from fontTools.t1Lib import T1Font

        font = T1Font(tmp)
        psLib.PSInterpreter = _bounded_t1_interpreter()
        try:
            font.parse()
        finally:
            psLib.PSInterpreter = original_interpreter
        fdict = font.font
        encoding = fdict.get("Encoding")
        charstrings = fdict.get("CharStrings", {})
        matrix = fdict.get("FontMatrix", [0.001])
        upem = 1.0 / float(matrix[0]) if matrix and matrix[0] else 1000.0
        if encoding == "StandardEncoding" or not isinstance(encoding, list):
            from fontTools.encodings.StandardEncoding import StandardEncoding

            encoding = list(StandardEncoding)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    def width_of(gname: str):
        cs = charstrings.get(gname)
        if cs is None:
            return None
        cs.draw(NullPen())
        return cs.width * (1000.0 / upem)

    names_by_code = {
        c: n
        for c, n in enumerate(encoding)
        if isinstance(n, str) and n != ".notdef" and n in charstrings
    }
    return _glyph_names_to_maps(names_by_code, width_of)


def _type1_encoding_map(
    raw: bytes,
) -> tuple[dict[int, str], dict[int, float], Optional[str]]:
    """/FontFile (Type1, PFA or PFB) → (code→unicode, code→advance, failure).

    ONE interpretation, on the one program that can succeed. ISO 32000-2:2020,
    9.9.1, Table 125 lets a Type 1 program in a PDF leave out its fixed-content
    portion — `/Length3 0` declares the 512 zeros and `cleartomark` omitted, to
    be added by the processor — but fontTools cannot bound the encrypted
    section without them. So the reader completes the program exactly when the
    zero run fontTools scans for is absent after `currentfile eexec`, and
    leaves it as embedded otherwise:
      - absent: the program as embedded CANNOT parse (`findEncryptedChunks`
        raises before interpreting anything), and the completed one can.
      - present: completing it CANNOT help — a second `cleartomark` finds no
        mark and interpretation fails — and the program as embedded can.
    The bytes answer the question `/Length3` only declares an answer to, so
    the declaration is not consulted: a `/Length3 0` on a program that kept its
    trailer, or a positive one over a truncated trailer, costs nothing. Junk a
    truncated trailer leaves behind is harmless — t1Lib keeps the cipher only
    up to the decrypted `currentfile closefile` and resumes at the zero run.
    /Length1 and /Length2 are not used to cut the program either: eexec is a
    stream cipher, so a cut before `closefile` fails and a cut after it is
    byte-identical to the whole stream.

    A PFB-segmented program (`0x80` magic) is read by its segment headers, not
    by the zero-run scan, so it is never completed; nor is a program with no
    `currentfile eexec`, which has no section to close.

    The trailer is appended with no separator. A separator is never required —
    `EEXECEND` matches the zero run wherever it starts — and appending one is
    strictly less robust: a program whose final cipher byte is `0x30` and which
    was cut exactly at the zero run (a corrupted `/Length3 0` embedding) then
    parses only without the separator, and nothing on the corpus parses only
    with it.

    Work is bounded for untrusted bytes at every stage: `MAX_TYPE1_PROGRAM_BYTES`
    on the bytes, the zero-run screen before fontTools' quadratic scan, and
    `_T1_MAX_INTERP_STEPS`/`_T1_MAX_INTERP_CELLS` on the interpretation itself.

    A program that fails states WHY in the third element — whether it was
    completed, and the failure named through `_parser_failure`, which carries
    no document bytes — instead of an empty derivation indistinguishable from
    a font that genuinely declares no encoding. A parse that SUCCEEDS but names
    no character (a subset whose glyph names are outside the AGL) says so too,
    so it is not mistaken for the absence of a program."""
    if len(raw) > MAX_TYPE1_PROGRAM_BYTES:
        return {}, {}, (
            "the embedded Type 1 program is larger than "
            f"{MAX_TYPE1_PROGRAM_BYTES} bytes and was not parsed"
        )
    completed = False
    marker = raw.find(_T1_EEXEC)
    if raw[:1] != b"\x80" and marker >= 0:
        # Exactly what t1Lib scans — everything after the marker and the one
        # byte ending its line — with the whitespace its pattern skips removed.
        # Transient: released before the program is parsed.
        section = raw[marker + len(_T1_EEXEC) + 1:].translate(None, _T1_WHITESPACE)
        # A 512-run holds exactly 32 blocks, so this counts the blocks of the
        # runs that fall short of it: the only ones the scan re-reads from
        # every position.
        short_blocks = section.count(_T1_ZERO_BLOCK) - (
            len(_T1_ZERO_RUN) // len(_T1_ZERO_BLOCK)
        ) * section.count(_T1_ZERO_RUN)
        if short_blocks > _T1_MAX_SHORT_ZERO_BLOCKS:
            return {}, {}, (
                "the embedded Type 1 program was not parsed: its encrypted "
                "section holds zero runs no encrypted section has"
            )
        completed = _T1_ZERO_RUN not in section
        del section
    program = raw + _T1_TRAILER if completed else raw
    try:
        code2uni, code2width = _parse_type1_program(program)
    except _T1InterpreterBudget as exc:
        return {}, {}, str(exc)
    except Exception as exc:
        how = " once completed" if completed else ""
        return {}, {}, (
            f"the embedded Type 1 program will not parse{how} "
            f"({_parser_failure(exc)})"
        )
    if not code2uni:
        return {}, {}, (
            "the embedded Type 1 program parsed but names no character "
            "the Adobe Glyph List maps"
        )
    return code2uni, code2width, None


def _program_encoding_map(
    font_obj,
) -> tuple[dict[int, str], dict[int, float], Optional[str]]:
    """code → unicode + code → advance (1000/em) derived from the embedded
    font program — the last resort for a symbolic
    simple font with no usable /Encoding and no ToUnicode. FontFile2 and
    SFNT-wrapped FontFile3 (/OpenType) parse via fontTools' TTFont; bare-CFF
    FontFile3 (Type1C) falls through to cffLib's builtin encoding +
    charstring widths, and /FontFile (Type1 PFA/PFB) to t1Lib's — both were
    once refusals.
    TTFont subtable preference (first that derives any unicode wins):
      (3,1) Windows-Unicode — code c maps to chr(c) when c is in the cmap;
      (3,0) Windows-Symbol  — glyph at 0xF000+c (or bare c), then the glyph
            NAME through the AGL (uniXXXX/uXXXX forms included);
      (1,0) Mac             — glyph at c, same name derivation.
    Codes with no derivable unicode stay unmapped (decode → U+FFFD, encode
    refuses); widths still cover every code resolving to a real glyph, since
    decoded_width keys on CODES. An EMPTY derivation returns ({}, {}) — the
    caller must keep refusing rather than accept garbage decoding — and the
    third element states why it is empty, which is reported, never acted on."""
    try:
        desc = font_obj.get("/FontDescriptor")
        if desc is None:
            return {}, {}, None
        program = desc.get("/FontFile2")
        kind = "sfnt"
        if program is None:
            program = desc.get("/FontFile3")
        if program is None:
            program = desc.get("/FontFile")
            kind = "type1" if program is not None else kind
        if program is None:
            return {}, {}, None
        raw = program.read_bytes()
    except Exception as exc:
        return {}, {}, f"the embedded font program will not read ({_parser_failure(exc)})"
    if kind == "type1":
        return _type1_encoding_map(raw)
    try:
        from fontTools.ttLib import TTFont

        tt = TTFont(BytesIO(raw), fontNumber=0, lazy=True)
        subtables = list(tt["cmap"].tables)
    except Exception:
        # Not an SFNT: a FontFile3 that TTFont rejects is bare CFF.
        return _cff_encoding_map(raw)
    from fontTools import agl

    by_key: dict[tuple[int, int], dict[int, str]] = {}
    for t in subtables:
        key = (getattr(t, "platformID", None), getattr(t, "platEncID", None))
        if key not in ((3, 1), (3, 0), (1, 0)) or key in by_key:
            continue
        try:
            m = dict(t.cmap)
        except Exception:
            continue
        if m:
            by_key[key] = m
    for key in ((3, 1), (3, 0), (1, 0)):
        m = by_key.get(key)
        if m is None:
            continue
        code2uni: dict[int, str] = {}
        code2glyph: dict[int, str] = {}
        for code in range(256):
            if key == (3, 1):
                glyph = m.get(code)
                if glyph is None or glyph == ".notdef":
                    continue
                code2glyph[code] = glyph
                code2uni[code] = chr(code)
                continue
            glyph = m.get(0xF000 + code) if key == (3, 0) else None
            if glyph is None:
                glyph = m.get(code)
            if glyph is None or glyph == ".notdef":
                continue
            code2glyph[code] = glyph
            u = agl.toUnicode(glyph)
            if u:
                code2uni[code] = u
        if code2uni:
            return code2uni, _hmtx_code_widths(tt, code2glyph), None
    return {}, {}, (
        "no cmap subtable of the embedded program names a character"
        if by_key
        else "the embedded program carries no readable cmap subtable"
    )


def _declared_simple_widths(font_obj) -> dict[int, float]:
    """code → advance straight from /Widths + /FirstChar. Needs no encoding,
    so it is readable even for a font whose text cannot be decoded."""
    widths: dict[int, float] = {}
    w = font_obj.get("/Widths")
    if w is None:
        return widths
    try:
        first = int(font_obj.get("/FirstChar", 0))
        for offset, val in enumerate(w):
            try:
                widths[first + offset] = float(val)
            except (TypeError, ValueError):
                continue
    except (TypeError, ValueError):
        return {}
    return widths


def _simple_widths(font_obj, code2uni: dict[int, str]) -> tuple[dict[int, float], float]:
    """code → advance for a simple font: /Widths + /FirstChar, else base-14
    AFM metrics via /BaseFont (AFM widths are keyed by unicode CHAR)."""
    widths = _declared_simple_widths(font_obj)
    if widths:
        return widths, DEFAULT_WIDTH
    base = _strip_subset_prefix(str(font_obj.get("/BaseFont", "")).lstrip("/"))
    metrics = FONT_METRICS.get(base)
    if metrics is not None:
        _props, char_widths = metrics
        for code, u in code2uni.items():
            cw = char_widths.get(u)
            if cw is not None:
                widths[code] = float(cw)
        return widths, DEFAULT_WIDTH
    return {}, DEFAULT_WIDTH


def _cmap_code_widths(named_cmap, codes, cid_widths: dict[int, float]) -> dict[int, float]:
    """Remap CID-keyed /W to CODE-keyed for a predefined CMap:
    each code decodes to a CID via the CMap, whose /W width becomes the
    code's. A code the CMap can't decode is left to the capability's default
    width — text still edits, only its same-line Δ is approximate for that
    glyph.

    The code's BYTE LENGTH comes from the CMap's own trie rather
    than being assumed to be 2. Assuming 2 silently dropped every one-byte
    code of a legacy CJK encoding (the ASCII half of Shift-JIS, EUC and
    Big5) to the default width, and every code longer than two of a UTF-8
    or UTF-32 one."""
    lengths = _code_lengths(getattr(named_cmap, "code2cid", None) or {})
    out: dict[int, float] = {}
    for code in codes:
        try:
            n = lengths.get(int(code), 2)
            data = int(code).to_bytes(n, "big")
        except (OverflowError, ValueError, TypeError):
            continue  # malformed — DW applies
        try:
            cids = list(named_cmap.decode(data))
        except Exception:
            cids = []
        if cids:
            w = cid_widths.get(cids[0])
            if w is not None:
                out[code] = w
    return out


def _cid_to_unicode_map(font_obj, vertical: bool) -> dict[int, str]:
    """CID→Unicode WITHOUT a /ToUnicode, via two honest routes:

    1. The CID system's REGISTRY map: a /CIDSystemInfo naming a known
       ordering (Adobe-Japan1, Adobe-GB1, …) has a published CID→Unicode
       table, bundled with pdfminer (`CMapDB.get_unicode_map`). This is the
       same information a /ToUnicode for that ordering would encode.
    2. The embedded font PROGRAM's own cmap table, reversed — the simple-font
       derivation applied to composite fonts. For Adobe-Identity-0 subsets
       (the modern majority) the registry says nothing, but the TrueType/
       OpenType program still maps unicode→glyph; inverted through
       /CIDToGIDMap that is CID→unicode.

    Returns {} when neither route yields anything — the caller keeps the
    honest refusal.
    """
    desc_fonts = font_obj.get("/DescendantFonts")
    if desc_fonts is None or len(desc_fonts) == 0:
        return {}
    desc = desc_fonts[0]

    # Route 1: registry ordering.
    csi = desc.get("/CIDSystemInfo")
    if csi is not None:
        try:
            registry = str(csi.get("/Registry", ""))
            ordering = str(csi.get("/Ordering", ""))
        except Exception:
            registry = ordering = ""
        if registry and ordering and ordering != "Identity":
            try:
                from pdfminer.cmapdb import CMapDB

                um = CMapDB.get_unicode_map(f"{registry}-{ordering}", vertical)
            except Exception:
                um = None
            if um is not None:
                out: dict[int, str] = {}
                # The registry maps are dense; enumerate the 2-byte CID space
                # once (fast — dict lookups) and keep what resolves.
                for cid in range(0x10000):
                    try:
                        ch = um.get_unichr(cid)
                    except Exception:
                        continue
                    if ch:
                        out[cid] = ch
                if out:
                    return out

    # Route 2: reverse the embedded program's cmap through /CIDToGIDMap.
    fd = desc.get("/FontDescriptor")
    if fd is None:
        return {}
    program = fd.get("/FontFile2") or fd.get("/FontFile3")
    if program is None:
        return {}
    try:
        from fontTools.ttLib import TTFont

        tt = TTFont(BytesIO(program.read_bytes()), fontNumber=0, lazy=True)
        best = tt.getBestCmap()  # {codepoint: glyphName}
    except Exception:
        return {}
    gid2uni: dict[int, str] = {}
    for cp, gname in best.items():
        try:
            gid = tt.getGlyphID(gname)
        except Exception:
            continue
        # First mapping wins — a glyph reachable from several codepoints
        # (case pairs via GSUB never appear in cmap, so ties are rare).
        gid2uni.setdefault(gid, chr(cp))
    if not gid2uni:
        return {}
    c2g = desc.get("/CIDToGIDMap")
    if c2g is None or (not isinstance(c2g, pikepdf.Stream) and str(c2g) == "/Identity"):
        return dict(gid2uni)  # CID == GID
    if isinstance(c2g, pikepdf.Stream):
        try:
            table = c2g.read_bytes()
        except Exception:
            return {}
        out = {}
        for cid in range(len(table) // 2):
            gid = (table[2 * cid] << 8) | table[2 * cid + 1]
            ch = gid2uni.get(gid)
            if ch and gid != 0:
                out.setdefault(cid, ch)
        return out
    return {}


def _plain(el):
    # Numbers FIRST (pdfminer's get_widths/get_widths2 want real ints for
    # CID starts), then arrays; pikepdf's universal Object surface defeats
    # hasattr-based duck typing (same trap as the encoding branch).
    try:
        f = float(el)
        return int(f) if f.is_integer() else f
    except (TypeError, ValueError):
        pass
    try:
        return [_plain(x) for x in el]
    except TypeError:
        return el


def _cid_widths(descendant) -> tuple[dict[int, float], float]:
    from pdfminer.pdffont import get_widths

    default = 1000.0
    try:
        dw = descendant.get("/DW")
        if dw is not None:
            default = float(dw)
    except (TypeError, ValueError):
        pass
    w = descendant.get("/W")
    if w is None:
        return {}, default
    try:
        parsed = get_widths(_plain(list(w)))
        return {int(k): float(v) for k, v in parsed.items()}, default
    except Exception:
        return {}, default


def _cid_vertical_advances(descendant) -> tuple[dict[int, float], float]:
    """CID → |w1y| vertical advance (1000/em) from /W2 (both spec forms:
    `c [w1y vx vy …]` triplets and `cfirst clast w1y vx vy` — pdfminer's
    get_widths2 parses both), default from /DW2 (spec default [880 -1000] →
    advance 1000). Magnitudes only — the walker applies the downward
    direction; the vx/vy position vectors are approximated by the v1 rect
    (vx = w/2 centering), not stored."""
    from pdfminer.pdffont import get_widths2

    default = 1000.0
    try:
        dw2 = descendant.get("/DW2")
        if dw2 is not None and len(dw2) >= 2:
            default = abs(float(dw2[1]))
    except (TypeError, ValueError):
        pass
    w2 = descendant.get("/W2")
    if w2 is None:
        return {}, default
    try:
        parsed = get_widths2(_plain(list(w2)))
        return {int(k): abs(float(v[0])) for k, v in parsed.items()}, default
    except Exception:
        return {}, default


def font_capability(font_obj) -> FontCapability:
    """Build the capability for a pikepdf font dictionary."""
    subtype = str(font_obj.get("/Subtype", "")).lstrip("/")

    if subtype == "Type3":
        # The GLYPHS are procedures (the renderer's concern — pdf.js
        # runs them), but the TEXT MODEL is a simple font's: /Encoding
        # names the codes and /Widths the advances. Two Type3-specific
        # rules: widths live in GLYPH SPACE, so /FontMatrix scales them to
        # text space (×1000 for the per-mille convention every other width
        # here uses), and a base-less /Differences encoding maps ONLY the
        # codes it lists — falling back to StandardEncoding for the rest
        # would claim characters the font never defined.
        enc = font_obj.get("/Encoding")
        base_less_diffs = None
        if isinstance(enc, pikepdf.Dictionary) and enc.get("/BaseEncoding") is None:
            base_less_diffs = enc.get("/Differences")
        if base_less_diffs is not None:
            # Build STRICTLY from the Differences names: pdfminer's merge
            # keeps the Standard-base value when a name fails to resolve
            # (probe-caught — /qqz1 at 65 came back as 'A'), which would
            # claim characters the font never defined.
            from pdfminer.encodingdb import name2unicode

            code2uni = {}
            code = 0
            for el in base_less_diffs:
                try:
                    code = int(el)
                    continue
                except (TypeError, ValueError):
                    pass
                try:
                    code2uni[code] = name2unicode(str(el).lstrip("/"))
                except Exception:
                    pass
                code += 1
        else:
            code2uni = _simple_encoding_map(font_obj) or {}
        if not code2uni:
            tou3 = font_obj.get("/ToUnicode")
            if tou3 is not None:
                try:
                    code2uni = _parse_tounicode(tou3.read_bytes())
                except Exception:
                    code2uni = {}
        if not code2uni:
            return _refused("Type3 font with no resolvable encoding")
        try:
            matrix = [float(x) for x in font_obj.get("/FontMatrix")]
            t3_scale = matrix[0] * 1000.0
        except Exception:
            return _refused("Type3 font with a malformed /FontMatrix")
        if t3_scale <= 0:
            return _refused("Type3 font with a degenerate /FontMatrix")
        widths, default = _simple_widths(font_obj, code2uni)
        widths = {c: w * t3_scale for c, w in widths.items()}
        return FontCapability(
            True,
            None,
            code2uni,
            _reverse(code2uni),
            widths,
            default * t3_scale,
            1,
            sequences=_ligatures(code2uni, code2uni),
        )

    if subtype == "Type0":
        # /Encoding is a NAME or a CMap STREAM (ISO 32000-2, 9.7.5.1). Only a
        # name has a name; `str()` of a stream is its object repr, which is
        # unbounded, carries the CMap dictionary's contents, and reaches the
        # user through the refusal reason below. A stream therefore yields the
        # empty name, so the refusal says "embedded CMap" as it was written to.
        _encoding = font_obj.get("/Encoding")
        enc = (
            ""
            if _encoding is None or isinstance(_encoding, pikepdf.Stream)
            else str(_encoding).lstrip("/")
        )
        # Identity-H (code == CID) OR a predefined UNICODE horizontal CMap
        # (Uni*-H — the modern CJK majority), plus their vertical
        # twins Identity-V / Uni*-UCS2-V — same 2-byte codes, same
        # ToUnicode round-trip; only the ADVANCE AXIS differs, carried as
        # `vertical=True` + /W2//DW2 advances. The named CMap is loaded
        # via pdfminer's bundled CMap DB and used ONLY to remap widths
        # (its code->CID differs from Identity); non-Unicode legacy
        # encodings stay refused with a reason.
        named_cmap = None
        vertical = enc.endswith("-V")

        def _refuse_composite(reason: str, *, reader_limit: bool = False) -> FontCapability:
            """A composite refusal carrying whatever the document DECLARES
            Under Identity-H/V the byte code IS the CID, so /W (or
            /W2) is code-keyed as it stands and /DW answers for the rest —
            real advances, available with no /ToUnicode in sight. Under a
            named CMap the codes would have to be remapped through the whole
            trie to be code-keyed, which is neither cheap nor needed here, so
            only the WRITING MODE and the 2-byte codespace ride along and a
            measuring caller falls wide."""
            widths_r: dict[int, float] = {}
            default_r = DEFAULT_WIDTH
            declared_r = False
            descendants_r = font_obj.get("/DescendantFonts")
            if named_cmap is None and descendants_r is not None and len(descendants_r) > 0:
                if vertical:
                    widths_r, default_r = _cid_vertical_advances(descendants_r[0])
                else:
                    widths_r, default_r = _cid_widths(descendants_r[0])
                declared_r = True
            return _refused(
                reason,
                code_bytes=2,
                widths=widths_r,
                default_width=default_r,
                default_declared=declared_r,
                writes_vertical=vertical,
                reader_limit=reader_limit,
            )

        if enc not in ("Identity-H", "Identity-V"):
            # ANY predefined CMap the bundled tables carry, not
            # just the -UCS2- family. UCS-2 alone was admitted because UCS-2
            # is by definition fixed 2-byte and the pipeline's fixed-2-byte
            # walk was exact for it; UTF-8 is 3 bytes for CJK, UTF-32 is 4,
            # UTF-16 uses surrogate pairs, and the legacy CJK encodings
            # (Shift-JIS/EUC/Big5/GBK) mix 1 and 2 — all of which the fixed
            # walk SILENTLY CORRUPTED (dropped/injected characters on decode,
            # truncated codes on encode). The pipeline now reads the CMap's
            # own code→CID TRIE, which is the authoritative statement of
            # where each code begins, so the width of a code stopped being
            # something this gate has to promise. What remains refused is a
            # CMap the tables do not carry (an embedded CMap stream), which
            # is an absence, not a width.
            try:
                from pdfminer.cmapdb import CMapDB

                cm = CMapDB.get_cmap(enc) if enc else None
            except Exception:
                cm = None
            # The loaded CMap's own writing mode must AGREE with
            # the name's -H/-V suffix (a disagreement is malformed) —
            # for -H names this is the is_vertical() gate unchanged.
            if cm is None or getattr(cm, "code2cid", None) is None:
                # The bundled CMap tables do not carry this encoding, or it is
                # an embedded CMap stream this build does not parse. The
                # document may be perfectly well formed; we cannot read it.
                return _refuse_composite(
                    f"unsupported composite-font encoding ({enc or 'embedded CMap'})",
                    reader_limit=True,
                )
            # A writing mode that disagrees with the name's -H/-V suffix is
            # MALFORMED, so this refusal stays a statement about the document.
            if cm.is_vertical() != vertical:
                return _refuse_composite(
                    f"unsupported composite-font encoding ({enc})"
                )
            named_cmap = cm
        tou = font_obj.get("/ToUnicode")
        if tou is None:
            # Recover the mapping WITHOUT /ToUnicode — the registry's
            # published CID→Unicode table for a named ordering, else the
            # embedded program's own cmap reversed through /CIDToGIDMap
            # (the precedent applied to composite fonts). Code-keyed via
            # Identity (code == CID) or the predefined CMap's code→CID.
            cid2uni = _cid_to_unicode_map(font_obj, vertical)
            if named_cmap is None:
                code2uni = dict(cid2uni)
            else:
                code2uni = {}
                for code in range(0x10000):
                    try:
                        cids = list(named_cmap.decode(code.to_bytes(2, "big")))
                    except Exception:
                        continue
                    if cids and cids[0] in cid2uni:
                        code2uni[code] = cid2uni[cids[0]]
            if not code2uni:
                if vertical:
                    # The reason keeps naming the vertical class
                    # (the zoo pins the "vertical" substring).
                    return _refuse_composite(
                        "no ToUnicode map and no recoverable mapping — "
                        "vertical text cannot be re-entered"
                    )
                return _refuse_composite(
                    "no ToUnicode map and no recoverable mapping — "
                    "this text cannot be re-entered"
                )
        else:
            try:
                code2uni = _parse_tounicode(tou.read_bytes())
            except Exception:
                return _refuse_composite("unreadable ToUnicode map")
            if not code2uni:
                return _refuse_composite("empty ToUnicode map")
        desc_fonts = font_obj.get("/DescendantFonts")
        cid_widths: dict[int, float] = {}
        default = 1000.0
        if desc_fonts is not None and len(desc_fonts) > 0:
            # A vertical capability's widths ARE the vertical
            # advances (/W2//DW2); /W//DW stay the horizontal path's,
            # byte-identical.
            if vertical:
                cid_widths, default = _cid_vertical_advances(desc_fonts[0])
            else:
                cid_widths, default = _cid_widths(desc_fonts[0])
        if named_cmap is None:
            # Identity-H: the byte code IS the CID, so the /W table
            # (CID-keyed) doubles as code-keyed unchanged (Identity-V
            # likewise for /W2).
            widths = cid_widths
        else:
            # Named CMap: remap /W (CID-keyed) to CODE-keyed via the
            # CMap's code->CID. FontCapability.decoded_width keys on the
            # emitted CODE bytes, which are what encode() produces, so the
            # widths dict must be code-keyed to stay honest. The -V CMaps
            # carry their own code->CID (incl. vertical-variant CIDs), so
            # the same remap serves /W2.
            widths = _cmap_code_widths(named_cmap, code2uni.keys(), cid_widths)
        # No /Widths subset guard on the composite path, so the
        # ligature table's encode filter is the decode map itself.
        return FontCapability(
            True,
            None,
            code2uni,
            _reverse(code2uni),
            widths,
            default,
            2,
            sequences=_ligatures(code2uni, code2uni),
            vertical=vertical,
            # A named CMap's own code→CID trie IS the codespace.
            # Identity-H/V pass None and keep the fixed 2-byte walk exactly.
            code_trie=getattr(named_cmap, "code2cid", None) if named_cmap else None,
            # /DW (or its spec default of 1000) declares the advance of
            # every CID /W omits, so this default is measured, not guessed.
            default_declared=True,
        )

    # Simple fonts (Type1, MMType1, TrueType).
    code2uni = _simple_encoding_map(font_obj)
    tou = font_obj.get("/ToUnicode")
    tou_map: dict[int, str] = {}
    if tou is not None:
        try:
            tou_map = _parse_tounicode(tou.read_bytes())
        except Exception:
            tou_map = {}
    program_widths: dict[int, float] = {}
    if code2uni is None:
        if tou_map:
            # Symbolic font, but ToUnicode names its codes — usable both ways.
            code2uni = tou_map
        else:
            # Exactly where the refusal used to fire — derive from the
            # embedded program. ToUnicode and usable-/Encoding paths above
            # stay byte-identical; an empty derivation keeps the refusal
            # (never accept a font that would decode as garbage).
            derived, program_widths, program_failure = _program_encoding_map(font_obj)
            if not derived:
                # /Widths is code-keyed and needs no encoding, so the
                # advances survive the refusal even though the text does not.
                # The reason names the class and is matched verbatim by the
                # message catalog; `diagnostic` carries the mechanism.
                return _refused(
                    "no resolvable encoding (symbolic font without ToUnicode)",
                    widths=_declared_simple_widths(font_obj),
                    diagnostic=program_failure,
                )
            code2uni = derived
    elif tou_map:
        # ToUnicode refines decoding where present (it is authoritative for
        # extraction); encoding entries fill the rest.
        merged = dict(code2uni)
        merged.update(tou_map)
        code2uni = merged
    widths, default = _simple_widths(font_obj, code2uni)
    # Declared /Widths entries stay authoritative PER CODE; the
    # embedded program's own hmtx (1000/em-scaled, keyed by the derived
    # codes) fills every code /Widths does not cover — a wholesale
    # An either/or merge drops real program advances to the 500 default for
    # codes outside a partial /Widths range.
    if program_widths:
        widths = {**program_widths, **widths}
    # Subset-coverage guard:
    # /Encoding is a fixed 256-slot table that says nothing about which
    # glyphs an EMBEDDED SUBSET actually contains — encode() succeeding for
    # a never-subsetted character writes .notdef boxes into the output with
    # no warning anywhere. When the font declares an explicit /Widths range
    # (the subset-generator norm), restrict the ENCODE direction to codes
    # inside [FirstChar, FirstChar+len-1]; decoding stays broad (bytes
    # already in the document decode by the full table). Not airtight (a
    # generator may emit a full-range /Widths for a true subset — the
    # fontTools pass can read the real charset), but it closes the common
    # real-world shape at zero new dependencies.
    encode_map = code2uni
    w = font_obj.get("/Widths")
    # len(w) > 0: an EMPTY declared /Widths carries no subset-boundary
    # information — treating it as one inverted the range (last < first)
    # and collapsed the encodable set to nothing on a font whose glyphs
    # are all present, while char_width can silently fall to the default,
    # yielding editable=True with encodable()=="" and every advance wrong.
    # This is the silent-corruption class the completeness
    # rule forbids).
    if w is not None and len(w) > 0 and len(widths) > 0:
        try:
            first = int(font_obj.get("/FirstChar", 0))
            last = first + len(w) - 1
            encode_map = {c: u for c, u in code2uni.items() if first <= c <= last}
        except (TypeError, ValueError):
            pass
    # The ligature table takes the SAME guarded encode_map as the
    # single-char reverse — an out-of-range ligature code must not encode.
    # This covers every simple-font decode source alike (encoding map,
    # ToUnicode merge, and the program derivation, whose AGL names like
    # f_i decode multi-char).
    return FontCapability(
        True,
        None,
        code2uni,
        _reverse(encode_map),
        widths,
        default,
        1,
        sequences=_ligatures(code2uni, encode_map),
    )
