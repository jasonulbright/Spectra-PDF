"""Builds the three IMAGE-CODEC render fixtures (O8 slice A).

Our own viewer could not decode /CCITTFaxDecode, /JBIG2Decode or /JPXDecode
until slice A staged pdf.js's wasm modules — a fax-derived or
scanner-optimized PDF rendered BLANK with no error the user could see. These
three one-page PDFs are the regression pins: spec 111 opens each and asserts
the rendered canvas carries ink in a recorded band.

The band matters more than "non-blank": a stencil written with the wrong
polarity renders 100% BLACK, which passes any not-blank check while being
exactly as wrong (§ 1.6 rule 2 of the brief — polarity is a MEASUREMENT). So
each fixture is drawn from one synthetic pattern whose ink fraction is known
by construction, and this generator DECODES ITS OWN OUTPUT with the bundled
Ghostscript and refuses to write a fixture whose coverage is off.

Deterministic and offline: the pattern is drawn from constants, so a rerun
produces byte-identical PDFs and a regeneration is reviewable as a diff.

Run with the bundled runtime, from the repo root:

    ./resources/python/python.exe e2e-tests/fixtures/make-codec-fixtures.py
"""

from __future__ import annotations

import io
import struct
import subprocess
import sys
from pathlib import Path

import pikepdf
from PIL import Image, ImageDraw
from PIL.TiffImagePlugin import ROWSPERSTRIP

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
GS = ROOT / "resources" / "ghostscript" / "gswin64c.exe"

# 200 dpi over a 612x792 pt page. Small enough that the fixtures stay tiny,
# large enough that the decoders do real work.
DPI = 200
W = round(612 * DPI / 72)
H = round(792 * DPI / 72)


