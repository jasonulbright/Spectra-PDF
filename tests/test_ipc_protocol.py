"""The JSON-RPC loop validates each line and survives malformed calls.

One engine process serves each window, so a request that raises out of
the loop ends every call that window has in flight; and the host drops a response line it
cannot parse, so a result that is not strict JSON leaves its call pending
forever."""

import io
import json
import math

from engine.ipc import JsonRpcServer


def _serve(lines: list[str]) -> list[dict]:
    server = JsonRpcServer()
    server.register("echo", lambda **kw: kw)
    server.register("nan", lambda **kw: math.nan)
    server.register("inf", lambda **kw: {"x": math.inf})
    server.register("raw", lambda **kw: b"\x00\x01")
    out = io.StringIO()
    server.run(io.StringIO("".join(line + "\n" for line in lines)), out)
    # Strict parse: what the host's reader accepts.
    return [
        json.loads(line, parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))
        for line in out.getvalue().splitlines()
    ]


_SENTINEL = '{"jsonrpc":"2.0","id":99,"method":"echo","params":{"a":1}}'


def test_non_object_request_is_answered_and_the_loop_continues():
    for bad in ("[1,2]", "42", '"s"', "null"):
        replies = _serve([bad, _SENTINEL])
        assert replies[0]["error"]["code"] == -32600
        assert replies[0]["id"] is None
        assert replies[1] == {"jsonrpc": "2.0", "result": {"a": 1}, "id": 99}


def test_non_string_method_is_an_invalid_request():
    for method in ("[1]", "{}"):
        replies = _serve([f'{{"jsonrpc":"2.0","id":7,"method":{method}}}', _SENTINEL])
        assert replies[0]["error"]["code"] == -32600
        assert replies[0]["id"] == 7
        assert replies[1]["id"] == 99


def test_non_finite_result_is_an_error_for_its_id():
    replies = _serve(
        ['{"jsonrpc":"2.0","id":5,"method":"nan"}',
         '{"jsonrpc":"2.0","id":6,"method":"inf"}', _SENTINEL]
    )
    assert [r["id"] for r in replies] == [5, 6, 99]
    assert replies[0]["error"]["code"] == -32603
    assert replies[1]["error"]["code"] == -32603


def test_unserializable_result_is_an_error_for_its_id():
    replies = _serve(['{"jsonrpc":"2.0","id":4,"method":"raw"}', _SENTINEL])
    assert replies[0]["error"]["code"] == -32603
    assert replies[0]["id"] == 4
    assert replies[1]["id"] == 99


def test_escaped_nul_in_a_string_round_trips():
    replies = _serve(
        ['{"jsonrpc":"2.0","id":1,"method":"echo","params":{"a":"x\\u0000y"}}']
    )
    assert replies[0]["result"] == {"a": "x\x00y"}


def test_control_calls_are_unchanged():
    replies = _serve(
        ["not json", '{"jsonrpc":"2.0","id":2,"method":"echo","params":[1]}', _SENTINEL]
    )
    assert replies[0]["error"]["code"] == -32700
    assert replies[1]["error"]["code"] == -32000 and replies[1]["id"] == 2
    assert replies[2]["id"] == 99


def test_invalid_request_metadata_never_dispatches():
    calls = []
    server = JsonRpcServer()
    server.register("effect", lambda **params: calls.append(params) or "done")
    requests = [
        '{"jsonrpc":"1.0","id":1,"method":"effect","params":{}}',
        '{"id":2,"method":"effect","params":{}}',
        '{"jsonrpc":"2.0","id":3,"method":1}',
        '{"jsonrpc":"2.0","id":4,"method":"effect","params":"bad"}',
        '{"jsonrpc":"2.0","id":[],"method":"effect","params":{}}',
        '{"jsonrpc":"2.0","id":true,"method":"effect","params":{}}',
        '{"jsonrpc":"2.0","id":5,"method":"effect","params":{}}',
    ]
    out = io.StringIO()
    server.run(io.StringIO("\n".join(requests) + "\n"), out)

    replies = [json.loads(line) for line in out.getvalue().splitlines()]
    assert [reply["error"]["code"] for reply in replies[:6]] == [-32600] * 6
    assert [reply["id"] for reply in replies[:6]] == [1, 2, 3, 4, None, None]
    assert replies[6] == {"jsonrpc": "2.0", "result": "done", "id": 5}
    assert calls == [{}]


