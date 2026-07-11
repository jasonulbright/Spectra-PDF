"""Digital-signature VERIFICATION (read-only).

Reports, per embedded signature: whether it's cryptographically valid, whether
the bytes it covers are intact, whether the document was modified after signing
(coverage level), the signer's certificate identity, and the claimed signing
time.

Scope — deliberately "single-cert" verification (roadmap § C, first slice):
we validate the signature's cryptography and the document's integrity, but do
NOT validate the signer's certificate against any trust store, nor check
revocation, nor timestamp/LTV. So ``trusted`` is reported but is
DETERMINISTICALLY False — the UI must present a valid result as
"cryptographically valid, signer identity NOT verified against a trusted
authority", never as fully trusted. Signing (applying signatures) is a
separate deferred slice. See docs/architecture/10-phase2h-signatures.md.

CRITICAL — trust context: we pass an EXPLICIT EMPTY trust context
(``ValidationContext(trust_roots=[])``), NOT ``signer_validation_context=None``.
Passing None does NOT mean "no anchor": pyHanko's SimpleTrustManager.build
treats ``trust_roots is None`` as "load the operating system's certificate
store" (oscrypto `trust_list.get_list()` — ~dozens of real CA roots on
Windows). Under None, a PDF signed by any commercial CA (DigiCert, GlobalSign,
…) would come back ``trusted=True``, machine-dependent, silently contradicting
this slice's whole promise. An explicit empty ``trust_roots=[]`` (a non-None
value, so no OS fallback) makes ``trusted`` deterministically False regardless
of the host's trust store. Regression-tested by monkeypatching the OS store to
contain the signer cert and asserting ``trusted`` stays False.

Uses pyHanko (MIT) — the ByteRange / CMS / incremental-update handling is
exactly the security-critical plumbing not to hand-roll.
"""

import logging

# pyHanko logs the path-building failure as a WARNING-with-traceback whenever a
# signature doesn't chain to a trust anchor — which is BY DESIGN here (we
# provide no anchors). Drop that expected noise WITHOUT blanketing the whole
# package: scope to the one submodule that emits it, and only at WARNING —
# genuine ERROR-level diagnostics (malformed CMS, processing errors) still log.
logging.getLogger("pyhanko.sign.validation.generic_cms").setLevel(logging.ERROR)

from pathlib import Path

from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import fields, signers
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko import stamp
from pyhanko.keys import load_certs_from_pemder_data, load_private_key_from_pemder_data
from pyhanko_certvalidator import ValidationContext
from pyhanko_certvalidator.registry import SimpleCertificateStore


# An explicit, empty, offline trust context. Empty trust_roots (NOT None) means
# no anchor and no OS-store fallback, so trusted is deterministically False;
# allow_fetching=False keeps validation offline (no CRL/OCSP network) — moot
# with no anchor, but explicit for determinism in enterprise/air-gapped hosts.
def _empty_trust_context() -> ValidationContext:
    return ValidationContext(trust_roots=[], allow_fetching=False)


def _signer_name(status) -> str | None:
    cert = getattr(status, "signing_cert", None)
    if cert is None:
        return None
    try:
        cn = cert.subject.native.get("common_name")
        if cn:
            return cn
        return cert.subject.human_friendly
    except Exception:
        return None


def _verify_one(embedded) -> dict:
    field = getattr(embedded, "field_name", None)
    ts = getattr(embedded, "self_reported_timestamp", None)
    try:
        # Explicit empty trust context — see the module docstring for why NOT
        # None (which would consult the OS certificate store).
        status = validate_pdf_signature(
            embedded, signer_validation_context=_empty_trust_context()
        )
    except Exception as exc:
        # A signature we can't validate at all (malformed CMS, unsupported
        # algorithm) is reported as failed, not allowed to sink the whole
        # report.
        return {
            "field": field,
            "signer": None,
            "valid": False,
            "intact": False,
            "trusted": False,
            "coverage": "UNKNOWN",
            "covers_whole_document": False,
            "modified_after_signing": True,
            "digest_algorithm": None,
            "signing_time": ts.isoformat() if ts is not None else None,
            "error": str(exc),
        }
    coverage = status.coverage.name if status.coverage is not None else "UNKNOWN"
    return {
        "field": field,
        "signer": _signer_name(status),
        # CMS signature verifies against the signer's key.
        "valid": bool(status.valid),
        # The bytes the signature covers are unmodified (document integrity).
        "intact": bool(status.intact),
        # Deterministically false: we validate against an EXPLICIT empty trust
        # context, so no certificate ever chains to an anchor. Reported (not
        # hidden) so the UI can state the identity caveat honestly.
        "trusted": bool(status.trusted),
        "coverage": coverage,
        "covers_whole_document": coverage == "ENTIRE_FILE",
        # Content was added/changed after this signature was applied.
        "modified_after_signing": coverage != "ENTIRE_FILE",
        "digest_algorithm": status.md_algorithm,
        # Claimed by the signer, NOT cryptographically anchored to a real time.
        "signing_time": ts.isoformat() if ts is not None else None,
    }


