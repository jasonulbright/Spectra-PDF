#!/bin/sh
# Vendors the signature script faces into resources/fonts/. POSIX counterpart
# of sync-signature-fonts.ps1, with the same pinned commit and hashes.
#
#   sh scripts/sync-signature-fonts.sh

. "$(dirname "$0")/posix-common.sh"
github_token_unexport
require_tool curl sha256sum

COMMIT="ec626514f79f831f1ab848a82114a0ce7e2d6372"
BASE="https://raw.githubusercontent.com/google/fonts/$COMMIT/ofl"
DEST="$RESOURCES_ROOT/fonts"
TAB="$(printf '\t')"

# upstream path <TAB> shipped name <TAB> sha256
WANTED="greatvibes/GreatVibes-Regular.ttf	GreatVibes-Regular.ttf	8d509802186f1b51572531ecf313e8098f9a5bfdfaca93f0c9b34467f9982d15
greatvibes/OFL.txt	LICENSE-GreatVibes-OFL.txt	61093a21f5e63dedf54222b3c09997e54c0fe43e3851d21386e02ddcbc246d49
sacramento/Sacramento-Regular.ttf	Sacramento-Regular.ttf	9341fda10adbfeb7efc94302b34507a3e227d7e7f5c432df3f5ac8753ff73d24
sacramento/OFL.txt	LICENSE-Sacramento-OFL.txt	2e2cb5a98da665f2ab82a9fd01fb18c2337f845761b0c163f690ed65f3b94677
parisienne/Parisienne-Regular.ttf	Parisienne-Regular.ttf	bc9ee17f022e20bc700797e5f557d14bfa43af0c98d9e6c9c5c1ca4ec7aacd57
parisienne/OFL.txt	LICENSE-Parisienne-OFL.txt	1dd84b611f4bed7f9ff9089e76a96337b187e6f283a4ab33bcb987f844f2c4db"

missing="$(printf '%s\n' "$WANTED" | while IFS="$TAB" read -r _in name sha; do
  [ -f "$DEST/$name" ] && [ "$(sha256_of "$DEST/$name")" = "$sha" ] || echo "$name"
done)"
if [ -z "$missing" ]; then
  echo "All signature faces present and verified in $DEST"
  exit 0
fi
mkdir -p "$DEST"
printf '%s\n' "$WANTED" | while IFS="$TAB" read -r upstream name sha; do
  cp "$(fetch_verified "$BASE/$upstream" "$sha" "signature-$COMMIT-$name")" "$DEST/$name"
  echo "Vendored: $DEST/$name"
done
