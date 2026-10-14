// What the canvas and the store do when the engine gives no answer: a
// layout call the engine answers with an error is not made again, a call
// with no answer is made again a bounded number of times, and an edit that
// needs a bundled face is admitted only on the face files the fonts folder
// holds.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineError } from '../src/renderer/lib/engine-messages';
import { importedEdit } from '../src/renderer/lib/imported-edit';
import { needsBundledFace, textBoxEditRefusal } from '../src/renderer/lib/text-box-edit';
import { awaitBundledFaces, forgetBundledFaces, provideFaceReader } from '../src/renderer/lib/text-box-engine';
import type { TextBlockResult, TextBoxEngine } from '../src/renderer/lib/text-box-engine';
import { BUNDLED_FACES } from '../src/renderer/lib/bundled-faces';
import { DEFAULT_FACE_STYLE, bundledFacesKnown, provideBundledFaces } from '../src/renderer/lib/text-box-faces';
import {
  ENGINE_LAYOUT_TEXT_LIMIT, LAYOUT_RETRY_MS, LayoutUnavailable, MALFORMED_LAYOUT_REQUEST, bodyPlanOf, engineLayout, engineLayoutUnavailable,
  forgetEngineLayouts, isLayoutAnswer, knownEngineLayout, layoutRetryDelay, provideTextBoxEngine,
} from '../src/renderer/lib/text-box-layout';
import type { BodyPlan } from '../src/renderer/lib/text-box-layout';
import { createAppStore } from '../src/renderer/state/store';
import type { FaceKnowledge } from '../src/renderer/state/store';
import type { AppAction, PageAnnotation } from '../src/renderer/state/types';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit, importedPages } from './support/commit-cycle';
import { FONT_DIR, HAS_BUNDLED_FACES, engineCalls } from './support/text-engine';
import { CJK, HEBREW, POLISH, blank, box, foreign, opened, pagesOf, placing } from './support/text-box-fixtures';

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const RUN = 240_000;
const ROOT = join(__dirname, '..');
const TABLE_FACES: string[] = [...new Set(Object.values(BUNDLED_FACES).flatMap((table) => Object.values(table)))];
const facesOf = (table: Record<string, string>): string[] => Object.values(table);
const ENGINE_PLAN: BodyPlan = { via: 'engine', size: 12, style: DEFAULT_FACE_STYLE };

describe('a layout call of the canvas that fails', () => {
  beforeEach(forgetEngineLayouts);
  afterEach(() => provideTextBoxEngine(undefined));

  it('keeps the answer of the engine to a request it does not take, and makes the call once', async () => {
    let calls = 0;
    provideTextBoxEngine(async () => {
      calls += 1;
      throw new EngineError(MALFORMED_LAYOUT_REQUEST);
    });
    await expect(engineLayout(HEBREW, ENGINE_PLAN, 100)).rejects.toBeInstanceOf(LayoutUnavailable);
    expect(engineLayoutUnavailable(HEBREW, ENGINE_PLAN, 100)).toBe(true);
    await expect(engineLayout(HEBREW, ENGINE_PLAN, 100)).rejects.toBeInstanceOf(LayoutUnavailable);
    expect(calls).toBe(1);
    // No lines are known: the browser wraps this text.
    expect(knownEngineLayout(HEBREW, ENGINE_PLAN, 100)).toBeUndefined();
    // Another width is another request.
    expect(engineLayoutUnavailable(HEBREW, ENGINE_PLAN, 200)).toBe(false);
    forgetEngineLayouts();
    expect(engineLayoutUnavailable(HEBREW, ENGINE_PLAN, 100)).toBe(false);
  });

  it('keeps nothing of a call that got no answer, and waits a bounded number of times', async () => {
    const stopped = new EngineError('The document engine stopped before completing the operation.');
    for (const failure of [new Error('the engine restarts'), stopped]) {
      expect(isLayoutAnswer(failure)).toBe(false);
      provideTextBoxEngine(async () => {
        throw failure;
      });
      await expect(engineLayout(HEBREW, ENGINE_PLAN, 100)).rejects.toBe(failure);
      expect(engineLayoutUnavailable(HEBREW, ENGINE_PLAN, 100)).toBe(false);
    }
    expect(isLayoutAnswer(new EngineError(MALFORMED_LAYOUT_REQUEST))).toBe(true);
    expect(isLayoutAnswer(new LayoutUnavailable())).toBe(true);
    expect([0, 1, 2, 3, 4, 5, 6, 100].map(layoutRetryDelay)).toEqual([null, ...LAYOUT_RETRY_MS, null, null, null]);
    expect(LAYOUT_RETRY_MS.length).toBeLessThanOrEqual(8);
  });

  it('asks nothing for a text longer than one call takes', async () => {
    let calls = 0;
    provideTextBoxEngine(async () => {
      calls += 1;
      return { blocks: [] };
    });
    const long = `ż${'x'.repeat(ENGINE_LAYOUT_TEXT_LIMIT)}`;
    expect(engineLayoutUnavailable(long, ENGINE_PLAN, 100)).toBe(true);
    await expect(engineLayout(long, ENGINE_PLAN, 100)).rejects.toBeInstanceOf(LayoutUnavailable);
    expect(calls).toBe(0);
  });

  it('holds the bound and the error text of the engine', () => {
    const source = readFileSync(join(ROOT, 'src', 'engine', 'text_box.py'), 'utf8');
    expect(source).toContain(`raise ValueError("${MALFORMED_LAYOUT_REQUEST}")`);
    expect(source).toMatch(new RegExp(`^_MAX_CHARS = ${ENGINE_LAYOUT_TEXT_LIMIT.toLocaleString('en-US').replace(/,/g, '_')}$`, 'm'));
  });
});

