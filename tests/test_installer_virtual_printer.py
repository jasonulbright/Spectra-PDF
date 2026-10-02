"""The virtual printer in the installer: every install retires the loopback
queue, a real uninstall removes every account's printer, an upgrade keeps
them, and no printer step can fail the run."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
HOOKS = ROOT / "src-tauri" / "nsis-hooks.nsh"


def _hooks() -> str:
    return HOOKS.read_text(encoding="utf-8")


def _block(start: str, end: str = "!macroend") -> str:
    return _hooks().split(start, 1)[1].split(end, 1)[0]


GUARD = "${If} $SpectraReplacing <> 1"


def _real_uninstall_only(body: str) -> str:
    """The body of the block that runs only when no other version replaces
    this one."""
    return body.split(GUARD, 1)[1].split("${EndIf}\n", 1)[0]


RETIRE = '!insertmacro SPECTRA_VIRTUAL_PRINTER "retire-legacy"'
REMOVE = '!insertmacro SPECTRA_VIRTUAL_PRINTER "remove-all"'


def test_every_install_retires_the_loopback_queue_updates_included() -> None:
    post = _block("!macro NSIS_HOOK_POSTINSTALL")
    assert post.count(RETIRE) == 1
    at = post.index(RETIRE)
    # Not inside any mode guard: an update is the path that migrates a machine.
    before = post[:at]
    assert before.count("${If}") + before.count("${IfNot}") == before.count("${EndIf}")
    assert "$UpdateMode" not in before


def test_only_a_real_uninstall_removes_every_printer() -> None:
    pre = _block("!macro NSIS_HOOK_PREUNINSTALL")
    assert pre.count(REMOVE) == 1
    assert REMOVE in _real_uninstall_only(pre)
    assert pre.count(GUARD) == 1
    assert pre.index("!insertmacro SPECTRA_READ_REPLACEMENT") < pre.index(GUARD)
    # $UpdateMode alone is never set on an interactive upgrade.
    assert "${If} $UpdateMode <> 1" not in pre
    first = pre.strip().splitlines()[0].strip()
    assert pre.index(first) < pre.index(REMOVE), "a running app could cancel after the printers went"


def test_a_real_uninstall_drops_the_marker_keys_empty_parents_after_the_printers() -> None:
    guarded = _real_uninstall_only(_block("!macro NSIS_HOOK_PREUNINSTALL"))
    drop = "!insertmacro SPECTRA_DROP_EMPTY_MARKER_PARENTS"
    assert guarded.count(drop) == 1
    assert guarded.index(REMOVE) < guarded.index(drop), "the marker key is still there"
    macro = _block("!macro SPECTRA_DROP_EMPTY_MARKER_PARENTS")
    lines = [line.strip() for line in macro.strip().splitlines()]
    assert lines == [
        "SetRegView 32",
        'DeleteRegKey /ifnosubkeys /ifnovalues HKLM "${SPECTRA_PRODUCT_KEY}"',
        'DeleteRegKey /ifnosubkeys /ifnovalues HKLM "${SPECTRA_PUBLISHER_KEY}"',
        "SetRegView lastused",
    ]


def test_the_installer_marks_a_replacement_before_the_previous_uninstaller_runs() -> None:
    gui = _block("Function SpectraPdfGuiInit", "FunctionEnd")
    assert gui.count("!insertmacro SPECTRA_MARK_REPLACEMENT") == 1
    # Not under a mode guard: GuiInit runs in interactive and passive
    # installs, and the reinstall page of either can run the previous
    # uninstaller (an interactive upgrade or downgrade, a passive install of
    # the same version).
    mark = gui.index("!insertmacro SPECTRA_MARK_REPLACEMENT")
    before = gui[gui.index("_noHelp:") : mark]
    assert "${If}" not in before and "${IfNot}" not in before
    # The uninstaller of every installed release reads this exact name and
    # value format.
    hooks = _hooks()
    assert '!define SPECTRA_INSTALLER_ENV "SPECTRA_PDF_INSTALLER"' in hooks
    assert 't "installer $R4"' in hooks
    assert '${If} $R9 != "installer ${VERSION}"' in hooks


def test_the_printer_step_reports_failures_and_never_aborts() -> None:
    body = _block("!macro SPECTRA_VIRTUAL_PRINTER ACTION")
    assert """ExecWait '"$INSTDIR\\spectrapdf.exe" virtual-printer ${ACTION}' $R9""" in body
    assert "${If} ${Errors}" in body and "${ElseIf} $R9 != 0" in body
    for word in ("Abort", "Quit", "SetErrorLevel"):
        assert word not in body


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


def _run_probe(tmp_path: Path, instdir: Path, action: str) -> str:
    makensis = _makensis()
    out = tmp_path / "result.txt"
    exe = tmp_path / "probe.exe"
    script = tmp_path / "probe.nsi"
    macro = _hooks().split("; ── Virtual printer", 1)[1].split("!macroend", 1)[0] + "!macroend\n"
    script.write_text(
        f"""Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "{exe}"
