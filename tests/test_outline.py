"""Tests for the outline (bookmarks) engine handlers."""

import os

import pytest

from engine.outline import get_outline, set_outline


def test_get_outline_empty(sample_pdf):
    result = get_outline(sample_pdf)
    assert result["outline"] == []
    assert result["count"] == 0
    assert result["truncated"] is False


def test_set_and_get_round_trip(sample_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "out.pdf")
    tree = [
        {"title": "Cover", "page": 1, "children": []},
        {
            "title": "Chapter 1",
            "page": 2,
            "children": [
                {"title": "Section 1.1", "page": 3, "children": []},
                {"title": "Section 1.2", "page": 4, "children": []},
            ],
        },
        {"title": "No target", "page": None, "children": []},
    ]
    result = set_outline(sample_pdf, tree, out)
    assert result["count"] == 5

    read = get_outline(out)
    assert read["count"] == 5
    assert [i["title"] for i in read["outline"]] == ["Cover", "Chapter 1", "No target"]
    chapter = read["outline"][1]
    assert chapter["page"] == 2
    assert [c["title"] for c in chapter["children"]] == ["Section 1.1", "Section 1.2"]
    assert chapter["children"][0]["page"] == 3
    assert read["outline"][2]["page"] is None


def test_set_outline_in_place(sample_pdf, tmp_dir):
    import shutil

    working = os.path.join(tmp_dir, "working.pdf")
    shutil.copy(sample_pdf, working)
    set_outline(working, [{"title": "A", "page": 1, "children": []}], working)
    assert get_outline(working)["count"] == 1


def test_set_outline_clears(sample_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "out.pdf")
    set_outline(sample_pdf, [{"title": "A", "page": 1, "children": []}], out)
    set_outline(out, [], out)
    assert get_outline(out)["count"] == 0


def test_set_outline_rejects_out_of_range(sample_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "out.pdf")
    with pytest.raises(ValueError, match="targets page 99"):
        set_outline(sample_pdf, [{"title": "Bad", "page": 99, "children": []}], out)


def test_untitled_fallback(sample_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "out.pdf")
    set_outline(sample_pdf, [{"title": "  ", "page": 1, "children": []}], out)
    assert get_outline(out)["outline"][0]["title"] == "Untitled"
