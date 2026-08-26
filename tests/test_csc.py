"""The CSC remote-signing client, against a real TLS provider on loopback.

Nothing here is stubbed at the transport: the client makes genuine HTTPS
requests to `csc_mock`, verifies the mock's CA, and the signatures it gets back
are produced by real keys and verified against the credential's own
certificate. A test that mocked `requests` would prove the client's shape and
none of its posture, and the posture — HTTPS only, no redirects, no explicit
PIN, hash-bound SAD — is what this module exists to hold.
"""

import base64
import hashlib
import json

import pytest
from asn1crypto import algos
from cryptography.hazmat.primitives import hashes as crypto_hashes
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, utils
from cryptography.x509 import load_der_x509_certificate

from csc_mock import MockCredential, MockCsc
from engine.csc import (
    HASH_OID,
    SIGN_ALGO_ECDSA,
    SIGN_ALGO_RSA_PKCS1,
    SIGN_ALGO_RSA_PSS,
    CscClient,
    CscConfig,
    CscError,
    normalize_ecdsa,
    verify_returned_signature,
)

SHA256_OID = HASH_OID["sha256"]
DIGEST = hashlib.sha256(b"the byte range of a document").digest()


def _client(mock, **overrides):
    config = CscConfig(
        base_url=mock.base_url,
        client_id=overrides.pop("client_id", mock.client_id),
        client_secret=overrides.pop("client_secret", ""),
        verify=mock.ca_path,
        **overrides,
    )
    return CscClient(config)


def _connected(mock, **overrides):
    client = _client(mock, **overrides)
    client.info()
    client.authorize_service()
    return client


@pytest.fixture
def mock(tmp_path):
    with MockCsc(tmp_path) as server:
        yield server


class TestDiscovery:
    def test_info_needs_no_authorization(self, mock):
        with _client(mock) as client:
            data = client.info()
        assert data["specs"] == "2.2.0.0"
        assert "oauth2code" in data["authType"]

    def test_refuses_a_provider_speaking_another_major_version(self, tmp_path):
        with MockCsc(tmp_path, specs="1.0.4.0") as server:
            with _client(server) as client:
                with pytest.raises(CscError, match="1.0.4.0"):
                    client.info()

    def test_refuses_plain_http_by_name(self, mock):
        config = CscConfig(base_url=mock.base_url.replace("https://", "http://"))
        with pytest.raises(CscError, match="HTTPS"):
            CscClient(config)

    def test_refuses_disabled_tls_verification(self, mock):
        config = CscConfig(base_url=mock.base_url, verify=False)
        with pytest.raises(CscError, match="verification cannot be disabled"):
            CscClient(config)

    def test_refuses_an_untrusted_certificate(self, mock, tmp_path):
        other = MockCsc(tmp_path)
        try:
            config = CscConfig(base_url=mock.base_url, verify=other.ca_path)
            with CscClient(config) as client:
                with pytest.raises(CscError, match="trusted TLS certificate"):
                    client.info()
        finally:
            other.stop()

    def test_refuses_a_cross_origin_oauth_base(self, tmp_path):
        with MockCsc(tmp_path, advertise_oauth="https://elsewhere.example/csc/v2") as server:
            with _client(server) as client:
                with pytest.raises(CscError, match="elsewhere.example"):
                    client.info()

    def test_accepts_a_same_origin_oauth_base(self, tmp_path):
        with MockCsc(tmp_path) as server:
            with _client(server, **{}) as client:
                server.advertise_oauth = server.base_url
                client.info()
                client.authorize_service()
                assert client.credentials_list() == ["cred-1"]


