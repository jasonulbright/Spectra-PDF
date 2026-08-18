"""The batch-OCR tails: supplied passwords and image sources."""

import io
import os
import shutil

import pikepdf
import pytest

from engine.batch_ocr import (
    IMAGE_SUFFIXES,
    _is_image,
    _list_sources,
    batch_ocr,
    ocr_file,
)
# The image wrap is a first-class engine arm now; batch OCR is a consumer.
from engine.create_pdf import image_to_pdf
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
        image_to_pdf(Path(png), out)
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


class TestBatchMrc:
    """The reported ask: "a batch option that could just compress automatically".

    The order is the claim: recognition rasterises from the PAGE, so MRC must
    read the RECOGNISED output, never the other way round. Everything else
    here is about a batch's standing promise — one file's outcome never
    changes another's, and MRC declining is a note rather than a failure.
    """

    def _scan_pdf(self, tmp_dir, dest):
        """A one-page PDF whose only content is a 300-dpi raster of text."""
        from pathlib import Path

        from PIL import Image

        png = _scan_png(tmp_dir, os.path.join(tmp_dir, "scan-src.png"))
        image = Image.open(png).convert("RGB")
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        image_to_pdf(Path(png), Path(dest))
        image.close()
        return dest

    def test_a_scan_is_recognised_then_compressed(self, tmp_dir):
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        self._scan_pdf(tmp_dir, os.path.join(src, "scan.pdf"))
        before = os.path.getsize(os.path.join(src, "scan.pdf"))
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS,
                           mrc=True, mrc_preset="balanced")
        entry = report["results"][0]
        assert entry["status"] == "ocr"
        assert entry["mrcApplied"] is True
        assert "MRC compressed" in entry["mrc"]
        out = os.path.join(dst, "scan.pdf")
        assert os.path.getsize(out) < before
        # The searchable layer is still there AFTER the compression: the
        # surgery keeps the page object, so the invisible text survives.
        assert PHRASE.split()[0].lower() in extract_text(out)["text"].lower()

    def test_a_file_with_no_scan_keeps_its_bytes_and_says_so(self, tmp_dir):
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        shutil.copy(_typed_pdf(tmp_dir), os.path.join(src, "typed.pdf"))
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS,
                           mrc=True)
        entry = report["results"][0]
        # Not a failure: MRC on a page that is not a scan is worse than the
        # original, and the file the user asked for is already mirrored.
        assert entry["status"] == "copied"
        assert "mrcApplied" not in entry
        assert "nothing to separate" in entry["mrc"]
        assert os.path.getsize(os.path.join(dst, "typed.pdf")) == os.path.getsize(
            os.path.join(src, "typed.pdf")
        )

    def test_without_the_option_nothing_is_compressed(self, tmp_dir):
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        self._scan_pdf(tmp_dir, os.path.join(src, "scan.pdf"))
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS)
        assert "mrc" not in report["results"][0]

    def test_the_note_reaches_the_log(self, tmp_dir):
        from engine.batch_ocr import _file_line

        line = _file_line({"status": "ocr", "rel": "a.pdf", "pagesOcrd": 1,
                           "mrc": "MRC compressed 1 page(s), 900 -> 100 bytes"})
        assert "[MRC compressed 1 page(s), 900 -> 100 bytes]" in line

    def test_ocr_file_carries_the_same_option(self, tmp_dir):
        out = os.path.join(tmp_dir, "one-mrc.pdf")
        result = ocr_file(self._scan_pdf(tmp_dir, os.path.join(tmp_dir, "one.pdf")),
                          out, tesseract_path=TESS, gs_path=GS, mrc=True)
        assert result["mrcApplied"] is True
        assert "MRC compressed" in result["mrc"]


