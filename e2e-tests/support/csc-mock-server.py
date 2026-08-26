"""Run `tests/csc_mock.py` as a standalone process, for the e2e battery.

The pytest suite drives that mock in-process. The e2e battery cannot: the
client under test is the SHIPPED engine, running inside the built application's
own Python, in a different process from the test runner. So the same mock is
hosted here instead of being reimplemented — a second copy of a provider would
drift from the one the unit tests pin, and the two suites would then be
asserting against different servers while claiming to assert against one.

Protocol, over stdio, one JSON object per line:

  * argv[1] is the configuration (credentials + behaviour switches).
  * On start, one line is written: ``{"base_url": ..., "ca_path": ...}``.
  * ``state`` on stdin answers with what the mock has been asked to do —
    the token forms it received, and the hashes it authorized and signed.
  * ``stop`` (or EOF) shuts the server down.

The CA is generated per run and written under a temporary directory; the
address is a loopback port chosen by the OS. Nothing here reaches the network
and nothing survives the process.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

# tests/ is not a package, so the mock is loaded by path rather than imported.
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "csc_mock", ROOT / "tests" / "csc_mock.py"
)
assert _spec and _spec.loader
csc_mock = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(csc_mock)


def main() -> int:
    config = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    credentials = [
        csc_mock.MockCredential(row.pop("credential_id"), **row)
        for row in config.pop("credentials", [{"credential_id": "cred-1"}])
    ]
    tmp = Path(tempfile.mkdtemp(prefix="spectra-e2e-csc-"))
    server = csc_mock.MockCsc(tmp, credentials=credentials, **config)

    sys.stdout.write(
        json.dumps({"base_url": server.base_url, "ca_path": server.ca_path}) + "\n"
    )
    sys.stdout.flush()

    try:
        for line in sys.stdin:
            command = line.strip()
            if command == "stop":
                break
            if command == "state":
                sys.stdout.write(
                    json.dumps(
                        {
                            "token_forms": server.token_forms,
                            "authorized_hashes": server.authorized_hashes,
                            "signed_hashes": server.signed_hashes,
                        }
                    )
                    + "\n"
                )
                sys.stdout.flush()
    finally:
        server.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
