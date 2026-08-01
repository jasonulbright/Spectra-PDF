"""Per-font round-trip capability for text editing (Phase 7.2).

For a pikepdf font dictionary, answers the four questions editing needs:
decode (bytes → unicode), encode (unicode → bytes, refusing characters the
font cannot express; 9.B5 — multi-char ligature sequences with an
unambiguous inverse round-trip longest-match-first), the finite ENCODABLE
character inventory (the live edit-box validation set; sequences are the
additive `encodable_sequences()` layer on top of that single-char floor),
and per-character advance widths (1000/em) for the Δwidth anchor math.

Leverages pdfminer.six's own tables and parsers (it is already the bundled
extraction engine) rather than re-deriving them — the recon-verified,
document-free subset:
  - `EncodingDB.get_encoding(base, differences)` for simple-font code maps
    (Differences glyph names must be `PSLiteral` — plain strings are
    silently skipped, a recon-caught trap).
  - `CMapParser` + `FileUnicodeMap` fed the RAW ToUnicode bytes via
    BytesIO — never through `stream_value`, which silently returns an
    EMPTY map for non-PDFStream input (the other recon-caught trap).
  - `FONT_METRICS` for base-14 widths (keyed by unicode CHAR, not code).
  - `get_widths` for the CID /W array (standalone, takes a plain list).

Editability taxonomy (every run is LISTED; refusal carries the reason):
  - Simple Type1/TrueType with a resolvable encoding → editable.
  - Symbolic simple fonts without one: ToUnicode when present, else a map
    DERIVED from the embedded program's cmap + glyph names (9.B3); refused
    only when neither yields a single code.
  - Type0 + Identity-H + ToUnicode → editable (the copy-paste capability
    bar: text you can extract is text you can re-enter). Identity-V and
    Uni*-UCS2-V are their vertical twins (9.B4a): same 2-byte codes, same
    ToUnicode round-trip; the capability carries `vertical=True` and its
    widths are the /W2//DW2 VERTICAL advances (|w1y|, 1000/em) — callers
    apply the downward direction.
  - Type3 ("glyphs are procedures"), Type0 without ToUnicode or with a
    non-Identity CMap, and fonts with no resolvable encoding → refused,
    with that reason. These are the rare classes; 7.4's replacement-font
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
    ):
        self.editable = editable
        self.reason = reason
        self._code2uni = code2uni
        self._uni2code = uni2code
        self._widths = widths
        self._default_width = default_width
        self._code_bytes = code_bytes  # 1 (simple) or 2 (Identity-H CID)
        # 9.B5: multi-char sequence → its single ligature code (len 2..4,
        # unambiguous inverse, encode-guard-filtered — see _ligatures).
        # encode()/text_width() match these longest-first; encodable()/
        # can_encode stay the single-char conservative floor.
        self._sequences = sequences or {}
        # 9.B4a: vertical writing mode. When True, `widths`/`default_width`
        # ARE the vertical advances (|w1y| from /W2//DW2, 1000/em), so
        # char_width/text_width/decoded_width return the vertical advance
        # magnitude unchanged — callers apply the downward direction.
        self.vertical = vertical

    # -- decode ------------------------------------------------------------
    def decode(self, data: bytes) -> str:
        out: list[str] = []
        if self._code_bytes == 1:
            for b in data:
                out.append(self._code2uni.get(b, "�"))
        else:
            for i in range(0, len(data) - 1, 2):
                cid = (data[i] << 8) | data[i + 1]
                out.append(self._code2uni.get(cid, "�"))
        return "".join(out)

    # -- encode ------------------------------------------------------------
    def _sequence_at(self, text: str, i: int) -> Optional[str]:
        # 9.B5: the longest listed ligature sequence starting at i (4→3→2),
        # else None — the ONE matcher encode() and text_width() share, so
        # emitted bytes and measured widths can never tokenize differently.
        for n in (4, 3, 2):
            seq = text[i : i + n]
            if len(seq) == n and seq in self._sequences:
                return seq
        return None

    def encode(self, text: str) -> bytes:
        """unicode → bytes, longest-match-first (9.B5): a listed ligature
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
            if self._code_bytes == 1:
                out.append(code)
            else:
                out += bytes(((code >> 8) & 0xFF, code & 0xFF))
        return bytes(out)

    def encodable(self) -> str:
        """The finite character inventory, sorted — the edit box's local
        validation set. SINGLE-CHAR only (the conservative floor, 9.B5:
        sequences are the additive encodable_sequences() layer)."""
        return "".join(sorted(self._uni2code.keys()))

    def encodable_sequences(self) -> list[str]:
        """The multi-char sequences encode() round-trips via one unambiguous
        ligature code (9.B5), sorted — the run listing's `sequences` field."""
        return sorted(self._sequences.keys())

    def can_encode(self, ch: str) -> bool:
        """True when the font can express `ch` (7.5 uses this to decide
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
        the walker composes those). Longest-match like encode() (9.B5): a
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
        if self._code_bytes == 1:
            for b in data:
                total += self._widths.get(b, self._default_width)
        else:
            for i in range(0, len(data) - 1, 2):
                cid = (data[i] << 8) | data[i + 1]
                total += self._widths.get(cid, self._default_width)
        return total


def _refused(reason: str, code_bytes: int = 1) -> FontCapability:
    """A non-editable capability. `code_bytes` must still be RIGHT (2 for
    composite fonts): the run LISTER measures refused runs' widths for
    their locked overlays, and 1-byte iteration over 2-byte CIDs doubled
    every refused-Type0 rect (review-measured)."""
    return FontCapability(False, reason, {}, {}, {}, DEFAULT_WIDTH, code_bytes)


def _reverse(code2uni: dict[int, str]) -> dict[str, int]:
    """unicode → code; single-char values only (multi-char decode strings
    ride the 9.B5 ligature table instead — this floor stays byte-identical);
    collisions keep the LOWEST code (deterministic)."""
    uni2code: dict[str, int] = {}
    for code in sorted(code2uni.keys()):
        u = code2uni[code]
        if len(u) == 1 and u not in uni2code:
            uni2code[u] = code
    return uni2code


def _ligatures(code2uni: dict[int, str], encode_map: dict[int, str]) -> dict[str, int]:
    """sequence → code (9.B5): multi-char decode strings (len 2..4) whose
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
    """hmtx advances × (1000/unitsPerEm), keyed by the derived codes (9.B3)."""
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


