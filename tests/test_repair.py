"""Tests for the PDF repair and recovery operations."""

import os
import shutil
import struct
import tempfile

import pikepdf
import pytest

from engine.repair import repair
from engine.rebuild import rebuild
from engine.recover import recover
from engine.check import check


# ── Fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture
def damaged_xref_pdf(sample_pdf, tmp_dir):
    """Create a PDF with a corrupted xref table (bytes zeroed in xref area)."""
    damaged = os.path.join(tmp_dir, "damaged_xref.pdf")
    with open(sample_pdf, "rb") as f:
        data = bytearray(f.read())

    # Find the xref keyword and corrupt the offset table
    xref_pos = data.find(b"xref")
    if xref_pos > 0:
        # Zero out 20 bytes after 'xref\n' to corrupt the offset table
        start = xref_pos + 5
        end = min(start + 20, len(data))
        for i in range(start, end):
            data[i] = 0x30  # Replace with '0' -- invalid offsets

    with open(damaged, "wb") as f:
        f.write(data)
    return damaged


@pytest.fixture
def truncated_pdf(sample_pdf, tmp_dir):
    """Create a truncated PDF (missing the last ~30% of data)."""
    truncated = os.path.join(tmp_dir, "truncated.pdf")
    with open(sample_pdf, "rb") as f:
        data = f.read()
    # Keep only the first 70% of the file
    cutoff = int(len(data) * 0.7)
    with open(truncated, "wb") as f:
        f.write(data[:cutoff])
    return truncated


@pytest.fixture
def not_a_pdf(tmp_dir):
    """A file that is not a PDF at all."""
    path = os.path.join(tmp_dir, "not_a_pdf.pdf")
    with open(path, "w") as f:
        f.write("This is not a PDF file.")
    return path


# ── Repair (Tier 1) ─────────────────────────────────────────────────────


