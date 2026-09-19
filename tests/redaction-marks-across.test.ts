// Unsaved redaction marks are view state bound to page ids. Page ids are
// generation-tagged and a page-tier commit keeps them, so a page that keeps
// its id across new bytes is the same page: a mark on it stays, turned back
// by the rotation the commit wrote into the page. A mark whose page is gone
// for good leaves, and an unsaved one that was in view is counted for the
// notice. Apply and save take their marks into the file: that is no loss.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import { buildCommitBytes, committedDocuments, planCommit } from '../src/renderer/lib/workspace-commit';
import {
  EMPTY_MARK_LEDGER,
  buildRedactionRegions,
  marksAcross,
  marksAfterRun,
  marksInRun,
  projectMarkRect,
  withSeededMarks,
  wroteBytes,
  type MarkLedger,
  type RedactionMark,
} from '../src/renderer/lib/redaction';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';
import type { AppAction, AppState, OpenDocument, OpenFile, PageRef, PdfBuffer } from '../src/renderer/state/types';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

function file(path: string, buffer: PdfBuffer, pageCount: number): OpenFile {
  return {
    path, workingPath: `${path}.w`, name: path, pageCount, buffer,
    dirty: false, undoStack: [], redoStack: [],
  };
}

function pages(path: string, tag: string, count: number): PageRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${path}#${tag}#p${i}`, sourceDocId: path, sourcePageIndex: i, rotation: 0 as const, width: 1, height: 1,
  }));
}

const A0 = 'a.pdf#g1#p0';
const A1 = 'a.pdf#g1#p1';
const A2 = 'a.pdf#g1#p2';
const B0 = 'b.pdf#g1#p0';

function opened(): AppState {
  const a = file('a.pdf', [1], 3);
  const b = file('b.pdf', [2], 1);
  const docs: OpenDocument[] = [
    { ...a, id: 'a#g1#0', pages: pages('a.pdf', 'g1', 3), pageCount: 3 },
    { ...b, id: 'b#g1#0', pages: pages('b.pdf', 'g1', 1), pageCount: 1 },
  ];
  return { ...initialState, files: new Map([['a.pdf', a], ['b.pdf', b]]), workspace: { documents: docs } };
}

function mark(id: string, pageId: string, extra: Partial<RedactionMark> = {}): RedactionMark {
  return {
    id,
    path: pageId.startsWith('b.pdf') ? 'b.pdf' : 'a.pdf',
    pageId,
    rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
    rotationAtDraw: 0,
    ...extra,
  };
}

const ledgerOf = (...marks: RedactionMark[]): MarkLedger => ({ ...EMPTY_MARK_LEDGER, marks });

interface World { state: AppState; ledger: MarkLedger }

/** One dispatch, and what it leaves of the ledger. */
function dispatch(world: World, action: AppAction): World {
  const state = appReducer(world.state, action);
  return { state, ledger: marksAcross(world.ledger, world.state, state) };
}

function withMark(world: World, m: RedactionMark): World {
  return { ...world, ledger: { ...world.ledger, marks: [...world.ledger.marks, m] } };
}

/** The documents new bytes of `path` hold, under ids no earlier reading minted. */
function read(state: AppState, path: string, buffer: PdfBuffer, tag: string): OpenDocument[] {
  const f = state.files.get(path)!;
  return [{ ...f, buffer, id: `${path}#${tag}#0`, pageCount: f.pageCount, pages: pages(path, tag, f.pageCount) }];
}

/** An operation's publication of `buffer` for `path`. */
function operation(state: AppState, path: string, buffer: PdfBuffer): AppAction {
  return {
    type: 'UPDATE_FILE', path, pageCount: state.files.get(path)!.pageCount, buffer,
    snapshotPath: 's', documents: read(state, path, buffer, 'g9'),
  };
}

