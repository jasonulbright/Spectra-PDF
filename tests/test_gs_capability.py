"""The Ghostscript capability authority, and the chokepoint that consults it.

Two things are under test and they are not the same thing: that ONE module
answers "is a usable Ghostscript configured?" by probing rather than by file
existence, and that a gs run with no usable Ghostscript leaves the engine as
ONE named refusal rather than as a spawn failure at whichever door was asked.
"""

import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import gs_axis  # noqa: E402
from engine import budget, gs_capability as gc  # noqa: E402

#: The Ghostscript the present axis drives — the authority's own answer for
#: this machine, never a path this file goes looking for.
GS = gs_axis.GS_PATH

needs_gs = gs_axis.requires_gs


@pytest.fixture(autouse=True)
def clean_capability_cache(monkeypatch):
    """Every test starts with no probed answers and no ambient override."""
    monkeypatch.delenv(gc.PATH_ENV_VAR, raising=False)
    gc.clear_cache()
    yield
    gc.clear_cache()


def stub_gs(directory, version_line, *, renders=False):
    """A fake `gs` that answers --version and (optionally) nothing else."""
    stub = os.path.join(directory, "gswin64c.cmd")
    body = f"@if \"%1\"==\"--version\" echo {version_line}\r\n"
    if not renders:
        body += "@if not \"%1\"==\"--version\" exit /b 1\r\n"
    with open(stub, "w", encoding="ascii", newline="") as handle:
        handle.write(body)
    return stub


# ── Version comparison ────────────────────────────────────────────────────


def test_version_reads_a_zero_padded_minor_as_a_value():
    assert gc.parse_version("10.07.1") == (10, 7, 1)
    assert gc.parse_version("9.50") == (9, 50)
    assert gc.parse_version("GPL Ghostscript 10.02.1") == (10, 2, 1)
    assert gc.parse_version("") == ()


def test_the_floor_rejects_the_whole_nine_series():
    # 9.50's minor is 50 — larger than 10.0's 0. The comparison is on the
    # PAIR, and a minor-only comparison would call 9.50 newer than 10.0.
    assert gc.parse_version("9.50")[:2] < gc.MINIMUM_VERSION
    assert gc.parse_version("10.0.0")[:2] >= gc.MINIMUM_VERSION
    assert gc.parse_version("10.07.1")[:2] >= gc.MINIMUM_VERSION


# ── Probing ───────────────────────────────────────────────────────────────


@needs_gs
def test_a_real_ghostscript_probes_available_with_its_version():
    answer = gc.probe(GS)
    assert answer.available
    assert answer.reason == ""
    assert gc.parse_version(answer.version)[:2] >= gc.MINIMUM_VERSION
    assert answer.path == GS


def test_nothing_configured_is_its_own_reason():
    answer = gc.probe("")
    assert not answer.available
    assert answer.reason == gc.NOT_CONFIGURED


def test_a_path_to_nothing_is_not_executable(tmp_path):
    answer = gc.probe(str(tmp_path / "gswin64c.exe"))
    assert not answer.available
    assert answer.reason == gc.NOT_EXECUTABLE


def test_a_directory_is_not_a_program(tmp_path):
    answer = gc.probe(str(tmp_path))
    assert not answer.available
    assert answer.reason == gc.NOT_EXECUTABLE


def test_a_file_that_is_not_a_program_fails_the_probe(tmp_path):
    fake = tmp_path / "gswin64c.exe"
    fake.write_bytes(b"not a program")
    answer = gc.probe(str(fake))
    assert not answer.available
    assert answer.reason == gc.PROBE_FAILED


def test_an_older_build_is_refused_by_version_not_by_rendering(tmp_path):
    stub = stub_gs(str(tmp_path), "9.50")
    answer = gc.probe(stub)
    assert not answer.available
    assert answer.reason == gc.VERSION_BELOW_MINIMUM
    assert answer.version == "9.50"


def test_a_new_enough_build_that_cannot_render_is_still_refused(tmp_path):
    # THE reason this module exists: a file can exist, be executable, and
    # report a modern version while being unable to render a page (a copied
    # exe without its Resource tree). Existence and --version both pass here.
    stub = stub_gs(str(tmp_path), "10.07.1")
    answer = gc.probe(stub)
    assert not answer.available
    assert answer.reason == gc.PROBE_FAILED


