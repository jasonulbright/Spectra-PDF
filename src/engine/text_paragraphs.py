"""Paragraph grouping + reflow (Phase 7.5 — the last content-editing slice).

Groups the text runs of a page into PARAGRAPH BOXES — the industry
editor's model — and re-lays-out a paragraph's text inside its box on
edit (rewrap at the measured width, alignment/indent/leading preserved,
growth downward). The design record is `docs/architecture/21` §7.5; the
one-line summary of every structural rule:

  - Grouping happens HERE (engine), from the SAME `_walk_runs` walk that
    produces the run listing — index agreement by construction. Lines never
    mix streams, but a paragraph MAY continue across a stream boundary
    (page → form, form → form) under strict evidence: the same geometric
    join tests, plus z-order adjacency — no visible foreign run between the
    fragments in content order (T17; the false-positive direction is the
    dangerous one). An apply then runs ONE per-stream rewrite per involved
    stream — each member's replacement text lands in ITS stream, form-hosted
    members via copy-on-write of the whole Do chain, one atomic save.
  - Only axis-aligned runs under a SHARED linear matrix group; rotated /
    skewed text simply never forms a paragraph and stays on the 7.2
    run-box surface. Refused paragraphs (uneditable member, RTL) are
    LISTED with their reason and decompose to run boxes in the renderer.
  - Line assembly: baseline clustering, superscript attach (near-baseline
    offsets become rise-carrying spans), column split at large gaps.
    Paragraph assembly: leading consistency, horizontal overlap,
    dominant-size continuity, bullet-line breaks.
  - Logical text: run texts in line order; synthetic U+0020 at positioned
    word gaps (between runs AND inside TJ arrays); lines join with a
    space except after a line-terminal hyphen (hyphens are document text
    — never de-/re-hyphenated).
  - The heuristic THRESHOLDS below are code constants pinned by the
    fixture matrix (tests own the numbers, the doc owns the intent).
  - Vertical runs (9.B4b) ride the SAME pipeline under one 90°
    transposition T(x, y) = (−y, x), applied at exactly TWO boundaries:
    member admission (`_members_from` — a column IS a line, the column
    pitch IS the leading, top-alignment IS left-alignment) and the
    emission's per-segment Tm anchor (T⁻¹(x', y') = (y', −x'); the
    linear part is untouched — glyphs stay upright, the walker's
    vertical advance model owns the direction). Every grouping heuristic
    between the boundaries applies unchanged. Modes never mix: the
    writing mode rides INSIDE lkey, which also makes the A4 merge's
    lkey guard refuse cross-mode merges for free.

The rewrite half (`replace_paragraph_text`) lives here too: member show
ops are removed, the paragraph re-emitted at the first member's position
as absolutely-positioned lines, and every kept op after the divergence is
resynced (position AND text state) against a parallel walk of the
ORIGINAL stream — see `_ResyncEmitter`. The correctness property (every
kept show renders at an identical matrix with identical state) is
asserted directly by the test suite's dual-walk harness.
"""

import math
import os
import re
import statistics
import unicodedata
from collections import defaultdict
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from engine import bidi
from engine.content_walk import GraphicsTextState, color_equal, mat_mult
from engine.page_images import _finalize_page_rewrite, _fresh_name, _register_xobject, _save
from engine.redact import (
    IDENTITY,
    MAX_FORM_DEPTH,
    _as_matrix,
    _copy_resources_for_write,
    _lookup_xobject,
    _resolve_resources,
)
from engine.text_runs import (
    SHOW_OPS,
    _child_state,
    _FontCache,
    _fresh_font_name,
    _instruction,
    _register_font,
    _run_metrics,
    _walk_runs,
)

# ── grouping constants (pinned by the fixture matrix, not spec) ───────────

MATRIX_TOL = 1e-3  # axis-alignment + shared-linear-part tolerance
BASELINE_TOL_EM = 0.12  # same-baseline clustering window (× eff size)
RISE_ATTACH_EM = 0.5  # near-baseline offset attach window (× line size)
RISE_SIZE_RATIO = 0.8  # …and the risen run must be smaller than the line
COLUMN_GAP_EM = 1.5  # a larger same-baseline gap splits line pieces
WORD_GAP_FRACTION = 0.5  # of the span font's space width → synthetic space
FALLBACK_SPACE_1000 = 250.0  # space-less fonts: nominal space width
DEFAULT_WORD_GAP_1000 = 250.0  # emission gap when a paragraph shows none
PARA_JOIN_MAX_EM = 1.6  # first-pair leading cap (× larger line size)
PARA_LEADING_DRIFT = 0.25  # later deltas within ±25% of running leading
PARA_MIN_DELTA_EM = 0.25  # closer lines never join (shadow/overlap)
PARA_OVERLAP_MIN = 0.5  # horizontal overlap ratio to join
SIZE_JUMP_RATIO = 1.2  # dominant-size discontinuity breaks (heading/body)
EDGE_TOL_PT = 0.75  # alignment-evidence tolerance floor (user units)
EDGE_TOL_FRACTION = 0.015  # …or this fraction of the box width
WRAP_TOL = 0.5  # user units of slack when refilling lines

BULLET_CHARS = "•◦▪‣·∙–—*"
_ENUM_RE = re.compile(r"^(\d{1,3}|[A-Za-z])[.)]([\s ]|$)")

# Kinsoku (JIS X 4051; T16 deepened the lite set): characters that must not
# START a wrapped line — closing punctuation, plus small kana, the prolonged
# sound mark and iteration marks (行頭禁則), and mid-leader continuation.
NO_LINE_START = set(
    "。、」』）］｝！？，．・:;,.!?)]}»›'\"”’"
    # Small kana (hiragana + katakana) — they modify the PRECEDING syllable.
    "ぁぃぅぇぉっゃゅょゎゕゖ"
    "ァィゥェォッャュョヮヵヶ"
    # Prolonged sound + iteration marks.
    "ーゝゞヽヾ々〻"
    # Leaders/ellipses never start a line mid-run.
    "…‥"
)

# T16: characters that must not END a wrapped line (行末禁則) — opening
# brackets and quotes glue FORWARD to the word they open.
NO_LINE_END = set("（｛［「『【〈《〔〖〘〚(［{«‹“‘\"'")


# ── members and lines ─────────────────────────────────────────────────────


class _Member:
    """One run, enriched for grouping (user-space geometry + span style)."""

    __slots__ = (
        "index",
        "stream",
        "cap",
        "style",
        "segments",
        "operator",
        "a",
        "d",
        "x0",
        "x1",
        "y",
        "eff",
        "space_w",
        "rect",
        "ptext",
        # 9.T25: the run's text as UNITS — one per drawn code, so the bidi
        # reorder permutes what the font actually drew rather than a guess.
        "punits",
        "gaps_1000",
        "editable",
        "blocking_reason",
        "rise_user",
        "tm",
        "ctm",
        "lkey",
        "resources",
        "fallback",
        "vertical",
        "clipped",
    )


def _axis_aligned(m) -> bool:
    a, b, c, d, _e, _f = m
    lim = MATRIX_TOL * max(abs(a), abs(d), 1e-9)
    return abs(b) <= lim and abs(c) <= lim and a > 0 and d > 0


def _linear_key(m) -> tuple:
    a, b, c, d, _e, _f = m
    return (round(a, 4), round(b, 4), round(c, 4), round(d, 4))


def _ptext_and_gaps(det) -> tuple[str, list[float], list[str]]:
    """The run's paragraph-text (synthetic spaces at TJ word gaps), the
    observed gap widths (1000ths of em) for the paragraph's median, and the
    text as UNITS — one entry per drawn code, which is what the 9.T25 bidi
    reorder permutes. A ligature the font drew as one glyph is one unit, so
    its characters can never be reversed against each other."""
    cap = det["cap"]
    parts: list[str] = []
    units: list[str] = []
    gaps: list[float] = []
    space_1000 = (
        cap.char_width(" ")
        if (cap is not None and cap.can_encode(" "))
        else FALLBACK_SPACE_1000
    )
    threshold = WORD_GAP_FRACTION * space_1000
    segments = det["segments"]
    for i, seg in enumerate(segments):
        if isinstance(seg, float):
            gap = -seg  # negative TJ numbers push the pen RIGHT
            # A forward jump that lands on a glyph SPELLING NOTHING is mark
            # positioning, not a word gap: a combining mark carries its
            # horizontal offset as exactly this shape — jump, draw a
            # zero-advance glyph whose /ToUnicode is empty, jump back. Reading
            # it as a space put one inside every vocalised Arabic word
            # (`مَرْحَبًا` extracted as `مَ رْحَبًا`). True of any producer's
            # marks, not just ours — the jump is bounded by the mark's own
            # offset, which routinely exceeds half a space.
            nxt = segments[i + 1] if i + 1 < len(segments) else None
            spells_nothing = (
                isinstance(nxt, bytes) and cap is not None and cap.decode(nxt) == ""
            )
            if gap >= threshold and not spells_nothing:
                parts.append(" ")
                units.append(" ")
                gaps.append(gap)
            continue
        if cap is None:
            continue
        chunk = cap.decode_units(seg)
        parts.extend(chunk)
        units.extend(u for u in chunk if u)
    return "".join(parts), gaps, units


def _members_from(runs: list[dict], detail: list[dict]) -> list[_Member]:
    members: list[_Member] = []
    for run, det in zip(runs, detail):
        m = det["combined"]
        if not _axis_aligned(m):
            continue  # rotated/skewed text stays on the run-box surface
        cap = det["cap"]
        if cap is None:
            continue  # no active font: degenerate, run-box surface
        style = det["style"]
        a, _b, _c, d, e, f = m
        vertical = bool(cap.vertical)
        mem = _Member()
        mem.index = run["index"]
        mem.stream = det["stream"]
        mem.cap = cap
        mem.style = style
        mem.segments = det["segments"]
        mem.operator = det["operator"]
        mem.a = a
        mem.d = d
        mem.vertical = vertical
        space_1000 = (
            cap.char_width(" ") if cap.can_encode(" ") else FALLBACK_SPACE_1000
        )
        if vertical:
            # 9.B4b: ONE 90° transposition T(x, y) = (−y, x) admits a
            # vertical run into the horizontal model — the downward
            # advance from the pen (e, f) maps to +x′, the column's x to
            # the line baseline y′, the em width (size×a, the column
            # axis) to the line size, and the space width scales by d
            # (Tz never applies vertically; the B4a advances are the
            # widths). Every heuristic downstream then applies unchanged;
            # the emission untransposes at its Tm anchors (T⁻¹).
            mem.x0 = -f
            mem.x1 = -f + det["raw_width"] * d
            mem.y = e
            mem.eff = max(style["size"] * a, 0.01)
            mem.space_w = space_1000 / 1000.0 * style["size"] * d
        else:
            mem.x0 = e
            mem.x1 = e + det["raw_width"] * style["h_scale"] * a
            mem.y = f
            mem.eff = max(style["size"] * d, 0.01)
            mem.space_w = space_1000 / 1000.0 * style["size"] * style["h_scale"] * a
        # REAL (untransposed) rect in both modes — paragraph boxes union
        # these, so the listing draws real page rects with no un-mapping.
        mem.rect = det["rect"]
        mem.ptext, mem.gaps_1000, mem.punits = _ptext_and_gaps(det)
        mem.editable = bool(run["editable"])
        # 9-§I.0-S8: the run's clip flag rides through so a paragraph whose
        # every member is clipped away lists as invisible (aggregated in
        # _listing). Additive — never affects grouping.
        mem.clipped = bool(run.get("clipped", False))
        # Whitespace-only runs ("nothing to edit") don't block a paragraph —
        # generators emit standalone space runs constantly; blocking is a
        # FONT refusal on visible text.
        mem.blocking_reason = (
            run["reason"] if (not run["editable"] and run["text"].strip()) else None
        )
        mem.rise_user = style["rise"] * d
        mem.tm = det["tm"]
        mem.ctm = det["ctm"]
        # 9.B4b: the writing mode rides INSIDE lkey — modes can never
        # co-group, AND the A4 merge's existing lkey guard refuses a
        # cross-mode merge for free (no new merge code).
        mem.lkey = _linear_key(m) + (vertical,)
        # Stream-scoped resources for family classification (9.B1) — a
        # nested form's font is not in page resources (review-caught).
        mem.resources = det.get("resources")
        mem.fallback = det.get("fallback")
        members.append(mem)
    return members


class _Line:
    __slots__ = ("members", "y", "eff", "x0", "x1")

    def __init__(self, members: list[_Member], y: float):
        self.members = sorted(members, key=lambda m: m.x0)
        self.y = y
        # Dominant size = the widest member's (labels a line by its body,
        # not a stray superscript).
        widest = max(members, key=lambda m: m.x1 - m.x0)
        self.eff = widest.eff
        self.x0 = min(m.x0 for m in members)
        self.x1 = max(m.x1 for m in members)


def _widest(cluster: list[_Member]) -> _Member:
    return max(cluster, key=lambda m: m.x1 - m.x0)


def _cluster_lines(members: list[_Member]) -> list[_Line]:
    """Baseline clustering → superscript attach → column split."""
    by_y = sorted(members, key=lambda m: -m.y)
    clusters: list[list[_Member]] = []
    for mem in by_y:
        placed = False
        for cluster in clusters:
            ref = _widest(cluster)
            if abs(mem.y - ref.y) <= BASELINE_TOL_EM * max(mem.eff, ref.eff):
                cluster.append(mem)
                placed = True
                break
        if not placed:
            clusters.append([mem])

    # Superscript/subscript attach: a markedly smaller cluster within the
    # rise window of a bigger one merges as risen spans. Direction-free —
    # the superscript may be ABOVE its body line and therefore processed
    # first; the size test decides which side is the body, not arrival
    # order.
    merged: list[list[_Member]] = []
    for cluster in clusters:
        c_ref = _widest(cluster)
        target = None
        for other in merged:
            o_ref = _widest(other)
            big = max(o_ref.eff, c_ref.eff)
            small = min(o_ref.eff, c_ref.eff)
            if abs(c_ref.y - o_ref.y) <= RISE_ATTACH_EM * big and small <= RISE_SIZE_RATIO * big:
                target = other
                break
        if target is None:
            merged.append(cluster)
        else:
            target.extend(cluster)

    # Rise assignment (idempotent, applied once per FINAL cluster): the
    # line's baseline is its widest member's; every member's rise is its
    # Ts component plus its Tm offset from that baseline, with sub-jitter
    # clamped to zero so baseline noise never emits a Ts.
    lines: list[_Line] = []
    for cluster in merged:
        base = _widest(cluster)
        for m in cluster:
            rise = m.style["rise"] * m.d + (m.y - base.y)
            m.rise_user = 0.0 if abs(rise) < 0.05 * base.eff else rise
        ordered = sorted(cluster, key=lambda m: m.x0)
        piece: list[_Member] = [ordered[0]]
        for mem in ordered[1:]:
            gap = mem.x0 - max(p.x1 for p in piece)
            if gap > COLUMN_GAP_EM * base.eff:
                lines.append(_Line(piece, base.y))
                piece = [mem]
            else:
                piece.append(mem)
        lines.append(_Line(piece, base.y))
    return lines


def _starts_with_bullet(line: _Line) -> bool:
    text = "".join(m.ptext for m in line.members).lstrip()
    if not text:
        return False
    if text[0] in BULLET_CHARS and (len(text) == 1 or text[1].isspace()):
        return True
    return bool(_ENUM_RE.match(text))


def _overlap_ratio(a0: float, a1: float, b0: float, b1: float) -> float:
    overlap = min(a1, b1) - max(a0, b0)
    if overlap <= 0:
        return 0.0
    return overlap / max(min(a1 - a0, b1 - b0), 1e-9)


class _Paragraph:
    __slots__ = (
        "lines",
        "stream",
        # T17: every distinct stream the members live in, ordered by first
        # appearance in content order. `stream` stays the FIRST of these (the
        # primary — the listing sort key and the single-stream common case);
        # a cross-stream paragraph has len(streams) > 1 and its rewrite runs
        # one per-stream target per entry.
        "streams",
        "lkey",
        "alignment",
        "leading",
        "indent",
        "left",
        "right",
        "text",
        "spans",
        "median_gap_1000",
        "editable",
        "reason",
        "box",
        # 9.T3: the paragraph's bidi base level (0 LTR / 1 RTL) and whether
        # its text was normalized from the page's VISUAL order into logical
        # order to get here. `base_level` is 0 and `bidi` False for every
        # paragraph with no strong RTL character — i.e. the shipped path.
        "base_level",
        "bidi",
    )

    @property
    def members(self) -> list[_Member]:
        return [m for line in self.lines for m in line.members]

    @property
    def run_indexes(self) -> list[int]:
        return sorted(m.index for m in self.members)

    @property
    def vertical(self) -> bool:
        # 9.B4b: all members share one writing mode by group construction
        # (the mode rides in lkey) — the paragraph's mode is any member's.
        return self.lines[0].members[0].vertical


def _join_paragraphs(lines: list[_Line], cross_ok=None) -> list[list[_Line]]:
    """Column-aware top-down joining: each line (y-descending) joins the
    OPEN paragraph with the best horizontal overlap whose leading/size
    evidence accepts it, else opens a new one. Strictly sequential joining
    fails the moment two columns interleave in y order — the candidate
    search is what keeps side-by-side columns separate AND contiguous.

    T17: a line never mixes streams (assembly is per-stream), but the pool
    may hold several streams' lines. A join that would bring a NEW stream
    into a paragraph passes every geometric test above PLUS `cross_ok(
    paragraph_member_indexes, line_member_indexes)` — the z-order adjacency
    gate (no visible foreign run between the fragments in content order).
    The false-positive direction is the dangerous one: a page paragraph and
    an unrelated form block that merely align must NOT group, so the gate is
    strict and a refused cross join simply opens a second paragraph (the
    shipped behavior)."""
    lines = sorted(lines, key=lambda l: -l.y)
    open_paras: list[dict] = []
    for line in lines:
        bullet = _starts_with_bullet(line)
        line_stream = line.members[0].stream
        line_idx = {m.index for m in line.members}
        best: dict | None = None
        best_overlap = 0.0
        if not bullet:
            for para in open_paras:
                prev = para["lines"][-1]
                delta = prev.y - line.y
                if delta <= PARA_MIN_DELTA_EM * prev.eff:
                    continue  # same visual band (a column sibling), never stacks
                leading = statistics.median(para["deltas"]) if para["deltas"] else None
                if leading is None:
                    if delta > PARA_JOIN_MAX_EM * max(prev.eff, line.eff):
                        continue
                elif abs(delta - leading) > PARA_LEADING_DRIFT * leading:
                    continue
                if max(prev.eff, line.eff) / max(min(prev.eff, line.eff), 0.01) > SIZE_JUMP_RATIO:
                    continue
                box_x0 = min(l.x0 for l in para["lines"])
                box_x1 = max(l.x1 for l in para["lines"])
                ov = _overlap_ratio(box_x0, box_x1, line.x0, line.x1)
                if ov < PARA_OVERLAP_MIN:
                    continue
                if line_stream not in para["streams"] and (
                    cross_ok is None or not cross_ok(para["idx"], line_idx)
                ):
                    continue
                if ov > best_overlap:
                    best, best_overlap = para, ov
        if best is None:
            open_paras.append(
                {
                    "lines": [line],
                    "deltas": [],
                    "streams": {line_stream},
                    "idx": set(line_idx),
                }
            )
        else:
            best["deltas"].append(best["lines"][-1].y - line.y)
            best["lines"].append(line)
            best["streams"].add(line_stream)
            best["idx"] |= line_idx
    return [p["lines"] for p in open_paras]


def _detect_alignment(
    lines: list[_Line], left: float, right: float, base_rtl: bool = False
) -> str:
    # 9.T3: with no alignment EVIDENCE, a right-to-left paragraph's default
    # is flush RIGHT — that is where its text starts, and it is the edge new
    # lines must grow from. `base_rtl=False` (every LTR paragraph, i.e. the
    # shipped call) keeps "left" in all four no-evidence branches, so the
    # existing behaviour is unchanged by construction.
    default = "right" if base_rtl else "left"
    if len(lines) < 2:
        return default
    tol = max(EDGE_TOL_PT, EDGE_TOL_FRACTION * (right - left))
    non_last = lines[:-1]
    if len(lines) >= 3 and all(
        (l.x0 - left) <= tol and (right - l.x1) <= tol for l in non_last
    ):
        return "justify"
    lefts = [l.x0 for l in lines]
    rights = [l.x1 for l in lines]
    centers = [(l.x0 + l.x1) / 2 for l in lines]
    lefts_vary = (max(lefts) - min(lefts)) > tol
    rights_vary = (max(rights) - min(rights)) > tol
    mean_c = sum(centers) / len(centers)
    if lefts_vary and rights_vary and all(abs(c - mean_c) <= tol for c in centers):
        return "center"
    if lefts_vary and not rights_vary:
        return "right"
    if rights_vary and not lefts_vary:
        return "left"  # flush left is EVIDENCE, in either base direction
    return default


