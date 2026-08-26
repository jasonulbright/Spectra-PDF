"""The maintenance tool that writes the root-program bundle.

Nothing here touches the network or the platform. The two artefacts are
SYNTHESIZED — a signed trust list built and signed by this suite's own throwaway
key, and a serialized certificate store assembled record by record — so the
parsing, the signature binding, the pin discipline and the distrust modelling
are all exercised against inputs whose correct answer is known by construction.

The published list itself is deliberately not a fixture: it is 800 KB of third
party certificates, it changes under us, and committing it would make this suite
assert facts about certificate authorities rather than about our own code.
"""

import datetime
import hashlib
import importlib.util
import struct
from pathlib import Path

import pytest
from asn1crypto import cms, core
from asn1crypto import x509 as ax509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

# The tool is a script with a hyphen in its name, so it loads by path rather
# than by import. Loading it here is also the check that it imports at all
# without the platform tools it shells out to.
_SPEC = importlib.util.spec_from_file_location(
    "fetch_msctl",
    Path(__file__).resolve().parent.parent / "scripts" / "fetch-msctl.py",
)
fetch_msctl = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(fetch_msctl)

ANY_PURPOSE = "2.5.29.37.0"
DOCUMENT_SIGNING = "1.3.6.1.4.1.311.10.3.12"
EMAIL_PROTECTION = "1.3.6.1.5.5.7.3.4"
TIME_STAMPING = "1.3.6.1.5.5.7.3.8"
SERVER_AUTH = "1.3.6.1.5.5.7.3.1"

_FILETIME_EPOCH = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)


# ─────────────────────────── synthesizing the inputs ───────────────────────


def filetime(moment: datetime.datetime) -> bytes:
    """A moment as the 8-byte value the disallowed-after property carries."""
    ticks = int((moment - _FILETIME_EPOCH).total_seconds() * 10_000_000)
    return struct.pack("<Q", ticks)


def purposes(*oids: str) -> bytes:
    """A purpose-set property blob."""
    return fetch_msctl._PurposeList(list(oids)).dump()


def certificate(common_name: str) -> bytes:
    """A self-signed certificate, as DER. Only its bytes matter here — nothing
    in the tool validates the certificate itself, and it must not: the trust
    statement comes from the signed list, not from the certificate."""
    from cryptography import x509 as cx509
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = cx509.Name([cx509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    now = datetime.datetime.now(datetime.timezone.utc)
    built = (
        cx509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(cx509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .sign(key, hashes.SHA256())
    )
    return built.public_bytes(serialization.Encoding.DER)


def store_of(entries: list) -> bytes:
    """A serialized certificate store from `[(der, {property id: blob})]`."""
    out = bytearray(fetch_msctl.STORE_HEADER)

    def record(identifier: int, value: bytes) -> None:
        out.extend(struct.pack("<III", identifier, 1, len(value)))
        out.extend(value)

    for der, properties in entries:
        for identifier, blob in sorted(properties.items()):
            record(identifier, blob)
        # SHA-1 here is the store format's own certificate identifier over public
        # certificate bytes; integrity comes from the verified CMS signature over
        # the list, never from this hash.
        record(fetch_msctl.PROP_SHA1, hashlib.sha1(der).digest())
        record(fetch_msctl.STORE_CERTIFICATE, der)
    record(0, b"")
    return bytes(out)


def ctl_payload(entries: list, sequence: int = 42) -> bytes:
    """The trust list SEQUENCE, DER, from `[(der, {property id: blob})]`."""
    subjects = []
    for der, properties in entries:
        attributes = []
        for identifier, blob in sorted(properties.items()):
            attributes.append({
                "type": f"{fetch_msctl.PROPERTY_ARC}{identifier}",
                "values": [core.OctetString(blob)],
            })
        subjects.append({
            # The trust list keys its subjects on the SHA-1 thumbprint; the
            # identifier is dictated by the format, not chosen here.
            "subject_identifier": hashlib.sha1(der).digest(),
            "subject_attributes": attributes,
        })
    return fetch_msctl.CertificateTrustList({
        # The list's declared usage. Its content is irrelevant here — nothing in
        # the tool reads it — but it is not optional, so it carries a real value.
        "subject_usage": core.Any.load(
            fetch_msctl._PurposeList(["1.3.6.1.4.1.311.10.3.9"]).dump()
        ),
        "sequence_number": sequence,
        "this_update": datetime.datetime(2026, 6, 18, tzinfo=datetime.timezone.utc),
        "subject_algorithm": {"algorithm": "sha1"},
        "trusted_subjects": subjects,
    }).dump()


class _Signing:
    """A throwaway issuer and the signer certificate it issued, as the tool
    expects to find them embedded in the list."""

    def __init__(self):
        from cryptography import x509 as cx509
        from cryptography.x509.oid import NameOID

        now = datetime.datetime.now(datetime.timezone.utc)
        self.issuer_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        issuer_name = cx509.Name(
            [cx509.NameAttribute(NameOID.COMMON_NAME, "Test List Issuer")]
        )
        self.issuer = (
            cx509.CertificateBuilder()
            .subject_name(issuer_name)
            .issuer_name(issuer_name)
            .public_key(self.issuer_key.public_key())
            .serial_number(1)
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=3650))
            .sign(self.issuer_key, hashes.SHA256())
        )
        self.signer_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.signer = (
            cx509.CertificateBuilder()
            .subject_name(
                cx509.Name([cx509.NameAttribute(NameOID.COMMON_NAME, "Test List Signer")])
            )
            .issuer_name(issuer_name)
            .public_key(self.signer_key.public_key())
            .serial_number(2)
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=3650))
            .sign(self.issuer_key, hashes.SHA256())
        )

    def der(self, which) -> bytes:
        return which.public_bytes(serialization.Encoding.DER)

    def asn1(self, which) -> ax509.Certificate:
        return ax509.Certificate.load(self.der(which))


