"""Guided-actions folder runs: step validation, the mirror walk,
per-file isolation, logs — plus the encrypt/decrypt in-place pins the runner
forced (the same latent CLI bug class fixed for five other ops)."""

import importlib.util
import inspect
import json
import os
import pathlib
import re
import zlib
from pathlib import Path

import pikepdf
import pytest

from engine import enhance_scan as enhance_scan_module
from engine import gs_capability
from engine.encrypt import decrypt, encrypt
from engine.extract_text import extract_text
from engine.guided_actions import (
    GS_NEVER,
    GS_OPTIONAL,
    GS_REQUIRED,
    GS_UNDECIDED,
    _STEPS,
    _gs_never,
    action_log_file_name,
    items_gs_need,
    plan_gs,
    run_action,
    step_gs_need,
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

    def test_mrc_compression_must_come_after_ocr(self):
        # Enforced rather than documented: `recognize` rasterizes FROM
        # the page, so an OCR step after MRC would read the reconstruction
        # instead of the scan the user actually has.
        with pytest.raises(ValueError, match="MRC compression must come after OCR"):
            validate_steps([
                {"op": "compress", "params": {"quality": "mrc"}},
                {"op": "ocr_file", "params": {"language": "eng"}},
            ])
        # The right order validates, and so does MRC with no OCR at all.
        assert len(validate_steps([
            {"op": "ocr_file", "params": {"language": "eng"}},
            {"op": "compress", "params": {"quality": "mrc", "mrc_preset": "archival"}},
        ])) == 2
        assert len(validate_steps([{"op": "compress", "params": {"quality": "mrc"}}])) == 1
        # An ordinary Ghostscript compress is unaffected — it does not
        # replace the page image, so nothing about it constrains OCR.
        assert len(validate_steps([
            {"op": "compress", "params": {"quality": "ebook"}},
            {"op": "ocr_file", "params": {}},
        ])) == 2

    def test_the_mrc_parameters_are_allowed_on_the_compress_step(self):
        steps = validate_steps([
            {
                "op": "compress",
                "params": {
                    "quality": "mrc",
                    "mrc_preset": "smallest",
                    "mrc_mask_codec": "ccitt",
                    "mrc_pdfa_safe": True,
                    "mrc_bg_div": 3,
                    "mrc_fg_div": 5,
                    # Slice E — the quality gate is a real switch on every
                    # surface `compress` reaches, watched folders and
                    # scheduled runs included.
                    "mrc_verify_text": True,
                    "mrc_lang": "deu",
                },
            }
        ])
        assert steps[0]["params"]["mrc_preset"] == "smallest"
        assert steps[0]["params"]["mrc_verify_text"] is True

    def test_the_verification_step_gets_a_recognizer_path(self):
        from engine.guided_actions import _STEPS

        # A verification that could not find Tesseract would refuse the whole
        # run by name; the step declares the tool path so it does not.
        assert "tesseract_path" in _STEPS["compress"][2]

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
        # without translation.
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
        # The placements shape stays first-class (files unchanged).
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
    """In-place mode: originals replaced through staged temps, per-file
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


class TestRunActionMoved:
    """The watched-folder shape: processed originals leave the intake."""

    def test_processed_originals_move_out(self, tree, tmp_path):
        dest = tmp_path / "out"
        done = tmp_path / "done"
        report = run_action(
            source=str(tree),
            dest=str(dest),
            steps=[{"op": "strip_metadata"}],
            move_processed_root=str(done),
        )
        assert report["ok"] == 2
        moved = [r.get("moved_to") for r in report["results"] if r["status"] == "ok"]
        assert all(moved)
        # Intake emptied of processed PDFs; structure preserved in Done.
        assert not (tree / "a.pdf").exists()
        assert not (tree / "sub" / "b.pdf").exists()
        assert (done / "a.pdf").is_file()
        assert (done / "sub" / "b.pdf").is_file()
        assert (dest / "a.pdf").is_file()
        # The decoy non-PDF never moves.
        assert (tree / "notes.txt").is_file()

    def test_failed_file_stays_in_the_intake(self, tree, tmp_path):
        broken = tree / "broken.pdf"
        broken.write_bytes(b"%PDF-not really")
        report = run_action(
            source=str(tree),
            dest=str(tmp_path / "out"),
            steps=[{"op": "strip_metadata"}],
            move_processed_root=str(tmp_path / "done"),
        )
        assert report["failed"] == 1
        assert broken.is_file()  # still in the intake for the next attempt

    def test_moved_refusals(self, tree, tmp_path):
        with pytest.raises(ValueError, match="outside the source"):
            run_action(
                source=str(tree),
                dest=str(tmp_path / "out"),
                steps=[{"op": "strip_metadata"}],
                move_processed_root=str(tree / "done"),
            )
        with pytest.raises(ValueError, match="cannot also move"):
            run_action(
                source=str(tree),
                dest="",
                steps=[{"op": "strip_metadata"}],
                in_place=True,
                move_processed_root=str(tmp_path / "done"),
            )


def _png(path, dpi=300, size=(600, 900)) -> None:
    """A source the IMAGE arm converts — no external binary, so these pins
    run everywhere (the Office arm needs the vendored LibreOffice and is
    covered by tests/test_create_pdf.py's skip-if-absent suite)."""
    from PIL import Image

    Image.new("L", size, 220).save(path, dpi=(dpi, dpi))


class TestCreatePdfStep:
    """The one step that PRODUCES the document.

    It is why `run_action` grew a branch: every other step is
    `fn(file=p, output=p)` on a COPY of the source, and `create_pdf` refuses
    to write over its own source (the identity guard). Its presence also
    widens what the run WALKS — a folder of Word files is the whole point.
    """

    def test_it_must_be_the_first_step(self):
        with pytest.raises(ValueError, match="create_pdf must be the first step"):
            validate_steps([{"op": "strip_metadata"}, {"op": "create_pdf"}])
        # First is fine, with or without anything after it.
        assert [s["op"] for s in validate_steps([{"op": "create_pdf"}])] == ["create_pdf"]
        assert [
            s["op"]
            for s in validate_steps([{"op": "create_pdf"}, {"op": "strip_metadata"}])
        ] == ["create_pdf", "strip_metadata"]

    def test_its_parameters_are_allow_listed_like_every_other_step(self):
        clean = validate_steps(
            [{"op": "create_pdf", "params": {"page_size": "letter", "margin_pt": 12}}]
        )
        assert clean[0]["params"] == {"page_size": "letter", "margin_pt": 12}
        with pytest.raises(ValueError, match="unknown parameter"):
            validate_steps([{"op": "create_pdf", "params": {"soffice_path": "evil.exe"}}])

    def test_a_creating_run_walks_more_than_pdfs(self, tree, tmp_path):
        # The tree's decoy `notes.txt` is a real SOURCE for this run — plain
        # text is one of the accepted kinds — and so is an image. A
        # transforming run over the same tree finds two files; this one finds
        # four. (Whether the .txt converts depends on the vendored
        # LibreOffice; being LISTED does not.)
        _png(tree / "scan.png")
        report = run_action(
            source=str(tree),
            dest=str(tmp_path / "out"),
            steps=[{"op": "create_pdf"}],
            write_log=False,
        )
        assert report["total"] == 4
        listed = [r["rel"] for r in report["results"]]
        assert "notes.txt" in listed and "scan.png" in listed

    def test_a_converted_source_name_GAINS_pdf_rather_than_replacing_it(
        self, tree, tmp_path
    ):
        # `scan.png` and `scan.pdf` in one folder must not collide, and the
        # original name stays legible (the image-source rule).
        _png(tree / "scan.png")
        dest = tmp_path / "out"
        run_action(
            source=str(tree),
            dest=str(dest),
            steps=[{"op": "create_pdf"}],
            write_log=False,
        )
        assert (dest / "scan.png.pdf").is_file()
        # A PDF source keeps its own name — no `a.pdf.pdf`.
        assert (dest / "a.pdf").is_file()
        assert not (dest / "a.pdf.pdf").exists()

    def test_the_step_parameters_reach_the_conversion(self, tree, tmp_path):
        _png(tree / "scan.png", dpi=600, size=(600, 900))
        dest = tmp_path / "out"
        run_action(
            source=str(tree),
            dest=str(dest),
            steps=[{"op": "create_pdf", "params": {"page_size": "letter"}}],
            write_log=False,
        )
        with pikepdf.open(dest / "scan.png.pdf") as pdf:
            assert [float(v) for v in pdf.pages[0].mediabox] == [0.0, 0.0, 612.0, 792.0]

    def test_later_steps_run_on_what_it_produced(self, tree, tmp_path):
        _png(tree / "scan.png")
        dest = tmp_path / "out"
        report = run_action(
            source=str(tree),
            dest=str(dest),
            steps=[{"op": "create_pdf"}, {"op": "strip_metadata"}],
            write_log=False,
        )
        row = next(r for r in report["results"] if r["rel"] == "scan.png")
        assert row["status"] == "ok"
        # BOTH steps counted — the creation is a step, not a preamble.
        assert row["steps_applied"] == 2

    def test_it_refuses_in_place_mode_by_name(self, tree):
        # Replacing `notes.txt` with a PDF that is still called `notes.txt` is
        # not an in-place edit — it is a destroyed source with a misleading
        # name.
        with pytest.raises(ValueError, match="cannot start with a step that creates"):
            run_action(
                source=str(tree),
                dest="",
                steps=[{"op": "create_pdf"}],
                in_place=True,
                write_log=False,
            )

    def test_a_source_no_arm_converts_is_never_even_listed(self, tree, tmp_path):
        (tree / "thing.zip").write_bytes(b"PKnot a document")
        report = run_action(
            source=str(tree),
            dest=str(tmp_path / "out"),
            steps=[{"op": "create_pdf"}],
            write_log=False,
        )
        assert "thing.zip" not in [r["rel"] for r in report["results"]]

    def test_a_source_that_cannot_be_read_fails_only_its_own_file(self, tree, tmp_path):
        _png(tree / "scan.png")
        (tree / "broken.png").write_bytes(b"not a png at all")
        report = run_action(
            source=str(tree),
            dest=str(tmp_path / "out"),
            steps=[{"op": "create_pdf"}],
            write_log=False,
        )
        broken = next(r for r in report["results"] if r["rel"] == "broken.png")
        good = next(r for r in report["results"] if r["rel"] == "scan.png")
        assert broken["status"] == "error" and "unreadable image" in broken["error"]
        assert good["status"] == "ok"


def _text_pdf(path) -> None:
    """A page carrying real text — an export target has to find something."""
    doc = pikepdf.new()
    page = doc.add_blank_page(page_size=(300, 300))
    font = doc.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name.Helvetica,
            Encoding=pikepdf.Name.WinAnsiEncoding,
        )
    )
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    page.Contents = doc.make_stream(b"BT /F1 12 Tf 50 200 Td (Exportable text) Tj ET")
    doc.save(str(path))
    doc.close()


