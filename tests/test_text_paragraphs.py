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


def _identity_v(pdf, mapping: dict[int, str], w2: list) -> pikepdf.Object:
    """Identity-V + ToUnicode + /W2 — the 9.B4a vertical-run producer."""
    from tests.test_pdf_fonts import _tounicode_stream

    desc = pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/CIDFontType2"),
            BaseFont=Name("/VertFace"),
            CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
            W2=Array([Array(el) if isinstance(el, list) else el for el in w2]),
        )
    )
    return pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type0"),
            BaseFont=Name("/VertFace"),
            Encoding=Name("/Identity-V"),
            DescendantFonts=Array([desc]),
            ToUnicode=_tounicode_stream(pdf, mapping),
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

    def test_clipped_away_paragraph_flagged(self, tmp_dir):
        # 9-§I.0-S8: a paragraph whose EVERY member is clipped away lists with
        # clipped=True; a visible paragraph with clipped=False. The runs channel
        # carries the per-run flag too. Order-robust: map by text.
        src = _build(
            tmp_dir,
            b"0 400 200 392 re W n "                    # clip to top-left region
            b"BT /F1 12 Tf 20 700 Td (Visible) Tj ET "  # inside the clip
            b"BT /F1 12 Tf 400 100 Td (Hidden) Tj ET",  # outside the clip
        )
        listing = list_text_paragraphs(src, 1)
        assert {p["text"]: p["clipped"] for p in listing["paragraphs"]} == {
            "Visible": False,
            "Hidden": True,
        }
        assert {r["text"]: r["clipped"] for r in listing["runs"]} == {
            "Visible": False,
            "Hidden": True,
        }

    def test_straddling_run_not_clipped(self, tmp_dir):
        # A run PARTLY inside the clip (bbox intersects the clip) is NOT flagged
        # — the safe direction, never hide content that may be visible.
        src = _build(
            tmp_dir,
            b"0 0 60 792 re W n "  # clip left strip x∈[0,60]
            b"BT /F1 12 Tf 40 700 Td (Wide) Tj ET",  # [40,~67] straddles x=60
        )
        listing = list_text_paragraphs(src, 1)
        assert len(listing["runs"]) == 1
        assert listing["runs"][0]["clipped"] is False
        assert listing["paragraphs"][0]["clipped"] is False

    def test_rotated_text_never_groups(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 0 1 -1 0 100 100 Tm (Rotated) Tj ET",
        )
        listing = list_text_paragraphs(src, 1)
        assert listing["paragraphs"] == []
        assert len(listing["runs"]) == 1

    def test_vertical_runs_group_with_column_gap_paragraph_break(self, tmp_dir):
        # 9.B4b lifted the B4a never-groups boundary: vertical runs now
        # group under the transposition — a column IS a line, and a large
        # gap DOWN the column (transposed: a large x-gap) is a paragraph
        # break, exactly the horizontal column-split rule. This fixture's
        # 40pt hop past a 17pt column therefore lists TWO paragraphs.
        src = os.path.join(tmp_dir, "vert.pdf")
        pdf = pikepdf.new()
        vfont = _identity_v(pdf, {3: "あ", 4: "い"}, [3, [-900, 500, 880, -800, 450, 880]])
        _page(
            pdf,
            b"BT /F1 10 Tf 100 700 Td <00030004> Tj 0 -40 Td <0003> Tj ET",
            {"/F1": vfont},
        )
        pdf.save(src)
        pdf.close()
        listing = list_text_paragraphs(src, 1)
        assert len(listing["runs"]) == 2
        assert all(r["vertical"] and r["editable"] for r in listing["runs"])
        paras = listing["paragraphs"]
        assert [p["text"] for p in paras] == ["あい", "あ"]
        assert all(p["vertical"] and p["editable"] for p in paras)

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

    def test_kept_vertical_column_survives_a_paragraph_edit(self, tmp_dir):
        # 9.B4a: the resync's REPOSITIONING is direction-agnostic (kept
        # shows are re-anchored at the parallel walk's ABSOLUTE tm), but
        # the walk's model must advance a kept vertical show DOWNWARD.
        # The column here FLOWS from the member with no Td between, so
        # divergence is still live at BOTH vertical shows and their
        # injected anchors bake the model's axis into the file — asserted
        # against HAND-COMPUTED spec positions (a self-consistent
        # wrong-axis model passes any walker-vs-walker comparison, so the
        # dual-walk harness alone cannot pin this).
        src = os.path.join(tmp_dir, "mix.pdf")
        pdf = pikepdf.new()
        vfont = _identity_v(pdf, {3: "あ", 4: "い"}, [3, [-900, 500, 880, -800, 450, 880]])
        # Member "HH" (Helvetica 722×2 → 17.328 wide at 12); the column
        # flows at x = 72+17.328, advances (900+800)/1000×10 = 17 then
        # 900/1000×10 = 9 downward from y = 700.
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (HH) Tj /FV 10 Tf <00030004> Tj <0003> Tj ET",
            {"/F1": _helv(pdf), "/FV": vfont},
        )
        pdf.save(src)
        pdf.close()
        v1 = [72 + 17.328 - 5, 683, 72 + 17.328 + 5, 700]
        v2 = [72 + 17.328 - 5, 674, 72 + 17.328 + 5, 683]
        before = list_text_runs(src, 1)["runs"]
        assert before[1]["rect"] == pytest.approx(v1, abs=0.05)
        assert before[2]["rect"] == pytest.approx(v2, abs=0.05)

        paras = _paras(src)
        # 9.B4b: the vertical column now groups as its OWN paragraph —
        # still never a member of the horizontal one (the mode key), so
        # it stays a KEPT run for this edit.
        assert len(paras) == 2
        target = next(p for p in paras if "HH" in p["text"])
        _apply(src, out := os.path.join(tmp_dir, "o.pdf"), target, "HHH")
        _assert_non_members_unmoved(src, out, target["runs"])
        after = list_text_runs(out, 1)["runs"]
        assert [r["vertical"] for r in after] == [False, True, True]
        # The kept column sits at its ORIGINAL spec positions — the grown
        # member does not push it, and the flowed second show's baked
        # anchor is one advance DOWN, not sideways.
        assert after[1]["rect"] == pytest.approx(v1, abs=0.05)
        assert after[2]["rect"] == pytest.approx(v2, abs=0.05)

    def test_flowing_vertical_run_between_members_keeps_the_tail_unmoved(self, tmp_dir):
        # 9.B4a round-27 coverage gap: the KEPT-ALREADY-RESYNCED advance
        # site (the else branch after divergence closes) was mutation-
        # invisible — dropping its `vert` flag failed NOTHING while a
        # trailing run silently jumped sideways. The exposing shape: a
        # vertical column FLOWING (no Td) between two members of one
        # paragraph, and a further vertical run flowing after the second
        # member; editing the paragraph must leave the tail at its
        # hand-computed spec position (lens-repro'd drift: ~9pt x-jump
        # with the flag dropped).
        # The exposing shape (lens blueprint): `0 0 Td` before the column
        # + a LONG replacement lets the resync CLOSE divergence before
        # the tail show — routing it through the kept-already-resynced
        # else branch, the one site every other test misses.
        src = os.path.join(tmp_dir, "gap.pdf")
        pdf = pikepdf.new()
        vfont = _identity_v(pdf, {3: "a"}, [3, [-900, 500, 880]])
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (Row) Tj"
            b" 0 0 Td /FV 10 Tf <0003> Tj <0003> Tj"
            b" /F1 12 Tf (Two) Tj"
            b" /FV 10 Tf <0003> Tj ET",
            {"/F1": _helv(pdf), "/FV": vfont},
        )
        pdf.save(src)
        pdf.close()
        before = list_text_runs(src, 1)["runs"]
        tail_before = [r for r in before if r["vertical"]][-1]["rect"]

        paras = _paras(src)
        target = next(p for p in paras if "Row" in p["text"])
        assert len(target["runs"]) >= 2  # both horizontal members grouped
        out = os.path.join(tmp_dir, "o.pdf")
        spans = [{"start": 0, "end": len("Rowxxxxxxxxxx Two"), "run": target["runs"][0]}]
        _apply(src, out, target, "Rowxxxxxxxxxx Two", spans=spans)
        after = list_text_runs(out, 1)["runs"]
        tail_after = [r for r in after if r["vertical"]][-1]["rect"]
        # With the else-branch advance's `vert` flag dropped, this tail
        # jumps sideways (lens mutation repro); correct axis = unmoved.
        assert tail_after == pytest.approx(tail_before, abs=0.05), (
            f"tail moved: {tail_after} vs {tail_before}"
        )

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
        # size=None/color=None/family=None/bold=None/italic=None must not
        # perturb the shipped 7.5 path (family joined the guard at 9.A3a,
        # the style axis at 9.A3b).
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Grow this paragraph text) Tj ET")
        out_a = os.path.join(tmp_dir, "a.pdf")
        out_b = os.path.join(tmp_dir, "b.pdf")
        para = _paras(src)[0]
        new = para["text"] + " with more"
        _apply(src, out_a, para, new)
        _apply(src, out_b, para, new, size=None, color=None, family=None, bold=None, italic=None)
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


def _fallback_font_names(path: str) -> list[str]:
    """The page-level /EditFb* subset font names — one per embedded fallback
    subset. len() == the count of distinct faces the edit substituted (9.A5b:
    zero for a colour-only or plain edit, one for a whole-para A3 swap)."""
    with pikepdf.open(path) as pdf:
        fonts = pdf.pages[0].obj.get("/Resources", {}).get("/Font", {}) or {}
        return [str(k) for k in fonts.keys() if str(k).startswith("/EditFb")]


FONTS_DIR = os.path.dirname(FALLBACK_FONT)

# The COMPLETE vendored bundle (sync-edit-fonts.ps1's $Faces): the guard
# must cover every face any test here embeds, or a stale local cache
# (pre-A3b: Regulars only) runs the style tests against the degrade
# ladder and FAILS them instead of skipping (review-caught, repro'd).
_ALL_FACES = [
    f"Liberation{fam}-{style}.ttf"
    for fam in ("Sans", "Serif", "Mono")
    for style in ("Regular", "Bold", "Italic", "BoldItalic")
]

_needs_faces = pytest.mark.skipif(
    not all(os.path.isfile(os.path.join(FONTS_DIR, n)) for n in _ALL_FACES),
    reason="bundled fallback faces not provisioned (run scripts/sync-edit-fonts.ps1)",
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


def _helv_bold(pdf) -> pikepdf.Object:
    """Bold-named simple font (the common real-world bold signal)."""
    return pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type1"),
            BaseFont=Name("/Helvetica-Bold"),
            Encoding=Name("/WinAnsiEncoding"),
        )
    )


