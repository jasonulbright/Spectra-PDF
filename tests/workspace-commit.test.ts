import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no type declarations for the deep legacy import
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { planCommit, buildCommitBytes, commitPageEdits } from '../src/renderer/lib/workspace-commit';
import { readManifest } from '../src/renderer/lib/pdfx-format';
import { carriesManifest } from '../src/renderer/lib/doc-names';
import type { AppAction, OpenDocument, OpenFile, PageRef, Workspace } from '../src/renderer/state/types';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return (await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false })
    .promise) as PDFDocumentProxy;
}

// Source pages get distinct widths (100 + pageIndex) so output page order is
// verifiable straight from the page geometry.
async function makeSourcePdf(pageCount: number, widthBase: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([widthBase + i, 400]);
  }
  return doc.save();
}

function makeFile(path: string, name: string, buffer: Uint8Array, pageCount: number): OpenFile {
  return {
    path,
    workingPath: `${path}.working`,
    name,
    pageCount,
    buffer,
    dirty: false,
    undoStack: [],
    redoStack: [],
  };
}

function pageRef(path: string, index: number, rotation: 0 | 90 | 180 | 270 = 0): PageRef {
  return {
    id: `${path}#p${index}`,
    sourceDocId: path,
    sourcePageIndex: index,
    rotation,
    width: 0,
    height: 0,
  };
}

function makeDoc(id: string, file: OpenFile, name: string, pages: PageRef[]): OpenDocument {
  return { ...file, id, name, pages, pageCount: pages.length };
}

async function setup() {
  const aBytes = await makeSourcePdf(3, 100); // widths 100, 101, 102
  const bBytes = await makeSourcePdf(2, 200); // widths 200, 201
  const files = new Map<string, OpenFile>([
    ['a.pdf', makeFile('a.pdf', 'a.pdf', aBytes, 3)],
    ['b.pdf', makeFile('b.pdf', 'b.pdf', bBytes, 2)],
  ]);
  return { files };
}

async function pageWidths(pdf: PDFDocumentProxy): Promise<number[]> {
  // MediaBox width (page.view), not viewport width — viewports fold /Rotate
  // in, and the rotation test would otherwise read swapped dimensions.
  const widths: number[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    widths.push(page.view[2] - page.view[0]);
  }
  return widths;
}

describe('planCommit', () => {
  it('plans only dirty paths, in workspace document order', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [pageRef('a.pdf', 2), pageRef('a.pdf', 0), pageRef('a.pdf', 1)]),
        makeDoc('b#0', files.get('b.pdf')!, 'b', [pageRef('b.pdf', 0), pageRef('b.pdf', 1)]),
      ],
    };
    const plans = planCommit(workspace, files, ['a.pdf']);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      path: 'a.pdf',
      workingPath: 'a.pdf.working',
      title: 'a',
      useManifest: false,
      pageCount: 3,
    });
    expect(plans[0].documents[0].pages.map((p) => p.pageIndex)).toEqual([2, 0, 1]);
  });

  it('uses a manifest for multi-partition files and .pdfx names', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const twoParts: Workspace = {
      documents: [
        makeDoc('a#0', a, 'Front', [pageRef('a.pdf', 0)]),
        makeDoc('a#1', a, 'Back', [pageRef('a.pdf', 1), pageRef('a.pdf', 2)]),
      ],
    };
    expect(planCommit(twoParts, files, ['a.pdf'])[0].useManifest).toBe(true);

    const pdfxFiles = new Map(files);
    const bundle = { ...a, path: 'c.pdfx', name: 'c.pdfx' };
    pdfxFiles.set('c.pdfx', bundle);
    const single: Workspace = {
      documents: [makeDoc('c#0', bundle, 'c', [pageRef('c.pdfx', 0)])],
    };
    expect(planCommit(single, pdfxFiles, ['c.pdfx'])[0].useManifest).toBe(true);
  });

  it('throws when a page references a closed file', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = {
      documents: [makeDoc('a#0', a, 'a', [pageRef('a.pdf', 0), pageRef('gone.pdf', 0)])],
    };
    expect(() => planCommit(workspace, files, ['a.pdf'])).toThrow(/no longer open/);
  });

  it('never plans a zero-page composition', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = { documents: [makeDoc('a#0', a, 'a', [])] };
    expect(planCommit(workspace, files, ['a.pdf'])).toEqual([]);
  });

  it('plans nothing for an empty dirty set', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = {
      documents: [makeDoc('a#0', a, 'a', [pageRef('a.pdf', 0)])],
    };
    expect(planCommit(workspace, files, [])).toEqual([]);
  });
});

