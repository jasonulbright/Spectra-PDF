"""Query → GLYPH-ACCURATE page regions (F15 slice C).

`search_in_files` answers "which pages match"; the in-app index answers the
same question faster. Neither returns a RECTANGLE, and a redaction tool that
cannot say WHERE a hit is cannot mark it. This module is the door that can.

**The rect authority is the engine's own run walk, sliced per CODE**, measured
exact: against pdfminer's own per-character geometry, the computed rect of
`"John Smith"` inside a 41-character Helvetica run came out

    computed  [72.0, 700.0, 132.02, 712.0]
    pdfminer  [72.0, 697.52, 132.02, 709.52]     dx0 +0.00  dx1 +0.00 pt

— horizontally exact to the hundredth of a point, and vertically off by
exactly the difference between an EM box and an INK box. The search worker has
no geometry at all, and a pdf.js text item carries one width for the whole
item with no per-character breakdown, so interpolating inside it is wrong for
every proportional font. "Approximately right" is not a thing a redaction rect
may be, so neither of those is the authority.

Five rules, each earned in recon (brief § 3):

1. **The match runs on THIS walk's own concatenation of the page's runs**, so
   a match offset maps back to (run, code index) by construction. Matching in
   the renderer and geometrising here would need the two to agree about the
   page's text down to the character, and they do not — pdfminer's layout
   order, pdf.js's item order and the stream's own order all differ.
2. **The rect is the per-code slice, adjusted to the font's INK extent** —
   `text_metrics.ink_extent_em`, the same descent/ascent redaction's own bbox
   uses since slice A. A run rect drawn baseline → baseline + size leaves the
   descenders of `p g y j q` visible under the black box.
3. **A hit spanning several runs yields ONE RECT PER RUN**, never a bounding
   box across them: a phrase broken over a line wrap would otherwise cover the
   right margin, the left margin and everything between.
4. **Rotation and nested forms fall out of the walk** — `_walk_runs` composes
   `tm ∘ ctm` and recurses into form XObjects with the form matrix, so the
   rect is already in page space. A run clipped entirely away is invisible and
   is not offered as a hit.
5. **Vertical runs (9.B4a) are honoured, not excluded** — the lister emits a
   vertical run's column rect and the per-code slice is a vertical slice.
   Refusing CJK vertical text would be a whole document class that cannot be
   redacted.

A run whose font cannot MEASURE (slice A's `measurable()`) still produces a
hit: its FULL rect, flagged `imprecise`, over-covering rather than guessing a
slice — never a dropped hit, because a hit the tool does not report is content
the user does not redact.
"""

from __future__ import annotations

import math
import re
import unicodedata
from typing import NamedTuple, Optional

import pikepdf

from engine.content_walk import GraphicsTextState
from engine.redact import IDENTITY, _resolve_resources, _span_bbox
from engine.text_match import (
    compile_matcher,
    compile_terms,
    compiled_pattern,
    finditer_nonempty,
    normalize_index_text,
    pattern_spans,
    snippet,
)
from engine.text_metrics import (
    _FontCache,
    measurable,
    show_items_from_segments,
    wide_width_from_segments,
)
from engine.text_runs import _walk_runs
from engine.validate import validate_pdf

# A forward gap of at least this fraction of the writing font's space advance
# reads as a word break. `text_paragraphs.WORD_GAP_FRACTION`'s value and its
# reasoning — a generator that emits one `Tj` per word draws no space at all,
# and a search that cannot see the gap matches "JohnSmith" and misses "John
# Smith".
WORD_GAP_FRACTION = 0.5

# Space advance assumed when the font cannot express a space (symbol fonts,
# subsetted faces that dropped it). text_paragraphs' FALLBACK_SPACE_1000.
FALLBACK_SPACE_1000 = 250.0

# Baseline clustering window, in ems of the larger run — the same tolerance
# the paragraph lister uses to decide two runs share a line.
BASELINE_TOL_EM = 0.12

MAX_HITS_DEFAULT = 50000


class _Unit(NamedTuple):
    """One drawn CODE, with where it sits and what it spells."""

    run: int
    item: int  # index into that run's show_items
    text: str


