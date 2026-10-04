#!/bin/sh
# Runs the AppImage the way the AppImage catalog's test runs it, on a base
# Ubuntu 22.04 system without WebKitGTK or GTK, as root. The system is changed
# for good and is meant to be discarded afterwards: packages are installed and
# GTK 3 and WebKitGTK removed, and a setuid firejail with its musl library is
# copied into /etc, /lib and /usr. The two kernel settings the catalog changes
# are restored on exit.
#   1. installs the catalog worker's tools, removes GTK 3 and WebKitGTK, and
#      refuses when either is still present;
#   2. mounts the image with the catalog's runtime-fuse2 (SquashFS only), runs
#      the catalog's appdir-lint.sh (whose appstreamcli validate-tree runs once
#      it finds usr/share/metainfo/*appdata.xml), converts that file with the
#      catalog's appstreamcli AppImage, runs check-libc.sh, and requires
#      X-AppImage-Self-Contained=true;
#   3. installs the catalog's firejail build and starts the image with
#      firejail --quiet --noprofile --net=none --appimage on Xvfb (800x600x24)
#      with the catalog's environment; after 10 s, up to 20 one-second polls of
#      xdotool search --onlyvisible --name '.' must find a window while the
#      process lives;
#   4. takes the screenshot with the catalog's take-screenshot.sh under icewm
#      and passes it through the catalog's check-screenshot.sh.
# Every catalog file is fetched at a pinned commit or release and checked
# against its SHA-256.
#
#   sh scripts/appimage-catalog-gate.sh IMAGE.AppImage [--work DIR] [--no-firejail]
#
# --no-firejail runs step 3 without firejail, for a system where firejail
# cannot create its sandbox; the catalog itself always uses firejail.

. "$(dirname "$0")/posix-common.sh"
github_token_unexport

CATALOG_COMMIT="685ed765c93a07b3966d959f657e1cb83c0a43ac"
CATALOG_RAW="https://raw.githubusercontent.com/AppImage/appimage.github.io/$CATALOG_COMMIT/code"
LINT_COMMIT="19e30b276ffedf4d3b4b56bc6320f463625a74f8"
LINT_RAW="https://raw.githubusercontent.com/AppImage/AppImages/$LINT_COMMIT"
DEPS="https://github.com/AppImage/appimage.github.io/releases/download/deps"
MUSL_URL="https://dl-cdn.alpinelinux.org/alpine/v3.13/main/x86_64/musl-1.2.2-r2.apk"

# name url sha256
CATALOG_FILES="appdir-lint.sh $LINT_RAW/appdir-lint.sh 408c60f34269b74ace4a87f074e9f215e9009772af57af4afc6be95de6790091
excludelist $LINT_RAW/excludelist 50db0f894f34b169c47a5cbc0c17dbab61e9edebca5bc8269a1e6ac1bf4bdad9
check-libc.sh $CATALOG_RAW/check-libc.sh 31146eb5780b4eefe761dbc4dea054ef295a2e986951028e54f12c712ecd81aa
check-screenshot.sh $CATALOG_RAW/check-screenshot.sh 5377029c84568ee2f4c43985907cde98c8dab57ae78810d84a9ed9ac99b83993
take-screenshot.sh $CATALOG_RAW/take-screenshot.sh a6711a7c5bb9992c0b30c03ff844832dcd379615ab8a129080463826798b7b8e
runtime-fuse2-x86_64 $DEPS/runtime-fuse2-x86_64 4aa4ff1da357d4a46dea9bcf1ab15edfccb7b0fb36afdfe0688ce19495e6ed24
alpine-firejail-git20230825.tar.gz $DEPS/alpine-firejail-git20230825.tar.gz e346e52ac7dbff3a3f1e8aad3cbb2f06584afcb51c840de07cb8d50e134492d9
musl-1.2.2-r2.apk $MUSL_URL 3d459f4f3a83e60c6c260c6aee26745e7aa22697f53e3a01445227d2cfeeae8a
appstreamcli-x86_64.AppImage $DEPS/appstreamcli-x86_64.AppImage 0b567ce75945bea2ba047533290ab85fb62749b025ef8bfbf8726e8b28c3e35f"

