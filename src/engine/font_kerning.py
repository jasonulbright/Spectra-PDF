"""Phase 9.K1 — pair-kerning read from a bundled face.

Every glyph we lay out advances by its own width alone, so an authored "AV"
or "To" sits visibly loose. This reads the face's own pair-kerning so the
emission can tighten those pairs the way a typesetter would.

SCOPE: wherever WE lay text out, sourced from whatever font that text
actually uses — the bundled Liberation family (authoring, convert, family
swap, per-span substitution) AND the document's own fonts, via their
embedded program or, failing that, their metric twin among the bundled
faces.

The document half is not a nicety. K1 first shipped bundled-faces-only,
reasoning that the A-track's byte-identity pins would break if every
emission kerned. That inverted the priority — the pins are an internal test
convention, a 1:1 feature set is the product requirement — and it left a
live regression standing: a paragraph whose original stream carried
`[(A) 74 (V) 74 (A) 55 (T) 40 (AR)] TJ` came back as a plain `Tj` after a
NO-OP re-type, so editing text visibly UN-KERNED it. Re-emitting without
kerning does not preserve the original kerning; it discards it. The pins
were updated to the corrected output (see DECISIONS #37).

Values are returned in 1000ths of an em — the unit PDF text space uses — so
callers never deal with a face's `unitsPerEm`.

"""

from __future__ import annotations

import os

# path -> {(left_char, right_char): value in 1000ths of an em}. Faces are
# re-read constantly during an edit; parsing a kern table per call is pure
# waste (the A3b _FontCache precedent).
_KERN_CACHE: dict[tuple[str, float], dict[tuple[str, str], float]] = {}


def _cache_key(font_path: str) -> tuple[str, float]:
    """Key on path AND mtime so a re-synced font bundle is picked up rather
    than served stale from a previous run's parse."""
    try:
        mtime = os.path.getmtime(font_path)
    except OSError:
        mtime = 0.0
    return (os.path.abspath(font_path), mtime)


def _legacy_kern(font, cmap_rev: dict[str, str]) -> dict[tuple[str, str], int]:
    """Pairs from the legacy `kern` table (format 0 subtables)."""
    out: dict[tuple[str, str], int] = {}
    try:
        table = font["kern"]
    except Exception:
        return out
    for sub in getattr(table, "kernTables", []) or []:
        # Only HORIZONTAL, additive pair kerning belongs in a `TJ` array.
        # The coverage bits (kern format 0): 0x1 horizontal, 0x2 minimum,
        # 0x4 cross-stream, 0x8 override.
        #   - not horizontal  -> vertical kerning; folding it into a
        #     horizontal TJ would displace glyphs along the wrong axis.
        #   - minimum         -> a floor on spacing, NOT an additive delta;
        #     summing it would be meaningless.
        #   - cross-stream    -> perpendicular movement (accent placement);
        #     again the wrong axis.
        # (Round-41 review: this previously tested 0x2 while CALLING it
        # cross-stream and never checked horizontal at all, so a genuine
        # cross-stream or vertical-only subtable passed straight through.
        # Inert for every shipped Liberation face — all are coverage 0x01 —
        # but a font resync or an added family would have activated it
        # silently, which is exactly the class of latent bug worth closing.)
        coverage = getattr(sub, "coverage", 0x1)
        if not (coverage & 0x1):
            continue  # vertical
        if coverage & 0x2:
            continue  # minimum
        if coverage & 0x4:
            continue  # cross-stream
        pairs = getattr(sub, "kernTable", None)
        if not pairs:
            continue
        for (left, right), value in pairs.items():
            lch = cmap_rev.get(left)
            rch = cmap_rev.get(right)
            if lch is None or rch is None:
                continue  # a glyph with no unicode: not addressable as text
            if value:
                out[(lch, rch)] = value
    return out