def test_the_answer_is_cached_per_path_and_remint_on_clear(tmp_path, monkeypatch):
    stub = stub_gs(str(tmp_path), "9.50")
    assert gc.probe(stub).reason == gc.VERSION_BELOW_MINIMUM

    def explode(*_args, **_kwargs):
        raise AssertionError("a cached answer must not re-probe")

    monkeypatch.setattr(gc, "_run", explode)
    assert gc.probe(stub).reason == gc.VERSION_BELOW_MINIMUM

    gc.clear_cache()
    with pytest.raises(AssertionError):
        gc.probe(stub)


def test_a_replaced_binary_at_the_same_path_re_probes(tmp_path):
    stub = stub_gs(str(tmp_path), "9.50")
    assert gc.probe(stub).reason == gc.VERSION_BELOW_MINIMUM
    # Same path, different bytes: the key carries mtime and size, so the
    # stale answer cannot survive a reinstall over the top.
    os.utime(stub, (0, 0))
    stub_gs(str(tmp_path), "10.07.1")
    assert gc.probe(stub).reason == gc.PROBE_FAILED


# ── Discovery and resolution ──────────────────────────────────────────────


@needs_gs
def test_the_environment_override_is_discovered(monkeypatch, tmp_path):
    monkeypatch.setenv(gc.PATH_ENV_VAR, GS)
    monkeypatch.setattr(gc.shutil, "which", lambda *_a, **_k: None)
    answer = gc.resolve("")
    assert answer.available
    assert answer.path == GS


def test_an_explicit_failure_never_falls_through_to_discovery(tmp_path, monkeypatch):
    # A machine with a working Ghostscript elsewhere must not silently answer
    # for the path the user actually named — a settings screen that reports
    # one path while the run used another is lying.
    monkeypatch.setattr(gc, "discover", lambda: [GS])
    named = str(tmp_path / "gswin64c.exe")
    answer = gc.resolve(named)
    assert not answer.available
    assert answer.path == named


def test_a_bare_name_resolves_through_path_before_anything_spawns(monkeypatch, tmp_path):
    stub = stub_gs(str(tmp_path), "9.50")
    monkeypatch.setattr(gc.shutil, "which", lambda name: stub if name else None)
    answer = gc.resolve("gs")
    # The old `or "gs"` shape spawned the bare name blind. It now resolves to
    # a real path and is judged like any other candidate.
    assert answer.path == stub
    assert answer.reason == gc.VERSION_BELOW_MINIMUM


def test_no_candidate_at_all_is_not_configured(monkeypatch):
    monkeypatch.setattr(gc, "discover", lambda: [])
    answer = gc.resolve("")
    assert not answer.available
    assert answer.reason == gc.NOT_CONFIGURED


# ── The refusal ───────────────────────────────────────────────────────────


def test_require_raises_the_named_refusal_carrying_its_reason(monkeypatch):
    monkeypatch.setattr(gc, "discover", lambda: [])
    with pytest.raises(gc.GsUnavailable) as caught:
        gc.require("")
    assert caught.value.reason == gc.NOT_CONFIGURED
    assert "Ghostscript" in str(caught.value)
    assert "ghostscript.com" in str(caught.value)


def test_every_reason_has_its_own_message(tmp_path):
    missing = gc.probe(str(tmp_path / "gswin64c.exe"))
    old = gc.probe(stub_gs(str(tmp_path), "9.50"))
    unconfigured = gc.probe("")
    texts = {gc.message(a) for a in (missing, old, unconfigured)}
    assert len(texts) == 3
    assert gc._minimum_text() in gc.message(old)
    assert old.version in gc.message(old)


def test_describe_is_a_structured_answer(monkeypatch):
    monkeypatch.setattr(gc, "discover", lambda: [])
    payload = gc.describe("")
    assert payload["available"] is False
    assert payload["reason"] == gc.NOT_CONFIGURED
    assert payload["minimum_version"] == gc._minimum_text()
    assert "Ghostscript" in payload["message"]


