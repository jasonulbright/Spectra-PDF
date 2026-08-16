"""Complex-script shaping (HarfBuzz) for the paragraph reflow.

A PDF viewer does NOT shape: the content stream already carries the final
glyph selections, so re-emitting Arabic text as its base letters draws the
ISOLATED forms of every letter — a word that reads as a row of disconnected
stumps. That is broken output, not a narrow limitation, which is why RTL
reflow could not ship on bidi reordering alone.

So the reflow shapes. `uharfbuzz` (Apache-2.0) is HarfBuzz itself, the same
engine used by browsers, and it answers the only two questions
the layout asks: WHICH glyphs, and HOW WIDE. Everything here is a thin,
honest wrapper around that:

  ``requires_shaping(text)``  — does this text belong to a cursively joining
      script? A property of the TEXT, not the font, so it is decidable before
      any font is resolved (which is what the fallback ladder needs).
  ``can_shape_in_place(...)`` — can the document's OWN embedded program drive
      the shaper, and are its glyph ids usable as PDF character codes? True
      keeps the document's typeface; False sends the run to the bundled face.
  ``shape(...)``              — glyph names + the total advance, per word.

Two conventions the callers depend on:

  - Shaping runs PER WORD. Cursive joining never crosses a space, so a word
    is the largest unit whose shaping is independent of its neighbours —
    which means the line breaker can move words freely without invalidating
    a single glyph. (Shaping a whole line and then breaking it would.)
  - Advances come from the shaper in font units and are returned per 1000/em,
    the unit every width path in this engine already speaks.

What this module deliberately does NOT do: GPOS mark positioning offsets
(x_offset/y_offset) are dropped, because expressing them needs a per-glyph
text-matrix push that the emission has no shape for. Dropping the
offsets degrades vowel-mark placement on
fully-vocalised text rather than corrupting the letters.
"""

import os
from functools import lru_cache

# Cursively joining scripts — the ones whose letters take contextual forms,
# so a per-character re-emission is WRONG rather than merely unkerned. Scripts
# with no joining behaviour (Hebrew, Thaana's neighbours, Greek…) are absent
# on purpose: their text re-emits correctly character by character and must
# keep taking the cheaper, font-preserving path.
_JOINING_SCRIPTS = frozenset((
    "Arab",  # Arabic
    "Syrc",  # Syriac
    "Mand",  # Mandaic
    "Mani",  # Manichaean
    "Phlp",  # Psalter Pahlavi
    "Nkoo",  # N'Ko
    "Adlm",  # Adlam
    "Rohg",  # Hanifi Rohingya
    "Sogd",  # Sogdian
    "Sogo",  # Old Sogdian
    "Chrs",  # Chorasmian
    "Ougr",  # Old Uyghur
    "Mong",  # Mongolian
    "Thaa",  # Thaana (joining-transparent marks, but shaped as a unit)
))

# The joining scripts that run LEFT to right. Every other entry above
# is a right-to-left script, and the shaping direction used to be derived as
# "it joins, therefore rtl" — which shaped Mongolian backwards, because
# Mongolian is the one cursive script in the set whose logical order runs the
# other way (HarfBuzz guesses `ltr` for script `Mong`, and its advances are
# real per-letter numbers in that direction). Direction is a property of the
# TEXT, never of whether it joins.
_LTR_JOINING_SCRIPTS = frozenset((
    "Mong",  # Mongolian, and with it Todo, Sibe and Manchu (one block)
))

# The scripts whose text sets in vertical COLUMNS by convention, with
# the columns advancing LEFT to right — the direction evidence. Mongolian
# and its relatives are the living case; Phags-pa and the Zanabazar/Soyombo
# pair set the same way. Ranges rather than fontTools script names because a
# reader needs to see exactly what is claimed.
_LTR_COLUMN_RANGES = (
    (0x1800, 0x18AF),  # Mongolian (Todo, Sibe, Manchu included)
    (0x11660, 0x1167F),  # Mongolian Supplement
    (0xA840, 0xA877),  # Phags-pa
    (0x11A00, 0x11A4F),  # Zanabazar Square
    (0x11A50, 0x11AAF),  # Soyombo
)


def sets_columns_left_to_right(text: str) -> bool:
    """True when `text` carries a character of a script whose vertical
    columns advance LEFT to right (script evidence).

    A TEXT test, like `requires_shaping`, and for the same reason: the
    column direction has to be decidable before any font is resolved."""
    return any(
        any(lo <= ord(ch) <= hi for lo, hi in _LTR_COLUMN_RANGES) for ch in text
    )


