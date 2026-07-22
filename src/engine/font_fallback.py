"""Replacement-font fallback (Phase 7.4).

When a run's own font cannot express the user's text (subset without the
glyph, symbolic encoding…), the edit is re-rendered in the BUNDLED
Liberation Sans (OFL; vendored by scripts/sync-edit-fonts.ps1, resolved by
the Rust `get_edit_font_path`) — subsetted to exactly the characters used
and embedded as a Type0/Identity-H font with a generated ToUnicode CMap,
so the output stays extractable/searchable (the same capability bar the
rest of Edit Text holds).

Embedding shape (the standard modern composite-font construction):
  Type0 (Identity-H, ToUnicode)
    └ CIDFontType2 (CIDToGIDMap /Identity, /W from hmtx, FontDescriptor
      with FontFile2 = the subsetted TrueType bytes)
CID == GID by construction: text encodes as 2-byte glyph ids straight from
the subsetted font's cmap.

The run rewrite itself reuses text_runs' targeted rewriter through its
builder hook: this module only supplies "how to render the replacement" —
`/NewFont size Tf`, the GID-encoded Tj, and a Tf restoring the run's
original font so subsequent runs are untouched. Δwidth math, same-line
anchor adjustment, and form copy-on-edit are the SAME code paths 7.2
shipped and tested.
"""

import io
import os
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name

from fontTools import subset as ft_subset
from fontTools.ttLib import TTFont

# The vendored fallback family (scripts/sync-edit-fonts.ps1); the engine
# picks the face matching the run's own font so a serif document's
# converted text stays serif (Phase 9.B1), and — since 9.A3b — the face
# VARIANT matching the requested style, so a bold restyle lands on the
# real Bold face. All twelve are metric-compatible with the Microsoft
# cores.
_FACE_FILES = {
    "serif": {
        "regular": "LiberationSerif-Regular.ttf",
        "bold": "LiberationSerif-Bold.ttf",
        "italic": "LiberationSerif-Italic.ttf",
        "bolditalic": "LiberationSerif-BoldItalic.ttf",
    },
    "sans": {
        "regular": "LiberationSans-Regular.ttf",
        "bold": "LiberationSans-Bold.ttf",
        "italic": "LiberationSans-Italic.ttf",
        "bolditalic": "LiberationSans-BoldItalic.ttf",
    },
    "mono": {
        "regular": "LiberationMono-Regular.ttf",
        "bold": "LiberationMono-Bold.ttf",
        "italic": "LiberationMono-Italic.ttf",
        "bolditalic": "LiberationMono-BoldItalic.ttf",
    },
}

# 9.K2: the feature-bearing family (Libertinus Serif OTF, SIL OFL). OPT-IN
# ONLY — deliberately NOT in `_FACE_FILES`, so `classify_font_family` /
# `resolve_fallback_font`'s automatic ladder can never land here. It is
# reached solely by an explicit feature request (small caps / alternates),
# because Liberation carries none of those features and swapping a document's
# body font into Libertinus (which is NOT metric-compatible) must never
# happen silently.
_LIBERTINUS_SERIF = {
    "regular": "LibertinusSerif-Regular.otf",
    "bold": "LibertinusSerif-Bold.otf",
    "italic": "LibertinusSerif-Italic.otf",
    "bolditalic": "LibertinusSerif-BoldItalic.otf",
}

# PDF FontDescriptor /Flags bits (PDF spec Table 121, 1-based in the spec).
_FLAG_FIXED_PITCH = 1 << 0
_FLAG_SERIF = 1 << 1
_FLAG_ITALIC = 1 << 6  # "Italic" (bit 7 in the spec's 1-based numbering)
_FLAG_FORCE_BOLD = 1 << 18  # "ForceBold" (bit 19)

_SERIF_HINTS = ("times", "serif", "georgia", "garamond", "minion", "roman", "mincho", "song")
_MONO_HINTS = ("courier", "mono", "consol", "console", "typewriter", "code")
_BOLD_HINTS = ("bold", "black", "heavy", "semibold", "demibold")
_ITALIC_HINTS = ("italic", "oblique")


def _descriptors_of(font_dict) -> list:
    """The font's descriptor(s): its own, plus each descendant CIDFont's
    (Type0 keeps the descriptor there). Malformed /DescendantFonts (a
    plain dict, or an array holding an int/Null) makes `.get` raise on a
    non-dict element — a damaged/hand-built PDF this app's repair engines
    exist for. Degrade to whatever was collectable, never abort the edit
    with a raw error (review-caught in 9.B1)."""
    descriptors = []
    desc = font_dict.get("/FontDescriptor")
    if desc is not None:
        descriptors.append(desc)
    desc_fonts = font_dict.get("/DescendantFonts")
    if desc_fonts is not None:
        try:
            for d in desc_fonts:
                dd = d.get("/FontDescriptor")
                if dd is not None:
                    descriptors.append(dd)
        except (TypeError, ValueError, AttributeError):
            pass
    return descriptors


