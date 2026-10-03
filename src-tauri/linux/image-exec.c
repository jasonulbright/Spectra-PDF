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
 * R1. No limit is lower than the C library's. argv and envp are counted and
 *     the arrays a rewrite needs are variable-length arrays of exactly that
 *     size. A rewrite whose pointer arrays reach the kernel's argument limit
 *     is not built: a payload start fails with E2BIG, the kernel's answer for
 *     the rewritten start, and a host start goes to the kernel unfiltered,
 *     which refuses it with the errno it gives the filtered one.
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
 *     file actions and attributes. It
 *     makes the payload, image and host decision after the actions, then
 *     execs. It connects to an abstract socket this library listens on and
 *     sends the errno of a failed exec, so posix_spawn fails with that errno
 *     and the child is reaped, as glibc does; a successful exec closes the
 *     socket. An absolute name, a relative name without file actions, and a
 *     search that reaches only host files keep the direct path.
 * R4. execvp, execvpe and execlp follow glibc's __execvpe_common: a name
 *     without a slash is tried in every PATH entry, ENOEXEC runs the file
 *     through /bin/sh, EACCES, ENOENT, ESTALE, ENOTDIR, ENODEV and ETIMEDOUT
 *     continue the search, EACCES is reported when one was seen. posix_spawnp
 *     searches the same way without the shell fallback (the default symbol
 *     version of glibc 2.15 and later, which the image carries), with the
 *     caller's PATH, in the child. A name without a slash is relative to the
 *     current directory for execve, execv, execl, execle and posix_spawn.
 *
 * The exec wrappers may run in a vfork child: the next functions are bound
 * once at load, and image-exec.h allocates on the stack only. system(3) and
 * popen(3) start /bin/sh through the C library's internal spawn, which no
 * preload intercepts; a program the shell then starts is not moved.
 * fexecve(3) and execveat(2) are not wrapped: they name a program by file
 * descriptor, and neither LibreOffice's process launcher nor the engine's
 * subprocess module calls them.
 *
 * Environment, set by the launchers:
 *   SPECTRAPDF_IMAGE_ROOT          the image's mount point
 *   SPECTRAPDF_IMAGE_EXEC          the path of this library
 *   SPECTRAPDF_IMAGE_LIBRARY_PATH  lib/ and every directory lib/lib.path names
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdarg.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>

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

/* glibc's execl family: the variadic list counted, then copied to the stack. */
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

int execl(const char *path, const char *arg, ...)
{
	size_t argc;
	COUNT_ARGS(arg, argc);
	char *args[argc + 1];
	char **unused = NULL;
	COPY_ARGS(arg, args, argc, 0, unused);
	(void)unused;
	return start_exec(path, args, environ);
}

int execlp(const char *file, const char *arg, ...)
{
	size_t argc;
	COUNT_ARGS(arg, argc);
	char *args[argc + 1];
	char **unused = NULL;
	COPY_ARGS(arg, args, argc, 0, unused);
	(void)unused;
	return search_exec(file, args, environ);
}

