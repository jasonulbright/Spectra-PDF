"""`search_text_regions`, the glyph-accurate hit-rect door.

The claim under test is a GEOMETRY claim, so it is checked against an
authority outside our own content walk: pdfminer's per-character boxes on the
same file. Horizontally the per-code slice is exact (the brief measured ±0.00
pt and this suite pins 0.01); vertically the returned rect is the INK box —
the font's own descent and ascent, the `ink_extent_em` — so it must
CONTAIN pdfminer's character box rather than equal it, which is the whole
point: a rect that stopped at the baseline would leave the descenders of
`p g y j q` showing under the black box.
"""

import math
import os

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine.search_regions import search_text_regions


# ── fixtures ──────────────────────────────────────────────────────────────


def _simple_font(doc, base: str = "Helvetica"):
    return doc.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name(f"/{base}"),
            Encoding=Name.WinAnsiEncoding,
        )
    )


def _page_pdf(path: str, content: bytes, fonts: dict | None = None, size=(612, 792)) -> str:
    doc = pikepdf.new()
    page = doc.add_blank_page(page_size=size)
    doc_fonts = fonts if fonts is not None else {"F1": _simple_font(doc)}
    page.Resources = Dictionary(Font=Dictionary(**doc_fonts))
    page.Contents = doc.make_stream(content)
    doc.save(path)
    doc.close()
    return path


def _blank_pdf(path: str, pages: int = 1) -> str:
    doc = pikepdf.new()
    for _ in range(pages):
        doc.add_blank_page(page_size=(612, 792))
    doc.save(path)
    doc.close()
    return path


def _char_boxes(path: str):
    """Every glyph pdfminer finds, as (char, x0, y0, x1, y1), left to right."""
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTChar

    out = []
    for layout in extract_pages(path):
        stack = [layout]
        while stack:
            element = stack.pop()
            if isinstance(element, LTChar):
                out.append(
                    (element.get_text(), element.x0, element.y0, element.x1, element.y1)
                )
            stack.extend(getattr(element, "_objs", []))
    return sorted(out, key=lambda t: t[1])


def _truth_rect(path: str, needle: str, text: str):
    """pdfminer's own box for `needle` inside a single-line page of `text`."""
    boxes = _char_boxes(path)
    start = text.index(needle)
    picked = boxes[start : start + len(needle)]
    return (
        min(b[1] for b in picked),
        min(b[2] for b in picked),
        max(b[3] for b in picked),
        max(b[4] for b in picked),
    )


LINE = "John Smith lives at 12 Oak Street Portland"


