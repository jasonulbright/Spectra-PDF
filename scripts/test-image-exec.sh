#!/bin/sh
# Regression test of src-tauri/linux/image-exec.c and image-exec-trampoline.c,
# the AppImage's exec library and its spawn trampoline: they must move
# payload programs onto the image's loader and keep the C library's exec and
# spawn semantics for every other program.
#
#   sh scripts/test-image-exec.sh [LIBRARY.so]
#
# Without LIBRARY.so both are compiled from source; with it, the trampoline is
# the image-exec-trampoline file beside it. The test image carries the
# trampoline at lib/image-exec/image-exec-trampoline, as the AppImage does.
# Needs a C compiler, a static C library and a glibc with ld.so --argv0 (2.33
# or later).
#
# Every semantics case runs the same call natively and with the library
# preloaded: stdout, the exit status and the errno the caller reports must be
# identical, and the native result must match the case's pattern. The
# environment cases check the documented removal of the image's variables.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$REPO_ROOT/src-tauri/linux/image-exec.c"
TRAMPOLINE_SOURCE="$REPO_ROOT/src-tauri/linux/image-exec-trampoline.c"
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
  TRAMPOLINE="$(dirname "$LIB")/image-exec-trampoline"
else
  LIB="$WORK/lib/image-exec.so"
  TRAMPOLINE="$WORK/lib/image-exec-trampoline"
  mkdir -p "$WORK/lib"
  "$CC" -shared -fPIC -O2 -Wall -Wextra -Werror -o "$LIB" "$SOURCE" -ldl
  "$CC" -static -O2 -Wall -Wextra -Werror -o "$TRAMPOLINE" "$TRAMPOLINE_SOURCE"
fi
[ -f "$LIB" ] || die "no library at $LIB"
[ -x "$TRAMPOLINE" ] || die "no trampoline at $TRAMPOLINE"

cat > "$WORK/caller.c" <<'EOF'
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static int report(const char *what, int err)
{
	const char *name = strerrorname_np(err);
	if (name)
		printf("%s failed: %s\n", what, name);
	else
		printf("%s failed: errno %d\n", what, err);
	fflush(stdout);
	return 3;
}

