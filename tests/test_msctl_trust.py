"""The bundled root-program certificates as an opt-in trust source.

Two halves, on the pattern the trusted-list suite established. The behavioural
tests point `engine.msctl._bundle_dir` — the module's one seam over the shipped
files — at a bundle this suite writes from its own throwaway CA, so nothing
asserts against real certificate authorities and the results are the same on any
host. The last class checks the REAL committed bundle, offline: that it parses,
that it says about itself what its manifest says, and that the manifest records
a distrust that was actually applied.
"""

import hashlib
import json
import os

import pikepdf
import pytest
from asn1crypto import x509 as asn1_x509
from cryptography.hazmat.primitives import serialization

from engine import eutl, msctl, os_trust
from engine.signatures import sign_pdf, verify_signatures
# Sibling helper, imported BARE like every other one in this suite — see the
# note in test_os_trust.py.
from test_pades import _build_pki


_PKI: dict | None = None


@pytest.fixture
def pki(tmp_path_factory):
    global _PKI
    if _PKI is None:
        _PKI = _build_pki(str(tmp_path_factory.mktemp("msctl-pki")))
    return _PKI


@pytest.fixture(autouse=True)
def _clear_bundle_cache():
    """The bundle is parsed once and kept, which is correct for a file that
    cannot change under a running app and wrong for a test that swaps it."""
    msctl._CACHE.clear()
    eutl._CACHE.clear()
    yield
    msctl._CACHE.clear()
    eutl._CACHE.clear()


def _pem_of(pem_path: str) -> bytes:
    with open(pem_path, "rb") as f:
        return f.read()


def _der_of(pem_path: str) -> bytes:
    from cryptography import x509 as crypto_x509

    with open(pem_path, "rb") as f:
        return crypto_x509.load_pem_x509_certificate(f.read()).public_bytes(
            serialization.Encoding.DER
        )


