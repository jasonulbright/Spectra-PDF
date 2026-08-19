"""Scan enhancement — deskew, despeckle, background, orientation.

The fixtures are built by the checked-in `tests/fixtures/make_enhance_scans.py`
and committed beside it, so every number below is measured against bytes that
can be regenerated and diffed reproducibly. Each fixture carries ONE known
defect, which is what lets an accuracy claim be scored against a ground truth
rather than against "looks better".

What is pinned, and why each pin exists rather than being obvious:

  * **Deskew accuracy** — the whole feature is a measurement. The bound is
    0.1 degrees, five times the worst error measured over -12..+8 degrees
    (0.02), which leaves room for a different Pillow or numpy build without
    leaving room for a regression.
  * **Despeckle safety** — removing a full stop is worse than leaving a speck,
    so the CLEAN page's zero is as load-bearing as the dirty page's count.
  * **Idempotence** — the raster arms are LOSSY surgery, so "enhancing twice
    must not degrade twice" is a claim that has to be measured. Three passes
    per fixture, and the pass that changes nothing must write nothing.
  * **Survival** — the argument for content-stream surgery over a rebuild is
    that /AcroForm and the invisible OCR layer come through untouched.
  * **Order** — enhancement before recognition is enforced in `validate_steps`
    and demonstrated end to end: a sideways scan recognises as nothing, and
    the same scan enhanced first recognises as prose.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import numpy as np
import pikepdf
import pytest
from PIL import Image, ImageFilter

from engine.batch_ocr import ocr_file
from engine.enhance_scan import (
    BACKGROUND_TRIGGER,
    DEFAULT_OSD_CONFIDENCE,
    DEFAULT_SPECK_GAP_IN,
    DEFAULT_SPECK_SIZE_IN,
    analyze_scan,
    detect_orientation,
    enhance_scan,
    estimate_skew,
    find_specks,
    paper_estimate,
    whiten,
)
from engine.guided_actions import validate_steps
from engine.mrc import segment
from engine.recognize import recognize

import gs_axis

FIXTURES = Path(__file__).resolve().parent / "fixtures"
RESOURCES = Path(__file__).resolve().parent.parent / "resources"
TESSERACT = RESOURCES / "tesseract" / "tesseract.exe"

#: `make_enhance_scans.py` builds `scan-skew.pdf` at exactly this angle.
SKEW_DEGREES = 2.75
#: Five times the worst error measured over -12..+8 degrees.
SKEW_TOLERANCE = 0.1

needs_tesseract = pytest.mark.skipif(
    not TESSERACT.is_file(), reason="Tesseract not vendored"
)
GS = gs_axis.GS_PATH
needs_gs = gs_axis.requires_gs


def _copy(name: str, tmp_dir) -> str:
    src = FIXTURES / name
    if not src.is_file():
        pytest.skip(f"{name} not generated (tests/fixtures/make_enhance_scans.py)")
    dest = os.path.join(tmp_dir, name)
    shutil.copy2(src, dest)
    return dest


@pytest.fixture
def skew_scan(tmp_dir):
    return _copy("scan-skew.pdf", tmp_dir)


@pytest.fixture
def speckle_scan(tmp_dir):
    return _copy("scan-speckle.pdf", tmp_dir)


@pytest.fixture
def dim_scan(tmp_dir):
    return _copy("scan-dim.pdf", tmp_dir)


@pytest.fixture
def sideways_scan(tmp_dir):
    return _copy("scan-sideways.pdf", tmp_dir)


def _page_gray(path: str) -> np.ndarray:
    """The page's own scan samples as greyscale — the array the arms measure."""
    with pikepdf.open(path) as pdf:
        page = pdf.pages[0]
        name = next(iter(page.Resources.XObject.keys()))
        image = pikepdf.PdfImage(page.Resources.XObject[name]).as_pil_image()
    return np.asarray(image.convert("L"), dtype=np.uint8)


