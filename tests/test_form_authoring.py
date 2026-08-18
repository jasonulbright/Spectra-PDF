"""`add_form_fields` — creating AcroForm fields by path.

The pins here are the ones a reader of the output can check: a created field is
findable by name and type, its widget sits where the spec said, its flags mean
what the spec asked for, and a button carries an on-state appearance. The
validation pins are the fail-closed posture: every problem at once, nothing
written when any of them fails.
"""

import os
import pathlib
import re

import pikepdf
import pytest
from pikepdf import Array, Dictionary, String

from engine.form_authoring import (
    FieldSpecError,
    add_form_fields,
    author_choice_appearance,
    author_vertical_field_font,
    existing_field_names,
)
from engine.forms import fill_form_fields, read_form_fields

FONTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts"
)


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


# ── Vertical fields ───────────────────────────────────────────────────────
#
# The CREATE half of a vertical field. A field writes down the page when its
# /DA names a /DR font on a vertical CMap, so what is pinned here is that
# font: its subtype, its CMap, and the character collection its descendant
# declares. The value's own glyphs are NOT in it — an empty field's /DA font
# has to cover characters nobody has typed — so the pins also hold the two
# halves apart: no font program in /DR, an embedded subset in the appearance
# the fill writes.

_HAS_CJK = os.path.isfile(os.path.join(FONTS_DIR, "NotoSansCJKsc-Regular.otf"))

#: script -> (/DR resource name, CMap, registry, ordering, supplement). Exact
#: values, because a viewer resolves a non-embedded CID font by exactly these.
VERTICAL_PINS = {
    "japanese": ("VJapan1", "/UniJIS-UTF16-V", "Adobe", "Japan1", 7),
    "simplified-chinese": ("VGB1", "/UniGB-UTF16-V", "Adobe", "GB1", 5),
    "traditional-chinese": ("VCNS1", "/UniCNS-UTF16-V", "Adobe", "CNS1", 7),
    "korean": ("VKorea1", "/UniKS-UTF16-V", "Adobe", "Korea1", 2),
}

#: script -> (a value in that script, a value mixing it with Latin).
VERTICAL_VALUES = {
    "japanese": ("機密文書", "型番 AB-12"),
    "simplified-chinese": ("机密文件", "型号 AB-12"),
    "traditional-chinese": ("機密文件", "型號 AB-12"),
    "korean": ("기밀문서", "모델 AB-12"),
}

_FONT_PROGRAM_KEYS = ("/FontFile", "/FontFile2", "/FontFile3")


def _vertical(name="note", script="japanese", page=0, rect=None):
    return {
        "name": name,
        "type": "text",
        "page_index": page,
        "rect": rect or [400, 400, 460, 700],
        "writing_mode": "vertical",
        "script": script,
    }


def _font_facts(font) -> dict:
    """What a composite font declares, as plain values a closed Pdf keeps.

    A composite font keeps its PROGRAM on the descendant's descriptor, so
    "embedded" is a claim about that one, never about the Type 0 wrapper.
    """
    descendant = font["/DescendantFonts"][0]
    info = descendant["/CIDSystemInfo"]
    descriptor = descendant["/FontDescriptor"]
    return {
        "subtype": str(font["/Subtype"]),
        "encoding": str(font["/Encoding"]),
        "descendant_subtype": str(descendant["/Subtype"]),
        "collection": (
            str(info["/Registry"]),
            str(info["/Ordering"]),
            int(info["/Supplement"]),
        ),
        "programs": {str(k) for k in descriptor.keys()} & set(_FONT_PROGRAM_KEYS),
    }


def _dr_font(path, resource) -> dict:
    with pikepdf.open(path) as pdf:
        return _font_facts(pdf.Root["/AcroForm"]["/DR"]["/Font"]["/" + resource])


def _field_da(path, name):
    with pikepdf.open(path) as pdf:
        for entry in pdf.Root["/AcroForm"]["/Fields"]:
            if str(entry.get("/T")) == name:
                return str(entry["/DA"])
    raise AssertionError(f"no field named {name}")


