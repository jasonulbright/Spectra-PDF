"""A profile over a folder — the droplet.

A droplet is a profile plus a folder, and the machinery is the folder-sweep
family rather than a new one: the mirror-tree discipline, the per-file log, the
``dest_conflicts_with_source`` guard and ``move_processed_root`` all come from
``batch_ocr`` and ``guided_actions`` unchanged.

Two modes, and the difference is what may be written.

``check`` reads every PDF under the source BY PATH, writes nothing to any
source, and produces one report per file in the destination. ``in_place``
means nothing here and is refused rather than ignored.

``fix`` copies each file to its mirror path, applies the profile's fixups in
place on the COPY, and **re-checks**. The re-check is not optional: a fix run
whose report is the before state is a droplet that lies, so every row carries
both summaries and the fixups that actually ran. A file whose run fails
deletes its partial copy, so the mirror never holds a half-processed document.

The JSON report is what THIS module writes, in both modes. A run driven from
the app also writes the localized text and HTML beside it — those are emitted
renderer-side, in the UI locale, from the one report model the panel's export
uses. A command line has no locale, and a Python twin of those emitters would
be a second implementation of one model emitting English only.
"""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime
from pathlib import Path

import pikepdf

from engine.batch_ocr import (
    _format_duration,
    _format_timestamp,
    _list_sources,
    _move_file,
    _pad,
    dest_conflicts_with_source,
)
from engine.preflight import preflight
from engine.preflight_fixups import apply_fixups
from engine.preflight_profiles import resolve_profile

#: What a report artifact is called beside the document it is about. One
#: suffix, so a second run over the same tree replaces its own reports rather
#: than accumulating a generation of them.
REPORT_SUFFIX = ".preflight.json"

MODES = ("check", "fix")


def report_path_for(dest_root: Path, rel: str) -> Path:
    """Where one document's report lands: its own tree position, with the
    report suffix ADDED rather than replacing the extension — `invoice.pdf`
    and `invoice.json` in one folder must not collide."""
    return dest_root / f"{rel}{REPORT_SUFFIX}"


def _write_report(path: Path, report: dict) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return str(path)


def _readable_output(path: Path) -> bool:
    """The in-place gate: the processed staging must read back as a PDF with
    pages before it replaces anything."""
    try:
        with pikepdf.open(str(path)) as pdf:
            return len(pdf.pages) > 0
    except pikepdf.PasswordError:
        return True
    except Exception:  # noqa: BLE001 — any unreadable staging refuses the swap
        return False


