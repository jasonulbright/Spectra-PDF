"""Digital-signature VERIFICATION (read-only).

Reports, per embedded signature: whether it's cryptographically valid, whether
the bytes it covers are intact, whether the document was modified after signing
(coverage level), the signer's certificate identity, and the claimed signing
time.

Scope — deliberately "single-cert" verification (roadmap § C, first slice):
we validate the signature's cryptography and the document's integrity, but do
NOT validate the signer's certificate against a trust store, nor check
revocation, nor timestamp/LTV. So ``trusted`` is always reported but reflects
"no trust anchor was consulted" — the UI must present a valid result as
"cryptographically valid, signer identity NOT verified against a trusted
authority", never as fully trusted. Signing (applying signatures) is a
separate deferred slice. See docs/architecture/10-phase2h-signatures.md.

Uses pyHanko (MIT) — the ByteRange / CMS / incremental-update handling is
exactly the security-critical plumbing not to hand-roll.
"""

import logging

# pyHanko logs a full traceback when it can't build a trust path (which is
# ALWAYS, here — we pass no trust anchor by design). It's handled internally
# and only reflected as trusted=False, so silence the noise before importing.
for _name in ("pyhanko", "pyhanko_certvalidator"):
    logging.getLogger(_name).setLevel(logging.CRITICAL)

from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature


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
        status = validate_pdf_signature(embedded, signer_validation_context=None)
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
        # Always false in this slice — no trust store is consulted.
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