class TestRepair:
    def test_repair_valid_pdf(self, sample_pdf, tmp_dir):
        """Repairing a valid PDF should succeed (no-op rewrite)."""
        out = os.path.join(tmp_dir, "repaired.pdf")
        result = repair(file=sample_pdf, output=out)
        assert result["pages"] == 5
        assert result["tier"] == "repair"
        assert os.path.isfile(out)
        assert result["repaired_size"] > 0
        # Verify the output is a valid PDF
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 5

    def test_repair_produces_readable_output(self, sample_pdf, tmp_dir):
        """Output of repair should be fully readable by pikepdf."""
        out = os.path.join(tmp_dir, "repaired.pdf")
        repair(file=sample_pdf, output=out)
        with pikepdf.open(out) as pdf:
            for page in pdf.pages:
                assert page.get("/MediaBox") is not None

    def test_repair_nonexistent_file(self, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(FileNotFoundError):
            repair(file="/nonexistent/file.pdf", output=out)

    def test_repair_in_place(self, tmp_pdf):
        """Repair with output == input (overwrite)."""
        result = repair(file=tmp_pdf, output=tmp_pdf)
        assert result["pages"] == 5
        with pikepdf.open(tmp_pdf) as pdf:
            assert len(pdf.pages) == 5


# ── Rebuild (Tier 2) ────────────────────────────────────────────────────


class TestRebuild:
    def test_rebuild_valid_pdf(self, sample_pdf, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "rebuilt.pdf")
        result = rebuild(file=sample_pdf, output=out, gs_path=gs_path)
        assert result["pages"] == 5
        assert result["tier"] == "rebuild"
        assert os.path.isfile(out)
        assert result["rebuilt_size"] > 0

    def test_rebuild_produces_readable_output(self, sample_pdf, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "rebuilt.pdf")
        rebuild(file=sample_pdf, output=out, gs_path=gs_path)
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 5
            for page in pdf.pages:
                assert page.get("/MediaBox") is not None

    def test_rebuild_nonexistent_file(self, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(FileNotFoundError):
            rebuild(file="/nonexistent/file.pdf", output=out, gs_path=gs_path)


# ── Recover (Tier 3) ────────────────────────────────────────────────────


class TestRecover:
    def test_recover_valid_pdf(self, sample_pdf, tmp_dir):
        """Recovering from a valid PDF should extract all pages."""
        out = os.path.join(tmp_dir, "recovered.pdf")
        result = recover(file=sample_pdf, output=out)
        assert result["recovered"] == 5
        assert result["lost"] == 0
        assert result["tier"] == "recover"
        assert os.path.isfile(out)

    def test_recover_produces_readable_output(self, sample_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "recovered.pdf")
        recover(file=sample_pdf, output=out)
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 5

    def test_recover_nonexistent_file(self, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(FileNotFoundError):
            recover(file="/nonexistent/file.pdf", output=out)

    def test_recover_reports_lost_pages(self, sample_pdf, tmp_dir):
        """Result includes lost_pages list (empty for a valid file)."""
        out = os.path.join(tmp_dir, "recovered.pdf")
        result = recover(file=sample_pdf, output=out)
        assert isinstance(result["lost_pages"], list)
        assert isinstance(result["recovered_pages"], list)
        assert result["recovered_pages"] == [1, 2, 3, 4, 5]

    def test_recover_not_a_pdf(self, not_a_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(RuntimeError):
            recover(file=not_a_pdf, output=out)


# ── Check (Validation) ──────────────────────────────────────────────────


class TestCheck:
    def test_check_valid_pdf(self, sample_pdf):
        result = check(file=sample_pdf)
        assert result["valid"] is True
        assert result["info"]["pages"] == 5
        assert result["summary"]["errors"] == 0
        assert result["summary"]["status"] == "ok"

    def test_check_returns_file_info(self, sample_pdf):
        result = check(file=sample_pdf)
        assert result["size_bytes"] > 0
        assert "pdf_version" in result["info"]
        assert "linearized" in result["info"]
        assert "encrypted" in result["info"]

    def test_check_nonexistent_file(self):
        with pytest.raises(FileNotFoundError):
            check(file="/nonexistent/file.pdf")

    def test_check_not_a_pdf(self, not_a_pdf):
        result = check(file=not_a_pdf)
        assert result["valid"] is False
        assert any(i["category"] == "header" for i in result["issues"])

    def test_check_font_info(self, sample_pdf):
        result = check(file=sample_pdf)
        assert "fonts_checked" in result["info"]
        assert "fonts_embedded" in result["info"]

    def test_check_encrypted_pdf(self, tmp_pdf, tmp_dir):
        """Encrypted PDFs should report encryption status."""
        from engine.encrypt import encrypt
        enc = os.path.join(tmp_dir, "encrypted.pdf")
        encrypt(file=tmp_pdf, output=enc, user_password="test123")
        result = check(file=enc)
        assert result["info"]["encrypted"] is True


# ── The font-embedding verdict ──────────────────────────────────────────


def _font_page(pdf, font_obj, name="/F1"):
    page = pdf.add_blank_page(page_size=(200, 200))
    page.obj["/Resources"] = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(**{name.lstrip("/"): font_obj})
    )
    return page


def _cid_font(pdf, embedded: bool):
    """A Type0 font whose DESCENDANT carries the descriptor — the shape whose
    top-level dict has no /FontDescriptor at all."""
    descriptor = pikepdf.Dictionary(
        Type=pikepdf.Name.FontDescriptor,
        FontName=pikepdf.Name("/Composite"),
        Flags=4,
    )
    if embedded:
        program = pdf.make_stream(b"\x00\x01\x00\x00")
        descriptor["/FontFile2"] = pdf.make_indirect(program)
    descendant = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font,
        Subtype=pikepdf.Name.CIDFontType2,
        BaseFont=pikepdf.Name("/Composite"),
        FontDescriptor=pdf.make_indirect(descriptor),
        CIDSystemInfo=pikepdf.Dictionary(
            Registry="Adobe", Ordering="Identity", Supplement=0
        ),
    ))
    return pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font,
        Subtype=pikepdf.Name.Type0,
        BaseFont=pikepdf.Name("/Composite"),
        Encoding=pikepdf.Name("/Identity-H"),
        DescendantFonts=pikepdf.Array([descendant]),
    ))


