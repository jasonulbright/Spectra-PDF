"""Is a HEIF file cut off?

The HEIF decoder opens a file that ends early and fills what is missing with a
flat or broken area, with no error. This module reads the container only and
answers one question: does the file name data that lies after its end? An
interrupted copy or download is the usual cause.

A False answer does not mean the file is undamaged. Damage inside data that is
present is not visible here, and the decoder does not report it.
"""

from __future__ import annotations

import os
import struct
from pathlib import Path
from typing import BinaryIO, Iterator

# Brands of still images and image sequences coded with HEVC, and the two
# general HEIF brands. AVIF has its own major brands and another decoder.
_BRANDS = frozenset({b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"})
# Top-level boxes whose loss costs picture data. Another box that overruns the
# file can be bytes a camera appended after the HEIF data, which is not damage.
_DATA_BOXES = frozenset({b"ftyp", b"meta", b"mdat", b"moov"})
# The item tables of real files are far below this. A larger `meta` box is not
# read.
_META_LIMIT = 32 * 1024 * 1024
#: What every run log says about such a file.
LOG_TEXT = "the file is cut off; parts of the picture can be missing or wrong"


def log_line(item: dict) -> str:
    """One run-log line for a `create_pdf` ``incomplete`` entry."""
    return f"{Path(item['path']).name} (PDF pages: {item['pages']}): {LOG_TEXT}"


def _top_level(stream: BinaryIO, size: int) -> Iterator[tuple[bytes, int, int]]:
    """(type, payload start, box end) of each top-level box; the end can lie
    after the end of the file."""
    start = 0
    while start + 8 <= size:
        stream.seek(start)
        header = stream.read(16)
        length, kind = struct.unpack_from(">I4s", header)
        head = 8
        if length == 1:
            if len(header) < 16:
                return
            length = struct.unpack_from(">Q", header, 8)[0]
            head = 16
        elif length == 0:
            length = size - start
        if length < head:
            return
        yield kind, start + head, start + length
        start += length


def _children(data: bytes) -> Iterator[tuple[bytes, bytes]]:
    start = 0
    while start + 8 <= len(data):
        length, kind = struct.unpack_from(">I4s", data, start)
        if length < 8 or start + length > len(data):
            return
        yield kind, data[start + 8 : start + length]
        start += length


def _extent_ends(iloc: bytes) -> Iterator[int]:
    """The end offset in the file of each item extent that `iloc` places at a
    file offset. A table that stops early yields what it could be read to."""
    position = 0

    def read(width: int) -> int:
        nonlocal position
        if position + width > len(iloc):
            raise EOFError
        value = int.from_bytes(iloc[position : position + width], "big")
        position += width
        return value

    try:
        version = read(1)
        read(3)
        if version > 2:
            return
        sizes = read(1)
        offset_size, length_size = sizes >> 4, sizes & 15
        sizes = read(1)
        base_size = sizes >> 4
        index_size = sizes & 15 if version else 0
        id_size = 4 if version == 2 else 2
        for _ in range(read(id_size)):
            read(id_size)
            method = read(2) & 15 if version else 0
            data_reference = read(2)
            base = read(base_size)
            for _ in range(read(2)):
                read(index_size)
                offset = read(offset_size)
                length = read(length_size)
                # Method 0 in this file; other methods and references point
                # inside `meta` or outside the file. A zero length means "the
                # whole source" and names no end.
                if method == 0 and data_reference == 0 and length:
                    yield base + offset + length
    except EOFError:
        return


def is_cut_off(path: str | Path) -> bool:
    """True when `path` is a HEIF file that names data after its end.

    False for a file that is not HEIF and for one that cannot be read: those are
    the decoder's refusals to make, and this check never refuses.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as stream:
            head = stream.read(12)
            if len(head) < 12 or head[4:8] != b"ftyp" or head[8:12] not in _BRANDS:
                return False
            for kind, body, end in _top_level(stream, size):
                if end > size and kind in _DATA_BOXES:
                    return True
                if kind != b"meta" or end > size or end - body > _META_LIMIT:
                    continue
                stream.seek(body)
                payload = stream.read(end - body)
                # `meta` is a full box: four bytes of version and flags first.
                for child, data in _children(payload[4:]):
                    if child == b"iloc" and any(stop > size for stop in _extent_ends(data)):
                        return True
    except OSError:
        return False
    return False
