// P22 slice C — the renderer half of Create PDF (brief 41 § 10, vitest).
//
// There is no DOM test environment in this repo, which is precisely why the
// list model lives in `lib/create-pdf.ts` and not inside the component: a rule
// living in a component is a rule with no test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ACCEPTED_SUFFIXES,
  IMAGE_SUFFIXES,
  KIND_LABEL_KEYS,
  OFFICE_SUFFIXES,
  ORIENTATIONS,
  PAGE_SIZES,
  POSTSCRIPT_SUFFIXES,
  addPaths,
  baseName,
  blankRow,
  classify,
  defaultOutputPath,
  extensionOf,
  hasUnsupported,
  moveRow,
  needsQualityPreset,
  removeRow,
  reorderRows,
  rowFromPath,
  toEngineSources,
} from '../src/renderer/lib/create-pdf';
import { DIALOG_STRINGS } from '../src/renderer/i18n-dialogs';

const ENGINE_CREATE_PDF = readFileSync(
  resolve(__dirname, '../src/engine/create_pdf.py'),
  'utf-8',
);
const ENGINE_SOFFICE = readFileSync(resolve(__dirname, '../src/engine/soffice.py'), 'utf-8');
const RUST_COMMANDS = readFileSync(resolve(__dirname, '../src-tauri/src/commands.rs'), 'utf-8');