class TestStyleAxis:
    """Phase 9.A3b — bold/italic substitution (the vendored variant faces).

    A present bold/italic is ABSOLUTE: the substituted face is
    styles[bold][italic]; family still classifies from the paragraph's own
    font when not explicit. All-None stays the shipped byte-identical
    path (guarded in test_no_override_is_byte_identical…)."""

    @_needs_faces
    def test_bold_swap_embeds_bold_face(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Make this paragraph bold) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], bold=True, font_path=FONTS_DIR)
        assert any("LiberationSans-Bold" in b for b in _page_base_fonts(out))
        relisted = _paras(out)
        assert relisted[0]["editable"] is True
        assert relisted[0]["text"] == para["text"]
        # The re-listing seeds the toggle from the embedded bold face.
        assert relisted[0]["bold"] is True
        assert relisted[0]["italic"] is False

    @_needs_faces
    def test_italic_and_bolditalic(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Slant this text now) Tj ET")
        out_i = os.path.join(tmp_dir, "i.pdf")
        para = _paras(src)[0]
        _apply(src, out_i, para, para["text"], italic=True, font_path=FONTS_DIR)
        assert any("LiberationSans-Italic" in b for b in _page_base_fonts(out_i))
        out_bi = os.path.join(tmp_dir, "bi.pdf")
        _apply(src, out_bi, para, para["text"], bold=True, italic=True, font_path=FONTS_DIR)
        assert any("LiberationSans-BoldItalic" in b for b in _page_base_fonts(out_bi))

    @_needs_faces
    def test_bold_on_serif_paragraph_classifies_serif(self, tmp_dir):
        # Style-only: family comes from the member's own font (B1), so a
        # serif paragraph's bold lands on LiberationSerif-Bold.
        srcpdf = pikepdf.new()
        _page(
            srcpdf,
            b"BT /F1 12 Tf 72 700 Td (Serif body to embolden) Tj ET",
            {"/F1": _times(srcpdf)},
        )
        src = os.path.join(tmp_dir, "serif.pdf")
        srcpdf.save(src)
        srcpdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], bold=True, font_path=FONTS_DIR)
        base = _page_base_fonts(out)
        assert any("LiberationSerif-Bold" in b for b in base)

    @_needs_faces
    def test_style_composes_with_family(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Bold mono please) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], family="mono", bold=True, font_path=FONTS_DIR)
        assert any("LiberationMono-Bold" in b for b in _page_base_fonts(out))

    @_needs_faces
    def test_style_degrades_to_regular_when_variant_missing(self, tmp_dir):
        # A sparse bundle (Regular only): the bold request degrades to the
        # family's Regular — face identity beats weight, never a crash.
        import shutil

        sparse = os.path.join(tmp_dir, "sparse-fonts")
        os.makedirs(sparse)
        shutil.copy(FALLBACK_FONT, os.path.join(sparse, "LiberationSans-Regular.ttf"))
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Degrade with grace) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], bold=True, font_path=sparse)
        base = _page_base_fonts(out)
        assert any("LiberationSans" in b for b in base)
        assert not any("Bold" in b for b in base)

    @_needs_faces
    def test_explicit_false_pair_unbolds(self, tmp_dir):
        # The unbold flow: a bold-fonted paragraph, toggles sent as
        # (False, False) — an absolute statement — re-embeds the REGULAR
        # face.
        srcpdf = pikepdf.new()
        _page(
            srcpdf,
            b"BT /F1 12 Tf 72 700 Td (Already bold body text) Tj ET",
            {"/F1": _helv_bold(srcpdf)},
        )
        src = os.path.join(tmp_dir, "bold.pdf")
        srcpdf.save(src)
        srcpdf.close()
        para = _paras(src)[0]
        # The listing seeds the toggle ON from the bold name.
        assert para["bold"] is True
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, para, para["text"], bold=False, italic=False, font_path=FONTS_DIR)
        base = _page_base_fonts(out)
        assert any("LiberationSans" in b for b in base)
        assert not any("LiberationSans-Bold" in b for b in base)

    def test_listing_seeds_default_false(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Plain and upright) Tj ET")
        para = _paras(src)[0]
        assert para["bold"] is False
        assert para["italic"] is False

    def test_listing_seeds_italic_from_descriptor_angle(self, tmp_dir):
        srcpdf = pikepdf.new()
        slanted = srcpdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type1"),
                BaseFont=Name("/Helvetica-Oblique"),
                Encoding=Name("/WinAnsiEncoding"),
                FontDescriptor=srcpdf.make_indirect(
                    Dictionary(Type=Name("/FontDescriptor"), ItalicAngle=-12)
                ),
            )
        )
        _page(
            srcpdf,
            b"BT /F1 12 Tf 72 700 Td (Slanted source text) Tj ET",
            {"/F1": slanted},
        )
        src = os.path.join(tmp_dir, "it.pdf")
        srcpdf.save(src)
        srcpdf.close()
        para = _paras(src)[0]
        assert para["italic"] is True
        assert para["bold"] is False


def _merge(src, out, paragraphs, idx, **kw):
    """Merge listing paragraph idx into idx-1, fingerprints from the listing."""
    from engine.text_paragraphs import merge_paragraph_with_previous

    prev, cur = paragraphs[idx - 1], paragraphs[idx]
    return merge_paragraph_with_previous(
        src, out, 1, idx,
        prev["runs"], prev["text"], cur["runs"], cur["text"], **kw,
    )


