"""Print-time page preparation: ordering, imposition, flatten, raster.

Everything driver-INDEPENDENT about the widened print contract lives here, as
pure math plus pikepdf/Ghostscript builders that turn the user's options into
one temporary, exactly-ordered, exactly-laid-out PDF that the mswinpr2 job
then prints verbatim:

- page ORDER (range in spec order, odd/even filter, reverse, uncollated
  copy duplication) — whole-page, same-Pdf sequence building, so annotations
  and form registration ride along untouched;
- ANNOTATION MODES (Document / Document and stamps) — a pikepdf strip of the
  not-kept subtypes, deliberately NOT a Ghostscript ShowAnnots flag: the
  strip is version-proof, unit-testable, and leaves Print-flag semantics for
  the kept annotations to the renderer stage;
- FLATTEN (imposition input) — gs pdfwrite -dPreserveAnnots=false -dPrinted:
  annotation appearances become page content with PRINT semantics (a
  viewer-only annotation does not survive; probe-pinned, see
  TestPrintPrepassSemantics);
- PRINT AS IMAGE — gs pdfimage24/pdfimage8 (page-per-image PDF), the
  compatibility path for documents whose vector content misprints;
- IMPOSITION (multiple-per-sheet, booklet, poster tiles, custom scale) —
  form-XObject placement onto sheet-sized pages. Imposition input is always
  the FLATTENED (or rasterized) document: XObject placement cannot carry
  live annotations, so they are baked into content first.

Sheet geometry is expressed in PDF points. The sheet size comes from the
caller (the dialog resolves the chosen Windows paper via DeviceCapabilities;
the CLI ditto) — this module never guesses paper.
"""

import math
import re
import subprocess
from pathlib import Path

import pikepdf
from engine.pdf_save import save_pdf

# Render stages inherit printer.py's posture: bounded, stdin-isolated.
RENDER_TIMEOUT_S = 600

# Annotation subtypes kept per mode. "all" never strips (no temp file).
# Widgets are form fields and remain printable in every mode; links carry no
# printable appearance in practice but are document structure, not markup.
# /Popup is intentionally absent everywhere: it dies with its parent markup.
ANNOT_KEEP = {
    "document": {"/Widget", "/Link"},
    "stamps": {"/Widget", "/Link", "/Stamp"},
}

NUP_ORDERS = ("horizontal", "horizontal-reversed", "vertical", "vertical-reversed")


# ---------------------------------------------------------------------------
# Order math (pure)
# ---------------------------------------------------------------------------

def expand_page_spec(spec: str, page_count: int) -> list[int]:
    """A validated ``parse_page_spec`` string -> 0-based indices, SPEC order.

    "" means every page. "5,1-2" yields [4, 0, 1] — the spec's own order is
    preserved (richer than -sPageList, which gs processes ascending; callers
    force the reorder path when the expansion is not ascending).
    """
    if not spec:
        return list(range(page_count))
    order: list[int] = []
    for token in spec.split(","):
        m = re.fullmatch(r"(\d+)(?:-(\d+))?", token, flags=re.ASCII)
        if not m:  # parse_page_spec runs first; this is a programming error
            raise ValueError(f"unvalidated page spec token: {token!r}")
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) is not None else start
        order.extend(range(start - 1, end))
    return order


def apply_subset(order: list[int], subset: str) -> list[int]:
    """Filter print order by DOCUMENT page-number parity (1-based).

    Parity is the page's own number, not its position in the selection —
    that is what makes "print odd, flip the stack, print even" line up on a
    single-sided printer.
    """
    if subset == "all":
        return list(order)
    keep = 0 if subset == "odd" else 1  # page 1 -> index 0 -> odd
    return [i for i in order if i % 2 == keep]