def _rotated_page(angle: float) -> np.ndarray:
    """A constructed page at a known angle, built the way the fixtures are."""
    import sys

    sys.path.insert(0, str(FIXTURES))
    from make_enhance_scans import base_page, scan_look  # noqa: PLC0415

    page = base_page()
    turned = page.rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=(252, 250, 244))
    return np.asarray(scan_look(turned).convert("L"), dtype=np.uint8)


# --------------------------------------------------------------------------
# Deskew
# --------------------------------------------------------------------------
class TestDeskew:
    def test_measures_the_fixture_angle(self, skew_scan):
        angle = estimate_skew(_page_gray(skew_scan), dpi=300)
        assert abs(angle - SKEW_DEGREES) <= SKEW_TOLERANCE, angle

    @needs_gs
    @pytest.mark.parametrize("truth", [0.5, 1.0, 2.0, 3.5, 5.0, -1.5, -4.0])
    def test_accuracy_across_the_range(self, truth):
        # 0.5-5 degrees is the band a sheet feeder actually produces, plus a
        # negative pair — the estimator must not be one-sided.
        angle = estimate_skew(_rotated_page(truth), dpi=300)
        assert abs(angle - truth) <= SKEW_TOLERANCE, (truth, angle)

    def test_a_blank_page_gets_no_invented_angle(self):
        blank = np.full((900, 700), 250, dtype=np.uint8)
        assert estimate_skew(blank, dpi=300) == 0.0

    def test_the_search_range_bounds_the_answer(self, skew_scan):
        # A caller who narrows the search cannot be handed an angle outside it.
        angle = estimate_skew(_page_gray(skew_scan), dpi=300, max_deg=1.0)
        assert -1.0 <= angle <= 1.0

    @needs_gs
    def test_the_pass_straightens_and_reports(self, skew_scan, tmp_dir):
        out = os.path.join(tmp_dir, "straight.pdf")
        report = enhance_scan(
            skew_scan, out, orientation=False, gs_path=str(GS)
        )
        row = report["pages"][0]
        assert row["decision"] == "enhanced"
        assert row["deskew_applied"] is True
        assert abs(row["skew_deg"] - SKEW_DEGREES) <= SKEW_TOLERANCE
        # The residual on the OUTPUT is what the correction is judged by.
        assert abs(estimate_skew(_page_gray(out), dpi=300)) <= SKEW_TOLERANCE

    @needs_gs
    def test_the_raster_keeps_its_pixel_dimensions(self, skew_scan, tmp_dir):
        # expand=False with a paper fill — a rotation that grew the raster
        # would need a new CTM and would change what the page measures.
        before = _page_gray(skew_scan).shape
        out = os.path.join(tmp_dir, "straight.pdf")
        enhance_scan(skew_scan, out, orientation=False, gs_path=str(GS))
        assert _page_gray(out).shape == before

    @needs_gs
    def test_an_angle_below_the_floor_is_reported_and_not_applied(
        self, skew_scan, tmp_dir
    ):
        out = os.path.join(tmp_dir, "untouched.pdf")
        report = enhance_scan(
            skew_scan,
            out,
            deskew=True,
            despeckle=False,
            background=False,
            orientation=False,
            min_skew_deg=5.0,
            gs_path=str(GS),
        )
        row = report["pages"][0]
        assert abs(row["skew_deg"] - SKEW_DEGREES) <= SKEW_TOLERANCE
        assert row["decision"] == "unchanged"
        assert report["written"] is False


