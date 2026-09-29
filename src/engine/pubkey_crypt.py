"""Certificate-based (public-key) PDF encryption — the second half.

The standard security handler (encrypt.py) locks a document with passwords;
this module locks it to RECIPIENT CERTIFICATES (Adobe.PubSec, AES-256): any
holder of a listed certificate's private key opens the file — no shared
password to distribute. pikepdf/qpdf can neither read nor write this
handler (pikepdf raises a generic PdfError, not PasswordError), so both
directions run on pyHanko, which is already bundled for signing:

- ``encrypt_with_certs`` — copy the document into a fresh writer and attach
  a PubKeySecurityHandler (``encrypt_pubkey``). A REWRITE: encryption is a
  whole-file property, so existing signatures do not survive, exactly as
  with password encryption (the panel says so).
- ``decrypt_with_pfx`` — authenticate with a PKCS#12 bundle and write an
  unprotected copy. Removing the encryption is a change of encryption, so it
  needs Table 24 bit 2 in the recipient's grants.
- ``open_pubkey_document`` — the open funnel's certificate open. qpdf and
  pdf.js read no Adobe.PubSec file, so the working copy is decrypted in
  place, and the recipient's Table 24 grants and the authenticated handler
  are recorded (``credentials.register_recipient``).
- ``pubkey_reseal`` — write the plaintext working copy under the original
  recipient lists and seed (7.6.5.3: the file key is a digest of the seed and
  the Recipients bytes), so every recipient opens the saved file with the
  grants its own list carries.
- ``classify_encryption`` — none | password | pubkey, the open funnel's
  router. The pubkey sniff reads the trailer's /Encrypt /Filter through an
  unauthenticated pyHanko reader (probe-verified: the trailer of an
  Adobe.PubSec file is readable without credentials).

Permissions map from the same ``{print, copy, modify, annotate}`` contract
the standard encrypt exposes; assistive-technology access is never blocked.
"""

import io
import os
from pathlib import Path

import pikepdf
from engine.credentials import open_pdf
from asn1crypto import pem as asn1_pem
from asn1crypto import x509 as asn1_x509
from pyhanko.pdf_utils import crypt as pyhanko_crypt
from pyhanko.pdf_utils.crypt.permissions import PubKeyPermissions
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.writer import copy_into_new_writer

from engine.credentials import (
    PERMISSIONS_HELD_BY_RECIPIENTS,
    is_recipient_copy,
    recipient_handler,
    register_recipient,
    require_encryption_change,
    restrict_to_owner,
)
from engine.inplace import is_same_file, staged_write
from engine.pdf_tree import exact_pyhanko_names

exact_pyhanko_names()



def _load_cert(path: str) -> asn1_x509.Certificate:
    data = Path(path).read_bytes()
    if asn1_pem.detect(data):
        _, _, data = asn1_pem.unarmor(data)
    try:
        return asn1_x509.Certificate.load(data)
    except Exception as exc:
        raise ValueError(
            f"{Path(path).name} is not a readable X.509 certificate "
            "(PEM or DER)."
        ) from exc


def _permissions(perms: dict | None) -> PubKeyPermissions:
    """{print, copy, modify, annotate} → PubKeyPermissions. Missing keys
    default to allowed; assistive technology is always allowed."""

    def allow(key: str) -> bool:
        return perms is None or bool(perms.get(key, True))

    flags = (
        PubKeyPermissions.ALLOW_ASSISTIVE_TECHNOLOGY
        | PubKeyPermissions.TOLERATE_MISSING_PDF_MAC
    )
    if allow("print"):
        flags |= (
            PubKeyPermissions.ALLOW_PRINTING
            | PubKeyPermissions.ALLOW_HIGH_QUALITY_PRINTING
        )
    if allow("copy"):
        flags |= PubKeyPermissions.ALLOW_CONTENT_EXTRACTION
    if allow("modify"):
        flags |= (
            PubKeyPermissions.ALLOW_MODIFICATION_GENERIC
            | PubKeyPermissions.ALLOW_REASSEMBLY
        )
    if allow("annotate"):
        flags |= (
            PubKeyPermissions.ALLOW_ANNOTS_FORM_FILLING
            | PubKeyPermissions.ALLOW_FORM_FILLING
        )
    # Table 24 bit 2 enables every other permission, so it is set only when
    # nothing is withheld.
    if all(allow(key) for key in ("print", "copy", "modify", "annotate")):
        flags |= PubKeyPermissions.ALLOW_ENCRYPTION_CHANGE
    return flags