# The published list puts the trust list SEQUENCE directly under the CMS
# explicit tag rather than inside the OCTET STRING the CMS structure nominally
# carries, and `Any` takes whatever tag its value has — so no `asn1crypto` spec
# can BUILD one. The message is therefore assembled from hand-encoded elements
# around parts `asn1crypto` does dump. `cms.ContentInfo` parses the result the
# same way it parses the real artefact, which is the whole point of doing it.
def _length(size: int) -> bytes:
    if size < 0x80:
        return bytes([size])
    octets = (size.bit_length() + 7) // 8
    return bytes([0x80 | octets]) + size.to_bytes(octets, "big")


def _tlv(tag: int, contents: bytes) -> bytes:
    return bytes([tag]) + _length(len(contents)) + contents


SEQUENCE = 0x30
EXPLICIT_0 = 0xA0
IMPLICIT_SET_0 = 0xA0


def signed_list(
    payload: bytes,
    signing: _Signing,
    content_type: str | None = None,
    digest_over: bytes | None = None,
    sign_with=None,
    version: str = "v1",
) -> bytes:
    """A CMS SignedData carrying `payload` as the trust list.

    `content_type`, `digest_over` and `sign_with` exist so a test can build a
    message that is correct in every way but one — which is the only way to
    prove the tool checks that one thing rather than the signature alone.
    """
    content_type = content_type or fetch_msctl.OID_CTL
    digested = digest_over if digest_over is not None else payload[
        fetch_msctl._header_length(payload):
    ]
    signed_attributes = cms.CMSAttributes([
        cms.CMSAttribute({"type": "content_type", "values": [content_type]}),
        cms.CMSAttribute({
            "type": "message_digest",
            "values": [hashlib.sha256(digested).digest()],
        }),
    ])
    signature = (sign_with or signing.signer_key).sign(
        signed_attributes.dump(), padding.PKCS1v15(), hashes.SHA256()
    )
    signer = signing.asn1(signing.signer)
    encapsulated = _tlv(
        SEQUENCE,
        core.ObjectIdentifier(content_type).dump() + _tlv(EXPLICIT_0, payload),
    )
    certificates = _tlv(
        IMPLICIT_SET_0, signing.der(signing.signer) + signing.der(signing.issuer)
    )
    signer_infos = cms.SignerInfos([{
        "version": "v1",
        "sid": cms.SignerIdentifier({
            "issuer_and_serial_number": {
                "issuer": signer.issuer,
                "serial_number": signer.serial_number,
            }
        }),
        "digest_algorithm": {"algorithm": "sha256"},
        "signed_attrs": signed_attributes,
        "signature_algorithm": {"algorithm": "rsassa_pkcs1v15"},
        "signature": signature,
    }]).dump()
    signed_data = _tlv(
        SEQUENCE,
        cms.CMSVersion(version).dump()
        + cms.DigestAlgorithms([{"algorithm": "sha256"}]).dump()
        + encapsulated
        + certificates
        + signer_infos,
    )
    return _tlv(
        SEQUENCE,
        core.ObjectIdentifier("1.2.840.113549.1.7.2").dump()
        + _tlv(EXPLICIT_0, signed_data),
    )


