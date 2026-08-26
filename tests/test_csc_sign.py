"""Signing through a remote signing service, across every placement.

The provider is `csc_mock` — a real HTTPS server on loopback whose keys are
real — so the signatures asserted here are produced by a key this process never
holds and are verified against the credential's own certificate. Nothing is
stubbed at the transport and nothing is recorded: what a passing test proves is
that the digest seam carries a genuine signature back into the document.

The matrix mirrors `test_store_sign.py`: the whole point of splitting a signer
at the digest is that no placement needs a path of its own, and the way to hold
that claim is to run the same placements through the new source.
"""

import base64
import os

import pikepdf
import pytest
from cryptography.hazmat.primitives import serialization

import engine.signatures as sigmod
from csc_mock import TOKEN, MockCredential, MockCsc
from engine import csc_signer
from engine.csc import HASH_OID, SIGN_ALGO_RSA_PKCS1, CscError
from engine.signatures import sign_pdf, verify_signatures

SHA256_OID = HASH_OID["sha256"]


@pytest.fixture(autouse=True)
def forget_tokens():
    """A held token is a session's, not a test's: one case must never
    authorize the next one's request."""
    csc_signer.forget_sessions()
    yield
    csc_signer.forget_sessions()


@pytest.fixture
def mock(tmp_path):
    with MockCsc(tmp_path) as server:
        yield server


@pytest.fixture
def blank_pdf(tmp_dir):
    p = os.path.join(tmp_dir, "doc.pdf")
    doc = pikepdf.new()
    doc.add_blank_page(page_size=(400, 400))
    doc.save(p)
    doc.close()
    return p


def _params(mock, credential_id: str = "cred-1", **overrides) -> dict:
    params = {
        "csc_url": mock.base_url,
        "csc_credential": credential_id,
        "csc_client_id": mock.client_id,
        "csc_ca_bundle": mock.ca_path,
    }
    params.update(overrides)
    return params


def _sign(src, out, mock, **kw):
    return sign_pdf(src, out, **_params(mock, **kw))


def _anchor(mock, tmp_path, credential_id: str = "cred-1") -> str:
    """The credential's own certificate as a PEM trust root.

    The mock's leaf is self-signed, so it IS its own anchor; revocation
    gathering needs one to build a path at all."""
    path = str(tmp_path / f"{credential_id}-anchor.pem")
    with open(path, "wb") as handle:
        handle.write(
            mock.credentials[credential_id].cert.public_bytes(serialization.Encoding.PEM)
        )
    return path


@pytest.fixture
def dummy_tsa(monkeypatch, tmp_path):
    """pyHanko's offline RFC 3161 responder, so B-T/B-LT/B-LTA run with no
    network beyond the loopback provider."""
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    from pyhanko.sign import signers
    from pyhanko.sign.timestamps.dummy_client import DummyTimeStamper

    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "CSC Test TSA")])
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime(2000, 1, 1))
        .not_valid_after(datetime.datetime(2100, 1, 1))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.TIME_STAMPING]), critical=True
        )
        .sign(key, hashes.SHA256())
    )
    pfx = str(tmp_path / "tsa.pfx")
    with open(pfx, "wb") as handle:
        handle.write(
            pkcs12.serialize_key_and_certificates(
                b"tsa", key, cert, None, serialization.BestAvailableEncryption(b"pw")
            )
        )
    loaded = signers.SimpleSigner.load_pkcs12(pfx, passphrase=b"pw")
    stamper = DummyTimeStamper(
        tsa_cert=loaded.signing_cert,
        tsa_key=loaded.signing_key,
        certs_to_embed=loaded.cert_registry,
    )
    monkeypatch.setattr(sigmod, "_make_timestamper", lambda url: stamper)
    # LTV validates the TIMESTAMP chain too, so the offline responder is its
    # own anchor and the revocation pass needs to be told so.
    anchor = str(tmp_path / "tsa-anchor.pem")
    with open(anchor, "wb") as handle:
        handle.write(cert.public_bytes(serialization.Encoding.PEM))
    return anchor


