"""The Unicode Bidirectional Algorithm (UAX #9), through rule L2.

Why our own rather than a dependency: the paragraph reflow needs the
REORDERING PERMUTATION, not a reordered string — every character of an edited
paragraph carries a style reference and a source-run attribution that has to
travel with it — and no available binding exposes the resolved levels. The
algorithm is also exactly the kind of thing that must not be approximated:
it is fully specified and, uniquely in this codebase, has an AUTHORITATIVE
conformance suite (`BidiCharacterTest.txt`), so an implementation can be
proven rather than argued about. `tests/data/BidiCharacterTest-sample.txt`
pins a deterministic sample of it; the full file drops in unchanged.

Public surface (everything else is rule machinery):

  ``paragraph_level(text)``   P2/P3 — 0 for LTR base, 1 for RTL base.
  ``resolve(text, base)``     → (paragraph level, per-character levels).
  ``visual_order(text, base)``→ (paragraph level, indices in visual order).
  ``has_strong_rtl(text)``    → any R/AL character (the reflow trigger).

Two conventions worth stating once:

  - Characters removed by rule X9 (the explicit embedding/override codes,
    PDF, and BN) get level ``None`` and are ABSENT from the visual order —
    the same convention `BidiCharacterTest.txt` uses with its ``x`` marker.
  - ``resolve`` treats the whole string as ONE paragraph and ONE line. The
    caller wraps first and reorders per line (rule L1's line-end whitespace
    reset is meaningless otherwise), which is exactly how the reflow uses it.

Unicode version skew is real and handled honestly: character classes come
from the running interpreter's `unicodedata`, with the DerivedBidiClass
default ranges filling in code points it does not know. A newer conformance
file may therefore carry cases whose characters this interpreter has not
heard of; the test filters those rather than pretending.
"""

import unicodedata

MAX_DEPTH = 125

# Types removed by rule X9 — they get no level and never appear in the order.
_REMOVED_BY_X9 = frozenset(("RLE", "LRE", "RLO", "LRO", "PDF", "BN"))
_ISOLATE_INITIATORS = frozenset(("LRI", "RLI", "FSI"))
# "NI" in the spec: neutral or isolate formatting character (rules N0-N2).
_NEUTRAL_OR_ISOLATE = frozenset(("B", "S", "WS", "ON", "FSI", "LRI", "RLI", "PDI"))

# BidiBrackets.txt, opening → closing (Bidi_Paired_Bracket_Type=Open).
_BRACKET_PAIRS = {
    0x0028: 0x0029, 0x005B: 0x005D, 0x007B: 0x007D, 0x0F3A: 0x0F3B,
    0x0F3C: 0x0F3D, 0x169B: 0x169C, 0x2045: 0x2046, 0x207D: 0x207E,
    0x208D: 0x208E, 0x2308: 0x2309, 0x230A: 0x230B, 0x2329: 0x232A,
    0x2768: 0x2769, 0x276A: 0x276B, 0x276C: 0x276D, 0x276E: 0x276F,
    0x2770: 0x2771, 0x2772: 0x2773, 0x2774: 0x2775, 0x27C5: 0x27C6,
    0x27E6: 0x27E7, 0x27E8: 0x27E9, 0x27EA: 0x27EB, 0x27EC: 0x27ED,
    0x27EE: 0x27EF, 0x2983: 0x2984, 0x2985: 0x2986, 0x2987: 0x2988,
    0x2989: 0x298A, 0x298B: 0x298C, 0x298D: 0x2990, 0x298F: 0x298E,
    0x2991: 0x2992, 0x2993: 0x2994, 0x2995: 0x2996, 0x2997: 0x2998,
    0x29D8: 0x29D9, 0x29DA: 0x29DB, 0x29FC: 0x29FD, 0x2E22: 0x2E23,
    0x2E24: 0x2E25, 0x2E26: 0x2E27, 0x2E28: 0x2E29, 0x2E55: 0x2E56,
    0x2E57: 0x2E58, 0x2E59: 0x2E5A, 0x2E5B: 0x2E5C, 0x3008: 0x3009,
    0x300A: 0x300B, 0x300C: 0x300D, 0x300E: 0x300F, 0x3010: 0x3011,
    0x3014: 0x3015, 0x3016: 0x3017, 0x3018: 0x3019, 0x301A: 0x301B,
    0xFE59: 0xFE5A, 0xFE5B: 0xFE5C, 0xFE5D: 0xFE5E, 0xFF08: 0xFF09,
    0xFF3B: 0xFF3D, 0xFF5B: 0xFF5D, 0xFF5F: 0xFF60, 0xFF62: 0xFF63,
}
_CLOSE_TO_OPEN = {v: k for k, v in _BRACKET_PAIRS.items()}
# BD16 matches under canonical equivalence, and exactly two bracket pairs are
# canonically equivalent to another pair (U+2329/U+232A ≡ U+3008/U+3009).
_BRACKET_CANONICAL = {0x3008: 0x2329, 0x3009: 0x232A}

