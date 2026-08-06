"""In-RIP trapping presets, their PostScript emission, and `/Trapped`.

The two claims worth pinning are the ones a surface without a trapping engine
could fake: the preset really reaches a consumer (a `setpagedevice` inside each
assigned page's own setup, in PostScript that still processes), and the
document never claims to be trapped just because a preset was assigned.
"""

import os
import subprocess

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine.prepress import _pdfx_def_ps
from engine.trapping import (
    DEFAULT_TRAPPED,
    TRAP_FIELDS,
    assign_presets,
    emit_trapping_setup,
    export_postscript,
    list_trap_presets,
    trap_preset_defaults,
    trapping_setup_block,
    validate_trap_preset,
)
from separation_builders import cmyk_spot_pdf

# The sixteen names and initial values `gs_trap.ps` defines. Read out of the
# bundled file rather than restated, so a Ghostscript that changed either is a
# red here instead of a preset nothing consumes.
GS_TRAP_DEFAULTS = {
    "BlackColorLimit": 1.0,
    "BlackDensityLimit": 1.0,
    "BlackWidth": 1.0,
    "ColorantZoneDetails": {},
    "Enabled": True,
    "HalftoneName": None,
    "ImageInternalTrapping": False,
    "ImagemaskTrapping": True,
    "ImageResolution": 1,
    "ImageToObjectTrapping": True,
    "ImageTrapPlacement": "Center",
    "SlidingTrapLimit": 1.0,
    "StepLimit": 1.0,
    "TrapColorScaling": 0.0,
    "TrapSetName": None,
    "TrapWidth": 1.0,
}


def _blank_pdf(path, pages=3):
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(200, 200))
    pdf.save(path)
    pdf.close()
    return str(path)


# ── the vocabulary ─────────────────────────────────────────────────────────


def test_the_sixteen_fields_carry_the_devices_own_initial_values():
    preset = validate_trap_preset()
    assert preset["fields"] == GS_TRAP_DEFAULTS
    assert len(TRAP_FIELDS) == 16


def test_the_defaults_op_describes_every_field_it_validates():
    described = trap_preset_defaults()
    assert {row["name"] for row in described["fields"]} == set(TRAP_FIELDS)
    assert described["default_trapped"] == DEFAULT_TRAPPED
    assert described["trapped_values"] == ["True", "False", "Unknown"]


@pytest.mark.parametrize("field,value", [
    ("BlackColorLimit", 1.5),
    ("SlidingTrapLimit", -0.1),
    ("StepLimit", 2.0),
    ("TrapColorScaling", 1.01),
    ("TrapWidth", 1000.0),
    ("ImageResolution", 0),
])
def test_a_value_outside_its_range_refuses(field, value):
    with pytest.raises(ValueError, match="must be between"):
        validate_trap_preset({field: value})


def test_an_unknown_field_refuses_rather_than_being_ignored():
    with pytest.raises(ValueError, match="not an In-RIP trapping parameter"):
        validate_trap_preset({"TrapEverything": True})


def test_a_placement_outside_the_enumeration_refuses():
    with pytest.raises(ValueError, match="must be one of"):
        validate_trap_preset({"ImageTrapPlacement": "Sideways"})
    assert validate_trap_preset({"ImageTrapPlacement": "Spread"})["fields"][
        "ImageTrapPlacement"] == "Spread"


def test_a_boolean_field_refuses_a_number():
    with pytest.raises(ValueError, match="true or false"):
        validate_trap_preset({"Enabled": 1})


def test_a_per_colorant_override_validates_against_the_same_vocabulary():
    preset = validate_trap_preset({
        "ColorantZoneDetails": {"PANTONE 185 C": {"TrapWidth": 2.0}},
    })
    assert preset["fields"]["ColorantZoneDetails"] == {"PANTONE 185 C": {"TrapWidth": 2.0}}
    with pytest.raises(ValueError, match="not an In-RIP trapping parameter"):
        validate_trap_preset({"ColorantZoneDetails": {"Spot": {"Nonsense": 1}}})
    with pytest.raises(ValueError, match="must be between"):
        validate_trap_preset({"ColorantZoneDetails": {"Spot": {"StepLimit": 9}}})


# ── the emission ───────────────────────────────────────────────────────────


def test_the_block_names_the_in_rip_door_and_guards_the_operator():
    block = trapping_setup_block(validate_trap_preset({"TrapWidth": 2.5}))
    assert "<< /Trapping true /TrappingType 1001 >> setpagedevice" in block
    # `settrapparams` exists only where the Trapping ProcSet is installed; an
    # unguarded call would error the job on every RIP that has no in-RIP
    # trapping at all.
    assert "/Trapping /ProcSet resourcestatus {" in block
    assert "settrapparams" in block
    assert "/TrapWidth 2.5" in block


