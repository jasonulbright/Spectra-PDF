"""MAINTENANCE TOOL, not a build step. Fetches the EU Trusted Lists once, at a
pinned moment, and writes the certificate bundle `src/engine/trust/`.

The app never fetches a trust feed at run time, so the bundle is a shipped
resource in the class of the spelling dictionaries: fetched here, verified
here, reviewed as a git diff, committed. `src/engine` is already a packaged
resource, so the bundle rides along with no packaging change.

WHAT THIS PROVES BEFORE IT WRITES ANYTHING

  1. The list of lists (LOTL) carries an XML signature. It is verified in full
     — exclusive canonicalization, the enveloped-signature transform, every
     reference digest, then the signature itself.
  2. The certificate that signed the LOTL must be one of the pinned signers in
     `eutl-lotl-signers.pem`. A different signer is accepted only when the
     published pivot chain authenticates it: each pivot list names the signing
     certificates valid for the list after it, so a signer change carries its
     own proof and is not accepted because it arrived over a TLS connection.
  3. Every member-state list is signed by a certificate the LOTL names for that
     state, and its own signature verifies the same way.
  4. Only services with status `granted` contribute anchors, split by the
     purpose the list itself records: certification authorities issuing
     qualified certificates anchor SIGNER chains, qualified timestamp
     authorities anchor TIMESTAMP chains.

A list that fails any of this is EXCLUDED and recorded as excluded with its
reason. A trust bundle is the wrong place to be generous.

Run: resources/python/python.exe scripts/fetch-eutl.py
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
from datetime import date
from pathlib import Path

import requests
from asn1crypto import x509 as ax509
from cryptography import x509 as cx509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from lxml import etree

LOTL_URL = "https://ec.europa.eu/tools/lotl/eu-lotl.xml"

TSL_NS = "http://uri.etsi.org/02231/v2#"
DS_NS = "http://www.w3.org/2000/09/xmldsig#"
EXC_C14N_NS = "http://www.w3.org/2001/10/xml-exc-c14n#"
NS = {"tsl": TSL_NS, "ds": DS_NS}

# The three service types that are document-signing authorities, and which
# chain each one anchors. Everything else a trusted list carries — revocation
# responders, non-qualified timestamping, electronic delivery, preservation,
# registration — is not an authority for a signature on a document.
SIGNER_SERVICE_TYPES = frozenset({
    "http://uri.etsi.org/TrstSvc/Svctype/CA/QC",
    "http://uri.etsi.org/TrstSvc/Svctype/NationalRootCA-QC",
})
TIMESTAMP_SERVICE_TYPES = frozenset({
    "http://uri.etsi.org/TrstSvc/Svctype/TSA/QTST",
})
GRANTED = "http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted"

XML_TSL_MIME = "application/vnd.etsi.tsl+xml"

_HASH_NAMES = ("sha512", "sha384", "sha256", "sha1")


class Refused(Exception):
    """A verification that did not hold. Nothing is written after one."""


# ─────────────────────────────── transport ────────────────────────────────


def fetch(url: str, verify: bool = True) -> bytes:
    """One list, over TLS."""
    if not verify:
        import urllib3

        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    response = requests.get(
        url,
        timeout=180,
        verify=verify,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
    )
    response.raise_for_status()
    return response.content


def fetch_member_list(url: str) -> tuple[bytes, str]:
    """One member-state list, with its transport recorded.

    TLS is transport only here. A member-state list is accepted on its XML
    signature against the certificate the LOTL names for that state, and the
    LOTL itself is fetched over verified TLS and checked against the pinned
    signer — so a forged list would need the state's own signing key, which no
    position on the network supplies. Several states serve their list from a
    host with an incomplete TLS chain; dropping a state's certificate
    authorities over that would weaken the bundle for a reason unrelated to
    whether the list is authentic. The fallback is recorded per list rather
    than hidden.
    """
    try:
        return fetch(url), "verified-tls"
    except requests.exceptions.SSLError:
        return fetch(url, verify=False), "tls-chain-incomplete-at-host"


# ──────────────────────────── XML-DSig checking ───────────────────────────


def _parse(xml_bytes: bytes):
    return etree.fromstring(
        xml_bytes, etree.XMLParser(resolve_entities=False, huge_tree=True)
    )


def _c14n(node, prefixes: list | None = None) -> bytes:
    return etree.tostring(
        node,
        method="c14n",
        exclusive=True,
        with_comments=False,
        inclusive_ns_prefixes=prefixes,
    )


def _hash_name(algorithm_uri: str) -> str:
    for name in _HASH_NAMES:
        if name in algorithm_uri:
            return name
    raise Refused(f"unsupported digest algorithm: {algorithm_uri}")


def _enveloped(xml_bytes: bytes):
    """The document with its signature removed, per the enveloped-signature
    transform.

    The transform removes the ``Signature`` ELEMENT — not the whitespace that
    followed it. A DOM removal takes the element's tail text with it, which
    changes the canonical form and breaks the document digest; three of the
    published member-state lists fail on exactly that. So the tail is
    re-attached to whatever now precedes it.
    """
    document = _parse(xml_bytes)
    signature = document.findall(f".//{{{DS_NS}}}Signature")[0]
    parent = signature.getparent()
    tail = signature.tail
    parent.remove(signature)
    if tail:
        siblings = list(parent)
        if siblings:
            siblings[-1].tail = (siblings[-1].tail or "") + tail
        else:
            parent.text = (parent.text or "") + tail
    return document


def _verify_signature_value(signed_info: bytes, signature_value: bytes,
                            algorithm_uri: str, certificate_der: bytes) -> None:
    certificate = cx509.load_der_x509_certificate(certificate_der)
    public_key = certificate.public_key()
    digest = {
        "sha512": hashes.SHA512,
        "sha384": hashes.SHA384,
        "sha256": hashes.SHA256,
        "sha1": hashes.SHA1,
    }[_hash_name(algorithm_uri)]()
    if isinstance(public_key, rsa.RSAPublicKey):
        if "MGF1" in algorithm_uri or "pss" in algorithm_uri.lower():
            public_key.verify(
                signature_value,
                signed_info,
                padding.PSS(mgf=padding.MGF1(digest), salt_length=digest.digest_size),
                digest,
            )
        else:
            public_key.verify(signature_value, signed_info, padding.PKCS1v15(), digest)
    elif isinstance(public_key, ec.EllipticCurvePublicKey):
        # XML-DSig carries an ECDSA signature as raw r||s, not as the DER
        # SEQUENCE the verifier expects.
        half = len(signature_value) // 2
        public_key.verify(
            encode_dss_signature(
                int.from_bytes(signature_value[:half], "big"),
                int.from_bytes(signature_value[half:], "big"),
            ),
            signed_info,
            ec.ECDSA(digest),
        )
    else:
        raise Refused(f"unsupported signing key: {type(public_key).__name__}")


def verify_list(xml_bytes: bytes, what: str) -> bytes:
    """Verify one list's XML signature end to end. Returns the signer's DER.

    Raises `Refused` on anything that does not hold — a failed reference
    digest, an unsupported algorithm, a signature that does not verify, or a
    signature that is not the root element's own.
    """
    root = _parse(xml_bytes)
    signatures = root.findall(f".//{{{DS_NS}}}Signature")
    if not signatures:
        raise Refused(f"{what}: no XML signature")
    signature = signatures[0]
    if signature.getparent() is not root:
        raise Refused(f"{what}: signature is not the list's own")
    signed_info = signature.find("ds:SignedInfo", NS)

    for reference in signed_info.findall("ds:Reference", NS):
        uri = reference.get("URI")
        prefixes = None
        for inclusive in reference.iter(f"{{{EXC_C14N_NS}}}InclusiveNamespaces"):
            if inclusive.get("PrefixList"):
                prefixes = inclusive.get("PrefixList").split()
        if uri in ("", None):
            target = _enveloped(xml_bytes)
        else:
            wanted = uri.lstrip("#")
            target = next(
                (
                    element
                    for element in root.iter()
                    if wanted in (element.get("Id"), element.get("id"), element.get("ID"))
                ),
                None,
            )
            if target is None:
                raise Refused(f"{what}: reference {uri} names nothing in the list")
        algorithm = reference.find("ds:DigestMethod", NS).get("Algorithm")
        expected = base64.b64decode(reference.find("ds:DigestValue", NS).text)
        actual = getattr(hashlib, _hash_name(algorithm))(_c14n(target, prefixes)).digest()
        if actual != expected:
            raise Refused(f"{what}: reference {uri or '(document)'} digest does not match")

    certificate_element = signature.find(f".//{{{DS_NS}}}X509Certificate")
    if certificate_element is None:
        raise Refused(f"{what}: the signature carries no signer certificate")
    certificate_der = base64.b64decode("".join(certificate_element.text.split()))
    try:
        _verify_signature_value(
            _c14n(signed_info),
            base64.b64decode(signature.find("ds:SignatureValue", NS).text),
            signed_info.find("ds:SignatureMethod", NS).get("Algorithm"),
            certificate_der,
        )
    except Refused:
        raise
    except Exception as exc:  # noqa: BLE001 — any failure here is a refusal
        raise Refused(f"{what}: signature does not verify ({type(exc).__name__})") from None
    return certificate_der


def signature_algorithm(xml_bytes: bytes) -> str:
    root = _parse(xml_bytes)
    method = root.find(f".//{{{DS_NS}}}SignedInfo/{{{DS_NS}}}SignatureMethod")
    return method.get("Algorithm").rsplit("#", 1)[-1] if method is not None else "?"


# ──────────────────────────── list structure ──────────────────────────────


def _certificates_under(element) -> list:
    """X509Certificate blobs under `element`. The trusted-list schema has its
    own element for a digital identity; the XML-DSig one appears only inside a
    signature, so reading that namespace here would collect signer certificates
    as if they were anchors."""
    blobs = []
    for node in element.iter(f"{{{TSL_NS}}}X509Certificate"):
        text = (node.text or "").strip()
        if text:
            blobs.append(base64.b64decode("".join(text.split())))
    return blobs


def _scheme_field(root, name: str) -> str | None:
    node = root.find(f".//tsl:SchemeInformation/{name}", NS)
    return node.text if node is not None else None


def pointers(root) -> list[dict]:
    """The LOTL's pointers to XML member-state lists, each with the signing
    certificates the LOTL names for that list."""
    found = []
    for pointer in root.findall(".//tsl:PointersToOtherTSL/tsl:OtherTSLPointer", NS):
        mime = territory = None
        for element in pointer.iter():
            if element.tag.endswith("}MimeType"):
                mime = element.text
            elif element.tag.endswith("}SchemeTerritory"):
                territory = element.text
        if mime != XML_TSL_MIME:
            continue
        location = pointer.find("tsl:TSLLocation", NS)
        found.append({
            "territory": territory,
            "url": location.text if location is not None else None,
            "signers": _certificates_under(pointer),
        })
    return found


def anchors_in(root) -> tuple[set, set]:
    """(signer anchors, timestamp anchors) from one member-state list.

    Only `granted` services contribute: a withdrawn or nationally-deprecated
    service is a CA that must not anchor anything, and withdrawn entries
    outnumber granted ones on several lists.
    """
    signer, timestamp = set(), set()
    for service in root.findall(".//tsl:TSPService", NS):
        information = service.find("tsl:ServiceInformation", NS)
        if information is None:
            continue
        type_node = information.find("tsl:ServiceTypeIdentifier", NS)
        status_node = information.find("tsl:ServiceStatus", NS)
        if type_node is None or status_node is None:
            continue
        if status_node.text != GRANTED:
            continue
        identity = information.find("tsl:ServiceDigitalIdentity", NS)
        if identity is None:
            continue
        certificates = _certificates_under(identity)
        if type_node.text in SIGNER_SERVICE_TYPES:
            signer.update(certificates)
        elif type_node.text in TIMESTAMP_SERVICE_TYPES:
            timestamp.update(certificates)
    return signer, timestamp


# ────────────────────────────── the pinned signer ──────────────────────────


def load_pinned(path: Path) -> set[str]:
    """SHA-256 of every pinned LOTL signing certificate. Empty when the pin
    file does not exist yet, which is the first-fetch case: the signer is
    written out and the diff is the review."""
    if not path.is_file():
        return set()
    from asn1crypto import pem

    pinned = set()
    for _, _, der in pem.unarmor(path.read_bytes(), multiple=True):
        pinned.add(hashlib.sha256(der).hexdigest())
    return pinned


def authenticate_signer(root, signer_der: bytes, pinned: set[str], log) -> str:
    """How the current LOTL's signer is authenticated.

    Directly, when it is a pinned signer. Otherwise through the published pivot
    chain: the pivots are the EU's own record of every signer change, each one
    signed by a certificate the pivot before it names, so a chain that starts
    at a pinned signer and ends naming the current one authenticates the change.
    """
    fingerprint = hashlib.sha256(signer_der).hexdigest()
    if fingerprint in pinned:
        return "pinned"
    if not pinned:
        return "first-fetch"

    pivot_urls = [
        node.text
        for node in root.findall(".//tsl:SchemeInformationURI/tsl:URI", NS)
        if node.text and "pivot" in node.text.lower() and node.text.endswith(".xml")
    ]
    if not pivot_urls:
        raise Refused("the LOTL signer is not pinned and no pivot chain is published")

    bodies = {url: fetch(url) for url in pivot_urls}
    ordered = sorted(
        pivot_urls,
        key=lambda url: int(_scheme_field(_parse(bodies[url]), "tsl:TSLSequenceNumber")),
    )
    declared: set[str] | None = None
    reached_pin = False
    for url in ordered:
        body = bodies[url]
        name = url.rsplit("/", 1)[-1]
        pivot_signer = verify_list(body, name)
        pivot_fingerprint = hashlib.sha256(pivot_signer).hexdigest()
        if declared is not None and pivot_fingerprint not in declared:
            raise Refused(f"{name}: signer is not named by the pivot before it")
        if pivot_fingerprint in pinned:
            reached_pin = True
        pivot_root = _parse(body)
        declared = {
            hashlib.sha256(der).hexdigest()
            for pointer in pivot_root.findall(
                ".//tsl:PointersToOtherTSL/tsl:OtherTSLPointer", NS
            )
            if any(
                element.tag.endswith("}SchemeTerritory") and element.text == "EU"
                for element in pointer.iter()
            )
            for der in _certificates_under(pointer)
        }
        log(f"  pivot {name}: verified, names {len(declared)} signer(s)")
    if not reached_pin:
        raise Refused("the pivot chain does not start at a pinned signer")
    if fingerprint not in (declared or set()):
        raise Refused("the LOTL signer is not named by the newest pivot")
    return "pivot-chain"


# ──────────────────────────────── output ──────────────────────────────────


def write_pem(path: Path, ders: list[bytes]) -> str:
    """One PEM file, ordered by fingerprint so the diff of a re-fetch shows
    only what actually changed. Returns the file's sha256."""
    from asn1crypto import pem

    body = b"".join(
        pem.armor("CERTIFICATE", der) for der in sorted(ders, key=lambda d: hashlib.sha256(d).hexdigest())
    )
    path.write_bytes(body)
    return hashlib.sha256(body).hexdigest()