def _cff_encoding_map(raw: bytes) -> tuple[dict[int, str], dict[int, float]]:
    """T9: bare-CFF FontFile3 (Type1C). The CFF carries its OWN encoding
    (code→glyph name) and every charstring encodes its advance — cffLib
    exposes both, so 'two refusals, zero justification' had a two-parser
    answer. CID-keyed CFF has no encoding and returns empty (a CID program
    in a SIMPLE font slot is malformed; the caller keeps the refusal)."""
    try:
        from fontTools.cffLib import CFFFontSet
        from fontTools.pens.basePen import NullPen

        cff = CFFFontSet()
        cff.decompile(BytesIO(raw), None)
        td = cff[cff.fontNames[0]]
        if hasattr(td, "ROS"):
            return {}, {}  # CID-keyed — no builtin encoding to honor
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
                return {}, {}  # ExpertEncoding — ornament sets, no honest text map
        charstrings = td.CharStrings
        upem = 1.0 / float(td.FontMatrix[0]) if td.FontMatrix[0] else 1000.0
    except Exception:
        return {}, {}

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
    return _glyph_names_to_maps(names_by_code, width_of)


def _type1_encoding_map(raw: bytes) -> tuple[dict[int, str], dict[int, float]]:
    """T9: /FontFile (Type1, PFA or PFB). t1Lib parses from a temp file
    (its API is path-based); the font's builtin encoding + charstring
    widths come out the same way the CFF path's do."""
    import os
    import tempfile

    fd, tmp = tempfile.mkstemp(suffix=".pfb" if raw[:1] == b"\x80" else ".pfa")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        from fontTools.pens.basePen import NullPen
        from fontTools.t1Lib import T1Font

        font = T1Font(tmp)
        font.parse()
        fdict = font.font
        encoding = fdict.get("Encoding")
        charstrings = fdict.get("CharStrings", {})
        matrix = fdict.get("FontMatrix", [0.001])
        upem = 1.0 / float(matrix[0]) if matrix and matrix[0] else 1000.0
        if encoding == "StandardEncoding" or not isinstance(encoding, list):
            from fontTools.encodings.StandardEncoding import StandardEncoding

            encoding = list(StandardEncoding)
    except Exception:
        return {}, {}
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


