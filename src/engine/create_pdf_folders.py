"""One PDF per folder — the directory-grouping walk over Create PDF's door.

`create_pdf` takes an ordered source list and writes ONE output; the batch arm
mirrors one output per source FILE. Neither composes into "walk this tree and
make one PDF out of each folder of scans", which is the shape a flatbed
produces: a folder per document, a file per page.

What is missing is only the aggregation, so that is all this adds. The
conversion, the page-size handling and the /AcroForm, outline and structure
carries stay `create_pdf`'s — one member list per directory, in page order.

The grouping is here rather than in the renderer or in Rust because it has to
answer to exactly one description. The GUI enumerates through
`list_source_folders` and then drives `create_pdf` per group so it can show
per-folder progress and stop; the CLI, a guided action and a scheduled run go
through `create_pdf_folders`, which walks the same function. A second copy of
the ordering rule is a run whose preview and whose output disagree about which
page comes first.
"""

import os
import re
from datetime import datetime
from pathlib import Path

from engine.batch_ocr import _format_duration, _format_timestamp, _pad, dest_conflicts_with_source
from engine.create_pdf import IMAGE_SUFFIXES, accepted_suffixes, create_pdf

# What a folder run takes. `images` is the default because a folder of scans is
# the job; `all` opens it to everything Create PDF converts, for a tree of
# per-document folders holding a mix.
SOURCE_SETS = ("images", "all")

_DIGITS = re.compile(r"(\d+)")


def natural_key(name: str) -> tuple:
    """Sort key putting `page2` before `page10`.

    Plain lexicographic order is wrong for the primary case and wrong
    silently: a folder of `page1 … page10` assembles with page 10 second, and
    nothing about the resulting PDF says the order was chosen rather than
    observed. Digit runs therefore compare as NUMBERS.

    Case is folded first (the platform's own file names are case-insensitive)
    with the raw text as the tiebreak, so two names differing only in case
    still have one stable order.
    """
    parts = _DIGITS.split(name)
    key: list = []
    for index, part in enumerate(parts):
        if index % 2:
            # A digit run. The width rides along so `01` and `1` — equal as
            # numbers — still order deterministically.
            key.append((0, int(part), len(part)))
        elif part:
            key.append((1, part.casefold(), part))
    return (tuple(key), name)


def _wanted_suffixes(sources: str) -> tuple[str, ...]:
    if sources not in SOURCE_SETS:
        raise ValueError(f"unknown source set {sources!r} ({', '.join(SOURCE_SETS)})")
    return IMAGE_SUFFIXES if sources == "images" else accepted_suffixes()


def _output_rel(root: Path, folder: Path) -> str:
    """Where a folder's PDF lands, relative to the destination root.

    A folder at `a/b` becomes `a/b.pdf` — the file takes the FOLDER'S place in
    the mirrored tree rather than sitting inside a recreated copy of it, which
    is what "one PDF per folder" means to someone looking at the result. The
    source root itself becomes a file named after it.
    """
    if folder == root:
        return f"{root.name}.pdf"
    return f"{folder.relative_to(root)}.pdf"


def list_source_folders(
    source: str, sources: str = "images", include_subfolders: bool = True
) -> dict:
    """Every folder under `source` that would produce a PDF, with its members.

    Read-only. Returned in the order the run will process them, each group's
    members in the order they will be assembled, so a caller previewing this
    listing is looking at the run itself rather than at a description of it.

    A folder is grouped by the IMMEDIATE parent of its files: a directory
    holding both pages of its own and subfolders of pages produces its own PDF
    from its own pages only. A folder with no accepted file produces nothing
    and is not an error — an empty intermediate directory is how a tree is
    shaped, not a failure.
    """
    root = Path(source).resolve()
    if not root.is_dir():
        raise ValueError(f"Source folder not found: {source}")
    wanted = _wanted_suffixes(sources)
    groups: list[dict] = []
    skipped_dirs: list[str] = []

    def collect(directory: Path) -> None:
        try:
            names = [e.name for e in os.scandir(directory) if e.is_file()]
        except OSError as exc:
            skipped_dirs.append(str(exc))
            return
        members = [n for n in names if n.lower().endswith(wanted)]
        if not members:
            return
        members.sort(key=natural_key)
        groups.append(
            {
                "rel": "" if directory == root else str(directory.relative_to(root)),
                "name": directory.name,
                "output": _output_rel(root, directory),
                "files": [str(directory / n) for n in members],
                "count": len(members),
            }
        )

    collect(root)
    if include_subfolders:
        for dirpath, dirnames, _files in os.walk(
            root, onerror=lambda e: skipped_dirs.append(str(e))
        ):
            # Deterministic descent, by the same rule the members use.
            dirnames.sort(key=natural_key)
            for name in dirnames:
                collect(Path(dirpath) / name)
    return {"source": str(root), "groups": groups, "skipped_dirs": skipped_dirs}


