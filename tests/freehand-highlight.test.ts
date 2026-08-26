// F36 — the freehand highlighter and tool locking.
//
// Two halves, tested where each one actually lives:
//
//   * the highlighter is a STYLE of /Ink, so the tests are about the emitted
//     annotation (a /Multiply ExtGState in the appearance's own resources, the
//     alpha on both /CA and the state, the private key that says which pen drew
//     it) and about the round trip back through the importer;
//   * locking is a rule at ONE reducer seam, so the tests are about that seam —
//     including that it cannot outrank `openTool`, which is the invariant a
//     locked mode must never break.
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString } from 'pdf-lib';

import { buildPdf } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';
import { readRawAnnotationStyles } from '../src/renderer/lib/annotation-raw-style';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import { rotateAnnotationRect } from '../src/renderer/state/reducer';
import type {
  AppState,
  OpenDocument,
  OpenFile,
  PageAnnotation,
  PageRef,
} from '../src/renderer/state/types';

// ── Emit helpers ─────────────────────────────────────────────────────────

async function sourceBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  return doc.save();
}

function annotBySubtype(doc: PDFDocument, subtype: string): PDFDict | null {
  const annots = doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) return null;
  for (let i = 0; i < annots.size(); i++) {
    const a = annots.lookupMaybe(i, PDFDict);
    if (a && String(a.lookup(PDFName.of('Subtype'))) === `/${subtype}`) return a;
  }
  return null;
}

const num = (v: unknown): number => (v instanceof PDFNumber ? v.asNumber() : NaN);
const text = (v: unknown): string =>
  v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : String(v);

/** The appearance stream's decoded content, and the ExtGState it names. */
function appearance(annot: PDFDict): { content: string; gs: PDFDict | null } {
  const ap = annot.lookupMaybe(PDFName.of('AP'), PDFDict)!;
  const n = ap.lookup(PDFName.of('N'));
  const stream = n as PDFRawStream;
  const content = new TextDecoder().decode(stream.getContents());
  const res = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
  const states = res?.lookupMaybe(PDFName.of('ExtGState'), PDFDict);
  return { content, gs: states?.lookupMaybe(PDFName.of('GS0'), PDFDict) ?? null };
}

function marker(over: Partial<PageAnnotation> = {}): PageAnnotation {
  return {
    id: 'h1',
    kind: 'ink',
    inkStyle: 'highlighter',
    x: 0.1,
    y: 0.4,
    w: 0.6,
    h: 0.05,
    color: '#ffd54a',
    strokeWidth: 14,
    opacity: 0.4,
    strokes: [[0.1, 0.42, 0.4, 0.42, 0.7, 0.45]],
    ...over,
  } as PageAnnotation;
}

async function emit(annotations: PageAnnotation[]): Promise<PDFDocument> {
  const page: ExportPage = {
    bytes: await sourceBytes(),
    sourceKey: 'src',
    pageIndex: 0,
    annotations: annotations as ExportPage['annotations'],
  };
  return PDFDocument.load(await buildPdf([page], undefined, 'src'));
}

