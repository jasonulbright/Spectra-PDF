"""PDF split operations using pikepdf.

Four modes, ONE writer. `ranges` (a range expression), `every_n` (a fixed
page count per output), `size` (a byte cap per output) and `bookmarks` (one
output per top-level outline entry) all reduce to a list of 0-based page
index lists, and every one of those lists goes through `_render_part`. The
AcroForm carry therefore cannot be forgotten by a mode: there is no other
way to produce an output.
"""

import io
from pathlib import Path

import pikepdf

from engine.acroform import (
    carry_doc_form_extras,
    carry_pure_data_fields,
    prune_form_to_pages,
    refresh_sig_flags,
    refuse_if_xfa,
)
from engine.fs_names import safe_file_name, unique_name

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


def _render_part(file: str, page_indices: list[int]) -> bytes:
    """The serialized bytes of ONE output holding `page_indices`.

    The source is re-opened per part on purpose: `prune_form_to_pages`
    mutates the field tree of the open it is given, so a second part built
    from the same open would inherit the first part's prune and lose its own
    fields. A fresh open per part is what makes the prune safe to repeat.
    """
    with pikepdf.open(file) as pdf:
        # Prune form-field trees to the kept pages BEFORE copying — a
        # partially-selected multi-widget field would otherwise carry its
        # ENTIRE subtree, leaving phantom dead widgets for the excluded
        # pages' kids. This open is private; the file on disk is untouched.
        prune_form_to_pages(pdf, page_indices)
        result = pikepdf.Pdf.new()
        # Form-aware copy: registers the kept fields in the part's own
        # /AcroForm — a plain pages.append leaves every field orphaned
        # (rendered, dead). Widget-less pure-data fields and /SigFlags are
        # covered by the acroform helpers.
        copy = result.add_pages_from(pdf, pages=page_indices)
        pure_renames = carry_pure_data_fields(result, pdf)
        refresh_sig_flags(result)
        # /CO reconciled to the surviving copied fields; catalog /AA carried
        # whole. Single source, but same-name single-source fields can
        # still rename — feed both reports.
        renames = dict(copy.renamed_fields)
        renames.update({r["from"]: r["to"] for r in pure_renames})
        carry_doc_form_extras(result, pdf, renames)
        buf = io.BytesIO()
        result.save(buf)
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


def _bookmark_parts(file: str, page_count: int) -> list[tuple[list[int], str]]:
    """(page indices, title) per part, from the TOP-LEVEL outline entries.

    Nested entries do not open a part. Entries are taken in destination-page
    order so an outline written out of order still yields contiguous,
    non-overlapping parts, and two entries on one page yield ONE part (a
    zero-page output must never be materialized).
    """
    from engine.outline import _resolve_dest_array, _resolve_dest_page  # noqa: PLC0415

    starts: list[tuple[int, str]] = []
    with pikepdf.open(file) as pdf:
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


def _size_parts(file: str, page_count: int, cap: float) -> list[tuple[list[int], bytes]]:
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


def split(
    file: str,
    ranges: str = "",
    output_dir: str = "",
    mode: str = "ranges",
    every_n: int = 0,
    max_mb: float = 0.0,
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
    """
    if not output_dir:
        raise ValueError("split needs an output folder")
    if mode not in MODES:
        raise ValueError(f"split mode must be one of {', '.join(MODES)}, got {mode!r}")
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    outputs: list[str] = []
    oversize: list[dict] = []
    used: set[str] = set()
    pages_written = 0

    with pikepdf.open(file) as pdf:
        refuse_if_xfa(pdf, file, "splitting")
        page_count = len(pdf.pages)
    stem = Path(file).stem

    def take(name: str) -> Path:
        chosen = unique_name(name, used)
        used.add(chosen.lower())
        return output_path / chosen

    if mode == "ranges":
        page_indices = parse_ranges(ranges, page_count)
        out_file = output_path / f"split_{ranges.replace(',', '_')}.pdf"
        out_file.write_bytes(_render_part(file, page_indices))
        outputs.append(str(out_file))
        pages_written = len(page_indices)

    elif mode == "every_n":
        for part in _every_n_parts(page_count, every_n):
            out_file = take(_page_span_name(stem, part[0] + 1, part[-1] + 1))
            out_file.write_bytes(_render_part(file, part))
            outputs.append(str(out_file))
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
        for part, data in _size_parts(file, page_count, cap):
            out_file = take(_page_span_name(stem, part[0] + 1, part[-1] + 1))
            out_file.write_bytes(data)
            outputs.append(str(out_file))
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
            _bookmark_parts(file, page_count), start=1
        ):
            name = safe_file_name(title, "") or safe_file_name(stem, "document")
            out_file = take(f"{number:03d}_{name}.pdf")
            out_file.write_bytes(_render_part(file, part))
            outputs.append(str(out_file))
            pages_written += len(part)

    return {
        "outputs": outputs,
        "pages_extracted": pages_written,
        "mode": mode,
        "parts": len(outputs),
        "oversize": oversize,
    }