/** The suffix tuple a Python module declares, as a set. */
function pythonSuffixes(source: string, name: string): Set<string> {
  const open = source.indexOf(`${name} = (`);
  expect(open, `${name} not found`).toBeGreaterThan(-1);
  // Scan to the MATCHING paren, not to the next `\n)`: the tuples are written
  // one-per-line in one module and on a single line in another, and a
  // line-shaped terminator silently swallowed the next declaration.
  const from = source.indexOf('(', open);
  let depth = 0;
  let close = from;
  for (let i = from; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const body = source.slice(from, close);
  return new Set([...body.matchAll(/"(\.[a-z0-9]+)"/g)].map((m) => m[1]));
}

describe('classification', () => {
  it('is total over the accepted set — every suffix names an arm', () => {
    for (const suffix of ACCEPTED_SUFFIXES) {
      const kind = classify(`file${suffix}`);
      expect(kind, suffix).not.toBe('');
    }
  });

  it('names a kind the badge list can label', () => {
    for (const suffix of ACCEPTED_SUFFIXES) {
      const kind = classify(`file${suffix}`) as keyof typeof KIND_LABEL_KEYS;
      expect(KIND_LABEL_KEYS[kind], suffix).toBeTruthy();
    }
    // …and every label key exists in the dialog catalog, so no badge can
    // render as a raw key string.
    for (const key of Object.values(KIND_LABEL_KEYS)) {
      expect(DIALOG_STRINGS, key).toHaveProperty(key);
    }
  });

  it('refuses what no arm converts', () => {
    for (const name of ['a.zip', 'b.exe', 'c.mp4', 'd', 'e.', '.hidden']) {
      expect(classify(name), name).toBe('');
    }
  });

  it('is case-insensitive and reads the LAST dot', () => {
    expect(classify('C:/x/REPORT.DOCX')).toBe('office');
    expect(classify('/tmp/photo.v2.HEIC')).toBe('image');
    expect(classify('deck.pdf.png')).toBe('image');
  });

  it('treats a PDF as a pass-through member, not a conversion', () => {
    expect(classify('already.pdf')).toBe('pdf');
  });

  it('never classifies a dotfile with no extension', () => {
    expect(extensionOf('.gitignore')).toBe('');
    expect(classify('.gitignore')).toBe('');
  });
});

describe('the renderer and the engine agree on what is accepted', () => {
  // Three copies of the accepted set exist because three processes need it
  // (Python converts, TypeScript badges, Rust filters the picker) and none can
  // import the others. These assertions are what stop them drifting.
  it('the image set matches engine/create_pdf.py', () => {
    expect(new Set(IMAGE_SUFFIXES)).toEqual(
      pythonSuffixes(ENGINE_CREATE_PDF, 'IMAGE_SUFFIXES'),
    );
  });

  it('the office set matches engine/soffice.py', () => {
    expect(new Set(OFFICE_SUFFIXES)).toEqual(
      pythonSuffixes(ENGINE_SOFFICE, 'OFFICE_SUFFIXES'),
    );
  });

  it('the PostScript set matches engine/create_pdf.py', () => {
    expect(new Set(POSTSCRIPT_SUFFIXES)).toEqual(
      pythonSuffixes(ENGINE_CREATE_PDF, 'POSTSCRIPT_SUFFIXES'),
    );
  });

  it("the native picker's filter offers every accepted suffix", () => {
    const offered = new Set(
      [...RUST_COMMANDS.matchAll(/"([a-z0-9]{1,5})"/g)].map((m) => `.${m[1]}`),
    );
    for (const suffix of ACCEPTED_SUFFIXES) {
      expect(offered.has(suffix), `${suffix} missing from pick_create_pdf_sources`).toBe(true);
    }
  });

  it('the page-size and orientation options match the engine', () => {
    for (const size of PAGE_SIZES) {
      expect(ENGINE_CREATE_PDF, size).toContain(`"${size}"`);
    }
    for (const value of ORIENTATIONS) {
      expect(ENGINE_CREATE_PDF, value).toContain(`"${value}"`);
    }
  });
});

describe('the source list', () => {
  it('adds paths in order and skips ones already listed', () => {
    const rows = addPaths([], ['a.png', 'b.docx', 'a.png']);
    expect(rows.map((r) => r.path)).toEqual(['a.png', 'b.docx']);
    const again = addPaths(rows, ['b.docx', 'c.ps']);
    expect(again.map((r) => r.path)).toEqual(['a.png', 'b.docx', 'c.ps']);
  });

  it('never de-duplicates blank pages — two blanks are deliberate', () => {
    const rows = [blankRow(), blankRow()];
    expect(rows).toHaveLength(2);
    expect(rows[0].id).not.toBe(rows[1].id);
    expect(addPaths(rows, ['a.png'])).toHaveLength(3);
  });

  it('keeps a row id stable across a move, so its state survives', () => {
    const rows = addPaths([], ['a.png', 'b.docx', 'c.ps']);
    const ids = rows.map((r) => r.id);
    const moved = moveRow(rows, ids[2], -2);
    expect(moved.map((r) => r.id)).toEqual([ids[2], ids[0], ids[1]]);
  });

  it('CLAMPS a move instead of wrapping', () => {
    // Wrapping would send a row held at the top straight to the bottom, which
    // is the thing a keyboard user does by accident.
    const rows = addPaths([], ['a.png', 'b.docx']);
    expect(moveRow(rows, rows[0].id, -1).map((r) => r.path)).toEqual(['a.png', 'b.docx']);
    expect(moveRow(rows, rows[1].id, 5).map((r) => r.path)).toEqual(['a.png', 'b.docx']);
    expect(moveRow(rows, rows[0].id, 1).map((r) => r.path)).toEqual(['b.docx', 'a.png']);
  });

  it('ignores a move naming a row that is gone', () => {
    const rows = addPaths([], ['a.png']);
    expect(moveRow(rows, 'nope', 1)).toEqual(rows);
  });

  it('removes by id', () => {
    const rows = addPaths([], ['a.png', 'b.docx']);
    expect(removeRow(rows, rows[0].id).map((r) => r.path)).toEqual(['b.docx']);
    expect(removeRow(rows, 'nope')).toHaveLength(2);
  });

  it('reorders by drag using ORIGINAL-list indices', () => {
    const rows = addPaths([], ['a.png', 'b.docx', 'c.ps', 'd.tif']);
    expect(reorderRows(rows, 3, 0).map((r) => r.path)).toEqual([
      'd.tif', 'a.png', 'b.docx', 'c.ps',
    ]);
    expect(reorderRows(rows, 0, 3).map((r) => r.path)).toEqual([
      'b.docx', 'c.ps', 'd.tif', 'a.png',
    ]);
  });

  it('leaves the list alone on an out-of-range or no-op drag', () => {
    const rows = addPaths([], ['a.png', 'b.docx']);
    for (const [from, to] of [[0, 0], [-1, 1], [0, 9], [5, 0]]) {
      expect(reorderRows(rows, from, to).map((r) => r.path)).toEqual(['a.png', 'b.docx']);
    }
  });

  it('never mutates the list it is given', () => {
    const rows = addPaths([], ['a.png', 'b.docx']);
    const snapshot = rows.map((r) => r.path);
    moveRow(rows, rows[0].id, 1);
    reorderRows(rows, 0, 1);
    removeRow(rows, rows[0].id);
    addPaths(rows, ['c.ps']);
    expect(rows.map((r) => r.path)).toEqual(snapshot);
  });
});

describe('what the dialog shows and sends', () => {
  it('offers the quality preset ONLY when a PostScript source is present', () => {
    // It is a `distill` parameter and means nothing for the other three arms.
    expect(needsQualityPreset(addPaths([], ['a.png', 'b.docx']))).toBe(false);
    expect(needsQualityPreset([blankRow()])).toBe(false);
    expect(needsQualityPreset(addPaths([], ['a.png', 'c.eps']))).toBe(true);
  });

  it('flags a list carrying something no arm converts', () => {
    expect(hasUnsupported(addPaths([], ['a.png']))).toBe(false);
    expect(hasUnsupported(addPaths([], ['a.png', 'b.zip']))).toBe(true);
  });

  it('sends order-preserved sources, blanks by kind', () => {
    const rows = [rowFromPath('a.docx'), blankRow(), rowFromPath('b.png')];
    expect(toEngineSources(rows)).toEqual([
      { path: 'a.docx' },
      { kind: 'blank' },
      { path: 'b.png' },
    ]);
  });

  it('names the output after the first source with a path, never a blank', () => {
    expect(defaultOutputPath([blankRow(), rowFromPath('C:/x/report.docx')])).toBe(
      'C:/x/report.pdf',
    );
    expect(defaultOutputPath([rowFromPath('C:/x/scan.TIFF')])).toBe('C:/x/scan.pdf');
    // A list of PDFs is a combine — never propose overwriting the first one.
    expect(defaultOutputPath([rowFromPath('C:/x/a.pdf')])).toBe('C:/x/a-combined.pdf');
    expect(defaultOutputPath([blankRow()])).toBe(null);
    expect(defaultOutputPath([])).toBe(null);
  });

  it('reads a base name off either slash', () => {
    expect(baseName('C:\\Users\\jane\\a.docx')).toBe('a.docx');
    expect(baseName('/home/jane/a.docx')).toBe('a.docx');
    expect(baseName('a.docx')).toBe('a.docx');
  });
});

describe('the dialog catalog covers every option the dialog renders', () => {
  it('has a label for every page size and orientation', () => {
    for (const size of PAGE_SIZES) {
      expect(DIALOG_STRINGS, size).toHaveProperty(`dialog.createPdf.pageSize.${size}`);
    }
    for (const value of ORIENTATIONS) {
      expect(DIALOG_STRINGS, value).toHaveProperty(`dialog.createPdf.orientation.${value}`);
    }
  });

  it('no longer says PostScript where the dialog is no longer PostScript-only', () => {
    // The old dialog's title and empty state named .ps/.eps; those strings are
    // REMOVED rather than reworded around, so a stale one cannot survive.
    expect(DIALOG_STRINGS).not.toHaveProperty('dialog.createPdf.noFile');
    expect(DIALOG_STRINGS).not.toHaveProperty('dialog.createPdf.pick');
    expect(DIALOG_STRINGS['dialog.createPdf.title']).toBe('Create PDF');
  });
});
