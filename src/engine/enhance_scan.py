"""Scan enhancement — deskew, despeckle, background whitening, orientation.

A scan arrives with the defects of the machine that made it: the sheet went
through the feeder a degree or two off square, the platen threw dust, the
paper photographed as grey rather than white, and the page went in sideways.
Each of those is a MEASUREMENT of the page before it is a correction of it,
and every measurement this module needs already exists in `engine/mrc.py`:

  * `_classify_page` decides whether a page IS a scan — one upright image
    covering the page and nothing else drawn over it. Reused rather than
    re-derived, so "is this a scan" has exactly one answer in the product;
  * `segment` measures the page's own glyph height, Sauvola-binarizes it at
    the window that measurement asks for, and separates pictorial regions
    (photographs, halftones) from type;
  * `components` labels connected components by union-find over row runs;
  * `masked_mean` estimates the paper as `blur(I·paper)/blur(paper)`.

Four arms, three of which rewrite pixels and one of which does not:

1. **Deskew** — a projection-profile search over a SHEARED accumulation
   (bin `y + x·tan θ`, score the profile's own first-difference energy).
   Binning rather than rotating is what makes the search affordable; a
   rotation per candidate angle would be a full resample of the page each
   time. Measured worst error over -12°..+8°: 0.02°.
2. **Despeckle** — small, non-pictorial, ISOLATED components painted with the
   local paper estimate. All three conditions are required: a period is small
   and a halftone dot is small, and neither is a speck.
3. **Background** — a flat-field divide by the local paper estimate, which
   removes a gradient (a gutter shadow, an uneven platen) rather than merely
   lightening it.
4. **Orientation** — `tesseract --psm 0`, applied as the page's `/Rotate`.
   LOSSLESS: it never touches a pixel.

Correctness constraints:

1. **Skew is measured on the ORIGINAL samples.** A measurement taken after a
   bicubic rotation measures the interpolation as much as the page.
2. **Despeckle and background run BEFORE the rotation**, for the same reason:
   a speck smeared by bicubic interpolation is no longer a compact component,
   and the mask that would have caught it misses.
3. **The segmentation is computed ONCE per page** and feeds all three raster
   arms. Two segmentations that disagreed would be two answers to "where is
   the ink".
4. **The raster keeps its pixel dimensions and its channel count.** The
   rotation is `expand=False` with a paper fill, so the placement's CTM stays
   exactly valid; a greyscale scan stays greyscale rather than being tripled
   into RGB.
5. **The output codec follows the source's own class.** A lossy source
   re-encodes as JPEG, a lossless one as Flate — an enhancement must not
   silently inflate a file, nor silently degrade a lossless one.
"""

from __future__ import annotations

import io
import math
import os
import subprocess
import tempfile
import zlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pikepdf
from PIL import Image
from pikepdf import Name

from .mrc import (
    DECISION_UNTOUCHED,
    _Candidate,
    _box_sums,
    _classify_page,
    _expand,
    _integral,
    _mark_runs,
    _rasterize_placement,
    _save,
    components,
    masked_mean,
    sauvola_ink,
    segment,
)
from .page_images import _walk_placements, replace_placement_with_layers
from .redact import IDENTITY, _lookup_xobject, _resolve_resources
from .validate import validate_pdf

# --------------------------------------------------------------------------
# Decisions. Reported, never fatal — a mixed document is enhanced on its
# scanned pages and left byte-identical on the rest.
# --------------------------------------------------------------------------
#: `analyze_scan` only: the page is a scan and here is what was measured.
DECISION_SCAN = "scan"
DECISION_ENHANCED = "enhanced"
#: The page IS a scan and every enabled arm measured nothing to do — a
#: distinct decision from "untouched", because the two mean different things
#: to whoever reads the report: one page was not a scan, the other was already
#: square, clean and white.
DECISION_UNCHANGED = "unchanged"