class _Run(NamedTuple):
    """One show operator, with everything a rect needs."""

    index: int
    combined: tuple
    state: GraphicsTextState
    ink: tuple
    vertical: bool
    items: list
    measured: bool
    cap: object
    text: str
    # The WHOLE run's box, computed exactly as redaction computes it — the
    # measured width for a measurable run, `wide_width` for one that is not.
    # Deliberately NOT the lister's rect: that is an EM box (a click target),
    # and a mark derived from it leaves the descenders visible.
    full_rect: list
    # Ordering: the writing direction as a rounded unit vector, and the pen's
    # position resolved onto (along, across) in that frame.
    direction: tuple
    along0: float
    along1: float
    across: float
    space_w: float


def _unit_vector(combined: tuple, vertical: bool) -> tuple[float, float]:
    """The direction the pen sweeps, in device space.

    Horizontal text advances along +x of text space — the matrix's (a, b).
    A vertical writing mode advances along −y — (−c, −d). Normalized so a
    scaled matrix and an unscaled one land in the same line group.
    """
    a, b, c, d, _e, _f = combined
    vx, vy = (-c, -d) if vertical else (a, b)
    norm = math.hypot(vx, vy)
    if norm < 1e-9:
        return (1.0, 0.0)
    return (vx / norm, vy / norm)


def _collect_runs(pdf, page) -> tuple[list[_Run], list[dict]]:
    """Walk the page with the LISTER's own walk (form recursion, clip
    tracking, rotation, vertical mode) and re-derive the per-code geometry
    each run needs. `detail` is the lister's rich channel, so run INDEX
    agreement with `list_text_runs` is by construction rather than by a
    parallel implementation."""
    resources = _resolve_resources(page)
    listing: list[dict] = []
    detail: list[dict] = []
    fonts = _FontCache()
    _walk_runs(
        pdf,
        pikepdf.parse_content_stream(page),
        resources,
        IDENTITY,
        0,
        None,
        listing,
        False,
        fonts,
        detail=detail,
    )

    runs: list[_Run] = []
    for index, (row, det) in enumerate(zip(listing, detail)):
        if row.get("clipped"):
            # A run wholly outside the active clip draws nothing a reader can
            # see, so offering it as a hit would mark an empty rectangle and
            # tell the user their term was there.
            continue
        cap = det["cap"]
        style = det["style"]
        state = GraphicsTextState(
            IDENTITY,
            font_size=style["size"],
            h_scale=style["h_scale"],
            font_name=style["font_name"],
        )
        state.char_spacing = style["char_spacing"]
        state.word_spacing = style["word_spacing"]
        state.rise = style["rise"]
        data = b"".join(s for s in det["segments"] if isinstance(s, bytes))
        measured = measurable(cap, data)
        items = (
            show_items_from_segments(det["segments"], cap, state) if measured else []
        )
        # `writes_vertical`, not the listing's `vertical`: a REFUSED
        # Identity-V font still draws its column downward, and a refused font
        # is precisely the unmeasurable case. Slice A's rule, one module over.
        vertical = bool(cap is not None and cap.writes_vertical)
        ink = fonts.ink_extent(det["resources"], det["fallback"], style["font_name"])
        combined = det["combined"]
        raw_width = (
            det["raw_width"]
            if measured
            else wide_width_from_segments(det["segments"], cap, state)
        )
        full_rect = [
            float(v)
            for v in _span_bbox(combined, 0.0, max(raw_width, 0.01), vertical, state, ink)
        ]
        dx, dy = _unit_vector(combined, vertical)
        _a, _b, _c, _d, e, f = combined
        along0 = e * dx + f * dy
        across = -e * dy + f * dx
        # The advance in DEVICE units: the run's text-space width scaled by
        # the matrix's own magnitude along the writing axis.
        scale = math.hypot(*(combined[2:4] if vertical else combined[0:2]))
        width = raw_width * (1.0 if vertical else style["h_scale"]) * scale
        space_1000 = (
            cap.char_width(" ")
            if (cap is not None and cap.can_encode(" "))
            else FALLBACK_SPACE_1000
        )
        space_w = (
            space_1000 / 1000.0 * style["size"]
            * (1.0 if vertical else style["h_scale"])
            * scale
        )
        runs.append(
            _Run(
                index=index,
                combined=combined,
                state=state,
                ink=ink,
                vertical=vertical,
                items=items,
                measured=measured,
                cap=cap,
                text=str(row.get("text") or ""),
                full_rect=full_rect,
                direction=(round(dx, 3), round(dy, 3)),
                along0=along0,
                along1=along0 + width,
                across=across,
                space_w=max(space_w, 1e-6),
            )
        )
    return runs, listing


