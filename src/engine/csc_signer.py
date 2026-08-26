"""The remote-signing signer source: pyHanko above, ``engine.csc`` below.

``engine.csc`` stops at the digest deliberately — it builds no PDF and reads
none. This module is the other half: it turns a CSC credential into a
:class:`pyhanko.sign.signers.Signer`, so every placement the local sources
already support (visible stamp, existing-field fill, in-place, PAdES B-B
through B-LTA, TSA, LTV, certification, field locks) reaches a remote key
through the ONE seam pyHanko offers, ``async_sign_raw``. There is no
signing path of this source's own, which is why there is nothing for a
placement to miss.

What the request carries, and what it never carries
---------------------------------------------------
A sign request names a PROVIDER (its address and the user's own OAuth client
registration) and a CREDENTIAL id. It never carries a PIN or a one-time
password: ``engine.csc`` refuses ``explicit`` credential authorization by name,
and this module adds no way around that. The access token lives in memory for
as long as this process does, in :data:`_SESSIONS`, and is written nowhere.

Headless posture
----------------
A provider registered for the authorization-code grant needs a browser and a
person; a CLI or scheduled run has neither. Such a provider is REFUSED BY NAME
in a headless request rather than hanging on a dance nobody can complete, and
the client-credentials grant — which needs no human — runs headlessly and is
the shape a scheduled signing run is expected to use.

Token expiry mid-sign
---------------------
A signature can be built long after a token was issued, and pyHanko may ask for
the signature more than once in one run (a document timestamp is a second
signing operation). An expired token surfaces as a 401 from the provider, which
:class:`~engine.csc.CscError` reports structurally rather than in its sentence,
so :meth:`CscSession.authorize_and_sign` renews ONCE and repeats the call. That
is not the retry ``engine.csc`` forbids: the forbidden one replays a request
with the same spent credential, and this one is a new request under a new
token, made only after a renewal the provider accepted.
"""

from __future__ import annotations

import base64
import hashlib
from typing import Any

from pyhanko.sign import signers
from pyhanko_certvalidator.registry import SimpleCertificateStore

from engine.csc import (
    HASH_OID,
    SIGN_ALGO_ECDSA,
    SIGN_ALGO_RSA_PKCS1,
    SIGN_ALGO_RSA_PSS,
    CscClient,
    CscConfig,
    CscCredential,
    CscError,
    normalize_ecdsa,
    verify_returned_signature,
)
from engine.signature_size import raw_signature_size

#: pyHanko's own name for the CMS signature algorithm -> the OID the spec's
#: ``signAlgo`` field carries. A mechanism this table does not name is refused
#: rather than signed under a guess: the provider signs whatever the OID says,
#: and a mismatch with what the CMS declares verifies against nothing.
SIGN_ALGO_BY_MECHANISM = {
    "rsassa_pkcs1v15": SIGN_ALGO_RSA_PKCS1,
    "rsassa_pss": SIGN_ALGO_RSA_PSS,
    "ecdsa": SIGN_ALGO_ECDSA,
}

#: Grant names a provider configuration may carry. The wire values are stable
#: names, never display text.
GRANT_CLIENT_CREDENTIALS = "client-credentials"
GRANT_AUTHORIZATION_CODE = "authorization-code"
GRANTS = (GRANT_CLIENT_CREDENTIALS, GRANT_AUTHORIZATION_CODE)