def subject_of(der: bytes) -> str:
    try:
        certificate = ax509.Certificate.load(der)
        name = certificate.subject.native
        return str(
            name.get("common_name")
            or name.get("organization_name")
            or certificate.subject.human_friendly
        )
    except Exception:  # noqa: BLE001
        return ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dest",
        default=str(Path(__file__).resolve().parent.parent / "src" / "engine" / "trust"),
        help="bundle directory (committed; the git diff is the review)",
    )
    arguments = parser.parse_args()
    destination = Path(arguments.dest)
    destination.mkdir(parents=True, exist_ok=True)

    def log(line: str = "") -> None:
        print(line, flush=True)

    pin_path = destination / "eutl-lotl-signers.pem"
    pinned = load_pinned(pin_path)
    log(f"pinned LOTL signers: {len(pinned)}")

    log(f"fetching {LOTL_URL}")
    lotl_bytes = fetch(LOTL_URL)
    lotl_signer = verify_list(lotl_bytes, "the LOTL")
    lotl_root = _parse(lotl_bytes)
    how = authenticate_signer(lotl_root, lotl_signer, pinned, log)
    log(f"  LOTL signature verified; signer authenticated: {how}")
    if how == "first-fetch":
        write_pem(pin_path, [lotl_signer])
        log(f"  wrote {pin_path.name} — REVIEW THIS DIFF, it is the trust pin")
    elif how == "pivot-chain":
        write_pem(pin_path, [lotl_signer])
        log(f"  signer changed; {pin_path.name} rewritten — review the diff")

    sequence = _scheme_field(lotl_root, "tsl:TSLSequenceNumber")
    issued = _scheme_field(lotl_root, "tsl:ListIssueDateTime")
    next_update = lotl_root.find(".//tsl:SchemeInformation/tsl:NextUpdate/tsl:dateTime", NS)

    signer_anchors: dict[bytes, set] = {}
    timestamp_anchors: dict[bytes, set] = {}
    rows = []
    for pointer in pointers(lotl_root):
        territory, url = pointer["territory"], pointer["url"]
        if territory == "EU":
            # The LOTL's pointer to itself: already fetched and verified.
            continue
        row = {"territory": territory, "url": url}
        try:
            body, transport = fetch_member_list(url)
        except Exception as exc:  # noqa: BLE001
            row["included"] = False
            row["excluded_because"] = f"not retrievable ({type(exc).__name__})"
            rows.append(row)
            log(f"{territory}: EXCLUDED — {row['excluded_because']}")
            continue
        row["transport"] = transport
        row["sha256"] = hashlib.sha256(body).hexdigest()
        row["bytes"] = len(body)
        try:
            signer = verify_list(body, territory)
            named = {hashlib.sha256(der).hexdigest() for der in pointer["signers"]}
            if hashlib.sha256(signer).hexdigest() not in named:
                raise Refused("signed by a certificate the LOTL does not name for it")
        except Refused as refusal:
            row["included"] = False
            row["excluded_because"] = str(refusal).split(": ", 1)[-1]
            rows.append(row)
            log(f"{territory}: EXCLUDED — {row['excluded_because']}")
            continue
        state_root = _parse(body)
        signer_set, timestamp_set = anchors_in(state_root)
        for der in signer_set:
            signer_anchors.setdefault(der, set()).add(territory)
        for der in timestamp_set:
            timestamp_anchors.setdefault(der, set()).add(territory)
        row.update({
            "included": True,
            "sequence": _scheme_field(state_root, "tsl:TSLSequenceNumber"),
            "signature": signature_algorithm(body),
            "signer_sha256": hashlib.sha256(signer).hexdigest(),
            "signer_anchors": len(signer_set),
            "timestamp_anchors": len(timestamp_set),
        })
        rows.append(row)
        log(f"{territory}: verified, {len(signer_set)} signer + {len(timestamp_set)} timestamp anchors")

    signer_path = destination / "eutl-signers.pem"
    timestamp_path = destination / "eutl-timestamp.pem"
    signer_sha = write_pem(signer_path, list(signer_anchors))
    timestamp_sha = write_pem(timestamp_path, list(timestamp_anchors))

    index = destination / "eutl-certificates.tsv"
    lines = ["sha256\tpurpose\tterritories\tsubject"]
    for purpose, table in (("signer", signer_anchors), ("timestamp", timestamp_anchors)):
        for der in sorted(table, key=lambda d: hashlib.sha256(d).hexdigest()):
            lines.append(
                f"{hashlib.sha256(der).hexdigest()}\t{purpose}\t"
                f"{','.join(sorted(table[der]))}\t{subject_of(der)}"
            )
    index.write_text("\n".join(lines) + "\n", encoding="utf-8")

    manifest = {
        "source": LOTL_URL,
        "fetched": date.today().isoformat(),
        "lotl": {
            "sha256": hashlib.sha256(lotl_bytes).hexdigest(),
            "sequence": int(sequence) if sequence else None,
            "issued": issued,
            "next_update": next_update.text if next_update is not None else None,
            "signer_sha256": hashlib.sha256(lotl_signer).hexdigest(),
            "signer_authenticated": how,
        },
        "files": {
            "eutl-signers.pem": {"sha256": signer_sha, "count": len(signer_anchors)},
            "eutl-timestamp.pem": {"sha256": timestamp_sha, "count": len(timestamp_anchors)},
        },
        "lists": {
            "included": sum(1 for row in rows if row.get("included")),
            "excluded": sum(1 for row in rows if not row.get("included")),
        },
        "territories": sorted(rows, key=lambda row: row["territory"] or ""),
    }
    (destination / "eutl-manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    log("")
    log(f"signer anchors:    {len(signer_anchors)}")
    log(f"timestamp anchors: {len(timestamp_anchors)}")
    log(f"lists included:    {manifest['lists']['included']} / "
        f"{manifest['lists']['included'] + manifest['lists']['excluded']}")
    log("REVIEW THE GIT DIFF and commit — these files are what ships.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Refused as refusal:
        print(f"REFUSED: {refusal}", file=sys.stderr)
        sys.exit(1)