int execle(const char *path, const char *arg, ...)
{
	size_t argc;
	COUNT_ARGS(arg, argc);
	char *args[argc + 1];
	char **envp = environ;
	COPY_ARGS(arg, args, argc, 1, envp);
	return start_exec(path, args, envp);
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

/* Whether a PATH entry glibc's search tries for `file` names a file inside the image. */
static int search_reaches_image(const struct image *im, const char *file, const char *path)
{
	if (!path)
		path = IMAGE_DEFAULT_PATH;
	size_t file_len = strnlen(file, NAME_MAX + 1) + 1;
	size_t path_len = strnlen(path, PATH_MAX - 1) + 1;
	if (file_len - 1 > NAME_MAX)
		return 0;
	char buffer[path_len + file_len + 1];
	char real[PATH_MAX];
	const char *subp;
	for (const char *p = path;; p = subp) {
		subp = strchrnul(p, ':');
		if ((size_t)(subp - p) >= path_len) {
			if (*subp == '\0')
				return 0;
			continue;
		}
		char *pend = mempcpy(buffer, p, (size_t)(subp - p));
		*pend = '/';
		memcpy(pend + (p < subp), file, file_len);
		if (image_classify(im, buffer, real) != IMAGE_HOST)
			return 1;
		if (*subp++ == '\0')
			return 0;
	}
}

static int child_exited(pid_t child)
{
	siginfo_t info;
	memset(&info, 0, sizeof info);
	return waitid(P_PID, (id_t)child, &info, WEXITED | WNOHANG | WNOWAIT) == 0 && info.si_pid == child;
}

/*
 * Waits until the trampoline `child` connects to `listener` or exits.
 * Returns the connection, or -1 when the child exited without connecting.
 */
static int await_trampoline(int listener, pid_t child)
{
	int pidfd = -1;
#ifdef SYS_pidfd_open
	pidfd = (int)syscall(SYS_pidfd_open, child, 0);
#endif
	int connection = -1;
	for (;;) {
		struct pollfd fds[2] = { { listener, POLLIN, 0 }, { pidfd, POLLIN, 0 } };
		int ready = poll(fds, pidfd >= 0 ? 2 : 1, pidfd >= 0 ? -1 : 10);
		if (ready < 0 && errno != EINTR)
			break;
		if (ready > 0 && (fds[0].revents & POLLIN)) {
			int c = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
			if (c >= 0) {
				struct ucred cred;
				socklen_t len = sizeof cred;
				if (getsockopt(c, SOL_SOCKET, SO_PEERCRED, &cred, &len) == 0 && cred.pid == child) {
					connection = c;
					break;
				}
				close(c);
			}
			continue;
		}
		if (pidfd >= 0 ? ready > 0 && (fds[1].revents & POLLIN) : child_exited(child))
			break;
	}
	if (pidfd >= 0)
		close(pidfd);
	return connection;
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
	char trampoline[strlen(im->root) + sizeof IMAGE_TRAMPOLINE];
	image_copy(image_copy(trampoline, im->root), IMAGE_TRAMPOLINE);

	int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (listener < 0)
		return errno;
	struct sockaddr_un address;
	memset(&address, 0, sizeof address);
	address.sun_family = AF_UNIX;
	socklen_t length = sizeof(sa_family_t);
	if (bind(listener, (struct sockaddr *)&address, length) != 0 || listen(listener, 4) != 0 ||
	    (length = sizeof address, getsockname(listener, (struct sockaddr *)&address, &length) != 0) ||
	    length <= offsetof(struct sockaddr_un, sun_path) + 1) {
		int err = errno;
		close(listener);
		return err ? err : EADDRNOTAVAIL;
	}
	size_t name_len = length - offsetof(struct sockaddr_un, sun_path) - 1;
	char name[name_len + 1];
	memcpy(name, address.sun_path + 1, name_len);
	name[name_len] = '\0';

	const char *path = getenv("PATH");
	size_t path_len = path ? strlen(path) : 0;
	char path_arg[path_len + 2];
	path_arg[0] = path ? 'P' : 'U';
	memcpy(path_arg + 1, path ? path : "", path_len + 1);
	size_t library_len = im->library_path ? strlen(im->library_path) : 0;
	char library_arg[library_len + 2];
	library_arg[0] = im->library_path ? 'P' : 'U';
	memcpy(library_arg + 1, im->library_path ? im->library_path : "", library_len + 1);

	char *args[8 + argc + 1];
	size_t n = 0;
	args[n++] = trampoline;
	args[n++] = name;
	args[n++] = use_path ? "spawnp" : "spawn";
	args[n++] = path_arg;
	args[n++] = (char *)im->root;
	args[n++] = (char *)im->self;
	args[n++] = library_arg;
	args[n++] = (char *)file;
	for (size_t i = 0; i < argc; i++)
		args[n++] = argv[i];
	args[n] = NULL;

	pid_t child = -1;
	int err = next_spawn(&child, trampoline, actions, attr, args, envp);
	if (err != 0) {
		close(listener);
		return err;
	}
	int connection = await_trampoline(listener, child);
	close(listener);
	int child_err = 0;
	if (connection >= 0) {
		size_t got = 0;
		while (got < sizeof child_err) {
			ssize_t r = read(connection, (char *)&child_err + got, sizeof child_err - got);
			if (r < 0 && errno == EINTR)
				continue;
			if (r <= 0)
				break;
			got += (size_t)r;
		}
		close(connection);
		if (got != sizeof child_err)
			child_err = 0;
	}
	if (child_err > 0) {
		while (waitpid(child, NULL, 0) < 0 && errno == EINTR)
			;
		return child_err;
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