class CscSigner(signers.Signer):
    """A signer whose private key lives at a signing service.

    Symmetrical with ``StoreSigner``: pyHanko builds the PDF object, the byte
    range and the signed attributes and then asks for the raw signature over
    those attribute bytes. Here the digest of those bytes travels to the
    provider and the signature travels back — the document itself never does.

    The mechanism is pyHanko's, not a fixed choice: an RSA key signs PKCS#1
    v1.5 or PSS as the CMS declares, and an EC key signs ECDSA. PSS parameters
    are DECLARED to the provider rather than assumed by it — ``signAlgoParams``
    carries the exact ``RSASSA-PSS-params`` the CMS states, so the salt length
    the provider signs under is the salt length the document claims. A
    provider that salted differently would return a signature verifying against
    nothing while every other field still read correct.

    ``dry_run`` sizes the placeholder and makes NO request: it would otherwise
    spend a signature authorization on bytes that are discarded, and under
    SCAL2 that authorization is bound to a digest that will never be signed.
    """

    def __init__(self, session: "CscSession", **kwargs):
        from asn1crypto import x509 as asn1_x509

        credential = session.credential
        cert = asn1_x509.Certificate.load(credential.signing_cert)
        registry = SimpleCertificateStore()
        registry.register_multiple(
            [asn1_x509.Certificate.load(der) for der in credential.chain]
        )
        super().__init__(signing_cert=cert, cert_registry=registry, **kwargs)
        self._session = session

    def _raw_signature_size(self) -> int:
        return raw_signature_size(self.signing_cert.public_key)

    async def async_sign_raw(
        self, data: bytes, digest_algorithm: str, dry_run=False
    ) -> bytes:
        if dry_run:
            return self._raw_signature_size() * b"\0"
        mechanism = self.get_signature_mechanism_for_digest(digest_algorithm)
        algorithm = mechanism.signature_algo
        sign_algo = SIGN_ALGO_BY_MECHANISM.get(algorithm)
        if sign_algo is None:
            raise CscError(
                f"A {algorithm} signature cannot be requested from a signing service."
            )
        name = digest_algorithm.lower().replace("-", "")
        hash_oid = HASH_OID.get(name)
        if hash_oid is None:
            raise CscError(
                f"A signing service cannot be asked for a {digest_algorithm} digest."
            )
        params_der = None
        params = None
        if algorithm == "rsassa_pss":
            params_der = mechanism["parameters"].dump()
            params = base64.b64encode(params_der).decode("ascii")
        digest = hashlib.new(name, data).digest()
        raw = self._session.authorize_and_sign(
            [digest], hash_oid, sign_algo, sign_algo_params=params
        )[0]
        signature = (
            normalize_ecdsa(raw, self.signing_cert.public_key.bit_size)
            if algorithm == "ecdsa"
            else raw
        )
        # The returned bytes are checked against the credential's own
        # certificate before they can be embedded: a provider that signs under
        # different parameters, or a response that is not the provider's,
        # otherwise produces a document that looks signed and validates
        # against nothing.
        verify_returned_signature(
            self.signing_cert.dump(),
            signature,
            digest,
            algorithm=algorithm,
            digest_name=name,
            pss_params_der=params_der,
        )
        return signature


def _reauthorize(client: CscClient, grant: str) -> None:
    """Renew the access token without the user.

    The refresh grant is preferred wherever the provider issued a refresh
    token. Failing that, only a client-credentials registration can
    re-authorize on its own — an authorization code is SPENT, so an expired
    authorization-code session ends in a refusal that says what the user has to
    do rather than in a silent failure.
    """
    if client.refreshable:
        client.refresh_service()
        return
    if grant == GRANT_CLIENT_CREDENTIALS:
        client.authorize_service()
        return
    raise CscError(
        "The signing service authorization expired. Sign in to the signing "
        "service again and repeat the signature."
    )


def renew_once(client: CscClient, grant: str, call):
    """Run one authorized call, renewing the token if it has expired.

    Every authorized call goes through here, not only the signing one: a token
    held across requests can go stale before any of them, and reading the
    credential is the first call a sign request makes.

    This is not the retry ``engine.csc`` forbids. The forbidden one replays a
    request carrying the same spent credential; this one is a new request under
    a token the provider has just issued, and it happens at most once — a
    second 401 leaves as a refusal.
    """
    try:
        return call()
    except CscError as first:
        if first.status != 401:
            raise
        _reauthorize(client, grant)
        return call()


