"""O8 slice C — the MRC pass (ITU-T T.44 mixed raster content).

A scanned page is a photograph OF text. Storing it as one continuous-tone
image forces a single trade: keep the resolution and keep the size, or drop
both. MRC splits the page into the three layers T.44 names and encodes each
with the codec it actually suits —

  * a 1-bit **stencil** at SOURCE resolution saying where ink is (JBIG2, or
    CCITT G4), which is why the output reads sharper than the JPEG it came
    from: the glyph edges become a binary shape instead of a chroma-
    subsampled gradient;
  * a small **foreground** carrying the ink COLOUR, drawn through the
    stencil as a `/Mask`;
  * a small **background** carrying the paper, inpainted so the text leaves
    no ghost behind it.

Measured on the recon fixture (brief 40 § 1.5): the 1146 KB source scan
becomes 204 KB with a CCITT G4 mask and the text still at 300 dpi, where
Ghostscript's `/ebook` reaches 301 KB only by dropping the text to 150 dpi
and `/screen` reaches 120 KB by making it unreadable.

WHAT MAKES THIS SURGERY AND NOT A REBUILD. The scan image's `Do` is replaced
in the page's own content stream by two `Do`s (`page_images.
replace_placement_with_layers`). The page OBJECT survives, so /Annots,
/AcroForm and its field tree, /StructTreeRoot and the marked-content ids the
layers now sit inside, page labels and the outline all carry through with
nothing to re-attach — unlike `compress`'s Ghostscript branch, which
regenerates the page and has to transplant /AcroForm back afterwards (and
cannot transplant the structure tree at all). It is also why the tool this
brief did NOT adopt was rejected: its `recode_pdf` builds a new PDF out of
page images, which destroys all of that by construction.

THE RULES EARNED HERE, each of which was a live bug in the recon probes:

1. **The background must be averaged over PAPER pixels only.** Filling the
   ink holes with a blur of the whole image leaves the text's own ghost
   under the text and contrast collapses — the ghosted build read
   `Thaiok heme fav jumns aver tap [a7y dpe` where the corrected build read
   the line verbatim. The correct form is a masked box filter,
   `blur(I·paper) / blur(paper)`, pyramided so a block with no paper in it
   still fills from a coarser level.
2. **Segmentation is a MEASUREMENT of the page, not a constant.** The
   Sauvola window is sized from the page's own median glyph height (a first
   pass at a default window measures it, a second pass uses it), because a
   window sized for 10 pt text erodes 24 pt text and a window sized for a
   heading smears body copy into one blob.
3. **A photograph is not text and must never enter the stencil.** A
   halftone put into a 1-bit mask both bloats it and moirés on screen; a
   continuous-tone photograph put there posterizes. Both are excluded and
   left to the background, and the background's resolution rises to carry
   them.
4. **Every mask is decode-verified before it is embedded** (slice B's
   `verify_mask_stream`, through Ghostscript — an INDEPENDENT decoder). A
   multi-strip G4 stream renders as a plausibly eroded page and an inverted
   stencil renders solid black that OCR still returns words from, so a size
   check and a "does it render" check both pass over either. A page whose
   mask fails verification is left UNTOUCHED and says so.
"""

from __future__ import annotations

import math
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pikepdf
from PIL import Image
from pikepdf import Dictionary, Name

from . import budget
from . import mrc_verify
from .mrc_codecs import (
    CCITT_G4,
    JBIG2_GENERIC,
    JBIG2_SYMBOL,
    encode_layer_jpeg,
    encode_layer_jpx,
    encode_mask,
    verify_mask_stream,
)
from .page_images import _walk_placements, replace_placement_with_layers
from .redact import IDENTITY, _lookup_xobject, _resolve_resources
from .validate import validate_pdf

# --------------------------------------------------------------------------
# Presets
# --------------------------------------------------------------------------
#: Named for what they promise, not for a number.
#:
#: `sauvola_k` is CONSERVATIVE at the low end: Sauvola's threshold is
#: `m·(1 + k·(σ/R − 1))` and σ < R over paper, so the bracket is negative and
#: a LARGER k lowers the threshold and finds LESS ink. Archival therefore runs
#: the smallest k — it keeps thin strokes, at the cost of keeping some paper
#: texture with them.
#:
#: `verify_threshold` (slice E) is the floor `mrc_verify_text` reverts below,
#: and it is set to catch a SEGMENTATION FAILURE, not an OCR wobble. Measured
#: over the matrix (`mrc-matrix.local.py`, six sources × three presets × three
#: codecs): the WORST good page any preset produced scored 0.9781 (the
#: greyscale scan under archival), while the failure this gate exists for — a
#: page thresholded for type that is not there — returns near-nothing, which
#: is why recon scored a misjudged page in the low hundredths. The floors sit
#: between those two populations with room to spare. **0.98 was the first
#: value here and the matrix caught it**: it would have REVERTED that
#: greyscale page, handing the user back the original they asked to shrink —
#: a false revert is its own silent degradation, and setting the floor at the
#: measured best case is how you build one.
PRESETS: dict[str, dict] = {
    "archival": {
        "mask_codec": JBIG2_GENERIC,  # no symbol may stand in for another
        # Archival's own codec ignores this — generic mode has no symbol
        # matching — but a caller may ask for symbol mode BY NAME on top of
        # this preset, and then it is used. 0.97 is the strictest value
        # jbig2enc accepts; the 0.98 that stood here reached the encoder as
        # "Invalid value for threshold" (matrix-caught).
        "symbol_threshold": 0.97,
        "bg_div": 2,
        "bg_rate": 40,
        "fg_div": 3,
        "fg_quality": 65,
        "sauvola_k": 0.10,
        "verify_threshold": 0.97,
    },
    "balanced": {
        "mask_codec": JBIG2_SYMBOL,
        "symbol_threshold": 0.92,  # jbig2enc's own default
        "bg_div": 3,
        "bg_rate": 60,
        "fg_div": 4,
        "fg_quality": 45,
        "sauvola_k": 0.20,
        "verify_threshold": 0.95,
    },
    "smallest": {
        "mask_codec": JBIG2_SYMBOL,
        "symbol_threshold": 0.85,
        "bg_div": 4,
        "bg_rate": 120,
        "fg_div": 6,
        "fg_quality": 35,
        "sauvola_k": 0.30,
        "verify_threshold": 0.90,
    },
}
DEFAULT_PRESET = "balanced"

