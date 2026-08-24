"""Shared fixtures for SpectraPDF engine tests."""

import os
import shutil
import sys
import tempfile

import pytest

# Add src/ to path so `from engine.xxx import yyy` works with relative imports
SRC_DIR = os.path.join(os.path.dirname(__file__), "..", "src")
sys.path.insert(0, SRC_DIR)
# …and tests/, so the shared helpers import by name whether pytest was
# pointed at the directory, at one file, or at a scratch checkout.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gs_axis import GS_PATH, PRESENT_AXIS_SKIP, force_absent  # noqa: E402

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")


@pytest.fixture
def sample_pdf():
    """Path to a 5-page test PDF with metadata."""
    return os.path.join(FIXTURES_DIR, "sample.pdf")


@pytest.fixture
def sample_pdf2():
    """Path to a 3-page test PDF."""
    return os.path.join(FIXTURES_DIR, "sample2.pdf")


@pytest.fixture
def tmp_dir():
    """Temporary directory, cleaned up after each test."""
    d = tempfile.mkdtemp(prefix="spectrapdf_test_")
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def tmp_pdf(sample_pdf, tmp_dir):
    """A working copy of sample.pdf in a temp directory."""
    dest = os.path.join(tmp_dir, "work.pdf")
    shutil.copy2(sample_pdf, dest)
    return dest


@pytest.fixture
def gs_path():
    """The capability-present axis: the Ghostscript the authority validated.

    Not a vendored path — nothing in the distribution provides Ghostscript,
    so the question is "did the authority find a usable one?" and the answer
    comes from `engine.gs_capability` rather than from a directory listing.
    """
    if not GS_PATH:
        pytest.skip(PRESENT_AXIS_SKIP)
    return GS_PATH


@pytest.fixture
def gs_absent(monkeypatch):
    """The capability-absent axis: the authority answers "none", always.

    Runs on every machine, including one with a working Ghostscript: the
    force is applied to discovery and the probe, so no arrangement of PATH,
    environment or installed copies can leak a usable answer into a test
    that is asserting the refusal.
    """
    force_absent(monkeypatch)
    yield
    _gs_capability().clear_cache()


def _gs_capability():
    from engine import gs_capability

    return gs_capability


def pytest_sessionfinish(session, exitstatus):
    """A clean full-capability gate may not turn missing resources into green.

    Most resource-heavy tests intentionally skip on an ordinary contributor
    checkout, where the gitignored shipped runtimes have not been assembled.
    CI and the release verifier explicitly assemble every one first and set
    this switch; under that contract, even one skip means the advertised full
    suite did not run and the gate fails after reporting its normal tally.

    The refusal names the axes it refused. A bare count says only that the run
    is unprovable; the reason lines say WHICH capability the runner is missing,
    which is the difference between reading a CI log and re-running the suite
    locally to find out.
    """
    if os.environ.get("SPECTRAPDF_REQUIRE_ZERO_SKIPS") != "1":
        return
    reporter = session.config.pluginmanager.get_plugin("terminalreporter")
    skipped = reporter.stats.get("skipped", []) if reporter is not None else []
    if skipped:
        if reporter is not None:
            reporter.write_sep(
                "=", f"full-capability gate refused {len(skipped)} skipped tests"
            )
            for reason, nodes in _skips_by_reason(skipped).items():
                reporter.write_line(f"{len(nodes):>5}  {reason}")
                for node in nodes[:3]:
                    reporter.write_line(f"         {node}")
                if len(nodes) > 3:
                    reporter.write_line(f"         ... and {len(nodes) - 3} more")
        session.exitstatus = pytest.ExitCode.TESTS_FAILED


def _skips_by_reason(skipped):
    """Group skip reports by their reason, preserving first-seen order.

    Reads defensively: a skip's `longrepr` is a (path, lineno, reason) triple
    for a skipped test but not for every report shape pytest can put in this
    bucket, and a report that cannot say why it skipped must not crash the
    gate that is already failing the run.
    """
    grouped = {}
    for report in skipped:
        longrepr = getattr(report, "longrepr", None)
        if isinstance(longrepr, tuple) and len(longrepr) == 3:
            reason = str(longrepr[2]).removeprefix("Skipped: ")
        else:
            reason = "unstated reason"
        grouped.setdefault(reason, []).append(getattr(report, "nodeid", "<unknown>"))
    return grouped


ICC_DIR = os.path.join(os.path.dirname(__file__), "..", "resources", "icc")


@pytest.fixture
def icc_dir():
    """The bundled colour-profile directory.

    The guard tests for the PROFILES, not for the directory: the release
    workflow creates the resource directories as stubs, so an isdir check
    would pass over an empty tree and the tests below would then measure
    nothing while reporting green.
    """
    import glob

    if not glob.glob(os.path.join(ICC_DIR, "*.icc")):
        pytest.skip("bundled ICC profiles not available")
    return ICC_DIR


def _resolve_soffice():
    """Bundled LibreOffice first (resources/libreoffice), else a system install."""
    bundled = os.path.join(
        os.path.dirname(__file__), "..", "resources", "libreoffice",
        "program", "soffice.exe",
    )
    if os.path.isfile(bundled):
        return bundled
    for base in (
        os.environ.get("ProgramFiles", r"C:\Program Files"),
        os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
    ):
        cand = os.path.join(base, "LibreOffice", "program", "soffice.exe")
        if os.path.isfile(cand):
            return cand
    return None


@pytest.fixture
def soffice_path():
    """Path to LibreOffice's soffice (bundled or system); skip if unavailable."""
    p = _resolve_soffice()
    if not p:
        pytest.skip("LibreOffice not available")
    return p
