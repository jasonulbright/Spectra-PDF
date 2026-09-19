"""Names and operators whose bytes are not UTF-8, through the page walkers.

ISO 32000-2 §7.3.5: a name is its byte sequence and may hold any byte but
NUL, so a resource may be named `/Im#E9` or `/F#E9`. §7.8.2 makes a content
operator a keyword, and §7.2.3 makes every byte that is not a delimiter or
white space a regular character, so a damaged stream can hold an operator of
bytes that are not UTF-8. Outside a BX/EX compatibility section, §7.8.2 makes
an operator that a processor does not recognise an error; the walkers read
past it, so the rest of the page stays readable. `str()` of such a pikepdf
name or operator raises, so every walker that spelled one with `str()` failed
the page, skipped the resource or lost its identity.
Every assertion reads the walker's real output or the file it wrote.
"""

from __future__ import annotations

import io
import os

import pikepdf
import pytest
from pdfminer.high_level import extract_text as pdfminer_text

_HELVETICA = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"


def _write(tmp_dir: str, raw: bytes, name: str) -> str:
    path = os.path.join(tmp_dir, name)
    with pikepdf.open(io.BytesIO(raw)) as pdf:
        pdf.save(path)
    return path


def _page(resources: bytes, content: bytes, extra: bytes = b"") -> bytes:
    return (
        b"%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources "
        + resources + b" /Contents 4 0 R >> endobj\n"
        b"4 0 obj << /Length " + str(len(content)).encode() + b" >> stream\n"
        + content + b"\nendstream endobj\n" + extra
        + b"trailer << /Root 1 0 R >>\n%%EOF\n"
    )


#: A keyword of two bytes that are not UTF-8 between a save and a restore,
#: then ordinary text and a filled square.
_GARBAGE = _page(
    b"<< /Font << /F1 " + _HELVETICA + b" >> >>",
    b"q \xfc\xfd Q BT /F1 12 Tf 100 500 Td (Secret words) Tj ET 0 0 1 rg 100 100 50 50 re f",
)


class TestAKeywordThatIsNotUtf8:
    def test_the_run_lister_reads_the_page(self, tmp_dir):
        from engine.text_runs import list_text_runs

        runs = list_text_runs(_write(tmp_dir, _GARBAGE, "g.pdf"), 1)["runs"]
        assert [r["text"] for r in runs] == ["Secret words"]

    def test_the_paragraph_lister_reads_the_page(self, tmp_dir):
        from engine.text_paragraphs import list_text_paragraphs

        paras = list_text_paragraphs(_write(tmp_dir, _GARBAGE, "g.pdf"), 1)["paragraphs"]
        assert [p["text"] for p in paras] == ["Secret words"]

    def test_a_redaction_removes_the_text(self, tmp_dir):
        from engine.redact import redact

        src = _write(tmp_dir, _GARBAGE, "g.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        redact(file=src, output=out, regions=[{"page": 1, "rect": [90, 490, 300, 520]}])
        assert "Secret" not in pdfminer_text(out)

    def test_hidden_text_sanitizing_reads_the_page(self, tmp_dir):
        from engine.sanitize import sanitize_pdf

        src = _write(tmp_dir, _GARBAGE, "g.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        sanitize_pdf(src, out, categories=["hidden_text"])
        assert "Secret words" in pdfminer_text(out)

    def test_the_vector_lister_reads_the_page(self, tmp_dir):
        from engine.page_vectors import list_page_vectors

        vectors = list_page_vectors(_write(tmp_dir, _GARBAGE, "g.pdf"), 1)["vectors"]
        assert [v["rect"] for v in vectors] == [[100.0, 100.0, 150.0, 150.0]]


_IMAGE = b"6 0 obj << /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >> stream\n\x00\x80\x80\x00\nendstream endobj\n"
_FORM = (b"7 0 obj << /Type /XObject /Subtype /Form /BBox [0 0 200 50] /Resources << /Font << /F1 "
         + _HELVETICA + b" >> >> /Length 38 >> stream\nBT /F1 12 Tf 0 10 Td (Form words) Tj ET\nendstream endobj\n")

#: Every resource of the page named with a byte that is not UTF-8.
_NAMED = _page(
    b"<< /Font << /F#E9 " + _HELVETICA + b" >> /XObject << /Im#E9 6 0 R /Fm#E9 7 0 R >>"
    b" /ExtGState << /G#E9 << /ca 0.5 >> >> >>",
    b"BT /F#E9 12 Tf 100 700 Td (Plain words) Tj ET\n"
    b"q 100 0 0 50 100 500 cm /Im#E9 Do Q\n"
    b"q 1 0 0 1 100 300 cm /Fm#E9 Do Q\n"
    b"q /G#E9 gs 1 0 0 rg 300 300 80 80 re f Q",
    _IMAGE + _FORM,
)


class TestResourcesNamedWithBytesThatAreNotUtf8:
    def test_text_in_such_a_font_lists_as_editable(self, tmp_dir):
        from engine.text_runs import list_text_runs

        runs = list_text_runs(_write(tmp_dir, _NAMED, "n.pdf"), 1)["runs"]
        by_text = {r["text"]: r for r in runs}
        assert set(by_text) == {"Plain words", "Form words"}
        assert by_text["Plain words"]["editable"] is True

    def test_an_edit_selects_the_font_by_its_own_bytes(self, tmp_dir):
        from engine.text_runs import list_text_runs, replace_text_run

        src = _write(tmp_dir, _NAMED, "n.pdf")
        index = next(r["index"] for r in list_text_runs(src, 1)["runs"] if r["text"] == "Plain words")
        out = os.path.join(tmp_dir, "out.pdf")
        replace_text_run(src, out, 1, index, "Other words")
        assert "Other words" in pdfminer_text(out)
        with pikepdf.open(out) as pdf:
            fonts = [bytes(i.operands[0]) for i in pikepdf.parse_content_stream(pdf.pages[0])
                     if i.operator == pikepdf.Operator("Tf")]
        assert fonts and set(fonts) == {b"/F\xe9"}

    def test_the_image_lister_finds_the_image(self, tmp_dir):
        from engine.page_images import list_page_images

        images = list_page_images(_write(tmp_dir, _NAMED, "n.pdf"), 1)["images"]
        assert len(images) == 1
        assert images[0]["rect"] == pytest.approx([100, 500, 200, 550], abs=0.01)

    def test_a_redaction_reaches_text_inside_the_form(self, tmp_dir):
        from engine.redact import redact

        src = _write(tmp_dir, _NAMED, "n.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        redact(file=src, output=out, regions=[{"page": 1, "rect": [95, 305, 200, 330]}])
        text = pdfminer_text(out)
        assert "Form words" not in text
        assert "Plain words" in text

    def test_the_transparency_lister_reads_the_state(self, tmp_dir):
        from engine.flattener import list_transparency

        [page] = list_transparency(_write(tmp_dir, _NAMED, "n.pdf"), pages=[1])["pages"]
        assert page["error"] is None
        assert page["unknown"] == []
        fills = [o for o in page["objects"] if o["kind"] == "fill"]
        assert [(o["rect"], o["transparent"]) for o in fills] == [([300.0, 300.0, 380.0, 380.0], True)]


def _doc(tmp_dir: str, name: str, objects: list[bytes]) -> str:
    """A document from numbered object bodies, the first being the catalog."""
    out = io.BytesIO()
    out.write(b"%PDF-1.7\n")
    for number, body in enumerate(objects, start=1):
        out.write(b"%d 0 obj " % number + body + b" endobj\n")
    out.write(b"trailer << /Root 1 0 R /Size %d >>\n%%EOF\n" % (len(objects) + 1))
    return _write(tmp_dir, out.getvalue(), name)


def _stream(data: bytes, extra: bytes = b"") -> bytes:
    return b"<< /Length %d " % len(data) + extra + b" >> stream\n" + data + b"\nendstream"


_FN = b"<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>"

#: The keyword of two bytes that are not UTF-8 ahead of text, a filled square,
#: an image, a form holding text, a spot fill under an overprint state and a
#: hairline: one page every walker has something on.
_GARBAGE_RICH = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
    + b" >> /XObject << /Im1 5 0 R /Fm1 6 0 R >> /ColorSpace << /CS1 [/Separation /Spot /DeviceCMYK "
    + _FN + b"] >> /ExtGState << /GS1 << /OP true /OPM 1 /ca 0.5 >> >> >> /Contents 4 0 R >>",
    _stream(b"q \xfc\xfd Q\nBT /F1 12 Tf 100 700 Td (Secret words) Tj ET\n0 0 1 rg 100 100 50 50 re f\n"
            b"q 100 0 0 50 100 500 cm /Im1 Do Q\nq 1 0 0 1 100 300 cm /Fm1 Do Q\n"
            b"q /CS1 cs 1 scn /GS1 gs 300 300 80 80 re f Q\n0.1 w 10 10 m 200 10 l S"),
    _IMAGE.split(b" obj ", 1)[1].rsplit(b" endobj", 1)[0],
    _FORM.split(b" obj ", 1)[1].rsplit(b" endobj", 1)[0],
]


class TestEveryWalkerReadsPastAKeywordThatIsNotUtf8:
    """Each walker below spelled every operator with `str()`, so the damaged
    keyword failed its whole page. Each walker now reads past the keyword, as
    it reads past any other operator it does not recognise."""

    def test_the_image_lister_finds_the_image(self, tmp_dir):
        from engine.page_images import list_page_images

        images = list_page_images(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), 1)["images"]
        assert [i["rect"] for i in images] == [pytest.approx([100, 500, 200, 550], abs=0.01)]

    def test_the_transparency_lister_reads_the_page(self, tmp_dir):
        from engine.flattener import list_transparency

        [page] = list_transparency(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), pages=[1])["pages"]
        assert page["error"] is None
        assert len(page["objects"]) == 6

    def test_the_overprint_lister_finds_the_spot_paint(self, tmp_dir):
        from engine.overprint import list_overprint

        result = list_overprint(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH))
        assert result["unreadable"] == []
        assert [(p["family"], p["components"]) for p in result["paints"]] == [("Separation", [1.0])]

    def test_the_hairline_lister_finds_the_hairline(self, tmp_dir):
        from engine.hairlines import list_hairlines

        result = list_hairlines(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH))
        assert result["unreadable"] == []
        assert [s["line_width"] for s in result["pages"][0]["strokes"]] == [0.1]

    def test_autotag_tags_the_text_and_the_image(self, tmp_dir):
        from engine.autotag import autotag

        result = autotag(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), os.path.join(tmp_dir, "t.pdf"))
        assert (result["paragraphs"], result["figures"]) == (1, 1)

    def test_the_standards_census_reads_the_page_marks(self, tmp_dir):
        from engine.standards_report import census

        facts = census(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH))
        assert facts.values["page_marks"] == [["image", "text", "vector"]]

    def test_read_aloud_reads_the_text(self, tmp_dir):
        from engine.read_aloud import read_aloud_page

        blocks = read_aloud_page(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), 1)["blocks"]
        assert [b["text"] for b in blocks] == ["Secret words", "Form words"]

    def test_spot_to_process_rewrites_the_spot_paint(self, tmp_dir):
        from engine.ink_manager import spot_to_process

        out = os.path.join(tmp_dir, "p.pdf")
        result = spot_to_process(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), out, ["Spot"])
        assert (result["spaces"], result["paints"]) == (1, 1)

    def test_a_redaction_removes_the_square(self, tmp_dir):
        from engine.page_vectors import list_page_vectors
        from engine.redact import redact

        out = os.path.join(tmp_dir, "r.pdf")
        redact(file=_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), output=out,
               regions=[{"page": 1, "rect": [95, 95, 155, 155]}])
        rects = [v["rect"] for v in list_page_vectors(out, 1)["vectors"]]
        assert [100.0, 100.0, 150.0, 150.0] not in rects
        assert [300.0, 300.0, 380.0, 380.0] in rects

    def test_the_outline_listing_reaches_the_font(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.outlines import list_outlines

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        result = list_outlines(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), font_dir=os.path.abspath(FONT_DIR))
        assert result["refusals"] == []
        assert result["text_runs"] == 2


_TEXT = b"BT /F1 12 Tf 72 700 Td (Hello words) Tj ET"

#: Annotations, links, a checkbox state and a field type whose names are not
#: UTF-8, and a legacy destination named the same way (ISO 32000-2 §12.3.2.4).
_VOCAB_PAGE = [
    b"<< /Type /Catalog /Pages 2 0 R /Dests << /D#FC [3 0 R /Fit] >> /AcroForm << /Fields [8 0 R 9 0 R] >> >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Tabs /S#FC /Resources << /Font << /F1 "
    + _HELVETICA + b" >> >> /Contents 4 0 R /Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 11 0 R] >>",
    _stream(_TEXT),
    b"<< /Type /Annot /Subtype /Te#FCxt /Rect [10 10 30 30] /Contents (odd) >>",
    b"<< /Type /Annot /Subtype /Text /Rect [40 10 60 30] /Contents (A note) /T (Ann) /NM (note-1) >>",
    b"<< /Type /Annot /Subtype /Link /Rect [72 690 150 715] /A << /S /U#FCRI /URI (http://x) >> >>",
    b"<< /Type /Annot /Subtype /Widget /FT /Btn /T (box) /Rect [200 200 220 220] /V /Gr#FCn /AS /Gr#FCn "
    b"/AP << /N << /Gr#FCn 12 0 R /Off 12 0 R >> >> >>",
    b"<< /Type /Annot /Subtype /Widget /FT /T#FCx /T (odd) /Rect [230 200 330 220] /V (v) >>",
    b"<< /Type /Annot /Subtype /Link /Rect [72 600 150 620] /Dest /D#FC /BS << /S /D#FC /W 1 >> /H /I#FC >>",
    b"<< /Type /Annot /Subtype /FreeText /Rect [300 300 400 350] /Contents (Free) /NM (free-1) "
    b"/DA (/Helv 12 Tf 0 g) /BE << /S /C#FC /I 1 >> /IRT 6 0 R /RT /R#FC >>",
    _stream(b"0 0 1 rg 0 0 20 20 re f", b"/Type /XObject /Subtype /Form /BBox [0 0 20 20]"),
]


class TestVocabularyNamesThatAreNotUtf8:
    """A name the vocabulary does not know is an unknown value: its subtype,
    action, style or field type matches none, and the rest of the document
    reads. `str()` of such a name raised and failed the whole listing."""

    def test_the_comment_list_reads_an_unknown_reply_type(self, tmp_dir):
        from engine.comment_summary import list_comments

        comments = list_comments(_doc(tmp_dir, "v.pdf", _VOCAB_PAGE))["comments"]
        assert [(c["subtype"], c["reply_to"], c["reply_type"]) for c in comments] == [
            ("Text", None, None), ("FreeText", "c1", "unknown")]

    def test_the_xfdf_export_writes_a_border_style_it_does_not_know_as_plain(self, tmp_dir):
        from engine.xfdf import export_xfdf

        out = os.path.join(tmp_dir, "v.xfdf")
        export_xfdf(_doc(tmp_dir, "v.pdf", _VOCAB_PAGE), out)
        with open(out, encoding="utf-8") as fh:
            xml = fh.read()
        assert "<freetext" in xml and 'name="free-1"' in xml
        assert "cloudy" not in xml

    def test_the_form_reader_reads_the_state_and_the_unknown_type(self, tmp_dir):
        from engine.forms import read_form_fields

        fields = {f["name"]: f for f in read_form_fields(_doc(tmp_dir, "v.pdf", _VOCAB_PAGE))["fields"]}
        assert (fields["box"]["type"], fields["box"]["value"], fields["box"]["export_value"]) == (
            "checkbox", True, "Gr#FCn")
        assert fields["odd"]["type"] == "unknown"

    def test_the_link_list_reads_every_link(self, tmp_dir):
        from engine.links import list_links

        links = list_links(_doc(tmp_dir, "v.pdf", _VOCAB_PAGE))["links"]
        assert [link["target_spec"] for link in links] == [
            {"kind": "other", "action": "U#FCRI"}, {"kind": "named", "name": "D#FC"}]
        assert (links[1]["appearance"]["style"], links[1]["appearance"]["highlight"]) == ("solid", "invert")

    def test_the_named_destinations_list_reaches_the_host_whole(self, tmp_dir):
        import json

        from engine.ipc import encode_response
        from engine.links import list_named_destinations

        result = list_named_destinations(_doc(tmp_dir, "v.pdf", _VOCAB_PAGE))
        line = encode_response({"jsonrpc": "2.0", "id": 1, "result": result})
        assert json.loads(line)["result"]["destinations"] == [{"name": "D#FC", "page": 1}]

    def test_the_accessibility_check_reads_a_tab_order_it_does_not_know(self, tmp_dir):
        from engine.accessibility import check_accessibility

        report = check_accessibility(_doc(tmp_dir, "v.pdf", _VOCAB_PAGE))
        [check] = [c for cat in report["categories"] for c in cat["checks"] if c["id"] == "tab_order"]
        assert [f["detail_key"] for f in check["findings"]] == ["tab_order_not_structure"]

    def test_the_hidden_information_audit_reads_the_comments(self, tmp_dir):
        from engine.sanitize import audit_hidden_information

        audit = audit_hidden_information(_doc(tmp_dir, "v.pdf", _VOCAB_PAGE))
        [comments] = [c for c in audit["categories"] if c["id"] == "comments"]
        assert comments["count"] == 2

    def test_the_standards_census_counts_every_annotation(self, tmp_dir):
        from engine.standards_report import census

        facts = census(_doc(tmp_dir, "v.pdf", _VOCAB_PAGE))
        assert facts.values["annotations"] == {
            "Te#FCxt": 1, "Text": 1, "Link": 2, "Widget": 2, "FreeText": 1}

    def test_preflight_reads_every_annotation(self, tmp_dir):
        from engine.preflight import preflight

        assert preflight(_doc(tmp_dir, "v.pdf", _VOCAB_PAGE))["unreadable"] == []


#: A structure tree whose custom role, role map key, attribute owner, scope
#: and marked-content reference type are names that are not UTF-8.
_VOCAB_TREE = [
    b"<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 5 0 R /Lang (en) >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /StructParents 0 /Resources << /Font << /F1 "
    + _HELVETICA + b" >> >> /Contents 4 0 R >>",
    _stream(b"/H1 << /MCID 0 >> BDC BT /F1 18 Tf 72 700 Td (Title words) Tj ET EMC "
            b"/P << /MCID 1 >> BDC BT /F1 12 Tf 72 650 Td (Body words) Tj ET EMC "
            b"/P << /MCID 2 >> BDC BT /F1 12 Tf 72 600 Td (Odd words) Tj ET EMC"),
    b"<< /Type /StructTreeRoot /K 6 0 R /RoleMap << /Cust#FC /H1 >> "
    b"/ParentTree << /Nums [0 [7 0 R 8 0 R 9 0 R]] >> >>",
    b"<< /Type /StructElem /S /Document /P 5 0 R /K [7 0 R 8 0 R 9 0 R] >>",
    b"<< /Type /StructElem /S /H1 /P 6 0 R /Pg 3 0 R /K 0 >>",
    b"<< /Type /StructElem /S /P /P 6 0 R /Pg 3 0 R /K << /Type /MC#FCR /Pg 3 0 R /MCID 1 >> "
    b"/A << /O /Tab#FCle /Scope /Ro#FCw >> >>",
    b"<< /Type /StructElem /S /Cust#FC /P 6 0 R /Pg 3 0 R /K 2 >>",
]


class TestStructureNamesThatAreNotUtf8:
    def test_the_tree_reads_the_custom_role_and_the_role_map(self, tmp_dir):
        from engine.struct_tree import get_struct_tree

        tree = get_struct_tree(_doc(tmp_dir, "t.pdf", _VOCAB_TREE))
        [document] = tree["root"]
        assert [n["type"] for n in document["children"]] == ["H1", "P", "Cust#FC"]
        assert tree["role_map"] == {"Cust#FC": "H1"}

    def test_the_derived_outline_follows_the_role_map(self, tmp_dir):
        from engine.derived_nav import preview_structure_outline

        preview = preview_structure_outline(_doc(tmp_dir, "t.pdf", _VOCAB_TREE))
        assert [item["title"] for item in preview["outline"]] == ["Title words", "Odd words"]

    def test_read_aloud_names_each_block_by_its_own_role(self, tmp_dir):
        from engine.read_aloud import read_aloud_page

        blocks = read_aloud_page(_doc(tmp_dir, "t.pdf", _VOCAB_TREE), 1)["blocks"]
        assert [(b["role"], b["text"]) for b in blocks] == [
            ("H1", "Title words"), (None, "Body words"), ("Cust#FC", "Odd words")]

    def test_the_accessibility_check_reads_the_tree(self, tmp_dir):
        from engine.accessibility import check_accessibility

        report = check_accessibility(_doc(tmp_dir, "t.pdf", _VOCAB_TREE))
        [tagged] = [c for cat in report["categories"] for c in cat["checks"] if c["id"] == "tagged"]
        assert tagged["status"] == "pass"


#: Simple fonts whose encoding names are not UTF-8: a base encoding the
#: vocabulary does not know leaves the standard one (ISO 32000-2 §9.6.5.1), and
#: a glyph name nothing knows names no character.
_VOCAB_FONTS = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << "
    b"/F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /Win#FCAnsi >> "
    b"/F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /BaseEncoding /Win#FCAnsi "
    b"/Differences [65 /B] >> >> "
    b"/F3 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [65 /g#FC /B] >> >> "
    b">> >> /Contents 4 0 R >>",
    _stream(b"BT /F1 12 Tf 72 700 Td (Plain) Tj ET BT /F2 12 Tf 72 650 Td (A) Tj ET "
            b"BT /F3 12 Tf 72 600 Td (AB) Tj ET"),
]


class TestFontEncodingNamesThatAreNotUtf8:
    def test_each_run_decodes_through_what_the_encoding_does_say(self, tmp_dir):
        from engine.text_runs import list_text_runs

        runs = list_text_runs(_doc(tmp_dir, "f.pdf", _VOCAB_FONTS), 1)["runs"]
        assert [(r["text"], r["editable"]) for r in runs] == [("Plain", True), ("B", True), ("AB", True)]

    def test_the_font_list_names_each_encoding(self, tmp_dir):
        from engine.font_inventory import list_document_fonts

        fonts = list_document_fonts(_doc(tmp_dir, "f.pdf", _VOCAB_FONTS))["fonts"]
        assert sorted(f["encoding"] for f in fonts) == ["Custom", "Win#FCAnsi"]


#: Catalog vocabulary that is not UTF-8: a portfolio view, an opening action
#: type and an output intent subtype, beside text under an OFF layer.
_VOCAB_CATALOG = [
    b"<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R] /D << /Order [5 0 R] "
    b"/ListMode /All#FCPages /OFF [5 0 R] >> >> "
    b"/OpenAction << /S /Java#FCScript /JS (app.alert(1)) >> /Collection << /View /D#FC >> "
    b"/OutputIntents [<< /Type /OutputIntent /S /GTS_PDF#FCX /OutputConditionIdentifier (Custom) >>] >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
    + b" >> /Properties << /MC0 5 0 R >> >> /Contents 4 0 R >>",
    _stream(b"BT /F1 12 Tf 72 700 Td (Shown words) Tj ET /OC /MC0 BDC BT /F1 12 Tf 72 650 Td "
            b"(Hidden words) Tj ET EMC"),
    b"<< /Type /OCG /Name (Layer) /Intent /V#FCiew >>",
]