describe('carriesManifest', () => {
  it('is file-anchored', () => {
    expect(carriesManifest('a.pdf', 1)).toBe(false);
    expect(carriesManifest('a.pdf', 2)).toBe(true);
    expect(carriesManifest('c.pdfx', 1)).toBe(true);
    expect(carriesManifest('C.PDFX', 1)).toBe(true);
  });
});

describe('commitPageEdits (transactional)', () => {
  interface FakeFs {
    writes: string[];
    renames: [string, string][];
    removed: string[];
    snapshots: string[];
    dispatched: AppAction[];
  }

  function makeDeps(fs: FakeFs, opts: { failWriteAt?: number } = {}) {
    let writeCount = 0;
    return {
      dispatch: (action: AppAction) => fs.dispatched.push(action),
      snapshot: async (workingPath: string) => {
        fs.snapshots.push(workingPath);
        return `${workingPath}.snap`;
      },
      writeBuffer: async (filePath: string) => {
        writeCount++;
        if (opts.failWriteAt === writeCount) throw new Error('disk full');
        fs.writes.push(filePath);
      },
      rename: async (fromPath: string, toPath: string) => {
        fs.renames.push([fromPath, toPath]);
      },
      remove: async (filePath: string) => {
        fs.removed.push(filePath);
      },
    };
  }

  async function crossFileState() {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const b = files.get('b.pdf')!;
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [pageRef('a.pdf', 1), pageRef('a.pdf', 2)]),
        makeDoc('b#0', b, 'b', [pageRef('b.pdf', 0), pageRef('a.pdf', 0), pageRef('b.pdf', 1)]),
      ],
    };
    return { files, workspace, dirtyPaths: ['a.pdf', 'b.pdf'] };
  }

  const TMP = /\.commit-tmp-\d+$/;

  it('stages all temps, then snapshots+renames, then dispatches one atomic update', async () => {
    const { files, workspace, dirtyPaths } = await crossFileState();
    const fs: FakeFs = { writes: [], renames: [], removed: [], snapshots: [], dispatched: [] };
    await commitPageEdits({ workspace, files, dirtyPaths, ...makeDeps(fs) });
    expect(fs.writes).toHaveLength(2);
    expect(fs.writes[0]).toMatch(/^a\.pdf\.working\.commit-tmp-\d+$/);
    expect(fs.writes[1]).toMatch(/^b\.pdf\.working\.commit-tmp-\d+$/);
    expect(fs.renames).toEqual([
      [fs.writes[0], 'a.pdf.working'],
      [fs.writes[1], 'b.pdf.working'],
    ]);
    expect(fs.removed).toEqual([]);
    expect(fs.dispatched).toHaveLength(1);
    const action = fs.dispatched[0];
    expect(action.type).toBe('COMMIT_PAGE_EDITS');
    if (action.type === 'COMMIT_PAGE_EDITS') {
      expect(action.updates.map((u) => [u.path, u.pageCount])).toEqual([
        ['a.pdf', 2],
        ['b.pdf', 3],
      ]);
      expect(action.updates.every((u) => u.snapshotPath.endsWith('.snap'))).toBe(true);
    }
  });

  it('a mid-stage failure removes temps, dispatches nothing, and leaves a clean retry', async () => {
    const { files, workspace, dirtyPaths } = await crossFileState();
    const fs: FakeFs = { writes: [], renames: [], removed: [], snapshots: [], dispatched: [] };
    await expect(
      commitPageEdits({ workspace, files, dirtyPaths, ...makeDeps(fs, { failWriteAt: 2 }) }),
    ).rejects.toThrow('disk full');
    // Nothing renamed into place, nothing dispatched — disk and state untouched.
    expect(fs.renames).toEqual([]);
    expect(fs.snapshots).toEqual([]);
    expect(fs.dispatched).toEqual([]);
    expect(fs.removed).toHaveLength(1);
    expect(fs.removed[0]).toMatch(TMP);

    // Retry from the same (unchanged) state: byte-identical plans succeed.
    const retryFs: FakeFs = { writes: [], renames: [], removed: [], snapshots: [], dispatched: [] };
    await commitPageEdits({ workspace, files, dirtyPaths, ...makeDeps(retryFs) });
    expect(retryFs.dispatched).toHaveLength(1);
    const retryAction = retryFs.dispatched[0];
    if (retryAction.type === 'COMMIT_PAGE_EDITS') {
      // The cross-file page still resolves against pre-commit indices: b gets
      // a's ORIGINAL page 0 (width 100), not whatever a's rebuild reordered.
      const bBytes = retryAction.updates[1].buffer as Uint8Array;
      const pdf = await loadPdf(bBytes);
      expect(await pageWidths(pdf)).toEqual([200, 100, 201]);
      await pdf.loadingTask.destroy();
    }
  });

  it('uses distinct temp names across runs so leftovers can never be renamed in', async () => {
    const { files, workspace, dirtyPaths } = await crossFileState();
    const first: FakeFs = { writes: [], renames: [], removed: [], snapshots: [], dispatched: [] };
    const second: FakeFs = { writes: [], renames: [], removed: [], snapshots: [], dispatched: [] };
    await commitPageEdits({ workspace, files, dirtyPaths, ...makeDeps(first) });
    await commitPageEdits({ workspace, files, dirtyPaths, ...makeDeps(second) });
    expect(first.writes[0]).not.toBe(second.writes[0]);
  });

  it('rejects concurrent entry loudly instead of corrupting the staged files', async () => {
    const { files, workspace, dirtyPaths } = await crossFileState();
    const fs: FakeFs = { writes: [], renames: [], removed: [], snapshots: [], dispatched: [] };
    const deps = makeDeps(fs);
    const slowDeps = {
      ...deps,
      writeBuffer: async (filePath: string) => {
        await new Promise((r) => setTimeout(r, 20));
        return deps.writeBuffer(filePath);
      },
    };
    const first = commitPageEdits({ workspace, files, dirtyPaths, ...slowDeps });
    await expect(
      commitPageEdits({ workspace, files, dirtyPaths, ...makeDeps(fs) }),
    ).rejects.toThrow(/already running/);
    await first; // the in-flight run itself completes normally
    expect(fs.dispatched).toHaveLength(1);
  });

  it('clears the tier without touching disk when there is nothing to plan', async () => {
    const { files } = await setup();
    const fs: FakeFs = { writes: [], renames: [], removed: [], snapshots: [], dispatched: [] };
    await commitPageEdits({
      workspace: { documents: [] },
      files,
      dirtyPaths: ['a.pdf'],
      ...makeDeps(fs),
    });
    expect(fs.writes).toEqual([]);
    expect(fs.dispatched).toEqual([{ type: 'CLEAR_PAGE_EDITS' }]);
  });
});

