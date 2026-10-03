"""Derived subprocess time budgets.

A FIXED wall-clock budget on a whole-document render fails on exactly the
documents the feature exists for. the reporter hit `timeout=300` on a
50 MB smartphone scan — the normal case for scanned-document work, not an
outlier — and the same fixed 300 s appears across the Ghostscript-backed ops.

So a budget is DERIVED from the work: a floor, plus an allowance per megabyte
of input and per page. The computed number is named in the timeout message,
which is what keeps a genuine hang distinguishable from a slow job: "gave up
after 300s" says nothing, while "did not finish within the derived budget
(940s, 52.1 MB, 210 pages)" says the job was given time proportional to its
size and still did not return.
"""

from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path

from . import gs_capability, platform_support
from .credentials import gs_password_argv


def derive(
    *,
    base: float,
    size_bytes: int = 0,
    pages: int = 0,
    per_mb: float = 0.0,
    per_page: float = 0.0,
    cap: float = 7200.0,
) -> float:
    """Seconds allowed for one subprocess run.

    `base` is the floor — a small file must still get enough time to start a
    process and load a runtime. The cap exists so a pathological input cannot
    produce an effectively-infinite budget; at two hours it is far above any
    honest run and far below "never returns".
    """
    if base <= 0:
        raise ValueError("a time budget needs a positive floor")
    mb = max(size_bytes, 0) / (1024.0 * 1024.0)
    derived = base + per_mb * mb + per_page * max(pages, 0)
    return min(derived, cap)


def for_file(path: str | Path, *, base: float, pages: int = 0, per_mb: float, per_page: float = 0.0) -> float:
    """`derive` with the size read off the file (0 when it is not there yet)."""
    try:
        size = Path(path).stat().st_size
    except OSError:
        size = 0
    return derive(base=base, size_bytes=size, pages=pages, per_mb=per_mb, per_page=per_page)


def describe(budget: float, *, size_bytes: int = 0, pages: int = 0) -> str:
    """The human half of a timeout message: what was allowed, and for what.

    Kept beside `derive` so a caller cannot report a budget it did not use.
    """
    parts = [f"{budget:.0f}s"]
    if size_bytes > 0:
        parts.append(f"{size_bytes / (1024.0 * 1024.0):.1f} MB")
    if pages > 0:
        parts.append(f"{pages} page{'s' if pages != 1 else ''}")
    return ", ".join(parts)


class TimeBudgetExceeded(RuntimeError):
    """A run that outlived its derived budget.

    Its own type, not a bare RuntimeError: a caller that has a SAFE SLOWER
    CODEC to fall back to must be able to catch a breach without also catching
    a malformed input or a crashed tool, and matching on the message text would
    be the string-matching this repo bans in control flow.
    """


class SubprocessOutputExceeded(RuntimeError):
    """A child produced more captured output than its caller can retain safely."""


DEFAULT_CAPTURE_LIMIT = 8 * 1024 * 1024
_READ_CHUNK = 64 * 1024
_PIPE_DRAIN_GRACE = 0.5


class _WindowsJob:
    """A kill-on-close job containing one suspended child and its descendants."""

    def __init__(self, handle: int, close_handle) -> None:
        self._handle = handle
        self._close_handle = close_handle
        self._lock = threading.Lock()

    def close(self) -> None:
        with self._lock:
            handle, self._handle = self._handle, 0
        if handle:
            self._close_handle(handle)


