"""Paragraph-editing fidelity against the two reported fixtures.

Both files come from real reports and each pins a class of defect the
hand-built streams could not reach:

  - `issue29-30-test.pdf` (pdflatex): six body paragraphs separated ONLY by
    a first-line indent, the body fully justified. It pins paragraph
    boundaries (an indent after a short line ends a paragraph) and
    justification survival (an indented first line is still a justified
    paragraph, and stays one after an edit).
  - `issue31-kern_spaces.pdf`: word gaps drawn as TJ kerns, with a subset
    whose /Widths entry for the space code is 0. It pins that a re-emitted
    gap DRAWS — a font that encodes a zero-width space cannot express one.
"""

import os
import types

import pikepdf
import pytest

from engine.extract_text import extract_text
from engine.text_paragraphs import (
    _detect_alignment,
    _first_line_indent,
    _join_paragraphs,
    _Line,
    list_text_paragraphs,
    merge_paragraph_with_previous,
    replace_paragraph_text,
)

ISSUES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "issues")
LATEX = os.path.join(ISSUES, "issue29-30-test.pdf")
KERNS = os.path.join(ISSUES, "issue31-kern_spaces.pdf")

# The LaTeX fixture's own geometry, read off the page. Points.
BODY_LEFT = 133.77
BODY_RIGHT = 477.48
INDENT_LEFT = 148.71
EDGE_TOL = 1.0
NL = chr(10)


def _lines(path: str, page: int = 1) -> list[tuple[float, float, float]]:
    """Every drawn line on the page as (y, x0, x1), top down."""
    from engine.redact import IDENTITY, _resolve_resources
    from engine.text_paragraphs import _cluster_lines, _members_from
    from engine.text_runs import _FontCache, _walk_runs

    with pikepdf.open(path) as pdf:
        p = pdf.pages[page - 1]
        resources = _resolve_resources(p)
        runs: list[dict] = []
        detail: list[dict] = []
        _walk_runs(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None,
            runs, False, _FontCache(), detail=detail,
        )
        out = [
            (line.y, line.x0, line.x1)
            for line in _cluster_lines(_members_from(runs, detail))
        ]
        return sorted(out, key=lambda t: -t[0])


def _edit(src: str, out: str, index: int, old: str, new: str, page: int = 1) -> dict:
    """Replace `old` with `new` inside paragraph `index`, spans shifted."""
    listing = list_text_paragraphs(src, page)
    para = listing["paragraphs"][index]
    text = para["text"]
    at = text.index(old)
    delta = len(new) - len(old)
    edited = text[:at] + new + text[at + len(old):]
    spans = []
    for span in para["spans"]:
        moved = dict(span)
        if span["start"] > at:
            moved["start"] = span["start"] + delta
        if span["end"] > at:
            moved["end"] = span["end"] + delta
        spans.append(moved)
    spans = [s for s in spans if s["end"] > s["start"]]
    spans[-1]["end"] = len(edited)
    replace_paragraph_text(
        file=src, output=out, page=page, paragraph_index=index,
        new_text=edited, spans=spans,
        expected_runs=para["runs"], expected_text=text,
    )
    return list_text_paragraphs(out, page)


def _body(path: str) -> list[dict]:
    """The page's paragraphs less the page number."""
    return [
        p for p in list_text_paragraphs(path, 1)["paragraphs"]
        if p["text"].strip() != "1"
    ]


# ── #29: a first-line indent is a paragraph boundary ─────────────────────


def test_indent_separates_the_six_body_paragraphs():
    body = _body(LATEX)
    assert len(body) == 6
    starts = [p["text"][:11] for p in body]
    assert starts[0] == "hello world"
    assert starts[1] == "hello again"
    assert all(s.startswith("Nam quis en") for s in starts[2:])
    # Each ipsum paragraph is whole: it ends where the source ends it.
    for p in body[2:]:
        assert p["text"].endswith("Duis porttitor nibh id eros.")


def test_short_line_alone_does_not_split_a_paragraph():
    # Every body paragraph's last line is short; only a line that FOLLOWS
    # one AND is indented opens a new paragraph, so no ordinary wrap breaks.
    for p in _body(LATEX)[2:]:
        assert p["text"].count("Duis porttitor nibh id eros.") == 1


def test_editing_one_paragraph_leaves_its_neighbours_alone(tmp_path):
    out = str(tmp_path / "edited.pdf")
    after = _edit(LATEX, out, 3, "Nam quis", "Nam quia")["paragraphs"]
    before = list_text_paragraphs(LATEX, 1)["paragraphs"]
    assert len(after) == len(before)
    for i, (a, b) in enumerate(zip(after, before)):
        if i == 3:
            assert a["text"].startswith("Nam quia")
        else:
            assert a["text"] == b["text"]


# ── #30: justification survives the edit ─────────────────────────────────


