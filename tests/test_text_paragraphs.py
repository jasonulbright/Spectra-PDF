"""Tests for paragraph grouping + reflow (Phase 7.5).

Fixtures are hand-built content streams (the test_text_runs discipline);
every heuristic threshold in text_paragraphs.py is pinned by a case here —
the tests own the numbers, the design doc owns the intent.

The rewrite half's core guarantee is PROPERTY-TESTED: after any paragraph
edit, every kept (non-member) show op renders at an identical composed
matrix with identical text state (±1e-6) — `_assert_non_members_unmoved`
walks both files with the real walker and compares run by run.
"""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

from engine.content_walk import IDENTITY, color_equal
from engine.extract_text import extract_text
from engine.redact import _resolve_resources
from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text
from engine.text_runs import _FontCache, _walk_runs, list_text_runs

FALLBACK_FONT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "resources",
    "fonts",
    "LiberationSans-Regular.ttf",
)


def _detail_runs(path: str, page: int = 1) -> list[dict]:
    with pikepdf.open(path) as pdf:
        p = pdf.pages[page - 1]
        resources = _resolve_resources(p)
        runs: list[dict] = []
        det: list[dict] = []
        _walk_runs(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            IDENTITY,
            0,
            None,
            runs,
            False,
            _FontCache(),
            detail=det,
        )
        return [
            {
                "text": r["text"],
                "combined": d["combined"],
                "style": d["style"],
                "stream": d["stream"],
            }
            for r, d in zip(runs, det)
        ]


def _style_close(a: dict, b: dict) -> bool:
    for key in a:
        va, vb = a[key], b[key]
        if key in ("fill_color", "stroke_color"):
            # Same semantic identity the engine uses: untouched default ≡
            # explicitly restored device-gray black.
            if not color_equal(_color_repr(va), _color_repr(vb), key == "stroke_color"):
                return False
        elif isinstance(va, float) or isinstance(vb, float):
            if abs(float(va) - float(vb)) > 1e-6:
                return False
        elif va != vb:
            return False
    return True


def _color_repr(color) -> tuple:
    def op_repr(op):
        if op is None:
            return None
        operator, operands = op
        return (operator, tuple(round(v, 6) if isinstance(v, float) else v for v in operands))

    return (op_repr(color[0]), op_repr(color[1]))


def _assert_non_members_unmoved(src: str, out: str, member_indexes: list[int]) -> None:
    """THE resync property: every kept show renders identically."""
    before = _detail_runs(src)
    member_set = set(member_indexes)
    keep = [r for i, r in enumerate(before) if i not in member_set]
    after = _detail_runs(out)
    ai = 0
    for want in keep:
        while ai < len(after) and after[ai]["text"] != want["text"]:
            ai += 1
        assert ai < len(after), f"kept run {want['text']!r} missing from output"
        got = after[ai]
        ai += 1
        for a, b in zip(want["combined"], got["combined"]):
            assert abs(a - b) <= 1e-6, (
                f"kept run {want['text']!r} moved: {want['combined']} -> {got['combined']}"
            )
        assert _style_close(want["style"], got["style"]), (
            f"kept run {want['text']!r} changed state:\n{want['style']}\n{got['style']}"
        )


def _apply(src: str, out: str, para: dict, new_text: str, spans=None, **kw):
    """Apply with the fingerprint taken from a listing — the way the
    renderer calls it. Default spans: everything styled by the first
    member run."""
    if spans is None:
        spans = [{"start": 0, "end": len(new_text), "run": para["runs"][0]}] if new_text else []
    return replace_paragraph_text(
        src,
        out,
        1,
        para["index"],
        new_text,
        spans,
        para["runs"],
        para["text"],
        **kw,
    )


def _helv(pdf) -> pikepdf.Object:
    return pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type1"),
            BaseFont=Name("/Helvetica"),
            Encoding=Name("/WinAnsiEncoding"),
        )
    )


def _type3(pdf) -> pikepdf.Object:
    return pdf.make_indirect(Dictionary(Type=Name("/Font"), Subtype=Name("/Type3")))


def _hebrew(pdf) -> pikepdf.Object:
    """Simple font whose ToUnicode maps 'A' (0x41) to א — the minimal
    strong-RTL producer."""
    tounicode = (
        b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
        b"1 begincodespacerange <00> <ff> endcodespacerange\n"
        b"1 beginbfchar <41> <05D0> endbfchar\n"
        b"endcmap end end\n"
    )
    return pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/TrueType"),
            BaseFont=Name("/Helvetica"),
            Encoding=Name("/WinAnsiEncoding"),
            ToUnicode=pdf.make_stream(tounicode),
        )
    )


def _page(pdf, content: bytes, fonts: dict, xobjects: dict | None = None):
    page = pdf.add_blank_page(page_size=(612, 792))
    res = Dictionary(Font=Dictionary(**{k.lstrip("/"): v for k, v in fonts.items()}))
    if xobjects:
        res["/XObject"] = Dictionary(**{k.lstrip("/"): v for k, v in xobjects.items()})
    page.obj["/Resources"] = res
    page.Contents = pdf.make_stream(content)
    return page


def _build(tmp_dir, content: bytes, fonts=None, xobjects=None, name="p.pdf") -> str:
    src = os.path.join(tmp_dir, name)
    pdf = pikepdf.new()
    _page(pdf, content, fonts if fonts is not None else {"/F1": _helv(pdf)}, xobjects)
    pdf.save(src)
    pdf.close()
    return src


def _paras(src):
    return list_text_paragraphs(src, 1)["paragraphs"]