def _attach_windows_job(process: subprocess.Popen) -> _WindowsJob | None:
    """Contain a suspended Windows child before it can spawn descendants."""
    if os.name != "nt":
        return None

    import ctypes
    from ctypes import wintypes

    class BasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimitInformation),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [
        wintypes.HANDLE,
        ctypes.c_int,
        wintypes.LPVOID,
        wintypes.DWORD,
    ]
    kernel.SetInformationJobObject.restype = wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Thread32First.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
    kernel.Thread32First.restype = wintypes.BOOL
    kernel.Thread32Next.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
    kernel.Thread32Next.restype = wintypes.BOOL
    kernel.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenThread.restype = wintypes.HANDLE
    kernel.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel.ResumeThread.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL

    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        limits = ExtendedLimitInformation()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel.SetInformationJobObject(
            job, 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.AssignProcessToJobObject(job, process._handle):
            raise ctypes.WinError(ctypes.get_last_error())

        class ThreadEntry32(ctypes.Structure):
            _fields_ = [
                ("dwSize", wintypes.DWORD),
                ("cntUsage", wintypes.DWORD),
                ("th32ThreadID", wintypes.DWORD),
                ("th32OwnerProcessID", wintypes.DWORD),
                ("tpBasePri", ctypes.c_long),
                ("tpDeltaPri", ctypes.c_long),
                ("dwFlags", wintypes.DWORD),
            ]

        snapshot = kernel.CreateToolhelp32Snapshot(0x00000004, 0)  # SNAPTHREAD
        invalid_handle = ctypes.c_void_p(-1).value
        if not snapshot or snapshot == invalid_handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            entry = ThreadEntry32()
            entry.dwSize = ctypes.sizeof(entry)
            found = False
            has_thread = kernel.Thread32First(snapshot, ctypes.byref(entry))
            while has_thread:
                if entry.th32OwnerProcessID == process.pid:
                    thread = kernel.OpenThread(0x0002, False, entry.th32ThreadID)
                    if not thread:
                        raise ctypes.WinError(ctypes.get_last_error())
                    try:
                        if kernel.ResumeThread(thread) == 0xFFFFFFFF:
                            raise ctypes.WinError(ctypes.get_last_error())
                    finally:
                        kernel.CloseHandle(thread)
                    found = True
                    break
                has_thread = kernel.Thread32Next(snapshot, ctypes.byref(entry))
            if not found:
                raise OSError("Could not find the suspended child thread")
        finally:
            kernel.CloseHandle(snapshot)
        return _WindowsJob(int(job), kernel.CloseHandle)
    except BaseException:
        try:
            process.kill()
        except OSError:
            pass
        kernel.CloseHandle(job)
        raise


def timed_out(what: str, budget: float, *, size_bytes: int = 0, pages: int = 0) -> TimeBudgetExceeded:
    """The refusal a caller raises when `subprocess.TimeoutExpired` fires."""
    return TimeBudgetExceeded(
        f"{what} did not finish within the derived budget "
        f"({describe(budget, size_bytes=size_bytes, pages=pages)})."
    )


def run(cmd: list[str], *, what: str, budget: float, size_bytes: int = 0, pages: int = 0,
        cwd: str | Path | None = None, text: bool = False,
        max_output_bytes: int = DEFAULT_CAPTURE_LIMIT) -> subprocess.CompletedProcess:
    """`subprocess.run` with a derived budget and an honest timeout message.

    stdin is isolated for every subprocess this module runs: a bundled tool
    that inherits the engine's RPC pipe can read the next request's bytes.
    `text` decodes stdout/stderr for the callers that read diagnostics as
    strings; the binary default is what a codec's stdout needs.
    """
    if max_output_bytes < 0:
        raise ValueError("a subprocess output limit cannot be negative")

    # subprocess.run(capture_output=True) buffers both streams until the child
    # exits. A malformed document can make a codec or renderer print for its
    # entire time budget, so drain concurrently and retain only a fixed amount.
    # The page codec that returns binary stdout may request a larger, input-
    # derived cap; diagnostics and every other caller use the fixed default.
    launch_options = {}
    if os.name == "nt":
        # The child must not run even briefly outside its per-run job: it
        # could otherwise spawn a grandchild before job assignment.
        launch_options["creationflags"] = 0x00000004  # CREATE_SUSPENDED
    process = platform_support.popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(cwd) if cwd is not None else None,
        text=False,
        start_new_session=(os.name == "posix"),
        **launch_options,
    )
    try:
        windows_job = _attach_windows_job(process)
    except BaseException:
        try:
            process.kill()
        except OSError:
            pass
        process.wait()
        raise
    stdout = bytearray()
    stderr = bytearray()
    captured_bytes = 0
    exceeded: list[str] = []
    exceeded_lock = threading.Lock()

    def terminate() -> None:
        # Engine subprocesses are not meant to leave helpers behind. On Unix,
        # make the child its own process group and close that whole group; on
        # Windows the engine itself runs inside the host's kill-on-close job.
        if os.name == "posix":
            import signal

            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            if windows_job is not None:
                windows_job.close()
            try:
                process.kill()
            except OSError:
                pass

    def drain(pipe, captured: bytearray, name: str) -> None:
        nonlocal captured_bytes
        while True:
            chunk = pipe.read(_READ_CHUNK)
            if not chunk:
                return
            with exceeded_lock:
                remaining = max_output_bytes - captured_bytes
                if len(chunk) > remaining:
                    if remaining > 0:
                        captured.extend(chunk[:remaining])
                        captured_bytes += remaining
                    first = not exceeded
                    if first:
                        exceeded.append(name)
                else:
                    captured.extend(chunk)
                    captured_bytes += len(chunk)
                    first = False
            if first:
                terminate()

    assert process.stdout is not None and process.stderr is not None
    readers = [
        threading.Thread(target=drain, args=(process.stdout, stdout, "stdout"), daemon=True),
        threading.Thread(target=drain, args=(process.stderr, stderr, "stderr"), daemon=True),
    ]
    started_readers = []
    try:
        for reader in readers:
            reader.start()
            started_readers.append(reader)
    except BaseException:
        # If thread creation fails (for example under process-wide resource
        # pressure), the child has no complete set of pipe drains and cannot
        # safely be left running without the wait/timeout path below.
        try:
            terminate()
        except OSError:
            pass
        try:
            process.wait()
        finally:
            for reader in started_readers:
                reader.join(_PIPE_DRAIN_GRACE)
            if windows_job is not None:
                windows_job.close()
        raise
    try:
        process.wait(timeout=budget)
    except subprocess.TimeoutExpired:
        terminate()
        process.wait()
        timed_out_flag = True
    else:
        timed_out_flag = False
        # The direct child can leave descendants running even when they close
        # both pipes. Retire its whole process group/job before returning.
        terminate()
    drain_deadline = time.monotonic() + _PIPE_DRAIN_GRACE
    for reader in readers:
        reader.join(max(0.0, drain_deadline - time.monotonic()))
    if any(reader.is_alive() for reader in readers):
        # On Unix this closes the group while the inherited pipes are still
        # evidence that a descendant exists, so its group id cannot be reused.
        terminate()
        # Do not turn a finished child into an unbounded wait on a stray pipe
        # handle. Readers are daemon threads and retain at most the same fixed
        # cap while they drain any handle a child escaped with on Windows.
        final_deadline = time.monotonic() + _PIPE_DRAIN_GRACE
        for reader in readers:
            reader.join(max(0.0, final_deadline - time.monotonic()))

    try:
        if exceeded:
            raise SubprocessOutputExceeded(
                f"{what} exceeded the {max_output_bytes}-byte captured-output limit on {exceeded[0]}."
            )
        if timed_out_flag:
            raise timed_out(what, budget, size_bytes=size_bytes, pages=pages) from None

        out: bytes | str = bytes(stdout)
        err: bytes | str = bytes(stderr)
        if text:
            import io

            out = io.TextIOWrapper(io.BytesIO(out)).read()
            err = io.TextIOWrapper(io.BytesIO(err)).read()
        return subprocess.CompletedProcess(cmd, process.returncode, out, err)
    finally:
        if windows_job is not None:
            windows_job.close()


