"""The portable zip's updater entry and the minisign check the release runs."""

from __future__ import annotations

import base64
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ENTRY_SCRIPT = ROOT / "scripts" / "add-portable-updater-entry.ps1"
VERIFIER = ROOT / "scripts" / "verify_minisign.py"


def _load_verifier():
    spec = importlib.util.spec_from_file_location("verify_minisign", VERIFIER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["verify_minisign"] = module
    spec.loader.exec_module(module)
    return module


vm = _load_verifier()

#: Written by `tauri signer generate` and `tauri signer sign` with a throwaway
#: key that exists nowhere else; the private half was discarded.
FIXTURE_BYTES = b"PK\x03\x04 spectra portable fixture\n"
FIXTURE_KEY = (
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDY3MUZEMkZEMzJCQjVCM0EKUldRNlc3c3kvZElm"
    "WjJIQkoyRE1sbEZyTTh4ZUczSis3V0Flbmh2M1FQa201b0VSSVliYVBobkgK"
)
OTHER_KEY = (
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEMwQjcyOTlDMzk0OUMwRkMKUldUOHdFazVuQ20z"
    "d0xSUmpCUlBhclNOcnVIN1dSeDE0NUlNOExubEFTZlZlL3FIalZmbDZYUnQK"
)
SIG_999 = (
    "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRNlc3c3kvZElmWnlBNkYz"
    "Um9PYnp1ZkFJRDhFUndYNlYrMEtaMnJiWHM4NTc1OEJtM011N01Fd0hhVU9GTTRDSGZzY2lnTUd4bWcxVWlwb1RXcm81"
    "TzB6OGtzZkhiaFFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyMjQzNjQ3CWZpbGU6c3BlY3RyYXBkZi05"
    "LjkuOS1wb3J0YWJsZS56aXAKRXdHd1RTQkZFOS9RY0VVUjkzcUFwNjNmVXQ3c3NaWXJVZmo5MXJKeU1zQTVnbkQzc1lW"
    "ODFtNmxpeFRHNDhuNzBZY3lGMkJuS3VXNVBMMW52OWYyQkE9PQo="
)
SIG_998 = (
    "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRNlc3c3kvZElmWitzUzhP"
    "ZUJVdlVWTWxRYnRTbHFDVVVhajJZdjBKSXViRUszSU5MRTBjYXR5KzNubXFNUklCQTlwMDB2NjFMK3BYSnhkbHdXZU9E"
    "cksvemFPMTMrVXdZPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyMjQzNzkwCWZpbGU6c3BlY3RyYXBkZi05"
    "LjkuOC1wb3J0YWJsZS56aXAKejI5MDR1Nit1dis1L1NNeEsrd0VYcHlXVEpFM3pSOHVuMDVuUEFBTWdCb0hDNlA1d3lV"
    "dHI4L0dJREErU0JJMzlLdnFtOXZseWlCdGVtVVBSckw2QlE9PQo="
)
NAME_999 = "spectrapdf-9.9.9-portable.zip"


def test_ed25519_matches_the_rfc_8032_vectors() -> None:
    public = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    signature = bytes.fromhex(
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
    )
    assert vm.ed25519_verify(public, b"", signature)
    assert not vm.ed25519_verify(public, b"\x00", signature)
    public2 = bytes.fromhex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
    signature2 = bytes.fromhex(
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
    )
    assert vm.ed25519_verify(public2, b"\x72", signature2)
    tampered = bytearray(signature2)
    tampered[0] ^= 1
    assert not vm.ed25519_verify(public2, b"\x72", bytes(tampered))
    high_s = signature2[:32] + (int.from_bytes(signature2[32:], "little") + vm.L).to_bytes(32, "little")
    assert not vm.ed25519_verify(public2, b"\x72", high_s)


@pytest.fixture()
def fixture_zip(tmp_path: Path) -> Path:
    path = tmp_path / NAME_999
    path.write_bytes(FIXTURE_BYTES)
    return path


def test_a_tauri_signature_verifies_and_names_its_file(fixture_zip: Path) -> None:
    verified = vm.verify_file(FIXTURE_KEY, SIG_999, fixture_zip, NAME_999)
    assert verified.fields["file"] == NAME_999
    assert verified.fields["timestamp"] == "1792243647"


def test_changed_bytes_are_refused(fixture_zip: Path) -> None:
    fixture_zip.write_bytes(FIXTURE_BYTES + b"x")
    with pytest.raises(vm.SignatureError, match="does not verify"):
        vm.verify_file(FIXTURE_KEY, SIG_999, fixture_zip, NAME_999)


def test_another_versions_signature_over_the_same_bytes_is_refused(fixture_zip: Path) -> None:
    vm.verify_file(FIXTURE_KEY, SIG_998, fixture_zip)
    with pytest.raises(vm.SignatureError, match="trusted comment names file"):
        vm.verify_file(FIXTURE_KEY, SIG_998, fixture_zip, NAME_999)


def test_another_key_is_refused(fixture_zip: Path) -> None:
    with pytest.raises(vm.SignatureError, match="names key 671FD2FD32BB5B3A"):
        vm.verify_file(OTHER_KEY, SIG_999, fixture_zip, NAME_999)


def test_an_edited_trusted_comment_is_refused(fixture_zip: Path) -> None:
    lines = base64.b64decode(SIG_999).decode().split("\n")
    lines[2] = lines[2].replace("9.9.9", "9.9.10")
    forged = base64.b64encode("\n".join(lines).encode()).decode()
    with pytest.raises(vm.SignatureError, match="global signature"):
        vm.verify_file(FIXTURE_KEY, forged, fixture_zip, "spectrapdf-9.9.10-portable.zip")


def test_the_shipped_updater_key_parses() -> None:
    run = subprocess.run(
        [sys.executable, "-I", str(VERIFIER), "--public-key-from-conf",
         str(ROOT / "src-tauri" / "tauri.conf.json"), "--key-only"],
        capture_output=True, text=True,
    )
    assert run.returncode == 0, run.stdout + run.stderr
    assert "parses" in run.stdout


def test_the_cli_exits_non_zero_on_a_refusal(fixture_zip: Path) -> None:
    sig = fixture_zip.with_name(fixture_zip.name + ".sig")
    sig.write_text(SIG_999)
    base = [sys.executable, "-I", str(VERIFIER), "--public-key", FIXTURE_KEY,
            "--signature-file", str(sig), "--file", str(fixture_zip)]
    ok = subprocess.run(base + ["--expect-file", NAME_999], capture_output=True, text=True)
    assert ok.returncode == 0, ok.stdout + ok.stderr
    bad = subprocess.run(base + ["--expect-file", "other.zip"], capture_output=True, text=True)
    assert bad.returncode == 1
    assert "refused:" in bad.stderr


def _require_pwsh() -> None:
    if shutil.which("pwsh") is None:
        pytest.skip("pwsh is not installed")


#: The manifest the release has before the step: what tauri-action and the
#: Linux step wrote, with a `pub_date` whose text must survive unchanged.
ORIGINAL = {
    "version": "9.9.9",
    "notes": "See CHANGELOG.md for details.",
    "pub_date": "2026-10-17T15:00:00.000Z",
    "platforms": {
        "windows-x86_64": {"signature": "aW5zdGFsbGVy", "url": "https://api.github.com/repos/o/r/releases/assets/100"},
        "windows-x86_64-nsis": {"signature": "aW5zdGFsbGVy", "url": "https://api.github.com/repos/o/r/releases/assets/100"},
        "linux-x86_64": {"signature": "YXBwaW1hZ2U=", "url": "https://api.github.com/repos/o/r/releases/assets/105"},
    },
}


def _offline_draft(tmp_path: Path) -> tuple[Path, Path]:
    portable = tmp_path / "portable"
    downloaded = tmp_path / "downloaded"
    portable.mkdir()
    downloaded.mkdir()
    (portable / NAME_999).write_bytes(FIXTURE_BYTES)
    (portable / f"{NAME_999}.sig").write_text(SIG_999 + "\n")
    text = json.dumps(ORIGINAL, indent=2)
    (downloaded / "latest.json").write_text(text, encoding="utf-8")
    assets = [
        {"name": "Spectra.PDF_9.9.9_x64-setup.exe", "id": 100, "size": 10},
        {"name": NAME_999, "id": 102, "size": len(FIXTURE_BYTES)},
        {"name": "latest.json", "id": 200, "size": len(text.encode())},
    ]
    (downloaded / "assets.json").write_text(json.dumps(assets), encoding="utf-8")
    return portable, downloaded


def _add_entry(portable: Path, downloaded: Path, tag: str = "v9.9.9") -> subprocess.CompletedProcess:
    return subprocess.run(
        ["pwsh", "-NoProfile", "-File", str(ENTRY_SCRIPT), "-Repo", "o/r", "-Tag", tag,
         "-Portable", str(portable), "-Offline", str(downloaded)],
        capture_output=True, text=True,
    )


def test_the_entry_is_added_and_every_existing_key_is_kept(tmp_path: Path) -> None:
    _require_pwsh()
    portable, downloaded = _offline_draft(tmp_path)
    run = _add_entry(portable, downloaded)
    assert run.returncode == 0, run.stdout + run.stderr
    raw = (downloaded / "latest.json").read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf") and b"\r\n" not in raw
    manifest = json.loads(raw)
    assert manifest["pub_date"] == ORIGINAL["pub_date"]
    for key in ("version", "notes"):
        assert manifest[key] == ORIGINAL[key]
    for key, entry in ORIGINAL["platforms"].items():
        assert manifest["platforms"][key] == entry, key
    assert manifest["platforms"]["windows-x86_64-portable"] == {
        "signature": SIG_999,
        "url": "https://api.github.com/repos/o/r/releases/assets/102",
    }
    assert set(manifest["platforms"]) == set(ORIGINAL["platforms"]) | {"windows-x86_64-portable"}
    assets = json.loads((downloaded / "assets.json").read_text(encoding="utf-8"))
    sizes = {a["name"]: a["size"] for a in assets}
    assert sizes["latest.json"] == len(raw)


def test_a_rerun_replaces_the_entry(tmp_path: Path) -> None:
    _require_pwsh()
    portable, downloaded = _offline_draft(tmp_path)
    assert _add_entry(portable, downloaded).returncode == 0
    first = (downloaded / "latest.json").read_bytes()
    second_run = _add_entry(portable, downloaded)
    assert second_run.returncode == 0, second_run.stdout + second_run.stderr
    assert (downloaded / "latest.json").read_bytes() == first


def test_a_manifest_for_another_version_is_refused(tmp_path: Path) -> None:
    _require_pwsh()
    portable, downloaded = _offline_draft(tmp_path)
    run = _add_entry(portable, downloaded, tag="v9.9.10")
    assert run.returncode != 0
    assert "latest.json version is not the tag version" in run.stdout + run.stderr


def test_a_missing_signature_is_refused(tmp_path: Path) -> None:
    _require_pwsh()
    portable, downloaded = _offline_draft(tmp_path)
    (portable / f"{NAME_999}.sig").unlink()
    run = _add_entry(portable, downloaded)
    assert run.returncode != 0
    assert "no updater signature" in run.stdout + run.stderr
