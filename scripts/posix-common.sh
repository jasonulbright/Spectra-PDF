# Shared helpers for the POSIX runtime bundle scripts. Sourced, never run.
#
# Layout: native Linux trees land in resources/linux-x86_64/<component>/ so a
# checkout shared with a Windows host never has its Windows trees replaced.
# Portable data trees (fonts, ICC) use the same paths as the Windows scripts.
# The spelling dictionaries land in resources/linux-x86_64/dictionaries/: the
# Windows tree carries the Finnish analyser's DLLs. Downloads are cached in resources/linux-x86_64/.downloads/
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

# The hosts that receive the GitHub credential, over HTTPS only. curl drops a
# custom Authorization header when a redirect changes the host (no
# --location-trusted), so a release asset's redirect to its signed URL on
# another host never carries it.
GITHUB_HOSTS="api.github.com github.com raw.githubusercontent.com objects.githubusercontent.com codeload.github.com release-assets.githubusercontent.com"

GITHUB_CREDENTIAL_MISSING="set GH_TOKEN or GITHUB_TOKEN to a GitHub token, or sign in with \`gh auth login\`"

# github_host URL -> succeeds when URL is https:// on a host in GITHUB_HOSTS.
# Scheme and host compare case-insensitively.
github_host() {
  _gh_host="$(printf '%s' "$1" | tr 'A-Z' 'a-z')"
  case "$_gh_host" in https://*) ;; *) return 1 ;; esac
  _gh_host="${_gh_host#https://}"
  _gh_host="${_gh_host%%[/?#]*}"
  _gh_host="${_gh_host##*@}"
  case "$_gh_host" in
    *:*)
      _gh_port="${_gh_host#*:}"
      if [ -n "$_gh_port" ]; then
        while [ "${_gh_port#0}" != "$_gh_port" ]; do _gh_port="${_gh_port#0}"; done
        [ "$_gh_port" = 443 ] || return 1
      fi
      ;;
  esac
  _gh_host="${_gh_host%%:*}"
  case " $GITHUB_HOSTS " in *" $_gh_host "*) return 0 ;; esac
  return 1
}

# _gh_trim VALUE: sets _gh_trimmed to VALUE without leading and trailing
# whitespace.
_gh_trim() {
  _gh_trimmed="${1#"${1%%[![:space:]]*}"}"
  _gh_trimmed="${_gh_trimmed%"${_gh_trimmed##*[![:space:]]}"}"
}

# github_token_resolve: sets _gh_token to GH_TOKEN, GITHUB_TOKEN, or the
# output of `gh auth token`, in that order, or to "" when none resolves. The
# first variable that holds more than whitespace decides; a value holding any
# character outside [A-Za-z0-9_] then counts as none. The caller turns tracing
# off first.
github_token_resolve() {
  _gh_token="${_gh_kept:-}"
  if [ -z "$_gh_token" ]; then
    _gh_trim "${GH_TOKEN:-}"
    _gh_token="$_gh_trimmed"
  fi
  if [ -z "$_gh_token" ]; then
    _gh_trim "${GITHUB_TOKEN:-}"
    _gh_token="$_gh_trimmed"
  fi
  _gh_trimmed=""
  if [ -z "$_gh_token" ] && command -v gh >/dev/null 2>&1; then
    if command -v timeout >/dev/null 2>&1; then
      _gh_token="$(timeout 15 gh auth token 2>/dev/null)" || _gh_token=""
    else
      _gh_token="$(gh auth token 2>/dev/null)" || _gh_token=""
    fi
  fi
  case "$_gh_token" in *[!A-Za-z0-9_]*) _gh_token="" ;; esac
}

# github_token_unexport: keeps the GH_TOKEN or GITHUB_TOKEN value for this
# shell's own fetches and removes both variables from the environment of every
# command run after it, so a package manager, a build or vendored code never
# inherits the credential. A script calls it before it runs any of those; a
# child script that fetches from GitHub must run before it.
github_token_unexport() {
  case "$-" in *x*) set +x; _gh_trace=1 ;; *) _gh_trace=0 ;; esac
  if [ -z "${_gh_kept:-}" ]; then
    _gh_trim "${GH_TOKEN:-}"
    _gh_kept="$_gh_trimmed"
    if [ -z "$_gh_kept" ]; then
      _gh_trim "${GITHUB_TOKEN:-}"
      _gh_kept="$_gh_trimmed"
    fi
    _gh_trimmed=""
  fi
  unset GH_TOKEN GITHUB_TOKEN
  [ "$_gh_trace" = 0 ] || set -x
}