#: The named codecs a caller may ask for, mapped to the codec ids slice B
#: knows. Asking BY NAME disables the CCITT fallback (a silent codec swap
#: would make the size claim untrue).
MASK_CODEC_ALIASES = {
    "jbig2": JBIG2_SYMBOL,
    "jbig2-symbol": JBIG2_SYMBOL,
    "jbig2_symbol": JBIG2_SYMBOL,
    "jbig2-generic": JBIG2_GENERIC,
    "jbig2_generic": JBIG2_GENERIC,
    "ccitt": CCITT_G4,
    "ccitt_g4": CCITT_G4,
}

#: The scan must cover this much of the page for the page to be a scan.
MIN_COVERAGE = 0.90
#: Placement skew/rotation tolerance, as a fraction of the placement's scale.
PLACEMENT_TOLERANCE = 1e-3
#: Rasterization fallback clamp, in dpi.
MIN_RASTER_DPI, MAX_RASTER_DPI = 200, 600
#: Sauvola's normalizer R — half of an 8-bit range, per the published form.
SAUVOLA_R = 128.0
#: CHROMA variance below which the foreground collapses to a single pixel.
#: Chroma, not luminance, and the difference is the whole test: a page of one
#: black ink still has a large LUMINANCE variance across its foreground —
#: a hairline's masked mean is lighter than a bold stem's — while its chroma
#: is flat. Measured on the fixtures: one ink reads 0.3, a page mixing black
#: and red reads 531, and a scan whose photograph leaks colour into the ink
#: set reads 17-26. Anything under 8 is one ink.
FLAT_INK_CHROMA_VARIANCE = 8.0

# Page-level decisions. Reported, never fatal — a mixed document gets MRC on
# its scanned pages and byte-identical output on the rest.
DECISION_MRC = "mrc"
DECISION_UNTOUCHED = "untouched"
#: Slice E. The page WAS a scan, its layers WERE built, and the text check
#: rejected them — a distinct decision from "untouched" because the two mean
#: different things to whoever reads the report: one page had nothing to
#: separate, the other had its separation refused.
DECISION_REVERTED = "reverted"


@dataclass
class _Candidate:
    """A page that classified as a scan, with what the pass needs to act."""

    page_number: int  # 1-based
    index: int  # placement ordinal on that page
    rect: tuple[float, float, float, float]
    width: int
    height: int
    source_dpi: int


# --------------------------------------------------------------------------
# Classification (§ 3.1)
# --------------------------------------------------------------------------
def _page_box(page) -> tuple[float, float, float, float]:
    box = page.obj.get("/CropBox", page.obj.get("/MediaBox"))
    try:
        x0, y0, x1, y1 = (float(v) for v in box)
    except (TypeError, ValueError):
        x0, y0, x1, y1 = 0.0, 0.0, 612.0, 792.0
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def _has_other_visible_content(pdf, instructions, resources, fallback, depth=0) -> bool:
    """True when the page draws anything besides the one image.

    Invisible text (`Tr 3` — an OCR layer) does not count, and annotations are
    not page content at all. Everything else — a signature stamp's vector art,
    a header the scanner's software drew, a second image — means the page is
    not a plain scan and MRC has no business rewriting it.
    """
    from .content_walk import GraphicsTextState

    state = GraphicsTextState(IDENTITY)
    for instruction in list(instructions):
        op = str(instruction.operator)
        operands = list(instruction.operands)
        if state.feed(op, operands):
            continue
        if op in ("Tj", "TJ", "'", '"'):
            if state.render_mode != 3:
                return True
            continue
        if op in ("S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "sh"):
            return True
        if op == "INLINE IMAGE":
            return True
        if op == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback)
            if xobj is None:
                continue
            subtype = str(xobj.get("/Subtype", ""))
            if subtype == "/Image":
                continue  # counted as a placement by the caller
            if subtype == "/Form":
                if depth >= 4:
                    return True
                form_res = xobj.get("/Resources")
                if _has_other_visible_content(
                    pdf,
                    pikepdf.parse_content_stream(xobj),
                    form_res if form_res is not None else resources,
                    resources,
                    depth + 1,
                ):
                    return True
                continue
            return True
    return False


def _image_refusal(xobj) -> str | None:
    """Why this image XObject cannot be separated, or None."""
    if xobj.get("/SMask") is not None:
        return "the page image carries a soft mask"
    if xobj.get("/Mask") is not None:
        return "the page image is already masked"
    try:
        bpc = int(xobj.get("/BitsPerComponent", 8))
    except (TypeError, ValueError):
        bpc = 8
    if bool(xobj.get("/ImageMask", False)) or bpc < 8:
        # Not a failure: a 1-bit page has no background to separate.
        return "the page image is already 1-bit"
    cs = xobj.get("/ColorSpace")
    if cs is not None and isinstance(cs, pikepdf.Array) and len(cs) and str(cs[0]) == "/Indexed":
        return "the page image uses an indexed colour space"
    return None


def _placement_is_upright(matrix) -> bool:
    a, b, c, d, _e, _f = (float(v) for v in matrix)
    scale = max(abs(a), abs(d), 1e-9)
    return (
        abs(b) <= PLACEMENT_TOLERANCE * scale
        and abs(c) <= PLACEMENT_TOLERANCE * scale
        and a > 0
        and d > 0
    )


def _classify_page(pdf, page, page_number: int) -> tuple[_Candidate | None, str]:
    """`(candidate, reason)` — a candidate, or None with the reason why not."""
    resources = _resolve_resources(page)
    try:
        instructions = list(pikepdf.parse_content_stream(page))
    except Exception:
        return None, "the page content stream could not be read"
    placements = _walk_placements(pdf, instructions, resources, IDENTITY, 0, None, [], False)
    images = [p for p in placements if p.get("kind") == "xobject" and not p.get("clipped")]
    if len(images) != 1:
        return None, "this page is not a scanned image"
    placement = images[0]
    if placement.get("nested"):
        return None, "the page image is drawn inside a form"
    if not _placement_is_upright(placement["matrix"]):
        return None, "the page image placement is rotated or skewed"

    px0, py0, px1, py1 = _page_box(page)
    page_area = max((px1 - px0) * (py1 - py0), 1e-6)
    rx0, ry0, rx1, ry1 = placement["rect"]
    if ((rx1 - rx0) * (ry1 - ry0)) / page_area < MIN_COVERAGE:
        return None, "this page is not a scanned image"

    xobj = _lookup_xobject(placement["name"], resources, None)
    if xobj is None:
        return None, "this page is not a scanned image"
    refusal = _image_refusal(xobj)
    if refusal is not None:
        return None, refusal
    if _has_other_visible_content(pdf, instructions, resources, None):
        return None, "this page draws more than a scanned image"

    width = int(placement["native_width"] or 0)
    height = int(placement["native_height"] or 0)
    if width < 2 or height < 2:
        return None, "this page is not a scanned image"
    dpi = int(round(width * 72.0 / max(rx1 - rx0, 1e-6)))
    return (
        _Candidate(
            page_number=page_number,
            index=int(placement["index"]),
            rect=(rx0, ry0, rx1, ry1),
            width=width,
            height=height,
            source_dpi=max(1, dpi),
        ),
        DECISION_MRC,
    )