class TestCatalogNamesThatAreNotUtf8:
    def test_the_portfolio_view_reads_as_custom(self, tmp_dir):
        from engine.portfolio import get_portfolio

        result = get_portfolio(_doc(tmp_dir, "c.pdf", _VOCAB_CATALOG))
        assert (result["is_portfolio"], result["view"]) == (True, "custom")

    def test_sanitizing_reads_an_action_type_it_does_not_know(self, tmp_dir):
        from engine.sanitize import sanitize_pdf

        out = os.path.join(tmp_dir, "s.pdf")
        sanitize_pdf(_doc(tmp_dir, "c.pdf", _VOCAB_CATALOG), out, categories=["hidden_text"])
        text = pdfminer_text(out)
        assert "Shown words" in text and "Hidden words" not in text

    def test_preflight_reads_the_output_intent(self, tmp_dir):
        from engine.preflight import preflight

        assert preflight(_doc(tmp_dir, "c.pdf", _VOCAB_CATALOG))["unreadable"] == []


#: Text under an OFF layer, selected through a property name that is not UTF-8.
_HIDDEN_UNDER_NAME = [
    b"<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R] /D << /Order [5 0 R] /OFF [5 0 R] >> >> >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
    + b" >> /Properties << /MC#FC 5 0 R >> >> /Contents 4 0 R >>",
    _stream(b"BT /F1 12 Tf 72 700 Td (Shown words) Tj ET /OC /MC#FC BDC BT /F1 12 Tf 72 650 Td "
            b"(Hidden words) Tj ET EMC"),
    b"<< /Type /OCG /Name (Layer) >>",
]


class TestHiddenContentSelectedThroughANameThatIsNotUtf8:
    """A marked-content property list may be named by any name (ISO 32000-2
    §14.6.2), and the group the name selects decides the visibility
    (§8.11.3.2). Read through `str()`, such a name selected nothing, so the
    audit missed the hidden text and sanitizing kept it."""

    def test_the_audit_reports_the_hidden_text(self, tmp_dir):
        from engine.sanitize import audit_hidden_information

        audit = audit_hidden_information(_doc(tmp_dir, "h.pdf", _HIDDEN_UNDER_NAME))
        [hidden] = [c for c in audit["categories"] if c["id"] == "hidden_text"]
        assert [d["text"] for d in hidden["detail"]] == ["Hidden words"]

    def test_sanitizing_hidden_text_removes_it(self, tmp_dir):
        from engine.sanitize import sanitize_pdf

        out = os.path.join(tmp_dir, "s.pdf")
        sanitize_pdf(_doc(tmp_dir, "h.pdf", _HIDDEN_UNDER_NAME), out, categories=["hidden_text"])
        assert "Hidden words" not in pdfminer_text(out)

    def test_sanitizing_hidden_layers_removes_the_layer_and_its_text(self, tmp_dir):
        from engine.sanitize import sanitize_pdf

        out = os.path.join(tmp_dir, "s.pdf")
        sanitize_pdf(_doc(tmp_dir, "h.pdf", _HIDDEN_UNDER_NAME), out, categories=["hidden_layers"])
        assert "Hidden words" not in pdfminer_text(out)
        with pikepdf.open(out) as pdf:
            assert pdf.Root.get("/OCProperties") is None
            assert len(pdf.pages[0].obj.Resources.Properties) == 0


_IMAGE_BODY = _IMAGE.split(b" obj ", 1)[1].rsplit(b" endobj", 1)[0]


class TestGraphicsStateNamesThatAreNotUtf8:
    """A blend mode or a soft mask name the vocabulary does not know is not
    the Normal blend and not /None (ISO 32000-2 §11.6.3, §11.6.5.1): paint
    under it is not proven opaque. `str()` of such a name raised and failed
    the page, and the hidden-text audit dropped the page without a word."""

    _STATES = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
        + b" >> /ExtGState << /G1 << /BM /Mul#FCtiply >> /G2 << /SMask /No#FCne /ca 0.5 >> >> >> "
        b"/Contents 4 0 R >>",
        _stream(b"q /G1 gs 1 0 0 rg 100 100 50 50 re f Q q /G2 gs 0 0 1 rg 300 300 50 50 re f Q "
                b"BT /F1 12 Tf 72 700 Td (Words) Tj ET"),
    ]

    def test_the_transparency_lister_reads_both_states_as_transparent(self, tmp_dir):
        from engine.flattener import list_transparency

        [page] = list_transparency(_doc(tmp_dir, "s.pdf", self._STATES), pages=[1])["pages"]
        assert page["error"] is None
        fills = [(o["rect"], o["transparent"]) for o in page["objects"] if o["kind"] == "fill"]
        assert fills == [([100.0, 100.0, 150.0, 150.0], True), ([300.0, 300.0, 350.0, 350.0], True)]

    def test_the_hidden_text_audit_reads_the_page_past_such_a_state(self, tmp_dir):
        from engine.sanitize import audit_hidden_information

        objects = list(self._STATES)
        objects[3] = _stream(b"BT /F1 12 Tf 72 700 Td (Covered words) Tj ET 1 1 1 rg 60 690 200 30 re f "
                             b"q /G1 gs Q q /G2 gs Q")
        audit = audit_hidden_information(_doc(tmp_dir, "s.pdf", objects))
        [hidden] = [c for c in audit["categories"] if c["id"] == "hidden_text"]
        assert [(d["kind"], d["text"]) for d in hidden["detail"]] == [("covered", "Covered words")]

    def test_the_image_lister_reads_a_tool_mask_beside_such_a_blend_mode(self, tmp_dir):
        from engine.page_images import list_page_images, set_image_opacity

        src = _doc(tmp_dir, "m.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"q 100 0 0 50 100 500 cm /Im1 Do Q"),
            _IMAGE_BODY,
        ])
        masked = os.path.join(tmp_dir, "masked.pdf")
        mask = {"kind": "linear", "from": [0.0, 0.0], "to": [1.0, 0.0], "start_alpha": 1.0, "end_alpha": 0.0}
        set_image_opacity(src, masked, 1, 0, mask=mask)
        odd = os.path.join(tmp_dir, "odd.pdf")
        with pikepdf.open(masked) as pdf:
            states = pdf.pages[0].obj.Resources.ExtGState
            for key in list(states.keys()):
                states[key]["/BM"] = pikepdf.Object.parse(b"/Mul#FCtiply")
            pdf.save(odd)
        [image] = list_page_images(odd, 1)["images"]
        assert (image["mask"], image["blend"]) == (mask, "Normal")


class TestImageNamesThatAreNotUtf8:
    _IMAGES = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R /Im2 6 0 R >> >> "
        b"/Contents 4 0 R >>",
        _stream(b"q 100 0 0 50 100 500 cm /Im1 Do Q q 100 0 0 50 100 300 cm /Im2 Do Q"),
        _stream(b"\x00\x80\x80\x00", b"/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray "
                b"/BitsPerComponent 8 /Filter /Fl#FCte"),
        _stream(b"\x00\x80\x80\x00", b"/Type /XObject /Subtype /Image /Width 2 /Height 2 "
                b"/ColorSpace [/Ind#FCexed /DeviceRGB 1 <000000FFFFFF>] /BitsPerComponent 8"),
    ]

    def test_the_image_lister_names_the_filter_and_the_colour_family(self, tmp_dir):
        from engine.page_images import list_page_images

        images = list_page_images(_doc(tmp_dir, "i.pdf", self._IMAGES), 1)["images"]
        assert [(i["filters"], i["colour_family"]) for i in images] == [
            (["/Fl#FCte"], "DeviceGray"), (["/FlateDecode"], "Ind#FCexed")]

    def test_the_health_check_names_the_one_image_it_cannot_read(self, tmp_dir):
        from engine.document_health import document_health

        facts = document_health(_doc(tmp_dir, "i.pdf", self._IMAGES))["facts"]
        codes = [(f["code"], f.get("params", {}).get("name")) for f in facts]
        assert ("page.imageUnreadable", "Im1") in codes
        assert "pages.unreadable" not in [code for code, _name in codes]

    @pytest.mark.parametrize("rect, reason", [
        ([120, 510, 150, 540], "an unsupported filter /Fl#FCte"),
        ([120, 310, 150, 340], "an unsupported colour space /Ind#FCexed"),
    ])
    def test_a_partial_redaction_refuses_the_image_by_name(self, tmp_dir, rect, reason):
        from engine.redact import redact

        with pytest.raises(ValueError) as refused:
            redact(file=_doc(tmp_dir, "i.pdf", self._IMAGES), output=os.path.join(tmp_dir, "r.pdf"),
                   regions=[{"page": 1, "rect": rect}])
        assert str(refused.value) == (
            f"This image cannot be partly redacted ({reason}). Mark the whole image to remove it.")

    def test_opacity_is_set_inside_a_frame_whose_state_is_named_that_way(self, tmp_dir):
        from engine.page_images import list_page_images, set_image_opacity

        src = _doc(tmp_dir, "o.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> "
            b"/ExtGState << /G#FC << /ca 0.5 >> /EditGS#FC << /ca 0.5 >> >> >> /Contents 4 0 R >>",
            _stream(b"q /G#FC gs q 100 0 0 50 100 500 cm /Im1 Do Q Q"),
            _IMAGE_BODY,
        ])
        out = os.path.join(tmp_dir, "o2.pdf")
        set_image_opacity(src, out, 1, 0, 0.25)
        [image] = list_page_images(out, 1)["images"]
        assert image["opacity"] == pytest.approx(0.25)
        with pikepdf.open(out) as pdf:
            keys = [k.encode("utf-8", "surrogateescape") for k in pdf.pages[0].obj.Resources.ExtGState.keys()]
        assert b"/G\xfc" in keys and b"/EditGS\xfc" not in keys


class TestMarkedContentPropertiesNamedWithBytesThatAreNotUtf8:
    _MARKED = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
        + b" >> /Properties << /P#FC << /MCID 3 >> /B#FC << /ActualText <FEFF000A> >> >> >> /Contents 4 0 R >>",
        _stream(b"/Span /P#FC BDC BT /F1 12 Tf 72 700 Td (Marked words) Tj ET EMC /Span /B#FC BDC EMC "
                b"BT /F1 12 Tf 72 680 Td (Next line) Tj ET"),
    ]

    def test_the_run_reads_the_mcid_its_property_list_holds(self, tmp_dir):
        from engine.text_runs import list_text_runs

        runs = list_text_runs(_doc(tmp_dir, "mc.pdf", self._MARKED), 1)["runs"]
        assert [(r["text"], r["mcid"]) for r in runs] == [("Marked words", 3), ("Next line", None)]

    def test_the_paragraph_reads_the_authored_break(self, tmp_dir):
        from engine.text_paragraphs import list_text_paragraphs

        paragraphs = list_text_paragraphs(_doc(tmp_dir, "mc.pdf", self._MARKED), 1)["paragraphs"]
        assert [p["text"] for p in paragraphs] == ["Marked words\nNext line"]


class TestStrokeOutlinesReplayTheColourSpaceByItsBytes:
    """Outlining a stroke fills its outline with the stroke colour, so the
    colour space is selected again, by the same name. The name is written
    with its escapes (ISO 32000-2 §7.3.5); written as text it raised for a
    name that is not UTF-8 and for one that is UTF-8 but not ASCII."""

    @pytest.mark.parametrize("name", [b"CS#FC", b"CS#C3#BC"], ids=["latin-1", "utf-8"])
    def test_the_outline_fills_in_the_same_space(self, tmp_dir, name):
        from outline_builders import FONT_DIR, fonts_available

        from engine.outlines import outline_page

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        src = _doc(tmp_dir, "s.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /ColorSpace << /" + name
            + b" [/ICCBased 5 0 R] >> >> /Contents 4 0 R >>",
            _stream(b"/" + name + b" CS 1 0 0 SCN 5 w 100 100 m 300 300 l S"),
            _stream(b"", b"/N 3 /Alternate /DeviceRGB"),
        ])
        out = os.path.join(tmp_dir, "o.pdf")
        with pikepdf.open(src) as pdf:
            report = outline_page(pdf, pdf.pages[0], 1, os.path.abspath(FONT_DIR), True, True)
            pdf.save(out)
        assert report["strokes"] == 1
        with pikepdf.open(out) as pdf:
            selects = [(str(i.operator), bytes(i.operands[0])) for i in pikepdf.parse_content_stream(pdf.pages[0])
                       if str(i.operator) in ("CS", "cs")]
        spelled = pikepdf.Object.parse(b"/" + name)
        assert selects == [("CS", bytes(spelled)), ("cs", bytes(spelled))]


def _layered(tmp_dir: str, name: str, intent: bytes, extra: bytes = b"") -> str:
    return _doc(tmp_dir, name, [
        b"<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R] /D << /Order [5 0 R] /ON [5 0 R] >> "
        + extra + b" >> >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
        + b" >> /Properties << /MC0 5 0 R >> >> /Contents 4 0 R >>",
        _stream(b"/OC /MC0 BDC BT /F1 12 Tf 72 700 Td (Layer words) Tj ET EMC"),
        b"<< /Type /OCG /Name (Layer) /Intent " + intent + b" >>",
    ])


def _intent_doc(tmp_dir: str, name: str, subtype: bytes, key: bytes) -> str:
    return _doc(tmp_dir, name, [
        b"<< /Type /Catalog /Pages 2 0 R /OutputIntents [<< /Type /OutputIntent /S " + subtype
        + b" /OutputConditionIdentifier (Custom) " + key + b" (v) >>] >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 "
        + _HELVETICA + b" >> >> >>",
        _stream(b"BT /F1 12 Tf 72 700 Td (Intent words) Tj ET"),
    ])


class TestMergesCarryNamesThatAreNotUtf8:
    def test_optional_content_merges_with_an_intent_and_a_key_named_that_way(self, tmp_dir):
        from engine.merge import merge

        first = _layered(tmp_dir, "a.pdf", b"/View")
        second = _layered(tmp_dir, "b.pdf", b"[/View /De#FCsign]", b"/X#FC (extra)")
        out = os.path.join(tmp_dir, "m.pdf")
        assert merge([first, second], out)["pages"] == 2
        assert pdfminer_text(out).count("Layer words") == 2
        with pikepdf.open(out) as pdf:
            intents = [bytes(n) for n in pdf.Root.OCProperties.OCGs[1].Intent]
            keys = [k.encode("utf-8", "surrogateescape") for k in pdf.Root.OCProperties.keys()]
        assert intents == [b"/View", b"/De\xfcsign"]
        assert b"/X\xfc" in keys

    def test_output_intents_merge_when_one_holds_names_that_way(self, tmp_dir):
        from engine.merge import merge

        first = _intent_doc(tmp_dir, "a.pdf", b"/GTS_PDF#FCX", b"/Info#FC")
        second = _intent_doc(tmp_dir, "b.pdf", b"/GTS_PDFX", b"/Info")
        out = os.path.join(tmp_dir, "m.pdf")
        assert merge([first, second], out)["pages"] == 2
        assert pdfminer_text(out).count("Intent words") == 2


class TestBookmarkActionsKeepTheirNameBytes:
    """A bookmark whose action cannot be placed on a page carries the action
    through the listing and back, so an edit of the tree keeps it. A name in
    that action is its bytes (ISO 32000-2 §7.3.5); read with `str()` it
    raised, the item was marked lossy and its action was dropped on save."""

    _BOOKMARKS = [
        b"<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        _stream(b""),
        b"<< /Type /Outlines /First 6 0 R /Last 7 0 R /Count 2 >>",
        b"<< /Title (Named) /Parent 5 0 R /Next 7 0 R /A << /S /Named /N /Ne#FCxtPage >> >>",
        b"<< /Title (Keyed) /Parent 5 0 R /Prev 6 0 R /A << /S /URI /URI (http://x) /K#FCy /V#FCal >> >>",
    ]

    def test_a_round_trip_writes_the_same_names(self, tmp_dir):
        import json

        from engine.ipc import encode_response
        from engine.outline import get_outline, set_outline

        src = _doc(tmp_dir, "b.pdf", self._BOOKMARKS)
        read = get_outline(src)
        assert not any(item.get("action_lossy") for item in read["outline"])
        wire = json.loads(encode_response({"jsonrpc": "2.0", "id": 1, "result": read}))["result"]
        out = os.path.join(tmp_dir, "o.pdf")
        set_outline(src, wire["outline"], out)
        with pikepdf.open(out) as pdf:
            first = pdf.Root.Outlines.First
            second = first.Next
            assert bytes(first.A.N) == b"/Ne\xfcxtPage"
            keys = {k.encode("utf-8", "surrogateescape"): second.A[k] for k in second.A.keys()}
        assert set(keys) == {b"/S", b"/URI", b"/K\xfcy"}
        assert bytes(keys[b"/K\xfcy"]) == b"/V\xfcal"


class TestCopiesByKey:
    """A dictionary with a key that is not UTF-8 is copied entry by entry: a
    copy built from a Python mapping of such keys raised `bad cast`."""

    def test_moving_the_opening_page_keeps_every_entry_of_the_opening_action(self, tmp_dir):
        from engine.doc_properties import set_initial_view

        src = _doc(tmp_dir, "v.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /GoTo /D [3 0 R /Fit] /X#FC 1 >> >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
            _stream(b""),
        ])
        out = os.path.join(tmp_dir, "o.pdf")
        set_initial_view(src, out, open_page=1, zoom="fit-page")
        with pikepdf.open(out) as pdf:
            action = pdf.Root.OpenAction
            keys = sorted(k.encode("utf-8", "surrogateescape") for k in action.keys())
        assert keys == [b"/D", b"/S", b"/X\xfc"]

    def test_a_redaction_copies_a_property_list_and_a_soft_mask_whole(self, tmp_dir):
        from engine.redact import redact

        src = _doc(tmp_dir, "r.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
            + b" >> /ExtGState << /GS1 << /SMask << /S /Luminosity /G 5 0 R /X#FC 1 >> /Y#FC 2 >> >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"/Span << /ActualText (Secret words) /K#FC 1 >> BDC BT /F1 12 Tf 72 700 Td (Secret words) Tj "
                    b"ET EMC q /GS1 gs 0 0 1 rg 100 100 200 200 re f Q"),
            _stream(b"BT /F1 12 Tf 110 150 Td (Mask words) Tj ET",
                    b"/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Group << /S /Transparency /CS /DeviceGray >> "
                    b"/Resources << /Font << /F1 " + _HELVETICA + b" >> >>"),
        ])
        out = os.path.join(tmp_dir, "o.pdf")
        redact(file=src, output=out, regions=[{"page": 1, "rect": [60, 690, 200, 720]},
                                              {"page": 1, "rect": [100, 140, 250, 170]}])
        assert "Secret words" not in pdfminer_text(out)
        with pikepdf.open(out) as pdf:
            page = pdf.pages[0].obj
            [marked] = [i for i in pikepdf.parse_content_stream(pdf.pages[0]) if str(i.operator) == "BDC"]
            [state] = [page.Resources.ExtGState[k] for k in page.Resources.ExtGState.keys()]
            prop_keys = {k.encode("utf-8", "surrogateescape") for k in marked.operands[1].keys()}
            state_keys = {k.encode("utf-8", "surrogateescape") for k in state.keys()}
            mask_keys = {k.encode("utf-8", "surrogateescape") for k in state.SMask.keys()}
        assert prop_keys == {b"/K\xfc"}
        assert state_keys == {b"/SMask", b"/Y\xfc"}
        assert mask_keys == {b"/S", b"/G", b"/X\xfc"}


_ON_FACE = _stream(b"0 0 1 rg 0 0 20 20 re f", b"/Type /XObject /Subtype /Form /BBox [0 0 20 20]")
_OFF_FACE = _stream(b"", b"/Type /XObject /Subtype /Form /BBox [0 0 20 20]")

#: A checkbox whose on-state is `/Gr#FCn` and a radio group whose first
#: option is `/Ja#FC`, both with those states as defaults, and a checkbox
#: action that goes to a legacy destination named `/D#FC`.
_FORM_STATES = [
    b"<< /Type /Catalog /Pages 2 0 R /Dests << /D#FC [3 0 R /Fit] >> "
    b"/AcroForm << /Fields [5 0 R 6 0 R] /NeedAppearances false >> >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R 7 0 R 8 0 R] >>",
    _stream(b""),
    b"<< /Type /Annot /Subtype /Widget /FT /Btn /T (box) /Rect [100 100 120 120] /V /Off /AS /Off /DV /Gr#FCn "
    b"/AP << /N << /Gr#FCn 9 0 R /Off 10 0 R >> >> /A << /S /GoTo /D /D#FC >> >>",
    b"<< /FT /Btn /Ff 49152 /T (choice) /V /Off /DV /Ja#FC /Kids [7 0 R 8 0 R] >>",
    b"<< /Type /Annot /Subtype /Widget /Parent 6 0 R /Rect [100 200 120 220] /AS /Off "
    b"/AP << /N << /Ja#FC 9 0 R /Off 10 0 R >> >> >>",
    b"<< /Type /Annot /Subtype /Widget /Parent 6 0 R /Rect [140 200 160 220] /AS /Off "
    b"/AP << /N << /Nein 9 0 R /Off 10 0 R >> >> >>",
    _ON_FACE,
    _OFF_FACE,
]


def _form_states(path: str) -> dict:
    with pikepdf.open(path) as pdf:
        box, choice = pdf.Root.AcroForm.Fields[0], pdf.Root.AcroForm.Fields[1]
        return {
            "box": (bytes(box.V), bytes(box.AS)),
            "choice": bytes(choice.V),
            "kids": [bytes(kid.AS) for kid in choice.Kids],
        }


_ALL_ON = {"box": (b"/Gr\xfcn", b"/Gr\xfcn"), "choice": b"/Ja\xfc", "kids": [b"/Ja\xfc", b"/Off"]}


class TestFormStatesThatAreNotUtf8:
    """An appearance state is a name (ISO 32000-2 §12.7.5.2.3), so it is its
    bytes: a fill, a reset and an import write the state the widget's
    appearance dictionary holds, and a listing shows it as text."""

    def test_the_reader_shows_each_state_as_text(self, tmp_dir):
        from engine.forms import read_form_fields

        fields = read_form_fields(_doc(tmp_dir, "f.pdf", _FORM_STATES))["fields"]
        assert [(f["name"], f["type"], f.get("options"), f.get("export_value")) for f in fields] == [
            ("box", "checkbox", None, "Gr#FCn"), ("choice", "radio", ["Ja#FC", "Nein"], None)]

    def test_a_fill_writes_the_states_the_appearances_hold(self, tmp_dir):
        from engine.forms import fill_form_fields, read_form_fields

        out = os.path.join(tmp_dir, "o.pdf")
        fill_form_fields(_doc(tmp_dir, "f.pdf", _FORM_STATES), out, {"box": True, "choice": "Ja#FC"})
        assert _form_states(out) == _ALL_ON
        assert [(f["name"], f["value"]) for f in read_form_fields(out)["fields"]] == [
            ("box", True), ("choice", "Ja#FC")]

    def test_a_reset_restores_each_default_state(self, tmp_dir):
        from engine.forms import fill_form_fields, reset_form_fields

        filled = os.path.join(tmp_dir, "filled.pdf")
        fill_form_fields(_doc(tmp_dir, "f.pdf", _FORM_STATES), filled, {"choice": "Nein"})
        out = os.path.join(tmp_dir, "o.pdf")
        reset_form_fields(filled, out)
        assert _form_states(out) == _ALL_ON

    def test_an_fdf_import_selects_each_state_by_its_name(self, tmp_dir):
        from engine.forms import import_form_data

        data = os.path.join(tmp_dir, "in.fdf")
        with open(data, "wb") as fh:
            fh.write(b"%FDF-1.2\n1 0 obj << /FDF << /Fields [<< /T (choice) /V /Ja#FC >> << /T (box) /V /Gr#FCn >>] "
                     b">> >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n")
        out = os.path.join(tmp_dir, "o.pdf")
        assert import_form_data(_doc(tmp_dir, "f.pdf", _FORM_STATES), out, data=data)["imported"] == 2
        assert _form_states(out) == _ALL_ON

    def test_a_field_action_reaches_a_legacy_destination_by_its_name(self, tmp_dir):
        from engine.fieldactions import classify

        with pikepdf.open(_doc(tmp_dir, "f.pdf", _FORM_STATES)) as pdf:
            box = pdf.Root.AcroForm.Fields[0]
            assert classify(pdf, box.A) == {"kind": "goto", "page": 0}