def gs(cmd: list[str], *, what: str, path: str | Path, pages: int = 0,
       base: float = 300.0, per_mb: float = 12.0, per_page: float = 1.5,
       text: bool = True) -> subprocess.CompletedProcess:
    """One Ghostscript run over `path`, with the budget derived from it.

    The whole gs family shares this so the defect cannot be half-fixed:
    a fixed 300 s died on a reported 50 MB scan, and every
    sibling op carried the same constant. The coefficients are one set on
    purpose — a per-op table would drift, and the honest statement is "time
    proportional to the work", not "this op is special".

    **The floor is the family's OWN old constant, and that is deliberate.**
    The defect was "too little time for a big file", never "too much for a
    small one", so every input now gets AT LEAST what it got before and large
    ones get more. Lowering the floor would have converted a slow-but-passing
    small job into a new failure — fixing a timeout by introducing one.

    A configured Ghostscript can be missing or broken, so this is also where
    its availability is decided: `cmd[0]` is validated by `gs_capability` and REPLACED with the
    validated path before anything spawns. Deciding it here rather than at
    each door is what makes the refusal one message instead of a dozen
    spellings of "file not found", and what stops an unconfigured run from
    reaching the OS as a spawn failure.
    """
    capability = gs_capability.require(cmd[0] if cmd else "")
    cmd = [capability.path, *cmd[1:]]
    size = 0
    try:
        size = Path(path).stat().st_size
    except OSError:
        pass
    allowed = derive(base=base, size_bytes=size, pages=pages, per_mb=per_mb, per_page=per_page)
    # `path` sizes the budget and is not always the document gs reads, which
    # every caller passes last.
    with gs_password_argv(cmd, path, cmd[-1]) as argv:
        return run(argv, what=what, budget=allowed, size_bytes=size, pages=pages, text=text)
