"""Layer codecs for mixed-raster-content compression.

MRC splits a scanned page into three layers — a 1-bit text STENCIL at source
resolution, a low-resolution FOREGROUND carrying ink colour, and a
low-resolution BACKGROUND carrying the paper. This module owns the encoding of
each, and nothing else; segmentation and page assembly are in `engine/mrc.py`.

Mask convention:
a mask is a Pillow mode-"1" image in which **0 is INK and 1 is PAPER**. That is
what `Image.new("1", size, 1)` plus `fill=0` drawing produces, and what a
threshold of the form `gray < threshold` produces after `.convert("1")`. It is
NOT negotiable per call site — a mask handed in the other polarity encodes to a
perfectly valid stream of the negative image, and the failure renders as a
solid black page that OCR still returns plausible words from.

Correctness constraints:

1. **A Pillow group-4 TIFF is MULTI-STRIP by default and each strip RESTARTS
   the G4 reference line.** Pillow wrote 17 strips of 205 rows for a 3300-row
   page; concatenating them decodes progressively wrong — and the corruption
   looks like EROSION, not like an error, so a size check and a "does it
   render" check both pass. `ROWSPERSTRIP = height` forces one strip, and the
   strip count is asserted rather than assumed.
2. **Stencil polarity is a MEASUREMENT, not a deduction.** libtiff's
   photometric tag and the PDF `/Decode` array do not compose the way reading
   the two specifications suggests: the measured pairing for a CCITT G4
   `/ImageMask` is `photometric 1` + `/Decode [1 0]` + `/BlackIs1 false`, while
   a jbig2enc stream embeds as an `/ImageMask` with NO `/Decode` at all. Both
   were established by encoding, embedding and rendering with an independent
   decoder — `verify_mask_stream` is that check, kept as production code so it
   runs on every real mask and not only in a probe.
3. **Refinement coding is never emitted.** jbig2enc's README records reader
   crashes with `-r`, so the flag has no parameter to reach it.
4. **Symbol mode substitutes glyphs, and that is a user-visible property.**
   jbig2enc's `-s` matches visually similar shapes and stores one
   representative — the mechanism behind the well-known scanner
   character-substitution class. It is selectable, never the silent default of
   a lossless-sounding preset, and `MaskStream.codec` records which arm ran so
   the caller can say so.
5. **Symbol mode costs the SQUARE of the document's unmatched marks, so a
   stencil made of grain rather than type must never enter the shared
   dictionary.** Every mark that matches no template becomes a template that
   every later mark is compared against, and a page of sensor grain matches
   nothing. Measured on eight DISTINCT pages of 2550x3300 stencils: 2 000
   unique marks per page encode in 7.5 s, 8 000 in 54.7 s, 16 000 in 183 s —
   against 0.08 s per page for generic mode and 0.03 s for G4, both flat. The
   quadratic term is in the DOCUMENT, not the page, which is why a 272-page
   run can spend hours and why no per-page timeout would have caught it.
6. **A codec is a preference; finishing is not.** Every arm degrades rather
   than refuses: symbol falls to generic, generic falls to G4 per page, and
   `MaskStream.codec` says which ran. Refusing a whole document because one
   stencil was expensive throws away every page that encoded correctly, and a
   safe slower codec was available the whole time.
7. **The background is FIXED-quality JPEG 2000, never rate-controlled.** A
   rate target picks every code-block's truncation against one threshold for
   the whole picture, so every background pixel depends on the content under
   any redaction mark, and a partial redaction must remove the whole layer.
   `encode_layer_jpx` quantizes each coefficient on its own value and codes
   every pass, so a partial redaction destroys only the mark and the 5/3
   filter's reach around it.
"""

from __future__ import annotations

import functools
import io
import math
import os
import struct
import subprocess
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image
from PIL.TiffImagePlugin import ROWSPERSTRIP

from . import budget
from engine.pdf_save import save_pdf

# The mask codecs, in the order the presets prefer them.
JBIG2_SYMBOL = "jbig2_symbol"
JBIG2_GENERIC = "jbig2_generic"
CCITT_G4 = "ccitt_g4"
MASK_CODECS = (JBIG2_SYMBOL, JBIG2_GENERIC, CCITT_G4)

#: The document-level answer when the pages did not all get the same codec.
#: Not a member of MASK_CODECS — nothing encodes with it, and a caller must
#: never be able to ASK for it; it is only ever a report.
MASK_CODEC_MIXED = "mixed"

# jbig2enc's own default classification threshold. Exposed because Archival
# never uses symbol mode at all and Smallest wants it looser.
DEFAULT_SYMBOL_THRESHOLD = 0.92
#: jbig2enc's own accepted range for `-t`. A value outside it is refused by
#: the encoder with a message about a flag our callers never wrote, so the
#: range is restated here and refused in OUR words.
MIN_SYMBOL_THRESHOLD, MAX_SYMBOL_THRESHOLD = 0.40, 0.97

# --------------------------------------------------------------------------
# Routing (rule 5) and the budgets each arm gets (rule 6)
# --------------------------------------------------------------------------
#: Mean INK PIXELS per connected mark, at 300 dpi, below which a stencil is
#: grain rather than type and does not enter the shared symbol dictionary.
#:
#: MARK SIZE, not mark count, and the difference is the whole test: 12 960
#: repeating glyph components encode in 0.34 s while 16 000 unique specks take
#: 7.5 s, so a count ceiling would demote a dense text page and still admit a
#: photograph. Measured over type down to 5 pt in three columns, clean and
#: noisy, the tightest LEGITIMATE page averages 112 px of ink per mark; a
#: full-page photograph's surviving grain averages 5.1 px. The floor sits at
#: 24 px — 4.7x below the tightest type and 4.7x above the grain, the centre of
#: that gap in ratio.
SYMBOL_MIN_MARK_AREA = 24.0
#: The resolution `SYMBOL_MIN_MARK_AREA` is stated at. Ink area is an AREA, so
#: a stencil at another resolution scales by the square.
SYMBOL_MARK_AREA_DPI = 300.0

#: Symbol mode's budget, and it is a DOCUMENT budget because the dictionary is.
#: Measured: 32 pages of 2550x3300 text stencils (33.7 MB of bitmap) encode in
#: 3.9 s, so 2 s per megabyte and 2 s per page is about fiftyfold headroom over
#: honest work on this hardware. The cap matters more than the coefficients: at
#: the shared 7200 s a pathological corpus burned two hours before anything was
#: reported, and since a breach now DEGRADES rather than refuses, the cap is
#: the bound on wasted waiting, not a judgement about honest runs.
SYMBOL_BASE, SYMBOL_PER_MB, SYMBOL_PER_PAGE, SYMBOL_CAP = 60.0, 2.0, 2.0, 1800.0
#: Generic mode runs one process per page, so its budget is a PAGE budget.
#: Measured at 0.08 s per page; the floor is process startup, not the encode.
GENERIC_BASE, GENERIC_PER_MB, GENERIC_CAP = 30.0, 2.0, 300.0