@pytest.fixture
def text_tree(tmp_path):
    src = tmp_path / "textsrc"
    (src / "sub").mkdir(parents=True)
    _text_pdf(src / "a.pdf")
    _text_pdf(src / "sub" / "b.pdf")
    return src


class TestExportSteps:
    """A terminal export CONSUMES the document: it must come last, it must name
    a format, it cannot run in place, and the mirror carries the exported file
    rather than the PDF the earlier steps ran on."""

    def test_export_must_be_the_last_step(self):
        with pytest.raises(ValueError, match="must be the last step"):
            validate_steps([
                {"op": "export_document", "params": {"fmt": "txt"}},
                {"op": "strip_metadata"},
            ])

    def test_export_must_name_a_known_format(self):
        with pytest.raises(ValueError, match="name the export format"):
            validate_steps([{"op": "export_document", "params": {}}])
        with pytest.raises(ValueError, match="unsupported export format"):
            validate_steps([{"op": "export_document", "params": {"fmt": "wpd"}}])
        with pytest.raises(ValueError, match="unsupported image format"):
            validate_steps([{"op": "export_images", "params": {"fmt": "bmp"}}])

    def test_in_place_refuses_an_export(self, tree, tmp_path):
        with pytest.raises(ValueError, match="cannot end with an export"):
            run_action(
                str(tree),
                "",
                [{"op": "export_document", "params": {"fmt": "txt"}}],
                in_place=True,
                write_log=False,
            )

    def test_mirrors_the_tree_carrying_only_the_exported_file(self, text_tree, tmp_path):
        dest = tmp_path / "out"
        report = run_action(
            str(text_tree),
            str(dest),
            [{"op": "export_document", "params": {"fmt": "txt"}}],
            write_log=False,
        )
        assert report["failed"] == 0
        assert (dest / "a.txt").is_file()
        assert (dest / "sub" / "b.txt").is_file()
        # The intermediate PDF never survives: two trees would make "what did
        # this run produce" ambiguous.
        assert not (dest / "a.pdf").exists()
        assert not (dest / "sub" / "b.pdf").exists()
        # The originals are untouched.
        assert (text_tree / "a.pdf").is_file()
        assert report["results"][0]["output"].endswith(".txt")

    def test_transform_steps_run_before_the_export(self, text_tree, tmp_path):
        dest = tmp_path / "out"
        report = run_action(
            str(text_tree),
            str(dest),
            [
                {"op": "strip_metadata", "params": {}},
                {"op": "export_document", "params": {"fmt": "txt"}},
            ],
            write_log=False,
        )
        assert report["failed"] == 0
        assert report["results"][0]["steps_applied"] == 2
        assert (dest / "a.txt").is_file()
        assert not (dest / "a.pdf").exists()

    def test_a_refusal_is_one_files_result(self, text_tree, tmp_path):
        dest = tmp_path / "out"
        (text_tree / "broken.pdf").write_bytes(b"not a pdf at all")
        report = run_action(
            str(text_tree),
            str(dest),
            [{"op": "export_document", "params": {"fmt": "txt"}}],
            write_log=False,
        )
        by_rel = {r["rel"]: r for r in report["results"]}
        assert by_rel["broken.pdf"]["status"] == "error"
        assert by_rel["a.pdf"]["status"] == "ok"
        assert report["ok"] == 2