# DerivedBidiClass.txt @missing ranges — the class of a code point this
# interpreter's UCD does not know. Ordered; first containing range wins.
_DEFAULT_RANGES = (
    (0x0600, 0x07BF, "AL"), (0x0860, 0x08FF, "AL"), (0xFB50, 0xFDCF, "AL"),
    (0xFDF0, 0xFDFF, "AL"), (0xFE70, 0xFEFF, "AL"), (0x10D00, 0x10D3F, "AL"),
    (0x10EC0, 0x10EFF, "AL"), (0x10F30, 0x10F6F, "AL"), (0x1EC70, 0x1ECBF, "AL"),
    (0x1ED00, 0x1ED4F, "AL"), (0x1EE00, 0x1EEFF, "AL"),
    (0x0590, 0x05FF, "R"), (0x07C0, 0x085F, "R"), (0xFB1D, 0xFB4F, "R"),
    (0x10800, 0x10CFF, "R"), (0x10D40, 0x10EBF, "R"), (0x10F00, 0x10F2F, "R"),
    (0x10F70, 0x10FFF, "R"), (0x1E800, 0x1EC6F, "R"), (0x1ECC0, 0x1ECFF, "R"),
    (0x1ED50, 0x1EDFF, "R"), (0x1EF00, 0x1EFFF, "R"),
    (0x20A0, 0x20CF, "ET"),
)


def bidi_class(ch: str) -> str:
    """The character's Bidi_Class. `unicodedata` answers for every code point
    it knows; the DerivedBidiClass default ranges answer for the rest (a
    newer Unicode version's additions), which is what keeps an unknown
    Arabic-block character strong-RTL instead of silently L."""
    cls = unicodedata.bidirectional(ch)
    if cls:
        return cls
    cp = ord(ch)
    for lo, hi, default in _DEFAULT_RANGES:
        if lo <= cp <= hi:
            return default
    # Noncharacters and default-ignorables default to BN; everything else L.
    if (cp & 0xFFFE) == 0xFFFE or 0xFDD0 <= cp <= 0xFDEF:
        return "BN"
    return "L"


def has_strong_rtl(text: str) -> bool:
    """Any strong right-to-left character — the reflow's own trigger, and
    deliberately the SAME test the earlier refusal used."""
    return any(bidi_class(ch) in ("R", "AL") for ch in text)


# ── BD9: matching PDI for each isolate initiator ──────────────────────────


def _matching_pdi(classes: list[str]) -> dict[int, int]:
    """{isolate-initiator index → matching PDI index}, `len(classes)` when
    the initiator has none (BD9)."""
    n = len(classes)
    match: dict[int, int] = {}
    stack: list[int] = []
    for i, cls in enumerate(classes):
        if cls in _ISOLATE_INITIATORS:
            stack.append(i)
        elif cls == "PDI" and stack:
            match[stack.pop()] = i
    for i in stack:
        match[i] = n
    return match


def _first_strong_level(classes, matching_pdi, start: int, end: int) -> int:
    """P2/P3 over `classes[start:end]`, skipping isolated runs."""
    i = start
    while i < end:
        cls = classes[i]
        if cls == "L":
            return 0
        if cls in ("R", "AL"):
            return 1
        if cls in _ISOLATE_INITIATORS:
            i = matching_pdi.get(i, end)
            if i >= end:
                break
        i += 1
    return 0


def paragraph_level(text: str) -> int:
    """Rules P2/P3 — 0 when the first strong character is LTR (or there is
    none), 1 when it is RTL."""
    classes = [bidi_class(ch) for ch in text]
    return _first_strong_level(classes, _matching_pdi(classes), 0, len(classes))


# ── X1-X8: explicit levels and overrides ──────────────────────────────────


