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
import {
  normalizeText,
  normalizeIndexText,
  countOccurrences,
  highlightWords,
  compileMatcher,
  countMatches,
  firstMatch,
} from '../src/renderer/search/normalize';
import { runCorpusSearch } from '../src/renderer/search/search-core';
import { REGEX_TIMEOUT_MS } from '../src/renderer/search/search-worker-client';
import type { SearchWorkerLike, SearchWorkerRequest } from '../src/renderer/search/search-protocol';
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

  it('regex mode highlights words matching the pattern', () => {
    const ws = [{ text: 'Total' }, { text: 'total' }, { text: '2024' }, { text: 'due' }];
    expect(highlightWords(ws, '\\d+', { regex: true }).map((w) => w.text)).toEqual(['2024']);
  });

  it('case-sensitive mode highlights only the exact case', () => {
    const ws = [{ text: 'Total' }, { text: 'total' }];
    expect(highlightWords(ws, 'Total', { caseSensitive: true }).map((w) => w.text)).toEqual(['Total']);
  });
});

describe('search matcher (P4 — regex / case / whole-word)', () => {
  it('normalizeIndexText preserves case (NFKC + soft-hyphen + whitespace only)', () => {
    expect(normalizeIndexText('Ｉｎｖｏｉｃｅ')).toBe('Invoice'); // fullwidth → NFKC, case kept
    expect(normalizeIndexText('  Total\n\tDue ')).toBe('Total Due');
    expect(normalizeIndexText('in­voice')).toBe('invoice'); // soft hyphen dropped
  });

  it('default mode is case-insensitive literal substring', () => {
    const { regex } = compileMatcher('total', {});
    expect(countMatches('Total the total TOTAL', regex!)).toBe(3);
  });

  it('case-sensitive matches only the exact case', () => {
    const { regex } = compileMatcher('Total', { caseSensitive: true });
    expect(countMatches('Total total TOTAL', regex!)).toBe(1);
  });

  it('whole-word does not match a substring inside a longer word', () => {
    const { regex } = compileMatcher('cat', { wholeWord: true });
    expect(countMatches('cat category concatenate cat.', regex!)).toBe(2); // "cat" and "cat."
  });

  it('regex mode compiles the query as a pattern', () => {
    const { regex, error } = compileMatcher('inv\\w+', { regex: true });
    expect(error).toBeNull();
    expect(countMatches('invoice and invalid but not xyz', regex!)).toBe(2);
  });

  it('regex mode honors case-insensitivity by default and case-sensitivity when set', () => {
    expect(countMatches('ABC abc', compileMatcher('abc', { regex: true }).regex!)).toBe(2);
    expect(countMatches('ABC abc', compileMatcher('abc', { regex: true, caseSensitive: true }).regex!)).toBe(1);
  });

  it('literal query escapes regex metacharacters', () => {
    const { regex } = compileMatcher('a.b', {});
    expect(countMatches('a.b axb aXb', regex!)).toBe(1); // the dot is literal, not "any char"
  });

  it('an invalid regex returns an error, not a throw', () => {
    const { regex, error } = compileMatcher('inv(', { regex: true });
    expect(regex).toBeNull();
    expect(error).toBeTruthy();
  });

  it('a zero-width-capable regex neither loops nor inflates the count', () => {
    const { regex } = compileMatcher('a*', { regex: true });
    expect(countMatches('aa b aaa', regex!)).toBe(2); // two non-empty runs of "a"
  });

  it('firstMatch returns the first non-empty hit position', () => {
    const { regex } = compileMatcher('secret', {});
    const hit = firstMatch('the SECRET is here', regex!);
    expect(hit).toEqual({ index: 4, length: 6 });
  });

  it('empty query yields a null matcher (no error)', () => {
    expect(compileMatcher('', {})).toEqual({ regex: null, error: null });
    expect(compileMatcher('   ', {})).toEqual({ regex: null, error: null });
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
    const r = await engine.search('total');
    expect(r.pages).toBe(1);
    expect(r.pageIds.has('C:/a.pdf#p0')).toBe(true);
    expect(r.occurrences).toBe(1);
  });

  it('advanced modes: case-sensitive, whole-word, and regex over the index (P4)', async () => {
    const doc = makeDoc('d1', 'C:/a.pdf', [pageRef('C:/a.pdf', 0), pageRef('C:/a.pdf', 1)]);
    const docsRef = { current: [doc] };
    extractMock
      .mockResolvedValueOnce({ text: 'Cat cats CAT concatenate Invoice-2024', needsOcr: false })
      .mockResolvedValueOnce({ text: 'nothing relevant', needsOcr: false });
    const { engine } = build(docsRef);
    engine.reconcile(docsRef.current, proxiesFor('C:/a.pdf'));
    await flush();

    // Case-sensitive: only the exact-case "Cat" (not "cats"/"CAT"/"concatenate").
    expect((await engine.search('Cat', { caseSensitive: true })).occurrences).toBe(1);
    // Case-insensitive default: Cat, cats, CAT, concatenate → 4 substring hits.
    expect((await engine.search('cat')).occurrences).toBe(4);
    // Whole-word: "Cat", "cats"? no — "cats" isn't the word "cat". Only "Cat"/"CAT".
    expect((await engine.search('cat', { wholeWord: true })).occurrences).toBe(2);
    // Regex: a 4-digit run.
    const rx = await engine.search('\\d{4}', { regex: true });
    expect(rx.occurrences).toBe(1);
    expect(rx.pageIds.has('C:/a.pdf#p0')).toBe(true);
    // Invalid regex surfaces an error instead of throwing.
    const bad = await engine.search('inv(', { regex: true });
    expect(bad.error).toBeTruthy();
    expect(bad.pages).toBe(0);
  });

  it('snippetsFor returns a per-page context window, only for matching pages', async () => {
    const doc = makeDoc('d1', 'C:/a.pdf', [pageRef('C:/a.pdf', 0), pageRef('C:/a.pdf', 1)]);
    const docsRef = { current: [doc] };
    extractMock
      .mockResolvedValueOnce({ text: 'The quarterly invoice total is due', needsOcr: false })
      .mockResolvedValueOnce({ text: 'unrelated content', needsOcr: false });
    const { engine } = build(docsRef);
    engine.reconcile(docsRef.current, proxiesFor('C:/a.pdf'));
    await flush();
    const snips = await engine.snippetsFor('invoice');
    expect(snips.size).toBe(1);
    expect(snips.get('C:/a.pdf#p0')).toContain('invoice'); // case-preserving (P4); fixture is lowercase here
    expect(snips.has('C:/a.pdf#p1')).toBe(false); // no match → absent
    expect((await engine.snippetsFor('   ')).size).toBe(0); // empty query → empty
  });

  it('snippetsFor ellipsizes when the match is deep inside long text', async () => {
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed'; // 58 chars > 40 radius
    const doc = makeDoc('d1', 'C:/b.pdf', [pageRef('C:/b.pdf', 0)]);
    const docsRef = { current: [doc] };
    extractMock.mockResolvedValueOnce({ text: `${filler} SECRET ${filler}`, needsOcr: false });
    const { engine } = build(docsRef);
    engine.reconcile(docsRef.current, proxiesFor('C:/b.pdf'));
    await flush();
    const snip = (await engine.snippetsFor('secret')).get('C:/b.pdf#p0');
    expect(snip).toBeDefined();
    expect(snip!.startsWith('…')).toBe(true);
    expect(snip!.endsWith('…')).toBe(true);
    // Snippets now preserve the ORIGINAL case (P4) — the fixture wrote SECRET,
    // and the case-insensitive query still matched it.
    expect(snip).toContain('SECRET');
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
    expect((await engine.search('invoice')).pages).toBe(0);
    resolveOcr!({ text: 'Scanned INVOICE text', words: [{ text: 'INVOICE', x: 0.1, y: 0.1, w: 0.2, h: 0.05 }] });
    await flush();
    expect((await engine.search('invoice')).pages).toBe(1);
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
    expect((await engine.search('secret')).pages).toBe(0);
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
    expect((await engine.search('first')).pages).toBe(1);

    engine.invalidatePath('C:/a.pdf');
    expect((await engine.search('first')).pages).toBe(0); // stale text dropped
    extractMock.mockResolvedValue({ text: 'second version', needsOcr: false });
    engine.reconcile(docsRef.current, proxiesFor('C:/a.pdf'));
    await flush();
    expect((await engine.search('second')).pages).toBe(1);
    expect((await engine.search('first')).pages).toBe(0);
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
    expect((await engine.search('cached')).pages).toBe(1);
  });
});

