"""Glyph outlines for the fonts a page draws with.

`pdf_fonts.FontCapability` answers what a code SPELLS and how wide it is; this
answers what it LOOKS like. The two are deliberately separate: the advance a
glyph contributes is the document's declared width, while its shape is the font
program's, and a document may state a width its program disagrees with.

Contours come out in EM-NORMALIZED units — 1.0 is one em — so the caller
multiplies by the font size and nothing has to remember whether a particular
program counts in 1000ths or in 2048ths.

A font whose glyphs cannot be reached refuses BY NAME. There is no silent skip:
text that cannot be outlined is text that would vanish, and a conversion that
loses a line without saying so is worse than one that stops.
"""

from __future__ import annotations

import os
from io import BytesIO
from typing import Optional

import pikepdf

# One subpath is a list of segments; a segment is ("m"|"l", (x, y)),
# ("c", (p1, p2, p3)) or ("h",). Points are em-normalized, y up.
Segment = tuple
Contours = list[list[Segment]]

# Quadratic-to-cubic error budget, as a fraction of the em. 0.001 em is
# a thousandth of the type size — below a device pixel at any resolution a
# page is rendered or printed at.
_QU2CU_ERR_EM = 0.001


class OutlineRefusal(ValueError):
    """A font whose glyphs cannot be taken, or a stroke with no fixed width.

    A ValueError subclass so the refusal sweep enumerates it and every caller
    that already handles a bad-input refusal keeps handling this one. Each
    raise carries its whole sentence, page number included: a message composed
    from fragments has no row in the engine-message table and reaches the UI
    untranslated.
    """


def _base_font_name(font_obj) -> str:
    try:
        name = str(font_obj.get("/BaseFont", "")).lstrip("/")
    except Exception:
        name = ""
    if not name:
        return "(unnamed)"
    # Subset tags (`ABCDEF+`) name nothing a reader would recognise.
    if len(name) > 7 and name[6] == "+" and name[:6].isalpha() and name[:6].isupper():
        name = name[7:]
    return name or "(unnamed)"


def _program_stream(descriptor):
    """(bytes, kind) for the embedded program, or (None, "")."""
    if descriptor is None:
        return None, ""
    for key, kind in (("/FontFile2", "sfnt"), ("/FontFile3", "cff"), ("/FontFile", "type1")):
        try:
            program = descriptor.get(key)
        except Exception:
            program = None
        if program is None:
            continue
        try:
            return program.read_bytes(), kind
        except Exception:
            return None, kind
    return None, ""


def _descriptor_of(font_obj):
    try:
        desc = font_obj.get("/FontDescriptor")
    except Exception:
        desc = None
    if desc is not None:
        return desc
    try:
        descendants = font_obj.get("/DescendantFonts")
        if descendants is not None and len(descendants) > 0:
            return descendants[0].get("/FontDescriptor")
    except Exception:
        pass
    return None


# ── the glyph program ──────────────────────────────────────────────────────


class _Program:
    """An opened font program, reduced to `outline(key)`.

    `key` is a glyph NAME for the charstring-keyed programs and a glyph ID for
    the sfnt ones; which one a caller holds is decided by the PDF font's own
    encoding, which is why the resolution and the program are separate objects.
    """

    def __init__(self, upem: float):
        self.upem = float(upem) or 1000.0
        self._cache: dict = {}

    def outline(self, key) -> Contours:
        if key in self._cache:
            return self._cache[key]
        try:
            value = self._draw(key)
        except OutlineRefusal:
            raise
        except Exception:
            value = []
        contours = _to_contours(value, self.upem)
        self._cache[key] = contours
        return contours

    def _draw(self, key):
        raise NotImplementedError


