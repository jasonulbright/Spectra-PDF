"""The `/AA` and `/A` action kinds that are DATA rather than code.

The corpus (``tests/fixtures/field-spec-corpus.json`` ``data_action_cases``)
pins what the writer emits and what the reader classifies back; this file pins
what the document then DOES — that a reset restores, that a show/hide changes
the annotation the page raster is drawn from, that an import fills and a
submission is BUILT, and that the edit door stays total without touching a
trigger it does not author.
"""

import json
import pathlib

import pikepdf
import pytest

from engine import fieldactions
from engine.form_authoring import FieldSpecError, add_form_fields, set_field_actions
from engine.formdata import parse_form_data
from engine.forms import (
    export_form_data,
    fill_form_fields,
    import_form_data,
    read_form_fields,
    reset_form_fields,
    set_widget_visibility,
)

CORPUS = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "field-spec-corpus.json").read_text(
        encoding="utf-8"
    )
)

#: Each corpus refusal condition in the engine's own English. The renderer half
#: maps the same condition names into catalog keys — the treatment `lock_cases`
#: already gets, so neither side reads the other's vocabulary.
REFUSAL_TEXT = {
    "goto_page_out_of_range": "which is outside this document",
    "unknown_field": "which this document does not have",
    "no_address": "needs an address",
    "unknown_format": "unknown submission format",
    "no_targets": "needs a field to act on",
    "no_import_file": "needs a file to import",
    "duplicate_trigger": "two actions on the same trigger",
    "unknown_trigger": "unknown trigger",
    "unknown_kind": "unknown action",
}


def _base(tmp_path):
    src = tmp_path / "blank.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(src)
    out = str(tmp_path / "base.pdf")
    add_form_fields(
        str(src),
        out,
        [
            {"name": "Item1", "type": "text", "page_index": 0, "rect": [72, 700, 300, 716]},
            {"name": "Item2", "type": "text", "page_index": 0, "rect": [72, 660, 300, 676]},
            {"name": "Go", "type": "text", "page_index": 0, "rect": [72, 620, 300, 636]},
        ],
    )
    return out


def _actions_of(path, field="Go"):
    for entry in read_form_fields(path)["fields"]:
        if entry["name"] == field:
            return entry.get("field_actions", {})
    raise AssertionError(f"no field named {field}")


# ── the corpus ────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "case", CORPUS["data_action_cases"], ids=lambda c: c["name"]
)
def test_authored_data_actions_match_the_corpus(case, tmp_path):
    src = _base(tmp_path)
    out = str(tmp_path / "authored.pdf")
    if case.get("refuses"):
        with pytest.raises((FieldSpecError, ValueError)) as excinfo:
            set_field_actions(src, out, field="Go", actions=case["authored"])
        assert REFUSAL_TEXT[case["refuses"]] in str(excinfo.value)
        assert getattr(excinfo.value, "problems", [str(excinfo.value)]) == case["problems"]
        return
    set_field_actions(src, out, field="Go", actions=case["authored"])
    assert _actions_of(out) == case["read"]


def test_the_data_action_corpus_covers_every_kind_every_trigger_and_both_outcomes():
    rows = CORPUS["data_action_cases"]
    kinds = {a["kind"] for row in rows for a in row["authored"] if not row.get("refuses")}
    triggers = {a["trigger"] for row in rows for a in row["authored"] if not row.get("refuses")}
    assert kinds == set(fieldactions.AUTHORED_KINDS)
    assert triggers == set(fieldactions.TRIGGERS)
    assert {bool(row.get("refuses")) for row in rows} == {True, False}
    # Every refusal condition this module can raise has a row.
    assert {row["refuses"] for row in rows if row.get("refuses")} == set(REFUSAL_TEXT)


# ── the edit door ─────────────────────────────────────────────────────────


