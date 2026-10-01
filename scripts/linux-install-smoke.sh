#!/bin/sh
# Installs the built Linux packages on a clean distribution container and runs
# the installed CLI against the fixture. Runs as root inside the container,
# from the repository root (keys/, scripts/ and tests/fixtures/sample.pdf).
#
#   sh scripts/linux-install-smoke.sh DIR STEP...
#
# DIR holds the release's AppImage, .deb and .rpm. Steps run in the order given:
#   --expect-missing-webkit  the AppImage exits 127 and names libwebkit2gtk-4.1.so.0
#                            (run before any package installs WebKitGTK)
#   --deb                    apt-get install the .deb, then the CLI check
#   --rpm                    verify the .rpm signature, dnf install it, then the CLI check
#   --appimage               the AppImage (extract-and-run) passes the CLI check

set -eu

die() {
  echo "error: $*" >&2
  exit 1
}

[ $# -ge 2 ] || die "usage: linux-install-smoke.sh DIR STEP..."
DIR="$1"; shift
FIXTURE="tests/fixtures/sample.pdf"
[ -f "$FIXTURE" ] || die "run from the repository root: $FIXTURE is missing"

# one PATTERN -> the single file in DIR matching it.
one() {
  set -- "$DIR"/$1
  [ $# -eq 1 ] && [ -f "$1" ] || die "expected one $(basename "$1") in $DIR"
  echo "$1"
}

# installable FILE -> the path apt and dnf read as a local package.
installable() {
  case "$1" in
    /*) echo "$1" ;;
    *) echo "./$1" ;;
  esac
}

# cli_check LABEL COMMAND...: the report's top-level `valid` is true and
# `size_bytes` is positive. The report is pretty-printed JSON, so top-level
# keys are the lines indented by exactly two spaces.
cli_check() {
  label="$1"; shift
  report="$("$@" check "$FIXTURE")" || die "$label: the CLI failed"
  printf '%s\n' "$report" | grep -Eq '^  "valid": true,?$' &&
    printf '%s\n' "$report" | grep -Eq '^  "size_bytes": [1-9][0-9]*,?$' ||
    die "$label: the CLI did not validate the fixture:
$report"
  echo "$label: CLI check passed"
}

for step in "$@"; do
  case "$step" in
    --expect-missing-webkit)
      appimage="$(one 'spectrapdf_*_amd64.AppImage')"
      chmod 0755 "$appimage"
      set +e
      out="$(APPIMAGE_EXTRACT_AND_RUN=1 "$appimage" check "$FIXTURE" 2>&1)"
      code=$?
      set -e
      [ "$code" -eq 127 ] || die "AppImage without WebKitGTK exited $code, expected 127:
$out"
      printf '%s\n' "$out" | grep -Fq libwebkit2gtk-4.1.so.0 ||
        die "AppImage without WebKitGTK did not name libwebkit2gtk-4.1.so.0:
$out"
      echo "AppImage without WebKitGTK: exit 127, missing library named"
      ;;
    --deb)
      deb="$(one 'spectrapdf_*_amd64.deb')"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends "$(installable "$deb")"
      cli_check ".deb" /usr/bin/spectrapdf
      ;;
    --rpm)
      rpm="$(one 'spectrapdf-*-1.x86_64.rpm')"
      sh scripts/verify-rpm-signature.sh "$rpm"
      dnf -y install "$(installable "$rpm")"
      cli_check ".rpm" /usr/bin/spectrapdf
      ;;
    --appimage)
      appimage="$(one 'spectrapdf_*_amd64.AppImage')"
      chmod 0755 "$appimage"
      cli_check "AppImage" env APPIMAGE_EXTRACT_AND_RUN=1 "$appimage"
      ;;
    *)
      die "unknown step: $step"
      ;;
  esac
done
