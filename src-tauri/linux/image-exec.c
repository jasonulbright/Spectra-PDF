/*
 * Preloaded by the AppImage's LibreOffice and Python launchers. A payload
 * program names the system loader as its interpreter, so a payload program
 * that LibreOffice or Python starts itself (xpdfimport for PDF import, for
 * one) would run on the host's C library and fail on an older one. Every
 * exec or spawn of a dynamic ELF file under $SPECTRAPDF_IMAGE_ROOT/lib/spectrapdf
 * becomes a start of the image's loader with that program, its original
 * argv[0] (--argv0), this library preloaded again, and the payload's and the
 * image's libraries on the search path. Any other program outside the image
 * starts with no preload (the library is built against the image's C library,
 * not the host's) and without the variables that name the image: every LD_
 * variable goes, image entries leave colon-separated lists, and other
 * variables naming the image go. The decisions live in image-exec.h.
 *
 * The wrapper is transparent for every other start:
 *
 * R1. No argument or environment size limit is lower than the C library's.
 *     argv and envp are counted and the arrays a rewrite needs have exactly
 *     that size. A rewrite whose pointer arrays reach the kernel's argument
 *     limit is not built: a payload start fails with E2BIG, the kernel's
 *     answer for the rewritten start, and a host start goes to the kernel
 *     unfiltered, which refuses it with the errno it gives the filtered one.
 *     If a host environment needs filtering but memory for its new pointer
 *     array is unavailable, the start fails with ENOMEM. Passing the original
 *     array would leak image-specific LD_ variables into a host process;
 *     modifying envp is unsafe because it belongs to the caller and can be
 *     shared with its parent in a vfork child.
 * R2. A host program receives the caller's own argv pointer, and the
 *     caller's own envp pointer when no entry is removed. A filtered copy
 *     exists only when an LD_ variable or a variable naming the image is
 *     present.
 * R3. A program name resolves in the context of the process that executes
 *     it. A posix_spawn or posix_spawnp whose file actions run in the child
 *     (any action: chdir and fchdir change the directory, later action kinds
 *     are covered without reading glibc's private action records) and whose
 *     program name is relative, and every posix_spawnp PATH search that can
 *     reach a file inside the image, spawn the static program
 *     lib/image-exec/image-exec-trampoline of the image with the caller's
 *     file actions and attributes. It makes the payload, image and host
 *     decision after the actions, then execs. An absolute name, a relative
 *     name without file actions, and a search that reaches only host files
 *     keep the direct path, where the C library's posix_spawn reports errors.
 * R4. execvp, execvpe and execlp follow glibc's __execvpe_common, and
 *     posix_spawnp its search without the shell fallback (the default symbol
 *     version of glibc 2.15 and later, which the image carries), with the
 *     caller's PATH, in the child. image_path_walk in image-exec.h builds the
 *     candidates for both, and for the check that routes a search to the
 *     trampoline. A name without a slash is relative to the current directory
 *     for execve, execv, execl, execle and posix_spawn.
 * R5. The wrapper adds no descriptor to a spawned child, and the trampoline
 *     needs none to run the requested program. The caller's file actions see
 *     the descriptors and RLIMIT_NOFILE a native spawn gives them; so does the
 *     started program. A private System V shared-memory segment carries the
 *     trampoline's exec errno without relying on /proc or adding a file
 *     descriptor. The segment is marked for deletion before spawning and is
 *     removed when its last attachment goes away. With
 *     POSIX_SPAWN_RESETIDS, its owner is changed to the caller's real UID
 *     after the parent attaches, so the reset-UID trampoline can attach too.
 *     The trampoline attaches, publishes its state, then execs; exec detaches
 *     it automatically. The parent waits for that detach or the reported
 *     error. A program's own exit status, including 127, is left for its
 *     caller.
 * R6. No stack array is sized by caller data beyond a fixed bound:
 *     IMAGE_STACK_BYTES (1 KiB, 128 pointers) for pointer arrays and short
 *     strings, PATH_MAX for path strings. Larger arrays are anonymous
 *     mappings, released on every path that returns (image_buffer_get in
 *     image-exec.h, which also states what a vfork child leaves mapped after
 *     a successful exec). A failed mapping needed to filter a host environment
 *     returns ENOMEM rather than launching with the unfiltered environment.
 *     Fixed buffers are PATH_MAX (a resolved name) and PATH_MAX + NAME_MAX + 2
 *     (a PATH candidate, glibc's own bound).
 *
 * The exec wrappers may run in a vfork child: the next functions are bound
 * once at load, and image-exec.h neither calls malloc nor needs a signal.
 * system(3) and popen(3) start /bin/sh through the C library's internal
 * spawn, which no preload intercepts; a program the shell then starts is not
 * moved. fexecve(3) and execveat(2) are not wrapped: they name a program by
 * file descriptor, and neither LibreOffice's process launcher nor the
 * engine's subprocess module calls them.
 *
 * Environment, set by the launchers:
 *   SPECTRAPDF_IMAGE_ROOT          the image's mount point
 *   SPECTRAPDF_IMAGE_EXEC          the path of this library
 *   SPECTRAPDF_IMAGE_LIBRARY_PATH  lib/ and every directory lib/lib.path names
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <sys/shm.h>
#include <sys/wait.h>
#include <time.h>

#include "image-exec.h"

extern char **environ;

typedef int (*execve_fn)(const char *, char *const[], char *const[]);
typedef int (*spawn_fn)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                        const posix_spawnattr_t *, char *const[], char *const[]);

static execve_fn next_execve;
static spawn_fn next_spawn;
static spawn_fn next_spawnp;

__attribute__((constructor)) static void bind_next(void)
{
	next_execve = (execve_fn)dlsym(RTLD_NEXT, "execve");
	next_spawn = (spawn_fn)dlsym(RTLD_NEXT, "posix_spawn");
	next_spawnp = (spawn_fn)dlsym(RTLD_NEXT, "posix_spawnp");
}

static struct image image_settings(void)
{
	struct image im = { NULL, NULL, NULL };
	const char *root = getenv("SPECTRAPDF_IMAGE_ROOT");
	if (root && root[0] == '/') {
		im.root = root;
		im.self = getenv("SPECTRAPDF_IMAGE_EXEC");
		im.library_path = getenv("SPECTRAPDF_IMAGE_LIBRARY_PATH");
	}
	return im;
}

static int launch_execve(const char *path, char *const argv[], char *const envp[], void *context)
{
	(void)context;
	if (!next_execve)
		bind_next();
	next_execve(path, argv, envp);
	return errno;
}

/* errno and -1 for an exec wrapper; -1 from image-exec.h keeps `saved`. */
static int failed(int err, int saved)
{
	errno = err > 0 ? err : saved;
	return -1;
}

