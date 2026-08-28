import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  planCommit,
  buildCommitBytes,
  commitPageEdits,
  carriesLiveSignature,
} from '../src/renderer/lib/workspace-commit';
import { rotateAnnotationRect } from '../src/renderer/state/reducer';
import { readManifest } from '../src/renderer/lib/pdfx-format';
import { carriesManifest } from '../src/renderer/lib/doc-names';
import { readRawAnnotationStyles } from '../src/renderer/lib/annotation-raw-style';
import { importPageAnnotations } from '../src/renderer/lib/annotation-import';
import { legendText } from '../src/renderer/lib/count-marks';
import type { AppAction, OpenDocument, OpenFile, PageRef, Workspace } from '../src/renderer/state/types';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return (await pdfjs.getDocument({ data: bytes.slice() })
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

// A document carrying one FILLED signature field — the shape
// `carriesLiveSignature` answers to, and the only shape a real transplant is
// ever attempted against.
async function withLiveSignature(bytes: Uint8Array, filled = true): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const ctx = doc.context;
  const field = ctx.obj({
    FT: 'Sig',
    T: PDFString.of('Signature1'),
    ...(filled
      ? { V: ctx.register(ctx.obj({ Type: 'Sig', SubFilter: 'adbe.pkcs7.detached' })) }
      : {}),
  });
  const acro = ctx.obj({ Fields: [ctx.register(field)], SigFlags: 3 });
  doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acro));
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
    // Identity channel: the authored ids are EXACTLY the plan's pages
    // in written order — same source array, so the manifest and the
    // identity record cannot disagree.
    expect(plans[0].authoredPageIds).toHaveLength(3);
    expect(plans[0].authoredDocuments.map((d) => d.id)).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
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

