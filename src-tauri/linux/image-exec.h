/*
 * The start decisions shared by image-exec.c (preloaded into the image's
 * processes) and image-exec-trampoline.c (a static program that makes them in
 * a spawned child's own context). See image-exec.c for the rules R1-R4.
 *
 * Every function here can run in a vfork child: arrays are variable-length
 * arrays on the caller's stack sized from the counted input, file names are
 * resolved with open(O_PATH) and readlink of /proc/self/fd, and nothing calls
 * malloc, stdio or a locale function. Functions return 0 when a spawn
 * started, an errno value when a start failed, and -1 when a search tried no
 * file and the caller's errno stands.
 */
#ifndef SPECTRAPDF_IMAGE_EXEC_H
#define SPECTRAPDF_IMAGE_EXEC_H

#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

#define IMAGE_SHELL "/bin/sh"
#define IMAGE_DEFAULT_PATH "/bin:/usr/bin"
#define IMAGE_LOADER "/lib/ld-linux-x86-64.so.2"
#define IMAGE_PAYLOAD "/lib/spectrapdf/"
#define IMAGE_OFFICE "/lib/spectrapdf/libreoffice/"
#define IMAGE_OFFICE_PROGRAM "/lib/spectrapdf/libreoffice/program:"
#define IMAGE_TRAMPOLINE "/lib/image-exec/image-exec-trampoline"

struct image {
	const char *root;         /* absolute mount point; NULL outside an image */
	const char *self;         /* the exec library; NULL when unknown */
	const char *library_path; /* lib/ and the lib.path directories */
};

/* Starts `path`; 0 when a spawn started, otherwise an errno value. */
typedef int (*launch_fn)(const char *path, char *const argv[], char *const envp[], void *context);

enum image_kind { IMAGE_HOST, IMAGE_INSIDE, IMAGE_PAYLOAD_PROGRAM };

static inline size_t image_count(char *const v[])
{
	size_t n = 0;
	while (v && v[n])
		n++;
	return n;
}

static inline int image_starts_with(const char *text, const char *prefix)
{
	return strncmp(text, prefix, strlen(prefix)) == 0;
}

/* `text` begins with `root` followed by `rest`. */
static inline int image_under(const char *text, const char *root, const char *rest)
{
	size_t len = strlen(root);
	return strncmp(text, root, len) == 0 && image_starts_with(text + len, rest);
}

static inline char *image_copy(char *out, const char *text)
{
	size_t len = strlen(text);
	memcpy(out, text, len);
	out[len] = '\0';
	return out + len;
}

/*
 * The kernel's limit on argument and environment bytes, pointers included:
 * three quarters of its 8 MiB stack reserve or a quarter of RLIMIT_STACK,
 * whichever is smaller, and never below 128 KiB. A start whose pointer arrays
 * reach it is one the kernel refuses with E2BIG.
 */
static inline size_t image_argument_limit(void)
{
	struct rlimit rl;
	size_t limit = (size_t)6 << 20;
	if (getrlimit(RLIMIT_STACK, &rl) == 0 && rl.rlim_cur != RLIM_INFINITY && rl.rlim_cur / 4 < limit)
		limit = (size_t)(rl.rlim_cur / 4);
	return limit < ((size_t)128 << 10) ? (size_t)128 << 10 : limit;
}

/* Whether `pointers` argument and environment pointers reach the kernel's limit. */
static inline int image_pointers_refused(size_t pointers, size_t limit)
{
	return pointers >= (limit + sizeof(char *) - 1) / sizeof(char *);
}

static inline int image_requests_interpreter(int fd)
{
	Elf64_Ehdr eh;
	if (pread(fd, &eh, sizeof eh, 0) != (ssize_t)sizeof eh || memcmp(eh.e_ident, ELFMAG, SELFMAG) != 0 ||
	    eh.e_ident[EI_CLASS] != ELFCLASS64 || eh.e_phentsize != sizeof(Elf64_Phdr))
		return 0;
	for (int i = 0; i < eh.e_phnum; i++) {
		Elf64_Phdr ph;
		if (pread(fd, &ph, sizeof ph, (off_t)(eh.e_phoff + (Elf64_Off)i * sizeof ph)) != (ssize_t)sizeof ph)
			return 0;
		if (ph.p_type == PT_INTERP)
			return 1;
	}
	return 0;
}

/*
 * What `file` names in the current context: a dynamic ELF program under
 * lib/spectrapdf, another file inside the image, or anything else. `real`
 * receives the resolved path of a payload program. A name the kernel would
 * not resolve classifies as a host name, whose start then fails as it would.
 */
