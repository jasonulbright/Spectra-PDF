"""Partial-region redaction of a placed image.

A page that is one scanned image used to lose the WHOLE image — a blank page
reported as a success — the moment a few lines of it were marked. These tests
hold the pixel-level contract that replaced it: the marked pixels are gone
from the saved bytes, every other pixel is untouched or, where the codec ties
it to the marked ones, destroyed too and reported; a whole-cover mark still
removes the object; placements do not leak into each other; a placement whose
geometry cannot be mapped exactly removes MORE rather than less; and a codec
that cannot be rewritten safely refuses by name without touching the input.

The lossy codecs are held by a differential: two inputs that differ only
under the mark must redact to the same bytes, so nothing that survives
depends on what was there.

Fixtures are the smallest input that proves the property; every pixel of a
lossless fixture carries a distinct value so a comparison names exactly which
pixels moved.
"""

from __future__ import annotations

import dataclasses
import io
import os
import struct
import subprocess
import zlib

import numpy as np
import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine import codec_taint, image_redact
from engine.redact import redact

W = 8
H = 8


# ── fixtures ──────────────────────────────────────────────────────────────


def _unique_rgb(width: int = W, height: int = H) -> bytes:
    """8-bit RGB where every pixel's red channel is its own (row, col)."""
    out = bytearray()
    for row in range(height):
        for col in range(width):
            out += bytes([row * 16 + col, 200, 100])
    return bytes(out)


def _unique_gray(width: int = W, height: int = H) -> bytes:
    return bytes(row * 16 + col for row in range(height) for col in range(width))


def _image_pdf(
    path: str,
    data: bytes,
    keys: dict,
    content: bytes = b"q 80 0 0 80 10 10 cm /Im0 Do Q",
    page_size=(100, 100),
    extra_images: dict | None = None,
) -> str:
    """A one-page PDF with `Im0` placed by `content`.

    The default placement maps the image onto (10,10)-(90,90), so at 8x8 one
    pixel is exactly 10 points and a region on a multiple of 10 lands on a
    pixel boundary.
    """
    doc = pikepdf.new()
    page = doc.add_blank_page(page_size=page_size)
    stream = doc.make_stream(data)
    stream["/Type"] = Name("/XObject")
    stream["/Subtype"] = Name("/Image")
    for key, value in keys.items():
        stream[key] = value
    xobjects = Dictionary(Im0=stream)
    for name, obj in (extra_images or {}).items():
        xobjects[name] = obj
    page.Resources = Dictionary(XObject=xobjects)
    page.Contents = doc.make_stream(content)
    doc.save(path)
    doc.close()
    return path


def _flate_rgb_pdf(path: str, data: bytes | None = None, **kwargs) -> str:
    return _image_pdf(
        path,
        zlib.compress(data if data is not None else _unique_rgb()),
        {
            "/Width": W,
            "/Height": H,
            "/ColorSpace": Name("/DeviceRGB"),
            "/BitsPerComponent": 8,
            "/Filter": Name("/FlateDecode"),
        },
        **kwargs,
    )


def _pixel_pdf(path: str, data: bytes, keys: dict, width: int, height: int) -> str:
    """The image drawn at one point per pixel from the page origin, so pixel
    (row, col) covers x in [col, col+1] and y in [height-row-1, height-row]."""
    return _image_pdf(
        path,
        data,
        keys,
        content=f"q {width} 0 0 {height} 0 0 cm /Im0 Do Q".encode("ascii"),
        page_size=(width, height),
    )


def _px_rect(col0: int, row0: int, col1: int, row1: int, height: int) -> list:
    """The page rectangle over pixel columns col0..col1 and rows row0..row1
    (exclusive ends) of an image placed by `_pixel_pdf`."""
    return [col0, height - row1, col1, height - row0]


def _g4_bits(width: int, height: int, black_box) -> tuple:
    """`(group-4 data, stored samples)` for a bilevel raster whose `black_box`
    rectangle is ink. Built through the imaging library's own TIFF writer, one
    strip, which is what a CCITT PDF stream is.

    The writer picks photometric 1, and the measured pairing for that is
    `/Decode [1 0]` with `/BlackIs1 false`: the samples the PDF filter yields
    are the COMPLEMENT of the bitmap that went in.
    """
    from PIL import Image
    from PIL.TiffImagePlugin import ROWSPERSTRIP

    mask = Image.new("1", (width, height), 1)
    x0, y0, x1, y1 = black_box
    for x in range(x0, x1):
        for y in range(y0, y1):
            mask.putpixel((x, y), 0)
    buffer = io.BytesIO()
    mask.save(buffer, format="TIFF", compression="group4", tiffinfo={ROWSPERSTRIP: height})
    tif = Image.open(io.BytesIO(buffer.getvalue()))
    offsets = tif.tag_v2[273]
    counts = tif.tag_v2[279]
    assert int(tif.tag_v2[262]) == 1, "the pairing below assumes photometric 1"
    buffer.seek(offsets[0])
    stored = bytes((~byte) & 0xFF for byte in mask.tobytes())
    return buffer.read(counts[0]), stored


def _jpeg(mode: str, width: int, height: int, paint, subsampling: int = 0, quality: int = 90) -> bytes:
    from PIL import Image

    image = Image.new(mode, (width, height))
    pixels = image.load()
    for row in range(height):
        for col in range(width):
            pixels[col, row] = paint(col, row)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=quality, subsampling=subsampling)
    return buffer.getvalue()


_JPEG_SPACES = {"L": "/DeviceGray", "RGB": "/DeviceRGB", "CMYK": "/DeviceCMYK"}


def _jpeg_keys(mode: str, width: int, height: int, filters=None) -> dict:
    keys = {
        "/Width": width,
        "/Height": height,
        "/ColorSpace": Name(_JPEG_SPACES[mode]),
        "/BitsPerComponent": 8,
        "/Filter": filters if filters is not None else Name("/DCTDecode"),
    }
    if mode == "CMYK":
        # The imaging library writes Adobe-style inverted CMYK.
        keys["/Decode"] = pikepdf.Array([1, 0, 1, 0, 1, 0, 1, 0])
    return keys


# ── readers ───────────────────────────────────────────────────────────────


def _only_image(path: str):
    """The single image XObject on page 1, as (name, decoded bytes, keys)."""
    with pikepdf.open(path) as pdf:
        xobjects = pdf.pages[0]["/Resources"]["/XObject"]
        images = [
            (str(key), xobjects[key])
            for key in xobjects.keys()
            if xobjects[key].get("/Subtype") == Name("/Image")
        ]
        assert len(images) == 1, f"expected one image, got {[n for n, _ in images]}"
        name, stream = images[0]
        return name, bytes(stream.read_bytes()), dict(stream.items())


def _only_image_raw(path: str):
    """`_only_image` without decoding the stream — for a codec qpdf cannot
    decode, where reading the samples is the decoder's job, not qpdf's."""
    with pikepdf.open(path) as pdf:
        xobjects = pdf.pages[0]["/Resources"]["/XObject"]
        images = [
            (str(key), xobjects[key])
            for key in xobjects.keys()
            if xobjects[key].get("/Subtype") == Name("/Image")
        ]
        assert len(images) == 1
        name, stream = images[0]
        return name, bytes(stream.read_raw_bytes()), dict(stream.items())


def _page_images(path: str) -> list:
    with pikepdf.open(path) as pdf:
        xobjects = pdf.pages[0].get("/Resources", Dictionary()).get("/XObject", Dictionary())
        return sorted(str(k) for k in xobjects.keys())


def _pixels(data: bytes, width: int, ncomp: int, bpc: int, height: int) -> list:
    return [
        [image_redact.read_packed(data, width, ncomp, bpc, row, col) for col in range(width)]
        for row in range(height)
    ]


def _contains_bytes(path: str, needle: bytes) -> bool:
    """Is `needle` anywhere in the file — in any stream, decoded or raw, or in
    the raw file bytes? An object that decodes cleanly is checked decoded; one
    that cannot be decoded cannot be allowed to hide a secret behind that."""
    raw = open(path, "rb").read()
    if needle in raw:
        return True
    with pikepdf.open(path) as pdf:
        for obj in pdf.objects:
            if not isinstance(obj, pikepdf.Stream):
                continue
            for reader in ("read_bytes", "read_raw_bytes"):
                try:
                    if needle in bytes(getattr(obj, reader)()):
                        return True
                    break
                except Exception:
                    continue
    return False


def _decoded(path: str, name: str | None = None):
    """The single image on page 1 decoded to an array, /Decode not applied."""
    from PIL import Image

    with pikepdf.open(path) as pdf:
        xobjects = pdf.pages[0]["/Resources"]["/XObject"]
        key = Name(name) if name else next(iter(xobjects.keys()))
        raw = bytes(xobjects[key].read_raw_bytes())
    with Image.open(io.BytesIO(raw)) as image:
        return np.asarray(image).astype(int)


def _source_decoded(data: bytes):
    from PIL import Image

    with Image.open(io.BytesIO(data)) as image:
        return np.asarray(image).astype(int)


# ── geometry ──────────────────────────────────────────────────────────────