def _appearance(path, name):
    """(appearance bytes, {resource name: facts}) for the widget's /AP /N."""
    with pikepdf.open(path) as pdf:
        for entry in pdf.Root["/AcroForm"]["/Fields"]:
            if str(entry.get("/T")) == name:
                ap = entry["/AP"]["/N"]
                fonts = ap["/Resources"]["/Font"]
                return bytes(ap.read_bytes()), {
                    str(k): _font_facts(fonts[k]) for k in fonts.keys()
                }
    raise AssertionError(f"no field named {name}")


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
@pytest.mark.parametrize("script", sorted(VERTICAL_PINS))
def test_a_vertical_field_binds_its_dr_font_to_the_scripts_collection(tmp_path, script):
    resource, cmap, registry, ordering, supplement = VERTICAL_PINS[script]
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, out, [_vertical(script=script)], font_dir=FONTS_DIR)

    assert _field_da(out, "note") == f"/{resource} 0 Tf 0 g"
    facts = _dr_font(out, resource)
    assert facts["subtype"] == "/Type0"
    assert facts["encoding"] == cmap
    assert facts["descendant_subtype"] == "/CIDFontType0"
    assert facts["collection"] == (registry, ordering, supplement)
    assert facts["programs"] == set()


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
@pytest.mark.parametrize("script", sorted(VERTICAL_PINS))
@pytest.mark.parametrize("which", (0, 1))
def test_an_authored_vertical_field_fills_as_a_column(tmp_path, script, which):
    # The author-then-fill matrix: every script, a value in that script and a
    # value mixing it with Latin. What the fill does with an authored field is
    # exactly what it does with one that arrived from anywhere else.
    resource = VERTICAL_PINS[script][0]
    value = VERTICAL_VALUES[script][which]
    src = _blank(tmp_path / "in.pdf")
    authored = str(tmp_path / "authored.pdf")
    filled = str(tmp_path / "filled.pdf")
    add_form_fields(src, authored, [_vertical(script=script)], font_dir=FONTS_DIR)

    result = fill_form_fields(authored, filled, {"note": value}, font_dir=FONTS_DIR)
    assert result["filled"] == 1
    # An intentional embed, never reported as a /DR-missing substitution.
    assert result["fonts_substituted"] == []

    body, fonts = _appearance(filled, "note")
    assert re.search(rb"/TxV \d+(?:\.\d+)? Tf", body)
    # The column head: the pen starts one pad down the reading axis, which is
    # the box's HEIGHT (300 - 2), under the upright identity linear part.
    assert re.search(rb"1 0 0 1 \d+(?:\.\d+)? 298 Tm", body)
    # The appearance carries its OWN subset, so the value renders in a viewer
    # that has no font for the collection the /DR font names.
    assert set(fonts) == {"/TxV"}
    assert fonts["/TxV"]["programs"]
    # …and the /DR font still carries none.
    assert _dr_font(filled, resource)["programs"] == set()


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_the_authored_column_reproduces_the_pinned_geometry(tmp_path):
    # The exact bytes T30 pinned for a 60x300 box: the auto fit caps at twice
    # the default size, and the pen lands half the column's own width in from
    # the stacking edge (60 - 2 - 24/2) at the reading axis' head (300 - 2).
    src = _blank(tmp_path / "in.pdf")
    authored = str(tmp_path / "authored.pdf")
    filled = str(tmp_path / "filled.pdf")
    add_form_fields(src, authored, [_vertical()], font_dir=FONTS_DIR)
    fill_form_fields(authored, filled, {"note": "機密文書"}, font_dir=FONTS_DIR)
    body, _fonts = _appearance(filled, "note")
    assert b"/TxV 24 Tf" in body
    assert b"1 0 0 1 46 298 Tm" in body


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_two_scripts_on_one_form_get_one_dr_font_each(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src,
        out,
        [
            _vertical("jp", "japanese", rect=[400, 400, 460, 700]),
            _vertical("kr", "korean", rect=[300, 400, 360, 700]),
            _text("plain"),
        ],
        font_dir=FONTS_DIR,
    )
    with pikepdf.open(out) as pdf:
        fonts = pdf.Root["/AcroForm"]["/DR"]["/Font"]
        assert {str(k) for k in fonts.keys()} == {"/Helv", "/VJapan1", "/VKorea1"}
    assert _field_da(out, "jp") == "/VJapan1 0 Tf 0 g"
    assert _field_da(out, "kr") == "/VKorea1 0 Tf 0 g"
    # A horizontal field beside them is untouched.
    assert _field_da(out, "plain") == "/Helv 0 Tf 0 g"


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_a_dropdown_can_write_vertically(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src,
        out,
        [
            {
                "name": "size",
                "type": "dropdown",
                "page_index": 0,
                "rect": [400, 400, 460, 700],
                "options": ["大", "中", "小"],
                "writing_mode": "vertical",
                "script": "japanese",
            }
        ],
        font_dir=FONTS_DIR,
    )
    assert _field_da(out, "size") == "/VJapan1 0 Tf 0 g"


