import { beforeEach, describe, expect, it, vi } from 'vitest';

// The search engine statically imports extract.ts (runtime pdfjs-dist, which
// can't load in Node) and ocr-client.ts (Worker) — mock both; the engine
// logic under test is the reconcile/cache/search/invalidate machinery.
const extractMock = vi.fn();
vi.mock('../src/renderer/search/extract', () => ({
  extractPageText: (...args: unknown[]) => extractMock(...args),
}));

const recognizeMock = vi.fn();
const setLanguageMock = vi.fn();
vi.mock('../src/renderer/ocr/ocr-client', () => ({
  createOcrClient: () => ({
    setLanguage: setLanguageMock,
    recognize: (...args: unknown[]) => recognizeMock(...args),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    dispose: vi.fn(),
  }),
}));

import { createSearchEngine, sourceKeyOf } from '../src/renderer/search/engine';
import { normalizeText, countOccurrences, highlightWords } from '../src/renderer/search/normalize';
import { buildOcrApplyPayload } from '../src/renderer/lib/ocr-apply';
import { displayRectToPdf } from '../src/renderer/lib/pdfx-build';
import type { OpenDocument, PageRef } from '../src/renderer/state/types';
import type { PDFDocumentProxy } from 'pdfjs-dist';

function pageRef(path: string, index: number, rotation: 0 | 90 | 180 | 270 = 0): PageRef {
  return {
    id: `${path}#p${index}`,
    sourceDocId: path,
    sourcePageIndex: index,
    rotation,
    width: 612,
    height: 792,
  };
}

function makeDoc(id: string, path: string, pages: PageRef[]): OpenDocument {
  return {
    id,
    path,
    workingPath: `${path}.working`,
    name: id,
    pageCount: pages.length,
    buffer: null,
    dirty: false,
    undoStack: [],
    redoStack: [],
    pages,
  };
}

const FAKE_PDF = {} as PDFDocumentProxy;
const proxiesFor = (...paths: string[]): Map<string, PDFDocumentProxy> =>
  new Map(paths.map((p) => [p, FAKE_PDF]));

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('normalize', () => {
  it('NFKC + soft hyphen + case + whitespace', () => {
    expect(normalizeText('Ｉｎｖｏｉｃｅ')).toBe('invoice'); // fullwidth → NFKC
    expect(normalizeText('in­voice')).toBe('invoice'); // soft hyphen dropped
    expect(normalizeText('  Total\n\tDue ')).toBe('total due');
  });

  it('countOccurrences counts non-overlapping hits', () => {
    expect(countOccurrences('aaa total total b', 'total')).toBe(2);
    expect(countOccurrences('abc', '')).toBe(0);
  });
});

describe('highlightWords (review #2 — multi-word queries)', () => {
  const words = [
    { text: 'Total' },
    { text: 'amount' },
    { text: 'Due' },
    { text: 'today' },
  ];

  it('highlights every query token, not the whole phrase', () => {
    // The single-substring approach highlighted NOTHING for 2+ word queries
    // (no whitespace-free OCR word contains a spaced phrase).
    const hits = highlightWords(words, 'total due').map((w) => w.text);
    expect(hits).toEqual(['Total', 'Due']);
  });

  it('single-word queries still match', () => {
    expect(highlightWords(words, 'amount').map((w) => w.text)).toEqual(['amount']);
  });

  it('empty query highlights nothing', () => {
    expect(highlightWords(words, '   ')).toEqual([]);
  });
});

