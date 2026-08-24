// White-background removal for an IMPORTED signature image, and the trim that
// follows it.
//
// A photographed or scanned signature arrives as dark ink on a bright sheet.
// Placed as-is it stamps an opaque rectangle over whatever it lands on, which
// is not what anybody means by signing a page. Removing the background is the
// difference between a signature and a sticker.
//
// PURE over pixels, deliberately: there is no DOM test environment, so the
// judgement (which pixels are background, where the ink actually ends) lives
// here where it can be tested, and the component does nothing but hand over a
// buffer and draw the result.
//
// The threshold is the user's, previewed before it is committed to, and the
// ORIGINAL pixels are what the dialog keeps — so raising, lowering, or
// switching removal off is always possible until the asset is saved. Nothing
// here mutates its input.

/** Rec. 709 luminance, 0..255, on sRGB values taken as-is. Perceptual
 * weighting matters: a saturated blue pen on white is much darker to the eye
 * than its mean channel value says, and a mean would erase it. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Where the ramp starts, below the threshold. A hard cut leaves a stair-
 * stepped edge on every stroke because an antialiased pen edge is exactly the
 * band of half-tones a hard cut splits; ramping alpha across the last stretch
 * keeps the stroke's own antialiasing instead of replacing it with a jag. */
const FEATHER = 32;

export const DEFAULT_BACKGROUND_THRESHOLD = 200;

/**
 * Make background pixels transparent, in place of nothing — a NEW buffer is
 * returned and the input is untouched.
 *
 * `threshold` is a luminance in 0..255: at or above it a pixel is fully
 * background, below `threshold - FEATHER` it is fully ink, and between the
 * two its existing alpha is scaled down proportionally. A pixel that was
 * already transparent stays transparent.
 */
export function removeBackground(
  rgba: Uint8ClampedArray,
  threshold: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const hi = Math.max(0, Math.min(255, threshold));
  const lo = Math.max(0, hi - FEATHER);
  const span = hi - lo;
  for (let i = 0; i < out.length; i += 4) {
    const alpha = out[i + 3];
    if (alpha === 0) continue;
    const lum = luminance(out[i], out[i + 1], out[i + 2]);
    if (lum >= hi) {
      out[i + 3] = 0;
    } else if (lum > lo && span > 0) {
      out[i + 3] = Math.round(alpha * (1 - (lum - lo) / span));
    }
  }
  return out;
}

/**
 * The bounding box of everything still visible, or null when nothing is.
 *
 * Run after removal so the saved asset's aspect is the SIGNATURE's, not the
 * sheet's: a mark photographed in the middle of a page would otherwise place
 * as a mostly-empty box whose visible part is a fraction of what the user
 * sized.
 *
 * `alphaMin` is the alpha a pixel must EXCEED to count as ink. Above zero by
 * default because the feather leaves a wide skirt of nearly-transparent
 * pixels that would otherwise restore most of the sheet's extent — a pixel at
 * 3% opacity is not where the signature ends.
 */
export function visibleBounds(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  alphaMin = 8,
): { x: number; y: number; w: number; h: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      if (rgba[row + x * 4 + 3] <= alphaMin) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