# --------------------------------------------------------------------------
# Despeckle
# --------------------------------------------------------------------------
class TestDespeckle:
    def _specks(self, gray, **kw):
        _ink, pictorial, stats = segment(gray, dpi=300, k=0.20)
        return find_specks(gray, pictorial, int(stats["window"]), dpi=300, **kw)

    def test_finds_the_injected_specks(self, speckle_scan):
        _mask, count = self._specks(_page_gray(speckle_scan))
        # 900 were injected; the rest landed on glyphs and are no longer
        # isolated, which is the point of injecting them onto a text page.
        assert 600 <= count <= 850, count

    def test_removes_nothing_from_a_clean_page(self, tmp_dir):
        clean = _copy("scan-text.pdf", tmp_dir)
        _mask, count = self._specks(_page_gray(clean))
        assert count == 0

    def test_the_isolation_gap_only_ever_removes_fewer(self, speckle_scan):
        gray = _page_gray(speckle_scan)
        _m, without = self._specks(gray, gap_in=0.0)
        _m2, with_gap = self._specks(gray, gap_in=DEFAULT_SPECK_GAP_IN)
        assert with_gap <= without
        assert with_gap > 0

    def test_a_larger_threshold_starts_eating_real_marks(self, tmp_dir):
        # The measurement the default rests on: at 0.014 in the clean page
        # starts losing real marks, so the default sits one step below.
        clean = _page_gray(_copy("scan-text.pdf", tmp_dir))
        _m, at_default = self._specks(clean, size_in=DEFAULT_SPECK_SIZE_IN, gap_in=0.0)
        _m2, at_wide = self._specks(clean, size_in=0.014, gap_in=0.0)
        assert at_default == 0
        assert at_wide > 0

    @needs_gs
    def test_the_pass_removes_them_and_reports_the_count(self, speckle_scan, tmp_dir):
        out = os.path.join(tmp_dir, "clean.pdf")
        report = enhance_scan(
            speckle_scan,
            out,
            deskew=False,
            background=False,
            orientation=False,
            gs_path=str(GS),
        )
        row = report["pages"][0]
        assert row["despeckle_applied"] is True
        assert row["specks"] > 600
        _mask, after = self._specks(_page_gray(out))
        # Converges downward: the re-encode can leave a component that crosses
        # the threshold again, but never more than a handful.
        assert after < 10


# --------------------------------------------------------------------------
# Background
# --------------------------------------------------------------------------
class TestBackground:
    def test_whitening_raises_the_paper_and_improves_the_separation(self, dim_scan):
        gray = _page_gray(dim_scan)
        samples = gray.astype(np.float32)[..., None]
        ink, _pictorial, _stats = segment(gray, dpi=300, k=0.20)
        paper = paper_estimate(samples, ~ink)
        out = whiten(samples, paper, 1.0)
        assert samples[~ink].mean() < 200
        assert out[~ink].mean() > 245
        # The test that this is a background correction and not a brightness
        # slider: the ink/paper separation has to GROW.
        assert (out[~ink].mean() - out[ink].mean()) > (
            samples[~ink].mean() - samples[ink].mean()
        )

    def test_strength_scales_between_the_source_and_the_correction(self, dim_scan):
        gray = _page_gray(dim_scan)
        samples = gray.astype(np.float32)[..., None]
        ink, _p, _s = segment(gray, dpi=300, k=0.20)
        paper = paper_estimate(samples, ~ink)
        means = [whiten(samples, paper, s)[~ink].mean() for s in (0.0, 0.25, 0.5, 1.0)]
        assert means == sorted(means)
        assert means[0] == pytest.approx(samples[~ink].mean(), abs=0.01)

    @needs_gs
    def test_the_pass_whitens_and_reports_both_levels(self, dim_scan, tmp_dir):
        out = os.path.join(tmp_dir, "white.pdf")
        report = enhance_scan(
            dim_scan, out, deskew=False, despeckle=False, orientation=False, gs_path=str(GS)
        )
        row = report["pages"][0]
        assert row["background_applied"] is True
        assert row["paper_before"] < BACKGROUND_TRIGGER
        assert row["paper_after"] > BACKGROUND_TRIGGER

    @needs_gs
    def test_an_already_white_page_declines(self, dim_scan, tmp_dir):
        # Without the trigger every run would decode and re-encode every page
        # to change nothing, so the decline is the feature, not an optimisation.
        once = os.path.join(tmp_dir, "white.pdf")
        enhance_scan(
            dim_scan, once, deskew=False, despeckle=False, orientation=False, gs_path=str(GS)
        )
        twice = os.path.join(tmp_dir, "white2.pdf")
        report = enhance_scan(
            once, twice, deskew=False, despeckle=False, orientation=False, gs_path=str(GS)
        )
        assert report["written"] is False
        assert report["pages"][0]["decision"] == "unchanged"
        assert not os.path.exists(twice)


