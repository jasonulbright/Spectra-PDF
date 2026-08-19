"""The capability-absent axis: every Ghostscript door, with none configured.

This is not the same suite as `test_gs_capability.py`, which proves the
AUTHORITY answers correctly and spot-checks representative doors. This one is
a ROSTER: the doors are derived mechanically from the same sweep the guards
use (`gs_axis.gs_door_modules`), so the set under test is the set that
exists, and a new Ghostscript consumer cannot ship without an absent-state
answer — adding one makes `test_the_roster_covers_every_gs_door` fail with
the module's name in the diff.

Four things are asserted at every door, because three of the four failure
modes are silent:

* it REFUSES, by the named refusal (`GsUnavailable`) carrying its reason;
* it does not CRASH — nothing else escapes, and in particular no
  `FileNotFoundError` from a spawn that was attempted anyway;
* it does not SILENTLY SUCCEED — a door that returns a report is a door that
  produced something without an interpreter, which for these doors means it
  produced something wrong;
* it leaves NO PARTIAL OUTPUT. A refusal that has already written half a
  file hands the user a document that opens and is incomplete, which is the
  worst of the four: it looks like the operation worked.

The whole roster runs on every machine. The force is applied to the
authority's discovery and probe, so a developer box with a working
Ghostscript exercises the same code path as one without.
"""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import pikepdf
import pytest
from pikepdf import Dictionary, Name

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import gs_axis  # noqa: E402
import preflight_builders as builders  # noqa: E402
from engine import gs_capability as gc  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"


# ── What a door is given ──────────────────────────────────────────────────


@dataclass(frozen=True)
class Bench:
    """One door's inputs and its own empty output directory.

    Each door gets a directory nothing else writes to, so "left a partial
    output behind" is answerable by listing it rather than by knowing which
    name each door would have chosen.
    """

    pdf: str
    transparent: str
    postscript: str
    out: Path

    def target(self, name: str) -> str:
        return str(self.out / name)


@pytest.fixture
def bench(tmp_path) -> Bench:
    pdf = tmp_path / "work.pdf"
    shutil.copy2(FIXTURES / "sample.pdf", pdf)
    out = tmp_path / "out"
    out.mkdir()
    return Bench(
        pdf=str(pdf),
        transparent=_transparent_pdf(tmp_path),
        postscript=_postscript(tmp_path),
        out=out,
    )


def _transparent_pdf(directory: Path) -> str:
    """A page whose flattening actually needs a rasterizer.

    `sample.pdf` has no transparency, and the flattener correctly does no
    Ghostscript work on a page with none — a roster row driven by it would
    assert a refusal that never had to happen, and would keep passing after
    the refusal was removed.
    """
    path = directory / "transparent.pdf"
    doc = pikepdf.new()
    state = doc.make_indirect(Dictionary(Type=Name.ExtGState, ca=0.5))
    builders.add_page(
        doc,
        Dictionary(ExtGState=Dictionary(GS0=state)),
        b"q /GS0 gs 1 0 0 rg 100 100 300 300 re f Q\n"
        b"q 0 0 1 rg 200 200 300 300 re f Q\n",
    )
    doc.save(str(path))
    return str(path)


def _postscript(directory: Path) -> str:
    """Distilling refuses a PDF before it ever asks about Ghostscript."""
    path = directory / "page.ps"
    path.write_text(
        "%!PS-Adobe-3.0\n/Helvetica findfont 24 scalefont setfont\n"
        "72 72 moveto (roster) show\nshowpage\n",
        encoding="ascii",
    )
    return str(path)


# ── The roster ────────────────────────────────────────────────────────────
#
# One row per door module the sweep finds. The call has to reach the door's
# GHOSTSCRIPT LEG: several of these doors do real work that needs no
# interpreter, and a row that stops short of the leg proves nothing.


def _compare(b: Bench) -> object:
    from engine.compare import compare_visual

    return compare_visual(b.pdf, b.pdf)


def _compress(b: Bench) -> object:
    from engine.compress import compress

    return compress(b.pdf, b.target("out.pdf"))


def _distill(b: Bench) -> object:
    from engine.distill import distill

    return distill(b.postscript, b.target("out.pdf"))


def _flattener(b: Bench) -> object:
    from engine.flattener import flatten_transparency

    return flatten_transparency(b.transparent, b.target("out.pdf"))


def _grayscale(b: Bench) -> object:
    from engine.grayscale import grayscale

    return grayscale(b.pdf, b.target("out.pdf"))


def _image_export(b: Bench) -> object:
    from engine.image_export import export_images

    return export_images(b.pdf, b.target("page.png"))


def _mrc(b: Bench) -> object:
    from engine.mrc import mrc_compress

    return mrc_compress(b.pdf, b.target("out.pdf"))


