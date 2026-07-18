import { describe, it, expect, vi } from 'vitest';
import {
  runBatchOcr,
  joinDest,
  destConflictsWithSource,
  classifyLoadError,
  summarize,
  type BatchEntry,
  type BatchIo,
  type BatchPdfDoc,
  type BatchProgress,
} from '../src/renderer/lib/batch-ocr';
import type { OcrResult } from '../src/renderer/ocr/types';

// The Phase 6 driver, exercised with all IO faked (the 2m no-WASM-in-vitest
// precedent): classification (ocr/copied/skipped), per-file failure
// isolation, cancellation quiescence, mirror path math, report aggregation.

const GEOMETRY = { box: { x: 0, y: 0, width: 612, height: 792 }, bakedRotate: 0 };

interface FakeSpec {
  /** Per page: true = needsOcr. */
  pages: boolean[];
  /** Words returned for every recognized page (default: one word). */
  words?: OcrResult['words'];
  loadError?: unknown;
  recognizeError?: Error;
}

function fakeDoc(spec: FakeSpec, destroyed: string[]): BatchPdfDoc {
  return {
    numPages: spec.pages.length,
    needsOcr: async (i) => spec.pages[i],
    geometry: async () => GEOMETRY,
    recognize: async () => {
      if (spec.recognizeError) throw spec.recognizeError;
      return {
        text: 'hello',
        words: spec.words ?? [{ text: 'hello', x: 0.1, y: 0.1, w: 0.2, h: 0.05 }],
      };
    },
    destroy: async () => {
      destroyed.push('doc');
    },
  };
}

function makeIo(specs: Record<string, FakeSpec>) {
  const destroyed: string[] = [];
  const copies: [string, string][] = [];
  const applied: { source: string; output: string; pages: number[] }[] = [];
  const ensured: string[] = [];
  const io: BatchIo = {
    load: async (abs) => {
      const spec = specs[abs];
      if (!spec) throw new Error(`no fixture for ${abs}`);
      if (spec.loadError) throw spec.loadError;
      return fakeDoc(spec, destroyed);
    },
    applyOcrLayer: async (source, output, pages) => {
      applied.push({ source, output, pages: pages.map((p) => p.page) });
    },
    copyFile: async (src, dest) => {
      copies.push([src, dest]);
    },
    ensureParentDirs: async (path) => {
      ensured.push(path);
    },
  };
  return { io, destroyed, copies, applied, ensured };
}

const entry = (rel: string): BatchEntry => ({ abs: `C:\\src\\${rel}`, rel });

describe('joinDest', () => {
  it('joins with the root separator style and no doubling', () => {
    expect(joinDest('C:\\out', 'a\\b.pdf')).toBe('C:\\out\\a\\b.pdf');
    expect(joinDest('C:\\out\\', 'b.pdf')).toBe('C:\\out\\b.pdf');
  });
  it('handles unicode and spaces untouched', () => {
    expect(joinDest('C:\\héllo out', 'ä ö\\ü.pdf')).toBe('C:\\héllo out\\ä ö\\ü.pdf');
  });
});

describe('destConflictsWithSource', () => {
  it('rejects dest == source (any spelling)', () => {
    expect(destConflictsWithSource('C:\\Docs', 'c:\\docs')).toBe(true);
    expect(destConflictsWithSource('C:\\Docs', 'C:\\Docs\\')).toBe(true);
  });
  it('rejects dest inside source', () => {
    expect(destConflictsWithSource('C:\\Docs', 'C:\\Docs\\out')).toBe(true);
  });
  it('allows siblings and prefix-similar names', () => {
    expect(destConflictsWithSource('C:\\Docs', 'C:\\Docs (OCR)')).toBe(false);
    expect(destConflictsWithSource('C:\\Docs', 'C:\\DocsOut')).toBe(false);
    // Source inside dest is allowed: outputs land beside, never over, sources.
    expect(destConflictsWithSource('C:\\Docs\\in', 'C:\\Docs')).toBe(false);
  });
});

describe('classifyLoadError', () => {
  it('names password protection', () => {
    const err = Object.assign(new Error('No password given'), { name: 'PasswordException' });
    expect(classifyLoadError(err)).toBe('password-protected');
  });
  it('wraps everything else as unreadable', () => {
    expect(classifyLoadError(new Error('bad XRef'))).toBe('unreadable: bad XRef');
  });
});

