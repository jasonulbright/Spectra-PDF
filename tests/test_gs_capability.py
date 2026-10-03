"""The Ghostscript capability authority, and the chokepoint that consults it.

Two things are under test and they are not the same thing: that ONE module
answers "is a usable Ghostscript configured?" by probing rather than by file
existence, and that a gs run with no usable Ghostscript leaves the engine as
ONE named refusal rather than as a spawn failure at whichever door was asked.
"""

import os
import re
import subprocess
import sys
import time

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
    monkeypatch.delenv(gc.SURFACE_ENV_VAR, raising=False)
    gc.clear_cache()
    yield
    gc.clear_cache()


def stub_gs(directory, version_line, *, renders=False):
    """A fake `gs` that answers --version and (optionally) nothing else.

    A batch file on Windows, an executable shell script elsewhere: each is what
    that platform's process launcher runs by path."""
    if sys.platform == "win32":
        stub = os.path.join(directory, "gswin64c.cmd")
        body = f"@if \"%1\"==\"--version\" echo {version_line}\r\n"
        if not renders:
            body += "@if not \"%1\"==\"--version\" exit /b 1\r\n"
    else:
        stub = os.path.join(directory, "gs")
        body = f'#!/bin/sh\nif [ "$1" = "--version" ]; then echo {version_line}; exit 0; fi\n'
        body += "exit 0\n" if renders else "exit 1\n"
    with open(stub, "w", encoding="ascii", newline="") as handle:
        handle.write(body)
    if sys.platform != "win32":
        os.chmod(stub, 0o755)
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


def test_a_short_discovery_timeout_does_not_poison_a_full_probe(tmp_path, monkeypatch):
    stub = tmp_path / "gswin64c.exe"
    stub.write_bytes(b"candidate")

    def timeout(args, *, timeout):
        raise subprocess.TimeoutExpired(args, timeout)

    monkeypatch.setattr(gc, "_run", timeout)
    short = gc._probe_with_budget(stub, 0.005)
    assert short.reason == gc.PROBE_FAILED
    assert not gc._CACHE

    monkeypatch.setattr(
        gc,
        "_run",
        lambda args, *, timeout: subprocess.CompletedProcess(
            args, 0, "GPL Ghostscript 10.07.1\n", ""
        ),
    )
    monkeypatch.setattr(gc, "_smoke", lambda _p, *, timeout: (True, ""))
    assert gc.probe(stub).available


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


def test_discovery_orders_the_environment_then_the_bundle_then_path(monkeypatch, tmp_path):
    env = str(tmp_path / "env" / "gswin64c.exe")
    bundled = str(tmp_path / "bundle" / "gswin64c.exe")
    on_path = str(tmp_path / "path" / "gswin64c.exe")
    monkeypatch.setenv(gc.PATH_ENV_VAR, env)
    monkeypatch.setattr(gc, "bundled_candidates", lambda: [bundled])
    monkeypatch.setattr(
        gc.shutil, "which", lambda name, *_a, **_k: on_path if name == gc._CANDIDATE_NAMES[0] else None
    )
    assert gc.discover() == [env, bundled, on_path]


def test_a_bundled_copy_named_again_on_path_is_one_candidate(monkeypatch, tmp_path):
    bundled = str(tmp_path / "bundle" / "gswin64c.exe")
    monkeypatch.setattr(gc, "bundled_candidates", lambda: [bundled])
    monkeypatch.setattr(gc.shutil, "which", lambda *_a, **_k: bundled)
    assert gc.discover() == [bundled]


def test_the_bundled_candidate_is_the_windows_tree_and_only_a_file(monkeypatch, tmp_path):
    engine_dir = tmp_path / "engine"
    engine_dir.mkdir()
    stub_dir = tmp_path / "ghostscript"
    stub_dir.mkdir()
    monkeypatch.setattr(gc, "__file__", str(engine_dir / "gs_capability.py"))
    (stub_dir / "gswin64c.exe").write_bytes(b"")
    if os.name != "nt":
        assert gc.bundled_candidates() == []
        return
    assert gc.bundled_candidates() == [str(stub_dir / "gswin64c.exe")]
    (stub_dir / "gswin64c.exe").unlink()
    # An empty stub folder (the CI resource stubs) is no candidate: it must
    # leave the answer NOT_CONFIGURED, not turn it into NOT_EXECUTABLE.
    assert gc.bundled_candidates() == []
    (stub_dir / "gswin64c.exe").mkdir()
    assert gc.bundled_candidates() == []