static int start_exec(const char *filename, char *const argv[], char *const envp[])
{
	int saved = errno;
	struct image im = image_settings();
	return failed(image_start(&im, filename, argv, envp, launch_execve, NULL), saved);
}

static int search_exec(const char *file, char *const argv[], char *const envp[])
{
	int saved = errno;
	struct image im = image_settings();
	return failed(image_search(&im, file, argv, envp, getenv("PATH"), 1, launch_execve, NULL), saved);
}

int execve(const char *filename, char *const argv[], char *const envp[])
{
	return start_exec(filename, argv, envp);
}

int execv(const char *path, char *const argv[])
{
	return start_exec(path, argv, environ);
}

int execvpe(const char *file, char *const argv[], char *const envp[])
{
	return search_exec(file, argv, envp);
}

int execvp(const char *file, char *const argv[])
{
	return search_exec(file, argv, environ);
}

/* glibc's execl family: the variadic list counted, then copied. */
#define COUNT_ARGS(first, argc)                                         \
	do {                                                            \
		va_list ap;                                             \
		va_start(ap, first);                                    \
		argc = 1;                                               \
		while (va_arg(ap, char *)) {                            \
			if (argc == INT_MAX) {                          \
				va_end(ap);                             \
				errno = E2BIG;                          \
				return -1;                              \
			}                                               \
			argc++;                                         \
		}                                                       \
		va_end(ap);                                             \
	} while (0)

