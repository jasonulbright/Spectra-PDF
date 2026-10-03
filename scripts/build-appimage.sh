#!/bin/sh
# Builds the self-contained Linux AppImage from the built .deb, on an Arch Linux
# host. quick-sharun deploys the application's WebKitGTK and GTK stack, the tray
# library, Ghostscript, the time zone database and the C library from the
# host's Arch packages, and makes sharun the AppRun: sharun starts every
# deployed program on the deployed dynamic loader. The .deb's payload
# (usr/lib/spectrapdf) is added after deployment, byte for byte; its Python,
# LibreOffice and every program the engine starts run on that same loader
# through lib/python-launcher, lib/libreoffice-launcher and
# engine/platform_support.py, so no host C library is used. appimagetool
# and the type-2 runtime pack the AppDir as SquashFS (zstd). Every tool is the
# vendor's released file, pinned by URL, SHA-256 and size.
#
# What the deployment rewrites inside the image:
#   lib/libwebkit2gtk-4.1.so.*: the compiled-in /usr/lib and /usr/bin become
#     /tmp/<3 characters> of the same length; bin/01-path-mapping-hardcoded.hook
#     links those names to the image at start, so the host needs a writable /tmp.
#   every deployed library and program: an absolute RUNPATH is removed and an
#     absolute NEEDED entry is reduced to its file name.
#   every program in shared/bin that holds a /usr/share/... or /usr/lib/...
#     string (gs among them) is patched the same way. shared/bin/spectrapdf is
#     then restored from the .deb and compared byte for byte.
#   loaders.cache, immodules.cache and the glvnd and Vulkan JSON files lose
#     their absolute directories.
# Nothing is stripped. The payload, the desktop entry, the icons and the
# AppStream file are not rewritten.
#
#   sh scripts/build-appimage.sh [--deb FILE] [--out DIR] [--release]
#   sh scripts/build-appimage.sh --install-packages   pacman installs ARCH_PACKAGES (root)
#   sh scripts/build-appimage.sh --prepare            fetch and verify the pinned tools
#   sh scripts/build-appimage.sh --check              lint the inputs; no download, no build
#
# Output in DIR (default <target>/release/bundle/appimage): the AppImage, its
# .zsync and, when TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD) is set, its updater
# .sig. --release refuses to finish without that key.
# SPECTRA_APPIMAGE_UPDATE_INFO overrides the embedded update information; an
# empty value embeds none.

. "$(dirname "$0")/posix-common.sh"

APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
APPIMAGETOOL_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
APPIMAGETOOL_SIZE="15092216"
RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64"
RUNTIME_SHA256="2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"
RUNTIME_SIZE="944632"
QUICK_SHARUN_URL="https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/5d00649d56d4196e59a632bd47d1660d1ee4acfa/useful-tools/quick-sharun.sh"
QUICK_SHARUN_SHA256="8026711b271c0d67d37075cd7e8c50dbd9fa635c012f9edb92a2c0d41573664b"
QUICK_SHARUN_SIZE="169744"
# quick-sharun downloads these two itself and refuses other hashes; they are
# fetched here first so every download goes through the same verified cache.
SHARUN_URL="https://github.com/pkgforge-dev/Anylinux-sharun/releases/download/3.5.0/sharun+helper-libs-x86_64.tar"
SHARUN_SHA256="a84935e91826cc38834f35eee099269ab643f97a47d3aaf5c171d87fda3d3c1f"
SHARUN_SIZE="419840"
CROSS_LIBC_DLOPEN_URL="https://github.com/pkgforge-dev/cross-libc-dlopen/releases/download/v0.2.7/cross-libc-dlopen-x86_64.tar"
CROSS_LIBC_DLOPEN_SHA256="5b4a9c799b4875e7687b9b4158105a64056031c6c8a8719cbf00fa20839c9cf3"
CROSS_LIBC_DLOPEN_SIZE="993280"

# The Arch packages float: each build deploys the versions current that day.
# scripts/appimage-packages.tsv is the committed set of packages the image may
# contain files from.
ARCH_PACKAGES="webkit2gtk-4.1 gtk3 libayatana-appindicator librsvg ghostscript tzdata
bubblewrap xdg-dbus-proxy patchelf strace xorg-server-xvfb xorg-xauth binutils libarchive
python nodejs licenses diffutils libheif appstream gcc"

