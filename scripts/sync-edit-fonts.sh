#!/bin/sh
# Vendors the bundled edit, fallback, CJK and right-to-left faces into
# resources/fonts/. POSIX counterpart of sync-edit-fonts.ps1, with the same
# pins: every archive and every extracted file is checked against its SHA-256
# before it is used. tests/test_posix_bundle_scripts.py holds the two scripts
# to one pin set.
#
#   sh scripts/sync-edit-fonts.sh

. "$(dirname "$0")/posix-common.sh"
require_tool curl sha256sum tar python3

DEST="$RESOURCES_ROOT/fonts"

LIB_VERSION="2.1.5"
LIB_URL="https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-$LIB_VERSION.tar.gz"
LIB_SHA256="7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0"
LIBERTINUS_VERSION="7.051"
LIBERTINUS_URL="https://github.com/alerque/libertinus/releases/download/v$LIBERTINUS_VERSION/Libertinus-$LIBERTINUS_VERSION.zip"
LIBERTINUS_SHA256="4d9be29b5cb380c35af8ba967abcc752ad1e07be1f738a9789c33e0dd7478c92"
NOTO_CJK_BASE="https://github.com/notofonts/noto-cjk/raw/Sans2.004"

# archive-member <TAB> shipped name <TAB> sha256, one table per source archive.
LIBERATION_FILES="LiberationSans-Regular.ttf	LiberationSans-Regular.ttf	76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8
LiberationSans-Bold.ttf	LiberationSans-Bold.ttf	788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173
LiberationSans-Italic.ttf	LiberationSans-Italic.ttf	e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0
LiberationSans-BoldItalic.ttf	LiberationSans-BoldItalic.ttf	698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee
LiberationSerif-Regular.ttf	LiberationSerif-Regular.ttf	058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74
LiberationSerif-Bold.ttf	LiberationSerif-Bold.ttf	d754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce
LiberationSerif-Italic.ttf	LiberationSerif-Italic.ttf	0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e
LiberationSerif-BoldItalic.ttf	LiberationSerif-BoldItalic.ttf	f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7
LiberationMono-Regular.ttf	LiberationMono-Regular.ttf	f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1
LiberationMono-Bold.ttf	LiberationMono-Bold.ttf	bd62a0672d0b9b6710b01df434c80ad54fa5f0835207eb7b17b7a761463067bb
LiberationMono-Italic.ttf	LiberationMono-Italic.ttf	605c01c711b44480a7508d349dfbf3264e81fa43d69e61cfa7d10b86e764c4d1
LiberationMono-BoldItalic.ttf	LiberationMono-BoldItalic.ttf	79451f3c09fe25116098853b7a2ca6e2436220ccc11af022979adbcf195be130
LICENSE	LICENSE-Liberation-OFL.txt	93fed46019c38bbe566b479d22148e2e8a1e85ada614accb0211c37b2c61c19b"
LIBERTINUS_FILES="LibertinusSerif-Regular.otf	LibertinusSerif-Regular.otf	fcf06307a77367394fcb0ccb241e59eea70dba3d732be309647611224679c733
LibertinusSerif-Bold.otf	LibertinusSerif-Bold.otf	0264914210ed51b3231ebc92ce529e9f2e166ba9eebf0cd4a579558690a27b64
LibertinusSerif-Italic.otf	LibertinusSerif-Italic.otf	9a393d63d6e05f620d3dc0190dfd35a8ede58c0808cf0fc9de7fcb9c723e4c24
LibertinusSerif-BoldItalic.otf	LibertinusSerif-BoldItalic.otf	47a665259f09f554f5d133d7718cdad43ff462c6a6b2328f38023465e62d57ce
OFL.txt	LICENSE-Libertinus-OFL.txt	9aeecc8107c489ec1ec0068b0313e531a760edf3493705b32ab8ab8215a8794e"
# Direct downloads: URL <TAB> shipped name <TAB> sha256.
CJK_FILES="$NOTO_CJK_BASE/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf	NotoSansCJKsc-Regular.otf	2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b
$NOTO_CJK_BASE/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf	NotoSansCJKsc-Bold.otf	b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a
$NOTO_CJK_BASE/LICENSE	LICENSE-NotoCJK.txt	6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2"
# Right-to-left and Mongolian archives: URL <TAB> archive sha256, then the
# member table (exact archive path <TAB> shipped name <TAB> sha256).
PLEX_URL="https://github.com/IBM/plex/releases/download/%40ibm%2Fplex-sans-arabic%401.1.0/ibm-plex-sans-arabic.zip"
PLEX_SHA256="f03915581aea37d82792c188b08064023a73494d679b8e19f85f5971db714013"
PLEX_FILES="ibm-plex-sans-arabic/fonts/complete/ttf/IBMPlexSansArabic-Regular.ttf	IBMPlexSansArabic-Regular.ttf	8e0f1046c736bf939d4939ee3ae0116acf61cbcd6592deae7656761627080981
ibm-plex-sans-arabic/fonts/complete/ttf/IBMPlexSansArabic-Bold.ttf	IBMPlexSansArabic-Bold.ttf	b74f809dead12442ed56e02a12c3bcc02076c9ad4e32f17d0a9ca6fc1aafc89e
ibm-plex-sans-arabic/LICENSE.txt	LICENSE-IBMPlexArabic-OFL.txt	7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da"
HEBREW_URL="https://github.com/notofonts/hebrew/releases/download/NotoSansHebrew-v3.001/NotoSansHebrew-v3.001.zip"
HEBREW_SHA256="df0a71814b4e63644cf40fcc4529111b61266b7a2dafbe95068b29a7520cc3cb"
HEBREW_FILES="NotoSansHebrew/unhinted/ttf/NotoSansHebrew-Regular.ttf	NotoSansHebrew-Regular.ttf	04272f5600d0ec816d31d0df73b23aa8d3501ea359ebe820da31c11ffcf00853
NotoSansHebrew/unhinted/ttf/NotoSansHebrew-Bold.ttf	NotoSansHebrew-Bold.ttf	dfdb3056de1f4542b888c77a1a8a750548a802e271479f56e52152423b64dde8
OFL.txt	LICENSE-NotoHebrew-OFL.txt	9b9fe028b5ba74d231659a1bbaf0ed09b11e759d1ca6a070999e16d151616b47"
MONGOLIAN_URL="https://github.com/notofonts/mongolian/releases/download/NotoSansMongolian-v3.002/NotoSansMongolian-v3.002.zip"
MONGOLIAN_SHA256="a5d3085d4040ecd92d44bf5c4f8faaeae7ba3147cf82e09aa2ef5ad46475de6c"
MONGOLIAN_FILES="NotoSansMongolian/full/ttf/NotoSansMongolian-Regular.ttf	NotoSansMongolian-Regular.ttf	e458bbdef2ac9579315293070b8f72abc290a42a0279a99b50a9829a7ccd8245
OFL.txt	LICENSE-NotoMongolian-OFL.txt	b0158b3c0b16c20e22ea662850503a7980111c5c704501e942cc1a7ed12dc011"

