"""Host-platform facts the engine needs to name and find its bundled tools.

A bundled program's file name differs by platform (`tesseract.exe` on
Windows, `tesseract` elsewhere), and so does the provisioning script that
vendors it. Every lookup and every refusal that names one goes through this
module, so no caller spells a `.exe` suffix or a `.ps1` script by hand.
"""

from __future__ import annotations

import os
import sys
from typing import NamedTuple
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
    """The bundled Windows Ghostscript's possible paths that exist."""
    if not IS_WINDOWS:
        return ()
    base = engine_dir if engine_dir is not None else Path(__file__).parent
    return tuple(
        str(candidate)
        for candidate in vendored_candidates(base, "ghostscript", "gswin64c.exe")
        if os.path.isfile(candidate)
    )


def _same_file(first: str, second: str) -> bool:
    """Whether two paths name one file, by volume and file index rather than
    by spelling: a hard link, a junction-reached path, a short name and a case
    variant of the bundled program are the bundled program. A path that does
    not exist names no file."""
    try:
        return os.path.samefile(first, second)
    except (OSError, ValueError):
        return False


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
    if not first or not any(_same_file(first, program) for program in programs):
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


# ── cache folders under the temp directory ─────────────────────────────────
#
# On a POSIX host the temp directory can be shared by every account. A cache
# folder there that another account created first, or a file another account
# placed in it, would let that account choose what the engine reads back as a
# cached result. Each folder is created 0700 and checked without following a
# symbolic link: a folder, owned by the effective user, with no bits for
# anyone else. A folder this user owns with looser bits is tightened; anything
# else is a refusal. The Windows temp directory is per-user.

_CACHE_ROOT_NAME = "spectrapdf"
_OTHERS = 0o077


def _owned_by_this_user(meta: os.stat_result) -> bool:
    return meta.st_uid == os.geteuid()


def ensure_private_dir(path: Path) -> None:
    """Create `path` 0700 if absent, then refuse unless this user owns it as a
    real folder; loose permission bits of an owned folder are tightened."""
    import stat

    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    meta = os.lstat(path)
    if not stat.S_ISDIR(meta.st_mode) or not _owned_by_this_user(meta):
        raise PermissionError(f"{path} is not a folder this user owns")
    if stat.S_IMODE(meta.st_mode) & _OTHERS:
        os.chmod(path, 0o700)


def private_cache_dir(name: str) -> Path:
    """`<temp>/spectrapdf/<name>`, private to this user."""
    import tempfile

    root = Path(tempfile.gettempdir()) / _CACHE_ROOT_NAME
    folder = root / name
    if IS_WINDOWS:
        folder.mkdir(parents=True, exist_ok=True)
        return folder
    ensure_private_dir(root)
    ensure_private_dir(folder)
    return folder


SYSTEM_SID = "S-1-5-18"
ADMINISTRATORS_SID = "S-1-5-32-544"
OWNER_RIGHTS_SID = "S-1-3-4"
CREATOR_OWNER_SID = "S-1-3-0"

#: `GetVolumeInformationW` file-system flag of a volume that stores ACLs.
#: FAT and exFAT lack it; on them `GetNamedSecurityInfoW` succeeds with a
#: synthesized owner and a NULL DACL, which name no account at all.
_FILE_PERSISTENT_ACLS = 0x00000008


class _Security(NamedTuple):
    """What a Windows entry records about who owns it and who may use it.
    `status` is the Win32 error of the query (0 on success). `allowed` holds
    the SIDs of every access-allowed entry, inherit-only ones included (they
    govern every file created inside), or None when the DACL is absent or
    holds an entry this reading does not interpret (which grants access to
    anyone the reading cannot name)."""

    status: int
    owner: str | None = None
    allowed: frozenset | None = None


def _volume_keeps_acls(path) -> bool | None:
    """Whether the volume holding `path` stores ACLs, or None when the volume
    cannot be read."""
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetVolumePathNameW.argtypes = (wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD)
    kernel.GetVolumePathNameW.restype = wintypes.BOOL
    kernel.GetVolumeInformationW.argtypes = (
        wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR, wintypes.DWORD,
    )
    kernel.GetVolumeInformationW.restype = wintypes.BOOL
    root = ctypes.create_unicode_buffer(32768)
    if not kernel.GetVolumePathNameW(str(path), root, len(root)):
        return None
    flags = wintypes.DWORD()
    if not kernel.GetVolumeInformationW(root.value, None, 0, None, None, ctypes.byref(flags), None, 0):
        return None
    return bool(flags.value & _FILE_PERSISTENT_ACLS)


class _Token(NamedTuple):
    user: str
    owner: str


def _sid_text(advapi, kernel, sid) -> str | None:
    import ctypes
    from ctypes import wintypes

    text = wintypes.LPWSTR()
    if not advapi.ConvertSidToStringSidW(ctypes.c_void_p(sid), ctypes.byref(text)):
        return None
    try:
        return text.value
    finally:
        kernel.LocalFree(text)


def _windows_api():
    import ctypes
    from ctypes import wintypes

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.GetNamedSecurityInfoW.argtypes = (
        wintypes.LPCWSTR, ctypes.c_int, wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
    )
    advapi.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi.ConvertSidToStringSidW.argtypes = (ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR))
    advapi.ConvertSidToStringSidW.restype = wintypes.BOOL
    advapi.OpenProcessToken.argtypes = (wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE))
    advapi.OpenProcessToken.restype = wintypes.BOOL
    advapi.GetTokenInformation.argtypes = (
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
    )
    advapi.GetTokenInformation.restype = wintypes.BOOL
    advapi.GetAce.argtypes = (ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p))
    advapi.GetAce.restype = wintypes.BOOL
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel.LocalFree.argtypes = (ctypes.c_void_p,)
    return advapi, kernel


