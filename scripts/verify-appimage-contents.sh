#!/bin/sh
# Contents gate for the self-contained AppImage. quick-sharun skips what it
# cannot find without failing, so every file the image needs on a host without
# WebKitGTK or GTK is checked here by name, and every ELF file in the image,
# the payload included, must load through the image's own dynamic loader with
# every library it names found inside the image.
#
#   sh scripts/verify-appimage-contents.sh IMAGE.AppImage [--deb FILE]
#   sh scripts/verify-appimage-contents.sh APPDIR [--deb FILE]
#   sh scripts/verify-appimage-contents.sh --deb-payload ROOT
#
# --deb compares shared/bin/spectrapdf with the package's usr/bin/spectrapdf.
# --deb-payload checks the payload of an unpacked .deb (ROOT/usr/lib/spectrapdf),
# which runs on the host's C library: no ELF file may require a GLIBC_ symbol
# version above SPECTRA_GLIBC_FLOOR (default 2.35), no Windows PE file outside
# the LibreOffice package's pip/setuptools launcher stubs, no dangling link.

set -eu

die() {
  echo "error: $*" >&2
  exit 1
}

# The oldest webkit2gtk-4.1 release series the image may carry.
WEBKIT_MINIMUM="2.52.0"
GLIBC_FLOOR="${SPECTRA_GLIBC_FLOOR:-2.35}"
PAYLOAD="lib/spectrapdf"
LOADER_NAME="ld-linux-x86-64.so.2"

# LibreOffice's desktop-integration plugins load only under a KDE, Qt or GTK 4
# desktop session, and its Java bean only inside a Java runtime; the headless
# conversions the engine runs load none of them. They name toolkit libraries
# the image does not carry. Each listed file may leave only libraries that
# match OFFICE_PLUGIN_LIBRARIES unresolved.
OFFICE_PLUGINS="libkf5be1lo.so libvclplug_kf5lo.so libvclplug_qt5lo.so libvclplug_gtk3_kde5lo.so
lo_kde5filepicker libvclplug_qt6lo.so libvclplug_gtk4lo.so libavmediagtk.so libavmediaqt6.so
libofficebean.so"
OFFICE_PLUGIN_LIBRARIES='^lib(Qt[56][A-Za-z0-9]*|KF5[A-Za-z0-9]*|gtk-4|jawt)\.so'

[ $# -ge 1 ] || die "usage: verify-appimage-contents.sh IMAGE|APPDIR [--deb FILE] | --deb-payload ROOT"
MODE=image
DEB=""
if [ "$1" = "--deb-payload" ]; then
  [ $# -eq 2 ] || die "usage: verify-appimage-contents.sh --deb-payload ROOT"
  MODE=deb-payload
  TARGET="$2"
  shift 2
else
  TARGET="$1"; shift
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --deb) DEB="$2"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
for tool in readelf objdump od sha256sum find cmp awk sort; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required on PATH"
done
if [ -n "$DEB" ]; then
  command -v bsdtar >/dev/null 2>&1 || die "bsdtar is required on PATH"
fi

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT INT TERM
problems=""
fail() {
  problems="$problems
  $*"
}

hexbytes() { od -An -tx1 -j "$2" -N "$3" "$1" | tr -d ' \n'; }
is_elf() { [ "$(hexbytes "$1" 0 4 2>/dev/null)" = "7f454c46" ]; }
is_dynamic() { readelf -dW "$1" 2>/dev/null | grep -q '(NEEDED)'; }
version_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1)" = "$1" ]
}
glibc_of() {
  objdump -T "$1" 2>/dev/null | awk '/\*UND\*/' | grep -o 'GLIBC_[0-9][0-9.]*' \
    | sed 's/^GLIBC_//' | sort -t. -k1,1n -k2,2n -k3,3n -u | tail -n1
}

