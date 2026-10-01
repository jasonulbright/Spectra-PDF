#!/bin/sh
# Builds the Linux AppImage from the built .deb. The AppDir is the .deb payload
# unpacked unmodified, plus AppRun, the desktop entry, the icon and the AppImage
# runtime's notices. WebKitGTK and GTK come from the host system, so no library
# is added and no ELF file is rewritten. appimagetool and the type-2 runtime are
# the vendors' released files, pinned by URL, SHA-256 and size.
#
#   sh scripts/build-appimage.sh [--deb FILE] [--out DIR]
#   sh scripts/build-appimage.sh --prepare     fetch and verify the pinned tools
#   sh scripts/build-appimage.sh --check       lint the inputs; no download, no build
#
# SPECTRA_GLIBC_FLOOR (default 2.35) is the highest GLIBC_ symbol version any
# ELF file in the AppDir may require. SPECTRA_APPIMAGE_UPDATE_INFO overrides
# the embedded update information; an empty value embeds none.

. "$(dirname "$0")/posix-common.sh"

APPIMAGETOOL_URL="https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage"
APPIMAGETOOL_SHA256="ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0"
APPIMAGETOOL_SIZE="15092216"
RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64"
RUNTIME_SHA256="2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d"
RUNTIME_SIZE="944632"

# AppImage update information (AppImageSpec, "update information"): the
# release page's newest .zsync file. appimagetool writes the .zsync beside the
# AppImage with its bundled zsyncmake. The application never reads it.
UPDATE_INFO_DEFAULT="gh-releases-zsync|jasonulbright|Spectra-PDF|latest|spectrapdf_*_amd64.AppImage.zsync"
UPDATE_INFO="${SPECTRA_APPIMAGE_UPDATE_INFO-$UPDATE_INFO_DEFAULT}"
GLIBC_FLOOR="${SPECTRA_GLIBC_FLOOR:-2.35}"

LINUX_DIR="$REPO_ROOT/src-tauri/linux"
APPRUN="$LINUX_DIR/AppRun"
DESKTOP="$LINUX_DIR/spectrapdf.desktop"
METAINFO="$LINUX_DIR/com.spectrapdf.app.metainfo.xml"
ICON="$REPO_ROOT/src-tauri/icons/128x128@2x.png"
RUNTIME_NOTICES="$REPO_ROOT/vendor/appimage-runtime"
RUNTIME_NOTICE_FILES="LICENSE-type2-runtime.txt LICENSE-libfuse-LGPL-2.1.txt LICENSE-squashfuse.txt
LICENSE-zstd.txt LICENSE-zlib.txt COPYRIGHT-musl.txt LICENSE-mimalloc.txt"
TOOL_DIR="$LINUX_RESOURCES/.build/appimagetool-1.9.1"
TARGET_ROOT="${CARGO_TARGET_DIR:-$REPO_ROOT/src-tauri/target}"

# The app binary's NEEDED set. Each name is a library of the WebKitGTK/GTK
# stack the packages declare, or of the C runtime.
HOST_SONAMES="libwebkit2gtk-4.1.so.0 libjavascriptcoregtk-4.1.so.0 libsoup-3.0.so.0
libgtk-3.so.0 libgdk-3.so.0 libgdk_pixbuf-2.0.so.0 libcairo.so.2 libglib-2.0.so.0
libgobject-2.0.so.0 libgio-2.0.so.0 libdbus-1.so.3 libgcc_s.so.1 libm.so.6 libc.so.6
ld-linux-x86-64.so.2"

