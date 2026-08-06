"""`add_form_fields` — creating AcroForm fields by path.

The pins here are the ones a reader of the output can check: a created field is
findable by name and type, its widget sits where the spec said, its flags mean
what the spec asked for, and a button carries an on-state appearance. The
validation pins are the fail-closed posture: every problem at once, nothing
written when any of them fails.
"""

import pathlib

import pikepdf
import pytest
from pikepdf import Array, Dictionary, String

from engine.form_authoring import FieldSpecError, add_form_fields, existing_field_names
from engine.forms import read_form_fields


def _blank(path, pages=1):
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(612, 792))
    pdf.save(str(path))
    return str(path)


def _text(name="Full_name", page=0, rect=None):
    return {
        "name": name,
        "type": "text",
        "page_index": page,
        "rect": rect or [72, 700, 400, 720],
    }


def _fields(path):
    return {f["name"]: f for f in read_form_fields(path)["fields"]}


def test_a_text_field_lands_with_its_rectangle_and_is_readable(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    result = add_form_fields(src, out, [_text()])
    assert result["created"] == 1
    fields = _fields(out)
    assert set(fields) == {"Full_name"}
    assert fields["Full_name"]["type"] == "text"
    widget = fields["Full_name"]["widgets"][0]
    assert widget["page"] == 0
    assert [round(v) for v in widget["rect"]] == [72, 700, 400, 720]


def test_every_created_widget_carries_an_appearance(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src,
        out,
        [
            _text(),
            {"name": "Agree", "type": "checkbox", "page_index": 0, "rect": [72, 600, 84, 612]},
        ],
    )
    with pikepdf.open(out) as pdf:
        for annot in pdf.pages[0].obj["/Annots"]:
            assert annot.get("/AP") is not None


def test_multiline_and_comb_flags_survive(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src,
        out,
        [
            {**_text("Comments"), "multiline": True},
            {**_text("Postcode", rect=[72, 500, 200, 520]), "comb": True, "max_length": 6},
        ],
    )
    fields = _fields(out)
    assert fields["Comments"]["multiline"] is True
    assert fields["Postcode"]["multiline"] is False
    with pikepdf.open(out) as pdf:
        by_name = {
            str(f["/T"]): f for f in pdf.Root["/AcroForm"]["/Fields"] if f.get("/T") is not None
        }
        assert int(by_name["Postcode"]["/MaxLen"]) == 6
        assert int(by_name["Postcode"]["/Ff"]) & (1 << 24)


def test_a_checkbox_starts_off_and_has_both_states(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src, out, [{"name": "Agree", "type": "checkbox", "page_index": 0, "rect": [72, 600, 84, 612]}]
    )
    assert _fields(out)["Agree"]["type"] == "checkbox"
    with pikepdf.open(out) as pdf:
        widget = pdf.pages[0].obj["/Annots"][0]
        assert str(widget["/AS"]) == "/Off"
        assert set(str(k) for k in widget["/AP"]["/N"].keys()) == {"/Yes", "/Off"}


def test_a_radio_group_is_one_field_with_a_widget_per_option(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src,
        out,
        [
            {
                "name": "Contact",
                "type": "radio",
                "page_index": 0,
                "rect": [72, 320, 301, 329],
                "options": [
                    {"label": "Email", "rect": [72, 320, 81, 329]},
                    {"label": "Phone", "rect": [182, 320, 191, 329]},
                    {"label": "Mail", "rect": [292, 320, 301, 329]},
                ],
            }
        ],
    )
    fields = _fields(out)
    assert fields["Contact"]["type"] == "radio"
    assert fields["Contact"]["options"] == ["Email", "Phone", "Mail"]
    widgets = fields["Contact"]["widgets"]
    assert len(widgets) == 3
    # Each option was drawn where the form drew it: equal cells of the group's
    # enclosing rectangle would put the second option at x=148, not x=182.
    assert [round(w["rect"][0]) for w in widgets] == [72, 182, 292]


def test_an_option_label_a_name_cannot_spell_still_round_trips(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src,
        out,
        [
            {
                "name": "Answer",
                "type": "radio",
                "page_index": 0,
                "rect": [72, 320, 200, 329],
                "options": [
                    {"label": "Not sure", "rect": [72, 320, 81, 329]},
                    {"label": "Yes/No", "rect": [191, 320, 200, 329]},
                ],
            }
        ],
    )
    assert _fields(out)["Answer"]["options"] == ["Not sure", "Yes/No"]


def test_a_group_given_one_rectangle_lays_its_options_out_in_cells(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src,
        out,
        [
            {
                "name": "Answer",
                "type": "radio",
                "page_index": 0,
                "rect": [100, 300, 300, 320],
                "options": ["Yes", "No"],
            }
        ],
    )
    widgets = _fields(out)["Answer"]["widgets"]
    assert len(widgets) == 2
    assert widgets[0]["rect"][0] < widgets[1]["rect"][0]


def test_choice_fields_carry_their_options(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src,
        out,
        [
            {
                "name": "Country",
                "type": "dropdown",
                "page_index": 0,
                "rect": [72, 600, 300, 620],
                "options": ["Ireland", "Portugal"],
            },
            {
                "name": "Languages",
                "type": "optionlist",
                "page_index": 0,
                "rect": [72, 500, 300, 560],
                "options": ["Irish", "Portuguese"],
            },
        ],
    )
    fields = _fields(out)
    assert fields["Country"]["type"] == "dropdown"
    assert fields["Country"]["options"] == ["Ireland", "Portugal"]
    assert fields["Languages"]["type"] == "optionlist"


def test_a_signature_field_sets_the_documents_signature_flag(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src, out, [{"name": "Sign_here", "type": "signature", "page_index": 0, "rect": [72, 100, 300, 160]}]
    )
    assert _fields(out)["Sign_here"]["type"] == "signature"
    with pikepdf.open(out) as pdf:
        assert int(pdf.Root["/AcroForm"]["/SigFlags"]) & 1
        # An empty signature field draws nothing: a generated appearance would
        # claim a look the signing flow then replaces.
        assert pdf.pages[0].obj["/Annots"][0].get("/AP") is None


def test_the_default_resource_dictionary_names_the_font_the_appearance_uses(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, out, [_text()])
    with pikepdf.open(out) as pdf:
        assert pdf.Root["/AcroForm"]["/DR"]["/Font"].get("/Helv") is not None


def test_fields_land_on_the_page_the_spec_names(tmp_path):
    src = _blank(tmp_path / "in.pdf", pages=3)
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, out, [_text("A", page=0), _text("B", page=2)])
    fields = _fields(out)
    assert fields["A"]["widgets"][0]["page"] == 0
    assert fields["B"]["widgets"][0]["page"] == 2