def test_indented_first_line_still_reads_as_justified():
    assert [p["alignment"] for p in _body(LATEX)[2:]] == ["justify"] * 4


def test_detect_alignment_exempts_only_the_first_line_left_edge():
    class L:
        def __init__(self, x0, x1):
            self.x0, self.x1 = x0, x1

    flush = [L(BODY_LEFT, BODY_RIGHT) for _ in range(3)]
    indented = [L(INDENT_LEFT, BODY_RIGHT)] + flush + [L(BODY_LEFT, 229.0)]
    assert _detect_alignment(indented, BODY_LEFT, BODY_RIGHT) == "justify"
    # A LATER line pulled in from the left is not an indent — it is ragged.
    ragged = [L(BODY_LEFT, BODY_RIGHT), L(INDENT_LEFT, BODY_RIGHT), L(BODY_LEFT, 229.0)]
    assert _detect_alignment(ragged, BODY_LEFT, BODY_RIGHT) != "justify"


def test_edited_justified_paragraph_stays_flush_to_both_margins(tmp_path):
    out = str(tmp_path / "justified.pdf")
    after = _edit(LATEX, out, 5, "Nam quis", "Nam quia")["paragraphs"]
    assert after[5]["alignment"] == "justify"
    edited = [ln for ln in _lines(out) if 300.0 < ln[0] < 435.0]
    assert len(edited) >= 4
    for _y, _x0, x1 in edited[:-1]:
        assert abs(x1 - BODY_RIGHT) <= EDGE_TOL
    for _y, x0, _x1 in edited[1:-1]:
        assert abs(x0 - BODY_LEFT) <= EDGE_TOL
    assert abs(edited[0][1] - INDENT_LEFT) <= EDGE_TOL  # the indent survives
    assert edited[-1][2] < BODY_RIGHT - 10.0  # …and the last line never stretches


# ── #31: a word gap must DRAW ────────────────────────────────────────────


def test_kern_gaps_survive_an_edit_geometrically(tmp_path):
    out = str(tmp_path / "kerns.pdf")
    after = _edit(KERNS, out, 0, "from", "form")["paragraphs"]
    assert after[0]["text"] == "hello form this file with kerns for spaces"
    assert "hello form this file with kerns for spaces" in str(
        extract_text(out, [1])
    )
    # The gaps are DRAWN, not merely spelled — the line keeps its width,
    # which a zero-advance space code could not have produced.
    _y, x0, x1 = _lines(out)[0]
    _by, bx0, bx1 = _lines(KERNS)[0]
    assert abs((x1 - x0) - (bx1 - bx0)) < 2.0


def test_zero_width_space_font_never_emits_a_literal_space(tmp_path):
    out = str(tmp_path / "kerns2.pdf")
    _edit(KERNS, out, 0, "from", "form")
    with pikepdf.open(out) as pdf:
        stream = bytes(pdf.pages[0].Contents.read_bytes())
    assert b"(hello form this" not in stream
    assert b"TJ" in stream


def test_a_justify_kern_beside_a_space_is_read_as_one_gap(tmp_path):
    # Re-editing a justified paragraph must not widen it by a space per
    # gap: the drawn space and the stretch kern are ONE word gap.
    out = str(tmp_path / "twice.pdf")
    after = _edit(LATEX, out, 5, "Nam quis", "Nam quia")["paragraphs"]
    assert "  " not in after[5]["text"]


# ── the author's own line break ──────────────────────────────────────────


def test_a_newline_ends_the_line_where_it_is_written(tmp_path):
    out = str(tmp_path / "break.pdf")
    _edit(LATEX, out, 5, "Duis euismod.", "Duis euismod." + NL + "BROKEN HERE.")
    text = list_text_paragraphs(out, 1)["paragraphs"][5]["text"]
    assert "BROKEN HERE." in text
    lines = [ln for ln in _lines(out) if 300.0 < ln[0] < 435.0]
    # The line carrying the break stops short and is NOT stretched to the
    # measure; the next line starts fresh at the body margin.
    broken = next(i for i, ln in enumerate(lines) if ln[2] < BODY_RIGHT - 20.0)
    assert lines[broken][2] < BODY_RIGHT - 20.0
    assert broken + 1 < len(lines)
    assert abs(lines[broken + 1][1] - BODY_LEFT) <= EDGE_TOL


def test_a_newline_is_never_asked_of_the_font(tmp_path):
    # The subset carries no newline glyph; the edit must not refuse it, and
    # nothing is drawn for the break itself — the two words land on two
    # lines at the same left edge.
    out = str(tmp_path / "break2.pdf")
    _edit(LATEX, out, 1, "hello again", "hello" + NL + "again")
    drawn = [ln for ln in _lines(out) if ln[0] > 600.0]
    hello = next(ln for ln in drawn if abs(ln[0] - 633.33) < 0.5)
    below = [ln for ln in drawn if ln[0] < hello[0] - 1.0]
    assert below and abs(below[0][1] - hello[1]) <= EDGE_TOL