# --------------------------------------------------------------------------
# Lifting the source pixels
# --------------------------------------------------------------------------
def _lift_image(pdf, page, candidate: _Candidate) -> Image.Image | None:
    """The scan's OWN samples, unresampled — the ideal path.

    Returns None rather than raising when this runtime cannot decode the
    codestream (a JPX scan on a build without openjpeg is the live case), so
    the caller falls through to the rasterizer instead of losing the page.
    """
    resources = _resolve_resources(page)
    placements = _walk_placements(
        pdf, pikepdf.parse_content_stream(page), resources, IDENTITY, 0, None, [], False
    )
    target = placements[candidate.index]
    xobj = _lookup_xobject(target["name"], resources, None)
    if xobj is None:
        return None
    try:
        im = pikepdf.PdfImage(xobj).as_pil_image()
    except Exception:
        return None
    return im.convert("RGB")


def _rasterize_placement(
    file: str, candidate: _Candidate, page, gs_path: str
) -> Image.Image:
    """Render the page and crop the placement out of it.

    The fallback for an image whose codestream this runtime cannot decode
    (a JPX scan, chiefly). Rendering the PAGE and cropping — rather than
    rendering at the page box and using the whole frame — is what keeps the
    layer geometry identical to the placement's: the scan covers ≥ 90% of the
    page, not 100%, so the two are not the same rectangle.
    """
    if not gs_path or not os.path.isfile(gs_path):
        raise RuntimeError(
            f"Ghostscript is not available at {gs_path or '(no path given)'} — the page "
            "image cannot be decoded, and MRC has no other way to read it."
        )
    dpi = min(max(candidate.source_dpi, MIN_RASTER_DPI), MAX_RASTER_DPI)
    px0, py0, px1, py1 = _page_box(page)
    with tempfile.TemporaryDirectory(prefix="spectrapdf_mrc_") as work:
        png = Path(work) / "page.png"
        result = budget.gs(
            [
                gs_path, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dUseCropBox",
                "-sDEVICE=png16m", f"-r{dpi}",
                f"-dFirstPage={candidate.page_number}",
                f"-dLastPage={candidate.page_number}",
                f"-sOutputFile={png}", str(file),
            ],
            what="Ghostscript (MRC page raster)",
            path=file,
            pages=1,
        )
        if result.returncode != 0 or not png.is_file():
            detail = (result.stderr or "").strip()
            raise RuntimeError(f"Ghostscript could not render the page image: {detail}")
        with Image.open(png) as raster:
            frame = raster.convert("RGB")
            scale = dpi / 72.0
            rx0, ry0, rx1, ry1 = candidate.rect
            left = int(round((rx0 - px0) * scale))
            right = int(round((rx1 - px0) * scale))
            top = int(round((py1 - ry1) * scale))
            bottom = int(round((py1 - ry0) * scale))
            left, top = max(left, 0), max(top, 0)
            right = min(max(right, left + 1), frame.width)
            bottom = min(max(bottom, top + 1), frame.height)
            return frame.crop((left, top, right, bottom))


# --------------------------------------------------------------------------
# Segmentation (§ 3.2)
# --------------------------------------------------------------------------
def _integral(a: np.ndarray) -> np.ndarray:
    """Summed-area table with a zero row/column, in float64.

    float64 is not a default choice: the squares table over a 300-dpi page
    reaches ~5·10^11, which float32 cannot hold to integer precision, and a
    variance computed from a lossy sum of squares is a threshold that drifts
    across the page.
    """
    out = np.zeros((a.shape[0] + 1, a.shape[1] + 1), dtype=np.float64)
    np.cumsum(np.cumsum(a, axis=0, dtype=np.float64), axis=1, out=out[1:, 1:])
    return out


def _box_sums(ii: np.ndarray, radius: int) -> tuple[np.ndarray, np.ndarray]:
    """Window sums (and window sizes) of radius `radius`, edges clamped."""
    h, w = ii.shape[0] - 1, ii.shape[1] - 1
    ys = np.arange(h)
    xs = np.arange(w)
    y0 = np.clip(ys - radius, 0, h)
    y1 = np.clip(ys + radius + 1, 0, h)
    x0 = np.clip(xs - radius, 0, w)
    x1 = np.clip(xs + radius + 1, 0, w)
    total = ii[np.ix_(y1, x1)]
    total -= ii[np.ix_(y0, x1)]
    total -= ii[np.ix_(y1, x0)]
    total += ii[np.ix_(y0, x0)]
    counts = (y1 - y0)[:, None] * (x1 - x0)[None, :]
    return total, counts.astype(np.float64)


