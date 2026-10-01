"""Reading order across text orientations, through every engine reader.

The shared cases live in tests/fixtures/reading-order-corpus.json, which
tests/reading-order-corpus.test.ts holds the renderer to as well. Most pages
there draw their text in an order reading does not follow, so a reader that
falls back to stream order fails them.
"""

import json
from decimal import Decimal
from pathlib import Path

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

from engine import reading_order
from engine.extract_text import document_pages, pdfminer_text
from engine.form_detect import _display_rect_to_pdf, _page_segments
from engine.ocr_layer import apply_ocr_layer
from engine.read_aloud import read_aloud_page
from engine.search_regions import _collect_runs, _page_text, search_text_regions
from test_pdf_fonts import _tounicode_stream

CORPUS = json.loads((Path(__file__).parent / "fixtures" / "reading-order-corpus.json").read_text(encoding="utf-8"))
CJK = {int(code): text for code, text in CORPUS["vertical_font"].items()}


def _helvetica(pdf):
    return pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
    )


def _vertical_font(pdf):
    widths, advances = [], []
    for cid in sorted(CJK):
        widths += [cid, Array([1000])]
        advances += [cid, Array([-1000, 500, 880])]
    descendant = Dictionary(
        Type=Name.Font,
        Subtype=Name("/CIDFontType2"),
        BaseFont=Name("/Probe"),
        CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
        DW=1000,
        W=Array(widths),
        W2=Array(advances),
        DW2=Array([880, -1000]),
    )
    return pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name("/Type0"),
            BaseFont=Name("/Probe"),
            Encoding=Name("/Identity-V"),
            DescendantFonts=Array([pdf.make_indirect(descendant)]),
            ToUnicode=_tounicode_stream(pdf, CJK),
        )
    )


