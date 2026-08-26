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

This source is ADDITIVE, never a replacement for the platform store read: a
root an administrator installed locally is in the store and not in the
published program, and enabling this must not lose it.

Unlike the platform store, this bundle CANNOT change while the app runs — it is
a file inside the installation — so it is parsed once and kept. The reason
``os_trust`` refuses a cache (a certificate installed mid-session must be seen)
does not apply.
"""

from __future__ import annotations

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


class _Bundle:
    __slots__ = ("certificates", "provenance")

    def __init__(self, certificates: dict, provenance: dict | None):
        self.certificates = certificates
        self.provenance = provenance


#: Parsed bundles, keyed by the directory they were read from. Keying on the
#: directory rather than a bare flag means a caller pointed at a different
#: bundle reads that bundle rather than a cached other one.
_CACHE: dict[Path, _Bundle] = {}


def _bundle_dir() -> Path:
    return Path(__file__).resolve().parent / "trust" / "msctl"


def _read_bundle(directory: Path) -> _Bundle:
    """The one seam over the shipped files. A malformed or absent bundle yields
    no certificates rather than raising: callers report the source as
    unavailable, which is a different thing from a chain that failed."""
    certificates: dict[str, list] = {SIGNER: [], TIMESTAMP: []}
    for purpose, name in _PEM_BY_PURPOSE.items():
        path = directory / name
        try:
            data = path.read_bytes()
        except OSError:
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
    try:
        provenance = json.loads((directory / _MANIFEST).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        provenance = None
    return _Bundle(certificates, provenance)


def _bundle() -> _Bundle:
    directory = _bundle_dir()
    cached = _CACHE.get(directory)
    if cached is None:
        cached = _read_bundle(directory)
        _CACHE[directory] = cached
    return cached


def available() -> bool:
    """Whether the shipped bundle was readable and holds any anchor at all."""
    certificates = _bundle().certificates
    return bool(certificates[SIGNER] or certificates[TIMESTAMP])


def anchors(purpose: str) -> list:
    """The bundle's anchors for one chain kind, as the objects
    ``ValidationContext(trust_roots=…)`` takes.

    An unknown purpose yields nothing rather than everything: a caller that
    misnames a chain kind must lose the anchors, never gain the other kind's.
    """
    return list(_bundle().certificates.get(purpose, ()))


def provenance() -> dict:
    """How old the bundle is — for a surface that has to say so rather than
    imply currency.

    Counts are deliberately NOT here: how many anchors are in force is a
    property of the verification, not of the manifest, and the two must not be
    able to disagree. Reported as a record of nulls when the bundle is
    unreadable, so a caller never has to distinguish "no manifest" from "no
    answer".
    """
    manifest = _bundle().provenance or {}
    listing = manifest.get("list") or {}
    return {
        "fetched": manifest.get("fetched"),
        "sequence": listing.get("sequence_number"),
        "issued": listing.get("this_update"),
    }