def _record(draw, glyph_set, upem: float):
    """Draw through a recording pen, decomposing components and converting
    quadratics to cubics in two passes.

    Two passes rather than one filter chain: a decomposing pen draws a
    component into ITSELF, which bypasses a quadratic filter wrapped around
    it and leaves quadratic segments in the recording. Replaying the finished
    recording through the converter cannot be bypassed that way.
    """
    from fontTools.pens.recordingPen import DecomposingRecordingPen, RecordingPen
    from fontTools.pens.qu2cuPen import Qu2CuPen

    raw = DecomposingRecordingPen(glyph_set)
    draw(raw)
    out = RecordingPen()
    converter = Qu2CuPen(out, max_err=max(_QU2CU_ERR_EM * upem, 1e-6), all_cubic=True)
    raw.replay(converter)
    return out.value


def _to_contours(value, upem: float) -> Contours:
    scale = 1.0 / (float(upem) or 1000.0)

    def P(point):
        return (float(point[0]) * scale, float(point[1]) * scale)

    contours: Contours = []
    current: list[Segment] = []
    for operator, args in value or ():
        if operator == "moveTo":
            if current:
                contours.append(current)
            current = [("m", P(args[0]))]
        elif operator == "lineTo":
            current.append(("l", P(args[0])))
        elif operator == "curveTo":
            points = [P(a) for a in args]
            # A cubic reaches the emitter with three points; a longer
            # super-BEZIER is split by the pen protocol into cubics only when
            # a filter asks for it, so an unexpected arity is a program this
            # module has not proven and must not guess at.
            if len(points) != 3:
                raise RuntimeError(
                    "A font program produced a curve segment with an unexpected "
                    "number of points."
                )
            current.append(("c", tuple(points)))
        elif operator == "qCurveTo":
            raise RuntimeError(
                "A font program produced a quadratic curve segment the outline "
                "emitter cannot place."
            )
        elif operator == "closePath":
            current.append(("h",))
            contours.append(current)
            current = []
        elif operator == "endPath":
            if current:
                contours.append(current)
            current = []
    if current:
        contours.append(current)
    return contours


class _SfntProgram(_Program):
    """TrueType or OpenType, keyed by glyph ID."""

    def __init__(self, raw: bytes):
        from fontTools.ttLib import TTFont

        self.tt = TTFont(BytesIO(raw), fontNumber=0, lazy=True)
        upem = 1000.0
        try:
            upem = float(self.tt["head"].unitsPerEm) or 1000.0
        except Exception:
            pass
        super().__init__(upem)
        self.glyph_set = self.tt.getGlyphSet()
        self.order = self.tt.getGlyphOrder()

    def name_for_gid(self, gid: int) -> Optional[str]:
        if 0 <= gid < len(self.order):
            return self.order[gid]
        return None

    def gid_for_name(self, name: str) -> Optional[int]:
        try:
            return self.tt.getGlyphID(name)
        except Exception:
            return None

    def best_cmap(self):
        try:
            return self.tt.getBestCmap()
        except Exception:
            return {}

    def cmap_tables(self) -> dict:
        out: dict[tuple, dict] = {}
        try:
            tables = list(self.tt["cmap"].tables)
        except Exception:
            return out
        for table in tables:
            key = (getattr(table, "platformID", None), getattr(table, "platEncID", None))
            if key in out:
                continue
            try:
                out[key] = dict(table.cmap)
            except Exception:
                continue
        return out

    def _draw(self, key):
        name = self.name_for_gid(key) if isinstance(key, int) else key
        if name is None or name not in self.glyph_set:
            return []
        return _record(self.glyph_set[name].draw, self.glyph_set, self.upem)