class TestSplitMerge:
    """Phase 9.A4 — split (split_at on replace) and merge (new op)."""

    def test_split_relists_as_two_paragraphs(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Alpha beta gamma delta) Tj "
            b"0 -14 Td (epsilon zeta eta theta) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        cut = para["text"].index("epsilon")
        _apply(src, out, para, para["text"], split_at=cut)
        relisted = _paras(out)
        assert len(relisted) == 2
        assert relisted[0]["text"] == "Alpha beta gamma delta"
        assert relisted[1]["text"] == "epsilon zeta eta theta"
        # The gap between the blocks is ~2×leading (14 → 28): each half
        # fits one line here, so the two run tops sit exactly one doubled
        # leading apart.
        runs_out = list_text_paragraphs(out, 1)["runs"]
        tops = sorted({round(r["rect"][3], 1) for r in runs_out}, reverse=True)
        assert len(tops) == 2
        assert (tops[0] - tops[1]) == pytest.approx(28.0, abs=1.5)

    def test_split_single_line_paragraph(self, tmp_dir):
        # leading=None path: gap = 2 × (1.2 × eff) > the 1.6-em join cap.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (One two three four) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        cut = para["text"].index("three")
        _apply(src, out, para, para["text"], split_at=cut)
        relisted = _paras(out)
        assert [p["text"] for p in relisted] == ["One two", "three four"]

    def test_split_composes_with_size(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Grow and split this text) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        cut = para["text"].index("split")
        _apply(src, out, para, para["text"], split_at=cut, size=18)
        relisted = _paras(out)
        assert len(relisted) == 2
        out_runs = list_text_paragraphs(out, 1)["runs"]
        assert any(abs(r["font_size"] - 18) < 0.01 for r in out_runs)

    def test_split_keeps_non_members_unmoved(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Split target words here) Tj "
            b"0 -60 Td (Bystander paragraph stays) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        target = next(p for p in paras if "Split target" in p["text"])
        cut = target["text"].index("words")
        _apply(src, out, target, target["text"], split_at=cut)
        _assert_non_members_unmoved(src, out, target["runs"])

    def test_split_validation_fails_closed(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (No split here) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        for bad in (0, len(para["text"]), -3, "x"):
            with pytest.raises(ValueError, match="split position"):
                _apply(src, out, para, para["text"], split_at=bad)
        assert not os.path.exists(out)

    def test_split_none_is_byte_identical(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Plain edit of the text) Tj ET")
        out_a = os.path.join(tmp_dir, "a.pdf")
        out_b = os.path.join(tmp_dir, "b.pdf")
        para = _paras(src)[0]
        new = para["text"] + " grown"
        _apply(src, out_a, para, new)
        _apply(src, out_b, para, new, split_at=None)
        with pikepdf.open(out_a) as pa, pikepdf.open(out_b) as pb:
            assert pa.pages[0].Contents.read_bytes() == pb.pages[0].Contents.read_bytes()

    def test_merge_joins_into_previous_box(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (First paragraph words) Tj "
            b"0 -60 Td (Second paragraph words) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        assert len(paras) == 2
        _merge(src, out, paras, 1)
        relisted = _paras(out)
        assert len(relisted) == 1
        assert relisted[0]["text"] == "First paragraph words Second paragraph words"
        # Anchored at the PREVIOUS paragraph's first baseline (y=700 →
        # box top ≈ original prev top, not the second's).
        assert relisted[0]["box"][3] == pytest.approx(paras[0]["box"][3], abs=1.0)

    def test_merge_cjk_no_space_join(self, tmp_dir):
        src = os.path.join(tmp_dir, "cjk2.pdf")
        pdf = pikepdf.new()
        mapping = {1: "日", 2: "本", 3: "語", 4: "文"}
        entries = "\n".join(f"<{c:04x}> <{ord(ch):04x}>" for c, ch in mapping.items())
        tounicode = (
            "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
            "1 begincodespacerange <0000> <ffff> endcodespacerange\n"
            f"{len(mapping)} beginbfchar\n{entries}\nendbfchar\n"
            "endcmap end end\n"
        ).encode("ascii")
        desc = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"), Subtype=Name("/CIDFontType2"),
                BaseFont=Name("/AAAAAA+CJK"),
                CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
                DW=1000,
            )
        )
        cid_font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"), Subtype=Name("/Type0"),
                BaseFont=Name("/AAAAAA+CJK"), Encoding=Name("/Identity-H"),
                DescendantFonts=Array([desc]), ToUnicode=pdf.make_stream(tounicode),
            )
        )
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td <00010002> Tj 0 -60 Td <00030004> Tj ET",
            {"/F1": cid_font},
        )
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        assert [p["text"] for p in paras] == ["日本", "語文"]
        _merge(src, out, paras, 1)
        assert _paras(out)[0]["text"] == "日本語文"  # no space at the join

    def test_merge_keeps_non_members_unmoved(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Merge one) Tj "
            b"0 -60 Td (Merge two) Tj "
            b"0 -120 Td (Bystander three) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        assert len(paras) == 3
        _merge(src, out, paras, 1)
        union = sorted(set(paras[0]["runs"]) | set(paras[1]["runs"]))
        _assert_non_members_unmoved(src, out, union)
        assert any("Bystander three" in p["text"] for p in _paras(out))

    def test_merge_first_paragraph_refuses(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Only paragraph) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        from engine.text_paragraphs import merge_paragraph_with_previous

        p0 = _paras(src)[0]
        with pytest.raises(ValueError, match="no previous paragraph"):
            merge_paragraph_with_previous(
                src, out, 1, 0, [], "", p0["runs"], p0["text"]
            )
        assert not os.path.exists(out)

    def test_merge_stale_fingerprint_refuses(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Alpha one) Tj 0 -60 Td (Beta two) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        from engine.text_paragraphs import merge_paragraph_with_previous

        with pytest.raises(ValueError, match="changed underneath"):
            merge_paragraph_with_previous(
                src, out, 1, 1,
                paras[0]["runs"], "stale text", paras[1]["runs"], paras[1]["text"],
            )
        assert not os.path.exists(out)

    def test_split_survives_condensed_leading(self, tmp_dir):
        # Review-caught HIGH: 2×leading alone rejoined GARBLED when
        # leading ≤ 0.8×eff (a single-line first block joins under the
        # 1.6-em cap, not the drift window). The 2×eff floor defeats it.
        src = _build(
            tmp_dir,
            b"BT /F1 10 Tf 72 700 Td (Alpha bb) Tj "
            b"0 -7 Td (Second line words) Tj "
            b"0 -7 Td (Third line words) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        cut = para["text"].index("bb")
        _apply(src, out, para, para["text"], split_at=cut)
        relisted = _paras(out)
        assert [p["text"] for p in relisted] == [
            "Alpha",
            "bb Second line words Third line words",
        ]

    def test_merge_different_scale_refuses(self, tmp_dir):
        # Review-caught: merging across a CTM-scale boundary silently
        # resized cur's text to prev's scale. The lkey guard refuses.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Normal scale text) Tj ET "
            b"q 2 0 0 2 0 0 cm BT /F1 12 Tf 36 300 Td (Double scale text) Tj ET Q",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        assert len(paras) == 2
        with pytest.raises(ValueError, match="different formatting"):
            _merge(src, out, paras, 1)
        assert not os.path.exists(out)

    def test_merge_cross_stream_refuses(self, tmp_dir):
        # prev on the page stream, cur inside a form → different streams.
        src = os.path.join(tmp_dir, "xs.pdf")
        pdf = pikepdf.new()
        helv = _helv(pdf)
        form = pdf.make_stream(b"BT /F1 12 Tf 0 0 Td (Form paragraph words) Tj ET")
        form["/Type"] = Name("/XObject")
        form["/Subtype"] = Name("/Form")
        form["/BBox"] = Array([0, 0, 300, 20])
        form["/Resources"] = Dictionary(Font=Dictionary(F1=_helv(pdf)))
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = Dictionary(
            Font=Dictionary(F1=helv), XObject=Dictionary(Fm1=pdf.make_indirect(form))
        )
        page.Contents = pdf.make_stream(
            b"BT /F1 12 Tf 72 700 Td (Page paragraph words) Tj ET "
            b"q 1 0 0 1 72 600 cm /Fm1 Do Q"
        )
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        assert len(paras) == 2
        with pytest.raises(ValueError, match="different content streams"):
            _merge(src, out, paras, 1)
        assert not os.path.exists(out)


def _vpage(tmp_dir, content: bytes, name="v.pdf", with_helv=False) -> str:
    """A page with /FV = Identity-V あいう at uniform /W2 advance 1000
    (10pt per char at size 10 — the hand-math base), plus /F1 Helvetica
    when a fixture mixes modes."""
    src = os.path.join(tmp_dir, name)
    pdf = pikepdf.new()
    vfont = _identity_v(
        pdf,
        {3: "あ", 4: "い", 5: "う"},
        [3, [-1000, 500, 880, -1000, 500, 880, -1000, 500, 880]],
    )
    fonts = {"/FV": vfont}
    if with_helv:
        fonts["/F1"] = _helv(pdf)
    _page(pdf, content, fonts)
    pdf.save(src)
    pdf.close()
    return src


class TestVerticalParagraphs:
    """Phase 9.B4b — vertical paragraph reflow: one 90° transposition
    T(x, y) = (−y, x) at member admission and T⁻¹ at the emission's Tm
    anchors; every grouping heuristic reused unchanged. Positions are
    HAND-COMPUTED (the round-27 discipline) — a self-consistent
    wrong-axis model passes any walker-vs-walker comparison, so the
    dual-walk harness alone cannot pin the axis."""

    def test_two_column_vertical_paragraph_groups_as_one(self, tmp_dir):
        # Columns at x=300 and x=286 (pitch 14 — the leading analogue),
        # both TOP-aligned at y=700: under T they are two left-aligned
        # lines 14 apart and join into ONE paragraph, read right-to-left
        # (rightmost column first), chars top-to-bottom, CJK no-space
        # line join.
        src = _vpage(
            tmp_dir,
            b"BT /FV 10 Tf 300 700 Td <000300040005> Tj -14 0 Td <00030004> Tj ET",
        )
        paras = _paras(src)
        assert len(paras) == 1
        p = paras[0]
        assert p["text"] == "あいうあい"
        assert p["line_count"] == 2
        assert p["vertical"] is True
        assert p["editable"] is True
        # "left" IS top for vertical (the transposed name is reported
        # as-is; the editor doesn't label alignment).
        assert p["alignment"] == "left"
        # The listing box is the REAL page rect around both columns.
        assert p["box"] == pytest.approx([281, 670, 305, 700], abs=0.05)
        assert p["runs"] == [0, 1]

    def test_vertical_retype_reflows_at_the_measured_pitch(self, tmp_dir):
        src = _vpage(
            tmp_dir,
            b"BT /FV 10 Tf 300 700 Td <000300040005> Tj -14 0 Td <00030004> Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, "いいいいい")
        after = list_text_runs(out, 1)["runs"]
        assert [r["vertical"] for r in after] == [True, True]
        assert [r["text"] for r in after] == ["いいい", "いい"]
        # Hand-computed: the box measure (30 = 3 chars at the /W2
        # advance) refills top-down from x=300, then one measured pitch
        # (14) LEFT at x=286, both columns re-anchored at y=700.
        assert after[0]["rect"] == pytest.approx([295, 670, 305, 700], abs=0.05)
        assert after[1]["rect"] == pytest.approx([281, 680, 291, 700], abs=0.05)
        relisted = _paras(out)
        assert relisted[0]["text"] == "いいいいい"
        assert relisted[0]["vertical"] is True

    def test_vertical_growth_adds_a_column_leftward(self, tmp_dir):
        src = _vpage(
            tmp_dir,
            b"BT /FV 10 Tf 300 700 Td <000300040005> Tj -14 0 Td <00030004> Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        old_leftmost = para["box"][0]
        _apply(src, out, para, "あいうあいうあ")  # 7 chars → columns of 3+3+1
        after = list_text_runs(out, 1)["runs"]
        assert [r["vertical"] for r in after] == [True, True, True]
        assert after[0]["rect"] == pytest.approx([295, 670, 305, 700], abs=0.05)
        assert after[1]["rect"] == pytest.approx([281, 670, 291, 700], abs=0.05)
        # The overflow column lands one pitch further LEFT — growth is
        # leftward, the vertical analogue of downward.
        assert after[2]["rect"] == pytest.approx([267, 690, 277, 700], abs=0.05)
        assert after[2]["rect"][0] < old_leftmost
        relisted = _paras(out)
        assert relisted[0]["text"] == "あいうあいうあ"
        assert relisted[0]["line_count"] == 3

    def test_vertical_reflow_under_scaled_ctm_ignores_tz(self, tmp_dir):
        # cm (2,0,0,4) + 50 Tz: vertical advances scale by d (4) and Tz
        # NEVER applies (spec 9.4.4: Th is tx-only) — an h_scale·a width
        # model would fit 12 chars per column instead of 3. The fixture
        # is the only place a≠d≠h_scale·a, so it is what actually pins
        # the axis choice at every width site.
        src = _vpage(
            tmp_dir,
            b"q 2 0 0 4 0 0 cm BT /FV 10 Tf 50 Tz 150 175 Td <000300040005> Tj"
            b" -7 0 Td <00030004> Tj ET Q",
        )
        para = _paras(src)[0]
        assert para["text"] == "あいうあい"
        assert para["vertical"] is True
        assert para["box"] == pytest.approx([276, 580, 310, 700], abs=0.05)
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, para, "いいいいい")
        after = list_text_runs(out, 1)["runs"]
        assert [r["text"] for r in after] == ["いいい", "いい"]
        # Hand-computed user space: 40pt per char (10 × d), columns at
        # x=300 and one 14pt pitch left at x=286, tops at y=700.
        assert after[0]["rect"] == pytest.approx([290, 580, 310, 700], abs=0.05)
        assert after[1]["rect"] == pytest.approx([276, 620, 296, 700], abs=0.05)

    def test_vertical_word_gap_round_trips_under_scaled_ctm(self, tmp_dir):
        # A TJ word gap (−500 at size 10 → a synthetic space) in the
        # scaled (d=4) + Tz 50 column: the gap must MEASURE and RE-EMIT
        # at the d scale — the gap-median denominator, the synthetic-
        # space width, and the emitted kern number all pin here (an
        # h_scale·a model re-emits the kern 4× too large and the
        # re-listed column's rect stretches accordingly).
        src = _vpage(
            tmp_dir,
            b"q 2 0 0 4 0 0 cm BT /FV 10 Tf 50 Tz 150 175 Td"
            b" [<0003> -500 <0004>] TJ ET Q",
        )
        para = _paras(src)[0]
        assert para["text"] == "あ い"
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, para, "い あ")
        after = list_text_runs(out, 1)["runs"]
        assert len(after) == 1 and after[0]["vertical"]
        # raw advance 10 + 5 (the kern-gap) + 10 = 25 text units → 100
        # user below y=700.
        assert after[0]["rect"] == pytest.approx([290, 600, 310, 700], abs=0.05)
        assert _paras(out)[0]["text"] == "い あ"

    def test_vertical_positioned_gap_between_members_measures_at_d_scale(self, tmp_dir):
        # The INTER-member positioned gap (a Td hop down the same
        # column, under the column-split threshold) is measured by
        # _assemble_text — its 1000ths conversion must also use the d
        # scale. Same scaled+Tz discipline: the wrong axis medians the
        # 5-text-unit gap as 2000 and the re-emitted column stretches.
        src = _vpage(
            tmp_dir,
            b"q 2 0 0 4 0 0 cm BT /FV 10 Tf 50 Tz 150 175 Td <0003> Tj"
            b" 0 -15 Td <0004> Tj ET Q",
        )
        para = _paras(src)[0]
        assert para["text"] == "あ い"
        assert para["line_count"] == 1
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, para, "い あ")
        after = list_text_runs(out, 1)["runs"]
        assert len(after) == 1 and after[0]["vertical"]
        # One column: 10 + 5 (the measured gap, 20 user / d) + 10 text
        # units of descent → 100 user below y=700.
        assert after[0]["rect"] == pytest.approx([290, 600, 310, 700], abs=0.05)
        assert _paras(out)[0]["text"] == "い あ"

    def test_vertical_edit_resyncs_kept_column_at_hand_computed_positions(self, tmp_dir):
        # A Td-anchored block LOWER in the second column (a paragraph
        # gap down the column) is a kept run; the paragraph reflow must
        # leave it at its spec position — asserted against hand-computed
        # numbers, not just the dual-walk property.
        src = _vpage(
            tmp_dir,
            b"BT /FV 10 Tf 300 700 Td <00030004> Tj -14 0 Td <0003> Tj"
            b" 0 -40 Td <00040004> Tj ET",
        )
        paras = _paras(src)
        assert [p["text"] for p in paras] == ["あいあ", "いい"]
        target = paras[0]
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, target, "あいあい")  # 4 chars → 2 per column
        _assert_non_members_unmoved(src, out, target["runs"])
        after = list_text_runs(out, 1)["runs"]
        kept = next(r for r in after if r["text"] == "いい")
        # Hand-computed: the kept block was anchored `0 -40 Td` under
        # the second column's start — absolute (286, 660), 20 down.
        assert kept["rect"] == pytest.approx([281, 640, 291, 660], abs=0.05)
        # The reflowed members: two chars per column at the original
        # column anchors.
        assert after[0]["rect"] == pytest.approx([295, 680, 305, 700], abs=0.05)
        assert after[1]["rect"] == pytest.approx([281, 680, 291, 700], abs=0.05)

    def test_flowing_horizontal_tail_after_vertical_members_keeps_spec_positions(self, tmp_dir):
        # The B4a flowing-tail template, axis-swapped: horizontal runs
        # FLOW (no Td) straight off the vertical members' pen. Editing
        # the vertical paragraph must leave the tail at hand-computed
        # spec positions — the resync's model of the emitted vertical
        # advances is what anchors the injected absolute Tm.
        src = _vpage(
            tmp_dir,
            b"BT /FV 10 Tf 300 700 Td <0003> Tj <0003> Tj"
            b" /F1 12 Tf (Aa) Tj (Bb) Tj ET",
            with_helv=True,
        )
        before = list_text_runs(src, 1)["runs"]
        # Spec: the tail flows at the pen after the column's 20pt
        # descent; Aa and Bb are each 14.676 wide (Helvetica at 12).
        assert before[2]["rect"] == pytest.approx([300, 680, 314.676, 692], abs=0.05)
        assert before[3]["rect"] == pytest.approx([314.676, 680, 329.352, 692], abs=0.05)
        paras = _paras(src)
        target = next(p for p in paras if p["text"] == "ああ")
        assert target["vertical"] is True
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, target, "あああ")  # the column grows 20 → 30
        _assert_non_members_unmoved(src, out, target["runs"])
        after = list_text_runs(out, 1)["runs"]
        got_aa = next(r for r in after if r["text"] == "Aa")
        got_bb = next(r for r in after if r["text"] == "Bb")
        assert got_aa["rect"] == pytest.approx([300, 680, 314.676, 692], abs=0.05)
        assert got_bb["rect"] == pytest.approx([314.676, 680, 329.352, 692], abs=0.05)
        grown = next(r for r in after if r["vertical"])
        assert grown["rect"] == pytest.approx([295, 670, 305, 700], abs=0.05)

    def test_vertical_and_horizontal_never_co_group(self, tmp_dir):
        # A DELIBERATE coordinate collision: the horizontal baseline
        # (y=300, x from 60) and the transposed vertical member (column
        # x=300 topping at y=−60 → x0′=60, y′=300) land in the SAME
        # transposed band — without the mode in the group key they
        # would cluster into one mixed line. The mode key keeps them
        # apart.
        src = _vpage(
            tmp_dir,
            b"BT /F1 12 Tf 60 300 Td (Hmix) Tj ET"
            b" BT /FV 10 Tf 300 -60 Td <0003> Tj ET",
            with_helv=True,
        )
        listing = list_text_paragraphs(src, 1)
        paras = listing["paragraphs"]
        assert len(paras) == 2
        assert {p["text"] for p in paras} == {"Hmix", "あ"}
        runs = listing["runs"]
        for p in paras:
            modes = {runs[i]["vertical"] for i in p["runs"]}
            assert len(modes) == 1  # single-mode paragraphs, always

    def test_split_vertical_paragraph_gap_transposes(self, tmp_dir):
        src = _vpage(
            tmp_dir,
            b"BT /FV 10 Tf 300 700 Td <000300040005> Tj -14 0 Td <00030004> Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], split_at=3)
        relisted = _paras(out)
        assert [p["text"] for p in relisted] == ["あいう", "あい"]
        assert all(p["vertical"] for p in relisted)
        after = list_text_runs(out, 1)["runs"]
        # The A4 split gap TRANSPOSES: block B's column starts one
        # split gap (max(2×leading, 2×eff) = 28) LEFT of block A's —
        # a gap the re-listing grouping can never join across.
        assert after[0]["rect"] == pytest.approx([295, 670, 305, 700], abs=0.05)
        assert after[1]["rect"] == pytest.approx([267, 680, 277, 700], abs=0.05)

    def test_merge_two_vertical_paragraphs_reflows_in_prev_column(self, tmp_dir):
        # Two single-column vertical paragraphs 28 apart (a paragraph
        # gap); the merge re-lays the CJK-joined text out from the
        # PREVIOUS (rightmost) paragraph's anchor — one column, since a
        # single-column paragraph's measure extends to the mirrored
        # bottom margin (the single-line rule, transposed).
        src = _vpage(
            tmp_dir,
            b"BT /FV 10 Tf 300 700 Td <000300040005> Tj -28 0 Td <00030004> Tj ET",
        )
        paras = _paras(src)
        assert [p["text"] for p in paras] == ["あいう", "あい"]
        out = os.path.join(tmp_dir, "o.pdf")
        _merge(src, out, paras, 1)
        relisted = _paras(out)
        assert len(relisted) == 1
        assert relisted[0]["text"] == "あいうあい"  # no space at the join
        after = list_text_runs(out, 1)["runs"]
        # Style continuity keeps one show per source paragraph — both
        # flow contiguously down ONE 50pt column from prev's anchor
        # (the second segment's dx untransposes to a further descent).
        assert [r["vertical"] for r in after] == [True, True]
        assert after[0]["rect"] == pytest.approx([295, 670, 305, 700], abs=0.05)
        assert after[1]["rect"] == pytest.approx([295, 650, 305, 670], abs=0.05)

    def test_merge_across_writing_modes_refuses(self, tmp_dir):
        src = _vpage(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Top words) Tj ET"
            b" BT /FV 10 Tf 300 680 Td <00030004> Tj ET",
            with_helv=True,
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        assert len(paras) == 2
        assert [p["vertical"] for p in paras] == [False, True]
        # FREE refusal: the writing mode rides in lkey, so the existing
        # different-formatting guard fires with no mode-specific code.
        with pytest.raises(ValueError, match="different formatting"):
            _merge(src, out, paras, 1)
        assert not os.path.exists(out)

    def test_substitution_and_convert_refuse_on_vertical(self, tmp_dir):
        # The Liberation faces are horizontal — family/bold/italic
        # substitution refuses outright, and the convert=True per-char
        # fallback fails closed the same way (the B4a rule). Both fire
        # before any font file is touched, so no faces guard is needed.
        src = _vpage(tmp_dir, b"BT /FV 10 Tf 300 700 Td <00030004> Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        for kw in ({"family": "serif"}, {"bold": True}, {"italic": True}):
            with pytest.raises(ValueError, match="vertical text cannot substitute"):
                _apply(src, out, para, para["text"], font_path=FONTS_DIR, **kw)
        with pytest.raises(ValueError, match="vertical text cannot be converted"):
            _apply(src, out, para, para["text"] + "Z", convert=True, font_path=FONTS_DIR)
        assert not os.path.exists(out)

    def test_transposition_round_trip_on_member_geometry(self, tmp_dir):
        # T(x, y) = (−y, x) / T⁻¹(x′, y′) = (y′, −x′): an inverse pair,
        # and the admitted member's transposed fields map back exactly
        # to the run's REAL pen geometry.
        def t(x, y):
            return (-y, x)

        def t_inv(x, y):
            return (y, -x)

        for x, y in [(0, 0), (300, 700), (-14, 40), (612.5, -792.25)]:
            assert t_inv(*t(x, y)) == (x, y)
            assert t(*t_inv(x, y)) == (x, y)

        from engine.text_paragraphs import _members_from

        src = _vpage(
            tmp_dir,
            b"BT /FV 10 Tf 300 700 Td <000300040005> Tj -14 0 Td <00030004> Tj ET",
        )
        with pikepdf.open(src) as pdf:
            p = pdf.pages[0]
            resources = _resolve_resources(p)
            runs: list = []
            det: list = []
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
            members = _members_from(runs, det)
            assert len(members) == 2
            for m, d in zip(members, det):
                a, _b, _c, dd, e, f = d["combined"]
                assert m.vertical is True
                assert m.lkey[-1] is True  # the mode rides IN lkey
                # T maps the real pen (e, f) to the transposed anchor…
                assert (m.x0, m.y) == pytest.approx(t(e, f))
                # …and T⁻¹ recovers it exactly.
                assert t_inv(m.x0, m.y) == pytest.approx((e, f))
                # The advance maps to +x′ at the d scale; eff is the
                # column axis (size × a).
                assert m.x1 - m.x0 == pytest.approx(d["raw_width"] * dd)
                assert m.eff == pytest.approx(d["style"]["size"] * a)

        # A NON-UNIFORM ctm (a=2, d=4) + Tz 50 pins every axis choice
        # numerically: the advance and space width scale by d (never
        # h_scale·a), eff by a (the column axis).
        ssrc = _vpage(
            tmp_dir,
            b"q 2 0 0 4 0 0 cm BT /FV 10 Tf 50 Tz 150 175 Td <000300040005> Tj ET Q",
            name="scaled.pdf",
        )
        with pikepdf.open(ssrc) as pdf:
            p = pdf.pages[0]
            resources = _resolve_resources(p)
            runs = []
            det = []
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
            m = _members_from(runs, det)[0]
            assert (m.x0, m.y) == pytest.approx((-700.0, 300.0))
            assert m.x1 - m.x0 == pytest.approx(30 * 4.0)  # raw × d
            assert m.eff == pytest.approx(10 * 2.0)  # size × a
            assert m.space_w == pytest.approx(250 / 1000 * 10 * 4.0)  # d, no Tz

        # The horizontal guard: byte-identical construction, mode False
        # in the lkey tail.
        hsrc = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Hz) Tj ET")
        with pikepdf.open(hsrc) as pdf:
            p = pdf.pages[0]
            resources = _resolve_resources(p)
            runs = []
            det = []
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
            members = _members_from(runs, det)
            assert members[0].vertical is False
            assert members[0].lkey[-1] is False
            assert (members[0].x0, members[0].y) == pytest.approx((72, 700))

    def test_vertical_rise_attach_refuses_to_edit(self, tmp_dir):
        # Round 28 HIGH: a markedly-smaller vertical run BESIDE a column
        # rise-attaches (the shipped superscript heuristic, mode-blind),
        # and its rise_user then carries a REAL-X displacement — which Ts
        # (a real-Y displacement for vertical text) structurally cannot
        # express, so an edit silently restacked the small run INTO the
        # column. Fail closed: the paragraph refuses with a stated
        # reason; the runs stay on the 7.2 surface.
        # Attach math (ctm 2/4): main eff 10·2=20, small at real x 304 vs
        # 300 → transposed-y offset 4 ≤ 0.5·20 and 6 ≤ 0.8·20 → attaches;
        # rise 4 ≥ 0.05·20 → nonzero.
        src = os.path.join(tmp_dir, "vrise.pdf")
        pdf = pikepdf.new()
        vfont = _identity_v(
            pdf, {3: "あ", 4: "い"}, [3, [-1000, 500, 880, -1000, 500, 880]]
        )
        _page(
            pdf,
            b"q 2 0 0 4 0 0 cm BT /FV 10 Tf 150 175 Td <0003> Tj "
            b"/FV 3 Tf 2 0 Td <0004> Tj ET Q",
            {"/FV": vfont},
        )
        pdf.save(src)
        pdf.close()
        paras = _paras(src)
        assert len(paras) == 1
        p = paras[0]
        assert p["vertical"] is True
        assert p["editable"] is False
        assert p["reason"] == "vertical text with raised characters does not reflow"
        runs = list_text_runs(src, 1)["runs"]
        assert [r["vertical"] for r in runs] == [True, True]
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="raised characters"):
            replace_paragraph_text(
                src, out, 1, p["index"], p["text"], p["spans"], p["runs"], p["text"]
            )
        assert not os.path.exists(out)

    def test_mixed_page_lists_in_reading_order(self, tmp_dir):
        # Round 28 MEDIUM: the sort key compared real Y (horizontal)
        # against real X (vertical) — a mid-page vertical column at high
        # x outsorted the page-top header. The key is now the box top
        # (real-page space in both modes), per-mode tiebreak.
        src = os.path.join(tmp_dir, "mixed.pdf")
        pdf = pikepdf.new()
        vfont = _identity_v(
            pdf, {3: "あ", 4: "い"}, [3, [-1000, 500, 880, -1000, 500, 880]]
        )
        _page(
            pdf,
            # The column's real X (600) must EXCEED the header's real Y
            # (500) — that inversion is what the old key misordered; a
            # column-x between the two y's sorts the same under both keys
            # (first draft was mutation-invisible exactly that way).
            b"BT /F1 12 Tf 72 500 Td (Header text here) Tj ET "
            b"BT /FV 10 Tf 600 400 Td <00030004> Tj ET "
            b"BT /F1 12 Tf 72 100 Td (Footer text here) Tj ET",
            {"/F1": _helv(pdf), "/FV": vfont},
        )
        pdf.save(src)
        pdf.close()
        paras = _paras(src)
        assert [p["text"] for p in paras] == ["Header text here", "あい", "Footer text here"]
        assert [p["vertical"] for p in paras] == [False, True, False]
        assert [p["index"] for p in paras] == [0, 1, 2]