def _pairpos2(sub, cmap_rev: dict[str, str], out: dict[tuple[str, str], int]) -> None:
    """Expand a CLASS-BASED PairPos (format 2) subtable.

    This is how most modern fonts encode kerning: glyphs are grouped into
    classes and the pairs live in a class x class matrix, so a font can hold
    tens of thousands of effective pairs in a small table. K1 originally
    skipped format 2 — harmless while only the bundled Liberation faces were
    kerned (they all use the legacy table), but the moment a DOCUMENT's own
    font is the source, skipping it would kern some documents and silently
    not others, which is worse than not kerning at all.
    """
    coverage = getattr(sub, "Coverage", None)
    cd1 = getattr(sub, "ClassDef1", None)
    cd2 = getattr(sub, "ClassDef2", None)
    matrix = getattr(sub, "Class1Record", None)
    if coverage is None or cd1 is None or cd2 is None or not matrix:
        return
    classes1 = getattr(cd1, "classDefs", {}) or {}
    classes2 = getattr(cd2, "classDefs", {}) or {}
    covered = set(coverage.glyphs or [])
    # class -> the glyphs in it, restricted to Coverage for the FIRST glyph
    # (a glyph absent from classDefs is class 0 by definition).
    first_by_class: dict[int, list[str]] = {}
    for glyph in covered:
        first_by_class.setdefault(classes1.get(glyph, 0), []).append(glyph)
    second_by_class: dict[int, list[str]] = {}
    for glyph, cls in classes2.items():
        second_by_class.setdefault(cls, []).append(glyph)
    # Class 0 of ClassDef2 is "everything not otherwise classed" — unbounded
    # and almost never carries kerning; expanding it would explode the table
    # for no gain, so only explicitly-classed second glyphs are expanded.
    for c1, rec1 in enumerate(matrix):
        firsts = first_by_class.get(c1)
        if not firsts:
            continue
        for c2, rec2 in enumerate(getattr(rec1, "Class2Record", []) or []):
            v1 = getattr(rec2, "Value1", None)
            adv = getattr(v1, "XAdvance", 0) if v1 is not None else 0
            if not adv:
                continue
            seconds = second_by_class.get(c2)
            if not seconds:
                continue
            for gl in firsts:
                lch = cmap_rev.get(gl)
                if lch is None:
                    continue
                for gr in seconds:
                    rch = cmap_rev.get(gr)
                    if rch is None:
                        continue
                    out.setdefault((lch, rch), adv)


def _positioning_subtables(lookup):
    """Yield `(effective_lookup_type, subtable)`, UNWRAPPING Extension
    Positioning (LookupType 9).

    Large fonts routinely put their kerning behind extension lookups — the
    lookup's own type is 9 and its subtables are thin wrappers whose real
    content is `ExtSubTable`, with the true type in `ExtensionLookupType`.
    Reading `sub.Format` directly off the wrapper yields the EXTENSION's
    format (always 1), so an unwrapped reader mistakes every extension
    subtable for a PairPos format 1, finds no Coverage, and silently
    extracts NOTHING.

    Measured on this machine: Calibri's `kern` feature is entirely
    LookupType 9, wrapping inner PairPos of BOTH formats. Calibri only
    appeared to work because it also ships a legacy `kern` table that takes
    precedence — a font with no legacy table would have kerned not at all,
    with no error. That is the "kerns some documents and silently not
    others" outcome this module explicitly refuses.
    """
    outer = getattr(lookup, "LookupType", None)
    for sub in getattr(lookup, "SubTable", []) or []:
        inner = getattr(sub, "ExtSubTable", None)
        if outer == 9 or inner is not None:
            if inner is None:
                continue
            yield getattr(sub, "ExtensionLookupType", None), inner
        else:
            yield outer, sub


