"""Per-document credentials for documents opened with a password.

ISO 32000-2 7.6.4.1: a document with a user password and a different owner
password opened with the USER password stays encrypted, and only the
operations its /P bits allow may run on it. The working copy therefore keeps
its /Encrypt, and every later read of it needs the password again. The
password lives here, in this process, and is never placed in a response. The
one file it is written to is a Ghostscript argument file inside an
owner-only temporary folder for the length of one run (`gs_password_argv`);
a folder a killed engine left behind is removed at the next engine start
(`remove_stale_gs_argfiles`).

Keys are canonical paths, so two spellings of one working copy share one
record. A path that is not a known document opens with the empty password,
and an encrypted one still raises `pikepdf.PasswordError`.
"""

import json
import os
import shutil
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from engine.inplace import atomic_output

_PERMISSION_KEYS = (
    ("print", "print_lowres"),
    ("print_high", "print_highres"),
    ("modify", "modify_other"),
    ("copy", "extract"),
    ("annotate", "modify_annotation"),
    ("fill", "modify_form"),
    ("accessibility", "accessibility"),
    ("assemble", "modify_assembly"),
)


@dataclass(frozen=True)
class _Credential:
    opener: str
    password: str | None = field(repr=False)
    permissions: dict
    revision: int | None
    p: int | None
    origin: str = ""
    #: The authenticated public-key security handler of a certificate open
    #: (ISO 32000-2 7.6.5): it holds the recipients' seed, which reseals the
    #: plaintext working copy under the document's own recipient lists.
    handler: object = field(default=None, repr=False, compare=False)


_documents: dict[str, _Credential] = {}


def _key(path) -> str:
    return os.path.normcase(os.path.realpath(os.fspath(path)))


def _is_path(source) -> bool:
    return isinstance(source, (str, os.PathLike))


def open_pdf(source, *args, document=None, **kwargs):
    """`pikepdf.open` with the stored password of a known document.

    `document` names the path whose credential applies when `source` is a
    stream over that document's bytes. A Pdf opened with a user-password credential is marked, so `save_pdf`
    writes it back with its own /Encrypt (`encryption=True`): qpdf cannot
    rebuild that protection without the owner password, and a default save
    drops it."""
    import pikepdf

    credential = None
    named = document if document is not None else source
    if "password" not in kwargs and _is_path(named):
        credential = _documents.get(_key(named))
        if credential is not None and credential.password is not None:
            kwargs["password"] = credential.password
    pdf = pikepdf.open(source, *args, **kwargs)
    if credential is not None and credential.opener == "user" and pdf.is_encrypted:
        pdf._spectra_preserve_encryption = True
        pdf._spectra_credential = credential
    if _is_path(named):
        recipient = _credential_for(named)
        if (
            recipient is not None
            and recipient.opener == "recipient"
            and not (recipient.p or 0) & _PUBKEY_ENCRYPTION_CHANGE
        ):
            # The plaintext of a restricted certificate-opened document: its
            # pages may be written only inside its own private working folder.
            folder = os.path.dirname(_key(named))
            pdf._spectra_recipient_folder = folder
            _hold_recipient_folder(pdf, folder)
    return pdf


#: Folders of restricted certificate-opened documents open in this process,
#: counted per open. qpdf copies foreign objects lazily, so a document holding
#: pages of one can only be written while that one is still open; requests run
#: one at a time, so every write in that window is checked against these.
_open_recipient_folders: dict[str, int] = {}


def _hold_recipient_folder(pdf, folder: str) -> None:
    _open_recipient_folders[folder] = _open_recipient_folders.get(folder, 0) + 1
    close = pdf.close
    released = False

    def release_and_close():
        nonlocal released
        if not released:
            released = True
            left = _open_recipient_folders.get(folder, 1) - 1
            if left > 0:
                _open_recipient_folders[folder] = left
            else:
                _open_recipient_folders.pop(folder, None)
        close()

    pdf.close = release_and_close


