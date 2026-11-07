"""The bundled EU trusted-list certificates as an opt-in trust source.

Two halves. The behavioural tests point `engine.eutl._bundle_dir` — the
module's one seam over the shipped files — at a bundle this suite writes from
its own throwaway CA, so nothing asserts against real certificate authorities
and the results are the same on any host. The last class checks the REAL
committed bundle, offline: that it parses, and that it says about itself what
its manifest says.
"""

import hashlib
import json
import os

import pikepdf
import pytest
from asn1crypto import x509 as asn1_x509
from cryptography.hazmat.primitives import serialization

from engine import eutl, os_trust
from engine.signatures import sign_pdf, verify_signatures
# Sibling helper, imported BARE like every other one in this suite — see the
# note in test_os_trust.py.
from test_pades import _build_pki


_PKI: dict | None = None


@pytest.fixture
def pki(tmp_path_factory):
    global _PKI
    if _PKI is None:
        _PKI = _build_pki(str(tmp_path_factory.mktemp("eutl-pki")))
    return _PKI


@pytest.fixture(autouse=True)
def _clear_bundle_cache():
    """The bundle is parsed once and kept, which is correct for a file that
    cannot change under a running app and wrong for a test that swaps it."""
    eutl._CACHE.clear()
    yield
    eutl._CACHE.clear()


def _pem_of(pem_path: str) -> bytes:
    with open(pem_path, "rb") as f:
        return f.read()


def _fake_bundle(monkeypatch, tmp_path, signers=(), timestampers=(),
                 manifest: dict | None = None) -> list:
    """Write a bundle of the suite's own certificates and point the seam at it.
    Returns a list that records every read, so a test can assert the bundle was
    NOT opened."""
    directory = tmp_path / "trust"
    directory.mkdir(exist_ok=True)
    (directory / "eutl-signers.pem").write_bytes(b"".join(signers))
    (directory / "eutl-timestamp.pem").write_bytes(b"".join(timestampers))
    if manifest is not None:
        (directory / "eutl-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    reads: list = []
    original = eutl._read_bundle

    def recording(where):
        reads.append(where)
        return original(where)

    monkeypatch.setattr(eutl, "_bundle_dir", lambda: directory)
    monkeypatch.setattr(eutl, "_read_bundle", recording)
    return reads


def _signed(path: str, pki: dict) -> str:
    doc = pikepdf.new()
    doc.add_blank_page(page_size=(400, 400))
    doc.save(path)
    doc.close()
    out = path.replace(".pdf", "-signed.pdf")
    sign_pdf(path, out, pfx_path=pki["pfx"], password="pw")
    return out


class TestOffMeansOff:
    def test_the_bundle_is_never_read_without_the_option(self, monkeypatch, tmp_path, pki):
        reads = _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out)
        assert reads == []  # not merely untrusted: nothing was opened
        signature = result["signatures"][0]
        assert signature["valid"] is True and signature["intact"] is True
        assert signature["trusted"] is False
        assert signature["trust_source"] is None
        assert result["summary"]["trust_verified"] is False
        assert result["eutl_trust"] == {
            "requested": False,
            "available": False,
            "anchor_count": 0,
        }

    def test_user_anchors_alone_still_do_not_read_the_bundle(
        self, monkeypatch, tmp_path, pki
    ):
        reads = _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, trust_roots=[pki["ca_pem"]])
        assert reads == []
        assert result["signatures"][0]["trust_source"] == "user"


