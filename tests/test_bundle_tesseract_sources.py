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

VENDOR_SOURCES = [
    "https://github.com/UB-Mannheim/tesseract/releases/download/v$TessVersion/tesseract-ocr-w64-setup-$TessVersion.exe",
    "https://digi.bib.uni-mannheim.de/tesseract/tesseract-ocr-w64-setup-$TessVersion.exe",
]


def test_sources_are_the_vendor_urls_in_order() -> None:
    # digi.bib.uni-mannheim.de does not answer GitHub-hosted runners, so the
    # vendor's GitHub release must stay first or every workflow run fails.
    start = TEXT.index("$InstallerSources = @(")
    body = TEXT[start : TEXT.index("\n)", start)]
    urls = [line.strip().rstrip(",").strip('"') for line in body.splitlines()[1:] if line.strip()]
    assert urls == VENDOR_SOURCES


def test_no_project_hosted_copy_is_a_source() -> None:
    assert "jasonulbright/Spectra-PDF/releases" not in TEXT
    assert "vendor-cache" not in TEXT


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


def test_a_failed_installer_extraction_stops_the_vendoring() -> None:
    # 7-Zip reports a truncated or unreadable member only through its exit code;
    # a DLL it wrote partially would otherwise ship beside a tesseract.exe that
    # still answers --version.
    call = '& $SevenZip x $Installer "-o$Extracted" -y | Out-Null'
    assert TEXT.count(call) == 1
    after = TEXT[TEXT.index(call) + len(call):].lstrip().splitlines()[0]
    assert after.startswith("if ($LASTEXITCODE -ne 0)"), after
    assert "exit 1" in after or "throw" in after, after