@pytest.fixture(scope="module")
def signing():
    return _Signing()


# ────────────────────────────────── tests ──────────────────────────────────


class TestTheStoreFormat:
    def test_properties_belong_to_the_certificate_that_closes_their_group(self):
        first, second = certificate("First"), certificate("Second")
        store = store_of([
            (first, {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING)}),
            (second, {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(TIME_STAMPING)}),
        ])
        read = fetch_msctl.certificates_in(store)
        assert set(read) == {
            hashlib.sha1(first).hexdigest(),
            hashlib.sha1(second).hexdigest(),
        }
        # The second certificate's properties must not have inherited the
        # first's — the group terminates at the certificate record.
        _der, properties = read[hashlib.sha1(second).hexdigest()]
        assert fetch_msctl.purposes_in(
            properties[fetch_msctl.PROP_ENHANCED_KEY_USAGE]
        ) == {TIME_STAMPING}

    def test_a_store_without_a_header_is_refused(self):
        with pytest.raises(fetch_msctl.Refused):
            fetch_msctl.certificates_in(b"not a certificate store at all")

    def test_a_certificate_with_no_properties_reads_as_no_properties(self):
        der = certificate("Bare")
        read = fetch_msctl.certificates_in(store_of([(der, {})]))
        _der, properties = read[hashlib.sha1(der).hexdigest()]
        assert fetch_msctl.PROP_ENHANCED_KEY_USAGE not in properties


class TestTheSignedList:
    def test_a_valid_list_verifies_and_yields_its_subjects(self, signing):
        der = certificate("Anchor")
        payload = ctl_payload([
            (der, {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING)})
        ])
        recovered, signer, embedded = fetch_msctl.verify_signed_list(
            signed_list(payload, signing)
        )
        assert recovered == payload
        assert signer.sha256 == signing.asn1(signing.signer).sha256
        assert len(embedded) == 2
        listing, subjects = fetch_msctl.subjects_in(recovered)
        assert listing["sequence_number"].native == 42
        assert set(subjects) == {hashlib.sha1(der).hexdigest()}

    def test_a_tampered_payload_is_refused_though_the_signature_holds(self, signing):
        # The signature covers the signed attributes; the message-digest
        # attribute is the only thing binding them to the payload. Swapping the
        # payload under a valid signature is exactly the attack a verifier that
        # checks only the signature accepts.
        honest = ctl_payload([(certificate("Honest"), {})])
        forged = ctl_payload([(certificate("Forged"), {})])
        message = signed_list(forged, signing, digest_over=honest[
            fetch_msctl._header_length(honest):
        ])
        with pytest.raises(fetch_msctl.Refused, match="message-digest"):
            fetch_msctl.verify_signed_list(message)

    def test_a_signature_by_another_key_is_refused(self, signing):
        payload = ctl_payload([(certificate("Anchor"), {})])
        message = signed_list(payload, signing, sign_with=signing.issuer_key)
        with pytest.raises(fetch_msctl.Refused, match="does not verify"):
            fetch_msctl.verify_signed_list(message)

    def test_encapsulated_content_of_another_type_is_refused(self, signing):
        payload = ctl_payload([(certificate("Anchor"), {})])
        message = signed_list(payload, signing, content_type="1.2.840.113549.1.7.1")
        with pytest.raises(fetch_msctl.Refused, match="not a trust list"):
            fetch_msctl.verify_signed_list(message)

    def test_content_the_reader_cannot_represent_is_refused_not_raised(self, signing):
        # The published list declares the version under which its encapsulated
        # content is readable as raw octets. A message that declares another one
        # puts the payload out of reach — a refusal, never a traceback.
        payload = ctl_payload([(certificate("Anchor"), {})])
        with pytest.raises(fetch_msctl.Refused):
            fetch_msctl.verify_signed_list(signed_list(payload, signing, version="v3"))

    def test_bytes_that_are_not_cms_are_refused(self):
        with pytest.raises(fetch_msctl.Refused, match="not CMS"):
            fetch_msctl.verify_signed_list(b"\x30\x03\x02\x01\x01")


