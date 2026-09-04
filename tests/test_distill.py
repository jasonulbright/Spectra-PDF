"""Tests for PostScript/EPS → PDF distilling.

The capability-PRESENT axis, like every Ghostscript-backed op: the conftest
`gs_path` fixture skips when the AUTHORITY (`engine.gs_capability`) finds no
usable Ghostscript on the machine. Nothing in the distribution provides one,
so the question is never whether a directory was vendored — a recorded gate
count must come from a run WITHOUT skips. The absent axis for this door is a
roster row in `test_gs_absent.py`."""

import os

import pikepdf
import pytest

from engine.distill import distill

# A minimal but real one-page PostScript program: text + a vector stroke.
PS_FIXTURE = b"""%!PS-Adobe-3.0
%%Pages: 1
%%Page: 1 1
/Helvetica findfont 24 scalefont setfont
72 700 moveto
(Distilled by Spectra PDF) show
newpath 72 680 moveto 400 680 lineto 2 setlinewidth stroke
showpage
%%EOF
"""

# EPS: the page must become the bounding box, not letter paper.
EPS_FIXTURE = b"""%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 200 100
newpath 10 10 moveto 190 90 lineto 4 setlinewidth stroke
showpage
%%EOF
"""


def _write(tmp_dir, name, data):
    path = os.path.join(tmp_dir, name)
    with open(path, "wb") as f:
        f.write(data)
    return path


class TestDistill:
    def test_ps_distills_to_a_valid_one_page_pdf(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "doc.ps", PS_FIXTURE)
        out = os.path.join(tmp_dir, "doc.pdf")
        r = distill(src, out, gs_path=gs_path)
        assert r["pages"] == 1
        assert r["eps"] is False
        assert r["output_size"] > 0
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 1

    @pytest.mark.parametrize("preset", ["screen", "ebook", "printer", "prepress", "default"])
    def test_every_preset_produces_a_valid_pdf(self, tmp_dir, gs_path, preset):
        src = _write(tmp_dir, "doc.ps", PS_FIXTURE)
        out = os.path.join(tmp_dir, f"doc-{preset}.pdf")
        r = distill(src, out, preset=preset, gs_path=gs_path)
        assert r["pages"] == 1
        assert r["preset"] == preset

    def test_eps_page_is_the_bounding_box(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "figure.eps", EPS_FIXTURE)
        out = os.path.join(tmp_dir, "figure.pdf")
        r = distill(src, out, gs_path=gs_path)
        assert r["eps"] is True
        with pikepdf.open(out) as pdf:
            box = [float(v) for v in pdf.pages[0].mediabox]
            assert box[2] - box[0] == pytest.approx(200, abs=1)
            assert box[3] - box[1] == pytest.approx(100, abs=1)

    def test_pdf_input_refuses_with_the_repair_pointer(self, tmp_dir, gs_path):
        src = os.path.join(tmp_dir, "already.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="already a PDF"):
            distill(src, out, gs_path=gs_path)

    def test_non_postscript_refuses_with_named_reason(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "junk.ps", b"this is not postscript at all")
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="%!"):
            distill(src, out, gs_path=gs_path)

    def test_broken_postscript_surfaces_gs_diagnostics(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "broken.ps", b"%!PS-Adobe-3.0\nthisisnotanoperator\nshowpage\n")
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(RuntimeError, match="Ghostscript"):
            distill(src, out, gs_path=gs_path)

    def test_unknown_preset_refuses(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "doc.ps", PS_FIXTURE)
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="unknown preset"):
            distill(src, out, preset="bogus", gs_path=gs_path)

    def test_overwrites_an_existing_output(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "doc.ps", PS_FIXTURE)
        out = _write(tmp_dir, "out.pdf", b"stale bytes")
        r = distill(src, out, gs_path=gs_path)
        assert r["pages"] == 1
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 1

    def test_missing_input_refuses(self, tmp_dir, gs_path):
        with pytest.raises(ValueError, match="not found"):
            distill(os.path.join(tmp_dir, "ghost.ps"), os.path.join(tmp_dir, "o.pdf"), gs_path=gs_path)

    # ── Additional pins ─────────────────────────────────────────────

    def test_percent_in_output_name_is_literal(self, tmp_dir, gs_path):
        # '%d' in -sOutputFile is a per-page TEMPLATE: unescaped, gs wrote
        # 'report 1 2024.pdf' and the requested name never existed
        # (review-reproduced via the dialog's own default naming).
        src = _write(tmp_dir, "report %d 2024.ps", PS_FIXTURE)
        out = os.path.join(tmp_dir, "report %d 2024.pdf")
        r = distill(src, out, gs_path=gs_path)
        assert r["pages"] == 1
        assert os.path.isfile(out)
        assert not os.path.isfile(os.path.join(tmp_dir, "report 1 2024.pdf"))

    def test_same_file_output_refuses(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "doc.ps", PS_FIXTURE)
        with pytest.raises(ValueError, match="different file"):
            distill(src, src, gs_path=gs_path)
        # The source survives untouched.
        with open(src, "rb") as f:
            assert f.read(2) == b"%!"

    def test_dash_leading_relative_input_still_converts(self, tmp_dir, gs_path):
        # Unresolved, `-r.ps` parses as a gs SWITCH (silently blank output
        # in the -d/-s cases — review-reproduced); resolution makes the
        # argv token absolute.
        cwd = os.getcwd()
        os.chdir(tmp_dir)
        try:
            _write(tmp_dir, "-r.ps", PS_FIXTURE)
            r = distill("-r.ps", os.path.join(tmp_dir, "dash.pdf"), gs_path=gs_path)
            assert r["pages"] == 1
        finally:
            os.chdir(cwd)

    def test_stdin_reading_postscript_cannot_hang_or_steal(self, tmp_dir, gs_path):
        # gs runs with stdin=DEVNULL: a PS program that reads %stdin gets
        # immediate EOF instead of the engine's RPC pipe (review-PROVEN
        # exfiltration without the isolation). The program then errors —
        # the point is it returns promptly and touches nothing.
        hostile = (
            b"%!PS-Adobe-3.0\n"
            b"/instr (%stdin) (r) file def\n"
            b"/buf 200 string def\n"
            b"instr buf readline\n"
            b"pop pop\n"
            b"thisisnotanoperator\n"
        )
        src = _write(tmp_dir, "hostile.ps", hostile)
        out = os.path.join(tmp_dir, "hostile.pdf")
        with pytest.raises(RuntimeError, match="Ghostscript"):
            distill(src, out, gs_path=gs_path)


