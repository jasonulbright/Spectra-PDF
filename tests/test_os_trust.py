"""The operating system's certificate store as an opt-in trust source.

Nothing here reads or writes the machine's real certificate store: every test
feeds `engine.os_trust._enumerate` — the module's one platform seam — with the
suite's own throwaway CA. That keeps the assertions deterministic on any host
and keeps a test suite out of a security-relevant machine setting.
"""

import os

import pikepdf
import pytest
from asn1crypto import x509 as asn1_x509
from cryptography.hazmat.primitives import serialization

from engine import os_trust
from engine.signatures import sign_pdf, verify_signatures
# Sibling helper, imported BARE like every other one in this suite
# (`derived_nav_builders`, `outline_builders`, `hairline_builders`).
# A `tests.` prefix resolves against whichever regular `tests` package is
# on sys.path FIRST, and an installed dependency that ships one — spylls
# 0.1.7 does — shadows this directory outright, which broke collection.
from test_pades import _build_pki


_PKI: dict | None = None


@pytest.fixture
def pki(tmp_path_factory):
    global _PKI
    if _PKI is None:
        _PKI = _build_pki(str(tmp_path_factory.mktemp("os-trust-pki")))
    return _PKI


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


def _der_of(pem_path: str) -> bytes:
    from cryptography import x509 as crypto_x509

    with open(pem_path, "rb") as f:
        cert = crypto_x509.load_pem_x509_certificate(f.read())
    return cert.public_bytes(serialization.Encoding.DER)


def _fake_store(monkeypatch, root_entries, ca_entries=()):
    """Point the platform seam at fabricated store contents and record which
    stores were asked for, so a test can assert the store was NOT read."""
    asked: list[str] = []

    def fake(store: str):
        asked.append(store)
        if store == "ROOT":
            return list(root_entries)
        if store == "CA":
            return list(ca_entries)
        return []

    monkeypatch.setattr(os_trust, "_enumerate", fake)
    return asked


def _signed(path: str, pki: dict) -> str:
    doc = pikepdf.new()
    doc.add_blank_page(page_size=(400, 400))
    doc.save(path)
    doc.close()
    out = path.replace(".pdf", "-signed.pdf")
    sign_pdf(path, out, pfx_path=pki["pfx"], password="pw")
    return out


class TestPurposeFiltering:
    def test_all_purpose_entry_is_an_anchor(self, monkeypatch, pki):
        _fake_store(monkeypatch, [(_der_of(pki["ca_pem"]), "x509_asn", True)])
        assert len(os_trust.anchors(os_trust.SIGNER_PURPOSES)) == 1

    def test_any_extended_key_usage_qualifies_for_every_chain(self, monkeypatch, pki):
        entry = (_der_of(pki["ca_pem"]), "x509_asn", {"2.5.29.37.0"})
        _fake_store(monkeypatch, [entry])
        assert len(os_trust.anchors(os_trust.SIGNER_PURPOSES)) == 1
        assert len(os_trust.anchors(os_trust.TIMESTAMP_PURPOSES)) == 1

    def test_server_auth_only_root_is_not_a_document_authority(self, monkeypatch, pki):
        # A root the store restricts to TLS must not anchor a document
        # signature merely because it is in the root store.
        entry = (_der_of(pki["ca_pem"]), "x509_asn", {"1.3.6.1.5.5.7.3.1"})
        _fake_store(monkeypatch, [entry])
        assert os_trust.anchors(os_trust.SIGNER_PURPOSES) == []

    def test_code_signing_only_root_is_not_a_document_authority(self, monkeypatch, pki):
        entry = (_der_of(pki["ca_pem"]), "x509_asn", {"1.3.6.1.5.5.7.3.3"})
        _fake_store(monkeypatch, [entry])
        assert os_trust.anchors(os_trust.SIGNER_PURPOSES) == []

    def test_timestamping_root_anchors_only_the_timestamp_chain(self, monkeypatch, pki):
        entry = (_der_of(pki["ca_pem"]), "x509_asn", {"1.3.6.1.5.5.7.3.8"})
        _fake_store(monkeypatch, [entry])
        assert os_trust.anchors(os_trust.SIGNER_PURPOSES) == []
        assert len(os_trust.anchors(os_trust.TIMESTAMP_PURPOSES)) == 1

    def test_unparsable_entry_does_not_remove_the_others(self, monkeypatch, pki):
        entries = [
            (b"not a certificate", "x509_asn", True),
            (_der_of(pki["ca_pem"]), "x509_asn", True),
        ]
        _fake_store(monkeypatch, entries)
        assert len(os_trust.anchors(os_trust.SIGNER_PURPOSES)) == 1

    def test_intermediates_are_read_unfiltered(self, monkeypatch, pki):
        ca = [(_der_of(pki["ca_pem"]), "x509_asn", {"1.3.6.1.5.5.7.3.1"})]
        _fake_store(monkeypatch, [], ca)
        assert len(os_trust.intermediates()) == 1


