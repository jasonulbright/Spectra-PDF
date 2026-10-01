"""The File Explorer commands: installer registration, policy survival, and
the build wiring that puts the handler into both containers."""

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
BS = "\\"
POLICIES = ("DisableAutoUpdate", "DisableFieldScripts", "DisableExplorerMenu")


def _hooks() -> str:
    return HOOKS.read_text(encoding="utf-8")


def _block(start: str, end: str = "!macroend") -> str:
    return _hooks().split(start, 1)[1].split(end, 1)[0]


def _postinstall() -> str:
    return _block("!macro NSIS_HOOK_POSTINSTALL")


def _preuninstall() -> str:
    return _block("!macro NSIS_HOOK_PREUNINSTALL")


def _update_guarded(body: str) -> str:
    """The body of the `$UpdateMode <> 1` block."""
    return body.split("${If} $UpdateMode <> 1", 1)[1].split("${EndIf}\n", 1)[0]


def test_install_registers_for_every_user_then_the_installing_user() -> None:
    post = _postinstall()
    machine = post.index("""ExecWait '"$INSTDIR\\spectrapdf.exe" shell-menu install-machine' $R9""")
    user = post.index('nsis_tauri_utils::RunAsUser "$INSTDIR\\spectrapdf.exe" "shell-menu register-user"')
    assert machine < user
    # The installing user is registered by interactive and passive installs;
    # a silent deployment's account is not the user's.
    assert post.rindex("${IfNot} ${Silent}", 0, user) > machine
    # The install record is written first: the registration reads it to know
    # this copy is the installed one.
    assert post.index("!insertmacro SPECTRA_WRITE_INSTALL_RECORD") < machine
    for code in ("${ElseIf} $R9 == 3", "${ElseIf} $R9 != 0"):
        assert code in post
    assert "Abort" not in post.split("install-machine", 1)[1].split("register-user", 1)[0]


def test_the_per_file_merge_verb_is_gone() -> None:
    hooks = _hooks()
    assert not re.search(r"WriteRegStr [^\n]*SpectraPDF\.Merge", hooks)
    assert 'DeleteRegKey HKCR "SystemFileAssociations\\.pdf\\shell\\SpectraPDF.Merge"' in _postinstall()
    assert 'DeleteRegKey HKCR "SystemFileAssociations\\.pdf\\shell\\SpectraPDF.Merge"' in _preuninstall()


def test_only_a_real_uninstall_removes_the_commands_and_the_policy_key() -> None:
    pre = _preuninstall()
    guarded = _update_guarded(pre)
    assert """ExecWait '"$INSTDIR\\spectrapdf.exe" shell-menu uninstall-machine' $R9""" in guarded
    assert pre.count("shell-menu uninstall-machine") == 1
    assert pre.count('DeleteRegKey HKLM "${SPECTRA_POLICY_KEY}"') == 2
    assert guarded.count('DeleteRegKey HKLM "${SPECTRA_POLICY_KEY}"') == 2
    assert guarded.index("SetRegView 64") < guarded.index("SetRegView 32")
    assert '!insertmacro SPECTRA_RETIRE_SHELL_DLL "x64"' in guarded
    assert '!insertmacro SPECTRA_RETIRE_SHELL_DLL "arm64"' in guarded
    assert 'DeleteRegKey HKLM "SOFTWARE\\Spectra PDF"' not in pre


def test_a_loaded_handler_is_moved_aside_before_the_payload_is_copied() -> None:
    pre = _block("!macro NSIS_HOOK_PREINSTALL")
    refusal = pre.index("SetErrorLevel 2")
    for arch in ("x64", "arm64"):
        assert pre.index(f'!insertmacro SPECTRA_RETIRE_SHELL_DLL "{arch}"') > refusal


