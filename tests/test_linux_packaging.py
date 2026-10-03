"""The Linux packaging inputs: the Tauri Linux config, the desktop entry, the
AppStream file, the AppImage start hook and LibreOffice launcher, the AppImage
build pins and package allowlist, the Linux Python pin rule and the jammy
library pins."""

import importlib.util
import json
import os
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


def test_the_packages_declare_the_time_zone_database_and_ghostscript_and_carry_the_product_licence():
    """tauri-cli itself adds WebKitGTK 4.1, GTK 3 and, with the tray-icon
    feature, the appindicator library to both packages' dependencies; the
    config adds only what the engine needs beyond that."""
    linux = _linux_conf()["bundle"]["linux"]
    assert linux["deb"]["depends"] == ["tzdata", "ghostscript"]
    assert linux["rpm"]["depends"] == ["tzdata", "ghostscript"]
    assert linux["deb"]["files"]["/usr/share/doc/spectrapdf/copyright"] == "../LICENSE"
    assert linux["rpm"]["files"]["/usr/share/licenses/spectrapdf/LICENSE"] == "../LICENSE"
    for kind in ("deb", "rpm"):
        assert (TAURI / linux[kind]["desktopTemplate"]).is_file()
        for source in linux[kind]["files"].values():
            assert (TAURI / source).is_file(), source
    for icon in _linux_conf()["bundle"]["icon"]:
        assert (TAURI / icon).is_file(), icon


# ── Desktop entry, AppStream, start hook, LibreOffice launcher ───────────────


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
    assert sum(1 for line in lines if line.startswith("Icon=")) == 1
    assert sum(1 for line in lines if line.startswith("Categories=")) == 1


def test_the_appstream_file_launches_the_desktop_entry():
    tree = ET.parse(LINUX / "com.spectrapdf.app.appdata.xml").getroot()
    assert tree.get("type") == "desktop-application"
    assert tree.findtext("id") == "com.spectrapdf.app"
    assert tree.findtext("launchable") == "spectrapdf.desktop"
    assert tree.findtext("project_license") == "MIT"
    assert tree.find("releases") is None


def test_the_sandbox_hook_probes_bwrap_and_changes_no_system_setting():
    assert not (LINUX / "AppRun").exists()
    raw = (LINUX / "webkit-sandbox.hook").read_bytes()
    assert b"\r" not in raw
    text = raw.decode("utf-8")
    assert text.startswith("#!/bin/sh\n")
    assert '"$APPDIR/bin/bwrap" --unshare-user' in text
    assert "export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1" in text
    for forbidden in ("sysctl", "pkexec", "sudo", "run0", "/etc/"):
        assert forbidden not in text, forbidden
    build = _text(SCRIPTS / "build-appimage.sh")
    assert 'install -m 0755 "$SANDBOX_HOOK" "$APPDIR/bin/10-webkit-sandbox.hook"' in build
    assert "ADD_HOOKS" not in build
    assert 'die "the image must not carry fix-namespaces.hook"' in build


def test_the_libreoffice_launcher_starts_soffice_bin_on_the_image_loader():
    raw = (LINUX / "libreoffice-launcher").read_bytes()
    assert b"\r" not in raw
    text = raw.decode("utf-8")
    assert text.startswith("#!/bin/sh\n")
    assert '"$root/lib/ld-linux-x86-64.so.2" --preload "$SPECTRAPDF_IMAGE_EXEC"' in text
    assert '--library-path "$office:$image" "$office/soffice.bin" "$@"' in text
    assert '[ "$status" -eq 81 ]' in text
    assert "$root/lib/lib.path" in text
    build = _text(SCRIPTS / "build-appimage.sh")
    assert '"$APPDIR/lib/libreoffice-launcher/program/soffice"' in build
    assert 'ln -s ../spectrapdf/libreoffice/share "$APPDIR/lib/libreoffice-launcher/share"' in build
    engine = _text(TAURI / "src" / "engine.rs")
    assert '.join("libreoffice-launcher")' in engine


