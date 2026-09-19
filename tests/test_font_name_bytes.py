"""A font whose /BaseFont is not UTF-8 reads, measures and lists like any other.

A name is a sequence of bytes (ISO 32000-2 §7.3.5); where one is shown as text
its bytes should be read as UTF-8, and an older producer writes a font name in
its own code page: `/Caf#E9Bold` in Latin-1, a Japanese face in Shift-JIS.
`str` of a pikepdf name decodes strictly and raises on those bytes, so a path
that spells the name with `str` fails on the whole document or falls back to a
wrong answer: the text reads as U+FFFD, the font inventory and the embedding
pass stop, and a report names the resource instead of the font.

Each test holds the file against a control that differs only in the name:
`/CafeBold`, whose bytes are ASCII.
"""

from __future__ import annotations

import io
import os

import pikepdf
import pytest

LATIN1 = b"/Caf#E9Bold"
CONTROL = b"/CafeBold"
SPELLED = "Caf\ufffdBold"
CONTENT = b"BT /F1 12 Tf 20 100 Td (Hello) Tj ET"


def _raw_pdf(fonts: dict[bytes, bytes], content: bytes) -> bytes:
    """A one-page file written by hand, so each /BaseFont keeps its exact bytes."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    ]
    font_refs = b" ".join(
        key + b" " + str(5 + i).encode() + b" 0 R" for i, key in enumerate(fonts)
    )
    objects.append(
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << "
        + font_refs + b" >> >> /Contents 4 0 R >>"
    )
    objects.append(
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream"
    )
    for base in fonts.values():
        objects.append(
            b"<< /Type /Font /Subtype /Type1 /BaseFont " + base + b" /Encoding /WinAnsiEncoding >>"
        )
    out = io.BytesIO()
    out.write(b"%PDF-1.7\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(str(number).encode() + b" 0 obj\n" + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 " + str(len(objects) + 1).encode() + b"\n0000000000 65535 f \n")
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(b"trailer << /Size " + str(len(objects) + 1).encode() + b" /Root 1 0 R >>\n")
    out.write(b"startxref\n" + str(xref).encode() + b"\n%%EOF\n")
    return out.getvalue()


def _write(tmp_dir: str, name: str, fonts: dict[bytes, bytes], content: bytes = CONTENT) -> str:
    path = os.path.join(tmp_dir, name)
    with open(path, "wb") as handle:
        handle.write(_raw_pdf(fonts, content))
    return path


@pytest.fixture
def latin1_pdf(tmp_dir) -> str:
    return _write(tmp_dir, "latin1.pdf", {b"/F1": LATIN1})


@pytest.fixture
def control_pdf(tmp_dir) -> str:
    return _write(tmp_dir, "control.pdf", {b"/F1": CONTROL})


def _font(path: str):
    pdf = pikepdf.open(path)
    return pdf, pdf.pages[0].Resources.Font.F1


class TestTheTextReads:
    def test_a_simple_font_with_no_widths_reads_its_text(self, latin1_pdf, control_pdf):
        from engine.text_runs import list_text_runs

        runs = list_text_runs(latin1_pdf, 1)["runs"]
        assert [run["text"] for run in runs] == ["Hello"]
        assert runs == list_text_runs(control_pdf, 1)["runs"]

    def test_the_capability_matches_the_control(self, latin1_pdf, control_pdf):
        from engine.pdf_fonts import font_capability

        answers = []
        for path in (latin1_pdf, control_pdf):
            pdf, font = _font(path)
            with pdf:
                capability = font_capability(font)
                answers.append((capability.editable, capability.decode(b"Hello"),
                                capability.decoded_width(b"Hello"), capability.measures(b"Hello")))
        assert answers[0] == answers[1]
        assert answers[0][1] == "Hello"

    def test_the_ink_extent_matches_the_control(self, latin1_pdf, control_pdf):
        from engine.text_metrics import ink_extent_em

        extents = []
        for path in (latin1_pdf, control_pdf):
            pdf, font = _font(path)
            with pdf:
                extents.append(ink_extent_em(font))
        assert extents[0] == extents[1]


class TestTheFontListsAndEmbeds:
    def test_the_inventory_lists_the_font_by_its_name(self, latin1_pdf, control_pdf):
        from engine.font_inventory import list_document_fonts

        [font] = list_document_fonts(latin1_pdf)["fonts"]
        [control] = list_document_fonts(control_pdf)["fonts"]
        assert font["name"] == SPELLED
        assert {k: v for k, v in font.items() if k not in ("name", "raw_name")} == {
            k: v for k, v in control.items() if k not in ("name", "raw_name")
        }

    def test_two_names_that_read_alike_stay_two_fonts(self, tmp_dir):
        from engine.font_inventory import list_document_fonts

        path = _write(
            tmp_dir, "two.pdf", {b"/F1": b"/Caf#E9Bold", b"/F2": b"/Caf#E8Bold"},
            b"BT /F1 12 Tf 20 100 Td (A) Tj /F2 12 Tf (B) Tj ET",
        )
        fonts = list_document_fonts(path)["fonts"]
        assert [f["name"] for f in fonts] == [SPELLED, SPELLED]

    def test_the_style_reads_from_the_name(self, latin1_pdf):
        from engine.font_fallback import classify_font_family, classify_font_style

        pdf, font = _font(latin1_pdf)
        with pdf:
            assert classify_font_style(font) == (True, False)
            assert classify_font_family(font) == "sans"

    def test_the_embedding_pass_names_the_font(self, latin1_pdf, control_pdf, tmp_dir):
        from engine.font_embed import embed_missing_fonts

        with pytest.raises(ValueError) as refused:
            embed_missing_fonts(latin1_pdf, os.path.join(tmp_dir, "out.pdf"))
        with pytest.raises(ValueError) as control:
            embed_missing_fonts(control_pdf, os.path.join(tmp_dir, "control-out.pdf"))
        assert str(refused.value).startswith(SPELLED + ": ")
        assert str(refused.value) == str(control.value).replace("CafeBold", SPELLED)


class TestTheReportsNameTheFont:
    def test_the_structure_check_names_the_font(self, latin1_pdf):
        from engine.check import check

        messages = [issue["message"] for issue in check(latin1_pdf)["issues"]]
        assert "1 font(s) not embedded: " + SPELLED in messages

    def test_every_label_spells_the_name(self, latin1_pdf):
        from engine import accessibility, check, document_health, glyph_outlines, preflight, sanitize_content

        pdf, font = _font(latin1_pdf)
        with pdf:
            assert glyph_outlines._base_font_name(font) == SPELLED
            assert accessibility._base_font(font) == SPELLED
            assert preflight._font_name(font) == SPELLED
            assert check._font_label(font, "/F1") == SPELLED
            assert document_health._font_label(font, "/F1") == SPELLED
            assert sanitize_content._base_font(font) == "/" + SPELLED

    def test_the_office_face_check_reads_the_name(self, latin1_pdf, control_pdf):
        from engine.soffice import embedded_faces

        assert embedded_faces(latin1_pdf) == {"cafbold"}
        assert embedded_faces(control_pdf) == {"cafebold"}