class CscSession:
    """One authorized client plus the credential a request named.

    Holds the access token for the life of the engine process and renews it
    once on an expiry the provider reports. Nothing here is written to disk.
    """

    def __init__(self, client: CscClient, credential: CscCredential, grant: str):
        self.client = client
        self.credential = credential
        self.grant = grant

    def authorize_and_sign(
        self,
        hashes,
        hash_algorithm_oid: str,
        sign_algo: str,
        *,
        sign_algo_params: str | None = None,
    ):
        return renew_once(
            self.client,
            self.grant,
            lambda: self.client.authorize_and_sign(
                self.credential,
                hashes,
                hash_algorithm_oid,
                sign_algo,
                sign_algo_params=sign_algo_params,
            ),
        )


#: One live client per EFFECTIVE CONFIGURATION, for the life of this process.
#: The engine is a subprocess of one running application, so "the session" is
#: this dictionary — a token outlives one sign request and no request beyond it.
#:
#: The key covers every field that changes what the client does or whom it
#: trusts, the CA bundle included. Keying on (address, client id) alone let a
#: user tighten TLS trust — public roots to a private bundle — and be served
#: the client built under the old trust, with the UI reporting a setting that
#: had silently not applied. A changed scope or secret went the same way.
_SESSIONS: dict[tuple, CscClient] = {}


def _session_key(config: CscConfig, grant: str) -> tuple:
    """The identity of a reusable session: the whole effective configuration.

    The secret is keyed by digest so no secret is held as a dictionary key.
    """
    secret = config.client_secret or ""
    digest = hashlib.sha256(secret.encode("utf-8")).hexdigest() if secret else ""
    return (
        config.base_url,
        config.client_id,
        config.scope,
        repr(config.verify),
        config.timeout,
        grant,
        digest,
    )


def forget_sessions() -> None:
    """Drop every held token. Called when the application signs out; a test
    calls it so one case's token cannot authorize the next one's request."""
    for client in list(_SESSIONS.values()):
        client.close()
    _SESSIONS.clear()


def _config(
    url: str,
    client_id: str,
    client_secret: str,
    scope: str,
    ca_bundle: str | None,
) -> CscConfig:
    if not url:
        raise CscError("A signing service needs its web address.")
    if not client_id:
        raise CscError(
            "A signing service needs the OAuth client ID you registered with "
            "that provider."
        )
    return CscConfig(
        base_url=url,
        client_id=client_id,
        client_secret=client_secret or "",
        scope=scope or "service",
        verify=ca_bundle if ca_bundle else True,
    )


def connect(
    *,
    url: str,
    client_id: str,
    client_secret: str = "",
    scope: str = "service",
    ca_bundle: str | None = None,
    grant: str = GRANT_CLIENT_CREDENTIALS,
    code: str = "",
    redirect_uri: str = "",
    verifier: str = "",
    headless: bool = False,
    reuse: bool = True,
) -> CscClient:
    """An authorized client for this provider.

    A cached client is reused while it still holds a token, so listing
    credentials and then signing does not authorize twice. A request that
    carries a fresh authorization code always authorizes: the code is the
    user's new sign-in and reusing a stale token would discard it.

    Reuse is keyed on the whole effective configuration (see
    :func:`_session_key`), so any change to the address, registration, scope,
    secret or CA bundle authorizes afresh under the new settings and retires
    the session held under the old ones.
    """
    if grant not in GRANTS:
        raise CscError(f"Unknown signing-service authorization ({grant}).")
    if headless and grant == GRANT_AUTHORIZATION_CODE:
        raise CscError(
            "This signing service signs in through a browser, which a "
            "command-line or scheduled run cannot do. Register the provider "
            "for the client-credentials grant to sign without a person present."
        )
    config = _config(url, client_id, client_secret, scope, ca_bundle)
    key = _session_key(config, grant)
    if reuse and not code:
        cached = _SESSIONS.get(key)
        if cached is not None and cached.authorized:
            return cached
    # Retire every session for this address and registration, not just the one
    # under this exact key: a re-connect after a settings change must not leave
    # a live token behind that was issued under the settings the user replaced.
    for stale in [k for k in _SESSIONS if k[0] == config.base_url and k[1] == config.client_id]:
        _SESSIONS.pop(stale).close()
    client = CscClient(config)
    try:
        client.info()
        if grant == GRANT_AUTHORIZATION_CODE:
            if not (code and redirect_uri and verifier):
                raise CscError(
                    "Signing in to this signing service did not complete. "
                    "Sign in again."
                )
            client.authorize_service_with_code(code, redirect_uri, verifier)
        else:
            client.authorize_service()
    except Exception:
        client.close()
        raise
    _SESSIONS[key] = client
    return client


