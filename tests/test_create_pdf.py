"""P22 slice A — the image arm of Create PDF (brief 41 § 9 A, § 10).

The pins that matter here are the two the recon measured as LIVE defects:
a multi-frame TIFF must produce one page PER FRAME (it produced one page,
full stop, in shipped batch OCR), and every page must be sized from its own
stored DPI (Pillow's `save_all` gives every frame the FIRST frame's).
"""

from __future__ import annotations

import io
import os
from pathlib import Path

import pikepdf
import pytest
from PIL import Image

from engine import create_pdf as create_pdf_mod
from engine.create_pdf import (
    HEIF_SUFFIXES,
    IMAGE_SUFFIXES,
    accepted_image_suffixes,
    image_to_pdf,
    is_image,
)


def boxes(path) -> list[list[float]]:
    with pikepdf.open(str(path)) as pdf:
        return [[round(float(v), 2) for v in p["/MediaBox"]] for p in pdf.pages]


def first_image(path):
    """The first page's sole image XObject, as (filter, colorspace, bpc)."""
    with pikepdf.open(str(path)) as pdf:
        xo = pdf.pages[0]["/Resources"]["/XObject"]
        obj = xo[list(xo.keys())[0]]
        return str(obj.get("/Filter")), str(obj.get("/ColorSpace")), obj.get("/BitsPerComponent")


def gray(size, value=200):
    return Image.new("L", size, value)


class TestDpiHonesty:
    def test_a_300_dpi_png_becomes_a_letter_page(self, tmp_dir):
        src = Path(tmp_dir) / "scan.png"
        gray((2550, 3300)).save(src, dpi=(300, 300))
        out = Path(tmp_dir) / "scan.pdf"
        report = image_to_pdf(src, out)
        assert report["pages"] == 1
        assert boxes(out) == [[0.0, 0.0, 612.0, 792.0]]
        assert report["page_size"] == [612.0, 792.0]
        assert report["dpi"] == [300.0]

    def test_a_150_dpi_jpeg_becomes_a_double_size_page(self, tmp_dir):
        # The same physical picture at half the resolution is TWICE the page:
        # the wrap must never normalise silently to a paper size.
        src = Path(tmp_dir) / "half.jpg"
        Image.new("RGB", (2550, 3300), (240, 240, 240)).save(src, dpi=(150, 150))
        out = Path(tmp_dir) / "half.pdf"
        image_to_pdf(src, out)
        assert boxes(out) == [[0.0, 0.0, 1224.0, 1584.0]]

    def test_an_image_with_no_stored_dpi_uses_the_default(self, tmp_dir):
        src = Path(tmp_dir) / "bare.png"
        gray((400, 200)).save(src)  # no dpi written
        out = Path(tmp_dir) / "bare.pdf"
        image_to_pdf(src, out, dpi_default=100.0)
        assert boxes(out) == [[0.0, 0.0, 288.0, 144.0]]

    def test_a_placeholder_dpi_of_one_is_not_believed(self, tmp_dir):
        # TIFF writes 0/1 for "unset"; honouring it would produce a page
        # metres across.
        src = Path(tmp_dir) / "unset.tif"
        gray((400, 200)).save(src, dpi=(1, 1))
        out = Path(tmp_dir) / "unset.pdf"
        image_to_pdf(src, out, dpi_default=200.0)
        assert boxes(out) == [[0.0, 0.0, 144.0, 72.0]]

    def test_a_non_positive_default_refuses(self, tmp_dir):
        src = Path(tmp_dir) / "x.png"
        gray((10, 10)).save(src)
        with pytest.raises(ValueError, match="positive number"):
            image_to_pdf(src, Path(tmp_dir) / "x.pdf", dpi_default=0)


