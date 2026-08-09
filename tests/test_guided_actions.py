"""Guided-actions folder runs: step validation, the mirror walk,
per-file isolation, logs — plus the encrypt/decrypt in-place pins the runner
forced (the same latent CLI bug class fixed for five other ops)."""

import json
import os
import pathlib
from pathlib import Path

import pikepdf
import pytest

from engine.encrypt import decrypt, encrypt
from engine.extract_text import extract_text
from engine.guided_actions import (
    _STEPS,
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
    `enhance_scan` drift this test exists for).
    """

    FIXTURE = json.loads(
        (pathlib.Path(__file__).parent / "fixtures" / "guided-step-catalog.json").read_text(
            encoding="utf-8"
        )
    )

    def test_the_op_names_match_the_fixture_in_both_directions(self):
        assert set(_STEPS) == set(self.FIXTURE["steps"])

    def test_every_op_accepts_exactly_the_parameters_the_fixture_names(self):
        for op, entry in self.FIXTURE["steps"].items():
            assert sorted(_STEPS[op][1]) == entry["params"], op

    def test_every_op_is_callable_with_its_declared_tool_paths(self):
        # The third element of a row is the tool-path set `_apply_steps`
        # injects; a name outside the run's own vocabulary would be passed as
        # an empty string to a keyword the callable does not take.
        known = {"gs_path", "tesseract_path", "soffice_path", "font_dir", "jbig2_path"}
        for op, (fn, _allowed, needed) in _STEPS.items():
            assert callable(fn), op
            assert set(needed) <= known, op


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