class TestCheckFontEmbedding:
    """A checker may not report an embedding pass it has not earned.

    The three failures pinned here were all live: a composite font counted as
    embedded because its descriptor is one level down, an unreadable font tree
    swallowed to a clean report, and a fixed scan cap presented as a total.
    """

    def test_a_non_embedded_composite_font_is_not_reported_embedded(self, tmp_dir):
        path = os.path.join(tmp_dir, "cid-bare.pdf")
        pdf = pikepdf.new()
        _font_page(pdf, _cid_font(pdf, embedded=False))
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_checked"] == 1
        assert result["info"]["fonts_embedded"] == 0
        assert result["info"]["fonts_not_embedded"] == 1
        assert any(
            i["category"] == "fonts" and "not embedded" in i["message"]
            for i in result["issues"]
        )

    def test_an_embedded_composite_font_is_reported_embedded(self, tmp_dir):
        path = os.path.join(tmp_dir, "cid-embedded.pdf")
        pdf = pikepdf.new()
        _font_page(pdf, _cid_font(pdf, embedded=True))
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_embedded"] == 1
        assert result["info"]["fonts_not_embedded"] == 0
        assert result["info"]["fonts_unreadable"] == 0
        assert not [i for i in result["issues"] if i["category"] == "fonts"]

    def test_a_font_with_no_descriptor_is_not_embedded(self, tmp_dir):
        """A standard face the document does not carry is a face the reader
        must already have. "No descriptor" is not evidence of a program."""
        path = os.path.join(tmp_dir, "standard.pdf")
        pdf = pikepdf.new()
        _font_page(pdf, pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name("/Helvetica"),
        )))
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_embedded"] == 0
        assert result["info"]["fonts_not_embedded"] == 1
        assert any("Helvetica" in i["message"] for i in result["issues"])

    def test_a_font_that_will_not_read_is_neither_answer(self, tmp_dir):
        path = os.path.join(tmp_dir, "unreadable.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200, 200))
        # An array where a font dictionary belongs: it answers no key, so
        # whether a program travels with it cannot be established.
        page.obj["/Resources"] = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F1=pikepdf.Array([1, 2, 3]))
        )
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_embedded"] == 0
        assert result["info"]["fonts_unreadable"] == 1
        assert any(
            i["category"] == "fonts" and "could not be read" in i["message"]
            for i in result["issues"]
        )

    def test_more_than_a_hundred_fonts_are_all_counted(self, tmp_dir):
        path = os.path.join(tmp_dir, "many-fonts.pdf")
        pdf = pikepdf.new()
        for i in range(120):
            _font_page(pdf, pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name.Font,
                Subtype=pikepdf.Name.Type1,
                BaseFont=pikepdf.Name(f"/Face{i:03d}"),
            )))
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_checked"] == 120
        assert result["info"]["fonts_not_embedded"] == 120

    def test_one_font_on_forty_pages_is_one_font(self, tmp_dir):
        path = os.path.join(tmp_dir, "shared-font.pdf")
        pdf = pikepdf.new()
        shared = _cid_font(pdf, embedded=True)
        for _ in range(40):
            _font_page(pdf, shared)
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_checked"] == 1
        assert result["info"]["fonts_embedded"] == 1


def _simple_font(pdf, name="Helvetica"):
    return pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font,
        Subtype=pikepdf.Name.Type1,
        BaseFont=pikepdf.Name("/" + name),
    ))


def _form_xobject(pdf, resources, body=b"BT /F1 12 Tf ET"):
    form = pdf.make_stream(body)
    form["/Type"] = pikepdf.Name.XObject
    form["/Subtype"] = pikepdf.Name.Form
    form["/BBox"] = pikepdf.Array([0, 0, 100, 100])
    form["/Resources"] = resources
    return pdf.make_indirect(form)


def _type3_font(pdf, char_procs):
    """A Type 3 font, with or without the glyph procedures 9.6.4 requires."""
    font = pikepdf.Dictionary(
        Type=pikepdf.Name.Font,
        Subtype=pikepdf.Name.Type3,
        FontBBox=pikepdf.Array([0, 0, 100, 100]),
        FontMatrix=pikepdf.Array([0.001, 0, 0, 0.001, 0, 0]),
        Encoding=pikepdf.Dictionary(
            Type=pikepdf.Name.Encoding,
            Differences=pikepdf.Array([97, pikepdf.Name("/square")]),
        ),
        FirstChar=97,
        LastChar=97,
        Widths=pikepdf.Array([100]),
    )
    if char_procs is not None:
        font["/CharProcs"] = char_procs
    return pdf.make_indirect(font)