def booklet_sides(count: int, binding: str) -> list[list[int | None]]:
    """Saddle-stitch imposition order for ``count`` ordered pages.

    Returns sheet SIDES in print order (front0, back0, front1, back1, ...),
    each side ``[left_cell, right_cell]`` holding 0-based positions into the
    print-order list, or None for pad blanks (count is padded to a multiple
    of 4). Classic check, count=4, left binding: front [3,0], back [1,2].
    ``binding="right"`` mirrors every side for RTL reading order.
    """
    if count <= 0:
        return []
    padded = (count + 3) // 4 * 4

    def real(i: int) -> int | None:
        return i if i < count else None

    sides: list[list[int | None]] = []
    for s in range(padded // 4):
        front = [real(padded - 1 - 2 * s), real(2 * s)]
        back = [real(2 * s + 1), real(padded - 2 - 2 * s)]
        if binding == "right":
            front = [front[1], front[0]]
            back = [back[1], back[0]]
        sides.append(front)
        sides.append(back)
    return sides


def nup_cells(
    sheet_w: float, sheet_h: float, rows: int, cols: int, order: str
) -> list[tuple[float, float, float, float]]:
    """Uniform grid of (x, y, w, h) cells in PLACEMENT order.

    PDF origin is bottom-left; reading order fills from the TOP row.
    horizontal: left-to-right then next row down. vertical: top-to-bottom
    then next column right. The -reversed variants mirror the horizontal
    direction (right-to-left / columns from the right).
    """
    cw = sheet_w / cols
    ch = sheet_h / rows
    cells: list[tuple[float, float, float, float]] = []
    if order.startswith("horizontal"):
        for r in range(rows):
            cs = range(cols - 1, -1, -1) if order.endswith("reversed") else range(cols)
            for c in cs:
                cells.append((c * cw, sheet_h - (r + 1) * ch, cw, ch))
    else:
        cs = range(cols - 1, -1, -1) if order.endswith("reversed") else range(cols)
        for c in cs:
            for r in range(rows):
                cells.append((c * cw, sheet_h - (r + 1) * ch, cw, ch))
    return cells


def place_in_cell(
    page_w: float,
    page_h: float,
    rotate: int,
    cell: tuple[float, float, float, float],
    auto_rotate: bool,
    scale_override: float | None = None,
) -> tuple[list[float], bool]:
    """Placement matrix [a b c d e f] for one page into one cell.

    ``rotate`` is the source page's effective /Rotate (0/90/180/270): the
    matrix presents the page AS DISPLAYED (the same composition every viewer
    applies). ``auto_rotate`` adds a further 90° when the displayed aspect
    fits the cell better rotated (multiple-per-sheet's "auto-rotate pages").
    Scaling preserves aspect and centers; ``scale_override`` (fraction, e.g.
    0.5) replaces fit-to-cell for the custom-scale mode.

    Returns (matrix, extra_rotated). Matrix maps the page's UNROTATED
    coordinate space (origin at its crop origin — the caller subtracts the
    crop offset) into sheet space.
    """
    cx, cy, cw, ch = cell
    disp_w, disp_h = (page_h, page_w) if rotate % 180 == 90 else (page_w, page_h)

    extra = False
    if auto_rotate and cw != ch and disp_w != disp_h:
        if (disp_w > disp_h) != (cw > ch):
            extra = True
    total = (rotate + (90 if extra else 0)) % 360
    out_w, out_h = (page_h, page_w) if total % 180 == 90 else (page_w, page_h)

    if scale_override is not None:
        s = scale_override
    else:
        s = min(cw / out_w, ch / out_h)

    # Rotation matrices place the page's [0,w]x[0,h] box into [0,out_w]x
    # [0,out_h] rotated CLOCKWISE as viewed (the /Rotate convention).
    if total == 0:
        rm = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    elif total == 90:
        rm = (0.0, -1.0, 1.0, 0.0, 0.0, page_w)
    elif total == 180:
        rm = (-1.0, 0.0, 0.0, -1.0, page_w, page_h)
    else:  # 270
        rm = (0.0, 1.0, -1.0, 0.0, page_h, 0.0)

    ox = cx + (cw - out_w * s) / 2
    oy = cy + (ch - out_h * s) / 2
    a, b, c, d, e, f = rm
    return ([s * a, s * b, s * c, s * d, s * e + ox, s * f + oy], extra)


def poster_tiles(
    scaled_w: float, scaled_h: float, sheet_w: float, sheet_h: float, overlap: float
) -> tuple[int, int]:
    """(cols, rows) of sheets needed to tile a scaled page.

    Each subsequent tile advances by (sheet - overlap); a dimension that fits
    one sheet needs exactly one tile.
    """
    def count(total: float, step: float) -> int:
        if total <= step:
            return 1
        stride = step - overlap
        if stride <= 0:
            raise ValueError("Poster overlap must be smaller than the paper")
        return math.ceil((total - step) / stride) + 1

    return count(scaled_w, sheet_w), count(scaled_h, sheet_h)


# ---------------------------------------------------------------------------
# pikepdf builders
# ---------------------------------------------------------------------------

def _crop_box(page) -> tuple[float, float, float, float]:
    """Effective crop (x0, y0, w, h) — CropBox intersected with MediaBox,
    falling back to MediaBox. Printing frames the CropBox (what the viewer
    shows); gs render stages get -dUseCropBox for the same reason."""
    mb = [float(v) for v in page.mediabox]
    mx0, my0, mx1, my1 = min(mb[0], mb[2]), min(mb[1], mb[3]), max(mb[0], mb[2]), max(mb[1], mb[3])
    try:
        cb = [float(v) for v in page.cropbox]
        cx0, cy0, cx1, cy1 = min(cb[0], cb[2]), min(cb[1], cb[3]), max(cb[0], cb[2]), max(cb[1], cb[3])
        x0, y0 = max(mx0, cx0), max(my0, cy0)
        x1, y1 = min(mx1, cx1), min(my1, cy1)
        if x1 <= x0 or y1 <= y0:
            x0, y0, x1, y1 = mx0, my0, mx1, my1
    except Exception:
        x0, y0, x1, y1 = mx0, my0, mx1, my1
    return x0, y0, x1 - x0, y1 - y0


def _page_rotate(page) -> int:
    try:
        return int(page.obj.get("/Rotate", 0)) % 360 // 90 * 90
    except Exception:
        return 0


def page_geometry(path: str) -> list[dict]:
    """[{w, h, rotate, display_landscape}] per page (crop-effective)."""
    out = []
    with pikepdf.open(path) as pdf:
        for page in pdf.pages:
            _, _, w, h = _crop_box(page)
            rot = _page_rotate(page)
            dw, dh = (h, w) if rot % 180 == 90 else (w, h)
            out.append({"w": w, "h": h, "rotate": rot, "display_landscape": dw > dh})
    return out


def strip_annotations(src: str, dst: str, mode: str) -> int:
    """Write ``dst`` keeping only ANNOT_KEEP[mode] subtypes. Returns the
    number of annotations removed. Popups die with their parents by simply
    not being in any keep set."""
    keep = ANNOT_KEEP[mode]
    removed = 0
    with pikepdf.open(src) as pdf:
        for page in pdf.pages:
            annots = page.obj.get("/Annots")
            if annots is None:
                continue
            kept = []
            for a in annots:
                try:
                    subtype = str(a.get("/Subtype"))
                except Exception:
                    subtype = ""
                if subtype in keep:
                    kept.append(a)
                else:
                    removed += 1
            if removed:
                page.obj["/Annots"] = pikepdf.Array(kept)
        save_pdf(pdf, dst)
    return removed


def build_sequence(
    src: str,
    dst: str,
    order: list[int | None],
    rotate_landscape_to_portrait: bool = False,
) -> None:
    """Write ``dst`` = ``src``'s pages in ``order`` (None -> blank page).

    Same-Pdf appends: pikepdf shallow-copies the page dict while SHARING
    contents and /Annots, so annotations render on every occurrence and the
    document /AcroForm stays registered (print rendering needs appearances,
    not fillability — no cross-Pdf field surgery required). The original
    pages are deleted after the sequence is appended.

    ``rotate_landscape_to_portrait`` bumps /Rotate by 90 on pages whose
    DISPLAYED aspect is landscape — the auto-orientation prepass for
    actual-size printing (fit mode gets this from Ghostscript itself,
    probe-pinned). Safe after sequencing: appended pages are distinct dicts,
    so per-occurrence /Rotate does not alias.
    """
    with pikepdf.open(src) as pdf:
        n = len(pdf.pages)
        originals = [pdf.pages[i] for i in range(n)]
        blank_w, blank_h = 612.0, 792.0
        if n:
            _, _, blank_w, blank_h = _crop_box(originals[0])
        for i in order:
            if i is None:
                pdf.add_blank_page(page_size=(blank_w, blank_h))
            else:
                pdf.pages.append(originals[i])
        del pdf.pages[0:n]
        if rotate_landscape_to_portrait:
            for page in pdf.pages:
                _, _, w, h = _crop_box(page)
                rot = _page_rotate(page)
                dw, dh = (h, w) if rot % 180 == 90 else (w, h)
                if dw > dh:
                    page.obj["/Rotate"] = (rot + 90) % 360
        save_pdf(pdf, dst)


def _xobject_for(dst_pdf, src_pdf, index: int, cache: dict):
    """Form XObject for source page ``index``, copied into ``dst_pdf``.

    BBox is forced to the page's crop box so placement math and visible
    framing agree (as_form_xobject defaults to the media box).
    """
    if index in cache:
        return cache[index]
    page = src_pdf.pages[index]
    xobj = src_pdf.make_indirect(page.as_form_xobject())
    x0, y0, w, h = _crop_box(page)
    xobj["/BBox"] = pikepdf.Array([x0, y0, x0 + w, y0 + h])
    copied = dst_pdf.copy_foreign(xobj)
    cache[index] = copied
    return copied


def _label_font(pdf: pikepdf.Pdf):
    return pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Font"),
            Subtype=pikepdf.Name("/Type1"),
            BaseFont=pikepdf.Name("/Helvetica"),
        )
    )