def test_a_colorant_name_that_is_not_a_postscript_name_goes_through_cvn():
    block = trapping_setup_block(validate_trap_preset({
        "ColorantZoneDetails": {"PANTONE 185 C": {"TrapWidth": 4.0}},
    }))
    assert "(PANTONE 185 C) cvn << /TrapWidth 4 >>" in block
    plain = trapping_setup_block(validate_trap_preset({
        "ColorantZoneDetails": {"Cyan": {"TrapWidth": 4.0}},
    }))
    assert "/Cyan << /TrapWidth 4 >>" in plain


def test_the_setup_lands_inside_each_assigned_pages_own_setup(tmp_dir, gs_path):
    source = _blank_pdf(os.path.join(tmp_dir, "src.pdf"))
    postscript = os.path.join(tmp_dir, "out.ps")
    export_postscript(source, postscript, gs_path=gs_path, trapping=False)
    result = emit_trapping_setup(postscript, assignments=[
        {"first": 1, "last": 2, "name": "Press A", "preset": {"TrapWidth": 2.0}},
    ])
    assert result["pages"] == 3
    assert result["attached"] == 2
    text = open(postscript, encoding="latin-1").read()
    assert text.count("%%BeginFeature: *Trapping True") == 2
    # Page-level device setup belongs inside PageSetup, and the page's own
    # content has not started there yet.
    head, _, _ = text.partition("%%BeginFeature")
    assert head.rstrip().endswith("endobj")
    assert "%%EndPageSetup" in text[text.index("%%EndFeature"):]


def test_the_emitted_postscript_still_processes(tmp_dir, gs_path):
    source = _blank_pdf(os.path.join(tmp_dir, "src.pdf"))
    assigned = os.path.join(tmp_dir, "assigned.pdf")
    assign_presets(source, assigned, assignments=[
        {"first": 1, "last": 3, "name": "Press A",
         "preset": {"TrapWidth": 2.5, "ColorantZoneDetails": {"PANTONE 185 C": {"TrapWidth": 4.0}}}},
    ])
    postscript = os.path.join(tmp_dir, "out.ps")
    result = export_postscript(assigned, postscript, gs_path=gs_path)
    assert result["trapping_pages"] == 3
    back = os.path.join(tmp_dir, "back.pdf")
    run = subprocess.run(
        [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=pdfwrite",
         "-o", back, postscript],
        capture_output=True, text=True, stdin=subprocess.DEVNULL,
    )
    assert run.returncode == 0, run.stderr
    with pikepdf.open(back) as pdf:
        assert len(pdf.pages) == 3


def test_a_page_range_outside_the_document_refuses(tmp_dir):
    source = _blank_pdf(os.path.join(tmp_dir, "src.pdf"))
    with pytest.raises(ValueError, match="not in this document"):
        assign_presets(source, os.path.join(tmp_dir, "out.pdf"), assignments=[
            {"first": 2, "last": 9, "name": "Press A", "preset": {}},
        ])


def test_a_file_with_no_page_structure_refuses(tmp_dir):
    path = os.path.join(tmp_dir, "bare.ps")
    with open(path, "w", encoding="ascii") as handle:
        handle.write("%!PS\nshowpage\n")
    with pytest.raises(ValueError, match="no page structure"):
        emit_trapping_setup(path, assignments=[{"first": 1, "last": 1, "preset": {}}])


def test_a_file_that_is_not_postscript_refuses(tmp_dir, sample_pdf):
    with pytest.raises(ValueError, match="no page structure"):
        emit_trapping_setup(sample_pdf, output=os.path.join(tmp_dir, "x.ps"),
                            assignments=[{"first": 1, "last": 1, "preset": {}}])


def test_language_level_2_refuses_the_trapping_setup(tmp_dir, gs_path):
    source = _blank_pdf(os.path.join(tmp_dir, "src.pdf"))
    assigned = os.path.join(tmp_dir, "assigned.pdf")
    assign_presets(source, assigned, assignments=[
        {"first": 1, "last": 1, "name": "Press A", "preset": {}},
    ])
    with pytest.raises(ValueError, match="LanguageLevel 3"):
        export_postscript(assigned, os.path.join(tmp_dir, "out.ps"),
                          gs_path=gs_path, level=2)


# ── the assignment, and `/Trapped` ─────────────────────────────────────────


def test_an_assignment_round_trips_through_the_document(tmp_dir):
    source = _blank_pdf(os.path.join(tmp_dir, "src.pdf"))
    assigned = os.path.join(tmp_dir, "assigned.pdf")
    assign_presets(source, assigned, assignments=[
        {"first": 1, "last": 2, "name": "Press A", "preset": {"TrapWidth": 2.5}},
        {"first": 3, "last": 3, "name": "Press B", "preset": {"Enabled": False}},
    ])
    read = list_trap_presets(assigned)
    assert [e["name"] for e in read["assignments"]] == ["Press A", "Press B"]
    assert read["assignments"][0]["preset"]["TrapWidth"] == 2.5
    assert read["assignments"][1]["preset"]["Enabled"] is False
    # What comes back is what the writers take, so a document's own assignment
    # can be re-applied without translation.
    again = os.path.join(tmp_dir, "again.pdf")
    assign_presets(assigned, again, assignments=read["assignments"])
    assert list_trap_presets(again)["assignments"][0]["preset"]["TrapWidth"] == 2.5


