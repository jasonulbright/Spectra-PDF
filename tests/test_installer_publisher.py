"""Installer publisher metadata and the upgrade path over publisher-less builds."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
HOOKS = ROOT / "src-tauri" / "nsis-hooks.nsh"
PUBLISHER = "Jason Ulbright"
COPYRIGHT = "Copyright (c) 2026 Jason Ulbright"
BS = "\\"


def _conf() -> dict:
    return json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))


def _hooks() -> str:
    return HOOKS.read_text(encoding="utf-8")


def _define(name: str) -> str:
    match = re.search(rf'^!define {name} "([^"]*)"', _hooks(), re.M)
    assert match, name
    return match.group(1)


def test_publisher_copyright_and_description_agree_across_manifests() -> None:
    bundle = _conf()["bundle"]
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    cargo = tomllib.loads((ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8"))[
        "package"
    ]
    licence = (ROOT / "LICENSE").read_text(encoding="utf-8")

    assert bundle["publisher"] == PUBLISHER
    assert bundle["copyright"] == COPYRIGHT
    assert COPYRIGHT in licence
    assert package["author"] == PUBLISHER
    assert cargo["authors"] == [PUBLISHER]
    description = package["description"]
    assert cargo["description"] == description
    assert bundle["shortDescription"] == description
    assert bundle["longDescription"] == description


def test_hook_product_key_matches_the_configured_publisher() -> None:
    conf = _conf()
    expected = BS.join(["Software", conf["bundle"]["publisher"], conf["productName"]])
    assert _define("SPECTRA_PRODUCT_KEY") == expected
    legacy_manufacturer = conf["identifier"].split(".")[1]
    assert _define("SPECTRA_LEGACY_MANU_KEY") == BS.join(["Software", legacy_manufacturer])


def test_adoption_runs_on_every_install_path() -> None:
    hooks = _hooks()
    gui = hooks.split("Function SpectraPdfGuiInit", 1)[1].split("FunctionEnd", 1)[0]
    pre = hooks.split("!macro NSIS_HOOK_PREINSTALL", 1)[1].split("!macroend", 1)[0]
    post = hooks.split("!macro NSIS_HOOK_POSTINSTALL", 1)[1].split("!macroend", 1)[0]
    assert "!insertmacro SPECTRA_ADOPT_LEGACY_INSTALL_DIR" in gui
    assert "${If} ${Silent}" in pre
    assert "!insertmacro SPECTRA_ADOPT_LEGACY_INSTALL_DIR" in pre
    assert "SetOutPath $INSTDIR" in pre
    assert "!insertmacro SPECTRA_DROP_LEGACY_INSTALL_DIR" in post


def _cli_template() -> str:
    binaries = sorted((ROOT / "node_modules" / "@tauri-apps").glob("cli-win32-*/*.node"))
    if not binaries:
        pytest.skip("Tauri CLI native binary is not installed")
    blob = binaries[0].read_bytes()
    at = blob.find(b"!define MANUPRODUCTKEY")
    assert at >= 0
    start = blob.rfind(b"\x00", 0, at) + 1
    return blob[start : blob.find(b"\x00", at)].decode("utf-8", "replace")


def test_cli_template_keys_the_install_dir_on_the_publisher() -> None:
    template = _cli_template()
    uninstall = BS.join(
        ["Software", "Microsoft", "Windows", "CurrentVersion", "Uninstall", "${PRODUCTNAME}"]
    )
    assert '!define MANUFACTURER "{{manufacturer}}"' in template
    assert '!define MANUKEY "Software' + BS + '${MANUFACTURER}"' in template
    assert '!define MANUPRODUCTKEY "${MANUKEY}' + BS + '${PRODUCTNAME}"' in template
    assert f'!define UNINSTKEY "{uninstall}"' in template
    assert 'ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""' in template
    assert "MUI_CUSTOMFUNCTION_GUIINIT" not in template


def _makensis() -> Path:
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    for candidate in (
        local / "tauri" / "NSIS" / "Bin" / "makensis.exe",
        local / "tauri" / "NSIS" / "makensis.exe",
    ):
        if candidate.is_file():
            return candidate
    found = shutil.which("makensis")
    if not found:
        pytest.skip("makensis is not installed")
    return Path(found)


def _macros(hive: str) -> str:
    hooks = _hooks()
    start = hooks.index("!define SPECTRA_PRODUCT_KEY")
    end = hooks.index("; ── /? switch dialog")
    return hooks[start:end].replace('"Software' + BS, '"' + hive + BS)


LEGACY = r"D:\Apps\Spectra"


@pytest.mark.skipif(sys.platform != "win32", reason="NSIS probe runs on Windows")
@pytest.mark.parametrize(
    ("legacy", "current", "instdir", "want_instdir", "want_current"),
    [
        (LEGACY, "", "default", LEGACY, LEGACY),
        (LEGACY, "", r"E:\Chosen", r"E:\Chosen", LEGACY),
        (r"D:\Apps\Old", r"F:\Current", "default", "default", r"F:\Current"),
        ("", "", "default", "default", ""),
    ],
)
def test_upgrade_over_a_publisherless_install_keeps_one_location(
    tmp_path: Path, legacy: str, current: str, instdir: str, want_instdir: str, want_current: str
) -> None:
    makensis = _makensis()
    import winreg

    hive = BS.join(["Software", f"SpectraPdfInstallerProbe-{uuid.uuid4().hex}"])
    legacy_key = BS.join([hive, "spectrapdf", "Spectra PDF"])
    current_key = BS.join([hive, PUBLISHER, "Spectra PDF"])
    out = tmp_path / "result.txt"
    exe = tmp_path / "probe.exe"
    script = tmp_path / "probe.nsi"
    default = r"$PROGRAMFILES64\Spectra PDF"
    start_dir = default if instdir == "default" else instdir
    script.write_text(
        f"""Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "{exe}"
