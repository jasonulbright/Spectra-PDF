"""Content-aware crop — the box math, against fixtures with known extents.

Every born-digital fixture here draws at coordinates the test itself chose, so
the expected box is an EXACT number rather than "smaller than the page". The
scanned fixture goes through the ink path instead: its content is a black
block at a known place in the raster, so the box it produces is exact too,
within the one pixel the image-to-page mapping is allowed to round by.
"""

from __future__ import annotations

import os

import numpy as np
import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

from engine.content_crop import content_crop, page_content_box

PAGE_W, PAGE_H = 612.0, 792.0


def _font(pdf):
    return pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type1"),
            BaseFont=Name("/Helvetica"),
            Encoding=Name("/WinAnsiEncoding"),
        )
    )


def _page(pdf, content: str, *, resources=None, media=(0, 0, PAGE_W, PAGE_H)):
    page = Dictionary(
        Type=Name("/Page"),
        MediaBox=list(media),
        Resources=resources if resources is not None else Dictionary(),
        Contents=pdf.make_stream(content.encode("latin-1")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    return pdf.pages[-1]


def _write(pdf, tmp_dir, name="src.pdf") -> str:
    path = os.path.join(tmp_dir, name)
    pdf.save(path)
    return path


def _boxes(path: str, key: str = "/CropBox"):
    with pikepdf.open(path) as pdf:
        out = []
        for page in pdf.pages:
            value = page.obj.get(key)
            out.append(None if value is None else [round(float(v), 2) for v in value])
        return out


@pytest.fixture
def two_boxes(tmp_dir):
    """Page 1: a filled rectangle at 200,100-320,160 and a second at
    400,600-500,700. Page 2: the same first rectangle only."""
    pdf = pikepdf.Pdf.new()
    _page(pdf, "0 0 1 rg 200 100 120 60 re f\n0 1 0 rg 400 600 100 100 re f\n")
    _page(pdf, "0 0 1 rg 200 100 120 60 re f\n")
    return _write(pdf, tmp_dir)


class TestBornDigital:
    def test_box_is_the_exact_union_of_what_the_page_draws(self, two_boxes, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        result = content_crop(two_boxes, out, margin=0)
        assert result["changed"] == 2
        assert result["skipped"] == []
        assert [p["source"] for p in result["pages"]] == ["content", "content"]
        assert _boxes(out) == [[200.0, 100.0, 500.0, 700.0], [200.0, 100.0, 320.0, 160.0]]

    def test_margin_is_kept_on_all_four_edges(self, two_boxes, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        content_crop(two_boxes, out, margin=12)
        assert _boxes(out)[0] == [188.0, 88.0, 512.0, 712.0]

    def test_margin_clamps_to_the_page_rather_than_growing_it(self, two_boxes, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        content_crop(two_boxes, out, margin=10_000)
        assert _boxes(out)[0] == [0.0, 0.0, PAGE_W, PAGE_H]

    def test_text_bounds_the_box(self, tmp_dir):
        pdf = pikepdf.Pdf.new()
        font = _font(pdf)
        _page(
            pdf,
            "BT /F1 12 Tf 100 700 Td (HELLO) Tj ET\n",
            resources=Dictionary(Font=Dictionary(F1=font)),
        )
        src = _write(pdf, tmp_dir)
        out = os.path.join(tmp_dir, "out.pdf")
        content_crop(src, out, margin=0)
        box = _boxes(out)[0]
        assert box[0] == pytest.approx(100.0, abs=0.5)
        assert box[1] == pytest.approx(700.0, abs=1.0)
        # 12pt Helvetica caps sit under the em box; the run's own advance
        # width bounds the right edge.
        assert 130 < box[2] < 170
        assert box[3] == pytest.approx(712.0, abs=1.0)

    def test_a_run_of_spaces_does_not_hold_the_margin_open(self, tmp_dir):
        pdf = pikepdf.Pdf.new()
        font = _font(pdf)
        _page(
            pdf,
            "BT /F1 12 Tf 100 700 Td (HI) Tj ET\n"
            "BT /F1 12 Tf 400 300 Td (      ) Tj ET\n",
            resources=Dictionary(Font=Dictionary(F1=font)),
        )
        src = _write(pdf, tmp_dir)
        out = os.path.join(tmp_dir, "out.pdf")
        content_crop(src, out, margin=0)
        box = _boxes(out)[0]
        # Whitespace at 400,300 paints nothing, so neither the bottom nor the
        # right edge may reach it.
        assert box[1] > 400
        assert box[2] < 300

    def test_clipped_content_is_not_content(self, tmp_dir):
        pdf = pikepdf.Pdf.new()
        # The second rectangle is clipped entirely away by a clip path that
        # covers only the first one.
        _page(
            pdf,
            "q 190 90 140 80 re W n\n"
            "0 0 1 rg 200 100 120 60 re f\n"
            "0 1 0 rg 400 600 100 100 re f\n"
            "Q\n",
        )
        src = _write(pdf, tmp_dir)
        out = os.path.join(tmp_dir, "out.pdf")
        content_crop(src, out, margin=0)
        assert _boxes(out)[0] == [200.0, 100.0, 320.0, 160.0]

    def test_content_outside_the_current_box_does_not_widen_it(self, two_boxes, tmp_dir):
        with pikepdf.open(two_boxes, allow_overwriting_input=True) as pdf:
            pdf.pages[0].obj["/CropBox"] = Array([250, 120, 460, 650])
            pdf.save(two_boxes)
        out = os.path.join(tmp_dir, "out.pdf")
        content_crop(two_boxes, out, margin=0)
        # The drawn union is 200..500 x 100..700, but the page only SHOWS
        # 250..460 x 120..650, and a crop must never reveal more.
        assert _boxes(out)[0] == [250.0, 120.0, 460.0, 650.0]

    def test_cropping_twice_writes_the_same_box(self, two_boxes, tmp_dir):
        once = os.path.join(tmp_dir, "once.pdf")
        twice = os.path.join(tmp_dir, "twice.pdf")
        content_crop(two_boxes, once, margin=6)
        content_crop(once, twice, margin=6)
        assert _boxes(once) == _boxes(twice)


class TestAnnotations:
    def _with_annot(self, tmp_dir, annot: Dictionary) -> str:
        pdf = pikepdf.Pdf.new()
        page = _page(pdf, "0 0 1 rg 200 100 120 60 re f\n")
        page.obj["/Annots"] = Array([pdf.make_indirect(annot)])
        return _write(pdf, tmp_dir)

    def test_a_visible_annotation_is_content(self, tmp_dir):
        src = self._with_annot(
            tmp_dir,
            Dictionary(Type=Name("/Annot"), Subtype=Name("/Square"), Rect=[500, 700, 560, 740]),
        )
        out = os.path.join(tmp_dir, "out.pdf")
        content_crop(src, out, margin=0)
        assert _boxes(out)[0] == [200.0, 100.0, 560.0, 740.0]

    def test_a_link_draws_nothing_and_is_not_content(self, tmp_dir):
        src = self._with_annot(
            tmp_dir,
            Dictionary(Type=Name("/Annot"), Subtype=Name("/Link"), Rect=[500, 700, 560, 740]),
        )
        out = os.path.join(tmp_dir, "out.pdf")
        content_crop(src, out, margin=0)
        assert _boxes(out)[0] == [200.0, 100.0, 320.0, 160.0]

    def test_a_hidden_annotation_is_not_content(self, tmp_dir):
        src = self._with_annot(
            tmp_dir,
            Dictionary(
                Type=Name("/Annot"), Subtype=Name("/Square"), Rect=[500, 700, 560, 740], F=2
            ),
        )
        out = os.path.join(tmp_dir, "out.pdf")
        content_crop(src, out, margin=0)
        assert _boxes(out)[0] == [200.0, 100.0, 320.0, 160.0]


class TestScopeAndBoxes:
    def test_pages_scopes_the_crop(self, two_boxes, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        result = content_crop(two_boxes, out, margin=0, pages=[2])
        assert result["changed"] == 1
        assert _boxes(out) == [None, [200.0, 100.0, 320.0, 160.0]]

    def test_an_empty_page_list_never_widens_to_all(self, two_boxes, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="no page in the selection has content"):
            content_crop(two_boxes, out, margin=0, pages=[])
        assert not os.path.exists(out)

    def test_another_box_leaves_the_crop_box_alone(self, two_boxes, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        content_crop(two_boxes, out, box="trim", margin=0)
        assert _boxes(out, "/TrimBox")[0] == [200.0, 100.0, 500.0, 700.0]
        assert _boxes(out, "/CropBox")[0] is None

    def test_writes_in_place(self, two_boxes, tmp_dir):
        content_crop(two_boxes, two_boxes, margin=0)
        assert _boxes(two_boxes)[0] == [200.0, 100.0, 500.0, 700.0]


class TestPreview:
    def test_preview_measures_and_writes_nothing(self, two_boxes, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        result = content_crop(two_boxes, out, margin=0, preview=True)
        assert result["preview"] is True
        assert result["changed"] == 2
        assert not os.path.exists(out)
        assert _boxes(two_boxes) == [None, None]

    def test_preview_reports_the_box_that_would_land(self, two_boxes, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        preview = content_crop(two_boxes, out, margin=3, preview=True)
        applied = content_crop(two_boxes, out, margin=3)
        assert [p["box"] for p in preview["pages"]] == [p["box"] for p in applied["pages"]]

    def test_preview_reports_per_edge_trims(self, two_boxes, tmp_dir):
        out = os.path.join(tmp_dir, "out.pdf")
        preview = content_crop(two_boxes, out, margin=0, preview=True)
        trimmed = preview["pages"][0]["trimmed"]
        assert trimmed["left"] == pytest.approx(200.0)
        assert trimmed["bottom"] == pytest.approx(100.0)
        assert trimmed["right"] == pytest.approx(PAGE_W - 500.0)
        assert trimmed["top"] == pytest.approx(PAGE_H - 700.0)


class TestRefusals:
    def test_a_blank_page_is_skipped_with_a_reason_and_keeps_its_box(self, tmp_dir):
        pdf = pikepdf.Pdf.new()
        _page(pdf, "0 0 1 rg 200 100 120 60 re f\n")
        _page(pdf, "")
        src = _write(pdf, tmp_dir)
        out = os.path.join(tmp_dir, "out.pdf")
        result = content_crop(src, out, margin=0)
        assert result["skipped"] == [
            {"page": 2, "reason": "the page has no content to crop to"}
        ]
        assert _boxes(out)[1] is None

    def test_a_document_with_no_content_refuses(self, tmp_dir):
        pdf = pikepdf.Pdf.new()
        _page(pdf, "")
        _page(pdf, "")
        src = _write(pdf, tmp_dir)
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="no page in the selection has content to crop to"):
            content_crop(src, out)
        assert not os.path.exists(out)

    def test_a_negative_margin_refuses(self, two_boxes, tmp_dir):
        with pytest.raises(ValueError, match="margin must be zero or more points"):
            content_crop(two_boxes, os.path.join(tmp_dir, "out.pdf"), margin=-1)

    def test_a_non_numeric_margin_refuses(self, two_boxes, tmp_dir):
        with pytest.raises(ValueError, match="margin must be a number"):
            content_crop(two_boxes, os.path.join(tmp_dir, "out.pdf"), margin="wide")

    def test_an_unknown_box_refuses(self, two_boxes, tmp_dir):
        with pytest.raises(ValueError, match="box must be one of"):
            content_crop(two_boxes, os.path.join(tmp_dir, "out.pdf"), box="margin")


def _scan_pdf(path: str, *, block: tuple[int, int, int, int] | None, speck: bool) -> tuple[int, int]:
    """A full-page scan whose only real mark is `block` (left, top, right,
    bottom in pixels), optionally with one isolated speck in a corner.

    Lossless samples, not JPEG: the speck is two pixels across, and a lossy
    codec would decide for itself whether it survives.
    """
    dpi = 150
    w = int(PAGE_W / 72 * dpi)
    h = int(PAGE_H / 72 * dpi)
    arr = np.full((h, w), 250, dtype=np.uint8)
    if block is not None:
        left, top, right, bottom = block
        arr[top:bottom, left:right] = 20
    if speck:
        arr[20:22, 20:22] = 20
    rgb = np.stack([arr] * 3, axis=-1)

    pdf = pikepdf.Pdf.new()
    img = pikepdf.Stream(pdf, rgb.tobytes())
    img["/Type"] = Name("/XObject")
    img["/Subtype"] = Name("/Image")
    img["/Width"] = w
    img["/Height"] = h
    img["/ColorSpace"] = Name("/DeviceRGB")
    img["/BitsPerComponent"] = 8
    _page(
        pdf,
        f"q {PAGE_W:.2f} 0 0 {PAGE_H:.2f} 0 0 cm /Im0 Do Q",
        resources=Dictionary(XObject=Dictionary(Im0=pdf.make_indirect(img))),
    )
    pdf.save(path)
    return w, h


class TestScannedPage:
    def test_the_box_comes_from_ink_not_from_the_image_placement(self, tmp_dir):
        src = os.path.join(tmp_dir, "scan.pdf")
        w, h = _scan_pdf(src, block=(300, 200, 900, 1000), speck=False)
        out = os.path.join(tmp_dir, "out.pdf")
        result = content_crop(src, out, margin=0)
        assert [p["source"] for p in result["pages"]] == ["ink"]
        box = _boxes(out)[0]
        # Pixels back into page space: x scales by PAGE_W/w, and the image's
        # y counts DOWN from the top of the page.
        sx, sy = PAGE_W / w, PAGE_H / h
        assert box[0] == pytest.approx(300 * sx, abs=2 * sx)
        assert box[2] == pytest.approx(900 * sx, abs=2 * sx)
        assert box[1] == pytest.approx(PAGE_H - 1000 * sy, abs=2 * sy)
        assert box[3] == pytest.approx(PAGE_H - 200 * sy, abs=2 * sy)
        # ...and it is NOT the placement, which covers the whole page.
        assert box != [0.0, 0.0, PAGE_W, PAGE_H]

    def test_one_speck_in_a_corner_does_not_hold_the_margin_open(self, tmp_dir):
        clean = os.path.join(tmp_dir, "clean.pdf")
        dirty = os.path.join(tmp_dir, "dirty.pdf")
        _scan_pdf(clean, block=(300, 200, 900, 1000), speck=False)
        _scan_pdf(dirty, block=(300, 200, 900, 1000), speck=True)
        out_clean = os.path.join(tmp_dir, "clean-out.pdf")
        out_dirty = os.path.join(tmp_dir, "dirty-out.pdf")
        content_crop(clean, out_clean, margin=0)
        content_crop(dirty, out_dirty, margin=0)
        a, b = _boxes(out_clean)[0], _boxes(out_dirty)[0]
        for i in range(4):
            assert a[i] == pytest.approx(b[i], abs=1.0)

    def test_a_blank_scan_is_skipped_rather_than_cropped_to_nothing(self, tmp_dir):
        src = os.path.join(tmp_dir, "blank-scan.pdf")
        _scan_pdf(src, block=None, speck=False)
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="no page in the selection has content"):
            content_crop(src, out)

    def test_page_content_box_names_which_measurement_answered(self, tmp_dir):
        src = os.path.join(tmp_dir, "scan.pdf")
        _scan_pdf(src, block=(300, 200, 900, 1000), speck=False)
        with pikepdf.open(src) as pdf:
            _box, source = page_content_box(pdf, pdf.pages[0], 1, src)
        assert source == "ink"