def classify_font_family(font_dict) -> str:
    """serif | sans | mono for a pikepdf font dict — from the
    FontDescriptor /Flags first (authoritative when present), then a
    BaseFont-name heuristic. Defaults to 'sans' (the common body case)."""
    flags = 0
    for d in _descriptors_of(font_dict):
        try:
            flags |= int(d.get("/Flags", 0))
        except (TypeError, ValueError, AttributeError):
            pass
    if flags & _FLAG_FIXED_PITCH:
        return "mono"
    if flags & _FLAG_SERIF:
        return "serif"

    name = str(font_dict.get("/BaseFont", "")).lstrip("/").lower()
    if any(h in name for h in _MONO_HINTS):
        return "mono"
    if any(h in name for h in _SERIF_HINTS):
        return "serif"
    return "sans"


def classify_font_style(font_dict) -> tuple[bool, bool]:
    """(bold, italic) for a pikepdf font dict — descriptor evidence
    (ForceBold flag, Italic flag, ItalicAngle) plus BaseFont-name hints
    (the workhorse in practice: real-world bold is signalled by the name,
    ForceBold is a Type1 hinting flag most producers never set). Seeds
    the 9.A3b style toggles; never authoritative for rendering."""
    bold = False
    italic = False
    for d in _descriptors_of(font_dict):
        try:
            flags = int(d.get("/Flags", 0))
        except (TypeError, ValueError, AttributeError):
            flags = 0
        if flags & _FLAG_FORCE_BOLD:
            bold = True
        if flags & _FLAG_ITALIC:
            italic = True
        try:
            if abs(float(d.get("/ItalicAngle", 0) or 0)) > 0.1:
                italic = True
        except (TypeError, ValueError, AttributeError):
            pass
    name = str(font_dict.get("/BaseFont", "")).lstrip("/").lower()
    if any(h in name for h in _BOLD_HINTS):
        bold = True
    if any(h in name for h in _ITALIC_HINTS):
        italic = True
    return bold, italic


def style_key(bold: bool, italic: bool) -> str:
    """The _FACE_FILES style key for an absolute (bold, italic) pair."""
    if bold and italic:
        return "bolditalic"
    if bold:
        return "bold"
    if italic:
        return "italic"
    return "regular"


def synthetic_family_font(family: str):
    """A minimal font dict whose classification is forced to `family` —
    the way to drive `resolve_fallback_font` when there is no original
    font to match (authoring, 9.A2) or the user picked the family
    explicitly (9.A3 restyle). serif/mono ride the /Flags bits the
    classifier reads first; anything else lands on the sans default.
    The dict is only ever classified, never embedded."""
    if family == "serif":
        flags, base = _FLAG_SERIF, "/Times"
    elif family == "mono":
        flags, base = _FLAG_FIXED_PITCH, "/Courier"
    else:
        flags, base = 32, "/Helvetica"  # non-symbolic → sans
    return Dictionary(
        Type=Name("/Font"),
        Subtype=Name("/Type1"),
        BaseFont=Name(base),
        FontDescriptor=Dictionary(Type=Name("/FontDescriptor"), Flags=flags),
    )


def resolve_fallback_font(font_path: str, original_font=None, style: str = "regular") -> str:
    """Resolve the concrete fallback .ttf to embed. `font_path` may be a
    DIRECTORY (the vendored `resources/fonts` — the real app passes this,
    and the family matching the original font is chosen) or a FILE (a
    specific face — the test/back-compat path, used verbatim). `style`
    (9.A3b: regular/bold/italic/bolditalic) picks the face variant.
    Degrade ladder: exact family+style → the family's Regular → Sans
    Regular → whatever single .ttf is present — face identity beats
    weight (a missing Bold lands on the family's Regular, never another
    family's Bold), and a partially provisioned bundle degrades instead
    of crashing."""
    if not os.path.isdir(font_path):
        return font_path
    family = classify_font_family(original_font) if original_font is not None else "sans"
    faces = _FACE_FILES[family]
    st = style if style in faces else "regular"
    for candidate_name in (faces[st], faces["regular"], _FACE_FILES["sans"]["regular"]):
        candidate = os.path.join(font_path, candidate_name)
        if os.path.isfile(candidate):
            return candidate
    for name in sorted(os.listdir(font_path)):
        if name.lower().endswith(".ttf"):
            return os.path.join(font_path, name)
    raise ValueError(f"no fallback font found in {font_path}")


