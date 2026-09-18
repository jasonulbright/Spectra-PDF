"""Which decoded pixels of a lossy image DEPEND on a given set of pixels.

A partial redaction keeps every pixel it does not destroy. For a lossless codec
that is exactly the pixels outside the mark. For a transform codec it is not:
the ORIGINAL encoder mixed pixels together before quantizing, and the decoder
mixes them again on the way out, so a pixel just outside the mark can carry
the colour, the edge, or the energy of what was inside it. A survivor like that
hands back part of the secret — the property a redaction must hold is that no
surviving pixel depends on the destroyed ones.

This module answers, from the codestream's own headers, which pixels those
are, so the caller can destroy them too and say that it did.

JPEG (ISO/IEC 10918-1)
  - Every component is quantized in 8x8 blocks of ITS OWN samples; a block's
    decoded samples all depend on all of its source samples.
  - A subsampled component's sample covers fx x fy pixels (fx = Hmax/H), so
    its block covers 8*fx x 8*fy pixels — a 16x16 MCU for 4:2:0.
  - The decoder upsamples subsampled components with a filter that reaches
    one sample beyond the pixel's own; the reference decoder's triangle
    filter reaches exactly one output pixel, and fx - 1 bounds it in general.
  - The encoder's own pre-filter (the reference encoder's smoothing option)
    reaches one source pixel beyond a sample's footprint.
  So a component block is tainted when its pixel footprint, grown by that one
  pixel, meets the marked pixels; every pixel within the upsampling reach of a
  tainted block is tainted.

JPEG 2000 (ISO/IEC 15444-1, carried by /JPXDecode — ISO 32000-2 §7.4.9)
  - The wavelet mixes a coefficient at decomposition level d from source
    samples within h*(2^d - 1) of it (h = 2 for the 5/3 filter, 4 for the
    9/7), and synthesis mixes it back out over the same reach.
  - A FIXED-QUALITY codestream (every included code-block coded to its last
    pass, every packet present) carries nothing else: each coefficient is
    coded from its own value alone, whether exactly (5/3) or through the
    subband's fixed quantizer step (9/7), and a block left out whole is one
    whose every coefficient coded to zero. Its survivors depend on the mark
    only through the filter reach, and the redaction is exact.
  - A RATE-CONTROLLED codestream picks each code-block's truncation point
    against one threshold chosen for the whole picture, and a codestream cut
    short of its last packet stops wherever the byte budget ran out.
    Measured on the product's own MRC background, replacing a 120x60 area with
    noise instead of a flat colour moved the truncation of 676 code-blocks the
    area never reached and changed 90% of the image's pixels by up to 16
    levels, 500 pixels and more from it. Every pixel of such an image depends
    on the marked area, so no part of it is kept: `jpx_taint` answers None and
    the caller removes the image whole, saying so.
  The packet headers say how many passes each code-block kept; the zero-bit-
  plane tag trees and the quantization exponents say how many it could have.
  Rate control shows as truncation: measured on the reference encoder at
  ratios 2 to 200 and PSNR targets 30 to 60 dB, every such codestream stopped
  at least one included block short, including those that also left blocks
  out whole.

What the JPEG model cannot see: an encoder that chose its quantization tables
from the whole picture (a table sized to hit a byte budget) wrote a few bits of
whole-image statistics into every pixel. A fixed-quality encoder, the
reference library's among them, does not.

JBIG2 (ITU-T T.88, carried by /JBIG2Decode — ISO 32000-2 §7.4.7) is decoded
exactly, so it has no reach to model; `jbig2_check` instead refuses the
streams a decoder would read as something other than what they hold. What
exact decoding does not remove: symbol coding draws every instance of a glyph
class with ONE bitmap the encoder chose — the reference encoder takes the
first instance on the page — so a glyph outside the mark can be drawn with
the bitmap of an instance under it (measured: 32 to 40 pixels outside a mark
change with the noise of the one glyph under it). The kept stencil is what
every reader draws there; the dictionary itself leaves the file.
"""

from __future__ import annotations

import struct
from typing import NamedTuple

# ── shared ────────────────────────────────────────────────────────────────


class TaintError(ValueError):
    """The codestream uses a feature the dependency model does not read; the
    caller turns this into a named refusal, never into a guess."""


def _merge(intervals: list) -> list:
    out: list = []
    for lo, hi in sorted(intervals):
        if out and lo <= out[-1][1]:
            if hi > out[-1][1]:
                out[-1] = (out[-1][0], hi)
        else:
            out.append((lo, hi))
    return out


def rects_to_spans(rects, width: int, height: int) -> tuple:
    """Pixel rectangles `(x0, y0, x1, y1)` (exclusive ends) as row spans."""
    rows: dict = {}
    for x0, y0, x1, y1 in rects:
        x0 = max(int(x0), 0)
        y0 = max(int(y0), 0)
        x1 = min(int(x1), width)
        y1 = min(int(y1), height)
        if x1 <= x0 or y1 <= y0:
            continue
        for row in range(y0, y1):
            rows.setdefault(row, []).append((x0, x1))
    spans: list = []
    for row in sorted(rows):
        for lo, hi in _merge(rows[row]):
            spans.append((row, lo, hi))
    return tuple(spans)


def span_rows(spans) -> dict:
    rows: dict = {}
    for row, lo, hi in spans:
        rows.setdefault(row, []).append((lo, hi))
    return rows