def _line_pieces(line: _Line, gaps: list[float]) -> list[tuple[str, int]]:
    """One line's `(text, run index)` pieces in PAGE order (left to right),
    appending its observed word gaps to `gaps`."""
    pieces: list[tuple[str, int]] = []
    prev: _Member | None = None
    for mem in line.members:
        if not mem.ptext:
            # A run that draws no TEXT cannot be one side of a word gap, and
            # letting it be one is not hypothetical: a zero-advance combining
            # mark (Arabic harakat, emitted as its own show because its
            # vertical offset needs a `Ts`) has `space_w` 0, which collapses
            # the threshold below to `gap >= 0` — so the ZERO gap to the next
            # glyph read as a word break and vocalised text extracted with a
            # space inside every word. Skip it entirely: `prev` stays the last
            # run that actually drew something.
            gaps.extend(mem.gaps_1000)
            continue
        if prev is not None:
            gap = mem.x0 - prev.x1
            # A gap must be POSITIVE to be a word gap — belt to the same
            # class, for any other run whose space width reads as zero.
            if gap > 0 and gap >= WORD_GAP_FRACTION * prev.space_w:
                if not (pieces and pieces[-1][0].endswith(" ")):
                    pieces.append((" ", prev.index, [" "]))
                # 9.B4b: the gap converts to 1000ths at the ADVANCE
                # axis's user scale — d for vertical (Tz never applies
                # vertically), h_scale×a for horizontal (unchanged).
                axis = prev.d if prev.vertical else prev.a * prev.style["h_scale"]
                denom = axis * prev.style["size"]
                if denom > 1e-9:
                    gaps.append(gap / denom * 1000.0)
        if mem.ptext:
            pieces.append((mem.ptext, mem.index, mem.punits))
        gaps.extend(mem.gaps_1000)
        prev = mem
    return pieces


def _to_logical(pieces: list[tuple[str, int]], base_level: int, cap_of):
    """9.T3 — one line's PAGE-ORDER pieces re-ordered into LOGICAL order,
    or None when the reconstruction cannot be proven.

    Page order IS visual order: the lister assembles a line left to right by
    geometry, whatever order the content stream drew it in. Bidi reordering
    is its own inverse for two-level text, so running the forward algorithm
    over the visual string is the candidate logical order — and the check
    below is what makes that a fact rather than a hope: reorder the candidate
    FORWARD and require the permutation to compose to the identity. Anything
    deeper than two levels fails here and the paragraph refuses, which is the
    honest outcome; nothing is ever silently re-spelled.

    Reordering is by UNIT, not by character. One glyph can spell several
    characters — an Arabic lam-alef, a Latin `fi` — and those characters are
    already in logical order inside the glyph's ToUnicode entry; reversing
    them individually would scramble the very word the reordering is meant
    to restore. The units come from the DRAWN CODES (`decode_units`), not
    from the font's `_sequences` table: that table is filtered to
    unambiguous inverses, so a ligature also expressible as separate codes
    is absent from it — and guessing from it turned `الله` into `لاله`."""
    units: list[tuple[str, int]] = []
    for text, run, punits in pieces:
        if punits and "".join(punits) == text:
            units.extend((u, run) for u in punits)
        else:
            # A piece whose units do not reconstruct it (a synthetic space
            # merged in, or a caller without unit data) falls back to
            # characters — safe, because such a piece is whitespace or plain.
            units.extend((ch, run) for ch in text)
    # A unit's bidi class is its FIRST character's; a ligature's characters
    # always share one (they are glyphs of a single script).
    visual = "".join(u[0][0] for u in units)
    back = bidi.reconstruct_logical(visual, base_level)
    if len(back) != len(units):
        return None  # directional formatting codes: rule X9 drops them
    logical = "".join(visual[i] for i in back)
    _lvl, forward = bidi.visual_order(logical, base_level)
    if len(forward) != len(units) or any(back[forward[v]] != v for v in range(len(units))):
        return None
    out: list[tuple[str, int, list]] = []
    for i in back:
        text, run = units[i]
        if out and out[-1][1] == run:
            out[-1] = (out[-1][0] + text, run, out[-1][2] + [text])
        else:
            out.append((text, run, [text]))
    return out


def _assemble_text(
    lines: list[_Line], base_level: int | None = None
) -> tuple[str, list[dict], list[float]] | None:
    """(logical text, spans [{start,end,run}], observed word gaps 1000).

    9.T3: `base_level` None is the shipped path — page order IS logical order
    for left-to-right text. An int normalizes each line from page (visual)
    order into logical order under that base direction, and returns None when
    any line's reconstruction cannot be verified."""
    parts: list[str] = []
    spans: list[dict] = []
    gaps: list[float] = []
    pos = 0
    last_char = ""

    def emit(text: str, run_index: int) -> None:
        nonlocal pos, last_char
        if not text:
            return
        if spans and spans[-1]["run"] == run_index and spans[-1]["end"] == pos:
            spans[-1]["end"] = pos + len(text)
        else:
            spans.append({"start": pos, "end": pos + len(text), "run": run_index})
        parts.append(text)
        pos += len(text)
        last_char = text[-1]

    for li, line in enumerate(lines):
        pieces = _line_pieces(line, gaps)
        if base_level is not None:
            caps = {m.index: m.cap for m in line.members}
            pieces = _to_logical(pieces, base_level, caps.get)
            if pieces is None:
                return None
        next_first = next((piece[0][0] for piece in pieces if piece[0]), "")
        if (
            li > 0
            and last_char not in ("-", " ", "")
            and not (_cjk(last_char) and next_first and _cjk(next_first))
        ):
            # Lines join with a space — except after a line-terminal hyphen
            # (hyphens are document text; never de-/re-hyphenated) and
            # across CJK↔CJK boundaries (no-space scripts wrap without
            # separators; inserting one would corrupt the round-trip). The
            # separator rides the PREVIOUS span (style continuity).
            emit(" ", spans[-1]["run"] if spans else line.members[0].index)
        for piece in pieces:
            emit(piece[0], piece[1])
    return "".join(parts), spans, gaps


def _resolve_bidi_text(lines: list[_Line], visual):
    """9.T3 — (text, spans, gaps, base_level) in LOGICAL order, or None.

    Both base directions are tried because the page gives no direct evidence
    of the producer's: P2/P3 on the VISUAL string is unreliable (a paragraph
    that starts with Hebrew and ends with Latin begins with the Latin once
    reordered). A candidate that verifies is a base direction under which a
    conforming bidi engine reproduces exactly what the page draws; when both
    verify, the one whose own reconstruction agrees with P2/P3 wins, since
    that is what a producer running the algorithm in `auto` mode would have
    used."""
    accepted = []
    for base in (1, 0):
        got = _assemble_text(lines, base_level=base)
        if got is not None:
            accepted.append((base, got))
    for base, got in accepted:
        if bidi.paragraph_level(got[0]) == base:
            return got + (base,)
    if accepted:
        base, got = accepted[0]
        return got + (base,)
    del visual
    return None


def _stream_direction_conflict(lines: list[_Line]) -> bool:
    """T17: True when two streams of one (bidi-normalized) paragraph resolve
    to DIFFERENT base directions from their own text. Each per-stream half
    would reorder against a different base on the way back out, so the
    reconstruction cannot be trusted — the refusal family of the T3 unproven
    case. Streams whose text carries no strong character can't disagree."""
    texts: dict[tuple, list[str]] = defaultdict(list)
    for line in lines:
        for m in line.members:
            texts[m.stream].append(m.ptext)
    levels = set()
    for parts in texts.values():
        t = "".join(parts)
        if any(bidi.bidi_class(ch) in ("L", "R", "AL") for ch in t):
            levels.add(bidi.paragraph_level(t))
    return len(levels) > 1


def _analyze(paras: list[list[_Line]], lkey: tuple) -> list[_Paragraph]:
    out: list[_Paragraph] = []
    for lines in paras:
        p = _Paragraph()
        p.lines = lines
        # T17: distinct member streams in content order; the first is the
        # primary (the single-stream `stream` field, unchanged meaning).
        first_of: dict[tuple, int] = {}
        for line in lines:
            for m in line.members:
                if m.stream not in first_of or m.index < first_of[m.stream]:
                    first_of[m.stream] = m.index
        p.streams = tuple(sorted(first_of, key=lambda s: first_of[s]))
        p.stream = p.streams[0]
        p.lkey = lkey
        p.left = min(l.x0 for l in lines)
        p.right = max(l.x1 for l in lines)
        p.base_level = 0
        p.bidi = False
        p.alignment = _detect_alignment(lines, p.left, p.right)
        p.leading = (
            statistics.median(lines[i].y - lines[i + 1].y for i in range(len(lines) - 1))
            if len(lines) > 1
            else None
        )
        body_lefts = [l.x0 for l in lines[1:]]
        p.indent = (
            (lines[0].x0 - min(body_lefts))
            if (body_lefts and p.alignment in ("left", "justify"))
            else 0.0
        )
        p.text, p.spans, gaps = _assemble_text(lines)
        bidi_failed = False
        if bidi.has_strong_rtl(p.text):
            # 9.T3: page order is VISUAL order. Normalize to logical so the
            # editor edits reading order, and re-detect alignment now that
            # the base direction is known.
            resolved = _resolve_bidi_text(lines, p.text)
            if resolved is None:
                bidi_failed = True
            else:
                p.text, p.spans, gaps, p.base_level = resolved
                p.bidi = True
                p.alignment = _detect_alignment(
                    lines, p.left, p.right, base_rtl=p.base_level == 1
                )
                # The first-line indent is a LEFT-edge measurement; a
                # right-aligned paragraph has none, so re-derive it now that
                # the alignment may have flipped.
                p.indent = (
                    (lines[0].x0 - min(body_lefts))
                    if (body_lefts and p.alignment in ("left", "justify"))
                    else 0.0
                )
        p.median_gap_1000 = statistics.median(gaps) if gaps else DEFAULT_WORD_GAP_1000
        rects = [m.rect for m in p.members]
        p.box = [
            min(r[0] for r in rects),
            min(r[1] for r in rects),
            max(r[2] for r in rects),
            max(r[3] for r in rects),
        ]
        p.editable = True
        p.reason = None
        blocker = next((m for m in p.members if m.blocking_reason), None)
        if blocker is not None:
            p.editable = False
            p.reason = f"contains text that cannot be edited ({blocker.blocking_reason})"
        elif bidi_failed:
            # 9.T3: the refusal that REPLACED "right-to-left text does not
            # reflow". RTL now reflows; what is refused is the narrow case
            # where the page's visual order cannot be proven to come from any
            # single logical order under either base direction — nesting past
            # two embedding levels, or explicit directional formatting codes
            # in the drawn text. Editing on an unproven reconstruction would
            # silently re-spell the paragraph, so it stays on the run surface.
            p.editable = False
            p.reason = "this paragraph's right-to-left order could not be reconstructed"
        elif len(p.streams) > 1 and p.bidi and _stream_direction_conflict(lines):
            # T17: the stated cross-stream refusal — the streams disagree
            # about the paragraph's base direction, so the per-stream halves
            # of an edit would reorder against different bases.
            p.editable = False
            p.reason = (
                "this paragraph crosses drawing layers that disagree about "
                "its text direction"
            )
        elif p.vertical and any(m.rise_user != 0.0 for m in p.members):
            # 9.B4b review (round 28 HIGH): a vertical member's rise_user
            # carries a REAL-X displacement (its transposed-y offset from
            # the column baseline — e.g. a ruby/superscript run attached
            # BESIDE the column), but Ts displaces along the advance axis
            # (real Y for vertical text) — it structurally cannot express
            # a sideways shift, so an edit would silently restack the run
            # INTO the column. Fail closed, the v1 refusal family; the
            # runs stay individually editable on the 7.2 surface.
            p.editable = False
            p.reason = "vertical text with raised characters does not reflow"
        elif any(m.clipped for m in p.members) and not all(m.clipped for m in p.members):
            # 9-§I.0-S8 (gauntlet): a clip boundary cutting THROUGH a paragraph
            # leaves some members visible and some clipped away. The whole-para
            # `clipped` flag (all-members) is False, so it would list as a
            # single editable paragraph whose `text`/`box` include the invisible
            # member and whose reflow (`replace_paragraph_text`) would re-lay
            # text INTO the clipped region — silently. Refuse the paragraph edit
            # (the RTL/vertical-rise refusal family): it decomposes to run boxes,
            # where each run's OWN `clipped` flag already hides the invisible
            # members and keeps the visible ones individually editable.
            p.editable = False
            p.reason = "part of this paragraph is clipped away on the page"
        out.append(p)
    return out


def _group(runs: list[dict], detail: list[dict]) -> list[_Paragraph]:
    members = _members_from(runs, detail)
    groups: dict[tuple, list[_Member]] = defaultdict(list)
    for mem in members:
        groups[(mem.stream, mem.lkey)].append(mem)
    # T17: line ASSEMBLY stays per (stream, lkey) — a line never mixes
    # streams — but paragraph JOINING pools every stream's lines under one
    # lkey, so a paragraph may continue across a stream boundary (page →
    # form, form → form) when the geometric evidence holds AND the fragments
    # are z-adjacent: no visible foreign run sits between them in content
    # order (run indexes are global content order — forms recurse at their
    # Do). Whitespace-only and clipped-away runs don't block adjacency; any
    # other text run does. A single-stream page pools to exactly the shipped
    # grouping.
    lines_by_lkey: dict[tuple, list[_Line]] = defaultdict(list)
    for (_stream, lkey), mems in groups.items():
        lines_by_lkey[lkey].extend(_cluster_lines(mems))

    def _blocks(i: int) -> bool:
        r = runs[i]
        return bool(r["text"].strip()) and not r.get("clipped", False)

    def cross_ok(para_idx: set, line_idx: set) -> bool:
        u = para_idx | line_idx
        return not any(_blocks(i) for i in range(min(u), max(u) + 1) if i not in u)

    paragraphs: list[_Paragraph] = []
    for lkey, lines in lines_by_lkey.items():
        for para_lines in _join_paragraphs(lines, cross_ok=cross_ok):
            paragraphs.extend(_analyze([para_lines], lkey))
    # Whitespace-only clusters offer nothing to edit — no box at all.
    paragraphs = [p for p in paragraphs if p.text.strip()]
    # Reading order on a MIXED page needs a mode-agnostic PRIMARY key:
    # lines[0].y is real Y for horizontal but real X for vertical (round
    # 28 MEDIUM — a mid-page vertical column outsorted the page-top
    # header). The box is real-page space in both modes, so top-edge
    # first; the TIEBREAK is per-mode (side-by-side blocks share a top):
    # horizontal reads leftmost-first, vertical columns read
    # rightmost-first (the RTL column convention).
    paragraphs.sort(
        key=lambda p: (p.stream, -p.box[3], -p.box[2] if p.vertical else p.box[0])
    )
    return paragraphs


def _validated_family(family) -> str:
    """A face selector: one of the three bundled families, or an ABSOLUTE
    PATH to an installed font file (9.T6).

    An explicit selector, so garbage REFUSES rather than silently keeping
    the original — a swap that did nothing would be a success that lied.
    A path is validated by `system_fonts.resolve_face`, which is also where
    the foundry's embedding permission is checked: a licence-restricted
    font is refused BY NAME here rather than embedded and shipped."""
    raw = str(family).strip()
    lowered = raw.lower()
    if lowered in ("serif", "sans", "mono"):
        return lowered
    if os.path.isabs(raw):
        from engine.system_fonts import resolve_face

        return resolve_face(raw)
    raise ValueError("family must be serif, sans, mono, or an installed font file")


def _fill_color_hex(color) -> str:
    """Best-effort #rrggbb for the A1 colour swatch seed. Device gray/rgb
    convert exactly; k (CMYK) approximates; anything else (the default,
    Separation, ICC…) seeds black — the editor only SENDS a colour the
    user actively changes, so a black seed on an unknown space keeps the
    original untouched."""
    _cs, val = color
    if val is None:
        return "#000000"
    op, operands = val
    try:
        nums = [float(v) for v in operands]
    except (TypeError, ValueError):
        return "#000000"

    def hx(rgb):
        return "#" + "".join(f"{max(0, min(255, round(c * 255))):02x}" for c in rgb)

    if op == "g" and len(nums) == 1:
        return hx((nums[0], nums[0], nums[0]))
    if op == "rg" and len(nums) == 3:
        return hx(nums)
    if op == "k" and len(nums) == 4:
        c, m, y, k = nums
        return hx(((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)))
    return "#000000"


def _listing(paragraphs: list[_Paragraph], style_of=None) -> list[dict]:
    out = []
    # A5-tails-a: `style_of` reads the pdf's font dicts, so memoize per member
    # index — the per-SPAN display seeds below call it once per span and a
    # paragraph routinely has many spans over few distinct members.
    style_cache: dict[int, tuple[bool, bool, str | None]] = {}

    def member_style(m) -> tuple[bool, bool, str | None]:
        key = int(m.index)
        if key not in style_cache:
            style_cache[key] = style_of(m) if style_of is not None else (False, False, None)
        return style_cache[key]

    for i, p in enumerate(paragraphs):
        # The DOMINANT member: the widest on the first line — the SAME rule
        # _Emission uses to compute the leading scale, so the size the
        # editor shows is the size that scale is reasoned from (a first-by-
        # index lead-in marker otherwise seeded a mismatched number —
        # review-caught).
        first = _widest(p.lines[0].members)
        # A3b seeds: the dominant member's own weight/slant, classified by
        # the caller (needs the pdf's font dicts — `style_of(member)` →
        # (bold, italic); None = unclassified, seeds regular).
        b, it, _fam = member_style(first)
        # A5a: enrich each style-source span with its member's fill colour,
        # so the editor seeds per-range colours (a source PDF or a prior
        # A5a edit with mixed colours re-opens showing them). Additive —
        # the run index the span already carries is unchanged.
        members_by_index = {m.index: m for m in p.members}
        spans_out = []
        for sp in p.spans:
            entry = dict(sp)
            m = members_by_index.get(int(sp["run"]))
            if m is not None:
                entry["color"] = _fill_color_hex(m.style["fill_color"])
                # A5-tails-a: per-span DISPLAY seeds — the span's own
                # weight/slant/family/size, so a reopened editor can SHOW
                # genuinely mixed per-span styling instead of starting blank.
                # DISPLAY-ONLY BY CONTRACT: the renderer keeps these apart
                # from user overrides and never sends them back, because a
                # face entry SUBSTITUTES its range into a bundled Liberation
                # face — re-sending a seed would silently replace the
                # document's own foundry font on any commit. (That hazard is
                # why the A5b round left the seed out entirely.)
                sb, sit, sfam = member_style(m)
                entry["bold"] = sb
                entry["italic"] = sit
                if sfam is not None:
                    entry["family"] = sfam
                entry["size"] = round(m.style["size"], 2)
            spans_out.append(entry)
        out.append(
            {
                "index": i,
                "runs": p.run_indexes,
                "box": [round(v, 4) for v in p.box],
                "text": p.text,
                "spans": spans_out,
                "alignment": p.alignment,
                "line_count": len(p.lines),
                "editable": p.editable,
                "reason": p.reason,
                # 9.B4b, additive: the paragraph's writing mode (the run
                # listing's B4a field, lifted). Boxes are REAL rects in
                # both modes; alignment names are the TRANSPOSED ones for
                # vertical ("left" ≡ top — the editor doesn't label them).
                "vertical": p.vertical,
                # 9.T3, additive: the paragraph's bidi base direction. The
                # editor sets the textarea's `dir` from this, so the caret,
                # selection and typing behave as the reading order the text
                # is now stored in.
                "rtl": p.base_level == 1,
                "bidi": p.bidi,
                # A1 restyle seeds: the paragraph's dominant (first-member)
                # size + fill colour.
                "font_size": round(first.style["size"], 2),
                "color": _fill_color_hex(first.style["fill_color"]),
                "bold": b,
                "italic": it,
                # 9-§I.0-S8, additive: the paragraph is invisible only when
                # EVERY member is clipped away — a paragraph with any visible
                # run stays offered (the safe direction). The renderer filters
                # clipped paragraphs (and their decomposed run boxes) out.
                "clipped": bool(p.members) and all(m.clipped for m in p.members),
            }
        )
    return out


def list_text_paragraphs(file: str, page: int) -> dict:
    """One walk → the standard run listing PLUS the paragraph layer."""
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        runs: list[dict] = []
        detail: list[dict] = []
        _walk_runs(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            IDENTITY,
            0,
            None,
            runs,
            False,
            _FontCache(),
            detail=detail,
        )
        paragraphs = _group(runs, detail)

        # A3b: seed the style toggles from each paragraph's dominant
        # member's OWN font (stream-scoped resources — the B1 discipline).
        from engine.font_fallback import classify_font_family, classify_font_style
        from engine.text_runs import _lookup_font

        def style_of(member: _Member) -> tuple[bool, bool, str | None]:
            """(bold, italic, family) of a member's OWN font. The family is a
            DISPLAY seed only (A5-tails-a) — it names what the member already
            is, never a substitution request."""
            try:
                fd = _lookup_font(
                    member.style["font_name"], member.resources or resources, resources
                )
            except Exception:
                fd = None
            if fd is None:
                return (False, False, None)
            try:
                b, it = classify_font_style(fd)
            except Exception:
                b, it = (False, False)
            try:
                fam = classify_font_family(fd)
            except Exception:
                fam = None
            return (b, it, fam)

        return {"page": int(page), "runs": runs, "paragraphs": _listing(paragraphs, style_of)}


# ═══════════════════════════ rewrite half ═════════════════════════════════
#
# `replace_paragraph_text` removes the paragraph's member show ops,
# re-emits the new text as absolutely-positioned lines at the FIRST
# member's position, and RESYNCS every kept op after the divergence
# against a parallel walk of the original stream — two GraphicsTextState
# machines, injections whenever the emitted state would differ where the
# original op reads state. See the module docstring + design doc §7.5.


