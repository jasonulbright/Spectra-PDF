"""The MRC pass.

The fixtures are built by the checked-in `tests/fixtures/make_scans.py` and
committed beside it, so every number below is measured against bytes a
fixtures can be regenerated and diffed reproducibly.

What is pinned, and why each pin exists rather than being obvious:

  * **Classification** — MRC on a page that is not a scan is worse than the
    original in both size and fidelity, so the classifier is the correctness
    boundary, not a convenience.
  * **Survival** — the whole argument for content-stream surgery over a
    rebuild is that /AcroForm, the invisible OCR layer, annotations and the
    page count come through untouched. If anyone ever swaps the surgery for a
    rebuild, this is the group that fails loudly.
  * **Size** — a recorded band against the SOURCE and against Ghostscript's
    `/ebook`, which is the comparison the actually claims.
  * **Legibility** — the point of the feature is that the words survive. The
    similarity is computed with `autojunk=False` over a normalized word list,
    because `SequenceMatcher`'s autojunk heuristic discards any token
    appearing in over 1% of a sequence longer than 200 — on prose that is
    most words, and it scores a CORRECT page at 7/713.
  * **PDF/A** — probe-verified that gs keeps the layering
    and transcodes JPX to DCT for PDF/A-1; the pin freezes that.
"""

from __future__ import annotations

import difflib
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pikepdf
import pytest
from PIL import Image

from engine.compress import compress
from engine.mrc import (
    DEFAULT_PRESET,
    PRESETS,
    _classify_page,
    _lift_image,
    components,
    estimate_text_height,
    masked_mean,
    mrc_compress,
    resolve_mask_codec,
    resolve_preset,
    sauvola_ink,
    segment,
)
from engine import mrc_verify
from engine.mrc_codecs import CCITT_G4, JBIG2_GENERIC, JBIG2_SYMBOL
from engine.pdfa import convert_pdfa

import numpy as np

FIXTURES = Path(__file__).resolve().parent / "fixtures"
TESSERACT = (
    Path(__file__).resolve().parent.parent / "resources" / "tesseract" / "tesseract.exe"
)

SCANS = ("scan-text", "scan-photo", "scan-form")

needs_tesseract = pytest.mark.skipif(
    not TESSERACT.is_file(), reason="Tesseract not vendored"
)


@pytest.fixture(params=SCANS)
def scan(request, tmp_dir):
    """A working copy of each scan fixture, one test run per fixture."""
    src = FIXTURES / f"{request.param}.pdf"
    if not src.is_file():
        pytest.skip(f"{src.name} not generated (tests/fixtures/make_scans.py)")
    dest = os.path.join(tmp_dir, src.name)
    shutil.copy2(src, dest)
    return dest


@pytest.fixture
def text_scan(tmp_dir):
    src = FIXTURES / "scan-text.pdf"
    if not src.is_file():
        pytest.skip("scan-text.pdf not generated")
    dest = os.path.join(tmp_dir, src.name)
    shutil.copy2(src, dest)
    return dest


@pytest.fixture
def form_scan(tmp_dir):
    src = FIXTURES / "scan-form.pdf"
    if not src.is_file():
        pytest.skip("scan-form.pdf not generated")
    dest = os.path.join(tmp_dir, src.name)
    shutil.copy2(src, dest)
    return dest


@pytest.fixture
def photo_scan(tmp_dir):
    src = FIXTURES / "scan-photo.pdf"
    if not src.is_file():
        pytest.skip("scan-photo.pdf not generated")
    dest = os.path.join(tmp_dir, src.name)
    shutil.copy2(src, dest)
    return dest


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _one_page_pdf(dest: str, content: bytes, resources=None, extra=None) -> str:
    pdf = pikepdf.Pdf.new()
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 612, 792],
        Resources=resources if resources is not None else pikepdf.Dictionary(),
        Contents=pdf.make_stream(content),
    )
    for key, value in (extra or {}).items():
        page[key] = value
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(dest)
    return dest


def _image_page_pdf(dest: str, image: Image.Image, *, fmt="jpeg", **image_keys) -> str:
    import io

    buf = io.BytesIO()
    if fmt == "jpeg":
        image.convert("RGB").save(buf, format="JPEG", quality=80)
        filt, cs, bpc = "/DCTDecode", "/DeviceRGB", 8
    else:  # 1-bit
        raw = np.packbits(
            np.asarray(image.convert("1"), dtype=bool), axis=1
        ).tobytes()
        buf.write(raw)
        filt, cs, bpc = None, "/DeviceGray", 1
    pdf = pikepdf.Pdf.new()
    st = pikepdf.Stream(pdf, buf.getvalue())
    st["/Type"] = pikepdf.Name("/XObject")
    st["/Subtype"] = pikepdf.Name("/Image")
    st["/Width"] = image.width
    st["/Height"] = image.height
    st["/ColorSpace"] = pikepdf.Name(cs)
    st["/BitsPerComponent"] = bpc
    if filt:
        st["/Filter"] = pikepdf.Name(filt)
    for key, value in image_keys.items():
        st["/" + key] = value
    img = pdf.make_indirect(st)
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 612, 792],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=img)),
        Contents=pdf.make_stream(b"q 612 0 0 792 0 0 cm /Im0 Do Q"),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(dest)
    return dest


def _decision(path: str, page_number: int = 1) -> tuple[str, str]:
    with pikepdf.open(path) as pdf:
        candidate, reason = _classify_page(pdf, pdf.pages[page_number - 1], page_number)
    return (("mrc", reason) if candidate is not None else ("untouched", reason))