class TestCheckReachesEveryFont:
    """The font total is the DOCUMENT's, not one resource dictionary's.

    Four routes reach a font that no page `/Resources /Font` names, and each
    of these documents was reported as carrying one font fewer than it does.
    """

    def test_a_font_only_a_form_xobject_names_is_counted(self, tmp_dir):
        path = os.path.join(tmp_dir, "form-only-font.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200, 200))
        form = _form_xobject(pdf, pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F1=_simple_font(pdf))
        ))
        page.obj["/Resources"] = pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Fm0=form)
        )
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_checked"] == 1
        assert result["info"]["fonts_not_embedded"] == 1
        assert any("Helvetica" in i["message"] for i in result["issues"])

    def test_a_font_only_a_type3_glyph_procedure_names_is_counted(self, tmp_dir):
        path = os.path.join(tmp_dir, "type3-nested-font.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200, 200))
        proc = pdf.make_stream(b"0 0 0 0 0 0 d1 BT /F1 8 Tf ET")
        proc["/Resources"] = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F1=_simple_font(pdf))
        )
        type3 = _type3_font(pdf, pikepdf.Dictionary(square=pdf.make_indirect(proc)))
        page.obj["/Resources"] = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(T3=type3)
        )
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_checked"] == 2
        assert result["info"]["fonts_embedded"] == 1
        assert result["info"]["fonts_not_embedded"] == 1
        assert any("Helvetica" in i["message"] for i in result["issues"])

    def test_a_font_only_an_annotation_appearance_names_is_counted(self, tmp_dir):
        path = os.path.join(tmp_dir, "annot-only-font.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200, 200))
        appearance = _form_xobject(
            pdf,
            pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=_simple_font(pdf))),
            body=b"BT /F1 12 Tf (x) Tj ET",
        )
        page.obj["/Resources"] = pikepdf.Dictionary()
        page.obj["/Annots"] = pikepdf.Array([pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.Annot,
            Subtype=pikepdf.Name.FreeText,
            Rect=pikepdf.Array([0, 0, 50, 20]),
            AP=pikepdf.Dictionary(N=appearance),
        ))])
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_checked"] == 1
        assert result["info"]["fonts_not_embedded"] == 1
        assert any("Helvetica" in i["message"] for i in result["issues"])

    def test_a_font_only_the_form_default_resources_name_is_counted(self, tmp_dir):
        path = os.path.join(tmp_dir, "acroform-only-font.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200, 200))
        page.obj["/Resources"] = pikepdf.Dictionary()
        pdf.Root["/AcroForm"] = pikepdf.Dictionary(
            Fields=pikepdf.Array([]),
            DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=_simple_font(pdf))),
        )
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_checked"] == 1
        assert result["info"]["fonts_not_embedded"] == 1
        assert any("Helvetica" in i["message"] for i in result["issues"])

    def test_one_font_reached_by_two_routes_is_one_font(self, tmp_dir):
        """The same indirect object named by a page and by the form's default
        resources is one font program, not two."""
        path = os.path.join(tmp_dir, "two-routes.pdf")
        pdf = pikepdf.new()
        shared = _simple_font(pdf)
        page = pdf.add_blank_page(page_size=(200, 200))
        page.obj["/Resources"] = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(F1=shared)
        )
        pdf.Root["/AcroForm"] = pikepdf.Dictionary(
            Fields=pikepdf.Array([]),
            DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=shared)),
        )
        pdf.save(path)
        pdf.close()

        assert check(file=path)["info"]["fonts_checked"] == 1