@lru_cache(maxsize=4096)
def _script_of(ch: str) -> str:
    from fontTools.unicodedata import script

    return script(ch)


def requires_shaping(text: str) -> bool:
    """True when `text` contains a character from a cursively joining script.

    Deliberately a TEXT test. The alternative — asking whether the font has
    GSUB — answers a different question: a font may carry GSUB for features
    nobody needs here, and a font may lack it while the text still needs
    joining (which is exactly the case that must substitute, not proceed)."""
    return any(_script_of(ch) in _JOINING_SCRIPTS for ch in text)


def shapes_right_to_left(text: str) -> bool:
    """The direction to hand HarfBuzz for `text`.

    Strong bidi evidence decides first (Hebrew joins nothing and is still
    right-to-left). Failing that, a joining script's own direction decides,
    which is right-to-left for every entry in `_JOINING_SCRIPTS` except
    Mongolian. Text with neither shapes left to right, the shipped default.

    Before this the callers passed `rtl=joins or has_strong_rtl(text)`, which
    is exactly right for thirteen of the fourteen joining scripts and hands
    back a REVERSED glyph stream for the fourteenth."""
    from engine import bidi

    if bidi.has_strong_rtl(text):
        return True
    tag = script_tag(text)
    if tag is None:
        return False
    return tag not in _LTR_JOINING_SCRIPTS


def script_tag(text: str) -> str | None:
    """The first joining script in `text` as an OpenType-ish tag, for the
    shaping buffer. None when nothing joins."""
    for ch in text:
        sc = _script_of(ch)
        if sc in _JOINING_SCRIPTS:
            return sc
    return None


class ShapedRun:
    """One shaped word: the glyphs to draw, where to draw them, and what
    they spell.

    `glyphs` is [(glyph name, advance, x offset, y offset)] in STREAM (visual,
    left-to-right) order, all measures per 1000/em. Names, not glyph ids:
    names survive subsetting, ids do not, so the caller maps them into
    whatever subset it embeds. `advance_1000` is the word's total advance.

    `clusters` is [(glyph name, text)] parallel to `glyphs`, where exactly
    ONE glyph per cluster carries that cluster's source characters and the
    others carry the empty string. That is the ToUnicode contract: a letter
    drawn as dotless-base-plus-dot must extract as ONE character, or every
    shaped edit would be a one-way trip."""

    __slots__ = ("text", "glyphs", "advance_1000", "clusters")

    def __init__(self, text, glyphs, advance_1000, clusters):
        self.text = text
        self.glyphs = tuple(glyphs)
        self.advance_1000 = advance_1000
        self.clusters = tuple(clusters)

    @property
    def glyph_names(self) -> tuple:
        return tuple(name for name, _a, _x, _y in self.glyphs)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"ShapedRun({self.text!r}, {len(self.glyphs)} glyphs)"


@lru_cache(maxsize=32)
def _hb_font(face_path: str):
    import uharfbuzz as hb

    with open(face_path, "rb") as fh:
        data = fh.read()
    face = hb.Face(hb.Blob(data))
    return hb.Font(face), face.upem


@lru_cache(maxsize=32)
def _glyph_order(face_path: str) -> tuple:
    from fontTools.ttLib import TTFont

    tt = TTFont(face_path, fontNumber=0, lazy=True)
    try:
        return tuple(tt.getGlyphOrder())
    finally:
        tt.close()


