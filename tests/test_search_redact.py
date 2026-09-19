"""`search_and_redact`, the per-file door the disk scope and the CLI share.

It composes two doors that have their own suites, so what is tested here is
the composition: that the hits it finds are the regions it writes, that the
signature gate is a per-file decision rather than a run-level one, that a
run finding nothing still produces the output it was asked for, and that the
Ghostscript a JBIG2 decode takes is the configured one or, with none
configured, the one the capability authority finds.
"""

import struct

import pikepdf
import pytest
from pikepdf import Dictionary, Name

import gs_axis
from engine import gs_capability as gc
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


# ── The Ghostscript a JBIG2 decode takes ──────────────────────────────────
#
# Only a hit over part of a JBIG2 image needs Ghostscript, to decode it.
# `gs_path` is the engine's whole representation of the user's choice: a
# configured path is the only Ghostscript that decode may use, and "" is the
# only value that lets the capability authority search.


def _scan(path: str) -> str:
    """One page whose word `SECRET` lies over part of a 16 x 16 JBIG2 image
    that fills the page. The image holds a page-information segment (type 48)
    and an end-of-page segment (type 49), so it passes the structure check
    that runs before any decoder and the redaction reaches the Ghostscript
    leg."""
    size = 16
    info = struct.pack(">IIIIBH", size, size, 0, 0, 0, 0)
    data = (
        struct.pack(">IBBBI", 0, 48, 0, 1, len(info)) + info
        + struct.pack(">IBBBI", 1, 49, 0, 1, 0)
    )
    doc = pikepdf.new()
    page = doc.add_blank_page(page_size=(200, 200))
    image = doc.make_stream(data)
    image["/Type"] = Name.XObject
    image["/Subtype"] = Name.Image
    image["/Width"] = size
    image["/Height"] = size
    image["/ColorSpace"] = Name.DeviceGray
    image["/BitsPerComponent"] = 1
    image["/Filter"] = Name.JBIG2Decode
    font = doc.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name("/Helvetica"),
            Encoding=Name.WinAnsiEncoding,
        )
    )
    page.Resources = Dictionary(Font=Dictionary(F1=font), XObject=Dictionary(Im0=image))
    page.Contents = doc.make_stream(
        b"q 200 0 0 200 0 0 cm /Im0 Do Q BT /F1 24 Tf 20 20 Td (SECRET) Tj ET"
    )
    doc.save(path)
    doc.close()
    return path


@pytest.fixture
def no_ambient_ghostscript(monkeypatch):
    monkeypatch.delenv(gc.PATH_ENV_VAR, raising=False)
    gc.clear_cache()
    yield
    gc.clear_cache()


def test_a_configured_path_is_the_only_ghostscript_a_jbig2_decode_uses(
    tmp_path, monkeypatch, no_ambient_ghostscript
):
    usable = str(tmp_path / "found" / "gswin64c.exe")
    gs_axis.force_available(monkeypatch, usable)
    searched = []
    monkeypatch.setattr(gc, "discover", lambda: searched.append(True) or [usable])
    configured = str(tmp_path / "nowhere" / "gswin64c.exe")
    out = tmp_path / "out.pdf"

    with pytest.raises(gc.GsUnavailable) as caught:
        search_and_redact(
            _scan(str(tmp_path / "in.pdf")), str(out), query="SECRET", gs_path=configured
        )

    assert caught.value.reason == gc.NOT_EXECUTABLE
    assert caught.value.path == configured
    assert configured in str(caught.value)
    assert searched == []
    assert not out.exists()


@pytest.mark.parametrize("unconfigured", ["", "   "])
def test_with_nothing_configured_a_jbig2_decode_searches(
    tmp_path, monkeypatch, no_ambient_ghostscript, unconfigured
):
    found = str(tmp_path / "old" / "gswin64c.exe")

    def probe(candidate) -> gc.GsCapability:
        text = str(candidate or "")
        if text == found:
            return gc.GsCapability(False, text, "9.50", gc.VERSION_BELOW_MINIMUM)
        return gc.GsCapability(False, text, "", gc.NOT_EXECUTABLE)

    def never_runs(*_args, **_kwargs):
        raise AssertionError("no Ghostscript may spawn")

    monkeypatch.setattr(gc, "discover", lambda: [found])
    monkeypatch.setattr(gc, "probe", probe)
    monkeypatch.setattr(gc, "_run", never_runs)
    out = tmp_path / "out.pdf"

    with pytest.raises(gc.GsUnavailable) as caught:
        search_and_redact(
            _scan(str(tmp_path / "in.pdf")), str(out), query="SECRET", gs_path=unconfigured
        )

    assert caught.value.reason == gc.VERSION_BELOW_MINIMUM
    assert caught.value.path == found
    assert not out.exists()


def test_a_configured_path_is_not_asked_about_when_no_input_needs_ghostscript(
    tmp_path, monkeypatch, no_ambient_ghostscript
):
    def never_asked(*_args, **_kwargs):
        raise AssertionError("a redaction with no JBIG2 image asked about Ghostscript")

    monkeypatch.setattr(gc, "resolve", never_asked)
    src = _doc(str(tmp_path / "in.pdf"))
    out = str(tmp_path / "out.pdf")
    result = search_and_redact(
        src, out, query="Jane Roe", gs_path=str(tmp_path / "nowhere" / "gswin64c.exe")
    )
    assert result["regions"] == 1
    assert "Jane Roe" not in _text_of(out)


@gs_axis.requires_gs
def test_a_configured_working_path_decodes_the_jbig2_input(tmp_path, no_ambient_ghostscript):
    out = str(tmp_path / "out.pdf")
    result = search_and_redact(
        _scan(str(tmp_path / "in.pdf")), out, query="SECRET", gs_path=gs_axis.GS_PATH
    )
    assert result["regions"] == 1
    assert result["images_modified"] == 1
    assert "SECRET" not in _text_of(out)


@gs_axis.requires_gs
def test_with_nothing_configured_the_search_finds_a_working_ghostscript(
    tmp_path, monkeypatch, no_ambient_ghostscript
):
    monkeypatch.setenv(gc.PATH_ENV_VAR, gs_axis.GS_PATH)
    monkeypatch.setattr(gc.shutil, "which", lambda *_a, **_k: None)
    out = str(tmp_path / "out.pdf")
    result = search_and_redact(_scan(str(tmp_path / "in.pdf")), out, query="SECRET")
    assert result["images_modified"] == 1
