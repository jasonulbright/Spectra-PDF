"""MAINTENANCE TOOL, not a build step. Fetches the platform root-certificate
program's published trust list once, at a pinned moment, and writes the
certificate bundle under `src/engine/trust/msctl/`.

The app never fetches a trust feed at run time, so the bundle is a shipped
resource in the class of the spelling dictionaries: fetched here, verified
here, reviewed as a git diff, committed. `src/engine` is already a packaged
resource, so the bundle rides along with no packaging change.

TWO ARTEFACTS, AND THE DISTINCTION IS THE WHOLE DESIGN

  The signed trust list (a CMS SignedData carrying a CTL) is the AUTHORITY: it
  states which subjects are in the program and, per subject, the trust
  properties — the granted purposes, a disallowed-after moment, a per-purpose
  denial. It carries NO certificate bytes.

  The serialized certificate store is the MATERIAL: the certificate bytes, plus
  a copy of the same properties. It is NOT signed, and it is produced from a
  plain-HTTP distribution point.

  So the properties are read from the SIGNED list and the bytes from the store,
  joined on the SHA-1 the list uses as its subject identifier. A certificate the
  signed list does not name is EXCLUDED — anchoring it would mean anchoring an
  unauthenticated download. Reading the properties from the store instead would
  mean letting an unauthenticated file widen the grant.

WHAT THIS PROVES BEFORE IT WRITES ANYTHING

  1. The list's CMS signature verifies offline: the encapsulated content digest
     matches the signed `message-digest` attribute, the signed `content-type`
     attribute names the CTL content type, and the signature over the signed
     attributes verifies under the signer's public key.
  2. The signer certificate is issued by one of the pinned issuers in
     `msctl-ctl-signers.pem`, proven by verifying the signer's own signature
     under the pinned issuer's key — not by name comparison. The issuing
     authority's name embeds a year and WILL rotate; a changed pin is a reviewed
     git diff, never an automatic accept.
  3. Every certificate taken from the store hashes to a subject the signed list
     names, and its property blobs are byte-identical to the signed list's.
  4. Distrust is modelled, not just the grant. A subject whose disallowed-after
     moment has passed is DROPPED. A subject carrying a per-purpose denial has
     those purposes SUBTRACTED from its grant. A subject with no purpose
     property at all is treated as unrestricted, which is what the platform's
     own store enumeration reports for such a root.
  5. The written anchors are re-checked against the naive read: no subject the
     distrust properties excluded may appear in the output, and the honest sets
     must be subsets of the naive ones. A failure here refuses the write.

Anything that does not hold is a refusal, and nothing is written after one.

THE ISSUANCE-DATE CONSTRAINT, AND WHICH PROPERTY ACTUALLY CARRIES IT

  A subject may be in the program only for certificates it issued BEFORE a
  stated moment: the authority is not withdrawn, but nothing it signed after
  that moment is an authority's work. That constraint is carried by property
  126, an 8-byte FILETIME, optionally narrowed by property 127, a list of the
  purpose OIDs it applies to. Property 127 absent means it applies to every
  purpose.

  Property 83 is root-program certificate POLICIES and carries no date: it
  decodes as an X.509 CertificatePolicies whose every qualifier is the
  program's own flags identifier (1.3.6.1.4.1.311.60.1.1) over a BIT STRING.
  It is parsed and counted here, and the parse REFUSES if a qualifier ever
  carries a time — the reading that says "83 holds no date" has to be
  re-proven on every fetch rather than remembered from one measurement.

  The cutoff is written out per anchor (``msctl-constraints.json``, keyed by
  the SHA-256 the runtime identifies an anchor by) because a PEM file has no
  room for it. ``engine/msctl.py`` reads it and the validator refuses a chain
  whose issued certificate postdates its anchor's cutoff.

  A subject whose cutoff has already passed is NOT dropped: it stays a valid
  authority for everything it issued before that moment, and dropping it would
  refuse signatures the program still vouches for.

REFRESH

  A later run REMOVES anchors as subjects are withdrawn. The counts and the
  exclusion tally are printed and written into the manifest for exactly that
  reason: a silently shrinking bundle is the failure that reads as a bug months
  later. The issuing authority's name embeds a year and will rotate; a changed
  pin is a reviewed git diff, never an automatic accept.

Run: .venv/Scripts/python.exe scripts/fetch-msctl.py
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import requests
from asn1crypto import algos, cms, core, pem
from asn1crypto import x509 as ax509
from cryptography.hazmat.primitives import hashes as chashes
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from engine.os_trust import (  # noqa: E402  — after the path insertion
    SIGNER_PURPOSES,
    TIMESTAMP_PURPOSES,
    _ANY_PURPOSE,
)

CTL_URL = (
    "http://ctldl.windowsupdate.com/msdownload/update/v3/static/trustedr/en/"
    "authrootstl.cab"
)
CTL_MEMBER = "authroot.stl"

#: The CTL content type. A SignedData encapsulating anything else is not a
#: trust list and is refused before its payload is looked at.
OID_CTL = "1.3.6.1.4.1.311.10.1"
OID_CONTENT_TYPE = "1.2.840.113549.1.9.3"
OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4"

#: Per-subject trust properties, as the signed list carries them: the property
#: id appended to this arc. The store records the same ids as bare integers.
PROPERTY_ARC = "1.3.6.1.4.1.311.10.11."

PROP_ENHANCED_KEY_USAGE = 9  # the grant: a SEQUENCE OF purpose OIDs
PROP_SHA1 = 3  # store-only; the signed list uses it as the subject identifier
PROP_DISALLOWED_AFTER = 104  # a FILETIME; past means the subject is dropped
PROP_DISALLOWED_PURPOSES = 122  # purposes SUBTRACTED from the grant
#: Root-program certificate policies: an X.509 CertificatePolicies carrying the
#: program's own flags. Parsed to PROVE it carries no date (see the module
#: docstring) rather than to model anything, and counted.
PROP_ROOT_PROGRAM_POLICIES = 83
#: The issuance cutoff: a FILETIME, after which nothing the subject issued is an
#: authority's work. The subject itself stays an authority.
PROP_NOT_BEFORE = 126
#: The purposes PROP_NOT_BEFORE applies to. Absent means every purpose.
PROP_NOT_BEFORE_PURPOSES = 127

#: The one qualifier identifier property 83 is observed to carry. Its value is a
#: BIT STRING of program flags.
OID_ROOT_PROGRAM_FLAGS = "1.3.6.1.4.1.311.60.1.1"
#: ASN.1 tags for the two time types. A property-83 qualifier carrying one of
#: these would mean the date constraint lives somewhere this tool does not read,
#: so it is a refusal rather than a silently ignored field.
_TIME_TAGS = (0x17, 0x18)

#: The store format: an 8-byte header, then property records, where a record
#: with this id carries a DER certificate and closes the group before it.
STORE_HEADER = b"\x00\x00\x00\x00CERT"
STORE_CERTIFICATE = 0x20

_FILETIME_EPOCH = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)


def _header_length(tlv: bytes) -> int:
    """The length of one BER/DER tag-and-length header.

    The trust list is BER: its lengths are long-form even where a short form
    would do, so a header cannot be assumed to be two bytes and the inner value
    cannot be found by searching for the next SEQUENCE tag — the first one found
    is inside the value.
    """
    if len(tlv) < 2:
        raise Refused("a truncated ASN.1 element")
    if tlv[0] & 0x1F == 0x1F:
        raise Refused("a multi-byte ASN.1 tag where a simple one is required")
    if tlv[1] == 0x80:
        raise Refused("an indefinite-length ASN.1 element")
    return 2 + (tlv[1] & 0x7F if tlv[1] & 0x80 else 0)


class Refused(Exception):
    """A verification that did not hold. Nothing is written after one."""


class _PurposeList(core.SequenceOf):
    _child_spec = core.ObjectIdentifier


class _SetOfAny(core.SetOf):
    _child_spec = core.Any


class _SubjectAttribute(core.Sequence):
    _fields = [("type", core.ObjectIdentifier), ("values", _SetOfAny)]


class _SubjectAttributes(core.SetOf):
    _child_spec = _SubjectAttribute


class _TrustedSubject(core.Sequence):
    _fields = [
        ("subject_identifier", core.OctetString),
        ("subject_attributes", _SubjectAttributes, {"optional": True}),
    ]


class _TrustedSubjects(core.SequenceOf):
    _child_spec = _TrustedSubject


class CertificateTrustList(core.Sequence):
    """The CTL payload. `asn1crypto` ships no specification for it; this is the
    published structure, and the optional fields are optional in the wild."""

    _fields = [
        ("subject_usage", core.Any),
        ("list_identifier", core.OctetString, {"optional": True}),
        ("sequence_number", core.Integer, {"optional": True}),
        ("this_update", core.UTCTime),
        ("next_update", core.UTCTime, {"optional": True}),
        ("subject_algorithm", algos.DigestAlgorithm),
        ("trusted_subjects", _TrustedSubjects, {"optional": True}),
        ("ctl_extensions", core.Any, {"optional": True, "explicit": 0}),
    ]


# ─────────────────────────────── transport ────────────────────────────────


def fetch(url: str) -> bytes:
    """The signed list, over the distribution point's plain HTTP.

    Authenticity comes from the CMS signature and the pinned issuer, never from
    the channel — which is why the transport being unprotected is stated here
    rather than papered over. A forged download fails `verify_signed_list`.
    """
    response = requests.get(url, timeout=180)
    response.raise_for_status()
    return response.content


def expand_cabinet(cabinet: bytes, member: str, workspace: Path) -> bytes:
    """The one member out of the downloaded cabinet.

    The platform's own expander is used rather than a hand-rolled decompressor:
    this is a maintenance tool that runs on the platform whose program is being
    read, and a decompressor written here would be one more thing to be wrong.
    """
    if shutil.which("expand") is None:
        raise Refused("no cabinet expander on this host; run this on Windows")
    source = workspace / "authrootstl.cab"
    source.write_bytes(cabinet)
    destination = workspace / member
    result = subprocess.run(
        ["expand", str(source), f"-F:{member}", str(destination)],
        capture_output=True,
        text=True,
    )
    if not destination.is_file():
        raise Refused(f"cabinet did not yield {member}: {result.stdout.strip()}")
    return destination.read_bytes()


def generate_store(workspace: Path) -> bytes:
    """The certificate material, produced by the platform's own tool.

    This is the only way to obtain the program's certificate bytes as one file.
    The bytes it produces are NOT trusted on the strength of having come from
    it: every certificate is matched against the signed list before it can
    anchor anything.
    """
    if shutil.which("certutil") is None:
        raise Refused("no certutil on this host; run this on Windows")
    destination = workspace / "roots.sst"
    result = subprocess.run(
        ["certutil", "-generateSSTFromWU", str(destination)],
        capture_output=True,
        text=True,
    )
    if not destination.is_file():
        raise Refused(
            "certutil produced no certificate store "
            f"({(result.stderr or result.stdout).strip()[:200]})"
        )
    return destination.read_bytes()


# ───────────────────────── the signed list's signature ─────────────────────


def _verify_under(
    public_key,
    signature: bytes,
    message: bytes,
    algorithm: str,
    digest_name: str | None = None,
) -> None:
    """One signature check.

    `digest_name` is separate because a CMS signer names its digest in its own
    field and its signature algorithm carries none (`rsassa_pkcs1v15`), while a
    certificate's signature algorithm names both.
    """
    digest = {
        "sha1": chashes.SHA1,
        "sha256": chashes.SHA256,
        "sha384": chashes.SHA384,
        "sha512": chashes.SHA512,
    }
    name = digest_name or next(
        (n for n in digest if n in algorithm.replace("_", "")), None
    )
    if name not in digest:
        raise Refused(f"unsupported signature algorithm: {algorithm} / {digest_name}")
    chosen = digest[name]()
    if isinstance(public_key, rsa.RSAPublicKey):
        if "pss" in algorithm:
            public_key.verify(
                signature,
                message,
                padding.PSS(mgf=padding.MGF1(chosen), salt_length=chosen.digest_size),
                chosen,
            )
        else:
            public_key.verify(signature, message, padding.PKCS1v15(), chosen)
    elif isinstance(public_key, ec.EllipticCurvePublicKey):
        public_key.verify(signature, message, ec.ECDSA(chosen))
    else:
        raise Refused(f"unsupported signing key: {type(public_key).__name__}")


def _public_key(certificate: ax509.Certificate):
    return serialization.load_der_public_key(
        certificate["tbs_certificate"]["subject_public_key_info"].dump()
    )


def _signed_attribute(signer_info, oid: str):
    for attribute in signer_info["signed_attrs"]:
        if attribute["type"].dotted == oid:
            return attribute["values"][0]
    return None


def verify_signed_list(data: bytes) -> tuple[bytes, ax509.Certificate, list]:
    """Verify the list's CMS signature end to end.

    Returns `(ctl payload bytes, signer certificate, embedded certificates)`.
    Raises `Refused` on anything that does not hold.

    Both bindings are checked, because either one alone proves nothing: the
    signature proves the signed attributes are the signer's, and the
    `message-digest` attribute is what binds those attributes to the payload.
    A verifier that checks only the signature accepts any payload.
    """
    try:
        info = cms.ContentInfo.load(data)
        # The load is lazy, so the first field read is where malformed bytes
        # actually surface. Both belong inside the same refusal.
        outer_type = info["content_type"].native
    except Exception as exc:  # noqa: BLE001
        raise Refused(f"the trust list is not CMS ({type(exc).__name__})") from None
    if outer_type != "signed_data":
        raise Refused(f"the trust list is not SignedData: {outer_type}")
    signed = info["content"]

    encapsulated = signed["encap_content_info"]
    if encapsulated["content_type"].dotted != OID_CTL:
        raise Refused(
            f"encapsulated content is not a trust list: "
            f"{encapsulated['content_type'].dotted}"
        )
    # The encapsulated content is the trust list SEQUENCE inside the CMS
    # explicit tag — not the OCTET STRING the CMS structure nominally carries,
    # so it is taken as raw octets and the tag stripped by measuring its header.
    # A reader that insists on the OCTET STRING cannot represent this content at
    # all, which is a refusal rather than a traceback.
    try:
        wrapper = encapsulated["content"].dump()
    except Exception as exc:  # noqa: BLE001
        raise Refused(
            f"the encapsulated trust list does not parse ({type(exc).__name__})"
        ) from None
    if not wrapper:
        raise Refused("the trust list carries no encapsulated content")
    payload = wrapper[_header_length(wrapper):]

    infos = signed["signer_infos"]
    if len(infos) != 1:
        raise Refused(f"expected exactly one signer, found {len(infos)}")
    signer_info = infos[0]
    if signer_info["signed_attrs"] is core.VOID or signer_info["signed_attrs"] is None:
        raise Refused("the signature carries no signed attributes")

    declared_type = _signed_attribute(signer_info, OID_CONTENT_TYPE)
    if declared_type is None or declared_type.native != OID_CTL:
        raise Refused("the signed content-type attribute does not name a trust list")

    digest_algorithm = signer_info["digest_algorithm"]["algorithm"].native
    # The digest covers the trust list SEQUENCE's CONTENTS, not the element:
    # the producer treats the encapsulated value's octets as the content the way
    # an OCTET STRING eContent would be treated. Digesting the whole element
    # instead fails to reproduce the published digest — measured, and the
    # difference is exactly one header.
    try:
        computed = hashlib.new(
            digest_algorithm.replace("_", ""), payload[_header_length(payload):]
        ).digest()
    except ValueError:
        raise Refused(f"unsupported digest algorithm: {digest_algorithm}") from None
    declared_digest = _signed_attribute(signer_info, OID_MESSAGE_DIGEST)
    if declared_digest is None:
        raise Refused("the signature carries no message-digest attribute")
    if declared_digest.native != computed:
        raise Refused("the signed message-digest does not match the trust list payload")

    # A certificate set may carry alternatives that are not certificates at all
    # (attribute certificates, the `other` escape). Taking `.chosen` blindly
    # hands the pin logic an object with no issuer.
    certificates = [
        entry.chosen for entry in signed["certificates"] if entry.name == "certificate"
    ]
    if not certificates:
        raise Refused("the trust list embeds no certificates")
    identifier = signer_info["sid"]
    signer_certificate = None
    for certificate in certificates:
        if identifier.name == "issuer_and_serial_number":
            if (
                certificate.issuer == identifier.chosen["issuer"]
                and certificate.serial_number == identifier.chosen["serial_number"].native
            ):
                signer_certificate = certificate
        elif identifier.chosen.native == certificate.key_identifier:
            signer_certificate = certificate
    if signer_certificate is None:
        raise Refused("the signer certificate is not embedded in the trust list")

    try:
        _verify_under(
            _public_key(signer_certificate),
            signer_info["signature"].native,
            signer_info["signed_attrs"].untag().dump(),
            signer_info["signature_algorithm"]["algorithm"].native,
            digest_algorithm.replace("_", ""),
        )
    except Refused:
        raise
    except Exception as exc:  # noqa: BLE001
        raise Refused(
            f"the trust list signature does not verify ({type(exc).__name__})"
        ) from None
    return payload, signer_certificate, certificates


#: Artefacts whose presence proves this bundle has been fetched and committed
#: before. If any of them is here, the pin belongs here too.
BUNDLE_ARTEFACTS = (
    "msctl-manifest.json",
    "msctl-signers.pem",
    "msctl-timestamp.pem",
    "msctl-certificates.tsv",
)


def guard_missing_pin(destination: Path, pin_path: Path, *, first_fetch: bool) -> None:
    """Refuse to re-pin trust-on-first-use over an already-pinned bundle.

    An absent pin file makes :func:`authenticate_signer` accept whatever the
    download claims and write it out as the new pin. That is right exactly
    once. Once the bundle exists, a missing pin is a deleted pin — a fetch that
    silently re-pins under it authenticates nothing, and the only backstop is a
    human noticing one word in the manifest diff. So: absent pin plus an
    existing bundle is a refusal, and ``--first-fetch`` is the way to say the
    trust-on-first-use is intended.
    """
    if first_fetch or pin_path.is_file():
        return
    present = [name for name in BUNDLE_ARTEFACTS if (destination / name).is_file()]
    if present:
        raise Refused(
            f"{pin_path.name} is missing but this bundle is already committed "
            f"({', '.join(present)}). Fetching now would trust whatever the "
            "download claims and write it out as the new pin. Restore the pin "
            "from git, or pass --first-fetch to pin afresh on purpose"
        )


def load_pinned(path: Path) -> list:
    """The pinned issuing certificates. Empty when the pin file does not exist
    yet, which is the first-fetch case: the issuer is written out and the diff
    is the review. :func:`guard_missing_pin` is what keeps that case from
    silently recurring after the bundle exists."""
    if not path.is_file():
        return []
    return [
        ax509.Certificate.load(der)
        for _type, _headers, der in pem.unarmor(path.read_bytes(), multiple=True)
    ]


def authenticate_signer(
    signer: ax509.Certificate, embedded: list, pinned: list
) -> tuple[str, list]:
    """How the signer is authenticated, and the issuers to pin going forward.

    A pinned issuer authenticates the signer only by having actually signed it:
    the signer's own signature is verified under the pinned key. A name match
    would authenticate nothing, and the issuing authority's name embeds a year
    that will change.
    """
    issuers = [
        certificate
        for certificate in embedded
        if certificate.subject == signer.issuer and certificate is not signer
    ]
    if not issuers:
        raise Refused("the trust list embeds no issuer for its signer")

    if not pinned:
        return "first-fetch", issuers

    pinned_by_fingerprint = {certificate.sha256 for certificate in pinned}
    for issuer in issuers:
        if issuer.sha256 not in pinned_by_fingerprint:
            continue
        try:
            _verify_under(
                _public_key(issuer),
                signer["signature_value"].native,
                signer["tbs_certificate"].dump(),
                signer["signature_algorithm"]["algorithm"].native,
            )
        except Exception as exc:  # noqa: BLE001
            raise Refused(
                f"the signer is not validly issued by its pinned issuer "
                f"({type(exc).__name__})"
            ) from None
        return "pinned", issuers
    raise Refused(
        "the trust list signer is issued by an authority this bundle does not pin; "
        "review the change and re-pin deliberately"
    )


# ──────────────────────────── the two artefacts ────────────────────────────


def subjects_in(payload: bytes) -> tuple[CertificateTrustList, dict]:
    """`(the parsed list, {subject sha-1 hex: {property id: blob}})`."""
    try:
        listing = CertificateTrustList.load(payload)
    except Exception as exc:  # noqa: BLE001
        raise Refused(f"the trust list payload does not parse ({type(exc).__name__})")
    subjects: dict[str, dict[int, bytes]] = {}
    for subject in listing["trusted_subjects"] or []:
        properties: dict[int, bytes] = {}
        attributes = subject["subject_attributes"]
        if attributes is not None:
            for attribute in attributes:
                dotted = attribute["type"].dotted
                if not dotted.startswith(PROPERTY_ARC):
                    continue
                try:
                    identifier = int(dotted[len(PROPERTY_ARC):])
                except ValueError:
                    continue
                values = [
                    core.OctetString.load(value.dump()).native
                    for value in attribute["values"]
                ]
                if len(values) == 1:
                    properties[identifier] = values[0]
        subjects[subject["subject_identifier"].native.hex()] = properties
    return listing, subjects


def certificates_in(store: bytes) -> dict:
    """`{sha-1 hex: (der, {property id: blob})}` from the serialized store.

    A store record's properties accumulate until a certificate record closes the
    group. The properties are read only so they can be checked against the
    signed list's; the signed list is what the grant is taken from.
    """
    if store[:8] != STORE_HEADER:
        raise Refused("the certificate store does not carry a store header")
    found: dict[str, tuple[bytes, dict]] = {}
    pending: dict[int, bytes] = {}
    offset = 8
    while offset + 12 <= len(store):
        identifier, _encoding, length = struct.unpack_from("<III", store, offset)
        offset += 12
        value = store[offset : offset + length]
        offset += length
        if identifier == 0:
            break
        if identifier == STORE_CERTIFICATE:
            found[hashlib.sha1(value).hexdigest()] = (value, pending)
            pending = {}
        else:
            pending[identifier] = value
    return found


def purposes_in(blob: bytes | None) -> set | None:
    """The purpose OIDs in one property blob, or None when the property is
    absent. None is NOT the empty set: a subject with no purpose property is
    unrestricted, which is what the platform's store enumeration reports for
    one, and the empty set would silently drop it instead."""
    if not blob:
        return None
    try:
        return {oid.dotted for oid in _PurposeList.load(blob)}
    except Exception:  # noqa: BLE001
        raise Refused("a purpose property does not parse as a list of purposes")


def disallowed_after(blob: bytes | None) -> datetime.datetime | None:
    """The moment after which the subject is not an authority, or None."""
    if not blob or len(blob) != 8:
        return None
    ticks = struct.unpack("<Q", blob)[0]
    if not ticks:
        return None
    return _FILETIME_EPOCH + datetime.timedelta(microseconds=ticks // 10)


#: The issuance cutoff shares the disallowed-after encoding exactly — one
#: FILETIME — and differs only in what it means, so it shares the reader.
not_before_cutoff = disallowed_after


def root_program_policies(blob: bytes | None) -> int:
    """How many policy entries property 83 carries, having PROVEN it carries no
    date.

    The proof, not the count, is the reason this parses at all: the constraint
    on issuance dates lives in property 126, and the claim that 83 does not also
    carry one must be re-established against each published list rather than
    remembered. A qualifier holding a time means that claim has stopped being
    true and the tool refuses rather than writing a bundle whose date modelling
    is now incomplete.
    """
    if not blob:
        return 0
    try:
        policies = ax509.CertificatePolicies.load(blob)
        entries = [
            (qualifier["policy_qualifier_id"].dotted, qualifier["qualifier"].dump())
            for policy in policies
            for qualifier in (policy["policy_qualifiers"] or [])
        ]
    except Exception:  # noqa: BLE001
        raise Refused("a root-program policy property does not parse as policies")
    for identifier, value in entries:
        if identifier != OID_ROOT_PROGRAM_FLAGS:
            raise Refused(
                f"a root-program policy carries an unknown qualifier {identifier}; "
                "review it before trusting this bundle's date modelling"
            )
        if value and value[0] in _TIME_TAGS:
            raise Refused(
                "a root-program policy qualifier carries a time; the issuance "
                "constraint is no longer only property 126"
            )
    return len(policies)


# ──────────────────── the grant, minus the distrust ────────────────────────


def classify(material: dict, subjects: dict, now: datetime.datetime | None = None) -> dict:
    """Which certificates anchor which chain, and why the rest do not.

    Pure, so the distrust modelling can be exercised without a network or a
    platform: `material` is `{sha-1: (der, store properties)}` and `subjects` is
    the signed list's `{sha-1: {property id: blob}}`.

    Three distrust properties, and honesty needs all three:

      * a disallowed-after moment in the past DROPS the subject entirely;
      * a per-purpose denial is SUBTRACTED from the grant, which can leave a
        subject anchoring one chain and not the other, or neither;
      * no purpose property at all is UNRESTRICTED, mirroring how the platform's
        own store enumeration reports such a root — a trust-widening default,
        and the one place this reads a behaviour rather than a stated rule.

    The naive sets are computed alongside, from the grant with no distrust
    applied, so `prove` can check the honest read against them rather than
    against an expectation written down separately.
    """
    now = now or datetime.datetime.now(datetime.timezone.utc)
    signer_anchors: list = []
    timestamp_anchors: list = []
    rows: list = []
    naive_signer: set = set()
    naive_timestamp: set = set()
    dropped_by_date: set = set()
    excluded = {
        "not_named_by_signed_list": 0,
        "properties_disagree_with_signed_list": 0,
        "disallowed_after_a_past_moment": 0,
        "no_purpose_this_bundle_anchors": 0,
    }
    trimmed_by_denial = 0
    unrestricted = 0
    root_program_policy_subjects = 0
    constraints: dict = {}

    for fingerprint, (der, store_properties) in sorted(material.items()):
        properties = subjects.get(fingerprint)
        if properties is None:
            excluded["not_named_by_signed_list"] += 1
            continue
        # The store's copy of the properties must agree with the signed list's,
        # or one of the two artefacts is not what it claims to be, and which one
        # is wrong cannot be told from here. Compared in BOTH directions: a
        # property the store omits is as much a disagreement as one it changes.
        # Property 3 is the SHA-1, which the signed list carries as the subject
        # identifier rather than as a property, so it is not a disagreement.
        comparable = {k: v for k, v in store_properties.items() if k != PROP_SHA1}
        if set(comparable) != set(properties) or any(
            properties[k] != v for k, v in comparable.items()
        ):
            excluded["properties_disagree_with_signed_list"] += 1
            continue

        granted = purposes_in(properties.get(PROP_ENHANCED_KEY_USAGE))
        if granted is None:
            unrestricted += 1
            granted = {_ANY_PURPOSE}
        if granted & SIGNER_PURPOSES:
            naive_signer.add(fingerprint)
        if granted & TIMESTAMP_PURPOSES:
            naive_timestamp.add(fingerprint)

        expiry = disallowed_after(properties.get(PROP_DISALLOWED_AFTER))
        if expiry is not None and expiry <= now:
            excluded["disallowed_after_a_past_moment"] += 1
            dropped_by_date.add(fingerprint)
            continue
        denied = purposes_in(properties.get(PROP_DISALLOWED_PURPOSES))
        if denied:
            trimmed_by_denial += 1
            granted = granted - denied

        is_signer = bool(granted & SIGNER_PURPOSES)
        is_timestamp = bool(granted & TIMESTAMP_PURPOSES)
        if not is_signer and not is_timestamp:
            excluded["no_purpose_this_bundle_anchors"] += 1
            continue
        if PROP_ROOT_PROGRAM_POLICIES in properties:
            # Parsed for its refusals, not its count — see root_program_policies.
            root_program_policies(properties[PROP_ROOT_PROGRAM_POLICIES])
            root_program_policy_subjects += 1
        if is_signer:
            signer_anchors.append(der)
        if is_timestamp:
            timestamp_anchors.append(der)

        # The issuance cutoff is carried per anchor rather than applied here: a
        # subject past its cutoff is still the authority for everything it
        # issued before it, so this is an input to path validation and not a
        # reason to drop anything.
        cutoff = not_before_cutoff(properties.get(PROP_NOT_BEFORE))
        cutoff_purposes = purposes_in(properties.get(PROP_NOT_BEFORE_PURPOSES))
        if cutoff is not None:
            constraints[hashlib.sha256(der).hexdigest()] = {
                "not_before": cutoff.isoformat(),
                # None, not the empty list: no purpose property means EVERY
                # purpose, and the empty list would mean none of them.
                "purposes": sorted(cutoff_purposes) if cutoff_purposes else None,
            }
        rows.append({
            "sha1": fingerprint,
            "sha256": hashlib.sha256(der).hexdigest(),
            "purposes": ",".join(
                name
                for name, on in (("signer", is_signer), ("timestamp", is_timestamp))
                if on
            ),
            "restricted": expiry.date().isoformat() if expiry is not None else "",
            "issued_before": cutoff.date().isoformat() if cutoff is not None else "",
            "subject": subject_of(der),
        })

    return {
        "signer_anchors": signer_anchors,
        "timestamp_anchors": timestamp_anchors,
        "rows": rows,
        "excluded": excluded,
        "trimmed_by_denial": trimmed_by_denial,
        "unrestricted": unrestricted,
        "root_program_policy_subjects": root_program_policy_subjects,
        "constraints": constraints,
        "naive_signer": naive_signer,
        "naive_timestamp": naive_timestamp,
        "dropped_by_date": dropped_by_date,
    }


def prove(verdict: dict, require_a_dated_exclusion: bool = False) -> None:
    """Re-check the classification against the naive read before anything is
    written. A distrust rule that silently stopped being applied would otherwise
    ship as a quietly wider anchor set, which is the failure this whole design
    exists to avoid.

    `require_a_dated_exclusion` is the live-data assertion: the published list
    always carries withdrawn subjects, so a run that excluded none of them
    excluded none because the property stopped being read. It is off for a
    synthetic input that legitimately has none.
    """
    honest_signer = {r["sha1"] for r in verdict["rows"] if "signer" in r["purposes"]}
    honest_timestamp = {r["sha1"] for r in verdict["rows"] if "timestamp" in r["purposes"]}
    if not honest_signer <= verdict["naive_signer"]:
        raise Refused("a signer anchor was written that the grant alone does not permit")
    if not honest_timestamp <= verdict["naive_timestamp"]:
        raise Refused("a timestamp anchor was written that the grant alone does not permit")
    leaked = verdict["dropped_by_date"] & (honest_signer | honest_timestamp)
    if leaked:
        raise Refused(f"{len(leaked)} distrusted subject(s) reached the anchor set")

    # Every anchor the list gives an issuance cutoff must carry that cutoff into
    # the output, and nothing else may. An anchor whose constraint went missing
    # is an anchor that silently widened back to unrestricted, which is the same
    # failure class as a distrust rule that stopped being applied.
    written = {r["sha256"] for r in verdict["rows"]}
    constraints = verdict["constraints"] or {}
    if not set(constraints) <= written:
        raise Refused("an issuance cutoff was written for a certificate that is not an anchor")
    expected = {r["sha256"] for r in verdict["rows"] if r["issued_before"]}
    if expected != set(constraints):
        raise Refused(
            f"{len(expected ^ set(constraints))} anchor(s) carry an issuance cutoff "
            "the bundle does not record"
        )

    if require_a_dated_exclusion:
        if not verdict["excluded"]["disallowed_after_a_past_moment"]:
            raise Refused(
                "no subject was excluded by a past disallowed-after moment; the "
                "distrust properties are not being applied"
            )
        if not constraints:
            raise Refused(
                "no anchor carries an issuance cutoff; the constraint property is "
                "not being read"
            )
        if not honest_signer or not honest_timestamp:
            raise Refused("the honest read produced no anchors for one of the two chains")


# ──────────────────────────────── output ──────────────────────────────────


def write_pem(path: Path, ders: list) -> str:
    """One PEM file, ordered by fingerprint so the diff of a re-fetch shows only
    what actually changed. Returns the file's sha256."""
    body = b"".join(
        pem.armor("CERTIFICATE", der)
        for der in sorted(ders, key=lambda d: hashlib.sha256(d).hexdigest())
    )
    path.write_bytes(body)
    return hashlib.sha256(body).hexdigest()