def spans_to_rects(spans) -> list:
    """Row spans as rectangles `(x0, y0, x1, y1)`, exclusive ends: each run
    of consecutive rows that share an interval becomes one rectangle, so a
    marked band thousands of rows tall costs one entry, not one per row."""
    rows = span_rows(spans)
    out: list = []
    open_runs: dict = {}  # interval -> first row of its run
    previous = None
    for row in sorted(rows):
        if previous is not None and row != previous + 1:
            out.extend((lo, start, hi, previous + 1) for (lo, hi), start in open_runs.items())
            open_runs = {}
        current: dict = {}
        for interval in _merge(rows[row]):
            current[interval] = open_runs.pop(interval, row)
        out.extend((lo, start, hi, row) for (lo, hi), start in open_runs.items())
        open_runs = current
        previous = row
    if previous is not None:
        out.extend((lo, start, hi, previous + 1) for (lo, hi), start in open_runs.items())
    return out


def snap_to_blocks(spans, block: int, width: int, height: int) -> tuple:
    """Grow spans to whole `block`-aligned squares."""
    bands: dict = {}
    for row, col0, col1 in spans:
        band = (row // block) * block
        bands.setdefault(band, []).append(
            (col0 - col0 % block, min(((col1 + block - 1) // block) * block, width))
        )
    out: list = []
    for band in sorted(bands):
        for lo, hi in _merge(bands[band]):
            for row in range(band, min(band + block, height)):
                out.append((row, lo, hi))
    return tuple(out)


# ── JPEG ──────────────────────────────────────────────────────────────────

# SOF markers this model reads. Lossless (C3, C7, CB, CF) and hierarchical
# (C5-C7, CD-CF) processes are not DCT-per-block in the same sense and refuse.
_SOF_DCT = {0xC0: "baseline", 0xC1: "extended", 0xC2: "progressive", 0xC9: "arithmetic", 0xCA: "arithmetic progressive"}
_SOF_OTHER = {0xC3, 0xC5, 0xC6, 0xC7, 0xCB, 0xCD, 0xCE, 0xCF}
_ENCODER_REACH = 1


class JpegComponent(NamedTuple):
    ident: int
    h: int
    v: int


class JpegLayout(NamedTuple):
    width: int
    height: int
    precision: int
    components: tuple
    adobe: bool
    adobe_transform: int  # -1 when the APP14 segment is absent
    adobe_segment: bytes  # the whole APP14 marker segment, for re-attachment


def jpeg_layout(data: bytes) -> JpegLayout:
    """The frame header and the Adobe APP14 segment, read up to the first scan."""
    if len(data) < 4 or data[0:2] != b"\xff\xd8":
        raise TaintError("not a JPEG stream")
    index = 2
    adobe = False
    transform = -1
    adobe_segment = b""
    frame = None
    size = len(data)
    while index < size:
        if data[index] != 0xFF:
            raise TaintError("a JPEG marker was expected")
        while index < size and data[index] == 0xFF:
            index += 1
        if index >= size:
            break
        marker = data[index]
        index += 1
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        if marker == 0xD9:
            break
        if index + 2 > size:
            raise TaintError("a truncated JPEG header")
        length = struct.unpack(">H", data[index : index + 2])[0]
        payload = data[index + 2 : index + length]
        start = index - 2
        index += length
        if marker == 0xEE and payload.startswith(b"Adobe"):
            adobe = True
            transform = payload[11] if len(payload) >= 12 else -1
            adobe_segment = data[start:index]
        elif marker in _SOF_OTHER:
            raise TaintError("a lossless or hierarchical JPEG")
        elif marker in _SOF_DCT:
            if len(payload) < 6:
                raise TaintError("a truncated JPEG frame header")
            precision = payload[0]
            height, width = struct.unpack(">HH", payload[1:5])
            count = payload[5]
            components = []
            for k in range(count):
                base = 6 + 3 * k
                if base + 3 > len(payload):
                    raise TaintError("a truncated JPEG frame header")
                sampling = payload[base + 1]
                components.append(JpegComponent(payload[base], sampling >> 4, sampling & 0x0F))
            frame = (width, height, precision, tuple(components))
        elif marker == 0xDA:
            break
    if frame is None:
        raise TaintError("a JPEG without a frame header")
    width, height, precision, components = frame
    if height == 0:
        raise TaintError("a JPEG whose height is given after the first scan")
    return JpegLayout(width, height, precision, components, adobe, transform, adobe_segment)


def jpeg_taint(layout: JpegLayout, spans, width: int, height: int) -> tuple:
    """The pixels whose DECODED value depends on any pixel in `spans`, snapped
    outward to the 8x8 grid the re-encode writes (it writes 4:4:4, so every
    component's block is 8x8 pixels there)."""
    if not layout.components:
        raise TaintError("a JPEG without components")
    hmax = max(c.h for c in layout.components)
    vmax = max(c.v for c in layout.components)
    rects: list = []
    marked = spans_to_rects(spans)
    for component in layout.components:
        if component.h <= 0 or component.v <= 0 or hmax % component.h or vmax % component.v:
            raise TaintError("a JPEG with fractional chroma sampling")
        fx = hmax // component.h
        fy = vmax // component.v
        block_w, block_h = 8 * fx, 8 * fy
        reach_x, reach_y = fx - 1, fy - 1
        # The blocks a rectangle meets form a rectangle of blocks, so each
        # marked rectangle taints one rectangle per component.
        for x0, y0, x1, y1 in marked:
            first_x = max(x0 - _ENCODER_REACH, 0) // block_w
            first_y = max(y0 - _ENCODER_REACH, 0) // block_h
            last_x = (min(x1 + _ENCODER_REACH, width) - 1) // block_w
            last_y = (min(y1 + _ENCODER_REACH, height) - 1) // block_h
            rects.append(
                (
                    first_x * block_w - reach_x,
                    first_y * block_h - reach_y,
                    (last_x + 1) * block_w + reach_x,
                    (last_y + 1) * block_h + reach_y,
                )
            )
    tainted = rects_to_spans(rects, width, height)
    return snap_to_blocks(tainted, 8, width, height)


# ── JPEG 2000 ─────────────────────────────────────────────────────────────


class JpxColour(NamedTuple):
    method: int  # 0 = no colr box, 1 = enumerated, 2/3 = ICC
    enumerated: int  # EnumCS when method == 1
    icc: bytes  # the profile when method is 2 or 3
    palette: bool  # a pclr / cmap box: samples are indices, not colours
    opacity: bool  # a cdef box names an opacity channel


class _CodingStyle(NamedTuple):
    scod: int
    progression: int
    layers: int
    mct: int
    levels: int
    xcb: int
    ycb: int
    cbstyle: int
    transform: int
    precincts: tuple  # per resolution (ppx, ppy)


class _Quant(NamedTuple):
    guard: int
    exponents: tuple  # per subband, in codestream order


class JpxLayout(NamedTuple):
    width: int
    height: int
    x_origin: int
    y_origin: int
    tile_w: int
    tile_h: int
    tile_x0: int
    tile_y0: int
    components: tuple  # ((precision, signed, xr, yr), ...)
    colour: JpxColour
    blocks: dict  # (tile, comp, res, band, bx, by) -> (passes, max_passes)
    styles: dict  # (tile, comp) -> _CodingStyle
    codestream: bytes
    complete: bool  # every packet the progression calls for is present


def _boxes(data: bytes, start: int = 0, end: int | None = None):
    end = len(data) if end is None else end
    index = start
    while index + 8 <= end:
        length, kind = struct.unpack(">I4s", data[index : index + 8])
        header = 8
        if length == 1:
            if index + 16 > end:
                raise TaintError("a truncated JP2 box")
            length = struct.unpack(">Q", data[index + 8 : index + 16])[0]
            header = 16
        elif length == 0:
            length = end - index
        if length < header or index + length > end:
            raise TaintError("a malformed JP2 box")
        yield kind, index + header, index + length
        index += length


def jpx_split(data: bytes) -> tuple:
    """`(codestream, colour)` from a JP2/JPX file or a bare codestream.

    Of several colour specifications, the one with the highest precedence and
    then the best approximation is the image's (ISO 32000-2 §7.4.9)."""
    if data[:2] == b"\xff\x4f":
        return data, JpxColour(0, 0, b"", False, False)
    method, enumerated, icc = 0, 0, b""
    ranked: list = []
    palette = opacity = False
    codestream = None
    for kind, body, end in _boxes(data):
        if kind == b"jp2h":
            for sub, sbody, send in _boxes(data, body, end):
                if sub == b"colr" and send - sbody >= 3:
                    meth = data[sbody]
                    precedence = struct.unpack(">b", data[sbody + 1 : sbody + 2])[0]
                    approximation = data[sbody + 2] or 5  # 0 is "not specified"
                    if meth == 1 and send - sbody >= 7:
                        spec = (1, struct.unpack(">I", data[sbody + 3 : sbody + 7])[0], b"")
                    elif meth in (2, 3):
                        spec = (meth, 0, bytes(data[sbody + 3 : send]))
                    else:
                        continue
                    ranked.append((-precedence, approximation, len(ranked), spec))
                elif sub in (b"pclr", b"cmap"):
                    palette = True
                elif sub == b"cdef":
                    count = struct.unpack(">H", data[sbody : sbody + 2])[0]
                    for k in range(count):
                        entry = data[sbody + 2 + 6 * k : sbody + 8 + 6 * k]
                        if len(entry) == 6 and struct.unpack(">HHH", entry)[1] in (1, 2):
                            opacity = True
        elif kind == b"jp2c":
            codestream = bytes(data[body:end])
    if codestream is None:
        raise TaintError("a JPX file without a codestream")
    if ranked:
        method, enumerated, icc = min(ranked)[3]
    return codestream, JpxColour(method, enumerated, icc, palette, opacity)


class _Bits:
    """The packet-header bit reader: MSB first, and a byte following 0xFF
    carries only seven bits (T.800 B.10.1)."""

    __slots__ = ("data", "pos", "end", "byte", "left", "last")

    def __init__(self, data: bytes, pos: int, end: int):
        self.data = data
        self.pos = pos
        self.end = end
        self.byte = 0
        self.left = 0
        self.last = 0

    def bit(self) -> int:
        if self.left == 0:
            if self.pos >= self.end:
                raise TaintError("a truncated JPX packet header")
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

    def align(self) -> int:
        """The byte position after the header, skipping the stuffed byte that
        follows a final 0xFF."""
        self.left = 0
        if self.last == 0xFF:
            self.pos += 1
            self.last = 0
        return self.pos


class _TagTree:
    """T.800 B.10.2 tag tree, decoded exactly as the reference decoder does."""

    __slots__ = ("levels",)

    def __init__(self, width: int, height: int):
        self.levels = []
        w, h = max(width, 1), max(height, 1)
        while True:
            self.levels.append((w, h, [0] * (w * h), [1 << 30] * (w * h)))
            if w == 1 and h == 1:
                break
            w, h = (w + 1) // 2, (h + 1) // 2

    def decode(self, bits: _Bits, x: int, y: int, threshold: int) -> bool:
        path = []
        for w, _h, lows, values in self.levels:
            path.append((lows, values, y * w + x))
            x //= 2
            y //= 2
        low = 0
        lows = values = None
        index = 0
        for lows, values, index in reversed(path):
            if low > lows[index]:
                lows[index] = low
            else:
                low = lows[index]
            while low < threshold and low < values[index]:
                if bits.bit():
                    values[index] = low
                else:
                    low += 1
            lows[index] = low
        return values[index] < threshold


def _num_passes(bits: _Bits) -> int:
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


def _floor_log2(value: int) -> int:
    return value.bit_length() - 1


def _ceil_div(a: int, b: int) -> int:
    return -((-a) // b)


def _read_cod(payload: bytes, main: bool) -> _CodingStyle:
    if main:
        scod = payload[0]
        progression, layers, mct = payload[1], struct.unpack(">H", payload[2:4])[0], payload[4]
        rest = payload[5:]
    else:
        scod, progression, layers, mct, rest = payload[0], 0, 0, 0, payload[1:]
    levels, xcb, ycb, cbstyle, transform = rest[0], rest[1] + 2, rest[2] + 2, rest[3], rest[4]
    if scod & 0x01:
        precincts = tuple((b & 0x0F, b >> 4) for b in rest[5 : 5 + levels + 1])
        if len(precincts) != levels + 1:
            raise TaintError("a truncated JPX coding style")
    else:
        precincts = tuple((15, 15) for _ in range(levels + 1))
    return _CodingStyle(scod, progression, layers, mct, levels, xcb, ycb, cbstyle, transform, precincts)


def _read_quant(payload: bytes) -> _Quant:
    sq = payload[0]
    guard = sq >> 5
    style = sq & 0x1F
    body = payload[1:]
    if style == 0:
        return _Quant(guard, tuple(b >> 3 for b in body))
    if style == 1:
        if len(body) < 2:
            raise TaintError("a truncated JPX quantization")
        return _Quant(guard, (struct.unpack(">H", body[:2])[0] >> 11,))
    if style == 2:
        return _Quant(
            guard,
            tuple(struct.unpack(">H", body[k : k + 2])[0] >> 11 for k in range(0, len(body) - 1, 2)),
        )
    raise TaintError("an unknown JPX quantization style")


def _exponent(quant: _Quant, levels: int, band_index: int, level: int) -> int:
    """The subband's exponent: band 0 is LL, then HL, LH, HH per resolution.
    Scalar-derived quantization states only the LL exponent (T.800 E-5)."""
    if len(quant.exponents) == 1 and band_index > 0:
        return quant.exponents[0] - levels + level
    if band_index >= len(quant.exponents):
        raise TaintError("a JPX quantization shorter than its subbands")
    return quant.exponents[band_index]


def jpx_layout(data: bytes) -> JpxLayout:
    """Parse the codestream down to one fact per code-block: how many coding
    passes it kept, and how many it could have kept."""
    codestream, colour = jpx_split(data)
    if codestream[:2] != b"\xff\x4f":
        raise TaintError("a JPX codestream without SOC")
    index = 2
    size = len(codestream)
    siz = None
    main_cod = None
    main_coc: dict = {}
    main_qcd = None
    main_qcc: dict = {}
    tile_parts: dict = {}
    tile_headers: dict = {}
    csiz = 0
    while index + 2 <= size:
        marker = struct.unpack(">H", codestream[index : index + 2])[0]
        if marker == 0xFFD9:
            break
        if marker == 0xFF90:
            length = struct.unpack(">H", codestream[index + 2 : index + 4])[0]
            isot, psot, tpsot, _tnsot = struct.unpack(">HIBB", codestream[index + 4 : index + 12])
            header_start = index
            index += 2 + length
            cod = coc = qcd = None
            cocs: dict = {}
            qccs: dict = {}
            while True:
                if index + 2 > size:
                    raise TaintError("a truncated JPX tile-part header")
                sub = struct.unpack(">H", codestream[index : index + 2])[0]
                if sub == 0xFF93:
                    index += 2
                    break
                sublen = struct.unpack(">H", codestream[index + 2 : index + 4])[0]
                body = codestream[index + 4 : index + 2 + sublen]
                if sub == 0xFF52:
                    cod = _read_cod(body, True)
                elif sub == 0xFF53:
                    comp = body[0] if csiz < 257 else struct.unpack(">H", body[:2])[0]
                    cocs[comp] = _read_cod(body[1 if csiz < 257 else 2 :], False)
                elif sub == 0xFF5C:
                    qcd = _read_quant(body)
                elif sub == 0xFF5D:
                    comp = body[0] if csiz < 257 else struct.unpack(">H", body[:2])[0]
                    qccs[comp] = _read_quant(body[1 if csiz < 257 else 2 :])
                elif sub in (0xFF5E,):
                    raise TaintError("a JPX region of interest")
                elif sub in (0xFF5F,):
                    raise TaintError("a JPX progression order change")
                elif sub in (0xFF61,):
                    raise TaintError("JPX packed packet headers")
                index += 2 + sublen
            if psot:
                end = header_start + psot
            else:
                # A zero length means the tile-part runs to EOC.
                end = size - 2 if codestream[size - 2 : size] == b"\xff\xd9" else size
            if end > size or end < index:
                raise TaintError("a JPX tile-part longer than the codestream")
            header = tile_headers.setdefault(isot, {"cod": None, "cocs": {}, "qcd": None, "qccs": {}})
            if tpsot == 0:
                header["cod"] = cod
                header["cocs"] = cocs
                header["qcd"] = qcd
                header["qccs"] = qccs
            tile_parts.setdefault(isot, []).append((tpsot, codestream[index:end]))
            index = end
            continue
        length = struct.unpack(">H", codestream[index + 2 : index + 4])[0]
        body = codestream[index + 4 : index + 2 + length]
        if marker == 0xFF51:
            (_rsiz, xsiz, ysiz, xosiz, yosiz, xtsiz, ytsiz, xtosiz, ytosiz, csiz) = struct.unpack(
                ">HIIIIIIIIH", body[:36]
            )
            components = []
            for k in range(csiz):
                ssiz, xr, yr = body[36 + 3 * k : 39 + 3 * k]
                components.append(((ssiz & 0x7F) + 1, bool(ssiz & 0x80), xr, yr))
            siz = (xsiz, ysiz, xosiz, yosiz, xtsiz, ytsiz, xtosiz, ytosiz, tuple(components))
        elif marker == 0xFF52:
            main_cod = _read_cod(body, True)
        elif marker == 0xFF53:
            comp = body[0] if csiz < 257 else struct.unpack(">H", body[:2])[0]
            main_coc[comp] = _read_cod(body[1 if csiz < 257 else 2 :], False)
        elif marker == 0xFF5C:
            main_qcd = _read_quant(body)
        elif marker == 0xFF5D:
            comp = body[0] if csiz < 257 else struct.unpack(">H", body[:2])[0]
            main_qcc[comp] = _read_quant(body[1 if csiz < 257 else 2 :])
        elif marker == 0xFF5E:
            raise TaintError("a JPX region of interest")
        elif marker == 0xFF5F:
            raise TaintError("a JPX progression order change")
        elif marker == 0xFF60:
            raise TaintError("JPX packed packet headers")
        elif marker in (0xFF50, 0xFF59):
            raise TaintError("a JPX extended-capability codestream")
        index += 2 + length
    if siz is None or main_cod is None or main_qcd is None:
        raise TaintError("a JPX codestream without its main header")
    xsiz, ysiz, xosiz, yosiz, xtsiz, ytsiz, xtosiz, ytosiz, components = siz
    tiles_x = _ceil_div(xsiz - xtosiz, xtsiz)
    tiles_y = _ceil_div(ysiz - ytosiz, ytsiz)

    blocks: dict = {}
    styles: dict = {}
    complete = True
    for tile in range(tiles_x * tiles_y):
        parts = sorted(tile_parts.get(tile, []))
        stream = b"".join(part for _n, part in parts)
        header = tile_headers.get(tile, {"cod": None, "cocs": {}, "qcd": None, "qccs": {}})
        tile_cod = header["cod"] or main_cod
        p, q = tile % tiles_x, tile // tiles_x
        tx0 = max(xtosiz + p * xtsiz, xosiz)
        ty0 = max(ytosiz + q * ytsiz, yosiz)
        tx1 = min(xtosiz + (p + 1) * xtsiz, xsiz)
        ty1 = min(ytosiz + (q + 1) * ytsiz, ysiz)
        comp_styles = []
        comp_quants = []
        for c in range(len(components)):
            # T.800 A.6: tile-part COC, then tile-part COD, then main COC, then
            # main COD; a COC carries only its own precinct flag, so SOP/EPH,
            # the progression, the layer count and MCT come from the COD.
            if header["cocs"].get(c) is not None:
                chosen = header["cocs"][c]
            elif header["cod"] is not None:
                chosen = None
            else:
                chosen = main_coc.get(c)
            if chosen is None:
                style = tile_cod
            else:
                style = chosen._replace(
                    scod=(chosen.scod & 0x01) | (tile_cod.scod & 0x06),
                    progression=tile_cod.progression,
                    layers=tile_cod.layers,
                    mct=tile_cod.mct,
                )
            if header["qccs"].get(c) is not None:
                quant = header["qccs"][c]
            elif header["qcd"] is not None:
                quant = header["qcd"]
            elif main_qcc.get(c) is not None:
                quant = main_qcc[c]
            else:
                quant = main_qcd
            comp_styles.append(style)
            comp_quants.append(quant)
            styles[(tile, c)] = style
            if style.cbstyle & 0x40:
                raise TaintError("a high-throughput JPX code-block coder")
        complete &= _read_tile_packets(
            stream, tile, (tx0, ty0, tx1, ty1), components, comp_styles, comp_quants, tile_cod, blocks
        )
    return JpxLayout(
        xsiz - xosiz,
        ysiz - yosiz,
        xosiz,
        yosiz,
        xtsiz,
        ytsiz,
        xtosiz,
        ytosiz,
        components,
        colour,
        blocks,
        styles,
        codestream,
        complete,
    )


class _Block:
    __slots__ = ("x", "y", "included", "lblock", "passes", "zero", "segments")

    def __init__(self, x: int, y: int):
        self.x = x
        self.y = y
        self.included = False
        self.lblock = 3
        self.passes = 0
        self.zero = -1
        self.segments: list = []  # [max_passes, passes]


def _new_segment(block: _Block, cbstyle: int) -> None:
    if cbstyle & 0x04:
        maximum = 1
    elif cbstyle & 0x01:
        if not block.segments:
            maximum = 10
        else:
            previous = block.segments[-1][0]
            maximum = 2 if previous in (1, 10) else 1
    else:
        maximum = 109
    block.segments.append([maximum, 0])


def _band_rect(tc: tuple, level: int, xob: int, yob: int) -> tuple:
    tcx0, tcy0, tcx1, tcy1 = tc
    if level == 0:
        return tc
    offset_x = (1 << (level - 1)) * xob
    offset_y = (1 << (level - 1)) * yob
    scale = 1 << level
    return (
        _ceil_div(tcx0 - offset_x, scale),
        _ceil_div(tcy0 - offset_y, scale),
        _ceil_div(tcx1 - offset_x, scale),
        _ceil_div(tcy1 - offset_y, scale),
    )


def _read_tile_packets(stream, tile, tile_rect, components, styles, quants, tile_cod, blocks) -> bool:
    """Record every code-block's kept and possible passes in `blocks`;
    answer whether every packet of the tile was present."""
    tx0, ty0, tx1, ty1 = tile_rect
    precinct_sets: dict = {}  # (c, r) -> list of precinct dicts
    max_levels = 0
    for c, (precision, _signed, xr, yr) in enumerate(components):
        del precision
        style = styles[c]
        quant = quants[c]
        levels = style.levels
        max_levels = max(max_levels, levels)
        tc = (_ceil_div(tx0, xr), _ceil_div(ty0, yr), _ceil_div(tx1, xr), _ceil_div(ty1, yr))
        for r in range(levels + 1):
            scale = 1 << (levels - r)
            trx0, try0 = _ceil_div(tc[0], scale), _ceil_div(tc[1], scale)
            trx1, try1 = _ceil_div(tc[2], scale), _ceil_div(tc[3], scale)
            ppx, ppy = style.precincts[r] if r < len(style.precincts) else (15, 15)
            if trx1 > trx0:
                wide = _ceil_div(trx1, 1 << ppx) - trx0 // (1 << ppx)
            else:
                wide = 0
            if try1 > try0:
                high = _ceil_div(try1, 1 << ppy) - try0 // (1 << ppy)
            else:
                high = 0
            if r == 0:
                bands = [(0, levels, 0, 0)]
                cbw = min(style.xcb, ppx)
                cbh = min(style.ycb, ppy)
                pxs, pys = ppx, ppy
            else:
                level = levels - r + 1
                bands = [
                    (1 + 3 * (r - 1), level, 1, 0),
                    (2 + 3 * (r - 1), level, 0, 1),
                    (3 + 3 * (r - 1), level, 1, 1),
                ]
                cbw = min(style.xcb, ppx - 1)
                cbh = min(style.ycb, ppy - 1)
                pxs, pys = ppx - 1, ppy - 1
            if pxs < 0 or pys < 0:
                raise TaintError("a JPX precinct smaller than its subbands")
            precincts = []
            first_px = trx0 // (1 << ppx)
            first_py = try0 // (1 << ppy)
            for py in range(high):
                for px in range(wide):
                    entry = []
                    for band_index, level, xob, yob in bands:
                        rect = _band_rect(tc, level, xob, yob)
                        if rect[2] <= rect[0] or rect[3] <= rect[1]:
                            entry.append((band_index, level, [], 0, 0, None, None, 0))
                            continue
                        # The precinct's area in this band's coordinates.
                        gx0 = (first_px + px) << pxs
                        gy0 = (first_py + py) << pys
                        gx1 = gx0 + (1 << pxs)
                        gy1 = gy0 + (1 << pys)
                        bx0 = max(rect[0], gx0)
                        by0 = max(rect[1], gy0)
                        bx1 = min(rect[2], gx1)
                        by1 = min(rect[3], gy1)
                        if bx1 <= bx0 or by1 <= by0:
                            entry.append((band_index, level, [], 0, 0, None, None, 0))
                            continue
                        cx0 = bx0 >> cbw
                        cy0 = by0 >> cbh
                        cx1 = _ceil_div(bx1, 1 << cbw)
                        cy1 = _ceil_div(by1, 1 << cbh)
                        cw, ch = cx1 - cx0, cy1 - cy0
                        cells = [_Block(cx0 + i, cy0 + j) for j in range(ch) for i in range(cw)]
                        magnitude = quant.guard + _exponent(quant, levels, band_index, level) - 1
                        entry.append(
                            (band_index, level, cells, cw, ch, _TagTree(cw, ch), _TagTree(cw, ch), magnitude)
                        )
                    precincts.append(entry)
            precinct_sets[(c, r)] = (precincts, cbw, cbh, style)

    layers = tile_cod.layers
    order = tile_cod.progression
    single = all(len(v[0]) <= 1 for v in precinct_sets.values())
    sequence = []
    comps = range(len(components))
    resolutions = range(max_levels + 1)

    def exists(c, r):
        return (c, r) in precinct_sets

    if order == 0:  # LRCP
        for layer in range(layers):
            for r in resolutions:
                for c in comps:
                    if exists(c, r):
                        for p in range(len(precinct_sets[(c, r)][0])):
                            sequence.append((layer, c, r, p))
    elif order == 1:  # RLCP
        for r in resolutions:
            for layer in range(layers):
                for c in comps:
                    if exists(c, r):
                        for p in range(len(precinct_sets[(c, r)][0])):
                            sequence.append((layer, c, r, p))
    elif order in (2, 3, 4):
        if not single:
            raise TaintError("a position-ordered JPX with several precincts")
        if order == 2:  # RPCL
            for r in resolutions:
                for c in comps:
                    if exists(c, r) and precinct_sets[(c, r)][0]:
                        for layer in range(layers):
                            sequence.append((layer, c, r, 0))
        else:  # PCRL and CPRL collapse to component, resolution, layer
            for c in comps:
                for r in resolutions:
                    if exists(c, r) and precinct_sets[(c, r)][0]:
                        for layer in range(layers):
                            sequence.append((layer, c, r, 0))
    else:
        raise TaintError("an unknown JPX progression order")

    pos = 0
    end = len(stream)
    complete = True
    for layer, c, r, p in sequence:
        if pos >= end:
            # A codestream may end at any packet boundary; the packets that
            # are missing contribute nothing.
            complete = False
            break
        precincts, _cbw, _cbh, style = precinct_sets[(c, r)]
        entry = precincts[p]
        if style.scod & 0x02 and stream[pos : pos + 2] == b"\xff\x91":
            pos += 6
        bits = _Bits(stream, pos, end)
        body = 0
        if bits.bit():
            for _band_index, _level, cells, cw, _ch, incl, zero, _magnitude in entry:
                for k, block in enumerate(cells):
                    x, y = k % cw, k // cw
                    if not block.included:
                        included = incl.decode(bits, x, y, layer + 1)
                    else:
                        included = bool(bits.bit())
                    if not included:
                        continue
                    if not block.included:
                        threshold = 0
                        while not zero.decode(bits, x, y, threshold):
                            threshold += 1
                        block.zero = threshold - 1
                        block.included = True
                    count = _num_passes(bits)
                    while bits.bit():
                        block.lblock += 1
                    if not block.segments:
                        _new_segment(block, style.cbstyle)
                    elif block.segments[-1][1] >= block.segments[-1][0]:
                        _new_segment(block, style.cbstyle)
                    remaining = count
                    while remaining > 0:
                        segment = block.segments[-1]
                        take = min(segment[0] - segment[1], remaining)
                        body += bits.bits(block.lblock + _floor_log2(take))
                        segment[1] += take
                        remaining -= take
                        if remaining > 0:
                            _new_segment(block, style.cbstyle)
                    block.passes += count
        pos = bits.align()
        if style.scod & 0x04 and stream[pos : pos + 2] == b"\xff\x92":
            pos += 2
        pos += body
        if pos > end:
            raise TaintError("a JPX packet longer than its tile")

    for (c, r), (precincts, cbw, cbh, _style) in precinct_sets.items():
        for entry in precincts:
            for band_index, level, cells, _cw, _ch, _incl, _zero, magnitude in entry:
                for block in cells:
                    if block.included:
                        planes = magnitude + 1 - (block.zero + 1)
                        maximum = max(3 * planes - 2, 0)
                    else:
                        maximum = -1  # never included: every pass was dropped
                    blocks[(tile, c, r, band_index, block.x, block.y)] = (
                        block.passes,
                        maximum,
                        level,
                        cbw,
                        cbh,
                    )
    return complete


_FILTER_REACH = {0: 4, 1: 2}  # wavelet transform -> half-length of its filters


def jpx_lossy(layout: JpxLayout) -> bool:
    """Is the codestream rate-controlled: did the encoder stop any code-block
    it included short of its last pass, or the codestream short of its last
    packet? A block left out whole is not evidence either way: a fixed-quality
    encoder leaves out the blocks that hold nothing."""
    if not layout.complete:
        return True
    return any(0 <= maximum and passes < maximum for passes, maximum, *_ in layout.blocks.values())


def jpx_taint(layout: JpxLayout, spans, width: int, height: int):
    """Pixels whose decoded value depends on the marked pixels in `spans`, or
    None when that is every pixel (a rate-controlled codestream)."""
    if not spans:
        return ()
    if jpx_lossy(layout):
        return None
    marked_rects = spans_to_rects(spans)
    rects: list = []
    tiles_x = _ceil_div(layout.width + layout.x_origin - layout.tile_x0, layout.tile_w)
    for (tile, c), style in layout.styles.items():
        _precision, _signed, xr, yr = layout.components[c]
        reach = _FILTER_REACH.get(style.transform)
        if reach is None:
            raise TaintError("an unknown JPX wavelet")
        p, q = tile % tiles_x, tile // tiles_x
        tx0 = max(layout.tile_x0 + p * layout.tile_w, layout.x_origin) - layout.x_origin
        ty0 = max(layout.tile_y0 + q * layout.tile_h, layout.y_origin) - layout.y_origin
        tx1 = min(layout.tile_x0 + (p + 1) * layout.tile_w, layout.x_origin + layout.width) - layout.x_origin
        ty1 = min(layout.tile_y0 + (q + 1) * layout.tile_h, layout.y_origin + layout.height) - layout.y_origin
        inside = [
            (max(x0, tx0), max(y0, ty0), min(x1, tx1), min(y1, ty1))
            for x0, y0, x1, y1 in marked_rects
            if x0 < tx1 and tx0 < x1 and y0 < ty1 and ty0 < y1
        ]
        if not inside:
            continue
        levels = style.levels
        # Analysis into the coarsest level and synthesis back out, plus one
        # coefficient's spacing for the subband phase; tiles are transformed
        # independently, so the reach stops at the tile's edge.
        whole = (2 * reach) * ((1 << levels) - 1) + (1 << levels)
        for x0, y0, x1, y1 in inside:
            rects.append(
                (
                    max(x0 - whole * xr, tx0),
                    max(y0 - whole * yr, ty0),
                    min(x1 + whole * xr, tx1),
                    min(y1 + whole * yr, ty1),
                )
            )
    return rects_to_spans(rects, width, height)


def covered_pixels(spans) -> int:
    return sum(hi - lo for _row, lo, hi in spans)


# ── JBIG2 ─────────────────────────────────────────────────────────────────
#
# Segment layout per ITU-T T.88 §7.2; carriage in PDF per ISO 32000-2 §7.4.7:
# embedded, sequential organisation, no file header, page association 1 in
# the image's own stream and 0 in /JBIG2Globals, no colour palette segment,
# COLEXTFLAG 0.

_JBIG2_FILE_HEADER = b"\x97JB2\r\n\x1a\n"
_JBIG2_REGIONS = frozenset({4, 6, 7, 20, 22, 23, 36, 38, 39, 40, 42, 43})
_JBIG2_GLOBAL_TYPES = frozenset({0, 16, 52, 53, 62})
_JBIG2_PAGE_TYPES = _JBIG2_REGIONS | _JBIG2_GLOBAL_TYPES | {48, 49, 50, 51}
_JBIG2_PAGE_INFO = 48
_JBIG2_END_OF_STRIPE = 50
_JBIG2_TRAILERS = frozenset({49, 51})
_JBIG2_PADDING = frozenset(b"\x00\t\n\x0c\r ")
_UNKNOWN_LENGTH = 0xFFFFFFFF


class _Segment(NamedTuple):
    number: int
    kind: int
    page: int
    refers: tuple
    data: bytes


def _jbig2_segments(data: bytes, where: str) -> list:
    """Every segment of one embedded JBIG2 stream, or TaintError when a header
    or a segment's declared data runs past the end of the stream."""
    if data.startswith(_JBIG2_FILE_HEADER):
        raise TaintError(f"a JBIG2 file header in the {where}")
    segments: list = []
    index = 0
    size = len(data)
    while index < size:
        if all(byte in _JBIG2_PADDING for byte in data[index:]):
            break
        if index + 6 > size:
            raise TaintError(f"truncated JBIG2 data in the {where}")
        number = struct.unpack(">I", data[index : index + 4])[0]
        flags = data[index + 4]
        kind = flags & 0x3F
        wide_page = bool(flags & 0x40)
        count_byte = data[index + 5]
        count = count_byte >> 5
        cursor = index + 6
        if count == 7:
            if cursor + 3 > size:
                raise TaintError(f"truncated JBIG2 data in the {where}")
            count = struct.unpack(">I", data[index + 5 : index + 9])[0] & 0x1FFFFFFF
            cursor = index + 9 + (count + 8) // 8
        elif count > 4:
            raise TaintError(f"a malformed JBIG2 segment header in the {where}")
        width = 1 if number <= 256 else 2 if number <= 65536 else 4
        refers: list = []
        for _ in range(count):
            if cursor + width > size:
                raise TaintError(f"truncated JBIG2 data in the {where}")
            refers.append(int.from_bytes(data[cursor : cursor + width], "big"))
            cursor += width
        page_size = 4 if wide_page else 1
        if cursor + page_size + 4 > size:
            raise TaintError(f"truncated JBIG2 data in the {where}")
        page = int.from_bytes(data[cursor : cursor + page_size], "big")
        cursor += page_size
        length = struct.unpack(">I", data[cursor : cursor + 4])[0]
        cursor += 4
        if length == _UNKNOWN_LENGTH:
            length = _unstated_length(data, cursor, kind, where)
        if cursor + length > size:
            raise TaintError(f"truncated JBIG2 data in the {where}")
        segments.append(_Segment(number, kind, page, tuple(refers), data[cursor : cursor + length]))
        index = cursor + length
    return segments


def _unstated_length(data: bytes, start: int, kind: int, where: str) -> int:
    """The data length of an immediate generic region that did not state one
    (T.88 §7.2.7): arithmetic-coded data ends at the 0xFF 0xAC marker, which
    byte stuffing keeps out of the data itself, then a 4-byte row count."""
    if kind != 38 or start + 18 > len(data):
        raise TaintError(f"a malformed JBIG2 segment header in the {where}")
    if data[start + 17] & 0x01:
        raise TaintError(f"an MMR-coded JBIG2 region of unstated length in the {where}")
    marker = data.find(b"\xff\xac", start + 18)
    if marker < 0 or marker + 6 > len(data):
        raise TaintError(f"truncated JBIG2 data in the {where}")
    return marker + 6 - start


def jbig2_check(data: bytes, globals_data: bytes | None, width: int, height: int) -> None:
    """Refuse (TaintError) a JBIG2 image the decoder could read differently
    from what it holds: truncated or malformed segments, a segment referred
    to but not carried, a page that is not the image's own size, colour
    extensions. A decoder handed such a stream draws whatever it could
    decode, often nothing, and reports success."""
    known: set = set()
    if globals_data is not None:
        for segment in _jbig2_segments(globals_data, "shared JBIG2 dictionary"):
            if segment.kind not in _JBIG2_GLOBAL_TYPES or segment.page != 0:
                raise TaintError("a shared JBIG2 dictionary holding page data")
            missing = [n for n in segment.refers if n not in known]
            if missing:
                raise TaintError("a JBIG2 segment that refers to one the file does not carry")
            known.add(segment.number)
    segments = _jbig2_segments(data, "image")
    page_info = [s for s in segments if s.kind == _JBIG2_PAGE_INFO]
    if len(page_info) != 1:
        raise TaintError("a JBIG2 image without exactly one page description")
    for position, segment in enumerate(segments):
        if segment.kind not in _JBIG2_PAGE_TYPES:
            raise TaintError(f"a JBIG2 segment of type {segment.kind}")
        if segment.kind in _JBIG2_TRAILERS:
            if position != len(segments) - 1 and not all(
                later.kind in _JBIG2_TRAILERS for later in segments[position + 1 :]
            ):
                raise TaintError("JBIG2 data after the end of its page")
            continue
        if segment.page != 1:
            raise TaintError("a JBIG2 image whose data is not for page 1")
        missing = [n for n in segment.refers if n not in known]
        if missing:
            raise TaintError("a JBIG2 segment that refers to one the file does not carry")
        if segment.kind in _JBIG2_REGIONS:
            if len(segment.data) < 17:
                raise TaintError("truncated JBIG2 data in the image")
            if segment.data[16] & 0x08:
                raise TaintError("a JBIG2 colour extension")
        known.add(segment.number)
    info = page_info[0].data
    if len(info) < 19:
        raise TaintError("truncated JBIG2 data in the image")
    page_width, page_height = struct.unpack(">II", info[:8])
    if page_width != width:
        raise TaintError("a JBIG2 page whose width contradicts the image dictionary")
    if page_height == _UNKNOWN_LENGTH:
        stripes = [s for s in segments if s.kind == _JBIG2_END_OF_STRIPE and len(s.data) >= 4]
        if not stripes or struct.unpack(">I", stripes[-1].data[:4])[0] + 1 != height:
            raise TaintError("a striped JBIG2 page whose height contradicts the image dictionary")
    elif page_height != height:
        raise TaintError("a JBIG2 page whose height contradicts the image dictionary")
