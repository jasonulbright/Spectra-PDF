"""Contract for `src/engine/PAYLOAD-MANIFEST.tsv`.

The manifest is the exact set of files that may enter the shipped engine
payload: `src-tauri/build.rs` stages these rows and nothing else, verifying
each one's size and SHA-256 before it is written. A source file added, removed
or edited without regenerating the manifest must fail here rather than change
what ships.
"""

from __future__ import annotations

import hashlib
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENGINE = ROOT / "src/engine"
MANIFEST = ENGINE / "PAYLOAD-MANIFEST.tsv"
GENERATOR = ROOT / "scripts/gen-engine-payload-manifest.py"
HEADER = "path\tsize\tsha256"


def manifest_lines() -> list[str]:
    text = MANIFEST.read_text(encoding="utf-8")
    assert text.endswith("\n")
    return text.split("\n")[:-1]


def rows() -> list[tuple[str, int, str]]:
    parsed = []
    for line in manifest_lines()[1:]:
        path, size, digest = line.split("\t")
        parsed.append((path, int(size), digest))
    return parsed


def test_header_is_the_declared_contract():
    assert manifest_lines()[0] == HEADER


def test_rows_are_sorted_relative_forward_slashed_paths():
    paths = [path for path, _size, _digest in rows()]
    assert paths, "the manifest lists no files"
    assert paths == sorted(paths)
    assert len(paths) == len(set(paths))
    for path in paths:
        assert "\\" not in path
        assert ":" not in path
        assert not path.startswith("/")
        assert ".." not in path.split("/")
        assert ".local." not in path.rsplit("/", 1)[-1]
        assert path != MANIFEST.name


def test_every_row_matches_the_file_on_disk():
    for path, size, digest in rows():
        data = (ENGINE / path).read_bytes()
        assert len(data) == size, path
        assert hashlib.sha256(data).hexdigest() == digest, path


def test_row_set_is_the_tracked_engine_inventory():
    tracked = subprocess.run(
        ["git", "ls-files", "-z", "--", "src/engine"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    expected = {
        entry[len("src/engine/"):]
        for entry in tracked.split("\0")
        if entry
    }
    expected = {
        rel
        for rel in expected
        if ".local." not in rel.rsplit("/", 1)[-1] and rel != MANIFEST.name
    }
    assert {path for path, _size, _digest in rows()} == expected


def test_generator_check_mode_is_clean():
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--check"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_generator_check_mode_refuses_a_stale_manifest(tmp_path):
    original = MANIFEST.read_bytes()
    lines = original.decode("utf-8").split("\n")
    path, size, digest = lines[1].split("\t")
    lines[1] = f"{path}\t{size}\t{'0' * 64}"
    try:
        MANIFEST.write_bytes("\n".join(lines).encode("utf-8"))
        result = subprocess.run(
            [sys.executable, str(GENERATOR), "--check"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
    finally:
        MANIFEST.write_bytes(original)
    assert result.returncode != 0
    assert "stale" in result.stdout
