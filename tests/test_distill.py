"""Tests for PostScript/EPS → PDF distilling (Phase 8). gs-gated like
every Ghostscript-backed op (the conftest `gs_path` fixture skips when
`resources/ghostscript` is unprovisioned — a recorded gate count must
come from a run WITHOUT skips, per the punchlist dev-notes rule)."""

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
(Distilled by Open PDF Studio) show
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

    # ── review round 12 pins ─────────────────────────────────────────────

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
