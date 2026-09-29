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
import re
import shutil
import stat
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


#: Staged names carry the owning pid, so a stage a killed engine left behind
#: is recognizable as ours and as dead, and nothing else ever matches.
STAGE_PREFIX = ".spectra-stage-"
_STAGE_NAME = re.compile(r"^\.spectra-stage-(\d+)-[A-Za-z0-9_]+\.pdf$")


def reclaim_stale_stages(folder) -> int:
    """Remove stages in ``folder`` whose owning process no longer runs.

    Only names matching the stage pattern are considered; a pid that cannot
    be proven dead keeps its file. Returns the count removed."""
    from engine.credentials import _gs_process_is_running

    try:
        names = os.listdir(str(folder))
    except OSError:
        return 0
    removed = 0
    for name in names:
        match = _STAGE_NAME.match(name)
        if match is None:
            continue
        pid = int(match.group(1))
        if pid == os.getpid() or _gs_process_is_running(pid):
            continue
        path = os.path.join(str(folder), name)
        try:
            if os.path.isfile(path) and not os.path.islink(path):
                os.unlink(path)
                removed += 1
        except OSError:
            continue
    return removed


def staging_target(output: Path) -> Path:
    """A fresh, closed temp file beside ``output``."""
    output = Path(output)
    reclaim_stale_stages(output.parent)
    fd, name = tempfile.mkstemp(prefix=f"{STAGE_PREFIX}{os.getpid()}-",
                                suffix=".pdf", dir=str(output.parent))
    os.close(fd)
    return Path(name)


def _discard(staged: Path) -> None:
    if os.path.exists(str(staged)):
        os.unlink(str(staged))


def _flush_to_disk(staged: Path) -> None:
    """Force the staged bytes to stable storage before the swap publishes
    them. Without it a power loss after the rename can leave the new
    directory entry naming blocks that were never written. FlushFileBuffers
    on Windows needs a write handle, hence ``r+b``."""
    with open(str(staged), "r+b") as handle:
        os.fsync(handle.fileno())


_READONLY = getattr(stat, "FILE_ATTRIBUTE_READONLY", 0x1)
_ERROR_UNABLE_TO_MOVE_REPLACEMENT = 1176
_REPLACEFILE_IGNORE_MERGE_ERRORS = 0x2
#: ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION: another handle holds the
#: target open without delete sharing.
_SHARING_ERRORS = frozenset({32, 33})
#: ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED, ERROR_INVALID_PARAMETER,
#: ERROR_UNABLE_TO_REMOVE_REPLACED: the volume or share does not perform
#: ReplaceFile; the target is left untouched.
_REPLACE_UNSUPPORTED = frozenset({1, 50, 87, 1175})

FILE_IN_USE = (
    "The file could not be replaced because another program is using it. "
    "Close it there and try again."
)



def _refuse_read_only(output: Path) -> None:
    """A read-only target refuses the write, as a direct write into it did;
    the flag is the user's and is never cleared here."""
    try:
        info = os.stat(str(output))
    except FileNotFoundError:
        return
    if getattr(info, "st_file_attributes", 0) & _READONLY or (
        os.name != "nt" and not os.access(str(output), os.W_OK)
    ):
        raise PermissionError(13, "The file is read-only", str(output))


def _replace_existing_windows(staged: Path, output: Path) -> None:
    """``ReplaceFileW`` onto an existing target: the target keeps its DACL,
    owner-set attributes, alternate data streams and creation time, which a
    rename would replace with the staged file's inherited ones."""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    replace = kernel32.ReplaceFileW
    replace.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR,
                        wintypes.DWORD, wintypes.LPVOID, wintypes.LPVOID)
    replace.restype = wintypes.BOOL
    if replace(str(output), str(staged), None,
               _REPLACEFILE_IGNORE_MERGE_ERRORS, None, None):
        return
    error = ctypes.get_last_error()
    if error in _SHARING_ERRORS:
        raise PermissionError(FILE_IN_USE)
    if error == _ERROR_UNABLE_TO_MOVE_REPLACEMENT and not os.path.exists(str(output)):
        # The target is already gone and the staged file is still whole under
        # its own name: landing it by rename is the only non-lossy outcome.
        os.replace(str(staged), str(output))
        return
    if error in _REPLACE_UNSUPPORTED:
        # A filesystem or share without ReplaceFile support still lands the
        # complete file; only the target's own metadata is not carried.
        _rename_over(staged, output)
        return
    raise ctypes.WinError(error)