# Form-field pdfmarks. gs lands the /ANN Widget
# annotations with field keys intact but never writes /AcroForm — the
# distill op ADOPTS them (engine/acroform.adopt_orphan_widget_fields).
FORMS_PS_FIXTURE = b"""%!PS-Adobe-3.0
/pdfmark where { pop } { userdict /pdfmark /cleartomark load put } ifelse
/Helvetica findfont 14 scalefont setfont
72 700 moveto (Form probe) show
[ /Rect [72 600 300 630] /Subtype /Widget /T (name-field) /FT /Tx
  /V (typed in PostScript) /DA (/Helv 0 Tf 0 g) /F 4 /ANN pdfmark
[ /Rect [72 540 92 560] /Subtype /Widget /T (agree) /FT /Btn
  /V /Off /AS /Off /F 4 /ANN pdfmark
showpage
%%EOF
"""


class TestDistillForms:
    def test_pdfmark_fields_adopt_and_fill(self, tmp_dir, gs_path):
        from engine.forms import fill_form_fields, read_form_fields

        src = _write(tmp_dir, "form.ps", FORMS_PS_FIXTURE)
        out = os.path.join(tmp_dir, "form.pdf")
        r = distill(src, out, gs_path=gs_path)
        assert r["form_fields_adopted"] == 2
        with pikepdf.open(out) as pdf:
            acro = pdf.Root["/AcroForm"]
            assert len(acro["/Fields"]) == 2
            assert acro.get("/NeedAppearances") == True  # noqa: E712 — pikepdf bool
        by_name = {f["name"]: f for f in read_form_fields(out)["fields"]}
        assert by_name["name-field"]["value"] == "typed in PostScript"
        assert by_name["agree"]["type"] == "checkbox"
        # The adopted form is a REAL form: a fill round-trips.
        filled = os.path.join(tmp_dir, "filled.pdf")
        fill_form_fields(out, filled, {"name-field": "edited after distill"})
        refreshed = {f["name"]: f for f in read_form_fields(filled)["fields"]}
        assert refreshed["name-field"]["value"] == "edited after distill"

    def test_formless_ps_gains_no_acroform(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "plain.ps", PS_FIXTURE)
        out = os.path.join(tmp_dir, "plain.pdf")
        r = distill(src, out, gs_path=gs_path)
        assert "form_fields_adopted" not in r
        with pikepdf.open(out) as pdf:
            assert pdf.Root.get("/AcroForm") is None


# The Windows spooler wraps a job in a PJL envelope: UEL, control lines, a
# language declaration, then the payload. The reporter's capture (issue #27)
# is this exact shape, CRLF-terminated.
UEL = b"\x1b%-12345X"
SPOOL_PROLOGUE = UEL + b"@PJL COMMENT MSxpsPS\r\n@PJL ENTER LANGUAGE=POSTSCRIPT\r\n"
SPOOL_TRAILER = UEL + b"@PJL EOJ\r\n" + UEL


