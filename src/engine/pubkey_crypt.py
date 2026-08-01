"""Certificate-based (public-key) PDF encryption — F9's second half.

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
- ``decrypt_with_pfx`` — authenticate with a PKCS#12 bundle and rewrite
  plain. The open funnel uses this to unlock the working copy in place,
  mirroring the password path's ``unlock`` semantics.
- ``classify_encryption`` — none | password | pubkey, the open funnel's
  router. The pubkey sniff reads the trailer's /Encrypt /Filter through an
  unauthenticated pyHanko reader (probe-verified: the trailer of an
  Adobe.PubSec file is readable without credentials).

Permissions map from the same ``{print, copy, modify, annotate}`` contract
the standard encrypt exposes; assistive-technology access is never blocked
(the F9 rule).
"""

import os
import tempfile
from pathlib import Path

import pikepdf
from asn1crypto import pem as asn1_pem
from asn1crypto import x509 as asn1_x509
from pyhanko.pdf_utils import crypt as pyhanko_crypt
from pyhanko.pdf_utils.crypt.permissions import PubKeyPermissions
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.writer import copy_into_new_writer


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
            | PubKeyPermissions.ALLOW_ENCRYPTION_CHANGE
        )
    if allow("annotate"):
        flags |= (
            PubKeyPermissions.ALLOW_ANNOTS_FORM_FILLING
            | PubKeyPermissions.ALLOW_FORM_FILLING
        )
    return flags


def _staged_write(writer, output_path: Path) -> None:
    """Write through a same-directory temp file + os.replace — atomic even
    when output overwrites the input (the unlock/redact_marks idiom)."""
    fd, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=str(output_path.parent))
    os.close(fd)
    try:
        with open(tmp_path, "wb") as f:
            writer.write(f)
        os.replace(tmp_path, output_path)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def classify_encryption(file: str) -> str:
    """'none' | 'password' | 'pubkey'."""
    try:
        with pikepdf.open(file):
            return "none"
    except pikepdf.PasswordError:
        return "password"
    except pikepdf.PdfError:
        pass  # possibly Adobe.PubSec — pikepdf cannot say; sniff the trailer
    try:
        with open(file, "rb") as f:
            reader = PdfFileReader(f)
            # INDEXING resolves indirect references; .get() hands back the
            # raw IndirectObject wrapper (probe-caught).
            enc = reader.trailer_view["/Encrypt"]
            if str(enc["/Filter"]) == "/Adobe.PubSec":
                return "pubkey"
    except Exception:
        pass
    # Not an encryption we recognize — surface pikepdf's original complaint.
    with pikepdf.open(file):
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
    recipients = [_load_cert(p) for p in certs]
    output_path = Path(output)
    with open(file, "rb") as f:
        reader = PdfFileReader(f)
        writer = copy_into_new_writer(reader)
        writer.encrypt_pubkey(recipients, perms=_permissions(permissions))
        _staged_write(writer, output_path)
    return {
        "output": str(output_path),
        "recipients": len(recipients),
        "size_bytes": output_path.stat().st_size,
    }


def decrypt_with_pfx(file: str, output: str, pfx: str, password: str = "") -> dict:
    """Decrypt a certificate-encrypted ``file`` with a PKCS#12 key bundle."""
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
    output_path = Path(output)
    with open(file, "rb") as f:
        reader = PdfFileReader(f)
        result = reader.decrypt_pubkey(credential)
        if result.status == pyhanko_crypt.AuthStatus.FAILED:
            raise ValueError(
                f"The key in {Path(pfx).name} does not match any recipient "
                "of this document."
            )
        writer = copy_into_new_writer(reader)
        _staged_write(writer, output_path)
    return {"output": str(output_path), "size_bytes": output_path.stat().st_size}
