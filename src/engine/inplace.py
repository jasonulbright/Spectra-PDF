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
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


def is_same_file(file: str, output: str) -> bool:
    """Whether ``output`` names the physical file ``file`` names.

    Sameness is the filesystem's, not the string's: one physical file has
    several spellings no normalization reconciles (UNC versus mapped letter,
    hard links), so `os.path.samefile` — volume serial plus file index — is the
    authority and the resolved-spelling comparison is only a cheap first test
    that needs no stat. A resolved comparison alone answers False for a hard
    link, which routes a same-file write down the direct-write branch and into
    the bytes the reader still holds open.

    A not-yet-existing output is never "same": it names nothing to be identical
    to, and `samefile` on it raises.
    """
    try:
        if Path(file).resolve() == Path(output).resolve():
            return True
        return os.path.exists(output) and os.path.samefile(file, output)
    except OSError:
        return False


def staging_target(output: Path) -> Path:
    """A fresh, closed temp file beside ``output``."""
    fd, name = tempfile.mkstemp(suffix=".pdf", dir=str(output.parent))
    os.close(fd)
    return Path(name)


def _discard(staged: Path) -> None:
    if os.path.exists(str(staged)):
        os.unlink(str(staged))


def finish_staged(staged: Path, output: Path) -> None:
    """Land ``staged`` at ``output`` by swapping the directory entry.

    The swap is ``os.replace`` and never ``shutil.move``: ``os.rename`` onto an
    existing destination raises on Windows, so ``shutil.move`` falls back to
    copying INTO that destination — which for an output that names its own
    input means the document is overwritten byte by byte, and a copy that dies
    part-way leaves the input truncated. ``os.replace`` swaps a directory
    entry, so a death leaves the input whole and a hard link to the input keeps
    reading the bytes it had.

    The destination cannot be replaced while a handle holds it open, so a
    caller whose output is its own still-open input closes that handle before
    landing. Staging in the output's own directory keeps the swap on one
    volume, where it is a rename rather than a copy. A swap that fails takes
    the staged file with it, so nothing is left beside the document — cleanup
    hangs off `finally` rather than off an `except`, because a swap interrupted
    by `KeyboardInterrupt` or `SystemExit` raises neither `Exception` nor
    anything an `except` clause here may swallow. A swap that succeeded left
    nothing at the staged name, so the same statement is a no-op.
    """
    try:
        os.replace(str(staged), str(output))
    finally:
        _discard(staged)


@contextmanager
def staged_write(output: Path) -> Iterator[Path]:
    """Yield a temp path beside ``output``; land it with :func:`finish_staged`
    on a clean exit, remove it on a failure.

    The swap invariant lives in :func:`finish_staged`; this adds the scope. A
    producer that dies between the staging and the swap leaves a temp file
    beside the user's document unless something owns that span, so the staging
    and the swap are never written as loose statements.

    The scope owns the span for EVERY way out of it, which is why the cleanup
    hangs off `finally` and a flag rather than off an `except`: a cancellation
    mid-write — `KeyboardInterrupt`, `SystemExit` — is not an `Exception`, and
    an `except BaseException` that discards is one edit away from swallowing
    the interrupt it was written to survive.
    """
    staged = staging_target(output)
    landed = False
    try:
        yield staged
        finish_staged(staged, output)
        landed = True
    finally:
        if not landed:
            _discard(staged)


@contextmanager
def staged_write_if(same_file: bool, output: Path) -> Iterator[Path]:
    """:func:`staged_write` when the output names its own input, a plain write
    to ``output`` otherwise.

    For a producer that is handed one path and writes it over seconds — a
    Ghostscript run — the branch is on the TARGET rather than on a save call,
    so the whole producer runs inside the scope that owns the staged file.
    """
    if same_file:
        with staged_write(output) as staged:
            yield staged
    else:
        yield output
