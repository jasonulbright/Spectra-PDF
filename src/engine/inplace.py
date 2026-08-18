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
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


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


@contextmanager
def staged_write(output: Path) -> Iterator[Path]:
    """Yield a temp path beside ``output``; land it with ``os.replace`` on a
    clean exit, remove it on a failure.

    The swap is ``os.replace`` and never ``shutil.move``: ``os.rename`` onto an
    existing destination raises on Windows, so ``shutil.move`` falls back to
    copying INTO that destination — which for an output that names its own
    input means the document is overwritten byte by byte, and a copy that dies
    part-way leaves the input truncated. ``os.replace`` swaps a directory
    entry, so a death leaves the input whole and a hard link to the input keeps
    reading the bytes it had.

    The destination cannot be replaced while a handle holds it open, so a
    caller whose output is its own still-open input closes that handle inside
    the block. Staging in the output's own directory keeps the swap on one
    volume, where it is a rename rather than a copy.
    """
    staged = staging_target(output)
    try:
        yield staged
        os.replace(str(staged), str(output))
    except Exception:
        if os.path.exists(str(staged)):
            os.unlink(str(staged))
        raise