describe('buildCommitBytes round-trip', () => {
  it('materializes a reorder with rotation, plain PDF, no manifest', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [
          pageRef('a.pdf', 2),
          pageRef('a.pdf', 0, 90),
          pageRef('a.pdf', 1),
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const pdf = await loadPdf(await buildCommitBytes(plan));
    expect(pdf.numPages).toBe(3);
    expect(await pageWidths(pdf)).toEqual([102, 100, 101]);
    const rotated = await pdf.getPage(2);
    expect(rotated.rotate % 360).toBe(90);
    expect(await readManifest(pdf)).toBeNull();
    await pdf.loadingTask.destroy();
  });

  it('materializes a cross-file move on both sides consistently', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const b = files.get('b.pdf')!;
    // Move a.pdf page 1 into b's document at index 1.
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [pageRef('a.pdf', 0), pageRef('a.pdf', 2)]),
        makeDoc('b#0', b, 'b', [pageRef('b.pdf', 0), pageRef('a.pdf', 1), pageRef('b.pdf', 1)]),
      ],
    };
    const plans = planCommit(workspace, files, ['a.pdf', 'b.pdf']);
    expect(plans).toHaveLength(2);
    const [aPdf, bPdf] = await Promise.all(
      plans.map(async (p) => loadPdf(await buildCommitBytes(p))),
    );
    expect(await pageWidths(aPdf)).toEqual([100, 102]);
    expect(await pageWidths(bPdf)).toEqual([200, 101, 201]);
    await aPdf.loadingTask.destroy();
    await bPdf.loadingTask.destroy();
  });

  it('writes partition names and counts into the manifest', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'Front', [pageRef('a.pdf', 0)]),
        makeDoc('a#1', a, 'Back', [pageRef('a.pdf', 1), pageRef('a.pdf', 2)]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const pdf = await loadPdf(await buildCommitBytes(plan));
    expect(pdf.numPages).toBe(3);
    expect(await readManifest(pdf)).toEqual({
      pdfx: '1.0',
      title: 'a',
      documents: [
        { name: 'Front', pages: 1 },
        { name: 'Back', pages: 2 },
      ],
    });
    await pdf.loadingTask.destroy();
  });
});
