"""Tests for the document image-resolution summary."""

import math
import zlib

import pikepdf
from pikepdf import Dictionary, Name

from engine.image_resolution import summarize_image_resolution


def _gray_image(pdf, w, h, value=128):
    """A flate 8-bit grayscale image XObject of exactly w x h pixels."""
    stream = pdf.make_stream(zlib.compress(bytes([value]) * (w * h)))
    stream["/Type"] = Name("/XObject")
    stream["/Subtype"] = Name("/Image")
    stream["/Width"] = w
    stream["/Height"] = h
    stream["/ColorSpace"] = Name("/DeviceGray")
    stream["/BitsPerComponent"] = 8
    stream["/Filter"] = Name("/FlateDecode")
    return pdf.make_indirect(stream)


def _known_dpi_page(path):
    """One page, three placements with arithmetic anyone can check:

    /Im300  300x300 px in a 72x72 pt box  -> 300 dpi both axes
    /Im150  300x300 px in a 144x144 pt box -> 150 dpi both axes
    /ImAniso 300x150 px in a 72x72 pt box -> 300 x, 150 y (limiting 150)
    """
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    square = _gray_image(pdf, 300, 300)
    aniso = _gray_image(pdf, 300, 150)
    page.obj["/Resources"] = Dictionary(XObject=Dictionary(Sq=square, An=aniso))
    page.Contents = pdf.make_stream(
        b"q 72 0 0 72 20 700 cm /Sq Do Q "
        b"q 144 0 0 144 20 500 cm /Sq Do Q "
        b"q 72 0 0 72 300 700 cm /An Do Q"
    )
    pdf.save(path)
    pdf.close()


def test_effective_dpi_is_pixels_over_placed_inches(tmp_path):
    src = tmp_path / "known.pdf"
    _known_dpi_page(src)
    report = summarize_image_resolution(str(src))

    assert report["images"] == 3
    assert report["unmeasured"] == 0
    assert report["pages"] == 1
    by_index = {p["index"]: p for p in report["placements"]}
    assert by_index[0]["dpi_x"] == 300 and by_index[0]["dpi_y"] == 300
    assert by_index[1]["dpi_x"] == 150 and by_index[1]["dpi_y"] == 150
    # The anisotropic placement reports both axes and ranks by the LIMITING one.
    assert by_index[2]["dpi_x"] == 300 and by_index[2]["dpi_y"] == 150
    assert by_index[2]["dpi"] == 150

    assert report["min_dpi"] == 150
    assert report["max_dpi"] == 300
    # Three values (300, 150, 150) -> the middle of the sorted list.
    assert report["median_dpi"] == 150


def test_median_takes_the_lower_middle_value(tmp_path):
    """An even count reports a DPI a placement actually has, never an average
    of two."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    # 100, 200, 300, 400 dpi: four 100x100 px draws in shrinking boxes.
    page.obj["/Resources"] = Dictionary(XObject=Dictionary(Im=_gray_image(pdf, 100, 100)))
    body = b""
    for i, box in enumerate((72.0, 36.0, 24.0, 18.0)):
        body += f"q {box} 0 0 {box} {20 + i * 80} 600 cm /Im Do Q ".encode()
    page.Contents = pdf.make_stream(body)
    src = tmp_path / "even.pdf"
    pdf.save(src)
    pdf.close()

    report = summarize_image_resolution(str(src))
    assert sorted(p["dpi"] for p in report["placements"]) == [100, 200, 300, 400]
    assert report["median_dpi"] == 200
    assert report["min_dpi"] == 100
    assert report["max_dpi"] == 400


def test_rotated_placement_measures_the_drawn_edges_not_the_bounding_box(tmp_path):
    """A 45-degree placement's bbox is ~1.41x its drawn edges, so a
    bbox-derived DPI would under-report it by that factor."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page.obj["/Resources"] = Dictionary(XObject=Dictionary(Im=_gray_image(pdf, 300, 300)))
    k = 72.0 * math.sqrt(0.5)
    page.Contents = pdf.make_stream(f"q {k} {k} {-k} {k} 300 400 cm /Im Do Q".encode())
    src = tmp_path / "rotated.pdf"
    pdf.save(src)
    pdf.close()

    report = summarize_image_resolution(str(src))
    assert report["images"] == 1
    assert report["placements"][0]["dpi"] == 300
    # The bbox answer, for contrast: 300 * 72 / (72 * sqrt(2)) ~= 212.
    assert report["placements"][0]["dpi"] != 212


