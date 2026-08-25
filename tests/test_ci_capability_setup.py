"""Clean-runner guards for optional capabilities used by engine tests."""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

import conftest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ("ci.yml", "release.yml")

#: Every capability axis a test may skip on, mapped to the command that stages
#: it on a clean runner. An axis is declared by a module-level `*_AXIS_SKIP`
#: constant in a `tests/` helper module; the discovery test below refuses an
#: axis that is not registered here, so a new axis cannot reach CI without its
#: provisioning. The zero-skip gate is what makes that mandatory: an axis with
#: nothing staging it does not skip quietly, it reds the whole run.
AXIS_PROVISIONING = {
    ("gs_axis", "PRESENT_AXIS_SKIP"): "choco install ghostscript -y --no-progress",
    ("ghent_corpus", "CORPUS_AXIS_SKIP"): "python scripts/fetch-ghent-suite.py --check",
    ("processing_steps_corpus", "PROCESSING_STEPS_AXIS_SKIP"):
        "python scripts/fetch-processing-steps-suite.py --check",
}

#: Every fetched corpus staged the same way: an actions/cache step keyed on
#: the fetch SCRIPT (which is where the archive digests are pinned), a fetch
#: guarded by the cache miss, and an unconditional `--check`. One table so a
#: new corpus cannot arrive with half the pattern.
CACHED_CORPORA = (
    ("ghent-cache", "ghent-corpus", "scripts/fetch-ghent-suite.py"),
    ("processing-steps-cache", "processing-steps-corpus",
     "scripts/fetch-processing-steps-suite.py"),
)


def _axis_constants() -> set[tuple[str, str]]:
    """Every `*_AXIS_SKIP` constant defined by a tests/ helper module."""
    found: set[tuple[str, str]] = set()
    for path in sorted((ROOT / "tests").glob("*.py")):
        if path.name.startswith("test_"):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            targets = (
                node.targets
                if isinstance(node, ast.Assign)
                else [node.target] if isinstance(node, ast.AnnAssign)
                else []
            )
            for target in targets:
                if isinstance(target, ast.Name) and target.id.endswith("AXIS_SKIP"):
                    found.add((path.stem, target.id))
    return found


def _assert_capabilities_precede_engine_tests(workflow: str) -> None:
    text = (ROOT / ".github" / "workflows" / workflow).read_text()
    engine_test = text.index("python -m pytest tests/ -q")

    for resource_step in (
        "scripts/bundle-icc.ps1",
        "scripts/sync-edit-fonts.ps1",
        "scripts/bundle-libreoffice.ps1",
        "scripts/bundle-tesseract.ps1",
        "scripts/bundle-jbig2enc.ps1",
        "scripts/bundle-dictionaries.ps1",
        "scripts/bundle-voikko.ps1",
        "scripts/sync-ocr-assets.mjs",
        "scripts/setup-test-softhsm.ps1",
    ):
        assert text.index(resource_step) < engine_test
    assert text.index("choco install ghostscript -y --no-progress") < engine_test
    assert text.index("SPECTRAPDF_GS_PATH=") < engine_test
    assert text.index("SPECTRAPDF_REQUIRE_ZERO_SKIPS") > engine_test
    for command in AXIS_PROVISIONING.values():
        assert text.index(command) < engine_test


def test_every_skip_axis_is_registered_with_its_provisioning() -> None:
    assert _axis_constants() == set(AXIS_PROVISIONING)


@pytest.mark.parametrize("workflow", WORKFLOWS)
@pytest.mark.parametrize("cache_id,path,script", CACHED_CORPORA)
def test_each_corpus_fetch_is_cached_on_its_pins(
    workflow: str, cache_id: str, path: str, script: str
) -> None:
    """The fetch hits GWG's server on a pin change, not once per run.

    The key is the fetch script because that file IS the pin: the archive
    digests live in its `SOURCES`. A cache hit skips only the download —
    `--check` runs unconditionally, so a truncated restore fails the job
    rather than presenting as an absent corpus (which would be a skip).
    """
    text = (ROOT / ".github" / "workflows" / workflow).read_text()
    cache = text.index(f"id: {cache_id}")
    fetch = text.index(f"run: python {script}\n")
    check = text.index(f"run: python {script} --check")

    assert f"hashFiles('{script}')" in text
    assert f"path: {path}" in text
    assert cache < fetch < check
    guard = text.index(f"if: steps.{cache_id}.outputs.cache-hit != 'true'")
    assert cache < guard < check
    assert text[fetch:check].count("cache-hit") == 0


def test_scan_fixture_uses_the_ghostscript_authority() -> None:
    text = (ROOT / "tests" / "fixtures" / "make_scans.py").read_text()
    assert "from engine.gs_capability import require" in text
    assert "resources\" / \"ghostscript" not in text


def test_the_test_hsm_download_is_version_and_hash_pinned() -> None:
    text = (ROOT / "scripts" / "setup-test-softhsm.ps1").read_text()
    assert '$Version = "2.5.0"' in text
    assert "releases/download/v$Version/SoftHSM2-$Version-portable.zip" in text
    assert "85273bcc1a6b90e877f7bb4f7e90221d57103d8f5241d154a79dd730a135b910" in text
    assert "1980a74f3088a7273d7efa502b6ceb8de6a5285d5bcd36d49512a8717bf89635" in text


def test_full_capability_gate_refuses_a_skip(monkeypatch) -> None:
    class Report:
        nodeid = "tests/test_ghent_output.py::test_assembled_pages_are_six"
        longrepr = ("tests/test_ghent_output.py", 209, "Skipped: Ghent-corpus axis")

    class Reporter:
        stats = {"skipped": [Report(), object()]}

        def __init__(self) -> None:
            self.lines: list[str] = []

        def write_sep(self, _char, message) -> None:
            self.lines.append(message)

        def write_line(self, message) -> None:
            self.lines.append(message)

    reporter = Reporter()
    session = SimpleNamespace(
        exitstatus=pytest.ExitCode.OK,
        config=SimpleNamespace(
            pluginmanager=SimpleNamespace(get_plugin=lambda _name: reporter)
        ),
    )
    monkeypatch.setenv("SPECTRAPDF_REQUIRE_ZERO_SKIPS", "1")

    conftest.pytest_sessionfinish(session, pytest.ExitCode.OK)

    assert session.exitstatus == pytest.ExitCode.TESTS_FAILED
    # The refusal names the axis and the test, not just a count: a CI log that
    # says only "refused 64" cannot be acted on without re-running the suite.
    assert "full-capability gate refused 2 skipped tests" in reporter.lines
    assert any("Ghent-corpus axis" in line for line in reporter.lines)
    assert any(Report.nodeid in line for line in reporter.lines)
    assert any("unstated reason" in line for line in reporter.lines)


def test_ci_stages_both_engine_capabilities() -> None:
    _assert_capabilities_precede_engine_tests("ci.yml")


def test_release_verification_stages_both_engine_capabilities() -> None:
    _assert_capabilities_precede_engine_tests("release.yml")