# AppImage update information (AppImageSpec, "update information"): the
# release page's newest .zsync file. appimagetool writes the .zsync beside the
# AppImage with its bundled zsyncmake. The application never reads it.
UPDATE_INFO_DEFAULT="gh-releases-zsync|jasonulbright|Spectra-PDF|latest|spectrapdf_*_amd64.AppImage.zsync"
UPDATE_INFO="${SPECTRA_APPIMAGE_UPDATE_INFO-$UPDATE_INFO_DEFAULT}"

LINUX_DIR="$REPO_ROOT/src-tauri/linux"
DESKTOP="$LINUX_DIR/spectrapdf.desktop"
METAINFO="$LINUX_DIR/com.spectrapdf.app.appdata.xml"
SANDBOX_HOOK="$LINUX_DIR/webkit-sandbox.hook"
OFFICE_LAUNCHER="$LINUX_DIR/libreoffice-launcher"
PYTHON_LAUNCHER="$LINUX_DIR/python-launcher"
APPRUN_SCRIPT="$LINUX_DIR/AppRun.sh"
IMAGE_EXEC_SOURCE="$LINUX_DIR/image-exec.c"
IMAGE_EXEC_TRAMPOLINE_SOURCE="$LINUX_DIR/image-exec-trampoline.c"
ICON="$REPO_ROOT/src-tauri/icons/128x128@2x.png"
RUNTIME_NOTICES="$REPO_ROOT/vendor/appimage-runtime"
RUNTIME_NOTICE_FILES="LICENSE-type2-runtime.txt LICENSE-libfuse-LGPL-2.1.txt LICENSE-squashfuse.txt
LICENSE-zstd.txt LICENSE-zlib.txt COPYRIGHT-musl.txt LICENSE-mimalloc.txt"
SHARUN_NOTICES="$REPO_ROOT/vendor/anylinux-sharun"
SHARUN_NOTICE_FILES="LICENSE-sharun.txt LICENSE-cross-libc-dlopen.txt LICENSE-linuxdeploy-plugin-checkrt.txt"
PACKAGES_TSV="$REPO_ROOT/scripts/appimage-packages.tsv"
PACKAGES_PY="$REPO_ROOT/scripts/appimage-packages.py"
CONTENTS_GATE="$REPO_ROOT/scripts/verify-appimage-contents.sh"
TOOL_DIR="$LINUX_RESOURCES/.build/appimagetool-1.9.1"
TARGET_ROOT="${CARGO_TARGET_DIR:-$REPO_ROOT/src-tauri/target}"
FIXTURE="$REPO_ROOT/tests/fixtures/sample.pdf"
DEPLOY_TIMEOUT=1800

pins_well_formed() {
  for name in APPIMAGETOOL RUNTIME QUICK_SHARUN SHARUN CROSS_LIBC_DLOPEN; do
    eval "sha=\$${name}_SHA256 size=\$${name}_SIZE"
    printf '%s\n' "$sha" | grep -Eqx '[0-9a-f]{64}' || die "$name SHA-256 pin is not 64 hex characters"
    printf '%s\n' "$size" | grep -Eqx '[1-9][0-9]*' || die "$name size pin is not a byte count"
  done
}

# fetch_tool URL SHA256 SIZE NAME -> the cached path, size-checked.
fetch_tool() {
  path="$(fetch_verified "$1" "$2" "$4")"
  got="$(wc -c < "$path" | tr -d ' ')"
  [ "$got" = "$3" ] || die "$4 is $got bytes; the pin is $3"
  echo "$path"
}