describe('annotations round-trip', () => {
  // Non-circular validation: read the written /Highlight rect back with pdf.js
  // and re-project it through the page's own viewport — the result must land
  // on the display-normalized rect we authored.
  async function roundTrip(rotation: 0 | 90 | 180 | 270) {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const authored = { x: 0.1, y: 0.2, w: 0.3, h: 0.15 };
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [
          { ...pageRef('a.pdf', 0, rotation), annotations: [
            { id: 'ann1', kind: 'highlight' as const, ...authored, color: '#ffd54a', note: 'check this' },
          ] },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const pdf = await loadPdf(await buildCommitBytes(plan));
    const page = await pdf.getPage(1);
    const annots = (await page.getAnnotations()) as {
      subtype: string;
      rect: [number, number, number, number];
      contentsObj?: { str: string };
    }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].subtype).toBe('Highlight');
    expect(annots[0].contentsObj?.str).toBe('check this');
    const viewport = page.getViewport({ scale: 1 }); // includes the committed rotation
    const [rx0, ry0, rx1, ry1] = annots[0].rect;
    const p1 = viewport.convertToViewportPoint(rx0, ry0);
    const p2 = viewport.convertToViewportPoint(rx1, ry1);
    const nx = Math.min(p1[0], p2[0]) / viewport.width;
    const ny = Math.min(p1[1], p2[1]) / viewport.height;
    const nw = Math.abs(p1[0] - p2[0]) / viewport.width;
    const nh = Math.abs(p1[1] - p2[1]) / viewport.height;
    expect(nx).toBeCloseTo(authored.x, 3);
    expect(ny).toBeCloseTo(authored.y, 3);
    expect(nw).toBeCloseTo(authored.w, 3);
    expect(nh).toBeCloseTo(authored.h, 3);
    await pdf.loadingTask.destroy();
  }

  it('lands where authored at rotation 0', () => roundTrip(0));
  it('lands where authored at rotation 90', () => roundTrip(90));
  it('lands where authored at rotation 180', () => roundTrip(180));
  it('lands where authored at rotation 270', () => roundTrip(270));

  it('freetext bakes as /FreeText with appearance, text, and correct placement', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const authored = { x: 0.15, y: 0.1, w: 0.4, h: 0.2 };
    for (const rotation of [0, 90] as const) {
      const rect = rotation === 90 ? rotateAnnotationRect({ id: 't', kind: 'freetext', ...authored, color: '#16161a' }, 90) : { ...authored };
      const workspace: Workspace = {
        documents: [
          makeDoc('a#0', a, 'a', [
            {
              ...pageRef('a.pdf', 0, rotation),
              annotations: [
                { id: 't1', kind: 'freetext', x: rect.x, y: rect.y, w: rect.w, h: rect.h, color: '#16161a', note: 'Reviewed (ok) — see p.2\nsecond line' },
              ],
            },
          ]),
        ],
      };
      const [plan] = planCommit(workspace, files, ['a.pdf']);
      const pdf = await loadPdf(await buildCommitBytes(plan));
      const page = await pdf.getPage(1);
      const annots = (await page.getAnnotations()) as {
        subtype: string;
        hasAppearance: boolean;
        contentsObj?: { str: string };
        rect: [number, number, number, number];
      }[];
      expect(annots).toHaveLength(1);
      expect(annots[0].subtype).toBe('FreeText');
      expect(annots[0].hasAppearance).toBe(true);
      expect(annots[0].contentsObj?.str).toBe('Reviewed (ok) — see p.2\nsecond line');
      const viewport = page.getViewport({ scale: 1 });
      const p1 = viewport.convertToViewportPoint(annots[0].rect[0], annots[0].rect[1]);
      const p2 = viewport.convertToViewportPoint(annots[0].rect[2], annots[0].rect[3]);
      expect(Math.min(p1[0], p2[0]) / viewport.width).toBeCloseTo(rect.x, 3);
      expect(Math.min(p1[1], p2[1]) / viewport.height).toBeCloseTo(rect.y, 3);
      await pdf.loadingTask.destroy();
    }
  });

  it('stamp bakes as /Stamp with a centered label and correct placement', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const authored = { x: 0.3, y: 0.4, w: 0.32, h: 0.09 };
    for (const rotation of [0, 90] as const) {
      const rect = rotation === 90 ? rotateAnnotationRect({ id: 's', kind: 'stamp', ...authored, color: '#2fbf71' }, 90) : { ...authored };
      const workspace: Workspace = {
        documents: [
          makeDoc('a#0', a, 'a', [
            {
              ...pageRef('a.pdf', 0, rotation),
              annotations: [
                { id: 's1', kind: 'stamp', x: rect.x, y: rect.y, w: rect.w, h: rect.h, color: '#2fbf71', note: 'APPROVED' },
              ],
            },
          ]),
        ],
      };
      const [plan] = planCommit(workspace, files, ['a.pdf']);
      const pdf = await loadPdf(await buildCommitBytes(plan));
      const page = await pdf.getPage(1);
      const annots = (await page.getAnnotations()) as {
        subtype: string;
        hasAppearance: boolean;
        contentsObj?: { str: string };
        rect: [number, number, number, number];
      }[];
      expect(annots).toHaveLength(1);
      expect(annots[0].subtype).toBe('Stamp');
      expect(annots[0].hasAppearance).toBe(true);
      expect(annots[0].contentsObj?.str).toBe('APPROVED');
      const viewport = page.getViewport({ scale: 1 });
      const p1 = viewport.convertToViewportPoint(annots[0].rect[0], annots[0].rect[1]);
      const p2 = viewport.convertToViewportPoint(annots[0].rect[2], annots[0].rect[3]);
      expect(Math.min(p1[0], p2[0]) / viewport.width).toBeCloseTo(rect.x, 3);
      expect(Math.min(p1[1], p2[1]) / viewport.height).toBeCloseTo(rect.y, 3);
      await pdf.loadingTask.destroy();
    }
  });

  it('rotate-after-annotate anchors the same page content as annotate-only', async () => {
    // Draw at rotation 0, then rotate the page 90°: the reducer re-projects
    // the rect into the new display space (rotateAnnotationRect), and the
    // builder inverts the new rotation — the baked PDF-space rect must be
    // identical to committing the un-rotated annotation, because it covers
    // the same content.
    const authored = { x: 0.1, y: 0.2, w: 0.3, h: 0.15 };
    const ann = (r: { x: number; y: number; w: number; h: number }) => ({
      id: 'ann1',
      kind: 'highlight' as const,
      ...r,
      color: '#ffd54a',
    });
    async function bakedRect(rotation: 0 | 90, rect: typeof authored) {
      const { files } = await setup();
      const a = files.get('a.pdf')!;
      const workspace: Workspace = {
        documents: [
          makeDoc('a#0', a, 'a', [{ ...pageRef('a.pdf', 0, rotation), annotations: [ann(rect)] }]),
        ],
      };
      const [plan] = planCommit(workspace, files, ['a.pdf']);
      const pdf = await loadPdf(await buildCommitBytes(plan));
      const page = await pdf.getPage(1);
      const [annot] = (await page.getAnnotations()) as { rect: number[] }[];
      await pdf.loadingTask.destroy();
      return annot.rect;
    }
    const before = await bakedRect(0, authored);
    const after = await bakedRect(90, rotateAnnotationRect(ann(authored), 90));
    for (let i = 0; i < 4; i++) expect(after[i]).toBeCloseTo(before[i], 3);
  });

  // A simple two-point stroke; bbox is the points' own extent (zero height —
  // a straight horizontal stroke, the degenerate case the box kinds'
  // skip-empty-rect guard must NOT apply to). Authored fresh at each
  // rotation (not re-projected between them) — same pattern as the highlight
  // `roundTrip` test above: it isolates displayPointToPdf's per-quadrant
  // correctness, since mapping to PDF space and back via the committed
  // page's own viewport must be the identity.
  const inkPoints = [0.2, 0.3, 0.5, 0.3];
  async function inkRoundTrip(rotation: 0 | 90 | 180 | 270) {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [
          {
            ...pageRef('a.pdf', 0, rotation),
            annotations: [
              { id: 'k1', kind: 'ink' as const, x: 0.2, y: 0.3, w: 0.3, h: 0, color: '#2f6fed', strokes: [inkPoints] },
            ],
          },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const pdf = await loadPdf(await buildCommitBytes(plan));
    const page = await pdf.getPage(1);
    const annots = (await page.getAnnotations()) as {
      subtype: string;
      hasAppearance: boolean;
      inkLists?: Float32Array[];
    }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].subtype).toBe('Ink');
    expect(annots[0].hasAppearance).toBe(true);
    const viewport = page.getViewport({ scale: 1 }); // includes the committed rotation
    // pdf.js flattens each stroke to a typed array of [x0,y0,x1,y1,...].
    const stroke = annots[0].inkLists![0];
    for (let i = 0; i < inkPoints.length; i += 2) {
      const p = viewport.convertToViewportPoint(stroke[i], stroke[i + 1]);
      expect(p[0] / viewport.width).toBeCloseTo(inkPoints[i], 3);
      expect(p[1] / viewport.height).toBeCloseTo(inkPoints[i + 1], 3);
    }
    await pdf.loadingTask.destroy();
  }

  it('ink bakes as /Ink with a stroked appearance, at rotation 0', () => inkRoundTrip(0));
  it('ink lands where authored at rotation 90', () => inkRoundTrip(90));
  it('ink lands where authored at rotation 180', () => inkRoundTrip(180));
  it('ink lands where authored at rotation 270', () => inkRoundTrip(270));

  it('multi-stroke ink bakes ONE /Ink with one InkList entry per stroke', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const strokes = [
      [0.2, 0.3, 0.5, 0.3],
      [0.25, 0.5, 0.45, 0.55, 0.5, 0.5],
      [0.6, 0.3, 0.6, 0.55],
    ];
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [
          {
            ...pageRef('a.pdf', 0, 0),
            annotations: [
              { id: 'sig', kind: 'ink' as const, x: 0.2, y: 0.3, w: 0.4, h: 0.25, color: '#2f6fed', strokes },
            ],
          },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const pdf = await loadPdf(await buildCommitBytes(plan));
    const page = await pdf.getPage(1);
    const annots = (await page.getAnnotations()) as {
      subtype: string;
      inkLists?: Float32Array[];
    }[];
    expect(annots).toHaveLength(1);
    expect(annots[0].subtype).toBe('Ink');
    expect(annots[0].inkLists).toHaveLength(3);
    // Every stroke lands where authored — per-stroke, not just the first.
    const viewport = page.getViewport({ scale: 1 });
    strokes.forEach((expected, si) => {
      const got = annots[0].inkLists![si];
      expect(got.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i += 2) {
        const p = viewport.convertToViewportPoint(got[i], got[i + 1]);
        expect(p[0] / viewport.width).toBeCloseTo(expected[i], 3);
        expect(p[1] / viewport.height).toBeCloseTo(expected[i + 1], 3);
      }
    });
    await pdf.loadingTask.destroy();
  });
});

