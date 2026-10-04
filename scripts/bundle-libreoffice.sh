#!/bin/sh
# Vendors LibreOffice for Linux x86-64 into resources/linux-x86_64/libreoffice/.
# POSIX counterpart of bundle-libreoffice.ps1.
#
# Source: the official The Document Foundation Linux x86-64 .deb archive for the
# same release the Windows script pins, verified against the SHA-256 TDF
# publishes beside it. The packages are unpacked, never installed: the tree
# under opt/libreoffice<major.minor>/ is relocatable, and program/, share/ and
# presets/ are copied out exactly as the Windows script copies them out of the
# administrative install. The desktop-menu package is not unpacked.
#
#   sh scripts/bundle-libreoffice.sh            vendor, then run the notice gate
#   sh scripts/bundle-libreoffice.sh --gate-only [tree]

. "$(dirname "$0")/posix-common.sh"
github_token_unexport

VERSION="26.2.5"
ARCHIVE_VERSION="26.2.5.2"
SHA256="2f03bfb2ac9f33ea7c77331b4b7a23300fb0ed7443566046bf8b5bc51c1bed1e"
NAME="LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz"
URLS="https://ftp.osuosl.org/pub/tdf/libreoffice/stable/$VERSION/deb/x86_64/$NAME
https://download.documentfoundation.org/libreoffice/stable/$VERSION/deb/x86_64/$NAME
https://downloadarchive.documentfoundation.org/libreoffice/old/$ARCHIVE_VERSION/deb/x86_64/LibreOffice_${ARCHIVE_VERSION}_Linux_x86-64_deb.tar.gz"
MANIFEST="$REPO_ROOT/scripts/libreoffice-notices.tsv"
DEST="$LINUX_RESOURCES/libreoffice"
APP_FONTS="$RESOURCES_ROOT/fonts"
STAMP="$LINUX_RESOURCES/.stamps/libreoffice"

# The official build links Mozilla NSS and NSPR from the host; they are not a
# desktop baseline, so the tree carries them beside its own libraries. Ubuntu
# 22.04 (jammy-security) packages, pinned to the SHA-256 in the archive's
# signed index: the Linux build base is Ubuntu 22.04, and a library built on a
# newer release raises the glibc floor of the whole package above 2.35. The
# archive pool drops a build once a newer security build supersedes it, so
# each package also names the Launchpad librarian copy of the same file.
UBUNTU_POOL="http://archive.ubuntu.com/ubuntu/pool/main"
SECURITY_POOL="http://security.ubuntu.com/ubuntu/pool/main"
LAUNCHPAD_FILES="https://launchpad.net/ubuntu/+archive/primary/+files"
NSS_DEB="libnss3_3.98-0ubuntu0.22.04.4_amd64.deb"
NSS_SHA256="caf60f375adbbdafef74930c5dd91411de0ac5c9499bf699185110dc77d82611"
NSS_URLS="$UBUNTU_POOL/n/nss/$NSS_DEB $SECURITY_POOL/n/nss/$NSS_DEB $LAUNCHPAD_FILES/$NSS_DEB"
NSPR_DEB="libnspr4_4.35-0ubuntu0.22.04.1_amd64.deb"
NSPR_SHA256="b3c96e4a61675c87f8d9655109346748847d859abc95f20493159d06b5aa30ef"
NSPR_URLS="$UBUNTU_POOL/n/nspr/$NSPR_DEB $SECURITY_POOL/n/nspr/$NSPR_DEB $LAUNCHPAD_FILES/$NSPR_DEB"
# NSS's softoken keeps its key database in SQLite.
SQLITE_DEB="libsqlite3-0_3.37.2-2ubuntu0.8_amd64.deb"
SQLITE_SHA256="6e22b1e8d375fed6a1d52cad5887e762b6cdeaba137595e726c95486968dfab5"
SQLITE_URLS="$UBUNTU_POOL/s/sqlite3/$SQLITE_DEB $SECURITY_POOL/s/sqlite3/$SQLITE_DEB $LAUNCHPAD_FILES/$SQLITE_DEB"

# fetch_first NAME SHA256 URL... -> the cached path from the first source that
# serves the pinned bytes.
fetch_first() {
  name="$1"; want="$2"; shift 2
  for url in "$@"; do
    if got="$( (fetch_verified "$url" "$want" "$name") )"; then
      echo "$got"
      return 0
    fi
    echo "  exhausted $url; trying the next source..." >&2
  done
  die "$name download failed on every source"
}