def test_degenerate_placement_is_counted_not_measured(tmp_path):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page.obj["/Resources"] = Dictionary(XObject=Dictionary(Im=_gray_image(pdf, 300, 300)))
    page.Contents = pdf.make_stream(
        b"q 72 0 0 72 20 700 cm /Im Do Q q 0 0 0 0 20 500 cm /Im Do Q"
    )
    src = tmp_path / "degenerate.pdf"
    pdf.save(src)
    pdf.close()

    report = summarize_image_resolution(str(src))
    assert report["images"] == 1
    assert report["unmeasured"] == 1
    assert report["min_dpi"] == 300


def test_a_document_with_no_images_reports_nulls(tmp_path):
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    src = tmp_path / "blank.pdf"
    pdf.save(src)
    pdf.close()

    report = summarize_image_resolution(str(src))
    assert report["images"] == 0
    assert report["min_dpi"] is None
    assert report["median_dpi"] is None
    assert report["max_dpi"] is None
    assert report["scan_pages"] == 0


def test_scan_pages_follows_the_mrc_classifier(tmp_path):
    """Page 1 is one full-page image (a scan); page 2 draws the same image
    small beside text, which the classifier refuses."""
    pdf = pikepdf.new()
    scan = _gray_image(pdf, 1275, 1650)  # 150 dpi over US Letter

    page_a = pdf.add_blank_page(page_size=(612, 792))
    page_a.obj["/Resources"] = Dictionary(XObject=Dictionary(Im=scan))
    page_a.Contents = pdf.make_stream(b"q 612 0 0 792 0 0 cm /Im Do Q")

    page_b = pdf.add_blank_page(page_size=(612, 792))
    page_b.obj["/Resources"] = Dictionary(
        XObject=Dictionary(Im=scan), Font=Dictionary(F1=pdf.make_indirect(
            Dictionary(Type=Name("/Font"), Subtype=Name("/Type1"), BaseFont=Name("/Helvetica"))
        ))
    )
    page_b.Contents = pdf.make_stream(
        b"q 100 0 0 100 20 600 cm /Im Do Q BT /F1 12 Tf 20 100 Td (visible) Tj ET"
    )

    src = tmp_path / "mixed.pdf"
    pdf.save(src)
    pdf.close()

    report = summarize_image_resolution(str(src))
    assert report["pages"] == 2
    assert report["images"] == 2
    assert report["scan_pages"] == 1
    # One image, two placements, two resolutions: 1275 px over 612 pt is 150
    # dpi, and the same pixels squeezed into 100 pt is 918.
    assert report["min_dpi"] == 150
    assert report["max_dpi"] == 918


def test_clipped_and_vector_placements_are_not_raster_resolution(tmp_path):
    """A placement wholly outside the active clip is invisible, so its scale
    is not a fact about the page."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page.obj["/Resources"] = Dictionary(XObject=Dictionary(Im=_gray_image(pdf, 300, 300)))
    page.Contents = pdf.make_stream(
        b"q 72 0 0 72 20 700 cm /Im Do Q "
        b"q 0 0 10 10 re W n q 400 0 0 400 100 100 cm /Im Do Q Q"
    )
    src = tmp_path / "clipped.pdf"
    pdf.save(src)
    pdf.close()

    report = summarize_image_resolution(str(src))
    assert report["images"] == 1
    assert report["placements"][0]["dpi"] == 300
