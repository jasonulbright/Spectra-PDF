"""Contract tests for the committed jbig2enc build and its installer."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "scripts" / "bundle-jbig2enc.ps1").read_text(encoding="utf-8")
BUILD = ROOT / "scripts" / "jbig2enc-build"


def _pin(name: str) -> str:
    return re.search(rf'\${name} = "([0-9A-F]{{64}})"', SCRIPT).group(1)


def test_the_committed_build_matches_the_pins() -> None:
    assert hashlib.sha256((BUILD / "jbig2.exe").read_bytes()).hexdigest().upper() == _pin("ExpectedExeSha256")
    assert hashlib.sha256((BUILD / "depmf.json").read_bytes()).hexdigest().upper() == _pin("ExpectedDepmfSha256")


def test_the_committed_build_links_no_giflib_and_no_zlib_1_3_1() -> None:
    projects = json.loads((BUILD / "depmf.json").read_text(encoding="utf-8"))["projects"]
    assert "giflib" not in projects and "zlib-ng" not in projects
    assert projects["zlib"]["version"] == "1.3.2"
    exe = (BUILD / "jbig2.exe").read_bytes()
    for marker in (b"DGifOpen", b"EGifOpen", b"GIF89a", b"zlib-ng"):
        assert marker not in exe


def test_the_installer_fetches_nothing_and_refuses_a_binary_off_its_pin() -> None:
    assert "Invoke-WebRequest" not in SCRIPT and "curl" not in SCRIPT
    check = SCRIPT.index("Checksum mismatch for $($pin[0])")
    copy = SCRIPT.index('Copy-Item (Join-Path $BuildDir "jbig2.exe")')
    assert check < copy