def _cid_font(doc, widths: dict, mapping: dict, encoding: str = "Identity-H",
              vertical_advances: dict | None = None):
    from test_pdf_fonts import _tounicode_stream

    w_array: list = []
    for cid, width in sorted(widths.items()):
        w_array += [cid, pikepdf.Array([width])]
    descendant = Dictionary(
        Type=Name.Font,
        Subtype=Name("/CIDFontType2"),
        BaseFont=Name("/Probe"),
        CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
        DW=1000,
        W=pikepdf.Array(w_array),
    )
    if vertical_advances is not None:
        w2: list = []
        for cid, advance in sorted(vertical_advances.items()):
            w2 += [cid, pikepdf.Array([-advance, 500, advance // 2])]
        descendant["/W2"] = pikepdf.Array(w2)
        descendant["/DW2"] = pikepdf.Array([880, -1000])
    return doc.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name("/Type0"),
            BaseFont=Name("/Probe"),
            Encoding=Name(f"/{encoding}"),
            DescendantFonts=pikepdf.Array([doc.make_indirect(descendant)]),
            ToUnicode=_tounicode_stream(doc, mapping),
        )
    )


# ── geometry ──────────────────────────────────────────────────────────────


class TestHitRectGeometry:
    """The rect authority: the engine's own run walk, sliced per code."""

    def test_a_substring_rect_matches_pdfminer_horizontally(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "plain.pdf"),
            f"BT /F1 12 Tf 72 700 Td ({LINE}) Tj ET".encode("ascii"),
        )
        result = search_text_regions(file=src, query="John Smith")
        assert len(result["hits"]) == 1
        rect = result["hits"][0]["rects"][0]["rect"]
        truth = _truth_rect(src, "John Smith", LINE)
        assert abs(rect[0] - truth[0]) < 0.01
        assert abs(rect[2] - truth[2]) < 0.01

    def test_the_rect_is_the_ink_box_and_contains_pdfminers_glyph_box(self, tmp_dir):
        """The lister's rect is baseline →
        baseline + size and misses 2.48 pt of descender at 12 pt Helvetica.
        The derived MARK rect is the INK box, so it covers the glyphs."""
        text = "puppy jog"
        src = _page_pdf(
            os.path.join(tmp_dir, "desc.pdf"),
            f"BT /F1 12 Tf 72 700 Td ({text}) Tj ET".encode("ascii"),
        )
        rect = search_text_regions(file=src, query="puppy")["hits"][0]["rects"][0]["rect"]
        truth = _truth_rect(src, "puppy", text)
        assert rect[1] <= truth[1] + 0.01, "the mark stops above the descenders"
        assert rect[3] >= truth[3] - 0.01
        # And it really is below the baseline (700), not an em box starting there.
        assert rect[1] < 700.0

    def test_a_kerned_TJ_slices_at_the_right_place(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "kern.pdf"),
            b"BT /F1 12 Tf 72 700 Td [(John ) -400 (Smith ) -400 (lives)] TJ ET",
        )
        result = search_text_regions(file=src, query="Smith")
        rect = result["hits"][0]["rects"][0]["rect"]
        truth = _truth_rect(src, "Smith", "John Smith lives")
        assert abs(rect[0] - truth[0]) < 0.01
        assert abs(rect[2] - truth[2]) < 0.01

    def test_Tz_scaled_text(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "tz.pdf"),
            f"BT /F1 12 Tf 50 Tz 72 700 Td ({LINE}) Tj ET".encode("ascii"),
        )
        rect = search_text_regions(file=src, query="Smith")["hits"][0]["rects"][0]["rect"]
        truth = _truth_rect(src, "Smith", LINE)
        assert abs(rect[0] - truth[0]) < 0.01
        assert abs(rect[2] - truth[2]) < 0.01

    def test_Tc_and_Tw_spacing(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "tctw.pdf"),
            f"BT /F1 12 Tf 1.5 Tc 3 Tw 72 700 Td ({LINE}) Tj ET".encode("ascii"),
        )
        rect = search_text_regions(file=src, query="Oak")["hits"][0]["rects"][0]["rect"]
        truth = _truth_rect(src, "Oak", LINE)
        assert abs(rect[0] - truth[0]) < 0.01
        # Tc trails the LAST glyph too, so the slice's right edge is one
        # char-space wider than the ink — over-covering, the safe direction.
        assert rect[2] >= truth[2] - 0.01
        assert rect[2] - truth[2] < 2.0

    def test_a_rotated_run_lands_in_page_space(self, tmp_dir):
        """The rect falls out of `tm ∘ ctm`, so nothing special is written for
        rotated text — recorded because a first pass would exclude it."""
        angle = math.radians(30)
        a, b = math.cos(angle), math.sin(angle)
        src = _page_pdf(
            os.path.join(tmp_dir, "rot.pdf"),
            f"BT /F1 12 Tf {a:.6f} {b:.6f} {-b:.6f} {a:.6f} 200 300 Tm (John Smith) Tj ET".encode("ascii"),
        )
        result = search_text_regions(file=src, query="Smith")
        assert len(result["hits"]) == 1
        rect = result["hits"][0]["rects"][0]["rect"]
        truth = _truth_rect(src, "Smith", "John Smith")
        # An axis-aligned box around rotated glyphs is larger than pdfminer's
        # per-glyph union only by the rotation's own slack; it must CONTAIN it.
        assert rect[0] <= truth[0] + 0.5 and rect[2] >= truth[2] - 0.5
        assert rect[1] <= truth[1] + 0.5 and rect[3] >= truth[3] - 0.5

    def test_a_hit_inside_a_form_xobject(self, tmp_dir):
        path = os.path.join(tmp_dir, "form.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(612, 792))
        font = _simple_font(doc)
        form = doc.make_stream(b"BT /F1 12 Tf 0 0 Td (John Smith) Tj ET")
        form.stream_dict["/Type"] = Name("/XObject")
        form.stream_dict["/Subtype"] = Name("/Form")
        form.stream_dict["/BBox"] = pikepdf.Array([0, 0, 300, 20])
        form.stream_dict["/Resources"] = Dictionary(Font=Dictionary(F1=font))
        page.Resources = Dictionary(
            Font=Dictionary(F1=font), XObject=Dictionary(Fx=form)
        )
        page.Contents = doc.make_stream(b"q 1 0 0 1 100 500 cm /Fx Do Q")
        doc.save(path)
        doc.close()

        rect = search_text_regions(file=path, query="Smith")["hits"][0]["rects"][0]["rect"]
        # The form matrix is composed by the walk, so the rect is in PAGE space.
        assert 100 < rect[0] < 200
        assert 495 < rect[1] < 520

    def test_a_vertical_cjk_column_slices_downward(self, tmp_dir):
        """Rule 5: refusing vertical text in a redaction tool would be a whole
        document class that cannot be redacted."""
        path = os.path.join(tmp_dir, "vert.pdf")
        doc = pikepdf.new()
        mapping = {1: "上", 2: "下", 3: "左", 4: "右"}
        font = _cid_font(
            doc,
            {1: 1000, 2: 1000, 3: 1000, 4: 1000},
            mapping,
            encoding="Identity-V",
            vertical_advances={1: 1000, 2: 1000, 3: 1000, 4: 1000},
        )
        page = doc.add_blank_page(page_size=(612, 792))
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        codes = b"".join(cid.to_bytes(2, "big") for cid in (1, 2, 3, 4))
        page.Contents = doc.make_stream(
            b"BT /F1 20 Tf 300 700 Td <" + codes.hex().encode("ascii") + b"> Tj ET"
        )
        doc.save(path)
        doc.close()

        result = search_text_regions(file=path, query="下左")
        assert len(result["hits"]) == 1
        rect = result["hits"][0]["rects"][0]["rect"]
        # Two glyphs of a 20 pt column: 40 pt tall, one em wide, and NOT the
        # whole four-glyph column (that would be the un-sliced answer).
        assert abs((rect[3] - rect[1]) - 40.0) < 0.5
        assert abs((rect[2] - rect[0]) - 20.0) < 0.5
        assert result["hits"][0]["rects"][0]["partial"] is True

    def test_a_match_spanning_two_runs_yields_two_rects_not_a_bounding_box(self, tmp_dir):
        """Rule 3. A bounding box across a line wrap would cover the right
        margin, the left margin and everything between them."""
        src = _page_pdf(
            os.path.join(tmp_dir, "wrap.pdf"),
            b"BT /F1 12 Tf 400 700 Td (John) Tj 1 0 0 1 72 686 Tm (Smith) Tj ET",
        )
        result = search_text_regions(file=src, query="John Smith")
        assert len(result["hits"]) == 1
        rects = result["hits"][0]["rects"]
        assert len(rects) == 2, [r["rect"] for r in rects]
        assert rects[0]["run"] != rects[1]["run"]
        # Neither rect spans the gap between the two lines.
        for entry in rects:
            assert entry["rect"][2] - entry["rect"][0] < 60


# ── page text assembly ────────────────────────────────────────────────────


class TestPageTextAssembly:
    def test_a_query_matches_across_a_line_break(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "break.pdf"),
            b"BT /F1 12 Tf 72 700 Td (the quick brown) Tj 0 -14 Td (fox jumps) Tj ET",
        )
        result = search_text_regions(file=src, query="brown fox")
        assert len(result["hits"]) == 1
        assert len(result["hits"][0]["rects"]) == 2

    def test_a_word_gap_drawn_as_a_TJ_jump_reads_as_a_space(self, tmp_dir):
        """A generator that emits one `Tj` per word draws no space at all; a
        search that cannot see the gap matches `JohnSmith` and misses the
        name the user typed."""
        src = _page_pdf(
            os.path.join(tmp_dir, "gap.pdf"),
            b"BT /F1 12 Tf 72 700 Td (John) Tj 30 0 Td (Smith) Tj ET",
        )
        assert search_text_regions(file=src, query="John Smith")["hits"]
        assert search_text_regions(file=src, query="JohnSmith")["hits"] == []

    def test_a_ligature_code_is_markable_by_the_letters_it_spells(self, tmp_dir):
        """NFKC expands one code into several characters, and every one of
        them points back at the code that drew it — so searching `fi` marks
        the ligature glyph rather than nothing."""
        path = os.path.join(tmp_dir, "lig.pdf")
        doc = pikepdf.new()
        font = _cid_font(doc, {1: 600, 2: 500, 3: 500}, {1: "ﬁ", 2: "l", 3: "e"})
        page = doc.add_blank_page(page_size=(612, 792))
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        codes = b"".join(cid.to_bytes(2, "big") for cid in (1, 2, 3))
        page.Contents = doc.make_stream(
            b"BT /F1 12 Tf 72 700 Td <" + codes.hex().encode("ascii") + b"> Tj ET"
        )
        doc.save(path)
        doc.close()

        result = search_text_regions(file=path, query="file")
        assert len(result["hits"]) == 1
        rect = result["hits"][0]["rects"][0]["rect"]
        assert abs(rect[0] - 72.0) < 0.01