@dataclass(frozen=True)
class MaskProfile:
    """What the segmentation measured about one stencil, for codec routing.

    Carried from the caller rather than re-derived here: connected components
    are `engine/mrc.py`'s answer to give, and that module imports this one.
    """

    #: Mean INK pixels per connected mark in the stencil.
    mark_area_mean: float
    #: The stencil's own resolution, which `mark_area_mean` is measured in.
    dpi: int


def symbol_mode_suits(profile: MaskProfile) -> bool:
    """Whether this stencil may join the shared symbol dictionary (rule 5)."""
    if profile.mark_area_mean <= 0:
        # An empty stencil costs nothing either way; keep it with the document
        # so a blank page does not split the codec report on its own.
        return True
    scale = max(float(profile.dpi), 1.0) / SYMBOL_MARK_AREA_DPI
    return profile.mark_area_mean >= SYMBOL_MIN_MARK_AREA * scale * scale


# How far a decoded stencil's ink coverage may sit from the mask it came from.
# Both G4 and JBIG2 generic are LOSSLESS with respect to the bitmap, so the
# honest tolerance is tiny; symbol mode substitutes shapes, which moves
# coverage by a fraction of a percent at most on real text.
VERIFY_TOLERANCE = 0.001


@dataclass(frozen=True)
class MaskStream:
    """An encoded stencil plus everything its PDF image dictionary needs."""

    data: bytes
    codec: str
    width: int
    height: int
    #: `/Decode` array, or None when the filter's natural polarity is correct.
    decode: tuple[int, int] | None
    #: `/DecodeParms` entries, minus `/JBIG2Globals` (which is an indirect
    #: reference the caller must create in its own Pdf).
    decode_parms: dict[str, object] | None
    #: The shared symbol dictionary for `/JBIG2Globals`, or None.
    globals_data: bytes | None
    #: Ink coverage of the SOURCE mask, for `verify_mask_stream` to check
    #: the round trip against.
    ink_fraction: float


# --------------------------------------------------------------------------
# Locating the vendored encoder
# --------------------------------------------------------------------------
def jbig2_candidates(engine_dir: Path) -> tuple[Path, ...]:
    """Where the vendored encoder sits relative to the engine package.

    Split out from `resolve_jbig2` so BOTH layouts can be tested: the shipped
    one is the layout that matters in production and cannot be exercised by
    running the dev tree, because `resolve_jbig2` reads its own `__file__`.
    """
    return (
        # Shipped: <resources>/engine/ beside <resources>/jbig2enc/.
        engine_dir.parent / "jbig2enc" / "jbig2.exe",
        # Dev tree: src/engine/ with <repo>/resources/jbig2enc/.
        engine_dir.parent.parent / "resources" / "jbig2enc" / "jbig2.exe",
    )


def resolve_jbig2(jbig2_path: str = "") -> str:
    """The BUNDLED jbig2 encoder, never a system install.

    An explicit path wins (the CLI and the Rust host pass one). Otherwise the
    binary is found relative to this package: the engine ships as
    `<resources>/engine/` and the encoder as `<resources>/jbig2enc/`, and the
    same relationship holds in the dev tree (`src/engine` beside
    `resources/jbig2enc` two levels up). PATH is deliberately not consulted —
    a machine-local jbig2enc of unknown version and unknown licence provenance
    must never silently become part of a shipped document's encoding.

    Returns "" when nothing is there; the caller decides whether that is a
    fallback to CCITT G4 or a refusal (a codec asked for BY NAME and missing
    is a refusal — a silent codec swap would make the size claim untrue).
    """
    if jbig2_path:
        return jbig2_path if os.path.isfile(jbig2_path) else ""
    for cand in jbig2_candidates(Path(__file__).resolve().parent):
        if cand.is_file():
            return str(cand)
    return ""


def jbig2_available(jbig2_path: str = "") -> bool:
    return bool(resolve_jbig2(jbig2_path))


def _require_jbig2(jbig2_path: str) -> str:
    exe = resolve_jbig2(jbig2_path)
    if not exe:
        raise RuntimeError(
            "The JBIG2 encoder is not available: no jbig2.exe at "
            f"{jbig2_path or '(no path given)'}. Run scripts/bundle-jbig2enc.ps1."
        )
    return exe


# --------------------------------------------------------------------------
# Measuring
# --------------------------------------------------------------------------
def mask_ink_fraction(mask: Image.Image) -> float:
    """Fraction of the mask that is INK, under the 0-is-ink convention."""
    hist = mask.convert("L").histogram()
    return sum(hist[:128]) / float(mask.width * mask.height)


def _as_mask(mask: Image.Image) -> Image.Image:
    if mask.mode != "1":
        raise ValueError(
            f"a mask must be a 1-bit image (Pillow mode '1'), got mode {mask.mode!r}"
        )
    return mask


# --------------------------------------------------------------------------
# CCITT group 4
# --------------------------------------------------------------------------
def encode_mask_ccitt_g4(mask: Image.Image) -> MaskStream:
    """Encode a stencil as `/CCITTFaxDecode` K=-1 (group 4).

    The PDF/A-1-safest mask filter and the fallback when the vendored JBIG2
    encoder is absent. Rule 1 lives here: exactly one strip, asserted.
    """
    _as_mask(mask)
    width, height = mask.size
    buf = io.BytesIO()
    mask.save(buf, format="TIFF", compression="group4", tiffinfo={ROWSPERSTRIP: height})
    raw = buf.getvalue()

    tif = Image.open(io.BytesIO(raw))
    offsets = tif.tag_v2[273]
    counts = tif.tag_v2[279]
    if len(offsets) != 1:
        # Not a warning: a concatenation of strips is a stream that decodes
        # progressively wrong while passing every cheap check.
        raise RuntimeError(
            f"a CCITT G4 mask must encode as ONE strip; libtiff wrote {len(offsets)} "
            "— the concatenated stream would decode progressively wrong."
        )
    photometric = int(tif.tag_v2[262])
    data = raw[offsets[0] : offsets[0] + counts[0]]

    # Rule 2. libtiff signals its run polarity through the photometric tag
    # rather than through the codestream, so the /Decode array is derived from
    # the tag it actually wrote — measured against a rendered page, never
    # inferred from the two specifications.
    decode = (1, 0) if photometric == 1 else (0, 1)
    return MaskStream(
        data=data,
        codec=CCITT_G4,
        width=width,
        height=height,
        decode=decode,
        decode_parms={"K": -1, "Columns": width, "Rows": height, "BlackIs1": False},
        globals_data=None,
        ink_fraction=mask_ink_fraction(mask),
    )