# --------------------------------------------------------------------------
# Orientation
# --------------------------------------------------------------------------
class TestOrientation:
    @needs_tesseract
    @pytest.mark.parametrize("turn,expected", [(0, 0), (90, 90), (180, 180), (270, 270)])
    def test_reads_every_turn_confidently(self, turn, expected, tmp_dir):
        clean = _copy("scan-text.pdf", tmp_dir)
        with pikepdf.open(clean) as pdf:
            page = pdf.pages[0]
            name = next(iter(page.Resources.XObject.keys()))
            image = pikepdf.PdfImage(page.Resources.XObject[name]).as_pil_image()
        turned = image.rotate(turn, expand=True)
        reading, error = detect_orientation(turned, str(TESSERACT), dpi=300)
        assert error == "", error
        assert reading["rotate"] == expected
        # The floor is 2.0 and every correct reading measured 15 or better.
        assert reading["confidence"] > 10.0
        assert reading["script"] == "Latin"

    @needs_tesseract
    def test_a_page_with_nothing_to_read_scores_below_the_floor(self):
        blank = Image.new("RGB", (2550, 3300), (250, 247, 236))
        reading, error = detect_orientation(blank, str(TESSERACT), dpi=300)
        # Either Tesseract refuses outright or it answers with no confidence.
        # Both are "not upright, unknown", and neither may cross the floor.
        if reading is not None:
            assert reading["confidence"] < DEFAULT_OSD_CONFIDENCE
        else:
            assert error

    @needs_tesseract
    @needs_gs
    def test_the_pass_writes_page_rotate_and_nothing_else(self, sideways_scan, tmp_dir):
        out = os.path.join(tmp_dir, "upright.pdf")
        report = enhance_scan(
            sideways_scan,
            out,
            deskew=False,
            despeckle=False,
            background=False,
            gs_path=str(GS),
            tesseract_path=str(TESSERACT),
        )
        row = report["pages"][0]
        assert row["rotate_applied"] == 90
        assert row["orientation"]["confidence"] >= DEFAULT_OSD_CONFIDENCE
        with pikepdf.open(out) as pdf:
            assert int(pdf.pages[0].obj.get("/Rotate", 0)) == 90
        # Orientation is LOSSLESS: with every raster arm off, the scan's own
        # samples must be the bytes they were.
        assert _page_gray(out).tobytes() == _page_gray(sideways_scan).tobytes()

    @needs_tesseract
    @needs_gs
    def test_a_reading_below_the_floor_is_reported_and_not_applied(
        self, sideways_scan, tmp_dir
    ):
        out = os.path.join(tmp_dir, "left.pdf")
        report = enhance_scan(
            sideways_scan,
            out,
            deskew=False,
            despeckle=False,
            background=False,
            osd_confidence=999.0,
            gs_path=str(GS),
            tesseract_path=str(TESSERACT),
        )
        row = report["pages"][0]
        assert row["orientation"]["rotate"] == 90
        assert row["decision"] == "unchanged"
        assert report["written"] is False

    @needs_gs
    def test_orientation_without_tesseract_refuses_by_name(self, sideways_scan, tmp_dir):
        # Asked for and not available REFUSES: running with the check quietly
        # skipped hands back exactly the output the switch exists to prevent.
        with pytest.raises(RuntimeError, match="OCR engine is not available"):
            enhance_scan(
                sideways_scan,
                os.path.join(tmp_dir, "x.pdf"),
                gs_path=str(GS),
                tesseract_path="",
            )


