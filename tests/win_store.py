"""Test-story helper: a throwaway signing certificate in the CURRENT USER's
``MY`` store.

The engine's store signing never imports anything (a real user's certificate
arrives from their organisation), so this module exists only so pytest can
drive the genuine CNG path. Import and removal both go through ``certutil``,
which is the same door an administrator would use and needs no elevation for
the user's own store. Lives in tests/ (never ships).
"""

from __future__ import annotations

import datetime
import os
import subprocess
import sys

#: The friendly name every certificate this module creates carries, so a
#: leaked-through certificate is identifiable as test residue rather than a
#: real signer.
FRIENDLY_NAME = "Spectra PDF store-signing test certificate"

TEST_COMMON_NAME = "Spectra Store Test Signer"


def available() -> bool:
    """Whether this machine can host the current-user store test at all."""
    if sys.platform != "win32":
        return False
    from engine import wincert

    return wincert.available() and _certutil() is not None


def _certutil() -> str | None:
    path = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "certutil.exe")
    return path if os.path.isfile(path) else None


def _run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [_certutil(), *args],
        capture_output=True,
        text=True,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def make_pfx(path: str, password: str, key: str = "rsa") -> str:
    """Write a self-signed signing certificate as a PKCS#12, and return its
    SHA-1 thumbprint (uppercase hex — the store's own spelling)."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    if key == "ec":
        private_key = ec.generate_private_key(ec.SECP256R1())
    else:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, TEST_COMMON_NAME)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.EMAIL_PROTECTION]),
            critical=False,
        )
        .sign(private_key, hashes.SHA256())
    )
    blob = pkcs12.serialize_key_and_certificates(
        FRIENDLY_NAME.encode("utf-8"),
        private_key,
        cert,
        None,
        serialization.BestAvailableEncryption(password.encode("utf-8")),
    )
    with open(path, "wb") as f:
        f.write(blob)
    return _sha1_thumbprint(cert)


def _sha1_thumbprint(cert) -> str:
    from cryptography.hazmat.primitives import hashes

    return cert.fingerprint(hashes.SHA1()).hex().upper()


def import_pfx(path: str, password: str) -> None:
    """Import into the CURRENT USER's ``MY`` store."""
    result = _run(["-user", "-f", "-p", password, "-importpfx", "My", path, "NoRoot"])
    if result.returncode != 0:
        raise RuntimeError(f"certutil importpfx failed: {result.stdout}\n{result.stderr}")


def delete(thumbprint: str) -> None:
    """Remove the certificate and its key from the CURRENT USER's ``MY`` store."""
    _run(["-user", "-delstore", "My", thumbprint])


__all__ = (
    "FRIENDLY_NAME",
    "TEST_COMMON_NAME",
    "available",
    "delete",
    "import_pfx",
    "make_pfx",
)
