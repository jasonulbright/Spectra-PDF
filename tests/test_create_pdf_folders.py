"""One PDF per folder: the grouping walk, the ordering rule, and the run.

The ordering rule gets the most attention here because it is the one that goes
wrong SILENTLY — a folder of `page1 … page10` assembled lexicographically puts
page 10 second, and nothing about the resulting document says the order was
chosen rather than observed.
"""

import os

import pikepdf
import pytest
from PIL import Image

from engine.create_pdf_folders import (
    create_pdf_folders,
    folder_log_file_name,
    list_source_folders,
    natural_key,
)


def _png(path, colour=(255, 255, 255)):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.new("RGB", (120, 160), colour).save(path)
    return path


@pytest.fixture
def tree(tmp_path):
    """Two document folders under a root, plus decoys.

    `invoice` holds ten pages named so that lexicographic order is wrong;
    `letter` sits one level deeper. `notes` holds nothing convertible, and the
    root itself holds one loose page — which is its own group.
    """
    root = tmp_path / "scans"
    for n in range(1, 11):
        _png(str(root / "invoice" / f"page{n}.png"))
    _png(str(root / "invoice" / "sub" / "letter" / "a.png"))
    _png(str(root / "invoice" / "sub" / "letter" / "b.png"))
    (root / "notes").mkdir(parents=True, exist_ok=True)
    (root / "notes" / "readme.txt").write_text("not a picture", encoding="utf-8")
    _png(str(root / "cover.png"))
    return root


class TestNaturalOrder:
    def test_a_digit_run_compares_as_a_number(self):
        names = ["page10.png", "page2.png", "page1.png"]
        assert sorted(names, key=natural_key) == ["page1.png", "page2.png", "page10.png"]

    def test_zero_padding_and_plain_digits_both_order(self):
        names = ["p003.png", "p1.png", "p20.png", "p2.png"]
        assert sorted(names, key=natural_key) == ["p1.png", "p2.png", "p003.png", "p20.png"]

    def test_letters_fold_case_but_stay_deterministic(self):
        names = ["B.png", "a.png", "A.png"]
        ordered = sorted(names, key=natural_key)
        assert ordered[-1] == "B.png"
        # The two spellings of `a` keep ONE stable order rather than depending
        # on the input order.
        assert sorted(names, key=natural_key) == sorted(list(reversed(names)), key=natural_key)

    def test_a_name_with_no_digits_still_sorts(self):
        assert sorted(["b", "a"], key=natural_key) == ["a", "b"]


class TestListing:
    def test_groups_by_the_immediate_parent(self, tree):
        listing = list_source_folders(str(tree))
        by_output = {g["output"]: g for g in listing["groups"]}
        # The root's own loose page is its own group, named after the root.
        assert "scans.pdf" in by_output
        assert by_output["scans.pdf"]["count"] == 1
        # A folder holding pages AND a subfolder of pages contributes only its
        # own pages.
        assert by_output[os.path.join("invoice") + ".pdf"]["count"] == 10
        assert by_output[os.path.join("invoice", "sub", "letter") + ".pdf"]["count"] == 2
        # A folder with nothing convertible produces nothing and is not an error.
        assert not any("notes" in output for output in by_output)

    def test_members_arrive_in_the_order_they_will_be_assembled(self, tree):
        listing = list_source_folders(str(tree))
        invoice = next(g for g in listing["groups"] if g["rel"] == "invoice")
        names = [os.path.basename(p) for p in invoice["files"]]
        assert names == [f"page{n}.png" for n in range(1, 11)]

    def test_the_top_level_only_option_stops_at_the_root(self, tree):
        listing = list_source_folders(str(tree), include_subfolders=False)
        assert [g["output"] for g in listing["groups"]] == ["scans.pdf"]

    def test_the_all_source_set_takes_more_than_pictures(self, tree):
        # `notes` holds only a .txt, which Create PDF converts through the
        # office arm — so it is a group under `all` and not under `images`.
        outputs = {g["output"] for g in list_source_folders(str(tree), sources="all")["groups"]}
        assert os.path.join("notes") + ".pdf" in outputs

    def test_an_unknown_source_set_refuses_by_name(self, tree):
        with pytest.raises(ValueError, match="unknown source set"):
            list_source_folders(str(tree), sources="everything")

    def test_a_missing_folder_refuses(self, tmp_path):
        with pytest.raises(ValueError, match="Source folder not found"):
            list_source_folders(str(tmp_path / "nowhere"))