def _fmt(v: float) -> str:
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s if s else "0"


def impose_sheets(
    src: str,
    dst: str,
    sheets: list[list[tuple[int | None, tuple[float, float, float, float]]]],
    sheet_w: float,
    sheet_h: float,
    border: bool = False,
    auto_rotate: bool = True,
    scale_override: float | None = None,
) -> int:
    """Write ``dst``: one page per entry of ``sheets``; each entry is a list
    of (source page index | None, cell rect) placements. Returns sheet count.

    The source must already be FLATTENED (or rasterized) — form XObjects
    carry content only; live annotations would silently vanish here, which
    is exactly why the pipeline bakes them first (workspace-commit's
    allowlist lesson, applied to print).
    """
    with pikepdf.open(src) as src_pdf:
        geo = []
        for page in src_pdf.pages:
            x0, y0, w, h = _crop_box(page)
            geo.append((w, h, _page_rotate(page)))
        out = pikepdf.new()
        cache: dict = {}
        for placements in sheets:
            content = []
            resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary())
            for slot, (idx, cell) in enumerate(placements):
                if idx is None:
                    continue
                w, h, rot = geo[idx]
                matrix, _ = place_in_cell(
                    w, h, rot, cell, auto_rotate, scale_override
                )
                xobj = _xobject_for(out, src_pdf, idx, cache)
                name = f"/P{slot}"
                resources.XObject[pikepdf.Name(name)] = xobj
                a, b, c, d, e, f = matrix
                # BBox origin sits at the crop origin; the matrix expects the
                # page's crop space at 0,0 — fold the offset in.
                px0, py0, _, _ = (
                    float(xobj["/BBox"][0]), float(xobj["/BBox"][1]), 0, 0
                )
                e -= a * px0 + c * py0
                f -= b * px0 + d * py0
                content.append(
                    "q {} {} {} {} {} {} cm {} Do Q".format(
                        _fmt(a), _fmt(b), _fmt(c), _fmt(d), _fmt(e), _fmt(f), name
                    )
                )
                if border:
                    bx, by, bw, bh = cell
                    content.append(
                        "q 0 G 0.5 w {} {} {} {} re S Q".format(
                            _fmt(bx), _fmt(by), _fmt(bw), _fmt(bh)
                        )
                    )
            page = out.add_blank_page(page_size=(sheet_w, sheet_h))
            page.Contents = out.make_stream(" ".join(content).encode("ascii"))
            page.obj["/Resources"] = resources
        n = len(sheets)
        save_pdf(out, dst)
    return n


