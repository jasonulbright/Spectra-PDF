"""The POSIX provisioning scripts carry the same pins as their PowerShell
counterparts, and every one of them parses."""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
HEX64 = re.compile(r"\b[0-9a-fA-F]{64}\b")


def _pins(name: str) -> set[str]:
    return {m.lower() for m in HEX64.findall((SCRIPTS / name).read_text(encoding="utf-8"))}


@pytest.mark.parametrize("stem", ["sync-edit-fonts", "sync-signature-fonts"])
def test_the_font_scripts_pin_the_same_bytes(stem):
    assert _pins(f"{stem}.ps1") == _pins(f"{stem}.sh")


def _assigned(name: str, pattern: str) -> str:
    match = re.search(pattern, (SCRIPTS / name).read_text(encoding="utf-8"), re.MULTILINE)
    assert match, (name, pattern)
    return match.group(1)


def test_the_dictionary_scripts_pin_one_commit():
    assert _assigned("bundle-dictionaries.ps1", r'^\$Commit = "([0-9a-f]{40})"') == _assigned(
        "bundle-dictionaries.sh", r'^COMMIT="([0-9a-f]{40})"'
    )


def test_the_voikko_scripts_pin_one_dictionary_package():
    assert _assigned("bundle-voikko.ps1", r'^\$DictSha = "([0-9a-f]{64})"') == _assigned(
        "bundle-voikko.sh", r'^DICT_SHA256="([0-9a-f]{64})"'
    )


def test_the_libreoffice_scripts_pin_one_release():
    assert _assigned("bundle-libreoffice.ps1", r'\[string\]\$ArchiveVersion = "([0-9.]+)"') == _assigned(
        "bundle-libreoffice.sh", r'^ARCHIVE_VERSION="([0-9.]+)"'
    )


def test_the_linux_lock_resolves_the_windows_versions():
    def pins(name):
        out = {}
        for line in (SCRIPTS / name).read_text(encoding="utf-8").splitlines():
            m = re.match(r"^([A-Za-z0-9._-]+)==(\S+)", line)
            if m:
                out[re.sub(r"[-_.]+", "-", m.group(1)).lower()] = m.group(2)
        return out

    windows = pins("python-requirements.txt")
    linux = pins("python-requirements-linux.txt")
    shared = windows.keys() & linux.keys()
    assert shared, "the two locks share no package"
    assert {k: windows[k] for k in shared} == {k: linux[k] for k in shared}


@pytest.mark.skipif(shutil.which("sh") is None, reason="no POSIX shell to parse with")
@pytest.mark.parametrize(
    "script",
    sorted(p.name for p in SCRIPTS.glob("*.sh") if ".local." not in p.name),
)
def test_every_posix_script_parses(script):
    run = subprocess.run(
        ["sh", "-n", str(SCRIPTS / script)], capture_output=True, text=True, timeout=60
    )
    assert run.returncode == 0, run.stderr