class TestPlacements:
    """Every placement, through the one digest seam."""

    def test_invisible_signature_verifies(self, mock, tmp_dir, blank_pdf):
        out = os.path.join(tmp_dir, "signed.pdf")
        r = _sign(blank_pdf, out, mock, reason="CSC pytest")
        assert r["valid"] and r["intact"] and r["covers_whole_document"]
        v = verify_signatures(out)
        assert v["signed"] and v["signatures"][0]["valid"] and v["signatures"][0]["intact"]

    def test_the_document_bytes_never_leave_the_machine(self, mock, tmp_dir, blank_pdf):
        # The provider is asked for a signature over a DIGEST and nothing else.
        # Every hash it saw is 32 bytes of SHA-256 — a document could not be
        # smuggled through this seam even if some future caller tried.
        out = os.path.join(tmp_dir, "digest-only.pdf")
        _sign(blank_pdf, out, mock)
        assert mock.signed_hashes
        for batch in mock.signed_hashes:
            for value in batch:
                assert len(base64.b64decode(value)) == 32

    def test_visible_stamp(self, mock, tmp_dir, blank_pdf):
        out = os.path.join(tmp_dir, "visible.pdf")
        r = _sign(
            blank_pdf, out, mock, appearance={"page": 1, "rect": [100, 100, 300, 160]}
        )
        assert r["valid"] and r["intact"]
        assert verify_signatures(out)["signatures"][0]["page"] == 1

    def test_existing_field_fill(self, mock, tmp_dir, blank_pdf):
        prepared = os.path.join(tmp_dir, "prepared.pdf")
        from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
        from pyhanko.sign import fields

        with open(blank_pdf, "rb") as handle:
            writer = IncrementalPdfFileWriter(handle)
            fields.append_signature_field(
                writer, fields.SigFieldSpec("Approval", on_page=0, box=(50, 50, 250, 110))
            )
            with open(prepared, "wb") as out_handle:
                writer.write(out_handle)
        out = os.path.join(tmp_dir, "filled.pdf")
        r = _sign(prepared, out, mock, existing_field="Approval")
        assert r["valid"] and r["field"] == "Approval"

    def test_in_place(self, mock, tmp_dir, blank_pdf):
        import shutil

        target = os.path.join(tmp_dir, "in-place.pdf")
        shutil.copyfile(blank_pdf, target)
        r = _sign(target, target, mock, allow_in_place=True)
        assert r["valid"] and r["intact"]
        assert verify_signatures(target)["signature_count"] == 1

    def test_certification(self, mock, tmp_dir, blank_pdf):
        out = os.path.join(tmp_dir, "certified.pdf")
        r = _sign(blank_pdf, out, mock, certify=True, certify_level="form-fill")
        assert r["valid"] and r["certified"]
        assert r["certification_level"] == "form-fill"

    def test_field_lock(self, mock, tmp_dir, blank_pdf):
        out = os.path.join(tmp_dir, "locked.pdf")
        r = _sign(blank_pdf, out, mock, lock="all")
        assert r["valid"] and r["lock"] == "all"

    def test_counter_signing_rotates_the_field_name(self, mock, tmp_dir, blank_pdf):
        first = os.path.join(tmp_dir, "one.pdf")
        second = os.path.join(tmp_dir, "two.pdf")
        _sign(blank_pdf, first, mock)
        r = _sign(first, second, mock)
        assert r["field"] == "Signature2"
        assert verify_signatures(second)["signature_count"] == 2


