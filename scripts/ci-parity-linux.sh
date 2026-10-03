#!/bin/sh
# Local mirror of the Linux release jobs, for scripts/ci-parity-gates.sh. Runs
# on a Linux host from the repository root. The package build, the package
# signatures and the install checks are not mirrored: they need the release
# keys and freshly installed systems. The AppImage build with its contents gate
# and the AppImage catalog gate need environments of their own and run in the
# release workflow: the build deploys the package database of an Arch Linux
# system as root, and the catalog gate removes GTK 3 and WebKitGTK from a
# disposable Ubuntu 22.04 system and installs a setuid firejail as root.
#
#   sh scripts/ci-parity-linux.sh
#
# 1. The AppImage inputs lint (scripts/build-appimage.sh --prepare, then
#    --check). --prepare fetches the five pinned tools once into the download
#    cache. The package allowlist and the sharun pins lint on their own, and
#    the contents gate and the catalog gate parse. scripts/test-image-exec.sh
#    compiles the AppImage's exec library and its spawn trampoline and checks
#    their exec and spawn semantics against the native C library.
# 2. Every Linux vendored tree is at its pin and passes its notice gate. Each
#    script skips the download when its tree already matches its pin.
# 3. cargo check of the app for Linux, all targets, with the Linux config.
#    CARGO_TARGET_DIR defaults to ~/spectra-target, off the shared checkout.
# 4. Every ELF file under resources/linux-x86_64 needs GLIBC_ 2.35 at most, the
#    tree holds no Windows PE file outside the pip/setuptools launcher stubs of
#    the LibreOffice package, and no symbolic link dangles.

. "$(dirname "$0")/posix-common.sh"
require_tool cargo objdump od curl sha256sum python3

FLOOR="2.35"

step() {
  echo "==> $*"
  "$@" || die "step failed: $*"
}

cd "$REPO_ROOT"
step sh scripts/build-appimage.sh --prepare
step sh scripts/build-appimage.sh --check
step python3 scripts/appimage-packages.py --lint scripts/appimage-packages.tsv --pins vendor/anylinux-sharun/PIN.tsv
step sh -n scripts/verify-appimage-contents.sh
step sh -n scripts/appimage-catalog-gate.sh
step sh scripts/test-image-exec.sh
step sh scripts/bundle-libreoffice.sh
step sh scripts/bundle-tesseract.sh
step sh scripts/bundle-jbig2enc.sh
step sh scripts/bundle-dictionaries.sh
step sh scripts/bundle-voikko.sh

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/spectra-target}"
(cd src-tauri && step cargo check --all-targets) || exit 1

# glibc_of FILE -> the highest GLIBC_ version FILE references, or nothing.
glibc_of() {
  objdump -T "$1" 2>/dev/null | awk '/\*UND\*/' | grep -o 'GLIBC_[0-9][0-9.]*' |
    sed 's/^GLIBC_//' | sort -t. -k1,1n -k2,2n -k3,3n -u | tail -n1
}

# version_gt A B: A is a higher dotted version than B.
version_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1)" = "$1" ]
}

echo "==> glibc floor $FLOOR, PE files and links under $LINUX_RESOURCES"
problems=""
elf_count=0
highest=""
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
find "$LINUX_RESOURCES" \( -path "$FETCH_CACHE" -o -path "$LINUX_RESOURCES/.build" \) -prune -o -type f -print > "$list"
while IFS= read -r f; do
  magic="$(head -c4 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  rel="${f#$LINUX_RESOURCES/}"
  case "$magic" in
    7f454c46)
      elf_count=$((elf_count + 1))
      v="$(glibc_of "$f")"
      [ -n "$v" ] || continue
      if version_gt "$v" "$FLOOR"; then
        problems="$problems
  $rel requires GLIBC_$v, above the floor $FLOOR"
      fi
      if [ -z "$highest" ] || version_gt "$v" "$highest"; then highest="$v"; fi
      ;;
    4d5a*)
      case "$rel" in
        libreoffice/program/python-core-*/lib/setuptools/*.exe | libreoffice/program/python-core-*/lib/pip/_vendor/distlib/*.exe) ;;
        *) problems="$problems
  $rel is a Windows PE file" ;;
      esac
      ;;
  esac
done < "$list"
dangling="$(find "$LINUX_RESOURCES" \( -path "$FETCH_CACHE" -o -path "$LINUX_RESOURCES/.build" \) -prune -o -type l ! -exec test -e {} \; -print)"
[ -z "$dangling" ] || problems="$problems
  dangling symlinks:
$dangling"
[ -z "$problems" ] || die "Linux resource gate refused:$problems"
echo "Linux resource gate: $elf_count ELF files, highest GLIBC_$highest (floor $FLOOR), no stray PE file, no dangling link"
echo "CI-PARITY LINUX OK"
