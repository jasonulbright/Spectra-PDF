import { describe, it, expect } from 'vitest';
import {
  hasCustomLabels,
  labelFor,
  resolvePageEntry,
  sanitizePageEntry,
} from '../src/renderer/lib/page-labels';

// A book: four roman pages of front matter, then a body restarting at 1.
const BOOK = ['i', 'ii', 'iii', 'iv', '1', '2', '3', '4'];
const PLAIN = ['1', '2', '3', '4'];

describe('hasCustomLabels', () => {
  it('is false when the labels are just the sheet numbers', () => {
    expect(hasCustomLabels(PLAIN)).toBe(false);
    expect(hasCustomLabels([])).toBe(false);
    expect(hasCustomLabels(null)).toBe(false);
  });

  it('is true as soon as one page is labelled differently', () => {
    expect(hasCustomLabels(BOOK)).toBe(true);
    expect(hasCustomLabels(['1', '2', 'A-1'])).toBe(true);
  });
});

describe('labelFor', () => {
  it('shows the label', () => {
    expect(labelFor(4, BOOK)).toBe('iv');
    expect(labelFor(5, BOOK)).toBe('1');
  });

  it('falls back to the page number when there is no label', () => {
    expect(labelFor(3, null)).toBe('3');
    expect(labelFor(9, BOOK)).toBe('9'); // past the end of the label list
    expect(labelFor(2, ['', ''])).toBe('2'); // an empty label is not a label
  });
});

describe('resolvePageEntry', () => {
  it('resolves a label to its sheet', () => {
    expect(resolvePageEntry('iv', BOOK, 8)).toBe(4);
    expect(resolvePageEntry('iii', BOOK, 8)).toBe(3);
  });

  it('prefers the LABEL over the sheet number where they disagree', () => {
    // The body's "1" is sheet 5. A reader typing 1 wants the page printed 1
    // — the one they can see — not the first sheet.
    expect(resolvePageEntry('1', BOOK, 8)).toBe(5);
  });

  it('falls back to the sheet number when no label matches', () => {
    expect(resolvePageEntry('7', BOOK, 8)).toBe(7);
    expect(resolvePageEntry('3', PLAIN, 4)).toBe(3);
    expect(resolvePageEntry('2', null, 10)).toBe(2);
  });

  it('is case- and space-insensitive', () => {
    expect(resolvePageEntry('IV', BOOK, 8)).toBe(4);
    expect(resolvePageEntry('  iv  ', BOOK, 8)).toBe(4);
  });

  it('clamps a too-large sheet number and rejects nonsense', () => {
    expect(resolvePageEntry('99', PLAIN, 4)).toBe(4);
    expect(resolvePageEntry('0', PLAIN, 4)).toBe(null);
    expect(resolvePageEntry('', BOOK, 8)).toBe(null);
    expect(resolvePageEntry('nowhere', BOOK, 8)).toBe(null);
    expect(resolvePageEntry('2', BOOK, 0)).toBe(null);
  });

  it('takes the FIRST of repeated labels', () => {
    // Two ranges both restarting at 1 is ordinary (a body and an appendix).
    const repeated = ['1', '2', '1', '2'];
    expect(resolvePageEntry('1', repeated, 4)).toBe(1);
    expect(resolvePageEntry('2', repeated, 4)).toBe(2);
  });

  it('never resolves a label beyond the document', () => {
    // A stale label list (fetched before pages were deleted) must not send
    // the reader to a page that no longer exists.
    expect(resolvePageEntry('iv', BOOK, 3)).toBe(null);
  });
});

describe('sanitizePageEntry', () => {
  it('keeps the digits-only behaviour when there are no custom labels', () => {
    expect(sanitizePageEntry('a1b2', false)).toBe('12');
  });

  it('accepts letters, prefixes and hyphens when labels are custom', () => {
    expect(sanitizePageEntry('A-1', true)).toBe('A-1');
    expect(sanitizePageEntry('iv', true)).toBe('iv');
  });
});
