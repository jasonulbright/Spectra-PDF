"""Builds truncated.pdf: sample.pdf cut off at 90% of its length.

The engine RECOVERS this (qpdf reconstructs an xref from scratch) and reports a
page count, while pdf.js refuses the same bytes outright. That disagreement is
the whole point of the fixture: it is the only way to reach the state where a
tab carries the real filename and the right page count over a canvas that will
never draw anything.
"""

from pathlib import Path

HERE = Path(__file__).resolve().parent

data = (HERE / "sample.pdf").read_bytes()
(HERE / "truncated.pdf").write_bytes(data[: int(len(data) * 0.9)])
print(f"truncated.pdf: {int(len(data) * 0.9)} of {len(data)} bytes")