# --------------------------------------------------------------------------
# Defaults, each measured rather than chosen — the measurement is stated on
# the constant it produced, and pinned in `tests/test_enhance_scan.py`.
# --------------------------------------------------------------------------
#: Search half-range, degrees. Larger than any sheet feeder produces, small
#: enough that a page of ruled tables cannot lock onto a spurious far peak.
DEFAULT_MAX_SKEW = 10.0
#: Below this the rotation is resampling that costs sharpness and buys
#: nothing, so the angle is REPORTED and not applied. This is also what makes
#: deskew idempotent: the residual after one pass measures ~0.02°.
DEFAULT_MIN_SKEW = 0.1
#: Largest half-range a caller may ask for. Past 45° the question is
#: orientation, not skew, and OSD answers it losslessly.
MAX_SKEW_LIMIT = 45.0
#: Speck bounding-box side, INCHES so the threshold is resolution-independent.
#: Swept on a clean page and the same page with injected specks: 0.010 in
#: removes 430 specks and 0 real marks, 0.014 in removes 499 specks and 68
#: REAL MARKS — at 300 dpi that is 4 px, and a full stop at 11 pt is about 4 px
#: across. The default sits one step below the first false positive.
DEFAULT_SPECK_SIZE_IN = 0.01
#: A speck must have no substantial ink within this distance. What protects a
#: period, an i-dot, an accent and a dotted leader: each is small, none alone.
DEFAULT_SPECK_GAP_IN = 0.02
#: Mean paper level, 0-255, at or above which the background arm declines.
#: Not a cosmetic guard: without it every page would be decoded and re-encoded
#: on every run, so a second pass over an already-enhanced document would
#: spend a JPEG generation to change nothing. Measured — a page this pass has
#: already whitened reads 252.7-253.9, and the dimmest page that still wants
#: work reads 242.9, so 250 sits between the two populations.
BACKGROUND_TRIGGER = 250.0
#: Tesseract OSD orientation confidence floor. Measured over the constructed
#: fixtures: the worst CORRECT determination scored 15.02 (upright) and the
#: best UNUSABLE one scored 0.92 (a blank page). 2.0 sits between the two
#: populations — above every reading from a page that had nothing to read, and
#: 7.5x below the weakest reading from a page that did.
DEFAULT_OSD_CONFIDENCE = 2.0
#: Re-encode quality for a lossy source. High enough that the second
#: generation does not spend the pass's gain on JPEG artefacts, low enough not
#: to inflate the file: measured against the quality-80 skew fixture, 85 came
#: out at 1.04x the source and 90 at 1.37x.
DEFAULT_JPEG_QUALITY = 85
#: Paper-estimate reduction. The estimate has to be coarse enough to be paper
#: and fine enough to follow a gutter shadow; 1/8 of the page is both.
PAPER_DIV = 8
#: The Sauvola k the analysis runs at — `PRESETS["balanced"]`'s value. Named
#: here rather than imported from a preset: this pass has no presets, and
#: borrowing a compression preset's name for a threshold that is not about
#: compression would tie two unrelated knobs together.
SEGMENT_K = 0.20
#: The skew search binarizes a DOWNSAMPLED page — measured, full-res Sauvola
#: costs ~700 ms and returns +2.75 where half-res costs ~174 ms and returns
#: +2.74. The line structure the estimator needs survives the downsample.
SKEW_TARGET_DPI = 150
#: Ink points the search scores. 50k / 100k / 200k / 400k all returned the
#: same angle to three decimals; the search costs 29 ms at the cap and 158 ms
#: uncapped.
SKEW_POINT_CAP = 50_000
#: Fewer ink points than this and the estimator REFUSES to invent an angle.
SKEW_MIN_POINTS = 64


@dataclass
class _Measured:
    """Everything one page's analysis produced, before anything is written."""

    candidate: _Candidate
    image: Image.Image
    source_filter: str
    #: H x W x C float32 — the source samples, channel count preserved.
    samples: np.ndarray
    ink: np.ndarray
    speck_mask: np.ndarray | None
    speck_count: int
    paper: np.ndarray | None  # full-resolution paper estimate, H x W x C
    paper_before: float
    skew_deg: float
    orientation: dict | None
    orientation_error: str


# --------------------------------------------------------------------------
# Lifting the source pixels — channel-preserving, unlike mrc._lift_image
# --------------------------------------------------------------------------
def _filter_name(xobj) -> str:
    """The LAST filter in the chain, which is the one that decoded the samples."""
    filt = xobj.get("/Filter")
    if filt is None:
        return ""
    if isinstance(filt, pikepdf.Array):
        return str(filt[-1]) if len(filt) else ""
    return str(filt)


def _lift(pdf, page, candidate: _Candidate) -> tuple[Image.Image | None, str]:
    """`(image, source filter)` — the scan's OWN samples, mode preserved.

    Returns `(None, filter)` rather than raising when this runtime cannot
    decode the codestream (a JPX scan on a build without openjpeg is the live
    case), so the caller falls through to the rasterizer instead of losing
    the page. Deliberately NOT `mrc._lift_image`: that one converts to RGB,
    which would triple a greyscale scan.
    """
    resources = _resolve_resources(page)
    placements = _walk_placements(
        pdf, pikepdf.parse_content_stream(page), resources, IDENTITY, 0, None, [], False
    )
    target = placements[candidate.index]
    xobj = _lookup_xobject(target["name"], resources, None)
    if xobj is None:
        return None, ""
    filt = _filter_name(xobj)
    try:
        im = pikepdf.PdfImage(xobj).as_pil_image()
    except Exception:
        return None, filt
    if im.mode not in ("L", "RGB"):
        im = im.convert("RGB")
    return im, filt