def sauvola_ink(gray: np.ndarray, window: int, k: float, R: float = SAUVOLA_R) -> np.ndarray:
    """EXACT Sauvola local thresholding — `thr = m·(1 + k·(σ/R − 1))`.

    Exact rather than the block-mean approximation the numpy-free recon used:
    with integral images the true sliding window costs one extra table and
    removes the blockiness that approximation puts along a window boundary,
    which shows up as a dashed edge on a long rule.
    """
    radius = max(int(window) // 2, 1)
    g = gray.astype(np.float64, copy=False)
    s1, counts = _box_sums(_integral(g), radius)
    s2, _ = _box_sums(_integral(g * g), radius)
    mean = s1 / counts
    var = np.maximum(s2 / counts - mean * mean, 0.0)
    thr = mean * (1.0 + k * (np.sqrt(var) / R - 1.0))
    return g < thr


def _runs(ink: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Row-runs of ink: `(row, x0, x1)` with x1 exclusive, in raster order."""
    h, w = ink.shape
    pad = np.zeros((h, w + 2), dtype=np.int8)
    pad[:, 1:-1] = ink
    d = np.diff(pad, axis=1)
    starts = np.argwhere(d == 1)
    ends = np.argwhere(d == -1)
    return starts[:, 0], starts[:, 1], ends[:, 1]


def _label_runs(rows: np.ndarray, x0: np.ndarray, x1: np.ndarray, height: int) -> np.ndarray:
    """8-connected component id per run, via union-find over RUNS not pixels.

    Labelling 8 million pixels one at a time in Python is minutes; a text page
    has a few hundred thousand runs and the union pass is linear in them, so
    the same answer arrives in well under a second. The runs are already in
    raster order, so each row only has to be merged against the one above it.
    """
    n = rows.shape[0]
    parent = np.arange(n, dtype=np.int64)

    def find(i: int) -> int:
        root = i
        while parent[root] != root:
            root = parent[root]
        while parent[i] != root:
            parent[i], i = root, parent[i]
        return root

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[max(ri, rj)] = min(ri, rj)

    row_start = np.searchsorted(rows, np.arange(height + 1))
    xs0 = x0.tolist()
    xs1 = x1.tolist()
    for r in range(1, height):
        a, a_end = int(row_start[r - 1]), int(row_start[r])
        b, b_end = int(row_start[r]), int(row_start[r + 1])
        i, j = a, b
        while i < a_end and j < b_end:
            # 8-connectivity: a diagonal touch counts, hence the <= on both
            # sides rather than a strict overlap.
            if xs0[i] <= xs1[j] and xs0[j] <= xs1[i]:
                union(i, j)
            if xs1[i] < xs1[j]:
                i += 1
            else:
                j += 1
    return np.array([find(i) for i in range(n)], dtype=np.int64)


@dataclass(frozen=True)
class _Components:
    labels: np.ndarray  # per-run root id, compacted to 0..n-1
    rows: np.ndarray
    x0: np.ndarray
    x1: np.ndarray
    area: np.ndarray
    top: np.ndarray
    bottom: np.ndarray
    left: np.ndarray
    right: np.ndarray

    @property
    def count(self) -> int:
        return int(self.area.shape[0])

    @property
    def bbox_h(self) -> np.ndarray:
        return self.bottom - self.top + 1

    @property
    def bbox_w(self) -> np.ndarray:
        return self.right - self.left + 1

    @property
    def fill(self) -> np.ndarray:
        return self.area / np.maximum(self.bbox_h * self.bbox_w, 1)


def components(ink: np.ndarray) -> _Components:
    rows, x0, x1 = _runs(ink)
    if rows.size == 0:
        z = np.zeros(0, dtype=np.int64)
        return _Components(z, z, z, z, z, z, z, z, z)
    roots = _label_runs(rows, x0, x1, ink.shape[0])
    labels, compact = np.unique(roots, return_inverse=True)
    n = labels.shape[0]
    widths = (x1 - x0).astype(np.int64)
    area = np.bincount(compact, weights=widths, minlength=n).astype(np.int64)
    top = np.full(n, ink.shape[0], dtype=np.int64)
    bottom = np.full(n, -1, dtype=np.int64)
    left = np.full(n, ink.shape[1], dtype=np.int64)
    right = np.full(n, -1, dtype=np.int64)
    np.minimum.at(top, compact, rows)
    np.maximum.at(bottom, compact, rows)
    np.minimum.at(left, compact, x0)
    np.maximum.at(right, compact, x1 - 1)
    return _Components(compact, rows, x0, x1, area, top, bottom, left, right)


def _clear_runs(ink: np.ndarray, comp: _Components, drop: np.ndarray) -> None:
    """Erase every run belonging to a dropped component, in place."""
    if not drop.any():
        return
    hit = np.flatnonzero(drop[comp.labels])
    rows = comp.rows[hit].tolist()
    lo = comp.x0[hit].tolist()
    hi = comp.x1[hit].tolist()
    for r, a, b in zip(rows, lo, hi):
        ink[r, a:b] = False


def estimate_text_height(comp: _Components, keep: np.ndarray, fallback: int) -> int:
    """The page's own median glyph height (rule 2).

    `keep` selects the components allowed to vote — the pictorial pass has
    already removed the ones that would lie. That ORDER is load-bearing: a
    halftone patch contributes tens of thousands of 5-pixel dots, so measuring
    the median before excluding it returns the DOT height, the window collapses
    to its floor, and the body text of the same page is then thresholded with a
    window sized for something else entirely (measured: 5 px instead of 26 px
    on the text+photo fixture).
    """
    if comp.count == 0 or not keep.any():
        return fallback
    h = comp.bbox_h[keep]
    w = comp.bbox_w[keep]
    a = comp.area[keep]
    plausible = (h >= 3) & (h <= fallback * 8) & (w <= fallback * 16) & (a >= 4)
    if not plausible.any():
        return fallback
    # Weighted by INK AREA, not one vote per component: a page has far more
    # dots, commas and grain specks than it has letters, so a plain median
    # returns the height of the smallest thing on the page. Weighting asks
    # the question that matters — how tall is the typical square of ink —
    # and a 200-pixel letter then outvotes a 12-pixel speck sixteen to one.
    order = np.argsort(h[plausible], kind="stable")
    heights = h[plausible][order]
    weights = a[plausible][order].astype(np.float64)
    cumulative = np.cumsum(weights)
    at = np.searchsorted(cumulative, cumulative[-1] / 2.0)
    return int(max(3, heights[min(at, heights.shape[0] - 1)]))


def _pictorial_blocks(
    ink: np.ndarray, comp: _Components, speckle: np.ndarray, *, dpi: int
) -> tuple[np.ndarray, dict]:
    """Block-grid mask of the regions that are pictures, not type (rule 3).

    Everything here is measured in INCHES, never in glyph heights, and that is
    deliberate: the glyph height is what this pass exists to make measurable,
    so depending on it would be circular — and circularly wrong, because a
    halftone's dots dominate the height estimate.

    Two signals, one grid:

    * **dot count** — a quarter-inch block holding twenty-plus separate tiny
      marks is a halftone. Text cannot reach that: a period and the dot of an
      `i` are the same size as a screen dot, but a quarter inch of prose holds
      a handful of them, not scores.
    * **coverage** — a block more than half ink is not type either. Even bold
      body copy covers about a quarter of its block; a continuous-tone shadow
      covers all of it.

    Contiguous groups of flagged blocks are filled to their BOUNDING BOX: a
    photograph's light passages trip neither signal, so flagging only the
    blocks that do would leave the picture's highlights in the stencil while
    taking its shadows out — visibly worse than leaving it whole.
    """
    inch = max(dpi, 1)
    block = max(inch // 4, 8)
    bh = int(math.ceil(ink.shape[0] / block))
    bw = int(math.ceil(ink.shape[1] / block))
    stats = {"halftone_blocks": 0, "picture_blocks": 0}
    if bh < 2 or bw < 2:
        return np.zeros((bh, bw), dtype=bool), stats

    dot_side = max(int(round(0.035 * inch)), 3)
    tiny = (~speckle) & (comp.bbox_h <= dot_side) & (comp.bbox_w <= dot_side)
    counts = np.zeros((bh, bw), dtype=np.int64)
    if tiny.any():
        cy = np.clip(((comp.top + comp.bottom) // 2)[tiny] // block, 0, bh - 1)
        cx = np.clip(((comp.left + comp.right) // 2)[tiny] // block, 0, bw - 1)
        counts = np.bincount(cy * bw + cx, minlength=bh * bw).reshape(bh, bw)
    halftone = counts >= 20
    stats["halftone_blocks"] = int(halftone.sum())

    pad_h, pad_w = bh * block - ink.shape[0], bw * block - ink.shape[1]
    padded = np.pad(ink, ((0, pad_h), (0, pad_w)), constant_values=False)
    coverage = padded.reshape(bh, block, bw, block).mean(axis=(1, 3))
    flagged = halftone | (coverage >= 0.55)
    if not flagged.any():
        return flagged, stats

    # Fill each contiguous group of flagged blocks to its bounding box, and
    # only keep groups big enough to be a picture rather than a headline.
    group = components(flagged)
    min_side = max(int(math.ceil(0.75 * inch / block)), 2)
    out = np.zeros_like(flagged)
    for i in range(group.count):
        if int(group.bbox_h[i]) < min_side or int(group.bbox_w[i]) < min_side:
            continue
        out[
            int(group.top[i]) : int(group.bottom[i]) + 1,
            int(group.left[i]) : int(group.right[i]) + 1,
        ] = True
    stats["picture_blocks"] = int(out.sum())
    return out, stats


def _expand_blocks(blocks: np.ndarray, shape: tuple[int, int], block: int) -> np.ndarray:
    grown = np.repeat(np.repeat(blocks, block, axis=0), block, axis=1)
    return grown[: shape[0], : shape[1]]


def segment(
    gray: np.ndarray, *, dpi: int, k: float
) -> tuple[np.ndarray, np.ndarray, dict]:
    """`(ink, pictorial, stats)` — the stencil, and what was kept OUT of it.

    `pictorial` marks pixels that ARE ink-dark but belong to a photograph or a
    halftone. They are excluded from the stencil (rule 3) and are the reason
    the background's resolution rises to carry them.

    The order is pictorial → measure → threshold again, for the reason
    `estimate_text_height` records.
    """
    scale = max(dpi, 1) / 300.0
    noise_floor = max(3, int(round(3 * scale * scale)))
    default_window = max(int(round(25 * scale)) | 1, 15)
    block = max(max(dpi, 1) // 4, 8)

    # Pass 1: a default window, good enough to find the pictures and to
    # measure the type that is left.
    first = sauvola_ink(gray, default_window, k)
    comp = components(first)
    stats: dict = {
        "window": default_window,
        "text_height": 0,
        "components": comp.count,
        "speckle_dropped": 0,
        "picture_components": 0,
        "halftone_blocks": 0,
        "picture_blocks": 0,
    }
    if comp.count == 0:
        stats["text_height"] = max(int(round(12 * scale)), 4)
        return first, np.zeros_like(first), stats

    speckle = comp.area < noise_floor
    blocks, block_stats = _pictorial_blocks(first, comp, speckle, dpi=dpi)
    stats.update(block_stats)
    picture_area = _expand_blocks(blocks, first.shape, block)

    # A component that sits inside a picture block, or is itself a large
    # solid mass (a logo, a photograph that survived as one component), does
    # not vote on the text height and does not enter the stencil.
    centres_y = np.clip((comp.top + comp.bottom) // 2, 0, first.shape[0] - 1)
    centres_x = np.clip((comp.left + comp.right) // 2, 0, first.shape[1] - 1)
    in_picture = picture_area[centres_y, centres_x]
    inch = max(dpi, 1)
    solid = (
        (comp.bbox_h >= inch // 2) & (comp.bbox_w >= inch // 2) & (comp.fill >= 0.5)
    )
    pictorial_comp = (in_picture | solid) & ~speckle
    stats["picture_components"] = int(pictorial_comp.sum())

    text_h = estimate_text_height(
        comp, ~(speckle | pictorial_comp), fallback=max(int(round(12 * scale)), 4)
    )
    window = int(min(max(text_h * 2 + 1, max(int(round(15 * scale)) | 1, 15)), 151)) | 1
    stats["window"] = window
    stats["text_height"] = text_h

    # Pass 2: the window the page asked for.
    ink = sauvola_ink(gray, window, k)
    comp2 = components(ink)
    stats["components"] = comp2.count
    pictorial = np.zeros_like(ink)
    if comp2.count == 0:
        return ink, pictorial, stats

    speckle2 = comp2.area < noise_floor
    stats["speckle_dropped"] = int(speckle2.sum())
    _clear_runs(ink, comp2, speckle2)

    cy2 = np.clip((comp2.top + comp2.bottom) // 2, 0, ink.shape[0] - 1)
    cx2 = np.clip((comp2.left + comp2.right) // 2, 0, ink.shape[1] - 1)
    solid2 = (
        (comp2.bbox_h >= inch // 2) & (comp2.bbox_w >= inch // 2) & (comp2.fill >= 0.5)
    )
    drop = ((picture_area[cy2, cx2]) | solid2) & ~speckle2
    if drop.any():
        _mark_runs(pictorial, comp2, drop)
        _clear_runs(ink, comp2, drop)
    # Whatever the second pass found inside a picture block belongs to the
    # background whether or not it survived as its own component.
    pictorial |= picture_area & ink
    ink &= ~picture_area
    return ink, pictorial, stats


def _mark_runs(target: np.ndarray, comp: _Components, keep: np.ndarray) -> None:
    """Set every run of a selected component — the inverse of `_clear_runs`."""
    hit = np.flatnonzero(keep[comp.labels])
    rows = comp.rows[hit].tolist()
    lo = comp.x0[hit].tolist()
    hi = comp.x1[hit].tolist()
    for r, a, b in zip(rows, lo, hi):
        target[r, a:b] = True


# --------------------------------------------------------------------------
# The continuous-tone layers (§ 3.3)
# --------------------------------------------------------------------------
_EPS = 1e-4


def _reduce(arr: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Area-average `arr` (H×W or H×W×C, float32) down to `size` = (w, h)."""
    w, h = size
    if arr.ndim == 2:
        return np.asarray(
            Image.fromarray(arr.astype(np.float32), mode="F").resize((w, h), Image.BOX),
            dtype=np.float32,
        )
    bands = [
        np.asarray(
            Image.fromarray(arr[..., c].astype(np.float32), mode="F").resize(
                (w, h), Image.BOX
            ),
            dtype=np.float32,
        )
        for c in range(arr.shape[2])
    ]
    return np.stack(bands, axis=-1)


def _expand(arr: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    w, h = size
    if arr.ndim == 2:
        return np.asarray(
            Image.fromarray(arr.astype(np.float32), mode="F").resize((w, h), Image.BILINEAR),
            dtype=np.float32,
        )
    bands = [
        np.asarray(
            Image.fromarray(arr[..., c].astype(np.float32), mode="F").resize(
                (w, h), Image.BILINEAR
            ),
            dtype=np.float32,
        )
        for c in range(arr.shape[2])
    ]
    return np.stack(bands, axis=-1)


def masked_mean(rgb: np.ndarray, keep: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """`blur(I·keep) / blur(keep)` at `size`, holes filled from coarser levels.

    Rule 1. A plain blur of the whole image smears ink back into the paper and
    the text ends up sitting on its own ghost; averaging over the KEEP pixels
    only is what preserves contrast. A block with no keep pixels at all — the
    middle of a thick rule, or a page of solid ink — has no answer at this
    scale, so the pyramid supplies one from a scale that does.
    """
    src = rgb.astype(np.float32, copy=False)
    keep_f = keep.astype(np.float32, copy=False)
    num = _reduce(src * keep_f[..., None], size)
    den = _reduce(keep_f, size)

    levels: list[tuple[np.ndarray, np.ndarray, tuple[int, int]]] = [(num, den, size)]
    w, h = size
    while (den < _EPS).any() and (w > 1 or h > 1):
        w, h = max(w // 2, 1), max(h // 2, 1)
        num = _reduce(num, (w, h))
        den = _reduce(den, (w, h))
        levels.append((num, den, (w, h)))

    num, den, _ = levels[-1]
    # Degenerate: a page with no keep pixels anywhere has no local answer at
    # ANY scale, so the source's global mean is the honest fallback — better
    # than the black plate a bare division by zero would produce.
    fallback = src.reshape(-1, src.shape[-1]).mean(axis=0).astype(np.float32)
    safe = np.maximum(den, _EPS)[..., None]
    result = np.where(den[..., None] > _EPS, num / safe, fallback)
    for num, den, lvl in reversed(levels[:-1]):
        up = _expand(result, lvl)
        safe = np.maximum(den, _EPS)[..., None]
        result = np.where(den[..., None] > _EPS, num / safe, up)
    return np.clip(result, 0.0, 255.0)


def _to_image(arr: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), mode="RGB")


def _mask_image(ink: np.ndarray) -> Image.Image:
    """The stencil in `mrc_codecs`' convention: mode "1", 0 = INK, 1 = paper."""
    return Image.fromarray(np.logical_not(ink))


# --------------------------------------------------------------------------
# Assembly (§ 3.4)
# --------------------------------------------------------------------------
def _image_xobject(pdf, data: bytes, width: int, height: int, filt: str, **extra):
    st = pikepdf.Stream(pdf, data)
    st["/Type"] = Name("/XObject")
    st["/Subtype"] = Name("/Image")
    st["/Width"] = int(width)
    st["/Height"] = int(height)
    st["/Filter"] = Name(filt)
    for key, value in extra.items():
        st["/" + key] = value
    return pdf.make_indirect(st)


def _stencil_xobject(pdf, stream):
    extra: dict = {"ImageMask": True}
    if stream.decode is not None:
        extra["Decode"] = pikepdf.Array(list(stream.decode))
    parms: dict = dict(stream.decode_parms or {})
    if stream.globals_data is not None:
        parms["JBIG2Globals"] = pdf.make_indirect(pikepdf.Stream(pdf, stream.globals_data))
    if parms:
        extra["DecodeParms"] = Dictionary(**parms)
    return _image_xobject(
        pdf,
        stream.data,
        stream.width,
        stream.height,
        "/CCITTFaxDecode" if stream.codec == CCITT_G4 else "/JBIG2Decode",
        **extra,
    )


# --------------------------------------------------------------------------
# The pass
# --------------------------------------------------------------------------
def resolve_preset(preset: str) -> dict:
    key = str(preset or DEFAULT_PRESET).strip().lower()
    if key not in PRESETS:
        raise ValueError(
            f"unknown MRC preset: {preset} (expected one of {', '.join(sorted(PRESETS))})"
        )
    return dict(PRESETS[key]) | {"name": key}


def resolve_mask_codec(name: str) -> str:
    key = str(name).strip().lower()
    if key in MASK_CODEC_ALIASES:
        return MASK_CODEC_ALIASES[key]
    raise ValueError(
        f"unknown MRC mask codec: {name} (expected one of "
        f"{', '.join(sorted(MASK_CODEC_ALIASES))})"
    )


def mrc_compress(
    file: str,
    output: str,
    *,
    preset: str = DEFAULT_PRESET,
    mask_codec: str = "",
    bg_div: int | None = None,
    fg_div: int | None = None,
    pdfa_safe: bool = False,
    verify_text: bool = False,
    lang: str = "eng",
    tesseract_path: str = "",
    gs_path: str = "gs",
    jbig2_path: str = "",
) -> dict:
    """Rewrite every scanned page of `file` as MRC layers into `output`.

    Document-scoped on purpose: JBIG2 symbol mode shares ONE `/JBIG2Globals`
    dictionary across pages, and that sharing is a large part of the
    multi-page win — a per-page pass throws it away.

    Signed documents: this is a full content rewrite, which
    `engine/incremental.py`'s transplant explicitly does not cover, so there
    is no append path and none is invented. The panel writes to a NEW file
    (Compress's shipped semantics); the in-place CLI and guided-action arms
    carry the same warning `compress` already carries.

    `verify_text` (slice E) recognises the SOURCE page and the reconstructed
    MRC page and REFUSES any page whose text similarity falls below the
    preset's threshold — that page keeps its original scan and the report says
    why. `engine/mrc_verify.py` records why the check is made against the
    encoded layers and why it runs before the surgery rather than after it.
    """
    settings = resolve_preset(preset)
    if mask_codec:
        codec = resolve_mask_codec(mask_codec)
        allow_fallback = False
    else:
        codec = settings["mask_codec"]
        allow_fallback = True
    if pdfa_safe:
        # PDF/A-1's filter set has no /JPXDecode and no JBIG2; forcing them
        # here saves a full re-render for anyone whose destination is PDF/A-1.
        # (Not strictly necessary — gs transcodes on the way — which is why it
        # is a modifier and not a fourth preset.)
        if mask_codec and codec != CCITT_G4:
            # Two explicit requests that cannot both hold. Overriding one of
            # them silently is exactly the "silent codec swap" slice B refused
            # to make, so the contradiction is named instead.
            raise ValueError(
                f"PDF/A-1 has no JBIG2 filter, so the mask codec {mask_codec} and "
                "the PDF/A-safe option cannot both apply — choose one."
            )
        codec = CCITT_G4
        allow_fallback = True
    # `is not None`, never truthiness: a divisor of 0 is a caller mistake that
    # must be REFUSED by name, and falsiness would silently substitute the
    # preset's value for it.
    bg_divisor = int(bg_div) if bg_div is not None else int(settings["bg_div"])
    fg_divisor = int(fg_div) if fg_div is not None else int(settings["fg_div"])
    if not 1 <= bg_divisor <= 12:
        raise ValueError(f"the MRC background divisor must be 1-12, got {bg_divisor}")
    if not 1 <= fg_divisor <= 12:
        raise ValueError(f"the MRC foreground divisor must be 1-12, got {fg_divisor}")
    if not gs_path or not os.path.isfile(gs_path):
        # Rule 4: every mask is decode-verified through an independent
        # decoder before it is embedded, and Ghostscript is that decoder.
        raise RuntimeError(
            f"Ghostscript is not available at {gs_path or '(no path given)'} — MRC cannot "
            "verify the stencils it writes, and an unverified stencil is not shippable."
        )
    verify_threshold = float(settings["verify_threshold"])
    if verify_text and (not tesseract_path or not os.path.isfile(tesseract_path)):
        # Asked for and not available REFUSES. Running the compression with
        # the check quietly skipped would hand back exactly the output the
        # switch exists to prevent, under a setting that says otherwise.
        raise RuntimeError(
            f"The OCR engine is not available at {tesseract_path or '(no path given)'}, so "
            "the text of an MRC page cannot be verified. Turn off text verification or "
            "run scripts/bundle-tesseract.ps1."
        )

    info = validate_pdf(file)
    input_path = Path(file)
    output_path = Path(output)
    original_size = input_path.stat().st_size

    pages: list[dict] = []
    # What survives between the two passes is the MASK, never the source. The
    # unit of work is the DOCUMENT (symbol mode shares one dictionary across
    # every page), so pass one has to finish before any page can be encoded —
    # and holding each page's RGB samples and boolean ink map until then costs
    # ~33 MB per page, which is 6.6 GB on a 200-page scan. A 1-bit mask is
    # ~1 MB, and pass two re-lifts the one source it is working on.
    prepared: list[tuple[_Candidate, Image.Image, dict, int]] = []

    with pikepdf.open(file) as pdf:
        candidates: list[_Candidate] = []
        for number, page in enumerate(pdf.pages, start=1):
            candidate, reason = _classify_page(pdf, page, number)
            if candidate is None:
                pages.append(
                    {"page": number, "decision": DECISION_UNTOUCHED, "reason": reason}
                )
            else:
                candidates.append(candidate)
        if not candidates:
            raise ValueError(
                "no page in this document is a scanned image — MRC compression has "
                "nothing to separate"
            )

        for candidate in candidates:
            page = pdf.pages[candidate.page_number - 1]
            source = _lift_image(pdf, page, candidate)
            if source is None:
                source = _rasterize_placement(file, candidate, page, gs_path)
            gray = np.asarray(source.convert("L"), dtype=np.uint8)
            ink, pictorial, stats = segment(
                gray, dpi=candidate.source_dpi, k=float(settings["sauvola_k"])
            )
            # Rule 3's consequence: a page carrying pictorial content gets a
            # finer background, because the background is now the ONLY layer
            # that content lives in.
            page_bg_div = min(bg_divisor, 2) if pictorial.any() else bg_divisor
            prepared.append((candidate, _mask_image(ink), stats, page_bg_div))
            del source, gray, ink, pictorial

        masks = [item[1] for item in prepared]
        streams, used_codec = encode_mask(
            masks,
            codec=codec,
            jbig2_path=jbig2_path,
            symbol_threshold=float(settings["symbol_threshold"]),
            allow_fallback=allow_fallback,
        )

        applied = 0
        reverted = 0
        lowest: float | None = None
        for (candidate, mask, stats, page_bg_div), stream in zip(prepared, streams):
            page = pdf.pages[candidate.page_number - 1]
            try:
                # Rule 4 — in the PRODUCTION path, not only in the tests.
                verify_mask_stream(
                    stream, gs_path, tolerance=0.005 if used_codec == JBIG2_SYMBOL else 0.001
                )
            except RuntimeError as exc:
                pages.append(
                    {
                        "page": candidate.page_number,
                        "decision": DECISION_UNTOUCHED,
                        "reason": f"mask verification failed: {exc}",
                    }
                )
                continue

            source = _lift_image(pdf, page, candidate)
            if source is None:
                source = _rasterize_placement(file, candidate, page, gs_path)
            rgb = np.asarray(source, dtype=np.uint8)
            # The stencil IS the segmentation — re-deriving the ink map from
            # it costs nothing and cannot disagree with what was encoded.
            paper = np.asarray(mask, dtype=bool)
            ink = np.logical_not(paper)
            bg_size = (
                max(source.width // page_bg_div, 1),
                max(source.height // page_bg_div, 1),
            )
            background = _to_image(masked_mean(rgb, paper, bg_size))
            if pdfa_safe:
                bg_bytes = encode_layer_jpeg(background, quality=75)
                bg_filter = "/DCTDecode"
            else:
                bg_bytes = encode_layer_jpx(background, rate=int(settings["bg_rate"]))
                bg_filter = "/JPXDecode"

            if ink.any():
                fg_size = (
                    max(source.width // fg_divisor, 1),
                    max(source.height // fg_divisor, 1),
                )
                fg_arr = masked_mean(rgb, ink, fg_size)
                # CHROMA of the downsampled layer — see
                # FLAT_INK_CHROMA_VARIANCE. Two things had to be got right
                # here and each was measured, not reasoned: the variance is
                # taken on the MASKED MEAN (the source ink set is full of
                # half-paper antialiasing pixels, whose spread says nothing
                # about the ink), and it is taken on the chroma (a single
                # black ink varies in lightness with stroke weight, and
                # judging on that never collapses the page the collapse
                # exists for).
                chroma = fg_arr - fg_arr.mean(axis=-1, keepdims=True)
                flat = float(chroma.reshape(-1, 3).var(axis=0).mean())
                if flat < FLAT_INK_CHROMA_VARIANCE:
                    # The common case — one ink. A 1×1 image is tens of
                    # kilobytes smaller and renders identically under the
                    # stencil, which is the only place it is ever seen.
                    fg_arr = fg_arr.reshape(-1, 3).mean(axis=0).reshape(1, 1, 3)
                foreground = _to_image(fg_arr)
            else:
                foreground = Image.new("RGB", (1, 1), (0, 0, 0))
            fg_bytes = encode_layer_jpeg(foreground, quality=int(settings["fg_quality"]))

            similarity: float | None = None
            if verify_text:
                # Slice E. Reconstruct what a viewer will draw from the bytes
                # about to be embedded, recognise both rasters, and REFUSE the
                # page if the words did not survive. This runs BEFORE any
                # object is created or any content stream is touched, so a
                # refusal leaves the page exactly as it arrived — there is no
                # undo path that could get it wrong.
                recon = mrc_verify.reconstruct_page(
                    bg_bytes, fg_bytes, ink, (source.width, source.height)
                )
                similarity, divergence = mrc_verify.compare_page(
                    source, recon, lang, tesseract_path
                )
                del recon
                if similarity < verify_threshold:
                    reverted += 1
                    reason = (
                        f"text verification failed: {similarity:.4f} of the source page's "
                        f"words survived, below this preset's {verify_threshold:.2f} floor"
                    )
                    if divergence:
                        reason = f"{reason} (first difference — {divergence})"
                    pages.append(
                        {
                            "page": candidate.page_number,
                            "decision": DECISION_REVERTED,
                            "reason": reason,
                            "text_similarity": round(similarity, 4),
                            "verify_threshold": verify_threshold,
                        }
                    )
                    continue
                lowest = similarity if lowest is None else min(lowest, similarity)

            stencil = _stencil_xobject(pdf, stream)
            bg_obj = _image_xobject(
                pdf, bg_bytes, background.width, background.height, bg_filter,
                **(
                    {"ColorSpace": Name("/DeviceRGB"), "BitsPerComponent": 8}
                    if bg_filter == "/DCTDecode"
                    else {}
                ),
            )
            fg_obj = _image_xobject(
                pdf, fg_bytes, foreground.width, foreground.height, "/DCTDecode",
                ColorSpace=Name("/DeviceRGB"), BitsPerComponent=8, Mask=stencil,
            )
            replace_placement_with_layers(pdf, page, candidate.index, [bg_obj, fg_obj])
            applied += 1
            pages.append(
                {
                    "page": candidate.page_number,
                    "decision": DECISION_MRC,
                    "mask_bytes": len(stream.data),
                    "bg_bytes": len(bg_bytes),
                    "fg_bytes": len(fg_bytes),
                    "source_dpi": candidate.source_dpi,
                    "bg_div": page_bg_div,
                    "fg_div": fg_divisor,
                    "text_height": stats["text_height"],
                    "window": stats["window"],
                    "picture_components": stats["picture_components"],
                    "picture_blocks": stats["picture_blocks"],
                    "halftone_blocks": stats["halftone_blocks"],
                    **(
                        {"text_similarity": round(similarity, 4)}
                        if similarity is not None
                        else {}
                    ),
                }
            )

        if applied == 0:
            if reverted:
                raise RuntimeError(
                    "every scanned page failed text verification — no MRC output was "
                    "written, because a page whose words did not survive is not an "
                    "output worth having. Try the archival preset, which keeps thin "
                    "strokes."
                )
            raise RuntimeError(
                "every scanned page failed mask verification — no MRC output was written"
            )
        _save(pdf, input_path, output_path)

    pages.sort(key=lambda row: row["page"])
    return {
        "output": str(output_path),
        "original_size": original_size,
        "compressed_size": output_path.stat().st_size,
        "output_size": output_path.stat().st_size,
        "quality": "mrc",
        "preset": settings["name"],
        "mask_codec": used_codec,
        "requested_mask_codec": codec,
        "pdfa_safe": bool(pdfa_safe),
        "verify_text": bool(verify_text),
        "verify_threshold": verify_threshold if verify_text else None,
        "min_text_similarity": round(lowest, 4) if lowest is not None else None,
        "pages": pages,
        "pages_mrc": applied,
        "pages_reverted": reverted,
        "pages_untouched": info["pages"] - applied,
    }


def _save(pdf, input_path: Path, output_path: Path) -> None:
    """`page_images._save`'s semantics, verbatim: identity-aware, and the Pdf
    is CLOSED before the rename — Windows refuses to replace an open file."""
    import shutil
    import stat

    same = input_path.resolve() == output_path.resolve() or (
        output_path.exists() and os.path.samefile(str(input_path), str(output_path))
    )
    if same:
        with tempfile.NamedTemporaryFile(
            suffix=".pdf", delete=False, dir=str(input_path.parent)
        ) as tmp:
            tmp_path = tmp.name
        pdf.save(tmp_path)
        pdf.close()
        shutil.move(tmp_path, str(output_path))
    else:
        if output_path.exists() and not os.access(output_path, os.W_OK):
            os.chmod(output_path, stat.S_IWRITE)
        pdf.save(str(output_path))