/** The page-tier commit of every dirty path of `state`, each into `buffers[path]`. */
function commit(state: AppState, buffers: Record<string, PdfBuffer>): AppAction {
  return {
    type: 'COMMIT_PAGE_EDITS',
    updates: state.pageDirtyPaths.map((path) => {
      const docs = state.workspace.documents.filter((d) => d.path === path);
      const buffer = buffers[path];
      return {
        path,
        pageCount: docs.reduce((n, d) => n + d.pages.length, 0),
        buffer,
        snapshotPath: `s-${path}`,
        authored: {
          pages: docs.flatMap((d) => d.pages.map((p) => p.id)),
          documents: docs.map((d) => ({ id: d.id, name: d.name })),
        },
        documents: committedDocuments(docs, buffer),
      };
    }),
    planned: { pageUndoStack: state.pageUndoStack, pageRedoStack: state.pageRedoStack },
  } as AppAction;
}

/** The read-back of `path`'s committed bytes, under the ids the commit authored. */
function readBack(state: AppState, path: string): AppAction {
  return {
    type: 'SET_WORKSPACE_DOCUMENTS',
    path,
    documents: state.workspace.documents
      .filter((d) => d.path === path)
      .map((d) => ({ ...d, provisional: undefined })),
  };
}

const ids = (ledger: MarkLedger): string[] => ledger.marks.map((m) => m.id);