pins_well_formed() {
  for pair in "APPIMAGETOOL:$APPIMAGETOOL_SHA256:$APPIMAGETOOL_SIZE" "RUNTIME:$RUNTIME_SHA256:$RUNTIME_SIZE"; do
    name="${pair%%:*}"; rest="${pair#*:}"; sha="${rest%%:*}"; size="${rest#*:}"
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

# prepare_tools: unpacks the pinned appimagetool once. Its bundled mksquashfs,
# zsyncmake and desktop-file-validate are static, so no host FUSE or package
# is needed and the same validator runs in every environment.
prepare_tools() {
  tool="$(fetch_tool "$APPIMAGETOOL_URL" "$APPIMAGETOOL_SHA256" "$APPIMAGETOOL_SIZE" "appimagetool-1.9.1-x86_64.AppImage")"
  RUNTIME_FILE="$(fetch_tool "$RUNTIME_URL" "$RUNTIME_SHA256" "$RUNTIME_SIZE" "type2-runtime-20251108-x86_64")"
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

# lint_inputs VALIDATOR: AppRun parses, the desktop entry validates, the
# runtime notices are present.
lint_inputs() {
  [ -f "$APPRUN" ] || die "missing $APPRUN"
  sh -n "$APPRUN" || die "$APPRUN does not parse"
  head -n1 "$APPRUN" | grep -qx '#!/bin/sh' || die "$APPRUN must start with #!/bin/sh"
  if grep -q "$(printf '\r')" "$APPRUN" "$DESKTOP" "$METAINFO"; then
    die "a Linux packaging input has CR line endings"
  fi
  "$1" "$DESKTOP" || die "desktop-file-validate refused $DESKTOP"
  grep -qx 'Exec=spectrapdf %F' "$DESKTOP" || die "$DESKTOP must run 'spectrapdf %F'"
  grep -qx 'Icon=spectrapdf' "$DESKTOP" || die "$DESKTOP must name the icon spectrapdf"
  grep -q '<launchable type="desktop-id">spectrapdf.desktop</launchable>' "$METAINFO" ||
    die "$METAINFO must launch spectrapdf.desktop"
  for f in $RUNTIME_NOTICE_FILES; do
    [ -s "$RUNTIME_NOTICES/$f" ] || die "runtime notice missing: vendor/appimage-runtime/$f"
  done
}

# glibc_of FILE -> the highest GLIBC_ version FILE references, or nothing.
glibc_of() {
  objdump -T "$1" 2>/dev/null | awk '/\*UND\*/' | grep -o 'GLIBC_[0-9][0-9.]*' \
    | sed 's/^GLIBC_//' | sort -t. -k1,1n -k2,2n -k3,3n -u | tail -n1
}

# version_gt A B: A is a higher dotted version than B.
version_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1)" = "$1" ]
}

