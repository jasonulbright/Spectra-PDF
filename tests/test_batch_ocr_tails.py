"""9-§I.5 P3 — the batch-OCR tails: supplied passwords and image sources."""

import os
import shutil

import pikepdf
import pytest

from engine.batch_ocr import IMAGE_SUFFIXES, _image_to_pdf, _is_image, _list_sources, batch_ocr
from engine.encrypt import encrypt
from engine.extract_text import extract_text
from engine.image_export import export_images
from engine.text_authoring import add_text_box

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GS = os.path.join(ROOT, "resources", "ghostscript", "gswin64c.exe")
TESS = os.path.join(ROOT, "resources", "tesseract", "tesseract.exe")
FONTS = os.path.join(ROOT, "resources", "fonts")
PHRASE = "SCANNED IMAGE PAGE"

pytestmark = pytest.mark.skipif(
    not (os.path.isfile(GS) and os.path.isfile(TESS)),
    reason="vendored Ghostscript/Tesseract not provisioned",
)


def _typed_pdf(tmp_dir, name="typed.pdf", text=PHRASE):
    blank = os.path.join(tmp_dir, "blank-" + name)
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(blank)
    pdf.close()
    out = os.path.join(tmp_dir, name)
    add_text_box(blank, out, 1, [72, 600, 540, 720], text, size=40.0,
                 font_path=FONTS, family="sans")
    return out


def _scan_png(tmp_dir, dest):
    """A page rasterized to PNG — an image with no extractable text."""
    typed = _typed_pdf(tmp_dir)
    export_images(typed, os.path.join(tmp_dir, "p.png"), fmt="png", dpi=200, gs_path=GS)
    png = sorted(f for f in os.listdir(tmp_dir) if f.lower().endswith(".png"))[0]
    shutil.copy(os.path.join(tmp_dir, png), dest)
    return dest


class TestImageSources:
    def test_image_suffixes_are_recognised(self):
        assert _is_image(pikepdf.Path if False else __import__("pathlib").Path("a.TIF"))
        for suffix in IMAGE_SUFFIXES:
            assert _is_image(__import__("pathlib").Path("x" + suffix))
        assert not _is_image(__import__("pathlib").Path("x.pdf"))

    def test_the_walk_includes_images_only_when_asked(self, tmp_dir):
        from pathlib import Path

        src = os.path.join(tmp_dir, "in")
        os.makedirs(src)
        open(os.path.join(src, "a.pdf"), "wb").write(b"%PDF-1.4\n")
        open(os.path.join(src, "b.png"), "wb").write(b"\x89PNG\r\n")
        off, _ = _list_sources(Path(src), False)
        on, _ = _list_sources(Path(src), True)
        assert [r for _p, r in off] == ["a.pdf"]
        assert sorted(r for _p, r in on) == ["a.pdf", "b.png"]

    def test_an_image_ocrs_into_a_searchable_pdf(self, tmp_dir):
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        _scan_png(tmp_dir, os.path.join(src, "scan.png"))
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS,
                           include_images=True)
        statuses = {r["rel"]: r["status"] for r in report["results"]}
        assert statuses["scan.png"] == "ocr", report["results"]
        # The name GAINS .pdf — `invoice.tif` and `invoice.pdf` in one folder
        # must not collide, and the original name stays legible.
        out = os.path.join(dst, "scan.png.pdf")
        assert os.path.isfile(out), sorted(os.listdir(dst))
        text = extract_text(out)["text"].upper()
        assert "SCANNED" in text and "PAGE" in text

    def test_images_are_ignored_without_the_option(self, tmp_dir):
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        _scan_png(tmp_dir, os.path.join(src, "scan.png"))
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS)
        assert report["results"] == [], report["results"]

    def test_in_place_refuses_an_image_by_name(self, tmp_dir):
        # Replacing a `.png` with a PDF that still ends in `.png` would leave
        # a file that lies about what it is — worse than not touching it.
        src = os.path.join(tmp_dir, "in")
        os.makedirs(src)
        png = _scan_png(tmp_dir, os.path.join(src, "scan.png"))
        before = open(png, "rb").read()
        report = batch_ocr(source=src, gs_path=GS, tesseract_path=TESS,
                           include_images=True, in_place=True)
        entry = next(r for r in report["results"] if r["rel"] == "scan.png")
        assert entry["status"] == "skipped"
        assert "in-place" in entry["reason"]
        assert open(png, "rb").read() == before  # untouched, byte for byte

    def test_a_corrupt_image_is_skipped_with_a_reason(self, tmp_dir):
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        with open(os.path.join(src, "broken.png"), "wb") as fh:
            fh.write(b"\x89PNG\r\n\x1a\n not really")
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS,
                           include_images=True)
        entry = next(r for r in report["results"] if r["rel"] == "broken.png")
        assert entry["status"] == "skipped"
        assert "image" in entry["reason"]

    def test_image_to_pdf_sizes_the_page_from_the_image_dpi(self, tmp_dir):
        from pathlib import Path

        png = _scan_png(tmp_dir, os.path.join(tmp_dir, "s.png"))
        out = Path(tmp_dir) / "wrapped.pdf"
        _image_to_pdf(Path(png), out)
        with pikepdf.open(str(out)) as pdf:
            box = [float(v) for v in pdf.pages[0].mediabox]
        # A 200-dpi raster of a 612x792 page comes back near its own size —
        # the OCR raster is taken FROM this page, so a wrong size would
        # rescale the text and cost accuracy.
        assert 500 < box[2] - box[0] < 720
        assert 700 < box[3] - box[1] < 900


