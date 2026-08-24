"""Digital signatures: verification AND signing.

Verification (``verify_signatures``) reports, per embedded signature: whether
it's cryptographically valid, whether the bytes it covers are intact, whether
the document was modified after signing (coverage level), the signer's
certificate identity, and the claimed signing time.

Verification scope — deliberately "single-cert": we validate
the signature's cryptography and the document's integrity, but do NOT
validate the signer's certificate against any trust store, nor check
revocation, nor timestamp/LTV. So ``trusted`` is reported but is
DETERMINISTICALLY False — the UI must present a valid result as
"cryptographically valid, signer identity NOT verified against a trusted
authority", never as fully trusted. PAdES/LTV/TSA are not implemented; an
arm's-length AGPL subprocess is the documented integration path.

Signing (``sign_pdf``) is shipped:
signer sources are a .pfx/.p12 (``_load_signer_from_pfx``), a PEM key +
certificate pair with key-match validation (``_load_signer_from_pem``), a
PKCS#11 token, or a certificate in the Windows certificate store whose key
never leaves the platform (``StoreSigner`` over ``engine.wincert``);
placement is invisible, a visible stamp rect, or an existing empty signature
field (``--existing-field`` / sign-into-field); ``generate_signer`` creates
an in-app self-signed identity.

CRITICAL — trust context: we pass an EXPLICIT EMPTY trust context
(``ValidationContext(trust_roots=[])``), NOT ``signer_validation_context=None``.
Passing None does NOT mean "no anchor": pyHanko's SimpleTrustManager.build
treats ``trust_roots is None`` as "load the operating system's certificate
store" (oscrypto `trust_list.get_list()` — ~dozens of real CA roots on
Windows). Under None, a PDF signed by any commercial CA would come back
``trusted=True``, machine-dependent, silently contradicting the explicit-trust
promise. An explicit empty ``trust_roots=[]`` (a non-None value, so no OS
fallback) makes ``trusted`` deterministically False regardless of the host's
trust store. Regression-tested by monkeypatching the OS store to contain the
signer cert and asserting ``trusted`` stays False.

The OS store IS reachable, but only as an explicit opt-in (``system_trust``),
never as a fallback: it goes through ``engine.os_trust``, which respects the
store's per-purpose (EKU) restrictions and is not read at all while the option
is off. The bundled EU trusted-list certificates (``engine.eutl``) are a third
source on the same terms — opt-in per source (``eutl_trust``), off by default,
never read while off, and offline: the bundle ships, nothing fetches it. Which
anchor set a chain reached is reported per signature as ``trust_source``.

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
from pyhanko.sign.fields import FieldMDPAction, FieldMDPSpec, MDPPerm, SigSeedSubFilter
from pyhanko.sign.general import SigningError
from pyhanko.sign.timestamps import HTTPTimeStamper
from pyhanko.sign.validation import validate_pdf_signature

from engine import eutl, os_trust, stamp_appearance, wincert
from engine.acroform import form_field_forest
from engine.docmdp import LEVEL_BY_VALUE, VALUE_BY_LEVEL, certification_of_file
from engine.docmdp_policy import DIFF_POLICY, LockedFieldModification
from engine.inplace import is_same_file
from engine.fieldmdp import (
    ACTION_BY_NAME,
    lock_of_field_dict,
    validated_lock,
)
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


def _load_trust_roots(paths: list) -> list:
    """Load CA certificates (PEM or DER) to act as trust anchors.

    the trust management: the USER supplies the anchors (a company CA, a
    public root they choose to trust). The OS store is deliberately never
    consulted — same explicit-trust posture as _empty_trust_context, just
    with the user's own anchors instead of none.
    """
    roots = []
    for p in paths or []:
        path = Path(str(p))
        if not path.is_file():
            raise ValueError(f"trust root not found: {p}")
        certs = list(load_certs_from_pemder_data(path.read_bytes()))
        if not certs:
            raise ValueError(f"no certificates found in trust root: {p}")
        roots.extend(certs)
    return roots


def _trust_context(trust_roots: list | None, allow_fetching: bool = False) -> ValidationContext:
    """A validation context anchored on user-supplied roots ('' state = empty).

    ``retroactive_revinfo`` matters for LTV verification: revocation data
    embedded in the DSS was necessarily fetched BEFORE the moment of
    validation, and without this flag fresh-signature checks reject it as
    stale-relative-to-now.
    """
    return ValidationContext(
        trust_roots=_load_trust_roots(trust_roots or []),
        allow_fetching=allow_fetching,
        retroactive_revinfo=True,
    )


def _fingerprints(certs: list) -> set:
    return {c.sha256 for c in certs}


class _TrustSources:
    """The anchors in force for one verification, and which set each came from.

    Three sources, each opt-in and off by default: the user's own anchors, the
    platform certificate store, and the bundled EU trusted-list certificates.

    Two contexts, not one: a signature validation builds a signer chain and a
    timestamp chain, and both optional sources record a DIFFERENT anchor set for
    each — the store as EKU restrictions, the trusted lists as service types.
    ``validate_pdf_signature`` already takes the two contexts separately.

    With both options off, nothing here reads the store or the bundle and the
    contexts collapse to the single user-anchored (or empty) context of the
    original explicit-trust posture.
    """

    def __init__(self, trust_roots: list | None, system_trust: bool,
                 eutl_trust: bool = False):
        user = _load_trust_roots(trust_roots or [])
        self.user_prints = _fingerprints(user)
        self.system_prints: set = set()
        self.eutl_prints: set = set()
        self.system_requested = bool(system_trust)
        self.system_available = os_trust.available() if system_trust else False
        self.system_anchor_count = 0
        self.eutl_requested = bool(eutl_trust)
        self.eutl_available = eutl.available() if eutl_trust else False
        self.eutl_provenance = eutl.provenance() if eutl_trust else {}
        if not system_trust and not eutl_trust:
            ctx = _trust_context(trust_roots) if trust_roots else None
            self.signer_context = ctx
            self.timestamp_context = ctx
            return

        signer_anchors: list = []
        timestamp_anchors: list = []
        intermediates: list = []
        if system_trust:
            store_signers = os_trust.anchors(os_trust.SIGNER_PURPOSES)
            store_timestampers = os_trust.anchors(os_trust.TIMESTAMP_PURPOSES)
            intermediates = os_trust.intermediates()
            # The union, not the signer set: a report of how many anchors the
            # store contributed to this verification at all.
            self.system_prints = _fingerprints(store_signers) | _fingerprints(store_timestampers)
            self.system_anchor_count = len(self.system_prints)
            signer_anchors += store_signers
            timestamp_anchors += store_timestampers
        if eutl_trust:
            list_signers = eutl.anchors(eutl.SIGNER)
            list_timestampers = eutl.anchors(eutl.TIMESTAMP)
            self.eutl_prints = _fingerprints(list_signers) | _fingerprints(list_timestampers)
            signer_anchors += list_signers
            timestamp_anchors += list_timestampers

        self.signer_context = ValidationContext(
            trust_roots=[*user, *signer_anchors],
            other_certs=intermediates,
            allow_fetching=False,
            retroactive_revinfo=True,
        )
        self.timestamp_context = ValidationContext(
            trust_roots=[*user, *timestamp_anchors],
            other_certs=intermediates,
            allow_fetching=False,
            retroactive_revinfo=True,
        )

    @property
    def anchored(self) -> bool:
        """Whether any anchor at all is in force — the precondition for a
        trusted verdict being meaningful."""
        return bool(self.user_prints) or bool(self.system_prints) or bool(self.eutl_prints)

    def source_of(self, status) -> str | None:
        """Which anchor set the validated path terminated at.

        Ordered by how specific the statement is, so a certificate carried by
        more than one source is reported as the narrowest thing that vouches for
        it: the user chose THIS certificate; a trusted list says this authority
        is a granted qualified one; the platform store says only that the
        machine carries the root.
        """
        path = getattr(status, "validation_path", None)
        if path is None:
            return None
        try:
            anchor = path[0]
        except Exception:
            return None
        if anchor.sha256 in self.user_prints:
            return "user"
        if anchor.sha256 in self.eutl_prints:
            return "eutl"
        if anchor.sha256 in self.system_prints:
            return "system"
        return None

    def report(self) -> dict:
        return {
            "requested": self.system_requested,
            "available": self.system_available,
            "anchor_count": self.system_anchor_count,
        }

    def eutl_report(self) -> dict:
        """What the bundled trusted lists contributed, plus the provenance a
        surface needs to say how old the bundle is."""
        return {
            "requested": self.eutl_requested,
            "available": self.eutl_available,
            "anchor_count": len(self.eutl_prints),
            **self.eutl_provenance,
        }


def _make_timestamper(tsa_url: str):
    """RFC 3161 client for the user's chosen TSA. A seam so tests can swap in
    an offline timestamper without network."""
    return HTTPTimeStamper(tsa_url)


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


def _subfilter_of(embedded) -> str | None:
    try:
        return str(embedded.sig_object.get("/SubFilter"))
    except Exception:
        return None


def _signature_certification_level(embedded) -> str | None:
    """The certification level THIS signature declares, or None for an approval
    signature. A permission value outside the three defined levels reads as no
    declared level rather than a guessed one."""
    try:
        level = embedded.docmdp_level
    except Exception:
        return None
    if level is None:
        return None
    # The permission enum is ordered but not an int subclass, so its `.value`
    # is the only integer that can be looked up.
    return LEVEL_BY_VALUE.get(getattr(level, "value", None))


def _signature_lock(embedded) -> dict | None:
    """The field lock THIS signature imposes, or None. Per signature, unlike the
    document's certification: a certification and a later approval signature can
    lock different sets."""
    try:
        spec = embedded.fieldmdp
    except Exception:
        return None
    if spec is None:
        return None
    action = ACTION_BY_NAME.get(str(getattr(spec.action, "value", "")))
    if action is None:
        return None
    return {"action": action, "fields": [] if action == "all" else [str(f) for f in spec.fields or ()]}


def _lock_violation(status) -> dict | None:
    """The locked fields a change since signing touched, or None. Read off the
    difference analysis as structured data — the library's own refusal names an
    object number, which is not user information."""
    result = getattr(status, "diff_result", None)
    if isinstance(result, LockedFieldModification):
        return {"fields": list(result.fields)}
    return None


def _unjudged(modification_level: str | None) -> dict:
    return {
        "policy_ok": None,
        "policy_judged": False,
        "modification_level": modification_level,
    }


def _policy_report(status, certification: dict) -> dict:
    """Whether the changes since signing stay within the document's own
    certification policy.

    A verdict that CANNOT be made is reported as unmade — never as a pass and
    never as a failure."""
    level = status.modification_level
    modification_level = level.name if level is not None else None
    if not certification["certified"]:
        # No certification policy is in force, so there is nothing to violate.
        return {
            "policy_ok": True,
            "policy_judged": True,
            "modification_level": modification_level,
        }
    if certification["level"] is None:
        # A permission level this build does not recognize is not guessed at.
        return _unjudged(modification_level)
    if status.docmdp_ok is None:
        return _unjudged(modification_level)
    return {
        "policy_ok": bool(status.docmdp_ok),
        "policy_judged": True,
        "modification_level": modification_level,
    }


def _verify_one(embedded, sources: "_TrustSources | None" = None,
                certification: dict | None = None) -> dict:
    certification = certification or {"certified": False, "level": None}
    field = getattr(embedded, "field_name", None)
    ts = getattr(embedded, "self_reported_timestamp", None)
    subfilter = _subfilter_of(embedded)
    is_pades = subfilter == "/ETSI.CAdES.detached"
    try:
        # Explicit empty trust context by default — see the module docstring
        # for why NOT None (which would consult the OS certificate store). The
        # caller's sources carry the user's chosen anchors, and the OS store
        # only when it was explicitly asked for.
        signer_ctx = sources.signer_context if sources is not None else None
        ts_ctx = sources.timestamp_context if sources is not None else None
        if signer_ctx is None:
            signer_ctx = _empty_trust_context()
        if ts_ctx is None:
            ts_ctx = _empty_trust_context()
        # The difference policy is passed EXPLICITLY here, at the one call
        # site, rather than installed as a library default — no other caller
        # of the validator inherits it.
        status = validate_pdf_signature(
            embedded, signer_validation_context=signer_ctx, ts_validation_context=ts_ctx,
            diff_policy=DIFF_POLICY,
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
            "trust_source": None,
            "coverage": "UNKNOWN",
            "covers_whole_document": False,
            "modified_after_signing": True,
            "digest_algorithm": None,
            "signing_time": ts.isoformat() if ts is not None else None,
            "subfilter": subfilter,
            "pades": is_pades,
            "timestamped": False,
            "timestamp_time": None,
            "timestamp_valid": False,
            "certification_level": _signature_certification_level(embedded),
            "lock": _signature_lock(embedded),
            "lock_violation": None,
            **_unjudged(None),
            "error": str(exc),
        }
    coverage = status.coverage.name if status.coverage is not None else "UNKNOWN"
    tsv = getattr(status, "timestamp_validity", None)
    return {
        "field": field,
        "signer": _signer_name(status),
        # CMS signature verifies against the signer's key.
        "valid": bool(status.valid),
        # The bytes the signature covers are unmodified (document integrity).
        "intact": bool(status.intact),
        # False unless an anchor set was supplied: with no user anchors and no
        # opt-in to the OS store, validation runs against an EXPLICIT empty
        # trust context and no certificate can chain. Reported (not hidden) so
        # the UI can state the identity caveat honestly.
        "trusted": bool(status.trusted),
        # WHICH anchor set the path terminated at, so a trusted result can say
        # whether the user vouched for the chain or the machine did.
        "trust_source": sources.source_of(status) if sources is not None and status.trusted else None,
        "coverage": coverage,
        "covers_whole_document": coverage == "ENTIRE_FILE",
        # Content was added/changed after this signature was applied.
        "modified_after_signing": coverage != "ENTIRE_FILE",
        "digest_algorithm": status.md_algorithm,
        # Claimed by the signer, NOT cryptographically anchored to a real time.
        "signing_time": ts.isoformat() if ts is not None else None,
        "subfilter": subfilter,
        "pades": is_pades,
        # An RFC 3161 timestamp token (TSA-backed time), unlike signing_time.
        "timestamped": tsv is not None,
        "timestamp_time": (
            tsv.timestamp.isoformat() if tsv is not None and tsv.timestamp is not None else None
        ),
        "timestamp_valid": bool(tsv.valid and tsv.intact) if tsv is not None else False,
        # The level THIS signature declares (None for an approval signature) —
        # a document with one certification and several approvals must show
        # which signature is the author's.
        "certification_level": _signature_certification_level(embedded),
        # What THIS signature locks, and which of those fields a later change
        # touched — a third fact beside validity and the certification verdict,
        # never folded into either.
        "lock": _signature_lock(embedded),
        "lock_violation": _lock_violation(status),
        **_policy_report(status, certification),
    }


def verify_signatures(
    file: str, trust_roots: list | None = None, system_trust: bool = False,
    eutl_trust: bool = False,
) -> dict:
    """Verify every embedded signature in a PDF (read-only).

    Args:
        file: PDF path.
        trust_roots: optional CA certificate files (PEM/DER) the USER trusts.
            When given, ``trusted`` is validated against exactly these anchors;
            without them, and without either optional source, it stays
            deterministically False — the explicit-trust posture.
        system_trust: also anchor on the operating system's certificate store,
            per purpose (``engine.os_trust``). OFF by default and read only
            when True, so the default costs no store enumeration.
        eutl_trust: also anchor on the bundled EU trusted-list certificates
            (``engine.eutl``). OFF by default and read only when True. The
            bundle ships; nothing is fetched here.
    """
    sources = _TrustSources(trust_roots, system_trust, eutl_trust)
    # /Perms /DocMDP is a CATALOG property, so the certification is
    # document-level; the per-signature level below says which signature wrote
    # it. Read first: every signature's policy verdict is relative to it.
    certification = certification_of_file(file)
    with open(file, "rb") as f:
        reader = PdfFileReader(f)
        # Regular signatures only — a PAdES B-LTA document timestamp is a
        # different animal (it seals the DSS, it doesn't sign content) and
        # validate_pdf_signature would misreport it as a broken signature.
        signatures = [
            _verify_one(esig, sources, certification)
            for esig in reader.embedded_regular_signatures
        ]
        doc_timestamps = len(reader.embedded_timestamp_signatures)
        # Document Security Store (/DSS) — the PAdES B-LT container for
        # embedded certs + revocation data. Its presence is what makes a
        # signature verifiable long after the CA endpoints go dark.
        try:
            has_dss = "/DSS" in reader.root
        except Exception:
            has_dss = False

    # Each signature's PAGE (1-based) via its widget's location — a
    # pikepdf pass, since pyHanko's object model offers no page lookup.
    # Best-effort: a signature whose widget can't be placed simply carries
    # no page (the panel then offers no jump, never a wrong one).
    try:
        import pikepdf

        from engine.incremental import _widget_field_name

        page_by_name: dict[str, int] = {}
        with pikepdf.open(file) as pdf:
            for i, page in enumerate(pdf.pages):
                annots = page.obj.get("/Annots")
                if annots is None:
                    continue
                for a in annots:
                    try:
                        if a.get("/Subtype") != pikepdf.Name("/Widget"):
                            continue
                        name = _widget_field_name(a)
                        if name:
                            page_by_name.setdefault(name, i + 1)
                    except Exception:
                        continue
        for s in signatures:
            page_no = page_by_name.get(s.get("field") or "")
            if page_no is not None:
                s["page"] = page_no
    except Exception:
        pass

    author_field = next(
        (s["field"] for s in signatures if s.get("certification_level") is not None), None
    )

    return {
        "signed": len(signatures) > 0,
        "signature_count": len(signatures),
        "signatures": signatures,
        "ltv_info_present": has_dss,
        # PAdES B-LTA document timestamps sealing the file (0 = none).
        "document_timestamps": doc_timestamps,
        # What the OS store contributed. `available` false with `requested`
        # true is a platform with no readable store — reported as such rather
        # than as an empty store, which would read as a failed chain.
        "system_trust": sources.report(),
        # What the bundled trusted lists contributed, on the same terms, plus
        # the bundle's fetch date: a trust feed that cannot say how old it is
        # invites being read as current.
        "eutl_trust": sources.eutl_report(),
        "certification": {
            "certified": bool(certification["certified"]),
            "level": certification["level"],
            "level_value": certification["level_value"],
            "field": author_field,
            "error": certification["error"],
        },
        "summary": {
            # Every signature is both crypto-valid AND covers intact bytes.
            "all_valid": bool(signatures) and all(s["valid"] and s["intact"] for s in signatures),
            "any_modified_after_signing": any(s["modified_after_signing"] for s in signatures),
            # True only when an anchor set was actually in force — otherwise
            # every signature is trivially untrusted and "not verified" would
            # be indistinguishable from "no anchors configured".
            "trust_verified": sources.anchored and bool(signatures)
            and all(s["trusted"] for s in signatures),
            "certified": bool(certification["certified"]),
            # An UNJUDGED signature is not a violation; only a judged failure is.
            "any_policy_violation": any(s.get("policy_ok") is False for s in signatures),
            "any_lock_violation": any(s.get("lock_violation") for s in signatures),
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
    signed with the right key but claimed the wrong identity on a root-first
    file, producing an invalid signature. The
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


def _validated_existing_field(file: str, field_name: str) -> None:
    """The named field must exist, be a SIGNATURE field, and be empty —
    validated up front for clear errors (pyHanko's existing_fields_only
    refusal is the fail-closed backstop either way). enumerate_sig_fields
    yields signature fields only, so a same-named text field correctly
    reports as 'no empty signature field'."""
    with open(file, "rb") as f:
        reader = PdfFileReader(f)
        for name, value, _ref in fields.enumerate_sig_fields(reader):
            if name == field_name:
                if value is not None:
                    raise ValueError(f'Signature field "{field_name}" is already signed.')
                return
    raise ValueError(f'No empty signature field named "{field_name}" exists in this PDF.')


def _free_field_name(file: str, requested: str) -> str:
    """A signature-field name not already present in the file: `requested` if
    free, else the lowest free ``Signature{N}``.

    The default is "Signature1", and the in-place flow re-reads the same working
    copy, so a second signature would collide on that
    name and pyHanko refuses ("field appears to be filled already"), breaking
    in-place signing after one use AND the Save-a-copy flow on that document.
    Rotating to the next free name makes counter-signing Just Work with no UI
    change. A read-only pre-scan; a lookup failure degrades to `requested`."""
    used: set[str] = set()
    try:
        with open(file, "rb") as f:
            reader = PdfFileReader(f)
            for name, _value, _ref in fields.enumerate_sig_fields(reader):
                used.add(name)
    except Exception:
        return requested
    if requested not in used:
        return requested
    n = 1
    while f"Signature{n}" in used:
        n += 1
    return f"Signature{n}"


_MDP_PERM_BY_LEVEL: dict[str, MDPPerm] = {
    "none": MDPPerm.NO_CHANGES,
    "form-fill": MDPPerm.FILL_FORMS,
    "annotate": MDPPerm.ANNOTATE,
}

_MDP_ACTION_BY_NAME: dict[str, FieldMDPAction] = {
    "all": FieldMDPAction.ALL,
    "include": FieldMDPAction.INCLUDE,
    "exclude": FieldMDPAction.EXCLUDE,
}


def _validated_lock(
    file: str, lock: str | None, lock_fields: list | None, own_name: str | None = None
) -> FieldMDPSpec | None:
    """Validate a field-lock request against the document, and build the spec.

    The rules live in ``fieldmdp.validated_lock``, which the preparer-side
    authoring doors share: a lock means the same thing and refuses the same
    requests whether it is placed at signing time or seeded onto an unsigned
    field beforehand.
    """
    present = None
    if lock_fields:
        import pikepdf

        try:
            with pikepdf.open(file) as pdf:
                present = set(form_field_forest(pdf))
        except Exception:
            # A document that cannot be read has no field list to check against.
            # The signing path below fails on its own with the actual reason.
            present = None
    spec = validated_lock(lock, lock_fields, present, own_name)
    if spec is None:
        return None
    return FieldMDPSpec(
        action=_MDP_ACTION_BY_NAME[spec["action"]], fields=spec["fields"] or None
    )


def _existing_field_lock_refusal(file: str, field_name: str, spec: FieldMDPSpec | None) -> None:
    """Refuse to replace a signature field's own ``/Lock``.

    The seed value is a constraint the form's author placed on whoever signs
    that field, and the signing machinery applies it whether or not the signer
    asked for one. Overwriting it with a different lock is not the signer's
    call; asking for the same one is not a change and proceeds."""
    if spec is None:
        return
    import pikepdf

    try:
        with pikepdf.open(file) as pdf:
            field = form_field_forest(pdf).get(field_name)
            existing = lock_of_field_dict(field) if field is not None else None
    except Exception:
        return
    if existing is None:
        return
    requested = {
        "action": next(k for k, v in _MDP_ACTION_BY_NAME.items() if v == spec.action),
        "fields": list(spec.fields or ()),
    }
    if existing != requested:
        raise ValueError(
            f'Signature field "{field_name}" already locks form fields on its own '
            "terms, and a signature cannot replace that. Sign it as it stands, or "
            "use a different field."
        )


def _filled_signature_fields(file: str) -> list[str]:
    """Names of the signature fields that already carry a value.

    A certification signature must be the first signature in a document, so
    this is read BEFORE any signing work — the refusal can then name the count
    and the field, which an exception raised from inside the signing machinery
    cannot."""
    filled: list[str] = []
    try:
        with open(file, "rb") as f:
            reader = PdfFileReader(f)
            for name, value, _ref in fields.enumerate_sig_fields(reader, filled_status=True):
                filled.append(name)
    except Exception:
        # An unreadable file fails on its own in the signing path below, with a
        # message about the actual problem.
        return []
    return filled


def _certification_refusals(file: str, certify: bool, certify_level: str | None) -> dict:
    """Validate the certification request against the document, and return the
    document's own certification state for the signing path to reason with.

    Every refusal here happens before the signer is resolved, so a rejected
    request never unlocks a key or opens a token session."""
    if certify_level is not None and not certify:
        raise ValueError(
            "A certification level applies only to a certification signature. "
            "Certify the document, or leave the level unset."
        )
    if certify_level is not None and certify_level not in VALUE_BY_LEVEL:
        raise ValueError(
            f'Unknown certification level "{certify_level}". '
            "Choose none, form-fill, or annotate."
        )
    existing = certification_of_file(file)
    if certify and existing["certified"]:
        existing_level = existing["level"] or "an unrecognized level"
        raise ValueError(
            f'This document is already certified at level "{existing_level}". '
            "A document can carry at most one certification signature."
        )
    if certify:
        filled = _filled_signature_fields(file)
        if filled:
            signature_count = len(filled)
            first_field = filled[0]
            raise ValueError(
                f"This document already carries {signature_count} signature(s), the first "
                f'in field "{first_field}". A certification signature must be the first '
                "signature in a document."
            )
    return existing


def _raise_mapped_signing_refusal(certify: bool, existing: dict) -> None:
    """Re-raise the library's own certification enforcement as an engine refusal.

    The mapping is keyed on the REQUEST and the document's certification state,
    never on the library exception's text: that text is a library string that
    can change under us, and control flow that reads it breaks silently when it
    does. ``from None`` because the library message is not the user's."""
    if certify:
        raise ValueError(
            "A certification signature must be the first signature in a document, and "
            "this document could not accept one."
        ) from None
    if existing["certified"] and existing["level"] == "none":
        raise ValueError(
            "This document is certified with no changes allowed, so it cannot be signed "
            "again. Save a copy and sign that instead."
        ) from None
    raise ValueError(
        "This document could not be signed — its own signature policy forbids the change."
    ) from None


