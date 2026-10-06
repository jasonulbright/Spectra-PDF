"""The real engine with extra methods, for tests/engine_workers.rs.

argv[1] is the directory that holds the `engine` package; arguments after it
(the process role and window) are ignored. `test_sleep` runs for the
requested seconds unless cancelled; `test_pid` answers the process id;
`test_identity` writes a self-signed certificate and its PKCS#12 bundle
(password "test-pass") into a folder. Nothing in the shipped engine
registers any of them.

`distill` (a job method) and `create_pdf_folders` (a run method) are
replaced by one gated handler: it waits until the file named by `gate`
exists, or returns early when its request is cancelled, and answers its
process id, whether it was cancelled, the log of every request this
process served before it as `[method, succeeded]` pairs, and the methods of
every line its input reader has received so far. A gate file whose content
names a method also waits until a line of that method has been received.
`linger` starts a thread that never ends, so the process does not exit
when its input closes. The harness registers last, so these replace the
shipped handlers."""

import os
import sys
import threading
import time

sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])

from engine import ipc  # noqa: E402

_run = ipc.JsonRpcServer.run
_handle = ipc.JsonRpcServer._handle
_offer = ipc._Inbox.offer
_served: list = []
_received: list = []


def _sleep(seconds: float) -> dict:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ipc.raise_if_cancelled()
        time.sleep(0.02)
    return {"slept": seconds}


def _gate_open(gate: str) -> bool:
    try:
        with open(gate, encoding="utf-8") as f:
            awaited = f.read().strip()
    except OSError:
        return False
    return not awaited or awaited in _received


def _gated(gate: str, linger: bool = False, **_ignored) -> dict:
    while True:
        if ipc.cancelled():
            cancelled = True
            break
        if _gate_open(gate):
            cancelled = False
            break
        time.sleep(0.02)
    if linger:
        threading.Thread(target=lambda: time.sleep(10**9), daemon=False).start()
    return {
        "pid": os.getpid(),
        "cancelled": cancelled,
        "log": list(_served),
        "received": list(_received),
    }


def _identity(folder: str) -> dict:
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "recipient")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=36500))
        .add_extension(
            x509.KeyUsage(
                digital_signature=False, content_commitment=False,
                key_encipherment=True, data_encipherment=True,
                key_agreement=False, key_cert_sign=False, crl_sign=False,
                encipher_only=False, decipher_only=False,
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path = os.path.join(folder, "recipient.cer")
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.DER))
    pfx_path = os.path.join(folder, "recipient.pfx")
    with open(pfx_path, "wb") as f:
        f.write(pkcs12.serialize_key_and_certificates(
            b"recipient", key, cert, None, serialization.BestAvailableEncryption(b"test-pass")))
    return {"cert": cert_path, "pfx": pfx_path}


def _logged_handle(self, request):
    response = _handle(self, request)
    method = request.get("method") if isinstance(request, dict) else None
    _served.append([method, response is None or "error" not in response])
    return response


def _logged_offer(self, kind, value, *args, **kwargs):
    if kind == "request" and isinstance(value, dict):
        _received.append(value.get("method"))
    return _offer(self, kind, value, *args, **kwargs)


def _run_with_test_methods(self, *args, **kwargs):
    self.register("test_sleep", _sleep)
    self.register("test_pid", os.getpid)
    self.register("test_identity", _identity)
    self.register("distill", _gated)
    self.register("create_pdf_folders", _gated)
    return _run(self, *args, **kwargs)


ipc.JsonRpcServer.run = _run_with_test_methods
ipc.JsonRpcServer._handle = _logged_handle
ipc._Inbox.offer = _logged_offer

from engine.__main__ import main  # noqa: E402

main()