def _explicit_levels(classes, orig_classes, para_level, matching_pdi):
    n = len(classes)
    levels = [para_level] * n
    # (embedding level, override status 'N'|'L'|'R', is-isolate-status)
    stack = [(para_level, "N", False)]
    overflow_isolate = 0
    overflow_embedding = 0
    valid_isolate = 0

    def apply_last(i: int) -> None:
        level, override, _iso = stack[-1]
        levels[i] = level
        if override != "N":
            classes[i] = override

    for i in range(n):
        cls = orig_classes[i]
        if cls in ("RLE", "LRE", "RLO", "LRO"):
            # X2-X5. The formatting character itself takes the CURRENT level
            # (it is removed by X9, so this only matters to the BN-retention
            # reading of L1, which skips removed characters anyway).
            levels[i] = stack[-1][0]
            rtl = cls in ("RLE", "RLO")
            new_level = (stack[-1][0] + 1) | 1 if rtl else (stack[-1][0] + 2) & ~1
            override = "R" if cls == "RLO" else ("L" if cls == "LRO" else "N")
            if new_level <= MAX_DEPTH and not overflow_isolate and not overflow_embedding:
                stack.append((new_level, override, False))
            elif not overflow_isolate:
                overflow_embedding += 1
        elif cls in _ISOLATE_INITIATORS:
            # X5a/X5b/X5c — the initiator is a normal character at the
            # CURRENT level first, and only then raises the new one.
            if cls == "FSI":
                rtl = _first_strong_level(
                    orig_classes, matching_pdi, i + 1, matching_pdi.get(i, n)
                ) == 1
            else:
                rtl = cls == "RLI"
            apply_last(i)
            new_level = (stack[-1][0] + 1) | 1 if rtl else (stack[-1][0] + 2) & ~1
            if new_level <= MAX_DEPTH and not overflow_isolate and not overflow_embedding:
                valid_isolate += 1
                stack.append((new_level, "N", True))
            else:
                overflow_isolate += 1
        elif cls == "PDI":
            # X6a — close the innermost VALID isolate, discarding any
            # embeddings opened inside it.
            if overflow_isolate:
                overflow_isolate -= 1
            elif valid_isolate:
                overflow_embedding = 0
                while not stack[-1][2]:
                    stack.pop()
                stack.pop()
                valid_isolate -= 1
            apply_last(i)
        elif cls == "PDF":
            # X7 — never pops an isolate's entry.
            levels[i] = stack[-1][0]
            if overflow_isolate:
                pass
            elif overflow_embedding:
                overflow_embedding -= 1
            elif not stack[-1][2] and len(stack) >= 2:
                stack.pop()
        elif cls == "B":
            # X8 — a paragraph separator ends everything. (`resolve` is
            # single-paragraph by contract, so this is the terminator case.)
            stack = [(para_level, "N", False)]
            overflow_isolate = overflow_embedding = valid_isolate = 0
            levels[i] = para_level
        else:
            apply_last(i)
    return levels


# ── X10 / BD13: isolating run sequences ───────────────────────────────────


class _Sequence:
    """One isolating run sequence: the positions it covers (in order), its
    embedding level, and the sos/eos boundary types."""

    __slots__ = ("positions", "level", "sos", "eos")

    def __init__(self, positions, level, sos, eos):
        self.positions = positions
        self.level = level
        self.sos = sos
        self.eos = eos


def _direction(level: int) -> str:
    return "L" if level % 2 == 0 else "R"


