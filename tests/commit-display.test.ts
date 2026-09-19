// What the canvas draws between a page-tier commit and the reindex of its
// bytes. The canvas renders page `sourcePageIndex` of the file's CURRENT bytes
// at `/Rotate + rotation`, and redaction reads its geometry from the same page.
// From the moment the commit lands, every slot must show the page it showed
// before, turned the same way, and a mark drawn there must land on that page
// at that position. Real bytes, real pdf.js: the check reads the committed file.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import { commitPageEdits } from '../src/renderer/lib/workspace-commit';
import { buildRedactionRegions, type RedactionMark } from '../src/renderer/lib/redaction';
import type { AppAction, AppState, OpenDocument, OpenFile, PageRef } from '../src/renderer/state/types';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const PATH = 'a.pdf';
const WIDTHS = [100, 150, 200];
const HEIGHT = 400;

async function load(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return (await pdfjs.getDocument({ data: bytes.slice() }).promise) as PDFDocumentProxy;
}

/** Three pages told apart by their width. */
async function source(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const width of WIDTHS) doc.addPage([width, HEIGHT]);
  return doc.save();
}

function opened(bytes: Uint8Array): AppState {
  const file: OpenFile = {
    path: PATH, workingPath: `${PATH}.w`, name: PATH, pageCount: WIDTHS.length, buffer: bytes,
    dirty: false, undoStack: [], redoStack: [],
  };
  const pages: PageRef[] = WIDTHS.map((width, i) => ({
    id: `${PATH}#g1#p${i}`, sourceDocId: PATH, sourcePageIndex: i, rotation: 0, width, height: HEIGHT,
  }));
  const doc: OpenDocument = { ...file, id: `${PATH}#g1#0`, pages, pageCount: pages.length };
  return { ...initialState, files: new Map([[PATH, file]]), workspace: { documents: [doc] } };
}

/** The commit bridge against an in-memory disk, landing through the reducer. */
async function commit(state: AppState): Promise<AppState> {
  const disk = new Map<string, Uint8Array>();
  const dispatched: AppAction[] = [];
  const stacks = { pageUndoStack: state.pageUndoStack, pageRedoStack: state.pageRedoStack };
  await commitPageEdits({
    workspace: state.workspace,
    files: state.files,
    dirtyPaths: state.pageDirtyPaths,
    tier: { planned: stacks, current: () => stacks },
    dispatch: (action) => dispatched.push(action),
    transaction: {
      publish: async (_id, entries) => {
        for (const entry of entries) disk.set(entry.workingPath, disk.get(entry.stagedPath)!);
        return { status: 'committed', snapshots: entries.map((e) => `${e.workingPath}.snap`), detail: '' };
      },
      abort: async () => ({ status: 'rolledBack', snapshots: [], detail: '' }),
      acknowledge: async () => {},
    },
    writeBuffer: async (path, bytes) => { disk.set(path, bytes); },
    remove: async (path) => { disk.delete(path); },
  });
  expect(dispatched.map((a) => a.type)).toEqual(['COMMIT_PAGE_EDITS']);
  return appReducer(state, dispatched[0]);
}

interface Shown { width: number; turn: number }

/** What each slot shows: the page drawn and its total turn. */
async function shown(state: AppState): Promise<Shown[]> {
  const pdf = await load(state.files.get(PATH)!.buffer as Uint8Array);
  const out: Shown[] = [];
  for (const page of state.workspace.documents.flatMap((d) => d.pages)) {
    const p = await pdf.getPage(page.sourcePageIndex + 1);
    out.push({ width: p.view[2] - p.view[0], turn: (p.rotate + page.rotation) % 360 });
  }
  await pdf.loadingTask.destroy();
  return out;
}

/** The redaction geometry of the file's CURRENT bytes, as the canvas reads it. */
function geometryOf(state: AppState) {
  const pdf = load(state.files.get(PATH)!.buffer as Uint8Array);
  return {
    get: async (page: PageRef) => {
      const p = await (await pdf).getPage(page.sourcePageIndex + 1);
      const [x0, y0, x1, y1] = p.view;
      return { box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, bakedRotate: p.rotate };
    },
    close: async () => { await (await pdf).loadingTask.destroy(); },
  };
}

