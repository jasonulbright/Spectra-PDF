"""Comparison between two PDFs: text diff and visual (pixel) diff.

Text: extracts text per page (pdfminer, the same path as extract_text), then
diffs the two documents' line lists with Python's stdlib ``difflib`` — no new
dependency, and the text already lives on the Python side. Output is a
unified-diff-style row list (context / add / remove / gap) with each row
attributed to its source page, plus a summary (similarity, counts, page
counts). Rows from similar replaced-line pairs additionally carry word-level
``segments`` for intra-line highlighting. Read-only: neither file is modified.

Visual: rasterizes both files with the bundled Ghostscript (``ppmraw`` — PPM
P6 is a trivial stdlib parse: header + raw RGB bytes, no PIL/numpy/PNG
dependency) and pixel-diffs page pairs 1:1 by index, reporting per-pair diff
counts and changed-region rectangles in PDF points. Engine-side deliberately —
GUI and CLI share one implementation (parity invariant), and it works for
scanned/image PDFs that the text diff cannot see. Both documents render with
the same gs build and settings in the same run, so identical content produces
identical bytes and the default tolerance is 0.

Deliberately stdlib difflib rather than the roadmap's suggested
`diff-match-patch` / `similar` crate, and deliberately Ghostscript-side rather
than the suggested renderer-side `pixelmatch` — see
docs/architecture/09-phase2g-compare.md for both rationales.
"""

import difflib
import re
import subprocess
import tempfile
from pathlib import Path

import pikepdf
from pdfminer.high_level import extract_text as pdfminer_extract

# Bound the row payload for pathological diffs. Counts/similarity in the
# summary stay exact past this — only the row detail is truncated.
MAX_ROWS = 5000

# Only line pairs at least this similar (SequenceMatcher char ratio) get
# word-level intra-line segments; below it, segments are confetti and the
# rows stay whole-line.
INTRALINE_MIN_RATIO = 0.5

# Changed rows within this many rows of each other merge into one region band.
REGION_ROW_GAP = 2

# Regions per page are capped by merging the nearest bands — the union always
# covers every changed pixel (over-cover, never drop).
MAX_REGIONS_PER_PAGE = 20

# Visual compare renders in CHUNKS of pages (gs -dFirstPage/-dLastPage) and
# deletes each chunk's rasters after diffing, so temp-disk peak stays bounded
# regardless of document length (uncompressed PPM is ~1.45MB per Letter page
# at 72 dpi — a large scanned document rendered whole would write gigabytes).
# The first chunk is a small probe; subsequent chunk size adapts to the
# measured bytes/page against the byte budget.
CHUNK_PROBE_PAGES = 8
CHUNK_BYTE_BUDGET = 256 * 1024 * 1024
CHUNK_MAX_PAGES = 64


def _page_count(file: str) -> int:
    with pikepdf.open(file) as pdf:
        return len(pdf.pages)


def _extract_lines(file: str) -> tuple[list[str], list[int], int]:
    """(lines, page_of_line, page_count). Each line is strip()-normalized;
    blank lines are dropped (pdfminer's layout output is whitespace-noisy and
    content comparison shouldn't flag spacing). page_of_line[i] is the 1-based
    page line i came from."""
    count = _page_count(file)
    lines: list[str] = []
    page_of: list[int] = []
    for i in range(count):
        text = pdfminer_extract(file, page_numbers={i})
        for raw in text.split("\n"):
            line = raw.strip()
            if not line:
                continue
            lines.append(line)
            page_of.append(i + 1)
    return lines, page_of, count


