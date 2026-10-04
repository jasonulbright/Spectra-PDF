/*
 * Started by image-exec.so through the C library's posix_spawn with the
 * caller's file actions and attributes, so it runs in the child's context:
 * the directory, descriptors, signal mask, process group and ids the caller
 * asked for. It makes the payload, image and host decision of image-exec.h
 * for the caller's program there and execs it with the caller's argv and
 * environment (its own environment is the caller's envp). It opens no
 * descriptor of its own beyond the transient ones image_classify needs.
 *
 *   image-exec-trampoline SEGMENT MODE PATH ROOT EXEC LIBRARY_PATH FILE ARGV...
 *
 * SEGMENT identifies the parent's private System V shared-memory segment.
 * MODE is spawn or spawnp; PATH and LIBRARY_PATH are prefixed with P, or U
 * when unset. The trampoline attaches, publishes -1, and publishes errno if
 * exec fails. A successful exec automatically detaches the segment. Failure
 * to attach exits with that errno before publishing any state. This program
 * is static, so LD_ variables and the host C library cannot affect startup.
 */
#define _GNU_SOURCE
#include <sys/shm.h>

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
	if (argc < 8)
		return EINVAL;
	char *end;
	long segment = strtol(argv[1], &end, 10);
	if (!*argv[1] || *end || segment < 0 || segment > INT_MAX)
		return EINVAL;
	int *state = shmat((int)segment, NULL, 0);
	if (state == (void *)-1)
		_exit(errno);
	__atomic_store_n(state, -1, __ATOMIC_RELEASE);
	int use_path = strcmp(argv[2], "spawnp") == 0;
	struct image im = { argv[4][0] == '/' ? argv[4] : NULL, argv[5], optional(argv[6]) };
	const char *file = argv[7];
	char **args = argv + 8;
	int err = use_path ? image_search(&im, file, args, environ, optional(argv[3]), 0, launch_execve, NULL)
	                   : image_start(&im, file, args, environ, launch_execve, NULL);
	__atomic_store_n(state, err > 0 ? err : errno, __ATOMIC_RELEASE);
	_exit(127);
}
