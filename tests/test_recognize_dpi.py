"""The resolution a page is rasterised at for OCR.

A page that draws one picture and nothing else is read at that picture's
effective resolution on the page times the headroom, clamped to
[OCR_MIN_DPI, OCR_DPI]; every other page keeps the flat OCR_DPI. Needs no
Ghostscript or tesseract: only the page's structure is read.
"""

import inspect
from decimal import Decimal

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


def _image(pdf, width, height, *, bpc=8, colorspace="/DeviceGray", smask=False,
           indexed=False, image_mask=False):
    """An image XObject of `width` x `height` samples."""
    if image_mask:
        img = pikepdf.Stream(pdf, b"\xff" * (((width + 7) // 8) * height))
        img.ImageMask = True
    else:
        if indexed:
            colorspace = pikepdf.Array(
                [pikepdf.Name.Indexed, pikepdf.Name.DeviceRGB, 1,
                 pikepdf.String(b"\x00\x00\x00\xff\xff\xff")]
            )
        row = (width * bpc + 7) // 8
        img = pikepdf.Stream(pdf, b"\xff" * (row * height))
        img.BitsPerComponent = bpc
        img.ColorSpace = pikepdf.Name(colorspace) if isinstance(colorspace, str) else colorspace
    img.Type = pikepdf.Name.XObject
    img.Subtype = pikepdf.Name.Image
    img.Width = width
    img.Height = height
    if smask:
        alpha = pikepdf.Stream(pdf, b"\xff" * (width * height))
        alpha.Type = pikepdf.Name.XObject
        alpha.Subtype = pikepdf.Name.Image
        alpha.Width = width
        alpha.Height = height
        alpha.BitsPerComponent = 8
        alpha.ColorSpace = pikepdf.Name.DeviceGray
        img.SMask = pdf.make_indirect(alpha)
    return pdf.make_indirect(img)


def _helvetica(pdf):
    return pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))


def _placed_pdf(path, content: bytes, *, width=1200, height=900, media=(0, 0, 900, 675),
                page_extra=None, annots=None, **image_kw):
    """One page drawing image /Im0 through `content`."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(media[2] - media[0], media[3] - media[1]))
    page.MediaBox = pikepdf.Array(list(media))
    page.Resources = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im0=_image(pdf, width, height, **image_kw)),
        Font=pikepdf.Dictionary(F1=_helvetica(pdf)),
    )
    page.Contents = pdf.make_stream(content)
    for key, value in (page_extra or {}).items():
        page.obj[key] = value
    if annots:
        page.obj.Annots = pdf.make_indirect(
            pikepdf.Array([pdf.make_indirect(pikepdf.Dictionary(a)) for a in annots])
        )
    pdf.save(path)
    return str(path)


# 1200 x 900 samples drawn over 900 x 675 pt is 96 dpi on both axes.
_UPRIGHT_96 = b"q 900 0 0 675 0 0 cm /Im0 Do Q"


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


class TestThePictureIsJudgedByItsPlacementNotItsEncoding:
    """A screenshot or a fax is one picture whatever its sample format."""

    def test_a_screenshot_with_an_alpha_channel(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf", _UPRIGHT_96, colorspace="/DeviceRGB", smask=True)
        assert _ocr_dpi_for_page(path, 1) == OCR_MIN_DPI

    def test_a_palette_screenshot(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf", _UPRIGHT_96, indexed=True)
        assert _ocr_dpi_for_page(path, 1) == OCR_MIN_DPI

    def test_a_one_bit_picture(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf", _UPRIGHT_96, bpc=1)
        assert _ocr_dpi_for_page(path, 1) == OCR_MIN_DPI

    def test_a_stencil_mask_picture(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf", b"q 0 g 900 0 0 675 0 0 cm /Im0 Do Q",
                           image_mask=True)
        assert _ocr_dpi_for_page(path, 1) == OCR_MIN_DPI

    def test_a_picture_placed_a_quarter_turn(self, tmp_path):
        # Sample rows run up the page: 1200 samples over 675 pt (128 dpi) and
        # 900 samples over 900 pt (72 dpi); the denser axis decides.
        path = _placed_pdf(tmp_path / "a.pdf", b"q 0 675 -900 0 900 0 cm /Im0 Do Q")
        assert _ocr_dpi_for_page(path, 1) == round(128 * OCR_SOURCE_HEADROOM)

    def test_a_picture_drawn_inside_a_form(self, tmp_path):
        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(900, 675))
        form = pdf.make_stream(_UPRIGHT_96)
        form.Type = pikepdf.Name.XObject
        form.Subtype = pikepdf.Name.Form
        form.BBox = pikepdf.Array([0, 0, 900, 675])
        form.Resources = pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=_image(pdf, 1200, 900))
        )
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm0=form))
        page.Contents = pdf.make_stream(b"/Fm0 Do")
        pdf.save(tmp_path / "a.pdf")
        assert _ocr_dpi_for_page(str(tmp_path / "a.pdf"), 1) == OCR_MIN_DPI

    def test_an_inline_picture(self, tmp_path):
        pdf = pikepdf.Pdf.new()
        page = pdf.add_blank_page(page_size=(150, 75))
        # 200 x 100 one-bit samples over 150 x 75 pt: 96 dpi.
        page.Contents = pdf.make_stream(
            b"q 150 0 0 75 0 0 cm BI /W 200 /H 100 /BPC 1 /CS /G ID "
            + b"\xff" * (25 * 100) + b" EI Q"
        )
        pdf.save(tmp_path / "a.pdf")
        assert _ocr_dpi_for_page(str(tmp_path / "a.pdf"), 1) == OCR_MIN_DPI

    def test_a_picture_that_does_not_fill_the_page(self, tmp_path):
        # 1200 x 900 samples over 600 x 450 pt on a letter page: 144 dpi.
        path = _placed_pdf(tmp_path / "a.pdf", b"q 600 0 0 450 6 300 cm /Im0 Do Q",
                           media=(0, 0, 612, 792))
        assert _ocr_dpi_for_page(path, 1) == round(144 * OCR_SOURCE_HEADROOM)


class TestTheResolutionIsTheOneOnThePage:
    def test_non_square_samples_use_the_denser_axis(self, tmp_path):
        # A standard-mode fax: 1728 x 1100 samples over 612 x 792 pt is about
        # 203 dpi across and 100 dpi down.
        path = _placed_pdf(tmp_path / "a.pdf", b"q 612 0 0 792 0 0 cm /Im0 Do Q",
                           width=1728, height=1100, media=(0, 0, 612, 792), bpc=1)
        assert _ocr_dpi_for_page(path, 1) == OCR_DPI

    def test_the_denser_axis_wins_when_it_is_the_vertical_one(self, tmp_path):
        # 900 x 1200 samples over 900 x 675 pt: 72 dpi across, 128 dpi down.
        path = _placed_pdf(tmp_path / "a.pdf", _UPRIGHT_96, width=900, height=1200)
        assert _ocr_dpi_for_page(path, 1) == round(128 * OCR_SOURCE_HEADROOM)

    def test_page_rotation_does_not_change_the_density(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf", _UPRIGHT_96, width=1800, height=1350,
                           page_extra={"/Rotate": 90})
        assert _ocr_dpi_for_page(path, 1) == round(144 * OCR_SOURCE_HEADROOM)

    def test_a_crop_box_inside_the_media_box_does_not_change_the_density(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf", _UPRIGHT_96, width=1800, height=1350,
                           page_extra={"/CropBox": pikepdf.Array([100, 100, 500, 400])})
        assert _ocr_dpi_for_page(path, 1) == round(144 * OCR_SOURCE_HEADROOM)

    def test_user_unit_scales_the_page_inch(self, tmp_path):
        # 2400 samples over 900 units of 2/72 in is 96 dpi; reading the units
        # as points gives 192 dpi and renders at the cap.
        path = _placed_pdf(tmp_path / "a.pdf", _UPRIGHT_96, width=2400, height=1800,
                           page_extra={"/UserUnit": 2})
        assert _ocr_dpi_for_page(path, 1) == OCR_MIN_DPI


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

    def test_page_zero_does_not_wrap_to_the_last_page(self, tmp_path):
        assert _ocr_dpi_for_page(_picture_pdf(tmp_path / "a.pdf", 96), 0) == OCR_DPI

    def test_visible_text_beside_the_picture(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf",
                           _UPRIGHT_96 + b" BT /F1 8 Tf 10 10 Td (x) Tj ET")
        assert _ocr_dpi_for_page(path, 1) == OCR_DPI

    def test_an_invisible_text_layer_does_not_count(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf",
                           _UPRIGHT_96 + b" BT 3 Tr /F1 8 Tf 10 10 Td (x) Tj ET")
        assert _ocr_dpi_for_page(path, 1) == OCR_MIN_DPI

    def test_vector_art_beside_the_picture(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf", _UPRIGHT_96 + b" 0 0 10 10 re f")
        assert _ocr_dpi_for_page(path, 1) == OCR_DPI

    def test_two_pictures(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf",
                           _UPRIGHT_96 + b" q 90 0 0 67 0 0 cm /Im0 Do Q")
        assert _ocr_dpi_for_page(path, 1) == OCR_DPI

    def test_an_inline_picture_beside_an_image_xobject(self, tmp_path):
        path = _placed_pdf(
            tmp_path / "a.pdf",
            _UPRIGHT_96 + b" q 8 0 0 8 0 0 cm BI /W 8 /H 8 /BPC 1 /CS /G ID "
            + b"\xff" * 8 + b" EI Q",
        )
        assert _ocr_dpi_for_page(path, 1) == OCR_DPI

    def test_a_visible_annotation_renders_with_the_page(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf", _UPRIGHT_96, annots=[{
            "/Type": pikepdf.Name.Annot, "/Subtype": pikepdf.Name.FreeText,
            "/Rect": pikepdf.Array([10, 10, 200, 40]), "/Contents": pikepdf.String("note"),
            "/DA": pikepdf.String("/Helv 8 Tf 0 g"),
        }])
        assert _ocr_dpi_for_page(path, 1) == OCR_DPI

    @pytest.mark.parametrize("flags", [2, 32])
    def test_a_hidden_annotation_does_not_count(self, tmp_path, flags):
        path = _placed_pdf(tmp_path / "a.pdf", _UPRIGHT_96, annots=[{
            "/Type": pikepdf.Name.Annot, "/Subtype": pikepdf.Name.FreeText,
            "/Rect": pikepdf.Array([10, 10, 200, 40]), "/F": flags,
        }])
        assert _ocr_dpi_for_page(path, 1) == OCR_MIN_DPI

    def test_a_popup_does_not_count(self, tmp_path):
        path = _placed_pdf(tmp_path / "a.pdf", _UPRIGHT_96, annots=[{
            "/Type": pikepdf.Name.Annot, "/Subtype": pikepdf.Name.Popup,
            "/Rect": pikepdf.Array([10, 10, 200, 40]),
        }])
        assert _ocr_dpi_for_page(path, 1) == OCR_MIN_DPI


    def test_a_density_that_overflows_with_the_headroom(self, tmp_path):
        # 1200 samples over 1e-150 * 5.76e-154 pt is about 1.5e308 dpi: finite,
        # but times the headroom it is inf, and round(inf) raises.
        def plain(value: str) -> bytes:
            return format(Decimal(value), "f").encode()

        outer, inner = plain("1e-150"), plain("5.76e-154")
        path = _placed_pdf(
            tmp_path / "a.pdf",
            b"q " + outer + b" 0 0 " + outer + b" 0 0 cm "
            + inner + b" 0 0 " + inner + b" 0 0 cm /Im0 Do Q",
        )
        assert _ocr_dpi_for_page(path, 1) == OCR_DPI

class TestEncryptedDocuments:
    @staticmethod
    def _encrypted(tmp_path):
        source = _picture_pdf(tmp_path / "plain.pdf", 96)
        target = tmp_path / "locked.pdf"
        with pikepdf.open(source) as pdf:
            pdf.save(target, encryption=pikepdf.Encryption(user="u", owner="o"))
        return str(target)

    def test_without_the_password_the_flat_density_is_used(self, tmp_path):
        assert _ocr_dpi_for_page(self._encrypted(tmp_path), 1) == OCR_DPI

    def test_the_stored_password_is_replayed(self, tmp_path):
        from engine import credentials

        path = self._encrypted(tmp_path)
        credentials.open_document(path, "u")
        try:
            assert _ocr_dpi_for_page(path, 1) == OCR_MIN_DPI
        finally:
            credentials.close_document(path)


class TestTheRasterIsStillTheDefault:
    def test_render_defaults_to_the_flat_density_other_callers_assume(self):
        # form_detect sizes its stroke threshold from OCR_DPI and calls this with
        # no density: it must keep rendering at OCR_DPI.
        assert inspect.signature(_render_page_png).parameters["dpi"].default == OCR_DPI

    def test_the_floor_and_headroom_are_sane(self):
        assert 0 < OCR_MIN_DPI <= OCR_DPI
        assert OCR_SOURCE_HEADROOM >= 1.0
        assert recognize.OCR_DPI == 300
