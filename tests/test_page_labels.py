"""Page number labels (/PageLabels)."""

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


def test_nested_number_tree_reads_all_children(tmp_path):
    path = tmp_path / "nested.pdf"
    with pikepdf.new() as pdf:
        for _ in range(4):
            pdf.add_blank_page()
        leaves = [pdf.make_indirect(pikepdf.Dictionary(Nums=pikepdf.Array([i, pikepdf.Dictionary(
            Type=pikepdf.Name.PageLabel, S=pikepdf.Name.r, St=3)]), Limits=pikepdf.Array([i, i]))) for i in (0, 2)]
        middle = pdf.make_indirect(pikepdf.Dictionary(Kids=pikepdf.Array(leaves), Limits=pikepdf.Array([0, 2])))
        pdf.Root.PageLabels = pikepdf.Dictionary(Kids=pikepdf.Array([middle]))
        pdf.save(path)
    r = get_page_labels(str(path))
    assert r["complete"] is True and r["count"] == 2
    assert r["labels"] == ["iii", "iv", "iii", "iv"]


@pytest.mark.parametrize("kind", ["odd", "scalar", "both", "duplicate", "negative", "fraction", "bool",
    "wrong-prefix", "wrong-style", "zero-value", "fraction-value", "wrong-type", "unknown-data", "empty",
    "no-zero", "child-scalar", "cycle", "missing-limits", "wrong-limits", "huge-alpha", "huge-roman", "budget"])
def test_incomplete_reads_never_return_partial_editable_ranges(tmp_path, kind):
    path = tmp_path / "damaged.pdf"
    with pikepdf.new() as pdf:
        for _ in range(4):
            pdf.add_blank_page()
        d = pikepdf.Dictionary(S=pikepdf.Name.D)
        nums = pikepdf.Array([0, d, 2, pikepdf.Dictionary(P=pikepdf.String("valid second"))])
        root = pikepdf.Dictionary(Nums=nums)
        if kind == "odd": nums.append(3)
        if kind == "scalar": root = pikepdf.String("wrong")
        if kind == "both": root.Kids = pikepdf.Array([])
        if kind == "duplicate": nums[2] = 0
        if kind == "negative": nums[0] = -1
        if kind == "fraction": nums[0] = 0.5
        if kind == "bool": nums[0] = False
        if kind == "wrong-prefix": d.P = 42
        if kind == "wrong-style": d.S = pikepdf.Name.Unknown
        if kind == "zero-value": d.St = 0
        if kind == "fraction-value": d.St = 1.5
        if kind == "wrong-type": d.Type = pikepdf.Name.Unknown
        if kind == "unknown-data": d.Custom = pikepdf.String("preserve me")
        if kind == "empty": root = pikepdf.Dictionary(Nums=pikepdf.Array([]))
        if kind == "no-zero": nums[0] = 1
        if kind == "child-scalar": root = pikepdf.Dictionary(Kids=pikepdf.Array([42]))
        if kind == "cycle":
            child = pdf.make_indirect(pikepdf.Dictionary(Limits=pikepdf.Array([0, 2])))
            child.Kids = pikepdf.Array([child]); root = pikepdf.Dictionary(Kids=pikepdf.Array([child]))
        if kind in ("missing-limits", "wrong-limits"):
            child = pdf.make_indirect(root)
            if kind == "wrong-limits": child.Limits = pikepdf.Array([0, 3])
            root = pikepdf.Dictionary(Kids=pikepdf.Array([child]))
        if kind in ("huge-alpha", "huge-roman"):
            d.S = pikepdf.Name.A if kind == "huge-alpha" else pikepdf.Name.R; d.St = 2147483647
        if kind == "budget": d.P = pikepdf.String("x" * 10001)
        pdf.Root.PageLabels = root
        pdf.save(path)
    before = path.read_bytes()
    assert get_page_labels(str(path)) == {"complete": False, "count": 0, "labels": [], "ranges": []}
    assert path.read_bytes() == before


@pytest.mark.parametrize("patch", [{"start": True}, {"start": 0.5}, {"start_at": 0}, {"start_at": 1.5},
    {"start_at": True}, {"prefix": 123}, {"style": "A", "start_at": 2147483647}])
def test_invalid_writer_input_preserves_existing_files(tmp_path, patch):
    src, out = tmp_path / "in.pdf", tmp_path / "out.pdf"
    _pdf(str(src), 2); out.write_bytes(b"existing destination")
    before = src.read_bytes()
    with pytest.raises(ValueError, match="Invalid page label ranges"):
        set_page_labels(str(src), str(out), [{"start": 0, "style": "D", **patch}])
    assert src.read_bytes() == before and out.read_bytes() == b"existing destination"


def test_nonzero_first_user_range_gets_explicit_physical_prefix(tmp_path):
    src, out = tmp_path / "in.pdf", tmp_path / "out.pdf"
    _pdf(str(src), 3)
    set_page_labels(str(src), str(out), [{"start": 1, "style": "r"}])
    r = get_page_labels(str(out))
    assert r["complete"] and r["ranges"][0]["start"] == 0 and r["labels"] == ["1", "i", "ii"]


def test_writer_cannot_emit_labels_exceeding_its_own_read_budget(tmp_path):
    src, out = tmp_path / "in.pdf", tmp_path / "out.pdf"
    _pdf(str(src), 201); out.write_bytes(b"existing")
    with pytest.raises(ValueError, match="Invalid page label ranges"):
        set_page_labels(str(src), str(out), [{"start": 0, "style": "none", "prefix": "x" * 9999}])
    assert out.read_bytes() == b"existing"
