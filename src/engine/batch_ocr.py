"""Headless batch OCR -- the folder-mirror driver, engine side.

This is the port of `src/renderer/lib/batch-ocr.ts`. It exists so a batch can
run with NO WINDOW: that is what makes the CLI arm possible, and the CLI arm is
what makes scheduling possible. The GUI keeps its own
TypeScript driver for the interactive case; this one serves the CLI and every
scheduled run.

**The two must agree.** Where they overlap, the behaviour here is deliberately
the same and the reasons are the same:

  - classification is ocr / copied / skipped, per file, and one file's failure
    never stops the run;
  - a page "needs OCR" only when it has fewer than 16 real glyphs AND the page
    actually paints a raster image -- a genuinely blank page is not a scan;
  - the destination may not be, or be inside, the source;
  - the moved/error folders are OPT-IN, the output is VERIFIED before any
    original moves, and a failed move never changes a file's status;
  - the log is byte-compatible with `lib/batch-log.ts`, because a run logged
    one way by the GUI and another way by the scheduler would make the audit
    trail useless exactly where it matters most.
"""

import os
import re
import shutil
import stat
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

import pikepdf
from engine.ipc import RequestCancelled, cancelled, raise_if_cancelled
from engine.credentials import open_pdf

from engine.compress import compress
# ONE image wrap for the whole product. batch OCR was where it lived and
# where its multi-frame data loss hid; it is now a first-class engine arm and
# this module is a consumer like any other.
from engine.create_pdf import IMAGE_SUFFIXES, image_to_pdf
from engine.enhance_scan import enhance_scan
from engine.inplace import (
    finish_staged,
    is_spectra_temp_name,
    publish_copy,
    reclaim_stale_stages,
    scratch_path,
    write_text_staged,
)
from engine.form_detect import _crop_box, _display_rect_to_pdf, _page_rotate
from engine.ocr_layer import apply_ocr_layer
from engine.recognize import recognize
from engine.repair import repair
from engine.widget_faces import regenerate_appearances_file

# Mirrors search/extract.ts MIN_TEXT_CHARS -- the GUI and the CLI must not
# disagree about whether a page is a scan.
MIN_TEXT_CHARS = 16


def _mrc_step(
    source: Path,
    dest: Path,
    preset: str,
    verify_text: bool,
    lang: str,
    gs_path: str,
    tesseract_path: str,
    font_dir: str = "",
) -> tuple[bool, str]:
    """MRC-compress one already-recognised file. Returns (applied, note).

    ORDER is the whole reason this is a separate step rather than
    a flag on the recognition call: recognition rasterises from the PAGE, so
    MRC first would hand Tesseract the reconstruction instead of the scan
    Here the recognised output IS the input, which makes the order
    structural rather than documented.

    A failure NEVER fails the file. The searchable copy is the deliverable the
    user asked for and it already exists; MRC is an additional saving on top.
    A file with no scanned page refuses by name from the engine and that
    refusal is the ordinary case for a mixed folder -- it is reported as a
    note, not as an error, and the file keeps the bytes it already had.

    The MRC pass reads its source as CONTENT, so it takes the same prepared
    copy the Ghostscript-backed ops take: a widget carrying no appearance is
    given one first. MRC drops no widget and flattens nothing (measured), so
    a document whose fields all carry an appearance comes out byte-identical
    either way -- what the shared preparation buys is that the two staged
    reads cannot drift apart, not a change today.
    """
    scratch = Path(tempfile.mkdtemp(prefix="spectra-batch-mrc-"))
    try:
        prepared = regenerate_appearances_file(Path(source), scratch, font_dir) or source
        report = compress(
            str(prepared),
            str(dest),
            quality="mrc",
            mrc_preset=preset,
            mrc_verify_text=verify_text,
            mrc_lang=lang,
            gs_path=gs_path,
            tesseract_path=tesseract_path,
        )
    except RequestCancelled:
        raise
    except Exception as exc:  # noqa: BLE001 - per-file isolation, as above
        return False, f"MRC compression did not apply: {exc}"
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    note = (
        f"MRC compressed {report['pages_mrc']} page(s), "
        f"{report['original_size']} -> {report['compressed_size']} bytes"
    )
    if report.get("pages_reverted"):
        note = (
            f"{note}; {report['pages_reverted']} page(s) reverted by text verification"
        )
    return True, note


def _enhance_step(
    source: Path, gs_path: str, tesseract_path: str, orientation: bool
) -> tuple[bool, str]:
    """Deskew/despeckle/whiten one file IN PLACE, BEFORE it is recognised.

    The mirror image of `_mrc_step`, and the order is structural for the same
    reason stated the other way round: recognition rasterises from the page, so
    enhancement AFTER it would improve a page nobody is going to read again,
    while enhancement first is exactly what raises recognition accuracy — a
    page two degrees off square recognises as ragged lines, and a page fed in
    sideways recognises as nothing at all.

    A failure NEVER fails the file. A document with no scanned page refuses by
    name from the engine, and for a mixed folder that refusal is the ordinary
    case — it is reported as a note, not as an error, and the file keeps the
    bytes it already had.
    """
    try:
        report = enhance_scan(
            str(source),
            str(source),
            orientation=orientation,
            gs_path=gs_path,
            tesseract_path=tesseract_path,
        )
    except RequestCancelled:
        raise
    except Exception as exc:  # noqa: BLE001 - per-file isolation, as above
        return False, f"Scan enhancement did not apply: {exc}"
    if not report["written"]:
        return False, "Scan enhancement found nothing to correct"
    return True, f"Enhanced {report['pages_enhanced']} scanned page(s)"


def _pages_needing_ocr(path: str, pdf: pikepdf.Pdf) -> list[int]:
    """0-based indices of pages that look like scans.

    Two conditions, both required, mirroring search/extract.ts: fewer than
    MIN_TEXT_CHARS real glyphs AND the page actually paints a raster image. The
    second half matters -- a genuinely blank page also has no text, and OCRing
    it yields nothing while costing a full 300dpi render.

    Text is extracted for the WHOLE document in one pdfminer pass rather than
    per page: pdfminer re-parses the file on every call, so per-page extraction
    turns an N-page document into N full parses.
    """
    per_page = _document_page_text(path, len(pdf.pages))
    needing: list[int] = []
    for i in range(len(pdf.pages)):
        text = per_page.get(i, "")
        glyphs = sum(1 for ch in text if ch not in (" ", "\t", "\n", "\r"))
        if glyphs >= MIN_TEXT_CHARS:
            continue
        if _paints_raster(pdf.pages[i]):
            needing.append(i)
    return needing


