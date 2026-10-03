/*
 * Started by image-exec.so through the C library's posix_spawn with the
 * caller's file actions and attributes, so it runs in the child's context:
 * the directory, descriptors, signal mask, process group and ids the caller
 * asked for. It makes the payload, image and host decision of image-exec.h
 * for the caller's program there and execs it with the caller's argv and
 * environment (its own environment is the caller's envp).
 *
 *   image-exec-trampoline SOCKET MODE PATH ROOT EXEC LIBRARY_PATH FILE ARGV...
 *
 * SOCKET is the abstract socket name the spawning process listens on; MODE is
 * spawn (FILE as posix_spawn names it) or spawnp (FILE searched in PATH as
 * posix_spawnp does, without the shell fallback); PATH and LIBRARY_PATH are
 * the spawning process's values prefixed with P, or U when unset. A failed
 * exec sends its errno on the socket and exits 127; the spawning process
 * then reaps this process and returns the errno from posix_spawn. A
 * successful exec closes the socket. The program is linked statically, so no
 * LD_ variable and no host C library takes part in starting it.
 */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/un.h>

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

static int connect_report(const char *name)
{
	struct sockaddr_un address;
	size_t len = strlen(name);
	if (len == 0 || len + 1 > sizeof address.sun_path)
		return -1;
	memset(&address, 0, sizeof address);
	address.sun_family = AF_UNIX;
	memcpy(address.sun_path + 1, name, len);
	int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	if (fd < 0)
		return -1;
	socklen_t length = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + len);
	while (connect(fd, (struct sockaddr *)&address, length) != 0) {
		if (errno != EINTR) {
			close(fd);
			return -1;
		}
	}
	return fd;
}

int main(int argc, char **argv)
{
	if (argc < 8)
		return 127;
	int report = connect_report(argv[1]);
	if (report < 0)
		_exit(127);
	int use_path = strcmp(argv[2], "spawnp") == 0;
	struct image im = { argv[4][0] == '/' ? argv[4] : NULL, argv[5], optional(argv[6]) };
	const char *file = argv[7];
	char **args = argv + 8;
	int err = use_path ? image_search(&im, file, args, environ, optional(argv[3]), 0, launch_execve, NULL)
	                   : image_start(&im, file, args, environ, launch_execve, NULL);
	if (err > 0)
		while (send(report, &err, sizeof err, MSG_NOSIGNAL) < 0 && errno == EINTR)
			;
	_exit(127);
}