# ── expand ────────────────────────────────────────────────────────────────


class TestExpand:
    LINE = "the year 1955 and Smithers"

    def _rect(self, tmp_dir, query, expand, name):
        src = _page_pdf(
            os.path.join(tmp_dir, f"{name}.pdf"),
            f"BT /F1 12 Tf 72 700 Td ({self.LINE}) Tj ET".encode("ascii"),
        )
        hit = search_text_regions(file=src, query=query, expand=expand)["hits"][0]
        return hit, _truth_rect(src, self.LINE, self.LINE)

    def test_match_marks_exactly_what_matched(self, tmp_dir):
        hit, _ = self._rect(tmp_dir, "55", "match", "m")
        assert hit["text"] == "55"

    def test_word_grows_to_the_whitespace_delimited_word(self, tmp_dir):
        hit, _ = self._rect(tmp_dir, "55", "word", "w")
        assert hit["text"] == "1955"

    def test_line_takes_the_whole_run(self, tmp_dir):
        hit, line = self._rect(tmp_dir, "55", "line", "l")
        entry = hit["rects"][0]
        assert entry["partial"] is False
        assert abs(entry["rect"][0] - line[0]) < 0.01
        assert entry["rect"][2] >= line[2] - 0.01

    def test_an_unknown_expand_refuses(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "e.pdf"),
            b"BT /F1 12 Tf 72 700 Td (hello) Tj ET",
        )
        with pytest.raises(ValueError):
            search_text_regions(file=src, query="hello", expand="paragraph")