def test_nothing_is_changed_before_a_running_app_can_cancel_the_run() -> None:
    pre = _block("!macro NSIS_HOOK_PREINSTALL")
    check = pre.index('!insertmacro SPECTRA_REQUIRE_APP_CLOSED "install" "spectrapdf.exe"')
    assert check < pre.index('!insertmacro SPECTRA_RETIRE_SHELL_DLL "x64"')
    uninstall = _preuninstall()
    first = uninstall.strip().splitlines()[0].strip()
    assert first == '!insertmacro SPECTRA_REQUIRE_APP_CLOSED "uninstall" "spectrapdf.exe"'
    assert uninstall.index(first) < uninstall.index("shell-menu uninstall-machine")
    assert uninstall.index(first) < uninstall.index("DeleteRegKey")
    closed = _block("!macro SPECTRA_REQUIRE_APP_CLOSED ID EXE")
    assert closed.index("Abort $R1") > closed.index("IDCANCEL spectra_cancel_${ID}")


def _plugin_dir() -> Path:
    found = sorted(
        Path(os.environ.get("LOCALAPPDATA", "")).glob("tauri/NSIS/Plugins/x86-unicode/additional/nsis_tauri_utils.dll")
    )
    if not found:
        pytest.skip("the Tauri NSIS plugin is not installed")
    return found[0].parent


@pytest.mark.skipif(sys.platform != "win32", reason="NSIS probe runs on Windows")
def test_a_running_app_is_closed_before_the_hooks_change_anything(tmp_path: Path) -> None:
    plugins = _plugin_dir()
    name = f"p-shellprobe-{uuid.uuid4().hex[:12]}.exe"
    dummy = tmp_path / name
    shutil.copyfile(Path(os.environ["SystemRoot"]) / "System32" / "PING.EXE", dummy)
    running = subprocess.Popen([str(dummy), "-n", "120", "127.0.0.1"], stdout=subprocess.DEVNULL)
    prelude = f"""!addplugindir "{plugins}"
Var PassiveMode
LangString appRunning 1033 "{{{{product_name}}}} is running"
LangString appRunningOkKill 1033 "close {{{{product_name}}}}?"
LangString failedToKillApp 1033 "could not close {{{{product_name}}}}"
{_shared_block()}"""
    body = f"""
  !insertmacro SPECTRA_REQUIRE_APP_CLOSED "probe" "{name}"
  StrCpy $1 "closed"
"""
    try:
        assert _run_probe(tmp_path, body, prelude) == "closed"
        running.wait(timeout=10)
    finally:
        if running.poll() is None:
            running.kill()
    assert running.returncode is not None


def test_policy_values_are_read_before_and_restored_after_an_upgrade() -> None:
    gui = _block("Function SpectraPdfGuiInit", "FunctionEnd")
    post = _postinstall()
    for name in POLICIES:
        assert re.search(rf'SPECTRA_CAPTURE_POLICY "{name}" \$SpectraPolicy\w+', gui), name
        assert re.search(rf'SPECTRA_RESTORE_POLICY "{name}" \$SpectraPolicy\w+', post), name
    assert gui.index("SetRegView 64") < gui.index("SPECTRA_CAPTURE_POLICY") < gui.index("SetRegView default")
    restore = post.index("SPECTRA_RESTORE_POLICY")
    assert post.rindex("SetRegView 64", 0, restore) < restore < post.index("SetRegView default")
    silent = post.index('WriteRegDWORD HKLM "${SPECTRA_POLICY_KEY}" "DisableAutoUpdate" 1')
    assert post.rindex("SetRegView 64", 0, silent) < silent < post.index("SetRegView default")


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


def _shared_block() -> str:
    hooks = _hooks()
    return hooks[hooks.index("; ── Machine policy") : hooks.index("Function SpectraPdfGuiInit")]