class TestThePin:
    def test_the_first_fetch_reports_itself_as_such(self, signing):
        how, issuers = fetch_msctl.authenticate_signer(
            signing.asn1(signing.signer),
            [signing.asn1(signing.signer), signing.asn1(signing.issuer)],
            pinned=[],
        )
        assert how == "first-fetch"
        assert [issuer.sha256 for issuer in issuers] == [
            signing.asn1(signing.issuer).sha256
        ]

    def test_a_pinned_issuer_that_actually_issued_the_signer_is_accepted(self, signing):
        how, _issuers = fetch_msctl.authenticate_signer(
            signing.asn1(signing.signer),
            [signing.asn1(signing.signer), signing.asn1(signing.issuer)],
            pinned=[signing.asn1(signing.issuer)],
        )
        assert how == "pinned"

    def test_an_unpinned_issuer_is_refused_rather_than_re_pinned(self, signing):
        other = _Signing()
        with pytest.raises(fetch_msctl.Refused, match="does not pin"):
            fetch_msctl.authenticate_signer(
                signing.asn1(signing.signer),
                [signing.asn1(signing.signer), signing.asn1(signing.issuer)],
                pinned=[other.asn1(other.issuer)],
            )

    def test_a_pinned_issuer_that_did_not_issue_the_signer_is_refused(self, signing):
        # The pin authenticates by signature, never by name: an impostor that
        # copies the issuer's subject name must not pass.
        from cryptography import x509 as cx509
        from cryptography.x509.oid import NameOID

        impostor_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        now = datetime.datetime.now(datetime.timezone.utc)
        impostor_signer = (
            cx509.CertificateBuilder()
            .subject_name(
                cx509.Name([cx509.NameAttribute(NameOID.COMMON_NAME, "Impostor Signer")])
            )
            .issuer_name(signing.issuer.subject)
            .public_key(impostor_key.public_key())
            .serial_number(99)
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=3650))
            .sign(impostor_key, hashes.SHA256())
        )
        with pytest.raises(fetch_msctl.Refused, match="not validly issued"):
            fetch_msctl.authenticate_signer(
                ax509.Certificate.load(
                    impostor_signer.public_bytes(serialization.Encoding.DER)
                ),
                [signing.asn1(signing.issuer)],
                pinned=[signing.asn1(signing.issuer)],
            )

    def test_a_list_embedding_no_issuer_is_refused(self, signing):
        with pytest.raises(fetch_msctl.Refused, match="no issuer"):
            fetch_msctl.authenticate_signer(
                signing.asn1(signing.signer), [signing.asn1(signing.signer)], pinned=[]
            )

    def test_the_pin_file_round_trips(self, tmp_path, signing):
        path = tmp_path / "pin.pem"
        fetch_msctl.write_pem(path, [signing.der(signing.issuer)])
        loaded = fetch_msctl.load_pinned(path)
        assert [c.sha256 for c in loaded] == [signing.asn1(signing.issuer).sha256]
        assert fetch_msctl.load_pinned(tmp_path / "absent.pem") == []


class TestADeletedPinCannotSilentlyRePin:
    """Trust on first use is right exactly once. Once the bundle is committed,
    a missing pin file is a DELETED pin, and a fetch that quietly re-pinned
    under it would authenticate nothing — the only backstop being a human
    noticing one word in the manifest diff."""

    def test_a_genuinely_empty_directory_is_the_first_fetch(self, tmp_path):
        fetch_msctl.guard_missing_pin(
            tmp_path, tmp_path / "msctl-ctl-signers.pem", first_fetch=False
        )

    def test_a_present_pin_never_needs_the_flag(self, tmp_path, signing):
        pin = tmp_path / "msctl-ctl-signers.pem"
        fetch_msctl.write_pem(pin, [signing.der(signing.issuer)])
        (tmp_path / "msctl-manifest.json").write_text("{}", encoding="utf-8")
        fetch_msctl.guard_missing_pin(tmp_path, pin, first_fetch=False)

    @pytest.mark.parametrize("artefact", fetch_msctl.BUNDLE_ARTEFACTS)
    def test_a_missing_pin_beside_a_committed_bundle_refuses(self, tmp_path, artefact):
        (tmp_path / artefact).write_text("x", encoding="utf-8")
        with pytest.raises(fetch_msctl.Refused, match="--first-fetch"):
            fetch_msctl.guard_missing_pin(
                tmp_path, tmp_path / "msctl-ctl-signers.pem", first_fetch=False
            )

    def test_the_flag_is_what_permits_a_deliberate_re_pin(self, tmp_path):
        (tmp_path / "msctl-manifest.json").write_text("{}", encoding="utf-8")
        fetch_msctl.guard_missing_pin(
            tmp_path, tmp_path / "msctl-ctl-signers.pem", first_fetch=True
        )

    def test_the_shipped_bundle_would_refuse_a_pinless_fetch(self):
        # The real bundle directory, as committed: deleting its pin must not be
        # a way to re-pin.
        bundle = (
            Path(__file__).resolve().parent.parent
            / "src" / "engine" / "trust" / "msctl"
        )
        if not (bundle / "msctl-manifest.json").is_file():
            pytest.skip("the msctl bundle is not provisioned in this checkout")
        with pytest.raises(fetch_msctl.Refused):
            fetch_msctl.guard_missing_pin(
                bundle, bundle / "a-pin-that-is-not-there.pem", first_fetch=False
            )