class TestGrouping:
    def test_multiline_left_paragraph_joins_with_spaces(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Alpha) Tj 40 0 Td (beta) Tj "
            b"-40 -14 Td (gamma) Tj 46 0 Td (delta) Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 1
        p = paras[0]
        assert p["text"] == "Alpha beta gamma delta"
        assert p["line_count"] == 2
        assert p["alignment"] == "left"
        assert p["editable"] is True
        assert p["runs"] == [0, 1, 2, 3]
        # Spans partition the text contiguously.
        spans = p["spans"]
        assert spans[0]["start"] == 0
        assert spans[-1]["end"] == len(p["text"])
        for a, b in zip(spans, spans[1:]):
            assert a["end"] == b["start"]

    def test_wide_vertical_gap_splits_paragraphs(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (One) Tj 0 -60 Td (Two) Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 2
        assert [p["text"] for p in paras] == ["One", "Two"]

    def test_columns_split_at_large_horizontal_gap(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Left) Tj 200 0 Td (Right) Tj "
            b"-200 -14 Td (col) Tj 200 0 Td (col) Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 2
        texts = sorted(p["text"] for p in paras)
        assert texts == ["Left col", "Right col"]

    def test_run_listing_matches_list_text_runs(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Alpha) Tj 40 0 Td (beta) Tj ET",
        )
        combined = list_text_paragraphs(src, 1)
        assert combined["runs"] == list_text_runs(src, 1)["runs"]

    def test_tj_word_gap_synthesizes_space(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td [(Hello) -600 (World)] TJ ET",
        )
        paras = _paras(src)
        assert len(paras) == 1
        assert paras[0]["text"] == "Hello World"

    def test_tj_kern_does_not_synthesize_space(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td [(He) 40 (llo)] TJ ET",
        )
        paras = _paras(src)
        assert paras[0]["text"] == "Hello"

    def test_hyphen_line_join_adds_no_space(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (well-) Tj 0 -14 Td (known) Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 1
        assert paras[0]["text"] == "well-known"

    def test_bullet_lines_break_paragraphs(self, tmp_dir):
        # \x95 is the bullet in WinAnsi.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (\x95 first item) Tj "
            b"0 -14 Td (\x95 second item) Tj 0 -14 Td (\x95 third item) Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 3

    def test_numbered_lines_break_paragraphs(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (1. first) Tj 0 -14 Td (2. second) Tj ET",
        )
        assert len(_paras(src)) == 2

    def test_heading_size_jump_breaks(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 18 Tf 72 700 Td (Title) Tj /F1 12 Tf 0 -20 Td (Body text) Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 2
        assert paras[0]["text"] == "Title"

    def test_superscript_attaches_to_line(self, tmp_dir):
        # Marker: 6pt, 5pt above baseline, tight after the word (Hello is
        # 27.34pt wide; 27.8 leaves a 0.46pt gap — below the space
        # threshold, so no synthetic space).
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj /F1 6 Tf 27.8 5 Td (1) Tj "
            b"/F1 12 Tf -27.8 -19 Td (world text here) Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 1
        p = paras[0]
        assert p["line_count"] == 2
        assert p["text"].startswith("Hello1")

    def test_rotated_text_never_groups(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 0 1 -1 0 100 100 Tm (Rotated) Tj ET",
        )
        listing = list_text_paragraphs(src, 1)
        assert listing["paragraphs"] == []
        assert len(listing["runs"]) == 1

    def test_streams_never_share_a_paragraph(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        pdf = pikepdf.new()
        helv = _helv(pdf)
        form = pdf.make_stream(b"BT /F1 12 Tf 0 0 Td (Formy) Tj ET")
        form["/Type"] = Name("/XObject")
        form["/Subtype"] = Name("/Form")
        form["/BBox"] = pikepdf.Array([0, 0, 200, 20])
        form["/Matrix"] = pikepdf.Array([1, 0, 0, 1, 120, 700])
        form["/Resources"] = Dictionary(Font=Dictionary(F1=helv))
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (Pagey) Tj ET /Fm1 Do",
            {"/F1": helv},
            {"/Fm1": form},
        )
        pdf.save(src)
        pdf.close()
        paras = _paras(src)
        assert len(paras) == 2
        assert sorted(p["text"] for p in paras) == ["Formy", "Pagey"]

    def test_whitespace_only_cluster_offers_no_paragraph(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (   ) Tj ET")
        assert _paras(src) == []

    def test_space_run_between_words_does_not_block(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj ( ) Tj (world) Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 1
        assert paras[0]["editable"] is True
        assert paras[0]["text"] == "Hello world"

    def test_uneditable_member_refuses_with_reason(self, tmp_dir):
        src = os.path.join(tmp_dir, "t3.pdf")
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj /F3 12 Tf 40 0 Td (ab) Tj ET",
            {"/F1": _helv(pdf), "/F3": _type3(pdf)},
        )
        pdf.save(src)
        pdf.close()
        paras = _paras(src)
        assert len(paras) == 1
        assert paras[0]["editable"] is False
        assert "Type3" in paras[0]["reason"]

    def test_rtl_text_refuses_reflow(self, tmp_dir):
        src = os.path.join(tmp_dir, "rtl.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (A) Tj ET", {"/F1": _hebrew(pdf)})
        pdf.save(src)
        pdf.close()
        paras = _paras(src)
        assert len(paras) == 1
        assert paras[0]["editable"] is False
        assert "right-to-left" in paras[0]["reason"]


class TestReplaceParagraphText:
    def test_grow_rewraps_at_the_box_width(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Alpha beta gamma) Tj 0 -14 Td (delta words) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        assert para["text"] == "Alpha beta gamma delta words"
        new_text = "Alpha beta gamma delta words plus extra padding here"
        _apply(src, out, para, new_text)
        relisted = _paras(out)
        assert len(relisted) == 1
        assert relisted[0]["text"] == new_text
        assert relisted[0]["line_count"] > 2
        # Wrapped lines share the box: no line extends past the measured
        # right edge (+ tolerance), all start at the left edge.
        for run in list_text_paragraphs(out, 1)["runs"]:
            assert run["rect"][2] <= para["box"][2] + 1.0
        assert relisted[0]["box"][0] == pytest.approx(para["box"][0], abs=0.01)

    def test_shrink_reduces_lines(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Alpha beta gamma) Tj 0 -14 Td (delta words) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, "Tiny")
        relisted = _paras(out)
        assert relisted[0]["text"] == "Tiny"
        assert relisted[0]["line_count"] == 1

    def test_same_line_other_column_does_not_move(self, tmp_dir):
        # The box semantic: a column sibling at the same baseline stays
        # EXACTLY put (7.2's Δ-shift applies to single-run edits only).
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Left words) Tj 200 0 Td (Rightcol) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        left = next(p for p in paras if p["text"] == "Left words")
        _apply(src, out, left, "Left words considerably longer now")
        _assert_non_members_unmoved(src, out, left["runs"])
        assert "Rightcol" in extract_text(out)["text"]

    def test_following_paragraph_relative_chain_unmoved(self, tmp_dir):
        # Paragraph 2 is anchored by a RELATIVE Td chained after paragraph
        # 1's ops — the resync must absolute-ize it.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (First para text) Tj "
            b"0 -40 Td (Second para below) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        assert len(paras) == 2
        first = paras[0]
        _apply(src, out, first, "First para text grown by several words")
        _assert_non_members_unmoved(src, out, first["runs"])

    def test_deletion_removes_members_and_moves_nothing(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Doomed text) Tj 0 -40 Td (Survivor) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        doomed = paras[0]
        assert doomed["text"] == "Doomed text"
        _apply(src, out, doomed, "")
        text = extract_text(out)["text"]
        assert "Doomed" not in text
        assert "Survivor" in text
        _assert_non_members_unmoved(src, out, doomed["runs"])

    def test_multi_font_spans_survive(self, tmp_dir):
        src = os.path.join(tmp_dir, "mf.pdf")
        pdf = pikepdf.new()
        helv = _helv(pdf)
        bold = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type1"),
                BaseFont=Name("/Helvetica-Bold"),
                Encoding=Name("/WinAnsiEncoding"),
            )
        )
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (Hello ) Tj /F2 12 Tf (World) Tj ET",
            {"/F1": helv, "/F2": bold},
        )
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        assert para["text"] == "Hello World"
        # Renderer-shaped spans: the inserted word takes the FIRST span's
        # style (caret inheritance); World keeps bold.
        spans = [
            {"start": 0, "end": 12, "run": para["spans"][0]["run"]},
            {"start": 12, "end": 17, "run": para["spans"][-1]["run"]},
        ]
        _apply(src, out, para, "Hello Cruel World", spans=spans)
        runs = list_text_runs(out, 1)["runs"]
        by_text = {r["text"]: r for r in runs}
        assert "Hello Cruel " in by_text and by_text["Hello Cruel "]["font_name"] == "/F1"
        assert "World" in by_text and by_text["World"]["font_name"] == "/F2"

    def test_color_spans_survive(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td 1 0 0 rg (red) Tj 30 0 Td 0 0 0 rg (black) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        spans = [
            {"start": 0, "end": 4, "run": para["spans"][0]["run"]},
            {"start": 4, "end": 9, "run": para["spans"][-1]["run"]},
        ]
        _apply(src, out, para, "red black", spans=spans)
        after = _detail_runs(out)
        by_text = {r["text"]: r for r in after}
        red = next(r for t, r in by_text.items() if "red" in t)
        black = next(r for t, r in by_text.items() if "black" in t)
        assert _color_repr(red["style"]["fill_color"]) == ((None), ("rg", (1.0, 0.0, 0.0))) or _color_repr(
            red["style"]["fill_color"]
        ) == (None, ("rg", (1.0, 0.0, 0.0)))
        assert _color_repr(black["style"]["fill_color"])[1] == ("rg", (0.0, 0.0, 0.0))

    def test_invisible_ocr_text_stays_invisible(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 3 Tr 72 700 Td (ghost words here) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, "ghost words edited")
        after = _detail_runs(out)
        ghost = next(r for r in after if "ghost" in r["text"])
        assert ghost["style"]["render_mode"] == 3

    def test_fingerprint_mismatch_refuses(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Hello world) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        with pytest.raises(ValueError, match="changed underneath"):
            replace_paragraph_text(
                src,
                out,
                1,
                para["index"],
                "New",
                [{"start": 0, "end": 3, "run": para["runs"][0]}],
                para["runs"],
                "stale text fingerprint",
            )

    def test_uneditable_paragraph_refuses_with_reason(self, tmp_dir):
        src = os.path.join(tmp_dir, "rtl.pdf")
        pdf = pikepdf.new()
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (A) Tj ET", {"/F1": _hebrew(pdf)})
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        with pytest.raises(ValueError, match="right-to-left"):
            _apply(src, out, para, "B")

    def test_unencodable_without_convert_names_the_char(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Hello world) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        with pytest.raises(ValueError, match="→"):
            _apply(src, out, para, "Hello → world")

    def test_justify_preserved_on_edit(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj 36.67 0 Td (World) Tj "
            b"-36.67 -14 Td (Hello) Tj 36.67 0 Td (World) Tj "
            b"-36.67 -14 Td (End) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        assert para["alignment"] == "justify"
        # Every non-last wrapped line keeps ≥2 words — a single-word line
        # cannot stretch (no gaps), which is also how real justifiers
        # behave, so the fixture avoids asserting the impossible.
        _apply(src, out, para, "Hello World Hello World Hello words")
        relisted = _paras(out)
        assert relisted[0]["alignment"] == "justify"
        # Non-last lines stay flush to both edges within tolerance.
        out_runs = list_text_paragraphs(out, 1)["runs"]
        tops = sorted({round(r["rect"][1], 1) for r in out_runs}, reverse=True)
        first_line_runs = [r for r in out_runs if round(r["rect"][1], 1) == tops[0]]
        assert min(r["rect"][0] for r in first_line_runs) == pytest.approx(72, abs=0.1)
        assert max(r["rect"][2] for r in first_line_runs) == pytest.approx(140, abs=0.8)

    def test_center_preserved_on_edit(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 136.33 700 Td (Hello) Tj "
            b"8.01 -14 Td (Hi) Tj -8.01 -14 Td (Hello) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        assert para["alignment"] == "center"
        _apply(src, out, para, "Hello Hi Hello again")
        relisted = _paras(out)
        # Line centers stay on the box center.
        box = para["box"]
        center = (box[0] + box[2]) / 2
        out_runs = list_text_paragraphs(out, 1)["runs"]
        tops = sorted({round(r["rect"][1], 1) for r in out_runs}, reverse=True)
        for top in tops:
            line_runs = [r for r in out_runs if round(r["rect"][1], 1) == top]
            line_center = (
                min(r["rect"][0] for r in line_runs) + max(r["rect"][2] for r in line_runs)
            ) / 2
            assert line_center == pytest.approx(center, abs=1.0)

    def test_nested_form_paragraph_edits_one_instance(self, tmp_dir):
        src = os.path.join(tmp_dir, "form2.pdf")
        pdf = pikepdf.new()
        helv = _helv(pdf)
        form = pdf.make_stream(b"BT /F1 12 Tf 0 0 Td (Shared form text) Tj ET")
        form["/Type"] = Name("/XObject")
        form["/Subtype"] = Name("/Form")
        form["/BBox"] = Array([0, 0, 300, 20])
        form["/Resources"] = Dictionary(Font=Dictionary(F1=helv))
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = Dictionary(
            Font=Dictionary(F1=helv), XObject=Dictionary(Fm1=form)
        )
        page.Contents = pdf.make_stream(
            b"q 1 0 0 1 72 700 cm /Fm1 Do Q q 1 0 0 1 72 400 cm /Fm1 Do Q"
        )
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        assert len(paras) == 2  # one per instance (streams never share)
        target = paras[1]  # the lower instance
        _apply(src, out, target, "Edited instance text")
        text = extract_text(out)["text"]
        assert "Edited instance text" in text
        assert "Shared form text" in text  # the OTHER instance, untouched
        _assert_non_members_unmoved(src, out, target["runs"])

    def test_cjk_wraps_without_spaces(self, tmp_dir):
        src = os.path.join(tmp_dir, "cjk.pdf")
        pdf = pikepdf.new()
        mapping = {1: "日", 2: "本", 3: "語", 4: "編", 5: "集", 6: "文", 7: "字", 8: "列"}
        tounicode_entries = "\n".join(
            f"<{code:04x}> <{ord(ch):04x}>" for code, ch in mapping.items()
        )
        tounicode = (
            "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
            "1 begincodespacerange <0000> <ffff> endcodespacerange\n"
            f"{len(mapping)} beginbfchar\n{tounicode_entries}\nendbfchar\n"
            "endcmap end end\n"
        ).encode("ascii")
        desc = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/CIDFontType2"),
                BaseFont=Name("/AAAAAA+CJK"),
                CIDSystemInfo=Dictionary(
                    Registry=b"Adobe", Ordering=b"Identity", Supplement=0
                ),
                DW=1000,
            )
        )
        cid_font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type0"),
                BaseFont=Name("/AAAAAA+CJK"),
                Encoding=Name("/Identity-H"),
                DescendantFonts=Array([desc]),
                ToUnicode=pdf.make_stream(tounicode),
            )
        )
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td <00010002000300040005> Tj "
            b"0 -14 Td <000600070008> Tj ET",
            {"/F1": cid_font},
        )
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        assert para["text"] == "日本語編集文字列"  # no synthetic spaces
        # Box width = 5 CJK chars (60pt). Nine chars must wrap to 2 lines.
        new_text = "日本語編集文字列日"
        _apply(src, out, para, new_text)
        relisted = _paras(out)
        assert relisted[0]["text"] == new_text
        assert relisted[0]["line_count"] == 2

    def test_spaceless_font_round_trips_gap_as_kern(self, tmp_dir):
        src = os.path.join(tmp_dir, "nospace.pdf")
        pdf = pikepdf.new()
        tounicode = (
            b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
            b"1 begincodespacerange <0000> <ffff> endcodespacerange\n"
            b"2 beginbfchar\n<0001> <0041>\n<0002> <0042>\nendbfchar\n"
            b"endcmap end end\n"
        )
        desc = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/CIDFontType2"),
                BaseFont=Name("/AAAAAA+AB"),
                CIDSystemInfo=Dictionary(
                    Registry=b"Adobe", Ordering=b"Identity", Supplement=0
                ),
                DW=500,
            )
        )
        cid_font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type0"),
                BaseFont=Name("/AAAAAA+AB"),
                Encoding=Name("/Identity-H"),
                DescendantFonts=Array([desc]),
                ToUnicode=pdf.make_stream(tounicode),
            )
        )
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td <0001> Tj 20 0 Td <0002> Tj ET",
            {"/F1": cid_font},
        )
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        assert para["text"] == "A B"  # the positioned gap became a space
        _apply(src, out, para, "B A")
        relisted = _paras(out)
        assert relisted[0]["text"] == "B A"  # kern-gap round-trips as a space

    def test_single_line_paragraph_wraps_at_the_symmetric_page_margin(self, tmp_dir):
        # Review-caught CRITICAL: leading=None collapsed the measure to ∞
        # and a grown title ran to 1.8× the page width. The rule now: a
        # single line extends right to the mirrored left inset (72 → limit
        # 540 on a 612pt page), then wraps downward at 1.2em leading.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Short title) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        long_text = "Short title " + "grown with many additional words " * 6
        _apply(src, out, para, long_text.strip())
        relisted = _paras(out)
        assert relisted[0]["line_count"] >= 2
        for run in list_text_paragraphs(out, 1)["runs"]:
            assert run["rect"][2] <= 540 + 1.0  # 612 − 72 (symmetric margin)
        # Wrapped lines stack at 1.2em (14.4pt at 12pt size).
        tops = sorted({round(r["rect"][1], 1) for r in list_text_paragraphs(out, 1)["runs"]}, reverse=True)
        assert tops[0] - tops[1] == pytest.approx(14.4, abs=0.1)

    def test_single_line_wrap_never_rewraps_unchanged_wide_lines(self, tmp_dir):
        # A single line already wider than the symmetric limit must not
        # rewrap under an unrelated small edit (measure floors at the
        # line's own width).
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 500 700 Td (Wide line sitting near the right edge) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"].replace("Wide", "Vast"))
        assert _paras(out)[0]["line_count"] == 1

    def test_repeated_edits_do_not_compound_stream_growth(self, tmp_dir):
        # Review-measured HIGH: interior operators of the removed member
        # span leaked into the output and every re-edit added ~17 ops.
        # The in-span drop rule makes repeated identical edits reach a
        # fixed point.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td 1 0 0 rg (Colored) Tj 0 0 0 rg 50 0 Td (Normal) Tj ET",
        )
        paths = [src] + [os.path.join(tmp_dir, f"o{i}.pdf") for i in range(3)]

        def op_count(path):
            with pikepdf.open(path) as pdf:
                return len(pikepdf.parse_content_stream(pdf.pages[0]))

        text = _paras(src)[0]["text"]
        for i in range(3):
            para = _paras(paths[i])[0]
            _apply(paths[i], paths[i + 1], para, text)
        assert op_count(paths[2]) == op_count(paths[3])
        # And the colored span still round-trips after three passes.
        after = _detail_runs(paths[3])
        colored = next(r for r in after if "Colored" in r["text"])
        assert _color_repr(colored["style"]["fill_color"])[1] == ("rg", (1.0, 0.0, 0.0))

    def test_in_span_paint_content_survives_with_its_color(self, tmp_dir):
        # An underline rule drawn BETWEEN member runs is real content: it
        # must survive the edit, and the resync must hand it its color
        # even though the in-span `rg` that set it was dropped.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Under) Tj ET "
            b"0 0 1 rg 72 697 30 0.8 re f "
            b"BT /F1 12 Tf 102 700 Td (lined) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        assert para["text"] == "Underlined"
        _apply(src, out, para, "Overlined")
        with pikepdf.open(out) as pdf:
            ops = [
                (str(i.operator), [str(o) for o in i.operands])
                for i in pikepdf.parse_content_stream(pdf.pages[0])
            ]
        re_idx = next(i for i, (op, _) in enumerate(ops) if op == "re")
        assert ops[re_idx + 1][0] == "f"
        # The blue fill must be in force at the paint: the nearest fill
        # color op before it is the original `0 0 1 rg`.
        prior_fills = [o for o in ops[:re_idx] if o[0] in ("g", "rg", "k", "sc", "scn")]
        assert prior_fills and prior_fills[-1] == ("rg", ["0", "0", "1"])

    def test_superscript_rise_survives_edit(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj /F1 6 Tf 27.8 5 Td (1) Tj "
            b"/F1 12 Tf -27.8 -19 Td (world text here) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        spans = para["spans"]
        # Keep every span's own style; append to the LAST span's text.
        new_text = para["text"] + " more"
        edit_spans = [dict(s) for s in spans]
        edit_spans[-1]["end"] = len(new_text)
        _apply(src, out, para, new_text, spans=edit_spans)
        after = _detail_runs(out)
        # The line-join space rides the marker's span, so its re-emitted
        # run text is "1 " — match by stripped content.
        marker = next(r for r in after if r["text"].strip() == "1")
        # The marker's baseline offset re-renders as rise: composed y ==
        # line baseline, style rise == +5 (text space).
        assert marker["style"]["rise"] == pytest.approx(5.0, abs=0.05)
        assert marker["style"]["size"] == pytest.approx(6.0, abs=1e-6)

    def test_first_line_indent_preserved(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 90 700 Td (Indented first line) Tj "
            b"-18 -14 Td (body line follows here) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, "Indented first line body line follows here plus growth")
        out_runs = list_text_paragraphs(out, 1)["runs"]
        tops = sorted({round(r["rect"][1], 1) for r in out_runs}, reverse=True)
        first_x = min(r["rect"][0] for r in out_runs if round(r["rect"][1], 1) == tops[0])
        body_xs = [
            min(r["rect"][0] for r in out_runs if round(r["rect"][1], 1) == top)
            for top in tops[1:]
        ]
        assert first_x == pytest.approx(90, abs=0.05)
        for bx in body_xs:
            assert bx == pytest.approx(72, abs=0.05)

    def test_q_bracket_and_cm_scoped_paragraph(self, tmp_dir):
        # The paragraph lives inside q 1 0 0 1 20 0 cm ... Q; a follower
        # paints AFTER the Q under the outer ctm — position + color of the
        # follower must be untouched (the property harness proves it).
        src = _build(
            tmp_dir,
            b"q 1 0 0 1 20 0 cm BT /F1 12 Tf 72 700 Td (Shifted paragraph text) Tj "
            b"0 -14 Td (second line) Tj ET Q "
            b"BT /F1 12 Tf 300 700 Td (Outside) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        target = next(p for p in paras if "Shifted" in p["text"])
        _apply(src, out, target, "Shifted paragraph text second line grown longer")
        _assert_non_members_unmoved(src, out, target["runs"])
        relisted = _paras(out)
        edited = next(p for p in relisted if "Shifted" in p["text"])
        # The cm translation held: box left = 72 + 20.
        assert edited["box"][0] == pytest.approx(92, abs=0.05)

    def test_paragraph_in_second_bt_block(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (First block) Tj ET "
            b"BT /F1 12 Tf 72 600 Td (Second block text) Tj 0 -14 Td (with lines) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        target = next(p for p in paras if "Second" in p["text"])
        _apply(src, out, target, "Second block text with lines and growth")
        _assert_non_members_unmoved(src, out, target["runs"])

    def test_h_scale_span_preserved(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 80 Tz 72 700 Td (Condensed text here) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, "Condensed text here edited")
        after = _detail_runs(out)
        run = next(r for r in after if "Condensed" in r["text"])
        assert run["style"]["h_scale"] == pytest.approx(0.8, abs=1e-6)

    @pytest.mark.skipif(
        not os.path.isfile(FALLBACK_FONT), reason="bundled fallback font not provisioned"
    )
    def test_convert_renders_unencodable_span_in_fallback(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Hello world) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(
            src,
            out,
            para,
            "Hello → world",
            convert=True,
            font_path=FALLBACK_FONT,
        )
        text = extract_text(out)["text"]
        assert "→" in text
        assert "Hello" in text and "world" in text
        # The fallback span must be re-editable: re-list and check.
        relisted = _paras(out)
        assert relisted[0]["editable"] is True
        assert "→" in relisted[0]["text"]

    @pytest.mark.skipif(
        not os.path.isfile(FALLBACK_FONT), reason="bundled fallback font not provisioned"
    )
    def test_convert_of_nested_form_paragraph_uses_form_scoped_family(self, tmp_dir):
        # 9.B1 review-caught: the paragraph living in a nested form must
        # classify its family from the FORM'S resources, not the page's —
        # a form's `F1` (serif Times here) differs from the page's `F1`
        # (Helvetica). Converting must embed the SERIF fallback face.
        import os as _os

        fonts_dir = _os.path.dirname(FALLBACK_FONT)
        src = os.path.join(tmp_dir, "nf.pdf")
        pdf = pikepdf.new()
        page_helv = _helv(pdf)
        form_serif = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type1"),
                BaseFont=Name("/TimesNewRoman"),
                Encoding=Name("/WinAnsiEncoding"),
                FontDescriptor=pdf.make_indirect(
                    Dictionary(Type=Name("/FontDescriptor"), Flags=2)
                ),
            )
        )
        form = pdf.make_stream(b"BT /F1 12 Tf 0 0 Td (Serif form text) Tj ET")
        form["/Type"] = Name("/XObject")
        form["/Subtype"] = Name("/Form")
        form["/BBox"] = Array([0, 0, 300, 20])
        form["/Resources"] = Dictionary(Font=Dictionary(F1=form_serif))
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = Dictionary(
            Font=Dictionary(F1=page_helv), XObject=Dictionary(Fm1=form)
        )
        page.Contents = pdf.make_stream(b"q 1 0 0 1 72 700 cm /Fm1 Do Q")
        pdf.save(src)
        pdf.close()

        para = _paras(src)[0]
        assert "Serif form text" in para["text"]
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, para, "Serif form → text", convert=True, font_path=fonts_dir)
        with pikepdf.open(out) as opened:
            base = []
            for pg in opened.pages:
                for _nm, xobj in (pg.get("/Resources", {}).get("/XObject", {}) or {}).items():
                    fonts = xobj.get("/Resources", {}).get("/Font", {}) or {}
                    for k in fonts.keys():
                        bf = fonts[k].get("/BaseFont")
                        if bf is not None:
                            base.append(str(bf))
        assert any("LiberationSerif" in b for b in base)
        assert not any("LiberationSans" in b for b in base)


class TestStyleControls:
    """Phase 9.A1 — uniform size + colour restyle of a paragraph."""

    def test_color_override_emits_fill_op_and_recolors(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Recolor this whole paragraph now) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], color=[1.0, 0.0, 0.0])
        after = _detail_runs(out)
        run = next(r for r in after if "Recolor" in r["text"])
        assert _color_repr(run["style"]["fill_color"])[1] == ("rg", (1.0, 0.0, 0.0))

    def test_size_override_changes_glyph_size_and_rewraps(self, tmp_dir):
        # A short paragraph at 12pt on one line; doubling the size makes it
        # wider and (in a fixed box) wraps to more lines.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Alpha beta gamma delta words) Tj "
            b"0 -14 Td (second line of the paragraph here) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], size=24)
        after = list_text_paragraphs(out, 1)
        # The runs now render at ~24pt (font_size in the listing).
        assert any(abs(r["font_size"] - 24) < 0.01 for r in after["runs"])
        relisted = after["paragraphs"]
        # Doubled text in the same box wraps to strictly more lines.
        assert relisted[0]["line_count"] > para["line_count"]

    def test_size_override_scales_leading(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 10 Tf 72 700 Td (Line one of this paragraph) Tj "
            b"0 -12 Td (Line two of this paragraph) Tj "
            b"0 -12 Td (Line three of this paragraph) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        assert para["line_count"] == 3
        # Original leading is 12pt at 10pt text; at 20pt it should ~double.
        _apply(src, out, para, para["text"], size=20)
        out_runs = list_text_paragraphs(out, 1)["runs"]
        tops = sorted({round(r["rect"][1], 1) for r in out_runs}, reverse=True)
        assert len(tops) >= 2
        gap = tops[0] - tops[1]
        assert gap == pytest.approx(24.0, abs=1.5)  # 12 * (20/10)

    def test_size_and_color_together(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Both at once please) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], size=18, color=[0.0, 0.0, 1.0])
        after = _detail_runs(out)
        run = next(r for r in after if "Both" in r["text"])
        assert run["style"]["size"] == pytest.approx(18, abs=0.01)
        assert _color_repr(run["style"]["fill_color"])[1] == ("rg", (0.0, 0.0, 1.0))

    def test_size_is_clamped_so_text_cannot_fly_off_page(self, tmp_dir):
        # Review-caught HIGH: an unbounded size pushed most of the
        # paragraph off the page. A fat-fingered 9999 clamps to the
        # editor max (1638) and the text stays on the mediabox.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Clamp this size please) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], size=9999)
        after = list_text_paragraphs(out, 1)["runs"]
        assert any(abs(r["font_size"] - 1638) < 0.1 for r in after)

    def test_color_recolors_stroke_rendered_text(self, tmp_dir):
        # Review-caught: Tr 1 (stroke) text shows its STROKE colour, so a
        # fill-only recolour was a silent no-op. The override must reach
        # stroke_color for stroke/fill-stroke render modes.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 1 Tr 0 0 0 RG 72 700 Td (Outline text here) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], color=[1.0, 0.0, 0.0])
        after = _detail_runs(out)
        run = next(r for r in after if "Outline" in r["text"])
        assert _color_repr(run["style"]["stroke_color"])[1] == ("RG", (1.0, 0.0, 0.0))

    def test_size_seed_is_the_dominant_member_not_a_lead_in(self, tmp_dir):
        # Review-caught: the seed shown to the user (font_size) must match
        # the member the leading-scale reasons from — the widest of line 0,
        # not a small first-by-index marker.
        src = _build(
            tmp_dir,
            b"BT /F1 6 Tf 72 700 Td (1) Tj /F1 12 Tf 10 0 Td (Main body text of the note) Tj ET",
        )
        para = _paras(src)[0]
        assert para["font_size"] == pytest.approx(12, abs=0.01)  # the body, not the 6pt marker

    def test_no_override_is_byte_identical_to_plain_edit(self, tmp_dir):
        # size=None/color=None/family=None must not perturb the shipped
        # 7.5 path (family joined the guard at 9.A3a).
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Grow this paragraph text) Tj ET")
        out_a = os.path.join(tmp_dir, "a.pdf")
        out_b = os.path.join(tmp_dir, "b.pdf")
        para = _paras(src)[0]
        new = para["text"] + " with more"
        _apply(src, out_a, para, new)
        _apply(src, out_b, para, new, size=None, color=None, family=None)
        with pikepdf.open(out_a) as pa, pikepdf.open(out_b) as pb:
            assert pa.pages[0].Contents.read_bytes() == pb.pages[0].Contents.read_bytes()


