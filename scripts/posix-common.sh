# Shared helpers for the POSIX runtime bundle scripts. Sourced, never run.
#
# Layout: native Linux trees land in resources/linux-x86_64/<component>/ so a
# checkout shared with a Windows host never has its Windows trees replaced.
# Portable data trees (fonts, dictionaries, ICC) use the same paths as the
# Windows scripts. Downloads are cached in resources/linux-x86_64/.downloads/
# and re-verified by SHA-256 on every run, so a second run is offline.
# SPECTRA_RESOURCES and SPECTRA_FETCH_CACHE move the resource root and the
# cache, for provisioning into a scratch tree.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCES_ROOT="${SPECTRA_RESOURCES:-$REPO_ROOT/resources}"
LINUX_RESOURCES="$RESOURCES_ROOT/linux-x86_64"
FETCH_CACHE="${SPECTRA_FETCH_CACHE:-$LINUX_RESOURCES/.downloads}"
FETCH_ATTEMPTS=4

die() {
  echo "error: $*" >&2
  exit 1
}

sha256_of() {
  sha256sum "$1" | cut -d' ' -f1
}

# fetch_verified URL SHA256 NAME -> prints the cached path.
# A cached file whose hash differs is deleted and refetched once; a fresh
# download whose hash differs refuses.
fetch_verified() {
  url="$1"; want="$2"; name="$3"
  mkdir -p "$FETCH_CACHE"
  path="$FETCH_CACHE/$name"
  if [ -f "$path" ] && [ "$(sha256_of "$path")" = "$want" ]; then
    echo "$path"
    return 0
  fi
  rm -f "$path" "$path.part"
  attempt=1
  while :; do
    if curl -fL --retry 0 --connect-timeout 30 --max-time 1800 -o "$path.part" "$url" >&2; then
      break
    fi
    [ "$attempt" -ge "$FETCH_ATTEMPTS" ] && die "download failed after $attempt attempts: $url"
    sleep $((attempt * 3))
    attempt=$((attempt + 1))
  done
  got="$(sha256_of "$path.part")"
  if [ "$got" != "$want" ]; then
    rm -f "$path.part"
    die "$name has SHA-256 $got; the pin is $want"
  fi
  mv "$path.part" "$path"
  echo "$path"
}

# tree_size DIR -> human-readable size, for the closing report line.
tree_size() {
  du -sh "$1" 2>/dev/null | cut -f1
}

require_tool() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required on PATH"
  done
}