static inline enum image_kind image_classify(const struct image *im, const char *file, char real[PATH_MAX])
{
	if (!im->root || !file || !*file)
		return IMAGE_HOST;
	int fd = open(file, O_PATH | O_CLOEXEC);
	if (fd < 0)
		return IMAGE_HOST;
	char link[32] = "/proc/self/fd/";
	char digits[16];
	size_t nd = 0;
	for (unsigned v = (unsigned)fd; nd == 0 || v; v /= 10)
		digits[nd++] = (char)('0' + v % 10);
	size_t at = strlen(link);
	while (nd)
		link[at++] = digits[--nd];
	link[at] = '\0';
	ssize_t len = readlink(link, real, PATH_MAX - 1);
	if (len > 0)
		real[len] = '\0';
	else if (!realpath(file, real))
		real[0] = '\0';
	enum image_kind kind = IMAGE_HOST;
	struct stat st;
	if (real[0] == '/' && image_under(real, im->root, "/")) {
		kind = IMAGE_INSIDE;
		if (im->self && *im->self && im->library_path && image_under(real, im->root, IMAGE_PAYLOAD) &&
		    fstat(fd, &st) == 0 && S_ISREG(st.st_mode)) {
			int rd = open(link, O_RDONLY | O_CLOEXEC);
			if (rd >= 0) {
				if (image_requests_interpreter(rd))
					kind = IMAGE_PAYLOAD_PROGRAM;
				close(rd);
			}
		}
	}
	close(fd);
	return kind;
}

/*
 * Starts the payload program `real` on the image's loader with argv[0] kept,
 * the exec library preloaded and the payload's and the image's libraries on
 * the search path. The environment is passed on as it is.
 */
static inline int image_launch_payload(const struct image *im, const char *real, char *const argv[], char *const envp[],
                                       launch_fn launch, void *context)
{
	size_t argc = image_count(argv);
	size_t n = argc > 0 ? argc + 7 : 6;
	if (image_pointers_refused(n + image_count(envp), image_argument_limit()))
		return E2BIG;
	size_t root_len = strlen(im->root);
	size_t dir_len = (size_t)(strrchr(real, '/') - real);
	int office = image_under(real, im->root, IMAGE_OFFICE);
	char loader[root_len + sizeof IMAGE_LOADER];
	char search[2 * dir_len + sizeof ":/../lib:" + (office ? root_len + sizeof IMAGE_OFFICE_PROGRAM : 0) +
	            strlen(im->library_path)];
	image_copy(image_copy(loader, im->root), IMAGE_LOADER);
	char *s = search;
	memcpy(s, real, dir_len);
	s = image_copy(s + dir_len, ":");
	memcpy(s, real, dir_len);
	s = image_copy(s + dir_len, "/../lib:");
	if (office)
		s = image_copy(image_copy(s, im->root), IMAGE_OFFICE_PROGRAM);
	image_copy(s, im->library_path);

	char *args[n + 1];
	size_t i = 0;
	args[i++] = loader;
	args[i++] = "--preload";
	args[i++] = (char *)im->self;
	args[i++] = "--library-path";
	args[i++] = search;
	if (argc > 0) {
		args[i++] = "--argv0";
		args[i++] = argv[0];
	}
	args[i++] = (char *)real;
	for (size_t k = 1; k < argc; k++)
		args[i++] = argv[k];
	args[i] = NULL;
	return launch(loader, args, envp, context);
}

/*
 * Length of `entry` (NAME=a:b:c, its value naming the image) with every list
 * element that names the image removed; 0 when no element is left. Writes the
 * result to `out` when `out` is not NULL.
 */
static inline size_t image_list_without(const char *entry, const char *root, char *out)
{
	const char *eq = strchr(entry, '=');
	size_t used = (size_t)(eq - entry) + 1;
	int kept = 0;
	if (out)
		memcpy(out, entry, used);
	for (const char *part = eq + 1;;) {
		const char *end = strchrnul(part, ':');
		const char *hit = strstr(part, root);
		if (!hit || hit >= end) {
			size_t len = (size_t)(end - part);
			if (kept && out)
				out[used] = ':';
			used += kept;
			if (out)
				memcpy(out + used, part, len);
			used += len;
			kept = 1;
		}
		if (!*end)
			break;
		part = end + 1;
	}
	if (!kept)
		return 0;
	if (out)
		out[used] = '\0';
	return used;
}

/* 0: kept as it is; 1: removed; 2: rewritten without its image elements. */
static inline int image_env_action(const char *entry, const char *root)
{
	if (image_starts_with(entry, "LD_"))
		return 1;
	const char *eq = strchr(entry, '=');
	if (!eq || !strstr(eq + 1, root))
		return 0;
	if (!strchr(eq + 1, ':'))
		return 1;
	return image_list_without(entry, root, NULL) ? 2 : 1;
}

/*
 * Starts the host program `file` without the variables that name the image:
 * the caller's own argv and envp when nothing is removed, a filtered copy of
 * envp otherwise. A filtered copy the kernel would refuse is not built; the
 * original start goes to the kernel, which refuses it with the same errno.
 */
