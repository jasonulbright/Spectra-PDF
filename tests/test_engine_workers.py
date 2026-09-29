"""Each window has its own engine worker process.

State that outlives a request lives in the process that created it, so a
credential registered in one worker is unknown to every other worker. A
worker whose window closed receives end of input: it answers every request
already queued, honours cancels sent before the end, and then exits."""

import io
import json
import os
import subprocess
import sys
import threading

import pikepdf
import pytest

from engine.ipc import JsonRpcServer, raise_if_cancelled

SRC_DIR = os.path.join(os.path.dirname(__file__), "..", "src")
USER = "user-secret"
OWNER = "owner-secret"


def _request(req_id, method, **params):
    return json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})


def _cancel(req_id):
    return json.dumps({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": req_id}})


def test_end_of_input_answers_every_queued_request_before_returning():
    started = threading.Event()
    server = JsonRpcServer()

    def slow(**_):
        started.set()
        return "slow"

    server.register("slow", slow)
    server.register("fast", lambda **kw: kw)
    lines = [_request(1, "slow"), _request(2, "fast", a=1), _request(3, "fast", a=2)]
    out = io.StringIO()
    server.run(io.StringIO("".join(line + "\n" for line in lines)), out)
    replies = [json.loads(line) for line in out.getvalue().splitlines()]
    assert started.is_set()
    assert [r["id"] for r in replies] == [1, 2, 3]
    assert replies[0]["result"] == "slow"
    assert replies[2]["result"] == {"a": 2}
    assert server.cancels.live_count() == 0


def test_a_cancel_sent_before_end_of_input_stops_the_queued_request():
    server = JsonRpcServer()

    def polls(**_):
        raise_if_cancelled()
        return "ran"

    server.register("polls", polls)
    lines = [_request(1, "polls"), _request(2, "polls"), _cancel(1)]
    out = io.StringIO()
    server.run(io.StringIO("".join(line + "\n" for line in lines)), out)
    replies = {r["id"]: r for r in map(json.loads, out.getvalue().splitlines())}
    assert set(replies) == {1, 2}
    assert "error" in replies[1]
    assert replies[2]["result"] == "ran"


class _Worker:
    """A real engine process, spoken to over its stdio like engine.rs does."""

    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "engine"],
            cwd=SRC_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=dict(os.environ, PYTHONUTF8="1"),
        )
        self.next_id = 0

    def call(self, method, **params):
        self.next_id += 1
        self.proc.stdin.write((_request(self.next_id, method, **params) + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            assert line, "the worker exited without answering"
            reply = json.loads(line)
            if reply.get("id") == self.next_id:
                return reply

    def close(self):
        self.proc.stdin.close()
        assert self.proc.wait(timeout=60) == 0


@pytest.fixture
def protected(tmp_dir):
    path = os.path.join(tmp_dir, "protected.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path, encryption=pikepdf.Encryption(user=USER, owner=OWNER, R=6))
    pdf.close()
    return path


def test_a_credential_lives_only_in_the_worker_that_registered_it(protected):
    first, second = _Worker(), _Worker()
    try:
        opened = first.call("open_document", path=protected, password=USER)
        assert opened["result"]["encrypted"] is True
        assert first.call("get_page_count", file=protected)["result"] is not None
        refused = second.call("get_page_count", file=protected)
        assert "error" in refused
        assert "password" in refused["error"]["message"].lower()
        assert second.call("document_permissions", path=protected).get("result", {}).get("opener") != "user"
        assert second.call("close_document", path=protected)["result"] == {"forgotten": False}
        assert first.call("close_document", path=protected)["result"] == {"forgotten": True}
    finally:
        first.close()
        second.close()


def _dictionary_pair(folder, tag, words):
    aff = os.path.join(folder, f"{tag}.aff")
    dic = os.path.join(folder, f"{tag}.dic")
    with open(aff, "w", encoding="utf-8") as f:
        f.write("SET UTF-8\n")
    with open(dic, "w", encoding="utf-8") as f:
        f.write(f"{words}\n")
        f.writelines(f"w{i:07d}\n" for i in range(words))
    return aff, dic


def test_two_workers_adding_one_dictionary_land_exactly_one_whole_pair(tmp_dir):
    user_dir = os.path.join(tmp_dir, "user")
    source = os.path.join(tmp_dir, "source")
    os.makedirs(source)
    tags = [f"zz_R{n}" for n in range(4)]
    pairs = {tag: _dictionary_pair(source, tag, 200_000) for tag in tags}
    sizes = {tag: os.path.getsize(pairs[tag][1]) for tag in tags}
    adders = [_Worker(), _Worker()]
    reader = _Worker()
    replies = {tag: [] for tag in tags}
    seen_partial = []
    stop = threading.Event()

    def add(worker):
        for tag in tags:
            aff, dic = pairs[tag]
            replies[tag].append(worker.call("add_user_dictionary", aff=aff, dic=dic, user_dictionary_dir=user_dir))

    def read():
        while not stop.is_set():
            listed = reader.call("list_dictionaries", user_dictionary_dir=user_dir)["result"]["dictionaries"]
            for entry in listed:
                tag = entry["tag"]
                dic = os.path.join(user_dir, tag, f"{tag}.dic")
                if tag in sizes and os.path.getsize(dic) != sizes[tag]:
                    seen_partial.append(tag)

    try:
        threads = [threading.Thread(target=add, args=(w,)) for w in adders]
        watcher = threading.Thread(target=read)
        watcher.start()
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=300)
        stop.set()
        watcher.join(timeout=60)
    finally:
        for worker in (*adders, reader):
            worker.close()
    for tag in tags:
        landed = [r for r in replies[tag] if "result" in r]
        refused = [r for r in replies[tag] if "error" in r]
        assert len(landed) == 1, (tag, replies[tag])
        assert len(refused) == 1 and "has already been added" in refused[0]["error"]["message"]
        assert os.path.getsize(os.path.join(user_dir, tag, f"{tag}.dic")) == sizes[tag]
    assert seen_partial == []
    assert sorted(os.listdir(user_dir)) == sorted(tags)


def test_a_briefly_locked_rename_is_retried_and_a_lasting_one_refuses_without_a_path(tmp_dir, monkeypatch):
    from engine import spelling

    source = os.path.join(tmp_dir, "source")
    os.makedirs(source)
    aff, dic = _dictionary_pair(source, "zz_LK", 3)
    user_dir = os.path.join(tmp_dir, "user")
    real_rename = os.rename
    refusals = {"left": 2}

    def flaky(src, dst):
        if refusals["left"] > 0:
            refusals["left"] -= 1
            raise PermissionError(5, "Access is denied", str(src))
        return real_rename(src, dst)

    monkeypatch.setattr(spelling, "_RENAME_PAUSE_SECONDS", 0)
    monkeypatch.setattr(spelling.os, "rename", flaky)
    assert spelling.add_user_dictionary(aff, dic, user_dir)["tag"] == "zz_LK"
    assert sorted(os.listdir(user_dir)) == ["zz_LK"]

    aff2, dic2 = _dictionary_pair(source, "zz_LL", 3)
    refusals["left"] = 10_000
    with pytest.raises(ValueError) as refused:
        spelling.add_user_dictionary(aff2, dic2, user_dir)
    assert "another program is using its files" in str(refused.value)
    assert user_dir not in str(refused.value) and "zz_LL" not in str(refused.value)
    assert sorted(os.listdir(user_dir)) == ["zz_LK"]