!include LogicLib.nsh
{_macros(hive)}
Section
  SetShellVarContext current
  StrCmp "{legacy}" "" +2
    WriteRegStr SHCTX "{legacy_key}" "" "{legacy}"
  StrCmp "{current}" "" +2
    WriteRegStr SHCTX "{current_key}" "" "{current}"
  StrCpy $INSTDIR "{start_dir}"
  !insertmacro SPECTRA_ADOPT_LEGACY_INSTALL_DIR
  ReadRegStr $1 SHCTX "{current_key}" ""
  !insertmacro SPECTRA_DROP_LEGACY_INSTALL_DIR
  ReadRegStr $2 SHCTX "{legacy_key}" ""
  StrCpy $3 "no"
  ClearErrors
  EnumRegKey $4 SHCTX "{BS.join([hive, 'spectrapdf'])}" 0
  IfErrors +2
    StrCpy $3 "yes"
  FileOpen $0 "{out}" w
  FileWrite $0 "$INSTDIR|$1|$2|$3|{default}"
  FileClose $0
SectionEnd
""",
        encoding="utf-8-sig",
    )
    try:
        build = subprocess.run(
            [str(makensis), "/V2", str(script)], capture_output=True, text=True, check=False
        )
        assert build.returncode == 0, build.stdout + build.stderr
        assert subprocess.run([str(exe)], check=False).returncode == 0
        got_instdir, got_current, got_legacy, legacy_parent, default_dir = (
            out.read_text(encoding="utf-8").split("|")
        )
    finally:
        subprocess.run(["reg", "delete", f"HKCU{BS}{hive}", "/f"], capture_output=True, check=False)

    assert got_instdir == (default_dir if want_instdir == "default" else want_instdir)
    assert got_current == want_current
    assert got_legacy == ""
    assert legacy_parent == "no"
    with pytest.raises(OSError):
        winreg.OpenKey(winreg.HKEY_CURRENT_USER, hive)