def _document_page_text(path: str, page_count: int) -> dict[int, str]:
    """{0-based page index: text}. A parse failure yields no text, not an error --
    the caller then falls back to the image check, which is the safe direction
    (it can only cause a page to be OCR'd, never to be silently skipped)."""
    from engine.extract_text import layout_text, pdfminer_pages

    out: dict[int, str] = {}
    try:
        for i, layout in enumerate(pdfminer_pages(path)):
            if i >= page_count:
                break
            out[i] = layout_text(layout)
    except Exception:
        return {}
    return out


def _paints_raster(page) -> bool:
    """Does this page draw an image? /XObject subtype Image, or an inline image."""
    try:
        resources = page.get("/Resources")
        if resources is not None:
            xobjects = resources.get("/XObject")
            if xobjects is not None:
                for _, xobj in xobjects.items():
                    try:
                        if xobj.get("/Subtype") == "/Image":
                            return True
                    except Exception:
                        continue
        # Inline images (BI ... ID ... EI) never appear in /XObject, so the
        # content stream is the only place they show up.
        try:
            stream = bytes(page.obj.get("/Contents").read_bytes())
        except Exception:
            stream = b""
        if stream and re.search(rb"(?:^|\s)BI\s", stream):
            return True
    except Exception:
        # A page we cannot inspect is treated as NOT a scan: claiming text that
        # was never there is worse than mirroring the page unchanged.
        return False
    return False


class _AlreadyHandled(Exception):
    """This entry already has a result — skip the open without
    reclassifying it (an image that would not wrap, so far)."""


def _classify_load_error(exc: Exception) -> str:
    if isinstance(exc, pikepdf.PasswordError):
        return "password-protected"
    return f"unreadable: {exc}"


def dest_conflicts_with_source(source_root: str, dest_root: str) -> bool:
    """dest == source, or dest inside source. Case-insensitive on Windows."""

    def norm(p: str) -> str:
        s = os.path.normcase(os.path.abspath(p)).replace("/", "\\")
        return s.rstrip("\\")

    src = norm(source_root)
    dst = norm(dest_root)
    return dst == src or dst.startswith(src + "\\")


# Image files a scan folder routinely holds beside its PDFs. Each is
# wrapped into a PDF and then OCR'd exactly like any other page — the
# recognizer never learns there was no PDF to begin with. `IMAGE_SUFFIXES` and
# the wrap itself are re-exported from `engine.create_pdf` (see the import).


def _list_sources(
    root: Path, images: bool, extra: tuple[str, ...] = ()
) -> tuple[list[tuple[Path, str]], list[str]]:
    """Every source under root, with its path RELATIVE to root, plus
    unreadable dirs. PDFs always; image files when `images` is on;
    `extra` for a caller that accepts more (a guided action whose FIRST step
    is `create_pdf` walks Office sources too).

    A non-PDF's mirrored name gains `.pdf` rather than replacing the
    extension: `invoice.tif` and `invoice.pdf` in one folder must not
    collide, and the original name stays legible in the output."""
    files: list[tuple[Path, str]] = []
    skipped: list[str] = []
    wanted = (".pdf",) + (IMAGE_SUFFIXES if images else ()) + tuple(extra)
    for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: skipped.append(str(e))):
        dirnames.sort()
        for name in sorted(filenames):
            if name.lower().endswith(wanted) and not is_spectra_temp_name(name):
                abs_path = Path(dirpath) / name
                files.append((abs_path, str(abs_path.relative_to(root))))
    return files, skipped


def _is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_SUFFIXES


def _unique_destination(dest: Path) -> Path:
    """First free name at or beside dest -- never overwrite (mirrors Rust)."""
    if not dest.exists():
        return dest
    stem, suffix = dest.stem, dest.suffix
    for n in range(2, 1000):
        candidate = dest.with_name(f"{stem} ({n}){suffix}")
        if not candidate.exists():
            return candidate
    return dest