# payload_host_checks DIR: the floor, PE and link checks of a payload that runs
# on the host's C library.
payload_host_checks() {
  payload_elfs=0
  pe_stubs=0
  highest=""
  office_python="$1/libreoffice/program"
  find "$1" -type f > "$SCRATCH/payload"
  while IFS= read -r f; do
    magic="$(hexbytes "$f" 0 4 2>/dev/null)"
    case "$magic" in
      7f454c46)
        payload_elfs=$((payload_elfs + 1))
        v="$(glibc_of "$f")"
        [ -n "$v" ] || continue
        version_gt "$v" "$GLIBC_FLOOR" && fail "$f requires GLIBC_$v, above the floor $GLIBC_FLOOR"
        if [ -z "$highest" ] || version_gt "$v" "$highest"; then highest="$v"; fi
        ;;
      4d5a*)
        # The official LibreOffice Linux package carries the Windows launcher
        # stubs of pip and setuptools inside its private Python.
        case "$f" in
          "$office_python"/python-core-*/lib/setuptools/*.exe | "$office_python"/python-core-*/lib/pip/_vendor/distlib/*.exe)
            pe_stubs=$((pe_stubs + 1)) ;;
          *) fail "$f is a Windows PE file" ;;
        esac
        ;;
    esac
  done < "$SCRATCH/payload"
  dangling="$(find "$1" -type l ! -exec test -e {} \; -print)"
  [ -z "$dangling" ] || fail "dangling symlinks:
$dangling"
}

if [ "$MODE" = deb-payload ]; then
  [ -d "$TARGET/usr/lib/spectrapdf" ] || die "$TARGET/usr/lib/spectrapdf is not a directory"
  payload_host_checks "$TARGET/usr/lib/spectrapdf"
  [ -z "$problems" ] || die ".deb payload gate refused:$problems"
  echo ".deb payload gate: $payload_elfs ELF files, highest GLIBC_$highest (floor $GLIBC_FLOOR), $pe_stubs pip/setuptools launcher stubs, no dangling link"
  exit 0
fi

if [ -f "$TARGET" ]; then
  IMAGE="$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
  [ "$(hexbytes "$IMAGE" 8 3)" = "414902" ] || die "$TARGET is not a type-2 AppImage (no AI 02 magic at offset 8)"
  offset="$("$IMAGE" --appimage-offset)" || die "$TARGET does not report its file system offset"
  [ "$(hexbytes "$IMAGE" "$offset" 4)" = "68737173" ] || die "$TARGET does not carry a SquashFS file system"
  [ "$(hexbytes "$IMAGE" $((offset + 20)) 2)" = "0600" ] || die "$TARGET's SquashFS is not zstd-compressed"
  (cd "$SCRATCH" && "$IMAGE" --appimage-extract >/dev/null) || die "$TARGET did not extract"
  APPDIR="$SCRATCH/squashfs-root"
else
  [ -d "$TARGET" ] || die "$TARGET is neither an AppImage nor a directory"
  APPDIR="$(cd "$TARGET" && pwd)"
fi
cd "$APPDIR"

# Top level, as the AppImage catalog lints it.
[ -x AppRun ] || fail "AppRun is missing or not executable"
[ -e .DirIcon ] || fail ".DirIcon is missing"
set -- ./*.desktop
[ $# -eq 1 ] && [ -f "$1" ] || fail "the top level needs exactly one .desktop file"
if [ -f spectrapdf.desktop ]; then
  [ "$(grep -c '^Icon=' spectrapdf.desktop)" = 1 ] || fail "spectrapdf.desktop must carry Icon exactly once"
  [ "$(grep -c '^Categories=' spectrapdf.desktop)" = 1 ] || fail "spectrapdf.desktop must carry Categories exactly once"
fi
[ -f usr/share/metainfo/com.spectrapdf.app.appdata.xml ] || fail "the AppStream file is not usr/share/metainfo/com.spectrapdf.app.appdata.xml"
[ -f usr/share/applications/spectrapdf.desktop ] || fail "the AppStream launchable usr/share/applications/spectrapdf.desktop is missing"
[ -f usr/share/icons/hicolor/128x128/apps/spectrapdf.png ] || fail "the 128x128 icon is not in usr/share/icons"

# sharun and the files it starts.
[ -f sharun ] && cmp -s sharun AppRun || fail "AppRun is not sharun"
need_link() { [ -f "$1" ] && cmp -s sharun "$1" || fail "$1 is not a sharun link"; }
need_elf() { [ -f "$1" ] && is_elf "$1" || fail "$1 is missing or not an ELF file"; }
need_file() { [ -e "$1" ] || fail "$1 is missing"; }
for b in spectrapdf gs bwrap xdg-dbus-proxy; do
  need_link "bin/$b"
  need_elf "shared/bin/$b"
done
for b in WebKitWebProcess WebKitNetworkProcess; do
  need_link "lib/webkit2gtk-4.1/$b"
  need_elf "shared/bin/$b"
done
grep -qx 'PATH="$APPDIR/bin:$PATH"' AppRun.sh 2>/dev/null || fail "AppRun.sh is not the start script from src-tauri/linux"
# AppRun.sh sources the start hooks only through AppRun.lib; sharun reads
# .env and lib/lib.path before it starts anything.
need_file AppRun.lib
need_file .env
need_file lib/lib.path
need_file "lib/$LOADER_NAME"
need_file lib/libc.so.6
need_file lib/libwebkit2gtk-4.1.so.0
need_file lib/libjavascriptcoregtk-4.1.so.0
need_file lib/libgtk-3.so.0
need_file lib/libsoup-3.0.so.0
need_file lib/libayatana-appindicator3.so.1
need_file lib/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so
need_file lib/gio/modules/libgiognutls.so
need_file lib/sharun-preload/anylinux.so
# gdk-pixbuf decodes through glycin loaders since 2.44 and through its own
# loader modules before; the image carries the SVG decoder of whichever it has.
set -- share/glycin-loaders/*/conf.d/glycin-svg.conf
if [ -f "$1" ]; then
  ! grep -q '/usr/' "$1" || fail "$1 keeps an absolute loader path"
  need_link bin/glycin-svg
  need_elf shared/bin/glycin-svg
