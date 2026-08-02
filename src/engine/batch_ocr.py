"""Headless batch OCR (Phase 12 step 3) -- the folder-mirror driver, engine side.

This is the port of `src/renderer/lib/batch-ocr.ts`. It exists so a batch can
run with NO WINDOW: that is what makes the CLI arm possible, and the CLI arm is
what makes scheduling possible (issue #1 request 5). The GUI keeps its own
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
import subprocess
from datetime import datetime
from pathlib import Path

import pikepdf

from engine.ocr_layer import apply_ocr_layer
from engine.recognize import recognize
from engine.repair import repair

# Mirrors search/extract.ts MIN_TEXT_CHARS -- the GUI and the CLI must not
# disagree about whether a page is a scan.
MIN_TEXT_CHARS = 16


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
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTTextContainer

    out: dict[int, str] = {}
    try:
        for i, layout in enumerate(extract_pages(path)):
            if i >= page_count:
                break
            parts = [
                element.get_text()
                for element in layout
                if isinstance(element, LTTextContainer)
            ]
            out[i] = "".join(parts)
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


# P3: image files a scan folder routinely holds beside its PDFs. Each is
# wrapped into a one-page PDF and then OCR'd exactly like any other page —
# the recognizer never learns there was no PDF to begin with.
IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp")


def _list_sources(root: Path, images: bool) -> tuple[list[tuple[Path, str]], list[str]]:
    """Every source under root, with its path RELATIVE to root, plus
    unreadable dirs. PDFs always; image files when `images` is on (P3).

    An image's mirrored name gains `.pdf` rather than replacing the
    extension: `invoice.tif` and `invoice.pdf` in one folder must not
    collide, and the original name stays legible in the output."""
    files: list[tuple[Path, str]] = []
    skipped: list[str] = []
    wanted = (".pdf",) + (IMAGE_SUFFIXES if images else ())
    for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: skipped.append(str(e))):
        dirnames.sort()
        for name in sorted(filenames):
            if name.lower().endswith(wanted):
                abs_path = Path(dirpath) / name
                files.append((abs_path, str(abs_path.relative_to(root))))
    return files, skipped


def _is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_SUFFIXES


def _image_to_pdf(src: Path, dest: Path) -> None:
    """Wrap ONE image into a one-page PDF at its own natural size.

    The page is sized from the image's stored DPI so a 300-dpi scan becomes
    a physically correct page rather than a giant one — that matters here
    because the OCR raster is taken FROM the page, so a wrong page size
    would rescale the text and cost accuracy."""
    from PIL import Image

    with Image.open(src) as im:
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        dpi = im.info.get("dpi")
        try:
            resolution = float(dpi[0]) if dpi and float(dpi[0]) > 1 else 200.0
        except (TypeError, ValueError, IndexError):
            resolution = 200.0
        dest.parent.mkdir(parents=True, exist_ok=True)
        im.save(str(dest), "PDF", resolution=resolution)


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
        with pikepdf.open(str(path)) as out:
            return len(out.pages) == expected_pages
    except Exception:
        return False


def _copy_file(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and os.path.samefile(src, dest):
        raise RuntimeError("source and destination are the same file")
    if dest.exists():
        dest.chmod(0o666)
    shutil.copy2(src, dest)


def ocr_file(
    file: str,
    output: str,
    language: str = "eng",
    tesseract_path: str = "",
    gs_path: str = "gs",
) -> dict:
    """Make ONE file searchable — the single-file arm of the batch pipeline.

    SAME detection (_pages_needing_ocr), SAME recognition (recognize), SAME
    rect mapping (_to_pdf_rects), SAME writer (apply_ocr_layer, which already
    handles output == file with a true-identity temp+rename) — COMPOSED
    beside batch_ocr from the shared helpers rather than extracted from it,
    so the batch loop's verified behavior is untouched. Built for the
    guided-actions OCR step (slice 2); also the CLI's `ocr-file` arm.

    A file with nothing that looks like a scan is reported, not rewritten:
    in-place → no write at all; to a distinct output → a byte copy.
    """
    input_path = Path(file)
    output_path = Path(output)
    try:
        same = output_path.exists() and os.path.samefile(input_path, output_path)
    except OSError:
        same = False

    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        needing = _pages_needing_ocr(file, pdf)

    if not needing:
        if not same:
            _copy_file(input_path, output_path)
        return {
            "output": str(output_path),
            "pages_total": total,
            "pages_ocrd": 0,
            "skipped": "no scanned pages",
        }

    pages: list[dict] = []
    for i in needing:
        got = recognize(file, i + 1, language, tesseract_path, gs_path)
        words = _to_pdf_rects(file, i, got["words"])
        if words:
            pages.append({"page": i + 1, "words": words})

    if not pages:
        if not same:
            _copy_file(input_path, output_path)
        return {
            "output": str(output_path),
            "pages_total": total,
            "pages_ocrd": 0,
            "skipped": "no text recognized",
        }

    apply_ocr_layer(file, str(output_path), pages)
    return {
        "output": str(output_path),
        "pages_total": total,
        "pages_ocrd": len(pages),
    }


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
) -> dict:
    """Mirror a folder of PDFs into searchable copies — or, with `in_place`,
    REPLACE each original with its searchable version (O7 in-place batch
    mode). In-place output goes through a staged temp beside the original
    and only replaces it after the verify-read succeeds, so a crash or a bad
    write can never leave a half-written original. Returns the report.

    P3 — `passwords` maps a source's RELATIVE path (or its bare file name) to
    the password that opens it. Supplied UP FRONT rather than prompted:
    a batch is exactly the run that has nobody to ask — a scheduled job under
    a service account has no desktop — so the credential has to arrive with
    the request. A file with no entry keeps the shipped behaviour and is
    skipped as `password-protected`, which is what lets a caller run once,
    read the report, and re-run just the files it now has passwords for.

    P3 — `include_images` adds loose image files (PNG/JPEG/TIFF/BMP) to the
    sweep. Each is wrapped into a one-page PDF at its own natural size and
    then travels the identical path; the mirrored name gains `.pdf` rather
    than replacing the extension, so `invoice.tif` and `invoice.pdf` in one
    folder cannot collide."""
    source_path = Path(source).resolve()
    if not source_path.is_dir():
        raise ValueError(f"Source folder not found: {source}")
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

    for index, (abs_path, rel) in enumerate(entries):
        if progress:
            print(f"[{index + 1}/{len(entries)}] {rel}", flush=True)
        # In place: write to a staged temp BESIDE the original; the tail
        # replaces the original only after the verify-read succeeds.
        # P3: an image's mirrored name GAINS `.pdf` rather than replacing the
        # extension — `invoice.tif` and `invoice.pdf` in one folder must not
        # collide, and the original name stays legible in the output.
        out_rel = rel + ".pdf" if _is_image(abs_path) else rel
        out_path = (
            abs_path.parent / f".{abs_path.name}.inplace.tmp" if in_place else dest_path / out_rel
        )
        result: dict | None = None
        scratch: Path | None = None
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
                # P3: an image becomes a one-page PDF FIRST, so everything
                # after this line is the shipped PDF path with no branch.
                scratch = out_path.parent / f".{out_path.stem}.image.tmp"
                try:
                    _image_to_pdf(abs_path, scratch)
                    source_for_open = scratch
                except Exception as exc:
                    scratch = None
                    result = {"rel": rel, "status": "skipped",
                              "reason": f"unreadable image: {exc}"}
            password = pw_map.get(os.path.normcase(rel)) or pw_map.get(
                os.path.normcase(os.path.basename(rel))
            )
            try:
                if result is not None:
                    raise _AlreadyHandled()
                pdf = (
                    pikepdf.open(str(source_for_open), password=password)
                    if password
                    else pikepdf.open(str(source_for_open))
                )
            except _AlreadyHandled:
                pdf = None
            except Exception as exc:
                classification = _classify_load_error(exc)
                # A password failure is not a repair candidate: a structural
                # rewrite cannot supply a password.
                if repair_damaged and classification != "password-protected":
                    scratch = out_path.parent / f".{out_path.stem}.repaired.tmp"
                    try:
                        scratch.parent.mkdir(parents=True, exist_ok=True)
                        repair(str(abs_path), str(scratch))
                        pdf = pikepdf.open(str(scratch))
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
                working = scratch if scratch is not None else abs_path
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
                        got = recognize(str(working), i + 1, lang, tesseract_path, gs_path)
                        words = _to_pdf_rects(str(working), i, got["words"])
                        if words:
                            pages.append({"page": i + 1, "words": words})
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

            # ── tail: verify, heal, move ────────────────────────────────
            if result is not None:
                if result["status"] != "skipped" and (
                    (in_place and result["status"] == "ocr")
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
                # atomically (same directory, os.replace). A skipped result
                # leaves the original untouched; the finally unlinks staging.
                if in_place and result["status"] == "ocr":
                    try:
                        os.replace(out_path, abs_path)
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
                            shutil.copy2(scratch, abs_path)
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
            if in_place:
                # Any staging that did not become the original is litter.
                out_path.unlink(missing_ok=True)

        if result is not None:
            results.append(result)

    report = {"cancelled": False, "results": results, "skippedDirs": skipped_dirs, "inPlace": in_place}
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
    )
    if log_path:
        report["logPath"] = log_path
    return report


def _to_pdf_rects(file: str, page_index: int, words: list[dict]) -> list[dict]:
    """Normalised display boxes -> PDF user-space rects (bottom-up).

    The renderer does this with `displayRectToPdf`; the same arithmetic, against
    the crop-intersected page box and its baked /Rotate.
    """
    with pikepdf.open(file) as pdf:
        page = pdf.pages[page_index]
        box = page.get("/CropBox") or page.get("/MediaBox") or [0, 0, 612, 792]
        x0, y0, x1, y1 = (float(v) for v in box)
        width = abs(x1 - x0)
        height = abs(y1 - y0)
        rotate = int(page.get("/Rotate", 0) or 0) % 360

    out: list[dict] = []
    for w in words:
        if not w["text"].strip():
            continue
        # Display space: x right, y DOWN from the top, fractions of the page as
        # rendered (i.e. after rotation).
        dw, dh = (height, width) if rotate in (90, 270) else (width, height)
        px = w["x"] * dw
        py = w["y"] * dh
        pw = w["w"] * dw
        ph = w["h"] * dh
        if rotate == 90:
            rect = [x0 + py, y0 + px, x0 + py + ph, y0 + px + pw]
        elif rotate == 180:
            rect = [x0 + width - px - pw, y0 + py, x0 + width - px, y0 + py + ph]
        elif rotate == 270:
            rect = [
                x0 + height - py - ph,
                y0 + width - px - pw,
                x0 + height - py,
                y0 + width - px,
            ]
        else:
            rect = [x0 + px, y0 + height - py - ph, x0 + px + pw, y0 + height - py]
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
    tag = f"[{r['status']}]".ljust(10)
    if r["status"] == "ocr":
        pages = r.get("pagesOcrd", 0)
        line = f"{tag}{r['rel']} — {pages} page{'' if pages == 1 else 's'} made searchable"
        if r.get("reason"):
            line += f" ({r['reason']})"
    else:
        line = f"{tag}{r['rel']} — {r['reason']}" if r.get("reason") else f"{tag}{r['rel']}"
    if r.get("repaired"):
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


def _describe_filing(moved: str, errors: str, repair_on: bool, replace_on: bool) -> str:
    parts = []
    if moved:
        parts.append(f"processed originals -> {moved}")
    if errors:
        parts.append(f"failed originals -> {errors}")
    if repair_on:
        parts.append(
            "repair damaged files (replacing the originals)"
            if replace_on
            else "repair damaged files"
        )
    return " · ".join(parts) if parts else "none (source folder untouched)"


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
) -> str:
    """Write the run log. Best-effort: a failed log never fails the batch."""
    if not log_dir:
        return ""
    results = report["results"]
    ocrd = sum(1 for r in results if r["status"] == "ocr")
    copied_clean = sum(1 for r in results if r["status"] == "copied" and not r.get("reason"))
    copied_notext = sum(1 for r in results if r["status"] == "copied" and r.get("reason"))
    skipped = sum(1 for r in results if r["status"] == "skipped")

    duration = (finished_at - started_at).total_seconds() * 1000
    lines = [
        "Spectra PDF — Batch OCR log",
        f"Started:      {_format_timestamp(started_at)}",
        f"Finished:     {_format_timestamp(finished_at)}  ({_format_duration(duration)})",
        f"Source:       {source}",
        f"Destination:  {dest}",
        f"Languages:    {lang}",
        f"Filing:       {_describe_filing(moved_root, error_root, repair_damaged, replace_repaired)}",
        "Result:       completed",
        "",
        f"Files: {len(results)} processed — {ocrd} made searchable · "
        f"{copied_clean} copied (already searchable) · "
        f"{copied_notext} copied (no text recognized) · {skipped} skipped",
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
    lines.append("")

    try:
        directory = Path(log_dir)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / batch_log_file_name(started_at)
        path.write_text("\r\n".join(lines), encoding="utf-8")
        return str(path)
    except Exception:
        return ""