describe('commitPageEdits (transactional)', () => {
  interface FakeFs {
    writes: string[];
    renames: [string, string][];
    removed: string[];
    snapshots: string[];
    dispatched: AppAction[];
    /** What each path actually holds — the disk side of the buffer/disk
     * identity these tests pin. */
    contents: Map<string, Uint8Array>;
  }

  function emptyFs(): FakeFs {
    return {
      writes: [],
      renames: [],
      removed: [],
      snapshots: [],
      dispatched: [],
      contents: new Map(),
    };
  }

  function makeDeps(fs: FakeFs, opts: { failWriteAt?: number } = {}) {
    let writeCount = 0;
    return {
      dispatch: (action: AppAction) => fs.dispatched.push(action),
      snapshot: async (workingPath: string) => {
        fs.snapshots.push(workingPath);
        return `${workingPath}.snap`;
      },
      writeBuffer: async (filePath: string, bytes: Uint8Array) => {
        writeCount++;
        if (opts.failWriteAt === writeCount) throw new Error('disk full');
        fs.writes.push(filePath);
        fs.contents.set(filePath, bytes);
      },
      rename: async (fromPath: string, toPath: string) => {
        fs.renames.push([fromPath, toPath]);
        const bytes = fs.contents.get(fromPath);
        if (bytes) fs.contents.set(toPath, bytes);
        fs.contents.delete(fromPath);
      },
      remove: async (filePath: string) => {
        fs.removed.push(filePath);
        fs.contents.delete(filePath);
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

  // Same shape, with a live signature on a.pdf only: whether a lost signature
  // is worth reporting is a property of the file, not of the failure.
  async function signedState() {
    const { files, workspace, dirtyPaths } = await crossFileState();
    const a = files.get('a.pdf')!;
    const signed = await withLiveSignature(a.buffer as Uint8Array);
    files.set('a.pdf', { ...a, buffer: signed });
    return {
      files,
      workspace: {
        documents: workspace.documents.map((d) =>
          d.path === 'a.pdf' ? { ...d, buffer: signed } : d,
        ),
      },
      dirtyPaths,
    };
  }

  const TMP = /\.commit-tmp-\d+$/;

  it('stages all temps, then snapshots+renames, then dispatches one atomic update', async () => {
    const { files, workspace, dirtyPaths } = await crossFileState();
    const fs = emptyFs();
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
    const fs = emptyFs();
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
    const retryFs = emptyFs();
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
    const first = emptyFs();
    const second = emptyFs();
    await commitPageEdits({ workspace, files, dirtyPaths, ...makeDeps(first) });
    await commitPageEdits({ workspace, files, dirtyPaths, ...makeDeps(second) });
    expect(first.writes[0]).not.toBe(second.writes[0]);
  });

  it('rejects concurrent entry loudly instead of corrupting the staged files', async () => {
    const { files, workspace, dirtyPaths } = await crossFileState();
    const fs = emptyFs();
    const deps = makeDeps(fs);
    const slowDeps = {
      ...deps,
      writeBuffer: async (filePath: string, bytes: Uint8Array) => {
        await new Promise((r) => setTimeout(r, 20));
        return deps.writeBuffer(filePath, bytes);
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
    const fs = emptyFs();
    await commitPageEdits({
      workspace: { documents: [] },
      files,
      dirtyPaths: ['a.pdf'],
      ...makeDeps(fs),
    });
    expect(fs.writes).toEqual([]);
    expect(fs.dispatched).toEqual([{ type: 'CLEAR_PAGE_EDITS' }]);
  });

  // The signature-preserving transplant dep. The dep rewrites the
  // staged temp engine-side; the state buffer must then carry the
  // TRANSPLANTED bytes (buffer identity keys the reindex), and any failure
  // must degrade to the plain rewrite, never block the commit.
  describe('signature-preserving transplant dep', () => {
    it('replaces the dispatched buffer with the read-back bytes when applied', async () => {
      const { files, workspace, dirtyPaths } = await crossFileState();
      const fs = emptyFs();
      const transplanted = new Uint8Array([9, 9, 9, 9]);
      const calls: [string, string][] = [];
      await commitPageEdits({
        workspace, files, dirtyPaths, ...makeDeps(fs),
        preserveSignatures: async (workingPath, stagedPath) => {
          calls.push([workingPath, stagedPath]);
          // only a.pdf is "signed"; the other reports the unsigned reason,
          // which is not a signature anyone lost.
          return workingPath === 'a.pdf.working'
            ? { applied: true }
            : { applied: false, reason: 'not-signed' };
        },
        readBack: async () => transplanted,
      });
      expect(calls).toHaveLength(2);
      expect(calls[0][0]).toBe('a.pdf.working');
      expect(calls[0][1]).toMatch(TMP);
      const action = fs.dispatched[0];
      expect(action.type).toBe('COMMIT_PAGE_EDITS');
      if (action.type === 'COMMIT_PAGE_EDITS') {
        expect(action.updates[0].buffer).toBe(transplanted);
        expect(action.updates[1].buffer).not.toBe(transplanted);
      }
    });

    it('keeps the rebuilt bytes when the transplant does not apply', async () => {
      const { files, workspace, dirtyPaths } = await crossFileState();
      const fs = emptyFs();
      let readBackCalled = false;
      await commitPageEdits({
        workspace, files, dirtyPaths, ...makeDeps(fs),
        preserveSignatures: async () => ({ applied: false, reason: 'not-signed' }),
        readBack: async () => {
          readBackCalled = true;
          return new Uint8Array();
        },
      });
      expect(readBackCalled).toBe(false);
      expect(fs.dispatched[0].type).toBe('COMMIT_PAGE_EDITS');
    });

    it('a throwing transplant degrades to the plain rewrite instead of failing the commit', async () => {
      const { files, workspace, dirtyPaths } = await crossFileState();
      const fs = emptyFs();
      await commitPageEdits({
        workspace, files, dirtyPaths, ...makeDeps(fs),
        preserveSignatures: async () => {
          throw new Error('engine unavailable');
        },
        readBack: async () => new Uint8Array(),
      });
      // Commit landed normally: staged, renamed, one atomic dispatch.
      expect(fs.renames).toHaveLength(2);
      expect(fs.dispatched).toHaveLength(1);
      expect(fs.dispatched[0].type).toBe('COMMIT_PAGE_EDITS');
    });

    // Every path through the preserve attempt ends with the staged temp and
    // the buffer about to be dispatched holding the SAME bytes — checked at
    // the end, on what the rename phase actually published.
    function expectBufferMatchesDisk(fs: FakeFs) {
      const action = fs.dispatched[0];
      expect(action.type).toBe('COMMIT_PAGE_EDITS');
      if (action.type !== 'COMMIT_PAGE_EDITS') return;
      for (const update of action.updates) {
        const landed = fs.contents.get(`${update.path}.working`);
        expect(landed, `nothing landed at ${update.path}.working`).toBeDefined();
        expect(
          Array.from(update.buffer as Uint8Array),
          `state buffer for ${update.path} differs from the bytes on disk`,
        ).toEqual(Array.from(landed!));
      }
    }

    const TRANSPLANTED = new Uint8Array([9, 9, 9, 9]);

    it('an engine exception on a SIGNED file is reported, not swallowed', async () => {
      const { files, workspace, dirtyPaths } = await signedState();
      const fs = emptyFs();
      const outcome = await commitPageEdits({
        workspace, files, dirtyPaths, ...makeDeps(fs),
        // a.pdf carries a live signature; b.pdf does not.
        preserveSignatures: async () => {
          throw new Error('engine unavailable');
        },
        readBack: async () => TRANSPLANTED,
      });
      expect(outcome.signatureRefusals).toEqual([
        {
          path: 'a.pdf',
          reason: { key: 'app.preserve.unrecognized', detail: 'engine unavailable' },
        },
      ]);
      // …and the rewrite still landed, which is what the notice reports on.
      expect(fs.dispatched).toHaveLength(1);
      expectBufferMatchesDisk(fs);
    });

    it('an engine exception on an unsigned file reports no lost signature', async () => {
      const { files, workspace, dirtyPaths } = await crossFileState();
      const fs = emptyFs();
      const outcome = await commitPageEdits({
        workspace, files, dirtyPaths, ...makeDeps(fs),
        preserveSignatures: async () => {
          throw new Error('engine unavailable');
        },
        readBack: async () => TRANSPLANTED,
      });
      expect(outcome.signatureRefusals).toEqual([]);
      expectBufferMatchesDisk(fs);
    });

    // The desync: the engine replaced the staged temp before it failed to
    // answer, so the transplanted file is what the rename publishes — a
    // commit that dispatched the rewrite bytes would leave the state buffer
    // describing a file that no longer exists.
    it('a transplant that landed but could not be answered for does not desync the buffer', async () => {
      const { files, workspace, dirtyPaths } = await signedState();
      const fs = emptyFs();
      const deps = makeDeps(fs);
      const outcome = await commitPageEdits({
        workspace, files, dirtyPaths, ...deps,
        preserveSignatures: async (_workingPath, stagedPath) => {
          // the engine's own stage-and-swap: the temp already holds the
          // appended revision when the answer is lost in transit.
          await deps.writeBuffer(stagedPath, TRANSPLANTED);
          throw new Error('engine exited');
        },
        readBack: async (filePath: string) => fs.contents.get(filePath)!,
      });
      expectBufferMatchesDisk(fs);
      expect(outcome.signatureRefusals).toEqual([
        {
          path: 'a.pdf',
          reason: { key: 'app.preserve.unrecognized', detail: 'engine exited' },
        },
      ]);
    });

    // The read-back failure: the transplant APPLIED, so the temp holds the
    // appended revision — dispatching the rebuild's bytes instead would pin
    // the state buffer to bytes no file has.
    it('a read-back failure after an applied transplant does not desync the buffer', async () => {
      const { files, workspace, dirtyPaths } = await signedState();
      const fs = emptyFs();
      const deps = makeDeps(fs);
      const outcome = await commitPageEdits({
        workspace, files, dirtyPaths, ...deps,
        preserveSignatures: async (workingPath, stagedPath) => {
          if (workingPath !== 'a.pdf.working') return { applied: false, reason: 'not-signed' };
          await deps.writeBuffer(stagedPath, TRANSPLANTED);
          return { applied: true };
        },
        readBack: async () => {
          throw new Error('read failed');
        },
      });
      expect(fs.dispatched).toHaveLength(1);
      expectBufferMatchesDisk(fs);
      expect(outcome.signatureRefusals).toEqual([
        { path: 'a.pdf', reason: { key: 'app.preserve.unrecognized', detail: 'read failed' } },
      ]);
    });

    it('an applied transplant leaves the buffer equal to the bytes that landed', async () => {
      const { files, workspace, dirtyPaths } = await signedState();
      const fs = emptyFs();
      const deps = makeDeps(fs);
      await commitPageEdits({
        workspace, files, dirtyPaths, ...deps,
        preserveSignatures: async (workingPath, stagedPath) => {
          if (workingPath !== 'a.pdf.working') return { applied: false, reason: 'not-signed' };
          await deps.writeBuffer(stagedPath, TRANSPLANTED);
          return { applied: true };
        },
        readBack: async (filePath: string) => fs.contents.get(filePath)!,
      });
      const action = fs.dispatched[0];
      if (action.type === 'COMMIT_PAGE_EDITS') {
        expect(Array.from(action.updates[0].buffer as Uint8Array)).toEqual(
          Array.from(TRANSPLANTED),
        );
      }
      expectBufferMatchesDisk(fs);
    });

    it('a refusal writes nothing, so the rebuilt bytes are the bytes on disk', async () => {
      const { files, workspace, dirtyPaths } = await signedState();
      const fs = emptyFs();
      await commitPageEdits({
        workspace, files, dirtyPaths, ...makeDeps(fs),
        preserveSignatures: async () => ({ applied: false, reason: 'catalog-changed' }),
        readBack: async () => TRANSPLANTED,
      });
      expectBufferMatchesDisk(fs);
    });

    // The identity channel is a property of the PLAN, not of how the bytes
    // landed: the append path rewrites the staged temp in place, so the
    // old→new mapping dispatched with COMMIT_PAGE_EDITS is the same one the
    // rewrite publishes whether the transplant applied, refused, or threw.
    // A mapping published on only one of those paths would leave a
    // page-tree edit that landed incrementally with stale positional ids.
    it.each([
      ['applied', async () => ({ applied: true as const })],
      ['refused', async () => ({ applied: false as const, reason: 'catalog-changed' })],
      ['threw', async () => { throw new Error('engine unavailable'); }],
    ])('publishes the authored mapping when the transplant %s', async (_label, preserveSignatures) => {
      const { files, workspace, dirtyPaths } = await signedState();
      const plans = planCommit(workspace, files, dirtyPaths);
      const fs = emptyFs();
      await commitPageEdits({
        workspace, files, dirtyPaths, ...makeDeps(fs),
        preserveSignatures: preserveSignatures as never,
        readBack: async () => TRANSPLANTED,
      });
      const action = fs.dispatched[0];
      expect(action.type).toBe('COMMIT_PAGE_EDITS');
      if (action.type !== 'COMMIT_PAGE_EDITS') return;
      expect(action.updates.map((u) => u.authored.pages)).toEqual(
        plans.map((p) => p.authoredPageIds),
      );
      expect(action.updates.map((u) => u.authored.documents)).toEqual(
        plans.map((p) => p.authoredDocuments),
      );
      // And the ids are the real ones, not two empty arrays agreeing.
      expect(action.updates[0].authored.pages.length).toBeGreaterThan(0);
    });

    // The reason, not the boolean. A signed file whose append refused is
    // rewritten — it always was — and the difference between that and an
    // unsigned file is the only thing that tells the user a signature is gone.
    describe('the refusal reason', () => {
      it('reports a refused signed file and names it by its own path', async () => {
        const { files, workspace, dirtyPaths } = await crossFileState();
        const fs = emptyFs();
        const outcome = await commitPageEdits({
          workspace, files, dirtyPaths, ...makeDeps(fs),
          preserveSignatures: async (workingPath) =>
            workingPath === 'a.pdf.working'
              ? {
                  applied: false,
                  reason: 'certified-annotate-forbids-page-structure',
                  certification_level: 'annotate',
                }
              : { applied: false, reason: 'not-signed' },
          readBack: async () => new Uint8Array(),
        });
        expect(outcome.signatureRefusals).toEqual([
          { path: 'a.pdf', reason: { key: 'app.preserve.certifiedAnnotate' } },
        ]);
        // And the commit still landed: the rewrite is the standing fallback.
        expect(fs.dispatched).toHaveLength(1);
      });

      it('reports nothing when every transplant applied', async () => {
        const { files, workspace, dirtyPaths } = await crossFileState();
        const fs = emptyFs();
        const outcome = await commitPageEdits({
          workspace, files, dirtyPaths, ...makeDeps(fs),
          preserveSignatures: async () => ({ applied: true }),
          readBack: async () => new Uint8Array([7]),
        });
        expect(outcome.signatureRefusals).toEqual([]);
      });

      it('reports nothing when no transplant dep is supplied at all', async () => {
        const { files, workspace, dirtyPaths } = await crossFileState();
        const fs = emptyFs();
        const outcome = await commitPageEdits({ workspace, files, dirtyPaths, ...makeDeps(fs) });
        expect(outcome.signatureRefusals).toEqual([]);
      });

      it('collects one entry per refusing file, in commit order', async () => {
        const { files, workspace, dirtyPaths } = await crossFileState();
        const fs = emptyFs();
        const outcome = await commitPageEdits({
          workspace, files, dirtyPaths, ...makeDeps(fs),
          preserveSignatures: async (workingPath) => ({
            applied: false,
            reason: workingPath === 'a.pdf.working' ? 'encrypted' : 'catalog-changed',
          }),
          readBack: async () => new Uint8Array(),
        });
        expect(outcome.signatureRefusals).toEqual([
          { path: 'a.pdf', reason: { key: 'app.preserve.encrypted' } },
          { path: 'b.pdf', reason: { key: 'app.preserve.catalogChanged' } },
        ]);
      });

      it('a plan with nothing to commit still answers with an empty report', async () => {
        const { files } = await setup();
        const fs = emptyFs();
        const outcome = await commitPageEdits({
          workspace: { documents: [] },
          files,
          dirtyPaths: ['a.pdf'],
          ...makeDeps(fs),
        });
        expect(outcome.signatureRefusals).toEqual([]);
      });
    });
  });
});

describe('carriesLiveSignature', () => {
  it('is false for a document with no form at all', async () => {
    expect(await carriesLiveSignature(await makeSourcePdf(1, 100))).toBe(false);
  });

  it('is false for an EMPTY signature field — a field is not a signature', async () => {
    const bytes = await withLiveSignature(await makeSourcePdf(1, 100), false);
    expect(await carriesLiveSignature(bytes)).toBe(false);
  });

  it('is true for a filled signature field', async () => {
    const bytes = await withLiveSignature(await makeSourcePdf(1, 100));
    expect(await carriesLiveSignature(bytes)).toBe(true);
  });

  it('is true when the filled field hangs off a parent that owns the /FT', async () => {
    const doc = await PDFDocument.load(await makeSourcePdf(1, 100));
    const ctx = doc.context;
    const kid = ctx.obj({
      T: PDFString.of('inner'),
      V: ctx.register(ctx.obj({ Type: 'Sig' })),
    });
    const parent = ctx.obj({ FT: 'Sig', T: PDFString.of('outer'), Kids: [ctx.register(kid)] });
    doc.catalog.set(
      PDFName.of('AcroForm'),
      ctx.register(ctx.obj({ Fields: [ctx.register(parent)] })),
    );
    expect(await carriesLiveSignature(await doc.save())).toBe(true);
  });

  it('reports an unreadable document as signed rather than staying quiet', async () => {
    expect(await carriesLiveSignature(new Uint8Array([1, 2, 3]))).toBe(true);
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

// Count marks and the placed legend must survive the ROUND TRIP
// through the file, because that is the whole design decision: the tallies are
// derived from what the document carries, never from app state, so a drawing
// counted on another machine has to open with its groups intact.
describe('count marks + takeoff legend round-trip', () => {
  it('bakes a count mark as /Stamp + /IT /Count + /Subj + /SpectraSymbol, and re-imports it', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [
          {
            ...pageRef('a.pdf', 0),
            annotations: [
              {
                id: 'c1',
                kind: 'count',
                x: 0.4,
                y: 0.3,
                w: 0.04,
                h: 0.04,
                color: '#e0393e',
                countGroup: 'Doors',
                countSymbol: 'square',
                countSeq: 7,
                note: 'Doors 7',
              },
            ],
          },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const bytes = await buildCommitBytes(plan);

    // The written dictionary — the interchange contract, read raw.
    const out = await PDFDocument.load(bytes);
    const styles = await readRawAnnotationStyles(bytes);
    expect(styles).not.toBeNull();
    const raw = styles![0][0];
    expect(raw.it).toBe('Count');
    expect(raw.subj).toBe('Doors');
    expect(raw.spectraSymbol).toBe('square');
    expect(out.getPageCount()).toBe(1);

    // …and the re-import, which is what makes the group reconstitute.
    const pdf = await loadPdf(bytes);
    const page = await pdf.getPage(1);
    const imported = await importPageAnnotations(page, styles![0]);
    expect(imported).toHaveLength(1);
    expect(imported[0].kind).toBe('count');
    expect(imported[0].countGroup).toBe('Doors');
    expect(imported[0].countSymbol).toBe('square');
    // The SEQUENCE is read off /Contents: renumbering on import would rewrite
    // labels the user reads off the sheet.
    expect(imported[0].countSeq).toBe(7);
    await pdf.loadingTask.destroy();
  });

  it('a plain /Stamp is NOT imported as a count mark', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [
          {
            ...pageRef('a.pdf', 0),
            annotations: [
              { id: 's1', kind: 'stamp', x: 0.1, y: 0.1, w: 0.3, h: 0.08, color: '#2fbf71', note: 'APPROVED' },
            ],
          },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const bytes = await buildCommitBytes(plan);
    const styles = await readRawAnnotationStyles(bytes);
    const pdf = await loadPdf(bytes);
    const page = await pdf.getPage(1);
    const imported = await importPageAnnotations(page, styles![0]);
    expect(imported).toHaveLength(1);
    expect(imported[0].kind).toBe('stamp');
    await pdf.loadingTask.destroy();
  });

  it('bakes the legend as /FreeText + /IT /CountLegend carrying its SNAPSHOT rows', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const rows = [
      { symbol: 'circle', group: 'Doors', color: '#e0393e', count: 12 },
      { symbol: 'square', group: 'Windows', color: '#2f6fed', count: 7 },
    ];
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [
          {
            ...pageRef('a.pdf', 0),
            annotations: [
              {
                id: 'l1',
                kind: 'countlegend',
                x: 0.5,
                y: 0.05,
                w: 0.4,
                h: 0.25,
                color: '#e0393e',
                note: legendText(rows, 'Takeoff', 'Total'),
                legendRows: rows,
                legendTitle: 'Takeoff',
                legendTotalWord: 'Total',
              },
            ],
          },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const bytes = await buildCommitBytes(plan);
    const styles = await readRawAnnotationStyles(bytes);
    expect(styles![0][0].it).toBe('CountLegend');
    const pdf = await loadPdf(bytes);
    const page = await pdf.getPage(1);
    const imported = await importPageAnnotations(page, styles![0]);
    expect(imported).toHaveLength(1);
    expect(imported[0].kind).toBe('countlegend');
    // A snapshot: the numbers come back exactly as placed, not re-derived.
    expect(imported[0].legendRows).toEqual(rows);
    expect(imported[0].note).toContain('Total\t19');
    await pdf.loadingTask.destroy();
  });
});

// A placed vector SYMBOL. The decision under test is that the
// GEOMETRY travels with the annotation: a symbol from an imported set has to
// draw on a machine that never imported that set, and re-importing it as a
// plain text stamp would turn the drawing into its own label.
describe('symbol stamp round-trip', () => {
  const parts = [
    { kind: 'poly' as const, points: [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9], closed: true },
    { kind: 'circle' as const, cx: 0.5, cy: 0.5, r: 0.2 },
  ];

  it('bakes a /Stamp carrying /SpectraSymbol + /SpectraSymbolParts, and re-imports the artwork', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [
          {
            ...pageRef('a.pdf', 0),
            annotations: [
              {
                id: 'y1',
                kind: 'stamp',
                x: 0.2,
                y: 0.2,
                w: 0.06,
                h: 0.06,
                color: '#2f6fed',
                note: 'Receptacle',
                symbolId: 'fs-outlet',
                symbolParts: parts,
              },
            ],
          },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const bytes = await buildCommitBytes(plan);
    const styles = await readRawAnnotationStyles(bytes);
    expect(styles).not.toBeNull();
    const raw = styles![0][0];
    expect(raw.subtype).toBe('Stamp');
    // No /IT: a symbol is not a count mark, and the count importer must not
    // claim it.
    expect(raw.it).toBeUndefined();
    expect(raw.spectraSymbol).toBe('fs-outlet');
    expect(raw.spectraSymbolParts).toBe(JSON.stringify(parts));

    const pdf = await loadPdf(bytes);
    const page = await pdf.getPage(1);
    const imported = await importPageAnnotations(page, styles![0]);
    expect(imported).toHaveLength(1);
    expect(imported[0].kind).toBe('stamp');
    expect(imported[0].symbolId).toBe('fs-outlet');
    expect(imported[0].symbolParts).toEqual(parts);
    expect(imported[0].note).toBe('Receptacle');
    await pdf.loadingTask.destroy();
  });

  it('a count mark whose marker came from an IMPORTED set carries its geometry too', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [
          {
            ...pageRef('a.pdf', 0),
            annotations: [
              {
                id: 'c9',
                kind: 'count',
                x: 0.4,
                y: 0.3,
                w: 0.04,
                h: 0.04,
                color: '#e0393e',
                countGroup: 'Outlets',
                countSymbol: 'fs-outlet',
                countSeq: 2,
                note: 'Outlets 2',
                symbolParts: parts,
              },
            ],
          },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const bytes = await buildCommitBytes(plan);
    const styles = await readRawAnnotationStyles(bytes);
    const raw = styles![0][0];
    expect(raw.it).toBe('Count');
    // The id is written as the FILE spells it, unknown to this build or not.
    expect(raw.spectraSymbol).toBe('fs-outlet');
    expect(raw.spectraSymbolParts).toBe(JSON.stringify(parts));

    const pdf = await loadPdf(bytes);
    const page = await pdf.getPage(1);
    const imported = await importPageAnnotations(page, styles![0]);
    expect(imported[0].kind).toBe('count');
    expect(imported[0].countSymbol).toBe('fs-outlet');
    expect(imported[0].symbolParts).toEqual(parts);
    await pdf.loadingTask.destroy();
  });

  it('a BUILT-IN marker writes no geometry — the id already names it', async () => {
    const { files } = await setup();
    const a = files.get('a.pdf')!;
    const workspace: Workspace = {
      documents: [
        makeDoc('a#0', a, 'a', [
          {
            ...pageRef('a.pdf', 0),
            annotations: [
              {
                id: 'c8',
                kind: 'count',
                x: 0.4,
                y: 0.3,
                w: 0.04,
                h: 0.04,
                color: '#e0393e',
                countGroup: 'Doors',
                countSymbol: 'square',
                countSeq: 1,
                note: 'Doors 1',
              },
            ],
          },
        ]),
      ],
    };
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    const bytes = await buildCommitBytes(plan);
    const styles = await readRawAnnotationStyles(bytes);
    expect(styles![0][0].spectraSymbolParts).toBeUndefined();
  });
});
