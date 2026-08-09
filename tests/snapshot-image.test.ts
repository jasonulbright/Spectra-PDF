// Snapshot capture arithmetic. Every one of these is a defect the user would
// only see in ANOTHER application, pasted: a skewed picture (row stride), an
// upside-down one (bottom-up rows), colour-swapped (BGR), or a transparent
// one (alpha in a format with no alpha).
import { describe, it, expect } from 'vitest';
import {
  buildDib,
  clampSnapshotDpi,
  dibRowStride,
  packSnapshotPayload,
  scaleForDpi,
  snapshotPixelRect,
  DEFAULT_SNAPSHOT_DPI,
  MAX_SNAPSHOT_DPI,
  MIN_SNAPSHOT_DPI,
} from '../src/renderer/lib/snapshot-image';

const DIB_HEADER = 40;

function header(dib: Uint8Array): DataView {
  return new DataView(dib.buffer, dib.byteOffset, DIB_HEADER);
}

/** The BGR triple at (col, row) counted from the TOP, the way the source
 * raster counts — the flip is what this reads through. */
function pixel(dib: Uint8Array, width: number, height: number, col: number, row: number): number[] {
  const stride = dibRowStride(width);
  const at = DIB_HEADER + (height - 1 - row) * stride + col * 3;
  return [dib[at], dib[at + 1], dib[at + 2]];
}

function rgbaRaster(width: number, height: number, fill: (x: number, y: number) => number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const at = (y * width + x) * 4;
      out[at] = r;
      out[at + 1] = g;
      out[at + 2] = b;
      out[at + 3] = a;
    }
  }
  return out;
}

describe('snapshot resolution', () => {
  it('clamps into the supported range and survives junk', () => {
    expect(clampSnapshotDpi(150)).toBe(150);
    expect(clampSnapshotDpi(10)).toBe(MIN_SNAPSHOT_DPI);
    expect(clampSnapshotDpi(5000)).toBe(MAX_SNAPSHOT_DPI);
    expect(clampSnapshotDpi(199.6)).toBe(200);
    // A stored value from a hand-edited preferences file must not render a
    // zero-scale (i.e. nothing) page.
    expect(clampSnapshotDpi('nonsense')).toBe(DEFAULT_SNAPSHOT_DPI);
    expect(clampSnapshotDpi(undefined)).toBe(DEFAULT_SNAPSHOT_DPI);
    expect(clampSnapshotDpi(NaN)).toBe(DEFAULT_SNAPSHOT_DPI);
  });

  it('turns a DPI into a page-point render scale', () => {
    expect(scaleForDpi(72)).toBe(1);
    expect(scaleForDpi(144)).toBe(2);
    expect(scaleForDpi(150)).toBeCloseTo(150 / 72, 10);
  });
});

