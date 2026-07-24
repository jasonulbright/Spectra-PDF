"""O1 — export a PDF to editable Office / web formats via LibreOffice."""

import os
import re
import zipfile
from pathlib import Path

import pikepdf
import pytest

from engine.office_export import export_document, supported_formats


def _text_pdf(path: str) -> None:
    """A born-digital PDF with two known sentences of real text."""
    pdf = pikepdf.new()
    pg = pdf.add_blank_page(page_size=(612, 792))
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    pg.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    pg.Contents = pdf.make_stream(
        b"BT /F1 18 Tf 72 720 Td (The quick brown fox jumps over the lazy dog.) Tj "
        b"0 -22 Td (Second paragraph of editable body text here.) Tj ET"
    )
    pdf.save(path)
    pdf.close()


def test_supported_formats_lists_the_targets():
    fmts = supported_formats()["formats"]
    assert set(fmts) >= {"docx", "rtf", "odt", "html", "xhtml"}


def test_rejects_an_unknown_format(tmp_dir, soffice_path):
    src = os.path.join(tmp_dir, "s.pdf")
    _text_pdf(src)
    with pytest.raises(ValueError, match="unsupported export format"):
        export_document(src, os.path.join(tmp_dir, "o.pages"), "pages", soffice_path)


def test_rejects_a_missing_input(tmp_dir, soffice_path):
    with pytest.raises(ValueError, match="input file not found"):
        export_document(os.path.join(tmp_dir, "nope.pdf"), os.path.join(tmp_dir, "o.docx"), "docx", soffice_path)


def test_rejects_no_soffice(tmp_dir):
    src = os.path.join(tmp_dir, "s.pdf")
    _text_pdf(src)
    with pytest.raises(RuntimeError, match="not available"):
        export_document(src, os.path.join(tmp_dir, "o.docx"), "docx", "")


def test_html_export_carries_the_real_text(tmp_dir, soffice_path):
    src = os.path.join(tmp_dir, "s.pdf")
    out = os.path.join(tmp_dir, "out.html")
    _text_pdf(src)
    r = export_document(src, out, "html", soffice_path)
    assert r["format"] == "html"
    assert os.path.isfile(out)
    body = open(out, encoding="utf-8", errors="replace").read()
    assert "quick brown fox" in body


def test_docx_bridge_produces_editable_word_runs(tmp_dir, soffice_path):
    src = os.path.join(tmp_dir, "s.pdf")
    out = os.path.join(tmp_dir, "out.docx")
    _text_pdf(src)
    r = export_document(src, out, "docx", soffice_path)
    assert r["size"] > 0
    # A real .docx (OOXML zip) with the sentences as editable <w:t> runs — NOT a
    # single page image. This is what makes the LibreOffice route worth its size.
    with zipfile.ZipFile(out) as z:
        doc = z.read("word/document.xml").decode("utf-8", "replace")
    runs = re.findall(r"<w:t[^>]*>([^<]+)</w:t>", doc)
    joined = " ".join(runs)
    assert "quick brown fox" in joined
    assert "Second paragraph" in joined


def test_rtf_bridge(tmp_dir, soffice_path):
    src = os.path.join(tmp_dir, "s.pdf")
    out = os.path.join(tmp_dir, "out.rtf")
    _text_pdf(src)
    export_document(src, out, "rtf", soffice_path)
    body = open(out, encoding="latin-1", errors="replace").read()
    assert body.lstrip().startswith("{\\rtf")


def test_same_file_guard(tmp_dir, soffice_path):
    src = os.path.join(tmp_dir, "s.pdf")
    _text_pdf(src)
    with pytest.raises(ValueError, match="same file"):
        export_document(src, src, "docx", soffice_path)


def test_rejects_a_directory_destination(tmp_dir):
    # Review-caught: shutil.move into an existing directory drops the file
    # INSIDE it under the wrong stem while reporting the directory as the output
    # (a silent misplace + false success). The guard is pre-soffice, so no
    # LibreOffice is needed to exercise it.
    src = os.path.join(tmp_dir, "s.pdf")
    _text_pdf(src)
    outdir = os.path.join(tmp_dir, "exports")
    os.makedirs(outdir)
    with pytest.raises(ValueError, match="is a directory"):
        export_document(src, outdir, "docx", "any-soffice-path")


def test_timeout_kills_the_process_tree_and_frees_the_profile(tmp_dir, monkeypatch):
    # A hung soffice must not orphan its worker + lock its profile dir. Drive
    # _run_soffice with a fake "soffice" that never exits and a 0s budget: the
    # timeout path must taskkill the tree and raise, and the finally must remove
    # the profile directory (rmtree can't succeed while a child holds it open,
    # so this also proves the tree-kill ran).
    import engine.office_export as oe

    profiles: list[str] = []
    real_mkdtemp = oe.tempfile.mkdtemp

    def spy_mkdtemp(*a, **k):
        d = real_mkdtemp(*a, **k)
        if k.get("prefix", "").startswith("lo-profile"):
            profiles.append(d)
        return d

    killed: list[int] = []
    real_kill = oe._kill_tree

    def spy_kill(pid):
        killed.append(pid)
        real_kill(pid)  # actually terminate the tree so communicate() returns

    monkeypatch.setattr(oe.tempfile, "mkdtemp", spy_mkdtemp)
    monkeypatch.setattr(oe, "_TIMEOUT", 0)
    monkeypatch.setattr(oe, "_kill_tree", spy_kill)

    src = Path(os.path.join(tmp_dir, "s.pdf"))
    _text_pdf(str(src))
    work = Path(os.path.join(tmp_dir, "work"))
    work.mkdir()
    # A trivial always-available "hangs forever" stand-in for soffice — swap the
    # command for a python child that sleeps past the (0s) budget. Capture the
    # REAL Popen first so the fake doesn't recurse into itself.
    import sys
    real_popen = oe.subprocess.Popen
    monkeypatch.setattr(
        oe.subprocess, "Popen",
        lambda cmd, **k: real_popen([sys.executable, "-c", "import time; time.sleep(30)"], **k),
    )

    with pytest.raises(RuntimeError, match="timed out"):
        oe._run_soffice(sys.executable, "html", src, work, ".html")

    assert killed, "the process tree was not killed on timeout"
    assert profiles and not os.path.exists(profiles[-1]), "the profile dir leaked"
