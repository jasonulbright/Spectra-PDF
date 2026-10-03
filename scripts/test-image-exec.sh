#!/bin/sh
# Regression test of src-tauri/linux/image-exec.c, the AppImage's exec
# library: it must move payload programs onto the image's loader and keep the
# C library's exec semantics for every other program.
#
#   sh scripts/test-image-exec.sh [LIBRARY.so]
#
# Without LIBRARY.so the library is compiled from source. Needs a C compiler
# and a glibc with ld.so --argv0 (2.33 or later).

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$REPO_ROOT/src-tauri/linux/image-exec.c"
CC="${CC:-gcc}"
SYSTEM_LOADER=/lib64/ld-linux-x86-64.so.2

die() {
  echo "error: $*" >&2
  exit 1
}

command -v "$CC" >/dev/null 2>&1 || die "$CC is required"
[ -x "$SYSTEM_LOADER" ] || die "no $SYSTEM_LOADER"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

if [ $# -ge 1 ]; then
  LIB="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  LIB="$WORK/image-exec.so"
  "$CC" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$LIB" "$SOURCE" -ldl
fi
[ -f "$LIB" ] || die "no library at $LIB"

cat > "$WORK/caller.c" <<'EOF'
#define _GNU_SOURCE
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int report(const char *what)
{
	const char *name = errno == ENOENT ? "ENOENT" : errno == EACCES ? "EACCES" : errno == ENOEXEC ? "ENOEXEC"
	                 : errno == E2BIG ? "E2BIG" : "OTHER";
	printf("%s failed: %s\n", what, name);
	fflush(stdout);
	return 3;
}

static int spawned(int rc, pid_t pid, const char *what)
{
	if (rc != 0) {
		errno = rc;
		return report(what);
	}
	int status;
	waitpid(pid, &status, 0);
	return WIFEXITED(status) ? WEXITSTATUS(status) : 4;
}

int main(int argc, char **argv)
{
	if (argc < 3)
		return 2;
	const char *mode = argv[1], *file = argv[2];
	char *args[] = { "custom-argv0", "one", NULL };
	pid_t pid;
	if (!strcmp(mode, "execvp")) {
		execvp(file, args);
		return report("execvp");
	}
	if (!strcmp(mode, "execlp")) {
		execlp(file, "custom-argv0", "one", (char *)NULL);
		return report("execlp");
	}
	if (!strcmp(mode, "execv")) {
		execv(file, args);
		return report("execv");
	}
	if (!strcmp(mode, "execve-null-env")) {
		execve(file, args, NULL);
		return report("execve");
	}
	if (!strcmp(mode, "execle-env")) {
		char *env[] = { "HOME=/home/user", "LD_FOO=1", argv[3], argv[4], NULL };
		execle(file, "custom-argv0", (char *)NULL, env);
		return report("execle");
	}
	if (!strcmp(mode, "spawn"))
		return spawned(posix_spawn(&pid, file, NULL, NULL, args, environ), pid, "posix_spawn");
	if (!strcmp(mode, "spawnp"))
		return spawned(posix_spawnp(&pid, file, NULL, NULL, args, environ), pid, "posix_spawnp");
	if (!strcmp(mode, "many-args")) {
		static char *many[2001];
		for (int i = 0; i < 2000; i++)
			many[i] = "x";
		many[2000] = NULL;
		execv(file, many);
		return report("execv");
	}
	return 2;
}
EOF
cat > "$WORK/helper.c" <<'EOF'
#include <stdio.h>
int main(int argc, char **argv)
{
	printf("HELPER argv0=%s argc=%d\n", argv[0], argc);
	return 0;
}
EOF
"$CC" -O2 -o "$WORK/caller" "$WORK/caller.c"

ROOT="$WORK/image"
mkdir -p "$ROOT/lib/spectrapdf/tool/bin" "$WORK/bin" "$WORK/noexec"
"$CC" -O2 -o "$ROOT/lib/spectrapdf/tool/bin/helper" "$WORK/helper.c"
printf '#!/bin/sh\necho LOADER_USED >&2\nexec %s "$@"\n' "$SYSTEM_LOADER" > "$ROOT/lib/ld-linux-x86-64.so.2"
chmod 0755 "$ROOT/lib/ld-linux-x86-64.so.2"
printf 'echo SCRIPT_OK\n' > "$WORK/bin/plain-script"
chmod 0755 "$WORK/bin/plain-script"
printf 'echo NOT_EXECUTABLE\n' > "$WORK/noexec/plain-script"
ln -s "$WORK/missing-target" "$WORK/dangling"

failures=0
# expect NAME EXPECTED-REGEX COMMAND...: the combined output must match.
expect() {
  name="$1"; pattern="$2"; shift 2
  out="$("$@" 2>&1)" || true
  if printf '%s\n' "$out" | grep -Eq "$pattern"; then
    echo "ok   $name"
  else
    echo "FAIL $name: expected /$pattern/, got: $(printf '%s' "$out" | tr '\n' ' ')"
    failures=$((failures + 1))
  fi
}
# refuse NAME REGEX COMMAND...: the combined output must not match.
refuse() {
  name="$1"; pattern="$2"; shift 2
  out="$("$@" 2>&1)" || true
  if printf '%s\n' "$out" | grep -Eq "$pattern"; then
    echo "FAIL $name: unexpected /$pattern/ in: $(printf '%s' "$out" | tr '\n' ' ')"
    failures=$((failures + 1))
  else
    echo "ok   $name"
  fi
}

run() {
  env LD_PRELOAD="$LIB" SPECTRAPDF_IMAGE_ROOT="$ROOT" SPECTRAPDF_IMAGE_EXEC="$LIB" \
    SPECTRAPDF_IMAGE_LIBRARY_PATH="$ROOT/lib" PATH="$WORK/noexec:$WORK/bin:/usr/bin:/bin" "$@"
}

HELPER="$ROOT/lib/spectrapdf/tool/bin/helper"
expect "execvp runs a text file without #! through /bin/sh (path)" '^SCRIPT_OK$' run "$WORK/caller" execvp "$WORK/bin/plain-script"
expect "execvp runs a text file without #! through /bin/sh (PATH, past EACCES)" '^SCRIPT_OK$' run "$WORK/caller" execvp plain-script
expect "execlp runs a text file without #! through /bin/sh" '^SCRIPT_OK$' run "$WORK/caller" execlp plain-script
expect "execv keeps ENOEXEC for a text file without #!" 'execv failed: ENOEXEC' run "$WORK/caller" execv "$WORK/bin/plain-script"
expect "posix_spawn keeps no shell fallback" 'posix_spawn failed: ENOEXEC' run "$WORK/caller" spawn "$WORK/bin/plain-script"
refuse "posix_spawn does not run a text file without #! through /bin/sh" 'SCRIPT_OK' run "$WORK/caller" spawn "$WORK/bin/plain-script"
expect "execvp reports ENOENT" 'execvp failed: ENOENT' run "$WORK/caller" execvp no-such-program
expect "execvp reports EACCES for a file without execute permission" 'execvp failed: EACCES' \
  env PATH="$WORK/noexec" LD_PRELOAD="$LIB" SPECTRAPDF_IMAGE_ROOT="$ROOT" SPECTRAPDF_IMAGE_EXEC="$LIB" \
  SPECTRAPDF_IMAGE_LIBRARY_PATH="$ROOT/lib" "$WORK/caller" execvp plain-script
expect "execv reports EACCES for a directory" 'execv failed: EACCES' run "$WORK/caller" execv "$WORK/bin"
expect "execv reports ENOENT for a dangling link" 'execv failed: ENOENT' run "$WORK/caller" execv "$WORK/dangling"
expect "a payload program starts on the image loader (execv)" 'LOADER_USED' run "$WORK/caller" execv "$HELPER"
expect "the image loader keeps argv[0]" 'HELPER argv0=custom-argv0 argc=2' run "$WORK/caller" execv "$HELPER"
expect "posix_spawn of a plain relative payload name uses the image loader" 'LOADER_USED' \
  sh -c "cd '$ROOT/lib/spectrapdf/tool/bin' && exec env LD_PRELOAD='$LIB' SPECTRAPDF_IMAGE_ROOT='$ROOT' SPECTRAPDF_IMAGE_EXEC='$LIB' SPECTRAPDF_IMAGE_LIBRARY_PATH='$ROOT/lib' '$WORK/caller' spawn helper"
expect "execv of a plain relative payload name uses the image loader" 'LOADER_USED' \
  sh -c "cd '$ROOT/lib/spectrapdf/tool/bin' && exec env LD_PRELOAD='$LIB' SPECTRAPDF_IMAGE_ROOT='$ROOT' SPECTRAPDF_IMAGE_EXEC='$LIB' SPECTRAPDF_IMAGE_LIBRARY_PATH='$ROOT/lib' '$WORK/caller' execv helper"
expect "posix_spawnp of a payload program in PATH uses the image loader" 'LOADER_USED' \
  env PATH="$ROOT/lib/spectrapdf/tool/bin" LD_PRELOAD="$LIB" SPECTRAPDF_IMAGE_ROOT="$ROOT" SPECTRAPDF_IMAGE_EXEC="$LIB" \
  SPECTRAPDF_IMAGE_LIBRARY_PATH="$ROOT/lib" "$WORK/caller" spawnp helper
expect "execve with a NULL environment starts a payload program" 'HELPER argv0=custom-argv0' run "$WORK/caller" execve-null-env "$HELPER"
expect "a payload start too large for the buffers fails with E2BIG" 'execv failed: E2BIG' run "$WORK/caller" many-args "$HELPER"
refuse "a host program is not moved onto the image loader" 'LOADER_USED' run "$WORK/caller" execv /usr/bin/env
expect "a host program loses LD_ variables and image variables" '^HOME=/home/user$' \
  run "$WORK/caller" execle-env /usr/bin/env "GS_LIB=$ROOT/share/ghostscript" "XDG_DATA_DIRS=$ROOT/share:/usr/share"
refuse "a host program sees no LD_ or image variable" "^LD_FOO=|^GS_LIB=|$ROOT" \
  run "$WORK/caller" execle-env /usr/bin/env "GS_LIB=$ROOT/share/ghostscript" "XDG_DATA_DIRS=$ROOT/share:/usr/share"
expect "a host program keeps the host entries of a list" '^XDG_DATA_DIRS=/usr/share$' \
  run "$WORK/caller" execle-env /usr/bin/env "GS_LIB=$ROOT/share/ghostscript" "XDG_DATA_DIRS=$ROOT/share:/usr/share"

[ "$failures" -eq 0 ] || die "image-exec: $failures case(s) failed"
echo "image-exec: every case passed"