class TestRun:
    def test_each_folder_becomes_one_pdf_at_the_folders_own_place(self, tree, tmp_path):
        dest = tmp_path / "out"
        report = create_pdf_folders(str(tree), str(dest), write_log=False)
        assert report["failed"] == 0
        assert report["ok"] == 3
        # The PDF takes the FOLDER'S place in the mirrored tree rather than
        # sitting inside a recreated copy of it.
        assert (dest / "invoice.pdf").is_file()
        assert (dest / "invoice" / "sub" / "letter.pdf").is_file()
        assert (dest / "scans.pdf").is_file()
        with pikepdf.open(str(dest / "invoice.pdf")) as pdf:
            assert len(pdf.pages) == 10
        with pikepdf.open(str(dest / "invoice" / "sub" / "letter.pdf")) as pdf:
            assert len(pdf.pages) == 2

    def test_the_sources_are_never_modified(self, tree, tmp_path):
        before = {
            p: os.path.getmtime(os.path.join(dirpath, p))
            for dirpath, _dirs, files in os.walk(tree)
            for p in files
        }
        create_pdf_folders(str(tree), str(tmp_path / "out"), write_log=False)
        after = {
            p: os.path.getmtime(os.path.join(dirpath, p))
            for dirpath, _dirs, files in os.walk(tree)
            for p in files
        }
        assert before == after

    def test_a_destination_inside_the_source_refuses(self, tree):
        # Otherwise the run's own outputs join what it walks.
        with pytest.raises(ValueError, match="outside the source folder"):
            create_pdf_folders(str(tree), str(tree / "out"), write_log=False)

    def test_one_unreadable_page_does_not_cost_the_others(self, tmp_path):
        root = tmp_path / "scans"
        _png(str(root / "doc" / "a.png"))
        (root / "doc" / "b.png").write_bytes(b"not a picture at all")
        _png(str(root / "doc" / "c.png"))
        report = create_pdf_folders(str(root), str(tmp_path / "out"), write_log=False)
        row = report["results"][0]
        assert row["status"] == "ok"
        assert row["pages"] == 2
        # Never silent: the member that could not be read is named.
        assert any("b.png" in w for w in row["warnings"])

    def test_a_folder_that_produces_nothing_is_reported_not_written(self, tmp_path):
        root = tmp_path / "scans"
        _png(str(root / "doc" / "a.png"))
        (root / "doc" / "a.png").write_bytes(b"broken")
        dest = tmp_path / "out"
        report = create_pdf_folders(str(root), str(dest), write_log=False)
        assert report["failed"] == 1
        assert report["results"][0]["error"]
        # No half-written document left behind.
        assert not (dest / "doc.pdf").exists()

    def test_an_empty_tree_is_an_empty_run_rather_than_a_refusal(self, tmp_path):
        root = tmp_path / "scans"
        (root / "nothing").mkdir(parents=True)
        report = create_pdf_folders(str(root), str(tmp_path / "out"), write_log=False)
        assert report["total"] == 0 and report["ok"] == 0 and report["failed"] == 0

    def test_the_run_leaves_a_log(self, tree, tmp_path):
        logs = tmp_path / "logs"
        report = create_pdf_folders(
            str(tree), str(tmp_path / "out"), log_dir=str(logs), write_log=True
        )
        assert os.path.isfile(report["log_path"])
        text = open(report["log_path"], encoding="utf-8").read()
        assert "Create PDF per folder" in text
        assert str(tree) in text
        assert "invoice.pdf" in text
        assert "3 built · 0 failed · 3 folder(s)" in text

    def test_the_log_name_is_sortable_and_greppable(self):
        from datetime import datetime

        name = folder_log_file_name(datetime(2026, 8, 9, 4, 5, 6))
        assert name == "create-pdf-folders-2026-08-09_040506.log"
