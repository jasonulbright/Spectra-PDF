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

import os
import shutil
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass, field

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
    return pdf


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
    shutil.copyfile(source, target)
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
            if not os.path.isdir(folder) or now - os.path.getmtime(folder) < _GS_STALE_SECONDS:
                continue
        except OSError:
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
    password goes into an `@file` argument inside a directory that
    `tempfile.mkdtemp` creates readable by its owner only, removed when the
    block ends. Without the password Ghostscript exits 0 having rendered
    nothing, so the omission never surfaces as its own error."""
    password = next((pw for pw in map(document_password, sources) if pw), None)
    if not password:
        yield list(cmd)
        return
    line = gs_password_line(password)
    folder = tempfile.mkdtemp(prefix=_GS_FOLDER_PREFIX)
    try:
        argfile = os.path.join(folder, "args")
        with open(argfile, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(line + "\n")
        yield [cmd[0], "@" + argfile, *cmd[1:]]
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def print_resolution(source) -> str:
    """"none", "low" or "high": how the document at `source` may print.

    ISO 32000-2 Table 22: bit 3 permits printing; from revision 3, bit 12
    clear limits printing to a low-level representation of the appearance.
    A document not opened with its user password prints without limit."""
    credential = _documents.get(_key(source)) if _is_path(source) else None
    if credential is None or credential.opener != "user":
        return "high"
    permissions = credential.permissions
    if not permissions.get("print"):
        return "none"
    if not permissions.get("print_high") and (credential.revision or 0) >= 3:
        return "low"
    return "high"


def _decoded_permissions(pdf) -> dict:
    if not pdf.is_encrypted or pdf.owner_password_matched:
        return {name: True for name, _ in _PERMISSION_KEYS}
    return {name: bool(getattr(pdf.allow, attr)) for name, attr in _PERMISSION_KEYS}


def open_document(path: str, password: str = "") -> dict:
    """Open the working copy at `path` with `password` and remember it.

    The owner password removes the protection from the working copy, as the
    open path always has. The user password leaves the working copy byte for
    byte as it is and records the password for every later read. A wrong
    password raises `pikepdf.PasswordError` and records nothing."""
    from engine.inspect import _decrypt_in_place

    previous = _documents.pop(_key(path), None)
    try:
        pdf = open_pdf(path, password=password)
    except Exception:
        # A wrong password on an open document leaves its record as it was.
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
        _decrypt_in_place(path, password)
        _documents[_key(path)] = _Credential("owner", None, permissions, revision, p, _key(path))
        return {"encrypted": True, "opener": "owner", "encryption_kept": False}
    _documents[_key(path)] = _Credential("user", password, permissions, revision, p, _key(path))
    return {"encrypted": True, "opener": "user", "encryption_kept": True}


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
    credential = _documents.get(_key(path))
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


def opened_with_user_password(path) -> bool:
    credential = _documents.get(_key(path))
    return credential is not None and credential.opener == "user"