def _cjk(ch: str) -> bool:
    o = ord(ch)
    return (
        0x3040 <= o <= 0x30FF  # hiragana + katakana
        or 0x3400 <= o <= 0x4DBF
        or 0x4E00 <= o <= 0x9FFF
        or 0xF900 <= o <= 0xFAFF
        or 0xFF00 <= o <= 0xFFEF  # fullwidth forms
    )


class _StyleRef:
    """One rendering style for a slice of new text: a member run's
    measured style, optionally re-fonted to a fallback subset.

    9.A5b: `fallback` is a FACE KEY `(family_or_None, bold, italic)` when
    this slice substitutes into a bundled Liberation face (a per-span
    bold/italic/family override, the whole-para A3 swap, or a convert
    char), else None to render in the member's own font. The key indexes
    `_Emission.fallbacks`; `family_or_None=None` resolves the face from the
    member's own classified family (mirrors A3b style-only). Was a plain
    bool (one shared subset) through A5a — a non-None key is the new truth,
    so every emission site tests `is not None`, not truthiness."""

    __slots__ = ("member", "fallback", "size_override", "color_override", "shaped")

    def __init__(
        self, member: _Member, fallback, size_override=None, color_override=None, shaped=None
    ):
        self.member = member
        self.fallback = fallback
        # 9.T3: an `engine.shaping.ShapedRun` when this slice is ONE shaped
        # word — the glyphs, their advances and their mark offsets, decided
        # by HarfBuzz rather than by a per-character cmap lookup. None
        # everywhere else, which is every left-to-right slice ever emitted.
        self.shaped = shaped
        # A1: uniform size (points) / fill-color (ColorState) overrides,
        # or None to keep the member's own. Applied via style().
        self.size_override = size_override
        self.color_override = color_override

    @property
    def key(self) -> tuple:
        # A shaped word is its own segment by construction (each carries a
        # distinct ShapedRun), which is what the emission wants anyway: one
        # positioned show per shaped word.
        return (
            self.member.index, self.fallback, self.size_override, self.color_override,
            None if self.shaped is None else id(self.shaped),
        )

    def style(self) -> dict:
        """The effective style: the member's, with A1 size/color overrides
        applied. All width/emit paths read THIS, not member.style."""
        s = self.member.style
        if self.size_override is None and self.color_override is None:
            return s
        s = dict(s)
        if self.size_override is not None:
            s["size"] = self.size_override
        if self.color_override is not None:
            s["fill_color"] = self.color_override
            # 9.A5a: (None, None) is the explicit-default-black RESET marker
            # — a per-span keep-segment whose member had no colour of its
            # own emits `0 g` (via _color_sync) so a recoloured neighbour
            # can't bleed forward. It is NOT a real colour, so it must not
            # recompute stroke (there's nothing to convert).
            if self.color_override != (None, None):
                # Text painted via STROKE (Tr 1 = stroke, Tr 2 = fill+stroke)
                # shows its stroke colour — recolour that too, or the swatch
                # would be a silent no-op on outline text (review-caught).
                # The stroke colour uses the UPPERCASE op (rg→RG, g→G, k→K),
                # so the fill override must be converted, not copied verbatim.
                if s.get("render_mode") in (1, 2):
                    s["stroke_color"] = _to_stroke_color(self.color_override)
        return s


def _to_stroke_color(color):
    """Map a FILL ColorState to its STROKE equivalent — the PDF stroke
    colour operators are the uppercase of the fill ones (rg→RG, g→G, k→K,
    cs→CS, sc→SC, scn→SCN)."""

    def up(op):
        if op is None:
            return None
        operator, operands = op
        return (operator.upper(), operands)

    return (up(color[0]), up(color[1]))


class _Fallback:
    """One embedded fallback subset (7.4 machinery). 9.A5b: an edit carries
    a DICT of these keyed by face — one per distinct requested face — where
    A5a/A3 carried exactly one. `name` is allocated at emission time against
    the target stream's resources (deterministic sorted-face order, so the
    single-subset A3 case keeps its shipped `/EditFb0`)."""

    __slots__ = (
        "name", "font_dict", "encode", "width_1000", "used", "face_path", "kern_pairs",
        "glyph_encode", "glyph_width",
    )

    def __init__(self, name, font_dict, encode, width_1000, face_path=None, kern_pairs=None,
                 glyph_encode=None, glyph_width=None):
        self.name = name
        self.font_dict = font_dict
        self.encode = encode
        self.width_1000 = width_1000
        # 9.T3: the GLYPH-level pair, present only on a shaped subset. A
        # shaped run addresses joining forms, ligatures and marks the cmap
        # cannot reach, so it encodes and measures by glyph, not character.
        self.glyph_encode = glyph_encode
        self.glyph_width = glyph_width
        self.used = False
        # 9.K1b: the resolved face file, so the kern source can read this
        # face's own pair table rather than guessing from the family.
        self.face_path = face_path
        # 9.K2: pre-captured kern pairs for an IN-PLACE feature face, whose
        # temp program is unlinked before the emission pass runs — reading
        # face_path then would find nothing and silently un-kern the run.
        self.kern_pairs = kern_pairs


def _feature_source(font_path, member, resources, chars, feats, alt, style):
    """9.K2: the (face_path, glyph_for, tmp_to_delete) for a feature key.

    IN PLACE when the member's OWN embedded font both advertises the feature
    AND actually contains the substituted glyphs — an aggressively subsetted
    embed frequently drops the unused `.sc`/alternate glyphs even while
    keeping the GSUB table, so presence must be CHECKED, not assumed.
    Otherwise the explicit switch to bundled Libertinus Serif. `member` is
    None when the caller has already decided in-place is inapplicable (an
    explicit family + feature — only Libertinus carries features), forcing the
    switch. The temp file (the extracted embedded program) is the caller's to
    delete after the subset build reads it."""
    import io
    import tempfile

    from fontTools.ttLib import TTFont

    from engine.font_fallback import resolve_feature_font
    from engine.font_features import available_features, resolve_glyphs
    from engine.font_kerning import _embedded_program
    from engine.text_runs import _lookup_font

    raw = None
    if member is not None:
        try:
            fd = _lookup_font(member.style["font_name"], member.resources or resources, resources)
            raw = _embedded_program(fd) if fd is not None else None
        except Exception:
            raw = None
    if raw:
        try:
            ff = TTFont(io.BytesIO(raw), fontNumber=0, lazy=True)
            try:
                # ALL requested feature tags must be present, not just one:
                # "small caps" expands to smcp+c2sc, and a font carrying only
                # smcp would small-cap the lowercase and leave capitals plain
                # (a silent non-uniform result). Require the full set, else
                # switch to Libertinus (which has both) for uniform output.
                if set(feats) <= available_features(ff):
                    names = resolve_glyphs(ff, chars, feats, alt_index=alt)
                    present = set(ff.getGlyphOrder())
                    if names and all(n is not None and n in present for n in names):
                        glyph_for = {ch: n for ch, n in zip(chars, names)}
                        suffix = ".otf" if getattr(ff, "sfntVersion", "") == "OTTO" else ".ttf"
                        tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
                        tmp.write(raw)
                        tmp.close()
                        return tmp.name, glyph_for, tmp.name
            finally:
                ff.close()
        except Exception:
            pass  # any hiccup reading the embed -> the Libertinus switch
    face = resolve_feature_font(str(font_path), style=style)
    ff = TTFont(str(face), fontNumber=0, lazy=True)
    try:
        names = resolve_glyphs(ff, chars, feats, alt_index=alt)
    finally:
        ff.close()
    glyph_for = {ch: n for ch, n in zip(chars, names) if n is not None}
    return face, glyph_for, None


def _normalize_para_features(features) -> tuple:
    """The op-level `features` list -> a concrete GSUB tag tuple. Accepts the
    convenience token "small_caps" (=> smcp+c2sc) and raw tags; unknown tags
    are ignored (never a silent wrong result). `()` when nothing applies."""
    if not features:
        return ()
    from engine.font_features import SUPPORTED

    out: list = []
    for f in features:
        f = str(f).strip().lower()
        if f in ("small_caps", "smallcaps"):
            out.extend(("smcp", "c2sc"))
        elif f in SUPPORTED:
            out.append(f)
    seen, uniq = set(), []
    for f in out:
        if f not in seen:
            seen.add(f)
            uniq.append(f)
    return tuple(uniq)


def _span_features(entry: dict) -> tuple:
    """9.K2: (features_tuple, alt_index) from a span/paragraph style entry.
    `small_caps: true` -> (smcp, c2sc); `alternates: true` -> (salt,) with an
    optional `alt_index`. Returns `((), 0)` when no feature is requested, so a
    plain restyle key is byte-identical to A5b."""
    feats: list = []
    if entry.get("small_caps"):
        feats.extend(("smcp", "c2sc"))
    if entry.get("alternates"):
        feats.append("salt")
    try:
        alt = int(entry.get("alt_index", 0) or 0)
    except (TypeError, ValueError):
        alt = 0
    return (tuple(feats), alt if feats else 0)


def _requires_shaping(ch: str) -> bool:
    from engine import shaping

    return shaping.requires_shaping(ch)


def _face_sort_key(key: tuple) -> tuple:
    """Total order over face keys `(family_or_None, bold, italic, features,
    alt_index)` — None family sorts as "" so the sort never compares NoneType
    to str. Pins the per-subset name allocation + build order (deterministic
    bytes). 9.K2 added the trailing (features, alt_index); a no-feature key
    carries `((), 0)`, so its sort position is unchanged from A5b.

    9.K2 also allows `fam` to be a member INDEX int on a per-span feature key
    (baked so each run re-embeds the feature from its own font). Map it to a
    high-codepoint-prefixed string so int/str/None never compare across types
    and int keys sort AFTER every family string — leaving the family/None
    order (and its byte pins) exactly as before."""
    fam, bold, italic, feats, alt = key
    fam_sort = f"￿{fam:08d}" if isinstance(fam, int) else (fam or "")
    return (fam_sort, bold, italic, feats, alt)


def _styled_chars(
    new_text: str,
    spans: list[dict],
    members_by_index: dict[int, _Member],
    convert: bool,
    size_override=None,
    color_override=None,
    whole_para_face=None,
    color_by_pos=None,
    face_by_pos=None,
    size_by_pos=None,
    member_family=None,
    rtl_style=None,
    vertical_ok: bool = False,
    inplace_ok: bool = False,
) -> tuple[list[tuple[str, _StyleRef]], dict]:
    """Map every char of the new text to its style source; returns the
    styled stream plus `fb_by_face` — a dict {face key → the char-set that
    subset must cover} the caller turns into one `_Fallback` per key.
    Refuses (ValueError, naming the char) when a char is unencodable and
    convert is off — the renderer validates live, this is the belt.

    9.A5b — face resolution per code point (per-span face at pos > the
    whole-para A3 substitution `whole_para_face` > None=keep the member
    font). A non-None key routes THAT char through a keyed fallback subset
    (one char at a time, spaces included, ligatures never formed — the
    face is a different font, the member's own coverage is moot), exactly
    the shipped `force_fallback` behaviour generalized from one boolean to
    N faces. `whole_para_face` is None or the single whole-paragraph key
    `(family_or_None, bold, italic)` (A3a/A3b) — when set it covers every
    char, so it collapses to ONE key/subset and stays byte-identical to
    the shipped single-face output. The convert path keeps the B1
    dominant-face key `(None, False, False)`.

    `color_by_pos` (9.A5a per-span colour) is None or a list one entry per
    code point of new_text: a ColorState overrides the char at that
    position, None falls through to the call-level `color_override` (the
    A1 whole-paragraph colour). `size_by_pos` (9.A5c per-span size) is the
    same shape for size (points): a float overrides the char at that
    position, None falls through to the call-level `size_override` (the A1
    whole-paragraph size). Colour, face, and size lookups fold
    INDEPENDENTLY from the same span_styles list — a char may be per-span
    red AND bold AND bigger, on unaligned ranges. All None (the default)
    is byte-identical to the shipped path."""
    if not spans and new_text:
        raise ValueError("edit spans are missing")
    covered = 0
    for span in spans:
        if span["start"] != covered:
            raise ValueError("edit spans must be contiguous from the start")
        if span["end"] < span["start"] or span["end"] > len(new_text):
            raise ValueError("edit span out of range")
        if int(span["run"]) not in members_by_index:
            raise ValueError("edit span references a run outside the paragraph")
        covered = span["end"]
    if covered != len(new_text):
        raise ValueError("edit spans must cover the whole text")

    styled: list[tuple[str, _StyleRef]] = []
    fb_by_face: dict[tuple, set[str]] = {}
    refs: dict[tuple, _StyleRef] = {}

    def ref(member: _Member, fb, col, siz) -> _StyleRef:
        # `fb` is a face KEY (tuple) or None — both hashable, so the memo
        # key + _StyleRef.key stay hashable/comparable (9.A5b). `siz` is
        # the resolved per-char size (9.A5c: per-span > A1 call > None);
        # keyed so two chars of one member at different sizes split into
        # their own segment (via _StyleRef.key), each emitting its own Tf.
        k = (member.index, fb, col, siz)
        if k not in refs:
            refs[k] = _StyleRef(member, fb, siz, col)
        return refs[k]

    def color_at(pos: int, member: _Member):
        # A5a: resolve this code point's fill override.
        if color_by_pos is None:
            return color_override  # shipped path — one call-level colour
        psc = color_by_pos[pos] if 0 <= pos < len(color_by_pos) else None
        if psc is not None:
            return psc  # per-span colour wins
        if color_override is not None:
            return color_override  # then the A1 whole-paragraph colour
        # A per-span edit's KEEP segments must emit a CONCRETE colour so a
        # recoloured neighbour never bleeds: a member with a REAL colour of
        # its own already emits (col=None keeps it), but a member at the
        # device default — the (None, None) ColorState, never Python None —
        # needs an explicit black reset via the (None, None) marker. (Compare
        # against the default ColorState, not None: fill_color is ALWAYS a
        # 2-tuple, so `is not None` was always true — a dead branch that
        # happened to work only because _state_ops re-emits colour every
        # segment; keyed on the default it is the real, intended guard.)
        return None if member.style.get("fill_color") != (None, None) else (None, None)

    def size_at(pos: int):
        # A5c: resolve this code point's size (points). Per-span size at
        # pos wins, else the A1 call-level size_override, else None (keep
        # the member's own). size_by_pos None ⇒ the shipped single size —
        # `size_override` for every char, byte-identical to before.
        if size_by_pos is None:
            return size_override
        pss = size_by_pos[pos] if 0 <= pos < len(size_by_pos) else None
        return pss if pss is not None else size_override

    def face_at(pos: int, member: _Member):
        # A5b: per-span face at pos wins, else the whole-para A3 face, else
        # None (keep the member's own font).
        if face_by_pos is not None:
            k = face_by_pos[pos] if 0 <= pos < len(face_by_pos) else None
            if k is not None:
                fam, kb, ki, kfeats, kalt = k
                if fam is None and not kfeats and member_family is not None:
                    # Round-33 HIGH: a per-span face with NO explicit family
                    # keeps THIS char's own member family (a bolded mono word
                    # in a serif paragraph → LiberationMono-Bold, not the
                    # first member's serif). Bake it into the key HERE, where
                    # the member is known, so chars from different families
                    # split into their own subsets and the build step embeds
                    # the right typeface. `whole_para_face` (the true
                    # whole-paragraph A3b key) is returned untouched below —
                    # it resolves from the DOMINANT member, byte-identical.
                    k = (member_family.get(member.index), kb, ki, kfeats, kalt)
                elif kfeats and fam is None:
                    # 9.K2 (round-42 CRITICAL fix): a per-span feature with no
                    # explicit family applies IN PLACE from THIS char's own
                    # member. Bake the member INDEX so a feature on one run of
                    # a mixed-font paragraph re-embeds from THAT run's font
                    # (the build step resolves the member back), not the
                    # paragraph's first run. Before this, every per-span
                    # feature key collapsed to fam=None and the build resolved
                    # it from `first` — a small-caps edit on a later run whose
                    # own font had no feature borrowed the first run's font.
                    # (fam a str = an explicit family + feature: only Libertinus
                    # carries features, so it never applies in place — handled
                    # at the build step, where the member is forced to None.)
                    k = (member.index, kb, ki, kfeats, kalt)
                return k
        return whole_para_face

    def seq_crosses_face(pos: int, length: int) -> bool:
        # A ligature must not span a per-span face boundary — the member-
        # font sequence would silently swallow a substituted char. Inert
        # (returns False) whenever there are no per-span faces, so the
        # shipped/A5a paths keep forming ligatures byte-identically.
        if face_by_pos is None:
            return False
        for q in range(pos, min(pos + length, len(face_by_pos))):
            if face_by_pos[q] is not None:
                return True
        return False

    for span in spans:
        member = members_by_index[int(span["run"])]
        seg_text = new_text[span["start"] : span["end"]]
        i = 0
        while i < len(seg_text):
            ch = seg_text[i]
            pos = span["start"] + i
            # A5a/A5c: a ligature/atomic entry can carry ONE colour AND one
            # size — resolve both at its FIRST position (the glyph is
            # indivisible; a colour/face/size boundary inside a sequence
            # takes the start value).
            col = color_at(pos, member)
            siz = size_at(pos)
            fk = face_at(pos, member)
            if rtl_style is not None and _requires_shaping(ch):
                # 9.T3: a cursively joining character ALWAYS routes to a
                # SHAPING path, whatever `convert` says and whatever face was
                # asked for. This is not a conversion the user opts into:
                # the character cannot be re-emitted per code without drawing
                # a row of disconnected isolated forms, and broken output is
                # not an option the completeness standard leaves open.
                #
                # 9.T26: WHICH shaping path is the fidelity question. When
                # the caller qualified the document's own font (its embedded
                # program still carries the cmap and GSUB most subsetters
                # strip), the character keeps that font — the edit preserves
                # the document's typeface. Otherwise the bundled face
                # substitutes, exactly as T3 shipped. An explicit face
                # request (fk) always substitutes: asking for bold IS asking
                # to leave the document font.
                if fk is None and inplace_ok:
                    ik = (INPLACE_FAMILY, False, False, (), 0)
                    fb_by_face.setdefault(ik, set()).add(ch)
                    styled.append((ch, ref(member, ik, col, siz)))
                    i += 1
                    continue
                if fk is not None:
                    rb, ri = bool(fk[1]), bool(fk[2])
                else:
                    rb, ri = rtl_style.get(member.index, (False, False))
                rk = (RTL_FAMILY, rb, ri, (), 0)
                fb_by_face.setdefault(rk, set()).add(ch)
                styled.append((ch, ref(member, rk, col, siz)))
                i += 1
                continue
            if fk is not None:
                if member.vertical and not vertical_ok:
                    # The belt behind the paragraph-level routing: a
                    # horizontal face dropped into a column lays out on the
                    # wrong axis. Lifted (T4) when the caller resolved a
                    # vertical-capable face for it.
                    raise ValueError(
                        "vertical text cannot be converted to the fallback font"
                    )
                fb_by_face.setdefault(fk, set()).add(ch)
                styled.append((ch, ref(member, fk, col, siz)))
                i += 1
                continue
            # 9.B5: an unambiguous ligature sequence becomes ONE atomic
            # styled entry — matched BEFORE the single map (the encode
            # order), so the width math and the emitted bytes agree by
            # construction (text_width and encode share the matcher).
            # Sequences never cross spans; nor a per-span face boundary.
            seq = member.cap._sequence_at(seg_text, i)
            if seq is not None and not seq_crosses_face(pos, len(seq)):
                styled.append((seq, ref(member, None, col, siz)))
                i += len(seq)
                continue
            if ch == " " or member.cap.can_encode(ch):
                styled.append((ch, ref(member, None, col, siz)))
            elif convert:
                if member.vertical and not vertical_ok:
                    # The 7.4 fallback embeds a HORIZONTAL Identity-H face —
                    # dropped into a column it would render on the wrong
                    # axis. T4 lifts this exactly when a vertical-capable
                    # face was resolved for the paragraph.
                    raise ValueError(
                        "vertical text cannot be converted to the fallback font"
                    )
                # B1 dominant/convert face: family resolves from the first
                # member (the build step), style regular — byte-identical to
                # the shipped single convert subset. 9.K2: no feature ⇒
                # `((), 0)`, so the convert key is unchanged in effect.
                ck = (None, False, False, (), 0)
                # T27: a mark falling back drags its base with it, or the two
                # end up in different fonts and the accent draws beside the
                # letter instead of on it.
                if unicodedata.combining(ch):
                    _pull_base_into_fallback(styled, fb_by_face, ck)
                fb_by_face.setdefault(ck, set()).add(ch)
                styled.append((ch, ref(member, ck, col, siz)))
            else:
                raise ValueError(f"font cannot encode {ch!r}")
            i += 1
    return styled, fb_by_face


class _Word:
    __slots__ = ("chars", "width", "gap_after", "gap_styles", "char_widths")

    def __init__(self):
        self.chars: list[tuple[str, _StyleRef]] = []
        self.width = 0.0
        self.gap_after = 0.0  # user units of following space chars
        self.gap_styles: list[tuple[str, _StyleRef, float]] = []  # (char, style, w)
        # 9.T3: each char's width AS MEASURED during tokenizing, i.e. in
        # LOGICAL order with its logical kern neighbour. A bidi line is
        # re-ordered before emission, so re-measuring downstream would take
        # kern pairs from the VISUAL neighbours and quietly disagree with the
        # wrap that already happened. Carrying the number is what makes
        # measured and drawn the same number by construction.
        self.char_widths: list[float] = []


