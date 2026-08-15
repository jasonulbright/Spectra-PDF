"""The droplet — a profile over a folder, in both modes.

Two properties are load-bearing and are pinned first: a CHECK run never writes
to the tree it reads, and a FIX run's report is the state AFTER the fixups
rather than the state that prompted them. A droplet whose report is the before
state is a droplet that lies.
"""

import json
import os
import pathlib

import pytest

from engine.preflight_sweep import REPORT_SUFFIX, report_path_for, run_preflight_sweep
import preflight_builders as builders


def _profile(fixups=(), **checks) -> dict:
    resolved = {"ink_coverage_max": {"enabled": False}}
    resolved.update(checks)
    return {
        "schema": 1,
        "id": "test_sweep",
        "name": "Test",
        "checks": resolved,
        "fixups": list(fixups),
    }


def _tree(root: pathlib.Path) -> dict:
    """Three documents, one of them failing, one of them in a subfolder."""
    root.mkdir(parents=True, exist_ok=True)
    sub = root / "inner"
    sub.mkdir(exist_ok=True)
    return {
        "clean": builders.build("baseline", str(root), name="clean"),
        "failing": builders.build("has_attachment", str(root), name="failing"),
        "nested": builders.build("baseline", str(sub), name="nested"),
    }


def _digest(paths) -> dict:
    return {p: pathlib.Path(p).read_bytes() for p in paths}


class TestCheckMode:
    def test_it_writes_a_report_per_file_and_touches_no_source(self, tmp_path):
        source = tmp_path / "in"
        files = _tree(source)
        before = _digest(files.values())
        report = run_preflight_sweep(
            str(source), str(tmp_path / "out"),
            profile=_profile(), mode="check", write_log=False,
        )
        assert report["total"] == 3
        assert report["ok"] == 3
        assert _digest(files.values()) == before
        for row in report["results"]:
            assert row["report"].endswith(REPORT_SUFFIX)
            written = json.loads(pathlib.Path(row["report"]).read_text(encoding="utf8"))
            assert written["profile"]["id"] == "test_sweep"
            # A check run's after IS its before: nothing was repaired.
            assert row["after"] == row["before"]

    def test_the_mirror_keeps_the_source_tree_shape(self, tmp_path):
        source = tmp_path / "in"
        _tree(source)
        dest = tmp_path / "out"
        run_preflight_sweep(str(source), str(dest), profile=_profile(),
                            mode="check", write_log=False)
        assert report_path_for(dest, os.path.join("inner", "nested.pdf")).is_file()

    def test_it_writes_no_document_into_the_destination(self, tmp_path):
        source = tmp_path / "in"
        _tree(source)
        dest = tmp_path / "out"
        run_preflight_sweep(str(source), str(dest), profile=_profile(),
                            mode="check", write_log=False)
        assert [p.name for p in dest.rglob("*.pdf")] == []


class TestFixMode:
    def _fix(self, tmp_path, **kwargs):
        source = tmp_path / "in"
        files = _tree(source)
        report = run_preflight_sweep(
            str(source), str(tmp_path / "out"),
            profile=_profile(
                [{"id": "remove_attachments", "params": {}}],
                embedded_files={"allow": False},
            ),
            mode="fix", write_log=False, **kwargs,
        )
        return source, files, report

    def test_it_mirrors_the_fixed_copies_and_leaves_the_sources_alone(self, tmp_path):
        source, files, report = self._fix(tmp_path)
        assert report["total"] == 3
        dest = tmp_path / "out"
        assert (dest / "failing.pdf").is_file()
        assert (dest / "inner" / "nested.pdf").is_file()
        # The source is read at its own path and is never written back.
        assert pathlib.Path(files["failing"]).read_bytes() != (
            dest / "failing.pdf"
        ).read_bytes()

    def test_the_report_is_the_state_after_the_fixups(self, tmp_path):
        _source, _files, report = self._fix(tmp_path)
        row = next(r for r in report["results"] if r["rel"] == "failing.pdf")
        assert row["applied"] == ["remove_attachments"]
        assert row["before"]["failed"] == 1
        assert row["after"]["failed"] == 0
        written = json.loads(pathlib.Path(row["report"]).read_text(encoding="utf8"))
        status = {c["id"]: c["status"] for c in written["checks"]}
        assert status["embedded_files"] == "pass"

    def test_a_document_with_nothing_to_repair_is_still_mirrored(self, tmp_path):
        _source, _files, report = self._fix(tmp_path)
        row = next(r for r in report["results"] if r["rel"] == "clean.pdf")
        assert row["status"] == "ok"
        assert row["applied"] == []
        assert (tmp_path / "out" / "clean.pdf").is_file()

    def test_the_clean_count_is_the_after_state(self, tmp_path):
        _source, _files, report = self._fix(tmp_path)
        assert report["clean"] == 3


