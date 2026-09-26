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


def _overlay_rows() -> list[dict[str, str]]:
    import re

    body = TEXT[TEXT.index("$Overlay = @(") : TEXT.index("$PkgCache")]
    return [
        dict(re.findall(r'(\w+) = "([^"]*)"', line))
        for line in body.splitlines()
        if line.strip().startswith("@{")
    ]


def test_every_overlay_row_pins_the_package_and_the_extracted_dll() -> None:
    import re

    rows = _overlay_rows()
    assert {r["Dll"] for r in rows} >= {"libarchive-13.dll", "libexpat-1.dll", "libpng16-16.dll", "zlib1.dll"}
    for r in rows:
        assert re.fullmatch(r"mingw-w64-x86_64-[\w.+-]+-any\.pkg\.tar\.zst", r["Pkg"])
        assert re.fullmatch(r"[0-9a-f]{64}", r["PkgSha"]) and re.fullmatch(r"[0-9a-f]{64}", r["DllSha"])
    assert len({r["Dll"] for r in rows}) == len(rows)


def test_the_overlay_is_applied_after_the_jbig_swap_and_before_the_closure_prune() -> None:
    swap = TEXT.index('Copy-Item $LibTiffSrc -Destination (Join-Path $DestDir "libtiff-6.dll")')
    apply = TEXT.index("foreach ($o in $Overlay)")
    prune = TEXT.index("$dropped = @(Get-UnreachedDlls -Root $DestDir)")
    assert swap < apply < prune
    assert "tesseract.exe does not start with the overlaid libraries" in TEXT


def test_every_overlaid_dll_names_its_exact_source_archive() -> None:
    manifest = (ROOT / "scripts" / "tesseract-licenses.tsv").read_text(encoding="utf-8")
    srcpkg = {c[0]: c[5] for c in (l.split("\t") for l in manifest.splitlines()) if len(c) >= 6}
    for r in _overlay_rows():
        stem = r["Pkg"].removesuffix("-any.pkg.tar.zst").replace("mingw-w64-x86_64-", "mingw-w64-", 1)
        assert srcpkg[r["Dll"]] == f"https://mirror.msys2.org/mingw/sources/{stem}.src.tar.zst"


def test_the_package_extractor_refuses_an_archive_off_its_pin(tmp_path: Path) -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location("msys2_package", ROOT / "scripts" / "msys2_package.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    archive = tmp_path / "x.pkg.tar.zst"
    archive.write_bytes(b"not an archive")
    with pytest.raises(ValueError):
        mod.extract(archive, "0" * 64, "mingw64/bin/x.dll", tmp_path / "x.dll")
    assert not (tmp_path / "x.dll").exists()