describe('marks across new bytes', () => {
  it('an operation clears the unsaved marks on its pages and counts them; another file keeps its own', () => {
    const world = { state: opened(), ledger: ledgerOf(mark('m1', A0), mark('m2', A2), mark('m3', B0)) };
    const next = dispatch(world, operation(world.state, 'a.pdf', [7]));
    expect(ids(next.ledger)).toEqual(['m3']);
    expect(next.ledger.cleared).toBe(2);
  });

  it('a disk undo or redo clears and counts the same way', () => {
    const world = { state: opened(), ledger: ledgerOf(mark('m1', A1)) };
    const buffer = [8];
    const next = dispatch(world, {
      type: 'REFRESH_BUFFER', path: 'a.pdf', pageCount: 3, buffer, documents: read(world.state, 'a.pdf', buffer, 'g8'),
    });
    expect(next.state.files.get('a.pdf')!.buffer).toBe(buffer);
    expect(ids(next.ledger)).toEqual([]);
    expect(next.ledger.cleared).toBe(1);
  });

  it('a reopen counts the marks of the bytes it replaces', () => {
    const world = { state: opened(), ledger: ledgerOf(mark('m1', A0), mark('m2', B0)) };
    const next = dispatch(world, {
      type: 'OPEN_FILE', path: 'a.pdf', workingPath: 'a.pdf.w2', name: 'a.pdf', pageCount: 3, buffer: [6],
    });
    expect(ids(next.ledger)).toEqual(['m2']);
    expect(next.ledger.cleared).toBe(1);
  });

  it('keeps the marks a page-tier commit still carries, turned back by the rotation it wrote', () => {
    let world: World = { state: opened(), ledger: ledgerOf(mark('m0', A0), mark('m2', A1)) };
    world = dispatch(world, { type: 'ROTATE_PAGE_REFS', pageIds: [A1], delta: 90 });
    // An in-memory rotation leaves the frame a mark was drawn in alone.
    expect(world.ledger.marks.map((m) => m.rotationAtDraw)).toEqual([0, 0]);
    world = withMark(world, mark('m1', A1, { rotationAtDraw: 90 }));
    world = dispatch(world, { type: 'REORDER_PAGES', docId: 'a#g1#0', order: [A2, A0, A1] });
    const before = world;
    world = dispatch(world, commit(world.state, { 'a.pdf': [9] }));
    expect(ids(world.ledger)).toEqual(['m0', 'm2', 'm1']);
    expect(world.ledger.marks.map((m) => m.rotationAtDraw)).toEqual([0, 270, 0]);
    expect(world.ledger.marks.map((m) => m.path)).toEqual(['a.pdf', 'a.pdf', 'a.pdf']);
    expect(world.ledger.cleared).toBe(0);
    // Each mark shows where it showed before the commit: the page is shown
    // the same way, now with its rotation in the bytes.
    const rotationOf = (w: World, id: string): number =>
      w.state.workspace.documents.flatMap((d) => d.pages).find((p) => p.id === id)!.rotation;
    for (const [i, m] of world.ledger.marks.entries()) {
      const was = before.ledger.marks[i];
      expect(projectMarkRect(m, rotationOf(world, m.pageId))).toEqual(
        projectMarkRect(was, rotationOf(before, was.pageId)),
      );
    }
    // The read-back of the committed bytes changes nothing.
    const settled = dispatch(world, readBack(world.state, 'a.pdf'));
    expect(settled.ledger).toBe(world.ledger);
    // New bytes the commit did not compose take new ids: all three go, counted.
    const operated = dispatch(settled, operation(settled.state, 'a.pdf', [10]));
    expect(ids(operated.ledger)).toEqual([]);
    expect(operated.ledger.cleared).toBe(3);
  });

  it('carries a mark into the file a commit wrote its page into', () => {
    let world: World = { state: opened(), ledger: ledgerOf(mark('m1', A1)) };
    world = dispatch(world, { type: 'MOVE_PAGES', pageIds: [A1], toDocId: 'b#g1#0', toIndex: 0 });
    expect(world.ledger.marks[0].path).toBe('a.pdf');
    world = dispatch(world, commit(world.state, { 'a.pdf': [11], 'b.pdf': [12] }));
    expect(world.ledger.marks.map((m) => [m.id, m.path])).toEqual([['m1', 'b.pdf']]);
    // An operation on the file the page left does not touch the mark.
    world = dispatch(world, readBack(world.state, 'a.pdf'));
    world = dispatch(world, readBack(world.state, 'b.pdf'));
    world = dispatch(world, operation(world.state, 'a.pdf', [13]));
    expect(ids(world.ledger)).toEqual(['m1']);
    world = dispatch(world, operation(world.state, 'b.pdf', [14]));
    expect(ids(world.ledger)).toEqual([]);
    expect(world.ledger.cleared).toBe(1);
  });

  it('keeps a mark on a pending page deletion for the undo, and drops it without a count once a commit writes the deletion', () => {
    let world: World = { state: opened(), ledger: ledgerOf(mark('m1', A2)) };
    world = dispatch(world, { type: 'DELETE_PAGE_REF', docId: 'a#g1#0', pageId: A2 });
    expect(ids(world.ledger)).toEqual(['m1']);
    world = dispatch(world, { type: 'UNDO_PAGE_OP' });
    expect(ids(world.ledger)).toEqual(['m1']);
    world = dispatch(world, { type: 'REDO_PAGE_OP' });
    expect(ids(world.ledger)).toEqual(['m1']);
    world = dispatch(world, commit(world.state, { 'a.pdf': [15] }));
    expect(ids(world.ledger)).toEqual([]);
    expect(world.ledger.cleared).toBe(0);
  });

  it('drops a mark only a redo could bring back, without a count, once an edit ends the redo', () => {
    const imported: PageRef = { id: 'imp#1', sourceDocId: 'b.pdf', sourcePageIndex: 0, rotation: 0, width: 1, height: 1 };
    let world: World = { state: opened(), ledger: EMPTY_MARK_LEDGER };
    world = dispatch(world, {
      type: 'IMPORT_PAGES', toDocId: 'a#g1#0', toIndex: 0, pages: [imported],
      sources: [{ path: 'b.pdf', buffer: world.state.files.get('b.pdf')!.buffer! }],
    });
    world = withMark(world, mark('m1', 'imp#1', { path: 'a.pdf' }));
    world = dispatch(world, { type: 'UNDO_PAGE_OP' });
    expect(ids(world.ledger)).toEqual(['m1']);
    world = dispatch(world, { type: 'ROTATE_PAGE_REFS', pageIds: [A0], delta: 90 });
    expect(ids(world.ledger)).toEqual([]);
    expect(world.ledger.cleared).toBe(0);
  });

  it('drops a seeded mark without a count: the seed reads what the new bytes store', () => {
    const world = { state: opened(), ledger: ledgerOf(mark('s1', A0, { seeded: true }), mark('m1', A1)) };
    const next = dispatch(world, operation(world.state, 'a.pdf', [16]));
    expect(ids(next.ledger)).toEqual([]);
    expect(next.ledger.cleared).toBe(1);
  });

  it('drops the marks of a closed file without a count, and those of pages that came from it', () => {
    let world: World = { state: opened(), ledger: ledgerOf(mark('m1', A0), mark('m2', A1), mark('m3', B0)) };
    world = dispatch(world, { type: 'MOVE_PAGES', pageIds: [A1], toDocId: 'b#g1#0', toIndex: 0 });
    // Drawn on the moved page where it now shows: in b.pdf, over a.pdf's bytes.
    world = withMark(world, mark('m4', A1, { path: 'b.pdf' }));
    world = dispatch(world, { type: 'CLOSE_FILE', path: 'a.pdf' });
    expect(ids(world.ledger)).toEqual(['m3']);
    expect(world.ledger.cleared).toBe(0);
  });

  it('drops without a count a mark whose page left with the document that held it', () => {
    let world: World = { state: opened(), ledger: ledgerOf(mark('m1', A1), mark('m2', A0)) };
    world = dispatch(world, { type: 'MOVE_PAGES', pageIds: [A1], toDocId: 'b#g1#0', toIndex: 0 });
    world = dispatch(world, { type: 'CLOSE_FILE', path: 'b.pdf' });
    expect(ids(world.ledger)).toEqual(['m2']);
    expect(world.ledger.cleared).toBe(0);
  });

  it('leaves the ledger as it is when no documents, files or page history change', () => {
    const world = { state: opened(), ledger: ledgerOf(mark('m1', A0)) };
    expect(dispatch(world, { type: 'UI_SET_CURRENT_PAGE', pageId: A0 }).ledger).toBe(world.ledger);
    const empty = { state: opened(), ledger: EMPTY_MARK_LEDGER };
    expect(dispatch(empty, operation(empty.state, 'a.pdf', [17])).ledger).toBe(EMPTY_MARK_LEDGER);
  });

  it('reads no document when there is no mark, or when a dispatch moved nothing a mark depends on', () => {
    const unread = (state: AppState): AppState => ({
      ...state,
      workspace: {
        get documents(): OpenDocument[] {
          throw new Error('documents read');
        },
      },
    });
    const state = opened();
    const after = unread(appReducer(state, operation(state, 'a.pdf', [18])));
    expect(marksAcross(EMPTY_MARK_LEDGER, unread(state), after)).toBe(EMPTY_MARK_LEDGER);
    const ledger = ledgerOf(mark('m1', A0));
    const still = unread(state);
    const scrolled: AppState = { ...still, ui: { ...still.ui, currentPageId: A0 } };
    expect(marksAcross(ledger, still, scrolled)).toBe(ledger);
  });
});