class _KernSource:
    """Pair kerning for whatever face a slice actually renders in (9.K1b).

    Resolution per style: a slice substituted into a bundled face kerns from
    that face; a slice left in the document's own font kerns from that font —
    its EMBEDDED program if it has one, else its metric twin among the bundled
    faces (B1 vendored Liberation for Helvetica/Times/Courier metric
    compatibility, and kerning is a metric).

    Kerning the document's own fonts is the point, not a bonus: re-emitting a
    paragraph DISCARDS the kerning its original `TJ` carried, so before this
    an edit visibly un-kerned the text (DECISIONS #37).

    Memoized on (member index, face key) — members repeat across spans and
    parsing a font program per character would be absurd. `{}` everywhere
    means "no kerning", which is also the honest answer for a monospace face
    or an unreadable program.
    """

    __slots__ = ("_resources", "_font_dir", "_fallbacks", "_cache")

    def __init__(self, resources, font_dir, fallbacks: dict):
        self._resources = resources
        self._font_dir = str(font_dir or "")
        self._fallbacks = fallbacks
        self._cache: dict = {}

    def pairs_for(self, st: "_StyleRef") -> dict:
        key = (st.member.index, st.fallback)
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        pairs: dict = {}
        try:
            from engine.font_kerning import kern_pairs, kern_pairs_for_font

            if st.fallback is not None:
                fb = self._fallbacks.get(st.fallback)
                # 9.K2: an in-place feature face captured its kerning at build
                # time (its temp program is already unlinked), so use that;
                # otherwise read the (bundled, still-present) face's table.
                captured = getattr(fb, "kern_pairs", None) if fb is not None else None
                if captured is not None:
                    pairs = captured
                else:
                    face = getattr(fb, "face_path", None) if fb is not None else None
                    if face:
                        pairs = kern_pairs(str(face))
            else:
                from engine.text_runs import _lookup_font

                fd = _lookup_font(
                    st.member.style["font_name"],
                    st.member.resources or self._resources,
                    self._resources,
                )
                if fd is not None:
                    pairs = kern_pairs_for_font(fd, self._font_dir)
        except Exception:
            pairs = {}  # never let a font quirk break an edit
        self._cache[key] = pairs
        return pairs

    def between(self, prev_ch, ch: str, st: "_StyleRef") -> float:
        """Kern between two adjacent chars in the SAME style, 1000ths of em.
        Returns 0 across a style boundary — a pair spanning two different
        faces is not a pair either font has an opinion about."""
        if not prev_ch:
            return 0.0
        return self.pairs_for(st).get((prev_ch, ch), 0.0)


def _char_width_user(ch: str, st: _StyleRef, fallbacks: dict, median_gap_1000: float,
                     kerns=None, prev_ch=None, prev_st=None) -> float:
    m = st.member
    s = st.style()
    if st.shaped is not None:
        # 9.T3: a shaped word measures as the GLYPHS the shaper chose, and
        # the number to sum is the shaper's POSITIONED advance — because that
        # is exactly what the emission steps by. `_pieces` writes each glyph
        # as [-x_off, glyph, x_off + width - advance]: the pen moves x_off,
        # then the /W width, then back by the correction, netting `advance`.
        #
        # 9.T22 fix: this used to sum the /W widths instead, on the reasoning
        # that /W is what the viewer adds up. Per glyph it is — but the TJ
        # correction is part of the same pen walk, so the DRAWN advance is
        # the shaper's, and measuring by /W disagreed by exactly the GPOS
        # advance deltas. Probe-caught before the Latin path could reach it,
        # and it was already live: IBM Plex Sans Arabic carries `kern`, and
        # `مرحبا` measured 40/1000 em narrower than it drew — a wrap and
        # justify error on shipped RTL. Latin makes it unmissable (Liberation
        # Sans kerns `AVATAR` by ~297/1000). Tc applies once per GLYPH, Tw
        # never (no space inside a word).
        w = (
            st.shaped.advance_1000 / 1000.0 * s["size"]
            + s["char_spacing"] * len(st.shaped.glyphs)
        )
        return w * (s["h_scale"] * m.a)
    if st.fallback is not None:
        fb = fallbacks.get(st.fallback)
        w1000 = fb.width_1000(ch) if fb is not None else 0.0
        w = w1000 / 1000.0 * s["size"] + s["char_spacing"]
    elif ch == " " and not m.cap.can_encode(" "):
        # Synthetic gap — emitted as a TJ kern, so no Tc/Tw applies.
        w = median_gap_1000 / 1000.0 * s["size"]
    else:
        # 9.B5: text_width longest-matches — a single char measures as
        # char_width; an atomic ligature entry measures as its ONE code's
        # width with ONE char_spacing (one rendered glyph).
        w = m.cap.text_width(ch) / 1000.0 * s["size"] + s["char_spacing"]
        if ch == " " and m.cap.single_byte_codes():
            try:
                if m.cap.encode(" ") == b" ":
                    w += s["word_spacing"]
            except ValueError:
                pass
    # 9.K1b: the pair kern with the PRECEDING character, when both render in
    # the same style. The width model must carry it or wrapping, justify and
    # the resync would disagree with what the TJ actually draws.
    if kerns is not None and prev_ch and prev_st is not None and prev_st.key == st.key:
        w += kerns.between(prev_ch, ch, st) / 1000.0 * s["size"]
    # 9.B4b: a vertical member's advance lives on the transposed x′ axis,
    # whose user scale is d — Tz never applies vertically (Tc does, and
    # already rode in above). Horizontal is byte-identical.
    return w * (m.d if m.vertical else s["h_scale"] * m.a)


# 9.T3: the face-key family that means "the bundled right-to-left face".
# It is not a user-selectable family like serif/sans/mono — it is the
# automatic, TEXT-driven switch a joining script forces, the same shape T5's
# CJK switch has. `_face_sort_key` orders it with the named families.
RTL_FAMILY = "rtl"
# 9.T26: the face key meaning "shape with the DOCUMENT'S OWN embedded
# program" — reachable only when the paragraph's font passes the in-place
# gate, never from user input (`_validated_family` refuses anything that is
# not the bundled trio or an absolute path).
INPLACE_FAMILY = "inplace"


def _shape_styled_runs(styled: list, key: tuple, face: str) -> tuple[list, list]:
    """9.T3 — collapse each run of same-style joining-script characters in
    `styled` into ONE shaped entry, and return (new styled, shaped runs).

    Per WORD, because cursive joining never crosses a space: that is the
    largest unit whose glyphs do not depend on its neighbours, so the line
    breaker can still move it anywhere. Runs that HarfBuzz cannot express in
    this face are left alone — the character path then refuses them by name,
    which is the honest floor rather than a silent `.notdef`."""
    from engine import shaping

    out: list = []
    runs: list = []
    i = 0
    while i < len(styled):
        text, st = styled[i]
        if st.fallback != key or st.shaped is not None or not shaping.requires_shaping(text):
            out.append((text, st))
            i += 1
            continue
        j = i
        chunk: list[str] = []
        while j < len(styled):
            t2, s2 = styled[j]
            if s2.key != st.key or t2 == " " or s2.shaped is not None:
                break
            chunk.append(t2)
            j += 1
        word = "".join(chunk)
        try:
            run = shaping.shape(face, word, rtl=True)
        except Exception:
            out.extend(styled[i:j])
            i = j
            continue
        runs.append(run)
        out.append((
            word,
            _StyleRef(st.member, st.fallback, st.size_override, st.color_override, shaped=run),
        ))
        i = j
    return out, runs


def _pull_base_into_fallback(styled: list, fb_by_face: dict, key: tuple) -> None:
    """9.T27 — a combining mark cannot render in a different font from the
    letter it sits on, so move that letter into the mark's face.

    The convert path routes ONE CHARACTER AT A TIME: it keeps whatever the
    document's own font can encode and falls back only for what it cannot.
    For `cafe` + COMBINING ACUTE that puts the `e` in the document font and
    the accent in a substitute subset — two fonts, so the shaper never sees
    them together and the accent draws as a spacing glyph after the letter.
    (This is why the shaping work looked like it fired and did not: the mark
    was alone in its chunk, with nothing to compose with.)

    Pulling the base across makes the pair ONE unit in ONE face, which is
    both what shaping needs and independently correct — a mark positioned by
    one font's metrics over a glyph drawn from another is wrong even
    unshaped. Only a single preceding character is moved, and only when it
    is genuinely a base in the document font: a space, an atomic ligature
    entry (9.B5) or a slice already substituted is left alone rather than
    guessed at."""
    j = len(styled) - 1
    # Marks already pulled across for this same cluster.
    while j >= 0 and len(styled[j][0]) == 1 and unicodedata.combining(styled[j][0]):
        j -= 1
    if j < 0:
        return
    text, st = styled[j]
    if len(text) != 1 or text == " " or st.fallback is not None:
        return
    fb_by_face.setdefault(key, set()).add(text)
    styled[j] = (
        text,
        _StyleRef(st.member, key, st.size_override, st.color_override),
    )


def _shape_ltr_runs(styled: list, key: tuple, face: str) -> tuple[list, list]:
    """9.T22/T23 — shape same-style LEFT-TO-RIGHT words against the face this
    style is about to embed, keeping only the runs shaping actually changes.

    The mirror of `_shape_styled_runs` (which serves joining scripts), with
    two differences that matter. It runs the buffer `ltr`, and it is
    SELECTIVE: a joining script has no correct per-character rendering at all,
    so there the shaper's answer always wins, whereas Latin renders correctly
    per character until a ligature or a mark is involved. `_shaping_changed_it`
    is that line.

    Chunks break at spaces (nothing shapes across one) and at CJK characters,
    because the line breaker wraps AFTER any CJK character and a collapsed run
    is atomic — swallowing a CJK stretch into one word would take away every
    break opportunity inside it. CJK shapes trivially anyway, so nothing is
    lost by keeping it on the character path."""
    from engine import shaping

    out: list = []
    runs: list = []
    i = 0
    while i < len(styled):
        text, st = styled[i]
        if (
            st.fallback != key
            or st.shaped is not None
            or not text
            or text == " "
            or (text and _cjk(text[0]))
            or shaping.requires_shaping(text)
        ):
            out.append((text, st))
            i += 1
            continue
        j = i
        chunk: list[str] = []
        while j < len(styled):
            t2, s2 = styled[j]
            if (
                s2.key != st.key
                or t2 == " "
                or s2.shaped is not None
                or not t2
                or _cjk(t2[0])  # safe: `not t2` short-circuits above
            ):
                break
            chunk.append(t2)
            j += 1
        word = "".join(chunk)
        run = shaping.shape_if_it_changes(face, word)
        if run is None:
            out.extend(styled[i:j])
            i = j
            continue
        runs.append(run)
        out.append((
            word,
            _StyleRef(st.member, st.fallback, st.size_override, st.color_override, shaped=run),
        ))
        i = j
    return out, runs


def _embed_shaping_aware(pdf, face: str, chars: str, styled: list, key: tuple):
    """9.T22/T23 — embed the subset this style needs, shaped when shaping
    changes the result and a plain simple font when it does not.

    Returns `(styled, _Fallback)`; `styled` comes back with any shaped word
    collapsed into one entry, exactly as the joining-script path returns it.

    Which builder runs is decided by the TEXT, not by the font's feature
    list: a face may carry `liga` and the paragraph contain nothing that
    forms one. When nothing changed, `build_fallback_font` runs and the
    output is byte-identical to what shipped before shaping reached this
    path — which is the property that lets this be applied everywhere rather
    than behind a switch."""
    from engine.font_fallback import build_fallback_font, build_shaped_font

    shaped_styled, runs = _shape_ltr_runs(styled, key, face)
    if runs:
        try:
            fdict, fenc, fwidth, genc, gwidth = build_shaped_font(
                pdf, face, chars, runs
            )
        except ValueError:
            # A CFF face that cannot carry two spellings of one glyph (see
            # `build_shaped_font`). The unshaped path's output is CORRECT —
            # it just forms no ligature — so take it rather than draw the
            # wrong glyphs.
            runs = []
    if not runs:
        font_dict, encode, width_1000 = build_fallback_font(pdf, face, chars)
        return styled, _Fallback(None, font_dict, encode, width_1000, face)
    return shaped_styled, _Fallback(
        None, fdict, fenc, fwidth, face, glyph_encode=genc, glyph_width=gwidth,
    )


def _tokenize(
    styled: list[tuple[str, _StyleRef]], fallbacks: dict, median_gap_1000: float,
    kerns=None,
) -> list[_Word]:
    """Words with break opportunities: at spaces, and AFTER any CJK char
    (no-space scripts must wrap). Kinsoku-lite: a chunk that would START
    with closing punctuation glues to the previous word."""
    words: list[_Word] = []
    current = _Word()

    def close() -> None:
        nonlocal current
        if current.chars or current.gap_styles:
            words.append(current)
            current = _Word()

    prev_ch = None
    prev_st = None
    for ch, st in styled:
        w = _char_width_user(ch, st, fallbacks, median_gap_1000, kerns, prev_ch, prev_st)
        prev_ch, prev_st = ch[-1] if ch else None, st
        if ch == " ":
            current.gap_after += w
            current.gap_styles.append((ch, st, w))
            continue
        if current.gap_styles:
            # T16 (行末禁則): a chunk ENDING with an opening bracket/quote
            # must not end a line — the break opportunity after it is
            # suppressed by FOLDING the gap into the word and continuing,
            # so the opener travels with the word it opens. The spaces stay
            # document text (chars + width), so the round-trip is untouched.
            if current.chars and current.chars[-1][0][-1] in NO_LINE_END:
                for gch, gst, gw in current.gap_styles:
                    current.chars.append((gch, gst))
                    current.char_widths.append(gw)
                    current.width += gw
                current.gap_after = 0.0
                current.gap_styles = []
            else:
                close()  # a non-space after gap chars starts the next word
        elif (
            current.chars
            and ch not in NO_LINE_START
            # T16: no break AFTER an opener either (the CJK-boundary break
            # is the common Japanese case: 「日 must stay together).
            and current.chars[-1][0][-1] not in NO_LINE_END
            # 9.B5: entries can be atomic multi-char ligatures — classify
            # the break by the boundary-adjacent code points.
            and (_cjk(current.chars[-1][0][-1]) or _cjk(ch[0]))
        ):
            close()  # break after (and before) CJK — no-space scripts wrap
        current.chars.append((ch, st))
        current.char_widths.append(w)
        current.width += w
    close()
    return words


class _LayoutLine:
    __slots__ = ("words", "width", "x", "y", "justify_extra", "max_eff", "vis_items")

    def __init__(self):
        self.words: list[_Word] = []
        self.width = 0.0
        self.x = 0.0
        self.y = 0.0
        self.justify_extra = 0.0  # per-gap addition (justified lines)
        # 9.A5c: the tallest glyph's effective size on this line, filled by
        # _fill_lines — drives the per-line leading when sizes vary.
        self.max_eff = 0.0
        # 9.T3: the line's items already in VISUAL order, with their measured
        # widths, for a bidi paragraph. None keeps `_segments` on the shipped
        # word walk, so every left-to-right emission is untouched.
        self.vis_items: list | None = None


def _visual_items(line: _LayoutLine, base_level: int) -> list:
    """9.T3 — the line's items in VISUAL order.

    An item is `("ch", text, style, width)` or `("gap", char, style, width)`;
    the trailing word's gap is dropped exactly as the shipped `_segments`
    drops it (rule L1 resets a line-final space to the base level anyway, so
    dropping it BEFORE reordering and letting L1 handle nothing is the same
    answer by two routes).

    Reordering is by character, not by word: an RTL word's letters mirror
    within the word as well as the words mirroring within the line, and only
    a character-level permutation gets both. Widths ride along, so the line's
    total is invariant under the reordering — the wrap that already happened
    stays valid."""
    items: list = []
    last = len(line.words) - 1
    for wi, word in enumerate(line.words):
        for (text, st), w in zip(word.chars, word.char_widths):
            items.append(["ch", text, st, w])
        if wi != last:
            for ch, st, w in word.gap_styles:
                items.append(["gap", ch, st, w])
    ordered = bidi.reorder_to_visual(items, base_level, key=lambda it: it[1][:1] or " ")
    if len(ordered) != len(items):
        # Rule X9 drops explicit directional formatting codes; a paragraph
        # whose EDITED text carries them cannot be laid out honestly.
        raise ValueError(
            "directional formatting characters cannot be re-laid-out in a paragraph"
        )
    return ordered


def _char_eff(st: _StyleRef) -> float:
    # 9.A5c: this char's effective size, scaling the member's OWN eff by the
    # per-span size ratio. Using member.eff (not a raw size·a) keeps the axis
    # CONSISTENT with dom_eff_orig / base_ratio — horizontal eff is size·d,
    # vertical size·a; deriving from member.eff picks the right one for free
    # (a raw size·a disagreed for an anamorphically-scaled a≠d run). Exact
    # for the no-override case: size == member's own ⇒ ratio 1 ⇒ member.eff.
    base_size = st.member.style["size"]
    if not base_size:
        return st.member.eff
    return st.member.eff * (st.style()["size"] / base_size)


def _line_max_eff(line: _LayoutLine) -> float:
    # 9.A5c: the tallest glyph's effective size on the line. Spaces
    # (gap_styles) count too, so a per-span size on a trailing space still
    # tallies. Equal across every line ⇒ no per-span size ⇒ _position_lines
    # takes the shipped path.
    best = 0.0
    for word in line.words:
        for _ch, st in word.chars:
            eff = _char_eff(st)
            if eff > best:
                best = eff
        for _ch, st, _w in word.gap_styles:
            eff = _char_eff(st)
            if eff > best:
                best = eff
    return best


def _fill_lines(words: list[_Word], first_measure: float, body_measure: float) -> list[_LayoutLine]:
    lines: list[_LayoutLine] = []
    line = _LayoutLine()
    measure = first_measure
    for word in words:
        candidate = line.width + (line.words[-1].gap_after if line.words else 0.0) + word.width
        if line.words and candidate > measure + WRAP_TOL:
            lines.append(line)
            line = _LayoutLine()
            measure = body_measure
        if line.words:
            line.width += line.words[-1].gap_after
        line.words.append(word)
        line.width += word.width
    if line.words:
        lines.append(line)
    for ln in lines:
        ln.max_eff = _line_max_eff(ln)
    return lines


def _position_lines(
    lines: list[_LayoutLine],
    para: _Paragraph,
    first_left: float,
    body_left: float,
    leading: float,
    y0: float | None = None,
    base_ratio: float = 0.0,
    has_span_size: bool = False,
    box_edges: tuple[float, float] | None = None,
) -> None:
    # T18 resize: center/right/justify position against the paragraph's OWN
    # edges — an explicit box passes its edges here or those alignments
    # would ignore the resize entirely. None = the shipped para edges.
    left_edge, right_edge = box_edges if box_edges else (para.left, para.right)
    # y0 overrides the anchor for a block that does NOT start at the
    # paragraph's own first baseline (A4 split: the second block starts
    # 2×leading below the first block's last line).
    if y0 is None:
        y0 = para.lines[0].y
    # 9.A5c per-line leading: when the lines' tallest glyphs DIFFER (a
    # per-span size edit), each baseline drops by the adjacent-max rule —
    # `max(max_eff[i-1], max_eff[i]) · base_ratio`, base_ratio = the
    # leading-per-unit-size the CALLER resolved (`build` passes it from BOTH
    # the measured-leading and the single-line-fallback branches — round-34
    # HIGH: an originally-single-line paragraph has `para.leading` None even
    # after it reflows to many lines, so gating on `para.leading` left its
    # wrapped output with flat leading around a big glyph). This gives the
    # bigger line its descenders + the next line's ascenders room. THE
    # BYTE-IDENTITY GATE (non-negotiable): when every max_eff is equal (no
    # per-span size — the uniform + A1-whole-para cases), take the EXACT
    # shipped `y0 - i·leading` (ONE multiply, float-identical). Per-line
    # accumulation would drift the last bits, so it fires ONLY when sizes
    # vary. The A4 split gap stays inter-BLOCK (the caller's y0 chaining).
    # Round 35 (finding 2): the gate is `has_span_size`, NOT max_eff spread —
    # a grouped paragraph can carry members that ALREADY differ in size (up to
    # SIZE_JUMP_RATIO) with no size edit at all, and inferring "a size was
    # requested" from the spread reflowed such a paragraph's lines on a plain
    # colour/null edit. A whole-paragraph A1 size also stays flat here (its
    # scale is uniform ⇒ shipped path), so `size_override` deliberately does
    # NOT arm this — only a per-span size does.
    effs = [ln.max_eff for ln in lines]
    varying = (
        has_span_size
        and len(effs) > 1
        and base_ratio > 0.0
        and (max(effs) - min(effs)) > _MAX_EFF_EPS
    )
    for i, line in enumerate(lines):
        if not varying:
            line.y = y0 - i * leading
        elif i == 0:
            line.y = y0
        else:
            line.y = lines[i - 1].y - max(effs[i - 1], effs[i]) * base_ratio
        if para.alignment == "center":
            # No clamp: an overflowing line centers symmetrically too.
            line.x = left_edge + ((right_edge - left_edge) - line.width) / 2
        elif para.alignment == "right":
            line.x = right_edge - line.width
        else:
            line.x = first_left if i == 0 else body_left
        if (
            para.alignment == "justify"
            and i < len(lines) - 1
            and len(line.words) > 1
        ):
            deficit = (right_edge - line.x) - line.width
            gaps = len(line.words) - 1
            if deficit > 0 and gaps > 0:
                line.justify_extra = deficit / gaps


