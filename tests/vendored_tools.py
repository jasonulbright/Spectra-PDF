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