describe.skipIf(!HAS_BUNDLED_FACES)('an imported text box longer than the engine lays out', () => {
  it('is shown by the wrap of the browser, moves with its appearance, and refuses every edit that draws it again', async () => {
    // Hebrew: the text is shaped, so the font of the file does not lay it out.
    const long = `${HEBREW} ${'long text '.repeat(100_000)}end`;
    expect(long.length).toBeGreaterThan(ENGINE_LAYOUT_TEXT_LIMIT);
    const bytes = await foreign('times', long);
    const [a] = (await importedPages(bytes))[0].annotations!;
    expect(a.note).toBe(long);
    // The canvas asks the engine for no lines of this text, in the plan of
    // the import and in the plan of an edit: the browser wraps it.
    const plan = bodyPlanOf(a);
    expect(plan.via === 'natural' || engineLayoutUnavailable(long, plan, 188)).toBe(true);
    expect(engineLayoutUnavailable(long, ENGINE_PLAN, 188)).toBe(true);
    let asked = 0;
    provideTextBoxEngine(async () => {
      asked += 1;
      return { blocks: [] };
    });
    await expect(engineLayout(long, ENGINE_PLAN, 188)).rejects.toBeInstanceOf(LayoutUnavailable);
    provideTextBoxEngine(undefined);
    expect(asked).toBe(0);
    const moved: PageAnnotation = { ...a, x: a.x + 0.1 };
    expect(importedEdit(moved)).toMatchObject({ text: false, geometry: 'moved' });
    expect(textBoxEditRefusal(moved, 1)).toBeNull();
    expect(needsBundledFace(moved)).toBe(false);
    expect(textBoxEditRefusal({ ...a, note: `${long}!` }, 1)).toMatchObject({ reason: 'long' });
    // A change of colour draws the text again: it is refused.
    expect(textBoxEditRefusal({ ...a, color: '#00ff00' }, 1)).not.toBeNull();
    const calls = engineCalls.length;
    const output = await commit(bytes, (pages) => [{ ...pages[0], annotations: [{ ...pages[0].annotations![0], x: a.x + 0.1 }] }]);
    expect(engineCalls.length).toBe(calls);
    const [after] = (await importedPages(output))[0].annotations!;
    expect(after.note).toBe(long);
    expect(after.x).toBeCloseTo(a.x + 0.1, 3);
  }, RUN);
});