def _pdf(path, content: str, rotate=None) -> str:
    """A page with /F1 Helvetica and /FV the corpus's vertical font. A
    `rotate` of None writes no /Rotate."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page.obj.Resources = Dictionary(Font=Dictionary(F1=_helvetica(pdf), FV=_vertical_font(pdf)))
    page.obj.Contents = pdf.make_stream(content.encode("latin-1"))
    if rotate is not None:
        page.obj.Rotate = rotate
    pdf.save(str(path))
    pdf.close()
    return str(path)


def _draw(items: list) -> str:
    content = ""
    for item in items:
        if "cids" in item:
            x, y = item["at"]
            codes = "".join(f"{cid:04x}" for cid in item["cids"])
            content += f"BT /FV 20 Tf {x} {y} Td <{codes}> Tj ET\n"
        else:
            a, b, c, d, e, f = item["tm"]
            content += f"BT /F1 12 Tf {a} {b} {c} {d} {e} {f} Tm ({item['text']}) Tj ET\n"
    return content


def _page(name: str) -> dict:
    return next(case for case in CORPUS["pages"] if case["name"] == name)


def _case_pdf(path, name: str) -> str:
    case = _page(name)
    return _pdf(path, _draw(case["draw"]), case["rotate"])


def _lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


def _search_text(path: str) -> str:
    with pikepdf.open(path) as pdf:
        runs, _listing = _collect_runs(pdf, pdf.pages[0])
        return _page_text(runs)[0]


def _segments(path: str) -> list[str]:
    with pikepdf.open(path) as pdf:
        return [segment.text for segment in _page_segments(pdf, pdf.pages[0])]


def _aloud(path: str) -> list[str]:
    return [block["text"] for block in read_aloud_page(path, 1)["blocks"]]


READERS = {
    "layout": (lambda path: _lines(pdfminer_text(path)), list),
    "search": (_search_text, " ".join),
    "segments": (_segments, list),
    "aloud": (_aloud, list),
}

PAGE_READS = [(case, reader) for case in CORPUS["pages"] for reader in case["readers"] if reader in READERS]


# ── the shared table ──────────────────────────────────────────────────────


class TestCorpus:
    @pytest.mark.parametrize(("value", "degrees"), CORPUS["rotations"])
    def test_a_rotation_reads_as_the_renderer_shows_it(self, tmp_path, value, degrees):
        path = _pdf(tmp_path / "rotate.pdf", "", value)
        with pikepdf.open(path) as pdf:
            assert reading_order.page_rotation(pdf.pages[0]) == degrees
        with open(path, "rb") as handle:
            assert [page.rotate for page in document_pages(handle, path)] == [degrees]

    @pytest.mark.parametrize("row", CORPUS["orientations"])
    def test_the_pen_advance_is_the_orientation(self, row):
        angle, reflected = reading_order.orientation(*row["matrix"], vertical=row["vertical"], rotate=row["rotate"])
        assert (angle, reflected) == (pytest.approx(row["angle"], abs=1e-9), row["reflected"])

    @pytest.mark.parametrize("row", CORPUS["partitions"])
    def test_items_group_into_parts_in_reading_order(self, row):
        parts = reading_order.partition(
            row["items"],
            lambda item: (float(item[1]), bool(item[2]) if len(item) > 2 else False),
            lambda item: len(item[0]),
        )
        assert [(key[0], key[1], [item[0] for item in members]) for key, members in parts] == [
            (pytest.approx(angle, abs=1e-6), reflected, texts) for angle, reflected, texts in row["parts"]
        ]

    @pytest.mark.parametrize(
        ("case", "reader"), PAGE_READS, ids=[f"{case['name']} [{reader}]" for case, reader in PAGE_READS]
    )
    def test_the_page_reads_in_the_corpus_order(self, tmp_path, case, reader):
        read, expected = READERS[reader]
        path = _pdf(tmp_path / "page.pdf", _draw(case["draw"]), case["rotate"])
        assert read(path) == expected(case["lines"])


# ── the shared rule, engine side ─────────────────────────────────────────


class TestFrames:
    def test_page_rotation_turns_the_user_frame_back(self):
        assert reading_order.user_frame((270.0, False), 90) == (0.0, False)

    def test_page_rotation_is_inherited(self):
        page = Dictionary(Type=Name.Page, Parent=Dictionary(Type=Name.Pages, Rotate=-90))
        assert reading_order.page_rotation(page) == 270

    def test_an_invalid_page_rotation_does_not_fall_through_to_the_parent(self):
        page = Dictionary(Type=Name.Page, Rotate=135, Parent=Dictionary(Type=Name.Pages, Rotate=90))
        assert reading_order.page_rotation(page) == 0

    @pytest.mark.parametrize(
        "value", [10**400 + 1, float("inf"), float("nan"), Decimal("Infinity"), Decimal("NaN"), Decimal("9E+40"), True, Name.R]
    )
    def test_a_rotation_no_viewer_can_apply_reads_as_none(self, value):
        assert reading_order.rotation_degrees(value) == 0

    @pytest.mark.parametrize("frame", [(0.0, False), (90.0, False), (33.5, False), (270.0, True)])
    def test_frame_points_round_trip(self, frame):
        u, v = reading_order.to_frame_point(123.25, -45.5, frame)
        x, y = reading_order.from_frame_point(u, v, frame)
        assert (x, y) == pytest.approx((123.25, -45.5))


# ── run walk: redaction search, form detection, document redaction ───────


class TestRunWalk:
    def test_a_hit_spans_a_rotated_line_break(self, tmp_path):
        path = _case_pdf(tmp_path / "wrap.pdf", "lines turned 90 degrees read in their own order")
        hits = search_text_regions(file=path, query="here Second")["hits"]
        assert len(hits) == 1
        assert len(hits[0]["rects"]) == 2

    def test_a_label_does_not_split_a_body_phrase(self, tmp_path):
        path = _case_pdf(tmp_path / "phrase.pdf", "a side label reads after the body")
        assert len(search_text_regions(file=path, query="two Body line three")["hits"]) == 1

    def test_a_scaled_text_matrix_keeps_a_line_whole(self, tmp_path):
        # A unit font size with the size in the matrix: the line window is an
        # em of the matrix, so a word set 0.5 pt higher still continues the
        # line instead of reading first.
        content = (
            "BT /F1 1 Tf 12 0 0 12 72 700 Tm (Alpha) Tj ET\n"
            "BT /F1 1 Tf 12 0 0 12 112 700.5 Tm (Beta) Tj ET\n"
            "BT /F1 1 Tf 12 0 0 12 72 680 Tm (Gamma) Tj ET\n"
        )
        path = _pdf(tmp_path / "scaled.pdf", content)
        assert _search_text(path) == "Alpha Beta Gamma"


# ── read aloud ───────────────────────────────────────────────────────────


class TestReadAloud:
    def test_a_column_that_opens_with_tate_chu_yoko_reads_as_a_column(self, tmp_path):
        # "26" set upright in a horizontal font heads the left column; the
        # column's three vertical characters outweigh it, so the block is a
        # column and reads after the column to its right.
        content = (
            "BT /F1 10 Tf 294.44 684 Td (26) Tj ET\n"
            "BT /FV 20 Tf 300 680 Td <000100020003> Tj ET\n"
            "BT /FV 20 Tf 400 700 Td <000400050006> Tj ET\n"
        )
        path = _pdf(tmp_path / "tcy.pdf", content)
        assert _aloud(path) == ["右見出", "26上下左"]


# ── OCR text layer ───────────────────────────────────────────────────────


def _display_words(rotate: int) -> list[dict]:
    """Two displayed lines of two words, as recognition reports them: tight
    boxes, a 4 pt word gap, in recognition order, mapped into user space the
    way every OCR caller maps them."""
    from engine.pdf_metrics import text_width_em

    width, height = (792.0, 612.0) if rotate % 180 else (612.0, 792.0)
    placed = []
    for top, words in ((100.0, ("Alpha", "Beta")), (120.0, ("Gamma", "Delta"))):
        left = 72.0
        for text in words:
            advance = 12.0 * text_width_em(text)
            placed.append((text, left / width, top / height, advance / width, 12.0 / height))
            left += advance + 4.0
    box = (0.0, 0.0, 612.0, 792.0)
    return [
        {"text": text, "rect": list(_display_rect_to_pdf((u, v, w, h), box, rotate))}
        for text, u, v, w, h in placed
    ]


class TestOcrLayer:
    @pytest.mark.parametrize(("rotate", "shown"), [(0, 0), (90, 90), (180, 180), (270, 270), (135, 0)])
    def test_words_read_along_the_displayed_lines(self, tmp_path, rotate, shown):
        source = _pdf(tmp_path / f"scan{rotate}.pdf", "", rotate)
        out = str(tmp_path / f"ocr{rotate}.pdf")
        apply_ocr_layer(source, out, [{"page": 1, "words": _display_words(shown)}])
        assert _lines(pdfminer_text(out)) == ["Alpha Beta", "Gamma Delta"]

    def test_an_unrotated_page_keeps_the_upright_matrix(self, tmp_path):
        source = _pdf(tmp_path / "scan.pdf", "")
        out = str(tmp_path / "ocr.pdf")
        apply_ocr_layer(source, out, [{"page": 1, "words": [{"text": "Word", "rect": [72, 700, 132, 712]}]}])
        with pikepdf.open(out) as pdf:
            layer = pdf.pages[0].obj.Resources.XObject["/SpectraPDFOCR"].read_bytes()
        assert b"1 0 0 1 72 702.4 Tm" in layer
