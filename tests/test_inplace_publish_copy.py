"""Publishing a finished file produced elsewhere over an existing output.

The converter families (LibreOffice import/export, slide export, batch OCR
mirror copies and repaired-original replacement) produce their result in a
scratch directory. Landing it with a copy INTO the destination truncates the
previous file first, so a death or a full disk part-way leaves a torn file
where a good one was. The hard-link alias reads the difference: after a
directory-entry swap the alias still holds the previous bytes.
"""

import os
import shutil
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


def test_a_published_copy_swaps_the_directory_entry(tmp_path):
    out = tmp_path / "out.pdf"
    prior = _pdf(out, 1)
    alias = tmp_path / "alias.pdf"
    os.link(out, alias)
    produced = tmp_path / "work" / "new.pdf"
    produced.parent.mkdir()
    fresh = _pdf(produced, 2)
    inplace.publish_copy(produced, out)
    assert out.read_bytes() == fresh
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
    prior = _pdf(out, 1)
    alias = tmp_path / "alias.pdf"
    os.link(out, alias)

    def convert(soffice_path, convert_to, src, out_dir, want_ext):
        produced = Path(out_dir) / (Path(src).stem + want_ext)
        _pdf(produced, 2)
        return produced

    monkeypatch.setattr(soffice, "run_convert", convert)
    result = soffice.to_pdf(source, out, shutil.which("cmd") or os.environ["COMSPEC"])
    assert result["pages"] == 2
    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == 2
    assert alias.read_bytes() == prior