# Libraries a desktop session provides and the tree takes from the host.
HOST_SONAMES="libc.so.6 libm.so.6 libpthread.so.0 libdl.so.2 librt.so.1 ld-linux-x86-64.so.2
libstdc++.so.6 libgcc_s.so.1 libz.so.1
libX11.so.6 libX11-xcb.so.1 libXext.so.6 libXinerama.so.1 libXrandr.so.2 libXrender.so.1
libxcb.so.1 libICE.so.6 libSM.so.6 libdbus-1.so.3 libcairo.so.2 libfontconfig.so.1
libfreetype.so.6 libglib-2.0.so.0 libgobject-2.0.so.0 libgio-2.0.so.0 libgmodule-2.0.so.0
libcups.so.2 libgssapi_krb5.so.2 libkrb5.so.3 libcom_err.so.2
libavahi-client.so.3 libavahi-common.so.3"

# Toolkit and optional-feature modules, loaded only when that desktop toolkit,
# media backend, Java bean or database driver is selected. A headless
# conversion never loads them, so their host libraries are not a requirement.
OPTIONAL_MODULES="libvclplug_gtk3lo.so libvclplug_gtk3_kde5lo.so libvclplug_gtk4lo.so
libvclplug_kf5lo.so libvclplug_qt5lo.so libvclplug_qt6lo.so libkf5be1lo.so lo_kde5filepicker
liblibreofficekitgtk.so libavmediagst.so libavmediagtk.so libavmediaqt6.so libofficebean.so
libmysqlclo.so libpostgresql-sdbc-impllo.so"

# host_gate PROGRAM_DIR: every NEEDED entry of a non-optional ELF file resolves
# inside the tree or to the host baseline above.
host_gate() {
  problems=""
  for f in "$1"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    case " $(echo $OPTIONAL_MODULES) " in *" $name "*) continue ;; esac
    head -c4 "$f" | grep -q 'ELF' || continue
    for need in $(readelf -d "$f" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p'); do
      [ -e "$1/$need" ] && continue
      case " $(echo $HOST_SONAMES) " in *" $need "*) continue ;; esac
      problems="$problems
  $name needs $need, which is neither in the tree nor in the host baseline"
    done
  done
  [ -z "$problems" ] || die "host-library gate refused:$problems"
}

# assert_notices TREE: every manifest row for this platform is present, carries
# its pinned hash, and names a notice that ships.
assert_notices() {
  tree="$1"
  [ -f "$MANIFEST" ] || die "notice manifest not found: $MANIFEST"
  awk -F'\t' -v tree="$tree" '
    /^#/ || !NF { next }
    !header { header = 1; next }
    {
      platform = (NF >= 8 && $8 != "") ? $8 : "all"
      if (platform != "all" && platform != "linux") next
      rows++
      file[rows] = $1; comp[rows] = $2; role[rows] = $3; sha[rows] = $4
      spdx[rows] = $5; notice[rows] = $6; src[rows] = $7
      if ($3 == "notice") { n = split($1, parts, "/"); notices[parts[n]] = 1 }
      if ($3 == "binary") binaries++
    }
    END {
      if (!header) { print "  the manifest has no header row"; exit }
      for (i = 1; i <= rows; i++) {
        if (comp[i] == "") print "  " file[i] ": no component"
        if (src[i] == "") print "  " file[i] ": no source"
        if (role[i] != "binary" && role[i] != "data" && role[i] != "notice")
          print "  " file[i] ": unknown role \x27" role[i] "\x27"
        if (role[i] != "notice") {
          if (spdx[i] == "" || spdx[i] == "-") print "  " file[i] ": no SPDX expression"
          if (notice[i] == "" || notice[i] == "-") print "  " file[i] ": names no notice file"
          else if (!(notice[i] in notices))
            print "  " file[i] ": names notice \x27" notice[i] "\x27, which no notice row ships"
        }
        if (sha[i] != "-" && (length(sha[i]) != 64 || sha[i] ~ /[^0-9a-f]/))
          print "  " file[i] ": sha256 is neither \x27-\x27 nor 64 hex characters"
        print "CHECK\t" file[i] "\t" sha[i]
      }
      if (!binaries) print "  the manifest names no binary for this platform"
    }' "$MANIFEST" > "$tree.gate.tmp"
  problems="$(grep -v '^CHECK' "$tree.gate.tmp" || true)"
  checked=0
  while IFS="$(printf '\t')" read -r tag file sha; do
    [ "$tag" = "CHECK" ] || continue
    checked=$((checked + 1))
    if [ ! -e "$tree/$file" ]; then
      problems="$problems
  $file: the vendored tree does not carry it"
    elif [ "$sha" != "-" ]; then
      got="$(sha256_of "$tree/$file")"
      [ "$got" = "$sha" ] || problems="$problems
  $file: sha256 $got, manifest pins $sha"
    fi
  done < "$tree.gate.tmp"
  rm -f "$tree.gate.tmp"
  [ -z "$problems" ] || die "LibreOffice notice gate refused:$problems"
  echo "Notice gate: $checked manifest rows verified against $tree"
}

