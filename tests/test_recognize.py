"""Engine-side OCR recognition (Phase 12 step 3).

The pure parsing/validation is tested directly; the two tests that need the
vendored binaries skip when those are absent, matching the gs_path fixture
convention (an unprovisioned box must not fail the suite -- but per the
punchlist rule, a gate count is only recorded from a run with NO skips).
"""

import shutil
import subprocess
from pathlib import Path

import pytest

from engine.recognize import _parse_tsv, _png_size, recognize

ROOT = Path(__file__).resolve().parents[1]
TESSERACT = ROOT / "resources" / "tesseract" / "tesseract.exe"
GS = ROOT / "resources" / "ghostscript" / "gswin64c.exe"
SCANNED = ROOT / "e2e-tests" / "fixtures" / "scanned.pdf"

needs_ocr_stack = pytest.mark.skipif(
    not (TESSERACT.is_file() and GS.is_file() and SCANNED.is_file()),
    reason="vendored tesseract/ghostscript not provisioned",
)

HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"


def tsv(*rows: str) -> str:
    return "\n".join([HEADER, *rows]) + "\n"


class TestParseTsv:
    def test_keeps_only_word_rows(self):
        # Levels 1-4 are page/block/paragraph/line layout rows. Indexing them
        # would double-count every word inside a box that spans the whole line.
        text, words = _parse_tsv(
            tsv(
                "1\t1\t0\t0\t0\t0\t0\t0\t1000\t500\t-1\t",
                "4\t1\t1\t1\t1\t0\t10\t20\t100\t30\t-1\t",
                "5\t1\t1\t1\t1\t1\t10\t20\t40\t30\t96\tHello",
            ),
            1000,
            500,
        )
        assert [w["text"] for w in words] == ["Hello"]
        assert text == "Hello"

    def test_normalises_to_fractions_of_the_page(self):
        # The contract tesseract.js produced, kept byte-for-byte so every
        # downstream consumer's display->PDF conversion still applies.
        _, words = _parse_tsv(tsv("5\t1\t1\t1\t1\t1\t100\t50\t200\t25\t96\tWord"), 1000, 500)
        w = words[0]
        assert w["x"] == pytest.approx(0.1)
        assert w["y"] == pytest.approx(0.1)
        assert w["w"] == pytest.approx(0.2)
        assert w["h"] == pytest.approx(0.05)

    def test_drops_blank_and_whitespace_only_words(self):
        _, words = _parse_tsv(
            tsv(
                "5\t1\t1\t1\t1\t1\t10\t20\t40\t30\t96\t   ",
                "5\t1\t1\t1\t1\t2\t60\t20\t40\t30\t96\t",
                "5\t1\t1\t1\t1\t3\t90\t20\t40\t30\t96\tReal",
            ),
            1000,
            500,
        )
        assert [w["text"] for w in words] == ["Real"]

    def test_drops_degenerate_boxes(self):
        # A zero-width box would become a zero-area rect in the text layer.
        _, words = _parse_tsv(tsv("5\t1\t1\t1\t1\t1\t10\t20\t0\t30\t96\tGhost"), 1000, 500)
        assert words == []

    def test_survives_a_word_containing_spaces(self):
        # Why a real TSV reader and not str.split: the text column is last and
        # may contain spaces; splitting on whitespace shifts every column.
        _, words = _parse_tsv(tsv("5\t1\t1\t1\t1\t1\t10\t20\t40\t30\t96\tNew York"), 1000, 500)
        assert words[0]["text"] == "New York"

    def test_ignores_malformed_rows_rather_than_raising(self):
        # OCR output is machine-generated but this also parses whatever a CLI
        # user's tesseract emits; one bad row must not lose the whole page.
        _, words = _parse_tsv(
            tsv(
                "5\t1\t1\t1\t1\t1\tNOTANUMBER\t20\t40\t30\t96\tBad",
                "5\t1\t1\t1\t1\t2\t90\t20\t40\t30\t96\tGood",
            ),
            1000,
            500,
        )
        assert [w["text"] for w in words] == ["Good"]

    def test_text_is_the_words_in_order(self):
        text, _ = _parse_tsv(
            tsv(
                "5\t1\t1\t1\t1\t1\t10\t20\t40\t30\t96\tone",
                "5\t1\t1\t1\t1\t2\t60\t20\t40\t30\t96\ttwo",
            ),
            1000,
            500,
        )
        assert text == "one two"