def _pyhanko_names_pdf(tmp_dir: str) -> str:
    """A page font and a form resource named `/F#E9`, and a checkbox whose on
    state is `/Stra#DFe`: names pyHanko reads as Latin-1 text."""
    content = b"BT /F#E9 12 Tf 20 150 Td (Hello) Tj ET"
    return _doc(tmp_dir, "names.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] "
        b"/Resources << /Font << /F#E9 4 0 R >> >> /Contents 5 0 R /Annots [7 0 R] >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        _stream(content),
        b"<< /Fields [7 0 R] /DR << /Font << /F#E9 4 0 R >> >> /DA (/Helv 0 Tf 0 g) >>",
        b"<< /Type /Annot /Subtype /Widget /FT /Btn /T (box) /Rect [20 20 40 40] /F 4 "
        b"/P 3 0 R /V /Off /AS /Off /AP << /N << /Stra#DFe 8 0 R /Off 9 0 R >> "
        b"/D << /Stra#DFe 9 0 R /Off 9 0 R >> >> /MK << /CA (4) >> >>",
        _stream(b"0 0 1 rg 0 0 20 20 re f", b"/Type /XObject /Subtype /Form /BBox [0 0 20 20]"),
        _stream(b"", b"/Type /XObject /Subtype /Form /BBox [0 0 20 20]"),
    ])


def _spelled(keys) -> list[bytes]:
    return sorted(k.encode("utf-8", "surrogateescape") for k in keys)


def _pyhanko_names_of(path: str) -> dict:
    with pikepdf.open(path) as pdf:
        page = pdf.pages[0].obj
        widget = next(a for a in page.Annots if a.get("/FT") == pikepdf.Name.Btn)
        return {
            "page fonts": _spelled(page.Resources.Font.keys()),
            "form fonts": _spelled(pdf.Root.AcroForm.DR.Font.keys()),
            "states": _spelled(widget.AP.N.keys()),
            "as": bytes(widget.AS),
        }


class TestPyhankoWritesEachNameAsItsBytes:
    """pyHanko reads a name that is not UTF-8 as Latin-1 text and writes the
    UTF-8 encoding of that text, so a signed revision, an appended revision
    or a certificate-encrypted copy renamed `/F#E9` to `/F#C3#A9` and broke
    the font and form references it held."""

    def test_signing_keeps_every_name(self, tmp_dir):
        from test_pades import _build_pki

        from engine.signatures import sign_pdf, verify_signatures

        pki = _build_pki(tmp_dir)
        src = _pyhanko_names_pdf(tmp_dir)
        before = _pyhanko_names_of(src)
        out = os.path.join(tmp_dir, "signed.pdf")
        sign_pdf(src, out, pfx_path=pki["pfx"], password="pw")
        assert _pyhanko_names_of(out) == before == {
            "page fonts": [b"/F\xe9"], "form fonts": [b"/F\xe9"], "states": [b"/Off", b"/Stra\xdfe"],
            "as": b"/Off"}
        [signature] = verify_signatures(out)["signatures"]
        assert signature["intact"] is True

    def test_a_fill_after_signing_appends_one_revision_that_keeps_the_signature(self, tmp_dir):
        from test_pades import _build_pki

        from engine.incremental import transplant_incremental
        from engine.signatures import sign_pdf, verify_signatures

        pki = _build_pki(tmp_dir)
        signed = os.path.join(tmp_dir, "signed.pdf")
        sign_pdf(_pyhanko_names_pdf(tmp_dir), signed, pfx_path=pki["pfx"], password="pw")
        modified = os.path.join(tmp_dir, "modified.pdf")
        with pikepdf.open(signed) as pdf:
            widget = next(a for a in pdf.pages[0].obj.Annots if a.get("/FT") == pikepdf.Name.Btn)
            state = pikepdf.Object.parse(b"/Stra#DFe")
            widget["/V"] = state
            widget["/AS"] = state
            pdf.save(modified)
        out = os.path.join(tmp_dir, "appended.pdf")
        result = transplant_incremental(signed, modified, out)
        assert result["applied"] is True, result
        with open(signed, "rb") as fh:
            original = fh.read()
        with open(out, "rb") as fh:
            assert fh.read().startswith(original)
        names = _pyhanko_names_of(out)
        assert (names["page fonts"], names["as"]) == ([b"/F\xe9"], b"/Stra\xdfe")
        [signature] = verify_signatures(out)["signatures"]
        assert (signature["intact"], signature["modification_level"]) == (True, "FORM_FILLING")

    def test_certificate_encryption_keeps_every_name(self, tmp_dir):
        from test_pubkey_crypt import _identity

        from engine.pubkey_crypt import decrypt_with_pfx, encrypt_with_certs

        cert, pfx = _identity(tmp_dir, "recipient")
        src = _pyhanko_names_pdf(tmp_dir)
        encrypted = os.path.join(tmp_dir, "encrypted.pdf")
        encrypt_with_certs(src, encrypted, [cert])
        with open(encrypted, "rb") as fh:
            data = fh.read()
        assert b"/F#E9" in data and b"/F#C3#A9" not in data
        plain = os.path.join(tmp_dir, "plain.pdf")
        decrypt_with_pfx(encrypted, plain, pfx, "test-pass")
        assert _pyhanko_names_of(plain) == _pyhanko_names_of(src)


def _page_doc(tmp_dir: str, name: str, catalog: bytes = b"", page: bytes = b"", content: bytes = b"",
              extra: tuple = ()) -> str:
    """One page of Helvetica text, with entries added to the catalog and the
    page and objects numbered from 5."""
    return _doc(tmp_dir, name, [
        b"<< /Type /Catalog /Pages 2 0 R " + catalog + b" >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
        + b" >> >> /Contents 4 0 R " + page + b" >>",
        _stream(content or b"BT /F1 12 Tf 72 700 Td (Words) Tj ET"),
        *extra,
    ])


class TestDeclarationsAndDestinationsNamedWithBytesThatAreNotUtf8:
    def test_a_merge_carries_an_extension_declaration_byte_for_byte(self, tmp_dir):
        from engine.merge import merge

        declaration = b"/Extensions << /SPEC << /BaseVersion /1.7 /ExtensionLevel 3 /X#FC /Y#FC >> >>"
        first = _page_doc(tmp_dir, "a.pdf", declaration)
        second = _page_doc(tmp_dir, "b.pdf", declaration)
        out = os.path.join(tmp_dir, "m.pdf")
        merge([first, second], out)
        with pikepdf.open(out) as pdf:
            carried = pdf.Root.Extensions.SPEC.unparse(resolved=True)
        assert carried == b"<< /BaseVersion /1.7 /ExtensionLevel 3 /X#fc /Y#fc >>"

    def test_the_initial_view_reads_an_opening_destination_named_that_way(self, tmp_dir):
        from engine.doc_properties import get_initial_view

        view = get_initial_view(_page_doc(tmp_dir, "v.pdf", b"/OpenAction /D#FC /Dests << /D#FC [3 0 R /FitH 500] >>"))
        assert (view["open_page"], view["zoom"]) == (1, "fit-width")

    def test_a_link_reads_a_fit_it_does_not_know_as_inherit(self, tmp_dir):
        from engine.links import list_links

        src = _page_doc(tmp_dir, "l.pdf", page=b"/Annots [5 0 R]", extra=(
            b"<< /Type /Annot /Subtype /Link /Rect [70 695 90 715] /Dest [3 0 R /XY#FCZ 10 20 1] >>",))
        assert [link["target_spec"] for link in list_links(src)["links"]] == [
            {"kind": "goto", "page": 1, "view": {"mode": "inherit"}}]

    def test_two_links_under_one_label_to_two_such_destinations_are_two_targets(self, tmp_dir):
        from engine.accessibility import check_accessibility

        src = _page_doc(
            tmp_dir, "t.pdf", b"/Dests << /A#FC [3 0 R /Fit] /B#FC [3 0 R /Fit] >>", b"/Annots [5 0 R 6 0 R]",
            b"BT /F1 12 Tf 72 700 Td (Go) Tj ET BT /F1 12 Tf 72 600 Td (Go) Tj ET",
            (b"<< /Type /Annot /Subtype /Link /Rect [70 695 90 715] /Dest /A#FC >>",
             b"<< /Type /Annot /Subtype /Link /Rect [70 595 90 615] /Dest /B#FC >>"))
        report = check_accessibility(src)
        [check] = [c for cat in report["categories"] for c in cat["checks"] if c["id"] == "navigation_links"]
        assert [f["detail_key"] for f in check["findings"]] == ["same_label_different_targets"]


class TestTextValuesThatAreNames:
    """A text value written as a name is malformed, and it still reads: as
    its solidus and its text, the way `str()` reads a UTF-8 one."""

    def test_a_document_script_written_as_a_name_lists(self, tmp_dir):
        from engine.document_js import list_document_js

        src = _page_doc(tmp_dir, "j.pdf", b"/Names << /JavaScript << /Names [(init) << /S /JavaScript /JS /al#FCert >>] >> >>")
        assert list_document_js(src)["scripts"] == [{"name": "init", "js": "/al#FCert"}]

    def test_a_language_written_as_a_name_reads(self, tmp_dir):
        from engine.spelling import document_language

        assert document_language(_page_doc(tmp_dir, "g.pdf", b"/Lang /d#FCe")) == {"language": "/d#FCe"}

    def test_a_checkbox_value_reads_in_the_audit(self, tmp_dir):
        from engine.sanitize import audit_hidden_information

        audit = audit_hidden_information(_doc(tmp_dir, "v.pdf", _VOCAB_PAGE))
        [fields] = [c for c in audit["categories"] if c["id"] == "form_fields"]
        assert {"name": "box", "type": "Btn", "value": "/Gr#FCn"} in fields["detail"]

    def test_a_signature_field_lock_it_does_not_know_reads_as_no_lock(self, tmp_dir):
        from engine.forms import read_form_fields

        src = _page_doc(tmp_dir, "s.pdf", b"/AcroForm << /Fields [5 0 R] >>", b"/Annots [5 0 R]", extra=(
            b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (sig) /Rect [0 0 10 10] "
            b"/Lock << /Type /SigFieldLock /Action /Al#FCl >> >>",))
        [field] = read_form_fields(src)["fields"]
        assert (field["type"], field["lock"]) == ("signature", None)


class TestFontNamesThatAreNotUtf8:
    def test_the_font_list_names_a_base_encoding_and_an_embedded_cmap(self, tmp_dir):
        from engine.font_inventory import list_document_fonts

        cmap = _stream(
            b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Custom#FC def "
            b"1 begincodespacerange <0000> <FFFF> endcodespacerange 1 begincidrange <0000> <FFFF> 0 endcidrange "
            b"endcmap CMapName currentdict /CMap defineresource pop end end",
            b"/Type /CMap /CMapName /Custom#FC /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) "
            b"/Supplement 0 >>")
        src = _doc(tmp_dir, "f.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << "
            b"/F4 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /BaseEncoding /Mac#FCRoman >> >> "
            b"/F5 << /Type /Font /Subtype /Type0 /BaseFont /Arial /Encoding 5 0 R /DescendantFonts [<< /Type /Font "
            b"/Subtype /CIDFontType2 /BaseFont /Arial /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) "
            b"/Supplement 0 >> /DW 1000 >>] >> >> >> /Contents 4 0 R >>",
            _stream(b"BT /F4 12 Tf 72 700 Td (A) Tj ET BT /F5 12 Tf 72 600 Td <0041> Tj ET"),
            cmap,
        ])
        fonts = list_document_fonts(src)["fonts"]
        assert sorted((f["name"], f["encoding"]) for f in fonts) == [
            ("Arial", "Custom#FC"), ("Helvetica", "Mac#FCRoman")]

    def test_an_outline_draws_the_glyph_the_differences_name_after_one_it_cannot(self):
        from outline_builders import FONT_DIR, fonts_available

        from engine.glyph_outlines import GlyphSource
        from engine.pdf_fonts import font_capability

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        remapped = pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica,
            Encoding=pikepdf.Dictionary(Differences=pikepdf.Array(
                [65, pikepdf.Object.parse(b"/g#FC"), pikepdf.Name("/eacute")])))
        plain = pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
                                   BaseFont=pikepdf.Name.Helvetica, Encoding=pikepdf.Name.WinAnsiEncoding)
        face = os.path.abspath(FONT_DIR)
        drawn = GlyphSource(remapped, font_capability(remapped), face).contours(66, b"B")
        eacute = GlyphSource(plain, font_capability(plain), face).contours(0xE9, b"\xe9")
        assert drawn == eacute

    def test_a_cid_font_with_a_glyph_map_named_that_way_refuses_for_its_mapping(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.text_runs import list_text_runs

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        with open(os.path.join(FONT_DIR, "LiberationSans-Regular.ttf"), "rb") as fh:
            program = fh.read()
        src = _doc(tmp_dir, "c.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"BT /F1 12 Tf 72 700 Td <0024> Tj ET"),
            b"<< /Type /Font /Subtype /Type0 /BaseFont /LiberationSans /Encoding /Identity-H /DescendantFonts [6 0 R] >>",
            b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LiberationSans /CIDSystemInfo << /Registry (Adobe) "
            b"/Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 /CIDToGIDMap /Id#FCentity >>",
            b"<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 "
            b"/Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>",
            b"<< /Length %d /Length1 %d >> stream\n" % (len(program), len(program)) + program + b"\nendstream",
        ])
        [run] = list_text_runs(src, 1)["runs"]
        assert run["editable"] is False
        assert run["reason"] == "no ToUnicode map and no recoverable mapping — this text cannot be re-entered"


class TestImagesAndScansWithNamesThatAreNotUtf8:
    def test_a_redaction_rewrites_an_inline_image_whose_space_is_named_that_way(self, tmp_dir):
        from engine.redact import redact

        src = _doc(tmp_dir, "i.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /ColorSpace << /CS#FC /DeviceGray >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"q 100 0 0 100 100 500 cm BI /W 4 /H 4 /BPC 8 /CS /CS#FC ID " + bytes(range(0, 256, 16))
                    + b" EI Q"),
        ])
        out = os.path.join(tmp_dir, "r.pdf")
        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [100, 500, 150, 550]}])
        assert (result["images_modified"], result["images_removed"]) == (1, 0)

    def test_the_resolution_summary_reads_a_scan_whose_space_is_named_that_way(self, tmp_dir):
        from engine.image_resolution import summarize_image_resolution

        src = _doc(tmp_dir, "s.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"q 612 0 0 792 0 0 cm /Im1 Do Q"),
            _stream(bytes(range(16)), b"/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace [/Ind#FCexed "
                    b"/DeviceRGB 255 <" + b"00" * 768 + b">] /BitsPerComponent 8"),
        ])
        summary = summarize_image_resolution(src)
        assert (summary["scan_pages"], [p["colour_family"] for p in summary["placements"]]) == (1, ["Ind#FCexed"])


class TestNamesInsideDictionariesAndFieldTypes:
    def test_the_hidden_text_audit_reads_past_a_soft_mask_dictionary_holding_such_a_name(self, tmp_dir):
        from engine.sanitize import audit_hidden_information

        src = _doc(tmp_dir, "m.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
            + b" >> /ExtGState << /G1 << /SMask << /S /Lum#FCinosity /G 5 0 R >> >> >> >> /Contents 4 0 R >>",
            _stream(b"BT /F1 12 Tf 72 700 Td (Covered words) Tj ET 1 1 1 rg 60 690 200 30 re f q /G1 gs Q"),
            _stream(b"", b"/Type /XObject /Subtype /Form /BBox [0 0 10 10]"),
        ])
        audit = audit_hidden_information(src)
        [hidden] = [c for c in audit["categories"] if c["id"] == "hidden_text"]
        assert [(d["kind"], d["text"]) for d in hidden["detail"]] == [("covered", "Covered words")]

    def test_the_space_audit_names_a_filter_it_does_not_know(self, tmp_dir):
        from engine.space_audit import audit_space_usage

        src = _doc(tmp_dir, "s.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"q 100 0 0 50 100 500 cm /Im1 Do Q"),
            _stream(bytes(200), b"/Type /XObject /Subtype /Image /Width 10 /Height 20 /ColorSpace /DeviceGray "
                    b"/BitsPerComponent 8 /Filter /Fl#FCte"),
        ])
        [images] = [c for c in audit_space_usage(src)["categories"] if c["id"] == "images"]
        assert [(d["name"], d["type"]) for d in images["detail"]] == [("/Im1", "Fl#FCte")]


_TOUNICODE_A = _stream(
    b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def "
    b"/CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfchar <0024> <0041> "
    b"endbfchar endcmap CMapName currentdict /CMap defineresource pop end end")


def _a11y_kitchen(tmp_dir: str, program: bytes) -> str:
    """A tagged page whose fonts, forms, annotations, actions, list numbering,
    file specification and content hold names that are not UTF-8."""
    return _doc(tmp_dir, "a11y.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 20 0 R /Lang (en) "
        b"/ViewerPreferences << /DisplayDocTitle true >> /Names << /EmbeddedFiles << /Names [(a.txt) 30 0 R] >> >> "
        b"/AcroForm << /Fields [12 0 R] >> >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Tabs /S /StructParents 0 "
        b"/Resources << /Font << /F1 5 0 R /F2 8 0 R /F3 9 0 R /F4 10 0 R >> /XObject << /Fm1 11 0 R /Fm2 13 0 R >> >> "
        b"/Contents 4 0 R /Annots [14 0 R 15 0 R 16 0 R 17 0 R 12 0 R] >>",
        _stream(b"q \xfc\xfd Q "
                b"/P << /MCID 0 >> BDC BT /F1 12 Tf 72 700 Td <0024> Tj ET EMC "
                b"/P << /MCID 1 >> BDC BT /F2 12 Tf 72 680 Td (Plain words) Tj ET EMC "
                b"/P << /MCID 2 >> BDC BT /F3 12 Tf 72 660 Td (AB) Tj ET EMC "
                b"/P << /MCID 3 >> BDC BT /F4 12 Tf 72 640 Td (Other words) Tj ET EMC "
                b"/Figure << /MCID 4 >> BDC q 1 0 0 1 72 400 cm /Fm1 Do Q EMC "
                b"q 1 0 0 1 300 400 cm /Fm2 Do Q "
                b"0 0 1 rg 400 100 50 50 re f"),
        b"<< /Type /Font /Subtype /Type0 /BaseFont /LiberationSans /Encoding /Identity-H /DescendantFonts [6 0 R] "
        b"/ToUnicode 19 0 R >>",
        b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LiberationSans /CIDSystemInfo << /Registry (Adobe) "
        b"/Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 /CIDToGIDMap /Id#FCentity >>",
        b"<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 "
        b"/Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 18 0 R >>",
        b"<< /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /FirstChar 32 /LastChar 126 "
        b"/Encoding /Win#FCAnsiEncoding /FontDescriptor 7 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /BaseEncoding /Mac#FCRoman "
        b"/Differences [65 /g#FC /B] >> >>",
        b"<< /Type /Font /Subtype /Type#FC1 /BaseFont /Helvetica >>",
        _stream(b"BT /F1 12 Tf 0 10 Td <0024> Tj ET",
                b"/Type /XObject /Subtype /Form /BBox [0 0 200 50] /Resources << /Font << /F1 5 0 R >> >>"),
        b"<< /Type /Annot /Subtype /Widget /FT /T#FCx /T (odd) /TU (Odd field) /Rect [72 300 172 320] /StructParent 1 >>",
        _stream(b"", b"/Type /XObject /Subtype /Fo#FCrm /BBox [0 0 10 10] /Ref << /F (other.pdf) /Page 0 >>"),
        b"<< /Type /Annot /Subtype /Te#FCxt /Rect [10 10 30 30] /Contents (odd) >>",
        b"<< /Type /Annot /Subtype /Link /Rect [70 695 90 715] /A << /S /X#FC >> /StructParent 2 >>",
        b"<< /Type /Annot /Subtype /Link /Rect [70 675 90 695] /A << /S /Y#FC /Next << /S /URI /URI (http://x) >> >> "
        b"/StructParent 3 >>",
        b"<< /Type /Annot /Subtype /Link /Rect [70 655 90 675] /A << /S /GoTo /D /D#FC >> /StructParent 4 >>",
        b"<< /Length %d /Length1 %d >> stream\n" % (len(program), len(program)) + program + b"\nendstream",
        _TOUNICODE_A,
        b"<< /Type /StructTreeRoot /K 21 0 R /ParentTree << /Nums [0 [22 0 R 23 0 R 24 0 R 25 0 R 26 0 R] "
        b"1 27 0 R 2 28 0 R 3 28 0 R 4 28 0 R] >> >>",
        b"<< /Type /StructElem /S /Document /P 20 0 R /K [22 0 R 23 0 R 24 0 R 25 0 R 26 0 R 27 0 R 28 0 R 29 0 R] >>",
        b"<< /Type /StructElem /S /P /P 21 0 R /Pg 3 0 R /K 0 >>",
        b"<< /Type /StructElem /S /P /P 21 0 R /Pg 3 0 R /K 1 >>",
        b"<< /Type /StructElem /S /P /P 21 0 R /Pg 3 0 R /K 2 >>",
        b"<< /Type /StructElem /S /P /P 21 0 R /Pg 3 0 R /K 3 >>",
        b"<< /Type /StructElem /S /Figure /P 21 0 R /Pg 3 0 R /K 4 /Alt (A figure) >>",
        b"<< /Type /StructElem /S /Form /P 21 0 R /Pg 3 0 R /K << /Type /OBJR /Obj 12 0 R >> >>",
        b"<< /Type /StructElem /S /Link /P 21 0 R /Pg 3 0 R /K [<< /Type /OBJR /Obj 15 0 R >> "
        b"<< /Type /OBJR /Obj 16 0 R >> << /Type /OBJR /Obj 17 0 R >>] >>",
        b"<< /Type /StructElem /S /L /P 21 0 R /A << /O /List /ListNumbering /Deci#FCmal >> /K [] >>",
        b"<< /Type /Filesp#FCec /F (a.txt) /EF << /F 31 0 R >> >>",
        _stream(b"hello", b"/Type /EmbeddedFile"),
    ])