class TestPixelSpans:
    def test_an_edge_on_a_pixel_boundary_takes_only_what_it_covers(self):
        """The placement is 8 units wide for 8 pixels, so a region from 2 to 4
        covers pixels 2 and 3 exactly. An outward bias of a whole pixel here
        would paint a fringe outside the region's own box on every redaction."""
        ctm = (8, 0, 0, 8, 0, 0)
        spans = image_redact.pixel_spans(ctm, [(2.0, 0.0, 4.0, 8.0)], 8, 8)
        assert spans is not None
        assert {(row, 2, 4) for row in range(8)} == set(spans)

    def test_rounding_noise_on_an_edge_adds_no_pixel(self):
        """0.07 on a placement 0.1 wide is the edge between pixels 6 and 7, and
        maps to 7.000000000000001: the error of the mapping, not a part of
        pixel 7 the mark covers."""
        spans = image_redact.pixel_spans((0.1, 0, 0, 1, 0, 0), [(0.03, 0.0, 0.07, 1.0)], 10, 1)
        assert set(spans) == {(0, 3, 7)}

    def test_a_sliver_deeper_than_rounding_noise_takes_its_pixel(self):
        """The edge snap is bounded by what floating point can carry, not by a
        fixed fraction of a pixel: a mark reaching a hundred-millionth of a
        pixel into column 7 is a mark on column 7."""
        spans = image_redact.pixel_spans((10, 0, 0, 1, 0, 0), [(3.0, 0.0, 7.00000001, 1.0)], 10, 1)
        assert set(spans) == {(0, 3, 8)}

    def test_a_partial_pixel_takes_the_whole_pixel(self):
        ctm = (8, 0, 0, 8, 0, 0)
        spans = image_redact.pixel_spans(ctm, [(2.5, 0.0, 3.5, 8.0)], 8, 8)
        assert {(row, 2, 4) for row in range(8)} == set(spans)

    def test_full_cover_reports_none_so_the_caller_removes_the_whole_image(self):
        ctm = (8, 0, 0, 8, 0, 0)
        assert image_redact.pixel_spans(ctm, [(-1.0, -1.0, 9.0, 9.0)], 8, 8) is None

    def test_a_union_of_regions_that_together_cover_it_reports_none(self):
        ctm = (8, 0, 0, 8, 0, 0)
        regions = [(0.0, 0.0, 8.0, 4.0), (0.0, 4.0, 8.0, 8.0)]
        assert image_redact.pixel_spans(ctm, regions, 8, 8) is None

    def test_all_but_one_column_is_a_partial_mark(self):
        ctm = (8, 0, 0, 8, 0, 0)
        spans = image_redact.pixel_spans(ctm, [(0.0, 0.0, 7.0, 8.0)], 8, 8)
        assert spans is not None
        assert set(spans) == {(row, 0, 7) for row in range(8)}

    def test_a_singular_placement_reports_none(self):
        """A zero-area CTM has no inverse, so there is no pixel region to
        compute and the occurrence goes whole — the fail-closed direction."""
        assert image_redact.pixel_spans((0, 0, 0, 0, 10, 10), [(0.0, 0.0, 9.0, 9.0)], 8, 8) is None

    def test_a_mirrored_placement_maps_to_the_mirrored_pixels(self):
        """A negative x scale draws the image reversed; the region must follow
        it rather than the other way round."""
        mirrored = image_redact.pixel_spans((-8, 0, 0, 8, 8, 0), [(0.0, 0.0, 2.0, 8.0)], 8, 8)
        assert {(row, 6, 8) for row in range(8)} == set(mirrored)

    @pytest.mark.parametrize(
        "label,ctm",
        [
            # 45 degrees: the unit square draws as a diamond spanning
            # x 29.3..170.7 and y 10..151.4. Nothing axis-aligned survives.
            ("rotated", (70.710678, 70.710678, -70.710678, 70.710678, 100.0, 10.0)),
            ("skewed", (100.0, 0.0, 45.0, 100.0, 30.0, 20.0)),
            ("mirrored", (-100.0, 0.0, 0.0, 100.0, 160.0, 20.0)),
            ("negative scale", (-100.0, 0.0, 0.0, -100.0, 160.0, 140.0)),
            ("rotated and skewed", (60.0, 60.0, -80.0, 30.0, 110.0, 20.0)),
        ],
    )
    def test_no_placement_removes_less_than_the_mark_covers(self, label, ctm):
        """The superset test, done exactly: a fine sample of points inside the
        region must every one of them land in a returned span.

        The sample is the region's strict INTERIOR: a pixel the mark meets
        only along its own boundary shares zero area with it, and a point
        exactly on a pixel edge belongs to both neighbours, so sampling the
        closed region would demand a pixel the mark does not cover.
        """
        region = (70.0, 45.0, 95.0, 75.0)
        spans = image_redact.pixel_spans(ctm, [region], 16, 16)
        inverse = image_redact.invert(ctm)
        covered = (
            {(row, col) for row, c0, c1 in spans for col in range(c0, c1)}
            if spans is not None
            else {(row, col) for row in range(16) for col in range(16)}
        )
        missed = []
        steps = 80
        for i in range(1, steps):
            for j in range(1, steps):
                x = region[0] + (region[2] - region[0]) * i / steps
                y = region[1] + (region[3] - region[1]) * j / steps
                u, v = image_redact._apply(inverse, x, y)
                if not (0.0 <= u < 1.0 and 0.0 < v <= 1.0):
                    continue
                col = min(int(u * 16), 15)
                row = min(int((1.0 - v) * 16), 15)
                if (row, col) not in covered:
                    missed.append((row, col, round(x, 2), round(y, 2)))
        assert not missed, f"{label}: under-removal at {missed[:5]}"

    def test_a_skewed_placement_is_redacted_end_to_end(self, tmp_dir):
        """The same rule through the whole operation, not just the geometry:
        a skewed placement keeps its far pixels and loses the marked ones."""
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_gray()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
            content=b"q 60 0 30 60 10 10 cm /Im0 Do Q",
            page_size=(120, 120),
        )
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 25, 25]}])

        assert result["images_modified"] == 1
        _name, data, _keys = _only_image(out)
        grid = _pixels(data, W, 1, 8, H)
        assert grid[H - 1][0] == (0,), "the marked corner must be destroyed"
        assert grid[0][W - 1] == (7,), "the far corner must survive"

    def test_a_mark_that_misses_the_rotated_quad_touches_no_pixel(self):
        """A mark inside the placement's axis-aligned bounding box but clear of
        the rotated quad it actually draws covers no pixel."""
        ctm = (70.710678, 70.710678, -70.710678, 70.710678, 100.0, 10.0)
        assert image_redact.pixel_spans(ctm, [(31.0, 12.0, 40.0, 20.0)], 16, 16) == ()

    def test_a_mark_that_touches_no_pixel_changes_nothing(self, tmp_dir):
        """The same miss through the whole operation: the image is neither
        copied nor removed, and the page still draws the original bytes."""
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_gray()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
            content=b"q 70.710678 70.710678 -70.710678 70.710678 100 10 cm /Im0 Do Q",
            page_size=(200, 200),
        )
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [31, 12, 40, 20]}])

        assert result["images_modified"] == 0
        assert result["images_removed"] == 0
        name, data, _keys = _only_image(out)
        assert name == "/Im0"
        assert data == _unique_gray()


# ── the packed-sample path ────────────────────────────────────────────────


class TestPartialRedaction:
    def test_only_the_marked_pixels_change_and_the_original_is_gone(self, tmp_dir):
        src = _flate_rgb_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        original = _unique_rgb()

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_removed"] == 0
        assert result["images_modified"] == 1
        assert result["images_widened"] == 0
        name, data, keys = _only_image(out)
        assert name != "/Im0", "the occurrence must point at a copy, not the shared original"
        grid = _pixels(data, W, 3, 8, H)
        for row in range(H):
            for col in range(W):
                marked = row >= H - 2 and col < 2
                expected = (0, 0, 0) if marked else (row * 16 + col, 200, 100)
                assert grid[row][col] == expected, f"pixel {row},{col}"
        # The bottom-left corner's original samples must be nowhere in the file.
        assert not _contains_bytes(out, original[6 * W * 3 : 6 * W * 3 + 6])
        assert not _contains_bytes(out, zlib.compress(original))

    def test_the_dictionary_travels_unaltered_apart_from_the_encoding(self, tmp_dir):
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_rgb()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
                "/Interpolate": True,
                "/Intent": Name("/Perceptual"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")
        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])
        _name, _data, keys = _only_image(out)
        assert keys["/ColorSpace"] == Name("/DeviceRGB")
        assert keys["/BitsPerComponent"] == 8
        assert keys["/Interpolate"] is True
        assert keys["/Intent"] == Name("/Perceptual")

    MARKER = b"ORIGINAL-PICTURE-IN-ANOTHER-FORM"

    @pytest.mark.parametrize(
        "key",
        ["/Metadata", "/AF", "/OPI", "/Alternates", "/ID", "/PtData", "/PrivateAppData"],
    )
    def test_no_key_that_can_hand_back_the_original_travels(self, tmp_dir, key):
        """ISO 32000-2 Table 87 lets an image carry XMP (with thumbnails),
        associated source files, an OPI pointer to the high-resolution
        original, alternate versions, a digital identifier and point data; an
        unknown key can hold anything. On the image AND on its masks, every one
        of them would hand back what the redaction destroyed."""
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))

        def carrier():
            return doc.make_stream(self.MARKER)

        def payload():
            if key == "/Metadata":
                return carrier()
            if key == "/AF":
                return pikepdf.Array(
                    [Dictionary(Type=Name("/Filespec"), F=pikepdf.String("scan.tif"), EF=Dictionary(F=carrier()))]
                )
            if key == "/Alternates":
                return pikepdf.Array([Dictionary(Image=carrier())])
            if key == "/ID":
                return pikepdf.String(self.MARKER)
            return Dictionary(Data=carrier())

        def image(data: bytes, ncomp_space, extra=None):
            stream = doc.make_stream(zlib.compress(data))
            stream["/Type"] = Name("/XObject")
            stream["/Subtype"] = Name("/Image")
            stream["/Width"] = W
            stream["/Height"] = H
            stream["/BitsPerComponent"] = 8
            stream["/ColorSpace"] = Name(ncomp_space)
            stream["/Filter"] = Name("/FlateDecode")
            stream[key] = payload()
            for k, v in (extra or {}).items():
                stream[k] = v
            return doc.make_indirect(stream)

        smask = image(_unique_gray(), "/DeviceGray")
        base = image(_unique_rgb(), "/DeviceRGB", {"/SMask": smask})
        page.Resources = Dictionary(XObject=Dictionary(Im0=base))
        page.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        src = os.path.join(tmp_dir, "in.pdf")
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        _name, _data, keys = _only_image(out)
        assert key not in keys
        with pikepdf.open(out) as pdf:
            copy = pdf.pages[0]["/Resources"]["/XObject"][Name(_name)]
            assert key not in copy["/SMask"]
        assert not _contains_bytes(out, self.MARKER)

    def test_all_but_one_column_keeps_the_last_column(self, tmp_dir):
        """Seven of eight columns under the mark is a partial mark: the last
        column is on display outside it and stays."""
        src = _flate_rgb_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [0, 0, 80, 100]}])

        assert result["images_modified"] == 1
        assert result["images_removed"] == 0
        _name, data, _keys = _only_image(out)
        grid = _pixels(data, W, 3, 8, H)
        for row in range(H):
            assert grid[row][W - 1] == (row * 16 + W - 1, 200, 100), row
            assert grid[row][W - 2] == (0, 0, 0), row

    def test_a_whole_cover_still_removes_the_object(self, tmp_dir):
        src = _flate_rgb_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [0, 0, 100, 100]}])

        assert result["images_removed"] == 1
        assert result["images_modified"] == 0
        assert result["images_removed_for_compression"] == 0
        assert _page_images(out) == []
        assert not _contains_bytes(out, zlib.compress(_unique_rgb()))

    def test_two_placements_of_one_image_do_not_leak_into_each_other(self, tmp_dir):
        """The left placement is marked; the right one draws the same XObject
        and must come out whole. The copy is what the marked `Do` points at."""
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_rgb()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
            content=(
                b"q 40 0 0 40 0 0 cm /Im0 Do Q "
                b"q 40 0 0 40 60 60 cm /Im0 Do Q"
            ),
        )
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [0, 0, 10, 10]}])

        assert result["images_modified"] == 1
        assert result["images_removed"] == 0
        with pikepdf.open(out) as pdf:
            xobjects = pdf.pages[0]["/Resources"]["/XObject"]
            names = sorted(str(k) for k in xobjects.keys())
            assert names == ["/Im0", "/RdxIm0"], names
            untouched = _pixels(bytes(xobjects[Name("/Im0")].read_bytes()), W, 3, 8, H)
            edited = _pixels(bytes(xobjects[Name("/RdxIm0")].read_bytes()), W, 3, 8, H)
        assert untouched[H - 1][0] == (7 * 16 + 0, 200, 100)
        assert edited[H - 1][0] == (0, 0, 0)
        assert edited[0][W - 1] == untouched[0][W - 1]

    def test_both_placements_marked_leaves_no_original_behind(self, tmp_dir):
        """Two marks, two different pixel sets, two copies — and ONE image in
        the count, because it is one picture the user sees twice."""
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_rgb()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
            content=(
                b"q 40 0 0 40 0 0 cm /Im0 Do Q "
                b"q 40 0 0 40 60 60 cm /Im0 Do Q"
            ),
        )
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(
            file=src,
            output=out,
            regions=[
                {"page": 1, "rect": [0, 0, 10, 10]},
                {"page": 1, "rect": [90, 90, 100, 100]},
            ],
        )

        assert result["images_modified"] == 1
        assert _page_images(out) == ["/RdxIm0", "/RdxIm1"]
        assert not _contains_bytes(out, zlib.compress(_unique_rgb()))

    def test_placements_with_the_same_marked_pixels_share_one_copy(self, tmp_dir):
        """A tile drawn forty times under one strip of marks is one redacted
        image, not forty: the output does not grow with the placements."""
        placements = b" ".join(
            f"q 8 0 0 8 {10 * i} 0 cm /Im0 Do Q".encode("ascii") for i in range(40)
        )
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_rgb()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
            content=placements,
            page_size=(400, 20),
        )
        out = os.path.join(tmp_dir, "out.pdf")

        # Rows 6 and 7 of every tile: y 0..2 at one point per pixel.
        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [0, 0, 400, 2]}])

        assert result["images_modified"] == 1
        assert _page_images(out) == ["/RdxIm0"]
        with pikepdf.open(out) as pdf:
            images = [o for o in pdf.objects if isinstance(o, pikepdf.Stream) and o.get("/Subtype") == Name("/Image")]
            body = bytes(pdf.pages[0].Contents.read_bytes())
        assert len(images) == 1
        assert body.count(b"/RdxIm0 Do") == 40

    def test_a_rotated_placement_removes_a_superset_of_the_mark(self, tmp_dir):
        """45 degrees: no pixel row lines up with the mark. Every pixel whose
        own area meets the mark must be destroyed, and the pixels far from it
        must survive."""
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_gray()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
            content=b"q 56.5685 56.5685 -56.5685 56.5685 40 5 cm /Im0 Do Q",
        )
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [35, 5, 45, 15]}])

        assert result["images_modified"] == 1
        _name, data, _keys = _only_image(out)
        grid = _pixels(data, W, 1, 8, H)
        # The mark sits at the placement's bottom point, which is the image's
        # bottom-LEFT corner pixel after the rotation.
        assert grid[H - 1][0] == (0,)
        assert grid[0][W - 1] == (0 * 16 + 7,), "the far corner must survive"
        assert grid[H - 1][W - 1] == ((H - 1) * 16 + 7,), "the far corner must survive"

    def test_the_source_file_is_untouched(self, tmp_dir):
        src = _flate_rgb_pdf(os.path.join(tmp_dir, "in.pdf"))
        before = open(src, "rb").read()
        redact(
            file=src,
            output=os.path.join(tmp_dir, "out.pdf"),
            regions=[{"page": 1, "rect": [10, 10, 30, 30]}],
        )
        assert open(src, "rb").read() == before


