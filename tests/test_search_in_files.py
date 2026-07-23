"""§ I.5 P4 part 2 — cross-file text search over PDFs on disk."""

import os

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine.search_in_files import search_in_files


def _text_pdf(path: str, pages_text: list[str]) -> None:
    """A PDF with one page per string, each drawing that string as extractable
    text (Helvetica/WinAnsi), built with pikepdf's low-level API."""
    doc = pikepdf.new()
    for text in pages_text:
        page = doc.add_blank_page(page_size=(400, 400))
        font = doc.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
                       Encoding=Name.WinAnsiEncoding))
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        page.Contents = doc.make_stream(
            b"BT /F1 12 Tf 50 300 Td (" + escaped.encode("latin-1") + b") Tj ET")
    doc.save(path)
    doc.close()


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


class TestSearchInFiles:
    def test_literal_match_across_files_and_pages(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        _text_pdf(a, ["Invoice total due", "nothing here", "another Invoice line"])
        _text_pdf(b, ["unrelated content"])
        r = search_in_files([a, b], "invoice")
        assert r["error"] is None
        assert r["files_searched"] == 2
        # Two matching pages in a.pdf (pages 1 and 3), none in b.pdf.
        matched = {(h["path"], h["page"]) for h in r["hits"]}
        assert matched == {(a, 1), (a, 3)}
        assert all(h["count"] >= 1 for h in r["hits"])
        assert any("Invoice" in h["snippet"] for h in r["hits"])

    def test_case_sensitive(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        _text_pdf(a, ["Cat cats CAT concatenate"])
        assert search_in_files([a], "cat")["hits"][0]["count"] == 4  # case-insensitive
        cs = search_in_files([a], "Cat", case_sensitive=True)
        assert cs["hits"][0]["count"] == 1  # only "Cat"

    def test_whole_word(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        _text_pdf(a, ["Cat cats CAT concatenate"])
        ww = search_in_files([a], "cat", whole_word=True)
        assert ww["hits"][0]["count"] == 2  # "Cat", "CAT" only

    def test_regex(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        _text_pdf(a, ["Order 2024 shipped", "Order abcd shipped"])
        r = search_in_files([a], r"\d{4}", regex=True)
        assert {(h["page"]) for h in r["hits"]} == {1}

    def test_invalid_regex_reports_error(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        _text_pdf(a, ["anything"])
        r = search_in_files([a], "inv(", regex=True)
        assert r["error"]
        assert r["hits"] == []

    def test_empty_query_no_hits_no_error(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        _text_pdf(a, ["something"])
        r = search_in_files([a], "   ")
        assert r["hits"] == [] and r["error"] is None

    def test_zero_width_regex_does_not_inflate_or_hang(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        _text_pdf(a, ["aa bb aaa"])
        r = search_in_files([a], "a*", regex=True)
        # Two non-empty runs of "a" (zero-width empties skipped).
        assert r["hits"][0]["count"] == 2

    def test_unreadable_file_reported_not_fatal(self, tmp_dir):
        good = os.path.join(tmp_dir, "good.pdf")
        bad = os.path.join(tmp_dir, "bad.pdf")
        _text_pdf(good, ["match me"])
        with open(bad, "wb") as f:
            f.write(b"%PDF-1.7\nnot a real pdf")
        r = search_in_files([bad, good], "match")
        assert any(h["path"] == good for h in r["hits"])  # good file still searched
        assert any(e["path"] == bad for e in r["errors"])  # bad file reported

    def test_truncation_reported(self, tmp_dir):
        paths = []
        for i in range(3):
            p = os.path.join(tmp_dir, f"f{i}.pdf")
            _text_pdf(p, ["hit"])
            paths.append(p)
        r = search_in_files(paths, "hit", max_files=2)
        assert r["truncated"] is True
        assert r["files_searched"] == 2
        assert r["files_total"] == 3

    def test_max_hits_per_file(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        _text_pdf(a, ["hit"] * 5)
        r = search_in_files([a], "hit", max_hits_per_file=2)
        assert len([h for h in r["hits"] if h["path"] == a]) == 2
