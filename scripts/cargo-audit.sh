#!/bin/sh
# cargo audit against a RustSec advisory database fetched with the GitHub
# credential. cargo-audit's own fetch sends none.
#
#   sh scripts/cargo-audit.sh
#
# The database is fetched on every run and a failed fetch fails the audit, so
# --no-fetch reads what this run fetched; cargo audit still refuses a database
# whose newest commit is stale. The credential reaches git as an extra header
# through git's environment configuration (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n,
# GIT_CONFIG_VALUE_n), never as an argument, which the process list shows. A
# credential helper is not enough: git asks a helper only after a 401, and a
# public repository never answers 401.
#
# SPECTRA_ADVISORY_DB moves the database (default: the one cargo-audit reads,
# under CARGO_HOME).

. "$(dirname "$0")/posix-common.sh"
require_tool git cargo base64

DB_URL="https://github.com/RustSec/advisory-db.git"
DB="${SPECTRA_ADVISORY_DB:-${CARGO_HOME:-$HOME/.cargo}/advisory-db}"

case "$-" in *x*) set +x; trace=1 ;; *) trace=0 ;; esac
github_token_resolve
[ -n "$_gh_token" ] || die "no GitHub credential for github.com: $GITHUB_CREDENTIAL_MISSING"
[ -z "${GIT_CONFIG_COUNT:-}" ] || die "GIT_CONFIG_COUNT is already set; this script owns git's environment configuration"
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$_gh_token" | base64 | tr -d '\n')"
export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
_gh_token=""
[ "$trace" = 0 ] || set -x
GIT_TERMINAL_PROMPT=0
export GIT_TERMINAL_PROMPT

if [ -d "$DB/.git" ]; then
  git -C "$DB" remote set-url origin "$DB_URL" || die "advisory database at $DB has no origin remote"
  git -C "$DB" fetch --quiet origin main || die "advisory database fetch failed"
  git -C "$DB" reset --quiet --hard FETCH_HEAD || die "advisory database checkout failed"
else
  rm -rf "$DB"
  git clone --quiet --branch main "$DB_URL" "$DB" || die "advisory database clone failed"
fi
echo "advisory database at $(git -C "$DB" log -1 --format='%h %cI')"

cd "$REPO_ROOT/src-tauri"
unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
github_token_unexport
exec cargo audit --no-fetch --db "$DB"
