/*
 * The start decisions shared by image-exec.c (preloaded into the image's
 * processes) and image-exec-trampoline.c (a static program that makes them in
 * a spawned child's own context). See image-exec.c for the rules R1-R6.
 *
 * Every function here can run in a vfork child: nothing calls malloc, stdio
 * or a locale function. An array sized by caller data lives on the stack only
 * up to IMAGE_STACK_BYTES; a larger one is an anonymous mapping (see
 * image_buffer_get). Functions return 0 when a spawn started, an errno value
 * when a start failed, and -1 when a search tried no file and the caller's
 * errno stands.
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
#include <sys/mman.h>
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

/* Stack bytes one caller-sized pointer array may take (128 pointers). */
#define IMAGE_STACK_BYTES 1024

struct image {
	const char *root;         /* absolute mount point; NULL outside an image */
	const char *self;         /* the exec library; NULL when unknown */
	const char *library_path; /* lib/ and the lib.path directories */
};

/* Starts `path`; 0 when a spawn started, otherwise an errno value. */
typedef int (*launch_fn)(const char *path, char *const argv[], char *const envp[], void *context);

enum image_kind { IMAGE_HOST, IMAGE_INSIDE, IMAGE_PAYLOAD_PROGRAM };

/*
 * A caller-sized array: `local` (`local_size` bytes on the caller's stack:
 * IMAGE_STACK_BYTES for pointer arrays and short strings, PATH_MAX for path
 * strings) when
 * `size` fits, otherwise an anonymous mapping that image_buffer_put releases. A mapping made in a vfork child whose exec then succeeds stays in
 * the parent's address space, which vfork shares until the exec: nothing runs
 * in the child after a successful exec to release it. It holds only arrays
 * larger than their stack bound (more than 128 pointers, or a path string
 * longer than PATH_MAX), once per such exec.
 */
struct image_buffer {
	void *data;
	size_t mapped;
};

static inline void *image_buffer_get(struct image_buffer *b, void *local, size_t local_size, size_t size)
{
	b->mapped = 0;
	b->data = local;
	if (size <= local_size)
		return local;
	void *m = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (m == MAP_FAILED)
		return b->data = NULL;
	b->mapped = size;
	return b->data = m;
}

static inline void image_buffer_put(struct image_buffer *b)
{
	if (b->mapped)
		munmap(b->data, b->mapped);
	b->mapped = 0;
}

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

