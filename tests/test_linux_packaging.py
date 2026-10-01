"""The Linux packaging inputs: the Tauri Linux config, the desktop entry, the
AppStream file, AppRun, the AppImage build pins, the Linux Python pin rule and
the jammy library pins."""

import importlib.util
import json
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
TAURI = ROOT / "src-tauri"
LINUX = TAURI / "linux"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _linux_conf() -> dict:
    return json.loads(_text(TAURI / "tauri.linux.conf.json"))


def _assigned(text: str, name: str) -> str:
    match = re.search(rf'^{name}="([^"]*)"$', text, re.M)
    assert match, name
    return match.group(1)


# ── Tauri Linux config ───────────────────────────────────────────────────────


def test_the_linux_config_names_the_package_spectrapdf_and_adds_no_version_surface():
    conf = _linux_conf()
    assert conf["productName"] == "spectrapdf"
    assert "version" not in conf
    assert conf["bundle"]["targets"] == ["deb", "rpm"]
    assert conf["bundle"]["createUpdaterArtifacts"] is False
    assert "Windows" not in conf["bundle"]["shortDescription"] + conf["bundle"]["longDescription"]


def test_the_linux_resource_directory_matches_the_cli_lookup():
    source = _text(TAURI / "src" / "platform.rs")
    linux = re.search(r'#\[cfg\(target_os = "linux"\)\]\nconst PRODUCT_NAME: &str = "([^"]+)";', source)
    other = re.search(r'#\[cfg\(not\(target_os = "linux"\)\)\]\nconst PRODUCT_NAME: &str = "([^"]+)";', source)
    assert linux and other
    assert linux[1] == _linux_conf()["productName"]
    assert other[1] == json.loads(_text(TAURI / "tauri.conf.json"))["productName"]


def test_the_linux_bundle_ships_its_own_dictionary_tree():
    resources = _linux_conf()["bundle"]["resources"]
    assert resources["../resources/dictionaries"] is None
    assert resources["../resources/linux-x86_64/dictionaries"] == "dictionaries"
    for script in ("bundle-dictionaries.sh", "bundle-voikko.sh"):
        text = _text(SCRIPTS / script)
        assert '$LINUX_RESOURCES/dictionaries' in text, script
        assert 'DEST="$RESOURCES_ROOT/dictionaries' not in text, script


def test_the_packages_declare_the_time_zone_database_and_carry_the_product_licence():
    """tauri-cli itself adds WebKitGTK 4.1, GTK 3 and, with the tray-icon
    feature, the appindicator library to both packages' dependencies; the
    config adds only what the engine needs beyond that."""
    linux = _linux_conf()["bundle"]["linux"]
    assert linux["deb"]["depends"] == ["tzdata"]
    assert linux["rpm"]["depends"] == ["tzdata"]
    assert linux["deb"]["files"]["/usr/share/doc/spectrapdf/copyright"] == "../LICENSE"
    assert linux["rpm"]["files"]["/usr/share/licenses/spectrapdf/LICENSE"] == "../LICENSE"
    for kind in ("deb", "rpm"):
        assert (TAURI / linux[kind]["desktopTemplate"]).is_file()
        for source in linux[kind]["files"].values():
            assert (TAURI / source).is_file(), source
    for icon in _linux_conf()["bundle"]["icon"]:
        assert (TAURI / icon).is_file(), icon


# ── Desktop entry, AppStream, AppRun ─────────────────────────────────────────


def test_the_desktop_entry_routes_files_into_the_app():
    raw = (LINUX / "spectrapdf.desktop").read_bytes()
    assert b"\r" not in raw
    lines = raw.decode("utf-8").splitlines()
    assert lines[0] == "[Desktop Entry]"
    fields = dict(line.split("=", 1) for line in lines[1:] if "=" in line)
    assert fields["Exec"] == "spectrapdf %F"
    assert fields["Icon"] == "spectrapdf"
    assert fields["Name"] == "Spectra PDF"
    assert fields["MimeType"] == "application/pdf;"
    assert fields["Terminal"] == "false"


