"""Empty source-folder removal after a batch run."""

import os
import sys

import pikepdf
import pytest

from engine.batch_ocr import batch_ocr, plan_empty_folders, remove_empty_folders_in


def _mk(root, *parts):
    path = os.path.join(root, *parts)
    os.makedirs(path, exist_ok=True)
    return path


def _touch(path):
    with open(path, "wb") as f:
        f.write(b"x")


def _junction(link, target):
    if sys.platform != "win32":
        pytest.skip("junctions are a Windows construct")
    import _winapi

    _winapi.CreateJunction(target, link)


def _planned(root, protected=()):
    return {os.path.relpath(c["path"], root) for c in plan_empty_folders(root, protected)["candidates"]}


class TestPlanner:
    def test_nested_empty_folders_qualify_and_the_root_never_does(self, tmp_path):
        root = str(tmp_path)
        _mk(root, "a", "b", "c")
        _mk(root, "d")
        assert _planned(root) == {"a", os.path.join("a", "b"), os.path.join("a", "b", "c"), "d"}

    def test_children_come_before_parents(self, tmp_path):
        root = str(tmp_path)
        _mk(root, "a", "b")
        order = [os.path.relpath(c["path"], root) for c in plan_empty_folders(root)["candidates"]]
        assert order.index(os.path.join("a", "b")) < order.index("a")

    def test_a_file_anywhere_below_keeps_every_ancestor(self, tmp_path):
        root = str(tmp_path)
        _mk(root, "a", "b", "empty")
        _touch(os.path.join(root, "a", "b", "keep.txt"))
        assert _planned(root) == {os.path.join("a", "b", "empty")}

    def test_an_empty_root_plans_nothing(self, tmp_path):
        assert plan_empty_folders(str(tmp_path))["candidates"] == []

    def test_a_protected_folder_is_kept_and_keeps_its_parent(self, tmp_path):
        root = str(tmp_path)
        out = _mk(root, "p", "out")
        assert _planned(root, (out,)) == set()
        skipped = plan_empty_folders(root, (out,))["skipped"]
        assert [s["path"] for s in skipped] == [out]

    def test_a_junction_is_not_followed_and_counts_as_content(self, tmp_path):
        outside = _mk(str(tmp_path), "outside", "empty-inside-target")
        root = _mk(str(tmp_path), "src")
        _mk(root, "holder")
        link = os.path.join(root, "holder", "link")
        _junction(link, os.path.dirname(outside))
        plan = plan_empty_folders(root)
        assert plan["candidates"] == []
        assert [s["path"] for s in plan["skipped"]] == [link]
        assert "not followed" in plan["skipped"][0]["reason"]

    def test_a_directory_symlink_is_not_followed(self, tmp_path):
        target = _mk(str(tmp_path), "target", "empty")
        root = _mk(str(tmp_path), "src")
        _mk(root, "holder")
        link = os.path.join(root, "holder", "link")
        try:
            os.symlink(os.path.dirname(target), link, target_is_directory=True)
        except OSError:
            pytest.skip("creating symbolic links needs a privilege this session lacks")
        assert _planned(root) == set()

    def test_a_root_that_is_itself_a_junction_resolves_to_its_target(self, tmp_path):
        real = _mk(str(tmp_path), "real")
        _mk(real, "e")
        link = os.path.join(str(tmp_path), "via")
        _junction(link, real)
        cands = plan_empty_folders(link)["candidates"]
        assert [os.path.normcase(c["path"]) for c in cands] == [
            os.path.normcase(os.path.join(real, "e"))
        ]


    def test_a_folder_holding_only_system_files_is_kept_and_named(self, tmp_path):
        root = str(tmp_path)
        shell = _mk(root, "a", "shell")
        _touch(os.path.join(shell, "desktop.ini"))
        _touch(os.path.join(shell, "Thumbs.db"))
        plan = plan_empty_folders(root)
        assert plan["candidates"] == []
        assert plan["skipped"] == [
            {"path": shell, "reason": "holds only system files: Thumbs.db, desktop.ini"}
        ]

    def test_a_system_file_beside_real_content_is_not_reported(self, tmp_path):
        root = str(tmp_path)
        d = _mk(root, "d")
        _touch(os.path.join(d, ".DS_Store"))
        _touch(os.path.join(d, "a.pdf"))
        assert plan_empty_folders(root)["skipped"] == []