# --------------------------------------------------------------------------
# JBIG2
# --------------------------------------------------------------------------
def encode_masks_jbig2(
    masks: list[Image.Image],
    *,
    mode: str = JBIG2_SYMBOL,
    jbig2_path: str = "",
    symbol_threshold: float = DEFAULT_SYMBOL_THRESHOLD,
) -> list[MaskStream]:
    """Encode a DOCUMENT's stencils as `/JBIG2Decode`.

    Plural on purpose. Symbol mode builds ONE symbol dictionary shared by every
    page and emitted as `/JBIG2Globals`; that sharing is a large part of the
    multi-page win, and a per-page call throws it away. Generic mode has no
    cross-page state, so it runs one page per invocation — but it takes the
    same list so callers do not branch on the codec.

    Returns one MaskStream per input, in order. Symbol-mode streams all carry
    the SAME `globals_data`.
    """
    if mode not in (JBIG2_SYMBOL, JBIG2_GENERIC):
        raise ValueError(f"unknown JBIG2 mode: {mode}")
    if mode == JBIG2_SYMBOL and not MIN_SYMBOL_THRESHOLD <= symbol_threshold <= MAX_SYMBOL_THRESHOLD:
        # Upstream's own range, restated here so the refusal names OUR
        # parameter. Reaching the encoder with an out-of-range value produces
        # "Invalid value for threshold" against a flag the caller never saw —
        # a matrix run caught exactly that combination (an archival preset
        # asked for symbol mode by name).
        raise ValueError(
            f"the JBIG2 symbol threshold must be {MIN_SYMBOL_THRESHOLD}-"
            f"{MAX_SYMBOL_THRESHOLD}, got {symbol_threshold}"
        )
    if not masks:
        return []
    exe = _require_jbig2(jbig2_path)
    for mask in masks:
        _as_mask(mask)

    with tempfile.TemporaryDirectory(prefix="spectrapdf_jbig2_") as work:
        wd = Path(work)
        inputs = []
        for i, mask in enumerate(masks):
            png = wd / f"p{i:04d}.png"
            mask.save(png, format="PNG")
            inputs.append(png)

        if mode == JBIG2_SYMBOL:
            # Derived, not fixed: the encoder's work is proportional to pixel
            # count, and a 600-dpi multi-page scan is the case the feature
            # exists for. ~4 MB of 1-bit samples per megapixel-page is the
            # scale, so the budget is expressed against the uncompressed
            # bitmap size — of the WHOLE group, because the dictionary is.
            bitmap_bytes = sum(m.width * m.height for m in masks) // 8
            allowed = budget.derive(
                base=SYMBOL_BASE, size_bytes=bitmap_bytes, pages=len(masks),
                per_mb=SYMBOL_PER_MB, per_page=SYMBOL_PER_PAGE, cap=SYMBOL_CAP,
            )
            streams = _run_symbol(exe, wd, inputs, symbol_threshold, allowed, bitmap_bytes)
        else:
            streams = _run_generic(exe, wd, inputs, masks)

    return [
        MaskStream(
            data=data,
            codec=mode,
            width=mask.width,
            height=mask.height,
            # Measured: a jbig2enc stream embeds as an /ImageMask with the
            # filter's natural polarity — adding /Decode [1 0] renders the
            # negative.
            decode=None,
            decode_parms=None,
            globals_data=globals_data,
            ink_fraction=mask_ink_fraction(mask),
        )
        for mask, (data, globals_data) in zip(masks, streams)
    ]


def _jbig2_failed(result: subprocess.CompletedProcess) -> RuntimeError:
    detail = (result.stderr or b"").decode("utf-8", "replace").strip()
    return RuntimeError(f"The JBIG2 encoder failed: {detail or 'no error output'}")


def _run_generic(
    exe: str, wd: Path, inputs: list[Path], masks: list[Image.Image]
) -> list[tuple[bytes, bytes | None]]:
    """One invocation per page; the embedded stream arrives on stdout.

    `-p` is PDF-ready output (embedded segment format, no file header). `-r`
    is never passed — rule 3.

    The budget is per PAGE because the invocation is: generic mode carries no
    cross-page state, so charging one page against the whole document's
    allowance would let an early page spend what a later one needs.
    """
    out: list[tuple[bytes, bytes | None]] = []
    for i, png in enumerate(inputs):
        page_bytes = (masks[i].width * masks[i].height) // 8
        result = budget.run(
            [exe, "-p", str(png)],
            what="The JBIG2 encoder",
            budget=budget.derive(
                base=GENERIC_BASE, size_bytes=page_bytes, pages=1,
                per_mb=GENERIC_PER_MB, cap=GENERIC_CAP,
            ),
            size_bytes=page_bytes,
            pages=1,
            cwd=wd,
        )
        if result.returncode != 0:
            raise _jbig2_failed(result)
        if not result.stdout:
            raise RuntimeError(f"The JBIG2 encoder produced no output for page {i + 1}.")
        out.append((result.stdout, None))
    return out


def _run_symbol(
    exe: str, wd: Path, inputs: list[Path], threshold: float, allowed: float, bitmap_bytes: int
) -> list[tuple[bytes, bytes | None]]:
    """One invocation for the whole document; output lands as files.

    `-s -p -b <base>` writes `<base>.sym` (the shared symbol dictionary, which
    becomes `/JBIG2Globals`) and `<base>.0000`, `.0001`, … one per page.
    """
    base = wd / "doc"
    result = budget.run(
        [exe, "-s", "-p", "-t", f"{threshold:g}", "-b", str(base), *[str(p) for p in inputs]],
        what="The JBIG2 encoder",
        budget=allowed,
        size_bytes=bitmap_bytes,
        pages=len(inputs),
        cwd=wd,
    )
    if result.returncode != 0:
        raise _jbig2_failed(result)

    sym = Path(str(base) + ".sym")
    if not sym.is_file():
        raise RuntimeError(
            "The JBIG2 encoder produced no symbol dictionary — the shared "
            "/JBIG2Globals stream every page refers to is missing."
        )
    globals_data = sym.read_bytes()

    out: list[tuple[bytes, bytes | None]] = []
    for i in range(len(inputs)):
        page = Path(f"{base}.{i:04d}")
        if not page.is_file():
            raise RuntimeError(f"The JBIG2 encoder produced no output for page {i + 1}.")
        out.append((page.read_bytes(), globals_data))
    return out