TAB="$(printf '\t')"

all_present() {
  printf '%s\n' "$LIBERATION_FILES" "$LIBERTINUS_FILES" "$CJK_FILES" "$PLEX_FILES" "$HEBREW_FILES" "$MONGOLIAN_FILES" |
    while IFS="$TAB" read -r _member name sha; do
      [ -f "$DEST/$name" ] && [ "$(sha256_of "$DEST/$name")" = "$sha" ] || { echo missing; break; }
    done
}

# place FILE NAME SHA256: install one extracted file after verifying it.
place() {
  got="$(sha256_of "$1")"
  [ "$got" = "$3" ] || die "sha256 mismatch for $2: $got"
  cp "$1" "$DEST/$2"
  echo "Vendored: $DEST/$2"
}

# from_tree ROOT TABLE: members are matched by basename anywhere under ROOT.
from_tree() {
  printf '%s\n' "$2" | while IFS="$TAB" read -r member name sha; do
    found="$(find "$1" -type f -name "$member" | head -n1)"
    [ -n "$found" ] || die "$member not found in the release archive"
    place "$found" "$name" "$sha"
  done
}

# unzip_to ARCHIVE DIR: extraction without an unzip dependency.
unzip_to() {
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$1" "$2"
}

if [ -z "$(all_present)" ]; then
  echo "All faces present and verified in $DEST"
  exit 0
fi
mkdir -p "$DEST"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Liberation Fonts $LIB_VERSION..."
mkdir -p "$work/liberation"
tar -xzf "$(fetch_verified "$LIB_URL" "$LIB_SHA256" "liberation-fonts-ttf-$LIB_VERSION.tar.gz")" -C "$work/liberation"
from_tree "$work/liberation" "$LIBERATION_FILES"

echo "Libertinus $LIBERTINUS_VERSION..."
unzip_to "$(fetch_verified "$LIBERTINUS_URL" "$LIBERTINUS_SHA256" "Libertinus-$LIBERTINUS_VERSION.zip")" "$work/libertinus"
from_tree "$work/libertinus" "$LIBERTINUS_FILES"

echo "Noto Sans CJK..."
printf '%s\n' "$CJK_FILES" | while IFS="$TAB" read -r url name sha; do
  place "$(fetch_verified "$url" "$sha" "$name")" "$name" "$sha"
done

for set in PLEX HEBREW MONGOLIAN; do
  eval "url=\$${set}_URL sha=\$${set}_SHA256 table=\$${set}_FILES"
  echo "$set..."
  rm -rf "$work/$set"
  unzip_to "$(fetch_verified "$url" "$sha" "$set-$sha.zip")" "$work/$set"
  printf '%s\n' "$table" | while IFS="$TAB" read -r member name msha; do
    [ -f "$work/$set/$member" ] || die "$member not found in the $set archive"
    place "$work/$set/$member" "$name" "$msha"
  done
done

echo "Done. Fonts: $(tree_size "$DEST") at $DEST"