def _move_file(src: Path, dest: Path) -> str:
    """Move a SOURCE file, with the same three properties the Rust command has.

    rename-first (atomic in-volume), copy+verify+delete across volumes, never
    overwrite, and refuse a same-file move by identity -- copy-then-delete onto
    itself deletes the file.
    """
    if not src.is_file():
        raise RuntimeError(f"not a file: {src}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and os.path.samefile(src, dest):
        raise RuntimeError("source and destination are the same file")
    target = _unique_destination(dest)
    try:
        os.rename(src, target)
        return str(target)
    except OSError:
        pass
    shutil.copy2(src, target)
    if target.stat().st_size != src.stat().st_size:
        target.unlink(missing_ok=True)
        raise RuntimeError(
            f"move aborted: short copy to {target} -- the original was left in place"
        )
    try:
        src.unlink()
    except OSError as exc:
        raise RuntimeError(
            f"copied to {target} but could not remove the original {src}: {exc} "
            "-- the file now exists in BOTH places"
        ) from None
    return str(target)


def _verify_output(path: Path, expected_pages: int) -> bool:
    """Is the mirror output a readable PDF of the expected length?

    Runs ONLY before a source is about to move. Any failure is a failure --
    this must never return True on doubt.
    """
    try:
        with open_pdf(str(path)) as out:
            return len(out.pages) == expected_pages
    except Exception:
        return False


def _copy_file(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and os.path.samefile(src, dest):
        raise RuntimeError("source and destination are the same file")
    if dest.exists():
        dest.chmod(0o666)
    publish_copy(src, dest)


def _repair_only_entry(
    abs_path: Path,
    rel: str,
    out_path: Path,
    in_place: bool,
    moved_root: str,
    error_root: str,
    replace_repaired_originals: bool,
) -> dict:
    """One file of a repair-only run: tier-1 repair, no recognition.

    The repair always writes to a scratch file beside the output. A file the
    repair reports as undamaged keeps its own bytes -- the rewrite would still
    strip signatures and renumber objects, which is a change, not a repair --
    so the mirror receives a byte copy and in-place leaves the original alone.
    A damaged file's repaired bytes land through a staged write: `publish_copy`
    in the mirror, verify-then-`finish_staged` in place.
    """
    scratch = scratch_path(out_path.parent, "repaired")
    result: dict
    try:
        scratch.parent.mkdir(parents=True, exist_ok=True)
        try:
            report = repair(str(abs_path), str(scratch))
        except Exception as exc:  # noqa: BLE001 - per-file isolation
            result = {"rel": rel, "status": "skipped", "reason": f"repair failed: {exc}"}
        else:
            raise_if_cancelled()
            if not report.get("damaged"):
                if in_place:
                    result = {"rel": rel, "status": "copied", "reason": "no repair needed -- unchanged"}
                else:
                    _copy_file(abs_path, out_path)
                    result = {"rel": rel, "status": "copied", "reason": "no repair needed"}
            elif not _verify_output(scratch, int(report.get("pages", 0))):
                result = {
                    "rel": rel,
                    "status": "skipped",
                    "reason": (
                        "the repaired copy could not be read back as a valid PDF -- "
                        "the original was left untouched"
                    ),
                }
            else:
                result = {
                    "rel": rel,
                    "status": "repaired",
                    "repaired": True,
                    "repairFixes": len(report.get("damage") or []),
                }
                if report.get("signatures_removed"):
                    result["signaturesRemoved"] = int(report["signatures_removed"])
                if in_place:
                    finish_staged(scratch, abs_path)
                    result["inPlace"] = True
                else:
                    _copy_file(scratch, out_path)
                    if replace_repaired_originals:
                        try:
                            publish_copy(scratch, abs_path)
                            result["repairedOriginalReplaced"] = True
                        except Exception as exc:  # noqa: BLE001
                            result["moveError"] = (
                                f"the repaired copy could not replace the original: {exc}"
                            )
        root = error_root if result["status"] == "skipped" else moved_root
        if root:
            try:
                result["movedTo"] = _move_file(abs_path, Path(root) / rel)
            except Exception as exc:  # noqa: BLE001
                prior = result.get("moveError")
                result["moveError"] = f"{prior}; move failed: {exc}" if prior else str(exc)
    except RequestCancelled:
        raise
    except Exception as exc:  # noqa: BLE001 - per-file isolation is the point
        result = {"rel": rel, "status": "skipped", "reason": str(exc)}
        if error_root:
            try:
                result["movedTo"] = _move_file(abs_path, Path(error_root) / rel)
            except Exception as move_exc:  # noqa: BLE001
                result["moveError"] = str(move_exc)
    finally:
        scratch.unlink(missing_ok=True)
    return result


def ocr_file(
    file: str,
    output: str,
    language: str = "eng",
    tesseract_path: str = "",
    gs_path: str = "",
    mrc: bool = False,
    mrc_preset: str = "balanced",
    mrc_verify_text: bool = False,
    enhance: bool = False,
    enhance_orientation: bool = True,
    font_dir: str = "",
) -> dict:
    """Make ONE file searchable — the single-file arm of the batch pipeline.

    SAME detection (_pages_needing_ocr), SAME recognition (recognize), SAME
    rect mapping (_to_pdf_rects), SAME writer (apply_ocr_layer, which already
    handles output == file with a true-identity temp+rename) — COMPOSED
    beside batch_ocr from the shared helpers rather than extracted from it,
    so the batch loop's verified behavior is untouched. Built for the
    guided-actions OCR step; also the CLI's `ocr-file` arm.

    A file with nothing that looks like a scan is reported, not rewritten:
    in-place → no write at all; to a distinct output → a byte copy.

    `enhance` runs scan enhancement BEFORE recognition and `mrc`
    MRC-compresses AFTER it, and the two orders are the same fact seen from
    both ends: recognition rasterises from the page, so the pass that IMPROVES
    what it will read has to run first and the pass that REPLACES what it read
    has to run last. Neither ever fails the file; both notes ride the result.
    """
    input_path = Path(file)
    output_path = Path(output)
    try:
        same = output_path.exists() and os.path.samefile(input_path, output_path)
    except OSError:
        same = False

    # Where everything downstream READS from. Enhancement is the one step that
    # moves it: the source is never modified in mirror mode, so the enhanced
    # bytes are staged at the deliverable path and recognition reads those.
    source_path = input_path
    enhance_note = ""
    enhance_applied = False
    if enhance:
        if not same:
            _copy_file(input_path, output_path)
        enhance_applied, enhance_note = _enhance_step(
            output_path, gs_path, tesseract_path, enhance_orientation
        )
        source_path = output_path

    def _deliver() -> None:
        """Put the un-recognised deliverable at `output_path`."""
        if not same and source_path != output_path:
            _copy_file(input_path, output_path)

    def _enhance_tail(result: dict) -> dict:
        if enhance:
            result["enhance"] = enhance_note
            if enhance_applied:
                result["enhanceApplied"] = True
        return result

    def _mrc_tail(result: dict) -> dict:
        result = _enhance_tail(result)
        if not mrc:
            return result
        # Every branch above has already put the deliverable at `output_path`
        # (recognised, or copied, or — in place — it was always there), so MRC
        # reads and rewrites that one file. `mrc_compress` handles the
        # same-file case with a staged temp and a rename.
        applied, note = _mrc_step(
            output_path, output_path, mrc_preset, mrc_verify_text, language, gs_path,
            tesseract_path, font_dir,
        )
        result["mrc"] = note
        if applied:
            result["mrcApplied"] = True
            result["output"] = str(output_path)
        return result

    with open_pdf(str(source_path)) as pdf:
        total = len(pdf.pages)
        needing = _pages_needing_ocr(str(source_path), pdf)

    if not needing:
        _deliver()
        return _mrc_tail({
            "output": str(output_path),
            "pages_total": total,
            "pages_ocrd": 0,
            "skipped": "no scanned pages",
        })

    pages: list[dict] = []
    for i in needing:
        got = recognize(str(source_path), i + 1, language, tesseract_path, gs_path)
        words = _to_pdf_rects(str(source_path), i, got["words"])
        if words:
            pages.append({"page": i + 1, "words": words})

    if not pages:
        _deliver()
        return _mrc_tail({
            "output": str(output_path),
            "pages_total": total,
            "pages_ocrd": 0,
            "skipped": "no text recognized",
        })

    apply_ocr_layer(str(source_path), str(output_path), pages)
    return _mrc_tail({
        "output": str(output_path),
        "pages_total": total,
        "pages_ocrd": len(pages),
    })


def _make_owned_dirs(folder: Path, owned: list[str]) -> None:
    """Create `folder` and its missing ancestors, recording in `owned` each
    folder this call created. A folder another process creates first raises
    `FileExistsError` here and is never recorded."""
    missing: list[Path] = []
    current = folder
    while not current.exists() and current.parent != current:
        missing.append(current)
        current = current.parent
    for path in reversed(missing):
        try:
            os.mkdir(path)
        except FileExistsError:
            continue
        except OSError:
            return
        owned.append(str(path))


def _remove_owned_empty_dirs(owned: list[str]) -> None:
    """Remove the folders in `owned` that are empty, deepest first. `os.rmdir`
    refuses a folder with anything in it."""
    for folder in sorted(owned, key=lambda d: d.count(os.sep), reverse=True):
        try:
            os.rmdir(folder)
        except OSError:
            pass


def batch_ocr(
    source: str,
    dest: str = "",
    lang: str = "eng",
    tesseract_path: str = "",
    gs_path: str = "",
    moved_root: str = "",
    error_root: str = "",
    repair_damaged: bool = False,
    replace_repaired_originals: bool = False,
    log_dir: str = "",
    progress: bool = False,
    in_place: bool = False,
    passwords: dict | None = None,
    include_images: bool = False,
    mrc: bool = False,
    mrc_preset: str = "balanced",
    mrc_verify_text: bool = False,
    enhance: bool = False,
    enhance_orientation: bool = True,
    font_dir: str = "",
    remove_empty_folders: bool = False,
    repair_only: bool = False,
) -> dict:
    """Mirror a folder of PDFs into searchable copies — or, with `in_place`,
    REPLACE each original with its searchable version (in-place batch
    mode). In-place output goes through a staged temp beside the original
    and only replaces it after the verify-read succeeds, so a crash or a bad
    write can never leave a half-written original. Returns the report.

    `passwords` maps a source's RELATIVE path (or its bare file name) to
    the password that opens it. Supplied UP FRONT rather than prompted:
    a batch is exactly the run that has nobody to ask — a scheduled job under
    a service account has no desktop — so the credential has to arrive with
    the request. A file with no entry keeps the shipped behaviour and is
    skipped as `password-protected`, which is what lets a caller run once,
    read the report, and re-run just the files it now has passwords for.

    `include_images` adds loose image files (PNG/JPEG/TIFF/BMP) to the
    sweep. Each is wrapped into a one-page PDF at its own natural size and
    then travels the identical path; the mirrored name gains `.pdf` rather
    than replacing the extension, so `invoice.tif` and `invoice.pdf` in one
    folder cannot collide.

    `mrc` MRC-compresses each processed file AFTER recognition:
    recognition rasterises from the page, so the reverse order would hand
    Tesseract the reconstruction). It answers "a batch
    option that could just compress automatically": the user with a folder of
    smartphone scans is standing in this run. A file MRC declines — anything
    that is not a scan — keeps the bytes it already had and says so; MRC
    never fails a file whose searchable copy already succeeded.

    `enhance` deskews, despeckles, whitens and re-orients each file BEFORE
    recognition — the same structural order as `mrc`'s, seen from the other
    end (`_enhance_step`). It stages into its own temp beside the output, so
    the source is never modified, and like MRC it never fails a file.

    `remove_empty_folders` deletes, after every file is done, the folders
    inside the source root that are empty at that point
    (`plan_empty_folders` defines which qualify). The source root itself is never removed.

    `repair_only` runs the tier-1 repair on every PDF and no recognition
    (`_repair_only_entry`). MRC, enhancement and image sources exist only for
    recognition, so a request that combines them with it is refused."""
    source_path = Path(source).resolve()
    if not source_path.is_dir():
        raise ValueError(f"Source folder not found: {source}")
    if repair_only and (mrc or enhance or include_images):
        raise ValueError(
            "Repair-only mode runs no OCR -- MRC compression, scan enhancement and "
            "image files cannot be combined with it."
        )
    if in_place:
        if dest:
            raise ValueError("In-place mode takes no destination -- the originals are replaced.")
        if moved_root:
            raise ValueError(
                "In-place mode cannot also move processed originals -- the processed "
                "file IS the original."
            )
        dest_path = source_path  # rel joins resolve to the originals themselves
    else:
        if not dest:
            raise ValueError("A destination folder is required unless running in place.")
        dest_path = Path(dest).resolve()
        if dest_conflicts_with_source(str(source_path), str(dest_path)):
            raise ValueError(
                "The destination must be outside the source folder -- choose a separate "
                "folder for the searchable copies."
            )
    for label, root in (("moved", moved_root), ("error", error_root)):
        if not root:
            continue
        if dest_conflicts_with_source(str(source_path), str(Path(root).resolve())):
            raise ValueError(f"The {label} folder must be outside the source folder.")
        if not in_place and dest_conflicts_with_source(str(dest_path), str(Path(root).resolve())):
            raise ValueError(f"The {label} folder must be outside the destination folder.")

    started_at = datetime.now()
    pw_map = {}
    for key, value in (passwords or {}).items():
        # Accept a relative path in either slash idiom, or a bare file name.
        norm = str(key).replace("/", os.sep).replace("\\", os.sep)
        pw_map[os.path.normcase(norm)] = str(value)
        pw_map.setdefault(os.path.normcase(os.path.basename(norm)), str(value))
    entries, skipped_dirs = _list_sources(source_path, bool(include_images))
    results: list[dict] = []
    stopped = False
    # Mirror folders this run created; the ones still empty at the end are
    # removed, and no folder another process made is ever in the list.
    owned_dirs: list[str] = []
    reclaimed: set[Path] = set()

    for index, (abs_path, rel) in enumerate(entries):
        if cancelled():
            stopped = True
            break
        if progress:
            print(f"[{index + 1}/{len(entries)}] {rel}", flush=True)
        # In place: write to a staged temp BESIDE the original; the tail
        # replaces the original only after the verify-read succeeds.
        # An image's mirrored name GAINS `.pdf` rather than replacing the
        # extension — `invoice.tif` and `invoice.pdf` in one folder must not
        # collide, and the original name stays legible in the output.
        out_rel = rel + ".pdf" if _is_image(abs_path) else rel
        out_path = (
            scratch_path(abs_path.parent, "inplace") if in_place else dest_path / out_rel
        )
        if not in_place:
            _make_owned_dirs(out_path.parent, owned_dirs)
        # A killed earlier run left its temps beside the originals (in place)
        # or beside the outputs (mirror); each folder is swept once per run.
        for folder in (abs_path.parent, out_path.parent):
            if folder not in reclaimed:
                reclaimed.add(folder)
                reclaim_stale_stages(folder)
        if repair_only:
            try:
                results.append(
                    _repair_only_entry(
                        abs_path, rel, out_path, in_place, moved_root, error_root,
                        replace_repaired_originals,
                    )
                )
            except RequestCancelled:
                stopped = True
                break
            continue
        result: dict | None = None
        scratch: Path | None = None
        # An image's PDF wrapping is not a repair: `scratch` alone may replace
        # the original, and an image original must never receive PDF bytes.
        wrapped: Path | None = None
        # Enhancement's OWN staging, deliberately not `scratch`: the tail reads
        # `scratch is not None` as "this file was repaired" and may replace the
        # original from it, which an enhanced copy must never trigger.
        enhanced: Path | None = None
        enhance_note = ""
        enhance_applied = False
        expected_pages = 0
        pdf = None
        try:
            source_for_open = abs_path
            if in_place and _is_image(abs_path):
                # In place means REPLACE the original. An image cannot be
                # replaced by a PDF without becoming a different kind of
                # file — leaving a `.png` that is secretly a PDF is worse
                # than not touching it. Say so and move on.
                result = {
                    "rel": rel,
                    "status": "skipped",
                    "reason": "in-place mode cannot replace an image with a PDF",
                }
            elif _is_image(abs_path):
                # An image becomes a PDF FIRST — one page per FRAME, so a
                # multi-page fax TIFF OCRs whole — and everything after this
                # line is the shipped PDF path with no branch.
                wrapped = scratch_path(out_path.parent, "image")
                try:
                    image_to_pdf(abs_path, wrapped)
                    source_for_open = wrapped
                except Exception as exc:
                    wrapped.unlink(missing_ok=True)
                    wrapped = None
                    result = {"rel": rel, "status": "skipped",
                              "reason": f"unreadable image: {exc}"}
            if enhance and result is None:
                # BEFORE the page is opened for recognition, because that is
                # the whole order (`_enhance_step`), and into a staging copy,
                # because a batch source is never modified.
                enhanced = scratch_path(out_path.parent, "enhanced")
                try:
                    enhanced.parent.mkdir(parents=True, exist_ok=True)
                    _copy_file(source_for_open, enhanced)
                    enhance_applied, enhance_note = _enhance_step(
                        enhanced, gs_path, tesseract_path, enhance_orientation
                    )
                    source_for_open = enhanced
                except RequestCancelled:
                    raise
                except Exception as exc:  # noqa: BLE001 - never fails the file
                    if enhanced is not None:
                        enhanced.unlink(missing_ok=True)
                        enhanced = None
                    enhance_note = f"Scan enhancement did not apply: {exc}"
            password = pw_map.get(os.path.normcase(rel)) or pw_map.get(
                os.path.normcase(os.path.basename(rel))
            )
            try:
                if result is not None:
                    raise _AlreadyHandled()
                pdf = (
                    open_pdf(str(source_for_open), password=password)
                    if password
                    else open_pdf(str(source_for_open))
                )
            except _AlreadyHandled:
                pdf = None
            except Exception as exc:
                classification = _classify_load_error(exc)
                # A password failure is not a repair candidate: a structural
                # rewrite cannot supply a password.
                if repair_damaged and classification != "password-protected":
                    scratch = scratch_path(out_path.parent, "repaired")
                    try:
                        scratch.parent.mkdir(parents=True, exist_ok=True)
                        repair(str(abs_path), str(scratch))
                        pdf = open_pdf(str(scratch))
                    except Exception as repair_exc:
                        pdf = None
                        if scratch is not None:
                            scratch.unlink(missing_ok=True)
                            scratch = None
                        result = {
                            "rel": rel,
                            "status": "skipped",
                            "reason": f"{classification}; repair did not help: {repair_exc}",
                        }
                else:
                    result = {"rel": rel, "status": "skipped", "reason": classification}

            if pdf is not None:
                working = enhanced or scratch or wrapped or abs_path
                expected_pages = len(pdf.pages)
                needing = _pages_needing_ocr(str(working), pdf)
                pdf.close()
                pdf = None

                if not needing:
                    if in_place:
                        # Nothing to write — the original already IS the output.
                        result = {"rel": rel, "status": "copied", "reason": "already searchable -- unchanged"}
                    else:
                        _copy_file(working, out_path)
                        result = {"rel": rel, "status": "copied"}
                else:
                    pages: list[dict] = []
                    for i in needing:
                        raise_if_cancelled()
                        got = recognize(str(working), i + 1, lang, tesseract_path, gs_path)
                        words = _to_pdf_rects(str(working), i, got["words"])
                        if words:
                            pages.append({"page": i + 1, "words": words})
                    raise_if_cancelled()
                    if not pages:
                        if in_place:
                            result = {
                                "rel": rel,
                                "status": "copied",
                                "reason": "no text recognized -- unchanged",
                            }
                        else:
                            _copy_file(working, out_path)
                            result = {
                                "rel": rel,
                                "status": "copied",
                                "reason": "no text recognized",
                            }
                    else:
                        out_path.parent.mkdir(parents=True, exist_ok=True)
                        apply_ocr_layer(str(working), str(out_path), pages)
                        result = {"rel": rel, "status": "ocr", "pagesOcrd": len(pages)}
                        if len(pages) < len(needing):
                            result["reason"] = (
                                f"{len(needing) - len(pages)} of {len(needing)} scanned "
                                "pages had no recognizable text"
                            )

            # ── enhancement's note, and its in-place landing ────────────
            #
            # The enhanced bytes reach a mirror output through whichever
            # branch above wrote it (`working` IS the staging). In place, a
            # file that needed no OCR wrote nothing at all, so the staging has
            # to be produced here or the enhancement would be discarded.
            if enhance and result is not None and result["status"] != "skipped":
                if enhance_note:
                    result["enhance"] = enhance_note
                if enhance_applied:
                    result["enhanceApplied"] = True
                    if in_place and result["status"] != "ocr" and enhanced is not None:
                        out_path.parent.mkdir(parents=True, exist_ok=True)
                        _copy_file(enhanced, out_path)

            # ── MRC, after recognition and before the tail ──────────────
            #
            # After, because the order is structural here: the file this
            # reads is the RECOGNISED one. Before the tail, because the tail
            # verifies the output and may move originals on the strength of
            # it — verifying bytes that are about to be replaced would verify
            # the wrong file.
            if mrc and result is not None and result["status"] != "skipped":
                if in_place and result["status"] != "ocr" and not result.get("enhanceApplied"):
                    # Nothing was staged (the file needed no OCR), so MRC
                    # produces the staging itself, from the original.
                    mrc_source = enhanced or scratch or wrapped or abs_path
                else:
                    mrc_source = out_path
                applied_mrc, note = _mrc_step(
                    mrc_source, out_path, mrc_preset, mrc_verify_text, lang, gs_path,
                    tesseract_path, font_dir,
                )
                result["mrc"] = note
                if applied_mrc:
                    result["mrcApplied"] = True

            # ── tail: verify, heal, move ────────────────────────────────
            if result is not None:
                if result["status"] != "skipped" and (
                    (
                        in_place
                        and (
                            result["status"] == "ocr"
                            or result.get("mrcApplied")
                            or result.get("enhanceApplied")
                        )
                    )
                    or moved_root
                    or (scratch is not None and replace_repaired_originals)
                ):
                    if not _verify_output(out_path, expected_pages):
                        result = {
                            "rel": rel,
                            "status": "skipped",
                            "reason": (
                                "the copy in the destination could not be read back as a "
                                "valid PDF -- the original was left untouched"
                            ),
                        }
                # In place: the verified staging REPLACES the original
                # atomically (same directory, finish_staged). A skipped result
                # leaves the original untouched; the finally unlinks staging.
                if in_place and (
                    result["status"] == "ocr"
                    or result.get("mrcApplied")
                    or result.get("enhanceApplied")
                ):
                    try:
                        finish_staged(out_path, abs_path)
                        result["inPlace"] = True
                    except OSError as exc:
                        result = {
                            "rel": rel,
                            "status": "skipped",
                            "reason": f"could not replace the original in place: {exc}",
                        }

                if scratch is not None:
                    result["repaired"] = True
                    if replace_repaired_originals and result["status"] != "skipped":
                        try:
                            publish_copy(scratch, abs_path)
                            result["repairedOriginalReplaced"] = True
                        except Exception as exc:
                            result["moveError"] = (
                                f"the repaired copy could not replace the original: {exc}"
                            )

                root = error_root if result["status"] == "skipped" else moved_root
                if root:
                    try:
                        result["movedTo"] = _move_file(abs_path, Path(root) / rel)
                    except Exception as exc:
                        prior = result.get("moveError")
                        result["moveError"] = (
                            f"{prior}; move failed: {exc}" if prior else str(exc)
                        )
        except RequestCancelled:
            # The original is untouched. A mirror output already written for
            # this file is a complete, valid PDF (every write is staged), so
            # it stays; the file is not listed.
            stopped = True
            result = None
        except Exception as exc:  # noqa: BLE001 - per-file isolation is the point
            result = {"rel": rel, "status": "skipped", "reason": str(exc)}
            if error_root:
                try:
                    result["movedTo"] = _move_file(abs_path, Path(error_root) / rel)
                except Exception as move_exc:
                    result["moveError"] = str(move_exc)
        finally:
            if pdf is not None:
                pdf.close()
            if scratch is not None:
                scratch.unlink(missing_ok=True)
            if wrapped is not None:
                wrapped.unlink(missing_ok=True)
            if enhanced is not None:
                enhanced.unlink(missing_ok=True)
            if in_place:
                # Any staging that did not become the original is litter.
                out_path.unlink(missing_ok=True)

        if result is not None:
            results.append(result)
        if stopped:
            break

    # A Stop that lands during the last file finds no next iteration to see it.
    if not stopped and cancelled():
        stopped = True
    _remove_owned_empty_dirs(owned_dirs)
    report = {"cancelled": stopped, "results": results, "skippedDirs": skipped_dirs, "inPlace": in_place}
    if remove_empty_folders and not stopped:
        protected = [str(dest_path)] if not in_place else []
        protected += [str(Path(r).resolve()) for r in (moved_root, error_root) if r]
        cleanup = remove_empty_folders_in(str(source_path), protected)
        if cleanup.get("stopped"):
            report["cancelled"] = True
        report["emptyFolders"] = cleanup
    log_path = _write_log(
        started_at,
        datetime.now(),
        str(source_path),
        str(dest_path),
        lang,
        report,
        moved_root,
        error_root,
        repair_damaged,
        replace_repaired_originals,
        log_dir,
        repair_only,
    )
    if log_path:
        report["logPath"] = log_path
    return report


# ── Empty source folders ──────────────────────────────────────────────────
#
# Remove empty folders left in a batch SOURCE tree after a run.
#
# A folder qualifies when it lies strictly inside the source root, is reached
# without crossing a reparse point (junction, symbolic link, mount point, cloud
# placeholder), and holds nothing at deletion time except folders that qualify
# themselves. The root is never removed. A reparse point is never entered and
# never removed: it counts as content, so every folder above it stays.
#
# Planning and deletion are separate steps. The plan is bottom-up (a parent
# after all its children), and deletion uses `os.rmdir`, which refuses a folder
# that is not empty -- so a file that appears between the plan and the delete
# makes that delete fail and be reported, never removes the file.


def _is_reparse(st: os.stat_result) -> bool:
    attrs = getattr(st, "st_file_attributes", 0)
    if attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
        return True
    return stat.S_ISLNK(st.st_mode)


_LINK_TAGS = frozenset({0xA000000C, 0xA0000003})  # symbolic link, mount point / junction


def _is_link(st: os.stat_result) -> bool:
    """A reparse point that redirects to another path. Cloud-file placeholders
    and other tagged folders are reparse points too, but stay where they are."""
    if stat.S_ISLNK(st.st_mode):
        return True
    return _is_reparse(st) and getattr(st, "st_reparse_tag", 0) in _LINK_TAGS


def _norm_path(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


# Shell-written metadata files. Their presence keeps a folder; the report
# names them so a kept folder that looks empty in Explorer is explained.
_SYSTEM_FILE_NAMES = frozenset({"desktop.ini", "thumbs.db", ".ds_store"})


def plan_empty_folders(root: str, protected: list[str] | tuple[str, ...] = ()) -> dict:
    """Plan which folders under `root` qualify for removal.

    Returns {"candidates": [...], "skipped": [{"path", "reason"}]}. Candidates
    are ordered deepest first, each with its lstat identity, so the executor
    can confirm it deletes the folder that was planned."""
    root_path = os.path.realpath(root)
    protected_set = {_norm_path(os.path.realpath(p)) for p in protected if p}
    candidates: list[dict] = []
    skipped: list[dict] = []

    def visit(path: str) -> bool:
        """True when `path` holds nothing but qualifying folders."""
        try:
            with os.scandir(path) as it:
                entries = list(it)
        except OSError as exc:
            skipped.append({"path": path, "reason": f"could not be read: {exc.strerror or exc}"})
            return False
        empty = True
        # Set by anything except a system file or a folder that qualifies.
        other_content = False
        system_files: list[str] = []
        for entry in sorted(entries, key=lambda e: e.name):
            try:
                st = os.lstat(entry.path)
            except OSError as exc:
                skipped.append(
                    {"path": entry.path, "reason": f"could not be read: {exc.strerror or exc}"}
                )
                empty = False
                other_content = True
                continue
            if _is_link(st):
                skipped.append({"path": entry.path, "reason": "link or junction, not followed"})
                empty = False
                other_content = True
                continue
            if _is_reparse(st):
                # Entering a cloud placeholder can download its contents, and
                # an online-only folder reads as empty; it counts as content.
                if stat.S_ISDIR(st.st_mode):
                    skipped.append(
                        {"path": entry.path, "reason": "cloud or other placeholder folder, not entered"}
                    )
                empty = False
                other_content = True
                continue
            if not stat.S_ISDIR(st.st_mode):
                if entry.name.lower() in _SYSTEM_FILE_NAMES:
                    system_files.append(entry.name)
                empty = False
                other_content = other_content or entry.name.lower() not in _SYSTEM_FILE_NAMES
                continue
            if _norm_path(entry.path) in protected_set:
                skipped.append({"path": entry.path, "reason": "output folder of this run"})
                empty = False
                other_content = True
                continue
            if visit(entry.path):
                candidates.append(
                    {"path": entry.path, "ino": st.st_ino, "dev": st.st_dev}
                )
            else:
                empty = False
                other_content = True
        if system_files and not other_content and path != root_path:
            skipped.append(
                {"path": path, "reason": "holds only system files: " + ", ".join(system_files)}
            )
        return empty

    try:
        root_st = os.lstat(root_path)
    except OSError as exc:
        return {
            "candidates": [],
            "skipped": [{"path": root_path, "reason": f"could not be read: {exc.strerror or exc}"}],
        }
    if not stat.S_ISDIR(root_st.st_mode) or _is_link(root_st):
        return {"candidates": [], "skipped": [{"path": root_path, "reason": "not a plain folder"}]}
    visit(root_path)
    return {"candidates": candidates, "skipped": skipped}


def _root_refusal(root: str) -> str:
    """Why nothing may be removed under `root`, or ''.

    The caller's authority covers `root` as spelled. A link or junction at the
    root or above it would move the walk into another tree."""
    absolute = os.path.abspath(root)
    current = absolute
    while True:
        parent = os.path.dirname(current)
        if parent == current:
            break
        try:
            if _is_link(os.lstat(current)):
                return f"not removed: {current} is a link or junction"
        except OSError as exc:
            return f"could not be read: {exc.strerror or exc}"
        current = parent
    if _norm_path(os.path.realpath(absolute)) != _norm_path(absolute):
        return "not removed: the source folder resolves to another location"
    return ""


def _remove_planned(cand: dict) -> dict | None:
    """Delete one planned folder. None on success, else its skipped entry."""
    path = cand["path"]
    try:
        st = os.lstat(path)
    except OSError as exc:
        return {"path": path, "reason": f"could not be read: {exc.strerror or exc}"}
    if _is_reparse(st) or not stat.S_ISDIR(st.st_mode):
        return {"path": path, "reason": "changed into a link or file after planning"}
    if (st.st_ino, st.st_dev) != (cand["ino"], cand["dev"]):
        return {"path": path, "reason": "replaced by another folder after planning"}
    try:
        os.rmdir(path)
    except OSError as exc:
        return {"path": path, "reason": f"not removed: {exc.strerror or exc}"}
    return None


def remove_empty_folders_in(root: str, protected: list[str] | None = None) -> dict:
    """Plan, then delete. Returns {"removed": [...], "skipped": [{"path", "reason"}]},
    plus `"stopped": True` when a cancel ended the deletion early; `removed`
    then lists exactly what was deleted before the stop.

    `protected` names folders that are never removed even when empty (the
    run's destination and filing roots)."""
    refusal = _root_refusal(root)
    if refusal:
        return {"removed": [], "skipped": [{"path": root, "reason": refusal}]}
    plan = plan_empty_folders(root, tuple(protected or ()))
    removed: list[str] = []
    skipped: list[dict] = list(plan["skipped"])
    # Parents of folders that were not removed: still non-empty, and the
    # child's entry already explains why.
    blocked: set[str] = set()
    for cand in plan["candidates"]:
        if cancelled():
            return {"removed": removed, "skipped": skipped, "stopped": True}
        path = cand["path"]
        if _norm_path(path) in blocked:
            blocked.add(_norm_path(os.path.dirname(path)))
            continue
        entry = _remove_planned(cand)
        if entry is None:
            removed.append(path)
            continue
        skipped.append(entry)
        blocked.add(_norm_path(os.path.dirname(path)))
    return {"removed": removed, "skipped": skipped}


def _to_pdf_rects(file: str, page_index: int, words: list[dict]) -> list[dict]:
    """Normalised display boxes -> PDF user-space rects (bottom-up).

    Against the crop-intersected page box and its baked /Rotate, which is what
    the renderer's `displayRectToPdf` and `form_detect._display_rect_to_pdf`
    both map through. The mapping is CALLED rather than restated: a third copy
    of four rotation cases is a third place for one case to drift, and this
    module's own copy had /Rotate 270 mapping through the box's width and
    height swapped, which puts the invisible text layer outside the page box.
    """
    with open_pdf(file) as pdf:
        page = pdf.pages[page_index]
        box = _crop_box(page)
        rotate = _page_rotate(page) % 360

    out: list[dict] = []
    for w in words:
        if not w["text"].strip():
            continue
        rect = _display_rect_to_pdf((w["x"], w["y"], w["w"], w["h"]), box, rotate)
        out.append({"text": w["text"], "rect": [float(v) for v in rect]})
    return out


# ── The log: byte-compatible with lib/batch-log.ts ────────────────────────


def _pad(n: int, width: int = 2) -> str:
    return str(n).zfill(width)


def _format_timestamp(d: datetime) -> str:
    return (
        f"{d.year}-{_pad(d.month)}-{_pad(d.day)} "
        f"{_pad(d.hour)}:{_pad(d.minute)}:{_pad(d.second)}"
    )


def batch_log_file_name(started_at: datetime) -> str:
    d = started_at
    return (
        f"batch-ocr-{d.year}-{_pad(d.month)}-{_pad(d.day)}"
        f"_{_pad(d.hour)}{_pad(d.minute)}{_pad(d.second)}.log"
    )


def _format_duration(ms: float) -> str:
    total = max(0, round(ms / 1000))
    h, m, s = total // 3600, (total % 3600) // 60, total % 60
    if h > 0:
        return f"{h}h {_pad(m)}m {_pad(s)}s"
    if m > 0:
        return f"{m}m {_pad(s)}s"
    return f"{s}s"


def _file_line(r: dict) -> str:
    tag = f"[{r['status']}]".ljust(max(10, len(r["status"]) + 3))
    if r["status"] == "repaired":
        fixes = r.get("repairFixes", 0)
        line = f"{tag}{r['rel']} — {fixes} problem{'' if fixes == 1 else 's'} fixed"
        signatures = r.get("signaturesRemoved", 0)
        if signatures:
            line += f"; {signatures} signature{'' if signatures == 1 else 's'} removed"
    elif r["status"] == "ocr":
        pages = r.get("pagesOcrd", 0)
        line = f"{tag}{r['rel']} — {pages} page{'' if pages == 1 else 's'} made searchable"
        if r.get("reason"):
            line += f" ({r['reason']})"
    else:
        line = f"{tag}{r['rel']} — {r['reason']}" if r.get("reason") else f"{tag}{r['rel']}"
    if r.get("enhance"):
        # What the enhancement corrected — or why it corrected nothing — on
        # the same terms as the MRC note below: never left to inference.
        line += f" [{r['enhance']}]"
    if r.get("mrc"):
        # The size saving — or the reason there was none — is the whole
        # point of having asked for MRC, so it is never left to inference.
        line += f" [{r['mrc']}]"
    if r.get("repaired") and r["status"] == "repaired":
        if r.get("repairedOriginalReplaced"):
            line += " [original replaced]"
    elif r.get("repaired"):
        line += (
            " [repaired; original replaced]"
            if r.get("repairedOriginalReplaced")
            else " [repaired]"
        )
    if r.get("movedTo"):
        line += f" -> original moved to {r['movedTo']}"
    if r.get("moveError"):
        line += f" !! original NOT moved: {r['moveError']}"
    return line


def _describe_filing(
    moved: str, errors: str, repair_on: bool, replace_on: bool, repair_only: bool = False
) -> str:
    parts = []
    if moved:
        parts.append(f"processed originals -> {moved}")
    if errors:
        parts.append(f"failed originals -> {errors}")
    if repair_only:
        if replace_on:
            parts.append("repaired files replace the originals")
    elif repair_on:
        parts.append(
            "repair damaged files (replacing the originals)"
            if replace_on
            else "repair damaged files"
        )
    return " · ".join(parts) if parts else "none (source folder untouched)"


def _outcome(report: dict) -> str:
    if not report.get("cancelled"):
        return "completed"
    if report.get("inPlace"):
        return (
            "STOPPED by the user (files finished before the stop were replaced; "
            "the rest are untouched)"
        )
    return "STOPPED by the user (files finished before the stop remain in the destination)"


def _write_log(
    started_at: datetime,
    finished_at: datetime,
    source: str,
    dest: str,
    lang: str,
    report: dict,
    moved_root: str,
    error_root: str,
    repair_damaged: bool,
    replace_repaired: bool,
    log_dir: str,
    repair_only: bool = False,
) -> str:
    """Write the run log. Best-effort: a failed log never fails the batch."""
    if not log_dir:
        return ""
    results = report["results"]
    ocrd = sum(1 for r in results if r["status"] == "ocr")
    copied_clean = sum(1 for r in results if r["status"] == "copied" and not r.get("reason"))
    copied_notext = sum(1 for r in results if r["status"] == "copied" and r.get("reason"))
    skipped = sum(1 for r in results if r["status"] == "skipped")
    repaired_files = sum(1 for r in results if r["status"] == "repaired")
    unchanged = sum(1 for r in results if r["status"] == "copied")

    duration = (finished_at - started_at).total_seconds() * 1000
    filing = _describe_filing(moved_root, error_root, repair_damaged, replace_repaired, repair_only)
    lines = [
        "Spectra PDF — Batch OCR log",
        f"Started:      {_format_timestamp(started_at)}",
        f"Finished:     {_format_timestamp(finished_at)}  ({_format_duration(duration)})",
        f"Source:       {source}",
        f"Destination:  {dest}",
        *(["Mode:         repair only (no OCR)"] if repair_only else []),
        f"Languages:    {'not used (repair only)' if repair_only else lang}",
        f"Filing:       {filing}",
        f"Result:       {_outcome(report)}",
        "",
        (
            f"Files: {len(results)} processed — {repaired_files} repaired · "
            f"{unchanged} no repair needed · {skipped} skipped"
            if repair_only
            else f"Files: {len(results)} processed — {ocrd} made searchable · "
            f"{copied_clean} copied (already searchable) · "
            f"{copied_notext} copied (no text recognized) · {skipped} skipped"
        ),
    ]
    moved = sum(1 for r in results if r.get("movedTo"))
    not_moved = sum(1 for r in results if r.get("moveError"))
    repaired = sum(1 for r in results if r.get("repaired"))
    if moved or not_moved or repaired:
        lines.append(
            f"Originals: {moved} moved · {not_moved} NOT moved (see the !! lines) · "
            f"{repaired} repaired"
        )
    lines.append("")
    if not results:
        lines.append("(no files were processed)")
    else:
        lines.extend(_file_line(r) for r in results)
    if report["skippedDirs"]:
        lines.append("")
        lines.append("Unreadable subfolders (missing from the mirror):")
        lines.extend(f"  {d}" for d in report["skippedDirs"])
    empty = report.get("emptyFolders")
    if empty is not None:
        lines.append("")
        lines.append(
            f"Empty source folders: {len(empty['removed'])} removed · "
            f"{len(empty['skipped'])} left in place"
        )
        lines.extend(f"  removed  {d}" for d in empty["removed"])
        lines.extend(f"  kept     {d['path']} — {d['reason']}" for d in empty["skipped"])
    lines.append("")

    try:
        directory = Path(log_dir)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / batch_log_file_name(started_at)
        write_text_staged(path, "\r\n".join(lines))
        return str(path)
    except Exception:
        return ""