static int waited(int rc, pid_t *pid, const char *what)
{
	if (rc != 0)
		return report(what, rc);
	int status;
	if (waitpid(*pid, &status, 0) != *pid)
		return report("waitpid", errno);
	return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

static char **many(const char *first, long count, const char *each)
{
	char **v = calloc((size_t)count + 2, sizeof *v);
	v[0] = (char *)first;
	for (long i = 1; i <= count; i++)
		v[i] = (char *)each;
	return v;
}

static const char *thread_mode, *thread_file;
static long thread_count;

/* Runs on a thread with a 64 KiB stack. */
static void *small_stack(void *unused)
{
	(void)unused;
	if (!strcmp(thread_mode, "thread-env")) {
		char **env = many("X=x", thread_count - 1, "X=x");
		env = realloc(env, ((size_t)thread_count + 2) * sizeof *env);
		env[thread_count] = "LD_FOO=1";
		env[thread_count + 1] = NULL;
		char *one[] = { "custom-argv0", NULL };
		execve(thread_file, one, env);
	} else {
		execv(thread_file, many("custom-argv0", thread_count, "x"));
	}
	return (void *)(long)report("execve", errno);
}

int main(int argc, char **argv)
{
	if (argc < 3)
		return 2;
	const char *mode = argv[1], *file = argv[2], *extra = argc > 3 ? argv[3] : "0";
	char *args[] = { "custom-argv0", "one", NULL };
	posix_spawn_file_actions_t fa;
	posix_spawn_file_actions_init(&fa);
	pid_t pid;
	if (!strcmp(mode, "execvp")) {
		execvp(file, args);
		return report("execvp", errno);
	}
	if (!strcmp(mode, "execlp")) {
		execlp(file, "custom-argv0", "one", (char *)NULL);
		return report("execlp", errno);
	}
	if (!strcmp(mode, "execv")) {
		execv(file, args);
		return report("execv", errno);
	}
	if (!strcmp(mode, "execve-null-env")) {
		execve(file, args, NULL);
		return report("execve", errno);
	}
	if (!strcmp(mode, "execle-env")) {
		char *env[] = { "HOME=/home/user", "LD_FOO=1", argv[3], argv[4], NULL };
		execle(file, "custom-argv0", (char *)NULL, env);
		return report("execle", errno);
	}
	if (!strcmp(mode, "execvp-many")) {
		execvp(file, many(file, atol(extra), "x"));
		return report("execvp", errno);
	}
	if (!strcmp(mode, "execv-many")) {
		execv(file, many("custom-argv0", atol(extra), "x"));
		return report("execv", errno);
	}
	if (!strcmp(mode, "execve-env") || !strcmp(mode, "execve-env-ld")) {
		char **env = many("X=x", atol(extra) - 1, "X=x");
		if (!strcmp(mode, "execve-env-ld")) {
			long n = atol(extra);
			env = realloc(env, ((size_t)n + 2) * sizeof *env);
			env[n] = "LD_FOO=1";
			env[n + 1] = NULL;
		}
		char *one[] = { "custom-argv0", NULL };
		execve(file, one, env);
		return report("execve", errno);
	}
	if (!strcmp(mode, "path-long")) {
		char path[5001];
		memset(path, 'a', sizeof path - 1);
		path[5000] = '\0';
		setenv("PATH", path, 1);
		errno = 0;
		execvp(file, args);
		return report("execvp", errno);
	}
	if (!strcmp(mode, "spawn"))
		return waited(posix_spawn(&pid, file, NULL, NULL, args, environ), &pid, "posix_spawn");
	if (!strcmp(mode, "spawnp"))
		return waited(posix_spawnp(&pid, file, NULL, NULL, args, environ), &pid, "posix_spawnp");
	if (!strcmp(mode, "spawn-chdir") || !strcmp(mode, "spawnp-chdir")) {
		posix_spawn_file_actions_addchdir_np(&fa, extra);
		if (!strcmp(mode, "spawn-chdir"))
			return waited(posix_spawn(&pid, file, &fa, NULL, args, environ), &pid, "posix_spawn");
		return waited(posix_spawnp(&pid, file, &fa, NULL, args, environ), &pid, "posix_spawnp");
	}
	if (!strcmp(mode, "spawn-fchdir")) {
		int dir = open(extra, O_RDONLY | O_DIRECTORY);
		posix_spawn_file_actions_addfchdir_np(&fa, dir);
		return waited(posix_spawn(&pid, file, &fa, NULL, args, environ), &pid, "posix_spawn");
	}
	if (!strcmp(mode, "spawn-closefrom-chdir")) {
		posix_spawn_file_actions_addclosefrom_np(&fa, 3);
		posix_spawn_file_actions_addchdir_np(&fa, extra);
		return waited(posix_spawn(&pid, file, &fa, NULL, args, environ), &pid, "posix_spawn");
	}
	if (!strcmp(mode, "execvp-oversized") || !strcmp(mode, "spawnp-oversized")) {
		size_t rest = strlen(extra);
		char *path = malloc(4096 + 1 + rest + 1);
		memset(path, 'a', 4096);
		path[4096] = ':';
		memcpy(path + 4097, extra, rest + 1);
		setenv("PATH", path, 1);
		if (!strcmp(mode, "spawnp-oversized"))
			return waited(posix_spawnp(&pid, file, NULL, NULL, args, environ), &pid, "posix_spawnp");
		execvp(file, args);
		return report("execvp", errno);
	}
	if (!strcmp(mode, "execvp-unset") || !strcmp(mode, "spawnp-unset")) {
		unsetenv("PATH");
		if (!strcmp(mode, "spawnp-unset"))
			return waited(posix_spawnp(&pid, file, NULL, NULL, args, environ), &pid, "posix_spawnp");
		execvp(file, args);
		return report("execvp", errno);
	}
	if (!strcmp(mode, "spawn-dup2-3") || !strcmp(mode, "spawn-nofile4")) {
		close_range(3, ~0U, 0);
		if (!strcmp(mode, "spawn-dup2-3")) {
			posix_spawn_file_actions_adddup2(&fa, 3, 1);
		} else {
			struct rlimit four = { 4, 4 };
			setrlimit(RLIMIT_NOFILE, &four);
			posix_spawn_file_actions_addopen(&fa, 3, "/dev/null", O_RDONLY, 0);
		}
		return waited(posix_spawn(&pid, file, &fa, NULL, args, environ), &pid, "posix_spawn");
	}
	if (!strcmp(mode, "thread-env") || !strcmp(mode, "thread-argv")) {
		thread_mode = mode;
		thread_file = file;
		thread_count = atol(extra);
		pthread_attr_t attr;
		pthread_attr_init(&attr);
		pthread_attr_setstacksize(&attr, 64 * 1024);
		pthread_t thread;
		if (pthread_create(&thread, &attr, small_stack, NULL) != 0)
			return report("pthread_create", errno);
		void *result;
		pthread_join(thread, &result);
		return (int)(long)result;
	}
	return 2;
}
EOF
cat > "$WORK/tagged.c" <<'EOF'
#include <stdio.h>
int main(int argc, char **argv)
{
	printf(TAG " argv0=%s argc=%d\n", argv[0], argc);
	return 0;
}
EOF
cat > "$WORK/argcount.c" <<'EOF'
#include <stdio.h>
int main(int argc, char **argv)
{
	(void)argv;
	printf("argc=%d\n", argc);
	return 0;
}
EOF
cat > "$WORK/envcount.c" <<'EOF'
#include <stdio.h>
extern char **environ;
int main(void)
{
	int n = 0;
	while (environ[n])
		n++;
	printf("envc=%d\n", n);
	return 0;
}
EOF

ROOT="$WORK/image"
PAYLOAD_DIR="$ROOT/lib/spectrapdf/tool/bin"
HOST_DIR="$WORK/host"
mkdir -p "$PAYLOAD_DIR" "$HOST_DIR" "$WORK/bin" "$WORK/noexec" "$ROOT/lib/image-exec"
cp "$TRAMPOLINE" "$ROOT/lib/image-exec/image-exec-trampoline"
"$CC" -O2 -pthread -o "$WORK/caller" "$WORK/caller.c"
"$CC" -O2 -DTAG='"PAYLOAD"' -o "$PAYLOAD_DIR/helper" "$WORK/tagged.c"
"$CC" -O2 -DTAG='"HOST"' -o "$HOST_DIR/helper" "$WORK/tagged.c"
"$CC" -O2 -static -DTAG='"HOST"' -o "$HOST_DIR/static-helper" "$WORK/tagged.c"
"$CC" -O2 -o "$WORK/bin/argcount" "$WORK/argcount.c"
"$CC" -O2 -o "$WORK/bin/envcount" "$WORK/envcount.c"
printf '#!/bin/sh\necho LOADER_USED >&2\nexec %s "$@"\n' "$SYSTEM_LOADER" > "$ROOT/lib/ld-linux-x86-64.so.2"
chmod 0755 "$ROOT/lib/ld-linux-x86-64.so.2"
printf 'echo SCRIPT_OK\n' > "$WORK/bin/plain-script"
printf 'echo SCRIPT_ARGC=$#\n' > "$HOST_DIR/argc-script"
printf '#!/bin/sh\nexit 7\n' > "$HOST_DIR/exit7"
printf '#!/bin/sh\nexit 127\n' > "$HOST_DIR/exit127"
mkdir -p "$WORK/cwd"
printf '#!/bin/sh\nexit 7\n' > "$WORK/cwd/true"
chmod 0755 "$WORK/bin/plain-script" "$HOST_DIR/argc-script" "$HOST_DIR/exit7" "$HOST_DIR/exit127" "$WORK/cwd/true"
printf 'echo NOT_EXECUTABLE\n' > "$WORK/noexec/plain-script"
ln -s "$WORK/missing-target" "$WORK/dangling"

export SPECTRAPDF_IMAGE_ROOT="$ROOT" SPECTRAPDF_IMAGE_EXEC="$LIB" SPECTRAPDF_IMAGE_LIBRARY_PATH="$ROOT/lib"
DEFAULT_PATH="$WORK/noexec:$WORK/bin:/usr/bin:/bin"
CALLER="$WORK/caller"
failures=0
cases=0

fail() {
  echo "FAIL $1"
  failures=$((failures + 1))
}

# same NAME LOADER DIR PATTERN COMMAND...: COMMAND runs in DIR with PATH set to
# $CASE_PATH, natively and with the library preloaded. stdout and the exit
# status must be identical; the native "stdout rc=N" must match PATTERN.
# LOADER yes: the preloaded run starts a payload program on the image loader;
# no: it does not.
same() {
  name="$1"; loader="$2"; dir="$3"; pattern="$4"; shift 4
  cases=$((cases + 1))
  native="$(cd "$dir" && PATH="$CASE_PATH" "$@" 2>"$WORK/native.err")" && native_rc=0 || native_rc=$?
  wrapped="$(cd "$dir" && LD_PRELOAD="$LIB" PATH="$CASE_PATH" "$@" 2>"$WORK/wrapped.err")" && wrapped_rc=0 || wrapped_rc=$?
  native_line="$(printf '%s rc=%s' "$native" "$native_rc" | tr '\n' ' ')"
  wrapped_line="$(printf '%s rc=%s' "$wrapped" "$wrapped_rc" | tr '\n' ' ')"
  if [ "$native" != "$wrapped" ] || [ "$native_rc" != "$wrapped_rc" ]; then
    fail "$name: native [$native_line], preloaded [$wrapped_line]"
  elif ! printf '%s\n' "$native_line" | grep -Eq "$pattern"; then
    fail "$name: native [$native_line] does not match /$pattern/"
  elif [ "$loader" = yes ] && ! grep -q LOADER_USED "$WORK/wrapped.err"; then
    fail "$name: the preloaded run did not use the image loader"
  elif [ "$loader" = no ] && grep -q LOADER_USED "$WORK/wrapped.err"; then
    fail "$name: the preloaded run used the image loader"
  else
    echo "ok   $name [$native_line]"
  fi
  CASE_PATH="$DEFAULT_PATH"
}

# expect NAME PATTERN COMMAND... / refuse NAME PATTERN COMMAND...: the
# preloaded run's combined output must (must not) match PATTERN.
expect() {
  name="$1"; pattern="$2"; shift 2
  cases=$((cases + 1))
  out="$(LD_PRELOAD="$LIB" PATH="$DEFAULT_PATH" "$@" 2>&1)" || true
  if printf '%s\n' "$out" | grep -Eq "$pattern"; then
    echo "ok   $name"
  else
    fail "$name: expected /$pattern/, got: $(printf '%s' "$out" | tr '\n' ' ')"
  fi
}
refuse() {
  name="$1"; pattern="$2"; shift 2
  cases=$((cases + 1))
  out="$(LD_PRELOAD="$LIB" PATH="$DEFAULT_PATH" "$@" 2>&1)" || true
  if printf '%s\n' "$out" | grep -Eq "$pattern"; then
    fail "$name: unexpected /$pattern/ in: $(printf '%s' "$out" | tr '\n' ' ')"
  else
    echo "ok   $name"
  fi
}

CASE_PATH="$DEFAULT_PATH"
P="$PAYLOAD_DIR/helper"
PAYLOAD_LINE='^PAYLOAD argv0=custom-argv0 argc=2 rc=0'
HOST_LINE='^HOST argv0=custom-argv0 argc=2 rc=0'

# The C library's exec and spawn semantics.
same "execvp runs a text file without #! through /bin/sh (path)" no "$WORK" '^SCRIPT_OK rc=0' \
  "$CALLER" execvp "$WORK/bin/plain-script"
same "execvp runs a text file without #! through /bin/sh (PATH, past EACCES)" no "$WORK" '^SCRIPT_OK rc=0' \
  "$CALLER" execvp plain-script
same "execlp runs a text file without #! through /bin/sh" no "$WORK" '^SCRIPT_OK rc=0' "$CALLER" execlp plain-script
same "execvp shell fallback with 1,500 arguments" no "$WORK" '^SCRIPT_ARGC=1500 rc=0' \
  "$CALLER" execvp-many "$HOST_DIR/argc-script" 1500
same "execv keeps ENOEXEC for a text file without #!" no "$WORK" 'execv failed: ENOEXEC rc=3' \
  "$CALLER" execv "$WORK/bin/plain-script"
same "posix_spawn has no shell fallback" no "$WORK" 'posix_spawn failed: ENOEXEC rc=3' \
  "$CALLER" spawn "$WORK/bin/plain-script"
same "posix_spawnp has no shell fallback (PATH, past EACCES)" no "$WORK" 'posix_spawnp failed: ENOEXEC rc=3' \
  "$CALLER" spawnp plain-script
same "execvp reports ENOENT" no "$WORK" 'execvp failed: ENOENT rc=3' "$CALLER" execvp no-such-program
CASE_PATH="$WORK/noexec"
same "execvp reports EACCES for a file without execute permission" no "$WORK" 'execvp failed: EACCES rc=3' \
  "$CALLER" execvp plain-script
same "execv reports EACCES for a directory" no "$WORK" 'execv failed: EACCES rc=3' "$CALLER" execv "$WORK/bin"
same "execv reports ENOENT for a dangling link" no "$WORK" 'execv failed: ENOENT rc=3' "$CALLER" execv "$WORK/dangling"
same "execvp skips a PATH entry of PATH_MAX bytes or more" no "$WORK" 'execvp failed' "$CALLER" path-long anything

# No limit below the C library's and the kernel's.
same "execve of a host program with a 2,051-entry environment" no "$WORK" '^envc=2051 rc=0' \
  "$CALLER" execve-env "$WORK/bin/envcount" 2051
same "execv of a host program with 100,000 arguments" no "$WORK" '^argc=100001 rc=0' \
  "$CALLER" execv-many "$WORK/bin/argcount" 100000
same "execv of a host program beyond the kernel's argument limit" no "$WORK" 'execv failed: E2BIG rc=3' \
  "$CALLER" execv-many "$WORK/bin/argcount" 1000000
same "execv of a payload program with 2,000 arguments" yes "$WORK" '^PAYLOAD argv0=custom-argv0 argc=2001 rc=0' \
  "$CALLER" execv-many "$P" 2000
same "execv of a payload program beyond the kernel's argument limit" no "$WORK" 'execv failed: E2BIG rc=3' \
  "$CALLER" execv-many "$P" 1000000

# Payload programs start on the image loader with argv[0] kept.
same "a payload program starts on the image loader (execv)" yes "$WORK" "$PAYLOAD_LINE" "$CALLER" execv "$P"
same "execve with a NULL environment starts a payload program" yes "$WORK" "$PAYLOAD_LINE" \
  "$CALLER" execve-null-env "$P"
same "posix_spawn of a bare relative payload name" yes "$PAYLOAD_DIR" "$PAYLOAD_LINE" "$CALLER" spawn helper
same "execv of a bare relative payload name" yes "$PAYLOAD_DIR" "$PAYLOAD_LINE" "$CALLER" execv helper
same "a relative payload name with a slash and no file actions (posix_spawn)" yes "$ROOT/lib/spectrapdf/tool" \
  "$PAYLOAD_LINE" "$CALLER" spawn bin/helper
same "a relative payload name with a slash and no file actions (execv)" yes "$ROOT/lib/spectrapdf/tool" \
  "$PAYLOAD_LINE" "$CALLER" execv bin/helper
same "a relative host name with a slash and no file actions" no "$WORK" "$HOST_LINE" "$CALLER" spawn host/helper
CASE_PATH="$PAYLOAD_DIR:/usr/bin"
same "posix_spawnp finds a payload program in PATH" yes "$WORK" "$PAYLOAD_LINE" "$CALLER" spawnp helper
same "a host program is not moved onto the image loader" no "$WORK" '^argc=3 rc=0' \
  "$CALLER" execv-many "$WORK/bin/argcount" 2

# Names resolve in the child, after its file actions.
same "addchdir + bare name runs the host program in the target directory" no "$PAYLOAD_DIR" "$HOST_LINE" \
  "$CALLER" spawn-chdir helper "$HOST_DIR"
same "addfchdir + ./helper runs the host program in the target directory" no "$PAYLOAD_DIR" "$HOST_LINE" \
  "$CALLER" spawn-fchdir ./helper "$HOST_DIR"
same "addchdir + bare name of a payload program in the target directory" yes "$WORK" "$PAYLOAD_LINE" \
  "$CALLER" spawn-chdir helper "$PAYLOAD_DIR"
CASE_PATH=".:/usr/bin"
same "posix_spawnp with chdir searches PATH in the child" no "$PAYLOAD_DIR" "$HOST_LINE" \
  "$CALLER" spawnp-chdir helper "$HOST_DIR"
CASE_PATH="."
same "posix_spawnp with chdir finds a payload program in the child" yes "$WORK" "$PAYLOAD_LINE" \
  "$CALLER" spawnp-chdir helper "$PAYLOAD_DIR"
CASE_PATH=".:/usr/bin"
same "posix_spawnp with chdir reports ENOENT" no "$PAYLOAD_DIR" 'posix_spawnp failed: ENOENT rc=3' \
  "$CALLER" spawnp-chdir no-such-program "$HOST_DIR"
same "a failed exec after chdir fails posix_spawn with its errno" no "$PAYLOAD_DIR" 'posix_spawn failed: ENOENT rc=3' \
  "$CALLER" spawn-chdir no-such-program "$HOST_DIR"
same "a program started after chdir keeps its exit status" no "$PAYLOAD_DIR" '^ rc=7' \
  "$CALLER" spawn-chdir ./exit7 "$HOST_DIR"
same "closefrom + chdir still fails posix_spawn with the exec's errno" no "$HOST_DIR" 'posix_spawn failed: ENOEXEC rc=3' \
  "$CALLER" spawn-closefrom-chdir plain-script "$WORK/bin"
same "a chdir to a missing directory fails posix_spawn" no "$PAYLOAD_DIR" 'posix_spawn failed: ENOENT rc=3' \
  "$CALLER" spawn-chdir helper "$WORK/missing"

# The PATH walk, entry by entry as glibc's __execvpe_common builds it.
same "an oversized PATH entry followed by /bin (execvp)" no "$WORK/cwd" '^ rc=(0|7)$' "$CALLER" execvp-oversized true /bin
same "an oversized PATH entry followed by /bin (posix_spawnp)" no "$WORK/cwd" '^ rc=(0|7)$' "$CALLER" spawnp-oversized true /bin
same "an oversized PATH entry before a payload directory (posix_spawnp)" yes "$PAYLOAD_DIR" "$PAYLOAD_LINE" "$CALLER" spawnp-oversized helper "$PAYLOAD_DIR"
CASE_PATH=":/usr/bin"
same "a leading empty PATH entry is the current directory" no "$HOST_DIR" "$HOST_LINE" "$CALLER" execvp helper
CASE_PATH="/nonexistent::/usr/bin"
same "a doubled colon in PATH is the current directory" no "$HOST_DIR" "$HOST_LINE" "$CALLER" execvp helper
CASE_PATH="/nonexistent:"
same "a trailing empty PATH entry is the current directory (posix_spawnp)" no "$HOST_DIR" "$HOST_LINE" "$CALLER" spawnp helper
CASE_PATH=""
same "an empty PATH is the current directory" no "$HOST_DIR" "$HOST_LINE" "$CALLER" execvp helper
same "an unset PATH is /bin:/usr/bin (execvp)" no "$HOST_DIR" '^ rc=0$' "$CALLER" execvp-unset true
same "an unset PATH is /bin:/usr/bin (posix_spawnp)" no "$HOST_DIR" '^ rc=0$' "$CALLER" spawnp-unset true
same "a name longer than NAME_MAX" no "$WORK" 'execvp failed: ENAMETOOLONG rc=3' "$CALLER" execvp "$(printf '%0300d' 0)"

# The trampoline adds no descriptor and no descriptor requirement.
same "dup2 from a closed descriptor 3 fails as natively" no "$HOST_DIR" 'posix_spawn failed: EBADF rc=3' "$CALLER" spawn-dup2-3 ./helper
same "an open action filling RLIMIT_NOFILE=4 still runs the program" no "$HOST_DIR" "$HOST_LINE" "$CALLER" spawn-nofile4 ./static-helper
same "a program after chdir that exits 127 is not a failed exec" no "$PAYLOAD_DIR" '^ rc=127' "$CALLER" spawn-chdir ./exit127 "$HOST_DIR"

# No caller-sized array on a small thread stack.
same "a filtered 10,000-entry environment on a 64 KiB thread stack" no "$WORK" '^argc=1 rc=0' "$CALLER" thread-env "$WORK/bin/argcount" 10000
same "a payload start with 10,000 arguments on a 64 KiB thread stack" yes "$WORK" '^PAYLOAD argv0=custom-argv0 argc=10001 rc=0' "$CALLER" thread-argv "$P" 10000

# The image's variables leave a host program's environment.
refuse "a host program is not moved onto the image loader (env)" 'LOADER_USED' "$CALLER" execv /usr/bin/env
expect "a host program loses LD_ variables and image variables" '^HOME=/home/user$' \
  "$CALLER" execle-env /usr/bin/env "GS_LIB=$ROOT/share/ghostscript" "XDG_DATA_DIRS=$ROOT/share:/usr/share"
refuse "a host program sees no LD_ or image variable" "^LD_FOO=|^GS_LIB=|$ROOT" \
  "$CALLER" execle-env /usr/bin/env "GS_LIB=$ROOT/share/ghostscript" "XDG_DATA_DIRS=$ROOT/share:/usr/share"
expect "a host program keeps the host entries of a list" '^XDG_DATA_DIRS=/usr/share$' \
  "$CALLER" execle-env /usr/bin/env "GS_LIB=$ROOT/share/ghostscript" "XDG_DATA_DIRS=$ROOT/share:/usr/share"
expect "a filtered 5,000-entry environment reaches the host program" '^envc=5000$' \
  "$CALLER" execve-env-ld "$WORK/bin/envcount" 5000

[ "$failures" -eq 0 ] || die "image-exec: $failures of $cases case(s) failed"
echo "image-exec: every case passed ($cases cases)"
