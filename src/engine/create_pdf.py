"""Create a PDF from a source that is not one (P22, brief 41).

Slice A: the IMAGE arm, promoted out of `batch_ocr` and fixed. The other arms
(LibreOffice, Ghostscript's distill, blank) join it here in later slices; this
module is already the single place an image becomes a page, so batch OCR and
the user-facing Create PDF cannot drift apart.

Why the image route is OURS and not LibreOffice's: measured (brief 41 § 1.2),
LibreOffice puts a 200-dpi PNG, a 150-dpi JPEG and a 300-dpi TIFF all on one
612x792 Letter page. It is not DPI-honest, and DPI honesty is the whole point —
a 300-dpi scan must become a Letter page, not a 25-inch one.

Four rules here, each MEASURED (`p22-image-probe{,2}.local.py` and their logs):

1. **The page is sized from the image's own stored DPI**, falling back to
   `dpi_default`. Pillow's PDF plugin IGNORES `im.info["dpi"]` — only the
   `resolution=` keyword sizes the page — so the DPI is read here and passed.
2. **Every frame is a page.** `im.save(..., "PDF")` without `save_all` writes
   the FIRST frame and silently discards the rest: a 3-frame TIFF came out as
   1 page. Multi-page TIFF is the normal shape of a fax or a departmental
   scanner's output, so that was silent data loss in shipped batch OCR.
3. **Frames are saved SEPARATELY and concatenated**, never through
   `save_all=True, append_images=[...]`. Two measured reasons: `save_all`
   applies ONE resolution to every frame (a 150-dpi second frame was sized at
   the first frame's 300 dpi), and Pillow LEAKS `encoderinfo` onto an
   append_images member — a later `save(..., resolution=150)` on that same
   object silently reused the stale 300. Concatenation is `add_pages_from`,
   never a bare `extend` (the structural-page-ops invariant).
4. **Normalisation is measured, not guessed.** The PDF plugin takes `1`
   (CCITT G4 — what a bilevel fax should stay), `L`, `RGB` and `CMYK`
   (DCTDecode) directly; it REFUSES `I`, `I;16`, `F` and `PA`; and it writes
   `P` as an ASCIIHex-encoded /Indexed image 23x larger than the same picture
   as RGB. Alpha is composited onto WHITE, because a bare `convert("RGB")` on
   a fully transparent red pixel yields opaque RED.
"""

from __future__ import annotations

import io
import math
from contextlib import ExitStack
from pathlib import Path

import pikepdf

# The accepted raster set. Widened past batch OCR's original png/jpg/tif/bmp:
# WEBP, JPEG 2000 and AVIF are decodable by the BUNDLED Pillow already (a
# measured `features.check`), GIF is ordinary, and HEIC/HEIF arrive with the
# vendored pillow-heif plugin. HEIC is the default camera format on the phones
# users photograph documents with, so its absence was a real hole.
IMAGE_SUFFIXES = (
    ".png",
    ".jpg",
    ".jpeg",
    ".jpe",
    ".tif",
    ".tiff",
    ".bmp",
    ".dib",
    ".gif",
    ".webp",
    ".jp2",
    ".j2k",
    ".j2c",
    ".jpc",
    ".jpf",
    ".jpx",
    ".avif",
    ".heic",
    ".heif",
)

# Handled by the plugin rather than by Pillow itself, so their absence is a
# NAMED refusal — never a silent skip of somebody's photograph.
HEIF_SUFFIXES = (".heic", ".heif")

# Modes the PDF plugin encodes directly, measured. `1` stays `1` deliberately:
# it lands as CCITTFaxDecode, which is what a bilevel fax page should be.
_DIRECT_MODES = ("1", "L", "RGB", "CMYK")

# Integer/float sample modes the plugin refuses outright.
_WIDE_MODES = ("I", "I;16", "I;16B", "I;16L", "I;16N", "F")

_heif_registered: bool | None = None


def accepted_image_suffixes() -> tuple[str, ...]:
    """The raster extensions this arm accepts (for pickers, CLI help, refusals)."""
    return IMAGE_SUFFIXES


def is_image(path: str | Path) -> bool:
    return Path(path).suffix.lower() in IMAGE_SUFFIXES


def _register_heif() -> bool:
    """Register the HEIF decoder once. False when the plugin is not provisioned."""
    global _heif_registered
    if _heif_registered is None:
        try:
            import pillow_heif  # noqa: PLC0415

            pillow_heif.register_heif_opener()
            _heif_registered = True
        except Exception:  # noqa: BLE001 - any import/registration failure is "absent"
            _heif_registered = False
    return _heif_registered


def _resolution(info: dict, dpi_default: float) -> float:
    """The image's own stored DPI, or the default.

    A stored value of 0 (TIFF's "unset") or 1 is not a resolution — it is a
    placeholder, and honouring it would produce a page metres across.
    """
    dpi = (info or {}).get("dpi")
    try:
        value = float(dpi[0])  # type: ignore[index]
    except (TypeError, ValueError, IndexError):
        return float(dpi_default)
    if not math.isfinite(value) or value <= 1.0:
        return float(dpi_default)
    return value