def shape(face_path: str, text: str, rtl: bool = True) -> ShapedRun:
    """Shape ONE word against `face_path`. Raises ValueError when the face
    cannot express the text (a `.notdef` in the output) — the same honest
    floor `build_fallback_font` applies to unshaped characters, and the
    signal the fallback ladder needs to keep looking."""
    import uharfbuzz as hb

    font, upem = _hb_font(face_path)
    order = _glyph_order(face_path)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    buf.direction = "rtl" if rtl else "ltr"
    hb.shape(font, buf)

    # HarfBuzz emits in VISUAL order; cluster values are start offsets into
    # the LOGICAL text.
    infos = list(buf.glyph_infos)
    positions = list(buf.glyph_positions)
    if not infos:
        return ShapedRun(text, (), 0.0, ())
    scale = 1000.0 / (upem or 1000)
    starts = sorted({info.cluster for info in infos})
    span = {}
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(text)
        span[start] = text[start:end]

    glyphs: list[tuple[str, float, float, float]] = []
    advance = 0.0
    for info, pos in zip(infos, positions):
        if info.codepoint == 0 or info.codepoint >= len(order):
            raise ValueError(f"the shaping font cannot express {text!r}")
        name = order[info.codepoint]
        glyphs.append((
            name,
            pos.x_advance * scale,
            pos.x_offset * scale,
            pos.y_offset * scale,
        ))
        advance += pos.x_advance * scale

    # Attribute the source characters to glyphs. Keyed by the cluster's START
    # OFFSET, never by its text — a word with the same letter twice has two
    # clusters spelling the same thing.
    members: dict[int, list[int]] = {}
    for gi, info in enumerate(infos):
        members.setdefault(info.cluster, []).append(gi)
    spelled: dict[int, str] = {}
    for start, gis in members.items():
        # ONE carrier per cluster takes the WHOLE cluster's characters: the
        # widest advance (a zero-advance mark never spells anything), first
        # in stream order on a tie. HarfBuzz folds a combining mark into its
        # base's cluster, so `مَ` is one cluster of two glyphs and the base
        # spells both characters.
        #
        # That makes the spelling a property of the (glyph, cluster) PAIR,
        # not of the glyph — the same base appears elsewhere carrying a
        # different mark — which is why `build_shaped_font` gives each
        # distinct pair its own character CODE rather than keying /ToUnicode
        # by glyph id. Attempting a 1:1 split here instead was tried and is
        # worse: it makes every mark spell something, which puts the mark's
        # horizontal offset back in play as a word gap.
        carrier = max(gis, key=lambda g: (glyphs[g][1], -g))
        spelled[carrier] = span[start]
    clusters = [(glyphs[gi][0], spelled.get(gi, "")) for gi in range(len(infos))]
    return ShapedRun(text, glyphs, advance, clusters)


def changed_it(run: ShapedRun, word: str) -> bool:
    """Did shaping this word produce anything the per-character
    path cannot?

    Three ways it can, and they are the whole point:
      * a LIGATURE formed (fewer glyphs than characters — `liga`, or `ccmp`
        composing a base and a combining mark into one precomposed glyph);
      * a glyph carries a positioning OFFSET (`mark`/`mkmk` attaching a
        diacritic, contextual GPOS);
      * a cluster spells something other than its own single character (the
        general form of the first — one glyph standing for several
        characters).

    Everything else is a glyph-per-character run whose only difference is the
    GPOS advance deltas, i.e. KERNING — which the character paths already
    apply from the same font. Answering "no" there is not a shortcut:
    it keeps the emission byte-identical for the overwhelming majority of
    text, so shaping changes output exactly where the old output was WRONG (a
    combining acute drawn as a spacing glyph beside its letter) and nowhere
    else. That property is what lets every surface adopt this unconditionally
    instead of behind a switch.

    The spelling test is deliberately ORDER-FREE — "does every glyph spell
    exactly one character?" rather than "does glyph i spell word[i]?". A
    right-to-left run comes back in visual order, so a positional comparison
    calls plain Hebrew a change, and the caller then draws a reversed word
    that the reorder was already going to handle correctly (pin-caught:
    `שלום` authored as `םולש`). What actually matters is whether any glyph
    stands for more or fewer than one character."""
    if len(run.glyphs) != len(word):
        return True
    if any(x_off or y_off for _n, _a, x_off, y_off in run.glyphs):
        return True
    return any(len(spells) != 1 for _n, spells in run.clusters)


def shape_if_it_changes(face_path: str, word: str) -> "ShapedRun | None":
    """The word shaped, or None to leave it on the per-character path.

    ONE gate for every emitter, because "when is shaping worth it?" must have
    one answer: a joining script has no correct per-character rendering at
    all, so its shaped run always wins; anything else wins only when
    `changed_it` says so. A face that cannot express the word returns None —
    the character path then refuses it BY NAME, which is the honest floor and
    not this function's call to make."""
    if not word:
        return None
    joins = requires_shaping(word)
    # Direction comes from the TEXT, never from "does it join". Hebrew joins
    # nothing but is still right-to-left, and shaping it left-to-right hands
    # back a reversed glyph stream; Mongolian joins and is left-to-right, and
    # shaping it right-to-left hands back the same reversal.
    try:
        run = shape(face_path, word, rtl=shapes_right_to_left(word))
    except ValueError:
        return None
    if joins:
        return run
    return run if changed_it(run, word) else None


