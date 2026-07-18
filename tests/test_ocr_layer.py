"""Tests for the invisible OCR text layer (Phase 2m persistence half)."""

import os

import pikepdf
import pytest

from engine.extract_text import extract_text
from engine.ocr_layer import apply_ocr_layer


def _scanlike_pdf(path: str, size=(400, 300)) -> None:
    """A page with visual content but ZERO extractable text — the scanned-
    document stand-in (a gray block instead of a raster image; the layer
    logic is identical)."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=size)
    page.Contents = pdf.make_stream(b"q 0.9 0.9 0.9 rg 20 20 360 260 re f Q")
    pdf.save(path)
    pdf.close()


WORDS = [
    {"text": "INVOICE", "rect": [40, 240, 140, 262]},
    {"text": "total", "rect": [40, 200, 80, 216]},
    {"text": "42.00", "rect": [90, 200, 140, 216]},
]


class TestApplyOcrLayer:
    def test_text_becomes_extractable_and_page_renders_identically(self, tmp_dir, gs_path):
        src = os.path.join(tmp_dir, "scan.pdf")
        out = os.path.join(tmp_dir, "ocr.pdf")
        _scanlike_pdf(src)
        assert extract_text(src)["text"].strip() == ""  # genuinely unsearchable

        r = apply_ocr_layer(src, out, [{"page": 1, "words": WORDS}])
        assert r["pages_applied"] == 1 and r["words_applied"] == 3

        # THE acceptance criterion: the file is now searchable on disk,
        # verified by an independent extractor.
        text = extract_text(out)["text"]
        assert "INVOICE" in text and "total" in text and "42.00" in text

        # Invisible: the output rasterizes pixel-identically to the input —
        # verified through compare_visual's own machinery.
        from engine.compare import compare_visual

        v = compare_visual(src, out, gs_path=gs_path)
        assert v["summary"]["identical"] is True

        # The layer really is invisible-text-mode inside a tagged XObject.
        with pikepdf.open(out) as pdf:
            xo = pdf.pages[0].obj["/Resources"]["/XObject"]
            assert "/OpenPDFStudioOCR" in xo
            assert b"3 Tr" in xo["/OpenPDFStudioOCR"].read_bytes()

    def test_reapply_replaces_not_stacks(self, tmp_dir):
        src = os.path.join(tmp_dir, "scan.pdf")
        first = os.path.join(tmp_dir, "a.pdf")
        second = os.path.join(tmp_dir, "b.pdf")
        _scanlike_pdf(src)
        apply_ocr_layer(src, first, [{"page": 1, "words": WORDS}])
        apply_ocr_layer(first, second, [{"page": 1, "words": [{"text": "INVOICE", "rect": [40, 240, 140, 262]}]}])
        text = extract_text(second)["text"]
        assert text.count("INVOICE") == 1  # replaced, not stacked
        assert "total" not in text  # old layer fully gone

    def test_validation_fails_closed(self, tmp_dir):
        src = os.path.join(tmp_dir, "scan.pdf")
        out = os.path.join(tmp_dir, "nope.pdf")
        _scanlike_pdf(src)
        with pytest.raises(ValueError, match="out of range"):
            apply_ocr_layer(src, out, [{"page": 99, "words": WORDS}])
        with pytest.raises(ValueError, match="malformed word"):
            apply_ocr_layer(src, out, [{"page": 1, "words": [{"text": "x"}]}])
        with pytest.raises(ValueError, match="No OCR words"):
            apply_ocr_layer(src, out, [])
        with pytest.raises(ValueError, match="No OCR words"):
            apply_ocr_layer(src, out, [{"page": 1, "words": [{"text": "   ", "rect": [1, 1, 2, 2]}]}])
        assert not os.path.exists(out)

    def test_non_winansi_words_skipped_not_fatal(self, tmp_dir):
        # OCR noise outside WinAnsi skips the word (a partially-searchable
        # page beats an unsearchable one); the count reports honestly.
        src = os.path.join(tmp_dir, "scan.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _scanlike_pdf(src)
        r = apply_ocr_layer(
            src,
            out,
            [{"page": 1, "words": [{"text": "日本語", "rect": [10, 10, 60, 26]}, {"text": "ok", "rect": [70, 10, 100, 26]}]}],
        )
        assert r["words_applied"] == 1
        assert "ok" in extract_text(out)["text"]

    def test_in_place(self, tmp_dir):
        import shutil

        src = os.path.join(tmp_dir, "scan.pdf")
        _scanlike_pdf(src)
        work = os.path.join(tmp_dir, "work.pdf")
        shutil.copy(src, work)
        apply_ocr_layer(work, work, [{"page": 1, "words": WORDS}])
        assert "INVOICE" in extract_text(work)["text"]

    def test_word_positions_land_in_user_space(self, tmp_dir):
        # pdfminer reports glyph positions; the layer lives in a Form
        # XObject, which pdfminer surfaces as an LTFigure of LTChars. The
        # INVOICE run's chars must sit inside the requested rect band.
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LTChar, LTFigure

        src = os.path.join(tmp_dir, "scan.pdf")
        out = os.path.join(tmp_dir, "ocr.pdf")
        _scanlike_pdf(src)
        apply_ocr_layer(src, out, [{"page": 1, "words": WORDS}])
        chars: list = []
        for layout in extract_pages(out):
            for element in layout:
                if isinstance(element, LTFigure):
                    for sub in element:
                        if isinstance(sub, LTChar):
                            chars.append(sub)
        text = "".join(c.get_text() for c in chars)
        at = text.find("INVOICE")
        assert at != -1, f"INVOICE chars not found in {text!r}"
        first = chars[at]
        last = chars[at + len("INVOICE") - 1]
        # Requested rect [40, 240, 140, 262]: run starts at its left edge,
        # sits in its vertical band, ends inside its right edge.
        assert 38 <= first.x0 <= 45
        assert 238 <= first.y0 <= 245 and first.y1 <= 265
        assert last.x1 <= 142

    def test_hardlink_alias_output_takes_the_safe_branch(self, tmp_dir):
        """output that IS the input under another name (hardlink — the
        unresolvable-alias stand-in for UNC-vs-mapped-letter spellings) must
        take the temp+rename branch, never a direct save into the file
        pikepdf has open. os.path.samefile (volume serial + file index)
        catches what resolve()-string equality cannot (batch-mirror review;
        subst aliases were verified live to resolve, hardlinks never do)."""
        src = os.path.join(tmp_dir, "scan.pdf")
        alias = os.path.join(tmp_dir, "alias.pdf")
        _scanlike_pdf(src)
        os.link(src, alias)  # NTFS hardlink, no admin needed
        assert os.path.samefile(src, alias)

        r = apply_ocr_layer(src, alias, [{"page": 1, "words": WORDS}])
        assert r["pages_applied"] == 1
        # The alias path now holds the searchable rewrite (rename broke the
        # link — expected); the ORIGINAL inode was never written into: the
        # source spelling still opens clean. No corruption on either path.
        assert "INVOICE" in extract_text(alias)["text"]
        with pikepdf.open(src) as pdf:  # would raise if the write had raced
            assert len(pdf.pages) == 1

    def test_readonly_existing_output_is_overwritten(self, tmp_dir):
        """Re-running the mirror over an existing read-only output must
        refresh it (the dialog promises overwrite; fs-level copies propagate
        a read-only SOURCE's attribute onto run 1's mirror file)."""
        import stat as stat_mod

        src = os.path.join(tmp_dir, "scan.pdf")
        out = os.path.join(tmp_dir, "ocr.pdf")
        _scanlike_pdf(src)
        _scanlike_pdf(out)  # pre-existing mirror file...
        os.chmod(out, stat_mod.S_IREAD)  # ...marked read-only

        r = apply_ocr_layer(src, out, [{"page": 1, "words": WORDS}])
        assert r["pages_applied"] == 1
        assert "INVOICE" in extract_text(out)["text"]

    def test_verbatim_prefixed_long_path_output(self, tmp_dir):
        r"""A \\?\-prefixed, >260-char output path — what dunce emits when a
        resolved path exceeds legacy limits — must reach pikepdf intact (the
        batch walk's deep-tree regime). Probes the reviewer-flagged unknown;
        a red here means the ENGINE needs long-path handling, not that the
        test is wrong."""
        prefix = "\\\\?\\"
        src = os.path.join(tmp_dir, "scan.pdf")
        _scanlike_pdf(src)
        # os.makedirs cannot recurse a verbatim path (it walks parents up to
        # the bare prefix and dies on it) — create each level explicitly.
        level = tmp_dir
        for _ in range(12):
            level = os.path.join(level, "subdir-" + "x" * 20)
            os.mkdir(prefix + level)
        out = prefix + os.path.join(level, "ocr-long.pdf")
        assert len(out) > 260

        r = apply_ocr_layer(src, out, [{"page": 1, "words": WORDS}])
        assert r["pages_applied"] == 1
        assert "INVOICE" in extract_text(out)["text"]