# prepare_tools: fetches every pinned tool and unpacks appimagetool once. Its
# bundled mksquashfs, zsyncmake and desktop-file-validate are static, so no
# host FUSE or package is needed and the same validator runs everywhere.
prepare_tools() {
  tool="$(fetch_tool "$APPIMAGETOOL_URL" "$APPIMAGETOOL_SHA256" "$APPIMAGETOOL_SIZE" "appimagetool-1.9.1-x86_64.AppImage")"
  RUNTIME_FILE="$(fetch_tool "$RUNTIME_URL" "$RUNTIME_SHA256" "$RUNTIME_SIZE" "type2-runtime-20251108-x86_64")"
  QUICK_SHARUN="$(fetch_tool "$QUICK_SHARUN_URL" "$QUICK_SHARUN_SHA256" "$QUICK_SHARUN_SIZE" "quick-sharun-5d00649d.sh")"
  SHARUN_TAR="$(fetch_tool "$SHARUN_URL" "$SHARUN_SHA256" "$SHARUN_SIZE" "sharun-3.5.0+helper-libs-x86_64.tar")"
  CROSS_LIBC_DLOPEN_TAR="$(fetch_tool "$CROSS_LIBC_DLOPEN_URL" "$CROSS_LIBC_DLOPEN_SHA256" "$CROSS_LIBC_DLOPEN_SIZE" "cross-libc-dlopen-v0.2.7-x86_64.tar")"
  grep -qx "		SHARUN_SHA=$SHARUN_SHA256" "$QUICK_SHARUN" || die "the pinned quick-sharun names another sharun"
  grep -qx "		CROSS_LIBC_DLOPEN_TAR_SHA=$CROSS_LIBC_DLOPEN_SHA256" "$QUICK_SHARUN" ||
    die "the pinned quick-sharun names another cross-libc-dlopen"
  if [ "$(cat "$TOOL_DIR/.artifact-sha256" 2>/dev/null)" != "$APPIMAGETOOL_SHA256" ]; then
    rm -rf "$TOOL_DIR" "$TOOL_DIR.stage"
    mkdir -p "$TOOL_DIR.stage"
    cp "$tool" "$TOOL_DIR.stage/appimagetool.AppImage"
    chmod 0755 "$TOOL_DIR.stage/appimagetool.AppImage"
    (cd "$TOOL_DIR.stage" && ./appimagetool.AppImage --appimage-extract >/dev/null) ||
      die "the pinned appimagetool did not unpack"
    rm -f "$TOOL_DIR.stage/appimagetool.AppImage"
    printf '%s\n' "$APPIMAGETOOL_SHA256" > "$TOOL_DIR.stage/.artifact-sha256"
    mv "$TOOL_DIR.stage" "$TOOL_DIR"
  fi
  APPIMAGETOOL="$TOOL_DIR/squashfs-root/AppRun"
  DESKTOP_VALIDATE="$TOOL_DIR/squashfs-root/usr/bin/desktop-file-validate"
  [ -x "$APPIMAGETOOL" ] && [ -x "$DESKTOP_VALIDATE" ] || die "the unpacked appimagetool lacks AppRun or desktop-file-validate"
}

# install_locked_tauri_cli DIR -> the path of the Tauri CLI's tauri.js. The
# CLI and its Linux binary come from the package-lock.json `resolved` URLs and
# are refused unless their SHA-512 equals the lockfile's `integrity`; no
# package manager resolves anything, so the signing key reaches only the
# locked release.
install_locked_tauri_cli() {
  for pkg in cli cli-linux-x64-gnu; do
    meta="$(python3 -c '
import json, sys
entry = json.load(open(sys.argv[1], encoding="utf-8"))["packages"]["node_modules/@tauri-apps/" + sys.argv[2]]
print(entry["resolved"], entry["integrity"])
' "$REPO_ROOT/package-lock.json" "$pkg")" || die "package-lock.json has no locked @tauri-apps/$pkg"
    url="${meta% *}"; integrity="${meta#* }"
    case "$integrity" in sha512-*) ;; *) die "@tauri-apps/$pkg is not locked by SHA-512" ;; esac
    mkdir -p "$1/node_modules/@tauri-apps/$pkg"
    curl -fsSL --retry 3 -o "$1/$pkg.tgz" "$url" >&2 || die "download failed: $url"
    got="$(python3 -c '
import base64, hashlib, sys
print("sha512-" + base64.b64encode(hashlib.sha512(open(sys.argv[1], "rb").read()).digest()).decode())
' "$1/$pkg.tgz")"
    [ "$got" = "$integrity" ] || die "@tauri-apps/$pkg is $got; package-lock.json locks $integrity"
    tar -xzf "$1/$pkg.tgz" -C "$1/node_modules/@tauri-apps/$pkg" --strip-components=1 ||
      die "@tauri-apps/$pkg did not unpack"
  done
  [ -f "$1/node_modules/@tauri-apps/cli/tauri.js" ] || die "the locked @tauri-apps/cli carries no tauri.js"
  echo "$1/node_modules/@tauri-apps/cli/tauri.js"
}

