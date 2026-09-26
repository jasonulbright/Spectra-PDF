"""Extract one file from an MSYS2 package archive after checking its SHA-256.

    python scripts/msys2_package.py <archive.pkg.tar.zst> <sha256> <member> <dest>

The archive must hash to <sha256> (the value MSYS2's repository database
publishes as %SHA256SUM% for that file name); otherwise nothing is written.
<member> is the path inside the archive (e.g. mingw64/bin/zlib1.dll).
Standard library only: runs under the embedded runtime (Python 3.14 carries
compression.zstd).
"""

from __future__ import annotations

import hashlib
import sys
import tarfile
from compression import zstd
from pathlib import Path


def extract(archive: Path, sha256: str, member: str, dest: Path) -> None:
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual != sha256.lower():
        raise ValueError(f"{archive.name} has SHA-256 {actual}; pinned {sha256.lower()}")
    with zstd.open(archive) as raw, tarfile.open(fileobj=raw, mode="r|") as tar:
        for entry in tar:
            if entry.name == member and entry.isfile():
                dest.write_bytes(tar.extractfile(entry).read())
                return
    raise FileNotFoundError(f"{archive.name} has no member {member}")


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        extract(Path(argv[0]), argv[1], argv[2], Path(argv[3]))
    except (OSError, ValueError, tarfile.TarError) as exc:
        print(f"msys2_package: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
