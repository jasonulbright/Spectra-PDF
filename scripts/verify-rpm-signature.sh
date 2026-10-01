#!/bin/sh
# Verifies that an .rpm carries a valid signature made with the Spectra PDF
# package signing key (keys/spectrapdf-rpm-signing.pub.asc).
#
#   sh scripts/verify-rpm-signature.sh FILE.rpm
#
# Needs rpm 4.18 or newer. rpm 4.17 (Ubuntu 22.04) reports the bundler's valid
# V4 signatures as "invalid OpenPGP signature", so the check runs on a current
# Fedora, never in the Ubuntu 22.04 build container.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="$REPO_ROOT/keys/spectrapdf-rpm-signing.pub.asc"
FINGERPRINT="5cc064b7833ab9d7404ff1366a868e9e98076374"
KEY_ID="98076374"

die() {
  echo "error: $*" >&2
  exit 1
}

[ $# -eq 1 ] && [ -f "$1" ] || die "usage: verify-rpm-signature.sh FILE.rpm"
command -v rpmkeys >/dev/null 2>&1 && command -v rpm >/dev/null 2>&1 || die "rpm and rpmkeys are required"

db="$(mktemp -d)"
trap 'rm -rf "$db"' EXIT
rpmkeys --dbpath "$db" --import "$KEY" || die "rpmkeys could not import $KEY"
imported="$(rpm --dbpath "$db" -q gpg-pubkey --qf '%{VERSION}\n' | tr 'A-F' 'a-f')"
case "$FINGERPRINT" in
  *"$imported") ;;
  *) die "$KEY is key $imported, not $FINGERPRINT" ;;
esac

report="$(rpmkeys --dbpath "$db" -Kv "$1" 2>&1)" || die "signature check failed:
$report"
if printf '%s\n' "$report" | grep -Eq 'NOT OK|BAD|NOKEY|NOTTRUSTED'; then
  die "signature check failed:
$report"
fi
printf '%s\n' "$report" | grep -i 'signature' | grep -Ei "($FINGERPRINT|key id $KEY_ID).*: OK" >/dev/null ||
  die "no signature by $FINGERPRINT:
$report"
echo "RPM signature OK: $(basename "$1") is signed by $FINGERPRINT"
