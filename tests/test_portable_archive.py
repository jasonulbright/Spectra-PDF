"""The portable ZIP writer and verifier behind scripts/build-portable-zip.ps1.

The archive that ships is written by scripts/portable-archive.ps1 with entry
names computed from the installer manifest, so its identity cannot follow the
archive module installed on the machine that writes it. These tests drive that
library through each PowerShell the release path uses: they write small faithful
archives carrying every name class the payload can hold, read them back with an
independent implementation, and feed the verifier one mutation at a time.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
import stat
import struct
import subprocess
import warnings
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
LIBRARY = ROOT / "scripts" / "portable-archive.ps1"
BUILDER = ROOT / "scripts" / "build-portable-zip.ps1"
SMOKE = ROOT / "scripts" / "smoke-portable-packaging.ps1"

#: The release workflow runs the builder under Windows PowerShell; the packaging
#: smoke verifies under both. Neither is optional on the runner.
SHELLS = ("powershell", "pwsh")

#: One of each name class the payload can carry: the root executable, a nested
#: path, a hidden binary file, a nested name with spaces and non-ASCII letters,
#: and an empty file.
TREE = {
    "spectrapdf.exe": b"packed application bytes",
    "engine/nested/deep/module.py": b"print('portable')\n",
    "engine/hidden data/.hidden control.bin": bytes(range(256)) * 4,
    "icc/\u00fcn\u00efcode dir/na\u00efve r\u00e9sum\u00e9.txt": "fixture unicode control".encode(),
    "THIRD-PARTY-LICENSES.md": b"",
}
HIDDEN = "engine/hidden data/.hidden control.bin"
UNICODE = "icc/\u00fcn\u00efcode dir/na\u00efve r\u00e9sum\u00e9.txt"

DRIVER = r"""
param([string]$Spec)
$ErrorActionPreference = 'Stop'
. '@@LIBRARY@@'
$request = Get-Content -LiteralPath $Spec -Raw -Encoding UTF8 | ConvertFrom-Json
$results = @()
foreach ($case in @($request.cases)) {
    $result = [ordered]@{ key = $case.key; ok = $true; error = ''; problems = @() }
    try {
        switch ($case.mode) {
            'write' { $null = Write-PortableArchive -Path $case.archive -Entries @($case.entries) }
            'verify' { $result.problems = @(Test-PortableArchive -Path $case.archive -Expected @($case.entries)) }
            'name' { $result.name = ConvertTo-PortableEntryName $case.name }
            'read' {
                $directory = Read-PortableArchiveDirectory -Path $case.archive
                $result.entryCount = $directory.entryCount
                $result.zip64 = $directory.zip64
                $result.localMismatches = @($directory.entries | Where-Object { -not $_.localNameMatches }).Count
                $result.descriptors = @($directory.entries | Where-Object { $null -ne $_.descriptor }).Count
                $result.first = $directory.entries[0].name
                $last = $directory.entries[$directory.entries.Count - 1]
                $result.last = $last.name
                $result.lastOffset = $last.localOffset
                $result.lastCompressed = $last.compressedSize
                $result.lastUncompressed = $last.uncompressedSize
                $result.lastCentralZip64 = $last.centralZip64
                $result.lastLocalZip64 = $last.localZip64
                $result.lastLocalCompressed = $last.localCompressedSize
            }
        }
    } catch {
        $result.ok = $false
        $result.error = $_.Exception.Message
    }
    $results += [pscustomobject]$result
}
[IO.File]::WriteAllText($request.output, (ConvertTo-Json -InputObject @($results) -Depth 5), [Text.UTF8Encoding]::new($false))
"""


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest().upper()


def _make_tree(root: Path) -> list[dict]:
    """Lay TREE down on disk and return the writer's entry list for it."""
    entries = []
    for name, data in TREE.items():
        path = root.joinpath(*name.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        if name == HIDDEN:
            assert ctypes.windll.kernel32.SetFileAttributesW(str(path), stat.FILE_ATTRIBUTE_HIDDEN)
            assert os.stat(path).st_file_attributes & stat.FILE_ATTRIBUTE_HIDDEN
        entries.append({"name": name, "source": str(path), "sha256": _sha256(data)})
    return entries


def _drive(shell: str, workdir: Path, cases: list[dict]) -> dict[str, dict]:
    driver = workdir / "driver.ps1"
    driver.write_text(DRIVER.replace("@@LIBRARY@@", str(LIBRARY)), encoding="ascii")
    output = workdir / "results.json"
    spec = workdir / "spec.json"
    spec.write_text(json.dumps({"cases": cases, "output": str(output)}), encoding="utf-8")
    run = subprocess.run(
        [shell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-File", str(driver), "-Spec", str(spec)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    assert run.returncode == 0, run.stdout + run.stderr
    results = json.loads(output.read_text(encoding="utf-8"))
    assert [r["key"] for r in results] == [c["key"] for c in cases]
    return {r["key"]: r for r in results}


def _local_names(archive: Path) -> list[str]:
    """Each entry's name as its LOCAL file header spells it, in central order."""
    names = []
    with zipfile.ZipFile(archive) as z, archive.open("rb") as raw:
        for info in z.infolist():
            raw.seek(info.header_offset)
            header = raw.read(30)
            assert header[:4] == b"PK\x03\x04"
            flags, = struct.unpack_from("<H", header, 6)
            length, = struct.unpack_from("<H", header, 26)
            names.append(raw.read(length).decode("utf-8" if flags & 0x800 else "cp437"))
    return names


def _write_zip(path: Path, members: list[tuple[str, bytes]], stored: bool = False) -> None:
    """An archive from an independent writer, names stored exactly as given."""
    method = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # duplicate names are deliberate here
        with zipfile.ZipFile(path, "w", method) as z:
            for name, data in members:
                info = zipfile.ZipInfo("placeholder", date_time=(2026, 1, 1, 0, 0, 0))
                info.filename = name  # bypasses the constructor's separator rewrite
                info.compress_type = method
                if name.endswith("/"):
                    info.external_attr = 0o40775 << 16 | 0x10
                z.writestr(info, data)


def _patch(path: Path, old: bytes, new: bytes, count: int) -> None:
    raw = path.read_bytes()
    assert raw.count(old) == count, (old, raw.count(old))
    path.write_bytes(raw.replace(old, new))


class _Unseekable:
    """A write-only sink: zipfile then stores CRC and sizes in data descriptors."""

    def __init__(self, sink):
        self._sink = sink

    def write(self, data):
        return self._sink.write(data)

    def flush(self):
        self._sink.flush()


def _write_descriptor_zip(path: Path, members: list[tuple[str, bytes]]) -> None:
    with path.open("wb") as sink, zipfile.ZipFile(_Unseekable(sink), "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in members:
            z.writestr(name, data)


def _end_record(raw: bytes) -> tuple[int, int, int, int]:
    """(eocd offset, entry count, directory size, directory offset)."""
    eocd = raw.rindex(b"PK\x05\x06")
    count, size, offset = struct.unpack_from("<HII", raw, eocd + 10)
    return eocd, count, size, offset


def _central_record(raw: bytes, index: int) -> int:
    _, count, _, offset = _end_record(raw)
    assert index < count
    for i in range(count):
        assert raw[offset:offset + 4] == b"PK\x01\x02"
        if i == index:
            return offset
        n, m, k = struct.unpack_from("<HHH", raw, offset + 28)
        offset += 46 + n + m + k
    raise AssertionError(index)


def _zip64_central(path: Path, index: int, declared_size: int = 24) -> None:
    """Move one central record's sizes and offset into a ZIP64 extra field, the
    form a 4 GB payload would force, with `declared_size` on that field."""
    raw = bytearray(path.read_bytes())
    eocd, _, directory_size, _ = _end_record(raw)
    record = _central_record(raw, index)
    compressed, uncompressed = struct.unpack_from("<II", raw, record + 20)
    n, m = struct.unpack_from("<HH", raw, record + 28)
    local_offset, = struct.unpack_from("<I", raw, record + 42)
    field = struct.pack("<HHQQQ", 1, declared_size, uncompressed, compressed, local_offset)
    struct.pack_into("<II", raw, record + 20, 0xFFFFFFFF, 0xFFFFFFFF)
    struct.pack_into("<I", raw, record + 42, 0xFFFFFFFF)
    struct.pack_into("<H", raw, record + 30, m + len(field))
    raw[record + 46 + n + m:record + 46 + n + m] = field
    struct.pack_into("<I", raw, eocd + len(field) + 12, directory_size + len(field))
    path.write_bytes(bytes(raw))


@pytest.fixture(params=SHELLS)
def shell(request):
    return request.param


def test_writer_stores_canonical_names_and_exact_bytes(shell, tmp_path):
    entries = _make_tree(tmp_path / "tree")
    archive = tmp_path / "out" / "spectrapdf-9.9.9-portable.zip"
    archive.parent.mkdir()
    results = _drive(shell, tmp_path, [
        {"key": "write", "mode": "write", "archive": str(archive), "entries": entries},
        {"key": "verify", "mode": "verify", "archive": str(archive), "entries": entries},
    ])
    assert results["write"]["ok"], results["write"]["error"]
    assert results["verify"]["ok"] and results["verify"]["problems"] == []
    assert archive.is_file()
    assert not archive.with_name(archive.name + ".partial").exists()
    with zipfile.ZipFile(archive) as z:
        assert z.testzip() is None
        infos = z.infolist()
        assert [i.orig_filename for i in infos] == [e["name"] for e in entries]
        for info, entry in zip(infos, entries):
            assert "\\" not in info.orig_filename
            assert not info.is_dir()
            assert bool(info.flag_bits & 0x800) == (not info.orig_filename.isascii())
            # A seekable writer patches sizes into the local header; no entry
            # depends on a trailing data descriptor.
            assert not info.flag_bits & 0x8
            assert _sha256(z.read(info)) == entry["sha256"]
    assert _local_names(archive) == [e["name"] for e in entries]


CANONICAL = {
    "engine\\nested\\x.py": "engine/nested/x.py",
    "engine/mixed\\seps.txt": "engine/mixed/seps.txt",
    "sp ace/\u00fc.txt": "sp ace/\u00fc.txt",
    ".hidden": ".hidden",
    "a/..b": "a/..b",
    "spectrapdf.exe": "spectrapdf.exe",
}
REFUSED = [
    "", " ", "../escape.txt", "engine/../x", "./x", "engine//x", "engine\\\\x", "C:\\x", "\\x", "/x",
    "x:stream", "a/b.", "a/b ", "con?", "trail/", "x\x01y", 'q"uote', "pipe|x",
]


def test_entry_name_rules(shell, tmp_path):
    cases = [{"key": f"ok{i}", "mode": "name", "name": raw} for i, raw in enumerate(CANONICAL)]
    cases += [{"key": f"no{i}", "mode": "name", "name": raw} for i, raw in enumerate(REFUSED)]
    results = _drive(shell, tmp_path, cases)
    for i, (raw, canonical) in enumerate(CANONICAL.items()):
        result = results[f"ok{i}"]
        assert result["ok"] and result["name"] == canonical, (raw, result)
    for i, raw in enumerate(REFUSED):
        result = results[f"no{i}"]
        assert not result["ok"] and "unsafe payload destination" in result["error"], (raw, result)


def test_writer_refusals_leave_no_archive(shell, tmp_path):
    entries = _make_tree(tmp_path / "tree")
    exe, module = entries[0], entries[1]
    outdir = tmp_path / "out"
    outdir.mkdir()
    specs = {
        "duplicate": ([exe, dict(module, name=exe["name"])], "duplicate portable entry"),
        "case": ([exe, dict(module, name="SPECTRAPDF.EXE")], "differ only by case"),
        "non-canonical": ([exe, dict(module, name="engine\\nested\\deep\\module.py")], "not canonical"),
        "unsafe": ([exe, dict(module, name="../escape.py")], "unsafe payload destination"),
        "missing-source": ([exe, dict(module, source=str(tmp_path / "absent.py"))], "source missing"),
        "no-hash": ([exe, dict(module, sha256="")], "carries no SHA-256"),
        "wrong-hash": ([exe, dict(module, sha256=_sha256(b"other"))], "refused before it was named"),
        "empty": ([], "no entries"),
    }
    cases = [{"key": key, "mode": "write", "archive": str(outdir / f"{key}.zip"), "entries": spec}
             for key, (spec, _) in specs.items()]
    results = _drive(shell, tmp_path, cases)
    for key, (_, reason) in specs.items():
        assert not results[key]["ok"], key
        assert reason in results[key]["error"], (key, results[key]["error"])
    assert results["wrong-hash"]["error"].count("archive bytes differ") == 1
    assert sorted(p.name for p in outdir.iterdir()) == []


def _mutations(tree: Path, entries: list[dict], outdir: Path) -> dict[str, tuple[Path, str]]:
    """Archive path and the refusal each mutation must earn; 'clean' earns none."""
    base = [(e["name"], TREE[e["name"]]) for e in entries]
    exe_name, exe_data = base[0]
    module_name, module_data = base[1]
    built: dict[str, tuple[Path, str]] = {}

    def make(key: str, members, reason: str) -> Path:
        path = outdir / f"{key}.zip"
        _write_zip(path, members)
        built[key] = (path, reason)
        return path

    make("clean", base, "")
    make("backslash", [(module_name.replace("/", "\\"), module_data)] + base[1:], "backslash separator")
    make("traversal", base + [("../escape.txt", b"x")], "unsafe entry name")
    make("duplicate", base + [(module_name, module_data)], "duplicate entry")
    make("missing", base[:-1], "in the installer manifest but not in the archive")
    make("extra", base + [("extra.txt", b"unexpected")], "in the archive but not in the installer manifest")
    make("bytes", [(exe_name, exe_data[:-1] + b"X")] + base[1:], "archive bytes differ")
    make("directory", base + [("engine/", b"")], "directory entry")
    make("case-collision", base + [(module_name.replace("engine", "Engine", 1), module_data)], "differ only by case")
    make("wrapper", [("spectrapdf/" + name, data) for name, data in base], "not in the archive: spectrapdf.exe")

    corrupt = make("corrupt", base, "")
    with zipfile.ZipFile(corrupt) as z:
        info = z.getinfo(HIDDEN)
        assert info.compress_size > 8
        data_start = info.header_offset + 30 + len(info.orig_filename.encode()) + len(info.extra)
    raw = bytearray(corrupt.read_bytes())
    raw[data_start + 4] ^= 0xFF
    corrupt.write_bytes(bytes(raw))
    built["corrupt"] = (corrupt, HIDDEN)

    local_name = make("local-name", base, "local header name differs")
    raw = bytearray(local_name.read_bytes())
    assert raw[:4] == b"PK\x03\x04" and raw[30:30 + len(exe_name)] == exe_name.encode()
    raw[30] ^= 0x20
    local_name.write_bytes(bytes(raw))

    local_flag = make("local-flag", base, "local header flags differ")
    with zipfile.ZipFile(local_flag) as z:
        offset = z.getinfo(UNICODE).header_offset
    raw = bytearray(local_flag.read_bytes())
    flags, = struct.unpack_from("<H", raw, offset + 6)
    assert flags & 0x800
    struct.pack_into("<H", raw, offset + 6, flags & ~0x800)
    local_flag.write_bytes(bytes(raw))

    # cp437 0x81 spells a letter no ASCII reader can name; both headers agree,
    # neither carries the UTF-8 flag.
    no_flag = make("no-utf8-flag", base + [("icc/qqzz.txt", b"q")], "without the UTF-8 flag")
    _patch(no_flag, b"icc/qqzz.txt", b"icc/\x81\x81zz.txt", 2)

    garbage = make("trailing-garbage", base, "portable archive structure")
    garbage.write_bytes(garbage.read_bytes() + b"appended after the end record")

    truncated = make("truncated", base, "portable archive structure")
    truncated.write_bytes(truncated.read_bytes()[:-3])
    return built


def test_verifier_refuses_each_mutation(shell, tmp_path):
    tree = tmp_path / "tree"
    entries = _make_tree(tree)
    outdir = tmp_path / "out"
    outdir.mkdir()
    built = _mutations(tree, entries, outdir)
    cases = [{"key": key, "mode": "verify", "archive": str(path), "entries": entries}
             for key, (path, _) in built.items()]
    cases.append({"key": "absent", "mode": "verify", "archive": str(outdir / "absent.zip"), "entries": entries})
    results = _drive(shell, tmp_path, cases)
    assert results["clean"]["ok"] and results["clean"]["problems"] == [], results["clean"]
    assert results["absent"]["problems"] == [f"portable archive missing: {outdir / 'absent.zip'}"]
    for key, (_, reason) in built.items():
        if key == "clean":
            continue
        result = results[key]
        assert result["ok"], (key, result["error"])
        assert result["problems"], key
        assert any(reason in problem for problem in result["problems"]), (key, result["problems"])
    # A flipped compressed byte is refused for the entry it damages, by
    # whichever reason the decompressor reaches first.
    assert all(HIDDEN in problem for problem in results["corrupt"]["problems"]), results["corrupt"]
    # The verifier never mutates what it examines.
    for key, (path, _) in built.items():
        assert path.is_file(), key


def test_reader_follows_a_zip64_central_directory(shell, tmp_path):
    """More entries than a 16-bit count holds: the end record carries sentinels
    and the real directory is reached through the ZIP64 locator."""
    archive = tmp_path / "many.zip"
    count = 65536
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        for i in range(count):
            z.writestr(f"e/{i:05d}", b"")
    raw = archive.read_bytes()
    assert raw.count(b"PK\x06\x06") == 1 and raw.count(b"PK\x06\x07") == 1
    results = _drive(shell, tmp_path, [{"key": "read", "mode": "read", "archive": str(archive)}])
    result = results["read"]
    assert result["ok"], result["error"]
    assert result["zip64"] is True
    assert result["entryCount"] == count
    assert result["localMismatches"] == 0
    assert (result["first"], result["last"]) == ("e/00000", f"e/{count - 1:05d}")


PAIR = [("engine/module.py", b"actual payload bytes"),
        ("engine/next.py", b"second member, so the first has a header after its data")]
PAIR_ENTRIES = [{"name": name, "sha256": _sha256(data)} for name, data in PAIR]


def test_verifier_checks_header_agreement_and_decoded_bytes(shell, tmp_path):
    """The framework reader returns bytes without checking CRC or sizes, and
    reads only the central directory: every declaration is checked here."""
    outdir = tmp_path / "out"
    outdir.mkdir()
    first_data = PAIR[0][1]
    cases: dict[str, tuple[Path, str]] = {}

    def build(key: str, reason: str, writer=_write_zip, mutate=None) -> None:
        path = outdir / f"{key}.zip"
        writer(path, PAIR)
        if mutate is not None:
            raw = bytearray(path.read_bytes())
            mutate(raw)
            path.write_bytes(bytes(raw))
        cases[key] = (path, reason)

    def central(raw: bytearray) -> int:
        return _central_record(bytes(raw), 0)

    def local_method(raw):
        struct.pack_into("<H", raw, 8, 99)

    def local_crc(raw):
        struct.pack_into("<I", raw, 14, 0)

    def both_crc(raw):
        struct.pack_into("<I", raw, 14, 0)
        struct.pack_into("<I", raw, central(raw) + 16, 0)

    def both_method(raw):
        struct.pack_into("<H", raw, 8, 99)
        struct.pack_into("<H", raw, central(raw) + 10, 99)

    def local_flags(raw):
        flags, = struct.unpack_from("<H", raw, 6)
        struct.pack_into("<H", raw, 6, flags | 0x2)

    def local_size(raw):
        struct.pack_into("<I", raw, 22, len(first_data) + 1)

    def both_uncompressed(raw):
        struct.pack_into("<I", raw, 22, len(first_data) + 1)
        struct.pack_into("<I", raw, central(raw) + 24, len(first_data) + 1)

    def both_compressed(raw):
        compressed, = struct.unpack_from("<I", raw, 18)
        struct.pack_into("<I", raw, 18, compressed - 1)
        struct.pack_into("<I", raw, central(raw) + 20, compressed - 1)

    def descriptor_crc(raw):
        n, m = struct.unpack_from("<HH", raw, 26)
        compressed, = struct.unpack_from("<I", raw, central(raw) + 20)
        position = 30 + n + m + compressed
        assert raw[position:position + 4] == b"PK\x07\x08"
        struct.pack_into("<I", raw, position + 4, 0)

    def descriptor_local_crc(raw):
        crc, = struct.unpack_from("<I", raw, central(raw) + 16)
        struct.pack_into("<I", raw, 14, crc)

    build("deflate-control", "")
    build("stored-control", "", writer=lambda path, members: _write_zip(path, members, stored=True))
    build("descriptor-control", "", writer=_write_descriptor_zip)
    build("local-method", "local header compression method differs", mutate=local_method)
    build("local-crc", "local header CRC differs", mutate=local_crc)
    build("both-crc", "decoded bytes do not match the declared CRC-32", mutate=both_crc)
    build("unsupported-method", "unsupported compression method 99", mutate=both_method)
    build("local-flags", "local header flags differ", mutate=local_flags)
    build("local-size", "local header sizes differ", mutate=local_size)
    build("both-size", "decoded length does not match the declared size", mutate=both_uncompressed)
    build("layout", "declared compressed size disagrees with the data layout", mutate=both_compressed)
    build("descriptor-crc", "data descriptor differs", writer=_write_descriptor_zip, mutate=descriptor_crc)
    build("descriptor-local-crc", "carries sizes despite its data-descriptor flag",
          writer=_write_descriptor_zip, mutate=descriptor_local_crc)
    # The independent reader agrees the both-CRC archive is corrupt, and that
    # the descriptor form is a faithful archive.
    with zipfile.ZipFile(cases["both-crc"][0]) as z:
        assert z.testzip() == PAIR[0][0]
    with zipfile.ZipFile(cases["descriptor-control"][0]) as z:
        assert z.testzip() is None
        assert all(info.flag_bits & 0x8 for info in z.infolist())

    verify = [{"key": key, "mode": "verify", "archive": str(path), "entries": PAIR_ENTRIES}
              for key, (path, _) in cases.items()]
    verify.append({"key": "read-descriptor", "mode": "read", "archive": str(cases["descriptor-control"][0])})
    results = _drive(shell, tmp_path, verify)
    for key, (_, reason) in cases.items():
        result = results[key]
        assert result["ok"], (key, result["error"])
        if not reason:
            assert result["problems"] == [], (key, result["problems"])
        else:
            assert any(reason in problem for problem in result["problems"]), (key, result["problems"])
    assert results["read-descriptor"]["descriptors"] == 2


def test_reader_resolves_zip64_fields_in_both_headers(shell, tmp_path):
    """Sizes and offsets past 32 bits move into the ZIP64 extra field of the
    header that needs them; small archives in those forms prove the parse."""
    outdir = tmp_path / "out"
    outdir.mkdir()
    name, data = PAIR[1]
    local = outdir / "local-zip64.zip"
    with zipfile.ZipFile(local, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(PAIR[0][0], PAIR[0][1])
        with z.open(name, "w", force_zip64=True) as member:
            member.write(data)
    with zipfile.ZipFile(local) as z:
        assert z.testzip() is None
        info = z.getinfo(name)
    raw = local.read_bytes()
    assert struct.unpack_from("<II", raw, info.header_offset + 18) == (0xFFFFFFFF, 0xFFFFFFFF)
    n, = struct.unpack_from("<H", raw, info.header_offset + 26)
    extra_at = info.header_offset + 30 + n
    assert struct.unpack_from("<HH", raw, extra_at) == (1, 16)
    local_short = outdir / "local-zip64-short.zip"
    patched = bytearray(raw)
    struct.pack_into("<H", patched, extra_at + 2, 4)
    local_short.write_bytes(bytes(patched))

    central = outdir / "central-zip64.zip"
    _write_zip(central, PAIR)
    _zip64_central(central, 1)
    with zipfile.ZipFile(central) as z:
        assert z.testzip() is None
        central_info = z.getinfo(name)
    overrun = outdir / "central-zip64-overrun.zip"
    _write_zip(overrun, PAIR)
    _zip64_central(overrun, 1, declared_size=100)
    short = outdir / "central-zip64-short.zip"
    _write_zip(short, PAIR)
    _zip64_central(short, 1, declared_size=8)

    results = _drive(shell, tmp_path, [
        {"key": "local", "mode": "verify", "archive": str(local), "entries": PAIR_ENTRIES},
        {"key": "local-read", "mode": "read", "archive": str(local)},
        {"key": "central", "mode": "verify", "archive": str(central), "entries": PAIR_ENTRIES},
        {"key": "central-read", "mode": "read", "archive": str(central)},
        {"key": "local-short", "mode": "verify", "archive": str(local_short), "entries": PAIR_ENTRIES},
        {"key": "overrun", "mode": "verify", "archive": str(overrun), "entries": PAIR_ENTRIES},
        {"key": "short", "mode": "verify", "archive": str(short), "entries": PAIR_ENTRIES},
    ])
    for key in ("local", "central"):
        assert results[key]["ok"] and results[key]["problems"] == [], (key, results[key])
    local_read = results["local-read"]
    assert local_read["ok"], local_read["error"]
    assert (local_read["lastLocalZip64"], local_read["lastCentralZip64"]) == (True, False)
    assert local_read["lastLocalCompressed"] == info.compress_size
    central_read = results["central-read"]
    assert central_read["ok"], central_read["error"]
    assert (central_read["lastLocalZip64"], central_read["lastCentralZip64"]) == (False, True)
    assert central_read["lastOffset"] == central_info.header_offset
    assert (central_read["lastCompressed"], central_read["lastUncompressed"]) == (central_info.compress_size, len(data))
    assert results["local-short"]["problems"] == [
        f"portable archive structure: local header of {name} ZIP64 field is shorter than the values it must carry"]
    assert results["overrun"]["problems"] == [
        "portable archive structure: central directory record 1 extra field 0x0001 overruns its declared length"]
    assert results["short"]["problems"] == [
        "portable archive structure: central directory record 1 ZIP64 field is shorter than the values it must carry"]


def test_replacement_preserves_existing_output(shell, tmp_path):
    """A refused replacement leaves the verified archive already at the path,
    and never touches a partial file another invocation owns."""
    entries = _make_tree(tmp_path / "tree")
    archive = tmp_path / "out" / "spectrapdf-9.9.9-portable.zip"
    archive.parent.mkdir()
    foreign = [archive.with_name(archive.name + ".partial"),
               archive.with_name(archive.name + ".0123456789abcdef0123456789abcdef.partial")]
    for path in foreign:
        path.write_bytes(b"another invocation's partial archive")
    exe, *rest = entries
    replacement = tmp_path / "tree" / "replacement.exe"
    replacement.write_bytes(b"replacement application bytes")
    changed = [dict(exe, source=str(replacement), sha256=_sha256(replacement.read_bytes()))] + rest

    first = _drive(shell, tmp_path, [{"key": "first", "mode": "write", "archive": str(archive), "entries": entries}])
    assert first["first"]["ok"], first["first"]["error"]
    original = archive.read_bytes()

    wrong = _drive(shell, tmp_path, [{"key": "wrong", "mode": "write", "archive": str(archive),
                                      "entries": [dict(exe, sha256=_sha256(b"other"))] + rest}])
    assert not wrong["wrong"]["ok"]
    assert "refused before it was named" in wrong["wrong"]["error"]
    assert archive.read_bytes() == original
    assert sorted(p.name for p in archive.parent.iterdir()) == sorted([archive.name] + [p.name for p in foreign])

    replaced = _drive(shell, tmp_path, [
        {"key": "replace", "mode": "write", "archive": str(archive), "entries": changed},
        {"key": "verify", "mode": "verify", "archive": str(archive), "entries": changed},
    ])
    assert replaced["replace"]["ok"], replaced["replace"]["error"]
    assert replaced["verify"]["problems"] == []
    assert archive.read_bytes() != original
    with zipfile.ZipFile(archive) as z:
        assert z.read("spectrapdf.exe") == replacement.read_bytes()
    assert all(path.read_bytes() == b"another invocation's partial archive" for path in foreign)
    assert sorted(p.name for p in archive.parent.iterdir()) == sorted([archive.name] + [p.name for p in foreign])


def test_builder_and_smoke_are_wired_to_the_shared_writer() -> None:
    builder = BUILDER.read_text(encoding="utf-8")
    assert '. "$PSScriptRoot\\portable-archive.ps1"' in builder
    assert "Compress-Archive" not in builder
    for call in ("ConvertTo-PortableEntryName $e.relative", "Write-PortableArchive -Path $zipPath",
                 "Test-PortableArchive -Path $Archive -Expected $entries"):
        assert call in builder, call
    library = LIBRARY.read_text(encoding="utf-8")
    assert "portable archive missing" in library
    smoke = SMOKE.read_text(encoding="utf-8")
    for check in ("archive-missing", "archive-backslash-name", "archive-changed-bytes", "archive-extra-entry",
                  "archive-missing-entry", "archive-duplicate-app", "archive-local-name-tamper", "archive-restored",
                  "$hiddenRel", "$unicodeRel", "/INPUTCHARSET UTF8"):
        assert check in smoke, check