def test_writing_over_the_input_is_allowed(tmp_path):
    src = _blank(tmp_path / "same.pdf")
    add_form_fields(src, src, [_text()])
    assert set(_fields(src)) == {"Full_name"}


def test_a_second_batch_sees_the_first_batchs_names(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, out, [_text()])
    assert "Full_name" in existing_field_names(out)
    with pytest.raises(FieldSpecError):
        add_form_fields(out, str(tmp_path / "again.pdf"), [_text()])


# ── validation ────────────────────────────────────────────────────────────


def _refusal(tmp_path, specs):
    src = _blank(tmp_path / "in.pdf", pages=1)
    out = tmp_path / "out.pdf"
    with pytest.raises(FieldSpecError) as excinfo:
        add_form_fields(src, str(out), specs)
    # Nothing is written when validation fails: a document carrying the fields
    # created before a throw is a state no caller can reason about.
    assert not out.exists()
    return excinfo.value


def test_every_problem_in_a_batch_is_reported_at_once(tmp_path):
    error = _refusal(
        tmp_path,
        [
            {**_text("Bad.name")},
            {**_text("Off_page", page=9)},
            {"name": "No_type", "type": "sausage", "page_index": 0, "rect": [1, 1, 2, 2]},
        ],
    )
    assert len(error.problems) == 3
    assert all(":" in problem for problem in error.problems)


def test_an_unnamed_field_refuses(tmp_path):
    assert "name" in _refusal(tmp_path, [_text("")]).problems[0]


def test_a_dotted_name_refuses(tmp_path):
    assert "dot" in _refusal(tmp_path, [_text("parent.child")]).problems[0]


def test_two_specs_that_would_collide_with_each_other_refuse(tmp_path):
    assert "already exists" in _refusal(tmp_path, [_text(), _text()]).problems[0]


def test_an_empty_rectangle_refuses(tmp_path):
    assert "rectangle" in _refusal(tmp_path, [_text(rect=[72, 700, 72, 700])]).problems[0]


def test_a_choice_field_without_options_refuses(tmp_path):
    problems = _refusal(
        tmp_path, [{"name": "Pick", "type": "radio", "page_index": 0, "rect": [1, 1, 20, 20]}]
    ).problems
    assert "option" in problems[0]


def test_duplicate_options_refuse(tmp_path):
    problems = _refusal(
        tmp_path,
        [
            {
                "name": "Pick",
                "type": "radio",
                "page_index": 0,
                "rect": [1, 1, 40, 20],
                "options": ["Yes", "Yes"],
            }
        ],
    ).problems
    assert "different" in problems[0]


