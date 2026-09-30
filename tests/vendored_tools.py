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

ROOT = Path(__file__).resolve().parents[1]
WINDOWS = os.name == "nt"
NATIVE = ROOT / "resources" if WINDOWS else ROOT / "resources" / "linux-x86_64"
EXE = ".exe" if WINDOWS else ""

TESSERACT = NATIVE / "tesseract" / f"tesseract{EXE}"
JBIG2 = NATIVE / "jbig2enc" / f"jbig2{EXE}"
SOFFICE = NATIVE / "libreoffice" / "program" / f"soffice{EXE}"
#: The Finnish analyser's native library. The Windows DLL sits beside the
#: dictionary data; the Linux library has its own platform tree.
VOIKKO_LIBRARY = (
    ROOT / "resources" / "dictionaries" / "fi" / "libvoikko-1.dll"
    if WINDOWS
    else NATIVE / "voikko" / "libvoikko.so.1"
)