def _refuse_unverifiable_output(verification: dict, field_name: str) -> None:
    """Refuse a just-written signature that does not verify against its own
    bytes.

    The write is still in its temp file when this runs, so the refusal leaves
    the original untouched. Selecting by field name rather than by "all
    signatures" keeps an already-broken PRIOR signature from blocking a new,
    correct one: only what this run produced is judged."""
    written = next(
        (s for s in verification["signatures"] if s.get("field") == field_name),
        verification["signatures"][-1] if verification["signatures"] else None,
    )
    if written is not None and written.get("valid") and written.get("intact"):
        return
    raise ValueError(
        "The signature this document was given does not verify against its own bytes, "
        "so it was not written. The signing key produced a signature this document "
        "cannot carry."
    )


def _seed_existing_field_lock(writer, field_name: str, spec: FieldMDPSpec) -> None:
    """Write the ``/Lock`` onto an existing signature field, in the same
    incremental revision the signature lands in — so the bytes carrying the lock
    are covered by the signature that declares it."""
    for name, _value, ref in fields.enumerate_sig_fields(writer):
        if name != field_name:
            continue
        field = ref.get_object()
        field["/Lock"] = writer.add_object(spec.as_sig_field_lock())
        writer.update_container(field)
        return


def _stamp_style(
    reason: str | None,
    location: str | None,
    appearance: "stamp_appearance.StampAppearance | None" = None,
) -> "stamp.TextStampStyle":
    """Visible-stamp style. ONE APPEARANCE AUTHOR: the drawing lives in
    `stamp_appearance`, which the preview calls too, so what a surface shows
    and what a signature carries cannot diverge. With no appearance configured
    this is the plain signer + timestamp + reason/location stamp signing has
    always produced."""
    return stamp_appearance.stamp_style(reason, location, appearance)


