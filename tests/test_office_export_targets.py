"""The export targets produced by the engine itself, not by LibreOffice."""

import os

import pikepdf
import pytest

from engine.office_export import export_document, supported_formats


def _text_pdf(path: str, pages: int = 1) -> None:
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    for index in range(pages):
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = pdf.make_stream(
            f"BT /F1 18 Tf 72 720 Td (Heading of page {index + 1}) Tj "
            f"0 -22 Td (Body sentence on page {index + 1}.) Tj ET".encode("latin-1")
        )
    pdf.save(path)
    pdf.close()


def _blank_pdf(path: str, pages: int = 1) -> None:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path)
    pdf.close()


def test_supported_formats_reports_each_target_options():
    rows = {f["key"]: f for f in supported_formats()["formats"]}
    assert rows["txt"]["ext"] == ".txt"
    assert set(rows["txt"]["options"]) == {"pages", "layout", "page_breaks"}
    # The LibreOffice targets take no options; offering one there would be an
    # option that silently does nothing.
    assert rows["docx"]["options"] == []


def test_text_export_writes_the_documents_text(tmp_dir):
    src = os.path.join(tmp_dir, "s.pdf")
    out = os.path.join(tmp_dir, "out.txt")
    _text_pdf(src, pages=2)
    r = export_document(src, out, "txt")
    assert r["format"] == "txt"
    assert r["pages_extracted"] == [1, 2]
    assert r["empty_pages"] == []
    body = open(out, encoding="utf-8").read()
    assert "Heading of page 1" in body
    assert "Body sentence on page 2." in body


def test_text_export_needs_no_libreoffice(tmp_dir):
    src = os.path.join(tmp_dir, "s.pdf")
    out = os.path.join(tmp_dir, "out.txt")
    _text_pdf(src)
    # An empty soffice path is what an unprovisioned install looks like; an
    # engine-produced target must not fail on it, and must not name it.
    r = export_document(src, out, "txt", "")
    assert r["size"] > 0


def test_text_export_writes_utf8_with_no_bom(tmp_dir):
    src = os.path.join(tmp_dir, "s.pdf")
    out = os.path.join(tmp_dir, "out.txt")
    _text_pdf(src)
    export_document(src, out, "txt")
    raw = open(out, "rb").read()
    assert not raw.startswith(b"\xef\xbb\xbf")


def test_page_breaks_write_a_form_feed_between_pages(tmp_dir):
    src = os.path.join(tmp_dir, "s.pdf")
    _text_pdf(src, pages=3)
    plain = os.path.join(tmp_dir, "plain.txt")
    broken = os.path.join(tmp_dir, "broken.txt")
    export_document(src, plain, "txt")
    export_document(src, broken, "txt", page_breaks=True)
    assert "\f" not in open(plain, encoding="utf-8").read()
    assert open(broken, encoding="utf-8").read().count("\f") == 2


def test_layout_mode_is_a_different_ordering(tmp_dir):
    src = os.path.join(tmp_dir, "s.pdf")
    out = os.path.join(tmp_dir, "out.txt")
    _text_pdf(src)
    r = export_document(src, out, "txt", layout="layout")
    body = open(out, encoding="utf-8").read()
    assert r["characters"] == len(body)
    assert "Heading of page 1" in body


def test_rejects_an_unknown_layout(tmp_dir):
    src = os.path.join(tmp_dir, "s.pdf")
    _text_pdf(src)
    with pytest.raises(ValueError, match="unknown text layout"):
        export_document(src, os.path.join(tmp_dir, "o.txt"), "txt", layout="sideways")


def test_page_scope_limits_the_transcription(tmp_dir):
    src = os.path.join(tmp_dir, "s.pdf")
    out = os.path.join(tmp_dir, "out.txt")
    _text_pdf(src, pages=3)
    r = export_document(src, out, "txt", pages=[2])
    assert r["pages_extracted"] == [2]
    body = open(out, encoding="utf-8").read()
    assert "page 2" in body
    assert "page 1" not in body


def test_rejects_a_page_outside_the_document(tmp_dir):
    src = os.path.join(tmp_dir, "s.pdf")
    _text_pdf(src, pages=2)
    with pytest.raises(ValueError, match=r"page 9 is out of range \(1-2\)"):
        export_document(src, os.path.join(tmp_dir, "o.txt"), "txt", pages=[9])


def test_refuses_a_document_with_no_text_layer_and_names_ocr(tmp_dir):
    src = os.path.join(tmp_dir, "blank.pdf")
    _blank_pdf(src, pages=2)
    with pytest.raises(ValueError, match="no text layer"):
        export_document(src, os.path.join(tmp_dir, "o.txt"), "txt")
    # The refusal is a RESULT: nothing is written that a caller could mistake
    # for a successful transcription.
    assert not os.path.exists(os.path.join(tmp_dir, "o.txt"))


def test_a_page_with_no_text_is_counted_not_refused(tmp_dir):
    src = os.path.join(tmp_dir, "mixed.pdf")
    _text_pdf(src, pages=1)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.add_blank_page(page_size=(612, 792))
        pdf.save(src)
    r = export_document(src, os.path.join(tmp_dir, "o.txt"), "txt")
    assert r["empty_pages"] == [2]
    assert r["pages_extracted"] == [1, 2]


def test_refuses_an_option_the_target_does_not_take(tmp_dir):
    src = os.path.join(tmp_dir, "s.pdf")
    _text_pdf(src)
    with pytest.raises(ValueError, match="the docx export takes no layout option"):
        export_document(src, os.path.join(tmp_dir, "o.docx"), "docx", "any", layout="reading")


def test_shared_guards_apply_to_the_engine_targets(tmp_dir):
    src = os.path.join(tmp_dir, "s.pdf")
    _text_pdf(src)
    outdir = os.path.join(tmp_dir, "exports")
    os.makedirs(outdir)
    with pytest.raises(ValueError, match="is a directory"):
        export_document(src, outdir, "txt")
    with pytest.raises(ValueError, match="input file not found"):
        export_document(os.path.join(tmp_dir, "nope.pdf"), os.path.join(tmp_dir, "o.txt"), "txt")