class TestOptimizeStep:
    """The Compress panel's "then optimize" second pass, as a folder step.

    It is lossless and needs no tool path, which is what lets it compose after
    any other step; the pins here are that it runs in place on the mirrored
    copy and that its three switches reach `optimize` rather than being
    silently dropped.
    """

    def test_runs_over_the_tree_and_leaves_readable_pdfs(self, tree, tmp_path):
        dest = tmp_path / "out"
        report = run_action(
            source=str(tree),
            dest=str(dest),
            steps=[{"op": "optimize", "params": {"linearize": True}}],
            action_name="Optimize",
        )
        assert report["total"] == 2 and report["ok"] == 2 and report["failed"] == 0
        for rel in ("a.pdf", os.path.join("sub", "b.pdf")):
            with pikepdf.open(dest / rel) as pdf:
                assert len(pdf.pages) == 1

    def test_composes_after_another_step(self, tree, tmp_path):
        # The pair the single-document panel offers together. Optimize last is
        # the point: it packs what the earlier step rewrote.
        dest = tmp_path / "out"
        report = run_action(
            source=str(tree),
            dest=str(dest),
            steps=[
                {"op": "watermark", "params": {"text": "PAIRED"}},
                {"op": "optimize", "params": {"compress_streams": True}},
            ],
        )
        assert report["ok"] == 2 and report["failed"] == 0
        assert "PAIRED" in extract_text(file=str(dest / "a.pdf"))["text"]

    def test_strip_metadata_switch_reaches_the_call(self, tree, tmp_path):
        dest = tmp_path / "out"
        run_action(
            source=str(tree),
            dest=str(dest),
            steps=[{"op": "optimize", "params": {"strip_metadata": True}}],
        )
        with pikepdf.open(dest / "a.pdf") as pdf:
            assert pikepdf.Name.Info not in pdf.trailer

    def test_refuses_a_parameter_optimize_does_not_take(self):
        with pytest.raises(ValueError, match="unknown parameter"):
            validate_steps([{"op": "optimize", "params": {"quality": "screen"}}])