def test_the_data_half_is_total_and_an_omitted_trigger_is_removed(tmp_path):
    src = _base(tmp_path)
    both = str(tmp_path / "both.pdf")
    set_field_actions(
        src,
        both,
        field="Go",
        actions=[
            {"trigger": "A", "kind": "goto", "page": 1},
            {"trigger": "E", "kind": "hide", "targets": ["Item1"], "hide": True},
        ],
    )
    assert set(_actions_of(both)) == {"A", "E"}
    one = str(tmp_path / "one.pdf")
    set_field_actions(both, one, field="Go", actions=[{"trigger": "A", "kind": "goto", "page": 0}])
    assert set(_actions_of(one)) == {"A"}
    cleared = str(tmp_path / "cleared.pdf")
    set_field_actions(one, cleared, field="Go", clear=["actions"])
    assert _actions_of(cleared) == {}


def test_omitting_the_data_half_leaves_every_trigger_alone(tmp_path):
    """The two halves are independent: setting a format must not silently
    remove the button's action."""
    src = _base(tmp_path)
    with_action = str(tmp_path / "action.pdf")
    set_field_actions(
        src, with_action, field="Go", actions=[{"trigger": "A", "kind": "goto", "page": 1}]
    )
    formatted = str(tmp_path / "formatted.pdf")
    set_field_actions(
        with_action,
        formatted,
        field="Go",
        format={"kind": "date", "mask": "mm/dd/yy"},
        clear=["validate", "calculate"],
    )
    assert _actions_of(formatted) == {"A": {"kind": "goto", "page": 1}}


def test_a_trigger_this_app_does_not_author_is_left_untouched(tmp_path):
    """A `/Named` action and a script are not this door's business; rewriting
    the triggers it DOES author must not take them with it."""
    src = _base(tmp_path)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Dictionary) and str(obj.get("/T", "")) == "Item1":
                obj["/AA"] = pikepdf.Dictionary(
                    Fo=pikepdf.Dictionary(S=pikepdf.Name("/Named"), N=pikepdf.Name("/NextPage")),
                    C=pikepdf.Dictionary(
                        S=pikepdf.Name("/JavaScript"),
                        JS=pikepdf.String("this.getField('x').value='y';"),
                    ),
                )
        pdf.save(str(tmp_path / "seeded.pdf"))
    seeded = str(tmp_path / "seeded.pdf")
    out = str(tmp_path / "out.pdf")
    set_field_actions(
        seeded, out, field="Item1", actions=[{"trigger": "A", "kind": "goto", "page": 1}]
    )
    read = _actions_of(out, "Item1")
    # The /Named action was on a trigger this door authors, so the door's
    # totality removed it; the SCRIPT trigger is not one of them and survives.
    assert read == {"A": {"kind": "goto", "page": 1}}
    for entry in read_form_fields(out)["fields"]:
        if entry["name"] == "Item1":
            assert entry["actions"]["C"] == "this.getField('x').value='y';"
            assert entry["scripts_not_run"] == ["C"]


# ── running them ──────────────────────────────────────────────────────────


def test_show_and_hide_writes_the_annotation_flag_the_page_is_drawn_from(tmp_path):
    src = _base(tmp_path)
    hidden = str(tmp_path / "hidden.pdf")
    result = set_widget_visibility(src, hidden, targets=["Item2"], hide=True)
    assert result["changed"] == 1
    fields = {f["name"]: f for f in read_form_fields(hidden)["fields"]}
    assert [w["hidden"] for w in fields["Item2"]["widgets"]] == [True]
    assert [w["hidden"] for w in fields["Item1"]["widgets"]] == [False]

    shown = str(tmp_path / "shown.pdf")
    set_widget_visibility(hidden, shown, targets=["Item2"], hide=False)
    fields = {f["name"]: f for f in read_form_fields(shown)["fields"]}
    assert [w["hidden"] for w in fields["Item2"]["widgets"]] == [False]


def test_show_and_hide_reports_a_name_the_document_does_not_have(tmp_path):
    src = _base(tmp_path)
    out = str(tmp_path / "out.pdf")
    result = set_widget_visibility(src, out, targets=["Item1", "Nope"], hide=True)
    assert result["missing"] == ["Nope"]
    assert result["changed"] == 1
    with pytest.raises(ValueError, match="no form field named"):
        set_widget_visibility(src, out, targets=["Nope"], hide=True)