class TestCheckType3Policy:
    """A Type 3 font's glyph programs are content streams in the font itself
    (ISO 32000-2, 9.6.4), so the descriptor question does not apply to it and
    the checker answers it by the one shared rule."""

    def test_a_type3_with_glyph_procedures_is_embedded(self, tmp_dir):
        path = os.path.join(tmp_dir, "type3-drawn.pdf")
        pdf = pikepdf.new()
        proc = pdf.make_indirect(pdf.make_stream(b"0 0 0 0 0 0 d1"))
        page = pdf.add_blank_page(page_size=(200, 200))
        page.obj["/Resources"] = pikepdf.Dictionary(Font=pikepdf.Dictionary(
            T3=_type3_font(pdf, pikepdf.Dictionary(square=proc))
        ))
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_checked"] == 1
        assert result["info"]["fonts_embedded"] == 1
        assert result["info"]["fonts_unreadable"] == 0

    def test_a_type3_with_no_glyph_procedures_is_neither_answer(self, tmp_dir):
        """`/CharProcs` is required, and without it the font carries no glyph
        programs at all. Reporting it embedded claims programs that are
        provably absent; reporting it not embedded claims a face a reader
        could substitute, which no Type 3 has."""
        path = os.path.join(tmp_dir, "type3-empty.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(200, 200))
        page.obj["/Resources"] = pikepdf.Dictionary(Font=pikepdf.Dictionary(
            T3=_type3_font(pdf, None)
        ))
        pdf.save(path)
        pdf.close()

        result = check(file=path)
        assert result["info"]["fonts_checked"] == 1
        assert result["info"]["fonts_embedded"] == 0
        assert result["info"]["fonts_not_embedded"] == 0
        assert result["info"]["fonts_unreadable"] == 1


# ── Conformance-preserving rewrite ────────────────────────────────────────


def _xmp(part: int) -> bytes:
    return (
        b'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
        b'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<rdf:Description rdf:about="" '
        b'xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" '
        b'pdfaid:part="' + str(part).encode() + b'" pdfaid:conformance="B"/>'
        b"</rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    )


def _pdfa_source(path: str, part: int) -> None:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.Root["/Metadata"] = pdf.make_stream(_xmp(part))
    pdf.save(path, object_stream_mode=pikepdf.ObjectStreamMode.disable,
             force_version="1.4" if part == 1 else "1.7")
    pdf.close()


def _signed_source(path: str) -> None:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    value = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Sig,
        Filter=pikepdf.Name("/Adobe.PPKLite"),
        SubFilter=pikepdf.Name("/adbe.pkcs7.detached"),
        ByteRange=pikepdf.Array([0, 1022, 4862, 6654]),
        Contents=pikepdf.String("\x00" * 16),
    ))
    field = pdf.make_indirect(pikepdf.Dictionary(
        FT=pikepdf.Name.Sig,
        T=pikepdf.String("Signature1"),
        V=value,
        Type=pikepdf.Name.Annot,
        Subtype=pikepdf.Name.Widget,
        Rect=pikepdf.Array([0, 0, 100, 50]),
        P=page.obj,
        F=4,
    ))
    page.obj["/Annots"] = pikepdf.Array([field])
    pdf.Root["/AcroForm"] = pdf.make_indirect(pikepdf.Dictionary(
        Fields=pikepdf.Array([field]), SigFlags=3
    ))
    pdf.save(path)
    pdf.close()