describe('runBatchOcr', () => {
  it('classifies: scanned → ocr, born-digital → copied, broken → skipped; run continues past failures', async () => {
    const { io, copies, applied } = makeIo({
      'C:\\src\\a\\scan.pdf': { pages: [true, false, true] },
      'C:\\src\\born.pdf': { pages: [false] },
      'C:\\src\\broken.pdf': { pages: [], loadError: new Error('bad XRef') },
    });
    const report = await runBatchOcr(
      [entry('a\\scan.pdf'), entry('born.pdf'), entry('broken.pdf')],
      'C:\\out',
      [],
      io,
    );
    expect(report.cancelled).toBe(false);
    expect(report.results).toEqual([
      { rel: 'a\\scan.pdf', status: 'ocr', pagesOcrd: 2 },
      { rel: 'born.pdf', status: 'copied' },
      { rel: 'broken.pdf', status: 'skipped', reason: 'unreadable: bad XRef' },
    ]);
    // OCR'd file: applied to the mirrored path with 1-based page numbers,
    // parents ensured first; born-digital copied to its mirrored path.
    expect(applied).toEqual([
      { source: 'C:\\src\\a\\scan.pdf', output: 'C:\\out\\a\\scan.pdf', pages: [1, 3] },
    ]);
    expect(copies).toEqual([['C:\\src\\born.pdf', 'C:\\out\\born.pdf']]);
    expect(summarize(report)).toEqual({ ocrd: 1, copied: 1, skipped: 1 });
  });

  it('destroys the doc even when apply fails, and isolates the failure to that file', async () => {
    const { io, destroyed } = makeIo({
      'C:\\src\\x.pdf': { pages: [true] },
      'C:\\src\\y.pdf': { pages: [false] },
    });
    io.applyOcrLayer = async () => {
      throw new Error('engine died on this file');
    };
    const report = await runBatchOcr([entry('x.pdf'), entry('y.pdf')], 'C:\\out', [], io);
    expect(report.results[0]).toEqual({
      rel: 'x.pdf',
      status: 'skipped',
      reason: 'engine died on this file',
    });
    expect(report.results[1].status).toBe('copied');
    expect(destroyed.length).toBe(2);
  });

  it('copies (with a note) a scanned file whose recognition finds no words', async () => {
    const { io, copies } = makeIo({
      'C:\\src\\blank.pdf': { pages: [true], words: [{ text: '   ', x: 0, y: 0, w: 0.1, h: 0.1 }] },
    });
    const report = await runBatchOcr([entry('blank.pdf')], 'C:\\out', [], io);
    expect(report.results[0]).toEqual({
      rel: 'blank.pdf',
      status: 'copied',
      reason: 'no text recognized',
    });
    expect(copies.length).toBe(1);
  });

  it('cancels between files: completed results stay, later files never load', async () => {
    const loaded: string[] = [];
    const { io } = makeIo({
      'C:\\src\\a.pdf': { pages: [false] },
      'C:\\src\\b.pdf': { pages: [false] },
    });
    const innerLoad = io.load;
    io.load = async (abs) => {
      loaded.push(abs);
      return innerLoad(abs);
    };
    let cancelled = false;
    const report = await runBatchOcr([entry('a.pdf'), entry('b.pdf')], 'C:\\out', [], io, {
      onProgress: (p: BatchProgress) => {
        if (p.rel === 'a.pdf' && p.phase === 'copying') cancelled = true;
      },
      isCancelled: () => cancelled,
    });
    expect(report.cancelled).toBe(true);
    expect(report.results).toEqual([{ rel: 'a.pdf', status: 'copied' }]);
    expect(loaded).toEqual(['C:\\src\\a.pdf']);
  });

  it('cancellation mid-recognition reaches quiescence (destroy runs after workers settle)', async () => {
    const events: string[] = [];
    let cancelled = false;
    let calls = 0;
    const doc: BatchPdfDoc = {
      numPages: 4,
      needsOcr: async () => true,
      geometry: async () => GEOMETRY,
      recognize: async (i) => {
        events.push(`start:${i}`);
        calls += 1;
        // Flip on the SECOND call so the FIRST recognize is genuinely in
        // flight when cancellation is observed — both workers must then
        // settle before destroy. (The original version flipped on call one,
        // so the sibling worker never started a recognition and the test
        // passed under a Promise.all mutant that destroys mid-flight —
        // proven by mutation during review.)
        if (calls === 2) cancelled = true;
        await new Promise((r) => setTimeout(r, 5));
        events.push(`end:${i}`);
        return { text: 'w', words: [{ text: 'w', x: 0, y: 0, w: 0.1, h: 0.1 }] };
      },
      destroy: async () => {
        events.push('destroy');
      },
    };
    const io: BatchIo = {
      load: async () => doc,
      applyOcrLayer: vi.fn(async () => {}),
      copyFile: vi.fn(async () => {}),
      ensureParentDirs: vi.fn(async () => {}),
    };
    const report = await runBatchOcr([entry('big.pdf')], 'C:\\out', [], io, {
      isCancelled: () => cancelled,
    });
    // Flush dangling timers a buggy variant would leave behind — its late
    // `end:` lands AFTER destroy and only a post-flush read can see it.
    await new Promise((r) => setTimeout(r, 25));
    expect(report.cancelled).toBe(true);
    expect(report.results).toEqual([]);
    // Every STARTED recognition must have ENDED, and ended BEFORE destroy —
    // otherwise the driver tore the doc down under an in-flight render.
    const destroyAt = events.indexOf('destroy');
    expect(destroyAt).toBeGreaterThan(-1);
    const started = events.filter((e) => e.startsWith('start:'));
    expect(started.length).toBeGreaterThanOrEqual(2); // the race actually raced
    for (const s of started) {
      const endIdx = events.indexOf(`end:${s.slice('start:'.length)}`);
      expect(endIdx).toBeGreaterThan(-1);
      expect(endIdx).toBeLessThan(destroyAt);
    }
    expect(io.applyOcrLayer).not.toHaveBeenCalled();
  });

  it('reports the shortfall when only SOME scanned pages recognize text (mixed file)', async () => {
    const doc: BatchPdfDoc = {
      numPages: 2,
      needsOcr: async () => true,
      geometry: async () => GEOMETRY,
      recognize: async (i) => ({
        text: i === 0 ? 'hello' : ' ',
        words:
          i === 0
            ? [{ text: 'hello', x: 0.1, y: 0.1, w: 0.2, h: 0.05 }]
            : [{ text: '   ', x: 0, y: 0, w: 0.1, h: 0.1 }],
      }),
      destroy: async () => {},
    };
    const io: BatchIo = {
      load: async () => doc,
      applyOcrLayer: vi.fn(async () => {}),
      copyFile: vi.fn(async () => {}),
      ensureParentDirs: vi.fn(async () => {}),
    };
    const report = await runBatchOcr([entry('mixed.pdf')], 'C:\\out', [], io);
    expect(report.results[0]).toEqual({
      rel: 'mixed.pdf',
      status: 'ocr',
      pagesOcrd: 1,
      reason: '1 of 2 scanned pages had no recognizable text',
    });
    // The fully-recognized case stays reason-free (asserted exactly in the
    // classification test above: {rel, status, pagesOcrd} with no reason).
  });

  it('treats worker-pool cancellation rejections ("cancelled") as a stop, not a file error', async () => {
    let cancelled = false;
    const doc: BatchPdfDoc = {
      numPages: 2,
      needsOcr: async () => true,
      geometry: async () => GEOMETRY,
      recognize: async () => {
        cancelled = true;
        throw new Error('cancelled'); // what OcrClient.cancelAll() rejects with
      },
      destroy: async () => {},
    };
    const io: BatchIo = {
      load: async () => doc,
      applyOcrLayer: vi.fn(async () => {}),
      copyFile: vi.fn(async () => {}),
      ensureParentDirs: vi.fn(async () => {}),
    };
    const report = await runBatchOcr([entry('a.pdf')], 'C:\\out', [], io, {
      isCancelled: () => cancelled,
    });
    expect(report.cancelled).toBe(true);
    expect(report.results).toEqual([]);
  });

  it('a recognition failure (non-cancel) fails the FILE and the run continues', async () => {
    const { io } = makeIo({
      'C:\\src\\bad.pdf': { pages: [true], recognizeError: new Error('worker exploded') },
      'C:\\src\\ok.pdf': { pages: [false] },
    });
    const report = await runBatchOcr([entry('bad.pdf'), entry('ok.pdf')], 'C:\\out', [], io);
    expect(report.cancelled).toBe(false);
    expect(report.results[0]).toEqual({
      rel: 'bad.pdf',
      status: 'skipped',
      reason: 'worker exploded',
    });
    expect(report.results[1].status).toBe('copied');
  });

  it('carries enumeration skippedDirs into the report', async () => {
    const { io } = makeIo({});
    const report = await runBatchOcr([], 'C:\\out', ['C:\\src\\locked'], io);
    expect(report.skippedDirs).toEqual(['C:\\src\\locked']);
  });

  it('converts word boxes with the shared display→PDF recipe (sanity anchor)', async () => {
    // One word at the top-left quarter of an unrotated 612x792 page must land
    // in PDF space with y measured from the BOTTOM (the recipe's case 0).
    const capture: { rect?: [number, number, number, number] } = {};
    const { io } = makeIo({
      'C:\\src\\w.pdf': { pages: [true], words: [{ text: 'w', x: 0, y: 0, w: 0.25, h: 0.25 }] },
    });
    const inner = io.applyOcrLayer;
    io.applyOcrLayer = async (s, o, pages) => {
      capture.rect = pages[0].words[0].rect;
      return inner(s, o, pages);
    };
    await runBatchOcr([entry('w.pdf')], 'C:\\out', [], io);
    expect(capture.rect).toEqual([0, 792 * 0.75, 612 * 0.25, 792]);
  });
});
