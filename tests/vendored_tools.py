"""The vendored native programs, spelled for the platform running the suite.

Windows trees live under `resources/<component>/` and name their programs with
`.exe`; the Linux trees live under `resources/linux-x86_64/<component>/`
(scripts/*.sh). A test that skips on a missing program checks the FILE these
paths name, never a directory: a stubbed `resources/` has directories and no
programs.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WINDOWS = os.name == "nt"
NATIVE = ROOT / "resources" if WINDOWS else ROOT / "resources" / "linux-x86_64"
EXE = ".exe" if WINDOWS else ""

#: A Linux tree is the pinned artifact as published: programs in `bin/`,
#: libraries in `lib/`, Tesseract's models in `share/tessdata/`.
BIN = "" if WINDOWS else "bin"
TESSERACT = NATIVE / "tesseract" / BIN / f"tesseract{EXE}"
TESSDATA = TESSERACT.parent / "tessdata" if WINDOWS else NATIVE / "tesseract" / "share" / "tessdata"
JBIG2 = NATIVE / "jbig2enc" / BIN / f"jbig2{EXE}"
SOFFICE = NATIVE / "libreoffice" / "program" / f"soffice{EXE}"
#: The bundled spelling dictionaries. The Linux tree is its own copy so a
#: checkout shared with a Windows host never ships the Windows analyser DLLs.
DICTIONARIES = ROOT / "resources" / "dictionaries" if WINDOWS else NATIVE / "dictionaries"
#: The Finnish analyser's native library. The Windows DLL sits beside the
#: dictionary data; the Linux library has its own platform tree.
VOIKKO_LIBRARY = (
    ROOT / "resources" / "dictionaries" / "fi" / "libvoikko-1.dll"
    if WINDOWS
    else NATIVE / "voikko" / "lib" / "libvoikko.so.1"
)

#: The bundled faces and colour profiles. They are platform-neutral data, so
#: both hosts read the same tree.
FONTS = ROOT / "resources" / "fonts"
ICC = ROOT / "resources" / "icc"
#: The one profile a PDF/A output intent embeds (`engine.pdfa._SRGB_PROFILE`).
SRGB_PROFILE = ICC / "srgb" / "sRGB2014.icc"


#: The skip reason for every test that needs a bundled colour profile.
ICC_MISSING = "bundled ICC profiles not provisioned: no resources/icc/*.icc"


def icc_profiles_provisioned() -> bool:
    """True when at least one bundled colour profile is on disk."""
    return any(ICC.glob("*.icc"))


def require_icc_profiles() -> str:
    """The bundled profile directory, or a skip when it holds no profile."""
    if not icc_profiles_provisioned():
        pytest.skip(ICC_MISSING)
    return str(ICC)


def require(path: Path | str, resource: str) -> str:
    """`path` as a string, or a skip that names the missing vendored file.

    Applied where a test or builder first reaches for the file, so the same
    test runs on a provisioned tree and skips on a stubbed one.
    """
    path = Path(path)
    if not path.is_file():
        pytest.skip(skip_reason(path, resource))
    return str(path)


def skip_reason(path: Path | str, resource: str) -> str:
    """The skip reason for a test that needs the vendored file `path`."""
    return f"{resource} not provisioned: no {_shown(Path(path))}"


def _shown(path: Path) -> str:
    """`path` relative to the checkout, so a skip reason reads the same on
    every machine and the zero-skip gate groups it as one axis."""
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)