class TestTheMrcTailSharesOnePreparation:
    """MRC reads its source as CONTENT, so it reads the prepared copy.

    The MRC pass keeps the page object and drops no widget, so today this
    changes nothing about any output — which is exactly why it is pinned by
    the SHAPE rather than by a byte diff: what the shared preparation buys is
    that the tail and the Ghostscript-backed ops cannot drift apart, so a
    later change to what MRC does with a page cannot silently re-open the
    class. The measurement of the no-change is the second test: without a
    bare field there is nothing to prepare and MRC is handed the original
    path, and that argument is the only thing the preparation can touch.
    """

    _HAS_CJK_FACE = os.path.isfile(os.path.join(FONTS, "NotoSansCJKsc-Regular.otf"))

    def _captured(self, monkeypatch):
        """(path, bytes) for every `compress` call the tail makes.

        The bytes are read at the call: the prepared copy is scaffolding and
        is gone by the time the step returns, which is its own pin below.
        """
        seen = []

        def fake_compress(file, output, **kwargs):
            seen.append((str(file), open(file, "rb").read()))
            raise ValueError("nothing to separate")

        monkeypatch.setattr("engine.batch_ocr.compress", fake_compress)
        return seen

    def _bare_unicode(self, tmp_dir, name="bare.pdf"):
        from separation_builders import form_appearance_pdf

        return form_appearance_pdf(os.path.join(tmp_dir, name), "bare-unicode")

    @pytest.mark.skipif(not _HAS_CJK_FACE, reason="bundled CJK face not provisioned")
    def test_a_bare_field_is_given_its_appearance_before_mrc_reads_the_file(
        self, tmp_dir, monkeypatch
    ):
        from engine.batch_ocr import _mrc_step

        seen = self._captured(monkeypatch)
        src = self._bare_unicode(tmp_dir)
        applied, note = _mrc_step(src, os.path.join(tmp_dir, "out.pdf"),
                                  "balanced", False, "eng", GS, TESS, FONTS)
        assert applied is False and "nothing to separate" in note
        assert len(seen) == 1 and seen[0][0] != src
        with pikepdf.open(io.BytesIO(seen[0][1])) as prepared:
            assert prepared.pages[0].Annots[0].get("/AP") is not None

    @pytest.mark.skipif(not _HAS_CJK_FACE, reason="bundled CJK face not provisioned")
    def test_the_scratch_copy_does_not_outlive_the_step(self, tmp_dir, monkeypatch):
        # It is scaffolding: a batch run over a thousand files would otherwise
        # leave a thousand copies behind.
        from engine.batch_ocr import _mrc_step

        seen = self._captured(monkeypatch)
        _mrc_step(self._bare_unicode(tmp_dir), os.path.join(tmp_dir, "out.pdf"),
                  "balanced", False, "eng", GS, TESS, FONTS)
        assert not os.path.exists(seen[0][0])

    def test_a_document_with_nothing_to_prepare_hands_over_its_own_path(
        self, tmp_dir, monkeypatch
    ):
        # The measured no-change, on both halves of the condition: no form
        # field at all, and a form field that already carries an appearance.
        from separation_builders import form_appearance_pdf

        from engine.batch_ocr import _mrc_step

        cases = [_typed_pdf(tmp_dir),
                 form_appearance_pdf(os.path.join(tmp_dir, "text.pdf"), "text")]
        for src in cases:
            seen = self._captured(monkeypatch)
            _mrc_step(src, os.path.join(tmp_dir, "out.pdf"), "balanced", False,
                      "eng", GS, TESS, FONTS)
            assert [path for path, _ in seen] == [src]

    @pytest.mark.skipif(not _HAS_CJK_FACE, reason="bundled CJK face not provisioned")
    def test_without_a_font_dir_nothing_is_prepared(self, tmp_dir, monkeypatch):
        # The degenerate stays measured: no face can spell this value, so the
        # widget keeps no appearance and MRC reads the file as it stands.
        from engine.batch_ocr import _mrc_step

        seen = self._captured(monkeypatch)
        src = self._bare_unicode(tmp_dir)
        _mrc_step(src, os.path.join(tmp_dir, "out.pdf"), "balanced", False,
                  "eng", GS, TESS, "")
        assert [path for path, _ in seen] == [src]

    @pytest.mark.skipif(not _HAS_CJK_FACE, reason="bundled CJK face not provisioned")
    def test_both_doors_carry_the_parameter_to_the_tail(self, tmp_dir, monkeypatch):
        # The thread, end to end: neither door reaches MRC with a font_dir it
        # was handed but never passed on. Both fixtures paint no raster, so
        # nothing is recognised and the tail is the only pass that runs.
        source = os.path.join(tmp_dir, "tree")
        os.makedirs(source)
        self._bare_unicode(source, "bare.pdf")

        def carries_an_appearance(seen):
            assert len(seen) == 1
            with pikepdf.open(io.BytesIO(seen[0][1])) as read:
                return read.pages[0].Annots[0].get("/AP") is not None

        seen = self._captured(monkeypatch)
        batch_ocr(source=source, dest=os.path.join(tmp_dir, "mirror"), gs_path=GS,
                  tesseract_path=TESS, mrc=True, font_dir=FONTS)
        assert carries_an_appearance(seen)

        seen = self._captured(monkeypatch)
        ocr_file(self._bare_unicode(tmp_dir, "one.pdf"),
                 os.path.join(tmp_dir, "one-out.pdf"), tesseract_path=TESS,
                 gs_path=GS, mrc=True, font_dir=FONTS)
        assert carries_an_appearance(seen)


