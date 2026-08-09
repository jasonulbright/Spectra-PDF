// The content-crop panel's own model: the page-scope field and the preview
// summary. Both are arithmetic the component would otherwise carry, and there
// is no DOM test environment to exercise it there.
import { describe, it, expect } from 'vitest';
import {
  parsePageScope,
  summarizeContentCrop,
  type ContentCropResult,
} from '../src/renderer/lib/content-crop';

function page(
  n: number,
  trimmed: { left: number; bottom: number; right: number; top: number },
  source = 'content',
): ContentCropResult['pages'][number] {
  return { page: n, source, box: [0, 0, 100, 100], trimmed };
}

const NONE = { left: 0, bottom: 0, right: 0, top: 0 };

function result(partial: Partial<ContentCropResult>): ContentCropResult {
  return {
    box: 'crop',
    margin: 0,
    changed: partial.pages?.length ?? 0,
    pages: [],
    skipped: [],
    preview: true,
    ...partial,
  };
}

describe('parsePageScope', () => {
  it('reads "all" as the whole document, in any case and with space', () => {
    expect(parsePageScope('all')).toEqual({ pages: undefined });
    expect(parsePageScope('  ALL ')).toEqual({ pages: undefined });
  });

  it('reads a list, de-duplicated and ordered', () => {
    expect(parsePageScope('3, 1,3 , 2')).toEqual({ pages: [1, 2, 3] });
  });

  it('drops entries that are not page numbers', () => {
    expect(parsePageScope('1, x, 4')).toEqual({ pages: [1, 4] });
    expect(parsePageScope('0, 2')).toEqual({ pages: [2] });
  });

  // An empty list means "no pages" to the engine, so a field naming nothing
  // valid has to be an error: it would otherwise crop nothing and report
  // success.
  it('refuses a field that names no valid page', () => {
    expect(parsePageScope('')).toEqual({ error: 'badPages' });
    expect(parsePageScope('nonsense')).toEqual({ error: 'badPages' });
    expect(parsePageScope('0')).toEqual({ error: 'badPages' });
  });
});

describe('summarizeContentCrop', () => {
  it('counts pages whose box actually moves', () => {
    const s = summarizeContentCrop(
      result({
        pages: [
          page(1, { left: 20, bottom: 30, right: 10, top: 5 }),
          page(2, { left: 4, bottom: 0, right: 0, top: 0 }),
        ],
      }),
    );
    expect(s.cropped).toBe(2);
    expect(s.unchanged).toBe(0);
    expect(s.largestTrim).toBe(30);
  });

  it('reports an already-tight page rather than hiding it', () => {
    const s = summarizeContentCrop(result({ pages: [page(1, NONE), page(2, NONE)] }));
    expect(s).toMatchObject({ cropped: 0, unchanged: 2, largestTrim: 0 });
  });

  it('treats a sub-point trim as already tight', () => {
    const s = summarizeContentCrop(
      result({ pages: [page(1, { left: 0.2, bottom: 0.1, right: 0, top: 0.4 })] }),
    );
    expect(s.cropped).toBe(0);
    expect(s.unchanged).toBe(1);
  });

  it('counts how many cropped pages were measured from ink', () => {
    const s = summarizeContentCrop(
      result({
        pages: [
          page(1, { left: 20, bottom: 0, right: 0, top: 0 }, 'ink'),
          page(2, { left: 20, bottom: 0, right: 0, top: 0 }, 'content'),
          // An already-tight scan is not a cropped page and must not be
          // counted as one.
          page(3, NONE, 'ink'),
        ],
      }),
    );
    expect(s.scanned).toBe(1);
    expect(s.cropped).toBe(2);
  });

  it('carries the skipped pages the engine reported', () => {
    const s = summarizeContentCrop(
      result({
        pages: [page(1, { left: 9, bottom: 0, right: 0, top: 0 })],
        skipped: [
          { page: 2, reason: 'the page has no content to crop to' },
          { page: 3, reason: 'resulting box is degenerate' },
        ],
      }),
    );
    expect(s.skipped).toBe(2);
  });

  it('rounds the headline trim to two places', () => {
    const s = summarizeContentCrop(
      result({ pages: [page(1, { left: 12.3456, bottom: 0, right: 0, top: 0 })] }),
    );
    expect(s.largestTrim).toBe(12.35);
  });

  it('survives a result with no pages array', () => {
    const s = summarizeContentCrop({
      box: 'crop',
      margin: 0,
      changed: 0,
      preview: true,
    } as unknown as ContentCropResult);
    expect(s).toEqual({ cropped: 0, unchanged: 0, skipped: 0, scanned: 0, largestTrim: 0 });
  });
});