class TestRefusedTransport:
    def test_refuses_a_redirect_naming_both_hosts(self, tmp_path):
        with MockCsc(tmp_path, redirect_to="https://evil.example/csc/v2/info") as server:
            with _client(server) as client:
                with pytest.raises(CscError, match="evil.example"):
                    client.info()

    def test_refuses_an_oversized_response(self, tmp_path):
        with MockCsc(tmp_path, oversize=True) as server:
            with _client(server) as client:
                with pytest.raises(CscError, match="oversized"):
                    client.info()

    def test_refuses_a_body_that_is_not_csc_json(self, tmp_path):
        with MockCsc(tmp_path, malformed=True) as server:
            with _client(server) as client:
                with pytest.raises(CscError, match="not valid CSC JSON"):
                    client.info()

    def test_times_out_rather_than_hanging(self, tmp_path):
        with MockCsc(tmp_path, stall=2.0) as server:
            config = CscConfig(
                base_url=server.base_url, client_id=server.client_id,
                verify=server.ca_path, timeout=(5.0, 0.4),
            )
            with CscClient(config) as client:
                with pytest.raises(CscError, match="did not respond in time"):
                    client.info()

    def test_refuses_a_call_before_authorization(self, mock):
        with _client(mock) as client:
            client.info()
            with pytest.raises(CscError, match="not been authorized"):
                client.credentials_list()


class TestOAuth:
    def test_client_credentials_grant_yields_a_bearer_token(self, mock):
        with _connected(mock) as client:
            assert client.credentials_list() == ["cred-1"]
        assert mock.token_forms[0]["grant_type"] == "client_credentials"
        assert mock.token_forms[0]["scope"] == "service"

    def test_a_secret_is_sent_only_when_configured(self, tmp_path):
        with MockCsc(tmp_path, require_secret=True) as server:
            with _client(server) as client:
                client.info()
                with pytest.raises(CscError, match="refused the request \\(401\\)"):
                    client.authorize_service()
            with _client(server, client_secret=server.client_secret) as client:
                client.info()
                client.authorize_service()
                assert client.credentials_list()

    def test_refuses_without_a_user_supplied_client_id(self, mock):
        with _client(mock, client_id="") as client:
            client.info()
            with pytest.raises(CscError, match="OAuth client ID"):
                client.authorize_service()

    def test_authorization_code_grant_echoes_the_pkce_verifier(self, mock):
        with _client(mock) as client:
            client.info()
            client.authorize_service_with_code("the-code", "http://127.0.0.1:0/cb", "verifier")
            assert client.credentials_list()
        form = mock.token_forms[-1]
        assert form["grant_type"] == "authorization_code"
        assert form["code_verifier"] == "verifier"
        assert form["redirect_uri"] == "http://127.0.0.1:0/cb"


class TestCredentials:
    def test_parses_credential_info(self, mock):
        with _connected(mock) as client:
            credential = client.credentials_info("cred-1")
        assert credential.auth_mode == "oauth2code"
        assert credential.scal == 2
        assert credential.key_len == 2048
        assert credential.subject_dn == "CN=Mock CSC"
        assert len(credential.certificates) == 2
        assert credential.chain and credential.signing_cert == credential.certificates[0]
        assert credential.status_blocked is None

    def test_reports_an_unusable_credential_before_signing(self, tmp_path):
        credentials = [
            MockCredential("disabled-key", key_status="disabled"),
            MockCredential("revoked-cert", cert_status="revoked"),
        ]
        with MockCsc(tmp_path, credentials=credentials) as server:
            with _connected(server) as client:
                assert "unavailable" in client.credentials_info("disabled-key").status_blocked
                assert "revoked" in client.credentials_info("revoked-cert").status_blocked
                with pytest.raises(CscError, match="unavailable"):
                    client.authorize_and_sign(
                        client.credentials_info("disabled-key"),
                        [DIGEST], SHA256_OID, SIGN_ALGO_RSA_PKCS1,
                    )

    def test_refuses_an_unknown_credential(self, mock):
        with _connected(mock) as client:
            with pytest.raises(CscError, match="refused the request \\(400\\)"):
                client.credentials_info("no-such-credential")