static inline int image_launch_host(const struct image *im, const char *file, char *const argv[], char *const envp[],
                                    launch_fn launch, void *context)
{
	if (!im->root || !envp)
		return launch(file, argv, envp, context);
	size_t kept = 0, list_bytes = 0;
	int changed = 0;
	for (size_t i = 0; envp[i]; i++) {
		int action = image_env_action(envp[i], im->root);
		changed |= action != 0;
		if (action == 0)
			kept++;
		else if (action == 2) {
			kept++;
			list_bytes += image_list_without(envp[i], im->root, NULL) + 1;
		}
	}
	if (!changed)
		return launch(file, argv, envp, context);
	size_t argc = image_count(argv);
	size_t pointers = (argc > 0 ? argc : 1) + kept;
	size_t limit = image_argument_limit();
	if (image_pointers_refused(pointers, limit) || pointers * sizeof(char *) + list_bytes > limit)
		return launch(file, argv, envp, context);
	char *env[kept + 1];
	char lists[list_bytes + 1];
	size_t n = 0, used = 0;
	for (size_t i = 0; envp[i]; i++) {
		int action = image_env_action(envp[i], im->root);
		if (action == 0) {
			env[n++] = envp[i];
		} else if (action == 2) {
			env[n++] = lists + used;
			used += image_list_without(envp[i], im->root, lists + used) + 1;
		}
	}
	env[n] = NULL;
	return launch(file, argv, env, context);
}

/* execve(2) semantics for `file`, with the payload move and the host environment. */
static inline int image_start(const struct image *im, const char *file, char *const argv[], char *const envp[],
                              launch_fn launch, void *context)
{
	char real[PATH_MAX];
	switch (image_classify(im, file, real)) {
	case IMAGE_PAYLOAD_PROGRAM:
		return image_launch_payload(im, real, argv, envp, launch, context);
	case IMAGE_INSIDE:
		return launch(file, argv, envp, context);
	default:
		return image_launch_host(im, file, argv, envp, launch, context);
	}
}

/* glibc's maybe_script_execute: `file` as a /bin/sh script, argv[0] dropped. */
static inline int image_script(const struct image *im, const char *file, char *const argv[], char *const envp[],
                               launch_fn launch, void *context)
{
	size_t argc = image_count(argv);
	if (argc >= INT_MAX - 1)
		return E2BIG;
	if (image_pointers_refused((argc > 1 ? argc + 1 : 2) + image_count(envp), image_argument_limit()))
		return E2BIG;
	char *args[argc > 1 ? argc + 2 : 3];
	args[0] = IMAGE_SHELL;
	args[1] = (char *)file;
	if (argc > 1)
		memcpy(args + 2, argv + 1, argc * sizeof(char *));
	else
		args[2] = NULL;
	return image_start(im, IMAGE_SHELL, args, envp, launch, context);
}

/*
 * glibc's __execvpe_common: a name with a slash starts as it is; a bare name
 * is tried in every PATH entry (a missing PATH is /bin:/usr/bin, an empty
 * entry the current directory, an entry of PATH_MAX bytes or more skipped).
 * ENOEXEC runs the file through /bin/sh when `script` is set; EACCES, ENOENT,
 * ESTALE, ENOTDIR, ENODEV and ETIMEDOUT go on to the next entry; EACCES is
 * reported when one was seen; any other error stops the search. A bare name
 * longer than NAME_MAX fails with ENAMETOOLONG, the error the kernel gives
 * for the first candidate glibc builds from it.
 */
static inline int image_search(const struct image *im, const char *file, char *const argv[], char *const envp[],
                               const char *path, int script, launch_fn launch, void *context)
{
	if (*file == '\0')
		return ENOENT;
	if (strchr(file, '/')) {
		int err = image_start(im, file, argv, envp, launch, context);
		if (err == ENOEXEC && script)
			err = image_script(im, file, argv, envp, launch, context);
		return err;
	}
	if (!path)
		path = IMAGE_DEFAULT_PATH;
	size_t file_len = strnlen(file, NAME_MAX + 1) + 1;
	size_t path_len = strnlen(path, PATH_MAX - 1) + 1;
	if (file_len - 1 > NAME_MAX)
		return ENAMETOOLONG;
	char buffer[path_len + file_len + 1];
	int got_eacces = 0, last = -1;
	const char *subp;
	for (const char *p = path;; p = subp) {
		subp = strchrnul(p, ':');
		if ((size_t)(subp - p) >= path_len) {
			if (*subp == '\0')
				break;
			continue;
		}
		char *pend = mempcpy(buffer, p, (size_t)(subp - p));
		*pend = '/';
		memcpy(pend + (p < subp), file, file_len);
		last = image_start(im, buffer, argv, envp, launch, context);
		if (last == ENOEXEC && script)
			last = image_script(im, buffer, argv, envp, launch, context);
		switch (last) {
		case EACCES:
			got_eacces = 1;
			/* fall through */
		case ENOENT:
		case ESTALE:
		case ENOTDIR:
		case ENODEV:
		case ETIMEDOUT:
			break;
		default:
			return last;
		}
		if (*subp++ == '\0')
			break;
	}
	return got_eacces ? EACCES : last;
}

#endif