def _gpos_kern(font, cmap_rev: dict[str, str]) -> dict[tuple[str, str], int]:
    """Pairs from the GPOS `kern` feature — PairPos format 1 (explicit pairs)
    AND format 2 (class-based). Contextual chains are not expanded: those are
    positioning RULES rather than pair values, and applying them needs a
    shaping engine, not a table lookup."""
    out: dict[tuple[str, str], int] = {}
    try:
        gpos = font["GPOS"].table
    except Exception:
        return out
    if not gpos or not gpos.FeatureList or not gpos.LookupList:
        return out
    wanted: set[int] = set()
    for rec in gpos.FeatureList.FeatureRecord:
        if rec.FeatureTag == "kern":
            wanted.update(rec.Feature.LookupListIndex or [])
    for idx in sorted(wanted):
        try:
            lookup = gpos.LookupList.Lookup[idx]
        except Exception:
            continue
        for kind, sub in _positioning_subtables(lookup):
            if kind != 2:  # PairPos only; 1 = single, 8 = chained context, ...
                continue
            fmt = getattr(sub, "Format", None)
            if fmt == 2:
                _pairpos2(sub, cmap_rev, out)
                continue
            if fmt != 1:
                continue
            coverage = getattr(sub, "Coverage", None)
            pairsets = getattr(sub, "PairSet", None)
            if coverage is None or not pairsets:
                continue
            for first_glyph, pairset in zip(coverage.glyphs, pairsets):
                lch = cmap_rev.get(first_glyph)
                if lch is None:
                    continue
                for record in getattr(pairset, "PairValueRecord", []) or []:
                    rch = cmap_rev.get(record.SecondGlyph)
                    if rch is None:
                        continue
                    v1 = getattr(record, "Value1", None)
                    adv = getattr(v1, "XAdvance", 0) if v1 is not None else 0
                    if adv:
                        out[(lch, rch)] = adv
    return out


def kern_pairs(font_path: str) -> dict[tuple[str, str], float]:
    """`{(left, right): 1000ths of an em}` for a bundled face.

    Negative values TIGHTEN (the overwhelmingly common case). A face with no
    pair kerning returns `{}` — Liberation Mono genuinely has none, so a
    monospace box simply never kerns with no special case anywhere.
    """
    key = _cache_key(font_path)
    hit = _KERN_CACHE.get(key)
    if hit is not None:
        return hit

    pairs: dict[tuple[str, str], float] = {}
    try:
        from fontTools.ttLib import TTFont

        font = TTFont(font_path, fontNumber=0, lazy=True)
        try:
            upem = int(font["head"].unitsPerEm) or 1000
            # glyph name -> the ONE character that reaches it. A glyph with
            # several codepoints is ambiguous for a char-keyed table; keep the
            # lowest so the mapping is deterministic run to run.
            cmap_rev: dict[str, str] = {}
            for code, gname in sorted(font.getBestCmap().items()):
                cmap_rev.setdefault(gname, chr(code))
            raw = _legacy_kern(font, cmap_rev)
            if not raw:
                raw = _gpos_kern(font, cmap_rev)
            scale = 1000.0 / float(upem)
            pairs = {k: v * scale for k, v in raw.items() if v}
        finally:
            font.close()
    except Exception:
        # A malformed or unreadable face must never break an edit — it just
        # means no kerning, exactly like Mono.
        pairs = {}

    _KERN_CACHE[key] = pairs
    return pairs


def kern_between(pairs: dict[tuple[str, str], float], left: str, right: str) -> float:
    """The adjustment between two characters, in 1000ths of an em (0 when the
    face has no opinion)."""
    if not pairs or not left or not right:
        return 0.0
    return pairs.get((left, right), 0.0)


def tj_offset(kern_1000: float) -> float:
    """Kern value (1000ths of an em) → the number to place in a PDF `TJ` array.

    THE SIGN TRAP, stated once so it is never re-derived by guess: a number in
    a `TJ` array moves the next glyph LEFT by `n/1000 x size`. Kern values are
    NEGATIVE when a pair should tighten. So the emitted number is the NEGATION
    of the kern: `A|V` at -128.9 (1000ths) emits +128.9, pulling the V left.
    """
    return -kern_1000


def kerned_width(pairs: dict[tuple[str, str], float], text: str) -> float:
    """Total kern adjustment across `text`, in 1000ths of an em.

    Measurement MUST include this or wrapping, centring and justification
    would disagree with what is actually drawn.
    """
    if not pairs or len(text) < 2:
        return 0.0
    total = 0.0
    chars = list(text)
    for i in range(len(chars) - 1):
        total += pairs.get((chars[i], chars[i + 1]), 0.0)
    return total