def _fake_bundle(monkeypatch, tmp_path, signers=(), timestampers=(),
                 manifest: dict | None = None) -> list:
    """Write a bundle of the suite's own certificates and point the seam at it.
    Returns a list that records every read, so a test can assert the bundle was
    NOT opened."""
    directory = tmp_path / "trust-msctl"
    directory.mkdir(exist_ok=True)
    (directory / "msctl-signers.pem").write_bytes(b"".join(signers))
    (directory / "msctl-timestamp.pem").write_bytes(b"".join(timestampers))
    if manifest is not None:
        (directory / "msctl-manifest.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )

    reads: list = []
    original = msctl._read_bundle

    def recording(where):
        reads.append(where)
        return original(where)

    monkeypatch.setattr(msctl, "_bundle_dir", lambda: directory)
    monkeypatch.setattr(msctl, "_read_bundle", recording)
    return reads


def _fake_eutl_bundle(monkeypatch, tmp_path, signers=()) -> None:
    directory = tmp_path / "trust-eutl"
    directory.mkdir(exist_ok=True)
    (directory / "eutl-signers.pem").write_bytes(b"".join(signers))
    (directory / "eutl-timestamp.pem").write_bytes(b"")
    monkeypatch.setattr(eutl, "_bundle_dir", lambda: directory)


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
        assert result["msctl_trust"] == {
            "requested": False,
            "available": False,
            "anchor_count": 0,
        }

    def test_the_other_sources_do_not_read_this_bundle(self, monkeypatch, tmp_path, pki):
        # Each source is opted into separately; turning on the store or the
        # trusted lists must not open this one.
        reads = _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        _fake_eutl_bundle(monkeypatch, tmp_path)
        monkeypatch.setattr(os_trust, "_enumerate", lambda store: [])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        verify_signatures(out, system_trust=True, eutl_trust=True,
                          trust_roots=[pki["ca_pem"]])
        assert reads == []


class TestVerifyAgainstTheBundle:
    def test_opting_in_trusts_a_chain_the_bundle_anchors(self, monkeypatch, tmp_path, pki):
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, msctl_trust=True)
        signature = result["signatures"][0]
        assert signature["trusted"] is True
        assert signature["trust_source"] == "msctl"
        assert result["summary"]["trust_verified"] is True
        assert result["msctl_trust"]["requested"] is True
        assert result["msctl_trust"]["available"] is True
        assert result["msctl_trust"]["anchor_count"] == 1

    def test_an_unrelated_bundle_trusts_nothing(self, monkeypatch, tmp_path, pki):
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["other_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, msctl_trust=True)
        assert result["signatures"][0]["trusted"] is False
        assert result["signatures"][0]["trust_source"] is None
        assert result["summary"]["trust_verified"] is False

    def test_a_timestamp_only_anchor_never_validates_a_signer(
        self, monkeypatch, tmp_path, pki
    ):
        # The purpose split is what the fetch encodes by writing an anchor into
        # one file and not the other, and this is where that encoding has to
        # hold: a subject the program grants only timestamping must not be able
        # to terminate a signer chain, however it got into the bundle.
        _fake_bundle(monkeypatch, tmp_path, timestampers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, msctl_trust=True)
        assert result["signatures"][0]["trusted"] is False
        assert result["signatures"][0]["trust_source"] is None
        # The anchor is in force — it is simply in force for the other chain.
        assert result["msctl_trust"]["anchor_count"] == 1

    def test_an_anchor_in_both_files_still_validates_a_signer(
        self, monkeypatch, tmp_path, pki
    ):
        # The complement of the test above: an unrestricted subject is written
        # into both files, and the signer chain must reach it.
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])],
                     timestampers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, msctl_trust=True)
        assert result["signatures"][0]["trusted"] is True
        # One certificate, one anchor: the report counts the union, not the rows.
        assert result["msctl_trust"]["anchor_count"] == 1

    def test_a_missing_bundle_reports_unavailable(self, monkeypatch, tmp_path, pki):
        # "This installation has no bundle" is not the same result as "the
        # bundle anchors nothing", and must not read as a failed chain.
        _fake_bundle(monkeypatch, tmp_path)
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, msctl_trust=True)
        assert result["msctl_trust"]["requested"] is True
        assert result["msctl_trust"]["available"] is False
        assert result["msctl_trust"]["anchor_count"] == 0
        assert result["signatures"][0]["trusted"] is False

    def test_a_malformed_entry_does_not_remove_the_others(
        self, monkeypatch, tmp_path, pki
    ):
        broken = b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
        _fake_bundle(monkeypatch, tmp_path, signers=[broken, _pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        assert verify_signatures(out, msctl_trust=True)["signatures"][0]["trusted"] is True

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
        result = verify_signatures(out, msctl_trust=True)
        assert result["signatures"][0]["intact"] is False
        assert result["signatures"][0]["trust_source"] is None


class TestSourcePrecedence:
    """user → trusted lists → root program → platform store, narrowest first."""

    def test_a_user_anchor_wins_over_the_bundle(self, monkeypatch, tmp_path, pki):
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, trust_roots=[pki["ca_pem"]], msctl_trust=True)
        assert result["signatures"][0]["trusted"] is True
        assert result["signatures"][0]["trust_source"] == "user"

    def test_the_trusted_lists_win_over_the_root_program(self, monkeypatch, tmp_path, pki):
        # Both bundles carry the same authority. A trusted list's statement is
        # the narrower one — a granted qualified authority — so that is what the
        # result says.
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        _fake_eutl_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, eutl_trust=True, msctl_trust=True)
        assert result["signatures"][0]["trusted"] is True
        assert result["signatures"][0]["trust_source"] == "eutl"

    def test_the_root_program_wins_over_the_platform_store(
        self, monkeypatch, tmp_path, pki
    ):
        # A curated program says the authority is in the program and has not
        # been withdrawn from it; the store says only that the machine carries
        # the root.
        der = _der_of(pki["ca_pem"])
        monkeypatch.setattr(
            os_trust, "_enumerate",
            lambda store: [(der, "x509_asn", True)] if store == "ROOT" else [],
        )
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, system_trust=True, msctl_trust=True)
        assert result["signatures"][0]["trusted"] is True
        assert result["signatures"][0]["trust_source"] == "msctl"
        assert result["system_trust"]["requested"] is True
        assert result["msctl_trust"]["requested"] is True

    def test_the_bundle_is_additive_and_never_a_replacement(
        self, monkeypatch, tmp_path, pki
    ):
        # A root an administrator installed locally is in the store and in no
        # published program. Turning the program on must not lose it.
        der = _der_of(pki["ca_pem"])
        monkeypatch.setattr(
            os_trust, "_enumerate",
            lambda store: [(der, "x509_asn", True)] if store == "ROOT" else [],
        )
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["other_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(out, system_trust=True, msctl_trust=True)
        assert result["signatures"][0]["trusted"] is True
        assert result["signatures"][0]["trust_source"] == "system"

    def test_every_source_is_reported_independently(self, monkeypatch, tmp_path, pki):
        monkeypatch.setattr(os_trust, "available", lambda: False)
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        _fake_eutl_bundle(monkeypatch, tmp_path)
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        result = verify_signatures(
            out, system_trust=True, eutl_trust=True, msctl_trust=True
        )
        assert result["system_trust"]["available"] is False
        assert result["eutl_trust"]["available"] is False
        assert result["msctl_trust"]["available"] is True


class TestProvenance:
    def test_the_report_carries_the_bundle_date_and_list_identity(
        self, monkeypatch, tmp_path, pki
    ):
        manifest = {
            "fetched": "2026-08-26",
            "list": {
                "sequence_number": "369069143887839448588",
                "this_update": "2026-06-18T07:29:24+00:00",
            },
        }
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])],
                     manifest=manifest)
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        report = verify_signatures(out, msctl_trust=True)["msctl_trust"]
        assert report["fetched"] == "2026-08-26"
        # A decimal string, not a number: the identifier exceeds what a JSON
        # number survives exactly, and a rounded one names a different list.
        assert report["sequence"] == "369069143887839448588"
        assert report["issued"] == "2026-06-18T07:29:24+00:00"

    def test_a_bundle_without_a_manifest_reports_nulls_not_a_guess(
        self, monkeypatch, tmp_path, pki
    ):
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])])
        out = _signed(os.path.join(str(tmp_path), "doc.pdf"), pki)
        report = verify_signatures(out, msctl_trust=True)["msctl_trust"]
        assert report["available"] is True
        assert report["fetched"] is None
        assert report["sequence"] is None
        assert report["issued"] is None

    def test_provenance_carries_no_counts_of_its_own(self, monkeypatch, tmp_path, pki):
        # How many anchors are in force is a property of the verification. Two
        # numbers for one thing is two numbers that can disagree.
        _fake_bundle(monkeypatch, tmp_path, signers=[_pem_of(pki["ca_pem"])],
                     manifest={"files": {"msctl-signers.pem": {"count": 999}}})
        assert "anchor_count" not in msctl.provenance()


