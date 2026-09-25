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