# -- columns: margin evidence is per lane, never pooled across columns ----


def _synth_line(index: int, y: float, x0: float, x1: float, stream: int = 0) -> "_Line":
    """One drawn line, positioned by hand. Geometry is the whole question
    here, so the members carry only what the join reads."""
    line = _Line.__new__(_Line)
    line.members = [types.SimpleNamespace(index=index, stream=stream, ptext="body")]
    line.y = float(y)
    line.eff = 10.0
    line.x0 = float(x0)
    line.x1 = float(x1)
    return line


def _columns(count: int) -> list:
    """`count` side-by-side columns, each holding two paragraphs the only
    way a typesetter marks them: a short last line, then an indented one.
    Every column is identical, so a rule that fires anywhere must fire in
    all of them."""
    lines = []
    index = 0
    for row, (x0_off, x1_off) in enumerate(
        [(0.0, 0.0), (0.0, -25.0), (10.0, 0.0), (0.0, 0.0)]
    ):
        for col in range(count):
            base = col * 200.0
            lines.append(
                _synth_line(index, 100.0 - row * 10.0 - col, base + x0_off,
                            base + 100.0 + x1_off)
            )
            index += 1
    return lines


def test_two_columns_each_keep_their_own_indent_break():
    paras = _join_paragraphs(_columns(2))
    assert len(paras) == 4
    assert all(len(block) == 2 for block in paras)


def test_three_columns_each_keep_their_own_indent_break():
    paras = _join_paragraphs(_columns(3))
    assert len(paras) == 6
    assert all(len(block) == 2 for block in paras)


def _spanning(count: int, x0: float, x1: float, y: float) -> list:
    """A full-width block over `count` columns - a heading, a footer or a
    figure caption. It overlaps every column, so a lane rule built on
    transitive x-overlap alone welds them into one pool."""
    return [_synth_line(900 + int(y), y, x0, x1)]


def test_a_spanning_heading_does_not_bridge_two_columns():
    lines = _spanning(2, 0.0, 300.0, 120.0) + _columns(2)
    paras = _join_paragraphs(lines)
    assert len(paras) == 5
    assert [len(block) for block in paras] == [1, 2, 2, 2, 2]


def test_a_spanning_heading_does_not_bridge_three_columns():
    lines = _spanning(3, 0.0, 500.0, 120.0) + _columns(3)
    paras = _join_paragraphs(lines)
    assert len(paras) == 7
    assert sorted(len(block) for block in paras) == [1, 2, 2, 2, 2, 2, 2]


def test_a_heading_and_a_footer_both_span_without_bridging():
    lines = (
        _spanning(2, 0.0, 300.0, 120.0)
        + _columns(2)
        + _spanning(2, 0.0, 300.0, 40.0)
    )
    paras = _join_paragraphs(lines)
    assert len(paras) == 6
    assert sorted(len(block) for block in paras) == [1, 1, 2, 2, 2, 2]


def test_a_single_column_page_with_a_wide_line_keeps_one_lane():
    # The withdrawal is accepted only when it exposes real COLUMNS. One
    # column with an over-wide line has no gutter to expose, so nothing is
    # withdrawn and the page measures as it always did.
    lines = [_synth_line(0, 100.0, 0.0, 300.0)] + [
        _synth_line(i + 1, 90.0 - i * 10.0, 0.0, 100.0 - (25.0 if i == 1 else 0.0))
        for i in range(4)
    ]
    lines[3].x0 = 10.0
    paras = _join_paragraphs(lines)
    assert [len(block) for block in paras] == [3, 2]


def test_a_spanning_heading_does_not_bridge_a_one_line_sidebar():
    # A genuine one-line sidebar/caption column can never itself reach
    # LANE_MIN_LINES, so a split that requires EVERY lane to have real
    # support can never be accepted here -- and a rejected split leaves the
    # heading, the main column and the sidebar in one merged pool, which
    # dilutes the main column's margin evidence enough to silence a real
    # indent break in it (regression: LANE_MIN_LINES rejected any split
    # touching this one-line lane, even though the main column alone
    # establishes both margins).
    heading = _spanning(2, 0.0, 300.0, 120.0)
    main_col = [
        _synth_line(1, 100.0, 0.0, 100.0),
        _synth_line(2, 90.0, 0.0, 60.0),
        _synth_line(3, 80.0, 15.0, 100.0),
        _synth_line(4, 70.0, 0.0, 55.0),
    ]
    sidebar = [_synth_line(5, 100.0, 200.0, 300.0)]
    paras = _join_paragraphs(heading + main_col + sidebar)
    assert sorted(len(block) for block in paras) == [1, 1, 2, 2]


