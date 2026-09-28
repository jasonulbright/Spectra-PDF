// The renderer half of Create PDF (vitest).
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
  createLimiter,
  captureIdToReleaseOnRowRemoval,
  classify,
  defaultOutputPath,
  dragTargetIndex,
  edgeScrollStep,
  extensionOf,
  hasThumbnail,
  hasUnsupported,
  moveRow,
  needsQualityPreset,
  orderSelection,
  removeRow,
  reorderRows,
  rowFromPath,
  toEngineSources,
} from '../src/renderer/lib/create-pdf';
import { DIALOG_STRINGS } from '../src/renderer/i18n-dialogs';
import { initialState } from '../src/renderer/state/reducer';
import { unsavedAmong } from '../src/renderer/state/selectors';
import type { AppState } from '../src/renderer/state/types';

const ENGINE_CREATE_PDF = readFileSync(
  resolve(__dirname, '../src/engine/create_pdf.py'),
  'utf-8',
);
const ENGINE_SOFFICE = readFileSync(resolve(__dirname, '../src/engine/soffice.py'), 'utf-8');
// Rust's copy of the accepted set. It lives in its own module rather than
// inside the picker command because TWO Rust surfaces need it — the native
// source picker and `batch --operation create-pdf`'s folder walk — and two
// copies inside one process would be a drift this cross-process test could
// not even see.
const RUST_SOURCES = readFileSync(
  resolve(__dirname, '../src-tauri/src/create_pdf_sources.rs'),
  'utf-8',
);

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

  it("Rust's accepted set offers every accepted suffix", () => {
    const offered = new Set(
      [...RUST_SOURCES.matchAll(/"([a-z0-9]{1,5})"/g)].map((m) => `.${m[1]}`),
    );
    for (const suffix of ACCEPTED_SUFFIXES) {
      expect(offered.has(suffix), `${suffix} missing from create_pdf_sources.rs`).toBe(true);
    }
  });

  it('the picker and the batch walk read that ONE Rust set', () => {
    // The drift this stops is inside a single process, so no cross-process
    // assertion can see it: a second hard-coded list in the picker or in the
    // CLI would pass every test above while accepting a different set.
    const commands = readFileSync(resolve(__dirname, '../src-tauri/src/commands.rs'), 'utf-8');
    const cli = readFileSync(resolve(__dirname, '../src-tauri/src/cli.rs'), 'utf-8');
    expect(commands).toContain('create_pdf_sources::');
    expect(cli).toContain('create_pdf_sources::accepts');
    // Probed with suffixes that belong to NO other feature — `docx` would
    // false-positive on `export --format docx`, which is a different set
    // entirely.
    for (const source of [commands, cli]) {
      for (const marker of ['"heic"', '"fodp"', '"jpx"']) {
        expect(source, marker).not.toContain(marker);
      }
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

  it('releases a web capture only after its last source row is removed', () => {
    const rows = [
      { ...rowFromPath('page-1.pdf'), captureId: 'capture-a' },
      { ...rowFromPath('page-2.pdf'), captureId: 'capture-a' },
      { ...rowFromPath('page-3.pdf'), captureId: 'capture-b' },
    ];
    expect(captureIdToReleaseOnRowRemoval(rows, rows[0].id)).toBeNull();
    expect(captureIdToReleaseOnRowRemoval(rows, rows[1].id)).toBeNull();
    expect(captureIdToReleaseOnRowRemoval(rows, rows[2].id)).toBe('capture-b');
    expect(captureIdToReleaseOnRowRemoval(rows, 'missing')).toBeNull();
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

describe('a picked batch keeps the order the folder listed it (issue 39)', () => {
  it('does not make the last-clicked image page 1', () => {
    // The Windows picker delivers the focused (last-clicked) item first.
    const delivered = ['C:/scans/p3.png', 'C:/scans/p1.png', 'C:/scans/p2.png'];
    const rows = addPaths([], orderSelection(delivered));
    expect(toEngineSources(rows)).toEqual([
      { path: 'C:/scans/p1.png' },
      { path: 'C:/scans/p2.png' },
      { path: 'C:/scans/p3.png' },
    ]);
  });

  it('orders numbered names numerically and ignores case', () => {
    expect(orderSelection(['C:/s/IMG10.png', 'C:/s/img2.png', 'C:/s/Img1.png'])).toEqual([
      'C:/s/Img1.png',
      'C:/s/img2.png',
      'C:/s/IMG10.png',
    ]);
  });

  it('keeps rows already in the list where they are', () => {
    const first = addPaths([], ['C:/s/z.png']);
    const next = addPaths(first, orderSelection(['C:/s/b.png', 'C:/s/a.png']));
    expect(next.map((r) => r.path)).toEqual(['C:/s/z.png', 'C:/s/a.png', 'C:/s/b.png']);
  });
});

describe('pointer reorder of the source list', () => {
  const mids = [10, 30, 50, 70];
  it('lands the dragged row after every other row whose middle is above the pointer', () => {
    expect(dragTargetIndex(mids, 0, 55)).toBe(2);
    expect(dragTargetIndex(mids, 3, 5)).toBe(0);
    expect(dragTargetIndex(mids, 1, 29)).toBe(1);
    expect(dragTargetIndex(mids, 0, 100)).toBe(3);
  });

  it('matches reorderRows so a drop moves the row to the index shown', () => {
    const rows = addPaths([], ['C:/a.png', 'C:/b.png', 'C:/c.png', 'C:/d.png']);
    const moved = reorderRows(rows, 0, dragTargetIndex(mids, 0, 55));
    expect(moved.map((r) => baseName(r.path ?? ''))).toEqual(['b.png', 'c.png', 'a.png', 'd.png']);
  });
});

describe('list thumbnails', () => {
  it('shows one only for images the webview decodes', () => {
    expect(hasThumbnail(rowFromPath('C:/a.PNG'))).toBe(true);
    expect(hasThumbnail(rowFromPath('C:/a.jpeg'))).toBe(true);
    expect(hasThumbnail(rowFromPath('C:/a.tiff'))).toBe(false);
    expect(hasThumbnail(rowFromPath('C:/a.pdf'))).toBe(false);
    expect(hasThumbnail(blankRow())).toBe(false);
  });
});

describe('thumbnail reads are bounded', () => {
  it('never runs more than the limit at once and skips a task no longer wanted', async () => {
    const run = createLimiter(2);
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const task = () =>
      new Promise<number>((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        releases.push(() => {
          active -= 1;
          resolve(1);
        });
      });
    const results = [run(task), run(task), run(task), run(task, () => false)];
    await Promise.resolve();
    expect(peak).toBe(2);
    while (releases.length > 0) {
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(await Promise.all(results)).toEqual([1, 1, 1, null]);
    expect(peak).toBe(2);
  });
});

describe('edge auto-scroll during a row drag', () => {
  it('scrolls up near the top, down near the bottom, and not in between', () => {
    expect(edgeScrollStep(100, 300, 102)).toBeLessThan(0);
    expect(edgeScrollStep(100, 300, 298)).toBeGreaterThan(0);
    expect(edgeScrollStep(100, 300, 200)).toBe(0);
    expect(edgeScrollStep(100, 300, 50)).toBe(-12);
  });
});

describe('post-OCR save covers every changed file', () => {
  it('lists the open files among the given paths that hold unsaved changes', () => {
    const file = (path: string, dirty: boolean) => [path, { path, dirty }] as const;
    const state = {
      ...initialState,
      files: new Map([file('C:/a.pdf', true), file('C:/b.pdf', false), file('C:/c.pdf', false)]),
      pageDirtyPaths: ['C:/c.pdf'],
    } as unknown as AppState;
    expect(unsavedAmong(state, ['C:/a.pdf', 'C:/b.pdf', 'C:/c.pdf', 'C:/gone.pdf'])).toEqual([
      'C:/a.pdf',
      'C:/c.pdf',
    ]);
  });

  it('never lists an import-only source', () => {
    const state = {
      ...initialState,
      files: new Map([['C:/ghost.pdf', { path: 'C:/ghost.pdf', dirty: true, importOnly: true }]]),
      pageDirtyPaths: ['C:/ghost.pdf'],
    } as unknown as AppState;
    expect(unsavedAmong(state, ['C:/ghost.pdf'])).toEqual([]);
  });
});