# ── The chokepoint ────────────────────────────────────────────────────────


def test_the_chokepoint_refuses_before_it_spawns(tmp_path, monkeypatch):
    def explode(*_args, **_kwargs):
        raise AssertionError("nothing may spawn without a usable Ghostscript")

    monkeypatch.setattr(subprocess, "run", explode)
    with pytest.raises(gc.GsUnavailable):
        budget.gs(
            [str(tmp_path / "gswin64c.exe"), "--help"],
            what="probe",
            path=str(tmp_path),
        )


@needs_gs
def test_the_chokepoint_substitutes_the_validated_path(monkeypatch, tmp_path):
    monkeypatch.setenv(gc.PATH_ENV_VAR, GS)
    monkeypatch.setattr(gc.shutil, "which", lambda *_a, **_k: None)
    result = budget.gs(["", "--version"], what="probe", path=str(tmp_path))
    assert result.returncode == 0
    assert result.stdout.strip().startswith("10.")


def test_the_refusal_is_catchable_as_a_runtime_error(tmp_path):
    # Every per-file and per-folder handler in the engine catches broadly.
    # The refusal must land in those handlers as a reported row, which means
    # it has to stay inside the RuntimeError family.
    assert issubclass(gc.GsUnavailable, RuntimeError)
    with pytest.raises(RuntimeError):
        gc.require(str(tmp_path / "gswin64c.exe"))


# ── The doors ─────────────────────────────────────────────────────────────
#
# Detection is one edit at the chokepoint; these prove the refusal actually
# arrives at representative doors in each door's OWN error shape — a raised
# refusal where the door raises, a reported row where the door isolates per
# file — rather than as a spawn failure or a crash.


def test_compress_refuses_by_name(tmp_pdf, tmp_dir, tmp_path):
    from engine.compress import compress

    with pytest.raises(gc.GsUnavailable) as caught:
        compress(
            tmp_pdf,
            os.path.join(tmp_dir, "out.pdf"),
            gs_path=str(tmp_path / "gswin64c.exe"),
        )
    assert "Ghostscript" in str(caught.value)
    assert caught.value.reason == gc.NOT_EXECUTABLE


def test_pdfa_conversion_refuses_by_name(tmp_pdf, tmp_dir, tmp_path):
    from engine.pdfa import convert_pdfa

    with pytest.raises(gc.GsUnavailable):
        convert_pdfa(
            tmp_pdf,
            os.path.join(tmp_dir, "out.pdf"),
            gs_path=str(tmp_path / "gswin64c.exe"),
        )


def test_rebuild_refuses_by_name(tmp_pdf, tmp_dir, tmp_path):
    from engine.rebuild import rebuild

    with pytest.raises(gc.GsUnavailable):
        rebuild(tmp_pdf, os.path.join(tmp_dir, "out.pdf"), gs_path=str(tmp_path / "gswin64c.exe"))


def test_a_folder_run_reports_the_refusal_as_a_row(tmp_path):
    # create_pdf_folders isolates per folder, so its error shape is a ROW.
    # This is also the site that used to pass `gs_path or "gs"` — a bare name
    # spawned blind, which is why the failure used to be a FileNotFoundError.
    from engine.create_pdf_folders import create_pdf_folders

    source = tmp_path / "src" / "job"
    source.mkdir(parents=True)
    (source / "page.ps").write_text(
        "%!PS\n/Helvetica findfont 24 scalefont setfont\n"
        "72 72 moveto (hello) show showpage\n",
        encoding="ascii",
    )
    dest = tmp_path / "out"
    report = create_pdf_folders(
        str(source.parent),
        str(dest),
        sources="all",
        gs_path=str(tmp_path / "gswin64c.exe"),
        write_log=False,
    )
    rows = [row for row in report["results"] if row["status"] == "error"]
    assert rows, report
    assert "Ghostscript" in rows[0]["error"]