class TestPadesProfiles:
    def test_b_b(self, mock, tmp_dir, blank_pdf):
        out = os.path.join(tmp_dir, "b-b.pdf")
        _sign(blank_pdf, out, mock, pades=True)
        sig = verify_signatures(out)["signatures"][0]
        assert sig["pades"] is True and sig["subfilter"] == "/ETSI.CAdES.detached"
        assert sig["valid"] and sig["intact"]

    def test_b_t(self, mock, tmp_dir, blank_pdf, dummy_tsa):
        out = os.path.join(tmp_dir, "b-t.pdf")
        _sign(blank_pdf, out, mock, pades=True, tsa_url="http://tsa.example/rfc3161")
        sig = verify_signatures(out)["signatures"][0]
        assert sig["timestamped"] is True and sig["timestamp_time"] is not None
        assert sig["valid"]

    def test_b_lt(self, mock, tmp_dir, tmp_path, blank_pdf, dummy_tsa):
        out = os.path.join(tmp_dir, "b-lt.pdf")
        _sign(
            blank_pdf, out, mock,
            pades=True, tsa_url="http://tsa.example/rfc3161",
            embed_revocation=True, trust_roots=[_anchor(mock, tmp_path), dummy_tsa],
        )
        r = verify_signatures(out)
        assert r["ltv_info_present"] is True
        assert r["signatures"][0]["pades"] is True

    def test_b_lta(self, mock, tmp_dir, tmp_path, blank_pdf, dummy_tsa):
        out = os.path.join(tmp_dir, "b-lta.pdf")
        _sign(
            blank_pdf, out, mock,
            pades=True, tsa_url="http://tsa.example/rfc3161",
            embed_revocation=True, lta=True, trust_roots=[_anchor(mock, tmp_path), dummy_tsa],
        )
        r = verify_signatures(out)
        # The document timestamp is a SECOND signing operation, so this also
        # proves one authorized session covers more than one signature.
        assert r["document_timestamps"] >= 1
        assert r["signature_count"] == 1
        assert r["signatures"][0]["valid"]


class TestKeyKinds:
    def test_an_ec_credential_signs(self, tmp_path, tmp_dir, blank_pdf):
        with MockCsc(tmp_path, credentials=[MockCredential("ec-1", key_type="ec")]) as mock:
            out = os.path.join(tmp_dir, "ec.pdf")
            r = _sign(blank_pdf, out, mock, csc_credential="ec-1")
            assert r["valid"] and r["intact"]
            assert verify_signatures(out)["signatures"][0]["valid"]

    def test_an_ec_credential_returning_der_signs(self, tmp_path, tmp_dir, blank_pdf):
        # The spec settles neither shape, so the DER arm has to verify too —
        # a re-wrapped DER signature would parse as garbage.
        with MockCsc(
            tmp_path,
            credentials=[MockCredential("ec-der", key_type="ec", ecdsa_shape="der")],
        ) as mock:
            out = os.path.join(tmp_dir, "ec-der.pdf")
            r = _sign(blank_pdf, out, mock, csc_credential="ec-der")
            assert r["valid"] and verify_signatures(out)["signatures"][0]["valid"]

    def test_pss_signs_under_the_salt_the_cms_declares(self, mock, tmp_dir, blank_pdf):
        # The provider reads `signAlgoParams` and salts by it. Declaring one
        # salt and signing under another leaves every field reading correct and
        # the signature verifying against nothing, which is exactly the failure
        # a fixed salt would produce.
        class PssSigner(csc_signer.CscSigner):
            def __init__(self, session, **kwargs):
                super().__init__(session, prefer_pss=True)

        original = csc_signer.CscSigner
        csc_signer.CscSigner = PssSigner
        try:
            out = os.path.join(tmp_dir, "pss.pdf")
            r = _sign(blank_pdf, out, mock)
        finally:
            csc_signer.CscSigner = original
        assert r["valid"] and r["intact"]
        assert verify_signatures(out)["signatures"][0]["valid"]


class TestReturnedSignatureIsChecked:
    """A returned signature is verified against the credential's own
    certificate before anything is embedded.

    The mock returns a signature of exactly the right length that is not this
    key's signature over this digest. A count check cannot see that; the
    document would be saved, look signed, and validate against nothing.
    """

    def _refuses(self, tmp_path, tmp_dir, blank_pdf, credential):
        with MockCsc(tmp_path, credentials=[credential], corrupt_signature=True) as mock:
            out = os.path.join(tmp_dir, "never.pdf")
            with pytest.raises(ValueError, match="does not verify against"):
                _sign(blank_pdf, out, mock, csc_credential=credential.credential_id)
            assert not os.path.exists(out)

    def test_a_bad_pkcs1_signature_refuses_and_embeds_nothing(
        self, tmp_path, tmp_dir, blank_pdf
    ):
        self._refuses(tmp_path, tmp_dir, blank_pdf, MockCredential("rsa-bad"))

    def test_a_bad_ecdsa_signature_refuses_and_embeds_nothing(
        self, tmp_path, tmp_dir, blank_pdf
    ):
        self._refuses(
            tmp_path, tmp_dir, blank_pdf, MockCredential("ec-bad", key_type="ec")
        )

    def test_a_bad_der_ecdsa_signature_refuses_and_embeds_nothing(
        self, tmp_path, tmp_dir, blank_pdf
    ):
        self._refuses(
            tmp_path,
            tmp_dir,
            blank_pdf,
            MockCredential("ec-der-bad", key_type="ec", ecdsa_shape="der"),
        )

    def test_a_bad_pss_signature_refuses_and_embeds_nothing(
        self, tmp_path, tmp_dir, blank_pdf
    ):
        class PssSigner(csc_signer.CscSigner):
            def __init__(self, session, **kwargs):
                super().__init__(session, prefer_pss=True)

        original = csc_signer.CscSigner
        csc_signer.CscSigner = PssSigner
        try:
            self._refuses(tmp_path, tmp_dir, blank_pdf, MockCredential("pss-bad"))
        finally:
            csc_signer.CscSigner = original


