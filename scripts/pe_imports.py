"""Import tables of Windows PE files, read without a toolchain.

Used by the shipped-binary gates: which DLL names a binary binds to, and
which symbols it takes from each, and which it exports. The parser reads the on-disk image only;
nothing is loaded, so it is safe on any file, including one that would
fail to load on this machine. Standard library only: the gates run it under
the embedded runtime, which carries no third-party parser.

    python scripts/pe_imports.py <file-or-directory> ...

prints one JSON object keyed by path, each value
{"imports": [dll, ...], "delay_imports": [dll, ...]}. A directory argument
contributes every *.dll and *.pyd beneath it.
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path


class NotPE(ValueError):
    pass


_EXPORT_DIR = 0
_IMPORT_DIR = 1
_DELAY_IMPORT_DIR = 13
_RESOURCE_DIR = 2
_RT_VERSION = 16


class _Image:
    def __init__(self, data: bytes):
        if len(data) < 0x40 or data[:2] != b"MZ":
            raise NotPE("not an MZ image")
        pe = struct.unpack_from("<I", data, 0x3C)[0]
        if data[pe : pe + 4] != b"PE\0\0":
            raise NotPE("no PE signature")
        self.data = data
        opt = pe + 24
        magic = struct.unpack_from("<H", data, opt)[0]
        if magic not in (0x10B, 0x20B):
            raise NotPE(f"unknown optional-header magic {magic:#x}")
        self.plus = magic == 0x20B
        # NumberOfRvaAndSizes bounds the directory table; an entry past it is
        # absent, not zero-filled.
        self.ndirs = struct.unpack_from("<I", data, opt + (108 if self.plus else 92))[0]
        self.ddir = opt + (112 if self.plus else 96)
        nsec = struct.unpack_from("<H", data, pe + 6)[0]
        opt_size = struct.unpack_from("<H", data, pe + 20)[0]
        first = pe + 24 + opt_size
        self.sections = []
        for i in range(nsec):
            s = first + 40 * i
            va_size, va, raw_size, raw = struct.unpack_from("<IIII", data, s + 8)
            self.sections.append((va, va_size, raw, raw_size))

    def directory(self, index: int) -> tuple[int, int]:
        if index >= self.ndirs:
            return 0, 0
        return struct.unpack_from("<II", self.data, self.ddir + 8 * index)

    def off(self, rva: int) -> int:
        for va, vsize, raw, rsize in self.sections:
            if va <= rva < va + max(vsize, rsize):
                return rva - va + raw
        raise ValueError(f"rva {rva:#x} maps to no section")

    def cstr(self, rva: int) -> str:
        start = self.off(rva)
        end = self.data.index(b"\0", start)
        return self.data[start:end].decode("ascii", "replace")

    def thunks(self, rva: int) -> list[str]:
        size = 8 if self.plus else 4
        ordinal_flag = 1 << 63 if self.plus else 1 << 31
        out: list[str] = []
        t = self.off(rva)
        while True:
            entry = struct.unpack_from("<Q" if self.plus else "<I", self.data, t)[0]
            if entry == 0:
                return out
            if entry & ordinal_flag:
                out.append(f"#{entry & 0xFFFF}")
            else:
                out.append(self.cstr((entry & 0x7FFFFFFF) + 2))
            t += size


def _image(path: str | Path) -> _Image:
    return _Image(Path(path).read_bytes())


def imports(path: str | Path) -> dict[str, list[str]]:
    """{dll name: [imported symbol or '#ordinal', ...]} of the static import table."""
    img = _image(path)
    rva, _size = img.directory(_IMPORT_DIR)
    out: dict[str, list[str]] = {}
    if rva == 0:
        return out
    off = img.off(rva)
    while True:
        ilt, _ts, _fc, name_rva, iat = struct.unpack_from("<IIIII", img.data, off)
        if name_rva == 0:
            return out
        out[img.cstr(name_rva)] = img.thunks(ilt or iat)
        off += 20


def delay_imports(path: str | Path) -> dict[str, list[str]]:
    """{dll name: [symbol, ...]} of the delay-load import table.

    A delay-loaded DLL is bound on first call rather than at load, so a gate
    that reads only the static table passes a binary that still reaches it.
    """
    img = _image(path)
    rva, _size = img.directory(_DELAY_IMPORT_DIR)
    out: dict[str, list[str]] = {}
    if rva == 0:
        return out
    off = img.off(rva)
    while True:
        attrs, name_rva, _hmod, _iat, int_rva = struct.unpack_from("<IIIII", img.data, off)
        if name_rva == 0:
            return out
        # Attribute bit 0 clear marks the pre-VC7 layout whose fields are VAs.
        if not attrs & 1:
            raise NotPE("VA-based delay-import descriptor")
        out[img.cstr(name_rva)] = img.thunks(int_rva) if int_rva else []
        off += 32


def exports(path: str | Path) -> list[str]:
    """Names in the export table; an export by ordinal only is '#ordinal'."""
    img = _image(path)
    rva, _size = img.directory(_EXPORT_DIR)
    if rva == 0:
        return []
    off = img.off(rva)
    base, n_funcs, n_names, _funcs, names_rva, ords_rva = struct.unpack_from("<IIIIII", img.data, off + 16)
    out: list[str] = []
    named: set[int] = set()
    if n_names:
        names = img.off(names_rva)
        ords = img.off(ords_rva)
        for i in range(n_names):
            out.append(img.cstr(struct.unpack_from("<I", img.data, names + 4 * i)[0]))
            named.add(struct.unpack_from("<H", img.data, ords + 2 * i)[0])
    out.extend(f"#{base + i}" for i in range(n_funcs) if i not in named)
    return out


def _resource_entries(img: _Image, base: int, table: int) -> list[tuple[int, int]]:
    """[(id-or-name-offset, entry-offset), ...] of one IMAGE_RESOURCE_DIRECTORY."""
    named, ids = struct.unpack_from("<HH", img.data, table + 12)
    out = []
    for i in range(named + ids):
        ident, target = struct.unpack_from("<II", img.data, table + 16 + 8 * i)
        out.append((ident, target))
    return out


def _version_blob(img: _Image) -> bytes | None:
    rva, _size = img.directory(_RESOURCE_DIR)
    if rva == 0:
        return None
    base = img.off(rva)
    for ident, target in _resource_entries(img, base, base):
        if ident != _RT_VERSION or not target & 0x80000000:
            continue
        level = base + (target & 0x7FFFFFFF)
        # Type -> name -> language: the first leaf is the version resource;
        # a DLL carries one, and every language variant holds the same fixed block.
        for _ in range(2):
            entries = _resource_entries(img, base, level)
            if not entries:
                return None
            nxt = entries[0][1]
            if nxt & 0x80000000:
                level = base + (nxt & 0x7FFFFFFF)
            else:
                data_rva, size = struct.unpack_from("<II", img.data, base + nxt)
                start = img.off(data_rva)
                return img.data[start : start + size]
        return None
    return None


def _align4(n: int) -> int:
    return (n + 3) & ~3


def _blocks(blob: bytes, start: int, end: int):
    """Yield (key, value-bytes, wType, children-start, block-end) for each
    VS_VERSIONINFO-shaped block in [start, end)."""
    pos = start
    while pos + 6 <= end:
        length, value_len, wtype = struct.unpack_from("<HHH", blob, pos)
        if length == 0:
            return
        block_end = min(pos + length, end)
        k = pos + 6
        key_end = k
        while key_end + 1 < block_end and blob[key_end : key_end + 2] != b"\0\0":
            key_end += 2
        key = blob[k:key_end].decode("utf-16-le", "replace")
        value_at = _align4(key_end + 2)
        # wValueLength counts WCHARs for a text value, bytes for binary.
        vbytes = value_len * 2 if wtype == 1 else value_len
        value = blob[value_at : min(value_at + vbytes, block_end)]
        yield key, value, wtype, _align4(value_at + vbytes), block_end
        pos = _align4(block_end)


def version_info(path: str | Path) -> dict[str, str] | None:
    """The VS_VERSIONINFO resource: 'FileVersion#'/'ProductVersion#' from the
    fixed block as dotted quads, plus every StringFileInfo string (first
    string table wins). None when the image carries no version resource."""
    img = _image(path)
    blob = _version_blob(img)
    if not blob:
        return None
    out: dict[str, str] = {}
    for key, value, _t, children, end in _blocks(blob, 0, len(blob)):
        if key != "VS_VERSION_INFO":
            continue
        if len(value) >= 52 and struct.unpack_from("<I", value, 0)[0] == 0xFEEF04BD:
            fms, fls, pms, pls = struct.unpack_from("<IIII", value, 8)
            out["FileVersion#"] = f"{fms >> 16}.{fms & 0xFFFF}.{fls >> 16}.{fls & 0xFFFF}"
            out["ProductVersion#"] = f"{pms >> 16}.{pms & 0xFFFF}.{pls >> 16}.{pls & 0xFFFF}"
        for ckey, _v, _t2, cchildren, cend in _blocks(blob, children, end):
            if ckey != "StringFileInfo":
                continue
            for _table, _v3, _t3, tchildren, tend in _blocks(blob, cchildren, cend):
                for skey, svalue, _t4, _c, _e in _blocks(blob, tchildren, tend):
                    text = svalue.decode("utf-16-le", "replace").split("\0", 1)[0].strip()
                    out.setdefault(skey, text)
    return out


def binaries(paths: list[str]) -> list[Path]:
    out: list[Path] = []
    for p in map(Path, paths):
        if p.is_dir():
            out.extend(sorted(f for f in p.rglob("*") if f.suffix.lower() in (".dll", ".pyd") and f.is_file()))
        else:
            out.append(p)
    return out


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    report = {}
    for f in binaries(argv):
        report[str(f)] = {"imports": list(imports(f)), "delay_imports": list(delay_imports(f))}
    json.dump(report, sys.stdout, indent=1)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
