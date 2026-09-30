"""Host-platform facts the engine needs to name and find its bundled tools.

A bundled program's file name differs by platform (`tesseract.exe` on
Windows, `tesseract` elsewhere), and so does the provisioning script that
vendors it. Every lookup and every refusal that names one goes through this
module, so no caller spells a `.exe` suffix or a `.ps1` script by hand.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

IS_WINDOWS = os.name == "nt"

#: The directory under the dev tree's `resources/` that holds the native
#: Linux trees. A checkout shared with a Windows host keeps both platforms'
#: trees side by side; the shipped layout has no such level.
DEV_PLATFORM_DIR = "" if IS_WINDOWS else f"{sys.platform.rstrip('0123456789')}-x86_64"


def program_name(stem: str) -> str:
    """`stem` spelled as this platform's executable file name."""
    return f"{stem}.exe" if IS_WINDOWS else stem


def bundle_script(stem: str) -> str:
    """The repository script that provisions a vendored tool on this platform."""
    return f"scripts/{stem}.ps1" if IS_WINDOWS else f"scripts/{stem}.sh"


def shared_library_name(windows_name: str, posix_name: str) -> str:
    """The file name of a vendored shared library on this platform."""
    return windows_name if IS_WINDOWS else posix_name


def program_relative(stem: str) -> tuple[str, ...]:
    """A vendored program's path relative to its component tree.

    A Linux tree is the pinned artifact unpacked as published: programs in
    `bin/` load their libraries from `lib/` through RUNPATH `$ORIGIN/../lib`,
    so flattening the tree would break the load.
    """
    return (program_name(stem),) if IS_WINDOWS else ("bin", stem)


def library_relative(windows_name: str, posix_name: str) -> tuple[str, ...]:
    """A vendored shared library's path relative to its component tree."""
    return (windows_name,) if IS_WINDOWS else ("lib", posix_name)


def tessdata_dir(tesseract: Path) -> Path:
    """The language-model directory of a vendored Tesseract program."""
    if IS_WINDOWS:
        return tesseract.parent / "tessdata"
    return tesseract.parent.parent / "share" / "tessdata"


def vendored_candidates(engine_dir: Path, component: str, *relative: str) -> tuple[Path, ...]:
    """Where a vendored tree's file sits relative to the engine package.

    Shipped: `<resources>/engine/` beside `<resources>/<component>/`. Dev tree:
    `src/engine/` with `<repo>/resources/<component>/`, or on a non-Windows
    host `<repo>/resources/<platform>/<component>/` for a native tree.
    """
    shipped = engine_dir.parent / component
    dev = engine_dir.parent.parent / "resources"
    if DEV_PLATFORM_DIR:
        dev = dev / DEV_PLATFORM_DIR
    return (shipped.joinpath(*relative), (dev / component).joinpath(*relative))


#: The host passes the decimal number of an inherited lease-channel socket in
#: this variable (see `adopt_lease_channel`).
LEASE_FD_ENV = "SPECTRAPDF_LEASE_FD"

_lease_fd: int | None = None


def adopt_lease_channel() -> int | None:
    """Take ownership of the host's folder-lease channel, if one was passed.

    The socket's single queued message holds the lock-file descriptions of
    every folder lease the host shares with this process; each lease stays
    held while this process keeps the socket open. The socket is therefore
    never read, written, or closed. It is marked close-on-exec so no child
    carries a lease past this process's death, and the variable is removed so
    no child reads a descriptor number that is not its own.
    """
    global _lease_fd
    raw = os.environ.pop(LEASE_FD_ENV, None)
    if _lease_fd is not None or raw is None or IS_WINDOWS:
        return _lease_fd
    try:
        fd = int(raw)
        os.fstat(fd)
    except (ValueError, OSError):
        return None
    os.set_inheritable(fd, False)
    _lease_fd = fd
    return fd


def lease_channel() -> int | None:
    """The descriptor adopted by `adopt_lease_channel`, if any."""
    return _lease_fd


if sys.platform.startswith("linux"):
    import ctypes
    import signal

    _PR_SET_PDEATHSIG = 1
    # Resolved before any fork: the child between fork and exec may run only
    # the already-bound C call, never an import or a symbol lookup.
    _prctl = ctypes.CDLL(None, use_errno=True).prctl
    _prctl.argtypes = (ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong)
    _prctl.restype = ctypes.c_int

    def _die_with(parent: int):
        def arm() -> None:
            if _prctl(_PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
                os._exit(127)
            # The parent can die between fork and prctl; the signal is then
            # never sent and the child is already reparented.
            if os.getppid() != parent:
                os.kill(os.getpid(), signal.SIGKILL)

        return arm

    def _spawn_options() -> dict:
        return {"preexec_fn": _die_with(os.getpid())}

else:

    def _spawn_options() -> dict:
        return {}


def spawn_options() -> dict:
    """Keyword arguments every engine child process is started with.

    On Linux the child receives SIGKILL when the thread that spawned it dies,
    so a spawn must come from a thread that outlives the child (the request
    loop's main thread).
    """
    return _spawn_options()


def popen(args, **kwargs):
    """`subprocess.Popen` with `spawn_options`. Every engine spawn uses this or `run`."""
    import subprocess

    return subprocess.Popen(args, **kwargs, **spawn_options())


def run(args, **kwargs):
    """`subprocess.run` with `spawn_options`."""
    import subprocess

    return subprocess.run(args, **kwargs, **spawn_options())