# --------------------------------------------------------------------------
# Classification and survival
# --------------------------------------------------------------------------
class TestClassification:
    def test_a_born_digital_document_refuses_by_name(self, sample_pdf, tmp_dir):
        dest = os.path.join(tmp_dir, "born.pdf")
        shutil.copy2(sample_pdf, dest)
        with pytest.raises(ValueError, match="is a scanned image"):
            enhance_scan(dest, os.path.join(tmp_dir, "out.pdf"), orientation=False)

    def test_a_born_digital_page_says_why_in_the_analysis(self, sample_pdf, tmp_dir):
        dest = os.path.join(tmp_dir, "born.pdf")
        shutil.copy2(sample_pdf, dest)
        report = analyze_scan(dest, orientation=False)
        assert report["pages_scanned"] == 0
        assert all(r["decision"] == "untouched" for r in report["pages"])
        assert all("not a scanned image" in r["reason"] for r in report["pages"])

    @needs_gs
    def test_acroform_fields_survive_the_surgery(self, tmp_dir):
        form = _copy("scan-form.pdf", tmp_dir)
        with pikepdf.open(form) as pdf:
            before = len(pdf.Root.AcroForm.Fields)
            annots = len(pdf.pages[0].obj["/Annots"])
        out = os.path.join(tmp_dir, "form-out.pdf")
        enhance_scan(form, out, orientation=False, gs_path=str(GS))
        with pikepdf.open(out) as pdf:
            assert len(pdf.Root.AcroForm.Fields) == before
            assert len(pdf.pages[0].obj["/Annots"]) == annots

    @needs_gs
    def test_an_invisible_ocr_layer_survives_the_surgery(self, tmp_dir):
        text = _copy("scan-text.pdf", tmp_dir)
        out = os.path.join(tmp_dir, "text-out.pdf")
        enhance_scan(text, out, orientation=False, gs_path=str(GS))
        with pikepdf.open(out) as pdf:
            assert b"3 Tr" in pdf.pages[0].Contents.read_bytes()

    @needs_gs
    def test_a_lossy_source_re_encodes_lossy(self, dim_scan, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        report = enhance_scan(dim_scan, out, orientation=False, gs_path=str(GS))
        assert report["pages"][0]["source_filter"] == "/DCTDecode"
        assert report["pages"][0]["output_filter"] == "/DCTDecode"

    @needs_gs
    def test_page_selection_and_the_out_of_range_refusal(self, skew_scan, sample_pdf, tmp_dir):
        merged = os.path.join(tmp_dir, "merged.pdf")
        with pikepdf.open(skew_scan) as a, pikepdf.open(sample_pdf) as b:
            a.pages.extend(b.pages[:2])
            a.save(merged)
        report = enhance_scan(
            merged, os.path.join(tmp_dir, "sel.pdf"), pages=[1],
            orientation=False, gs_path=str(GS),
        )
        assert [r["page"] for r in report["pages"]] == [1]
        with pytest.raises(ValueError, match="out of range"):
            enhance_scan(merged, os.path.join(tmp_dir, "x.pdf"), pages=[9])


class TestOptions:
    @pytest.mark.parametrize(
        "kwargs,message",
        [
            (
                dict(deskew=False, despeckle=False, background=False, orientation=False),
                "no enhancement was asked for",
            ),
            (dict(max_skew_deg=90.0), "maximum skew"),
            (dict(min_skew_deg=50.0), "minimum skew"),
            (dict(speck_size_in=0.5), "speck size"),
            (dict(speck_gap_in=9.0), "speck gap"),
            (dict(background_strength=2.0), "background strength"),
            (dict(osd_confidence=-1.0), "confidence floor"),
            (dict(jpeg_quality=0), "JPEG quality"),
        ],
    )
    def test_every_setting_refuses_out_of_band(self, skew_scan, tmp_dir, kwargs, message):
        # Refused BEFORE the document is opened, so a bad setting cannot half
        # apply across a long document.
        with pytest.raises(ValueError, match=message):
            enhance_scan(skew_scan, os.path.join(tmp_dir, "x.pdf"), **kwargs)


# --------------------------------------------------------------------------
# The preview, and idempotence
# --------------------------------------------------------------------------
class TestAnalyze:
    @needs_gs
    def test_the_analysis_writes_nothing(self, skew_scan):
        before = Path(skew_scan).read_bytes()
        analyze_scan(skew_scan, orientation=False, gs_path=str(GS))
        assert Path(skew_scan).read_bytes() == before

    @needs_gs
    def test_the_preview_predicts_exactly_what_the_pass_does(self, speckle_scan, tmp_dir):
        # The preview is only worth showing if it measures with the same
        # settings the pass applies — `_would_act` is the one place that
        # decision lives, so the two cannot disagree.
        preview = analyze_scan(speckle_scan, orientation=False, gs_path=str(GS))
        applied = enhance_scan(
            speckle_scan, os.path.join(tmp_dir, "out.pdf"),
            orientation=False, gs_path=str(GS),
        )
        p, a = preview["pages"][0], applied["pages"][0]
        assert p["would_deskew"] == a["deskew_applied"]
        assert p["would_despeckle"] == a["despeckle_applied"]
        assert p["would_whiten"] == a["background_applied"]
        assert p["would_rotate"] == a["rotate_applied"]
        assert preview["pages_would_change"] == applied["pages_enhanced"]


class TestIdempotence:
    """The arms are lossy raster surgery, so no arm may compound."""

    @needs_gs
    @needs_tesseract
    @pytest.mark.parametrize("name", ["scan-skew.pdf", "scan-dim.pdf", "scan-sideways.pdf"])
    def test_a_second_pass_writes_nothing(self, name, tmp_dir):
        current = _copy(name, tmp_dir)
        first = os.path.join(tmp_dir, "1.pdf")
        report = enhance_scan(
            current, first, gs_path=str(GS), tesseract_path=str(TESSERACT)
        )
        assert report["written"] is True
        second = os.path.join(tmp_dir, "2.pdf")
        again = enhance_scan(
            first, second, gs_path=str(GS), tesseract_path=str(TESSERACT)
        )
        assert again["written"] is False
        assert again["pages_unchanged"] == 1
        assert not os.path.exists(second)

    @needs_gs
    @needs_tesseract
    def test_despeckle_settles_within_three_passes(self, speckle_scan, tmp_dir):
        # The one arm that is not an exact no-op on the second run: the JPEG
        # re-encode can leave a component that crosses the threshold again.
        # It converges DOWNWARD, and the third pass writes nothing.
        current = speckle_scan
        counts = []
        for i in range(3):
            out = os.path.join(tmp_dir, f"p{i}.pdf")
            report = enhance_scan(
                current, out, gs_path=str(GS), tesseract_path=str(TESSERACT)
            )
            counts.append(report["pages"][0].get("specks") or 0)
            if not report["written"]:
                break
            current = out
        assert counts == sorted(counts, reverse=True)
        assert counts[-1] < 10

    @needs_gs
    def test_deskew_resamples_the_page_once(self, skew_scan, tmp_dir):
        first = os.path.join(tmp_dir, "1.pdf")
        enhance_scan(skew_scan, first, orientation=False, gs_path=str(GS))
        second = os.path.join(tmp_dir, "2.pdf")
        again = enhance_scan(first, second, orientation=False, gs_path=str(GS))
        # The residual is below `min_skew_deg`, so the second run performs no
        # rotation at all — the page is resampled once however often this runs.
        assert abs(again["pages"][0]["skew_deg"]) < 0.1
        assert again["pages"][0].get("deskew_applied") in (None, False)


# --------------------------------------------------------------------------
# The batch / guided-action arms
# --------------------------------------------------------------------------
class TestOrder:
    def test_enhancement_must_come_before_ocr(self):
        with pytest.raises(ValueError, match="must come before OCR"):
            validate_steps([
                {"op": "ocr_file", "params": {"language": "eng"}},
                {"op": "enhance_scan", "params": {}},
            ])
        assert len(validate_steps([
            {"op": "enhance_scan", "params": {}},
            {"op": "ocr_file", "params": {"language": "eng"}},
        ])) == 2

    def test_enhancement_must_come_before_mrc(self):
        with pytest.raises(ValueError, match="must come before MRC"):
            validate_steps([
                {"op": "compress", "params": {"quality": "mrc"}},
                {"op": "enhance_scan", "params": {}},
            ])
        # An ordinary Ghostscript compress does not replace the page image, so
        # nothing about it constrains the enhancement.
        assert len(validate_steps([
            {"op": "compress", "params": {"quality": "ebook"}},
            {"op": "enhance_scan", "params": {}},
        ])) == 2

    def test_the_three_scan_steps_validate_in_their_one_legal_order(self):
        assert len(validate_steps([
            {"op": "enhance_scan", "params": {"orientation": False}},
            {"op": "ocr_file", "params": {"language": "eng"}},
            {"op": "compress", "params": {"quality": "mrc"}},
        ])) == 3

    def test_the_enhancement_parameters_are_allowed_on_the_step(self):
        steps = validate_steps([
            {
                "op": "enhance_scan",
                "params": {
                    "pages": "all",
                    "deskew": True,
                    "despeckle": True,
                    "background": True,
                    "orientation": False,
                    "max_skew_deg": 5.0,
                    "min_skew_deg": 0.2,
                    "speck_size_in": 0.008,
                    "speck_gap_in": 0.03,
                    "background_strength": 0.5,
                    "osd_confidence": 3.0,
                    "jpeg_quality": 90,
                },
            }
        ])
        assert steps[0]["params"]["jpeg_quality"] == 90
        with pytest.raises(ValueError, match="unknown parameter"):
            validate_steps([{"op": "enhance_scan", "params": {"gs_path": "evil.exe"}}])


class TestBatchArm:
    @needs_gs
    @needs_tesseract
    def test_ocr_file_enhances_before_it_recognises(self, sideways_scan, tmp_dir):
        out = os.path.join(tmp_dir, "searchable.pdf")
        result = ocr_file(
            sideways_scan, out, tesseract_path=str(TESSERACT), gs_path=str(GS), enhance=True
        )
        assert result["enhanceApplied"] is True
        assert result["pages_ocrd"] == 1
        # The whole argument for the order, end to end: the page went in
        # sideways and came out upright AND searchable.
        with pikepdf.open(out) as pdf:
            assert int(pdf.pages[0].obj.get("/Rotate", 0)) == 90
        # And the batch guarantee: the source is never modified.
        with pikepdf.open(sideways_scan) as pdf:
            assert int(pdf.pages[0].obj.get("/Rotate", 0)) == 0

    @needs_gs
    @needs_tesseract
    def test_enhancement_before_recognition_is_what_makes_the_words_readable(
        self, sideways_scan, tmp_dir
    ):
        # The evidence for the ordering rule, measured rather than asserted:
        # the same page recognises as noise sideways and as prose upright.
        raw = recognize(sideways_scan, 1, "eng", str(TESSERACT), str(GS))
        upright = os.path.join(tmp_dir, "upright.pdf")
        enhance_scan(
            sideways_scan, upright, deskew=False, despeckle=False, background=False,
            gs_path=str(GS), tesseract_path=str(TESSERACT),
        )
        fixed = recognize(upright, 1, "eng", str(TESSERACT), str(GS))
        assert "stencil" in fixed["text"].lower()
        assert "stencil" not in raw["text"].lower()

    @needs_gs
    def test_a_file_with_no_scan_is_noted_not_failed(self, sample_pdf, tmp_dir):
        src = os.path.join(tmp_dir, "born.pdf")
        shutil.copy2(sample_pdf, src)
        out = os.path.join(tmp_dir, "born-out.pdf")
        result = ocr_file(src, out, gs_path=str(GS), enhance=True, enhance_orientation=False)
        # Enhancement never fails the file — the refusal rides the result.
        assert "enhance" in result
        assert "scanned image" in result["enhance"]
        assert os.path.isfile(out)
