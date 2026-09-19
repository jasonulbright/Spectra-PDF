"""Destroy the PIXELS under a redaction region inside one placed image.

The redactor's original boundary was "whole `Tj`/`TJ`/`Do` kept or dropped as a
unit". For text that boundary is gone (a show operator is split, surviving
glyphs keep their positions). This module is the image half: a mark over a few
lines of a page that IS one scanned image must remove those lines' pixels, not
the page.

One placement (`Do`, or an inline image) is handled in four steps.

  1. GEOMETRY. The marks are mapped from page space into the image's unit
     square through the INVERSE of the placement CTM, and from there onto the
     pixel grid of every raster the image carries — the base samples, an
     /SMask, a stencil /Mask — each on its OWN grid, because they need not
     share a resolution. Pixel bounds round outward: a pixel the mark covers
     any positive area of is "touched". A rotated or skewed CTM makes a mark a
     parallelogram in image space; each pixel row's span is that
     parallelogram's exact extent across the row's band.
  2. PLAN. A mark covering the whole placed area removes the image (and its
     bytes) whole. A mark touching no pixel changes nothing. Otherwise every
     raster destroys its touched pixels — unless it is COARSER than the mark
     (every one of its pixels is touched while the image as a whole is only
     partly marked: the 1x1 colour image of an MRC foreground, a small SMask).
     A coarse raster keeps each pixel that straddles the mark's edge, because
     that pixel's value is on display outside the mark already, and destroys
     only the pixels that may lie wholly inside it. A kept straddler of a
     coarse BASE must still show somewhere outside the mark through the image's
     own (redacted) mask; one that no longer does is destroyed too, so a colour
     visible only under the mark does not outlive it.
  3. CODEC. The destroyed set is widened to every pixel whose DECODED value
     depends on it (`codec_taint`): whole JPEG blocks and the chroma
     upsampling reach for DCT; the wavelet filter reach for lossless JPEG 2000.
     A lossy JPEG 2000 image is rate-controlled, which ties every one of its
     pixels to the marked area, so it is removed whole and the result says why.
  4. REBUILD. The samples are decoded in the image's own colour space and bit
     depth, the destroyed pixels are overwritten, the samples re-encoded, and a
     NEW stream is built from a policy over the source dictionary's keys (the
     tables below): the keys that describe how to read the samples travel,
     every key that can carry a copy, a preview or a hash of the original is
     dropped. The caller registers the stream under a fresh name and rewrites
     only that occurrence, so other placements of the same XObject keep the
     original; identical plans share one copy.

What "destroyed" writes, per raster:
  - lossless base samples: one constant per colour space (black where the
    space has one), chosen through the /Decode array so it RENDERS as that;
  - DCT and JPEG 2000 base samples: per connected destroyed area, the mean of
    the untouched pixels on its outer ring — those pixels do not depend on the
    mark, so the fill carries nothing of it, and a widened margin reads as the
    surrounding picture instead of a dark halo around the box;
  - an /SMask or stencil /Mask: TRANSPARENT — the destroyed area paints
    nothing, as removed text or a cut path paints nothing, and never shows
    base pixels the mask was hiding;
  - a stencil drawn on its own: "paint nothing", never the unpredictable live
    fill colour.

Codecs: the qpdf-decodable filters (Flate, LZW, RunLength, ASCIIHex, ASCII85)
are edited as packed samples and re-encoded as Flate, every survivor exact.
CCITT is decoded through the imaging library and re-encoded as Flate. JBIG2 is
decoded by the user-supplied Ghostscript and re-encoded as CCITT group 4, the
exact bitmap proved by decoding it back; the symbol dictionary it shared
(/JBIG2Globals) can hold shapes from the destroyed area, so every other image
that used it is converted the same way by the caller. DCT is re-encoded with
the source's own quantization tables at 4:4:4, and its Adobe marker mirrors the
source's, because a viewer inverts CMYK samples on the marker's presence.
JPEG 2000 is read per ISO 32000-2 §7.4.9: without /ColorSpace, the colour
comes from the codestream. Any codec shape outside these refuses by name.

Every refusal is `refuse(reason)`: one sentence, one raise site, the reason its
only variable part. A font the redaction cannot cut (`redact_fonts`) refuses
through the same function, naming the font. A Ghostscript that is not usable
refuses through the capability authority (`gs_capability.require`), as at every
Ghostscript door. The source file is never touched, because the caller raises
before anything is saved.
"""

from __future__ import annotations

import io
import math
import struct
import tempfile
import zlib
from pathlib import Path
from typing import NamedTuple, NoReturn

import pikepdf
from pikepdf import Name

from engine import codec_taint
from engine import redact_geometry
from engine.content_walk import Matrix
from engine.pdf_tree import key_text, token_text


def refuse(reason: str, *, font: str | None = None) -> NoReturn:
    """The one redaction refusal: one sentence for an image whose pixels, and
    one for a font whose glyphs, cannot be rewritten safely."""
    if font is not None:
        raise ValueError(
            f"The redacted characters cannot be removed from the font {font} ({reason})."
        )
    raise ValueError(
        f"This image cannot be partly redacted ({reason})."
        " Mark the whole image to remove it."
    )


# ── limits and codec names ────────────────────────────────────────────────

# The largest decoded raster partial redaction will hold, in bytes: a legal
# page at 600 dpi in RGB (5100x8400x3), or a letter page at 1200 dpi as a
# bilevel raster held a byte per pixel. Peak memory runs to about twice this.
# A declared size beyond it refuses before anything is decoded, and a stream
# that decodes past it — whatever it declares — refuses as it crosses it.
MAX_DECODED_BYTES = 160_000_000

QPDF_FILTERS = frozenset(
    {
        "/FlateDecode",
        "/LZWDecode",
        "/RunLengthDecode",
        "/ASCIIHexDecode",
        "/ASCII85Decode",
        "/Fl",
        "/LZW",
        "/RL",
        "/AHx",
        "/A85",
    }
)
DCT_FILTERS = frozenset({"/DCTDecode", "/DCT"})
CCITT_FILTERS = frozenset({"/CCITTFaxDecode", "/CCF"})
JPX_FILTERS = frozenset({"/JPXDecode"})
JBIG2_FILTERS = frozenset({"/JBIG2Decode"})

# ── the key policy for a redacted image copy (ISO 32000-2 Table 87) ───────
#
# Kept: the keys that say how to read the samples or where the image belongs.
#   /Type /Subtype /Width /Height /ColorSpace /BitsPerComponent /Decode
#   /ImageMask /Intent /Interpolate — sample interpretation and rendering;
#   /Mask /SMask — rebuilt from redacted copies (a colour-key /Mask array is
#   kept as is: it holds ranges, not pixels);
#   /OC — optional-content membership, so the copy hides and shows with its
#   layer; /Measure — the viewport's coordinate system, not picture content;
#   /Name — a PDF 1.0 resource name; /StructParent — rebound by the caller to
#   the first copy, dropped from any later one; /SMaskInData — only while the
#   copy is still JPEG 2000.
# Dropped, each because it can hand back the original:
#   /Alternates — other versions of the same picture;
#   /OPI — a pointer to the unredacted high-resolution original;
#   /Metadata — XMP, which can carry xmp:Thumbnails, a preview of the whole
#   unredacted picture, and free-text descriptions of its content;
#   /AF — associated files, such as the source scan the image was made from;
#   /ID — a Web Capture digital identifier, a hash of the original content
#   that confirms a guess;
#   /PtData — point-cloud or geospatial data describing the pictured content;
#   and every key this table does not name — a private key can hold anything,
#   so an unknown key is dropped rather than trusted.
IMAGE_KEPT_KEYS = frozenset(
    {
        "/Type",
        "/Subtype",
        "/Width",
        "/Height",
        "/ColorSpace",
        "/BitsPerComponent",
        "/Decode",
        "/ImageMask",
        "/Intent",
        "/Interpolate",
        "/Mask",
        "/SMask",
        "/OC",
        "/Measure",
        "/Name",
        "/StructParent",
        "/SMaskInData",
    }
)

# Inline-image abbreviations, and the full key each one stands for. The rebuild
# always emits an XObject, where only the full names are defined.
_ABBREVIATIONS = {
    "/W": "/Width",
    "/H": "/Height",
    "/BPC": "/BitsPerComponent",
    "/CS": "/ColorSpace",
    "/IM": "/ImageMask",
    "/D": "/Decode",
    "/I": "/Interpolate",
    "/F": "/Filter",
    "/DP": "/DecodeParms",
}
_ABBREVIATED_VALUES = {
    "/G": "/DeviceGray",
    "/RGB": "/DeviceRGB",
    "/CMYK": "/DeviceCMYK",
    "/I": "/Indexed",
}

# A re-encoded JPEG flat block lands within this many levels of its fill.
_JPEG_TOLERANCE = 4

# Roles a raster can play, which decides what "destroyed" writes into it.
BASE = "base"
SMASK = "smask"
STENCIL_MASK = "mask"


# ── geometry ──────────────────────────────────────────────────────────────


def invert(m: Matrix):
    """The inverse of a placement CTM, or None when it has no area."""
    a, b, c, d, e, f = (float(v) for v in m)
    det = a * d - b * c
    if abs(det) < 1e-12:
        return None
    return (
        d / det,
        -b / det,
        -c / det,
        a / det,
        (c * f - d * e) / det,
        (b * e - a * f) / det,
    )


