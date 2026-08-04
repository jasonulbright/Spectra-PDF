"""Derived subprocess time budgets.

A FIXED wall-clock budget on a whole-document render fails on exactly the
documents the feature exists for. Issue #5's reporter hit `timeout=300` on a
50 MB smartphone scan — the normal case for scanned-document work, not an
outlier — and the same fixed 300 s appears across the Ghostscript-backed ops.

So a budget is DERIVED from the work: a floor, plus an allowance per megabyte
of input and per page. The computed number is named in the timeout message,
which is what keeps a genuine hang distinguishable from a slow job: "gave up
after 300s" says nothing, while "did not finish within the derived budget
(940s, 52.1 MB, 210 pages)" says the job was given time proportional to its
size and still did not return.
"""

from __future__ import annotations

import subprocess
from pathlib import Path


def derive(
    *,
    base: float,
    size_bytes: int = 0,
    pages: int = 0,
    per_mb: float = 0.0,
    per_page: float = 0.0,
    cap: float = 7200.0,
) -> float:
    """Seconds allowed for one subprocess run.

    `base` is the floor — a small file must still get enough time to start a
    process and load a runtime. The cap exists so a pathological input cannot
    produce an effectively-infinite budget; at two hours it is far above any
    honest run and far below "never returns".
    """
    if base <= 0:
        raise ValueError("a time budget needs a positive floor")
    mb = max(size_bytes, 0) / (1024.0 * 1024.0)
    derived = base + per_mb * mb + per_page * max(pages, 0)
    return min(derived, cap)


def for_file(path: str | Path, *, base: float, pages: int = 0, per_mb: float, per_page: float = 0.0) -> float:
    """`derive` with the size read off the file (0 when it is not there yet)."""
    try:
        size = Path(path).stat().st_size
    except OSError:
        size = 0
    return derive(base=base, size_bytes=size, pages=pages, per_mb=per_mb, per_page=per_page)


def describe(budget: float, *, size_bytes: int = 0, pages: int = 0) -> str:
    """The human half of a timeout message: what was allowed, and for what.

    Kept beside `derive` so a caller cannot report a budget it did not use.
    """
    parts = [f"{budget:.0f}s"]
    if size_bytes > 0:
        parts.append(f"{size_bytes / (1024.0 * 1024.0):.1f} MB")
    if pages > 0:
        parts.append(f"{pages} page{'s' if pages != 1 else ''}")
    return ", ".join(parts)


def timed_out(what: str, budget: float, *, size_bytes: int = 0, pages: int = 0) -> RuntimeError:
    """The refusal a caller raises when `subprocess.TimeoutExpired` fires."""
    return RuntimeError(
        f"{what} did not finish within the derived budget "
        f"({describe(budget, size_bytes=size_bytes, pages=pages)})."
    )


def run(cmd: list[str], *, what: str, budget: float, size_bytes: int = 0, pages: int = 0,
        cwd: str | Path | None = None, text: bool = False) -> subprocess.CompletedProcess:
    """`subprocess.run` with a derived budget and an honest timeout message.

    stdin is isolated: a bundled tool must never inherit the RPC pipe (the
    distill review's finding, applied to every subprocess this module runs).
    `text` decodes stdout/stderr for the callers that read diagnostics as
    strings; the binary default is what a codec's stdout needs.
    """
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            timeout=budget,
            stdin=subprocess.DEVNULL,
            cwd=str(cwd) if cwd is not None else None,
            text=text,
        )
    except subprocess.TimeoutExpired:
        raise timed_out(what, budget, size_bytes=size_bytes, pages=pages) from None


def gs(cmd: list[str], *, what: str, path: str | Path, pages: int = 0,
       base: float = 300.0, per_mb: float = 12.0, per_page: float = 1.5,
       text: bool = True) -> subprocess.CompletedProcess:
    """One Ghostscript run over `path`, with the budget derived from it.

    The whole gs family shares this so the § 5.5 defect cannot be half-fixed:
    a fixed 300 s died on the 50 MB scan that issue #5 reported, and every
    sibling op carried the same constant. The coefficients are one set on
    purpose — a per-op table would drift, and the honest statement is "time
    proportional to the work", not "this op is special".

    **The floor is the family's OWN old constant, and that is deliberate.**
    The defect was "too little time for a big file", never "too much for a
    small one", so every input now gets AT LEAST what it got before and large
    ones get more. Lowering the floor would have converted a slow-but-passing
    small job into a new failure — fixing a timeout by introducing one.
    """
    size = 0
    try:
        size = Path(path).stat().st_size
    except OSError:
        pass
    allowed = derive(base=base, size_bytes=size, pages=pages, per_mb=per_mb, per_page=per_page)
    return run(cmd, what=what, budget=allowed, size_bytes=size, pages=pages, text=text)