# ── colour spaces and sample depths ───────────────────────────────────────


class TestSampleFormats:
    @pytest.mark.parametrize(
        "bpc,packed,expected_fill",
        [
            # 1 bit: 8 pixels per byte, one row per byte.
            (1, bytes([0b10101010] * H), 0),
            # 2 bits: 4 pixels per byte, two bytes per row.
            (2, bytes([0b11100100, 0b00011011] * H), 0),
            # 4 bits: two pixels per byte, four bytes per row.
            (4, bytes([0x0F, 0x1E, 0x2D, 0x3C] * H), 0),
            (8, _unique_gray(), 0),
        ],
    )
    def test_grey_at_every_sample_depth(self, tmp_dir, bpc, packed, expected_fill):
        src = _image_pdf(
            os.path.join(tmp_dir, f"in{bpc}.pdf"),
            zlib.compress(packed),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": bpc,
                "/Filter": Name("/FlateDecode"),
            },
        )
        out = os.path.join(tmp_dir, f"out{bpc}.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        _name, data, _keys = _only_image(out)
        before = _pixels(packed, W, 1, bpc, H)
        after = _pixels(data, W, 1, bpc, H)
        for row in range(H):
            for col in range(W):
                marked = row >= H - 2 and col < 2
                assert after[row][col] == (
                    (expected_fill,) if marked else before[row][col]
                ), f"{bpc}bpc pixel {row},{col}"

    def test_sixteen_bit_grey(self, tmp_dir):
        packed = b"".join(
            (row * 4096 + col * 17).to_bytes(2, "big") for row in range(H) for col in range(W)
        )
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(packed),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 16,
                "/Filter": Name("/FlateDecode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        _name, data, _keys = _only_image(out)
        after = _pixels(data, W, 1, 16, H)
        assert after[H - 1][0] == (0,)
        assert after[0][W - 1] == (0 * 4096 + 7 * 17,)

    def test_run_length_samples(self, tmp_dir):
        """/RunLengthDecode is a filter the sample path claims: it must be
        read, not refused as unreadable."""
        body = bytearray()
        raw = _unique_gray()
        for index in range(0, len(raw), 8):
            body += bytes([7]) + raw[index : index + 8]
        body += bytes([128])
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            bytes(body),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/RunLengthDecode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        _name, data, _keys = _only_image(out)
        after = _pixels(data, W, 1, 8, H)
        assert after[H - 1][0] == (0,)
        assert after[0][W - 1] == (7,)

    def test_cmyk_fills_with_full_black_ink(self, tmp_dir):
        packed = bytes(
            sample
            for row in range(H)
            for col in range(W)
            for sample in (row * 16 + col, 10, 20, 30)
        )
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(packed),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceCMYK"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        _name, data, _keys = _only_image(out)
        after = _pixels(data, W, 4, 8, H)
        assert after[H - 1][0] == (0, 0, 0, 255)
        assert after[0][W - 1] == (7, 10, 20, 30)

    def test_indexed_fills_with_the_darkest_palette_entry(self, tmp_dir):
        # Entry 0 white, 1 mid grey, 2 black: the fill must be index 2 rather
        # than a hole in the table.
        palette = bytes([255, 255, 255, 128, 128, 128, 0, 0, 0])
        packed = bytes((row + col) % 3 for row in range(H) for col in range(W))
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(packed),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": pikepdf.Array(
                    [Name("/Indexed"), Name("/DeviceRGB"), 2, pikepdf.String(palette)]
                ),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        _name, data, _keys = _only_image(out)
        after = _pixels(data, W, 1, 8, H)
        assert after[H - 1][0] == (2,)
        assert after[0][W - 1] == (((0 + 7) % 3),)

    @staticmethod
    def _separation(white_at_one: bool):
        """A spot colour over grey whose tint transform is the exponential
        (FunctionType 2) kind: tint 1 renders black, or — inverted — white."""
        c0, c1 = ([0], [1]) if white_at_one else ([1], [0])
        return pikepdf.Array(
            [
                Name("/Separation"),
                Name("/Spot"),
                Name("/DeviceGray"),
                Dictionary(FunctionType=2, Domain=[0, 1], C0=c0, C1=c1, N=1),
            ]
        )

    @pytest.mark.parametrize("white_at_one,expected", [(False, 255), (True, 0)])
    def test_a_separation_fills_with_the_tint_that_renders_darkest(self, tmp_dir, white_at_one, expected):
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_gray()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": self._separation(white_at_one),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        _name, data, _keys = _only_image(out)
        assert _pixels(data, W, 1, 8, H)[H - 1][0] == (expected,)

    @pytest.mark.parametrize("white_at_one,expected", [(False, 1), (True, 2)])
    def test_an_indexed_spot_colour_fills_with_the_darkest_tint(self, tmp_dir, white_at_one, expected):
        """A palette over a Separation holds TINTS: entry 1 is tint 1 and
        entry 2 is tint 0, and which of them renders darkest is the spot
        colour's own tint transform to say."""
        palette = bytes([128, 255, 0])
        packed = bytes((row + col) % 3 for row in range(H) for col in range(W))
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(packed),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": pikepdf.Array(
                    [Name("/Indexed"), self._separation(white_at_one), 2, pikepdf.String(palette)]
                ),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        _name, data, _keys = _only_image(out)
        assert _pixels(data, W, 1, 8, H)[H - 1][0] == (expected,)

    def test_a_decode_array_is_inverted_rather_than_ignored(self, tmp_dir):
        """/Decode [1 0] reverses grey, so the sample that RENDERS black is
        255, not 0."""
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_gray()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
                "/Decode": pikepdf.Array([1, 0]),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        _name, data, keys = _only_image(out)
        assert list(keys["/Decode"]) == [1, 0]
        after = _pixels(data, W, 1, 8, H)
        assert after[H - 1][0] == (255,)


# ── stencils and transparency ─────────────────────────────────────────────


def _mask_stream(doc, data: bytes, keys: dict):
    stream = doc.make_stream(data)
    stream["/Type"] = Name("/XObject")
    stream["/Subtype"] = Name("/Image")
    for key, value in keys.items():
        stream[key] = value
    return doc.make_indirect(stream)


