/**
 * Snapshot capture — the byte-level half.
 *
 * The snapshot band becomes two clipboard payloads: a PNG (for consumers that
 * prefer it) and a Windows DIB (what everything else pastes). Neither side of
 * the IPC decodes an image — the renderer already holds the pixels, so it
 * builds the DIB itself and Rust performs the OS calls on two opaque blobs.
 *
 * The arithmetic therefore lives here rather than in the component: there is
 * no DOM test environment, and a wrong row stride or a forgotten bottom-up
 * flip produces a picture that pastes skewed or upside down in another
 * application, where no unit test would ever see it.
 */

/** Points per inch — the PDF user-space unit, and the divisor turning a
 * requested DPI into a pdf.js render scale. */
const POINTS_PER_INCH = 72;
/** Metres per inch, for the DIB's pixels-per-metre resolution fields. */
const METRES_PER_INCH = 0.0254;

/** The DPI range the snapshot preference accepts. Below 72 the capture is
 * coarser than the page's own unit grid; above 600 a full-page band costs
 * hundreds of megabytes of RGBA before it is ever compressed. */
export const MIN_SNAPSHOT_DPI = 72;
export const MAX_SNAPSHOT_DPI = 600;
export const DEFAULT_SNAPSHOT_DPI = 150;

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A DPI a caller supplied (preference, or an older stored value), clamped
 * into the supported range. A non-numeric value resolves to the default
 * rather than to zero — a zero scale renders nothing at all. */
export function clampSnapshotDpi(dpi: unknown): number {
  const n = typeof dpi === 'number' ? dpi : Number(dpi);
  if (!Number.isFinite(n)) return DEFAULT_SNAPSHOT_DPI;
  return Math.min(MAX_SNAPSHOT_DPI, Math.max(MIN_SNAPSHOT_DPI, Math.round(n)));
}

/** The pdf.js render scale that puts one page point at `dpi` pixels. */
export function scaleForDpi(dpi: number): number {
  return clampSnapshotDpi(dpi) / POINTS_PER_INCH;
}

/**
 * The band, as whole device pixels of a raster `viewportW` x `viewportH`.
 *
 * The band arrives display-normalised (0..1 of the drawn frame, y from the
 * TOP) and the viewport is rendered at the same rotation the reader sees, so
 * the two frames already agree and the conversion is a scale. Returns null
 * for a band with no area — a click is not a capture.
 */
export function snapshotPixelRect(
  band: NormRect,
  viewportW: number,
  viewportH: number,
): PixelRect | null {
  if (!(viewportW >= 1) || !(viewportH >= 1)) return null;
  const x = Math.min(Math.max(band.x, 0), 1);
  const y = Math.min(Math.max(band.y, 0), 1);
  const w = Math.min(Math.max(band.w, 0), 1 - x);
  const h = Math.min(Math.max(band.h, 0), 1 - y);
  if (w <= 0.001 || h <= 0.001) return null;
  const px = Math.floor(x * viewportW);
  const py = Math.floor(y * viewportH);
  const pw = Math.round(w * viewportW);
  const ph = Math.round(h * viewportH);
  const cw = Math.min(Math.max(pw, 1), Math.floor(viewportW) - px);
  const ch = Math.min(Math.max(ph, 1), Math.floor(viewportH) - py);
  if (cw < 1 || ch < 1) return null;
  return { x: px, y: py, w: cw, h: ch };
}

/** Bytes per DIB row: three per pixel, rounded up to a 4-byte boundary. */
export function dibRowStride(width: number): number {
  return (width * 3 + 3) & ~3;
}

const DIB_HEADER_BYTES = 40;

/**
 * A packed 24-bit `BITMAPINFOHEADER` DIB from canvas RGBA.
 *
 * Three transformations, each of which is a paste defect when missed: RGBA to
 * BGR channel order, top-down raster to the DIB's bottom-up row order, and
 * every row padded to a 4-byte boundary. Alpha is composited over WHITE
 * rather than carried: `CF_DIB` has no agreed alpha channel, and a consumer
 * reading the unused byte as opacity would show a transparent capture.
 */
export function buildDib(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  dpi: number = DEFAULT_SNAPSHOT_DPI,
): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`snapshot: bad raster size ${width}x${height}`);
  }
  if (rgba.length < width * height * 4) {
    throw new Error(`snapshot: raster has ${rgba.length} bytes, needs ${width * height * 4}`);
  }
  const stride = dibRowStride(width);
  const pixelBytes = stride * height;
  const out = new Uint8Array(DIB_HEADER_BYTES + pixelBytes);
  const view = new DataView(out.buffer);
  const ppm = Math.round(clampSnapshotDpi(dpi) / METRES_PER_INCH);
  view.setUint32(0, DIB_HEADER_BYTES, true);
  view.setInt32(4, width, true);
  view.setInt32(8, height, true); // positive: bottom-up rows
  view.setUint16(12, 1, true); // planes
  view.setUint16(14, 24, true); // bits per pixel
  view.setUint32(16, 0, true); // BI_RGB
  view.setUint32(20, pixelBytes, true);
  view.setInt32(24, ppm, true);
  view.setInt32(28, ppm, true);
  view.setUint32(32, 0, true); // palette entries used
  view.setUint32(36, 0, true); // palette entries required

  for (let row = 0; row < height; row++) {
    const src = row * width * 4;
    const dst = DIB_HEADER_BYTES + (height - 1 - row) * stride;
    for (let col = 0; col < width; col++) {
      const s = src + col * 4;
      const a = rgba[s + 3];
      const d = dst + col * 3;
      if (a === 255) {
        out[d] = rgba[s + 2];
        out[d + 1] = rgba[s + 1];
        out[d + 2] = rgba[s];
      } else {
        const f = a / 255;
        out[d] = Math.round(rgba[s + 2] * f + 255 * (1 - f));
        out[d + 1] = Math.round(rgba[s + 1] * f + 255 * (1 - f));
        out[d + 2] = Math.round(rgba[s] * f + 255 * (1 - f));
      }
    }
  }
  return out;
}

export interface SnapshotPayload {
  bytes: Uint8Array;
  pngLength: number;
}

/**
 * The two blobs as ONE raw IPC body, PNG first.
 *
 * One body rather than two arguments because both formats must reach the same
 * clipboard session: a consumer that polls between two calls would see a
 * clipboard holding half the answer.
 */
export function packSnapshotPayload(png: Uint8Array, dib: Uint8Array): SnapshotPayload {
  const bytes = new Uint8Array(png.length + dib.length);
  bytes.set(png, 0);
  bytes.set(dib, png.length);
  return { bytes, pngLength: png.length };
}