class TestDistrustIsModelled:
    """The three properties, one test each, plus what they do together."""

    def _classify(self, entries, now=None):
        store = store_of(entries)
        payload = ctl_payload(entries)
        _listing, subjects = fetch_msctl.subjects_in(payload)
        return fetch_msctl.classify(fetch_msctl.certificates_in(store), subjects, now)

    def test_a_grant_alone_anchors_the_chains_it_names(self):
        signer = certificate("Signer")
        stamper = certificate("Stamper")
        verdict = self._classify([
            (signer, {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING)}),
            (stamper, {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(TIME_STAMPING)}),
        ])
        assert verdict["signer_anchors"] == [signer]
        assert verdict["timestamp_anchors"] == [stamper]

    def test_an_unmodelled_policy_restriction_anchors_but_is_counted(self):
        # Property 83 constrains issuance dates, which the validator takes no
        # per-anchor form of, so the subject anchors normally. The count is what
        # makes the size of that gap auditable across refreshes instead of only
        # being a paragraph in the tool's docstring.
        restricted = certificate("PolicyRestricted")
        plain = certificate("Plain")
        verdict = self._classify([
            (restricted, {
                fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING),
                fetch_msctl.PROP_ROOT_PROGRAM_POLICIES: b"\x04\x02\x00\x00",
            }),
            (plain, {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING)}),
        ])
        assert sorted(verdict["signer_anchors"]) == sorted([restricted, plain])
        assert verdict["unmodelled_policy_restriction"] == 1

    def test_a_past_disallowed_after_moment_drops_the_subject_entirely(self):
        withdrawn = certificate("Withdrawn")
        past = datetime.datetime(2019, 2, 1, tzinfo=datetime.timezone.utc)
        verdict = self._classify([
            (withdrawn, {
                fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING, TIME_STAMPING),
                fetch_msctl.PROP_DISALLOWED_AFTER: filetime(past),
            }),
        ])
        assert verdict["signer_anchors"] == []
        assert verdict["timestamp_anchors"] == []
        assert verdict["excluded"]["disallowed_after_a_past_moment"] == 1
        # …and the naive read shows exactly what was avoided.
        assert len(verdict["naive_signer"]) == 1
        fetch_msctl.prove(verdict)

    def test_a_future_disallowed_after_moment_keeps_the_subject(self):
        # The property is compared, never assumed: a moment still ahead is a
        # subject that is trusted TODAY and will not be later.
        pending = certificate("Pending")
        future = datetime.datetime(2099, 1, 1, tzinfo=datetime.timezone.utc)
        verdict = self._classify([
            (pending, {
                fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING),
                fetch_msctl.PROP_DISALLOWED_AFTER: filetime(future),
            }),
        ])
        assert verdict["signer_anchors"] == [pending]
        assert verdict["rows"][0]["restricted"] == "2099-01-01"

    def test_the_comparison_is_against_the_moment_not_the_calendar(self):
        # Same subject, two evaluation moments, opposite verdicts.
        subject = certificate("Boundary")
        moment = datetime.datetime(2030, 1, 1, tzinfo=datetime.timezone.utc)
        entry = [(subject, {
            fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING),
            fetch_msctl.PROP_DISALLOWED_AFTER: filetime(moment),
        })]
        before = self._classify(entry, moment - datetime.timedelta(days=1))
        after = self._classify(entry, moment + datetime.timedelta(days=1))
        assert before["signer_anchors"] == [subject]
        assert after["signer_anchors"] == []

    def test_a_per_purpose_denial_is_subtracted_from_the_grant(self):
        both = certificate("BothThenOne")
        verdict = self._classify([
            (both, {
                fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING, TIME_STAMPING),
                fetch_msctl.PROP_DISALLOWED_PURPOSES: purposes(DOCUMENT_SIGNING),
            }),
        ])
        assert verdict["signer_anchors"] == []
        assert verdict["timestamp_anchors"] == [both]
        assert verdict["trimmed_by_denial"] == 1
        assert verdict["rows"][0]["purposes"] == "timestamp"

    def test_a_denial_that_empties_the_grant_drops_the_subject(self):
        emptied = certificate("Emptied")
        verdict = self._classify([
            (emptied, {
                fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING),
                fetch_msctl.PROP_DISALLOWED_PURPOSES: purposes(DOCUMENT_SIGNING),
            }),
        ])
        assert verdict["signer_anchors"] == []
        assert verdict["timestamp_anchors"] == []
        assert verdict["excluded"]["no_purpose_this_bundle_anchors"] == 1

    def test_a_denial_of_a_purpose_this_bundle_ignores_changes_nothing(self):
        unaffected = certificate("Unaffected")
        verdict = self._classify([
            (unaffected, {
                fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING),
                fetch_msctl.PROP_DISALLOWED_PURPOSES: purposes(SERVER_AUTH),
            }),
        ])
        assert verdict["signer_anchors"] == [unaffected]

    def test_no_purpose_property_at_all_is_unrestricted(self):
        # The trust-widening default, stated in the module docstring and pinned
        # here so it can never become a silent behaviour.
        bare = certificate("Bare")
        verdict = self._classify([(bare, {})])
        assert verdict["signer_anchors"] == [bare]
        assert verdict["timestamp_anchors"] == [bare]
        assert verdict["unrestricted"] == 1

    def test_an_explicit_any_purpose_grant_anchors_both_chains(self):
        every = certificate("Every")
        verdict = self._classify([
            (every, {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(ANY_PURPOSE)}),
        ])
        assert verdict["signer_anchors"] == [every]
        assert verdict["timestamp_anchors"] == [every]

    def test_email_protection_anchors_a_signer_chain(self):
        # The purpose sets are os_trust's, not a second copy — a change there
        # has to move this test, which is the point.
        from engine.os_trust import SIGNER_PURPOSES

        assert EMAIL_PROTECTION in SIGNER_PURPOSES
        smime = certificate("Smime")
        verdict = self._classify([
            (smime, {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(EMAIL_PROTECTION)}),
        ])
        assert verdict["signer_anchors"] == [smime]
        assert verdict["timestamp_anchors"] == []

    def test_a_grant_of_a_purpose_this_bundle_ignores_anchors_nothing(self):
        web = certificate("Web")
        verdict = self._classify([
            (web, {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(SERVER_AUTH)}),
        ])
        assert verdict["signer_anchors"] == []
        assert verdict["excluded"]["no_purpose_this_bundle_anchors"] == 1