class TestLigatureParagraphs:
    """9.B5 paragraph path: atomic ligature entries — the commit accepts
    what the run editor and the live validation accept, at agreeing
    widths (the sub-flagged accept/refuse mismatch + width drift)."""

    def _lig_font(self, pdf):
        # Simple TrueType: 'a','b','f' singles + code 0x4C → "fi" (the
        # ligature); 'i' is reachable ONLY through the sequence.
        entries = {0x61: "a", 0x62: "b", 0x66: "f", 0x4C: "fi"}
        lines = "\n".join(
            f"<{c:02x}> <{''.join(f'{ord(u):04x}' for u in t)}>" for c, t in entries.items()
        )
        tou = (
            "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
            "1 begincodespacerange <00> <ff> endcodespacerange\n"
            f"{len(entries)} beginbfchar\n{lines}\nendbfchar\n"
            "endcmap end end\n"
        ).encode("ascii")
        return pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/TrueType"),
                BaseFont=Name("/LigPara"),
                FontDescriptor=pdf.make_indirect(
                    Dictionary(Type=Name("/FontDescriptor"), Flags=4)
                ),
                ToUnicode=pdf.make_stream(tou),
            )
        )

    def _build_lig(self, tmp_dir, content):
        src = os.path.join(tmp_dir, "lig.pdf")
        pdf = pikepdf.new()
        _page(pdf, content, {"/F1": self._lig_font(pdf)})
        pdf.save(src)
        pdf.close()
        return src

    def test_paragraph_edit_round_trips_a_ligature_only_char(self, tmp_dir):
        # The document shows "afib" via the lig code; the paragraph edit
        # re-types it — 'i' is sequence-only, so pre-fix this REFUSED
        # while the run editor accepted (the mismatch).
        src = self._build_lig(tmp_dir, b"BT /F1 12 Tf 72 700 Td (aLb) Tj ET")
        para = _paras(src)[0]
        assert para["text"] == "afib"
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, para, "afib ba")
        relisted = _paras(out)
        assert relisted[0]["text"] == "afib ba"
        # The emitted bytes carry the LIGATURE code, not f+i singles
        # (which don't exist for 'i' — encode round-trips the sequence).
        with pikepdf.open(out) as pdf2:
            raw = pikepdf.unparse_content_stream(pikepdf.parse_content_stream(pdf2.pages[0]))
        assert b"L" in raw

    def test_ligature_edit_keeps_siblings_unmoved(self, tmp_dir):
        # Width agreement end to end: the resync property under ligature
        # emission (the sub-flagged drift would move the sibling).
        src = self._build_lig(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (aLb) Tj 0 -60 Td (ab ba) Tj ET",
        )
        paras = _paras(src)
        target = next(p for p in paras if "fi" in p["text"])
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, target, target["text"] + " ab")
        _assert_non_members_unmoved(src, out, target["runs"])

    def test_noncoalesced_same_run_spans_never_form_a_cross_entry_ligature(self, tmp_dir):
        # Review-caught HIGH (round 26): the joined-buffer re-encode could
        # ligature-match ACROSS styled-entry boundaries — 'f','i' arriving
        # as separate single entries (adjacent same-run spans, widths
        # summed as singles) emitted as the LIG code (4.2pt drift repro,
        # success result). The shipped renderer coalesces such spans, but
        # the ENGINE must hold for any caller: per-entry encode keeps
        # bytes ≡ widths. Font: 'f','i' singles AND a "fi" ligature.
        src = os.path.join(tmp_dir, "lig2.pdf")
        pdf = pikepdf.new()
        entries = {0x66: "f", 0x69: "i", 0x4C: "fi", 0x61: "a"}
        lines = "\n".join(
            f"<{c:02x}> <{''.join(f'{ord(u):04x}' for u in t)}>" for c, t in entries.items()
        )
        tou = (
            "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
            "1 begincodespacerange <00> <ff> endcodespacerange\n"
            f"{len(entries)} beginbfchar\n{lines}\nendbfchar\n"
            "endcmap end end\n"
        ).encode("ascii")
        font = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/TrueType"),
                BaseFont=Name("/LigBoth"),
                FontDescriptor=pdf.make_indirect(
                    Dictionary(Type=Name("/FontDescriptor"), Flags=4)
                ),
                ToUnicode=pdf.make_stream(tou),
            )
        )
        _page(pdf, b"BT /F1 12 Tf 72 700 Td (fa) Tj ET", {"/F1": font})
        pdf.save(src)
        pdf.close()
        para = _paras(src)[0]
        assert para["text"] == "fa"
        out = os.path.join(tmp_dir, "o.pdf")
        run = para["runs"][0]
        # Hand-split spans: 'f' and 'i' as SEPARATE same-run spans — the
        # non-conforming caller shape (the renderer coalesces these).
        spans = [
            {"start": 0, "end": 1, "run": run},
            {"start": 1, "end": 2, "run": run},
            {"start": 2, "end": 3, "run": run},
        ]
        _apply(src, out, para, "fia", spans=spans)
        with pikepdf.open(out) as pdf2:
            raw = pikepdf.unparse_content_stream(pikepdf.parse_content_stream(pdf2.pages[0]))
        # Bytes must be the TWO SINGLES (f i) + a — matching the summed
        # widths — NEVER the cross-boundary lig code 0x4C.
        assert b"fia" in raw
        assert b"\x4c" not in raw.replace(b"/LigBoth", b"")

    def test_family_swap_of_ligature_text_uses_liberation_singles(self, tmp_dir):
        # force_fallback ignores sequences: Liberation encodes f and i as
        # separate glyphs — the substitution path stays sequence-free.
        if not (os.path.isfile(FALLBACK_FONT)):
            pytest.skip("fallback faces not provisioned")
        src = self._build_lig(tmp_dir, b"BT /F1 12 Tf 72 700 Td (aLb) Tj ET")
        para = _paras(src)[0]
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, para, para["text"], family="sans", font_path=FONTS_DIR)
        assert _paras(out)[0]["text"] == "afib"


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