# The worker's tools that matter to these steps, as Ubuntu 22.04 packages.
APT_TOOLS="ca-certificates curl file procps psmisc libfuse2 xvfb xauth xdotool x11-utils
imagemagick tesseract-ocr tesseract-ocr-eng icewm desktop-file-utils libfile-mimeinfo-perl binutils appstream"
GTK_PACKAGES="libgtk-3-0 libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libwebkit2gtk-4.0-37 libjavascriptcoregtk-4.0-18"
GTK_LIBRARIES='libgtk-3\.so|libwebkit2gtk-4\.[01]\.so|libjavascriptcoregtk-4\.[01]\.so'

[ $# -ge 1 ] || die "usage: appimage-catalog-gate.sh IMAGE.AppImage [--work DIR] [--no-firejail]"
IMAGE="$1"; shift
WORK="$PWD/appimage-catalog-gate.work"
FIREJAIL=1
while [ $# -gt 0 ]; do
  case "$1" in
    --work) WORK="$2"; shift 2 ;;
    --no-firejail) FIREJAIL=0; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -f "$IMAGE" ] || die "no AppImage at $IMAGE"
IMAGE="$(cd "$(dirname "$IMAGE")" && pwd)/$(basename "$IMAGE")"
[ "$(id -u)" = 0 ] || die "the gate installs packages and firejail and runs as root"
grep -q 'VERSION_ID="22.04"' /etc/os-release || die "the gate mirrors the catalog's Ubuntu 22.04 runner"

step() { echo "==> $*"; }

step "the catalog worker's tools"
export DEBIAN_FRONTEND=noninteractive
# shellcheck disable=SC2086
apt-get update >/dev/null && apt-get install -y --no-install-recommends $APT_TOOLS >/dev/null ||
  die "apt-get could not install the catalog worker's tools"
# runtime-fuse2 mounts through libfuse2, which runs the fusermount helper.
if ! command -v fusermount >/dev/null 2>&1; then
  apt-get install -y --no-install-recommends fuse >/dev/null || die "apt-get could not install fusermount"
fi

step "no GTK 3 and no WebKitGTK"
remove=""
for p in $GTK_PACKAGES; do
  dpkg -s "$p" >/dev/null 2>&1 && remove="$remove $p"
done
if [ -n "$remove" ]; then
  # shellcheck disable=SC2086
  apt-get purge -y $remove >/dev/null || die "apt-get could not remove$remove"
fi
for tool in Xvfb xdotool xwininfo import convert identify tesseract icewm file mimetype desktop-file-validate appstreamcli readelf objdump killall fusermount; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is missing after GTK and WebKitGTK were removed"
done
if ldconfig -p | grep -E "$GTK_LIBRARIES"; then
  die "the dynamic loader still finds GTK 3 or WebKitGTK"
fi
found="$(find /usr/lib /lib /usr/local/lib -regextype posix-extended -regex ".*/($GTK_LIBRARIES).*" 2>/dev/null | head -n 5)"
[ -z "$found" ] || die "GTK 3 or WebKitGTK files remain:
$found"
echo "ldconfig and the library directories carry no GTK 3 and no WebKitGTK"

step "the catalog's files"
rm -rf "$WORK"
mkdir -p "$WORK"
printf '%s\n' "$CATALOG_FILES" > "$WORK/files.lst"
while read -r name url sha; do
  path="$(fetch_verified "$url" "$sha" "catalog-$name")"
  cp "$path" "$WORK/$name"
done < "$WORK/files.lst"
chmod 0755 "$WORK/runtime-fuse2-x86_64" "$WORK/appstreamcli-x86_64.AppImage"
cd "$WORK"