class TestMasks:
    def test_an_image_mask_loses_its_marked_bits(self, tmp_dir):
        packed = bytes([0x00] * H)  # 8x8, every bit clear: the whole stencil paints
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(packed),
            {
                "/Width": W,
                "/Height": H,
                "/ImageMask": True,
                "/BitsPerComponent": 1,
                "/Filter": Name("/FlateDecode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        _name, data, keys = _only_image(out)
        assert keys["/ImageMask"] is True
        after = _pixels(data, W, 1, 1, H)
        # A stencil paints where the sample is 0, so the destroyed area is 1:
        # it paints NOTHING rather than whatever colour happened to be live.
        assert after[H - 1][0] == (1,)
        assert after[0][W - 1] == (0,)

    def test_a_soft_mask_loses_the_marked_area_on_a_copy(self, tmp_dir):
        """An /SMask left intact holds the alpha silhouette of the pixels just
        destroyed. The destroyed area becomes TRANSPARENT — it paints nothing,
        as removed text paints nothing — and the mask is shareable, so it is
        never edited in place."""
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        shared = _mask_stream(
            doc,
            zlib.compress(_unique_gray()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
        )
        images = {}
        for name in ("Im0", "Im1"):
            images[name] = _mask_stream(
                doc,
                zlib.compress(_unique_rgb()),
                {
                    "/Width": W,
                    "/Height": H,
                    "/ColorSpace": Name("/DeviceRGB"),
                    "/BitsPerComponent": 8,
                    "/Filter": Name("/FlateDecode"),
                    "/SMask": shared,
                },
            )
        page.Resources = Dictionary(XObject=Dictionary(**images))
        page.Contents = doc.make_stream(
            b"q 40 0 0 40 0 0 cm /Im0 Do Q q 40 0 0 40 60 60 cm /Im1 Do Q"
        )
        src = os.path.join(tmp_dir, "in.pdf")
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [0, 0, 10, 10]}])

        with pikepdf.open(out) as pdf:
            xobjects = pdf.pages[0]["/Resources"]["/XObject"]
            edited = xobjects[Name("/RdxIm0")]
            alpha_after = _pixels(bytes(edited["/SMask"].read_bytes()), W, 1, 8, H)
            colour_after = _pixels(bytes(edited.read_bytes()), W, 3, 8, H)
            other = xobjects[Name("/Im1")]
            alpha_other = _pixels(bytes(other["/SMask"].read_bytes()), W, 1, 8, H)
        assert alpha_after[H - 1][0] == (0,), "the destroyed area must paint nothing"
        assert colour_after[H - 1][0] == (0, 0, 0), "and its colour must be gone too"
        assert alpha_after[0][W - 1] == (7,)
        assert alpha_other[H - 1][0] == ((H - 1) * 16,), "the shared mask must be untouched"

    def test_a_stencil_mask_masks_the_destroyed_area_out(self, tmp_dir):
        """/Mask as an image mask: a sample of 1 leaves the page unchanged
        (ISO 32000-2 §8.9.6.2), so the destroyed area is stored 1."""
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        mask = _mask_stream(
            doc,
            zlib.compress(bytes([0x00] * H)),
            {
                "/Width": W,
                "/Height": H,
                "/ImageMask": True,
                "/BitsPerComponent": 1,
                "/Filter": Name("/FlateDecode"),
            },
        )
        base = _mask_stream(
            doc,
            zlib.compress(_unique_rgb()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
                "/Mask": mask,
            },
        )
        page.Resources = Dictionary(XObject=Dictionary(Im0=base))
        page.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        src = os.path.join(tmp_dir, "in.pdf")
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        with pikepdf.open(out) as pdf:
            edited = pdf.pages[0]["/Resources"]["/XObject"][Name("/RdxIm0")]
            bits = _pixels(bytes(edited["/Mask"].read_bytes()), W, 1, 1, H)
        assert bits[H - 1][0] == (1,), "the destroyed area must be masked out"
        assert bits[0][W - 1] == (0,)

    def test_a_fine_stencil_over_a_one_pixel_colour_loses_only_the_mark(self, tmp_dir):
        """The shape of an MRC foreground: one colour for the whole page and a
        full-resolution stencil that says where it paints. Every pixel of the
        colour image meets the mark, but it shows everywhere else too, so the
        colour stays; the text shape lives in the stencil, and the stencil is
        what loses the marked area."""
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        mask = _mask_stream(
            doc,
            zlib.compress(bytes([0x0F] * H)),
            {
                "/Width": W,
                "/Height": H,
                "/ImageMask": True,
                "/BitsPerComponent": 1,
                "/Filter": Name("/FlateDecode"),
            },
        )
        colour = _mask_stream(
            doc,
            zlib.compress(bytes([20, 40, 90])),
            {
                "/Width": 1,
                "/Height": 1,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
                "/Mask": mask,
            },
        )
        page.Resources = Dictionary(XObject=Dictionary(Im0=colour))
        page.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        src = os.path.join(tmp_dir, "in.pdf")
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        assert result["images_removed"] == 0
        with pikepdf.open(out) as pdf:
            edited = pdf.pages[0]["/Resources"]["/XObject"][Name("/RdxIm0")]
            assert bytes(edited.read_bytes()) == bytes([20, 40, 90])
            bits = _pixels(bytes(edited["/Mask"].read_bytes()), W, 1, 1, H)
        before = _pixels(bytes([0x0F] * H), W, 1, 1, H)
        for row in range(H):
            for col in range(W):
                marked = row >= H - 2 and col < 2
                assert bits[row][col] == ((1,) if marked else before[row][col]), f"pixel {row},{col}"

    def test_a_colour_key_mask_cannot_make_the_fill_transparent(self, tmp_dir):
        """Colour-key masking hides a pixel whose samples fall in the given
        ranges. A black fill inside those ranges would be transparent — the
        content under the image would show through the "removed" area."""
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_gray()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
                "/Mask": pikepdf.Array([0, 4]),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        _name, data, keys = _only_image(out)
        assert list(keys["/Mask"]) == [0, 4]
        after = _pixels(data, W, 1, 8, H)
        assert after[H - 1][0] == (5,), "the fill must sit outside the masked range"

    def test_a_colour_key_mask_over_the_whole_range_refuses(self, tmp_dir):
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_gray()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
                "/Mask": pikepdf.Array([0, 255]),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="cannot be partly redacted"):
            redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])
        assert not os.path.exists(out)