class StoreSigner(signers.Signer):
    """A signer whose private key stays inside the Windows certificate store.

    pyHanko builds the PDF object, the byte range and the signed attributes and
    then asks for ONE thing: the raw signature over those attribute bytes. That
    request is the whole seam — the attributes are digested here and the digest
    is handed to ``NCryptSignHash`` under a key handle the store owns, so every
    placement (visible stamp, existing-field fill, in-place, PAdES, TSA, LTV,
    DocMDP, FieldMDP) works with no path of its own.

    The padding follows the mechanism pyHanko settled on for this digest rather
    than a fixed choice, so an RSA key signs PKCS#1 v1.5 or PSS as asked and an
    EC key signs ECDSA.

    ``dry_run`` sizes the placeholder and must not touch the key: a hardware
    key would raise its consent prompt twice, once for a signature that is
    discarded.
    """

    def __init__(self, handle, **kwargs):
        from asn1crypto import x509 as asn1_x509

        cert = asn1_x509.Certificate.load(handle.certificate)
        registry = SimpleCertificateStore()
        registry.register_multiple(
            [asn1_x509.Certificate.load(der) for der in handle.chain]
        )
        super().__init__(signing_cert=cert, cert_registry=registry, **kwargs)
        self._handle = handle

    def _raw_signature_size(self) -> int:
        key = self.signing_cert.public_key
        if key.algorithm == "ec":
            # DER SEQUENCE of two INTEGERs, each at worst one leading zero byte
            # wider than the field. The SEQUENCE header is NOT a fixed two
            # bytes: a payload of 128 or more takes the long form, which P-521
            # reaches (2 * (67 + 2) = 138 → 0x30 0x81 0x8A, 141 in all). A
            # placeholder sized for the short form truncates the signature.
            field = (key.bit_size + 7) // 8
            integer = field + 1 + 2
            payload = 2 * integer
            header = 2 if payload < 0x80 else 2 + (payload.bit_length() + 7) // 8
            return payload + header
        return (key.bit_size + 7) // 8

    async def async_sign_raw(self, data: bytes, digest_algorithm: str, dry_run=False) -> bytes:
        if dry_run:
            return self._raw_signature_size() * b"\0"
        import hashlib

        mechanism = self.get_signature_mechanism_for_digest(digest_algorithm)
        algorithm = mechanism.signature_algo
        # PSS salt length is a property of the mechanism the CMS DECLARES, not
        # a constant: signing with a salt the declaration does not name yields
        # a signature that verifies against nothing.
        pss_salt = (
            int(mechanism["parameters"]["salt_length"].native)
            if algorithm == "rsassa_pss"
            else None
        )
        digest = hashlib.new(digest_algorithm, data).digest()
        try:
            raw = self._handle.sign_digest(
                digest,
                digest_algorithm,
                pss_salt=pss_salt,
                ecdsa=algorithm == "ecdsa",
            )
        except wincert.SigningCancelled:
            # A turned-down prompt is the user's answer, so it leaves the same
            # door every other signing refusal does rather than surfacing as a
            # library failure.
            raise ValueError(
                "Signing was cancelled — Windows was not given permission to use the key."
            ) from None
        if algorithm == "ecdsa":
            return wincert.ecdsa_der(raw)
        return raw


