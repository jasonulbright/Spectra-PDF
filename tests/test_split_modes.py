"""Split modes beyond page ranges: every-n, file size, top-level bookmarks.

Design: docs/architecture/59-p25-split-modes.md. The range mode's own
behaviour is covered in test_engine.py (TestSplit) and its AcroForm carry in
test_acroform_carry.py (TestSplitForms); this file covers the three added
modes, the shared naming rule, and the claim that every mode goes through the
one form-aware writer.
"""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

from engine.forms import read_form_fields
from engine.fs_names import safe_file_name, unique_name
from engine.outline import set_outline
from engine.split import split


def _pages_pdf(path: str, count: int, filler: int = 0) -> None:
    """`count` pages, each with a marker and `filler` bytes of INCOMPRESSIBLE
    padding — random bytes, so a size-mode part's measured size tracks its
    page count instead of collapsing under Flate."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
                   Encoding=Name.WinAnsiEncoding)
    )
    for i in range(count):
        page = pdf.add_blank_page(page_size=(200, 200))
        page.Resources = Dictionary(Font=Dictionary(F0=font))
        body = f"BT /F0 12 Tf 20 100 Td (MARK{i + 1}) Tj ET".encode("ascii")
        if filler:
            body += b"\n% " + os.urandom(filler).hex().encode("ascii")
        page.Contents = pdf.make_stream(body)
    pdf.save(path)
    pdf.close()


def _names(result: dict) -> list[str]:
    return [os.path.basename(p) for p in result["outputs"]]


def _page_counts(result: dict) -> list[int]:
    counts = []
    for out in result["outputs"]:
        with pikepdf.open(out) as pdf:
            counts.append(len(pdf.pages))
    return counts


# ── every-n ───────────────────────────────────────────────────────────────


class TestEveryN:
    def test_exact_division(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out")
        _pages_pdf(src, 6)
        result = split(file=src, output_dir=out, mode="every_n", every_n=2)
        assert result["parts"] == 3
        assert result["pages_extracted"] == 6
        assert _page_counts(result) == [2, 2, 2]
        assert _names(result) == ["in_1-2.pdf", "in_3-4.pdf", "in_5-6.pdf"]

    def test_remainder_tail(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out")
        _pages_pdf(src, 7)
        result = split(file=src, output_dir=out, mode="every_n", every_n=3)
        assert _page_counts(result) == [3, 3, 1]
        # A one-page part names ONE page number, not a degenerate span.
        assert _names(result)[-1] == "in_7.pdf"

    def test_n_larger_than_the_document(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out")
        _pages_pdf(src, 3)
        result = split(file=src, output_dir=out, mode="every_n", every_n=50)
        assert result["parts"] == 1
        assert _page_counts(result) == [3]

    def test_one_page_each(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out")
        _pages_pdf(src, 4)
        result = split(file=src, output_dir=out, mode="every_n", every_n=1)
        assert _page_counts(result) == [1, 1, 1, 1]
        assert _names(result) == ["in_1.pdf", "in_2.pdf", "in_3.pdf", "in_4.pdf"]

    def test_pages_land_in_document_order(self, tmp_dir):
        from engine.extract_text import extract_text

        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out")
        _pages_pdf(src, 4)
        result = split(file=src, output_dir=out, mode="every_n", every_n=2)
        assert "MARK1" in extract_text(result["outputs"][0])["text"]
        assert "MARK3" in extract_text(result["outputs"][1])["text"]

    def test_zero_and_negative_refuse(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out")
        _pages_pdf(src, 3)
        for bad in (0, -2):
            with pytest.raises(ValueError, match="at least 1"):
                split(file=src, output_dir=out, mode="every_n", every_n=bad)


# ── size ──────────────────────────────────────────────────────────────────


class TestSize:
    def test_every_part_is_under_the_cap(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out")
        # ~8 KB of incompressible filler per page.
        _pages_pdf(src, 8, filler=4000)
        cap_mb = 0.03
        result = split(file=src, output_dir=out, mode="size", max_mb=cap_mb)
        assert result["oversize"] == []
        assert result["parts"] > 1
        assert sum(_page_counts(result)) == 8
        for path in result["outputs"]:
            assert os.path.getsize(path) <= cap_mb * 1_000_000

    def test_the_boundary_page_opens_the_next_part(self, tmp_dir):
        """A page that would push the current part over the cap starts the
        NEXT part; it is never dropped and never written twice."""
        from engine.extract_text import extract_text

        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out")
        _pages_pdf(src, 6, filler=4000)
        result = split(file=src, output_dir=out, mode="size", max_mb=0.025)
        seen = []
        for path in result["outputs"]:
            text = extract_text(path)["text"]
            seen.extend(m for m in (f"MARK{i}" for i in range(1, 7)) if m in text)
        assert seen == [f"MARK{i}" for i in range(1, 7)]

    def test_a_page_over_the_cap_is_its_own_output_and_reported(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out")
        _pages_pdf(src, 3, filler=20000)
        # A cap far below ANY single page: every page is its own part, and
        # every one of them is reported rather than refused or silently
        # written as if it fit.
        result = split(file=src, output_dir=out, mode="size", max_mb=0.001)
        assert result["parts"] == 3
        assert _page_counts(result) == [1, 1, 1]
        assert [o["pages"] for o in result["oversize"]] == [[1], [2], [3]]
        for entry in result["oversize"]:
            assert entry["bytes"] > 0.001 * 1_000_000
            assert entry["bytes"] == os.path.getsize(entry["output"])

    def test_a_generous_cap_yields_one_part(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out")
        _pages_pdf(src, 5)
        result = split(file=src, output_dir=out, mode="size", max_mb=50)
        assert result["parts"] == 1
        assert _page_counts(result) == [5]

    def test_bad_caps_refuse(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out")
        _pages_pdf(src, 2)
        with pytest.raises(ValueError, match="greater than 0"):
            split(file=src, output_dir=out, mode="size", max_mb=0)
        with pytest.raises(ValueError, match="must be a number"):
            split(file=src, output_dir=out, mode="size", max_mb="big")


# ── bookmarks ─────────────────────────────────────────────────────────────


def _outlined(tmp_dir, name: str, pages: int, tree: list) -> str:
    plain = os.path.join(tmp_dir, f"{name}_plain.pdf")
    src = os.path.join(tmp_dir, f"{name}.pdf")
    _pages_pdf(plain, pages)
    set_outline(plain, tree, src)
    return src


class TestBookmarks:
    def test_one_part_per_top_level_entry(self, tmp_dir):
        src = _outlined(tmp_dir, "manual", 9, [
            {"title": "Intro", "page": 1, "children": []},
            {"title": "Methods", "page": 4, "children": [
                {"title": "Sub", "page": 5, "children": []},
            ]},
            {"title": "Results", "page": 7, "children": []},
        ])
        out = os.path.join(tmp_dir, "out")
        result = split(file=src, output_dir=out, mode="bookmarks")
        assert result["parts"] == 3
        assert _page_counts(result) == [3, 3, 3]
        assert _names(result) == ["001_Intro.pdf", "002_Methods.pdf", "003_Results.pdf"]
        assert result["pages_extracted"] == 9

    def test_a_nested_entry_does_not_open_a_part(self, tmp_dir):
        src = _outlined(tmp_dir, "nested", 6, [
            {"title": "Only", "page": 1, "children": [
                {"title": "A", "page": 2, "children": []},
                {"title": "B", "page": 4, "children": []},
            ]},
        ])
        out = os.path.join(tmp_dir, "out")
        result = split(file=src, output_dir=out, mode="bookmarks")
        assert result["parts"] == 1
        assert _page_counts(result) == [6]

    def test_pages_before_the_first_bookmark_form_their_own_part(self, tmp_dir):
        src = _outlined(tmp_dir, "front", 8, [
            {"title": "Chapter 1", "page": 3, "children": []},
            {"title": "Chapter 2", "page": 6, "children": []},
        ])
        out = os.path.join(tmp_dir, "out")
        result = split(file=src, output_dir=out, mode="bookmarks")
        # No page is lost, and the leading pages are named from the DOCUMENT,
        # not from a bookmark that does not describe them.
        assert result["pages_extracted"] == 8
        assert _page_counts(result) == [2, 3, 3]
        assert _names(result) == ["001_front.pdf", "002_Chapter 1.pdf", "003_Chapter 2.pdf"]

    def test_two_entries_on_one_page_make_one_part(self, tmp_dir):
        src = _outlined(tmp_dir, "same", 4, [
            {"title": "First", "page": 1, "children": []},
            {"title": "Also first", "page": 1, "children": []},
            {"title": "Later", "page": 3, "children": []},
        ])
        out = os.path.join(tmp_dir, "out")
        result = split(file=src, output_dir=out, mode="bookmarks")
        assert result["parts"] == 2
        assert _page_counts(result) == [2, 2]
        assert _names(result)[0] == "001_First.pdf"

    def test_entries_out_of_page_order_still_tile_the_document(self, tmp_dir):
        src = _outlined(tmp_dir, "unsorted", 6, [
            {"title": "Late", "page": 4, "children": []},
            {"title": "Early", "page": 1, "children": []},
        ])
        out = os.path.join(tmp_dir, "out")
        result = split(file=src, output_dir=out, mode="bookmarks")
        assert _page_counts(result) == [3, 3]
        assert _names(result) == ["001_Early.pdf", "002_Late.pdf"]

    def test_an_unresolvable_entry_opens_no_part(self, tmp_dir):
        src = _outlined(tmp_dir, "lossy", 4, [
            {"title": "Real", "page": 1, "children": []},
            {"title": "Dangling", "page": None, "children": []},
            {"title": "Real 2", "page": 3, "children": []},
        ])
        out = os.path.join(tmp_dir, "out")
        result = split(file=src, output_dir=out, mode="bookmarks")
        assert _names(result) == ["001_Real.pdf", "002_Real 2.pdf"]
        assert _page_counts(result) == [2, 2]

    def test_a_document_without_an_outline_refuses_by_name(self, tmp_dir):
        src = os.path.join(tmp_dir, "bare.pdf")
        out = os.path.join(tmp_dir, "out")
        _pages_pdf(src, 3)
        with pytest.raises(ValueError, match="no top-level bookmarks"):
            split(file=src, output_dir=out, mode="bookmarks")
        assert not os.path.isdir(out) or os.listdir(out) == []

    def test_an_outline_of_only_unresolvable_entries_refuses(self, tmp_dir):
        src = _outlined(tmp_dir, "ghosts", 3, [
            {"title": "Nowhere", "page": None, "children": []},
        ])
        out = os.path.join(tmp_dir, "out")
        with pytest.raises(ValueError, match="no top-level bookmarks"):
            split(file=src, output_dir=out, mode="bookmarks")

    def test_titles_are_sanitized_into_filenames(self, tmp_dir):
        src = _outlined(tmp_dir, "dirty", 6, [
            {"title": "A/B: notes\tand\x01more", "page": 1, "children": []},
            {"title": "CON", "page": 3, "children": []},
            {"title": "...", "page": 5, "children": []},
        ])
        out = os.path.join(tmp_dir, "out")
        result = split(file=src, output_dir=out, mode="bookmarks")
        names = _names(result)
        assert names[0] == "001_A_B_ notes_and_more.pdf"
        # A reserved DOS device name cannot be created on Windows at all.
        assert names[1] == "002_CON_.pdf"
        # A title that reduces to nothing falls back to the document's stem.
        assert names[2] == "003_dirty.pdf"
        for path in result["outputs"]:
            assert os.path.isfile(path)

    def test_repeated_titles_deduplicate(self, tmp_dir):
        src = _outlined(tmp_dir, "dupes", 6, [
            {"title": "Appendix", "page": 1, "children": []},
            {"title": "Appendix", "page": 3, "children": []},
            {"title": "Appendix", "page": 5, "children": []},
        ])
        out = os.path.join(tmp_dir, "out")
        result = split(file=src, output_dir=out, mode="bookmarks")
        # The NUMBER prefix already separates them; the dedupe is the safety
        # net for any naming that could collide.
        assert len(set(_names(result))) == 3
        assert all(os.path.isfile(p) for p in result["outputs"])


# ── the one door ──────────────────────────────────────────────────────────


def _make_form(path: str, pages: int) -> None:
    pdf = pikepdf.new()
    fields = []
    for i in range(pages):
        page = pdf.add_blank_page(page_size=(300, 300))
        widget = pdf.make_indirect(
            Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx,
                       Rect=[20, 20 + 30 * i, 200, 44 + 30 * i], F=4, P=page.obj,
                       T=pikepdf.String(f"field{i + 1}"),
                       V=pikepdf.String(f"value{i + 1}"))
        )
        page.obj["/Annots"] = Array([widget])
        fields.append(widget)
    helv = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
                   Encoding=Name.WinAnsiEncoding)
    )
    pdf.Root["/AcroForm"] = pdf.make_indirect(
        Dictionary(Fields=Array(fields), DA=pikepdf.String("/Helv 0 Tf 0 g"),
                   DR=Dictionary(Font=Dictionary(Helv=helv)))
    )
    pdf.save(path)
    pdf.close()


class TestEveryModeCarriesTheForm:
    """Every mode reaches `_render_part`, so none of them can lose the
    /AcroForm registration. Proved per mode rather than asserted once."""

    def _assert_fields(self, result, expected_first):
        for path, first in zip(result["outputs"], expected_first):
            fields = {f["name"]: f["value"] for f in read_form_fields(path)["fields"]}
            assert fields.get(f"field{first}") == f"value{first}", path
            with pikepdf.open(path) as pdf:
                assert "/AcroForm" in pdf.Root

    def test_every_n(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        out = os.path.join(tmp_dir, "out")
        _make_form(src, 6)
        result = split(file=src, output_dir=out, mode="every_n", every_n=2)
        self._assert_fields(result, [1, 3, 5])

    def test_size(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        out = os.path.join(tmp_dir, "out")
        _make_form(src, 4)
        result = split(file=src, output_dir=out, mode="size", max_mb=50)
        self._assert_fields(result, [1])

    def test_bookmarks(self, tmp_dir):
        plain = os.path.join(tmp_dir, "form_plain.pdf")
        src = os.path.join(tmp_dir, "form.pdf")
        out = os.path.join(tmp_dir, "out")
        _make_form(plain, 6)
        set_outline(plain, [
            {"title": "One", "page": 1, "children": []},
            {"title": "Two", "page": 4, "children": []},
        ], src)
        result = split(file=src, output_dir=out, mode="bookmarks")
        self._assert_fields(result, [1, 4])

    def test_a_part_sees_only_its_own_fields(self, tmp_dir):
        """The prune is destructive on the open it is given, so a shared open
        across parts would hand part 2 a tree part 1 already emptied. Each
        part re-opens the source; this is the assertion that proves it."""
        src = os.path.join(tmp_dir, "form.pdf")
        out = os.path.join(tmp_dir, "out")
        _make_form(src, 4)
        result = split(file=src, output_dir=out, mode="every_n", every_n=1)
        for index, path in enumerate(result["outputs"], start=1):
            names = {f["name"] for f in read_form_fields(path)["fields"]}
            assert names == {f"field{index}"}, path


# ── shared naming rule ────────────────────────────────────────────────────


class TestFileNames:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Chapter 1", "Chapter 1"),
            ("a/b\\c", "a_b_c"),
            ('q"uote', "q_uote"),
            ("tab\there", "tab_here"),
            ("  padded  ", "padded"),
            ("trailing...", "trailing"),
            ("CON", "CON_"),
            ("nul.pdf", "nul.pdf_"),
            ("com4", "com4_"),
            ("console", "console"),
            ("", "fallback"),
            ("   ", "fallback"),
            ("...", "fallback"),
        ],
    )
    def test_safe_file_name(self, raw, expected):
        assert safe_file_name(raw, "fallback") == expected

    def test_long_names_are_truncated(self):
        assert len(safe_file_name("x" * 400)) == 120

    def test_unique_name_suffixes(self):
        used = set()
        taken = []
        for _ in range(3):
            name = unique_name("part.pdf", used)
            used.add(name.lower())
            taken.append(name)
        assert taken == ["part.pdf", "part (2).pdf", "part (3).pdf"]


class TestModeDispatch:
    def test_an_unknown_mode_refuses_by_name(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        _pages_pdf(src, 2)
        with pytest.raises(ValueError, match="split mode must be one of"):
            split(file=src, output_dir=tmp_dir, mode="chapters")

    def test_a_missing_output_folder_refuses(self, sample_pdf):
        with pytest.raises(ValueError, match="output folder"):
            split(file=sample_pdf, ranges="1")

    def test_range_mode_keeps_its_shipped_name_and_result(self, sample_pdf, tmp_dir):
        result = split(sample_pdf, "1-3", tmp_dir)
        assert os.path.basename(result["outputs"][0]) == "split_1-3.pdf"
        assert result["pages_extracted"] == 3
        assert result["mode"] == "ranges"
