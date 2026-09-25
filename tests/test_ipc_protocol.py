"""The JSON-RPC loop answers every line and survives every line.

One engine process serves every window, so a request that raises out of
the loop ends every in-flight call; and the host drops a response line it
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


def test_unhashable_method_is_method_not_found():
    for method in ("[1]", "{}"):
        replies = _serve([f'{{"id":7,"method":{method}}}', _SENTINEL])
        assert replies[0]["error"]["code"] == -32601
        assert replies[0]["id"] == 7
        assert replies[1]["id"] == 99


def test_non_finite_result_is_an_error_for_its_id():
    replies = _serve(['{"id":5,"method":"nan"}', '{"id":6,"method":"inf"}', _SENTINEL])
    assert [r["id"] for r in replies] == [5, 6, 99]
    assert replies[0]["error"]["code"] == -32603
    assert replies[1]["error"]["code"] == -32603


def test_unserializable_result_is_an_error_for_its_id():
    replies = _serve(['{"id":4,"method":"raw"}', _SENTINEL])
    assert replies[0]["error"]["code"] == -32603
    assert replies[0]["id"] == 4
    assert replies[1]["id"] == 99


def test_escaped_nul_in_a_string_round_trips():
    replies = _serve(['{"id":1,"method":"echo","params":{"a":"x\\u0000y"}}'])
    assert replies[0]["result"] == {"a": "x\x00y"}


def test_control_calls_are_unchanged():
    replies = _serve(["not json", '{"id":2,"method":"echo","params":[1]}', _SENTINEL])
    assert replies[0]["error"]["code"] == -32700
    assert replies[1]["error"]["code"] == -32000 and replies[1]["id"] == 2
    assert replies[2]["id"] == 99