APID=""
MOUNT_PID=""
XVFB_PID=""
APPDIR=""
MMAP_MIN_ADDR="$(sysctl -n vm.mmap_min_addr 2>/dev/null || true)"
USERNS_CLONE="$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || true)"
cleanup() {
  rc=$?
  set +e
  [ -n "$MMAP_MIN_ADDR" ] && sysctl -w vm.mmap_min_addr="$MMAP_MIN_ADDR" >/dev/null
  [ -n "$USERNS_CLONE" ] && sysctl -w kernel.unprivileged_userns_clone="$USERNS_CLONE" >/dev/null
  for p in $APID $MOUNT_PID; do kill "$p" 2>/dev/null; done
  sleep 2
  for p in $APID $MOUNT_PID; do kill -9 "$p" 2>/dev/null; done
  killall -9 icewm 2>/dev/null
  [ -n "$APPDIR" ] && fusermount -u -z "$APPDIR" 2>/dev/null
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' INT TERM

step "mount with the catalog's runtime (SquashFS)"
[ "$(od -An -tx1 -j 8 -N 3 "$IMAGE" | tr -d ' \n')" = "414902" ] || die "$IMAGE is not a type-2 AppImage"
TARGET_APPIMAGE="$IMAGE" ./runtime-fuse2-x86_64 --appimage-mount > runtime-mount.log 2>&1 &
MOUNT_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  APPDIR="$(mount | grep -F " type fuse.$(basename "$IMAGE") " | tail -n 1 | cut -d ' ' -f 3 || true)"
  [ -n "$APPDIR" ] && break
  kill -0 "$MOUNT_PID" 2>/dev/null || break
done
if [ -z "$APPDIR" ]; then
  cat runtime-mount.log
  die "the catalog's runtime could not mount the image: the catalog supports only SquashFS AppImages"
fi
echo "mounted at $APPDIR"

step "appdir-lint.sh"
bash appdir-lint.sh "$APPDIR" > appdir-lint.log 2>&1 || { cat appdir-lint.log; die "appdir-lint.sh refused the image"; }
grep -v 'Blacklisted file' appdir-lint.log || true
set -- "$APPDIR"/usr/share/metainfo/*appdata.xml
[ -f "$1" ] || die "the image has no usr/share/metainfo/*appdata.xml"
grep -q 'Validation was successful' appdir-lint.log || die "appdir-lint.sh did not validate the AppStream tree"
./appstreamcli-x86_64.AppImage convert "$1" appdata.yaml || die "the catalog's appstreamcli cannot convert $(basename "$1")"
echo "the catalog's appstreamcli converted $(basename "$1")"

step "check-libc.sh"
LIBC_INFO="$(bash check-libc.sh "$IMAGE" "$APPDIR" || true)"
echo "$LIBC_INFO"
printf '%s\n' "$LIBC_INFO" | grep -qx 'X-AppImage-Self-Contained=true' || die "the catalog does not rate the image self-contained"

step "the desktop entry's icon, as the catalog finds it"
ICON_NAME="$(grep -h '^Icon=' "$APPDIR"/*.desktop | head -n 1 | cut -d = -f 2-)"
ICONFILE="$(find "$APPDIR" -name "$ICON_NAME.svg*" -path '*/scalable/*' -print -quit)"
[ -n "$ICONFILE" ] || ICONFILE="$(find "$APPDIR" -name "$ICON_NAME.png" -path '*/128x128/*' -print -quit)"
[ -n "$ICONFILE" ] || ICONFILE="$(find "$APPDIR" -maxdepth 1 -name "$ICON_NAME.png" -print -quit)"
[ -n "$ICONFILE" ] || die "the catalog finds no icon named $ICON_NAME"
file "$(readlink -f "$ICONFILE")" | grep -qE ', [0-9]+ x [0-9]+,' || die "the catalog cannot read the size of $ICONFILE"
echo "icon: ${ICONFILE#$APPDIR/}"

if [ "$FIREJAIL" -eq 1 ]; then
  step "firejail, installed as the catalog worker installs it"
  mkdir -p firejail
  tar xf alpine-firejail-git20230825.tar.gz
  tar xf musl-*.apk -C ./firejail/ 2>/dev/null || true
  tar xf firejail-0*.apk -C ./firejail/ 2>/dev/null || true
  cp -Rf ./firejail/etc/* /etc/
  cp -Rf ./firejail/lib/* /lib/
  cp -Rf ./firejail/usr/* /usr/
  chown root:root /usr/bin/firejail
  chmod u+s /usr/bin/firejail
  set -- firejail --quiet --noprofile --net=none --appimage "$IMAGE"
else
  echo "NOTE: step 3 runs WITHOUT firejail (--no-firejail); the catalog uses firejail"
  set -- "$IMAGE"
fi

step "start the image on Xvfb with the catalog's environment"
DISPLAY_NUMBER=99
while [ -e "/tmp/.X11-unix/X$DISPLAY_NUMBER" ] || [ -e "/tmp/.X$DISPLAY_NUMBER-lock" ]; do
  DISPLAY_NUMBER=$((DISPLAY_NUMBER + 1))
done
Xvfb ":$DISPLAY_NUMBER" -screen 0 800x600x24 >/dev/null 2>&1 &
XVFB_PID=$!
export DISPLAY=":$DISPLAY_NUMBER"
unset WAYLAND_DISPLAY
sleep 2
mkdir -p "$HOME/.local/share/appimagekit" "$HOME/.icewm"
touch "$HOME/.local/share/appimagekit/no_desktopintegration"
printf 'ShowTaskBar = 0\nTaskBarAutoHide = 1\n' > "$HOME/.icewm/preferences"
sysctl -w vm.mmap_min_addr=0 >/dev/null || echo "note: vm.mmap_min_addr could not be set"
sysctl -w kernel.unprivileged_userns_clone=1 >/dev/null 2>&1 ||
  echo "note: this kernel has no kernel.unprivileged_userns_clone setting"
export QTWEBENGINE_DISABLE_SANDBOX=1 QT_DEBUG_PLUGINS=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
echo "running: $*"
"$@" > app.log 2>&1 &
APID=$!
sleep 10
WAIT=0
for WAIT in $(seq 1 20); do
  kill -0 "$APID" 2>/dev/null || break
  timeout 5 xdotool search --onlyvisible --name '.' >/dev/null 2>&1 && break
  sleep 1
done
[ "$WAIT" -gt 1 ] && sleep 2
if ! kill -0 "$APID" 2>/dev/null; then
  cat app.log
  die "the application exited within $((10 + WAIT)) seconds instead of showing a window"
fi
timeout 5 xdotool search --onlyvisible --name '.' >/dev/null 2>&1 || {
  cat app.log
  die "could not find a single window on screen"
}
WINDOWS="$(timeout 20 xwininfo -tree -root | grep 0x | grep '": ("' | sed -e 's/^[[:space:]]*//' || true)"
echo "$WINDOWS"
[ "$(printf '%s' "$WINDOWS" | grep -c .)" -ge 1 ] || die "xwininfo lists no window"

step "screenshot, as the catalog takes and checks it"
icewm >/dev/null 2>&1 &
sleep 2
read -r SW SH <<EOF
$(timeout 5 xdotool getdisplaygeometry)
EOF
LINE="$(timeout 20 xwininfo -tree -root 2>/dev/null | grep '": ("' \
  | sed -nE 's/^[[:space:]]*(0x[0-9a-f]+) .* ([0-9]+)x([0-9]+)[-+][-0-9]+[-+][-0-9]+ +[-+][0-9]+[-+][0-9]+$/\1 \2 \3/p' \
  | awk '{ print $2 * $3, $0 }' | sort -rn | head -n 1 | cut -d ' ' -f 2-)"
read -r WID WW WH <<EOF
$LINE
EOF
if [ -n "$WID" ]; then
  timeout 5 xdotool windowmove "$WID" 0 0 2>/dev/null || true
  NW=$WW; NH=$WH
  [ "$WW" -gt $((SW - 4)) ] && NW=$((SW - 4))
  [ "$WH" -gt $((SH - 30)) ] && NH=$((SH - 30))
  if [ "$NW" != "$WW" ] || [ "$NH" != "$WH" ]; then
    timeout 5 xdotool windowsize "$WID" "$NW" "$NH" 2>/dev/null || true
    sleep 1
  fi
fi
bash take-screenshot.sh screenshot.png || true
kill "$APID" || die "the application did not live until the screenshot"
APID=""
[ "$(file -b --mime-type screenshot.png)" = "image/png" ] || die "no PNG screenshot was taken"
bash check-screenshot.sh screenshot.png || die "check-screenshot.sh refused the screenshot ($WORK/screenshot.png)"
echo "PASS: the catalog's checks accept the image; screenshot at $WORK/screenshot.png"