def test_the_start_script_quotes_every_expansion_and_launches_the_app():
    raw = (LINUX / "AppRun.sh").read_bytes()
    assert b"\r" not in raw
    text = raw.decode("utf-8")
    assert 'PATH="$APPDIR/bin:$PATH"' in text.splitlines()
    assert "export ARG0 APPDIR PATH" in text
    assert "MAIN_BIN=spectrapdf" in text
    assert 'for hook in "$APPDIR"/bin/*.hook; do' in text
    assert re.search(r"export [A-Z_]+=", text) is None
    build = _text(SCRIPTS / "build-appimage.sh")
    assert 'install -m 0755 "$APPRUN_SCRIPT" "$APPDIR/AppRun.sh"' in build
    assert 'cmp "$APPRUN_SCRIPT" "$APPDIR/AppRun.sh"' in build


def test_the_exec_library_moves_payload_programs_onto_the_image_loader():
    library = _text(LINUX / "image-exec.c")
    core = _text(LINUX / "image-exec.h")
    trampoline = _text(LINUX / "image-exec-trampoline.c")
    for symbol in ("int execve(", "int execv(", "int execvp(", "int execvpe(", "int execl(", "int execlp(", "int execle(",
                   "int posix_spawn(", "int posix_spawnp("):
        assert symbol in library, symbol
    for rule in ("R1.", "R2.", "R3.", "R4."):
        assert rule in library, rule
    for needle in ("SPECTRAPDF_IMAGE_ROOT", "SPECTRAPDF_IMAGE_EXEC", "SPECTRAPDF_IMAGE_LIBRARY_PATH", '#include "image-exec.h"',
                   "spawn_in_child", "SO_PEERCRED"):
        assert needle in library, needle
    for needle in ('"--preload"', '"--library-path"', '"--argv0"', "PT_INTERP", '"/lib/spectrapdf/"', "ENOEXEC", "image_script",
                   '"/lib/image-exec/image-exec-trampoline"', "image_argument_limit"):
        assert needle in core, needle
    for limit in ("MAX_ARGS", "MAX_ENV", "LIST_SIZE", "SEARCH_SIZE", "malloc("):
        assert limit not in library and limit not in core and limit not in trampoline, limit
    assert '#include "image-exec.h"' in trampoline
    build = _text(SCRIPTS / "build-appimage.sh")
    assert 'gcc -shared -fPIC -O2 -Wall -Wextra -Werror -o "$APPDIR/lib/image-exec/image-exec.so" "$IMAGE_EXEC_SOURCE"' in build
    assert ('gcc -static -O2 -Wall -Wextra -Werror -o "$APPDIR/lib/image-exec/image-exec-trampoline" '
            '"$IMAGE_EXEC_TRAMPOLINE_SOURCE"') in build
    gate = _text(SCRIPTS / "verify-appimage-contents.sh")
    assert "need_elf lib/image-exec/image-exec-trampoline" in gate
    assert "lib/image-exec/image-exec-trampoline is not a static executable" in gate
    generator = _text(SCRIPTS / "appimage-packages.py")
    assert '"lib/image-exec/image-exec-trampoline": "glibc",' in generator
    assert 'rows.append((rel, f"static:{STATIC_LINKED[rel]}", digest))' in generator
    assert '$1 == "lib/image-exec/image-exec-trampoline" && $2 == "static:glibc"' in gate
    assert "statically linked with the C library of the Arch Linux `glibc` package" in _text(ROOT / "THIRD-PARTY-LICENSES.md")
    for launcher in ("python-launcher", "libreoffice-launcher"):
        text = _text(LINUX / launcher)
        assert 'SPECTRAPDF_IMAGE_EXEC="$root/lib/image-exec/image-exec.so"' in text, launcher
        assert "LD_PRELOAD" not in text, launcher


@pytest.mark.skipif(not sys.platform.startswith("linux") or shutil.which("gcc") is None,
                    reason="compiles and runs the exec library on Linux")
def test_the_exec_library_keeps_exec_semantics_and_moves_payload_programs():
    run = subprocess.run(["sh", str(SCRIPTS / "test-image-exec.sh")], capture_output=True, text=True, timeout=300)
    assert run.returncode == 0, run.stdout + run.stderr
    assert "image-exec: every case passed" in run.stdout


def test_the_exec_library_test_runs_in_the_build_and_the_linux_parity():
    build = _text(SCRIPTS / "build-appimage.sh")
    assert 'sh "$REPO_ROOT/scripts/test-image-exec.sh" "$APPDIR/lib/image-exec/image-exec.so" ||' in build
    assert "step sh scripts/test-image-exec.sh" in _text(SCRIPTS / "ci-parity-linux.sh")


