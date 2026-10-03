#!/bin/sh
# Installs the built Linux packages on a system without WebKitGTK or GTK
# installed and runs the installed CLI against the fixture. Runs as root, from
# the repository root (keys/, scripts/ and tests/fixtures/sample.pdf).
#
#   sh scripts/linux-install-smoke.sh DIR STEP...
#
# DIR holds the release's AppImage, .deb and .rpm. Steps run in the order given:
#   --bare-cli               on a system without WebKitGTK and GTK 3 (run before
#                            any package installs them), the AppImage passes the
#                            CLI check
#   --deb                    apt-get install the .deb, then the CLI check
#   --rpm                    verify the .rpm signature, dnf install it, then the CLI check
#   --icc-assent             after --deb or --rpm: the installed CLI records the
#                            colour-profile answer in the per-user configuration
#                            folder of a scratch HOME, reads it back as accepted,
#                            and writes nothing beside the executable
#   --appimage               the AppImage (extract-and-run) passes the CLI check
#   --ghostscript            the distribution's ghostscript package is installed,
#                            `gs --version` is 10 or newer, and the installed CLI
#                            compresses the fixture through it

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
    --bare-cli)
      appimage="$(one 'spectrapdf_*_amd64.AppImage')"
      chmod 0755 "$appimage"
      if ldconfig -p | grep -E 'libwebkit2gtk-4\.1\.so|libgtk-3\.so'; then
        die "this system has WebKitGTK 4.1 or GTK 3; --bare-cli needs a system without them"
      fi
      cli_check "AppImage without WebKitGTK and GTK 3" env APPIMAGE_EXTRACT_AND_RUN=1 "$appimage"
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
    --icc-assent)
      [ -x /usr/bin/spectrapdf ] || die "--icc-assent needs --deb or --rpm first"
      home="$(mktemp -d)"
      record="$home/.config/com.spectrapdf.app/icc-assent.json"
      assent() {
        env -u XDG_CONFIG_HOME HOME="$home" /usr/bin/spectrapdf icc-assent "$@"
      }
      report="$(assent --status)" || die "icc-assent --status failed"
      printf '%s\n' "$report" | grep -Eq '^  "container": "package",?$' ||
        die "the installed copy is not the package container:
$report"
      printf '%s\n' "$report" | grep -Eq '^  "assent": "unrecorded",?$' ||
        die "a fresh HOME already has an answer:
$report"
      assent --accept >/dev/null || die "icc-assent --accept failed"
      [ -f "$record" ] || die "the answer is not in $record"
      report="$(assent --status)" || die "icc-assent --status failed after --accept"
      printf '%s\n' "$report" | grep -Eq '^  "assent": "accepted",?$' ||
        die "the recorded answer does not read back as accepted:
$report"
      printf '%s\n' "$report" | grep -Fq "\"record\": \"$record\"" ||
        die "the status names another record:
$report"
      [ ! -e /usr/bin/data ] || die "the CLI wrote beside the executable: /usr/bin/data"
      echo "icc-assent: recorded in $record and read back as accepted"
      ;;
    --appimage)
      appimage="$(one 'spectrapdf_*_amd64.AppImage')"
      chmod 0755 "$appimage"
      cli_check "AppImage" env APPIMAGE_EXTRACT_AND_RUN=1 "$appimage"
      ;;
    --ghostscript)
      if command -v dpkg >/dev/null 2>&1 && dpkg -s ghostscript >/dev/null 2>&1; then
        echo "ghostscript: installed (dpkg)"
      elif command -v rpm >/dev/null 2>&1 && rpm -q ghostscript >/dev/null 2>&1; then
        echo "ghostscript: installed (rpm)"
      else
        die "the distribution's ghostscript package is not installed"
      fi
      version="$(gs --version)" || die "gs --version failed"
      major="${version%%.*}"
      case "$major" in
        ''|*[!0-9]*) die "gs --version printed '$version'" ;;
      esac
      [ "$major" -ge 10 ] || die "gs $version is older than 10"
      out="$(mktemp -d)/compressed.pdf"
      /usr/bin/spectrapdf compress "$FIXTURE" -o "$out" --quality ebook ||
        die "the installed CLI could not compress through gs $version"
      [ -s "$out" ] || die "the installed CLI wrote no compressed output"
      echo "ghostscript: gs $version compresses the fixture"
      ;;
    *)
      die "unknown step: $step"
      ;;
  esac
done