class TestRefusals:
    def test_check_mode_refuses_in_place(self, tmp_path):
        source = tmp_path / "in"
        _tree(source)
        with pytest.raises(ValueError, match="nothing for in-place mode to replace"):
            run_preflight_sweep(str(source), "", profile=_profile(), mode="check",
                                in_place=True, write_log=False)

    def test_a_destination_inside_the_source_refuses(self, tmp_path):
        source = tmp_path / "in"
        _tree(source)
        with pytest.raises(ValueError, match="outside the source folder"):
            run_preflight_sweep(str(source), str(source / "out"), profile=_profile(),
                                mode="check", write_log=False)

    def test_fix_mode_with_a_profile_carrying_no_fixups_names_it(self, tmp_path):
        source = tmp_path / "in"
        _tree(source)
        with pytest.raises(ValueError, match="carries no fixups"):
            run_preflight_sweep(str(source), str(tmp_path / "out"),
                                profile=_profile(), mode="fix", write_log=False)

    def test_an_unknown_mode_refuses(self, tmp_path):
        source = tmp_path / "in"
        _tree(source)
        with pytest.raises(ValueError, match="runs in check or fix mode"):
            run_preflight_sweep(str(source), str(tmp_path / "out"),
                                profile=_profile(), mode="audit", write_log=False)

    def test_a_missing_source_folder_refuses(self, tmp_path):
        with pytest.raises(ValueError, match="Source folder not found"):
            run_preflight_sweep(str(tmp_path / "nowhere"), str(tmp_path / "out"),
                                profile=_profile(), write_log=False)


class TestPerFileIsolation:
    def test_one_unreadable_document_never_ends_the_run(self, tmp_path):
        source = tmp_path / "in"
        _tree(source)
        (source / "broken.pdf").write_bytes(b"not a pdf at all")
        report = run_preflight_sweep(str(source), str(tmp_path / "out"),
                                     profile=_profile(), mode="check",
                                     write_log=False)
        assert report["total"] == 4
        assert report["ok"] == 3
        broken = next(r for r in report["results"] if r["rel"] == "broken.pdf")
        assert broken["status"] == "error"
        assert broken["error"]


class TestTheLog:
    def test_it_carries_the_prefix_the_retention_sweep_matches(self, tmp_path):
        source = tmp_path / "in"
        _tree(source)
        logs = tmp_path / "logs"
        report = run_preflight_sweep(str(source), str(tmp_path / "out"),
                                     profile=_profile(), mode="check",
                                     write_log=True, log_dir=str(logs))
        written = pathlib.Path(report["log_path"])
        assert written.name.startswith("preflight-run-")
        assert written.name.endswith(".log")
        # The write and the retention prune share one predicate, whose bound
        # the name has to stay inside.
        assert len(written.name) <= 64
        text = written.read_text(encoding="utf-8")
        assert "Preflight sweep" in text
        assert "clean.pdf" in text