def end_request() -> None:
    """Forget the restricted folders held by the request that just ended. A
    handle it leaked still refuses by its own mark; later requests are not
    bound by it."""
    _open_recipient_folders.clear()


def open_recipient_folders() -> set[str]:
    """Working folders of restricted certificate-opened documents now open."""
    return set(_open_recipient_folders)


def refuse_recipient_escape(target, folders) -> None:
    """Refuse a write to `target` outside any of `folders`."""
    if not folders or not _is_path(target):
        return
    parent = os.path.normcase(os.path.realpath(os.path.dirname(os.path.abspath(os.fspath(target)))))
    if any(parent != folder for folder in folders):
        from engine.pdf_save import _refuse_unreproducible_encryption

        _refuse_unreproducible_encryption(True, False)


def _restricted_recipient_folder(source):
    credential = _credential_for(source)
    if credential is None or credential.opener != "recipient":
        return None
    if (credential.p or 0) & _PUBKEY_ENCRYPTION_CHANGE:
        return None
    return os.path.dirname(_key(source))


def is_open_document(path) -> bool:
    """Whether `path` holds a credential: a document opened through the
    open funnel, or a file of a certificate-opened working folder."""
    return _credential_for(path) is not None


def document_password(source) -> str | None:
    """The stored user password of the document at `source`, or None.

    Every reader that does not go through `open_pdf` (pdfminer, pyHanko,
    Ghostscript) asks here, so a copy lent the credential reads the same as
    the working copy it came from."""
    if not _is_path(source):
        return None
    credential = _documents.get(_key(source))
    if credential is None or credential.opener != "user":
        return None
    return credential.password


def lend_saved_copy(pdf, target) -> None:
    """Lend `pdf`'s credential to `target`, a file just written from it with
    its own /Encrypt.

    A scratch, staged or intermediate file written from a user-opened
    document is encrypted with the same user password, so a later reopen by
    path needs the credential. The lend lasts until the original is closed.
    A path already holding a different document's credential keeps it."""
    _lend(getattr(pdf, "_spectra_credential", None), target)


def _lend(credential, target) -> None:
    if credential is None or not _is_path(target):
        return
    key = _key(target)
    held = _documents.get(key)
    if held is None or held is credential:
        _documents[key] = credential


def copy_document(source, target) -> None:
    """Copy the document at `source` to `target` byte for byte, lending the
    copy the credential of `source` until `source` is closed, as `save_pdf`
    does for a copy it writes."""
    if _is_path(source):
        folder = _restricted_recipient_folder(source)
        refuse_recipient_escape(target, {folder} if folder else set())
    with atomic_output(Path(target)) as staged:
        shutil.copyfile(source, staged)
    if _is_path(source):
        _lend(_documents.get(_key(source)), target)


@contextmanager
def lent(original, copy):
    """Lend the credential of `original` to `copy`, a byte copy of it, for
    the body of the block.

    A byte copy made outside `save_pdf` is otherwise unreadable when the
    original was opened with its user password."""
    credential = _documents.get(_key(original)) if _is_path(original) else None
    key = _key(copy)
    shared = credential is not None and key not in _documents
    if shared:
        _documents[key] = credential
    try:
        yield
    finally:
        if shared and _documents.get(key) is credential:
            del _documents[key]


#: The refusal of an operation the owner's permissions withhold from a
#: document opened with its user password.
PERMISSIONS_HELD = (
    "This document's permissions are held by an owner password, which is "
    "needed to change them. Open it with that password first."
)


#: The refusal of an operation the grants of a certificate recipient's list
#: withhold (ISO 32000-2 Table 24).
PERMISSIONS_HELD_BY_RECIPIENTS = (
    "This document's permissions are set by its certificate recipient lists, "
    "and your certificate's list does not allow this."
)

#: Table 24 bit 2: change of encryption, which enables every other permission.
_PUBKEY_ENCRYPTION_CHANGE = 1 << 1


class GhostscriptPasswordUnsupported(ValueError):
    """The stored password has no spelling Ghostscript's argument file reads
    back unchanged."""


