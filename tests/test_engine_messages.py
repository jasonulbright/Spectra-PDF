"""N12 slice D — the gate over the engine refusal table (brief 37 § Slices D).

`src/renderer/locales/engine-messages.tsv` is a CHECKED-IN, reviewed table:
every user-facing refusal the engine raises, mapped to the stable catalog key
that renders it in the UI language. The renderer matches an incoming engine
message against it and localizes what it recognizes; anything else passes
through verbatim.

That only stays true if the table tracks the engine. These tests re-run the
sweep and fail the moment a refusal is added, reworded, moved or removed
without the table being regenerated — the same shape as the Tesseract notice
inventory's build-time refusal, and for the same reason: an inventory nobody
re-checks is an inventory that quietly stops being true.

    Regenerate:  .venv/Scripts/python.exe scripts/gen-engine-messages.py
    then review the diff and commit it.
"""

from __future__ import annotations

import pathlib
import re
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "scripts"))

from engine_message_sweep import (  # noqa: E402
    MIN_LITERAL_ANCHOR,
    PUBLIC_EXCEPTIONS,
    composed,
    inventory,
    literal_anchor,
    read_table,
    sweep,
)

REGENERATE = (
    "run `.venv/Scripts/python.exe scripts/gen-engine-messages.py`, "
    "review the diff and commit it"
)


@pytest.fixture(scope="module")
def table():
    return read_table()


@pytest.fixture(scope="module")
def live():
    return inventory()


def test_sweep_finds_the_engine(live):
    """A sweep that finds nothing would make every other test vacuously green."""
    assert len(live) > 250, "the AST sweep stopped seeing the engine's refusals"


def test_table_covers_every_live_refusal(table, live):
    """No refusal reaches the UI without a row (an unlocalized string)."""
    missing = sorted(set(live) - {row.message for row in table})
    assert not missing, (
        f"{len(missing)} engine refusal(s) are not in the table — {REGENERATE}\n"
        + "\n".join(f"  + [{','.join(live[m])}] {m!r}" for m in missing[:20])
    )


def test_table_has_no_dead_rows(table, live):
    """A row whose message the engine no longer raises is a dead translation."""
    stale = sorted({row.message for row in table} - set(live))
    assert not stale, (
        f"{len(stale)} table row(s) match no engine refusal — {REGENERATE}\n"
        + "\n".join(f"  - {m!r}" for m in stale[:20])
    )


def test_table_module_attribution_is_current(table, live):
    """The module column is part of the review; a moved refusal must show up."""
    drifted = [
        (row.key, row.modules, live[row.message])
        for row in table
        if row.message in live and row.modules != live[row.message]
    ]
    assert not drifted, (
        f"{len(drifted)} row(s) name the wrong module(s) — {REGENERATE}\n"
        + "\n".join(f"  {k}: table={t} live={l}" for k, t, l in drifted[:20])
    )


def test_keys_are_unique(table):
    seen: dict[str, str] = {}
    for row in table:
        assert row.key not in seen, (
            f"duplicate key {row.key!r} — two messages cannot share a catalog entry "
            f"({seen[row.key]!r} and {row.message!r})"
        )
        seen[row.key] = row.message


def test_keys_are_catalog_safe(table):
    for row in table:
        assert re.fullmatch(r"[a-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]+", row.key), (
            f"key {row.key!r} is not a `<module>.<slug>` catalog id"
        )


def test_kind_matches_the_message(table):
    for row in table:
        expected = "pattern" if "{{" in row.message else "exact"
        assert row.kind == expected, (
            f"{row.key}: kind={row.kind} but the message is {expected}"
        )


def test_patterns_carry_a_real_anchor(table):
    """A template that is mostly placeholder would match unrelated messages.

    Match order in the renderer is longest-literal-first, so a specific
    pattern always beats a general one — but a template with almost no
    literal text has no business in the table at all, and `inventory()`
    excludes that class. This asserts the exclusion held.
    """
    for row in table:
        if row.kind != "pattern":
            continue
        assert literal_anchor(row.message) >= MIN_LITERAL_ANCHOR, (
            f"{row.key}: only {literal_anchor(row.message)} literal characters — "
            "too thin to recognize; it belongs in the passthrough class"
        )


def test_placeholder_names_are_interpolatable(table):
    for row in table:
        for name in re.findall(r"\{\{([^}]*)\}\}", row.message):
            assert re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name), (
                f"{row.key}: placeholder {name!r} is not a usable interpolation name"
            )


def test_no_pattern_shadows_another(table):
    """Two templates must not be able to claim one message ambiguously.

    Longest-literal-first resolves overlap deterministically; what would NOT
    be resolvable is two DIFFERENT templates with the same literal length
    both matching one string. Assert no such pair exists by checking that no
    pattern matches another row's own rendered message.
    """
    def to_regex(message: str) -> re.Pattern[str]:
        parts = re.split(r"(\{\{[^}]*\}\})", message)
        return re.compile(
            "".join("(.+?)" if p.startswith("{{") else re.escape(p) for p in parts) + r"\Z"
        )

    patterns = [(row, to_regex(row.message)) for row in table if row.kind == "pattern"]
    for row in table:
        sample = re.sub(r"\{\{[^}]*\}\}", "SAMPLE", row.message)
        hits = [
            (other.key, literal_anchor(other.message))
            for other, rx in patterns
            if rx.match(sample)
        ]
        if len(hits) > 1:
            lengths = [n for _, n in hits]
            assert len(set(lengths)) == len(lengths), (
                f"{row.key}: {hits} match the same message with equal specificity — "
                "one of them needs a distinguishing literal"
            )


def test_composed_exclusions_are_named(table):
    """The excluded class is small and deliberate, not a silent gap."""
    excluded = composed()
    assert len(excluded) <= 3, (
        "the passthrough-only class grew — review whether these refusals can be "
        f"anchored instead: {list(excluded)}"
    )
    for message in excluded:
        assert message not in {row.message for row in table}


def test_internal_sentinels_are_not_swept():
    """A transplant refusal is a RESULT, never a message the user reads."""
    for refusal in sweep():
        assert refusal.exc in PUBLIC_EXCEPTIONS
