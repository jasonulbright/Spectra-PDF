#!/bin/sh
# Vendors the Linux x86-64 JBIG2 encoder into resources/linux-x86_64/jbig2enc/:
# the pinned jbig2enc 0.32 artifact published by the fork's release, unpacked as
# published (bin/jbig2, lib/, licenses/ with the PATENTS note, NOTICES.tsv,
# SHA256SUMS.txt).
#
#   sh scripts/bundle-jbig2enc.sh

. "$(dirname "$0")/posix-common.sh"
require_tool curl sha256sum tar awk

ARTIFACT_URL="https://github.com/jasonulbright/jbig2enc/releases/download/spectra-0.32-2/jbig2enc-0.32-linux-x86_64.tar.zst"
ARTIFACT_SHA256="db4695b90b507867818259d6b7b3b95ebbeb0a567bb899687ac339aa456440ef"
ARTIFACT_SIZE="2196628"
MANIFEST="$REPO_ROOT/scripts/jbig2enc-licenses.tsv"
DEST="$LINUX_RESOURCES/jbig2enc"

install_artifact "$ARTIFACT_URL" "$ARTIFACT_SHA256" "$ARTIFACT_SIZE" \
  "jbig2enc-0.32-linux-x86_64.tar.zst" "$DEST"
rm -rf "$DEST.old"

notice_gate "$MANIFEST" "$DEST" '$1 ~ /^(bin|lib)\//' 1 5 0

"$DEST/bin/jbig2" --version >/dev/null 2>&1 || die "$DEST/bin/jbig2 does not run on this host"
echo "Done. jbig2enc 0.32 at $DEST ($(tree_size "$DEST"))"
