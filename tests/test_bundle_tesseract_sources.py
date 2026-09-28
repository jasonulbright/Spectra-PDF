"""Contract and behaviour tests for the Tesseract installer source list."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "bundle-tesseract.ps1"
TEXT = SCRIPT.read_text(encoding="utf-8")

MIRROR = "https://github.com/jasonulbright/Spectra-PDF/releases/download/vendor-cache/tesseract-ocr-w64-setup-$TessVersion.exe"
UPSTREAM_HOST = "digi.bib.uni-mannheim.de"


def test_the_mirror_is_the_only_download_source() -> None:
    # The upstream host is geo-blocked for GitHub-hosted runners, so it is not a
    # source. Its URL survives only as the provenance of the pinned bytes, in a
    # comment; any other occurrence would be a live source again.
    sources = TEXT.index("$InstallerSources = @(")
    body = TEXT[sources : TEXT.index(")", sources)]
    assert MIRROR in body
    assert UPSTREAM_HOST not in body

    mentions = [
        line
        for line in TEXT.splitlines()
        if UPSTREAM_HOST in line
    ]
    assert mentions and all(line.lstrip().startswith("#") for line in mentions)


def test_checksum_gate_follows_the_download_loop() -> None:
    # The pin decides the bytes whichever source answered, so it must come after
    # the last source is tried, never inside the loop.
    assert TEXT.index("foreach ($src in $InstallerSources)") < TEXT.index(
        "$actual -ne $ExpectedSha256"
    )


def test_exhausted_sources_fail_listing_every_source() -> None:
    assert "Download failed from every source" in TEXT
    assert "$InstallerSources | ForEach-Object" in TEXT


def test_environment_override_is_honoured_and_still_hashed() -> None:
    assert "$env:SPECTRAPDF_TESSERACT_INSTALLER" in TEXT
    assert TEXT.index("$env:SPECTRAPDF_TESSERACT_INSTALLER") < TEXT.index(
        "$actual -ne $ExpectedSha256"
    )


@pytest.mark.skipif(shutil.which("powershell") is None, reason="powershell absent")
def test_override_cannot_bypass_the_checksum_pin(tmp_path: Path) -> None:
    fake = tmp_path / "tesseract-ocr-w64-setup-fake.exe"
    fake.write_bytes(b"not the pinned installer")

    env = dict(os.environ, SPECTRAPDF_TESSERACT_INSTALLER=str(fake))
    proc = subprocess.run(
        [
            "powershell",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(SCRIPT),
            "-DownloadOnly",
        ],
        capture_output=True,
        text=True,
        env=env,
        cwd=ROOT,
    )
    assert proc.returncode == 1
    assert "Checksum mismatch" in proc.stdout + proc.stderr