class TestExplicitAuthorizationRefusal:
    """The app never collects or transmits a PIN or OTP."""

    def test_refuses_an_explicit_mode_credential_by_name(self, tmp_path):
        credentials = [MockCredential("pin-cred", auth_mode="explicit")]
        with MockCsc(tmp_path, credentials=credentials) as server:
            with _connected(server) as client:
                credential = client.credentials_info("pin-cred")
                with pytest.raises(CscError, match="does not collect or transmit"):
                    client.authorize_and_sign(
                        credential, [DIGEST], SHA256_OID, SIGN_ALGO_RSA_PKCS1
                    )
                with pytest.raises(CscError, match="does not collect or transmit"):
                    client.authorize_credential(credential, [DIGEST], SHA256_OID)

    def test_refuses_an_unknown_authorization_mode(self, tmp_path):
        credentials = [MockCredential("odd", auth_mode="telepathy")]
        with MockCsc(tmp_path, credentials=credentials) as server:
            with _connected(server) as client:
                with pytest.raises(CscError, match="unsupported authorization mode"):
                    client.authorize_and_sign(
                        client.credentials_info("odd"), [DIGEST], SHA256_OID,
                        SIGN_ALGO_RSA_PKCS1,
                    )

    def test_no_request_ever_carries_authdata(self, mock):
        """The mock rejects an `authData` key outright, so a green round trip is
        itself the proof that none was sent."""
        with _connected(mock) as client:
            credential = client.credentials_info("cred-1")
            client.authorize_and_sign(credential, [DIGEST], SHA256_OID, SIGN_ALGO_RSA_PKCS1)


class TestSignHash:
    def _verify_rsa(self, credential, signature, pad):
        cert = load_der_x509_certificate(credential.signing_cert)
        cert.public_key().verify(
            signature, DIGEST, pad, utils.Prehashed(crypto_hashes.SHA256())
        )

    def test_rsa_pkcs1_round_trip_verifies(self, mock):
        with _connected(mock) as client:
            credential = client.credentials_info("cred-1")
            signatures = client.authorize_and_sign(
                credential, [DIGEST], SHA256_OID, SIGN_ALGO_RSA_PKCS1
            )
        assert len(signatures) == 1
        self._verify_rsa(credential, signatures[0], padding.PKCS1v15())

    def test_rsa_pss_uses_the_declared_salt_length(self, mock):
        params = base64.b64encode(
            algos.RSASSAPSSParams(
                {
                    "hash_algorithm": {"algorithm": "sha256"},
                    "mask_gen_algorithm": {
                        "algorithm": "mgf1",
                        "parameters": {"algorithm": "sha256"},
                    },
                    "salt_length": 20,
                }
            ).dump()
        ).decode()
        with _connected(mock) as client:
            credential = client.credentials_info("cred-1")
            signatures = client.authorize_and_sign(
                credential, [DIGEST], SHA256_OID, SIGN_ALGO_RSA_PSS,
                sign_algo_params=params,
            )
        self._verify_rsa(
            credential,
            signatures[0],
            padding.PSS(mgf=padding.MGF1(crypto_hashes.SHA256()), salt_length=20),
        )

    @pytest.mark.parametrize("shape", ["raw", "der"])
    def test_ecdsa_verifies_whichever_shape_the_provider_returns(self, tmp_path, shape):
        credentials = [MockCredential("ec-cred", key_type="ec", ecdsa_shape=shape)]
        with MockCsc(tmp_path, credentials=credentials) as server:
            with _connected(server) as client:
                credential = client.credentials_info("ec-cred")
                signatures = client.authorize_and_sign(
                    credential, [DIGEST], SHA256_OID, SIGN_ALGO_ECDSA
                )
        der = normalize_ecdsa(signatures[0], credential.key_len)
        cert = load_der_x509_certificate(credential.signing_cert)
        cert.public_key().verify(
            der, DIGEST, ec.ECDSA(utils.Prehashed(crypto_hashes.SHA256()))
        )

    def test_refuses_a_malformed_ecdsa_signature(self):
        with pytest.raises(CscError, match="malformed ECDSA"):
            normalize_ecdsa(b"\x01\x02\x03", 256)

    def test_refuses_a_signature_count_that_does_not_match(self, mock, monkeypatch):
        with _connected(mock) as client:
            credential = client.credentials_info("cred-1")
            sad = client.authorize_credential(credential, [DIGEST], SHA256_OID)
            original = client._post

            def short(endpoint, payload, **kwargs):
                data = original(endpoint, payload, **kwargs)
                if endpoint.endswith("signHash"):
                    data["signatures"] = []
                return data

            monkeypatch.setattr(client, "_post", short)
            with pytest.raises(CscError, match="different number of signatures"):
                client.sign_hash(
                    credential, [DIGEST], SHA256_OID, SIGN_ALGO_RSA_PKCS1, sad=sad
                )

    def test_refuses_more_signatures_than_the_credential_allows(self, mock):
        with _connected(mock) as client:
            credential = client.credentials_info("cred-1")
            with pytest.raises(CscError, match="that many signatures"):
                client.authorize_and_sign(
                    credential, [DIGEST, DIGEST], SHA256_OID, SIGN_ALGO_RSA_PKCS1
                )


