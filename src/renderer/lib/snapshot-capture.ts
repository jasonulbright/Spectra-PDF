/**
 * Snapshot capture — the render half.
 *
 * The band names a region of the page as the reader SEES it. The capture
 * re-renders that page through the same pdf.js proxy the view uses, at a
 * fixed resolution rather than the current zoom, and crops the band out of
 * the result. Same rasterizer as the page on screen, so the capture cannot
 * disagree with what was pointed at; fixed DPI, so a reader zoomed out to 40%
 * does not silently paste a 40%-detail picture into another document.
 *
 * Only the page region is captured — annotations, form values, redaction
 * marks and the find highlight are canvas overlays, not page pixels, and a
 * snapshot is of the DOCUMENT.
 */

import type { PDFPageProxy } from 'pdfjs-dist';
import {
  buildDib,
  packSnapshotPayload,
  scaleForDpi,
  snapshotPixelRect,
  clampSnapshotDpi,
  type NormRect,
} from './snapshot-image';
import { imageClipboard, type ClipboardImage } from './tauri-bridge';

/** A captured region, still on the page as a transient card. Same lifecycle
 * as the crop placement: single, page-anchored, view state only. */
export interface SnapshotPlacement {
  id: string;
  /** File path at capture time — for buffer-identity invalidation. */
  path: string;
  pageId: string;
  /** Display-normalised, in the orientation shown at capture time. */
  rect: { x: number; y: number; w: number; h: number };
  rotationAtDraw: 0 | 90 | 180 | 270;
  /** Pixel size of the raster the clipboard received, and the formats it
   * carries — both READ BACK from the clipboard, not reported by the write. */
  width: number;
  height: number;
  formats: string[];
  /** The PNG the clipboard holds, kept so *Save image…* writes the SAME
   * raster rather than re-rendering one that could differ. */
  png: Uint8Array;
}

export interface CaptureResult {
  png: Uint8Array;
  width: number;
  height: number;
  clipboard: ClipboardImage;
}

/** The rotation a page is drawn at: its own `/Rotate` composed with the
 * in-memory delta, the composition every raster in the view uses. */
export function displayRotation(bakedRotate: number, rotationExtra: number): number {
  return ((((bakedRotate || 0) + rotationExtra) % 360) + 360) % 360;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('the captured region could not be encoded'));
        return;
      }
      blob
        .arrayBuffer()
        .then((buf) => resolve(new Uint8Array(buf)))
        .catch(reject);
    }, 'image/png');
  });
}

/**
 * Render the band and put it on the clipboard.
 *
 * Returns null when the band has no area — a click is not a capture, and it
 * must not clear whatever the clipboard already held.
 */
export async function captureSnapshot(
  page: PDFPageProxy,
  band: NormRect,
  rotationExtra: number,
  dpi: number,
): Promise<CaptureResult | null> {
  const resolution = clampSnapshotDpi(dpi);
  const viewport = page.getViewport({
    scale: scaleForDpi(resolution),
    rotation: displayRotation(page.rotate ?? 0, rotationExtra),
  });
  const rect = snapshotPixelRect(band, viewport.width, viewport.height);
  if (!rect) return null;

  const canvas = document.createElement('canvas');
  canvas.width = rect.w;
  canvas.height = rect.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('the captured region could not be rendered');
  // The whole page is rendered THROUGH a canvas the size of the band: the
  // transform slides the region under it, so a 600-dpi capture of a corner
  // costs the corner's pixels and not the page's.
  await page.render({
    canvas,
    canvasContext: ctx,
    viewport,
    transform: [1, 0, 0, 1, -rect.x, -rect.y],
  }).promise;

  const png = await canvasToPng(canvas);
  const image = ctx.getImageData(0, 0, rect.w, rect.h);
  const dib = buildDib(image.data, rect.w, rect.h, resolution);
  const { bytes, pngLength } = packSnapshotPayload(png, dib);
  const clipboard = await imageClipboard.copyImage(bytes, pngLength);
  return { png, width: rect.w, height: rect.h, clipboard };
}