def _normalise(frame):
    """One frame in a mode the PDF plugin encodes well (see rule 4 above)."""
    from PIL import Image  # noqa: PLC0415

    mode = frame.mode
    if mode in _DIRECT_MODES:
        return frame
    if mode in _WIDE_MODES:
        # A direct convert("L") CLIPS at 255 — a 16-bit scan would come back
        # almost entirely white (measured: 10000 -> 255). Scale instead.
        return frame.convert("I").point(lambda v: v * (1 / 256)).convert("L")
    if mode == "P" and "transparency" not in frame.info:
        # /Indexed + ASCIIHexDecode measured 23x the size of the same picture
        # as RGB, for no fidelity gain.
        return frame.convert("RGB")
    if mode == "LA":
        base = Image.new("L", frame.size, 255)
        base.paste(frame.convert("L"), mask=frame.getchannel("A"))
        return base
    if mode in ("RGBA", "PA", "P") or "A" in frame.getbands():
        rgba = frame.convert("RGBA")
        base = Image.new("RGB", rgba.size, (255, 255, 255))
        base.paste(rgba, mask=rgba.getchannel("A"))
        return base
    return frame.convert("RGB")


def _frame_pdf(frame, resolution: float) -> bytes:
    """One normalised frame as a one-page PDF, sized by `resolution`.

    The frame object is saved EXACTLY ONCE and never reused — Pillow merges
    into a stale `encoderinfo` and the stale value wins (measured), so a reused
    image silently carries a previous call's resolution.
    """
    buf = io.BytesIO()
    frame.save(buf, "PDF", resolution=resolution)
    return buf.getvalue()


def image_to_pdf(src: str | Path, dest: str | Path, *, dpi_default: float = 200.0) -> dict:
    """Wrap ONE image file into a PDF — every frame a page, at its own size.

    Args:
        src: the image file.
        dest: the PDF to write.
        dpi_default: the resolution assumed when the image stores none.

    Returns a report: pages, the per-page DPI actually used, and the first
    page's size in points.
    """
    from PIL import Image, ImageSequence, UnidentifiedImageError  # noqa: PLC0415

    src_path = Path(src)
    dest_path = Path(dest)
    try:
        default = float(dpi_default)
    except (TypeError, ValueError):
        raise ValueError("the image DPI default must be a positive number") from None
    if not math.isfinite(default) or default <= 0:
        raise ValueError("the image DPI default must be a positive number")

    if not src_path.is_file():
        raise ValueError(f"image file not found: {src_path}")
    # A zero-byte source is refused BEFORE any decoder sees it — the same rule
    # the LibreOffice arm needs, where an empty .docx converts "successfully".
    if src_path.stat().st_size == 0:
        raise ValueError(f"the image file is empty: {src_path}")
    if src_path.suffix.lower() in HEIF_SUFFIXES and not _register_heif():
        raise RuntimeError(
            f"HEIC/HEIF images need the pillow-heif plugin, which this runtime "
            f"does not have: {src_path}"
        )
    # Registering unconditionally costs nothing and lets a .heic that arrived
    # under a wrong extension still decode.
    _register_heif()

    parts: list[bytes] = []
    sizes: list[tuple[float, float]] = []
    resolutions: list[float] = []
    try:
        with Image.open(src_path) as im:
            for raw in ImageSequence.Iterator(im):
                resolution = _resolution(raw.info or im.info, default)
                frame = _normalise(raw.copy())
                parts.append(_frame_pdf(frame, resolution))
                resolutions.append(resolution)
                sizes.append(
                    (
                        frame.size[0] * 72.0 / resolution,
                        frame.size[1] * 72.0 / resolution,
                    )
                )
    except UnidentifiedImageError as exc:
        raise ValueError(f"unreadable image: {src_path} ({exc})") from None
    except (OSError, ValueError) as exc:
        # Pillow raises OSError for a truncated frame mid-sequence; a partial
        # page set is not a success, so the whole source refuses.
        raise ValueError(f"unreadable image: {src_path} ({exc})") from None

    if not parts:
        raise ValueError(f"the image contains no frames: {src_path}")

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    if len(parts) == 1:
        dest_path.write_bytes(parts[0])
    else:
        merged = pikepdf.Pdf.new()
        with ExitStack() as stack:
            for data in parts:
                page_pdf = stack.enter_context(pikepdf.open(io.BytesIO(data)))
                # add_pages_from, never `pages.extend` — the structural-page-ops
                # invariant holds even where no source can carry a form, because
                # the exception is what erodes.
                merged.add_pages_from(page_pdf)
            merged.save(str(dest_path))

    return {
        "output": str(dest_path),
        "pages": len(parts),
        "dpi": [round(r, 2) for r in resolutions],
        "page_size": [round(sizes[0][0], 2), round(sizes[0][1], 2)],
    }
