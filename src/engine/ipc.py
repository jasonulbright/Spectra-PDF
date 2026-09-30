"""
JSON-RPC 2.0 protocol handler for stdin/stdout communication.

The host reads each response line with a JSON reader that rejects a lone
surrogate escape, and drops the whole line when it meets one — the call
never resolves. A lone surrogate is how Python spells a byte that is not
UTF-8 once it has been decoded with `surrogateescape`, which is what
pikepdf's `keys()` does to a dictionary key whose name is not UTF-8 (ISO
32000-2 §7.3.5 allows any byte in a name). So no response leaves here
holding one: each such byte is written `#XX`, the escape a name is written
with in the file.
"""

import json
import math
import re
import sys
import threading
from collections import deque
from contextlib import contextmanager, redirect_stdout
from contextvars import ContextVar
from typing import Any, Callable, Iterator, TextIO

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
MAX_JSONRPC_LINE_BYTES = 256 * 1024 * 1024
#: Bounds on requests read but not yet served. The reader never stops reading,
#: so a cancel is always applied on arrival; a request that arrives while the
#: inbox is at a bound is refused on its id instead of being queued.
MAX_QUEUED_REQUESTS = 256
MAX_QUEUED_BYTES = 2 * MAX_JSONRPC_LINE_BYTES


def _escaped(text: str) -> str:
    """`text` with each lone surrogate written `#XX`: the byte it stands
    for when it came from `surrogateescape`, else its code point's low
    byte pair."""
    def one(match) -> str:
        code = ord(match.group(0))
        if 0xDC80 <= code <= 0xDCFF:
            return f"#{code - 0xDC00:02X}"
        return f"#{code >> 8:02X}#{code & 0xFF:02X}"

    return _LONE_SURROGATE.sub(one, text)


