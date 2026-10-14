// The lines the canvas shows for a pending text box are the lines the commit
// writes: a failed layout call is asked again, and the alignment is the one
// the commit writes.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFName } from 'pdf-lib';
import { textBoxEditRefusal } from '../src/renderer/lib/text-box-edit';
import { bodyPlanOf, engineLayout, forgetEngineLayouts, knownEngineLayout, provideTextBoxEngine, standardLayout } from '../src/renderer/lib/text-box-layout';
import { forgetBundledFaces, learnBundledFaces, provideFaceReader } from '../src/renderer/lib/text-box-engine';
import { bundledFacesKnown } from '../src/renderer/lib/text-box-faces';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit, importedPages } from './support/commit-cycle';
import { FONT_DIR, HAS_BUNDLED_FACES, pythonTextEngine } from './support/text-engine';
import { CJK, HEBREW, POLISH, appearances, box, foreign } from './support/text-box-fixtures';
import type { Appearance } from './support/text-box-fixtures';

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const N = PDFName.of;
const RUN = 120_000;

const lineStarts = (out: Appearance): number[] => [...out.content.matchAll(/1 0 0 1 ([\d.]+) [-\d.]+ Tm/g)].map((match) => Number(match[1]));

describe.skipIf(!HAS_BUNDLED_FACES)('the canvas layout request', () => {
  beforeEach(() => {
    forgetEngineLayouts();
    forgetBundledFaces();
  });

  it('keeps nothing of a call that fails, shares a call that runs, and keeps an answer', async () => {
    let calls = 0;
    let failing = true;
    provideTextBoxEngine(async (blocks, draw) => {
      calls += 1;
      if (failing) throw new Error('the engine restarts');
      return pythonTextEngine(blocks, draw);
    });
    const plan = bodyPlanOf(box(HEBREW));
    await expect(engineLayout(HEBREW, plan, 100)).rejects.toThrow('the engine restarts');
    expect(knownEngineLayout(HEBREW, plan, 100)).toBeUndefined();
    failing = false;
    const [first, second] = await Promise.all([engineLayout(HEBREW, plan, 100), engineLayout(HEBREW, plan, 100)]);
    expect(calls).toBe(2);
    expect(first).toBe(second);
    expect(first).toMatchObject({ rtl: true, align: 2, lines: [HEBREW] });
    expect(knownEngineLayout(HEBREW, plan, 100)).toBe(first);
    expect(await engineLayout(HEBREW, plan, 100)).toBe(first);
    expect(calls).toBe(2);
    // A text the engine refuses is an answer.
    expect(await engineLayout('क्ष', plan, 100)).toBeNull();
    expect(knownEngineLayout('क्ष', plan, 100)).toBeNull();
    provideTextBoxEngine(undefined);
    await expect(engineLayout('שלום אחר', plan, 100)).rejects.toThrow();
    expect(knownEngineLayout('שלום אחר', plan, 100)).toBeUndefined();
  }, RUN);

  it('reads the face files once, and again after a read that fails', async () => {
    let reads = 0;
    let failing = true;
    provideFaceReader(async (_method, params) => {
      reads += 1;
      if (failing) throw new Error('the engine restarts');
      expect(params).toMatchObject({ blocks: [], draw: false, faces: true });
      return { blocks: [], faces: ['LiberationSans-Regular.ttf'] };
    }, async () => FONT_DIR);
    await learnBundledFaces();
    expect(bundledFacesKnown()).toBe(false);
    expect(textBoxEditRefusal(box(CJK), 1)).toBeNull();
    failing = false;
    await Promise.all([learnBundledFaces(), learnBundledFaces()]);
    expect(reads).toBe(2);
    expect(bundledFacesKnown()).toBe(true);
    expect(textBoxEditRefusal(box(CJK), 1)).toMatchObject({ reason: 'faces' });
    expect(textBoxEditRefusal(box(POLISH), 1)).toBeNull();
    await learnBundledFaces();
    expect(reads).toBe(2);
    provideFaceReader(undefined);
    forgetBundledFaces();
  });

  it('aligns as the commit aligns: by the alignment the original states, else by the direction of the text', async () => {
    const words = 'Several words that wrap in the box because one line does not hold them';
    for (const [kind, via] of [['times', 'engine'], ['helvetica', 'standard']] as const) {
      const bytes = await foreign(kind, 'Ten point text', 1);
      const [a] = (await importedPages(bytes))[0].annotations!;
      expect(a.textRedraw!.align, kind).toBe(1);
      const text = via === 'engine' ? `${POLISH} ${words}` : words;
      const edited = { ...a, note: text, geometryDiverged: true };
      const plan = bodyPlanOf(edited);
      expect(plan, kind).toMatchObject({ via, align: 1, size: 10 });
      const width = edited.w * 612 - 6;
      provideTextBoxEngine(pythonTextEngine);
      const layout = via === 'engine' ? (await engineLayout(text, plan, width))! : standardLayout(text, plan.size, width, plan.align);
      provideTextBoxEngine(undefined);
      expect(layout.align, kind).toBe(1);
      const output = await commit(bytes, (pages) => [{ ...pages[0], annotations: [{ ...pages[0].annotations![0], note: text, geometryDiverged: true }] }]);
      const [out] = await appearances(output);
      expect(out.lines, kind).toEqual(layout.lines);
      expect(out.lines.length, kind).toBeGreaterThan(1);
      expect(Math.max(...lineStarts(out)), kind).toBeGreaterThan(1);
      expect(String(out.dict.lookup(N('Q'))), kind).toBe('1');
    }
  }, RUN);
  it('aligns a right-to-left text to the right when the original states no alignment', async () => {
    const bytes = await foreign('times');
    const [a] = (await importedPages(bytes))[0].annotations!;
    expect(a.textRedraw!.align).toBeUndefined();
    const plan = bodyPlanOf({ ...a, note: HEBREW });
    expect(plan.via).toBe('engine');
    expect(plan.align).toBeUndefined();
    provideTextBoxEngine(pythonTextEngine);
    const layout = (await engineLayout(HEBREW, plan, a.w * 612 - 6))!;
    provideTextBoxEngine(undefined);
    expect(layout).toMatchObject({ rtl: true, align: 2 });
    const output = await commit(bytes, (pages) => [{ ...pages[0], annotations: [{ ...pages[0].annotations![0], note: HEBREW, geometryDiverged: true }] }]);
    const [out] = await appearances(output);
    expect(Math.min(...lineStarts(out))).toBeGreaterThan(1);
    expect(String(out.dict.lookup(N('Q')))).toBe('2');
  }, RUN);
});
