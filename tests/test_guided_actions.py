"""Guided-actions folder runs (slice 3): step validation, the mirror walk,
per-file isolation, logs — plus the encrypt/decrypt in-place pins the runner
forced (the same latent CLI bug class slice 1 fixed for five other ops)."""

import os
from pathlib import Path

import pikepdf
import pytest

from engine.encrypt import decrypt, encrypt
from engine.extract_text import extract_text
from engine.guided_actions import (
    action_log_file_name,
    run_action,
    validate_steps,
)
from engine.inspect import check_encrypted


def _pdf(path, text_free: bool = True) -> None:
    doc = pikepdf.new()
    doc.add_blank_page(page_size=(300, 300))
    doc.save(path)
    doc.close()


@pytest.fixture
def tree(tmp_path):
    """A small source tree: two PDFs, one nested, plus a decoy non-PDF."""
    src = tmp_path / "src"
    (src / "sub").mkdir(parents=True)
    _pdf(src / "a.pdf")
    _pdf(src / "sub" / "b.pdf")
    (src / "notes.txt").write_text("not a pdf")
    return src


class TestValidateSteps:
    def test_accepts_known_steps_and_cleans(self):
        steps = validate_steps([
            {"op": "watermark", "params": {"text": "X", "opacity": 0.2}},
            {"op": "strip_metadata"},
        ])
        assert [s["op"] for s in steps] == ["watermark", "strip_metadata"]

    def test_refuses_unknown_ops_and_params(self):
        with pytest.raises(ValueError, match="unknown operation"):
            validate_steps([{"op": "rm_rf", "params": {}}])
        with pytest.raises(ValueError, match="unknown parameter"):
            validate_steps([{"op": "compress", "params": {"gs_path": "evil.exe"}}])
        with pytest.raises(ValueError, match="no steps"):
            validate_steps([])

    def test_encrypt_rules(self):
        with pytest.raises(ValueError, match="last step"):
            validate_steps([
                {"op": "encrypt", "params": {"owner_password": "s"}},
                {"op": "strip_metadata"},
            ])
        with pytest.raises(ValueError, match="open or an owner password"):
            validate_steps([{"op": "encrypt", "params": {}}])

    def test_header_footer_form_sugar_folds_to_placements(self):
        # The GUI's saved/exported shape stores ONE position+text pair per
        # step; the fold makes an exported action file CLI-consumable
        # without translation (slice 4).
        steps = validate_steps([
            {
                "op": "add_header_footer",
                "params": {"position": "br", "text": "P {page}", "font_size": 12},
            }
        ])
        assert steps[0]["params"]["placements"] == [{"position": "br", "text": "P {page}"}]
        assert "position" not in steps[0]["params"]
        assert "text" not in steps[0]["params"]
        assert steps[0]["params"]["font_size"] == 12

    def test_header_footer_sugar_rules(self):
        with pytest.raises(ValueError, match="not both"):
            validate_steps([
                {
                    "op": "add_header_footer",
                    "params": {"position": "br", "text": "x", "placements": []},
                }
            ])
        with pytest.raises(ValueError, match="go together"):
            validate_steps([{"op": "add_header_footer", "params": {"position": "br"}}])
        # The placements shape stays first-class (slice 3 files unchanged).
        steps = validate_steps([
            {"op": "add_header_footer", "params": {"placements": [{"position": "bc", "text": "x"}]}}
        ])
        assert steps[0]["params"]["placements"] == [{"position": "bc", "text": "x"}]