def impose_poster(
    src: str,
    dst: str,
    sheet_w: float,
    sheet_h: float,
    scale: float,
    overlap: float,
    cut_marks: bool,
    labels: bool,
) -> dict:
    """Tile every source page across sheets at ``scale`` (fraction).

    Tiles advance by (sheet - overlap), rows from the TOP for assembly
    order. Optional hairline cut marks frame each tile's trim (interior
    edges only) and a small gray label names the tile position.
    Returns {"sheets": n, "grid": [[cols, rows] per source page]}.
    """
    with pikepdf.open(src) as src_pdf:
        geo = []
        for page in src_pdf.pages:
            x0, y0, w, h = _crop_box(page)
            geo.append((w, h, _page_rotate(page)))
        out = pikepdf.new()
        cache: dict = {}
        font = None
        sheets = 0
        grids: list[list[int]] = []
        for idx, (w, h, rot) in enumerate(geo):
            disp_w, disp_h = (h, w) if rot % 180 == 90 else (w, h)
            scaled_w, scaled_h = disp_w * scale, disp_h * scale
            cols, rows = poster_tiles(scaled_w, scaled_h, sheet_w, sheet_h, overlap)
            grids.append([cols, rows])
            xobj = _xobject_for(out, src_pdf, idx, cache)
            px0 = float(xobj["/BBox"][0])
            py0 = float(xobj["/BBox"][1])
            # Display-space placement matrix at scale, before tiling: rotate
            # to display orientation then scale (same convention as
            # place_in_cell with a full-page cell).
            base, _ = place_in_cell(
                w, h, rot, (0.0, 0.0, scaled_w, scaled_h), False, scale
            )
            a, b, c, d, e, f = base
            e -= a * px0 + c * py0
            f -= b * px0 + d * py0
            for r in range(rows):
                for col in range(cols):
                    tx = col * (sheet_w - overlap)
                    ty = max(scaled_h - sheet_h, 0.0) - r * (sheet_h - overlap)
                    content = [
                        "q 1 0 0 1 {} {} cm {} {} {} {} {} {} cm /P0 Do Q".format(
                            _fmt(-tx), _fmt(-ty), _fmt(a), _fmt(b), _fmt(c),
                            _fmt(d), _fmt(e), _fmt(f)
                        )
                    ]
                    resources = pikepdf.Dictionary(
                        XObject=pikepdf.Dictionary(P0=xobj)
                    )
                    if cut_marks and overlap > 0:
                        # Hairline trim on edges that have a neighbor.
                        marks = []
                        if col > 0:
                            marks.append((overlap, 0, overlap, sheet_h))
                        if col < cols - 1:
                            marks.append((sheet_w - overlap, 0, sheet_w - overlap, sheet_h))
                        if r > 0:
                            marks.append((0, sheet_h - overlap, sheet_w, sheet_h - overlap))
                        if r < rows - 1:
                            marks.append((0, overlap, sheet_w, overlap))
                        for x1, y1, x2, y2 in marks:
                            content.append(
                                "q 0.6 G 0.24 w {} {} m {} {} l S Q".format(
                                    _fmt(x1), _fmt(y1), _fmt(x2), _fmt(y2)
                                )
                            )
                    if labels:
                        if font is None:
                            font = _label_font(out)
                        resources["/Font"] = pikepdf.Dictionary(F0=font)
                        text = f"({r + 1},{col + 1}) of {rows}x{cols}"
                        tx_label = overlap + 6 if col > 0 else 6
                        ty_label = (
                            sheet_h - overlap - 14 if r > 0 else sheet_h - 14
                        )
                        content.append(
                            "q 0.5 g BT /F0 9 Tf 1 0 0 1 {} {} Tm ({}) Tj ET Q".format(
                                _fmt(tx_label), _fmt(ty_label), text
                            )
                        )
                    page = out.add_blank_page(page_size=(sheet_w, sheet_h))
                    page.Contents = out.make_stream(" ".join(content).encode("ascii"))
                    page.obj["/Resources"] = resources
                    sheets += 1
        save_pdf(out, dst)
    return {"sheets": sheets, "grid": grids}