def _isolating_run_sequences(orig_classes, levels, kept, para_level, matching_pdi):
    """BD13 + X10. `kept` is the ascending list of non-X9-removed indices."""
    # Level runs over the KEPT positions.
    runs: list[list[int]] = []
    for pos in kept:
        if runs and levels[runs[-1][-1]] == levels[pos]:
            runs[-1].append(pos)
        else:
            runs.append([pos])

    run_starting_at = {run[0]: ri for ri, run in enumerate(runs)}
    # A PDI's matching isolate initiator, so a run opening with a MATCHED PDI
    # is never taken as a sequence start (it continues its initiator's).
    matched_pdi = {v: k for k, v in matching_pdi.items() if v < len(orig_classes)}

    used = [False] * len(runs)
    sequences: list[_Sequence] = []
    for ri, run in enumerate(runs):
        if used[ri]:
            continue
        first = run[0]
        if orig_classes[first] == "PDI" and first in matched_pdi:
            continue  # continuation of another sequence, not a start
        positions: list[int] = []
        cursor = ri
        while True:
            used[cursor] = True
            positions.extend(runs[cursor])
            last = runs[cursor][-1]
            if orig_classes[last] not in _ISOLATE_INITIATORS:
                break
            pdi = matching_pdi.get(last, len(orig_classes))
            nxt = run_starting_at.get(pdi)
            if nxt is None or used[nxt]:
                break
            cursor = nxt
        level = levels[positions[0]]
        # sos: against the previous non-removed character, else the paragraph.
        prev_pos = _prev_kept(kept, positions[0])
        prev_level = levels[prev_pos] if prev_pos is not None else para_level
        sos = _direction(max(level, prev_level))
        # eos: an UNMATCHED isolate initiator at the end always faces the
        # paragraph level, whatever follows it in the text.
        last_pos = positions[-1]
        if (
            orig_classes[last_pos] in _ISOLATE_INITIATORS
            and matching_pdi.get(last_pos, len(orig_classes)) >= len(orig_classes)
        ):
            next_level = para_level
        else:
            next_pos = _next_kept(kept, last_pos)
            next_level = levels[next_pos] if next_pos is not None else para_level
        eos = _direction(max(levels[last_pos], next_level))
        sequences.append(_Sequence(positions, level, sos, eos))
    return sequences


def _prev_kept(kept: list[int], pos: int):
    lo, hi = 0, len(kept)
    while lo < hi:  # kept is ascending — locate `pos`, take its predecessor
        mid = (lo + hi) // 2
        if kept[mid] < pos:
            lo = mid + 1
        else:
            hi = mid
    return kept[lo - 1] if lo > 0 else None


def _next_kept(kept: list[int], pos: int):
    lo, hi = 0, len(kept)
    while lo < hi:
        mid = (lo + hi) // 2
        if kept[mid] <= pos:
            lo = mid + 1
        else:
            hi = mid
    return kept[lo] if lo < len(kept) else None


# ── W1-W7, N0-N2, I1-I2 ───────────────────────────────────────────────────


def _resolve_weak(seq: _Sequence, classes: list[str], orig_classes: list[str]) -> None:
    pos = seq.positions

    # W1 — NSM takes the previous type; after an isolate initiator or PDI, ON.
    prev = seq.sos
    for p in pos:
        if classes[p] == "NSM":
            classes[p] = "ON" if prev in _ISOLATE_INITIATORS or prev == "PDI" else prev
        prev = classes[p]

    # W2 — EN becomes AN when the last strong type before it is AL.
    strong = seq.sos
    for p in pos:
        cls = classes[p]
        if cls in ("L", "R", "AL"):
            strong = cls
        elif cls == "EN" and strong == "AL":
            classes[p] = "AN"

    # W3 — AL becomes R.
    for p in pos:
        if classes[p] == "AL":
            classes[p] = "R"

    # W4 — a single ES between two ENs, or a single CS between two numbers of
    # the same type, becomes that number type.
    for i in range(1, len(pos) - 1):
        cls = classes[pos[i]]
        if cls not in ("ES", "CS"):
            continue
        before, after = classes[pos[i - 1]], classes[pos[i + 1]]
        if before == "EN" and after == "EN":
            classes[pos[i]] = "EN"
        elif cls == "CS" and before == "AN" and after == "AN":
            classes[pos[i]] = "AN"

    # W5 — a run of ETs adjacent to an EN becomes EN.
    i = 0
    while i < len(pos):
        if classes[pos[i]] != "ET":
            i += 1
            continue
        j = i
        while j < len(pos) and classes[pos[j]] == "ET":
            j += 1
        before = classes[pos[i - 1]] if i > 0 else seq.sos
        after = classes[pos[j]] if j < len(pos) else seq.eos
        if before == "EN" or after == "EN":
            for k in range(i, j):
                classes[pos[k]] = "EN"
        i = j

    # W6 — remaining separators and terminators become ON.
    for p in pos:
        if classes[p] in ("ET", "ES", "CS"):
            classes[p] = "ON"

    # W7 — EN becomes L when the last strong type before it is L.
    strong = seq.sos
    for p in pos:
        cls = classes[p]
        if cls in ("L", "R"):
            strong = cls
        elif cls == "EN" and strong == "L":
            classes[p] = "L"

    del orig_classes