# ── patterns, scope, refusals ─────────────────────────────────────────────


class TestPatternsAndScope:
    def test_a_pattern_hit_names_the_pattern_that_produced_it(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "pat.pdf"),
            b"BT /F1 12 Tf 72 700 Td (write to jane@example.com now) Tj ET",
        )
        result = search_text_regions(file=src, patterns=["email"])
        assert [h["source"] for h in result["hits"]] == ["email"]
        assert result["hits"][0]["text"] == "jane@example.com"

    def test_patterns_are_additive_to_the_query(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "add.pdf"),
            b"BT /F1 12 Tf 72 700 Td (Smith jane@example.com) Tj ET",
        )
        result = search_text_regions(file=src, query="Smith", patterns=["email"])
        assert sorted(h["source"] for h in result["hits"]) == ["email", "query"]

    def test_a_word_list_is_or_ed(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "list.pdf"),
            f"BT /F1 12 Tf 72 700 Td ({LINE}) Tj ET".encode("ascii"),
        )
        result = search_text_regions(file=src, terms=["Smith", "Oak"])
        assert [h["text"] for h in result["hits"]] == ["Smith", "Oak"]

    def test_two_sources_naming_the_same_characters_are_one_hit(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "dup.pdf"),
            b"BT /F1 12 Tf 72 700 Td (jane@example.com) Tj ET",
        )
        result = search_text_regions(
            file=src, query="jane@example.com", patterns=["email"]
        )
        assert len(result["hits"]) == 1

    def test_a_page_selection_searches_only_those_pages(self, tmp_dir):
        path = os.path.join(tmp_dir, "multi.pdf")
        doc = pikepdf.new()
        for word in ("alpha", "beta", "gamma"):
            page = doc.add_blank_page(page_size=(612, 792))
            page.Resources = Dictionary(Font=Dictionary(F1=_simple_font(doc)))
            page.Contents = doc.make_stream(
                f"BT /F1 12 Tf 72 700 Td ({word} target) Tj ET".encode("ascii")
            )
        doc.save(path)
        doc.close()
        result = search_text_regions(file=path, query="target", pages=[2])
        assert [h["page"] for h in result["hits"]] == [2]
        assert result["pages_searched"] == 1

    def test_a_page_out_of_range_refuses(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "one.pdf"),
            b"BT /F1 12 Tf 72 700 Td (hello) Tj ET",
        )
        with pytest.raises(ValueError):
            search_text_regions(file=src, query="hello", pages=[4])