# ---------------------------------------------------------------------------
# Ghostscript render stages
# ---------------------------------------------------------------------------

def _run_render(args: list[str], what: str) -> None:
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=RENDER_TIMEOUT_S,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{what} timed out after {RENDER_TIMEOUT_S}s") from None
    if result.returncode != 0:
        detail = (result.stderr or "").strip() or (result.stdout or "").strip()
        raise RuntimeError(f"{what} failed: {detail or 'unknown error'}")


def flatten_pdf(gs_path: str, src: str, dst: str, pages: str = "") -> None:
    """Bake annotation appearances into page content (imposition input).

    -dPrinted is REQUIRED here: pdfwrite defaults to viewer semantics, which
    would flatten screen-only annotations into the print (probe-pinned).
    """
    args = [
        gs_path, "-dNOPAUSE", "-dBATCH", "-dQUIET", "-dSAFER",
        "-sDEVICE=pdfwrite", "-dPreserveAnnots=false", "-dPrinted",
        "-dUseCropBox",
    ]
    if pages:
        args.append(f"-sPageList={pages}")
    args += [f"-sOutputFile={dst}", str(Path(src))]
    _run_render(args, "Print preparation (flatten)")


def rasterize_pdf(
    gs_path: str, src: str, dst: str, dpi: int, pages: str = "", gray: bool = False
) -> None:
    """Print-as-image: render pages to a PDF of page images."""
    device = "pdfimage8" if gray else "pdfimage24"
    args = [
        gs_path, "-dNOPAUSE", "-dBATCH", "-dQUIET", "-dSAFER",
        f"-sDEVICE={device}", f"-r{int(dpi)}", "-dPrinted", "-dUseCropBox",
    ]
    if pages:
        args.append(f"-sPageList={pages}")
    args += [f"-sOutputFile={dst}", str(Path(src))]
    _run_render(args, "Print rasterization")