GS_PASSWORD_UNSUPPORTED = (
    "This document's password cannot be handed to Ghostscript, so this "
    "operation cannot read the document. Open it with the owner password, or "
    "decrypt the document first."
)


def gs_password_line(password: str) -> str:
    """One `@file` argument line that Ghostscript 10 reads back as
    `-sPDFPassword=<password>`.

    Inside quotes a backslash-quote is a quote and every other backslash is
    literal, except a backslash before the closing quote, which escapes it.
    Unquoted, whitespace ends the argument and one final backslash is
    dropped. A password ending in a backslash therefore has a spelling only
    unquoted, and only without whitespace, a leading quote or a
    backslash-quote. A line break or NUL has no spelling."""
    if any(c in password for c in "\r\n\0"):
        raise GhostscriptPasswordUnsupported(GS_PASSWORD_UNSUPPORTED)
    if not password.endswith("\\"):
        return '"-sPDFPassword=' + password.replace('"', '\\"') + '"'
    if any(c.isspace() for c in password) or password.startswith('"') or '\\"' in password:
        raise GhostscriptPasswordUnsupported(GS_PASSWORD_UNSUPPORTED)
    return "-sPDFPassword=" + password + "\\"


_GS_FOLDER_PREFIX = "spectrapdf-gs-"
#: A folder younger than this may belong to a run of another engine process
#: (the health worker) between writing its argument file and spawning gs.
_GS_STALE_SECONDS = 60
_GS_LEGACY_STALE_SECONDS = 3 * 60 * 60
_GS_OWNER_FILE = ".owner-pid"


def _gs_process_is_running(pid: int) -> bool:
    """Return whether `pid` exists; uncertainty keeps the password file."""
    if pid <= 0 or pid > 0xFFFFFFFF:
        return True
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        open_process.restype = wintypes.HANDLE
        get_exit_code = kernel32.GetExitCodeProcess
        get_exit_code.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        get_exit_code.restype = wintypes.BOOL
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = (wintypes.HANDLE,)
        close_handle.restype = wintypes.BOOL
        handle = open_process(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            # ERROR_INVALID_PARAMETER means the PID no longer exists. Access
            # denied and every other failure are ambiguous, so fail closed.
            return ctypes.get_last_error() != 87
        try:
            exit_code = wintypes.DWORD()
            if not get_exit_code(handle, ctypes.byref(exit_code)):
                return True
            return exit_code.value == 259  # STILL_ACTIVE
        finally:
            close_handle(handle)

    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        # EPERM, transient process-table errors, and unknown platform errors
        # must not cause deletion of a possibly active password file.
        return True
    except OverflowError:
        return True


def _process_user_sid() -> str:
    """String SID of the user the process token belongs to.

    The folder names this SID as owner and sole ACE rather than OWNER RIGHTS:
    an elevated token's default owner is the Administrators group, and a folder
    owned by that group is unreadable to the same user's later non-elevated
    run, so the startup reclaim could never remove it."""
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
    kernel32.LocalFree.restype = ctypes.c_void_p
    advapi32.OpenProcessToken.argtypes = (wintypes.HANDLE, wintypes.DWORD,
                                          ctypes.POINTER(wintypes.HANDLE))
    advapi32.OpenProcessToken.restype = wintypes.BOOL
    advapi32.GetTokenInformation.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                             wintypes.DWORD, ctypes.POINTER(wintypes.DWORD))
    advapi32.GetTokenInformation.restype = wintypes.BOOL
    advapi32.ConvertSidToStringSidW.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))
    advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL

    token = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0x0008,  # TOKEN_QUERY
                                     ctypes.byref(token)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        needed = wintypes.DWORD()
        advapi32.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))  # TokenUser
        buffer = ctypes.create_string_buffer(needed.value)
        if not advapi32.GetTokenInformation(token, 1, buffer, needed, ctypes.byref(needed)):
            raise ctypes.WinError(ctypes.get_last_error())
        sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        text = ctypes.c_void_p()
        if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return ctypes.wstring_at(text.value)
        finally:
            kernel32.LocalFree(text)
    finally:
        kernel32.CloseHandle(token)