else
  set -- lib/gdk-pixbuf-2.0/*/loaders/*svg*.so
  [ -f "$1" ] || fail "neither a glycin nor a gdk-pixbuf SVG loader is deployed"
  set -- lib/gdk-pixbuf-2.0/*/loaders.cache
  if [ -f "$1" ]; then
    grep -q 'svg' "$1" || fail "$1 does not list the SVG loader"
    ! grep -q '"/usr/lib' "$1" || fail "$1 keeps absolute loader paths"
  else
    fail "the gdk-pixbuf loaders.cache is missing"
  fi
fi
set -- lib/dri/*.so lib/libgallium-*.so
found_mesa=0
for f do [ -f "$f" ] && found_mesa=1; done
[ "$found_mesa" = 1 ] || fail "no Mesa driver is deployed (lib/dri, lib/libgallium-*)"

# WebKitGTK relocation: the compiled-in directories point at the start hook's links.
hook=bin/01-path-mapping-hardcoded.hook
if [ -f "$hook" ]; then
  tmp_lib="$(sed -n 's/^_tmp_lib=//p' "$hook" | tr -d '"')"
  tmp_bin="$(sed -n 's/^_tmp_bin=//p' "$hook" | tr -d '"')"
  [ ${#tmp_lib} -eq 3 ] && [ ${#tmp_bin} -eq 3 ] || fail "$hook does not set both relocation names"
  webkit="$(readlink -f lib/libwebkit2gtk-4.1.so.0 2>/dev/null || true)"
  if [ -f "$webkit" ]; then
    grep -aq "/tmp/$tmp_lib/webkit2gtk-4.1" "$webkit" || fail "libwebkit2gtk-4.1 does not name /tmp/$tmp_lib/webkit2gtk-4.1"
    ! grep -aq '/usr/lib/webkit2gtk-4.1' "$webkit" || fail "libwebkit2gtk-4.1 still names /usr/lib/webkit2gtk-4.1"
  fi
else
  fail "$hook is missing"
fi
need_file bin/10-webkit-sandbox.hook
[ -x lib/libreoffice-launcher/program/soffice ] || fail "lib/libreoffice-launcher/program/soffice is missing or not executable"
[ "$(readlink lib/libreoffice-launcher/share 2>/dev/null)" = "../spectrapdf/libreoffice/share" ] ||
  fail "lib/libreoffice-launcher/share does not link to the payload's libreoffice/share"
[ -x lib/python-launcher/python3 ] || fail "lib/python-launcher/python3 is missing or not executable"
need_elf lib/image-exec/image-exec.so
set -- bin/*fix-namespaces*
[ ! -e "$1" ] || fail "the image carries a namespace hook that changes a system setting"
grep -qx '+/webkit2gtk-4.1/injected-bundle' lib/lib.path 2>/dev/null ||
  fail "lib/lib.path does not cover lib/webkit2gtk-4.1/injected-bundle"
! grep -q 'spectrapdf' lib/lib.path 2>/dev/null || fail "lib/lib.path names a payload directory"

# Ghostscript and the time zone database.
set -- share/ghostscript/*/Resource/Init/gs_init.ps share/ghostscript/Resource/Init/gs_init.ps
found_gs=0
for f do [ -f "$f" ] && found_gs=1; done
[ "$found_gs" = 1 ] || fail "the Ghostscript Resource/Init tree is missing"
[ -d share/ghostscript/Resource/CMap ] && [ ! -L share/ghostscript/Resource/CMap ] ||
  fail "share/ghostscript/Resource/CMap is not a directory in the image"