def _content_bytes(path):
    with pikepdf.open(path) as pdf:
        c = pdf.pages[0].obj.get("/Contents")
        if isinstance(c, pikepdf.Array):
            return b"".join(bytes(x.read_bytes()) for x in c)
        return bytes(c.read_bytes())


def _color_ops(path):
    """The (op, args) stream filtered to fill-colour + show ops — enough to
    read the per-segment colour sequence."""
    with pikepdf.open(path) as pdf:
        return [
            (str(i.operator), [str(x) for x in i.operands])
            for i in pikepdf.parse_content_stream(pdf.pages[0])
            if str(i.operator) in ("rg", "g", "k", "Tj", "TJ")
        ]


class TestPerSpanColor:
    """Phase 9.A5a — per-span colour: recolour a character RANGE inside a
    paragraph, distinct from the whole-paragraph A1 colour. The emission is
    already per-segment; the override just becomes per-code-point."""

    def test_recolours_a_middle_range_and_resets_after(self, tmp_dir):
        # "Hello colored world" — recolour [6,13) ("colored") red. The
        # surrounding text stays default black, and CRUCIALLY the trailing
        # " world" emits an explicit reset so the red can't bleed forward.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Hello colored world) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        _apply(src, out, p, p["text"], span_styles=[{"start": 6, "end": 13, "color": [1.0, 0.0, 0.0]}])
        ops = _color_ops(out)
        # Three shows, the middle one red, flanked by explicit black resets.
        shows = [(op, args) for op, args in ops]
        assert ("Tj", ["Hello "]) in shows
        assert ("rg", ["1", "0", "0"]) in [o for o in ops]
        # After the red show there is a `0 g` before " world" (no bleed).
        red_i = next(i for i, (op, a) in enumerate(ops) if op == "rg")
        world_i = next(i for i, (op, a) in enumerate(ops) if op == "Tj" and a == [" world"])
        assert any(op == "g" and a == ["0"] for op, a in ops[red_i + 1 : world_i + 1])

    def test_no_span_styles_is_byte_identical(self, tmp_dir):
        # The pin: an edit with span_styles=None (or absent) is byte-for-byte
        # the shipped path — per-span colour touches nothing when unused.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Plain reword here) Tj ET")
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        p = _paras(src)[0]
        _apply(src, a, p, p["text"])
        _apply(src, b, p, p["text"], span_styles=None)
        assert _content_bytes(a) == _content_bytes(b)

    def test_surrounding_text_matches_a_plain_edit(self, tmp_dir):
        # Recolouring the middle must not perturb the flanking runs' bytes:
        # the show ops for "Hello " and " world" are identical to a plain
        # reword (colour is metric-neutral — same Tm, same widths).
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Hello colored world) Tj ET")
        plain = os.path.join(tmp_dir, "plain.pdf")
        colored = os.path.join(tmp_dir, "colored.pdf")
        p = _paras(src)[0]
        _apply(src, plain, p, p["text"])
        _apply(src, colored, p, p["text"], span_styles=[{"start": 6, "end": 13, "color": [1.0, 0.0, 0.0]}])

        def tms(path):
            with pikepdf.open(path) as pdf:
                return [
                    [str(x) for x in i.operands]
                    for i in pikepdf.parse_content_stream(pdf.pages[0])
                    if str(i.operator) == "Tm"
                ]

        # Plain lays ONE segment (one Tm); coloured splits into THREE (a Tm
        # per colour segment). The start doesn't move, and the three segment
        # anchors flow strictly left-to-right — the recolour split the line
        # without perturbing the layout (colour is metric-neutral).
        p_tm, c_tm = tms(plain), tms(colored)
        assert len(p_tm) == 1 and len(c_tm) == 3
        assert c_tm[0] == p_tm[0]
        xs = [float(t[4]) for t in c_tm]
        assert xs[0] < xs[1] < xs[2]

    def test_multi_range_sparse(self, tmp_dir):
        # Two disjoint recoloured ranges; the gap between stays default.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (alpha beta gamma delta) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        _apply(src, out, p, p["text"], span_styles=[
            {"start": 0, "end": 5, "color": [1.0, 0.0, 0.0]},   # alpha red
            {"start": 11, "end": 16, "color": [0.0, 0.0, 1.0]},  # gamma blue
        ])
        ops = _color_ops(out)
        assert any(op == "rg" and a == ["1", "0", "0"] for op, a in ops)
        assert any(op == "rg" and a == ["0", "0", "1"] for op, a in ops)

    def test_range_splits_a_run_boundary(self, tmp_dir):
        # A colour range that straddles TWO style-source runs (spanning the
        # boundary) recolours across it — the override is independent of the
        # run/span structure.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (first ) Tj /F1 12 Tf (second) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        assert p["text"] == "first second"
        # Recolour [3,9) — spans the "st sec" straddle of the run boundary.
        _apply(src, out, p, p["text"], p["spans"], span_styles=[{"start": 3, "end": 9, "color": [0.0, 0.5, 0.0]}])
        ops = _color_ops(out)
        assert any(op == "rg" and a == ["0", "0.5", "0"] for op, a in ops)

    def test_composes_with_a1_size(self, tmp_dir):
        # Per-span colour AND an A1 whole-paragraph size change together:
        # size applies uniformly, colour to the range.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Hello colored world) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        _apply(src, out, p, p["text"], size=18.0, span_styles=[{"start": 6, "end": 13, "color": [1.0, 0.0, 0.0]}])
        with pikepdf.open(out) as pdf:
            ops = [(str(i.operator), [str(x) for x in i.operands]) for i in pikepdf.parse_content_stream(pdf.pages[0])]
        # Every Tf carries size 18; a red rg appears.
        tf_sizes = {a[1] for op, a in ops if op == "Tf"}
        assert tf_sizes == {"18"}
        assert any(op == "rg" and a == ["1", "0", "0"] for op, a in ops)

    def test_listing_exposes_per_span_colour(self, tmp_dir):
        # The additive seed: each span carries its member's fill colour hex.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Black ) Tj 1 0 0 rg (red) Tj ET",
        )
        p = _paras(src)[0]
        colors = [sp.get("color") for sp in p["spans"]]
        assert "#000000" in colors
        assert "#ff0000" in colors

    def test_out_of_bounds_range_refuses(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (short) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        with pytest.raises(ValueError, match="out of bounds"):
            _apply(src, out, p, p["text"], span_styles=[{"start": 0, "end": 999, "color": [1.0, 0.0, 0.0]}])
        with pytest.raises(ValueError, match=r"\[r, g, b\]"):
            _apply(src, out, p, p["text"], span_styles=[{"start": 0, "end": 3, "color": [1.0, 0.0]}])


class TestPerSpanDisplaySeeds:
    """Phase 9.A5-tails-a — the listing's per-span DISPLAY seeds (weight,
    slant, family, size), so a reopened editor can SHOW genuinely mixed
    per-span styling instead of starting blank.

    These are display-only by contract: the renderer keeps them apart from
    user overrides and never sends them back. A face entry SUBSTITUTES its
    range into a bundled face, so re-sending a seed would silently replace
    the document's own foundry font on any commit — which is exactly why
    the A5b round shipped with no seed at all."""

    def test_mixed_face_paragraph_seeds_each_span(self, tmp_dir):
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (Plain ) Tj /F2 12 Tf (bold) Tj ET",
            {"/F1": _helv(pdf), "/F2": _helv_bold(pdf)},
        )
        src = os.path.join(tmp_dir, "mixed.pdf")
        pdf.save(src)
        pdf.close()
        para = _paras(src)[0]
        by_bold = {sp.get("bold") for sp in para["spans"]}
        # The paragraph genuinely mixes weights, so BOTH seeds appear.
        assert by_bold == {False, True}
        # And the span carrying the bold run is the later one.
        bold_spans = [sp for sp in para["spans"] if sp.get("bold")]
        assert bold_spans and bold_spans[0]["start"] >= len("Plain ") - 1

    def test_uniform_paragraph_never_false_mixes(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (All one face here) Tj ET")
        para = _paras(src)[0]
        assert {sp.get("bold") for sp in para["spans"]} == {False}
        assert {sp.get("italic") for sp in para["spans"]} == {False}
        # One size across the paragraph: the seed agrees with the A1 seed.
        assert {sp.get("size") for sp in para["spans"]} == {para["font_size"]}

    def test_mixed_size_paragraph_seeds_per_span_size(self, tmp_dir):
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (small ) Tj /F1 24 Tf (BIG) Tj ET",
        )
        para = _paras(src)[0]
        sizes = {sp.get("size") for sp in para["spans"]}
        assert 12.0 in sizes and 24.0 in sizes

    def test_family_seed_names_the_members_own_family(self, tmp_dir):
        # A serif member seeds 'serif' — it NAMES what the span already is,
        # it is not a substitution request.
        pdf = pikepdf.new()
        times = pdf.make_indirect(
            Dictionary(
                Type=Name("/Font"),
                Subtype=Name("/Type1"),
                BaseFont=Name("/Times-Roman"),
                Encoding=Name("/WinAnsiEncoding"),
            )
        )
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (Sans ) Tj /F2 12 Tf (serif) Tj ET",
            {"/F1": _helv(pdf), "/F2": times},
        )
        src = os.path.join(tmp_dir, "fam.pdf")
        pdf.save(src)
        pdf.close()
        para = _paras(src)[0]
        fams = {sp.get("family") for sp in para["spans"]}
        assert "serif" in fams and "sans" in fams