class TestCatalogPin:
    """The engine half of the cross-language catalog pin.

    `tests/fixtures/guided-step-catalog.json` is the one written-down
    declaration of the step set; the renderer's `STEP_CATALOG` is pinned
    against the same file in `tests/guided-actions.test.ts`. A step or a
    parameter added on one side alone therefore goes red on that side rather
    than surfacing as an unknown-op refusal in front of a user (the
    `enhance_scan` drift this test exists for). What a step needs from
    Ghostscript is not in the file: the window and the command line ask the
    engine's own evaluator through `run_action(plan=True)`.
    `scripts/gen-guided-step-catalog.py` writes the file.
    """

    FIXTURE_PATH = pathlib.Path(__file__).parent / "fixtures" / "guided-step-catalog.json"
    GENERATOR = pathlib.Path(__file__).parent.parent / "scripts" / "gen-guided-step-catalog.py"
    FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    def test_the_fixture_is_what_the_tracked_generator_writes(self):
        spec = importlib.util.spec_from_file_location("gen_guided_step_catalog", self.GENERATOR)
        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)
        assert generator.render() == self.FIXTURE_PATH.read_text(encoding="utf-8"), (
            "run `.venv/Scripts/python.exe scripts/gen-guided-step-catalog.py` "
            "and review the diff"
        )

    def test_the_op_names_match_the_fixture_in_both_directions(self):
        assert set(_STEPS) == set(self.FIXTURE["steps"])

    def test_every_op_accepts_exactly_the_parameters_the_fixture_names(self):
        for op, entry in self.FIXTURE["steps"].items():
            assert sorted(_STEPS[op][1]) == entry["params"], op

    def test_every_op_is_callable_with_its_declared_tool_paths(self):
        # `tools` is the tool-path set `_apply_steps` injects; a name outside
        # the run's own vocabulary would be passed as an empty string to a
        # keyword the callable does not take.
        known = {"gs_path", "tesseract_path", "soffice_path", "font_dir", "jbig2_path"}
        for op, spec in _STEPS.items():
            assert callable(spec.fn), op
            assert set(spec.tools) <= known, op

    def test_every_op_declares_every_tool_path_its_callable_takes(self):
        # The totality the fixture cannot state: a tool-path keyword the op
        # ACCEPTS but does not declare is never injected, so the op runs with
        # the parameter's default and silently loses whatever it enables. The
        # instance this pin exists for is the `font_dir` a bare non-WinAnsi
        # widget appearance needs on `compress` and `grayscale`.
        known = {"gs_path", "tesseract_path", "soffice_path", "font_dir", "jbig2_path"}
        for op, spec in _STEPS.items():
            takes = known & set(inspect.signature(spec.fn).parameters)
            assert takes == set(spec.tools), op

    def test_the_tool_paths_match_the_fixture_in_both_directions(self):
        for op, entry in self.FIXTURE["steps"].items():
            assert sorted(_STEPS[op][2]) == entry["tools"], op

    def test_the_fixture_carries_no_ghostscript_demand(self):
        # A demand column here would be a second copy of the evaluator's
        # rules, and one that cannot see a step's parameters or files.
        for op, entry in self.FIXTURE["steps"].items():
            assert set(entry) == {"method", "params", "tools"}, op

    def test_every_step_method_is_registered_and_binds_the_same_callable(self):
        # The single-document runner sends the fixture's `method` as a JSON-RPC
        # name, so a step whose id is not itself a registered name (four
        # were: links_from_urls, sanitize, search_redact, prepare_forms) came
        # back "Method not found", and `preflight` reached the CHECK handler,
        # which refuses the `output` keyword. Read from the server's own
        # register() calls rather than importing __main__, whose module body
        # reconfigures stdio and starts the loop.
        main_py = (
            pathlib.Path(__file__).parent.parent / "src" / "engine" / "__main__.py"
        ).read_text(encoding="utf-8")
        registered = dict(re.findall(r'server\.register\("(\w+)", (\w+)\)', main_py))
        for op, entry in self.FIXTURE["steps"].items():
            method = entry["method"]
            assert method in registered, f"{op}: {method} is not a registered method"
            fn = _STEPS[op][0]
            assert registered[method] == fn.__name__, op
            # The symbol comparison is only sound while the handler is imported
            # under its own name.
            assert f" as {registered[method]}" not in main_py, op