class TestScal:
    def test_scal2_authorizes_the_exact_hashes_it_then_signs(self, mock):
        with _connected(mock) as client:
            credential = client.credentials_info("cred-1")
            client.authorize_and_sign(credential, [DIGEST], SHA256_OID, SIGN_ALGO_RSA_PKCS1)
        assert mock.authorized_hashes == [[base64.b64encode(DIGEST).decode()]]
        assert mock.signed_hashes == mock.authorized_hashes

    def test_scal2_rejects_a_sad_bound_to_a_different_hash(self, mock):
        """The ordering hazard the design exists to avoid: a SAD taken before the
        byte range is known authorizes hashes that are never signed."""
        with _connected(mock) as client:
            credential = client.credentials_info("cred-1")
            stale = client.authorize_credential(
                credential, [hashlib.sha256(b"an earlier draft").digest()], SHA256_OID
            )
            with pytest.raises(CscError, match="refused the request \\(403\\)"):
                client.sign_hash(
                    credential, [DIGEST], SHA256_OID, SIGN_ALGO_RSA_PKCS1, sad=stale
                )

    def test_scal1_signs_without_hash_binding(self, tmp_path):
        credentials = [MockCredential("scal1", scal=1)]
        with MockCsc(tmp_path, credentials=credentials) as server:
            with _connected(server) as client:
                credential = client.credentials_info("scal1")
                assert credential.scal == 1
                signatures = client.authorize_and_sign(
                    credential, [DIGEST], SHA256_OID, SIGN_ALGO_RSA_PKCS1
                )
        cert = load_der_x509_certificate(credential.signing_cert)
        cert.public_key().verify(
            signatures[0], DIGEST, padding.PKCS1v15(),
            utils.Prehashed(crypto_hashes.SHA256()),
        )

    def test_sign_hash_without_a_sad_is_refused_by_the_provider(self, mock):
        with _connected(mock) as client:
            credential = client.credentials_info("cred-1")
            with pytest.raises(CscError, match="refused the request \\(401\\)"):
                client.sign_hash(credential, [DIGEST], SHA256_OID, SIGN_ALGO_RSA_PKCS1)