class TestPerSpanFace:
    """Phase 9.A5b — per-span bold/italic/family: substitute just a
    character RANGE into a bundled Liberation face. Generalizes the single
    fallback subset (A5a/A3) to one subset per distinct requested face; the
    whole-paragraph A3 path is the single-face special case (proven
    byte-identical vs HEAD out-of-suite; the ONE-subset shape is pinned by
    test_a3_only_path_embeds_exactly_one_subset here)."""

    @_needs_faces
    def test_per_span_bold_embeds_bold_face_for_just_the_range(self, tmp_dir):
        # Bold [5,9) ("this"); the range embeds a -Bold subset, the rest
        # keeps the member's own font (Helvetica), and it round-trips as
        # ONE editable paragraph with the same text.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Make this word plain) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        assert p["text"] == "Make this word plain"
        assert p["text"][5:9] == "this"  # hand-verified range
        _apply(src, out, p, p["text"], font_path=FONTS_DIR,
               span_styles=[{"start": 5, "end": 9, "bold": True}])
        base = _page_base_fonts(out)
        assert any("LiberationSans-Bold" in b for b in base)  # the styled subset…
        assert any("Helvetica" in b for b in base)            # …the member font for the rest
        assert len(_fallback_font_names(out)) == 1
        relisted = _paras(out)
        assert relisted[0]["text"] == p["text"]
        assert relisted[0]["editable"] is True

    @_needs_faces
    def test_implicit_family_keeps_each_members_own_family(self, tmp_dir):
        # Round-33 HIGH: a per-span bold with NO explicit family must take the
        # BOLDED char's OWN member family — not the paragraph's first member.
        # "Hello " is Times (serif, member 0); "World" is Courier (mono,
        # member 1). Bolding "World" alone must embed LiberationMONO-Bold,
        # never LiberationSerif-Bold.
        src = os.path.join(tmp_dir, "mix.pdf")
        pdf = pikepdf.new()
        times = pdf.make_indirect(Dictionary(
            Type=Name("/Font"), Subtype=Name("/Type1"),
            BaseFont=Name("/Times-Roman"), Encoding=Name("/WinAnsiEncoding")))
        cour = pdf.make_indirect(Dictionary(
            Type=Name("/Font"), Subtype=Name("/Type1"),
            BaseFont=Name("/Courier"), Encoding=Name("/WinAnsiEncoding")))
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = Dictionary(Font=Dictionary(F1=times, F2=cour))
        page.Contents = pdf.make_stream(
            b"BT /F1 12 Tf 72 700 Td (Hello ) Tj /F2 12 Tf (World) Tj ET")
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        assert p["text"] == "Hello World"
        _apply(src, out, p, p["text"], p["spans"], font_path=FONTS_DIR,
               span_styles=[{"start": 6, "end": 11, "bold": True}])
        base = _page_base_fonts(out)
        assert any("LiberationMono-Bold" in b for b in base), base
        assert not any("LiberationSerif" in b for b in base), base

    @_needs_faces
    def test_two_distinct_faces_embed_two_subsets(self, tmp_dir):
        # A serif-bold range AND a mono range in one paragraph → two DISTINCT
        # Liberation subsets embedded, each its own registered /EditFb font.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (alpha beta gamma delta) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        assert p["text"] == "alpha beta gamma delta"
        assert p["text"][0:5] == "alpha" and p["text"][11:16] == "gamma"
        _apply(src, out, p, p["text"], font_path=FONTS_DIR, span_styles=[
            {"start": 0, "end": 5, "family": "serif", "bold": True},   # alpha → serif bold
            {"start": 11, "end": 16, "family": "mono"},                 # gamma → mono regular
        ])
        base = _page_base_fonts(out)
        assert any("LiberationSerif-Bold" in b for b in base)
        assert any("LiberationMono" in b for b in base)
        assert len(_fallback_font_names(out)) == 2  # two distinct subsets

    @_needs_faces
    def test_per_span_face_composes_with_colour_and_size(self, tmp_dir):
        # One range bold AND red, PLUS an A1 whole-paragraph size bump: the
        # bold subset embeds, the range emits red, every Tf carries the new
        # size (member and subset alike).
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Hello colored world) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        assert p["text"][6:13] == "colored"
        _apply(src, out, p, p["text"], size=18.0, font_path=FONTS_DIR,
               span_styles=[{"start": 6, "end": 13, "bold": True, "color": [1.0, 0.0, 0.0]}])
        assert any("LiberationSans-Bold" in b for b in _page_base_fonts(out))
        with pikepdf.open(out) as pdf:
            ops = [(str(i.operator), [str(x) for x in i.operands])
                   for i in pikepdf.parse_content_stream(pdf.pages[0])]
        assert any(op == "rg" and a == ["1", "0", "0"] for op, a in ops)  # the range is red
        assert {a[1] for op, a in ops if op == "Tf"} == {"18"}  # size reached every Tf

    @_needs_faces
    def test_a3_only_path_embeds_exactly_one_subset(self, tmp_dir):
        # The in-suite proxy for the byte-identity gate: a whole-paragraph A3
        # swap (NO per-span faces) resolves to EXACTLY ONE subset with the
        # expected BaseFont — the shipped single-face shape, unchanged.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Whole paragraph swap) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        _apply(src, out, p, p["text"], family="serif", font_path=FONTS_DIR)
        assert len(_fallback_font_names(out)) == 1
        assert any("LiberationSerif" in b for b in _page_base_fonts(out))

    @_needs_faces
    def test_colour_only_span_styles_embeds_no_subset(self, tmp_dir):
        # The no-face path: colour-only span_styles substitute NOTHING, so
        # the fallback subset count stays zero (A5a's world, unchanged).
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Hello colored world) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        _apply(src, out, p, p["text"], font_path=FONTS_DIR,
               span_styles=[{"start": 6, "end": 13, "color": [1.0, 0.0, 0.0]}])
        assert len(_fallback_font_names(out)) == 0
        assert not any("Liberation" in b for b in _page_base_fonts(out))

    @_needs_faces
    def test_per_span_substitution_of_missing_char_refuses(self, tmp_dir):
        # A per-span face on a char the Liberation face lacks (CJK) refuses
        # with the stated coverage reason — the A3 boundary, now per-span.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Hello world) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        new = "Hello 你 world"
        assert new[6] == "你"  # hand-verified position
        spans = [{"start": 0, "end": len(new), "run": p["runs"][0]}]
        with pytest.raises(ValueError, match="cannot express"):
            _apply(src, out, p, new, spans, font_path=FONTS_DIR,
                   span_styles=[{"start": 6, "end": 7, "bold": True}])

    @_needs_faces
    def test_per_span_face_keeps_other_paragraphs_unmoved(self, tmp_dir):
        # The resync property at A5b scope: a per-span substitution (which
        # interleaves subset + member Tf switches) must leave every other
        # show op at an identical matrix + state (the dual-walk harness).
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (Bold one word here) Tj "
            b"0 -60 Td (This one stays untouched) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(src)
        assert len(paras) == 2
        target = next(p for p in paras if "Bold one" in p["text"])
        assert target["text"][5:8] == "one"
        _apply(src, out, target, target["text"], font_path=FONTS_DIR,
               span_styles=[{"start": 5, "end": 8, "bold": True}])
        _assert_non_members_unmoved(src, out, target["runs"])
        assert any("This one stays untouched" in p["text"] for p in _paras(out))

    def test_span_style_needs_a_colour_or_a_face(self, tmp_dir):
        # A span_styles entry that sets none of colour, face, or size (9.A5c
        # widened the axis set) is malformed — refuse loudly, not silent
        # no-op.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Whatever text here) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        with pytest.raises(ValueError, match="colour, a face, or a size"):
            _apply(src, out, p, p["text"], font_path=FONTS_DIR,
                   span_styles=[{"start": 0, "end": 4}])

    def test_invalid_span_face_family_refuses(self, tmp_dir):
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Whatever text here) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        with pytest.raises(ValueError, match="family must be"):
            _apply(src, out, p, p["text"], font_path=FONTS_DIR,
                   span_styles=[{"start": 0, "end": 4, "family": "cursive"}])


