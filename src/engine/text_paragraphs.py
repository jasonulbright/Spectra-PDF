"""Paragraph grouping + reflow (Phase 7.5 — the last content-editing slice).

Groups the text runs of a page into PARAGRAPH BOXES — the industry
editor's model — and re-lays-out a paragraph's text inside its box on
edit (rewrap at the measured width, alignment/indent/leading preserved,
growth downward). The design record is `docs/architecture/21` §7.5; the
one-line summary of every structural rule:

  - Grouping happens HERE (engine), from the SAME `_walk_runs` walk that
    produces the run listing — index agreement by construction. Runs from
    different streams (page vs a form instance; two instances of one
    form) never group, so an apply is one stream rewrite.
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

import re
import statistics
import unicodedata
from collections import defaultdict
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

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

# Kinsoku-lite: closing punctuation that must not START a wrapped line.
NO_LINE_START = set("。、」』）］｝！？，．・:;,.!?)]}»›'\"”’")


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
    )


def _axis_aligned(m) -> bool:
    a, b, c, d, _e, _f = m
    lim = MATRIX_TOL * max(abs(a), abs(d), 1e-9)
    return abs(b) <= lim and abs(c) <= lim and a > 0 and d > 0


def _linear_key(m) -> tuple:
    a, b, c, d, _e, _f = m
    return (round(a, 4), round(b, 4), round(c, 4), round(d, 4))


def _ptext_and_gaps(det) -> tuple[str, list[float]]:
    """The run's paragraph-text (synthetic spaces at TJ word gaps) plus the
    observed gap widths (1000ths of em) for the paragraph's median."""
    cap = det["cap"]
    parts: list[str] = []
    gaps: list[float] = []
    space_1000 = (
        cap.char_width(" ")
        if (cap is not None and cap.can_encode(" "))
        else FALLBACK_SPACE_1000
    )
    threshold = WORD_GAP_FRACTION * space_1000
    for seg in det["segments"]:
        if isinstance(seg, float):
            gap = -seg  # negative TJ numbers push the pen RIGHT
            if gap >= threshold:
                parts.append(" ")
                gaps.append(gap)
            continue
        parts.append(cap.decode(seg) if cap is not None else "")
    return "".join(parts), gaps


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
        mem.ptext, mem.gaps_1000 = _ptext_and_gaps(det)
        mem.editable = bool(run["editable"])
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


def _join_paragraphs(lines: list[_Line]) -> list[list[_Line]]:
    """Column-aware top-down joining: each line (y-descending) joins the
    OPEN paragraph with the best horizontal overlap whose leading/size
    evidence accepts it, else opens a new one. Strictly sequential joining
    fails the moment two columns interleave in y order — the candidate
    search is what keeps side-by-side columns separate AND contiguous."""
    lines = sorted(lines, key=lambda l: -l.y)
    open_paras: list[dict] = []
    for line in lines:
        bullet = _starts_with_bullet(line)
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
                if ov > best_overlap:
                    best, best_overlap = para, ov
        if best is None:
            open_paras.append({"lines": [line], "deltas": []})
        else:
            best["deltas"].append(best["lines"][-1].y - line.y)
            best["lines"].append(line)
    return [p["lines"] for p in open_paras]


def _detect_alignment(lines: list[_Line], left: float, right: float) -> str:
    if len(lines) < 2:
        return "left"
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
    return "left"


def _assemble_text(lines: list[_Line]) -> tuple[str, list[dict], list[float]]:
    """(logical text, spans [{start,end,run}], observed word gaps 1000)."""
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
        next_first = next(
            (m.ptext[0] for m in line.members if m.ptext), ""
        )
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
        prev: _Member | None = None
        for mem in line.members:
            if prev is not None:
                gap = mem.x0 - prev.x1
                if gap >= WORD_GAP_FRACTION * prev.space_w:
                    if last_char != " ":
                        emit(" ", prev.index)
                    # 9.B4b: the gap converts to 1000ths at the ADVANCE
                    # axis's user scale — d for vertical (Tz never applies
                    # vertically), h_scale×a for horizontal (unchanged).
                    axis = prev.d if prev.vertical else prev.a * prev.style["h_scale"]
                    denom = axis * prev.style["size"]
                    if denom > 1e-9:
                        gaps.append(gap / denom * 1000.0)
            emit(mem.ptext, mem.index)
            gaps.extend(mem.gaps_1000)
            prev = mem
    return "".join(parts), spans, gaps