def test_the_python_launcher_starts_the_payload_interpreter_on_the_image_loader():
    raw = (LINUX / "python-launcher").read_bytes()
    assert b"\r" not in raw
    text = raw.decode("utf-8")
    assert text.startswith("#!/bin/sh\n")
    assert 'exec "$root/lib/ld-linux-x86-64.so.2" --preload "$SPECTRAPDF_IMAGE_EXEC"' in text
    assert '--library-path "$python/bin:$python/lib:$image" "$python/bin/python3" "$@"' in text
    build = _text(SCRIPTS / "build-appimage.sh")
    assert 'install -m 0755 "$PYTHON_LAUNCHER" "$APPDIR/lib/python-launcher/python3"' in build
    engine = _text(TAURI / "src" / "engine.rs")
    assert '&["python-launcher", "python3"]' in engine
    assert "crate::engine::image_python()" in _text(TAURI / "src" / "cli.rs")


def _platform_support():
    spec = importlib.util.spec_from_file_location("platform_support_image", ROOT / "src" / "engine" / "platform_support.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _elf_with_interpreter(path: Path, interp: bool) -> None:
    header = bytearray(64)
    header[:6] = b"\x7fELF\x02\x01"
    header[0x20:0x28] = (64).to_bytes(8, "little")
    header[0x36:0x38] = (56).to_bytes(2, "little")
    header[0x38:0x3A] = (1).to_bytes(2, "little")
    program_header = bytearray(56)
    program_header[:4] = (3 if interp else 1).to_bytes(4, "little")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(header + program_header))


def test_payload_programs_start_on_the_image_loader_and_nothing_else_does(tmp_path):
    module = _platform_support()
    root = tmp_path / "mount"
    tesseract = root / "lib" / "spectrapdf" / "tesseract" / "bin" / "tesseract"
    static = root / "lib" / "spectrapdf" / "tools" / "static"
    script = root / "lib" / "spectrapdf" / "libreoffice" / "program" / "soffice"
    outside = root / "bin" / "gs"
    _elf_with_interpreter(tesseract, True)
    _elf_with_interpreter(static, False)
    _elf_with_interpreter(outside, True)
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("#!/bin/sh\n", encoding="utf-8")
    (root / "lib" / "lib.path").write_text("+\n+/gio/modules\n", encoding="utf-8")
    assert module.image_argv([str(tesseract)], root=str(root)) == [str(tesseract)], "no image loader yet"
    (root / "lib" / "ld-linux-x86-64.so.2").write_bytes(b"")
    argv = module.image_argv([str(tesseract), "page.png", "stdout"], root=str(root))
    real = Path(os.path.realpath(tesseract))
    assert argv[:2] == [str(root / "lib" / "ld-linux-x86-64.so.2"), "--library-path"]
    assert argv[3:] == [str(real), "page.png", "stdout"]
    assert argv[2].startswith(str(real.parent) + ":")
    assert str(root / "lib" / "gio" / "modules") in argv[2]
    for args in ([str(static), "x"], [str(script), "x"], [str(outside), "x"], ["tesseract", "x"]):
        assert module.image_argv(args, root=str(root)) == args
    assert module.image_argv([str(tesseract)], root="") == [str(tesseract)]


def test_an_image_root_needs_the_image_loader_and_payload(tmp_path):
    module = _platform_support()
    root = tmp_path / "usr"
    (root / "lib").mkdir(parents=True)
    assert module.image_root(str(root)) is None
    (root / "lib" / "ld-linux-x86-64.so.2").write_bytes(b"")
    assert module.image_root(str(root)) is None
    (root / "lib" / "spectrapdf").mkdir()
    assert module.image_root(str(root)) == root
    assert module.image_root("relative") is None
    assert module.image_root("") is None


