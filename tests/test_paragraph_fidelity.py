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
    _join_paragraphs,
    _Line,
    list_text_paragraphs,
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
