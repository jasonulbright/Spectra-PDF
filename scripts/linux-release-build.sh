#!/bin/sh
# Builds the Linux x86-64 release packages: provisions every vendored tree,
# builds the .deb and .rpm with Tauri, checks the .rpm signature, runs the
# payload gate on the .deb's payload (it runs on the host's C library: no ELF
# file above the SPECTRA_GLIBC_FLOOR symbol version, no stray Windows PE file,
# no dangling link), and runs the built CLI from the .deb payload against the
# fixture. The AppImage is built
# from this .deb by scripts/build-appimage.sh on an Arch Linux host.
#
#   sh scripts/linux-release-build.sh            local build; signing optional
#   sh scripts/linux-release-build.sh --release  release build; refuses unsigned
#
# Output: src-tauri/target/release/bundle/linux/ holds the .deb and the .rpm.
#
# TAURI_SIGNING_RPM_KEY (and _PASSPHRASE) is read by the Tauri RPM bundler,
# which signs the package. This script checks that the signature is present;
# scripts/verify-rpm-signature.sh checks it against
# keys/spectrapdf-rpm-signing.pub.asc on rpm 4.18 or newer. A release build
# requires that key, the rpm tool and the configured glibc floor 2.35.

. "$(dirname "$0")/posix-common.sh"

RELEASE=0
case "${1:-}" in
  --release) RELEASE=1 ;;
  "") ;;
  *) die "unknown argument: $1" ;;
esac

RPM_PUBLIC_KEY="$REPO_ROOT/keys/spectrapdf-rpm-signing.pub.asc"
TARGET_ROOT="${CARGO_TARGET_DIR:-$REPO_ROOT/src-tauri/target}"
BUNDLE="$TARGET_ROOT/release/bundle"
OUT="$BUNDLE/linux"
FIXTURE="$REPO_ROOT/tests/fixtures/sample.pdf"

require_tool curl sha256sum tar dpkg-deb readelf objdump python3 node npx
[ -f "$RPM_PUBLIC_KEY" ] || die "missing $RPM_PUBLIC_KEY"
if [ "$RELEASE" -eq 1 ]; then
  [ -n "${TAURI_SIGNING_RPM_KEY:-}" ] || die "a release build needs TAURI_SIGNING_RPM_KEY (RPM signature)"
  [ "${SPECTRA_GLIBC_FLOOR:-2.35}" = "2.35" ] || die "a release build runs with the glibc floor 2.35, not $SPECTRA_GLIBC_FLOOR"
  require_tool rpmkeys
fi

step() {
  echo "==> $*"
  "$@" || die "step failed: $*"
}

step sh "$REPO_ROOT/scripts/setup-python-embed.sh"
step sh "$REPO_ROOT/scripts/bundle-icc.sh"
step sh "$REPO_ROOT/scripts/sync-edit-fonts.sh"
step sh "$REPO_ROOT/scripts/sync-signature-fonts.sh"
step sh "$REPO_ROOT/scripts/bundle-libreoffice.sh"
step sh "$REPO_ROOT/scripts/bundle-tesseract.sh"
step sh "$REPO_ROOT/scripts/bundle-jbig2enc.sh"
step sh "$REPO_ROOT/scripts/bundle-dictionaries.sh"
step sh "$REPO_ROOT/scripts/bundle-voikko.sh"
step node "$REPO_ROOT/scripts/sync-ocr-assets.mjs"
step node "$REPO_ROOT/scripts/sync-pdfjs-assets.mjs"

if find "$LINUX_RESOURCES" -path "$FETCH_CACHE" -prune -o -type f -iname '*.dll' -print | grep -q .; then
  die "a Windows DLL is under $LINUX_RESOURCES"
fi

rm -rf "$BUNDLE/deb" "$BUNDLE/rpm" "$OUT"
(cd "$REPO_ROOT" && step npx tauri build --bundles deb,rpm) || exit 1

set -- "$BUNDLE"/deb/spectrapdf_*_amd64.deb
[ $# -eq 1 ] && [ -f "$1" ] || die "expected one .deb in $BUNDLE/deb"
DEB="$1"
set -- "$BUNDLE"/rpm/spectrapdf-*-1.x86_64.rpm
[ $# -eq 1 ] && [ -f "$1" ] || die "expected one .rpm in $BUNDLE/rpm"
RPM="$1"
VERSION="$(dpkg-deb -f "$DEB" Version)"
[ "$(basename "$RPM")" = "spectrapdf-$VERSION-1.x86_64.rpm" ] || die "$(basename "$RPM") does not carry the .deb version $VERSION"

if [ -n "${TAURI_SIGNING_RPM_KEY:-}" ]; then
  report="$(rpmkeys -Kv "$RPM" 2>&1 || true)"
  printf '%s\n' "$report" | grep -Eqi 'header .*signature' ||
    die "the .rpm carries no header signature:
$report"
  echo "RPM: header signature present (scripts/verify-rpm-signature.sh verifies it on rpm 4.18+)"
fi

# smoke LABEL COMMAND...: the built CLI validates the fixture.
smoke() {
  label="$1"; shift
  report="$("$@" check "$FIXTURE")" || die "$label: the built CLI failed"
  printf '%s' "$report" | python3 -c '
import json, sys
report = json.load(sys.stdin)
sys.exit(0 if report.get("valid") is True and report.get("size_bytes", 0) > 0 else 1)
' || die "$label: the built CLI did not validate the fixture: $report"
  echo "$label: CLI check passed"
}

work="$BUNDLE/.smoke"
rm -rf "$work"
mkdir -p "$work/deb"
dpkg-deb -x "$DEB" "$work/deb"
step env SPECTRA_GLIBC_FLOOR="${SPECTRA_GLIBC_FLOOR:-2.35}" sh "$REPO_ROOT/scripts/verify-appimage-contents.sh" --deb-payload "$work/deb"
smoke ".deb payload" "$work/deb/usr/bin/spectrapdf"
rm -rf "$work"

mkdir -p "$OUT"
cp "$DEB" "$RPM" "$OUT/"
echo "Done. Linux packages in $OUT:"
(cd "$OUT" && ls -l)