@pytest.mark.skipif(os.name == "nt", reason="colon-separated lists of POSIX paths")
def test_a_program_outside_the_image_gets_no_image_variables(tmp_path):
    module = _platform_support()
    root = tmp_path / "mount"
    (root / "lib" / "spectrapdf").mkdir(parents=True)
    (root / "lib" / "ld-linux-x86-64.so.2").write_bytes(b"")
    inside = root / "bin" / "gs"
    inside.parent.mkdir()
    inside.write_bytes(b"")
    host = tmp_path / "usr" / "bin" / "gs"
    host.parent.mkdir(parents=True)
    host.write_bytes(b"")
    r = str(root)
    env = {
        "GS_LIB": f"{r}/share/ghostscript/Resource/Init:{r}/share/ghostscript/Resource",
        "XDG_DATA_DIRS": f"{r}/share:/usr/local/share:/usr/share",
        "PATH": f"{r}/bin:/usr/bin:/bin",
        "LD_LIBRARY_PATH": "/opt/lib",
        "GTK_PATH": f"{r}/lib/gtk-3.0",
        "HOME": "/home/user",
    }
    cleaned = module.image_env([str(host), "-q"], env, root=r)
    assert cleaned == {"XDG_DATA_DIRS": "/usr/local/share:/usr/share", "PATH": "/usr/bin:/bin", "HOME": "/home/user"}
    assert module.image_env([str(inside), "-q"], env, root=r) is None
    assert module.image_env([str(host)], env, root=str(tmp_path / "nowhere")) is None