def _bracket_pairs(seq: _Sequence, classes, text) -> list[tuple[int, int]]:
    """BD16 — the sequence's bracket pairs, sorted by opening position. The
    63-element stack limit is the spec's, and overflowing STOPS pairing
    (it does not merely drop the deepest pair)."""
    stack: list[tuple[int, int]] = []  # (expected closing cp, sequence index)
    pairs: list[tuple[int, int]] = []
    for si, p in enumerate(seq.positions):
        if classes[p] != "ON":
            continue
        cp = ord(text[p])
        canon = _BRACKET_CANONICAL.get(cp, cp)
        if canon in _BRACKET_PAIRS:
            if len(stack) >= 63:
                return sorted(pairs)
            closing = _BRACKET_PAIRS[canon]
            stack.append((_BRACKET_CANONICAL.get(closing, closing), si))
        elif canon in _CLOSE_TO_OPEN:
            for depth in range(len(stack) - 1, -1, -1):
                if stack[depth][0] == canon:
                    pairs.append((stack[depth][1], si))
                    del stack[depth:]
                    break
    return sorted(pairs)


def _resolve_neutral(seq: _Sequence, classes, orig_classes, text) -> None:
    pos = seq.positions
    embedding = _direction(seq.level)
    opposite = "L" if embedding == "R" else "R"

    def strong_of(cls: str):
        if cls == "L":
            return "L"
        if cls in ("R", "EN", "AN"):
            return "R"
        return None

    # N0 — paired brackets.
    for open_i, close_i in _bracket_pairs(seq, classes, text):
        found_e = found_o = False
        for si in range(open_i + 1, close_i):
            s = strong_of(classes[pos[si]])
            if s == embedding:
                found_e = True
                break
            if s == opposite:
                found_o = True
        if found_e:
            new = embedding
        elif found_o:
            # Established context before the opening bracket.
            context = seq.sos
            for si in range(open_i - 1, -1, -1):
                s = strong_of(classes[pos[si]])
                if s is not None:
                    context = s
                    break
            new = opposite if context == opposite else embedding
        else:
            continue  # no strong type inside — the brackets stay neutral
        classes[pos[open_i]] = new
        classes[pos[close_i]] = new
        # Any NSM (by ORIGINAL type) directly following a bracket that
        # changed takes the bracket's new type.
        for si in (open_i, close_i):
            for sj in range(si + 1, len(pos)):
                if orig_classes[pos[sj]] != "NSM":
                    break
                classes[pos[sj]] = new

    # N1 — a run of NIs between matching directions takes that direction;
    # N2 — anything left takes the embedding direction.
    i = 0
    while i < len(pos):
        if classes[pos[i]] not in _NEUTRAL_OR_ISOLATE:
            i += 1
            continue
        j = i
        while j < len(pos) and classes[pos[j]] in _NEUTRAL_OR_ISOLATE:
            j += 1
        before = strong_of(classes[pos[i - 1]]) if i > 0 else seq.sos
        after = strong_of(classes[pos[j]]) if j < len(pos) else seq.eos
        new = before if (before is not None and before == after) else embedding
        for k in range(i, j):
            classes[pos[k]] = new
        i = j


def _resolve_implicit(seq: _Sequence, classes, levels) -> None:
    for p in seq.positions:
        cls = classes[p]
        level = levels[p]
        if level % 2 == 0:  # I1
            if cls == "R":
                levels[p] = level + 1
            elif cls in ("AN", "EN"):
                levels[p] = level + 2
        else:  # I2
            if cls in ("L", "AN", "EN"):
                levels[p] = level + 1


# ── the entry points ──────────────────────────────────────────────────────