# lint_inputs VALIDATOR:the desktop entry validates, the start hook parses,
# the notices are present, the package allowlist is well formed.
lint_inputs() {
  if grep -q "$(printf '\r')" "$DESKTOP" "$METAINFO" "$SANDBOX_HOOK" "$OFFICE_LAUNCHER" "$PYTHON_LAUNCHER" "$APPRUN_SCRIPT" "$IMAGE_EXEC_SOURCE"; then
    die "a Linux packaging input has CR line endings"
  fi
  "$1" "$DESKTOP" || die "desktop-file-validate refused $DESKTOP"
  grep -qx 'Exec=spectrapdf %F' "$DESKTOP" || die "$DESKTOP must run 'spectrapdf %F'"
  grep -qx 'Icon=spectrapdf' "$DESKTOP" || die "$DESKTOP must name the icon spectrapdf"
  [ "$(grep -c '^Icon=' "$DESKTOP")" = 1 ] && [ "$(grep -c '^Categories=' "$DESKTOP")" = 1 ] ||
    die "$DESKTOP must carry Icon and Categories exactly once"
  grep -q '<launchable type="desktop-id">spectrapdf.desktop</launchable>' "$METAINFO" ||
    die "$METAINFO must launch spectrapdf.desktop"
  sh -n "$SANDBOX_HOOK" || die "$SANDBOX_HOOK does not parse"
  sh -n "$OFFICE_LAUNCHER" || die "$OFFICE_LAUNCHER does not parse"
  sh -n "$PYTHON_LAUNCHER" || die "$PYTHON_LAUNCHER does not parse"
  sh -n "$APPRUN_SCRIPT" || die "$APPRUN_SCRIPT does not parse"
  for f in $RUNTIME_NOTICE_FILES; do
    [ -s "$RUNTIME_NOTICES/$f" ] || die "runtime notice missing: vendor/appimage-runtime/$f"
  done
  for f in $SHARUN_NOTICE_FILES PIN.tsv; do
    [ -s "$SHARUN_NOTICES/$f" ] || die "sharun notice missing: vendor/anylinux-sharun/$f"
  done
  python3 "$PACKAGES_PY" --lint "$PACKAGES_TSV" --pins "$SHARUN_NOTICES/PIN.tsv" ||
    die "scripts/appimage-packages.tsv or vendor/anylinux-sharun/PIN.tsv is malformed"
}

case "${1:-}" in
  --check)
    require_tool python3
    pins_well_formed
    validator="$TOOL_DIR/squashfs-root/usr/bin/desktop-file-validate"
    if [ ! -x "$validator" ]; then
      validator="$(command -v desktop-file-validate || true)"
    fi
    [ -n "$validator" ] || die "no desktop-file-validate: run 'sh scripts/build-appimage.sh --prepare' once"
    lint_inputs "$validator"
    sh -n "$CONTENTS_GATE" || die "$CONTENTS_GATE does not parse"
    echo "build-appimage --check: pins well-formed, desktop entry valid, start hook parses, notices present, package allowlist well-formed"
    exit 0
    ;;
  --prepare)
    require_tool curl sha256sum python3
    pins_well_formed
    prepare_tools
    lint_inputs "$DESKTOP_VALIDATE"
    echo "Done. appimagetool 1.9.1, the type-2 runtime 20251108, quick-sharun, sharun 3.5.0 and cross-libc-dlopen v0.2.7 verified"
    exit 0
    ;;
  --install-packages)
    require_tool pacman
    [ "$(id -u)" = 0 ] || die "--install-packages runs pacman and needs root"
    # The official archlinux base image extracts no documentation, translations
    # or locale sources (NoExtract); the AppImage needs the notices, translations
    # and locale data under those paths, so every package missing files is
    # reinstalled.
    sed -i 's/^NoExtract/#NoExtract/' /etc/pacman.conf || die "cannot edit /etc/pacman.conf"
    # shellcheck disable=SC2086
    pacman -Syu --noconfirm --needed $ARCH_PACKAGES || die "pacman could not install the AppImage build packages"
    missing="$(pacman -Qkq 2>/dev/null | cut -d' ' -f1 | sort -u)"
    if [ -n "$missing" ]; then
      # shellcheck disable=SC2086
      pacman -S --noconfirm $missing || die "pacman could not reinstall the packages that miss files"
    fi
    left="$(pacman -Qkq 2>/dev/null | cut -d' ' -f1 | sort -u)"
    [ -z "$left" ] || die "these packages still miss files: $left"
    exit 0
    ;;
