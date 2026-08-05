"""Per-run text measurement — the ONE geometry authority for the content
walkers (F15 slice A).

Until this module existed there were TWO answers to "how wide is this show
operator": `text_runs.py` decoded the run through its font and summed the real
advances (+ TJ kern, Tc, Tw, Tz), while `redact.py` guessed a flat 0.5 em per
BYTE. The guess was a **redaction false negative** — measured against the
shipped engine, one 45-character line at 11 pt:

    Courier         real 297.0 pt   estimate 247.5 pt   est/real 0.83
    Helvetica-Bold  real 263.5      estimate 247.5      est/real 0.94
    Helvetica       real 255.6      estimate 247.5      est/real 0.97
    a 2-byte CID font                                   est/real 2.00

so on every monospace document the last sixth of each line sat OUTSIDE the
bbox redaction tested against: a mark drawn on that text reported
`regions_applied: 1, text_runs_removed: 0` and the words stayed extractable.
The CID direction is the mirror — a mark 10 pt clear of a CJK run deleted it.

The fix is a deletion, not an invention: the real computation already lived in
the lister's walk with the same `GraphicsTextState`. It moved here so both
walkers call it, and `AVG_CHAR_ADVANCE_EM` is gone.

Two things a security walker needs that a lister does not, and they are the
reason this module has a surface of its own:

  - **`FontCapability.measures()`** — whether the advances are DECLARED or
    defaulted. A width that falls back to the 500/1000 placeholder is a guess,
    and a guess that comes out narrow is the same false negative in a new
    costume. An unmeasurable run gets `wide_width()` instead: 1 em per CODE,
    which over-covers every real face (over-removal is the tolerable error for
    a redaction tool; under-removal is not).
  - **`ink_extent_em()`** — the run's VERTICAL extent from the font's own
    descriptor. The lister's rect is baseline → baseline + font size, which is
    the right box to CLICK but the wrong box to test ink against: measured at
    12 pt Helvetica it misses 2.48 pt of descender below the baseline (`p`,
    `g`, `y`, `j`, `q`) and adds 2.48 pt of empty leading above. A band drawn
    across the descenders of a line missed the bbox entirely.
"""

from typing import NamedTuple, Optional

from pdfminer.fontmetrics import FONT_METRICS
from pikepdf import Name

from engine.content_walk import GraphicsTextState
from engine.pdf_fonts import FontCapability, _strip_subset_prefix, font_capability

# Vertical extent used when the font declares neither /Ascent//Descent nor a
# /FontBBox and is not one of the base-14 faces. Deliberately WIDER than any
# common face (Helvetica is 0.931/0.225) — the unmeasured direction is the
# fail-wide one.
FALLBACK_ABOVE_EM = 1.0
FALLBACK_BELOW_EM = 0.30

# Advance assumed per CODE when the run's widths cannot be measured. One em is
# an upper bound for every ordinary face (a full-width CJK glyph is exactly
# 1 em; Latin glyphs are well under it), so the resulting bbox over-covers.
UNMEASURED_ADVANCE_EM = 1.0


# ── font resolution (cached per call) ─────────────────────────────────────


def _lookup_font(name, resources, fallback_resources):
    for res in (resources, fallback_resources):
        if res is None:
            continue
        fonts = res.get("/Font")
        if fonts is not None and Name(name) in fonts:
            return fonts[Name(name)]
    return None