class TestEveryFrameIsAPage:
    def test_a_three_frame_tiff_produces_three_pages(self, tmp_dir):
        # THE pin that fails on the pre-P22 code: `im.save(..., "PDF")` with no
        # save_all wrote frame 1 and silently dropped frames 2 and 3 — silent
        # data loss in the shipped batch-OCR feature, not only a Create PDF gap.
        src = Path(tmp_dir) / "fax.tif"
        frames = [gray((900, 1200), v) for v in (240, 200, 160)]
        frames[0].save(src, save_all=True, append_images=frames[1:], dpi=(300, 300))
        out = Path(tmp_dir) / "fax.pdf"
        report = image_to_pdf(src, out)
        assert report["pages"] == 3
        assert boxes(out) == [[0.0, 0.0, 216.0, 288.0]] * 3

    def test_each_frame_keeps_its_own_dpi(self, tmp_dir):
        """The discriminating case for rule 3.

        A TIFF stores resolution PER FRAME and Pillow reads it back per frame
        (measured). Frame 2 here is 300 px at 150 dpi = 144 pt; Pillow's
        `save_all` would have given it frame 1's 300 dpi and produced 72 pt.
        This test is the difference between the two implementations.
        """
        src = Path(tmp_dir) / "mixed.tif"
        a = gray((600, 600), 220)
        b = gray((300, 300), 180)
        b.encoderinfo = {"dpi": (150, 150)}
        a.save(src, save_all=True, append_images=[b], dpi=(300, 300))
        out = Path(tmp_dir) / "mixed.pdf"
        report = image_to_pdf(src, out)
        assert report["pages"] == 2
        assert report["dpi"] == [300.0, 150.0]
        assert boxes(out) == [[0.0, 0.0, 144.0, 144.0], [0.0, 0.0, 144.0, 144.0]]

    def test_a_multi_frame_source_never_reuses_a_saved_image_object(self, tmp_dir):
        """Regression for Pillow's encoderinfo leak.

        `Image.save` MERGES into a stale `encoderinfo` and the STALE value wins
        — measured: a second `save(..., resolution=150)` on an image that had
        been an `append_images` member silently used the earlier 300. Two
        frames whose page sizes differ prove each frame got a fresh object.
        """
        src = Path(tmp_dir) / "two.tif"
        gray((600, 600)).save(
            src, save_all=True, append_images=[gray((1200, 1200))], dpi=(300, 300)
        )
        out = Path(tmp_dir) / "two.pdf"
        image_to_pdf(src, out)
        assert boxes(out) == [[0.0, 0.0, 144.0, 144.0], [0.0, 0.0, 288.0, 288.0]]


class TestNormalisation:
    def test_a_bilevel_page_stays_bilevel(self, tmp_dir):
        # Mode "1" lands as CCITTFaxDecode — what a fax page should be. The old
        # wrap converted it to RGB and paid for it in every byte.
        src = Path(tmp_dir) / "bw.tif"
        Image.new("1", (800, 1000), 1).save(src, dpi=(200, 200))
        out = Path(tmp_dir) / "bw.pdf"
        image_to_pdf(src, out)
        filt, cs, bpc = first_image(out)
        assert "CCITTFaxDecode" in filt
        assert cs == "/DeviceGray" and int(bpc) == 1

    def test_a_palette_image_does_not_land_as_indexed_asciihex(self, tmp_dir):
        src = Path(tmp_dir) / "pal.png"
        Image.new("RGB", (200, 100), (200, 30, 30)).convert("P").save(src, dpi=(72, 72))
        out = Path(tmp_dir) / "pal.pdf"
        image_to_pdf(src, out)
        filt, cs, _ = first_image(out)
        assert filt == "/DCTDecode" and cs == "/DeviceRGB"

    def test_transparency_composites_onto_white_not_onto_the_hidden_colour(self, tmp_dir):
        # A bare convert("RGB") of a fully transparent RED pixel yields opaque
        # RED (measured). A document page shows paper there.
        src = Path(tmp_dir) / "alpha.png"
        Image.new("RGBA", (64, 64), (255, 0, 0, 0)).save(src, dpi=(72, 72))
        out = Path(tmp_dir) / "alpha.pdf"
        image_to_pdf(src, out)
        with pikepdf.open(str(out)) as pdf:
            xo = pdf.pages[0]["/Resources"]["/XObject"]
            raw = pikepdf.PdfImage(xo[list(xo.keys())[0]]).as_pil_image().convert("RGB")
        r, g, b = raw.getpixel((32, 32))
        assert r > 240 and g > 240 and b > 240, (r, g, b)

    def test_a_16_bit_image_is_scaled_not_clipped(self, tmp_dir):
        # convert("L") straight off I;16 CLIPS at 255 — a 16-bit scan would come
        # back almost entirely white (10000 -> 255 measured). Scaled: 10000 -> 39.
        src = Path(tmp_dir) / "deep.tif"
        Image.new("I;16", (32, 32), 10000).save(src, dpi=(72, 72))
        out = Path(tmp_dir) / "deep.pdf"
        image_to_pdf(src, out)
        with pikepdf.open(str(out)) as pdf:
            xo = pdf.pages[0]["/Resources"]["/XObject"]
            pil = pikepdf.PdfImage(xo[list(xo.keys())[0]]).as_pil_image().convert("L")
        assert 30 <= pil.getpixel((16, 16)) <= 48

    def test_cmyk_stays_cmyk(self, tmp_dir):
        src = Path(tmp_dir) / "press.jpg"
        Image.new("CMYK", (200, 100), (0, 200, 200, 10)).save(src, dpi=(72, 72))
        out = Path(tmp_dir) / "press.pdf"
        image_to_pdf(src, out)
        _filt, cs, _ = first_image(out)
        assert cs == "/DeviceCMYK"


