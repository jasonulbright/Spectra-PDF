// The Combine Files list model (vitest).
//
// The same reason `create-pdf.test.ts` exists: there is no DOM test
// environment here, so the rules that decide what Combine sends and what it
// refuses live in `lib/combine.ts` and are tested directly.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONVERTER_LABEL_KEYS,
  applyReport,
  clearRowResults,
  combineBlocker,
  isValidPageRange,
  plannedPages,
  rangeCount,
  rowContribution,
  rowState,
  setRowError,
  setRowPageCount,
  setRowRange,
  supportsPageRange,
} from '../src/renderer/lib/combine';
import {
  ACCEPTED_SUFFIXES,
  addPaths,
  blankRow,
  classify,
  rowFromPath,
  toEngineSources,
  type SourceRow,
} from '../src/renderer/lib/create-pdf';
import { DIALOG_STRINGS } from '../src/renderer/i18n-dialogs';

const ENGINE_CREATE_PDF = readFileSync(
  resolve(__dirname, '../src/engine/create_pdf.py'),
  'utf-8',
);

describe('page ranges', () => {
  it('accepts pages, spans and lists of both — and an EMPTY spec', () => {
    // Empty is "every page": the field starts empty, and a user who has not
    // typed anything has not made a mistake.
    for (const spec of ['', '   ', '1', '1-3', '1-3,5', ' 2 - 4 , 9 ', '10,11,12']) {
      expect(isValidPageRange(spec), spec).toBe(true);
    }
  });

  it('refuses what is not a range at all', () => {
    for (const spec of ['abc', '1-', '-3', '1,,2', ',', '1;2', '1..3', '1-2-3']) {
      expect(isValidPageRange(spec), spec).toBe(false);
    }
  });

  it('mirrors the engine spelling — the SAME shape create_pdf validates', () => {
    // Two validators, one grammar. A dialog that refuses early and an engine
    // that refuses late must not disagree about what "1-3,5" means.
    expect(ENGINE_CREATE_PDF).toContain('^\\s*\\d+\\s*(?:-\\s*\\d+\\s*)?$');
  });

  it('counts what a range selects, clamped exactly as the engine clamps', () => {
    expect(rangeCount('', 6)).toBe(6);
    expect(rangeCount('2-3', 6)).toBe(2);
    expect(rangeCount('1,4,6', 6)).toBe(3);
    // A span's END is clamped to the document; pages past it drop out.
    expect(rangeCount('1-999', 6)).toBe(6);
    expect(rangeCount('99', 6)).toBe(0);
    // Reversed spans select nothing, and a page named twice contributes
    // twice — both are what `engine/split.py`'s parse_ranges does, and
    // guessing otherwise would make the preview disagree with the file.
    expect(rangeCount('4-2', 6)).toBe(0);
    expect(rangeCount('1,1', 6)).toBe(2);
    // A spec that is not a range at all is not a count — the blocker catches
    // it, so this must not silently report zero pages.
    expect(rangeCount('abc', 6)).toBe(6);
  });

  it('offers a range only where the page count is knowable up front', () => {
    expect(supportsPageRange(rowFromPath('a.pdf'))).toBe(true);
    // A .docx's page count is a property of the CONVERSION, so a range typed
    // before it runs would be a guess dressed as a choice.
    expect(supportsPageRange(rowFromPath('a.docx'))).toBe(false);
    expect(supportsPageRange(rowFromPath('a.png'))).toBe(false);
    expect(supportsPageRange(blankRow())).toBe(false);
  });

  it('sends a range to the engine only when there is one', () => {
    const rows = addPaths([], ['a.pdf', 'b.pdf']);
    const ranged = setRowRange(rows, rows[0].id, ' 2-3 ');
    expect(toEngineSources(ranged)).toEqual([
      { path: 'a.pdf', pages: '2-3' },
      { path: 'b.pdf' },
    ]);
    // An empty string is a range nobody typed — never sent.
    expect(toEngineSources(setRowRange(rows, rows[0].id, '  '))).toEqual([
      { path: 'a.pdf' },
      { path: 'b.pdf' },
    ]);
  });

  it('never sends a range on a blank member — the engine refuses one', () => {
    const rows: SourceRow[] = [blankRow()];
    expect(toEngineSources(rows)).toEqual([{ kind: 'blank' }]);
    expect(ENGINE_CREATE_PDF).toContain('a blank page has no pages to select a range from');
  });
});