def can_shape_in_place(font_dict) -> bool:
    """Whether a document's own font can drive the shaper AND accept the
    result as character codes: it must be Type0/Identity-H with an Identity
    CIDToGIDMap (so a glyph id IS the two-byte code), carry an embedded
    program, and that program must still have both a unicode cmap (to map
    the letters in) and a GSUB table (to do the joining). Subsetters
    routinely drop one or both — a PDF that draws Arabic by glyph id has no
    use for either — and when they do, the run must substitute instead."""
    try:
        if str(font_dict.get("/Subtype", "")) != "/Type0":
            return False
        if str(font_dict.get("/Encoding", "")) != "/Identity-H":
            return False
        descendants = font_dict.get("/DescendantFonts")
        if descendants is None or len(descendants) != 1:
            return False
        desc = descendants[0]
        if str(desc.get("/CIDToGIDMap", "/Identity")) != "/Identity":
            return False
        fd = desc.get("/FontDescriptor")
        if fd is None:
            return False
        for key in ("/FontFile2", "/FontFile3", "/FontFile"):
            if key in fd:
                break
        else:
            return False
        return True
    except Exception:
        return False


def program_bytes(font_dict) -> bytes | None:
    """The embedded font program of a Type0 font, or None."""
    try:
        desc = font_dict["/DescendantFonts"][0]["/FontDescriptor"]
        for key in ("/FontFile2", "/FontFile3", "/FontFile"):
            if key in desc:
                return bytes(desc[key].read_bytes())
    except Exception:
        return None
    return None


def in_place_face(font_dict) -> str | None:
    """The document font's OWN program as a shapeable temp file, or None.

    `can_shape_in_place` checks the PDF-side shape (Type0/Identity-H,
    Identity CIDToGIDMap, an embedded program); this extracts the program
    and checks the FONT-side half: it must still carry a unicode cmap (to
    map the letters in) and a GSUB table (to do the joining). Subsetters
    routinely drop both — a PDF that draws Arabic by glyph id has no use
    for either — and HarfBuzz without GSUB happily produces ISOLATED forms,
    which is broken output wearing a working font's name. So GSUB absence
    means None here, never a degraded shape.

    The caller owns the returned temp file and must unlink it."""
    import tempfile

    from fontTools.ttLib import TTFont

    if not can_shape_in_place(font_dict):
        return None
    raw = program_bytes(font_dict)
    if not raw:
        return None
    tmp = tempfile.NamedTemporaryFile(suffix=".ttf", delete=False)
    try:
        tmp.write(raw)
        tmp.close()
        tt = TTFont(tmp.name, fontNumber=0, lazy=True)
        try:
            ok = "GSUB" in tt and bool(tt.getBestCmap())
        finally:
            tt.close()
        if ok:
            return tmp.name
    except Exception:
        pass
    try:
        os.unlink(tmp.name)
    except OSError:
        pass
    return None


def shape_vertical(face_path: str, ch: str):
    """(glyph name, vertical advance per 1000/em) for ONE character drawn
    top-to-bottom, or None when the face cannot express it.

    Shaping with the buffer running `ttb` is what reaches the font's
    vertical machinery: the `vert`/`vrt2` GSUB features swap in the upright
    forms (a comma becomes its vertical variant, brackets rotate) and the
    advance comes from `vmtx` as a NEGATIVE `y_advance`. Neither is
    reachable by a cmap lookup, which is why "no vertical face is bundled"
    stayed true for as long as there was no shaper to ask.

    Per CHARACTER on purpose: vertical text advances glyph by glyph and
    forms no cross-character ligatures, so this is exact and keeps the
    code→character map one to one — which is what lets the embed carry an
    ordinary /ToUnicode."""
    import uharfbuzz as hb

    font, upem = _hb_font(face_path)
    order = _glyph_order(face_path)
    buf = hb.Buffer()
    buf.add_str(ch)
    buf.guess_segment_properties()
    buf.direction = "ttb"
    hb.shape(font, buf)
    infos = list(buf.glyph_infos)
    positions = list(buf.glyph_positions)
    if len(infos) != 1 or infos[0].codepoint == 0 or infos[0].codepoint >= len(order):
        return None
    scale = 1000.0 / (upem or 1000)
    advance = positions[0].y_advance * scale
    if advance == 0:
        # A zero vertical advance would stack every glyph on one spot. The
        # face's em is the honest default and what a CJK face's `DW2` says.
        advance = -1000.0
    return order[infos[0].codepoint], advance