#: Every check's status and finding kinds on the document above.
_A11Y_KITCHEN_REPORT = {
    "alt_hides_annotation": ["pass", []], "alt_no_content": ["pass", []], "artifact_judgement": ["pass", []],
    "bookmarks": ["not_applicable", []], "character_encoding": ["pass", []],
    "cid_to_gid_map": ["fail", ["cid_font_no_cid_to_gid_map"]], "content_grouping": ["pass", []],
    "content_order": ["not_applicable", []], "contrast": ["pass", []], "dynamic_xfa": ["not_applicable", []],
    "embedded_file_names": ["not_applicable", []], "field_descriptions": ["pass", []], "figures_alt": ["pass", []],
    "font_embedding": ["fail", ["font_not_embedded", "font_not_embedded"]],
    "font_encodings": ["fail", ["nonsymbolic_truetype_bad_encoding"]], "heading_nesting": ["not_applicable", []],
    "heading_semantics": ["pass", []], "heading_tag_mixing": ["not_applicable", []], "image_only": ["pass", []],
    "lang": ["pass", []], "link_ismap": ["pass", []], "list_item_structure": ["not_applicable", []],
    "list_items": ["not_applicable", []], "list_labels": ["not_applicable", []], "list_numbering": ["not_applicable", []],
    "list_semantics": ["pass", []], "media_clip_data": ["not_applicable", []], "navigation_links": ["pass", []],
    "nested_alt": ["pass", []], "optional_content_config": ["not_applicable", []],
    "other_elements_alt": ["fail", ["element_missing_description"]], "permissions": ["pass", []],
    "print_field_attributes": ["not_applicable", []], "reading_order": ["pass", []], "reference_xobjects": ["pass", []],
    "role_map": ["pass", []], "screen_flicker": ["not_applicable", []], "scripts": ["not_applicable", []],
    "structure_nesting": ["not_applicable", []], "suspects": ["pass", []], "tab_order": ["pass", []],
    "table_cells": ["not_applicable", []], "table_headers": ["not_applicable", []],
    "table_regularity": ["not_applicable", []], "table_rows": ["not_applicable", []],
    "table_summary": ["not_applicable", []], "tagged": ["pass", []], "tagged_annotations": ["fail", ["annotation_not_tagged"]],
    "tagged_content": ["pass", []], "tagged_form_fields": ["pass", []], "tagged_multimedia": ["not_applicable", []],
    "timed_responses": ["not_applicable", []], "title": ["fail", ["title_missing"]],
    "trapnet_annotations": ["pass", []], "unicode_mapping": ["pass", []],
    "untagged_graphics": ["fail", ["graphics_outside_marked_content"]],
}


class TestTheAccessibilityInventoryReadsEveryNameThatIsNotUtf8:
    """Each check reads names: font subtypes and encodings, glyph maps,
    Differences glyph names, field types, annotation subtypes, action types,
    list numbering, file specification types, and every content operator. A
    name the vocabulary does not know is an unknown value, and every check
    still reports; `str()` of one raised and failed the whole inventory."""

    def test_every_check_reports_on_the_document(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.accessibility import check_accessibility

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        with open(os.path.join(FONT_DIR, "LiberationSans-Regular.ttf"), "rb") as fh:
            program = fh.read()
        report = check_accessibility(_a11y_kitchen(tmp_dir, program))
        summary = {check["id"]: [check["status"], sorted(f.get("detail_key") or "" for f in check["findings"])]
                   for cat in report["categories"] for check in cat["checks"]}
        assert summary == _A11Y_KITCHEN_REPORT


def _a11y_values(tmp_dir: str, program: bytes) -> str:
    """Names that are not UTF-8 where a check reports their value: two links
    over one label to two such destinations, two over another label with two
    such action types, a field and an annotation of such types, two sibling
    lists declaring one such numbering, a header cell of such a scope, a
    TrueType encoding of such a base and glyph name, a CIDFont of such a
    subtype and a media clip of such a subtype."""
    return _doc(tmp_dir, "a11y-values.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 20 0 R /Lang (en) "
        b"/AcroForm << /Fields [12 0 R] >> /X [19 0 R] >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Tabs /S /StructParents 0 "
        b"/Resources << /Font << /F1 " + _HELVETICA + b" /F5 5 0 R /F6 8 0 R >> >> "
        b"/Contents 4 0 R /Annots [10 0 R 13 0 R 14 0 R 15 0 R 16 0 R 17 0 R 12 0 R] >>",
        _stream(b"/P << /MCID 0 >> BDC BT /F1 12 Tf 72 600 Td (Next) Tj 228 0 Td (Next) Tj ET EMC "
                b"/P << /MCID 1 >> BDC BT /F1 12 Tf 72 560 Td (Back) Tj 228 0 Td (Back) Tj ET EMC "
                b"/P << /MCID 2 >> BDC BT /F5 12 Tf 72 520 Td (AB) Tj ET EMC "
                b"/P << /MCID 3 >> BDC BT /F6 12 Tf 72 480 Td <0024> Tj ET EMC"),
        b"<< /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /FirstChar 32 /LastChar 126 "
        b"/Encoding << /BaseEncoding /Mac#FCRoman /Differences [65 /g#FC] >> /FontDescriptor 6 0 R >>",
        b"<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 "
        b"/Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>",
        b"<< /Length %d /Length1 %d >> stream\n" % (len(program), len(program)) + program + b"\nendstream",
        b"<< /Type /Font /Subtype /Type0 /BaseFont /LiberationSans /Encoding /Identity-H /DescendantFonts [9 0 R] >>",
        b"<< /Type /Font /Subtype /CIDFontType#FC2 /BaseFont /LiberationSans /CIDSystemInfo << /Registry (Adobe) "
        b"/Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW 1000 >>",
        b"<< /Type /Annot /Subtype /Te#FCxt /Rect [10 10 30 30] /Contents (odd) >>",
        b"null",
        b"<< /Type /Annot /Subtype /Widget /FT /Ch#FC /T (pick) /Rect [72 300 172 320] >>",
        b"<< /Type /Annot /Subtype /Link /Rect [70 595 100 615] /A << /S /GoTo /D /Ch#E91 >> /StructParent 1 >>",
        b"<< /Type /Annot /Subtype /Link /Rect [298 595 330 615] /A << /S /GoTo /D /Ch#E92 >> /StructParent 2 >>",
        b"<< /Type /Annot /Subtype /Link /Rect [70 555 100 575] /A << /S /X#FC1 >> /StructParent 3 >>",
        b"<< /Type /Annot /Subtype /Link /Rect [298 555 330 575] /A << /S /X#FC2 >> /StructParent 4 >>",
        b"<< /Type /Annot /Subtype /Te#FCxt /Rect [10 40 30 60] /Contents (odd) /StructParent 5 >>",
        b"null",
        b"<< /Type /MediaClip /S /M#FCCD /CT (video/mp4) /Alt [() (A clip)] >>",
        b"<< /Type /StructTreeRoot /K 21 0 R /ParentTree << /Nums [0 [22 0 R 22 0 R 23 0 R 23 0 R] "
        b"1 24 0 R 2 24 0 R 3 24 0 R 4 24 0 R 5 25 0 R] >> >>",
        b"<< /Type /StructElem /S /Document /P 20 0 R /K [22 0 R 23 0 R 24 0 R 25 0 R 26 0 R 27 0 R 28 0 R] >>",
        b"<< /Type /StructElem /S /P /P 21 0 R /Pg 3 0 R /K [0 1] >>",
        b"<< /Type /StructElem /S /P /P 21 0 R /Pg 3 0 R /K [2 3] >>",
        b"<< /Type /StructElem /S /Link /P 21 0 R /Pg 3 0 R /K [<< /Type /OBJR /Obj 13 0 R >> "
        b"<< /Type /OBJR /Obj 14 0 R >> << /Type /OBJR /Obj 15 0 R >> << /Type /OBJR /Obj 16 0 R >>] /Alt (Links) >>",
        b"<< /Type /StructElem /S /Annot /P 21 0 R /Pg 3 0 R /K << /Type /OBJR /Obj 17 0 R >> /Alt (A note) >>",
        b"<< /Type /StructElem /S /L /P 21 0 R /A << /O /List /ListNumbering /Dec#FCimal >> /K [] >>",
        b"<< /Type /StructElem /S /L /P 21 0 R /A << /O /List /ListNumbering /Dec#FCimal >> /K [] >>",
        b"<< /Type /StructElem /S /Table /P 21 0 R /K [29 0 R] >>",
        b"<< /Type /StructElem /S /TR /P 28 0 R /K [30 0 R 31 0 R] >>",
        b"<< /Type /StructElem /S /TH /P 29 0 R /A << /O /Table /Scope /Co#FClumn >> /K [] >>",
        b"<< /Type /StructElem /S /TD /P 29 0 R /K [] >>",
    ])


#: What the checks above report on that document: each value is the name's
#: label, and nothing is unreadable.
_A11Y_VALUES_REPORT = {
    "cid_to_gid_map": ["not_applicable", []],
    "field_descriptions": ["fail", [["field_has_no_description", [("type", "Ch#FC")]]]],
    "font_encodings": ["fail", [["nonsymbolic_truetype_bad_encoding", [("font", "LiberationSans")]],
                                ["nonsymbolic_truetype_unlisted_glyph_name",
                                 [("font", "LiberationSans"), ("glyph", "g#FC")]]]],
    "list_semantics": ["needs_review", [["adjacent_lists_declare_alike", [("numbering", "Dec#FCimal")]]]],
    "media_clip_data": ["not_applicable", []],
    "navigation_links": ["needs_review", [["same_label_different_targets", [("count", 2), ("targets", 2)]],
                                          ["same_label_different_targets", [("count", 2), ("targets", 2)]]]],
    "table_headers": ["pass", []],
    "tagged_annotations": ["fail", [["annotation_not_tagged", [("page", 1), ("subtype", "Te#FCxt")]]]],
}


class TestEveryCheckReportsTheValueOfANameThatIsNotUtf8:
    """A check that names a value it read (a field type, an annotation
    subtype, a list numbering, a glyph name) reports the name's label, and
    two such names that differ stay different: `str()` of one raised, and the
    check either dropped the value, merged every such name into one, or
    reported the object unreadable."""

    def test_each_check_reports_the_label(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.accessibility import check_accessibility

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        with open(os.path.join(FONT_DIR, "LiberationSans-Regular.ttf"), "rb") as fh:
            program = fh.read()
        report = check_accessibility(_a11y_values(tmp_dir, program))
        wanted = {"navigation_links", "field_descriptions", "tagged_annotations", "list_semantics",
                  "table_headers", "font_encodings", "cid_to_gid_map", "media_clip_data"}
        summary = {check["id"]: [check["status"], sorted(
            [f.get("detail_key") or "", sorted((f.get("values") or {}).items())] for f in check["findings"])]
            for cat in report["categories"] for check in cat["checks"] if check["id"] in wanted}
        assert report["unreadable"] == []
        assert summary == _A11Y_VALUES_REPORT


def _sanitize_kitchen(tmp_dir: str, field_type: bytes) -> str:
    """Annotations, actions, fields and a file specification whose types are
    names that are not UTF-8, beside readable ones of each kind."""
    return _doc(tmp_dir, "san.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [8 0 R 9 0 R] >> "
        b"/OpenAction << /S /GoTo /D [3 0 R /Fit] /Next << /S /Laun#FCch /F (x.exe) >> >> "
        b"/AA << /WC << /S /Java#FCScript /JS (x) >> /WS << /S /JavaScript /JS (y) >> >> "
        b"/Names << /EmbeddedFiles << /Names [(a.txt) 12 0 R] >> >> >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
        + b" >> >> /Contents 4 0 R /Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 11 0 R] "
        b"/AA << /O << /S /Sub#FCmitForm /F (http://x) >> >> >>",
        _stream(b"BT /F1 12 Tf 72 700 Td (Words) Tj ET"),
        b"<< /Type /Annot /Subtype /Te#FCxt /Rect [10 10 30 30] /Contents (odd) >>",
        b"<< /Type /Annot /Subtype /Text /Rect [40 10 60 30] /Contents (A note) /T (Ann) >>",
        b"<< /Type /Annot /Subtype /Link /Rect [72 690 150 715] /A << /S /Laun#FCch /F (a.exe) >> >>",
        b"<< /Type /Annot /Subtype /Widget /FT " + field_type + b" /T (odd) /Rect [230 200 330 220] /V /V#FCal "
        b"/AA << /K << /S /Java#FCScript /JS (z) >> >> >>",
        b"<< /Type /Annot /Subtype /Widget /FT /Btn /T (box) /Rect [200 200 220 220] /V /Gr#FCn >>",
        b"<< /Type /Annot /Subtype /Link /Rect [72 600 150 620] /A << /S /URI /URI (http://y) >> >>",
        b"<< /Type /Annot /Subtype /Scr#FCeen /Rect [300 300 400 400] /A << /S /Rend#FCition >> >>",
        b"<< /Type /Filesp#FCec /F (a.txt) /EF << /F 13 0 R >> >>",
        _stream(b"hello", b"/Type /EmbeddedFile"),
    ])


class TestSanitizingReadsEveryNameThatIsNotUtf8:
    """An annotation, action or field type the vocabulary does not know is
    not a comment, not a script and not a link: the audit reports what it
    does know and the removal removes exactly that. `str()` of such a type
    raised, and the audit refused the whole document."""

    def test_the_audit_reports_each_category(self, tmp_dir):
        from engine.sanitize import audit_hidden_information

        audit = audit_hidden_information(_sanitize_kitchen(tmp_dir, b"/T#FCx"))
        by_id = {c["id"]: c for c in audit["categories"]}
        assert not any(c.get("unreadable") for c in by_id.values())
        assert by_id["comments"]["detail"] == [
            {"author": "Ann", "contents": "A note", "page": 1, "subtype": "Text"}]
        assert by_id["form_fields"]["detail"] == [
            {"name": "odd", "type": "T#FCx", "value": "/V#FCal"}, {"name": "box", "type": "Btn", "value": "/Gr#FCn"}]
        assert by_id["javascript"]["detail"] == [{"site": "catalog_aa", "where": "document action: WS"}]
        assert by_id["links_and_actions"]["detail"] == [
            {"kind": "laun#fcch", "page": 1, "site": "link", "target": "a.exe"},
            {"kind": "uri", "page": 1, "site": "link", "target": "http://y"}]

    def test_the_removal_removes_what_the_audit_named(self, tmp_dir):
        from engine.sanitize import CATEGORY_IDS, sanitize_pdf

        out = os.path.join(tmp_dir, "clean.pdf")
        result = sanitize_pdf(_sanitize_kitchen(tmp_dir, b"/Tx"), out,
                              categories=[c for c in CATEGORY_IDS if c != "signatures"])
        removed = {c["id"]: c["removed"] for c in result["categories"] if c["removed"]}
        assert removed == {"embedded_files": 1, "comments": 1, "form_fields": 2, "javascript": 1,
                           "links_and_actions": 2}
        with pikepdf.open(out) as pdf:
            left = [bytes(a.get("/Subtype")) for a in pdf.pages[0].obj.Annots]
            catalog = sorted(pdf.Root.keys())
        assert left == [b"/Te\xfcxt", b"/Scr\xfceen"]
        assert catalog == ["/AA", "/OpenAction", "/Pages", "/Type"]


class TestEveryEditReadsPastAKeywordThatIsNotUtf8:
    """Each edit re-walks the stream it rewrites, and spelled each operator
    with `str()`: the damaged keyword failed the edit. The keyword is kept
    where it was, and the edit lands."""

    def _keeps_the_keyword(self, path: str) -> None:
        with pikepdf.open(path) as pdf:
            ops = [bytes(i.operator) for i in pikepdf.parse_content_stream(pdf.pages[0])]
        assert b"\xfc\xfd" in ops

    def test_a_vector_deletes(self, tmp_dir):
        from engine.page_vectors import delete_page_vector, list_page_vectors

        out = os.path.join(tmp_dir, "o.pdf")
        delete_page_vector(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), out, 1, 0)
        assert [100.0, 100.0, 150.0, 150.0] not in [v["rect"] for v in list_page_vectors(out, 1)["vectors"]]
        self._keeps_the_keyword(out)

    def test_a_vector_moves(self, tmp_dir):
        from engine.page_vectors import list_page_vectors, transform_page_vector

        out = os.path.join(tmp_dir, "o.pdf")
        transform_page_vector(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), out, 1, 0, [50, 0, 0, 50, 110, 110])
        assert [110.0, 110.0, 160.0, 160.0] in [v["rect"] for v in list_page_vectors(out, 1)["vectors"]]

    @pytest.mark.parametrize("index", [0, 1], ids=["on-the-page", "inside-the-form"])
    def test_a_vector_restyles(self, tmp_dir, index):
        from engine.page_vectors import list_page_vectors, restyle_page_vector

        out = os.path.join(tmp_dir, "o.pdf")
        restyle_page_vector(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), out, 1, index, fill=[1, 0, 0])
        [vector] = [v for v in list_page_vectors(out, 1)["vectors"] if v["index"] == index]
        assert vector["fill"] == [1.0, 0.0, 0.0]

    def test_an_image_deletes(self, tmp_dir):
        from engine.page_images import delete_page_image, list_page_images

        out = os.path.join(tmp_dir, "o.pdf")
        delete_page_image(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), out, 1, 0)
        assert list_page_images(out, 1)["images"] == []
        self._keeps_the_keyword(out)

    def test_an_image_moves_and_crops(self, tmp_dir):
        from engine.page_images import crop_page_image, list_page_images, transform_page_image

        moved = os.path.join(tmp_dir, "m.pdf")
        transform_page_image(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), moved, 1, 0, [100, 0, 0, 50, 110, 510])
        assert list_page_images(moved, 1)["images"][0]["rect"] == pytest.approx([110, 510, 210, 560], abs=0.01)
        cropped = os.path.join(tmp_dir, "c.pdf")
        crop_page_image(moved, cropped, 1, 0, [0.0, 0.0, 0.5, 1.0])
        assert list_page_images(cropped, 1)["images"][0]["crop"] is not None

    def test_a_run_is_replaced_and_restyled(self, tmp_dir):
        from engine.text_runs import list_text_runs, replace_text_run, restyle_text_run

        src = _doc(tmp_dir, "g.pdf", _GARBAGE_RICH)
        replaced = os.path.join(tmp_dir, "r.pdf")
        replace_text_run(src, replaced, 1, 0, "Other words")
        assert "Other words" in pdfminer_text(replaced)
        restyled = os.path.join(tmp_dir, "s.pdf")
        restyle_text_run(src, restyled, 1, 0, size=14)
        assert list_text_runs(restyled, 1)["runs"][0]["font_size"] == pytest.approx(14)

    def test_a_paragraph_is_replaced(self, tmp_dir):
        from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

        src = _doc(tmp_dir, "g.pdf", _GARBAGE_RICH)
        [first] = [p for p in list_text_paragraphs(src, 1)["paragraphs"] if p["text"] == "Secret words"]
        out = os.path.join(tmp_dir, "p.pdf")
        replace_paragraph_text(src, out, 1, first["index"], "Public words", first["spans"], first["runs"], first["text"])
        text = pdfminer_text(out)
        assert "Public words" in text and "Secret words" not in text

    def test_a_hairline_is_widened(self, tmp_dir):
        from engine.hairlines import fix_hairlines, list_hairlines

        out = os.path.join(tmp_dir, "h.pdf")
        assert fix_hairlines(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), out)["fixed_strokes"] == 1
        assert list_hairlines(out)["count"] == 0

    def test_printer_marks_on_a_page_edited_since_are_replaced(self, tmp_dir):
        from engine.printer_marks import add_printer_marks

        once = add_printer_marks(_doc(tmp_dir, "g.pdf", _GARBAGE_RICH), os.path.join(tmp_dir, "m1.pdf"),
                                 marks=["crop"])["output"]
        edited = os.path.join(tmp_dir, "e.pdf")
        with pikepdf.open(once) as pdf:
            pdf.pages[0].contents_add(b"0 g", prepend=False)
            pdf.save(edited)
        twice = os.path.join(tmp_dir, "m2.pdf")
        add_printer_marks(edited, twice, marks=["crop"])
        with pikepdf.open(twice) as pdf:
            draws = [i for i in pikepdf.parse_content_stream(pdf.pages[0]) if bytes(i.operator) == b"Do"]
        assert sum(1 for i in draws if bytes(i.operands[0]) == b"/SpectraPrinterMarks") == 1


#: A language, an opening action type, two XObject subtypes and an
#: annotation subtype that are names that are not UTF-8.
_CENSUS = [
    b"<< /Type /Catalog /Pages 2 0 R /Lang /d#FCe /OpenAction << /S /Java#FCScript /JS (x) >> "
    b"/StructTreeRoot << /Type /StructTreeRoot >> >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
    + b" >> /XObject << /Im1 5 0 R /Im2 6 0 R /Fm1 7 0 R >> >> /Contents 4 0 R /Annots [8 0 R] >>",
    _stream(b"BT /F1 12 Tf 72 700 Td (Words) Tj ET q 10 0 0 10 100 100 cm /Im1 Do Q "
            b"q 10 0 0 10 200 100 cm /Im2 Do Q q 1 0 0 1 300 300 cm /Fm1 Do Q"),
    _IMAGE_BODY,
    _stream(b"\x00\x80\x80\x00", b"/Type /XObject /Subtype /Ima#FCge /Width 2 /Height 2 /ColorSpace /DeviceGray "
            b"/BitsPerComponent 8"),
    _stream(b"0 0 1 rg 0 0 10 10 re f", b"/Type /XObject /Subtype /Fo#FCrm /BBox [0 0 10 10]"),
    b"<< /Type /Annot /Subtype /Te#FCxt /Rect [0 0 10 10] >>",
]


class TestReportsReadEveryNameThatIsNotUtf8:
    def test_the_standards_census_reads_every_fact(self, tmp_dir):
        from engine.standards_report import census

        facts = census(_doc(tmp_dir, "c.pdf", _CENSUS))
        assert facts.reasons == {}
        assert facts.values == {
            "annotations": {"Te#FCxt": 1}, "attachments": [], "document_scripts": False, "encryption": False,
            "form_fields": 0, "images": 1, "optional_content": False, "outline": False,
            "page_marks": [["image", "text"]], "pages": 1, "standard_identifiers": [],
            "tagged_structure": {"lang": "/d#FCe", "mark_info": False, "struct_tree": True}}

    def test_the_health_check_reads_every_resource(self, tmp_dir):
        from engine.document_health import document_health

        report = document_health(_doc(tmp_dir, "c.pdf", _CENSUS))
        assert report["status"] == "collected"
        assert [f["code"] for f in report["facts"]] == ["font.notEmbedded"]


_RGB_AXIAL = (b"<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Extend [true true] "
              b"/Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >>")

#: Every resource a page selects by name, named with a byte that is not
#: UTF-8, behind a damaged keyword and an XObject of a subtype of such bytes,
#: with a marked-content tag of such bytes and an authored line break the
#: damaged keyword follows.
_EDITOR_NAMES = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F#E9 " + _HELVETICA
    + b" >> /XObject << /Xg 5 0 R /Im#E9 6 0 R /Fm#E9 7 0 R >> /Shading << /Sh#E9 8 0 R >> "
    b"/Pattern << /P#E9 9 0 R >> /ColorSpace << /CS#E9 [/Separation /Spot /DeviceCMYK " + _FN + b"] >> >> "
    b"/Contents 4 0 R >>",
    _stream(b"q \xfc\xfd Q\nq 1 0 0 1 20 20 cm /Xg Do Q\nq /Sh#E9 sh Q\n"
            b"/Sp#E9n << /MCID 0 >> BDC BT /F#E9 12 Tf 100 700 Td (Plain words) Tj ET EMC\n"
            b"BT /F#E9 12 Tf 100 600 Td (Loose words) Tj ET\n"
            b"q 100 0 0 50 100 500 cm /Im#E9 Do Q\nq 1 0 0 1 100 300 cm /Fm#E9 Do Q\n"
            b"/Pattern cs /P#E9 scn 300 300 80 80 re f\n/CS#E9 cs 1 scn 400 100 50 50 re f"),
    _stream(b"0 0 1 rg 0 0 5 5 re f", b"/Type /XObject /Subtype /Fo#FCrm /BBox [0 0 10 10]"),
    _IMAGE_BODY,
    _stream(b"BT /F1 12 Tf 0 10 Td (Form words) Tj ET 0 1 0 rg 0 0 5 5 re f 2 w 0 0 m 50 0 l S",
            b"/Type /XObject /Subtype /Form /BBox [0 0 200 50] /Resources << /Font << /F1 " + _HELVETICA
            + b" >> >>"),
    _RGB_AXIAL,
    _stream(b"0 0 1 rg 0 0 10 10 re f", b"/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] "
            b"/XStep 10 /YStep 10 /Resources << >>"),
]