class TestAcceptedSet:
    def test_the_formats_the_bundled_pillow_already_decodes_are_accepted(self):
        # They were decodable all along and simply absent from the list —
        # WEBP, JPEG 2000 and AVIF all report available in the bundled Pillow.
        for suffix in (".webp", ".jp2", ".avif", ".gif", ".heic", ".heif"):
            assert suffix in IMAGE_SUFFIXES
        assert accepted_image_suffixes() is IMAGE_SUFFIXES

    def test_is_image_is_case_insensitive_and_excludes_pdf(self):
        assert is_image("A.TIF") and is_image(Path("b.HeIc"))
        assert not is_image("c.pdf") and not is_image("d.docx")

    @pytest.mark.parametrize("fmt,suffix", [("WEBP", ".webp"), ("JPEG2000", ".jp2")])
    def test_a_widened_format_round_trips(self, tmp_dir, fmt, suffix):
        src = Path(tmp_dir) / f"pic{suffix}"
        Image.new("RGB", (400, 200), (30, 90, 160)).save(src, format=fmt)
        out = Path(tmp_dir) / "pic.pdf"
        report = image_to_pdf(src, out, dpi_default=200.0)
        assert report["pages"] == 1
        assert boxes(out) == [[0.0, 0.0, 144.0, 72.0]]

    def test_an_animated_gif_contributes_every_frame(self, tmp_dir):
        src = Path(tmp_dir) / "anim.gif"
        f0 = Image.new("P", (120, 90))
        f0.putpalette([0, 0, 0, 255, 255, 255] + [0] * 762)
        f1 = f0.copy()
        f1.paste(1, (0, 0, 60, 45))
        f0.save(src, save_all=True, append_images=[f1])
        out = Path(tmp_dir) / "anim.pdf"
        assert image_to_pdf(src, out, dpi_default=72.0)["pages"] == 2


class TestHeif:
    def test_heic_decodes_when_the_plugin_is_present(self, tmp_dir):
        pytest.importorskip("pillow_heif")
        import pillow_heif

        pillow_heif.register_heif_opener()
        src = Path(tmp_dir) / "photo.heic"
        Image.new("RGB", (800, 600), (10, 120, 200)).save(src, format="HEIF")
        out = Path(tmp_dir) / "photo.pdf"
        report = image_to_pdf(src, out, dpi_default=200.0)
        assert report["pages"] == 1
        assert boxes(out) == [[0.0, 0.0, 288.0, 216.0]]

    def test_heic_refuses_BY_NAME_when_the_plugin_is_absent(self, tmp_dir, monkeypatch):
        # Never silently skip somebody's photograph: the refusal names the
        # missing plugin and the file.
        src = Path(tmp_dir) / "photo.heic"
        src.write_bytes(b"\x00\x00\x00\x20ftypheic" + b"\x00" * 64)
        monkeypatch.setattr(create_pdf_mod, "_heif_registered", False)
        with pytest.raises(RuntimeError, match="pillow-heif"):
            image_to_pdf(src, Path(tmp_dir) / "photo.pdf")

    def test_the_heif_suffixes_are_a_subset_of_the_accepted_set(self):
        assert set(HEIF_SUFFIXES) <= set(IMAGE_SUFFIXES)


class TestRefusals:
    def test_a_missing_source_refuses_by_name(self, tmp_dir):
        with pytest.raises(ValueError, match="image file not found"):
            image_to_pdf(Path(tmp_dir) / "nope.png", Path(tmp_dir) / "o.pdf")

    def test_a_zero_byte_source_refuses_before_any_decoder_runs(self, tmp_dir):
        src = Path(tmp_dir) / "empty.png"
        src.write_bytes(b"")
        with pytest.raises(ValueError, match="empty"):
            image_to_pdf(src, Path(tmp_dir) / "o.pdf")

    def test_an_unreadable_image_refuses_by_name(self, tmp_dir):
        src = Path(tmp_dir) / "broken.png"
        src.write_bytes(b"\x89PNG\r\n\x1a\n not really an image")
        with pytest.raises(ValueError, match="unreadable image"):
            image_to_pdf(src, Path(tmp_dir) / "o.pdf")

    def test_nothing_is_written_when_the_source_refuses(self, tmp_dir):
        src = Path(tmp_dir) / "broken.png"
        src.write_bytes(b"\x89PNG\r\n\x1a\n nope")
        out = Path(tmp_dir) / "o.pdf"
        with pytest.raises(ValueError):
            image_to_pdf(src, out)
        assert not out.exists()


