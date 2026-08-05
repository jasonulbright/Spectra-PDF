"""In-place (output == input) support for whole-file ops.

pikepdf cannot save over its own open input, and Ghostscript must never
write the file it is still reading — so every op that accepts
``output == file`` stages the result BESIDE the output and renames over it
at the end. Staging in the output's own directory keeps the final move on one
volume, so it is a rename rather than a copy. Every operation that permits
in-place output must use this path; otherwise a multi-step sequence can
overwrite an input while it is still being read.
"""

import os
import shutil
import tempfile
from pathlib import Path


def is_same_file(file: str, output: str) -> bool:
    """Resolved-identity comparison; a not-yet-existing output is never
    "same" (resolve(strict=False) still normalizes the spelling)."""
    try:
        return Path(file).resolve() == Path(output).resolve()
    except OSError:
        return False


def staging_target(output: Path) -> Path:
    """A fresh, closed temp file beside ``output``."""
    fd, name = tempfile.mkstemp(suffix=".pdf", dir=str(output.parent))
    os.close(fd)
    return Path(name)


def finish_staged(staged: Path, output: Path) -> None:
    shutil.move(str(staged), str(output))
