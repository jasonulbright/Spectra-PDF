import { describe, it, expect } from 'vitest';
import {
  hasAlpha,
  stripAlpha,
  isJpegPath,
  engineWantsRawFallback,
  jpegExifOrientation,
} from '../src/renderer/lib/image-replace';
import { fetchEditPlacements } from '../src/renderer/lib/edit-images';

describe('image-replace helpers (7.1)', () => {
  it('hasAlpha: fully opaque is false; any translucency is true', () => {
    expect(hasAlpha(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
    expect(hasAlpha(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
    expect(hasAlpha(new Uint8Array([]))).toBe(false);
  });

  it('stripAlpha interleaves RGB correctly', () => {
    const rgba = new Uint8Array([1, 2, 3, 255, 10, 20, 30, 128]);
    expect([...stripAlpha(rgba)]).toEqual([1, 2, 3, 10, 20, 30]);
  });

  it('isJpegPath matches .jpg/.jpeg case-insensitively, nothing else', () => {
    expect(isJpegPath('C:\\a\\photo.JPG')).toBe(true);
    expect(isJpegPath('x.jpeg')).toBe(true);
    expect(isJpegPath('x.png')).toBe(false);
    expect(isJpegPath('x.jpg.png')).toBe(false);
  });

  it('jpegExifOrientation reads the tag in both byte orders; defaults to 1', () => {
    const exifJpeg = (little: boolean, orientation: number): Uint8Array => {
      const tiff = little
        ? [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // II, 42, IFD @8
           0x01, 0x00, // 1 entry
           0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00,
           0x00, 0x00, 0x00, 0x00]
        : [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // MM, 42, IFD @8
           0x00, 0x01,
           0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
           0x00, 0x00, 0x00, 0x00];
      const app1 = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff]; // "Exif\0\0"
      const seglen = app1.length + 2;
      return new Uint8Array([
        0xff, 0xd8, // SOI
        0xff, 0xe1, (seglen >> 8) & 0xff, seglen & 0xff, ...app1,
        0xff, 0xd9, // EOI
      ]);
    };
    expect(jpegExifOrientation(exifJpeg(true, 6))).toBe(6);
    expect(jpegExifOrientation(exifJpeg(false, 8))).toBe(8);
    expect(jpegExifOrientation(exifJpeg(true, 1))).toBe(1);
    // No APP1 at all → upright.
    expect(jpegExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe(1);
    // Not a JPEG → upright (callers gate on isJpegPath anyway).
    expect(jpegExifOrientation(new Uint8Array([0x89, 0x50]))).toBe(1);
  });

  it('engineWantsRawFallback matches only the engine’s specific refusals', () => {
    expect(engineWantsRawFallback('unsupported JPEG (4 components); send raw pixels')).toBe(true);
    expect(engineWantsRawFallback('not a JPEG file')).toBe(true);
    expect(engineWantsRawFallback('no SOF marker found (unsupported JPEG)')).toBe(true);
    expect(engineWantsRawFallback('image index 5 is out of range (page has 2)')).toBe(false);
    expect(engineWantsRawFallback('engine died')).toBe(false);
  });
});

describe('fetchEditPlacements (7.1)', () => {
  it('projects engine PDF rects into display-normalized space', async () => {
    // 612x792 page, unrotated: PDF y is bottom-up; display y top-down.
    const placements = await fetchEditPlacements(
      async () => ({
        images: [{ index: 0, rect: [0, 792 * 0.75, 612 * 0.25, 792], nested: false }],
      }),
      'C:\\w.pdf',
      1,
      { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 },
    );
    expect(placements).toEqual([
      // opacity defaults to 1 when the engine omits it (9.C3 seed);
      // kind defaults to 'xobject' (9.C4 — inline draws report 'inline');
      // crop defaults to null (C3-tail — pre-tail engines omit it).
      {
        index: 0,
        nested: false,
        rect: { x: 0, y: 0, w: 0.25, h: 0.25 },
        opacity: 1,
        kind: 'xobject',
        crop: null,
      },
    ]);
  });

  it('9-§I.0-S8: filters out clipped-away placements, preserving engine index', async () => {
    const placements = await fetchEditPlacements(
      async () => ({
        images: [
          { index: 0, rect: [0, 0, 100, 100], nested: false },
          { index: 1, rect: [500, 500, 540, 540], nested: false, clipped: true },
          { index: 2, rect: [10, 10, 50, 50], nested: false },
        ],
      }),
      'C:\\w.pdf',
      1,
      { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 },
    );
    // The clipped placement (engine index 1) is gone; survivors keep their
    // engine indices so a mutator still targets the right draw.
    expect(placements.map((p) => p.index)).toEqual([0, 2]);
  });

  it('crop threads through; degenerate/inverted intersections null out (C3-tail)', async () => {
    const fetch = (crop: unknown): ReturnType<typeof fetchEditPlacements> =>
      fetchEditPlacements(
        async () => ({ images: [{ index: 0, rect: [0, 0, 100, 100], nested: false, crop }] }),
        'C:\\w.pdf',
        1,
        { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 },
      );
    expect((await fetch([0.25, 0.25, 0.75, 0.75]))[0].crop).toEqual([0.25, 0.25, 0.75, 0.75]);
    // A pre-tail disjoint stack lists an INVERTED intersection — no sane
    // handle seed; the guard nulls it (band-crop heals via replace).
    expect((await fetch([0.6, 0.6, 0.3, 0.3]))[0].crop).toBe(null);
    expect((await fetch([0.2, 0.2, 0.2, 0.8]))[0].crop).toBe(null); // zero width
    expect((await fetch(null))[0].crop).toBe(null);
  });

  it('projects under a baked 90° rotation', async () => {
    const placements = await fetchEditPlacements(
      async () => ({ images: [{ index: 0, rect: [0, 0, 612, 792], nested: true }] }),
      'C:\\w.pdf',
      1,
      { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 90 },
    );
    // The full page maps to the full display box regardless of rotation.
    expect(placements[0].rect.x).toBeCloseTo(0);
    expect(placements[0].rect.y).toBeCloseTo(0);
    expect(placements[0].rect.w).toBeCloseTo(1);
    expect(placements[0].rect.h).toBeCloseTo(1);
    expect(placements[0].nested).toBe(true);
  });
});