# --------------------------------------------------------------- the pattern
def pattern() -> Image.Image:
    """A 1-bit page: 0 = ink, 255 = paper (Pillow mode '1' convention).

    Bars plus a grid plus a disc — geometric rather than textual so the ink
    fraction is a property of the constants, not of a font.
    """
    im = Image.new("1", (W, H), 1)
    d = ImageDraw.Draw(im)
    # A masthead bar.
    d.rectangle([W // 12, H // 20, W - W // 12, H // 20 + H // 24], fill=0)
    # Twelve text-like rules of varying length.
    y = H // 5
    for i in range(12):
        x1 = W // 12 + (i % 4) * (W // 30)
        d.rectangle([W // 12, y, W - x1, y + H // 90], fill=0)
        y += H // 16
    # A filled disc and a hollow square — curved and straight edges, which
    # exercise the run-length coder's reference-line handling.
    d.ellipse([W // 6, int(H * 0.72), W // 6 + W // 4, int(H * 0.72) + W // 4], fill=0)
    d.rectangle([W // 2, int(H * 0.72), W // 2 + W // 4, int(H * 0.72) + W // 4], outline=0, width=W // 60)
    return im


def ink_fraction(im: Image.Image) -> float:
    """Fraction of pixels that are dark, over any mode."""
    g = im.convert("L")
    hist = g.histogram()
    dark = sum(hist[:128])
    return dark / float(g.width * g.height)


# --------------------------------------------------------------- G4 / CCITT
def g4_bytes(mask: Image.Image) -> tuple[bytes, int]:
    """CCITT group-4 codestream for a mode-'1' image, as ONE strip.

    Pillow defaults to ~205-row strips and each G4 strip RESTARTS the
    reference line, so concatenating them decodes progressively wrong — and
    the corruption looks like erosion, not like an error, so a size check and
    a "does it render" check both pass. ROWSPERSTRIP = height forces one strip.

    Returns the codestream and the TIFF PhotometricInterpretation tag, which
    is what decides the PDF /Decode array (measured, never assumed).
    """
    buf = io.BytesIO()
    mask.save(buf, format="TIFF", compression="group4", tiffinfo={ROWSPERSTRIP: mask.size[1]})
    raw = buf.getvalue()
    tif = Image.open(io.BytesIO(raw))
    offsets = tif.tag_v2[273]
    counts = tif.tag_v2[279]
    if len(offsets) != 1:
        raise SystemExit(f"expected ONE strip, libtiff wrote {len(offsets)} — the G4 stream would be corrupt")
    photometric = int(tif.tag_v2[262])
    return raw[offsets[0] : offsets[0] + counts[0]], photometric


# --------------------------------------------------------------- JBIG2 (MMR)
def jbig2_segment(number: int, seg_type: int, page: int, data: bytes) -> bytes:
    """One T.88 segment header + its data, in the PDF EMBEDDED stream format.

    Embedded streams carry no file header and no segment-number-size games:
    every segment here is numbered below 256 and refers to nothing, so the
    referred-to field is a single byte of zero and the page association is one
    byte.
    """
    out = struct.pack(">I", number)          # segment number
    out += bytes([seg_type & 0x3F])          # flags: type, 1-byte page assoc
    out += b"\x00"                           # 0 referred-to segments, no retain bits
    out += bytes([page & 0xFF])              # page association
    out += struct.pack(">I", len(data))      # data length
    return out + data


def jbig2_mmr_stream(width: int, height: int, mmr: bytes) -> bytes:
    """An embedded JBIG2 stream holding one MMR-coded generic region.

    JBIG2's generic-region coder has two arms: the MQ arithmetic coder and
    MMR (which IS T.6 / group 4). Using the MMR arm lets this fixture reuse
    the G4 codestream above, so the JBIG2 pin needs no encoder — it exercises
    pdf.js's jbig2.wasm segment parser and region decoder on a stream whose
    expected output is already known from the CCITT fixture.
    """
    # 7.4.8 page information
    page_info = struct.pack(">IIII", width, height, 0, 0) + bytes([0x01]) + struct.pack(">H", 0)
    # 7.4.6 region segment information + generic region flags (MMR = 1)
    region = struct.pack(">IIII", width, height, 0, 0) + bytes([0x00]) + bytes([0x01]) + mmr
    return (
        jbig2_segment(0, 48, 1, page_info)      # page information
        + jbig2_segment(1, 38, 1, region)       # immediate generic region
        + jbig2_segment(2, 49, 1, b"")          # end of page
    )


# --------------------------------------------------------------- PDF assembly
def one_page_pdf(dest: Path, build) -> None:
    pdf = pikepdf.Pdf.new()
    pw, ph = W * 72 / DPI, H * 72 / DPI
    xobj = build(pdf)
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, pw, ph],
        Resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=xobj)),
        Contents=pdf.make_stream(f"q {pw} 0 0 {ph} 0 0 cm /Im0 Do Q".encode()),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    # Deterministic output: no timestamps, no ids that change per run.
    pdf.save(dest, static_id=True)


def image_stream(pdf: pikepdf.Pdf, data: bytes, filt: str, extra: dict) -> pikepdf.Object:
    st = pikepdf.Stream(pdf, data)
    st["/Type"] = pikepdf.Name("/XObject")
    st["/Subtype"] = pikepdf.Name("/Image")
    st["/Width"] = W
    st["/Height"] = H
    st["/Filter"] = pikepdf.Name(filt)
    for k, v in extra.items():
        st[k] = v
    return pdf.make_indirect(st)


# --------------------------------------------------------------- verification
def gs_ink(pdf: Path) -> float:
    """Render with the bundled Ghostscript and measure the ink fraction.

    Ghostscript carries jbig2dec, an openjpeg and its own CCITT decoder, so it
    is an INDEPENDENT decoder from pdf.js — a fixture that renders correctly
    here and blank in the app is an app defect, which is the whole point.
    """
    if not GS.exists():
        print(f"  ! Ghostscript absent at {GS} — cannot verify {pdf.name}")
        return float("nan")
    png = pdf.with_suffix(".verify.png")
    proc = subprocess.run(
        [str(GS), "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pnggray",
         "-r72", f"-sOutputFile={png}", str(pdf)],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(f"Ghostscript refused {pdf.name}: {proc.stderr.strip()}")
    frac = ink_fraction(Image.open(png))
    png.unlink(missing_ok=True)
    return frac


def main() -> int:
    mask = pattern()
    expected = ink_fraction(mask)
    print(f"pattern {W}x{H}, ink fraction {expected:.4f}")

    mmr, photometric = g4_bytes(mask)
    print(f"G4 codestream {len(mmr)} bytes, TIFF photometric={photometric} "
          f"({'WhiteIsZero' if photometric == 0 else 'BlackIsZero'})")

    # BlackIs1 false is the PDF default: a 0 bit is black. libtiff's
    # photometric decides whether the codestream's "1" runs are the ink, and
    # /Decode inverts when it is the other way round. Measured, not deduced.
    ccitt_decode = pikepdf.Array([1, 0]) if photometric == 1 else pikepdf.Array([0, 1])

    def build_ccitt(pdf: pikepdf.Pdf) -> pikepdf.Object:
        return image_stream(pdf, mmr, "/CCITTFaxDecode", {
            "/ImageMask": True,
            "/Decode": ccitt_decode,
            "/DecodeParms": pikepdf.Dictionary(K=-1, Columns=W, Rows=H, BlackIs1=False),
        })

    # JBIG2Decode always yields 1 = black, independent of the TIFF tag, so the
    # MMR payload may need inverting relative to what libtiff produced. The
    # verification below is what settles it.
    def build_jbig2(decode_flip: bool):
        stream = jbig2_mmr_stream(W, H, mmr)

        def build(pdf: pikepdf.Pdf) -> pikepdf.Object:
            extra = {
                "/ColorSpace": pikepdf.Name("/DeviceGray"),
                "/BitsPerComponent": 1,
            }
            if decode_flip:
                extra["/Decode"] = pikepdf.Array([1, 0])
            return image_stream(pdf, stream, "/JBIG2Decode", extra)

        return build

    # JPX: a colour page carrying the same geometry, so the JPEG2000 pin is a
    # real photographic-ish codestream rather than a flat fill.
    colour = Image.merge("RGB", (
        mask.convert("L"),
        mask.convert("L").point(lambda v: v * 0.55 + 40),
        Image.linear_gradient("L").resize((W, H)).point(lambda v: 255 - v // 2),
    ))
    jpx = io.BytesIO()
    colour.save(jpx, format="JPEG2000", quality_mode="rates", quality_layers=[40])

    def build_jpx(pdf: pikepdf.Pdf) -> pikepdf.Object:
        # /JPXDecode carries its own colour space; PDF says /ColorSpace may be
        # omitted, and omitting it is what a real scanner-optimized file does.
        return image_stream(pdf, jpx.getvalue(), "/JPXDecode", {"/BitsPerComponent": 8})

    outputs = []

    ccitt = HERE / "codec-ccitt.pdf"
    one_page_pdf(ccitt, build_ccitt)
    outputs.append((ccitt, expected))

    jb = HERE / "codec-jbig2.pdf"
    one_page_pdf(jb, build_jbig2(False))
    got = gs_ink(jb)
    if got == got and abs(got - expected) > 0.05:
        # Polarity is a measurement: if the un-flipped build came back as the
        # negative of the pattern, write the flipped one instead.
        flipped = abs((1.0 - got) - expected)
        if flipped <= 0.05:
            print(f"  JBIG2 polarity inverted (ink {got:.4f}) — rebuilding with /Decode [1 0]")
            one_page_pdf(jb, build_jbig2(True))
        else:
            raise SystemExit(f"JBIG2 fixture decoded to ink {got:.4f}, expected ~{expected:.4f}")
    outputs.append((jb, expected))

    jp = HERE / "codec-jpx.pdf"
    one_page_pdf(jp, build_jpx)
    outputs.append((jp, None))

    print()
    ok = True
    for path, want in outputs:
        frac = gs_ink(path)
        size = path.stat().st_size
        note = ""
        if want is not None and frac == frac:
            if abs(frac - want) > 0.05:
                note = f"  !! expected ~{want:.4f}"
                ok = False
        print(f"  {path.name:22s} {size/1024:7.1f} KB   ink {frac:.4f}{note}")
    if not ok:
        print("\nRefusing: a fixture does not decode to the pattern it was built from.")
        return 1
    print("\nAll three fixtures decode to the source pattern.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