#define COPY_ARGS(first, args, argc, read_env, envp_out)                \
	do {                                                            \
		va_list ap;                                             \
		va_start(ap, first);                                    \
		args[0] = (char *)(first);                              \
		for (size_t i = 1; i < argc; i++)                       \
			args[i] = va_arg(ap, char *);                   \
		args[argc] = NULL;                                      \
		(void)va_arg(ap, char *);                               \
		if (read_env)                                           \
			envp_out = va_arg(ap, char **);                 \
		va_end(ap);                                             \
	} while (0)

/* `argc` + 1 pointers, or NULL with errno set to what the start would report. */
static char **list_buffer(struct image_buffer *b, void *local, size_t argc)
{
	if (image_pointers_refused(argc + 1, image_argument_limit())) {
		errno = E2BIG;
		return NULL;
	}
	char **args = image_buffer_get(b, local, IMAGE_STACK_BYTES, (argc + 1) * sizeof(char *));
	if (!args)
		errno = ENOMEM;
	return args;
}

static int list_done(struct image_buffer *b, int result)
{
	int saved = errno;
	image_buffer_put(b);
	errno = saved;
	return result;
}

int execl(const char *path, const char *arg, ...)
{
	size_t argc;
	COUNT_ARGS(arg, argc);
	_Alignas(16) char local[IMAGE_STACK_BYTES];
	struct image_buffer b;
	char **args = list_buffer(&b, local, argc);
	if (!args)
		return -1;
	char **unused = NULL;
	COPY_ARGS(arg, args, argc, 0, unused);
	(void)unused;
	return list_done(&b, start_exec(path, args, environ));
}

int execlp(const char *file, const char *arg, ...)
{
	size_t argc;
	COUNT_ARGS(arg, argc);
	_Alignas(16) char local[IMAGE_STACK_BYTES];
	struct image_buffer b;
	char **args = list_buffer(&b, local, argc);
	if (!args)
		return -1;
	char **unused = NULL;
	COPY_ARGS(arg, args, argc, 0, unused);
	(void)unused;
	return list_done(&b, search_exec(file, args, environ));
}

int execle(const char *path, const char *arg, ...)
{
	size_t argc;
	COUNT_ARGS(arg, argc);
	_Alignas(16) char local[IMAGE_STACK_BYTES];
	struct image_buffer b;
	char **args = list_buffer(&b, local, argc);
	if (!args)
		return -1;
	char **envp = environ;
	COPY_ARGS(arg, args, argc, 1, envp);
	return list_done(&b, start_exec(path, args, envp));
}

struct spawn_call {
	spawn_fn next;
	pid_t *pid;
	const posix_spawn_file_actions_t *actions;
	const posix_spawnattr_t *attr;
};

static int launch_spawn(const char *path, char *const argv[], char *const envp[], void *context)
{
	struct spawn_call *c = context;
	return c->next(c->pid, path, c->actions, c->attr, argv, envp);
}

static int has_actions(const posix_spawn_file_actions_t *actions)
{
	return actions && actions->__used > 0;
}

static int resets_ids(const posix_spawnattr_t *attr)
{
	short flags = 0;
	return attr && posix_spawnattr_getflags(attr, &flags) == 0 && (flags & POSIX_SPAWN_RESETIDS);
}

struct reach_state {
	const struct image *im;
	char real[PATH_MAX];
};

