"""§ I.5 P5 — crop pages / edit page boxes."""

import os

import pikepdf
import pytest

from engine.page_boxes import set_page_boxes


def _pdf(path: str, n_pages: int = 1, size=(600, 800)) -> None:
    doc = pikepdf.new()
    for _ in range(n_pages):
        doc.add_blank_page(page_size=size)
    doc.save(path)
    doc.close()


def _box(path: str, page_index: int, key: str):
    with pikepdf.open(path) as pdf:
        v = pdf.pages[page_index].obj.get(key)
        return [float(x) for x in v] if v is not None else None


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


class TestSetPageBoxes:
    def test_crop_insets_from_media(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1)
        r = set_page_boxes(src, out, box="crop", top=10, bottom=20, left=30, right=40)
        assert r["changed"] == 1
        # media [0,0,600,800] → crop [0+30, 0+20, 600-40, 800-10].
        assert _box(out, 0, "/CropBox") == [30.0, 20.0, 560.0, 790.0]

    def test_bleed_trim_art_targets(self, tmp_dir):
        for box, key in [("bleed", "/BleedBox"), ("trim", "/TrimBox"), ("art", "/ArtBox")]:
            src = os.path.join(tmp_dir, f"{box}.pdf")
            out = os.path.join(tmp_dir, f"{box}-o.pdf")
            _pdf(src, 1)
            set_page_boxes(src, out, box=box, top=5, bottom=5, left=5, right=5)
            assert _box(out, 0, key) == [5.0, 5.0, 595.0, 795.0]

    def test_clamped_to_media(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1)
        # A negative inset (expand) can't push the crop outside the media box.
        set_page_boxes(src, out, box="crop", top=-100, left=-100)
        assert _box(out, 0, "/CropBox") == [0.0, 0.0, 600.0, 800.0]

    def test_degenerate_crop_refused_per_page(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1)
        r = set_page_boxes(src, out, box="crop", left=400, right=400)  # 600 - 800 < 0
        assert r["changed"] == 0
        assert r["skipped"] and r["skipped"][0]["reason"] == "resulting box is degenerate"
        assert _box(out, 0, "/CropBox") is None  # untouched

    def test_crop_from_existing_crop_not_media(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1)
        first = os.path.join(tmp_dir, "first.pdf")
        set_page_boxes(src, first, box="crop", top=50, bottom=50, left=50, right=50)
        # A second crop insets from the ALREADY-cropped box, not the media box.
        set_page_boxes(first, out, box="crop", top=10, left=10)
        assert _box(out, 0, "/CropBox") == [60.0, 50.0, 550.0, 740.0]

    def test_page_range(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 3)
        r = set_page_boxes(src, out, box="crop", top=10, pages=[2])
        assert r["changed"] == 1
        assert _box(out, 0, "/CropBox") is None
        assert _box(out, 1, "/CropBox") == [0.0, 0.0, 600.0, 790.0]
        assert _box(out, 2, "/CropBox") is None

    def test_bad_box_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 1)
        with pytest.raises(ValueError, match="box must be"):
            set_page_boxes(src, os.path.join(tmp_dir, "o.pdf"), box="margin")

    def test_in_place(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 1)
        set_page_boxes(src, src, box="crop", top=10)
        assert _box(src, 0, "/CropBox") == [0.0, 0.0, 600.0, 790.0]