describe('apply and save runs', () => {
  const start = (): World => ({ state: opened(), ledger: ledgerOf(mark('m1', A0), mark('m2', A1)) });

  it('the bytes a run writes take its marks without a count', () => {
    let world = start();
    world = { ...world, ledger: marksInRun(world.ledger, ['m1'], 'run') };
    expect(world.ledger.marks.map((m) => m.consumedBy)).toEqual(['run', undefined]);
    world = dispatch(world, operation(world.state, 'a.pdf', [18]));
    // m2 was not in the run: its loss is counted now.
    expect(world.ledger.cleared).toBe(1);
    expect(world.ledger.awaiting).toEqual({ run: 1 });
    const settled = marksAfterRun(world.ledger, 'run', true);
    expect(settled.cleared).toBe(1);
    expect(settled.awaiting).toEqual({});
  });

  it('a run that wrote takes the marks still here', () => {
    const settled = marksAfterRun(marksInRun(start().ledger, ['m1'], 'run'), 'run', true);
    expect(ids(settled)).toEqual(['m2']);
    expect(settled.cleared).toBe(0);
  });

  it('a run that wrote nothing leaves its marks pending', () => {
    const settled = marksAfterRun(marksInRun(start().ledger, ['m1', 'm2'], 'run'), 'run', false);
    expect(ids(settled)).toEqual(['m1', 'm2']);
    expect(settled.marks.every((m) => !('consumedBy' in m))).toBe(true);
    expect(settled.cleared).toBe(0);
  });

  it('a run that wrote nothing counts the marks other bytes took while it ran', () => {
    let world = start();
    world = { ...world, ledger: marksInRun(world.ledger, ['m1', 'm2'], 'run') };
    world = dispatch(world, operation(world.state, 'a.pdf', [19]));
    expect(world.ledger.cleared).toBe(0);
    const settled = marksAfterRun(world.ledger, 'run', false);
    expect(settled.cleared).toBe(2);
    expect(settled.awaiting).toEqual({});
  });

  it('a run leaves another run’s marks alone', () => {
    const both = marksInRun(marksInRun(start().ledger, ['m1'], 'one'), ['m2'], 'two');
    const settled = marksAfterRun(both, 'one', true);
    expect(settled.marks.map((m) => [m.id, m.consumedBy])).toEqual([['m2', 'two']]);
  });

  it('a run of marks no longer here leaves the ledger as it is', () => {
    const ledger = start().ledger;
    expect(marksInRun(ledger, ['gone'], 'run')).toBe(ledger);
  });
});