def _invert(m) -> tuple:
    a, b, c, d, e, f = m
    det = a * d - b * c
    if abs(det) < 1e-12:
        raise ValueError("cannot re-lay-out text under a degenerate transform")
    ia = d / det
    ib = -b / det
    ic = -c / det
    id_ = a / det
    ie = -(e * ia + f * ic)
    if_ = -(e * ib + f * id_)
    return (ia, ib, ic, id_, ie, if_)


def _color_op_instructions(color) -> list:
    ops = []
    cs_op, val_op = color
    for op in (cs_op, val_op):
        if op is None:
            continue
        operator, operands = op
        vals = []
        for v in operands:
            if isinstance(v, str):
                vals.append(Name(v if v.startswith("/") else "/" + v))
            else:
                vals.append(v)
        ops.append(_instruction(vals, operator))
    return ops


def _color_sync(target, current, stroke: bool) -> list:
    if isinstance(current, tuple) and color_equal(target, current, stroke):
        return []
    if target == (None, None):
        return [_instruction([0], "G" if stroke else "g")]
    return _color_op_instructions(target)


def _f(v: float) -> float:
    r = round(v, 6)
    return 0.0 if r == 0 else r


# Single-line paragraphs have no measured leading and their box is exactly
# their own text — wrapping AT that width would tower one word per line,
# and never wrapping ran a grown title off the page (review-caught
# CRITICAL, reproduced at 1.8× page width). The rule: a single line
# extends right to the page's SYMMETRIC margin (mirror the left inset)
# before wrapping, and wrapped lines stack at standard single spacing.
SINGLE_LINE_LEADING_EM = 1.2

# A1 size clamp: the common PDF viewer maximum (matches the editor input's
# declared max). Bounds a fat-fingered size so text can't fly off the page.
_MAX_EDIT_SIZE = 1638.0

# 9.A5c per-line-leading uniformity floor: lines whose tallest-glyph eff
# differ by more than this (points) get per-line leading; equal within it
# take the shipped constant-leading path (byte-identity gate). Point sizes
# differ by whole points, and a uniform line's max_eff is float-EXACT, so an
# absolute epsilon this small never conflates a real size change with noise.
_MAX_EFF_EPS = 1e-6


class _Emission:
    """The paragraph's replacement ops, built once the rewriter reaches the
    first member (the ctm there anchors the user-space line targets)."""

    def __init__(
        self, para: _Paragraph, styled, fallbacks: dict, page_x0: float, page_x1: float,
        size_override=None, split_at=None, has_span_size=False, kerns=None,
        base_level=None, split_gap=None, box_width=None, box_left=None,
    ):
        self.para = para
        # 9.T3: the bidi base level when this paragraph reorders (0 or 1),
        # None when it does not. Set ⇒ every wrapped line is permuted from
        # logical into visual order before segmentation; None ⇒ the shipped
        # word walk, untouched.
        self.base_level = base_level
        self.styled = styled
        # 9.K1b: pair-kerning source for whatever face each slice renders
        # in; None keeps the pre-K1b un-kerned emission.
        self.kerns = kerns
        # 9.A5c: True when the caller folded per-span SIZE ranges (size_by_pos
        # is not None). The per-line-leading rule + the size-aware split gap
        # fire ONLY under this flag — a whole-paragraph A1 size or a
        # no-size/colour/face edit keeps the shipped flat rhythm and split
        # gap, so those stay byte-identical even for a paragraph whose grouped
        # members already vary in size (review round 35, finding 2). The
        # anisotropic-eff variance a≠d edge is why this can't be inferred from
        # max_eff spread alone.
        self.has_span_size = has_span_size
        # 9.A5b: {face key → _Fallback}, one subset per distinct requested
        # face (was the single `self.fb`). Empty when nothing substitutes.
        self.fallbacks = fallbacks
        # 9.B4b: for a vertical paragraph the caller passes the TRANSPOSED
        # page bounds (x′ = −y of the mediabox) — the whole layout runs in
        # transposed space, the single-line margin rule included.
        self.page_x0 = page_x0
        self.page_x1 = page_x1
        # 9.B4b: the paragraph's writing mode — the rewriter advances its
        # emitted-state machine on this axis after each emitted show.
        self.vertical = para.vertical
        # A1: when the size is overridden, the paragraph leading scales by
        # the same factor so bigger text doesn't overlap (and smaller
        # text doesn't waste space) — the ratio to the paragraph's
        # dominant original size.
        self.size_override = size_override
        # A4: a styled-index split point — the second block lays out as its
        # own paragraph 2×leading below the first (a gap the re-listing
        # grouping can never join across, so the output relists as TWO
        # paragraphs through the shipped heuristics).
        self.split_at = split_at
        # T18: the split gap as a LEADING multiple (None = the shipped 2.0).
        # The 2×eff relist floor below is never scaled by it — a tighter
        # request stops at the tightest gap that still lists as two.
        self.split_gap = split_gap
        # T18 resize: an explicit box width (points, paragraph space) and,
        # optionally, a new left edge. None = the shipped derived measures,
        # byte-identical.
        self.box_width = box_width
        self.box_left = box_left
        # T17: the positioned layout, computed ONCE — a cross-stream edit
        # calls build once per target stream and every call must see the
        # SAME lines (same _StyleRef identities, same positions).
        self._laid: list[_LayoutLine] | None = None
        # T17: user-space bbox of the pieces the LAST build call emitted
        # (None when it emitted nothing) — the rewriter expands a target
        # form copy's /BBox by this so emitted text is never clipped away.
        self.last_build_bbox: list[float] | None = None

    def build(self, ctm, stream=None, used=None) -> list[tuple]:
        """[(kind, instruction, raw_width|None)]; kind ∈ {'op','show'} —
        the caller feeds ops into its emitted-state machine and advances
        after shows.

        T17: `stream` filters the emission to pieces whose style MEMBER
        lives in that stream (None = everything, the single-stream path —
        identical output, since every member then shares the one stream).
        Segments never span members (`_StyleRef.key` carries the member
        index), so the routing is exact. `used` (a set) collects the
        fallback face keys THIS call actually emitted, for the caller's
        per-stream font registration."""
        para = self.para
        self.last_build_bbox = None
        if not self.styled:
            return []
        lines = self._layout()
        if not lines:
            return []
        return self._emit(lines, ctm, stream, used)

    def _layout(self) -> list:
        if self._laid is not None:
            return self._laid
        para = self.para
        body_lefts = [l.x0 for l in para.lines[1:]]
        first_left = para.lines[0].x0
        body_left = min(body_lefts) if body_lefts else first_left
        if para.alignment in ("center", "right"):
            first_left = body_left = para.left
        # A1 leading scale: new size / the dominant original size.
        dom_style_size = _widest(para.lines[0].members).style["size"] or 12.0
        size_scale = (self.size_override / dom_style_size) if self.size_override else 1.0
        # 9.A5c: the per-line leading rule (below) maps a line's tallest eff
        # to its baseline gap via `base_ratio`, resolved HERE in BOTH branches
        # (round-34 HIGH: an originally-single-line paragraph keeps
        # `para.leading` None even once its edit reflows it to many lines).
        dom_eff_orig = _widest(para.lines[0].members).eff
        if para.leading is not None:
            leading = para.leading * size_scale
            right_limit = para.right
            base_ratio = (para.leading / dom_eff_orig) if dom_eff_orig else 0.0
        else:
            dominant = _widest(para.lines[0].members)
            base_eff = (
                dominant.eff * size_scale if self.size_override else dominant.eff
            )
            leading = SINGLE_LINE_LEADING_EM * base_eff
            # The single-line rhythm IS 1.2·eff, so its leading-per-unit-size
            # is exactly SINGLE_LINE_LEADING_EM (leading / base_eff).
            base_ratio = SINGLE_LINE_LEADING_EM
            if self.base_level == 1:
                # 9.T3: a right-to-left paragraph grows LEFTWARD from its own
                # right edge, so the symmetric-margin rule mirrors — the
                # measure is bounded by the LEFT page margin, and the box's
                # left edge moves rather than its right. Without this the
                # single-line branch offers a measure the line can never use
                # and the text walks off the left side of the page.
                margin = max(self.page_x1 - para.right, 0.0)
                first_left = body_left = min(self.page_x0 + margin, para.left)
                right_limit = para.right
            else:
                # Symmetric page margin, never narrower than the existing line
                # (unchanged text must not rewrap under its own edit).
                margin = max(para.left - self.page_x0, 0.0)
                right_limit = max(self.page_x1 - margin, para.right)
        first_measure = right_limit - first_left
        body_measure = right_limit - body_left
        # T18 resize: an explicit width replaces the derived measures. The
        # first-line indent (its delta from the body edge) survives, so the
        # opener keeps its shape at the new width. An explicit left edge
        # moves the whole box — the renderer sends it when the LEFT handle
        # dragged; width alone anchors the left edge and moves the right.
        box_edges = None
        if self.box_width is not None:
            indent = first_left - body_left
            if self.box_left is not None:
                body_left = float(self.box_left)
                first_left = body_left + indent
            body_measure = float(self.box_width)
            first_measure = body_measure - indent
            if first_measure <= 0 or body_measure <= 0:
                raise ValueError(
                    "the requested box is narrower than the first-line indent"
                )
            box_edges = (body_left, body_left + body_measure)
        # A4 split: each block is its OWN paragraph (fresh first-line
        # indent, own justify-final-line), the second anchored below the
        # first by a gap the re-listing grouping can NEVER join across.
        # 2×leading alone was NOT that gap (review-caught HIGH, repro'd at
        # leading ≤ 0.8×eff): a single-line first block has no measured
        # deltas, so the join test uses the 1.6-em cap — condensed leading
        # made 2×leading clear the drift test but not the cap, and the
        # blocks re-joined GARBLED. The floor of 2×eff beats the cap
        # (1.6×eff) with margin; max() keeps ≥2×leading for airy layouts
        # (which beats the ±25% drift window for any leading < 1.6×eff).
        # Split-edge spaces are trimmed (the caret split must not leave an
        # invisible leading/trailing gap word).
        if self.split_at is not None and 0 < self.split_at < len(self.styled):
            part_a = list(self.styled[: self.split_at])
            part_b = list(self.styled[self.split_at :])
            while part_a and part_a[-1][0] == " ":
                part_a.pop()
            while part_b and part_b[0][0] == " ":
                part_b.pop(0)
            parts = [p for p in (part_a, part_b) if p]
        else:
            parts = [self.styled]
        dom_eff = _widest(para.lines[0].members).eff * size_scale
        # T18: the user's gap factor scales the LEADING term only; the 2×eff
        # relist floor is the guarantee the output still lists as two
        # paragraphs (it defeats the 1.6-em join cap with margin) and never
        # shrinks below it. Factor 2.0 (the default) is byte-identical.
        gap_factor = 2.0 if self.split_gap is None else float(self.split_gap)
        base_split_gap = max(gap_factor * leading, 2.0 * dom_eff)
        lines: list[_LayoutLine] = []
        prev_last: _LayoutLine | None = None
        for part in parts:
            words = _tokenize(part, self.fallbacks, para.median_gap_1000, self.kerns)
            if not words:
                continue
            block = _fill_lines(words, first_measure, body_measure)
            if self.box_width is not None:
                # An explicit resize REFUSES when a word cannot fit the box
                # (the shipped no-resize path tolerates a natural overlong
                # word — center even documents "no clamp" — but honoring an
                # impossible request would silently overflow the very box
                # the user just drew).
                limit = max(first_measure, body_measure) + 0.5
                for ln in block:
                    if ln.width > limit:
                        raise ValueError(
                            "the paragraph cannot wrap to that width — a word is wider than the box"
                        )
            if prev_last is not None and block:
                # A4 split gap from the previous block's last line to this
                # block's first line. 9.A5c (review round 35, finding 1): with
                # a per-span size the boundary line's tallest glyph can be far
                # bigger than the paragraph's dominant size, and a fixed
                # `2×leading` gap let an enlarged word's DESCENDER bleed into
                # the next block; widen by the boundary lines' own leading.
                # Gated on has_span_size so a no-per-span-size split keeps the
                # shipped gap EXACTLY (the boundary term only ~equals 2×leading
                # for uniform sizes, so an unconditional max() would perturb it
                # by a ULP — see _position_lines' byte-identity gate).
                split_gap = base_split_gap
                if self.has_span_size:
                    boundary_eff = max(prev_last.max_eff, block[0].max_eff)
                    split_gap = max(base_split_gap, 2.0 * boundary_eff * base_ratio)
                y_next = prev_last.y - split_gap
            else:
                y_next = None
            _position_lines(
                block, para, first_left, body_left, leading, y0=y_next,
                base_ratio=base_ratio, has_span_size=self.has_span_size,
                box_edges=box_edges,
            )
            if block:
                prev_last = block[-1]
            lines.extend(block)
        if lines and self.base_level is not None:
            # 9.T3: wrapping happened in LOGICAL order (that is where line
            # breaks live); each finished line now permutes into the visual
            # order the page will draw. Per LINE, after wrapping — rule L1's
            # line-end reset is meaningless before the lines exist.
            for line in lines:
                line.vis_items = _visual_items(line, self.base_level)
        self._laid = lines
        return lines

    def _emit(self, lines: list, ctm, stream, used) -> list[tuple]:
        para = self.para
        ctm_inv = _invert(ctm)
        base = _widest(para.lines[0].members)
        lin_a, lin_d = base.a, base.d
        out: list[tuple] = []
        bbox: list[float] | None = None

        def grow(x0: float, y0: float, x1: float, y1: float) -> None:
            nonlocal bbox
            if bbox is None:
                bbox = [x0, y0, x1, y1]
            else:
                bbox[0] = min(bbox[0], x0)
                bbox[1] = min(bbox[1], y0)
                bbox[2] = max(bbox[2], x1)
                bbox[3] = max(bbox[3], y1)

        for line in lines:
            for seg in self._segments(line):
                st: _StyleRef = seg["style"]
                if stream is not None and st.member.stream != stream:
                    continue
                for dx, dy, encoded_items, raw in self._pieces(seg, lin_d):
                    # Rise renders via Ts (a state op), never the matrix —
                    # the line target is the BASELINE.
                    if self.vertical:
                        # 9.B4b: THE untranspose — layout ran wholly in
                        # transposed space; only the anchor maps back through
                        # T⁻¹(x′, y′) = (y′, −x′). The linear part stays
                        # (a, 0, 0, d): glyphs upright — the advance
                        # DIRECTION is the walker's vertical model
                        # (advance_after_show), never the matrix.
                        tx, ty = line.y, -(line.x + dx)
                    else:
                        tx, ty = line.x + dx, line.y + dy
                    target = (lin_a, 0.0, 0.0, lin_d, tx, ty)
                    # T17: a CONSERVATIVE user-space envelope of this piece
                    # (full em above the baseline, 0.35 em below, advance
                    # along the writing axis) — only ever used to EXPAND a
                    # target form's /BBox, where over-covering is harmless
                    # and under-covering clips text away.
                    eff = st.style()["size"] * abs(lin_d)
                    if self.vertical:
                        em = st.style()["size"] * abs(lin_a)
                        grow(tx - em, ty - raw * abs(lin_d), tx + em, ty)
                    else:
                        adv = raw * st.style()["h_scale"] * abs(lin_a)
                        grow(tx, ty - 0.35 * eff, tx + adv, ty + eff)
                    tm_op = mat_mult(target, ctm_inv)
                    out.append(("op", _instruction([_f(v) for v in tm_op], "Tm"), None))
                    out.extend(self._state_ops(st, used))
                    if len(encoded_items) == 1 and not isinstance(encoded_items[0], float):
                        out.append(
                            ("show", _instruction([pikepdf.String(encoded_items[0])], "Tj"), raw)
                        )
                    else:
                        arr = pikepdf.Array(
                            [
                                pikepdf.String(el) if isinstance(el, bytes) else _f(el)
                                for el in encoded_items
                            ]
                        )
                        out.append(("show", _instruction([arr], "TJ"), raw))
        self.last_build_bbox = bbox
        return out

    def _pieces(self, seg: dict, lin_d: float) -> list[tuple]:
        """[(dx, dy, TJ items, raw advance)] for one segment.

        Every ordinary segment is exactly ONE piece at the segment's own dx
        and no dy — byte-identical to the shipped single-show emission. A
        SHAPED segment (9.T3) splits only where a glyph carries a vertical
        mark offset, because a baseline shift is the one thing a TJ array
        cannot express: the piece gets its own Tm, raised by that offset. The
        horizontal half of mark positioning, and the GPOS advance deltas,
        stay inside the TJ where they belong."""
        st: _StyleRef = seg["style"]
        if st.shaped is None:
            items, raw = self._encode(seg)
            return [(seg["dx"], 0.0, items, raw)]

        s = st.style()
        m = st.member
        fb = self.fallbacks[st.fallback]
        axis = s["h_scale"] * m.a
        size = s["size"]
        pieces: list[tuple] = []
        items: list = []
        piece_dx = seg["dx"]
        piece_dy = 0.0
        piece_raw = 0.0
        dx = seg["dx"]

        def flush() -> None:
            nonlocal items, piece_dx, piece_dy, piece_raw
            if items:
                pieces.append((piece_dx, piece_dy, items, piece_raw))
            items = []
            piece_raw = 0.0

        for (name, advance, x_off, y_off), (_n2, spells) in zip(
            st.shaped.glyphs, st.shaped.clusters
        ):
            width = fb.glyph_width(name, spells)
            dy = y_off / 1000.0 * size * lin_d
            if items and abs(dy - piece_dy) > 1e-9:
                flush()
            if not items:
                piece_dx = dx
                piece_dy = dy
            if x_off:
                items.append(-x_off)  # a negative TJ number moves the pen right
            items.append(fb.glyph_encode(name, spells))
            trailing = x_off + width - advance
            if abs(trailing) > 1e-9:
                items.append(trailing)
            step = (advance / 1000.0 * size + s["char_spacing"]) * axis
            dx += step
            piece_raw += step / axis if axis else 0.0
        flush()
        return pieces or [(seg["dx"], 0.0, [b""], 0.0)]

    def _segments(self, line: _LayoutLine) -> list[dict]:
        """Split a line's char stream into same-style segments; synthetic
        spaces and justify extras become in-segment kerns (or fold into
        the next segment's absolute x at a style boundary)."""
        if line.vis_items is not None:
            return self._split_segments(self._visual_stream(line))
        stream: list[tuple] = []  # ("ch", ch, style, w) | ("kern", style, w)
        # 9.K1b: the preceding char/style, so a pair kern is only taken
        # between adjacent chars rendering in the SAME style.
        prev_ch_seg = None
        prev_st_seg = None
        for wi, word in enumerate(line.words):
            for ch, st in word.chars:
                stream.append((
                    "ch", ch, st,
                    _char_width_user(ch, st, self.fallbacks, self.para.median_gap_1000,
                                     self.kerns, prev_ch_seg, prev_st_seg),
                ))
                prev_ch_seg, prev_st_seg = (ch[-1] if ch else None), st
            is_last = wi == len(line.words) - 1
            if not is_last:
                for ch, st, w in word.gap_styles:
                    if ch == " " and st.fallback is None and not st.member.cap.can_encode(" "):
                        stream.append(("kern", st, w))
                    else:
                        stream.append(("ch", ch, st, w))
                if line.justify_extra:
                    last_style = word.gap_styles[-1][1] if word.gap_styles else word.chars[-1][1]
                    stream.append(("kern", last_style, line.justify_extra))
        return self._split_segments(stream)

    def _visual_stream(self, line: _LayoutLine) -> list[tuple]:
        """9.T3 — the same item stream `_segments` builds, from a line whose
        characters are already in visual order. Widths are the ones measured
        at wrap time; a run of adjacent gap items is one inter-word space, so
        the justify extra lands after it exactly as in the logical walk."""
        stream: list[tuple] = []
        items = line.vis_items
        i = 0
        while i < len(items):
            kind, text, st, w = items[i]
            if kind == "ch":
                stream.append(("ch", text, st, w))
                i += 1
                continue
            j = i
            while j < len(items) and items[j][0] == "gap":
                _k, ch, gst, gw = items[j]
                if ch == " " and gst.fallback is None and not gst.member.cap.can_encode(" "):
                    stream.append(("kern", gst, gw))
                else:
                    stream.append(("ch", ch, gst, gw))
                j += 1
            if line.justify_extra:
                stream.append(("kern", items[j - 1][2], line.justify_extra))
            i = j
        return stream

    def _split_segments(self, stream: list[tuple]) -> list[dict]:
        segments: list[dict] = []
        current: dict | None = None
        dx = 0.0
        for item in stream:
            st = item[2] if item[0] == "ch" else item[1]
            w = item[3] if item[0] == "ch" else item[2]
            if current is None or current["style"].key != st.key:
                current = {"style": st, "items": [], "width": 0.0, "dx": dx}
                segments.append(current)
            current["items"].append(item)
            current["width"] += w
            dx += w
        return segments

    def _state_ops(self, st: _StyleRef, used=None) -> list[tuple]:
        m = st.member
        s = st.style()  # A1: effective (possibly size/color-overridden)
        ops: list[tuple] = []
        if st.fallback is not None:
            fb = self.fallbacks[st.fallback]
            fb.used = True  # marks THIS subset for registration (per face)
            if used is not None:
                used.add(st.fallback)  # T17: per-STREAM usage for the caller
            font = fb.name
        else:
            font = s["font_name"]
        if font:
            ops.append(("op", _instruction([Name(font), _f(s["size"])], "Tf"), None))
        ops.append(("op", _instruction([_f(s["h_scale"] * 100.0)], "Tz"), None))
        ops.append(("op", _instruction([_f(s["char_spacing"])], "Tc"), None))
        ops.append(("op", _instruction([_f(s["word_spacing"])], "Tw"), None))
        ops.append(("op", _instruction([int(s["render_mode"])], "Tr"), None))
        rise_ts = m.rise_user / m.d if m.d else 0.0
        ops.append(("op", _instruction([_f(rise_ts)], "Ts"), None))
        for ins in _color_sync(s["fill_color"], object(), stroke=False):
            ops.append(("op", ins, None))
        for ins in _color_sync(s["stroke_color"], object(), stroke=True):
            ops.append(("op", ins, None))
        return ops

    def _encode(self, seg: dict) -> tuple[list, float]:
        """Segment items → TJ elements (bytes | kern number) + the raw
        text-space advance (pre-h_scale) for state feeding."""
        st: _StyleRef = seg["style"]
        m = st.member
        s = st.style()  # A1: effective size/color
        items: list = []
        buf: list[str] = []
        raw = 0.0

        def flush() -> None:
            nonlocal raw
            if not buf:
                return
            # 9.B5 (review-caught HIGH): encode PER ENTRY, never a joined
            # buffer — cap.encode's greedy matcher on the join could form
            # a ligature ACROSS entry boundaries (two same-run singles
            # from adjacent spans), emitting the lig code where the width
            # math summed singles (repro'd: 4.2pt drift at 12pt). Each
            # styled entry already carries its identity: an atomic
            # sequence entry longest-matches to exactly its lig code; a
            # single entry to its single code. Per-entry encode makes
            # bytes and widths agree by construction for ANY caller-
            # supplied span shape.
            if st.fallback is not None:
                fb = self.fallbacks[st.fallback]
                encoded = b"".join(fb.encode(t) for t in buf)
            else:
                encoded = b"".join(m.cap.encode(t) for t in buf)
            items.append(encoded)
            buf.clear()

        # 9.B4b: kern numbers and the raw advance convert at the ADVANCE
        # axis's user scale — d for vertical (Tz never applies), h_scale×a
        # for horizontal (unchanged). The kern SIGN convention is the B4a
        # mirror (negative pushes the pen along the advance) either way.
        axis = m.d if m.vertical else s["h_scale"] * m.a
        # 9.K1b: a pair kern splits the buffer and emits its own TJ number,
        # exactly like the synthetic-gap kerns below. The sign convention is
        # this loop's existing one — `items.append(-kern_1000)` — so a
        # tightening (negative) kern becomes a POSITIVE TJ number, which moves
        # the next glyph left. Widths already carry the same kern via
        # _char_width_user, so what is measured is what is drawn.
        prev_enc = None
        for item in seg["items"]:
            if item[0] == "ch":
                ch_txt = item[1]
                if self.kerns is not None and prev_enc:
                    k = self.kerns.between(prev_enc, ch_txt[0] if ch_txt else "", st)
                    if k:
                        flush()
                        items.append(-k)
                buf.append(ch_txt)
                prev_enc = ch_txt[-1] if ch_txt else prev_enc
            else:
                prev_enc = None
                flush()
                gap_user = item[2]
                denom = axis * s["size"]
                kern_1000 = gap_user / denom * 1000.0 if denom else 0.0
                items.append(-kern_1000)
        flush()
        raw = seg["width"] / axis if axis else 0.0
        return items, raw