def run_preflight_sweep(
    source: str,
    dest: str,
    profile=None,
    mode: str = "check",
    profile_path: str = "",
    write_log: bool = True,
    log_dir: str = "",
    in_place: bool = False,
    move_processed_root: str = "",
    gs_path: str = "",
    font_dir: str = "",
    tesseract_path: str = "",
    progress: bool = False,
) -> dict:
    """Measure — and optionally repair — every PDF under `source`.

    Args:
        source: The folder to sweep. Never written to, in either mode.
        dest: Where the reports (and, in fix mode, the fixed copies) land.
        profile: A shipped profile id, or the rule itself as an object.
        mode: `check` reports; `fix` repairs a copy and re-checks it.
        profile_path: A profile file. Exactly one of this and `profile`.
        write_log: Write a `preflight-run-*.log` beside the batch logs.
        log_dir: Where that log goes.
        in_place: Fix mode only — replace each original with its fixed
            version, staged beside it, verified, then swapped. The reports
            land beside the originals, because there is no mirror to put them
            in and a run with no record is a run nobody can audit.
        move_processed_root: The watched-folder shape (In → Out → Done):
            processed originals leave the intake so the next run never
            reprocesses them.
        gs_path: Ghostscript, for the checks and fixups that need it.
        font_dir: The vendored faces.
        tesseract_path: Passed through to the downsample fixup's `compress`.
        progress: Print one line per file.

    Returns the run report; every row carries its own before and after
    summaries and the fixups that ran.
    """
    if mode not in MODES:
        raise ValueError(
            f"A preflight sweep runs in {' or '.join(MODES)} mode, not {mode!r}."
        )
    source_path = Path(source).resolve()
    if not source_path.is_dir():
        raise ValueError(f"Source folder not found: {source}")

    if in_place:
        if mode == "check":
            raise ValueError(
                "A check writes nothing, so there is nothing for in-place mode to "
                "replace. Run it in fix mode, or give a destination for the reports."
            )
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
                "separate folder for the reports."
            )
    if move_processed_root:
        moved = Path(move_processed_root).resolve()
        if dest_conflicts_with_source(str(source_path), str(moved)):
            raise ValueError("The processed-originals folder must be outside the source folder.")
        if dest_conflicts_with_source(str(dest_path), str(moved)):
            raise ValueError(
                "The processed-originals folder must be outside the destination folder."
            )

    resolved = resolve_profile(profile, profile_path)
    if mode == "fix" and not resolved["fixups"]:
        raise ValueError(
            f"The preflight profile '{resolved['id']}' carries no fixups, so a fix "
            "run over this folder would repair nothing. Choose a profile that "
            "carries some, or run the sweep as a check."
        )

    started_at = datetime.now()
    entries, skipped_dirs = _list_sources(source_path, False)
    results: list[dict] = []
    for index, (abs_path, rel) in enumerate(entries):
        if progress:
            print(f"[{index + 1}/{len(entries)}] {rel}", flush=True)
        out_path = (abs_path.parent / f".{abs_path.name}.inplace.tmp") if in_place \
            else dest_path / rel
        report_path = report_path_for(
            source_path if in_place else dest_path,
            rel,
        )
        try:
            # The source is read at its own path and is never opened through
            # anything that could write it back — the batch rule, and the
            # reason a check run cannot touch the tree it measures.
            before = preflight(str(abs_path), profile=resolved, gs_path=gs_path,
                               font_dir=font_dir)
            row: dict = {"rel": rel, "status": "ok", "before": before["summary"]}
            if mode == "check":
                row["report"] = _write_report(report_path, before)
                row["after"] = before["summary"]
                results.append(row)
                continue

            out_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(abs_path, out_path)
            outcome = apply_fixups(
                str(out_path), str(out_path), profile=resolved, report=before,
                gs_path=gs_path, font_dir=font_dir, tesseract_path=tesseract_path,
            )
            if in_place:
                if not _readable_output(out_path):
                    raise ValueError(
                        "the processed copy could not be read back -- the original "
                        "was left untouched"
                    )
                os.replace(out_path, abs_path)
            row["applied"] = [entry["fixup"] for entry in outcome["applied"]]
            # A fixup that landed on part of what it was asked for is named
            # here as well as in `applied`: the id alone would read as a
            # repair the file does not carry.
            row["partial"] = [
                {"fixup": entry["fixup"], "partial": entry["partial"]}
                for entry in outcome["applied"] if entry.get("partial")
            ]
            row["refused"] = outcome["refused"]
            row["order"] = outcome["order"]
            # The re-check `apply_fixups` already ran IS the after state; a
            # second run over the same bytes would say the same thing at the
            # cost of another Ghostscript pass per page.
            row["after"] = outcome["after"]
            row["report"] = _write_report(report_path, outcome["report"])
            if move_processed_root:
                try:
                    row["moved_to"] = _move_file(abs_path, Path(move_processed_root) / rel)
                except Exception as exc:  # noqa: BLE001 — the fix stands; the move is reported
                    row["move_error"] = str(exc)
            results.append(row)
        except Exception as exc:  # noqa: BLE001 — per-file isolation is the contract
            if mode == "fix":
                # Never leave a half-processed document in the mirror.
                try:
                    if out_path.exists():
                        out_path.unlink()
                except OSError:
                    pass
            results.append({"rel": rel, "status": "error", "error": str(exc)})
    finished_at = datetime.now()

    ok = sum(1 for r in results if r["status"] == "ok")
    clean = sum(
        1 for r in results
        if r["status"] == "ok" and not r["after"]["failed"] and not r["after"]["needs_review"]
    )
    report = {
        "source": str(source_path),
        "dest": str(dest_path),
        "mode": mode,
        "profile": {
            "id": resolved["id"],
            "name": resolved.get("name", ""),
            "name_key": resolved.get("name_key", ""),
        },
        "total": len(results),
        "ok": ok,
        "failed": len(results) - ok,
        "clean": clean,
        "skipped_dirs": skipped_dirs,
        "results": results,
        "duration_ms": (finished_at - started_at).total_seconds() * 1000,
        "in_place": in_place,
    }
    if write_log and log_dir:
        try:
            report["log_path"] = _write_sweep_log(started_at, finished_at, report, Path(log_dir))
        except OSError as exc:
            report["log_error"] = str(exc)
    return report


def sweep_log_file_name(started_at: datetime) -> str:
    d = started_at
    return (
        f"preflight-run-{d.year}-{_pad(d.month)}-{_pad(d.day)}"
        f"_{_pad(d.hour)}{_pad(d.minute)}{_pad(d.second)}.log"
    )


def _write_sweep_log(started_at: datetime, finished_at: datetime, report: dict,
                     log_dir: Path) -> str:
    """The batch-OCR log's shape, for preflight sweeps. Named
    `preflight-run-*` — the retention sweep accepts a third prefix."""
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / sweep_log_file_name(started_at)
    profile = report["profile"]
    lines = [
        f"Preflight sweep — {profile['name'] or profile['id']} ({report['mode']})",
        f"Started:  {_format_timestamp(started_at)}",
        f"Finished: {_format_timestamp(finished_at)} ({_format_duration(report['duration_ms'])})",
        f"Source:   {report['source']}",
        f"Dest:     {report['dest']}",
        "",
    ]
    for row in report["results"]:
        tag = f"[{row['status']}]".ljust(10)
        if row["status"] != "ok":
            lines.append(f"{tag}{row['rel']} — {row['error']}")
            continue
        after = row["after"]
        verdict = (
            f"{after['passed']} passed · {after['failed']} failed · "
            f"{after['warnings']} to watch · {after['needs_review']} to review"
        )
        if row.get("applied"):
            verdict += f" — fixed: {', '.join(row['applied'])}"
        for entry in row.get("partial", []):
            left = ", ".join(str(item["item"]) for item in entry["partial"])
            verdict += f" — {entry['fixup']} left: {left}"
        for refusal in row.get("refused", []):
            verdict += f" — {refusal['fixup']} refused: {refusal['reason']}"
        lines.append(f"{tag}{row['rel']} — {verdict}")
    lines.append("")
    lines.append(
        f"{report['clean']} clean · {report['ok']} measured · "
        f"{report['failed']} failed · {report['total']} total"
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)
