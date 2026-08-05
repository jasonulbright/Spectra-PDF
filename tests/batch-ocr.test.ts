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

// The batch-OCR driver, exercised with all IO faked (the no-WASM-in-vitest
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

/** knobs: which fake operations fail, and what a repair produces. */
interface IoOpts {
  /** Mirror outputs that fail the read-back verification. */
  verifyFails?: string[];
  /** Source paths whose move throws. */
  moveFails?: string[];
  /** src -> the scratch path a repair produces. The scratch path must have its
   * own entry in `specs`, which is how a test says "repair made it readable". */
  repairProduces?: Record<string, string>;
  /** Source paths whose repair itself throws. */
  repairFails?: string[];
  /** Source paths whose repaired-bytes copy-back throws. */
  copyFails?: string[];
  /** Mirror outputs whose MRC pass refuses (e.g. nothing to separate). */
  mrcFails?: string[];
}

function makeIo(specs: Record<string, FakeSpec>, opts: IoOpts = {}) {
  const destroyed: string[] = [];
  const copies: [string, string][] = [];
  const applied: { source: string; output: string; pages: number[] }[] = [];
  const ensured: string[] = [];
  const moves: [string, string][] = [];
  const verified: [string, number][] = [];
  const discarded: string[] = [];
  const compressed: [string, string, boolean][] = [];
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
      if (opts.copyFails?.includes(src)) throw new Error('copy denied');
      copies.push([src, dest]);
    },
    ensureParentDirs: async (path) => {
      ensured.push(path);
    },
    moveFile: async (src, dest) => {
      if (opts.moveFails?.includes(src)) throw new Error('move denied');
      moves.push([src, dest]);
      return dest;
    },
    verifyOutput: async (path, expectedPages) => {
      verified.push([path, expectedPages]);
      return !opts.verifyFails?.includes(path);
    },
    compressMrc: async (path, preset, verifyText) => {
      compressed.push([path, preset, verifyText]);
      if (opts.mrcFails?.includes(path)) throw new Error('nothing to separate');
      return `MRC compressed 2 page(s), 900 -> 100 bytes`;
    },
    repairToScratch: async (src) => {
      if (opts.repairFails?.includes(src)) throw new Error('too damaged');
      const scratch = opts.repairProduces?.[src];
      if (!scratch) throw new Error('too damaged');
      return scratch;
    },
    discardScratch: async (path) => {
      discarded.push(path);
    },
  };
  return { io, destroyed, copies, applied, ensured, moves, verified, discarded, compressed };
}

/** The four filing primitives, stubbed to explode. Tests using the inline `io`
 * literals below do not opt into moved/error folders or repair, so the driver
 * must never reach these — a throwing stub says that, where a silent no-op
 * would hide a driver that moved files nobody asked it to move. */
function noFiling(): Pick<
  BatchIo,
  'moveFile' | 'verifyOutput' | 'repairToScratch' | 'discardScratch' | 'compressMrc'
