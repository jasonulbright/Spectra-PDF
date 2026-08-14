"""Detected candidates becoming real fields, by path.

The corpus this reads is shared with the renderer's own spec builder: two
implementations of one grouping rule drift the moment nothing compares them.
The end-to-end pins are the ones a folder run depends on — what the detector
offers is what gets created, and a second run over the first run's output
creates nothing, because the detector subtracts widgets a file already carries.
"""

import json
import pathlib

import pikepdf
import pytest

from engine.acroform import calculation_order_names, form_field_forest
from engine.afscript import recognize
from engine.document_js import decode_js
from engine.fieldmdp import lock_of_field_dict
from engine.form_authoring import FieldSpecError, add_form_fields
from engine.form_detect import detect_form_fields
from engine.form_prepare import (
    create_detected_fields,
    prepare_form_fields,
    specs_from_candidates,
)
from engine.forms import read_form_fields

CORPUS = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "field-spec-corpus.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("case", CORPUS["cases"], ids=lambda c: c["name"])
def test_candidates_become_the_specs_the_corpus_names(case):
    assert specs_from_candidates(case["candidates"], case["existing"]) == case["specs"]


# ── the /Lock half of the same pin ────────────────────────────────────────

# The wording each corpus condition carries on THIS side. The renderer states
# the same conditions through its own catalog keys; only the condition crosses.
LOCK_REFUSAL_TEXT = {
    "lock_not_signature": "only a signature field can lock form fields",
    "lock_needs_fields": "needs at least one field name",
    "lock_takes_no_fields": "takes no field names",
    "lock_unknown_field": "has no form field named",
    "lock_self": "cannot lock itself",
}


def _lock_base(path, existing):
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(str(path))
    if not existing:
        return str(path)
    specs = [
        {
            "name": name,
            "type": "text",
            "page_index": 0,
            "rect": [72.0, 700.0 - index * 24, 300.0, 714.0 - index * 24],
        }
        for index, name in enumerate(existing)
    ]
    add_form_fields(str(path), str(path), specs)
    return str(path)


@pytest.mark.parametrize("case", CORPUS["lock_cases"], ids=lambda c: c["name"])
def test_authored_locks_match_the_corpus(case, tmp_path):
    src = _lock_base(tmp_path / "base.pdf", case["existing"])
    out = str(tmp_path / "locked.pdf")
    if case.get("refuses"):
        with pytest.raises(FieldSpecError) as excinfo:
            add_form_fields(src, out, case["specs"])
        assert LOCK_REFUSAL_TEXT[case["refuses"]] in str(excinfo.value)
        return
    add_form_fields(src, out, case["specs"])
    with pikepdf.open(out) as pdf:
        forest = form_field_forest(pdf)
        for name, expected in case["locks"].items():
            assert lock_of_field_dict(forest[name]) == expected


# ── end to end ────────────────────────────────────────────────────────────

RULED_LABELS = ("First name:", "Last name:", "Email address:", "Telephone:")


