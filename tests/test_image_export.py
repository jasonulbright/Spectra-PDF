"""Export PDF pages as raster images via Ghostscript."""

import os
import struct

import pikepdf
import pytest

from engine.image_export import export_images


def _pdf(path: str, pages: int = 3) -> None:
    p = pikepdf.new()
    for _ in range(pages):
        p.add_blank_page(page_size=(200, 200))
    p.save(path)
    p.close()


def _tiff_page_count(path: str) -> int:
    """Count IFDs in a TIFF — each rendered page is one directory."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:2] == b"II":
        u16, u32 = "<H", "<I"
    elif data[:2] == b"MM":
        u16, u32 = ">H", ">I"
    else:
        raise AssertionError("not a TIFF")
    off = struct.unpack_from(u32, data, 4)[0]
    count = 0
    while off:
        count += 1
        n = struct.unpack_from(u16, data, off)[0]
        off = struct.unpack_from(u32, data, off + 2 + n * 12)[0]
    return count


def test_png_multipage_one_file_per_page(tmp_dir, gs_path):
    src = os.path.join(tmp_dir, "s.pdf")
    _pdf(src, pages=3)
    r = export_images(src, os.path.join(tmp_dir, "page.png"), "png", dpi=72, gs_path=gs_path)
    assert r["pages_rendered"] == 3
    assert [os.path.basename(p) for p in r["outputs"]] == ["page-1.png", "page-2.png", "page-3.png"]
    for p in r["outputs"]:
        with open(p, "rb") as f:
            assert f.read(8) == b"\x89PNG\r\n\x1a\n"


def test_single_page_selection_keeps_the_exact_name(tmp_dir, gs_path):
    src = os.path.join(tmp_dir, "s.pdf")
    _pdf(src, pages=3)
    out = os.path.join(tmp_dir, "only.png")
    r = export_images(src, out, "png", dpi=72, pages="2", gs_path=gs_path)
    assert r["outputs"] == [out]
    assert os.path.isfile(out)


def test_tiff_is_one_multipage_file(tmp_dir, gs_path):
    src = os.path.join(tmp_dir, "s.pdf")
    _pdf(src, pages=4)
    out = os.path.join(tmp_dir, "doc.tiff")
    r = export_images(src, out, "tiff", dpi=72, gs_path=gs_path)
    assert r["outputs"] == [out]
    assert _tiff_page_count(out) == 4


def test_jpeg_and_range(tmp_dir, gs_path):
    src = os.path.join(tmp_dir, "s.pdf")
    _pdf(src, pages=5)
    r = export_images(src, os.path.join(tmp_dir, "j.jpg"), "jpeg", dpi=72, pages="2-4", gs_path=gs_path)
    assert r["pages_rendered"] == 3
    for p in r["outputs"]:
        with open(p, "rb") as f:
            assert f.read(2) == b"\xff\xd8"  # JPEG SOI


def test_percent_in_name_stays_literal(tmp_dir, gs_path):
    # gs treats % as a per-page template char — the distill review's class.
    src = os.path.join(tmp_dir, "s.pdf")
    _pdf(src, pages=1)
    out = os.path.join(tmp_dir, "Q4 50% off.png")
    r = export_images(src, out, "png", dpi=72, gs_path=gs_path)
    assert r["outputs"] == [out]
    assert os.path.isfile(out)


def test_gray_uses_the_grayscale_device(tmp_dir, gs_path):
    src = os.path.join(tmp_dir, "s.pdf")
    _pdf(src, pages=1)
    out = os.path.join(tmp_dir, "g.png")
    export_images(src, out, "png", dpi=72, gray=True, gs_path=gs_path)
    with open(out, "rb") as f:
        header = f.read(26)
    assert header[25] == 0  # PNG color type 0 = grayscale (png16m writes 2)


def test_refusals(tmp_dir, gs_path):
    src = os.path.join(tmp_dir, "s.pdf")
    _pdf(src, pages=2)
    with pytest.raises(ValueError, match="unsupported image format"):
        export_images(src, os.path.join(tmp_dir, "o.bmp"), "bmp", gs_path=gs_path)
    with pytest.raises(ValueError, match="dpi must be"):
        export_images(src, os.path.join(tmp_dir, "o.png"), "png", dpi=5000, gs_path=gs_path)
    with pytest.raises(ValueError, match="beyond the document"):
        export_images(src, os.path.join(tmp_dir, "o.png"), "png", pages="9", gs_path=gs_path)
    with pytest.raises(ValueError, match="is a directory"):
        export_images(src, tmp_dir, "png", gs_path=gs_path)