def _seg_tfs(path):
    """[(seg_text, Tf_size)] in stream order — the font size active at each
    show op, so a per-segment size split is readable directly."""
    out = []
    with pikepdf.open(path) as pdf:
        cur = None
        for i in pikepdf.parse_content_stream(pdf.pages[0]):
            op = str(i.operator)
            if op == "Tf":
                cur = float(i.operands[1])
            elif op == "Tj":
                out.append((bytes(i.operands[0]), cur))
            elif op == "TJ":
                txt = b"".join(bytes(e) for e in i.operands[0] if isinstance(e, pikepdf.String))
                out.append((txt, cur))
    return out


def _tm_ys(path):
    """Distinct emission baselines (each Tm's f-component) in stream order —
    one per laid-out line. The direct measure of the reflow's line rhythm
    (the re-listing's grouping collapses unreliably around a big glyph)."""
    ys, cy, seen = [], None, []
    with pikepdf.open(path) as pdf:
        for i in pikepdf.parse_content_stream(pdf.pages[0]):
            op = str(i.operator)
            if op == "Tm":
                cy = round(float(i.operands[5]), 4)
            elif op in ("Tj", "TJ") and cy is not None:
                ys.append(cy)
    for y in ys:
        if y not in seen:
            seen.append(y)
    return seen


# The A5c per-line-leading fixture: four ONE-word lines at 12pt, baselines
# 700/686/672/658 (14pt leading), each word alone on its line (the box is one
# word wide, so a re-emit keeps one per line). Bumping a middle word's size
# makes THAT line taller by the adjacent-max rule.
_FOURLINE = (
    b"BT /F1 12 Tf 72 700 Td (alpha) Tj 0 -14 Td (bravo) Tj "
    b"0 -14 Td (gamma) Tj 0 -14 Td (delta) Tj ET"
)