def _order_runs(runs: list[_Run]) -> list[list[_Run]]:
    """Group runs into LINES and order them for reading.

    A line is runs sharing a writing direction whose baselines sit within
    `BASELINE_TOL_EM` of each other, ordered along the writing axis; lines are
    ordered by their perpendicular coordinate, decreasing — which is top-to-
    bottom for upright text and the correct reading order for a rotated or
    vertical frame too, because the frame is what "perpendicular" is measured
    in. Stream order is NOT reading order: a generator is free to draw a
    footer before its body, and a phrase that wraps must still be findable.
    """
    by_direction: dict[tuple, list[_Run]] = {}
    for run in runs:
        by_direction.setdefault(run.direction, []).append(run)
    lines: list[list[_Run]] = []
    for group in by_direction.values():
        clusters: list[list[_Run]] = []
        for run in sorted(group, key=lambda r: -r.across):
            placed = False
            for cluster in clusters:
                ref = cluster[0]
                tol = BASELINE_TOL_EM * max(
                    ref.state.font_size, run.state.font_size, 0.01
                )
                if abs(run.across - ref.across) <= tol:
                    cluster.append(run)
                    placed = True
                    break
            if not placed:
                clusters.append([run])
        for cluster in clusters:
            cluster.sort(key=lambda r: r.along0)
            lines.append(cluster)
    lines.sort(key=lambda line: -max(r.across for r in line))
    return lines


def _page_text(runs: list[_Run]) -> tuple[str, list[Optional[_Unit]]]:
    """The page's text as this walk reads it, plus one map entry per CHARACTER
    back to the code that drew it.

    Whitespace is synthesized where the geometry says a word ended: between
    runs on a line whose gap exceeds `WORD_GAP_FRACTION` of the space advance,
    at every line break, and inside a run at a forward TJ jump big enough to
    be a gap. T25 rules 3 and 4 hold here as they do in the reflow — a jump
    onto a glyph that SPELLS NOTHING is mark positioning, and a run that draws
    no text cannot be one side of a word gap.

    The map is what makes the offsets usable: NFKC can expand one code into
    several characters (a `ﬁ` ligature spells `fi`), so every character the
    normalization produces points back at the code that drew it, and searching
    `fi` marks the ligature glyph.
    """
    chars: list[str] = []
    origin: list[Optional[_Unit]] = []

    def emit(text: str, unit: Optional[_Unit]) -> None:
        for ch in text:
            chars.append(ch)
            origin.append(unit)

    lines = _order_runs(runs)
    for line_index, line in enumerate(lines):
        if line_index > 0:
            emit(" ", None)
        previous: Optional[_Run] = None
        for run in line:
            if previous is not None:
                gap = run.along0 - previous.along1
                if gap >= WORD_GAP_FRACTION * previous.space_w:
                    emit(" ", None)
            cap = run.cap
            if not run.measured or cap is None:
                # No per-code geometry: the whole run is one unit. Its text
                # still participates in matching — dropping it would hide the
                # hit rather than over-cover it.
                emit(run.text, _Unit(run.index, -1, run.text))
                previous = run
                continue
            pending_gap = 0.0
            drew_text = False
            for item_index, item in enumerate(run.items):
                if item.kern:
                    if item.advance > 0:
                        pending_gap += item.advance
                    continue
                text = cap.decode(item.data)
                if pending_gap > 0 and drew_text and text.strip():
                    # Rule 3: a jump onto a glyph that spells nothing is mark
                    # positioning. Rule 4: a run that has drawn no text yet
                    # has no space width to compare against.
                    threshold = WORD_GAP_FRACTION * (
                        cap.char_width(" ")
                        if cap.can_encode(" ")
                        else FALLBACK_SPACE_1000
                    ) / 1000.0 * run.state.font_size
                    if threshold > 0 and pending_gap >= threshold:
                        emit(" ", None)
                pending_gap = 0.0
                if text:
                    emit(text, _Unit(run.index, item_index, text))
                    if text.strip():
                        drew_text = True
            previous = run

    return _normalize_with_map(chars, origin)