class TestScal:
    def test_scal2_binds_the_authorization_to_the_hash_it_signs(
        self, mock, tmp_dir, blank_pdf
    ):
        # The default mock credential is SCAL2 and refuses a SAD bound to
        # anything else, so a passing signature IS the binding assertion.
        out = os.path.join(tmp_dir, "scal2.pdf")
        _sign(blank_pdf, out, mock)
        assert mock.authorized_hashes == mock.signed_hashes

    def test_scal1_signs_too(self, tmp_path, tmp_dir, blank_pdf):
        with MockCsc(tmp_path, credentials=[MockCredential("scal1", scal=1)]) as mock:
            out = os.path.join(tmp_dir, "scal1.pdf")
            r = _sign(blank_pdf, out, mock, csc_credential="scal1")
            assert r["valid"]

    def test_the_dry_run_spends_no_authorization(self, mock, tmp_dir, blank_pdf):
        # pyHanko sizes the placeholder with a dry run. Signing it would spend
        # a SAD on a digest the document never carries — and under SCAL2 that
        # authorization is bound to bytes that are then discarded.
        out = os.path.join(tmp_dir, "dry.pdf")
        _sign(blank_pdf, out, mock)
        assert len(mock.authorized_hashes) == 1
        assert len(mock.signed_hashes) == 1


class TestSessionReuseFollowsTheConfiguration:
    """A held session is reused only while the configuration it was built under
    still holds. Keying reuse on the address and the registration alone let a
    user tighten TLS trust and be served the client built under the old trust,
    with the setting reported as applied and silently not applied."""

    def _connect(self, mock, **overrides):
        params = {
            "url": mock.base_url,
            "client_id": mock.client_id,
            "ca_bundle": mock.ca_path,
        }
        params.update(overrides)
        return csc_signer.connect(**params)

    def test_the_same_configuration_reuses_one_client(self, mock):
        first = self._connect(mock)
        assert self._connect(mock) is first
        assert len(mock.token_forms) == 1

    def test_a_changed_ca_bundle_builds_a_fresh_client(self, mock, tmp_path):
        first = self._connect(mock)
        # A second bundle whose bytes are the same trust, at a different path:
        # the client must be rebuilt around the setting the user just changed,
        # not served from a cache that never looked at it.
        other = tmp_path / "other-roots.pem"
        other.write_bytes(open(mock.ca_path, "rb").read())
        second = self._connect(mock, ca_bundle=str(other))
        assert second is not first
        assert second._verify == str(other)
        assert len(mock.token_forms) == 2

    def test_a_changed_scope_builds_a_fresh_client(self, mock):
        first = self._connect(mock)
        assert self._connect(mock, scope="service credential") is not first

    def test_a_changed_secret_builds_a_fresh_client(self, tmp_path):
        with MockCsc(tmp_path, require_secret=True, client_secret="right") as mock:
            first = self._connect(mock, client_secret="right")
            assert len(mock.token_forms) == 1
            # The changed secret is not the cached session's, so it is sent —
            # and refused. A cache keyed without the secret would have returned
            # the old client and reported success.
            with pytest.raises(CscError):
                self._connect(mock, client_secret="wrong")
            assert len(mock.token_forms) == 2
            # The failed re-connect retired the session held under the old
            # settings rather than leaving its token alive.
            assert self._connect(mock, client_secret="right") is not first
            assert len(mock.token_forms) == 3