def _apply(m, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def _band_u_extent(poly, vlo: float, vhi: float):
    """The u-extent of a convex polygon over the horizontal band [vlo, vhi]."""
    us: list[float] = []
    count = len(poly)
    for index in range(count):
        u0, v0 = poly[index]
        u1, v1 = poly[(index + 1) % count]
        if vlo <= v0 <= vhi:
            us.append(u0)
        for edge in (vlo, vhi):
            if (v0 < edge) != (v1 < edge):
                us.append(u0 + (edge - v0) / (v1 - v0) * (u1 - u0))
    if not us:
        return None
    return min(us), max(us)


def _merge(intervals: list) -> list:
    out: list = []
    for lo, hi in sorted(intervals):
        if out and lo <= out[-1][1]:
            if hi > out[-1][1]:
                out[-1] = (out[-1][0], hi)
        else:
            out.append((lo, hi))
    return out


# Double-precision rounding: the most a single operation can be off by, as a
# fraction of its operands.
_EPS = 2.220446049250313e-16


def _snapper(tolerance: float):
    """Floor and ceil that treat an edge within `tolerance` pixels of a whole
    pixel as ON it. Floor and ceil are discontinuous exactly at the integers a
    mark drawn along a pixel boundary produces, so without this, rounding noise
    in the inverse mapping adds a whole pixel of fringe outside the region's
    own box. The tolerance is the rounding error the mapping itself can carry
    (see `coverage`), so the only slivers it can drop are thinner than
    floating point can place an edge — a bound, not a guess."""

    def snap(value: float) -> float:
        nearest = round(value)
        return float(nearest) if abs(value - nearest) <= tolerance else value

    return (lambda v: math.floor(snap(v))), (lambda v: math.ceil(snap(v)))


class Coverage(NamedTuple):
    width: int
    height: int
    touched: tuple  # ((row, col0, col1), ...): pixels the marks cover any area of
    every_pixel: bool  # every pixel is touched
    full: bool  # the marks cover the whole placed unit square
    singular: bool  # the placement has no area (or no pixels)


def coverage(ctm: Matrix, regions: list, width: int, height: int) -> Coverage:
    """Where the marks fall on one raster's pixel grid."""
    if width <= 0 or height <= 0:
        return Coverage(width, height, (), False, False, True)
    inverse = invert(ctm)
    if inverse is None:
        return Coverage(width, height, (), False, False, True)

    corners = [_apply(ctm, 0.0, 0.0), _apply(ctm, 1.0, 0.0), _apply(ctm, 1.0, 1.0), _apply(ctm, 0.0, 1.0)]
    full = redact_geometry.covered(corners, [tuple(r) for r in regions])

    rows: dict = {}
    for region in regions:
        x0, y0, x1, y1 = (float(v) for v in region)
        poly = [
            _apply(inverse, x0, y0),
            _apply(inverse, x1, y0),
            _apply(inverse, x1, y1),
            _apply(inverse, x0, y1),
        ]
        vs = [point[1] for point in poly]
        vmin, vmax = min(vs), max(vs)
        if vmax <= 0.0 or vmin >= 1.0:
            continue
        # The rounding error the mapping can carry into a pixel edge: a few
        # operations over operands of this magnitude, scaled to pixels.
        magnitude = (
            sum(abs(v) for v in inverse[:4]) * max(abs(x0), abs(x1), abs(y0), abs(y1), 1.0)
            + abs(inverse[4])
            + abs(inverse[5])
            + max(abs(p[0]) + abs(p[1]) for p in poly)
        )
        floor, ceil = _snapper(64.0 * _EPS * magnitude * max(width, height))
        # Image row 0 sits at v = 1: the top of the unit square.
        first = max(floor((1.0 - vmax) * height), 0)
        last = min(ceil((1.0 - vmin) * height), height)
        for row in range(first, last):
            extent = _band_u_extent(poly, 1.0 - (row + 1) / height, 1.0 - row / height)
            if extent is None:
                continue
            col0 = max(floor(extent[0] * width), 0)
            col1 = min(ceil(extent[1] * width), width)
            if col1 > col0:
                rows.setdefault(row, []).append((col0, col1))

    spans: list = []
    complete = 0
    for row in sorted(rows):
        merged = _merge(rows[row])
        if len(merged) == 1 and merged[0] == (0, width):
            complete += 1
        for lo, hi in merged:
            spans.append((row, lo, hi))
    return Coverage(width, height, tuple(spans), complete == height, full, False)


def pixel_spans(ctm: Matrix, regions: list, width: int, height: int):
    """The touched spans; () when no pixel is touched; None when the marks
    cover the whole placement or it has no area to map."""
    cov = coverage(ctm, regions, width, height)
    if cov.singular or cov.full:
        return None
    return cov.touched


def inside_spans(ctm: Matrix, regions: list, cov: Coverage) -> tuple:
    """Of the touched pixels, those that may lie WHOLLY inside the marks.

    A pixel with any point strictly outside every mark has a region of positive
    area on display outside them, so it is kept; this tests the four corners
    and the centre of each pixel's footprint and calls a pixel inside when all
    five fall inside some mark. A pixel reported inside that in fact had a
    sliver outside is destroyed — the over-removing side, never the other.
    """
    import numpy as np

    if not cov.touched:
        return ()
    a, b, c, d, e, f = (float(v) for v in ctm)
    rects = [tuple(float(v) for v in r) for r in regions]
    width, height = cov.width, cov.height
    out: list = []

    def inside_any(x, y):
        hit = np.zeros(x.shape, dtype=bool)
        for x0, y0, x1, y1 in rects:
            hit |= (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)
        return hit

    for row, col0, col1 in cov.touched:
        cols = np.arange(col0, col1, dtype=np.float64)
        u_left = cols / width
        u_right = (cols + 1.0) / width
        u_mid = (cols + 0.5) / width
        v_top = 1.0 - row / height
        v_bottom = 1.0 - (row + 1) / height
        v_mid = 1.0 - (row + 0.5) / height
        all_inside = np.ones(cols.shape, dtype=bool)
        for u, v in (
            (u_left, v_top),
            (u_right, v_top),
            (u_left, v_bottom),
            (u_right, v_bottom),
            (u_mid, v_mid),
        ):
            x = a * u + c * v + e
            y = b * u + d * v + f
            all_inside &= inside_any(x, y)
        start = None
        for index, flag in enumerate(all_inside.tolist()):
            if flag and start is None:
                start = index
            elif not flag and start is not None:
                out.append((row, col0 + start, col0 + index))
                start = None
        if start is not None:
            out.append((row, col0 + start, col1))
    return tuple(out)


def _span_count(spans) -> int:
    return sum(hi - lo for _row, lo, hi in spans)


def _union(*span_sets) -> tuple:
    rows: dict = {}
    for spans in span_sets:
        for row, lo, hi in spans:
            rows.setdefault(row, []).append((lo, hi))
    out: list = []
    for row in sorted(rows):
        for lo, hi in _merge(rows[row]):
            out.append((row, lo, hi))
    return tuple(out)


def _difference(spans, removed) -> tuple:
    taken = codec_taint.span_rows(removed)
    out: list = []
    for row, lo, hi in spans:
        pieces = [(lo, hi)]
        for rlo, rhi in taken.get(row, ()):
            next_pieces = []
            for plo, phi in pieces:
                if rhi <= plo or phi <= rlo:
                    next_pieces.append((plo, phi))
                    continue
                if plo < rlo:
                    next_pieces.append((plo, rlo))
                if rhi < phi:
                    next_pieces.append((rhi, phi))
            pieces = next_pieces
        out.extend((row, plo, phi) for plo, phi in pieces)
    return tuple(out)


# ── colour spaces ─────────────────────────────────────────────────────────


class _Space(NamedTuple):
    family: str  # gray | rgb | cmyk | lab | indexed | tint | mask
    ncomp: int
    palette: bytes = b""  # indexed only: the lookup table
    palette_comps: int = 0  # indexed only: components per palette entry
    lab_range: tuple = ()  # lab only: (amin, amax, bmin, bmax)
    darkest_tint: float = 1.0  # tint only: the tint that renders darkest
    base: object = None  # indexed only: the base space


_DEVICE_SPACES = {
    "/DeviceGray": ("gray", 1),
    "/G": ("gray", 1),
    "/CalGray": ("gray", 1),
    "/DeviceRGB": ("rgb", 3),
    "/RGB": ("rgb", 3),
    "/CalRGB": ("rgb", 3),
    "/DeviceCMYK": ("cmyk", 4),
    "/CMYK": ("cmyk", 4),
}
_ICC_FAMILIES = {1: "gray", 3: "rgb", 4: "cmyk"}


def _darkness(family: str, values) -> float:
    """How dark a colour renders, 0 (white) to 1, in its own space."""
    if family == "gray":
        return 1.0 - float(values[0])
    if family == "rgb":
        r, g, b = (float(v) for v in values[:3])
        return 1.0 - (0.2126 * r + 0.7152 * g + 0.0722 * b)
    if family == "cmyk":
        c, m, y, k = (float(v) for v in values[:4])
        return 1.0 - (1.0 - min(1.0, (c + m + y) / 3.0)) * (1.0 - k)
    return 0.0


def _tint_darkness(space, tint: float) -> float | None:
    """What a Separation's tint renders as, for the one tint transform whose
    value can be read without a function interpreter (FunctionType 2); None
    for the others."""
    try:
        entries = list(space)
        alternate = _space(entries[2], None)
        function = entries[3]
        if int(function.get("/FunctionType")) != 2:
            return None
        n = float(function.get("/N", 1.0))
        c0 = [float(v) for v in function.get("/C0", pikepdf.Array([0.0]))]
        c1 = [float(v) for v in function.get("/C1", pikepdf.Array([1.0]))]
        values = [a + (tint ** n) * (b - a) for a, b in zip(c0, c1)]
        return _darkness(alternate.family, values)
    except Exception:
        return None


def _space(cs, resolve, depth: int = 0) -> _Space:
    """The colour space as (family, component count), refusing what it cannot
    read. A component count guessed wrong would write the fill across the wrong
    samples — a visible corruption on a security operation."""
    if depth > 4 or cs is None:
        refuse("an unreadable colour space")
    if isinstance(cs, (pikepdf.Array, list)):
        entries = list(cs)
        if not entries:
            refuse("an unreadable colour space")
        head = _ABBREVIATED_VALUES.get(token_text(entries[0]), token_text(entries[0]))
        if head == "/Indexed":
            if len(entries) < 4:
                refuse("an unreadable colour space")
            base = _space(entries[1], resolve, depth + 1)
            if base.family == "indexed":
                refuse("an unreadable colour space")
            lookup = entries[3]
            try:
                table = (
                    bytes(lookup.read_bytes())
                    if isinstance(lookup, pikepdf.Stream)
                    else bytes(lookup)
                )
            except Exception:
                table = b""
            return _Space("indexed", 1, table, base.ncomp, base=base)
        if head == "/Separation":
            dark0 = _tint_darkness(cs, 0.0)
            dark1 = _tint_darkness(cs, 1.0)
            darkest = 0.0 if (dark0 is not None and dark1 is not None and dark0 > dark1) else 1.0
            return _Space("tint", 1, darkest_tint=darkest)
        if head == "/DeviceN":
            try:
                count = len(list(entries[1]))
            except (TypeError, ValueError):
                refuse("an unreadable colour space")
            if count < 1:
                refuse("an unreadable colour space")
            return _Space("tint", count)
        if head == "/ICCBased":
            stream = entries[1] if len(entries) > 1 else None
            try:
                n = int(stream.get("/N"))
            except Exception:
                refuse("an unreadable colour space")
            family = _ICC_FAMILIES.get(n)
            if family is None:
                refuse(f"an unsupported {n}-component ICC colour space")
            return _Space(family, n)
        if head == "/Lab":
            lab_range = (-100.0, 100.0, -100.0, 100.0)
            try:
                params = entries[1] if len(entries) > 1 else None
                given = params.get("/Range") if params is not None else None
                if given is not None:
                    values = [float(v) for v in given]
                    if len(values) == 4:
                        lab_range = (values[0], values[1], values[2], values[3])
            except Exception:
                pass
            return _Space("lab", 3, lab_range=lab_range)
        if head in _DEVICE_SPACES:
            family, ncomp = _DEVICE_SPACES[head]
            return _Space(family, ncomp)
        refuse(f"an unsupported colour space {head}")

    name = key_text(cs)
    if name in _DEVICE_SPACES:
        family, ncomp = _DEVICE_SPACES[name]
        return _Space(family, ncomp)
    if name == "/Pattern":
        refuse("a pattern colour space")
    resolved = resolve(name) if resolve is not None else None
    if resolved is None:
        refuse(f"an unsupported colour space {name}")
    return _space(resolved, resolve, depth + 1)


def _decode_pairs(obj, space: _Space, bpc: int, image_mask: bool, honour: bool = True) -> tuple:
    """`((dmin, dmax), …)` per component: the /Decode array, or the default
    for this colour space when it has none (or when it must be ignored — a
    JPEG 2000 image without /ColorSpace, ISO 32000-2 §7.4.9)."""
    maxv = (1 << bpc) - 1
    if image_mask:
        default = ((0.0, 1.0),)
    elif space.family == "indexed":
        default = ((0.0, float(maxv)),)
    elif space.family == "lab" and len(space.lab_range) == 4:
        amin, amax, bmin, bmax = space.lab_range
        default = ((0.0, 100.0), (amin, amax), (bmin, bmax))
    else:
        default = tuple((0.0, 1.0) for _ in range(space.ncomp))
    if not honour:
        return default
    try:
        given = obj.get("/Decode")
        if given is None:
            given = obj.get("/D")
    except Exception:
        given = None
    if given is None:
        return default
    try:
        values = [float(v) for v in given]
    except (TypeError, ValueError):
        return default
    if len(values) != 2 * len(default):
        return default
    return tuple((values[2 * i], values[2 * i + 1]) for i in range(len(default)))


def _darkest_index(space: _Space) -> int:
    """The palette index whose entry RENDERS darkest in the base space."""
    entries = space.palette_comps
    table = space.palette
    base = space.base
    if entries not in (1, 3, 4) or len(table) < entries or base is None:
        return 0
    best, best_dark = 0, -1.0
    for index in range(len(table) // entries):
        chunk = [v / 255.0 for v in table[index * entries : (index + 1) * entries]]
        if base.family == "tint":
            # Palette bytes are tints; the darkest is the tint closest to the
            # base's own darkest tint.
            dark = 1.0 - abs(chunk[0] - base.darkest_tint)
        elif base.family in ("gray", "rgb", "cmyk"):
            dark = _darkness(base.family, chunk)
        elif base.family == "lab":
            dark = 1.0 - chunk[0]
        else:
            dark = 0.0
        if dark > best_dark:
            best, best_dark = index, dark
    return best


def _targets(space: _Space, role: str, image_mask: bool, bpc: int) -> tuple:
    """What destroyed samples must RENDER as, in the space's own units."""
    if role == SMASK:
        return (0.0,)
    if image_mask:
        # A stencil paints where its rendered value is 0. Drawn on its own it
        # must paint nothing; used as /Mask it must mask the base out.
        return (1.0,)
    if space.family == "gray":
        return (0.0,)
    if space.family == "rgb":
        return (0.0, 0.0, 0.0)
    if space.family == "cmyk":
        return (0.0, 0.0, 0.0, 1.0)
    if space.family == "lab":
        return (0.0, 0.0, 0.0)
    if space.family == "indexed":
        return (float(min(_darkest_index(space), (1 << bpc) - 1)),)
    return tuple(space.darkest_tint for _ in range(space.ncomp))


def _stored(target: float, pair: tuple, maxv: int) -> int:
    dmin, dmax = pair
    if abs(dmax - dmin) < 1e-12:
        return 0
    value = (target - dmin) / (dmax - dmin) * maxv
    return max(0, min(maxv, int(round(value))))


def _colour_key_safe(fill: list, ranges, maxv: int) -> list:
    """A fill that colour-key masking would make transparent is moved out of
    the masked ranges; one component outside its range is enough."""
    try:
        bounds = [int(v) for v in ranges]
    except (TypeError, ValueError):
        return fill
    if len(bounds) != 2 * len(fill):
        return fill
    spans = [
        (min(bounds[2 * i], bounds[2 * i + 1]), max(bounds[2 * i], bounds[2 * i + 1]))
        for i in range(len(fill))
    ]
    if not all(lo <= fill[i] <= hi for i, (lo, hi) in enumerate(spans)):
        return fill
    for index, (lo, hi) in enumerate(spans):
        if hi < maxv:
            fill[index] = hi + 1
            return fill
        if lo > 0:
            fill[index] = lo - 1
            return fill
    refuse("a colour-key mask that would make every fill colour transparent")


# ── packed samples ────────────────────────────────────────────────────────


def stride(width: int, ncomp: int, bpc: int) -> int:
    """Bytes per sample row. The format pads every row to a byte boundary."""
    return (width * ncomp * bpc + 7) // 8


def fill_packed(buf: bytearray, spans, width: int, ncomp: int, bpc: int, fill) -> None:
    """Overwrite the spanned pixels of a packed sample buffer."""
    row_bytes = stride(width, ncomp, bpc)
    if bpc == 8:
        unit = bytes(min(max(int(v), 0), 255) for v in fill)
        for row, col0, col1 in spans:
            base = row * row_bytes + col0 * ncomp
            buf[base : base + (col1 - col0) * ncomp] = unit * (col1 - col0)
        return
    if bpc == 16:
        unit = b"".join(min(max(int(v), 0), 65535).to_bytes(2, "big") for v in fill)
        for row, col0, col1 in spans:
            base = row * row_bytes + col0 * ncomp * 2
            buf[base : base + (col1 - col0) * ncomp * 2] = unit * (col1 - col0)
        return
    per_byte = 8 // bpc
    mask = (1 << bpc) - 1
    for row, col0, col1 in spans:
        row_base = row * row_bytes
        index = col0 * ncomp
        for _col in range(col1 - col0):
            for comp in range(ncomp):
                position = row_base + index // per_byte
                shift = 8 - bpc * (index % per_byte + 1)
                buf[position] = (buf[position] & (0xFF ^ (mask << shift))) | (
                    (int(fill[comp]) & mask) << shift
                )
                index += 1


def read_packed(buf: bytes, width: int, ncomp: int, bpc: int, row: int, col: int) -> tuple:
    """One pixel's stored components — the read side of `fill_packed`."""
    row_bytes = stride(width, ncomp, bpc)
    if bpc == 8:
        base = row * row_bytes + col * ncomp
        return tuple(buf[base : base + ncomp])
    if bpc == 16:
        base = row * row_bytes + col * ncomp * 2
        return tuple(
            int.from_bytes(buf[base + 2 * i : base + 2 * i + 2], "big") for i in range(ncomp)
        )
    per_byte = 8 // bpc
    mask = (1 << bpc) - 1
    out = []
    index = col * ncomp
    for _comp in range(ncomp):
        position = row * row_bytes + index // per_byte
        shift = 8 - bpc * (index % per_byte + 1)
        out.append((buf[position] >> shift) & mask)
        index += 1
    return tuple(out)


# ── reading one raster ────────────────────────────────────────────────────


def _full_key(key: str) -> str:
    return _ABBREVIATIONS.get(key, key)


def _get(obj, key: str):
    """A dictionary entry by its full name or its inline abbreviation."""
    try:
        value = obj.get(key)
        if value is None:
            for short, full in _ABBREVIATIONS.items():
                if full == key:
                    value = obj.get(short)
                    break
        return value
    except Exception:
        return None


def dimensions(obj) -> tuple:
    """`(width, height)`, or `(0, 0)` when they cannot be read."""
    try:
        width = int(_get(obj, "/Width") or 0)
        height = int(_get(obj, "/Height") or 0)
    except (TypeError, ValueError):
        return 0, 0
    return max(width, 0), max(height, 0)


def _filter_names(obj) -> tuple:
    filt = _get(obj, "/Filter")
    if filt is None:
        return ()
    if isinstance(filt, (pikepdf.Array, list)):
        return tuple(_ABBREVIATED_FILTERS.get(token_text(f), token_text(f)) for f in filt)
    return (_ABBREVIATED_FILTERS.get(token_text(filt), token_text(filt)),)


_ABBREVIATED_FILTERS = {
    "/AHx": "/ASCIIHexDecode",
    "/A85": "/ASCII85Decode",
    "/LZW": "/LZWDecode",
    "/Fl": "/FlateDecode",
    "/RL": "/RunLengthDecode",
    "/CCF": "/CCITTFaxDecode",
    "/DCT": "/DCTDecode",
}


def _parms_for(obj, count: int):
    parms = _get(obj, "/DecodeParms")
    if parms is None:
        return None
    if isinstance(parms, (pikepdf.Array, list)):
        entries = list(parms)
        if not entries:
            return None
        return entries[count - 1] if 0 < count <= len(entries) else entries[-1]
    return parms


def _bounded_inflate(data: bytes, limit: int) -> bytes:
    decoder = zlib.decompressobj()
    out = bytearray()
    try:
        chunk = decoder.decompress(data, limit + 1)
        out += chunk
        while decoder.unconsumed_tail and len(out) <= limit:
            out += decoder.decompress(decoder.unconsumed_tail, limit + 1 - len(out))
    except zlib.error:
        refuse("undecodable compressed image data")
    if len(out) > limit:
        refuse("image data that decodes larger than partial redaction holds")
    return bytes(out)


def _peel(raw: bytes, filters: tuple) -> bytes:
    """Strip the simple filters wrapped around an image codec.

    `[/FlateDecode /DCTDecode]` is a real shape; the JPEG bytes are inside the
    Flate layer. Only the prefixes this can undo without guessing are accepted.
    """
    data = raw
    for name in filters[:-1]:
        if name == "/FlateDecode":
            data = _bounded_inflate(data, MAX_DECODED_BYTES)
        elif name == "/ASCIIHexDecode":
            import binascii

            body = bytes(data).split(b">")[0]
            body = bytes(ch for ch in body if not chr(ch).isspace())
            if len(body) % 2:
                body += b"0"
            try:
                data = binascii.unhexlify(body)
            except binascii.Error:
                refuse("undecodable hexadecimal image data")
        elif name == "/ASCII85Decode":
            import base64

            try:
                data = base64.a85decode(bytes(data), adobe=True, ignorechars=b" \t\r\n\f\v")
            except ValueError:
                refuse("undecodable ASCII85 image data")
        else:
            refuse(f"an unsupported filter chain ending at {filters[-1]}")
    return data


def _decoded_length_within(raw: bytes, filters: tuple, limit: int) -> None:
    """Refuse a stream whose decoded bytes run past `limit`, whatever size its
    dictionary declares — counted as it decodes, so a small stream that
    expands without bound is refused before it is ever held."""
    data = _peel(raw, filters) if len(filters) > 1 else raw
    last = filters[-1] if filters else ""
    if last == "/FlateDecode":
        decoder = zlib.decompressobj()
        total = 0
        pending = data
        try:
            while pending:
                chunk = decoder.decompress(pending, 1 << 20)
                total += len(chunk)
                if total > limit:
                    refuse("image data that decodes larger than partial redaction holds")
                pending = decoder.unconsumed_tail
        except zlib.error:
            refuse("undecodable compressed image data")
    elif last == "/RunLengthDecode":
        total = 0
        index = 0
        size = len(data)
        while index < size:
            length = data[index]
            if length == 128:
                break
            if length < 128:
                total += length + 1
                index += length + 2
            else:
                total += 257 - length
                index += 2
            if total > limit:
                refuse("image data that decodes larger than partial redaction holds")
    elif last == "/LZWDecode":
        # Each 9- to 12-bit code expands to at most the longest dictionary
        # entry, 4096 bytes: a stream this short cannot exceed the limit.
        if len(data) * 8 // 9 * 4096 > limit:
            total = _lzw_length(data, limit)
            if total > limit:
                refuse("image data that decodes larger than partial redaction holds")


def _lzw_length(data: bytes, limit: int) -> int:
    """The decoded length of a PDF LZW stream (EarlyChange 1), counted up to
    `limit` without building the output."""
    lengths = [1] * 256 + [0, 0]
    width = 9
    bits = 0
    held = 0
    total = 0
    previous = -1
    for byte in data:
        held = (held << 8) | byte
        bits += 8
        while bits >= width:
            bits -= width
            code = (held >> bits) & ((1 << width) - 1)
            if code == 256:
                lengths = lengths[:258]
                width = 9
                previous = -1
                continue
            if code == 257:
                return total
            if code < len(lengths):
                size = lengths[code]
            elif previous >= 0:
                size = lengths[previous] + 1
            else:
                return total
            total += size
            if total > limit:
                return total
            if previous >= 0 and len(lengths) < 4096:
                lengths.append(lengths[previous] + 1)
                if len(lengths) + 1 >= (1 << width) and width < 12:
                    width += 1
            previous = code
    return total


class _Raster(NamedTuple):
    obj: object  # the authoritative dictionary: read for analysis, copied on rebuild
    source: object  # a Stream whose filter chain can be applied
    width: int
    height: int
    bpc: int
    image_mask: bool
    space: _Space
    filters: tuple
    parms: object
    raw: bytes
    honour_decode: bool


def _load(obj, resolve, role: str, source=None, raw: bytes | None = None) -> _Raster:
    width, height = dimensions(obj)
    if width <= 0 or height <= 0:
        refuse("unreadable dimensions")
    filters = _filter_names(obj)
    last = filters[-1] if filters else ""
    image_mask = bool(_get(obj, "/ImageMask"))
    cs = _get(obj, "/ColorSpace")
    honour = True
    if raw is None:
        try:
            raw = bytes(source.read_raw_bytes())
        except Exception:
            refuse("unreadable image data")

    if image_mask:
        space = _Space("mask", 1)
        bpc = 1
    elif last in JPX_FILTERS and cs is None:
        # ISO 32000-2 §7.4.9: without /ColorSpace the codestream's own colour
        # specification governs and /Decode is ignored; the fallback is Gray,
        # RGB or CMYK by the number of ordinary channels.
        space = _jpx_space(_peel(raw, filters))
        bpc = 8
        honour = False
    else:
        if cs is None and role == SMASK:
            space = _Space("gray", 1)
        else:
            space = _space(cs, resolve)
        try:
            bpc = int(_get(obj, "/BitsPerComponent") or 0)
        except (TypeError, ValueError):
            bpc = 0
        if last in JPX_FILTERS and bpc == 0:
            bpc = 8
        if bpc not in (1, 2, 4, 8, 16):
            refuse(f"an unsupported {bpc or 'unstated'}-bit sample depth")
    return _Raster(
        obj, source, width, height, bpc, image_mask, space, filters,
        _parms_for(obj, len(filters)), raw, honour,
    )


def _jpx_space(data: bytes) -> _Space:
    try:
        codestream, colour = codec_taint.jpx_split(data)
    except codec_taint.TaintError as exc:
        refuse(f"unreadable JPEG 2000 data: {exc}")
    if colour.palette:
        refuse("a JPEG 2000 palette image")
    if colour.method == 1:
        mapping = {16: ("rgb", 3), 17: ("gray", 1), 18: ("rgb", 3), 12: ("cmyk", 4)}
        if colour.enumerated in mapping:
            family, ncomp = mapping[colour.enumerated]
            return _Space(family, ncomp)
    if colour.method in (2, 3) and len(colour.icc) >= 20:
        signature = colour.icc[16:20]
        mapping = {b"GRAY": ("gray", 1), b"RGB ": ("rgb", 3), b"CMYK": ("cmyk", 4)}
        if signature in mapping:
            family, ncomp = mapping[signature]
            return _Space(family, ncomp)
    try:
        count = struct.unpack(">H", codestream[codestream.index(b"\xff\x51") + 40 : codestream.index(b"\xff\x51") + 42])[0]
    except (ValueError, struct.error):
        refuse("unreadable JPEG 2000 data")
    fallback = {1: ("gray", 1), 3: ("rgb", 3), 4: ("cmyk", 4)}
    if count not in fallback:
        refuse(f"a {count}-channel JPEG 2000 image")
    family, ncomp = fallback[count]
    return _Space(family, ncomp)


def _check_size(width: int, height: int, bytes_per_row: int) -> None:
    if bytes_per_row * height > MAX_DECODED_BYTES:
        refuse(f"an image of {width}x{height} pixels, more than partial redaction decodes")


def _fill_samples(raster: _Raster, role: str) -> list:
    """The stored sample tuple destroyed pixels are written with."""
    maxv = (1 << raster.bpc) - 1
    pairs = _decode_pairs(raster.obj, raster.space, raster.bpc, raster.image_mask, raster.honour_decode)
    targets = _targets(raster.space, role, raster.image_mask, raster.bpc)
    fill = [
        _stored(targets[i], pairs[i] if i < len(pairs) else (0.0, 1.0), maxv)
        for i in range(len(targets))
    ]
    if role == BASE and not raster.image_mask:
        ranges = _get(raster.obj, "/Mask")
        if isinstance(ranges, (pikepdf.Array, list)):
            fill = _colour_key_safe(fill, list(ranges), maxv)
    return fill


# ── per-codec sample access ───────────────────────────────────────────────


def _packed_samples(raster: _Raster) -> bytearray:
    needed = stride(raster.width, raster.space.ncomp, raster.bpc) * raster.height
    _check_size(raster.width, raster.height, stride(raster.width, raster.space.ncomp, raster.bpc))
    if raster.filters:
        _decoded_length_within(raster.raw, raster.filters, MAX_DECODED_BYTES)
        try:
            data = raster.source.read_bytes(decode_level=pikepdf.StreamDecodeLevel.specialized)
        except Exception:
            refuse("unreadable image data")
    else:
        data = raster.raw
    if len(data) < needed:
        refuse("image data shorter than its declared size")
    buf = bytearray(data[:needed])
    del data
    return buf


def _ccitt_samples(raster: _Raster) -> bytearray:
    """Packed 1-bit STORED samples of a CCITT raster.

    Decoded through a throwaway grey view of the same bytes: a stencil has no
    colour space and the imaging bridge refuses an /ImageMask outright.
    `apply_decode_array=False` keeps the samples as the file stores them, so
    the original /Decode travels unchanged.
    """
    _check_size(raster.width, raster.height, raster.width)
    parms = raster.parms
    columns = 1728
    try:
        if parms is not None and parms.get("/Columns") is not None:
            columns = int(parms.get("/Columns"))
    except (TypeError, ValueError):
        refuse("undecodable CCITT data")
    if columns != raster.width:
        # ISO 32000-2 Table 11: an absent /Columns means 1728. A stream whose
        # rows are not the image's width decodes differently in every reader;
        # there is no survivor pixel to keep that all of them agree on.
        refuse("CCITT data whose row length contradicts the image width")
    scratch = pikepdf.new()
    view = scratch.make_stream(_peel(raster.raw, raster.filters))
    view["/Type"] = Name("/XObject")
    view["/Subtype"] = Name("/Image")
    view["/Width"] = raster.width
    view["/Height"] = raster.height
    view["/ColorSpace"] = Name("/DeviceGray")
    view["/BitsPerComponent"] = 1
    view["/Filter"] = Name("/CCITTFaxDecode")
    if parms is not None:
        try:
            copied = pikepdf.Dictionary()
            for key in parms.keys():
                copied[key] = parms[key]
            view["/DecodeParms"] = copied
        except Exception:
            refuse("undecodable CCITT data")
    try:
        image = pikepdf.PdfImage(view).as_pil_image(apply_decode_array=False, apply_mask=False)
    except Exception:
        refuse("undecodable CCITT data")
    with image:
        if image.mode != "1" or image.size != (raster.width, raster.height):
            refuse("undecodable CCITT data")
        # The imaging library packs "1" rows to whole bytes exactly as the
        # format does, and a set bit is 255, so the bytes ARE the stored samples.
        packed = bytearray(image.tobytes())
    needed = stride(raster.width, 1, 1) * raster.height
    if len(packed) < needed:
        refuse("undecodable CCITT data")
    return packed[:needed]


def encode_g4(bits: bytes, width: int, height: int) -> tuple:
    """`(data, /DecodeParms)` for packed 1-bit STORED samples as CCITT group 4,
    proved by decoding the result back and comparing every bit.

    The imaging library writes photometric 1 for a bilevel TIFF, and the
    measured pairing for that is a CCITT decode (BlackIs1 false) that yields
    the COMPLEMENT of the bitmap it was given — so the complement goes in.
    The round trip below is what makes that pairing a checked fact here
    rather than an assumption: a codec that answered differently refuses.
    """
    from PIL import Image
    from PIL.TiffImagePlugin import ROWSPERSTRIP

    complement = bytes((~v) & 0xFF for v in bits)
    bitmap = Image.frombytes("1", (width, height), complement)
    buffer = io.BytesIO()
    bitmap.save(buffer, format="TIFF", compression="group4", tiffinfo={ROWSPERSTRIP: height})
    tif = Image.open(io.BytesIO(buffer.getvalue()))
    offsets, counts = tif.tag_v2[273], tif.tag_v2[279]
    if len(offsets) != 1:
        refuse("a bilevel image that could not be re-encoded exactly")
    if int(tif.tag_v2[262]) != 1:
        refuse("a bilevel image that could not be re-encoded exactly")
    buffer.seek(offsets[0])
    data = buffer.read(counts[0])
    parms = {"/K": -1, "/Columns": width, "/Rows": height, "/BlackIs1": False}
    probe = _Raster(
        pikepdf.Dictionary(Width=width, Height=height),
        None, width, height, 1, False, _Space("gray", 1),
        ("/CCITTFaxDecode",), pikepdf.Dictionary({k: v for k, v in parms.items()}), data, True,
    )
    if bytes(_ccitt_samples(probe)) != bytes(bits):
        refuse("a bilevel image that could not be re-encoded exactly")
    return data, parms


class Context:
    """What one redaction run shares across images: the Ghostscript it may
    need, the copies it has built (so identical plans share one), and the
    JBIG2 symbol dictionaries a redacted image used."""

    def __init__(self, pdf, gs_path: str = ""):
        self.pdf = pdf
        self.gs_path = gs_path
        self._gs = None
        self.copies: dict = {}
        self.jbig2_globals: set = set()
        self.modified: set = set()
        self.removed: set = set()
        self.widened: set = set()
        self.removed_for_codec: set = set()
        self.first_copy: dict = {}  # source objgen -> the first copy made from it
        self.replaced: dict = {}  # source objgen -> [copies]

    def ghostscript(self) -> str:
        if self._gs is None:
            from engine import gs_capability

            self._gs = gs_capability.require(self.gs_path).path
        return self._gs


def _require_bilevel(raster: _Raster) -> None:
    """JBIG2 codes one bit per pixel (ISO 32000-2 §7.4.7); a dictionary that
    says otherwise cannot be read back the way a reader would draw it."""
    if raster.bpc != 1 or raster.space.ncomp != 1:
        refuse("JBIG2 data under an image that is not one bit per pixel")


def jbig2_source(obj) -> tuple:
    """`(obj, JBIG2 bytes, /DecodeParms)` for an image whose filter chain ends
    in /JBIG2Decode, with any simple filters in front of it undone."""
    filters = _filter_names(obj)
    if not filters or filters[-1] not in JBIG2_FILTERS:
        refuse("an unsupported filter chain ending at /JBIG2Decode")
    try:
        raw = bytes(obj.read_raw_bytes())
    except Exception:
        refuse("unreadable image data")
    return obj, _peel(raw, filters), _parms_for(obj, len(filters))


def jbig2_bits(streams: list, context: Context) -> list:
    """Packed 1-bit STORED samples of JBIG2 images, decoded by Ghostscript.

    Each image is drawn on its own page at one point per pixel and rendered at
    72 dpi, so each sample lands on exactly one device pixel. The view is a
    plain DeviceGray image with no /Decode and no stencil flag, so the grey
    written is the stored bit itself: 0 is black, 1 is white.

    The decoder draws what it could decode and exits cleanly on a stream it
    could not read in full — a truncated one draws a partial page and says
    nothing, an unreadable one draws a blank page — so the stream's structure
    is checked first (`codec_taint.jbig2_check`) and any diagnostic the
    decoder prints refuses as well.
    """
    from PIL import Image

    from engine import budget

    if not streams:
        return []
    for obj, data, parms in streams:
        width, height = dimensions(obj)
        globals_stream = parms.get("/JBIG2Globals") if isinstance(parms, pikepdf.Dictionary) else None
        try:
            shared = bytes(globals_stream.read_bytes()) if isinstance(globals_stream, pikepdf.Stream) else None
        except Exception:
            refuse("an unreadable shared JBIG2 dictionary")
        try:
            codec_taint.jbig2_check(data, shared, width, height)
        except codec_taint.TaintError as exc:
            refuse(f"unreadable JBIG2 data: {exc}")
    gs = context.ghostscript()
    scratch = pikepdf.new()
    for obj, data, parms in streams:
        width, height = dimensions(obj)
        _check_size(width, height, width)
        page = scratch.add_blank_page(page_size=(width, height))
        view = scratch.make_stream(data)
        view["/Type"] = Name("/XObject")
        view["/Subtype"] = Name("/Image")
        view["/Width"] = width
        view["/Height"] = height
        view["/ColorSpace"] = Name("/DeviceGray")
        view["/BitsPerComponent"] = 1
        view["/Filter"] = Name("/JBIG2Decode")
        if isinstance(parms, pikepdf.Dictionary):
            globals_stream = parms.get("/JBIG2Globals")
            if isinstance(globals_stream, pikepdf.Stream):
                copied = scratch.make_stream(bytes(globals_stream.read_bytes()))
                view["/DecodeParms"] = pikepdf.Dictionary(JBIG2Globals=copied)
        page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=view))
        page.Contents = scratch.make_stream(f"q {width} 0 0 {height} 0 0 cm /Im0 Do Q".encode("ascii"))
    results: list = []
    with tempfile.TemporaryDirectory(prefix="spectrapdf_redact_jbig2_") as work:
        folder = Path(work)
        source = folder / "views.pdf"
        scratch.save(source)
        scratch.close()
        outcome = budget.gs(
            [
                gs, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dInterpolateControl=0",
                "-sDEVICE=pnggray", "-r72", f"-sOutputFile={folder / 'p%d.png'}", str(source),
            ],
            what="Ghostscript (JBIG2 decode for redaction)",
            path=source,
            pages=len(streams),
            base=60.0,
            per_mb=30.0,
            per_page=2.0,
            text=False,
        )
        # The embedded decoder prefixes every warning and error it reports
        # with its own name; the exit status stays 0 for both.
        said = bytes(outcome.stdout or b"") + bytes(outcome.stderr or b"")
        if outcome.returncode != 0 or b"jbig2dec" in said:
            refuse("JBIG2 data Ghostscript did not decode cleanly")
        for index, (obj, _data, _parms) in enumerate(streams, start=1):
            width, height = dimensions(obj)
            png = folder / f"p{index}.png"
            if not png.is_file():
                refuse("JBIG2 data Ghostscript could not decode")
            with Image.open(png) as rendered:
                if rendered.size != (width, height):
                    refuse("JBIG2 data Ghostscript could not decode")
                bits = rendered.convert("L").point(lambda v: 255 if v >= 128 else 0).convert("1")
                results.append(bytearray(bits.tobytes()))
    return results


