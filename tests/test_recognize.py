"""Engine-side OCR recognition.

The pure parsing/validation is tested directly; the two tests that need the
vendored binaries skip when those are absent, matching the gs_path fixture
convention (an unprovisioned box must not fail the suite -- but per the
a gate count is only recorded from a run with NO skips).
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
        # Multi-language selection must keep working on the native path: '+'-joined
        # loads both models rather than erroring.
        result = recognize(str(SCANNED), 1, "eng+fra", str(TESSERACT), str(GS))
        assert "INVOICE" in result["text"].upper()

    def test_the_vendored_tree_carries_no_jbig(self):
        # The tree's libtiff is rebuilt without JBIG (scripts/build-libtiff-nojbig.ps1)
        # so no GPL object code ships. Deleting libjbig-0.dll alone does not
        # achieve that: the import is static, and a tree that still names it is a
        # tesseract.exe that cannot start. Both halves are asserted, and the
        # recognition above proves the tree still runs.
        tree = TESSERACT.parent
        assert not (tree / "libjbig-0.dll").exists()
        referencing = [
            binary.name
            for binary in tree.iterdir()
            if binary.suffix.lower() in (".dll", ".exe")
            and b"libjbig" in binary.read_bytes()
        ]
        assert referencing == []

    def test_the_vendored_tree_can_actually_emit_tsv(self):
        # Guards the failure that cost real time: tessdata/configs/tsv is a
        # CONFIG file, not a model. Without it tesseract exits 0 and prints
        # plain text, so recognition silently yields zero boxes.
        assert (TESSERACT.parent / "tessdata" / "configs" / "tsv").is_file()

    def test_refuses_a_page_past_the_end(self):
        with pytest.raises(RuntimeError):
            recognize(str(SCANNED), 999, "eng", str(TESSERACT), str(GS))


#: The cropped fixture, in points. The MediaBox is letter; the CropBox is a
#: 300x200 window at (100, 500). One word is drawn inside that window, at a
#: baseline the round trip has to recover. A raster framed on the MediaBox
#: instead scales every recognised box by 300/612 across and 200/792 down and
#: lands it at the wrong corner, so each number below comes out different.
CROP_MEDIA = (612.0, 792.0)
CROP_BOX = (100.0, 500.0, 400.0, 700.0)
CROP_WORD = "INSIDE"
CROP_WORD_SIZE = 36.0
CROP_WORD_ORIGIN = (150.0, 600.0)


def _cropped_word_pdf(path, rotate: int = 0, cropped: bool = True) -> str:
    """One word inside a window on a larger MediaBox."""
    import pikepdf
    from pikepdf import Array, Dictionary, Name

    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=CROP_MEDIA)
    if cropped:
        page.obj[Name("/CropBox")] = Array(list(CROP_BOX))
    if rotate:
        page.obj[Name("/Rotate")] = int(rotate)
    font = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type1,
        BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding))
    page.Resources = Dictionary(Font=Dictionary(F1=font))
    x, y = CROP_WORD_ORIGIN
    page.Contents = pdf.make_stream(
        f"BT /F1 {CROP_WORD_SIZE:g} Tf 1 0 0 1 {x:g} {y:g} Tm"
        f" ({CROP_WORD}) Tj ET".encode("ascii"))
    pdf.save(str(path))
    pdf.close()
    return str(path)


def _recognized_span(src: str) -> tuple:
    """Where the recognised ink lands in PDF user space, through the shipped
    mapping the GUI and the batch arm both mirror.

    The union over every word rather than one named word: a page turned upside
    down is read as a different STRING (the recogniser is not asked to detect
    orientation), while the region the glyphs occupy is the same region. The
    frame question is about that region.
    """
    from engine.batch_ocr import _to_pdf_rects

    words = recognize(src, 1, "eng", str(TESSERACT), str(GS))["words"]
    rects = _to_pdf_rects(src, 0, words)
    assert rects, "nothing recognised"
    return (
        min(r["rect"][0] for r in rects),
        min(r["rect"][1] for r in rects),
        max(r["rect"][2] for r in rects),
        max(r["rect"][3] for r in rects),
    )


class TestTheRectMapping:
    """`batch_ocr._to_pdf_rects` maps a recognised box back into user space.

    It is the engine's half of a recipe the renderer
    (`lib/pdfx-build.displayRectToPdf`) and the form detector
    (`form_detect._display_rect_to_pdf`) also implement, and all three must
    answer the same. Needs no binaries: the mapping is arithmetic over the
    page box, and only the page box has to exist.
    """

    def test_every_quarter_turn_stays_inside_the_page_box(self, tmp_path):
        from engine.batch_ocr import _to_pdf_rects

        word = {"text": "w", "x": 0.2, "y": 0.3, "w": 0.25, "h": 0.1}
        for angle in (0, 90, 180, 270):
            src = _cropped_word_pdf(tmp_path / f"box{angle}.pdf", rotate=angle)
            (x0, y0, x1, y1) = _to_pdf_rects(src, 0, [word])[0]["rect"]
            # A normalised box lies inside the page by construction, so its
            # image does too. Swapping the box's width for its height under one
            # rotation sends it outside — /Rotate 270 on this 300x200 window
            # landed at y 710..760, above the box's own top edge of 700, which
            # is an invisible text layer written off the page.
            assert CROP_BOX[0] <= x0 < x1 <= CROP_BOX[2], angle
            assert CROP_BOX[1] <= y0 < y1 <= CROP_BOX[3], angle

    def test_it_agrees_with_the_form_detector(self, tmp_path):
        from engine.batch_ocr import _to_pdf_rects
        from engine.form_detect import _display_rect_to_pdf

        word = {"text": "w", "x": 0.2, "y": 0.3, "w": 0.25, "h": 0.1}
        for angle in (0, 90, 180, 270):
            src = _cropped_word_pdf(tmp_path / f"box{angle}.pdf", rotate=angle)
            assert _to_pdf_rects(src, 0, [word])[0]["rect"] == pytest.approx(
                _display_rect_to_pdf(
                    (word["x"], word["y"], word["w"], word["h"]),
                    CROP_BOX, angle)), angle

    def test_the_whole_display_area_maps_onto_the_whole_page_box(self, tmp_path):
        from engine.batch_ocr import _to_pdf_rects

        # Whatever the rotation, a full-page box has nowhere to go but the box.
        whole = {"text": "w", "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
        for angle in (0, 90, 180, 270):
            src = _cropped_word_pdf(tmp_path / f"full{angle}.pdf", rotate=angle)
            assert _to_pdf_rects(src, 0, [whole])[0]["rect"] == pytest.approx(
                list(CROP_BOX)), angle


@needs_ocr_stack
class TestTheRasterFrame:
    """The OCR raster carries the frame the recognised boxes are mapped back
    through, which is the CROP-INTERSECTED page box.

    Every consumer denormalizes against that box -- the GUI through pdf.js's
    `page.view`, `batch_ocr._to_pdf_rects` and `form_detect` through
    `/CropBox`. A raster framed on the MediaBox therefore does not merely
    read extra content: it writes the invisible text layer at a scaled,
    translated position, so the searchable text a reader selects lands
    nowhere near the glyphs it transcribes.

    The right answer is fixed by what the fixture draws. A page box never
    moves content in user space, so the same word on the same page with the
    CropBox removed must come back at the same user-space rect -- and a
    /Rotate on top of the CropBox must not move it either.
    """

    def test_the_word_comes_back_where_it_was_drawn(self, tmp_path):
        src = _cropped_word_pdf(tmp_path / "crop.pdf")
        assert recognize(src, 1, "eng", str(TESSERACT), str(GS))["text"].upper() \
            == CROP_WORD
        x0, y0, x1, y1 = _recognized_span(src)
        # The text matrix puts the word's origin at (150, 600) and the glyphs
        # are capitals, so the box starts at the baseline and rises by the cap
        # height -- 0.717 em of 36 pt, about 26 pt. Under a MediaBox raster the
        # same box arrives 26 pt tall times 200/792, under 7 pt, at y0 651.
        assert x0 == pytest.approx(CROP_WORD_ORIGIN[0], abs=6.0)
        assert y0 == pytest.approx(CROP_WORD_ORIGIN[1], abs=3.0)
        assert 20.0 <= y1 - y0 <= 32.0
        # Six capitals of Helvetica at 36 pt run past 100 pt; the MediaBox
        # raster shrinks the same span by 300/612 to about 56 pt.
        assert x1 - x0 >= 100.0

    def test_the_crop_box_does_not_move_the_answer(self, tmp_path):
        cropped = _recognized_span(_cropped_word_pdf(tmp_path / "crop.pdf"))
        whole = _recognized_span(
            _cropped_word_pdf(tmp_path / "whole.pdf", cropped=False))
        # One raster pixel at 300 dpi is 0.24 pt, and the two rasters quantize
        # the same glyph edges differently; nothing else may differ. A MediaBox
        # raster puts the cropped page's word at x 175, y 651 against the whole
        # page's x 154, y 599.
        assert cropped == pytest.approx(whole, abs=1.0)

    def test_rotate_does_not_move_the_answer_either(self, tmp_path):
        upright = _recognized_span(_cropped_word_pdf(tmp_path / "crop.pdf"))
        for angle in (90, 180, 270):
            turned = _recognized_span(
                _cropped_word_pdf(tmp_path / f"rot{angle}.pdf", rotate=angle))
            # The device turns the frame and `_to_pdf_rects` turns it back.
            # Disagreement between the two is a text layer written sideways.
            assert turned == pytest.approx(upright, abs=2.0), angle


class TestOcrFile:
    """The single-file arm: composed from the SAME
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