def test_notifications_are_dispatched_without_responses():
    calls = []
    server = JsonRpcServer()
    server.register("effect", lambda: calls.append("effect"))
    server.register("echo", lambda **params: params)
    requests = (
        '{"jsonrpc":"2.0","method":"effect"}\n'
        '{"jsonrpc":"2.0","method":"unknown"}\n'
        '{"jsonrpc":"2.0","id":null,"method":"echo","params":{"x":0}}\n'
        '{"jsonrpc":"2.0","id":8,"method":"echo","params":{"x":1}}\n'
    )
    out = io.StringIO()
    server.run(io.StringIO(requests), out)

    replies = [json.loads(line) for line in out.getvalue().splitlines()]
    assert replies == [
        {"jsonrpc": "2.0", "result": {"x": 0}, "id": None},
        {"jsonrpc": "2.0", "result": {"x": 1}, "id": 8},
    ]
    assert calls == ["effect"]


def test_positional_parameter_arrays_are_supported():
    server = JsonRpcServer()
    server.register("subtract", lambda left, right: left - right)
    out = io.StringIO()
    server.run(
        io.StringIO('{"jsonrpc":"2.0","id":1,"method":"subtract","params":[9,4]}\n'),
        out,
    )
    assert json.loads(out.getvalue()) == {"jsonrpc": "2.0", "result": 5, "id": 1}


def test_non_json_constants_are_parse_errors():
    replies = _serve(
        ['{"jsonrpc":"2.0","id":5,"method":"echo","params":{"x":NaN}}', _SENTINEL]
    )
    assert replies[0]["error"]["code"] == -32700
    assert replies[1]["id"] == 99


def test_numeric_id_is_preserved_in_result_serialization_error():
    replies = _serve(['{"jsonrpc":"2.0","id":4.5,"method":"raw"}'])
    assert replies[0]["error"]["code"] == -32603
    assert replies[0]["id"] == 4.5


def _pulled_while_busy(monkeypatch, *, items: int, max_bytes: int, total: int) -> tuple[int, list]:
    """Serve `total` requests behind one handler that blocks until released;
    return how many input lines the reader pulled while it blocked, and the
    replies once released."""
    import threading
    import time

    from engine import ipc

    monkeypatch.setattr(ipc, "MAX_QUEUED_REQUESTS", items)
    monkeypatch.setattr(ipc, "MAX_QUEUED_BYTES", max_bytes)
    release = threading.Event()
    pulled = 0

    def lines():
        nonlocal pulled
        for index in range(total):
            pulled += 1
            method = "block" if index == 0 else "echo"
            yield f'{{"jsonrpc":"2.0","id":{index},"method":"{method}","params":{{}}}}\n'

    server = JsonRpcServer()
    server.register("block", lambda: release.wait(10) and "done")
    server.register("echo", lambda **kw: kw)
    out = io.StringIO()
    runner = threading.Thread(target=server.run, args=(lines(), out))
    runner.start()
    deadline = time.monotonic() + 5
    last = -1
    while time.monotonic() < deadline and last != pulled:
        last = pulled
        time.sleep(0.2)
    seen = pulled
    release.set()
    runner.join(10)
    assert not runner.is_alive()
    return seen, [json.loads(line) for line in out.getvalue().splitlines()]


def test_a_busy_handler_stops_the_reader_at_the_queued_request_bound(monkeypatch):
    seen, replies = _pulled_while_busy(monkeypatch, items=4, max_bytes=1 << 30, total=200)
    # The running request, four queued, and one line held waiting for room.
    assert seen <= 6
    assert [r["id"] for r in replies] == list(range(200))


def test_a_busy_handler_stops_the_reader_at_the_queued_byte_bound(monkeypatch):
    seen, replies = _pulled_while_busy(monkeypatch, items=10_000, max_bytes=200, total=200)
    assert seen <= 6
    assert [r["id"] for r in replies] == list(range(200))
