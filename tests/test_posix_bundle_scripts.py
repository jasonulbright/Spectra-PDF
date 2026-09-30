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


#: The scripts that fetch a fork's pinned Linux artifact, the manifest that
#: inventories the unpacked tree, the awk row selector the script's notice gate
#: uses (as a Python predicate over the row), and the file/notice/sha columns.
ARTIFACT_SCRIPTS = {
    "bundle-tesseract.sh": ("tesseract-licenses.tsv", lambda c: c[0].startswith(("bin/", "lib/")), 0, 3, None),
    "bundle-jbig2enc.sh": ("jbig2enc-licenses.tsv", lambda c: c[0].startswith(("bin/", "lib/")), 0, 4, None),
    "bundle-voikko.sh": ("voikko.tsv", lambda c: len(c) >= 8 and c[7] == "linux", 0, 5, 3),
}
ARTIFACT_PIN = re.compile(
    r'^(?:NATIVE|ARTIFACT)_URL="(https://github\.com/jasonulbright/[^"]+\.tar\.zst)"\n'
    r'(?:NATIVE|ARTIFACT)_SHA256="([^"]*)"\n'
    r'(?:NATIVE|ARTIFACT)_SIZE="([^"]*)"$',
    re.MULTILINE,
)


def _artifact_pin(script: str) -> tuple[str, str, str]:
    match = ARTIFACT_PIN.search((SCRIPTS / script).read_text(encoding="utf-8"))
    assert match, f"{script} carries no URL/SHA256/SIZE pin block"
    return match.groups()


def _manifest_rows(name: str) -> list[list[str]]:
    rows, header = [], False
    for line in (SCRIPTS / name).read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or not line.strip():
            continue
        if not header:
            header = line.startswith("file\t")
            continue
        rows.append(line.split("\t"))
    return rows


@pytest.mark.parametrize("script", sorted(ARTIFACT_SCRIPTS))
def test_each_artifact_script_pins_url_hash_and_size(script):
    url, sha, size = _artifact_pin(script)
    assert re.fullmatch(r"[0-9a-f]{64}", sha), sha
    assert re.fullmatch(r"[1-9][0-9]*", size), size
    assert "/releases/download/spectra-" in url, url


def test_the_artifact_pins_are_distinct():
    pins = [_artifact_pin(s)[1] for s in ARTIFACT_SCRIPTS]
    assert len(set(pins)) == len(pins)


@pytest.mark.parametrize("script", sorted(ARTIFACT_SCRIPTS))
def test_each_artifact_script_runs_the_notice_gate_on_its_manifest(script):
    manifest = ARTIFACT_SCRIPTS[script][0]
    text = (SCRIPTS / script).read_text(encoding="utf-8")
    assert f'scripts/{manifest}"' in text
    assert re.search(r"^notice_gate ", text, re.MULTILINE), script
    assert re.search(r"^install_artifact ", text, re.MULTILINE), script


@pytest.mark.parametrize("script", sorted(ARTIFACT_SCRIPTS))
def test_the_linux_rows_resolve_inside_the_artifact_layout(script):
    manifest, select, file_col, notice_col, sha_col = ARTIFACT_SCRIPTS[script]
    rows = [r for r in _manifest_rows(manifest) if select(r)]
    assert rows, f"{manifest} has no Linux rows"
    shipped = {r[file_col] for r in rows}
    for row in rows:
        file = row[file_col]
        assert file.split("/", 1)[0] in ("bin", "lib", "licenses"), file
        for notice in row[notice_col].split(","):
            assert re.fullmatch(r"[A-Za-z0-9.+_-]+", notice), (file, notice)
        if sha_col is not None:
            assert re.fullmatch(r"[0-9a-f]{64}", row[sha_col]), file
    assert any(f.startswith(("bin/", "lib/")) for f in shipped)


@pytest.mark.parametrize("script", sorted(ARTIFACT_SCRIPTS))
def test_a_provisioned_tree_holds_every_row_and_notice(script):
    manifest, select, file_col, notice_col, sha_col = ARTIFACT_SCRIPTS[script]
    component = re.search(r'="\$LINUX_RESOURCES/([a-z0-9]+)"', (SCRIPTS / script).read_text(encoding="utf-8"))[1]
    tree = SCRIPTS.parent / "resources" / "linux-x86_64" / component
    if not (tree / ".artifact-sha256").is_file():
        pytest.skip(f"{component} artifact not provisioned")
    for row in (r for r in _manifest_rows(manifest) if select(r)):
        assert (tree / row[file_col]).is_file(), row[file_col]
        for notice in row[notice_col].split(","):
            assert (tree / "licenses" / notice).is_file(), (row[file_col], notice)


