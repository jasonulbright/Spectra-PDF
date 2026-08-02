"""Guided-actions folder runs (slice 3) — the Action Wizard's batch half.

Runs a validated step sequence over every PDF under a source folder,
mirroring the tree into a destination (the batch-OCR shape: sources are
never modified, outputs land at the same relative paths, one file's failure
never stops the run). Lives ENGINE-SIDE deliberately: one RPC per run, the
CLI arm gets it for free, and a scheduled run can fire with the app closed —
the same reasoning that put batch OCR here (Phase 12).

Steps arrive as DATA (saved actions, CLI JSON, scheduled profiles), so they
are validated against an explicit dispatch table — op names and parameter
keys both — never splatted blindly into calls. Tool paths (Ghostscript,
Tesseract, the font dir) are injected per-op from the run's own arguments.

Each file is copied to its mirror path first and the steps run IN-PLACE on
the copy — the engine-wide in-place support (engine/inplace.py) makes every
step atomic per write, and a failed step deletes the partial copy so the
mirror never holds half-processed files.
"""

from datetime import datetime
from pathlib import Path
import os
import shutil

import pikepdf

from engine.batch_ocr import (
    _format_duration,
    _format_timestamp,
    _list_sources,
    _move_file,
    _pad,
    dest_conflicts_with_source,
    ocr_file,
)
from engine.compress import compress
from engine.encrypt import encrypt
from engine.grayscale import grayscale
from engine.headers import add_header_footer
from engine.metadata import strip_metadata
from engine.pdfa import convert_pdfa
from engine.watermark import watermark

# op name -> (callable, allowed data params, needed tool-path params).
_STEPS: dict = {
    "compress": (compress, frozenset({"quality", "dpi"}), frozenset({"gs_path"})),
    "grayscale": (grayscale, frozenset(), frozenset({"gs_path"})),
    "convert_pdfa": (convert_pdfa, frozenset({"level"}), frozenset({"gs_path"})),
    "strip_metadata": (strip_metadata, frozenset(), frozenset()),
    "watermark": (
        watermark,
        frozenset({"text", "opacity", "angle", "color", "font_size", "layer"}),
        frozenset({"font_dir"}),
    ),
    "add_header_footer": (
        add_header_footer,
        # position/text is the GUI's saved/exported one-pair-per-step shape;
        # validate_steps folds it into placements so an exported action file
        # runs through the CLI without translation.
        frozenset(
            {
                "placements",
                "position",
                "text",
                "font_size",
                "margin",
                "color",
                "bates_start",
                "bates_digits",
            }
        ),
        frozenset({"font_dir"}),
    ),
    "ocr_file": (ocr_file, frozenset({"language"}), frozenset({"gs_path", "tesseract_path"})),
    "encrypt": (encrypt, frozenset({"user_password", "owner_password", "permissions"}), frozenset()),
}


def validate_steps(steps) -> list[dict]:
    """Shape-check a step list from untrusted data; returns the cleaned list."""
    if not isinstance(steps, list) or not steps:
        raise ValueError("the action has no steps")
    out: list[dict] = []
    for i, s in enumerate(steps):
        if not isinstance(s, dict) or not isinstance(s.get("op"), str):
            raise ValueError(f"step {i + 1} is not a step object")
        op = s["op"]
        if op not in _STEPS:
            raise ValueError(f"step {i + 1}: unknown operation {op!r}")
        params = s.get("params") or {}
        if not isinstance(params, dict):
            raise ValueError(f"step {i + 1} ({op}): params must be an object")
        allowed = _STEPS[op][1]
        unknown = sorted(set(params) - allowed)
        if unknown:
            raise ValueError(f"step {i + 1} ({op}): unknown parameter(s) {unknown}")
        params = dict(params)
        if op == "add_header_footer" and ("position" in params or "text" in params):
            if "placements" in params:
                raise ValueError(f"step {i + 1} ({op}): use placements or position/text, not both")
            if "position" not in params or "text" not in params:
                raise ValueError(f"step {i + 1} ({op}): position and text go together")
            params["placements"] = [
                {"position": str(params.pop("position")), "text": str(params.pop("text"))}
            ]
        if op == "encrypt":
            if i != len(steps) - 1:
                raise ValueError("encrypt must be the last step")
            u = str(params.get("user_password") or "").strip()
            o = str(params.get("owner_password") or "").strip()
            if not u and not o:
                raise ValueError("encrypt: set an open or an owner password")
        out.append({"op": op, "params": params})
    return out


def _apply_steps(path: str, steps: list[dict], tool_paths: dict) -> int:
    """Run every step in-place on `path`; returns the count applied."""
    for step in steps:
        fn, _allowed, needed = _STEPS[step["op"]]
        kwargs = dict(step["params"])
        for key in needed:
            kwargs[key] = tool_paths.get(key, "")
        fn(file=path, output=path, **kwargs)
    return len(steps)


def _readable_output(path: Path) -> bool:
    """The in-place gate: the processed staging must read back as a PDF with
    pages. An ENCRYPTED result counts as readable — a terminal encrypt step
    produces exactly that on purpose."""
    try:
        with pikepdf.open(str(path)) as pdf:
            return len(pdf.pages) > 0
    except pikepdf.PasswordError:
        return True
    except Exception:  # noqa: BLE001 — any unreadable staging refuses the swap
        return False