def _normalize_with_map(
    chars: list[str], origin: list[Optional[_Unit]]
) -> tuple[str, list[Optional[_Unit]]]:
    """`normalize_index_text` applied CHARACTER BY CHARACTER, carrying the map.

    Per character rather than over the joined string because the map has to
    survive: NFKC on a whole string can reorder and recombine across
    boundaries, and a map that no longer lines up with the text is worse than
    no map — it would put the redaction mark on the wrong glyph.
    """
    out_chars: list[str] = []
    out_origin: list[Optional[_Unit]] = []
    for ch, unit in zip(chars, origin):
        if ch == "­":
            continue
        for expanded in unicodedata.normalize("NFKC", ch):
            out_chars.append(expanded)
            out_origin.append(unit)
    # Whitespace collapse + trim, carrying the map.
    collapsed: list[str] = []
    collapsed_origin: list[Optional[_Unit]] = []
    in_space = True  # leading whitespace is dropped (the trim's front half)
    for ch, unit in zip(out_chars, out_origin):
        if ch.isspace() or ch in ("​", "﻿"):
            if not in_space:
                collapsed.append(" ")
                collapsed_origin.append(unit)
                in_space = True
            continue
        in_space = False
        collapsed.append(ch)
        collapsed_origin.append(unit)
    while collapsed and collapsed[-1] == " ":
        collapsed.pop()
        collapsed_origin.pop()
    return "".join(collapsed), collapsed_origin


def _expand_span(text: str, start: int, end: int, expand: str) -> tuple[int, int]:
    """Grow a match to what the user asked to MARK.

    `match` marks exactly what matched — the default, because the mode toggles
    are how the user says "only the whole word" and answering that question
    for them silently is not this tool's place. `word` grows to the
    whitespace-delimited word containing the match (searching `smith` and
    wanting `Smithers` fully covered). `line` is handled per RUN by the
    caller, where the run's own extent lives.
    """
    if expand != "word":
        return start, end
    while start > 0 and not text[start - 1].isspace():
        start -= 1
    while end < len(text) and not text[end].isspace():
        end += 1
    return start, end


def _rects_for_span(
    runs_by_index: dict, origin: list, start: int, end: int, expand: str
) -> list[dict]:
    """One rect per RUN the span touches (rule 3), each the per-code slice of
    that run's own ink."""
    per_run: dict[int, list[int]] = {}
    order: list[int] = []
    for unit in origin[start:end]:
        if unit is None:
            continue
        if unit.run not in per_run:
            per_run[unit.run] = []
            order.append(unit.run)
        per_run[unit.run].append(unit.item)

    rects: list[dict] = []
    for run_index in order:
        run = runs_by_index[run_index]
        items = per_run[run_index]
        whole = (not run.measured) or (-1 in items) or expand == "line"
        if whole:
            rects.append(
                {
                    "run": run_index,
                    "rect": list(run.full_rect),
                    "codes": [0, max(len(run.items) - 1, 0)],
                    "partial": False,
                    "imprecise": not run.measured,
                }
            )
            continue
        first, last = min(items), max(items)
        rects.append(
            {
                "run": run_index,
                "rect": _slice_rect(run, first, last),
                "codes": [first, last],
                "partial": not (first == 0 and last == len(run.items) - 1),
                "imprecise": False,
            }
        )
    return rects


def _slice_rect(run: _Run, first: int, last: int) -> list[float]:
    """The device rect of codes [first…last] of a run — the per-code advance
    slice, given the font's own ink extent above and below the baseline."""
    xs: list[float] = []
    for index in range(first, min(last, len(run.items) - 1) + 1):
        item = run.items[index]
        if item.kern:
            continue
        xs.append(item.x)
        xs.append(item.x + item.advance)
    if not xs:
        return list(run.full_rect)
    x0, x1 = min(xs), max(xs)
    return [
        float(v)
        for v in _span_bbox(run.combined, x0, x1, run.vertical, run.state, run.ink)
    ]


def _page_numbers(pages, pdf) -> list[int]:
    """The 1-based pages to search. Spelled with `page_no` and
    `len(pdf.pages)` deliberately: the out-of-range refusal is already a
    shared row in `locales/engine-messages.tsv`, and the sweep canonicalizes a
    group by its alphabetically first template — so a differently-named local
    here would silently RENAME the interpolations in a message seven other
    modules raise, orphaning every translation of it."""
    if pages is None or pages == "all":
        return list(range(1, len(pdf.pages) + 1))
    if isinstance(pages, str):
        raise ValueError('pages must be a list of page numbers or "all"')
    out: list[int] = []
    for value in pages:
        page_no = int(value)
        if not (1 <= page_no <= len(pdf.pages)):
            raise ValueError(f"page {page_no} is out of range (1-{len(pdf.pages)})")
        if page_no not in out:
            out.append(page_no)
    return sorted(out)