def test_a_single_column_page_is_unchanged_by_the_lane_split():
    # The lane rule must not be a second behaviour: one column has one lane.
    body = _body(LATEX)
    assert len(body) == 6


# -- RTL: the justification test mirrors with the base direction ---------


def test_rtl_justification_survives_a_first_line_indent():
    class L:
        def __init__(self, x0, x1):
            self.x0, self.x1 = x0, x1

    # Right-to-left: the lines grow toward the LEFT margin and the
    # first-line indent insets the RIGHT edge.
    indented = [L(0.0, 90.0), L(0.0, 100.0), L(0.0, 100.0), L(30.0, 100.0)]
    assert _detect_alignment(indented, 0.0, 100.0, base_rtl=True) == "justify"
    # The same geometry read left to right is NOT justified: its right
    # edges are ragged and only the first line reaches the measure.
    assert _detect_alignment(indented, 0.0, 100.0) != "justify"
    # A LATER line inset from the right is ragged, not an indent.
    ragged = [L(0.0, 100.0), L(0.0, 90.0), L(0.0, 100.0), L(30.0, 100.0)]
    assert _detect_alignment(ragged, 0.0, 100.0, base_rtl=True) != "justify"


def test_the_first_line_indent_is_measured_at_the_logical_start_edge():
    class L:
        def __init__(self, x0, x1):
            self.x0, self.x1 = x0, x1

    # Left to right: the opener's LEFT edge is in from the body's.
    ltr = [L(15.0, 100.0), L(0.0, 100.0), L(0.0, 100.0), L(0.0, 60.0)]
    assert _first_line_indent(ltr, "justify", False) == 15.0
    assert _first_line_indent(ltr, "justify", True) == 0.0
    # Right to left: the opener's RIGHT edge is in from the body's.
    rtl = [L(0.0, 85.0), L(0.0, 100.0), L(0.0, 100.0), L(40.0, 100.0)]
    assert _first_line_indent(rtl, "justify", True) == 15.0
    assert _first_line_indent(rtl, "justify", False) == 0.0
    # An alignment with no start edge to indent from has no indent.
    assert _first_line_indent(rtl, "center", True) == 0.0
    assert _first_line_indent(ltr, "right", False) == 0.0


def test_ltr_justification_is_unchanged_by_the_mirror():
    class L:
        def __init__(self, x0, x1):
            self.x0, self.x1 = x0, x1

    flush = [L(BODY_LEFT, BODY_RIGHT) for _ in range(3)]
    indented = [L(INDENT_LEFT, BODY_RIGHT)] + flush + [L(BODY_LEFT, 229.0)]
    assert _detect_alignment(indented, BODY_LEFT, BODY_RIGHT) == "justify"
    assert _detect_alignment(indented, BODY_LEFT, BODY_RIGHT, base_rtl=True) != "justify"


# -- RTL: a justified paragraph re-emits justified ------------------------

_AR_FACE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "resources", "fonts",
    "IBMPlexSansArabic-Regular.ttf",
)
RTL_LEFT, RTL_RIGHT = 100.0, 300.0
RTL_INDENT = 15.0


def _build_justified_rtl(path: str) -> str:
    """A four-line right-to-left paragraph justified the way a producer
    justifies one: each line is stretched to the measure with its own Tz,
    the FIRST line inset from the right margin by the paragraph indent and
    the last line flush right. Drawn in visual order, as a PDF pen must."""
    from fontTools.ttLib import TTFont
    from pikepdf import Dictionary
    from test_rtl_reflow import _embed, _shape_line

    face = TTFont(_AR_FACE, lazy=True)
    upm, hmtx = face["head"].unitsPerEm, face["hmtx"]
    gid_of = {n: i for i, n in enumerate(face.getGlyphOrder())}
    size = 16.0
    texts = [
        "مرحبا بالعالم",
        "لغة عربية جميلة",
        "ونص طويل يحتاج",
        "الى اكثر",
    ]
    measure = RTL_RIGHT - RTL_LEFT
    targets = [measure - RTL_INDENT, measure, measure, 120.0]
    x0s = [RTL_LEFT, RTL_LEFT, RTL_LEFT, RTL_RIGHT - 120.0]
    runs = [_shape_line(_AR_FACE, t) for t in texts]
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    gids, gid_text = set(), {}
    for run in runs:
        for name, cluster in run:
            g = gid_of[name]
            gids.add(g)
            if cluster:
                gid_text[g] = cluster
            else:
                gid_text.setdefault(g, "")
    font_dict = _embed(pdf, _AR_FACE, gids, gid_text)
    ops = ["BT", "/PF1 %g Tf" % size]
    for i, run in enumerate(runs):
        natural = sum(hmtx[n][0] for n, _t in run) / upm * size
        ops.append("%g Tz" % (targets[i] / natural * 100.0))
        ops.append("1 0 0 1 %g %g Tm" % (x0s[i], 700.0 - i * 22.0))
        ops.append("<%s> Tj" % "".join(f"{gid_of[n]:04x}" for n, _t in run))
    ops.append("ET")
    page.Contents = pdf.make_stream((NL.join(ops)).encode("ascii"))
    page.Resources = Dictionary(Font=Dictionary(PF1=font_dict))
    pdf.save(path)
    pdf.close()
    return path