class _CffProgram(_Program):
    """Bare CFF (Type1C), keyed by glyph name — or, when the CFF is CID-keyed,
    by CID through its charset."""

    def __init__(self, raw: bytes):
        from fontTools.cffLib import CFFFontSet

        cff = CFFFontSet()
        cff.decompile(BytesIO(raw), None)
        self.top = cff[cff.fontNames[0]]
        matrix = list(self.top.FontMatrix)
        upem = 1.0 / matrix[0] if matrix and matrix[0] else 1000.0
        super().__init__(upem)
        self.charstrings = self.top.CharStrings
        self.is_cid = hasattr(self.top, "ROS")
        self.by_cid: dict[int, str] = {}
        if self.is_cid:
            # A CID-keyed CFF's charset IS the CID→glyph-name table, in glyph
            # order. `cidXXXXX` names are conventional but not guaranteed, so
            # the charset is read rather than the name parsed.
            try:
                for gid, name in enumerate(self.top.charset):
                    cid = gid
                    if name.startswith("cid"):
                        try:
                            cid = int(name[3:])
                        except ValueError:
                            cid = gid
                    self.by_cid[cid] = name
            except Exception:
                self.by_cid = {}

    def builtin_encoding(self) -> dict[int, str]:
        try:
            encoding = self.top.Encoding
        except Exception:
            return {}
        if isinstance(encoding, str):
            if encoding != "StandardEncoding":
                return {}
            from fontTools.encodings.StandardEncoding import StandardEncoding

            encoding = list(StandardEncoding)
        out: dict[int, str] = {}
        for code, name in enumerate(encoding):
            if name and name != ".notdef" and name in self.charstrings:
                out[code] = name
        return out

    def name_for_cid(self, cid: int) -> Optional[str]:
        if not self.is_cid:
            return None
        return self.by_cid.get(cid)

    def _draw(self, key):
        if not isinstance(key, str) or key not in self.charstrings:
            return []
        charstring = self.charstrings[key]
        return _record(charstring.draw, self.charstrings, self.upem)


class _Type1Program(_Program):
    """A Type1 program (PFA or PFB), keyed by glyph name. `t1Lib`'s API is
    path-based, so the bytes go to a temp file the way `pdf_fonts` already
    reads their widths."""

    def __init__(self, raw: bytes):
        import tempfile

        from fontTools.t1Lib import T1Font

        handle, path = tempfile.mkstemp(suffix=".pfb" if raw[:1] == b"\x80" else ".pfa")
        try:
            with os.fdopen(handle, "wb") as sink:
                sink.write(raw)
            font = T1Font(path)
            font.parse()
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
        self.font = font.font
        self.charstrings = self.font.get("CharStrings", {})
        matrix = self.font.get("FontMatrix", [0.001])
        upem = 1.0 / matrix[0] if matrix and matrix[0] else 1000.0
        super().__init__(upem)

    def builtin_encoding(self) -> dict[int, str]:
        encoding = self.font.get("Encoding")
        if encoding == "StandardEncoding" or not isinstance(encoding, list):
            from fontTools.encodings.StandardEncoding import StandardEncoding

            encoding = list(StandardEncoding)
        return {
            code: name
            for code, name in enumerate(encoding)
            if isinstance(name, str) and name != ".notdef" and name in self.charstrings
        }

    def _draw(self, key):
        if not isinstance(key, str) or key not in self.charstrings:
            return []
        return _record(self.charstrings[key].draw, self.charstrings, self.upem)


# ── the PDF font's own encoding ────────────────────────────────────────────


def _simple_encoding_names(font_obj) -> dict[int, str]:
    """code → glyph name from /Encoding, base name plus /Differences.

    Empty when the font declares no encoding — the program's builtin one
    answers then, which is what the spec says for a symbolic font.
    """
    try:
        encoding = font_obj.get("/Encoding")
    except Exception:
        return {}
    if encoding is None:
        return {}
    base = None
    differences = None
    if isinstance(encoding, pikepdf.Dictionary):
        base = encoding.get("/BaseEncoding")
        differences = encoding.get("/Differences")
    else:
        base = encoding
    names: dict[int, str] = {}
    if base is not None:
        try:
            from pdfminer.encodingdb import EncodingDB

            table = EncodingDB.get_encoding(str(base).lstrip("/"), None)
            names.update({int(c): str(n) for c, n in dict(table).items()})
        except Exception:
            names = {}
    if differences is not None:
        code = 0
        try:
            for item in differences:
                if isinstance(item, pikepdf.Name):
                    names[code] = str(item).lstrip("/")
                    code += 1
                else:
                    code = int(item)
        except Exception:
            pass
    return names


