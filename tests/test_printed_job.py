"""A job taken from the held print queue, laid out the way the print system
would have laid it out: pages per sheet, their order on the sheet, reverse
order, and text and image sources converted through Create PDF."""

import re
import struct
import zlib
from pathlib import Path

import pikepdf
import pytest

from engine.print_layout import number_up_cells, printed_job


def _pdf(path: Path, sizes: list[tuple[float, float]]) -> str:
    """One page per size; page i draws the marker `(Pi) Tj` so placement and
    order can be read back from the content."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
        )
    )
    for i, (w, h) in enumerate(sizes):
        page = pdf.add_blank_page(page_size=(w, h))
        page.obj["/Resources"] = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = pdf.make_stream(f"BT /F1 24 Tf 72 72 Td (P{i + 1}) Tj ET".encode())
    pdf.save(path)
    return str(path)


def _markers(page) -> list[str]:
    """The page markers a page draws, in drawing order, through its XObjects."""
    found: list[str] = []

    def walk(stream_owner, resources):
        for operands, operator in pikepdf.parse_content_stream(stream_owner):
            if operator == pikepdf.Operator("Tj"):
                found.append(bytes(operands[0]).decode())
            elif operator == pikepdf.Operator("Do"):
                xobj = resources.XObject[operands[0]]
                walk(xobj, xobj.get("/Resources", resources))

    walk(page, page.obj.Resources)
    return found


def _placements(page) -> list[tuple[float, float]]:
    """(e, f) of each `cm` before a `Do`: where each cell's page lands."""
    out = []
    for operands, operator in pikepdf.parse_content_stream(page):
        if operator == pikepdf.Operator("cm"):
            out.append((float(operands[4]), float(operands[5])))
    return out


def _png(path: Path, w: int, h: int) -> str:
    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"".join(b"\x00" + b"\xff\x00\x00" * w for _ in range(h))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )
    return str(path)


A4 = (595.28, 841.89)


def _assert_refused(result: dict, match: str = "") -> None:
    """A refusal is a result, not an exception: the job's bytes or options
    cannot be printed, and delivery removes the job."""
    assert "refused" in result, result
    if match:
        assert re.search(match, result["refused"]), result["refused"]


def _filled_form(path: Path, value: str, pages: int = 2) -> str:
    """A text field on page 1 holding ``value`` with no appearance stream and
    /NeedAppearances true: the value exists only as field data."""
    _pdf(path, [A4] * pages)
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        helv = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
            )
        )
        field = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Annot,
                Subtype=pikepdf.Name.Widget,
                FT=pikepdf.Name.Tx,
                T=pikepdf.String("name"),
                V=pikepdf.String(value),
                DA=pikepdf.String("/Helv 12 Tf 0 g"),
                Rect=pikepdf.Array([72, 600, 372, 630]),
                F=4,
                P=pdf.pages[0].obj,
            )
        )
        pdf.pages[0].obj["/Annots"] = pikepdf.Array([field])
        pdf.Root.AcroForm = pikepdf.Dictionary(
            Fields=pikepdf.Array([field]),
            NeedAppearances=True,
            DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=helv)),
            DA=pikepdf.String("/Helv 12 Tf 0 g"),
        )
        pdf.save(path)
    return str(path)


def _drawn_bytes(page) -> bytes:
    """Every content stream a page draws, through its form XObjects."""
    out = bytearray()

    def walk(owner, resources):
        if isinstance(owner, pikepdf.Stream):
            out.extend(owner.read_bytes())
        else:
            for stream in owner.Contents if isinstance(owner.Contents, pikepdf.Array) else [owner.Contents]:
                out.extend(stream.read_bytes())
        xobjects = resources.get("/XObject", {}) if resources is not None else {}
        for name in xobjects.keys():
            xobj = xobjects[name]
            if xobj.get("/Subtype") == pikepdf.Name.Form:
                walk(xobj, xobj.get("/Resources"))

    walk(page.obj, page.obj.get("/Resources"))
    return bytes(out)


class TestNumberUp:
    def test_two_up_puts_two_pages_on_each_landscape_sheet(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 3)
        out = Path(tmp_dir) / "out.pdf"
        result = printed_job(src, str(out), number_up=2, sheet_width=A4[0], sheet_height=A4[1])
        assert result["sheets"] == 2
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 2
            box = [float(v) for v in pdf.pages[0].mediabox]
            assert box[2] > box[3], "a 2-up sheet is landscape"
            assert _markers(pdf.pages[0]) == ["P1", "P2"]
            assert _markers(pdf.pages[1]) == ["P3"]

    def test_four_up_fills_a_portrait_sheet(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 4)
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), number_up=4)
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 1
            box = [float(v) for v in pdf.pages[0].mediabox]
            assert box[3] > box[2]
            assert _markers(pdf.pages[0]) == ["P1", "P2", "P3", "P4"]

    def test_an_unoffered_count_is_refused_by_name(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4])
        _assert_refused(printed_job(src, str(Path(tmp_dir) / "out.pdf"), number_up=3), "3 pages per sheet")


class TestNumberUpLayout:
    @pytest.mark.parametrize(
        "layout, first_cell",
        [
            ("lrtb", "top-left"),
            ("rltb", "top-right"),
            ("lrbt", "bottom-left"),
            ("rlbt", "bottom-right"),
            ("tblr", "top-left"),
            ("tbrl", "top-right"),
            ("btlr", "bottom-left"),
            ("btrl", "bottom-right"),
        ],
    )
    def test_the_first_page_lands_in_the_layouts_first_cell(self, layout, first_cell):
        _, sh, cells = number_up_cells(*A4, 4, layout)
        x, y, w, h = cells[0]
        assert ("top" if y + h == pytest.approx(sh) else "bottom") + "-" + (
            "left" if x == 0 else "right"
        ) == first_cell

    def test_rows_and_columns_order_the_second_page(self):
        _, _, across = number_up_cells(*A4, 4, "lrtb")
        _, _, down = number_up_cells(*A4, 4, "tblr")
        assert across[1][1] == across[0][1] and across[1][0] > across[0][0]
        assert down[1][0] == down[0][0] and down[1][1] < down[0][1]

    def test_the_layout_reaches_the_sheet(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 2)
        left = Path(tmp_dir) / "lr.pdf"
        right = Path(tmp_dir) / "rl.pdf"
        printed_job(src, str(left), number_up=2, number_up_layout="lrtb")
        printed_job(src, str(right), number_up=2, number_up_layout="rltb")
        with pikepdf.open(left) as a, pikepdf.open(right) as b:
            (ax1, _), (ax2, _) = _placements(a.pages[0])
            (bx1, _), (bx2, _) = _placements(b.pages[0])
            assert ax1 < ax2, "left to right: the first page is on the left"
            assert bx1 > bx2, "right to left: the first page is on the right"

    def test_an_unknown_layout_is_refused_by_name(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4])
        _assert_refused(printed_job(src, str(Path(tmp_dir) / "out.pdf"), number_up=2, number_up_layout="zigzag"), "'zigzag'")


class TestReverse:
    def test_reverse_writes_the_pages_back_to_front(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 3)
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), reverse=True)
        with pikepdf.open(out) as pdf:
            assert [_markers(p) for p in pdf.pages] == [["P3"], ["P2"], ["P1"]]

    def test_reverse_after_number_up_reverses_the_sheets(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 3)
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), number_up=2, reverse=True)
        with pikepdf.open(out) as pdf:
            assert [_markers(p) for p in pdf.pages] == [["P3"], ["P1", "P2"]]

    def test_no_option_keeps_the_pages(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 2)
        out = Path(tmp_dir) / "out.pdf"
        result = printed_job(src, str(out))
        assert result["prepass"] == []
        with pikepdf.open(out) as pdf:
            assert [_markers(p) for p in pdf.pages] == [["P1"], ["P2"]]


class TestFormValues:
    def test_a_field_without_an_appearance_keeps_its_value_two_up(self, tmp_dir):
        src = _filled_form(Path(tmp_dir) / "form.pdf", "FILLED-VALUE")
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), number_up=2, sheet_width=A4[0], sheet_height=A4[1])
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 1
            assert b"FILLED-VALUE" in _drawn_bytes(pdf.pages[0])

    def test_one_up_keeps_the_field_itself(self, tmp_dir):
        src = _filled_form(Path(tmp_dir) / "form.pdf", "FILLED-VALUE")
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out))
        with pikepdf.open(out) as pdf:
            assert str(pdf.Root.AcroForm.Fields[0].V) == "FILLED-VALUE"


class TestOutput:
    def test_the_output_may_not_be_the_job(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4])
        before = Path(src).read_bytes()
        _assert_refused(printed_job(src, src, reverse=True), "printed job itself")
        assert Path(src).read_bytes() == before


class TestConvertedSources:
    def test_an_image_converts_and_lays_out(self, tmp_dir):
        src = _png(Path(tmp_dir) / "job.png", 40, 20)
        out = Path(tmp_dir) / "out.pdf"
        result = printed_job(src, str(out), number_up=2, sheet_width=A4[0], sheet_height=A4[1])
        assert result["prepass"][0] == "convert:image"
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 1

    def test_text_converts(self, tmp_dir, soffice_path):
        src = Path(tmp_dir) / "job.txt"
        src.write_text("held words\n", encoding="utf-8")
        out = Path(tmp_dir) / "out.pdf"
        result = printed_job(str(src), str(out), soffice_path=soffice_path)
        assert result["prepass"] == ["convert:text"]
        assert result["pages"] == 1

    def test_text_holding_markup_prints_as_the_characters_sent(self, tmp_dir, soffice_path):
        from pdfminer.high_level import extract_text

        from engine import soffice

        # A flat OpenDocument file: LibreOffice's type detection imports it as
        # a document when it arrives under a .txt name.
        markup = (
            '<?xml version="1.0"?>\n'
            '<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
            'office:mimetype="application/vnd.oasis.opendocument.text"><office:body>'
            '<office:text><text:p xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">'
            "BODY-ONLY</text:p></office:text></office:body></office:document>\n"
        )
        src = Path(tmp_dir) / "job.txt"
        src.write_text(markup, encoding="utf-8")
        sniffed = Path(tmp_dir) / "sniffed.pdf"
        soffice.to_pdf(str(src), str(sniffed), soffice_path)
        assert "office:document" not in extract_text(str(sniffed)), (
            "without a named filter the text is imported as a document; the control no longer holds"
        )
        out = Path(tmp_dir) / "out.pdf"
        printed_job(str(src), str(out), soffice_path=soffice_path)
        assert "<office:document" in extract_text(str(out))


class TestUnreadableJob:
    def test_a_user_password_job_refuses_a_layout_it_cannot_read(self, tmp_dir):
        src = Path(tmp_dir) / "locked.pdf"
        _pdf(src, [A4] * 2)
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            pdf.save(src, encryption=pikepdf.Encryption(user="u", owner="o"))
        out = Path(tmp_dir) / "out.pdf"
        _assert_refused(printed_job(str(src), str(out), number_up=2))
        assert not out.exists(), "a refused layout writes nothing; delivery copies the job as sent"


class TestPageSelection:
    def test_page_set_selects_document_pages_before_number_up(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 5)
        out = Path(tmp_dir) / "out.pdf"
        result = printed_job(src, str(out), page_set="odd", number_up=2)
        assert result["printed_pages"] == 3
        with pikepdf.open(out) as pdf:
            assert [_markers(p) for p in pdf.pages] == [["P1", "P3"], ["P5"]]

    def test_even_pages_one_up_keep_the_pages_themselves(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 4)
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), page_set="even")
        with pikepdf.open(out) as pdf:
            assert [_markers(p) for p in pdf.pages] == [["P2"], ["P4"]]
            assert "/XObject" not in pdf.pages[0].obj.Resources, "no imposition for a selection alone"

    def test_ranges_and_page_set_combine_then_reverse(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 6)
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), page_ranges="2-5", page_set="odd", reverse=True)
        with pikepdf.open(out) as pdf:
            assert [_markers(p) for p in pdf.pages] == [["P5"], ["P3"]]

    def test_a_selection_of_no_page_is_refused_by_name(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4])
        _assert_refused(printed_job(src, str(Path(tmp_dir) / "out.pdf"), page_set="even"), "selects none of the job's 1 pages")

    @pytest.mark.parametrize("ranges", ["0-2", "3-1", "x", "1,,2"])
    def test_a_malformed_range_is_refused_by_name(self, tmp_dir, ranges):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4])
        _assert_refused(printed_job(src, str(Path(tmp_dir) / "out.pdf"), page_ranges=ranges), "page range")


def _scale_of(page) -> float:
    """The scale of the first placement `cm` on a sheet."""
    for operands, operator in pikepdf.parse_content_stream(page):
        if operator == pikepdf.Operator("cm"):
            a, b = float(operands[0]), float(operands[1])
            return (a * a + b * b) ** 0.5
    raise AssertionError("no placement")


LETTER = (612.0, 792.0)


class TestScaling:
    def test_fit_scales_a_small_page_up_to_the_sheet(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [(306.0, 396.0)])
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), scaling="fit", sheet_width=LETTER[0], sheet_height=LETTER[1])
        with pikepdf.open(out) as pdf:
            assert [float(v) for v in pdf.pages[0].mediabox] == [0, 0, *LETTER]
            assert _scale_of(pdf.pages[0]) == pytest.approx(2.0)
            assert _markers(pdf.pages[0]) == ["P1"]

    def test_auto_fit_shrinks_only_a_page_larger_than_the_sheet(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [(306.0, 396.0), (1224.0, 1584.0)])
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), scaling="auto-fit", sheet_width=LETTER[0], sheet_height=LETTER[1])
        with pikepdf.open(out) as pdf:
            assert _scale_of(pdf.pages[0]) == pytest.approx(1.0)
            assert _scale_of(pdf.pages[1]) == pytest.approx(0.5)

    def test_fill_covers_the_sheet_and_clips_to_it(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [(400.0, 400.0)])
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), scaling="fill", sheet_width=LETTER[0], sheet_height=LETTER[1])
        with pikepdf.open(out) as pdf:
            assert _scale_of(pdf.pages[0]) == pytest.approx(792.0 / 400.0)
            ops = [str(op) for _, op in pikepdf.parse_content_stream(pdf.pages[0])]
            assert ops[:3] == ["q", "re", "W"]

    def test_a_percentage_scales_the_fitted_page(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [LETTER])
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), scaling="50")
        with pikepdf.open(out) as pdf:
            assert _scale_of(pdf.pages[0]) == pytest.approx(0.5)

    def test_a_pdf_job_applies_its_scaling_percentage(self, tmp_dir):
        """The CUPS PDF filter ignores `scaling`; delivery applies it to every
        job format, a PDF included."""
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 2)
        out = Path(tmp_dir) / "out.pdf"
        result = printed_job(src, str(out), scaling="50")
        assert result["prepass"] == ["scaling:50"]
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 2
            for page in pdf.pages:
                assert [float(v) for v in page.mediabox] == pytest.approx([0, 0, *A4])
                assert _scale_of(page) == pytest.approx(0.5, rel=1e-3)
            assert [_markers(p) for p in pdf.pages] == [["P1"], ["P2"]]

    def test_fit_of_pages_already_the_sheets_size_copies_the_job(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 2)
        out = Path(tmp_dir) / "out.pdf"
        result = printed_job(src, str(out), scaling="fit")
        assert result["prepass"] == []
        assert out.read_bytes() == Path(src).read_bytes()

    def test_scaling_applies_inside_number_up_cells(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 2)
        fit = Path(tmp_dir) / "fit.pdf"
        half = Path(tmp_dir) / "half.pdf"
        printed_job(src, str(fit), number_up=2)
        printed_job(src, str(half), number_up=2, scaling="50")
        with pikepdf.open(fit) as a, pikepdf.open(half) as b:
            assert _scale_of(b.pages[0]) == pytest.approx(_scale_of(a.pages[0]) / 2, rel=1e-3)

    @pytest.mark.parametrize("scaling", ["0", "801", "stretch", "-5"])
    def test_an_unknown_scaling_is_refused_by_name(self, tmp_dir, scaling):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4])
        _assert_refused(printed_job(src, str(Path(tmp_dir) / "out.pdf"), scaling=scaling), "unknown scaling")


class TestMirror:
    def test_mirror_flips_each_page_about_its_own_width(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4, (300.0, 500.0)])
        out = Path(tmp_dir) / "out.pdf"
        result = printed_job(src, str(out), mirror=True)
        assert result["prepass"] == ["mirror"]
        with pikepdf.open(out) as pdf:
            for page, width in zip(pdf.pages, (A4[0], 300.0)):
                operands, operator = list(pikepdf.parse_content_stream(page))[1]
                assert str(operator) == "cm"
                assert [float(v) for v in operands] == pytest.approx([-1, 0, 0, 1, width, 0])
            assert [_markers(p) for p in pdf.pages] == [["P1"], ["P2"]]

    def test_mirror_after_number_up_flips_the_whole_sheet(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 2)
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), number_up=2, mirror=True)
        with pikepdf.open(out) as pdf:
            sheet_w = float(pdf.pages[0].mediabox[2])
            operands, _ = list(pikepdf.parse_content_stream(pdf.pages[0]))[1]
            assert [float(v) for v in operands] == pytest.approx([-1, 0, 0, 1, sheet_w, 0])

    def test_a_rotated_page_mirrors_across_its_displayed_width(self, tmp_dir):
        src = Path(tmp_dir) / "in.pdf"
        _pdf(src, [(300.0, 500.0)])
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            pdf.pages[0].obj["/Rotate"] = 90
            pdf.save(src)
        out = Path(tmp_dir) / "out.pdf"
        printed_job(str(src), str(out), mirror=True)
        with pikepdf.open(out) as pdf:
            operands, _ = list(pikepdf.parse_content_stream(pdf.pages[0]))[1]
            assert [float(v) for v in operands] == pytest.approx([1, 0, 0, -1, 0, 500.0])


class TestOpenEndedRanges:
    @pytest.mark.parametrize(
        "ranges, printed",
        [
            ("3-", ["P3", "P4", "P5"]),
            ("3-2147483647", ["P3", "P4", "P5"]),
            ("-2", ["P1", "P2"]),
            ("4-99", ["P4", "P5"]),
            ("2,4-", ["P2", "P4", "P5"]),
        ],
    )
    def test_a_range_past_the_last_page_runs_through_it(self, tmp_dir, ranges, printed):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 5)
        out = Path(tmp_dir) / "out.pdf"
        printed_job(src, str(out), page_ranges=ranges)
        with pikepdf.open(out) as pdf:
            assert [m for p in pdf.pages for m in _markers(p)] == printed

    def test_a_lower_bound_past_the_last_page_selects_nothing(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 2)
        _assert_refused(
            printed_job(src, str(Path(tmp_dir) / "out.pdf"), page_ranges="7-"),
            "selects none of the job's 2 pages",
        )

    @pytest.mark.parametrize("ranges", ["-", "3--4", "1-2-3"])
    def test_a_range_without_bounds_is_refused(self, tmp_dir, ranges):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4])
        _assert_refused(printed_job(src, str(Path(tmp_dir) / "out.pdf"), page_ranges=ranges), "page range")


LATIN = "Grüße, Ærø, café, ½ — naïve façade"


class TestTextCharacterSets:
    def _printed_text(self, tmp_dir, data: bytes, soffice_path, charset: str = "") -> tuple[str, dict]:
        from pdfminer.high_level import extract_text

        src = Path(tmp_dir) / "job.txt"
        src.write_bytes(data)
        out = Path(tmp_dir) / "out.pdf"
        result = printed_job(str(src), str(out), charset=charset, soffice_path=soffice_path)
        assert "refused" not in result, result
        return extract_text(str(out)), result

    def test_declared_latin1_prints_the_characters_sent(self, tmp_dir, soffice_path):
        text, result = self._printed_text(tmp_dir, LATIN.replace("—", "-").encode("latin-1"), soffice_path, "ISO-8859-1")
        assert LATIN.replace("—", "-") in text
        assert result["notes"] == []

    def test_undeclared_latin1_is_read_as_windows_1252_and_says_so(self, tmp_dir, soffice_path):
        text, result = self._printed_text(tmp_dir, LATIN.encode("cp1252"), soffice_path)
        assert LATIN in text
        assert result["notes"] == [
            "the text job named no character set it could be read in and is not UTF-8, so it "
            "was read as windows-1252"
        ]

    @pytest.mark.parametrize("encoding", ["utf-16", "utf-16-le", "utf-16-be"])
    def test_utf16_with_a_byte_order_mark_prints_the_characters_sent(self, tmp_dir, soffice_path, encoding):
        data = LATIN.encode(encoding)
        if encoding != "utf-16":
            data = ("﻿" + LATIN).encode(encoding)
        text, result = self._printed_text(tmp_dir, data, soffice_path)
        assert LATIN in text
        assert result["notes"] == []

    def test_declared_utf16_without_a_mark_prints_the_characters_sent(self, tmp_dir, soffice_path):
        text, _ = self._printed_text(tmp_dir, LATIN.encode("utf-16-be"), soffice_path, "UTF-16BE")
        assert LATIN in text

    def test_utf8_with_a_byte_order_mark_prints_without_the_mark(self, tmp_dir, soffice_path):
        text, result = self._printed_text(tmp_dir, b"\xef\xbb\xbf" + LATIN.encode(), soffice_path)
        assert text.lstrip().startswith(LATIN)
        assert result["notes"] == []

    @pytest.mark.parametrize("charset", ["x-klingon", "base64", "hex", "rot13", "zip"])
    def test_a_charset_that_is_unknown_or_not_text_is_detected_and_noted(self, tmp_dir, soffice_path, charset):
        text, result = self._printed_text(tmp_dir, LATIN.encode("cp1252"), soffice_path, charset)
        assert LATIN in text
        assert result["notes"] == [
            f"the text job's character set {charset!r} is not one Spectra PDF reads, so its "
            "character set was detected",
            "the text job named no character set it could be read in and is not UTF-8, so it "
            "was read as windows-1252",
        ]

    def test_bytes_the_declared_charset_does_not_define_are_replaced_and_noted(self, tmp_dir, soffice_path):
        text, result = self._printed_text(tmp_dir, "café".encode("latin-1") + b" ok", soffice_path, "utf-8")
        assert "caf" in text and "ok" in text
        assert result["notes"] == ["the text job holds bytes that are not utf-8 text; they print as \ufffd"]


class TestRefusalOrRetry:
    """A refusal (a result) removes the job; a raised failure keeps it for a
    later attempt."""

    def test_a_pdf_that_cannot_be_read_is_refused(self, tmp_dir):
        src = Path(tmp_dir) / "broken.pdf"
        src.write_bytes(b"%PDF-1.7\n1 0 obj<<garbage")
        _assert_refused(printed_job(str(src), str(Path(tmp_dir) / "out.pdf"), number_up=2))

    def test_a_pdf_with_no_output_folder_raises(self, tmp_dir):
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 2)
        with pytest.raises(OSError):
            printed_job(src, str(Path(tmp_dir) / "gone" / "out.pdf"), reverse=True)

    def test_an_image_with_a_valid_signature_and_a_corrupt_body_is_refused(self, tmp_dir):
        src = Path(tmp_dir) / "job.png"
        src.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\x0dIHDR" + b"\xff" * 40)
        _assert_refused(printed_job(str(src), str(Path(tmp_dir) / "out.pdf")))

    def test_an_image_with_no_output_folder_raises(self, tmp_dir):
        src = _png(Path(tmp_dir) / "job.png", 4, 4)
        with pytest.raises(OSError):
            printed_job(src, str(Path(tmp_dir) / "gone" / "out.pdf"))

    def test_postscript_the_interpreter_rejects_is_kept(self, tmp_dir, gs_path):
        """Ghostscript exits non-zero for bad PostScript and for an I/O error
        alike, so its failure keeps the job; delivery caps the attempts."""
        src = Path(tmp_dir) / "job.ps"
        src.write_bytes(b"%!PS\n/undefinedname_x9 cvx exec }}} showpage\n")
        with pytest.raises(RuntimeError, match="Ghostscript failed"):
            printed_job(str(src), str(Path(tmp_dir) / "out.pdf"), gs_path=gs_path)

    def test_postscript_without_ghostscript_raises(self, tmp_dir):
        from engine.gs_capability import GsUnavailable

        src = Path(tmp_dir) / "job.ps"
        src.write_bytes(b"%!PS\nshowpage\n")
        with pytest.raises(GsUnavailable):
            printed_job(str(src), str(Path(tmp_dir) / "out.pdf"), gs_path=str(Path(tmp_dir) / "no-gs"))

    def test_text_with_nothing_to_print_is_refused(self, tmp_dir, soffice_path):
        src = Path(tmp_dir) / "job.txt"
        src.write_bytes(b" \n\t\n")
        _assert_refused(printed_job(str(src), str(Path(tmp_dir) / "out.pdf"), soffice_path=soffice_path))

    def test_text_without_libreoffice_raises(self, tmp_dir):
        from engine.print_layout import ConverterUnavailable

        src = Path(tmp_dir) / "job.txt"
        src.write_bytes(b"words")
        with pytest.raises(ConverterUnavailable):
            printed_job(str(src), str(Path(tmp_dir) / "out.pdf"), soffice_path="")


class TestMachineFailuresKeepTheJob:
    """A converter wraps a machine failure in its own exception; none of them
    is a refusal, so the job is kept and tried again."""

    @pytest.mark.parametrize(
        "message",
        [
            "LibreOffice conversion failed (exit -9): ",
            "LibreOffice reported success but wrote no output (stderr: none)",
        ],
    )
    def test_a_failed_libreoffice_run_is_kept(self, tmp_dir, monkeypatch, message):
        import sys

        from engine import soffice

        def fail(*args, **kwargs):
            raise RuntimeError(message)

        monkeypatch.setattr(soffice, "run_convert", fail)
        src = Path(tmp_dir) / "job.txt"
        src.write_bytes(b"words")
        with pytest.raises(RuntimeError, match=re.escape(message)):
            printed_job(str(src), str(Path(tmp_dir) / "out.pdf"), soffice_path=sys.executable)

    def test_a_ghostscript_io_error_is_kept(self, tmp_dir, monkeypatch, gs_path):
        import subprocess

        from engine import budget

        def io_error(cmd, **kwargs):
            return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="I/O error writing output")

        monkeypatch.setattr(budget, "gs", io_error)
        src = Path(tmp_dir) / "job.ps"
        src.write_bytes(b"%!PS\nshowpage\n")
        with pytest.raises(RuntimeError, match="Ghostscript failed: I/O error"):
            printed_job(str(src), str(Path(tmp_dir) / "out.pdf"), gs_path=gs_path)

    def test_a_full_disk_after_ghostscript_is_kept(self, tmp_dir, monkeypatch, gs_path):
        import errno

        from engine import distill

        def no_space(*args, **kwargs):
            raise OSError(errno.ENOSPC, "No space left on device")

        monkeypatch.setattr(distill, "open_pdf", no_space)
        src = Path(tmp_dir) / "job.ps"
        src.write_bytes(b"%!PS\nshowpage\n")
        with pytest.raises(RuntimeError, match="unreadable PDF: .*No space left"):
            printed_job(str(src), str(Path(tmp_dir) / "out.pdf"), gs_path=gs_path)

    def test_an_image_read_error_wrapped_by_create_pdf_is_kept(self, tmp_dir, monkeypatch):
        from engine import create_pdf

        def wrapped(src_path, *args, **kwargs):
            raise ValueError(f"unreadable image: {src_path} ([Errno 5] Input/output error)")

        monkeypatch.setattr(create_pdf, "image_to_pdf", wrapped)
        src = _png(Path(tmp_dir) / "job.png", 4, 4)
        with pytest.raises(ValueError, match="Input/output error"):
            printed_job(src, str(Path(tmp_dir) / "out.pdf"))

    @pytest.mark.parametrize("bug", [TypeError("bad operand"), KeyError("/Resources")])
    def test_a_defect_in_delivery_is_kept(self, tmp_dir, monkeypatch, bug):
        from engine import print_layout

        def broken(*args, **kwargs):
            raise bug

        monkeypatch.setattr(print_layout, "impose_sheets", broken)
        src = _pdf(Path(tmp_dir) / "in.pdf", [A4] * 2)
        with pytest.raises(type(bug)):
            printed_job(src, str(Path(tmp_dir) / "out.pdf"), number_up=2)