def _operands_of(path: str, operator: bytes) -> list:
    with pikepdf.open(path) as pdf:
        return [[bytes(o) if isinstance(o, pikepdf.Name) else o for o in i.operands]
                for i in pikepdf.parse_content_stream(pdf.pages[0]) if bytes(i.operator) == operator]


def _resource_keys(path: str, category: str) -> list:
    with pikepdf.open(path) as pdf:
        table = pdf.pages[0].obj.Resources.get(category)
        return sorted(k.encode("utf-8", "surrogateescape") for k in table.keys()) if table is not None else []


class TestEditorsSelectEachResourceByItsBytes:
    """Each editor below reads a resource name, a marked-content tag, an
    XObject subtype or a keyword off the page it rewrites, and writes the
    names it reads back. `str()` of such a name raised and failed the edit,
    and `Name()` of such a spelling refused it."""

    def _run(self, path: str, text: str) -> dict:
        from engine.text_runs import list_text_runs

        return next(r for r in list_text_runs(path, 1)["runs"] if r["text"] == text)

    def test_the_run_lister_reads_every_run(self, tmp_dir):
        from engine.text_runs import list_text_runs

        runs = list_text_runs(_doc(tmp_dir, "e.pdf", _EDITOR_NAMES), 1)["runs"]
        assert sorted((r["text"], r["editable"]) for r in runs) == [
            ("Form words", True), ("Loose words", True), ("Plain words", True)]

    def test_a_restyle_selects_the_font_by_its_bytes(self, tmp_dir):
        from engine.text_runs import restyle_text_run

        src = _doc(tmp_dir, "e.pdf", _EDITOR_NAMES)
        out = os.path.join(tmp_dir, "o.pdf")
        restyle_text_run(src, out, 1, self._run(src, "Plain words")["index"], size=14)
        assert self._run(out, "Plain words")["font_size"] == pytest.approx(14)
        assert [b"/F\xe9", 14] in _operands_of(out, b"Tf")

    def test_a_run_in_another_face_restores_the_font_by_its_bytes(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.text_runs import convert_text_run

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        src = _doc(tmp_dir, "e.pdf", _EDITOR_NAMES)
        out = os.path.join(tmp_dir, "o.pdf")
        convert_text_run(src, out, 1, self._run(src, "Plain words")["index"], "\u03a9mega words",
                         os.path.abspath(FONT_DIR))
        assert "\u03a9mega words" in pdfminer_text(out)
        fonts = [operands[0] for operands in _operands_of(out, b"Tf")]
        assert fonts[0] == fonts[2] == fonts[3] == b"/F\xe9" and len(fonts) == 4
        assert fonts[1] in _resource_keys(out, "/Font") and fonts[1] != b"/F\xe9"

    def test_a_run_inside_a_form_is_replaced(self, tmp_dir):
        from engine.text_runs import replace_text_run

        src = _doc(tmp_dir, "e.pdf", _EDITOR_NAMES)
        out = os.path.join(tmp_dir, "o.pdf")
        replace_text_run(src, out, 1, self._run(src, "Form words")["index"], "Other words")
        assert "Other words" in pdfminer_text(out)

    def _paragraph(self, path: str, text: str) -> dict:
        from engine.text_paragraphs import list_text_paragraphs

        return next(p for p in list_text_paragraphs(path, 1)["paragraphs"] if p["text"] == text)

    def test_a_paragraph_is_rewritten_in_its_own_font(self, tmp_dir):
        from engine.text_paragraphs import replace_paragraph_text

        src = _doc(tmp_dir, "e.pdf", _EDITOR_NAMES)
        para = self._paragraph(src, "Plain words")
        out = os.path.join(tmp_dir, "o.pdf")
        spans = [{"start": 0, "end": len("New words"), "run": para["runs"][0]}]
        replace_paragraph_text(src, out, 1, para["index"], "New words", spans, para["runs"], para["text"])
        assert "New words" in pdfminer_text(out)
        assert b"/F\xe9" in [operands[0] for operands in _operands_of(out, b"Tf")]

    def test_a_paragraph_in_another_face_restores_the_font_by_its_bytes(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.text_paragraphs import replace_paragraph_text

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        src = _doc(tmp_dir, "e.pdf", _EDITOR_NAMES)
        para = self._paragraph(src, "Plain words")
        out = os.path.join(tmp_dir, "o.pdf")
        spans = [{"start": 0, "end": len("\u03a9mega words"), "run": para["runs"][0]}]
        replace_paragraph_text(src, out, 1, para["index"], "\u03a9mega words", spans, para["runs"], para["text"],
                               convert=True, font_path=os.path.abspath(FONT_DIR))
        assert "\u03a9mega words" in pdfminer_text(out)
        assert b"/F\xe9" in [operands[0] for operands in _operands_of(out, b"Tf")]

    def test_the_vector_lister_reads_every_path_and_a_delete_keeps_the_drawn_shading(self, tmp_dir):
        from engine.page_vectors import delete_page_vector, list_page_vectors

        src = _doc(tmp_dir, "e.pdf", _EDITOR_NAMES)
        vectors = list_page_vectors(src, 1)["vectors"]
        spot = next(v["index"] for v in vectors if v["rect"] == [400.0, 100.0, 450.0, 150.0])
        out = os.path.join(tmp_dir, "o.pdf")
        delete_page_vector(src, out, 1, spot)
        assert _resource_keys(out, "/Shading") == [b"/Sh\xe9"]
        assert [400.0, 100.0, 450.0, 150.0] not in [v["rect"] for v in list_page_vectors(out, 1)["vectors"]]

    def test_an_image_is_deleted_past_an_xobject_of_an_unknown_subtype(self, tmp_dir):
        from engine.page_images import delete_page_image, list_page_images

        src = _doc(tmp_dir, "e.pdf", _EDITOR_NAMES)
        images = list_page_images(src, 1)["images"]
        assert [i["rect"] for i in images] == [pytest.approx([100, 500, 200, 550], abs=0.01)]
        out = os.path.join(tmp_dir, "o.pdf")
        delete_page_image(src, out, 1, 0)
        assert list_page_images(out, 1)["images"] == []
        assert [b"/Im\xe9"] not in _operands_of(out, b"Do")

    def test_an_image_is_extracted(self, tmp_dir):
        from engine.page_images import extract_page_image

        result = extract_page_image(_doc(tmp_dir, "e.pdf", _EDITOR_NAMES), 1, 0, os.path.join(tmp_dir, "x"))
        assert (result["width"], result["height"]) == (2, 2)
        assert os.path.getsize(result["output"]) > 0

    def test_the_image_becomes_a_figure(self, tmp_dir):
        from engine.autotag import autotag
        from engine.struct_tree import get_struct_tree

        out = os.path.join(tmp_dir, "t.pdf")
        autotag(_doc(tmp_dir, "e.pdf", _EDITOR_NAMES), out)
        roles = []

        def walk(nodes):
            for node in nodes:
                roles.append(node.get("type"))
                walk(node.get("children") or [])

        walk(get_struct_tree(out)["root"])
        assert "Figure" in roles

    def test_a_run_is_tagged(self, tmp_dir):
        from engine.tag_content import tag_page_content

        src = _doc(tmp_dir, "e.pdf", [b"<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> "
                                      b"/StructTreeRoot << /Type /StructTreeRoot /K [] >> >>"] + _EDITOR_NAMES[1:])
        out = os.path.join(tmp_dir, "t.pdf")
        result = tag_page_content(src, out, 1, targets=[{"run": self._run(src, "Loose words")["index"]}])
        assert [entry["role"] for entry in result["tagged"]] == ["P"]

    def test_the_inspector_reads_the_pattern_the_shading_and_the_image(self, tmp_dir, gs_path):
        from engine.object_inspector import inspect_point
        from engine.separations import render_separations

        src = _doc(tmp_dir, "e.pdf", _EDITOR_NAMES)
        plates = render_separations(src, 1, dpi=36, gs_path=gs_path, reuse=False)

        def at(x, y):
            return inspect_point(src, 1, x, y, plates=plates["plates"], plates_dir=plates["dir"],
                                 gs_path=gs_path)["objects"][0]

        assert at(340, 340)["colour"]["pattern_type"] == 1
        assert at(150, 525)["kind"] == "image"
        assert at(560, 20)["colour"]["family"] == "DeviceRGB"

    def test_stroke_outlines_replace_the_form_by_its_bytes(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.outlines import outline_page

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        src = _doc(tmp_dir, "e.pdf", _EDITOR_NAMES)
        out = os.path.join(tmp_dir, "o.pdf")
        with pikepdf.open(src) as pdf:
            report = outline_page(pdf, pdf.pages[0], 1, os.path.abspath(FONT_DIR), False, True)
            pdf.save(out)
        assert report["strokes"] == 1
        assert _resource_keys(out, "/XObject") == [b"/Im\xe9", b"/OlFm0", b"/Xg"]

    def test_the_census_reads_the_image_drawn_through_the_name(self, tmp_dir):
        from engine.standards_report import census

        facts = census(_doc(tmp_dir, "e.pdf", _EDITOR_NAMES))
        assert facts.values["page_marks"] == [["image", "text", "vector"]]


class TestReadersReportTheLabelOfANameThatIsNotUtf8:
    """Each reader below spelled a name with `str()`, and a name that is not
    UTF-8 either failed the read, dropped the value, or was reported as a
    different fact. The reader reports the name's label, the same as it
    reports any name it does not know."""

    def test_a_layer_named_by_such_a_name_lists_that_name(self, tmp_dir):
        from engine.layers import list_layers

        src = _page_doc(tmp_dir, "l.pdf", catalog=b"/OCProperties << /OCGs [5 0 R 6 0 R] /D << /Order [5 0 R 6 0 R] >> >>",
                        extra=(b"<< /Type /OCG /Name /La#FCyer >>", b"<< /Type /OCG /Name /Plain >>"))
        assert [layer["name"] for layer in list_layers(src)["layers"]] == ["/La#FCyer", "/Plain"]

    def test_an_overprint_paint_names_the_family_its_space_names(self, tmp_dir):
        from engine.overprint import list_overprint

        src = _doc(tmp_dir, "o.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /ColorSpace << /CS0 /Gar#FC "
            b"/CS1 /Foo >> /ExtGState << /G << /OP true /op true /OPM 1 >> >> >> /Contents 4 0 R >>",
            _stream(b"/G gs /CS0 cs 0 scn 100 100 50 50 re f /CS1 cs 0 scn 200 100 50 50 re f"),
        ])
        paints = list_overprint(src)["paints"]
        assert [(p["family"], p["components"]) for p in paints] == [("Gar#FC", [0.0]), ("Foo", [0.0])]

    def test_a_field_action_names_its_type(self, tmp_dir):
        from engine.forms import read_form_fields

        src = _page_doc(tmp_dir, "f.pdf", catalog=b"/AcroForm << /Fields [5 0 R] >>", page=b"/Annots [5 0 R]",
                        extra=(b"<< /Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (go) /Rect [72 300 172 320] "
                               b"/A << /S /Gar#FC >> >>",))
        [field] = read_form_fields(src)["fields"]
        assert field["field_actions"] == {"A": {"kind": "other", "action": "Gar#FC"}}

    def test_a_font_of_such_a_subtype_reads_as_not_embedded(self, tmp_dir):
        from engine.font_inventory import list_document_fonts
        from engine.preflight import preflight

        src = _doc(tmp_dir, "f.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"BT /F1 12 Tf 72 700 Td (A) Tj ET"),
            b"<< /Type /Font /Subtype /Type#FC1 /BaseFont /Courier >>",
        ])
        assert [(f["name"], f["embedded"]) for f in list_document_fonts(src)["fonts"]] == [("Courier", False)]
        [embedding] = [c for c in preflight(src)["checks"] if c["id"] == "fonts_embedded"]
        assert embedding["status"] == "fail"
        assert [f["detail_key"] for f in embedding["findings"]] == ["font_not_embedded"]

    def test_the_transparency_list_skips_an_xobject_of_such_a_subtype(self, tmp_dir):
        from engine.flattener import list_transparency

        src = _doc(tmp_dir, "t.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Xg 5 0 R >> "
            b"/ExtGState << /G << /ca 0.5 >> >> >> /Contents 4 0 R >>",
            _stream(b"q /G gs 0 0 1 rg 100 100 50 50 re f Q q 1 0 0 1 120 120 cm /Xg Do Q"),
            _stream(b"0 0 1 rg 0 0 5 5 re f", b"/Type /XObject /Subtype /Fo#FCrm /BBox [0 0 10 10]"),
        ])
        [page] = list_transparency(src)["pages"]
        assert [(o["kind"], o["unknown"]) for o in page["objects"]] == [("fill", False)]
        assert page["counts"]["unknown"] == 0 and page["unknown"] == []

    def test_the_xfdf_export_reads_every_annotation(self, tmp_dir):
        from engine.xfdf import export_xfdf

        src = _page_doc(tmp_dir, "x.pdf", page=b"/Annots [5 0 R 6 0 R]", extra=(
            b"<< /Type /Annot /Subtype /Te#FCxt /Rect [0 0 10 10] /Contents (odd) >>",
            b"<< /Type /Annot /Subtype /Polygon /Rect [20 20 60 60] /Contents (poly) "
            b"/Vertices [20 20 60 20 40 60] /BE << /S /C#FC /I 1 >> >>"))
        out = os.path.join(tmp_dir, "x.xfdf")
        result = export_xfdf(src, out)
        assert (result["found"], result["by_type"], result["skipped"]) == (1, {"polygon": 1}, [])
        with open(out, encoding="utf-8") as fh:
            text = fh.read()
        assert "<vertices>20,20;60,20;40,60</vertices>" in text and "cloudy" not in text

    def test_document_javascript_behind_an_action_of_such_a_type_is_found(self, tmp_dir):
        from engine.preflight import preflight

        src = _page_doc(tmp_dir, "j.pdf", page=b"/Annots [5 0 R]", extra=(
            b"<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << /S /Gar#FC >> "
            b"/AA << /E << /S /JavaScript /JS (app.alert(1)) >> >> >>",))
        [check] = [c for c in preflight(src, profile="pdfx_1a")["checks"] if c["id"] == "document_javascript"]
        assert check["status"] == "fail"
        assert [f["values"]["name"] for f in check["findings"]] == ["page 1 E"]


class TestEditsProceedOrRefuseByTheLabelOfANameThatIsNotUtf8:
    """Each edit below read a name with `str()` on its way, and a name that
    is not UTF-8 failed it with a codec error. The edit now proceeds, or
    refuses with its own reason naming the label."""

    def test_the_opening_view_refuses_by_its_own_reason(self, tmp_dir):
        from engine.doc_properties import set_initial_view

        src = _page_doc(tmp_dir, "v.pdf", catalog=b"/OpenAction [3 0 R /Fi#FCt]")
        with pytest.raises(ValueError, match="opening action cannot be changed without losing behavior"):
            set_initial_view(src, os.path.join(tmp_dir, "o.pdf"), open_page=1)

    def test_a_cid_font_refuses_by_its_encoding_label(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.font_embed import embed_missing_fonts

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        src = _doc(tmp_dir, "c.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F3 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"BT /F3 12 Tf 72 700 Td <0041> Tj ET"),
            b"<< /Type /Font /Subtype /Type0 /BaseFont /LiberationSans /Encoding /Iden#FCtity-H "
            b"/DescendantFonts [6 0 R] >>",
            b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LiberationSans /CIDSystemInfo << /Registry (Adobe) "
            b"/Ordering (Identity) /Supplement 0 >> /FontDescriptor << /Type /FontDescriptor "
            b"/FontName /LiberationSans /Flags 32 >> >>",
        ])
        with pytest.raises(ValueError, match="addressed through the Iden#FCtity-H character map"):
            embed_missing_fonts(src, os.path.join(tmp_dir, "o.pdf"), sources=("bundled",),
                                font_dir=os.path.abspath(FONT_DIR))

    def test_a_font_of_such_a_subtype_whose_state_will_not_read_is_left_alone(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.font_embed import embed_missing_fonts

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        src = _doc(tmp_dir, "c.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"BT /F1 12 Tf 72 700 Td (A) Tj /F2 12 Tf (B) Tj ET"),
            b"<< /Type /Font /Subtype /Type#FC1 /BaseFont /Courier /FontDescriptor 5 >>",
            b"<< /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /FirstChar 32 /LastChar 126 "
            b"/Encoding /WinAnsiEncoding /FontDescriptor << /Type /FontDescriptor /FontName /LiberationSans "
            b"/Flags 32 >> >>",
        ])
        with pytest.raises(ValueError, match="^LiberationSans: the document declares no advances"):
            embed_missing_fonts(src, os.path.join(tmp_dir, "o.pdf"), sources=("bundled",),
                                font_dir=os.path.abspath(FONT_DIR))

    def test_text_outlines_refuse_by_the_encoding_label(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.glyph_outlines import OutlineRefusal
        from engine.outlines import outline_page

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        with open(os.path.join(FONT_DIR, "LiberationSans-Regular.ttf"), "rb") as fh:
            program = fh.read()
        src = _doc(tmp_dir, "t.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F3 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"BT /F3 24 Tf 72 700 Td <00240025> Tj ET"),
            b"<< /Type /Font /Subtype /Type0 /BaseFont /LiberationSans /Encoding /Iden#FCtity-V "
            b"/DescendantFonts [6 0 R] >>",
            b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LiberationSans /CIDSystemInfo << /Registry (Adobe) "
            b"/Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /CIDToGIDMap /Identity >>",
            b"<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 "
            b"/Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>",
            b"<< /Length %d /Length1 %d >> stream\n" % (len(program), len(program)) + program + b"\nendstream",
        ])
        with pikepdf.open(src) as pdf, pytest.raises(OutlineRefusal, match="through the encoding Iden#FCtity-V,"):
            outline_page(pdf, pdf.pages[0], 1, os.path.abspath(FONT_DIR), True, False)

    def test_a_watermark_page_draws_an_annotation_of_such_a_subtype(self, tmp_dir):
        from engine.watermark import watermark

        source = _page_doc(tmp_dir, "s.pdf", page=b"/Annots [5 0 R]", content=b"0 0 1 rg 10 10 50 50 re f", extra=(
            b"<< /Type /Annot /Subtype /Sta#FCmp /Rect [100 100 200 120] /AP << /N 6 0 R >> >>",
            _stream(b"BT /F1 12 Tf 0 2 Td (Stamp words) Tj ET",
                    b"/Type /XObject /Subtype /Form /BBox [0 0 100 20] /Resources << /Font << /F1 "
                    + _HELVETICA + b" >> >>")))
        out = os.path.join(tmp_dir, "w.pdf")
        watermark(_page_doc(tmp_dir, "d.pdf"), out, pdf_source=source)
        assert "Stamp words" in pdfminer_text(out)

    def test_removing_comments_takes_a_popup_of_such_a_subtype(self, tmp_dir):
        from engine.annotations import delete_all_annotations

        src = _page_doc(tmp_dir, "a.pdf", page=b"/Annots [5 0 R 6 0 R 7 0 R]", extra=(
            b"<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (A note) /Popup 6 0 R >>",
            b"<< /Type /Annot /Subtype /Po#FCpup /Rect [40 10 140 60] /Parent 5 0 R >>",
            b"<< /Type /Annot /Subtype /Te#FCxt /Rect [10 40 30 60] /Contents (odd) >>"))
        out = os.path.join(tmp_dir, "o.pdf")
        delete_all_annotations(src, out)
        with pikepdf.open(out) as pdf:
            assert [bytes(a.get("/Subtype")) for a in pdf.pages[0].obj.Annots] == [b"/Te\xfcxt"]

    def test_a_vertical_field_beside_a_font_of_such_an_encoding(self, tmp_dir):
        from outline_builders import FONT_DIR

        from engine.form_authoring import add_form_fields

        if not os.path.isfile(os.path.join(FONT_DIR, "NotoSansCJKsc-Regular.otf")):
            pytest.skip("bundled CJK face not provisioned")
        src = _page_doc(tmp_dir, "v.pdf", catalog=b"/AcroForm << /Fields [] /DR << /Font << /VJapan1 << /Type /Font "
                        b"/Subtype /Type0 /BaseFont /Other /Encoding /Uni#FCJIS >> >> >> >>")
        out = os.path.join(tmp_dir, "o.pdf")
        add_form_fields(src, out, [{"name": "note", "type": "text", "page_index": 0, "rect": [400, 400, 460, 700],
                                    "writing_mode": "vertical", "script": "japanese"}],
                        font_dir=os.path.abspath(FONT_DIR))
        with pikepdf.open(out) as pdf:
            fonts = pdf.Root.AcroForm.DR.Font
            assert sorted(fonts.keys()) == ["/Helv", "/VJapan1", "/VJapan12"]
            assert bytes(fonts["/VJapan1"].Encoding) == b"/Uni\xfcJIS"
            assert str(fonts["/VJapan12"].Encoding) == "/UniJIS-UTF16-V"

    def test_a_scan_whose_filter_chain_ends_in_such_a_name_is_left_as_it_is(self, tmp_dir, gs_path):
        import zlib

        from engine.enhance_scan import enhance_scan

        pixels = zlib.compress(bytes([200]) * (64 * 64))
        src = _doc(tmp_dir, "s.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"q 612 0 0 792 0 0 cm /Im1 Do Q"),
            _stream(pixels, b"/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray "
                    b"/BitsPerComponent 8 /Filter [/FlateDecode /Gar#FC]"),
        ])
        result = enhance_scan(src, os.path.join(tmp_dir, "o.pdf"), deskew=False, despeckle=False,
                              orientation=False, gs_path=gs_path)
        assert (result["pages_unchanged"], result["pages_enhanced"]) == (1, 0)