def test_a_bare_name_path_cannot_resolve_is_the_answer(monkeypatch):
    # Not a licence to go looking elsewhere: a run told to use `gs` must not
    # quietly succeed through some other install the machine happens to have.
    monkeypatch.setattr(gc.shutil, "which", lambda *_a, **_k: None)
    monkeypatch.setattr(gc, "discover", lambda: [GS])
    answer = gc.resolve("no-such-ghostscript")
    assert not answer.available
    assert answer.reason == gc.NOT_EXECUTABLE
    assert answer.path == "no-such-ghostscript"


# ── the doors OUTSIDE the chokepoint ──────────────────────────────────────
#
# `budget.gs` validates every run that goes through it. These eight doors did
# not: three spawned `subprocess.run` directly and four guarded with
# `os.path.isfile`, which says yes to a copied executable with no `Resource/`
# tree and to a build too old for the flags passed. Each is asserted at ITS
# OWN shape, because "it refuses" is only true if the refusal is what the
# caller of that door actually receives.


def _absent(tmp_path):
    """A path that names no program. Not a bare name — the point is that a
    caller's EXPLICIT path is the answer, never a hint to go looking."""
    return str(tmp_path / "nowhere" / "gswin64c.exe")


def test_printing_refuses_before_the_first_job_spawns(tmp_pdf, tmp_path):
    # Decided before the copies loop: an unusable Ghostscript must refuse
    # once, not once per copy.
    from engine.printer import print_pdf

    with pytest.raises(gc.GsUnavailable) as caught:
        print_pdf(tmp_pdf, "Microsoft Print to PDF", gs_path=_absent(tmp_path), copies=3)
    assert caught.value.reason == gc.NOT_EXECUTABLE


def test_every_print_render_stage_refuses_by_name(tmp_pdf, tmp_path, tmp_dir):
    from engine.print_layout import flatten_pdf, rasterize_pdf, render_preview

    absent = _absent(tmp_path)
    out = os.path.join(tmp_dir, "out.pdf")
    for run in (
        lambda: flatten_pdf(absent, tmp_pdf, out),
        lambda: rasterize_pdf(absent, tmp_pdf, out, 72),
        lambda: render_preview(absent, tmp_pdf, tmp_dir, 72, 612.0, 792.0,
                               ["-dFIXEDMEDIA", "-dFitPage"]),
    ):
        with pytest.raises(gc.GsUnavailable) as caught:
            run()
        assert caught.value.reason == gc.NOT_EXECUTABLE


def test_image_export_refuses_by_name(tmp_pdf, tmp_dir, tmp_path):
    from engine.image_export import export_images

    with pytest.raises(gc.GsUnavailable):
        export_images(tmp_pdf, os.path.join(tmp_dir, "p.png"), gs_path=_absent(tmp_path))


def test_the_ocr_raster_refuses_by_name(tmp_pdf, tmp_dir, tmp_path):
    from engine.recognize import _render_page_png

    with pytest.raises(gc.GsUnavailable):
        _render_page_png(tmp_pdf, 1, _absent(tmp_path),
                         __import__("pathlib").Path(tmp_dir) / "p.png")


def test_the_slide_raster_refuses_by_name(tmp_pdf, tmp_dir, tmp_path):
    from engine.slide_export import _render_background

    with pytest.raises(gc.GsUnavailable):
        _render_background(tmp_pdf, 1, _absent(tmp_path),
                           __import__("pathlib").Path(tmp_dir) / "p.png")


def test_mask_verification_refuses_by_name(tmp_path):
    # Rule 4's decoder. An unverified stencil is not shippable, so the
    # verification must refuse rather than be skipped.
    from engine.mrc_codecs import MaskStream, verify_mask_stream

    stream = MaskStream(data=b"", codec="ccitt", width=8, height=8, decode=None,
                        decode_parms=None, globals_data=None, ink_fraction=0.1)
    with pytest.raises(gc.GsUnavailable):
        verify_mask_stream(stream, _absent(tmp_path))


def test_mrc_refuses_up_front_rather_than_after_the_segmentation(tmp_pdf, tmp_dir, tmp_path):
    from engine.mrc import mrc_compress

    with pytest.raises(gc.GsUnavailable) as caught:
        mrc_compress(tmp_pdf, os.path.join(tmp_dir, "out.pdf"), gs_path=_absent(tmp_path))
    assert caught.value.reason == gc.NOT_EXECUTABLE


