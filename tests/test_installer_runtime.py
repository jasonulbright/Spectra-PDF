"""An upgrade replaces the embedded runtime; it never copies over the old one."""
from __future__ import annotations

import pathlib
import re

HOOKS = (pathlib.Path(__file__).resolve().parent.parent / "src-tauri" / "nsis-hooks.nsh").read_text(encoding="utf-8")


def _macro(name: str) -> str:
    found = re.search(rf"^!macro {name}\b.*?^!macroend", HOOKS, re.M | re.S)
    assert found, name
    return found[0]


def test_the_old_runtime_goes_after_the_app_is_closed_and_before_the_copy():
    body = _macro("NSIS_HOOK_PREINSTALL")
    closed = body.index("SPECTRA_REQUIRE_APP_CLOSED")
    assert body.index("!insertmacro SPECTRA_REMOVE_OLD_RUNTIME") > closed


def test_only_this_applications_embeddable_runtime_is_removed():
    body = _macro("SPECTRA_REMOVE_OLD_RUNTIME")
    guard, removal = body.split("RMDir", 1)
    for proof in (r"$INSTDIR\spectrapdf.exe", r"$INSTDIR\engine\__startup__.py", r"$INSTDIR\python\python*._pth"):
        assert f'${{FileExists}} "{proof}"' in guard, proof
    assert removal.split("\n")[0].strip() == r'/r "$INSTDIR\python"'
    assert HOOKS.count(r'RMDir /r "$INSTDIR\python"') == 1