describe('what a row contributes', () => {
  it('counts a blank as one page without asking anyone', () => {
    expect(rowContribution(blankRow())).toBe(1);
  });

  it('is unknown until the page count is', () => {
    const row = rowFromPath('a.docx');
    expect(rowContribution(row)).toBe(null);
    expect(rowContribution({ ...row, pageCount: 4 })).toBe(4);
  });

  it('honours the range, not the whole document', () => {
    const row = { ...rowFromPath('a.pdf'), pageCount: 10, pages: '2-4' };
    expect(rowContribution(row)).toBe(3);
  });

  it('is unknown for a refused row, whatever count it once had', () => {
    const row = { ...rowFromPath('a.pdf'), pageCount: 10, error: 'nope' };
    expect(rowContribution(row)).toBe(null);
    expect(rowContribution(rowFromPath('a.zip'))).toBe(null);
  });

  it('prefers what the run REPORTED over the derived preview', () => {
    // The report counts what the member PUT IN. Folding it back into
    // `pageCount` would make the next preview apply the range to an
    // already-ranged count — 10 pages, "2-4", reported 3, previewed 2.
    const row = { ...rowFromPath('a.pdf'), pageCount: 10, pages: '2-4', contributed: 3 };
    expect(rowContribution(row)).toBe(3);
  });

  it('totals the list and admits when the total is not yet known', () => {
    const known = [
      { ...rowFromPath('a.pdf'), pageCount: 3 },
      { ...rowFromPath('b.pdf'), pageCount: 10, pages: '1-2' },
      blankRow(),
    ];
    expect(plannedPages(known)).toEqual({ pages: 6, known: true });
    expect(plannedPages([...known, rowFromPath('c.docx')])).toEqual({
      pages: 6,
      known: false,
    });
  });
});

