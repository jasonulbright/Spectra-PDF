"""Shared fixtures for SpectraPDF engine tests."""

import os
import shutil
import sys
import tempfile

import pytest

# Add src/ to path so `from engine.xxx import yyy` works with relative imports
SRC_DIR = os.path.join(os.path.dirname(__file__), "..", "src")
sys.path.insert(0, SRC_DIR)

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")
GS_PATH = os.path.join(
    os.path.dirname(__file__), "..", "resources", "ghostscript", "gswin64c.exe"
)


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
    """Path to the bundled Ghostscript executable."""
    if not os.path.isfile(GS_PATH):
        pytest.skip("Ghostscript not available")
    return GS_PATH


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