class TestVerifyAgainstTheBundle:
    def test_opting_in_trusts_a_chain_the_bundle_anchors(self, monkeypatch, tmp_path, pki):
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, eutl_trust=True)
        signature = result["signatures"][0]
        assert signature["trusted"] is True
        assert signature["trust_source"] == "eutl"
        assert result["summary"]["trust_verified"] is True
        assert result["eutl_trust"]["requested"] is True
        assert result["eutl_trust"]["available"] is True
        assert result["eutl_trust"]["anchor_count"] == 1

    def test_an_unrelated_bundle_trusts_nothing(self, monkeypatch, tmp_path, pki):
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["other_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, eutl_trust=True)
        assert result["signatures"][0]["trusted"] is False
        assert result["signatures"][0]["trust_source"] is None
        assert result["summary"]["trust_verified"] is False

    def test_a_timestamp_anchor_does_not_anchor_a_signer_chain(
        self, monkeypatch, tmp_path, pki
    ):
        # The purpose split, proven rather than assumed: a qualified timestamp
        # authority is not an authority for the signature on a document.
        _fake_bundle(monkeypatch, tmp_path, timestampers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, eutl_trust=True)
        assert result["signatures"][0]["trusted"] is False
        # The anchor is in force — it is simply in force for the other chain.
        assert result["eutl_trust"]["anchor_count"] == 1

    def test_a_missing_bundle_reports_unavailable(self, monkeypatch, tmp_path, pki):
        # "This installation has no bundle" is not the same result as "the
        # bundle anchors nothing", and must not read as a failed chain.
        _fake_bundle(monkeypatch, tmp_path)
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, eutl_trust=True)
        assert result["eutl_trust"]["requested"] is True
        assert result["eutl_trust"]["available"] is False
        assert result["eutl_trust"]["anchor_count"] == 0
        assert result["signatures"][0]["trusted"] is False

    def test_a_malformed_entry_does_not_remove_the_others(
        self, monkeypatch, tmp_path, pki
    ):
        broken = b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
        _fake_bundle(monkeypatch, tmp_path, signers=[broken, _pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        assert verify_signatures(out, eutl_trust=True)["signatures"][0]["trusted"] is True

    def test_an_invalid_signature_carries_no_trust_source(
        self, monkeypatch, tmp_path, pki
    ):
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        with open(out, "r+b") as f:
            f.seek(100)
            byte = f.read(1)
            f.seek(100)
            f.write(bytes([byte[0] ^ 0xFF]))
        result = verify_signatures(out, eutl_trust=True)
        assert result["signatures"][0]["intact"] is False
        assert result["signatures"][0]["trust_source"] is None


class TestSourcePrecedence:
    def test_a_user_anchor_wins_over_the_bundle(self, monkeypatch, tmp_path, pki):
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, trust_roots=[pki["ca_pem"]], eutl_trust=True)
        assert result["signatures"][0]["trusted"] is True
        assert result["signatures"][0]["trust_source"] == "user"

    def test_the_bundle_wins_over_the_platform_store(self, monkeypatch, tmp_path, pki):
        # Both sources carry the same authority. The bundle's statement is the
        # narrower one — a granted qualified authority, rather than a root this
        # machine happens to carry — so that is what the result says.
        from cryptography import x509 as crypto_x509

        with open(pki["ca_pem"], "rb") as f:
            der = crypto_x509.load_pem_x509_certificate(f.read()).public_bytes(
                serialization.Encoding.DER
            )
        monkeypatch.setattr(os_trust, "_enumerate",
                            lambda store: [(der, "x509_asn", True)] if store == "ROOT" else [])
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, system_trust=True, eutl_trust=True)
        assert result["signatures"][0]["trusted"] is True
        assert result["signatures"][0]["trust_source"] == "eutl"
        assert result["system_trust"]["requested"] is True
        assert result["eutl_trust"]["requested"] is True

    def test_both_sources_reported_independently(self, monkeypatch, tmp_path, pki):
        monkeypatch.setattr(os_trust, "available", lambda: False)
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, system_trust=True, eutl_trust=True)
        assert result["system_trust"]["available"] is False
        assert result["eutl_trust"]["available"] is True