# ── lossy codecs: widening and the ring fill ──────────────────────────────


def _labels(spans, width: int, height: int):
    """Connected components of a span set, as lists of spans (4-connected)."""
    rows = codec_taint.span_rows(spans)
    parent: dict = {}

    def find(key):
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    keys = []
    for row in sorted(rows):
        for interval in rows[row]:
            key = (row, interval[0], interval[1])
            parent[key] = key
            keys.append(key)
            for lo, hi in rows.get(row - 1, ()):
                if lo < interval[1] and interval[0] < hi:
                    union(key, (row - 1, lo, hi))
    groups: dict = {}
    for key in keys:
        groups.setdefault(find(key), []).append(key)
    return list(groups.values())


def _ring_fill(array, spans, fallback):
    """Fill each connected destroyed area with the mean of the untouched pixels
    on its outer ring (8-neighbourhood). Those pixels are outside the widened
    set, so they do not depend on the destroyed ones."""
    import numpy as np

    height, width = array.shape[0], array.shape[1]
    destroyed = np.zeros((height, width), dtype=bool)
    for row, lo, hi in spans:
        destroyed[row, lo:hi] = True
    fills: list = []
    for component in _labels(spans, width, height):
        rows = [row for row, _lo, _hi in component]
        y0, y1 = max(min(rows) - 1, 0), min(max(rows) + 2, height)
        x0 = max(min(lo for _r, lo, _h in component) - 1, 0)
        x1 = min(max(hi for _r, _l, hi in component) + 1, width)
        local = np.zeros((y1 - y0, x1 - x0), dtype=bool)
        for row, lo, hi in component:
            local[row - y0, lo - x0 : hi - x0] = True
        grown = local.copy()
        grown[1:, :] |= local[:-1, :]
        grown[:-1, :] |= local[1:, :]
        grown[:, 1:] |= local[:, :-1]
        grown[:, :-1] |= local[:, 1:]
        grown[1:, 1:] |= local[:-1, :-1]
        grown[:-1, :-1] |= local[1:, 1:]
        grown[1:, :-1] |= local[:-1, 1:]
        grown[:-1, 1:] |= local[1:, :-1]
        ring = grown & ~destroyed[y0:y1, x0:x1]
        window = array[y0:y1, x0:x1]
        if ring.any():
            value = window[ring].reshape(-1, array.shape[2]).mean(axis=0)
            value = np.rint(value).astype(array.dtype)
        else:
            value = np.array(fallback, dtype=array.dtype)
        for row, lo, hi in component:
            array[row, lo:hi] = value
        fills.append((component, tuple(int(v) for v in value)))
    return fills


