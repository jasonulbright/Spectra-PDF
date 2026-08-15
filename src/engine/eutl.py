"""The bundled EU trusted-list certificates as an OPT-IN trust source.

Never consulted unless a caller asks for it. ``signatures.py`` reads this
module only inside ``if eutl_trust:`` — with the option off nothing here is
read, and there is no import-time read.

The bundle SHIPS; nothing fetches it at run time. It is written by
``scripts/fetch-eutl.py``, which verifies each list's XML signature against the
certificate the list of lists names for it, and is reviewed as a git diff and
committed. ``provenance()`` carries the fetch date and the list count so a
surface can state how old the bundle is instead of implying it is current.

Anchors are split by the purpose the lists themselves record: certification
authorities issuing qualified certificates anchor signer chains, qualified
timestamp authorities anchor timestamp chains. That is the same split
``os_trust`` derives from the platform store's EKU bits, stated as data here.

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
    SIGNER: "eutl-signers.pem",
    TIMESTAMP: "eutl-timestamp.pem",
}
_MANIFEST = "eutl-manifest.json"


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
    return Path(__file__).resolve().parent / "trust"


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
    ``ValidationContext(trust_roots=…)`` takes."""
    return list(_bundle().certificates.get(purpose, ()))


def provenance() -> dict:
    """How old the bundle is and how much of the union it covers — for a
    surface that has to say so rather than imply currency.

    Counts are deliberately NOT here: how many anchors are in force is a
    property of the verification, not of the manifest, and the two must not be
    able to disagree. Reported as a record of nulls when the bundle is
    unreadable, so a caller never has to distinguish "no manifest" from "no
    answer".
    """
    manifest = _bundle().provenance or {}
    lists = manifest.get("lists") or {}
    lotl = manifest.get("lotl") or {}
    return {
        "fetched": manifest.get("fetched"),
        "sequence": lotl.get("sequence"),
        "list_count": lists.get("included"),
    }