class TestMergesCopyEachNameByItsBytes:
    """A merge validates and copies the layer configuration and the extension
    declarations of every source. Each name that is not UTF-8 in them failed
    the merge through `str()`, `Name()` or a dictionary built from `keys()`
    spellings, and each one is now copied byte for byte."""

    def test_two_levels_of_one_declaration_compose_past_a_key_of_such_bytes(self, tmp_dir):
        from engine.merge import merge

        first = _page_doc(tmp_dir, "a.pdf", b"/Extensions << /SPEC << /BaseVersion /1.7 /ExtensionLevel 3 "
                                            b"/X#FC /Y#FC >> >>")
        second = _page_doc(tmp_dir, "b.pdf", b"/Extensions << /SPEC << /BaseVersion /1.7 /ExtensionLevel 5 "
                                             b"/X#FC /Y#FC >> >>")
        out = os.path.join(tmp_dir, "m.pdf")
        merge([first, second], out)
        with pikepdf.open(out) as pdf:
            carried = pdf.Root.Extensions.SPEC.unparse(resolved=True)
        assert carried == b"<< /BaseVersion /1.7 /ExtensionLevel 5 /X#fc /Y#fc >>"

    def test_a_layer_configuration_copies_every_name_of_such_bytes(self, tmp_dir):
        from engine.merge import merge

        first = _layered(tmp_dir, "a.pdf", b"/View")
        second = _doc(tmp_dir, "b.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R] /D << /Order [5 0 R] /ON [5 0 R] "
            b"/Y#FC << /K#FC /V#FC /Type /T#FC /S /S#FC >> >> >> >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
            + b" >> /Properties << /MC0 5 0 R >> >> /Contents 4 0 R >>",
            _stream(b"/OC /MC0 BDC BT /F1 12 Tf 72 700 Td (Layer words) Tj ET EMC"),
            b"<< /Type /OCG /Name (Layer) /Intent /De#FCsign >>",
        ])
        out = os.path.join(tmp_dir, "m.pdf")
        assert merge([second, first], out)["pages"] == 2
        with pikepdf.open(out) as pdf:
            properties = pdf.Root.OCProperties
            assert bytes(properties.OCGs[0].Intent) == b"/De\xfcsign"
            extra = properties.D[pikepdf.Object.parse(b"/Y#FC")]
            assert extra.unparse(resolved=True) == b"<< /K#fc /V#fc /S /S#fc /Type /T#fc >>"


class TestEditsReadPastKeywordsBesideTheirOwnInstructions:
    """A damaged keyword directly beside an instruction an edit inspects: the
    operator after a shading, the operator before a path's colour, the one
    after its paint, the one after an authored line break, and the ones
    around the mark draw the printer-mark add wrote."""

    _PATHS = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Shading << /Sh1 5 0 R >> >> "
        b"/Contents 4 0 R >>",
        _stream(b"q 0 0 1 rg 100 100 50 50 re f \xfc\xfd Q\n\xfc\xfd 1 0 0 rg 300 100 50 50 re f\n"
                b"q /Sh1 sh \xfc\xfd Q"),
        _RGB_AXIAL,
    ]

    def test_the_vector_lister_reads_a_keyword_after_a_shading(self, tmp_dir):
        from engine.page_vectors import list_page_vectors

        vectors = list_page_vectors(_doc(tmp_dir, "p.pdf", self._PATHS), 1)["vectors"]
        assert sorted(v["rect"] for v in vectors)[1:] == [[100.0, 100.0, 150.0, 150.0], [300.0, 100.0, 350.0, 150.0]]

    @pytest.mark.parametrize("rect", [[100.0, 100.0, 150.0, 150.0], [300.0, 100.0, 350.0, 150.0]],
                             ids=["keyword-after-the-paint", "keyword-before-the-colour"])
    def test_a_restyle_reads_the_keyword_beside_the_path(self, tmp_dir, rect):
        from engine.page_vectors import list_page_vectors, restyle_page_vector

        src = _doc(tmp_dir, "p.pdf", self._PATHS)
        index = next(v["index"] for v in list_page_vectors(src, 1)["vectors"] if v["rect"] == rect)
        out = os.path.join(tmp_dir, "o.pdf")
        restyle_page_vector(src, out, 1, index, fill=[0, 1, 0])
        [vector] = [v for v in list_page_vectors(out, 1)["vectors"] if v["rect"] == rect]
        assert vector["fill"] == [0.0, 1.0, 0.0]

    def test_a_paragraph_before_an_authored_break_and_a_keyword_is_replaced(self, tmp_dir):
        from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

        src = _page_doc(tmp_dir, "b.pdf", content=b"BT /F1 12 Tf 72 700 Td (First line) Tj ET "
                        b"/Span << /ActualText (\\n) >> BDC \xfc\xfd EMC BT /F1 12 Tf 72 686 Td (Second line) Tj ET")
        [para] = list_text_paragraphs(src, 1)["paragraphs"]
        out = os.path.join(tmp_dir, "o.pdf")
        spans = [{"start": 0, "end": len("New words"), "run": para["runs"][0]}]
        replace_paragraph_text(src, out, 1, para["index"], "New words", spans, para["runs"], para["text"])
        assert "New words" in pdfminer_text(out)
        with pikepdf.open(out) as pdf:
            assert b"\xfc\xfd" in [bytes(i.operator) for i in pikepdf.parse_content_stream(pdf.pages[0])]

    def test_an_image_inside_a_form_is_deleted_past_a_keyword_on_the_page(self, tmp_dir):
        from engine.page_images import delete_page_image, list_page_images

        src = _doc(tmp_dir, "n.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Fm1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"q \xfc\xfd Q q 1 0 0 1 100 300 cm /Fm1 Do Q"),
            _stream(b"q 50 0 0 25 0 0 cm /Im1 Do Q", b"/Type /XObject /Subtype /Form /BBox [0 0 100 50] "
                    b"/Resources << /XObject << /Im1 6 0 R >> >>"),
            _IMAGE_BODY,
        ])
        [image] = list_page_images(src, 1)["images"]
        out = os.path.join(tmp_dir, "o.pdf")
        delete_page_image(src, out, 1, image["index"])
        assert list_page_images(out, 1)["images"] == []

    def test_printer_marks_are_replaced_around_keywords_and_names_of_such_bytes(self, tmp_dir):
        from engine.printer_marks import add_printer_marks

        once = add_printer_marks(_doc(tmp_dir, "e.pdf", _EDITOR_NAMES), os.path.join(tmp_dir, "m1.pdf"),
                                 marks=["crop"])["output"]
        edited = os.path.join(tmp_dir, "x.pdf")
        with pikepdf.open(once) as pdf:
            data = pikepdf.unparse_content_stream(pikepdf.parse_content_stream(pdf.pages[0]))
            assert data.count(b"/SpectraPrinterMarks Do") == 1
            pdf.pages[0].obj.Contents = pdf.make_stream(
                data.replace(b"/SpectraPrinterMarks Do", b"\xfc\xfd /SpectraPrinterMarks Do \xfc\xfd"))
            pdf.save(edited)
        twice = os.path.join(tmp_dir, "m2.pdf")
        add_printer_marks(edited, twice, marks=["crop"])
        draws = [operands[0] for operands in _operands_of(twice, b"Do")]
        assert draws.count(b"/SpectraPrinterMarks") == 1
        assert b"/Im\xe9" in draws


#: Hidden text under an OFF group, a second OFF group whose /Type is a name
#: that is not UTF-8, a form of such a name holding hidden text, and a damaged
#: keyword both on the page and inside a hidden sequence.
_HIDDEN_KITCHEN = [
    b"<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /Order [5 0 R 6 0 R] "
    b"/OFF [5 0 R 6 0 R] >> >> >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
    + b" >> /Properties << /MC0 5 0 R /MC1 6 0 R >> /XObject << /Fm#E9 7 0 R >> >> /Contents 4 0 R >>",
    _stream(b"q \xfc\xfd Q BT /F1 12 Tf 72 700 Td (Shown words) Tj ET "
            b"/OC /MC0 BDC q \xfc\xfd Q BT /F1 12 Tf 72 650 Td (Hidden words) Tj ET EMC "
            b"/OC /MC1 BDC BT /F1 12 Tf 72 600 Td (Odd hidden) Tj ET EMC "
            b"q 1 0 0 1 72 400 cm /Fm#E9 Do Q"),
    b"<< /Type /OCG /Name (Layer) >>",
    b"<< /Type /OC#FCG /Name (Odd) >>",
    _stream(b"BT /F1 12 Tf 0 30 Td (Form shown) Tj ET /OC /MC0 BDC BT /F1 12 Tf 0 10 Td (Form hidden) Tj ET EMC",
            b"/Type /XObject /Subtype /Form /BBox [0 0 200 50] /Resources << /Font << /F1 " + _HELVETICA
            + b" >> /Properties << /MC0 5 0 R >> >>"),
]


class TestHiddenContentPastNamesAndKeywordsThatAreNotUtf8:
    """The hidden-content analysis walks every operator, every form a page
    draws and every group a sequence selects. A form or a group type named
    with bytes that are not UTF-8, or a damaged keyword, failed the audit and
    the removal through `str()`."""

    def test_the_audit_names_every_hidden_run(self, tmp_dir):
        from engine.sanitize import audit_hidden_information

        audit = audit_hidden_information(_doc(tmp_dir, "h.pdf", _HIDDEN_KITCHEN))
        [hidden] = [c for c in audit["categories"] if c["id"] == "hidden_text"]
        assert sorted(d["text"] for d in hidden["detail"]) == ["Form hidden", "Hidden words", "Odd hidden"]

    def test_the_removal_removes_every_hidden_run(self, tmp_dir):
        from engine.sanitize import sanitize_pdf

        out = os.path.join(tmp_dir, "s.pdf")
        sanitize_pdf(_doc(tmp_dir, "h.pdf", _HIDDEN_KITCHEN), out, categories=["hidden_text"])
        text = pdfminer_text(out)
        assert "Shown words" in text and "Form shown" in text
        assert not any(t in text for t in ("Hidden words", "Odd hidden", "Form hidden"))


class TestNamesThatAreNotUtf8BesideTheOnesAnEditWrites:
    def test_a_header_scope_is_set_beside_an_attribute_owner_of_such_bytes(self, tmp_dir):
        from engine.struct_tree import set_struct_props

        src = _doc(tmp_dir, "t.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 5 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
            _stream(b""),
            b"<< /Type /StructTreeRoot /K 6 0 R >>",
            b"<< /Type /StructElem /S /Table /P 5 0 R /K 7 0 R >>",
            b"<< /Type /StructElem /S /TR /P 6 0 R /K 8 0 R >>",
            b"<< /Type /StructElem /S /TH /P 7 0 R /A << /O /La#FCyout /Placement /Block >> /K [] >>",
        ])
        out = os.path.join(tmp_dir, "o.pdf")
        set_struct_props(src, out, [0, 0, 0], {"scope": "Column"})
        with pikepdf.open(out) as pdf:
            header = pdf.Root.StructTreeRoot.K.K.K
            owners = sorted(bytes(a.O) for a in header.A)
            scope = next(a for a in header.A if a.O == pikepdf.Name.Table).Scope
        assert (owners, scope) == ([b"/La\xfcyout", b"/Table"], pikepdf.Name.Column)

    def test_a_trap_setting_stored_as_a_name_lists_as_that_name(self, tmp_dir):
        from engine.trapping import list_trap_presets

        src = _page_doc(tmp_dir, "t.pdf", catalog=b"/SpectraTrapPresets [<< /First 1 /Last 1 /Name (P) "
                        b"/Params << /HalftoneName /Gar#FC /ImageTrapPlacement /Choke >> >>]")
        [assignment] = list_trap_presets(src)["assignments"]
        preset = assignment["preset"]
        assert (preset["HalftoneName"], preset["ImageTrapPlacement"]) == ("/Gar#FC", "/Choke")

    def test_a_redaction_cuts_a_type3_font_past_a_keyword_in_a_procedure_it_keeps(self, tmp_dir):
        from engine.redact import redact

        src = _doc(tmp_dir, "t3.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F3 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"BT /F3 12 Tf 10 50 Td (A) Tj ET BT /F3 12 Tf 200 50 Td (B) Tj ET"),
            b"<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] "
            b"/CharProcs << /a 6 0 R /b 7 0 R >> /Encoding << /Type /Encoding /Differences [65 /a /b] >> "
            b"/FirstChar 65 /LastChar 66 /Widths [600 600] /Resources << /ExtGState << /G1 << /ca 1 >> "
            b"/G2 << /ca 1 >> >> >> >>",
            _stream(b"600 0 d0 \xfc\xfd /G1 gs 0 0 500 500 re f"),
            _stream(b"600 0 d0 /G2 gs 0 0 500 500 re f"),
        ])
        out = os.path.join(tmp_dir, "out.pdf")
        redact(src, out, [{"page": 1, "rect": [195, 40, 300, 70]}])
        with pikepdf.open(out) as pdf:
            font = pdf.pages[0].Resources.Font.F3
            assert sorted(font.CharProcs.keys()) == ["/a"]
            assert sorted(font.Resources.ExtGState.keys()) == ["/G1"]


_XFA_STATE_TEMPLATE = (b'<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="topmostSubform">'
                       b'<subform name="Page1"><field name="box"/><exclGroup name="choice"/></subform></subform>'
                       b'</template>')
_XFA_BOX = "topmostSubform[0].Page1[0].box[0]"
_XFA_CHOICE = "topmostSubform[0].Page1[0].choice[0]"


def _xfa_states(tmp_dir: str, data: bytes) -> str:
    """A static XFA form whose check box turns on as `/Gr#FCn` and whose radio
    group's options are `/Ja#FC` and `/Nein`, with `data` as the Page1 node's
    content in the datasets packet."""
    datasets = (b'<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><topmostSubform>'
                b'<Page1>' + data + b'</Page1></topmostSubform></xfa:data></xfa:datasets>')
    return _doc(tmp_dir, "xfa.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R] /DA (/Helv 0 Tf 0 g) "
        b"/DR << /Font << /Helv " + _HELVETICA + b" >> >> /XFA [(template) 9 0 R (datasets) 10 0 R] >> >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Annots [5 0 R 7 0 R 8 0 R] >>",
        _stream(b"BT ET"),
        b"<< /Type /Annot /Subtype /Widget /FT /Btn /T (" + _XFA_BOX.encode() + b") /Rect [20 20 40 40] /F 4 "
        b"/P 3 0 R /AS /Off /AP << /N << /Gr#FCn 11 0 R /Off 12 0 R >> >> >>",
        b"<< /FT /Btn /Ff 49152 /T (" + _XFA_CHOICE.encode() + b") /Kids [7 0 R 8 0 R] >>",
        b"<< /Type /Annot /Subtype /Widget /Parent 6 0 R /Rect [60 20 80 40] /F 4 /P 3 0 R /AS /Off "
        b"/AP << /N << /Ja#FC 11 0 R /Off 12 0 R >> >> >>",
        b"<< /Type /Annot /Subtype /Widget /Parent 6 0 R /Rect [100 20 120 40] /F 4 /P 3 0 R /AS /Off "
        b"/AP << /N << /Nein 11 0 R /Off 12 0 R >> >> >>",
        _stream(_XFA_STATE_TEMPLATE),
        _stream(datasets),
        _ON_FACE,
        _OFF_FACE,
    ])


class TestXfaDataNamesEachStateByItsLabel:
    """A static XFA form keeps each value twice: as the field's state name and
    as text in the datasets packet. A state name that is not UTF-8 is
    written to the packet as its label, and a label read from the packet
    selects that state; compared with the `keys()` spelling it matched
    nothing, and written as that spelling it put a lone surrogate into the
    packet."""

    def test_the_datasets_select_each_state_by_its_label(self, tmp_dir):
        from engine.forms import read_form_fields

        src = _xfa_states(tmp_dir, b"<box>Gr#FCn</box><choice>Ja#FC</choice>")
        fields = {f["name"]: f for f in read_form_fields(src)["fields"]}
        assert (fields[_XFA_BOX]["value"], fields[_XFA_BOX].get("value_from_xfa")) == (True, True)
        assert (fields[_XFA_CHOICE]["value"], fields[_XFA_CHOICE].get("value_from_xfa")) == ("Ja#FC", True)

    def test_a_fill_writes_each_state_label_into_the_datasets(self, tmp_dir):
        from engine import xfa
        from engine.forms import fill_form_fields
        from engine.xfa_datasets import DatasetsPacket

        out = os.path.join(tmp_dir, "o.pdf")
        fill_form_fields(_xfa_states(tmp_dir, b"<box/><choice/>"), out, {_XFA_BOX: True, _XFA_CHOICE: "Ja#FC"})
        with pikepdf.open(out) as pdf:
            packet = DatasetsPacket(xfa.datasets_stream(pdf).read_bytes())
            widgets = [bytes(a.AS) for a in pdf.pages[0].obj.Annots]
        assert (packet.get(_XFA_BOX), packet.get(_XFA_CHOICE)) == ("Gr#FCn", "Ja#FC")
        assert widgets == [b"/Gr\xfcn", b"/Ja\xfc", b"/Off"]

    def test_a_fill_that_unchecks_the_box_writes_the_empty_text(self, tmp_dir):
        from engine import xfa
        from engine.forms import fill_form_fields
        from engine.xfa_datasets import DatasetsPacket

        out = os.path.join(tmp_dir, "o.pdf")
        fill_form_fields(_xfa_states(tmp_dir, b"<box>Gr#FCn</box><choice/>"), out, {_XFA_BOX: False})
        with pikepdf.open(out) as pdf:
            packet = DatasetsPacket(xfa.datasets_stream(pdf).read_bytes())
        assert packet.get(_XFA_BOX) in ("", None)


class TestAFillAfterSigningKeepsAKeyOfSuchBytes:
    def test_the_revision_carries_a_widget_key_that_is_not_utf8(self, tmp_dir):
        from test_pades import _build_pki

        from engine.incremental import transplant_incremental
        from engine.signatures import sign_pdf, verify_signatures

        pki = _build_pki(tmp_dir)
        source = _pyhanko_names_pdf(tmp_dir)
        with pikepdf.open(source, allow_overwriting_input=True) as pdf:
            widget = next(a for a in pdf.pages[0].obj.Annots if a.get("/FT") == pikepdf.Name.Btn)
            widget[pikepdf.Object.parse(b"/X#FC")] = pikepdf.String("kept")
            pdf.save(source)
        signed = os.path.join(tmp_dir, "signed.pdf")
        sign_pdf(source, signed, pfx_path=pki["pfx"], password="pw")
        modified = os.path.join(tmp_dir, "modified.pdf")
        with pikepdf.open(signed) as pdf:
            widget = next(a for a in pdf.pages[0].obj.Annots if a.get("/FT") == pikepdf.Name.Btn)
            state = pikepdf.Object.parse(b"/Stra#DFe")
            widget["/V"] = state
            widget["/AS"] = state
            pdf.save(modified)
        out = os.path.join(tmp_dir, "appended.pdf")
        result = transplant_incremental(signed, modified, out)
        assert result["applied"] is True, result
        with pikepdf.open(out) as pdf:
            widget = next(a for a in pdf.pages[0].obj.Annots if a.get("/FT") == pikepdf.Name.Btn)
            assert str(widget[pikepdf.Object.parse(b"/X#FC")]) == "kept"
        [signature] = verify_signatures(out)["signatures"]
        assert (signature["intact"], signature["modification_level"]) == (True, "FORM_FILLING")


#: Text slots that hold names that are not UTF-8: a field's partial name, a
#: text field's value, a combo box's value, a list box's selection, a list
#: box's single value, a lock's field list, a remote action's file
#: specification, and a field whose default appearance is a name.
_TEXT_SLOTS = [
    b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 11 0 R] "
    b"/DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv " + _HELVETICA + b" >> >> >> >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
    b"/Annots [5 0 R 6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 11 0 R] >>",
    _stream(b"BT /Helv 12 Tf 72 700 Td (Form) Tj ET"),
    b"<< /Type /Annot /Subtype /Widget /FT /Tx /T /Gar#FC /Rect [72 600 272 620] /V /Val#FC >>",
    b"<< /Type /Annot /Subtype /Widget /FT /Ch /Ff 131072 /T (combo) /Rect [72 560 272 580] /Opt [(a) (b)] "
    b"/V /Cho#FC >>",
    b"<< /Type /Annot /Subtype /Widget /FT /Ch /T (list) /Rect [72 480 272 540] /Opt [(a) (b)] /V [/Li#FC] >>",
    b"<< /Type /Annot /Subtype /Widget /FT /Ch /T (single) /Rect [72 400 272 460] /Opt [(a) (b)] /V /One#FC >>",
    b"<< /Type /Annot /Subtype /Widget /FT /Sig /T (sig) /Rect [72 300 272 340] "
    b"/Lock << /Type /SigFieldLock /Action /Include /Fields [/Gar#FC] >> >>",
    b"<< /Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (go) /Rect [72 250 172 270] "
    b"/A << /S /GoToR /F << /Type /Filespec /F /Fi#FCle >> /D [0 /Fit] >> >>",
    b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (da) /Rect [72 200 272 220] /DA /Helv#FC /V (text) >>",
]


class TestTextSlotsHoldingNamesThatAreNotUtf8:
    """A slot the format fills with a text string can hold a name in a
    damaged file. `str()` reads a UTF-8 one as its solidus and its text, and
    raised for any other, failing the whole form. Each such value now reads
    as its solidus and its label, the same way."""

    def test_the_field_list_reads_each_value(self, tmp_dir):
        from engine.forms import read_form_fields

        fields = {f["name"]: f for f in read_form_fields(_doc(tmp_dir, "s.pdf", _TEXT_SLOTS))["fields"]}
        assert fields["/Gar#FC"]["value"] == "/Val#FC"
        assert fields["combo"]["value"] == "/Cho#FC"
        assert fields["list"]["value"] == ["/Li#FC"]
        assert fields["single"]["value"] == "/One#FC"
        assert fields["sig"]["lock"] == {"action": "include", "fields": ["/Gar#FC"]}
        assert fields["go"]["field_actions"]["A"]["file"] == "/Fi#FCle"

    def test_a_fill_draws_every_field_past_those_values(self, tmp_dir):
        from engine.forms import fill_form_fields, read_form_fields

        out = os.path.join(tmp_dir, "o.pdf")
        fill_form_fields(_doc(tmp_dir, "s.pdf", _TEXT_SLOTS), out, {"/Gar#FC": "New text", "da": "Other"})
        fields = {f["name"]: f["value"] for f in read_form_fields(out)["fields"]}
        assert (fields["/Gar#FC"], fields["da"]) == ("New text", "Other")

    def test_a_merge_carries_a_field_named_by_such_a_name(self, tmp_dir):
        from engine.forms import read_form_fields
        from engine.merge import merge

        first = _doc(tmp_dir, "a.pdf", _TEXT_SLOTS)
        second = _doc(tmp_dir, "b.pdf", _TEXT_SLOTS)
        out = os.path.join(tmp_dir, "m.pdf")
        assert merge([first, second], out)["pages"] == 2
        names = [f["name"] for f in read_form_fields(out)["fields"]]
        assert "/Gar#FC" in names and len(names) == 14

    def test_a_new_field_is_added_beside_a_field_named_by_such_a_name(self, tmp_dir):
        from engine.form_authoring import add_form_fields
        from engine.forms import read_form_fields

        out = os.path.join(tmp_dir, "o.pdf")
        add_form_fields(_doc(tmp_dir, "s.pdf", _TEXT_SLOTS), out,
                        [{"name": "added", "type": "text", "page_index": 0, "rect": [300, 600, 500, 620]}])
        assert "added" in [f["name"] for f in read_form_fields(out)["fields"]]

    def test_detection_lists_a_field_named_by_such_a_name(self, tmp_dir):
        from engine.form_detect import detect_form_fields

        result = detect_form_fields(_doc(tmp_dir, "s.pdf", _TEXT_SLOTS), scan="never")
        assert result["existing_fields"] == 7

    def test_links_read_a_uri_and_a_file_that_are_names(self, tmp_dir):
        from engine.links import list_links

        src = _page_doc(tmp_dir, "l.pdf", page=b"/Annots [5 0 R 6 0 R]", extra=(
            b"<< /Type /Annot /Subtype /Link /Rect [70 695 90 715] /A << /S /URI /URI /Ur#FCl >> >>",
            b"<< /Type /Annot /Subtype /Link /Rect [70 655 90 675] /A << /S /Launch /F << /Type /Filespec "
            b"/F /Fi#FCle >> >> >>"))
        specs = [link["target_spec"] for link in list_links(src)["links"]]
        assert specs == [{"kind": "uri", "url": "/Ur#FCl"}, {"kind": "launch", "path": "/Fi#FCle"}]

    def test_the_census_reads_an_attachment_name_that_is_a_name(self, tmp_dir):
        from engine.standards_report import census

        facts = census(_page_doc(tmp_dir, "c.pdf", catalog=b"/Names << /EmbeddedFiles << /Names [/At#FC 5 0 R] >> >>",
                                 extra=(b"<< /Type /Filespec /F (a.txt) /EF << /F 6 0 R >> >>",
                                        _stream(b"hello", b"/Type /EmbeddedFile"))))
        assert (facts.reasons.get("attachments"), facts.values.get("attachments")) == (None, ["/At#FC"])

    def test_an_xfa_packet_named_by_such_a_name_is_passed_over(self, tmp_dir):
        from engine.forms import read_form_fields

        src = _xfa_states(tmp_dir, b"<box>Gr#FCn</box><choice/>")
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            pdf.Root.AcroForm.XFA.append(pikepdf.Object.parse(b"/Gar#FC"))
            pdf.Root.AcroForm.XFA.append(pdf.make_stream(b"<extra/>"))
            pdf.save(src)
        fields = {f["name"]: f for f in read_form_fields(src)["fields"]}
        assert fields[_XFA_BOX]["value"] is True

    def test_a_fill_after_signing_indexes_a_field_named_by_such_a_name(self, tmp_dir):
        from test_pades import _build_pki

        from engine.incremental import transplant_incremental
        from engine.signatures import sign_pdf

        pki = _build_pki(tmp_dir)
        source = _pyhanko_names_pdf(tmp_dir)
        with pikepdf.open(source, allow_overwriting_input=True) as pdf:
            extra = pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Tx,
                T=pikepdf.Object.parse(b"/Gar#FC"), Rect=pikepdf.Array([60, 20, 160, 40]), F=4,
                P=pdf.pages[0].obj, V=pikepdf.String("old")))
            pdf.pages[0].obj.Annots.append(extra)
            pdf.Root.AcroForm.Fields.append(extra)
            pdf.save(source)
        signed = os.path.join(tmp_dir, "signed.pdf")
        sign_pdf(source, signed, pfx_path=pki["pfx"], password="pw")
        modified = os.path.join(tmp_dir, "modified.pdf")
        with pikepdf.open(signed) as pdf:
            widget = next(a for a in pdf.pages[0].obj.Annots if a.get("/FT") == pikepdf.Name.Btn)
            state = pikepdf.Object.parse(b"/Stra#DFe")
            widget["/V"] = state
            widget["/AS"] = state
            pdf.save(modified)
        out = os.path.join(tmp_dir, "appended.pdf")
        result = transplant_incremental(signed, modified, out)
        assert (result["applied"], result["fields_updated"]) == (True, 1), result
        with open(signed, "rb") as fh:
            original = fh.read()
        with open(out, "rb") as fh:
            assert fh.read().startswith(original)


