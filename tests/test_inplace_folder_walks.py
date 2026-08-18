"""Writing back over the input, for the three doors that walk a FOLDER.

`test_inplace_staged_write` and `test_inplace_finish_staged` ask their
question of one document handed in twice. These three doors cannot be asked
that: they take a source folder, a destination folder and an `in_place` flag,
and the write over an input happens per file inside the walk. So the same
three properties are asked of the walk instead, once per door:

  * in place lands what a mirrored destination lands, file for file;
  * a file whose write dies keeps its bytes and leaves nothing staged beside
    it — and the walk's per-file isolation means the OTHER files still land,
    which is a claim the single-document families have no way to make;
  * one physical file under two names is one file: the staged copy replaces a
    directory ENTRY, so a second name for the original still reads as it did.
    A swap that copied would write through the link and into the original.

All three stage at `.<name>.inplace.tmp` beside the original, so "nothing
staged" is a claim about the whole tree rather than about one directory: the
sweep below looks for that suffix everywhere under the source root.

`tests/test_inplace_staged_write.py`'s `WALK_DOORS` holds each door to this
file by name, and its guard opens the citation rather than trusting it.
"""

import os
import shutil
from pathlib import Path

import pikepdf
import pytest

import engine.batch_ocr as batch_ocr_mod
import engine.guided_actions as guided_actions_mod
import engine.preflight_sweep as preflight_sweep_mod
from engine.batch_ocr import batch_ocr
from engine.extract_text import extract_text
from engine.guided_actions import run_action
from engine.preflight_sweep import run_preflight_sweep

import preflight_builders as builders

FIXTURES = Path(__file__).resolve().parent / "fixtures"
RESOURCES = FIXTURES.parent.parent / "resources"
GS = RESOURCES / "ghostscript" / "gswin64c.exe"
TESSERACT = RESOURCES / "tesseract" / "tesseract.exe"

#: What every one of these walks stages its working copy as.
STAGING_SUFFIX = ".inplace.tmp"


def _staged(root: Path) -> list:
    """Every staging file anywhere under the tree — the litter a walk that
    died mid-file leaves unless the run removes it."""
    return sorted(str(p.relative_to(root)) for p in root.rglob("*" + STAGING_SUFFIX))


def _hardlink(source: Path, alias: Path) -> Path:
    """A second name for one physical file, or a skip where the filesystem
    has no such thing."""
    try:
        os.link(str(source), str(alias))
    except (AttributeError, NotImplementedError, OSError) as exc:
        pytest.skip(f"this filesystem does not make hard links: {exc}")
    return alias


def _blank(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 300))
    pdf.save(str(path))
    pdf.close()
    return path


def _scan(path: Path) -> Path:
    """A scan carrying NO text layer — `scan-text.pdf` is built with an
    invisible one, so the sweep would report it as needing nothing and never
    reach the write this file is about."""
    source = FIXTURES / "scan-photo.pdf"
    if not source.is_file():
        pytest.skip("scan-photo.pdf not generated (tests/fixtures/make_scans.py)")
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, path)
    return path


def _ocr_layer_present(path: Path) -> bool:
    with pikepdf.open(str(path)) as pdf:
        xobjects = pdf.pages[0].obj.get("/Resources", {}).get("/XObject")
        return xobjects is not None and "/SpectraPDFOCR" in xobjects


needs_gs = pytest.mark.skipif(not GS.is_file(), reason="Ghostscript not vendored")
needs_tesseract = pytest.mark.skipif(
    not TESSERACT.is_file(), reason="Tesseract not vendored"
)


# ── run_action ─────────────────────────────────────────────────────────────