def _windows_security(path) -> _Security:
    """The owner and the allowed SIDs recorded on `path`."""
    import ctypes

    advapi, kernel = _windows_api()
    owner = ctypes.c_void_p()
    dacl = ctypes.c_void_p()
    descriptor = ctypes.c_void_p()
    # SE_FILE_OBJECT = 1; OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION = 1 | 4
    status = advapi.GetNamedSecurityInfoW(
        str(path), 1, 5, ctypes.byref(owner), None, ctypes.byref(dacl), None, ctypes.byref(descriptor)
    )
    if status != 0:
        return _Security(status)
    try:
        owner_text = _sid_text(advapi, kernel, owner.value) if owner.value else None
        if not dacl.value:
            return _Security(0, owner_text, None)
        # ACL header: revision byte, Sbz1 byte, AclSize word, AceCount word.
        count = ctypes.c_uint16.from_address(dacl.value + 4).value
        allowed = set()
        for index in range(count):
            ace = ctypes.c_void_p()
            if not advapi.GetAce(dacl, index, ctypes.byref(ace)):
                return _Security(0, owner_text, None)
            kind = ctypes.c_uint8.from_address(ace.value).value
            if kind == 1:  # ACCESS_DENIED_ACE_TYPE narrows access
                continue
            if kind != 0:  # anything but ACCESS_ALLOWED_ACE_TYPE is not read here
                return _Security(0, owner_text, None)
            # ACCESS_ALLOWED_ACE: header (4 bytes), Mask (4 bytes), SidStart.
            sid = _sid_text(advapi, kernel, ace.value + 8)
            if sid is None:
                return _Security(0, owner_text, None)
            allowed.add(sid)
        return _Security(0, owner_text, frozenset(allowed))
    finally:
        kernel.LocalFree(descriptor)


def _windows_token() -> _Token | None:
    """This process's user SID and the default owner of what it creates."""
    import ctypes
    from ctypes import wintypes

    advapi, kernel = _windows_api()
    token = wintypes.HANDLE()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):
        return None
    try:
        found = []
        # TokenUser = 1, TokenOwner = 4: each starts with a pointer to a SID.
        for information in (1, 4):
            size = wintypes.DWORD()
            advapi.GetTokenInformation(token, information, None, 0, ctypes.byref(size))
            buffer = ctypes.create_string_buffer(max(size.value, 1))
            if not size.value or not advapi.GetTokenInformation(
                token, information, buffer, size, ctypes.byref(size)
            ):
                return None
            sid = ctypes.c_void_p.from_buffer(buffer).value
            text = _sid_text(advapi, kernel, sid) if sid else None
            if text is None:
                return None
            found.append(text)
        return _Token(user=found[0], owner=found[1])
    finally:
        kernel.CloseHandle(token)


def owner_acceptable(security: _Security, token: _Token | None) -> bool:
    """Whether an entry with `security` is this process's own.

    Its owner is this process's user or its token's default owner. An entry
    owned by Administrators is also accepted when its DACL lets only this
    user, SYSTEM and Administrators in: an elevated token creates objects
    owned by Administrators, and a later standard token of the same user must
    still find its own caches and stages. OWNER RIGHTS names the owner itself
    and CREATOR OWNER the owner of each file created inside."""
    if security.status != 0 or token is None or security.owner is None:
        return False
    if security.owner in (token.user, token.owner):
        return True
    if security.owner == ADMINISTRATORS_SID and security.allowed is not None:
        return security.allowed <= {
            token.user, SYSTEM_SID, ADMINISTRATORS_SID, OWNER_RIGHTS_SID, CREATOR_OWNER_SID,
        }
    return False


def _windows_owner_is_this_process(path) -> bool:
    """On a volume that stores no ACLs (FAT, exFAT) no account can own an
    entry, so the caller's lstat and reparse checks decide alone. Anything
    that cannot be read refuses."""
    try:
        keeps = _volume_keeps_acls(path)
        if keeps is None:
            return False
        if not keeps:
            return True
        return owner_acceptable(_windows_security(path), _windows_token())
    except OSError:
        return False


def dacl_grants_only(path, sid: str) -> bool:
    """Whether the DACL recorded on `path` lets `sid` in and nobody else."""
    if not IS_WINDOWS:
        return False
    try:
        security = _windows_security(path)
    except OSError:
        return False
    return security.status == 0 and security.allowed == frozenset({sid})


def windows_user_sid() -> str | None:
    if not IS_WINDOWS:
        return None
    try:
        token = _windows_token()
    except OSError:
        return None
    return token.user if token is not None else None


def owned_entry(path: Path, *, directory: bool) -> bool:
    """Whether `path` is a real folder (or regular file) this user owns, never
    a link or another reparse point. On Windows the owner recorded on the
    entry must be this process's user or its token's default owner."""
    import stat

    try:
        meta = os.lstat(path)
    except OSError:
        return False
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if not kind(meta.st_mode):
        return False
    if IS_WINDOWS:
        if getattr(meta, "st_file_attributes", 0) & 0x400:  # FILE_ATTRIBUTE_REPARSE_POINT
            return False
        return _windows_owner_is_this_process(path)
    return _owned_by_this_user(meta)