def _images_on_page(path: str, page_number: int = 1) -> list[dict]:
    """Plain dicts, read INSIDE the open Pdf.

    Not a style choice: a `pikepdf.Object` handed out past its Pdf's close is
    detached, and every key then reads as absent — a test written that way
    reports "the foreground lost its /Mask" for a file that has one.
    """
    out: list[dict] = []
    with pikepdf.open(path) as pdf:
        res = pdf.pages[page_number - 1].obj.get("/Resources")
        xo = res.get("/XObject") if res is not None else None
        for key in xo.keys() if xo is not None else []:
            obj = xo[key]
            if str(obj.get("/Subtype", "")) != "/Image":
                continue
            mask = obj.get("/Mask")
            out.append(
                {
                    "filter": str(obj.get("/Filter", "")),
                    "width": int(obj.get("/Width", 0)),
                    "height": int(obj.get("/Height", 0)),
                    "mask": None
                    if mask is None
                    else {
                        "image_mask": bool(mask.get("/ImageMask", False)),
                        "filter": str(mask.get("/Filter", "")),
                        "width": int(mask.get("/Width", 0)),
                    },
                }
            )
    return out


def _extract_text(path: str) -> str:
    from engine.extract_text import extract_text

    return extract_text(path)["text"]


def _ocr_words(pdf_path: str, gs_path: str, dpi: int = 300) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="spectrapdf_mrcocr_") as work:
        png = Path(work) / "p.png"
        subprocess.run(
            [
                gs_path, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
                "-sDEVICE=png16m", f"-r{dpi}", f"-sOutputFile={png}", str(pdf_path),
            ],
            check=True,
            capture_output=True,
            stdin=subprocess.DEVNULL,
        )
        result = subprocess.run(
            [
                str(TESSERACT), str(png), "stdout", "-l", "eng",
                "--tessdata-dir", str(TESSERACT.parent / "tessdata"),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    return [w for w in re.findall(r"\S+", (result.stdout or "").lower())]


def _similarity(a: list[str], b: list[str]) -> tuple[float, str]:
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    ratio = matcher.ratio()
    first = ""
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            first = f"{tag}: {a[i1:i2][:6]} -> {b[j1:j2][:6]}"
            break
    return ratio, first


# --------------------------------------------------------------------------
# Presets and parameter refusals
# --------------------------------------------------------------------------
class TestPresets:
    def test_three_presets_named_for_what_they_promise(self):
        assert set(PRESETS) == {"archival", "balanced", "smallest"}
        assert DEFAULT_PRESET == "balanced"

    def test_archival_never_substitutes_a_symbol(self):
        # The whole meaning of the preset: jbig2enc's -s matches visually
        # similar glyphs and stores one representative, which is the mechanism
        # behind the scanner character-substitution class.
        assert PRESETS["archival"]["mask_codec"] == JBIG2_GENERIC
        assert PRESETS["balanced"]["mask_codec"] == JBIG2_SYMBOL

    def test_archival_is_the_most_conservative_threshold(self):
        # Sauvola's bracket is negative over paper, so a SMALLER k finds MORE
        # ink. The ordering is the promise, not the numbers.
        ks = [PRESETS[p]["sauvola_k"] for p in ("archival", "balanced", "smallest")]
        assert ks == sorted(ks)

    def test_divisors_grow_with_aggressiveness(self):
        for key in ("bg_div", "fg_div"):
            vals = [PRESETS[p][key] for p in ("archival", "balanced", "smallest")]
            assert vals == sorted(vals)

    def test_unknown_preset_refused_by_name(self):
        with pytest.raises(ValueError, match="unknown MRC preset"):
            resolve_preset("lossless")

    def test_every_codec_alias_resolves(self):
        assert resolve_mask_codec("jbig2") == JBIG2_SYMBOL
        assert resolve_mask_codec("jbig2-generic") == JBIG2_GENERIC
        assert resolve_mask_codec("ccitt") == CCITT_G4

    def test_unknown_codec_refused_by_name(self):
        with pytest.raises(ValueError, match="unknown MRC mask codec"):
            resolve_mask_codec("jbig2-refined")

    def test_a_divisor_out_of_range_refuses(self, text_scan, tmp_dir, gs_path):
        with pytest.raises(ValueError, match="background divisor"):
            mrc_compress(
                text_scan, os.path.join(tmp_dir, "o.pdf"), bg_div=99, gs_path=gs_path
            )
        with pytest.raises(ValueError, match="foreground divisor"):
            mrc_compress(
                text_scan, os.path.join(tmp_dir, "o.pdf"), fg_div=0, gs_path=gs_path
            )

    def test_pdfa_safe_and_a_named_jbig2_codec_cannot_both_apply(
        self, text_scan, tmp_dir, gs_path
    ):
        # Two explicit requests that contradict. Silently honouring one is the
        # same class as a silent codec swap, so the contradiction is named.
        with pytest.raises(ValueError, match="cannot both apply"):
            mrc_compress(
                text_scan,
                os.path.join(tmp_dir, "o.pdf"),
                mask_codec="jbig2",
                pdfa_safe=True,
                gs_path=gs_path,
            )
        # Asking for CCITT alongside it is not a contradiction.
        report = mrc_compress(
            text_scan, os.path.join(tmp_dir, "ok.pdf"), mask_codec="ccitt",
            pdfa_safe=True, gs_path=gs_path,
        )
        assert report["mask_codec"] == CCITT_G4

    def test_missing_ghostscript_refuses_by_name(self, text_scan, tmp_dir):
        # Rule 4: gs is the INDEPENDENT decoder every stencil is verified
        # through, so its absence is not a degraded mode, it is a refusal.
        with pytest.raises(RuntimeError, match="Ghostscript is not available"):
            mrc_compress(text_scan, os.path.join(tmp_dir, "o.pdf"), gs_path="")


# --------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------
class TestClassification:
    def test_every_scan_fixture_classifies_as_a_scan(self, scan):
        assert _decision(scan)[0] == "mrc"

    def test_an_ocr_layer_does_not_disqualify_a_page(self, text_scan):
        # Tr 3 invisible text is exactly what MRC must run AFTER, so a page
        # carrying it is the normal input, not an exception.
        assert "Mixed raster content" in _extract_text(text_scan)
        assert _decision(text_scan)[0] == "mrc"

    def test_vector_text_is_untouched(self, tmp_dir):
        font = pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"),
            Subtype=pikepdf.Name("/Type1"),
            BaseFont=pikepdf.Name("/Helvetica"),
        )
        path = _one_page_pdf(
            os.path.join(tmp_dir, "vector.pdf"),
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj ET",
            resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
        )
        decision, reason = _decision(path)
        assert decision == "untouched"
        assert "not a scanned image" in reason

    def test_an_already_1bit_page_is_untouched_with_its_own_reason(self, tmp_dir):
        bitmap = Image.new("1", (1200, 1600), 1)
        path = _image_page_pdf(
            os.path.join(tmp_dir, "bitonal.pdf"), bitmap, fmt="1bit"
        )
        decision, reason = _decision(path)
        assert decision == "untouched"
        assert "already 1-bit" in reason

    def test_a_soft_masked_image_is_refused_by_name(self, tmp_dir):
        photo = Image.new("RGB", (600, 800), (200, 200, 200))
        pdf_path = os.path.join(tmp_dir, "smask.pdf")
        _image_page_pdf(pdf_path, photo)
        with pikepdf.open(pdf_path, allow_overwriting_input=True) as pdf:
            res = pdf.pages[0].obj["/Resources"]["/XObject"]["/Im0"]
            alpha = pikepdf.Stream(pdf, b"\xff" * (600 * 800))
            alpha["/Type"] = pikepdf.Name("/XObject")
            alpha["/Subtype"] = pikepdf.Name("/Image")
            alpha["/Width"] = 600
            alpha["/Height"] = 800
            alpha["/ColorSpace"] = pikepdf.Name("/DeviceGray")
            alpha["/BitsPerComponent"] = 8
            res["/SMask"] = pdf.make_indirect(alpha)
            pdf.save(pdf_path)
        decision, reason = _decision(pdf_path)
        assert decision == "untouched"
        assert "soft mask" in reason

    def test_a_rotated_placement_is_refused_by_name(self, tmp_dir):
        photo = Image.new("RGB", (600, 800), (180, 180, 180))
        path = os.path.join(tmp_dir, "rot.pdf")
        _image_page_pdf(path, photo)
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            page = pdf.pages[0]
            page.Contents = pdf.make_stream(b"q 0 792 -612 0 612 0 cm /Im0 Do Q")
            pdf.save(path)
        decision, reason = _decision(path)
        assert decision == "untouched"
        assert "rotated or skewed" in reason

    def test_a_page_that_draws_more_than_the_scan_is_untouched(self, tmp_dir):
        photo = Image.new("RGB", (600, 800), (180, 180, 180))
        path = os.path.join(tmp_dir, "extra.pdf")
        _image_page_pdf(path, photo)
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            pdf.pages[0].Contents = pdf.make_stream(
                b"q 612 0 0 792 0 0 cm /Im0 Do Q\n1 0 0 rg 10 10 100 100 re f"
            )
            pdf.save(path)
        decision, reason = _decision(path)
        assert decision == "untouched"
        assert "more than a scanned image" in reason

    def test_a_document_with_no_scan_refuses_rather_than_copying(
        self, sample_pdf, tmp_dir, gs_path
    ):
        with pytest.raises(ValueError, match="no page in this document is a scanned image"):
            mrc_compress(sample_pdf, os.path.join(tmp_dir, "o.pdf"), gs_path=gs_path)


# --------------------------------------------------------------------------
# Segmentation
# --------------------------------------------------------------------------
class TestSegmentation:
    def test_sauvola_is_local_not_global(self):
        # An illumination ramp with a mark of the same RELATIVE darkness at
        # each end — which is what ink on unevenly lit paper actually is,
        # since ink reflects a fraction of whatever light reaches it. No
        # single global threshold can find both: the light end's mark (92)
        # is brighter than the dark end's PAPER (40), so any constant that
        # catches it floods the dark half of the page. That impossibility is
        # the whole reason for a local threshold.
        gray = np.tile(np.linspace(40, 230, 400, dtype=np.float64), (200, 1))
        gray[90:110, 40:60] *= 0.4
        gray[90:110, 340:360] *= 0.4
        ink = sauvola_ink(gray.astype(np.uint8), window=25, k=0.2)
        assert ink[95:105, 45:55].mean() > 0.5, "the dark end's mark was missed"
        assert ink[95:105, 345:355].mean() > 0.5, "the light end's mark was missed"
        # ...and the ramp's own dark paper, darker than the light mark, is
        # NOT ink — the half of the property a global threshold cannot have.
        assert ink[10:30, 5:25].mean() < 0.02

    def test_components_are_8_connected(self):
        ink = np.zeros((20, 20), dtype=bool)
        ink[5, 5] = ink[6, 6] = True  # diagonal touch — ONE component
        ink[15, 15] = True
        comp = components(ink)
        assert comp.count == 2

    def test_component_boxes_and_areas(self):
        ink = np.zeros((20, 30), dtype=bool)
        ink[4:8, 10:20] = True
        comp = components(ink)
        assert comp.count == 1
        assert int(comp.area[0]) == 40
        assert (int(comp.top[0]), int(comp.bottom[0])) == (4, 7)
        assert (int(comp.left[0]), int(comp.right[0])) == (10, 19)

    def test_text_height_is_weighted_by_ink_area(self):
        # A halftone patch contributes many small dots, so the height statistic
        # must be weighted by ink area rather than component count.
        ink = np.zeros((400, 400), dtype=bool)
        for i in range(12):  # twelve 24-px letters
            ink[40 : 40 + 24, 20 + i * 30 : 20 + i * 30 + 14] = True
        for i in range(40):  # forty 4-px marks — periods, commas, i-dots
            ink[200 + (i // 10) * 20 : 204 + (i // 10) * 20,
                20 + (i % 10) * 30 : 24 + (i % 10) * 30] = True
        comp = components(ink)
        keep = np.ones(comp.count, dtype=bool)
        # Forty small marks outnumber twelve letters, so an unweighted median
        # answers 4. Weighted by ink area, the letters carry 4032 pixels
        # against the marks' 640 and the answer is the letter height.
        assert estimate_text_height(comp, keep, fallback=12) >= 20
        heights = sorted(int(h) for h in comp.bbox_h)
        assert heights[len(heights) // 2] < 10, "the fixture must trap a plain median"

    def test_a_photograph_is_absent_from_the_mask_and_present_in_the_background(
        self, photo_scan
    ):
        with pikepdf.open(photo_scan) as pdf:
            candidate, _ = _classify_page(pdf, pdf.pages[0], 1)
            source = _lift_image(pdf, pdf.pages[0], candidate)
        gray = np.asarray(source.convert("L"), dtype=np.uint8)
        ink, pictorial, stats = segment(gray, dpi=candidate.source_dpi, k=0.2)
        assert stats["picture_blocks"] > 0
        assert stats["halftone_blocks"] > 0
        assert pictorial.any()

        # The photograph's own rectangle (make_scans.py pastes it at
        # 300,900-1900,1900 in the 300-dpi raster) must be essentially empty
        # in the stencil...
        photo_region = ink[950:1850, 350:1850]
        assert photo_region.mean() < 0.01
        # ...and its pixels must survive in the background, which is what
        # "left entirely to the background layer" means: inpainting from
        # PAPER pixels only would erase them, so they are paper here.
        rgb = np.asarray(source, dtype=np.uint8)
        bg = masked_mean(rgb, np.logical_not(ink), (source.width // 2, source.height // 2))
        patch = bg[475:925, 175:925]
        assert patch.std() > 15.0

    def test_the_halftone_patch_is_excluded_too(self, photo_scan):
        with pikepdf.open(photo_scan) as pdf:
            candidate, _ = _classify_page(pdf, pdf.pages[0], 1)
            source = _lift_image(pdf, pdf.pages[0], candidate)
        gray = np.asarray(source.convert("L"), dtype=np.uint8)
        ink, _pictorial, _stats = segment(gray, dpi=candidate.source_dpi, k=0.2)
        # make_scans.py pastes the dot field at 300,2000-1500,2500.
        assert ink[2050:2450, 350:1450].mean() < 0.01

    def test_the_stencil_ink_fraction_sits_in_a_recorded_band(self, scan):
        with pikepdf.open(scan) as pdf:
            candidate, _ = _classify_page(pdf, pdf.pages[0], 1)
            source = _lift_image(pdf, pdf.pages[0], candidate)
        gray = np.asarray(source.convert("L"), dtype=np.uint8)
        ink, _pictorial, stats = segment(gray, dpi=candidate.source_dpi, k=0.2)
        assert 0.01 < float(ink.mean()) < 0.20
        # Rule 2: the window is the page's own measurement, not the default.
        assert 20 <= stats["text_height"] <= 40
        assert stats["window"] > 25

    def test_the_background_averages_paper_only(self, text_scan):
        # Rule 1, as an inequality rather than a picture: the masked mean over
        # PAPER must be lighter than a mean that lets the ink in, because the
        # difference IS the ghost measured as unreadable OCR.
        with pikepdf.open(text_scan) as pdf:
            candidate, _ = _classify_page(pdf, pdf.pages[0], 1)
            source = _lift_image(pdf, pdf.pages[0], candidate)
        rgb = np.asarray(source, dtype=np.uint8)
        gray = np.asarray(source.convert("L"), dtype=np.uint8)
        ink, _pic, _stats = segment(gray, dpi=candidate.source_dpi, k=0.2)
        size = (source.width // 3, source.height // 3)
        paper_only = masked_mean(rgb, np.logical_not(ink), size)
        everything = masked_mean(rgb, np.ones_like(ink), size)
        assert paper_only.mean() > everything.mean() + 2.0

    def test_masked_mean_fills_a_hole_with_no_keep_pixels(self):
        rgb = np.full((64, 64, 3), 200, dtype=np.uint8)
        keep = np.ones((64, 64), dtype=bool)
        keep[0:32, 0:32] = False  # a whole quadrant with nothing to average
        out = masked_mean(rgb, keep, (8, 8))
        assert np.isfinite(out).all()
        assert out.min() > 150.0  # filled from a coarser level, not with black

    def test_masked_mean_survives_a_page_with_no_keep_pixels_at_all(self):
        rgb = np.full((32, 32, 3), 123, dtype=np.uint8)
        out = masked_mean(rgb, np.zeros((32, 32), dtype=bool), (4, 4))
        assert np.allclose(out, 123.0, atol=1.0)


# --------------------------------------------------------------------------
# Assembly — what must survive
# --------------------------------------------------------------------------
class TestSurvival:
    def test_the_page_becomes_two_layers_over_one_stencil(self, text_scan, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "mrc.pdf")
        report = mrc_compress(text_scan, out, gs_path=gs_path)
        assert report["pages_mrc"] == 1
        images = _images_on_page(out)
        # Background + foreground are page resources; the stencil hangs off
        # the foreground's /Mask, which is what makes the two one drawing.
        assert len(images) == 2
        masked = [im for im in images if im["mask"] is not None]
        assert len(masked) == 1
        stencil = masked[0]["mask"]
        assert stencil["image_mask"]
        assert stencil["filter"] in ("/JBIG2Decode", "/CCITTFaxDecode")
        # The stencil is at the SCAN's resolution — that is the whole claim.
        assert stencil["width"] == 2550

    def test_the_original_scan_bytes_are_gone(self, text_scan, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "mrc.pdf")
        mrc_compress(text_scan, out, gs_path=gs_path)
        # Not merely undrawn: the point of the pass is that the photograph of
        # the page is no longer in the file.
        for image in _images_on_page(out):
            assert image["width"] < 2550

    def test_the_invisible_ocr_layer_is_byte_identical(self, text_scan, tmp_dir, gs_path):
        before = _extract_text(text_scan)
        out = os.path.join(tmp_dir, "mrc.pdf")
        mrc_compress(text_scan, out, gs_path=gs_path)
        assert _extract_text(out) == before
        assert "Mixed raster content" in before

    def test_acroform_fields_and_annotations_survive(self, form_scan, tmp_dir, gs_path):
        with pikepdf.open(form_scan) as pdf:
            names_before = [
                str(f.get("/T")) for f in pdf.Root["/AcroForm"]["/Fields"]
            ]
            annots_before = len(pdf.pages[0].obj["/Annots"])
        out = os.path.join(tmp_dir, "mrc.pdf")
        mrc_compress(form_scan, out, gs_path=gs_path)
        with pikepdf.open(out) as pdf:
            assert "/AcroForm" in pdf.Root
            names_after = [str(f.get("/T")) for f in pdf.Root["/AcroForm"]["/Fields"]]
            assert names_after == names_before
            assert len(pdf.pages[0].obj["/Annots"]) == annots_before

    def test_page_count_and_boxes_are_unchanged(self, scan, tmp_dir, gs_path):
        with pikepdf.open(scan) as pdf:
            pages_before = len(pdf.pages)
            box_before = [float(v) for v in pdf.pages[0].obj["/MediaBox"]]
        out = os.path.join(tmp_dir, "mrc.pdf")
        mrc_compress(scan, out, gs_path=gs_path)
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == pages_before
            assert [float(v) for v in pdf.pages[0].obj["/MediaBox"]] == box_before

    def test_the_output_opens_and_renders(self, scan, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "mrc.pdf")
        mrc_compress(scan, out, gs_path=gs_path)
        with tempfile.TemporaryDirectory() as work:
            png = Path(work) / "p.png"
            result = subprocess.run(
                [
                    gs_path, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
                    "-sDEVICE=pnggray", "-r72", f"-sOutputFile={png}", out,
                ],
                capture_output=True,
                stdin=subprocess.DEVNULL,
            )
            assert result.returncode == 0, result.stderr
            with Image.open(png) as im:
                arr = np.asarray(im.convert("L"), dtype=np.uint8)
        # A coverage BAND, not "not blank": an inverted stencil renders 100%
        # black and would pass any not-blank check while being exactly as
        # wrong (the lesson, applied to the pass that writes them).
        dark = float((arr < 128).mean())
        assert 0.01 < dark < 0.35

    def test_a_mask_that_fails_verification_leaves_its_page_untouched(
        self, text_scan, sample_pdf, tmp_dir, gs_path, monkeypatch
    ):
        # Rule 4 is production code, so its FAILURE path is production
        # behaviour too: an unverified stencil is never embedded, the page
        # keeps its original image, and the report says which page and why.
        import engine.mrc as mrc_module

        mixed = os.path.join(tmp_dir, "mixed.pdf")
        with pikepdf.open(text_scan) as scan_pdf, pikepdf.open(sample_pdf) as other:
            scan_pdf.pages.extend(other.pages[:1])
            scan_pdf.save(mixed)

        def refuse(*_args, **_kwargs):
            raise RuntimeError("mask verification failed: forced")

        monkeypatch.setattr(mrc_module, "verify_mask_stream", refuse)
        with pytest.raises(RuntimeError, match="every scanned page failed mask verification"):
            mrc_compress(mixed, os.path.join(tmp_dir, "o.pdf"), gs_path=gs_path)
        # Nothing was written — a refusal must not leave a half-made file.
        assert not os.path.exists(os.path.join(tmp_dir, "o.pdf"))

    def test_in_place_output_is_safe(self, text_scan, gs_path):
        before = os.path.getsize(text_scan)
        report = mrc_compress(text_scan, text_scan, gs_path=gs_path)
        assert report["output_size"] < before
        with pikepdf.open(text_scan) as pdf:
            assert len(pdf.pages) == 1


# --------------------------------------------------------------------------
# Size (the claim the actually makes)
# --------------------------------------------------------------------------
class TestSize:
    @pytest.mark.parametrize("preset", ("archival", "balanced", "smallest"))
    def test_every_preset_is_materially_smaller_than_the_scan(
        self, scan, tmp_dir, gs_path, preset
    ):
        out = os.path.join(tmp_dir, f"{preset}.pdf")
        report = mrc_compress(scan, out, preset=preset, gs_path=gs_path)
        ratio = report["output_size"] / report["original_size"]
        # Recorded band, measured on these fixtures: archival lands near a
        # quarter of the source and smallest near a fiftieth.
        assert ratio < 0.30, f"{preset}: {ratio:.3f} of the source"

    def test_the_presets_are_ordered_by_size(self, text_scan, tmp_dir, gs_path):
        sizes = []
        for preset in ("archival", "balanced", "smallest"):
            out = os.path.join(tmp_dir, f"{preset}.pdf")
            sizes.append(mrc_compress(text_scan, out, preset=preset, gs_path=gs_path)["output_size"])
        assert sizes == sorted(sizes, reverse=True)

    def test_the_default_preset_beats_ghostscript_ebook(self, scan, tmp_dir, gs_path):
        # The comparison the claims: at the same or better
        # legibility, MRC lands between /screen and /ebook in SIZE while
        # keeping the text at the scan's own resolution.
        mrc = os.path.join(tmp_dir, "mrc.pdf")
        ebook = os.path.join(tmp_dir, "ebook.pdf")
        mrc_report = mrc_compress(scan, mrc, gs_path=gs_path)
        compress(scan, ebook, quality="ebook", gs_path=gs_path)
        assert mrc_report["output_size"] < os.path.getsize(ebook)

    def test_the_foreground_collapses_for_a_single_ink(self, text_scan, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "mrc.pdf")
        report = mrc_compress(text_scan, out, gs_path=gs_path)
        # Black text: the foreground carries one colour, so it is one pixel.
        assert report["pages"][0]["fg_bytes"] < 2048

    def test_a_pictorial_page_gets_a_finer_background(self, photo_scan, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "mrc.pdf")
        report = mrc_compress(photo_scan, out, preset="smallest", gs_path=gs_path)
        # "left entirely to the background layer, at that layer's own (higher)
        # resolution for the region": the background is the only home the
        # picture has left, so its divisor is clamped.
        assert report["pages"][0]["bg_div"] == 2
        assert report["pages"][0]["bg_div"] < PRESETS["smallest"]["bg_div"]


# --------------------------------------------------------------------------
# Legibility (rule 4)
# --------------------------------------------------------------------------
@needs_tesseract
class TestLegibility:
    @pytest.mark.parametrize(
        "preset,floor", (("archival", 0.99), ("balanced", 0.97), ("smallest", 0.97))
    )
    def test_the_words_survive(self, scan, tmp_dir, gs_path, preset, floor):
        out = os.path.join(tmp_dir, f"{preset}.pdf")
        mrc_compress(scan, out, preset=preset, gs_path=gs_path)
        source_words = _ocr_words(scan, gs_path)
        assert len(source_words) > 100, "the fixture itself must be OCR-able"
        mrc_words = _ocr_words(out, gs_path)
        ratio, first = _similarity(source_words, mrc_words)
        assert ratio >= floor, f"{preset}: similarity {ratio:.4f}; first divergence {first}"

    def test_mrc_reads_at_least_as_well_as_ghostscript_ebook(
        self, text_scan, tmp_dir, gs_path
    ):
        # The other half of the register's claim: smaller AND not worse.
        mrc = os.path.join(tmp_dir, "mrc.pdf")
        ebook = os.path.join(tmp_dir, "ebook.pdf")
        mrc_compress(text_scan, mrc, gs_path=gs_path)
        compress(text_scan, ebook, quality="ebook", gs_path=gs_path)
        source_words = _ocr_words(text_scan, gs_path)
        mrc_ratio, _ = _similarity(source_words, _ocr_words(mrc, gs_path))
        gs_ratio, _ = _similarity(source_words, _ocr_words(ebook, gs_path))
        assert mrc_ratio >= gs_ratio - 0.005


# --------------------------------------------------------------------------
# The text-verification gate
# --------------------------------------------------------------------------
class TestVerifyText:
    """A compression setting may be lossy; it may not quietly destroy the text.

    Two halves, pinned separately on purpose: the SCORING (does the comparison
    measure what it claims?) and the REVERT PATH (does a failing page keep its
    original scan?). Only the first needs Tesseract; forcing the second through
    a real segmentation failure would pin a fixture's luck rather than the
    behaviour, so the score is substituted and the path is what is asserted.
    """

    def test_an_empty_source_scores_one(self):
        # A scan with no recognisable text has nothing to lose, and MRC does
        # not create a text layer (boundary 3). Scoring it 0 would revert
        # every page of a wordless scan.
        assert mrc_verify.text_similarity("", "anything at all")[0] == 1.0

    def test_identical_text_scores_one_and_destroyed_text_scores_low(self):
        words = "the quick brown fox jumps over the lazy dog " * 30
        assert mrc_verify.text_similarity(words, words)[0] == 1.0
        ratio, first = mrc_verify.text_similarity(words, "|||| ||| ||||")
        assert ratio < 0.1
        assert first, "the first divergence is reported, not just the number"

    def test_autojunk_is_off(self):
        # The bug this exists for: autojunk discards any token in over
        # 1% of a sequence longer than 200, which on prose is most words — it
        # scored a CORRECT page at 7/713.
        words = ("the quick brown fox jumps over the lazy dog and then some " * 25).split()
        changed = list(words)
        changed[5] = "0ver"
        naive = difflib.SequenceMatcher(None, words, changed).ratio()
        ours, _ = mrc_verify.text_similarity(" ".join(words), " ".join(changed))
        # One word out of 300 differs. The default heuristic calls the page
        # 1.7% similar; ours calls it 99.7%.
        assert naive < 0.05
        assert ours > 0.99

    def test_the_reconstruction_is_what_a_viewer_draws(self):
        # Ink pixels take the foreground colour, paper takes the background —
        # the stencil's semantics, at SOURCE resolution.
        from engine.mrc_codecs import encode_layer_jpeg

        ink = np.zeros((40, 40), dtype=bool)
        ink[10:20, 10:20] = True
        bg = encode_layer_jpeg(Image.new("RGB", (10, 10), (250, 250, 250)), quality=95)
        fg = encode_layer_jpeg(Image.new("RGB", (1, 1), (0, 0, 0)), quality=95)
        recon = np.asarray(mrc_verify.reconstruct_page(bg, fg, ink, (40, 40)))
        assert recon.shape == (40, 40, 3)
        assert recon[15, 15].max() < 40, "ink is the foreground colour"
        assert recon[2, 2].min() > 200, "paper is the background"

    def test_verification_off_costs_nothing_and_reports_nothing(
        self, text_scan, tmp_dir, gs_path
    ):
        report = mrc_compress(text_scan, os.path.join(tmp_dir, "o.pdf"), gs_path=gs_path)
        assert report["verify_text"] is False
        assert report["min_text_similarity"] is None
        assert report["pages_reverted"] == 0
        assert "text_similarity" not in report["pages"][0]

    def test_the_switch_refuses_without_a_recognizer(self, text_scan, tmp_dir, gs_path):
        # Asked for and not available REFUSES. Running with the check quietly
        # skipped hands back exactly the output the switch exists to prevent.
        with pytest.raises(RuntimeError, match="cannot be verified"):
            mrc_compress(
                text_scan, os.path.join(tmp_dir, "o.pdf"),
                verify_text=True, tesseract_path="", gs_path=gs_path,
            )

    @needs_tesseract
    @pytest.mark.parametrize("preset", ("archival", "balanced", "smallest"))
    def test_every_preset_clears_its_own_floor_on_the_fixtures(
        self, text_scan, tmp_dir, gs_path, preset
    ):
        report = mrc_compress(
            text_scan, os.path.join(tmp_dir, f"{preset}.pdf"), preset=preset,
            verify_text=True, tesseract_path=str(TESSERACT), gs_path=gs_path,
        )
        assert report["pages_reverted"] == 0
        assert report["pages_mrc"] == 1
        assert report["min_text_similarity"] >= PRESETS[preset]["verify_threshold"]
        assert report["pages"][0]["text_similarity"] == report["min_text_similarity"]

    def test_a_failing_page_keeps_its_original_scan(
        self, monkeypatch, text_scan, tmp_dir, gs_path
    ):
        # The revert PATH. The score is substituted rather than provoked: a
        # real segmentation failure would pin the fixture's luck, and what
        # must be pinned is that a page below the floor is left alone.
        monkeypatch.setattr(
            "engine.mrc_verify.compare_page",
            lambda *a, **k: (0.10, "replace: ['contract'] -> ['c0ntract']"),
        )
        out = os.path.join(tmp_dir, "reverted.pdf")
        with pytest.raises(RuntimeError, match="failed text verification"):
            # Any existing file satisfies the presence guard; the recognizer
            # itself is substituted above, so nothing is ever spawned.
            mrc_compress(
                text_scan, out, verify_text=True,
                tesseract_path=gs_path, gs_path=gs_path,
            )
        # Nothing was written: a document whose only scanned page was refused
        # is not an output worth having, and a silent copy would be a lie.
        assert not os.path.exists(out)

    def test_a_mixed_document_reverts_only_the_failing_page(
        self, monkeypatch, text_scan, photo_scan, tmp_dir, gs_path
    ):
        mixed = os.path.join(tmp_dir, "mixed.pdf")
        with pikepdf.open(text_scan) as first, pikepdf.open(photo_scan) as second:
            first.pages.extend(second.pages)
            first.save(mixed)
        # Page 1 passes, page 2 fails — the per-page revert is the claim.
        scores = iter([(0.99, ""), (0.10, "replace: ['a'] -> ['b']")])
        monkeypatch.setattr(
            "engine.mrc_verify.compare_page", lambda *a, **k: next(scores)
        )
        out = os.path.join(tmp_dir, "mixed-mrc.pdf")
        report = mrc_compress(
            mixed, out, verify_text=True, tesseract_path=gs_path, gs_path=gs_path,
        )
        assert report["pages_mrc"] == 1
        assert report["pages_reverted"] == 1
        rows = {row["page"]: row for row in report["pages"]}
        assert rows[1]["decision"] == "mrc"
        assert rows[2]["decision"] == "reverted"
        assert "0.1000" in rows[2]["reason"] and "floor" in rows[2]["reason"]
        assert "first difference" in rows[2]["reason"]
        # The reverted page still carries its ORIGINAL scan: one image, and no
        # stencil beside it.
        page_two = _images_on_page(out, page_number=2)
        assert len(page_two) == 1
        assert page_two[0]["mask"] is None


# --------------------------------------------------------------------------
# PDF/A (probe-measured, frozen here)
# --------------------------------------------------------------------------
class TestPdfa:
    def test_pdfa_safe_writes_only_pdfa1_filters(self, text_scan, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "safe.pdf")
        report = mrc_compress(text_scan, out, pdfa_safe=True, gs_path=gs_path)
        assert report["mask_codec"] == CCITT_G4
        filters = {im["filter"] for im in _images_on_page(out)}
        assert "/JPXDecode" not in filters

    @pytest.mark.parametrize("level", ("1b", "2b"))
    def test_the_layering_survives_pdfa_conversion(self, text_scan, tmp_dir, gs_path, level):
        mrc = os.path.join(tmp_dir, "mrc.pdf")
        archival = os.path.join(tmp_dir, f"pdfa{level}.pdf")
        mrc_compress(text_scan, mrc, gs_path=gs_path)
        convert_pdfa(mrc, archival, level=level, gs_path=gs_path)
        images = _images_on_page(archival)
        masked = [im for im in images if im["mask"] is not None]
        assert masked, "the foreground lost its stencil reference"
        assert masked[0]["mask"]["image_mask"]
        filters = {im["filter"] for im in images}
        if level == "1b":
            # /JPXDecode is PDF 1.5, outside PDF/A-1's PDF 1.4 base — gs
            # transcodes it rather than dropping the layer.
            assert "/JPXDecode" not in filters
            assert "/DCTDecode" in filters


# --------------------------------------------------------------------------
# The one door
# --------------------------------------------------------------------------
class TestCompressDoor:
    def test_quality_mrc_reaches_the_pass(self, text_scan, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "via-compress.pdf")
        report = compress(text_scan, out, quality="mrc", gs_path=gs_path)
        assert report["quality"] == "mrc"
        assert report["preset"] == "balanced"
        assert report["pages_mrc"] == 1
        assert report["compressed_size"] == report["output_size"]

    def test_the_preset_reaches_the_pass_through_compress(self, text_scan, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "arch.pdf")
        report = compress(
            text_scan, out, quality="mrc", mrc_preset="archival", gs_path=gs_path
        )
        assert report["preset"] == "archival"

    def test_mrc_with_a_dpi_refuses_rather_than_dropping_one(
        self, text_scan, tmp_dir, gs_path
    ):
        with pytest.raises(ValueError, match="MRC compression has no DPI setting"):
            compress(text_scan, os.path.join(tmp_dir, "o.pdf"), quality="mrc", dpi=150,
                     gs_path=gs_path)

    def test_a_named_codec_that_is_absent_refuses_instead_of_substituting(
        self, text_scan, tmp_dir, gs_path
    ):
        with pytest.raises(RuntimeError, match="JBIG2 encoder is not available"):
            compress(
                text_scan,
                os.path.join(tmp_dir, "o.pdf"),
                quality="mrc",
                mrc_mask_codec="jbig2",
                jbig2_path="C:/definitely/not/here/jbig2.exe",
                gs_path=gs_path,
            )

    def test_the_verification_switch_reaches_the_pass_through_compress(
        self, text_scan, tmp_dir, gs_path
    ):
        # Every surface travels through the same door. The switch is exercised by its
        # own refusal — a parameter that silently went nowhere would let the
        # panel show a checkbox that does nothing.
        with pytest.raises(RuntimeError, match="cannot be verified"):
            compress(
                text_scan, os.path.join(tmp_dir, "o.pdf"), quality="mrc",
                mrc_verify_text=True, tesseract_path="", gs_path=gs_path,
            )

    def test_the_ghostscript_branch_is_untouched_by_the_mrc_arguments(
        self, sample_pdf, tmp_dir, gs_path, monkeypatch
    ):
        # The claim is that the mrc_* keywords never reach the Ghostscript
        # branch, so the thing to compare is the COMMAND, not the output.
        # Comparing output SIZE flaked: two runs of gs on one input differ by
        # a few bytes now and then (measured — 3788 vs 3780 with byte-identical
        # arguments and no other code in the process), so the pin failed on its
        # own nondeterminism roughly one run in ten and said nothing about the
        # arguments when it did.
        import engine.compress as compress_module

        seen: list[list[str]] = []
        real_gs = compress_module.budget.gs

        def record(cmd, **kwargs):
            seen.append([str(part) for part in cmd])
            return real_gs(cmd, **kwargs)

        monkeypatch.setattr(compress_module.budget, "gs", record)

        plain = os.path.join(tmp_dir, "plain.pdf")
        withargs = os.path.join(tmp_dir, "withargs.pdf")
        compress(sample_pdf, plain, quality="ebook", gs_path=gs_path)
        compress(
            sample_pdf, withargs, quality="ebook", gs_path=gs_path,
            mrc_preset="smallest", mrc_pdfa_safe=True, mrc_bg_div=8,
            mrc_verify_text=True, tesseract_path="",
        )
        assert len(seen) == 2
        # Only the output path may differ between the two invocations.
        assert [a for a in seen[0] if not a.startswith("-sOutputFile=")] == [
            a for a in seen[1] if not a.startswith("-sOutputFile=")
        ]
        assert not any("mrc" in a.lower() for a in seen[1])
        assert os.path.getsize(plain) > 0 and os.path.getsize(withargs) > 0


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------
class TestReport:
    def test_every_page_is_accounted_for(self, text_scan, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "mrc.pdf")
        report = mrc_compress(text_scan, out, gs_path=gs_path)
        assert report["pages_mrc"] + report["pages_untouched"] == len(report["pages"])
        row = report["pages"][0]
        assert row["decision"] == "mrc"
        assert row["source_dpi"] == 300
        assert row["mask_bytes"] > 0 and row["bg_bytes"] > 0 and row["fg_bytes"] > 0

    def test_the_codec_actually_used_is_reported(self, text_scan, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "mrc.pdf")
        report = mrc_compress(
            text_scan, out, mask_codec="ccitt", gs_path=gs_path
        )
        assert report["mask_codec"] == CCITT_G4
        assert report["requested_mask_codec"] == CCITT_G4

    def test_a_mixed_document_reports_both_decisions(self, text_scan, sample_pdf, tmp_dir, gs_path):
        mixed = os.path.join(tmp_dir, "mixed.pdf")
        with pikepdf.open(text_scan) as scan_pdf, pikepdf.open(sample_pdf) as other:
            scan_pdf.pages.extend(other.pages[:2])
            scan_pdf.save(mixed)
        out = os.path.join(tmp_dir, "mrc.pdf")
        report = mrc_compress(mixed, out, gs_path=gs_path)
        assert report["pages_mrc"] == 1
        assert report["pages_untouched"] == 2
        decisions = [row["decision"] for row in report["pages"]]
        assert decisions == ["mrc", "untouched", "untouched"]
        # The pages MRC did not touch still come through.
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 3