describe('search engine', () => {
  beforeEach(() => {
    extractMock.mockReset();
    recognizeMock.mockReset();
  });

  function build(docsRef: { current: OpenDocument[] }) {
    const onChange = vi.fn();
    const onProgress = vi.fn();
    const engine = createSearchEngine({
      onChange,
      onProgress,
      getDocs: () => docsRef.current,
    });
    return { engine, onChange, onProgress };
  }

  it('indexes born-digital text and answers queries', async () => {
    const doc = makeDoc('d1', 'C:/a.pdf', [pageRef('C:/a.pdf', 0), pageRef('C:/a.pdf', 1)]);
    const docsRef = { current: [doc] };
    extractMock
      .mockResolvedValueOnce({ text: 'Invoice Total Due', needsOcr: false })
      .mockResolvedValueOnce({ text: 'nothing here', needsOcr: false });
    const { engine } = build(docsRef);
    engine.reconcile(docsRef.current, proxiesFor('C:/a.pdf'));
    await flush();
    const r = engine.search('total');
    expect(r.pages).toBe(1);
    expect(r.pageIds.has('C:/a.pdf#p0')).toBe(true);
    expect(r.occurrences).toBe(1);
  });

  it('queues OCR for scanned pages and merges results into search', async () => {
    const doc = makeDoc('d1', 'C:/scan.pdf', [pageRef('C:/scan.pdf', 0)]);
    const docsRef = { current: [doc] };
    extractMock.mockResolvedValueOnce({ text: '', needsOcr: true });
    let resolveOcr: (v: { text: string; words: { text: string; x: number; y: number; w: number; h: number }[] }) => void;
    recognizeMock.mockImplementation(
      () => new Promise((resolve) => (resolveOcr = resolve)),
    );
    const { engine } = build(docsRef);
    engine.reconcile(docsRef.current, proxiesFor('C:/scan.pdf'));
    await flush();
    expect(recognizeMock).toHaveBeenCalledTimes(1);
    expect(engine.search('invoice').pages).toBe(0);
    resolveOcr!({ text: 'Scanned INVOICE text', words: [{ text: 'INVOICE', x: 0.1, y: 0.1, w: 0.2, h: 0.05 }] });
    await flush();
    expect(engine.search('invoice').pages).toBe(1);
    const key = sourceKeyOf(doc.pages[0]);
    expect(engine.getOcrWords(key)?.[0].text).toBe('INVOICE');
    expect(engine.ocrReadySources()).toEqual([key]);
  });

  it('discards a STALE in-flight OCR result after the file mutates (review #1)', async () => {
    // A recognize() dispatched against the pre-mutation raster must NOT
    // overwrite state once invalidatePath fired — otherwise stale (e.g.
    // pre-redaction) words could be persisted as an invisible layer.
    const doc = makeDoc('d1', 'C:/scan.pdf', [pageRef('C:/scan.pdf', 0)]);
    const docsRef = { current: [doc] };
    extractMock.mockResolvedValue({ text: '', needsOcr: true });
    let resolveStale!: (v: { text: string; words: { text: string; x: number; y: number; w: number; h: number }[] }) => void;
    recognizeMock.mockImplementationOnce(() => new Promise((r) => (resolveStale = r)));
    const { engine } = build(docsRef);
    engine.reconcile(docsRef.current, proxiesFor('C:/scan.pdf'));
    await flush();
    const key = sourceKeyOf(doc.pages[0]);

    // File mutates mid-recognition → invalidate. A fresh pass is set up but
    // NOT resolved; then the STALE pass resolves with old words.
    engine.invalidatePath('C:/scan.pdf');
    recognizeMock.mockImplementationOnce(
      () => new Promise(() => {}), // fresh pass stays pending
    );
    engine.reconcile(docsRef.current, proxiesFor('C:/scan.pdf'));
    await flush();

    resolveStale({ text: 'PRE-REDACTION SECRET', words: [{ text: 'SECRET', x: 0.1, y: 0.1, w: 0.2, h: 0.05 }] });
    await flush();

    // The stale words are discarded — not searchable, not ready to persist.
    expect(engine.search('secret').pages).toBe(0);
    expect(engine.getOcrWords(key)).toBeUndefined();
    expect(engine.ocrReadySources()).toEqual([]);
  });

  it('invalidatePath drops the cache so mutated files re-extract', async () => {
    const doc = makeDoc('d1', 'C:/a.pdf', [pageRef('C:/a.pdf', 0)]);
    const docsRef = { current: [doc] };
    extractMock.mockResolvedValue({ text: 'first version', needsOcr: false });
    const { engine } = build(docsRef);
    engine.reconcile(docsRef.current, proxiesFor('C:/a.pdf'));
    await flush();
    expect(engine.search('first').pages).toBe(1);

    engine.invalidatePath('C:/a.pdf');
    expect(engine.search('first').pages).toBe(0); // stale text dropped
    extractMock.mockResolvedValue({ text: 'second version', needsOcr: false });
    engine.reconcile(docsRef.current, proxiesFor('C:/a.pdf'));
    await flush();
    expect(engine.search('second').pages).toBe(1);
    expect(engine.search('first').pages).toBe(0);
  });

  it('a moved page keeps its cached text (source-keyed cache)', async () => {
    const p0 = pageRef('C:/a.pdf', 0);
    const doc = makeDoc('d1', 'C:/a.pdf', [p0]);
    const docsRef = { current: [doc] };
    extractMock.mockResolvedValueOnce({ text: 'cached words', needsOcr: false });
    const { engine } = build(docsRef);
    engine.reconcile(docsRef.current, proxiesFor('C:/a.pdf'));
    await flush();
    // Move the page into a different doc (new PageRef identity? — no: page
    // ids are positional/persistent; a move keeps the id but changes doc).
    const doc2 = makeDoc('d2', 'C:/a.pdf', [p0]);
    docsRef.current = [doc2];
    engine.reconcile(docsRef.current, proxiesFor('C:/a.pdf'));
    await flush();
    expect(extractMock).toHaveBeenCalledTimes(1); // no re-extraction
    expect(engine.search('cached').pages).toBe(1);
  });
});