def search_text_regions(
    file: str,
    query: str = "",
    pages="all",
    regex: bool = False,
    case_sensitive: bool = False,
    whole_word: bool = False,
    terms: Optional[list] = None,
    patterns: Optional[list] = None,
    expand: str = "match",
    max_hits: int = MAX_HITS_DEFAULT,
) -> dict:
    """Every occurrence of `query` / `terms` / `patterns`, with page-space
    rectangles.

    Returns ``{hits, pages_searched, truncated, pages_without_text, error}``.
    A hit is ``{page, index, text, source, context, rects, runs}`` where each
    entry of ``rects`` is ``{run, rect, codes, partial, imprecise}`` — ONE PER
    RUN, never a bounding box across runs (rule 3), and `rect` is
    ``[x0, y0, x1, y1]`` in the page's own point space, the space `redact` and
    `save_redaction_marks` already take.

    An invalid regex is REPORTED in `error`, not raised — the user is typing
    it. Everything else that cannot be honoured refuses by name.
    """
    if expand not in ("match", "word", "line"):
        raise ValueError('expand must be "match", "word" or "line"')
    pattern_ids = [str(p) for p in (patterns or [])]
    for pattern_id in pattern_ids:
        # Validated by ASKING for the pattern rather than by re-deriving the
        # refusal: two spellings of "we do not carry that pattern" would be
        # two catalog rows, and the second would go untranslated.
        compiled_pattern(pattern_id)
    term_list = [str(t) for t in (terms or [])]
    if not str(query).strip() and not any(t.strip() for t in term_list) and not pattern_ids:
        raise ValueError(
            "give a search term, a word list or a built-in pattern — "
            "searching for nothing would mark every page"
        )
    if int(max_hits) <= 0:
        raise ValueError("max_hits must be a positive number")

    matchers: list[tuple[str, "re.Pattern"]] = []
    if str(query) != "":
        compiled, error = compile_matcher(
            query, regex, case_sensitive, whole_word, normalizer=normalize_index_text
        )
        if error is not None:
            return {
                "hits": [],
                "pages_searched": 0,
                "truncated": False,
                "pages_without_text": [],
                "error": error,
            }
        if compiled is not None:
            matchers.append(("query", compiled))
    if term_list:
        compiled, error = compile_terms(
            term_list, regex, case_sensitive, whole_word, normalizer=normalize_index_text
        )
        if error is not None:
            return {
                "hits": [],
                "pages_searched": 0,
                "truncated": False,
                "pages_without_text": [],
                "error": error,
            }
        if compiled is not None:
            matchers.append(("terms", compiled))

    validate_pdf(file)
    hits: list[dict] = []
    pages_without_text: list[int] = []
    truncated = False
    with pikepdf.open(file) as pdf:
        wanted = _page_numbers(pages, pdf)
        for page_number in wanted:
            if truncated:
                break
            page = pdf.pages[page_number - 1]
            runs, _listing = _collect_runs(pdf, page)
            if not runs:
                # Reported per page, never a silent shortfall: an image-only
                # page carries no searchable text, and the caller's second
                # authority (the in-memory OCR word boxes) is what covers it.
                pages_without_text.append(page_number)
                continue
            text, origin = _page_text(runs)
            if not text.strip():
                pages_without_text.append(page_number)
                continue
            runs_by_index = {run.index: run for run in runs}
            spans: list[tuple[int, int, str]] = []
            for source, compiled in matchers:
                for m in finditer_nonempty(compiled, text):
                    spans.append((m.start(), m.end(), source))
            for pattern_id in pattern_ids:
                for start, end in pattern_spans(pattern_id, text):
                    spans.append((start, end, pattern_id))
            spans.sort(key=lambda s: (s[0], -s[1], s[2]))
            seen: set = set()
            for start, end, source in spans:
                if (start, end) in seen:
                    # Two sources naming the same characters is one hit with
                    # one rectangle — a duplicate row would let the user tick
                    # a box that changes nothing and untick one that does.
                    continue
                seen.add((start, end))
                if len(hits) >= int(max_hits):
                    truncated = True
                    break
                grown_start, grown_end = _expand_span(text, start, end, expand)
                rects = _rects_for_span(runs_by_index, origin, grown_start, grown_end, expand)
                if not rects:
                    continue
                hits.append(
                    {
                        "page": page_number,
                        "index": len(hits),
                        "text": text[grown_start:grown_end],
                        "source": source,
                        "context": snippet(text, start, end),
                        "rects": rects,
                        "runs": [r["run"] for r in rects],
                    }
                )
    return {
        "hits": hits,
        "pages_searched": len(wanted),
        "truncated": truncated,
        "pages_without_text": pages_without_text,
        "error": None,
    }