describe('withSeededMarks', () => {
  it('an empty seed takes the path’s earlier seeded marks away and keeps every drawn one', () => {
    const next = withSeededMarks([mark('drawn', A0), mark('stored', A1, { seeded: true }), mark('other', B0, { seeded: true })], 'a.pdf', []);
    expect(next.map((m) => m.id)).toEqual(['drawn', 'other']);
  });

  it('returns the marks as they are when nothing is to be replaced', () => {
    const marks = [mark('drawn', A0), mark('other', B0, { seeded: true })];
    expect(withSeededMarks(marks, 'a.pdf', [])).toBe(marks);
  });
});

describe('wroteBytes', () => {
  it('holds only for an outcome that published bytes', () => {
    expect(wroteBytes({ output: 'x' })).toBe(true);
    expect(wroteBytes(null)).toBe(false);
    expect(wroteBytes(EDIT_DECLINED)).toBe(false);
  });
});

// Real bytes: the commit builder writes the pending rotation into the page,
// and the carried mark still names the same user-space rectangle.
describe('a mark carried over a real commit', () => {
  async function geometryOf(bytes: Uint8Array, pageNumber: number) {
    const doc = (await pdfjs.getDocument({ data: bytes.slice() }).promise) as PDFDocumentProxy;
    try {
      const page = await doc.getPage(pageNumber);
      const [x0, y0, x1, y1] = page.view;
      return { box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, bakedRotate: page.rotate };
    } finally {
      await doc.loadingTask.destroy();
    }
  }

  it('redacts the same content of the committed bytes', async () => {
    const source = await PDFDocument.create();
    source.addPage([300, 400]);
    source.addPage([500, 400]).setRotation(degrees(90));
    const bytes = await source.save();
    const a = file('a.pdf', bytes, 2);
    const docs: OpenDocument[] = [{ ...a, id: 'a#g1#0', pages: pages('a.pdf', 'g1', 2), pageCount: 2 }];
    let world: World = {
      state: { ...initialState, files: new Map([['a.pdf', a]]), workspace: { documents: docs } },
      ledger: EMPTY_MARK_LEDGER,
    };
    world = withMark(world, mark('m1', A1, { rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 } }));
    world = dispatch(world, { type: 'ROTATE_PAGE_REF', docId: 'a#g1#0', pageId: A1, rotation: 90 });
    const regionsBefore = await buildRedactionRegions(world.state.workspace.documents, world.ledger.marks, async (page) =>
      geometryOf(bytes, page.sourcePageIndex + 1));

    const [plan] = planCommit(world.state.workspace, world.state.files, world.state.pageDirtyPaths);
    const committed = await buildCommitBytes(plan);
    world = dispatch(world, commit(world.state, { 'a.pdf': committed }));
    expect(ids(world.ledger)).toEqual(['m1']);
    expect((await geometryOf(committed, 2)).bakedRotate).toBe(180);
    const regionsAfter = await buildRedactionRegions(world.state.workspace.documents, world.ledger.marks, async (page) =>
      geometryOf(committed, page.sourcePageIndex + 1));

    expect(regionsAfter.files.map((f) => f.regions.map((r) => r.page))).toEqual([[2]]);
    const [before] = regionsBefore.files[0].regions;
    const [after] = regionsAfter.files[0].regions;
    expect(after.page).toBe(before.page);
    after.rect.forEach((v, i) => expect(v).toBeCloseTo(before.rect[i], 6));
  });
});

