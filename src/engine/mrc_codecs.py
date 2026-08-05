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
"""

from __future__ import annotations

import io
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from PIL import Image
from PIL.TiffImagePlugin import ROWSPERSTRIP

from . import budget

# The mask codecs, in the order the presets prefer them.
JBIG2_SYMBOL = "jbig2_symbol"
JBIG2_GENERIC = "jbig2_generic"
CCITT_G4 = "ccitt_g4"
MASK_CODECS = (JBIG2_SYMBOL, JBIG2_GENERIC, CCITT_G4)

# jbig2enc's own default classification threshold. Exposed because Archival
# never uses symbol mode at all and Smallest wants it looser.
DEFAULT_SYMBOL_THRESHOLD = 0.92
#: jbig2enc's own accepted range for `-t`. A value outside it is refused by
#: the encoder with a message about a flag our callers never wrote, so the
#: range is restated here and refused in OUR words.
MIN_SYMBOL_THRESHOLD, MAX_SYMBOL_THRESHOLD = 0.40, 0.97

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

    pixels = sum(m.width * m.height for m in masks)
    # Derived, not fixed (§ 5.5): the encoder's work is proportional to pixel
    # count, and a 600-dpi multi-page scan is the case the feature exists for.
    # ~4 MB of 1-bit samples per megapixel-page is the scale, so the budget is
    # expressed against the uncompressed bitmap size.
    bitmap_bytes = pixels // 8
    allowed = budget.derive(
        base=60.0, size_bytes=bitmap_bytes, pages=len(masks), per_mb=20.0, per_page=15.0
    )

    with tempfile.TemporaryDirectory(prefix="spectrapdf_jbig2_") as work:
        wd = Path(work)
        inputs = []
        for i, mask in enumerate(masks):
            png = wd / f"p{i:04d}.png"
            mask.save(png, format="PNG")
            inputs.append(png)

        if mode == JBIG2_SYMBOL:
            streams = _run_symbol(exe, wd, inputs, symbol_threshold, allowed, bitmap_bytes)
        else:
            streams = _run_generic(exe, wd, inputs, allowed, bitmap_bytes)

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
    exe: str, wd: Path, inputs: list[Path], allowed: float, bitmap_bytes: int
) -> list[tuple[bytes, bytes | None]]:
    """One invocation per page; the embedded stream arrives on stdout.

    `-p` is PDF-ready output (embedded segment format, no file header). `-r`
    is never passed — rule 3.
    """
    out: list[tuple[bytes, bytes | None]] = []
    for i, png in enumerate(inputs):
        result = budget.run(
            [exe, "-p", str(png)],
            what="The JBIG2 encoder",
            budget=allowed,
            size_bytes=bitmap_bytes,
            pages=len(inputs),
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


def encode_mask(
    masks: list[Image.Image],
    *,
    codec: str,
    jbig2_path: str = "",
    symbol_threshold: float = DEFAULT_SYMBOL_THRESHOLD,
    allow_fallback: bool = True,
) -> tuple[list[MaskStream], str]:
    """Encode a document's stencils with `codec`, reporting what actually ran.

    A missing vendored encoder is a PROVISIONING fault, not a document fault,
    so with `allow_fallback` the mask falls back to CCITT G4 — but the returned
    codec name says so, because a silent swap would make the size claim untrue.
    When the caller asked for a codec BY NAME (`allow_fallback=False`) it
    refuses instead of substituting.
    """
    if codec not in MASK_CODECS:
        raise ValueError(f"unknown mask codec: {codec} (expected one of {', '.join(MASK_CODECS)})")
    if codec == CCITT_G4:
        return [encode_mask_ccitt_g4(m) for m in masks], CCITT_G4
    if not jbig2_available(jbig2_path):
        if not allow_fallback:
            _require_jbig2(jbig2_path)  # raises the named refusal
        return [encode_mask_ccitt_g4(m) for m in masks], CCITT_G4
    return (
        encode_masks_jbig2(
            masks, mode=codec, jbig2_path=jbig2_path, symbol_threshold=symbol_threshold
        ),
        codec,
    )


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


def encode_layer_jpx(image: Image.Image, rate: int = 60) -> bytes:
    """`/JPXDecode` bytes for the background layer.

    `rate` is a JPEG2000 compression RATIO (Pillow's `quality_layers` under
    `quality_mode="rates"`), so a larger number is a smaller file — the
    opposite sense to JPEG quality, which is why the parameter is not named
    `quality`.
    """
    if rate < 1:
        raise ValueError(f"a JPEG2000 rate must be >= 1, got {rate}")
    buf = io.BytesIO()
    image.convert("RGB").save(
        buf, format="JPEG2000", quality_mode="rates", quality_layers=[rate]
    )
    return buf.getvalue()


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
    pdf.save(str(dest))


def verify_mask_stream(
    stream: MaskStream,
    gs_path: str,
    tolerance: float = VERIFY_TOLERANCE,
) -> float:
    """Decode the embedded stencil back and return its measured ink coverage.

    Raises when the coverage misses `stream.ink_fraction` by more than
    `tolerance`. Both § 1.6 rules are invisible to any check weaker than this:
    a multi-strip G4 stream renders as a plausible eroded page, and an inverted
    stencil renders as a solid black one that OCR still returns words from.

    Ghostscript is used deliberately rather than the library that did the
    encoding — an INDEPENDENT decoder (jbig2dec / its own CCITT arm) is what
    makes this a round trip rather than a restatement.
    """
    if not gs_path or not os.path.isfile(gs_path):
        raise RuntimeError(
            f"Ghostscript is not available at {gs_path or '(no path given)'} — a mask "
            "stream cannot be decoded back, and an unverified stencil is not shippable."
        )

    with tempfile.TemporaryDirectory(prefix="spectrapdf_maskverify_") as work:
        wd = Path(work)
        pdf = wd / "stencil.pdf"
        png = wd / "stencil.png"
        build_stencil_pdf(stream, pdf)
        allowed = budget.for_file(pdf, base=60.0, pages=1, per_mb=30.0)
        result = budget.run(
            [
                str(gs_path), "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
                "-sDEVICE=pnggray", "-r72", f"-sOutputFile={png}", str(pdf),
            ],
            what="Ghostscript (mask verification)",
            budget=allowed,
            size_bytes=pdf.stat().st_size,
            pages=1,
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
