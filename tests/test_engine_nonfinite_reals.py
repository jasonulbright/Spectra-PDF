"""A PDF real too large for a double reads as infinity, and two of them
subtract to NaN. The response encoder refuses non-finite numbers, so one such
value inside a listing fails the whole call unless the reader drops or nulls
it where it is read. Each listing below keeps its readable entries."""

import json

import pytest

from engine import annotations, forms, inspect, links, outline, page_images, page_vectors, threads

H = "9" * 400 + ".0"


def _write(path, content: str) -> str:
    objs = [
        "<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /Threads [10 0 R] /AcroForm << /Fields [12 0 R] >> >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R "
        "/Annots [6 0 R 7 0 R 12 0 R] /B [11 0 R] "
        "/Resources << /XObject << /Im1 13 0 R >> >> >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {H} 792] >>",
        f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
        f"<< /Type /Annot /Subtype /Square /Rect [0 0 {H} 10] >>",
        f"<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest [3 0 R /XYZ {H} 5 0] >>",
        "<< /Type /Outlines /First 9 0 R /Last 9 0 R /Count 1 >>",
        f"<< /Title (x) /Parent 8 0 R /Dest [3 0 R /XYZ 0 {H} null] >>",
        "<< /Type /Thread /F 11 0 R >>",
        f"<< /Type /Bead /T 10 0 R /N 11 0 R /V 11 0 R /P 3 0 R /R [0 0 {H} 10] >>",
        f"<< /Type /Annot /Subtype /Widget /FT /Tx /T (f) /P 3 0 R /Rect [0 0 {H} 10] >>",
        "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray "
        "/BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream",
    ]
    out = "%PDF-1.7\n"
    for i, o in enumerate(objs, 1):
        out += f"{i} 0 obj\n{o}\nendobj\n"
    out += "trailer\n<< /Root 1 0 R /Size 14 >>\n%%EOF\n"
    target = path / "overflow.pdf"
    target.write_bytes(out.encode("latin-1"))
    return str(target)


CONTENT = (
    f"0 0 {H} 1 re f 0 0 5 5 re f "
    f"q {H} 0 0 1 0 0 cm /Im1 Do Q q 10 0 0 10 0 0 cm /Im1 Do Q"
)


@pytest.fixture
def doc(tmp_path):
    return _write(tmp_path, CONTENT)


def _encodes(result) -> None:
    json.dumps(result, allow_nan=False)


def test_page_sizes_null_the_unreadable_box_and_keep_the_count(doc):
    result = inspect.get_page_count(doc)
    _encodes(result)
    assert result["pages"] == 2
    assert result["page_sizes"][0] == {"width": 612.0, "height": 792.0}
    assert result["page_sizes"][1] == {"width": None, "height": 792.0}
    info = inspect.get_page_info(doc, 2)
    _encodes(info)
    assert info["width"] is None and info["height"] == 792.0


def test_annotation_rect_is_unreadable_not_infinite(doc):
    result = annotations.list_annotations(doc)
    _encodes(result)


def test_link_destination_keeps_its_readable_coordinates(doc):
    result = links.list_links(doc)
    _encodes(result)
    assert result["links"], result


def test_outline_destination_keeps_its_readable_coordinates(doc):
    result = outline.get_outline(doc)
    _encodes(result)
    assert json.dumps(result).count("null") >= 1


def test_thread_bead_and_widget_rects(doc):
    _encodes(threads.list_threads(doc))
    _encodes(forms.read_form_fields(doc))


def test_vector_listings_omit_only_the_infinite_path(doc):
    vectors = page_vectors.list_page_vectors(doc, 1)
    _encodes(vectors)
    assert [v["index"] for v in vectors["vectors"]] == [1]
    geometry = page_vectors.list_page_geometry(doc, 1)
    _encodes(geometry)
    assert [path["kind"] for path in geometry["paths"]] == ["fill", "placement"]


def test_image_listing_omits_only_the_infinite_placement(doc):
    result = page_images.list_page_images(doc, 1)
    _encodes(result)
    assert [image["index"] for image in result["images"]] == [1]


def _write_text_doc(path, content: str) -> str:
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R "
        "/Resources << /Font << /F1 6 0 R /F2 7 0 R >> >> /Annots [8 0 R] >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {H} {H}] /TrimBox [0 0 {H} 10] >>",
        f"<< /Length {len(content)} >>\nstream\n{content}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 72 /LastChar 105 "
        f"/Widths [{' '.join([H] * 34)}] >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Type /Annot /Subtype /Text /Contents (note) /Rect [0 0 {H} 10] >>",
    ]
    out = "%PDF-1.7\n"
    for i, o in enumerate(objs, 1):
        out += f"{i} 0 obj\n{o}\nendobj\n"
    out += "trailer\n<< /Root 1 0 R /Size 9 >>\n%%EOF\n"
    target = path / "overflow-text.pdf"
    target.write_bytes(out.encode("latin-1"))
    return str(target)