def create_pdf_folders(
    source: str,
    dest: str,
    sources: str = "images",
    include_subfolders: bool = True,
    page_size: str = "auto",
    orientation: str = "auto",
    margin_pt: float = 0.0,
    image_dpi_default: float = 200.0,
    distill_preset: str = "printer",
    gs_path: str = "gs",
    soffice_path: str = "",
    log_dir: str = "",
    write_log: bool = True,
    progress: bool = False,
) -> dict:
    """Build one PDF per folder under `source`, mirrored into `dest`.

    Per-folder isolation is the contract, as it is for every other folder run:
    a directory whose files cannot be converted is reported and the run
    carries on. A partially written output is removed, so the destination
    never holds half a document.

    Sources are never modified. The destination must lie outside the source
    tree — otherwise the run's own outputs join what it walks.
    """
    root = Path(source).resolve()
    listing = list_source_folders(source, sources=sources, include_subfolders=include_subfolders)
    if not dest:
        raise ValueError("A destination folder is required.")
    dest_path = Path(dest).resolve()
    if dest_conflicts_with_source(str(root), str(dest_path)):
        raise ValueError(
            "The destination must be outside the source folder -- choose a "
            "separate folder for the assembled documents."
        )

    started_at = datetime.now()
    results: list[dict] = []
    for index, group in enumerate(listing["groups"]):
        if progress:
            print(f"[{index + 1}/{len(listing['groups'])}] {group['output']}", flush=True)
        out_path = dest_path / group["output"]
        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            built = create_pdf(
                [{"path": p} for p in group["files"]],
                str(out_path),
                page_size=page_size,
                orientation=orientation,
                margin_pt=margin_pt,
                image_dpi_default=image_dpi_default,
                distill_preset=distill_preset,
                gs_path=gs_path or "gs",
                soffice_path=soffice_path,
                # One unreadable page must not cost the other forty. The
                # skipped member is reported on its own row, never dropped.
                on_unsupported="skip",
            )
            row: dict = {
                "rel": group["rel"],
                "output": group["output"],
                "status": "ok",
                "files": group["count"],
                "pages": built["pages"],
            }
            if built.get("warnings"):
                row["warnings"] = built["warnings"]
            results.append(row)
        except Exception as exc:  # noqa: BLE001 — per-folder isolation is the contract
            try:
                if out_path.exists():
                    out_path.unlink()
            except OSError:
                pass
            results.append(
                {
                    "rel": group["rel"],
                    "output": group["output"],
                    "status": "error",
                    "files": group["count"],
                    "error": str(exc),
                }
            )
    finished_at = datetime.now()

    ok = sum(1 for r in results if r["status"] == "ok")
    report = {
        "source": str(root),
        "dest": str(dest_path),
        "total": len(results),
        "ok": ok,
        "failed": len(results) - ok,
        "skipped_dirs": listing["skipped_dirs"],
        "results": results,
        "duration_ms": (finished_at - started_at).total_seconds() * 1000,
    }
    if write_log and log_dir:
        try:
            report["log_path"] = _write_log(started_at, finished_at, report, Path(log_dir))
        except OSError as exc:
            report["log_error"] = str(exc)
    return report


def folder_log_file_name(started_at: datetime) -> str:
    d = started_at
    return (
        f"create-pdf-folders-{d.year}-{_pad(d.month)}-{_pad(d.day)}"
        f"_{_pad(d.hour)}{_pad(d.minute)}{_pad(d.second)}.log"
    )


def _write_log(
    started_at: datetime, finished_at: datetime, report: dict, log_dir: Path
) -> str:
    """The batch-OCR log's shape: header, one line per folder, summary."""
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / folder_log_file_name(started_at)
    lines = [
        "Create PDF per folder",
        f"Started:  {_format_timestamp(started_at)}",
        f"Finished: {_format_timestamp(finished_at)} ({_format_duration(report['duration_ms'])})",
        f"Source:   {report['source']}",
        f"Dest:     {report['dest']}",
        "",
    ]
    for r in report["results"]:
        tag = f"[{r['status']}]".ljust(10)
        if r["status"] == "ok":
            lines.append(
                f"{tag}{r['output']} — {r['files']} file(s), {r['pages']} page(s)"
            )
            for warning in r.get("warnings", []):
                lines.append(f"{' ' * 10}  ! {warning}")
        else:
            lines.append(f"{tag}{r['output']} — {r['error']}")
    lines.append("")
    lines.append(
        f"{report['ok']} built · {report['failed']} failed · {report['total']} folder(s)"
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)