@pytest.mark.skipif(
    not os.path.isfile(_AR_FACE),
    reason="RTL faces not provisioned (scripts/sync-edit-fonts.ps1)",
)
def test_a_justified_rtl_paragraph_reads_and_re_emits_as_justified(tmp_path):
    src = _build_justified_rtl(str(tmp_path / "rtl-justified.pdf"))
    para = list_text_paragraphs(src, 1)["paragraphs"][0]
    assert para["rtl"] is True
    assert para["line_count"] == 4
    assert para["alignment"] == "justify"
    # Emitted: the edit reflows and the paragraph is still justified to the
    # same measure — the classification is what the re-emission obeys.
    out = str(tmp_path / "rtl-justified-edited.pdf")
    new_text = para["text"].replace(
        "جميلة", "جميل"
    )
    assert new_text != para["text"]
    replace_paragraph_text(
        file=src, output=out, page=1, paragraph_index=para["index"],
        new_text=new_text,
        spans=[{"start": 0, "end": len(new_text), "run": para["runs"][0]}],
        expected_runs=para["runs"], expected_text=para["text"],
        convert=True,
        font_path=os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "resources", "fonts"
        ),
    )
    after = list_text_paragraphs(out, 1)["paragraphs"][0]
    assert after["alignment"] == "justify"
    assert abs(after["box"][0] - RTL_LEFT) <= EDGE_TOL
    assert abs(after["box"][2] - RTL_RIGHT) <= EDGE_TOL
    drawn = _lines(out)
    assert len(drawn) >= 3
    for line in drawn[1:-1]:
        assert abs(line[1] - RTL_LEFT) <= EDGE_TOL
        assert abs(line[2] - RTL_RIGHT) <= EDGE_TOL
    # The first line keeps its indent, which right to left insets the RIGHT
    # edge: the opener justifies against the reduced limit while the body
    # lines still reach both margins.
    assert abs(drawn[0][2] - (RTL_RIGHT - RTL_INDENT)) <= EDGE_TOL
    assert abs(drawn[0][1] - RTL_LEFT) <= EDGE_TOL
    # The closing line hangs from the edge the reading starts at.
    assert abs(drawn[-1][2] - RTL_RIGHT) <= EDGE_TOL


# -- Column lanes carry through a split and a merge ----------------------

COURIER_HEAD = "A Heading Spanning Both Of The Columns"
COURIER_INDENT = 12.0
#: Courier at 10pt advances 6pt per character, so a 30-character line is
#: exactly the 180pt column measure and every edge below is exact.
COL_ONE = [
    ("Alpha beta gamma delta epsilon", 0.0),
    ("zeta eta theta iota kappa xxxx", 0.0),
    ("lambda mu nu", 0.0),
    ("Xi omicron pi rho sigma taux", COURIER_INDENT),
    ("upsilon phi chi psi omega jjjj", 0.0),
    ("aa bb cc", 0.0),
    ("Alef bet gimel dalet hey vav", COURIER_INDENT),
    ("zayin het tet yod kaf lamedxx", 0.0),
    ("mem nun", 0.0),
]
COL_TWO = [
    ("Uno dos tres cuatro cinco seis", 0.0),
    ("siete ocho nueve diez once dos", 0.0),
    ("tres catorce", 0.0),
    ("Quince dieciseis diecisietex", COURIER_INDENT),
    ("dieciocho diecinueve veinte vv", 0.0),
    ("uno dos", 0.0),
]
LANE_ONE = (72.0, 252.0)
LANE_TWO = (320.0, 500.0)


def _two_column_page(path: str) -> str:
    """A spanning heading over two columns, each column's paragraphs
    separated only by a first-line indent. Column two starts BELOW column
    one so reading order lists each column's paragraphs adjacently."""
    ops = [b"BT /F1 14 Tf 1 0 0 1 72 720 Tm (%s) Tj ET" % COURIER_HEAD.encode("ascii")]
    for base, rows, ytop in ((72.0, COL_ONE, 690.0), (320.0, COL_TWO, 560.0)):
        y = ytop
        for text, indent in rows:
            ops.append(
                b"BT /F1 10 Tf 1 0 0 1 %g %g Tm (%s) Tj ET"
                % (base + indent, y, text.encode("ascii"))
            )
            y -= 12.0
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page.obj["/Resources"] = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(
            F1=pdf.make_indirect(
                pikepdf.Dictionary(
                    Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
                    BaseFont=pikepdf.Name("/Courier"),
                    Encoding=pikepdf.Name("/WinAnsiEncoding"),
                )
            )
        )
    )
    page.Contents = pdf.make_stream((NL.encode("ascii")).join(ops))
    pdf.save(path)
    pdf.close()
    return path