if [ "${1:-}" = "--gate-only" ]; then
  assert_notices "${2:-$DEST}"
  exit 0
fi

require_tool curl sha256sum tar dpkg-deb readelf

if [ -x "$DEST/program/soffice" ] && [ -f "$STAMP" ] &&
   [ "$(cat "$STAMP")" = "$SHA256 $NSS_SHA256 $NSPR_SHA256 $SQLITE_SHA256" ] &&
   (assert_notices "$DEST" >/dev/null 2>&1); then
  echo "LibreOffice $ARCHIVE_VERSION already vendored at $DEST"
  assert_notices "$DEST"
  echo "Done. Vendored LibreOffice: $(tree_size "$DEST")"
  exit 0
fi

set -- $URLS
archive=""
for url in "$@"; do
  if archive="$( (fetch_verified "$url" "$SHA256" "$NAME") )"; then
    break
  fi
  archive=""
  echo "  exhausted $url; trying the next source..." >&2
done
[ -n "$archive" ] || die "LibreOffice download failed on every source"

set -- "$APP_FONTS"/*.ttf "$APP_FONTS"/*.otf "$APP_FONTS"/*.ttc "$APP_FONTS"/*.otc
fonts=""
for f in "$@"; do [ -f "$f" ] && fonts="$fonts $f"; done
[ -n "$fonts" ] || die "No app fonts found at $APP_FONTS; run scripts/sync-edit-fonts.sh first."

work="$LINUX_RESOURCES/.lo-work"
rm -rf "$work"
mkdir -p "$work/debs" "$work/root"
tar -xzf "$archive" -C "$work/debs"
found=0
for deb in "$work"/debs/*/DEBS/*.deb; do
  case "$(basename "$deb")" in *-debian-menus_*) continue ;; esac
  version="$(dpkg-deb -f "$deb" Version)"
  case "$version" in
    "$ARCHIVE_VERSION"-*) ;;
    *) die "$(basename "$deb") is version $version, not $ARCHIVE_VERSION" ;;
  esac
  dpkg-deb -x "$deb" "$work/root"
  found=$((found + 1))
done
[ "$found" -gt 0 ] || die "the archive carried no packages"

root=""
for d in "$work"/root/opt/libreoffice*; do [ -x "$d/program/soffice" ] && root="$d"; done
[ -n "$root" ] || die "program/soffice not found in the unpacked packages"

nss="$(fetch_first "$NSS_DEB" "$NSS_SHA256" $NSS_URLS)"
nspr="$(fetch_first "$NSPR_DEB" "$NSPR_SHA256" $NSPR_URLS)"
sqlite="$(fetch_first "$SQLITE_DEB" "$SQLITE_SHA256" $SQLITE_URLS)"
mkdir -p "$work/nss"
dpkg-deb -x "$nss" "$work/nss"
dpkg-deb -x "$nspr" "$work/nss"
dpkg-deb -x "$sqlite" "$work/nss"

rm -rf "$DEST"
mkdir -p "$DEST"
for sub in program share presets; do
  [ -d "$root/$sub" ] && cp -a "$root/$sub" "$DEST/$sub"
done
mkdir -p "$DEST/share/fonts/truetype"
count=0
for f in $fonts; do
  cp "$f" "$DEST/share/fonts/truetype/"
  count=$((count + 1))
done
echo "Staged $count app fonts for LibreOffice's private font registry."
for lic in LICENSE license.txt LICENSE.html; do
  if [ -f "$root/$lic" ]; then
    cp "$root/$lic" "$DEST/LICENSE"
    break
  fi
done

# NSS loads its softoken and freebl modules from its own directory, so every
# library of these packages lands in program/ beside the libraries that need it.
multiarch="$work/nss/usr/lib/x86_64-linux-gnu"
for lib in "$multiarch"/*.so "$multiarch"/libsqlite3.so.0 "$multiarch"/nss/*.so "$multiarch"/nss/*.chk; do
  [ -f "$lib" ] && cp -L "$lib" "$DEST/program/"
done
mkdir -p "$DEST/licenses"
cp "$work/nss/usr/share/doc/libnss3/copyright" "$DEST/licenses/copyright-nss"
cp "$work/nss/usr/share/doc/libnspr4/copyright" "$DEST/licenses/copyright-nspr"
cp "$work/nss/usr/share/doc/libsqlite3-0/copyright" "$DEST/licenses/copyright-sqlite"
rm -rf "$work"

host_gate "$DEST/program"
assert_notices "$DEST"
mkdir -p "$(dirname "$STAMP")"
echo "$SHA256 $NSS_SHA256 $NSPR_SHA256 $SQLITE_SHA256" > "$STAMP"
echo "Done. Vendored LibreOffice $ARCHIVE_VERSION: $(tree_size "$DEST")"
