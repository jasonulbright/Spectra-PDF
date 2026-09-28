"""A cancelled batch stops between files or between pages, and every original
is either untouched or fully replaced."""

import io
import json
import threading
import time
from pathlib import Path

import pikepdf

import engine.batch_ocr as batch_mod
from engine.batch_ocr import batch_ocr
from engine.ipc import CancelRegistry, JsonRpcServer, cancelled, serving


def _pdf(path: Path, pages: int = 3) -> bytes:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(612, 792))
    pdf.save(str(path))
    pdf.close()
    return path.read_bytes()


def _tree(root: Path, names=("a.pdf", "b.pdf", "c.pdf")) -> dict[str, bytes]:
    root.mkdir(parents=True, exist_ok=True)
    return {name: _pdf(root / name) for name in names}


class _Fakes:
    """Recognition without Tesseract: every page needs OCR and yields a word.
    `stop_at` names the recognize() call (1-based) that trips the cancel."""

    def __init__(self, monkeypatch, stop_at: int | None = None, stop_after_writes: int | None = None):
        self.flag = [False]
        self.calls = 0
        self.writes = 0
        self.stop_at = stop_at
        self.stop_after_writes = stop_after_writes
        monkeypatch.setattr(batch_mod, "_pages_needing_ocr", lambda _p, pdf: list(range(len(pdf.pages))))
        monkeypatch.setattr(batch_mod, "recognize", self.recognize)
        monkeypatch.setattr(batch_mod, "_to_pdf_rects", lambda _p, _i, words: words)
        monkeypatch.setattr(batch_mod, "apply_ocr_layer", self.apply)

    def recognize(self, *_args, **_kw):
        self.calls += 1
        if self.stop_at is not None and self.calls >= self.stop_at:
            self.flag[0] = True
        return {"words": [{"text": "w", "rect": [0, 0, 1, 1]}]}

    def apply(self, src: str, out: str, pages):
        with pikepdf.open(src) as pdf:
            pdf.Root.SpectraTestOcr = pikepdf.Name.Yes
            pdf.save(out)
        self.writes += 1
        if self.stop_after_writes is not None and self.writes >= self.stop_after_writes:
            self.flag[0] = True

    def run(self, **kw):
        with serving(lambda: self.flag[0]):
            return batch_ocr(**kw)


def _is_ocrd(path: Path) -> bool:
    with pikepdf.open(str(path)) as pdf:
        return "/SpectraTestOcr" in pdf.Root


def _litter(root: Path) -> list[str]:
    return sorted(p.name for p in root.rglob("*") if p.name.endswith(".tmp"))


def test_in_place_stop_between_files_keeps_finished_files_and_leaves_the_rest(tmp_path, monkeypatch):
    src = tmp_path / "in"
    before = _tree(src)
    logs = tmp_path / "logs"
    fakes = _Fakes(monkeypatch, stop_after_writes=1)
    report = fakes.run(source=str(src), in_place=True, log_dir=str(logs))

    assert report["cancelled"] is True
    assert [r["rel"] for r in report["results"]] == ["a.pdf"]
    assert report["results"][0]["inPlace"] is True
    assert _is_ocrd(src / "a.pdf")
    assert (src / "b.pdf").read_bytes() == before["b.pdf"]
    assert (src / "c.pdf").read_bytes() == before["c.pdf"]
    assert _litter(src) == []
    text = Path(report["logPath"]).read_text(encoding="utf-8")
    assert "STOPPED by the user" in text and "were replaced" in text


def test_in_place_stop_between_pages_leaves_that_original_byte_identical(tmp_path, monkeypatch):
    src = tmp_path / "in"
    before = _tree(src)
    fakes = _Fakes(monkeypatch, stop_at=2)
    report = fakes.run(source=str(src), in_place=True)

    assert report["cancelled"] is True
    assert report["results"] == []
    assert fakes.writes == 0
    for name, data in before.items():
        assert (src / name).read_bytes() == data
    assert _litter(src) == []


def test_mirror_stop_between_pages_writes_no_partial_output(tmp_path, monkeypatch):
    src = tmp_path / "in"
    dest = tmp_path / "out"
    _tree(src)
    fakes = _Fakes(monkeypatch, stop_at=5)
    report = fakes.run(source=str(src), dest=str(dest))

    assert report["cancelled"] is True
    assert [r["rel"] for r in report["results"]] == ["a.pdf"]
    assert sorted(p.name for p in dest.rglob("*.pdf")) == ["a.pdf"]
    assert _litter(dest) == []


def test_a_stopped_run_removes_no_empty_folders(tmp_path, monkeypatch):
    src = tmp_path / "in"
    _tree(src)
    (src / "empty").mkdir()
    fakes = _Fakes(monkeypatch, stop_after_writes=1)
    report = fakes.run(source=str(src), in_place=True, remove_empty_folders=True)

    assert report["cancelled"] is True
    assert "emptyFolders" not in report
    assert (src / "empty").is_dir()


def test_an_uncancelled_run_reports_completed(tmp_path, monkeypatch):
    src = tmp_path / "in"
    _tree(src, ("a.pdf",))
    logs = tmp_path / "logs"
    fakes = _Fakes(monkeypatch)
    report = fakes.run(source=str(src), in_place=True, log_dir=str(logs))
    assert report["cancelled"] is False
    assert "Result:       completed" in Path(report["logPath"]).read_text(encoding="utf-8")