# ── the resync rewriter ───────────────────────────────────────────────────

_PAINT_OPS = frozenset(("f", "F", "f*", "B", "B*", "b", "b*", "S", "s", "sh"))
# Path OBJECTS begin with m or re; between path construction and the paint
# only path/clip operators are legal — so the pre-paint state resync must
# fire BEFORE construction starts, never between `re` and `f`
# (self-caught: the first injection landed inside the path object).
_PATH_START_OPS = frozenset(("m", "re"))
_LINE_OPS = frozenset(("Td", "TD", "T*", "Tm"))

# Operators that may be DROPPED while inside the member span (between the
# first and last member show): pure text-state, text-positioning, and
# color setters that existed to serve the removed members. Any LATER
# reader is preceded by a resync that re-derives them from the original
# machine, so dropping is exact — and without the drop, every multi-run
# paragraph edit leaked the span's interior operators into the output and
# REPEATED edits compounded without bound (review-measured: +17 ops per
# identical re-edit). Deliberately NOT droppable: q/Q (stack balance),
# BT/ET (structure), cm (the ctm-identity invariant between the two
# machines), Do and paint ops (real content — an icon or underline rule
# between runs must survive, resynced), gs (opaque state we don't model).
_DROPPABLE_IN_SPAN = frozenset(
    (
        "Tf", "Tz", "Tc", "Tw", "TL", "Tr", "Ts",
        "Td", "TD", "T*", "Tm",
        "g", "rg", "k", "cs", "sc", "scn",
        "G", "RG", "K", "CS", "SC", "SCN",
    )
)


def _mats_close(m1, m2) -> bool:
    return all(abs(a - b) <= 1e-6 for a, b in zip(m1, m2))


def _states_equal(orig: GraphicsTextState, emit: GraphicsTextState) -> bool:
    return (
        orig.font_name == emit.font_name
        and abs(orig.font_size - emit.font_size) <= 1e-9
        and abs(orig.h_scale - emit.h_scale) <= 1e-9
        and abs(orig.char_spacing - emit.char_spacing) <= 1e-9
        and abs(orig.word_spacing - emit.word_spacing) <= 1e-9
        and abs(orig.leading - emit.leading) <= 1e-9
        and orig.render_mode == emit.render_mode
        and abs(orig.rise - emit.rise) <= 1e-9
        and color_equal(orig.fill_color, emit.fill_color, stroke=False)
        and color_equal(orig.stroke_color, emit.stroke_color, stroke=True)
        and _mats_close(orig.tm, emit.tm)
        and _mats_close(orig.tlm, emit.tlm)
    )


def _state_sync_instructions(orig: GraphicsTextState, emit: GraphicsTextState) -> list:
    """Ops that bring `emit`'s text/color state to `orig`'s (position is
    injected separately — Tm is only legal inside BT). Only differing
    fields emit anything."""
    ops: list = []
    if (
        orig.font_name != emit.font_name or abs(orig.font_size - emit.font_size) > 1e-9
    ) and orig.font_name:
        ops.append(_instruction([Name(orig.font_name), _f(orig.font_size)], "Tf"))
    if abs(orig.h_scale - emit.h_scale) > 1e-9:
        ops.append(_instruction([_f(orig.h_scale * 100.0)], "Tz"))
    if abs(orig.char_spacing - emit.char_spacing) > 1e-9:
        ops.append(_instruction([_f(orig.char_spacing)], "Tc"))
    if abs(orig.word_spacing - emit.word_spacing) > 1e-9:
        ops.append(_instruction([_f(orig.word_spacing)], "Tw"))
    if abs(orig.leading - emit.leading) > 1e-9:
        ops.append(_instruction([_f(orig.leading)], "TL"))
    if orig.render_mode != emit.render_mode:
        ops.append(_instruction([int(orig.render_mode)], "Tr"))
    if abs(orig.rise - emit.rise) > 1e-9:
        ops.append(_instruction([_f(orig.rise)], "Ts"))
    ops.extend(_color_sync(orig.fill_color, emit.fill_color, stroke=False))
    ops.extend(_color_sync(orig.stroke_color, emit.stroke_color, stroke=True))
    return ops


def _member_ordinals_by_stream(detail: list[dict], member_set: set) -> dict:
    """{stream → set of member SHOW ordinals within that stream} — the
    rewriter's removal targets, one entry per involved stream (T17)."""
    per_stream_counts: dict[tuple, int] = defaultdict(int)
    out: dict[tuple, set] = defaultdict(set)
    for i, det in enumerate(detail):
        o = per_stream_counts[det["stream"]]
        per_stream_counts[det["stream"]] = o + 1
        if i in member_set:
            out[det["stream"]].add(o)
    return dict(out)


def _allocate_fallback_names(members: list, fallbacks: dict, counter, reserved: set) -> None:
    """9.A5b naming, hoisted out of the rewriter for T17: allocate each
    substitute subset's name ONCE, fresh against EVERY involved stream's
    fonts — one name serves all streams (a cross-stream edit registers the
    same font dict into each using stream's resources under it). For a
    single-stream edit the taken-set is exactly the shipped in-rewriter
    allocation's, so names and bytes are unchanged. 9.T26: an in-place
    entry IS the document's own font (font_dict None) — it keeps its name
    from construction and is never renamed."""
    if not any(fallbacks[k].font_dict is not None for k in fallbacks):
        return
    seen: set = set()
    for m in members:
        res = m.resources
        if res is None or id(res) in seen:
            continue
        seen.add(id(res))
        fonts_d = res.get("/Font")
        if fonts_d is not None:
            reserved |= {str(k) for k in fonts_d.keys()}
    for key in sorted(fallbacks, key=_face_sort_key):
        if fallbacks[key].font_dict is not None:
            fallbacks[key].name = _fresh_font_name(None, counter, reserved)


class _StreamTarget:
    """T17: one involved stream's share of a paragraph edit — its member
    show ordinals (within that stream), where its emission lands, the fonts
    to register into ITS resources, and the user-space extent it emitted
    (to expand a form copy's /BBox)."""

    __slots__ = (
        "member_ordinals",
        "first_ordinal",
        "last_ordinal",
        "pending_fonts",
        "emitted_bbox",
        "changed",
    )

    def __init__(self, member_ordinals: set):
        self.member_ordinals = set(member_ordinals)
        self.first_ordinal = min(member_ordinals)
        self.last_ordinal = max(member_ordinals)
        self.pending_fonts: list = []
        self.emitted_bbox = None
        self.changed = False


class _ParaEditState:
    def __init__(self, ordinals_by_stream: dict, emission, fallbacks):
        # T17: one target per involved stream (the single-stream edit is a
        # dict of one). Each target's portion of the emission lands at ITS
        # first member; member removal + resync run per stream.
        self.targets: dict[tuple, _StreamTarget] = {
            stream: _StreamTarget(ords) for stream, ords in ordinals_by_stream.items()
        }
        self.emission = emission
        # 9.A5b: {face key → _Fallback} (was the single `fallback`).
        self.fallbacks = fallbacks
        self.superseded_forms: set = set()

    @property
    def changed(self) -> bool:
        return all(t.changed for t in self.targets.values())


def _expand_form_bbox(copy, edit: "_ParaEditState", child: tuple, form_ctm) -> None:
    """T17: grow a form COPY's /BBox to cover everything emitted into it or
    into any target beneath it — /BBox clips at EVERY level of a Do chain,
    and reflowed text may extend past the original's crop. Rewritten only
    when it must strictly GROW: an unchanged box keeps the original object
    (byte-identity for edits that stay inside it)."""
    boxes = [
        t.emitted_bbox
        for s, t in edit.targets.items()
        if s[: len(child)] == child and t.emitted_bbox is not None
    ]
    if not boxes:
        return
    ub = (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )
    a, b, c, d, e, f = _invert(form_ctm)
    xs, ys = [], []
    for x, y in ((ub[0], ub[1]), (ub[0], ub[3]), (ub[2], ub[1]), (ub[2], ub[3])):
        xs.append(a * x + c * y + e)
        ys.append(b * x + d * y + f)
    try:
        old = [float(v) for v in copy["/BBox"]]
    except (TypeError, ValueError, KeyError):
        return
    x0, y0 = min(old[0], old[2]), min(old[1], old[3])
    x1, y1 = max(old[0], old[2]), max(old[1], old[3])
    nx0, ny0 = min(x0, min(xs)), min(y0, min(ys))
    nx1, ny1 = max(x1, max(xs)), max(y1, max(ys))
    if nx0 < x0 - 1e-6 or ny0 < y0 - 1e-6 or nx1 > x1 + 1e-6 or ny1 > y1 + 1e-6:
        copy["/BBox"] = pikepdf.Array([_f(nx0), _f(ny0), _f(nx1), _f(ny1)])


def _rewrite_paragraph_stream(
    pdf,
    instructions,
    resources,
    fallback_res,
    depth,
    edit: _ParaEditState,
    fonts,
    counter,
    reserved,
    path,
    base_ctm=IDENTITY,
    parent_state=None,
):
    """(kept, changed, new_forms). Non-involved streams pass through
    verbatim (descending ONLY along target paths — local form ordinals make
    that navigable); every TARGET stream gets member removal + its share of
    the emission + the dual-machine resync described in the module
    docstring. T17: `edit.targets` may name several streams (a cross-stream
    paragraph) — each receives its portion at its own first member, and a
    target stream can itself host a deeper target's Do."""
    tgt = edit.targets.get(path)
    in_target = tgt is not None
    orig = _child_state(base_ctm, parent_state)
    emit = _child_state(base_ctm, parent_state) if in_target else None
    kept: list = []
    changed = False
    new_forms: dict = {}
    show_ordinal = 0
    form_ordinal = 0
    diverged = False
    in_bt = False
    # Consecutive state/positioning setters directly BEFORE the first
    # member styled/positioned that member — buffered, and DISCARDED when
    # the member arrives (they'd be dead weight; without this, every
    # re-edit kept the prior emission's pre-show cluster and streams
    # compounded anyway — the between-members drop alone wasn't enough,
    # self-caught by the fixed-point test). Any other op flushes first,
    # so the buffer never spans structure.
    pending_setters: list = []

    def emit_feed(ins) -> None:
        emit.feed(str(ins.operator), list(ins.operands))

    def flush_setters() -> None:
        if not in_target:
            return
        for ins in pending_setters:
            kept.append(ins)
            emit_feed(ins)
        pending_setters.clear()

    def sync_state() -> None:
        for ins in _state_sync_instructions(orig, emit):
            kept.append(ins)
            emit_feed(ins)

    def sync_position_to(matrix) -> None:
        if in_bt and not (_mats_close(matrix, emit.tm) and _mats_close(matrix, emit.tlm)):
            ins = _instruction([_f(v) for v in matrix], "Tm")
            kept.append(ins)
            emit_feed(ins)

    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)

        if operator == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback_res)
            subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""
            if xobj is not None and subtype == "/Form" and depth < MAX_FORM_DEPTH:
                my_ordinal = form_ordinal
                form_ordinal += 1
                child = path + (my_ordinal,)
                # T17: descend when ANY target lies at or beneath this Do —
                # a target stream can itself host a deeper target.
                on_path = any(
                    len(t) >= len(child) and t[: len(child)] == child
                    for t in edit.targets
                )
                if on_path:
                    if in_target:
                        # The Do is a paint that inherits the whole text
                        # state — flush held setters and resync exactly as
                        # the kept-Do tail below does.
                        flush_setters()
                        if diverged:
                            sync_state()
                    form_res = xobj.get("/Resources")
                    read_res = form_res if form_res is not None else resources
                    form_matrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
                    form_ctm = mat_mult(form_matrix, orig.ctm)
                    inner_kept, inner_changed, inner_new_forms = _rewrite_paragraph_stream(
                        pdf,
                        pikepdf.parse_content_stream(xobj),
                        read_res,
                        resources,
                        depth + 1,
                        edit,
                        fonts,
                        counter,
                        reserved,
                        child,
                        base_ctm=form_ctm,
                        parent_state=orig,
                    )
                    if inner_changed:
                        changed = True
                        copy = pdf.make_stream(pikepdf.unparse_content_stream(inner_kept))
                        for key in xobj.keys():
                            if key in ("/Length", "/Filter", "/DecodeParms", "/Resources"):
                                continue
                            copy[key] = xobj[key]
                        copy_res = _copy_resources_for_write(pdf, read_res)
                        for nm, st in inner_new_forms.items():
                            copy_res["/XObject"][Name(nm)] = pdf.make_indirect(st)
                        child_tgt = edit.targets.get(child)
                        if child_tgt is not None and child_tgt.pending_fonts:
                            # /Font must be DEEP-copied into the copy
                            # first: _copy_resources_for_write shares
                            # non-XObject entries by reference (the 7.4
                            # lesson, test-caught live there).
                            src_fonts = copy_res.get("/Font")
                            fresh_fonts = Dictionary()
                            if src_fonts is not None:
                                for k in src_fonts.keys():
                                    fresh_fonts[k] = src_fonts[k]
                            copy_res["/Font"] = fresh_fonts
                            for fname, fdict in child_tgt.pending_fonts:
                                _register_font(pdf, copy_res, fname, fdict)
                        copy["/Resources"] = copy_res
                        _expand_form_bbox(copy, edit, child, form_ctm)
                        new_name = _fresh_name(resources, counter, reserved)
                        new_forms[new_name] = copy
                        kept.append(_instruction([Name(new_name)], "Do"))
                        if name:
                            edit.superseded_forms.add(name)
                        continue

        if not in_target:
            orig.feed(operator, operands)
            kept.append(instruction)
            continue

        # ── target stream ────────────────────────────────────────────────
        if operator == "BT":
            in_bt = True
        elif operator == "ET":
            in_bt = False

        if operator in SHOW_OPS:
            is_member = show_ordinal in tgt.member_ordinals
            if is_member and show_ordinal == tgt.first_ordinal:
                pending_setters.clear()  # they styled the removed member
            else:
                flush_setters()
            if operator in ("'", '"'):
                orig.next_line()
                if operator == '"' and len(operands) >= 2:
                    try:
                        orig.word_spacing = float(operands[0])
                        orig.char_spacing = float(operands[1])
                    except (TypeError, ValueError):
                        pass
            cap = fonts.capability(resources, fallback_res, orig.font_name)
            _text, raw = _run_metrics(operator, operands, cap, orig)
            # 9.B4a: a KEPT vertical run advances the parallel walks
            # downward — the model's tm must match reality or the next
            # injected absolute Tm would move a kept show. (9.B4b lifted
            # the B4a members-are-never-vertical boundary: the emission
            # feed below advances the emit machine on the PARAGRAPH's
            # axis, so its model matches the emitted shows too.)
            vert = bool(cap is not None and cap.vertical)
            if is_member:
                if show_ordinal == tgt.first_ordinal:
                    # T17: THIS stream's share of the emission, anchored at
                    # its own first member's ctm (fallback names were
                    # allocated ONCE by the caller — same names in every
                    # stream). `used_keys` collects the subsets this stream
                    # actually drew, for registration into ITS resources.
                    used_keys: set = set()
                    for kind, ins, raw_w in edit.emission.build(
                        orig.ctm, stream=path, used=used_keys
                    ):
                        kept.append(ins)
                        if kind == "show":
                            emit.advance_after_show(raw_w, edit.emission.vertical)
                        else:
                            emit_feed(ins)
                    for key in sorted(used_keys, key=_face_sort_key):
                        fb = edit.fallbacks[key]
                        # 9.T26: an in-place entry IS the document's own font
                        # (font_dict None) — it registers nothing.
                        if fb.font_dict is not None:
                            tgt.pending_fonts.append((fb.name, fb.font_dict))
                    tgt.emitted_bbox = edit.emission.last_build_bbox
                tgt.changed = True
                changed = True
                diverged = True
                orig.advance_after_show(raw, vert)
                show_ordinal += 1
                continue
            if diverged:
                sync_state()
                sync_position_to(orig.tm)
                if operator in ("'", '"'):
                    # Absolute conversion: next_line/Tw/Tc effects are
                    # already in orig (and synced); the show itself
                    # becomes a plain Tj at the injected position.
                    payload = operands[-1] if operands else pikepdf.String(b"")
                    kept.append(_instruction([payload], "Tj"))
                else:
                    kept.append(instruction)
                orig.advance_after_show(raw, vert)
                emit.advance_after_show(raw, vert)
                if _states_equal(orig, emit):
                    diverged = False
            else:
                kept.append(instruction)
                if operator in ("'", '"'):
                    emit.next_line()
                    if operator == '"' and len(operands) >= 2:
                        try:
                            emit.word_spacing = float(operands[0])
                            emit.char_spacing = float(operands[1])
                        except (TypeError, ValueError):
                            pass
                orig.advance_after_show(raw, vert)
                emit.advance_after_show(raw, vert)
            show_ordinal += 1
            continue

        if (
            diverged
            and show_ordinal <= tgt.last_ordinal
            and operator in _DROPPABLE_IN_SPAN
        ):
            # Inside the member span: this setter served a removed member.
            # Feed the original machine and drop it — any kept reader
            # ahead gets a resync (see _DROPPABLE_IN_SPAN's rationale).
            orig.feed(operator, operands)
            continue

        if not diverged and operator in _DROPPABLE_IN_SPAN:
            # Might be the first member's styling cluster — hold it; the
            # next non-setter (or a non-member show) flushes it verbatim.
            orig.feed(operator, operands)
            pending_setters.append(instruction)
            continue

        flush_setters()

        if diverged and operator in _LINE_OPS:
            # Absolute-ize: reproduce the ORIGINAL post-op line matrix.
            # (TD's leading side effect is a state field — the sync after
            # the feed covers it.)
            orig.feed(operator, operands)
            sync_state()
            sync_position_to(orig.tlm)
            if _states_equal(orig, emit):
                diverged = False
            continue

        if diverged and (operator in _PAINT_OPS or operator in _PATH_START_OPS or operator == "Do"):
            # Paints read color (and a form draw inherits the whole text
            # state) — and the sync must land BEFORE path construction.
            sync_state()

        orig.feed(operator, operands)
        if in_target:
            emit.feed(operator, operands)
        kept.append(instruction)
        if diverged and _states_equal(orig, emit):
            diverged = False
    # Trailing setters with no member after them are verbatim content.
    flush_setters()
    return kept, changed, new_forms


