"""§ I.5 P5 — headers, footers, and Bates numbering."""

import os

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine.extract_text import extract_text
from engine.headers import _anchor, _display_to_user, add_header_footer


def _pdf(path: str, n_pages: int, rotate: int = 0) -> None:
    doc = pikepdf.new()
    for _ in range(n_pages):
        page = doc.add_blank_page(page_size=(600, 800))
        if rotate:
            page.obj["/Rotate"] = rotate
    doc.save(path)
    doc.close()


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


class TestDisplayToUser:
    # The displayed bottom-left corner maps to a different USER corner per
    # /Rotate — this pins the rotation convention the whole feature rests on.
    # Box W=600, H=800.
    @pytest.mark.parametrize(
        "rotate,expected",
        [(0, (0.0, 0.0)), (90, (600.0, 0.0)), (180, (600.0, 800.0)), (270, (0.0, 800.0))],
    )
    def test_displayed_bottom_left_maps_per_rotation(self, rotate, expected):
        ux, uy = _display_to_user(0.0, 0.0, 600.0, 800.0, rotate)
        assert abs(ux - expected[0]) < 1e-6 and abs(uy - expected[1]) < 1e-6

    def test_round_trip_center_is_fixed(self):
        # The centre maps to itself at every rotation.
        for r in (0, 90, 180, 270):
            ux, uy = _display_to_user(300.0, 400.0, 600.0, 800.0, r) if r in (0, 180) \
                else _display_to_user(400.0, 300.0, 600.0, 800.0, r)
            assert abs(ux - 300.0) < 1e-6 and abs(uy - 400.0) < 1e-6


class TestAnchor:
    # Displayed-space baseline anchors: top rows sit high, bottom rows low;
    # left/center/right order left→right. dw=600, dh=800, margin=24, size=10.
    def test_placement_grid(self):
        tw, size, dw, dh, m = 100.0, 10.0, 600.0, 800.0, 24.0
        pos = {p: _anchor(p, tw, size, dw, dh, m) for p in
               ("tl", "tc", "tr", "bl", "bc", "br")}
        # Vertical: top above bottom.
        for col in ("l", "c", "r"):
            assert pos[f"t{col}"][1] > pos[f"b{col}"][1]
        # Horizontal: left < center < right (same for top and bottom rows).
        for row in ("t", "b"):
            assert pos[f"{row}l"][0] < pos[f"{row}c"][0] < pos[f"{row}r"][0]
        # Left is at the margin; right is margin-in from the far edge.
        assert abs(pos["tl"][0] - m) < 1e-6
        assert abs(pos["tr"][0] - (dw - m - tw)) < 1e-6
        assert abs(pos["tc"][0] - (dw - tw) / 2) < 1e-6
        # Bottom baseline sits at the margin.
        assert abs(pos["bl"][1] - m) < 1e-6


class TestHeaderFooter:
    def test_page_and_total_tokens_per_page(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 3)
        r = add_header_footer(
            src, out,
            [{"position": "bc", "text": "Page {page} of {pages}"}],
        )
        assert r["pages_stamped"] == 3
        for p in (1, 2, 3):
            txt = extract_text(out, pages=[p])["text"]
            assert f"Page {p} of 3" in txt

    def test_bates_increments_and_pads(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 3)
        add_header_footer(
            src, out,
            [{"position": "br", "text": "ACME-{bates}"}],
            bates_start=41, bates_digits=6,
        )
        assert "ACME-000041" in extract_text(out, pages=[1])["text"]
        assert "ACME-000043" in extract_text(out, pages=[3])["text"]

    def test_page_range_limits_stamping(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 4)
        r = add_header_footer(
            src, out,
            [{"position": "tc", "text": "HDR{page}"}],
            first_page=2, last_page=3,
        )
        assert r["pages_stamped"] == 2
        assert "HDR1" not in extract_text(out, pages=[1])["text"]
        assert "HDR2" in extract_text(out, pages=[2])["text"]
        assert "HDR3" in extract_text(out, pages=[3])["text"]
        assert "HDR4" not in extract_text(out, pages=[4])["text"]

    def test_bates_counter_follows_range_not_doc(self, tmp_dir):
        # The counter increments once per STAMPED page — page 2 is the first
        # stamped, so it gets bates_start.
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 3)
        add_header_footer(
            src, out, [{"position": "bl", "text": "{bates}"}],
            first_page=2, bates_start=100, bates_digits=3,
        )
        assert "100" in extract_text(out, pages=[2])["text"]
        assert "101" in extract_text(out, pages=[3])["text"]

    def test_multiple_placements_all_drawn(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1)
        add_header_footer(
            src, out,
            [
                {"position": "tl", "text": "TOPLEFT"},
                {"position": "br", "text": "BOTRIGHT"},
            ],
        )
        txt = extract_text(out, pages=[1])["text"]
        assert "TOPLEFT" in txt and "BOTRIGHT" in txt

    def test_rotated_page_still_stamps_extractable_text(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 1, rotate=90)
        r = add_header_footer(src, out, [{"position": "bc", "text": "ROT{page}"}])
        assert r["pages_stamped"] == 1
        assert "ROT1" in extract_text(out, pages=[1])["text"]

    def test_bad_position_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 1)
        with pytest.raises(ValueError, match="position"):
            add_header_footer(src, os.path.join(tmp_dir, "o.pdf"),
                              [{"position": "middle", "text": "x"}])

    def test_empty_placements_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 1)
        with pytest.raises(ValueError, match="placement"):
            add_header_footer(src, os.path.join(tmp_dir, "o.pdf"), [])

    def test_in_place_output(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 1)
        r = add_header_footer(src, src, [{"position": "bc", "text": "INPLACE"}])
        assert r["pages_stamped"] == 1
        assert "INPLACE" in extract_text(src, pages=[1])["text"]