def _times(pdf) -> pikepdf.Object:
    """Serif-classified simple font (the nested-form test's shape)."""
    return pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type1"),
            BaseFont=Name("/TimesNewRoman"),
            Encoding=Name("/WinAnsiEncoding"),
            FontDescriptor=pdf.make_indirect(
                Dictionary(Type=Name("/FontDescriptor"), Flags=2)
            ),
        )
    )


def _page_base_fonts(path: str) -> list[str]:
    with pikepdf.open(path) as pdf:
        fonts = pdf.pages[0].obj.get("/Resources", {}).get("/Font", {}) or {}
        return [str(fonts[k].get("/BaseFont", "")) for k in fonts.keys()]


FONTS_DIR = os.path.dirname(FALLBACK_FONT)
SERIF_FONT = os.path.join(FONTS_DIR, "LiberationSerif-Regular.ttf")
MONO_FONT = os.path.join(FONTS_DIR, "LiberationMono-Regular.ttf")

_needs_faces = pytest.mark.skipif(
    not (os.path.isfile(FALLBACK_FONT) and os.path.isfile(SERIF_FONT) and os.path.isfile(MONO_FONT)),
    reason="bundled fallback faces not provisioned",
)


class TestFamilySwap:
    """Phase 9.A3a — whole-paragraph family substitution (sans/serif/mono).

    The swap forces EVERY character through the fallback machinery in the
    chosen Liberation face — an honest substitution of the original
    foundry font. The no-family path must stay byte-identical to shipped
    7.5/A1 (guarded above in test_no_override_is_byte_identical…)."""

    @_needs_faces
    def test_swap_to_serif_embeds_liberation_serif_and_round_trips(self, tmp_dir):
        # Pure restyle: SAME text, family only. The sans (Helvetica)
        # paragraph re-renders wholly in Liberation Serif and stays one
        # editable, extractable paragraph.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Alpha beta gamma delta words) Tj "
            b"0 -14 Td (flowing on the second line) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], family="serif", font_path=FONTS_DIR)
        assert any("LiberationSerif" in b for b in _page_base_fonts(out))
        text = extract_text(out)["text"]
        assert "Alpha beta gamma delta words" in text
        assert "flowing on the second line" in text
        relisted = _paras(out)
        assert len(relisted) == 1
        assert relisted[0]["editable"] is True
        assert relisted[0]["text"] == para["text"]

    @_needs_faces
    def test_swap_serif_paragraph_to_sans(self, tmp_dir):
        # The opposite direction, with a text change riding along — the
        # serif original must land in the SANS face (classification
        # bypassed by the explicit choice, not re-derived from the run).
        srcpdf = pikepdf.new()
        _page(
            srcpdf,
            b"BT /F1 12 Tf 72 700 Td (Serif body text here) Tj ET",
            {"/F1": _times(srcpdf)},
        )
        src = os.path.join(tmp_dir, "serif.pdf")
        srcpdf.save(src)
        srcpdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, "Serif body now sans", family="sans", font_path=FONTS_DIR)
        base = _page_base_fonts(out)
        assert any("LiberationSans" in b for b in base)
        assert not any("LiberationSerif" in b for b in base)
        assert "Serif body now sans" in extract_text(out)["text"]

    @_needs_faces
    def test_swap_to_mono(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Now in a code face) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], family="mono", font_path=FONTS_DIR)
        assert any("LiberationMono" in b for b in _page_base_fonts(out))

    @_needs_faces
    def test_family_composes_with_size_and_color(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (All three at once) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(
            src, out, para, para["text"],
            family="serif", size=18, color=[0.0, 0.0, 1.0], font_path=FONTS_DIR,
        )
        assert any("LiberationSerif" in b for b in _page_base_fonts(out))
        after = _detail_runs(out)
        run = next(r for r in after if "All three" in r["text"])
        assert run["style"]["size"] == pytest.approx(18, abs=0.01)
        assert _color_repr(run["style"]["fill_color"])[1] == ("rg", (0.0, 0.0, 1.0))

    @_needs_faces
    def test_family_swap_keeps_other_paragraphs_unmoved(self, tmp_dir):
        # THE delicate-rewriter guard at A3a scope: swapping one
        # paragraph's family must leave every other show op at an
        # identical matrix with identical state (the resync property).
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Swap this paragraph only) Tj "
            b"0 -60 Td (This one stays untouched) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        assert len(paras) == 2
        target = next(p for p in paras if "Swap this" in p["text"])
        _apply(src, out, target, target["text"], family="serif", font_path=FONTS_DIR)
        _assert_non_members_unmoved(src, out, target["runs"])
        assert any("This one stays untouched" in p["text"] for p in _paras(out))

    @_needs_faces
    def test_family_refuses_chars_outside_liberation(self, tmp_dir):
        # Liberation has no CJK — the swap must refuse with the char
        # named, never emit a missing glyph.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Hello world) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        new = "Hello 你 world"
        with pytest.raises(ValueError, match="cannot express"):
            _apply(src, out, para, new, family="serif", font_path=FONTS_DIR)

    def test_invalid_family_refuses(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Whatever text) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        with pytest.raises(ValueError, match="family must be"):
            _apply(src, out, para, para["text"], family="cursive", font_path=FONTS_DIR)

    def test_family_requires_font_path(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Needs the fonts dir) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        with pytest.raises(ValueError, match="fallback font path"):
            _apply(src, out, para, para["text"], family="serif")

    def test_no_family_edit_does_not_embed_fallback(self, tmp_dir):
        # Direct pin that force_fallback is OFF by default: a plain text
        # edit embeds nothing (the byte-identical guard's readable twin).
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Plain edit stays plain) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"] + " grown")
        assert not any("Liberation" in b for b in _page_base_fonts(out))