class TestValidation:
    def test_rejects_a_language_that_could_reach_the_filesystem(self):
        # Tesseract treats -l as a filename stem, and this op also serves the
        # CLI where the value comes straight from a user.
        for bad in ["../../etc/passwd", "eng;rm", "eng/../x", "eng eng", "ENG!"]:
            with pytest.raises(ValueError):
                recognize("x.pdf", 1, bad, str(TESSERACT), str(GS))

    def test_an_empty_language_falls_back_to_the_default(self):
        # Matches ocr/language-selection.ts: an empty selection resolves to the
        # default rather than erroring, because an empty -l is what Tesseract
        # itself rejects. It gets past validation and fails on the file instead.
        with pytest.raises((FileNotFoundError, RuntimeError)):
            recognize("x.pdf", 1, "", str(TESSERACT), str(GS))

    def test_accepts_the_plus_joined_multi_language_form(self, tmp_path):
        # eng+fra must pass validation (it fails later on the missing file).
        with pytest.raises((FileNotFoundError, RuntimeError)):
            recognize(str(tmp_path / "nope.pdf"), 1, "eng+fra", str(TESSERACT), str(GS))

    def test_rejects_a_zero_or_negative_page(self):
        with pytest.raises(ValueError):
            recognize("x.pdf", 0, "eng", str(TESSERACT), str(GS))

    def test_names_the_missing_tool_rather_than_crashing(self, tmp_path):
        with pytest.raises(RuntimeError, match="not available"):
            recognize(str(SCANNED), 1, "eng", str(tmp_path / "no-tesseract.exe"), str(GS))

    def test_png_size_refuses_a_non_png(self, tmp_path):
        junk = tmp_path / "x.png"
        junk.write_bytes(b"not a png at all, definitely not 24 bytes of header")
        with pytest.raises(RuntimeError, match="did not produce a PNG"):
            _png_size(junk)


@needs_ocr_stack
class TestAgainstTheVendoredStack:
    def test_recognises_a_scanned_page_with_boxes_inside_the_page(self):
        result = recognize(str(SCANNED), 1, "eng", str(TESSERACT), str(GS))
        assert "INVOICE" in result["text"].upper()
        assert result["words"], "no word boxes returned"
        for w in result["words"]:
            # Normalised: every box lies within the page.
            assert 0.0 <= w["x"] <= 1.0
            assert 0.0 <= w["y"] <= 1.0
            assert 0.0 < w["w"] <= 1.0
            assert 0.0 < w["h"] <= 1.0
            assert w["x"] + w["w"] <= 1.001
            assert w["y"] + w["h"] <= 1.001

    def test_multi_language_still_recognises(self):
        # Issue #1 request 1 must keep working on the native path: '+'-joined
        # loads both models rather than erroring.
        result = recognize(str(SCANNED), 1, "eng+fra", str(TESSERACT), str(GS))
        assert "INVOICE" in result["text"].upper()

    def test_the_vendored_tree_can_actually_emit_tsv(self):
        # Guards the failure that cost real time: tessdata/configs/tsv is a
        # CONFIG file, not a model. Without it tesseract exits 0 and prints
        # plain text, so recognition silently yields zero boxes.
        assert (TESSERACT.parent / "tessdata" / "configs" / "tsv").is_file()

    def test_refuses_a_page_past_the_end(self):
        with pytest.raises(RuntimeError):
            recognize(str(SCANNED), 999, "eng", str(TESSERACT), str(GS))


class TestOcrFile:
    """The single-file arm (guided-actions slice 2): composed from the SAME
    helpers as batch_ocr, so these pin the composition, not new logic."""

    def test_text_pdf_reported_not_rewritten(self, tmp_pdf, tmp_dir):
        # A text PDF has no scanned pages: no binaries touched, output is a
        # plain copy, and the report says why nothing was OCR'd.
        from engine.batch_ocr import ocr_file

        out = str(Path(tmp_dir) / "searchable.pdf")
        result = ocr_file(file=tmp_pdf, output=out)
        assert result["pages_ocrd"] == 0
        assert result["skipped"] == "no scanned pages"
        assert Path(out).is_file()

    def test_text_pdf_in_place_is_a_no_op(self, tmp_pdf):
        from engine.batch_ocr import ocr_file

        before = Path(tmp_pdf).read_bytes()
        result = ocr_file(file=tmp_pdf, output=tmp_pdf)
        assert result["pages_ocrd"] == 0
        assert Path(tmp_pdf).read_bytes() == before  # untouched, not rewritten

    @needs_ocr_stack
    def test_scanned_file_becomes_searchable(self, tmp_dir):
        from engine.batch_ocr import ocr_file
        from engine.extract_text import extract_text

        work = Path(tmp_dir) / "scan.pdf"
        shutil.copy2(SCANNED, work)
        result = ocr_file(
            file=str(work),
            output=str(work),
            language="eng",
            tesseract_path=str(TESSERACT),
            gs_path=str(GS),
        )
        assert result["pages_ocrd"] >= 1
        text = extract_text(file=str(work))["text"]
        assert len(text.strip()) > 10