class TestProvenance:
    def test_the_report_carries_the_bundle_date_and_list_count(
        self, monkeypatch, tmp_path, pki
    ):
        manifest = {
            "fetched": "2026-08-15",
            "lotl": {"sequence": 390},
            "lists": {"included": 31, "excluded": 0},
        }
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])],
                     manifest=manifest)
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        report = verify_signatures(out, eutl_trust=True)["eutl_trust"]
        assert report["fetched"] == "2026-08-15"
        assert report["sequence"] == 390
        assert report["list_count"] == 31

    def test_a_bundle_without_a_manifest_reports_nulls_not_a_guess(
        self, monkeypatch, tmp_path, pki
    ):
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        report = verify_signatures(out, eutl_trust=True)["eutl_trust"]
        assert report["available"] is True
        assert report["fetched"] is None
        assert report["list_count"] is None

    def test_provenance_carries_no_counts_of_its_own(self, monkeypatch, tmp_path, pki):
        # How many anchors are in force is a property of the verification. Two
        # numbers for one thing is two numbers that can disagree.
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])],
                     manifest={"files": {"eutl-signers.pem": {"count": 999}}})
        assert "anchor_count" not in eutl.provenance()


class TestTheShippedBundle:
    """The committed bundle itself — parsed, counted, and cross-checked against
    its own manifest. No network, and no assertion about any particular
    certificate authority: the point is that what ships is what was reviewed."""

    @pytest.fixture
    def bundle_dir(self):
        directory = eutl._bundle_dir()
        if not (directory / "eutl-manifest.json").is_file():
            pytest.skip("no trusted-list bundle in this tree")
        return directory

    @pytest.fixture
    def manifest(self, bundle_dir):
        return json.loads((bundle_dir / "eutl-manifest.json").read_text(encoding="utf-8"))

    def test_every_certificate_parses_as_the_validators_type(self, bundle_dir):
        anchors = eutl.anchors(eutl.SIGNER) + eutl.anchors(eutl.TIMESTAMP)
        assert anchors, "the shipped bundle holds no anchors"
        assert all(isinstance(a, asn1_x509.Certificate) for a in anchors)

    def test_the_files_match_the_manifest_byte_for_byte(self, bundle_dir, manifest):
        for name, recorded in manifest["files"].items():
            digest = hashlib.sha256((bundle_dir / name).read_bytes()).hexdigest()
            assert digest == recorded["sha256"], f"{name} is not the file that was reviewed"

    def test_the_counts_match_the_manifest(self, bundle_dir, manifest):
        assert len(eutl.anchors(eutl.SIGNER)) == manifest["files"]["eutl-signers.pem"]["count"]
        assert (
            len(eutl.anchors(eutl.TIMESTAMP))
            == manifest["files"]["eutl-timestamp.pem"]["count"]
        )

    def test_every_included_list_verified_its_signature(self, manifest):
        # The bundle is fail-closed by construction: a list that did not verify
        # contributes nothing and is recorded as excluded with its reason.
        for row in manifest["territories"]:
            if row.get("included"):
                assert row.get("signer_sha256"), f"{row['territory']}: no signer recorded"
            else:
                assert row.get("excluded_because"), f"{row['territory']}: no reason recorded"
        included = sum(1 for row in manifest["territories"] if row.get("included"))
        assert included == manifest["lists"]["included"]

    def test_the_pinned_signer_is_the_one_the_manifest_names(self, bundle_dir, manifest):
        from asn1crypto import pem

        pinned = {
            hashlib.sha256(der).hexdigest()
            for _, _, der in pem.unarmor(
                (bundle_dir / "eutl-lotl-signers.pem").read_bytes(), multiple=True
            )
        }
        assert manifest["lotl"]["signer_sha256"] in pinned

    def test_the_bundle_is_read_once_and_kept(self, bundle_dir):
        eutl._CACHE.clear()
        eutl.available()
        first = eutl._CACHE.get(bundle_dir)
        eutl.anchors(eutl.SIGNER)
        eutl.provenance()
        assert eutl._CACHE.get(bundle_dir) is first