def verify_signatures(file: str) -> dict:
    """Verify every embedded signature in a PDF (read-only).

    Args:
        file: PDF path.
    """
    with open(file, "rb") as f:
        reader = PdfFileReader(f)
        signatures = [_verify_one(esig) for esig in reader.embedded_signatures]

    return {
        "signed": len(signatures) > 0,
        "signature_count": len(signatures),
        "signatures": signatures,
        "summary": {
            # Every signature is both crypto-valid AND covers intact bytes.
            "all_valid": bool(signatures) and all(s["valid"] and s["intact"] for s in signatures),
            "any_modified_after_signing": any(s["modified_after_signing"] for s in signatures),
            # This slice never verifies signer identity against a trust store.
            "trust_verified": False,
        },
    }


def _load_signer_from_pfx(pfx_path: str, password: str) -> "signers.SimpleSigner":
    """Load a PKCS#12 signer. Uses load_pkcs12_data (not load_pkcs12): the
    file-path variant swallows its own failure, logs it via
    `logger.error(..., exc_info=e)` on the pyhanko.sign.signers.pdf_cms logger
    — which is NOT silenced here — and returns None. With no handler
    configured, Python's last-resort handler dumps that ERROR-with-traceback
    (including internal deployment paths) to stderr on every
    wrong-password/corrupt-.pfx attempt, and our `except` would be dead code.
    load_pkcs12_data genuinely raises instead, so the handling here is live
    and nothing leaks. The bundled-chain unpacking (other_certs from the
    archive) happens inside load_pkcs12_data itself."""
    if not Path(pfx_path).is_file():
        raise ValueError("Signer file (.pfx) not found.")
    try:
        with open(pfx_path, "rb") as pf:
            pfx_bytes = pf.read()
        return signers.SimpleSigner.load_pkcs12_data(
            pfx_bytes,
            other_certs=[],
            passphrase=password.encode("utf-8") if password else None,
        )
    except Exception:
        # Deliberately generic and password-free — never echo the secret, and
        # suppress the underlying exception chain (`from None`) so nothing it
        # may carry leaks upward.
        raise ValueError(
            "Could not load the signer — wrong password, or an unsupported/corrupt .pfx."
        ) from None


def _key_spki_der(key_bytes: bytes, password: str) -> bytes:
    """DER SubjectPublicKeyInfo of the private key's public half, via the
    bundled `cryptography` (accepts PEM or DER key files, same passphrase)."""
    from cryptography.hazmat.primitives import serialization

    passphrase = password.encode("utf-8") if password else None
    try:
        key = serialization.load_pem_private_key(key_bytes, passphrase)
    except ValueError:
        key = serialization.load_der_private_key(key_bytes, passphrase)
    return key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


def _load_signer_from_pem(key_path: str, cert_path: str, password: str) -> "signers.SimpleSigner":
    """Load a PEM/DER key + certificate signer. Deliberately built on the
    RAISING primitives (load_private_key_from_pemder_data /
    load_certs_from_pemder_data over bytes we read ourselves) with a directly
    constructed SimpleSigner — SimpleSigner.load has the SAME
    swallow-and-log-return-None behavior load_pkcs12 had (confirmed in
    source), which the slice-2 follow-up established as a stderr leak plus
    dead error handling.

    The signing certificate is the one whose public key MATCHES the private
    key — never positional. A PEM bundle has no structural key↔cert pairing
    (unlike PKCS#12), and real-world chain files come in both orders
    (leaf-first fullchain.pem AND root-first CA bundles); trusting certs[0]
    signed with the right key but claimed the WRONG identity on a root-first
    file, producing an invalid-yet-written signature (review-caught). The
    non-matching certificates are registered as the supplied chain."""
    if not Path(key_path).is_file():
        raise ValueError("Signer key file not found.")
    if not Path(cert_path).is_file():
        raise ValueError("Signer certificate file not found.")
    try:
        key_bytes = Path(key_path).read_bytes()
        cert_bytes = Path(cert_path).read_bytes()
        signing_key = load_private_key_from_pemder_data(
            key_bytes, password.encode("utf-8") if password else None
        )
        certs = list(load_certs_from_pemder_data(cert_bytes))
        if not certs:
            raise ValueError("no certificates in file")
        key_spki = _key_spki_der(key_bytes, password)
        matching = [c for c in certs if c.public_key.dump() == key_spki]
        if not matching:
            raise ValueError("no certificate matches the key")
        signing_cert = matching[0]
        registry = SimpleCertificateStore()
        registry.register_multiple([c for c in certs if c is not signing_cert])
        return signers.SimpleSigner(
            signing_cert=signing_cert, signing_key=signing_key, cert_registry=registry
        )
    except Exception:
        # Generic and passphrase-free, chain suppressed — same posture as the
        # .pfx path.
        raise ValueError(
            "Could not load the signer — wrong key passphrase, no certificate "
            "matching the key, or an unsupported/corrupt key or certificate file."
        ) from None


