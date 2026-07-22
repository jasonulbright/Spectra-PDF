"""Phase 9.K2 — OpenType feature control (small caps, alternates).

Applies GSUB features to text WE lay out, at the glyph level. Because our
embedding is Type0/Identity (CID == GID, controlled by us), we can draw any
glyph the font contains while keeping ToUnicode pointed at the original
characters — so feature-styled text stays searchable and re-editable.

SCOPE — only NON-CONTEXTUAL features, applied without a shaper:
  - small caps: `smcp` (lowercase -> small cap) + `c2sc` (uppercase -> small
    cap), applied together so "Abc" becomes uniform small caps.
  - alternates: `salt` (stylistic alternates) — a glyph may offer several;
    the caller picks one by index (default 0 = the first alternate).
A single substitution (LookupType 1) and an alternate substitution
(LookupType 3) are both context-free 1->1 (alternate = 1->pick-1) maps, so a
plain table read is CORRECT here — no HarfBuzz needed. Ligatures (`liga`) and
contextual features are deliberately NOT applied: they need a shaping engine,
and a partial hand-rolled shaper would style some sequences and silently miss
others (the § I.0 silent-partial class).

SOURCE — a feature applies from WHATEVER font already carries it (the owner's
"apply in place" rule): a document set in a font with `smcp` gets real small
caps from its own font. When the current font lacks the feature the caller
requires an explicit switch to a bundled face that has it (Libertinus Serif).
"""

from __future__ import annotations

# The features we can honestly apply, mapped to a human label. Extendable, but
# every entry must be a NON-CONTEXTUAL single/alternate substitution.
SMALL_CAPS = ("smcp", "c2sc")
SUPPORTED = frozenset(SMALL_CAPS + ("salt",))


def _iter_subtables(lookup):
    """Yield GSUB subtables, unwrapping Extension Substitution (LookupType 7)
    — the GSUB twin of the GPOS extension trap in font_kerning: reading
    `.Format`/type off the wrapper misses everything behind an extension
    lookup, silently. Yields (effective_type, subtable)."""
    outer = getattr(lookup, "LookupType", None)
    for sub in getattr(lookup, "SubTable", []) or []:
        ext = getattr(sub, "ExtSubTable", None)
        if outer == 7 or ext is not None:
            if ext is None:
                continue
            yield getattr(sub, "ExtensionLookupType", None), ext
        else:
            yield outer, sub


def _feature_lookup_indices(gsub, tags) -> list[int]:
    idxs: set[int] = set()
    try:
        for rec in gsub.FeatureList.FeatureRecord:
            if rec.FeatureTag in tags:
                idxs.update(rec.Feature.LookupListIndex or [])
    except Exception:
        return []
    return sorted(idxs)


def _single_map(sub) -> dict[str, str]:
    """A 1->1 substitution map from a LookupType 1 (single) OR a LookupType 2
    (multiple) whose outputs are single glyphs.

    Small caps in real fonts is often a MultipleSubst with 1-element outputs
    (`a -> [a.sc]`) rather than a SingleSubst — Libertinus does exactly this
    (verified). A genuine 1->many multiple substitution (e.g. a decomposition)
    is NOT a styling feature and is skipped: only length-1 outputs are taken.
    """
    out: dict[str, str] = {}
    mapping = getattr(sub, "mapping", None)
    if not isinstance(mapping, dict):
        return out
    for g, v in mapping.items():
        if isinstance(v, str):
            out[g] = v
        elif isinstance(v, (list, tuple)) and len(v) == 1:
            out[g] = v[0]
    return out


def _alternate_map(sub) -> dict[str, list]:
    """LookupType 3 alternate-substitution: {glyph -> [alternate glyphs]}."""
    out: dict[str, list] = {}
    alts = getattr(sub, "alternates", None)
    if isinstance(alts, dict):
        for g, choices in alts.items():
            if choices:
                out[g] = list(choices)
    return out


def available_features(font) -> set:
    """The SUPPORTED features actually present in this font's GSUB.

    `font` is an open fontTools TTFont. Returns the raw feature tags (so
    `smcp`/`c2sc` are reported separately); callers group them into UI labels.
    """
    try:
        gsub = font["GSUB"].table
    except Exception:
        return set()
    if not gsub or not gsub.FeatureList:
        return set()
    present = set()
    try:
        for rec in gsub.FeatureList.FeatureRecord:
            if rec.FeatureTag in SUPPORTED:
                present.add(rec.FeatureTag)
    except Exception:
        return set()
    return present


def has_small_caps(font) -> bool:
    return bool(available_features(font) & set(SMALL_CAPS))


def _ordered_lookups(font, tags):
    """The requested features' lookups AS AN ORDERED LIST of (kind, map),
    where map is {g->g} for single/multiple-1 and {g->[alts]} for alternate.

    Order matters: a feature may split its work across lookups that CHAIN
    (Libertinus small caps runs a single-subst for `i` then a multiple-subst
    for the rest), so `resolve_glyphs` applies them in sequence to the running
    glyph rather than merging into one pass.
    """
    try:
        gsub = font["GSUB"].table
    except Exception:
        return []
    if not gsub or not gsub.LookupList:
        return []
    steps = []
    for idx in _feature_lookup_indices(gsub, tags):
        try:
            lookup = gsub.LookupList.Lookup[idx]
        except Exception:
            continue
        for kind, sub in _iter_subtables(lookup):
            if kind in (1, 2):
                m = _single_map(sub)
                if m:
                    steps.append(("single", m))
            elif kind == 3:
                m = _alternate_map(sub)
                if m:
                    steps.append(("alt", m))
    return steps


def resolve_glyphs(font, text: str, features, alt_index: int = 0) -> list[str]:
    """The glyph name to DRAW for each character in `text` after applying
    `features` (an iterable of tags from SUPPORTED). A character the feature
    does not cover keeps its base (cmap) glyph.

    Context-free by construction: a given character always resolves to the
    same glyph, so the caller can memoise a char->glyph map. A character with
    no cmap glyph is returned as None (the caller refuses it, as today).
    """
    cmap = font.getBestCmap() or {}
    tags = tuple(t for t in features if t in SUPPORTED)
    steps = _ordered_lookups(font, tags) if tags else []
    out: list[str] = []
    for ch in text:
        g = cmap.get(ord(ch))
        if g is None:
            out.append(None)
            continue
        for kind, m in steps:
            if g not in m:
                continue
            if kind == "single":
                g = m[g]
            else:  # alternate: pick the requested index, clamped
                choices = m[g]
                g = choices[min(max(alt_index, 0), len(choices) - 1)]
        out.append(g)
    return out