def _standard_encoding_names() -> dict[int, str]:
    from fontTools.encodings.StandardEncoding import StandardEncoding

    return {
        code: name
        for code, name in enumerate(StandardEncoding)
        if name and name != ".notdef"
    }


def _cid_to_gid(descendant):
    """A callable CID → GID for a CIDFontType2, honouring /CIDToGIDMap."""
    try:
        mapping = descendant.get("/CIDToGIDMap")
    except Exception:
        mapping = None
    if isinstance(mapping, pikepdf.Stream):
        try:
            table = mapping.read_bytes()
        except Exception:
            table = b""

        def lookup(cid: int) -> int:
            index = 2 * cid
            if index + 1 >= len(table):
                return 0
            return (table[index] << 8) | table[index + 1]

        return lookup
    return lambda cid: cid


# ── the source ─────────────────────────────────────────────────────────────


class GlyphSource:
    """One PDF font's glyphs, addressed by the codes its text draws.

    Construction resolves the program and the encoding and raises
    `OutlineRefusal` when neither the document nor the bundled faces can supply
    a shape. `substituted` names the face when the glyphs did not come from the
    document itself.
    """

    def __init__(self, font_obj, capability, font_dir: str = "", page: int = 0):
        self.name = _base_font_name(font_obj)
        self.page = int(page)
        self.substituted: Optional[str] = None
        self._capability = capability
        self._font = font_obj
        self._resolve_cache: dict[int, object] = {}

        try:
            subtype = str(font_obj.get("/Subtype", "")).lstrip("/")
        except Exception:
            subtype = ""
        self.subtype = subtype
        if subtype == "Type3":
            page, name = self.page, self.name
            raise OutlineRefusal(
                f"Page {page} draws text in the Type 3 font {name}, whose "
                f"glyphs are content streams rather than outlines."
            )

        descriptor = _descriptor_of(font_obj)
        raw, kind = _program_stream(descriptor)
        if raw is None:
            self._build_substitute(font_dir)
            return
        try:
            self.program = _open_program(raw, kind)
        except OutlineRefusal:
            raise
        except Exception:
            page, name = self.page, self.name
            raise OutlineRefusal(
                f"Page {page} draws text in {name}, whose embedded font "
                f"program could not be read."
            ) from None
        if subtype == "Type0":
            self._build_composite(font_obj)
        else:
            self._build_simple(font_obj)

    # -- construction ------------------------------------------------------

    def _build_substitute(self, font_dir: str) -> None:
        """No program in the document. The glyphs come from the bundled face a
        reader would substitute anyway, and the substitution is REPORTED — the
        caller states it, so nothing about the output is silent."""
        from .font_fallback import classify_font_style, resolve_fallback_font, style_key

        page, name = self.page, self.name
        if not font_dir or not os.path.isdir(font_dir):
            raise OutlineRefusal(
                f"Page {page} draws text in {name}, which is not embedded in "
                f"this document and no bundled face could stand in for it."
            )
        bold, italic = classify_font_style(self._font)
        try:
            face = resolve_fallback_font(
                font_dir, original_font=self._font, style=style_key(bold, italic)
            )
            with open(face, "rb") as handle:
                self.program = _SfntProgram(handle.read())
        except Exception:
            raise OutlineRefusal(
                f"Page {page} draws text in {name}, which is not embedded in "
                f"this document and no bundled face could stand in for it."
            ) from None
        self.substituted = os.path.basename(face)
        self._mode = "substitute"
        self._cmap = self.program.best_cmap()

    def _build_simple(self, font_obj) -> None:
        self._mode = "simple"
        self._names = _simple_encoding_names(font_obj)
        if isinstance(self.program, _SfntProgram):
            self._tables = self.program.cmap_tables()
            self._symbolic = not self._names
        else:
            builtin = self.program.builtin_encoding()
            if not self._names:
                self._names = builtin
            else:
                for code, name in builtin.items():
                    self._names.setdefault(code, name)
            if not self._names:
                self._names = _standard_encoding_names()

    def _build_composite(self, font_obj) -> None:
        self._mode = "composite"
        try:
            descendants = font_obj.get("/DescendantFonts")
            descendant = descendants[0]
        except Exception:
            page, name = self.page, self.name
            raise OutlineRefusal(
                f"Page {page} draws text in {name}, whose embedded font "
                f"program could not be read."
            ) from None
        self._cid_to_gid = _cid_to_gid(descendant)
        self._vertical = str(font_obj.get("/Encoding", "")).endswith("-V")
        if self._vertical:
            self._origins = _vertical_origins(descendant)
        encoding = str(font_obj.get("/Encoding", "")).lstrip("/")
        self._named_cmap = None
        if encoding not in ("Identity-H", "Identity-V"):
            try:
                from pdfminer.cmapdb import CMapDB

                self._named_cmap = CMapDB.get_cmap(encoding) if encoding else None
            except Exception:
                self._named_cmap = None
            if self._named_cmap is None:
                page, name = self.page, self.name
                shown = encoding or "an embedded CMap"
                raise OutlineRefusal(
                    f"Page {page} draws text in {name} through the encoding "
                    f"{shown}, which this engine cannot resolve to glyphs."
                )

    # -- lookup ------------------------------------------------------------

    def _cid_for(self, code: int, data: bytes) -> int:
        if self._named_cmap is None:
            return code
        try:
            cids = list(self._named_cmap.decode(data))
        except Exception:
            cids = []
        return cids[0] if cids else 0

    def _key_for_simple(self, code: int) -> object:
        name = self._names.get(code)
        if not isinstance(self.program, _SfntProgram):
            return name if name is not None else ".notdef"
        # PDF 9.6.6.4's ladder, in its own order: a named code resolves through
        # the post table first and through the AGL and the Unicode cmap second;
        # a symbolic font resolves the raw code through the (3,0) or (1,0)
        # subtable.
        if name:
            gid = self.program.gid_for_name(name)
            if gid:
                return gid
            from fontTools import agl

            text = agl.toUnicode(name)
            if text:
                table = self._tables.get((3, 1)) or {}
                glyph = table.get(ord(text[0]))
                if glyph is not None:
                    return self.program.gid_for_name(glyph) or 0
        for key, candidates in (((3, 0), (0xF000 + code, code)), ((1, 0), (code,))):
            table = self._tables.get(key)
            if not table:
                continue
            for candidate in candidates:
                glyph = table.get(candidate)
                if glyph is not None:
                    return self.program.gid_for_name(glyph) or 0
        table = self._tables.get((3, 1)) or {}
        glyph = table.get(code)
        if glyph is not None:
            return self.program.gid_for_name(glyph) or 0
        return 0

    def _key_for_substitute(self, code: int, data: bytes) -> object:
        text = self._capability.decode(data) if self._capability is not None else ""
        text = text.replace("�", "")
        page, name = self.page, self.name
        if not text:
            raise OutlineRefusal(
                f"Page {page} draws text in {name}, and one of its codes spells "
                f"nothing a bundled face could be matched to."
            )
        glyph = self._cmap.get(ord(text[0]))
        if glyph is None:
            raise OutlineRefusal(
                f"Page {page} draws text in {name}, and no bundled face can "
                f"express one of its characters."
            )
        return self.program.gid_for_name(glyph) or 0

    def _key_for_composite(self, code: int, data: bytes) -> object:
        cid = self._cid_for(code, data)
        if isinstance(self.program, _CffProgram):
            if self.program.is_cid:
                name = self.program.name_for_cid(cid)
                return name if name is not None else ".notdef"
            # A non-CID CFF inside a composite font is glyph-ordered, so the
            # CID indexes the charset directly.
            try:
                return self.program.top.charset[cid]
            except Exception:
                return ".notdef"
        return self._cid_to_gid(cid)

    def vertical_origin(self, code: int, data: bytes) -> tuple[float, float]:
        """The glyph's vertical origin, in ems.

        Vertical writing places the glyph so this point sits at the current
        text position, which is why a vertical run cannot reuse the horizontal
        placement: the horizontal one puts the glyph's LEFT SIDEBEARING there.
        Horizontal fonts answer (0, 0), so one placement formula serves both.
        """
        if self._mode != "composite" or not getattr(self, "_vertical", False):
            return (0.0, 0.0)
        cid = self._cid_for(code, data)
        return self._origins(cid)

    def contours(self, code: int, data: bytes) -> Contours:
        """The glyph's outline, em-normalized. A code that maps to nothing
        yields the program's own `.notdef`, which is exactly what a reader
        draws for it."""
        cached = self._resolve_cache.get(code)
        if cached is None:
            if self._mode == "simple":
                cached = self._key_for_simple(code)
            elif self._mode == "substitute":
                cached = self._key_for_substitute(code, data)
            else:
                cached = self._key_for_composite(code, data)
            self._resolve_cache[code] = cached
        return self.program.outline(cached)