need_file share/ghostscript/Resource/CMap/Identity-H
need_file share/ghostscript/Resource/CMap/UniJIS-UTF16-H
set -- share/ghostscript/Resource/Font/*
[ -f "$1" ] || fail "share/ghostscript/Resource/Font holds no font"
need_file share/zoneinfo/UTC
need_file share/zoneinfo/Europe/Berlin

# The payload, where Tauri and the CLI resolve it.
need_file "$PAYLOAD/engine/__startup__.py"
need_file "$PAYLOAD/python/bin/python3"
[ "$(readlink usr/lib/spectrapdf 2>/dev/null)" = "../../lib/spectrapdf" ] || fail "usr/lib/spectrapdf does not link to ../../lib/spectrapdf"
if [ -n "$DEB" ]; then
  bsdtar -xOf "$DEB" 'data.tar*' | bsdtar -xf - -C "$SCRATCH" ./usr/bin/spectrapdf ||
    die "$DEB carries no usr/bin/spectrapdf"
  cmp -s "$SCRATCH/usr/bin/spectrapdf" shared/bin/spectrapdf || fail "shared/bin/spectrapdf differs from the .deb's usr/bin/spectrapdf"
fi

# Every dynamic ELF file loads through the image's loader with every library
# it names found inside the image: the image's own files on sharun's search
# path (lib/ and lib/lib.path), the payload's on the path the launchers and
# engine/platform_support.py give it (its directory, ../lib, LibreOffice's
# program/ for that tree, then the image's).
IMAGE_PATH="$APPDIR/lib"
while IFS= read -r dir; do
  case "$dir" in
    "+"/*) IMAGE_PATH="$IMAGE_PATH:$APPDIR/lib${dir#+}" ;;
  esac
done < lib/lib.path
LOADER="$APPDIR/lib/$LOADER_NAME"
[ -x "$LOADER" ] || die "the image's dynamic loader is missing"

# resolves FILE SEARCH_PATH: the loader lists FILE's libraries; every one is
# found and lies inside the image. Prints the libraries left unresolved.
resolves() {
  "$LOADER" --inhibit-cache --library-path "$2" --list "$1" > "$SCRATCH/list" 2>&1 || true
  awk -v root="$APPDIR/" '
    /=> not found/ { print $1; next }
    /=>/ && index($3, root) != 1 { print $1 " (outside the image: " $3 ")"; next }
    /not found|error while loading/ { print "(" $0 ")" }
  ' "$SCRATCH/list"
}

elf_count=0
find . -path "./$PAYLOAD" -prune -o -type f -print > "$SCRATCH/outside"
while IFS= read -r f; do
  is_elf "$f" || continue
  is_dynamic "$f" || continue
  elf_count=$((elf_count + 1))
  missing="$(resolves "$APPDIR/${f#./}" "$IMAGE_PATH")"
  [ -z "$missing" ] || fail "${f#./} does not load inside the image: $(echo $missing)"
done < "$SCRATCH/outside"

payload_elfs=0
plugin_gaps=0
find "$PAYLOAD" -type f > "$SCRATCH/payload"
while IFS= read -r f; do
  is_elf "$f" || continue
  payload_elfs=$((payload_elfs + 1))
  is_dynamic "$f" || continue
  dir="$APPDIR/$(dirname "$f")"
  search="$dir:$(dirname "$dir")/lib"
  case "$f" in
    "$PAYLOAD"/libreoffice/*) search="$search:$APPDIR/$PAYLOAD/libreoffice/program" ;;
  esac
  name="$(basename "$f")"
  case " $(echo $OFFICE_PLUGINS) " in
    *" $name "*)
      # The loader stops at the first library it cannot open, so every named
      # library is looked up on the search path instead.
      left=""
      for need in $(readelf -dW "$f" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p'); do
        printf '%s\n' "$need" | grep -Eq "$OFFICE_PLUGIN_LIBRARIES" && continue
        found=""
        paths="$search:$IMAGE_PATH"
        old_ifs="$IFS"; IFS=:
        for d in $paths; do
          [ -e "$d/$need" ] && found=1 && break
        done
        IFS="$old_ifs"
        [ -n "$found" ] || left="$left $need"
      done
      if [ -z "$left" ]; then
        plugin_gaps=$((plugin_gaps + 1))
      else
        fail "$f does not load inside the image:$left"
      fi
      continue
      ;;
  esac
  missing="$(resolves "$APPDIR/$f" "$search:$IMAGE_PATH")"
  [ -z "$missing" ] || fail "$f does not load inside the image: $(echo $missing)"
done < "$SCRATCH/payload"

# Nothing of the payload was deployed a second time outside it.
while IFS= read -r f; do
  is_elf "$f" && sha256sum "$f"
done < "$SCRATCH/payload" | awk '{ print $1 }' | sort -u > "$SCRATCH/payload-hashes"
while IFS= read -r f; do
  is_elf "$f" && sha256sum "$f"
done < "$SCRATCH/outside" | sort > "$SCRATCH/outside-hashes"
dup="$(awk 'NR == FNR { seen[$1] = 1; next } ($1 in seen) { print $2 }' "$SCRATCH/payload-hashes" "$SCRATCH/outside-hashes")"
[ -z "$dup" ] || fail "payload ELF files deployed a second time outside $PAYLOAD:
$dup"

absolute="$(find . -path "./$PAYLOAD" -prune -o -type l -lname '/*' -print)"
[ -z "$absolute" ] || fail "symlinks that name the build host's files:
$absolute"
dangling="$(find . -type l ! -exec test -e {} \; -print)"
[ -z "$dangling" ] || fail "dangling symlinks:
$dangling"
while IFS= read -r f; do
  case "$(hexbytes "$f" 0 2 2>/dev/null)" in
    4d5a)
      # The official LibreOffice Linux package carries the Windows launcher
      # stubs of pip and setuptools inside its private Python.
      case "$f" in
        "$PAYLOAD"/libreoffice/program/python-core-*/lib/setuptools/*.exe | \
        "$PAYLOAD"/libreoffice/program/python-core-*/lib/pip/_vendor/distlib/*.exe) ;;
        *) fail "$f is a Windows PE file" ;;
      esac
      ;;
  esac
done < "$SCRATCH/payload"

# The library manifest, and the WebKitGTK release it records.
MANIFEST=usr/share/doc/spectrapdf/appimage-libraries.tsv
webkit_version=""
if [ -f "$MANIFEST" ]; then
  webkit_version="$(awk -F '\t' '$2 == "webkit2gtk-4.1" { print $3; exit }' "$MANIFEST")"
  [ -n "$webkit_version" ] || fail "$MANIFEST records no webkit2gtk-4.1 file"
  base="${webkit_version%%-*}"
  if [ -n "$base" ] && version_gt "$WEBKIT_MINIMUM" "$base"; then
    fail "webkit2gtk-4.1 $webkit_version is older than the minimum $WEBKIT_MINIMUM"
  fi
  [ -d usr/share/doc/spectrapdf/appimage-licenses/webkit2gtk-4.1 ] || fail "the webkit2gtk-4.1 notices are missing"
  for f in LICENSE-sharun.txt LICENSE-cross-libc-dlopen.txt LICENSE-linuxdeploy-plugin-checkrt.txt; do
    [ -s "usr/share/doc/spectrapdf/anylinux-sharun/$f" ] || fail "usr/share/doc/spectrapdf/anylinux-sharun/$f is missing"
  done
else
  fail "$MANIFEST is missing"
fi

[ -z "$problems" ] || die "AppImage contents gate refused:$problems"
echo "AppImage contents gate: $elf_count image ELF files and $payload_elfs payload ELF files load through the image's loader with every library inside the image ($plugin_gaps LibreOffice desktop plugins leave only toolkit libraries unresolved); webkit2gtk-4.1 $webkit_version; no payload duplicate, no dangling or host-bound link"