describe('freehand highlighter emits', () => {
  it('is a real /Ink annotation carrying its stroke as /InkList', async () => {
    const out = await emit([marker()]);
    const ink = annotBySubtype(out, 'Ink');
    expect(ink).not.toBeNull();
    const list = ink!.lookupMaybe(PDFName.of('InkList'), PDFArray)!;
    expect(list.size()).toBe(1);
    // One path, three points, six numbers — the drawn stroke, not a box.
    expect(list.lookupMaybe(0, PDFArray)!.size()).toBe(6);
    expect(num(ink!.lookupMaybe(PDFName.of('BS'), PDFDict)!.lookup(PDFName.of('W')))).toBe(14);
  });

  it('draws through a /Multiply ExtGState at the mark alpha', async () => {
    const out = await emit([marker()]);
    const { content, gs } = appearance(annotBySubtype(out, 'Ink')!);
    expect(gs).not.toBeNull();
    expect(String(gs!.lookup(PDFName.of('BM')))).toBe('/Multiply');
    // BOTH alphas: a stroked path is painted with the STROKING alpha, and a
    // reader that consults `ca` alone must not see an opaque bar.
    expect(num(gs!.lookup(PDFName.of('CA')))).toBeCloseTo(0.4);
    expect(num(gs!.lookup(PDFName.of('ca')))).toBeCloseTo(0.4);
    // The state has to be SELECTED before anything is painted, or it applies
    // to nothing.
    expect(content.indexOf('/GS0 gs')).toBe(0);
    // Round caps and joins — a 14pt nib with butt caps is a different mark.
    expect(content).toContain('1 J 1 j');
    // /CA on the annotation too: a viewer that ignores appearance streams
    // still composites the mark translucently.
    expect(num(annotBySubtype(out, 'Ink')!.lookup(PDFName.of('CA')))).toBeCloseTo(0.4);
  });

  it('says which pen drew it, for the round trip', async () => {
    const out = await emit([marker()]);
    expect(text(annotBySubtype(out, 'Ink')!.lookup(PDFName.of('SpectraInkStyle')))).toBe(
      'highlighter',
    );
  });

  it('gives the appearance a BBox that encloses the whole nib', async () => {
    // A Form XObject CLIPS to its BBox. A 14pt nib reaches 7pt past its
    // centreline in every direction (round caps and joins included), so a pad
    // that does not scale with the stroke width shaves the mark down inside
    // the file while the canvas — which draws with overflow visible — keeps
    // showing all of it. Screen and paper have to agree.
    const nib = 14;
    // A FLAT stroke: point bounds have zero height, so the pad IS the extent.
    const out = await emit([
      marker({ y: 0.42, h: 0, strokes: [[0.1, 0.42, 0.7, 0.42]] }),
    ]);
    const ink = annotBySubtype(out, 'Ink')!;
    const stream = ink.lookupMaybe(PDFName.of('AP'), PDFDict)!.lookup(PDFName.of('N')) as PDFRawStream;
    const bbox = stream.dict.lookupMaybe(PDFName.of('BBox'), PDFArray)!;
    const [bx0, by0, bx1, by1] = [0, 1, 2, 3].map((i) => num(bbox.lookup(i)));
    // Where the path actually is inside the appearance's own coordinates.
    const content = new TextDecoder().decode(stream.getContents());
    const pts = [...content.matchAll(/(-?[\d.]+) (-?[\d.]+) [ml]/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(pts.length).toBeGreaterThan(1);
    const half = nib / 2;
    for (const [px, py] of pts) {
      expect(px - half).toBeGreaterThanOrEqual(bx0);
      expect(px + half).toBeLessThanOrEqual(bx1);
      expect(py - half).toBeGreaterThanOrEqual(by0);
      expect(py + half).toBeLessThanOrEqual(by1);
    }
    // …and the /Rect the BBox is placed into is the same size, so the viewer
    // does not scale the appearance to fit a smaller box.
    const rect = ink.lookupMaybe(PDFName.of('Rect'), PDFArray)!;
    const [rx0, ry0, rx1, ry1] = [0, 1, 2, 3].map((i) => num(rect.lookup(i)));
    expect(rx1 - rx0).toBeCloseTo(bx1 - bx0);
    expect(ry1 - ry0).toBeCloseTo(by1 - by0);
    expect(ry1 - ry0).toBeGreaterThanOrEqual(nib);
  });

  it('keeps the 2pt pen nib byte-stable', async () => {
    // The pad formula has to reproduce the pinned 2 at the default nib, or
    // every existing pen stroke re-commits to different bytes.
    const out = await emit([marker({ inkStyle: undefined, opacity: undefined, strokeWidth: undefined, h: 0, strokes: [[0.1, 0.42, 0.7, 0.42]] })]);
    const ink = annotBySubtype(out, 'Ink')!;
    const rect = ink.lookupMaybe(PDFName.of('Rect'), PDFArray)!;
    expect(num(rect.lookup(3)) - num(rect.lookup(1))).toBeCloseTo(4); // 2pt pad each side
  });

  it('leaves an ordinary pen stroke opaque and stateless', async () => {
    // The pen's output must not acquire a blend state because the highlighter
    // exists — this is the byte-stability half of the same branch.
    const out = await emit([marker({ inkStyle: undefined, opacity: undefined, strokeWidth: undefined })]);
    const ink = annotBySubtype(out, 'Ink')!;
    const { content, gs } = appearance(ink);
    expect(gs).toBeNull();
    expect(content.startsWith('/GS0 gs')).toBe(false);
    expect(ink.lookup(PDFName.of('CA'))).toBeUndefined();
    expect(ink.lookup(PDFName.of('SpectraInkStyle'))).toBeUndefined();
  });
});

describe('freehand highlighter round trip', () => {
  it('re-imports as a highlighter, keeping its nib and alpha', async () => {
    const bytes = await buildPdf(
      [
        {
          bytes: await sourceBytes(),
          sourceKey: 'src',
          pageIndex: 0,
          annotations: [marker()] as ExportPage['annotations'],
        },
      ],
      undefined,
      'src',
    );
    const styles = await readRawAnnotationStyles(bytes as unknown as Parameters<typeof readRawAnnotationStyles>[0]);
    expect(styles).not.toBeNull();
    const sidecar = styles![0].find((s) => s.subtype === 'Ink');
    expect(sidecar?.spectraInkStyle).toBe('highlighter');
    expect(sidecar?.strokeWidth).toBe(14);
    expect(sidecar?.opacity).toBeCloseTo(0.4);
  });
});

describe('highlighter geometry re-projects with the page', () => {
  it('a quarter turn re-projects the strokes, not just the box', () => {
    const a = marker();
    const turned = rotateAnnotationRect(a, 90);
    // The box travels into the rotated frame; its extents swap.
    expect(turned.w).toBeCloseTo(a.h);
    expect(turned.h).toBeCloseTo(a.w);
    // The stroke travels with it, POINT BY POINT — a highlighter that kept its
    // strokes while its box turned would mark the wrong part of the page.
    expect(turned.strokes![0]).toHaveLength(a.strokes![0].length);
    expect(turned.strokes![0][0]).toBeCloseTo(1 - a.strokes![0][1]);
    expect(turned.strokes![0][1]).toBeCloseTo(a.strokes![0][0]);
    // …and the pen it was drawn with is not a geometric property.
    expect(turned.inkStyle).toBe('highlighter');
    expect(turned.strokeWidth).toBe(a.strokeWidth);
    expect(turned.opacity).toBe(a.opacity);

    const back = rotateAnnotationRect(turned, 270);
    expect(back.x).toBeCloseTo(a.x);
    expect(back.y).toBeCloseTo(a.y);
    expect(back.w).toBeCloseTo(a.w);
    expect(back.h).toBeCloseTo(a.h);
    for (let i = 0; i < a.strokes![0].length; i++) {
      expect(back.strokes![0][i]).toBeCloseTo(a.strokes![0][i]);
    }
  });
});

// ── Tool locking ─────────────────────────────────────────────────────────

function makeFile(path: string): OpenFile {
  return {
    path,
    workingPath: `${path}.working`,
    name: 'doc.pdf',
    pageCount: 1,
    buffer: [1, 2, 3],
    dirty: false,
    undoStack: [],
    redoStack: [],
  };
}

function lockState(toolLock: boolean, tool: AppState['ui']['tool']): AppState {
  const file = makeFile('/doc.pdf');
  const pages: PageRef[] = [
    {
      id: '/doc.pdf#g1#p0',
      sourceDocId: '/doc.pdf',
      sourcePageIndex: 0,
      rotation: 0,
      width: 300,
      height: 300,
    },
  ];
  const doc: OpenDocument = { ...file, id: 'd1', pages, pageCount: 1 };
  return {
    ...initialState,
    files: new Map([[file.path, file]]),
    activeFileId: file.path,
    workspace: { ...initialState.workspace, documents: [doc] },
    ui: { ...initialState.ui, toolLock, tool, activeToolId: 'comment' },
  };
}

const place = (id: string): PageAnnotation =>
  ({ ...marker(), id }) as PageAnnotation;

describe('tool locking', () => {
  it('is locked by default, so an armed mode survives its own placement', () => {
    expect(initialState.ui.toolLock).toBe(true);
    const next = appReducer(lockState(true, 'inkhighlight'), {
      type: 'ADD_ANNOTATION',
      docId: 'd1',
      pageId: '/doc.pdf#g1#p0',
      annotation: place('a1'),
    });
    expect(next.ui.tool).toBe('inkhighlight');
    // …and again, and again: N placements, one arming gesture.
    const third = appReducer(
      appReducer(next, {
        type: 'ADD_ANNOTATION',
        docId: 'd1',
        pageId: '/doc.pdf#g1#p0',
        annotation: place('a2'),
      }),
      { type: 'ADD_ANNOTATION', docId: 'd1', pageId: '/doc.pdf#g1#p0', annotation: place('a3') },
    );
    expect(third.ui.tool).toBe('inkhighlight');
    expect(third.workspace.documents[0].pages[0].annotations).toHaveLength(3);
  });

  it('unlocked, a placement disarms to Select and leaves the tool open', () => {
    const next = appReducer(lockState(false, 'inkhighlight'), {
      type: 'ADD_ANNOTATION',
      docId: 'd1',
      pageId: '/doc.pdf#g1#p0',
      annotation: place('a1'),
    });
    expect(next.ui.tool).toBe('select');
    // The TOOL is not closed — only its mode was spent.
    expect(next.ui.activeToolId).toBe('comment');
    expect(next.workspace.documents[0].pages[0].annotations).toHaveLength(1);
  });

  it('applies at the seam, not per tool', () => {
    // The measure modes are in this list because the lock control renders for
    // the Measure tool too, and a finished measurement lands through the same
    // ADD_ANNOTATION — unlocking it there used to be a silent no-op.
    for (const tool of [
      'highlight', 'ink', 'inkhighlight', 'stamp', 'shape', 'note',
      'measuredist', 'measureperim', 'measurearea',
    ] as const) {
      const next = appReducer(lockState(false, tool), {
        type: 'ADD_ANNOTATION',
        docId: 'd1',
        pageId: '/doc.pdf#g1#p0',
        annotation: place('a1'),
      });
      expect(next.ui.tool, `${tool} should disarm when unlocked`).toBe('select');
    }
  });

  it('does not disarm a mode that placed nothing', () => {
    // A refused placement (no such document) must not spend the mode.
    const next = appReducer(lockState(false, 'inkhighlight'), {
      type: 'ADD_ANNOTATION',
      docId: 'nope',
      pageId: '/doc.pdf#g1#p0',
      annotation: place('a1'),
    });
    expect(next.ui.tool).toBe('inkhighlight');
  });

  it('cannot outrank openTool: closing the tool disarms a LOCKED mode', () => {
    // The invariant the lock must compose with. `openTool` recomputes the mode
    // from the tool being opened, so a locked mode can never ride to the next
    // document.
    const armed = appReducer(lockState(true, 'inkhighlight'), {
      type: 'ADD_ANNOTATION',
      docId: 'd1',
      pageId: '/doc.pdf#g1#p0',
      annotation: place('a1'),
    });
    expect(armed.ui.tool).toBe('inkhighlight');
    const closed = appReducer(armed, { type: 'UI_OPEN_TOOL', toolId: null });
    expect(closed.ui.tool).toBe('select');
    expect(closed.ui.toolLock).toBe(true); // the preference survives; the arming does not
  });

  it('toggles, and the toggle is the only thing it changes', () => {
    const off = appReducer(lockState(true, 'inkhighlight'), {
      type: 'UI_SET_TOOL_LOCK',
      locked: false,
    });
    expect(off.ui.toolLock).toBe(false);
    expect(off.ui.tool).toBe('inkhighlight');
    // Setting it to what it already is returns the SAME state object.
    expect(appReducer(off, { type: 'UI_SET_TOOL_LOCK', locked: false })).toBe(off);
  });
});