class TestAlignmentDetection:
    def test_center(self, tmp_dir):
        # Centers share x=150; Hello=27.34pt wide, Hi=11.33pt.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 136.33 700 Td (Hello) Tj "
            b"8.01 -14 Td (Hi) Tj -8.01 -14 Td (Hello) Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 1
        assert paras[0]["alignment"] == "center"

    def test_right(self, tmp_dir):
        # Right edges share x=300.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 272.66 700 Td (Hello) Tj "
            b"16.01 -14 Td (Hi) Tj -16.01 -14 Td (Hello) Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 1
        assert paras[0]["alignment"] == "right"

    def test_justify(self, tmp_dir):
        # Two flush-both lines (72..140, a realistic word gap of ~9pt —
        # under the column-split threshold) + a short ragged last line.
        # World is 31.33pt wide -> starts at 108.67 to end at 140.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Hello) Tj 36.67 0 Td (World) Tj "
            b"-36.67 -14 Td (Hello) Tj 36.67 0 Td (World) Tj "
            b"-36.67 -14 Td (End) Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 1
        assert paras[0]["alignment"] == "justify"

    def test_left_default_with_ragged_right(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Hello there friend) Tj "
            b"0 -14 Td (Hi) Tj ET",
        )
        paras = _paras(src)
        assert paras[0]["alignment"] == "left"
