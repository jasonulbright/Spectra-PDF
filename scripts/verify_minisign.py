"""Verify a Tauri updater signature (a minisign signature box) over a file.

The updater public key and signature are the strings Tauri writes: base64 of
the minisign public key file and of the minisign signature file. The check is
the one minisign performs: the key ids match, the Ed25519 signature over the
file (BLAKE2b-512 prehash for algorithm `ED`, the raw bytes for `Ed`) holds,
and the global signature over the signature and the trusted comment holds.
With `--expect-file`, the trusted comment's `file:` field must equal that name.

Ed25519 verification follows RFC 8032 section 5.1.7 with no dependency beyond
the standard library: the release runner verifies with the same code the tests
exercise.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path

P = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
D = (-121665 * pow(121666, P - 2, P)) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)

Point = tuple[int, int, int, int]


def _add(a: Point, b: Point) -> Point:
    x1, y1, z1, t1 = a
    x2, y2, z2, t2 = b
    aa = (y1 - x1) * (y2 - x2) % P
    bb = (y1 + x1) * (y2 + x2) % P
    cc = 2 * t1 * t2 * D % P
    dd = 2 * z1 * z2 % P
    e, f, g, h = bb - aa, dd - cc, dd + cc, bb + aa
    return (e * f % P, g * h % P, f * g % P, e * h % P)


def _multiply(scalar: int, point: Point) -> Point:
    result: Point = (0, 1, 1, 0)
    while scalar > 0:
        if scalar & 1:
            result = _add(result, point)
        point = _add(point, point)
        scalar >>= 1
    return result


def _equal(a: Point, b: Point) -> bool:
    x1, y1, z1, _ = a
    x2, y2, z2, _ = b
    return (x1 * z2 - x2 * z1) % P == 0 and (y1 * z2 - y2 * z1) % P == 0


def _recover_x(y: int, sign: int) -> int | None:
    if y >= P:
        return None
    x2 = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P != 0:
        x = x * SQRT_M1 % P
    if (x * x - x2) % P != 0:
        return None
    if (x & 1) != sign:
        x = P - x
    return x


def _decompress(data: bytes) -> Point | None:
    if len(data) != 32:
        return None
    y = int.from_bytes(data, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % P)


_GY = 4 * pow(5, P - 2, P) % P
_GX = _recover_x(_GY, 0)
assert _GX is not None
BASE: Point = (_GX, _GY, 1, _GX * _GY % P)


def ed25519_verify(public: bytes, message: bytes, signature: bytes) -> bool:
    if len(public) != 32 or len(signature) != 64:
        return False
    a = _decompress(public)
    r = _decompress(signature[:32])
    if a is None or r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= L:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public + message).digest(), "little") % L
    return _equal(_multiply(s, BASE), _add(r, _multiply(h, a)))


class SignatureError(Exception):
    pass


@dataclass(frozen=True)
class Verified:
    trusted_comment: str
    fields: dict[str, str]


def _box_lines(encoded: str, what: str) -> list[str]:
    try:
        text = base64.b64decode(encoded.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError) as e:
        raise SignatureError(f"the {what} is not base64 of a minisign {what} box: {e}") from None
    return [line for line in text.replace("\r\n", "\n").split("\n") if line != ""]


def _b64(line: str, length: int, what: str) -> bytes:
    try:
        data = base64.b64decode(line, validate=True)
    except binascii.Error as e:
        raise SignatureError(f"the {what} line is not base64: {e}") from None
    if len(data) != length:
        raise SignatureError(f"the {what} line decodes to {len(data)} bytes, expected {length}")
    return data


def parse_public_key(encoded: str) -> tuple[bytes, bytes]:
    lines = _box_lines(encoded, "public key")
    if len(lines) != 2 or not lines[0].startswith("untrusted comment:"):
        raise SignatureError("the public key box is not two lines with an untrusted comment")
    raw = _b64(lines[1], 42, "public key")
    if raw[:2] != b"Ed":
        raise SignatureError("the public key is not an Ed25519 minisign key")
    return raw[2:10], raw[10:]


def _file_message(path: Path, algorithm: bytes) -> bytes:
    if algorithm == b"Ed":
        return path.read_bytes()
    digest = hashlib.blake2b(digest_size=64)
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.digest()


def verify_file(public_key: str, signature: str, path: Path, expect_file: str | None = None) -> Verified:
    key_id, public = parse_public_key(public_key)
    lines = _box_lines(signature, "signature")
    if (
        len(lines) != 4
        or not lines[0].startswith("untrusted comment:")
        or not lines[2].startswith("trusted comment: ")
    ):
        raise SignatureError("the signature box is not four lines with untrusted and trusted comments")
    raw = _b64(lines[1], 74, "signature")
    algorithm, signed_key_id, sig = raw[:2], raw[2:10], raw[10:]
    if algorithm not in (b"Ed", b"ED"):
        raise SignatureError(f"unknown signature algorithm {algorithm!r}")
    if signed_key_id != key_id:
        raise SignatureError(
            f"the signature names key {signed_key_id[::-1].hex().upper()}, "
            f"the public key is {key_id[::-1].hex().upper()}"
        )
    if not ed25519_verify(public, _file_message(path, algorithm), sig):
        raise SignatureError(f"the signature does not verify over {path.name}")
    trusted = lines[2][len("trusted comment: "):]
    global_sig = _b64(lines[3], 64, "global signature")
    if not ed25519_verify(public, sig + trusted.encode("utf-8"), global_sig):
        raise SignatureError("the trusted comment's global signature does not verify")
    fields: dict[str, str] = {}
    for part in trusted.split("\t"):
        name, sep, value = part.partition(":")
        if sep:
            fields[name] = value
    if expect_file is not None and fields.get("file") != expect_file:
        raise SignatureError(
            f"the trusted comment names file {fields.get('file')!r}, expected {expect_file!r}"
        )
    return Verified(trusted, fields)


def public_key_from_conf(conf: Path) -> str:
    """`plugins.updater.pubkey` of a tauri.conf.json."""
    try:
        data = json.loads(conf.read_text(encoding="utf-8"))
        key = data["plugins"]["updater"]["pubkey"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise SignatureError(f"{conf} carries no plugins.updater.pubkey: {e}") from None
    if not isinstance(key, str) or not key.strip():
        raise SignatureError(f"{conf} carries an empty plugins.updater.pubkey")
    return key


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    key = parser.add_mutually_exclusive_group(required=True)
    key.add_argument("--public-key", help="base64 updater public key")
    key.add_argument("--public-key-from-conf", type=Path, help="tauri.conf.json carrying plugins.updater.pubkey")
    parser.add_argument("--key-only", action="store_true", help="parse the public key and stop")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--signature", help="base64 updater signature")
    source.add_argument("--signature-file", type=Path, help="file holding the base64 updater signature")
    parser.add_argument("--file", type=Path)
    parser.add_argument("--expect-file", help="the name the trusted comment's file: field must carry")
    args = parser.parse_args(argv)
    if not args.key_only and (args.file is None or (args.signature is None and args.signature_file is None)):
        parser.error("--file and one of --signature/--signature-file are required unless --key-only is given")
    try:
        public_key = args.public_key
        if args.public_key_from_conf is not None:
            public_key = public_key_from_conf(args.public_key_from_conf)
        key_id, _ = parse_public_key(public_key)
        if args.key_only:
            print(f"updater public key {key_id[::-1].hex().upper()} parses")
            return 0
        signature = args.signature
        if args.signature_file is not None:
            signature = args.signature_file.read_text(encoding="utf-8")
        verify_file(public_key, signature, args.file, args.expect_file)
    except (SignatureError, OSError) as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    print(f"verified {args.file.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