class TestTheStoreIsMaterialNotAuthority:
    def _classify(self, store_entries, list_entries):
        payload = ctl_payload(list_entries)
        _listing, subjects = fetch_msctl.subjects_in(payload)
        return fetch_msctl.classify(
            fetch_msctl.certificates_in(store_of(store_entries)), subjects
        )

    def test_a_certificate_the_signed_list_does_not_name_is_excluded(self):
        # The store is an unauthenticated download. A certificate in it and not
        # in the signed list has nothing vouching for it and must not anchor.
        listed = certificate("Listed")
        smuggled = certificate("Smuggled")
        grant = {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING)}
        verdict = self._classify([(listed, grant), (smuggled, grant)], [(listed, grant)])
        assert verdict["signer_anchors"] == [listed]
        assert verdict["excluded"]["not_named_by_signed_list"] == 1

    def test_a_widened_grant_in_the_store_is_refused_not_honoured(self):
        # The store carries its own copy of the properties. If it disagrees with
        # the signed list, the subject is dropped — taking the signed list's
        # narrower answer silently would let an unauthenticated file decide
        # which disagreements matter.
        subject = certificate("Widened")
        verdict = self._classify(
            [(subject, {
                fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING, TIME_STAMPING)
            })],
            [(subject, {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(TIME_STAMPING)})],
        )
        assert verdict["signer_anchors"] == []
        assert verdict["timestamp_anchors"] == []
        assert verdict["excluded"]["properties_disagree_with_signed_list"] == 1

    def test_a_stripped_distrust_property_in_the_store_is_refused(self):
        subject = certificate("Stripped")
        past = datetime.datetime(2019, 2, 1, tzinfo=datetime.timezone.utc)
        verdict = self._classify(
            [(subject, {fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING)})],
            [(subject, {
                fetch_msctl.PROP_ENHANCED_KEY_USAGE: purposes(DOCUMENT_SIGNING),
                fetch_msctl.PROP_DISALLOWED_AFTER: filetime(past),
            })],
        )
        assert verdict["signer_anchors"] == []
        assert verdict["excluded"]["properties_disagree_with_signed_list"] == 1