/* Writes `value` in decimal; returns the end of the digits. */
static inline char *image_decimal(char *out, unsigned long value)
{
	char digits[24];
	size_t n = 0;
	do
		digits[n++] = (char)('0' + value % 10);
	while ((value /= 10) != 0);
	while (n)
		*out++ = digits[--n];
	*out = '\0';
	return out;
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

/*
 * open(2) with O_CLOEXEC. When every descriptor below RLIMIT_NOFILE is in use
 * and the hard limit allows one more, the soft limit is raised by one for the
 * open and restored at once: the descriptor stays valid, and the limit any
 * later code and the started program see is the caller's.
 */
static inline int image_open(const char *path, int flags)
{
	int fd = open(path, flags | O_CLOEXEC);
	if (fd >= 0 || errno != EMFILE)
		return fd;
	struct rlimit rl;
	if (getrlimit(RLIMIT_NOFILE, &rl) != 0 || rl.rlim_cur == RLIM_INFINITY ||
	    (rl.rlim_max != RLIM_INFINITY && rl.rlim_cur >= rl.rlim_max))
		return -1;
	struct rlimit raised = { rl.rlim_cur + 1, rl.rlim_max };
	if (setrlimit(RLIMIT_NOFILE, &raised) != 0)
		return -1;
	fd = open(path, flags | O_CLOEXEC);
	int err = errno;
	setrlimit(RLIMIT_NOFILE, &rl);
	errno = err;
	return fd;
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
 * receives the resolved path. A name the kernel would not resolve classifies
 * as a host name, whose start then fails as it would. The name resolves
 * through open(O_PATH) and /proc/self/fd, or through realpath(3) when no
 * descriptor or no /proc is available. A payload file whose header cannot be
 * read for want of a descriptor classifies as inside the image: it starts as
 * the C library would start it, unchanged.
 */
static inline enum image_kind image_classify(const struct image *im, const char *file, char real[PATH_MAX])
{
	if (!im->root || !file || !*file)
		return IMAGE_HOST;
	int resolved = 0;
	int fd = image_open(file, O_PATH);
	if (fd >= 0) {
		char link[32];
		image_decimal(image_copy(link, "/proc/self/fd/"), (unsigned long)fd);
		ssize_t len = readlink(link, real, PATH_MAX - 1);
		close(fd);
		if (len > 0 && len < PATH_MAX - 1) {
			real[len] = '\0';
			resolved = 1;
		}
	} else if (errno != EMFILE && errno != ENFILE) {
		return IMAGE_HOST;
	}
	if (!resolved && !realpath(file, real))
		return IMAGE_HOST;
	if (real[0] != '/' || !image_under(real, im->root, "/"))
		return IMAGE_HOST;
	struct stat st;
	if (!im->self || !*im->self || !im->library_path || !image_under(real, im->root, IMAGE_PAYLOAD) ||
	    stat(real, &st) != 0 || !S_ISREG(st.st_mode))
		return IMAGE_INSIDE;
	int rd = image_open(real, O_RDONLY);
	if (rd < 0)
		return IMAGE_INSIDE;
	enum image_kind kind = image_requests_interpreter(rd) ? IMAGE_PAYLOAD_PROGRAM : IMAGE_INSIDE;
	close(rd);
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
	size_t search_size = 2 * dir_len + sizeof ":/../lib:" + (office ? root_len + sizeof IMAGE_OFFICE_PROGRAM : 0) +
	                     strlen(im->library_path);
	char loader_local[IMAGE_STACK_BYTES], search_local[PATH_MAX];
	_Alignas(16) char args_local[IMAGE_STACK_BYTES];
	struct image_buffer lb, sb, ab;
	char *loader = image_buffer_get(&lb, loader_local, sizeof loader_local, root_len + sizeof IMAGE_LOADER);
	char *search = image_buffer_get(&sb, search_local, sizeof search_local, search_size);
	char **args = image_buffer_get(&ab, args_local, sizeof args_local, (n + 1) * sizeof(char *));
	int err = ENOMEM;
	if (loader && search && args) {
		image_copy(image_copy(loader, im->root), IMAGE_LOADER);
		char *s = search;
		memcpy(s, real, dir_len);
		s = image_copy(s + dir_len, ":");
		memcpy(s, real, dir_len);
		s = image_copy(s + dir_len, "/../lib:");
		if (office)
			s = image_copy(image_copy(s, im->root), IMAGE_OFFICE_PROGRAM);
		image_copy(s, im->library_path);

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
		err = launch(loader, args, envp, context);
	}
	image_buffer_put(&ab);
	image_buffer_put(&sb);
	image_buffer_put(&lb);
	return err;
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
	_Alignas(16) char env_local[IMAGE_STACK_BYTES];
	char lists_local[PATH_MAX];
	struct image_buffer eb, lb;
	char **env = image_buffer_get(&eb, env_local, sizeof env_local, (kept + 1) * sizeof(char *));
	char *lists = image_buffer_get(&lb, lists_local, sizeof lists_local, list_bytes + 1);
	int err = ENOMEM;
	if (env && lists) {
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
		err = launch(file, argv, env, context);
	}
	image_buffer_put(&lb);
	image_buffer_put(&eb);
	return err;
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
	size_t n = argc > 1 ? argc + 2 : 3;
	if (image_pointers_refused(n - 1 + image_count(envp), image_argument_limit()))
		return E2BIG;
	_Alignas(16) char args_local[IMAGE_STACK_BYTES];
	struct image_buffer ab;
	char **args = image_buffer_get(&ab, args_local, sizeof args_local, n * sizeof(char *));
	if (!args)
		return ENOMEM;
	args[0] = IMAGE_SHELL;
	args[1] = (char *)file;
	if (argc > 1)
		memcpy(args + 2, argv + 1, argc * sizeof(char *));
	else
		args[2] = NULL;
	int err = image_start(im, IMAGE_SHELL, args, envp, launch, context);
	image_buffer_put(&ab);
	return err;
}

/* Called with each PATH candidate; nonzero ends the walk with that value. */
typedef int (*image_visit_fn)(const char *candidate, void *context);

/*
 * The candidates glibc's __execvpe_common builds for the bare name `file`
 * from `path`, in order: a NULL path is /bin:/usr/bin; an empty entry
 * (leading, trailing, a doubled colon, or an empty PATH) is the current
 * directory; an entry of path_len bytes or more, path_len being the length of
 * PATH capped at PATH_MAX - 1 plus one, is skipped by moving to its colon,
 * which glibc then reads as an empty entry, so the current directory follows
 * it. `file` is at most NAME_MAX bytes. Returns the first nonzero `visit`
 * value, or 0 after the last entry.
 */
static inline int image_path_walk(const char *file, const char *path, image_visit_fn visit, void *context)
{
	if (!path)
		path = IMAGE_DEFAULT_PATH;
	size_t file_len = strnlen(file, NAME_MAX) + 1;
	size_t path_len = strnlen(path, PATH_MAX - 1) + 1;
	char buffer[PATH_MAX + NAME_MAX + 2];
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
		int result = visit(buffer, context);
		if (result)
			return result;
		if (*subp++ == '\0')
			return 0;
	}
}

struct image_search_state {
	const struct image *im;
	char *const *argv;
	char *const *envp;
	int script;
	launch_fn launch;
	void *context;
	int got_eacces;
	int last;
};

static inline int image_search_visit(const char *candidate, void *context)
{
	struct image_search_state *s = context;
	s->last = image_start(s->im, candidate, s->argv, s->envp, s->launch, s->context);
	if (s->last == ENOEXEC && s->script)
		s->last = image_script(s->im, candidate, s->argv, s->envp, s->launch, s->context);
	switch (s->last) {
	case EACCES:
		s->got_eacces = 1;
		return 0;
	case ENOENT:
	case ESTALE:
	case ENOTDIR:
	case ENODEV:
	case ETIMEDOUT:
		return 0;
	default:
		return 1;
	}
}

/*
 * glibc's __execvpe_common: a name with a slash starts as it is; a bare name
 * longer than NAME_MAX fails with ENAMETOOLONG; any other bare name is tried
 * at every candidate image_path_walk builds. ENOEXEC runs the file through
 * /bin/sh when `script` is set; EACCES, ENOENT, ESTALE, ENOTDIR, ENODEV and
 * ETIMEDOUT go on to the next candidate; EACCES is reported when one was
 * seen; any other result stops the search.
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
	if (strnlen(file, NAME_MAX + 1) > NAME_MAX)
		return ENAMETOOLONG;
	struct image_search_state s = { im, argv, envp, script, launch, context, 0, -1 };
	if (image_path_walk(file, path, image_search_visit, &s))
		return s.last;
	return s.got_eacces ? EACCES : s.last;
}

#endif