class _FontCache:
    def __init__(self):
        self._by_key: dict = {}
        self._ink: dict = {}

    @staticmethod
    def _key(font_obj, resources, fallback_resources, name):
        # Key on stable identity ONLY. `objgen` is value-based for indirect
        # fonts; a DIRECT font dict's wrapper is a fresh pikepdf object per
        # access, so id(font_obj) recycles across GC and served a STALE
        # OTHER FONT's capability — review-measured at 22.6% wrong lookups
        # in an alternating-font walk, and on replace it would encode the
        # user's text with the wrong font's table into the saved file. The
        # resources dicts are stable Python references for the whole walk
        # scope, so (resources ids + name) is a sound direct-font key.
        try:
            is_indirect = bool(font_obj.is_indirect)
        except AttributeError:
            is_indirect = False
        return (
            ("obj", font_obj.objgen)
            if is_indirect
            else ("direct", id(resources), id(fallback_resources), str(name))
        )

    def capability(self, resources, fallback_resources, name) -> Optional[FontCapability]:
        if not name:
            return None
        font_obj = _lookup_font(name, resources, fallback_resources)
        if font_obj is None:
            return None
        key = self._key(font_obj, resources, fallback_resources, name)
        if key not in self._by_key:
            try:
                self._by_key[key] = font_capability(font_obj)
            except Exception as exc:  # a malformed font dict refuses, never crashes
                self._by_key[key] = FontCapability(
                    False, f"unreadable font ({exc})", {}, {}, {}, 500.0, 1
                )
        return self._by_key[key]

    def ink_extent(self, resources, fallback_resources, name) -> tuple[float, float]:
        """(below_em, above_em) for the named font — the run's real vertical
        ink extent, relative to the baseline. Falls WIDE when unknown."""
        if not name:
            return (FALLBACK_BELOW_EM, FALLBACK_ABOVE_EM)
        font_obj = _lookup_font(name, resources, fallback_resources)
        if font_obj is None:
            return (FALLBACK_BELOW_EM, FALLBACK_ABOVE_EM)
        key = self._key(font_obj, resources, fallback_resources, name)
        if key not in self._ink:
            try:
                self._ink[key] = ink_extent_em(font_obj)
            except Exception:
                self._ink[key] = (FALLBACK_BELOW_EM, FALLBACK_ABOVE_EM)
        return self._ink[key]


# ── vertical ink extent ───────────────────────────────────────────────────


def _num(value) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _descriptor_of(font_obj):
    """The /FontDescriptor of a simple font, or of a composite font's first
    descendant (that is where a Type0's metrics live)."""
    desc = font_obj.get("/FontDescriptor")
    if desc is not None:
        return desc
    descendants = font_obj.get("/DescendantFonts")
    try:
        if descendants is not None and len(descendants) > 0:
            return descendants[0].get("/FontDescriptor")
    except (TypeError, ValueError):
        pass
    return None


def _extent_from(ascent, descent, bbox) -> tuple[Optional[float], Optional[float]]:
    """(below, above) in 1000/em from an /Ascent, /Descent and /FontBBox, each
    optional. The FontBBox is the union of every glyph's ink, so where both are
    present the WIDER of the two is the honest bound."""
    above = _num(ascent)
    dsc = _num(descent)
    below = None if dsc is None else -dsc
    try:
        if bbox is not None:
            ys = [float(bbox[1]), float(bbox[3])]
            below = max(below, -min(ys)) if below is not None else -min(ys)
            above = max(above, max(ys)) if above is not None else max(ys)
    except (TypeError, ValueError, IndexError):
        pass
    return below, above


def ink_extent_em(font_obj) -> tuple[float, float]:
    """(below_em, above_em): how far a glyph's ink reaches below and above the
    baseline, as a fraction of the font size.

    Read from the font's own /FontDescriptor, else from the base-14 AFM tables
    pdfminer bundles, else the deliberately-wide fallback. Never returns a
    NEGATIVE extent — a font declaring a positive /Descent (some do) would
    otherwise shrink the box above the baseline."""
    desc = _descriptor_of(font_obj)
    below = above = None
    if desc is not None:
        below, above = _extent_from(
            desc.get("/Ascent"), desc.get("/Descent"), desc.get("/FontBBox")
        )
    if below is None or above is None:
        base = _strip_subset_prefix(str(font_obj.get("/BaseFont", "")).lstrip("/"))
        metrics = FONT_METRICS.get(base)
        if metrics is not None:
            props = metrics[0]
            afm_below, afm_above = _extent_from(
                props.get("Ascent"), props.get("Descent"), props.get("FontBBox")
            )
            below = below if below is not None else afm_below
            above = above if above is not None else afm_above
    below = FALLBACK_BELOW_EM * 1000.0 if below is None else below
    above = FALLBACK_ABOVE_EM * 1000.0 if above is None else above
    return (max(below, 0.0) / 1000.0, max(above, 0.0) / 1000.0)


# ── show-op decoding + width ──────────────────────────────────────────────


def _operand_bytes(el) -> bytes:
    try:
        return bytes(el)
    except (TypeError, ValueError):
        return b""


def _show_segments(operator: str, operands: list) -> list:
    """The show op's content as [bytes | float] — strings and (for TJ)
    kern numbers, in order."""
    if operator == "TJ":
        arr = operands[0] if operands else []
        out: list = []
        try:
            for el in arr:
                try:
                    out.append(float(el))
                except (TypeError, ValueError):
                    out.append(_operand_bytes(el))
        except TypeError:
            return []
        return out
    return [_operand_bytes(operands[-1])] if operands else []