static int reaches_image(const char *candidate, void *context)
{
	struct reach_state *s = context;
	return image_classify(s->im, candidate, s->real) != IMAGE_HOST;
}

/* Whether a candidate glibc's PATH search tries for `file` names a file inside the image. */
static int search_reaches_image(const struct image *im, const char *file, const char *path)
{
	if (strnlen(file, NAME_MAX + 1) > NAME_MAX)
		return 0;
	struct reach_state s;
	s.im = im;
	return image_path_walk(file, path, reaches_image, &s);
}

/*
 * A pending trampoline has state 0; after attaching it publishes -1, then
 * leaves that state on a successful exec (which detaches the segment). A
 * failed exec publishes its errno. No descriptor, signal handler or /proc
 * access is involved. Each concurrent spawn owns a separate segment.
 */
static int await_exec(pid_t child, int segment, int *state)
{
	struct timespec delay = { 0, 20000 };
	for (;;) {
		int value = __atomic_load_n(state, __ATOMIC_ACQUIRE);
		if (value > 0)
			return value;
		if (value == -1) {
			struct shmid_ds info;
			if (shmctl(segment, IPC_STAT, &info) == 0 && info.shm_nattch == 1) {
				value = __atomic_load_n(state, __ATOMIC_ACQUIRE);
				return value > 0 ? value : 0;
			}
		}
		siginfo_t info;
		memset(&info, 0, sizeof info);
		if (waitid(P_PID, (id_t)child, &info, WEXITED | WNOHANG | WNOWAIT) != 0) {
			if (errno == EINTR)
				continue;
			value = __atomic_load_n(state, __ATOMIC_ACQUIRE);
			return value > 0 ? value : 0;
		}
		if (info.si_pid == child) {
			value = __atomic_load_n(state, __ATOMIC_ACQUIRE);
			if (value > 0)
				return value;
			// Only the trampoline can exit before publishing the attached state.
			if (value == 0 && info.si_code == CLD_EXITED)
				return info.si_status ? info.si_status : EIO;
			return 0;
		}
		nanosleep(&delay, NULL);
		if (delay.tv_nsec < 1000000)
			delay.tv_nsec *= 2;
	}
}

/* A copy of `value` behind a P, or U for a value that is not set. */
static char *optional_arg(struct image_buffer *b, char *local, const char *value)
{
	size_t len = value ? strlen(value) : 0;
	char *out = image_buffer_get(b, local, PATH_MAX, len + 2);
	if (out) {
		out[0] = value ? 'P' : 'U';
		memcpy(out + 1, value ? value : "", len + 1);
	}
	return out;
}

/*
 * posix_spawn of `file` through the trampoline, which resolves it after the
 * caller's file actions. `use_path` makes it search PATH like posix_spawnp.
 */