def _program_encoding_map(font_obj) -> tuple[dict[int, str], dict[int, float]]:
    """code → unicode + code → advance (1000/em) derived from the embedded
    font program (9.B3, widened by T9) — the last resort for a symbolic
    simple font with no usable /Encoding and no ToUnicode. FontFile2 and
    SFNT-wrapped FontFile3 (/OpenType) parse via fontTools' TTFont; bare-CFF
    FontFile3 (Type1C) falls through to cffLib's builtin encoding +
    charstring widths, and /FontFile (Type1 PFA/PFB) to t1Lib's — T9 lifted
    both former refusals.
    TTFont subtable preference (first that derives any unicode wins):
      (3,1) Windows-Unicode — code c maps to chr(c) when c is in the cmap;
      (3,0) Windows-Symbol  — glyph at 0xF000+c (or bare c), then the glyph
            NAME through the AGL (uniXXXX/uXXXX forms included);
      (1,0) Mac             — glyph at c, same name derivation.
    Codes with no derivable unicode stay unmapped (decode → U+FFFD, encode
    refuses); widths still cover every code resolving to a real glyph, since
    decoded_width keys on CODES. An EMPTY derivation returns ({}, {}) — the
    caller must keep refusing rather than accept garbage decoding."""
    try:
        desc = font_obj.get("/FontDescriptor")
        if desc is None:
            return {}, {}
        program = desc.get("/FontFile2")
        kind = "sfnt"
        if program is None:
            program = desc.get("/FontFile3")
        if program is None:
            program = desc.get("/FontFile")
            kind = "type1" if program is not None else kind
        if program is None:
            return {}, {}
        raw = program.read_bytes()
    except Exception:
        return {}, {}
    if kind == "type1":
        return _type1_encoding_map(raw)
    try:
        from fontTools.ttLib import TTFont

        tt = TTFont(BytesIO(raw), fontNumber=0, lazy=True)
        subtables = list(tt["cmap"].tables)
    except Exception:
        # Not an SFNT: a FontFile3 that TTFont rejects is bare CFF (T9).
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
            return code2uni, _hmtx_code_widths(tt, code2glyph)
    return {}, {}


