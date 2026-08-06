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

from engine.form_authoring import FieldSpecError
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
