"""Deterministic HEIC/HEIF decode corpus for the image arm of Create PDF.

Run it to regenerate; the resulting files are CHECKED IN beside it under
`heif/` so a regeneration is reviewable as a git diff.

    .venv/Scripts/python.exe tests/fixtures/make_heif_corpus.py

The generator needs a HEIF **encoder**, which the shipped runtime does not
have and is not meant to have — the product decodes HEIF and never writes it.
Any Python with `pillow-heif` installed (the encoder-carrying distribution)
regenerates the set; the shipped runtime then only ever reads it. That
asymmetry is the point of checking the files in: the corpus outlives whichever
encoder produced it.

Every fixture is a synthetic gradient computed here, so nothing in the tree
carries third-party image provenance.

What each file is for — each row is a container or pixel shape the decode path
can get wrong, and all of them reach `engine.create_pdf.image_to_pdf`:

  rgb8            baseline 8-bit 4:2:0 RGB — the control
  rgb8-chroma444  4:4:4 subsampling, a different plane layout
  gray8           monochrome, one plane — must stay `L`, not become RGB
  rgb10           10-bit HDR RGB — the decoder tone-maps to 8 bits per sample
  gray10          10-bit monochrome, the one-plane form of the same
  rgba8           an alpha channel, which the PDF arm composites onto white
  exif-orient6    EXIF orientation 6; libheif applies the rotation at decode,
                  so the decoded size is TRANSPOSED against the stored one
  multi-3         three top-level images — three PDF pages, at three sizes
  multi-primary1  three images where the PRIMARY is the second one stored;
                  the primary must come out first, so page 1 is 100x100
  grid-tiled      a grid-derived image built from 128px tiles, the container
                  shape phone cameras write for full-resolution stills
  thumbnail       carries an embedded thumbnail, which must NOT become a page
  odd-dims        29x100 — odd width against 4:2:0's even-sized chroma plane
  lossless        quality=-1, the lossless encoder path
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

import pillow_heif

OUT = Path(__file__).resolve().parent / "heif"

# The x265 encoder is deterministic for a fixed input, preset and quality, so
# a regeneration on the same encoder version reproduces the same bytes.
QUALITY = 90


def _gradient(w: int, h: int, mode: str) -> Image.Image:
    """A per-pixel ramp — no noise, no dither, identical on every run."""
    im = Image.new(mode, (w, h))
    px = im.load()
    span_x = max(w - 1, 1)
    span_y = max(h - 1, 1)
    for y in range(h):
        for x in range(w):
            r = x * 255 // span_x
            g = y * 255 // span_y
            if mode == "RGB":
                px[x, y] = (r, g, (r + g) // 2)
            elif mode == "RGBA":
                px[x, y] = (r, g, (r + g) // 2, (r + g) // 2)
            else:  # "L"
                px[x, y] = (r + g) // 2
    return im


def _gradient16(w: int, h: int) -> bytes:
    """The same ramp at 16 bits per sample, little-endian, for the HDR path."""
    span_x = max(w - 1, 1)
    span_y = max(h - 1, 1)
    out = bytearray()
    for y in range(h):
        for x in range(w):
            r = x * 65535 // span_x
            g = y * 65535 // span_y
            b = (r + g) // 2
            out += r.to_bytes(2, "little") + g.to_bytes(2, "little") + b.to_bytes(2, "little")
    return bytes(out)


def _gradient16_l(w: int, h: int) -> bytes:
    span_x = max(w - 1, 1)
    span_y = max(h - 1, 1)
    out = bytearray()
    for y in range(h):
        for x in range(w):
            v = (x * 65535 // span_x + y * 65535 // span_y) // 2
            out += v.to_bytes(2, "little")
    return bytes(out)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    _gradient(160, 120, "RGB").save(OUT / "rgb8.heic", format="HEIF", quality=QUALITY)
    _gradient(160, 120, "RGB").save(
        OUT / "rgb8-chroma444.heic", format="HEIF", quality=QUALITY, chroma=444
    )
    _gradient(160, 120, "L").save(OUT / "gray8.heic", format="HEIF", quality=QUALITY)
    _gradient(160, 120, "RGBA").save(OUT / "rgba8.heic", format="HEIF", quality=QUALITY)
    _gradient(29, 100, "RGB").save(OUT / "odd-dims.heic", format="HEIF", quality=QUALITY)
    # quality=-1 is pillow-heif's lossless switch, not a quality of minus one.
    _gradient(160, 120, "RGB").save(OUT / "lossless.heic", format="HEIF", quality=-1)

    # EXIF orientation 6 (rotate 90 CW for display). libheif turns the tag into
    # an `irot` transform, so the decoded raster is already upright.
    exif = Image.Exif()
    exif[0x0112] = 6
    _gradient(160, 120, "RGB").save(
        OUT / "exif-orient6.heic", format="HEIF", quality=QUALITY, exif=exif.tobytes()
    )

    extras = [_gradient(100, 100, "RGB"), _gradient(80, 60, "RGBA")]
    _gradient(160, 120, "RGB").save(
        OUT / "multi-3.heic",
        format="HEIF",
        quality=QUALITY,
        save_all=True,
        append_images=extras,
    )
    _gradient(160, 120, "RGB").save(
        OUT / "multi-primary1.heic",
        format="HEIF",
        quality=QUALITY,
        save_all=True,
        primary_index=1,
        append_images=extras,
    )

    # 10-bit. The encoder picks its output depth from the SOURCE mode: a
    # 16-bit-per-sample plane with SAVE_HDR_TO_12_BIT off encodes at 10 bits.
    # Pillow has no 16-bit RGB mode, so the planes are handed over as raw bytes.
    assert not pillow_heif.options.SAVE_HDR_TO_12_BIT
    hdr = pillow_heif.HeifFile()
    hdr.add_frombytes("RGB;16", (160, 120), _gradient16(160, 120))
    hdr.save(OUT / "rgb10.heic", quality=QUALITY)

    hdr_l = pillow_heif.HeifFile()
    hdr_l.add_frombytes("L;16", (160, 120), _gradient16_l(160, 120))
    hdr_l.save(OUT / "gray10.heic", quality=QUALITY)

    # An embedded thumbnail. It is an auxiliary item, never a top-level image,
    # so the page count must not move.
    thumbed = pillow_heif.from_pillow(_gradient(320, 240, "RGB"))
    thumbed.save(OUT / "thumbnail.heic", quality=QUALITY, thumbnails=[128])

    # A grid-derived image: the full picture is stored as 128x128 tiles that a
    # `grid` item stitches back together. This is the container shape phone
    # cameras write, and it is the one shape a naive reader gets wrong by
    # returning a single tile.
    previous_tile = pillow_heif.options.GRID_TILE_SIZE
    pillow_heif.options.GRID_TILE_SIZE = 128
    try:
        _gradient(512, 384, "RGB").save(
            OUT / "grid-tiled.heic", format="HEIF", quality=QUALITY
        )
    finally:
        pillow_heif.options.GRID_TILE_SIZE = previous_tile

    for path in sorted(OUT.iterdir()):
        print(f"{path.stat().st_size:8d}  {path.name}")


if __name__ == "__main__":
    pillow_heif.register_heif_opener()
    main()
