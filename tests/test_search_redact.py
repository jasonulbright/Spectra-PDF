"""`search_and_redact`, the per-file door the disk scope and the CLI share.

It composes two doors that have their own suites, so what is tested here is
the composition: that the hits it finds are the regions it writes, that the
signature gate is a per-file decision rather than a run-level one, and that a
run finding nothing still produces the output it was asked for.
"""

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine.search_redact import search_and_redact


TEXT = b"BT /F1 18 Tf 40 700 Td (Contact Jane Roe at once) Tj ET"


def _doc(path: str, content: bytes = TEXT) -> str:
    doc = pikepdf.new()
    page = doc.add_blank_page(page_size=(612, 792))
    page.Resources = Dictionary(
        Font=Dictionary(
            F1=doc.make_indirect(
                Dictionary(
                    Type=Name.Font,
                    Subtype=Name.Type1,
                    BaseFont=Name("/Helvetica"),
                    Encoding=Name.WinAnsiEncoding,
                )
            )
        )
    )
    page.Contents = doc.make_stream(content)
    doc.save(path)
    doc.close()
    return path


def _text_of(path: str) -> str:
    from engine.extract_text import extract_text

    return extract_text(path)["text"]


def test_redacts_every_hit_and_leaves_the_neighbours(tmp_path):
    src = _doc(str(tmp_path / "in.pdf"))
    out = str(tmp_path / "out.pdf")
    result = search_and_redact(src, out, query="Jane Roe")
    assert result["hits"] == 1
    assert result["regions"] == 1
    assert result["pages"] == [1]
    assert result["marks_only"] is False
    text = _text_of(out)
    assert "Jane Roe" not in text
    assert "Contact" in text
    assert "at once" in text


def test_marks_mode_writes_annotations_and_removes_nothing(tmp_path):
    src = _doc(str(tmp_path / "in.pdf"))
    out = str(tmp_path / "out.pdf")
    result = search_and_redact(src, out, query="Jane Roe", marks_only=True)
    assert result["marks_only"] is True
    assert result["saved"] == 1
    assert "Jane Roe" in _text_of(out)
    with pikepdf.open(out) as pdf:
        annots = pdf.pages[0].obj["/Annots"]
        assert len(annots) == 1
        assert str(annots[0]["/Subtype"]) == "/Redact"


def test_a_pattern_finds_what_a_plain_query_would_not(tmp_path):
    src = _doc(
        str(tmp_path / "in.pdf"),
        b"BT /F1 14 Tf 40 700 Td (card 4111111111111111 end) Tj ET",
    )
    out = str(tmp_path / "out.pdf")
    result = search_and_redact(src, out, patterns=["credit_card"])
    assert result["hits"] == 1
    assert "4111111111111111" not in _text_of(out)


def test_properties_ride_onto_every_region(tmp_path):
    src = _doc(str(tmp_path / "in.pdf"))
    out = str(tmp_path / "out.pdf")
    search_and_redact(
        src,
        out,
        query="Jane Roe",
        marks_only=True,
        properties={"overlay_text": "(b)(6)"},
    )
    with pikepdf.open(out) as pdf:
        annot = pdf.pages[0].obj["/Annots"][0]
        assert str(annot["/OverlayText"]) == "(b)(6)"


def test_an_unknown_property_refuses_rather_than_being_dropped(tmp_path):
    src = _doc(str(tmp_path / "in.pdf"))
    with pytest.raises(ValueError, match="unknown redaction property"):
        search_and_redact(
            src, str(tmp_path / "out.pdf"), query="Jane", properties={"overlayText": "x"}
        )


def test_no_hits_still_produces_the_named_output(tmp_path):
    src = _doc(str(tmp_path / "in.pdf"))
    out = str(tmp_path / "out.pdf")
    result = search_and_redact(src, out, query="nothing here")
    assert result["hits"] == 0
    assert result["regions"] == 0
    assert _text_of(out).strip() == _text_of(src).strip()


def test_no_hits_in_place_leaves_the_file_alone(tmp_path):
    src = _doc(str(tmp_path / "in.pdf"))
    before = open(src, "rb").read()
    result = search_and_redact(src, src, query="nothing here")
    assert result["regions"] == 0
    assert open(src, "rb").read() == before


def test_in_place_redaction_rewrites_the_file(tmp_path):
    src = _doc(str(tmp_path / "in.pdf"))
    search_and_redact(src, src, query="Jane Roe")
    assert "Jane Roe" not in _text_of(src)


def test_searching_for_nothing_refuses(tmp_path):
    src = _doc(str(tmp_path / "in.pdf"))
    with pytest.raises(ValueError):
        search_and_redact(src, str(tmp_path / "out.pdf"))


def test_an_invalid_regex_refuses_rather_than_writing_a_file(tmp_path):
    src = _doc(str(tmp_path / "in.pdf"))
    out = str(tmp_path / "out.pdf")
    with pytest.raises(ValueError, match="could not be compiled"):
        search_and_redact(src, out, query="(unclosed", regex=True)
    assert not (tmp_path / "out.pdf").exists()


def test_a_signed_document_refuses_until_the_run_says_signed_are_included(
    tmp_path, monkeypatch
):
    src = _doc(str(tmp_path / "in.pdf"))
    monkeypatch.setattr(
        "engine.search_redact.signature_policy",
        lambda path: {"signed": True, "count": 1, "certified": False, "level": None},
    )
    with pytest.raises(RuntimeError, match="signed"):
        search_and_redact(src, str(tmp_path / "out.pdf"), query="Jane Roe")
    result = search_and_redact(
        src, str(tmp_path / "out.pdf"), query="Jane Roe", allow_signed=True
    )
    assert result["regions"] == 1


def test_a_no_changes_certification_refuses_even_when_signed_are_included(
    tmp_path, monkeypatch
):
    src = _doc(str(tmp_path / "in.pdf"))
    monkeypatch.setattr(
        "engine.search_redact.signature_policy",
        lambda path: {"signed": True, "count": 1, "certified": True, "level": "none"},
    )
    with pytest.raises(RuntimeError, match="no changes"):
        search_and_redact(
            src, str(tmp_path / "out.pdf"), query="Jane Roe", allow_signed=True
        )


def test_marks_mode_on_a_signed_document_proceeds(tmp_path, monkeypatch):
    src = _doc(str(tmp_path / "in.pdf"))
    monkeypatch.setattr(
        "engine.search_redact.signature_policy",
        lambda path: {"signed": True, "count": 1, "certified": False, "level": None},
    )
    result = search_and_redact(
        src, str(tmp_path / "out.pdf"), query="Jane Roe", marks_only=True
    )
    assert result["saved"] == 1
