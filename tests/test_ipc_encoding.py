"""The JSON-RPC channel must be UTF-8 end to end.

Review-caught (2l): on Windows an embedded/console Python defaults piped
stdio to the ANSI codepage (cp1252), silently decoding the spawner's UTF-8
request bytes as cp1252 — mojibake for every non-ASCII value on every
text-carrying op, in the GUI and CLI alike, corrupting VALID values ("José
García") and letting invalid ones ("日本語") slip past the forms WinAnsi
check as gibberish-that-happens-to-encode. It hid because every other test
calls engine functions in-process; these tests drive the REAL subprocess
stdin/stdout channel. The engine reconfigures its own stdio to UTF-8 in
__main__.py — these tests deliberately spawn WITHOUT PYTHONUTF8 so the
in-engine fix alone is what's being proven (the spawners also set
PYTHONUTF8=1 as the other half)."""

import json
import os
import subprocess
import sys

import pikepdf

SRC_DIR = os.path.join(os.path.dirname(__file__), "..", "src")


def _rpc_roundtrip(requests: list[dict]) -> list[dict]:
    """Run the engine as a real subprocess and exchange JSON-RPC lines,
    UTF-8-encoded on the wire exactly like engine.rs / cli.rs write them."""
    env = dict(os.environ)
    env.pop("PYTHONUTF8", None)  # prove the engine-side reconfigure suffices
    env.pop("PYTHONIOENCODING", None)
    proc = subprocess.Popen(
        [sys.executable, "-m", "engine"],
        cwd=SRC_DIR,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    payload = b"".join(json.dumps(r, ensure_ascii=False).encode("utf-8") + b"\n" for r in requests)
    out, _ = proc.communicate(payload, timeout=60)
    responses = []
    for line in out.decode("utf-8").splitlines():
        line = line.strip()
        if line.startswith("{"):
            responses.append(json.loads(line))
    return responses


def test_non_ascii_metadata_roundtrips_exactly(tmp_dir):
    src = os.path.join(tmp_dir, "meta.pdf")
    doc = pikepdf.new()
    doc.add_blank_page(page_size=(100, 100))
    doc.save(src)
    doc.close()
    out = os.path.join(tmp_dir, "meta_out.pdf")

    title = "José García — 日本語 · кириллица"
    responses = _rpc_roundtrip(
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "set_metadata",
                "params": {"file": src, "output": out, "title": title},
            },
            {"jsonrpc": "2.0", "id": 2, "method": "get_metadata", "params": {"file": out}},
        ]
    )
    by_id = {r["id"]: r for r in responses}
    assert "error" not in by_id[1], by_id[1]
    # The exact title must survive the wire in BOTH directions.
    assert by_id[2]["result"]["title"] == title


def test_forms_winansi_check_holds_over_the_wire(tmp_dir):
    fixture = os.path.join(os.path.dirname(__file__), "fixtures", "form-pdflib.pdf")
    out = os.path.join(tmp_dir, "filled.pdf")

    responses = _rpc_roundtrip(
        [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "fill_form_fields",
                "params": {"file": fixture, "output": out, "edits": {"applicant.name": "日本語"}},
            },
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "fill_form_fields",
                "params": {"file": fixture, "output": out, "edits": {"applicant.name": "José García"}},
            },
            {"jsonrpc": "2.0", "id": 3, "method": "read_form_fields", "params": {"file": out}},
        ]
    )
    by_id = {r["id"]: r for r in responses}
    # Non-WinAnsi genuinely rejected over the wire (it used to slip through as
    # cp1252 mojibake that happened to encode)...
    assert "error" in by_id[1]
    assert "WinAnsi" in by_id[1]["error"]["message"]
    # ...while a VALID accented value survives byte-exact (it used to corrupt).
    assert "error" not in by_id[2], by_id[2]
    values = {f["name"]: f["value"] for f in by_id[3]["result"]["fields"]}
    assert values["applicant.name"] == "José García"