def _mrc_codecs(b: Bench) -> object:
    # Rule 4's decoder: an unverified stencil is not shippable, so the
    # verification refuses rather than passing the mask through unchecked.
    from engine.mrc_codecs import MaskStream, verify_mask_stream

    stream = MaskStream(
        data=b"", codec="ccitt", width=8, height=8, decode=None,
        decode_parms=None, globals_data=None, ink_fraction=0.1,
    )
    return verify_mask_stream(stream, "")


def _object_inspector(b: Bench) -> object:
    # The public door refuses earlier, on the plate set. The Ghostscript leg
    # is the paint test, which is what this row has to reach.
    from engine import object_inspector as inspector

    with pikepdf.open(b.transparent) as pdf:
        page = pdf.pages[0]
        box = inspector._view_box(page)
        walk = inspector._Walk(pdf, page)
        walk.run()
        units: list = []
        for entry in walk.objects:
            if entry["unit"] not in units:
                units.append(entry["unit"])
        x = (box[0] + box[2]) / 2
        y = (box[1] + box[3]) / 2
        return inspector._painting_units(
            pdf, page, units, units[:1], x, y, box, "", b.transparent
        )


def _pdfa(b: Bench) -> object:
    from engine.pdfa import convert_pdfa

    return convert_pdfa(b.pdf, b.target("out.pdf"))


def _prepress(b: Bench) -> object:
    from engine.prepress import convert_cmyk

    return convert_cmyk(b.pdf, b.target("out.pdf"))


def _print_layout(b: Bench) -> object:
    from engine.print_layout import flatten_pdf

    return flatten_pdf("", b.pdf, b.target("out.pdf"))


def _printer(b: Bench) -> object:
    # Decided before the copies loop: one refusal, not one per copy.
    from engine.printer import print_pdf

    return print_pdf(b.pdf, "Microsoft Print to PDF", copies=3)


def _rebuild(b: Bench) -> object:
    from engine.rebuild import rebuild

    return rebuild(b.pdf, b.target("out.pdf"))


def _recognize(b: Bench) -> object:
    from engine.recognize import _render_page_png

    return _render_page_png(b.pdf, 1, "", Path(b.target("page.png")))


def _separations(b: Bench) -> object:
    from engine.separations import render_separations

    return render_separations(b.pdf, page=1)


def _slide_export(b: Bench) -> object:
    from engine.slide_export import _render_background

    return _render_background(b.pdf, 1, "", Path(b.target("page.png")))


def _trapping(b: Bench) -> object:
    from engine.trapping import export_postscript

    return export_postscript(b.pdf, b.target("out.ps"))


ROSTER: dict[str, Callable[[Bench], object]] = {
    "compare": _compare,
    "compress": _compress,
    "distill": _distill,
    "flattener": _flattener,
    "grayscale": _grayscale,
    "image_export": _image_export,
    "mrc": _mrc,
    "mrc_codecs": _mrc_codecs,
    "object_inspector": _object_inspector,
    "pdfa": _pdfa,
    "prepress": _prepress,
    "print_layout": _print_layout,
    "printer": _printer,
    "rebuild": _rebuild,
    "recognize": _recognize,
    "separations": _separations,
    "slide_export": _slide_export,
    "trapping": _trapping,
}


# ── The derivation ────────────────────────────────────────────────────────


def test_the_roster_covers_every_gs_door():
    """The roster IS the sweep's answer, not a list somebody remembered.

    A new module that drives Ghostscript joins `gs_door_modules()` the
    moment it builds a command or requires the capability. If it has no
    roster row, this fails naming it — which is the only mechanism that
    keeps "every door has an absent-state answer" true over time.
    """
    assert sorted(ROSTER) == sorted(gs_axis.gs_door_modules())