def _rename_over(staged: Path, output: Path) -> None:
    try:
        os.replace(str(staged), str(output))
    except PermissionError as exc:
        if getattr(exc, "winerror", None) in _SHARING_ERRORS:
            raise PermissionError(FILE_IN_USE) from exc
        raise


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
    output = landing_path(output)
    try:
        _flush_to_disk(staged)
        _refuse_read_only(output)
        if os.name == "nt" and os.path.isfile(str(output)):
            _replace_existing_windows(staged, output)
        else:
            _rename_over(staged, output)
    finally:
        _discard(staged)


def landing_path(output) -> Path:
    """The file a write to ``output`` replaces.

    A symbolic link lands on the file it points to, so the link stays a link.
    A hard link is a second name for the old file object: the swap gives the
    written name a new object and the other names keep the old bytes.
    """
    output = Path(output)
    if os.path.islink(str(output)):
        return Path(os.path.realpath(str(output)))
    return output


def is_stage_path(path) -> bool:
    """Whether ``path`` is a stage an enclosing scope already owns."""
    return _STAGE_NAME.match(Path(path).name) is not None


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
    output = landing_path(output)
    staged = staging_target(output)
    landed = False
    try:
        yield staged
        finish_staged(staged, output)
        landed = True
    finally:
        if not landed:
            _discard(staged)


def publish_copy(produced: Path, output: Path) -> None:
    """Land a finished file from anywhere (another directory, another volume)
    at ``output`` without ever writing into ``output`` itself.

    A copy into an existing destination truncates it first, so a death or a
    full disk part-way leaves a torn file where the previous one was. The copy
    goes to a staging file beside ``output`` and lands with :func:`finish_staged`.
    """
    with staged_write(Path(output)) as staged:
        shutil.copy2(str(produced), str(staged))


@contextmanager
def staged_write_if(same_file: bool, output: Path) -> Iterator[Path]:
    """:func:`staged_write` for a producer that is handed one path and writes
    it over seconds — a Ghostscript run — so the whole producer runs inside
    the scope that owns the staged file.

    Every output stages, not only one that names its own input: a producer
    killed mid-write into an existing file leaves that file torn, and one
    killed mid-write into a new file leaves a truncated document under the
    requested name. ``same_file`` does not change the target.
    """
    with staged_write(output) as staged:
        yield staged


@contextmanager
def atomic_output(output) -> Iterator[Path]:
    """:func:`staged_write` for a writer whose output is never its own input.

    The name keeps its previous bytes until the complete output replaces it.
    A stage path is written directly: the scope that made it lands it.
    """
    if is_stage_path(output):
        yield Path(output)
        return
    with staged_write(Path(output)) as staged:
        yield staged


def write_bytes_staged(output, data: bytes) -> None:
    """Land ``data`` at ``output``: the name holds either its previous bytes
    or all of ``data``, never a prefix."""
    with atomic_output(output) as staged:
        with open(str(staged), "wb") as handle:
            handle.write(data)


def write_text_staged(output, text: str, *, encoding: str = "utf-8",
                      newline: str | None = None) -> None:
    """:func:`write_bytes_staged` for text, with ``open``'s newline rules."""
    with atomic_output(output) as staged:
        with open(str(staged), "w", encoding=encoding, newline=newline) as handle:
            handle.write(text)
