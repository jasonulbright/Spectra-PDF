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
        mem = _Member()
        mem.index = run["index"]
        mem.stream = det["stream"]
        mem.cap = cap
        mem.style = style
        mem.segments = det["segments"]
        mem.operator = det["operator"]
        mem.a = a
        mem.d = d
        mem.x0 = e
        mem.x1 = e + det["raw_width"] * style["h_scale"] * a
        mem.y = f
        mem.eff = max(style["size"] * d, 0.01)
        space_1000 = (
            cap.char_width(" ") if cap.can_encode(" ") else FALLBACK_SPACE_1000
        )
        mem.space_w = space_1000 / 1000.0 * style["size"] * style["h_scale"] * a
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
        mem.lkey = _linear_key(m)
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
                    denom = prev.a * prev.style["h_scale"] * prev.style["size"]
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
    paragraphs.sort(key=lambda p: (p.stream, -p.lines[0].y, p.left))
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


def _listing(paragraphs: list[_Paragraph]) -> list[dict]:
    out = []
    for i, p in enumerate(paragraphs):
        # The DOMINANT member: the widest on the first line — the SAME rule
        # _Emission uses to compute the leading scale, so the size the
        # editor shows is the size that scale is reasoned from (a first-by-
        # index lead-in marker otherwise seeded a mismatched number —
        # review-caught).
        first = _widest(p.lines[0].members)
        out.append(
            {
                "index": i,
                "runs": p.run_indexes,
                "box": [round(v, 4) for v in p.box],
                "text": p.text,
                "spans": p.spans,
                "alignment": p.alignment,
                "line_count": len(p.lines),
                "editable": p.editable,
                "reason": p.reason,
                # A1 restyle seeds: the paragraph's dominant (first-member)
                # size + fill colour.
                "font_size": round(first.style["size"], 2),
                "color": _fill_color_hex(first.style["fill_color"]),
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
        return {"page": int(page), "runs": runs, "paragraphs": _listing(paragraphs)}


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
    measured style, optionally re-fonted to the shared fallback subset."""

    __slots__ = ("member", "fallback", "size_override", "color_override")

    def __init__(self, member: _Member, fallback: bool, size_override=None, color_override=None):
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
            # Text painted via STROKE (Tr 1 = stroke, Tr 2 = fill+stroke)
            # shows its stroke colour — recolour that too, or the swatch
            # would be a silent no-op on outline text (review-caught). The
            # stroke colour uses the UPPERCASE op (rg→RG, g→G, k→K), so the
            # fill override must be converted, not copied verbatim.
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
    """The one shared fallback subset for this edit (7.4 machinery)."""

    __slots__ = ("name", "font_dict", "encode", "width_1000", "used")

    def __init__(self, name, font_dict, encode, width_1000):
        self.name = name
        self.font_dict = font_dict
        self.encode = encode
        self.width_1000 = width_1000
        self.used = False


def _styled_chars(
    new_text: str,
    spans: list[dict],
    members_by_index: dict[int, _Member],
    convert: bool,
    size_override=None,
    color_override=None,
    force_fallback: bool = False,
) -> tuple[list[tuple[str, _StyleRef]], str]:
    """Map every char of the new text to its style source; returns the
    styled stream plus the characters that need the fallback font (empty
    unless convert). Refuses (ValueError, naming the char) when a char is
    unencodable and convert is off — the renderer validates live, this is
    the belt.

    `force_fallback` (9.A3a family swap) routes EVERY character through
    the fallback font — the whole paragraph re-renders in the chosen
    face, so the members' own coverage is irrelevant (spaces included:
    they become real fallback glyphs, not synthetic kerns). Default False
    keeps the shipped branch order untouched — a no-family edit must stay
    byte-identical to 7.5/A1 output."""
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
    fallback_chars: set[str] = set()
    refs: dict[tuple, _StyleRef] = {}

    def ref(member: _Member, fb: bool) -> _StyleRef:
        k = (member.index, fb)
        if k not in refs:
            refs[k] = _StyleRef(member, fb, size_override, color_override)
        return refs[k]

    for span in spans:
        member = members_by_index[int(span["run"])]
        for ch in new_text[span["start"] : span["end"]]:
            if force_fallback:
                fallback_chars.add(ch)
                styled.append((ch, ref(member, True)))
            elif ch == " " or member.cap.can_encode(ch):
                styled.append((ch, ref(member, False)))
            elif convert:
                fallback_chars.add(ch)
                styled.append((ch, ref(member, True)))
            else:
                raise ValueError(f"font cannot encode {ch!r}")
    return styled, "".join(sorted(fallback_chars))


class _Word:
    __slots__ = ("chars", "width", "gap_after", "gap_styles")

    def __init__(self):
        self.chars: list[tuple[str, _StyleRef]] = []
        self.width = 0.0
        self.gap_after = 0.0  # user units of following space chars
        self.gap_styles: list[tuple[str, _StyleRef, float]] = []  # (char, style, w)


def _char_width_user(ch: str, st: _StyleRef, fb: _Fallback | None, median_gap_1000: float) -> float:
    m = st.member
    s = st.style()
    if st.fallback:
        w1000 = fb.width_1000(ch) if fb is not None else 0.0
        w = w1000 / 1000.0 * s["size"] + s["char_spacing"]
    elif ch == " " and not m.cap.can_encode(" "):
        # Synthetic gap — emitted as a TJ kern, so no Tc/Tw applies.
        w = median_gap_1000 / 1000.0 * s["size"]
    else:
        w = m.cap.char_width(ch) / 1000.0 * s["size"] + s["char_spacing"]
        if ch == " " and m.cap._code_bytes == 1:
            try:
                if m.cap.encode(" ") == b" ":
                    w += s["word_spacing"]
            except ValueError:
                pass
    return w * s["h_scale"] * m.a


def _tokenize(
    styled: list[tuple[str, _StyleRef]], fb: _Fallback | None, median_gap_1000: float
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
        w = _char_width_user(ch, st, fb, median_gap_1000)
        if ch == " ":
            current.gap_after += w
            current.gap_styles.append((ch, st, w))
            continue
        if current.gap_styles:
            close()  # a non-space after gap chars starts the next word
        elif (
            current.chars
            and ch not in NO_LINE_START
            and (_cjk(current.chars[-1][0]) or _cjk(ch))
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
) -> None:
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
        self, para: _Paragraph, styled, fb: _Fallback | None, page_x0: float, page_x1: float,
        size_override=None,
    ):
        self.para = para
        self.styled = styled
        self.fb = fb
        self.page_x0 = page_x0
        self.page_x1 = page_x1
        # A1: when the size is overridden, the paragraph leading scales by
        # the same factor so bigger text doesn't overlap (and smaller
        # text doesn't waste space) — the ratio to the paragraph's
        # dominant original size.
        self.size_override = size_override

    def build(self, ctm) -> list[tuple]:
        """[(kind, instruction, raw_width|None)]; kind ∈ {'op','show'} —
        the caller feeds ops into its emitted-state machine and advances
        after shows."""
        para = self.para
        if not self.styled:
            return []
        words = _tokenize(self.styled, self.fb, para.median_gap_1000)
        if not words:
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
        lines = _fill_lines(words, first_measure, body_measure)
        _position_lines(lines, para, first_left, body_left, leading)

        ctm_inv = _invert(ctm)
        base = _widest(para.lines[0].members)
        lin_a, lin_d = base.a, base.d
        out: list[tuple] = []
        for line in lines:
            for seg in self._segments(line):
                st: _StyleRef = seg["style"]
                # Rise renders via Ts (a state op), never the matrix —
                # the line target is the BASELINE.
                target = (lin_a, 0.0, 0.0, lin_d, line.x + seg["dx"], line.y)
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
                stream.append(("ch", ch, st, _char_width_user(ch, st, self.fb, self.para.median_gap_1000)))
            is_last = wi == len(line.words) - 1
            if not is_last:
                for ch, st, w in word.gap_styles:
                    if ch == " " and not st.fallback and not st.member.cap.can_encode(" "):
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
        font = self.fb.name if st.fallback else s["font_name"]
        if st.fallback and self.fb is not None:
            self.fb.used = True
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
            text = "".join(buf)
            encoded = self.fb.encode(text) if st.fallback else m.cap.encode(text)
            items.append(encoded)
            buf.clear()

        for item in seg["items"]:
            if item[0] == "ch":
                buf.append(item[1])
            else:
                flush()
                gap_user = item[2]
                denom = s["h_scale"] * m.a * s["size"]
                kern_1000 = gap_user / denom * 1000.0 if denom else 0.0
                items.append(-kern_1000)
        flush()
        denom_user = s["h_scale"] * m.a
        raw = seg["width"] / denom_user if denom_user else 0.0
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
    def __init__(self, target_stream, member_ordinals, first_ordinal, emission, fallback):
        self.target_stream = target_stream
        self.member_ordinals = member_ordinals
        self.first_ordinal = first_ordinal
        self.last_ordinal = max(member_ordinals)
        self.emission = emission
        self.fallback = fallback
        self.changed = False
        self.superseded_forms: set = set()
        self.pending_font: tuple | None = None


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
                                edit.pending_font is not None
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
                                fname, fdict = edit.pending_font
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
            if is_member:
                if show_ordinal == edit.first_ordinal:
                    if edit.fallback is not None:
                        edit.fallback.name = _fresh_font_name(resources, counter, reserved)
                    for kind, ins, raw_w in edit.emission.build(orig.ctm):
                        kept.append(ins)
                        if kind == "show":
                            emit.advance_after_show(raw_w)
                        else:
                            emit_feed(ins)
                    if edit.fallback is not None and edit.fallback.used:
                        edit.pending_font = (edit.fallback.name, edit.fallback.font_dict)
                edit.changed = True
                changed = True
                diverged = True
                orig.advance_after_show(raw)
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
                orig.advance_after_show(raw)
                emit.advance_after_show(raw)
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
                orig.advance_after_show(raw)
                emit.advance_after_show(raw)
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

    A3a restyle: `family` ("serif" | "sans" | "mono") substitutes the
    WHOLE paragraph into the bundled Liberation face of that family —
    every character re-embeds via the fallback machinery (`font_path`
    required), an honest substitution of the original foundry font.
    Characters the Liberation face lacks refuse with a stated reason.
    None keeps the paragraph's own fonts (the shipped 7.5/A1 path,
    byte-identical)."""
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

        members_by_index = {m.index: m for m in para.members}
        styled, fb_chars = _styled_chars(
            str(new_text), list(spans), members_by_index, bool(convert),
            size_override=size_override, color_override=color_override,
            force_fallback=family_override is not None,
        )
        fallback = None
        if fb_chars:
            from engine.font_fallback import (
                build_fallback_font,
                resolve_fallback_font,
                synthetic_family_font,
            )
            from engine.text_runs import _lookup_font

            if not font_path:
                raise ValueError("fallback font path is required to convert")
            if family_override is not None:
                # A3a: the user picked the family — classification is
                # bypassed via a synthetic /Flags dict (the A2 trick), so
                # the substitution lands on exactly that face.
                face = resolve_fallback_font(str(font_path), synthetic_family_font(family_override))
            else:
                # Phase 9.B1: one fallback face for the paragraph, its family
                # matched to the paragraph's first member run (a serif body
                # converts in serif). Per-span fallback families (a mono code
                # span inside a serif paragraph) is a documented tail — one
                # face here, chosen from the dominant member. The font is
                # looked up in the member's OWN stream resources (form-scoped
                # when nested), page resources as fallback — a form's `F1` can
                # differ from the page's (review-caught).
                first = min(para.members, key=lambda m: m.index)
                original = _lookup_font(
                    first.style["font_name"], first.resources or resources, resources
                )
                face = resolve_fallback_font(str(font_path), original)
            font_dict, encode, width_1000 = build_fallback_font(pdf, face, fb_chars)
            fallback = _Fallback(None, font_dict, encode, width_1000)

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
            page_x0, page_x1 = min(box[0], box[2]), max(box[0], box[2])
        except (TypeError, ValueError):
            page_x0, page_x1 = 0.0, 612.0
        edit = _ParaEditState(
            para.stream,
            set(ordinal_of.values()),
            ordinal_of[min(member_set)],
            _Emission(para, styled, fallback, page_x0, page_x1, size_override=size_override),
            fallback,
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
        if edit.pending_font is not None and edit.target_stream == ():
            fname, fdict = edit.pending_font
            _register_font(pdf, resources, fname, fdict)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(paragraph_index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass
