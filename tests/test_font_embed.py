"""Embedding a font the document names and does not carry.

The four rules of § 4.3, each pinned: an exact face or a refusal, the
document's `/Widths` win, a restricted face refuses with the foundry's own
reason, and refusal is per FONT rather than per document.

The fixtures are built against a face that is actually installed, and their
`/Widths` are taken from that face's own `hmtx` — so a metric disagreement in
a test is a defect in the comparison rather than a difference of opinion about
what Arial measures. A machine without it skips rather than pretending.
"""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

from engine.font_embed import (
    _family_key,
    _full_key,
    _match,
    embed_missing_fonts,
)
from engine.font_inventory import list_document_fonts
from engine.system_fonts import _scan

CODES = list(range(32, 127))


def _usable():
    return [face for face in _scan() if face["refusal"] is None]


def _face(name: str, bold: bool = False, italic: bool = False):
    return _match(_usable(), name, bold, italic)


ARIAL = _face("ArialMT")
needs_arial = pytest.mark.skipif(
    ARIAL is None, reason="no Arial installed to take metrics from"
)


def _face_widths(face, codes) -> list[float]:
    from fontTools.ttLib import TTFont

    tt = TTFont(face["path"], fontNumber=int(face.get("index", 0)), lazy=True)
    try:
        cmap = tt.getBestCmap()
        hmtx = tt["hmtx"]
        scale = 1000.0 / int(tt["head"].unitsPerEm)
        return [round(float(hmtx[cmap[code]][0]) * scale) for code in codes]
    finally:
        tt.close()


def _document(path, base_font: str, widths, *, subtype="TrueType", embedded=False):
    pdf = pikepdf.Pdf.new()
    entries = {
        "Type": Name("/Font"),
        "Subtype": Name("/" + subtype),
        "BaseFont": Name("/" + base_font),
        "FirstChar": CODES[0],
        "LastChar": CODES[-1],
        "Widths": Array(list(widths)),
        "Encoding": Name("/WinAnsiEncoding"),
    }
    font = pdf.make_indirect(Dictionary(**entries))
    if embedded:
        program = pdf.make_stream(b"\x00\x01\x02\x03")
        program["/Length1"] = 4
        font["/FontDescriptor"] = pdf.make_indirect(
            Dictionary(Type=Name("/FontDescriptor"), FontName=Name("/" + base_font),
                       Flags=32, FontFile2=program)
        )
    page = pdf.add_blank_page(page_size=(300, 200))
    page.obj["/Resources"] = Dictionary(Font=Dictionary(F1=font))
    page.contents_add(b"BT /F1 24 Tf 20 100 Td (Hello preflight) Tj ET")
    pdf.save(path)
    pdf.close()
    return path


class TestNameMatching:
    def test_a_family_key_drops_the_weight_and_the_producer_suffix(self):
        for name in ("Arial-BoldMT", "ArialMT", "Arial,Bold", "Arial",
                     "ABCDEF+Arial-Italic"):
            assert _family_key(name) == "arial", name

    def test_a_family_word_that_is_not_a_weight_survives(self):
        # `roman` and `book` are parts of real family names, and stripping them
        # would make two different typefaces compare equal.
        assert _family_key("TimesNewRomanPSMT") == "timesnewroman"
        assert _full_key("TimesNewRomanPS-BoldMT") == "timesnewromanbold"
        assert _full_key("Times New Roman Bold") == "timesnewromanbold"

    @needs_arial
    def test_a_weighted_face_never_answers_for_a_plain_one(self):
        # `Arial Black` reports the family `Arial` and neither the bold nor the
        # italic bit; without the plain-style guard it answers for `Arial`.
        assert _face("ArialMT")["name"].lower() in ("arial", "arial regular")

    def test_an_unknown_family_matches_nothing(self):
        assert _face("NoSuchFaceEverInstalled") is None


@needs_arial
class TestTheFourRules:
    def test_an_exact_face_embeds_and_the_document_reads_back_embedded(self, tmp_path):
        source = _document(str(tmp_path / "in.pdf"), "ArialMT",
                           _face_widths(ARIAL, CODES))
        output = str(tmp_path / "out.pdf")
        result = embed_missing_fonts(source, output)
        assert [row["font"] for row in result["embedded"]] == ["ArialMT"]
        assert result["refused"] == []
        assert result["substituted"] == []
        fonts = list_document_fonts(output)["fonts"]
        assert [(f["name"], f["embedded"]) for f in fonts] == [("ArialMT", True)]
        with pikepdf.open(output) as pdf:
            descriptor = pdf.pages[0].obj["/Resources"]["/Font"]["/F1"]["/FontDescriptor"]
            assert len(bytes(descriptor["/FontFile2"].read_bytes())) > 0

    def test_a_width_the_document_declares_differently_refuses_by_name(self, tmp_path):
        widths = _face_widths(ARIAL, CODES)
        widths[5] += 5
        source = _document(str(tmp_path / "in.pdf"), "ArialMT", widths)
        with pytest.raises(ValueError, match="reflow every line"):
            embed_missing_fonts(source, str(tmp_path / "out.pdf"))

    def test_no_matching_face_refuses_rather_than_substituting(self, tmp_path):
        source = _document(str(tmp_path / "in.pdf"), "NoSuchFaceEverInstalled",
                           _face_widths(ARIAL, CODES))
        with pytest.raises(ValueError, match="no installed face matches"):
            embed_missing_fonts(source, str(tmp_path / "out.pdf"))

    def test_a_substitute_needs_a_directory_to_substitute_from(self, tmp_path):
        source = _document(str(tmp_path / "in.pdf"), "NoSuchFaceEverInstalled",
                           _face_widths(ARIAL, CODES))
        with pytest.raises(ValueError, match="no fallback fonts directory"):
            embed_missing_fonts(source, str(tmp_path / "out.pdf"),
                                allow_substitute=True)

    def test_refusal_is_per_font_not_per_document(self, tmp_path):
        """Two fonts, one matchable: the matchable one embeds and the other is
        named. A document is not all-or-nothing."""
        path = str(tmp_path / "two.pdf")
        widths = _face_widths(ARIAL, CODES)
        pdf = pikepdf.Pdf.new()

        def simple(base):
            return pdf.make_indirect(Dictionary(
                Type=Name("/Font"), Subtype=Name("/TrueType"),
                BaseFont=Name("/" + base), FirstChar=CODES[0], LastChar=CODES[-1],
                Widths=Array(list(widths)), Encoding=Name("/WinAnsiEncoding"),
            ))

        page = pdf.add_blank_page(page_size=(300, 200))
        page.obj["/Resources"] = Dictionary(Font=Dictionary(
            F1=simple("ArialMT"), F2=simple("NoSuchFaceEverInstalled"),
        ))
        page.contents_add(b"BT /F1 12 Tf (a) Tj /F2 12 Tf (b) Tj ET")
        pdf.save(path)
        pdf.close()

        result = embed_missing_fonts(path, str(tmp_path / "out.pdf"))
        assert [row["font"] for row in result["embedded"]] == ["ArialMT"]
        assert [row["font"] for row in result["refused"]] == ["NoSuchFaceEverInstalled"]

    def test_an_embedded_font_is_left_alone_and_the_copy_still_lands(self, tmp_path):
        source = _document(str(tmp_path / "in.pdf"), "ArialMT",
                           _face_widths(ARIAL, CODES), embedded=True)
        output = str(tmp_path / "out.pdf")
        result = embed_missing_fonts(source, output)
        assert result["embedded"] == []
        assert result["refused"] == []
        # Nothing to embed and a copy was asked for: an output that does not
        # exist would report a success that wrote no file.
        assert os.path.isfile(output)

    def test_a_type3_font_names_why_it_has_no_program(self, tmp_path):
        path = str(tmp_path / "type3.pdf")
        pdf = pikepdf.Pdf.new()
        font = pdf.make_indirect(Dictionary(
            Type=Name("/Font"), Subtype=Name("/Type3"),
            BaseFont=Name("/Drawn"), FirstChar=97, LastChar=97,
            Widths=Array([500]), FontMatrix=Array([0.001, 0, 0, 0.001, 0, 0]),
            CharProcs=Dictionary(), Encoding=Name("/WinAnsiEncoding"),
        ))
        # No /CharProcs entries, so the inventory reports it non-embedded and
        # the embedder has to say WHY it cannot write a program.
        del font["/CharProcs"]
        page = pdf.add_blank_page(page_size=(300, 200))
        page.obj["/Resources"] = Dictionary(Font=Dictionary(F1=font))
        pdf.save(path)
        pdf.close()
        with pytest.raises(ValueError, match="carries its glyphs as drawings"):
            embed_missing_fonts(path, str(tmp_path / "out.pdf"))


class TestSources:
    def test_an_unknown_source_refuses_by_name(self, tmp_path):
        path = _document(str(tmp_path / "in.pdf"), "ArialMT",
                         [500] * len(CODES))
        with pytest.raises(ValueError, match="unknown font source"):
            embed_missing_fonts(path, str(tmp_path / "out.pdf"), sources=("network",))