@pytest.mark.skipif(shutil.which("sh") is None, reason="no POSIX shell to parse with")
@pytest.mark.parametrize("name", ["webkit-sandbox.hook", "libreoffice-launcher", "python-launcher", "AppRun.sh"])
def test_the_image_scripts_parse(name):
    run = subprocess.run(["sh", "-n", str(LINUX / name)], capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr


# ── AppImage build ───────────────────────────────────────────────────────────


def _packages_module():
    spec = importlib.util.spec_from_file_location("appimage_packages", SCRIPTS / "appimage-packages.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _assigned_words(text: str, name: str) -> list:
    match = re.search(rf'^{name}="([^"]*)"$', text, re.M | re.S)
    assert match, name
    return match.group(1).split()


def test_the_appimage_tools_are_the_pinned_vendor_releases():
    text = _text(SCRIPTS / "build-appimage.sh")
    assert _assigned(text, "APPIMAGETOOL_URL") == (
        "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
    )
    assert _assigned(text, "RUNTIME_URL") == (
        "https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64"
    )
    assert _assigned(text, "QUICK_SHARUN_URL") == (
        "https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/"
        "5d00649d56d4196e59a632bd47d1660d1ee4acfa/useful-tools/quick-sharun.sh"
    )
    assert _assigned(text, "QUICK_SHARUN_SHA256") == "8026711b271c0d67d37075cd7e8c50dbd9fa635c012f9edb92a2c0d41573664b"
    assert _assigned(text, "SHARUN_URL").endswith(
        "/Anylinux-sharun/releases/download/3.5.0/sharun+helper-libs-x86_64.tar")
    assert _assigned(text, "CROSS_LIBC_DLOPEN_URL").endswith(
        "/cross-libc-dlopen/releases/download/v0.2.7/cross-libc-dlopen-x86_64.tar")
    for name in ("APPIMAGETOOL", "RUNTIME", "QUICK_SHARUN", "SHARUN", "CROSS_LIBC_DLOPEN"):
        assert re.fullmatch(r"[0-9a-f]{64}", _assigned(text, f"{name}_SHA256")), name
        assert re.fullmatch(r"[1-9][0-9]*", _assigned(text, f"{name}_SIZE")), name
    assert not re.search(r"linuxdeploy(?!-plugin-checkrt)", text)
    assert "SKIP_INTEGRITY_CHECKS" not in text
    assert "--make-appimage" not in text
    assert "--comp zstd" in text
    notices = _text(ROOT / "THIRD-PARTY-LICENSES.md")
    assert _assigned(text, "RUNTIME_SHA256") in notices


def test_the_sharun_pin_record_matches_the_build_pins_and_ships_its_notices():
    text = _text(SCRIPTS / "build-appimage.sh")
    module = _packages_module()
    pins = module.load_pins(ROOT / "vendor" / "anylinux-sharun" / "PIN.tsv")
    assert set(pins) == {"sharun", "anylinux.so", "glycin-fix.so", "cross-libc-dlopen.so"}
    for name in ("sharun", "anylinux.so", "glycin-fix.so"):
        assert pins[name]["url"] == _assigned(text, "SHARUN_URL")
        assert pins[name]["tarball_sha256"] == _assigned(text, "SHARUN_SHA256")
    assert pins["cross-libc-dlopen.so"]["url"] == _assigned(text, "CROSS_LIBC_DLOPEN_URL")
    assert pins["cross-libc-dlopen.so"]["tarball_sha256"] == _assigned(text, "CROSS_LIBC_DLOPEN_SHA256")
    for name in _assigned_words(text, "SHARUN_NOTICE_FILES"):
        assert (ROOT / "vendor" / "anylinux-sharun" / name).stat().st_size > 0, name
    notices = _text(ROOT / "THIRD-PARTY-LICENSES.md")
    for pin in pins.values():
        assert pin["file_sha256"] in notices, pin["file"]


def test_the_package_allowlist_names_the_deployed_stack_once():
    module = _packages_module()
    allow = module.load_allowlist(SCRIPTS / "appimage-packages.tsv")
    for package in ("webkit2gtk-4.1", "gtk3", "glibc", "ghostscript", "tzdata", "libayatana-appindicator",
                    "bubblewrap", "xdg-dbus-proxy", "mesa"):
        assert package in allow, package
    lines = _text(SCRIPTS / "appimage-packages.tsv").splitlines()
    names = [line.split("\t")[0] for line in lines[1:]]
    assert names == sorted(names)
    assert all(line.count("\t") == 1 for line in lines)
    arch = _assigned_words(_text(SCRIPTS / "build-appimage.sh"), "ARCH_PACKAGES")
    for package in ("webkit2gtk-4.1", "gtk3", "libayatana-appindicator", "ghostscript", "tzdata",
                    "bubblewrap", "xdg-dbus-proxy", "licenses"):
        assert package in arch, package


@pytest.mark.parametrize(
    "rel, owned, expected",
    [
        ("lib/libgtk-3.so.0.2400.0", {"/usr/lib/libgtk-3.so.0.2400.0": "gtk3"}, "gtk3"),
        ("shared/bin/gs", {"/usr/bin/gs": "ghostscript"}, "ghostscript"),
        ("share/zoneinfo/UTC", {"/usr/share/zoneinfo/UTC": "tzdata"}, "tzdata"),
        ("lib/gio/modules/giomodule.cache", {}, "glib2"),
    ],
)
def test_the_generator_attributes_a_deployed_file_to_its_package(tmp_path, rel, owned, expected):
    module = _packages_module()
    target = tmp_path / rel
    target.parent.mkdir(parents=True)
    target.write_bytes(b"x")
    pins = module.load_pins(ROOT / "vendor" / "anylinux-sharun" / "PIN.tsv")
    rows, problems = module.survey(tmp_path, pins, owned)
    assert problems == []
    assert [(r, s) for r, s, _ in rows] == [(rel, expected)]


def test_the_generator_refuses_an_unowned_file_and_a_changed_pinned_file(tmp_path):
    module = _packages_module()
    (tmp_path / "lib" / "sharun-preload").mkdir(parents=True)
    (tmp_path / "lib" / "sharun-preload" / "anylinux.so").write_bytes(b"not the pinned file")
    (tmp_path / "lib" / "libstray.so.1").write_bytes(b"x")
    (tmp_path / "lib" / "spectrapdf").mkdir()
    (tmp_path / "lib" / "spectrapdf" / "payload.so").write_bytes(b"x")
    pins = module.load_pins(ROOT / "vendor" / "anylinux-sharun" / "PIN.tsv")
    rows, problems = module.survey(tmp_path, pins, {})
    assert rows == []
    assert any("anylinux.so: SHA-256" in p for p in problems)
    assert any("libstray.so.1: no installed package owns it" in p for p in problems)
    assert not any("payload.so" in p for p in problems)


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
    names = _assigned_words(text, "RUNTIME_NOTICE_FILES")
    assert len(names) == 7
    for name in names:
        assert (ROOT / "vendor" / "appimage-runtime" / name).stat().st_size > 0, name


def test_the_build_restores_the_program_and_adds_the_payload_after_deployment():
    text = _text(SCRIPTS / "build-appimage.sh")
    deploy = text.index('timeout "$DEPLOY_TIMEOUT" sh "$QUICK_SHARUN"')
    assert text.index('cmp "$DEB_BIN" "$APPDIR/shared/bin/spectrapdf"') > deploy
    assert text.index('cp -a "$PAYLOAD" "$APPDIR/lib/spectrapdf"') > deploy
    assert "NO_STRIP=1" in text
    assert 'sh "$CONTENTS_GATE" "$OUT_DIR/$NAME" --deb "$DEB"' in text


def test_the_contents_gate_checks_relocation_payload_and_libraries():
    gate = _text(SCRIPTS / "verify-appimage-contents.sh")
    for needle in ("lib/libwebkit2gtk-4.1.so.0", "bin/01-path-mapping-hardcoded.hook", 'LOADER_NAME="ld-linux-x86-64.so.2"',
                   "lib/libc.so.6", "share/zoneinfo/UTC", "Resource/Init/gs_init.ps", "(NEEDED)",
                   "shared/bin/spectrapdf differs", 'WEBKIT_MINIMUM="', "fix-namespaces", '"0600"',
                   '--inhibit-cache --library-path "$2" --list', "--deb-payload", "payload-hashes",
                   "lib/python-launcher/python3"):
        assert needle in gate, needle
    assert "SPECTRA_GLIBC_FLOOR" not in _text(SCRIPTS / "build-appimage.sh")


def test_the_release_build_refuses_unsigned_packages():
    text = _text(SCRIPTS / "linux-release-build.sh")
    assert 'die "a release build needs TAURI_SIGNING_RPM_KEY' in text
    assert 'rpmkeys -Kv "$RPM"' in text
    assert "build-appimage.sh" not in text.split('. "$(dirname "$0")/posix-common.sh"', 1)[1]
    appimage = _text(SCRIPTS / "build-appimage.sh")
    assert 'die "a release build needs TAURI_SIGNING_PRIVATE_KEY' in appimage
    assert "npx" not in appimage
    assert '[ "$got" = "$integrity" ] || die' in appimage
    assert "for pkg in cli cli-linux-x64-gnu; do" in appimage
    assert 'node "$tauri" signer sign "$OUT_DIR/$NAME"' in appimage
    assert 'sh "$REPO_ROOT/scripts/verify-appimage-contents.sh" --deb-payload "$work/deb"' in text
    key = _text(ROOT / "keys" / "spectrapdf-rpm-signing.pub.asc")
    assert key.startswith("-----BEGIN PGP PUBLIC KEY BLOCK-----")
    assert "PRIVATE" not in key
    verifier = _text(SCRIPTS / "verify-rpm-signature.sh")
    fingerprint = _assigned(verifier, "FINGERPRINT")
    assert fingerprint == "5cc064b7833ab9d7404ff1366a868e9e98076374"
    assert fingerprint.endswith(_assigned(verifier, "KEY_ID"))


def test_the_bare_system_steps_mirror_the_catalog():
    smoke = _text(SCRIPTS / "linux-install-smoke.sh")
    assert "--bare-cli)" in smoke and "--expect-missing-webkit" not in smoke
    gate = _text(SCRIPTS / "appimage-catalog-gate.sh")
    for needle in ("firejail --quiet --noprofile --net=none --appimage", "WEBKIT_DISABLE_DMABUF_RENDERER=1",
                   "WEBKIT_DISABLE_COMPOSITING_MODE=1", "xdotool search --onlyvisible --name '.'",
                   "$(seq 1 20)", "sleep 10", "X-AppImage-Self-Contained=true", "check-screenshot.sh",
                   "800x600x24"):
        assert needle in gate, needle
    pinned = re.findall(r" (\$\S+|https://\S+) ([0-9a-f]{64})\"?$", gate, re.M)
    assert len(pinned) == 9
    assert 'sysctl -w vm.mmap_min_addr="$MMAP_MIN_ADDR"' in gate
    assert "appstreamcli-x86_64.AppImage convert" in gate
    assert not [url for url, _ in pinned if "/master/" in url]


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



def test_every_pinned_python_runtime_notice_has_a_notice_row():
    pinned = sorted((SCRIPTS / "python-linux-licenses").iterdir())
    assert {f.name for f in pinned} == {"LICENSE.zstd.txt", "LICENSE.zlib-ng.txt"}
    notices = _text(ROOT / "THIRD-PARTY-LICENSES.md")
    for f in pinned:
        assert f"`python/licenses/{f.name}`" in notices
        assert f.read_text(encoding="utf-8").strip()
    text = _text(SCRIPTS / "setup-python-embed.sh")
    assert '"$REPO_ROOT/scripts/python-linux-licenses"' in text
    assert 'sys.exit("no licence text for: "' in text

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