def _gs_folder_sddl(sid: str) -> str:
    """Owner `sid` and a protected DACL with one ACE, full control for `sid`:
    nothing is inherited from the temporary directory, and SYSTEM,
    Administrators and every other account get no access."""
    return f"O:{sid}D:P(A;OICI;FA;;;{sid})"


def _make_gs_folder() -> str:
    """Create an empty folder for one argument file, readable by its owner only.

    On Windows the DACL is applied by `CreateDirectoryW` at creation, so no
    moment exists in which the folder carries the temporary directory's
    inherited ACL; `tempfile.mkdtemp` applies an owner-only DACL only from
    Python 3.13. Elsewhere `mkdtemp` creates it with mode 0o700."""
    if os.name != "nt":
        return tempfile.mkdtemp(prefix=_GS_FOLDER_PREFIX)
    import ctypes
    import secrets
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    to_descriptor = advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW
    to_descriptor.argtypes = (wintypes.LPCWSTR, wintypes.DWORD,
                              ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p)
    to_descriptor.restype = wintypes.BOOL
    create_directory = kernel32.CreateDirectoryW
    create_directory.argtypes = (wintypes.LPCWSTR, ctypes.c_void_p)
    create_directory.restype = wintypes.BOOL
    local_free = kernel32.LocalFree
    local_free.argtypes = (ctypes.c_void_p,)
    local_free.restype = ctypes.c_void_p

    class SecurityAttributes(ctypes.Structure):
        _fields_ = [("nLength", wintypes.DWORD),
                    ("lpSecurityDescriptor", ctypes.c_void_p),
                    ("bInheritHandle", wintypes.BOOL)]

    descriptor = ctypes.c_void_p()
    if not to_descriptor(_gs_folder_sddl(_process_user_sid()), 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
        root = tempfile.gettempdir()
        for _ in range(100):
            folder = os.path.join(root, _GS_FOLDER_PREFIX + secrets.token_hex(8))
            if create_directory(folder, ctypes.byref(attributes)):
                return folder
            error = ctypes.get_last_error()
            if error != 183:  # ERROR_ALREADY_EXISTS
                raise ctypes.WinError(error)
        raise FileExistsError("no unused name for a Ghostscript argument folder")
    finally:
        local_free(descriptor)


def remove_stale_gs_argfiles() -> int:
    """Remove argument-file folders a killed engine left in the temporary
    directory, each holding a stored password. Returns the count removed."""
    import time

    root = tempfile.gettempdir()
    removed = 0
    try:
        names = os.listdir(root)
    except OSError:
        return 0
    now = time.time()
    for name in names:
        if not name.startswith(_GS_FOLDER_PREFIX):
            continue
        folder = os.path.join(root, name)
        try:
            if not os.path.isdir(folder):
                continue
            age = now - os.path.getmtime(folder)
            if age < _GS_STALE_SECONDS:
                continue
        except OSError:
            continue
        owner_path = os.path.join(folder, _GS_OWNER_FILE)
        try:
            with open(owner_path, encoding="ascii") as owner_file:
                owner_pid = int(owner_file.read().strip())
        except FileNotFoundError:
            # Older builds did not record an owner PID. Their Ghostscript
            # budget is capped at two hours, so retain legacy folders beyond
            # that full window plus a one-hour shutdown margin.
            if age < _GS_LEGACY_STALE_SECONDS:
                continue
        except (OSError, ValueError):
            # An unreadable or incomplete marker is not evidence that its
            # process has stopped.
            continue
        else:
            if _gs_process_is_running(owner_pid):
                continue
        shutil.rmtree(folder, ignore_errors=True)
        removed += 0 if os.path.exists(folder) else 1
    return removed


@contextmanager
def gs_password_argv(cmd: list[str], *sources):
    """`cmd` with the stored password of the first of `sources` that has one
    handed to Ghostscript.

    Ghostscript reads an encrypted PDF only with `-sPDFPassword=`, and a
    command-line argument is visible to every process on the machine. The
    password goes into an `@file` argument inside a folder that
    `_make_gs_folder` creates readable by its owner only, removed when the
    block ends on every exit path. Ghostscript 10 reads no argument file from
    standard input (`@-` is refused), so a file is the only channel that keeps
    the password out of the process command line. Without the password Ghostscript exits 0 having rendered
    nothing, so the omission never surfaces as its own error."""
    password = next((pw for pw in map(document_password, sources) if pw), None)
    if not password:
        yield list(cmd)
        return
    line = gs_password_line(password)
    folder = _make_gs_folder()
    try:
        owner_path = os.path.join(folder, _GS_OWNER_FILE)
        with open(owner_path, "x", encoding="ascii") as owner_file:
            owner_file.write(str(os.getpid()))
        argfile = os.path.join(folder, "args")
        with open(argfile, "x", encoding="utf-8", newline="\n") as handle:
            handle.write(line + "\n")
        yield [cmd[0], "@" + argfile, *cmd[1:]]
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def print_resolution(source) -> str:
    """"none", "low" or "high": how the document at `source` may print.

    ISO 32000-2 Table 22: bit 3 permits printing; from revision 3, bit 12
    clear limits printing to a low-level representation of the appearance.
    A document opened with its owner password prints without limit. One
    never passed to `open_document` (a headless caller) is read with the
    empty password, so an owner-gated document that opens without a prompt
    keeps its /P bits."""
    held = _opener_permissions(source)
    if held is None:
        return "high"
    permissions, revision = held
    if not permissions.get("print"):
        return "none"
    # A recipient record has no revision: Table 24 bit 12 always applies.
    if not permissions.get("print_high") and (revision is None or revision >= 3):
        return "low"
    return "high"


def require_permission(source, name: str) -> None:
    """Refuse an operation the /P bits of the document at `source` withhold
    from its opener (`name` is a key of `_PERMISSION_KEYS`), before anything
    is read or written. The opener is decided as `print_resolution` decides
    it, so a document never passed to `open_document` keeps its bits. A
    document that needs a password nobody supplied, or that does not parse,
    is left to the door's own read, which reports it."""
    import pikepdf

    try:
        held = _opener_permissions(source)
    except (pikepdf.PasswordError, pikepdf.PdfError):
        return
    if held is not None and not held[0].get(name):
        credential = _credential_for(source)
        if credential is not None and credential.opener == "recipient":
            raise PermissionError(PERMISSIONS_HELD_BY_RECIPIENTS)
        raise PermissionError(PERMISSIONS_HELD)


def _opener_permissions(source):
    """(permissions, revision) held by the opener of the document at
    `source`, or None where nothing limits it: an owner-password open, an
    unencrypted document, or a path that does not exist."""
    credential = _credential_for(source)
    if credential is not None:
        if credential.opener not in ("user", "recipient"):
            return None
        return credential.permissions, credential.revision
    if not _is_path(source) or not os.path.exists(source):
        return None
    with open_pdf(source) as pdf:
        if not pdf.is_encrypted or pdf.owner_password_matched:
            return None
        return _decoded_permissions(pdf), int(pdf.encryption.R)


def _decoded_permissions(pdf) -> dict:
    if not pdf.is_encrypted or pdf.owner_password_matched:
        return {name: True for name, _ in _PERMISSION_KEYS}
    return {name: bool(getattr(pdf.allow, attr)) for name, attr in _PERMISSION_KEYS}


def _open_document(path: str, password: str, *, report_wrong_password: bool) -> dict | None:
    import pikepdf
    from engine.inspect import _decrypt_in_place

    previous = _documents.pop(_key(path), None)
    try:
        pdf = open_pdf(path, password=password)
    except pikepdf.PasswordError:
        # A wrong password on an open document leaves its record as it was.
        if previous is not None:
            _documents[_key(path)] = previous
        if report_wrong_password:
            return None
        raise
    except Exception:
        if previous is not None:
            _documents[_key(path)] = previous
        raise
    try:
        encrypted = pdf.is_encrypted
        owner = encrypted and pdf.owner_password_matched
        permissions = _decoded_permissions(pdf)
        revision = int(pdf.encryption.R) if encrypted else None
        p = int(pdf.encryption.P) if encrypted else None
    finally:
        pdf.close()
    if not encrypted:
        return {"encrypted": False, "opener": "none"}
    if owner:
        try:
            _decrypt_in_place(path, password)
        except Exception:
            # The file on disk is unchanged, so its reader still needs the old record.
            if previous is not None:
                _documents[_key(path)] = previous
            raise
        _documents[_key(path)] = _Credential("owner", None, permissions, revision, p, _key(path))
        return {"encrypted": True, "opener": "owner", "encryption_kept": False}
    _documents[_key(path)] = _Credential("user", password, permissions, revision, p, _key(path))
    return {"encrypted": True, "opener": "user", "encryption_kept": True}


def open_document(path: str, password: str = "") -> dict:
    """Open the working copy at `path` with `password` and remember it.

    The owner password removes the protection from the working copy. The
    user password leaves it byte for byte as it is and records the password
    for later reads. A wrong password raises `pikepdf.PasswordError`."""
    result = _open_document(path, password, report_wrong_password=False)
    assert result is not None
    return result


def open_document_attempt(path: str, password: str = "") -> dict:
    """Open a prompted document, reporting a bad password as data so the UI
    can retry without mistaking unrelated engine failures for authentication
    failures."""
    result = _open_document(path, password, report_wrong_password=True)
    if result is None:
        return {"status": "wrong_password"}
    return {"status": "opened", "document": result}


class CredentialConflict(RuntimeError):
    """A path already holds a different document's credential."""


def share_document(path: str, alias: str) -> dict:
    """Let `alias`, a byte copy of the document at `path`, open with the
    credential `path` was opened with. The renderer stages every in-place
    rewrite on such a copy; without the credential a user-opened copy cannot
    be read at all. `close_document(alias)` forgets it again."""
    credential = _documents.get(_key(path))
    if credential is None:
        return {"shared": False}
    held = _documents.get(_key(alias))
    if held is not None and held is not credential:
        raise CredentialConflict("the alias already holds another document's credential")
    _documents[_key(alias)] = credential
    return {"shared": True}


def close_document(path: str) -> dict:
    """Forget the credential of the document at `path`, and every copy it was
    lent to when `path` is the document it was opened as."""
    key = _key(path)
    credential = _documents.pop(key, None)
    if credential is not None and credential.origin == key:
        for alias in [k for k, v in _documents.items() if v is credential]:
            del _documents[alias]
    return {"forgotten": credential is not None}


def document_permissions(path: str) -> dict:
    """The /P bits of the document at `path`, decoded, and who opened it.

    `opener` is "user", "owner", or "none" for a document that was not
    opened through `open_document`; an unknown document is read with the
    empty password."""
    credential = _credential_for(path)
    if credential is not None:
        return {
            "opener": credential.opener,
            "permissions": dict(credential.permissions),
            "revision": credential.revision,
            "p": credential.p,
        }
    with open_pdf(path) as pdf:
        encrypted = pdf.is_encrypted
        return {
            "opener": "none",
            "encrypted": encrypted,
            "permissions": _decoded_permissions(pdf),
            "revision": int(pdf.encryption.R) if encrypted else None,
            "p": int(pdf.encryption.P) if encrypted else None,
        }


#: Beside a certificate-opened working copy: the recipient's grants, so an
#: engine that restarts without the in-memory record still enforces them on
#: every file of that working folder (the copy, its stages and snapshots).
RECIPIENT_MARKER = "spectra-recipient.json"


def _marker_credential(source):
    folder = os.path.dirname(_key(source))
    try:
        with open(os.path.join(folder, RECIPIENT_MARKER), encoding="utf-8") as f:
            record = json.load(f)
        permissions = {name: record["permissions"].get(name) is True for name, _ in _PERMISSION_KEYS}
        flags = int(record["p"])
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        # An unreadable record grants nothing.
        permissions = {name: False for name, _ in _PERMISSION_KEYS}
        flags = 0
    return _Credential("recipient", None, permissions, None, flags, "")


def _credential_for(source):
    """The credential of `source`: its in-memory record, else the recipient
    record of its working folder."""
    if not _is_path(source):
        return None
    credential = _documents.get(_key(source))
    if credential is not None:
        return credential
    return _marker_credential(source)


def restrict_to_owner(folder: str) -> None:
    """Give `folder` and everything in it a protected DACL granting only the
    process user; later files inherit it. No-op off Windows."""
    if os.name != "nt":
        os.chmod(folder, 0o700)
        return
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    to_descriptor = advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW
    to_descriptor.argtypes = (wintypes.LPCWSTR, wintypes.DWORD,
                              ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p)
    to_descriptor.restype = wintypes.BOOL
    get_dacl = advapi32.GetSecurityDescriptorDacl
    get_dacl.argtypes = (ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL),
                         ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.BOOL))
    get_dacl.restype = wintypes.BOOL
    set_named = advapi32.SetNamedSecurityInfoW
    set_named.argtypes = (wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD, ctypes.c_void_p,
                          ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
    set_named.restype = wintypes.DWORD
    kernel32.LocalFree.argtypes = (ctypes.c_void_p,)
    kernel32.LocalFree.restype = ctypes.c_void_p

    descriptor = ctypes.c_void_p()
    if not to_descriptor(_gs_folder_sddl(_process_user_sid()), 1, ctypes.byref(descriptor), None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        present, defaulted = wintypes.BOOL(), wintypes.BOOL()
        dacl = ctypes.c_void_p()
        if not get_dacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)):
            raise ctypes.WinError(ctypes.get_last_error())
        # SE_FILE_OBJECT; DACL | PROTECTED_DACL: inheritable ACEs propagate to
        # the files already in the folder.
        error = set_named(folder, 1, 0x4 | 0x80000000, None, None, dacl, None)
        if error:
            raise ctypes.WinError(error)
    finally:
        kernel32.LocalFree(descriptor)


