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
 * variables naming the image go.
 *
 * Each wrapper keeps the C library's own semantics: a name without a slash is
 * relative to the current directory for execve, execv, execl, execle and
 * posix_spawn, and searched in PATH for execvp, execvpe, execlp and
 * posix_spawnp. execvp, execvpe and execlp run a file the kernel refuses with
 * ENOEXEC through /bin/sh, continue the PATH search past EACCES, ENOENT,
 * ESTALE, ENOTDIR, ENODEV and ETIMEDOUT, and report EACCES when one was seen.
 * posix_spawn and posix_spawnp have no shell fallback in the default symbol
 * version of glibc 2.15 and later, which the image carries; neither do these.
 *
 * execve may run in a vfork child: the next functions are bound once at load,
 * every buffer is on the stack, nothing calls malloc, printf or a locale
 * function, and a start that does not fit the buffers fails with E2BIG.
 * system(3) and popen(3) start /bin/sh through the C library's internal spawn,
 * which no preload intercepts; a program the shell then starts is not moved.
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
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

extern char **environ;

#define MAX_ARGS 1024
#define MAX_ENV 2048
#define MAX_LISTS 8
#define LIST_SIZE 4096
#define SEARCH_SIZE 16384
#define SHELL "/bin/sh"
#define DEFAULT_PATH "/bin:/usr/bin"

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

static int starts_with(const char *text, const char *prefix)
{
	return strncmp(text, prefix, strlen(prefix)) == 0;
}

/* Appends `len` bytes of `text` to `buf`; 0 when they do not fit. */
static int append(char *buf, size_t size, size_t *used, const char *text, size_t len)
{
	if (*used + len + 1 > size)
		return 0;
	memcpy(buf + *used, text, len);
	*used += len;
	buf[*used] = '\0';
	return 1;
}

static int append_str(char *buf, size_t size, size_t *used, const char *text)
{
	return append(buf, size, used, text, strlen(text));
}

static int requests_interpreter(const char *path)
{
	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		return 0;
	Elf64_Ehdr eh;
	int found = 0;
	if (pread(fd, &eh, sizeof eh, 0) == (ssize_t)sizeof eh &&
	    memcmp(eh.e_ident, ELFMAG, SELFMAG) == 0 && eh.e_ident[EI_CLASS] == ELFCLASS64 &&
	    eh.e_phentsize == sizeof(Elf64_Phdr)) {
		for (int i = 0; i < eh.e_phnum && !found; i++) {
			Elf64_Phdr ph;
			if (pread(fd, &ph, sizeof ph, (off_t)(eh.e_phoff + (Elf64_Off)i * sizeof ph)) != (ssize_t)sizeof ph)
				break;
			found = ph.p_type == PT_INTERP;
		}
	}
	close(fd);
	return found;
}

static const char *image_root(void)
{
	const char *root = getenv("SPECTRAPDF_IMAGE_ROOT");
	return root && root[0] == '/' ? root : NULL;
}

/* Everything one rewritten start needs, on the caller's stack. */
struct start {
	char loader[PATH_MAX];
	char program[PATH_MAX];
	char search[SEARCH_SIZE];
	char *argv[MAX_ARGS + 8];
	char *envp[MAX_ENV + 1];
	char lists[MAX_LISTS][LIST_SIZE];
};

/*
 * When `filename` (absolute, or relative to the current directory) is a
 * payload program, fills s->argv and returns 1; returns 0 for any other
 * file, and -1 with errno E2BIG when the start does not fit the buffers.
 */
static int payload_start(const char *filename, char *const argv[], struct start *s)
{
	const char *root = image_root();
	const char *self = getenv("SPECTRAPDF_IMAGE_EXEC");
	const char *image_path = getenv("SPECTRAPDF_IMAGE_LIBRARY_PATH");
	if (!root || !self || !*self || !image_path || !filename || !*filename)
		return 0;
	char payload[PATH_MAX], office[PATH_MAX];
	size_t pu = 0, ou = 0;
	if (!append_str(payload, sizeof payload, &pu, root) || !append_str(payload, sizeof payload, &pu, "/lib/spectrapdf/") ||
	    !append_str(office, sizeof office, &ou, root) ||
	    !append_str(office, sizeof office, &ou, "/lib/spectrapdf/libreoffice/"))
		return 0;
	if (!realpath(filename, s->program) || !starts_with(s->program, payload) || !requests_interpreter(s->program))
		return 0;

	size_t argc = 0;
	while (argv && argv[argc])
		argc++;
	size_t dir_len = (size_t)(strrchr(s->program, '/') - s->program);
	size_t su = 0, lu = 0;
	s->search[0] = '\0';
	int fits = append(s->search, sizeof s->search, &su, s->program, dir_len) &&
	           append_str(s->search, sizeof s->search, &su, ":") &&
	           append(s->search, sizeof s->search, &su, s->program, dir_len) &&
	           append_str(s->search, sizeof s->search, &su, "/../lib:");
	if (fits && starts_with(s->program, office))
		fits = append_str(s->search, sizeof s->search, &su, root) &&
		       append_str(s->search, sizeof s->search, &su, "/lib/spectrapdf/libreoffice/program:");
	fits = fits && append_str(s->search, sizeof s->search, &su, image_path) &&
	       append_str(s->loader, sizeof s->loader, &lu, root) &&
	       append_str(s->loader, sizeof s->loader, &lu, "/lib/ld-linux-x86-64.so.2") && argc <= MAX_ARGS;
	if (!fits) {
		errno = E2BIG;
		return -1;
	}
	size_t n = 0;
	s->argv[n++] = s->loader;
	s->argv[n++] = "--preload";
	s->argv[n++] = (char *)self;
	s->argv[n++] = "--library-path";
	s->argv[n++] = s->search;
	if (argc > 0) {
		s->argv[n++] = "--argv0";
		s->argv[n++] = argv[0];
	}
	s->argv[n++] = s->program;
	for (size_t i = 1; i < argc; i++)
		s->argv[n++] = argv[i];
	s->argv[n] = NULL;
	return 1;
}