def _in_lane(para: dict, lane: tuple) -> bool:
    lo, hi = lane
    return para["box"][0] >= lo - EDGE_TOL and para["box"][2] <= hi + EDGE_TOL


def test_the_two_column_page_lists_its_lane_paragraphs(tmp_path):
    src = _two_column_page(str(tmp_path / "cols.pdf"))
    paras = list_text_paragraphs(src, 1)["paragraphs"]
    assert [p["line_count"] for p in paras] == [1, 3, 3, 3, 3, 3]
    assert paras[0]["text"] == COURIER_HEAD
    assert all(_in_lane(p, LANE_ONE) for p in paras[1:4])
    assert all(_in_lane(p, LANE_TWO) for p in paras[4:])


def test_a_split_inside_a_column_keeps_both_halves_in_that_lane(tmp_path):
    src = _two_column_page(str(tmp_path / "cols.pdf"))
    out = str(tmp_path / "split.pdf")
    paras = list_text_paragraphs(src, 1)["paragraphs"]
    target = paras[3]
    cut = target["text"].index("zayin")
    replace_paragraph_text(
        file=src, output=out, page=1, paragraph_index=target["index"],
        new_text=target["text"],
        spans=[{"start": 0, "end": len(target["text"]), "run": target["runs"][0]}],
        expected_runs=target["runs"], expected_text=target["text"], split_at=cut,
    )
    after = list_text_paragraphs(out, 1)["paragraphs"]
    assert len(after) == len(paras) + 1
    halves = after[3:5]
    assert [h["text"] for h in halves] == [
        "Alef bet gimel dalet hey vav", "zayin het tet yod kaf lamedxx mem nun"
    ]
    # Both halves are still the first column's, and the first keeps the
    # indent the break was signalled by.
    assert all(_in_lane(h, LANE_ONE) for h in halves)
    assert abs(halves[0]["box"][0] - (LANE_ONE[0] + COURIER_INDENT)) <= EDGE_TOL
    # …and the OTHER column's indent break still fires, unchanged.
    assert [p["text"][:6] for p in after[5:]] == ["Uno do", "Quince"]
    assert all(_in_lane(p, LANE_TWO) for p in after[5:])


def test_a_merge_across_a_column_indent_break_keeps_the_first_indent(tmp_path):
    src = _two_column_page(str(tmp_path / "cols.pdf"))
    out = str(tmp_path / "merged.pdf")
    paras = list_text_paragraphs(src, 1)["paragraphs"]
    merge_paragraph_with_previous(
        src, out, 1, 3,
        paras[2]["runs"], paras[2]["text"], paras[3]["runs"], paras[3]["text"],
    )
    after = list_text_paragraphs(out, 1)["paragraphs"]
    assert len(after) == len(paras) - 1
    merged = after[2]
    assert merged["text"] == paras[2]["text"] + " " + paras[3]["text"]
    assert merged["line_count"] == 5
    assert _in_lane(merged, LANE_ONE)
    # The first line carries the ANCHOR paragraph's own indent; the body
    # lines start at the column's margin.
    top, bottom = merged["box"][3], merged["box"][1]
    own = [
        line for line in _lines(out)
        if line[1] < LANE_TWO[0] and bottom - EDGE_TOL <= line[0] <= top + EDGE_TOL
    ]
    assert len(own) == 5
    assert abs(own[0][1] - (LANE_ONE[0] + COURIER_INDENT)) <= EDGE_TOL
    assert all(abs(line[1] - LANE_ONE[0]) <= EDGE_TOL for line in own[1:])
    # The second column is untouched and still breaks on its own indent.
    assert [p["text"][:6] for p in after[3:]] == ["Uno do", "Quince"]


# -- RTL: the first-line indent survives a split and a merge --------------

_RTL_SKIP = pytest.mark.skipif(
    not os.path.isfile(_AR_FACE),
    reason="RTL faces not provisioned (scripts/sync-edit-fonts.ps1)",
)
FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resources", "fonts")


def _rtl_edit(src: str, out: str, para: dict, new_text: str, **kw) -> None:
    replace_paragraph_text(
        file=src, output=out, page=1, paragraph_index=para["index"],
        new_text=new_text,
        spans=[{"start": 0, "end": len(new_text), "run": para["runs"][0]}],
        expected_runs=para["runs"], expected_text=para["text"],
        convert=True, font_path=FONT_DIR, **kw,
    )