class TestAnnotationsOfSuchSubtypesAndRelationships:
    def test_the_comment_list_counts_an_unknown_subtype_as_unmodelled(self, tmp_dir):
        from engine.comment_summary import list_comments

        src = _page_doc(tmp_dir, "c.pdf", page=b"/Annots [5 0 R 6 0 R]", extra=(
            b"<< /Type /Annot /Subtype /Te#FCxt /Rect [10 10 30 30] /Contents (odd) >>",
            b"<< /Type /Annot /Subtype /Text /Rect [40 10 60 30] /Contents (A note) /RT /R#FC >>"))
        result = list_comments(src)
        assert result["unreadable"] == []
        assert [c["contents"] for c in result["comments"]] == ["A note"]

    def test_the_xfdf_export_reads_a_relationship_of_such_a_name(self, tmp_dir):
        from engine.xfdf import export_xfdf

        src = _page_doc(tmp_dir, "x.pdf", page=b"/Annots [5 0 R]", extra=(
            b"<< /Type /Annot /Subtype /Text /Rect [40 10 60 30] /Contents (A note) /RT /R#FC >>",))
        result = export_xfdf(src, os.path.join(tmp_dir, "x.xfdf"))
        assert (result["count"], result["skipped"], result["partial"]) == (1, [], [])

    def test_the_crop_keeps_an_annotation_of_such_a_subtype(self, tmp_dir):
        from engine.content_crop import content_crop

        src = _page_doc(tmp_dir, "c.pdf", page=b"/Annots [5 0 R]", extra=(
            b"<< /Type /Annot /Subtype /Te#FCxt /Rect [400 100 450 150] /Contents (odd) >>",))
        out = os.path.join(tmp_dir, "o.pdf")
        content_crop(src, out)
        with pikepdf.open(out) as pdf:
            crop = [float(v) for v in pdf.pages[0].obj.CropBox]
        assert crop[2] >= 450 and crop[1] <= 100

    def test_a_named_action_of_such_a_name_is_read(self, tmp_dir):
        from engine.forms import read_form_fields

        src = _page_doc(tmp_dir, "f.pdf", catalog=b"/AcroForm << /Fields [5 0 R] >>", page=b"/Annots [5 0 R]",
                        extra=(b"<< /Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (go) /Rect [72 300 172 320] "
                               b"/A << /S /Named /N /Next#FCPage >> >>",))
        [field] = read_form_fields(src)["fields"]
        assert field["field_actions"] == {"A": {"kind": "named", "name": "Next#FCPage"}}

    def test_a_role_mapped_through_a_role_of_such_a_name_is_a_heading(self, tmp_dir):
        from engine.derived_nav import preview_structure_outline

        src = _doc(tmp_dir, "r.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 5 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /StructParents 0 /Resources << /Font << /F1 "
            + _HELVETICA + b" >> >> /Contents 4 0 R >>",
            _stream(b"/MyHead << /MCID 0 >> BDC BT /F1 18 Tf 72 700 Td (Chapter one) Tj ET EMC"),
            b"<< /Type /StructTreeRoot /K 6 0 R /RoleMap << /MyHead /Mid#FC /Mid#FC /H1 >> "
            b"/ParentTree << /Nums [0 [7 0 R]] >> >>",
            b"<< /Type /StructElem /S /Document /P 5 0 R /K [7 0 R] >>",
            b"<< /Type /StructElem /S /MyHead /P 6 0 R /Pg 3 0 R /K 0 >>",
        ])
        outline = preview_structure_outline(src)["outline"]
        assert [entry["title"] for entry in outline] == ["Chapter one"]


#: A page whose transparent square is rasterized and whose other content
#: stays: a damaged keyword, an image, a shading, a pattern, a spot fill and a
#: stroke under a state, each resource named with a byte that is not UTF-8.
_FLATTEN_NAMES = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /ExtGState << /G#E9 << /ca 0.5 >> "
    b"/L#E9 << /LW 2 >> >> /XObject << /Im#E9 5 0 R >> /Shading << /Sh#E9 6 0 R >> /Pattern << /P#E9 7 0 R >> "
    b"/ColorSpace << /CS#E9 [/Separation /Spot /DeviceCMYK " + _FN + b"] >> >> /Contents 4 0 R >>",
    _stream(b"\xfc\xfd\nq /G#E9 gs 0 0 1 rg 100 100 50 50 re f Q\nq 100 0 0 50 300 500 cm /Im#E9 Do Q\n"
            b"q 300 300 50 50 re W n /Sh#E9 sh Q\n/Pattern cs /P#E9 scn 400 100 50 50 re f\n"
            b"/CS#E9 cs 1 scn 500 100 50 50 re f\nq /L#E9 gs 0 g 10 10 m 60 10 l S Q"),
    _IMAGE_BODY,
    _RGB_AXIAL,
    _stream(b"0 0 1 rg 0 0 10 10 re f", b"/PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] "
            b"/XStep 10 /YStep 10 /Resources << >>"),
]


class TestFlatteningKeepsWhatItDoesNotRasterizeByItsBytes:
    def test_the_rasterized_square_leaves_every_other_resource_in_place(self, tmp_dir, gs_path):
        from engine.flattener import flatten_transparency

        out = os.path.join(tmp_dir, "f.pdf")
        result = flatten_transparency(_doc(tmp_dir, "f.pdf", _FLATTEN_NAMES), out, gs_path=gs_path)
        assert [(p["regions"], p["removed"], p["error"]) for p in result["pages"]] == [(1, 1, None)]
        assert _resource_keys(out, "/Shading") == [b"/Sh\xe9"]
        assert _resource_keys(out, "/Pattern") == [b"/P\xe9"]
        assert b"/L\xe9" in _resource_keys(out, "/ExtGState")
        assert b"/Im\xe9" in _resource_keys(out, "/XObject")
        with pikepdf.open(out) as pdf:
            assert b"\xfc\xfd" in [bytes(i.operator) for i in pikepdf.parse_content_stream(pdf.pages[0])]

    def test_forms_whose_group_or_child_is_named_that_way_are_read(self, tmp_dir):
        from engine.flattener import list_transparency

        src = _doc(tmp_dir, "t.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Fg 5 0 R /Fx 6 0 R >> "
            b">> /Contents 4 0 R >>",
            _stream(b"q 1 0 0 1 100 100 cm /Fg Do Q q 1 0 0 1 300 100 cm /Fx Do Q"),
            _stream(b"0 0 1 rg 0 0 50 50 re f", b"/Type /XObject /Subtype /Form /BBox [0 0 50 50] "
                    b"/Group << /S /Tra#FCnsparency >>"),
            _stream(b"0 1 0 rg 0 0 50 50 re f", b"/Type /XObject /Subtype /Form /BBox [0 0 50 50] "
                    b"/Resources << /XObject << /Odd 7 0 R >> >>"),
            _stream(b"0 0 1 rg 0 0 5 5 re f", b"/Type /XObject /Subtype /Ima#FCge /BBox [0 0 10 10]"),
        ])
        [page] = list_transparency(src)["pages"]
        assert page["counts"]["unknown"] == 0 and page["unknown"] == []
        assert not any(o["unknown"] for o in page["objects"])


def _a11y_fonts(tmp_dir: str, program: bytes) -> str:
    """A composite font whose encoding and a TrueType font whose subtype are
    names that are not UTF-8, text in a Courier face inside a form named by
    such bytes, and a table whose summary is a name."""
    return _doc(tmp_dir, "a11y-fonts.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 20 0 R /Lang (en) >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /StructParents 0 "
        b"/Resources << /Font << /F7 5 0 R /F8 9 0 R >> /XObject << /Fm#E9 10 0 R >> >> /Contents 4 0 R >>",
        _stream(b"/P << /MCID 0 >> BDC BT /F7 12 Tf 72 700 Td <0024> Tj ET EMC "
                b"/P << /MCID 1 >> BDC BT /F8 12 Tf 72 680 Td (AB) Tj ET EMC "
                b"/P << /MCID 2 >> BDC q 1 0 0 1 72 600 cm /Fm#E9 Do Q EMC"),
        b"<< /Type /Font /Subtype /Type0 /BaseFont /LiberationSans /Encoding /Iden#FCtity-H /DescendantFonts [6 0 R] "
        b"/ToUnicode 11 0 R >>",
        b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LiberationSans /CIDSystemInfo << /Registry (Adobe) "
        b"/Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 /CIDToGIDMap /Identity >>",
        b"<< /Type /FontDescriptor /FontName /LiberationSans /Flags 32 /FontBBox [0 -200 1000 900] /ItalicAngle 0 "
        b"/Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>",
        b"<< /Length %d /Length1 %d >> stream\n" % (len(program), len(program)) + program + b"\nendstream",
        b"<< /Type /Font /Subtype /True#FCType /BaseFont /LiberationSans /FirstChar 32 /LastChar 126 "
        b"/Encoding /WinAnsiEncoding /FontDescriptor 7 0 R >>",
        _stream(b"BT /F9 12 Tf 0 10 Td (Form words) Tj ET",
                b"/Type /XObject /Subtype /Form /BBox [0 0 200 50] /Resources << /Font << /F9 << /Type /Font "
                b"/Subtype /Type1 /BaseFont /Courier >> >> >>"),
        _TOUNICODE_A,
        b"null", b"null", b"null", b"null", b"null", b"null", b"null", b"null",
        b"<< /Type /StructTreeRoot /K 21 0 R /ParentTree << /Nums [0 [22 0 R 22 0 R 22 0 R]] >> >>",
        b"<< /Type /StructElem /S /Document /P 20 0 R /K [22 0 R 23 0 R] >>",
        b"<< /Type /StructElem /S /P /P 21 0 R /Pg 3 0 R /K [0 1 2] >>",
        b"<< /Type /StructElem /S /Table /P 21 0 R /A << /O /Table /Summary /Su#FCmmary >> /K 24 0 R >>",
        b"<< /Type /StructElem /S /TR /P 23 0 R /K 25 0 R >>",
        b"<< /Type /StructElem /S /TH /P 24 0 R /A << /O /Table /Scope /Column >> /K [] >>",
    ])


class TestFontAndTableChecksReadNamesThatAreNotUtf8:
    def test_each_check_reads_the_fonts_and_the_table(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.accessibility import check_accessibility

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        with open(os.path.join(FONT_DIR, "LiberationSans-Regular.ttf"), "rb") as fh:
            program = fh.read()
        report = check_accessibility(_a11y_fonts(tmp_dir, program))
        checks = {c["id"]: c for cat in report["categories"] for c in cat["checks"]}
        assert report["unreadable"] == []
        assert [f["values"]["font"] for f in checks["font_embedding"]["findings"]] == ["Courier"]
        assert (checks["unicode_mapping"]["status"], checks["unicode_mapping"]["findings"]) == ("pass", [])
        assert (checks["table_summary"]["status"], checks["table_summary"]["findings"]) == ("pass", [])


class TestMoreReadersPastNamesThatAreNotUtf8:
    """Each reader below spelled a subtype, an encoding or a keyword with
    `str()`, and a name or keyword that is not UTF-8 failed the whole call."""

    def test_a_scan_behind_a_damaged_keyword_is_a_scan_and_one_beside_an_odd_xobject_is_not(self, tmp_dir):
        import zlib

        from engine.mrc import mrc_compress

        pixels = zlib.compress(bytes([255, 255, 0, 0] * 16) * 64)
        page = (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im#E9 5 0 R "
                b"/Xg 6 0 R >> >> /Contents %d 0 R >>")
        src = _doc(tmp_dir, "s.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
            page % 7,
            page % 8,
            _stream(pixels, b"/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray "
                    b"/BitsPerComponent 8 /Filter /FlateDecode"),
            _stream(b"", b"/Type /XObject /Subtype /Fo#FCrm /BBox [0 0 10 10]"),
            _stream(b"\xfc\xfd q 612 0 0 792 0 0 cm /Im#E9 Do Q"),
            _stream(b"q 612 0 0 792 0 0 cm /Im#E9 Do Q q /Xg Do Q"),
        ])
        result = mrc_compress(src, os.path.join(tmp_dir, "o.pdf"))
        reasons = {p["page"]: p.get("reason") for p in result["pages"]}
        assert reasons[2] == "this page draws more than a scanned image"
        assert reasons[1] != "this page draws more than a scanned image"

    def test_a_scan_whose_image_space_family_is_such_a_name_is_passed_over(self, tmp_dir):
        import zlib

        from engine.mrc import mrc_compress

        pixels = zlib.compress(bytes([0]) * (64 * 64))
        src = _doc(tmp_dir, "s.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"q 612 0 0 792 0 0 cm /Im1 Do Q"),
            _stream(pixels, b"/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace [/Ind#FCexed "
                    b"/DeviceRGB 0 <FF0000>] /BitsPerComponent 8 /Filter /FlateDecode"),
        ])
        result = mrc_compress(src, os.path.join(tmp_dir, "o.pdf"))
        [page] = result["pages"]
        assert page.get("reason") != "the page image uses an indexed colour space"

    def test_a_thin_border_of_an_annotation_of_such_a_subtype_is_listed(self, tmp_dir):
        from engine.hairlines import list_hairlines

        src = _page_doc(tmp_dir, "h.pdf", page=b"/Annots [5 0 R]", extra=(
            b"<< /Type /Annot /Subtype /Sq#FCuare /Rect [100 100 200 200] /BS << /W 0.1 >> >>",))
        [row] = [r for r in list_hairlines(src)["pages"] if r["annotations"]]
        assert [a["subtype"] for a in row["annotations"]] == ["/Sq#FCuare"]

    def test_a_field_whose_font_has_such_an_encoding_is_filled(self, tmp_dir):
        from engine.forms import fill_form_fields, read_form_fields

        src = _page_doc(tmp_dir, "f.pdf", catalog=b"/AcroForm << /Fields [5 0 R] /DR << /Font << /F9 << /Type /Font "
                        b"/Subtype /Type1 /BaseFont /Helvetica /Encoding /Gar#FC >> >> >> >>", page=b"/Annots [5 0 R]",
                        extra=(b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (t) /Rect [72 600 272 620] "
                               b"/DA (/F9 10 Tf 0 g) >>",))
        out = os.path.join(tmp_dir, "o.pdf")
        fill_form_fields(src, out, {"t": "Filled"})
        assert [f["value"] for f in read_form_fields(out)["fields"]] == ["Filled"]


_CID_FONT = (b"<< /Type /Font /Subtype /Type0 /BaseFont /LiberationSans /Encoding /Identity-H "
             b"/DescendantFonts [<< /Type /Font /Subtype %s /BaseFont /LiberationSans /CIDSystemInfo << "
             b"/Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor << /Type /FontDescriptor "
             b"/FontName /LiberationSans /Flags 32 >> /CIDToGIDMap %s >>] >>")


class TestFontEmbeddingRefusesByTheLabel:
    @pytest.mark.parametrize(("font", "reason"), [
        (_CID_FONT % (b"/CIDFontType2", b"/Id#FCentity"), "it carries its own glyph-id map"),
        (_CID_FONT % (b"/CIDFont#FCType2", b"/Identity"), "this engine embeds a glyph-indexed CID font"),
        (b"<< /Type /Font /Subtype /Type#FC1 /BaseFont /LiberationSans /FirstChar 65 /LastChar 65 /Widths [667] "
         b"/FontDescriptor << /Type /FontDescriptor /FontName /LiberationSans /Flags 32 >> >>", "LiberationSans"),
    ], ids=["glyph-map-of-such-a-name", "descendant-of-such-a-subtype", "font-of-such-a-subtype"])
    def test_the_refusal_names_the_font(self, tmp_dir, font, reason):
        from outline_builders import FONT_DIR, fonts_available

        from engine.font_embed import embed_missing_fonts

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        src = _doc(tmp_dir, "c.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F3 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"BT /F3 12 Tf 72 700 Td <0041> Tj ET"),
            font,
        ])
        try:
            result = embed_missing_fonts(src, os.path.join(tmp_dir, "o.pdf"), sources=("bundled",),
                                         font_dir=os.path.abspath(FONT_DIR))
        except ValueError as exc:
            assert reason in str(exc) and "codec" not in str(exc)
        else:
            assert [e["font"] for e in result["embedded"]] == ["LiberationSans"]


#: A spot painted beside an XObject whose subtype is a name that is not UTF-8,
#: a spot whose alternate space's family is such a name, and a spot whose
#: alternate is an indexed space over a base of such a family.
_SPOT_BESIDE_ODD = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /ColorSpace << /CS1 [/Separation /Spot "
    b"/DeviceCMYK " + _FN + b"] /CS2 [/Separation /Odd [/Ca#FClRGB << /WhitePoint [0.95 1 1.09] >>] " + _FN
    + b"] /CS3 [/Separation /Odd2 [/Indexed [/IC#FCCBased << /N 3 >>] 0 <000000>] " + _FN
    + b"] >> /XObject << /Xg 5 0 R >> >> /Contents 4 0 R >>",
    _stream(b"q /Xg Do Q /CS1 cs 1 scn 100 100 50 50 re f /CS2 cs 1 scn 200 100 50 50 re f "
            b"/CS3 cs 1 scn 300 100 50 50 re f"),
    _stream(b"0 0 1 rg 0 0 5 5 re f", b"/Type /XObject /Subtype /Fo#FCrm /BBox [0 0 10 10]"),
]


class TestInkEditsPastNamesThatAreNotUtf8:
    def test_a_spot_converts_beside_an_xobject_of_such_a_subtype(self, tmp_dir):
        from engine.ink_manager import spot_to_process

        out = os.path.join(tmp_dir, "o.pdf")
        result = spot_to_process(_doc(tmp_dir, "s.pdf", _SPOT_BESIDE_ODD), out, ["Spot"])
        assert (result["inks"], result["paints"]) == (["Spot"], 1)

    def test_the_ink_list_reads_a_spot_whose_alternate_family_is_such_a_name(self, tmp_dir):
        from engine.separations import list_inks

        inks = {e["name"]: e for e in list_inks(_doc(tmp_dir, "s.pdf", _SPOT_BESIDE_ODD))["inks"]}
        assert {"Odd", "Odd2", "Spot"} <= set(inks)


class TestVectorAndImageEditsBesideKeywordsThatAreNotUtf8:
    def test_deleting_one_draw_of_a_shading_drawn_twice_keeps_it_past_a_keyword(self, tmp_dir):
        from engine.page_vectors import delete_page_vector, list_page_vectors

        src = _doc(tmp_dir, "s.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Shading << /Sh1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"\xfc\xfd q 100 100 50 50 re W n /Sh1 sh Q q 300 300 50 50 re W n /Sh1 sh Q"),
            _RGB_AXIAL,
        ])
        first = min(v["index"] for v in list_page_vectors(src, 1)["vectors"])
        out = os.path.join(tmp_dir, "o.pdf")
        delete_page_vector(src, out, 1, first)
        assert _resource_keys(out, "/Shading") == [b"/Sh1"]

    def test_a_path_with_a_keyword_inside_it_moves(self, tmp_dir):
        from engine.page_vectors import list_page_vectors, transform_page_vector

        src = _doc(tmp_dir, "p.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
            _stream(b"0 0 1 RG 2 w 100 100 m \xfc\xfd 200 200 l S"),
        ])
        [vector] = list_page_vectors(src, 1)["vectors"]
        out = os.path.join(tmp_dir, "o.pdf")
        transform_page_vector(src, out, 1, vector["index"], [1, 0, 0, 1, 10, 10])
        [moved] = list_page_vectors(out, 1)["vectors"]
        assert moved["rect"] == pytest.approx([10, 10, 11, 11], abs=1e-4)

    def test_an_image_under_a_keyword_in_its_own_frame_moves(self, tmp_dir):
        from engine.page_images import list_page_images, transform_page_image

        src = _doc(tmp_dir, "i.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"q \xfc\xfd 100 0 0 50 100 500 cm /Im1 Do Q"),
            _IMAGE_BODY,
        ])
        out = os.path.join(tmp_dir, "o.pdf")
        transform_page_image(src, out, 1, 0, [1, 0, 0, 1, 10, 10])
        assert list_page_images(out, 1)["images"][0]["rect"] == pytest.approx([10, 10, 11, 11], abs=0.01)

    def test_an_image_whose_space_is_such_a_name_lists_that_family(self, tmp_dir):
        from engine.page_images import list_page_images

        src = _doc(tmp_dir, "i.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"q 100 0 0 50 100 500 cm /Im1 Do Q"),
            _stream(b"\x00\x80\x80\x00", b"/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /Gar#FC "
                    b"/BitsPerComponent 8"),
        ])
        [image] = list_page_images(src, 1)["images"]
        assert image["colour_family"] == "Gar#FC"


