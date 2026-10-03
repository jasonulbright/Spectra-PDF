#!/usr/bin/env python3
"""Attributes every file the AppImage carries outside its payload.

  appimage-packages.py --lint ALLOWLIST --pins PIN.tsv
  appimage-packages.py --appdir DIR --allowlist ALLOWLIST --pins PIN.tsv
                       --manifest OUT.tsv --licenses DIR

Build mode reads the Arch package database of the build host, writes the
per-build manifest (file, source, version, url, sha256) and copies each
package's notices into DIR. It refuses a file that no installed package owns
and no rule below names, a file owned by a package missing from ALLOWLIST, a
listed notice the host lacks, and a pinned sharun file whose hash differs.
"""

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

PAYLOAD = "lib/spectrapdf"
PAYLOAD_LINK = "usr/lib/spectrapdf"
LICENSES_ROOT = Path("/usr/share/licenses")
PACKAGE_NAME = re.compile(r"^[a-z0-9@._+][a-z0-9@._+-]*$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
# Older Arch packages name licences without SPDX identifiers; the licenses
# package ships texts under SPDX file names only.
LEGACY_LICENSE_NAMES = {
    "GPL": "GPL-2.0-only",
    "GPL2": "GPL-2.0-only",
    "GPL3": "GPL-3.0-only",
    "LGPL": "LGPL-2.1-only",
    "LGPL2.1": "LGPL-2.1-only",
    "LGPL3": "LGPL-3.0-only",
    "AGPL3": "AGPL-3.0-only",
    "MPL2": "MPL-2.0",
    "APACHE": "Apache-2.0",
}

# Spectra's own files: the .deb's binary, desktop entry, icons, AppStream
# file, documentation, and the start script, start hook, the LibreOffice and
# Python launchers and the exec library built from src-tauri/linux.
OWN_EXACT = {
    "spectrapdf.desktop",
    "spectrapdf.png",
    "shared/bin/spectrapdf",
    "bin/10-webkit-sandbox.hook",
    "lib/libreoffice-launcher/program/soffice",
    "lib/python-launcher/python3",
    "lib/image-exec/image-exec.so",
    "AppRun.sh",
    "usr/share/applications/spectrapdf.desktop",
    "usr/share/metainfo/com.spectrapdf.app.appdata.xml",
}
OWN_PREFIXES = ("usr/share/icons/hicolor/", "usr/share/doc/spectrapdf/")

# Files quick-sharun writes from its own text.
TOOL_EXACT = {
    "AppRun.lib",
    ".env",
    "lib/lib.path",
    "shared/lib/lib.path",
    "bin/01-path-mapping-hardcoded.hook",
    "bin/01-check-ca-certs.hook",
    "etc/ssl/openssl.cnf",
}

# Files the deployment generates from one package's data; the build host keeps
# the same files outside its package database (pacman hooks or localedef).
GENERATED = [
    (re.compile(r"^lib/gdk-pixbuf-2\.0/[^/]+/loaders\.cache$"), "gdk-pixbuf2"),
    (re.compile(r"^lib/gio/modules/giomodule\.cache$"), "glib2"),
    (re.compile(r"^lib/gtk-3\.0/[^/]+/immodules\.cache$"), "gtk3"),
    (re.compile(r"^lib/locale/en_US\.utf8/"), "glibc"),
    (re.compile(r"^lib/locale/C\.utf8/"), "glibc"),
    (re.compile(r"^share/mime/"), "shared-mime-info"),
    (re.compile(r"^share/icons/hicolor/icon-theme\.cache$"), "hicolor-icon-theme"),
    (re.compile(r"^share/glib-2\.0/schemas/gschemas\.compiled$"), "glib2"),
    (re.compile(r"^share/fonts/.*/fonts\.(dir|scale)$"), "xorg-mkfontscale"),
]


def die(message: str) -> None:
    sys.exit(f"error: {message}")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def read_tsv(path: Path, header: list) -> list:
    rows = []
    seen_header = False
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        fields = line.split("\t")
        if not seen_header:
            if fields != header:
                die(f"{path}:{number}: the header must be {' / '.join(header)}")
            seen_header = True
            continue
        if len(fields) != len(header):
            die(f"{path}:{number}: expected {len(header)} tab-separated fields")
        rows.append(dict(zip(header, fields)))
    if not seen_header:
        die(f"{path}: no header row")
    return rows


def load_allowlist(path: Path) -> dict:
    allow = {}
    for row in read_tsv(path, ["package", "notices"]):
        name = row["package"]
        if not PACKAGE_NAME.match(name):
            die(f"{path}: '{name}' is not an Arch package name")
        if name in allow:
            die(f"{path}: '{name}' is listed twice")
        notices = [n for n in row["notices"].split(",") if n]
        if not notices or any(n.startswith("/") or ".." in Path(n).parts for n in notices):
            die(f"{path}: '{name}' needs notices relative to {LICENSES_ROOT}")
        allow[name] = notices
    if not allow:
        die(f"{path}: no packages")
    return allow


def load_pins(path: Path) -> dict:
    pins = {}
    header = ["file", "version", "url", "tarball_sha256", "file_sha256", "notices"]
    for row in read_tsv(path, header):
        for key in ("tarball_sha256", "file_sha256"):
            if not SHA256.match(row[key]):
                die(f"{path}: {row['file']} {key} is not 64 hex characters")
        if not row["url"].startswith("https://"):
            die(f"{path}: {row['file']} url is not https")
        for notice in row["notices"].split(","):
            if not (path.parent / notice).is_file():
                die(f"{path}: {row['file']} names notice {notice}, which is not in {path.parent}")
        pins[row["file"]] = row
    for required in ("sharun", "anylinux.so", "cross-libc-dlopen.so"):
        if required not in pins:
            die(f"{path}: no row for {required}")
    return pins


def pacman_files() -> dict:
    owner = {}
    out = subprocess.run(["pacman", "-Ql"], check=True, capture_output=True, text=True).stdout
    for line in out.splitlines():
        package, _, path = line.partition(" ")
        if path and not path.endswith("/"):
            owner[path] = package
    return owner


def pacman_info(packages: list) -> dict:
    info = {}
    out = subprocess.run(["pacman", "-Qi", *packages], check=True, capture_output=True, text=True).stdout
    current = {}
    for line in out.splitlines() + [""]:
        if not line.strip():
            if current.get("Name"):
                info[current["Name"]] = current
            current = {}
            continue
        key, sep, value = line.partition(":")
        if sep and not line.startswith(" "):
            current[key.strip()] = value.strip()
    return info


def proposed_notices(package: str, meta: dict) -> list:
    found = []
    own = LICENSES_ROOT / package
    if own.is_dir() and any(own.iterdir()):
        found.append(package)
    for token in re.split(r"[\s()]+", meta.get("Licenses", "")):
        notice = f"spdx/{LEGACY_LICENSE_NAMES.get(token, token)}.txt"
        if token and notice not in found and (LICENSES_ROOT / notice).is_file():
            found.append(notice)
    return found


def host_candidates(rel: str, by_name: dict) -> list:
    parts = rel.split("/", 1)
    if rel.startswith("shared/bin/"):
        name = rel[len("shared/bin/"):]
        found = [f"/usr/bin/{name}"]
        found += sorted(p for p in by_name.get(name, []) if p.startswith("/usr/lib/"))
        return found
    if len(parts) != 2:
        return []
    prefix = {"lib": "/usr/lib/", "share": "/usr/share/", "etc": "/etc/", "bin": "/usr/bin/"}.get(parts[0])
    return [prefix + parts[1]] if prefix else []


def survey(appdir: Path, pins: dict, owner: dict) -> tuple:
    by_name = {}
    for path in owner:
        by_name.setdefault(os.path.basename(path), []).append(path)
    sharun_sha = pins["sharun"]["file_sha256"]
    rows = []
    problems = []
    for root, dirs, files in os.walk(appdir):
        rel_root = os.path.relpath(root, appdir).replace(os.sep, "/")
        rel_root = "" if rel_root == "." else rel_root + "/"
        dirs[:] = sorted(d for d in dirs if f"{rel_root}{d}" not in (PAYLOAD, PAYLOAD_LINK))
        for name in sorted(files):
            rel = f"{rel_root}{name}"
            path = appdir / rel
            if path.is_symlink() or rel == PAYLOAD_LINK:
                continue
            digest = sha256_of(path)
            if rel in OWN_EXACT or rel.startswith(OWN_PREFIXES):
                continue
            if digest == sharun_sha:
                rows.append((rel, "pin:sharun", digest))
                continue
            if rel.startswith("lib/sharun-preload/"):
                pin = pins.get(name)
                if pin is None:
                    problems.append(f"{rel}: a sharun helper library with no row in PIN.tsv")
                elif digest != pin["file_sha256"]:
                    problems.append(f"{rel}: SHA-256 {digest} differs from the PIN.tsv row")
                else:
                    rows.append((rel, f"pin:{name}", digest))
                continue
            if rel in TOOL_EXACT:
                rows.append((rel, "tool:quick-sharun", digest))
                continue
            package = None
            for candidate in host_candidates(rel, by_name):
                for host_path in (candidate, os.path.realpath(candidate)):
                    if host_path in owner:
                        package = owner[host_path]
                        break
                if package is not None:
                    break
            if package is None:
                package = next((p for rule, p in GENERATED if rule.search(rel)), None)
            if package is None:
                problems.append(f"{rel}: no installed package owns it and no rule names it")
                continue
            rows.append((rel, package, digest))
    return rows, problems


def build(args) -> None:
    appdir = Path(args.appdir)
    allow = load_allowlist(Path(args.allowlist))
    pins_path = Path(args.pins)
    pins = load_pins(pins_path)
    rows, problems = survey(appdir, pins, pacman_files())
    packages = sorted({source for _, source, _ in rows if ":" not in source})
    info = pacman_info(packages) if packages else {}
    for package in packages:
        if package not in allow:
            files = [rel for rel, source, _ in rows if source == package]
            row = f"{package}\t{','.join(proposed_notices(package, info.get(package, {})))}"
            problems.append(f"package {package} is not in {args.allowlist} ({len(files)} files, e.g. {files[0]}); "
                            f"its row from this host's notices: {row!r}")
    licenses = Path(args.licenses)
    if licenses.exists():
        shutil.rmtree(licenses)
    for package in packages:
        for notice in allow.get(package, []):
            source = LICENSES_ROOT / notice
            target = licenses / package / notice
            if source.is_dir():
                shutil.copytree(source, target, symlinks=False)
            elif source.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
            else:
                problems.append(f"package {package}: notice {source} is not on this host")
    if problems:
        die("the AppImage contents are not attributed:\n  " + "\n  ".join(problems))
    unused = sorted(set(allow) - set(packages))
    lines = ["file\tsource\tversion\turl\tsha256"]
    for rel, source, digest in rows:
        if source.startswith("pin:"):
            pin = pins[source[4:]]
            lines.append(f"{rel}\t{source[4:]}\t{pin['version']}\t{pin['url']}\t{digest}")
        elif source.startswith("tool:"):
            lines.append(f"{rel}\tquick-sharun\t-\t-\t{digest}")
        else:
            meta = info[source]
            lines.append(f"{rel}\t{source}\t{meta.get('Version', '-')}\t{meta.get('URL', '-')}\t{digest}")
    manifest = Path(args.manifest)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"appimage-packages: {len(rows)} files from {len(packages)} Arch packages and the pinned sharun files; "
          f"manifest {manifest.name}")
    if unused:
        print(f"appimage-packages: listed but not deployed: {', '.join(unused)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lint")
    parser.add_argument("--appdir")
    parser.add_argument("--allowlist")
    parser.add_argument("--pins", required=True)
    parser.add_argument("--manifest")
    parser.add_argument("--licenses")
    args = parser.parse_args()
    if args.lint:
        allow = load_allowlist(Path(args.lint))
        load_pins(Path(args.pins))
        print(f"appimage-packages --lint: {len(allow)} packages, pins well-formed")
        return
    if not (args.appdir and args.allowlist and args.manifest and args.licenses):
        die("build mode needs --appdir, --allowlist, --manifest and --licenses")
    build(args)


if __name__ == "__main__":
    main()
