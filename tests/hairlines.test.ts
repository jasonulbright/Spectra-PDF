import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REPLACEMENT_PT,
  DEFAULT_THRESHOLD_PT,
  type HairlineReport,
  boundsProblem,
  unreadablePages,
  widthSummary,
} from '../src/renderer/lib/hairlines';

function report(over: Partial<HairlineReport> = {}): HairlineReport {
  return {
    threshold_pt: 0.25,
    count: 0,
    stroke_count: 0,
    annotation_count: 0,
    widths: [],
    pages: [],
    ...over,
  };
}

describe('the two widths', () => {
  it('a threshold of zero or less is refused', () => {
    expect(boundsProblem(0, 0.25)).toBe('threshold');
    expect(boundsProblem(-1, 0.25)).toBe('threshold');
  });

  it('a replacement below the threshold would leave a hairline behind', () => {
    expect(boundsProblem(0.5, 0.25)).toBe('replacement');
  });

  it('equal widths are allowed, and are the defaults', () => {
    expect(boundsProblem(0.25, 0.25)).toBeNull();
    expect(boundsProblem(DEFAULT_THRESHOLD_PT, DEFAULT_REPLACEMENT_PT)).toBeNull();
  });

  it('a NaN threshold is refused rather than compared into silence', () => {
    expect(boundsProblem(Number.NaN, 0.25)).toBe('threshold');
  });
});

describe('the report the panel shows before anything is rewritten', () => {
  it('widths are listed thinnest first', () => {
    const summary = widthSummary(report({
      widths: [
        { effective_pt: 0.24, count: 1 },
        { effective_pt: 0, count: 3 },
        { effective_pt: 0.1, count: 2 },
      ],
    }));
    expect(summary.map((w) => w.effective_pt)).toEqual([0, 0.1, 0.24]);
  });

  it('an absent report is empty rather than a crash', () => {
    expect(widthSummary(null)).toEqual([]);
    expect(unreadablePages(null)).toEqual([]);
  });

  it('a page whose stream could not be read is named, never dropped silently', () => {
    const pages = unreadablePages(report({
      pages: [
        { page: 1, strokes: [], annotations: [], error: null },
        { page: 2, strokes: [], annotations: [], error: 'unterminated string' },
      ],
    }));
    expect(pages).toEqual([2]);
  });
});
