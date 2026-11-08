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
    __slots__ = ("certificates", "provenance", "transient")

    def __init__(self, certificates: dict, provenance: dict | None, transient: bool = False):
        self.certificates = certificates
        self.provenance = provenance
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
    return Path(__file__).resolve().parent / "trust"


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
    return _Bundle(certificates, provenance, transient)


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
    """The bundle one verification reads from, start to finish. A caller takes
    this once and passes it to every reader below, so its anchors and its
    provenance come from the same read."""
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
    ``ValidationContext(trust_roots=…)`` takes."""
    bundle = bundle or _bundle()
    if bundle.transient:
        # Fail closed. A bundle some of whose files could not be read has
        # anchors without everything that goes with them (for the root program,
        # without the cutoffs), so none of it is used. The source reports as
        # unavailable and the next verification reads again.
        return []
    return list(bundle.certificates.get(purpose, ()))


def provenance(bundle: _Bundle | None = None) -> dict:
    """How old the bundle is and how much of the union it covers — for a
    surface that has to say so rather than imply currency.

    Counts are deliberately NOT here: how many anchors are in force is a
    property of the verification, not of the manifest, and the two must not be
    able to disagree. Reported as a record of nulls when the bundle is
    unreadable, so a caller never has to distinguish "no manifest" from "no
    answer".
    """
    manifest = (bundle or _bundle()).provenance or {}
    lists = manifest.get("lists") or {}
    lotl = manifest.get("lotl") or {}
    return {
        "fetched": manifest.get("fetched"),
        "sequence": lotl.get("sequence"),
        "list_count": lists.get("included"),
    }