def _generic_ladder(masks: list[Image.Image], jbig2_path: str) -> list[MaskStream]:
    """Generic mode, page by page, each page falling to G4 on a breach.

    The bottom two rungs of rule 6. Generic mode has no cross-page state, so a
    page that outlives its budget can be re-encoded alone without disturbing
    any other — and CCITT G4 has no subprocess at all, so the bottom rung
    cannot itself time out.
    """
    out: list[MaskStream] = []
    for mask in masks:
        try:
            out.extend(encode_masks_jbig2([mask], mode=JBIG2_GENERIC, jbig2_path=jbig2_path))
        except budget.TimeBudgetExceeded:
            out.append(encode_mask_ccitt_g4(mask))
    return out


def encode_mask(
    masks: list[Image.Image],
    *,
    codec: str,
    jbig2_path: str = "",
    symbol_threshold: float = DEFAULT_SYMBOL_THRESHOLD,
    allow_fallback: bool = True,
    profiles: Sequence[MaskProfile] | None = None,
) -> tuple[list[MaskStream], str]:
    """Encode a document's stencils with `codec`, reporting what actually ran.

    A missing vendored encoder is a PROVISIONING fault, not a document fault,
    so with `allow_fallback` the mask falls back to CCITT G4 — but the returned
    codec name says so, because a silent swap would make the size claim untrue.
    When the caller asked for a codec BY NAME (`allow_fallback=False`) it
    refuses instead of substituting.

    `profiles`, one per mask, is what routes a grain stencil away from the
    shared symbol dictionary before a second of it is spent (rule 5). Without
    them nothing is routed and the ladder of rule 6 is the only protection,
    which is why the routing is an OPTIMISATION and the ladder is the guarantee.

    The returned codec name is the DOCUMENT's: the one every page got, or
    `MASK_CODEC_MIXED` when they differ. Per-page truth is `MaskStream.codec`,
    and it is the only thing a size claim may be made against.
    """
    if codec not in MASK_CODECS:
        raise ValueError(f"unknown mask codec: {codec} (expected one of {', '.join(MASK_CODECS)})")
    if profiles is not None and len(profiles) != len(masks):
        raise ValueError(
            f"one mask profile per mask is required, got {len(profiles)} for {len(masks)} mask(s)"
        )
    if codec == CCITT_G4:
        return [encode_mask_ccitt_g4(m) for m in masks], CCITT_G4
    if not jbig2_available(jbig2_path):
        if not allow_fallback:
            _require_jbig2(jbig2_path)  # raises the named refusal
        return [encode_mask_ccitt_g4(m) for m in masks], CCITT_G4
    if not masks:
        return [], codec
    if codec == JBIG2_GENERIC:
        streams = _generic_ladder(masks, jbig2_path)
        used = {s.codec for s in streams}
        return streams, (used.pop() if len(used) == 1 else MASK_CODEC_MIXED)

    shared: list[int] = list(range(len(masks)))
    alone: list[int] = []
    if profiles is not None:
        suits = [symbol_mode_suits(p) for p in profiles]
        shared = [i for i in shared if suits[i]]
        alone = [i for i, ok in enumerate(suits) if not ok]

    # Keyed by INDEX so the two arms reassemble into the caller's page order.
    # A dictionary rather than a pre-sized list with holes: a missing index is
    # then a crash at the lookup, where a hole would hand a page someone else's
    # stencil — which renders as a plausible page of the wrong words.
    by_index: dict[int, MaskStream] = {}
    if shared:
        group = [masks[i] for i in shared]
        try:
            streams = encode_masks_jbig2(
                group, mode=codec, jbig2_path=jbig2_path, symbol_threshold=symbol_threshold
            )
        except budget.TimeBudgetExceeded:
            # The corpus has answered the question the profiles only estimated.
            # Everything the dictionary was building is discarded — it is the
            # dictionary that was expensive — and the pages encode on their own.
            streams = _generic_ladder(group, jbig2_path)
        by_index.update(zip(shared, streams))
    by_index.update(zip(alone, _generic_ladder([masks[i] for i in alone], jbig2_path)))

    ordered = [by_index[i] for i in range(len(masks))]
    used = {s.codec for s in ordered}
    return ordered, (used.pop() if len(used) == 1 else MASK_CODEC_MIXED)


# --------------------------------------------------------------------------
# Continuous-tone layers
# --------------------------------------------------------------------------
def encode_layer_jpeg(image: Image.Image, quality: int = 45) -> bytes:
    """`/DCTDecode` bytes for a foreground or a PDF/A-1-safe background."""
    if not 1 <= quality <= 100:
        raise ValueError(f"JPEG quality must be 1-100, got {quality}")
    buf = io.BytesIO()
    # Baseline, no progressive: a progressive JPEG is not a valid /DCTDecode
    # stream for every consumer, and the layer is small enough that the few
    # percent progressive would save is not worth the compatibility question.
    image.convert("RGB").save(buf, format="JPEG", quality=quality, progressive=False)
    return buf.getvalue()


#: The most wavelet decomposition levels a background may use. A partial
#: redaction of a fixed-quality codestream destroys the mark plus the 5/3
#: filter's reach, `5 * 2**levels - 4` pixels of the layer on every side
#: (`codec_taint.jpx_taint`), so each level doubles the ring of background a
#: redaction takes with it; the lowest-frequency subband is coded exactly, so
#: each level fewer quadruples what that costs.
JPX_MAX_LEVELS = 5
#: How much coarser the chroma detail subbands are quantized than luma's. The
#: inverse RCT adds a chroma error to red and to blue one for one.
JPX_CHROMA_WEIGHT = 2.0

#: Code-block side, as the exponent T.800 A.6.1 signals (64 = 2**6).
_JPX_BLOCK_EXP = 6
#: Guard bits the encoder writes in QCD, and so the bit-plane budget a
#: code-block's zero-bit-plane count is measured against.
_JPX_GUARD_BITS = 2


class _Unassembled(Exception):
    """A codestream the assembly cannot carry through unchanged; the detail
    rides the public refusal's cause."""


def jpx_levels(width: int, height: int, levels: int) -> int:
    """`levels`, or fewer for a layer narrower than `2**levels` pixels, which
    the encoder refuses to decompose that far. The quantizer and the
    codestream must use the same count: the redaction model reads the reach
    from the codestream's own."""
    while levels and min(width, height) < (1 << levels):
        levels -= 1
    return levels