class TestScope:
    def test_sign_doc_is_refused_by_name(self, mock):
        with _client(mock) as client:
            with pytest.raises(CscError, match="whole document"):
                client.sign_doc()

    def test_no_client_method_accepts_a_url(self):
        """The structural reason no document-driven path can reach this client:
        every endpoint derives from the configured base URI."""
        import inspect

        from engine import csc

        public = [
            name
            for name, value in vars(csc.CscClient).items()
            if callable(value) and not name.startswith("_")
        ]
        assert "info" in public and "sign_hash" in public
        for name in public:
            parameters = inspect.signature(getattr(csc.CscClient, name)).parameters
            # `redirect_uri` is the exception that proves the rule: it is
            # echoed back to the token endpoint exactly as the browser's
            # authorization request carried it, and is never a destination this
            # client fetches.
            assert not any(
                "url" in p.lower() or "uri" in p.lower() or "host" in p.lower()
                for p in parameters
                if p not in ("self", "redirect_uri")
            ), name

    def test_credentials_never_appear_in_a_refusal_message(self, tmp_path):
        with MockCsc(tmp_path, require_secret=True, client_secret="a-secret-value") as server:
            with _client(server, client_secret="a-secret-value") as client:
                client.info()
                client.authorize_service()
                credential = client.credentials_info("cred-1")
                sad = client.authorize_credential(credential, [DIGEST], SHA256_OID)
                with pytest.raises(CscError) as caught:
                    client.sign_hash(
                        credential,
                        [hashlib.sha256(b"other").digest()],
                        SHA256_OID,
                        SIGN_ALGO_RSA_PKCS1,
                        sad=sad,
                    )
        message = str(caught.value)
        assert "a-secret-value" not in message
        assert sad not in message


class TestProviderTextIsBounded:
    """A provider writes the text in `error_description`, and it reaches a
    dialog the user reads. An unbounded remote string can push the refusal's
    own words off the surface and leave only text the provider wrote."""

    def test_a_long_error_description_is_truncated(self, tmp_path):
        from engine.csc import _MAX_PROVIDER_DETAIL

        shouty = "PLEASE ENTER YOUR PIN TO CONTINUE. " * 100
        with MockCsc(tmp_path) as server:
            with _client(server) as client:
                client.info()
                client.authorize_service()
                with pytest.raises(CscError) as caught:
                    client._decode(
                        400, json.dumps({"error_description": shouty}).encode("utf-8")
                    )
        message = str(caught.value)
        assert len(message) < _MAX_PROVIDER_DETAIL + 100
        assert message.endswith("…")

    def test_a_short_error_description_is_untouched(self, tmp_path):
        with MockCsc(tmp_path) as server:
            with _client(server) as client:
                with pytest.raises(CscError) as caught:
                    client._decode(
                        400, json.dumps({"error_description": "key locked"}).encode("utf-8")
                    )
        assert str(caught.value).endswith(": key locked")


