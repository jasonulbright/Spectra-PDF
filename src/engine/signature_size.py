"""How wide a raw signature can be, for the placeholder a dry run reserves.

pyHanko sizes the ``/Contents`` placeholder from a DRY-RUN call that must not
touch the key: a hardware token would raise its consent prompt twice, and a
remote service would spend an authorization on a signature that is discarded.
So the width is computed from the PUBLIC key alone, and it is the WIDEST value
that key can produce — a placeholder sized for a narrower case truncates the
signature into a document that verifies against nothing.

Every signer that signs over a digest it computes itself needs exactly this
number, so it lives in one place rather than once per source.
"""

from __future__ import annotations

from typing import Any


def raw_signature_size(public_key: Any) -> int:
    """Upper bound, in bytes, on the raw signature this key produces.

    For RSA the signature is exactly the modulus width. For EC it is the DER
    ``SEQUENCE`` of two INTEGERs, each at worst one leading zero byte wider
    than the field (DER INTEGER is signed). The SEQUENCE header is NOT a fixed
    two bytes: a payload of 128 or more takes the long form, which P-521
    reaches (2 * (67 + 2) = 138 -> 0x30 0x81 0x8A, 141 in all).
    """
    if public_key.algorithm == "ec":
        field = (public_key.bit_size + 7) // 8
        integer = field + 1 + 2
        payload = 2 * integer
        header = 2 if payload < 0x80 else 2 + (payload.bit_length() + 7) // 8
        return payload + header
    return (public_key.bit_size + 7) // 8