def _ruled(path):
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name("/Helvetica"),
            Encoding=pikepdf.Name.WinAnsiEncoding,
        )
    )
    lines = []
    y = 700
    for label in RULED_LABELS:
        lines.append(f"BT /F1 11 Tf 72 {y + 3} Td ({label}) Tj ET")
        lines.append(f"0.7 w 170 {y} m 520 {y} l S")
        y -= 40
    page = pikepdf.Dictionary(
        Type=pikepdf.Name.Page,
        MediaBox=pikepdf.Array([0, 0, 612, 792]),
        Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
        Contents=pdf.make_stream("\n".join(lines).encode("latin-1")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(str(path))
    return str(path)


def _names(path):
    return [f["name"] for f in read_form_fields(path)["fields"]]


def test_preparing_a_ruled_form_creates_one_field_per_labelled_rule(tmp_path):
    src = _ruled(tmp_path / "ruled.pdf")
    out = str(tmp_path / "out.pdf")
    result = prepare_form_fields(src, out, scan="never")
    assert result["candidates"] == 4
    assert result["created"] == 4
    assert _names(out) == ["First_name", "Last_name", "Email_address", "Telephone"]


def test_a_second_run_over_the_first_runs_output_creates_nothing(tmp_path):
    src = _ruled(tmp_path / "ruled.pdf")
    once = str(tmp_path / "once.pdf")
    twice = str(tmp_path / "twice.pdf")
    prepare_form_fields(src, once, scan="never")
    again = prepare_form_fields(once, twice, scan="never")
    # The detector subtracts the widgets the file already carries, so a
    # re-run must not double every field -- and must report why it offered
    # nothing rather than looking like it found nothing.
    assert again["created"] == 0
    assert again["existing_fields"] == 4
    assert any(row["reason"] == "covered_by_existing_field" for row in again["unoffered"])
    assert _names(twice) == ["First_name", "Last_name", "Email_address", "Telephone"]


def test_a_narrowed_run_creates_only_the_kinds_it_names(tmp_path):
    src = _ruled(tmp_path / "ruled.pdf")
    out = str(tmp_path / "out.pdf")
    result = prepare_form_fields(src, out, scan="never", kinds=["checkbox"])
    assert result["created"] == 0
    assert _names(out) == []


def test_an_unknown_kind_refuses(tmp_path):
    src = _ruled(tmp_path / "ruled.pdf")
    with pytest.raises(ValueError) as excinfo:
        prepare_form_fields(src, str(tmp_path / "out.pdf"), scan="never", kinds=["sausage"])
    assert "unknown field kind" in str(excinfo.value)


def test_a_run_that_finds_nothing_still_writes_the_output_it_named(tmp_path):
    blank = tmp_path / "blank.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(str(blank))
    out = tmp_path / "mirror" / "blank.pdf"
    result = prepare_form_fields(str(blank), str(out), scan="never")
    assert result["created"] == 0
    assert out.exists()


def test_only_the_reviewed_rows_are_created(tmp_path):
    src = _ruled(tmp_path / "ruled.pdf")
    detected = detect_form_fields(src, scan="never")
    kept = [row for row in detected["candidates"] if row["name"] != "Telephone"]
    out = str(tmp_path / "out.pdf")
    result = create_detected_fields(src, out, kept)
    assert result["candidates"] == 3
    assert _names(out) == ["First_name", "Last_name", "Email_address"]


def test_reviewed_rows_are_named_around_the_documents_own_fields(tmp_path):
    src = _ruled(tmp_path / "ruled.pdf")
    detected = detect_form_fields(src, scan="never")
    once = str(tmp_path / "once.pdf")
    create_detected_fields(src, once, detected["candidates"][:1])
    twice = str(tmp_path / "twice.pdf")
    # The same rows against a document that now carries the first field: the
    # duplicate name would refuse the whole write.
    create_detected_fields(once, twice, detected["candidates"][:1])
    assert _names(twice) == ["First_name", "First_name_2"]


def test_a_row_naming_a_page_the_document_does_not_have_refuses(tmp_path):
    src = _ruled(tmp_path / "ruled.pdf")
    detected = detect_form_fields(src, scan="never")
    row = dict(detected["candidates"][0])
    row["page"] = 9
    with pytest.raises(FieldSpecError):
        create_detected_fields(src, str(tmp_path / "out.pdf"), [row])


# ── the /AA + /CO half of the same pin ────────────────────────────────────

# The wording each corpus condition carries on THIS side; the renderer states
# the same conditions through its own catalog keys.
ACTION_REFUSAL_TEXT = {
    "calc_cycle": "depends on itself through",
    "calc_unknown_field": "which this document does not have",
    "format_kind_only": "belongs to a text or dropdown field",
    "calculate_kind_only": "belongs to a text field",
    "range_needs_bound": "a smallest value, a largest value, or both",
}


def _authored_actions(path):
    """{field: {trigger: raw /JS}}, the /DV each field carries, and the /CO."""
    actions = {}
    defaults = {}
    with pikepdf.open(path) as pdf:
        for name, node in form_field_forest(pdf).items():
            aa = node.get("/AA")
            if aa is not None and isinstance(aa, pikepdf.Dictionary):
                entry = {}
                for key in ("/F", "/K", "/V", "/C"):
                    action = aa.get(key)
                    if action is None:
                        continue
                    js = decode_js(action)
                    if js is not None:
                        entry[key[1:]] = js
                if entry:
                    actions[name] = entry
            dv = node.get("/DV")
            if dv is not None:
                defaults[name] = str(dv)
        return actions, defaults, calculation_order_names(pdf)


@pytest.mark.parametrize("case", CORPUS["action_cases"], ids=lambda c: c["name"])
def test_authored_actions_match_the_corpus(case, tmp_path):
    src = _lock_base(tmp_path / "base.pdf", case["existing"])
    out = str(tmp_path / "authored.pdf")
    if case.get("refuses"):
        with pytest.raises(FieldSpecError) as excinfo:
            add_form_fields(src, out, case["specs"])
        assert ACTION_REFUSAL_TEXT[case["refuses"]] in str(excinfo.value)
        assert excinfo.value.problems == case["problems"]
        return
    add_form_fields(src, out, case["specs"])
    actions, defaults, order = _authored_actions(out)
    assert actions == case["actions"]
    assert order == case["co"]
    assert defaults == case.get("defaults", {})
    # Every body this app writes is a body this app runs, and the fields it
    # names are the ones /CO ordered it after.
    for entry in actions.values():
        for js in entry.values():
            assert recognize(js) is not None


def test_the_action_corpus_covers_every_trigger_and_both_outcomes():
    triggers = {
        trigger
        for case in CORPUS["action_cases"]
        for entry in (case.get("actions") or {}).values()
        for trigger in entry
    }
    assert triggers == {"F", "K", "V", "C"}
    assert {bool(case.get("refuses")) for case in CORPUS["action_cases"]} == {True, False}