def render_preview(
    gs_path: str,
    src: str,
    out_dir: str,
    dpi: int,
    sheet_w: float,
    sheet_h: float,
    fit_switches: list[str],
    gray: bool = False,
    pages: str = "",
) -> list[str]:
    """Render sheets as PNGs THE WAY THE JOB WILL PRINT them: the same
    fixed medium and fit switches the mswinpr2 run gets, so letterboxing,
    clipping, auto-rotation, and imposition all show as they will land on
    paper. Returns the produced files in sheet order."""
    device = "pnggray" if gray else "png16m"
    template = str(Path(out_dir) / "sheet-%d.png")
    args = [
        gs_path, "-dNOPAUSE", "-dBATCH", "-dQUIET", "-dSAFER",
        f"-sDEVICE={device}", f"-r{int(dpi)}",
        f"-dDEVICEWIDTHPOINTS={_fmt(sheet_w)}",
        f"-dDEVICEHEIGHTPOINTS={_fmt(sheet_h)}",
        "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4",
        "-dPrinted", "-dUseCropBox",
        *fit_switches,
    ]
    if pages:
        args.append(f"-sPageList={pages}")
    args += [f"-sOutputFile={template}", str(Path(src))]
    _run_render(args, "Print preview render")
    produced = sorted(
        Path(out_dir).glob("sheet-*.png"),
        key=lambda p: int(p.stem.split("-")[1]),
    )
    return [str(p) for p in produced]