describe('regex search runs off the render thread (ReDoS hardening)', () => {
  // A fake worker standing in for search.worker.ts. `answer` decides what (if
  // anything) comes back — a worker that never answers is the pathological
  // backtrack this hardening exists for.
  function fakeWorker(answer: 'sync' | 'never') {
    const sent: SearchWorkerRequest[] = [];
    const corpus = new Map<string, string>();
    let terminated = 0;
    const w: SearchWorkerLike = {
      onmessage: null,
      postMessage(message) {
        sent.push(message);
        if (message.type === 'seed') {
          corpus.clear();
          for (const [id, text] of message.entries) corpus.set(id, text);
          return;
        }
        if (answer === 'never') return;
        // The worker's own body, run inline: same core the render thread uses.
        const { hits, error } = runCorpusSearch(corpus, message.query, message.options);
        w.onmessage?.({ data: { type: 'result', id: message.id, hits, error } });
      },
      terminate() {
        terminated++;
      },
    };
    return {
      worker: w,
      sent,
      seeds: () => sent.filter((m) => m.type === 'seed').length,
      terminations: () => terminated,
    };
  }

  async function indexed(answer: 'sync' | 'never', text = 'Invoice 2024 total aaaaaaaaaa') {
    const doc = makeDoc('d1', 'C:/a.pdf', [pageRef('C:/a.pdf', 0)]);
    const docsRef = { current: [doc] };
    extractMock.mockReset();
    extractMock.mockResolvedValue({ text, needsOcr: false });
    const fake = fakeWorker(answer);
    const engine = createSearchEngine({
      onChange: vi.fn(),
      onProgress: vi.fn(),
      getDocs: () => docsRef.current,
      createSearchWorker: () => fake.worker,
    });
    engine.reconcile(docsRef.current, proxiesFor('C:/a.pdf'));
    await flush();
    return { engine, fake, docsRef };
  }

  it('sends regex queries to the worker and maps the hits back', async () => {
    const { engine, fake } = await indexed('sync');
    const r = await engine.search('\\d{4}', { regex: true });
    expect(r.pages).toBe(1);
    expect(r.occurrences).toBe(1);
    expect(fake.sent.some((m) => m.type === 'search')).toBe(true);
  });

  it('LITERAL queries never reach the worker (the sync path is unchanged)', async () => {
    const { engine, fake } = await indexed('sync');
    expect((await engine.search('invoice')).pages).toBe(1);
    expect((await engine.search('total', { caseSensitive: false, wholeWord: true })).pages).toBe(1);
    expect(fake.sent).toEqual([]);
  });

  it('seeds the corpus once, and again only after the index changes', async () => {
    const { engine, fake, docsRef } = await indexed('sync');
    await engine.search('total', { regex: true });
    await engine.search('invoice', { regex: true });
    expect(fake.seeds()).toBe(1); // corpus unchanged between the two queries

    engine.invalidatePath('C:/a.pdf'); // bytes changed under the index
    extractMock.mockResolvedValue({ text: 'replacement text', needsOcr: false });
    engine.reconcile(docsRef.current, proxiesFor('C:/a.pdf'));
    await flush();
    expect((await engine.search('replacement', { regex: true })).pages).toBe(1);
    expect(fake.seeds()).toBe(2);
  });

  it('kills the worker when a scan blows the time budget, and re-seeds the next one', async () => {
    const { engine, fake } = await indexed('never');
    vi.useFakeTimers();
    try {
      const pending = engine.search('(a+)+$', { regex: true });
      await vi.advanceTimersByTimeAsync(REGEX_TIMEOUT_MS);
      const r = await pending;
      expect(r.errorKind).toBe('timeout');
      expect(r.error).toBeTruthy();
      expect(r.pages).toBe(0);
      expect(fake.terminations()).toBe(1); // terminate is the ONLY way to stop it
    } finally {
      vi.useRealTimers();
    }
    // The replacement worker starts empty — it must be re-seeded, or every
    // later regex search would silently report zero hits. (The seed posts
    // synchronously; this fake never answers, so don't await the scan.)
    const next = engine.search('total', { regex: true });
    expect(fake.seeds()).toBe(2);
    engine.dispose(); // drops the pending time budget
    void next.catch(() => undefined);
  });

  it('falls back to a synchronous scan when no worker can be created', async () => {
    const doc = makeDoc('d1', 'C:/a.pdf', [pageRef('C:/a.pdf', 0)]);
    const docsRef = { current: [doc] };
    extractMock.mockReset();
    extractMock.mockResolvedValue({ text: 'Invoice 2024', needsOcr: false });
    const engine = createSearchEngine({
      onChange: vi.fn(),
      onProgress: vi.fn(),
      getDocs: () => docsRef.current,
      createSearchWorker: () => null,
    });
    engine.reconcile(docsRef.current, proxiesFor('C:/a.pdf'));
    await flush();
    expect((await engine.search('\\d{4}', { regex: true })).occurrences).toBe(1);
  });

  it('runCorpusSearch reports counts and first-match snippets in one pass', () => {
    const corpus = new Map([
      ['p0', 'total and total again'],
      ['p1', 'nothing'],
    ]);
    const { hits, error } = runCorpusSearch(corpus, 'total', {});
    expect(error).toBeNull();
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ pageId: 'p0', count: 2 });
    expect(hits[0].snippet).toContain('total');
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