def test_the_appstream_file_launches_the_desktop_entry():
    tree = ET.parse(LINUX / "com.spectrapdf.app.metainfo.xml").getroot()
    assert tree.get("type") == "desktop-application"
    assert tree.findtext("id") == "com.spectrapdf.app"
    assert tree.findtext("launchable") == "spectrapdf.desktop"
    assert tree.findtext("project_license") == "MIT"
    assert tree.find("releases") is None


def test_apprun_names_the_missing_libraries_and_their_packages():
    text = _text(LINUX / "AppRun")
    assert text.startswith("#!/bin/sh\n")
    for lib in ("libwebkit2gtk-4.1.so.0", "libjavascriptcoregtk-4.1.so.0", "libsoup-3.0.so.0", "libgtk-3.so.0"):
        assert lib in text
    assert "libwebkit2gtk-4.1-0 libgtk-3-0" in text
    assert "webkit2gtk4.1 gtk3" in text
    assert "exit 127" in text
    assert "/usr/share/zoneinfo" in text and "tzdata" in text
    assert text.rstrip().endswith('exec "$HERE/usr/bin/spectrapdf" "$@"')


@pytest.mark.skipif(shutil.which("sh") is None, reason="no POSIX shell to parse with")
def test_apprun_parses():
    run = subprocess.run(["sh", "-n", str(LINUX / "AppRun")], capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr


# ── AppImage build ───────────────────────────────────────────────────────────


def test_the_appimage_tools_are_the_pinned_vendor_releases():
    text = _text(SCRIPTS / "build-appimage.sh")
    assert _assigned(text, "APPIMAGETOOL_URL") == (
        "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
    )
    assert _assigned(text, "RUNTIME_URL") == (
        "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64"
    )
    for name in ("APPIMAGETOOL", "RUNTIME"):
        assert re.fullmatch(r"[0-9a-f]{64}", _assigned(text, f"{name}_SHA256"))
        assert re.fullmatch(r"[1-9][0-9]*", _assigned(text, f"{name}_SIZE"))
    assert "linuxdeploy" not in text
    notices = _text(ROOT / "THIRD-PARTY-LICENSES.md")
    assert _assigned(text, "RUNTIME_SHA256") in notices


def test_the_update_information_points_at_the_published_zsync_name():
    text = _text(SCRIPTS / "build-appimage.sh")
    info = _assigned(text, "UPDATE_INFO_DEFAULT")
    kind, user, repo, tag, pattern = info.split("|")
    assert (kind, user, repo, tag) == ("gh-releases-zsync", "jasonulbright", "Spectra-PDF", "latest")
    assert 'NAME="spectrapdf_${VERSION}_amd64.AppImage"' in text
    assert re.fullmatch(pattern.replace(".", r"\.").replace("*", r"[^/]+"),
                        "spectrapdf_2026.1011.151_amd64.AppImage.zsync")


def test_the_runtime_notices_ship():
    text = _text(SCRIPTS / "build-appimage.sh")
    names = re.search(r'RUNTIME_NOTICE_FILES="([^"]+)"', text)[1].split()
    assert len(names) == 7
    for name in names:
        assert (ROOT / "vendor" / "appimage-runtime" / name).stat().st_size > 0, name


def test_the_host_library_list_names_no_tls_or_bundled_library():
    text = _text(SCRIPTS / "build-appimage.sh")
    listed = re.search(r'HOST_SONAMES="([^"]+)"', text)[1].split()
    assert "libwebkit2gtk-4.1.so.0" in listed and "libc.so.6" in listed
    assert not [n for n in listed if n.startswith(("libssl", "libcrypto", "libpython", "libnss"))]


def test_the_release_build_refuses_unsigned_packages():
    text = _text(SCRIPTS / "linux-release-build.sh")
    assert 'die "a release build needs TAURI_SIGNING_PRIVATE_KEY' in text
    assert 'die "a release build needs TAURI_SIGNING_RPM_KEY' in text
    assert 'rpmkeys -Kv "$RPM"' in text
    key = _text(ROOT / "keys" / "spectrapdf-rpm-signing.pub.asc")
    assert key.startswith("-----BEGIN PGP PUBLIC KEY BLOCK-----")
    assert "PRIVATE" not in key
    verifier = _text(SCRIPTS / "verify-rpm-signature.sh")
    fingerprint = _assigned(verifier, "FINGERPRINT")
    assert fingerprint == "5cc064b7833ab9d7404ff1366a868e9e98076374"
    assert fingerprint.endswith(_assigned(verifier, "KEY_ID"))


# ── Linux Python runtime pin ─────────────────────────────────────────────────


def test_the_linux_runtime_is_the_pinned_minor_at_or_below_the_patch():
    pin = _text(ROOT / ".python-version").split()[0]
    text = _text(SCRIPTS / "setup-python-embed.sh")
    linux = _assigned(text, "PBS_PINNED_VERSION")
    a, b = [tuple(int(x) for x in v.split(".")) for v in (pin, linux)]
    assert b[:2] == a[:2] and b[2] <= a[2]
    assert '[ "$PYTHON_VERSION" = "$PBS_PINNED_VERSION" ]' not in text
    notices = _text(ROOT / "THIRD-PARTY-LICENSES.md")
    assert f"CPython {linux} from python-build-standalone release {_assigned(text, 'PBS_RELEASE')}" in notices


def _toolchains():
    spec = importlib.util.spec_from_file_location("check_toolchains_linux", SCRIPTS / "check-toolchains.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _release(tag: str, *versions: str) -> dict:
    return {
        "tag_name": tag,
        "assets": [
            {"name": f"cpython-{v}+{tag}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
             "digest": "sha256:" + "ab" * 32}
            for v in versions
        ] + [{"name": f"cpython-3.14.9+{tag}-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz"}],
    }


@pytest.mark.parametrize(
    "pin, linux, versions, passed, needle",
    [
        ("3.14.8", "3.14.8", ("3.13.9", "3.14.8"), True, "OK:"),
        ("3.14.8", "3.14.7", ("3.14.7",), True, "NOTE:"),
        ("3.14.8", "3.14.7", ("3.14.7", "3.14.8"), False, "carries 3.14.8"),
        ("3.14.8", "3.14.8", ("3.14.9",), False, "carries no Linux x86-64 build"),
        ("3.14.8", "3.13.9", ("3.13.9",), False, "must be Python 3.14"),
        ("3.14.8", "3.14.9", ("3.14.9",), False, "must be Python 3.14"),
    ],
)
def test_the_python_linux_arm(pin, linux, versions, passed, needle):
    module = _toolchains()
    ok, lines = module.python_linux_verdict(
        module.Fetched(pin),
        module.Fetched({"release": "20260929", "version": linux}),
        module.Fetched(_release("20260929", *versions)),
    )
    assert ok is passed
    assert any(needle in line for line in lines), lines


def test_the_python_linux_arm_fails_closed_without_the_release_list():
    module = _toolchains()
    ok, lines = module.python_linux_verdict(
        module.Fetched("3.14.8"),
        module.read_linux_pin(SCRIPTS / "setup-python-embed.sh"),
        module.Fetched(error="offline"),
    )
    assert not ok
    assert any("offline" in line for line in lines)
    assert "python-linux" in module.CHECKS


# ── LibreOffice host libraries ───────────────────────────────────────────────


def test_the_nss_pins_are_the_jammy_builds_with_a_second_source():
    text = _text(SCRIPTS / "bundle-libreoffice.sh")
    notices = _text(SCRIPTS / "libreoffice-notices.tsv")
    for prefix in ("NSS", "NSPR", "SQLITE"):
        deb = _assigned(text, f"{prefix}_DEB")
        assert "ubuntu0.22.04" in deb or "2ubuntu0." in deb, deb
        assert re.fullmatch(r"[0-9a-f]{64}", _assigned(text, f"{prefix}_SHA256"))
        urls = _assigned(text, f"{prefix}_URLS")
        assert "$LAUNCHPAD_FILES/" in urls and "$UBUNTU_POOL/" in urls
        version = deb.split("_")[1]
        assert version in notices, version
    assert "1ubuntu0.2" not in notices and "3.45.1" not in notices