def resolve_feature_font(font_path: str, style: str = "regular") -> str:
    """The bundled FEATURE-BEARING face (Libertinus Serif OTF) for `style`.
    9.K2 — opt-in only; never returned by the automatic ladder above, so it
    can't become a silent substitution of a document's body font."""
    if not os.path.isdir(font_path):
        return font_path
    st = style if style in _LIBERTINUS_SERIF else "regular"
    for name in (_LIBERTINUS_SERIF[st], _LIBERTINUS_SERIF["regular"]):
        candidate = os.path.join(font_path, name)
        if os.path.isfile(candidate):
            return candidate
    raise ValueError(f"Libertinus Serif (feature font) not found in {font_path}")


def _subset_font(font_path: str, text: str, glyphs=None) -> tuple[bytes, "TTFont"]:
    """Subset the fallback font; returns (ttf bytes, the loaded subset TTFont
    for metrics/cmap reads).

    9.K2: when `glyphs` (a set of glyph NAMES) is given, subset to those
    glyphs directly instead of by character. Feature-substituted glyphs
    (`a.sc`, a stylistic alternate) are not reachable through the cmap, so a
    text-driven subset would drop them; a glyph-driven subset keeps exactly
    what will be drawn."""
    options = ft_subset.Options()
    options.retain_gids = False
    options.name_IDs = [1, 2]  # family + subfamily are plenty
    options.notdef_outline = True
    subsetter = ft_subset.Subsetter(options=options)
    if glyphs:
        subsetter.populate(glyphs=sorted(glyphs))
    else:
        subsetter.populate(text=text or " ")
    font = TTFont(font_path)
    subsetter.subset(font)
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    return data, TTFont(io.BytesIO(data))


def _font_metrics(font: "TTFont") -> dict:
    head = font["head"]
    hhea = font["hhea"]
    os2 = font["OS/2"]
    upem = head.unitsPerEm or 1000
    scale = 1000.0 / upem

    def s(v: float) -> float:
        return round(v * scale, 2)

    try:
        cap_height = os2.sCapHeight
    except AttributeError:
        cap_height = hhea.ascent
    return {
        "bbox": [s(head.xMin), s(head.yMin), s(head.xMax), s(head.yMax)],
        "ascent": s(hhea.ascent),
        "descent": s(hhea.descent),
        "cap_height": s(cap_height),
        "scale": scale,
    }