gate_appdir() {
  appdir="$1"
  problems=""
  binary="$appdir/usr/bin/spectrapdf"
  [ -x "$binary" ] || die "the .deb carries no usr/bin/spectrapdf"
  for need in $(readelf -d "$binary" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p'); do
    case " $(echo $HOST_SONAMES) " in *" $need "*) continue ;; esac
    problems="$problems
  usr/bin/spectrapdf needs $need, which the host-library list does not name"
  done
  highest=""
  elf_count=0
  pe_stubs=0
  LO_PYTHON="usr/lib/spectrapdf/libreoffice/program"
  list="$appdir.elf.tmp"
  find "$appdir" -type f > "$list"
  while IFS= read -r f; do
    magic="$(head -c4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
    case "$magic" in
      7f454c46)
        elf_count=$((elf_count + 1))
        v="$(glibc_of "$f")"
        [ -n "$v" ] || continue
        if version_gt "$v" "$GLIBC_FLOOR"; then
          problems="$problems
  ${f#$appdir/} requires GLIBC_$v, above the floor $GLIBC_FLOOR"
        fi
        if [ -z "$highest" ] || version_gt "$v" "$highest"; then highest="$v"; fi
        ;;
      4d5a*)
        # The official LibreOffice Linux package carries the Windows launcher
        # stubs of pip and setuptools inside its private Python. The pinned
        # package ships unmodified; every other PE file fails the gate.
        case "${f#$appdir/}" in
          "$LO_PYTHON"/python-core-*/lib/setuptools/*.exe | "$LO_PYTHON"/python-core-*/lib/pip/_vendor/distlib/*.exe)
            pe_stubs=$((pe_stubs + 1)) ;;
          *) problems="$problems
  ${f#$appdir/} is a Windows PE file" ;;
        esac
        ;;
    esac
  done < "$list"
  rm -f "$list"
  dangling="$(find "$appdir" -type l ! -exec test -e {} \; -print)"
  [ -z "$dangling" ] || problems="$problems
  dangling symlinks:
$dangling"
  "$DESKTOP_VALIDATE" "$appdir/spectrapdf.desktop" || problems="$problems
  desktop-file-validate refused spectrapdf.desktop"
  [ -z "$problems" ] || die "AppDir gate refused:$problems"
  GLIBC_HIGHEST="$highest"
  echo "AppDir gate: $elf_count ELF files, highest GLIBC_$highest (floor $GLIBC_FLOOR), no PE file outside the $pe_stubs pip/setuptools launcher stubs of the LibreOffice package, no dangling link"
}

case "${1:-}" in
  --check)
    pins_well_formed
    validator="$TOOL_DIR/squashfs-root/usr/bin/desktop-file-validate"
    if [ ! -x "$validator" ]; then
      validator="$(command -v desktop-file-validate || true)"
    fi
    [ -n "$validator" ] || die "no desktop-file-validate: run 'sh scripts/build-appimage.sh --prepare' once"
    lint_inputs "$validator"
    echo "build-appimage --check: pins well-formed, AppRun parses, desktop entry valid, runtime notices present"
    exit 0
    ;;
  --prepare)
    require_tool curl sha256sum
    pins_well_formed
    prepare_tools
    lint_inputs "$DESKTOP_VALIDATE"
    echo "Done. appimagetool 1.9.1 and the type-2 runtime 20251108 verified at $TOOL_DIR"
    exit 0
    ;;
esac

DEB=""
OUT_DIR="$TARGET_ROOT/release/bundle/appimage"
while [ $# -gt 0 ]; do
  case "$1" in
    --deb) DEB="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
if [ -z "$DEB" ]; then
  set -- "$TARGET_ROOT"/release/bundle/deb/spectrapdf_*_amd64.deb
  [ $# -eq 1 ] && [ -f "$1" ] || die "expected exactly one spectrapdf_*_amd64.deb in $TARGET_ROOT/release/bundle/deb"
  DEB="$1"
fi

require_tool curl sha256sum dpkg-deb readelf objdump objcopy od install
pins_well_formed
prepare_tools
lint_inputs "$DESKTOP_VALIDATE"

[ "$(dpkg-deb -f "$DEB" Package)" = "spectrapdf" ] || die "$DEB is not the spectrapdf package"
VERSION="$(dpkg-deb -f "$DEB" Version)"
[ -n "$VERSION" ] || die "$DEB carries no Version"
NAME="spectrapdf_${VERSION}_amd64.AppImage"

APPDIR="$OUT_DIR/spectrapdf.AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR"
dpkg-deb -x "$DEB" "$APPDIR"
install -m 0755 "$APPRUN" "$APPDIR/AppRun"
install -m 0644 "$DESKTOP" "$APPDIR/spectrapdf.desktop"
install -m 0644 "$ICON" "$APPDIR/spectrapdf.png"
ln -s spectrapdf.png "$APPDIR/.DirIcon"
mkdir -p "$APPDIR/usr/share/doc/spectrapdf/appimage-runtime"
for f in $RUNTIME_NOTICE_FILES; do
  install -m 0644 "$RUNTIME_NOTICES/$f" "$APPDIR/usr/share/doc/spectrapdf/appimage-runtime/$f"
done

gate_appdir "$APPDIR"

rm -f "$OUT_DIR/$NAME" "$OUT_DIR/$NAME.zsync"
set -- --runtime-file "$RUNTIME_FILE"
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
rm -rf "$APPDIR"
echo "Done. $OUT_DIR/$NAME ($(du -h "$OUT_DIR/$NAME" | cut -f1), highest GLIBC_$GLIBC_HIGHEST)"
