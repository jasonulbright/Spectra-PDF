"""Two loads of the same bytes read a page in one order.

pdfminer groups a page's text boxes pairwise, the closest pair first, and
breaks a tie between two equally distant pairs by `id()`: a memory address.
A second load of the same file gets other addresses, in another order, so a
file and its exact copy extract in two different reading orders and Compare
Text reports lines added and removed between them.

`_addresses` fixes the order the addresses come out in, for every module that
lays text out, so each test forces two loads to see two different orders.
"""

from __future__ import annotations

import builtins
import contextlib
import os
import shutil

import pikepdf
import pytest
from pdfminer import layout as pdfminer_layout
from pdfminer.layout import LTTextBox
from pikepdf import Array, Dictionary, Name

from engine import compare, extract_text, text_export

# Four words of one width on a 2 x 2 grid. Every glyph is 8 units wide and 16
# high at 16 pt (/Widths 500, /Descent 0), so every coordinate is exact: a row
# pair and a column pair are both 384 square units apart, and nothing else is
# as close. Which pair merges first decides whether the page reads row by row
# or column by column.
WORDS = {"one": (100, 600), "two": (148, 600), "six": (100, 568), "ten": (148, 568)}
ROWS = ("one", "two", "six", "ten")
COLUMNS = ("one", "six", "two", "ten")


def _grid_pdf(path: str, drawn: tuple[str, ...]) -> str:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    descriptor = Dictionary(
        Type=Name.FontDescriptor, FontName=Name("/GridFace"), Flags=32,
        FontBBox=Array([0, 0, 500, 1000]), ItalicAngle=0, Ascent=1000,
        Descent=0, CapHeight=1000, StemV=80)
    font = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/GridFace"),
        FirstChar=32, LastChar=126, Widths=Array([500] * 95),
        Encoding=Name.WinAnsiEncoding, FontDescriptor=pdf.make_indirect(descriptor)))
    page = pdf.pages[0]
    page.Resources = Dictionary(Font=Dictionary(F1=font))
    shows = [f"BT /F1 16 Tf {WORDS[w][0]} {WORDS[w][1]} Td ({w}) Tj ET" for w in drawn]
    page.Contents = pdf.make_stream("\n".join(shows).encode("ascii"))
    pdf.save(path)
    pdf.close()
    return path


def _copy(path: str) -> str:
    twin = path.replace(".pdf", "-copy.pdf")
    shutil.copyfile(path, twin)
    return twin


@contextlib.contextmanager
def _addresses(order: tuple[str, ...]):
    """Every text box reports the address its word's place in `order` gives."""
    real = builtins.id

    def address(obj) -> int:
        if isinstance(obj, LTTextBox):
            word = obj.get_text().strip()
            if word in order:
                return order.index(word)
        return real(obj)

    modules = (pdfminer_layout, extract_text)
    for module in modules:
        module.id = address
    try:
        yield
    finally:
        for module in modules:
            del module.id


def _words(text: str) -> list[str]:
    return text.split()


def _pdfminer_text(path: str) -> str:
    return extract_text.pdfminer_text(path)


def _layout_text(path: str) -> str:
    return "".join(extract_text.layout_text(page) for page in extract_text.pdfminer_pages(path))


def _export_text(path: str) -> str:
    return "".join(text for _page, text in text_export.page_texts(path, [1], "reading"))


READERS = [
    pytest.param(_pdfminer_text, id="extract-text"),
    pytest.param(_layout_text, id="page-layout"),
    pytest.param(_export_text, id="text-export"),
]


class TestTwoLoadsReadOneOrder:
    @pytest.mark.parametrize("read", READERS)
    @pytest.mark.parametrize("drawn", [ROWS, COLUMNS], ids=["drawn-by-row", "drawn-by-column"])
    def test_the_address_order_does_not_change_the_text(self, tmp_dir, read, drawn):
        first = _grid_pdf(os.path.join(tmp_dir, "grid.pdf"), drawn)
        second = _copy(first)
        with _addresses(ROWS):
            by_rows = read(first)
        with _addresses(COLUMNS):
            by_columns = read(second)
        assert sorted(_words(by_rows)) == sorted(WORDS)
        assert _words(by_rows) == _words(by_columns)

    @pytest.mark.parametrize(
        "drawn, read",
        [
            pytest.param(ROWS, ROWS, id="square-drawn-by-row"),
            pytest.param(COLUMNS, COLUMNS, id="square-drawn-by-column"),
            # Three words in an L: `one`-`two` is a row pair and `one`-`six` a
            # column pair, equally close. When the column pair merges first,
            # pdfminer's left-to-right, top-to-bottom order reads the lone
            # `two` before the column it sits beside.
            pytest.param(("one", "two", "six"), ("one", "two", "six"), id="l-row-pair-drawn-first"),
            pytest.param(("one", "six", "two"), ("two", "one", "six"), id="l-column-pair-drawn-first"),
        ],
    )
    def test_of_two_equally_close_pairs_the_one_drawn_first_merges_first(self, tmp_dir, drawn, read):
        path = _grid_pdf(os.path.join(tmp_dir, "grid.pdf"), drawn)
        for order in (ROWS, COLUMNS):
            with _addresses(order):
                assert _words(extract_text.pdfminer_text(path)) == list(read)


class TestCompareTextOfACopy:
    def test_a_file_and_its_exact_copy_are_identical(self, tmp_dir, monkeypatch):
        first = _grid_pdf(os.path.join(tmp_dir, "grid.pdf"), ROWS)
        second = _copy(first)
        real = compare._extract_lines

        def extract(file: str):
            with _addresses(ROWS if file == first else COLUMNS):
                return real(file)

        monkeypatch.setattr(compare, "_extract_lines", extract)
        summary = compare.compare_text(first, second)["summary"]
        assert summary["lines_added"] == 0
        assert summary["lines_removed"] == 0
        assert summary["identical"] is True