@_RTL_SKIP
def test_an_rtl_split_gives_the_second_half_its_own_right_edge_indent(tmp_path):
    src = _build_justified_rtl(str(tmp_path / "rtl.pdf"))
    out = str(tmp_path / "rtl-split.pdf")
    para = list_text_paragraphs(src, 1)["paragraphs"][0]
    cut = para["text"].index("ونص")
    _rtl_edit(src, out, para, para["text"], split_at=cut)
    after = list_text_paragraphs(out, 1)["paragraphs"]
    # The split really split — and each half is a paragraph in its own
    # right, not the first half plus a stray closing line.
    assert len(after) == 2
    assert after[0]["text"] + " " + after[1]["text"] == para["text"]
    assert all(p["rtl"] for p in after)
    drawn = _lines(out)
    firsts = [drawn[0], drawn[after[0]["line_count"]]]
    for first in firsts:
        assert abs(first[2] - (RTL_RIGHT - RTL_INDENT)) <= EDGE_TOL
    # Every other line, both halves, reaches the right margin.
    for line in drawn:
        if line not in firsts:
            assert abs(line[2] - RTL_RIGHT) <= EDGE_TOL


@_RTL_SKIP
def test_a_split_offset_inside_a_shaped_unit_refuses_by_name(tmp_path):
    # The offset is a CODE POINT index and the styled stream is a list of
    # UNITS; landing inside one names no boundary.
    src = _build_justified_rtl(str(tmp_path / "rtl.pdf"))
    para = list_text_paragraphs(src, 1)["paragraphs"][0]
    out = str(tmp_path / "never.pdf")
    refused = 0
    for cut in range(1, len(para["text"])):
        try:
            _rtl_edit(src, out, para, para["text"], split_at=cut)
        except ValueError as exc:
            assert "ligature" in str(exc)
            refused += 1
    # Some offsets are boundaries and some are not; what must never happen
    # is a split that silently lands somewhere else.
    assert 0 < refused < len(para["text"]) - 1


@_RTL_SKIP
def test_an_rtl_merge_keeps_one_right_edge_indent_and_hangs_its_last_line(tmp_path):
    src = _build_justified_rtl(str(tmp_path / "rtl.pdf"))
    split = str(tmp_path / "rtl-split.pdf")
    para = list_text_paragraphs(src, 1)["paragraphs"][0]
    _rtl_edit(src, split, para, para["text"],
              split_at=para["text"].index("ونص"))
    halves = list_text_paragraphs(split, 1)["paragraphs"]
    out = str(tmp_path / "rtl-merged.pdf")
    merge_paragraph_with_previous(
        split, out, 1, 1,
        halves[0]["runs"], halves[0]["text"], halves[1]["runs"], halves[1]["text"],
        font_path=FONT_DIR,
    )
    after = list_text_paragraphs(out, 1)["paragraphs"]
    assert len(after) == 1
    # The merge reorders on the way out: the text comes back in LOGICAL
    # order, not mirrored.
    assert after[0]["text"] == para["text"]
    assert after[0]["rtl"] is True
    drawn = _lines(out)
    # ONE indent, on the first line, at the right edge.
    assert abs(drawn[0][2] - (RTL_RIGHT - RTL_INDENT)) <= EDGE_TOL
    for line in drawn[1:]:
        assert abs(line[2] - RTL_RIGHT) <= EDGE_TOL
    # The last line hangs from the edge the reading starts at.
    assert abs(drawn[-1][2] - RTL_RIGHT) <= EDGE_TOL
    assert drawn[-1][1] > RTL_LEFT + EDGE_TOL


def _synth_rtl_line(index: int, y: float, x0: float, x1: float) -> "_Line":
    """`_synth_line` with right-to-left text on it, so the lane resolves to
    a right-to-left base direction."""
    line = _synth_line(index, y, x0, x1)
    line.members[0].ptext = "\u0645\u0631\u062d\u0628\u0627"
    return line


#: A justified block whose SECOND paragraph opens with a first-line indent
#: and closes with a short line. Read at the left edge, the closing line's
#: ragged left is a first-line indent and its predecessor's inset right is
#: a short line -- the exact signature of a paragraph break, in a paragraph
#: that has none.
_MIRROR_ROWS = [(0.0, 85.0), (0.0, 100.0), (0.0, 100.0), (0.0, 85.0), (14.0, 100.0)]


def test_a_closing_rtl_line_is_not_read_as_a_first_line_indent():
    rtl = [_synth_rtl_line(i, 100.0 - 10.0 * i, x0, x1)
           for i, (x0, x1) in enumerate(_MIRROR_ROWS)]
    assert [len(block) for block in _join_paragraphs(rtl)] == [5]


def test_the_same_geometry_read_left_to_right_still_breaks():
    # The mirror is a mirror, not a loosening: left to right the identical
    # edges are an indent after a short line, and still end a paragraph.
    ltr = [_synth_line(i, 100.0 - 10.0 * i, x0, x1)
           for i, (x0, x1) in enumerate(_MIRROR_ROWS)]
    assert [len(block) for block in _join_paragraphs(ltr)] == [4, 1]