# curl_fetch URL OUT: one download attempt. For a GitHub host the token comes
# from GH_TOKEN, GITHUB_TOKEN, then `gh auth token`, and reaches curl as a
# config file on stdin: no argument carries it, so the process list and a
# traced command line never show it. Tracing is off while the token is read
# and tested, because `set -x` prints assignments and test arguments expanded.
# A token holding any character outside [A-Za-z0-9_] is not sent: the config
# line quotes it with no escaping. A GitHub host with no credential stops the
# script before any request.
curl_fetch() {
  _gh_auth=0
  if github_host "$1"; then
    case "$-" in *x*) set +x; _gh_trace=1 ;; *) _gh_trace=0 ;; esac
    github_token_resolve
    [ -z "$_gh_token" ] || _gh_auth=1
    [ "$_gh_trace" = 0 ] || set -x
    [ "$_gh_auth" = 1 ] || die "no GitHub credential for $_gh_host: $GITHUB_CREDENTIAL_MISSING"
  fi
  if [ "$_gh_auth" = 0 ]; then
    curl -fL --retry 0 --connect-timeout 30 --max-time 1800 -o "$2" "$1"
    return
  fi
  _gh_status=0
  curl -fL --retry 0 --connect-timeout 30 --max-time 1800 -K - -o "$2" "$1" <<CURLCONFIG || _gh_status=$?
header = "Authorization: Bearer $_gh_token"
CURLCONFIG
  _gh_token=""
  return "$_gh_status"
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
    if curl_fetch "$url" "$path.part" >&2; then
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

# unpack_tar_zst ARCHIVE DIR. The Linux Python runtime reads zstd itself, so a
# host without the zstd tool still unpacks once setup-python-embed.sh has run.
unpack_tar_zst() {
  # Downloads may have used the shell's private credential. Archive tools do
  # not need it and must not inherit it, including the zstd fast path.
  github_token_unexport
  mkdir -p "$2"
  if command -v zstd >/dev/null 2>&1; then
    zstd -dc "$1" | tar -x -C "$2"
    return 0
  fi
  py="$LINUX_RESOURCES/python/bin/python3"
  [ -x "$py" ] || die "unpacking $1 needs zstd on PATH or scripts/setup-python-embed.sh run first"
  (github_token_unexport; "$py" - "$1" "$2") <<'PYEOF'
import sys, tarfile
import compression.zstd as zstd
with zstd.open(sys.argv[1], "rb") as raw, tarfile.open(fileobj=raw, mode="r|") as tar:
    tar.extractall(sys.argv[2], filter="data")
PYEOF
}

# install_artifact URL SHA256 SIZE NAME DEST
# Fetches a pinned release tarball, refuses a size or hash mismatch, unpacks it
# into DEST.stage, verifies SHA256SUMS.txt inside it, and swaps it into DEST.
# The previous tree is left at DEST.old for the caller to harvest and remove.
# A DEST whose marker names this pin and whose sums still hold is kept as is;
# ARTIFACT_CHANGED says which branch ran.
install_artifact() {
  url="$1"; want="$2"; size="$3"; name="$4"; dest="$5"
  ARTIFACT_CHANGED=0
  if [ -f "$dest/.artifact-sha256" ] && [ "$(cat "$dest/.artifact-sha256")" = "$want" ] \
     && (cd "$dest" && sha256sum -c --quiet --strict SHA256SUMS.txt) >/dev/null 2>&1; then
    return 0
  fi
  archive="$(fetch_verified "$url" "$want" "$name")"
  got_size="$(wc -c < "$archive" | tr -d ' ')"
  [ "$got_size" = "$size" ] || die "$name is $got_size bytes; the pin is $size"
  rm -rf "$dest.stage" "$dest.old"
  unpack_tar_zst "$archive" "$dest.stage"
  [ -f "$dest.stage/SHA256SUMS.txt" ] || die "$name has no SHA256SUMS.txt"
  (cd "$dest.stage" && sha256sum -c --quiet --strict SHA256SUMS.txt) >&2 \
    || die "$name does not match its own SHA256SUMS.txt"
  extra="$(cd "$dest.stage" && find . -type f ! -name SHA256SUMS.txt | sed 's|^\./||' | sort \
    | awk 'NR == FNR { sub(/^[0-9a-f]+  (\.\/)?/, ""); listed[$0] = 1; next } !($0 in listed)' SHA256SUMS.txt -)"
  [ -z "$extra" ] || die "$name carries files SHA256SUMS.txt does not list: $extra"
  if [ -d "$dest" ]; then mv "$dest" "$dest.old"; fi
  mv "$dest.stage" "$dest"
  printf '%s\n' "$want" > "$dest/.artifact-sha256"
  ARTIFACT_CHANGED=1
}