describe('an edit that needs a bundled face', () => {
  afterEach(() => {
    provideFaceReader(undefined);
    forgetBundledFaces();
    vi.useRealTimers();
  });

  const start = async () => {
    const bytes = await blank();
    const state = opened(await importedPages(bytes), bytes);
    const add = (annotation: PageAnnotation): AppAction =>
      ({ type: 'ADD_ANNOTATION', docId: 'a.pdf#0', pageId: pagesOf(state)[0].id, annotation });
    return { state, add };
  };
  const notes = (store: ReturnType<typeof createAppStore>): string[] =>
    (pagesOf(store.getState())[0].annotations ?? []).map((annotation) => annotation.note ?? '');
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  };

  it('tells which texts rest on the face files', () => {
    expect(needsBundledFace(box('plain “text” – 5 €'))).toBe(false);
    expect(needsBundledFace(box(''))).toBe(false);
    expect(needsBundledFace(box(POLISH))).toBe(true);
    expect(needsBundledFace(box(CJK))).toBe(true);
    expect(needsBundledFace(box(HEBREW))).toBe(true);
    // No face of the tables draws it: the refusal does not rest on the files.
    expect(needsBundledFace(box('ภาษาไทย'))).toBe(false);
    expect(needsBundledFace({ ...box('x'), kind: 'stamp', note: 'zażółć' } as PageAnnotation)).toBe(true);
  });

  it('is held until the face files are read, and a text the standard font draws waits behind it', async () => {
    const { state, add } = await start();
    let known = false;
    let settles = 0;
    let answer: (() => void) | undefined;
    const faces: FaceKnowledge = {
      known: () => known,
      settle: () => new Promise((resolve) => {
        settles += 1;
        answer = () => {
          known = true;
          provideBundledFaces(TABLE_FACES);
          resolve(true);
        };
      }),
    };
    const store = createAppStore(state, faces);
    store.dispatch(add(box(CJK)));
    expect(store.getState()).toBe(state);
    expect(settles).toBe(1);
    // A later page edit keeps its place: it is applied after the held one.
    store.dispatch(add(box('plain', { id: 'plain' })));
    expect(store.getState()).toBe(state);
    expect(settles).toBe(1);
    // An action that changes no page is not delayed.
    store.dispatch({ type: 'UI_SET_RECENT_FILES', files: [{ path: 'recent.pdf', openedAt: null }] });
    expect(store.getState().ui.recentFiles).toEqual([{ path: 'recent.pdf', openedAt: null }]);
    expect(store.getState().workspace).toBe(state.workspace);
    answer!();
    await settled();
    expect(notes(store)).toEqual([CJK, 'plain']);
    expect(store.getState().pageEditRefusals).toBe(state.pageEditRefusals);
    // Undo takes the edits back in the order opposite to the one they were asked in.
    store.dispatch({ type: 'UNDO_PAGE_OP' });
    expect(notes(store)).toEqual([CJK]);
    store.dispatch({ type: 'REDO_PAGE_OP' });
    expect(notes(store)).toEqual([CJK, 'plain']);
    // Known: no edit is held.
    store.dispatch(add(box(POLISH, { id: 'polish' })));
    expect(notes(store)).toEqual([CJK, 'plain', POLISH]);
    expect(settles).toBe(1);
  });

  it('keeps the order of every page edit, undo and redo asked for while one is held', async () => {
    const { state, add } = await start();
    let known = false;
    const answers: (() => void)[] = [];
    const store = createAppStore(state, {
      known: () => known,
      settle: () => new Promise((resolve) => {
        answers.push(() => resolve(known));
      }),
    });
    store.dispatch(add(box('first', { id: 'first' })));
    expect(notes(store)).toEqual(['first']);
    store.dispatch(add(box(CJK, { id: 'held' })));
    store.dispatch(add(box('second', { id: 'second' })));
    // Asked for after the held edit and `second`: it takes `second` back, never `first`.
    store.dispatch({ type: 'UNDO_PAGE_OP' });
    store.dispatch(add(box(HEBREW, { id: 'held-too' })));
    store.dispatch(add(box('third', { id: 'third' })));
    expect(notes(store)).toEqual(['first']);
    expect(answers).toHaveLength(1);
    // The first read gives no answer: the held edit is refused, and the next
    // edit that needs a face is held for a read of its own with `third` behind it.
    answers[0]();
    await settled();
    expect(notes(store)).toEqual(['first']);
    expect(store.getState().pageEditRefusals).toBe(state.pageEditRefusals + 1);
    expect(answers).toHaveLength(2);
    known = true;
    provideBundledFaces(TABLE_FACES);
    answers[1]();
    await settled();
    expect(notes(store)).toEqual(['first', HEBREW, 'third']);
    store.dispatch({ type: 'UNDO_PAGE_OP' });
    expect(notes(store)).toEqual(['first', HEBREW]);
  });

  it('applies the actions behind a held edit when the read of the face files fails', async () => {
    const { state, add } = await start();
    const store = createAppStore(state, { known: () => false, settle: () => Promise.reject(new Error('the engine restarts')) });
    store.dispatch(add(box(CJK, { id: 'held' })));
    store.dispatch(add(box('plain', { id: 'plain' })));
    expect(notes(store)).toEqual([]);
    await settled();
    expect(notes(store)).toEqual(['plain']);
    expect(store.getState().pageEditRefusalReason).toMatchObject({ textBox: { reason: 'faces' } });
  });

  it('is refused with the notice of the face files when the read gives no answer, and the next edit reads again', async () => {
    const { state, add } = await start();
    let known = false;
    let settles = 0;
    const store = createAppStore(state, { known: () => known, settle: async () => { settles += 1; return known; } });
    store.dispatch(add(box(CJK)));
    await settled();
    expect(notes(store)).toEqual([]);
    expect(store.getState().workspace).toBe(state.workspace);
    expect(store.getState().pageEditRefusals).toBe(state.pageEditRefusals + 1);
    expect(store.getState().pageEditRefusalReason).toEqual({ textBox: { reason: 'faces', kind: 'freetext', page: 1, words: CJK } });
    store.dispatch(add(box(CJK)));
    await settled();
    expect(settles).toBe(2);
    expect(store.getState().pageEditRefusals).toBe(state.pageEditRefusals + 2);
    // The read answers: the folder lacks the CJK faces, and the gate says so by its own rule.
    known = true;
    provideBundledFaces(TABLE_FACES.filter((name) => !facesOf(BUNDLED_FACES.cjk).includes(name)));
    store.dispatch(add(box(CJK)));
    expect(settles).toBe(2);
    expect(store.getState().pageEditRefusals).toBe(state.pageEditRefusals + 3);
    expect(store.getState().pageEditRefusalReason).toMatchObject({ textBox: { reason: 'faces' } });
    store.dispatch(add(box(POLISH)));
    expect(notes(store)).toEqual([POLISH]);
  });

  it('holds no undo and no redo', async () => {
    const { state, add } = await start();
    let known = true;
    provideBundledFaces(TABLE_FACES);
    const store = createAppStore(state, { known: () => known, settle: async () => false });
    store.dispatch(add(box(CJK)));
    expect(notes(store)).toEqual([CJK]);
    known = false;
    store.dispatch({ type: 'UNDO_PAGE_OP' });
    expect(notes(store)).toEqual([]);
    store.dispatch({ type: 'REDO_PAGE_OP' });
    expect(notes(store)).toEqual([CJK]);
  });

  it('waits for the read of the face files for a bounded time, and reads again after a failure', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let mode: 'silent' | 'failing' | 'answering' = 'silent';
    provideFaceReader(async () => {
      reads += 1;
      if (mode === 'silent') return new Promise<never>(() => undefined);
      if (mode === 'failing') throw new Error('the engine restarts');
      return { blocks: [], faces: TABLE_FACES };
    }, async () => FONT_DIR);
    const slow = awaitBundledFaces(50);
    await vi.advanceTimersByTimeAsync(49);
    let done: boolean | undefined;
    void slow.then((value) => { done = value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(false);
    expect(bundledFacesKnown()).toBe(false);
    forgetBundledFaces();
    mode = 'failing';
    expect(await awaitBundledFaces(50)).toBe(false);
    mode = 'answering';
    expect(await awaitBundledFaces(50)).toBe(true);
    expect(reads).toBe(3);
    expect(await awaitBundledFaces(50)).toBe(true);
    expect(reads).toBe(3);
    // With no reader the answer cannot be had.
    forgetBundledFaces();
    provideFaceReader(undefined);
    expect(await awaitBundledFaces(50)).toBe(false);
  });
});

