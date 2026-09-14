import { describe, expect, it } from 'vitest';
import { spellingCommentTarget } from '../src/renderer/lib/spelling-comment-target';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile, PageAnnotation, PageRef } from '../src/renderer/state/types';
import type { SpellIssue } from '../src/renderer/lib/spellcheck';

const file: OpenFile = { path: 'A', workingPath: 'work-A', name: 'A', buffer: new Uint8Array([1]),
  pageCount: 2, dirty: false, undoStack: [], redoStack: [] };
function note(id: string, rect: [number, number, number, number] = [0, 0, 20, 20]): PageAnnotation {
  return { id, kind: 'note', x: 0, y: 0, w: .1, h: .1, color: '#000000', note: 'helo',
    importedOriginal: { subtype: 'Text', rect, contents: 'helo', color: '#000000', hasAppearance: false } };
}
function page(id: string, annotations: PageAnnotation[]): PageRef {
  return { id, sourceDocId: 'A', sourcePageIndex: 0, rotation: 0, width: 612, height: 792, annotations };
}
function fixture(pages = [page('p1', [note('a1')]), page('p2', [note('a2')])]): AppState {
  return { ...initialState, activeFileId: 'A', files: new Map([['A', file]]),
    workspace: { documents: [{ ...file, id: 'd1', pages: [pages[0]] },
      { ...file, path: 'other', id: 'other', pages: [page('other', [note('other')])] },
      { ...file, id: 'd2', pages: pages.slice(1) }] } };
}
const issue: SpellIssue = { source: 'comments', word: 'helo', start: 0, end: 4, context: 'helo',
  page: 2, annotation: 1, subtype: 'Text', annotation_text: 'helo', annotation_rect: [0, 0, 20, 20] };

describe('spelling comment identity', () => {
  it('targets the reported physical page across partitions, never the first equal note', () => {
    expect(spellingCommentTarget(fixture(), 'A', issue)).toMatchObject({ docId: 'd2', pageId: 'p2', annotationId: 'a2' });
    expect(spellingCommentTarget(fixture(), 'A', { ...issue, page: 1 })).toMatchObject({ pageId: 'p1', annotationId: 'a1' });
  });
  it('distinguishes equal notes on one page using the reviewed raw rectangle', () => {
    const state = fixture([page('p1', []), page('p2', [note('wrong', [25, 0, 45, 20]), note('right')])]);
    expect(spellingCommentTarget(state, 'A', issue)).toMatchObject({ annotationId: 'right' });
  });
  it('refuses ambiguous identities instead of guessing from a global listing ordinal', () => {
    const state = fixture([page('p1', []), page('p2', [note('one'), note('two')])]);
    expect(spellingCommentTarget(state, 'A', issue)).toBeNull();
  });
  it.each([0, -1, 1.5, 3, NaN])('refuses invalid or missing physical page %s', n => {
    expect(spellingCommentTarget(fixture(), 'A', { ...issue, page: n })).toBeNull();
  });
  it('refuses changed text, subtype, or malformed fingerprint', () => {
    for (const patch of [{ annotation_text: 'changed' }, { subtype: 'Square' }, { annotation_rect: [NaN, 0, 20, 20] as [number, number, number, number] }]) {
      expect(spellingCommentTarget(fixture(), 'A', { ...issue, ...patch })).toBeNull();
    }
  });
});