TEXT_CONTENT = (
    "BT /F2 12 Tf 10 700 Td (Keep me) Tj ET "
    f"BT /F2 {H} Tf 10 600 Td (Size) Tj ET "
    f"BT /F2 12 Tf {H} 500 Td (Move) Tj ET "
    f"BT /F2 12 Tf {H} 0 0 1 10 400 Tm (Matrix) Tj ET "
    f"BT /F2 12 Tf {H} Tc {H} Tw {H} TL {H} Tz 10 300 Td (Spacing) Tj ET "
    f"BT /F2 12 Tf 10 200 Td [(Ke) -{H} (rn)] TJ ET "
    "BT /F1 12 Tf 10 100 Td (Hi) Tj ET "
    f"q {H} 0 0 {H} 0 0 cm BT /F2 12 Tf 10 50 Td (Scaled) Tj ET Q "
    f"0 0 {H} 1 re f"
)


@pytest.fixture
def text_doc(tmp_path):
    return _write_text_doc(tmp_path, TEXT_CONTENT)


def test_text_listing_keeps_every_run_with_finite_geometry(text_doc):
    from engine import text_paragraphs

    result = text_paragraphs.list_text_paragraphs(text_doc, 1)
    _encodes(result)
    texts = [run["text"] for run in result["runs"]]
    assert texts == ["Keep me", "Size", "Move", "Matrix", "Spacing", "Kern", "Hi", "Scaled"]
    assert [run["index"] for run in result["runs"]] == list(range(8))


def test_read_aloud_keeps_the_readable_text(text_doc):
    from engine import read_aloud

    result = read_aloud.read_aloud_page(text_doc, 1)
    _encodes(result)
    assert "Keep me" in json.dumps(result)


def test_accessibility_report_encodes(text_doc):
    from engine import accessibility

    _encodes(accessibility.check_accessibility(text_doc))


def test_transparency_bounds_overflowing_objects_by_the_page(text_doc):
    from engine import flattener

    result = flattener.list_transparency(text_doc)
    _encodes(result)
    first, second = result["pages"]
    assert first["error"] is None
    assert all(o["rect"][2] <= 612.0 for o in first["objects"])
    assert second["error"] and second["objects"] == []


def test_printer_marks_treat_an_overflowing_box_as_absent(text_doc):
    from engine import printer_marks

    result = printer_marks.list_printer_marks(text_doc)
    _encodes(result)
    second = result["pages"][1]
    assert second["media"] == [] and second["trim_source"] == "default"


def _write_form_doc(path) -> str:
    form = "BT /F2 12 Tf 1 1 Td (In form) Tj ET"
    page = "BT /F2 12 Tf 10 700 Td (Keep me) Tj ET q /X0 Do Q"
    objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        "/Resources << /Font << /F2 5 0 R >> /XObject << /X0 6 0 R >> >> >>",
        f"<< /Length {len(page)} >>\nstream\n{page}\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [{H} 0 0 {H} 0 0] "
        f"/Resources << /Font << /F2 5 0 R >> >> /Length {len(form)} >>\nstream\n{form}\nendstream",
    ]
    out = "%PDF-1.7\n"
    for i, o in enumerate(objs, 1):
        out += f"{i} 0 obj\n{o}\nendobj\n"
    out += "trailer\n<< /Root 1 0 R /Size 7 >>\n%%EOF\n"
    target = path / "overflow-form.pdf"
    target.write_bytes(out.encode("latin-1"))
    return str(target)


def test_a_form_whose_matrix_overflows_lists_its_text_under_the_identity(tmp_path):
    from engine import text_paragraphs, text_runs

    source = _write_form_doc(tmp_path)
    runs = text_runs.list_text_runs(source, 1)
    _encodes(runs)
    assert [run["text"] for run in runs["runs"]] == ["Keep me", "In form"]
    paragraphs = text_paragraphs.list_text_paragraphs(source, 1)
    _encodes(paragraphs)
    assert [run["text"] for run in paragraphs["runs"]] == ["Keep me", "In form"]
    edited = str(tmp_path / "edited.pdf")
    text_runs.replace_text_run(source, edited, 1, 1, "In it")
    after = text_runs.list_text_runs(edited, 1)
    _encodes(after)
    assert [run["text"] for run in after["runs"]] == ["Keep me", "In it"]