def _augment_cid_widths(font_dict, additions: dict[int, float]) -> None:
    """Append `/W` entries for the gids an in-place edit introduced — 9.T26.

    Only gids `/W` does not already cover (the caller filtered), each with
    its PROGRAM advance, so the viewer's advance, the layout's measurement
    and the re-listing's width model are the same number. Without this the
    new forms fell to `/DW` and the correcting TJ jumps read as word gaps."""
    try:
        descendant = font_dict["/DescendantFonts"][0]
    except Exception:
        return
    w = descendant.get("/W")
    items = list(w) if w is not None else []
    for gid in sorted(additions):
        items.append(gid)
        items.append(pikepdf.Array([additions[gid]]))
    descendant["/W"] = pikepdf.Array(items)


def _augment_tounicode(pdf, font_dict, additions: dict[int, str]) -> None:
    """Extend a font's /ToUnicode with the shaped glyphs an in-place edit
    drew — 9.T26.

    Additive ONLY: the prequalification and the build both refuse a glyph
    that would need a DIFFERENT spelling than the document already gives it
    (code == gid under Identity-H, so one glyph gets one entry — the T25
    collision, closed at the gate rather than papered over here). The whole
    map is re-emitted as bfchar entries, chunked at the CMap spec's 100 per
    block; semantically identical to whatever mix of bfchar/bfrange the
    producer wrote."""
    from engine.pdf_fonts import _parse_tounicode

    merged: dict[int, str] = {}
    tou = font_dict.get("/ToUnicode")
    if tou is not None:
        try:
            merged = dict(_parse_tounicode(tou.read_bytes()))
        except Exception:
            merged = {}
    for gid, spells in additions.items():
        merged.setdefault(gid, spells)
    entries = sorted(merged.items())
    nl = chr(10)
    blocks = []
    for i in range(0, len(entries), 100):
        chunk = entries[i : i + 100]
        lines = nl.join(
            f"<{code:04x}> <{text.encode('utf-16-be').hex()}>" for code, text in chunk
        )
        blocks.append(f"{len(chunk)} beginbfchar{nl}{lines}{nl}endbfchar")
    body = nl.join(
        [
            "/CIDInit /ProcSet findresource begin",
            "12 dict begin",
            "begincmap",
            "/CMapName /Adobe-Identity-UCS def",
            "/CMapType 2 def",
            "1 begincodespacerange",
            "<0000> <ffff>",
            "endcodespacerange",
            *blocks,
            "endcmap",
            "CMapName currentdict /CMap defineresource pop",
            "end",
            "end",
            "",
        ]
    )
    font_dict["/ToUnicode"] = pdf.make_stream(body.encode("ascii"))


class _PreparedStyle:
    """Everything the styled-chars pipeline resolves for an edit: the styled
    stream, the fallback subsets, and the whole-paragraph overrides. Built by
    `_prepare_styled` — ONE implementation shared by replace (which adds
    per-span styling, bidi machinery and the T26 in-place path) and merge
    (whole-paragraph restyle only, shipped substitution behaviour kept)."""

    __slots__ = (
        "styled", "fallbacks", "size_override", "has_span_size",
        "vertical_face", "inplace_face", "inplace_font_dict",
        "inplace_tounicode", "inplace_widths",
    )


def _prepare_styled(
    pdf,
    para: _Paragraph,
    resources,
    new_text: str,
    spans: list,
    *,
    convert: bool = False,
    font_path: str | None = None,
    size=None,
    color=None,
    family=None,
    bold=None,
    italic=None,
    features=None,
    alt_index: int = 0,
    span_styles: list | None = None,
    allow_inplace: bool = False,
    bidi_aware: bool = False,
    members_override: dict | None = None,
) -> _PreparedStyle:
    """The A1/A3/A5/9.K2/9.T26 styling pipeline, extracted verbatim from
    `replace_paragraph_text` for T18 so a merge can restyle through the
    SAME machinery instead of a drifting copy. `allow_inplace=False` and
    `bidi_aware=False` keep a caller byte-identical to the pre-extraction
    bare `_styled_chars` call when every restyle argument is None."""
    inplace_face = None
    inplace_font_dict = None
    inplace_tounicode: dict[int, str] = {}
    inplace_widths: dict[int, float] = {}
    # A1 overrides: a size in points (clamped to a sane editing range —
    # an unbounded value pushed most of the paragraph off the page on a
    # typo, review-caught), an [r,g,b] fill colour.
    size_override = None
    if size is not None:
        try:
            sv = float(size)
        except (TypeError, ValueError):
            sv = 0.0
        if sv > 0:
            size_override = max(1.0, min(_MAX_EDIT_SIZE, sv))
    color_override = None
    if color is not None:
        try:
            rgb = [max(0.0, min(1.0, float(c))) for c in color]
        except (TypeError, ValueError):
            rgb = []
        if len(rgb) == 3:
            color_override = (None, ("rg", tuple(rgb)))
    # A3a family swap: an explicit selector, so garbage REFUSES rather
    # than silently keeping the original (a swap that did nothing would
    # be a success that lied).
    family_override = None
    if family is not None:
        family_override = _validated_family(family)
    # A3b style axis: a PRESENT bold/italic is the substituted face's
    # absolute weight/slant; both None = no style substitution.
    style_override = None
    if bold is not None or italic is not None:
        style_override = (bool(bold), bool(italic))
    # 9.K2 whole-paragraph OpenType features (small caps / alternates).
    # `features` accepts the tokens "small_caps"/"smcp"/"c2sc"/"salt"; a
    # feature forces the Libertinus-Serif switch (Liberation has none) and
    # substitutes the whole paragraph. `((), 0)` when absent, so the
    # no-feature path is byte-identical.
    para_feats = _normalize_para_features(features)
    try:
        para_alt = int(alt_index or 0) if para_feats else 0
    except (TypeError, ValueError):
        para_alt = 0
    substituting = (
        family_override is not None or style_override is not None or bool(para_feats)
    )
    # 9.T4: a VERTICAL paragraph substitutes into a vertical-capable
    # face. This used to refuse outright ("vertical text cannot
    # substitute a horizontal face") because the bundled Liberation
    # faces are horizontal and nothing else was vendored — a true
    # statement that stopped being true when T5 bundled Noto Sans CJK
    # (which carries `vert`/`vrt2` and `vmtx`) and T3 brought the shaper
    # that can reach those features. Family serif/sans/mono has nothing
    # honest to resolve to for a column, so it is IGNORED here rather
    # than obeyed into a sideways result; the weight axis is real, and a
    # user who wants a different vertical face picks an installed one
    # (T6), which is checked for vertical machinery before it is used.
    vertical_face = None
    # `convert` counts as well as a style request. A column whose own
    # font cannot express a typed character needs the vertical face for
    # exactly the reason a restyle does, and without this it raised
    # "vertical text cannot be converted to the fallback font" — the
    # refusal T4 was supposed to have lifted. It survived because the
    # shipped pin for the escape hatch passes `bold=True`, which sets
    # `substituting` on its own and hid the plain-convert case.
    if (substituting or convert) and para.vertical:
        # `style_key` is imported again below, inside the fallback-build
        # block — naming it there makes it a FUNCTION-LOCAL, so this
        # earlier use must bring its own or it reads as unassigned.
        from engine.font_fallback import (
            face_shapes_vertically,
            resolve_vertical_font,
        )
        from engine.font_fallback import style_key as _style_key

        if not font_path:
            raise ValueError("fallback font path is required to restyle")
        if isinstance(family_override, str) and os.path.isabs(family_override):
            if not face_shapes_vertically(family_override, para.text):
                raise ValueError(
                    "that font has no vertical forms — pick one that does"
                )
            vertical_face = family_override
        else:
            vertical_face = resolve_vertical_font(
                str(font_path),
                para.text,
                style=_style_key(
                    bool(style_override[0]) if style_override else False,
                    bool(style_override[1]) if style_override else False,
                ),
            )

    # A5a/A5b/A5c per-span styling: fold the sparse span_styles ranges
    # into per-code-point lookups — `color_by_pos` (A5a colour),
    # `face_by_pos` (A5b face key), and `size_by_pos` (A5c size, points)
    # INDEPENDENTLY, so one entry may carry a colour, a face, a size, or
    # any combination, on unaligned ranges. Last-writer-wins on overlap.
    # All three stay None when unused → _styled_chars byte-identical.
    color_by_pos = None
    face_by_pos = None
    size_by_pos = None
    if span_styles:
        n_cp = len(str(new_text))
        for entry in span_styles:
            try:
                st = int(entry["start"])
                en = int(entry["end"])
            except (KeyError, TypeError, ValueError):
                raise ValueError("span style needs integer start/end") from None
            if not (0 <= st <= en <= n_cp):
                raise ValueError("span style range out of bounds")
            if st == en:
                continue  # empty range: harmless no-op
            has_face = any(
                f in entry for f in ("family", "bold", "italic", "small_caps", "alternates")
            )
            has_color = entry.get("color") is not None
            has_size = entry.get("size") is not None
            if not has_face and not has_color and not has_size:
                raise ValueError("span style must set a colour, a face, or a size")
            if has_color:
                try:
                    rgb = [max(0.0, min(1.0, float(c))) for c in entry.get("color")]
                except (TypeError, ValueError):
                    rgb = []
                if len(rgb) != 3:
                    raise ValueError("span style colour must be [r, g, b]")
                cs = (None, ("rg", tuple(rgb)))
                if color_by_pos is None:
                    color_by_pos = [None] * n_cp
                for k in range(st, en):
                    color_by_pos[k] = cs
            if has_face:
                # A5b face key (family_or_None, bold, italic): family in
                # the trio or absent (None = keep the member family);
                # bold/italic coerced bool (absent = False — the absolute
                # A3b weight/slant semantics, now per span).
                fam = entry.get("family")
                if fam is not None:
                    try:
                        fam = _validated_family(fam)
                    except ValueError as exc:
                        raise ValueError(f"span style {exc}") from None
                # 9.K2: a per-span OpenType feature request (small caps /
                # alternates) rides the SAME face key. small_caps expands
                # to smcp+c2sc; a feature forces a feature-bearing face
                # (Libertinus Serif) in the build below, because Liberation
                # has none. No feature => `((), 0)`, byte-identical to A5b.
                feats, alt = _span_features(entry)
                facekey = (fam, bool(entry.get("bold")), bool(entry.get("italic")), feats, alt)
                if face_by_pos is None:
                    face_by_pos = [None] * n_cp
                for k in range(st, en):
                    face_by_pos[k] = facekey
            if has_size:
                # A5c per-span size (points): coerce + clamp to the A1
                # range [1.0, _MAX_EDIT_SIZE] (a fat-fingered 5000 lands
                # at the viewer max, never off-page); a non-number refuses
                # named, mirroring the colour shape check.
                try:
                    sv = float(entry.get("size"))
                except (TypeError, ValueError):
                    raise ValueError("span style size must be a number") from None
                sv = max(1.0, min(_MAX_EDIT_SIZE, sv))
                if size_by_pos is None:
                    size_by_pos = [None] * n_cp
                for k in range(st, en):
                    size_by_pos[k] = sv

    # A3a/A3b whole-paragraph substitution → ONE face key covering every
    # char (family_override may be None = keep the member family). None
    # when not substituting. Per-span faces (face_by_pos) override it per
    # position; the single-key case stays byte-identical to shipped A3.
    whole_para_face = None
    if substituting:
        wb = style_override[0] if style_override is not None else False
        wi = style_override[1] if style_override is not None else False
        whole_para_face = (family_override, wb, wi, para_feats, para_alt)

    members_by_index = (
        members_override
        if members_override is not None
        else {m.index: m for m in para.members}
    )
    # 9.A5b (round-33 HIGH): each member's OWN classified family, so a
    # per-span face with no explicit family lands on that member's family
    # (a bolded mono word in a serif paragraph → mono-bold). Only needed
    # when per-span faces are present; the font is looked up in the
    # member's own stream resources (form-scoped when nested), page
    # resources as fallback.
    member_family = None
    if face_by_pos is not None:
        from engine.font_fallback import classify_font_family
        from engine.text_runs import _lookup_font

        member_family = {}
        for m in para.members:
            fd = _lookup_font(m.style["font_name"], m.resources or resources, resources)
            member_family[m.index] = classify_font_family(fd) if fd is not None else "sans"
    # 9.T3: a paragraph that reorders may carry a cursively joining
    # script, which has to be SHAPED into a face that still knows how.
    # The per-member weight/slant comes along so a bold Arabic run lands
    # on the bold face rather than flattening.
    rtl_style = None
    if bidi_aware and para.bidi and not para.vertical:
        from engine.font_fallback import classify_font_style
        from engine.text_runs import _lookup_font

        rtl_style = {}
        for m in para.members:
            fd = _lookup_font(m.style["font_name"], m.resources or resources, resources)
            try:
                rtl_style[m.index] = classify_font_style(fd) if fd is not None else (False, False)
            except Exception:
                rtl_style[m.index] = (False, False)

    # 9.T26: qualify the document's OWN font for in-place shaping, so an
    # RTL edit keeps the document's typeface instead of substituting the
    # bundled face. Every condition below is a correctness gate, not a
    # preference:
    #   - no substitution/feature request and no per-span face — asking
    #     for bold IS asking to leave the document font;
    #   - ONE font across the members — a per-member split would seam a
    #     word at a member boundary;
    #   - the PDF-side shape (Identity-H + Identity CIDToGIDMap: a glyph
    #     id IS the code) and the program-side one (cmap + GSUB still
    #     present) both hold — `in_place_face` checks them;
    #   - every joining word of the NEW text shapes without `.notdef`
    #     (a subset keeps only the glyphs it drew, and a form the new
    #     text needs may be gone);
    #   - no glyph SPELLING collision: code == gid here, so one glyph
    #     gets exactly one ToUnicode entry — a shaped cluster that wants
    #     gid G to spell Y when the document already has it spelling X
    #     cannot be expressed, and the T25 fatha-as-sukun lesson says
    #     never to try. Any failed condition falls back to the bundled
    #     face, which is the shipped, correct behaviour.
    if (
        allow_inplace
        and rtl_style is not None
        and not substituting
        and font_path
        and len({m.style["font_name"] for m in para.members}) == 1
    ):
        from engine import shaping as _shaping
        from engine.text_runs import _lookup_font as _lf

        first_m = min(para.members, key=lambda m: m.index)
        fd0 = _lf(first_m.style["font_name"], first_m.resources or resources, resources)
        candidate = _shaping.in_place_face(fd0) if fd0 is not None else None
        if candidate is not None:
            cap0 = first_m.cap
            ok = True
            additions: dict[int, str] = {}
            try:
                from fontTools.ttLib import TTFont as _TT

                _tt = _TT(candidate, fontNumber=0, lazy=True)
                try:
                    gid_of0 = {n: i for i, n in enumerate(_tt.getGlyphOrder())}
                finally:
                    _tt.close()
                for token in str(new_text).split():
                    if not _shaping.requires_shaping(token):
                        continue
                    run0 = _shaping.shape(candidate, token, rtl=True)
                    for name, spells in run0.clusters:
                        gid = gid_of0[name]
                        existing = cap0._code2uni.get(gid)
                        if existing is None:
                            additions[gid] = spells
                        elif spells and existing != spells:
                            ok = False
                            break
                    if not ok:
                        break
            except Exception:
                ok = False
            if ok:
                inplace_face = candidate
                inplace_font_dict = fd0
                inplace_tounicode = additions
            else:
                try:
                    os.unlink(candidate)
                except OSError:
                    pass
    styled, fb_by_face = _styled_chars(
        str(new_text), list(spans), members_by_index, bool(convert),
        size_override=size_override, color_override=color_override,
        whole_para_face=whole_para_face, color_by_pos=color_by_pos,
        face_by_pos=face_by_pos, size_by_pos=size_by_pos,
        member_family=member_family, rtl_style=rtl_style,
        vertical_ok=vertical_face is not None,
        inplace_ok=inplace_face is not None,
    )
    # 9.A5b: build ONE _Fallback per face key, sorted-face order so the
    # subset names + embedded bytes are deterministic. The whole-para A3
    # path yields exactly one key here → one subset → byte-identical to
    # the shipped single-_Fallback output.
    fallbacks: dict[tuple, _Fallback] = {}
    if fb_by_face:
        from engine.font_fallback import (
            build_fallback_font,
            resolve_fallback_font,
            style_key,
            synthetic_family_font,
        )
        from engine.text_runs import _lookup_font

        if not font_path:
            raise ValueError("fallback font path is required to convert")
        # family=None keys resolve their face from the FIRST member's own
        # font (form-scoped when nested — a form's `F1` can differ from
        # the page's, review-caught): this is the B1 dominant face and
        # reproduces the shipped whole-para style-only / convert resolve
        # exactly. family=serif|sans|mono keys bypass classification via
        # a synthetic /Flags dict (the A2 trick).
        first = min(para.members, key=lambda m: m.index)
        for key in sorted(fb_by_face, key=_face_sort_key):
            fam, kbold, kitalic, kfeats, kalt = key
            chars = "".join(sorted(fb_by_face[key]))
            if vertical_face is not None:
                # 9.T4: ONE vertical face serves the whole paragraph —
                # the weight was resolved with it, and a column cannot
                # mix writing modes anyway (the writing mode rides in
                # lkey, so a mixed-mode paragraph never groups).
                from engine.font_fallback import build_vertical_font

                font_dict, encode, width_1000 = build_vertical_font(
                    pdf, vertical_face, chars
                )
                fallbacks[key] = _Fallback(
                    None, font_dict, encode, width_1000, vertical_face
                )
                continue
            if fam == INPLACE_FAMILY:
                # 9.T26: shape with the DOCUMENT'S OWN program and emit
                # its own glyph ids — Identity-H makes a gid the two-byte
                # code, so nothing new embeds, no name allocates, and the
                # Tf the emission writes is the font the paragraph
                # already uses.
                #
                # Widths: /W is what the VIEWER advances by, so a gid /W
                # already covers keeps that number. A gid the edit
                # INTRODUCES (a joining form the subset never drew) is
                # absent from /W and would fall to DW — and papering over
                # that with TJ corrections put a forward jump between two
                # real glyphs, which the word-gap heuristic then read as
                # a SPACE INSIDE THE WORD (probe-caught: `ونص` came back
                # `ون ص`). So the new gids take their PROGRAM advance
                # here, and `/W` itself is AUGMENTED with the same
                # numbers after the edit — measured, drawn, and re-read
                # all become the one number.
                from fontTools.ttLib import TTFont as _TT

                styled, shaped_runs = _shape_styled_runs(styled, key, inplace_face)
                _tt = _TT(inplace_face, fontNumber=0, lazy=True)
                try:
                    _order = _tt.getGlyphOrder()
                    _gid_of = {n: i for i, n in enumerate(_order)}
                    _hmtx = _tt["hmtx"]
                    _upem = _tt["head"].unitsPerEm or 1000
                    _prog_adv = {
                        _gid_of[n]: round(_hmtx[n][0] * 1000.0 / _upem, 2)
                        for run2 in shaped_runs
                        for n in run2.glyph_names
                    }
                finally:
                    _tt.close()
                _cap = min(para.members, key=lambda m: m.index).cap
                for _g, _adv in _prog_adv.items():
                    if _g not in _cap._widths:
                        inplace_widths[_g] = _adv

                def _ip_encode(text, _c=_cap):
                    return _c.encode(text)

                def _ip_width(text, _c=_cap):
                    return _c.text_width(text)

                def _ip_genc(name, spells, _g=_gid_of):
                    return _g[name].to_bytes(2, "big")

                def _ip_gwidth(name, spells, _g=_gid_of, _c=_cap, _w=dict(inplace_widths)):
                    gid = _g[name]
                    if gid in _w:
                        return _w[gid]
                    return _c.decoded_width(gid.to_bytes(2, "big"))

                # The ToUnicode additions the augmentation writes, taken
                # from the ACTUAL emitted runs (word fragments can pick
                # forms the prequalification's whole-word pass did not).
                inplace_tounicode = {}
                for run2 in shaped_runs:
                    for name, spells in run2.clusters:
                        gid = _gid_of[name]
                        existing = _cap._code2uni.get(gid)
                        if existing is None:
                            inplace_tounicode[gid] = spells
                        elif spells and existing != spells:
                            # The T25 lesson, held as a refusal: one code
                            # cannot spell two things, and here code==gid.
                            raise ValueError(
                                "this edit cannot keep the document font — "
                                "retry, or restyle to another face"
                            )
                fallbacks[key] = _Fallback(
                    min(para.members, key=lambda m: m.index).style["font_name"],
                    None, _ip_encode, _ip_width, inplace_face,
                    glyph_encode=_ip_genc, glyph_width=_ip_gwidth,
                )
                continue
            if fam == RTL_FAMILY:
                # 9.T3: resolve the bundled RTL face, SHAPE every word
                # that routed here against it, then embed a subset that
                # carries the resulting glyphs. The order is forced: the
                # subset has to contain the shaper's output, and the
                # shaper needs the face.
                from engine.font_fallback import build_shaped_font, resolve_rtl_font

                face = resolve_rtl_font(
                    str(font_path), chars, style=style_key(kbold, kitalic)
                )
                styled, shaped_runs = _shape_styled_runs(styled, key, face)
                fdict, fenc, fwidth, genc, gwidth = build_shaped_font(
                    pdf, face, chars, shaped_runs
                )
                fallbacks[key] = _Fallback(
                    None, fdict, fenc, fwidth, face,
                    glyph_encode=genc, glyph_width=gwidth,
                )
                continue
            if kfeats:
                # 9.K2: apply the OpenType feature. IN PLACE using the
                # OWNING member's font when it carries the feature AND the
                # substituted glyphs; otherwise the explicit switch to
                # bundled Libertinus Serif (Liberation has no features).
                # ToUnicode keeps the plain letters (searchable) either way.
                # The in-place source member (round-42 CRITICAL fix): a
                # per-span key baked its own member index into `fam`; a
                # whole-paragraph key (None) resolves from the dominant
                # `first`; an explicit family + feature (str) can only get
                # features from Libertinus, so it never applies in place.
                if isinstance(fam, int):
                    src_member = members_by_index.get(fam)
                elif fam is None:
                    src_member = first
                else:
                    src_member = None
                face, glyph_for, tmp = _feature_source(
                    font_path, src_member, resources, chars, kfeats, kalt,
                    style_key(kbold, kitalic),
                )
                feat_kern = None
                try:
                    font_dict, encode, width_1000 = build_fallback_font(
                        pdf, face, chars, glyph_for=glyph_for
                    )
                    # Capture the IN-PLACE face's kerning while its temp
                    # program still exists — the emission pass reads it
                    # later (by which point `tmp` is unlinked), so reading
                    # the path then would silently un-kern the run (K1b).
                    if tmp:
                        from engine.font_kerning import kern_pairs as _kp

                        feat_kern = _kp(str(face))
                finally:
                    if tmp:
                        try:
                            os.unlink(tmp)
                        except OSError:
                            pass
                fallbacks[key] = _Fallback(
                    None, font_dict, encode, width_1000, face, kern_pairs=feat_kern
                )
                continue
            if isinstance(fam, str) and os.path.isabs(fam):
                # 9.T6: an INSTALLED font, chosen by the user. It bypasses
                # the family ladder entirely — the ladder exists to pick a
                # bundled stand-in, and there is nothing to stand in for
                # when the face itself was named. Coverage still decides
                # the outcome: `build_fallback_font` refuses by character
                # if the chosen face cannot express the text.
                from engine.system_fonts import resolve_face

                face = resolve_face(fam)
                styled, fallbacks[key] = _embed_shaping_aware(
                    pdf, face, chars, styled, key
                )
                continue
            if fam is not None:
                original = synthetic_family_font(fam)
            else:
                original = _lookup_font(
                    first.style["font_name"], first.resources or resources, resources
                )
            face = resolve_fallback_font(
                str(font_path), original, style=style_key(kbold, kitalic), text=chars
            )
            styled, fallbacks[key] = _embed_shaping_aware(
                pdf, face, chars, styled, key
            )

    out = _PreparedStyle()
    out.styled = styled
    out.fallbacks = fallbacks
    out.size_override = size_override
    out.has_span_size = size_by_pos is not None
    out.vertical_face = vertical_face
    out.inplace_face = inplace_face
    out.inplace_font_dict = inplace_font_dict
    out.inplace_tounicode = inplace_tounicode
    out.inplace_widths = inplace_widths
    return out


