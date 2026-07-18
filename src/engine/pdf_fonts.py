"""Per-font round-trip capability for text editing (Phase 7.2).

For a pikepdf font dictionary, answers the four questions editing needs:
decode (bytes → unicode), encode (unicode → bytes, refusing characters the
font cannot express), the finite ENCODABLE character inventory (the live
edit-box validation set), and per-character advance widths (1000/em) for
the Δwidth anchor math.

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
  - Type0 + Identity-H + ToUnicode → editable (the copy-paste capability
    bar: text you can extract is text you can re-enter).
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
    ):
        self.editable = editable
        self.reason = reason
        self._code2uni = code2uni
        self._uni2code = uni2code
        self._widths = widths
        self._default_width = default_width
        self._code_bytes = code_bytes  # 1 (simple) or 2 (Identity-H CID)

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
    def encode(self, text: str) -> bytes:
        out = bytearray()
        for ch in text:
            code = self._uni2code.get(ch)
            if code is None:
                raise ValueError(f"font cannot encode {ch!r}")
            if self._code_bytes == 1:
                out.append(code)
            else:
                out += bytes(((code >> 8) & 0xFF, code & 0xFF))
        return bytes(out)

    def encodable(self) -> str:
        """The finite character inventory, sorted — the edit box's local
        validation set."""
        return "".join(sorted(self._uni2code.keys()))

    # -- widths ------------------------------------------------------------
    def char_width(self, ch: str) -> float:
        code = self._uni2code.get(ch)
        if code is None:
            return self._default_width
        return self._widths.get(code, self._default_width)

    def text_width(self, text: str) -> float:
        """Sum of glyph advances in 1000/em units (no size/Tz/Tc applied —
        the walker composes those)."""
        return sum(self.char_width(ch) for ch in text)

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


def _refused(reason: str) -> FontCapability:
    return FontCapability(False, reason, {}, {}, {}, DEFAULT_WIDTH, 1)


def _reverse(code2uni: dict[int, str]) -> dict[str, int]:
    """unicode → code; single-char values only (a char reachable only via a
    multi-char ligature mapping is refused — honest and rare); collisions
    keep the LOWEST code (deterministic)."""
    uni2code: dict[str, int] = {}
    for code in sorted(code2uni.keys()):
        u = code2uni[code]
        if len(u) == 1 and u not in uni2code:
            uni2code[u] = code
    return uni2code


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

    def _plain(el):
        # Numbers FIRST (pdfminer's get_widths wants real ints for CID
        # starts), then arrays; pikepdf's universal Object surface defeats
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

    try:
        parsed = get_widths(_plain(list(w)))
        return {int(k): float(v) for k, v in parsed.items()}, default
    except Exception:
        return {}, default


def font_capability(font_obj) -> FontCapability:
    """Build the capability for a pikepdf font dictionary."""
    subtype = str(font_obj.get("/Subtype", "")).lstrip("/")

    if subtype == "Type3":
        return _refused("Type3 fonts (glyph procedures) are not editable")

    if subtype == "Type0":
        enc = str(font_obj.get("/Encoding", "")).lstrip("/")
        if enc not in ("Identity-H",):
            return _refused(f"unsupported composite-font encoding ({enc or 'embedded CMap'})")
        tou = font_obj.get("/ToUnicode")
        if tou is None:
            return _refused("no ToUnicode map — this text cannot be re-entered")
        try:
            code2uni = _parse_tounicode(tou.read_bytes())
        except Exception:
            return _refused("unreadable ToUnicode map")
        if not code2uni:
            return _refused("empty ToUnicode map")
        desc_fonts = font_obj.get("/DescendantFonts")
        widths: dict[int, float] = {}
        default = 1000.0
        if desc_fonts is not None and len(desc_fonts) > 0:
            widths, default = _cid_widths(desc_fonts[0])
        return FontCapability(True, None, code2uni, _reverse(code2uni), widths, default, 2)

    # Simple fonts (Type1, MMType1, TrueType).
    code2uni = _simple_encoding_map(font_obj)
    tou = font_obj.get("/ToUnicode")
    tou_map: dict[int, str] = {}
    if tou is not None:
        try:
            tou_map = _parse_tounicode(tou.read_bytes())
        except Exception:
            tou_map = {}
    if code2uni is None:
        if tou_map:
            # Symbolic font, but ToUnicode names its codes — usable both ways.
            code2uni = tou_map
        else:
            return _refused("no resolvable encoding (symbolic font without ToUnicode)")
    elif tou_map:
        # ToUnicode refines decoding where present (it is authoritative for
        # extraction); encoding entries fill the rest.
        merged = dict(code2uni)
        merged.update(tou_map)
        code2uni = merged
    widths, default = _simple_widths(font_obj, code2uni)
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
    if w is not None and len(widths) > 0:
        try:
            first = int(font_obj.get("/FirstChar", 0))
            last = first + len(w) - 1
            encode_map = {c: u for c, u in code2uni.items() if first <= c <= last}
        except (TypeError, ValueError):
            pass
    return FontCapability(True, None, code2uni, _reverse(encode_map), widths, default, 1)
