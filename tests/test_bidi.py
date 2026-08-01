"""UAX #9 conformance + the reflow-facing surface of engine/bidi.py."""

import os
import unicodedata

import pytest

from engine import bidi

FIXTURE = os.path.join(
    os.path.dirname(__file__), "fixtures", "BidiCharacterTest-sample.txt"
)

ARABIC = "مرحبا بالعالم"  # "hello world"
HEBREW = "שלום עולם"
MIXED = "قال PDF ثم توقف"  # Arabic with an embedded Latin word


def _cases():
    """(lineno, text, base, want_para, want_levels, want_order) per data line.

    Cases carrying a code point this interpreter's UCD has never heard of are
    skipped: the conformance file tracks a newer Unicode than CPython ships,
    and `bidi_class`'s default ranges are a floor, not a promise of the exact
    class a future assignment will get.
    """
    out = []
    with open(FIXTURE, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            fields = line.split(";")
            cps = [int(x, 16) for x in fields[0].split()]
            if any(unicodedata.category(chr(cp)) == "Cn" for cp in cps):
                continue
            direction = int(fields[1])
            out.append((
                lineno,
                "".join(chr(cp) for cp in cps),
                None if direction == 2 else direction,
                int(fields[2]),
                fields[3].split(),
                [int(x) for x in fields[4].split()] if fields[4].strip() else [],
            ))
    return out


CASES = _cases()


def test_fixture_is_substantial():
    # A silently-empty conformance fixture would make every check below pass.
    assert len(CASES) > 2000


def test_conformance_paragraph_levels():
    bad = [
        (ln, text) for ln, text, base, want, _l, _o in CASES
        if bidi.resolve(text, base)[0] != want
    ]
    assert not bad, f"{len(bad)} paragraph-level failures, first: {bad[:3]}"


def test_conformance_resolved_levels():
    bad = []
    for lineno, text, base, _want_para, want_levels, _order in CASES:
        _para, got = bidi.resolve(text, base)
        if len(got) != len(want_levels):
            bad.append((lineno, "length"))
            continue
        for want, have in zip(want_levels, got):
            if want == "x":
                if have is not None:
                    bad.append((lineno, f"expected removed, got {have}"))
                    break
            elif have is None or int(want) != have:
                bad.append((lineno, f"want {want} got {have}"))
                break
    assert not bad, f"{len(bad)} level failures, first: {bad[:3]}"


def test_conformance_visual_order():
    bad = []
    for lineno, text, base, _p, _l, want_order in CASES:
        _para, got = bidi.visual_order(text, base)
        if got != want_order:
            bad.append((lineno, want_order, got))
    assert not bad, f"{len(bad)} order failures, first: {bad[:3]}"


# ── the reflow-facing surface ─────────────────────────────────────────────


def test_has_strong_rtl_is_the_old_refusal_test():
    assert bidi.has_strong_rtl(ARABIC)
    assert bidi.has_strong_rtl(HEBREW)
    assert bidi.has_strong_rtl(MIXED)
    assert not bidi.has_strong_rtl("plain latin 123 (with punctuation)")
    # Digits alone are never strong — an Arabic-indic digit is AN, not R.
    assert not bidi.has_strong_rtl("١٢٣")


def test_paragraph_level_follows_the_first_strong_character():
    assert bidi.paragraph_level(ARABIC) == 1
    assert bidi.paragraph_level("PDF " + ARABIC) == 0
    assert bidi.paragraph_level(ARABIC + " PDF") == 1
    assert bidi.paragraph_level("123 456") == 0


def test_reorder_to_visual_carries_the_payload():
    # The whole reason this module returns indices: an arbitrary payload
    # travels with each character through the reordering.
    items = [(ch, i) for i, ch in enumerate(HEBREW)]
    visual = bidi.reorder_to_visual(items, 1, key=lambda it: it[0])
    assert "".join(ch for ch, _i in visual) == "".join(
        HEBREW[i] for i in bidi.visual_order(HEBREW, 1)[1]
    )
    # …and the payload is still the ORIGINAL logical index of that character.
    assert [i for _ch, i in visual] == bidi.visual_order(HEBREW, 1)[1]


@pytest.mark.parametrize("text", [ARABIC, HEBREW, MIXED, "abc " + HEBREW + " def"])
def test_reconstruct_logical_round_trips_two_level_text(text):
    base = bidi.paragraph_level(text)
    _p, order = bidi.visual_order(text, base)
    visual = "".join(text[i] for i in order)
    back = bidi.reconstruct_logical(visual, base)
    assert "".join(visual[i] for i in back) == text


def test_reconstruct_logical_is_a_candidate_not_a_promise():
    # Three levels (RTL base, Latin inside, Hebrew inside that) is where the
    # involution stops holding — the caller's verification exists for this.
    text = "אב abc דה ghi כל"
    base = 1
    _p, order = bidi.visual_order(text, base)
    visual = "".join(text[i] for i in order)
    back = bidi.reconstruct_logical(visual, base)
    rebuilt = "".join(visual[i] for i in back)
    # Whatever it produces, re-running the forward pass on it is the ONLY
    # honest test of the reconstruction — which is exactly the gate
    # text_paragraphs applies.
    _p2, fwd = bidi.visual_order(rebuilt, base)
    verified = "".join(rebuilt[i] for i in fwd) == visual
    assert verified == (rebuilt == text)


def test_removed_characters_are_absent_from_the_order():
    text = "a‫b‬c"  # RLE / PDF around 'b'
    _p, order = bidi.visual_order(text, 0)
    assert 1 not in order and 3 not in order
    assert sorted(order) == [0, 2, 4]


def test_empty_and_neutral_text():
    assert bidi.visual_order("", None) == (0, [])
    assert bidi.visual_order("   ", None) == (0, [0, 1, 2])