class TestMaskResolution:
    def _pdf_with_smask(self, tmp_dir, mask_size: int, alpha: bytes) -> str:
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        smask = _mask_stream(
            doc,
            zlib.compress(alpha),
            {
                "/Width": mask_size,
                "/Height": mask_size,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
        )
        base = _mask_stream(
            doc,
            zlib.compress(_unique_rgb()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
                "/SMask": smask,
            },
        )
        page.Resources = Dictionary(XObject=Dictionary(Im0=base))
        page.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        src = os.path.join(tmp_dir, f"in{mask_size}.pdf")
        doc.save(src)
        doc.close()
        return src

    def test_a_mask_on_its_own_coarser_grid_is_mapped_to_that_grid(self, tmp_dir):
        """The mask need not match the base's resolution: it covers the same
        unit square, so the spans are recomputed against its own pixels."""
        alpha = bytes(row * 16 + col + 1 for row in range(4) for col in range(4))
        src = self._pdf_with_smask(tmp_dir, 4, alpha)
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        with pikepdf.open(out) as pdf:
            edited = pdf.pages[0]["/Resources"]["/XObject"][Name("/RdxIm0")]
            mask = edited["/SMask"]
            assert int(mask["/Width"]) == 4
            grid = _pixels(bytes(mask.read_bytes()), 4, 1, 8, 4)
        assert grid[3][0] == (0,), "the destroyed corner must paint nothing"
        assert grid[0][3] == (4,), "the rest of the mask is untouched"

    def test_a_one_pixel_mask_keeps_its_value_and_the_base_loses_the_mark(self, tmp_dir):
        """A single-pixel mask is on display all over the image, most of it
        outside the mark: its value says nothing the rest of the picture does
        not. The base's own marked pixels go."""
        src = self._pdf_with_smask(tmp_dir, 1, bytes([200]))
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        with pikepdf.open(out) as pdf:
            edited = pdf.pages[0]["/Resources"]["/XObject"][Name("/RdxIm0")]
            assert bytes(edited["/SMask"].read_bytes()) == bytes([200])
            colour = _pixels(bytes(edited.read_bytes()), W, 3, 8, H)
        assert colour[H - 1][0] == (0, 0, 0)
        assert colour[0][W - 1] == (7, 200, 100)


# ── lossy codecs ──────────────────────────────────────────────────────────


def _two_secrets(mode: str, size: int, box, background):
    """Paint functions for two inputs that differ ONLY inside `box`."""
    x0, y0, x1, y1 = box
    secrets = {
        "L": (10, 245),
        "RGB": ((230, 20, 20), (20, 20, 230)),
        "CMYK": ((0, 220, 220, 0), (220, 220, 0, 0)),
    }[mode]

    def paint(secret):
        def fn(col, row):
            if x0 <= col < x1 and y0 <= row < y1:
                return secret
            return background(col, row)

        return fn

    return [paint(s) for s in secrets]


def _smooth(mode: str):
    if mode == "L":
        return lambda col, row: 90 + (col % 7) * 4 + (row % 5) * 3
    if mode == "RGB":
        return lambda col, row: (100 + (col % 7) * 5, 110 + (row % 5) * 6, 120)
    return lambda col, row: (30 + (col % 7) * 3, 40, 50 + (row % 5) * 4, 20)


class TestJpeg:
    @pytest.mark.parametrize(
        "mode,subsampling,box",
        [
            ("L", 0, (40, 40, 56, 56)),
            ("RGB", 0, (40, 40, 56, 56)),
            ("RGB", 1, (40, 40, 56, 56)),
            ("RGB", 2, (40, 40, 56, 56)),
            # Inside one half of a 16-pixel chroma block: the whole block
            # carries it, not only the 8-pixel luma blocks the mark meets.
            ("RGB", 2, (41, 41, 46, 46)),
            ("CMYK", 0, (40, 40, 56, 56)),
        ],
        ids=["grey", "rgb-444", "rgb-422", "rgb-420", "rgb-420-half-block", "cmyk"],
    )
    def test_nothing_that_survives_depends_on_the_marked_area(self, tmp_dir, mode, subsampling, box):
        """The differential: two scans identical except under the mark. The
        encoder spread each one's colour into neighbouring blocks and the
        decoder's chroma upsampling spreads it further, so the survivors a
        naive rewrite keeps carry the secret's colour. Every pixel whose
        decoded value depends on the marked ones goes too, and the rewritten
        images must then be the SAME bytes."""
        size = 96
        outputs = []
        for index, paint in enumerate(_two_secrets(mode, size, box, _smooth(mode))):
            data = _jpeg(mode, size, size, paint, subsampling=subsampling)
            src = _pixel_pdf(os.path.join(tmp_dir, f"in{index}.pdf"), data, _jpeg_keys(mode, size, size), size, size)
            out = os.path.join(tmp_dir, f"out{index}.pdf")
            result = redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(*box, size)}])
            assert result["images_modified"] == 1
            assert result["images_widened"] == 1, "the widened area must be reported"
            _name, raw, keys = _only_image_raw(out)
            assert keys["/Filter"] == Name("/DCTDecode")
            outputs.append((raw, data))
        assert outputs[0][0] == outputs[1][0], "a survivor depends on what was under the mark"
        # And the far corner is still the picture it was.
        after = _source_decoded(outputs[0][0])
        before = _source_decoded(outputs[0][1])
        assert np.abs(after[:8, :8] - before[:8, :8]).max() <= 8

    def test_the_destroyed_area_is_whole_blocks_of_one_colour(self, tmp_dir):
        """A 4:4:4 source: the marked block, its neighbours within the
        encoder's reach, snapped to the 8x8 grid the rewrite encodes on — each
        destroyed block one flat colour, the mean of the untouched ring around
        it, so a widened margin reads as the surrounding picture."""
        size = 48
        data = _jpeg("L", size, size, lambda col, row: 20 if 16 <= col < 24 and 16 <= row < 24 else 60 + col + row)
        src = _pixel_pdf(os.path.join(tmp_dir, "in.pdf"), data, _jpeg_keys("L", size, size), size, size)
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(16, 16, 24, 24, size)}])

        assert result["images_modified"] == 1
        after = _decoded(out)
        before = _source_decoded(data)
        destroyed = after[8:32, 8:32]
        assert destroyed.max() - destroyed.min() <= 2, "the destroyed blocks must be flat"
        ring = np.concatenate([before[7, 7:33], before[32, 7:33], before[7:33, 7], before[7:33, 32]])
        assert abs(int(destroyed.mean()) - int(round(ring.mean()))) <= 4
        assert abs(after[4, 4] - before[4, 4]) <= 4
        assert abs(after[40, 40] - before[40, 40]) <= 4

    def test_a_subsampled_source_loses_whole_output_blocks_too(self, tmp_dir):
        """4:2:0: a chroma block covers 16x16 pixels and the upsampling reaches
        one more, so the dependency runs 31..65 around a mark at 40..56 — and
        the destroyed area is that, out to the 8x8 grid: 24..72, one flat
        colour, nothing of the picture left inside it."""
        size = 96
        data = _jpeg("RGB", size, size, _smooth("RGB"), subsampling=2)
        src = _pixel_pdf(os.path.join(tmp_dir, "in.pdf"), data, _jpeg_keys("RGB", size, size), size, size)
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(40, 40, 56, 56, size)}])

        after = _decoded(out)
        destroyed = after[24:72, 24:72]
        assert (destroyed.max(axis=(0, 1)) - destroyed.min(axis=(0, 1))).max() <= 3
        before = _source_decoded(data)
        assert np.abs(after[:23, :23] - before[:23, :23]).max() <= 8

    def test_a_rewrite_whose_destroyed_area_is_not_its_fill_refuses(self, tmp_dir, monkeypatch):
        """The rewrite decodes what it wrote and requires every destroyed pixel
        to hold its fill. A lossy codec is the one path where what was written
        and what a reader gets back are different questions."""
        real = image_redact._ring_fill

        def misreported(array, spans, fallback):
            return [
                (component, tuple((v + 90) % 256 for v in value))
                for component, value in real(array, spans, fallback)
            ]

        monkeypatch.setattr(image_redact, "_ring_fill", misreported)
        size = 48
        data = _jpeg("L", size, size, lambda col, row: 60 + col + row)
        src = _pixel_pdf(os.path.join(tmp_dir, "in.pdf"), data, _jpeg_keys("L", size, size), size, size)
        out = os.path.join(tmp_dir, "out.pdf")

        with pytest.raises(ValueError, match="could not be proven"):
            redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(16, 16, 24, 24, size)}])
        assert not os.path.exists(out)

    @pytest.mark.parametrize("adobe", [True, False])
    def test_the_adobe_marker_follows_the_source(self, tmp_dir, adobe):
        """A viewer inverts CMYK samples on the Adobe marker's presence, so a
        rewrite that gained or lost it would invert every surviving pixel."""
        size = 48
        data = _jpeg("CMYK", size, size, lambda col, row: (30 + col, 40, 50 + row, 20))
        if not adobe:
            data = image_redact._strip_app14(data)
        assert codec_taint.jpeg_layout(data).adobe is adobe
        keys = _jpeg_keys("CMYK", size, size)
        if not adobe:
            del keys["/Decode"]
        src = _pixel_pdf(os.path.join(tmp_dir, "in.pdf"), data, keys, size, size)
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(16, 16, 24, 24, size)}])

        assert result["images_modified"] == 1
        _name, raw, _keys = _only_image_raw(out)
        assert codec_taint.jpeg_layout(raw).adobe is adobe
        after = _source_decoded(raw)
        before = _source_decoded(data)
        assert np.abs(after[:8, :8] - before[:8, :8]).max() <= 6

    def test_a_jpeg_inside_a_flate_wrapper(self, tmp_dir):
        """`[/FlateDecode /DCTDecode]` is a real shape: the JPEG bytes live
        inside the Flate layer and must be peeled before the decoder sees
        them."""
        size = 48
        data = _jpeg("L", size, size, lambda col, row: 200 if col < 8 and row >= 40 else 60 + col)
        src = _pixel_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(data),
            _jpeg_keys("L", size, size, filters=pikepdf.Array([Name("/FlateDecode"), Name("/DCTDecode")])),
            size,
            size,
        )
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(0, 40, 8, 48, size)}])

        assert result["images_modified"] == 1
        after = _decoded(out)
        assert after[44, 4] < 150, "the marked corner must lose its bright block"
        assert abs(after[4, 44] - (60 + 44)) <= 6

    def test_dimensions_that_are_not_a_multiple_of_the_block_size(self, tmp_dir):
        """The last block row and column are partial. The snap clamps to the
        image, and the re-encode's own edge padding keeps those blocks flat —
        so the verification passes rather than refusing a legitimate scan."""
        size = 20
        data = _jpeg("L", size, size, lambda col, row: 240 if col < 4 and row >= 16 else 60 + 4 * col)
        src = _pixel_pdf(os.path.join(tmp_dir, "in.pdf"), data, _jpeg_keys("L", size, size), size, size)
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(0, 16, 4, 20, size)}])

        assert result["images_modified"] == 1
        after = _decoded(out)
        assert after.shape == (size, size)
        assert after[18, 1] < 200, "the marked corner must lose its bright block"
        assert abs(after[2, 18] - (60 + 72)) <= 6, "the far corner must survive"