def test_no_gs_door_is_left_spawning_a_raw_subprocess():
    """The sweep that keeps a NEW door from reappearing outside the authority.

    Every module that takes a `gs_path` must reach Ghostscript through
    `budget` (which validates) or consult `gs_capability` itself. A module
    that takes the parameter and calls `subprocess` directly is the shape
    this whole layer was built to remove, so it is checked mechanically
    rather than by review.

    A module that only PASSES `gs_path` down is not a door; the ones that
    matter BUILD a Ghostscript command, which always names the executable as
    the list's first element. Such a module must NAME the authority: either
    `budget.gs`, which validates and replaces the executable before spawning,
    or `gs_capability` directly. One that names neither has no way to have
    validated the path it was handed, whatever it does with it.

    The predicate lives in `gs_axis` because the absent-axis roster is
    derived from the same sweep — a door this finds is a door that owes an
    absent-state answer.
    """
    assert not gs_axis.modules_missing_the_authority()


def test_no_gs_default_is_a_bare_command_name():
    """`gs_path` defaults to ABSENT, never to the literal "gs".

    A literal default is a claim that a program named `gs` is the right one,
    which on the shipped platform is usually not even the console binary's
    name (`gswin64c`). Absent means "resolve one", and the authority's
    discovery answers it — including the registry-installed copies that
    never reach PATH.
    """
    offenders = gs_axis.modules_matching(r'gs_path\s*(?::\s*str\s*)?=\s*["\']gs["\']')
    assert not offenders, offenders


def test_an_absent_default_still_reaches_discovery(monkeypatch, tmp_path):
    """The normalization's whole point: "" resolves, it does not refuse blind.

    With the override pointing at a usable stub, a door called with NO
    `gs_path` must find it — otherwise the defaults sweep would have turned
    every default caller into a refusal.
    """
    stub = stub_gs(str(tmp_path), "10.07.1", renders=True)
    monkeypatch.setenv(gc.PATH_ENV_VAR, stub)
    monkeypatch.setattr(gc, "_smoke", lambda _p: (True, ""))
    gc.clear_cache()
    answer = gc.resolve("")
    assert answer.available
    assert answer.path == stub


def test_a_preflight_raster_check_reports_rather_than_skips(tmp_dir, monkeypatch):
    """The worst failure mode in the matrix: a check that PASSES because the
    tool it needed was missing. Total area coverage is the one preflight
    check that measures through Ghostscript, and with none available it must
    say so by name — a `needs_review` carrying `tac_not_measured`, never a
    pass it did not earn."""
    import preflight_builders as builders
    from engine.preflight import preflight

    profile = {"schema": 1, "id": "t", "name": "T",
               "checks": {"ink_coverage_max": {"enabled": True}}}
    src = builders.build("tac_360", tmp_dir)

    monkeypatch.setattr(
        gc, "resolve",
        lambda path=None: gc.GsCapability(False, str(path or ""), "", gc.NOT_CONFIGURED),
    )
    report = preflight(src, profile=profile)
    row = next(r for r in report["checks"] if r["id"] == "ink_coverage_max")
    assert row["status"] == "needs_review"
    assert [f["detail_key"] for f in row["findings"]] == ["tac_not_measured"]


def test_no_module_decides_ghostscript_by_file_existence():
    """The other half of the defect class the sweep above covers.

    A door does not have to spawn blind to be wrong: guarding with
    `os.path.isfile(gs_path)` says yes to a copied `gswin64c.exe` with no
    `Resource/` tree, and to a build too old for the flags the engine passes.
    Both then fail deep inside the operation as something else — an
    unexplained render error, a bad stencil — which is exactly the confusion
    the authority exists to end. Existence is never the question; the probe
    is.
    """
    offenders = []
    for pattern in (
        r"os\.path\.isfile\(\s*gs_path",
        r"os\.path\.exists\(\s*gs_path",
        r"Path\(\s*gs_path\s*\)",
    ):
        for name in gs_axis.modules_matching(pattern, skip={"gs_capability.py"}):
            offenders.append(f"{name}: {pattern}")
    assert not offenders, offenders