> {
  const nope = (name: string) => () => {
    throw new Error(`${name} must not run without the matching opt-in`);
  };
  return {
    moveFile: nope('moveFile') as unknown as BatchIo['moveFile'],
    verifyOutput: nope('verifyOutput') as unknown as BatchIo['verifyOutput'],
    repairToScratch: nope('repairToScratch') as unknown as BatchIo['repairToScratch'],
    discardScratch: nope('discardScratch') as unknown as BatchIo['discardScratch'],
    compressMrc: nope('compressMrc') as unknown as BatchIo['compressMrc'],
  };
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
      ...noFiling(),
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
      ...noFiling(),
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
      ...noFiling(),
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

// ── the moved/error folders and auto-repair ────────────────────────────────
//
// These are the only batch behaviours that MUTATE the user's source tree, so
// the tests are written around the question "when is a source allowed to
// move?" rather than around the happy path.

describe('runBatchOcr — filing the originals', () => {
  const specs = {
    'C:\\src\\a\\scan.pdf': { pages: [true, false] },
    'C:\\src\\born.pdf': { pages: [false] },
    'C:\\src\\broken.pdf': { pages: [], loadError: new Error('bad XRef') },
  };
  const allThree = [entry('a\\scan.pdf'), entry('born.pdf'), entry('broken.pdf')];

  it('touches NOTHING when no roots are given — the default guarantee', async () => {
    // `noFiling`-style proof at the driver level: the fake's moveFile records
    // every call, so an empty list is the assertion that the standing promise
    // ("the source folder is never modified") still holds by default.
    const { io, moves, verified } = makeIo(specs);
    const report = await runBatchOcr(allThree, 'C:\\out', [], io);
    expect(moves).toEqual([]);
    expect(verified).toEqual([]);
    expect(report.results.every((r) => r.movedTo === undefined)).toBe(true);
  });

  it('moves successes to the moved root and failures to the error root, structure preserved', async () => {
    const { io, moves } = makeIo(specs);
    const report = await runBatchOcr(allThree, 'C:\\out', [], io, {
      movedRoot: 'D:\\done',
      errorRoot: 'D:\\errors',
    });
    expect(moves).toEqual([
      ['C:\\src\\a\\scan.pdf', 'D:\\done\\a\\scan.pdf'],
      ['C:\\src\\born.pdf', 'D:\\done\\born.pdf'],
      ['C:\\src\\broken.pdf', 'D:\\errors\\broken.pdf'],
    ]);
    expect(report.results.map((r) => r.movedTo)).toEqual([
      'D:\\done\\a\\scan.pdf',
      'D:\\done\\born.pdf',
      'D:\\errors\\broken.pdf',
    ]);
  });

  it('uses each root independently — an error root alone leaves successes in place', async () => {
    const { io, moves } = makeIo(specs);
    await runBatchOcr(allThree, 'C:\\out', [], io, { errorRoot: 'D:\\errors' });
    expect(moves).toEqual([['C:\\src\\broken.pdf', 'D:\\errors\\broken.pdf']]);
  });

  it('VERIFIES the output before moving a source, and against the source page count', async () => {
    const { io, verified } = makeIo(specs);
    await runBatchOcr([entry('a\\scan.pdf')], 'C:\\out', [], io, { movedRoot: 'D:\\done' });
    expect(verified).toEqual([['C:\\out\\a\\scan.pdf', 2]]);
  });

  it('leaves the original ALONE when the output cannot be read back', async () => {
    // The failure this exists for: the engine reports success and writes a
    // truncated or unreadable file. Moving the source then loses the only
    // good copy. Status must not claim success either.
    const { io, moves } = makeIo(specs, { verifyFails: ['C:\\out\\a\\scan.pdf'] });
    const report = await runBatchOcr([entry('a\\scan.pdf')], 'C:\\out', [], io, {
      movedRoot: 'D:\\done',
    });
    expect(report.results[0].status).toBe('skipped');
    expect(report.results[0].reason).toContain('could not be read back');
    expect(report.results[0].movedTo).toBeUndefined();
    expect(moves).toEqual([]);
  });

  it('routes a verification failure to the ERROR root, never the done root', async () => {
    const { io, moves } = makeIo(specs, { verifyFails: ['C:\\out\\a\\scan.pdf'] });
    await runBatchOcr([entry('a\\scan.pdf')], 'C:\\out', [], io, {
      movedRoot: 'D:\\done',
      errorRoot: 'D:\\errors',
    });
    expect(moves).toEqual([['C:\\src\\a\\scan.pdf', 'D:\\errors\\a\\scan.pdf']]);
  });

  it('does not verify when nothing is going to move (the default path stays one pass)', async () => {
    const { io, verified } = makeIo(specs);
    await runBatchOcr([entry('a\\scan.pdf')], 'C:\\out', [], io, { errorRoot: 'D:\\errors' });
    expect(verified).toEqual([]);
  });

  it('reports a failed move WITHOUT downgrading the OCR result', async () => {
    // The OCR genuinely succeeded; the filing did not. Conflating the two
    // would tell the user their document failed when it is sitting correct in
    // the destination.
    const { io } = makeIo(specs, { moveFails: ['C:\\src\\a\\scan.pdf'] });
    const report = await runBatchOcr([entry('a\\scan.pdf')], 'C:\\out', [], io, {
      movedRoot: 'D:\\done',
    });
    expect(report.results[0].status).toBe('ocr');
    expect(report.results[0].pagesOcrd).toBe(1);
    expect(report.results[0].movedTo).toBeUndefined();
    expect(report.results[0].moveError).toBe('move denied');
  });

  it('moves a file that failed MID-WORK to the error root', async () => {
    // Not a load failure — a throw from the write step, which lands in the
    // driver's outer catch rather than the tail.
    const { io } = makeIo({ 'C:\\src\\x.pdf': { pages: [true] } });
    io.applyOcrLayer = async () => {
      throw new Error('disk full');
    };
    const report = await runBatchOcr([entry('x.pdf')], 'C:\\out', [], io, {
      errorRoot: 'D:\\errors',
    });
    expect(report.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'disk full',
      movedTo: 'D:\\errors\\x.pdf',
    });
  });
});

