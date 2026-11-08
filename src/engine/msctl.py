"""The bundled platform root-program certificates as an OPT-IN trust source.

Never consulted unless a caller asks for it. ``signatures.py`` reads this
module only inside ``if msctl_trust:`` — with the option off nothing here is
read, and there is no import-time read.

The bundle SHIPS; nothing fetches it at run time. It is written by
``scripts/fetch-msctl.py``, which verifies the published trust list's own
signature against a pinned issuing authority, takes the certificate bytes only
for subjects that signed list names, and models the list's DISTRUST properties
as well as its grants — a subject past its disallowed-after moment is dropped
entirely, and a subject carrying a per-purpose denial has those purposes
subtracted. Reading the grant without the distrust would anchor authorities the
program deliberately withdrew. ``provenance()`` carries the fetch date and the
list's sequence number so a surface can state how old the bundle is instead of
implying it is current.

Purpose restrictions are carried STRUCTURALLY rather than as data checked at
use: the fetch splits the anchors into one file per chain kind, so a subject
granted only timestamping is in the timestamp file and nowhere else and cannot
reach a signer chain. That is the same split ``os_trust`` derives from the
platform store's per-entry restrictions, and it uses the same two purpose sets,
so what counts as a signer authority has one definition.

Purpose restrictions are the ones the split can express. An ISSUANCE-DATE
restriction cannot be: a subject is in the program for everything it signed
before a stated moment and for nothing it signed after, so the same anchor is
in force or not depending on the certificate under it. Those cutoffs travel as
DATA (``msctl-constraints.json``, keyed by the SHA-256 an anchor is identified
by) and ``constraint_for`` is what the validator asks; dropping such a subject
instead would refuse signatures the program still vouches for.

This source is ADDITIVE, never a replacement for the platform store read: a
root an administrator installed locally is in the store and not in the
published program, and enabling this must not lose it.

Unlike the platform store, this bundle CANNOT change while the app runs — it is
a file inside the installation — so it is parsed once and kept. The reason
``os_trust`` refuses a cache (a certificate installed mid-session must be seen)
does not apply.
"""

from __future__ import annotations

import datetime
import json
from pathlib import Path

from asn1crypto import pem, x509

SIGNER = "signer"
TIMESTAMP = "timestamp"

_PEM_BY_PURPOSE = {
    SIGNER: "msctl-signers.pem",
    TIMESTAMP: "msctl-timestamp.pem",
}
_MANIFEST = "msctl-manifest.json"
_CONSTRAINTS = "msctl-constraints.json"


class _Bundle:
    __slots__ = ("certificates", "provenance", "constraints", "transient")

    def __init__(
        self,
        certificates: dict,
        provenance: dict | None,
        constraints: dict,
        transient: bool = False,
    ):
        self.certificates = certificates
        self.provenance = provenance
        self.constraints = constraints
        #: True when a file could not be read for a reason that may pass. Such
        #: a bundle serves the verification that read it and is not cached.
        self.transient = transient


#: Parsed bundles, keyed by the directory they were read from. Keying on the
#: directory rather than a bare flag means a caller pointed at a different
#: bundle reads that bundle rather than a cached other one.
_CACHE: dict[Path, _Bundle] = {}


def _read_file(path: Path) -> tuple[bytes | None, bool]:
    """The file's bytes, and whether the read FAILED in a way that may pass.

    A missing file is a fact about the install and stays missing, so it is not
    transient. Any other OS error (a lock held by a scanner, a share that
    dropped, a busy disk) may be gone on the next read.
    """
    try:
        return path.read_bytes(), False
    except FileNotFoundError:
        return None, False
    except OSError:
        return None, True


def _bundle_dir() -> Path:
    return Path(__file__).resolve().parent / "trust" / "msctl"


def _read_bundle(directory: Path) -> _Bundle:
    """The one seam over the shipped files. A malformed or absent bundle yields
    no certificates rather than raising: callers report the source as
    unavailable, which is a different thing from a chain that failed."""
    certificates: dict[str, list] = {SIGNER: [], TIMESTAMP: []}
    transient = False
    for purpose, name in _PEM_BY_PURPOSE.items():
        data, failed = _read_file(directory / name)
        transient = transient or failed
        if data is None:
            continue
        try:
            for _type, _headers, der in pem.unarmor(data, multiple=True):
                try:
                    certificates[purpose].append(x509.Certificate.load(der))
                except Exception:  # noqa: BLE001
                    # One unparsable entry must not remove every anchor.
                    continue
        except Exception:  # noqa: BLE001
            continue
    manifest, failed = _read_file(directory / _MANIFEST)
    transient = transient or failed
    try:
        provenance = json.loads(manifest.decode("utf-8")) if manifest is not None else None
    except Exception:  # noqa: BLE001
        provenance = None
    constraints, failed = _read_constraints(directory)
    return _Bundle(certificates, provenance, constraints, transient or failed)