/** A mark drawn on `pageId` as the page is shown now. */
function markOn(state: AppState, pageId: string): RedactionMark {
  const page = state.workspace.documents.flatMap((d) => d.pages).find((p) => p.id === pageId)!;
  return {
    id: `mark-${pageId}`, path: PATH, pageId,
    rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 },
    rotationAtDraw: page.rotation,
  };
}

async function regionsOf(state: AppState, mark: RedactionMark) {
  const geometry = geometryOf(state);
  try {
    const { files } = await buildRedactionRegions(state.workspace.documents, [mark], geometry.get);
    return files.flatMap((f) => f.regions.map((r) => ({ page: r.page, rect: r.rect })));
  } finally {
    await geometry.close();
  }
}

/** The plan reorders the pages and turns the one that moves into slot two. */
async function edited(): Promise<AppState> {
  const start = opened(await source());
  return [
    { type: 'REORDER_PAGES', docId: `${PATH}#g1#0`, order: [`${PATH}#g1#p2`, `${PATH}#g1#p0`, `${PATH}#g1#p1`] },
    { type: 'ROTATE_PAGE_REFS', pageIds: [`${PATH}#g1#p0`], delta: 90 },
  ].reduce((s, a) => appReducer(s, a as AppAction), start);
}

describe('between a commit and the reindex of its bytes', () => {
  it('a turned page is turned once', async () => {
    const before = appReducer(opened(await source()), {
      type: 'ROTATE_PAGE_REFS', pageIds: [`${PATH}#g1#p1`], delta: 90,
    });
    const expected = await shown(before);
    expect(expected[1]).toEqual({ width: 150, turn: 90 });
    expect(await shown(await commit(before))).toEqual(expected);
  });

  it('every slot shows the page it showed before, turned the same way', async () => {
    const before = await edited();
    const expected = await shown(before);
    expect(expected).toEqual([
      { width: 200, turn: 0 },
      { width: 100, turn: 90 },
      { width: 150, turn: 0 },
    ]);
    const after = await commit(before);
    expect(await shown(after)).toEqual(expected);
  });

  it('a mark drawn on a moved and turned page lands on that page, at the position drawn', async () => {
    const before = await edited();
    // Drawn on the same visible rectangle of the same page before the commit.
    const expected = await regionsOf(before, markOn(before, `${PATH}#g1#p0`));
    expect(expected).toHaveLength(1);
    expect(expected[0].page).toBe(2);
    const after = await commit(before);
    const got = await regionsOf(after, markOn(after, `${PATH}#g1#p0`));
    expect(got).toHaveLength(1);
    expect(got[0].page).toBe(expected[0].page);
    got[0].rect.forEach((v, i) => expect(v).toBeCloseTo(expected[0].rect[i], 6));
    // The committed file holds that page at that number: the 100-wide page.
    const pdf = await load(after.files.get(PATH)!.buffer as Uint8Array);
    const p = await pdf.getPage(got[0].page);
    expect(p.view[2] - p.view[0]).toBe(100);
    await pdf.loadingTask.destroy();
  });

  it('a mark drawn after a further reorder in that window lands on the page it was drawn on', async () => {
    const after = await commit(await edited());
    const moved = appReducer(after, {
      type: 'REORDER_PAGES', docId: `${PATH}#g1#0`, order: [`${PATH}#g1#p0`, `${PATH}#g1#p2`, `${PATH}#g1#p1`],
    });
    const got = await regionsOf(moved, markOn(moved, `${PATH}#g1#p0`));
    // Slot one after the reorder; the geometry is the 100-wide page turned once.
    expect(got[0].page).toBe(1);
    const geometry = { x: 0, y: 0, width: 100, height: HEIGHT };
    const { displayRectToPdf } = await import('../src/renderer/lib/pdfx-build');
    const expected = displayRectToPdf({ x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, geometry, 90);
    got[0].rect.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 6));
  });
});