def _to_samples(image: Image.Image) -> np.ndarray:
    """H x W x C float32. C is 1 for greyscale — the third axis is always
    present so the shared pyramid code has one shape to handle."""
    arr = np.asarray(image, dtype=np.float32)
    return arr[..., None] if arr.ndim == 2 else arr


def _to_image(samples: np.ndarray) -> Image.Image:
    arr = np.clip(samples, 0, 255).astype(np.uint8)
    if arr.shape[-1] == 1:
        return Image.fromarray(arr[..., 0], mode="L")
    return Image.fromarray(arr, mode="RGB")


# --------------------------------------------------------------------------
# Deskew
# --------------------------------------------------------------------------
def _profile_score(ys: np.ndarray, xs: np.ndarray, angle_deg: float) -> float:
    """Energy of the first difference of the projection profile at `angle_deg`.

    The profile alternates hardest between line and interline when the text
    lines lie along the bins, so this peaks at the page's own skew.
    """
    idx = np.rint(ys + xs * math.tan(math.radians(angle_deg))).astype(np.int64)
    idx -= idx.min()
    profile = np.bincount(idx).astype(np.float64)
    if profile.size < 4:
        return 0.0
    d = np.diff(profile)
    return float(d @ d)


def estimate_skew(gray: np.ndarray, *, dpi: int, max_deg: float = DEFAULT_MAX_SKEW) -> float:
    """The page's own rotation in degrees, POSITIVE counter-clockwise.

    The correction is its negation. Returns 0.0 for a page with too little ink
    to measure — a refusal to invent an angle, not a coincidence.
    """
    factor = max(1, int(round(dpi / SKEW_TARGET_DPI)))
    if factor > 1:
        small = Image.fromarray(gray).resize(
            (max(gray.shape[1] // factor, 1), max(gray.shape[0] // factor, 1)), Image.BOX
        )
        work = np.asarray(small, dtype=np.uint8)
        work_dpi = dpi / factor
    else:
        work, work_dpi = gray, float(dpi)
    if work.shape[0] < 8 or work.shape[1] < 8:
        return 0.0

    window = max(int(round(25 * work_dpi / 300.0)) | 1, 15)
    ink = sauvola_ink(work, window, SEGMENT_K)
    ys, xs = np.nonzero(ink)
    if ys.size < SKEW_MIN_POINTS:
        return 0.0
    if ys.size > SKEW_POINT_CAP:
        step = int(math.ceil(ys.size / SKEW_POINT_CAP))
        ys, xs = ys[::step], xs[::step]
    ys = ys.astype(np.float64)
    xs = xs.astype(np.float64)

    best = 0.0
    # Coarse, then two refinements. A 0.01° grid across the whole range would
    # be 2000 evaluations for the same answer three passes reach in ~100.
    for step_deg, span in ((0.5, max_deg), (0.05, 0.6), (0.01, 0.06)):
        grid = np.round(np.arange(best - span, best + span + 1e-9, step_deg), 4)
        grid = grid[(grid >= -max_deg - 1e-9) & (grid <= max_deg + 1e-9)]
        if grid.size == 0:
            break
        best = float(grid[int(np.argmax([_profile_score(ys, xs, a) for a in grid]))])
    return round(best, 2)


# --------------------------------------------------------------------------
# Despeckle
# --------------------------------------------------------------------------
def find_specks(
    gray: np.ndarray,
    pictorial: np.ndarray,
    window: int,
    *,
    dpi: int,
    size_in: float = DEFAULT_SPECK_SIZE_IN,
    gap_in: float = DEFAULT_SPECK_GAP_IN,
) -> tuple[np.ndarray, int]:
    """`(mask, count)` — the isolated specks on this page.

    Three conditions, all required. SMALL alone would take every full stop on
    the page; small and NOT PICTORIAL would still take every halftone dot that
    happened to fall outside a flagged block; small, not pictorial and
    ISOLATED is a speck.

    The isolation test is a box sum of the substantial-ink mask read at each
    candidate's centre — the same integral-image primitive Sauvola runs on,
    so no second neighbourhood idiom enters the module.
    """
    raw = sauvola_ink(gray, window, SEGMENT_K)
    comp = components(raw)
    empty = np.zeros_like(raw)
    if comp.count == 0:
        return empty, 0

    side = max(2, int(round(size_in * max(dpi, 1))))
    small = (comp.bbox_h <= side) & (comp.bbox_w <= side) & (comp.area <= side * side)
    cy = np.clip((comp.top + comp.bottom) // 2, 0, raw.shape[0] - 1)
    cx = np.clip((comp.left + comp.right) // 2, 0, raw.shape[1] - 1)
    small &= ~pictorial[cy, cx]
    if not small.any():
        return empty, 0

    substantial = np.zeros_like(raw)
    _mark_runs(substantial, comp, ~small)
    gap = max(1, int(round(gap_in * max(dpi, 1))))
    near, _counts = _box_sums(_integral(substantial.astype(np.float64)), gap)
    isolated = small & (near[cy, cx] <= 0.5)
    if not isolated.any():
        return empty, 0

    mask = np.zeros_like(raw)
    _mark_runs(mask, comp, isolated)
    return mask, int(isolated.sum())


# --------------------------------------------------------------------------
# Background
# --------------------------------------------------------------------------
def paper_estimate(samples: np.ndarray, keep: np.ndarray) -> np.ndarray:
    """The paper, at full resolution — `blur(I·keep)/blur(keep)` upsampled.

    Averaged over PAPER pixels only, per `mrc.masked_mean`'s rule 1: a blur of
    the whole image smears ink back into the paper, and dividing by that
    leaves the text sitting in its own halo.
    """
    h, w = samples.shape[:2]
    coarse = masked_mean(samples, keep, (max(w // PAPER_DIV, 1), max(h // PAPER_DIV, 1)))
    return _expand(coarse, (w, h))


def whiten(samples: np.ndarray, paper: np.ndarray, strength: float) -> np.ndarray:
    """Flat-field the page toward paper white, blended by `strength`.

    A DIVIDE by the local estimate, not a subtraction of a global level: the
    divide removes a gradient, a subtraction only lightens one.
    """
    corrected = np.clip(samples * 255.0 / np.maximum(paper, 1.0), 0.0, 255.0)
    return samples * (1.0 - strength) + corrected * strength


# --------------------------------------------------------------------------
# Orientation
# --------------------------------------------------------------------------
def _tessdata_for(exe: Path) -> Path:
    tessdata = exe.parent / "tessdata"
    if not tessdata.is_dir():
        raise RuntimeError(f"No tessdata beside {exe}; run scripts/bundle-tesseract.ps1.")
    return tessdata


def detect_orientation(
    image: Image.Image, tesseract_path: str, *, dpi: int = 300
) -> tuple[dict | None, str]:
    """`(reading, error)` from `tesseract --psm 0`.

    The reading is `{rotate, confidence, script, script_confidence}`. `rotate`
    is Tesseract's own CLOCKWISE correction, which is the same sense as PDF
    `/Rotate`, so the two compose with no sign conversion.

    A page Tesseract will not judge (its "Too few characters" refusal is the
    live case) returns `(None, reason)` — a refusal is a result, and a page
    that could not be read is not a page that is upright.
    """
    exe = Path(tesseract_path) if tesseract_path else Path()
    if not exe.is_file():
        raise RuntimeError(
            "The OCR engine is not available: no tesseract.exe at "
            f"{tesseract_path or '(no path given)'}. Turn off orientation detection or "
            "run scripts/bundle-tesseract.ps1."
        )
    tessdata = _tessdata_for(exe)
    with tempfile.TemporaryDirectory(prefix="spectrapdf_osd_") as work:
        png = Path(work) / "page.png"
        # The resolution is written into the PNG because Tesseract otherwise
        # guesses, warns, and judges a page at 70 dpi that is really 300.
        image.save(png, dpi=(max(dpi, 1), max(dpi, 1)))
        env = dict(os.environ)
        env["TESSDATA_PREFIX"] = str(tessdata)
        proc = subprocess.run(
            [str(exe), str(png), "stdout", "--psm", "0", "--tessdata-dir", str(tessdata)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
        )
    fields: dict[str, str] = {}
    for line in (proc.stdout or "").splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            fields[key.strip()] = value.strip()
    if "Rotate" not in fields:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        reason = next(
            (ln.strip() for ln in reversed(detail) if ln.strip() and not ln.startswith("Estimating")),
            "no orientation was reported",
        )
        return None, reason
    try:
        reading = {
            "rotate": int(fields["Rotate"]) % 360,
            "confidence": float(fields.get("Orientation confidence", "0") or 0.0),
            "script": fields.get("Script", "") or "",
            "script_confidence": float(fields.get("Script confidence", "0") or 0.0),
        }
    except (TypeError, ValueError):
        return None, "the orientation reading could not be read"
    return reading, ""


# --------------------------------------------------------------------------
# Re-encoding
# --------------------------------------------------------------------------
#: The filters whose sources were already lossy. Re-encoding one as JPEG costs
#: a generation; re-encoding it as Flate would multiply the file size for a
#: fidelity that was never there.
LOSSY_FILTERS = frozenset({"/DCTDecode", "/JPXDecode"})


def _encode(image: Image.Image, source_filter: str, quality: int) -> tuple[bytes, str, str]:
    """`(bytes, /Filter, /ColorSpace)` for the enhanced raster."""
    colorspace = "/DeviceGray" if image.mode == "L" else "/DeviceRGB"
    if source_filter in LOSSY_FILTERS:
        buf = io.BytesIO()
        # Baseline, never progressive: a progressive JPEG is not a valid
        # /DCTDecode stream for every consumer.
        image.save(buf, format="JPEG", quality=quality, progressive=False)
        return buf.getvalue(), "/DCTDecode", colorspace
    return zlib.compress(image.tobytes(), 6), "/FlateDecode", colorspace


def _image_xobject(pdf, data: bytes, image: Image.Image, filt: str, colorspace: str):
    stream = pikepdf.Stream(pdf, data)
    stream["/Type"] = Name("/XObject")
    stream["/Subtype"] = Name("/Image")
    stream["/Width"] = int(image.width)
    stream["/Height"] = int(image.height)
    stream["/ColorSpace"] = Name(colorspace)
    stream["/BitsPerComponent"] = 8
    stream["/Filter"] = Name(filt)
    return pdf.make_indirect(stream)


# --------------------------------------------------------------------------
# Options
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class _Options:
    deskew: bool
    despeckle: bool
    background: bool
    orientation: bool
    max_skew_deg: float
    min_skew_deg: float
    speck_size_in: float
    speck_gap_in: float
    background_strength: float
    osd_confidence: float
    jpeg_quality: int


def _options(
    *,
    deskew: bool,
    despeckle: bool,
    background: bool,
    orientation: bool,
    max_skew_deg: float,
    min_skew_deg: float,
    speck_size_in: float,
    speck_gap_in: float,
    background_strength: float,
    osd_confidence: float,
    jpeg_quality: int,
) -> _Options:
    if not (deskew or despeckle or background or orientation):
        raise ValueError(
            "no enhancement was asked for — turn on deskew, despeckle, background "
            "removal or orientation detection"
        )
    max_skew = float(max_skew_deg)
    min_skew = float(min_skew_deg)
    if not 0.1 <= max_skew <= MAX_SKEW_LIMIT:
        raise ValueError(
            f"the maximum skew must be 0.1-{MAX_SKEW_LIMIT:g} degrees, got {max_skew:g}"
        )
    if not 0.0 <= min_skew <= max_skew:
        raise ValueError(
            f"the minimum skew must be 0-{max_skew:g} degrees, got {min_skew:g}"
        )
    size_in = float(speck_size_in)
    if not 0.001 <= size_in <= 0.05:
        raise ValueError(f"the speck size must be 0.001-0.05 inches, got {size_in:g}")
    gap_in = float(speck_gap_in)
    if not 0.0 <= gap_in <= 0.5:
        raise ValueError(f"the speck gap must be 0-0.5 inches, got {gap_in:g}")
    strength = float(background_strength)
    if not 0.0 <= strength <= 1.0:
        raise ValueError(f"the background strength must be 0-1, got {strength:g}")
    confidence = float(osd_confidence)
    if confidence < 0.0:
        raise ValueError(f"the orientation confidence floor cannot be negative, got {confidence:g}")
    quality = int(jpeg_quality)
    if not 1 <= quality <= 100:
        raise ValueError(f"the JPEG quality must be 1-100, got {quality}")
    return _Options(
        deskew=bool(deskew),
        despeckle=bool(despeckle),
        background=bool(background),
        orientation=bool(orientation),
        max_skew_deg=max_skew,
        min_skew_deg=min_skew,
        speck_size_in=size_in,
        speck_gap_in=gap_in,
        background_strength=strength,
        osd_confidence=confidence,
        jpeg_quality=quality,
    )


def _selected(pages, total: int) -> set[int]:
    """The 1-based page numbers to work on.

    The out-of-range refusal is spelled `page_no` and `int(total)` to land on
    the SAME row of the engine-message table every other module's version of
    this sentence lands on. The placeholder names come from the f-string's own
    expressions, so a bare `total` would rename the row's second capture from
    `{{v1}}` and orphan every catalog that already translates it.
    """
    if pages is None or pages == "all" or pages == "":
        return set(range(1, total + 1))
    if isinstance(pages, str):
        raise ValueError('pages must be a list of page numbers or "all"')
    out: set[int] = set()
    for value in pages:
        page_no = int(value)
        if not (1 <= page_no <= total):
            raise ValueError(f"page {page_no} is out of range (1-{int(total)})")
        out.add(page_no)
    if not out:
        raise ValueError("no page was selected")
    return out


# --------------------------------------------------------------------------
# The measurement
# --------------------------------------------------------------------------
def _measure(
    pdf, file: str, page, candidate: _Candidate, opts: _Options, gs_path: str, tesseract_path: str
) -> _Measured:
    """Everything one page's analysis produces. Writes nothing."""
    image, source_filter = _lift(pdf, page, candidate)
    if image is None:
        image = _rasterize_placement(file, candidate, page, gs_path)
        source_filter = "/DCTDecode"
    samples = _to_samples(image)
    gray = np.asarray(image.convert("L"), dtype=np.uint8)
    ink, pictorial, stats = segment(gray, dpi=candidate.source_dpi, k=SEGMENT_K)

    skew = (
        estimate_skew(gray, dpi=candidate.source_dpi, max_deg=opts.max_skew_deg)
        if opts.deskew
        else 0.0
    )

    speck_mask: np.ndarray | None = None
    speck_count = 0
    if opts.despeckle:
        speck_mask, speck_count = find_specks(
            gray,
            pictorial,
            int(stats["window"]),
            dpi=candidate.source_dpi,
            size_in=opts.speck_size_in,
            gap_in=opts.speck_gap_in,
        )

    paper_keep = ~ink if speck_mask is None else ~(ink | speck_mask)
    paper: np.ndarray | None = None
    if opts.despeckle or opts.background:
        paper = paper_estimate(samples, paper_keep)
    paper_before = float(samples[paper_keep].mean()) if paper_keep.any() else float(samples.mean())

    orientation: dict | None = None
    orientation_error = ""
    if opts.orientation:
        upright = image
        current = int(page.obj.get("/Rotate", 0)) % 360
        if current:
            # Measured against what a reader SEES: the placement is upright in
            # image space, and /Rotate is what turns it on the way to the
            # screen, so the reading has to be taken past that turn.
            upright = image.rotate(-current, expand=True)
        orientation, orientation_error = detect_orientation(
            upright, tesseract_path, dpi=candidate.source_dpi
        )

    return _Measured(
        candidate=candidate,
        image=image,
        source_filter=source_filter,
        samples=samples,
        ink=ink,
        speck_mask=speck_mask,
        speck_count=speck_count,
        paper=paper,
        paper_before=round(paper_before, 2),
        skew_deg=skew,
        orientation=orientation,
        orientation_error=orientation_error,
    )


def _measurement_row(m: _Measured, opts: _Options, *, with_filter: bool = False) -> dict:
    row: dict = {
        "page": m.candidate.page_number,
        "source_dpi": m.candidate.source_dpi,
        "width": m.candidate.width,
        "height": m.candidate.height,
        "skew_deg": m.skew_deg if opts.deskew else None,
        "specks": m.speck_count if opts.despeckle else None,
        "paper_before": m.paper_before,
    }
    if opts.orientation:
        row["orientation"] = m.orientation
        if m.orientation_error:
            row["orientation_reason"] = m.orientation_error
    if with_filter:
        row["source_filter"] = m.source_filter
    return row


def _would_act(m: _Measured, opts: _Options) -> tuple[bool, bool, bool, int]:
    """`(deskew, despeckle, background, rotate)` — what this page's numbers ask
    for. The ONE place the act/report distinction is decided, so the preview
    and the pass can never disagree about whether a page would change."""
    do_deskew = opts.deskew and abs(m.skew_deg) >= opts.min_skew_deg
    do_despeckle = opts.despeckle and m.speck_count > 0
    do_background = (
        opts.background
        and opts.background_strength > 0.0
        and m.paper_before < BACKGROUND_TRIGGER
    )
    rotate = 0
    if (
        opts.orientation
        and m.orientation is not None
        and m.orientation["confidence"] >= opts.osd_confidence
    ):
        rotate = int(m.orientation["rotate"]) % 360
    return do_deskew, do_despeckle, do_background, rotate


# --------------------------------------------------------------------------
# The pass
# --------------------------------------------------------------------------
def analyze_scan(
    file: str,
    pages="all",
    *,
    deskew: bool = True,
    despeckle: bool = True,
    background: bool = True,
    orientation: bool = True,
    max_skew_deg: float = DEFAULT_MAX_SKEW,
    min_skew_deg: float = DEFAULT_MIN_SKEW,
    speck_size_in: float = DEFAULT_SPECK_SIZE_IN,
    speck_gap_in: float = DEFAULT_SPECK_GAP_IN,
    background_strength: float = 1.0,
    osd_confidence: float = DEFAULT_OSD_CONFIDENCE,
    jpeg_quality: int = DEFAULT_JPEG_QUALITY,
    gs_path: str = "",
    tesseract_path: str = "",
) -> dict:
    """Measure every selected page and report; write nothing.

    The PREVIEW half of the pass, so the panel can state how many pages are
    scans, how far each is off square and how many specks it carries BEFORE
    anything is rewritten — an enhancement whose first evidence is the changed
    file is one the user cannot judge.
    """
    opts = _options(
        deskew=deskew,
        despeckle=despeckle,
        background=background,
        orientation=orientation,
        max_skew_deg=max_skew_deg,
        min_skew_deg=min_skew_deg,
        speck_size_in=speck_size_in,
        speck_gap_in=speck_gap_in,
        background_strength=background_strength,
        osd_confidence=osd_confidence,
        jpeg_quality=jpeg_quality,
    )
    rows: list[dict] = []
    scans = 0
    would_change = 0
    with pikepdf.open(file) as pdf:
        wanted = _selected(pages, len(pdf.pages))
        for number, page in enumerate(pdf.pages, start=1):
            if number not in wanted:
                continue
            candidate, reason = _classify_page(pdf, page, number)
            if candidate is None:
                rows.append({"page": number, "decision": DECISION_UNTOUCHED, "reason": reason})
                continue
            scans += 1
            measured = _measure(pdf, file, page, candidate, opts, gs_path, tesseract_path)
            row = _measurement_row(measured, opts)
            row["decision"] = DECISION_SCAN
            do_deskew, do_despeckle, do_background, rotate = _would_act(measured, opts)
            row["would_deskew"] = do_deskew
            row["would_despeckle"] = do_despeckle
            row["would_whiten"] = do_background
            row["would_rotate"] = rotate
            if do_deskew or do_despeckle or do_background or rotate:
                would_change += 1
            rows.append(row)
            del measured
    return {
        "file": str(file),
        "pages": rows,
        "pages_selected": len(rows),
        "pages_scanned": scans,
        "pages_would_change": would_change,
    }


def enhance_scan(
    file: str,
    output: str,
    pages="all",
    *,
    deskew: bool = True,
    despeckle: bool = True,
    background: bool = True,
    orientation: bool = True,
    max_skew_deg: float = DEFAULT_MAX_SKEW,
    min_skew_deg: float = DEFAULT_MIN_SKEW,
    speck_size_in: float = DEFAULT_SPECK_SIZE_IN,
    speck_gap_in: float = DEFAULT_SPECK_GAP_IN,
    background_strength: float = 1.0,
    osd_confidence: float = DEFAULT_OSD_CONFIDENCE,
    jpeg_quality: int = DEFAULT_JPEG_QUALITY,
    gs_path: str = "",
    tesseract_path: str = "",
) -> dict:
    """Deskew, despeckle, whiten and re-orient every selected scanned page.

    Only pages that ARE scans are touched, by `mrc._classify_page`'s definition
    — one upright image covering the page with nothing else drawn over it. A
    born-digital page refuses by name and keeps its bytes; a document with no
    scanned page at all refuses rather than writing an output that changed
    nothing.

    The raster arms are LOSSY surgery: the page image is decoded, corrected and
    re-encoded. Orientation is not — it writes the page's `/Rotate`.

    Signed documents: this is a content rewrite, which
    `engine/incremental.py`'s transplant does not cover, so there is no append
    path and none is invented. The panel routes through the ordinary
    snapshot → engine → reload flow, which is undoable as one step.
    """
    opts = _options(
        deskew=deskew,
        despeckle=despeckle,
        background=background,
        orientation=orientation,
        max_skew_deg=max_skew_deg,
        min_skew_deg=min_skew_deg,
        speck_size_in=speck_size_in,
        speck_gap_in=speck_gap_in,
        background_strength=background_strength,
        osd_confidence=osd_confidence,
        jpeg_quality=jpeg_quality,
    )
    info = validate_pdf(file)
    input_path = Path(file)
    output_path = Path(output)

    rows: list[dict] = []
    enhanced = 0
    unchanged = 0
    with pikepdf.open(file) as pdf:
        wanted = _selected(pages, len(pdf.pages))
        candidates: list[_Candidate] = []
        for number, page in enumerate(pdf.pages, start=1):
            if number not in wanted:
                continue
            candidate, reason = _classify_page(pdf, page, number)
            if candidate is None:
                rows.append({"page": number, "decision": DECISION_UNTOUCHED, "reason": reason})
            else:
                candidates.append(candidate)
        if not candidates:
            raise ValueError(
                "no selected page in this document is a scanned image — scan "
                "enhancement has nothing to work on"
            )

        for candidate in candidates:
            page = pdf.pages[candidate.page_number - 1]
            measured = _measure(pdf, file, page, candidate, opts, gs_path, tesseract_path)
            row = _measurement_row(measured, opts, with_filter=True)
            do_deskew, do_despeckle, do_background, rotate = _would_act(measured, opts)

            if not (do_deskew or do_despeckle or do_background or rotate):
                row["decision"] = DECISION_UNCHANGED
                rows.append(row)
                unchanged += 1
                del measured
                continue

            samples = measured.samples
            if do_despeckle and measured.speck_mask is not None and measured.paper is not None:
                # Painted with the LOCAL paper, never a constant white: a
                # constant leaves a bright fleck on a tinted or shadowed scan.
                samples = samples.copy()
                samples[measured.speck_mask] = measured.paper[measured.speck_mask]
            if do_background and measured.paper is not None:
                samples = whiten(samples, measured.paper, opts.background_strength)

            paper_keep = (
                ~measured.ink
                if measured.speck_mask is None
                else ~(measured.ink | measured.speck_mask)
            )
            row["paper_after"] = round(
                float(samples[paper_keep].mean()) if paper_keep.any() else float(samples.mean()), 2
            )

            enhanced_image = _to_image(samples)
            if do_deskew:
                # expand=False keeps the pixel dimensions, so the placement's
                # CTM stays exactly valid and the page geometry is untouched.
                fill = _paper_fill(measured, enhanced_image.mode)
                enhanced_image = enhanced_image.rotate(
                    -measured.skew_deg, resample=Image.BICUBIC, expand=False, fillcolor=fill
                )

            if do_deskew or do_despeckle or do_background:
                data, filt, colorspace = _encode(
                    enhanced_image, measured.source_filter, opts.jpeg_quality
                )
                obj = _image_xobject(pdf, data, enhanced_image, filt, colorspace)
                # The single-layer case of the MRC assembly primitive: the page
                # OBJECT survives, so /Annots, /AcroForm and its field tree,
                # /StructTreeRoot and the marked-content ids carry through with
                # nothing to reattach.
                replace_placement_with_layers(pdf, page, candidate.index, [obj])
                row["output_bytes"] = len(data)
                row["output_filter"] = filt
            if rotate:
                page.obj["/Rotate"] = (int(page.obj.get("/Rotate", 0)) + rotate) % 360

            row["decision"] = DECISION_ENHANCED
            row["deskew_applied"] = do_deskew
            row["despeckle_applied"] = do_despeckle
            row["background_applied"] = do_background
            row["rotate_applied"] = rotate
            rows.append(row)
            enhanced += 1
            del measured, samples, enhanced_image

        if enhanced == 0:
            # Every scanned page measured square, clean and white. Writing an
            # output anyway would re-encode rasters for no gain, so the file is
            # left alone and the report says why.
            rows.sort(key=lambda r: r["page"])
            return {
                "output": str(input_path),
                "written": False,
                "pages": rows,
                "pages_enhanced": 0,
                "pages_unchanged": unchanged,
                "pages_untouched": info["pages"] - unchanged,
            }
        _save(pdf, input_path, output_path)

    rows.sort(key=lambda r: r["page"])
    return {
        "output": str(output_path),
        "written": True,
        "pages": rows,
        "pages_enhanced": enhanced,
        "pages_unchanged": unchanged,
        "pages_untouched": info["pages"] - enhanced - unchanged,
    }


def _paper_fill(m: _Measured, mode: str):
    """The colour a deskew rotation exposes at the corners.

    The page's OWN median paper, not a constant white: filling a cream scan's
    corners with 255 draws four bright wedges the original never had.
    """
    if m.paper is not None:
        value = np.median(m.paper.reshape(-1, m.paper.shape[-1]), axis=0)
    else:
        keep = ~m.ink
        source = m.samples.reshape(-1, m.samples.shape[-1])
        value = (
            m.samples[keep].mean(axis=0) if keep.any() else source.mean(axis=0)
        )
    channels = [int(round(float(v))) for v in np.clip(value, 0, 255)]
    return channels[0] if mode == "L" else tuple(channels[:3])
