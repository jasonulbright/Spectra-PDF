"""The Python half of the shared field-script pin.

The SAME JSON drives tests/af-corpus.test.ts: the fill computes here and the
canvas previews there, so the two must answer alike or a Total the user watched
appear differs from the one the file was saved with.

Every expectation in the corpus was checked against the reference
implementation extracted from the AcroForm scripting host that ships, unused,
inside the pdf.js dependency — so a row that looks wrong is the reference being
reproduced, not a transcription error.
"""

import json
import pathlib

import pytest

from engine.afcalc import (
    DATE_FORMATS,
    TIME_FORMATS,
    as_stored,
    calculate,
    closure,
    format_display,
    run,
    unrunnable,
)
from engine.afscript import ENTRY_POINTS, recognize

CORPUS = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "af-corpus.json").read_text(encoding="utf-8")
)


def _scripts(raw: dict) -> tuple[dict, list[str]]:
    """The corpus' `{field: {trigger: js}}` recognized, plus the fields whose
    script this app does not run."""
    scripts: dict = {}
    unrecognized: list[str] = []
    for field, actions in raw.items():
        entry: dict = {}
        for trigger, js in actions.items():
            script = recognize(js)
            if script is None or unrunnable(script):
                unrecognized.append(field)
                continue
            entry[trigger] = script
        scripts[field] = entry
    return scripts, sorted(set(unrecognized))


@pytest.mark.parametrize("case", CORPUS["recognize"], ids=lambda c: c["name"])
def test_recognizes_what_the_corpus_names(case):
    assert recognize(case["js"]) == case["script"]


@pytest.mark.parametrize("case", CORPUS["format"], ids=lambda c: c["name"])
def test_format_shows_what_the_corpus_names(case):
    script = recognize(case["js"])
    assert script is not None
    assert as_stored(run(script, case["value"]).value) == case["shown"]


@pytest.mark.parametrize("case", CORPUS["keystroke"], ids=lambda c: c["name"])
def test_keystroke_commits_what_the_corpus_names(case):
    script = recognize(case["js"])
    assert script is not None
    event = run(script, case["value"])
    assert event.rc == case["ok"]
    assert as_stored(event.value) == case["stored"]
    problem = None if event.problem is None else {"kind": event.problem[0], "args": list(event.problem[1])}
    assert problem == case["problem"]


@pytest.mark.parametrize("case", CORPUS["validate"], ids=lambda c: c["name"])
def test_validate_decides_what_the_corpus_names(case):
    script = recognize(case["js"])
    assert script is not None
    event = run(script, case["value"])
    assert event.rc == case["ok"]
    problem = None if event.problem is None else {"kind": event.problem[0], "args": list(event.problem[1])}
    assert problem == case["problem"]


@pytest.mark.parametrize("case", CORPUS["evaluate"], ids=lambda c: c["name"])
def test_calculation_pass_computes_what_the_corpus_names(case):
    scripts, unrecognized = _scripts(case["scripts"])
    assert unrecognized == case["unrecognized"]
    changed = calculate(case["fields"], scripts, case["co"], case["terminals"])
    assert changed == case["expect"]
    shown = {
        name: format_display(scripts.get(name, {}).get("F"), value)
        for name, value in changed.items()
    }
    assert shown == case["shown"]


@pytest.mark.parametrize("case", CORPUS["closure"], ids=lambda c: c["name"])
def test_closure_reaches_what_the_corpus_names(case):
    scripts, _ = _scripts(case["scripts"])
    assert closure(case["typed"], scripts, case["co"], case["terminals"]) == case["transitive"]


@pytest.mark.parametrize("js", CORPUS["round_trip"])
def test_every_script_this_app_writes_its_own_recognizer_accepts(js):
    assert recognize(js) is not None


def test_the_corpus_covers_every_entry_point():
    """A new function cannot join the table without a corpus row — the same
    coverage contract field-spec-corpus.test.ts carries."""
    covered = {
        (recognize(case["js"]) or {}).get("fn")
        for case in CORPUS["recognize"]
        if case["script"] is not None
    }
    assert set(ENTRY_POINTS) - covered == set()
    assert "SFN" in covered


def test_the_corpus_pins_both_mask_tables():
    assert CORPUS["date_formats"] == DATE_FORMATS
    assert CORPUS["time_formats"] == TIME_FORMATS
    for index in range(len(DATE_FORMATS)):
        assert any(f"AFDate_Format({index});" == case["js"] for case in CORPUS["format"])
    for index in range(len(TIME_FORMATS)):
        assert any(f"AFTime_Format({index});" == case["js"] for case in CORPUS["format"])


def test_the_corpus_pins_every_separator_style():
    shown = {
        case["shown"]
        for case in CORPUS["format"]
        if case["name"].startswith("separator style")
    }
    assert shown == {"1,234.50", "1234.50", "1.234,50", "1234,50", "1'234.50"}