def _strip_app14(data: bytes) -> bytes:
    """The JPEG with its Adobe APP14 segment removed."""
    try:
        layout = codec_taint.jpeg_layout(data)
    except codec_taint.TaintError:
        return data
    if not layout.adobe_segment:
        return data
    index = data.find(layout.adobe_segment)
    if index < 0:
        return data
    return data[:index] + data[index + len(layout.adobe_segment) :]


def _dct_rewrite(raster: _Raster, destroy, role: str, fill) -> tuple:
    """`(data, destroyed spans)` for a DCT raster."""
    import numpy as np
    from PIL import Image

    source = _peel(raster.raw, raster.filters)
    try:
        layout = codec_taint.jpeg_layout(source)
    except codec_taint.TaintError as exc:
        refuse(f"unreadable JPEG data: {exc}")
    if layout.precision != 8:
        refuse(f"a {layout.precision}-bit JPEG")
    if (layout.width, layout.height) != (raster.width, raster.height):
        refuse("a JPEG whose size contradicts the image dictionary")
    if len(layout.components) != raster.space.ncomp:
        refuse("a JPEG whose channel count contradicts its colour space")
    _check_size(raster.width, raster.height, raster.width * max(len(layout.components), 1))
    try:
        widened = codec_taint.jpeg_taint(layout, destroy, raster.width, raster.height)
    except codec_taint.TaintError as exc:
        refuse(f"a JPEG the dependency model cannot read: {exc}")
    try:
        image = Image.open(io.BytesIO(source))
        image.load()
    except Exception:
        refuse("undecodable JPEG data")
    with image:
        if image.mode not in ("L", "RGB", "CMYK"):
            refuse(f"an unsupported JPEG colour mode {image.mode}")
        qtables = getattr(image, "quantization", None)
        # Read-only and backed by the decoder's bytes; the writable copy is
        # taken once the decoder's own raster is released.
        decoded = np.asarray(image)
    array = decoded.copy()
    del decoded
    if array.ndim == 2:
        array = array[:, :, None]
    if role == BASE and not raster.image_mask:
        fills = _ring_fill(array, widened, fill)
    else:
        # The imaging library reads every CMYK JPEG as inverted, so a mask's
        # constant is written through the same inversion.
        constant = tuple((255 - v) if array.shape[2] == 4 else v for v in fill)
        for row, lo, hi in widened:
            array[row, lo:hi] = constant
        fills = [(list(widened), constant)]
    mode = {1: "L", 3: "RGB", 4: "CMYK"}[array.shape[2]]
    out_image = Image.fromarray(array[:, :, 0] if array.shape[2] == 1 else array, mode)
    buffer = io.BytesIO()
    options = {"format": "JPEG", "subsampling": 0, "progressive": False, "optimize": False}
    if qtables:
        options["qtables"] = [list(table) for _k, table in sorted(qtables.items())]
    else:
        options["quality"] = 95
    try:
        out_image.save(buffer, **options)
    except Exception:
        refuse("a JPEG that could not be re-encoded")
    out_image.close()
    del out_image, array
    data = buffer.getvalue()
    if mode == "CMYK" and not layout.adobe:
        data = _strip_app14(data)
    _verify_dct(data, fills, raster, qtables)
    return data, widened