def register_recipient(path: str, permissions: dict, flags: int, handler) -> None:
    """Record a certificate open of the working copy at `path`: the
    recipient's Table 24 grants, and the handler that reseals it on save.
    The grants are also written beside it (`RECIPIENT_MARKER`)."""
    folder = os.path.dirname(_key(path))
    with open(os.path.join(folder, RECIPIENT_MARKER), "w", encoding="utf-8") as f:
        json.dump({"permissions": dict(permissions), "p": int(flags)}, f)
    _documents[_key(path)] = _Credential(
        "recipient", None, dict(permissions), None, flags, _key(path), handler
    )


def is_recipient_copy(path) -> bool:
    """Whether `path` lies in the working folder of a certificate-opened
    document."""
    credential = _credential_for(path)
    return credential is not None and credential.opener == "recipient"


def require_encryption_change(source) -> None:
    """Refuse to change or remove the encryption of a certificate-opened
    working copy at `source` whose recipient list withholds Table 24 bit 2.
    The working copy is plaintext, so the encryption doors cannot see the
    protection in the file itself."""
    credential = _credential_for(source)
    if credential is None or credential.opener != "recipient":
        return
    if not (credential.p or 0) & _PUBKEY_ENCRYPTION_CHANGE:
        raise PermissionError(PERMISSIONS_HELD_BY_RECIPIENTS)


def recipient_handler(path):
    """The authenticated public-key handler of a certificate-opened working
    copy at `path`, or None."""
    credential = _credential_for(path)
    if credential is None or credential.opener != "recipient":
        return None
    return credential.handler


def opened_with_user_password(path) -> bool:
    credential = _documents.get(_key(path))
    return credential is not None and credential.opener == "user"
