import { inflateSync } from 'node:zlib';

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8Array;
}

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG: the form the WebDriver
 * screenshot endpoints return. Any other form throws. */
export function decodePng(png: Uint8Array): Pixels {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  for (let at = 8; at < png.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const body = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = body[8];
      const colour = body[9];
      if (depth !== 8 || body[12] !== 0 || (colour !== 2 && colour !== 6)) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}, interlace ${body[12]}`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= channels ? prior[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = (line[x] + predictor) & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    data[i * 4] = rows[j];
    data[i * 4 + 1] = rows[j + 1];
    data[i * 4 + 2] = rows[j + 2];
    data[i * 4 + 3] = channels === 4 ? rows[j + 3] : 255;
  }
  return { width, height, data };
}

/** How many pixels differ by more than `tolerance` in any channel. Images of
 * different sizes differ everywhere. */
export function differingPixels(a: Pixels, b: Pixels, tolerance = 24): number {
  if (a.width !== b.width || a.height !== b.height) return Math.max(a.width * a.height, b.width * b.height);
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      Math.abs(a.data[i] - b.data[i]) > tolerance
      || Math.abs(a.data[i + 1] - b.data[i + 1]) > tolerance
      || Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance
    ) count++;
  }
  return count;
}

/** The pixels of one element as the WebDriver element screenshot draws them. */
export async function elementPixels(selector: string): Promise<Pixels> {
  const el = await $(selector);
  const id: string = await el.elementId;
  const base64 = await browser.takeElementScreenshot(id);
  return decodePng(Buffer.from(base64, 'base64'));
}