describe('runBatchOcr — auto-repair', () => {
  const damaged = { pages: [], loadError: new Error('bad XRef') };

  it('is OFF by default: a damaged file is skipped without a repair attempt', async () => {
    const { io, discarded } = makeIo({ 'C:\\src\\bad.pdf': damaged });
    const report = await runBatchOcr([entry('bad.pdf')], 'C:\\out', [], io);
    expect(report.results[0]).toEqual({
      rel: 'bad.pdf',
      status: 'skipped',
      reason: 'unreadable: bad XRef',
    });
    expect(discarded).toEqual([]);
  });

  it('repairs, then processes the REPAIRED copy rather than the damaged source', async () => {
    const { io, applied, discarded } = makeIo(
      { 'C:\\src\\bad.pdf': damaged, 'T:\\scratch-0.pdf': { pages: [true] } },
      { repairProduces: { 'C:\\src\\bad.pdf': 'T:\\scratch-0.pdf' } },
    );
    const report = await runBatchOcr([entry('bad.pdf')], 'C:\\out', [], io, {
      repairDamaged: true,
    });
    expect(report.results[0]).toMatchObject({ status: 'ocr', pagesOcrd: 1, repaired: true });
    // The mirror is built from the repaired bytes — reading the damaged
    // original again is what would put unreadable content in the destination.
    expect(applied[0].source).toBe('T:\\scratch-0.pdf');
    expect(discarded).toEqual(['T:\\scratch-0.pdf']);
  });

  it('never attempts repair on a password-protected file', async () => {
    // A structural rewrite cannot supply a password, and trying replaces a
    // clear diagnosis with a confusing one.
    const err = Object.assign(new Error('No password given'), { name: 'PasswordException' });
    const { io } = makeIo({ 'C:\\src\\locked.pdf': { pages: [], loadError: err } });
    const report = await runBatchOcr([entry('locked.pdf')], 'C:\\out', [], io, {
      repairDamaged: true,
    });
    // repairToScratch would have thrown 'too damaged' had it run.
    expect(report.results[0].reason).toBe('password-protected');
    expect(report.results[0].repaired).toBeUndefined();
  });

  it('keeps the ORIGINAL diagnosis when repair does not help', async () => {
    const { io } = makeIo(
      { 'C:\\src\\bad.pdf': damaged },
      { repairFails: ['C:\\src\\bad.pdf'] },
    );
    const report = await runBatchOcr([entry('bad.pdf')], 'C:\\out', [], io, {
      repairDamaged: true,
    });
    expect(report.results[0].reason).toBe('unreadable: bad XRef; repair did not help: too damaged');
  });

  it('writes the repaired bytes back over the original only when asked', async () => {
    const setup = () =>
      makeIo(
        { 'C:\\src\\bad.pdf': damaged, 'T:\\scratch-0.pdf': { pages: [false] } },
        { repairProduces: { 'C:\\src\\bad.pdf': 'T:\\scratch-0.pdf' } },
      );
    const off = setup();
    await runBatchOcr([entry('bad.pdf')], 'C:\\out', [], off.io, { repairDamaged: true });
    // Only the mirror copy — nothing written back into C:\src.
    expect(off.copies).toEqual([['T:\\scratch-0.pdf', 'C:\\out\\bad.pdf']]);

    const on = setup();
    const report = await runBatchOcr([entry('bad.pdf')], 'C:\\out', [], on.io, {
      repairDamaged: true,
      replaceRepairedOriginals: true,
    });
    expect(on.copies).toEqual([
      ['T:\\scratch-0.pdf', 'C:\\out\\bad.pdf'],
      // The PRE-OCR repaired bytes go back, not a searchable derivative.
      ['T:\\scratch-0.pdf', 'C:\\src\\bad.pdf'],
    ]);
    expect(report.results[0].repairedOriginalReplaced).toBe(true);
  });

  it('reports a failed write-back without claiming the original was healed', async () => {
    // The repaired page NEEDS OCR, so the mirror goes through applyOcrLayer
    // and the only copyFile in the run is the write-back itself — otherwise
    // this test would be asserting on a file that failed earlier, for an
    // unrelated reason, and would pass with the write-back deleted.
    const { io } = makeIo(
      { 'C:\\src\\bad.pdf': damaged, 'T:\\scratch-0.pdf': { pages: [true] } },
      {
        repairProduces: { 'C:\\src\\bad.pdf': 'T:\\scratch-0.pdf' },
        copyFails: ['T:\\scratch-0.pdf'],
      },
    );
    const report = await runBatchOcr([entry('bad.pdf')], 'C:\\out', [], io, {
      repairDamaged: true,
      replaceRepairedOriginals: true,
    });
    // The document itself succeeded; only the healing of the source failed.
    expect(report.results[0].status).toBe('ocr');
    expect(report.results[0].repairedOriginalReplaced).toBeUndefined();
    expect(report.results[0].moveError).toContain('could not replace the original');
  });

  it('discards the scratch file even when the run fails', async () => {
    const { io, discarded } = makeIo(
      { 'C:\\src\\bad.pdf': damaged, 'T:\\scratch-0.pdf': { pages: [true] } },
      { repairProduces: { 'C:\\src\\bad.pdf': 'T:\\scratch-0.pdf' } },
    );
    io.applyOcrLayer = async () => {
      throw new Error('disk full');
    };
    await runBatchOcr([entry('bad.pdf')], 'C:\\out', [], io, { repairDamaged: true });
    expect(discarded).toEqual(['T:\\scratch-0.pdf']);
  });
});