/* Whether `filename` lies inside the image (a launcher, a sharun link). */
static int inside_image(const char *filename)
{
	const char *root = image_root();
	char real[PATH_MAX], prefix[PATH_MAX];
	size_t used = 0;
	if (!root || !filename || !*filename || !realpath(filename, real) ||
	    !append_str(prefix, sizeof prefix, &used, root) || !append_str(prefix, sizeof prefix, &used, "/"))
		return 0;
	return starts_with(real, prefix);
}

/*
 * s->envp: `envp` (NULL is an empty environment) without the variables that
 * name the image. Returns 1 when built, 0 outside an image, -1 with errno
 * E2BIG when the environment does not fit the buffers.
 */
static int host_environment(char *const envp[], struct start *s)
{
	const char *root = image_root();
	if (!root)
		return 0;
	size_t n = 0, lists = 0;
	for (size_t i = 0; envp && envp[i]; i++) {
		const char *entry = envp[i];
		if (n >= MAX_ENV) {
			errno = E2BIG;
			return -1;
		}
		if (starts_with(entry, "LD_"))
			continue;
		const char *eq = strchr(entry, '=');
		if (!eq || !strstr(eq + 1, root)) {
			s->envp[n++] = (char *)entry;
			continue;
		}
		if (!strchr(eq + 1, ':'))
			continue;
		if (lists >= MAX_LISTS) {
			errno = E2BIG;
			return -1;
		}
		char *out = s->lists[lists];
		size_t used = 0;
		int kept = 0;
		if (!append(out, LIST_SIZE, &used, entry, (size_t)(eq - entry) + 1)) {
			errno = E2BIG;
			return -1;
		}
		const char *part = eq + 1;
		for (;;) {
			const char *end = strchr(part, ':');
			size_t part_len = end ? (size_t)(end - part) : strlen(part);
			const char *hit = strstr(part, root);
			if (!hit || (end && hit >= end)) {
				if ((kept && !append_str(out, LIST_SIZE, &used, ":")) ||
				    !append(out, LIST_SIZE, &used, part, part_len)) {
					errno = E2BIG;
					return -1;
				}
				kept = 1;
			}
			if (!end)
				break;
			part = end + 1;
		}
		if (kept) {
			s->envp[n++] = out;
			lists++;
		}
	}
	s->envp[n] = NULL;
	return 1;
}

/* execve(2) through the payload rewrite and the host environment. */
static int start_execve(const char *filename, char *const argv[], char *const envp[])
{
	if (!next_execve)
		bind_next();
	struct start s;
	int rewritten = payload_start(filename, argv, &s);
	if (rewritten < 0)
		return -1;
	if (rewritten)
		return next_execve(s.loader, s.argv, envp);
	if (!inside_image(filename)) {
		int built = host_environment(envp, &s);
		if (built < 0)
			return -1;
		if (built)
			return next_execve(filename, argv, s.envp);
	}
	return next_execve(filename, argv, envp);
}

/* glibc's maybe_script_execute: run `file` as a shell script. */
static void script_execute(const char *file, char *const argv[], char *const envp[])
{
	char *args[MAX_ARGS + 2];
	size_t argc = 1;
	while (argv && argv[0] && argv[argc])
		argc++;
	if (argc > MAX_ARGS) {
		errno = E2BIG;
		return;
	}
	size_t n = 0;
	args[n++] = SHELL;
	args[n++] = (char *)file;
	for (size_t i = 1; argv && argv[0] && i < argc; i++)
		args[n++] = argv[i];
	args[n] = NULL;
	start_execve(SHELL, args, envp);
}

int execve(const char *filename, char *const argv[], char *const envp[])
{
	return start_execve(filename, argv, envp);
}

int execv(const char *path, char *const argv[])
{
	return start_execve(path, argv, environ);
}

