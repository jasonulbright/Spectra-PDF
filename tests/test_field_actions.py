"""Authoring a field's Format, Accepted range and Calculate.

The corpus (``tests/fixtures/field-spec-corpus.json`` ``action_cases``) pins
what the writers EMIT; this file pins what the emitted document then DOES —
that a summed total computes, that a formatted value stores raw and draws
formatted, that the edit door is total, and that a reset restores what `/DV`
now finally carries.
"""

import pikepdf
import pytest

from engine.acroform import calculation_order_names, form_field_forest
from engine.document_js import decode_js
from engine.form_authoring import (
    FieldSpecError,
    add_form_fields,
    set_field_actions,
)
from engine.form_detect import detect_form_fields
from engine.form_prepare import prepare_form_fields
from engine.forms import fill_form_fields, read_form_fields, reset_form_fields

MONEY = {
    "kind": "number",
    "decimals": 2,
    "sep_style": 0,
    "neg_style": 0,
    "currency": "",
    "currency_prepend": True,
}


def _blank(path):
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(str(path))
    return str(path)


def _spec(name, y, **extra):
    row = {
        "name": name,
        "type": "text",
        "page_index": 0,
        "rect": [72.0, float(y), 300.0, float(y) + 16.0],
    }
    row.update(extra)
    return row


def _invoice(tmp_path):
    """Two line items and a money-formatted Total that sums them."""
    src = _blank(tmp_path / "blank.pdf")
    out = str(tmp_path / "invoice.pdf")
    add_form_fields(
        src,
        out,
        [
            _spec("Item1", 700),
            _spec("Item2", 670),
            _spec(
                "Total",
                640,
                format=MONEY,
                calculate={"op": "SUM", "fields": ["Item1", "Item2"]},
            ),
        ],
    )
    return out


def _field(path, name):
    return next(f for f in read_form_fields(path)["fields"] if f["name"] == name)


def _appearance(path, name):
    with pikepdf.open(path) as pdf:
        node = form_field_forest(pdf)[name]
        stream = node["/AP"]["/N"]
        return bytes(stream.read_bytes()).decode("latin-1")


# ── what the authored document does ───────────────────────────────────────


def test_an_authored_calculation_computes_when_the_form_is_filled(tmp_path):
    doc = _invoice(tmp_path)
    filled = str(tmp_path / "filled.pdf")
    result = fill_form_fields(doc, filled, {"Item1": "10", "Item2": "1234.5"})
    assert result["calculated"] == ["Total"]
    assert _field(filled, "Total")["value"] == "1244.5"


def test_an_authored_format_stores_the_raw_value_and_draws_the_formatted_one(tmp_path):
    doc = _invoice(tmp_path)
    filled = str(tmp_path / "filled.pdf")
    fill_form_fields(doc, filled, {"Item1": "10", "Item2": "1234.5"})
    # /V keeps the number the next calculation needs; /AP draws what every
    # other viewer shows.
    assert _field(filled, "Total")["value"] == "1244.5"
    assert "(1,244.50) Tj" in _appearance(filled, "Total")


def test_the_authored_calculation_order_puts_the_total_after_its_inputs(tmp_path):
    src = _blank(tmp_path / "blank.pdf")
    out = str(tmp_path / "chain.pdf")
    add_form_fields(
        src,
        out,
        [
            # Authored Grand-first: the sort is what puts Sub ahead of it, and
            # a /CO in the wrong order computes a stale value in every viewer.
            _spec("Grand", 700, calculate={"op": "SUM", "fields": ["Sub", "Item"]}),
            _spec("Sub", 670, calculate={"op": "SUM", "fields": ["Item"]}),
            _spec("Item", 640),
        ],
    )
    with pikepdf.open(out) as pdf:
        assert calculation_order_names(pdf) == ["Sub", "Grand"]
    filled = str(tmp_path / "filled.pdf")
    fill_form_fields(out, filled, {"Item": "5"})
    assert _field(filled, "Sub")["value"] == "5"
    assert _field(filled, "Grand")["value"] == "10"


def test_an_authored_range_refuses_a_value_outside_it(tmp_path):
    src = _blank(tmp_path / "blank.pdf")
    out = str(tmp_path / "rated.pdf")
    add_form_fields(src, out, [_spec("Rate", 700, validate={"min": 0, "max": 100})])
    with pytest.raises(ValueError) as excinfo:
        fill_form_fields(out, str(tmp_path / "filled.pdf"), {"Rate": "150"})
    assert "outside the allowed range" in str(excinfo.value)
    # And accepts one inside it.
    fill_form_fields(out, str(tmp_path / "ok.pdf"), {"Rate": "50"})


def test_an_authored_default_value_is_what_a_reset_restores(tmp_path):
    src = _blank(tmp_path / "blank.pdf")
    out = str(tmp_path / "defaulted.pdf")
    add_form_fields(src, out, [_spec("Rate", 700, default_value="5")])
    filled = str(tmp_path / "filled.pdf")
    fill_form_fields(out, filled, {"Rate": "42"})
    assert _field(filled, "Rate")["value"] == "42"
    reset = str(tmp_path / "reset.pdf")
    reset_form_fields(filled, reset)
    assert _field(reset, "Rate")["value"] == "5"


# ── the edit-an-existing-field door ───────────────────────────────────────


def _scripts(path, name):
    with pikepdf.open(path) as pdf:
        aa = form_field_forest(pdf)[name].get("/AA")
        if aa is None:
            return {}
        return {
            key[1:]: decode_js(aa[key])
            for key in ("/F", "/K", "/V", "/C")
            if aa.get(key) is not None
        }


