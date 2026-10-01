"""Release guards for the Adobe color-profile end-user agreement."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EULA_REL = "../vendor/icc/Adobe-Color-Profile-License.txt"


def test_nsis_presents_the_adobe_eula_to_interactive_users() -> None:
    config = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text())
    assert config["bundle"]["licenseFile"] == EULA_REL

    eula = (ROOT / "vendor" / "icc" / "Adobe-Color-Profile-License.txt").read_text()
    assert "END-USER LICENSE FOR THE BUNDLED COLOR PROFILES" in eula
    assert "BY USING ALL OR ANY PORTION OF THE SOFTWARE YOU ACCEPT" in " ".join(
        eula.split()
    )


def test_unattended_install_requires_explicit_acceptance() -> None:
    hooks = (ROOT / "src-tauri" / "nsis-hooks.nsh").read_text()
    preinstall = hooks.split("!macro NSIS_HOOK_PREINSTALL", 1)[1].split(
        "!macroend", 1
    )[0]

    assert "${If} ${Silent}" in preinstall
    assert "${ElseIf} $PassiveMode == 1" in preinstall
    assert '${GetOptions} $1 "/acceptEULA" $2' in preinstall
    assert "${If} ${Errors}" in preinstall
    assert "SetErrorLevel 2" in preinstall
    assert "Quit" in preinstall


def test_enterprise_documentation_does_not_advertise_unaccepted_install() -> None:
    readme = (ROOT / "README.md").read_text()
    assert 'setup.exe" /S /acceptEULA' in readme
    assert 'setup.exe" /S\n' not in readme


def test_only_the_visible_installer_offers_ghostscript_download() -> None:
    hooks = (ROOT / "src-tauri" / "nsis-hooks.nsh").read_text()
    postinstall = hooks.split("!macro NSIS_HOOK_POSTINSTALL", 1)[1].split(
        "!macroend", 1
    )[0]
    prompt = postinstall.index("Open the official Ghostscript download page now?")

    assert postinstall.index("${IfNot} ${Silent}") < prompt
    assert postinstall.index("${AndIf} $PassiveMode != 1") < prompt
    assert 'ExecShell "open" "https://ghostscript.com/releases/gsdnld.html"' in postinstall


def test_ghostscript_offer_is_skipped_when_an_install_is_found() -> None:
    hooks = (ROOT / "src-tauri" / "nsis-hooks.nsh").read_text()
    postinstall = hooks.split("!macro NSIS_HOOK_POSTINSTALL", 1)[1].split(
        "!macroend", 1
    )[0]
    prompt = postinstall.index("Open the official Ghostscript download page now?")
    check = postinstall.index("Call SpectraGhostscriptInstalled")
    assert postinstall.index("${IfNot} ${Silent}") < check < prompt
    assert postinstall.index("${If} $R9 != 1", check) < prompt

    detect = hooks.split("Function SpectraGhostscriptInstalled", 1)[1].split(
        "FunctionEnd", 1
    )[0]
    for root in ("HKLM64", "HKLM32", "HKCU64", "HKCU32"):
        for key in (r"SOFTWARE\GPL Ghostscript", r"SOFTWARE\Artifex\GPL Ghostscript"):
            assert f'SPECTRA_GS_SCAN_KEY {root} "{key}"' in detect
    assert 'SPECTRA_GS_SCAN_PATH "gswin64c.exe"' in detect
    # The installer runs no program but its own executable's File Explorer
    # registration: never Ghostscript, not even to read its version.
    executed = re.findall(r"\bExecWait '([^']*)'", hooks)
    assert hooks.count("ExecWait") == len(executed) == 2
    for command in executed:
        assert command.startswith('"$INSTDIR\\spectrapdf.exe" shell-menu '), command
    assert "nsExec" not in hooks and "gswin" not in "".join(executed)


def test_installer_ghostscript_floor_matches_discovery() -> None:
    hooks = (ROOT / "src-tauri" / "nsis-hooks.nsh").read_text()
    gs = (ROOT / "src-tauri" / "src" / "gs.rs").read_text()
    assert "pub const MINIMUM_VERSION: (u32, u32) = (10, 0);" in gs
    assert hooks.count("${If} $R3 >= 10") == 2


def test_shipped_notice_keeps_ghostscript_separate() -> None:
    notice = (ROOT / "THIRD-PARTY-LICENSES.md").read_text()
    assert "does not\ndownload or run the Ghostscript installer" in notice
    assert "never\ndownload, launch, install or accept terms for Ghostscript" in notice


def test_end_user_requirements_name_the_guarded_feature_families() -> None:
    readme = (ROOT / "README.md").read_text()
    requirements = readme.split("## Requirements", 1)[1].split(
        "## Quick Start", 1
    )[0]

    for feature in (
        "scan cleanup and OCR rendering",
        "scan-based automatic form detection",
        "visual Compare",
        "printing",
        "PostScript/EPS input and distilling",
        "PDF/A",
        "PDF/X and CMYK conversion",
        "Output Preview",
        "Ink Manager",
        "transparency flattening",
        "page-image export",
        "content-aware crop's fallback",
    ):
        assert feature in requirements
    assert "; ink manager, printer marks" not in readme