class TestPjlEnvelope:
    def test_spooled_job_with_the_reporter_header_distills(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "spool.ps", SPOOL_PROLOGUE + PS_FIXTURE)
        out = os.path.join(tmp_dir, "spool.pdf")
        r = distill(src, out, gs_path=gs_path)
        assert r["pages"] == 1
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 1

    def test_trailing_uel_and_eoj_are_stripped(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "job.ps", SPOOL_PROLOGUE + PS_FIXTURE + SPOOL_TRAILER)
        out = os.path.join(tmp_dir, "job.pdf")
        assert distill(src, out, gs_path=gs_path)["pages"] == 1

    def test_lf_line_endings_in_the_envelope_distill(self, tmp_dir, gs_path):
        prologue = UEL + b"@PJL SET RESOLUTION=600\n@PJL ENTER LANGUAGE = POSTSCRIPT\n"
        src = _write(tmp_dir, "lf.ps", prologue + PS_FIXTURE)
        out = os.path.join(tmp_dir, "lf.pdf")
        assert distill(src, out, gs_path=gs_path)["pages"] == 1

    def test_repeated_uel_before_the_payload_distills(self, tmp_dir, gs_path):
        prologue = UEL + b"\r\n" + UEL + b"@PJL ENTER LANGUAGE=POSTSCRIPT\r\n"
        src = _write(tmp_dir, "twice.ps", prologue + PS_FIXTURE)
        out = os.path.join(tmp_dir, "twice.pdf")
        assert distill(src, out, gs_path=gs_path)["pages"] == 1

    def test_input_size_reports_the_whole_job(self, tmp_dir, gs_path):
        data = SPOOL_PROLOGUE + PS_FIXTURE + SPOOL_TRAILER
        src = _write(tmp_dir, "sized.ps", data)
        out = os.path.join(tmp_dir, "sized.pdf")
        assert distill(src, out, gs_path=gs_path)["input_size"] == len(data)

    def test_pjl_wrapped_pcl_refuses_naming_pcl(self, tmp_dir, gs_path):
        job = UEL + b"@PJL ENTER LANGUAGE=PCL\r\n" + b"\x1bE\x1b&l0O printer bytes"
        src = _write(tmp_dir, "pcl.ps", job)
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match=r"LANGUAGE=PCL"):
            distill(src, out, gs_path=gs_path)

    def test_pjl_wrapped_xps_package_refuses_by_name(self, tmp_dir, gs_path):
        job = UEL + b"@PJL ENTER LANGUAGE=XPS\r\n" + b"PK\x03\x04rest of the zip"
        src = _write(tmp_dir, "xps.ps", job)
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match=r"LANGUAGE=XPS"):
            distill(src, out, gs_path=gs_path)

    def test_zip_payload_under_a_postscript_declaration_refuses_as_a_package(
        self, tmp_dir, gs_path
    ):
        job = SPOOL_PROLOGUE + b"PK\x03\x04rest of the zip"
        src = _write(tmp_dir, "mislabelled.ps", job)
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match=r"ZIP/XPS package"):
            distill(src, out, gs_path=gs_path)

    def test_envelope_with_no_payload_refuses(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "hollow.ps", SPOOL_PROLOGUE)
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match=r"no payload"):
            distill(src, out, gs_path=gs_path)

    def test_empty_file_refuses_as_empty(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "empty.ps", b"")
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match=r"the file is empty"):
            distill(src, out, gs_path=gs_path)

    def test_wrapped_pdf_still_points_at_repair(self, tmp_dir, gs_path):
        src = _write(tmp_dir, "wrapped.ps", SPOOL_PROLOGUE + b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="already a PDF"):
            distill(src, out, gs_path=gs_path)


class TestPjlParsing:
    """The envelope grammar, exercised without Ghostscript."""

    def test_no_envelope_leaves_the_payload_at_byte_zero(self):
        from engine.distill import _parse_pjl_prologue

        assert _parse_pjl_prologue(PS_FIXTURE) == (0, None)

    def test_language_is_captured_across_spacing_and_case(self):
        from engine.distill import _parse_pjl_prologue

        offset, lang = _parse_pjl_prologue(
            UEL + b"@PJL enter language = PostScript\r\n%!PS"
        )
        assert lang == "PostScript"
        assert offset == len(UEL) + len(b"@PJL enter language = PostScript\r\n")

    def test_an_unterminated_envelope_reports_no_payload(self):
        from engine.distill import _parse_pjl_prologue

        assert _parse_pjl_prologue(UEL + b"@PJL ENTER LANGUAGE=POSTSCRIPT")[0] == 0

    def test_trailer_start_cuts_only_a_pure_control_tail(self):
        from engine.distill import _pjl_trailer_start

        body = b"%!PS\nshowpage\n"
        assert _pjl_trailer_start(body + SPOOL_TRAILER, 0) == len(body)

    def test_a_uel_followed_by_job_bytes_is_not_a_trailer(self):
        from engine.distill import _pjl_trailer_start

        data = b"%!PS\n" + UEL + b"more postscript\n"
        assert _pjl_trailer_start(data, 0) == len(data)

    def test_no_trailer_leaves_the_file_whole(self):
        from engine.distill import _pjl_trailer_start

        assert _pjl_trailer_start(PS_FIXTURE, 0) == len(PS_FIXTURE)