class TestRunActionInPlace:
    """The guided action, run over a folder with the originals replaced."""

    @pytest.fixture
    def tree(self, tmp_path):
        root = tmp_path / "src"
        _blank(root / "a.pdf")
        _blank(root / "sub" / "b.pdf")
        return root

    STEPS = [{"op": "watermark", "params": {"text": "WALKED"}}]

    def test_in_place_lands_what_a_mirrored_destination_lands(self, tree, tmp_path):
        """The mirror is the control: the same walk with a destination
        produces the deliverables the in-place walk must put over the
        originals."""
        control = tmp_path / "mirror"
        run_action(source=str(tree), dest=str(control), steps=self.STEPS)
        mirrored = {
            str(p.relative_to(control)): extract_text(file=str(p))["text"]
            for p in sorted(control.rglob("*.pdf"))
        }

        report = run_action(source=str(tree), dest="", steps=self.STEPS, in_place=True)

        assert report["in_place"] is True
        assert (report["ok"], report["failed"]) == (2, 0)
        landed = {
            str(p.relative_to(tree)): extract_text(file=str(p))["text"]
            for p in sorted(tree.rglob("*.pdf"))
        }
        assert landed == mirrored
        assert _staged(tree) == []

    def test_a_file_whose_write_dies_keeps_its_bytes_and_stages_nothing(
        self, tree, monkeypatch,
    ):
        """The read-back gate is the last call the staged file exists for, so
        a death there is a death inside the staged span. The file it refused
        keeps its bytes; the walk's per-file isolation means the other one
        still lands.
        """
        target = tree / "a.pdf"
        before = target.read_bytes()
        other = tree / "sub" / "b.pdf"
        other_before = other.read_bytes()
        targets: list = []
        real = guided_actions_mod._readable_output

        def die_for_one(path, *args, **kwargs):
            if Path(path).name.startswith("." + target.name):
                targets.append(str(path))
                raise OSError("the volume went away mid-write")
            return real(path, *args, **kwargs)

        monkeypatch.setattr(guided_actions_mod, "_readable_output", die_for_one)
        report = run_action(source=str(tree), dest="", steps=self.STEPS, in_place=True)

        # The write that died was the STAGED one. Without this the assertions
        # below hold for a write that never began.
        assert targets and targets[0] != str(target)
        assert report["failed"] == 1
        assert target.read_bytes() == before
        assert other.read_bytes() != other_before
        assert _staged(tree) == []

    def test_an_original_under_two_names_keeps_the_bytes_it_had(self, tree):
        """The staged copy replaces the NAME. A swap that copied would fill
        the original in chunks, and the second name would read whatever the
        copy wrote."""
        target = tree / "a.pdf"
        before = target.read_bytes()
        alias = _hardlink(target, tree.parent / "alias.pdf")

        run_action(source=str(tree), dest="", steps=self.STEPS, in_place=True)

        assert target.read_bytes() != before
        assert alias.read_bytes() == before


# ── run_preflight_sweep ────────────────────────────────────────────────────


def _profile() -> dict:
    return {
        "schema": 1,
        "id": "inplace_walk",
        "name": "In-place walk",
        "checks": {
            "ink_coverage_max": {"enabled": False},
            "embedded_files": {"allow": False},
        },
        "fixups": [{"id": "remove_attachments", "params": {}}],
    }


class TestPreflightSweepInPlace:
    """The droplet's fix mode, with the originals replaced."""

    @pytest.fixture
    def tree(self, tmp_path):
        root = tmp_path / "src"
        (root / "inner").mkdir(parents=True)
        builders.build("has_attachment", str(root), name="failing")
        builders.build("has_attachment", str(root / "inner"), name="nested")
        return root

    def _attachments(self, path: Path) -> int:
        with pikepdf.open(str(path)) as pdf:
            names = pdf.Root.get("/Names", {})
            embedded = (names or {}).get("/EmbeddedFiles")
            return 0 if embedded is None else len(list(embedded.get("/Names", [])))

    def test_in_place_lands_what_a_mirrored_destination_lands(self, tree, tmp_path):
        control = tmp_path / "mirror"
        run_preflight_sweep(str(tree), str(control), profile=_profile(),
                            mode="fix", write_log=False)
        mirrored = {
            str(p.relative_to(control)): self._attachments(p)
            for p in sorted(control.rglob("*.pdf"))
        }

        report = run_preflight_sweep(str(tree), "", profile=_profile(), mode="fix",
                                     in_place=True, write_log=False)

        assert report["total"] == 2
        assert all(row["applied"] == ["remove_attachments"] for row in report["results"])
        landed = {
            str(p.relative_to(tree)): self._attachments(p)
            for p in sorted(tree.rglob("*.pdf"))
        }
        assert landed == mirrored
        assert _staged(tree) == []

    def test_a_file_whose_write_dies_keeps_its_bytes_and_stages_nothing(
        self, tree, monkeypatch,
    ):
        target = tree / "failing.pdf"
        before = target.read_bytes()
        other = tree / "inner" / "nested.pdf"
        other_before = other.read_bytes()
        targets: list = []
        real = preflight_sweep_mod._readable_output

        def die_for_one(path, *args, **kwargs):
            if Path(path).name.startswith("." + target.name):
                targets.append(str(path))
                raise OSError("the volume went away mid-write")
            return real(path, *args, **kwargs)

        monkeypatch.setattr(preflight_sweep_mod, "_readable_output", die_for_one)
        report = run_preflight_sweep(str(tree), "", profile=_profile(), mode="fix",
                                     in_place=True, write_log=False)

        assert targets and targets[0] != str(target)
        assert [row["status"] for row in report["results"] if row["rel"] == "failing.pdf"] \
            == ["error"]
        assert target.read_bytes() == before
        assert other.read_bytes() != other_before
        assert _staged(tree) == []

    def test_an_original_under_two_names_keeps_the_bytes_it_had(self, tree):
        target = tree / "failing.pdf"
        before = target.read_bytes()
        alias = _hardlink(target, tree.parent / "alias.pdf")

        run_preflight_sweep(str(tree), "", profile=_profile(), mode="fix",
                            in_place=True, write_log=False)

        assert target.read_bytes() != before
        assert alias.read_bytes() == before