_RTL_CLASSES = ("R", "AL")


def _analyze(paras: list[list[_Line]], stream: tuple, lkey: tuple) -> list[_Paragraph]:
    out: list[_Paragraph] = []
    for lines in paras:
        p = _Paragraph()
        p.lines = lines
        p.stream = stream
        p.lkey = lkey
        p.left = min(l.x0 for l in lines)
        p.right = max(l.x1 for l in lines)
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
        elif any(unicodedata.bidirectional(ch) in _RTL_CLASSES for ch in p.text):
            p.editable = False
            p.reason = "right-to-left text does not reflow"
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
        out.append(p)
    return out


def _group(runs: list[dict], detail: list[dict]) -> list[_Paragraph]:
    members = _members_from(runs, detail)
    groups: dict[tuple, list[_Member]] = defaultdict(list)
    for mem in members:
        groups[(mem.stream, mem.lkey)].append(mem)
    paragraphs: list[_Paragraph] = []
    for (stream, lkey), mems in groups.items():
        lines = _cluster_lines(mems)
        for para_lines in _join_paragraphs(lines):
            paragraphs.extend(_analyze([para_lines], stream, lkey))
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
        b, it = style_of(first) if style_of is not None else (False, False)
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
                # A1 restyle seeds: the paragraph's dominant (first-member)
                # size + fill colour.
                "font_size": round(first.style["size"], 2),
                "color": _fill_color_hex(first.style["fill_color"]),
                "bold": b,
                "italic": it,
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
        from engine.font_fallback import classify_font_style
        from engine.text_runs import _lookup_font

        def style_of(member: _Member) -> tuple[bool, bool]:
            try:
                fd = _lookup_font(
                    member.style["font_name"], member.resources or resources, resources
                )
            except Exception:
                fd = None
            if fd is None:
                return (False, False)
            try:
                return classify_font_style(fd)
            except Exception:
                return (False, False)

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

    __slots__ = ("member", "fallback", "size_override", "color_override")

    def __init__(self, member: _Member, fallback, size_override=None, color_override=None):
        self.member = member
        self.fallback = fallback
        # A1: uniform size (points) / fill-color (ColorState) overrides,
        # or None to keep the member's own. Applied via style().
        self.size_override = size_override
        self.color_override = color_override

    @property
    def key(self) -> tuple:
        return (self.member.index, self.fallback, self.size_override, self.color_override)

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

    __slots__ = ("name", "font_dict", "encode", "width_1000", "used")

    def __init__(self, name, font_dict, encode, width_1000):
        self.name = name
        self.font_dict = font_dict
        self.encode = encode
        self.width_1000 = width_1000
        self.used = False