class TestVerifyAgainstTheStore:
    def test_off_by_default_the_store_is_never_read(self, monkeypatch, pki, tmp_dir):
        asked = _fake_store(monkeypatch, [(_der_of(pki["ca_pem"]), "x509_asn", True)])
        out = _signed(os.path.join(tmp_dir, "doc.pdf"), pki)
        r = verify_signatures(out)
        assert asked == []  # not merely untrusted: no enumeration happened
        s = r["signatures"][0]
        assert s["valid"] is True and s["intact"] is True
        assert s["trusted"] is False
        assert s["trust_source"] is None
        assert r["summary"]["trust_verified"] is False
        assert r["system_trust"] == {
            "requested": False,
            "available": False,
            "anchor_count": 0,
        }

    def test_opting_in_trusts_a_chain_the_store_anchors(self, monkeypatch, pki, tmp_dir):
        _fake_store(monkeypatch, [(_der_of(pki["ca_pem"]), "x509_asn", True)])
        out = _signed(os.path.join(tmp_dir, "doc.pdf"), pki)
        r = verify_signatures(out, system_trust=True)
        s = r["signatures"][0]
        assert s["trusted"] is True
        assert s["trust_source"] == "system"
        assert r["summary"]["trust_verified"] is True
        assert r["system_trust"]["requested"] is True
        assert r["system_trust"]["anchor_count"] == 1

    def test_opting_in_does_not_trust_an_unrelated_store(self, monkeypatch, pki, tmp_dir):
        _fake_store(monkeypatch, [(_der_of(pki["other_pem"]), "x509_asn", True)])
        out = _signed(os.path.join(tmp_dir, "doc.pdf"), pki)
        r = verify_signatures(out, system_trust=True)
        assert r["signatures"][0]["trusted"] is False
        assert r["signatures"][0]["trust_source"] is None
        assert r["summary"]["trust_verified"] is False

    def test_purpose_restriction_survives_the_whole_verification(
        self, monkeypatch, pki, tmp_dir
    ):
        entry = (_der_of(pki["ca_pem"]), "x509_asn", {"1.3.6.1.5.5.7.3.1"})
        _fake_store(monkeypatch, [entry])
        out = _signed(os.path.join(tmp_dir, "doc.pdf"), pki)
        r = verify_signatures(out, system_trust=True)
        assert r["signatures"][0]["trusted"] is False
        assert r["system_trust"]["anchor_count"] == 0

    def test_user_anchor_wins_when_both_sets_carry_the_certificate(
        self, monkeypatch, pki, tmp_dir
    ):
        _fake_store(monkeypatch, [(_der_of(pki["ca_pem"]), "x509_asn", True)])
        out = _signed(os.path.join(tmp_dir, "doc.pdf"), pki)
        r = verify_signatures(out, trust_roots=[pki["ca_pem"]], system_trust=True)
        assert r["signatures"][0]["trusted"] is True
        assert r["signatures"][0]["trust_source"] == "user"

    def test_user_anchor_alone_reports_its_own_source(self, pki, tmp_dir):
        out = _signed(os.path.join(tmp_dir, "doc.pdf"), pki)
        r = verify_signatures(out, trust_roots=[pki["ca_pem"]])
        assert r["signatures"][0]["trusted"] is True
        assert r["signatures"][0]["trust_source"] == "user"

    def test_a_platform_without_a_store_reports_unavailable(
        self, monkeypatch, pki, tmp_dir
    ):
        # The distinction that matters: "this platform has no store to read" is
        # not the same result as "the store contains no matching anchor".
        monkeypatch.setattr(os_trust, "available", lambda: False)
        out = _signed(os.path.join(tmp_dir, "doc.pdf"), pki)
        r = verify_signatures(out, system_trust=True)
        assert r["system_trust"] == {
            "requested": True,
            "available": False,
            "anchor_count": 0,
        }
        assert r["signatures"][0]["trusted"] is False

    def test_an_unreadable_store_yields_no_anchors(self, monkeypatch, pki, tmp_dir):
        def boom(store):
            raise OSError("store unavailable")

        monkeypatch.setattr(os_trust, "_enumerate", boom)
        out = _signed(os.path.join(tmp_dir, "doc.pdf"), pki)
        r = verify_signatures(out, system_trust=True)
        assert r["signatures"][0]["trusted"] is False
        assert r["system_trust"]["anchor_count"] == 0

    def test_an_invalid_signature_carries_no_trust_source(
        self, monkeypatch, pki, tmp_dir
    ):
        _fake_store(monkeypatch, [(_der_of(pki["ca_pem"]), "x509_asn", True)])
        out = _signed(os.path.join(tmp_dir, "doc.pdf"), pki)
        with open(out, "r+b") as f:
            f.seek(100)
            b = f.read(1)
            f.seek(100)
            f.write(bytes([b[0] ^ 0xFF]))
        r = verify_signatures(out, system_trust=True)
        s = r["signatures"][0]
        assert s["intact"] is False
        assert s["trust_source"] is None