int execvpe(const char *file, char *const argv[], char *const envp[])
{
	if (*file == '\0') {
		errno = ENOENT;
		return -1;
	}
	if (strchr(file, '/')) {
		start_execve(file, argv, envp);
		if (errno == ENOEXEC)
			script_execute(file, argv, envp);
		return -1;
	}
	size_t file_len = strnlen(file, NAME_MAX + 1);
	if (file_len > NAME_MAX) {
		errno = ENAMETOOLONG;
		return -1;
	}
	const char *path = getenv("PATH");
	if (!path)
		path = DEFAULT_PATH;
	int got_eacces = 0;
	for (const char *p = path;;) {
		const char *end = strchrnul(p, ':');
		char candidate[PATH_MAX];
		size_t used = 0;
		int fits = append(candidate, sizeof candidate, &used, p, (size_t)(end - p)) &&
		           (end == p || append_str(candidate, sizeof candidate, &used, "/")) &&
		           append(candidate, sizeof candidate, &used, file, file_len);
		if (fits) {
			start_execve(candidate, argv, envp);
			if (errno == ENOEXEC)
				script_execute(candidate, argv, envp);
			switch (errno) {
			case EACCES:
				got_eacces = 1;
				break;
			case ENOENT:
			case ESTALE:
			case ENOTDIR:
			case ENODEV:
			case ETIMEDOUT:
				break;
			default:
				return -1;
			}
		}
		if (*end == '\0')
			break;
		p = end + 1;
	}
	if (got_eacces)
		errno = EACCES;
	return -1;
}

int execvp(const char *file, char *const argv[])
{
	return execvpe(file, argv, environ);
}

/*
 * Collects the variadic arguments of execl, execlp and execle on the stack;
 * more than MAX_ARGS fails with E2BIG.
 */
#define COLLECT_ARGS(first, args, read_env, envp_out)                         \
	do {                                                                  \
		va_list ap;                                                   \
		size_t count = 0;                                             \
		va_start(ap, first);                                          \
		args[count++] = (char *)(first);                              \
		char *next_arg = (char *)(first);                             \
		while (next_arg && (next_arg = va_arg(ap, char *)) != NULL) { \
			if (count >= MAX_ARGS) {                              \
				va_end(ap);                                   \
				errno = E2BIG;                                \
				return -1;                                    \
			}                                                     \
			args[count++] = next_arg;                             \
		}                                                             \
		args[count] = NULL;                                           \
		if (read_env)                                                 \
			envp_out = va_arg(ap, char **);                       \
		va_end(ap);                                                   \
	} while (0)

int execl(const char *path, const char *arg, ...)
{
	char *args[MAX_ARGS + 1];
	char **unused = NULL;
	COLLECT_ARGS(arg, args, 0, unused);
	(void)unused;
	return start_execve(path, args, environ);
}

int execlp(const char *file, const char *arg, ...)
{
	char *args[MAX_ARGS + 1];
	char **unused = NULL;
	COLLECT_ARGS(arg, args, 0, unused);
	(void)unused;
	return execvpe(file, args, environ);
}

int execle(const char *path, const char *arg, ...)
{
	char *args[MAX_ARGS + 1];
	char **envp = environ;
	COLLECT_ARGS(arg, args, 1, envp);
	return start_execve(path, args, envp);
}

/*
 * The program posix_spawnp would start: the first regular executable file
 * named `file` in PATH. 0 when none is found; posix_spawnp then reports it.
 */
static int search_path(const char *file, char *found, size_t size)
{
	const char *path = getenv("PATH");
	if (!path)
		path = DEFAULT_PATH;
	for (const char *p = path;;) {
		const char *end = strchrnul(p, ':');
		size_t used = 0;
		struct stat st;
		if (append(found, size, &used, p, (size_t)(end - p)) &&
		    (end == p || append_str(found, size, &used, "/")) && append_str(found, size, &used, file) &&
		    stat(found, &st) == 0 && S_ISREG(st.st_mode) && access(found, X_OK) == 0)
			return 1;
		if (*end == '\0')
			return 0;
		p = end + 1;
	}
}

static int spawn(spawn_fn next, int use_path, pid_t *pid, const char *path,
                 const posix_spawn_file_actions_t *actions, const posix_spawnattr_t *attr,
                 char *const argv[], char *const envp[])
{
	if (!next)
		return ENOSYS;
	struct start s;
	char found[PATH_MAX];
	const char *program = path;
	if (use_path && !strchr(path, '/'))
		program = search_path(path, found, sizeof found) ? found : NULL;
	if (program) {
		int rewritten = payload_start(program, argv, &s);
		if (rewritten < 0)
			return errno;
		if (rewritten)
			return next_spawn(pid, s.loader, actions, attr, s.argv, envp);
		if (inside_image(program))
			return next(pid, path, actions, attr, argv, envp);
	}
	int built = host_environment(envp, &s);
	if (built < 0)
		return errno;
	return next(pid, path, actions, attr, argv, built ? s.envp : envp);
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
	if (!next_spawn)
		bind_next();
	return spawn(next_spawn, 0, pid, path, actions, attr, argv, envp);
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
	if (!next_spawnp)
		bind_next();
	return spawn(next_spawnp, 1, pid, file, actions, attr, argv, envp);
}