@pytest.mark.parametrize("fmt", ["fdf", "xfdf", "html"])
def test_a_submission_is_built_in_full(tmp_path, fmt):
    src = _base(tmp_path)
    filled = str(tmp_path / "filled.pdf")
    fill_form_fields(src, filled, {"Item1": "10", "Item2": "20"})
    out = tmp_path / f"submission.{fmt}"
    result = export_form_data(filled, str(out), format=fmt)
    assert result["count"] == 2
    if fmt == "html":
        assert out.read_bytes() == b"Item1=10&Item2=20"
    else:
        assert parse_form_data(str(out)) == {"Item1": "10", "Item2": "20"}


def test_a_pdf_submission_is_the_document_itself(tmp_path):
    src = _base(tmp_path)
    out = tmp_path / "submission.pdf"
    export_form_data(src, str(out), format="pdf")
    assert out.read_bytes() == pathlib.Path(src).read_bytes()


def test_a_submission_scopes_itself_and_can_carry_the_blanks(tmp_path):
    src = _base(tmp_path)
    filled = str(tmp_path / "filled.pdf")
    fill_form_fields(src, filled, {"Item1": "10"})
    only = tmp_path / "only.fdf"
    export_form_data(filled, str(only), fields=["Item1"])
    assert parse_form_data(str(only)) == {"Item1": "10"}

    everything = tmp_path / "all.fdf"
    export_form_data(filled, str(everything), include_empty=True)
    assert parse_form_data(str(everything)) == {"Item1": "10", "Item2": "", "Go": ""}

    without = tmp_path / "without.fdf"
    export_form_data(filled, str(without), fields=["Item1"], exclude=True, include_empty=True)
    assert parse_form_data(str(without)) == {"Item2": "", "Go": ""}


def test_an_unknown_submission_format_refuses_by_name(tmp_path):
    src = _base(tmp_path)
    with pytest.raises(ValueError, match="unknown submission format"):
        export_form_data(src, str(tmp_path / "x.csv"), format="csv")


def test_importing_data_fills_the_form_and_reports_what_it_could_not_place(tmp_path):
    src = _base(tmp_path)
    data = tmp_path / "data.fdf"
    from engine.formdata import write_fdf

    data.write_bytes(write_fdf({"Item1": "10", "Item2": "20", "Ghost": "x"}))
    out = str(tmp_path / "imported.pdf")
    result = import_form_data(src, out, data=str(data))
    assert result["imported"] == 2
    assert result["unknown"] == ["Ghost"]
    values = {f["name"]: f["value"] for f in read_form_fields(out)["fields"]}
    assert values["Item1"] == "10"
    assert values["Item2"] == "20"


def test_an_import_round_trips_a_submission_this_app_built(tmp_path):
    """The two halves are one format: what the submission writes, the import
    reads."""
    src = _base(tmp_path)
    filled = str(tmp_path / "filled.pdf")
    fill_form_fields(src, filled, {"Item1": "10", "Item2": "20"})
    for fmt in ("fdf", "xfdf"):
        payload = tmp_path / f"payload.{fmt}"
        export_form_data(filled, str(payload), format=fmt)
        out = str(tmp_path / f"back-{fmt}.pdf")
        import_form_data(src, out, data=str(payload))
        values = {f["name"]: f["value"] for f in read_form_fields(out)["fields"]}
        assert values["Item1"] == "10"
        assert values["Item2"] == "20"


def test_an_import_scopes_itself(tmp_path):
    src = _base(tmp_path)
    from engine.formdata import write_fdf

    data = tmp_path / "data.fdf"
    data.write_bytes(write_fdf({"Item1": "10", "Item2": "20"}))
    out = str(tmp_path / "imported.pdf")
    import_form_data(src, out, data=str(data), fields=["Item1"])
    values = {f["name"]: f["value"] for f in read_form_fields(out)["fields"]}
    assert values["Item1"] == "10"
    assert values["Item2"] == ""


def test_an_import_that_names_no_file_refuses(tmp_path):
    src = _base(tmp_path)
    with pytest.raises(ValueError, match="Name the form-data file"):
        import_form_data(src, str(tmp_path / "out.pdf"), data="")


