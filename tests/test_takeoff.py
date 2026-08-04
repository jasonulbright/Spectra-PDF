"""N11 slice C — the count/takeoff CSV summary."""

import csv

import pikepdf
import pytest

from engine.takeoff import (
    COLUMNS,
    UNGROUPED,
    collect_count_marks,
    export_count_summary,
    summarize_counts,
)


def _count_mark(pdf: pikepdf.Pdf, page_index: int, group: str, seq: int, symbol="circle"):
    a = pikepdf.Dictionary(
        Type=pikepdf.Name("/Annot"),
        Subtype=pikepdf.Name("/Stamp"),
        Rect=pikepdf.Array([10, 10, 24, 24]),
        IT=pikepdf.Name("/Count"),
        Subj=pikepdf.String(group),
        Contents=pikepdf.String(f"{group} {seq}"),
    )
    a["/SpectraSymbol"] = pikepdf.Name("/" + symbol)
    page = pdf.pages[page_index]
    if page.obj.get("/Annots") is None:
        page.obj["/Annots"] = pdf.make_indirect(pikepdf.Array())
    page.obj["/Annots"].append(pdf.make_indirect(a))


def _plain_stamp(pdf: pikepdf.Pdf, page_index: int, label="APPROVED"):
    a = pikepdf.Dictionary(
        Type=pikepdf.Name("/Annot"),
        Subtype=pikepdf.Name("/Stamp"),
        Rect=pikepdf.Array([50, 50, 200, 80]),
        Contents=pikepdf.String(label),
    )
    page = pdf.pages[page_index]
    if page.obj.get("/Annots") is None:
        page.obj["/Annots"] = pdf.make_indirect(pikepdf.Array())
    page.obj["/Annots"].append(pdf.make_indirect(a))


@pytest.fixture()
def counted(tmp_path):
    path = tmp_path / "counted.pdf"
    pdf = pikepdf.new()
    for _ in range(3):
        pdf.add_blank_page(page_size=(400, 400))
    _count_mark(pdf, 0, "Doors", 1)
    _count_mark(pdf, 0, "Doors", 2)
    _count_mark(pdf, 0, "Windows", 1, symbol="square")
    _count_mark(pdf, 1, "Doors", 3)
    # A perfectly ordinary APPROVED stamp: /IT /Count is the whole gate, and
    # tallying this would silently inflate somebody's door count.
    _plain_stamp(pdf, 1)
    pdf.save(str(path))
    return path


def _rows(csv_path):
    with open(csv_path, newline="", encoding="utf-8") as handle:
        return list(csv.reader(handle))


def test_collects_only_count_marks(counted):
    marks = collect_count_marks(str(counted))
    assert len(marks) == 4
    assert {m["group"] for m in marks} == {"Doors", "Windows"}
    assert {m["symbol"] for m in marks} == {"circle", "square"}


def test_groups_by_subject_and_page(counted):
    rows = summarize_counts(collect_count_marks(str(counted)))
    assert [(r["group"], r["page"], r["count"]) for r in rows] == [
        ("Doors", 1, 2),
        ("Doors", 2, 1),
        ("Windows", 1, 1),
    ]


def test_writes_csv_with_header_and_totals(counted, tmp_path):
    out = tmp_path / "takeoff.csv"
    result = export_count_summary(str(counted), str(out))
    rows = _rows(out)
    assert rows[0] == COLUMNS
    assert rows[1] == ["Doors", "circle", "1", "2"]
    assert rows[-1] == ["Total", "", "", "4"]
    assert result["total"] == 4
    assert result["groups"] == 2
    assert result["rows"] == 3


def test_a_plain_stamp_is_never_counted(tmp_path):
    path = tmp_path / "stamped.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    _plain_stamp(pdf, 0)
    pdf.save(str(path))
    out = tmp_path / "takeoff.csv"
    result = export_count_summary(str(path), str(out))
    assert result["total"] == 0
    assert _rows(out) == [COLUMNS, ["Total", "", "", "0"]]


def test_a_file_with_no_annotations_writes_the_zero_total(tmp_path):
    path = tmp_path / "blank.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    pdf.save(str(path))
    out = tmp_path / "takeoff.csv"
    # An empty takeoff is an ANSWER, not an error.
    assert export_count_summary(str(path), str(out))["total"] == 0
    assert _rows(out) == [COLUMNS, ["Total", "", "", "0"]]


def test_a_mark_without_a_subject_files_under_ungrouped(tmp_path):
    path = tmp_path / "orphan.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    a = pikepdf.Dictionary(
        Type=pikepdf.Name("/Annot"),
        Subtype=pikepdf.Name("/Stamp"),
        Rect=pikepdf.Array([10, 10, 24, 24]),
        IT=pikepdf.Name("/Count"),
    )
    pdf.pages[0].obj["/Annots"] = pdf.make_indirect(pikepdf.Array([pdf.make_indirect(a)]))
    pdf.save(str(path))
    # Dropping it would UNDER-report a total the file plainly carries.
    rows = summarize_counts(collect_count_marks(str(path)))
    assert [(r["group"], r["count"]) for r in rows] == [(UNGROUPED, 1)]


def test_refuses_a_missing_output_folder(counted, tmp_path):
    with pytest.raises(ValueError):
        export_count_summary(str(counted), str(tmp_path / "nope" / "takeoff.csv"))


def test_group_names_pass_through_verbatim(tmp_path):
    path = tmp_path / "es.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    _count_mark(pdf, 0, "puertas de garaje", 1)
    pdf.save(str(path))
    out = tmp_path / "takeoff.csv"
    export_count_summary(str(path), str(out))
    # User data: never translated, never normalized.
    assert _rows(out)[1][0] == "puertas de garaje"