class TestTheProof:
    def test_a_leaked_distrusted_subject_refuses_the_write(self):
        # `prove` is the last gate before anything is written; a classification
        # that let a dropped subject through has to stop the run rather than
        # ship a wider anchor set.
        verdict = {
            "rows": [{"sha1": "aa", "purposes": "signer"}],
            "naive_signer": {"aa"},
            "naive_timestamp": set(),
            "dropped_by_date": {"aa"},
            "excluded": {"disallowed_after_a_past_moment": 1},
        }
        with pytest.raises(fetch_msctl.Refused, match="distrusted subject"):
            fetch_msctl.prove(verdict)

    def test_an_anchor_the_grant_never_permitted_refuses_the_write(self):
        verdict = {
            "rows": [{"sha1": "bb", "purposes": "signer"}],
            "naive_signer": set(),
            "naive_timestamp": set(),
            "dropped_by_date": set(),
            "excluded": {"disallowed_after_a_past_moment": 1},
        }
        with pytest.raises(fetch_msctl.Refused, match="grant alone"):
            fetch_msctl.prove(verdict)

    def test_live_data_with_no_dated_exclusion_refuses_the_write(self):
        # The published list always carries withdrawn subjects. Excluding none
        # of them means the property stopped being read.
        verdict = {
            "rows": [{"sha1": "cc", "purposes": "signer,timestamp"}],
            "naive_signer": {"cc"},
            "naive_timestamp": {"cc"},
            "dropped_by_date": set(),
            "excluded": {"disallowed_after_a_past_moment": 0},
        }
        fetch_msctl.prove(verdict)  # fine for a synthetic input
        with pytest.raises(fetch_msctl.Refused, match="not being applied"):
            fetch_msctl.prove(verdict, require_a_dated_exclusion=True)


class TestTheParsingPrimitives:
    def test_a_long_form_header_is_measured_not_assumed(self):
        # The published list is BER: every length is long-form, so a two-byte
        # header assumption silently mis-slices the payload.
        assert fetch_msctl._header_length(bytes([0x30, 0x05])) == 2
        assert fetch_msctl._header_length(bytes([0x30, 0x83, 0x03, 0x0B, 0xDF])) == 5

    def test_an_indefinite_length_is_refused(self):
        with pytest.raises(fetch_msctl.Refused, match="indefinite"):
            fetch_msctl._header_length(bytes([0x30, 0x80]))

    def test_a_zero_filetime_is_no_restriction_rather_than_the_epoch(self):
        assert fetch_msctl.disallowed_after(struct.pack("<Q", 0)) is None
        assert fetch_msctl.disallowed_after(None) is None
        assert fetch_msctl.disallowed_after(b"\x00\x00") is None

    def test_an_absent_purpose_property_is_none_and_not_the_empty_set(self):
        assert fetch_msctl.purposes_in(None) is None
        assert fetch_msctl.purposes_in(b"") is None
        assert fetch_msctl.purposes_in(purposes(TIME_STAMPING)) == {TIME_STAMPING}

    def test_a_malformed_purpose_property_is_refused(self):
        with pytest.raises(fetch_msctl.Refused, match="purposes"):
            fetch_msctl.purposes_in(b"\x01\x02\x03\x04")
