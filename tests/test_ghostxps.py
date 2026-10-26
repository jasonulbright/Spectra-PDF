"""Pinned packaging and routing for the Windows XPS print interpreter."""

import hashlib
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def _manifest_pins():
    script = (ROOT / "scripts" / "bundle-ghostxps.ps1").read_text(encoding="utf-8")
    block = script.split("$ExpectedFiles = [ordered]@{", 1)[1].split("}", 1)[0]
    in_script = {
        name: digest.lower()
        for name, digest in re.findall(r'"([^"\n]+)"\s*=\s*"([0-9A-F]{64})"', block)
    }
    rows = [
        line.rstrip("\r\n").split("\t")
        for line in (ROOT / "scripts" / "ghostxps.tsv").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert rows[0] == ["file", "member", "sha256"]
    return in_script, {name: digest for name, _member, digest in rows[1:]}


def test_ghostxps_files_are_hash_pinned_in_the_script_and_manifest():
    in_script, in_table = _manifest_pins()
    assert in_script == in_table
    assert set(in_script) == {"gxpswin64.exe", "gxpsdll64.dll", "LICENSE-GhostXPS.txt"}


def test_vendored_ghostxps_tree_contains_only_pinned_upstream_bytes():
    pins, _table = _manifest_pins()
    tree = ROOT / "resources" / "ghostxps"
    if not (tree / "gxpswin64.exe").is_file():
        import pytest

        pytest.skip("no vendored resources/ghostxps in this checkout")
    assert sorted(path.name for path in tree.iterdir()) == sorted(pins)
    for name, digest in pins.items():
        assert hashlib.sha256((tree / name).read_bytes()).hexdigest() == digest, name


def test_only_windows_resource_mapping_ships_ghostxps():
    windows = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    linux = json.loads((ROOT / "src-tauri" / "tauri.linux.conf.json").read_text(encoding="utf-8"))
    assert windows["bundle"]["resources"]["../resources/ghostxps"] == "ghostxps"
    assert linux["bundle"]["resources"]["../resources/ghostxps"] is None


def test_windows_print_path_routes_zip_spool_data_to_the_pinned_interpreter():
    printer = (ROOT / "src-tauri" / "src" / "print_to_pdf.rs").read_text(encoding="utf-8")
    gxps = (ROOT / "src-tauri" / "src" / "gxps.rs").read_text(encoding="utf-8")
    assert 'signature == *b"PK\\x03\\x04"' in printer
    assert "convert_xps_staged(staged, stem, before_rename)" in printer
    assert "crate::gxps::convert_bundled(staged, part)" in printer
    assert ".env_clear()" in gxps
    assert "output_within(command, GXPS_TIMEOUT)" in gxps
    assert "validate_pdf(output)" in gxps
