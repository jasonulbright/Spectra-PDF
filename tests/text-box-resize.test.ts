// A text box whose original appearance the commit keeps is resized by one
// factor: a kept appearance is never stretched. A text box in a readable
// font takes the size asked and its text is drawn again.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { appReducer } from '../src/renderer/state/reducer';
import type { AppState, PageAnnotation } from '../src/renderer/state/types';
import { keptAppearanceMove, resizeKeepsAppearance, withUniformScale } from '../src/renderer/lib/imported-edit';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit, importedPages } from './support/commit-cycle';
import { expectSound } from './support/saved-pdf';
import { HAS_BUNDLED_FACES } from './support/text-engine';
import { appearances, foreign, only, opened, pagesOf } from './support/text-box-fixtures';

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const N = PDFName.of;
const RUN = 120_000;

describe.skipIf(!HAS_BUNDLED_FACES)('a resize that keeps the appearance of the original', () => {
  it('keeps the aspect ratio of the original, from the side the edit changed more', async () => {
    const bytes = await foreign('type3');
    const [a] = (await importedPages(bytes))[0].annotations!;
    expect(resizeKeepsAppearance(a)).toBe(true);
    const ratio = a.w / a.h;
    // The right edge moved more: the width leads, the left and the top edge stay.
    const wider = withUniformScale(a, { ...a, w: a.w * 2, h: a.h * 1.5, geometryDiverged: true });
    expect(wider.w).toBeCloseTo(a.w * 2, 12);
    expect(wider.h).toBeCloseTo(a.h * 2, 12);
    expect([wider.x, wider.y]).toEqual([a.x, a.y]);
    // The top edge moved: the bottom edge stays, the box stays centred across.
    const taller = withUniformScale(a, { ...a, y: a.y - a.h, h: a.h * 2, geometryDiverged: true });
    expect(taller.h).toBeCloseTo(a.h * 2, 12);
    expect(taller.w / taller.h).toBeCloseTo(ratio, 12);
    expect(taller.y + taller.h).toBeCloseTo(a.y + a.h, 12);
    expect(taller.x + taller.w / 2).toBeCloseTo(a.x + a.w / 2, 12);
    // A second resize reads its change against the box before it.
    const again = withUniformScale(wider, { ...wider, w: wider.w, h: wider.h * 0.5 });
    expect(again.w / again.h).toBeCloseTo(ratio, 12);
    expect(again.h).toBeCloseTo(wider.h * 0.5, 12);
    // A uniform change and a move pass as they are.
    const uniform = { ...a, w: a.w * 1.5, h: a.h * 1.5, geometryDiverged: true };
    expect(withUniformScale(a, uniform)).toBe(uniform);
    const moved = { ...a, x: a.x + 0.1, geometryDiverged: true };
    expect(withUniformScale(a, moved)).toBe(moved);
    expect(keptAppearanceMove(wider)).toEqual({ dx: 0, dy: 0, sx: 2, sy: 2 });
  }, RUN);

  it('is held by the store for every size edit, and a readable font is drawn again in the new box', async () => {
    const bytes = await foreign('type3');
    const state = opened(await importedPages(bytes), bytes);
    const a = only(state);
    const resize = (target: AppState, over: Partial<PageAnnotation>): AppState => {
      const now = only(target);
      return appReducer(target, {
        type: 'TRANSFORM_ANNOTATIONS', docId: 'a.pdf#0',
        edits: [{ pageId: pagesOf(target)[0].id, annotationId: now.id, x: now.x, y: now.y, w: now.w, h: now.h, ...over }],
      });
    };
    const next = resize(state, { w: a.w * 1.3, h: a.h * 1.6 });
    const sized = only(next);
    expect(sized.w / sized.h).toBeCloseTo(a.w / a.h, 12);
    expect(sized.h).toBeCloseTo(a.h * 1.6, 12);
    const output = await commit(bytes, () => pagesOf(next));
    const doc = await PDFDocument.load(output, { updateMetadata: false });
    const written = doc.getPage(0).node.lookup(N('Annots'), PDFArray).lookup(0, PDFDict);
    const rect = written.lookup(N('Rect'), PDFArray).asArray().map((value) => Number(String(value)));
    expect((rect[2] - rect[0]) / (rect[3] - rect[1])).toBeCloseTo(200 / 40, 6);
    expect(written.lookup(N('AP'), PDFDict).lookup(N('N'), PDFStream).dict.lookup(N('BBox'), PDFArray).asArray().map((value) => Number(String(value)))).toEqual([0, 0, 200, 40]);
    await expectSound(output, [], undefined, bytes);

    // A readable font: the box takes the size asked and the text is drawn again, wrapped to it.
    const times = await foreign('times', 'Ten point text that is long enough to wrap in a narrow box');
    const readable = opened(await importedPages(times), times);
    const b = only(readable);
    expect(resizeKeepsAppearance(b)).toBe(false);
    const narrow = resize(readable, { w: b.w * 0.4, h: b.h * 3 });
    expect(only(narrow).w).toBeCloseTo(b.w * 0.4, 12);
    expect(only(narrow).h).toBeCloseTo(b.h * 3, 12);
    const [redrawn] = await appearances(await commit(times, () => pagesOf(narrow)));
    expect(redrawn.lines.length).toBeGreaterThan(1);
    expect(redrawn.lines.join(' ')).toBe('Ten point text that is long enough to wrap in a narrow box');
  }, RUN);
});
