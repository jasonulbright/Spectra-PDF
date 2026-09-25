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
