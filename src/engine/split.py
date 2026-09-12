"""PDF split operations using pikepdf.

Four modes, ONE writer. `ranges` (a range expression), `every_n` (a fixed
page count per output), `size` (a byte cap per output) and `bookmarks` (one
output per top-level outline entry) all reduce to a list of 0-based page
index lists, and every one of those lists goes through `_render_part`. The
AcroForm carry therefore cannot be forgotten by a mode: there is no other
way to produce an output.
"""

import io
import hashlib
import os
import stat
import tempfile
from pathlib import Path

import pikepdf

from engine.acroform import refuse_if_xfa
from engine.page_copy import copy_pages_with_forms
from engine.fs_names import safe_file_name, unique_name
from engine.pdf_save import save_pdf

MODES = ("ranges", "every_n", "size", "bookmarks")

# An upload limit is quoted in decimal megabytes, so that is what max_mb is.
BYTES_PER_MB = 1_000_000


def parse_ranges(range_str: str, max_page: int) -> list[int]:
    """Parse a page range string like '1-5,10-15' into a list of 0-based page indices."""
    pages: list[int] = []
    for part in range_str.split(","):
        part = part.strip()
        if "-" in part:
            start, end = part.split("-", 1)
            start_idx = int(start) - 1
            end_idx = min(int(end), max_page)
            pages.extend(range(start_idx, end_idx))
        else:
            pages.append(int(part) - 1)
    return [p for p in pages if 0 <= p < max_page]


def _render_part(file: str | bytes, page_indices: list[int]) -> bytes:
    """The serialized bytes of ONE output holding `page_indices`.

    The source is re-opened per part on purpose: `prune_form_to_pages`
    mutates the field tree of the open it is given, so a second part built
    from the same open would inherit the first part's prune and lose its own
    fields. A fresh open per part is what makes the prune safe to repeat.
    """
    with pikepdf.open(io.BytesIO(file) if isinstance(file, bytes) else file) as pdf, pikepdf.Pdf.new() as result:
        # The shared copy boundary prunes before copying and registers all
        # selected pages' widgets through one field map, including repeats.
        copy_pages_with_forms(result, pdf, pages=page_indices)
        buf = io.BytesIO()
        # Every part is the source document minus pages, so each part carries
        # the source's own encryption; `result` is a fresh Pdf and knows
        # nothing about it.
        save_pdf(result, buf, encryption_source=pdf)
        return buf.getvalue()


def _page_span_name(stem: str, first: int, last: int) -> str:
    """`stem_3-7.pdf`, or `stem_3.pdf` for a single page. 1-based."""
    span = f"{first}" if first == last else f"{first}-{last}"
    return f"{safe_file_name(stem, 'document')}_{span}.pdf"


def _every_n_parts(page_count: int, every_n: int) -> list[list[int]]:
    try:
        n = int(every_n)
    except (TypeError, ValueError):
        raise ValueError(f"pages per file must be a whole number, got {every_n!r}") from None
    if n < 1:
        raise ValueError(f"pages per file must be at least 1, got {every_n}")
    return [list(range(i, min(i + n, page_count))) for i in range(0, page_count, n)]


def _bookmark_parts(file: str | bytes, page_count: int) -> list[tuple[list[int], str]]:
    """(page indices, title) per part, from the TOP-LEVEL outline entries.

    Nested entries do not open a part. Entries are taken in destination-page
    order so an outline written out of order still yields contiguous,
    non-overlapping parts, and two entries on one page yield ONE part (a
    zero-page output must never be materialized).
    """
    from engine.outline import _resolve_dest_array, _resolve_dest_page  # noqa: PLC0415

    starts: list[tuple[int, str]] = []
    with pikepdf.open(io.BytesIO(file) if isinstance(file, bytes) else file) as pdf:
        with pdf.open_outline() as outline:
            for item in outline.root:
                page = _resolve_dest_page(pdf, _resolve_dest_array(pdf, item))
                if page is None or not 0 <= page < page_count:
                    continue
                title = str(item.title) if item.title is not None else ""
                starts.append((page, title))
    if not starts:
        raise ValueError("this document has no top-level bookmarks to split at")

    starts.sort(key=lambda s: s[0])
    # Two entries on the same page: the first one's title names the part.
    deduped: list[tuple[int, str]] = []
    for page, title in starts:
        if deduped and deduped[-1][0] == page:
            continue
        deduped.append((page, title))

    parts: list[tuple[list[int], str]] = []
    # Pages ahead of the first bookmark are a part of their own — dropping
    # them would lose pages, and the first bookmark's title would mislabel
    # them. The source document's own name is the honest title (the caller
    # substitutes it for the empty one).
    if deduped[0][0] > 0:
        parts.append((list(range(0, deduped[0][0])), ""))
    for i, (page, title) in enumerate(deduped):
        end = deduped[i + 1][0] if i + 1 < len(deduped) else page_count
        parts.append((list(range(page, end)), title))
    return parts


