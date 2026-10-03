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


#: Set by the host to the AppImage's mount point when the engine runs from one.
IMAGE_ROOT_ENV = "SPECTRAPDF_IMAGE_ROOT"

_ELF_MAGIC = b"\x7fELF"
_PT_INTERP = 3


def _requests_interpreter(program: Path) -> bool:
    """Whether `program` is a 64-bit little-endian ELF file with a PT_INTERP header."""
    try:
        with program.open("rb") as handle:
            header = handle.read(64)
            if len(header) < 64 or header[:4] != _ELF_MAGIC or header[4] != 2 or header[5] != 1:
                return False
            phoff = int.from_bytes(header[0x20:0x28], "little")
            phentsize = int.from_bytes(header[0x36:0x38], "little")
            phnum = int.from_bytes(header[0x38:0x3A], "little")
            handle.seek(phoff)
            table = handle.read(phentsize * phnum)
    except OSError:
        return False
    return any(
        int.from_bytes(table[i:i + 4], "little") == _PT_INTERP
        for i in range(0, len(table) - 3, max(phentsize, 1))
    )


def image_library_path(root: Path, program: Path) -> str:
    """The library search path a payload program runs with inside an AppImage:
    its own directory and `../lib`, LibreOffice's `program/` for that tree,
    then the image's `lib/` and every directory `lib/lib.path` names."""
    dirs = [program.parent, program.parent.parent / "lib"]
    office = root / "lib" / "spectrapdf" / "libreoffice" / "program"
    if office in program.parents:
        dirs.append(office)
    dirs.append(root / "lib")
    try:
        lines = (root / "lib" / "lib.path").read_text(encoding="utf-8").splitlines()
    except OSError:
        lines = []
    dirs += [root / "lib" / line[1:].lstrip("/") for line in lines if line.startswith("+") and line != "+"]
    return ":".join(str(d) for d in dirs)


def image_root(root: str | None = None) -> Path | None:
    """The AppImage this engine runs from, or None.

    `SPECTRAPDF_IMAGE_ROOT` alone is not proof: a process started from another
    AppImage inherits it, and a system prefix such as /usr holds no image
    loader. The image's loader and its payload must both be there.
    """
    raw = os.environ.get(IMAGE_ROOT_ENV) if root is None else root
    if not raw or not os.path.isabs(raw):
        return None
    image = Path(raw)
    if (image / "lib" / "ld-linux-x86-64.so.2").is_file() and (image / "lib" / "spectrapdf").is_dir():
        return image
    return None


def image_argv(args, root: str | None = None):
    """`args`, with a payload program started on the AppImage's dynamic loader.

    Payload programs name the system loader as their interpreter and would
    otherwise run on the host's C library, whatever its version. A program
    outside the payload (the image's own `bin/gs`, a launcher script, a host
    program) is left as it is.
    """
    image = image_root(root)
    if image is None or isinstance(args, (str, bytes, os.PathLike)) or not args:
        return args
    first = os.fspath(args[0])
    if not os.path.isabs(first):
        return args
    program = Path(os.path.realpath(first))
    payload = Path(os.path.realpath(image / "lib" / "spectrapdf"))
    if payload not in program.parents or not _requests_interpreter(program):
        return args
    loader = image / "lib" / "ld-linux-x86-64.so.2"
    return [str(loader), "--library-path", image_library_path(image, program), str(program), *list(args)[1:]]


def _program_path(args, env) -> str | None:
    if isinstance(args, (str, bytes, os.PathLike)):
        first = os.fsdecode(args).split()[0] if os.fsdecode(args).split() else ""
    else:
        first = os.fsdecode(os.fspath(args[0])) if args else ""
    if not first:
        return None
    if os.path.sep in first:
        return os.path.realpath(first)
    import shutil

    found = shutil.which(first, path=(env or os.environ).get("PATH"))
    return os.path.realpath(found) if found else None


def image_env(args, env=None, root: str | None = None):
    """The environment for a child of an AppImage engine, or None to keep `env`.

    The image's start sets variables that name the image (GS_LIB at the
    image's Ghostscript init files, GTK_PATH, GIO_MODULE_DIR, XDG_DATA_DIRS
    entries, and more). A program outside the image, such as a Ghostscript
    the user named, reads them as its own and fails. For such a program every
    LD_ variable goes, every image entry leaves a colon-separated list, and
    every other variable that names the image goes. A program inside the image
    keeps the environment as it is.
    """
    image = image_root(root)
    if image is None:
        return None
    roots = {str(image), os.path.realpath(image)}
    program = _program_path(args, env)
    if program is not None and any(program == r or program.startswith(r + os.sep) for r in roots):
        return None
    cleaned = {}
    for name, value in (os.environ if env is None else env).items():
        if name.startswith("LD_"):
            continue
        if not any(r in value for r in roots):
            cleaned[name] = value
            continue
        if ":" in value:
            kept = [part for part in value.split(":") if not any(r in part for r in roots)]
            if kept:
                cleaned[name] = ":".join(kept)
    return cleaned


#: The bundled Ghostscript's search path: its compiled-in ROM file system
#: alone. Ghostscript reads GS_LIB from the environment and consults the
#: registry value of the same name only when the variable is absent; a
#: separately installed Ghostscript of the same version registers its own lib
#: and fonts directories there, which would otherwise precede the ROM.
BUNDLED_GS_LIB = "%rom%Resource/Init/;%rom%lib/"


def bundled_gs_programs(engine_dir: Path | None = None) -> tuple[str, ...]:
    """The bundled Windows Ghostscript's possible paths, normalized for comparison."""
    if not IS_WINDOWS:
        return ()
    base = engine_dir if engine_dir is not None else Path(__file__).parent
    return tuple(
        os.path.normcase(os.path.realpath(candidate))
        for candidate in vendored_candidates(base, "ghostscript", "gswin64c.exe")
    )


def bundled_gs_env(args, env=None, engine_dir: Path | None = None):
    """The environment for a child that is the bundled Ghostscript, or None to keep `env`."""
    programs = bundled_gs_programs(engine_dir)
    if not programs:
        return None
    if isinstance(args, (str, bytes, os.PathLike)):
        words = os.fsdecode(args).split()
        first = words[0] if words else ""
    else:
        first = os.fsdecode(os.fspath(args[0])) if args else ""
    if not first or os.path.normcase(os.path.realpath(first)) not in programs:
        return None
    child = dict(os.environ if env is None else env)
    child["GS_LIB"] = BUNDLED_GS_LIB
    return child


def _image_spawn(args, kwargs):
    env = image_env(args, kwargs.get("env"))
    if env is not None:
        kwargs = dict(kwargs, env=env)
    env = bundled_gs_env(args, kwargs.get("env"))
    if env is not None:
        kwargs = dict(kwargs, env=env)
    return image_argv(args), kwargs


def popen(args, **kwargs):
    """`subprocess.Popen` with `spawn_options`. Every engine spawn uses this or `run`."""
    import subprocess

    args, kwargs = _image_spawn(args, kwargs)
    return subprocess.Popen(args, **kwargs, **spawn_options())


def run(args, **kwargs):
    """`subprocess.run` with `spawn_options`."""
    import subprocess

    args, kwargs = _image_spawn(args, kwargs)
    return subprocess.run(args, **kwargs, **spawn_options())
