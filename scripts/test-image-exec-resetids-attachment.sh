#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "RESETIDS attachment regression requires root to create two UID contexts"
  exit 77
fi
[ $# -eq 1 ] || { echo "usage: $0 image-exec.so" >&2; exit 2; }
LIB="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
TRAMPOLINE="$(dirname "$LIB")/image-exec-trampoline"
[ -f "$LIB" ] || { echo "no image-exec library at $LIB" >&2; exit 2; }
[ -x "$TRAMPOLINE" ] || { echo "no trampoline at $TRAMPOLINE" >&2; exit 2; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM
IMAGE="$WORK/image"
BIN="$IMAGE/lib/spectrapdf/tool/bin"
HOOK="$WORK/hold-shm.so"
mkdir -p "$BIN" "$IMAGE/lib/image-exec"
chmod 0755 "$WORK" "$IMAGE" "$IMAGE/lib" "$IMAGE/lib/spectrapdf" "$IMAGE/lib/spectrapdf/tool" "$BIN" "$IMAGE/lib/image-exec"
cp "$TRAMPOLINE" "$IMAGE/lib/image-exec/image-exec-trampoline"

for name in ready hook-release attached controller-release spawn-returned payload-started attach-result; do
  : > "$WORK/$name"
  chmod 0666 "$WORK/$name"
done

cat > "$WORK/hold-shm.c" <<'EOF'
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/shm.h>
#include <time.h>
#include <unistd.h>

typedef int (*shmctl_fn)(int, int, struct shmid_ds *);

int shmctl(int id, int command, struct shmid_ds *info)
{
  static shmctl_fn next;
  if (!next) next = (shmctl_fn)dlsym(RTLD_NEXT, "shmctl");
  int result = next(id, command, info);
  if (result == 0 && command == IPC_RMID && geteuid() == 2000 && getuid() == 1000) {
    const char *ready = getenv("CX17_READY");
    const char *release = getenv("CX17_HOOK_RELEASE");
    int fd = open(ready, O_WRONLY | O_TRUNC);
    if (fd >= 0) {
      dprintf(fd, "%d\n", id);
      close(fd);
    }
    struct timespec pause = { 0, 10000000 };
    for (;;) {
      FILE *f = fopen(release, "r");
      int go = f && fgetc(f) == '1';
      if (f) fclose(f);
      if (go) break;
      nanosleep(&pause, NULL);
    }
  }
  return result;
}
EOF

cat > "$WORK/controller.c" <<'EOF'
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/shm.h>
#include <time.h>
#include <unistd.h>

static int nonempty(const char *path)
{
  FILE *f = fopen(path, "r");
  int c = f ? fgetc(f) : EOF;
  if (f) fclose(f);
  return c != EOF;
}

int main(void)
{
  if (setresuid(1000, 1000, 1000) != 0) return 2;
  const char *ready = getenv("CX17_READY");
  const char *attached = getenv("CX17_ATTACHED");
  const char *release = getenv("CX17_CONTROLLER_RELEASE");
  const char *payload = getenv("CX17_PAYLOAD_STARTED");
  const char *spawn_returned = getenv("CX17_SPAWN_RETURNED");
  const char *attach_result = getenv("CX17_ATTACH_RESULT");
  struct timespec pause = { 0, 10000000 };
  for (int i = 0; i < 500 && !nonempty(ready); i++) nanosleep(&pause, NULL);
  FILE *f = fopen(ready, "r");
  int id = -1;
  if (!f || fscanf(f, "%d", &id) != 1) return 3;
  fclose(f);
  void *mapping = shmat(id, NULL, 0);
  if (mapping == (void *)-1) return 4;
  f = fopen(attached, "w");
  if (!f) return 5;
  fputs("1", f);
  fclose(f);
  for (int i = 0; i < 500 && !nonempty(payload); i++) nanosleep(&pause, NULL);
  if (!nonempty(payload)) return 6;
  for (int i = 0; i < 500 && !nonempty(spawn_returned); i++) nanosleep(&pause, NULL);
  if (!nonempty(spawn_returned)) return 7;
  errno = 0;
  void *late_mapping = shmat(id, NULL, 0);
  int denied = late_mapping == (void *)-1 && errno == EACCES;
  if (late_mapping != (void *)-1) shmdt(late_mapping);
  f = fopen(attach_result, "w");
  if (!f) return 8;
  fputs(denied ? "blocked" : "allowed", f);
  fclose(f);
  for (int i = 0; i < 500 && !nonempty(release); i++) nanosleep(&pause, NULL);
  f = fopen(release, "r");
  int go = f && fgetc(f) == '1';
  if (f) fclose(f);
  shmdt(mapping);
  return go ? 0 : 9;
}
EOF

cat > "$WORK/caller.c" <<'EOF'
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;

int main(void)
{
  if (setresuid(1000, 2000, 1000) != 0) return 2;
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attr;
  if (posix_spawn_file_actions_init(&actions) || posix_spawnattr_init(&attr)) return 3;
  if (posix_spawn_file_actions_addchdir_np(&actions, "/") ||
      posix_spawnattr_setflags(&attr, POSIX_SPAWN_RESETIDS)) return 4;
  char *argv[] = { "helper", NULL };
  pid_t child = -1;
  int rc = posix_spawnp(&child, "helper", &actions, &attr, argv, environ);
  FILE *f = fopen(getenv("CX17_SPAWN_RETURNED"), "w");
  if (!f) return 5;
  fprintf(f, "%d\n", rc);
  fclose(f);
  if (rc) return 6;
  int status = 0;
  pid_t waited;
  do {
    waited = waitpid(child, &status, 0);
  } while (waited < 0 && errno == EINTR);
  if (waited != child) return 7;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 8;
}
EOF

cat > "$WORK/helper.c" <<'EOF'
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
int main(void)
{
  FILE *f = fopen(getenv("CX17_PAYLOAD_STARTED"), "w");
  if (!f) return 2;
  fputs("1", f);
  fclose(f);
  struct timespec delay = { 8, 0 };
  nanosleep(&delay, NULL);
  return 0;
}
EOF

cat > "$IMAGE/lib/ld-linux-x86-64.so.2" <<'EOF'
#!/bin/sh
exec /lib64/ld-linux-x86-64.so.2 "$@"
EOF
chmod 0755 "$IMAGE/lib/ld-linux-x86-64.so.2"

gcc -shared -fPIC -O2 -Wall -Wextra -Werror -o "$HOOK" "$WORK/hold-shm.c" -ldl
gcc -O2 -Wall -Wextra -Werror -o "$WORK/controller" "$WORK/controller.c"
gcc -O2 -Wall -Wextra -Werror -o "$WORK/caller" "$WORK/caller.c"
gcc -O2 -Wall -Wextra -Werror -o "$BIN/helper" "$WORK/helper.c"

export CX17_READY="$WORK/ready" CX17_HOOK_RELEASE="$WORK/hook-release"
export CX17_ATTACHED="$WORK/attached" CX17_CONTROLLER_RELEASE="$WORK/controller-release"
export CX17_SPAWN_RETURNED="$WORK/spawn-returned" CX17_PAYLOAD_STARTED="$WORK/payload-started"
export CX17_ATTACH_RESULT="$WORK/attach-result"
export SPECTRAPDF_IMAGE_ROOT="$IMAGE" SPECTRAPDF_IMAGE_EXEC="$LIB" SPECTRAPDF_IMAGE_LIBRARY_PATH="$IMAGE/lib"
export PATH="$BIN:/usr/bin:/bin"

"$WORK/controller" & controller_pid=$!
LD_PRELOAD="$HOOK:$LIB" "$WORK/caller" & caller_pid=$!

wait_file() {
  path="$1"
  for i in $(seq 1 500); do
    [ -s "$path" ] && return 0
    sleep 0.01
  done
  return 1
}

if ! wait_file "$WORK/attached"; then
  kill "$controller_pid" "$caller_pid" 2>/dev/null || true
  echo "controller could not attach to the reset-UID segment"
  exit 1
fi
printf 1 > "$WORK/hook-release"
if ! wait_file "$WORK/payload-started"; then
  printf 1 > "$WORK/controller-release"
  kill "$controller_pid" "$caller_pid" 2>/dev/null || true
  echo "payload did not start"
  exit 1
fi
if ! wait_file "$WORK/spawn-returned"; then
  printf 1 > "$WORK/controller-release"
  kill "$controller_pid" "$caller_pid" 2>/dev/null || true
  wait "$controller_pid" 2>/dev/null || true
  wait "$caller_pid" 2>/dev/null || true
  echo "RESETIDS attachment regression: posix_spawn stayed blocked while UID 1000 held the segment"
  exit 1
fi
if [ "$(cat "$WORK/spawn-returned")" != 0 ]; then
  printf 1 > "$WORK/controller-release"
  wait "$controller_pid" 2>/dev/null || true
  wait "$caller_pid" 2>/dev/null || true
  echo "RESETIDS attachment regression: posix_spawn reported an error"
  exit 1
fi
if ! wait_file "$WORK/attach-result"; then
  printf 1 > "$WORK/controller-release"
  wait "$controller_pid" 2>/dev/null || true
  wait "$caller_pid" 2>/dev/null || true
  echo "RESETIDS attachment regression: controller did not check a late attachment"
  exit 1
fi
if [ "$(cat "$WORK/attach-result")" != blocked ]; then
  printf 1 > "$WORK/controller-release"
  wait "$controller_pid" 2>/dev/null || true
  wait "$caller_pid" 2>/dev/null || true
  echo "RESETIDS attachment regression: shared-memory ownership stayed available to UID 1000"
  exit 1
fi
printf 1 > "$WORK/controller-release"
wait "$controller_pid"
wait "$caller_pid"
echo "RESETIDS attachment regression passed: posix_spawn returned while UID 1000 held the segment"