def _lift_forward(x: np.ndarray, axis: int) -> tuple[np.ndarray, np.ndarray]:
    """One reversible 5/3 analysis step along `axis`: `(low, high)`.

    T.800 F.3.8 with the first sample low-pass (the layer's origin is 0) and
    whole-sample symmetric extension (F.3.7). `>>` is the floor the lifting
    steps round with, negative values included.
    """
    x = np.moveaxis(x, axis, 0)
    even, odd = x[0::2], x[1::2]
    count = odd.shape[0]
    if count == 0:
        return np.moveaxis(even.copy(), 0, axis), np.moveaxis(odd.copy(), 0, axis)
    right = even[1 : count + 1] if even.shape[0] > count else np.concatenate([even[1:], even[-1:]])
    high = odd - ((even[:count] + right) >> 1)
    before = np.concatenate([high[:1], high])[: even.shape[0]]
    after = high if even.shape[0] == count else np.concatenate([high, high[-1:]])
    low = even + ((before + after + 2) >> 2)
    return np.moveaxis(low, 0, axis), np.moveaxis(high, 0, axis)


def _lift_inverse(low: np.ndarray, high: np.ndarray, axis: int) -> np.ndarray:
    """The exact inverse of `_lift_forward`."""
    low = np.moveaxis(low, axis, 0)
    high = np.moveaxis(high, axis, 0)
    count = high.shape[0]
    if count == 0:
        return np.moveaxis(low.copy(), 0, axis)
    before = np.concatenate([high[:1], high])[: low.shape[0]]
    after = high if low.shape[0] == count else np.concatenate([high, high[-1:]])
    even = low - ((before + after + 2) >> 2)
    right = even[1 : count + 1] if even.shape[0] > count else np.concatenate([even[1:], even[-1:]])
    out = np.empty((low.shape[0] + count,) + low.shape[1:], dtype=low.dtype)
    out[0::2] = even
    out[1::2] = high + ((even[:count] + right) >> 1)
    return np.moveaxis(out, 0, axis)


def _dwt_forward(plane: np.ndarray, levels: int) -> list:
    """`[LL, (HL, LH, HH) of the coarsest level, ..., of the finest]`.

    Vertical before horizontal at every level (T.800 F.4.2), the order the
    encoder's own forward transform uses. Another order yields other
    coefficients from the same samples, and the lossless coder then pays for
    the difference in every subband.
    """
    details = []
    for _ in range(levels):
        low, high = _lift_forward(plane, 0)
        plane, hl = _lift_forward(low, 1)
        lh, hh = _lift_forward(high, 1)
        details.append((hl, lh, hh))
    return [plane] + details[::-1]


def _dwt_inverse(bands: list) -> np.ndarray:
    plane = bands[0]
    for hl, lh, hh in bands[1:]:
        plane = _lift_inverse(_lift_inverse(plane, hl, 1), _lift_inverse(lh, hh, 1), 0)
    return plane


