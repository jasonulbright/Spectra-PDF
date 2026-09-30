"""The engine's process contract: every spawn goes through one helper; on
Linux the folder-lease channel is kept close-on-exec and withheld from
children, and every child is armed with PR_SET_PDEATHSIG(SIGKILL)."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parent.parent / "src"

linux_only = pytest.mark.skipif(
    not sys.platform.startswith("linux"), reason="Linux process contract"
)


def _engine_process(script: str, env: dict | None = None, **kwargs) -> subprocess.CompletedProcess:
    merged = dict(os.environ)
    merged["PYTHONPATH"] = str(SRC)
    merged.update(env or {})
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        env=merged,
        capture_output=True,
        text=True,
        timeout=60,
        **kwargs,
    )


def test_every_engine_spawn_goes_through_the_helper():
    calls = ("subprocess.run(", "subprocess.Popen(", "subprocess.call(",
             "subprocess.check_output(", "subprocess.check_call(",
             "os.system(", "os.popen(", "os.posix_spawn", "os.spawn", "os.exec")
    offenders = []
    for path in sorted((SRC / "engine").rglob("*.py")):
        if path.name == "platform_support.py":
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("#", 1)[0]
            offenders += [f"{path.name}:{number}" for call in calls if call in code]
    assert offenders == []


@linux_only
def test_the_lease_channel_is_kept_cloexec_and_withheld_from_children(tmp_path):
    lock = tmp_path / "lease.lock"
    lock.write_bytes(b"")
    host, worker = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    with open(lock, "rb") as held:
        socket.send_fds(host, [b"\0"], [held.fileno()])
    fd = worker.fileno()
    probe = _engine_process(
        f"""
        import fcntl, os, sys
        from engine import platform_support
        assert platform_support.adopt_lease_channel() == {fd}
        assert platform_support.lease_channel() == {fd}
        assert "SPECTRAPDF_LEASE_FD" not in os.environ
        assert fcntl.fcntl({fd}, fcntl.F_GETFD) & fcntl.FD_CLOEXEC
        child = platform_support.run(
            [sys.executable, "-c",
             "import os; print(os.path.exists('/proc/self/fd/{fd}'), 'SPECTRAPDF_LEASE_FD' in os.environ)"],
            capture_output=True, text=True, close_fds=False,
        )
        assert child.stdout.split() == ["False", "False"], child.stdout
        os.fstat({fd})
        print("ok")
        """,
        env={"SPECTRAPDF_LEASE_FD": str(fd)},
        pass_fds=(fd,),
    )
    worker.close()
    host.close()
    assert probe.returncode == 0, probe.stderr
    assert probe.stdout.strip() == "ok"


@linux_only
def test_a_process_without_the_channel_adopts_nothing():
    probe = _engine_process(
        """
        import os
        os.environ.pop("SPECTRAPDF_LEASE_FD", None)
        from engine import platform_support
        assert platform_support.adopt_lease_channel() is None
        print("ok")
        """
    )
    assert probe.returncode == 0, probe.stderr


@linux_only
def test_every_engine_child_is_armed_with_pdeathsig():
    import signal

    from engine import platform_support

    reader = platform_support.run(
        [
            sys.executable,
            "-c",
            "import ctypes; s = ctypes.c_int(); "
            "ctypes.CDLL(None).prctl(2, ctypes.byref(s), 0, 0, 0); print(s.value)",
        ],
        capture_output=True,
        text=True,
    )
    assert reader.returncode == 0, reader.stderr
    assert int(reader.stdout) == signal.SIGKILL


@linux_only
def test_a_child_dies_with_the_engine(tmp_path):
    pid_file = tmp_path / "child.pid"
    engine = _engine_process(
        f"""
        import os
        from engine import platform_support
        child = platform_support.popen(["sleep", "60"])
        open({str(pid_file)!r}, "w").write(str(child.pid))
        os._exit(0)
        """
    )
    assert engine.returncode == 0, engine.stderr
    pid = int(pid_file.read_text())
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            state = Path(f"/proc/{pid}/stat").read_text().split()[2]
        except FileNotFoundError:
            return
        if state == "Z":
            return
        time.sleep(0.05)
    os.kill(pid, 9)
    pytest.fail("the engine's child outlived it")
