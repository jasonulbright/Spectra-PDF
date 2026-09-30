"""Publishing a finished file produced elsewhere over an existing output.

The converter families (LibreOffice import/export, slide export, batch OCR
mirror copies and repaired-original replacement) produce their result in a
scratch directory. Landing it with a copy INTO the destination truncates the
previous file first, so a death or a full disk part-way leaves a torn file
where a good one was. The file identity reads the difference: a
directory-entry swap gives the name a new file object.
"""

import os
import sys
from pathlib import Path

import pikepdf
import pytest

from engine import inplace, soffice


def _pdf(path: Path, pages: int) -> bytes:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page()
    pdf.save(path)
    pdf.close()
    return path.read_bytes()


def _identity(path: Path) -> tuple:
    info = os.stat(path)
    return info.st_dev, info.st_ino


def test_a_published_copy_swaps_the_directory_entry(tmp_path):
    out = tmp_path / "out.pdf"
    _pdf(out, 1)
    identity = _identity(out)
    produced = tmp_path / "work" / "new.pdf"
    produced.parent.mkdir()
    fresh = _pdf(produced, 2)
    inplace.publish_copy(produced, out)
    assert out.read_bytes() == fresh
    assert _identity(out) != identity
    assert sorted(p.name for p in tmp_path.iterdir()) == ["out.pdf", "work"]


def test_a_published_copy_refuses_a_hard_linked_output(tmp_path):
    out = tmp_path / "out.pdf"
    prior = _pdf(out, 1)
    alias = tmp_path / "alias.pdf"
    os.link(out, alias)
    produced = tmp_path / "work" / "new.pdf"
    produced.parent.mkdir()
    _pdf(produced, 2)
    with pytest.raises(PermissionError) as refused:
        inplace.publish_copy(produced, out)
    assert str(refused.value) == inplace.HARD_LINKED
    assert out.read_bytes() == prior
    assert alias.read_bytes() == prior
    assert sorted(p.name for p in tmp_path.iterdir()) == ["alias.pdf", "out.pdf", "work"]


def test_a_copy_that_dies_part_way_leaves_the_previous_output_whole(tmp_path, monkeypatch):
    out = tmp_path / "out.pdf"
    prior = _pdf(out, 1)
    produced = tmp_path / "new.pdf"
    _pdf(produced, 3)

    def torn(src, dst):
        Path(dst).write_bytes(Path(src).read_bytes()[:40])
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(inplace.shutil, "copy2", torn)
    with pytest.raises(OSError):
        inplace.publish_copy(produced, out)
    assert out.read_bytes() == prior
    assert sorted(p.name for p in tmp_path.iterdir()) == ["new.pdf", "out.pdf"]


def test_office_import_replaces_an_existing_output_by_swap(tmp_path, monkeypatch):
    source = tmp_path / "note.txt"
    source.write_text("hello\n", encoding="utf-8")
    out = tmp_path / "note.pdf"
    _pdf(out, 1)
    identity = _identity(out)

    def convert(soffice_path, convert_to, src, out_dir, want_ext):
        produced = Path(out_dir) / (Path(src).stem + want_ext)
        _pdf(produced, 2)
        return produced

    monkeypatch.setattr(soffice, "run_convert", convert)
    # Any existing program stands in for soffice: run_convert is replaced.
    result = soffice.to_pdf(source, out, sys.executable)
    assert result["pages"] == 2
    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == 2
    assert _identity(out) != identity