!include LogicLib.nsh
; ── Virtual printer{macro}
Section
  StrCpy $INSTDIR "{instdir}"
  !insertmacro SPECTRA_VIRTUAL_PRINTER "{action}"
  StrCpy $1 "done $R9"
  FileOpen $0 "{out}" w
  FileWrite $0 $1
  FileClose $0
SectionEnd
""",
        encoding="utf-8-sig",
    )
    build = subprocess.run([str(makensis), "/V2", str(script)], capture_output=True, text=True, check=False)
    assert build.returncode == 0, build.stdout + build.stderr
    assert subprocess.run([str(exe)], check=False).returncode == 0
    return out.read_text(encoding="utf-8")


@pytest.mark.skipif(sys.platform != "win32", reason="NSIS probe runs on Windows")
def test_a_failing_printer_step_lets_the_run_finish(tmp_path: Path) -> None:
    instdir = tmp_path / "app"
    instdir.mkdir()
    # where.exe exits 1 when the names it is given match no file: a stand-in
    # for a printer step that fails, with no side effect of its own.
    system = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "where.exe"
    shutil.copyfile(system, instdir / "spectrapdf.exe")
    assert _run_probe(tmp_path, instdir, "retire-legacy") == "done 1"


@pytest.mark.skipif(sys.platform != "win32", reason="NSIS probe runs on Windows")
def test_a_missing_executable_lets_the_run_finish(tmp_path: Path) -> None:
    instdir = tmp_path / "empty"
    instdir.mkdir()
    assert _run_probe(tmp_path, instdir, "remove-all").startswith("done")


def _replacement_block() -> str:
    hooks = _hooks()
    return hooks[hooks.index("; ── Version replacement") : hooks.index("Function SpectraPdfGuiInit")]


def _build(makensis: Path, script: Path, text: str) -> None:
    script.write_text(text, encoding="utf-8-sig")
    build = subprocess.run([str(makensis), "/V2", str(script)], capture_output=True, text=True, check=False)
    assert build.returncode == 0, build.stdout + build.stderr


INSTALLED = "2026.930.150"


def _installed_uninstaller(makensis: Path, tmp_path: Path, result: Path) -> Path:
    """An installed release's uninstaller: the template's /P and /UPDATE
    switches, the real replacement check, then the verdict written where the
    test reads it."""
    instdir = tmp_path / "installed"
    setup = tmp_path / "installed-setup.exe"
    _build(
        makensis,
        tmp_path / "installed.nsi",
        f"""Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
OutFile "{setup}"
InstallDir "{instdir}"
!include LogicLib.nsh
!include FileFunc.nsh
!define VERSION "{INSTALLED}"
Var PassiveMode
Var UpdateMode
{_replacement_block()}
Function un.onInit
  ${{GetOptions}} $CMDLINE "/P" $PassiveMode
  ${{IfNot}} ${{Errors}}
    StrCpy $PassiveMode 1
  ${{EndIf}}
  ${{GetOptions}} $CMDLINE "/UPDATE" $UpdateMode
  ${{IfNot}} ${{Errors}}
    StrCpy $UpdateMode 1
  ${{EndIf}}
FunctionEnd
Section
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
Section "Uninstall"
  !insertmacro SPECTRA_READ_REPLACEMENT
  FileOpen $0 "{result}" w
  FileWrite $0 "$SpectraReplacing"
  FileClose $0
SectionEnd
""",
    )
    assert subprocess.run([str(setup)], check=False).returncode == 0
    uninstaller = instdir / "uninstall.exe"
    assert uninstaller.is_file()
    return uninstaller


def _order(version: str) -> int:
    """The reinstall page's $R0: 0 same version, 1 upgrade, -1 downgrade."""
    new = tuple(int(field) for field in version.split("."))
    old = tuple(int(field) for field in INSTALLED.split("."))
    return (new > old) - (new < old)