class TestTokenLifetime:
    def test_a_token_is_reused_across_signatures(self, mock, tmp_dir, blank_pdf):
        first = os.path.join(tmp_dir, "one.pdf")
        second = os.path.join(tmp_dir, "two.pdf")
        _sign(blank_pdf, first, mock)
        _sign(blank_pdf, second, mock)
        assert len(mock.token_forms) == 1

    def test_an_expired_token_is_renewed_once_mid_sign(self, mock, tmp_dir, blank_pdf):
        # The token the session holds goes stale between one signature and the
        # next. The provider answers 401, which the refusal reports
        # STRUCTURALLY rather than in its sentence, so the session renews and
        # repeats the call and the document lands. Matching the sentence
        # instead would be matching display text.
        from csc_mock import _Refused

        state = {"expired": False}

        def expiring(headers):
            if state["expired"]:
                state["expired"] = False
                raise _Refused(
                    401, {"error": "invalid_token", "error_description": "expired"}
                )
            if headers.get("Authorization") != f"Bearer {TOKEN}":
                raise _Refused(
                    401, {"error": "invalid_token", "error_description": "bad token"}
                )

        mock._require_token = expiring
        _sign(blank_pdf, os.path.join(tmp_dir, "warm.pdf"), mock)
        issued = len(mock.token_forms)
        state["expired"] = True
        r = _sign(blank_pdf, os.path.join(tmp_dir, "renewed.pdf"), mock)
        assert r["valid"] and r["intact"]
        assert len(mock.token_forms) == issued + 1  # renewed exactly once

    def test_an_expired_browser_authorization_refuses_by_name(self, mock, tmp_dir, blank_pdf):
        # A client-credentials registration can re-authorize itself; an
        # authorization code is SPENT, so with no refresh token there is
        # nothing to renew and the refusal has to say what the user must do.
        from csc_mock import _Refused

        session = csc_signer.open_session(
            url=mock.base_url,
            credential_id="cred-1",
            client_id=mock.client_id,
            ca_bundle=mock.ca_path,
            grant=csc_signer.GRANT_AUTHORIZATION_CODE,
            code="the-code",
            redirect_uri="http://127.0.0.1:1/callback",
            verifier="the-verifier",
        )

        def always_expired(headers):
            raise _Refused(401, {"error": "invalid_token", "error_description": "expired"})

        mock._require_token = always_expired
        with pytest.raises(CscError, match="Sign in to the signing service again"):
            session.authorize_and_sign([b"0" * 32], SHA256_OID, SIGN_ALGO_RSA_PKCS1)

    def test_forgetting_a_session_drops_the_token(self, mock, tmp_dir, blank_pdf):
        _sign(blank_pdf, os.path.join(tmp_dir, "one.pdf"), mock)
        csc_signer.forget_sessions()
        _sign(blank_pdf, os.path.join(tmp_dir, "two.pdf"), mock)
        assert len(mock.token_forms) == 2


class TestListing:
    def test_lists_every_credential_with_its_usability(self, tmp_path):
        with MockCsc(
            tmp_path,
            credentials=[
                MockCredential("good"),
                MockCredential("revoked", cert_status="revoked"),
                MockCredential("pin", auth_mode="explicit"),
            ],
        ) as mock:
            rows = csc_signer.list_csc_credentials(
                csc_url=mock.base_url,
                csc_client_id=mock.client_id,
                csc_ca_bundle=mock.ca_path,
            )["credentials"]
            by_id = {r["credential_id"]: r for r in rows}
            assert by_id["good"]["usable"] is True
            assert by_id["revoked"]["usable"] is False
            assert "revoked" in by_id["revoked"]["unusable_reason"]
            # An unusable credential is REPORTED, not hidden: a user staring at
            # a short list must be able to learn why it is short.
            assert by_id["pin"]["usable"] is False
            assert "PIN" in by_id["pin"]["unusable_reason"]

    def test_a_listing_and_a_sign_share_one_authorization(
        self, mock, tmp_dir, blank_pdf
    ):
        csc_signer.list_csc_credentials(
            csc_url=mock.base_url,
            csc_client_id=mock.client_id,
            csc_ca_bundle=mock.ca_path,
        )
        _sign(blank_pdf, os.path.join(tmp_dir, "signed.pdf"), mock)
        assert len(mock.token_forms) == 1


