"""A form that already calculates, calculating.

The corpus (tests/test_afcalc.py) pins the semantics; this file pins what they
do to a real document: the raw value in /V against the formatted one in /AP, a
read-only Total reached through /CO, an unrecognized script leaving its
neighbours computing, and the closure a signed document's field lock has to be
asked about.

Authoring /AA and /CO is a later feature set, so these fixtures write them with
pikepdf directly — which is also the honest shape of the row, since every form
this slice serves was authored somewhere else.
"""

import pathlib

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.afcalc import closure
from engine.afscript import recognize
from engine.form_authoring import add_form_fields
from engine.forms import fill_form_fields, read_form_fields


FF_READ_ONLY = 1 << 0


def _text_spec(name: str, y: float) -> dict:
    return {"name": name, "type": "text", "page_index": 0, "rect": [50.0, y, 250.0, y + 20.0]}


def _field_by_name(pdf: pikepdf.Pdf, name: str):
    for node in pdf.Root.AcroForm.Fields:
        if str(node.get("/T")) == name:
            return node
    raise AssertionError(f"no field {name}")


def _script(pdf: pikepdf.Pdf, js: str) -> Dictionary:
    return pdf.make_indirect(Dictionary(S=Name.JavaScript, JS=String(js)))


def _author(path: pathlib.Path, base: str, specs, scripts: dict, order, read_only=()) -> None:
    """Create `specs`, then attach `{field: {trigger: js}}`, a /CO, and the
    read-only flag a calculated Total routinely carries."""
    add_form_fields(base, str(path), specs)
    with pikepdf.open(str(path), allow_overwriting_input=True) as pdf:
        for name, actions in scripts.items():
            node = _field_by_name(pdf, name)
            aa = Dictionary()
            for key, js in actions.items():
                aa[key] = _script(pdf, js)
            node["/AA"] = aa
        for name in read_only:
            node = _field_by_name(pdf, name)
            node["/Ff"] = int(node.get("/Ff", 0)) | FF_READ_ONLY
        if order is not None:
            pdf.Root.AcroForm["/CO"] = Array([_field_by_name(pdf, n) for n in order])
        pdf.save(str(path) + ".tmp")
    pathlib.Path(str(path) + ".tmp").replace(path)


SUM3 = 'AFSimple_Calculate("SUM", "Item1,Item2,Item3");'
MONEY = 'AFNumber_Format(2, 0, 0, 0, "", true);'


@pytest.fixture
def calc_form(sample_pdf, tmp_path):
    """Three line items and a read-only Total that sums them, formatted."""
    path = tmp_path / "calc.pdf"
    _author(
        path,
        sample_pdf,
        [
            _text_spec("Item1", 700),
            _text_spec("Item2", 660),
            _text_spec("Item3", 620),
            _text_spec("Total", 560),
        ],
        {"Total": {"/C": SUM3, "/F": MONEY}},
        ["Total"],
        read_only=["Total"],
    )
    return path


def _values(path) -> dict:
    return {f["name"]: f["value"] for f in read_form_fields(str(path))["fields"]}


def _appearance(path, name: str) -> str:
    with pikepdf.open(str(path)) as pdf:
        node = _field_by_name(pdf, name)
        widget = node if node.get("/Subtype") == Name.Widget else node.Kids[0]
        return bytes(widget.AP.N.read_bytes()).decode("latin-1")


def test_filling_a_line_item_computes_the_total(calc_form, tmp_path):
    out = tmp_path / "filled.pdf"
    result = fill_form_fields(str(calc_form), str(out), {"Item1": "10", "Item2": "20"})
    assert result["calculated"] == ["Total"]
    assert _values(out)["Total"] == "30"


def test_the_stored_value_is_raw_and_the_appearance_is_formatted(calc_form, tmp_path):
    out = tmp_path / "filled.pdf"
    fill_form_fields(str(calc_form), str(out), {"Item1": "1234.5"})
    # /V keeps the number a consumer (and the next calculation) needs.
    assert _values(out)["Total"] == "1234.5"
    # /AP draws what every other viewer shows.
    assert "(1,234.50) Tj" in _appearance(out, "Total")


def test_a_read_only_total_is_computed_but_never_filled_by_name(calc_form, tmp_path):
    out = tmp_path / "filled.pdf"
    fill_form_fields(str(calc_form), str(out), {"Item1": "5"})
    assert _values(out)["Total"] == "5"
    with pytest.raises(ValueError, match="field is read-only: Total"):
        fill_form_fields(str(calc_form), str(tmp_path / "x.pdf"), {"Total": "999"})