def _intraline_segments(line_a: str, line_b: str) -> tuple[list, list] | None:
    """Word-level diff of one replaced-line pair, or None when the lines are
    too dissimilar for intra-line highlighting to be readable. Returns
    (segments_a, segments_b), each ``[[text, changed], ...]`` with adjacent
    same-flag tokens merged; ``"".join`` of the texts reconstructs the line."""
    if difflib.SequenceMatcher(a=line_a, b=line_b, autojunk=False).ratio() < INTRALINE_MIN_RATIO:
        return None
    tokens_a = re.findall(r"\S+|\s+", line_a)
    tokens_b = re.findall(r"\S+|\s+", line_b)
    seg_a: list = []
    seg_b: list = []

    def push(segments: list, text: str, changed: bool) -> None:
        if segments and segments[-1][1] == changed:
            segments[-1][0] += text
        else:
            segments.append([text, changed])

    matcher = difflib.SequenceMatcher(a=tokens_a, b=tokens_b, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for t in tokens_a[i1:i2]:
                push(seg_a, t, False)
            for t in tokens_b[j1:j2]:
                push(seg_b, t, False)
        else:
            for t in tokens_a[i1:i2]:
                push(seg_a, t, True)
            for t in tokens_b[j1:j2]:
                push(seg_b, t, True)
    return seg_a, seg_b


def compare_text(file_a: str, file_b: str, context: int = 3) -> dict:
    """Diff the extracted text of two PDFs.

    Args:
        file_a: First (baseline) PDF path.
        file_b: Second (changed) PDF path.
        context: Unchanged lines of context to keep around each change; longer
            equal runs collapse to a single gap marker.
    """
    lines_a, page_a, count_a = _extract_lines(file_a)
    lines_b, page_b, count_b = _extract_lines(file_b)

    matcher = difflib.SequenceMatcher(a=lines_a, b=lines_b, autojunk=False)
    rows: list[dict] = []
    added = 0
    removed = 0
    truncated = False

    def emit(row: dict) -> None:
        nonlocal truncated
        if len(rows) >= MAX_ROWS:
            truncated = True
            return
        rows.append(row)

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            n = i2 - i1
            if n <= 2 * context + 1:
                for k in range(i1, i2):
                    emit({"type": "context", "text": lines_a[k], "page": page_a[k]})
            else:
                for k in range(i1, i1 + context):
                    emit({"type": "context", "text": lines_a[k], "page": page_a[k]})
                emit({"type": "gap", "count": n - 2 * context})
                for k in range(i2 - context, i2):
                    emit({"type": "context", "text": lines_a[k], "page": page_a[k]})
        elif tag == "delete":
            for k in range(i1, i2):
                removed += 1
                emit({"type": "remove", "text": lines_a[k], "page": page_a[k]})
        elif tag == "insert":
            for k in range(j1, j2):
                added += 1
                emit({"type": "add", "text": lines_b[k], "page": page_b[k]})
        elif tag == "replace":
            # Pair removed/added lines positionally (k-th with k-th) for
            # intra-line word segments — the common case (a word edited in a
            # line) is an equal-length block where positional pairing is
            # right. Unpaired extras and dissimilar pairs stay whole-line.
            pair_count = min(i2 - i1, j2 - j1)
            segments: dict[int, tuple[list, list]] = {}
            for k in range(pair_count):
                pair = _intraline_segments(lines_a[i1 + k], lines_b[j1 + k])
                if pair is not None:
                    segments[k] = pair
            for k in range(i1, i2):
                removed += 1
                row = {"type": "remove", "text": lines_a[k], "page": page_a[k]}
                if (k - i1) in segments:
                    row["segments"] = segments[k - i1][0]
                emit(row)
            for k in range(j1, j2):
                added += 1
                row = {"type": "add", "text": lines_b[k], "page": page_b[k]}
                if (k - j1) in segments:
                    row["segments"] = segments[k - j1][1]
                emit(row)

    return {
        "summary": {
            "identical": added == 0 and removed == 0,
            "similarity": round(matcher.ratio(), 4),
            "lines_added": added,
            "lines_removed": removed,
            "pages_a": count_a,
            "pages_b": count_b,
            "truncated": truncated,
        },
        "rows": rows,
    }


# ── Visual (pixel) diff ───────────────────────────────────────────────────


def _render_ppm_range(
    file: str, dpi: int, gs_path: str, out_dir: Path, prefix: str, first: int, last: int
) -> list[Path]:
    """Rasterize pages first..last (1-based, inclusive) of `file` to PPM P6
    via one Ghostscript call. Returns the page files in page order.

    A SHORT result (fewer files than requested, returncode 0) means the
    document ENDED inside the range — verified gs semantics: -dLastPage beyond
    EOF renders to the real last page with rc 0; -dFirstPage beyond EOF
    renders zero files with rc 0; a mid-document processing failure exits
    NONZERO (raised here). Callers use short results for end-of-document
    discovery — page counting deliberately shares this exact mechanism (and
    binary, and code path) with the diff rendering itself, so "how many pages"
    can never disagree with "what renders". NOTE: gs's %d output counter
    restarts at 1 per invocation; the caller owns mapping file j back to real
    page first + j - 1."""
    cmd = [
        gs_path,
        "-sDEVICE=ppmraw",
        f"-r{dpi}",
        f"-dFirstPage={first}",
        f"-dLastPage={last}",
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        "-dQUIET",
        f"-sOutputFile={out_dir / (prefix + '-%d.ppm')}",
        str(file),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(f"Ghostscript render failed for {Path(file).name}: {stderr[-500:]}")
    return sorted(
        out_dir.glob(f"{prefix}-*.ppm"),
        key=lambda p: int(p.stem.rsplit("-", 1)[1]),
    )


# Tail counting renders at the cheapest resolution — page ENUMERATION doesn't
# depend on dpi, and the rasters are deleted unread.
TAIL_COUNT_DPI = 36
TAIL_COUNT_CHUNK = 32


def _count_pages_by_rendering(file: str, gs_path: str, out_dir: Path, prefix: str, start: int) -> int:
    """Exact page count of `file` from page `start` on, discovered by chunked
    minimal-dpi rendering (files deleted unread). Used for the LONGER side's
    unpaired tail when the paired loop ended on the other document — keeps
    page counting on the renderer's own mechanism instead of a second one
    (pikepdf page trees or gs's pdfpagecount one-liner can both disagree with
    what gs actually renders; a soft-failing counter that reports 0 for
    garbage would make two unreadable files compare "identical")."""
    total = start - 1
    s = start
    idx = 0
    while True:
        e = s + TAIL_COUNT_CHUNK - 1
        files = _render_ppm_range(file, TAIL_COUNT_DPI, gs_path, out_dir, f"{prefix}{idx}", s, e)
        n = len(files)
        for p in files:
            p.unlink(missing_ok=True)
        total = s + n - 1 if n else total
        if n < TAIL_COUNT_CHUNK:
            return total
        s = e + 1
        idx += 1


def _read_ppm(path: Path) -> tuple[int, int, bytes]:
    """Parse a binary PPM (P6): returns (width, height, raw RGB bytes).
    Header tokens are whitespace-separated with '#'-to-EOL comments; a single
    whitespace byte separates the maxval from the pixel data."""
    data = path.read_bytes()
    tokens: list[bytes] = []
    i = 0
    n = len(data)
    while len(tokens) < 4 and i < n:
        c = data[i : i + 1]
        if c == b"#":
            while i < n and data[i : i + 1] not in (b"\n", b"\r"):
                i += 1
        elif c.isspace():
            i += 1
        else:
            start = i
            while i < n and not data[i : i + 1].isspace() and data[i : i + 1] != b"#":
                i += 1
            tokens.append(data[start:i])
    if len(tokens) < 4 or tokens[0] != b"P6":
        raise ValueError(f"Not a binary PPM (P6): {path.name}")
    width, height, maxval = int(tokens[1]), int(tokens[2]), int(tokens[3])
    if maxval != 255:
        raise ValueError(f"Unsupported PPM maxval {maxval} (expected 255)")
    # STRICT framing: exactly one whitespace byte after maxval, then exactly
    # width*height*3 pixel bytes to EOF. gs_path is user-configurable, so a
    # non-conformant producer is possible — but no tolerance scheme is sound:
    # surplus bytes BEFORE the raster (e.g. CRLF separator) and surplus bytes
    # AFTER it (e.g. a trailing newline) are indistinguishable by length
    # arithmetic whenever the true first pixel byte happens to be whitespace-
    # valued (0x09–0x0D/0x20 — ordinary dark-pixel values), and guessing wrong
    # silently shifts the whole buffer into a bogus-but-plausible diff. A loud
    # rejection is strictly better than a coin-flip for a diff tool. The
    # bundled Ghostscript always writes this exact framing.
    if i >= n or not data[i : i + 1].isspace():
        raise ValueError(f"Malformed PPM header (missing separator after maxval): {path.name}")
    i += 1
    body_len = width * height * 3
    if n - i != body_len:
        raise ValueError(
            f"Malformed PPM data: expected exactly {body_len} pixel bytes after the header, "
            f"found {n - i}: {path.name}"
        )
    return width, height, data[i : i + body_len]


def _pad_rgb(pixels: bytes, width: int, height: int, out_w: int, out_h: int) -> bytes:
    """Pad an RGB buffer to out_w×out_h with white (top-left anchored)."""
    if width == out_w and height == out_h:
        return pixels
    row_pad = b"\xff" * ((out_w - width) * 3)
    rows = []
    for y in range(height):
        start = y * width * 3
        rows.append(pixels[start : start + width * 3] + row_pad)
    white_row = b"\xff" * (out_w * 3)
    rows.extend(white_row for _ in range(out_h - height))
    return b"".join(rows)


def _scan_row(row_a: bytes, row_b: bytes, tolerance: int) -> tuple[int, int, int]:
    """(changed_count, min_x, max_x) for one differing row of RGB pixels."""
    count = 0
    min_x = -1
    max_x = -1
    for x in range(0, len(row_a), 3):
        if tolerance == 0:
            changed = row_a[x : x + 3] != row_b[x : x + 3]
        else:
            changed = (
                abs(row_a[x] - row_b[x]) > tolerance
                or abs(row_a[x + 1] - row_b[x + 1]) > tolerance
                or abs(row_a[x + 2] - row_b[x + 2]) > tolerance
            )
        if changed:
            px = x // 3
            count += 1
            if min_x < 0:
                min_x = px
            max_x = px
    return count, min_x, max_x


def _merge_two_nearest(bands: list[dict]) -> None:
    """Merge the pair of consecutive bands with the smallest vertical gap
    (bands are kept sorted by y)."""
    best = 0
    best_gap = None
    for i in range(len(bands) - 1):
        gap = bands[i + 1]["y0"] - bands[i]["y1"]
        if best_gap is None or gap < best_gap:
            best_gap = gap
            best = i
    a, b = bands[best], bands[best + 1]
    a["y1"] = b["y1"]
    a["x0"] = min(a["x0"], b["x0"])
    a["x1"] = max(a["x1"], b["x1"])
    del bands[best + 1]


def _diff_pair(a: tuple[int, int, bytes], b: tuple[int, int, bytes], tolerance: int) -> dict:
    """Pixel-diff one page pair. Returns diff counts and changed-region bands
    (raster-pixel space)."""
    out_w = max(a[0], b[0])
    out_h = max(a[1], b[1])
    total = out_w * out_h
    pa = _pad_rgb(a[2], a[0], a[1], out_w, out_h)
    pb = _pad_rgb(b[2], b[0], b[1], out_w, out_h)
    if pa == pb:
        return {"diff_pixels": 0, "total_pixels": total, "bands": [], "width_px": out_w, "height_px": out_h}

    row_len = out_w * 3
    diff_pixels = 0
    bands: list[dict] = []
    va = memoryview(pa)
    vb = memoryview(pb)
    for y in range(out_h):
        row_a = va[y * row_len : (y + 1) * row_len]
        row_b = vb[y * row_len : (y + 1) * row_len]
        if row_a == row_b:
            continue
        count, min_x, max_x = _scan_row(bytes(row_a), bytes(row_b), tolerance)
        if count == 0:
            continue  # sub-tolerance noise only
        diff_pixels += count
        if bands and y - bands[-1]["y1"] <= REGION_ROW_GAP:
            band = bands[-1]
            band["y1"] = y
            band["x0"] = min(band["x0"], min_x)
            band["x1"] = max(band["x1"], max_x)
        else:
            bands.append({"y0": y, "y1": y, "x0": min_x, "x1": max_x})

    while len(bands) > MAX_REGIONS_PER_PAGE:
        _merge_two_nearest(bands)

    return {"diff_pixels": diff_pixels, "total_pixels": total, "bands": bands, "width_px": out_w, "height_px": out_h}


def compare_visual(
    file_a: str,
    file_b: str,
    dpi: int = 72,
    tolerance: int = 0,
    gs_path: str = "gs",
) -> dict:
    """Pixel-diff two PDFs page by page (paired 1:1 by index).

    Args:
        file_a: First (baseline) PDF path.
        file_b: Second (changed) PDF path.
        dpi: Raster resolution (36–300). 72 makes 1 px = 1 pt.
        tolerance: Per-channel delta (0–255) a pixel must exceed to count as
            changed. 0 (exact) is correct here: both files render with the
            same Ghostscript build and settings in the same run.
        gs_path: Path to the Ghostscript executable.

    Read-only. Returns per-pair diff counts and changed-region rectangles in
    PDF points (y from the top of the rendered page — the same orientation
    pdf.js renders, so the GUI overlays them with a pure scale factor).
    """
    dpi = int(dpi)
    if not (36 <= dpi <= 300):
        raise ValueError("dpi must be between 36 and 300.")
    tolerance = int(tolerance)
    if not (0 <= tolerance <= 255):
        raise ValueError("tolerance must be between 0 and 255.")

    scale = 72.0 / dpi
    pages: list[dict] = []
    pairs_differing = 0

    # Structural page counts, used ONLY to cross-check the render-discovered
    # counts (see the disagreement-detector note in the loop below). Raises
    # loud on files pikepdf can't open — same dependency compare_text already
    # has, so visual and text compare accept the same input class.
    struct_count_a = _page_count(file_a)
    struct_count_b = _page_count(file_b)

    with tempfile.TemporaryDirectory(prefix="spectra-compare-") as tmp:
        out_dir = Path(tmp)
        chunk_size = CHUNK_PROBE_PAGES
        max_page_bytes = 0
        start = 1  # 1-based first page of the current chunk
        chunk_idx = 0
        # Document ends are DISCOVERED from the diff rendering itself: a chunk
        # that comes back short (rc 0) normally means that document ended
        # inside it (see _render_ppm_range). The COUNT OF RECORD is always the
        # renderer's — pikepdf counts can't be it (page-tree heuristics can
        # disagree with gs on malformed files → silent false-identical), and
        # gs's pdfpagecount one-liner can't either (fails SOFT: prints an
        # error plus a fallback "0" and exits 0 on garbage, which made two
        # unreadable files compare "identical"; its --permit-file-read flag
        # also splits on ';', breaking legitimate semicolon filenames). BUT a
        # short render is not PROOF of document end: gs's tree walk halts
        # silently (rc 0) at a damaged interior page-tree node, which would
        # truncate the compare and report real pages as missing. So pikepdf
        # serves as a DISAGREEMENT DETECTOR (below): render-discovered counts
        # must match the structural counts or the comparison refuses loudly.
        end_a: int | None = None
        end_b: int | None = None
        while end_a is None and end_b is None:
            end = start + chunk_size - 1
            requested = chunk_size
            # Distinct per-chunk prefixes so a leftover file from an earlier
            # chunk can never be globbed into a later one.
            files_a = _render_ppm_range(file_a, dpi, gs_path, out_dir, f"a{chunk_idx}", start, end)
            files_b = _render_ppm_range(file_b, dpi, gs_path, out_dir, f"b{chunk_idx}", start, end)
            na, nb = len(files_a), len(files_b)

            for j in range(min(na, nb)):
                max_page_bytes = max(max_page_bytes, files_a[j].stat().st_size, files_b[j].stat().st_size)
                img_a = _read_ppm(files_a[j])
                img_b = _read_ppm(files_b[j])
                d = _diff_pair(img_a, img_b, tolerance)
                identical = d["diff_pixels"] == 0
                if not identical:
                    pairs_differing += 1
                regions = [
                    {
                        "x": round(band["x0"] * scale, 2),
                        "y": round(band["y0"] * scale, 2),
                        "w": round((band["x1"] - band["x0"] + 1) * scale, 2),
                        "h": round((band["y1"] - band["y0"] + 1) * scale, 2),
                    }
                    for band in d["bands"]
                ]
                pages.append(
                    {
                        "page": start + j,
                        "identical": identical,
                        "diff_pixels": d["diff_pixels"],
                        "total_pixels": d["total_pixels"],
                        "diff_ratio": round(d["diff_pixels"] / d["total_pixels"], 6) if d["total_pixels"] else 0.0,
                        "regions": regions,
                        "width_pts": round(d["width_px"] * scale, 2),
                        "height_pts": round(d["height_px"] * scale, 2),
                    }
                )

            # This chunk's rasters are consumed — delete before rendering the
            # next chunk so temp-disk peak stays ~2 chunks, not the whole doc.
            for p in (*files_a, *files_b):
                p.unlink(missing_ok=True)

            # A short chunk pins that document's exact end.
            if na < requested:
                end_a = start + na - 1
            if nb < requested:
                end_b = start + nb - 1

            # Adapt the chunk size to the measured page size vs. the budget.
            if max_page_bytes > 0:
                chunk_size = max(1, min(CHUNK_MAX_PAGES, CHUNK_BYTE_BUDGET // max_page_bytes))
            start = end + 1
            chunk_idx += 1

        # The side that hadn't ended when pairing stopped gets its exact count
        # the same way — by rendering (minimal dpi, discarded). In the common
        # case (documents of equal length) both ends land in the same final
        # chunk and this costs nothing.
        count_a = end_a if end_a is not None else _count_pages_by_rendering(file_a, gs_path, out_dir, "ca", start)
        count_b = end_b if end_b is not None else _count_pages_by_rendering(file_b, gs_path, out_dir, "cb", start)

    # Disagreement detector: if the renderer's discovered count doesn't match
    # the structural count, the page tree is damaged in a way gs walks past
    # SILENTLY (rc 0) — proceeding would compare a truncated document and
    # report real pages as missing. Refuse loudly instead; the app's repair
    # tooling exists for exactly these files.
    for name, rendered, structural in (
        (Path(file_a).name, count_a, struct_count_a),
        (Path(file_b).name, count_b, struct_count_b),
    ):
        if rendered != structural:
            raise RuntimeError(
                f"Page structure of {name} looks damaged: its page tree lists "
                f"{structural} page(s) but Ghostscript could only render {rendered} — "
                f"a comparison would be silently incomplete. Repair the file first."
            )

    paired = min(count_a, count_b)
    for i in range(paired, count_a):
        pages.append({"page": i + 1, "only_in": "a"})
    for i in range(paired, count_b):
        pages.append({"page": i + 1, "only_in": "b"})

    return {
        "summary": {
            "identical": pairs_differing == 0 and count_a == count_b,
            "pages_a": count_a,
            "pages_b": count_b,
            "pairs_compared": paired,
            "pairs_differing": pairs_differing,
            "unpaired_a": max(0, count_a - paired),
            "unpaired_b": max(0, count_b - paired),
            "dpi": dpi,
        },
        "pages": pages,
    }