class TestReturnedSignatureVerification:
    """`verify_returned_signature` is the guard that turns a bad provider
    response into a named refusal instead of a document that validates against
    nothing."""

    def _cert_and_key(self, mock, credential_id="cred-1"):
        credential = mock.credentials[credential_id]
        return (
            credential.cert.public_bytes(serialization.Encoding.DER),
            credential,
        )

    def test_a_genuine_pkcs1_signature_passes(self, mock):
        cert_der, credential = self._cert_and_key(mock)
        signature = credential.sign(DIGEST, SHA256_OID, SIGN_ALGO_RSA_PKCS1, None)
        verify_returned_signature(
            cert_der,
            signature,
            DIGEST,
            algorithm="rsassa_pkcs1v15",
            digest_name="sha256",
        )

    def test_a_flipped_pkcs1_signature_refuses_by_name(self, mock):
        cert_der, credential = self._cert_and_key(mock)
        signature = credential.sign(DIGEST, SHA256_OID, SIGN_ALGO_RSA_PKCS1, None)
        bad = signature[:-1] + bytes([signature[-1] ^ 0xFF])
        with pytest.raises(CscError, match="does not verify against"):
            verify_returned_signature(
                cert_der, bad, DIGEST, algorithm="rsassa_pkcs1v15", digest_name="sha256"
            )

    def test_a_signature_over_a_different_digest_refuses(self, mock):
        cert_der, credential = self._cert_and_key(mock)
        signature = credential.sign(DIGEST, SHA256_OID, SIGN_ALGO_RSA_PKCS1, None)
        with pytest.raises(CscError, match="does not verify against"):
            verify_returned_signature(
                cert_der,
                signature,
                hashlib.sha256(b"a different document").digest(),
                algorithm="rsassa_pkcs1v15",
                digest_name="sha256",
            )

    def test_pss_is_checked_under_the_declared_parameters(self, mock):
        cert_der, credential = self._cert_and_key(mock)
        params = algos.RSASSAPSSParams({
            "hash_algorithm": {"algorithm": "sha256"},
            "mask_gen_algorithm": {
                "algorithm": "mgf1",
                "parameters": {"algorithm": "sha256"},
            },
            "salt_length": 32,
        })
        signature = credential.sign(DIGEST, SHA256_OID, SIGN_ALGO_RSA_PSS, 32)
        verify_returned_signature(
            cert_der,
            signature,
            DIGEST,
            algorithm="rsassa_pss",
            digest_name="sha256",
            pss_params_der=params.dump(),
        )
        # The same signature checked under a salt length it was not made with
        # is exactly the misread `signAlgoParams` case, and it must not pass.
        wrong = algos.RSASSAPSSParams({
            "hash_algorithm": {"algorithm": "sha256"},
            "mask_gen_algorithm": {
                "algorithm": "mgf1",
                "parameters": {"algorithm": "sha256"},
            },
            "salt_length": 20,
        })
        with pytest.raises(CscError, match="does not verify against"):
            verify_returned_signature(
                cert_der,
                signature,
                DIGEST,
                algorithm="rsassa_pss",
                digest_name="sha256",
                pss_params_der=wrong.dump(),
            )

    def test_pss_without_declared_parameters_refuses(self, mock):
        cert_der, credential = self._cert_and_key(mock)
        signature = credential.sign(DIGEST, SHA256_OID, SIGN_ALGO_RSA_PSS, 32)
        with pytest.raises(CscError, match="could not be checked"):
            verify_returned_signature(
                cert_der, signature, DIGEST, algorithm="rsassa_pss", digest_name="sha256"
            )

    @pytest.mark.parametrize("shape", ["raw", "der"])
    def test_ecdsa_verifies_in_the_shape_cms_carries(self, tmp_path, shape):
        with MockCsc(
            tmp_path,
            credentials=[MockCredential("ec-1", key_type="ec", ecdsa_shape=shape)],
        ) as server:
            credential = server.credentials["ec-1"]
            cert_der = credential.cert.public_bytes(serialization.Encoding.DER)
            raw = credential.sign(DIGEST, SHA256_OID, SIGN_ALGO_ECDSA, None)
            bits = load_der_x509_certificate(cert_der).public_key().key_size
            signature = normalize_ecdsa(raw, bits)
            verify_returned_signature(
                cert_der, signature, DIGEST, algorithm="ecdsa", digest_name="sha256"
            )
            flipped = signature[:-1] + bytes([signature[-1] ^ 0xFF])
            with pytest.raises(CscError, match="does not verify against"):
                verify_returned_signature(
                    cert_der, flipped, DIGEST, algorithm="ecdsa", digest_name="sha256"
                )

    def test_garbage_of_the_right_length_refuses(self, mock):
        cert_der, credential = self._cert_and_key(mock)
        signature = credential.sign(DIGEST, SHA256_OID, SIGN_ALGO_RSA_PKCS1, None)
        with pytest.raises(CscError, match="does not verify against"):
            verify_returned_signature(
                cert_der,
                b"\x41" * len(signature),
                DIGEST,
                algorithm="rsassa_pkcs1v15",
                digest_name="sha256",
            )
