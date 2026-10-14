// A batch edit changes every member that takes it and names the members that
// do not; the text editor of an annotation keeps a text the store refuses.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appReducer } from '../src/renderer/state/reducer';
import { textEditorOutcome } from '../src/renderer/lib/text-box-edit';
import { MetadataTestWorker, prepareMetadataWorker } from './helpers/metadata-worker';
import { commit, importedPages } from './support/commit-cycle';
import { expectSound } from './support/saved-pdf';
import { HAS_BUNDLED_FACES } from './support/text-engine';
import { POLISH, box, foreign, opened, pagesOf } from './support/text-box-fixtures';

beforeAll(prepareMetadataWorker, 30000);
beforeEach(() => vi.stubGlobal('Worker', MetadataTestWorker));

const RUN = 120_000;

describe.skipIf(!HAS_BUNDLED_FACES)('a batch edit', () => {
  it('changes every member that takes the edit, names how many did not, and is one undo step', async () => {
    const bytes = await foreign('type3');
    const [page] = await importedPages(bytes);
    const own = box('Own text', { id: 'own' });
    const second = box(POLISH, { id: 'second', y: 0.4 });
    const state = opened([{ ...page, annotations: [...page.annotations!, own, second] }], bytes);
    const [refusing] = pagesOf(state)[0].annotations!;
    const at = { docId: 'a.pdf#0', pageId: pagesOf(state)[0].id };
    const next = appReducer(state, { type: 'RECOLOR_ANNOTATIONS', ...at, annotationIds: [refusing.id, 'own', 'second'], color: '#00ff00' });
    const [kept, a, b] = pagesOf(next)[0].annotations!;
    expect(kept).toBe(refusing);
    expect([a.color, b.color]).toEqual(['#00ff00', '#00ff00']);
    expect(next.pageUndoStack).toHaveLength(state.pageUndoStack.length + 1);
    expect(next.pageEditRefusals).toBe(state.pageEditRefusals + 1);
    expect(next.pageEditRefusalReason).toEqual({ textBox: { reason: 'font', kind: 'freetext', page: 1, words: 'Ten point text' }, notChanged: 1 });
    const undone = appReducer(next, { type: 'UNDO_PAGE_OP' });
    expect(pagesOf(undone)[0].annotations).toEqual(pagesOf(state)[0].annotations);
    await expectSound(await commit(bytes, () => pagesOf(next)), [], undefined, bytes);

    // Every member refuses: nothing changes and the notice counts them.
    const none = appReducer(state, { type: 'RECOLOR_ANNOTATIONS', ...at, annotationIds: [refusing.id, 'missing'], color: '#00ff00' });
    expect(none.workspace).toBe(state.workspace);
    expect(none.pageEditRefusalReason).toMatchObject({ notChanged: 1 });
    // One annotation: the notice is the refusal itself.
    const one = appReducer(state, { type: 'RECOLOR_ANNOTATIONS', ...at, annotationIds: [refusing.id], color: '#00ff00' });
    expect(one.pageEditRefusalReason).toEqual({ textBox: { reason: 'font', kind: 'freetext', page: 1, words: 'Ten point text' } });
  }, RUN);
});

describe('the text editor of an annotation', () => {
  it('keeps a refused text: the store refuses the update and the editor stays open', () => {
    const existing = box('Old text');
    expect(textEditorOutcome(existing, 'New \u{1F600} text', 3)).toBe('refused');
    expect(textEditorOutcome(existing, '  New text ', 3)).toBe('update');
    expect(textEditorOutcome(existing, 'Old text ', 3)).toBe('keep');
    expect(textEditorOutcome(existing, '   ', 3)).toBe('remove');
    expect(textEditorOutcome(box(''), '\u{1F600}', 3)).toBe('refused');
  });
});