def _face_sort_key(key: tuple) -> tuple:
    """Total order over face keys `(family_or_None, bold, italic)` — None
    family sorts as "" so the sort never compares NoneType to str. Pins the
    per-subset name allocation + build order (deterministic bytes)."""
    fam, bold, italic = key
    return (fam or "", bold, italic)


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
    member_family=None,
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
    A1 whole-paragraph colour). The colour and face lookups are folded
    INDEPENDENTLY from the same span_styles list — a char may be per-span
    red AND bold, on unaligned ranges. Both None (the default) is
    byte-identical to the shipped path."""
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

    def ref(member: _Member, fb, col) -> _StyleRef:
        # `fb` is a face KEY (tuple) or None — both hashable, so the memo
        # key + _StyleRef.key stay hashable/comparable (9.A5b).
        k = (member.index, fb, col)
        if k not in refs:
            refs[k] = _StyleRef(member, fb, size_override, col)
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

    def face_at(pos: int, member: _Member):
        # A5b: per-span face at pos wins, else the whole-para A3 face, else
        # None (keep the member's own font).
        if face_by_pos is not None:
            k = face_by_pos[pos] if 0 <= pos < len(face_by_pos) else None
            if k is not None:
                fam, kb, ki = k
                if fam is None and member_family is not None:
                    # Round-33 HIGH: a per-span face with NO explicit family
                    # keeps THIS char's own member family (a bolded mono word
                    # in a serif paragraph → LiberationMono-Bold, not the
                    # first member's serif). Bake it into the key HERE, where
                    # the member is known, so chars from different families
                    # split into their own subsets and the build step embeds
                    # the right typeface. `whole_para_face` (the true
                    # whole-paragraph A3b key) is returned untouched below —
                    # it resolves from the DOMINANT member, byte-identical.
                    k = (member_family.get(member.index), kb, ki)
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
            # A5a: a ligature/atomic entry can carry ONE colour — resolve at
            # its FIRST position (the glyph is indivisible; a colour/face
            # boundary inside a sequence takes the start value).
            col = color_at(pos, member)
            fk = face_at(pos, member)
            if fk is not None:
                if member.vertical:
                    # 9.B4b belt (the para-level substitution refusal is
                    # the surface): the fallback faces are horizontal.
                    raise ValueError(
                        "vertical text cannot be converted to the fallback font"
                    )
                fb_by_face.setdefault(fk, set()).add(ch)
                styled.append((ch, ref(member, fk, col)))
                i += 1
                continue
            # 9.B5: an unambiguous ligature sequence becomes ONE atomic
            # styled entry — matched BEFORE the single map (the encode
            # order), so the width math and the emitted bytes agree by
            # construction (text_width and encode share the matcher).
            # Sequences never cross spans; nor a per-span face boundary.
            seq = member.cap._sequence_at(seg_text, i)
            if seq is not None and not seq_crosses_face(pos, len(seq)):
                styled.append((seq, ref(member, None, col)))
                i += len(seq)
                continue
            if ch == " " or member.cap.can_encode(ch):
                styled.append((ch, ref(member, None, col)))
            elif convert:
                if member.vertical:
                    # 9.B4b: the 7.4 fallback embeds a HORIZONTAL
                    # Identity-H face — dropped into a column it would
                    # render on the wrong axis (the B4a convert-refusal
                    # rule, held here for the per-char path).
                    raise ValueError(
                        "vertical text cannot be converted to the fallback font"
                    )
                # B1 dominant/convert face: family resolves from the first
                # member (the build step), style regular — byte-identical to
                # the shipped single convert subset.
                ck = (None, False, False)
                fb_by_face.setdefault(ck, set()).add(ch)
                styled.append((ch, ref(member, ck, col)))
            else:
                raise ValueError(f"font cannot encode {ch!r}")
            i += 1
    return styled, fb_by_face


class _Word:
    __slots__ = ("chars", "width", "gap_after", "gap_styles")

    def __init__(self):
        self.chars: list[tuple[str, _StyleRef]] = []
        self.width = 0.0
        self.gap_after = 0.0  # user units of following space chars
        self.gap_styles: list[tuple[str, _StyleRef, float]] = []  # (char, style, w)


def _char_width_user(ch: str, st: _StyleRef, fallbacks: dict, median_gap_1000: float) -> float:
    m = st.member
    s = st.style()
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
        if ch == " " and m.cap._code_bytes == 1:
            try:
                if m.cap.encode(" ") == b" ":
                    w += s["word_spacing"]
            except ValueError:
                pass
    # 9.B4b: a vertical member's advance lives on the transposed x′ axis,
    # whose user scale is d — Tz never applies vertically (Tc does, and
    # already rode in above). Horizontal is byte-identical.
    return w * (m.d if m.vertical else s["h_scale"] * m.a)


def _tokenize(
    styled: list[tuple[str, _StyleRef]], fallbacks: dict, median_gap_1000: float
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

    for ch, st in styled:
        w = _char_width_user(ch, st, fallbacks, median_gap_1000)
        if ch == " ":
            current.gap_after += w
            current.gap_styles.append((ch, st, w))
            continue
        if current.gap_styles:
            close()  # a non-space after gap chars starts the next word
        elif (
            current.chars
            and ch not in NO_LINE_START
            # 9.B5: entries can be atomic multi-char ligatures — classify
            # the break by the boundary-adjacent code points.
            and (_cjk(current.chars[-1][0][-1]) or _cjk(ch[0]))
        ):
            close()  # break after (and before) CJK — no-space scripts wrap
        current.chars.append((ch, st))
        current.width += w
    close()
    return words


class _LayoutLine:
    __slots__ = ("words", "width", "x", "y", "justify_extra")

    def __init__(self):
        self.words: list[_Word] = []
        self.width = 0.0
        self.x = 0.0
        self.y = 0.0
        self.justify_extra = 0.0  # per-gap addition (justified lines)


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
    return lines


def _position_lines(
    lines: list[_LayoutLine],
    para: _Paragraph,
    first_left: float,
    body_left: float,
    leading: float,
    y0: float | None = None,
) -> None:
    # y0 overrides the anchor for a block that does NOT start at the
    # paragraph's own first baseline (A4 split: the second block starts
    # 2×leading below the first block's last line).
    if y0 is None:
        y0 = para.lines[0].y
    for i, line in enumerate(lines):
        line.y = y0 - i * leading
        if para.alignment == "center":
            # No clamp: an overflowing line centers symmetrically too.
            line.x = para.left + ((para.right - para.left) - line.width) / 2
        elif para.alignment == "right":
            line.x = para.right - line.width
        else:
            line.x = first_left if i == 0 else body_left
        if (
            para.alignment == "justify"
            and i < len(lines) - 1
            and len(line.words) > 1
        ):
            deficit = (para.right - line.x) - line.width
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


class _Emission:
    """The paragraph's replacement ops, built once the rewriter reaches the
    first member (the ctm there anchors the user-space line targets)."""

    def __init__(
        self, para: _Paragraph, styled, fallbacks: dict, page_x0: float, page_x1: float,
        size_override=None, split_at=None,
    ):
        self.para = para
        self.styled = styled
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

    def build(self, ctm) -> list[tuple]:
        """[(kind, instruction, raw_width|None)]; kind ∈ {'op','show'} —
        the caller feeds ops into its emitted-state machine and advances
        after shows."""
        para = self.para
        if not self.styled:
            return []
        body_lefts = [l.x0 for l in para.lines[1:]]
        first_left = para.lines[0].x0
        body_left = min(body_lefts) if body_lefts else first_left
        if para.alignment in ("center", "right"):
            first_left = body_left = para.left
        # A1 leading scale: new size / the dominant original size.
        dom_style_size = _widest(para.lines[0].members).style["size"] or 12.0
        size_scale = (self.size_override / dom_style_size) if self.size_override else 1.0
        if para.leading is not None:
            leading = para.leading * size_scale
            right_limit = para.right
        else:
            dominant = _widest(para.lines[0].members)
            base_eff = (
                dominant.eff * size_scale if self.size_override else dominant.eff
            )
            leading = SINGLE_LINE_LEADING_EM * base_eff
            # Symmetric page margin, never narrower than the existing line
            # (unchanged text must not rewrap under its own edit).
            margin = max(para.left - self.page_x0, 0.0)
            right_limit = max(self.page_x1 - margin, para.right)
        first_measure = right_limit - first_left
        body_measure = right_limit - body_left
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
        split_gap = max(2.0 * leading, 2.0 * dom_eff)
        lines: list[_LayoutLine] = []
        y_next: float | None = None
        for part in parts:
            words = _tokenize(part, self.fallbacks, para.median_gap_1000)
            if not words:
                continue
            block = _fill_lines(words, first_measure, body_measure)
            _position_lines(block, para, first_left, body_left, leading, y0=y_next)
            if block:
                y_next = block[-1].y - split_gap
            lines.extend(block)
        if not lines:
            return []

        ctm_inv = _invert(ctm)
        base = _widest(para.lines[0].members)
        lin_a, lin_d = base.a, base.d
        out: list[tuple] = []
        for line in lines:
            for seg in self._segments(line):
                st: _StyleRef = seg["style"]
                # Rise renders via Ts (a state op), never the matrix —
                # the line target is the BASELINE.
                if self.vertical:
                    # 9.B4b: THE untranspose — layout ran wholly in
                    # transposed space; only the anchor maps back through
                    # T⁻¹(x′, y′) = (y′, −x′). The linear part stays
                    # (a, 0, 0, d): glyphs upright — the advance
                    # DIRECTION is the walker's vertical model
                    # (advance_after_show), never the matrix.
                    tx, ty = line.y, -(line.x + seg["dx"])
                else:
                    tx, ty = line.x + seg["dx"], line.y
                target = (lin_a, 0.0, 0.0, lin_d, tx, ty)
                tm_op = mat_mult(target, ctm_inv)
                out.append(("op", _instruction([_f(v) for v in tm_op], "Tm"), None))
                out.extend(self._state_ops(st))
                encoded_items, raw = self._encode(seg)
                if len(encoded_items) == 1 and not isinstance(encoded_items[0], float):
                    out.append(("show", _instruction([pikepdf.String(encoded_items[0])], "Tj"), raw))
                else:
                    arr = pikepdf.Array(
                        [
                            pikepdf.String(el) if isinstance(el, bytes) else _f(el)
                            for el in encoded_items
                        ]
                    )
                    out.append(("show", _instruction([arr], "TJ"), raw))
        return out

    def _segments(self, line: _LayoutLine) -> list[dict]:
        """Split a line's char stream into same-style segments; synthetic
        spaces and justify extras become in-segment kerns (or fold into
        the next segment's absolute x at a style boundary)."""
        stream: list[tuple] = []  # ("ch", ch, style, w) | ("kern", style, w)
        for wi, word in enumerate(line.words):
            for ch, st in word.chars:
                stream.append(("ch", ch, st, _char_width_user(ch, st, self.fallbacks, self.para.median_gap_1000)))
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

    def _state_ops(self, st: _StyleRef) -> list[tuple]:
        m = st.member
        s = st.style()  # A1: effective (possibly size/color-overridden)
        ops: list[tuple] = []
        if st.fallback is not None:
            fb = self.fallbacks[st.fallback]
            fb.used = True  # marks THIS subset for registration (per face)
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
        for item in seg["items"]:
            if item[0] == "ch":
                buf.append(item[1])
            else:
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


class _ParaEditState:
    def __init__(self, target_stream, member_ordinals, first_ordinal, emission, fallbacks):
        self.target_stream = target_stream
        self.member_ordinals = member_ordinals
        self.first_ordinal = first_ordinal
        self.last_ordinal = max(member_ordinals)
        self.emission = emission
        # 9.A5b: {face key → _Fallback} (was the single `fallback`).
        self.fallbacks = fallbacks
        self.changed = False
        self.superseded_forms: set = set()
        # 9.A5b: one (name, font_dict) per USED subset (was the single
        # `pending_font`) — each registered at the top level or into the
        # nested-form copy.
        self.pending_fonts: list = []


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
    """(kept, changed, new_forms). Non-target streams pass through verbatim
    (descending ONLY along the target path — local form ordinals make that
    navigable); the target stream gets member removal + emission + the
    dual-machine resync described in the module docstring."""
    in_target = path == edit.target_stream
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

        if not in_target:
            if operator == "Do":
                name = str(operands[0]) if operands else None
                xobj = _lookup_xobject(name, resources, fallback_res)
                subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""
                if xobj is not None and subtype == "/Form" and depth < MAX_FORM_DEPTH:
                    my_ordinal = form_ordinal
                    form_ordinal += 1
                    on_path = (
                        len(edit.target_stream) > len(path)
                        and edit.target_stream[: len(path)] == path
                        and edit.target_stream[len(path)] == my_ordinal
                    )
                    if on_path:
                        form_res = xobj.get("/Resources")
                        read_res = form_res if form_res is not None else resources
                        form_matrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
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
                            path + (my_ordinal,),
                            base_ctm=mat_mult(form_matrix, orig.ctm),
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
                            if (
                                edit.pending_fonts
                                and path + (my_ordinal,) == edit.target_stream
                            ):
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
                                for fname, fdict in edit.pending_fonts:
                                    _register_font(pdf, copy_res, fname, fdict)
                            copy["/Resources"] = copy_res
                            new_name = _fresh_name(resources, counter, reserved)
                            new_forms[new_name] = copy
                            kept.append(_instruction([Name(new_name)], "Do"))
                            if name:
                                edit.superseded_forms.add(name)
                            continue
            orig.feed(operator, operands)
            kept.append(instruction)
            continue

        # ── target stream ────────────────────────────────────────────────
        if operator == "BT":
            in_bt = True
        elif operator == "ET":
            in_bt = False

        if operator in SHOW_OPS:
            is_member = show_ordinal in edit.member_ordinals
            if is_member and show_ordinal == edit.first_ordinal:
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
                if show_ordinal == edit.first_ordinal:
                    # 9.A5b: allocate a fresh name per subset in sorted-face
                    # order BEFORE the build (so _state_ops reads it), then
                    # collect the ones the build actually emitted. One key →
                    # one `/EditFb0`, byte-identical to the shipped A3 path.
                    for key in sorted(edit.fallbacks, key=_face_sort_key):
                        edit.fallbacks[key].name = _fresh_font_name(resources, counter, reserved)
                    for kind, ins, raw_w in edit.emission.build(orig.ctm):
                        kept.append(ins)
                        if kind == "show":
                            emit.advance_after_show(raw_w, edit.emission.vertical)
                        else:
                            emit_feed(ins)
                    for key in sorted(edit.fallbacks, key=_face_sort_key):
                        fb = edit.fallbacks[key]
                        if fb.used:
                            edit.pending_fonts.append((fb.name, fb.font_dict))
                edit.changed = True
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
            and show_ordinal <= edit.last_ordinal
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
    span_styles: list | None = None,
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

    A5a/A5b per-span styling: `span_styles` is None or a list of
    `{start, end, color?: [r, g, b], family?, bold?, italic?}` over
    CODE-POINT ranges of `new_text` (distinct from the style-SOURCE
    `spans`; sparse; need not align to span boundaries; overlaps fold
    last-wins). A `color` recolours its range, overriding the A1
    whole-paragraph `color` (A5a, metric-neutral). A `family`/`bold`/
    `italic` SUBSTITUTES its range into the matching bundled Liberation
    face (A5b) — one embedded subset per distinct requested face, family
    absent = keep the char's member family, the same honest substitution
    A3 does whole-paragraph. The colour and face axes fold INDEPENDENTLY
    (a range can be red AND bold, on unaligned ranges). Per-span faces
    inherit A3's refusals (a char the Liberation face lacks is named);
    vertical paragraphs refuse substitution (B4b). None throughout =
    byte-identical shipped.

    9.B4b: vertical paragraphs reflow through the same pipeline in
    transposed space (columns fill top-down at the measured pitch, growth
    adds columns leftward; size scales the pitch, split gaps transpose).
    Family/bold/italic substitution and per-char convert refuse — the
    fallback faces are horizontal (v1 boundary)."""
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
        if not (0 <= int(paragraph_index) < len(paragraphs)):
            raise ValueError(
                f"paragraph index {paragraph_index} is out of range (page has {len(paragraphs)})"
            )
        para = paragraphs[int(paragraph_index)]
        if not para.editable:
            raise ValueError(para.reason or "this paragraph is not editable")
        if [int(r) for r in expected_runs] != para.run_indexes or str(expected_text) != para.text:
            raise ValueError("the page's text changed underneath this edit — reopen the editor")

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
            fam = str(family).strip().lower()
            if fam not in ("serif", "sans", "mono"):
                raise ValueError("family must be serif, sans, or mono")
            family_override = fam
        # A3b style axis: a PRESENT bold/italic is the substituted face's
        # absolute weight/slant; both None = no style substitution.
        style_override = None
        if bold is not None or italic is not None:
            style_override = (bool(bold), bool(italic))
        substituting = family_override is not None or style_override is not None
        # 9.B4b: the bundled Liberation faces are horizontal — substituted
        # into a column their glyphs would lay out on the wrong axis.
        # Refuse outright (the B4a convert-refusal honesty; v1 boundary).
        if substituting and para.vertical:
            raise ValueError("vertical text cannot substitute a horizontal face")
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

        # A5a/A5b per-span styling: fold the sparse span_styles ranges into
        # per-code-point lookups — `color_by_pos` (A5a colour) and
        # `face_by_pos` (A5b face key) INDEPENDENTLY, so one entry may carry
        # a colour, a face, or both, on unaligned ranges. Last-writer-wins on
        # overlap. Both stay None when unused → _styled_chars byte-identical.
        color_by_pos = None
        face_by_pos = None
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
                has_face = any(f in entry for f in ("family", "bold", "italic"))
                has_color = entry.get("color") is not None
                if not has_face and not has_color:
                    raise ValueError("span style must set a colour or a face")
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
                        fam = str(fam).strip().lower()
                        if fam not in ("serif", "sans", "mono"):
                            raise ValueError("span style family must be serif, sans, or mono")
                    facekey = (fam, bool(entry.get("bold")), bool(entry.get("italic")))
                    if face_by_pos is None:
                        face_by_pos = [None] * n_cp
                    for k in range(st, en):
                        face_by_pos[k] = facekey

        # A3a/A3b whole-paragraph substitution → ONE face key covering every
        # char (family_override may be None = keep the member family). None
        # when not substituting. Per-span faces (face_by_pos) override it per
        # position; the single-key case stays byte-identical to shipped A3.
        whole_para_face = None
        if substituting:
            wb = style_override[0] if style_override is not None else False
            wi = style_override[1] if style_override is not None else False
            whole_para_face = (family_override, wb, wi)

        members_by_index = {m.index: m for m in para.members}
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
        styled, fb_by_face = _styled_chars(
            str(new_text), list(spans), members_by_index, bool(convert),
            size_override=size_override, color_override=color_override,
            whole_para_face=whole_para_face, color_by_pos=color_by_pos,
            face_by_pos=face_by_pos, member_family=member_family,
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
                fam, kbold, kitalic = key
                if fam is not None:
                    original = synthetic_family_font(fam)
                else:
                    original = _lookup_font(
                        first.style["font_name"], first.resources or resources, resources
                    )
                face = resolve_fallback_font(
                    str(font_path), original, style=style_key(kbold, kitalic)
                )
                chars = "".join(sorted(fb_by_face[key]))
                font_dict, encode, width_1000 = build_fallback_font(pdf, face, chars)
                fallbacks[key] = _Fallback(None, font_dict, encode, width_1000)

        member_set = set(para.run_indexes)
        per_stream_counts: dict[tuple, int] = defaultdict(int)
        ordinal_of: dict[int, int] = {}
        for i, det in enumerate(detail):
            o = per_stream_counts[det["stream"]]
            per_stream_counts[det["stream"]] = o + 1
            if i in member_set:
                ordinal_of[i] = o
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
        edit = _ParaEditState(
            para.stream,
            set(ordinal_of.values()),
            ordinal_of[min(member_set)],
            _Emission(
                para, styled, fallbacks, page_x0, page_x1,
                size_override=size_override, split_at=split_point,
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
            [0],
            set(),
            (),
        )
        if not (changed and edit.changed):
            raise ValueError("edit did not apply (paragraph not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, edit.superseded_forms)
        if edit.pending_fonts and edit.target_stream == ():
            for fname, fdict in edit.pending_fonts:
                _register_font(pdf, resources, fname, fdict)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(paragraph_index)}
    finally:
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
        if not (1 <= idx < len(paragraphs)):
            raise ValueError("no previous paragraph to merge with")
        prev, cur = paragraphs[idx - 1], paragraphs[idx]
        for para_, label in ((prev, "previous"), (cur, "selected")):
            if not para_.editable:
                raise ValueError(para_.reason or f"the {label} paragraph is not editable")
        if prev.stream != cur.stream:
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

        joiner = "" if (prev.text and cur.text and _cjk(prev.text[-1]) and _cjk(cur.text[0])) else " "
        new_text = prev.text + joiner + cur.text
        # Spans stay contiguous: the joiner rides the PREVIOUS paragraph's
        # last span (the line-join rule); cur's spans shift up.
        shift = len(prev.text) + len(joiner)
        spans = [dict(s) for s in prev.spans]
        if joiner and spans:
            spans[-1]["end"] += len(joiner)
        spans += [
            {"start": s["start"] + shift, "end": s["end"] + shift, "run": s["run"]}
            for s in cur.spans
        ]

        members_by_index = {m.index: m for m in prev.members}
        members_by_index.update({m.index: m for m in cur.members})
        # convert=False: a merge re-encodes existing characters in their own
        # fonts; the belt refusal names any that cannot round-trip.
        styled, _fb = _styled_chars(new_text, spans, members_by_index, False)

        member_set = set(prev.run_indexes) | set(cur.run_indexes)
        per_stream_counts: dict[tuple, int] = defaultdict(int)
        ordinal_of: dict[int, int] = {}
        for i, det in enumerate(detail):
            o = per_stream_counts[det["stream"]]
            per_stream_counts[det["stream"]] = o + 1
            if i in member_set:
                ordinal_of[i] = o
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
        edit = _ParaEditState(
            prev.stream,
            set(ordinal_of.values()),
            ordinal_of[min(member_set)],
            _Emission(prev, styled, {}, page_x0, page_x1),
            {},
        )
        kept, changed, new_forms = _rewrite_paragraph_stream(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            None,
            0,
            edit,
            fonts,
            [0],
            set(),
            (),
        )
        if not (changed and edit.changed):
            raise ValueError("edit did not apply (paragraph not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, edit.superseded_forms)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": idx - 1}
    finally:
        try:
            pdf.close()
        except Exception:
            pass