#: One page of PostScript. Create PDF distills it through Ghostscript.
POSTSCRIPT = (
    "%!PS-Adobe-3.0\n/Helvetica findfont 24 scalefont setfont\n"
    "72 720 moveto (page) show\nshowpage\n"
)

#: The evaluator's test vectors, shared with the command line's own rules.
VECTORS = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "gs-need-vectors.json").read_text(
        encoding="utf-8"
    )
)["vectors"]


class TestGhostscriptNeed:
    """`step_gs_need` is the one evaluator of what a step needs from
    Ghostscript. `tests/fixtures/gs-need-vectors.json` holds its vectors, and
    `src-tauri/src/cli.rs` requires its own rules for the same operations to
    answer them too."""

    @pytest.mark.parametrize(
        "vector", VECTORS, ids=[f"{v['op']}-{i}" for i, v in enumerate(VECTORS)]
    )
    def test_the_evaluator_answers_every_vector(self, vector):
        need = step_gs_need(
            vector["op"],
            vector["params"],
            asked=vector.get("asked", ()),
            sources=vector.get("sources"),
        )
        assert need == vector["need"]

    def test_the_vectors_name_every_step_and_every_need(self):
        assert {v["op"] for v in VECTORS} == set(_STEPS)
        assert {v["need"] for v in VECTORS} == {
            GS_NEVER,
            GS_OPTIONAL,
            GS_REQUIRED,
            GS_UNDECIDED,
        }

    def test_a_step_needs_ghostscript_only_when_it_is_handed_a_path(self):
        for op, spec in _STEPS.items():
            assert (spec.gs is _gs_never) == ("gs_path" not in spec.tools), op

    def test_a_run_needs_what_its_rows_need(self):
        assert items_gs_need([]) == GS_NEVER
        assert items_gs_need([GS_NEVER, GS_NEVER]) == GS_NEVER
        assert items_gs_need([GS_REQUIRED, GS_REQUIRED]) == GS_REQUIRED
        assert items_gs_need([GS_NEVER, GS_REQUIRED]) == GS_OPTIONAL
        assert items_gs_need([GS_REQUIRED, GS_UNDECIDED]) == GS_UNDECIDED