@functools.lru_cache(maxsize=None)
def _detail_norms(levels: int) -> tuple:
    """L2 norm of one coefficient's synthesis basis in each detail subband,
    `((HL, LH, HH) of the coarsest level, ..., of the finest)`.

    An error e in one coefficient puts (e * norm)^2 of squared error into the
    picture, so a step of `step / norm` in every subband spreads the error
    evenly over them.
    """

    def inverse(low: np.ndarray, high: np.ndarray, axis: int) -> np.ndarray:
        low = np.moveaxis(low, axis, 0)
        high = np.moveaxis(high, axis, 0)
        even = low - (np.concatenate([high[:1], high[:-1]]) + high) / 4.0
        out = np.empty((low.shape[0] * 2,) + low.shape[1:])
        out[0::2] = even
        out[1::2] = high + (even + np.concatenate([even[1:], even[-1:]])) / 2.0
        return np.moveaxis(out, 0, axis)

    # Large enough that no basis function meets the edge of the plane.
    size = 1 << (levels + 5)

    def norm(position: int, orient: int) -> float:
        bands: list = [np.zeros((size >> levels, size >> levels))]
        for level in range(levels, 0, -1):
            bands.append([np.zeros((size >> level, size >> level)) for _ in range(3)])
        target = bands[position][orient]
        target[target.shape[0] // 2, target.shape[1] // 2] = 1.0
        plane = bands[0]
        for hl, lh, hh in bands[1:]:
            plane = inverse(inverse(plane, hl, 1), inverse(lh, hh, 1), 0)
        return float(np.sqrt((plane * plane).sum()))

    return tuple(
        tuple(norm(position, orient) for orient in range(3)) for position in range(1, levels + 1)
    )


def _quantize_detail(coefficients: np.ndarray, step: float, norm: float) -> np.ndarray:
    """Dead-zone quantization with the power-of-two step nearest
    `step / norm`, reconstructed at the lower edge of each bin.

    The low bit-planes of every coefficient become zero, which the coder
    spends almost nothing on, and no magnitude grows.
    """
    shift = max(int(math.floor(math.log2(step / norm) + 0.5)), 0)
    if shift == 0:
        return coefficients
    return np.sign(coefficients) * ((np.abs(coefficients) >> shift) << shift)


def _quantized_components(image: Image.Image, step: float, levels: int) -> tuple[int, list]:
    """`(levels, [Y, Cb, Cr])`: the RCT components (T.800 G.2) rebuilt from
    their quantized subbands, before any clipping.

    `step` is the luma step of a detail subband whose synthesis norm is 1;
    chroma is `JPX_CHROMA_WEIGHT` times coarser. The lowest-frequency subband
    is kept exact: its coefficients are local means, so quantizing them draws
    contour lines across a smooth background, and a dead zone there rounds a
    faint paper tint to grey.
    """
    if not (step > 0 and 0 <= levels <= JPX_MAX_LEVELS):
        raise ValueError(
            f"a JPEG 2000 background needs a positive quantization step and 0-{JPX_MAX_LEVELS} "
            f"decomposition levels, got {step} and {levels}"
        )
    rgb = np.asarray(image.convert("RGB"), dtype=np.int32)
    red, green, blue = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    components = ((red + 2 * green + blue) >> 2, blue - green, red - green)
    del rgb, red, green, blue
    levels = jpx_levels(image.width, image.height, levels)
    norms = _detail_norms(levels)
    rebuilt = []
    for index, component in enumerate(components):
        scale = step * (1.0 if index == 0 else JPX_CHROMA_WEIGHT)
        bands = _dwt_forward(component, levels)
        for position in range(1, len(bands)):
            bands[position] = tuple(
                _quantize_detail(band, scale, norm)
                for band, norm in zip(bands[position], norms[position - 1])
            )
        rebuilt.append(_dwt_inverse(bands))
        del bands
    return levels, rebuilt


def _to_rgb(components: list) -> np.ndarray:
    """Inverse RCT and the clip to 0..255 every decoder applies last."""
    luma, cb, cr = components
    green = luma - ((cb + cr) >> 2)
    return np.clip(np.stack([cr + green, green, cb + green], axis=-1), 0, 255).astype(np.uint8)


def jpx_reconstruction(image: Image.Image, step: float, levels: int) -> np.ndarray:
    """The RGB samples every reader decodes from `encode_layer_jpx`, uint8."""
    return _to_rgb(_quantized_components(image, step, levels)[1])


# --------------------------------------------------------------------------
# Codestream assembly: the quantized components, coded unclipped
# --------------------------------------------------------------------------
class _HeaderReader:
    """Packet-header bits (T.800 B.10.1): MSB first, and a byte that follows
    0xFF carries only seven."""

    __slots__ = ("data", "pos", "byte", "left", "last")

    def __init__(self, data: bytes, pos: int):
        self.data, self.pos, self.byte, self.left, self.last = data, pos, 0, 0, 0

    def bit(self) -> int:
        if self.left == 0:
            if self.pos >= len(self.data):
                raise _Unassembled("a packet header runs past its tile")
            value = self.data[self.pos]
            self.pos += 1
            self.left = 7 if self.last == 0xFF else 8
            self.last = value
            self.byte = value & (0x7F if self.left == 7 else 0xFF)
        self.left -= 1
        return (self.byte >> self.left) & 1

    def bits(self, count: int) -> int:
        value = 0
        for _ in range(count):
            value = (value << 1) | self.bit()
        return value

    def end(self) -> int:
        """The offset after the header; a final 0xFF is followed by its stuffed byte."""
        if self.last == 0xFF:
            self.pos += 1
        return self.pos


class _HeaderWriter:
    """The writing side of `_HeaderReader`."""

    __slots__ = ("out", "byte", "free", "count")

    def __init__(self):
        self.out = bytearray()
        self.byte = 0
        self.free = 8
        self.count = 0

    def bit(self, value: int) -> None:
        self.free -= 1
        self.byte |= (value & 1) << self.free
        self.count += 1
        if self.free == 0:
            self._emit()

    def bits(self, value: int, count: int) -> None:
        for shift in range(count - 1, -1, -1):
            self.bit((value >> shift) & 1)

    def _emit(self) -> None:
        self.out.append(self.byte)
        self.free = 7 if self.byte == 0xFF else 8
        self.byte = 0
        self.count = 0

    def finish(self) -> bytes:
        if self.count:
            self._emit()
        if self.out and self.out[-1] == 0xFF:
            self.out.append(0)
        return bytes(self.out)


class _TagTree:
    """T.800 B.10.2 over one subband's code-block grid, in both directions."""

    __slots__ = ("shapes", "value", "low", "known")

    def __init__(self, width: int, height: int, leaves: Sequence[int] | None = None):
        self.shapes = []
        w, h = max(width, 1), max(height, 1)
        while True:
            self.shapes.append((w, h))
            if w == 1 and h == 1:
                break
            w, h = (w + 1) // 2, (h + 1) // 2
        unknown = 1 << 30
        self.value = [[unknown] * (w * h) for w, h in self.shapes]
        self.low = [[0] * (w * h) for w, h in self.shapes]
        self.known = [[False] * (w * h) for w, h in self.shapes]
        if leaves is not None:
            self.value[0] = list(leaves)
            for depth in range(1, len(self.shapes)):
                w, _h = self.shapes[depth]
                child_w, child_h = self.shapes[depth - 1]
                row = self.value[depth]
                for y in range(child_h):
                    for x in range(child_w):
                        k = (y // 2) * w + x // 2
                        row[k] = min(row[k], self.value[depth - 1][y * child_w + x])

    def _path(self, x: int, y: int) -> list:
        path = []
        for depth, (w, _h) in enumerate(self.shapes):
            path.append((depth, y * w + x))
            x //= 2
            y //= 2
        return path[::-1]

    def decode(self, bits: _HeaderReader, x: int, y: int, threshold: int) -> bool:
        low = 0
        depth = index = 0
        for depth, index in self._path(x, y):
            low = max(low, self.low[depth][index])
            while low < threshold and low < self.value[depth][index]:
                if bits.bit():
                    self.value[depth][index] = low
                else:
                    low += 1
            self.low[depth][index] = low
        return self.value[depth][index] < threshold

    def encode(self, out: _HeaderWriter, x: int, y: int, threshold: int) -> None:
        low = 0
        for depth, index in self._path(x, y):
            low = max(low, self.low[depth][index])
            while low < threshold:
                if low >= self.value[depth][index]:
                    if not self.known[depth][index]:
                        out.bit(1)
                        self.known[depth][index] = True
                    break
                out.bit(0)
                low += 1
            self.low[depth][index] = low


def _read_passes(bits: _HeaderReader) -> int:
    """T.800 Table B.4."""
    if not bits.bit():
        return 1
    if not bits.bit():
        return 2
    value = bits.bits(2)
    if value != 3:
        return 3 + value
    value = bits.bits(5)
    if value != 31:
        return 6 + value
    return 37 + bits.bits(7)


def _write_passes(out: _HeaderWriter, count: int) -> None:
    if count == 1:
        out.bit(0)
    elif count == 2:
        out.bits(0b10, 2)
    elif count <= 5:
        out.bits(0b11, 2)
        out.bits(count - 3, 2)
    elif count <= 36:
        out.bits(0b1111, 4)
        out.bits(count - 6, 5)
    else:
        out.bits(0b111111111, 9)
        out.bits(count - 37, 7)


def _block_grids(width: int, height: int, levels: int) -> list:
    """Per resolution, the code-block grid `(wide, high)` of each subband in
    packet order: LL, then HL, LH, HH (T.800 B.5 with the origin at 0, one
    tile, one precinct per resolution)."""
    side = 1 << _JPX_BLOCK_EXP
    out = []
    for resolution in range(levels + 1):
        if resolution == 0:
            scale = 1 << levels
            sizes = [(-(-width // scale), -(-height // scale))]
        else:
            scale = 1 << (levels - resolution + 1)
            half = scale >> 1
            low_w, low_h = -(-width // scale), -(-height // scale)
            high_w, high_h = -(-(width - half) // scale), -(-(height - half) // scale)
            sizes = [(high_w, low_h), (low_w, high_h), (high_w, high_h)]
        out.append([(-(-w // side), -(-h // side)) for w, h in sizes])
    return out


def _read_component_packets(tile: bytes, grids: list) -> list:
    """Every packet of a one-component, one-layer tile in resolution order:
    `(blocks, body)`, where `blocks` holds per subband one entry per
    code-block — None when it is left out, else `(zero_planes, passes,
    lblock, length)`."""
    pos = 0
    packets = []
    for bands in grids:
        bits = _HeaderReader(tile, pos)
        blocks: list = []
        if bits.bit():
            for wide, high in bands:
                inclusion, zero = _TagTree(wide, high), _TagTree(wide, high)
                band: list = []
                for k in range(wide * high):
                    x, y = k % wide, k // wide
                    if not inclusion.decode(bits, x, y, 1):
                        band.append(None)
                        continue
                    threshold = 0
                    while not zero.decode(bits, x, y, threshold):
                        threshold += 1
                    passes = _read_passes(bits)
                    lblock = 3
                    while bits.bit():
                        lblock += 1
                    length = bits.bits(lblock + passes.bit_length() - 1)
                    band.append((threshold - 1, passes, lblock, length))
                blocks.append(band)
        else:
            blocks = [[None] * (wide * high) for wide, high in bands]
        pos = bits.end()
        size = sum(block[3] for band in blocks for block in band if block)
        packets.append((blocks, tile[pos : pos + size]))
        pos += size
    if pos != len(tile):
        raise _Unassembled("a tile holds data after its last packet")
    return packets


def _write_packet_header(blocks: list, bands: list, drop_planes: int) -> bytes:
    """The packet header for `blocks`, each zero-bit-plane count lowered by
    `drop_planes`; every other field is written as it was read."""
    out = _HeaderWriter()
    if not any(block for band in blocks for block in band):
        out.bit(0)
        return out.finish()
    out.bit(1)
    for band, (wide, high) in zip(blocks, bands):
        unused = 1 << 20
        zeros = []
        for block in band:
            if block is None:
                zeros.append(unused)
            elif block[0] < drop_planes:
                raise _Unassembled("a code-block holds more bit-planes than an 8-bit layer carries")
            else:
                zeros.append(block[0] - drop_planes)
        inclusion = _TagTree(wide, high, [0 if block else 1 for block in band])
        zero = _TagTree(wide, high, zeros)
        for k, block in enumerate(band):
            x, y = k % wide, k // wide
            inclusion.encode(out, x, y, 1)
            if block is None:
                continue
            _zero_planes, passes, lblock, length = block
            zero.encode(out, x, y, unused)
            _write_passes(out, passes)
            out.bits((1 << (lblock - 3)) - 1, lblock - 3)
            out.bit(0)
            out.bits(length, lblock + passes.bit_length() - 1)
    return out.finish()


def _quantization_segment(levels: int, depth: int) -> bytes:
    """QCD for reversible coding (T.800 A.6.4): no quantization, one exponent
    per subband equal to the sample depth plus the subband's gain."""
    exponents = [depth] + [depth + gain for _ in range(levels) for gain in (1, 1, 2)]
    return bytes([_JPX_GUARD_BITS << 5]) + bytes(e << 3 for e in exponents)


def _component_packets(plane: np.ndarray, offset: int, levels: int, grids: list) -> list:
    """One component coded alone, losslessly, as 16-bit samples.

    The quantized components leave the 8-bit sample range wherever the
    quantization overshoots, and an 8-bit coder given the clipped samples
    would code the clipping too — in every subband around each clipped
    sample. A 16-bit carrier holds them unclipped; `offset` moves the
    component onto the carrier so that its DC level shift (T.800 G.1) leaves
    exactly what an 8-bit codestream's shift would.
    """
    samples = plane + offset
    if samples.min() < 0 or samples.max() > 0xFFFF:
        raise _Unassembled("a component left its 16-bit carrier")
    height, width = plane.shape
    buf = io.BytesIO()
    Image.frombytes("I;16", (width, height), samples.astype("<u2").tobytes()).save(
        buf, format="JPEG2000", irreversible=False, num_resolutions=levels + 1, no_jp2=True
    )
    codestream = buf.getvalue()
    markers: dict = {}
    pos = 2
    while True:
        marker, length = struct.unpack(">HH", codestream[pos : pos + 4])
        if marker == 0xFF90:
            break
        markers[marker] = codestream[pos + 4 : pos + 2 + length]
        pos += 2 + length
    coding = markers.get(0xFF52, b"")
    expected = bytes([0, 0, 0, 1, 0, levels, _JPX_BLOCK_EXP - 2, _JPX_BLOCK_EXP - 2, 0, 1])
    if coding != expected or markers.get(0xFF5C) != _quantization_segment(levels, 16):
        raise _Unassembled("the encoder wrote an unexpected coding style")
    part_length = struct.unpack(">I", codestream[pos + 6 : pos + 10])[0]
    data = pos + 14
    if codestream[data - 2 : data] != b"\xff\x93" or pos + part_length != len(codestream) - 2:
        raise _Unassembled("the encoder wrote an unexpected tile layout")
    return _read_component_packets(codestream[data : pos + part_length], grids)


def _codestream(components: list, width: int, height: int, levels: int) -> bytes:
    """One 8-bit, three-component codestream carrying `components` (the RCT
    signalled, T.800 A.6.1) with every packet's code-block data kept byte
    for byte from the one-component codestreams."""
    grids = _block_grids(width, height, levels)
    packets = [
        _component_packets(plane, 0x8000 - (0x80 if index == 0 else 0), levels, grids)
        for index, plane in enumerate(components)
    ]
    size = struct.pack(">HIIIIIIIIH", 0, width, height, 0, 0, width, height, 0, 0, 3)
    size += bytes([7, 1, 1]) * 3
    coding = bytes([0, 0, 0, 1, 1, levels, _JPX_BLOCK_EXP - 2, _JPX_BLOCK_EXP - 2, 0, 1])
    body = bytearray()
    for resolution, bands in enumerate(grids):
        for component in packets:
            blocks, data = component[resolution]
            # The 16-bit carrier's QCD gives every subband 16 - 8 more
            # magnitude bit-planes than this codestream's 8-bit QCD.
            body += _write_packet_header(blocks, bands, 16 - 8)
            body += data
    out = bytearray(b"\xff\x4f")
    for marker, payload in (
        (0xFF51, size),
        (0xFF52, coding),
        (0xFF5C, _quantization_segment(levels, 8)),
    ):
        out += struct.pack(">HH", marker, len(payload) + 2) + payload
    out += struct.pack(">HHHIBB", 0xFF90, 10, 0, 14 + len(body), 0, 1)
    out += b"\xff\x93" + body + b"\xff\xd9"
    return bytes(out)


def _jp2(codestream: bytes, width: int, height: int) -> bytes:
    """The JP2 file (ISO/IEC 15444-1 Annex I): three 8-bit sRGB components."""

    def box(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", 8 + len(payload)) + kind + payload

    header = box(b"ihdr", struct.pack(">IIHBBBB", height, width, 3, 7, 7, 0, 0))
    header += box(b"colr", struct.pack(">BBBI", 1, 0, 0, 16))
    return (
        box(b"jP  ", b"\r\n\x87\n")
        + box(b"ftyp", b"jp2 " + bytes(4) + b"jp2 ")
        + box(b"jp2h", header)
        + box(b"jp2c", codestream)
    )


def encode_layer_jpx(image: Image.Image, step: float, levels: int) -> bytes:
    """`/JPXDecode` bytes for the background layer, at FIXED quality.

    Every wavelet coefficient is quantized on its own value with a step fixed
    per subband (`_quantized_components`), and the codestream codes every
    pass of every code-block. Nothing is cut to meet a size, so a decoded
    pixel depends on the layer only through the 5/3 filter's reach, and a
    partial redaction keeps the rest of the layer exactly. A rate target
    cannot give that: its truncation threshold is chosen for the whole
    picture, so every pixel depends on the content under any mark.

    The quantized coefficients are coded as they are, through the same RCT
    and 5/3 transform: every reader rebuilds exactly the quantized
    components and clips them to 0..255 itself (`jpx_reconstruction`). The
    codestream is decoded back before it is returned, and one that does not
    decode to that reconstruction raises.

    A larger `step` is a smaller file; `levels` bounds the reach
    (`JPX_MAX_LEVELS`).
    """
    levels, components = _quantized_components(image, step, levels)
    width, height = image.size
    try:
        data = _jp2(_codestream(components, width, height, levels), width, height)
        with Image.open(io.BytesIO(data)) as decoded:
            if decoded.mode != "RGB" or not np.array_equal(np.asarray(decoded), _to_rgb(components)):
                raise _Unassembled("the codestream does not decode to its reconstruction")
    except _Unassembled as exc:
        raise RuntimeError("the JPEG 2000 background could not be encoded exactly") from exc
    return data


# --------------------------------------------------------------------------
# Verification — rule 2, as production code
# --------------------------------------------------------------------------
def build_stencil_pdf(stream: MaskStream, dest: str | Path) -> None:
    """A one-page PDF drawing `stream` as a black stencil on white.

    This is the same dictionary `engine/mrc.py` embeds, which is the point:
    verifying the CODESTREAM would miss a wrong `/Decode` array, and `/Decode`
    is precisely where the polarity bugs live.
    """
    import pikepdf  # local: keeps this module importable without a Pdf engine

    pdf = pikepdf.Pdf.new()
    st = pikepdf.Stream(pdf, stream.data)
    st["/Type"] = pikepdf.Name("/XObject")
    st["/Subtype"] = pikepdf.Name("/Image")
    st["/Width"] = stream.width
    st["/Height"] = stream.height
    st["/ImageMask"] = True
    st["/Filter"] = pikepdf.Name(
        "/CCITTFaxDecode" if stream.codec == CCITT_G4 else "/JBIG2Decode"
    )
    if stream.decode is not None:
        st["/Decode"] = pikepdf.Array(list(stream.decode))
    parms: dict[str, object] = dict(stream.decode_parms or {})
    if stream.globals_data is not None:
        parms["JBIG2Globals"] = pdf.make_indirect(pikepdf.Stream(pdf, stream.globals_data))
    if parms:
        st["/DecodeParms"] = pikepdf.Dictionary(**parms)
    xobj = pdf.make_indirect(st)

    # One point per pixel, so a 72-dpi render is exactly 1:1 and the coverage
    # comparison needs no resampling allowance.
    w, h = stream.width, stream.height
    content = (
        f"q 1 1 1 rg 0 0 {w} {h} re f Q\n"
        f"q 0 g {w} 0 0 {h} 0 0 cm /Im0 Do Q"
    ).encode()
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, w, h],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=xobj)),
        Contents=pdf.make_stream(content),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    save_pdf(pdf, str(dest))


def verify_mask_stream(
    stream: MaskStream,
    gs_path: str,
    tolerance: float = VERIFY_TOLERANCE,
) -> float:
    """Decode the embedded stencil back and return its measured ink coverage.

    Raises when the coverage misses `stream.ink_fraction` by more than
    `tolerance`. Both failure modes are invisible to any check weaker than this:
    a multi-strip G4 stream renders as a plausible eroded page, and an inverted
    stencil renders as a solid black one that OCR still returns words from.

    Ghostscript is used deliberately rather than the library that did the
    encoding — an INDEPENDENT decoder (jbig2dec / its own CCITT arm) is what
    makes this a round trip rather than a restatement.
    """
    with tempfile.TemporaryDirectory(prefix="spectrapdf_maskverify_") as work:
        wd = Path(work)
        pdf = wd / "stencil.pdf"
        png = wd / "stencil.png"
        build_stencil_pdf(stream, pdf)
        # `budget.gs`, not `budget.run`: the decoder has to be a WORKING
        # Ghostscript, and an existence check said yes to a file that cannot
        # initialise — which would have failed here as an opaque decode error
        # and read as a bad stencil. The budget is the same one the
        # `budget.for_file` call derived; `text=False` keeps stderr as bytes
        # for the decode below.
        result = budget.gs(
            [
                str(gs_path), "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
                "-sDEVICE=pnggray", "-r72", f"-sOutputFile={png}", str(pdf),
            ],
            what="Ghostscript (mask verification)",
            path=pdf,
            pages=1,
            base=60.0,
            per_mb=30.0,
            per_page=0.0,
            text=False,
        )
        if result.returncode != 0 or not png.is_file():
            detail = (result.stderr or b"").decode("utf-8", "replace").strip()
            raise RuntimeError(f"mask verification could not decode the stencil: {detail}")
        with Image.open(png) as decoded:
            got = mask_ink_fraction(decoded)

    if abs(got - stream.ink_fraction) > tolerance:
        raise RuntimeError(
            f"mask verification failed: the embedded {stream.codec} stencil decodes to "
            f"{got:.4f} ink coverage, the mask it came from has {stream.ink_fraction:.4f}."
        )
    return got