def test_an_empty_bundle_folder_leaves_nothing_configured(monkeypatch, tmp_path):
    engine_dir = tmp_path / "engine"
    engine_dir.mkdir()
    (tmp_path / "ghostscript").mkdir()
    monkeypatch.setattr(gc, "__file__", str(engine_dir / "gs_capability.py"))
    monkeypatch.setattr(gc.platform_support, "DEV_PLATFORM_DIR", "")
    monkeypatch.setattr(gc.shutil, "which", lambda *_a, **_k: None)
    answer = gc.resolve("")
    assert not answer.available
    assert answer.reason == gc.NOT_CONFIGURED


def test_only_the_bundled_program_is_spawned_on_the_rom_search_path(monkeypatch, tmp_path):
    ps = gc.platform_support
    engine_dir = tmp_path / "engine"
    engine_dir.mkdir()
    bundled = tmp_path / "ghostscript" / "gswin64c.exe"
    monkeypatch.setattr(ps, "IS_WINDOWS", True)
    monkeypatch.setattr(ps, "DEV_PLATFORM_DIR", "")
    # A bundled program that does not exist names no file.
    assert ps.bundled_gs_env([str(bundled), "--version"], {}, engine_dir) is None
    bundled.parent.mkdir()
    bundled.write_bytes(b"MZ bundled")
    env = ps.bundled_gs_env([str(bundled), "--version"], {"PATH": "x"}, engine_dir)
    assert env == {"PATH": "x", "GS_LIB": ps.BUNDLED_GS_LIB}
    assert ps.bundled_gs_env(str(bundled) + " --version", {}, engine_dir)["GS_LIB"] == ps.BUNDLED_GS_LIB
    other = tmp_path / "gs" / "bin" / "gswin64c.exe"
    assert ps.bundled_gs_env([str(other), "--version"], {}, engine_dir) is None
    other.parent.mkdir(parents=True)
    other.write_bytes(b"MZ bundled")
    # Equal bytes at another path are another installation.
    assert ps.bundled_gs_env([str(other), "--version"], {}, engine_dir) is None
    assert ps.bundled_gs_env([], {}, engine_dir) is None
    monkeypatch.setattr(ps, "IS_WINDOWS", False)
    assert ps.bundled_gs_env([str(bundled), "--version"], {}, engine_dir) is None


def test_a_link_to_the_bundled_program_is_the_bundled_program(monkeypatch, tmp_path):
    ps = gc.platform_support
    engine_dir = tmp_path / "engine"
    engine_dir.mkdir()
    bundled = tmp_path / "ghostscript" / "gswin64c.exe"
    bundled.parent.mkdir()
    bundled.write_bytes(b"MZ bundled")
    alias = tmp_path / "elsewhere" / "gs-alias.exe"
    alias.parent.mkdir()
    try:
        os.link(bundled, alias)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"hard links are not supported here: {exc}")
    monkeypatch.setattr(ps, "IS_WINDOWS", True)
    monkeypatch.setattr(ps, "DEV_PLATFORM_DIR", "")
    inherited = {"GS_LIB": "C:/other/gs/lib"}
    assert ps.bundled_gs_env([str(alias), "--version"], inherited, engine_dir) == {
        "GS_LIB": ps.BUNDLED_GS_LIB
    }
    # A case variant of the bundled path names the same file where the file
    # system ignores case.
    variant = bundled.with_name(bundled.name.upper())
    if variant.exists():
        assert ps.bundled_gs_env([str(variant)], {}, engine_dir)["GS_LIB"] == ps.BUNDLED_GS_LIB


@pytest.mark.skipif(
    not gc.bundled_candidates(), reason="no vendored resources/ghostscript in this checkout"
)
def test_the_vendored_copy_searches_only_its_rom(monkeypatch):
    # With GS_LIB absent from the parent, a same-version registry value
    # would otherwise appear first in this listing.
    monkeypatch.delenv("GS_LIB", raising=False)
    result = gc.platform_support.run(
        [gc.bundled_candidates()[0], "-h"], capture_output=True, text=True, timeout=60
    )
    listing = result.stdout.split("Search path:", 1)[1].split("Initialization files", 1)[0]
    entries = [entry.strip() for entry in " ".join(listing.split()).split(" ; ") if entry.strip()]
    assert entries and all(entry.startswith("%rom%") for entry in entries), entries