def subject_of(der: bytes) -> str:
    try:
        name = ax509.Certificate.load(der).subject.native
        return str(
            name.get("common_name")
            or name.get("organization_name")
            or ax509.Certificate.load(der).subject.human_friendly
        )
    except Exception:  # noqa: BLE001
        return ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dest",
        default=str(
            Path(__file__).resolve().parent.parent
            / "src"
            / "engine"
            / "trust"
            / "msctl"
        ),
        help="bundle directory (committed; the git diff is the review)",
    )
    parser.add_argument(
        "--first-fetch",
        action="store_true",
        help=(
            "pin the trust list's issuer from this download (trust on first "
            "use). Required when no pin file is present but the bundle is"
        ),
    )
    arguments = parser.parse_args()
    destination = Path(arguments.dest)
    destination.mkdir(parents=True, exist_ok=True)

    def log(line: str = "") -> None:
        print(line, flush=True)

    pin_path = destination / "msctl-ctl-signers.pem"
    guard_missing_pin(destination, pin_path, first_fetch=arguments.first_fetch)
    pinned = load_pinned(pin_path)
    log(f"pinned trust-list issuers: {len(pinned)}")

    with tempfile.TemporaryDirectory(prefix="msctl-") as scratch:
        workspace = Path(scratch)
        log(f"fetching {CTL_URL}")
        cabinet = fetch(CTL_URL)
        signed_list = expand_cabinet(cabinet, CTL_MEMBER, workspace)
        log(f"  {len(cabinet)} bytes cabinet, {len(signed_list)} bytes trust list")

        payload, signer, embedded = verify_signed_list(signed_list)
        how, issuers = authenticate_signer(signer, embedded, pinned)
        log(f"  signature verified; signer authenticated: {how}")
        if how == "first-fetch":
            write_pem(pin_path, [issuer.dump() for issuer in issuers])
            log(f"  wrote {pin_path.name} — REVIEW THIS DIFF, it is the trust pin")

        listing, subjects = subjects_in(payload)
        sequence = listing["sequence_number"].native
        this_update = listing["this_update"].native
        log(f"  trust list: {len(subjects)} subjects, sequence {sequence}, "
            f"issued {this_update.isoformat()}")

        log("generating the certificate store")
        store = generate_store(workspace)
        material = certificates_in(store)
        log(f"  {len(material)} certificates, {len(store)} bytes")

    verdict = classify(material, subjects)
    prove(verdict, require_a_dated_exclusion=True)
    signer_anchors = verdict["signer_anchors"]
    timestamp_anchors = verdict["timestamp_anchors"]
    rows = verdict["rows"]
    excluded = verdict["excluded"]
    trimmed_by_denial = verdict["trimmed_by_denial"]
    unrestricted = verdict["unrestricted"]
    policy_subjects = verdict["root_program_policy_subjects"]
    constraints = verdict["constraints"]
    naive_signer = verdict["naive_signer"]
    naive_timestamp = verdict["naive_timestamp"]

    signer_path = destination / "msctl-signers.pem"
    timestamp_path = destination / "msctl-timestamp.pem"
    signer_sha = write_pem(signer_path, signer_anchors)
    timestamp_sha = write_pem(timestamp_path, timestamp_anchors)

    index = destination / "msctl-certificates.tsv"
    # `newline=""` for the same reason the constraints file is written as
    # bytes: this tree checks out with EOL translation disabled, so whatever
    # newline the fetching host's `write_text` chose is frozen into the
    # committed blob and a refresh run elsewhere rewrites every line.
    index.write_text(
        "\n".join(
            ["sha1\tpurposes\trestricted_after\tissued_before\tsubject"]
            + [
                f"{r['sha1']}\t{r['purposes']}\t{r['restricted']}\t"
                f"{r['issued_before']}\t{r['subject']}"
                for r in sorted(rows, key=lambda r: r["sha1"])
            ]
        )
        + "\n",
        encoding="utf-8",
        newline="\n",
    )

    # Keyed by SHA-256 because that is what identifies an anchor at validation
    # time; the TSV's SHA-1 is the list's own subject identifier and belongs to
    # the fetch, not to the runtime.
    constraints_path = destination / "msctl-constraints.json"
    # Written as BYTES: the manifest records this file's digest and the reader
    # checks it, so the platform's newline translation must not sit between the
    # two.
    constraints_body = (
        json.dumps(
            {key: constraints[key] for key in sorted(constraints)},
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    ).encode("utf-8")
    constraints_path.write_bytes(constraints_body)
    constraints_sha = hashlib.sha256(constraints_body).hexdigest()

    manifest = {
        "source": CTL_URL,
        "fetched": datetime.date.today().isoformat(),
        "list": {
            "sequence_number": str(sequence),
            "this_update": this_update.isoformat(),
            "subjects": len(subjects),
            "signer_sha256": signer.sha256.hex(),
            "signer_authenticated": how,
            "issuer_sha256": sorted(issuer.sha256.hex() for issuer in issuers),
        },
        "files": {
            "msctl-signers.pem": {"sha256": signer_sha, "count": len(signer_anchors)},
            "msctl-timestamp.pem": {
                "sha256": timestamp_sha,
                "count": len(timestamp_anchors),
            },
            "msctl-constraints.json": {
                "sha256": constraints_sha,
                "count": len(constraints),
            },
        },
        "material": {
            "certificates": len(material),
            "unrestricted_no_purpose_property": unrestricted,
            "purposes_trimmed_by_denial": trimmed_by_denial,
            # Modelled, not merely counted: each of these anchors carries an
            # issuance cutoff into msctl-constraints.json and the validator
            # refuses a certificate issued after it.
            "anchored_with_issuance_cutoff": len(constraints),
            "anchored_with_issuance_cutoff_for_some_purposes": sum(
                1 for entry in constraints.values() if entry["purposes"]
            ),
            # Property 83, re-proven date-free on this list rather than modelled.
            "anchored_with_root_program_policies": policy_subjects,
        },
        "excluded": excluded,
        "naive_read_would_have_anchored": {
            "signer": len(naive_signer),
            "timestamp": len(naive_timestamp),
        },
    }
    (destination / "msctl-manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    log("")
    log(f"signer anchors:    {len(signer_anchors)}  "
        f"(a naive read would have anchored {len(naive_signer)})")
    log(f"timestamp anchors: {len(timestamp_anchors)}  "
        f"(a naive read would have anchored {len(naive_timestamp)})")
    for reason, count in excluded.items():
        log(f"excluded, {reason}: {count}")
    log(f"purposes trimmed by a per-purpose denial: {trimmed_by_denial}")
    log(f"anchors carrying an issuance cutoff: {len(constraints)}")
    log("REVIEW THE GIT DIFF and commit — these files are what ships.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Refused as refusal:
        print(f"REFUSED: {refusal}", file=sys.stderr)
        sys.exit(1)