class TestTheShippedBundle:
    """The committed bundle itself — parsed, counted, and cross-checked against
    its own manifest. No network, and no assertion about any particular
    certificate authority: the point is that what ships is what was reviewed."""

    @pytest.fixture
    def bundle_dir(self):
        directory = msctl._bundle_dir()
        if not (directory / "msctl-manifest.json").is_file():
            pytest.skip("no root-program bundle in this tree")
        return directory

    @pytest.fixture
    def manifest(self, bundle_dir):
        return json.loads((bundle_dir / "msctl-manifest.json").read_text(encoding="utf-8"))

    def test_every_certificate_parses_as_the_validators_type(self, bundle_dir):
        anchors = msctl.anchors(msctl.SIGNER) + msctl.anchors(msctl.TIMESTAMP)
        assert anchors, "the shipped bundle holds no anchors"
        assert all(isinstance(a, asn1_x509.Certificate) for a in anchors)

    def test_the_files_match_the_manifest_byte_for_byte(self, bundle_dir, manifest):
        for name, recorded in manifest["files"].items():
            digest = hashlib.sha256((bundle_dir / name).read_bytes()).hexdigest()
            assert digest == recorded["sha256"], f"{name} is not the file that was reviewed"

    def test_the_counts_match_the_manifest(self, bundle_dir, manifest):
        assert len(msctl.anchors(msctl.SIGNER)) == manifest["files"]["msctl-signers.pem"]["count"]
        assert (
            len(msctl.anchors(msctl.TIMESTAMP))
            == manifest["files"]["msctl-timestamp.pem"]["count"]
        )

    def test_the_bundle_is_narrower_than_the_grant_alone_would_be(self, manifest):
        # The whole point of the fetch: the published roster includes every
        # authority the program ever listed, withdrawn ones included. A bundle
        # as wide as the naive read is a bundle that stopped reading distrust.
        naive = manifest["naive_read_would_have_anchored"]
        assert manifest["files"]["msctl-signers.pem"]["count"] < naive["signer"]
        assert manifest["files"]["msctl-timestamp.pem"]["count"] < naive["timestamp"]
        assert manifest["excluded"]["disallowed_after_a_past_moment"] > 0

    def test_nothing_unauthenticated_reached_the_bundle(self, manifest):
        # Certificate material the signed list does not name, and material whose
        # properties disagree with it, are both excluded rather than pinned.
        assert manifest["excluded"]["not_named_by_signed_list"] == 0
        assert manifest["excluded"]["properties_disagree_with_signed_list"] == 0
        assert manifest["list"]["signer_authenticated"] in ("pinned", "first-fetch")

    def test_the_pinned_issuer_is_the_one_the_manifest_names(self, bundle_dir, manifest):
        from asn1crypto import pem

        pinned = {
            hashlib.sha256(der).hexdigest()
            for _, _, der in pem.unarmor(
                (bundle_dir / "msctl-ctl-signers.pem").read_bytes(), multiple=True
            )
        }
        assert set(manifest["list"]["issuer_sha256"]) <= pinned

    def test_the_two_purpose_files_are_not_the_same_set(self, bundle_dir):
        # If they were, the split would be decorative and the timestamp-only
        # refusal above would prove nothing about the shipped data.
        signers = {a.sha256 for a in msctl.anchors(msctl.SIGNER)}
        timestampers = {a.sha256 for a in msctl.anchors(msctl.TIMESTAMP)}
        assert signers != timestampers
        assert signers - timestampers

    def test_the_bundle_is_read_once_and_kept(self, bundle_dir):
        msctl._CACHE.clear()
        msctl.available()
        first = msctl._CACHE.get(bundle_dir)
        msctl.anchors(msctl.SIGNER)
        msctl.provenance()
        assert msctl._CACHE.get(bundle_dir) is first
