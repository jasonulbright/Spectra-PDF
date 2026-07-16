// Print wire contract + range validation (M-P). The dialog's engine call is
// assembled by buildPrintParams; these pin the exact wire KEY NAMES the
// engine's print_pdf signature accepts (pytest pins the same set from the
// Python side) — a renamed key would otherwise surface only as every print
// failing at run time with an unexpected-argument error.
import { describe, expect, it } from 'vitest';
import {
  buildPrintParams,
  copiesError,
  normalizePageRange,
  pageRangeError,
  MAX_COPIES,
} from '../src/renderer/lib/print-params';

describe('buildPrintParams', () => {
  it('produces exactly the engine print_pdf wire keys', () => {
    const p = buildPrintParams({
      file: 'C:\\work\\a.pdf',
      printer: 'My Printer',
      gsPath: 'C:\\gs\\gswin64c.exe',
      pages: '1-3, 5',
      copies: 2,
      fit: 'actual',
    });
    expect(p).toEqual({
      file: 'C:\\work\\a.pdf',
      printer: 'My Printer',
      gs_path: 'C:\\gs\\gswin64c.exe',
      pages: '1-3,5',
      copies: 2,
      fit: 'actual',
    });
    // The exact key set, not a superset — print_pdf(**params) rejects
    // anything extra.
    expect(Object.keys(p).sort()).toEqual([
      'copies', 'file', 'fit', 'gs_path', 'pages', 'printer',
    ]);
  });

  it('normalizes the range and keeps "" for all pages', () => {
    expect(normalizePageRange('1-3, 5')).toBe('1-3,5');
    expect(buildPrintParams({
      file: 'a.pdf', printer: 'P', gsPath: 'gs', pages: '', copies: 1, fit: 'fit',
    }).pages).toBe('');
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
  it('accepts whole numbers 1..MAX_COPIES', () => {
    expect(copiesError('1')).toBeNull();
    expect(copiesError(String(MAX_COPIES))).toBeNull();
    expect(copiesError(' 3 ')).toBeNull();
  });

  it.each(['0', '100', '-1', '2.5', 'two', ''])('rejects %j', (bad) => {
    expect(copiesError(bad)).not.toBeNull();
  });
});