def build_fallback_font(pdf: "pikepdf.Pdf", font_path: str, text: str, glyph_for=None):
    """Embed a subset of the fallback font for `text`. Returns
    (font_dict [indirect], encode(str)->bytes, width_1000(str)->float).

    9.K2: `glyph_for` (a `{char: glyph_name}` map from `font_features.
    resolve_glyphs`) overrides the cmap lookup so a FEATURE-substituted glyph
    (small cap, alternate) is what gets embedded and drawn. ToUnicode still
    maps back to the original character, so small-caps text stays searchable
    and re-editable as its plain letters. `glyph_for=None` keeps the shipped
    cmap-driven path byte-for-byte."""
    if not Path(font_path).is_file():
        raise ValueError(f"bundled fallback font not found: {font_path}")

    if glyph_for is not None:
        # Feature path: subset to the RESOLVED glyphs (unreachable via cmap).
        missing = [ch for ch in set(text) if not glyph_for.get(ch)]
        if missing:
            pretty = " ".join(f"'{c}'" for c in sorted(missing))
            raise ValueError(f"the fallback font cannot express {pretty}")
        want_glyphs = {glyph_for[ch] for ch in set(text)}
        ttf_bytes, font = _subset_font(font_path, text, glyphs=want_glyphs)
        glyph_of_char = {ch: glyph_for[ch] for ch in set(text)}
    else:
        ttf_bytes, font = _subset_font(font_path, text)
        # getBestCmap() is NONE when the subset kept no unicode cmap at all
        # (every requested char missing) — treat as an empty map so the
        # refusal below names the characters instead of TypeError-ing.
        cmap = font.getBestCmap() or {}
        missing = [ch for ch in set(text) if ord(ch) not in cmap]
        if missing:
            pretty = " ".join(f"'{c}'" for c in sorted(missing))
            raise ValueError(f"the fallback font cannot express {pretty}")
        glyph_of_char = {ch: cmap[ord(ch)] for ch in set(text)}

    hmtx = font["hmtx"]
    metrics = _font_metrics(font)
    scale = metrics["scale"]
    glyph_order = font.getGlyphOrder()
    gid_of = {name: i for i, name in enumerate(glyph_order)}

    used: dict[str, int] = {}  # char -> gid
    widths: dict[int, float] = {}  # gid -> width (1000/em)
    for ch in sorted(set(text)):
        glyph_name = glyph_of_char[ch]
        gid = gid_of[glyph_name]
        used[ch] = gid
        widths[gid] = round(hmtx[glyph_name][0] * scale, 2)

    def encode(s: str) -> bytes:
        out = bytearray()
        for ch in s:
            gid = used.get(ch)
            if gid is None:
                raise ValueError(f"the fallback font cannot express {ch!r}")
            out += bytes(((gid >> 8) & 0xFF, gid & 0xFF))
        return bytes(out)

    def width_1000(s: str) -> float:
        return sum(widths[used[ch]] for ch in s if ch in used)

    # Derive the embedded BaseFont from the ACTUAL face (9.B1: it may now
    # be Serif/Mono, not always Sans) — a hardcoded "LiberationSans" would
    # lie about a serif embed. "-Regular" is dropped; the "ABCDEF+" fake
    # subset tag marks it as subsetted.
    stem = Path(font_path).stem
    if stem.endswith("-Regular"):
        stem = stem[: -len("-Regular")]
    base_name = f"ABCDEF+{stem or 'FallbackFont'}"
    # 9.K2: the face may be CFF-flavoured (an .otf). That matters because the
    # OpenType FEATURES this slice exists for live only in the OTF builds of
    # some families — Libertinus ships `smcp`/`salt` in its .otf faces and
    # strips them from its .ttf ones — so a TrueType-only embedder would make
    # a small-caps toggle that silently did nothing.
    #
    # CFF outlines go in FontFile3 `/OpenType` with a CIDFontType0 descendant;
    # TrueType keeps the shipped FontFile2 + CIDFontType2 path byte-for-byte.
    is_cff = getattr(font, "sfntVersion", "") == "OTTO"
    prog = pdf.make_stream(ttf_bytes)
    if is_cff:
        prog["/Subtype"] = Name("/OpenType")
        font_file_key = "FontFile3"
    else:
        prog["/Length1"] = len(ttf_bytes)
        font_file_key = "FontFile2"

    descriptor = pdf.make_indirect(
        Dictionary(
            **{
                "Type": Name("/FontDescriptor"),
                "FontName": Name("/" + base_name),
                "Flags": 32,  # non-symbolic
                "FontBBox": Array(metrics["bbox"]),
                "ItalicAngle": 0,
                "Ascent": metrics["ascent"],
                "Descent": metrics["descent"],
                "CapHeight": metrics["cap_height"],
                "StemV": 80,
                font_file_key: prog,
            }
        )
    )
    # /W: one [gid [w]] pair per used glyph — compact enough at edit scale.
    w_array = []
    for gid in sorted(widths):
        w_array.append(gid)
        w_array.append(Array([widths[gid]]))
    descendant = pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            # CIDFontType0 = CFF outlines, CIDFontType2 = TrueType glyf.
            Subtype=Name("/CIDFontType0" if is_cff else "/CIDFontType2"),
            BaseFont=Name("/" + base_name),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
            FontDescriptor=descriptor,
            DW=1000,
            W=Array(w_array),
            # /CIDToGIDMap is defined for CIDFontType2 ONLY; for a CFF
            # descendant the CID-to-glyph mapping comes from the embedded
            # font, so emitting it here would be meaningless (and is what
            # trips strict validators).
            **({} if is_cff else {"CIDToGIDMap": Name("/Identity")}),
        )
    )

    # Real UTF-16BE per entry: an f'{ord(ch):04x}' of an astral char emits
    # FIVE nibbles — a malformed CMap hex string (review-caught, latent:
    # Liberation is BMP-only so the coverage refusal fires first, but a
    # future supplementary-plane fallback font must not ship this).
    entries = "\n".join(
        f"<{gid:04x}> <{ch.encode('utf-16-be').hex()}>"
        for ch, gid in sorted(used.items(), key=lambda kv: kv[1])
    )
    tounicode = (
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n"
        f"{len(used)} beginbfchar\n{entries}\nendbfchar\n"
        "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
    )

    font_dict = pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type0"),
            BaseFont=Name("/" + base_name),
            Encoding=Name("/Identity-H"),
            DescendantFonts=Array([descendant]),
            ToUnicode=pdf.make_stream(tounicode.encode("ascii")),
        )
    )
    return font_dict, encode, width_1000