def _vertical_origins(descendant):
    """CID → vertical origin (v_x, v_y) in ems, from /DW2 and /W2.

    The spec's defaults are `/DW2 [880 -1000]` and a horizontal origin at half
    the glyph's own width, so a font that declares neither still places
    correctly. `/W2`'s two forms are both read: `c [w1y vx vy …]` and
    `cFirst cLast w1y vx vy`.
    """
    default_vy = 0.88
    try:
        dw2 = descendant.get("/DW2")
        if dw2 is not None:
            default_vy = float(dw2[0]) / 1000.0
    except Exception:
        pass

    widths: dict[int, float] = {}
    default_w = 1.0
    try:
        from .pdf_fonts import _cid_widths

        raw_widths, raw_default = _cid_widths(descendant)
        widths = {cid: value / 1000.0 for cid, value in raw_widths.items()}
        default_w = float(raw_default) / 1000.0
    except Exception:
        pass

    explicit: dict[int, tuple[float, float]] = {}
    try:
        table = descendant.get("/W2")
        if table is not None:
            entries = list(table)
            index = 0
            while index < len(entries):
                first = int(entries[index])
                following = entries[index + 1]
                if isinstance(following, pikepdf.Array):
                    values = [float(v) for v in following]
                    for offset in range(0, len(values) - 2, 3):
                        explicit[first + offset // 3] = (
                            values[offset + 1] / 1000.0, values[offset + 2] / 1000.0
                        )
                    index += 2
                else:
                    last = int(following)
                    vx = float(entries[index + 3]) / 1000.0
                    vy = float(entries[index + 4]) / 1000.0
                    for cid in range(first, last + 1):
                        explicit[cid] = (vx, vy)
                    index += 5
    except Exception:
        explicit = explicit

    def lookup(cid: int) -> tuple[float, float]:
        found = explicit.get(cid)
        if found is not None:
            return found
        return (widths.get(cid, default_w) / 2.0, default_vy)

    return lookup


def _open_program(raw: bytes, kind: str) -> _Program:
    if kind == "type1":
        return _Type1Program(raw)
    if kind == "sfnt":
        return _SfntProgram(raw)
    # A /FontFile3 is bare CFF unless it is an SFNT-wrapped OpenType.
    if raw[:4] in (b"OTTO", b"\x00\x01\x00\x00", b"true", b"ttcf"):
        return _SfntProgram(raw)
    return _CffProgram(raw)