# ── the channel ──────────────────────────────────────────────────────────────


def _frames(text: str) -> list[dict]:
    return [json.loads(line) for line in text.splitlines()]


def test_a_cancel_for_a_queued_request_is_seen_when_it_starts():
    server = JsonRpcServer()

    def first() -> bool:
        deadline = time.monotonic() + 5
        while not server.cancels.is_cancelled(2) and time.monotonic() < deadline:
            time.sleep(0.01)
        return cancelled()

    server.register("first", first)
    server.register("probe", lambda: cancelled())
    lines = [
        {"jsonrpc": "2.0", "id": 1, "method": "first", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "probe", "params": {}},
        {"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 2}},
    ]
    out = io.StringIO()
    server.run(io.StringIO("".join(json.dumps(x) + "\n" for x in lines)), out)
    assert _frames(out.getvalue()) == [
        {"jsonrpc": "2.0", "result": False, "id": 1},
        {"jsonrpc": "2.0", "result": True, "id": 2},
    ]
    assert server.cancels.live_count() == 0


def test_a_cancel_for_no_live_request_is_dropped_and_never_reaches_a_later_one():
    server = JsonRpcServer()
    server.register("probe", lambda: cancelled())
    lines = [
        {"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": 7}},
        {"jsonrpc": "2.0", "id": 7, "method": "probe", "params": {}},
    ]
    out = io.StringIO()
    server.run(io.StringIO("".join(json.dumps(x) + "\n" for x in lines)), out)
    assert _frames(out.getvalue()) == [{"jsonrpc": "2.0", "result": False, "id": 7}]


class _LineFeed(io.TextIOBase):
    """A blocking line source the test writes to while the server runs."""

    def __init__(self) -> None:
        self._lines: list[str] = []
        self._cv = threading.Condition()
        self._closed = False

    def feed(self, obj) -> None:
        with self._cv:
            self._lines.append(json.dumps(obj) + "\n")
            self._cv.notify_all()

    def close_feed(self) -> None:
        with self._cv:
            self._closed = True
            self._cv.notify_all()

    def readable(self) -> bool:
        return True

    def __iter__(self):
        return self

    def __next__(self) -> str:
        with self._cv:
            while not self._lines and not self._closed:
                self._cv.wait()
            if self._lines:
                return self._lines.pop(0)
            raise StopIteration


def test_a_cancel_reaches_a_handler_that_is_already_running():
    server = JsonRpcServer()
    started = threading.Event()

    def long_call() -> str:
        started.set()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if cancelled():
                return "stopped"
            time.sleep(0.01)
        return "ran out"

    server.register("long_call", long_call)
    feed = _LineFeed()
    out = io.StringIO()
    runner = threading.Thread(target=server.run, args=(feed, out))
    runner.start()
    feed.feed({"jsonrpc": "2.0", "id": "x", "method": "long_call", "params": {}})
    assert started.wait(5)
    feed.feed({"jsonrpc": "2.0", "method": "$/cancelRequest", "params": {"id": "x"}})
    feed.close_feed()
    runner.join(15)
    assert not runner.is_alive()
    assert _frames(out.getvalue()) == [{"jsonrpc": "2.0", "result": "stopped", "id": "x"}]


def test_registry_keys_do_not_confuse_a_string_id_with_a_number():
    reg = CancelRegistry()
    reg.admit(1)
    assert reg.request("1") is False
    assert reg.request(True) is False
    assert reg.request(1.0) is True
    assert reg.is_cancelled(1)
    reg.retire(1)
    assert reg.live_count() == 0 and not reg.is_cancelled(1)



def test_a_stopped_mirror_run_leaves_no_folder_its_staging_created(tmp_path, monkeypatch):
    src = tmp_path / "in"
    (src / "sub" / "deeper").mkdir(parents=True)
    _pdf(src / "sub" / "deeper" / "a.pdf")
    dest = tmp_path / "out"
    (dest / "kept").mkdir(parents=True)
    fakes = _Fakes(monkeypatch, stop_at=1)
    monkeypatch.setattr(batch_mod, "_enhance_step", lambda *_a, **_k: (False, ""))
    report = fakes.run(source=str(src), dest=str(dest), enhance=True)

    assert report["cancelled"] is True
    assert report["results"] == []
    assert sorted(p.relative_to(dest).as_posix() for p in dest.rglob("*")) == ["kept"]


def test_repair_only_stops_before_writing_a_repaired_file(tmp_path, monkeypatch):
    src = tmp_path / "in"
    before = _tree(src, ("a.pdf", "b.pdf"))
    flag = [False]

    def fake_repair(file, output):
        Path(output).write_bytes(Path(file).read_bytes())
        flag[0] = True
        return {"damaged": True, "pages": 3, "damage": ["x"]}

    monkeypatch.setattr(batch_mod, "repair", fake_repair)
    with serving(lambda: flag[0]):
        report = batch_ocr(source=str(src), in_place=True, repair_only=True)

    assert report["cancelled"] is True
    assert report["results"] == []
    for name, data in before.items():
        assert (src / name).read_bytes() == data
    assert _litter(src) == []