def test_the_derivation_finds_a_new_door(tmp_path, monkeypatch):
    """The sweep is not a hard-coded list: a module it has never seen, with
    the shape of a door, is found. Proven against a throwaway engine
    directory so the assertion cannot be satisfied by the real one."""
    fake = tmp_path / "engine"
    fake.mkdir()
    (fake / "newcomer.py").write_text(
        "def render(src, gs_path=''):\n"
        "    cmd = [gs_path, '-q', '-dBATCH']\n"
        "    return budget.gs(cmd, what='x', path=src)\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(gs_axis, "ENGINE_DIR", fake)
    assert gs_axis.gs_door_modules() == ["newcomer"]


# ── The absent-state answer, per door ─────────────────────────────────────


@pytest.mark.parametrize("door", sorted(ROSTER))
def test_every_gs_door_refuses_by_name(door, bench, gs_absent):
    """Refuses, with the reason attached — never a spawn failure."""
    with pytest.raises(gc.GsUnavailable) as caught:
        ROSTER[door](bench)
    assert caught.value.reason in {
        gc.NOT_CONFIGURED,
        gc.NOT_EXECUTABLE,
    }, (door, caught.value.reason)
    assert "Ghostscript" in str(caught.value)
    assert "ghostscript.com" in str(caught.value)


@pytest.mark.parametrize("door", sorted(ROSTER))
def test_no_gs_door_leaves_a_partial_output(door, bench, gs_absent):
    """Nothing in the output directory after the refusal.

    A door that has already written its destination before it discovers it
    cannot finish leaves a file that opens — the failure mode a user cannot
    tell from success.
    """
    with pytest.raises(gc.GsUnavailable):
        ROSTER[door](bench)
    assert sorted(p.name for p in bench.out.iterdir()) == []


@pytest.mark.parametrize("door", sorted(ROSTER))
def test_no_gs_door_reports_success(door, bench, gs_absent):
    """A returned report is a silent success — the roster's whole point.

    Spelled separately from the refusal assertion because the two fail for
    different reasons: this one fails when a door starts SWALLOWING the
    refusal (a broad `except RuntimeError` that turns it into an empty
    result), which the raises-assertion alone would report as the same red.
    """
    outcome: object = None
    try:
        outcome = ROSTER[door](bench)
    except gc.GsUnavailable:
        return
    pytest.fail(f"{door} produced a result with no Ghostscript: {outcome!r}")


# ── The shapes that are not a raise ───────────────────────────────────────


def test_a_folder_walk_reports_the_refusal_as_a_row(tmp_path, gs_absent):
    """The folder tier isolates per folder, so its shape is a ROW.

    Asserted on the absent axis rather than with a bogus path because the
    two arrive by different routes: a bogus path fails discovery's
    successor, an absent capability fails discovery itself, and the row has
    to carry the named reason either way.
    """
    from engine.create_pdf_folders import create_pdf_folders

    source = tmp_path / "src" / "job"
    source.mkdir(parents=True)
    (source / "page.ps").write_text(
        "%!PS\n/Helvetica findfont 24 scalefont setfont\n"
        "72 72 moveto (row) show showpage\n",
        encoding="ascii",
    )
    report = create_pdf_folders(
        str(source.parent), str(tmp_path / "out"), sources="all", write_log=False
    )
    errors = [row for row in report["results"] if row["status"] == "error"]
    assert errors, report
    assert "Ghostscript" in errors[0]["error"]


def test_a_preflight_measurement_reports_rather_than_passes(tmp_dir, gs_absent):
    """The one check that measures THROUGH Ghostscript says so.

    A check that passes because the tool it needed was missing is a wrong
    result, not a degraded one, so the absent axis asserts `needs_review`
    with the named finding rather than a pass.
    """
    from engine.preflight import preflight

    profile = {"schema": 1, "id": "t", "name": "T",
               "checks": {"ink_coverage_max": {"enabled": True}}}
    report = preflight(builders.build("tac_360", tmp_dir), profile=profile)
    row = next(r for r in report["checks"] if r["id"] == "ink_coverage_max")
    assert row["status"] == "needs_review"
    assert [f["detail_key"] for f in row["findings"]] == ["tac_not_measured"]


# ── The mechanism itself ──────────────────────────────────────────────────


def test_the_absent_axis_holds_against_every_route_to_an_answer(gs_absent):
    """PATH, the environment override and an explicit path all answer "no".

    The reason the force is applied to discovery and the probe rather than
    to PATH: three of these four routes never consult PATH at all, so a
    PATH-based absent axis would prove nothing about them.
    """
    assert gc.resolve("").reason == gc.NOT_CONFIGURED
    assert gc.resolve("gswin64c").reason == gc.NOT_EXECUTABLE
    assert gc.resolve(r"C:\Program Files\gs\gs99\bin\gswin64c.exe").reason == (
        gc.NOT_EXECUTABLE
    )
    with pytest.raises(gc.GsUnavailable):
        gc.require("")


def test_the_absent_axis_runs_where_a_ghostscript_exists(gs_absent):
    """Whatever this machine has, the axis is absent inside the fixture and
    the machine's own answer is back once it lifts — the property that lets
    both axes run in one session."""
    assert not gc.resolve("").available


def test_the_present_axis_keys_on_the_authority():
    """The present axis's skip is the authority's answer, not a directory.

    If this ever keys on a vendored path again, the whole present axis
    silently skips the moment the tree stops shipping — which is the change
    this remediation is making.
    """
    if gs_axis.GS_AVAILABLE:
        assert gc.resolve(gs_axis.GS_PATH).available
    else:
        assert gs_axis.GS_PATH == ""
