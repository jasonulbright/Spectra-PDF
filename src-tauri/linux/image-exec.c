/*
 * Preloaded by the AppImage's LibreOffice and Python launchers. A payload
 * program names the system loader as its interpreter, so a payload program
 * that LibreOffice or Python starts itself (xpdfimport for PDF import, for
 * one) would run on the host's C library and fail on an older one. Every
 * exec or spawn of a dynamic ELF file under $SPECTRAPDF_IMAGE_ROOT/lib/spectrapdf
 * becomes a start of the image's loader with that program, this library
 * preloaded again, and the payload's and the image's libraries on the search
 * path. Any other program outside the image starts with no preload (the
 * library is built against the image's C library, not the host's) and without
 * the variables that name the image: every LD_ variable goes, image entries
 * leave colon-separated lists, and other variables naming the image go.
 *
 * execve may run in a vfork child, so nothing here allocates: every buffer is
 * on the stack, and a start that does not fit them runs unchanged.
 * system(3) and popen(3) start /bin/sh through the C library's internal spawn,
 * which no preload intercepts; a program the shell then starts is not moved.
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
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

#define MAX_ARGS 1024
#define MAX_ENV 1024
#define MAX_LISTS 8
#define LIST_SIZE 4096
#define SEARCH_SIZE 16384

typedef int (*execve_fn)(const char *, char *const[], char *const[]);
typedef int (*spawn_fn)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                        const posix_spawnattr_t *, char *const[], char *const[]);

static int starts_with(const char *text, const char *prefix)
{
	return strncmp(text, prefix, strlen(prefix)) == 0;
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

/* Fills s->argv when `filename` is a payload program: 1, else 0. */
static int payload_start(const char *filename, char *const argv[], struct start *s)
{
	const char *root = image_root();
	const char *self = getenv("SPECTRAPDF_IMAGE_EXEC");
	const char *image_path = getenv("SPECTRAPDF_IMAGE_LIBRARY_PATH");
	if (!root || !self || !*self || !image_path)
		return 0;
	char payload[PATH_MAX], office[PATH_MAX], dir[PATH_MAX];
	if (!realpath(filename, s->program))
		return 0;
	if (snprintf(payload, sizeof payload, "%s/lib/spectrapdf/", root) >= (int)sizeof payload ||
	    snprintf(office, sizeof office, "%s/lib/spectrapdf/libreoffice/", root) >= (int)sizeof office)
		return 0;
	if (!starts_with(s->program, payload) || !requests_interpreter(s->program))
		return 0;
	snprintf(dir, sizeof dir, "%s", s->program);
	*strrchr(dir, '/') = '\0';
	int used;
	if (starts_with(s->program, office))
		used = snprintf(s->search, sizeof s->search, "%s:%s/../lib:%s/lib/spectrapdf/libreoffice/program:%s",
		                dir, dir, root, image_path);
	else
		used = snprintf(s->search, sizeof s->search, "%s:%s/../lib:%s", dir, dir, image_path);
	if (used >= (int)sizeof s->search ||
	    snprintf(s->loader, sizeof s->loader, "%s/lib/ld-linux-x86-64.so.2", root) >= (int)sizeof s->loader)
		return 0;

	size_t argc = 0;
	while (argv && argv[argc])
		argc++;
	if (argc > MAX_ARGS)
		return 0;
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
	if (!root || !realpath(filename, real) || snprintf(prefix, sizeof prefix, "%s/", root) >= (int)sizeof prefix)
		return 0;
	return starts_with(real, prefix);
}