def test_the_edit_door_sets_a_format_on_a_field_created_without_one(tmp_path):
    doc = _invoice(tmp_path)
    out = str(tmp_path / "edited.pdf")
    result = set_field_actions(doc, out, "Item1", format=MONEY)
    assert result["scripts"] == {
        "F": 'AFNumber_Format(2, 0, 0, 0, "", true);',
        "K": 'AFNumber_Keystroke(2, 0, 0, 0, "", true);',
    }
    assert _scripts(out, "Item1") == result["scripts"]


def test_the_edit_door_is_total_so_an_omitted_action_is_removed(tmp_path):
    doc = _invoice(tmp_path)
    out = str(tmp_path / "stripped.pdf")
    # Total carries a format AND a calculation; setting only the format must
    # leave no calculation behind, and must drop it from /CO with it.
    set_field_actions(doc, out, "Total", format=MONEY)
    assert set(_scripts(out, "Total")) == {"F", "K"}
    with pikepdf.open(out) as pdf:
        assert calculation_order_names(pdf) == []


def test_the_edit_door_leaves_a_trigger_it_does_not_author_untouched(tmp_path):
    doc = _invoice(tmp_path)
    with pikepdf.open(doc, allow_overwriting_input=True) as pdf:
        node = form_field_forest(pdf)["Item1"]
        node["/AA"] = pikepdf.Dictionary(
            E=pikepdf.Dictionary(
                S=pikepdf.Name("/JavaScript"), JS=pikepdf.String("app.alert('hi');")
            )
        )
        pdf.save(str(tmp_path / "hooked.pdf"))
    hooked = str(tmp_path / "hooked.pdf")
    out = str(tmp_path / "edited.pdf")
    set_field_actions(hooked, out, "Item1", format=MONEY)
    with pikepdf.open(out) as pdf:
        aa = form_field_forest(pdf)["Item1"]["/AA"]
        # A widget trigger is not this door's business.
        assert decode_js(aa["/E"]) == "app.alert('hi');"
        assert str(aa["/F"]["/S"]) == "/JavaScript"


def test_the_edit_door_refuses_a_calculation_that_would_cycle(tmp_path):
    doc = _invoice(tmp_path)
    with pytest.raises(FieldSpecError) as excinfo:
        set_field_actions(
            doc,
            str(tmp_path / "cycle.pdf"),
            "Item1",
            calculate={"op": "SUM", "fields": ["Total"]},
        )
    assert excinfo.value.problems == [
        "Item1: its calculation depends on itself through Item1 -> Total -> Item1"
    ]


def test_the_edit_door_refuses_a_calculation_naming_a_field_that_does_not_exist(tmp_path):
    doc = _invoice(tmp_path)
    with pytest.raises(FieldSpecError) as excinfo:
        set_field_actions(
            doc,
            str(tmp_path / "unknown.pdf"),
            "Item1",
            calculate={"op": "SUM", "fields": ["Nope"]},
        )
    assert 'names "Nope"' in str(excinfo.value)


def test_the_edit_door_refuses_a_field_the_document_does_not_have(tmp_path):
    doc = _invoice(tmp_path)
    with pytest.raises(ValueError) as excinfo:
        set_field_actions(doc, str(tmp_path / "x.pdf"), "Nope", format=MONEY)
    assert "no form field named" in str(excinfo.value)


def test_the_edit_door_adds_a_calculation_and_orders_it(tmp_path):
    src = _blank(tmp_path / "blank.pdf")
    plain = str(tmp_path / "plain.pdf")
    add_form_fields(src, plain, [_spec("A", 700), _spec("B", 670), _spec("Sum", 640)])
    out = str(tmp_path / "summed.pdf")
    result = set_field_actions(
        plain, out, "Sum", calculate={"op": "SUM", "fields": ["A", "B"]}
    )
    assert result["calculation_order"] == ["Sum"]
    filled = str(tmp_path / "filled.pdf")
    fill_form_fields(out, filled, {"A": "2", "B": "3"})
    assert _field(filled, "Sum")["value"] == "5"


# ── a detected date field lands with a date format ───────────────────────


def _dated_form(path):
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
    for label in ("Date of birth:", "Employer:"):
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


def test_a_detected_date_field_is_created_with_a_date_format(tmp_path):
    src = _dated_form(tmp_path / "dated.pdf")
    detected = detect_form_fields(src, scan="never")
    assert any(row["format"] == "date" for row in detected["candidates"])
    out = str(tmp_path / "prepared.pdf")
    prepare_form_fields(src, out, scan="never")
    assert _scripts(out, "Date_of_birth") == {
        "F": 'AFDate_FormatEx("mm/dd/yy");',
        "K": 'AFDate_KeystrokeEx("mm/dd/yy");',
    }
    # The hint only reaches a field it was made about.
    assert _scripts(out, "Employer") == {}


def test_a_detected_date_field_formats_the_value_a_fill_writes(tmp_path):
    src = _dated_form(tmp_path / "dated.pdf")
    out = str(tmp_path / "prepared.pdf")
    prepare_form_fields(src, out, scan="never")
    filled = str(tmp_path / "filled.pdf")
    fill_form_fields(out, filled, {"Date_of_birth": "1990-03-14"})
    assert _field(filled, "Date_of_birth")["value"] == "1990-03-14"
    assert "(03/14/90) Tj" in _appearance(filled, "Date_of_birth")