class TestRunAction:
    def test_mirrors_the_tree_and_applies_steps(self, tree, tmp_path):
        dest = tmp_path / "out"
        report = run_action(
            source=str(tree),
            dest=str(dest),
            steps=[
                {"op": "watermark", "params": {"text": "FOLDER RUN"}},
                {"op": "strip_metadata"},
            ],
            action_name="Mark & Strip",
        )
        assert report["total"] == 2 and report["ok"] == 2 and report["failed"] == 0
        assert (dest / "a.pdf").is_file()
        assert (dest / "sub" / "b.pdf").is_file()
        assert "FOLDER RUN" in extract_text(file=str(dest / "a.pdf"))["text"]
        assert "FOLDER RUN" in extract_text(file=str(dest / "sub" / "b.pdf"))["text"]
        # Sources untouched; the decoy never copied.
        assert "FOLDER RUN" not in extract_text(file=str(tree / "a.pdf"))["text"]
        assert not (dest / "notes.txt").exists()

    def test_per_file_isolation_and_no_partial_outputs(self, tree, tmp_path):
        (tree / "broken.pdf").write_bytes(b"%PDF-not really")
        dest = tmp_path / "out"
        report = run_action(
            source=str(tree),
            dest=str(dest),
            steps=[{"op": "strip_metadata"}],
        )
        assert report["total"] == 3 and report["ok"] == 2 and report["failed"] == 1
        bad = next(r for r in report["results"] if r["status"] == "error")
        assert bad["rel"] == "broken.pdf"
        assert not (dest / "broken.pdf").exists()  # no half-processed mirror file

    def test_dest_inside_source_refused(self, tree):
        with pytest.raises(ValueError, match="outside the source"):
            run_action(source=str(tree), dest=str(tree / "out"), steps=[{"op": "strip_metadata"}])

    def test_gui_exported_header_footer_shape_runs(self, tree, tmp_path):
        # An exported action file carries the GUI's position/text shape —
        # prove it runs end-to-end through the same entry the CLI uses.
        dest = tmp_path / "out"
        report = run_action(
            source=str(tree),
            dest=str(dest),
            steps=[
                {
                    "op": "add_header_footer",
                    "params": {"position": "bc", "text": "EXPORTED", "font_size": 10},
                }
            ],
        )
        assert report["ok"] == 2 and report["failed"] == 0
        assert "EXPORTED" in extract_text(file=str(dest / "a.pdf"))["text"]

    def test_encrypt_last_produces_locked_mirrors(self, tree, tmp_path):
        dest = tmp_path / "locked"
        report = run_action(
            source=str(tree),
            dest=str(dest),
            steps=[
                {"op": "strip_metadata"},
                {"op": "encrypt", "params": {"user_password": "pw"}},
            ],
        )
        assert report["ok"] == 2
        assert check_encrypted(file=str(dest / "a.pdf"))["encrypted"] is True

    def test_writes_the_run_log(self, tree, tmp_path):
        dest = tmp_path / "out"
        logs = tmp_path / "logs"
        report = run_action(
            source=str(tree),
            dest=str(dest),
            steps=[{"op": "strip_metadata"}],
            action_name="Strip",
            log_dir=str(logs),
        )
        log_path = Path(report["log_path"])
        assert log_path.is_file()
        assert log_path.name.startswith("action-run-")
        body = log_path.read_text(encoding="utf-8")
        assert "Strip" in body and "[ok]" in body and "2 processed" in body


class TestEncryptDecryptInPlace:
    def test_encrypt_in_place(self, tmp_pdf):
        encrypt(file=tmp_pdf, output=tmp_pdf, user_password="pw")
        assert check_encrypted(file=tmp_pdf)["encrypted"] is True

    def test_decrypt_in_place(self, tmp_pdf):
        encrypt(file=tmp_pdf, output=tmp_pdf, user_password="pw")
        decrypt(file=tmp_pdf, output=tmp_pdf, password="pw")
        assert check_encrypted(file=tmp_pdf)["encrypted"] is False


class TestRunActionInPlace:
    """O7 in-place mode: originals replaced through staged temps, per-file
    isolation intact, refusals loud."""

    def test_in_place_replaces_originals(self, tree, tmp_path):
        report = run_action(
            source=str(tree),
            dest="",
            steps=[{"op": "watermark", "params": {"text": "INPLACE RUN"}}],
            in_place=True,
        )
        assert report["in_place"] is True
        assert report["ok"] == 2 and report["failed"] == 0
        # The ORIGINALS carry the watermark now.
        assert "INPLACE RUN" in extract_text(file=str(tree / "a.pdf"))["text"]
        assert "INPLACE RUN" in extract_text(file=str(tree / "sub" / "b.pdf"))["text"]
        # No staging litter anywhere in the tree.
        assert not list(tree.rglob("*.inplace.tmp"))

    def test_in_place_failed_file_untouched(self, tree):
        broken = tree / "broken.pdf"
        broken.write_bytes(b"%PDF-not really")
        before = broken.read_bytes()
        report = run_action(
            source=str(tree),
            dest="",
            steps=[{"op": "strip_metadata"}],
            in_place=True,
        )
        assert report["failed"] == 1
        assert broken.read_bytes() == before
        assert not list(tree.rglob("*.inplace.tmp"))

    def test_in_place_refuses_a_dest(self, tree, tmp_path):
        with pytest.raises(ValueError, match="no destination"):
            run_action(
                source=str(tree),
                dest=str(tmp_path / "out"),
                steps=[{"op": "strip_metadata"}],
                in_place=True,
            )
        with pytest.raises(ValueError, match="destination folder is required"):
            run_action(source=str(tree), dest="", steps=[{"op": "strip_metadata"}])