def _installer(makensis: Path, tmp_path: Path, version: str, passive: bool, first: bool, uninstaller: Path) -> Path:
    """A release's installer as far as the hooks and the reinstall page go:
    GuiInit's mark, then the template's leave-page decision (see
    TEMPLATE_FACTS) for the given mode and radio button, and the previous
    uninstaller run the way the template runs it."""
    name = f"setup-{version}-{'passive' if passive else 'interactive'}-{'first' if first else 'second'}"
    setup = tmp_path / f"{name}.exe"
    _build(
        makensis,
        tmp_path / f"{name}.nsi",
        f"""Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "{setup}"
!include LogicLib.nsh
!include nsDialogs.nsh
VIProductVersion "{version}.0"
VIAddVersionKey "ProductName" "Spectra PDF"
VIAddVersionKey "FileVersion" "{version}"
VIAddVersionKey "ProductVersion" "{version}"
Var PassiveMode
{_replacement_block()}
Section
  !insertmacro SPECTRA_MARK_REPLACEMENT
  StrCpy $PassiveMode {1 if passive else 0}
  StrCpy $R0 {_order(version)}
  ${{If}} $PassiveMode = 1
    ; No radio buttons exist: $R2 holds the first choice's label.
    StrCpy $R2 "Add/Reinstall components"
    ${{NSD_GetState}} $R2 $R1
  ${{Else}}
    StrCpy $R1 {1 if first else 0}
  ${{EndIf}}
  ${{If}} $R0 = 0
    ${{If}} $R1 = 1
      Goto done
    ${{EndIf}}
  ${{ElseIf}} $R1 <> 1
    Goto done
  ${{EndIf}}
  StrCpy $R1 '"{uninstaller}"'
  ${{IfThen}} $PassiveMode = 1 ${{|}} StrCpy $R1 "$R1 /P" ${{|}}
  StrCpy $R1 "$R1 _?={uninstaller.parent}"
  ExecWait '$R1' $0
  done:
SectionEnd
""",
    )
    return setup


@pytest.mark.skipif(sys.platform != "win32", reason="NSIS probe runs on Windows")
def test_every_install_keeps_the_printers_and_only_an_explicit_uninstall_removes_them(tmp_path: Path) -> None:
    makensis = _makensis()
    result = tmp_path / "replacing.txt"
    uninstaller = _installed_uninstaller(makensis, tmp_path, result)
    env = {key: value for key, value in os.environ.items() if key.upper() != "SPECTRA_PDF_INSTALLER"}

    def verdict(command: list[str], extra: dict[str, str] | None = None) -> str | None:
        result.unlink(missing_ok=True)
        assert subprocess.run(command, env={**env, **(extra or {})}, check=False).returncode == 0
        return result.read_text(encoding="utf-8") if result.exists() else None

    def install(version: str, passive: bool, first: bool = True) -> str | None:
        return verdict([str(_installer(makensis, tmp_path, version, passive, first, uninstaller))])

    keep, remove, untouched = "1", "0", None
    assert install("2026.1004.151", passive=False) == keep, "an upgrade removed every printer"
    assert install("2026.915.149", passive=False) == keep, "a downgrade removed every printer"
    assert install(INSTALLED, passive=True) == keep, "a passive repair removed every printer"
    assert install(INSTALLED, passive=False, first=True) is untouched, "Add/Reinstall ran the uninstaller"
    assert install(INSTALLED, passive=False, first=False) == remove, "the maintenance page's Uninstall kept the printers"
    assert install("2026.1004.151", passive=True) is untouched, "a passive upgrade ran the uninstaller"
    directory = f"_?={uninstaller.parent}"
    assert verdict([str(uninstaller), directory]) == remove, "an uninstall from Apps kept the printers"
    assert verdict([str(uninstaller), "/P", directory]) == remove, "a scripted passive uninstall kept the printers"
    assert verdict([str(uninstaller), "/UPDATE", directory]) == keep
    assert verdict([str(uninstaller), directory], {"SPECTRA_PDF_INSTALLER": "replace"}) == keep, (
        "a later installer could not ask for a replacement"
    )


TAURI_CLI = ROOT / "node_modules" / "@tauri-apps" / "cli-win32-x64-msvc" / "cli.win32-x64-msvc.node"