class TestScannedPage:
    def test_a_page_that_is_one_scanned_image_keeps_the_rest_of_the_page(self, tmp_dir):
        """The reported defect, at the smallest size that shows it: the whole
        page is one image, a few lines of it are marked, and the page must not
        come back blank."""
        size = 64
        data = _jpeg("L", size, size, lambda col, row: 50 + (row // 8) * 24)
        src = _image_pdf(
            os.path.join(tmp_dir, "scan.pdf"),
            data,
            _jpeg_keys("L", size, size),
            # The image IS the page: 64 pixels over 640 points, 10 per pixel.
            content=b"q 640 0 0 640 0 0 cm /Im0 Do Q",
            page_size=(640, 640),
        )
        out = os.path.join(tmp_dir, "out.pdf")

        # Rows 24..40 across the middle, the shape of a few marked lines. The
        # encoder's reach takes the 8x8 block rows either side with them.
        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [0, 240, 640, 400]}])

        assert result["images_removed"] == 0, "the page must not lose its image"
        assert result["images_modified"] == 1
        assert result["images_widened"] == 1
        with pikepdf.open(out) as pdf:
            body = bytes(pikepdf.Page(pdf.pages[0]).obj["/Contents"].read_bytes())
            assert b"Do" in body, "the page must still draw an image"
        after = _decoded(out)
        before = _source_decoded(data)
        column = after[:, size // 2]
        destroyed = column[16:48]
        assert destroyed.max() - destroyed.min() <= 2
        # The ring is rows 15 and 48; the band becomes their mean, not the
        # lines that were there.
        assert abs(int(destroyed.mean()) - int(round((before[15, 32] + before[48, 32]) / 2))) <= 4
        for row in list(range(0, 16)) + list(range(48, 64)):
            assert abs(column[row] - before[row, size // 2]) <= 4, f"row {row}"
        assert not _contains_bytes(out, data)


def _jp2(mode: str, size: int, paint, **options) -> bytes:
    from PIL import Image

    image = Image.new(mode, (size, size))
    pixels = image.load()
    for row in range(size):
        for col in range(size):
            pixels[col, row] = paint(col, row)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG2000", **options)
    return buffer.getvalue()


class TestJpeg2000:
    def test_a_lossless_codestream_loses_the_wavelet_reach_and_keeps_the_rest_exactly(self, tmp_dir):
        """Every coefficient of a lossless codestream is coded in full, so a
        survivor depends on the mark only through the filter's reach. The
        rewrite is lossless too: outside that reach, every sample is exactly
        what it was."""
        size = 64
        box = (24, 24, 40, 40)
        outputs = []
        for index, paint in enumerate(_two_secrets("RGB", size, box, _smooth("RGB"))):
            data = _jp2("RGB", size, paint, irreversible=False, num_resolutions=2)
            keys = {
                "/Width": size,
                "/Height": size,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/JPXDecode"),
            }
            src = _pixel_pdf(os.path.join(tmp_dir, f"in{index}.pdf"), data, keys, size, size)
            out = os.path.join(tmp_dir, f"out{index}.pdf")
            result = redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(*box, size)}])
            assert result["images_modified"] == 1
            assert result["images_widened"] == 1
            _name, raw, keys_after = _only_image_raw(out)
            assert keys_after["/Filter"] == Name("/JPXDecode")
            outputs.append((raw, data))
        assert outputs[0][0] == outputs[1][0], "a survivor depends on what was under the mark"
        after = _source_decoded(outputs[0][0])
        before = _source_decoded(outputs[0][1])
        # One decomposition level of the 5/3 filter reaches 6 pixels.
        assert np.array_equal(after[:16], before[:16])
        assert np.array_equal(after[48:], before[48:])

    def test_a_fixed_quality_background_is_rewritten_near_its_own_size(self, tmp_dir):
        """The MRC background (`encode_layer_jpx`) codes its RGB samples
        through the reversible colour transform. The lossless rewrite keeps
        that transform: coding the three components apart grows this
        background several times over."""
        from PIL import Image

        from engine.mrc_codecs import encode_layer_jpx

        size = 128
        rows, cols = np.mgrid[0:size, 0:size].astype(float)
        tint = np.stack(
            [236 + 6 * np.sin(cols / 9), 230 + 5 * np.cos(rows / 11), 214 + 4 * np.sin((cols + rows) / 13)],
            axis=-1,
        )
        data = encode_layer_jpx(Image.fromarray(tint.astype(np.uint8), "RGB"), 2**4, 3)
        keys = {
            "/Width": size,
            "/Height": size,
            "/ColorSpace": Name("/DeviceRGB"),
            "/BitsPerComponent": 8,
            "/Filter": Name("/JPXDecode"),
        }
        src = _pixel_pdf(os.path.join(tmp_dir, "in.pdf"), data, keys, size, size)
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(60, 60, 68, 68, size)}])

        assert result["images_modified"] == 1
        _name, raw, _keys = _only_image_raw(out)
        rewritten, source = len(raw), len(data)
        assert rewritten <= 3 * source

    def test_a_rate_controlled_codestream_is_removed_whole_and_says_why(self, tmp_dir):
        """A lossy codestream's truncation points are chosen against one
        threshold for the whole picture, so every pixel of it depends on what
        the mark covered. It goes whole, and the result says it went for its
        compression rather than for the mark."""
        size = 64
        data = _jp2("RGB", size, _smooth("RGB"), quality_mode="rates", quality_layers=[20])
        assert codec_taint.jpx_lossy(codec_taint.jpx_layout(data))
        keys = {
            "/Width": size,
            "/Height": size,
            "/ColorSpace": Name("/DeviceRGB"),
            "/BitsPerComponent": 8,
            "/Filter": Name("/JPXDecode"),
        }
        src = _pixel_pdf(os.path.join(tmp_dir, "in.pdf"), data, keys, size, size)
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(24, 24, 40, 40, size)}])

        assert result["images_modified"] == 0
        assert result["images_removed"] == 1
        assert result["images_removed_for_compression"] == 1
        assert _page_images(out) == []
        assert not _contains_bytes(out, data[-64:])

    def test_without_a_colour_space_the_codestream_says_what_the_colour_is(self, tmp_dir):
        """ISO 32000-2 §7.4.9: a JPXDecode image may omit /ColorSpace, and the
        colour is then read from the file's own colour specification."""
        size = 64
        data = _jp2("RGB", size, _smooth("RGB"), irreversible=False, num_resolutions=2)
        keys = {"/Width": size, "/Height": size, "/Filter": Name("/JPXDecode")}
        src = _pixel_pdf(os.path.join(tmp_dir, "in.pdf"), data, keys, size, size)
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(24, 24, 40, 40, size)}])

        assert result["images_modified"] == 1
        after = _decoded(out)
        assert after.shape == (size, size, 3)

    def test_an_opacity_channel_in_the_codestream_leaves_as_a_soft_mask_without_the_mark(self, tmp_dir):
        """/SMaskInData: the opacity rides inside the codestream. The rewrite
        carries colour only, and the opacity becomes an explicit /SMask whose
        destroyed area is transparent."""
        size = 64
        rgba = np.zeros((size, size, 4), np.uint8)
        rgba[..., 0] = 120
        rgba[..., 1] = (np.arange(size)[None, :] * 3).astype(np.uint8)
        rgba[..., 2] = 60
        rgba[..., 3] = 200
        from PIL import Image

        buffer = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buffer, format="JPEG2000", irreversible=False, num_resolutions=2)
        keys = {"/Width": size, "/Height": size, "/Filter": Name("/JPXDecode"), "/SMaskInData": 1}
        src = _pixel_pdf(os.path.join(tmp_dir, "in.pdf"), buffer.getvalue(), keys, size, size)
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(24, 24, 40, 40, size)}])

        assert result["images_modified"] == 1
        with pikepdf.open(out) as pdf:
            xobjects = pdf.pages[0]["/Resources"]["/XObject"]
            image = xobjects[next(iter(xobjects.keys()))]
            assert "/SMaskInData" not in image
            alpha = np.frombuffer(bytes(image["/SMask"].read_bytes()), np.uint8).reshape(size, size)
            colour = _source_decoded(bytes(image.read_raw_bytes()))
        assert colour.shape == (size, size, 3)
        assert alpha[30, 30] == 0
        assert alpha[2, 2] == 200

    def test_the_colour_specification_with_the_highest_precedence_is_the_image_s(self):
        """ISO 32000-2 §7.4.9: of several colour specifications, the one with
        the highest precedence (then the best approximation) is used."""
        data = _jp2("RGB", 16, lambda col, row: (10, 20, 30), irreversible=False, num_resolutions=2)
        assert codec_taint.jpx_split(data)[1].enumerated == 16
        header = data.index(b"jp2h") - 4
        length = struct.unpack(">I", data[header : header + 4])[0]
        body = struct.pack(">BbB", 1, 5, 1) + struct.pack(">I", 17)
        box = struct.pack(">I4s", 8 + len(body), b"colr") + body
        patched = (
            data[:header]
            + struct.pack(">I", length + len(box))
            + data[header + 4 : header + length]
            + box
            + data[header + length :]
        )
        assert codec_taint.jpx_split(patched)[1].enumerated == 17

    def test_a_palette_codestream_refuses_by_name(self, tmp_dir):
        size = 16
        data = _jp2("L", size, lambda col, row: col * 8, irreversible=False, num_resolutions=2)
        # Put a palette box into the JP2 header: a palette image's samples are
        # indexes, which the rewrite has no way to fill.
        header = data.index(b"jp2h") - 4
        length = struct.unpack(">I", data[header : header + 4])[0]
        palette = struct.pack(">HB", 2, 1) + bytes([7]) + bytes([0, 255])
        box = struct.pack(">I4s", 8 + len(palette), b"pclr") + palette
        patched = (
            data[:header]
            + struct.pack(">I", length + len(box))
            + data[header + 4 : header + length]
            + box
            + data[header + length :]
        )
        keys = {"/Width": size, "/Height": size, "/Filter": Name("/JPXDecode")}
        src = _pixel_pdf(os.path.join(tmp_dir, "in.pdf"), patched, keys, size, size)
        out = os.path.join(tmp_dir, "out.pdf")

        with pytest.raises(ValueError, match="palette"):
            redact(file=src, output=out, regions=[{"page": 1, "rect": _px_rect(4, 4, 8, 8, size)}])
        assert not os.path.exists(out)


# ── bilevel codecs ────────────────────────────────────────────────────────


