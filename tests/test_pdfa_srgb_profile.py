"""The PDF/A output intent embeds the bundled sRGB profile on every platform.

The fake Ghostscript here has no `iccprofiles` tree beside it and no ROM, so
a profile path that depended on the user's Ghostscript would surface in the
captured command line.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from engine import budget, gs_capability, pdfa

ICC_DIR = Path(__file__).resolve().parent.parent / "resources" / "icc"
SRGB = ICC_DIR / "srgb" / "sRGB2014.icc"
SRGB_SHA256 = "384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a"


@pytest.fixture
def fake_gs(tmp_path, monkeypatch):
    exe = tmp_path / "bin" / ("gswin64c.exe" if os.name == "nt" else "gs")
    exe.parent.mkdir()
    exe.write_bytes(b"")
    monkeypatch.setattr(
        gs_capability, "require", lambda _path=None: SimpleNamespace(path=str(exe))
    )
    seen: dict = {}

    def run(cmd, **_kwargs):
        seen["cmd"] = list(cmd)
        definition = next(arg for arg in cmd if arg.endswith("pdfa_def.ps"))
        seen["definition"] = Path(definition).read_text(encoding="ascii")
        return subprocess.CompletedProcess(cmd, 1, "", "stopped by the test")

    monkeypatch.setattr(budget, "gs", run)
    return seen


def _profile_copy(tmp_path: Path) -> Path:
    if not SRGB.is_file():
        pytest.skip("bundled sRGB profile not provisioned (scripts/bundle-icc)")
    icc = tmp_path / "icc"
    (icc / "srgb").mkdir(parents=True)
    shutil.copyfile(SRGB, icc / "srgb" / "sRGB2014.icc")
    return icc


def test_the_output_intent_embeds_the_bundled_srgb_profile(tmp_pdf, tmp_path, fake_gs):
    icc = _profile_copy(tmp_path)
    with pytest.raises(RuntimeError, match="Ghostscript PDF/A conversion failed"):
        pdfa.convert_pdfa(tmp_pdf, str(tmp_path / "out.pdf"), icc_dir=str(icc))
    expected = str(icc / "srgb" / "sRGB2014.icc").replace("\\", "/")
    assert f"--permit-file-read={expected}" in fake_gs["cmd"]
    assert f"({expected}) (r) file" in fake_gs["definition"]
    assert "%rom%" not in "\n".join(fake_gs["cmd"]) + fake_gs["definition"]


def test_a_missing_bundled_profile_refuses_by_name(tmp_pdf, tmp_path, fake_gs):
    empty = tmp_path / "icc"
    empty.mkdir()
    with pytest.raises(RuntimeError, match="bundled sRGB color profile is missing"):
        pdfa.convert_pdfa(tmp_pdf, str(tmp_path / "out.pdf"), icc_dir=str(empty))
    assert "cmd" not in fake_gs
    assert not (tmp_path / "out.pdf").exists()


def test_the_provisioned_profile_is_the_pinned_version_2_profile():
    if not SRGB.is_file():
        pytest.skip("bundled sRGB profile not provisioned (scripts/bundle-icc)")
    data = SRGB.read_bytes()
    assert hashlib.sha256(data).hexdigest() == SRGB_SHA256
    assert data[8] == 2
    assert data[16:20] == b"RGB "