// The canvas and the App have no DOM test environment: their mark sites are
// pinned to the rules above as source text.
const source = (path: string): string =>
  readFileSync(resolve(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');

describe('the canvas', () => {
  const view = source('src/renderer/components/canvas/WorkspaceCanvasView.tsx');

  it('carries its marks across every dispatch, one at a time', () => {
    expect(view).toContain('return subscribeState(() => {');
    expect(view).toContain('setMarkLedger((ledger) => marksAcross(ledger, was, after));');
  });

  it('no longer clears a file’s marks when its bytes change', () => {
    expect(view).not.toContain('setMarks((prevMarks) => prevMarks.filter((m) => !invalidated.has(m.path)));');
  });

  it('owes a notice for every mark it counts', () => {
    expect(view).toContain('data-testid="redact-marks-cleared"');
    expect(view).toContain("tChromeCount('canvas.redact.marksCleared', markLedger.cleared - marksClearedSeen)");
    expect(view).toContain('{(redactError || markLedger.cleared > marksClearedSeen) && (');
  });

  it('lets apply and save take their marks', () => {
    expect(view.match(/setMarkLedger\(\(ledger\) => marksInRun\(ledger, payload\.markIds, run\)\);/g)).toHaveLength(2);
    expect(view.match(/setMarkLedger\(\(ledger\) => marksAfterRun\(ledger, run, wrote\)\);/g)).toHaveLength(2);
    expect(view).toContain('wrote = await onRedactFile(payload.path, payload.marks, state);');
    expect(view).toContain('wrote = await onSaveRedactionMarks(payload.path, payload.marks, state);');
  });

  it('lands an empty listing of stored marks', () => {
    expect(view).not.toContain('if (!listed.marks?.length) return;');
    expect(view).toContain('const stored = listed.marks ?? [];');
  });
});

describe('the App', () => {
  const app = source('src/renderer/App.tsx');

  it('answers whether apply and save wrote new bytes', () => {
    expect(app).toContain('writeRedactionMarks(path, marks, seen, \'redact\', readState, performOperation, redactionGeometry, gsPathIfAvailable)');
    expect(app).toContain("writeRedactionMarks(path, marks, seen, 'save_redaction_marks', readState, performOperation, redactionGeometry, gsPathIfAvailable)");
  });
});