class TestPerSpanSize:
    """Phase 9.A5c — per-span SIZE: resize a character RANGE inside a
    paragraph, overriding the A1 whole-paragraph size. The range's Tf grows,
    its width/wrap follow, and the LINE it lands on gets tallest-glyph
    leading via the adjacent-max rule while other lines keep theirs. No
    per-span size ⇒ byte-identical to the shipped (uniform-leading) path."""

    def test_bigger_size_widens_range_and_adds_line_leading(self, tmp_dir):
        # THE crux. Bump "bravo" (line 1, chars [6,11)) to 24pt. Only that
        # segment emits a 24pt Tf; the LINE it lands on and the one below it
        # gain leading while the two normal lines below keep 14pt.
        #   base_ratio = para.leading / dom_eff_orig = 14 / 12 = 7/6
        #   max_eff    = [12, 24, 12, 12]
        #   line0.y = 700
        #   line1.y = 700 - max(12,24)·7/6 = 700 - 28 = 672
        #   line2.y = 672 - max(24,12)·7/6 = 672 - 28 = 644  (bravo descenders)
        #   line3.y = 644 - max(12,12)·7/6 = 644 - 14 = 630  (OTHERS keep 14)
        src = _build(tmp_dir, _FOURLINE)
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        assert p["text"] == "alpha bravo gamma delta"
        assert p["line_count"] == 4
        assert p["text"][6:11] == "bravo"  # hand-verified range
        _apply(src, out, p, p["text"], span_styles=[{"start": 6, "end": 11, "size": 24.0}])
        # A larger Tf for JUST "bravo".
        assert [t for _txt, t in _seg_tfs(out)] == [12.0, 24.0, 12.0, 12.0]
        # The hand-computed per-line baselines (the multi-line leading crux).
        assert _tm_ys(out) == pytest.approx([700.0, 672.0, 644.0, 630.0], abs=0.02)

    def test_smaller_size_lets_bigger_neighbours_keep_their_leading(self, tmp_dir):
        # "bravo" (line 1) shrunk to 8pt. The adjacent-max rule PROTECTS the
        # 12pt neighbours — a lone smaller word can't pull them closer:
        #   gap = max(12,8)·7/6 = 14 on both sides.
        # So every baseline stays the uniform 700/686/672/658 (identical to a
        # plain edit), while bravo's Tf still drops to 8.
        src = _build(tmp_dir, _FOURLINE)
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        _apply(src, out, p, p["text"], span_styles=[{"start": 6, "end": 11, "size": 8.0}])
        assert [t for _txt, t in _seg_tfs(out)] == [12.0, 8.0, 12.0, 12.0]
        assert _tm_ys(out) == pytest.approx([700.0, 686.0, 672.0, 658.0], abs=0.02)

    def test_size_composes_with_per_span_colour(self, tmp_dir):
        # One range carries BOTH a bigger size AND a colour: the size drives
        # the Tf (and the line leading), the colour emits its rg — folded
        # independently on the SAME range.
        src = _build(tmp_dir, _FOURLINE)
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        _apply(src, out, p, p["text"],
               span_styles=[{"start": 6, "end": 11, "size": 24.0, "color": [1.0, 0.0, 0.0]}])
        assert [t for _txt, t in _seg_tfs(out)] == [12.0, 24.0, 12.0, 12.0]  # bigger Tf
        assert any(op == "rg" and a == ["1", "0", "0"] for op, a in _color_ops(out))  # AND red
        # The size still moved the leading (line1 down to 672, per the crux).
        assert _tm_ys(out) == pytest.approx([700.0, 672.0, 644.0, 630.0], abs=0.02)

    def test_single_line_original_reflow_gets_per_line_leading(self, tmp_dir):
        # Round-34 HIGH: a paragraph that STARTED single-line has para.leading
        # None even after its edit reflows it to many lines — gating the
        # per-line rule on para.leading left the wrapped output with FLAT
        # leading around a big glyph. base_ratio now comes from build()'s
        # single-line branch (SINGLE_LINE_LEADING_EM), so a bumped word on a
        # wrapped line gets the adjacent-max gap. Assert the STRUCTURAL
        # property (exact wrap x's are page-margin-dependent): the biggest
        # inter-baseline gap (around the 40pt word) clearly exceeds the flat
        # 12pt one — not all gaps equal.
        src = _build(tmp_dir, b"BT /F1 12 Tf 60 260 Td (Short line) Tj ET")  # single line
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        new_text = (
            "Short line now retyped much longer so it wraps across several "
            "lines inside the same narrow box here today please"
        )
        cut = new_text.index("wraps")
        _apply(
            src, out, p, new_text,
            [{"start": 0, "end": len(new_text), "run": p["runs"][0]}],
            span_styles=[{"start": cut, "end": cut + 5, "size": 40.0}],
        )
        assert 40.0 in [t for _txt, t in _seg_tfs(out)]  # the bump landed
        ys = _tm_ys(out)
        assert len(ys) >= 2  # it really wrapped ("wraps" lands on line 0)
        gaps = [round(ys[i] - ys[i + 1], 2) for i in range(len(ys) - 1)]
        # The gap adjacent to the 40pt word is its adjacent-max (40·1.2 = 48),
        # NOT the flat single-line 14.4 (12·1.2) — the HIGH: without the fix
        # this whole reflow used the flat constant.
        assert max(gaps) > 30.0, gaps

    def test_no_span_size_is_byte_identical(self, tmp_dir):
        # The self-contained pin: an edit carrying NO span size is byte-for-
        # byte the shipped path — the A5c size machinery is inert until a
        # size is present (the uniform-leading + per-code-point-None cases).
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Plain reword here) Tj ET")
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        p = _paras(src)[0]
        _apply(src, a, p, p["text"])
        _apply(src, b, p, p["text"], span_styles=None)
        assert _content_bytes(a) == _content_bytes(b)

    def test_size_is_clamped_to_the_edit_maximum(self, tmp_dir):
        # A fat-fingered 5000pt clamps to the A1 viewer max (1638) — never a
        # size that flies the range off the page.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Clamp) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        _apply(src, out, p, p["text"], span_styles=[{"start": 0, "end": 5, "size": 5000}])
        sizes = {t for _txt, t in _seg_tfs(out)}
        assert 1638.0 in sizes
        assert max(sizes) == 1638.0

    def test_size_only_entry_is_accepted(self, tmp_dir):
        # An entry with ONLY a size (no colour, no face) is a valid span
        # style — the widened axis-set check accepts it.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (Only size here) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        _apply(src, out, p, p["text"], span_styles=[{"start": 0, "end": 4, "size": 20.0}])
        assert 20.0 in {t for _txt, t in _seg_tfs(out)}

    def test_bigger_glyph_wraps_sooner(self, tmp_dir):
        # The bigger glyph consumes more of the box, forcing an earlier wrap:
        # "one two three four five six" fits on 2 emission lines at 12pt; with
        # "three" at 30pt the reflow needs 3.
        src = _build(
            tmp_dir,
            b"BT /F1 12 Tf 72 700 Td (one two three) Tj 0 -14 Td (four five six) Tj ET",
        )
        plain = os.path.join(tmp_dir, "plain.pdf")
        big = os.path.join(tmp_dir, "big.pdf")
        p = _paras(src)[0]
        assert p["text"] == "one two three four five six"
        cut = p["text"].index("three")
        _apply(src, plain, p, p["text"])
        _apply(src, big, p, p["text"], span_styles=[{"start": cut, "end": cut + 5, "size": 30.0}])
        assert len(_tm_ys(plain)) == 2
        assert len(_tm_ys(big)) == 3

    def test_split_with_enlarged_boundary_word_clears_descender(self, tmp_dir):
        # Round-35 finding 1 (HIGH): an A4 split whose block-A boundary word is
        # enlarged per-span must widen the INTER-BLOCK gap so the big glyph's
        # descender can't bleed into block B. Split "bravo delta" after
        # "bravo" with "bravo" at 150pt: the shipped fixed 2×leading gap
        # (~28.8) put block B's baseline at 671.2, INSIDE the 150pt descender;
        # the size-aware gap scales with the boundary glyph (2·150·1.2 = 360).
        # Mutation-pinned: revert to a fixed split_gap ⇒ gap ≈ 28.8 < 150.
        src = _build(tmp_dir, b"BT /F1 12 Tf 72 700 Td (bravo delta) Tj ET")
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        assert p["text"] == "bravo delta"
        _apply(
            src, out, p, p["text"], split_at=5,
            span_styles=[{"start": 0, "end": 5, "size": 150.0}],
        )
        ys = _tm_ys(out)
        assert len(ys) == 2  # block A ("bravo" @150), block B ("delta" @12)
        assert 150.0 in [t for _txt, t in _seg_tfs(out)]  # the bump landed
        assert ys[0] - ys[1] >= 150.0  # the gap accounts for the enlarged word

    def test_null_edit_of_size_varied_group_stays_flat(self, tmp_dir):
        # Round-35 finding 2 (MED): a grouped paragraph whose members ALREADY
        # differ in size (within SIZE_JUMP_RATIO — 16.5/14 = 1.18 < 1.2, so the
        # three lines join into ONE editable paragraph) must NOT reflow its
        # line rhythm on an edit that requests no size change. The per-line
        # rule is gated on an actual per-span size, NOT on pre-existing max_eff
        # spread. A null edit keeps the flat 20pt baselines; the bug (gate on
        # spread alone) drifted them to 23.57pt. Mutation-pinned: drop the
        # has_span_size gate ⇒ 700/676.43/652.86, not 700/680/660.
        src = _build(
            tmp_dir,
            b"BT /F1 14 Tf 72 700 Td (alpha) Tj "
            b"/F1 16.5 Tf 0 -20 Td (bravo) Tj "
            b"/F1 14 Tf 0 -20 Td (gamma) Tj ET",
        )
        out = os.path.join(tmp_dir, "o.pdf")
        p = _paras(src)[0]
        assert p["text"] == "alpha bravo gamma"
        assert p["line_count"] == 3  # the size-varied lines grouped into one
        # The paragraph's OWN spans carry the per-member sizes (14/16.5/14);
        # spans=None would collapse them to one size and hide the variance.
        _apply(src, out, p, p["text"], p["spans"])  # NULL edit, per-member spans
        assert _tm_ys(out) == pytest.approx([700.0, 680.0, 660.0], abs=0.02)


class TestDocumentFontKerning:
    """Phase 9.K1b — kerning the DOCUMENT'S OWN font.

    K1 shipped bundled-faces-only; that left a live regression, because
    re-emitting a paragraph DISCARDS the kerning its original `TJ` carried.
    A no-op re-type visibly un-kerned the text (DECISIONS #37).

    These pins deliberately pass `font_path`, because the app always does.
    The older byte-identity pins call the engine WITHOUT it, so they exercise
    a path the product no longer takes on its own.
    """

    def _tj_numbers(self, path):
        with pikepdf.open(path) as pdf:
            for instr in pikepdf.parse_content_stream(pdf.pages[0]):
                op = str(instr.operator)
                if op == "TJ":
                    out = []
                    for o in instr.operands[0]:
                        try:
                            out.append(round(float(o), 1))
                        except (TypeError, ValueError):
                            pass
                    return out
                if op == "Tj":
                    return None
        return None

    def _kerned_source(self, tmp_dir, name="kern_src.pdf"):
        # A paragraph whose ORIGINAL stream carries real kerning.
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td [(A) 74 (V) 74 (A) 55 (T) 40 (AR)] TJ ET",
            {"/F1": _helv(pdf)},
        )
        src = os.path.join(tmp_dir, name)
        pdf.save(src)
        pdf.close()
        return src

    @_needs_faces
    def test_a_retype_KEEPS_the_text_kerned(self, tmp_dir):
        # The regression, inverted: before K1b this came back a plain `Tj`.
        src = self._kerned_source(tmp_dir)
        out = os.path.join(tmp_dir, "kern_out.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], font_path=FONTS_DIR)
        nums = self._tj_numbers(out)
        assert nums, "the re-typed paragraph lost its kerning (plain Tj)"
        assert all(v > 0 for v in nums), "kerns must TIGHTEN (positive TJ numbers)"

    @_needs_faces
    def test_the_kerns_match_the_metric_twins_own_table(self, tmp_dir):
        # Helvetica ships no program and our Core14 metrics carry no pairs, so
        # the kerning comes from Liberation Sans — the face B1 vendored for
        # exactly that metric compatibility.
        from engine.font_kerning import kern_pairs

        src = self._kerned_source(tmp_dir, "twin_src.pdf")
        out = os.path.join(tmp_dir, "twin_out.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"], font_path=FONTS_DIR)

        twin = kern_pairs(os.path.join(FONTS_DIR, "LiberationSans-Regular.ttf"))
        text = para["text"]
        expected = [
            round(-twin[(text[i], text[i + 1])], 1)
            for i in range(len(text) - 1)
            if twin.get((text[i], text[i + 1]))
        ]
        assert self._tj_numbers(out) == expected

    def test_without_a_font_path_the_output_is_unchanged(self, tmp_dir):
        # Back-compat for direct/CLI callers that pass no fonts dir: no dir
        # means no metric twin, so a non-embedded font simply does not kern.
        src = self._kerned_source(tmp_dir, "nodir_src.pdf")
        out = os.path.join(tmp_dir, "nodir_out.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"])
        assert self._tj_numbers(out) is None  # plain Tj

    @_needs_faces
    def test_kerning_does_not_cross_a_style_boundary(self, tmp_dir):
        # A pair straddling two different faces is not a pair either font has
        # an opinion about; taking one would invent spacing.
        pdf = pikepdf.new()
        _page(
            pdf,
            b"BT /F1 12 Tf 72 700 Td (A) Tj /F2 12 Tf (V) Tj ET",
            {"/F1": _helv(pdf), "/F2": _helv_bold(pdf)},
        )
        src = os.path.join(tmp_dir, "boundary.pdf")
        pdf.save(src)
        pdf.close()
        para = _paras(src)[0]
        out = os.path.join(tmp_dir, "boundary_out.pdf")
        # The REAL spans map each char to its own member run — `_apply`'s
        # default would style everything from the first run, collapsing the
        # two faces into one style and legitimately kerning the pair.
        _apply(src, out, para, para["text"], para["spans"], font_path=FONTS_DIR)
        # Two members, two styles: the A|V pair spans them, so no kern rides.
        assert self._tj_numbers(out) is None