#: ISO 32000-2 Table 24 bits, by the app's permission names. Bit 10 is
#: ignored by a reader, so accessibility is always granted.
_TABLE_24 = (
    ("print", PubKeyPermissions.ALLOW_PRINTING),
    ("print_high", PubKeyPermissions.ALLOW_HIGH_QUALITY_PRINTING),
    ("modify", PubKeyPermissions.ALLOW_MODIFICATION_GENERIC),
    ("copy", PubKeyPermissions.ALLOW_CONTENT_EXTRACTION),
    ("annotate", PubKeyPermissions.ALLOW_ANNOTS_FORM_FILLING),
    ("fill", PubKeyPermissions.ALLOW_FORM_FILLING),
    ("assemble", PubKeyPermissions.ALLOW_REASSEMBLY),
)


def recipient_permissions(flags) -> dict:
    """Table 24 grants → the app's permission names. Bit 2 enables every
    other permission."""
    if flags is None or PubKeyPermissions.ALLOW_ENCRYPTION_CHANGE in flags:
        granted = {name: True for name, _ in _TABLE_24}
    else:
        granted = {name: bit in flags for name, bit in _TABLE_24}
    granted["accessibility"] = True
    return granted


def _reader_over(file: str) -> PdfFileReader:
    """A reader holding the document's BYTES rather than an open handle on
    it.

    The writer reads lazily from whatever the reader was built over, so the
    source has to stay readable for the whole write — and an output that
    names its own input is landed by swapping a directory entry over it,
    which Windows refuses while any handle holds that entry open. Reading the
    file once and handing the reader memory satisfies both.
    """
    return PdfFileReader(io.BytesIO(Path(file).read_bytes()))


def _staged_write(writer, output_path: Path) -> None:
    """Write through a same-directory temp file + os.replace — atomic even
    when output overwrites the input (the unlock/redact_marks idiom)."""
    with staged_write(output_path) as staged:
        with open(str(staged), "wb") as f:
            writer.write(f)


def classify_encryption(file: str) -> str:
    """'none' | 'password' | 'pubkey'."""
    try:
        with open_pdf(file):
            return "none"
    except pikepdf.PasswordError:
        return "password"
    except pikepdf.PdfError:
        pass  # possibly Adobe.PubSec — pikepdf cannot say; sniff the trailer
    try:
        with open(file, "rb") as f:
            reader = PdfFileReader(f)
            # INDEXING resolves indirect references; .get() hands back the
            # raw IndirectObject wrapper.
            enc = reader.trailer_view["/Encrypt"]
            if str(enc["/Filter"]) == "/Adobe.PubSec":
                return "pubkey"
    except Exception:
        pass
    # Not an encryption we recognize — surface pikepdf's original complaint.
    with open_pdf(file):
        return "none"  # unreachable; open() raises


def encrypt_with_certs(
    file: str,
    output: str,
    certs: list[str],
    permissions: dict | None = None,
) -> dict:
    """Encrypt ``file`` to the given recipient certificate files (AES-256)."""
    if not certs:
        raise ValueError("At least one recipient certificate is required.")
    require_encryption_change(file)
    recipients = [_load_cert(p) for p in certs]
    output_path = Path(output)
    reader = _reader_over(file)
    writer = copy_into_new_writer(reader)
    writer.encrypt_pubkey(recipients, perms=_permissions(permissions))
    _staged_write(writer, output_path)
    return {
        "output": str(output_path),
        "recipients": len(recipients),
        "size_bytes": output_path.stat().st_size,
    }


def _authenticate(file: str, pfx: str, password: str):
    """(reader, auth result, credential) for a certificate-encrypted `file`."""
    kind = classify_encryption(file)
    if kind != "pubkey":
        raise ValueError(
            "This document is not certificate-encrypted"
            + (" (it uses password encryption)." if kind == "password" else ".")
        )
    try:
        credential = pyhanko_crypt.SimpleEnvelopeKeyDecrypter.load_pkcs12(
            pfx, password.encode() if password else None
        )
    except Exception as exc:
        credential = None
        cause = exc
    else:
        cause = None
    if credential is None:
        # load_pkcs12 LOGS and returns None on a bad passphrase (verified) —
        # both shapes collapse to one honest message.
        raise ValueError(
            f"Could not read {Path(pfx).name} — check the file and its "
            "password."
        ) from cause
    reader = _reader_over(file)
    result = reader.decrypt_pubkey(credential)
    if result.status == pyhanko_crypt.AuthStatus.FAILED:
        raise ValueError(
            f"The key in {Path(pfx).name} does not match any recipient "
            "of this document."
        )
    return reader, result, credential