class TestCcitt:
    def test_a_group_four_scan_loses_its_marked_pixels(self, tmp_dir):
        """The classic bilevel scan encoding. It comes back as /FlateDecode —
        lossless for a bitmap — with the same /Decode and stencil flag."""
        data, bits = _g4_bits(W, H, (0, 0, W, H // 2))
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            data,
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 1,
                "/Decode": pikepdf.Array([1, 0]),
                "/Filter": Name("/CCITTFaxDecode"),
                "/DecodeParms": Dictionary(K=-1, Columns=W, Rows=H, BlackIs1=False),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        _name, packed, keys = _only_image(out)
        assert keys["/Filter"] == Name("/FlateDecode")
        assert "/DecodeParms" not in keys
        after = _pixels(packed, W, 1, 1, H)
        before = _pixels(bits, W, 1, 1, H)
        for row in range(H):
            for col in range(W):
                marked = row >= H - 2 and col < 2
                # /Decode [1 0] reverses grey, so the sample that RENDERS
                # black is 1.
                assert after[row][col] == (
                    (1,) if marked else before[row][col]
                ), f"pixel {row},{col}"
        assert before[H - 1][0] == (0,), "the marked pixels started as paper"

    def test_a_group_four_stencil(self, tmp_dir):
        """An /ImageMask has no colour space, and the imaging bridge refuses an
        image of that shape outright — the decode goes through a grey view of
        the same bits instead."""
        data, _bits = _g4_bits(W, H, (0, 0, W, H))
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            data,
            {
                "/Width": W,
                "/Height": H,
                "/ImageMask": True,
                "/BitsPerComponent": 1,
                "/Decode": pikepdf.Array([1, 0]),
                "/Filter": Name("/CCITTFaxDecode"),
                "/DecodeParms": Dictionary(K=-1, Columns=W, Rows=H, BlackIs1=False),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        _name, packed, keys = _only_image(out)
        assert keys["/ImageMask"] is True
        assert list(keys["/Decode"]) == [1, 0]
        after = _pixels(packed, W, 1, 1, H)
        # /Decode [1 0] reverses the stencil, so "paints nothing" is stored 0.
        assert after[H - 1][0] == (0,)
        assert after[0][W - 1] == (1,)

    def test_rows_of_the_default_length_that_are_not_the_image_width_refuse(self, tmp_dir):
        """ISO 32000-2 Table 11: an absent /Columns means 1728. Rows of that
        length under an 8-pixel image decode differently in every reader, so
        there is no survivor they all agree on."""
        data, _bits = _g4_bits(W, H, (0, 0, W, H // 2))
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            data,
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 1,
                "/Filter": Name("/CCITTFaxDecode"),
                "/DecodeParms": Dictionary(K=-1, Rows=H, BlackIs1=False),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        with pytest.raises(ValueError, match="row length contradicts the image width"):
            redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])


def _jbig2_available() -> bool:
    from engine.mrc_codecs import jbig2_available

    return jbig2_available()


needs_jbig2 = pytest.mark.skipif(not _jbig2_available(), reason="jbig2enc not vendored")


def _stencil_bitmap(size: int) -> "object":
    from PIL import Image, ImageDraw

    image = Image.new("1", (size, size), 1)
    draw = ImageDraw.Draw(image)
    for line in range(6):
        y = 4 + line * 10
        for word in range(5):
            x = 4 + word * 12
            draw.rectangle([x, y, x + 8, y + 5], fill=0)
    return image


def _jbig2_pdf(path: str, streams: list, size: int) -> str:
    """One page per stencil, each drawn in black at one point per pixel; the
    streams share one symbol dictionary when they carry one."""
    doc = pikepdf.new()
    shared = None
    for stream in streams:
        page = doc.add_blank_page(page_size=(size, size))
        image = doc.make_stream(stream.data)
        image["/Type"] = Name("/XObject")
        image["/Subtype"] = Name("/Image")
        image["/Width"] = size
        image["/Height"] = size
        image["/ImageMask"] = True
        image["/BitsPerComponent"] = 1
        image["/Filter"] = Name("/JBIG2Decode")
        if stream.globals_data:
            if shared is None:
                shared = doc.make_indirect(doc.make_stream(stream.globals_data))
            image["/DecodeParms"] = Dictionary(JBIG2Globals=shared)
        page.Resources = Dictionary(XObject=Dictionary(Im0=image))
        page.Contents = doc.make_stream(f"q 0 g {size} 0 0 {size} 0 0 cm /Im0 Do Q".encode("ascii"))
    doc.save(path)
    doc.close()
    return path


def _render(path: str, gs_path: str, page: int = 1):
    """One page rendered to grey at 72 dpi: one device pixel per point."""
    import tempfile

    from PIL import Image

    with tempfile.TemporaryDirectory(prefix="spectrapdf_test_render_") as work:
        target = os.path.join(work, "p.png")
        subprocess.run(
            [
                gs_path, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-dInterpolateControl=0",
                f"-dFirstPage={page}", f"-dLastPage={page}",
                "-sDEVICE=pnggray", "-r72", f"-sOutputFile={target}", path,
            ],
            check=True,
            stdin=subprocess.DEVNULL,
            capture_output=True,
        )
        with Image.open(target) as image:
            return np.asarray(image.convert("L")).astype(int)


class TestJbig2:
    def test_an_unreadable_stream_refuses_before_any_decoder_runs(self, tmp_dir, gs_absent):
        """A stream whose segments do not add up is refused on its structure:
        the decoder draws whatever it could read of it and reports success."""
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            b"not really a codestream",
            {
                "/Width": W,
                "/Height": H,
                "/ImageMask": True,
                "/BitsPerComponent": 1,
                "/Filter": Name("/JBIG2Decode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="unreadable JBIG2 data"):
            redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])
        assert not os.path.exists(out)

    @needs_jbig2
    def test_a_truncated_stream_refuses(self, tmp_dir):
        from engine.mrc_codecs import JBIG2_GENERIC, encode_masks_jbig2

        size = 64
        [stream] = encode_masks_jbig2([_stencil_bitmap(size)], mode=JBIG2_GENERIC)
        with pytest.raises(codec_taint.TaintError, match="truncated"):
            codec_taint.jbig2_check(stream.data[: len(stream.data) - 8], None, size, size)
        codec_taint.jbig2_check(stream.data, None, size, size)
        with pytest.raises(codec_taint.TaintError, match="height contradicts"):
            codec_taint.jbig2_check(stream.data, None, size, size + 1)

    @needs_jbig2
    def test_a_symbol_stream_without_its_dictionary_refuses(self, tmp_dir):
        from engine.mrc_codecs import JBIG2_SYMBOL, encode_masks_jbig2

        size = 64
        [stream] = encode_masks_jbig2([_stencil_bitmap(size)], mode=JBIG2_SYMBOL)
        assert stream.globals_data
        codec_taint.jbig2_check(stream.data, stream.globals_data, size, size)
        with pytest.raises(codec_taint.TaintError, match="does not carry"):
            codec_taint.jbig2_check(stream.data, None, size, size)

    @needs_jbig2
    def test_without_ghostscript_a_jbig2_image_refuses_by_name(self, tmp_dir, gs_absent):
        from engine import gs_capability
        from engine.mrc_codecs import JBIG2_GENERIC, encode_masks_jbig2

        size = 64
        [stream] = encode_masks_jbig2([_stencil_bitmap(size)], mode=JBIG2_GENERIC)
        src = _jbig2_pdf(os.path.join(tmp_dir, "in.pdf"), [stream], size)
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(gs_capability.GsUnavailable) as caught:
            redact(file=src, output=out, regions=[{"page": 1, "rect": [0, 44, 30, 64]}])
        assert caught.value.reason == gs_capability.NOT_CONFIGURED
        assert not os.path.exists(out)

    @needs_jbig2
    def test_a_stream_the_decoder_complains_about_refuses(self, tmp_dir, gs_path):
        """Well-formed segments, but one the decoder cannot handle: an
        extension flagged necessary. The decoder says so and still exits 0
        with whatever it drew, so its diagnostics are what refuses."""
        from engine.mrc_codecs import JBIG2_GENERIC, encode_masks_jbig2

        size = 64
        [stream] = encode_masks_jbig2([_stencil_bitmap(size)], mode=JBIG2_GENERIC)
        # After the 30-byte page description: segment 7, type 62, page 1,
        # four bytes of data naming an unknown extension marked necessary.
        extension = struct.pack(">IBBBI", 7, 62, 0, 1, 4) + struct.pack(">I", 0x80007FFF)
        data = stream.data[:30] + extension + stream.data[30:]
        codec_taint.jbig2_check(data, None, size, size)
        stream = dataclasses.replace(stream, data=data)
        src = _jbig2_pdf(os.path.join(tmp_dir, "in.pdf"), [stream], size)
        out = os.path.join(tmp_dir, "out.pdf")

        with pytest.raises(ValueError, match="did not decode cleanly"):
            redact(
                file=src, output=out, regions=[{"page": 1, "rect": _px_rect(0, 0, 30, 20, size)}], gs_path=gs_path
            )
        assert not os.path.exists(out)

    @needs_jbig2
    def test_a_jbig2_stencil_loses_only_its_marked_pixels(self, tmp_dir, gs_path):
        from engine.mrc_codecs import JBIG2_GENERIC, encode_masks_jbig2

        size = 64
        [stream] = encode_masks_jbig2([_stencil_bitmap(size)], mode=JBIG2_GENERIC)
        src = _jbig2_pdf(os.path.join(tmp_dir, "in.pdf"), [stream], size)
        out = os.path.join(tmp_dir, "out.pdf")

        # Pixel columns 0..30 of rows 0..20.
        result = redact(
            file=src, output=out, regions=[{"page": 1, "rect": _px_rect(0, 0, 30, 20, size)}], gs_path=gs_path
        )

        assert result["images_modified"] == 1
        _name, _raw, keys = _only_image_raw(out)
        assert keys["/Filter"] == Name("/CCITTFaxDecode")
        before = _render(src, gs_path)
        after = _render(out, gs_path)
        # The black box is painted over the mark; everything else is the
        # stencil exactly as it was.
        outside = np.ones((size, size), bool)
        outside[0:20, 0:30] = False
        assert np.array_equal(after[outside], before[outside])
        assert (before[0:20, 0:30] == 0).any(), "the mark covered ink"

    @needs_jbig2
    def test_a_shared_symbol_dictionary_leaves_the_file(self, tmp_dir, gs_path):
        """The dictionary holds the shapes of every glyph the pages drew,
        including the ones under the mark. Every other image that read it is
        re-encoded without it, so it drops out of the saved file."""
        from engine.mrc_codecs import JBIG2_SYMBOL, encode_masks_jbig2

        size = 64
        streams = encode_masks_jbig2([_stencil_bitmap(size), _stencil_bitmap(size)], mode=JBIG2_SYMBOL)
        assert streams[0].globals_data
        src = _jbig2_pdf(os.path.join(tmp_dir, "in.pdf"), streams, size)
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(
            file=src, output=out, regions=[{"page": 1, "rect": _px_rect(0, 0, 30, 20, size)}], gs_path=gs_path
        )

        assert result["images_modified"] == 1
        with pikepdf.open(out) as pdf:
            filters = {
                str(obj.get("/Filter"))
                for obj in pdf.objects
                if isinstance(obj, pikepdf.Stream) and obj.get("/Subtype") == Name("/Image")
            }
        assert filters == {"/CCITTFaxDecode"}
        assert not _contains_bytes(out, streams[0].globals_data)
        assert np.array_equal(_render(out, gs_path, 2), _render(src, gs_path, 2))


# ── the product's own scans ───────────────────────────────────────────────


def _scan_pdf(path: str, secret: int) -> str:
    """A 100 dpi letter page as one JPEG: lines of word-shaped strokes on
    tinted paper, and a block of `secret`-dependent strokes where the mark
    will go."""
    from PIL import Image, ImageDraw

    width, height = 850, 1100
    image = Image.new("RGB", (width, height), (246, 244, 236))
    draw = ImageDraw.Draw(image)
    for line in range(20):
        y = 60 + line * 48
        for word in range(8):
            x = 60 + word * 95
            draw.rectangle([x, y, x + 70, y + 18], fill=(25, 25, 40))
            draw.rectangle([x + 6, y + 5, x + 64, y + 12], fill=(246, 244, 236))
    draw.rectangle([100, 300, 500, 360], fill=(246, 244, 236))
    for k in range(12):
        x = 120 + k * 30
        draw.rectangle([x, 310, x + 12, 310 + (10 + (k * 7 + secret * 13) % 30)], fill=(25, 25, 40))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=90)
    doc = pikepdf.new()
    page = doc.add_blank_page(page_size=(612, 792))
    stream = doc.make_stream(buffer.getvalue())
    stream["/Type"] = Name("/XObject")
    stream["/Subtype"] = Name("/Image")
    stream["/Width"] = width
    stream["/Height"] = height
    stream["/ColorSpace"] = Name("/DeviceRGB")
    stream["/BitsPerComponent"] = 8
    stream["/Filter"] = Name("/DCTDecode")
    page.Resources = Dictionary(XObject=Dictionary(Im0=stream))
    page.Contents = doc.make_stream(b"q 612 0 0 792 0 0 cm /Im0 Do Q")
    doc.save(path)
    doc.close()
    return path


# Scan pixels (100, 300)-(500, 360), as page points.
_SCAN_MARK = [100 * 0.72, 792 - 360 * 0.72, 500 * 0.72, 792 - 300 * 0.72]


def _stencil_of(path: str, gs_path: str):
    """What the page's stencil paints, rendered on its own: the foreground's
    /Mask drawn in black at one point per mask pixel."""
    import tempfile

    with pikepdf.open(path) as pdf:
        xobjects = pdf.pages[0]["/Resources"]["/XObject"]
        stencil = next(xobjects[k]["/Mask"] for k in xobjects.keys() if isinstance(xobjects[k].get("/Mask"), pikepdf.Stream))
        width, height = int(stencil["/Width"]), int(stencil["/Height"])
        scratch = pikepdf.new()
        copied = scratch.copy_foreign(stencil)
        page = scratch.add_blank_page(page_size=(width, height))
        page.Resources = Dictionary(XObject=Dictionary(Im0=copied))
        page.Contents = scratch.make_stream(f"q 0 g {width} 0 0 {height} 0 0 cm /Im0 Do Q".encode("ascii"))
        with tempfile.TemporaryDirectory(prefix="spectrapdf_test_stencil_") as work:
            target = os.path.join(work, "stencil.pdf")
            scratch.save(target)
            return _render(target, gs_path), (width, height)


class TestMrcScans:
    VARIANTS = {
        "jbig2": {},
        "ccitt": {"mrc_mask_codec": "ccitt"},
        "pdfa-safe": {"mrc_pdfa_safe": True},
    }

    @pytest.mark.parametrize("variant", sorted(VARIANTS))
    def test_a_marked_band_keeps_every_stroke_outside_it(self, tmp_dir, gs_path, variant):
        """The reported defect on the product's own output. The text lives in
        a full-resolution stencil under one foreground colour, so the stencil
        is what loses the marked strokes; every stroke outside the mark is
        drawn exactly as before."""
        from engine.compress import compress

        if variant == "jbig2" and not _jbig2_available():
            pytest.skip("jbig2enc not vendored")
        src = _scan_pdf(os.path.join(tmp_dir, "scan.pdf"), 1)
        mrc = os.path.join(tmp_dir, "mrc.pdf")
        compress(src, mrc, quality="mrc", gs_path=gs_path, **self.VARIANTS[variant])
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=mrc, output=out, regions=[{"page": 1, "rect": _SCAN_MARK}], gs_path=gs_path)

        before, (width, height) = _stencil_of(mrc, gs_path)
        after, _size = _stencil_of(out, gs_path)
        spans = image_redact.pixel_spans((612, 0, 0, 792, 0, 0), [tuple(_SCAN_MARK)], width, height)
        touched = np.zeros((height, width), bool)
        for row, lo, hi in spans:
            touched[row, lo:hi] = True
        assert np.array_equal(after[~touched], before[~touched]), "a stroke outside the mark changed"
        assert (before[touched] == 0).any(), "the mark covered strokes"
        assert (after[touched] == 255).all(), "a marked stroke survived"
        assert result["images_modified"] == 2
        assert result["images_removed"] == 0
        assert result["images_removed_for_compression"] == 0

    def test_two_scans_that_differ_only_under_the_mark_redact_to_the_same_images(self, tmp_dir, gs_path):
        from engine.compress import compress

        payloads = []
        for secret in (1, 2):
            src = _scan_pdf(os.path.join(tmp_dir, f"scan{secret}.pdf"), secret)
            mrc = os.path.join(tmp_dir, f"mrc{secret}.pdf")
            compress(src, mrc, quality="mrc", gs_path=gs_path, mrc_pdfa_safe=True)
            out = os.path.join(tmp_dir, f"out{secret}.pdf")
            redact(file=mrc, output=out, regions=[{"page": 1, "rect": _SCAN_MARK}], gs_path=gs_path)
            with pikepdf.open(out) as pdf:
                xobjects = pdf.pages[0]["/Resources"]["/XObject"]
                images = []
                for key in sorted(xobjects.keys()):
                    obj = xobjects[key]
                    images.append(bytes(obj.read_raw_bytes()))
                    if isinstance(obj.get("/Mask"), pikepdf.Stream):
                        images.append(bytes(obj["/Mask"].read_raw_bytes()))
            payloads.append(images)
        assert payloads[0] == payloads[1]


# ── inline images ─────────────────────────────────────────────────────────


class TestInlineImages:
    def test_a_partly_marked_inline_image_keeps_its_unmarked_pixels(self, tmp_dir):
        """It comes back as an image XObject drawn by `Do`: the imaging bridge
        cannot build an inline image carrying new data. Same unit square, same
        CTM, so the placement is unchanged."""
        raw = _unique_rgb()
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        page.Contents = doc.make_stream(
            b"q 80 0 0 80 10 10 cm BI /W 8 /H 8 /CS /RGB /BPC 8 ID " + raw + b" EI Q"
        )
        src = os.path.join(tmp_dir, "in.pdf")
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        assert result["images_removed"] == 0
        _name, data, keys = _only_image(out)
        assert keys["/ColorSpace"] == Name("/DeviceRGB")
        assert keys["/Width"] == W
        after = _pixels(data, W, 3, 8, H)
        assert after[H - 1][0] == (0, 0, 0)
        assert after[0][W - 1] == (7, 200, 100)
        with pikepdf.open(out) as pdf:
            body = bytes(pikepdf.Page(pdf.pages[0]).obj["/Contents"].read_bytes())
        assert b"BI" not in body
        assert not _contains_bytes(out, raw[6 * W * 3 : 6 * W * 3 + 6])

    def test_a_fully_marked_inline_image_is_dropped_as_before(self, tmp_dir):
        raw = _unique_rgb()
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        page.Contents = doc.make_stream(
            b"q 80 0 0 80 10 10 cm BI /W 8 /H 8 /CS /RGB /BPC 8 ID " + raw + b" EI Q"
        )
        src = os.path.join(tmp_dir, "in.pdf")
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [0, 0, 100, 100]}])

        assert result["images_removed"] == 1
        assert result["images_modified"] == 0
        assert not _contains_bytes(out, raw[:9])

    def test_a_flate_compressed_inline_image(self, tmp_dir):
        raw = _unique_gray()
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        page.Contents = doc.make_stream(
            b"q 80 0 0 80 10 10 cm BI /W 8 /H 8 /CS /G /BPC 8 /F /Fl ID "
            + zlib.compress(raw)
            + b" EI Q"
        )
        src = os.path.join(tmp_dir, "in.pdf")
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        _name, data, _keys = _only_image(out)
        after = _pixels(data, W, 1, 8, H)
        assert after[H - 1][0] == (0,)
        assert after[0][W - 1] == (7,)