class TestRepairConformance:
    """A rewrite must not silently trade the input's declared conformance for
    a smaller file. PDF/A-1 is a PDF 1.4 profile: object streams and the
    cross-reference stream they force do not exist below PDF 1.5."""

    def test_pdfa1_keeps_classic_xref_and_header(self, tmp_dir):
        src = os.path.join(tmp_dir, "pdfa1.pdf")
        out = os.path.join(tmp_dir, "pdfa1-out.pdf")
        _pdfa_source(src, 1)

        repair(file=src, output=out)

        data = open(out, "rb").read()
        assert data.startswith(b"%PDF-1.4")
        assert b"/ObjStm" not in data
        assert b"/Type /XRef" not in data and b"/Type/XRef" not in data
        assert b"\nxref" in data or data.startswith(b"xref")
        assert b'pdfaid:part="1"' in data

    def test_pdfa1_claim_forces_the_mode_at_the_save_seam(self, tmp_dir):
        from engine.pdf_save import declared_pdfa_part, save_pdf

        src = os.path.join(tmp_dir, "pdfa1-seam.pdf")
        out = os.path.join(tmp_dir, "pdfa1-seam-out.pdf")
        _pdfa_source(src, 1)
        with pikepdf.open(src) as pdf:
            assert declared_pdfa_part(pdf) == 1
            save_pdf(pdf, out,
                     object_stream_mode=pikepdf.ObjectStreamMode.generate)
        assert b"/ObjStm" not in open(out, "rb").read()

    def test_pdfa2_may_use_object_streams(self, tmp_dir):
        from engine.pdf_save import declared_pdfa_part, save_pdf

        src = os.path.join(tmp_dir, "pdfa2.pdf")
        out = os.path.join(tmp_dir, "pdfa2-out.pdf")
        _pdfa_source(src, 2)
        with pikepdf.open(src) as pdf:
            assert declared_pdfa_part(pdf) == 2
            save_pdf(pdf, out,
                     object_stream_mode=pikepdf.ObjectStreamMode.generate)
        assert b"/ObjStm" in open(out, "rb").read()

    @pytest.mark.parametrize("encoding, bom", [
        ("utf-16-le", b"\xff\xfe"),
        ("utf-16-be", b"\xfe\xff"),
    ])
    def test_a_utf16_pdfa1_claim_is_read_through_the_save(self, tmp_dir, encoding, bom):
        """ISO 16684-1 admits UTF-16 for an XMP packet. A byte scan for an
        ASCII `pdfaid:part` finds nothing in one, which reads exactly like a
        document that never claimed PDF/A — and the save then generates the
        object streams a PDF/A-1 file may not carry."""
        from engine.pdf_save import declared_pdfa_part, save_pdf

        src = os.path.join(tmp_dir, f"pdfa1-{encoding}.pdf")
        out = os.path.join(tmp_dir, f"pdfa1-{encoding}-out.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(200, 200))
        pdf.Root["/Metadata"] = pdf.make_stream(
            bom + _xmp(1).decode("ascii").encode(encoding)
        )
        pdf.save(src, object_stream_mode=pikepdf.ObjectStreamMode.disable,
                 force_version="1.4")
        pdf.close()

        with pikepdf.open(src) as opened:
            assert declared_pdfa_part(opened) == 1
            save_pdf(opened, out,
                     object_stream_mode=pikepdf.ObjectStreamMode.generate)
        data = open(out, "rb").read()
        assert b"/ObjStm" not in data
        assert b"/Type /XRef" not in data and b"/Type/XRef" not in data

    def test_metadata_that_cannot_be_read_fails_safe(self, tmp_dir):
        """A claim that cannot be reasoned about is not the absence of one."""
        from engine.pdf_save import UNREADABLE, pdfa_claim, save_pdf

        out = os.path.join(tmp_dir, "garbled-out.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(200, 200))
        # A UTF-16 byte order mark over bytes that are not UTF-16: no encoding
        # reading of this packet reaches a verdict.
        pdf.Root["/Metadata"] = pdf.make_stream(b"\xff\xfe<x:xmpmeta")
        assert pdfa_claim(pdf) is UNREADABLE
        save_pdf(pdf, out, object_stream_mode=pikepdf.ObjectStreamMode.generate)
        pdf.close()
        assert b"/ObjStm" not in open(out, "rb").read()

    def test_a_document_with_no_metadata_still_uses_object_streams(self, tmp_dir):
        """The fail-safe reaches unreadable metadata, never absent metadata."""
        from engine.pdf_save import ABSENT, pdfa_claim, save_pdf

        src = os.path.join(tmp_dir, "plain.pdf")
        out = os.path.join(tmp_dir, "plain-out.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(200, 200))
        pdf.save(src)
        pdf.close()

        with pikepdf.open(src) as opened:
            assert pdfa_claim(opened) is ABSENT
            save_pdf(opened, out,
                     object_stream_mode=pikepdf.ObjectStreamMode.generate)
        assert b"/ObjStm" in open(out, "rb").read()


class TestRepairSignedDocument:
    """A whole-file rewrite renumbers every object, so a carried /ByteRange
    no longer spans the bytes its digest was computed over (ISO 32000-2
    12.8.1). The signature is removed and the removal reported."""

    def test_rewrite_removes_the_invalidated_signature(self, tmp_dir):
        src = os.path.join(tmp_dir, "signed.pdf")
        out = os.path.join(tmp_dir, "signed-out.pdf")
        _signed_source(src)

        result = repair(file=src, output=out)

        assert result["signatures_removed"] == 1
        assert any("signature" in row.lower() for row in result["issues_found"])
        data = open(out, "rb").read()
        assert b"/ByteRange" not in data
        assert b"/SigFlags" not in data
        with pikepdf.open(out) as pdf:
            assert pdf.Root.get("/AcroForm") is None
            assert len(pdf.pages[0].get("/Annots") or []) == 0

    def test_an_unsigned_document_is_untouched(self, tmp_dir, sample_pdf):
        out = os.path.join(tmp_dir, "plain-out.pdf")
        result = repair(file=sample_pdf, output=out)
        assert result["signatures_removed"] == 0