describe('buildOcrApplyPayload', () => {
  const GEOMETRY = { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 };

  it('converts normalized word boxes to user-space rects per committed page', async () => {
    const p0 = pageRef('C:/scan.pdf', 0);
    const doc = makeDoc('d1', 'C:/scan.pdf', [p0]);
    const words = [{ text: 'INVOICE', x: 0.1, y: 0.1, w: 0.3, h: 0.05 }];
    const { files, skippedSources } = await buildOcrApplyPayload(
      [doc],
      [sourceKeyOf(p0)],
      () => words,
      async () => GEOMETRY,
    );
    expect(skippedSources).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('C:/scan.pdf');
    expect(files[0].pages[0].page).toBe(1);
    expect(files[0].pages[0].words[0].rect).toEqual(
      displayRectToPdf(words[0], GEOMETRY.box, 0),
    );
  });

  it('skips sources whose page left the workspace', async () => {
    const doc = makeDoc('d1', 'C:/scan.pdf', [pageRef('C:/scan.pdf', 0)]);
    const { files, skippedSources } = await buildOcrApplyPayload(
      [doc],
      ['C:/scan.pdf:7'],
      () => [{ text: 'x', x: 0, y: 0, w: 0.1, h: 0.1 }],
      async () => GEOMETRY,
    );
    expect(files).toEqual([]);
    expect(skippedSources).toEqual(['C:/scan.pdf:7']);
  });

  it('composes the baked rotation into the conversion', async () => {
    const p0 = pageRef('C:/scan.pdf', 0);
    const doc = makeDoc('d1', 'C:/scan.pdf', [p0]);
    const rotated = { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 90 };
    const words = [{ text: 'w', x: 0.2, y: 0.3, w: 0.1, h: 0.05 }];
    const { files } = await buildOcrApplyPayload(
      [doc],
      [sourceKeyOf(p0)],
      () => words,
      async () => rotated,
    );
    expect(files[0].pages[0].words[0].rect).toEqual(
      displayRectToPdf(words[0], rotated.box, 90),
    );
  });
});
