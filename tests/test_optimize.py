"""Tests for the lossless optimize pass, including in-place output."""

import pikepdf

from engine.optimize import optimize


def _doc(path, pages=3):
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(612, 792))
    with pdf.open_metadata() as meta:
        meta["dc:title"] = "before"
    pdf.save(path)
    pdf.close()


def test_optimize_writes_a_distinct_output(tmp_path):
    src = tmp_path / "in.pdf"
    out = tmp_path / "out.pdf"
    _doc(src)
    report = optimize(str(src), str(out))
    assert out.exists()
    assert report["original_size"] == src.stat().st_size
    assert report["output_size"] == out.stat().st_size
    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == 3


def test_optimize_accepts_output_equal_to_input(tmp_path):
    """The Compress panel's second step optimizes the file the first step just
    wrote, so `output == file` has to stage rather than save over an open
    input."""
    target = tmp_path / "same.pdf"
    _doc(target)
    before = target.stat().st_size

    report = optimize(str(target), str(target), strip_metadata=True)

    assert report["original_size"] == before
    assert report["output_size"] == target.stat().st_size
    with pikepdf.open(target) as pdf:
        assert len(pdf.pages) == 3
        assert pdf.open_metadata().get("dc:title") is None
    # No staging file left beside the target.
    assert [p.name for p in tmp_path.iterdir()] == ["same.pdf"]