static int spawn_in_child(const struct image *im, int use_path, pid_t *pid, const char *file,
                          const posix_spawn_file_actions_t *actions, const posix_spawnattr_t *attr,
                          char *const argv[], char *const envp[])
{
	size_t argc = image_count(argv);
	if (image_pointers_refused(8 + argc + image_count(envp), image_argument_limit()))
		return E2BIG;
	char trampoline_local[IMAGE_STACK_BYTES], path_local[PATH_MAX], library_local[PATH_MAX];
	_Alignas(16) char args_local[IMAGE_STACK_BYTES];
	struct image_buffer tb, pb, lb, ab;
	char *trampoline = image_buffer_get(&tb, trampoline_local, sizeof trampoline_local,
	                                    strlen(im->root) + sizeof IMAGE_TRAMPOLINE);
	char *path_arg = optional_arg(&pb, path_local, getenv("PATH"));
	char *library_arg = optional_arg(&lb, library_local, im->library_path);
	char **args = image_buffer_get(&ab, args_local, sizeof args_local, (8 + argc + 1) * sizeof(char *));
	int err = ENOMEM;
	int reset_child_ids = resets_ids(attr) && getuid() != geteuid();
	pid_t child = -1;
	int segment = -1;
	int *state = (void *)-1;
	char segment_arg[24];
	if (trampoline && path_arg && library_arg && args) {
		image_copy(image_copy(trampoline, im->root), IMAGE_TRAMPOLINE);
		segment = shmget(IPC_PRIVATE, sizeof *state, IPC_CREAT | 0600);
		if (segment < 0) {
			err = errno;
			goto done;
		}
		state = shmat(segment, NULL, 0);
		int attach_errno = errno;
		if (state != (void *)-1 && reset_child_ids) {
			struct shmid_ds info;
			if (shmctl(segment, IPC_STAT, &info) != 0) {
				err = errno;
				(void)shmctl(segment, IPC_RMID, NULL);
				goto done;
			}
			info.shm_perm.uid = getuid();
			if (shmctl(segment, IPC_SET, &info) != 0) {
				err = errno;
				(void)shmctl(segment, IPC_RMID, NULL);
				goto done;
			}
		}
		// Linux permits attachment to an IPC_RMID segment while we hold it.
		if (shmctl(segment, IPC_RMID, NULL) != 0) {
			err = errno;
			goto done;
		}
		if (state == (void *)-1) {
			err = attach_errno;
			goto done;
		}
		// An unrelated fork in another thread must not inherit an attachment:
		// only this parent and the trampoline participate in the detach count.
		if (madvise(state, sizeof *state, MADV_DONTFORK) != 0) {
			err = errno;
			goto done;
		}
		__atomic_store_n(state, 0, __ATOMIC_RELEASE);
		image_decimal(segment_arg, (unsigned long)segment);
		size_t n = 0;
		args[n++] = trampoline;
		args[n++] = segment_arg;
		args[n++] = use_path ? "spawnp" : "spawn";
		args[n++] = path_arg;
		args[n++] = (char *)im->root;
		args[n++] = (char *)im->self;
		args[n++] = library_arg;
		args[n++] = (char *)file;
		for (size_t i = 0; i < argc; i++)
			args[n++] = argv[i];
		args[n] = NULL;
		err = next_spawn(&child, trampoline, actions, attr, args, envp);
	}
done:
	image_buffer_put(&ab);
	image_buffer_put(&lb);
	image_buffer_put(&pb);
	image_buffer_put(&tb);
	int exec_err = err == 0 ? await_exec(child, segment, state) : 0;
	if (state != (void *)-1)
		shmdt(state);
	if (err != 0)
		return err;
	if (exec_err > 0) {
		while (waitpid(child, NULL, 0) < 0 && errno == EINTR)
			;
		return exec_err;
	}
	if (pid)
		*pid = child;
	return 0;
}

static int spawn(int use_path, pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
	if (!next_spawn)
		bind_next();
	if (!next_spawn || !next_spawnp)
		return ENOSYS;
	int saved = errno;
	struct image im = image_settings();
	int bare = use_path && !strchr(file, '/');
	int err;
	if (!im.root) {
		err = (bare ? next_spawnp : next_spawn)(pid, file, actions, attr, argv, envp);
	} else if (im.self && *im.self && *file && file[0] != '/' &&
	           (has_actions(actions) || (bare && search_reaches_image(&im, file, getenv("PATH"))))) {
		err = spawn_in_child(&im, bare, pid, file, actions, attr, argv, envp);
	} else {
		struct spawn_call call = { bare ? next_spawnp : next_spawn, pid, actions, attr };
		err = bare ? image_launch_host(&im, file, argv, envp, launch_spawn, &call)
		           : image_start(&im, file, argv, envp, launch_spawn, &call);
	}
	errno = saved;
	return err;
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
	return spawn(0, pid, path, actions, attr, argv, envp);
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
	return spawn(1, pid, file, actions, attr, argv, envp);
}