def _run_probe(tmp_path: Path, body: str, prelude: str = "") -> str:
    makensis = _makensis()
    out = tmp_path / "result.txt"
    exe = tmp_path / "probe.exe"
    script = tmp_path / "probe.nsi"
    script.write_text(
        f"""Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "{exe}"
!include LogicLib.nsh
{prelude}
Section
{body}
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
def test_captured_policy_values_come_back_and_present_ones_are_kept(tmp_path: Path) -> None:
    hive = BS.join(["Software", f"SpectraPdfPolicyProbe-{uuid.uuid4().hex}"])
    shared = _shared_block().replace('HKLM "${SPECTRA_POLICY_KEY}"', f'HKCU "{hive}"')
    assert f'HKCU "{hive}"' in shared
    body = f"""
  WriteRegDWORD HKCU "{hive}" "DisableExplorerMenu" 1
  WriteRegDWORD HKCU "{hive}" "DisableFieldScripts" 0
  !insertmacro SPECTRA_CAPTURE_POLICY "DisableExplorerMenu" $SpectraPolicyExplorerMenu
  !insertmacro SPECTRA_CAPTURE_POLICY "DisableFieldScripts" $SpectraPolicyFieldScripts
  !insertmacro SPECTRA_CAPTURE_POLICY "DisableAutoUpdate" $SpectraPolicyAutoUpdate
  DeleteRegKey HKCU "{hive}"
  WriteRegDWORD HKCU "{hive}" "DisableFieldScripts" 1
  !insertmacro SPECTRA_RESTORE_POLICY "DisableExplorerMenu" $SpectraPolicyExplorerMenu
  !insertmacro SPECTRA_RESTORE_POLICY "DisableFieldScripts" $SpectraPolicyFieldScripts
  !insertmacro SPECTRA_RESTORE_POLICY "DisableAutoUpdate" $SpectraPolicyAutoUpdate
  ReadRegDWORD $2 HKCU "{hive}" "DisableExplorerMenu"
  ReadRegDWORD $3 HKCU "{hive}" "DisableFieldScripts"
  StrCpy $4 "absent"
  ClearErrors
  ReadRegDWORD $5 HKCU "{hive}" "DisableAutoUpdate"
  IfErrors +2
    StrCpy $4 "present"
  StrCpy $1 "$2|$3|$4"
"""
    try:
        got = _run_probe(tmp_path, body, shared)
    finally:
        subprocess.run(["reg", "delete", f"HKCU{BS}{hive}", "/f"], capture_output=True, check=False)
    # Restored when gone; an administrator's newer value is kept; a value that
    # was never set is not invented.
    assert got == "1|1|absent"


@pytest.mark.skipif(sys.platform != "win32", reason="NSIS probe runs on Windows")
def test_an_unloaded_handler_is_deleted_and_nothing_is_left_beside_it(tmp_path: Path) -> None:
    install = tmp_path / "install"
    dll = install / "shell" / "x64" / "spectrapdf_shell.dll"
    dll.parent.mkdir(parents=True)
    dll.write_bytes(b"MZ")
    body = f"""
  StrCpy $INSTDIR "{install}"
  !insertmacro SPECTRA_RETIRE_SHELL_DLL "x64"
  !insertmacro SPECTRA_RETIRE_SHELL_DLL "arm64"
  StrCpy $1 "done"
"""
    assert _run_probe(tmp_path, body, _shared_block()) == "done"
    assert list(dll.parent.iterdir()) == []


def _conf(name: str = "tauri.conf.json") -> dict:
    return json.loads((ROOT / "src-tauri" / name).read_text(encoding="utf-8"))


def test_both_containers_carry_the_handler_built_inside_the_bundle_step() -> None:
    conf = _conf()
    assert conf["bundle"]["resources"]["../resources/shell"] == "shell"
    assert conf["build"]["beforeBundleCommand"] == "npm run build:shell-menu"
    scripts = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert "scripts/build-shell-menu.ps1" in scripts["build:shell-menu"]
    assert "scripts/build-shell-menu.ps1 -Prepare" in scripts["prepackage"]
    linux = _conf("tauri.linux.conf.json")
    assert linux["build"]["beforeBundleCommand"] is None
    assert linux["bundle"]["resources"]["../resources/shell"] is None
    portable = (ROOT / "scripts" / "build-portable-zip.ps1").read_text(encoding="utf-8")
    assert re.search(r'^\s*"shell"\s*=\s*""\s*$', portable, re.M), "shell is first-party in the notice map"
    for name in (
        "shell/x64/spectrapdf_shell.dll",
        "shell/arm64/spectrapdf_shell.dll",
        "shell/SpectraPDF.ExplorerCommands_x64.msix",
        "shell/SpectraPDF.ExplorerCommands_arm64.msix",
    ):
        assert f"'{name}'" in portable, name


def test_the_handler_crate_is_a_workspace_member_with_no_new_dependency() -> None:
    root = tomllib.loads((ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8"))
    assert root["workspace"]["members"] == [".", "shell-menu"]
    assert root["workspace"]["default-members"] == [".", "shell-menu"]
    crate = tomllib.loads((ROOT / "src-tauri" / "shell-menu" / "Cargo.toml").read_text(encoding="utf-8"))
    assert crate["package"]["publish"] is False
    assert crate["lib"]["name"] == "spectrapdf_shell"
    assert "cdylib" in crate["lib"]["crate-type"]
    lock = (ROOT / "src-tauri" / "Cargo.lock").read_text(encoding="utf-8")
    names = set(re.findall(r'^name = "([^"]+)"', lock, re.M))
    deps = set(crate.get("dependencies", {})) | set(crate.get("build-dependencies", {}))
    for table in crate.get("target", {}).values():
        deps |= set(table.get("dependencies", {}))
    assert deps <= names, deps - names


def test_the_committed_publisher_is_one_subject_line() -> None:
    text = (ROOT / "scripts" / "shell-menu-publisher.txt").read_text(encoding="utf-8")
    lines = text.splitlines()
    assert len(lines) == 1 and lines[0].startswith("CN=") and lines[0] == lines[0].strip()
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
    cn = re.search(r"SPECTRAPDF_SIGN_SUBJECT_CN: (.+)", workflow).group(1).strip()
    assert lines[0].startswith(f"CN={cn},")


def test_the_release_jobs_compile_both_handlers_before_the_signing_window() -> None:
    for workflow in ("release.yml", "release-redo.yml"):
        text = (ROOT / ".github" / "workflows" / workflow).read_text(encoding="utf-8")
        stage = text.index("- name: Stage the File Explorer command handler")
        assert stage < text.index("- name: Azure login (federated, no secret)"), workflow
        assert "scripts/build-shell-menu.ps1 -CompileOnly" in text[stage:], workflow
        # The Windows job's toolchain: the Linux build job precedes it.
        rust = text.index("uses: dtolnay/rust-toolchain@stable", text.index("\n  release:\n"))
        assert "targets: aarch64-pc-windows-msvc" in text[rust : rust + 300], workflow
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "mkdir -p resources/shell" in ci


def test_the_handler_build_is_mirrored_locally() -> None:
    parity = (ROOT / "scripts" / "ci-parity-gates.sh").read_text(encoding="utf-8")
    assert "gate shell-menu powershell -ExecutionPolicy Bypass -File scripts/build-shell-menu.ps1 -Check" in parity


def test_the_handler_build_checks_the_signing_subject_against_the_publisher() -> None:
    script = (ROOT / "scripts" / "build-shell-menu.ps1").read_text(encoding="utf-8")
    assert "shell-menu-publisher.txt" in script
    assert "CreateFromSignedFile" in script
    assert "$subject -cne $Publisher" in script
    # Signed at the build paths, which the signed-set rule accepts, before the
    # copy under resources/, which it refuses.
    assert script.index("Set-ArtifactSignature $dll") < script.index("Copy-Item -LiteralPath $dlls[$arch]")
    assert script.index("Set-ArtifactSignature $msix") < script.index("Copy-Item -LiteralPath $packages[$arch]")
