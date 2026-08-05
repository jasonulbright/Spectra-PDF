"""PAdES signing profiles (B-B/B-T/B-LT/B-LTA), TSA timestamps, and
user-anchored trust validation.

All offline: the TSA is pyHanko's DummyTimeStamper (a real RFC 3161 responder
minus the network), and trust anchors are a locally-built CA→leaf chain.
"""

import datetime
import os

import pikepdf
import pytest

import engine.signatures as sigmod
from engine.signatures import sign_pdf, verify_signatures


# ── local PKI: a CA and a CA-signed leaf, serialized every way needed ───────

def _build_pki(tmp_dir: str) -> dict:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    def _name(cn: str):
        return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])

    def _cert(subject, issuer, key, signing_key, ca: bool):
        b = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.datetime(2000, 1, 1))
            .not_valid_after(datetime.datetime(2100, 1, 1))
            .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        )
        if not ca:
            b = b.add_extension(
                x509.KeyUsage(
                    digital_signature=True, content_commitment=True,
                    key_encipherment=False, data_encipherment=False,
                    key_agreement=False, key_cert_sign=False, crl_sign=False,
                    encipher_only=False, decipher_only=False,
                ),
                critical=True,
            )
        return b.sign(signing_key, hashes.SHA256())

    def _tsa_cert(subject, key, signing_key, issuer):
        # A TSA certificate MUST carry the time-stamping EKU (RFC 3161 §2.3) —
        # the LTV chain validation refuses a stamper without it.
        return (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.datetime(2000, 1, 1))
            .not_valid_after(datetime.datetime(2100, 1, 1))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(
                x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.TIME_STAMPING]),
                critical=True,
            )
            .sign(signing_key, hashes.SHA256())
        )

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_cert = _cert(_name("Spectra Test CA"), _name("Spectra Test CA"), ca_key, ca_key, True)
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf_cert = _cert(_name("Spectra Leaf Signer"), _name("Spectra Test CA"), leaf_key, ca_key, False)
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other_ca = _cert(_name("Unrelated CA"), _name("Unrelated CA"), other_key, other_key, True)

    ca_pem = os.path.join(tmp_dir, "ca.pem")
    with open(ca_pem, "wb") as f:
        f.write(ca_cert.public_bytes(serialization.Encoding.PEM))
    other_pem = os.path.join(tmp_dir, "other-ca.pem")
    with open(other_pem, "wb") as f:
        f.write(other_ca.public_bytes(serialization.Encoding.PEM))

    tsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    tsa_cert = _tsa_cert(_name("Spectra Test TSA"), tsa_key, ca_key, _name("Spectra Test CA"))
    tsa_pfx = os.path.join(tmp_dir, "tsa.pfx")
    with open(tsa_pfx, "wb") as f:
        f.write(
            pkcs12.serialize_key_and_certificates(
                b"tsa", tsa_key, tsa_cert, [ca_cert],
                serialization.BestAvailableEncryption(b"pw"),
            )
        )

    pfx = os.path.join(tmp_dir, "leaf.pfx")
    with open(pfx, "wb") as f:
        f.write(
            pkcs12.serialize_key_and_certificates(
                b"leaf", leaf_key, leaf_cert, [ca_cert],
                serialization.BestAvailableEncryption(b"pw"),
            )
        )
    return {"pfx": pfx, "tsa_pfx": tsa_pfx, "ca_pem": ca_pem, "other_pem": other_pem}


_PKI: dict | None = None


@pytest.fixture
def pki(tmp_path_factory):
    global _PKI
    if _PKI is None:
        _PKI = _build_pki(str(tmp_path_factory.mktemp("pki")))
    return _PKI


@pytest.fixture
def blank_pdf(tmp_dir):
    p = os.path.join(tmp_dir, "doc.pdf")
    doc = pikepdf.new()
    doc.add_blank_page(page_size=(400, 400))
    doc.save(p)
    doc.close()
    return p


@pytest.fixture
def dummy_tsa(monkeypatch, pki):
    """Swap the HTTP TSA for pyHanko's offline RFC 3161 responder."""
    from pyhanko.sign import signers
    from pyhanko.sign.timestamps.dummy_client import DummyTimeStamper

    s = signers.SimpleSigner.load_pkcs12(pki["tsa_pfx"], passphrase=b"pw")
    stamper = DummyTimeStamper(
        tsa_cert=s.signing_cert, tsa_key=s.signing_key, certs_to_embed=s.cert_registry
    )
    calls: list[str] = []

    def fake(url: str):
        calls.append(url)
        return stamper

    monkeypatch.setattr(sigmod, "_make_timestamper", fake)
    return calls


def _sign(src, out, pki, **kw):
    return sign_pdf(src, out, pfx_path=pki["pfx"], password="pw", **kw)