def list_csc_credentials(
    csc_url: str = "",
    csc_client_id: str = "",
    csc_client_secret: str = "",
    csc_scope: str = "service",
    csc_ca_bundle: str | None = None,
    csc_grant: str = GRANT_CLIENT_CREDENTIALS,
    csc_code: str = "",
    csc_redirect_uri: str = "",
    csc_verifier: str = "",
    csc_headless: bool = False,
) -> dict:
    """Enumerate what this provider will let this user sign with.

    Every credential is reported, usable or not, with the reason it cannot be
    used where there is one. A surface that hid the unusable ones would leave a
    user staring at an empty list with no way to learn why — a revoked
    certificate and a provider holding nothing at all are different answers.
    """
    client = connect(
        url=csc_url,
        client_id=csc_client_id,
        client_secret=csc_client_secret,
        scope=csc_scope,
        ca_bundle=csc_ca_bundle,
        grant=csc_grant,
        code=csc_code,
        redirect_uri=csc_redirect_uri,
        verifier=csc_verifier,
        headless=csc_headless,
    )
    rows = []
    for credential_id in renew_once(client, csc_grant, client.credentials_list):
        info = renew_once(
            client, csc_grant, lambda cid=credential_id: client.credentials_info(cid)
        )
        blocked = info.status_blocked
        if blocked is None and info.auth_mode == "explicit":
            blocked = (
                "This credential is authorized with a PIN or one-time password "
                "typed into the signing application, which this application "
                "does not collect."
            )
        elif blocked is None and info.auth_mode and info.auth_mode != "oauth2code":
            blocked = (
                f"This credential uses an unsupported authorization mode "
                f"({info.auth_mode})."
            )
        rows.append(
            {
                "credential_id": credential_id,
                "subject": info.subject_dn,
                "auth_mode": info.auth_mode,
                "scal": info.scal,
                "multisign": info.multisign,
                "key_algorithms": list(info.key_algo),
                "key_length": info.key_len,
                "key_curve": info.key_curve,
                "key_status": info.key_status,
                "certificate_status": info.cert_status,
                "usable": blocked is None,
                "unusable_reason": blocked,
            }
        )
    return {"credentials": rows}


def open_session(
    *,
    url: str,
    credential_id: str,
    client_id: str,
    client_secret: str = "",
    scope: str = "service",
    ca_bundle: str | None = None,
    grant: str = GRANT_CLIENT_CREDENTIALS,
    code: str = "",
    redirect_uri: str = "",
    verifier: str = "",
    headless: bool = False,
) -> CscSession:
    """Authorize, read the credential, and refuse an unusable one BEFORE the
    document is touched.

    A credential the provider itself reports as disabled or revoked is knowable
    here, and refusing at this point means no partially built output ever
    exists — the same posture the store source takes when a thumbprint names
    nothing."""
    if not credential_id:
        raise CscError("A signing service needs the credential to sign with.")
    client = connect(
        url=url,
        client_id=client_id,
        client_secret=client_secret,
        scope=scope,
        ca_bundle=ca_bundle,
        grant=grant,
        code=code,
        redirect_uri=redirect_uri,
        verifier=verifier,
        headless=headless,
    )
    credential = renew_once(
        client, grant, lambda: client.credentials_info(credential_id)
    )
    blocked = credential.status_blocked
    if blocked:
        raise CscError(blocked)
    # Refuses `explicit` by name, and any mode this client does not speak.
    client.check_auth_mode(credential)
    if not credential.certificates:
        raise CscError(
            "The signing service returned no certificate for this credential."
        )
    return CscSession(client, credential, grant)
