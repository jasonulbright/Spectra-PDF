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
from contextlib import redirect_stdout
from typing import Any, Callable, TextIO

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


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


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def encode_response(response: dict) -> str:
    """One response as the line the host reads.

    `json.dumps` writes a lone surrogate as `\\udcXX` and a character past
    the BMP as a surrogate PAIR, so a line without `\\ud` holds neither and
    is written as dumped.
    """
    line = json.dumps(response, allow_nan=False)
    if "\\ud" in line:
        line = json.dumps(_json_safe(response), allow_nan=False)
    return line


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


class JsonRpcServer:
    """Minimal JSON-RPC 2.0 server over stdin/stdout."""

    def __init__(self) -> None:
        self._methods: dict[str, Callable[..., Any]] = {}

    def register(self, name: str, handler: Callable[..., Any]) -> None:
        self._methods[name] = handler

    def run(self, input_stream: TextIO, output_stream: TextIO) -> None:
        for line in input_stream:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line, parse_constant=_reject_json_constant)
            except (ValueError, RecursionError):
                self._write_error(output_stream, None, -32700, "Parse error")
                continue
            # An exception that escapes this loop ends the process, and every
            # request any window has in flight with it.
            if not isinstance(request, dict):
                self._write_error(output_stream, None, -32600, "Invalid Request")
                continue
            # Handler progress and diagnostics are not JSON-RPC frames. Keep
            # synchronous prints off stdout, which is the line-framed protocol
            # channel consumed by both the desktop app and the CLI.
            with redirect_stdout(sys.stderr):
                response = self._handle(request)
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

    @staticmethod
    def _write_error(
        stream: TextIO, req_id: Any, code: int, message: str
    ) -> None:
        response = {
            "jsonrpc": "2.0",
            "error": {"code": code, "message": message},
            "id": req_id,
        }
        stream.write(json.dumps(response) + "\n")
        stream.flush()