class TestPades:
    def test_pades_subfilter_round_trip(self, tmp_dir, blank_pdf, pki):
        out = os.path.join(tmp_dir, "b-b.pdf")
        _sign(blank_pdf, out, pki, pades=True)
        r = verify_signatures(out)
        sig = r["signatures"][0]
        assert sig["subfilter"] == "/ETSI.CAdES.detached"
        assert sig["pades"] is True
        assert sig["valid"] and sig["intact"]

    def test_default_stays_adbe(self, tmp_dir, blank_pdf, pki):
        out = os.path.join(tmp_dir, "adbe.pdf")
        _sign(blank_pdf, out, pki)
        sig = verify_signatures(out)["signatures"][0]
        assert sig["pades"] is False
        assert sig["subfilter"] == "/adbe.pkcs7.detached"

    def test_tsa_timestamp_b_t(self, tmp_dir, blank_pdf, pki, dummy_tsa):
        out = os.path.join(tmp_dir, "b-t.pdf")
        _sign(blank_pdf, out, pki, pades=True, tsa_url="http://tsa.example/rfc3161")
        assert dummy_tsa == ["http://tsa.example/rfc3161"]  # the seam was used
        sig = verify_signatures(out)["signatures"][0]
        assert sig["timestamped"] is True
        assert sig["timestamp_time"] is not None
        # TSA-backed time ≠ the signer-claimed signing_time field.
        assert sig["valid"] and sig["intact"]

    def test_ltv_embeds_dss_b_lt(self, tmp_dir, blank_pdf, pki, dummy_tsa):
        out = os.path.join(tmp_dir, "b-lt.pdf")
        _sign(
            blank_pdf, out, pki,
            pades=True, tsa_url="http://tsa.example/rfc3161",
            embed_revocation=True, trust_roots=[pki["ca_pem"]],
        )
        r = verify_signatures(out)
        assert r["ltv_info_present"] is True  # /DSS landed
        assert r["signatures"][0]["pades"] is True

    def test_lta_document_timestamp(self, tmp_dir, blank_pdf, pki, dummy_tsa):
        out = os.path.join(tmp_dir, "b-lta.pdf")
        _sign(
            blank_pdf, out, pki,
            pades=True, tsa_url="http://tsa.example/rfc3161",
            embed_revocation=True, lta=True, trust_roots=[pki["ca_pem"]],
        )
        r = verify_signatures(out)
        assert r["document_timestamps"] >= 1  # the B-LTA seal
        assert r["signature_count"] == 1  # the seal is NOT reported as a signature
        assert r["signatures"][0]["valid"]

    def test_refusals(self, tmp_dir, blank_pdf, pki):
        out = os.path.join(tmp_dir, "x.pdf")
        with pytest.raises(ValueError, match="requires PAdES"):
            _sign(blank_pdf, out, pki, embed_revocation=True)
        with pytest.raises(ValueError, match="requires PAdES"):
            _sign(blank_pdf, out, pki, lta=True)
        with pytest.raises(ValueError, match="timestamp server"):
            _sign(blank_pdf, out, pki, pades=True, lta=True)
        assert not os.path.exists(out)  # refusals write nothing


class TestUserTrustAnchors:
    def test_trusted_against_the_right_ca(self, tmp_dir, blank_pdf, pki):
        out = os.path.join(tmp_dir, "t.pdf")
        _sign(blank_pdf, out, pki, pades=True)
        r = verify_signatures(out, trust_roots=[pki["ca_pem"]])
        assert r["signatures"][0]["trusted"] is True
        assert r["summary"]["trust_verified"] is True

    def test_untrusted_against_an_unrelated_ca(self, tmp_dir, blank_pdf, pki):
        out = os.path.join(tmp_dir, "u.pdf")
        _sign(blank_pdf, out, pki, pades=True)
        r = verify_signatures(out, trust_roots=[pki["other_pem"]])
        assert r["signatures"][0]["trusted"] is False
        assert r["summary"]["trust_verified"] is False
        # And crypto validity is UNCHANGED — trust and validity are orthogonal.
        assert r["signatures"][0]["valid"] and r["signatures"][0]["intact"]

    def test_no_anchors_stays_deterministically_false(self, tmp_dir, blank_pdf, pki):
        out = os.path.join(tmp_dir, "n.pdf")
        _sign(blank_pdf, out, pki, pades=True)
        r = verify_signatures(out)
        assert r["signatures"][0]["trusted"] is False
        assert r["summary"]["trust_verified"] is False

    def test_bad_trust_root_refused(self, tmp_dir, blank_pdf, pki):
        out = os.path.join(tmp_dir, "b.pdf")
        _sign(blank_pdf, out, pki, pades=True)
        with pytest.raises(ValueError, match="trust root not found"):
            verify_signatures(out, trust_roots=[os.path.join(tmp_dir, "missing.pem")])