class TestGhostscriptPlan:
    """`run_action(plan=True)`: what a run needs, before any of it runs. The
    window and the command line read it to hand a run its Ghostscript."""

    def test_a_plan_names_the_need_of_each_step_and_of_the_run(self):
        plan = run_action(
            "",
            "",
            [{"op": "optimize"}, {"op": "search_redact", "params": {"query": "x"}}],
            plan=True,
        )
        assert plan == {
            "gs": GS_OPTIONAL,
            "steps": [
                {"op": "optimize", "gs": GS_NEVER},
                {"op": "search_redact", "gs": GS_OPTIONAL},
            ],
        }
        assert plan_gs([{"op": "optimize"}])["gs"] == GS_NEVER
        assert plan_gs([])["gs"] == GS_NEVER
        assert plan_gs([{"op": "search_redact"}, {"op": "compress"}])["gs"] == GS_REQUIRED

    def test_a_value_the_run_collects_later_leaves_the_plan_undecided(self):
        steps = [{"op": "export_document", "params": {"fmt": "pptx"}, "ask": ["fmt"]}]
        assert plan_gs(steps)["gs"] == GS_UNDECIDED
        steps[0]["ask"] = []
        assert plan_gs(steps)["gs"] == GS_REQUIRED
        # Without a folder, a source step has no files to decide from.
        assert plan_gs([{"op": "create_pdf"}])["gs"] == GS_UNDECIDED
        # The most demanding step decides the run.
        assert plan_gs([{"op": "create_pdf"}, {"op": "grayscale"}])["gs"] == GS_REQUIRED
        assert plan_gs([{"op": "create_pdf"}, {"op": "search_redact"}])["gs"] == GS_UNDECIDED

    def test_a_plan_refuses_what_is_not_a_step(self):
        for steps, message in (
            ("compress", "no steps"),
            ([{"op": 7}], "not a step object"),
            ([{"op": "no_such_step"}], "unknown operation"),
            ([{"op": "compress", "params": ["quality"]}], "params must be an object"),
            ([{"op": "compress", "ask": "fmt"}], "not a step object"),
        ):
            with pytest.raises(ValueError, match=message):
                plan_gs(steps)

    def test_a_folder_plan_decides_a_source_step_from_each_file(self, tmp_path):
        folders = {
            "postscript": ("a.ps", "b.eps"),
            "mixed": ("a.ps", "b.pdf"),
            "plain": ("b.pdf",),
        }
        for name, files in folders.items():
            folder = tmp_path / name
            folder.mkdir()
            for file in files:
                if file.endswith(".pdf"):
                    _pdf(folder / file)
                else:
                    (folder / file).write_text(POSTSCRIPT, encoding="ascii")
        steps = [{"op": "create_pdf"}]
        assert run_action(str(tmp_path / "postscript"), "", steps, plan=True)["gs"] == GS_REQUIRED
        assert run_action(str(tmp_path / "mixed"), "", steps, plan=True)["gs"] == GS_OPTIONAL
        assert run_action(str(tmp_path / "plain"), "", steps, plan=True)["gs"] == GS_NEVER

    def test_a_folder_plan_groups_the_files_as_the_run_does(self, tmp_path):
        (tmp_path / "one").mkdir()
        (tmp_path / "two").mkdir()
        (tmp_path / "one" / "page2.ps").write_text(POSTSCRIPT, encoding="ascii")
        _png(tmp_path / "one" / "page1.png")
        _png(tmp_path / "two" / "page1.png")
        every = [{"op": "create_pdf_folders", "params": {"sources": "all"}}]
        images = [{"op": "create_pdf_folders", "params": {"sources": "images"}}]
        assert run_action(str(tmp_path), "", every, plan=True)["gs"] == GS_OPTIONAL
        assert run_action(str(tmp_path), "", images, plan=True)["gs"] == GS_NEVER
        assert run_action(str(tmp_path / "one"), "", every, plan=True)["gs"] == GS_REQUIRED

    def test_a_folder_plan_validates_as_the_run_does_and_writes_nothing(self, tree, tmp_path):
        with pytest.raises(ValueError, match="name the export format"):
            run_action(str(tree), "", [{"op": "export_document", "params": {}}], plan=True)
        with pytest.raises(ValueError, match="Source folder not found"):
            run_action(str(tmp_path / "missing"), "", [{"op": "optimize"}], plan=True)
        before = sorted(str(p) for p in tree.rglob("*"))
        dest, logs = tmp_path / "out", tmp_path / "logs"
        plan = run_action(
            str(tree), str(dest), [{"op": "compress"}], log_dir=str(logs), plan=True
        )
        assert plan["gs"] == GS_REQUIRED
        assert not dest.exists() and not logs.exists()
        assert sorted(str(p) for p in tree.rglob("*")) == before


class TestGhostscriptBeforeTheRun:
    """A run that cannot finish without Ghostscript never starts. A step whose
    parameters need it, or a folder whose every row needs it, refuses before
    the first row; a row that alone needs it refuses by name."""

    def test_a_step_that_always_needs_ghostscript_refuses_before_the_first_row(
        self, tree, tmp_path, gs_absent
    ):
        dest = tmp_path / "out"
        with pytest.raises(gs_capability.GsUnavailable):
            run_action(
                str(tree), str(dest), [{"op": "optimize"}, {"op": "grayscale"}], write_log=False
            )
        assert not dest.exists()

    def test_a_parameter_that_needs_ghostscript_refuses_before_the_first_row(
        self, text_tree, tmp_path, gs_absent
    ):
        dest = tmp_path / "out"
        slides = [{"op": "strip_metadata"}, {"op": "export_document", "params": {"fmt": "pptx"}}]
        with pytest.raises(gs_capability.GsUnavailable):
            run_action(str(text_tree), str(dest), slides, write_log=False)
        assert not dest.exists()
        text = [{"op": "strip_metadata"}, {"op": "export_document", "params": {"fmt": "txt"}}]
        report = run_action(str(text_tree), str(dest), text, write_log=False)
        assert (report["ok"], report["failed"]) == (2, 0), report

    def test_a_folder_whose_every_file_needs_ghostscript_refuses_before_it_starts(
        self, tmp_path, gs_absent
    ):
        src = tmp_path / "in"
        src.mkdir()
        (src / "a.ps").write_text(POSTSCRIPT, encoding="ascii")
        (src / "b.eps").write_text(POSTSCRIPT, encoding="ascii")
        dest = tmp_path / "out"
        with pytest.raises(gs_capability.GsUnavailable):
            run_action(str(src), str(dest), [{"op": "create_pdf"}], write_log=False)
        assert not dest.exists()

    def test_a_file_that_needs_ghostscript_refuses_by_name_and_the_others_run(
        self, tmp_path, gs_absent
    ):
        src = tmp_path / "in"
        src.mkdir()
        (src / "a.ps").write_text(POSTSCRIPT, encoding="ascii")
        _pdf(src / "b.pdf")
        dest = tmp_path / "out"
        report = run_action(str(src), str(dest), [{"op": "create_pdf"}], write_log=False)
        rows = {r["rel"]: r for r in report["results"]}
        assert rows["b.pdf"]["status"] == "ok"
        assert rows["a.ps"]["status"] == "error"
        assert "Ghostscript" in rows["a.ps"]["error"]
        assert (dest / "b.pdf").is_file()
        assert not (dest / "a.ps.pdf").exists()

    def test_a_folder_of_folders_is_decided_per_folder(self, tmp_path, gs_absent):
        root = tmp_path / "in"
        (root / "one").mkdir(parents=True)
        (root / "two").mkdir()
        (root / "one" / "page.ps").write_text(POSTSCRIPT, encoding="ascii")
        _png(root / "two" / "page.png")
        steps = [{"op": "create_pdf_folders", "params": {"sources": "all"}}]
        report = run_action(str(root), str(tmp_path / "out"), steps, write_log=False)
        rows = {r["rel"]: r for r in report["results"]}
        assert rows["two.pdf"]["status"] == "ok"
        assert rows["one.pdf"]["status"] == "error"
        assert "Ghostscript" in rows["one.pdf"]["error"]
        with pytest.raises(gs_capability.GsUnavailable):
            run_action(str(root / "one"), str(tmp_path / "out2"), steps, write_log=False)
        assert not (tmp_path / "out2").exists()