def test_a_partial_set_of_option_rectangles_refuses(tmp_path):
    problems = _refusal(
        tmp_path,
        [
            {
                "name": "Pick",
                "type": "radio",
                "page_index": 0,
                "rect": [1, 1, 40, 20],
                "options": [{"label": "Yes", "rect": [1, 1, 10, 10]}, {"label": "No"}],
            }
        ],
    ).problems
    assert "every option" in problems[0]


def test_a_comb_without_a_length_refuses(tmp_path):
    assert "comb" in _refusal(tmp_path, [{**_text(), "comb": True}]).problems[0]


def test_a_comb_that_is_also_multiline_refuses(tmp_path):
    problems = _refusal(
        tmp_path, [{**_text(), "comb": True, "max_length": 6, "multiline": True}]
    ).problems
    assert any("multiline" in p for p in problems)


def test_a_page_outside_the_document_refuses(tmp_path):
    assert "outside" in _refusal(tmp_path, [_text(page=4)]).problems[0]


# ── documents that refuse outright ────────────────────────────────────────


def _xfa(path):
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.Root["/AcroForm"] = pdf.make_indirect(
        Dictionary(Fields=Array(), XFA=Array([String("preamble"), pdf.make_stream(b"<xdp/>")]))
    )
    pdf.save(str(path))
    return str(path)


def test_a_dynamic_form_refuses(tmp_path):
    src = _xfa(tmp_path / "xfa.pdf")
    with pytest.raises(Exception) as excinfo:
        add_form_fields(src, str(tmp_path / "out.pdf"), [_text()])
    assert "XFA" in str(excinfo.value)


def test_a_document_with_no_pages_of_its_own_still_reports_the_range(tmp_path):
    src = _blank(tmp_path / "in.pdf", pages=2)
    with pytest.raises(FieldSpecError) as excinfo:
        add_form_fields(src, str(tmp_path / "out.pdf"), [_text(page=2)])
    assert "2 pages" in excinfo.value.problems[0]


def test_an_existing_form_keeps_its_fields(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    first = str(tmp_path / "first.pdf")
    add_form_fields(src, first, [_text("Full_name")])
    second = str(tmp_path / "second.pdf")
    add_form_fields(first, second, [_text("Employer", rect=[72, 650, 400, 670])])
    assert set(_fields(second)) == {"Full_name", "Employer"}


def test_the_widget_is_attached_to_its_page(tmp_path):
    src = _blank(tmp_path / "in.pdf", pages=2)
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, out, [_text("A", page=1)])
    with pikepdf.open(out) as pdf:
        assert pdf.pages[0].obj.get("/Annots") is None
        assert len(pdf.pages[1].obj["/Annots"]) == 1


def test_the_output_directory_is_created(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = tmp_path / "mirror" / "deep" / "out.pdf"
    add_form_fields(src, str(out), [_text()])
    assert out.exists()


def test_a_signed_document_refuses_until_the_run_says_signed_are_included(
    tmp_path, monkeypatch
):
    src = _blank(tmp_path / "in.pdf")
    monkeypatch.setattr(
        "engine.form_authoring.signature_policy",
        lambda path: {"signed": True, "count": 1, "certified": False, "level": None},
    )
    with pytest.raises(RuntimeError, match="signed"):
        add_form_fields(src, str(tmp_path / "out.pdf"), [_text()])
    result = add_form_fields(
        src, str(tmp_path / "out.pdf"), [_text()], allow_signed=True
    )
    assert result["created"] == 1


def test_a_no_changes_certification_refuses_even_when_signed_are_included(
    tmp_path, monkeypatch
):
    src = _blank(tmp_path / "in.pdf")
    monkeypatch.setattr(
        "engine.form_authoring.signature_policy",
        lambda path: {"signed": True, "count": 1, "certified": True, "level": "none"},
    )
    with pytest.raises(RuntimeError, match="no changes"):
        add_form_fields(src, str(tmp_path / "out.pdf"), [_text()], allow_signed=True)


def test_a_form_fill_certification_still_refuses_a_new_field(tmp_path, monkeypatch):
    # Filling a form is what that certification permits; ADDING a field is a
    # structural change to the form itself.
    src = _blank(tmp_path / "in.pdf")
    monkeypatch.setattr(
        "engine.form_authoring.signature_policy",
        lambda path: {"signed": True, "count": 1, "certified": True, "level": "form-fill"},
    )
    with pytest.raises(RuntimeError, match="signed"):
        add_form_fields(src, str(tmp_path / "out.pdf"), [_text()])


def test_signature_fields_do_not_clear_an_existing_flag(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, out, [_text()])
    assert pathlib.Path(out).exists()
    with pikepdf.open(out) as pdf:
        assert pdf.Root["/AcroForm"].get("/SigFlags") is None