def _three_level_pki(tmp_dir: str) -> dict:
    """Root → intermediate → leaf, with the leaf's PKCS#12 carrying NO
    intermediate. A signature made from it is unbuildable from the root alone."""
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12

    def _name(cn):
        return x509.Name([x509.NameAttribute(x509.oid.NameOID.COMMON_NAME, cn)])

    def _build(subject, issuer, key, signing_key, ca):
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

    root_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    root = _build(_name("Deep Root"), _name("Deep Root"), root_key, root_key, True)
    mid_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    mid = _build(_name("Deep Intermediate"), _name("Deep Root"), mid_key, root_key, True)
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf = _build(_name("Deep Leaf"), _name("Deep Intermediate"), leaf_key, mid_key, False)

    pfx = os.path.join(tmp_dir, "deep-leaf.pfx")
    with open(pfx, "wb") as f:
        f.write(
            pkcs12.serialize_key_and_certificates(
                b"leaf", leaf_key, leaf, None,
                serialization.BestAvailableEncryption(b"pw"),
            )
        )
    return {
        "pfx": pfx,
        "root_der": root.public_bytes(serialization.Encoding.DER),
        "mid_der": mid.public_bytes(serialization.Encoding.DER),
    }


class TestIntermediateSupply:
    def test_a_chain_missing_its_intermediate_needs_the_intermediate_store(
        self, monkeypatch, tmp_dir
    ):
        # The reason the intermediate store is read at all: an anchor alone
        # cannot validate a chain whose middle link the document omits.
        deep = _three_level_pki(tmp_dir)
        src = os.path.join(tmp_dir, "deep.pdf")
        doc = pikepdf.new()
        doc.add_blank_page(page_size=(400, 400))
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "deep-signed.pdf")
        sign_pdf(src, out, pfx_path=deep["pfx"], password="pw")

        root_only = [(deep["root_der"], "x509_asn", True)]
        _fake_store(monkeypatch, root_only)
        assert verify_signatures(out, system_trust=True)["signatures"][0]["trusted"] is False

        _fake_store(monkeypatch, root_only, [(deep["mid_der"], "x509_asn", True)])
        assert verify_signatures(out, system_trust=True)["signatures"][0]["trusted"] is True


class TestStoreSelection:
    def test_only_the_root_and_intermediate_stores_are_consulted(
        self, monkeypatch, pki
    ):
        # The user's own identities (MY) and directly-trusted end-entity certs
        # are not anchor material; reading them would trust self-signed
        # documents as though a third party had vouched for them.
        asked = _fake_store(monkeypatch, [(_der_of(pki["ca_pem"]), "x509_asn", True)])
        os_trust.anchors(os_trust.SIGNER_PURPOSES)
        os_trust.intermediates()
        assert set(asked) == {"ROOT", "CA"}

    def test_the_der_blob_loads_as_the_validators_certificate_type(
        self, monkeypatch, pki
    ):
        _fake_store(monkeypatch, [(_der_of(pki["ca_pem"]), "x509_asn", True)])
        (cert,) = os_trust.anchors(os_trust.SIGNER_PURPOSES)
        assert isinstance(cert, asn1_x509.Certificate)
