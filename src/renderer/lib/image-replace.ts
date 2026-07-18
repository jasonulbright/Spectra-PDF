// Replacement-image sourcing for Edit ▸ Replace (Phase 7.1).
//
// The division of labor mirrors batch OCR: the WEBVIEW is the decoder (it
// reads every image format natively), the engine only embeds. A picked
// JPEG goes to the engine BY PATH for byte-passthrough (/DCTDecode, zero
// re-encode); anything else — or a JPEG flavor the engine's SOF scan
// declines (CMYK etc.) — is decoded here to raw pixels and handed over as
// a temp file next to the document's working copy (inside the plugin-fs
// $TEMP scope).

export interface RawReplacementSource {
  raw_path: string;
  width: number;
  height: number;
  channels: 3 | 4;
}

export type ReplacementSource = { jpeg_path: string } | RawReplacementSource;

export const isJpegPath = (path: string): boolean => /\.jpe?g$/i.test(path);

/**
 * The EXIF Orientation tag (1–8; 1 = upright) from a JPEG's APP1 segment, or
 * 1 when absent/unparseable. Byte passthrough embeds the SENSOR pixel grid —
 * PDF viewers ignore EXIF — so a phone photo shot in portrait would land
 * sideways; any orientation ≠ 1 must take the decode path instead, where the
 * webview applies the rotation (review-caught).
 */
export function jpegExifOrientation(data: Uint8Array): number {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = data[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) return 1; // scan data — no APP1 seen
    const seglen = (data[i + 2] << 8) | data[i + 3];
    if (marker === 0xe1 && seglen >= 14) {
      const p = i + 4;
      // "Exif\0\0" then a TIFF header.
      if (
        data[p] === 0x45 && data[p + 1] === 0x78 && data[p + 2] === 0x69 &&
        data[p + 3] === 0x66 && data[p + 4] === 0 && data[p + 5] === 0
      ) {
        const tiff = p + 6;
        const little = data[tiff] === 0x49 && data[tiff + 1] === 0x49;
        const u16 = (off: number): number =>
          little ? data[off] | (data[off + 1] << 8) : (data[off] << 8) | data[off + 1];
        const u32 = (off: number): number =>
          little
            ? (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0
            : ((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]) >>> 0;
        const ifd = tiff + u32(tiff + 4);
        if (ifd + 2 <= data.length) {
          const entries = u16(ifd);
          for (let e = 0; e < entries; e++) {
            const entry = ifd + 2 + e * 12;
            if (entry + 12 > data.length) break;
            if (u16(entry) === 0x0112) {
              const value = u16(entry + 8);
              return value >= 1 && value <= 8 ? value : 1;
            }
          }
        }
      }
      return 1;
    }
    i += 2 + seglen;
  }
  return 1;
}

/** The engine's specific "re-send as raw" signal (page_images._jpeg_info /
 * _image_from_source raise it for JPEG flavors passthrough can't bless). */
export const engineWantsRawFallback = (message: string): boolean =>
  /send raw pixels|not a JPEG|no SOF marker/i.test(message);

/** True when any pixel is even slightly transparent — those need the RGBA
 * path (engine splits an /SMask); fully-opaque images ship as RGB (25%
 * smaller, and the common case for photos/scans). */
export function hasAlpha(rgba: Uint8ClampedArray | Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true;
  }
  return false;
}

/** RGBA → packed RGB. A plain JIT-compiled loop — ~tens of ms on a
 * camera-sized image, and it only runs when the source has no alpha to
 * preserve anyway. */
export function stripAlpha(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const pixels = rgba.length / 4;
  const rgb = new Uint8Array(pixels * 3);
  for (let p = 0, s = 0, d = 0; p < pixels; p++, s += 4, d += 3) {
    rgb[d] = rgba[s];
    rgb[d + 1] = rgba[s + 1];
    rgb[d + 2] = rgba[s + 2];
  }
  return rgb;
}

/** Decode arbitrary image bytes via the webview and produce the engine's
 * raw source, writing pixels through the injected temp-writer. */
export async function decodeToRawSource(
  bytes: Uint8Array,
  writeTemp: (data: Uint8Array) => Promise<string>,
): Promise<RawReplacementSource> {
  const copy = new Uint8Array(bytes); // detached-buffer hygiene
  // 'from-image' EXPLICITLY: EXIF orientation must be applied here — this
  // path is exactly where EXIF-rotated photos are routed (review-caught).
  const bitmap = await createImageBitmap(new Blob([copy.buffer as ArrayBuffer]), {
    imageOrientation: 'from-image',
  });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('image decode: no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const alpha = hasAlpha(rgba);
    const payload = alpha ? new Uint8Array(rgba.buffer.slice(0)) : stripAlpha(rgba);
    const rawPath = await writeTemp(payload);
    return {
      raw_path: rawPath,
      width: bitmap.width,
      height: bitmap.height,
      channels: alpha ? 4 : 3,
    };
  } finally {
    bitmap.close();
  }
}