def test_a_vertical_field_without_a_font_dir_is_refused(tmp_path):
    # The descriptor states the metrics of the face the fill will draw
    # through; with no face there is nothing to state, so nothing is written.
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    with pytest.raises(ValueError, match="no vertical font is available"):
        add_form_fields(src, out, [_vertical()], font_dir="")
    assert not pathlib.Path(out).exists()


@pytest.mark.parametrize(
    "spec, expected",
    (
        ({"type": "checkbox"}, "draws a mark rather than a text run"),
        ({"type": "radio", "options": ["a", "b"]}, "draws a mark rather than a text run"),
        ({"type": "signature"}, "draws a mark rather than a text run"),
    ),
)
def test_vertical_writing_is_refused_where_it_is_undefined(tmp_path, spec, expected):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    field = {
        "name": "mark",
        "page_index": 0,
        "rect": [100, 100, 140, 140],
        "writing_mode": "vertical",
        "script": "japanese",
        **spec,
    }
    with pytest.raises(FieldSpecError) as exc:
        add_form_fields(src, out, [field], font_dir=FONTS_DIR)
    assert any(expected in problem for problem in exc.value.problems)
    assert not pathlib.Path(out).exists()


@pytest.mark.parametrize(
    "extra, expected",
    (
        ({"script": "japanese"}, "this field writes horizontally"),
        ({"writing_mode": "vertical"}, "needs the script"),
        ({"writing_mode": "vertical", "script": "klingon"}, "unknown script klingon"),
        ({"writing_mode": "sideways"}, "unknown writing mode sideways"),
        ({"writing_mode": "vertical-rl", "script": "japanese"}, "no column direction"),
        ({"writing_mode": "vertical-lr", "script": "japanese"}, "no column direction"),
        (
            {
                "writing_mode": "vertical",
                "script": "japanese",
                "comb": True,
                "max_length": 8,
            },
            "divides its box across",
        ),
    ),
)
def test_the_writing_mode_and_script_are_validated_together(tmp_path, extra, expected):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    with pytest.raises(FieldSpecError) as exc:
        add_form_fields(src, out, [{**_text(), **extra}], font_dir=FONTS_DIR)
    assert any(expected in problem for problem in exc.value.problems)
    assert not pathlib.Path(out).exists()


