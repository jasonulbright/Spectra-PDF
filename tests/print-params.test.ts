// Print wire contract + validation (M-P + O2). The dialog's engine call is
// assembled by buildPrintParams; these pin the exact wire KEY NAMES the
// engine's print_pdf signature accepts (pytest pins the same set from the
// Python side) — a renamed key would otherwise surface only as every print
// failing at run time with an unexpected-argument error.
import { describe, expect, it } from 'vitest';
import {
  buildPrintParams,
  copiesError,
  defaultPrintOptions,
  normalizePageRange,
  pageRangeError,
  posterOverlapError,
  posterScaleError,
  scaleError,
  MAX_COPIES,
  type PrintOptions,
} from '../src/renderer/lib/print-params';

function opts(over: Partial<PrintOptions> = {}): PrintOptions {
  return {
    ...defaultPrintOptions(),
    file: 'C:\\work\\a.pdf',
    printer: 'My Printer',
    gsPath: 'C:\\gs\\gswin64c.exe',
    ...over,
  };
}

describe('buildPrintParams', () => {
  it('sends exactly the six original keys when everything is defaulted', () => {
    const p = buildPrintParams(opts({ pages: '1-3, 5', copies: 2, fit: 'actual' }));
    expect(p).toEqual({
      file: 'C:\\work\\a.pdf',
      printer: 'My Printer',
      gs_path: 'C:\\gs\\gswin64c.exe',
      pages: '1-3,5',
      copies: 2,
      fit: 'actual',
    });
    // The exact key set, not a superset — defaulted options are OMITTED so
    // the engine's own defaults stay the single source of truth.
    expect(Object.keys(p).sort()).toEqual([
      'copies', 'file', 'fit', 'gs_path', 'pages', 'printer',
    ]);
  });

  it('carries the driver options with engine key names', () => {
    const p = buildPrintParams(opts({
      collate: false,
      subset: 'odd',
      reverse: true,
      duplex: 'short',
      paper: 9,
      orientation: 'landscape',
      color: 'gray',
      annots: 'document',
      asImage: true,
      imageDpi: 150,
    }));
    expect(p.collate).toBe(false);
    expect(p.subset).toBe('odd');
    expect(p.reverse).toBe(true);
    expect(p.duplex).toBe('short');
    expect(p.paper).toBe(9);
    expect(p.orientation).toBe('landscape');
    expect(p.color).toBe('gray');
    expect(p.annots).toBe('document');
    expect(p.as_image).toBe(true);
    expect(p.image_dpi).toBe(150);
  });

  it('scale mode carries the percent and the sheet', () => {
    const p = buildPrintParams(opts({
      fit: 'scale', scalePercent: 55, sheetWidth: 612, sheetHeight: 792,
    }));
    expect(p.fit).toBe('scale');
    expect(p.scale_percent).toBe(55);
    expect(p.sheet_width).toBe(612);
    expect(p.sheet_height).toBe(792);
  });

  it('layout modes carry their own option groups only', () => {
    const nup = buildPrintParams(opts({
      layout: 'nup', nupRows: 3, nupCols: 2, nupOrder: 'vertical',
      nupBorder: true, nupAutoRotate: false,
      sheetWidth: 612, sheetHeight: 792,
    }));
    expect(nup.layout).toBe('nup');
    expect(nup.nup_rows).toBe(3);
    expect(nup.nup_cols).toBe(2);
    expect(nup.nup_order).toBe('vertical');
    expect(nup.nup_border).toBe(true);
    expect(nup.nup_auto_rotate).toBe(false);
    expect(nup.booklet_subset).toBeUndefined();
    expect(nup.poster_scale).toBeUndefined();

    const booklet = buildPrintParams(opts({
      layout: 'booklet', bookletSubset: 'front', bookletBinding: 'right',
      sheetWidth: 612, sheetHeight: 792,
    }));
    expect(booklet.booklet_subset).toBe('front');
    expect(booklet.booklet_binding).toBe('right');
    expect(booklet.nup_rows).toBeUndefined();

    const poster = buildPrintParams(opts({
      layout: 'poster', posterScale: 200, posterOverlap: 12,
      posterCutMarks: true, posterLabels: true,
      sheetWidth: 612, sheetHeight: 792,
    }));
    expect(poster.poster_scale).toBe(200);
    expect(poster.poster_overlap).toBe(12);
    expect(poster.poster_cut_marks).toBe(true);
    expect(poster.poster_labels).toBe(true);
  });

  it('normalizes the range and keeps "" for all pages', () => {
    expect(normalizePageRange('1-3, 5')).toBe('1-3,5');
    expect(buildPrintParams(opts({ pages: '' })).pages).toBe('');
  });
});

describe('pageRangeError', () => {
  it('accepts empty (= all), single pages, and ascending ranges', () => {
    expect(pageRangeError('', 5)).toBeNull();
    expect(pageRangeError('   ', 5)).toBeNull();
    expect(pageRangeError('1,3,5', 5)).toBeNull();
    expect(pageRangeError('2-4', 5)).toBeNull();
    expect(pageRangeError('1-3, 5', 5)).toBeNull();
    expect(pageRangeError('1-1', 5)).toBeNull();
  });

  // Strict like the engine (the 2e lesson: a lax parse turned a typo into a
  // whole-document operation).
  it.each(['abc', '1-2-3', ',', '1,,2', '0', '5-2', '-3', '3-', '1.5', '1;2'])(
    'rejects %j',
    (bad) => {
      expect(pageRangeError(bad, 5)).not.toBeNull();
    },
  );

  it('rejects pages beyond the document, naming the count', () => {
    expect(pageRangeError('6', 5)).toMatch(/beyond the document \(5 pages\)/);
    expect(pageRangeError('1-99', 5)).toMatch(/beyond/);
    expect(pageRangeError('2', 1)).toMatch(/\(1 page\)/);
  });
});

describe('copiesError', () => {
  it('accepts whole numbers 1..MAX_COPIES (999 — the O4 flip from 99)', () => {
    expect(MAX_COPIES).toBe(999);
    expect(copiesError('1')).toBeNull();
    expect(copiesError('100')).toBeNull();
    expect(copiesError(String(MAX_COPIES))).toBeNull();
    expect(copiesError(' 3 ')).toBeNull();
  });

  it.each(['0', '1000', '-1', '2.5', 'two', ''])('rejects %j', (bad) => {
    expect(copiesError(bad)).not.toBeNull();
  });
});

describe('scale and poster validators', () => {
  it('custom scale bounds 1..1000', () => {
    expect(scaleError('50')).toBeNull();
    expect(scaleError('1000')).toBeNull();
    expect(scaleError('0')).not.toBeNull();
    expect(scaleError('1001')).not.toBeNull();
    expect(scaleError('abc')).not.toBeNull();
    expect(scaleError('')).not.toBeNull();
  });

  it('poster scale bounds 1..2000', () => {
    expect(posterScaleError('200')).toBeNull();
    expect(posterScaleError('2001')).not.toBeNull();
    expect(posterScaleError('x')).not.toBeNull();
  });

  it('poster overlap: non-negative and under half the sheet', () => {
    expect(posterOverlapError('0', 612, 792)).toBeNull();
    expect(posterOverlapError('36', 612, 792)).toBeNull();
    expect(posterOverlapError('-1', 612, 792)).not.toBeNull();
    expect(posterOverlapError('306', 612, 792)).not.toBeNull();
    // Sheet unknown: only the numeric checks apply.
    expect(posterOverlapError('9999', null, null)).toBeNull();
  });
});
