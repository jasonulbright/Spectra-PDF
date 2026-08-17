"""Guided-actions folder runs — the Action Wizard's batch half.

Runs a validated step sequence over every PDF under a source folder,
mirroring the tree into a destination (the batch-OCR shape: sources are
never modified, outputs land at the same relative paths, one file's failure
never stops the run). Lives ENGINE-SIDE deliberately: one RPC per run, the
CLI arm gets it for free, and a scheduled run can fire with the app closed —
the same reasoning that put batch OCR here.

Steps arrive as DATA (saved actions, CLI JSON, scheduled profiles), so they
are validated against an explicit dispatch table — op names and parameter
keys both — never splatted blindly into calls. Tool paths (Ghostscript,
Tesseract, the font dir) are injected per-op from the run's own arguments.

Each file is copied to its mirror path first and the steps run IN-PLACE on
the copy — the engine-wide in-place support (engine/inplace.py) makes every
step atomic per write, and a failed step deletes the partial copy so the
mirror never holds half-processed files.

**One step breaks that shape deliberately: `create_pdf`.** It
PRODUCES the mirrored document instead of transforming a copy of the source,
so an action can start "convert every Office file that lands in this folder"
and then compress, stamp and OCR the result. Because it produces rather than
transforms it is only valid FIRST (`validate_steps` refuses it anywhere else,
by name), it is incompatible with in-place mode, and its presence widens what
the run walks from PDFs to the whole Create PDF accepted set.
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
from engine.create_pdf import accepted_suffixes as create_pdf_suffixes
from engine.enhance_scan import enhance_scan
from engine.create_pdf import create_pdf
from engine.create_pdf_folders import create_pdf_folders, list_source_folders
from engine.encrypt import encrypt
from engine.image_export import export_images, image_extension
from engine.office_export import export_document, target_extension
from engine.grayscale import grayscale
from engine.headers import add_header_footer
from engine.metadata import strip_metadata
from engine.optimize import optimize
from engine.pdfa import convert_pdfa
from engine.preflight_fixups import apply_fixups
from engine.sanitize import sanitize_pdf
from engine.derived_nav import outline_from_structure
from engine.form_prepare import prepare_form_fields
from engine.links import create_links_from_urls
from engine.search_redact import search_and_redact
from engine.watermark import watermark

# op name -> (callable, allowed data params, needed tool-path params).
_STEPS: dict = {
    "compress": (
        compress,
        frozenset(
            {
                "quality",
                "dpi",
                # `quality="mrc"` routes the SAME step to the MRC pass, so
                # watched folders and scheduled runs get it with no new op.
                "mrc_preset",
                "mrc_mask_codec",
                "mrc_bg_div",
                "mrc_fg_div",
                "mrc_pdfa_safe",
                # Slice E: the quality gate is a real switch on every surface
                # `compress` reaches, watched folders and scheduled runs
                # included — an unattended run is exactly where a silently
                # degraded page would go unnoticed.
                "mrc_verify_text",
                "mrc_lang",
            }
        ),
        frozenset({"gs_path", "jbig2_path", "tesseract_path"}),
    ),
    # The pair the single-document panel already offers as one flow ("then
    # optimize"). Lossless and Ghostscript-free, so it composes after any
    # step; running it LAST is what leaves the object streams the earlier
    # steps rewrote in their smallest form.
    "optimize": (
        optimize,
        frozenset({"linearize", "strip_metadata", "compress_streams"}),
        frozenset(),
    ),
    "grayscale": (grayscale, frozenset(), frozenset({"gs_path"})),
    "convert_pdfa": (convert_pdfa, frozenset({"level"}), frozenset({"gs_path"})),
    "strip_metadata": (strip_metadata, frozenset(), frozenset()),
    # Authoring navigation over a whole tree is where these two stop being a
    # nicety: nobody links the addresses in 400 documents by hand, and nobody
    # transcribes the headings of a folder of tagged reports.
    "links_from_urls": (
        create_links_from_urls,
        frozenset({"pages", "emails", "skip_existing"}),
        frozenset(),
    ),
    "outline_from_structure": (
        outline_from_structure,
        frozenset({"mode", "max_level", "tag_if_untagged"}),
        frozenset(),
    ),
    # An unattended run is where "clean every document leaving this folder"
    # actually lives. The category list is a run parameter, never a default:
    # the step removes exactly what the action names.
    "sanitize": (
        sanitize_pdf,
        frozenset({"categories", "form_fields_mode", "hidden_text_ocr", "all_removable"}),
        frozenset(),
    ),
    # No review step exists in a folder run, so this redacts every hit the
    # request finds. `marks_only` is the reviewable half: it writes /Redact
    # annotations and removes nothing.
    "search_redact": (
        search_and_redact,
        frozenset(
            {
                "query",
                "terms",
                "patterns",
                "pages",
                "regex",
                "case_sensitive",
                "whole_word",
                "expand",
                "max_hits",
                "marks_only",
                "allow_signed",
                "properties",
            }
        ),
        frozenset({"font_dir"}),
    ),
    "watermark": (
        watermark,
        frozenset(
            {
                "text",
                "image",
                "pdf_source",
                "pdf_page",
                "opacity",
                "angle",
                "color",
                "font_size",
                "layer",
                "scale",
                "position",
                "margin",
                "tile",
                "tile_gap",
                "writing_mode",
            }
        ),
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
    # Deskew, despeckle, whiten and re-orient the scanned pages. Its ORDER
    # against the other two scan steps is enforced in validate_steps.
    "enhance_scan": (
        enhance_scan,
        frozenset(
            {
                "pages",
                "deskew",
                "despeckle",
                "background",
                "orientation",
                "max_skew_deg",
                "min_skew_deg",
                "speck_size_in",
                "speck_gap_in",
                "background_strength",
                "osd_confidence",
                "jpeg_quality",
            }
        ),
        frozenset({"gs_path", "tesseract_path"}),
    ),
    # No review step exists in a folder run, so this creates every field the
    # detector offers. `kinds` is the only narrowing available without a
    # reviewer.
    "prepare_forms": (
        prepare_form_fields,
        frozenset({"pages", "scan", "lang", "max_candidates", "kinds", "allow_signed"}),
        frozenset({"gs_path", "tesseract_path", "font_dir"}),
    ),
    # A print profile inside a longer authored action ("convert every Office
    # file that lands here, then bring it up to the house press rule, then
    # stamp it"). It calls the SAME `apply_fixups` door the panel button, the
    # command line and the droplet call, so what repairing a finding means is
    # not answered a second time inside this dispatch table.
    #
    # Fix only, deliberately: every step here TRANSFORMS the document it is
    # handed, and a check produces a report an action has nowhere to put. The
    # droplet is where a check over a folder lives.
    "preflight": (
        apply_fixups,
        frozenset({"profile", "profile_path", "checks"}),
        frozenset({"gs_path", "font_dir", "tesseract_path"}),
    ),
    "encrypt": (encrypt, frozenset({"user_password", "owner_password", "permissions"}), frozenset()),
    # The one step that PRODUCES the document instead of
    # transforming it, which is why it is handled by `run_action` directly
    # rather than by `_apply_steps`: every other step is `fn(file=p,
    # output=p)`, and `create_pdf` refuses to write over its own source (the
    # identity guard). Its presence also widens what the run WALKS — a folder
    # of .docx files is the whole point of the step.
    "create_pdf": (
        create_pdf,
        frozenset(
            {
                "page_size",
                "orientation",
                "margin_pt",
                "image_dpi_default",
                "distill_preset",
            }
        ),
        frozenset({"gs_path", "soffice_path"}),
    ),
    # The second source step, and the one that changes the run's UNIT: a
    # folder of pages is one document, so the run walks DIRECTORIES rather
    # than files. Everything after it runs on the assembled PDF, which is what
    # makes "one PDF per scan folder, then straighten it, then make it
    # searchable" a single unattended job.
    "create_pdf_folders": (
        create_pdf_folders,
        frozenset(
            {
                "sources",
                "include_subfolders",
                "page_size",
                "orientation",
                "margin_pt",
                "image_dpi_default",
                "distill_preset",
            }
        ),
        frozenset({"gs_path", "soffice_path"}),
    ),
    # The two steps that CONSUME the document instead of transforming it. They
    # write a different kind of file at a different extension, so nothing can
    # follow them and `run_action` handles them directly rather than through
    # `_apply_steps` (every other step is `fn(file=p, output=p)`).
    "export_document": (
        export_document,
        frozenset(
            {
                "fmt",
                "pages",
                "layout",
                "page_breaks",
                "sheet_per",
                "include_untabled",
                "slide_size",
            }
        ),
        frozenset({"gs_path", "soffice_path"}),
    ),
    "export_images": (
        export_images,
        frozenset({"fmt", "dpi", "pages", "gray", "quality"}),
        frozenset({"gs_path"}),
    ),
}

# The steps that end a sequence by producing a non-PDF. Named once: the
# validation, the in-place refusal and the output naming all ask the same
# question.
EXPORT_STEPS = ("export_document", "export_images")

# Everything a create_pdf-led run walks BEYOND the PDFs `_list_sources`
# always takes. Derived from the engine's own accepted set, never re-listed —
# a suffix added to one arm must not need remembering here.
CREATE_PDF_EXTRA_SUFFIXES = tuple(s for s in create_pdf_suffixes() if s != ".pdf")


# The steps that PRODUCE the document the rest of the action works on. Named
# once: the ordering rule, the in-place refusal, the open-document refusal and
# what the run walks all ask the same question.
SOURCE_STEPS = ("create_pdf", "create_pdf_folders")


def creates_its_own_source(steps) -> bool:
    """Does this (validated) step list START by creating the document?"""
    return bool(steps) and steps[0]["op"] in SOURCE_STEPS


def groups_by_folder(steps) -> bool:
    """Is this run's unit a DIRECTORY rather than a file?

    True only when the folder-grouping source step leads, which is the one
    shape where a run's rows are folders and its outputs are named after them.
    """
    return bool(steps) and steps[0]["op"] == "create_pdf_folders"


def exports_its_result(steps) -> bool:
    """Does this (validated) step list END by exporting to another format?"""
    return bool(steps) and steps[-1]["op"] in EXPORT_STEPS


def _export_out_path(dest_root: Path, rel: str, step: dict) -> Path:
    """The mirror path a terminal export writes: the source's own tree position
    with the target's extension in place of the PDF's."""
    if step["op"] == "export_images":
        ext = image_extension(step["params"].get("fmt", "png"))
    else:
        ext = target_extension(step["params"].get("fmt", "docx"))
    stem = rel[:-4] if rel.lower().endswith(".pdf") else rel
    return dest_root / f"{stem}{ext}"


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
        if op == "watermark":
            # Exactly one source, checked HERE as well as in the editor: an
            # action file reaches this validator without passing through the
            # editor at all, and `watermark` itself would refuse a pair only
            # after the run had already started.
            sources = [
                k for k in ("text", "image", "pdf_source") if str(params.get(k, "")).strip()
            ]
            if len(sources) != 1:
                raise ValueError(
                    f"step {i + 1} ({op}): set text, image or pdf_source, exactly one of them"
                )
        if op == "compress" and str(params.get("quality", "")).strip().lower() == "mrc":
            # ORDER, enforced rather than documented: recognition
            # rasterizes from the page, so OCR after MRC would read the
            # RECONSTRUCTION instead of the scan it was meant to read.
            later_ocr = any(
                isinstance(s2, dict) and s2.get("op") == "ocr_file"
                for s2 in steps[i + 1 :]
            )
            if later_ocr:
                raise ValueError(
                    "MRC compression must come after OCR — OCR reads the page image, "
                    "and MRC replaces it"
                )
        if op == "enhance_scan":
            # ORDER, enforced rather than documented (the MRC-after-OCR
            # precedent, read the other way round): enhancement rewrites the
            # page IMAGE, so everything that READS that image has to come
            # after it.
            for prior in steps[:i]:
                if not isinstance(prior, dict):
                    continue
                if prior.get("op") == "ocr_file":
                    raise ValueError(
                        "scan enhancement must come before OCR — enhancement moves the "
                        "ink, and an OCR layer written first would sit over where it "
                        "used to be"
                    )
                prior_params = prior.get("params") or {}
                if prior.get("op") == "compress" and str(
                    prior_params.get("quality", "") if isinstance(prior_params, dict) else ""
                ).strip().lower() == "mrc":
                    raise ValueError(
                        "scan enhancement must come before MRC compression — MRC "
                        "replaces the page image with reconstructed layers, and "
                        "enhancing those enhances a reconstruction"
                    )
        if op in EXPORT_STEPS:
            # The target names the output's extension, so a run cannot be
            # planned without it. Refused at validation rather than per file:
            # a missing format is a broken action, not a broken document.
            fmt = str(params.get("fmt") or "").strip()
            if not fmt:
                raise ValueError(f"step {i + 1} ({op}): name the export format")
            if op == "export_images":
                image_extension(fmt)
            else:
                target_extension(fmt)
            params["fmt"] = fmt
        if op in EXPORT_STEPS and i != len(steps) - 1:
            # ORDER, enforced rather than documented (the create_pdf
            # precedent): an export CONSUMES the document and writes another
            # kind of file, so a step after it would be handed something that
            # is no longer a PDF.
            raise ValueError(
                f"{op} must be the last step -- it writes a different kind of "
                "file, and nothing can run on that"
            )
        if op in SOURCE_STEPS and i != 0:
            # ORDER, enforced rather than documented (the MRC-after-OCR
            # precedent): a source step PRODUCES the document the rest of the
            # action operates on, so anywhere but first it would convert a
            # file the earlier steps had already rewritten.
            raise ValueError(
                f"{op} must be the first step — it produces the document "
                "the rest of the action works on"
            )
        if op == "create_pdf_folders" and any(
            isinstance(s2, dict) and s2.get("op") == "create_pdf" for s2 in steps
        ):
            # Two source steps would each claim to produce the document, and
            # only one of them can name what the run walks.
            raise ValueError(
                "an action produces its document once — use create_pdf or "
                "create_pdf_folders, not both"
            )
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


def _run_export(source: Path, output: Path, step: dict, tool_paths: dict) -> None:
    """The terminal export: `fn(file=source, output=output)` across a change of
    format, which is why it cannot go through `_apply_steps`."""
    fn, _allowed, needed = _STEPS[step["op"]]
    kwargs = dict(step["params"])
    for key in needed:
        kwargs[key] = tool_paths.get(key, "")
    fn(file=str(source), output=str(output), **kwargs)


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
    soffice_path: str = "",
    font_dir: str = "",
    log_dir: str = "",
    write_log: bool = True,
    progress: bool = False,
    in_place: bool = False,
    move_processed_root: str = "",
) -> dict:
    """Run a step sequence over every PDF under `source`, mirroring into
    `dest` — or, with `in_place`, REPLACING each original with its processed
    version (in-place batch mode; staged beside the original, verified,
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
        # The watched-folder shape (In -> Out -> Done): processed
        # originals leave the intake so the next run never reprocesses them.
        moved = Path(move_processed_root).resolve()
        if dest_conflicts_with_source(str(source_path), str(moved)):
            raise ValueError("The processed-originals folder must be outside the source folder.")
        if dest_conflicts_with_source(str(dest_path), str(moved)):
            raise ValueError(
                "The processed-originals folder must be outside the destination folder."
            )
    clean_steps = validate_steps(steps)
    creates = creates_its_own_source(clean_steps)
    exports = exports_its_result(clean_steps)
    if exports and in_place:
        # An export writes a different kind of file. Replacing `report.pdf`
        # with a spreadsheet that is still called `report.pdf` is a destroyed
        # source under a misleading name, not an in-place edit.
        raise ValueError(
            "In-place mode cannot end with an export -- the exported document is a "
            "new file, not a replacement for its source."
        )
    if creates and in_place:
        # The converted document is a NEW file — replacing `report.docx` with
        # a PDF that is still called `report.docx` is not an in-place edit,
        # it is a destroyed source with a misleading name.
        raise ValueError(
            "In-place mode cannot start with a step that creates the document -- the "
            "converted document is a new file, not a replacement for its source."
        )
    grouping = groups_by_folder(clean_steps)
    if grouping and move_processed_root:
        # A folder run's unit is a DIRECTORY of pages, and moving processed
        # originals means moving that whole directory -- a different operation
        # from the per-file move this option performs. Refused rather than
        # silently moving only part of what was consumed.
        raise ValueError(
            "A one-PDF-per-folder run cannot move processed originals -- its "
            "sources are whole folders, not single files."
        )
    tool_paths = {
        "gs_path": gs_path,
        "tesseract_path": tesseract_path,
        "soffice_path": soffice_path,
        "font_dir": font_dir,
    }

    started_at = datetime.now()
    # What one ROW of this run is. Ordinarily a file; with the folder-grouping
    # source step, a directory of pages that becomes one document — so the
    # listing, the row key and the output name all change together rather than
    # a file walk being reinterpreted downstream.
    group_members: dict[str, list[str]] = {}
    if grouping:
        listing = list_source_folders(
            str(source_path),
            sources=str(clean_steps[0]["params"].get("sources", "images")),
            include_subfolders=bool(clean_steps[0]["params"].get("include_subfolders", True)),
        )
        skipped_dirs = listing["skipped_dirs"]
        entries = []
        for group in listing["groups"]:
            entries.append((Path(group["files"][0]).parent, group["output"]))
            group_members[group["output"]] = group["files"]
    else:
        # Guided actions run PDF steps; image sources are the batch-OCR
        # sweep's own option and would have nothing to run against here —
        # UNLESS the action starts by CREATING the document, which is exactly
        # the "convert every Office file that lands in this folder" run.
        entries, skipped_dirs = _list_sources(
            source_path, False, CREATE_PDF_EXTRA_SUFFIXES if creates else ()
        )
    results: list[dict] = []
    # A terminal export CONSUMES the document; everything before it transforms
    # a copy of it, which is the shape `_apply_steps` speaks.
    transform_steps = clean_steps[:-1] if exports else clean_steps
    # An export-only action never stages: reading each source directly is the
    # difference between one pass and a full copy of every file in the tree.
    stages = bool(transform_steps)
    for index, (abs_path, rel) in enumerate(entries):
        if progress:
            print(f"[{index + 1}/{len(entries)}] {rel}", flush=True)
        # In place: stage beside the original, verify, then swap atomically —
        # a failed step or a bad write can never leave a broken original.
        if in_place:
            out_path = abs_path.parent / f".{abs_path.name}.inplace.tmp"
        elif creates and not rel.lower().endswith(".pdf"):
            # The mirrored name GAINS `.pdf` rather than replacing the
            # extension — `invoice.docx` and `invoice.pdf` in one folder must
            # not collide, and the original name stays legible (the
            # image-source rule, met at a second surface).
            out_path = dest_path / f"{rel}.pdf"
        else:
            out_path = dest_path / rel
        export_path = _export_out_path(dest_path, rel, clean_steps[-1]) if exports else None
        try:
            out_path.parent.mkdir(parents=True, exist_ok=True)
            if creates:
                if grouping:
                    # The grouping parameters describe the WALK, which already
                    # happened; `create_pdf` takes neither, and passing them
                    # would refuse the whole run on an unexpected keyword.
                    build_params = {
                        k: v
                        for k, v in clean_steps[0]["params"].items()
                        if k not in ("sources", "include_subfolders")
                    }
                    members = [{"path": p} for p in group_members[rel]]
                else:
                    build_params = dict(clean_steps[0]["params"])
                    members = [{"path": str(abs_path)}]
                create_pdf(
                    members,
                    str(out_path),
                    gs_path=gs_path or "gs",
                    soffice_path=soffice_path,
                    **build_params,
                )
                applied = 1 + _apply_steps(str(out_path), transform_steps[1:], tool_paths)
            elif stages:
                shutil.copy2(abs_path, out_path)
                applied = _apply_steps(str(out_path), transform_steps, tool_paths)
            else:
                applied = 0
            if in_place:
                if not _readable_output(out_path):
                    raise ValueError(
                        "the processed copy could not be read back -- the original "
                        "was left untouched"
                    )
                os.replace(out_path, abs_path)
            row: dict = {"rel": rel, "status": "ok", "steps_applied": applied}
            # The move gate reads the PROCESSED copy, so it is answered before a
            # terminal export consumes and removes it.
            processed_readable = (
                _readable_output(out_path) if move_processed_root and stages else True
            )
            if exports:
                export_path.parent.mkdir(parents=True, exist_ok=True)
                _run_export(
                    out_path if stages else abs_path, export_path, clean_steps[-1], tool_paths
                )
                if stages:
                    # The mirror carries the exported document, not the PDF the
                    # steps ran on: leaving both would double the tree and make
                    # "what did this run produce" ambiguous.
                    out_path.unlink()
                applied += 1
                row["steps_applied"] = applied
                row["output"] = str(export_path)
            if move_processed_root:
                # Only after the mirror copy fully processed — a failed file
                # stays in the intake for the next attempt.
                if not processed_readable:
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
            # Never leave a half-processed file in the mirror (or staging litter),
            # and never leave the partial output of an export that failed.
            for litter in (out_path if stages or in_place else None, export_path):
                if litter is None:
                    continue
                try:
                    if litter.exists():
                        litter.unlink()
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
