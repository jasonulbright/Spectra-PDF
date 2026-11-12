"""A raw TCP listener on 127.0.0.1 (port 9100 style) that stores each job.

A Standard TCP/IP port sends the driver's job bytes to a host and a port. This
listener keeps the bytes of each connection as `job-0001.bin` in a folder. A job
ends when the sender closes the connection, or when no byte has arrived for
`--idle` seconds. Nothing is sent back. Python standard library only.

    python scripts/printer-lab/tcp_capture.py --dir <folder> --port 9100
"""

from __future__ import annotations

import argparse
import os
import socket
import threading
import time
from pathlib import Path


MAX_BYTES = 64 * 1024 * 1024  # one job; more ends the job
DEADLINE_S = 120.0  # one connection, from accept to the end of the job


class TcpCapture:
    def __init__(
        self, directory: Path, host: str = "127.0.0.1", port: int = 0, idle: float = 5.0,
        max_bytes: int = MAX_BYTES, deadline: float = DEADLINE_S,
    ) -> None:
        if host != "127.0.0.1":
            raise ValueError("the capture listener binds 127.0.0.1 only")
        self.max_bytes, self.deadline = max_bytes, deadline
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.idle = idle
        self.lock = threading.Lock()
        self.next_job = 1
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if os.name != "nt":  # on Windows SO_REUSEADDR lets a second process bind the same port
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((host, port))
        self.sock.listen(8)
        self.closed = False
        self.thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        return self.sock.getsockname()[1]

    def start(self) -> "TcpCapture":
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()
        return self

    def stop(self) -> None:
        self.closed = True
        self.sock.close()

    def serve_forever(self) -> None:
        while not self.closed:
            try:
                connection, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._receive, args=(connection,), daemon=True).start()

    def _receive(self, connection: socket.socket) -> None:
        data = bytearray()
        started = time.monotonic()
        cut = ""
        try:
            while True:
                left = self.deadline - (time.monotonic() - started)
                if left <= 0:
                    cut = "deadline"
                    break
                connection.settimeout(min(self.idle, left))
                chunk = connection.recv(65536)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) >= self.max_bytes:
                    del data[self.max_bytes:]
                    cut = "byte cap"
                    break
        except (socket.timeout, OSError):
            if time.monotonic() - started >= self.deadline:
                cut = "deadline"
        finally:
            connection.close()
        if not data:
            return
        with self.lock:
            job_id = self.next_job
            self.next_job += 1
        temp = self.directory / f"job-{job_id:04d}.bin.part"
        temp.write_bytes(bytes(data))
        if cut:
            (self.directory / f"job-{job_id:04d}.cut").write_text(f"the job was cut at the {cut}")
        os.replace(temp, self.directory / f"job-{job_id:04d}.bin")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=9100)
    parser.add_argument("--idle", type=float, default=5.0)
    args = parser.parse_args(argv)
    capture = TcpCapture(args.dir, "127.0.0.1", args.port, args.idle)
    print(f"TCP capture listening on 127.0.0.1:{capture.port}", flush=True)
    try:
        capture.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
