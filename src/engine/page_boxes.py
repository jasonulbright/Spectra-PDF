"""Crop pages / edit page boxes.

Sets one of the four page boundary boxes — /CropBox, /BleedBox, /TrimBox,
/ArtBox — by insetting the page's current effective box by per-edge margins
(points) across a page range. "Crop pages" is exactly this on /CropBox; the
other three are standard prepress boxes.

Insets are clamped so the result stays inside the /MediaBox and never
degenerates (a crop that would invert or collapse is refused for that page,
reported, and the page left untouched — a silent zero-area box would make a
viewer show nothing). The box is written directly on each page object (not
inherited), so a page keeps its box even if the file hoisted a shared one.
"""

from pathlib import Path

import pikepdf
from pikepdf import Array

from engine.inplace import staged_write
from engine.pdf_save import save_pdf
from engine.pdf_tree import walk_inheritable

#: The four boundary boxes, by the name every surface spells them with. Shared
#: so the content-aware crop cannot grow a second spelling of the same choice.
BOXES = {
    "crop": "/CropBox",
    "bleed": "/BleedBox",
    "trim": "/TrimBox",
    "art": "/ArtBox",
}
MIN_EXTENT = 1.0  # points — a box thinner than this is degenerate


def box_key(box: str) -> str:
    """The dictionary key for a box name, raising the one refusal both crops
    share for an unknown one."""
    key = BOXES.get(str(box).lower())
    if key is None:
        raise ValueError(f"box must be one of {sorted(BOXES)}, got {box!r}")
    return key


def effective_box(page, key: str):
    """A page's box as `(x0, y0, x1, y1)`, inheritance-aware and normalized,
    or None when the page does not have one."""
    v = walk_inheritable(page, key)
    if v is None:
        return None
    try:
        x0, y0, x1, y1 = (float(v[i]) for i in range(4))
    except (TypeError, ValueError, IndexError):
        return None
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def set_page_boxes(
    file: str,
    output: str,
    box: str = "crop",
    top: float = 0.0,
    bottom: float = 0.0,
    left: float = 0.0,
    right: float = 0.0,
    pages: list | None = None,
) -> dict:
    """Inset a page box by per-edge margins across a page range.

    Args:
        box: one of crop/bleed/trim/art.
        top/bottom/left/right: points to trim from each edge (may be negative to
            EXPAND, still clamped to the media box).
        pages: 1-based page numbers; None = all, [] = zero (watermark's
            convention — an empty selection never widens to all). Out-of-range
            entries are ignored.
    """
    key = box_key(box)
    t, b, l, r = float(top), float(bottom), float(left), float(right)

    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    wanted = None if pages is None else {int(p) for p in pages}

    changed = 0
    skipped: list[dict] = []
    with pikepdf.open(file) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            if wanted is not None and index not in wanted:
                continue
            media = effective_box(page, "/MediaBox")
            if media is None:
                skipped.append({"page": index, "reason": "no media box"})
                continue
            # Inset the box we're editing from its current value, else the media
            # box (a page with no explicit crop crops from its media bounds).
            base = effective_box(page, key) or media
            nx0, ny0 = base[0] + l, base[1] + b
            nx1, ny1 = base[2] - r, base[3] - t
            # Clamp inside the media box.
            nx0 = max(nx0, media[0])
            ny0 = max(ny0, media[1])
            nx1 = min(nx1, media[2])
            ny1 = min(ny1, media[3])
            if nx1 - nx0 < MIN_EXTENT or ny1 - ny0 < MIN_EXTENT:
                skipped.append({"page": index, "reason": "resulting box is degenerate"})
                continue
            page.obj[key] = Array([nx0, ny0, nx1, ny1])
            changed += 1

        if same_file:
            with staged_write(output_path) as staged:
                save_pdf(pdf, str(staged))
                pdf.close()
        else:
            save_pdf(pdf, output_path)

    return {"output": str(output_path), "box": str(box).lower(), "changed": changed, "skipped": skipped}
