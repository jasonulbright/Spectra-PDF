/*
 * Started by image-exec.so through the C library's posix_spawn with the
 * caller's file actions and attributes, so it runs in the child's context:
 * the directory, descriptors, signal mask, process group and ids the caller
 * asked for. It makes the payload, image and host decision of image-exec.h
 * for the caller's program there and execs it with the caller's argv and
 * environment (its own environment is the caller's envp). It opens no
 * descriptor of its own beyond the transient ones image_classify needs, and
 * starts the program without them when none is available.
 *
 *   image-exec-trampoline NONCE MODE PATH ROOT EXEC LIBRARY_PATH FILE ARGV...
 *
 * NONCE is eight hexadecimal digits from the spawning process; MODE is spawn
 * (FILE as posix_spawn names it) or spawnp (FILE searched in PATH as
 * posix_spawnp does, without the shell fallback); PATH and LIBRARY_PATH are
 * the spawning process's values prefixed with P, or U when unset. A failed
 * exec sets this process's name to NONCE, "e" and the errno in decimal, then
 * exits 127; the spawning process reads the name from /proc/<pid>/stat. The
 * program is linked statically, so no LD_ variable and no host C library
 * takes part in starting it.
 */
#define _GNU_SOURCE
#include <sys/prctl.h>

#include "image-exec.h"

extern char **environ;

static int launch_execve(const char *path, char *const argv[], char *const envp[], void *context)
{
	(void)context;
	execve(path, argv, envp);
	return errno;
}

static const char *optional(const char *arg)
{
	return arg[0] == 'P' ? arg + 1 : NULL;
}

int main(int argc, char **argv)
{
	if (argc < 8 || strlen(argv[1]) != 8)
		return 127;
	int use_path = strcmp(argv[2], "spawnp") == 0;
	struct image im = { argv[4][0] == '/' ? argv[4] : NULL, argv[5], optional(argv[6]) };
	const char *file = argv[7];
	char **args = argv + 8;
	int err = use_path ? image_search(&im, file, args, environ, optional(argv[3]), 0, launch_execve, NULL)
	                   : image_start(&im, file, args, environ, launch_execve, NULL);
	if (err > 0) {
		char name[16];
		memcpy(name, argv[1], 8);
		name[8] = 'e';
		image_decimal(name + 9, (unsigned long)err);
		prctl(PR_SET_NAME, name, 0, 0, 0);
	}
	_exit(127);
}