def _validated_appearance(appearance: dict, file: str) -> tuple[int, tuple[float, float, float, float]]:
    """Validate a visible-signature placement: 1-based page within range and a
    normalized rect in PDF user-space points. Returns (page_index_0based, box)."""
    try:
        raw_page = appearance["page"]
        # Reject non-integral pages instead of silently truncating (1.7 → 1).
        if isinstance(raw_page, bool) or (isinstance(raw_page, float) and not raw_page.is_integer()):
            raise ValueError("non-integral page")
        page = int(raw_page)
        x0, y0, x1, y1 = (float(v) for v in appearance["rect"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("Invalid signature appearance: expected {page, rect:[x0,y0,x1,y1]}.") from None
    box = (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
    if box[0] == box[2] or box[1] == box[3]:
        raise ValueError("Invalid signature appearance: the rectangle is empty.")
    import pikepdf

    with pikepdf.open(file) as pdf:
        page_count = len(pdf.pages)
    if not (1 <= page <= page_count):
        raise ValueError(f"Invalid signature appearance: page {page} is out of range (1-{page_count}).")
    return page - 1, box


def _stamp_style(reason: str | None, location: str | None) -> "stamp.TextStampStyle":
    """Visible-stamp style: signer + timestamp via pyHanko's built-in
    interpolation, plus optional reason/location lines. USER TEXT IS
    %-ESCAPED — TextStampStyle interpolates with %(...)s, so a literal % in a
    reason like "100% reviewed" would otherwise raise (or worse, interpolate)
    at sign time."""
    lines = ["Digitally signed by %(signer)s", "%(ts)s"]
    if reason and reason.strip():
        lines.append("Reason: " + reason.strip().replace("%", "%%"))
    if location and location.strip():
        lines.append("Location: " + location.strip().replace("%", "%%"))
    return stamp.TextStampStyle(stamp_text="\n".join(lines))


def sign_pdf(
    file: str,
    output: str,
    pfx_path: str | None = None,
    password: str = "",
    field_name: str = "Signature1",
    reason: str | None = None,
    location: str | None = None,
    key_path: str | None = None,
    cert_path: str | None = None,
    appearance: dict | None = None,
) -> dict:
    """Apply a digital signature, written to a NEW file (signing appends an
    incremental revision — see docs/architecture/11-phase2h-signing.md and
    13-phase2k-signature-completeness.md).

    Signer source: EXACTLY ONE of a PKCS#12 file (``pfx_path``) or a PEM/DER
    key + certificate pair (``key_path`` + ``cert_path``; ``cert_path`` may be
    a fullchain file). ``password`` unlocks whichever source is used (empty
    string for an unencrypted PEM key).

    Appearance: by default the signature is INVISIBLE. Passing ``appearance``
    = ``{page: <1-based>, rect: [x0,y0,x1,y1]}`` (PDF user-space points,
    bottom-up — the same convention as redaction regions) draws a visible
    stamp (signer, signing time, optional reason/location) at that box.

    SECURITY: the ``password`` is used only to load the signer and is NEVER
    placed in the return value, an error message, or any log. The result is
    self-verified via verify_signatures so the caller gets immediate
    confirmation.

    Args:
        file: Input PDF path.
        output: Output path for the signed PDF (MUST differ from ``file``).
        pfx_path: PKCS#12 (.pfx/.p12) signer file.
        password: Passphrase for the signer (empty string if none).
        field_name: Signature field name (default "Signature1").
        reason / location: Optional signature metadata (not secret).
        key_path / cert_path: PEM/DER signer files (alternative to pfx_path).
        appearance: Optional visible-stamp placement (see above).
    """
    input_path = Path(file)
    output_path = Path(output)
    if input_path.resolve() == output_path.resolve():
        # Signing appends a revision; an in-place write would be ambiguous and
        # invites re-serialization that breaks the signature.
        raise ValueError("The signed output must be a different file from the input.")

    have_pfx = bool(pfx_path)
    have_pem = bool(key_path) or bool(cert_path)
    if have_pfx and have_pem:
        raise ValueError("Choose ONE signer source: a .pfx file, or a PEM key + certificate.")
    if have_pem and not (key_path and cert_path):
        raise ValueError("A PEM signer needs both the key file and the certificate file.")
    if not have_pfx and not have_pem:
        raise ValueError("No signer given — provide a .pfx file, or a PEM key + certificate.")

    if have_pfx:
        signer = _load_signer_from_pfx(pfx_path, password)  # type: ignore[arg-type]
    else:
        signer = _load_signer_from_pem(key_path, cert_path, password)  # type: ignore[arg-type]

    placement = _validated_appearance(appearance, file) if appearance is not None else None

    meta = signers.PdfSignatureMetadata(field_name=field_name, reason=reason, location=location)
    with open(file, "rb") as inf:
        writer = IncrementalPdfFileWriter(inf)
        if placement is not None:
            page_ix, box = placement
            fields.append_signature_field(
                writer,
                sig_field_spec=fields.SigFieldSpec(field_name, on_page=page_ix, box=box),
            )
            pdf_signer = signers.PdfSigner(
                meta, signer=signer, stamp_style=_stamp_style(reason, location)
            )
            signed = pdf_signer.sign_pdf(writer)
        else:
            signed = signers.sign_pdf(writer, meta, signer=signer)
    # Fail closed: only write the output once signing has fully succeeded.
    with open(output_path, "wb") as f:
        f.write(signed.getvalue())

    # Immediately self-verify the freshly-signed file (read-only, empty trust
    # context like all verification). The returned dict carries NO secret.
    verification = verify_signatures(str(output_path))
    sig = next(
        (s for s in verification["signatures"] if s.get("field") == field_name),
        verification["signatures"][-1] if verification["signatures"] else None,
    )
    return {
        "output": str(output_path),
        "field": field_name,
        "signer": sig["signer"] if sig else None,
        "valid": sig["valid"] if sig else False,
        "intact": sig["intact"] if sig else False,
        "covers_whole_document": sig["covers_whole_document"] if sig else False,
        "signature_count": verification["signature_count"],
    }


def generate_signer(
    common_name: str,
    output: str,
    password: str,
    org: str | None = None,
    valid_days: int = 1095,
    overwrite: bool = False,
) -> dict:
    """Generate a self-signed signing identity: RSA-2048 key + self-signed
    certificate, written as a password-protected PKCS#12 (.pfx).

    A self-signed identity proves possession of THIS generated key — it does
    not prove identity to third parties (consistent with the app's standing
    trust caveat; verification of files signed with it reports
    ``trusted: false`` like every other signer here).

    SECURITY: the ``password`` protects the private key inside the .pfx and is
    NEVER placed in the return value, an error message, or any log. Refuses to
    overwrite an existing file unless ``overwrite=True`` — a .pfx holds a
    private key; silently clobbering one is not like clobbering a PDF.

    Args:
        common_name: Subject CN — the display name verifiers will show.
        output: Destination .pfx path.
        password: Non-empty passphrase for the .pfx.
        org: Optional organization (subject O).
        valid_days: Certificate validity from now (default 3 years).
        overwrite: Allow replacing an existing file.
    """
    from datetime import datetime, timedelta, timezone

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    name = (common_name or "").strip()
    if not name:
        raise ValueError("A signer name (common name) is required.")
    if not password:
        raise ValueError("A password is required — the .pfx will contain a private key.")
    days = int(valid_days)
    if not (1 <= days <= 3650 * 2):
        raise ValueError("Validity must be between 1 day and 20 years.")
    output_path = Path(output)
    if output_path.exists() and not overwrite:
        raise ValueError(
            "That file already exists. Choose a different name, or explicitly allow overwriting."
        )

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, name)]
    if org and org.strip():
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATION_NAME, org.strip()))
    subject = x509.Name(attrs)
    now = datetime.now(timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        # Small backdate absorbs clock skew between machines.
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=days))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=True,  # nonRepudiation — document signing
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    pfx_bytes = pkcs12.serialize_key_and_certificates(
        name.encode("utf-8"),
        key,
        cert,
        None,
        serialization.BestAvailableEncryption(password.encode("utf-8")),
    )
    # Fail closed: serialize fully, then write.
    with open(output_path, "wb") as f:
        f.write(pfx_bytes)

    return {
        "output": str(output_path),
        "common_name": name,
        "organization": org.strip() if org and org.strip() else None,
        "not_after": (now + timedelta(days=days)).isoformat(),
        "fingerprint_sha256": cert.fingerprint(hashes.SHA256()).hex(),
    }
