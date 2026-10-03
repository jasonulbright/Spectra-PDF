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


def test_the_installer_runs_and_offers_no_ghostscript() -> None:
    hooks = (ROOT / "src-tauri" / "nsis-hooks.nsh").read_text()
    assert "ghostscript.com" not in hooks
    assert "ExecShell" not in hooks
    assert "SpectraGhostscriptInstalled" not in hooks
    assert "SPECTRA_GS_SCAN" not in hooks
    # The installer runs no program but its own executable's File Explorer
    # registration and virtual-printer step: never Ghostscript, not even to
    # read its version.
    executed = re.findall(r"\bExecWait '([^']*)'", hooks)
    assert hooks.count("ExecWait") == len(executed) == 3
    for command in executed:
        assert command.startswith(
            ('"$INSTDIR\\spectrapdf.exe" shell-menu ', '"$INSTDIR\\spectrapdf.exe" virtual-printer ')
        ), command
    assert "nsExec" not in hooks and "gswin" not in "".join(executed)


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
