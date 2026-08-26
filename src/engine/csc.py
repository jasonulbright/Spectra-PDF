"""Cloud Signature Consortium API client — remote signing over a digest.

The protocol is CSC API **2.2.0.0** (the specification's own ``specs`` value,
§11.1). What this module provides is the minimum a signer needs: service
discovery (``info``, §11.1), OAuth 2.0 service authorization (``oauth2/token``,
§8.2.4), credential enumeration (``credentials/list`` §11.6,
``credentials/info`` §11.7), credential authorization (``credentials/authorize``
§11.8) and signing over an externally computed digest
(``signatures/signHash``, §11.13). §9 case 1 — single hash, per-signature
authorization — is the path every conforming provider SHALL support and the
path built here.

**The seam is the digest.** ``signHash`` takes base64 message digests and
returns base64 raw signatures in input order, which is exactly what a
``Signer.async_sign_raw`` implementation asks for. Nothing in this module
builds, reads or holds a PDF.

SCAL2 and the ordering problem
------------------------------
Under SCAL2 the Signature Activation Data is bound to THE HASHES BEING SIGNED
(§8.1.4), but a digest does not exist until the document's byte range is built,
which is after a signer is constructed. This module therefore takes the LAZY
option: :meth:`CscClient.authorize_and_sign` acquires the SAD at digest time,
with the hashes it is about to sign, and immediately spends it. The
alternative — a dry-run pass to obtain the digest, authorize, then sign for
real — doubles the document build and is not used. Under SCAL1 the
authorization is not hash-bound and the same call still holds, so one entry
point covers both levels.

Explicit authorization is REFUSED BY NAME
-----------------------------------------
§8.1.4 defines ``explicit`` credential authorization, where the signature
application collects a PIN or OTP in its own environment and transmits it as
``authData`` to ``credentials/authorize``. This client refuses that mode by
name and never accepts an ``authData`` value. The application's standing
credential posture is that the platform collects an authentication factor and
the application never sees it (the certificate-store source relies on Windows'
own consent UI for exactly this reason); a factor typed into this application
and forwarded to a third party is the opposite of that posture. Only
``oauth2code`` credentials are usable here, where the provider's own
authorization server collects the factor.

``signatures/signDoc`` is out of scope
--------------------------------------
That method hands the WHOLE DOCUMENT to the provider. That is a different
privacy posture from sending a digest, and it is deliberately not implemented
here rather than being smuggled in behind the same configuration.

Network posture (architecture doc 97)
-------------------------------------
Doc 97 §2 assigns the HTTP client to Rust for ``/SubmitForm``, where the
DESTINATION COMES FROM THE DOCUMENT and one audited client with an SSRF
classifier is the answer. This client is categorically different: its
destination is user-configured and a document can neither name nor influence
it. That is enforced structurally rather than by convention — **no method here
accepts a URL**. Every endpoint is derived from the base URI held in
:class:`CscConfig`, which is built from application settings, and even the
OAuth base the provider advertises in its own ``info`` response is required to
be same-origin with that configured base (a provider response is untrusted
bytes; letting it retarget the token endpoint would hand a hostile response the
user's authorization). There is therefore no path from document content to an
outbound request.

The transport rules: HTTPS only (plain HTTP refused by name — §7.3 forbids SSL
and expects TLS 1.2, and a signing credential over cleartext is
indefensible); TLS verification always on; redirects never followed, a redirect
response refused naming both hosts; no cookie jar, no environment proxies or
netrc, no credential store, a plain user agent; bounded connect and read
timeouts; a response body size cap; and no request is ever retried carrying
credentials.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence
from urllib.parse import urlsplit, urlunsplit

SPEC_VERSION = "2.2.0.0"

#: Response bodies above this are refused unread. Every response this client
#: consumes is a small JSON object; a signature for a 4096-bit key is under
#: 700 base64 bytes and a certificate chain a few tens of kilobytes.
MAX_RESPONSE_BYTES = 4 * 1024 * 1024

#: (connect, read) seconds. A remote signing service may take a human's consent
#: into account on the far side, so the read budget is not tight; neither is it
#: unbounded.
DEFAULT_TIMEOUT = (10.0, 60.0)

USER_AGENT = "SpectraPDF"

# Signature algorithm OIDs the spec's `signAlgo` field carries (RFC 8017 /
# RFC 5758). Named here so a caller maps from a CMS mechanism once.
SIGN_ALGO_RSA_PKCS1 = "1.2.840.113549.1.1.1"
SIGN_ALGO_RSA_PSS = "1.2.840.113549.1.1.10"
SIGN_ALGO_ECDSA = "1.2.840.10045.4.3.2"

# Digest OIDs for `hashAlgorithmOID` (NIST, RFC 8017 §B.1).
HASH_OID = {
    "sha256": "2.16.840.1.101.3.4.2.1",
    "sha384": "2.16.840.1.101.3.4.2.2",
    "sha512": "2.16.840.1.101.3.4.2.3",
}


class CscError(ValueError):
    """A refusal or a provider failure.

    Derives from ``ValueError`` so it leaves by the same door every other
    engine refusal leaves by: the message is the user-facing sentence and no
    credential, token, SAD or PIN is ever interpolated into it.

    ``status`` carries the provider's HTTP status when the refusal came from a
    response, and is ``None`` for a refusal this client made on its own. A
    caller distinguishes an expired access token (401) from every other failure
    by this field rather than by matching the sentence, which is display text.
    """

    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class CscConfig:
    """User-supplied provider configuration.

    ``client_id`` and ``client_secret`` are the USER'S OWN registration with
    their provider (§8.2 leaves the registration out of scope, and a
    per-provider registration is the only way to speak OAuth 2.0 to one). The
    application ships no client credential and holds no relationship with any
    provider — the user registers, the user pastes, mirroring the
    user-supplied/optional/disclosed posture the project already chose for
    other outside components.
    """

    base_url: str
    client_id: str = ""
    client_secret: str = ""
    timeout: tuple[float, float] = DEFAULT_TIMEOUT
    #: Path to a CA bundle, or ``True`` for the system/certifi trust. Never
    #: ``False`` — see :func:`_verify_argument`.
    verify: Any = True
    scope: str = "service"


@dataclass
class CscCredential:
    """The parsed shape of one ``credentials/info`` response (§11.7)."""

    credential_id: str
    auth_mode: str
    scal: int
    multisign: int
    key_algo: tuple[str, ...]
    key_len: int | None
    key_curve: str | None
    key_status: str
    cert_status: str
    subject_dn: str
    certificates: tuple[bytes, ...] = field(default_factory=tuple)

    @property
    def signing_cert(self) -> bytes:
        if not self.certificates:
            raise CscError(
                "The signing service returned no certificate for this credential."
            )
        return self.certificates[0]

    @property
    def chain(self) -> tuple[bytes, ...]:
        return self.certificates[1:]

    @property
    def status_blocked(self) -> str | None:
        """A credential the provider itself reports as unusable.

        Signing against a disabled key or a revoked certificate produces either
        a provider rejection at save time or a signature that validates against
        nothing; the state is knowable from ``credentials/info`` before any
        document is touched, so it is read there.
        """
        if self.key_status and self.key_status != "enabled":
            return (
                "The signing service reports this credential's key as unavailable "
                f"({self.key_status})."
            )
        if self.cert_status in ("revoked", "suspended", "expired"):
            return (
                "The signing service reports this credential's certificate as "
                f"{self.cert_status}."
            )
        return None


def _verify_argument(verify: Any) -> Any:
    """TLS verification is not a switch this client exposes.

    A path or ``True`` passes through; anything falsey is refused rather than
    quietly disabling certificate validation on the connection that carries a
    signing authorization.
    """
    if verify is None or verify is False or verify == "":
        raise CscError(
            "TLS certificate verification cannot be disabled for a signing service."
        )
    return verify


def _origin(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    return parts.scheme.lower(), parts.netloc.lower()


def _require_https(url: str, *, what: str) -> str:
    parts = urlsplit(url)
    if parts.scheme.lower() != "https":
        raise CscError(
            f"The {what} must use HTTPS. "
            f"Refusing to send signing credentials to a {parts.scheme or 'schemeless'} address."
        )
    if not parts.netloc:
        raise CscError(f"The {what} is not a usable web address.")
    return urlunsplit((parts.scheme.lower(), parts.netloc, parts.path.rstrip("/"), "", ""))


#: How much provider-authored text may ride along inside a refusal the user
#: reads. Enough for a real diagnostic; not enough to compose a paragraph.
_MAX_PROVIDER_DETAIL = 200


def _clip(text: str) -> str:
    """Bound a provider-supplied string before it reaches a user-facing message."""
    if len(text) <= _MAX_PROVIDER_DETAIL:
        return text
    return text[:_MAX_PROVIDER_DETAIL].rstrip() + "…"


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _unb64(value: str, *, what: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except Exception:
        raise CscError(f"The signing service returned an unreadable {what}.") from None


def normalize_ecdsa(signature: bytes, key_bit_size: int) -> bytes:
    """Return an ECDSA signature as the DER ``SEQUENCE`` CMS carries.

    The specification does not settle whether a provider returns the fixed-width
    ``r||s`` pair or the DER encoding, so the shape is decided by inspection
    rather than by configuration: a DER signature starts with ``0x30`` and
    declares its own length, and a raw pair is exactly twice the field width.
    An input that is neither is refused rather than guessed at, because a
    misread signature verifies against nothing and the failure would surface
    later as a corrupt document.
    """
    field_bytes = (key_bit_size + 7) // 8
    if len(signature) == 2 * field_bytes:
        from engine import wincert

        return wincert.ecdsa_der(signature)
    if signature[:1] == b"\x30" and len(signature) >= 2:
        length = signature[1]
        if length < 0x80:
            total = 2 + length
        else:
            count = length & 0x7F
            total = 2 + count + int.from_bytes(signature[2 : 2 + count], "big")
        if total == len(signature):
            return signature
    raise CscError("The signing service returned a malformed ECDSA signature.")


class _Uncheckable(Exception):
    """Internal: the check could not be RUN, as distinct from a signature that
    ran the check and failed it. Both refuse; only the sentence differs."""


def _hash_for(digest_name: str):
    from cryptography.hazmat.primitives import hashes as _hashes

    table = {
        "sha1": _hashes.SHA1,
        "sha224": _hashes.SHA224,
        "sha256": _hashes.SHA256,
        "sha384": _hashes.SHA384,
        "sha512": _hashes.SHA512,
        "sha3_256": _hashes.SHA3_256,
        "sha3_384": _hashes.SHA3_384,
        "sha3_512": _hashes.SHA3_512,
    }
    cls = table.get(digest_name.lower().replace("-", ""))
    if cls is None:
        raise _Uncheckable(digest_name)
    return cls()


def verify_returned_signature(
    cert_der: bytes,
    signature: bytes,
    digest: bytes,
    *,
    algorithm: str,
    digest_name: str,
    pss_params_der: bytes | None = None,
) -> None:
    """Check a provider's signature against the credential's own certificate.

    The client already holds the certificate that the CMS will name as the
    signer and the digest it just sent, so whether the returned bytes are that
    key's signature over that digest is answerable HERE, before anything is
    embedded. Without this check a provider bug, a differently-read
    ``signAlgoParams``, or a hostile response reaching the client produces a
    document that is saved, looks signed, and validates against nothing — a
    failure the user discovers later, possibly after distribution.

    The signature must already be in the shape CMS carries (ECDSA normalized to
    DER). Raises :class:`CscError` on any failure; returns nothing on success.
    Two sentences, one distinction: a check that RAN and failed, and a check
    that could not be run at all. Both refuse — an unchecked signature is not
    embedded either way.
    """
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric import ec, padding, utils
    from cryptography.x509 import load_der_x509_certificate

    try:
        try:
            public_key = load_der_x509_certificate(cert_der).public_key()
        except Exception:
            raise _Uncheckable("certificate") from None
        prehashed = utils.Prehashed(_hash_for(digest_name))
        if algorithm == "ecdsa":
            public_key.verify(signature, digest, ec.ECDSA(prehashed))
        elif algorithm == "rsassa_pkcs1v15":
            public_key.verify(signature, digest, padding.PKCS1v15(), prehashed)
        elif algorithm == "rsassa_pss":
            public_key.verify(
                signature,
                digest,
                _pss_padding(pss_params_der, _hash_for(digest_name)),
                prehashed,
            )
        else:
            raise _Uncheckable(algorithm)
    except _Uncheckable:
        raise CscError(
            "The signature the signing service returned could not be checked "
            "against this credential's own certificate. Nothing was signed."
        ) from None
    except InvalidSignature:
        raise CscError(
            "The signature the signing service returned does not verify against "
            "this credential's own certificate. Nothing was signed."
        ) from None
    except Exception:
        # A wrong-length or otherwise unusable signature reaches the same
        # verdict as one that simply does not verify: it is not this key's
        # signature over this digest.
        raise CscError(
            "The signature the signing service returned does not verify against "
            "this credential's own certificate. Nothing was signed."
        ) from None


def _pss_padding(params_der: bytes | None, hash_algorithm):
    """The PSS padding the CMS declares, never a padding assumed by default.

    Verifying under different parameters than the CMS states would accept a
    signature a validator later rejects, which is the failure this check
    exists to catch.
    """
    from cryptography.hazmat.primitives.asymmetric import padding

    if not params_der:
        raise _Uncheckable("pss parameters")
    try:
        from asn1crypto.algos import RSASSAPSSParams

        parsed = RSASSAPSSParams.load(params_der)
        salt_length = int(parsed["salt_length"].native)
        mgf_hash = _hash_for(parsed["mask_gen_algorithm"]["parameters"]["algorithm"].native)
    except _Uncheckable:
        raise
    except Exception:
        raise _Uncheckable("pss parameters") from None
    return padding.PSS(mgf=padding.MGF1(mgf_hash), salt_length=salt_length)


class CscClient:
    """One provider, one session, one configured origin.

    No method takes a URL: every endpoint is derived from the configured base
    URI, which is the structural reason no document-driven path can reach this
    client.
    """

    def __init__(self, config: CscConfig, session: Any = None):
        self._config = config
        self._base = _require_https(config.base_url, what="signing service address")
        self._origin = _origin(self._base)
        self._verify = _verify_argument(config.verify)
        self._token: str | None = None
        # Held in memory for the life of this client and never written
        # anywhere: it is a credential, and this application persists none.
        self._refresh_token: str | None = None
        self._session = session if session is not None else self._new_session()
        self._oauth_base: str | None = None

    @property
    def authorized(self) -> bool:
        return bool(self._token)

    @property
    def refreshable(self) -> bool:
        """Whether an expired access token can be replaced without the user.

        A client-credentials registration can always re-authorize; an
        authorization-code one can only do so while the provider issued a
        refresh token, because the code itself is spent.
        """
        return bool(self._refresh_token)

    # ── transport ────────────────────────────────────────────────────────

    @staticmethod
    def _new_session():
        import requests

        session = requests.Session()
        # No ambient state: no environment proxies, no netrc, no inherited CA
        # override, and a cookie jar that keeps nothing a provider tries to set.
        session.trust_env = False
        session.headers.clear()
        session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
        return session

    def close(self) -> None:
        self._token = None
        self._refresh_token = None
        try:
            self._session.close()
        except Exception:
            pass

    def __enter__(self) -> "CscClient":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _url(self, endpoint: str) -> str:
        return f"{self._base}/{endpoint.lstrip('/')}"

    def _post(
        self,
        endpoint: str,
        payload: dict | None,
        *,
        authorize: bool = True,
        url: str | None = None,
        form: dict | None = None,
    ) -> dict:
        """One request, no retry, no redirect.

        ``url`` is only ever an internally derived endpoint — either
        :meth:`_url` or the same-origin OAuth base — never a caller-supplied or
        response-supplied address.
        """
        import requests

        target = url or self._url(endpoint)
        headers = {}
        if authorize:
            if not self._token:
                raise CscError(
                    "The signing service has not been authorized yet."
                )
            headers["Authorization"] = f"Bearer {self._token}"
        try:
            if form is not None:
                response = self._session.post(
                    target,
                    data=form,
                    headers=headers,
                    timeout=self._config.timeout,
                    verify=self._verify,
                    allow_redirects=False,
                    stream=True,
                )
            else:
                response = self._session.post(
                    target,
                    json=payload if payload is not None else {},
                    headers=headers,
                    timeout=self._config.timeout,
                    verify=self._verify,
                    allow_redirects=False,
                    stream=True,
                )
        except requests.exceptions.SSLError:
            raise CscError(
                f"The signing service at {self._origin[1]} did not present a "
                "trusted TLS certificate."
            ) from None
        except requests.exceptions.Timeout:
            raise CscError(
                f"The signing service at {self._origin[1]} did not respond in time."
            ) from None
        except requests.exceptions.RequestException:
            raise CscError(
                f"The signing service at {self._origin[1]} could not be reached."
            ) from None
        with response:
            self._refuse_redirect(response)
            body = self._body(response)
        return self._decode(response.status_code, body)

    def _refuse_redirect(self, response) -> None:
        """A redirect is never followed.

        Following one would move a request that carries a bearer token — and
        sometimes a Signature Activation Data value — to a host the user never
        configured. The refusal names both hosts so the user can see where the
        provider tried to send them.
        """
        if response.status_code in (301, 302, 303, 307, 308):
            location = response.headers.get("Location", "")
            there = _origin(location)[1] or location or "an unnamed address"
            raise CscError(
                f"The signing service at {self._origin[1]} redirected to {there}. "
                "Refusing to follow a redirect while carrying signing credentials."
            )

    def _body(self, response) -> bytes:
        declared = response.headers.get("Content-Length")
        if declared is not None:
            try:
                if int(declared) > MAX_RESPONSE_BYTES:
                    raise CscError(
                        f"The signing service at {self._origin[1]} returned an "
                        "oversized response."
                    )
            except ValueError:
                pass
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_content(64 * 1024):
            total += len(chunk)
            if total > MAX_RESPONSE_BYTES:
                raise CscError(
                    f"The signing service at {self._origin[1]} returned an "
                    "oversized response."
                )
            chunks.append(chunk)
        return b"".join(chunks)

    def _decode(self, status: int, body: bytes) -> dict:
        """A provider response is untrusted bytes.

        §10 defines the error object (``error`` / ``error_description``); a
        failure that does not carry one still has to produce a sentence, and a
        body that is not a JSON object at all is a protocol failure rather than
        an empty success.

        The provider's own text reaches a dialog the user reads, so it is
        truncated to :data:`_MAX_PROVIDER_DETAIL`: an unbounded remote string
        can push the refusal's own words off the surface and leave only text
        the provider wrote.
        """
        parsed: Any = None
        if body:
            try:
                parsed = json.loads(body.decode("utf-8"))
            except Exception:
                parsed = None
        if status >= 400:
            detail = ""
            if isinstance(parsed, dict):
                detail = _clip(
                    str(
                        parsed.get("error_description") or parsed.get("error") or ""
                    ).strip()
                )
            raise CscError(
                f"The signing service refused the request ({status})"
                + (f": {detail}" if detail else "."),
                status=status,
            )
        if not isinstance(parsed, dict):
            raise CscError(
                f"The signing service at {self._origin[1]} returned a response "
                "that is not valid CSC JSON."
            )
        return parsed

    # ── §11.1 discovery ──────────────────────────────────────────────────

    def info(self) -> dict:
        """``info`` — the only method every provider SHALL implement, and the
        only one that needs no authorization, so it doubles as the probe for
        "does this address speak CSC"."""
        data = self._post("info", {"lang": "en-US"}, authorize=False)
        specs = str(data.get("specs", ""))
        if specs and not specs.startswith("2."):
            raise CscError(
                f"The signing service speaks CSC API {specs}; this application "
                f"speaks {SPEC_VERSION}."
            )
        self._oauth_base = self._resolve_oauth_base(data)
        return data

    def _resolve_oauth_base(self, data: dict) -> str:
        """Pin the advertised OAuth base to the configured origin.

        ``info`` returns one of ``oauth2`` / ``oauth2Issuer`` / ``oauth2Servers``
        (§11.1). Those values are provider-supplied, so an address outside the
        origin the user configured is refused: honouring it would let a
        response retarget where the user's authorization is sent.
        """
        advertised = data.get("oauth2")
        if not isinstance(advertised, str) or not advertised:
            return self._base
        pinned = _require_https(advertised, what="authorization service address")
        if _origin(pinned) != self._origin:
            raise CscError(
                f"The signing service at {self._origin[1]} points its authorization "
                f"at {_origin(pinned)[1]}. Refusing to authorize against a different host."
            )
        return pinned

    # ── §8.2.4 service authorization ─────────────────────────────────────

    def _oauth_url(self, endpoint: str) -> str:
        base = self._oauth_base or self._base
        return f"{base}/{endpoint}"

    def authorize_service(self) -> None:
        """Client-credentials grant (§8.2.4) for the service-level token.

        The authorization-code and refresh grants are the other two the spec
        allows; implicit SHALL NOT be used and is not implemented. The
        credentials are the user's own registration, sent once, never retried.
        """
        self._token = self._request_token(
            {
                "grant_type": "client_credentials",
                "scope": self._config.scope,
            }
        )

    def authorize_service_with_code(self, code: str, redirect_uri: str, verifier: str) -> None:
        """Authorization-code grant with PKCE (§8.2.2, RFC 7636).

        The browser half — a loopback listener per RFC 8252 — belongs outside
        the engine; what arrives here is the code the user's own browser
        returned. ``redirect_uri`` is echoed back to the token endpoint exactly
        as the authorization request carried it; it is not a destination this
        client ever fetches.
        """
        self._token = self._request_token(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            }
        )

    def refresh_service(self) -> None:
        """Refresh grant (§8.2.4, RFC 6749 §6).

        Only reachable while :attr:`refreshable`; an expired token with no
        refresh token is a fresh authorization, not a retry.
        """
        if not self._refresh_token:
            raise CscError(
                "The signing service authorization has expired and cannot be "
                "renewed without signing in again."
            )
        self._token = self._request_token(
            {"grant_type": "refresh_token", "refresh_token": self._refresh_token}
        )

    def _request_token(self, form: dict) -> str:
        if not self._config.client_id:
            raise CscError(
                "The signing service needs an OAuth client ID registered with "
                "that provider."
            )
        payload = dict(form)
        payload["client_id"] = self._config.client_id
        if self._config.client_secret:
            payload["client_secret"] = self._config.client_secret
        data = self._post(
            "oauth2/token",
            None,
            authorize=False,
            url=self._oauth_url("oauth2/token"),
            form=payload,
        )
        token = data.get("access_token")
        if not isinstance(token, str) or not token:
            raise CscError("The signing service returned no access token.")
        refresh = data.get("refresh_token")
        if isinstance(refresh, str) and refresh:
            self._refresh_token = refresh
        return token

    # ── §11.6 / §11.7 credentials ────────────────────────────────────────

    def credentials_list(self) -> list[str]:
        data = self._post("credentials/list", {})
        ids = data.get("credentialIDs")
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise CscError("The signing service returned an unreadable credential list.")
        return list(ids)

    def credentials_info(self, credential_id: str) -> CscCredential:
        data = self._post(
            "credentials/info",
            {
                "credentialID": credential_id,
                "certificates": "chain",
                "certInfo": True,
                "authInfo": True,
            },
        )
        key = data.get("key") if isinstance(data.get("key"), dict) else {}
        cert = data.get("cert") if isinstance(data.get("cert"), dict) else {}
        auth = data.get("auth") if isinstance(data.get("auth"), dict) else {}
        raw_certs = cert.get("certificates")
        certificates: tuple[bytes, ...] = ()
        if isinstance(raw_certs, list):
            certificates = tuple(
                _unb64(c, what="certificate") for c in raw_certs if isinstance(c, str)
            )
        algos = key.get("algo")
        try:
            scal = int(data.get("SCAL", 1))
        except (TypeError, ValueError):
            scal = 1
        try:
            multisign = int(data.get("multisign", 1))
        except (TypeError, ValueError):
            multisign = 1
        length = key.get("len")
        return CscCredential(
            credential_id=credential_id,
            auth_mode=str(auth.get("mode", "")),
            scal=scal,
            multisign=multisign,
            key_algo=tuple(a for a in algos if isinstance(a, str))
            if isinstance(algos, list)
            else (),
            key_len=int(length) if isinstance(length, (int, str)) and str(length).isdigit() else None,
            key_curve=key.get("curve") if isinstance(key.get("curve"), str) else None,
            key_status=str(key.get("status", "")),
            cert_status=str(cert.get("status", "")),
            subject_dn=str(cert.get("subjectDN", "")),
            certificates=certificates,
        )

    # ── §11.8 credential authorization / §11.13 signHash ─────────────────

    def check_auth_mode(self, credential: CscCredential) -> None:
        """The authorization-mode refusal, reachable before a document exists.

        The signing path applies it too; a caller that can refuse EARLIER
        should, so no output is ever half-built for a credential this client
        was never going to use.
        """
        self._refuse_explicit(credential)

    def _refuse_explicit(self, credential: CscCredential) -> None:
        if credential.auth_mode == "explicit":
            raise CscError(
                "This credential uses explicit authorization, which requires this "
                "application to collect a PIN or one-time password and send it to "
                "the signing service. This application does not collect or transmit "
                "authentication secrets. Use a credential authorized through the "
                "provider's own sign-in instead."
            )
        if credential.auth_mode and credential.auth_mode != "oauth2code":
            raise CscError(
                f"This credential uses an unsupported authorization mode "
                f"({credential.auth_mode})."
            )

    def authorize_credential(
        self,
        credential: CscCredential,
        hashes: Sequence[bytes],
        hash_algorithm_oid: str,
    ) -> str:
        """Obtain the SAD for exactly these hashes.

        Called at digest time, never earlier: under SCAL2 the SAD is bound to
        the hashes (§8.1.4) and a SAD obtained before the byte range exists
        would be bound to nothing that will be signed. ``authData`` is never
        sent — see :meth:`_refuse_explicit`.
        """
        self._refuse_explicit(credential)
        if credential.status_blocked:
            raise CscError(credential.status_blocked)
        if len(hashes) > max(credential.multisign, 1):
            raise CscError(
                "The signing service will not authorize that many signatures for "
                "this credential in one operation."
            )
        data = self._post(
            "credentials/authorize",
            {
                "credentialID": credential.credential_id,
                "numSignatures": len(hashes),
                "hashes": [_b64(h) for h in hashes],
                "hashAlgorithmOID": hash_algorithm_oid,
            },
        )
        sad = data.get("SAD")
        if not isinstance(sad, str) or not sad:
            raise CscError("The signing service returned no signature authorization.")
        return sad

    def sign_hash(
        self,
        credential: CscCredential,
        hashes: Sequence[bytes],
        hash_algorithm_oid: str,
        sign_algo: str,
        *,
        sad: str | None = None,
        sign_algo_params: str | None = None,
    ) -> list[bytes]:
        """``signatures/signHash`` (§11.13) — digests in, raw signatures out.

        Synchronous ``operationMode`` only: the async arm returns a
        ``responseID`` to poll, which is a different lifetime than a signer
        call has, and every provider supports the synchronous form.
        """
        payload: dict[str, Any] = {
            "credentialID": credential.credential_id,
            "hashes": [_b64(h) for h in hashes],
            "hashAlgorithmOID": hash_algorithm_oid,
            "signAlgo": sign_algo,
            "operationMode": "S",
        }
        if sad:
            payload["SAD"] = sad
        if sign_algo_params:
            payload["signAlgoParams"] = sign_algo_params
        data = self._post("signatures/signHash", payload)
        raw = data.get("signatures")
        if not isinstance(raw, list) or len(raw) != len(hashes):
            raise CscError(
                "The signing service returned a different number of signatures "
                "than it was asked for."
            )
        return [_unb64(s, what="signature") for s in raw]

    def authorize_and_sign(
        self,
        credential: CscCredential,
        hashes: Sequence[bytes],
        hash_algorithm_oid: str,
        sign_algo: str,
        *,
        sign_algo_params: str | None = None,
    ) -> list[bytes]:
        """The one entry point a signer calls, at digest time.

        SCAL2 authorizes against these exact hashes and spends the SAD
        immediately. SCAL1 authorizes too — the SAD is simply not hash-bound —
        so the caller does not branch on assurance level.
        """
        self._refuse_explicit(credential)
        sad = self.authorize_credential(credential, hashes, hash_algorithm_oid)
        return self.sign_hash(
            credential,
            hashes,
            hash_algorithm_oid,
            sign_algo,
            sad=sad,
            sign_algo_params=sign_algo_params,
        )

    def sign_doc(self, *args, **kwargs):
        """``signatures/signDoc`` is not implemented, by name.

        That method uploads the WHOLE DOCUMENT to the provider. Sending a
        digest reveals nothing about the document's contents; sending the
        document reveals all of it, which is a different privacy posture and
        belongs to a decision of its own rather than riding in on this
        configuration.
        """
        raise CscError(
            "Sending a whole document to a signing service is not supported. "
            "Only the document's digest is ever transmitted."
        )