class TestBatchEnhance:
    """Scan enhancement inside a batch run.

    The order is the claim, read the other way round from MRC's: enhancement
    rewrites the page IMAGE, so it runs BEFORE recognition — a text layer
    written first would sit over where the ink used to be. These reach the
    same engine arguments the CLI's `--enhance` / `--no-enhance-orientation`
    and a scheduled run's expanded command line reach, which is what makes
    those two surfaces provable without registering a task.
    """

    def _skewed_scan(self, tmp_dir, dest):
        """A one-page PDF whose only content is a rotated raster of text."""
        from pathlib import Path

        from PIL import Image

        png = _scan_png(tmp_dir, os.path.join(tmp_dir, "enh-src.png"))
        image = Image.open(png).convert("RGB")
        turned = image.rotate(-2.0, expand=True, fillcolor=(255, 255, 255))
        leaning = os.path.join(tmp_dir, "enh-leaning.png")
        turned.save(leaning)
        image.close()
        turned.close()
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        image_to_pdf(Path(leaning), Path(dest))
        return dest

    def test_a_scan_is_enhanced_then_recognised(self, tmp_dir):
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        self._skewed_scan(tmp_dir, os.path.join(src, "scan.pdf"))
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS,
                           enhance=True)
        entry = report["results"][0]
        assert entry["status"] == "ocr"
        assert entry["enhance"]
        # The searchable layer is written over the CORRECTED page, so the text
        # is extractable from the output the enhancement produced.
        assert PHRASE.split()[0].lower() in extract_text(
            os.path.join(dst, "scan.pdf")
        )["text"].lower()

    def test_a_file_with_no_scan_says_so_rather_than_failing(self, tmp_dir):
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        shutil.copy(_typed_pdf(tmp_dir), os.path.join(src, "typed.pdf"))
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS,
                           enhance=True)
        entry = report["results"][0]
        assert entry["status"] == "copied"
        assert entry["enhance"]
        assert os.path.isfile(os.path.join(dst, "typed.pdf"))

    def test_without_the_option_nothing_is_enhanced(self, tmp_dir):
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        self._skewed_scan(tmp_dir, os.path.join(src, "scan.pdf"))
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS)
        assert "enhance" not in report["results"][0]

    def test_the_orientation_half_can_be_turned_off_on_its_own(self, tmp_dir):
        # The half whose shipped default is ON. It is inert without `enhance`,
        # so the pin is that turning it off leaves the rest of the run intact
        # rather than refusing or skipping the file.
        src = os.path.join(tmp_dir, "in")
        dst = os.path.join(tmp_dir, "out")
        os.makedirs(src)
        self._skewed_scan(tmp_dir, os.path.join(src, "scan.pdf"))
        report = batch_ocr(source=src, dest=dst, gs_path=GS, tesseract_path=TESS,
                           enhance=True, enhance_orientation=False)
        entry = report["results"][0]
        assert entry["status"] in ("ocr", "copied")
        assert entry["enhance"]
        assert os.path.isfile(os.path.join(dst, "scan.pdf"))