def _pinned_files():
    root = os.path.join(os.path.dirname(__file__), "..")
    with open(os.path.join(root, "scripts", "bundle-ghostscript.ps1"), encoding="utf-8") as handle:
        script = handle.read()
    block = script.split("$ShippedSha256 = [ordered]@{", 1)[1].split("}", 1)[0]
    in_script = {
        name: digest.lower()
        for name, digest in re.findall(r'"([^"]+)"\s*=\s*"([0-9A-F]{64})"', block)
    }
    in_table = {}
    with open(os.path.join(root, "scripts", "ghostscript.tsv"), encoding="utf-8") as handle:
        rows = [
            line.rstrip("\r\n").split("\t")
            for line in handle
            if line.strip() and not line.startswith("#")
        ]
    assert rows[0] == ["file", "member", "sha256"]
    for name, _member, digest in rows[1:]:
        in_table[name] = digest
    return root, in_script, in_table


def test_the_shipped_file_pins_agree_and_name_every_shipped_file():
    _root, in_script, in_table = _pinned_files()
    assert in_script == in_table
    assert set(in_script) == {"gswin64c.exe", "gsdll64.dll", "LICENSE-Ghostscript.txt"}


def test_the_vendored_tree_holds_the_pinned_upstream_bytes():
    import hashlib

    root, in_script, _table = _pinned_files()
    tree = os.path.join(root, "resources", "ghostscript")
    if not os.path.isfile(os.path.join(tree, "gswin64c.exe")):
        pytest.skip("no vendored resources/ghostscript in this checkout")
    assert sorted(os.listdir(tree)) == sorted(in_script)
    for name, digest in in_script.items():
        with open(os.path.join(tree, name), "rb") as handle:
            assert hashlib.sha256(handle.read()).hexdigest() == digest, name


def test_the_bundled_version_meets_the_minimum():
    script = os.path.join(
        os.path.dirname(__file__), "..", "scripts", "bundle-ghostscript.ps1"
    )
    with open(script, encoding="utf-8") as handle:
        text = handle.read()
    pinned = re.findall(r'\[string\]\$GsVersion = "([0-9.]+)"', text)
    assert len(pinned) == 1, pinned
    assert gc.parse_version(pinned[0])[:2] >= gc.MINIMUM_VERSION


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


def test_auto_discovery_shares_one_probe_time_budget():
    attempts = []

    def slow_probe(candidate, remaining):
        attempts.append((candidate, remaining))
        time.sleep(0.02)
        return gc.GsCapability(False, candidate, "", gc.NOT_EXECUTABLE)

    answer = gc._resolve_candidates_with(
        ["slow-candidate", "later-candidate"], 0.005, slow_probe
    )
    assert [candidate for candidate, _ in attempts] == ["slow-candidate"]
    assert attempts[0][1] <= 0.005
    assert answer.reason == gc.PROBE_FAILED
    assert answer.path == "slow-candidate"
    assert "total time budget" in answer.detail


def test_a_blank_path_is_nothing_configured_and_searches(monkeypatch):
    # The CLI and the renderer both read a blank setting as "not configured";
    # the engine must give it the one answer that permits a search.
    found = r"C:\gs\bin\gswin64c.exe"
    gs_axis.force_available(monkeypatch, found)
    for unconfigured in (None, "", "   "):
        answer = gc.resolve(unconfigured)
        assert answer.available, repr(unconfigured)
        assert answer.path == found


def test_a_configured_value_never_consults_discovery(monkeypatch, tmp_path):
    def searched():
        raise AssertionError("a configured Ghostscript must not start a search")

    monkeypatch.setattr(gc, "discover", searched)
    monkeypatch.setattr(gc.shutil, "which", lambda *_a, **_k: None)
    named = str(tmp_path / "gswin64c.exe")
    for configured in (named, "gswin64c"):
        with pytest.raises(gc.GsUnavailable) as caught:
            gc.require(configured)
        assert caught.value.reason == gc.NOT_EXECUTABLE
        assert caught.value.path == configured


# ── The refusal ───────────────────────────────────────────────────────────


def test_require_raises_the_named_refusal_carrying_its_reason(monkeypatch):
    monkeypatch.setattr(gc, "discover", lambda: [])
    with pytest.raises(gc.GsUnavailable) as caught:
        gc.require("")
    assert caught.value.reason == gc.NOT_CONFIGURED
    assert "Ghostscript" in str(caught.value)
    assert "Reinstall Spectra PDF" in str(caught.value)