describe('the engine report folds back onto the list', () => {
  it('matches by INDEX, so two rows naming one file cannot collapse', () => {
    const rows = [rowFromPath('a.pdf'), rowFromPath('b.docx'), blankRow()];
    const folded = applyReport(rows, [
      { path: 'a.pdf', kind: 'pdf', pages: 3 },
      { path: 'b.docx', kind: '', pages: 0, error: 'LibreOffice is not available' },
      { kind: 'blank', pages: 1 },
    ]);
    expect(folded.map((r) => r.contributed)).toEqual([3, 0, 1]);
    expect(folded[1].error).toBe('LibreOffice is not available');
    expect(folded[0].error).toBeUndefined();
    // Ids survive, so a row's identity (and its React key) is untouched.
    expect(folded.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it('CLEARS a previous error when the row succeeds this time', () => {
    const rows = [{ ...rowFromPath('a.docx'), error: 'was broken' }];
    const folded = applyReport(rows, [{ path: 'a.docx', kind: 'office', pages: 2 }]);
    expect(folded[0].error).toBeUndefined();
  });

  it('leaves rows the report says nothing about alone', () => {
    const rows = [rowFromPath('a.pdf'), rowFromPath('b.pdf')];
    expect(applyReport(rows, [{ path: 'a.pdf', kind: 'pdf', pages: 1 }])[1]).toEqual(rows[1]);
  });

  it('drops results but keeps what the user typed', () => {
    const rows = [
      { ...rowFromPath('a.pdf'), pages: '2-3', pageCount: 9, contributed: 2, error: 'stale' },
    ];
    const cleared = clearRowResults(rows);
    expect(cleared[0].error).toBeUndefined();
    expect(cleared[0].contributed).toBeUndefined();
    expect(cleared[0].pages).toBe('2-3');
    // The PROBED count is not a result of the run — a PDF's page count does
    // not change because a combine failed, and re-probing it would blank the
    // range preview for no reason.
    expect(cleared[0].pageCount).toBe(9);
  });
});

describe('row state and the converter column', () => {
  it('names the state a row is in', () => {
    expect(rowState(rowFromPath('a.pdf'))).toBe('ready');
    expect(rowState(rowFromPath('a.zip'))).toBe('unsupported');
    expect(rowState({ ...rowFromPath('a.pdf'), error: 'nope' })).toBe('error');
  });

  it('has a converter label for every kind the accepted set produces', () => {
    for (const suffix of ACCEPTED_SUFFIXES) {
      const kind = classify(`file${suffix}`) as keyof typeof CONVERTER_LABEL_KEYS;
      expect(CONVERTER_LABEL_KEYS[kind], suffix).toBeTruthy();
    }
    expect(CONVERTER_LABEL_KEYS.blank).toBeTruthy();
    for (const key of Object.values(CONVERTER_LABEL_KEYS)) {
      expect(DIALOG_STRINGS, key).toHaveProperty(key);
    }
  });

  it('sets a count and an error by id, leaving the others alone', () => {
    const rows = addPaths([], ['a.pdf', 'b.pdf']);
    expect(setRowPageCount(rows, rows[1].id, 7)[1].pageCount).toBe(7);
    expect(setRowPageCount(rows, rows[1].id, 7)[0].pageCount).toBeUndefined();
    expect(setRowError(rows, rows[0].id, 'x')[0].error).toBe('x');
    expect(setRowError(rows, 'nope', 'x')).toEqual(rows);
  });

  it('never mutates the list it is given', () => {
    const rows = addPaths([], ['a.pdf', 'b.docx']);
    const snapshot = JSON.stringify(rows);
    setRowRange(rows, rows[0].id, '1-2');
    setRowPageCount(rows, rows[0].id, 4);
    setRowError(rows, rows[0].id, 'x');
    clearRowResults(rows);
    applyReport(rows, [{ path: 'a.pdf', kind: 'pdf', pages: 1 }]);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe('when Combine refuses to run, and why', () => {
  const destination = { docId: 'd1', name: 'Report', pages: 4 };

  it('needs sources', () => {
    expect(combineBlocker([], 'new', null)).toBe('dialog.combine.needsSources');
    // Blank pages alone are not a combine — they are a blank document, which
    // is Create PDF's job.
    expect(combineBlocker([blankRow(), blankRow()], 'new', null)).toBe(
      'dialog.combine.needsSources',
    );
  });

  it('refuses a list carrying something no arm converts', () => {
    expect(combineBlocker(addPaths([], ['a.pdf', 'b.zip']), 'new', null)).toBe(
      'dialog.combine.hasUnsupported',
    );
  });

  it('refuses a malformed range before any engine call', () => {
    const rows = addPaths([], ['a.pdf']);
    expect(combineBlocker(setRowRange(rows, rows[0].id, '1-'), 'new', null)).toBe(
      'dialog.combine.badRange',
    );
  });

  it('needs a destination only when appending', () => {
    const rows = addPaths([], ['a.pdf']);
    expect(combineBlocker(rows, 'append', null)).toBe('dialog.combine.needsDestination');
    expect(combineBlocker(rows, 'append', destination)).toBe(null);
    expect(combineBlocker(rows, 'new', null)).toBe(null);
  });

  it('names every blocker with a key the dialog catalog carries', () => {
    const keys = [
      'dialog.combine.needsSources',
      'dialog.combine.hasUnsupported',
      'dialog.combine.badRange',
      'dialog.combine.needsDestination',
    ];
    for (const key of keys) expect(DIALOG_STRINGS, key).toHaveProperty(key);
  });
});
