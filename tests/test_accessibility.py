"""§ I.6 — accessibility checker."""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.accessibility import check_accessibility


def _text_page(doc):
    page = doc.add_blank_page(page_size=(300, 300))
    font = doc.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1,
                                        BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding))
    page.Resources = Dictionary(Font=Dictionary(F1=font))
    page.Contents = doc.make_stream(b"BT /F1 12 Tf 50 200 Td (Readable text) Tj ET")
    return page


def _inaccessible_pdf(path: str) -> None:
    doc = pikepdf.new()
    _text_page(doc)  # has text, but nothing else
    doc.save(path)
    doc.close()


def _accessible_pdf(path: str) -> None:
    doc = pikepdf.new()
    _text_page(doc)
    doc.Root.Lang = String("en-US")
    doc.Root.MarkInfo = Dictionary(Marked=True)
    doc.Root.StructTreeRoot = doc.make_indirect(Dictionary(Type=Name.StructTreeRoot))
    doc.Root.ViewerPreferences = Dictionary(DisplayDocTitle=True)
    with doc.open_metadata() as m:
        m["dc:title"] = "An Accessible Document"
    doc.save(path)
    doc.close()


def _scanned_pdf(path: str) -> None:
    doc = pikepdf.new()
    doc.add_blank_page(page_size=(300, 300))  # no text content
    doc.save(path)
    doc.close()


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


def _by_id(res):
    return {c["id"]: c["status"] for c in res["checks"]}


class TestAccessibilityChecker:
    def test_inaccessible_document_fails_core_checks(self, tmp_dir):
        src = os.path.join(tmp_dir, "bad.pdf")
        _inaccessible_pdf(src)
        s = _by_id(check_accessibility(src))
        assert s["tagged"] == "fail"
        assert s["lang"] == "fail"
        assert s["title"] == "fail"
        assert s["display_title"] == "warn"
        assert s["text"] == "pass"  # it does have text

    def test_accessible_document_passes(self, tmp_dir):
        src = os.path.join(tmp_dir, "good.pdf")
        _accessible_pdf(src)
        res = check_accessibility(src)
        s = _by_id(res)
        assert s["tagged"] == "pass"
        assert s["lang"] == "pass"
        assert s["title"] == "pass"
        assert s["display_title"] == "pass"
        assert s["text"] == "pass"
        assert res["failed"] == 0

    def test_scanned_document_flags_no_text(self, tmp_dir):
        src = os.path.join(tmp_dir, "scan.pdf")
        _scanned_pdf(src)
        s = _by_id(check_accessibility(src))
        assert s["text"] == "fail"

    def test_lang_detail_included(self, tmp_dir):
        src = os.path.join(tmp_dir, "good.pdf")
        _accessible_pdf(src)
        lang = next(c for c in check_accessibility(src)["checks"] if c["id"] == "lang")
        assert "en-US" in lang["detail"]

    def test_bookmark_check_only_for_long_docs(self, tmp_dir):
        short = os.path.join(tmp_dir, "short.pdf")
        _inaccessible_pdf(short)
        assert "bookmarks" not in _by_id(check_accessibility(short))

        longp = os.path.join(tmp_dir, "long.pdf")
        doc = pikepdf.new()
        for _ in range(12):
            _text_page(doc)
        doc.save(longp)
        doc.close()
        s = _by_id(check_accessibility(longp))
        assert s["bookmarks"] == "warn"  # 12 pages, no outline

    def test_summary_counts(self, tmp_dir):
        src = os.path.join(tmp_dir, "good.pdf")
        _accessible_pdf(src)
        res = check_accessibility(src)
        assert res["passed"] + res["failed"] + res["warnings"] == res["total"]