def test_every_reason_has_its_own_message(tmp_path):
    missing = gc.probe(str(tmp_path / "gswin64c.exe"))
    old = gc.probe(stub_gs(str(tmp_path), "9.50"))
    unconfigured = gc.probe("")
    texts = {gc.message(a) for a in (missing, old, unconfigured)}
    assert len(texts) == 3
    assert gc._minimum_text() in gc.message(old)
    assert old.version in gc.message(old)


#: The fix the window's text names, as `_refuse` writes it.
WINDOW_FIX = "Reinstall Spectra PDF, or choose a Ghostscript program in Preferences > Engine."


def _unavailable_answers(directory):
    """One unavailable answer per reason."""
    return {
        gc.NOT_EXECUTABLE: gc.probe(os.path.join(directory, "gswin64c.exe")),
        gc.PROBE_FAILED: gc.GsCapability(
            False, os.path.join(directory, "gs.exe"), "10.05.0", gc.PROBE_FAILED,
            "no Resource tree",
        ),
        gc.VERSION_BELOW_MINIMUM: gc.probe(stub_gs(directory, "9.50")),
        gc.NOT_CONFIGURED: gc.probe(""),
    }


def test_the_window_names_preferences_for_every_reason(tmp_path):
    for reason, answer in _unavailable_answers(str(tmp_path)).items():
        assert answer.reason == reason
        text = gc.message(answer)
        assert text.endswith(WINDOW_FIX), (reason, text)
        assert "--gs-path" not in text, (reason, text)


def test_the_command_line_names_its_flag_and_variable_for_every_reason(tmp_path, monkeypatch):
    answers = _unavailable_answers(str(tmp_path))
    window = {reason: gc.message(answer) for reason, answer in answers.items()}
    monkeypatch.setenv(gc.SURFACE_ENV_VAR, gc.CLI_SURFACE)
    for reason, answer in answers.items():
        text = gc.message(answer)
        assert text.endswith(
            "Reinstall Spectra PDF, or name a Ghostscript program with --gs-path or "
            f"the {gc.PATH_ENV_VAR} environment variable."
        ), (reason, text)
        assert "Preferences" not in text, (reason, text)
        # The problem half is built from the refusal's own fields, so it
        # reads as the window's does: only the fix differs.
        assert text.split(". Reinstall")[0] == window[reason].split(". Reinstall")[0], reason


def test_the_raised_refusal_names_the_fix_of_the_surface_that_shows_it(tmp_path, monkeypatch):
    missing = str(tmp_path / "gswin64c.exe")
    with pytest.raises(gc.GsUnavailable) as caught:
        gc.require(missing)
    refusal = caught.value
    assert str(refusal).endswith(WINDOW_FIX)
    monkeypatch.setenv(gc.SURFACE_ENV_VAR, "window")
    assert str(refusal).endswith(WINDOW_FIX)
    monkeypatch.setenv(gc.SURFACE_ENV_VAR, gc.CLI_SURFACE)
    assert "--gs-path" in str(refusal) and missing in str(refusal)
    # The message the refusal table matches stays the window's own.
    assert refusal.args[0].endswith(WINDOW_FIX)


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


@pytest.mark.parametrize("through_cups", [False, True], ids=["ghostscript-spool", "cups-spool"])
def test_printing_refuses_before_the_first_job_spawns(tmp_pdf, tmp_path, monkeypatch, through_cups):
    # Decided before the copies loop: an unusable Ghostscript must refuse
    # once, not once per copy. The printer lookup and both spool routes are
    # replaced, so the host's printers (winspool, CUPS or none) decide nothing.
    from engine import cups_print, printer

    spawned = []

    def _never(*args, **kwargs):
        spawned.append(args)
        raise AssertionError("a print job spawned before the Ghostscript refusal")

    monkeypatch.setattr(printer, "_SPOOL_THROUGH_CUPS", through_cups)
    monkeypatch.setattr(printer, "printer_exists", lambda _name: True)
    monkeypatch.setattr(printer.platform_support, "run", _never)
    monkeypatch.setattr(cups_print, "print_file", _never)
    # The CUPS route spools the document itself; its Ghostscript stage is the
    # raster render that precedes the spool.
    with pytest.raises(gc.GsUnavailable) as caught:
        printer.print_pdf(
            tmp_pdf, "Any Printer", gs_path=_absent(tmp_path), copies=3, as_image=through_cups
        )
    assert caught.value.reason == gc.NOT_EXECUTABLE
    assert caught.value.path == _absent(tmp_path)
    assert spawned == []


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
    monkeypatch.setattr(gc, "_smoke", lambda _p, *, timeout: (True, ""))
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