def _read_constraints(directory: Path) -> tuple[dict, bool]:
    """The per-anchor issuance cutoffs, parsed to what a comparison needs.

    An entry that does not parse is DROPPED rather than defaulted, and the
    absence of the file yields nothing: a cutoff this build cannot read must not
    turn into a cutoff at some guessed moment, in either direction. That the
    file is present and complete is proven where it is written, not here.

    The second value says the read failed for a reason that may pass. The map
    is then empty, and the bundle that carries it is not kept.
    """
    data, failed = _read_file(directory / _CONSTRAINTS)
    if data is None:
        return {}, failed
    try:
        raw = json.loads(data.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return {}, False
    if not isinstance(raw, dict):
        return {}, False
    parsed: dict[str, tuple] = {}
    for fingerprint, entry in raw.items():
        if not isinstance(entry, dict):
            continue
        try:
            moment = datetime.datetime.fromisoformat(entry["not_before"])
        except Exception:  # noqa: BLE001
            continue
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=datetime.timezone.utc)
        purposes = entry.get("purposes")
        # None is EVERY purpose, not none of them — the fetch writes null for a
        # cutoff the list states without narrowing it.
        parsed[fingerprint.lower()] = (
            moment,
            frozenset(purposes) if purposes else None,
        )
    return parsed, False


def _bundle() -> _Bundle:
    directory = _bundle_dir()
    cached = _CACHE.get(directory)
    if cached is None:
        cached = _read_bundle(directory)
        # A read that failed for a reason that may pass is not kept: the next
        # verification reads again instead of living without anchors until the
        # process ends. A missing or unparsable file is permanent and is kept.
        if not cached.transient:
            _CACHE[directory] = cached
    return cached


def snapshot() -> _Bundle:
    """The bundle one verification reads from, start to finish.

    Anchors, cutoffs and provenance must all come from the same read. Asked
    for one by one, a read that failed between two calls could give a full
    anchor list with an empty cutoff map, and a root would be trusted without
    its issuance cutoff. A caller takes this once and passes it to every
    reader below.
    """
    return _bundle()


def available(bundle: _Bundle | None = None) -> bool:
    """Whether the shipped bundle was readable and holds any anchor at all."""
    bundle = bundle or _bundle()
    if bundle.transient:
        return False
    certificates = bundle.certificates
    return bool(certificates[SIGNER] or certificates[TIMESTAMP])


def anchors(purpose: str, bundle: _Bundle | None = None) -> list:
    """The bundle's anchors for one chain kind, as the objects
    ``ValidationContext(trust_roots=…)`` takes.

    An unknown purpose yields nothing rather than everything: a caller that
    misnames a chain kind must lose the anchors, never gain the other kind's.
    """
    bundle = bundle or _bundle()
    if bundle.transient:
        # Fail closed. A bundle some of whose files could not be read has
        # anchors without everything that goes with them (for the root program,
        # without the cutoffs), so none of it is used. The source reports as
        # unavailable and the next verification reads again.
        return []
    return list(bundle.certificates.get(purpose, ()))


def constraint_for(anchor_sha256: str, bundle: _Bundle | None = None):
    """This anchor's issuance cutoff as ``(moment, purposes | None)``, or None.

    ``purposes`` is None when the cutoff applies to every purpose — the common
    case — and a set of EKU OIDs when the program narrowed it. The caller
    decides what a chain's purpose is; this module only says what the list
    states.
    """
    return (bundle or _bundle()).constraints.get((anchor_sha256 or "").lower())


def constraints(bundle: _Bundle | None = None) -> dict:
    """Every issuance cutoff in the bundle, as ``{anchor sha-256 hex: (moment,
    purposes | None)}``.

    A copy, so a caller holding it across a bundle swap cannot mutate the cached
    parse; the whole map rather than a per-anchor lookup because the caller
    checks one chain's anchor against it many times and an empty map is also the
    caller's cheapest "nothing to enforce".
    """
    return dict((bundle or _bundle()).constraints)


def provenance(bundle: _Bundle | None = None) -> dict:
    """How old the bundle is — for a surface that has to say so rather than
    imply currency.

    Counts are deliberately NOT here: how many anchors are in force is a
    property of the verification, not of the manifest, and the two must not be
    able to disagree. Reported as a record of nulls when the bundle is
    unreadable, so a caller never has to distinguish "no manifest" from "no
    answer".
    """
    manifest = (bundle or _bundle()).provenance or {}
    listing = manifest.get("list") or {}
    return {
        "fetched": manifest.get("fetched"),
        "sequence": listing.get("sequence_number"),
        "issued": listing.get("this_update"),
    }