class TestRefusalsAndReports:
    def test_searching_for_nothing_refuses_by_name(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "n.pdf"), b"BT /F1 12 Tf 72 700 Td (hello) Tj ET"
        )
        with pytest.raises(ValueError) as exc:
            search_text_regions(file=src, query="   ")
        assert "word list" in str(exc.value)

    def test_an_invalid_regex_is_reported_not_raised(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "r.pdf"), b"BT /F1 12 Tf 72 700 Td (hello) Tj ET"
        )
        result = search_text_regions(file=src, query="(unclosed", regex=True)
        assert result["error"]
        assert result["hits"] == []

    def test_an_unknown_pattern_refuses_and_lists_the_ids(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "p.pdf"), b"BT /F1 12 Tf 72 700 Td (hello) Tj ET"
        )
        with pytest.raises(ValueError) as exc:
            search_text_regions(file=src, patterns=["passport"])
        assert "passport" in str(exc.value) and "credit_card" in str(exc.value)

    def test_a_page_with_no_text_is_reported_per_page(self, tmp_dir):
        """Never a silent shortfall on a scanned set: the panel's second
        authority (the in-memory OCR word boxes) covers these pages, and it
        can only do that if it is told which ones they are."""
        path = os.path.join(tmp_dir, "mixed.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(612, 792))
        page.Resources = Dictionary(Font=Dictionary(F1=_simple_font(doc)))
        page.Contents = doc.make_stream(b"BT /F1 12 Tf 72 700 Td (target) Tj ET")
        doc.add_blank_page(page_size=(612, 792))
        doc.save(path)
        doc.close()
        result = search_text_regions(file=path, query="target")
        assert result["pages_without_text"] == [2]

    def test_max_hits_truncates_and_says_so(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "many.pdf"),
            b"BT /F1 12 Tf 72 700 Td (aa aa aa aa aa) Tj ET",
        )
        result = search_text_regions(file=src, query="aa", max_hits=3)
        assert result["truncated"] is True
        assert len(result["hits"]) == 3

    def test_max_hits_must_be_positive(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "z.pdf"), b"BT /F1 12 Tf 72 700 Td (hello) Tj ET"
        )
        with pytest.raises(ValueError):
            search_text_regions(file=src, query="hello", max_hits=0)

    def test_an_unmeasurable_run_is_reported_imprecise_and_whole_never_dropped(
        self, tmp_dir
    ):
        """A run whose font will not measure still yields a hit — its FULL
        rect, over-covering, flagged. A DROPPED hit is content the user does
        not redact."""
        path = os.path.join(tmp_dir, "unmeasured.pdf")
        doc = pikepdf.new()
        # A Type3 font: no declared widths this walker can trust.
        font = doc.make_indirect(
            Dictionary(
                Type=Name.Font,
                Subtype=Name.Type1,
                BaseFont=Name("/Unknowable"),
                Encoding=Name.WinAnsiEncoding,
            )
        )
        page = doc.add_blank_page(page_size=(612, 792))
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(b"BT /F1 12 Tf 72 700 Td (Smith) Tj ET")
        doc.save(path)
        doc.close()
        result = search_text_regions(file=path, query="Smith")
        assert len(result["hits"]) == 1
        entry = result["hits"][0]["rects"][0]
        assert entry["imprecise"] is True
        assert entry["partial"] is False


class TestClippedRunsAreNotOffered:
    def test_a_run_clipped_entirely_away_is_invisible_and_not_a_hit(self, tmp_dir):
        src = _page_pdf(
            os.path.join(tmp_dir, "clip.pdf"),
            b"q 0 0 10 10 re W n BT /F1 12 Tf 300 700 Td (Smith) Tj ET Q",
        )
        assert search_text_regions(file=src, query="Smith")["hits"] == []