class TestBatchOcrSharesTheOneImplementation:
    def test_batch_ocr_re_exports_the_promoted_wrap(self):
        from engine import batch_ocr

        assert batch_ocr.image_to_pdf is image_to_pdf
        assert batch_ocr.IMAGE_SUFFIXES is IMAGE_SUFFIXES

    def test_the_batch_walk_now_sees_the_widened_set(self, tmp_dir):
        from engine.batch_ocr import _list_sources

        root = Path(tmp_dir) / "in"
        root.mkdir()
        for name in ("a.pdf", "b.png", "c.heic", "d.webp", "e.txt"):
            (root / name).write_bytes(b"x")
        found = sorted(rel for _p, rel in _list_sources(root, True)[0])
        assert found == ["a.pdf", "b.png", "c.heic", "d.webp"]


class TestOfficeExportDefectsFixed:
    """The two soffice-side defects P22 recon found in code it reuses."""

    def _fake_run(self, monkeypatch, returncode=0, stderr="boom"):
        import subprocess

        from engine import office_export

        class FakeProc:
            pid = 4242

            def __init__(self, *a, **k):
                self.returncode = returncode

            def communicate(self, timeout=None):
                return ("", stderr)

        monkeypatch.setattr(office_export.subprocess, "Popen", FakeProc)
        return subprocess

    def test_the_wrote_no_output_path_raises_its_own_message_not_a_NameError(
        self, tmp_dir, monkeypatch
    ):
        # It referenced `result`, a name that does not exist in the function —
        # so the honest message was unreachable and `gen-engine-messages.py`
        # carried a row for a string that could never be raised.
        from engine import office_export

        self._fake_run(monkeypatch, returncode=0, stderr="soffice said something")
        out_dir = Path(tmp_dir) / "out"
        out_dir.mkdir()
        src = Path(tmp_dir) / "in.pdf"
        src.write_bytes(b"%PDF-1.4\n")
        with pytest.raises(RuntimeError, match="reported success but wrote no output"):
            office_export._run_soffice("soffice", "html", src, out_dir, ".html")

    def test_an_empty_produced_file_is_not_a_success(self, tmp_dir, monkeypatch):
        from engine import office_export

        out_dir = Path(tmp_dir) / "out"
        out_dir.mkdir()
        src = Path(tmp_dir) / "in.pdf"
        src.write_bytes(b"%PDF-1.4\n")

        class FakeProc:
            pid = 99

            def __init__(self, *a, **k):
                self.returncode = 0
                (out_dir / "in.html").write_bytes(b"")

            def communicate(self, timeout=None):
                return ("", "")

        monkeypatch.setattr(office_export.subprocess, "Popen", FakeProc)
        with pytest.raises(RuntimeError, match="the file it wrote is empty"):
            office_export._run_soffice("soffice", "html", src, out_dir, ".html")

    def test_a_zero_byte_source_refuses_before_soffice_is_invoked(self, tmp_dir):
        # Measured: soffice returns 0 and writes a plausible 1-page PDF from a
        # zero-byte .docx, so its exit code is not a success signal.
        from engine.office_export import export_document

        src = Path(tmp_dir) / "empty.pdf"
        src.write_bytes(b"")
        with pytest.raises(ValueError, match="input file is empty"):
            export_document(str(src), str(Path(tmp_dir) / "o.docx"), "docx", "soffice")


def test_the_module_does_not_import_pillow_at_module_scope():
    """PIL is imported inside the functions, as batch_ocr's wrap did — the
    engine's import graph stays cheap for the ops that never touch an image."""
    source = Path(create_pdf_mod.__file__).read_text(encoding="utf-8")
    top_level = [
        line
        for line in source.splitlines()
        if line.startswith(("import ", "from ")) and "PIL" in line
    ]
    assert top_level == [], top_level


def test_no_leftover_temporaries_beside_the_output(tmp_dir):
    src = Path(tmp_dir) / "s.tif"
    frames = [gray((100, 100), v) for v in (10, 20)]
    frames[0].save(src, save_all=True, append_images=frames[1:], dpi=(72, 72))
    out = Path(tmp_dir) / "nested" / "deep" / "s.pdf"
    image_to_pdf(src, out)
    assert out.is_file()
    assert sorted(os.listdir(out.parent)) == ["s.pdf"]