class TestPrintChecksReadNamesThatAreNotUtf8:
    _DOC = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Xg 5 0 R /Fg 6 0 R "
        b"/Fm#E9 7 0 R >> /ExtGState << /G1 << /SMask /No#FCne >> /OP << /OP true /op true /OPM 1 >> >> "
        b"/ColorSpace << /CS0 [/Ca#FClRGB << /WhitePoint [0.95 1 1.09] >>] /CS1 [/Separation /Spot /DeviceCMYK "
        + _FN + b"] /CS#E9 [/Separation /Spot2 /DeviceCMYK " + _FN + b"] >> >> /Contents 4 0 R >>",
        _stream(b"q /Xg Do Q q /Fg Do Q q /G1 gs 0 g 10 10 50 50 re f Q q /OP gs /CS0 cs 0 0 0 scn 100 100 50 50 re f Q "
                b"q /OP gs 1 0 0 1 300 300 cm /Fm#E9 Do Q q /OP gs /CS#E9 cs 0 scn 400 100 50 50 re f Q"),
        _stream(b"0 0 1 rg 0 0 5 5 re f", b"/Type /XObject /Subtype /Fo#FCrm /BBox [0 0 10 10]"),
        _stream(b"0 0 1 rg 0 0 5 5 re f", b"/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Group << /S /Tra#FCns >>"),
        _stream(b"/CS1 cs 0 scn 0 0 20 20 re f", b"/Type /XObject /Subtype /Form /BBox [0 0 20 20] /Resources << "
                b"/ColorSpace << /CS1 [/Separation /Spot /DeviceCMYK " + _FN + b"] >> >>"),
    ]

    def test_preflight_reads_every_branch(self, tmp_dir):
        from engine.preflight import preflight

        report = preflight(_doc(tmp_dir, "p.pdf", self._DOC))
        unread = [f for c in report["checks"] for f in c.get("findings") or [] if f.get("detail_key") == "unreadable_branch"]
        assert unread == []

    def test_overprint_reads_the_family_and_the_form(self, tmp_dir):
        from engine.overprint import list_overprint

        listed = list_overprint(_doc(tmp_dir, "p.pdf", self._DOC))
        assert listed["unreadable"] == []
        assert sorted((p["family"], p["zero_tint"]) for p in listed["paints"]) == [
            ("Ca#FClRGB", None), ("Separation", True), ("Separation", True)]


#: Hidden content reached through names and keywords that are not UTF-8: a
#: default configuration whose base state is such a name, an OCMD whose
#: policy is such a name, a marked-content tag of such bytes, a damaged
#: keyword on the page and inside a hidden block, a form of such a name
#: that a hidden group hides, a form holding hidden text, and an XObject of
#: such a subtype.
_HIDDEN_KITCHEN2 = [
    b"<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R] /D << /BaseState /O#FCN "
    b"/Order [5 0 R 6 0 R] /OFF [5 0 R] >> >> >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
    + b" >> /Properties << /MC0 5 0 R /MD 7 0 R >> /XObject << /Fm#E9 8 0 R /Fh#E9 9 0 R /Xg 10 0 R >> >> "
    b"/Contents 4 0 R >>",
    _stream(b"\xfc\xfd q /Xg Do Q BT /F1 12 Tf 72 700 Td (Shown words) Tj ET "
            b"/Sp#E9n << >> BDC BT /F1 12 Tf 72 680 Td (Tagged words) Tj ET EMC "
            b"/OC /MC0 BDC q \xfc\xfd Q BT /F1 12 Tf 72 650 Td (Hidden words) Tj ET EMC q /Fh#E9 Do Q "
            b"/OC /MD BDC BT /F1 12 Tf 72 620 Td (Policy words) Tj ET EMC "
            b"q 1 0 0 1 72 400 cm /Fm#E9 Do Q"),
    b"<< /Type /OCG /Name (Layer) >>",
    b"<< /Type /OCG /Name (Other) >>",
    b"<< /Type /OCMD /OCGs [5 0 R] /P /Al#FClOn >>",
    _stream(b"BT /F1 12 Tf 0 30 Td (Form shown) Tj ET /OC /MC0 BDC BT /F1 12 Tf 0 10 Td (Form hidden) Tj ET EMC",
            b"/Type /XObject /Subtype /Form /BBox [0 0 200 50] /Resources << /Font << /F1 " + _HELVETICA
            + b" >> /Properties << /MC0 5 0 R >> >>"),
    _stream(b"0 0 1 rg 0 0 5 5 re f", b"/Type /XObject /Subtype /Form /BBox [0 0 10 10] /OC 5 0 R"),
    _stream(b"0 0 1 rg 0 0 5 5 re f", b"/Type /XObject /Subtype /Fo#FCrm /BBox [0 0 10 10]"),
]


class TestHiddenLayersPastNamesAndKeywordsThatAreNotUtf8:
    """The layer removal and the hidden-text removal walk every operator,
    every form and every group the page selects; each read a name or a
    keyword with `str()` and failed on one that is not UTF-8."""

    def test_the_audit_names_each_hidden_run(self, tmp_dir):
        from engine.sanitize import audit_hidden_information

        audit = audit_hidden_information(_doc(tmp_dir, "h.pdf", _HIDDEN_KITCHEN2))
        [hidden] = [c for c in audit["categories"] if c["id"] == "hidden_text"]
        assert sorted(d["text"] for d in hidden["detail"]) == ["Form hidden", "Hidden words", "Policy words"]

    @pytest.mark.parametrize("category", ["hidden_text", "hidden_layers"])
    def test_the_removal_removes_each_hidden_run_and_keeps_the_rest(self, tmp_dir, category):
        from engine.sanitize import sanitize_pdf

        out = os.path.join(tmp_dir, "s.pdf")
        sanitize_pdf(_doc(tmp_dir, "h.pdf", _HIDDEN_KITCHEN2), out, categories=[category])
        text = pdfminer_text(out)
        assert all(t in text for t in ("Shown words", "Tagged words", "Form shown"))
        assert not any(t in text for t in ("Hidden words", "Policy words", "Form hidden"))
        with pikepdf.open(out) as pdf:
            assert b"\xfc\xfd" in [bytes(i.operator) for i in pikepdf.parse_content_stream(pdf.pages[0])]
            if category == "hidden_layers":
                assert b"/Fh\xe9" not in [k.encode("utf-8", "surrogateescape")
                                          for k in pdf.pages[0].obj.Resources.XObject.keys()]


class TestMoreEditsPastNamesThatAreNotUtf8:
    def test_an_image_under_a_state_of_such_a_name_lists_its_opacity(self, tmp_dir):
        from engine.page_images import list_page_images

        src = _doc(tmp_dir, "i.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> "
            b"/ExtGState << /G#E9 << /ca 0.5 >> >> >> /Contents 4 0 R >>",
            _stream(b"q /G#E9 gs 100 0 0 50 100 500 cm /Im1 Do Q"),
            _IMAGE_BODY,
        ])
        [image] = list_page_images(src, 1)["images"]
        assert image["opacity"] == pytest.approx(0.5)

    def test_a_redaction_reads_past_an_xobject_of_such_a_subtype(self, tmp_dir):
        from engine.redact import redact

        src = _page_doc(tmp_dir, "r.pdf", content=b"q /Xg Do Q BT /F1 12 Tf 72 700 Td (Secret words) Tj ET",
                        page=b"", extra=())
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            odd = pdf.make_stream(b"0 0 1 rg 0 0 5 5 re f")
            odd[pikepdf.Name.Type] = pikepdf.Name.XObject
            odd[pikepdf.Name.Subtype] = pikepdf.Object.parse(b"/Fo#FCrm")
            odd[pikepdf.Name.BBox] = pikepdf.Array([0, 0, 10, 10])
            pdf.pages[0].obj.Resources[pikepdf.Name.XObject] = pikepdf.Dictionary(Xg=odd)
            pdf.save(src)
        out = os.path.join(tmp_dir, "o.pdf")
        redact(file=src, output=out, regions=[{"page": 1, "rect": [60, 690, 300, 720]}])
        assert "Secret" not in pdfminer_text(out)

    def test_a_redaction_cuts_a_font_past_a_keyword(self, tmp_dir):
        from test_redact_fonts import KEPT, MARK, _truetype_chars, _truetype_doc

        from engine.redact import redact

        doc, _program = _truetype_doc([[(10, KEPT), (200, "QZXJ")]])
        page = doc.pages[0]
        page.Contents = doc.make_stream(b"\xfc\xfd " + pikepdf.unparse_content_stream(
            pikepdf.parse_content_stream(page)))
        src = os.path.join(tmp_dir, "in.pdf")
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")
        redact(src, out, [{"page": 1, "rect": MARK}])
        assert _truetype_chars(out) == set(KEPT)

    def test_the_audit_lists_a_field_whose_kid_has_such_a_subtype(self, tmp_dir):
        from engine.sanitize import audit_hidden_information

        src = _page_doc(tmp_dir, "k.pdf", catalog=b"/AcroForm << /Fields [5 0 R] >>", page=b"/Annots [6 0 R]", extra=(
            b"<< /FT /Tx /T (parent) /Kids [6 0 R] >>",
            b"<< /Type /Annot /Subtype /Wi#FCdget /Parent 5 0 R /T (kid) /Rect [72 600 272 620] /V (value) >>"))
        audit = audit_hidden_information(src)
        [fields] = [c for c in audit["categories"] if c["id"] == "form_fields"]
        assert not fields.get("unreadable")
        assert [d["name"] for d in fields["detail"]] == ["parent.kid"]

    def test_a_paragraph_rewrite_restores_the_font_for_the_next_line_by_its_bytes(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        src = _doc(tmp_dir, "p.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F#E9 " + _HELVETICA
            + b" >> >> /Contents 4 0 R >>",
            _stream(b"BT /F#E9 12 Tf 100 700 Td (Plain words) Tj 0 -300 Td (Other line) Tj ET"),
        ])
        para = next(p for p in list_text_paragraphs(src, 1)["paragraphs"] if p["text"] == "Plain words")
        out = os.path.join(tmp_dir, "o.pdf")
        text = "\u03a9mega words"
        replace_paragraph_text(src, out, 1, para["index"], text, [{"start": 0, "end": len(text), "run": para["runs"][0]}],
                               para["runs"], para["text"], convert=True, font_path=os.path.abspath(FONT_DIR))
        assert "Other line" in pdfminer_text(out)
        with pikepdf.open(out) as pdf:
            ops = [(bytes(i.operator), [bytes(o) if isinstance(o, pikepdf.Name) else o for o in i.operands])
                   for i in pikepdf.parse_content_stream(pdf.pages[0])]
        last_tf = [operands[0] for op, operands in ops if op == b"Tf"][-1]
        assert last_tf == b"/F\xe9"


def _pyhanko_text_field_pdf(tmp_dir: str) -> str:
    """`_pyhanko_names_pdf` with a text field whose appearance font is the
    form's `/F#E9`, a form-level key and a content-stream key that are not
    UTF-8."""
    src = _pyhanko_names_pdf(tmp_dir)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        acro = pdf.Root.AcroForm
        acro[pikepdf.Object.parse(b"/X#FC")] = pikepdf.String("form key")
        pdf.pages[0].obj.Contents[pikepdf.Object.parse(b"/Y#FC")] = 1
        text = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Tx, T=pikepdf.String("words"),
            Rect=pikepdf.Array([60, 100, 260, 120]), F=4, P=pdf.pages[0].obj,
            DA=pikepdf.String("/F#E9 10 Tf 0 g")))
        pdf.pages[0].obj.Annots.append(text)
        acro.Fields.append(text)
        pdf.save(src)
    return src


class TestAFillAfterSigningPastKeysAndFontsOfSuchBytes:
    def test_the_fill_appends_one_revision_that_keeps_the_signature(self, tmp_dir):
        from test_pades import _build_pki

        from engine.forms import fill_form_fields
        from engine.signatures import sign_pdf, verify_signatures

        pki = _build_pki(tmp_dir)
        signed = os.path.join(tmp_dir, "signed.pdf")
        sign_pdf(_pyhanko_text_field_pdf(tmp_dir), signed, pfx_path=pki["pfx"], password="pw")
        out = os.path.join(tmp_dir, "filled.pdf")
        fill_form_fields(signed, out, {"words": "Filled words"})
        with open(signed, "rb") as fh:
            original = fh.read()
        with open(out, "rb") as fh:
            assert fh.read().startswith(original)
        [signature] = verify_signatures(out)["signatures"]
        assert (signature["intact"], signature["modification_level"]) == (True, "FORM_FILLING")


#: A form whose calculated field and whose pure-data field are named by
#: names that are not UTF-8: the calculation order names the first, and the
#: second has no widget on any page.
_FORM_WITH_ORDER = [
    b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R 6 0 R] /CO [5 0 R] /DA (/Helv 0 Tf 0 g) "
    b"/DR << /Font << /Helv " + _HELVETICA + b" >> >> >> >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Annots [5 0 R] >>",
    _stream(b"BT /Helv 12 Tf 72 700 Td (Form) Tj ET"),
    b"<< /Type /Annot /Subtype /Widget /FT /Tx /T /Tot#FCal /Rect [72 600 272 620] /V (1) "
    b"/AA << /C << /S /JavaScript /JS (event.value = 1;) >> >> >>",
    b"<< /FT /Tx /T /Da#FCta /V (kept) >>",
]


class TestAMergeCarriesTheCalculationOrderAndDataFieldsNamedThatWay:
    def test_both_copies_of_each_field_travel(self, tmp_dir):
        from engine.forms import read_form_fields
        from engine.merge import merge

        first = _doc(tmp_dir, "a.pdf", _FORM_WITH_ORDER)
        second = _doc(tmp_dir, "b.pdf", _FORM_WITH_ORDER)
        out = os.path.join(tmp_dir, "m.pdf")
        assert merge([first, second], out)["pages"] == 2
        with pikepdf.open(out) as pdf:
            acro = pdf.Root.AcroForm
            order = len(acro.CO)
            titles = sorted(bytes(f.T) if isinstance(f.T, pikepdf.Name) else str(f.T).encode() for f in acro.Fields)
        assert order == 2
        assert titles.count(b"/Da\xfcta") == 1 and len(titles) == 4
        names = [f["name"] for f in read_form_fields(out)["fields"]]
        assert "/Tot#FCal" in names and "/Da#FCta" in names


class TestAVerticalFontIsBoundPastAppearancesThatAreNames:
    def test_each_field_keeps_its_size_and_colour_defaults(self, tmp_dir):
        from outline_builders import FONT_DIR

        from engine.form_authoring import author_vertical_field_font

        if not os.path.isfile(os.path.join(FONT_DIR, "NotoSansCJKsc-Regular.otf")):
            pytest.skip("bundled CJK face not provisioned")
        src = _page_doc(tmp_dir, "v.pdf", catalog=b"/AcroForm << /Fields [5 0 R 6 0 R] /DA /Form#FCDA >>",
                        page=b"/Annots [5 0 R 6 0 R]", extra=(
                            b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (own) /Rect [400 400 460 700] /DA /Own#FCDA >>",
                            b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (inherited) /Rect [300 400 360 700] >>"))
        out = os.path.join(tmp_dir, "o.pdf")
        result = author_vertical_field_font(src, out, fields=["own", "inherited"], script="japanese",
                                            font_dir=os.path.abspath(FONT_DIR))
        assert sorted(result["fields"]) == ["inherited", "own"]
        with pikepdf.open(out) as pdf:
            appearances = sorted(str(f.DA) for f in pdf.Root.AcroForm.Fields)
        assert appearances == [f"/{result['font']} 12 Tf 0 g"] * 2


class TestAppearancesPastSelectionsThatAreNames:
    def test_every_bare_widget_is_given_its_appearance(self, tmp_dir):
        from pathlib import Path

        from outline_builders import FONT_DIR

        from engine.widget_faces import regenerate_appearances_file

        path = regenerate_appearances_file(Path(_doc(tmp_dir, "s.pdf", _TEXT_SLOTS)), Path(tmp_dir),
                                           os.path.abspath(FONT_DIR))
        with pikepdf.open(path) as pdf:
            drawn = sorted(bytes(a.T) if isinstance(a.T, pikepdf.Name) else str(a.T).encode()
                           for a in pdf.pages[0].obj.Annots if a.get("/AP") is not None)
        assert drawn == [b"/Gar\xfc", b"combo", b"da", b"list", b"single"]


class TestEditsPastKeywordsInsideTheirOwnFrames:
    def test_a_paragraph_that_ends_in_another_face_restores_the_font_by_its_bytes(self, tmp_dir):
        from outline_builders import FONT_DIR, fonts_available

        from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

        if not fonts_available():
            pytest.skip("bundled fonts not provisioned")
        src = _doc(tmp_dir, "p.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F#E9 " + _HELVETICA
            + b" >> >> /Contents 4 0 R >>",
            _stream(b"BT /F#E9 12 Tf 100 700 Td (Plain words) Tj 0 -300 Td (Other line) Tj ET"),
        ])
        para = next(p for p in list_text_paragraphs(src, 1)["paragraphs"] if p["text"] == "Plain words")
        out = os.path.join(tmp_dir, "o.pdf")
        text = "Plain \u03a9"
        replace_paragraph_text(src, out, 1, para["index"], text, [{"start": 0, "end": len(text), "run": para["runs"][0]}],
                               para["runs"], para["text"], convert=True, font_path=os.path.abspath(FONT_DIR))
        assert "Other line" in pdfminer_text(out)
        with pikepdf.open(out) as pdf:
            fonts = [bytes(i.operands[0]) for i in pikepdf.parse_content_stream(pdf.pages[0])
                     if bytes(i.operator) == b"Tf"]
        assert fonts[-1] == b"/F\xe9" and fonts[-2] != b"/F\xe9"

    def test_an_image_with_a_keyword_after_its_draw_in_its_frame_moves(self, tmp_dir):
        from engine.page_images import list_page_images, transform_page_image

        src = _doc(tmp_dir, "i.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"q 100 0 0 50 100 500 cm /Im1 Do \xfc\xfd Q"),
            _IMAGE_BODY,
        ])
        out = os.path.join(tmp_dir, "o.pdf")
        transform_page_image(src, out, 1, 0, [1, 0, 0, 1, 10, 10])
        assert list_page_images(out, 1)["images"][0]["rect"] == pytest.approx([10, 10, 11, 11], abs=0.01)

    def test_an_unbalanced_hidden_block_keeps_its_save_past_a_keyword(self, tmp_dir):
        from engine.sanitize import sanitize_pdf

        src = _doc(tmp_dir, "h.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R] /D << /Order [5 0 R] /OFF [5 0 R] >> >> >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " + _HELVETICA
            + b" >> /Properties << /MC0 5 0 R >> >> /Contents 4 0 R >>",
            _stream(b"BT /F1 12 Tf 72 700 Td (Shown words) Tj ET "
                    b"/OC /MC0 BDC q \xfc\xfd BT /F1 12 Tf 72 650 Td (Hidden words) Tj ET EMC Q"),
            b"<< /Type /OCG /Name (Layer) >>",
        ])
        out = os.path.join(tmp_dir, "s.pdf")
        sanitize_pdf(src, out, categories=["hidden_layers"])
        text = pdfminer_text(out)
        assert "Shown words" in text and "Hidden words" not in text
        with pikepdf.open(out) as pdf:
            ops = [bytes(i.operator) for i in pikepdf.parse_content_stream(pdf.pages[0])]
        assert (ops.count(b"q"), ops.count(b"Q"), b"\xfc\xfd" in ops) == (1, 1, False)


class TestARevisionAfterSigningCarriesKeysOfSuchBytes:
    def test_a_new_annotation_and_its_face_keep_their_keys(self, tmp_dir):
        from test_pades import _build_pki

        from engine.incremental import transplant_incremental
        from engine.signatures import sign_pdf, verify_signatures

        pki = _build_pki(tmp_dir)
        signed = os.path.join(tmp_dir, "signed.pdf")
        sign_pdf(_pyhanko_names_pdf(tmp_dir), signed, pfx_path=pki["pfx"], password="pw")
        modified = os.path.join(tmp_dir, "modified.pdf")
        with pikepdf.open(signed) as pdf:
            face = pdf.make_stream(b"0 0 1 rg 0 0 20 20 re f")
            face.Type = pikepdf.Name.XObject
            face.Subtype = pikepdf.Name.Form
            face.BBox = pikepdf.Array([0, 0, 20, 20])
            face[pikepdf.Object.parse(b"/Y#FC")] = 1
            note = pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Square,
                                      Rect=pikepdf.Array([100, 100, 120, 120]), F=4,
                                      AP=pikepdf.Dictionary(N=face))
            note[pikepdf.Object.parse(b"/X#FC")] = pikepdf.String("kept")
            pdf.pages[0].obj.Annots.append(pdf.make_indirect(note))
            pdf.save(modified)
        out = os.path.join(tmp_dir, "appended.pdf")
        assert transplant_incremental(signed, modified, out)["applied"] is True
        with open(signed, "rb") as fh:
            original = fh.read()
        with open(out, "rb") as fh:
            assert fh.read().startswith(original)
        with pikepdf.open(out) as pdf:
            note = next(a for a in pdf.pages[0].obj.Annots if a.get("/Subtype") == pikepdf.Name.Square)
            assert str(note[pikepdf.Object.parse(b"/X#FC")]) == "kept"
            assert int(note.AP.N[pikepdf.Object.parse(b"/Y#FC")]) == 1
        [signature] = verify_signatures(out)["signatures"]
        assert (signature["intact"], signature["modification_level"]) == (True, "ANNOTATIONS")

    def test_a_change_to_a_form_that_holds_a_key_of_such_bytes_is_appended(self, tmp_dir):
        from test_pades import _build_pki

        from engine.incremental import transplant_incremental
        from engine.signatures import sign_pdf

        pki = _build_pki(tmp_dir)
        signed = os.path.join(tmp_dir, "signed.pdf")
        sign_pdf(_pyhanko_text_field_pdf(tmp_dir), signed, pfx_path=pki["pfx"], password="pw")
        modified = os.path.join(tmp_dir, "modified.pdf")
        with pikepdf.open(signed) as pdf:
            pdf.Root.AcroForm.NeedAppearances = True
            pdf.save(modified)
        out = os.path.join(tmp_dir, "appended.pdf")
        assert transplant_incremental(signed, modified, out)["applied"] is True
        with pikepdf.open(out) as pdf:
            acro = pdf.Root.AcroForm
            assert bool(acro.NeedAppearances) is True
            assert str(acro[pikepdf.Object.parse(b"/X#FC")]) == "form key"


class TestACompositeFontReportsItsDescendantsTypeOfSuchBytes:
    def test_the_font_list_names_the_descendants_type_by_its_label(self, tmp_dir):
        from engine.font_inventory import list_document_fonts

        src = _doc(tmp_dir, "f.pdf", [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> "
            b"/Contents 4 0 R >>",
            _stream(b"BT /F1 12 Tf 72 700 Td <0024> Tj ET"),
            b"<< /Type /Font /Subtype /Type0 /BaseFont /Odd /Encoding /Identity-H /DescendantFonts [6 0 R] >>",
            b"<< /Type /Font /Subtype /CIDFontType#FC2 /BaseFont /Odd /CIDSystemInfo << /Registry (Adobe) "
            b"/Ordering (Identity) /Supplement 0 >> /DW 1000 >>",
        ])
        fonts = list_document_fonts(src)["fonts"]
        assert [(f["name"], f["type"]) for f in fonts] == [("Odd", "CIDFontType#FC2")]