class TestStepsThatRunWithoutGhostscript:
    """A step whose content decides its need runs with no Ghostscript.

    The window and the command line start such a run without one, so the
    evaluator's `GS_OPTIONAL` is a promise about the callable. Every step that
    makes it for its defaults carries a request here over content that needs
    no Ghostscript, and the input whose content does need one refuses by name
    while the rest of the run goes on.
    """

    @staticmethod
    def _text_pdf(path: Path) -> None:
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(612, 792))
        page.Resources = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(
                F1=doc.make_indirect(
                    pikepdf.Dictionary(
                        Type=pikepdf.Name.Font,
                        Subtype=pikepdf.Name.Type1,
                        BaseFont=pikepdf.Name("/Helvetica"),
                        Encoding=pikepdf.Name.WinAnsiEncoding,
                    )
                )
            )
        )
        page.Contents = doc.make_stream(
            b"BT /F1 18 Tf 40 700 Td (Contact Jane Roe at once) Tj ET "
            b"BT /F1 18 Tf 40 600 Td (Name: ______________________) Tj ET"
        )
        doc.save(path)
        doc.close()

    @staticmethod
    def _scan_pdf(path: Path) -> None:
        """One page covered by a greyscale image this build decodes."""
        width, height = 850, 1100
        rows = b"".join(b"\x00" + b"\xf0" * width for _ in range(height))
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(612, 792))
        image = doc.make_stream(
            zlib.compress(rows),
            Type=pikepdf.Name.XObject,
            Subtype=pikepdf.Name.Image,
            Width=width,
            Height=height,
            ColorSpace=pikepdf.Name.DeviceGray,
            BitsPerComponent=8,
            Filter=pikepdf.Name.FlateDecode,
            DecodeParms=pikepdf.Dictionary(
                Predictor=15, Colors=1, BitsPerComponent=8, Columns=width
            ),
        )
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image))
        page.Contents = doc.make_stream(b"q 612 0 0 792 0 0 cm /Im0 Do Q")
        doc.save(path)
        doc.close()

    REQUESTS = {
        "search_redact": ("_text_pdf", {"query": "Jane Roe"}),
        "ocr_file": ("_text_pdf", {}),
        "enhance_scan": ("_scan_pdf", {"orientation": False}),
        "preflight": ("_text_pdf", {"profile": "digital_printing"}),
        "prepare_forms": ("_text_pdf", {}),
    }

    def test_every_step_whose_content_decides_runs_without_ghostscript(
        self, tmp_path, gs_absent
    ):
        declared = sorted(op for op in _STEPS if step_gs_need(op) == GS_OPTIONAL)
        assert declared == sorted(self.REQUESTS)
        for op in declared:
            builder, params = self.REQUESTS[op]
            src = tmp_path / op / "in"
            src.mkdir(parents=True)
            getattr(self, builder)(src / "a.pdf")
            dest = tmp_path / op / "out"
            report = run_action(
                str(src), str(dest), [{"op": op, "params": params}], write_log=False
            )
            assert (report["ok"], report["failed"]) == (1, 0), (op, report)
            assert (dest / "a.pdf").is_file(), op

    def test_a_redaction_removes_the_words_without_ghostscript(self, tmp_path, gs_absent):
        src = tmp_path / "in"
        src.mkdir()
        self._text_pdf(src / "a.pdf")
        dest = tmp_path / "out"
        steps = [{"op": "search_redact", "params": {"query": "Jane Roe"}}]
        report = run_action(str(src), str(dest), steps, write_log=False)
        assert (report["ok"], report["failed"]) == (1, 0), report
        assert "Jane Roe" not in extract_text(str(dest / "a.pdf"))["text"]

    def test_the_input_that_needs_ghostscript_refuses_by_name(
        self, tmp_path, gs_absent, monkeypatch
    ):
        # A codestream this build cannot decode is rendered through
        # Ghostscript instead; only the file that carries one needs it.
        lift = enhance_scan_module._lift

        def undecodable_in_b(pdf, page, candidate):
            if Path(pdf.filename).name == "b.pdf":
                return None, "/JPXDecode"
            return lift(pdf, page, candidate)

        monkeypatch.setattr(enhance_scan_module, "_lift", undecodable_in_b)
        src = tmp_path / "in"
        src.mkdir()
        self._scan_pdf(src / "a.pdf")
        self._scan_pdf(src / "b.pdf")
        dest = tmp_path / "out"
        steps = [{"op": "enhance_scan", "params": {"orientation": False}}]
        report = run_action(str(src), str(dest), steps, write_log=False)
        rows = {r["rel"]: r for r in report["results"]}
        assert rows["a.pdf"]["status"] == "ok"
        assert rows["b.pdf"]["status"] == "error"
        assert "Ghostscript" in rows["b.pdf"]["error"]
        assert (dest / "a.pdf").is_file()
        assert not (dest / "b.pdf").exists()