def _size_parts(file: str | bytes, page_count: int, cap: float) -> list[tuple[list[int], bytes]]:
    """Greedy page accumulation under a byte cap: (page indices, bytes) each.

    Each candidate part is really serialized before a page is committed to
    it. A page's contribution is not additive — shared resources (one font
    program, one background image) are written once per OUTPUT file — so an
    estimate built from per-page object sizes is wrong in both directions,
    and a cap derived from it is not a cap.
    """
    parts: list[tuple[list[int], bytes]] = []
    current: list[int] = []
    current_bytes = b""
    for index in range(page_count):
        trial = current + [index]
        data = _render_part(file, trial)
        if len(data) > cap and current:
            # The page does not fit: close the part at its last known-good
            # bytes and let the page open the next one.
            parts.append((current, current_bytes))
            current, current_bytes = [index], _render_part(file, [index])
        else:
            current, current_bytes = trial, data
        if len(current) == 1 and len(current_bytes) > cap:
            # One page over the cap on its own. It is written alone at
            # whatever size it comes to: a page is the atom, so there is
            # nothing smaller to fall back to, and refusing the document
            # would destroy every other page's correct work.
            parts.append((current, current_bytes))
            current, current_bytes = [], b""
    if current:
        parts.append((current, current_bytes))
    return parts