def test_a_reset_action_runs_through_the_same_scope_the_document_declares(tmp_path):
    """`/ResetForm`'s `/Fields` + `/Flags` bit 1 are the two shapes the reader
    reports, and the runner takes them verbatim."""
    src = _base(tmp_path)
    defaults = str(tmp_path / "defaults.pdf")
    set_field_actions(src, defaults, field="Item1", default_value="7")
    filled = str(tmp_path / "filled.pdf")
    fill_form_fields(defaults, filled, {"Item1": "10", "Item2": "20"})

    scoped = str(tmp_path / "scoped.pdf")
    reset_form_fields(filled, scoped, fields=["Item1"])
    values = {f["name"]: f["value"] for f in read_form_fields(scoped)["fields"]}
    assert values["Item1"] == "7"
    assert values["Item2"] == "20"

    inverted = str(tmp_path / "inverted.pdf")
    reset_form_fields(filled, inverted, fields=["Item1"], exclude=True)
    values = {f["name"]: f["value"] for f in read_form_fields(inverted)["fields"]}
    assert values["Item1"] == "10"
    assert values["Item2"] == ""


# ── reading what a document already carries ───────────────────────────────


def test_an_action_kind_this_app_does_not_run_is_reported_not_dropped(tmp_path):
    src = _base(tmp_path)
    out = str(tmp_path / "seeded.pdf")
    with pikepdf.open(src) as pdf:
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Dictionary) and str(obj.get("/T", "")) == "Go":
                obj["/A"] = pikepdf.Dictionary(
                    S=pikepdf.Name("/Named"), N=pikepdf.Name("/NextPage")
                )
                obj["/AA"] = pikepdf.Dictionary(
                    U=pikepdf.Dictionary(
                        S=pikepdf.Name("/GoToR"), F=pikepdf.String("other.pdf")
                    ),
                    D=pikepdf.Dictionary(S=pikepdf.Name("/Movie")),
                )
        pdf.save(out)
    assert _actions_of(out) == {
        "A": {"kind": "named", "name": "NextPage"},
        "U": {"kind": "remote", "file": "other.pdf"},
        "D": {"kind": "other", "action": "Movie"},
    }


def test_a_destination_the_document_no_longer_reaches_reports_no_page(tmp_path):
    src = _base(tmp_path)
    authored = str(tmp_path / "authored.pdf")
    set_field_actions(src, authored, field="Go", actions=[{"trigger": "A", "kind": "goto", "page": 1}])
    out = str(tmp_path / "onepage.pdf")
    with pikepdf.open(authored) as pdf:
        del pdf.pages[1]
        pdf.save(out)
    assert _actions_of(out) == {"A": {"kind": "goto", "page": None}}


def test_a_named_destination_resolves_through_the_name_tree(tmp_path):
    src = _base(tmp_path)
    out = str(tmp_path / "named-dest.pdf")
    with pikepdf.open(src) as pdf:
        dest = pikepdf.Array([pdf.pages[1].obj, pikepdf.Name("/Fit")])
        pdf.Root["/Names"] = pdf.make_indirect(
            pikepdf.Dictionary(
                Dests=pdf.make_indirect(
                    pikepdf.Dictionary(Names=pikepdf.Array([pikepdf.String("Second"), dest]))
                )
            )
        )
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Dictionary) and str(obj.get("/T", "")) == "Go":
                obj["/A"] = pikepdf.Dictionary(
                    S=pikepdf.Name("/GoTo"), D=pikepdf.String("Second")
                )
        pdf.save(out)
    assert _actions_of(out) == {"A": {"kind": "goto", "page": 1}}


def test_a_reset_scoped_by_object_reference_reports_the_field_it_names(tmp_path):
    """`/Fields` entries are names OR references to the field objects; both
    resolve to a NAME, because a name is what a reset addresses a field by."""
    src = _base(tmp_path)
    out = str(tmp_path / "refscope.pdf")
    with pikepdf.open(src) as pdf:
        target = None
        button = None
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Dictionary):
                if str(obj.get("/T", "")) == "Item1":
                    target = obj
                elif str(obj.get("/T", "")) == "Go":
                    button = obj
        button["/A"] = pikepdf.Dictionary(
            S=pikepdf.Name("/ResetForm"), Fields=pikepdf.Array([target])
        )
        pdf.save(out)
    assert _actions_of(out) == {
        "A": {"kind": "reset", "fields": ["Item1"], "exclude": False}
    }
