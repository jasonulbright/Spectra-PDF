"""§ I.5 P5 — page number labels (/PageLabels)."""

import os

import pikepdf
import pytest

from engine.page_labels import (
    _to_alpha,
    _to_roman,
    get_page_labels,
    label_for,
    set_page_labels,
)


def _pdf(path: str, n_pages: int) -> None:
    doc = pikepdf.new()
    for _ in range(n_pages):
        doc.add_blank_page(page_size=(300, 300))
    doc.save(path)
    doc.close()


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


class TestFormatting:
    def test_roman(self):
        assert [_to_roman(n) for n in (1, 2, 4, 9, 14, 40)] == ["i", "ii", "iv", "ix", "xiv", "xl"]

    def test_alpha(self):
        assert [_to_alpha(n) for n in (1, 26, 27, 28, 53)] == ["a", "z", "aa", "bb", "aaa"]

    def test_label_for_front_matter_then_body(self):
        ranges = [
            {"start": 0, "style": "r", "prefix": "", "start_at": 1},
            {"start": 4, "style": "D", "prefix": "", "start_at": 1},
        ]
        labels = [label_for(ranges, p) for p in range(7)]
        assert labels == ["i", "ii", "iii", "iv", "1", "2", "3"]

    def test_prefix_and_start_at(self):
        ranges = [{"start": 0, "style": "D", "prefix": "A-", "start_at": 5}]
        assert [label_for(ranges, p) for p in range(3)] == ["A-5", "A-6", "A-7"]

    def test_style_none_is_prefix_only(self):
        ranges = [{"start": 0, "style": "none", "prefix": "Cover", "start_at": 1}]
        assert label_for(ranges, 0) == "Cover"

    def test_page_before_first_range_falls_back_to_physical(self):
        ranges = [{"start": 2, "style": "D", "prefix": "", "start_at": 1}]
        assert label_for(ranges, 0) == "1"  # physical
        assert label_for(ranges, 2) == "1"  # first of the range


class TestReadWrite:
    def test_round_trip(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 6)
        set_page_labels(src, out, [
            {"start": 0, "style": "r"},
            {"start": 4, "style": "D", "start_at": 1},
        ])
        r = get_page_labels(out)
        assert r["labels"] == ["i", "ii", "iii", "iv", "1", "2"]
        assert r["count"] == 2

    def test_empty_removes_tree(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        mid = os.path.join(tmp_dir, "mid.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 3)
        set_page_labels(src, mid, [{"start": 0, "style": "R"}])
        assert get_page_labels(mid)["count"] == 1
        set_page_labels(mid, out, [])
        assert get_page_labels(out)["count"] == 0
        with pikepdf.open(out) as pdf:
            assert "/PageLabels" not in pdf.Root

    def test_no_labels_returns_physical(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 3)
        r = get_page_labels(src)
        assert r["labels"] == ["1", "2", "3"] and r["count"] == 0

    def test_out_of_range_start_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 3)
        with pytest.raises(ValueError, match="out of range"):
            set_page_labels(src, os.path.join(tmp_dir, "o.pdf"), [{"start": 5, "style": "D"}])

    def test_duplicate_start_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 3)
        with pytest.raises(ValueError, match="duplicate"):
            set_page_labels(src, os.path.join(tmp_dir, "o.pdf"),
                            [{"start": 0, "style": "D"}, {"start": 0, "style": "r"}])

    def test_bad_style_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src, 3)
        with pytest.raises(ValueError, match="style must be"):
            set_page_labels(src, os.path.join(tmp_dir, "o.pdf"), [{"start": 0, "style": "Q"}])

    def test_prefix_start_at_persist(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, 3)
        set_page_labels(src, out, [{"start": 0, "style": "D", "prefix": "B-", "start_at": 10}])
        r = get_page_labels(out)
        assert r["labels"][0] == "B-10"
        assert r["ranges"][0]["prefix"] == "B-" and r["ranges"][0]["start_at"] == 10
