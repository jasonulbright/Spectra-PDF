"""Phase 9.K1 — pair-kerning read from a bundled face.

Every glyph we lay out advances by its own width alone, so an authored "AV"
or "To" sits visibly loose. This reads the face's own pair-kerning so the
emission can tighten those pairs the way a typesetter would.

SCOPE (deliberate, and load-bearing): only faces we lay out OURSELVES — the
bundled Liberation family used for authoring, convert, family swap, and
per-span substitution. Text kept in a document's own embedded font is never
kerned here: it already carries its kerning in the original `TJ` arrays, and
the A-track's byte-identity pins (a no-override edit must reproduce shipped
output exactly) would break by construction if every emission kerned.

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
        # Only horizontal, non-cross-stream subtables carry ordinary pair
        # kerning; anything else is a different feature wearing the same table.
        if getattr(sub, "coverage", 1) & 0x2:  # cross-stream
            continue
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


def _gpos_kern(font, cmap_rev: dict[str, str]) -> dict[tuple[str, str], int]:
    """Pairs from the GPOS `kern` feature (PairPos format 1 only).

    The fallback for faces that ship GPOS but no legacy table. Class-based
    (format 2) pairs and contextual chains are deliberately NOT expanded —
    that is the stated v1 boundary, and a partial class expansion would kern
    some pairs and silently miss others.
    """
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
        for sub in getattr(lookup, "SubTable", []) or []:
            if getattr(sub, "Format", None) != 1:
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
