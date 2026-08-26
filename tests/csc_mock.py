"""A local Cloud Signature Consortium provider, in-process and over real TLS.

The client under test refuses plain HTTP and never disables certificate
verification, so a mock that spoke HTTP would only ever exercise the refusal.
This server therefore generates its own CA and leaf at start-up, serves HTTPS on
a loopback port, and hands the test the CA path to trust — the same shape as the
Rust loopback network tests, and the reason the suite needs no external service
and no network.

The keys are real. ``signatures/signHash`` signs the digest it is given with a
``cryptography`` private key whose certificate the mock also serves through
``credentials/info``, so a test verifies an end-to-end signature against the
credential's own certificate rather than against a recorded fixture.

Lives in tests/ and never ships.
"""

from __future__ import annotations

import base64
import datetime
import json
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa, utils
from cryptography.x509.oid import NameOID

TOKEN = "mock-service-access-token"
SAD_PREFIX = "mock-sad:"

HASH_BY_OID = {
    "2.16.840.1.101.3.4.2.1": hashes.SHA256,
    "2.16.840.1.101.3.4.2.2": hashes.SHA384,
    "2.16.840.1.101.3.4.2.3": hashes.SHA512,
}


def _self_signed(
    key,
    subject: str,
    *,
    ca: bool = False,
    issuer_key=None,
    issuer_name=None,
    signing: bool = False,
):
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject)])
    now = datetime.datetime.now(datetime.timezone.utc)
    builder = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(issuer_name or name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        .add_extension(
            x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False
        )
    )
    # OpenSSL's default verification refuses a chain whose leaf carries no
    # authority key identifier, so the issuer link is stated explicitly rather
    # than left to name matching.
    signer = issuer_key or key
    builder = builder.add_extension(
        x509.AuthorityKeyIdentifier.from_issuer_public_key(signer.public_key()),
        critical=False,
    )
    if ca:
        builder = builder.add_extension(
            x509.KeyUsage(
                digital_signature=True, content_commitment=False,
                key_encipherment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=True, crl_sign=True,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
    elif signing:
        # A document-signing certificate declares nonRepudiation
        # (contentCommitment); LTV path validation refuses a signer without it,
        # so a mock credential lacking it would only ever exercise that refusal.
        builder = builder.add_extension(
            x509.KeyUsage(
                digital_signature=True, content_commitment=True,
                key_encipherment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=False, crl_sign=False,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
    else:
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False
        )
    return builder.sign(signer, hashes.SHA256())


class MockCredential:
    """One credential the mock serves, with its real key and certificate."""

    def __init__(
        self,
        credential_id: str,
        *,
        key_type: str = "rsa",
        auth_mode: str = "oauth2code",
        scal: int = 2,
        multisign: int = 1,
        key_status: str = "enabled",
        cert_status: str = "valid",
        ecdsa_shape: str = "raw",
    ):
        self.credential_id = credential_id
        self.key_type = key_type
        self.auth_mode = auth_mode
        self.scal = scal
        self.multisign = multisign
        self.key_status = key_status
        self.cert_status = cert_status
        #: "raw" (fixed-width r||s) or "der" — the spec settles neither, so the
        #: client detects the shape and both are exercised.
        self.ecdsa_shape = ecdsa_shape
        if key_type == "rsa":
            self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        else:
            self.key = ec.generate_private_key(ec.SECP256R1())
        self.cert = _self_signed(self.key, f"Mock CSC {credential_id}", signing=True)
        self.ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.ca_cert = _self_signed(self.ca_key, f"Mock CSC issuer {credential_id}", ca=True)

    def info(self) -> dict:
        chain = [self.cert, self.ca_cert]
        key = {"status": self.key_status, "algo": [], "len": 0}
        if self.key_type == "rsa":
            key["algo"] = ["1.2.840.113549.1.1.1", "1.2.840.113549.1.1.10"]
            key["len"] = self.key.key_size
        else:
            key["algo"] = ["1.2.840.10045.4.3.2"]
            key["len"] = self.key.curve.key_size
            key["curve"] = "1.2.840.10045.3.1.7"
        return {
            "key": key,
            "cert": {
                "status": self.cert_status,
                "certificates": [
                    base64.b64encode(c.public_bytes(serialization.Encoding.DER)).decode()
                    for c in chain
                ],
                "subjectDN": "CN=Mock CSC",
            },
            "auth": {"mode": self.auth_mode, "expression": "PIN"},
            "SCAL": str(self.scal),
            "multisign": self.multisign,
        }

    def sign(self, digest: bytes, oid: str, sign_algo: str, salt_len: int | None) -> bytes:
        algorithm = HASH_BY_OID[oid]()
        prehashed = utils.Prehashed(algorithm)
        if self.key_type == "rsa":
            if sign_algo == "1.2.840.113549.1.1.10":
                pad = padding.PSS(
                    mgf=padding.MGF1(algorithm),
                    salt_length=salt_len
                    if salt_len is not None
                    else algorithm.digest_size,
                )
            else:
                pad = padding.PKCS1v15()
            return self.key.sign(digest, pad, prehashed)
        der = self.key.sign(digest, ec.ECDSA(prehashed))
        if self.ecdsa_shape == "der":
            return der
        from cryptography.hazmat.primitives.asymmetric.utils import (
            decode_dss_signature,
        )

        r, s = decode_dss_signature(der)
        width = (self.key.curve.key_size + 7) // 8
        return r.to_bytes(width, "big") + s.to_bytes(width, "big")


class MockCsc:
    """The server. Start it, read :attr:`base_url` and :attr:`ca_path`, stop it."""

    def __init__(self, tmp_path, credentials=None, **behaviour):
        self.credentials = {c.credential_id: c for c in (credentials or [MockCredential("cred-1")])}
        #: Behaviour switches the refusal tests drive.
        self.redirect_to: str | None = behaviour.get("redirect_to")
        self.oversize: bool = behaviour.get("oversize", False)
        self.malformed: bool = behaviour.get("malformed", False)
        self.stall: float = behaviour.get("stall", 0.0)
        self.specs: str = behaviour.get("specs", "2.2.0.0")
        self.advertise_oauth: str | None = behaviour.get("advertise_oauth")
        self.require_secret: bool = behaviour.get("require_secret", False)
        #: Return a signature of the RIGHT LENGTH that is not a signature. A
        #: count check cannot see this; only verifying against the credential's
        #: own certificate can.
        self.corrupt_signature: bool = behaviour.get("corrupt_signature", False)
        self.client_id: str = behaviour.get("client_id", "mock-client")
        self.client_secret: str = behaviour.get("client_secret", "mock-secret")
        #: Every hash the mock was asked to authorize, then to sign — the SCAL2
        #: binding assertion reads these.
        self.authorized_hashes: list[list[str]] = []
        self.signed_hashes: list[list[str]] = []
        self.token_forms: list[dict] = []

        self._tmp = tmp_path
        self._build_tls()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._server.socket = self._context.wrap_socket(self._server.socket, server_side=True)
        self.port = self._server.server_address[1]
        self.base_url = f"https://localhost:{self.port}/csc/v2"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def _build_tls(self):
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ca_cert = _self_signed(ca_key, "Mock CSC test CA", ca=True)
        leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        leaf_cert = _self_signed(
            leaf_key,
            "localhost",
            issuer_key=ca_key,
            issuer_name=ca_cert.subject,
        )
        self.ca_path = str(self._tmp / "mock-csc-ca.pem")
        with open(self.ca_path, "wb") as handle:
            handle.write(ca_cert.public_bytes(serialization.Encoding.PEM))
        chain = str(self._tmp / "mock-csc-leaf.pem")
        with open(chain, "wb") as handle:
            handle.write(leaf_cert.public_bytes(serialization.Encoding.PEM))
            handle.write(
                leaf_key.private_bytes(
                    serialization.Encoding.PEM,
                    serialization.PrivateFormat.PKCS8,
                    serialization.NoEncryption(),
                )
            )
        self._context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self._context.load_cert_chain(chain)

    def stop(self):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.stop()

    # ── request handling ─────────────────────────────────────────────────

    def _handler(mock):  # noqa: N805 — the closure IS the handler's access to the mock
        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_POST(self):  # noqa: N802
                import time

                path = urlsplit(self.path).path
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                if mock.stall:
                    time.sleep(mock.stall)
                if mock.redirect_to and path.endswith("/csc/v2/info"):
                    self.send_response(302)
                    self.send_header("Location", mock.redirect_to)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                try:
                    status, payload = mock.route(path, body, self.headers)
                except _Refused as refusal:
                    status, payload = refusal.status, refusal.payload
                if mock.malformed:
                    raw = b"<html>not json at all</html>"
                elif mock.oversize:
                    from engine.csc import MAX_RESPONSE_BYTES

                    raw = b'{"pad":"' + b"A" * (MAX_RESPONSE_BYTES + 1024) + b'"}'
                else:
                    raw = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST

        return Handler

    def route(self, path: str, body: bytes, headers) -> tuple[int, dict]:
        if path.endswith("/oauth2/token"):
            return self._token(body)
        # Discovery is `/csc/v2/info`; `credentials/info` also ends in "/info",
        # so the discovery match is anchored on the full path.
        if path.endswith("/csc/v2/info"):
            return 200, self._info()
        self._require_token(headers)
        payload = json.loads(body or b"{}")
        if path.endswith("/credentials/list"):
            return 200, {"credentialIDs": list(self.credentials)}
        if path.endswith("/credentials/info"):
            return 200, self._credential(payload).info()
        if path.endswith("/credentials/authorize"):
            return self._authorize(payload)
        if path.endswith("/signatures/signHash"):
            return self._sign(payload)
        raise _Refused(404, {"error": "invalid_request", "error_description": "no such method"})

    def _info(self) -> dict:
        data = {
            "specs": self.specs,
            "name": "Mock CSC",
            "region": "XX",
            "lang": "en-US",
            "authType": ["oauth2code", "oauth2client"],
            "methods": [
                "info",
                "credentials/list",
                "credentials/info",
                "credentials/authorize",
                "signatures/signHash",
            ],
        }
        if self.advertise_oauth:
            data["oauth2"] = self.advertise_oauth
        return data

    def _token(self, body: bytes) -> tuple[int, dict]:
        form = {k: v[0] for k, v in parse_qs(body.decode("utf-8")).items()}
        self.token_forms.append(form)
        if form.get("client_id") != self.client_id:
            raise _Refused(401, {"error": "invalid_client", "error_description": "unknown client"})
        if self.require_secret and form.get("client_secret") != self.client_secret:
            raise _Refused(401, {"error": "invalid_client", "error_description": "bad secret"})
        return 200, {"access_token": TOKEN, "token_type": "Bearer", "expires_in": 3600}

    def _require_token(self, headers):
        if headers.get("Authorization") != f"Bearer {TOKEN}":
            raise _Refused(401, {"error": "invalid_token", "error_description": "bad token"})

    def _credential(self, payload) -> MockCredential:
        credential = self.credentials.get(payload.get("credentialID"))
        if credential is None:
            raise _Refused(
                400, {"error": "invalid_request", "error_description": "no such credential"}
            )
        return credential

    def _authorize(self, payload) -> tuple[int, dict]:
        credential = self._credential(payload)
        if "authData" in payload:
            raise _Refused(
                400,
                {
                    "error": "invalid_request",
                    "error_description": "authData sent to an oauth2code credential",
                },
            )
        hashes_in = payload.get("hashes") or []
        if payload.get("numSignatures") != len(hashes_in):
            raise _Refused(
                400,
                {"error": "invalid_request", "error_description": "numSignatures mismatch"},
            )
        if len(hashes_in) > credential.multisign:
            raise _Refused(
                400, {"error": "invalid_request", "error_description": "multisign exceeded"}
            )
        self.authorized_hashes.append(list(hashes_in))
        # SCAL2 binds the SAD to these exact hashes; SCAL1 does not, and the
        # difference is exactly what the signHash check below enforces.
        bound = "|".join(hashes_in) if credential.scal == 2 else ""
        return 200, {"SAD": SAD_PREFIX + bound, "expiresIn": 300}

    def _sign(self, payload) -> tuple[int, dict]:
        credential = self._credential(payload)
        hashes_in = payload.get("hashes") or []
        sad = payload.get("SAD") or ""
        if not sad.startswith(SAD_PREFIX):
            raise _Refused(401, {"error": "invalid_request", "error_description": "missing SAD"})
        if credential.scal == 2 and sad[len(SAD_PREFIX) :] != "|".join(hashes_in):
            raise _Refused(
                403,
                {
                    "error": "invalid_request",
                    "error_description": "SAD does not authorize these hashes",
                },
            )
        oid = payload.get("hashAlgorithmOID")
        if oid not in HASH_BY_OID:
            raise _Refused(
                400, {"error": "invalid_request", "error_description": "unknown hash algorithm"}
            )
        salt = _pss_salt_length(payload.get("signAlgoParams"))
        self.signed_hashes.append(list(hashes_in))
        raw = [
            credential.sign(base64.b64decode(h), oid, payload.get("signAlgo"), salt)
            for h in hashes_in
        ]
        if self.corrupt_signature:
            raw = [_corrupt(s) for s in raw]
        return 200, {"signatures": [base64.b64encode(s).decode() for s in raw]}


def _corrupt(signature: bytes) -> bytes:
    """The same signature with its last byte flipped.

    Length, and for a DER ECDSA signature the encoding, both survive — so
    nothing short of verifying against the credential's public key notices.
    """
    return signature[:-1] + bytes([signature[-1] ^ 0xFF])


def _pss_salt_length(params: str | None) -> int | None:
    """``signAlgoParams`` is the base64 DER AlgorithmIdentifier parameters
    (§11.13), so for RSASSA-PSS it is an ``RSASSA-PSS-params`` structure and the
    salt length is read out of it rather than passed as a bare number. A real
    provider reads it exactly this way, and a client that declared one salt and
    signed with another would produce a signature verifying against nothing."""
    if not params:
        return None
    from asn1crypto import algos

    parsed = algos.RSASSAPSSParams.load(base64.b64decode(params))
    return int(parsed["salt_length"].native)


class _Refused(Exception):
    def __init__(self, status: int, payload: dict):
        super().__init__(payload.get("error_description", ""))
        self.status = status
        self.payload = payload