def _verify_dct(data: bytes, fills, raster: _Raster, qtables) -> None:
    """Decode the re-encoded JPEG and require every destroyed pixel to hold its
    fill. A lossy codec is the one path where what was written and what a
    reader gets back are different questions; an unproven rewrite refuses."""
    from PIL import Image

    tolerance = _JPEG_TOLERANCE
    if qtables:
        # A flat block's DC lands within step/16 of its value in each coded
        # component, and the YCbCr-to-RGB transform adds up to 1.772 times the
        # chroma component's error to one channel.
        steps = [list(t)[0] for _k, t in sorted(qtables.items()) if list(t)]
        if steps:
            if len(steps) > 1 and raster.space.ncomp == 3:
                bound = (steps[0] + 1.772 * max(steps[1:])) / 16.0
            else:
                bound = max(steps) / 16.0
            tolerance = max(tolerance, int(math.ceil(bound)) + 2)
    try:
        check = Image.open(io.BytesIO(data))
        check.load()
    except Exception:
        refuse("a JPEG that could not be re-encoded")
    with check:
        if check.size != (raster.width, raster.height):
            refuse("a JPEG that could not be re-encoded")
        for component, value in fills:
            for row, lo, hi in component:
                for col in (lo, (lo + hi) // 2, hi - 1):
                    got = check.getpixel((col, row))
                    values = got if isinstance(got, tuple) else (got,)
                    for index, sample in enumerate(values):
                        if abs(int(sample) - int(value[index])) > tolerance:
                            refuse("a JPEG whose redacted area could not be proven")


def _jpx_rewrite(raster: _Raster, destroy, role: str, fill):
    """`(data, destroyed spans, colour space to declare)` for a JPEG 2000
    raster, or None when the codestream is lossy (every pixel depends on the
    mark; the caller removes the image whole)."""
    import numpy as np
    from PIL import Image

    source = _peel(raster.raw, raster.filters)
    try:
        layout = codec_taint.jpx_layout(source)
    except codec_taint.TaintError as exc:
        refuse(f"a JPEG 2000 image the dependency model cannot read: {exc}")
    if (layout.width, layout.height) != (raster.width, raster.height):
        refuse("a JPEG 2000 image whose size contradicts the image dictionary")
    if any(precision > 8 for precision, *_ in layout.components):
        refuse("a JPEG 2000 image with more than 8 bits per sample")
    if layout.colour.palette:
        refuse("a JPEG 2000 palette image")
    _check_size(raster.width, raster.height, raster.width * max(len(layout.components), 1))
    widened = codec_taint.jpx_taint(layout, destroy, raster.width, raster.height)
    if widened is None:
        return None
    try:
        image = Image.open(io.BytesIO(source))
        image.load()
    except Exception:
        refuse("undecodable JPEG 2000 data")
    with image:
        mode = image.mode
        if mode not in ("L", "LA", "RGB", "RGBA"):
            refuse(f"an unsupported JPEG 2000 colour mode {mode}")
        decoded = np.asarray(image)
    if decoded.ndim == 2:
        decoded = decoded[:, :, None]
    colour_bands = 1 if mode in ("L", "LA") else 3
    colour = decoded[:, :, :colour_bands].copy()
    alpha = decoded[:, :, colour_bands].copy() if decoded.shape[2] > colour_bands else None
    del decoded
    if role == BASE and not raster.image_mask:
        _ring_fill(colour, widened, fill)
    else:
        for row, lo, hi in widened:
            colour[row, lo:hi] = fill[:colour_bands]
    out_mode = "L" if colour_bands == 1 else "RGB"
    out = Image.fromarray(colour[:, :, 0] if colour_bands == 1 else colour, out_mode)
    style = next(iter(layout.styles.values()))
    options = {
        "format": "JPEG2000",
        "irreversible": False,
        "num_resolutions": style.levels + 1,
        "codeblock_size": (1 << style.xcb, 1 << style.ycb),
        "no_jp2": layout.colour.method == 0,
    }
    if layout.tile_w < raster.width or layout.tile_h < raster.height:
        options["tile_size"] = (layout.tile_w, layout.tile_h)
    if colour_bands == 3:
        # The reversible colour transform (T.800 G.2) is lossless too. Without
        # it the three components are coded apart, and a background coded
        # with it grows several times over.
        options["mct"] = 1
    buffer = io.BytesIO()
    try:
        out.save(buffer, **options)
    except Exception:
        refuse("a JPEG 2000 image that could not be re-encoded")
    out.close()
    del out
    data = buffer.getvalue()
    try:
        check = np.asarray(Image.open(io.BytesIO(data)))
    except Exception:
        refuse("a JPEG 2000 image that could not be re-encoded")
    expected = colour[:, :, 0] if colour_bands == 1 else colour
    if check.shape != expected.shape or not np.array_equal(check, expected):
        refuse("a JPEG 2000 image that could not be re-encoded exactly")
    declared = None
    if _get(raster.obj, "/ColorSpace") is None and layout.colour.method in (2, 3):
        declared = ("icc", layout.colour.icc, colour_bands)
    return data, widened, declared, alpha


# ── building the copy ─────────────────────────────────────────────────────


def _rebuild(pdf, obj, data: bytes, filter_name: str | None, parms=None):
    """A new image stream built from the key policy over `obj`."""
    stream = pdf.make_stream(data)
    for key in obj.keys():
        full = _full_key(str(key))
        if full not in IMAGE_KEPT_KEYS:
            continue
        value = obj[key]
        if full == "/ColorSpace" and isinstance(value, pikepdf.Name):
            abbreviated = _ABBREVIATED_VALUES.get(token_text(value))
            if abbreviated is not None:
                value = Name(abbreviated)
        if full == "/ColorSpace" and isinstance(value, pikepdf.Array) and len(value):
            head = str(value[0])
            if head in _ABBREVIATED_VALUES:
                value = pikepdf.Array([Name(_ABBREVIATED_VALUES[head])] + list(value)[1:])
        stream[full] = value
    stream["/Type"] = Name("/XObject")
    stream["/Subtype"] = Name("/Image")
    if filter_name is not None:
        stream["/Filter"] = Name(filter_name)
    if parms:
        stream["/DecodeParms"] = pikepdf.Dictionary(parms)
    return stream


class _LayerResult(NamedTuple):
    stream: object  # the rewritten stream, or None when nothing was destroyed
    destroyed: tuple  # the spans actually destroyed (after any widening)
    widened: bool
    lossy_jpx: bool


def _rewrite_layer(pdf, obj, role: str, destroy, context: Context, resolve, source=None, raw=None) -> _LayerResult:
    """Destroy `destroy` in one raster and rebuild it."""
    if not destroy:
        return _LayerResult(None, (), False, False)
    raster = _load(obj, resolve, role, source=source if source is not None else obj, raw=raw)
    last = raster.filters[-1] if raster.filters else ""
    fill = _fill_samples(raster, role)

    if not raster.filters or last in QPDF_FILTERS:
        samples = _packed_samples(raster)
        fill_packed(samples, destroy, raster.width, raster.space.ncomp, raster.bpc, fill)
        return _LayerResult(_rebuild(pdf, obj, zlib.compress(samples, 6), "/FlateDecode"), destroy, False, False)

    if last in CCITT_FILTERS:
        samples = _ccitt_samples(raster)
        fill_packed(samples, destroy, raster.width, 1, 1, fill)
        return _LayerResult(_rebuild(pdf, obj, zlib.compress(samples, 6), "/FlateDecode"), destroy, False, False)

    if last in JBIG2_FILTERS:
        _require_bilevel(raster)
        parms = raster.parms
        globals_stream = parms.get("/JBIG2Globals") if isinstance(parms, pikepdf.Dictionary) else None
        samples = jbig2_bits([(obj, _peel(raster.raw, raster.filters), parms)], context)[0]
        fill_packed(samples, destroy, raster.width, 1, 1, fill)
        data, g4 = encode_g4(bytes(samples), raster.width, raster.height)
        if isinstance(globals_stream, pikepdf.Stream):
            context.jbig2_globals.add(globals_stream.objgen)
        return _LayerResult(_rebuild(pdf, obj, data, "/CCITTFaxDecode", g4), destroy, False, False)

    if last in DCT_FILTERS:
        data, widened = _dct_rewrite(raster, destroy, role, fill)
        grew = codec_taint.covered_pixels(widened) > codec_taint.covered_pixels(destroy)
        return _LayerResult(_rebuild(pdf, obj, data, "/DCTDecode"), widened, grew, False)

    if last in JPX_FILTERS:
        outcome = _jpx_rewrite(raster, destroy, role, fill)
        if outcome is None:
            return _LayerResult(None, (), False, True)
        data, widened, declared, alpha = outcome
        stream = _rebuild(pdf, obj, data, "/JPXDecode")
        if "/SMaskInData" in stream:
            del stream["/SMaskInData"]
        if declared is not None:
            profile = pdf.make_stream(declared[1])
            profile["/N"] = declared[2]
            stream["/ColorSpace"] = pikepdf.Array([Name("/ICCBased"), profile])
        if alpha is not None and int(_get(obj, "/SMaskInData") or 0):
            stream["/SMask"] = pdf.make_indirect(_alpha_mask(pdf, alpha, widened))
        grew = codec_taint.covered_pixels(widened) > codec_taint.covered_pixels(destroy)
        return _LayerResult(stream, widened, grew, False)

    refuse(f"an unsupported filter {last}")


def _alpha_mask(pdf, alpha, destroyed):
    """A JPEG 2000 image's embedded opacity channel, as an explicit /SMask with
    the destroyed area transparent."""
    buffer = bytearray(alpha.astype("uint8").tobytes())
    height, width = alpha.shape
    fill_packed(buffer, destroyed, width, 1, 8, (0,))
    mask = pdf.make_stream(zlib.compress(bytes(buffer), 6))
    mask["/Type"] = Name("/XObject")
    mask["/Subtype"] = Name("/Image")
    mask["/Width"] = width
    mask["/Height"] = height
    mask["/ColorSpace"] = Name("/DeviceGray")
    mask["/BitsPerComponent"] = 8
    mask["/Filter"] = Name("/FlateDecode")
    return mask


def _mask_shows(pdf, obj, role, context, resolve, touched):
    """`numpy` bool array over the mask's pixels: True where the mask lets its
    image show AND the marks do not touch that pixel at all."""
    import numpy as np

    raster = _load(obj, resolve, role, source=obj)
    last = raster.filters[-1] if raster.filters else ""
    if not raster.filters or last in QPDF_FILTERS:
        samples = _packed_samples(raster)
    elif last in CCITT_FILTERS:
        samples = _ccitt_samples(raster)
    elif last in JBIG2_FILTERS:
        _require_bilevel(raster)
        samples = jbig2_bits([(obj, _peel(raster.raw, raster.filters), raster.parms)], context)[0]
    else:
        # A continuous-tone mask (DCT or JPEG 2000) is only ever an /SMask:
        # read it through the imaging bridge as grey.
        try:
            grey = pikepdf.PdfImage(obj).as_pil_image(apply_mask=False).convert("L")
        except Exception:
            refuse("an unreadable transparency mask")
        samples = bytearray(grey.tobytes())
        raster = raster._replace(bpc=8, space=_Space("gray", 1), image_mask=False, honour_decode=False)
    width, height, bpc = raster.width, raster.height, raster.bpc
    buf = np.frombuffer(bytes(samples), dtype=np.uint8)
    if bpc == 16:
        values = buf.view(">u2").reshape(height, width).astype(np.float64)
    elif bpc == 8:
        values = buf.reshape(height, width).astype(np.float64)
    else:
        packed = buf.reshape(height, stride(width, 1, bpc))
        bits = np.unpackbits(packed, axis=1)
        if bpc == 1:
            values = bits[:, :width].astype(np.float64)
        else:
            groups = bits[:, : width * bpc].reshape(height, width, bpc)
            weights = (1 << np.arange(bpc - 1, -1, -1)).astype(np.float64)
            values = (groups * weights).sum(axis=2)
    pairs = _decode_pairs(raster.obj, raster.space, bpc, raster.image_mask, raster.honour_decode)
    dmin, dmax = pairs[0]
    maxv = float((1 << bpc) - 1)
    rendered = dmin + values / maxv * (dmax - dmin)
    if raster.image_mask:
        # A stencil /Mask shows its base where the rendered value is 0.
        show = rendered < 0.5
    else:
        show = rendered > 0.0
    for row, lo, hi in touched:
        show[row, lo:hi] = False
    return show


class Placement(NamedTuple):
    kind: str  # "keep" | "remove" | "replace"
    stream: object
    key: tuple
    widened: bool
    codec: bool  # removed whole because a lossy codec ties every pixel to the mark


_KEEP = Placement("keep", None, (), False, False)


def _identity(obj):
    try:
        if obj.is_indirect:
            return ("obj",) + tuple(obj.objgen)
    except Exception:
        pass
    return ("id", id(obj))


def plan_placement(pdf, obj, ctm: Matrix, regions: list, context: Context, resolve=None, inline=None) -> Placement:
    """What one placement of one image becomes under the marks."""
    base_w, base_h = dimensions(obj)
    base_cov = coverage(ctm, regions, base_w, base_h)
    if base_cov.singular:
        return Placement("remove", None, (), False, False)
    if not base_cov.touched:
        return _KEEP
    if base_cov.full:
        return Placement("remove", None, (), False, False)

    masks = []
    if inline is None:
        for key, role in (("/SMask", SMASK), ("/Mask", STENCIL_MASK)):
            entry = obj.get(key)
            if isinstance(entry, pikepdf.Stream):
                w, h = dimensions(entry)
                masks.append((key, role, entry, coverage(ctm, regions, w, h)))
        if any(key == "/SMask" for key, *_ in masks):
            # /SMask overrides /Mask (ISO 32000-2 Table 87, SMask).
            masks = [m for m in masks if m[0] == "/SMask"]

    def plan(cov):
        if cov.singular or not cov.touched:
            return (), False
        if cov.every_pixel:
            return inside_spans(ctm, regions, cov), True
        return cov.touched, False

    mask_plans = []
    for key, role, entry, cov in masks:
        destroy, coarse = plan(cov)
        mask_plans.append((key, role, entry, cov, destroy, coarse))
    if base_cov.every_pixel and not any(cov.touched and not coarse for _k, _r, _e, cov, _d, coarse in mask_plans):
        # Every base pixel meets the mark and no finer layer says where the
        # content is: the image is, to its own resolution, covered.
        return Placement("remove", None, (), False, False)
    base_destroy, base_coarse = plan(base_cov)

    # Everything below is a function of these sets and the image, so identical
    # sets share one copy — the same logo drawn 400 times under one strip of
    # marks is one redacted image, not 400.
    plan_key = (
        _identity(obj) if inline is None else ("inline", id(inline)),
        base_cov.touched,
        base_destroy,
        tuple((key, cov.touched, destroy) for key, _r, _e, cov, destroy, _c in mask_plans),
    )
    if inline is None and plan_key in context.copies:
        return context.copies[plan_key]

    if base_coarse and mask_plans:
        straddlers = _difference(base_cov.touched, base_destroy)
        if straddlers:
            key, role, entry, cov, destroy, _coarse = mask_plans[0]
            show = _mask_shows(pdf, entry, role, context, resolve, cov.touched)
            hidden: list = []
            for row, lo, hi in straddlers:
                for col in range(lo, hi):
                    if not _straddler_shows(row, col, base_w, base_h, show):
                        hidden.append((row, col, col + 1))
            base_destroy = _union(base_destroy, hidden)

    raw = None
    source = None
    if inline is not None:
        source, raw = inline
    result = _build(pdf, obj, base_w, base_h, base_destroy, mask_plans, context, resolve, source, raw, plan_key)
    if inline is None:
        context.copies[plan_key] = result
    return result


def _build(pdf, obj, base_w, base_h, base_destroy, mask_plans, context, resolve, source, raw, plan_key) -> Placement:
    base = _rewrite_layer(pdf, obj, BASE, base_destroy, context, resolve, source=source, raw=raw)
    if base.lossy_jpx:
        return Placement("remove", None, plan_key, False, True)
    if base_destroy and _span_count(base.destroyed) >= base_w * base_h:
        return Placement("remove", None, plan_key, False, bool(base.widened))

    widened = base.widened
    mask_streams: dict = {}
    for key, role, entry, cov, destroy, _coarse in mask_plans:
        layer = _rewrite_layer(pdf, entry, role, destroy, context, resolve)
        if layer.lossy_jpx:
            return Placement("remove", None, plan_key, False, True)
        if layer.stream is not None:
            if _span_count(layer.destroyed) >= cov.width * cov.height:
                # Transparent everywhere: the image paints nothing at all.
                return Placement("remove", None, plan_key, False, bool(layer.widened))
            mask_streams[key] = layer.stream
            widened = widened or layer.widened

    if base.stream is None and not mask_streams:
        # Every touched pixel straddles the mark and still shows outside it:
        # nothing here is visible only under the mark.
        return _KEEP

    if base.stream is not None:
        stream = base.stream
    else:
        stream = _verbatim_copy(pdf, obj)
    for key, _role, entry, _cov, _destroy, _coarse in mask_plans:
        if key in mask_streams:
            stream[key] = pdf.make_indirect(mask_streams[key])
        else:
            # A mask with nothing destroyed still goes through the key policy:
            # its own /Metadata or /AF could picture the original.
            stream[key] = pdf.make_indirect(_verbatim_copy(pdf, entry))
    return Placement("replace", stream, plan_key, widened, False)


def _verbatim_copy(pdf, obj):
    """The same encoded samples under the key policy."""
    stream = _rebuild(pdf, obj, bytes(obj.read_raw_bytes()), None)
    for key in ("/Filter", "/DecodeParms"):
        if obj.get(key) is not None:
            stream[key] = obj.get(key)
    return stream


def _straddler_shows(row, col, base_w, base_h, show) -> bool:
    """Does a kept base pixel still show OUTSIDE the marks through its mask?"""
    mask_h, mask_w = show.shape
    m_c0 = max(int(math.floor(col / base_w * mask_w)), 0)
    m_c1 = min(int(math.ceil((col + 1) / base_w * mask_w)), mask_w)
    m_r0 = max(int(math.floor(row / base_h * mask_h)), 0)
    m_r1 = min(int(math.ceil((row + 1) / base_h * mask_h)), mask_h)
    return bool(show[m_r0:m_r1, m_c0:m_c1].any())


def inline_image_parts(iimage) -> tuple:
    r"""`(dict, raw data)` for an inline image.

    `unparse()` is the only public route to the bytes: the data accessor builds
    a throwaway one-page PDF sized to the image and raises on anything under
    three units, which every test-sized image is. The metadata section holds
    only names and numbers, so the first `\nID\n` is the separator.
    """
    try:
        body = bytes(iimage.unparse())
    except Exception:
        refuse("unreadable inline image data")
    _head, separator, rest = body.partition(b"\nID\n")
    if not separator:
        refuse("unreadable inline image data")
    if rest.endswith(b"EI"):
        rest = rest[:-2]
    return iimage.obj, bytes(rest)


def plan_inline(pdf, iimage, ctm: Matrix, regions: list, context: Context, resolve=None) -> Placement:
    """An inline image's plan. A partial result comes back as an image XObject:
    the imaging bridge cannot build an inline image carrying new data (a
    hand-built one unparses with an empty data section), and `Do` on an image
    XObject draws the same unit square under the same CTM."""
    obj, raw = inline_image_parts(iimage)
    filters = _filter_names(obj)
    for name in filters:
        if name in JPX_FILTERS or name in JBIG2_FILTERS:
            # ISO 32000-2 §8.9.7: neither filter is allowed on an inline image.
            refuse(f"an inline image encoded with {name}")
    width, height = dimensions(obj)
    scratch = pikepdf.new()
    view = scratch.make_stream(raw)
    view["/Type"] = Name("/XObject")
    view["/Subtype"] = Name("/Image")
    view["/Width"] = width
    view["/Height"] = height
    view["/ColorSpace"] = Name("/DeviceGray")
    view["/BitsPerComponent"] = 1
    if filters:
        view["/Filter"] = (
            Name(filters[0]) if len(filters) == 1 else pikepdf.Array([Name(n) for n in filters])
        )
        parms = _parms_for(obj, len(filters))
        if parms is not None:
            try:
                copied = pikepdf.Dictionary()
                for key in parms.keys():
                    copied[key] = parms[key]
                view["/DecodeParms"] = copied
            except Exception:
                pass
    return plan_placement(pdf, obj, ctm, regions, context, resolve, inline=(view, raw))