class TestBatchInPlace:
    """In-place batch mode: originals replaced through staged temps."""

    def test_in_place_refuses_dest_and_moved(self, tmp_path):
        from engine.batch_ocr import batch_ocr

        src = tmp_path / "src"
        src.mkdir()
        with pytest.raises(ValueError, match="no destination"):
            batch_ocr(source=str(src), dest=str(tmp_path / "out"), in_place=True)
        with pytest.raises(ValueError, match="cannot also move"):
            batch_ocr(source=str(src), moved_root=str(tmp_path / "moved"), in_place=True)
        with pytest.raises(ValueError, match="destination folder is required"):
            batch_ocr(source=str(src))

    @needs_ocr_stack
    def test_in_place_replaces_scanned_originals_only(self, tmp_path):
        from engine.batch_ocr import batch_ocr
        from engine.extract_text import extract_text
        import pikepdf

        src = tmp_path / "src"
        src.mkdir()
        shutil.copy2(SCANNED, src / "scan.pdf")
        text_pdf = src / "plain.pdf"
        doc = pikepdf.new()
        doc.add_blank_page(page_size=(200, 200))
        doc.save(text_pdf)
        plain_before = text_pdf.read_bytes()

        report = batch_ocr(
            source=str(src),
            in_place=True,
            tesseract_path=str(TESSERACT),
            gs_path=str(GS),
        )
        assert report["inPlace"] is True
        by_rel = {r["rel"]: r for r in report["results"]}
        assert by_rel["scan.pdf"]["status"] == "ocr"
        assert by_rel["scan.pdf"]["inPlace"] is True
        # The scanned ORIGINAL is now searchable, in its own place.
        assert len(extract_text(file=str(src / "scan.pdf"))["text"].strip()) > 10
        # A blank/no-text file is left byte-identical — nothing was written.
        assert by_rel["plain.pdf"]["status"] == "copied"
        assert text_pdf.read_bytes() == plain_before
        # No staging litter, no mirror.
        assert not list(src.glob("*.inplace.tmp"))
        assert not (tmp_path / "out").exists()
