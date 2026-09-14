"""One bounded retry policy for every corpus fetch a CI or release job runs.

A transient upstream failure is not a build failure: a 504 from a host that
serves the same URL a minute later has failed whole jobs. Only transient
conditions are retried -- HTTP 408, 429 and 5xx, plus connect/read timeouts and
reset connections. Every other 4xx is a real answer about the request and is
raised on the first attempt.

Retrying never relaxes acceptance: the caller's hash verification runs on the
bytes of whatever attempt succeeded, unchanged.
"""
from __future__ import annotations

import http.client
import socket
import time
import urllib.error
import urllib.request
from typing import Callable

ATTEMPTS = 4
BASE_DELAY_SECONDS = 3.0
TRANSIENT_STATUS = frozenset({408, 429})
_TRANSPORT = (
    TimeoutError,
    socket.timeout,
    ConnectionError,
    http.client.IncompleteRead,
    http.client.RemoteDisconnected,
)


def is_transient(error: BaseException) -> bool:
    """Whether one failed attempt says to try again rather than to stop."""
    if isinstance(error, urllib.error.HTTPError):
        return error.code in TRANSIENT_STATUS or error.code >= 500
    if isinstance(error, urllib.error.URLError):
        return isinstance(error.reason, _TRANSPORT) or isinstance(error.reason, socket.gaierror)
    return isinstance(error, _TRANSPORT)


def fetch_with_retry(
    request: urllib.request.Request,
    *,
    timeout: float,
    description: str,
    inspect: Callable[[object], None] | None = None,
    attempts: int = ATTEMPTS,
    base_delay: float = BASE_DELAY_SECONDS,
) -> bytes:
    """The response body of one request, retrying transient failures only.

    Args:
        timeout: The per-attempt timeout, in seconds.
        inspect: Checked against the response before its body is read. What it
            raises is the caller's own refusal and is never retried.
    """
    if attempts < 1:
        raise ValueError("a fetch needs at least one attempt")
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if inspect is not None:
                    inspect(response)
                return response.read()
        except Exception as error:  # noqa: BLE001 - classified immediately below
            if not is_transient(error):
                raise
            if attempt == attempts:
                raise RuntimeError(
                    f"{description}: transient download failure after {attempts} "
                    f"attempts ({error})"
                ) from error
            wait = base_delay * attempt
            print(f"  {description}: attempt {attempt}/{attempts} failed ({error}); "
                  f"retrying in {wait:.0f}s...", flush=True)
            time.sleep(wait)
    raise AssertionError("unreachable")