class TestRemoval:
    def test_removes_only_empty_folders(self, tmp_path):
        root = str(tmp_path)
        _mk(root, "a", "b")
        _mk(root, "keep")
        _touch(os.path.join(root, "keep", "f.pdf"))
        result = remove_empty_folders_in(root)
        assert {os.path.relpath(p, root) for p in result["removed"]} == {"a", os.path.join("a", "b")}
        assert result["skipped"] == []
        assert os.path.isdir(root)
        assert os.path.isfile(os.path.join(root, "keep", "f.pdf"))
        assert not os.path.exists(os.path.join(root, "a"))

    def test_a_junction_target_is_untouched(self, tmp_path):
        outside = _mk(str(tmp_path), "outside")
        _mk(outside, "empty")
        root = _mk(str(tmp_path), "src")
        link = os.path.join(root, "link")
        _junction(link, outside)
        result = remove_empty_folders_in(root)
        assert result["removed"] == []
        assert os.path.isdir(os.path.join(outside, "empty"))
        assert os.path.lexists(link)

    def test_a_folder_that_fills_after_planning_is_kept(self, tmp_path, monkeypatch):
        root = str(tmp_path)
        late = _mk(root, "late")
        import engine.batch_ocr as ef

        real_plan = ef.plan_empty_folders

        def plan_then_fill(*args):
            plan = real_plan(*args)
            _touch(os.path.join(late, "arrived.pdf"))
            return plan

        monkeypatch.setattr(ef, "plan_empty_folders", plan_then_fill)
        result = ef.remove_empty_folders_in(root)
        assert result["removed"] == []
        assert [s["path"] for s in result["skipped"]] == [late]
        assert os.path.isfile(os.path.join(late, "arrived.pdf"))

    def test_only_the_deepest_failure_is_reported(self, tmp_path, monkeypatch):
        root = str(tmp_path)
        deep = _mk(root, "a", "b", "c")
        import engine.batch_ocr as ef

        real_plan = ef.plan_empty_folders

        def plan_then_fill(*args):
            plan = real_plan(*args)
            _touch(os.path.join(deep, "late.pdf"))
            return plan

        monkeypatch.setattr(ef, "plan_empty_folders", plan_then_fill)
        result = ef.remove_empty_folders_in(root)
        assert result["removed"] == []
        assert [s["path"] for s in result["skipped"]] == [deep]

    def test_a_folder_replaced_after_planning_is_kept(self, tmp_path, monkeypatch):
        root = str(tmp_path)
        swapped = _mk(root, "swapped")
        import engine.batch_ocr as ef

        real_plan = ef.plan_empty_folders

        def plan_then_swap(*args):
            plan = real_plan(*args)
            os.rmdir(swapped)
            _junction(swapped, _mk(str(tmp_path.parent), tmp_path.name + "-elsewhere"))
            return plan

        monkeypatch.setattr(ef, "plan_empty_folders", plan_then_swap)
        result = ef.remove_empty_folders_in(root)
        assert result["removed"] == []
        assert os.path.lexists(swapped)


def _text_pdf(path):
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(path)


class TestRootRefusal:
    def test_a_junction_root_removes_nothing(self, tmp_path):
        real = _mk(str(tmp_path), "real")
        _mk(real, "e")
        link = os.path.join(str(tmp_path), "via")
        _junction(link, real)
        result = remove_empty_folders_in(link)
        assert result["removed"] == []
        assert "link or junction" in result["skipped"][0]["reason"]
        assert os.path.isdir(os.path.join(real, "e"))

    def test_a_junction_ancestor_removes_nothing(self, tmp_path):
        real = _mk(str(tmp_path), "real")
        _mk(real, "src", "e")
        link = os.path.join(str(tmp_path), "via")
        _junction(link, real)
        result = remove_empty_folders_in(os.path.join(link, "src"))
        assert result["removed"] == []
        assert os.path.isdir(os.path.join(real, "src", "e"))