esac

DEB=""
OUT_DIR="$TARGET_ROOT/release/bundle/appimage"
RELEASE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --deb) DEB="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --release) RELEASE=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
if [ -z "$DEB" ]; then
  set -- "$TARGET_ROOT"/release/bundle/deb/spectrapdf_*_amd64.deb
  [ $# -eq 1 ] && [ -f "$1" ] || die "expected exactly one spectrapdf_*_amd64.deb in $TARGET_ROOT/release/bundle/deb"
  DEB="$1"
fi
[ -f "$DEB" ] || die "no .deb at $DEB"
DEB="$(cd "$(dirname "$DEB")" && pwd)/$(basename "$DEB")"
if [ "$RELEASE" -eq 1 ]; then
  [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || die "a release build needs TAURI_SIGNING_PRIVATE_KEY (updater signature)"
fi

require_tool curl sha256sum bsdtar readelf objdump objcopy patchelf strace xvfb-run python3 pacman cmp timeout appstreamcli gcc
[ -f /etc/arch-release ] || die "the AppImage deploys Arch Linux packages and builds only on Arch Linux"
pins_well_formed
prepare_tools
lint_inputs "$DESKTOP_VALIDATE"

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
WORK="$OUT_DIR/spectrapdf.appimage-work"
APPDIR="$WORK/AppDir"
DEB_ROOT="$WORK/deb"
rm -rf "$WORK"
mkdir -p "$DEB_ROOT" "$WORK/tmp" "$APPDIR/bin" "$APPDIR/usr/share/doc/spectrapdf"

control="$(bsdtar -xOf "$DEB" 'control.tar*' | bsdtar -xOf - ./control)" || die "$DEB carries no control file"
[ "$(printf '%s\n' "$control" | sed -n 's/^Package: //p')" = "spectrapdf" ] || die "$DEB is not the spectrapdf package"
VERSION="$(printf '%s\n' "$control" | sed -n 's/^Version: //p')"
[ -n "$VERSION" ] || die "$DEB carries no Version"
NAME="spectrapdf_${VERSION}_amd64.AppImage"
bsdtar -xOf "$DEB" 'data.tar*' | bsdtar -xpf - -C "$DEB_ROOT" || die "the .deb payload did not unpack"
DEB_BIN="$DEB_ROOT/usr/bin/spectrapdf"
PAYLOAD="$DEB_ROOT/usr/lib/spectrapdf"
[ -x "$DEB_BIN" ] && [ -f "$PAYLOAD/engine/__startup__.py" ] || die "the .deb lacks usr/bin/spectrapdf or its payload"

# The program is deployed without its payload: quick-sharun runs it to record
# the libraries it opens at run time, and a payload in reach would start the
# engine and copy the payload's own libraries into lib/.
install -m 0755 "$DEB_BIN" "$APPDIR/bin/spectrapdf"
install -m 0644 "$DESKTOP" "$APPDIR/spectrapdf.desktop"
install -m 0755 "$APPRUN_SCRIPT" "$APPDIR/AppRun.sh"
install -m 0644 "$ICON" "$APPDIR/spectrapdf.png"
ln -s spectrapdf.png "$APPDIR/.DirIcon"
for d in applications icons metainfo; do
  mkdir -p "$APPDIR/usr/share/$d"
  cp -a "$DEB_ROOT/usr/share/$d/." "$APPDIR/usr/share/$d/"
done
cp -a "$DEB_ROOT/usr/share/doc/spectrapdf/." "$APPDIR/usr/share/doc/spectrapdf/"
bsdtar -xf "$SHARUN_TAR" -C "$APPDIR" sharun || die "the pinned sharun tarball carries no sharun"
cp "$SHARUN_TAR" "$WORK/tmp/sharun+helper-libs-x86_64.tar"
cp "$CROSS_LIBC_DLOPEN_TAR" "$WORK/tmp/cross-libc-dlopen-x86_64.tar"

# quick-sharun copies /usr/share/ghostscript itself once it deploys libgs.
# It reports a directory it could not copy and carries on, so its output is
# kept and any such report fails the build.
echo "==> quick-sharun"
deploy_status=0
(
  cd "$WORK" &&
  env APPDIR="$APPDIR" TMPDIR="$WORK/tmp" OUTPATH="$WORK" MAIN_BIN=spectrapdf \
    NO_STRIP=1 DEPLOY_OPENGL=1 DEPLOY_DATADIR=0 STRACE_MODE=1 \
    timeout "$DEPLOY_TIMEOUT" sh "$QUICK_SHARUN" "$APPDIR/bin/spectrapdf" \
      /usr/bin/gs /usr/lib/libayatana-appindicator3.so.1 /usr/lib/libcrypt.so.2 \
      /usr/share/zoneinfo
) > "$WORK/quick-sharun.log" 2>&1 || deploy_status=$?
cat "$WORK/quick-sharun.log"
[ "$deploy_status" -eq 0 ] || die "quick-sharun failed"
if grep -E 'Failed to add|cannot overwrite|ERROR' "$WORK/quick-sharun.log"; then
  die "quick-sharun reported a deployment it did not complete"
fi

cmp "$APPRUN_SCRIPT" "$APPDIR/AppRun.sh" || die "quick-sharun replaced AppRun.sh"
[ -f "$APPDIR/bin/01-path-mapping-hardcoded.hook" ] || die "quick-sharun wrote no path-mapping hook: WebKitGTK was not relocated"
# The trace run starts the program from bin/ with no image file, so the
# program keeps its portable data in bin/data.
rm -rf "$APPDIR/bin/data"
# A directory copied with its symbolic links keeps links that name the build
# host (share/ghostscript/Resource/CMap names /usr/share/poppler/cMap); such a
# link dangles on any other host, so its target is copied in its place.
find "$APPDIR" -type l -lname '/*' > "$WORK/absolute-links"
while IFS= read -r link; do
  target="$(readlink "$link")"
  [ -e "$target" ] || die "${link#$APPDIR/} links to $target, which this host lacks"
  rm "$link"
  cp -RL "$target" "$link" || die "could not copy $target into ${link#$APPDIR/}"
done < "$WORK/absolute-links"
[ ! -e "$APPDIR/bin/05-fix-namespaces.hook" ] || die "the image must not carry fix-namespaces.hook"
[ ! -e "$APPDIR/lib/spectrapdf" ] || die "quick-sharun deployed files under lib/spectrapdf"
cp "$DEB_BIN" "$APPDIR/shared/bin/spectrapdf"
cmp "$DEB_BIN" "$APPDIR/shared/bin/spectrapdf" || die "shared/bin/spectrapdf differs from the .deb's usr/bin/spectrapdf"
install -m 0755 "$SANDBOX_HOOK" "$APPDIR/bin/10-webkit-sandbox.hook"

# Tauri and the CLI resolve their resources at <exe dir>/../lib/spectrapdf. The
# program runs as bin/spectrapdf (sharun keeps that path as the executable), so
# that is lib/spectrapdf; shared/bin/../lib reaches the same directory through
# the shared/lib link, and Tauri's $APPDIR fallback is usr/lib/spectrapdf.
cp -a "$PAYLOAD" "$APPDIR/lib/spectrapdf"
mkdir -p "$APPDIR/usr/lib"
ln -s ../../lib/spectrapdf "$APPDIR/usr/lib/spectrapdf"
[ -x "$APPDIR/lib/spectrapdf/libreoffice/program/soffice.bin" ] || die "the payload carries no libreoffice/program/soffice.bin"
mkdir -p "$APPDIR/lib/libreoffice-launcher/program"
install -m 0755 "$OFFICE_LAUNCHER" "$APPDIR/lib/libreoffice-launcher/program/soffice"
ln -s ../spectrapdf/libreoffice/share "$APPDIR/lib/libreoffice-launcher/share"
[ -x "$APPDIR/lib/spectrapdf/python/bin/python3" ] || die "the payload carries no python/bin/python3"
mkdir -p "$APPDIR/lib/python-launcher" "$APPDIR/lib/image-exec"
gcc -shared -fPIC -O2 -Wall -Wextra -Werror -o "$APPDIR/lib/image-exec/image-exec.so" "$IMAGE_EXEC_SOURCE" ||
  die "src-tauri/linux/image-exec.c did not compile"
gcc -static -O2 -Wall -Wextra -Werror -o "$APPDIR/lib/image-exec/image-exec-trampoline" "$IMAGE_EXEC_TRAMPOLINE_SOURCE" ||
  die "src-tauri/linux/image-exec-trampoline.c did not compile"
sh "$REPO_ROOT/scripts/test-image-exec.sh" "$APPDIR/lib/image-exec/image-exec.so" ||
  die "lib/image-exec/image-exec.so failed its regression test"
install -m 0755 "$PYTHON_LAUNCHER" "$APPDIR/lib/python-launcher/python3"

DOC="$APPDIR/usr/share/doc/spectrapdf"
mkdir -p "$DOC/appimage-runtime" "$DOC/anylinux-sharun"
for f in $RUNTIME_NOTICE_FILES; do
  install -m 0644 "$RUNTIME_NOTICES/$f" "$DOC/appimage-runtime/$f"
done
for f in $SHARUN_NOTICE_FILES; do
  install -m 0644 "$SHARUN_NOTICES/$f" "$DOC/anylinux-sharun/$f"
done
python3 "$PACKAGES_PY" --appdir "$APPDIR" --allowlist "$PACKAGES_TSV" --pins "$SHARUN_NOTICES/PIN.tsv" \
  --manifest "$DOC/appimage-libraries.tsv" --licenses "$DOC/appimage-licenses" ||
  die "the deployed files do not match scripts/appimage-packages.tsv"

appstreamcli validate-tree --no-net "$APPDIR" || die "appstreamcli validate-tree refused the AppDir"

rm -f "$OUT_DIR/$NAME" "$OUT_DIR/$NAME.zsync" "$OUT_DIR/$NAME.sig"
set -- --runtime-file "$RUNTIME_FILE" --comp zstd
[ -n "$UPDATE_INFO" ] && set -- "$@" --updateinformation "$UPDATE_INFO"
(cd "$OUT_DIR" && ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGETOOL" "$@" "$APPDIR" "$OUT_DIR/$NAME") ||
  die "appimagetool failed"
[ -f "$OUT_DIR/$NAME" ] || die "appimagetool wrote no $NAME"
if [ -n "$UPDATE_INFO" ]; then
  [ -s "$OUT_DIR/$NAME.zsync" ] || die "appimagetool wrote no $NAME.zsync"
  objcopy -O binary --only-section=.upd_info "$OUT_DIR/$NAME" "$OUT_DIR/.upd_info.tmp" ||
    die "$NAME has no .upd_info section"
  embedded="$(tr -d '[:cntrl:]' < "$OUT_DIR/.upd_info.tmp")"
  rm -f "$OUT_DIR/.upd_info.tmp"
  [ "$embedded" = "$UPDATE_INFO" ] || die "$NAME embeds update information '$embedded', not '$UPDATE_INFO'"
fi
chmod 0755 "$OUT_DIR/$NAME"

sh "$CONTENTS_GATE" "$OUT_DIR/$NAME" --deb "$DEB" || {
  rm -f "$OUT_DIR/$NAME" "$OUT_DIR/$NAME.zsync"
  die "the contents gate refused $NAME"
}

# smoke LABEL COMMAND...: the image's CLI validates the fixture.
smoke() {
  label="$1"; shift
  report="$("$@" check "$FIXTURE")" || die "$label: the CLI failed"
  printf '%s' "$report" | python3 -c '
import json, sys
report = json.load(sys.stdin)
sys.exit(0 if report.get("valid") is True and report.get("size_bytes", 0) > 0 else 1)
' || die "$label: the CLI did not validate the fixture: $report"
  echo "$label: CLI check passed"
}
smoke "AppImage (APPIMAGE_EXTRACT_AND_RUN)" env APPIMAGE_EXTRACT_AND_RUN=1 TMPDIR="$WORK/tmp" "$OUT_DIR/$NAME"
smoke "AppImage (--appimage-extract-and-run)" env TMPDIR="$WORK/tmp" "$OUT_DIR/$NAME" --appimage-extract-and-run

if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  require_tool node
  tauri="$(install_locked_tauri_cli "$WORK/signer")"
  node "$tauri" signer sign "$OUT_DIR/$NAME" || die "tauri signer failed"
  [ -s "$OUT_DIR/$NAME.sig" ] || die "tauri signer wrote no $NAME.sig"
fi

rm -rf "$WORK"
echo "Done. $OUT_DIR/$NAME ($(du -h "$OUT_DIR/$NAME" | cut -f1))"