# ─────────────────── the DOCUMENT'S own fonts (K1b) ──────────────────────
#
# Kerning is not a bundled-face nicety: a paragraph whose original content
# stream carries `[(A) 74 (V) 74 (A) 55 (T) 40 (AR)] TJ` must not come back as
# a plain `Tj` after an edit. It did, which un-kerned text on every edit, so
# the source of kern data has to be whatever font the text actually uses.

_EMBEDDED_CACHE: dict[bytes, dict[tuple[str, str], float]] = {}


def _pairs_from_program(raw: bytes) -> dict[tuple[str, str], float]:
    """Kern pairs from an embedded font PROGRAM (FontFile2 / SFNT-wrapped
    FontFile3), cached on a digest of the bytes — the same subset appears on
    many pages and re-parsing it per run is pure waste."""
    import hashlib

    key = hashlib.sha1(raw).digest()
    hit = _EMBEDDED_CACHE.get(key)
    if hit is not None:
        return hit
    pairs: dict[tuple[str, str], float] = {}
    try:
        from io import BytesIO

        from fontTools.ttLib import TTFont

        font = TTFont(BytesIO(raw), fontNumber=0, lazy=True)
        try:
            upem = int(font["head"].unitsPerEm) or 1000
            cmap_rev: dict[str, str] = {}
            for code, gname in sorted(font.getBestCmap().items()):
                cmap_rev.setdefault(gname, chr(code))
            raw_pairs = _legacy_kern(font, cmap_rev)
            if not raw_pairs:
                raw_pairs = _gpos_kern(font, cmap_rev)
            scale = 1000.0 / float(upem)
            pairs = {k: v * scale for k, v in raw_pairs.items() if v}
        finally:
            font.close()
    except Exception:
        # A damaged or bare-CFF program just means no kerning — never a
        # broken edit. (Bare Type1C has no SFNT wrapper for fontTools; the
        # metric-twin fallback below covers those.)
        pairs = {}
    _EMBEDDED_CACHE[key] = pairs
    return pairs


def _embedded_program(font_obj):
    """The embedded program bytes for a pdf font dict, or None. Mirrors
    `pdf_fonts`' extraction (FontFile2, else SFNT-wrapped FontFile3)."""
    try:
        desc = font_obj.get("/FontDescriptor")
        if desc is None:
            # Type0: the descriptor lives on the descendant.
            desc_fonts = font_obj.get("/DescendantFonts")
            if desc_fonts is not None and len(desc_fonts) > 0:
                desc = desc_fonts[0].get("/FontDescriptor")
        if desc is None:
            return None
        program = desc.get("/FontFile2")
        if program is None:
            program = desc.get("/FontFile3")
        if program is None:
            return None
        return program.read_bytes()
    except Exception:
        return None


def kern_pairs_for_font(font_obj, font_dir: str = "") -> dict[tuple[str, str], float]:
    """Kern pairs for a font as it appears IN A DOCUMENT.

    Resolution order:
      1. The font's own EMBEDDED program — the authoritative source, and the
         only one that can be right for a custom or subsetted face.
      2. Its METRIC TWIN among the bundled faces. B1 vendored Liberation
         precisely because it is metric-compatible with Helvetica / Times /
         Courier, and kerning IS a metric — so a non-embedded standard-14
         font (which carries no program at all, and whose Core14 AFM data
         ships no kern pairs in our stack) gets the kerning its metrics
         imply, rather than none.
    Returns {} when neither resolves, which simply means no kerning.
    """
    raw = _embedded_program(font_obj)
    if raw:
        pairs = _pairs_from_program(raw)
        if pairs:
            return pairs
    if not font_dir:
        return {}
    try:
        import os as _os

        from engine.font_fallback import classify_font_family

        family = classify_font_family(font_obj)
        face = {
            "serif": "LiberationSerif-Regular.ttf",
            "mono": "LiberationMono-Regular.ttf",
        }.get(family, "LiberationSans-Regular.ttf")
        path = _os.path.join(str(font_dir), face)
        if _os.path.isfile(path):
            return kern_pairs(path)
    except Exception:
        pass
    return {}