# ── forms ─────────────────────────────────────────────────────────────────


class TestInsideForms:
    def test_an_image_drawn_by_a_form_is_redacted_on_the_form_copy(self, tmp_dir):
        """A form stamped on two pages must lose pixels only where it was
        marked; the original form and its image stay intact for the other
        page."""
        doc = pikepdf.new()
        image = _mask_stream(
            doc,
            zlib.compress(_unique_rgb()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
        )
        form = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        form["/Type"] = Name("/XObject")
        form["/Subtype"] = Name("/Form")
        form["/BBox"] = pikepdf.Array([0, 0, 100, 100])
        form["/Resources"] = Dictionary(XObject=Dictionary(Im0=image))
        shared = doc.make_indirect(form)
        for _ in range(2):
            page = doc.add_blank_page(page_size=(100, 100))
            page.Resources = Dictionary(XObject=Dictionary(Fm0=shared))
            page.Contents = doc.make_stream(b"/Fm0 Do")
        src = os.path.join(tmp_dir, "in.pdf")
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        with pikepdf.open(out) as pdf:
            first = pdf.pages[0]["/Resources"]["/XObject"]
            copy_name = next(k for k in first.keys() if str(k).startswith("/RdxFm"))
            inner = first[copy_name]["/Resources"]["/XObject"]
            names = sorted(str(k) for k in inner.keys())
            assert names == ["/RdxIm0"], names
            edited = _pixels(bytes(inner[Name("/RdxIm0")].read_bytes()), W, 3, 8, H)
            second = pdf.pages[1]["/Resources"]["/XObject"][Name("/Fm0")]
            original = second["/Resources"]["/XObject"][Name("/Im0")]
            untouched = _pixels(bytes(original.read_bytes()), W, 3, 8, H)
        assert edited[H - 1][0] == (0, 0, 0)
        assert edited[0][W - 1] == (7, 200, 100)
        assert untouched[H - 1][0] == ((H - 1) * 16, 200, 100)


# ── limits and refusals ───────────────────────────────────────────────────


class TestBounds:
    def test_an_image_larger_than_partial_redaction_decodes_refuses(self, tmp_dir, monkeypatch):
        monkeypatch.setattr(image_redact, "MAX_DECODED_BYTES", 100)
        src = _flate_rgb_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="more than partial redaction decodes"):
            redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])
        assert not os.path.exists(out)

    def test_a_stream_that_inflates_past_the_bound_refuses_as_it_decodes(self, tmp_dir, monkeypatch):
        """The dictionary says 8x8; the data says two megabytes. The count is
        taken as the data decodes, so the stream is refused before it is held."""
        monkeypatch.setattr(image_redact, "MAX_DECODED_BYTES", 1_000_000)
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(bytes(2_000_000)),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="decodes larger than partial redaction holds"):
            redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])


class TestRefusals:
    @pytest.mark.parametrize(
        "filter_name,reason",
        [("/JPXDecode", "JPEG 2000"), ("/JBIG2Decode", "JBIG2")],
    )
    def test_an_unreadable_codestream_refuses_by_name(self, tmp_dir, filter_name, reason):
        """Never a blanked page and never a success report: a codestream whose
        round trip cannot be stated says so, and says which image to mark in
        full."""
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            b"not really a codestream",
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name(filter_name),
            },
        )
        before = open(src, "rb").read()
        out = os.path.join(tmp_dir, "out.pdf")

        with pytest.raises(ValueError) as caught:
            redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        message = str(caught.value)
        assert message.startswith("This image cannot be partly redacted (")
        assert reason in message
        assert message.endswith("Mark the whole image to remove it.")
        assert open(src, "rb").read() == before
        assert not os.path.exists(out)

    def test_a_fully_covered_undecodable_image_still_removes_whole(self, tmp_dir):
        """A whole-cover mark needs no decode at all, so the codec never comes
        into it."""
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            b"not really a codestream",
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/JPXDecode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [0, 0, 100, 100]}])

        assert result["images_removed"] == 1
        assert not _contains_bytes(out, b"not really a codestream")

    def test_truncated_sample_data_refuses(self, tmp_dir):
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_gray()[: W * H // 2]),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceGray"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="shorter than its declared size"):
            redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

    def test_an_unreadable_colour_space_refuses(self, tmp_dir):
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            zlib.compress(_unique_gray()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/NotAColourSpace"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
        )
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="colour space"):
            redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

    def test_a_named_colour_space_resolves_from_the_page_resources(self, tmp_dir):
        """The lenient half of the same rule: `/CS0` defined in /Resources is
        readable, so the image is redacted rather than refused."""
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        stream = _mask_stream(
            doc,
            zlib.compress(_unique_gray()),
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/CS0"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/FlateDecode"),
            },
        )
        page.Resources = Dictionary(
            XObject=Dictionary(Im0=stream),
            ColorSpace=Dictionary(CS0=Name("/DeviceGray")),
        )
        page.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        src = os.path.join(tmp_dir, "in.pdf")
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert result["images_modified"] == 1
        _name, data, _keys = _only_image(out)
        assert _pixels(data, W, 1, 8, H)[H - 1][0] == (0,)

    def test_an_in_place_refusal_leaves_the_file_byte_identical(self, tmp_dir):
        """The in-place write stages to a temporary file and renames. A refusal
        must come BEFORE any of that, or the user's only copy is the casualty
        of a redaction that did not happen."""
        src = _image_pdf(
            os.path.join(tmp_dir, "in.pdf"),
            b"not really a codestream",
            {
                "/Width": W,
                "/Height": H,
                "/ColorSpace": Name("/DeviceRGB"),
                "/BitsPerComponent": 8,
                "/Filter": Name("/JPXDecode"),
            },
        )
        before = open(src, "rb").read()

        with pytest.raises(ValueError, match="JPEG 2000"):
            redact(file=src, output=src, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        assert open(src, "rb").read() == before
        assert sorted(os.listdir(tmp_dir)) == ["in.pdf"]


class TestPageThumbnail:
    def test_a_page_thumbnail_does_not_survive_the_redaction(self, tmp_dir):
        """/Thumb is a raster of the page as it WAS, so a content-stream
        rewrite leaves it showing exactly what was removed — extractable from
        the saved file whether or not any viewer draws it."""
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        keys = {
            "/Width": W,
            "/Height": H,
            "/ColorSpace": Name("/DeviceRGB"),
            "/BitsPerComponent": 8,
            "/Filter": Name("/FlateDecode"),
        }
        stream = _mask_stream(doc, zlib.compress(_unique_rgb()), keys)
        thumb = _mask_stream(doc, zlib.compress(_unique_rgb()), keys)
        page.Resources = Dictionary(XObject=Dictionary(Im0=stream))
        page.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        page.obj["/Thumb"] = thumb
        src = os.path.join(tmp_dir, "in.pdf")
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 30, 30]}])

        with pikepdf.open(out) as pdf:
            assert "/Thumb" not in pdf.pages[0].obj
        assert not _contains_bytes(out, _unique_rgb())
