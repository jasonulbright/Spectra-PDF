import { describe, it, expect } from 'vitest';
import {
  EMPTY_IMAGE_RESOLUTION,
  isScanClassified,
  parseImageResolution,
  resolutionShape,
} from '../src/renderer/lib/image-resolution';

describe('image resolution summary model', () => {
  it('parses the engine payload', () => {
    const parsed = parseImageResolution({
      file: 'x.pdf',
      pages: 12,
      images: 30,
      unmeasured: 2,
      min_dpi: 72,
      median_dpi: 150,
      max_dpi: 918,
      scan_pages: 10,
    });
    expect(parsed).toEqual({
      pages: 12,
      images: 30,
      unmeasured: 2,
      minDpi: 72,
      medianDpi: 150,
      maxDpi: 918,
      scanPages: 10,
    });
  });

  it('reports no resolutions when nothing was measured, whatever the payload carries', () => {
    const parsed = parseImageResolution({
      pages: 4,
      images: 0,
      unmeasured: 0,
      min_dpi: 300,
      median_dpi: 300,
      max_dpi: 300,
      scan_pages: 0,
    });
    expect(parsed.minDpi).toBeNull();
    expect(parsed.medianDpi).toBeNull();
    expect(parsed.maxDpi).toBeNull();
    expect(resolutionShape(parsed)).toBe('none');
  });

  it('tolerates a missing or malformed payload', () => {
    expect(parseImageResolution({})).toEqual(EMPTY_IMAGE_RESOLUTION);
    expect(parseImageResolution({ pages: 'many', images: -3, min_dpi: null })).toEqual(
      EMPTY_IMAGE_RESOLUTION,
    );
  });

  it('calls one shared resolution "single" and a spread "range"', () => {
    const flat = parseImageResolution({
      pages: 3, images: 3, unmeasured: 0, min_dpi: 300, median_dpi: 300, max_dpi: 300, scan_pages: 0,
    });
    expect(resolutionShape(flat)).toBe('single');
    const spread = parseImageResolution({
      pages: 3, images: 3, unmeasured: 0, min_dpi: 72, median_dpi: 150, max_dpi: 300, scan_pages: 0,
    });
    expect(resolutionShape(spread)).toBe('range');
  });

  it('calls a document scanned when a majority of its pages classify', () => {
    const summary = (pages: number, scanPages: number) =>
      parseImageResolution({ pages, images: scanPages, unmeasured: 0, min_dpi: 150, median_dpi: 150, max_dpi: 150, scan_pages: scanPages });

    // The reported corpus: a long scan with a typed cover page.
    expect(isScanClassified(summary(272, 271))).toBe(true);
    expect(isScanClassified(summary(3, 3))).toBe(true);
    // Half is not a majority, and one scanned page in a report is not a scan.
    expect(isScanClassified(summary(4, 2))).toBe(false);
    expect(isScanClassified(summary(20, 1))).toBe(false);
    expect(isScanClassified(summary(10, 0))).toBe(false);
  });
});