def resolve(text: str, base_level: int | None = None):
    """(paragraph level, levels) for ONE paragraph AND ONE line — rule L1's
    line-end whitespace reset is included, which is what "resolved levels"
    means in `BidiCharacterTest.txt` field 3. `levels[i]` is None for a
    character rule X9 removes. `base_level` forces the paragraph direction
    (0 or 1); None applies P2/P3."""
    orig_classes = [bidi_class(ch) for ch in text]
    matching_pdi = _matching_pdi(orig_classes)
    if base_level is None:
        para_level = _first_strong_level(orig_classes, matching_pdi, 0, len(orig_classes))
    else:
        para_level = 1 if base_level else 0
    if not text:
        return para_level, []

    classes = list(orig_classes)
    levels = _explicit_levels(classes, orig_classes, para_level, matching_pdi)
    kept = [i for i, cls in enumerate(orig_classes) if cls not in _REMOVED_BY_X9]
    if kept:
        for seq in _isolating_run_sequences(
            orig_classes, levels, kept, para_level, matching_pdi
        ):
            _resolve_weak(seq, classes, orig_classes)
            _resolve_neutral(seq, classes, orig_classes, text)
            _resolve_implicit(seq, classes, levels)

    out: list[int | None] = [None] * len(text)
    for i in kept:
        out[i] = levels[i]
    _apply_l1(orig_classes, out, para_level)
    return para_level, out


_L1_WHITESPACE = frozenset(("WS", "FSI", "LRI", "RLI", "PDI"))


def _apply_l1(orig_classes, levels, para_level) -> None:
    """Rule L1 — segment/paragraph separators, the whitespace-or-isolate runs
    that PRECEDE one, and the run at the line's end all return to the
    paragraph level. Uses the ORIGINAL types, per the rule; X9-removed
    characters are transparent (they neither reset nor break a run — the
    spec's BN-retention note)."""
    in_run = True  # walking backwards, we start at the end of the line
    for i in range(len(orig_classes) - 1, -1, -1):
        cls = orig_classes[i]
        if cls in _REMOVED_BY_X9:
            continue
        if cls in ("B", "S"):
            if levels[i] is not None:
                levels[i] = para_level
            in_run = True
        elif cls in _L1_WHITESPACE:
            if in_run and levels[i] is not None:
                levels[i] = para_level
        else:
            in_run = False


def _reorder(levels_kept: list[int], para_level: int) -> list[int]:
    """Rule L2 over already-L1-adjusted levels; returns the permutation of
    `range(len(levels_kept))` in visual (left-to-right) order."""
    if not levels_kept:
        return []
    order = list(range(len(levels_kept)))
    highest = max(levels_kept)
    lowest_odd = min((lvl | 1) for lvl in levels_kept)
    for level in range(highest, lowest_odd - 1, -1):
        i = 0
        while i < len(order):
            if levels_kept[order[i]] < level:
                i += 1
                continue
            j = i
            while j < len(order) and levels_kept[order[j]] >= level:
                j += 1
            order[i:j] = reversed(order[i:j])
            i = j
    del para_level
    return order


def visual_order(text: str, base_level: int | None = None):
    """(paragraph level, indices of `text` in visual left-to-right order).
    X9-removed characters are absent from the result — the convention
    `BidiCharacterTest.txt` field 4 uses."""
    para_level, levels = resolve(text, base_level)  # L1 already applied
    kept = [i for i, lvl in enumerate(levels) if lvl is not None]
    kept_levels = [levels[i] for i in kept]
    return para_level, [kept[k] for k in _reorder(kept_levels, para_level)]


def reorder_to_visual(items: list, base_level: int, key=None) -> list:
    """`items` in visual order, keyed by `key(item)` → the item's character
    (default: the item itself). The permutation travels with whatever the
    caller attached to each character — style, source run, measured width —
    which is the entire reason this module exposes indices rather than a
    reordered string. Items whose class rule X9 removes are DROPPED, so the
    caller must not hand in explicit formatting codes it needs back."""
    text = "".join((key(it) if key else it) for it in items)
    _level, order = visual_order(text, base_level)
    return [items[i] for i in order]


def reconstruct_logical(text_visual: str, base_level: int):
    """Indices of `text_visual` in LOGICAL order, under `base_level`.

    Bidi reordering is an INVOLUTION whenever only the paragraph level and
    one embedded level are in play (each rule-L2 reversal pass is its own
    inverse, and with two levels there is exactly one pass that moves
    anything) — which covers RTL text with embedded Latin words and numbers,
    i.e. the overwhelming majority of real documents. Deeper nesting is NOT
    an involution, so this is a CANDIDATE: `text_paragraphs` proves each one
    by re-running `visual_order` on the reconstruction and comparing against
    the visual text it actually observed, and refuses the paragraph when the
    two disagree. That turns the ambiguity of inverse-bidi from a silent
    corruption risk into an honest, narrow refusal."""
    _level, order = visual_order(text_visual, base_level)
    return order