def run_action(
    source: str,
    dest: str,
    steps: list,
    action_name: str = "",
    gs_path: str = "",
    tesseract_path: str = "",
    font_dir: str = "",
    log_dir: str = "",
    write_log: bool = True,
    progress: bool = False,
    in_place: bool = False,
    move_processed_root: str = "",
) -> dict:
    """Run a step sequence over every PDF under `source`, mirroring into
    `dest` — or, with `in_place`, REPLACING each original with its processed
    version (O7 in-place batch mode; staged beside the original, verified,
    then swapped atomically). Returns the report; writes an
    `action-run-*.log` beside the batch-OCR logs when `write_log` and a
    `log_dir` are given."""
    source_path = Path(source).resolve()
    if not source_path.is_dir():
        raise ValueError(f"Source folder not found: {source}")
    if in_place:
        if dest:
            raise ValueError("In-place mode takes no destination -- the originals are replaced.")
        if move_processed_root:
            raise ValueError(
                "In-place mode cannot also move processed originals -- the processed "
                "file IS the original."
            )
        dest_path = source_path
    else:
        if not dest:
            raise ValueError("A destination folder is required unless running in place.")
        dest_path = Path(dest).resolve()
        if dest_conflicts_with_source(str(source_path), str(dest_path)):
            raise ValueError(
                "The destination must be outside the source folder -- choose a "
                "separate folder for the processed copies."
            )
    if move_processed_root:
        # The watched-folder shape (Distiller's In -> Out -> Done): processed
        # originals leave the intake so the next run never reprocesses them.
        moved = Path(move_processed_root).resolve()
        if dest_conflicts_with_source(str(source_path), str(moved)):
            raise ValueError("The processed-originals folder must be outside the source folder.")
        if dest_conflicts_with_source(str(dest_path), str(moved)):
            raise ValueError(
                "The processed-originals folder must be outside the destination folder."
            )
    clean_steps = validate_steps(steps)
    tool_paths = {"gs_path": gs_path, "tesseract_path": tesseract_path, "font_dir": font_dir}

    started_at = datetime.now()
    # Guided actions run PDF steps; image sources are the batch-OCR
    # sweep's own option (P3) and would have nothing to run against here.
    entries, skipped_dirs = _list_sources(source_path, False)
    results: list[dict] = []
    for index, (abs_path, rel) in enumerate(entries):
        if progress:
            print(f"[{index + 1}/{len(entries)}] {rel}", flush=True)
        # In place: stage beside the original, verify, then swap atomically —
        # a failed step or a bad write can never leave a broken original.
        out_path = (
            abs_path.parent / f".{abs_path.name}.inplace.tmp" if in_place else dest_path / rel
        )
        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(abs_path, out_path)
            applied = _apply_steps(str(out_path), clean_steps, tool_paths)
            if in_place:
                if not _readable_output(out_path):
                    raise ValueError(
                        "the processed copy could not be read back -- the original "
                        "was left untouched"
                    )
                os.replace(out_path, abs_path)
            row: dict = {"rel": rel, "status": "ok", "steps_applied": applied}
            if move_processed_root:
                # Only after the mirror copy fully processed — a failed file
                # stays in the intake for the next attempt.
                if not _readable_output(out_path):
                    raise ValueError(
                        "the processed copy could not be read back -- the original "
                        "stays in the source folder"
                    )
                try:
                    row["moved_to"] = _move_file(abs_path, Path(move_processed_root) / rel)
                except Exception as exc:  # noqa: BLE001 — the OCR result stands; the move is reported
                    row["move_error"] = str(exc)
            results.append(row)
        except Exception as exc:  # noqa: BLE001 — per-file isolation is the contract
            # Never leave a half-processed file in the mirror (or staging litter).
            try:
                if out_path.exists():
                    out_path.unlink()
            except OSError:
                pass
            results.append({"rel": rel, "status": "error", "error": str(exc)})
    finished_at = datetime.now()

    ok = sum(1 for r in results if r["status"] == "ok")
    failed = len(results) - ok
    report = {
        "action": action_name,
        "source": str(source_path),
        "dest": str(dest_path),
        "total": len(results),
        "ok": ok,
        "failed": failed,
        "skipped_dirs": skipped_dirs,
        "results": results,
        "duration_ms": (finished_at - started_at).total_seconds() * 1000,
        "steps": [s["op"] for s in clean_steps],
        "in_place": in_place,
    }
    if write_log and log_dir:
        try:
            report["log_path"] = _write_action_log(
                started_at, finished_at, report, Path(log_dir)
            )
        except OSError as exc:
            report["log_error"] = str(exc)
    return report


def action_log_file_name(started_at: datetime) -> str:
    d = started_at
    return (
        f"action-run-{d.year}-{_pad(d.month)}-{_pad(d.day)}"
        f"_{_pad(d.hour)}{_pad(d.minute)}{_pad(d.second)}.log"
    )


def _write_action_log(
    started_at: datetime, finished_at: datetime, report: dict, log_dir: Path
) -> str:
    """The batch-OCR log's shape, for guided-action runs: header, one line
    per file, summary. Named `action-run-*` — the retention sweep accepts
    both prefixes."""
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / action_log_file_name(started_at)
    lines = [
        f"Guided action run — {report['action'] or '(unnamed)'}",
        f"Started:  {_format_timestamp(started_at)}",
        f"Finished: {_format_timestamp(finished_at)} ({_format_duration(report['duration_ms'])})",
        f"Steps:    {' -> '.join(report['steps'])}",
        f"Source:   {report['source']}",
        f"Dest:     {report['dest']}",
        "",
    ]
    for r in report["results"]:
        tag = f"[{r['status']}]".ljust(10)
        if r["status"] == "ok":
            n = r["steps_applied"]
            lines.append(f"{tag}{r['rel']} — {n} step{'' if n == 1 else 's'} applied")
        else:
            lines.append(f"{tag}{r['rel']} — {r['error']}")
    lines.append("")
    lines.append(f"{report['ok']} processed · {report['failed']} failed · {report['total']} total")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)
