"""The resolution a page is rasterised at for OCR.

A page that is one placed picture is read at that picture's own resolution
times the headroom, clamped to [OCR_MIN_DPI, OCR_DPI]; every other page keeps
the flat OCR_DPI. Needs no Ghostscript or tesseract: only the page's structure
is read.
"""

import inspect

import pikepdf
import pytest
from PIL import Image

from engine import recognize
from engine.recognize import (
    OCR_DPI,
    OCR_MIN_DPI,
    OCR_SOURCE_HEADROOM,
    _ocr_dpi_for_page,
    _render_page_png,
)


def _picture_pdf(path, source_dpi: float, width: int = 1200, height: int = 900):
    """A one-page PDF that is a single image stored at `source_dpi`."""
    Image.new("L", (width, height), 255).save(path, resolution=source_dpi)
    return str(path)


def _text_pdf(path):
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    font = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
                           BaseFont=pikepdf.Name.Helvetica)
    )
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    page.Contents = pdf.make_stream(b"BT /F1 12 Tf 72 700 Td (Hello) Tj ET")
    pdf.save(path)
    return str(path)


class TestPictureOnlyPages:
    def test_a_screenshot_at_96_dpi_is_read_at_the_150_floor(self, tmp_path):
        # 96 x 1.5 = 144, below the floor: 1.56x the source pixels, not 3.1x.
        assert _ocr_dpi_for_page(_picture_pdf(tmp_path / "a.pdf", 96), 1) == OCR_MIN_DPI

    def test_a_low_resolution_picture_is_not_rendered_too_small(self, tmp_path):
        assert _ocr_dpi_for_page(_picture_pdf(tmp_path / "a.pdf", 72), 1) == OCR_MIN_DPI

    def test_a_mid_resolution_picture_gets_the_headroom(self, tmp_path):
        got = _ocr_dpi_for_page(_picture_pdf(tmp_path / "a.pdf", 150), 1)
        assert got == round(150 * OCR_SOURCE_HEADROOM) == 225

    def test_a_200_dpi_fax_is_read_at_the_cap(self, tmp_path):
        assert _ocr_dpi_for_page(_picture_pdf(tmp_path / "a.pdf", 200), 1) == OCR_DPI

    @pytest.mark.parametrize("dpi", [300, 400, 600])
    def test_a_real_scan_is_unchanged(self, tmp_path, dpi):
        assert _ocr_dpi_for_page(_picture_pdf(tmp_path / "a.pdf", dpi), 1) == OCR_DPI


class TestEverythingElseKeepsTheFlatDensity:
    def test_a_text_page(self, tmp_path):
        assert _ocr_dpi_for_page(_text_pdf(tmp_path / "t.pdf"), 1) == OCR_DPI

    def test_a_file_that_is_not_a_pdf(self, tmp_path):
        bad = tmp_path / "x.pdf"
        bad.write_bytes(b"not a pdf")
        assert _ocr_dpi_for_page(str(bad), 1) == OCR_DPI

    def test_a_missing_file(self, tmp_path):
        assert _ocr_dpi_for_page(str(tmp_path / "gone.pdf"), 1) == OCR_DPI

    def test_a_page_past_the_end(self, tmp_path):
        assert _ocr_dpi_for_page(_picture_pdf(tmp_path / "a.pdf", 96), 9) == OCR_DPI


class TestTheRasterIsStillTheDefault:
    def test_render_defaults_to_the_flat_density_other_callers_assume(self):
        # form_detect sizes its stroke threshold from OCR_DPI and calls this with
        # no density: it must keep rendering at OCR_DPI.
        assert inspect.signature(_render_page_png).parameters["dpi"].default == OCR_DPI

    def test_the_floor_and_headroom_are_sane(self):
        assert 0 < OCR_MIN_DPI <= OCR_DPI
        assert OCR_SOURCE_HEADROOM >= 1.0
        assert recognize.OCR_DPI == 300