def test_the_jbig2_row_requires_the_patents_note():
    rows = {r[0]: r for r in _manifest_rows("jbig2enc-licenses.tsv")}
    assert "PATENTS-jbig2enc.txt" in rows["bin/jbig2"][4].split(",")


def test_every_linux_tree_carries_the_gcc_runtime_notice():
    for script, (manifest, select, file_col, notice_col, _sha) in ARTIFACT_SCRIPTS.items():
        rows = [r for r in _manifest_rows(manifest) if select(r)]
        runtime = [r for r in rows if r[file_col] in ("lib/libstdc++.so.6", "lib/libgcc_s.so.1")]
        assert len(runtime) == 2, script
        assert all(r[notice_col] == "LICENSE-gcc-runtime.txt" for r in runtime), script


def test_the_voikko_linux_row_carries_the_windows_licence_reading():
    rows = _manifest_rows("voikko.tsv")
    windows = next(r for r in rows if r[0] == "libvoikko-1.dll")
    linux = next(r for r in rows if r[0] == "lib/libvoikko.so.1")
    assert linux[4] == windows[4]
    assert "LICENSE-utfcpp.txt" in linux[5].split(",")


def test_the_windows_gates_skip_the_linux_rows():
    # Each PowerShell gate filters the shared manifest to its own rows; a Linux
    # row that reached it would name a file no Windows tree holds.
    assert r"'\.(exe|dll)$'" in (SCRIPTS / "bundle-jbig2enc.ps1").read_text(encoding="utf-8")
    assert "platform -ne 'linux'" in (SCRIPTS / "bundle-voikko.ps1").read_text(encoding="utf-8")


@pytest.mark.parametrize("script", sorted(ARTIFACT_SCRIPTS))
def test_each_artifact_script_names_the_tree_the_engine_reads(script, monkeypatch):
    from engine import platform_support

    monkeypatch.setattr(platform_support, "IS_WINDOWS", False)
    component = {"bundle-tesseract.sh": "tesseract", "bundle-jbig2enc.sh": "jbig2enc", "bundle-voikko.sh": "voikko"}[script]
    text = (SCRIPTS / script).read_text(encoding="utf-8")
    assert f'="$LINUX_RESOURCES/{component}"' in text
    relative = {
        "tesseract": platform_support.program_relative("tesseract"),
        "jbig2enc": platform_support.program_relative("jbig2"),
        "voikko": platform_support.library_relative("libvoikko-1.dll", "libvoikko.so.1"),
    }[component]
    rows = [r for r in _manifest_rows(ARTIFACT_SCRIPTS[script][0]) if ARTIFACT_SCRIPTS[script][1](r)]
    assert "/".join(relative) in {r[0] for r in rows}


def test_the_engine_refusals_name_scripts_that_exist(monkeypatch):
    from engine import platform_support

    engine = SCRIPTS.parent / "src" / "engine"
    stems = set()
    for source in engine.glob("*.py"):
        stems |= set(re.findall(r'bundle_script\("([^"]+)"\)', source.read_text(encoding="utf-8")))
    assert {"bundle-tesseract", "bundle-jbig2enc"} <= stems
    for windows in (False, True):
        monkeypatch.setattr(platform_support, "IS_WINDOWS", windows)
        for stem in stems:
            assert (SCRIPTS.parent / platform_support.bundle_script(stem)).is_file(), (windows, stem)


def _merge_patch(base, patch):
    if not isinstance(patch, dict):
        return patch
    out = dict(base) if isinstance(base, dict) else {}
    for key, value in patch.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = _merge_patch(out.get(key), value)
    return out


def test_each_platform_bundle_ships_only_its_own_native_trees():
    import json

    tauri = SCRIPTS.parent / "src-tauri"
    base = json.loads((tauri / "tauri.conf.json").read_text(encoding="utf-8"))
    linux = _merge_patch(base, json.loads((tauri / "tauri.linux.conf.json").read_text(encoding="utf-8")))
    portable = {"../resources/fonts", "../resources/dictionaries", "../resources/icc"}

    windows_trees = {k for k in base["bundle"]["resources"] if k.startswith("../resources/")}
    assert not {k for k in windows_trees if k.startswith("../resources/linux-x86_64")}
    windows_native = windows_trees - portable
    assert {"../resources/python", "../resources/tesseract", "../resources/jbig2enc"} <= windows_native

    linux_trees = {k for k in linux["bundle"]["resources"] if k.startswith("../resources/")}
    assert not linux_trees & windows_native
    assert linux_trees - portable == {k for k in linux_trees if k.startswith("../resources/linux-x86_64/")}
    targets = linux["bundle"]["resources"]
    assert targets["../resources/linux-x86_64/python"] == "python"
