"""The engine RPC loop keeps serving after unrepresentable JSON depth."""

import json
from io import StringIO

from engine.ipc import JsonRpcServer


def _request(request_id: int, method: str, params: str = "{}") -> str:
    return (
        f'{{"jsonrpc":"2.0","id":{request_id},'
        f'"method":{json.dumps(method)},"params":{params}}}\n'
    )


def test_a_deep_request_is_reported_without_ending_the_server():
    server = JsonRpcServer()
    server.register("ping", lambda: "alive")
    # The shipped CPython decoder tolerates over 10,000 levels before its
    # C-stack guard fires; this depth reliably exercises that guard.
    depth = 20000
    deep_params = '{"x":' * depth + "0" + "}" * depth
    output = StringIO()

    server.run(
        StringIO(_request(1, "ping", deep_params) + _request(2, "ping")),
        output,
    )

    first, second = [json.loads(line) for line in output.getvalue().splitlines()]
    assert first["error"]["code"] == -32700
    assert second == {"jsonrpc": "2.0", "result": "alive", "id": 2}


def test_an_oversized_integer_is_reported_without_ending_the_server():
    server = JsonRpcServer()
    server.register("ping", lambda: "alive")
    oversized_integer = "9" * 5000
    output = StringIO()

    server.run(
        StringIO(_request(1, "ping", oversized_integer) + _request(2, "ping")),
        output,
    )

    first, second = [json.loads(line) for line in output.getvalue().splitlines()]
    assert first["error"]["code"] == -32700
    assert second == {"jsonrpc": "2.0", "result": "alive", "id": 2}


def test_a_deep_result_becomes_an_error_without_ending_the_server():
    server = JsonRpcServer()
    value = 0
    for _ in range(20000):
        value = [value]
    server.register("deep", lambda: value)
    server.register("ping", lambda: "alive")
    output = StringIO()

    server.run(StringIO(_request(1, "deep") + _request(2, "ping")), output)

    first, second = [json.loads(line) for line in output.getvalue().splitlines()]
    assert first["id"] == 1
    assert first["error"]["code"] == -32603
    assert second == {"jsonrpc": "2.0", "result": "alive", "id": 2}