@lru_cache(maxsize=32)
def vertical_forms(face_path: str) -> dict:
    """The face's `vert`/`vrt2` glyph→glyph map, read straight out of GSUB.

    `vert` is by OpenType definition a SINGLE substitution: one glyph in, one
    glyph out, the upright variant of a mark that would otherwise lie on its
    side in a column (a 、, a 「, a bracket). Reading the lookup itself is
    therefore exact and positional by construction.

    A second top-to-bottom shaping pass is not a substitute: it may select
    different cursive positional forms or ligatures and is not positionally
    comparable with the original run. Reading the GSUB feature limits this
    map to the substitutions the font explicitly defines."""
    from fontTools.ttLib import TTFont

    out: dict[str, str] = {}
    try:
        tt = TTFont(face_path, fontNumber=0, lazy=True)
    except Exception:
        return out
    try:
        gsub = tt.get("GSUB")
        if gsub is None or gsub.table is None:
            return out
        table = gsub.table
        wanted: set[int] = set()
        for rec in table.FeatureList.FeatureRecord:
            if rec.FeatureTag in ("vert", "vrt2"):
                wanted.update(rec.Feature.LookupListIndex)
        for index in sorted(wanted):
            lookup = table.LookupList.Lookup[index]
            for sub in lookup.SubTable:
                mapping = getattr(sub, "mapping", None)
                if mapping:
                    out.update(mapping)
    except Exception:
        return {}
    finally:
        tt.close()
    return out


@lru_cache(maxsize=32)
def _hmtx_1000(face_path: str) -> dict:
    """glyph name → horizontal advance per 1000/em."""
    from fontTools.ttLib import TTFont

    tt = TTFont(face_path, fontNumber=0, lazy=True)
    try:
        upem = tt["head"].unitsPerEm or 1000
        return {
            name: adv * 1000.0 / upem for name, (adv, _lsb) in tt["hmtx"].metrics.items()
        }
    finally:
        tt.close()


def shape_sideways(face_path: str, text: str) -> ShapedRun:
    """Shape ONE word for a COLUMN of a script whose font stores horizontal
    glyphs.

    A Mongolian (or Phags-pa, or Soyombo) column is not `-V`-CMap vertical
    text: the face has no honest vertical metric to embed, the glyphs are the
    horizontal ones, and the column is produced by ROTATING the run. So the
    glyphs, the clusters and the advances all come from an ordinary
    directional shape — and the ONE thing a column still owes the reader is
    the face's own upright punctuation, which is `vert`.

    Raises ValueError when a substituted glyph has no `hmtx` entry: the
    advance is what the column's length is measured from, and inventing one
    is the defect wearing a different hat."""
    run = shape(face_path, text, rtl=shapes_right_to_left(text))
    vmap = vertical_forms(face_path)
    if not vmap or not any(name in vmap for name, _a, _x, _y in run.glyphs):
        return run
    widths = _hmtx_1000(face_path)
    glyphs = []
    total = 0.0
    for name, adv, x_off, y_off in run.glyphs:
        sub = vmap.get(name)
        if sub is None:
            glyphs.append((name, adv, x_off, y_off))
            total += adv
            continue
        if sub not in widths:
            raise ValueError(
                f"this font's vertical form of {name!r} has no advance"
            )
        glyphs.append((sub, widths[sub], x_off, y_off))
        total += widths[sub]
    clusters = [
        (vmap.get(name, name), spells) for name, spells in run.clusters
    ]
    return ShapedRun(run.text, glyphs, total, clusters)


def face_can_shape(face_path: str, text: str) -> bool:
    """Whether `face_path` shapes `text` without hitting `.notdef` — the
    ladder's probe, so a face that merely CONTAINS the letters but not their
    joining forms is not mistaken for a working one.

    The probe runs in the TEXT's own direction. It used to take
    `shape`'s right-to-left default, which is correct for every joining
    script but Mongolian — and a probe that shapes backwards answers about a
    run nobody will draw.

    Structural whitespace is a line break, not a glyph: it never embeds and
    is never shaped, so the probe must not ask the face about it. It used to,
    and the face answered `.notdef` — which failed the probe for every
    MULTI-LINE box mixing a joining script with anything else, sent the
    resolution back to a Latin face, and turned into "the fallback font
    cannot express" for text a bundled face draws perfectly on one line. The
    substitution keeps the word boundaries the per-word shaping relies on."""
    probe = text.translate({0x0A: " ", 0x0D: " ", 0x09: " "})
    try:
        shape(face_path, probe, rtl=shapes_right_to_left(probe))
        return True
    except Exception:
        return False
