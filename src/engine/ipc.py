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
import re
import sys
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


def encode_response(response: dict) -> str:
    """One response as the line the host reads.

    `json.dumps` writes a lone surrogate as `\\udcXX` and a character past
    the BMP as a surrogate PAIR, so a line without `\\ud` holds neither and
    is written as dumped.
    """
    line = json.dumps(response)
    if "\\ud" in line:
        line = json.dumps(_json_safe(response))
    return line


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
                request = json.loads(line)
                response = self._handle(request)
                if response is not None:
                    output_stream.write(encode_response(response) + "\n")
                    output_stream.flush()
            except json.JSONDecodeError:
                self._write_error(output_stream, None, -32700, "Parse error")

    def _handle(self, request: dict[str, Any]) -> dict[str, Any] | None:
        req_id = request.get("id")
        method = request.get("method", "")
        params = request.get("params", {})

        if method not in self._methods:
            return {
                "jsonrpc": "2.0",
                "error": {"code": -32601, "message": f"Method not found: {method}"},
                "id": req_id,
            }

        try:
            result = self._methods[method](**params)
            return {"jsonrpc": "2.0", "result": result, "id": req_id}
        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "error": {"code": -32000, "message": str(exc)},
                "id": req_id,
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