def test_a_calculation_order_that_loops_terminates_in_one_pass(sample_pdf, tmp_path):
    path = tmp_path / "loop.pdf"
    _author(
        path,
        sample_pdf,
        [_text_spec("A", 700), _text_spec("B", 660), _text_spec("Seed", 620)],
        {"A": {"/C": "event.value = B + Seed;"}, "B": {"/C": "event.value = A + Seed;"}},
        ["A", "B"],
    )
    out = tmp_path / "filled.pdf"
    fill_form_fields(str(path), str(out), {"Seed": "1"})
    values = _values(out)
    assert values["A"] == "1"  # B was empty when A ran
    assert values["B"] == "2"  # A had already been computed


def test_an_unrecognized_script_is_reported_and_its_bytes_survive(sample_pdf, tmp_path):
    path = tmp_path / "custom.pdf"
    custom = "this.getField('Item1').value = 'y';"
    _author(
        path,
        sample_pdf,
        [_text_spec("Item1", 700), _text_spec("Item2", 660), _text_spec("Item3", 620),
         _text_spec("Total", 560), _text_spec("Custom", 520)],
        {"Total": {"/C": SUM3}, "Custom": {"/C": custom}},
        ["Custom", "Total"],
    )
    out = tmp_path / "filled.pdf"
    result = fill_form_fields(str(path), str(out), {"Item1": "10", "Item2": "20"})
    assert result["scripts_not_run"] == ["Custom"]
    assert _values(out)["Total"] == "30"  # the neighbours still computed
    with pikepdf.open(str(out)) as pdf:
        assert str(_field_by_name(pdf, "Custom").AA.C.JS) == custom


def test_calculations_without_a_declared_order_do_not_run(sample_pdf, tmp_path):
    path = tmp_path / "unordered.pdf"
    _author(
        path,
        sample_pdf,
        [_text_spec("Item1", 700), _text_spec("Item2", 660), _text_spec("Item3", 620),
         _text_spec("Total", 560)],
        {"Total": {"/C": SUM3}},
        None,
    )
    out = tmp_path / "filled.pdf"
    result = fill_form_fields(str(path), str(out), {"Item1": "10"})
    assert "calculated" not in result
    assert _values(out)["Total"] == ""
    assert read_form_fields(str(out))["calculation_order"] == []


def test_the_read_reports_the_scripts_and_the_order(calc_form):
    report = read_form_fields(str(calc_form))
    assert report["calculation_order"] == ["Total"]
    total = next(f for f in report["fields"] if f["name"] == "Total")
    assert total["calculated"] is True
    assert total["actions"] == {"C": SUM3, "F": MONEY}
    assert "scripts_not_run" not in total


def test_a_validate_script_refuses_the_value_and_writes_nothing(sample_pdf, tmp_path):
    path = tmp_path / "range.pdf"
    _author(
        path,
        sample_pdf,
        [_text_spec("Percent", 700)],
        {"Percent": {"/V": "AFRange_Validate(true, 0, true, 100);"}},
        None,
    )
    out = tmp_path / "filled.pdf"
    with pytest.raises(ValueError, match="outside the allowed range"):
        fill_form_fields(str(path), str(out), {"Percent": "150"})
    assert not out.exists()
    fill_form_fields(str(path), str(out), {"Percent": "50"})
    assert _values(out)["Percent"] == "50"


def test_a_keystroke_script_rewrites_a_comma_decimal(sample_pdf, tmp_path):
    path = tmp_path / "comma.pdf"
    _author(
        path,
        sample_pdf,
        [_text_spec("Amount", 700)],
        {"Amount": {"/K": 'AFNumber_Keystroke(2, 2, 0, 0, "", true);',
                    "/F": 'AFNumber_Format(2, 2, 0, 0, "", true);'}},
        None,
    )
    out = tmp_path / "filled.pdf"
    fill_form_fields(str(path), str(out), {"Amount": "1234,5"})
    assert _values(out)["Amount"] == "1234.5"
    assert "(1.234,50) Tj" in _appearance(out, "Amount")


def test_the_lock_closure_reaches_a_total_the_caller_never_named(calc_form):
    """The decision a signed document's /Lock is asked about must cover what
    the recalculation changes, not only what the caller typed."""
    report = read_form_fields(str(calc_form))
    scripts = {
        f["name"]: {t: recognize(js) for t, js in (f.get("actions") or {}).items()}
        for f in report["fields"]
    }
    terminals = [f["name"] for f in report["fields"]]
    assert closure(["Item1"], scripts, report["calculation_order"], terminals) == [
        "Item1",
        "Total",
    ]


def test_the_carried_calculation_order_still_computes_after_a_merge(calc_form, sample_pdf2, tmp_path):
    from engine.merge import merge

    merged = tmp_path / "merged.pdf"
    merge([str(calc_form), str(sample_pdf2)], str(merged))
    assert read_form_fields(str(merged))["calculation_order"] == ["Total"]
    out = tmp_path / "filled.pdf"
    fill_form_fields(str(merged), str(out), {"Item1": "7", "Item2": "3"})
    assert _values(out)["Total"] == "10"