describe('runBatchOcr — MRC', () => {
  it('compresses the MIRROR OUTPUT, never the source, and only when asked', async () => {
    const { io, compressed } = makeIo({
      'C:\\src\\scan.pdf': { pages: [true] },
      'C:\\src\\born.pdf': { pages: [false] },
    });
    const off = await runBatchOcr([entry('scan.pdf')], 'C:\\out', [], io);
    expect(compressed).toEqual([]);
    expect(off.results[0].mrc).toBeUndefined();

    const report = await runBatchOcr(
      [entry('scan.pdf'), entry('born.pdf')],
      'C:\\out',
      [],
      io,
      { mrc: { preset: 'smallest', verifyText: true } },
    );
    // The recognised output is the input — which is what makes the
    // recognize-then-MRC order structural rather than documented.
    expect(compressed).toEqual([
      ['C:\\out\\scan.pdf', 'smallest', true],
      ['C:\\out\\born.pdf', 'smallest', true],
    ]);
    expect(report.results[0].mrc).toContain('MRC compressed');
    expect(report.results[0].status).toBe('ocr');
  });

  it('a refusal is a NOTE, never a file failure', async () => {
    // MRC declining is the ordinary case for a mixed folder: the searchable
    // copy is the deliverable the user asked for and it is already written.
    const { io } = makeIo(
      { 'C:\\src\\typed.pdf': { pages: [false] } },
      { mrcFails: ['C:\\out\\typed.pdf'] },
    );
    const report = await runBatchOcr([entry('typed.pdf')], 'C:\\out', [], io, {
      mrc: { preset: 'balanced', verifyText: false },
    });
    expect(report.results[0].status).toBe('copied');
    expect(report.results[0].mrc).toContain('nothing to separate');
    expect(summarize(report)).toEqual({ ocrd: 0, copied: 1, skipped: 0 });
  });

  it('a skipped file is never compressed', async () => {
    const { io, compressed } = makeIo({
      'C:\\src\\broken.pdf': { pages: [], loadError: new Error('bad XRef') },
    });
    const report = await runBatchOcr([entry('broken.pdf')], 'C:\\out', [], io, {
      mrc: { preset: 'balanced', verifyText: false },
    });
    expect(report.results[0].status).toBe('skipped');
    expect(compressed).toEqual([]);
  });

  it('runs BEFORE the verification that lets an original move', async () => {
    // Verifying bytes that are about to be replaced would verify the wrong
    // file — and the source moves on the strength of that verification.
    const order: string[] = [];
    const { io } = makeIo({ 'C:\\src\\scan.pdf': { pages: [true] } });
    const realCompress = io.compressMrc;
    io.compressMrc = async (path, preset, verify) => {
      order.push('mrc');
      return realCompress(path, preset, verify);
    };
    const realVerify = io.verifyOutput;
    io.verifyOutput = async (path, pages) => {
      order.push('verify');
      return realVerify(path, pages);
    };
    await runBatchOcr([entry('scan.pdf')], 'C:\\out', [], io, {
      movedRoot: 'C:\\done',
      mrc: { preset: 'balanced', verifyText: false },
    });
    expect(order).toEqual(['mrc', 'verify']);
  });

  it('reports a compressing phase so a long MRC pass is not silence', async () => {
    const phases: string[] = [];
    const { io } = makeIo({ 'C:\\src\\scan.pdf': { pages: [true] } });
    await runBatchOcr([entry('scan.pdf')], 'C:\\out', [], io, {
      mrc: { preset: 'balanced', verifyText: false },
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases).toContain('compressing');
  });
});