# notice_gate TSV DEST SELECT FILE_COL NOTICE_COL SHA_COL LICENCE_COL
# SELECT is an awk condition on a manifest row ($1..$n). Refuses when a
# selected row's file or any of its comma-separated notices (under
# DEST/licenses/) is missing, when a pinned sha256 differs, and when a file
# under DEST/bin or DEST/lib has no selected row. SHA_COL 0 means no column.
# Each selected row's licence must equal the licence of the DEST/NOTICES.tsv
# row whose notices list the row's first notice; an artifact licence written
# `X (elected from E)` matches a manifest licence E.
notice_gate() {
  tsv="$1"; dest="$2"; select="$3"; fcol="$4"; ncol="$5"; scol="$6"; lcol="$7"
  [ -f "$tsv" ] || die "notice manifest missing: $tsv"
  rows="$(awk -F '\t' "
    /^#/ || NF == 0 { next }
    !hdr { hdr = (\$1 == \"file\"); next }
    $select { print \$$fcol \"\t\" \$$ncol \"\t\" ($scol ? \$$scol : \"-\") \"\t\" \$$lcol }
  " "$tsv")"
  [ -n "$rows" ] || die "$tsv has no rows for $dest"
  problems=""
  tab="$(printf '\t')"
  while IFS="$tab" read -r file notices sha _licence; do
    if [ ! -f "$dest/$file" ]; then
      problems="$problems
  $file: has a row in $(basename "$tsv") but is not in the tree"
      continue
    fi
    old_ifs="$IFS"; IFS=','
    for n in $notices; do
      [ -f "$dest/licenses/$n" ] || problems="$problems
  $file: the row names notice '$n' but licenses/$n is not present"
    done
    IFS="$old_ifs"
    if [ "$sha" != "-" ] && [ "$(sha256_of "$dest/$file")" != "$sha" ]; then
      problems="$problems
  $file: sha256 differs from the pin in $(basename "$tsv")"
    fi
  done <<ROWS
$rows
ROWS
  for f in $(cd "$dest" && find bin lib -type f 2>/dev/null | sort); do
    printf '%s\n' "$rows" | cut -f1 | grep -qxF "$f" || problems="$problems
  $f: shipped but has NO ROW in $(basename "$tsv")"
  done
  if [ -f "$dest/NOTICES.tsv" ]; then
    problems="$problems$(printf '%s\n' "$rows" | awk -F '\t' -v manifest="$(basename "$tsv")" '
      NR == FNR {
        if (FNR == 1) { for (i = 1; i <= NF; i++) col[$i] = i; next }
        n = split($col["notices"], list, ",")
        for (i = 1; i <= n; i++) lic[list[i]] = $col["license"]
        next
      }
      {
        split($2, mine, ",")
        if (!(mine[1] in lic)) {
          printf "\n  %s: no NOTICES.tsv row lists notice %s", $1, mine[1]
          next
        }
        theirs = lic[mine[1]]
        suffix = " (elected from " $4 ")"
        elected = length(theirs) > length(suffix) &&
          substr(theirs, length(theirs) - length(suffix) + 1) == suffix
        if (theirs != $4 && !elected)
          printf "\n  %s: %s says \"%s\" but NOTICES.tsv says \"%s\"", $1, manifest, $4, theirs
      }
    ' "$dest/NOTICES.tsv" -)"
  else
    problems="$problems
  NOTICES.tsv: the artifact carries no notice inventory"
  fi
  [ -z "$problems" ] || die "notice gate FAILED -- refusing to ship $dest:$problems"
}