# ── The font door, for a field somebody else created ──────────────────────


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
@pytest.mark.parametrize("script", sorted(VERTICAL_PINS))
def test_the_door_binds_an_existing_field_to_a_vertical_font(tmp_path, script):
    resource, cmap, registry, ordering, supplement = VERTICAL_PINS[script]
    src = _blank(tmp_path / "in.pdf")
    horizontal = str(tmp_path / "h.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, horizontal, [_text("note")])

    result = author_vertical_field_font(
        horizontal, out, fields=["note"], script=script, font_dir=FONTS_DIR
    )
    assert result["fields"] == ["note"]
    assert (result["font"], result["cmap"]) == (resource, cmap.lstrip("/"))
    assert (result["registry"], result["ordering"], result["supplement"]) == (
        registry,
        ordering,
        supplement,
    )
    assert _field_da(out, "note") == f"/{resource} 0 Tf 0 g"
    assert _dr_font(out, resource)["encoding"] == cmap


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_the_door_keeps_the_size_and_colour_the_field_already_had(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    horizontal = str(tmp_path / "h.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, horizontal, [_text("note")])
    with pikepdf.open(horizontal, allow_overwriting_input=True) as pdf:
        for entry in pdf.Root["/AcroForm"]["/Fields"]:
            entry["/DA"] = String("/Helv 9 Tf 1 0 0 rg")
        pdf.save(horizontal)
    author_vertical_field_font(
        horizontal, out, fields=["note"], script="japanese", font_dir=FONTS_DIR
    )
    assert _field_da(out, "note") == "/VJapan1 9 Tf 1 0 0 rg"


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_the_door_reports_every_problem_and_writes_nothing(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    horizontal = str(tmp_path / "h.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src,
        horizontal,
        [
            _text("note"),
            {
                "name": "agree",
                "type": "checkbox",
                "page_index": 0,
                "rect": [100, 100, 120, 120],
            },
            {
                "name": "code",
                "type": "text",
                "page_index": 0,
                "rect": [100, 200, 300, 220],
                "comb": True,
                "max_length": 8,
            },
        ],
    )
    with pytest.raises(FieldSpecError) as exc:
        author_vertical_field_font(
            horizontal,
            out,
            fields=["note", "agree", "code", "ghost"],
            script="japanese",
            font_dir=FONTS_DIR,
        )
    problems = exc.value.problems
    assert len(problems) == 3
    assert any("agree: a checkbox field draws a mark" in p for p in problems)
    assert any("code: a comb field divides its box" in p for p in problems)
    assert any("ghost: this document has no form field" in p for p in problems)
    assert not pathlib.Path(out).exists()


def test_the_door_refuses_an_unknown_script(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    horizontal = str(tmp_path / "h.pdf")
    add_form_fields(src, horizontal, [_text("note")])
    with pytest.raises(ValueError, match="the script must be one of"):
        author_vertical_field_font(
            horizontal,
            str(tmp_path / "out.pdf"),
            fields=["note"],
            script="",
            font_dir=FONTS_DIR,
        )


def test_the_door_needs_a_field_to_bind(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    horizontal = str(tmp_path / "h.pdf")
    add_form_fields(src, horizontal, [_text("note")])
    with pytest.raises(ValueError, match="Name the form fields"):
        author_vertical_field_font(
            horizontal,
            str(tmp_path / "out.pdf"),
            fields=[],
            script="japanese",
            font_dir=FONTS_DIR,
        )


# ── Option-list appearances ───────────────────────────────────────────────
#
# A list box's appearance draws EVERY label, so it is the one field kind whose
# appearance depends on arbitrary authored text. What is pinned here is the
# per-ROW font choice (the standard face where WinAnsi covers the row, an
# embedded subset where it does not), the exact geometry of the rows and of
# the selection band, and that the whole surface has ONE author: the create,
# the door and the fill all produce the same stream for the same state.

MIXED_OPTIONS = ["US", "한국", "Ελλάδα", "Россия"]


def _list_spec(name="country", options=None, rect=None, **extra):
    return {
        "name": name,
        "type": "optionlist",
        "page_index": 0,
        "rect": rect or [72, 600, 300, 700],
        "options": list(options if options is not None else MIXED_OPTIONS),
        **extra,
    }


def _widget_of(pdf, name):
    for entry in pdf.Root["/AcroForm"]["/Fields"]:
        if str(entry.get("/T")) == name:
            return entry
    raise AssertionError(f"no field named {name}")


def _list_appearance(path, name="country"):
    """(stream bytes, {resource: (subtype, base font, embedded program keys)}).

    Written for a MIXED appearance: a simple Type 1 face and a composite
    subset side by side in one /Resources, which `_font_facts` (composite
    only) cannot describe.
    """
    with pikepdf.open(path) as pdf:
        ap = _widget_of(pdf, name)["/AP"]["/N"]
        fonts = ap["/Resources"]["/Font"]
        facts = {}
        for key in fonts.keys():
            font = fonts[key]
            descendants = font.get("/DescendantFonts")
            descriptor = (
                descendants[0]["/FontDescriptor"]
                if descendants is not None
                else font.get("/FontDescriptor")
            )
            programs = (
                {str(k) for k in descriptor.keys()} & set(_FONT_PROGRAM_KEYS)
                if descriptor is not None
                else set()
            )
            facts[str(key)] = (str(font["/Subtype"]), str(font["/BaseFont"]), programs)
        return bytes(ap.read_bytes()), facts


def _set_da(path, name, da):
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        _widget_of(pdf, name)["/DA"] = String(da)
        pdf.save(path)


def _set_key(path, name, key, value):
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        _widget_of(pdf, name)[key] = value
        pdf.save(path)


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_a_mixed_option_list_draws_every_row_through_its_own_font(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, out, [_list_spec()], font_dir=FONTS_DIR)
    _set_da(out, "country", "/Helv 10 Tf 0 g")
    drawn = str(tmp_path / "drawn.pdf")
    result = author_choice_appearance(out, drawn, fields=["country"], font_dir=FONTS_DIR)
    assert result["fields"] == ["country"]
    assert result["embedded"] == ["country"]

    body, fonts = _list_appearance(drawn)
    text = body.decode("latin-1")
    # The WinAnsi row draws as a literal string through the standard face; the
    # three others draw as hex through embedded subsets. Four Tm operators mean
    # four rows: nothing was dropped for being unencodable.
    assert "(US) Tj" in text
    assert text.count(" Tm") == 4
    assert fonts["/Helv"] == ("/Type1", "/Helvetica", set())
    embedded = {key: facts for key, facts in fonts.items() if key != "/Helv"}
    assert len(embedded) == 2, embedded
    # Korean resolves to the bundled CJK face, whose CFF outlines embed as
    # /FontFile3; Greek and Cyrillic share ONE Liberation subset (/FontFile2),
    # because the ladder resolves a face per ROW and both rows land on it.
    by_face = {facts[1].split("+")[-1]: facts for facts in embedded.values()}
    assert by_face["NotoSansCJKsc"][0] == "/Type0"
    assert by_face["NotoSansCJKsc"][2] == {"/FontFile3"}
    assert by_face["LiberationSans"][0] == "/Type0"
    assert by_face["LiberationSans"][2] == {"/FontFile2"}
    # One resource per FACE, not per row.
    assert len(fonts) == 3


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_the_rows_of_an_option_list_sit_one_line_pitch_apart(tmp_path):
    # Exact geometry, at an explicit /DA size so nothing depends on the
    # auto-size scan. Box 228x100 with a 1 pt border and 1 pt of list padding:
    # the rows live in the 96 pt band 2 pt in, the first baseline one row pitch
    # down from its top (2 + 96 - 11.1), and each row after it drops another.
    # The pitch is the GLYPH height plus its leading (9.25 * 1.2), which is
    # what the provider that drew this surface before the door uses — a list
    # whose rows moved when it was selected would be the visible defect.
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, out, [_list_spec()], font_dir=FONTS_DIR)
    _set_da(out, "country", "/Helv 10 Tf 0 g")
    drawn = str(tmp_path / "drawn.pdf")
    author_choice_appearance(out, drawn, fields=["country"], font_dir=FONTS_DIR)
    text = _list_appearance(drawn)[0].decode("latin-1")
    assert "1 0 0 1 2 86.9 Tm" in text
    assert "1 0 0 1 2 75.8 Tm" in text
    assert "1 0 0 1 2 64.7 Tm" in text
    assert "1 0 0 1 2 53.6 Tm" in text


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_the_selection_band_covers_exactly_one_row_pitch(tmp_path):
    # /I names rows 0 and 2. A band runs the full row pitch, so two adjacent
    # selected rows highlight continuously: row i's band bottom is its baseline
    # less the descent and half the leading (86.9 - 2.07 - 0.925), and it runs
    # the full width inside the border.
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, out, [_list_spec()], font_dir=FONTS_DIR)
    _set_da(out, "country", "/Helv 10 Tf 0 g")
    _set_key(out, "country", "/I", Array([0, 2]))
    drawn = str(tmp_path / "drawn.pdf")
    author_choice_appearance(out, drawn, fields=["country"], font_dir=FONTS_DIR)
    text = _list_appearance(drawn)[0].decode("latin-1")
    assert "0.6 0.7569 0.8549 rg\n1 83.91 227 11.1 re f" in text
    assert "0.6 0.7569 0.8549 rg\n1 61.71 227 11.1 re f" in text
    assert text.count(" re f") == 3  # two bands plus the /MK background


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_the_top_index_scrolls_the_rows_and_the_band_together(tmp_path):
    # /TI is the row drawn at the TOP, so rows above it are scrolled out and
    # the selection moves up with them: row 2 selected under /TI 2 bands the
    # FIRST drawn row, at the first row's own position.
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, out, [_list_spec()], font_dir=FONTS_DIR)
    _set_da(out, "country", "/Helv 10 Tf 0 g")
    _set_key(out, "country", "/TI", 2)
    _set_key(out, "country", "/I", Array([2]))
    drawn = str(tmp_path / "drawn.pdf")
    author_choice_appearance(out, drawn, fields=["country"], font_dir=FONTS_DIR)
    text = _list_appearance(drawn)[0].decode("latin-1")
    assert text.count(" Tm") == 2  # only the last two options are drawn
    assert "(US) Tj" not in text  # the first row scrolled out
    assert "1 0 0 1 2 86.9 Tm" in text  # row 2 now sits at the top
    assert "1 83.91 227 11.1 re f" in text


def test_a_winansi_only_list_needs_no_embedded_font(tmp_path):
    # The boundary in the other direction: a list the standard face covers
    # draws through it alone, with no font program anywhere in the appearance,
    # and with no font tree in reach.
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(src, out, [_list_spec(options=["Red", "Grün", "Café"])])
    drawn = str(tmp_path / "drawn.pdf")
    result = author_choice_appearance(out, drawn, fields=["country"], font_dir="")
    assert result["embedded"] == []
    body, fonts = _list_appearance(drawn)
    assert set(fonts) == {"/Helv"}
    assert fonts["/Helv"][2] == set()
    assert body.decode("latin-1").count(" Tm") == 3


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
@pytest.mark.parametrize("script", sorted(VERTICAL_PINS))
def test_a_vertical_option_list_draws_its_options_as_columns(tmp_path, script):
    # T31 x F28: a list bound to a vertical font routes its rows through the
    # vertical emitter — the SAME door, one call, not a second one.
    labels = [VERTICAL_VALUES[script][0], "US"]
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src,
        out,
        [
            _list_spec(
                options=labels,
                rect=[400, 400, 500, 700],
                writing_mode="vertical",
                script=script,
            )
        ],
        font_dir=FONTS_DIR,
    )
    resource = VERTICAL_PINS[script][0]
    assert _field_da(out, "country") == f"/{resource} 0 Tf 0 g"
    _set_key(out, "country", "/I", Array([0]))
    drawn = str(tmp_path / "drawn.pdf")
    author_choice_appearance(out, drawn, fields=["country"], font_dir=FONTS_DIR)
    body, fonts = _list_appearance(drawn)
    text = body.decode("latin-1")
    # The vertical emitter names ONE resource, and it embeds its own subset —
    # the /DR collection font the field's /DA names carries no program.
    assert set(fonts) == {"/TxV"}
    assert fonts["/TxV"][2], "the vertical appearance embeds its own subset"
    assert text.count(" Tm") == 2
    assert "0.6 0.7569 0.8549 rg" in text  # the selected column is banded


def test_the_choice_door_reports_every_problem_and_writes_nothing(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    created = str(tmp_path / "created.pdf")
    out = str(tmp_path / "out.pdf")
    add_form_fields(
        src,
        created,
        [
            _list_spec(options=["Red", "Blue"]),
            _text("note"),
            {
                "name": "pick",
                "type": "dropdown",
                "page_index": 0,
                "rect": [72, 500, 300, 524],
                "options": ["a", "b"],
            },
        ],
    )
    with pytest.raises(FieldSpecError) as exc:
        author_choice_appearance(
            created, out, fields=["country", "note", "pick", "ghost"], font_dir=FONTS_DIR
        )
    problems = exc.value.problems
    assert len(problems) == 3
    assert any("note: a text field draws no list of options" in p for p in problems)
    assert any("pick: a dropdown field draws no list of options" in p for p in problems)
    assert any("ghost: this document has no form field" in p for p in problems)
    assert not pathlib.Path(out).exists()


def test_the_choice_door_needs_a_field_to_draw(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    created = str(tmp_path / "created.pdf")
    add_form_fields(src, created, [_list_spec(options=["Red", "Blue"])])
    with pytest.raises(ValueError, match="Name the option lists"):
        author_choice_appearance(
            created, str(tmp_path / "out.pdf"), fields=[], font_dir=FONTS_DIR
        )


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_a_list_beyond_winansi_refuses_by_name_without_a_font_tree(tmp_path):
    # The degenerate case the capability keeps a named refusal for: the rows
    # need an embedded face and there is no font tree to resolve one from.
    src = _blank(tmp_path / "in.pdf")
    out = str(tmp_path / "out.pdf")
    with pytest.raises(FieldSpecError) as exc:
        add_form_fields(src, out, [_list_spec()], font_dir="")
    assert any("no font is available to embed" in p for p in exc.value.problems)
    assert not pathlib.Path(out).exists()

    created = str(tmp_path / "created.pdf")
    add_form_fields(src, created, [_list_spec()], font_dir=FONTS_DIR)
    with pytest.raises(FieldSpecError) as exc:
        author_choice_appearance(created, out, fields=["country"], font_dir="")
    assert any("no fallback font is available" in p for p in exc.value.problems)
    assert not pathlib.Path(out).exists()


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_selecting_an_option_redraws_the_whole_list(tmp_path):
    # The fill side, measured rather than assumed: selecting a row regenerates
    # the SAME all-rows appearance the door authored, with the band moved. One
    # author for the surface — author, select, reopen, exact bytes.
    src = _blank(tmp_path / "in.pdf")
    created = str(tmp_path / "created.pdf")
    add_form_fields(src, created, [_list_spec()], font_dir=FONTS_DIR)
    _set_da(created, "country", "/Helv 10 Tf 0 g")
    drawn = str(tmp_path / "drawn.pdf")
    author_choice_appearance(created, drawn, fields=["country"], font_dir=FONTS_DIR)

    filled = str(tmp_path / "filled.pdf")
    fill_form_fields(drawn, filled, {"country": ["한국"]}, font_dir=FONTS_DIR)
    assert _fields(filled)["country"]["value"] == ["한국"]
    before = _list_appearance(drawn)[0].decode("latin-1")
    after = _list_appearance(filled)[0].decode("latin-1")
    # Every row still draws, and the ONLY difference is the band.
    assert after.count(" Tm") == 4
    assert "(US) Tj" in after
    # Row 1 of four: its baseline is 75.8, and the band bottom is that less
    # the descent and half the leading.
    assert "1 72.81 227 11.1 re f" in after
    assert after.replace("0.6 0.7569 0.8549 rg\n1 72.81 227 11.1 re f\n", "") == before

    # Selecting again from the FILLED file lands the band on the other row and
    # nothing else moves — the appearance is a function of the state, so a
    # second pass cannot accumulate.
    again = str(tmp_path / "again.pdf")
    fill_form_fields(filled, again, {"country": ["Ελλάδα"]}, font_dir=FONTS_DIR)
    text = _list_appearance(again)[0].decode("latin-1")
    assert text.count(" re f") == 2  # one band plus the background
    assert "1 61.71 227 11.1 re f" in text


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_the_created_list_and_the_door_agree_byte_for_byte(tmp_path):
    # Two authors of one surface drift the moment nothing compares them: the
    # create path draws the list itself, and running the door over the result
    # changes nothing.
    src = _blank(tmp_path / "in.pdf")
    created = str(tmp_path / "created.pdf")
    add_form_fields(src, created, [_list_spec()], font_dir=FONTS_DIR)
    drawn = str(tmp_path / "drawn.pdf")
    author_choice_appearance(created, drawn, fields=["country"], font_dir=FONTS_DIR)
    assert _list_appearance(drawn)[0] == _list_appearance(created)[0]


@pytest.mark.skipif(not _HAS_CJK, reason="bundled CJK face not provisioned")
def test_a_clear_leaves_the_rows_drawn_and_removes_only_the_band(tmp_path):
    src = _blank(tmp_path / "in.pdf")
    created = str(tmp_path / "created.pdf")
    add_form_fields(src, created, [_list_spec()], font_dir=FONTS_DIR)
    _set_da(created, "country", "/Helv 10 Tf 0 g")
    drawn = str(tmp_path / "drawn.pdf")
    author_choice_appearance(created, drawn, fields=["country"], font_dir=FONTS_DIR)
    filled = str(tmp_path / "filled.pdf")
    fill_form_fields(drawn, filled, {"country": ["한국"]}, font_dir=FONTS_DIR)
    cleared = str(tmp_path / "cleared.pdf")
    fill_form_fields(filled, cleared, {"country": []}, font_dir=FONTS_DIR)
    assert _list_appearance(cleared)[0] == _list_appearance(drawn)[0]