def show_bytes(operator: str, operands: list) -> bytes:
    """Every CODE byte the operator draws, concatenated — the string the
    capability's codespace walk is asked about."""
    return b"".join(
        seg for seg in _show_segments(operator, operands) if not isinstance(seg, float)
    )


def _spaces_in(data: bytes, cap: FontCapability) -> int:
    # Tw applies to the SINGLE-BYTE code 32 only (spec) — never CID fonts,
    # and never a multi-byte code that merely CONTAINS 0x20 (9.T10: a
    # Shift-JIS trail byte can be 0x20-adjacent, so counting raw bytes would
    # invent word spacing mid-character).
    if not cap.single_byte_codes():
        return 0
    return data.count(0x20)


def _run_metrics(
    operator: str, operands: list, cap: Optional[FontCapability], state: GraphicsTextState
) -> tuple[str, float]:
    """(decoded_text, raw_width) where raw_width is in TEXT-SPACE units
    BEFORE Tz (advance_after_show applies h_scale)."""
    text_parts: list[str] = []
    width = 0.0
    for seg in _show_segments(operator, operands):
        if isinstance(seg, float):
            width -= seg / 1000.0 * state.font_size
            continue
        if cap is not None:
            text_parts.append(cap.decode(seg))
            width += cap.decoded_width(seg) / 1000.0 * state.font_size
            n_codes = cap.code_count(seg)
            width += state.char_spacing * n_codes
            width += state.word_spacing * _spaces_in(seg, cap)
        else:
            width += len(seg) * state.font_size * 0.5  # no font: a bare guess
    return "".join(text_parts), width


class ShowItem(NamedTuple):
    """One indivisible piece of a show operator: a drawn CODE, or a TJ number.

    `x` is the pen offset at the piece's start and `advance` what it adds, both
    in TEXT-SPACE units before Tz — the same space `_run_metrics` sums in, so
    `sum(item.advance for item in show_items(...))` equals its width.
    """

    kern: bool
    data: bytes  # the code's own bytes; b"" for a kern
    number: float  # the TJ number; 0.0 for a code
    advance: float
    x: float


def show_items(
    operator: str, operands: list, cap: FontCapability, state: GraphicsTextState
) -> list[ShowItem]:
    """A show operator decomposed per CODE (F15 slice B).

    The split points are the codespace's own — `FontCapability.codes()` is
    "the ONE place the codespace is interpreted" — so a code is never cut in
    half and a LIGATURE, which is one code spelling several characters, is
    structurally unsplittable here (T25 rule 2: what a glyph spells is a
    property of the (glyph, cluster) pair, and a caller that re-split decoded
    text could only guess). Caller must have checked `measurable()`; the
    advances are meaningless otherwise.
    """
    return show_items_from_segments(_show_segments(operator, operands), cap, state)


def show_items_from_segments(
    segments: list, cap: FontCapability, state: GraphicsTextState
) -> list[ShowItem]:
    """`show_items` for a caller that already holds the segments (F15 slice C).

    The run LISTER's detail channel carries `segments` detached from pikepdf so
    an analysis can outlive the walk; re-deriving them from operands the walk no
    longer has would mean a second decomposition of the same operator, which is
    exactly the two-answers-to-one-question shape slice A deleted.
    """
    items: list[ShowItem] = []
    x = 0.0
    tw_applies = cap.single_byte_codes()
    for seg in segments:
        if isinstance(seg, float):
            advance = -seg / 1000.0 * state.font_size
            items.append(ShowItem(True, b"", float(seg), advance, x))
            x += advance
            continue
        offset = 0
        for _code, n in cap.codes(seg):
            raw = seg[offset : offset + n]
            offset += n
            advance = cap.decoded_width(raw) / 1000.0 * state.font_size
            advance += state.char_spacing
            if tw_applies and raw == b" ":
                advance += state.word_spacing
            items.append(ShowItem(False, raw, 0.0, advance, x))
            x += advance
    return items


