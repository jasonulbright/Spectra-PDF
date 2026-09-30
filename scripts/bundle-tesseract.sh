#!/bin/sh
# Vendors the Linux x86-64 OCR runtime into resources/linux-x86_64/tesseract/:
# the pinned Tesseract 5.4.0 artifact published by the fork's release, unpacked
# as published (bin/, lib/, share/tessdata/, licenses/, NOTICES.tsv,
# SHA256SUMS.txt), plus the two models bundle-tesseract.ps1 installs from the
# Windows installer (osd and eng, tessdata_fast 4.1.0, byte-identical to that
# installer's copies). Language models already in the tree survive a re-vendor;
# scripts/sync-ocr-assets.mjs stages the rest.
#
#   sh scripts/bundle-tesseract.sh

. "$(dirname "$0")/posix-common.sh"
require_tool curl sha256sum tar awk

ARTIFACT_URL="https://github.com/jasonulbright/tesseract/releases/download/spectra-5.4.0-3/tesseract-5.4.0-linux-x86_64.tar.zst"
ARTIFACT_SHA256="9c74148edb6abb4734351bfb23aab0d088b15abc23eba4a90addad3434a8c420"
ARTIFACT_SIZE="3850001"
OSD_URL="https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/osd.traineddata"
OSD_SHA256="9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff"
ENG_URL="https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata"
ENG_SHA256="7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"
MANIFEST="$REPO_ROOT/scripts/tesseract-licenses.tsv"
DEST="$LINUX_RESOURCES/tesseract"

install_artifact "$ARTIFACT_URL" "$ARTIFACT_SHA256" "$ARTIFACT_SIZE" \
  "tesseract-5.4.0-linux-x86_64.tar.zst" "$DEST"
TESSDATA="$DEST/share/tessdata"

# A re-vendor keeps the models of the tree it replaces, from this layout or the
# earlier flat one (tessdata/ beside the program).
if [ -d "$DEST.old" ]; then
  for old in "$DEST.old/share/tessdata" "$DEST.old/tessdata"; do
    [ -d "$old" ] || continue
    for model in "$old"/*.traineddata; do
      if [ -f "$model" ]; then cp -p "$model" "$TESSDATA/"; fi
    done
  done
  rm -rf "$DEST.old"
fi

# The tsv config is how the engine reads word boxes; without it recognition
# exits 0 and prints plain text.
[ -f "$TESSDATA/configs/tsv" ] || die "share/tessdata/configs/tsv is missing from the artifact"

for pin in "osd $OSD_URL $OSD_SHA256" "eng $ENG_URL $ENG_SHA256"; do
  set -- $pin
  if [ ! -f "$TESSDATA/$1.traineddata" ]; then
    cp "$(fetch_verified "$2" "$3" "$1-4.1.0-fast.traineddata")" "$TESSDATA/$1.traineddata"
  fi
done
[ "$(sha256_of "$TESSDATA/osd.traineddata")" = "$OSD_SHA256" ] \
  || die "share/tessdata/osd.traineddata differs from its pin; delete it and run again"

notice_gate "$MANIFEST" "$DEST" '$1 ~ /^(bin|lib)\//' 1 4 0

"$DEST/bin/tesseract" --version >/dev/null 2>&1 || die "$DEST/bin/tesseract does not run on this host"
echo "Done. Tesseract 5.4.0 at $DEST ($(tree_size "$DEST"))"