describe('the refusal of a build whose engine refuses a character', () => {
  const refusing = (faces: string[] | undefined): TextBoxEngine => async (blocks) => ({
    blocks: blocks.map((block) => ({ refused: block.text.replace(/\s/g, '').slice(0, 2) }) as TextBlockResult),
    ...(faces ? { faces } : {}),
  });
  const build = async (faces: string[] | undefined): Promise<Uint8Array> =>
    commit(await blank(), placing(box(POLISH)), 'a.pdf', { textBoxes: refusing(faces) });

  it('names a missing face file only when the fonts folder, as the engine lists it, lacks one the text needs', async () => {
    await expect(build([])).rejects.toThrow('Page 1, Text box “Zażółć gęślą jaźń”: a font file that draws this text is missing from this installation.');
    await expect(build(TABLE_FACES.filter((name) => !facesOf(BUNDLED_FACES.sans).includes(name))))
      .rejects.toThrow('a font file that draws this text is missing from this installation.');
  }, RUN);

  it('names the characters the engine refused in every other case', async () => {
    await expect(build(TABLE_FACES)).rejects.toThrow('Page 1, Text box “Zażółć gęślą jaźń”: no font of this editor draws these characters: Z a.');
    await expect(build(undefined)).rejects.toThrow('no font of this editor draws these characters: Z a.');
  }, RUN);
});
