"""Replacement-font fallback.

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
anchor adjustment, and form copy-on-edit are the SAME code paths the
run editor uses.
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
# converted text stays serif, and the face
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

# The feature-bearing family (Libertinus Serif OTF, SIL OFL). OPT-IN
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
    exist for. Degrade to whatever was collectable rather than aborting the
    edit with a raw error."""
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
    the style toggles; never authoritative for rendering."""
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
    font to match (authoring) or the user picked the family
    explicitly (restyle). serif/mono ride the /Flags bits the
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


# The CJK-capable faces (Noto Sans CJK SC — OFL, vendored by
# sync-edit-fonts.ps1). No CJK italic exists; the style map degrades
# italic requests to Regular exactly like a missing family face.
_CJK_FACES = {
    "regular": "NotoSansCJKsc-Regular.otf",
    "bold": "NotoSansCJKsc-Bold.otf",
    "italic": "NotoSansCJKsc-Regular.otf",
    "bolditalic": "NotoSansCJKsc-Bold.otf",
}

# The right-to-left faces (IBM Plex Sans Arabic / Noto Sans Hebrew —
# both OFL, vendored by sync-edit-fonts.ps1). Arabic is the SHAPING face: it
# carries the GSUB joining rules a document's own subset almost never keeps,
# which is why an Arabic run substitutes here rather than re-emitting per
# character. Hebrew joins nothing and is here purely for coverage — a Hebrew
# run in a font that can already draw it never comes this way. Neither
# family ships an italic; the style map degrades to Regular, the same honest
# degradation the CJK map makes.
#
# IBM Plex rather than Noto Sans Arabic, on a measured difference: Noto's
# GSUB DECOMPOSES each letter into a dotless skeleton plus separately
# positioned dots, so one character draws as several glyphs and the letter is
# spelled by the SEQUENCE — which a per-code ToUnicode cannot express, and a
# shaped edit that cannot be read back is a one-way trip. IBM Plex shapes one
# composite glyph per character, so the round trip is exact by construction.
_RTL_FACES = {
    "arabic": {
        "regular": "IBMPlexSansArabic-Regular.ttf",
        "bold": "IBMPlexSansArabic-Bold.ttf",
        "italic": "IBMPlexSansArabic-Regular.ttf",
        "bolditalic": "IBMPlexSansArabic-Bold.ttf",
    },
    "hebrew": {
        "regular": "NotoSansHebrew-Regular.ttf",
        "bold": "NotoSansHebrew-Bold.ttf",
        "italic": "NotoSansHebrew-Regular.ttf",
        "bolditalic": "NotoSansHebrew-Bold.ttf",
    },
}


# The Mongolian face (Noto Sans Mongolian — OFL-1.1, vendored by
# sync-edit-fonts.ps1). ONE face, Regular only, so the style map degrades
# exactly as the CJK map does for italic.
#
# Chosen on the SAME measurement that chose IBM Plex over Noto Sans Arabic
# (`mongolian-measure.local.py`, run against this face and against Mongolian
# Baiti as the script's reference implementation):
#   * every cluster has exactly ONE advancing glyph — ligating clusters
#     included — so a per-code /ToUnicode can spell the text back and a
#     shaped edit is not a one-way trip;
#   * no `.notdef` anywhere in the corpus, Latin and digits included (the
#     `full` build, deliberately: the `unhinted` one has NO Latin coverage,
#     and a Mongolian column with a year in it would have refused);
#   * real per-glyph horizontal advances (284–1065 per 1000/em across the
#     corpus), which is the metric the column's length comes from.
# The face is embedded HORIZONTALLY through `build_shaped_font` under a
# rotated Tm — never `build_vertical_font` under /Identity-V, because a
# Mongolian face states no vertical advance worth embedding as /W2.
_MONGOLIAN_FACES = {
    "regular": "NotoSansMongolian-Regular.ttf",
    "bold": "NotoSansMongolian-Regular.ttf",
    "italic": "NotoSansMongolian-Regular.ttf",
    "bolditalic": "NotoSansMongolian-Regular.ttf",
}


def resolve_mongolian_font(font_path: str, text: str, style: str = "regular") -> str:
    """The bundled face that can DRAW Mongolian-family `text`.

    Raises ValueError naming the text when the bundled face cannot express
    it — the signal the reflow turns into an honest refusal rather than a
    silent substitution of a script the reader cannot read."""
    from engine.shaping import face_can_shape

    if not os.path.isdir(font_path):
        return font_path
    st = style if style in _MONGOLIAN_FACES else "regular"
    for name in (_MONGOLIAN_FACES[st], _MONGOLIAN_FACES["regular"]):
        candidate = os.path.join(font_path, name)
        if not os.path.isfile(candidate):
            break
        # Coverage is not enough for a joining script: the face must produce
        # real joining forms, not `.notdef`s.
        if face_can_shape(candidate, text):
            return candidate
        break
    raise ValueError(f"no bundled Mongolian font can express {text!r}")


def resolve_rtl_font(font_path: str, text: str, style: str = "regular") -> str:
    """The bundled face that can DRAW `text` — the Arabic face when the text
    joins cursively, else whichever RTL face covers it.

    `font_path` must be the vendored fonts DIRECTORY. Raises ValueError
    naming the text when no bundled face can express it, which is the
    signal the reflow turns into an honest refusal rather than a silent
    substitution of the wrong script."""
    from engine.shaping import face_can_shape, requires_shaping

    if not os.path.isdir(font_path):
        return font_path
    st = style if style in _RTL_FACES["arabic"] else "regular"
    joining = requires_shaping(text)
    families = ("arabic", "hebrew") if joining else ("hebrew", "arabic")
    for family in families:
        for name in (_RTL_FACES[family][st], _RTL_FACES[family]["regular"]):
            candidate = os.path.join(font_path, name)
            if not os.path.isfile(candidate):
                continue
            if joining:
                # Coverage is not enough for a joining script: the face must
                # produce real joining forms, not `.notdef`s.
                if face_can_shape(candidate, text):
                    return candidate
            elif face_covers(candidate, text):
                return candidate
            break
    raise ValueError(f"no bundled right-to-left font can express {text!r}")


def face_covers(face_path: str, text: str) -> bool:
    """Whether the face's cmap maps every DRAWN character of `text`
    (structural whitespace excluded — it never embeds)."""
    needed = {ch for ch in text if ch not in ("\n", "\r", "\t")}
    if not needed:
        return True
    try:
        from fontTools.ttLib import TTFont

        tt = TTFont(str(face_path), fontNumber=0, lazy=True)
        try:
            cmap = tt.getBestCmap()
        finally:
            tt.close()
    except Exception:
        return False
    return all(ord(ch) in cmap for ch in needed)


def resolve_fallback_font(
    font_path: str, original_font=None, style: str = "regular", text: str | None = None,
    rtl_ok: bool = False,
) -> str:
    """Resolve the concrete fallback face to embed. `font_path` may be a
    DIRECTORY (the vendored `resources/fonts` — the real app passes this,
    and the family matching the original font is chosen) or a FILE (a
    specific face — the test/back-compat path, used verbatim). `style`
    (regular/bold/italic/bolditalic) picks the face variant.
    Degrade ladder: exact family+style → the family's Regular → Sans
    Regular → whatever single .ttf is present — face identity beats
    weight (a missing Bold lands on the family's Regular, never another
    family's Bold), and a partially provisioned bundle degrades instead
    of crashing.

    When `text` is given and the family face cannot express it, the
    CJK-capable face (Noto Sans CJK, full Latin included so mixed strings
    stay one face) takes over — a text-DRIVEN switch, never a silent
    substitution for text the family face already covers. Text neither
    face covers still refuses downstream (the honest floor)."""
    if not os.path.isdir(font_path):
        return font_path
    family = classify_font_family(original_font) if original_font is not None else "sans"
    faces = _FACE_FILES[family]
    st = style if style in faces else "regular"
    resolved = None
    for candidate_name in (faces[st], faces["regular"], _FACE_FILES["sans"]["regular"]):
        candidate = os.path.join(font_path, candidate_name)
        if os.path.isfile(candidate):
            resolved = candidate
            break
    if resolved is None:
        for name in sorted(os.listdir(font_path)):
            if name.lower().endswith(".ttf"):
                resolved = os.path.join(font_path, name)
                break
    if resolved is None:
        raise ValueError(f"no fallback font found in {font_path}")
    if text is not None and not face_covers(resolved, text):
        cjk_name = _CJK_FACES.get(st, _CJK_FACES["regular"])
        for candidate_name in (cjk_name, _CJK_FACES["regular"]):
            cjk = os.path.join(font_path, candidate_name)
            if os.path.isfile(cjk) and face_covers(cjk, text):
                return cjk
        # The same text-driven step for right-to-left scripts — but
        # OPT-IN, unlike the CJK one, and that difference is the whole
        # safety property. Resolving an RTL face is only correct for a
        # caller that also REORDERS the line and SHAPES the joining runs;
        # handing one to a caller that does neither would turn today's
        # honest "the fallback font cannot express 'ب'" refusal into
        # silently broken output — disconnected letters in reverse. So each
        # emitter opts in as it is lifted (Add Text is; per-span styling,
        # watermarks and form fill are not yet), and
        # everything else keeps the refusal it has today.
        if rtl_ok:
            try:
                return resolve_rtl_font(font_path, text, style=st)
            except ValueError:
                pass
    return resolved


def resolve_vertical_font(font_path: str, text: str, style: str = "regular") -> str:
    """The bundled face that can draw `text` VERTICALLY.

    One family, deliberately: the CJK face is the only bundled one carrying
    `vert`/`vrt2` and `vmtx`, and a serif/mono request has nothing honest to
    resolve to. That is an ABSENCE (we vendor no vertical serif), not a
    refusal to look — a user who wants another vertical face picks one of
    their own installed ones, which is a first-class choice.

    Raises ValueError naming the text when nothing bundled can draw it,
    which the caller turns into the same honest refusal it had before."""
    from engine.shaping import shape_vertical

    if not os.path.isdir(font_path):
        return font_path
    st = style if style in _CJK_FACES else "regular"
    for name in (_CJK_FACES[st], _CJK_FACES["regular"]):
        candidate = os.path.join(font_path, name)
        if not os.path.isfile(candidate):
            continue
        drawn = [c for c in text if c not in ("\n", "\r", "\t")]
        if all(shape_vertical(candidate, ch) is not None for ch in drawn):
            return candidate
        break
    raise ValueError(f"no bundled vertical font can express {text!r}")


def face_has_vertical_metrics(face_path: str) -> bool:
    """Whether the face's own program STATES vertical advances — `vmtx`
    with its `vhea` header.

    This is a metrics test, not a shaping test. HarfBuzz synthesizes a
    `y_advance` when `vmtx` is absent, but that value is not a font-supplied
    vertical metric and must not be embedded as `/W2` under `/Identity-V`."""
    try:
        tt = TTFont(face_path, fontNumber=0, lazy=True)
    except Exception:
        return False
    try:
        keys = set(tt.keys())
    finally:
        tt.close()
    return "vmtx" in keys and "vhea" in keys


def face_shapes_vertically(face_path: str, text: str) -> bool:
    """Whether `face_path` can draw every character of `text` vertically —
    the gate for an INSTALLED face used on vertical text. A font with
    no vertical machinery answers False rather than drawing sideways.

    Two independent absences, both refused: no vertical METRICS (no `vmtx`
    — the face makes no vertical statement at all) and no vertical FORM for
    some character (the face has the machinery but not that glyph). Callers
    that report the refusal ask `face_has_vertical_metrics` first so the two
    are distinguishable in a bug report."""
    from engine.shaping import shape_vertical

    if not face_has_vertical_metrics(face_path):
        return False
    try:
        return all(
            shape_vertical(face_path, ch) is not None
            for ch in text
            if ch not in ("\n", "\r", "\t")
        )
    except Exception:
        return False


def resolve_feature_font(font_path: str, style: str = "regular") -> str:
    """The bundled FEATURE-BEARING face (Libertinus Serif OTF) for `style`.
    Opt-in only; never returned by the automatic ladder above, so it
    can't become a silent substitution of a document's body font."""
    if not os.path.isdir(font_path):
        return font_path
    st = style if style in _LIBERTINUS_SERIF else "regular"
    for name in (_LIBERTINUS_SERIF[st], _LIBERTINUS_SERIF["regular"]):
        candidate = os.path.join(font_path, name)
        if os.path.isfile(candidate):
            return candidate
    raise ValueError(f"Libertinus Serif (feature font) not found in {font_path}")


def _subset_font(font_path: str, text: str, glyphs=None, retain_gids=False) -> tuple[bytes, "TTFont"]:
    """Subset the fallback font; returns (ttf bytes, the loaded subset TTFont
    for metrics/cmap reads).

    When `glyphs` (a set of glyph NAMES) is given, subset to those
    glyphs directly instead of by character. Feature-substituted glyphs
    (`a.sc`, a stylistic alternate) are not reachable through the cmap, so a
    text-driven subset would drop them; a glyph-driven subset keeps exactly
    what will be drawn."""
    options = ft_subset.Options()
    # A SHAPED subset keeps the source glyph ids (`retain_gids`), because
    # the shaper addresses glyphs by id and the subsetter drops the `post`
    # names that would otherwise let us re-find them. The character path keeps
    # the shipped renumbering — it re-derives every glyph through the subset's
    # OWN cmap, so it never crosses the id boundary at all.
    options.retain_gids = bool(retain_gids)
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

    `glyph_for` (a `{char: glyph_name}` map from `font_features.
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

    return _embed_identity_h(
        pdf, ttf_bytes, font, font_path, metrics, widths,
        sorted(((gid, ch) for ch, gid in used.items())),
    ) + (encode, width_1000)


def _embed_identity_h(pdf, ttf_bytes, font, font_path, metrics, widths, tounicode_pairs,
                      cid_to_gid=None, vertical_advances=None):
    """The Type0/Identity-H embed shared by the character and the SHAPED
    builders — descriptor, descendant CIDFont, /W, ToUnicode. Returns a
    1-tuple so the callers can concatenate their own encode/measure pair
    onto it; splitting it out is what keeps the shaped path from forking a
    second copy of the embedding rules.

    `tounicode_pairs` is [(code, text)] sorted by code; `text` may be empty
    (a shaped cluster's non-leading glyph maps to NOTHING, so the word
    extracts back exactly once) or several characters (a ligature)."""
    # Derive the embedded BaseFont from the ACTUAL face (it may now
    # be Serif/Mono, not always Sans) — a hardcoded "LiberationSans" would
    # lie about a serif embed. "-Regular" is dropped; the "ABCDEF+" fake
    # subset tag marks it as subsetted.
    stem = Path(font_path).stem
    if stem.endswith("-Regular"):
        stem = stem[: -len("-Regular")]
    base_name = f"ABCDEF+{stem or 'FallbackFont'}"
    # The face may be CFF-flavoured (an .otf). That matters because the
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
            # A VERTICAL embed carries /W2 (the vertical advances, as
            # `c [w1y vx vy]` triplets) and /DW2. Per spec w1y is NEGATIVE —
            # the advance runs DOWN the page — while every width table in
            # this engine stores magnitudes, so the sign is applied here, at
            # the one place the PDF is written.
            **(
                {
                    "W2": Array(
                        [
                            item
                            for gid in sorted(vertical_advances)
                            for item in (
                                gid,
                                Array([
                                    -vertical_advances[gid],
                                    round(metrics["bbox"][2] / 2.0, 2),
                                    round(metrics["ascent"], 2),
                                ]),
                            )
                        ]
                    ),
                    "DW2": Array([880, -1000]),
                }
                if vertical_advances
                else {}
            ),
            # /CIDToGIDMap is defined for CIDFontType2 ONLY; for a CFF
            # descendant the CID-to-glyph mapping comes from the embedded
            # font, so emitting it here would be meaningless (and is what
            # trips strict validators). A SHAPED subset passes a
            # stream, because several codes may point at one glyph — that is
            # how one base glyph spells `مَ` under one code and `مْ` under
            # another. The character path passes nothing and keeps /Identity.
            **(
                {}
                if is_cff
                else {
                    "CIDToGIDMap": (
                        pdf.make_stream(cid_to_gid)
                        if cid_to_gid is not None
                        else Name("/Identity")
                    )
                }
            ),
        )
    )

    # Real UTF-16BE per entry: an f'{ord(ch):04x}' of an astral char emits
    # five nibbles, producing a malformed CMap hex string. This is latent when
    # Liberation is BMP-only so the coverage refusal fires first, but a
    # future supplementary-plane fallback font must not ship this).
    entries = "\n".join(
        f"<{gid:04x}> <{ch.encode('utf-16-be').hex()}>" for gid, ch in tounicode_pairs
    )
    tounicode = (
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n"
        f"{len(tounicode_pairs)} beginbfchar\n{entries}\nendbfchar\n"
        "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
    )

    font_dict = pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type0"),
            BaseFont=Name("/" + base_name),
            Encoding=Name("/Identity-V" if vertical_advances else "/Identity-H"),
            DescendantFonts=Array([descendant]),
            ToUnicode=pdf.make_stream(tounicode.encode("ascii")),
        )
    )
    return (font_dict,)


def build_vertical_font(pdf: "pikepdf.Pdf", font_path: str, text: str):
    """Embed a subset for VERTICAL writing.

    Vertical CJK could not be restyled at all because "no vertical face is
    bundled". One is bundled now (Noto Sans CJK carries `vert`/`vrt2`,
    `vmtx` and `VORG`) and the shaper can reach those features, so the
    stated reason stopped being true and this is what replaces it.

    Three things make an embed vertical rather than horizontal, and all
    three come from the font rather than from an assumption:

      - the glyphs are the VERTICAL forms, which is a GSUB substitution the
        shaper applies when the buffer runs top-to-bottom (a comma becomes
        its upright variant; brackets rotate);
      - the advance is the vertical one from `vmtx`, reported by the shaper
        as a negative `y_advance` — `/W2` carries its magnitude;
      - the /Encoding is **Identity-V**, which is what tells the VIEWER to
        advance downward. Emitting vertical glyphs under a horizontal CMap
        would draw the right shapes marching across the page.

    Returns (font_dict, encode, width_1000) with the same shape as
    `build_fallback_font`, so every caller's width and emission code is
    unchanged — `width_1000` reports the vertical advance, which is exactly
    the convention `FontCapability` already uses for a vertical font."""
    from engine import shaping

    if not Path(font_path).is_file():
        raise ValueError(f"bundled fallback font not found: {font_path}")
    # `/Identity-V` requires the `vmtx` values used to populate `/W2`.
    if not face_has_vertical_metrics(font_path):
        raise ValueError("that font has no vertical metrics — pick one that does")
    drawn = [ch for ch in dict.fromkeys(text) if ch not in ("\n", "\r", "\t")]
    if not drawn:
        raise ValueError("no text to embed")
    full = TTFont(font_path, fontNumber=0, lazy=True)
    try:
        full_gid_of = {name: i for i, name in enumerate(full.getGlyphOrder())}
    finally:
        full.close()

    # Shape each character on its own: vertical text advances per glyph and
    # forms no cross-character ligatures, so a per-character shape is exact
    # and keeps the code→character map one to one.
    per_char: dict[str, tuple[str, float]] = {}
    for ch in drawn:
        run = shaping.shape_vertical(font_path, ch)
        if run is None:
            raise ValueError(f"the vertical fallback font cannot express {ch!r}")
        per_char[ch] = run

    want = {name for name, _adv in per_char.values()}
    ttf_bytes, font = _subset_font(font_path, "".join(drawn), glyphs=want, retain_gids=True)
    metrics = _font_metrics(font)
    used: dict[str, int] = {}
    advances: dict[int, float] = {}
    for ch, (name, advance) in per_char.items():
        gid = full_gid_of[name]
        used[ch] = gid
        advances[gid] = round(abs(advance), 2)

    def encode(s: str) -> bytes:
        out = bytearray()
        for ch in s:
            gid = used.get(ch)
            if gid is None:
                raise ValueError(f"the fallback font cannot express {ch!r}")
            out += bytes(((gid >> 8) & 0xFF, gid & 0xFF))
        return bytes(out)

    def width_1000(s: str) -> float:
        # The VERTICAL advance — the convention: magnitudes only, the
        # caller applies the downward direction.
        return sum(advances.get(used[ch], 1000.0) for ch in s if ch in used)

    return _embed_identity_h(
        pdf, ttf_bytes, font, font_path, metrics, {},
        sorted((gid, ch) for ch, gid in used.items()),
        vertical_advances=advances,
    ) + (encode, width_1000)


def build_shaped_font(pdf: "pikepdf.Pdf", font_path: str, text: str, shaped):
    """Embed a subset that carries SHAPED glyphs as well as plain characters
    Returns (font_dict, encode, width_1000, glyph_encode,
    glyph_width) — the last two take a sequence of glyph NAMES, which is how
    a shaped run addresses glyphs the cmap cannot reach (a joining form, a
    lam-alef ligature, an attached mark).

    `shaped` is a list of `engine.shaping.ShapedRun`. The subset RETAINS the
    source glyph ids so a glyph can be addressed by the id the shaper handed
    back (the subsetter drops the `post` names that would otherwise let us
    re-find it), and a **/CIDToGIDMap STREAM** then maps character codes onto
    those ids.

    That indirection is the whole point, and it is not optional. What a glyph
    SPELLS is a property of the (glyph, cluster) PAIR, not of the glyph:
    HarfBuzz folds a combining mark into its base's cluster, so one base
    glyph spells `مَ` here and `مْ` three words later. /ToUnicode is keyed by
    CODE, so giving each distinct pair its own code lets both spellings
    coexist — where keying by glyph id silently let the second overwrite the
    first, and a fatha came back as a sukun. Several codes mapping to one
    glyph is exactly what a CIDToGIDMap stream is for.

    Each cluster's CARRIER code takes that cluster's characters and its
    companions map to the EMPTY string, so an Arabic letter drawn as
    base-plus-mark still extracts as exactly its characters, once. That is
    what keeps a shaped edit re-editable — the round trip is the feature,
    not a nicety."""
    if not Path(font_path).is_file():
        raise ValueError(f"bundled fallback font not found: {font_path}")
    full = TTFont(font_path, fontNumber=0, lazy=True)
    try:
        full_cmap = full.getBestCmap() or {}
        full_gid_of = {name: i for i, name in enumerate(full.getGlyphOrder())}
    finally:
        full.close()
    missing = [ch for ch in set(text) if ord(ch) not in full_cmap]
    if missing:
        pretty = " ".join(f"'{c}'" for c in sorted(missing))
        raise ValueError(f"the fallback font cannot express {pretty}")
    want = {full_cmap[ord(ch)] for ch in set(text)}
    for run in shaped:
        want.update(run.glyph_names)
    ttf_bytes, font = _subset_font(font_path, text, glyphs=want, retain_gids=True)

    hmtx = font["hmtx"]
    metrics = _font_metrics(font)
    scale = metrics["scale"]
    sub_order = font.getGlyphOrder()
    # A CFF descendant is a CIDFontType0, and /CIDToGIDMap is defined for
    # CIDFontType2 ONLY — `_embed_identity_h` correctly refuses to write one,
    # which means the indirection this function is built on DOES NOT EXIST
    # for a CFF face and the CID must simply BE the glyph index (exactly the
    # scheme `build_fallback_font` already ships for both flavours).
    #
    # CFF faces must retain their mapping; otherwise they draw whatever glyph
    # the arbitrary code happened to hit. Libertinus and Noto Sans CJK — the
    # two bundled faces that actually carry `liga` — are both OTF, so the
    # ligature capability was landing on precisely the fonts this broke.
    is_cff = getattr(font, "sfntVersion", "") == "OTTO"

    def gid_width(g: int) -> float:
        if g >= len(sub_order):
            raise ValueError(f"the fallback font lost glyph {g} while subsetting")
        return round(hmtx[sub_order[g]][0] * scale, 2)

    # code → gid, code → spelling, code → width. Codes start at 1: CID 0 is
    # `.notdef` by convention and nothing should ever draw it.
    gid_of_code: dict[int, int] = {}
    unicode_of: dict[int, str] = {}
    widths: dict[int, float] = {}
    code_of: dict[tuple, int] = {}  # (glyph name, spelling) → code

    def code_for(name: str, spells: str) -> int:
        key = (name, spells)
        code = code_of.get(key)
        if code is not None:
            return code
        g = full_gid_of[name]
        if is_cff:
            # No mapping table to point several codes at one glyph, so a
            # glyph carries exactly ONE spelling. A collision REFUSES rather
            # than letting the second spelling overwrite the first — the
            # spelling rule, which is why a fatha does not come back a sukun.
            # The caller drops to the unshaped path, whose output is correct
            # (just without the ligature), never to wrong glyphs.
            code = g
            prior = unicode_of.get(code)
            if prior is not None and prior != spells:
                raise ValueError(
                    "this font cannot carry both spellings of one glyph "
                    f"({prior!r} and {spells!r})"
                )
        else:
            code = len(code_of) + 1
        code_of[key] = code
        gid_of_code[code] = g
        widths[code] = gid_width(g)
        unicode_of[code] = spells
        return code

    used: dict[str, int] = {}
    for ch in sorted(set(text)):
        used[ch] = code_for(full_cmap[ord(ch)], ch)
    for run in shaped:
        for name, cluster in run.clusters:
            code_for(name, cluster)

    def encode(s: str) -> bytes:
        out = bytearray()
        for ch in s:
            code = used.get(ch)
            if code is None:
                raise ValueError(f"the fallback font cannot express {ch!r}")
            out += bytes(((code >> 8) & 0xFF, code & 0xFF))
        return bytes(out)

    def width_1000(s: str) -> float:
        return sum(widths[used[ch]] for ch in s if ch in used)

    def glyph_encode(name: str, spells: str) -> bytes:
        code = code_for(name, spells)
        return bytes(((code >> 8) & 0xFF, code & 0xFF))

    def glyph_width(name: str, spells: str) -> float:
        return widths[code_for(name, spells)]

    # /CIDToGIDMap as a STREAM: two big-endian bytes per CID, indexed by CID.
    # CFF took the code==gid branch above, so it needs none and gets none.
    cid_to_gid = None
    if not is_cff:
        top = max(gid_of_code) if gid_of_code else 0
        buf = bytearray((top + 1) * 2)
        for code, g in gid_of_code.items():
            buf[code * 2] = (g >> 8) & 0xFF
            buf[code * 2 + 1] = g & 0xFF
        cid_to_gid = bytes(buf)

    return _embed_identity_h(
        pdf, ttf_bytes, font, font_path, metrics, widths,
        sorted(unicode_of.items()), cid_to_gid=cid_to_gid,
    ) + (encode, width_1000, glyph_encode, glyph_width)