def _name_text(name) -> str:
    try:
        return name.human_friendly
    except Exception:
        return ""


def _recipient_identity(credential) -> dict:
    cert = credential.cert
    return {
        "subject": _name_text(cert.subject),
        "issuer": _name_text(cert.issuer),
        "serial": format(cert.serial_number, "X"),
    }


def decrypt_with_pfx(file: str, output: str, pfx: str, password: str = "") -> dict:
    """Write an unprotected copy of a certificate-encrypted ``file``,
    decrypted with a PKCS#12 key bundle. Refused unless the recipient's list
    grants Table 24 bit 2 (change of encryption)."""
    reader, result, _ = _authenticate(file, pfx, password)
    flags = result.permission_flags
    if flags is not None and PubKeyPermissions.ALLOW_ENCRYPTION_CHANGE not in flags:
        raise PermissionError(PERMISSIONS_HELD_BY_RECIPIENTS)
    output_path = Path(output)
    writer = copy_into_new_writer(reader)
    _staged_write(writer, output_path)
    return {"output": str(output_path), "size_bytes": output_path.stat().st_size}



def open_pubkey_document(path: str, pfx: str, password: str = "") -> dict:
    """Open the certificate-encrypted working copy at `path`.

    The copy is decrypted in place (it lives in the app's private working
    folder and is removed with it); the grants of the first recipient list
    that matches the key (7.6.5.2) and the authenticated handler are
    recorded for `path`, and `pubkey_reseal` writes the document back under
    its own recipient lists."""
    reader, result, credential = _authenticate(path, pfx, password)
    handler = reader.security_handler
    flags = result.permission_flags
    permissions = recipient_permissions(flags)
    # Before the plaintext exists: the folder, and every stage and snapshot
    # later written in it, is readable by the process user only.
    restrict_to_owner(os.path.dirname(os.path.abspath(path)))
    register_recipient(path, permissions, flags.as_sint32() if flags is not None else -1, handler)
    writer = copy_into_new_writer(reader)
    _staged_write(writer, Path(path))
    return {
        "encrypted": True,
        "opener": "recipient",
        "permissions": permissions,
        "recipient": _recipient_identity(credential),
    }


def pubkey_reattach(path: str, source: str, pfx: str, password: str = "") -> dict:
    """Authenticate again to the certificate-encrypted `source` (the user's
    file) for the working copy at `path`, whose in-memory record an engine
    restart lost. The grants of the new authentication replace the old."""
    if not is_recipient_copy(path):
        raise ValueError("this document was not opened with a certificate")
    reader, result, credential = _authenticate(source, pfx, password)
    flags = result.permission_flags
    permissions = recipient_permissions(flags)
    register_recipient(
        path, permissions, flags.as_sint32() if flags is not None else -1, reader.security_handler
    )
    return {
        "encrypted": True,
        "opener": "recipient",
        "permissions": permissions,
        "recipient": _recipient_identity(credential),
    }


def pubkey_reseal(path: str, output: str, break_signatures: bool = False) -> dict:
    """Write the certificate-opened plaintext working copy at `path` to
    `output`, encrypted under the document's original recipient lists, seed
    and crypt filters. `output` must be a stage, never the working copy.

    The rewrite breaks every signature. A signed working copy is written
    only with `break_signatures`; otherwise the reply carries
    ``{"output": None, "signatures": n}`` and nothing is written. A working
    copy whose handler an engine restart lost replies
    ``{"output": None, "needs_certificate": True}``."""
    from engine.incremental import signature_policy_of_pdf

    if not is_recipient_copy(path):
        raise ValueError("this document was not opened with a certificate")
    if os.path.exists(output) and is_same_file(path, output):
        raise ValueError("the resealed output must be a stage, never the working copy")
    handler = recipient_handler(path)
    if handler is None:
        return {"output": None, "needs_certificate": True}
    if not break_signatures:
        with pikepdf.open(path) as pdf:
            policy = signature_policy_of_pdf(pdf)
        if policy["signed"] or policy.get("error") is not None:
            return {"output": None, "signatures": max(1, int(policy["count"]))}
    reader = _reader_over(path)
    if reader.security_handler is not None:
        raise ValueError("the working copy is already encrypted")
    writer = copy_into_new_writer(reader)
    # The handler read from the original /Encrypt: its crypt filters hold the
    # recipients' seed, so the written file has the original file key.
    writer._assign_security_handler(handler)
    output_path = Path(output)
    _staged_write(writer, output_path)
    return {"output": str(output_path), "size_bytes": output_path.stat().st_size}
