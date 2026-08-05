"""Second half: certificate-based (Adobe.PubSec) encryption.

Round-trips run against in-test identities (cryptography-generated cert +
PKCS#12 bundle — the signing suite's precedent for clock-independent
fixtures). pikepdf cannot read this handler at all, so the assertions that
matter are: the right key opens it, the wrong key is refused cleanly, the
permissions flags land, and the open funnel's classifier tells the three
states apart.
"""

import datetime
import os

import pikepdf
import pytest

from engine.inspect import check_encrypted
from engine.pubkey_crypt import (
    classify_encryption,
    decrypt_with_pfx,
    encrypt_with_certs,
)

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12


def _identity(tmp_dir: str, cn: str, password: bytes = b"test-pass"):
    """(cert_path, pfx_path) for a fresh self-signed identity."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, cn)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=36500))
        .add_extension(
            x509.KeyUsage(
                digital_signature=False, content_commitment=False,
                key_encipherment=True, data_encipherment=True,
                key_agreement=False, key_cert_sign=False, crl_sign=False,
                encipher_only=False, decipher_only=False,
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path = os.path.join(tmp_dir, f"{cn}.cer")
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.DER))
    pfx_path = os.path.join(tmp_dir, f"{cn}.pfx")
    with open(pfx_path, "wb") as f:
        f.write(
            pkcs12.serialize_key_and_certificates(
                cn.encode(), key, cert, None,
                serialization.BestAvailableEncryption(password),
            )
        )
    return cert_path, pfx_path


class TestPubkeyEncryption:
    def test_round_trip_and_classification(self, tmp_dir, sample_pdf):
        cert, pfx = _identity(tmp_dir, "recipient-a")
        enc = os.path.join(tmp_dir, "locked.pdf")
        plain = os.path.join(tmp_dir, "plain.pdf")

        result = encrypt_with_certs(sample_pdf, enc, [cert])
        assert result["recipients"] == 1
        assert classify_encryption(enc) == "pubkey"
        assert check_encrypted(enc) == {"encrypted": True, "kind": "pubkey"}
        with pytest.raises(pikepdf.PdfError):
            pikepdf.open(enc)  # the handler pikepdf cannot read

        decrypt_with_pfx(enc, plain, pfx, "test-pass")
        assert classify_encryption(plain) == "none"
        with pikepdf.open(plain) as pdf:
            assert len(pdf.pages) == 5  # sample.pdf round-trips whole

    def test_multiple_recipients_either_key_opens(self, tmp_dir, sample_pdf):
        cert_a, pfx_a = _identity(tmp_dir, "first")
        cert_b, pfx_b = _identity(tmp_dir, "second")
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt_with_certs(sample_pdf, enc, [cert_a, cert_b])
        for pfx in (pfx_a, pfx_b):
            out = os.path.join(tmp_dir, f"plain-{os.path.basename(pfx)}.pdf")
            decrypt_with_pfx(enc, out, pfx, "test-pass")
            assert classify_encryption(out) == "none"

    def test_wrong_key_refused_cleanly(self, tmp_dir, sample_pdf):
        cert, _ = _identity(tmp_dir, "recipient-a")
        _, wrong_pfx = _identity(tmp_dir, "intruder")
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt_with_certs(sample_pdf, enc, [cert])
        with pytest.raises(ValueError, match="does not match any recipient"):
            decrypt_with_pfx(enc, os.path.join(tmp_dir, "no.pdf"), wrong_pfx, "test-pass")

    def test_wrong_pfx_password_refused(self, tmp_dir, sample_pdf):
        cert, pfx = _identity(tmp_dir, "recipient-a")
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt_with_certs(sample_pdf, enc, [cert])
        with pytest.raises(ValueError, match="check the file and its password"):
            decrypt_with_pfx(enc, os.path.join(tmp_dir, "no.pdf"), pfx, "not-the-pass")

    def test_pem_certificate_accepted(self, tmp_dir, sample_pdf):
        cert_der, pfx = _identity(tmp_dir, "pem-recipient")
        with open(cert_der, "rb") as f:
            der = f.read()
        import base64
        pem_path = os.path.join(tmp_dir, "recipient.pem")
        b64 = base64.encodebytes(der).decode()
        with open(pem_path, "w") as f:
            f.write(f"-----BEGIN CERTIFICATE-----\n{b64}-----END CERTIFICATE-----\n")
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt_with_certs(sample_pdf, enc, [pem_path])
        assert classify_encryption(enc) == "pubkey"
        decrypt_with_pfx(enc, os.path.join(tmp_dir, "plain.pdf"), pfx, "test-pass")

    def test_permissions_flags_land(self, tmp_dir, sample_pdf):
        cert, pfx = _identity(tmp_dir, "recipient-a")
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt_with_certs(
            sample_pdf, enc, [cert],
            permissions={"print": False, "copy": False, "modify": True, "annotate": True},
        )
        from pyhanko.pdf_utils import crypt as pyhanko_crypt
        from pyhanko.pdf_utils.crypt.permissions import PubKeyPermissions
        from pyhanko.pdf_utils.reader import PdfFileReader

        with open(enc, "rb") as f:
            reader = PdfFileReader(f)
            cred = pyhanko_crypt.SimpleEnvelopeKeyDecrypter.load_pkcs12(pfx, b"test-pass")
            perms = reader.decrypt_pubkey(cred).permission_flags
            assert not (perms & PubKeyPermissions.ALLOW_PRINTING)
            assert not (perms & PubKeyPermissions.ALLOW_CONTENT_EXTRACTION)
            assert perms & PubKeyPermissions.ALLOW_MODIFICATION_GENERIC
            assert perms & PubKeyPermissions.ALLOW_FORM_FILLING
            assert perms & PubKeyPermissions.ALLOW_ASSISTIVE_TECHNOLOGY

    def test_not_pubkey_inputs_refused(self, tmp_dir, sample_pdf):
        _, pfx = _identity(tmp_dir, "recipient-a")
        with pytest.raises(ValueError, match="not certificate-encrypted"):
            decrypt_with_pfx(sample_pdf, os.path.join(tmp_dir, "no.pdf"), pfx, "test-pass")
        with pytest.raises(ValueError, match="At least one recipient"):
            encrypt_with_certs(sample_pdf, os.path.join(tmp_dir, "no.pdf"), [])

    def test_password_encryption_still_classifies(self, tmp_dir, sample_pdf):
        from engine.encrypt import encrypt as std_encrypt
        enc = os.path.join(tmp_dir, "pw.pdf")
        std_encrypt(sample_pdf, enc, user_password="u", owner_password="o")
        assert classify_encryption(enc) == "password"
        assert check_encrypted(enc) == {"encrypted": True, "kind": "password"}
