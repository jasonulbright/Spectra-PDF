"""Per-document credentials for documents opened with a password.

ISO 32000-2 7.6.4.1: a document with a user password and a different owner
password opened with the USER password stays encrypted, and only the
operations its /P bits allow may run on it. The working copy therefore keeps
its /Encrypt, and every later read of it needs the password again. The
password lives here, in this process only: it is never written to a file and
never placed in a response.

Keys are canonical paths, so two spellings of one working copy share one
record. A path that is not a known document opens with the empty password,
and an encrypted one still raises `pikepdf.PasswordError`.
"""

import os
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
    return pdf


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

    _documents.pop(_key(path), None)
    pdf = open_pdf(path, password=password)
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
        _documents[_key(path)] = _Credential("owner", None, permissions, revision, p)
        return {"encrypted": True, "opener": "owner", "encryption_kept": False}
    _documents[_key(path)] = _Credential("user", password, permissions, revision, p)
    return {"encrypted": True, "opener": "user", "encryption_kept": True}


def close_document(path: str) -> dict:
    """Forget the credential of the document at `path`."""
    return {"forgotten": _documents.pop(_key(path), None) is not None}


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