describe('snapshotPixelRect', () => {
  it('scales a normalised band onto the raster', () => {
    const r = snapshotPixelRect({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 800, 1000);
    expect(r).toEqual({ x: 200, y: 500, w: 400, h: 250 });
  });

  it('clamps a band that runs off the page', () => {
    const r = snapshotPixelRect({ x: 0.8, y: 0.8, w: 0.9, h: 0.9 }, 100, 100)!;
    expect(r.x + r.w).toBeLessThanOrEqual(100);
    expect(r.y + r.h).toBeLessThanOrEqual(100);
  });

  it('refuses a click and a zero-area band', () => {
    expect(snapshotPixelRect({ x: 0.3, y: 0.3, w: 0, h: 0 }, 800, 1000)).toBeNull();
    expect(snapshotPixelRect({ x: 0.3, y: 0.3, w: 0.0005, h: 0.4 }, 800, 1000)).toBeNull();
  });

  it('refuses a raster with no pixels', () => {
    expect(snapshotPixelRect({ x: 0, y: 0, w: 1, h: 1 }, 0, 500)).toBeNull();
  });
});

describe('buildDib', () => {
  it('writes a 24-bit BITMAPINFOHEADER with the raster size', () => {
    const dib = buildDib(rgbaRaster(4, 3, () => [0, 0, 0, 255]), 4, 3, 150);
    const h = header(dib);
    expect(h.getUint32(0, true)).toBe(DIB_HEADER);
    expect(h.getInt32(4, true)).toBe(4);
    // Positive height: bottom-up rows, the only layout CF_DIB consumers
    // agree on.
    expect(h.getInt32(8, true)).toBe(3);
    expect(h.getUint16(12, true)).toBe(1);
    expect(h.getUint16(14, true)).toBe(24);
    expect(h.getUint32(16, true)).toBe(0); // BI_RGB
    expect(h.getUint32(20, true)).toBe(dibRowStride(4) * 3);
    // 150 dpi as pixels per metre.
    expect(h.getInt32(24, true)).toBe(Math.round(150 / 0.0254));
    expect(h.getInt32(28, true)).toBe(h.getInt32(24, true));
  });

  it('pads every row to a 4-byte boundary', () => {
    expect(dibRowStride(1)).toBe(4);
    expect(dibRowStride(2)).toBe(8);
    expect(dibRowStride(3)).toBe(12);
    expect(dibRowStride(4)).toBe(12);
    expect(dibRowStride(5)).toBe(16);
    const dib = buildDib(rgbaRaster(3, 2, () => [1, 2, 3, 255]), 3, 2);
    expect(dib.length).toBe(DIB_HEADER + 12 * 2);
    // The pad bytes are not pixels and stay zero.
    expect(dib[DIB_HEADER + 9]).toBe(0);
  });

  it('stores BGR, not RGB', () => {
    const dib = buildDib(rgbaRaster(1, 1, () => [10, 20, 30, 255]), 1, 1);
    expect(pixel(dib, 1, 1, 0, 0)).toEqual([30, 20, 10]);
  });

  it('flips the rows bottom-up', () => {
    // Row 0 red, row 1 green: the DIB must carry green FIRST.
    const raster = rgbaRaster(2, 2, (_x, y) => (y === 0 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    const dib = buildDib(raster, 2, 2);
    expect(pixel(dib, 2, 2, 0, 0)).toEqual([0, 0, 255]); // top row is red
    expect(pixel(dib, 2, 2, 0, 1)).toEqual([0, 255, 0]); // bottom row is green
    const stride = dibRowStride(2);
    // ...and physically, the first stored row is the BOTTOM one.
    expect([dib[DIB_HEADER], dib[DIB_HEADER + 1], dib[DIB_HEADER + 2]]).toEqual([0, 255, 0]);
    expect([dib[DIB_HEADER + stride], dib[DIB_HEADER + stride + 1], dib[DIB_HEADER + stride + 2]])
      .toEqual([0, 0, 255]);
  });

  it('composites transparency over white instead of carrying alpha', () => {
    // Fully transparent black must read as paper, not as black and not as a
    // consumer's idea of an unused fourth byte.
    const clear = buildDib(rgbaRaster(1, 1, () => [0, 0, 0, 0]), 1, 1);
    expect(pixel(clear, 1, 1, 0, 0)).toEqual([255, 255, 255]);
    const half = buildDib(rgbaRaster(1, 1, () => [0, 0, 0, 128]), 1, 1);
    expect(pixel(half, 1, 1, 0, 0)).toEqual([127, 127, 127]);
  });

  it('refuses a raster that does not match its stated size', () => {
    expect(() => buildDib(new Uint8ClampedArray(4 * 3), 4, 4)).toThrow(/needs/);
    expect(() => buildDib(new Uint8ClampedArray(16), 0, 4)).toThrow(/bad raster size/);
  });
});

describe('packSnapshotPayload', () => {
  it('concatenates PNG then DIB and reports the split', () => {
    const png = new Uint8Array([1, 2, 3]);
    const dib = new Uint8Array([9, 8]);
    const { bytes, pngLength } = packSnapshotPayload(png, dib);
    expect(pngLength).toBe(3);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 9, 8]);
    // The split the Rust side performs, proved to recover both halves.
    expect(Array.from(bytes.slice(0, pngLength))).toEqual([1, 2, 3]);
    expect(Array.from(bytes.slice(pngLength))).toEqual([9, 8]);
  });
});
