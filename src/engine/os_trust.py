"""The operating system's certificate store as an OPT-IN trust source.

Never consulted unless a caller asks for it. ``signatures.py`` reads this
module only inside ``if system_trust:`` — with the option off, no store
enumeration happens at all, and there is no import-time read and no cache to
warm.

Purpose (EKU) restrictions recorded on a store entry are respected rather than
flattened: a signature validation builds two chains (the signer's and the
timestamp's) and each gets the anchors the store marks as usable for it. A root
restricted to code signing authorises executables and must not become a
document authority by omission.

``ssl.enum_certificates`` is Windows-only; elsewhere the store reports as
unavailable and yields nothing, which callers surface as unavailable rather
than as an empty store.
"""

from __future__ import annotations

import ssl

from asn1crypto import x509

# EKU OIDs. `2.5.29.37.0` (anyExtendedKeyUsage) qualifies for every chain.
_ANY_PURPOSE = "2.5.29.37.0"
_DOCUMENT_SIGNING = "1.3.6.1.4.1.311.10.3.12"
_EMAIL_PROTECTION = "1.3.6.1.5.5.7.3.4"
_TIME_STAMPING = "1.3.6.1.5.5.7.3.8"

# Email protection is in the signer set because the store has no PDF-signing
# purpose of its own and the certificates that sign documents (S/MIME and
# qualified-signature certificates) carry it. Code signing is deliberately
# absent: it authorises executables.
SIGNER_PURPOSES = frozenset({_ANY_PURPOSE, _DOCUMENT_SIGNING, _EMAIL_PROTECTION})
TIMESTAMP_PURPOSES = frozenset({_ANY_PURPOSE, _TIME_STAMPING})

# Roots are anchors; the intermediate store supplies path-building material
# only — an intermediate grants no trust, the anchor it chains to decides.
_ANCHOR_STORE = "ROOT"
_INTERMEDIATE_STORE = "CA"


def available() -> bool:
    """Whether this platform exposes a readable certificate store."""
    return hasattr(ssl, "enum_certificates")


def _enumerate(store: str) -> list:
    """The one seam over the platform store. Entries are
    ``(der, encoding, trust)``, where ``trust`` is ``True`` for an entry usable
    for every purpose or a set of EKU OID strings otherwise."""
    return ssl.enum_certificates(store)


def _read(store: str, purposes: frozenset | None) -> list:
    """Certificates from one store, filtered to `purposes` (None = no filter).

    A single unparsable entry is skipped rather than failing the read: the
    store is populated by the platform and by every product installed on the
    machine, and one malformed blob must not remove every anchor.
    """
    try:
        entries = _enumerate(store)
    except Exception:
        return []
    certs = []
    for entry in entries:
        try:
            der, _encoding, trust = entry
            if purposes is not None and trust is not True:
                if not purposes.intersection(trust or ()):
                    continue
            certs.append(x509.Certificate.load(der))
        except Exception:
            continue
    return certs


def anchors(purposes: frozenset) -> list:
    """Root certificates the store marks as usable for `purposes`."""
    if not available():
        return []
    return _read(_ANCHOR_STORE, purposes)


def intermediates() -> list:
    """Intermediate CA certificates, unfiltered — they are supplied as path
    material, never as anchors, so a purpose filter here would only make
    otherwise-anchorable chains unbuildable."""
    if not available():
        return []
    return _read(_INTERMEDIATE_STORE, None)