def show_clusters(items: list[ShowItem]) -> list[list[int]]:
    """Group `show_items` into the units a split may fall BETWEEN.

    A cluster is one advancing glyph plus every zero-advance glyph that follows
    it and the kerns around them. T25 rules 3 and 4: a combining mark carries
    its horizontal offset as jump / zero-advance glyph / jump back, so cutting
    between a base and its mark would strand the mark on the wrong side of the
    redaction — and the jump routinely exceeds half a space, which is why the
    grouping is by ADVANCE rather than by any notion of what the codes spell.
    """
    clusters: list[list[int]] = []
    i = 0
    n = len(items)
    while i < n:
        start = i
        while i < n and items[i].kern:  # leading kerns join this cluster
            i += 1
        if i >= n:
            # Trailing kerns own no glyph — they ride with the last cluster so
            # that removing it removes their displacement too.
            if clusters:
                clusters[-1].extend(range(start, n))
            else:
                clusters.append(list(range(start, n)))
            break
        i += 1  # the base glyph
        while True:
            j = i
            while j < n and items[j].kern:
                j += 1
            if j < n and not items[j].kern and items[j].advance == 0.0:
                i = j + 1  # a zero-advance mark: same cluster, with its kerns
                while i < n and items[i].kern:
                    i += 1  # …and the jump BACK that pairs with the jump out
                continue
            break
        clusters.append(list(range(start, i)))
    return clusters


def cluster_span(items: list[ShowItem], cluster: list[int]) -> tuple[float, float]:
    """(x0, x1) of the ink a cluster draws, in pre-Tz text space. Kerns move
    the pen but draw nothing, so only glyph items contribute — a cluster whose
    mark sits 400/1000 em to the left of its base spans both."""
    xs: list[float] = []
    for index in cluster:
        item = items[index]
        if item.kern:
            continue
        xs.append(item.x)
        xs.append(item.x + item.advance)
    if not xs:
        anchor = items[cluster[0]].x if cluster else 0.0
        return (anchor, anchor)
    return (min(xs), max(xs))


def measurable(cap: Optional[FontCapability], data: bytes) -> bool:
    """Can this run's advances be taken from the font rather than guessed?

    Deliberately NOT `cap.editable`: whether text can be re-entered and how
    wide it is are independent questions, and a CID font with no /ToUnicode
    still declares every advance in /W. `measures()` asks the narrow question
    — is every drawn code's width DECLARED, or does some of it come from the
    500/1000 placeholder — and the placeholder is the same guess this module
    deleted."""
    return cap is not None and cap.measures(data)


def wide_width(
    operator: str, operands: list, cap: Optional[FontCapability], state: GraphicsTextState
) -> float:
    """A deliberately-generous advance for a run whose font cannot measure it.

    1 em per CODE (an upper bound for real faces), plus positive Tc/Tw only —
    a NEGATIVE spacing narrows the real run, and ignoring it keeps the estimate
    on the over-covering side. Forward TJ jumps (negative numbers) push the
    run's right edge out and ARE counted; backward ones are ignored for the
    same reason. This is the R2 fail-closed direction: for a redaction tool the
    tolerable error is removing too much."""
    return wide_width_from_segments(_show_segments(operator, operands), cap, state)


def wide_width_from_segments(
    segments: list, cap: Optional[FontCapability], state: GraphicsTextState
) -> float:
    """`wide_width` for a caller holding the lister's detached segments."""
    width = 0.0
    for seg in segments:
        if isinstance(seg, float):
            width += max(-seg / 1000.0 * state.font_size, 0.0)
            continue
        n_codes = cap.code_count(seg) if cap is not None else len(seg)
        width += n_codes * state.font_size * UNMEASURED_ADVANCE_EM
        width += max(state.char_spacing, 0.0) * n_codes
        spaces = _spaces_in(seg, cap) if cap is not None else seg.count(0x20)
        width += max(state.word_spacing, 0.0) * spaces
    return width


# ── form inheritance ──────────────────────────────────────────────────────


def _child_state(base_ctm, parent: Optional[GraphicsTextState]) -> GraphicsTextState:
    """A form's stream starts with the INVOKING stream's text parameters —
    font, size, leading, Tz, Tc/Tw (and 7.5's Tr/Ts/colors) are graphics
    state a form inherits at its Do (the _redact_form rule); tm/tlm reset
    per stream."""
    if parent is None:
        return GraphicsTextState(base_ctm)
    child = GraphicsTextState(
        base_ctm, parent.font_size, parent.leading, parent.h_scale, parent.font_name
    )
    child.char_spacing = parent.char_spacing
    child.word_spacing = parent.word_spacing
    child.render_mode = parent.render_mode
    child.rise = parent.rise
    child.fill_color = parent.fill_color
    child.stroke_color = parent.stroke_color
    return child