from contextlib import contextmanager


@contextmanager
def _signer_source(
    pfx_path: str | None,
    password: str,
    key_path: str | None,
    cert_path: str | None,
    pkcs11_module: str | None,
    pkcs11_token: str | None,
    pkcs11_pin: str,
    pkcs11_cert_label: str | None,
    pkcs11_key_label: str | None,
    store_cert: str | None = None,
    store_machine: bool = False,
):
    """Resolve EXACTLY ONE signer source, yielding a live signer (added
    the third source). File-based signers (PKCS#12 / PEM) resolve eagerly and
    need no cleanup; a PKCS#11 signer holds an OPEN token session and a
    certificate-store signer holds an OPEN key handle for the whole signing
    operation — the reason this is a context manager. The PIN, like the
    password, never lands in results, errors, or logs; the store source has no
    secret of ours to leak, because Windows collects any PIN itself."""
    have_pfx = bool(pfx_path)
    have_pem = bool(key_path) or bool(cert_path)
    have_p11 = bool(pkcs11_module) or bool(pkcs11_token) or bool(pkcs11_cert_label)
    have_store = bool(store_cert)
    if sum([have_pfx, have_pem, have_p11, have_store]) > 1:
        raise ValueError(
            "Choose ONE signer source: a .pfx file, a PEM key + certificate, "
            "a PKCS#11 token, or a certificate from the Windows certificate store."
        )
    if have_pem and not (key_path and cert_path):
        raise ValueError("A PEM signer needs both the key file and the certificate file.")
    if have_store:
        if not wincert.available():
            raise ValueError("The Windows certificate store is not available on this system.")
        try:
            handle = wincert.StoreCertificate(store_cert, store_machine).open()
        except wincert.StoreUnavailable:
            raise ValueError(
                "The Windows certificate store is not available on this system."
            ) from None
        except wincert.SigningCancelled:
            raise ValueError(
                "Signing was cancelled — Windows was not given permission to use the key."
            ) from None
        try:
            yield StoreSigner(handle)
        finally:
            handle.close()
        return
    if have_p11:
        if not (pkcs11_module and pkcs11_token and pkcs11_cert_label):
            raise ValueError(
                "A PKCS#11 signer needs the module path, the token label, "
                "and the certificate label."
            )
        if not Path(pkcs11_module).is_file():
            raise ValueError("PKCS#11 module not found at the given path.")
        from pyhanko.sign.pkcs11 import PKCS11Signer, open_pkcs11_session

        try:
            session_cm = open_pkcs11_session(
                lib_location=pkcs11_module,
                token_label=pkcs11_token,
                user_pin=pkcs11_pin or None,
            )
            session = session_cm.__enter__()
        except Exception as exc:
            # Honest, PIN-free classification. pyHanko wraps everything in
            # its own PKCS11Error (probe-verified: a missing token surfaces
            # as "No token matching criteria …"), so classify by TEXT, not
            # type name. Neither library echoes the PIN in messages.
            text = str(exc)
            kind = type(exc).__name__
            if "No token" in text:
                msg = f'No token labelled "{pkcs11_token}" in this module.'
            elif "PIN" in text.upper() or "PinIncorrect" in kind or "PinInvalid" in kind:
                msg = "The token rejected the PIN."
            else:
                msg = f"Could not open the PKCS#11 token: {text}"
            raise ValueError(msg) from exc
        try:
            yield PKCS11Signer(
                session,
                cert_label=pkcs11_cert_label,
                key_label=pkcs11_key_label or pkcs11_cert_label,
            )
        except ValueError:
            raise
        except Exception as exc:
            # Signing-time token failures (missing key/cert label, a yanked
            # device) arrive as pkcs11/pyHanko exceptions whose messages are
            # already user-honest — re-raise as the engine's error type so
            # they surface as messages, not tracebacks.
            raise ValueError(str(exc)) from exc
        finally:
            session_cm.__exit__(None, None, None)
        return
    if have_pfx:
        yield _load_signer_from_pfx(pfx_path, password)  # type: ignore[arg-type]
        return
    if have_pem:
        yield _load_signer_from_pem(key_path, cert_path, password)  # type: ignore[arg-type]
        return
    raise ValueError(
        "No signer given — provide a .pfx file, a PEM key + certificate, "
        "a PKCS#11 token, or a certificate from the Windows certificate store."
    )


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
    existing_field: str | None = None,
    allow_in_place: bool = False,
    pades: bool = False,
    tsa_url: str | None = None,
    embed_revocation: bool = False,
    lta: bool = False,
    trust_roots: list | None = None,
    system_trust: bool = False,
    eutl_trust: bool = False,
    pkcs11_module: str | None = None,
    pkcs11_token: str | None = None,
    pkcs11_pin: str = "",
    pkcs11_cert_label: str | None = None,
    pkcs11_key_label: str | None = None,
    store_cert: str | None = None,
    store_machine: bool = False,
    certify: bool = False,
    certify_level: str | None = None,
    lock: str | None = None,
    lock_fields: list | None = None,
    stamp_style: dict | None = None,
    font_dir: str = "",
) -> dict:
    """Apply a digital signature (signing APPENDS an incremental
    revision). ``output`` may be a new file OR the
    same path as ``file`` (in-place signing — the append is byte-safe over
    the original, and the write is atomic).

    Signer source: EXACTLY ONE of a PKCS#12 file (``pfx_path``), a PEM/DER
    key + certificate pair (``key_path`` + ``cert_path``; ``cert_path`` may be
    a fullchain file), a PKCS#11 token (``pkcs11_module`` +
    ``pkcs11_token`` + ``pkcs11_cert_label``, optional ``pkcs11_key_label``
    defaulting to the cert label, ``pkcs11_pin``), or a certificate in the
    Windows certificate store named by its SHA-1 thumbprint (``store_cert``,
    ``store_machine`` to read the machine store instead of the user's). The
    store source takes no secret from us at all: Windows collects any PIN or
    consent itself, inside the sign call. ``password`` unlocks the
    file-based sources (empty string for an unencrypted PEM key); the PIN
    unlocks the token, and like the password it is NEVER placed in results,
    errors, or logs. Every signing feature below — visible stamps,
    existing-field fill, in-place, PAdES/TSA/LTV/LTA — works identically
    with a token signer; the session stays open only for the signing step.

    Appearance: by default the signature is INVISIBLE. Passing ``appearance``
    = ``{page: <1-based>, rect: [x0,y0,x1,y1]}`` (PDF user-space points,
    bottom-up — the same convention as redaction regions) draws a visible
    stamp (signer, signing time, optional reason/location) at that box in a
    NEW signature field.

    Existing field: passing ``existing_field`` instead FILLS the
    named, already-present, EMPTY signature field — the field's own widget
    /Rect provides the stamp box (a zero-size widget signs invisibly, which
    is that field's design). Mutually exclusive with ``appearance`` (each
    decides the placement); refuses (before any signing work) when the field
    is missing, not a signature field, or already signed.

    SECURITY: the ``password`` is used only to load the signer and is NEVER
    placed in the return value, an error message, or any log. The result is
    self-verified via verify_signatures so the caller gets immediate
    confirmation.

    Args:
        file: Input PDF path.
        output: Output path for the signed PDF; may equal ``file`` (in place).
        pfx_path: PKCS#12 (.pfx/.p12) signer file.
        password: Passphrase for the signer (empty string if none).
        field_name: NEW signature field name (default "Signature1"); ignored
            when ``existing_field`` is given.
        reason / location: Optional signature metadata (not secret).
        key_path / cert_path: PEM/DER signer files (alternative to pfx_path).
        store_cert: SHA-1 thumbprint of a certificate in the Windows
            certificate store. Its private key stays inside the platform —
            only the signed-attributes digest crosses to it.
        store_machine: read the machine store rather than the user's.
        appearance: Optional visible-stamp placement (see above).
        existing_field: Name of an existing empty signature field to fill.
        trust_roots: CA certificate files anchoring the signer's own chain
            while revocation material is gathered for the DSS.
        system_trust: also anchor that gathering on the operating system's
            certificate store. Off by default, read only when True.
        eutl_trust: also anchor that gathering on the bundled EU trusted-list
            certificates. Off by default, read only when True.
        certify: Apply an AUTHOR (certification) signature, which records in
            the catalog what may change in the document afterwards. At most one
            per document, and it must be the document's first signature.
        certify_level: What the certification permits — ``"none"`` (no changes)
            / ``"form-fill"`` (form filling and signing) / ``"annotate"`` (form
            filling, signing and commenting), defaulting to ``"form-fill"``.
            Refuses without ``certify``: the level applies to approval
            signatures too under PDF 2.0, and writing one there produces an
            entry most readers disregard.
        lock: Which form fields this signature locks — ``"all"`` /
            ``"include"`` (only those named) / ``"exclude"`` (all but those
            named). Independent of ``certify``: a lock binds with no
            certification present, and one signature can carry both.
        lock_fields: The field names the two list actions name. Fully qualified;
            a name that scopes a subtree locks everything beneath it.
        stamp_style: What the visible stamp LOOKS like — which text lines it
            renders, a logo/background raster and whether the text sits over
            or beside it, and a personal-signature face. See
            `stamp_appearance.parse_appearance` for the full specification.
            Ignored by an invisible signature, which draws nothing; it travels
            every other placement, including the incremental append onto an
            already-signed document. Omitted, the stamp is the plain signer +
            timestamp one.
        font_dir: The app's bundled fonts directory, which is where a typed
            personal-signature face is resolved from. Never a system font.
    """
    input_path = Path(file)
    output_path = Path(output)
    # IN-PLACE signing (output == input) is allowed ONLY when the caller
    # explicitly opts in (`allow_in_place`, set by the undoable in-place flow).
    # Left global, removing the refusal would silently exempt the Save-a-copy
    # and canvas sign flows too, letting a save-dialog path that happens to
    # equal the working copy overwrite it outside the snapshot/undo flow.
    # pyHanko's IncrementalPdfFileWriter appends a
    # revision — `signed.getvalue()` is the original bytes verbatim + the
    # signature, never a re-serialization — and the input read handle is closed
    # before the write below, so writing back is byte-safe. The write is atomic
    # (temp → verify → os.replace), so a failed write OR a failed self-verify
    # can never leave a half-written or reported-failed-but-signed file.
    # Same file, not same spelling: a hard link resolves to two names and would
    # otherwise slip past the opt-in and overwrite the working copy.
    if is_same_file(str(input_path), str(output_path)) and not allow_in_place:
        raise ValueError("The signed output must be a different file from the input.")

    if existing_field is not None and appearance is not None:
        raise ValueError(
            "Choose ONE placement: fill an existing signature field, or place a new visible stamp."
        )

    # Certification is orthogonal to placement, signer source and PAdES
    # profile; only the document's own state can refuse it.
    existing_certification = _certification_refusals(file, certify, certify_level)
    # A NEW field's name is not in the document yet, so it cannot appear in the
    # list without refusing as a missing name first; only the existing-field
    # path can name its own target.
    lock_spec = _validated_lock(file, lock, lock_fields, existing_field)
    # The appearance is validated and its rasters decoded HERE, before any
    # signer is opened: a store or token signer holds a live key handle inside
    # the `with signer_cm` block below, and a refusal or a slow image decode
    # must never happen while a smart-card session is open.
    stamp_appearance_spec = stamp_appearance.parse_appearance(stamp_style, font_dir)

    signer_cm = _signer_source(
        pfx_path, password, key_path, cert_path,
        pkcs11_module, pkcs11_token, pkcs11_pin, pkcs11_cert_label, pkcs11_key_label,
        store_cert, store_machine,
    )

    placement = _validated_appearance(appearance, file) if appearance is not None else None
    if existing_field is not None:
        _validated_existing_field(file, existing_field)
        _existing_field_lock_refusal(file, existing_field, lock_spec)
        field_name = existing_field
    else:
        # A NEW signature field — rotate the name off any already-present field
        # so signing a document that already carries "Signature1" cannot
        # collide. This does not touch the existing-field
        # path, which targets a specific named field on purpose.
        field_name = _free_field_name(file, field_name)

    # ── PAdES / TSA / LTV ────────────────────────────────────────────────
    # B-B  = pades (ETSI.CAdES.detached subfilter)
    # B-T  = + tsa_url (RFC 3161 timestamp from the user's chosen TSA)
    # B-LT = + embed_revocation (certs + revocation data into the /DSS)
    # B-LTA= + lta (a document timestamp sealing the DSS; needs the TSA)
    # The TSA and revocation fetches are network calls only to endpoints the
    # user configured; they never use a bundled service.
    tsa_url = (tsa_url or "").strip() or None
    if lta and not pades:
        raise ValueError("PAdES B-LTA requires PAdES mode.")
    if lta and not tsa_url:
        raise ValueError("PAdES B-LTA requires a timestamp server (TSA URL).")
    if embed_revocation and not pades:
        raise ValueError("Embedding revocation info (LTV) requires PAdES mode.")
    timestamper = _make_timestamper(tsa_url) if tsa_url else None

    # The signer stays live through the signing itself — a PKCS#11 source
    # holds an open token session here (closed as soon as the signed bytes
    # exist; the write/verify below needs no signer).
    with signer_cm as signer:
        meta_kwargs: dict = {"field_name": field_name, "reason": reason, "location": location}
        if pades:
            meta_kwargs["subfilter"] = SigSeedSubFilter.PADES
        if embed_revocation:
            # Validating the signer's own chain is a precondition for gathering
            # the revinfo that goes into the DSS. Anchors: the user's roots,
            # plus each opted-in source, or — for a self-signed signer — its own
            # certificate.
            anchors = _load_trust_roots(trust_roots or [])
            if system_trust:
                anchors = [*anchors, *os_trust.anchors(os_trust.SIGNER_PURPOSES)]
            if eutl_trust:
                anchors = [*anchors, *eutl.anchors(eutl.SIGNER)]
            if not anchors:
                anchors = [signer.signing_cert, *signer.cert_registry]
            meta_kwargs["embed_validation_info"] = True
            meta_kwargs["validation_context"] = ValidationContext(
                trust_roots=anchors, allow_fetching=True, retroactive_revinfo=True
            )
        if lta:
            meta_kwargs["use_pades_lta"] = True
        if certify:
            meta_kwargs["certify"] = True
            meta_kwargs["docmdp_permissions"] = _MDP_PERM_BY_LEVEL[certify_level or "form-fill"]
        meta = signers.PdfSignatureMetadata(**meta_kwargs)
        try:
            with open(file, "rb") as inf:
                writer = IncrementalPdfFileWriter(inf)
                # A lock rides the signature FIELD, never the metadata: the
                # signing machinery reads it off the field's /Lock and turns it
                # into the signature's /FieldMDP transform. So each placement
                # carries it through that placement's own door.
                if existing_field is not None:
                    # existing_fields_only is the fail-closed backstop: pyHanko will
                    # refuse to CREATE a field here, so a lookup miss can never
                    # silently turn into a new invisible signature. The stamp style
                    # draws in the field's own widget rect (zero-size -> invisible).
                    if lock_spec is not None:
                        _seed_existing_field_lock(writer, field_name, lock_spec)
                    pdf_signer = signers.PdfSigner(
                        meta, signer=signer, stamp_style=_stamp_style(reason, location, stamp_appearance_spec),
                        timestamper=timestamper,
                    )
                    signed = pdf_signer.sign_pdf(writer, existing_fields_only=True)
                elif placement is not None:
                    page_ix, box = placement
                    fields.append_signature_field(
                        writer,
                        sig_field_spec=fields.SigFieldSpec(
                            field_name, on_page=page_ix, box=box, field_mdp_spec=lock_spec
                        ),
                    )
                    pdf_signer = signers.PdfSigner(
                        meta, signer=signer, stamp_style=_stamp_style(reason, location, stamp_appearance_spec),
                        timestamper=timestamper,
                    )
                    signed = pdf_signer.sign_pdf(writer)
                else:
                    signed = signers.sign_pdf(
                        writer, meta, signer=signer, timestamper=timestamper,
                        new_field_spec=(
                            fields.SigFieldSpec(field_name, field_mdp_spec=lock_spec)
                            if lock_spec is not None
                            else None
                        ),
                    )
        except SigningError:
            _raise_mapped_signing_refusal(certify, existing_certification)
    # Fail closed + atomic: write the signed bytes to a temp beside the output,
    # Self-verify the temporary file before replacement. This keeps the
    # in-place case honest: a transient
    # verify failure (e.g. an AV scanner briefly locking the just-written file)
    # discards the temp and leaves the original untouched — never "reported
    # failure while the working copy is already signed". The returned dict
    # carries NO secret.
    import os
    import tempfile

    out_dir = output_path.parent
    fd, tmp_name = tempfile.mkstemp(suffix=".pdf", dir=str(out_dir))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(signed.getvalue())
        # The temp holds exactly the bytes that will land at output_path, so its
        # verification is the output's — computed while a failure is still fully
        # recoverable.
        verification = verify_signatures(tmp_name)
        # Fail closed on the verdict, not only on an exception: a signature
        # that does not verify against its own bytes is broken output, and
        # letting it land while merely reporting `valid: false` puts a file the
        # user believes is signed where the original was. `valid`/`intact` are
        # crypto-and-coverage facts, independent of trust anchors, so a
        # self-signed or untrusted-but-correct signer still passes here.
        _refuse_unverifiable_output(verification, field_name)
        # Read back out of the WRITTEN bytes, never echoed from the request —
        # the same discipline as the valid/intact fields beside it.
        written_certification = certification_of_file(tmp_name)
        os.replace(tmp_name, output_path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise

    sig = next(
        (s for s in verification["signatures"] if s.get("field") == field_name),
        verification["signatures"][-1] if verification["signatures"] else None,
    )
    written_lock = (sig or {}).get("lock") or {}
    return {
        "output": str(output_path),
        "field": field_name,
        "signer": sig["signer"] if sig else None,
        "valid": sig["valid"] if sig else False,
        "intact": sig["intact"] if sig else False,
        "covers_whole_document": sig["covers_whole_document"] if sig else False,
        "signature_count": verification["signature_count"],
        "certified": bool(written_certification["certified"]),
        "certification_level": written_certification["level"],
        # Read back from the written signature, never echoed from the request:
        # a field that already carried its own /Lock imposes it whether or not
        # one was asked for.
        "lock": written_lock.get("action"),
        "lock_fields": written_lock.get("fields", []),
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