def _json_safe(value: Any) -> Any:
    """`value` with every string, dictionary keys included, free of lone
    surrogates."""
    if isinstance(value, str):
        return _escaped(value) if _LONE_SURROGATE.search(value) else value
    if isinstance(value, dict):
        return {_json_safe(k) if isinstance(k, str) else k: _json_safe(v)
                for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def _contains_lone_surrogate(value: Any, ancestors: set[int] | None = None) -> bool:
    """Check JSON data before encoding; escaped non-BMP scalars are valid."""
    if isinstance(value, str):
        return _LONE_SURROGATE.search(value) is not None
    if not isinstance(value, (dict, list, tuple)):
        return False

    if ancestors is None:
        ancestors = set()
    identity = id(value)
    if identity in ancestors:
        raise ValueError("Circular reference detected")
    ancestors.add(identity)
    try:
        if isinstance(value, dict):
            return any(
                (isinstance(key, str) and _contains_lone_surrogate(key, ancestors))
                or _contains_lone_surrogate(item, ancestors)
                for key, item in value.items()
            )
        return any(_contains_lone_surrogate(item, ancestors) for item in value)
    finally:
        ancestors.remove(identity)


# ── cooperative cancel ────────────────────────────────────────────────────
#
# The reader thread receives a `$/cancelRequest` notification while the main
# thread is still inside a handler. A cancel is recorded only for an id that
# is queued or running, so a cancel that arrives after its response leaves
# nothing behind. A handler never sees an id: it asks `cancelled()` about the
# request it is serving, and only at its own safe points.

CANCEL_METHOD = "$/cancelRequest"


class RequestCancelled(Exception):
    """Raised at a safe point when the request being served was cancelled."""


def cancel_key(req_id: Any) -> Any:
    """A hashable key for a JSON-RPC id; bool is not an id and never matches."""
    if isinstance(req_id, bool):
        return None
    if isinstance(req_id, (int, str)):
        return (type(req_id).__name__, req_id)
    if isinstance(req_id, float):
        return ("int", int(req_id)) if req_id.is_integer() else ("float", req_id)
    return None


class CancelRegistry:
    """Ids that are queued or running, and which of them were cancelled."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._live: dict[Any, int] = {}
        self._cancelled: set[Any] = set()

    def admit(self, req_id: Any) -> None:
        key = cancel_key(req_id)
        if key is None:
            return
        with self._lock:
            self._live[key] = self._live.get(key, 0) + 1

    def retire(self, req_id: Any) -> None:
        key = cancel_key(req_id)
        if key is None:
            return
        with self._lock:
            count = self._live.get(key, 0) - 1
            if count > 0:
                self._live[key] = count
            else:
                self._live.pop(key, None)
                self._cancelled.discard(key)

    def request(self, req_id: Any) -> bool:
        """Record a cancel. False when no such request is queued or running."""
        key = cancel_key(req_id)
        if key is None:
            return False
        with self._lock:
            if key not in self._live:
                return False
            self._cancelled.add(key)
            return True

    def is_cancelled(self, req_id: Any) -> bool:
        key = cancel_key(req_id)
        if key is None:
            return False
        with self._lock:
            return key in self._cancelled

    def live_count(self) -> int:
        with self._lock:
            return len(self._live)


_current: ContextVar[Callable[[], bool] | None] = ContextVar("_current_cancel", default=None)


def cancelled() -> bool:
    """True when the request this handler is serving has been cancelled."""
    check = _current.get()
    return bool(check and check())


def raise_if_cancelled() -> None:
    if cancelled():
        raise RequestCancelled()


@contextmanager
def serving(check: Callable[[], bool]) -> Iterator[None]:
    """Bind `check` as the cancel test for the handler run inside the scope."""
    token = _current.set(check)
    try:
        yield
    finally:
        _current.reset(token)


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def encode_response(response: dict) -> str:
    """One response as the line the host reads.

    Detect lone surrogates in the source tree before encoding. Looking for
    `\\ud` in the encoded line also matches valid non-BMP characters, which
    need no repair and should not cause a full response copy and second dump.
    """
    if _contains_lone_surrogate(response):
        safe_response = _json_safe(response)
    else:
        safe_response = response
    return json.dumps(safe_response, allow_nan=False)


def _representable_id(req_id: Any) -> Any:
    """`req_id` when it can be written back as JSON, else None."""
    if isinstance(req_id, bool) or not isinstance(req_id, (int, float, str)):
        return None
    if isinstance(req_id, float) and not math.isfinite(req_id):
        return None
    return _json_safe(req_id)


def _valid_request_id(req_id: Any) -> bool:
    return (
        req_id is None
        or isinstance(req_id, str)
        or (isinstance(req_id, int) and not isinstance(req_id, bool))
        or (isinstance(req_id, float) and math.isfinite(req_id))
    )


QUEUE_FULL_CODE = -32001
QUEUE_FULL_MESSAGE = "The engine has too many queued requests. Try again when current work finishes."


def _refused(message: str, req_id: Any, code: int) -> dict[str, Any]:
    """A user-facing refusal answered on `req_id`; the message is swept into
    the engine refusal table like a raised one."""
    return {"jsonrpc": "2.0", "error": {"code": code, "message": message}, "id": req_id}


class _Inbox:
    """FIFO between the reader thread and the main thread, bounded by item
    count and by the wire size of the queued lines. An item is always admitted
    into an empty inbox, so one line at the size limit still proceeds.
    `offer` never blocks, so the reader keeps draining input at a bound."""

    def __init__(self, max_items: int, max_bytes: int) -> None:
        self._items: deque[tuple[str, Any, int]] = deque()
        self._bytes = 0
        self._max_items = max_items
        self._max_bytes = max_bytes
        self._changed = threading.Condition()

    def offer(self, kind: str, value: Any, size: int = 0) -> bool:
        """Queue the item when it fits; False leaves the inbox unchanged."""
        with self._changed:
            if self._items and (
                len(self._items) >= self._max_items
                or self._bytes + size > self._max_bytes
            ):
                return False
            self._items.append((kind, value, size))
            self._bytes += size
            self._changed.notify_all()
            return True

    def close(self, failure: BaseException | None) -> None:
        """Queue end of input past the bounds: it holds no request bytes."""
        with self._changed:
            self._items.append(("eof", failure, 0))
            self._changed.notify_all()

    def get(self) -> tuple[str, Any]:
        with self._changed:
            while not self._items:
                self._changed.wait()
            kind, value, size = self._items.popleft()
            self._bytes -= size
            self._changed.notify_all()
            return kind, value


class JsonRpcServer:
    """Minimal JSON-RPC 2.0 server over stdin/stdout."""

    def __init__(self) -> None:
        self._methods: dict[str, Callable[..., Any]] = {}
        self.cancels = CancelRegistry()
        # The reader thread answers refused lines while the main thread writes
        # responses; one frame per write keeps lines whole on the wire.
        self._output_lock = threading.Lock()

    def register(self, name: str, handler: Callable[..., Any]) -> None:
        self._methods[name] = handler

    def _read(self, input_stream: TextIO, output_stream: TextIO, inbox: _Inbox) -> None:
        """Reader thread. A cancel is applied here, while the main thread may
        be inside the handler it cancels; every other line is queued in
        arrival order. The last item is always ("eof", exception-or-None), so
        end of input is served only after every request queued before it:
        the host retires a closed window's worker by closing its stdin."""
        failure: BaseException | None = None
        try:
            for line in input_stream:
                size = len(line)
                line = line.strip()
                if not line:
                    continue
                try:
                    request = json.loads(line, parse_constant=_reject_json_constant)
                except (ValueError, RecursionError):
                    if not inbox.offer("parse-error", None):
                        self._write_error(output_stream, None, -32700, "Parse error")
                    continue
                if (
                    isinstance(request, dict)
                    and request.get("method") == CANCEL_METHOD
                    and "id" not in request
                ):
                    params = request.get("params")
                    if isinstance(params, dict):
                        self.cancels.request(params.get("id"))
                    continue
                has_id = isinstance(request, dict) and "id" in request
                if has_id:
                    self.cancels.admit(request.get("id"))
                if inbox.offer("request", request, size):
                    continue
                if has_id:
                    self.cancels.retire(request.get("id"))
                    req_id = request.get("id")
                    reply_id = _representable_id(req_id) if _valid_request_id(req_id) else None
                    self._write(output_stream, _refused(QUEUE_FULL_MESSAGE, reply_id, QUEUE_FULL_CODE))
        except BaseException as exc:  # noqa: BLE001 - re-raised on the main thread
            failure = exc
        finally:
            inbox.close(failure)

    def run(self, input_stream: TextIO, output_stream: TextIO) -> None:
        inbox = _Inbox(MAX_QUEUED_REQUESTS, MAX_QUEUED_BYTES)
        threading.Thread(
            target=self._read, args=(input_stream, output_stream, inbox), name="jsonrpc-reader", daemon=True
        ).start()
        while True:
            kind, request = inbox.get()
            if kind == "eof":
                if request is not None:
                    raise request
                return
            if kind == "parse-error":
                self._write_error(output_stream, None, -32700, "Parse error")
                continue
            # An exception that escapes this loop ends the process, and every
            # request its window has in flight with it.
            if not isinstance(request, dict):
                self._write_error(output_stream, None, -32600, "Invalid Request")
                continue
            has_id = "id" in request
            req_id = request.get("id")
            # Handler progress and diagnostics are not JSON-RPC frames. Keep
            # synchronous prints off stdout, which is the line-framed protocol
            # channel consumed by both the desktop app and the CLI.
            try:
                with redirect_stdout(sys.stderr), serving(
                    lambda: has_id and self.cancels.is_cancelled(req_id)
                ):
                    response = self._handle(request)
            finally:
                if has_id:
                    self.cancels.retire(req_id)
                from engine.credentials import end_request

                end_request()
            if response is None:
                continue
            try:
                encoded = encode_response(response)
            except (TypeError, ValueError) as exc:
                # The host drops a line it cannot parse (NaN, Infinity), so
                # the call would never resolve; an unrepresentable result is
                # reported against its id instead.
                encoded = encode_response({
                    "jsonrpc": "2.0",
                    "error": {"code": -32603,
                              "message": f"Result not representable as JSON: {exc}"},
                    "id": _representable_id(response.get("id")),
                })
            except RecursionError:
                # Deep results can make the encoder's diagnostic itself huge;
                # keep the fallback small and let the server continue.
                encoded = encode_response({
                    "jsonrpc": "2.0",
                    "error": {"code": -32603,
                              "message": "Result exceeds JSON encoding limits."},
                    "id": _representable_id(response.get("id")),
                })
            if len(encoded) > MAX_JSONRPC_LINE_BYTES:
                # json.dumps uses ensure_ascii=True, so each character here is
                # one wire byte. Return a small error instead of sending a
                # frame the native reader is required to refuse.
                encoded = encode_response({
                    "jsonrpc": "2.0",
                    "error": {
                        "code": -32603,
                        "message": "Result exceeds the JSON-RPC response size limit.",
                    },
                    "id": _representable_id(response.get("id")),
                })
            with self._output_lock:
                output_stream.write(encoded + "\n")
                output_stream.flush()

    def _handle(self, request: dict[str, Any]) -> dict[str, Any] | None:
        has_id = "id" in request
        req_id = request.get("id")
        response_id = (
            _representable_id(req_id)
            if has_id and _valid_request_id(req_id)
            else None
        )
        method = request.get("method")
        params = request.get("params", {})

        if (
            request.get("jsonrpc") != "2.0"
            or not isinstance(method, str)
            or not isinstance(params, (dict, list))
            or (has_id and not _valid_request_id(req_id))
        ):
            return {
                "jsonrpc": "2.0",
                "error": {"code": -32600, "message": "Invalid Request"},
                "id": response_id,
            }

        if method not in self._methods:
            if not has_id:
                return None
            return {
                "jsonrpc": "2.0",
                "error": {"code": -32601, "message": f"Method not found: {method}"},
                "id": response_id,
            }

        try:
            if isinstance(params, dict):
                result = self._methods[method](**params)
            else:
                result = self._methods[method](*params)
            if not has_id:
                return None
            return {"jsonrpc": "2.0", "result": result, "id": response_id}
        except Exception as exc:
            if not has_id:
                return None
            return {
                "jsonrpc": "2.0",
                "error": {"code": -32000, "message": str(exc)},
                "id": response_id,
            }

    def _write_error(
        self,
        stream: TextIO, req_id: Any, code: int, message: str
    ) -> None:
        self._write(stream, {
            "jsonrpc": "2.0",
            "error": {"code": code, "message": message},
            "id": req_id,
        })

    def _write(self, stream: TextIO, response: dict[str, Any]) -> None:
        with self._output_lock:
            stream.write(json.dumps(response) + "\n")
            stream.flush()