class TestRefusals:
    def test_an_explicit_credential_refuses_before_the_document_is_touched(
        self, tmp_path, tmp_dir, blank_pdf
    ):
        with MockCsc(
            tmp_path, credentials=[MockCredential("pin", auth_mode="explicit")]
        ) as mock:
            out = os.path.join(tmp_dir, "never.pdf")
            with pytest.raises(ValueError, match="does not collect or transmit"):
                _sign(blank_pdf, out, mock, csc_credential="pin")
            assert not os.path.exists(out)

    def test_a_revoked_credential_refuses_by_name(self, tmp_path, tmp_dir, blank_pdf):
        with MockCsc(
            tmp_path, credentials=[MockCredential("dead", cert_status="revoked")]
        ) as mock:
            with pytest.raises(ValueError, match="revoked"):
                _sign(blank_pdf, os.path.join(tmp_dir, "no.pdf"), mock, csc_credential="dead")

    def test_a_disabled_key_refuses_by_name(self, tmp_path, tmp_dir, blank_pdf):
        with MockCsc(
            tmp_path, credentials=[MockCredential("off", key_status="disabled")]
        ) as mock:
            with pytest.raises(ValueError, match="unavailable"):
                _sign(blank_pdf, os.path.join(tmp_dir, "no.pdf"), mock, csc_credential="off")

    def test_a_provider_with_no_credential_named_refuses(self, mock, tmp_dir, blank_pdf):
        with pytest.raises(ValueError, match="credential to sign with"):
            sign_pdf(
                blank_pdf,
                os.path.join(tmp_dir, "no.pdf"),
                csc_url=mock.base_url,
                csc_client_id=mock.client_id,
                csc_ca_bundle=mock.ca_path,
            )

    def test_a_credential_with_no_provider_named_refuses(self, tmp_dir, blank_pdf):
        with pytest.raises(ValueError, match="web address"):
            sign_pdf(
                blank_pdf, os.path.join(tmp_dir, "no.pdf"), csc_credential="cred-1"
            )

    def test_a_missing_client_registration_refuses_by_name(
        self, mock, tmp_dir, blank_pdf
    ):
        with pytest.raises(ValueError, match="OAuth client ID"):
            sign_pdf(
                blank_pdf,
                os.path.join(tmp_dir, "no.pdf"),
                csc_url=mock.base_url,
                csc_credential="cred-1",
                csc_ca_bundle=mock.ca_path,
            )

    def test_mixing_sources_is_refused(self, mock, tmp_dir, blank_pdf):
        with pytest.raises(ValueError, match="ONE signer source"):
            _sign(blank_pdf, os.path.join(tmp_dir, "no.pdf"), mock, pfx_path="x.pfx")

    def test_no_output_survives_a_refused_sign(self, tmp_path, tmp_dir, blank_pdf):
        with MockCsc(
            tmp_path, credentials=[MockCredential("dead", cert_status="revoked")]
        ) as mock:
            out = os.path.join(tmp_dir, "never.pdf")
            with pytest.raises(ValueError):
                _sign(blank_pdf, out, mock, csc_credential="dead")
            assert not os.path.exists(out)

    def test_a_plain_http_provider_refuses_by_name(self, tmp_dir, blank_pdf):
        with pytest.raises(ValueError, match="must use HTTPS"):
            sign_pdf(
                blank_pdf,
                os.path.join(tmp_dir, "no.pdf"),
                csc_url="http://signing.example/csc/v2",
                csc_credential="cred-1",
                csc_client_id="id",
            )


