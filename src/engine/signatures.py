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
from pyhanko.sign import signers
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext


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


def sign_pdf(
    file: str,
    output: str,
    pfx_path: str,
    password: str,
    field_name: str = "Signature1",
    reason: str | None = None,
    location: str | None = None,
) -> dict:
    """Apply an INVISIBLE digital signature using a PKCS#12 (.pfx) signer,
    written to a NEW file (signing appends an incremental revision — see
    docs/architecture/11-phase2h-signing.md).

    SECURITY: the ``password`` is used only to load the signer and is NEVER
    placed in the return value, an error message, or any log. The result is
    self-verified via verify_signatures so the caller gets immediate
    confirmation.

    Args:
        file: Input PDF path.
        output: Output path for the signed PDF (MUST differ from ``file``).
        pfx_path: PKCS#12 (.pfx/.p12) signer file.
        password: Passphrase for the .pfx (empty string if none).
        field_name: Signature field name (default "Signature1").
        reason / location: Optional signature metadata (not secret).
    """
    input_path = Path(file)
    output_path = Path(output)
    if input_path.resolve() == output_path.resolve():
        # Signing appends a revision; an in-place write would be ambiguous and
        # invites re-serialization that breaks the signature.
        raise ValueError("The signed output must be a different file from the input.")
    if not Path(pfx_path).is_file():
        raise ValueError("Signer file (.pfx) not found.")

    # Use load_pkcs12_data (not load_pkcs12): the file-path variant swallows its
    # own failure, logs it via `logger.error(..., exc_info=e)` on the
    # pyhanko.sign.signers.pdf_cms logger — which is NOT silenced here — and
    # returns None. With no handler configured, Python's last-resort handler
    # dumps that ERROR-with-traceback (including internal deployment paths) to
    # stderr on every wrong-password/corrupt-.pfx attempt, and our `except`
    # below would be dead code. load_pkcs12_data genuinely raises instead, so
    # the handling here is live and nothing leaks. The bundled-chain unpacking
    # (other_certs from the archive) happens inside load_pkcs12_data itself.
    try:
        with open(pfx_path, "rb") as pf:
            pfx_bytes = pf.read()
        signer = signers.SimpleSigner.load_pkcs12_data(
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

    meta = signers.PdfSignatureMetadata(field_name=field_name, reason=reason, location=location)
    with open(file, "rb") as inf:
        writer = IncrementalPdfFileWriter(inf)
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