def _destination_stamp(path: Path):
    """A missing output is distinct from an unreadable/non-file destination."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Cannot replace a non-regular split destination: {path}")
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _assert_destination(path: Path, stamp) -> None:
    if _destination_stamp(path) != stamp:
        raise ValueError(f"Split destination changed before publication: {path}")


def _install_new(staged: Path, path: Path) -> None:
    """Publish to an absent name, refusing a file created after our last check."""
    if os.name == 'nt':
        # Windows rename fails if the destination exists (unlike replace).
        os.rename(staged, path)
    else:
        # POSIX rename would clobber. Both paths are on the same filesystem;
        # link atomically claims an absent name, with the stage cleaned later.
        os.link(staged, path)


def _publish_parts(file: str, planned: list[tuple[Path, list[int], bytes | None]],
                   source_bytes: bytes) -> list[str]:
    """Build every part before changing any destination; roll back failed publication.

    Backups stay beside their targets. If restoration itself fails, retain the
    backup and report its location rather than cleaning up the only old copy.
    This is exception-safe publication, not a claim of power-loss atomicity
    across multiple filesystem directory entries.
    """
    source = Path(file)
    stamps = []
    resolved = set()
    existing = set()
    for path, _, _ in planned:
        stamp = _destination_stamp(path)
        # samefile is authoritative for hard links, case/short-path aliases and
        # mapped-drive spellings. An identity read error is a refusal, not False.
        if path.resolve() == source.resolve() or stamp is not None and os.path.samefile(source, path):
            raise ValueError(f"Split output must not replace its source: {path}")
        canonical = path.resolve()
        if canonical in resolved or stamp is not None and stamp[:2] in existing:
            raise ValueError(f"Split destinations must identify different files: {path}")
        resolved.add(canonical)
        if stamp is not None:
            existing.add(stamp[:2])
        stamps.append(stamp)
    records = []

    def cleanup(committed: bool) -> list[str]:
        retained = []
        for record in records:
            candidates = [record['staged']]
            backup = record['backup']
            if backup is not None:
                # A failed or unprovable restore must never delete the old copy.
                if committed or not record['backed']:
                    candidates.append(backup)
                else:
                    retained.append(str(backup))
            for candidate in candidates:
                try:
                    candidate.unlink(missing_ok=True)
                except OSError:
                    retained.append(str(candidate))
        return retained

    try:
        for (path, pages, data), stamp in zip(planned, stamps):
            fd, name = tempfile.mkstemp(prefix='.spectra-split-', suffix='.pdf', dir=path.parent)
            record = dict(path=path, staged=Path(name), stamp=stamp, backup=None, backed=False,
                          backup_stamp=None, published=False, staged_stamp=None)
            records.append(record)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(_render_part(source_bytes, pages) if data is None else data)
                stream.flush()
                os.fsync(stream.fileno())
            record['staged_stamp'] = _destination_stamp(record['staged'])

        # Every render sees one immutable snapshot, including size trials and
        # bookmark planning. Refuse if the source changed while staging.
        with source.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').digest() != hashlib.sha256(source_bytes).digest():
                raise ValueError("Split source changed during preparation")
        # No rendering remains after this point. Re-prove every
        # original before starting, and each destination before its own move.
        for record in records:
            _assert_destination(record['path'], record['stamp'])
        for record in records:
            path = record['path']
            _assert_destination(path, record['stamp'])
            if record['stamp'] is not None:
                fd, name = tempfile.mkstemp(prefix='.spectra-split-', suffix='.backup', dir=path.parent)
                os.close(fd)
                record['backup'] = Path(name)
                record['backup_stamp'] = _destination_stamp(record['backup'])
                # Conservatively retain it until the move/restore is proven;
                # cancellation can occur after rename but before its return.
                record['backed'] = True
                os.replace(path, record['backup'])
            _install_new(record['staged'], path)
            record['published'] = True
    except BaseException as original:
        recovery = []
        for record in reversed(records):
            try:
                # A filesystem call may have completed before cancellation
                # reaches Python; the durable identities, not the next flag
                # assignment alone, decide which moves must be unwound.
                backup = record['backup']
                current = _destination_stamp(record['path'])
                if backup is not None:
                    backup_stamp = _destination_stamp(backup)
                    if backup_stamp == record['stamp']:
                        record['backed'] = True
                    elif current == record['stamp'] and backup_stamp in (None, record['backup_stamp']):
                        # Either the backup move never happened, or a restore
                        # completed before an interrupted call returned.
                        record['backed'] = False
                    else:
                        # Missing/corrupt recovery data is not proof that the
                        # original was never moved. Keep all surviving copies.
                        record['backed'] = True
                        raise OSError('The original split destination could not be recovered')
                owned_output = record['staged_stamp'] is not None and current == record['staged_stamp']
                if record['backed']:
                    if current is not None and not owned_output:
                        raise OSError('Destination no longer belongs to this split publication')
                    os.replace(record['backup'], record['path'])
                    record['backed'] = False
                elif owned_output:
                    record['path'].unlink()
                record['published'] = False
            except (OSError, ValueError) as failure:
                try:
                    if record['backup'] is not None and _destination_stamp(record['path']) == record['stamp'] \
                            and _destination_stamp(record['backup']) is None:
                        record['backed'] = False
                        continue
                except (OSError, ValueError):
                    pass
                recovery.append(f"{record['path']} (backup: {record['backup']}): {failure}")
        retained = cleanup(False)
        if recovery or retained:
            details = '; '.join(recovery + retained)
            raise RuntimeError(f"Split publication failed; retained recovery files: {details}") from original
        raise
    # Cleanup is after the publication commit point. A leftover backup cannot
    # turn a successfully published result into a falsely reported failure.
    return cleanup(True)


def split(
    file: str,
    ranges: str = "",
    output_dir: str = "",
    mode: str = "ranges",
    every_n: int = 0,
    max_mb: float = 0.0,
    output: str = "",
) -> dict:
    """Split a PDF into separate files.

    Args:
        file: Input PDF.
        ranges: Range expression, e.g. ``"1-5,10-15"`` (``ranges`` mode).
            Kept in the second position so the shipped positional call
            ``split(file, ranges, output_dir)`` still means what it did.
        output_dir: Destination folder (created if missing).
        mode: One of ``ranges``, ``every_n``, ``size``, ``bookmarks``.
        every_n: Pages per output (``every_n`` mode).
        max_mb: Byte cap per output, in decimal MB (``size`` mode). A page
            that exceeds the cap ON ITS OWN is written as its own output at
            whatever size it comes to and reported in ``oversize``.
        output: Exact destination selected for ``ranges`` mode. When absent,
            directory-based callers retain the generated range filename.
    """
    if not output_dir and not output:
        raise ValueError("split needs an output folder")
    if mode not in MODES:
        raise ValueError(f"split mode must be one of {', '.join(MODES)}, got {mode!r}")
    if output and mode != "ranges":
        raise ValueError("An exact split output is only valid for page ranges")
    if output and output_dir:
        raise ValueError("Choose either an exact split output or an output folder")
    output_path = Path(output).parent if output else Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    outputs: list[str] = []
    oversize: list[dict] = []
    used: set[str] = set()
    pages_written = 0
    planned: list[tuple[Path, list[int], bytes | None]] = []

    # Each Pdf open gets a fresh stream over the same bytes: form pruning is
    # private, and a writer outside the app cannot change later split parts.
    with open(file, 'rb') as stream:
        before = os.fstat(stream.fileno())
        source_bytes = stream.read()
        after = os.fstat(stream.fileno())
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("Split source changed during preparation")
    with pikepdf.open(io.BytesIO(source_bytes)) as pdf:
        refuse_if_xfa(pdf, file, "splitting")
        page_count = len(pdf.pages)
    if page_count == 0:
        raise ValueError("Cannot split a document without pages")
    stem = Path(file).stem

    def take(name: str) -> Path:
        chosen = unique_name(name, used)
        used.add(chosen.lower())
        return output_path / chosen

    if mode == "ranges":
        page_indices = parse_ranges(ranges, page_count)
        if not page_indices:
            raise ValueError("The split range selects no pages")
        out_file = Path(output) if output else output_path / f"split_{ranges.replace(',', '_')}.pdf"
        planned.append((out_file, page_indices, None))
        pages_written = len(page_indices)

    elif mode == "every_n":
        for part in _every_n_parts(page_count, every_n):
            out_file = take(_page_span_name(stem, part[0] + 1, part[-1] + 1))
            planned.append((out_file, part, None))
            pages_written += len(part)

    elif mode == "size":
        try:
            cap = float(max_mb) * BYTES_PER_MB
        except (TypeError, ValueError):
            raise ValueError(
                f"maximum file size must be a number, got {max_mb!r}"
            ) from None
        if not cap > 0:
            raise ValueError(f"maximum file size must be greater than 0, got {max_mb}")
        for part, data in _size_parts(source_bytes, page_count, cap):
            out_file = take(_page_span_name(stem, part[0] + 1, part[-1] + 1))
            planned.append((out_file, part, data))
            pages_written += len(part)
            if len(data) > cap:
                oversize.append(
                    {
                        "output": str(out_file),
                        "pages": [p + 1 for p in part],
                        "bytes": len(data),
                    }
                )

    else:  # bookmarks
        for number, (part, title) in enumerate(
            _bookmark_parts(source_bytes, page_count), start=1
        ):
            name = safe_file_name(title, "") or safe_file_name(stem, "document")
            out_file = take(f"{number:03d}_{name}.pdf")
            planned.append((out_file, part, None))
            pages_written += len(part)

    retained = _publish_parts(file, planned, source_bytes)
    outputs = [str(path) for path, _, _ in planned]
    return {
        "outputs": outputs,
        "pages_extracted": pages_written,
        "mode": mode,
        "parts": len(outputs),
        "oversize": oversize,
        "retained_files": retained,
    }