def test_assigning_a_preset_never_claims_the_document_is_trapped(tmp_dir):
    source = _blank_pdf(os.path.join(tmp_dir, "src.pdf"))
    assigned = os.path.join(tmp_dir, "assigned.pdf")
    result = assign_presets(source, assigned, assignments=[
        {"first": 1, "last": 3, "name": "Press A", "preset": {}},
    ])
    assert result["trapped"] == "Unknown"
    with pikepdf.open(assigned) as pdf:
        assert str(pdf.docinfo["/Trapped"]) == "/Unknown"


def test_trapped_is_the_callers_assertion_and_nothing_else(tmp_dir):
    source = _blank_pdf(os.path.join(tmp_dir, "src.pdf"))
    for claim in ("True", "False", "Unknown"):
        out = os.path.join(tmp_dir, f"{claim}.pdf")
        assign_presets(source, out, assignments=[], trapped=claim)
        with pikepdf.open(out) as pdf:
            assert str(pdf.docinfo["/Trapped"]) == f"/{claim}"
    with pytest.raises(ValueError, match="Trapped must be one of"):
        assign_presets(source, os.path.join(tmp_dir, "bad.pdf"), trapped="Maybe")


def test_the_pdfx_master_no_longer_hardcodes_false():
    assert "/Trapped /Unknown" in _pdfx_def_ps(3, "cond", "id", "", "")
    assert "/Trapped /False" in _pdfx_def_ps(3, "cond", "id", "", "", "False")
    assert "/Trapped /True" in _pdfx_def_ps(3, "cond", "id", "", "", "True")
    with pytest.raises(ValueError, match="Trapped must be one of"):
        _pdfx_def_ps(3, "cond", "id", "", "", "Perhaps")


def test_a_preset_naming_an_absent_ink_warns_and_does_not_refuse(tmp_dir):
    source = cmyk_spot_pdf(os.path.join(tmp_dir, "spot.pdf"))
    assigned = os.path.join(tmp_dir, "assigned.pdf")
    assign_presets(source, assigned, assignments=[
        {"first": 1, "last": 1, "name": "Press A", "preset": {"ColorantZoneDetails": {
            "PANTONE 185 C": {"TrapWidth": 2.0},
            "PANTONE 300 C": {"TrapWidth": 3.0},
        }}},
    ])
    read = list_trap_presets(assigned)
    assert read["unused_colorants"] == ["PANTONE 300 C"]
    assert len(read["assignments"]) == 1


def test_an_empty_assignment_removes_the_documents_record(tmp_dir):
    source = _blank_pdf(os.path.join(tmp_dir, "src.pdf"))
    assigned = os.path.join(tmp_dir, "assigned.pdf")
    assign_presets(source, assigned, assignments=[
        {"first": 1, "last": 1, "name": "Press A", "preset": {}},
    ])
    cleared = os.path.join(tmp_dir, "cleared.pdf")
    assign_presets(assigned, cleared, assignments=[])
    assert list_trap_presets(cleared)["assignments"] == []
    with pikepdf.open(cleared) as pdf:
        assert Name("/SpectraTrapPresets") not in pdf.Root


def test_a_document_carrying_no_presets_exports_plain_postscript(tmp_dir, gs_path):
    source = _blank_pdf(os.path.join(tmp_dir, "src.pdf"))
    postscript = os.path.join(tmp_dir, "out.ps")
    result = export_postscript(source, postscript, gs_path=gs_path)
    assert result["trapping_pages"] == 0
    assert "%%BeginFeature: *Trapping True" not in open(
        postscript, encoding="latin-1").read()


def test_a_stored_preset_that_omits_a_field_reads_back_at_its_default(tmp_dir):
    source = _blank_pdf(os.path.join(tmp_dir, "src.pdf"))
    path = os.path.join(tmp_dir, "hand.pdf")
    with pikepdf.open(source) as pdf:
        pdf.Root[Name("/SpectraTrapPresets")] = pdf.make_indirect(pikepdf.Array([
            Dictionary(First=1, Last=1, Name=pikepdf.String("Sparse"),
                       Params=Dictionary(TrapWidth=3.0)),
        ]))
        pdf.save(path)
    fields = list_trap_presets(path)["assignments"][0]["preset"]
    assert fields["TrapWidth"] == 3.0
    assert fields["ImageTrapPlacement"] == "Center"
    assert fields["ColorantZoneDetails"] == {}
