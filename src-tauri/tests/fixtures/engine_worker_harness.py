"""The real engine with two extra methods, for tests/engine_workers.rs.

argv[1] is the directory that holds the `engine` package. `test_sleep` runs
for the requested seconds unless cancelled; `test_pid` answers the process
id. Nothing in the shipped engine registers either method."""

import os
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])

from engine import ipc  # noqa: E402

_run = ipc.JsonRpcServer.run


def _sleep(seconds: float) -> dict:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ipc.raise_if_cancelled()
        time.sleep(0.02)
    return {"slept": seconds}


def _run_with_test_methods(self, *args, **kwargs):
    self.register("test_sleep", _sleep)
    self.register("test_pid", os.getpid)
    return _run(self, *args, **kwargs)


ipc.JsonRpcServer.run = _run_with_test_methods

from engine.__main__ import main  # noqa: E402

main()