def _simple_widths(font_obj, code2uni: dict[int, str]) -> tuple[dict[int, float], float]:
    """code → advance for a simple font: /Widths + /FirstChar, else base-14
    AFM metrics via /BaseFont (AFM widths are keyed by unicode CHAR)."""
    widths: dict[int, float] = {}
    w = font_obj.get("/Widths")
    if w is not None:
        try:
            first = int(font_obj.get("/FirstChar", 0))
            for offset, val in enumerate(w):
                try:
                    widths[first + offset] = float(val)
                except (TypeError, ValueError):
                    continue
        except (TypeError, ValueError):
            widths = {}
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
    """Remap CID-keyed /W to CODE-keyed for a predefined CMap (9.B2):
    each 2-byte code decodes to a CID via the CMap, whose /W width becomes
    the code's. A code the CMap can't decode (or an out-of-BMP code) is
    left to the capability's default width — text still edits, only its
    same-line Δ is approximate for that glyph."""
    out: dict[int, float] = {}
    for code in codes:
        try:
            data = int(code).to_bytes(2, "big")
        except (OverflowError, ValueError, TypeError):
            continue  # not a 2-byte code (astral / malformed) — DW applies
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
    """CID→Unicode WITHOUT a /ToUnicode (T8), via two honest routes:

    1. The CID system's REGISTRY map: a /CIDSystemInfo naming a known
       ordering (Adobe-Japan1, Adobe-GB1, …) has a published CID→Unicode
       table, bundled with pdfminer (`CMapDB.get_unicode_map`). This is the
       same information a /ToUnicode for that ordering would encode.
    2. The embedded font PROGRAM's own cmap table, reversed — the B3
       precedent applied to composite fonts. For Adobe-Identity-0 subsets
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
    advance 1000). 9.B4a: magnitudes only — the walker applies the downward
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
        # T7: the GLYPHS are procedures (the renderer's concern — pdf.js
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
        enc = str(font_obj.get("/Encoding", "")).lstrip("/")
        # Identity-H (code == CID) OR a predefined UNICODE horizontal CMap
        # (Uni*-H — the modern CJK majority; 9.B2), plus their vertical
        # twins Identity-V / Uni*-UCS2-V (9.B4a) — same 2-byte codes, same
        # ToUnicode round-trip; only the ADVANCE AXIS differs, carried as
        # `vertical=True` + /W2//DW2 advances. The named CMap is loaded
        # via pdfminer's bundled CMap DB and used ONLY to remap widths
        # (its code->CID differs from Identity); non-Unicode legacy
        # encodings stay refused with a reason.
        named_cmap = None
        vertical = enc.endswith("-V")
        if enc not in ("Identity-H", "Identity-V"):
            # ONLY the -UCS2- family: UCS-2 is by DEFINITION a fixed 2-byte
            # encoding, so our fixed-2-byte decode/encode is exact. The
            # other Uni* widths are NOT 2-byte — UTF8 is 3 bytes for CJK,
            # UTF32 is 4, UTF16 uses surrogate pairs for astral — and the
            # 2-byte pipeline SILENTLY CORRUPTS them (review-reproduced:
            # dropped/injected chars on decode, truncated codes on encode,
            # written to disk with no round-trip check). Refuse them; a
            # UTF16-BMP-only refinement is a documented tail, not B2.
            if "-UCS2-" in enc and enc.startswith("Uni"):
                try:
                    from pdfminer.cmapdb import CMapDB

                    cm = CMapDB.get_cmap(enc)
                except Exception:
                    cm = None
                # 9.B4a: the loaded CMap's own writing mode must AGREE with
                # the name's -H/-V suffix (a disagreement is malformed) —
                # for -H names this is B2's is_vertical() gate unchanged.
                if cm is None or cm.is_vertical() != vertical:
                    return _refused(
                        f"unsupported composite-font encoding ({enc})", code_bytes=2
                    )
                named_cmap = cm
            else:
                return _refused(
                    f"unsupported composite-font encoding ({enc or 'embedded CMap'})",
                    code_bytes=2,
                )
        tou = font_obj.get("/ToUnicode")
        if tou is None:
            # T8: recover the mapping WITHOUT /ToUnicode — the registry's
            # published CID→Unicode table for a named ordering, else the
            # embedded program's own cmap reversed through /CIDToGIDMap
            # (the B3 precedent applied to composite fonts). Code-keyed via
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
                    # 9.B4a: the reason keeps naming the vertical class
                    # (the zoo pins the "vertical" substring).
                    return _refused(
                        "no ToUnicode map and no recoverable mapping — "
                        "vertical text cannot be re-entered",
                        code_bytes=2,
                    )
                return _refused(
                    "no ToUnicode map and no recoverable mapping — "
                    "this text cannot be re-entered",
                    code_bytes=2,
                )
        else:
            try:
                code2uni = _parse_tounicode(tou.read_bytes())
            except Exception:
                return _refused("unreadable ToUnicode map", code_bytes=2)
            if not code2uni:
                return _refused("empty ToUnicode map", code_bytes=2)
        desc_fonts = font_obj.get("/DescendantFonts")
        cid_widths: dict[int, float] = {}
        default = 1000.0
        if desc_fonts is not None and len(desc_fonts) > 0:
            # 9.B4a: a vertical capability's widths ARE the vertical
            # advances (/W2//DW2); /W//DW stay the horizontal path's,
            # byte-identical.
            if vertical:
                cid_widths, default = _cid_vertical_advances(desc_fonts[0])
            else:
                cid_widths, default = _cid_widths(desc_fonts[0])
        if named_cmap is None:
            # Identity-H: the byte code IS the CID, so the /W table
            # (CID-keyed) doubles as code-keyed unchanged (Identity-V
            # likewise for /W2; 9.B4a).
            widths = cid_widths
        else:
            # Named CMap: remap /W (CID-keyed) to CODE-keyed via the
            # CMap's code->CID. FontCapability.decoded_width keys on the
            # emitted CODE bytes, which are what encode() produces, so the
            # widths dict must be code-keyed to stay honest. The -V CMaps
            # carry their own code->CID (incl. vertical-variant CIDs), so
            # the same remap serves /W2 (9.B4a).
            widths = _cmap_code_widths(named_cmap, code2uni.keys(), cid_widths)
        # 9.B5: no /Widths subset guard on the composite path, so the
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
            # 9.B3: exactly where the refusal used to fire — derive from the
            # embedded program. ToUnicode and usable-/Encoding paths above
            # stay byte-identical; an empty derivation keeps the refusal
            # (never accept a font that would decode as garbage).
            derived, program_widths = _program_encoding_map(font_obj)
            if not derived:
                return _refused("no resolvable encoding (symbolic font without ToUnicode)")
            code2uni = derived
    elif tou_map:
        # ToUnicode refines decoding where present (it is authoritative for
        # extraction); encoding entries fill the rest.
        merged = dict(code2uni)
        merged.update(tou_map)
        code2uni = merged
    widths, default = _simple_widths(font_obj, code2uni)
    # 9.B3: declared /Widths entries stay authoritative PER CODE; the
    # embedded program's own hmtx (1000/em-scaled, keyed by the derived
    # codes) fills every code /Widths does not cover — a wholesale
    # either/or here dropped real program advances to the 500 default for
    # any code outside a partial /Widths range (review-caught, repro'd
    # via decoded_width on an under-declared subset).
    if program_widths:
        widths = {**program_widths, **widths}
    # Subset-coverage guard (review-caught; the phase doc's stated design):
    # /Encoding is a fixed 256-slot table that says nothing about which
    # glyphs an EMBEDDED SUBSET actually contains — encode() succeeding for
    # a never-subsetted character writes .notdef boxes into the output with
    # no warning anywhere. When the font declares an explicit /Widths range
    # (the subset-generator norm), restrict the ENCODE direction to codes
    # inside [FirstChar, FirstChar+len-1]; decoding stays broad (bytes
    # already in the document decode by the full table). Not airtight (a
    # generator may emit a full-range /Widths for a true subset — 7.4's
    # fontTools pass can read the real charset), but it closes the common
    # real-world shape at zero new dependencies.
    encode_map = code2uni
    w = font_obj.get("/Widths")
    # len(w) > 0: an EMPTY declared /Widths carries no subset-boundary
    # information — treating it as one inverted the range (last < first)
    # and collapsed the encodable set to nothing on a font whose glyphs
    # are all present, while char_width silently fell to the default
    # (review-caught HIGH, repro'd: editable=True with encodable()=="" and
    # every advance wrong — the silent-corruption class the completeness
    # rule forbids).
    if w is not None and len(w) > 0 and len(widths) > 0:
        try:
            first = int(font_obj.get("/FirstChar", 0))
            last = first + len(w) - 1
            encode_map = {c: u for c, u in code2uni.items() if first <= c <= last}
        except (TypeError, ValueError):
            pass
    # 9.B5: the ligature table takes the SAME guarded encode_map as the
    # single-char reverse — an out-of-range ligature code must not encode.
    # This covers every simple-font decode source alike (encoding map,
    # ToUnicode merge, and 9.B3's program derivation, whose AGL names like
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