def replace_paragraph_text(
    file: str,
    output: str,
    page: int,
    paragraph_index: int,
    new_text: str,
    spans: list,
    expected_runs: list,
    expected_text: str,
    convert: bool = False,
    font_path: str | None = None,
    size: float | None = None,
    color: list | None = None,
    family: str | None = None,
    bold: bool | None = None,
    italic: bool | None = None,
    split_at: int | None = None,
    split_gap: float | None = None,
    box_width: float | None = None,
    box_left: float | None = None,
    span_styles: list | None = None,
    features: list | None = None,
    alt_index: int = 0,
) -> dict:
    """Replace a paragraph's text and re-lay-out inside its box (7.5).

    `spans` is the renderer-computed style mapping (char range → member
    run); `expected_runs`/`expected_text` are the fingerprint — grouping
    is a heuristic, so the apply re-derives it and REFUSES on mismatch
    rather than ever silently retargeting. `convert=True` renders
    characters the mapped font cannot express in the bundled fallback
    font (`font_path`), the 7.4 machinery shared at span granularity.

    A1 restyle: `size` (points) applies a uniform new font size to the
    whole paragraph (scaling leading + rewrapping); `color` is an
    [r, g, b] triple (0-1) applied as a uniform fill colour. Either None
    keeps the paragraph's own.

    A3a/A3b restyle: `family` ("serif" | "sans" | "mono") and/or
    `bold`/`italic` (absolute booleans — a present value states the
    substituted face's weight/slant outright) substitute the WHOLE
    paragraph into the matching bundled Liberation face — every
    character re-embeds via the fallback machinery (`font_path`
    required), an honest substitution of the original foundry font.
    Family defaults to the first member's own classification (B1) when
    only a style is given, so bold-only on a serif paragraph lands
    LiberationSerif-Bold. Characters the Liberation face lacks refuse
    with a stated reason. All three None keeps the paragraph's own
    fonts (the shipped 7.5/A1 path, byte-identical).

    A4 split: `split_at` (a code-point offset strictly inside
    `new_text`) lays the text out as TWO blocks, the second starting
    2×leading below the first — a gap the re-listing grouping can never
    join across, so the result lists as two paragraphs. None = the
    shipped single-block layout (byte-identical).

    T18 split gap: `split_gap` (leading multiples, [1.3, 10]) scales the
    gap between the two blocks; the 2×eff relist floor never shrinks, so
    every allowed factor still lists as two paragraphs. Requires
    `split_at`; None = the shipped 2.0.

    T18 resize: `box_width` (points, paragraph space) rewraps the
    paragraph to an explicit measure — first-line indent preserved,
    center/right/justify positioned against the new edges, and a width no
    word can wrap into REFUSES rather than overflowing the box the user
    drew. `box_left` (requires `box_width`) additionally moves the left
    edge — the renderer sends it when the LEFT handle dragged. Both None
    = the shipped derived measures, byte-identical.

    A5a/A5b/A5c per-span styling: `span_styles` is None or a list of
    `{start, end, color?: [r, g, b], family?, bold?, italic?, size?}` over
    CODE-POINT ranges of `new_text` (distinct from the style-SOURCE
    `spans`; sparse; need not align to span boundaries; overlaps fold
    last-wins). A `color` recolours its range, overriding the A1
    whole-paragraph `color` (A5a, metric-neutral). A `family`/`bold`/
    `italic` SUBSTITUTES its range into the matching bundled Liberation
    face (A5b) — one embedded subset per distinct requested face, family
    absent = keep the char's member family, the same honest substitution
    A3 does whole-paragraph. A `size` (points, clamped [1, 1638]) resizes
    just its range, overriding the A1 whole-paragraph `size` (A5c) — the
    range's Tf grows/shrinks, its width and wrap follow, and the LINE it
    lands on gets tallest-glyph leading while other lines keep theirs. The
    colour, face, and size axes fold INDEPENDENTLY (a range can be red AND
    bold AND bigger, on unaligned ranges). Per-span faces inherit A3's
    refusals (a char the Liberation face lacks is named); vertical
    paragraphs refuse substitution (B4b). None throughout = byte-identical
    shipped.

    9.B4b: vertical paragraphs reflow through the same pipeline in
    transposed space (columns fill top-down at the measured pitch, growth
    adds columns leftward; size scales the pitch, split gaps transpose).
    Family/bold/italic substitution and per-char convert refuse — the
    fallback faces are horizontal (v1 boundary)."""
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    # 9.T26: initialized BEFORE any refusal can raise — the finally block
    # reads these, and a validation error firing earlier would otherwise
    # turn into an UnboundLocalError that buries the real message.
    inplace_face = None
    inplace_font_dict = None
    inplace_tounicode: dict[int, str] = {}
    inplace_widths: dict[int, float] = {}
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        fonts = _FontCache()
        runs: list[dict] = []
        detail: list[dict] = []
        _walk_runs(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            IDENTITY,
            0,
            None,
            runs,
            False,
            fonts,
            detail=detail,
        )
        paragraphs = _group(runs, detail)
        if not (0 <= int(paragraph_index) < len(paragraphs)):
            raise ValueError(
                f"paragraph index {paragraph_index} is out of range (page has {len(paragraphs)})"
            )
        para = paragraphs[int(paragraph_index)]
        if not para.editable:
            raise ValueError(para.reason or "this paragraph is not editable")
        if [int(r) for r in expected_runs] != para.run_indexes or str(expected_text) != para.text:
            raise ValueError("the page's text changed underneath this edit — reopen the editor")

        # A4 split: an explicit selector — a caret offset outside the open
        # interval refuses (a "split" that splits nothing would be a
        # success that lied). Code points: Python strings index them
        # natively; the renderer converts from UTF-16 before sending.
        split_point = None
        if split_at is not None:
            try:
                sp = int(split_at)
            except (TypeError, ValueError):
                raise ValueError("split position must be a number") from None
            if not (0 < sp < len(str(new_text))):
                raise ValueError("split position must be inside the text")
            split_point = sp
        # T18: the split gap in LEADING multiples. Bounded — below ~1.3 the
        # grouping's ±25% drift window can re-join the halves (garbled
        # output), above 10 the second block walks off the page for no
        # articulable reason.
        gap_value = None
        if split_gap is not None:
            try:
                gv = float(split_gap)
            except (TypeError, ValueError):
                raise ValueError("split gap must be a number") from None
            if split_point is None:
                raise ValueError("split gap requires a split position")
            if not (1.3 <= gv <= 10.0):
                raise ValueError("split gap must be between 1.3 and 10 line heights")
            gap_value = gv
        # T18 resize: an explicit positive width; the emission refuses a
        # width no word-wrap can honour.
        width_value = None
        left_value = None
        if box_width is not None:
            try:
                wv = float(box_width)
            except (TypeError, ValueError):
                raise ValueError("box width must be a number") from None
            if not (wv > 0 and math.isfinite(wv)):
                raise ValueError("box width must be a positive number")
            width_value = wv
            if box_left is not None:
                try:
                    left_value = float(box_left)
                except (TypeError, ValueError):
                    raise ValueError("box left must be a number") from None
                if not math.isfinite(left_value):
                    raise ValueError("box left must be a finite number")
        elif box_left is not None:
            raise ValueError("box left requires a box width")

        # T18: the styling pipeline lives in _prepare_styled now — replace
        # passes everything through (per-span styling, bidi machinery, the
        # T26 in-place path included).
        prep = _prepare_styled(
            pdf, para, resources, str(new_text), list(spans),
            convert=bool(convert), font_path=font_path,
            size=size, color=color, family=family, bold=bold, italic=italic,
            features=features, alt_index=alt_index, span_styles=span_styles,
            allow_inplace=True, bidi_aware=True,
        )
        styled = prep.styled
        fallbacks = prep.fallbacks
        size_override = prep.size_override
        inplace_face = prep.inplace_face
        inplace_font_dict = prep.inplace_font_dict
        inplace_tounicode = prep.inplace_tounicode
        inplace_widths = prep.inplace_widths

        member_set = set(para.run_indexes)
        ords_by_stream = _member_ordinals_by_stream(detail, member_set)
        try:
            box = [float(v) for v in p.mediabox]
            if para.vertical:
                # 9.B4b: the emission lays out in TRANSPOSED space, where
                # the page's x′-extent is T of its y-extent (x′ = −y) —
                # the single-column margin rule then mirrors the top inset
                # to the bottom, exactly as the horizontal rule mirrors
                # left to right.
                page_x0, page_x1 = -max(box[1], box[3]), -min(box[1], box[3])
            else:
                page_x0, page_x1 = min(box[0], box[2]), max(box[0], box[2])
        except (TypeError, ValueError):
            page_x0, page_x1 = (-792.0, 0.0) if para.vertical else (0.0, 612.0)
        counter = [0]
        reserved: set = set()
        _allocate_fallback_names(para.members, fallbacks, counter, reserved)
        edit = _ParaEditState(
            ords_by_stream,
            _Emission(
                para, styled, fallbacks, page_x0, page_x1,
                size_override=size_override, split_at=split_point,
                split_gap=gap_value, box_width=width_value, box_left=left_value,
                has_span_size=prep.has_span_size,
                # 9.K1b: kern from whatever face each slice renders in — the
                # bundled subset when substituted, the document's own font
                # (embedded program, else its metric twin) otherwise.
                kerns=_KernSource(resources, font_path, fallbacks),
                # 9.T3: only a paragraph the listing actually normalized
                # reorders on the way out — the two halves are the same
                # decision, taken once.
                base_level=para.base_level if para.bidi else None,
            ),
            fallbacks,
        )
        kept, changed, new_forms = _rewrite_paragraph_stream(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            None,
            0,
            edit,
            fonts,
            counter,
            reserved,
            (),
        )
        if not (changed and edit.changed):
            raise ValueError("edit did not apply (paragraph not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, edit.superseded_forms)
        page_tgt = edit.targets.get(())
        if page_tgt is not None:
            for fname, fdict in page_tgt.pending_fonts:
                _register_font(pdf, resources, fname, fdict)
        if inplace_font_dict is not None and inplace_tounicode:
            _augment_tounicode(pdf, inplace_font_dict, inplace_tounicode)
        if inplace_font_dict is not None and inplace_widths:
            _augment_cid_widths(inplace_font_dict, inplace_widths)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(paragraph_index)}
    finally:
        if inplace_face is not None:
            try:
                os.unlink(inplace_face)
            except OSError:
                pass
        try:
            pdf.close()
        except Exception:
            pass


def merge_paragraph_with_previous(
    file: str,
    output: str,
    page: int,
    paragraph_index: int,
    expected_prev_runs: list,
    expected_prev_text: str,
    expected_runs: list,
    expected_text: str,
    # 9.K1b: the bundled-fonts dir, so a merge kerns the same way an edit
    # does. Without it a non-embedded standard-14 font would kern on edit
    # (via its metric twin) but not on merge — "some documents, not others".
    font_path: str | None = None,
    # T18: merge DIRECTION — with_next merges the NEXT paragraph into the
    # selected one (the selected box anchors, exactly as the previous box
    # anchors the shipped direction). expected_prev_* always fingerprints
    # the ANCHOR paragraph, expected_* the one merging into it.
    with_next: bool = False,
    # T18: the selected paragraph's EDITED text (+ the renderer's span map
    # for it) — an edited editor no longer refuses the merge; the page
    # fingerprints still prove the on-disk state.
    selected_text_override: str | None = None,
    selected_spans_override: list | None = None,
    # T18: whole-paragraph restyle riding the merge — the same A1/A3
    # semantics replace has, through the same pipeline (_prepare_styled).
    size=None,
    color=None,
    family=None,
    bold=None,
    italic=None,
) -> dict:
    """Merge a paragraph into the one above it in the listing (A4): the
    joined text (space-joined; no space across a CJK-CJK boundary — the
    line-join rule) re-lays-out in the PREVIOUS paragraph's box, both
    originals' show ops removed — one op, one undo step. Fingerprints for
    BOTH paragraphs refuse a stale view; different content streams refuse
    (a cross-column merge is nonsense); unencodable characters refuse
    named (a decoded char without a single-char reverse — the B5
    boundary — cannot re-emit). Cross-writing-mode merges refuse via the
    existing lkey guard — the mode rides in lkey (9.B4b)."""
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        fonts = _FontCache()
        runs: list[dict] = []
        detail: list[dict] = []
        _walk_runs(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            IDENTITY,
            0,
            None,
            runs,
            False,
            fonts,
            detail=detail,
        )
        paragraphs = _group(runs, detail)
        idx = int(paragraph_index)
        if with_next:
            if not (0 <= idx < len(paragraphs) - 1):
                raise ValueError("no next paragraph to merge with")
            prev, cur = paragraphs[idx], paragraphs[idx + 1]
        else:
            if not (1 <= idx < len(paragraphs)):
                raise ValueError("no previous paragraph to merge with")
            prev, cur = paragraphs[idx - 1], paragraphs[idx]
        for para_, label in ((prev, "previous"), (cur, "selected")):
            if not para_.editable:
                raise ValueError(para_.reason or f"the {label} paragraph is not editable")
        # T17 kept this refusal DELIBERATELY (now over stream SETS): the
        # multi-target rewrite could express a cross-stream merge, but the
        # merged single-line case lands both fragments on ONE baseline in
        # different streams — which can never relist as one paragraph
        # (lines never mix streams), so the "merge" would succeed and lie.
        # Two cross-stream paragraphs sharing the same stream set merge
        # fine — their fragments stack, they don't share a band.
        if prev.streams != cur.streams:
            raise ValueError("the paragraphs are in different content streams and cannot merge")
        if prev.lkey != cur.lkey:
            # Different linear parts (CTM scale) — the emission would lay
            # cur's text out at PREV's scale, silently resizing it
            # (review-caught, repro'd: 2×-scaled text shrank to 1× with a
            # success result). The same signal that kept these runs in
            # separate paragraphs at grouping time refuses the merge.
            raise ValueError("the paragraphs have different formatting and cannot merge")
        if [int(r) for r in expected_prev_runs] != prev.run_indexes or str(expected_prev_text) != prev.text:
            raise ValueError("the page's text changed underneath this edit — reopen the editor")
        if [int(r) for r in expected_runs] != cur.run_indexes or str(expected_text) != cur.text:
            raise ValueError("the page's text changed underneath this edit — reopen the editor")

        # T18: an edited editor rides its text into the merge as the
        # SELECTED side (cur for the shipped previous-merge, prev/anchor
        # for with_next), with the renderer's span map for that text. The
        # fingerprints above already proved the PAGE state.
        prev_text, cur_text = prev.text, cur.text
        prev_spans_src, cur_spans_src = prev.spans, cur.spans
        if selected_text_override is not None:
            ov_text = str(selected_text_override)
            if not ov_text.strip():
                raise ValueError(
                    "the edited text is empty — delete the paragraph instead of merging"
                )
            if not selected_spans_override:
                raise ValueError("edited text needs its span map")
            if with_next:
                prev_text, prev_spans_src = ov_text, selected_spans_override
            else:
                cur_text, cur_spans_src = ov_text, selected_spans_override

        joiner = "" if (prev_text and cur_text and _cjk(prev_text[-1]) and _cjk(cur_text[0])) else " "
        new_text = prev_text + joiner + cur_text
        # Spans stay contiguous: the joiner rides the PREVIOUS paragraph's
        # last span (the line-join rule); cur's spans shift up.
        shift = len(prev_text) + len(joiner)
        spans = [dict(s) for s in prev_spans_src]
        if joiner and spans:
            spans[-1]["end"] += len(joiner)
        spans += [
            {"start": s["start"] + shift, "end": s["end"] + shift, "run": s["run"]}
            for s in cur_spans_src
        ]

        # T18 restyle-on-merge refusal: a face substitution on right-to-left
        # text cannot ride a merge — this emission has no shaping pass, so a
        # substituted joining script would come out in unshaped forms.
        # Restyling the merged paragraph afterwards goes through replace,
        # which has the full machinery.
        if (family is not None or bold is not None or italic is not None) and (
            prev.bidi or cur.bidi
        ):
            raise ValueError(
                "restyle the merged paragraph after merging — a face change "
                "cannot ride a merge of right-to-left text"
            )
        members_by_index = {m.index: m for m in prev.members}
        members_by_index.update({m.index: m for m in cur.members})
        # T18: the same styling pipeline replace uses. With every restyle
        # argument None this is byte-identical to the old bare
        # `_styled_chars(new_text, spans, members_by_index, False)` call
        # (allow_inplace/bidi_aware off = the shipped merge behaviour).
        prep = _prepare_styled(
            pdf, prev, resources, new_text, spans,
            convert=False, font_path=font_path,
            size=size, color=color, family=family, bold=bold, italic=italic,
            allow_inplace=False, bidi_aware=False,
            members_override=members_by_index,
        )
        styled = prep.styled

        member_set = set(prev.run_indexes) | set(cur.run_indexes)
        ords_by_stream = _member_ordinals_by_stream(detail, member_set)
        try:
            box = [float(v) for v in p.mediabox]
            if prev.vertical:
                # 9.B4b: transposed page bounds for a vertical emission
                # (x′ = −y) — see replace_paragraph_text.
                page_x0, page_x1 = -max(box[1], box[3]), -min(box[1], box[3])
            else:
                page_x0, page_x1 = min(box[0], box[2]), max(box[0], box[2])
        except (TypeError, ValueError):
            page_x0, page_x1 = (-792.0, 0.0) if prev.vertical else (0.0, 612.0)
        counter = [0]
        reserved: set = set()
        _allocate_fallback_names(
            list(prev.members) + list(cur.members), prep.fallbacks, counter, reserved
        )
        edit = _ParaEditState(
            ords_by_stream,
            _Emission(prev, styled, prep.fallbacks, page_x0, page_x1,
                      size_override=prep.size_override,
                      kerns=_KernSource(resources, font_path, prep.fallbacks)),
            prep.fallbacks,
        )
        kept, changed, new_forms = _rewrite_paragraph_stream(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            None,
            0,
            edit,
            fonts,
            counter,
            reserved,
            (),
        )
        if not (changed and edit.changed):
            raise ValueError("edit did not apply (paragraph not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, edit.superseded_forms)
        # T18: a restyled merge can embed a substitute face — register it,
        # exactly as replace does (a Tf naming an unregistered font renders
        # nothing).
        page_tgt = edit.targets.get(())
        if page_tgt is not None:
            for fname, fdict in page_tgt.pending_fonts:
                _register_font(pdf, resources, fname, fdict)
        _save(pdf, input_path, output_path)
        return {
            "output": str(output_path),
            "page": int(page),
            # The merged paragraph lists at the ANCHOR's position: idx-1 for
            # the shipped previous-merge, idx itself when the next paragraph
            # merged INTO the selected one.
            "index": idx if with_next else idx - 1,
        }
    finally:
        try:
            pdf.close()
        except Exception:
            pass