class TestHeadless:
    """A run with nobody present cannot complete a browser sign-in."""

    def test_a_browser_provider_refuses_by_name_headlessly(
        self, mock, tmp_dir, blank_pdf
    ):
        out = os.path.join(tmp_dir, "no.pdf")
        with pytest.raises(ValueError, match="command-line or scheduled run"):
            _sign(
                blank_pdf, out, mock,
                csc_grant="authorization-code",
                csc_headless=True,
            )
        assert not os.path.exists(out)
        # The refusal is structural: no request was ever made.
        assert mock.token_forms == []

    def test_client_credentials_runs_headlessly(self, mock, tmp_dir, blank_pdf):
        out = os.path.join(tmp_dir, "scheduled.pdf")
        r = _sign(blank_pdf, out, mock, csc_headless=True)
        assert r["valid"] and r["intact"]

    def test_an_unknown_grant_refuses_by_name(self, mock, tmp_dir, blank_pdf):
        with pytest.raises(ValueError, match="Unknown signing-service authorization"):
            _sign(blank_pdf, os.path.join(tmp_dir, "no.pdf"), mock, csc_grant="implicit")

    def test_an_incomplete_browser_sign_in_refuses(self, mock, tmp_dir, blank_pdf):
        with pytest.raises(ValueError, match="did not complete"):
            _sign(
                blank_pdf, os.path.join(tmp_dir, "no.pdf"), mock,
                csc_grant="authorization-code",
            )

    def test_a_browser_sign_in_authorizes_with_the_code(self, mock, tmp_dir, blank_pdf):
        out = os.path.join(tmp_dir, "browser.pdf")
        r = _sign(
            blank_pdf, out, mock,
            csc_grant="authorization-code",
            csc_code="the-code",
            csc_redirect_uri="http://127.0.0.1:1/callback",
            csc_verifier="the-verifier",
        )
        assert r["valid"]
        form = mock.token_forms[-1]
        assert form["grant_type"] == "authorization_code"
        assert form["code_verifier"] == "the-verifier"


class TestSecrets:
    def test_no_secret_reaches_the_result(self, mock, tmp_dir, blank_pdf):
        out = os.path.join(tmp_dir, "signed.pdf")
        r = _sign(blank_pdf, out, mock, csc_client_secret="the-client-secret")
        rendered = repr(r)
        assert "the-client-secret" not in rendered
        assert TOKEN not in rendered

    def test_no_secret_reaches_a_refusal(self, tmp_path, tmp_dir, blank_pdf):
        with MockCsc(
            tmp_path,
            credentials=[MockCredential("dead", cert_status="revoked")],
            require_secret=True,
        ) as mock:
            with pytest.raises(ValueError) as caught:
                _sign(
                    blank_pdf, os.path.join(tmp_dir, "no.pdf"), mock,
                    csc_credential="dead",
                    csc_client_secret=mock.client_secret,
                )
            assert mock.client_secret not in str(caught.value)

    def test_a_request_can_never_carry_a_pin(self, mock, tmp_dir, blank_pdf):
        # There is no parameter for one. The signing path has no way to send
        # `authData`, which is the structural half of the refusal above.
        import inspect

        names = set(inspect.signature(sign_pdf).parameters)
        assert not [n for n in names if "auth_data" in n or n == "csc_pin"]


class TestRawSignatureSize:
    """One helper, two signers: the placeholder bound cannot drift between the
    local store source and the remote one."""

    def test_both_signers_use_the_same_helper(self):
        import types

        from engine.signature_size import raw_signature_size

        for bit_size, expected in ((256, 72), (384, 104), (521, 141)):
            fake = types.SimpleNamespace(
                signing_cert=types.SimpleNamespace(
                    public_key=types.SimpleNamespace(algorithm="ec", bit_size=bit_size)
                )
            )
            assert sigmod.StoreSigner._raw_signature_size(fake) == expected
            assert csc_signer.CscSigner._raw_signature_size(fake) == expected
            assert raw_signature_size(fake.signing_cert.public_key) == expected


class TestUnsupportedMechanisms:
    def test_an_unknown_digest_refuses_rather_than_guessing(self, mock):
        # A hash the spec's OID table does not name cannot be requested: the
        # provider signs whatever the OID says, so a guess would produce a
        # signature the CMS misdescribes.
        session = csc_signer.open_session(
            url=mock.base_url,
            credential_id="cred-1",
            client_id=mock.client_id,
            ca_bundle=mock.ca_path,
        )
        signer = csc_signer.CscSigner(session)
        import asyncio

        with pytest.raises(CscError, match="sha1 digest"):
            asyncio.run(signer.async_sign_raw(b"x", "sha1"))