class _Tagged:
    def __init__(self, real, tag):
        self._real = real
        self.st_file_attributes = real.st_file_attributes | 0x400
        self.st_reparse_tag = tag

    def __getattr__(self, name):
        return getattr(self._real, name)


def _fake_tag(monkeypatch, path, tag):
    real_lstat = os.lstat
    key = os.path.normcase(os.path.abspath(path))

    def lstat(p, *args, **kwargs):
        st = real_lstat(p, *args, **kwargs)
        if os.path.normcase(os.path.abspath(p)) == key:
            return _Tagged(st, tag)
        return st

    monkeypatch.setattr(os, "lstat", lstat)


CLOUD_TAG = 0x9000601A
SYMLINK_TAG = 0xA000000C


class TestReparseTags:
    def test_a_cloud_tagged_ancestor_does_not_refuse(self, tmp_path, monkeypatch):
        root = _mk(str(tmp_path), "OneDrive", "src")
        _mk(root, "e")
        _fake_tag(monkeypatch, os.path.dirname(root), CLOUD_TAG)
        result = remove_empty_folders_in(root)
        assert [os.path.basename(p) for p in result["removed"]] == ["e"]

    def test_a_symlink_tagged_ancestor_refuses(self, tmp_path, monkeypatch):
        root = _mk(str(tmp_path), "linked", "src")
        _mk(root, "e")
        _fake_tag(monkeypatch, os.path.dirname(root), SYMLINK_TAG)
        result = remove_empty_folders_in(root)
        assert result["removed"] == []
        assert os.path.isdir(os.path.join(root, "e"))

    def test_a_cloud_placeholder_in_the_tree_is_not_entered_and_is_kept(
        self, tmp_path, monkeypatch
    ):
        root = str(tmp_path)
        holder = _mk(root, "holder")
        placeholder = _mk(holder, "online-only")
        _fake_tag(monkeypatch, placeholder, CLOUD_TAG)
        plan = plan_empty_folders(root)
        assert plan["candidates"] == []
        assert plan["skipped"] == [
            {"path": placeholder, "reason": "cloud or other placeholder folder, not entered"}
        ]


class TestProtectedSpelling:
    def test_a_short_name_spelling_still_protects(self, tmp_path):
        if sys.platform != "win32":
            pytest.skip("8.3 names are a Windows construct")
        import ctypes

        root = str(tmp_path)
        out = _mk(root, "long output folder name")
        buf = ctypes.create_unicode_buffer(512)
        ctypes.windll.kernel32.GetShortPathNameW(out, buf, 512)
        short = buf.value
        if not short or os.path.normcase(short) == os.path.normcase(out):
            pytest.skip("8.3 names are disabled on this volume")
        result = remove_empty_folders_in(root, [short])
        assert result["removed"] == []
        assert os.path.isdir(out)


class TestBatchRun:
    def test_moved_sources_leave_folders_that_are_removed(self, tmp_path):
        src = _mk(str(tmp_path), "src")
        _mk(src, "sub", "deeper")
        _text_pdf(os.path.join(src, "sub", "deeper", "a.pdf"))
        _mk(src, "kept")
        _touch(os.path.join(src, "kept", "notes.txt"))
        dest = _mk(str(tmp_path), "dest")
        moved = _mk(str(tmp_path), "moved")
        logs = _mk(str(tmp_path), "logs")
        report = batch_ocr(
            src, dest, moved_root=moved, log_dir=logs, remove_empty_folders=True
        )
        assert report["results"][0]["movedTo"]
        removed = {os.path.relpath(p, os.path.realpath(src)) for p in report["emptyFolders"]["removed"]}
        assert removed == {"sub", os.path.join("sub", "deeper")}
        assert os.path.isdir(src)
        assert os.path.isfile(os.path.join(src, "kept", "notes.txt"))
        log = open(report["logPath"], encoding="utf-8").read()
        assert "Empty source folders: 2 removed · 0 left in place" in log

    def test_off_by_default(self, tmp_path):
        src = _mk(str(tmp_path), "src")
        _mk(src, "empty")
        dest = _mk(str(tmp_path), "dest")
        report = batch_ocr(src, dest)
        assert "emptyFolders" not in report
        assert os.path.isdir(os.path.join(src, "empty"))
