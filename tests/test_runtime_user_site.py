"""The shipped runtime, launched the way the product launches the engine,
must not load anything from the user's site-packages."""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "resources/python/python.exe"

pytestmark = pytest.mark.skipif(not RUNTIME.is_file(), reason="embedded runtime not provisioned")

PROBE = (
    "import importlib.util, sys\n"
    "print(importlib.util.find_spec('spectra_user_site_probe') is not None)\n"
    "print(sys.flags.utf8_mode)\n"
)


def _plant(appdata: pathlib.Path) -> pathlib.Path:
    site = appdata / "Python" / "Python315" / "site-packages"
    site.mkdir(parents=True)
    (site / "spectra_user_site_probe.py").write_text("")
    marker = appdata / "usercustomize-ran"
    (site / "usercustomize.py").write_text(f"open({str(marker)!r}, 'w').close()\n")
    return marker


def _run(
    args: list[str], appdata: pathlib.Path, script: pathlib.Path, extra: dict[str, str],
    interpreter: str = str(RUNTIME),
) -> list[str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
    env.update(APPDATA=str(appdata), PYTHONUTF8="1", **extra)
    return subprocess.run(
        [interpreter, *args, str(script)], env=env, capture_output=True, text=True, timeout=60, check=True
    ).stdout.splitlines()


def test_the_engine_argv_ignores_a_planted_user_site(tmp_path: pathlib.Path) -> None:
    appdata = tmp_path / "appdata"
    marker = _plant(appdata)
    script = tmp_path / "probe.py"
    script.write_text(PROBE)

    # The plant is live: a full interpreter of the same version loads it. The
    # base interpreter, because a virtual environment has no user site either.
    found, _ = _run([], appdata, script, {}, interpreter=sys._base_executable)
    assert found == "True" and marker.exists(), "the plant is not where this Python version looks"
    marker.unlink()

    # From 3.15 the embeddable runtime's ._pth file turns the user site off by
    # itself, so the shipped runtime ignores the plant with no flag at all.
    found, _ = _run([], appdata, script, {})
    assert found == "False"
    assert not marker.exists()

    found, utf8 = _run(["-s"], appdata, script, {"PYTHONNOUSERSITE": "1"})
    assert found == "False"
    assert not marker.exists()
    assert utf8 == "1"