class TestSuppliedPasswords:
    def test_a_supplied_password_opens_the_file(self, tmp_dir):
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        typed = _typed_pdf(tmp_dir, "plain.pdf")
        encrypt(typed, os.path.join(src, "locked.pdf"),
                user_password="s3cret", owner_password="s3cret")
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS,
                           passwords={"locked.pdf": "s3cret"})
        entry = next(r for r in report["results"] if r["rel"] == "locked.pdf")
        assert entry["status"] != "skipped", entry
        assert os.path.isfile(os.path.join(dst, "locked.pdf"))

    def test_without_the_password_it_is_still_skipped_by_name(self, tmp_dir):
        # The shipped behaviour, unchanged — and what lets a caller run once,
        # read the report, and re-run just the files it now has keys for.
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        typed = _typed_pdf(tmp_dir, "plain.pdf")
        encrypt(typed, os.path.join(src, "locked.pdf"),
                user_password="s3cret", owner_password="s3cret")
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS)
        entry = next(r for r in report["results"] if r["rel"] == "locked.pdf")
        assert entry["status"] == "skipped"
        assert entry["reason"] == "password-protected"

    def test_a_wrong_password_reports_rather_than_crashes(self, tmp_dir):
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        typed = _typed_pdf(tmp_dir, "plain.pdf")
        encrypt(typed, os.path.join(src, "locked.pdf"),
                user_password="s3cret", owner_password="s3cret")
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS,
                           passwords={"locked.pdf": "wrong"})
        entry = next(r for r in report["results"] if r["rel"] == "locked.pdf")
        assert entry["status"] == "skipped"
        assert "password" in entry["reason"]

    def test_a_bare_file_name_matches_a_nested_file(self, tmp_dir):
        # A caller reading the report back sees relative paths, but supplying
        # a bare name is the obvious thing to try — both resolve.
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(os.path.join(src, "sub"))
        typed = _typed_pdf(tmp_dir, "plain.pdf")
        encrypt(typed, os.path.join(src, "sub", "locked.pdf"),
                user_password="s3cret", owner_password="s3cret")
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS,
                           passwords={"locked.pdf": "s3cret"})
        entry = report["results"][0]
        assert entry["status"] != "skipped", entry