class TestFolderGroupingSource:
    """The second source step: a run whose UNIT is a directory.

    A folder of page images is one document, so `create_pdf_folders` changes
    what the walk enumerates. Everything after it runs on the assembled PDF,
    which is what makes "one PDF per scan folder, then clean it up" a single
    unattended job rather than two runs with a manual step between them.
    """

    @pytest.fixture
    def scans(self, tmp_path):
        from PIL import Image

        root = tmp_path / "scans"
        for folder, count in (("invoice", 3), ("letter", 2)):
            (root / folder).mkdir(parents=True)
            for n in range(1, count + 1):
                Image.new("RGB", (120, 160), (255, 255, 255)).save(
                    root / folder / f"page{n}.png"
                )
        return root

    def test_each_folder_becomes_one_document(self, scans, tmp_path):
        dest = tmp_path / "out"
        report = run_action(
            source=str(scans),
            dest=str(dest),
            steps=[{"op": "create_pdf_folders", "params": {}}],
            write_log=False,
        )
        assert report["total"] == 2 and report["ok"] == 2
        with pikepdf.open(dest / "invoice.pdf") as pdf:
            assert len(pdf.pages) == 3
        with pikepdf.open(dest / "letter.pdf") as pdf:
            assert len(pdf.pages) == 2

    def test_later_steps_run_on_the_assembled_document(self, scans, tmp_path):
        dest = tmp_path / "out"
        report = run_action(
            source=str(scans),
            dest=str(dest),
            steps=[
                {"op": "create_pdf_folders", "params": {}},
                {"op": "strip_metadata", "params": {}},
            ],
            write_log=False,
        )
        assert report["ok"] == 2
        assert all(r["steps_applied"] == 2 for r in report["results"])
        with pikepdf.open(dest / "invoice.pdf") as pdf:
            assert pikepdf.Name.Info not in pdf.trailer

    def test_the_walk_parameters_never_reach_the_builder(self, scans, tmp_path):
        # `sources` and `include_subfolders` describe the WALK; create_pdf
        # takes neither, so passing them through would refuse every folder.
        report = run_action(
            source=str(scans),
            dest=str(tmp_path / "out"),
            steps=[
                {
                    "op": "create_pdf_folders",
                    "params": {"sources": "images", "include_subfolders": True},
                }
            ],
            write_log=False,
        )
        assert report["failed"] == 0

    def test_it_must_be_the_first_step(self):
        with pytest.raises(ValueError, match="first step"):
            validate_steps(
                [
                    {"op": "strip_metadata", "params": {}},
                    {"op": "create_pdf_folders", "params": {}},
                ]
            )

    def test_an_action_produces_its_document_once(self):
        with pytest.raises(ValueError, match="not both"):
            validate_steps(
                [
                    {"op": "create_pdf_folders", "params": {}},
                    {"op": "create_pdf", "params": {}},
                ]
            )

    def test_in_place_is_refused(self, scans):
        with pytest.raises(ValueError, match="In-place mode cannot start"):
            run_action(
                source=str(scans),
                dest="",
                steps=[{"op": "create_pdf_folders", "params": {}}],
                in_place=True,
                write_log=False,
            )

    def test_moving_processed_originals_is_refused(self, scans, tmp_path):
        # Its sources are whole FOLDERS; the per-file move would take part of
        # what a row consumed and leave the rest.
        with pytest.raises(ValueError, match="whole folders"):
            run_action(
                source=str(scans),
                dest=str(tmp_path / "out"),
                steps=[{"op": "create_pdf_folders", "params": {}}],
                move_processed_root=str(tmp_path / "done"),
                write_log=False,
            )