# The reinstall-page behaviour the probe above models, as the installer
# template in use states it. A template change here changes when the previous
# uninstaller runs.
TEMPLATE_FACTS = (
    # A passive run calls the leave function and creates no radio buttons.
    "${If} $PassiveMode = 1 Call PageLeaveReinstall ${Else} nsDialogs::Create 1018",
    "Function PageLeaveReinstall ${NSD_GetState} $R2 $R1",
    "${If} $UpdateMode = 1 Goto reinst_done ${EndIf}",
    "${If} $R0 = 0 ; Same version, proceed ${If} $R1 = 1 ; User chose to add/reinstall Goto reinst_done"
    " ${Else} ; User chose to uninstall Goto reinst_uninstall ${EndIf}",
    "${ElseIf} $R0 = 1 ; Upgrading ${If} $R1 = 1 ; User chose to uninstall Goto reinst_uninstall"
    " ${Else} Goto reinst_done ; User chose NOT to uninstall ${EndIf}",
    "${ElseIf} $R0 = -1 ; Downgrading ${If} $R1 = 1 ; User chose to uninstall Goto reinst_uninstall"
    " ${Else} Goto reinst_done ; User chose NOT to uninstall ${EndIf}",
    '${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P',
    'StrCpy $R1 "$R1 _?=$4" ; append uninstall directory',
)


def test_the_reinstall_page_model_matches_the_template_in_use() -> None:
    if not TAURI_CLI.is_file():
        pytest.skip("the Tauri CLI is not installed")
    data = TAURI_CLI.read_bytes()
    at = data.find(b"Function PageReinstall")
    assert at >= 0, "the installer template has no reinstall page"
    template = " ".join(data[max(0, at - 4000) : at + 12000].decode("utf-8", "replace").split())
    for fact in TEMPLATE_FACTS:
        assert " ".join(fact.split()) in template, fact


@pytest.mark.skipif(sys.platform != "win32", reason="NSIS probe runs on Windows")
def test_only_empty_marker_parents_are_dropped(tmp_path: Path) -> None:
    import winreg

    makensis = _makensis()
    macro = _block("!macro SPECTRA_DROP_EMPTY_MARKER_PARENTS").replace("HKLM", "HKCU")
    root = "\\".join(["Software", f"SpectraParentProbe-{uuid.uuid4().hex}"])
    cases = ("empty", "valued", "shared")
    insertions = ""
    for case in cases:
        insertions += f"""
  !define SPECTRA_PRODUCT_KEY "{root}\\{case}\\Jason Ulbright\\Spectra PDF"
  !define SPECTRA_PUBLISHER_KEY "{root}\\{case}\\Jason Ulbright"
  !insertmacro SPECTRA_DROP_EMPTY_MARKER_PARENTS
  !undef SPECTRA_PRODUCT_KEY
  !undef SPECTRA_PUBLISHER_KEY
"""
    exe = tmp_path / "parents.exe"
    _build(
        makensis,
        tmp_path / "parents.nsi",
        f"""Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "{exe}"
!include LogicLib.nsh
!macro SPECTRA_DROP_EMPTY_MARKER_PARENTS{macro}!macroend
Section
  WriteRegStr HKCU "{root}\\empty\\Jason Ulbright\\Spectra PDF" "probe" "1"
  DeleteRegValue HKCU "{root}\\empty\\Jason Ulbright\\Spectra PDF" "probe"
  WriteRegStr HKCU "{root}\\valued\\Jason Ulbright\\Spectra PDF" "InstallDir" "C:\\Apps"
  WriteRegStr HKCU "{root}\\shared\\Jason Ulbright\\Spectra PDF" "probe" "1"
  DeleteRegValue HKCU "{root}\\shared\\Jason Ulbright\\Spectra PDF" "probe"
  WriteRegStr HKCU "{root}\\shared\\Jason Ulbright\\Other Product" "Version" "1"
{insertions}
SectionEnd
""",
    )

    def present(path: str) -> bool:
        try:
            winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CURRENT_USER, path))
            return True
        except FileNotFoundError:
            return False

    try:
        assert subprocess.run([str(exe)], check=False).returncode == 0
        assert present(root + "\\empty") and not present(root + "\\empty\\Jason Ulbright")
        assert present(root + "\\valued\\Jason Ulbright\\Spectra PDF"), "a key with a value was dropped"
        assert not present(root + "\\shared\\Jason Ulbright\\Spectra PDF")
        assert present(root + "\\shared\\Jason Ulbright\\Other Product"), "another product's key was touched"
    finally:
        subprocess.run(["reg", "delete", f"HKCU\\{root}", "/f"], capture_output=True, check=False)