# ── batch_ocr ──────────────────────────────────────────────────────────────


@needs_gs
@needs_tesseract
class TestBatchOcrInPlace:
    """The batch sweep, with each original replaced by its searchable copy."""

    @pytest.fixture
    def tree(self, tmp_path):
        root = tmp_path / "src"
        _scan(root / "a.pdf")
        _scan(root / "sub" / "b.pdf")
        return root

    def test_in_place_lands_what_a_mirrored_destination_lands(self, tree, tmp_path):
        control = tmp_path / "mirror"
        batch_ocr(source=str(tree), dest=str(control),
                  gs_path=str(GS), tesseract_path=str(TESSERACT))
        mirrored = {
            str(p.relative_to(control)): p.read_bytes()
            for p in sorted(control.rglob("*.pdf"))
        }

        report = batch_ocr(source=str(tree), gs_path=str(GS),
                           tesseract_path=str(TESSERACT), in_place=True)

        assert [row["status"] for row in report["results"]] == ["ocr", "ocr"]
        assert all(row.get("inPlace") for row in report["results"])
        landed = {
            str(p.relative_to(tree)): p.read_bytes()
            for p in sorted(tree.rglob("*.pdf"))
        }
        assert landed == mirrored
        assert all(_ocr_layer_present(p) for p in tree.rglob("*.pdf"))
        assert _staged(tree) == []

    def test_a_file_whose_write_dies_keeps_its_bytes_and_stages_nothing(
        self, tree, monkeypatch,
    ):
        """The read-back verify runs on the staged file, before the swap, so
        a death there is a death inside the staged span."""
        target = tree / "a.pdf"
        before = target.read_bytes()
        other = tree / "sub" / "b.pdf"
        other_before = other.read_bytes()
        targets: list = []
        real = batch_ocr_mod._verify_output

        def die_for_one(path, *args, **kwargs):
            if Path(path).name.startswith("." + target.name):
                targets.append(str(path))
                raise OSError("the volume went away mid-write")
            return real(path, *args, **kwargs)

        monkeypatch.setattr(batch_ocr_mod, "_verify_output", die_for_one)
        report = batch_ocr(source=str(tree), gs_path=str(GS),
                           tesseract_path=str(TESSERACT), in_place=True)

        assert targets and targets[0] != str(target)
        by_rel = {row["rel"]: row for row in report["results"]}
        assert by_rel["a.pdf"]["status"] == "skipped"
        assert target.read_bytes() == before
        assert other.read_bytes() != other_before
        assert _staged(tree) == []

    def test_an_original_under_two_names_keeps_the_bytes_it_had(self, tree):
        target = tree / "a.pdf"
        before = target.read_bytes()
        alias = _hardlink(target, tree.parent / "alias.pdf")

        batch_ocr(source=str(tree), gs_path=str(GS),
                  tesseract_path=str(TESSERACT), in_place=True)

        assert target.read_bytes() != before
        assert alias.read_bytes() == before