/* s->envp: `envp` without the variables that name the image; 1 when built. */
static int host_environment(char *const envp[], struct start *s)
{
	const char *root = image_root();
	if (!root)
		return 0;
	size_t n = 0, lists = 0;
	for (size_t i = 0; envp && envp[i]; i++) {
		const char *entry = envp[i];
		if (n >= MAX_ENV)
			return 0;
		if (starts_with(entry, "LD_"))
			continue;
		const char *eq = strchr(entry, '=');
		if (!eq || !strstr(eq + 1, root)) {
			s->envp[n++] = (char *)entry;
			continue;
		}
		if (!strchr(eq + 1, ':') || lists >= MAX_LISTS)
			continue;
		char *out = s->lists[lists];
		size_t len = (size_t)(eq - entry) + 1;
		if (len >= LIST_SIZE)
			continue;
		memcpy(out, entry, len);
		int kept = 0;
		const char *part = eq + 1;
		while (part) {
			const char *end = strchr(part, ':');
			size_t part_len = end ? (size_t)(end - part) : strlen(part);
			char piece[PATH_MAX];
			if (part_len < sizeof piece) {
				memcpy(piece, part, part_len);
				piece[part_len] = '\0';
				if (!strstr(piece, root) && len + part_len + 2 < LIST_SIZE) {
					if (kept)
						out[len++] = ':';
					memcpy(out + len, piece, part_len);
					len += part_len;
					kept = 1;
				}
			}
			part = end ? end + 1 : NULL;
		}
		out[len] = '\0';
		if (kept) {
			s->envp[n++] = out;
			lists++;
		}
	}
	s->envp[n] = NULL;
	return 1;
}

static int start_execve(const char *filename, char *const argv[], char *const envp[])
{
	execve_fn next = (execve_fn)dlsym(RTLD_NEXT, "execve");
	struct start s;
	if (payload_start(filename, argv, &s))
		return next(s.loader, s.argv, envp);
	if (!inside_image(filename) && host_environment(envp, &s))
		return next(filename, argv, s.envp);
	return next(filename, argv, envp);
}

int execve(const char *filename, char *const argv[], char *const envp[])
{
	return start_execve(filename, argv, envp);
}

int execv(const char *path, char *const argv[])
{
	return start_execve(path, argv, environ);
}

/* The PATH search of execvp(3): the first executable `file` in PATH. */
static int search_path(const char *file, char *found, size_t size)
{
	const char *path = getenv("PATH");
	if (!path)
		path = "/bin:/usr/bin";
	while (*path) {
		const char *end = strchr(path, ':');
		size_t len = end ? (size_t)(end - path) : strlen(path);
		if (len == 0) {
			if (snprintf(found, size, "%s", file) < (int)size && access(found, X_OK) == 0)
				return 1;
		} else if (snprintf(found, size, "%.*s/%s", (int)len, path, file) < (int)size && access(found, X_OK) == 0) {
			return 1;
		}
		if (!end)
			break;
		path = end + 1;
	}
	return 0;
}

int execvpe(const char *file, char *const argv[], char *const envp[])
{
	char found[PATH_MAX];
	if (strchr(file, '/'))
		return start_execve(file, argv, envp);
	if (search_path(file, found, sizeof found))
		return start_execve(found, argv, envp);
	execve_fn next = (execve_fn)dlsym(RTLD_NEXT, "execvpe");
	return next(file, argv, envp);
}

int execvp(const char *file, char *const argv[])
{
	return execvpe(file, argv, environ);
}

/* Collects the variadic arguments of execl, execlp and execle on the stack. */
#define COLLECT_ARGS(first, args, read_env, envp_out)                                 \
	do {                                                                  \
		va_list ap;                                                   \
		size_t count = 0;                                             \
		va_start(ap, first);                                          \
		args[count++] = (char *)(first);                              \
		char *next_arg;                                               \
		while ((next_arg = va_arg(ap, char *)) != NULL) {             \
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

static int spawn(const char *name, pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
	spawn_fn next = (spawn_fn)dlsym(RTLD_NEXT, name);
	struct start s;
	char found[PATH_MAX];
	const char *program = path;
	if (!strchr(path, '/') && strcmp(name, "posix_spawnp") == 0 && search_path(path, found, sizeof found))
		program = found;
	if (strchr(program, '/') && payload_start(program, argv, &s))
		return next(pid, s.loader, actions, attr, s.argv, envp);
	if (strchr(program, '/') && !inside_image(program) && host_environment(envp, &s))
		return next(pid, path, actions, attr, argv, s.envp);
	return next(pid, path, actions, attr, argv, envp);
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
	return spawn("posix_spawn", pid, path, actions, attr, argv, envp);
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[])
{
	return spawn("posix_spawnp", pid, file, actions, attr, argv, envp);
}