@_RTL_SKIP
def test_a_justified_rtl_paragraph_relists_whole_after_an_edit(tmp_path):
    src = _build_justified_rtl(str(tmp_path / "rtl.pdf"))
    out = str(tmp_path / "rtl-edited.pdf")
    para = list_text_paragraphs(src, 1)["paragraphs"][0]
    shorter = para["text"].replace("\u062c\u0645\u064a\u0644\u0629", "\u062c\u0645\u064a\u0644")
    assert shorter != para["text"]
    _rtl_edit(src, out, para, shorter)
    after = list_text_paragraphs(out, 1)["paragraphs"]
    assert len(after) == 1
    assert after[0]["text"] == shorter


# -- A paragraph edit on a SIGNED document -------------------------------

def _sign_beside(src: str, out: str, tmp_path) -> str:
    from engine import signatures
    from test_engine import _make_test_pfx

    pfx = _make_test_pfx(str(tmp_path / "signer.pfx"), "testpw")
    signatures.sign_pdf(file=src, output=out, pfx_path=pfx, password="testpw")
    return out


def _signature_rows(path: str):
    from engine import signatures

    return sorted(
        (row.get("field"), bool(row.get("valid")), bool(row.get("intact")))
        for row in signatures.verify_signatures(path)["signatures"]
    )


def test_a_signed_column_edit_refuses_the_append_by_name_and_writes_nothing(tmp_path):
    # A paragraph edit rewrites a page's CONTENT, which is not one of the
    # append-safe delta classes: the page no longer matches its signed twin
    # structurally, and a rewritten page cannot be told from a delete plus
    # an insert. The transplant says so and lands no bytes; the ordinary
    # rewrite is what the caller gets, and it reports the signature as no
    # longer intact rather than claiming otherwise.
    from engine.incremental import has_live_signatures, transplant_incremental

    plain = _two_column_page(str(tmp_path / "cols.pdf"))
    signed = _sign_beside(plain, str(tmp_path / "signed.pdf"), tmp_path)
    assert has_live_signatures(signed)
    assert _signature_rows(signed) == [("Signature1", True, True)]

    paras = list_text_paragraphs(signed, 1)["paragraphs"]
    target = next(p for p in paras if p["text"].startswith("Alef"))
    new_text = target["text"].replace("Alef", "Alve")
    edited = str(tmp_path / "edited.pdf")
    replace_paragraph_text(
        file=signed, output=edited, page=1, paragraph_index=target["index"],
        new_text=new_text,
        spans=[{"start": 0, "end": len(new_text), "run": target["runs"][0]}],
        expected_runs=target["runs"], expected_text=target["text"],
    )
    landed = str(tmp_path / "transplanted.pdf")
    result = transplant_incremental(signed, edited, landed)
    assert result["applied"] is False
    assert "structural match" in result["reason"]
    assert not os.path.exists(landed)

    assert _signature_rows(edited) == [("Signature1", True, False)]
    # …and the edit itself is right: the lanes and the indent break survive.
    after = list_text_paragraphs(edited, 1)["paragraphs"]
    assert [p["line_count"] for p in after] == [1, 3, 3, 3, 3, 3]
    assert after[3]["text"].startswith("Alve")
    assert all(_in_lane(p, LANE_ONE) for p in after[1:4])
    assert all(_in_lane(p, LANE_TWO) for p in after[4:])


@_RTL_SKIP
def test_a_signed_rtl_indent_edit_refuses_the_append_and_keeps_its_geometry(tmp_path):
    from engine.incremental import transplant_incremental

    plain = _build_justified_rtl(str(tmp_path / "rtl.pdf"))
    signed = _sign_beside(plain, str(tmp_path / "signed.pdf"), tmp_path)
    assert _signature_rows(signed) == [("Signature1", True, True)]

    para = list_text_paragraphs(signed, 1)["paragraphs"][0]
    shorter = para["text"].replace("جميلة", "جميل")
    edited = str(tmp_path / "edited.pdf")
    _rtl_edit(signed, edited, para, shorter)

    landed = str(tmp_path / "transplanted.pdf")
    result = transplant_incremental(signed, edited, landed)
    assert result["applied"] is False
    assert "structural match" in result["reason"]
    assert not os.path.exists(landed)
    assert _signature_rows(edited) == [("Signature1", True, False)]

    after = list_text_paragraphs(edited, 1)["paragraphs"]
    assert len(after) == 1
    assert after[0]["rtl"] is True
    drawn = _lines(edited)
    assert abs(drawn[0][2] - (RTL_RIGHT - RTL_INDENT)) <= EDGE_TOL
    for line in drawn[1:]:
        assert abs(line[2] - RTL_RIGHT) <= EDGE_TOL
