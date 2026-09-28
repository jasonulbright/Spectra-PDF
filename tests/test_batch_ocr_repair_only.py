"""Batch OCR repair-only mode: repair every file, recognise nothing."""

import os
import re

import pikepdf
import pytest

from engine.batch_ocr import batch_ocr
from engine.repair import repair


def _clean_pdf(path, pages=2):
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path)
    pdf.close()
    return path


def _damaged_pdf(path, pages=2):
    """A PDF whose startxref points at the wrong offset."""
    _clean_pdf(path, pages)
    data = open(path, "rb").read()
    data = re.sub(rb"startxref\s+\d+", b"startxref\n12", data)
    open(path, "wb").write(data)
    return path


def _tree(tmp_path):
    src = tmp_path / "in"
    (src / "sub").mkdir(parents=True)
    _damaged_pdf(str(src / "sub" / "bad.pdf"))
    _clean_pdf(str(src / "fine.pdf"))
    (src / "junk.pdf").write_bytes(b"not a pdf at all")
    return src


def test_repair_reports_damage_only_for_structural_problems(tmp_path):
    clean = _clean_pdf(str(tmp_path / "clean.pdf"))
    bad = _damaged_pdf(str(tmp_path / "bad.pdf"))
    assert repair(clean, str(tmp_path / "c.out.pdf"))["damaged"] is False
    report = repair(bad, str(tmp_path / "b.out.pdf"))
    assert report["damaged"] is True
    assert report["damage"]


def test_mirror_run_repairs_copies_and_skips(tmp_path):
    src = _tree(tmp_path)
    dest = tmp_path / "out"
    fine_bytes = (src / "fine.pdf").read_bytes()
    report = batch_ocr(str(src), str(dest), repair_only=True, log_dir=str(tmp_path / "logs"))
    by_rel = {r["rel"]: r for r in report["results"]}

    bad = by_rel[os.path.join("sub", "bad.pdf")]
    assert bad["status"] == "repaired" and bad["repaired"] is True
    assert bad["repairFixes"] >= 1
    with pikepdf.open(dest / "sub" / "bad.pdf") as out:
        assert len(out.pages) == 2

    assert by_rel["fine.pdf"] == {"rel": "fine.pdf", "status": "copied", "reason": "no repair needed"}
    assert (dest / "fine.pdf").read_bytes() == fine_bytes

    assert by_rel["junk.pdf"]["status"] == "skipped"
    assert by_rel["junk.pdf"]["reason"].startswith("repair failed: ")
    assert not (dest / "junk.pdf").exists()

    # Scratch files never survive into the mirror.
    assert not [p for p in dest.rglob("*.tmp")]

    log = open(report["logPath"], encoding="utf-8").read()
    assert "Mode:         repair only (no OCR)" in log
    assert "Languages:    not used (repair only)" in log
    assert "Files: 3 processed — 1 repaired · 1 no repair needed · 1 skipped" in log
    assert "made searchable" not in log
    assert re.search(r"\[repaired\] sub.bad\.pdf — \d+ problems? fixed", log)
    assert "[copied]  fine.pdf — no repair needed" in log


def test_in_place_run_replaces_only_damaged_originals(tmp_path):
    src = _tree(tmp_path)
    fine_bytes = (src / "fine.pdf").read_bytes()
    bad_before = (src / "sub" / "bad.pdf").read_bytes()
    report = batch_ocr(str(src), in_place=True, repair_only=True)
    by_rel = {r["rel"]: r for r in report["results"]}

    assert by_rel[os.path.join("sub", "bad.pdf")]["status"] == "repaired"
    assert (src / "sub" / "bad.pdf").read_bytes() != bad_before
    with pikepdf.open(src / "sub" / "bad.pdf") as out:
        assert not out.get_warnings()
    assert by_rel["fine.pdf"]["reason"] == "no repair needed -- unchanged"
    assert (src / "fine.pdf").read_bytes() == fine_bytes
    assert not [p for p in src.rglob("*.tmp")]


def test_filing_and_replace_in_a_mirror_run(tmp_path):
    src = _tree(tmp_path)
    dest, moved, errors = tmp_path / "out", tmp_path / "done", tmp_path / "failed"
    report = batch_ocr(
        str(src), str(dest), repair_only=True, replace_repaired_originals=True,
        moved_root=str(moved), error_root=str(errors),
    )
    by_rel = {r["rel"]: r for r in report["results"]}
    bad = by_rel[os.path.join("sub", "bad.pdf")]
    assert bad["repairedOriginalReplaced"] is True
    assert "repairedOriginalReplaced" not in by_rel["fine.pdf"]
    assert (moved / "sub" / "bad.pdf").exists()
    assert (moved / "fine.pdf").exists()
    assert (errors / "junk.pdf").exists()
    with pikepdf.open(moved / "sub" / "bad.pdf") as healed:
        assert len(healed.pages) == 2


@pytest.mark.parametrize("option", ["mrc", "enhance", "include_images"])
def test_recognition_only_options_are_refused(tmp_path, option):
    src = _tree(tmp_path)
    with pytest.raises(ValueError, match="Repair-only mode runs no OCR"):
        batch_ocr(str(src), str(tmp_path / "out"), repair_only=True, **{option: True})


def test_benign_qpdf_warnings_are_not_damage():
    from engine.repair import _is_damage

    assert not _is_damage(
        "f.pdf: xref entry for the xref stream itself is missing - a common error "
        "handled correctly by qpdf and most other applications"
    )
    assert not _is_damage("f.pdf (offset 11720): input stream is complete but output may still be valid")
    assert _is_damage("f.pdf (offset 999999): xref not found")


def test_removed_signatures_are_reported(tmp_path, monkeypatch):
    import engine.batch_ocr as batch_mod

    real = batch_mod.repair

    def signed_repair(src, out):
        report = real(src, out)
        report["signatures_removed"] = 2 if report["damaged"] else 0
        return report

    monkeypatch.setattr(batch_mod, "repair", signed_repair)
    src = _tree(tmp_path)
    report = batch_ocr(str(src), str(tmp_path / "out"), repair_only=True, log_dir=str(tmp_path / "logs"))
    by_rel = {r["rel"]: r for r in report["results"]}
    assert by_rel[os.path.join("sub", "bad.pdf")]["signaturesRemoved"] == 2
    assert "signaturesRemoved" not in by_rel["fine.pdf"]
    log = open(report["logPath"], encoding="utf-8").read()
    assert re.search(r"\[repaired\] sub.bad\.pdf — \d+ problems? fixed; 2 signatures removed", log)


def test_moved_original_is_the_healed_file_when_replace_is_on(tmp_path):
    """Same order as the OCR run's repair path: heal the original, then file it."""
    src = _tree(tmp_path)
    moved = tmp_path / "done"
    batch_ocr(str(src), str(tmp_path / "out"), repair_only=True,
              replace_repaired_originals=True, moved_root=str(moved))
    with pikepdf.open(moved / "sub" / "bad.pdf") as healed:
        assert not healed.get_warnings()
