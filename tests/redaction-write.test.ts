import { describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenDocument, OpenFile } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import { assertOperationIntent } from '../src/renderer/lib/operation-intent';
import { committedDocuments } from '../src/renderer/lib/workspace-commit';
import { buildRedactionRegions, type RedactionMark } from '../src/renderer/lib/redaction';
import { groupRedactionMarks, writeRedactionMarks } from '../src/renderer/lib/redaction-write';

function fixture() {
  const file: OpenFile = { path: 'a', name: 'a.pdf', workingPath: 'a.work', buffer: [1], pageCount: 2,
    dirty: false, undoStack: [], redoStack: [] };
  const doc: OpenDocument = { ...file, id: 'a.doc', pages: [
    { id: 'second', sourceDocId: 'a', sourcePageIndex: 1, rotation: 90, width: 800, height: 600 },
    { id: 'first', sourceDocId: 'a', sourcePageIndex: 0, rotation: 0, width: 600, height: 800 },
  ] };
  const seen: AppState = { ...initialState, files: new Map([['a', file]]),
    pageDirtyPaths: ['a'], workspace: { documents: [doc] } };
  const buffer = [2];
  const afterFile = { ...file, buffer, authoredIdentity: { sourceBuffer: file.buffer!, buffer,
    pages: ['second', 'first'], documents: [{ id: doc.id, name: doc.name }] } };
  const after: AppState = { ...seen, files: new Map([['a', afterFile]]), pageDirtyPaths: [],
    workspace: { documents: committedDocuments([doc], buffer) } };
  const mark: RedactionMark = { id: 'mark', path: 'a', pageId: 'second', rotationAtDraw: 90,
    rect: { x: .1, y: .2, w: .3, h: .1 } };
  return { seen, after, file, mark };
}

describe('redaction of committed page positions', () => {
  it.each(['redact', 'save_redaction_marks'] as const)('carries a moved, rotated page through the gate for %s', async method => {
    const f = fixture();
    const box = { x: 0, y: 0, width: 600, height: 800 };
    const expected = await buildRedactionRegions(f.seen.workspace.documents, [f.mark], async () => ({ box, bakedRotate: 0 }));
    let state = f.seen;
    const geometry = vi.fn(async (_page, accepted: AppState) => {
      expect(accepted).toBe(f.after);
      return { box, bakedRotate: 90 };
    });
    const perform: PerformOperation = async (_path, _method, _params, options) => {
      assertOperationIntent(state, options!.intent!);
      expect(_params).toEqual(method === 'redact' ? { gs_path: 'gs' } : {});
      expect(geometry).not.toHaveBeenCalled();
      state = f.after;
      const params = await options!.prepareParams!(state);
      expect(params.regions).toEqual(expected.files[0].regions);
      return { output: 'a.work', publication: f.after.files.get('a')! } as Awaited<ReturnType<PerformOperation>>;
    };
    expect(await writeRedactionMarks('a', [f.mark], f.seen, method, () => state, perform, geometry, async () => 'gs')).toBe(true);
    expect(geometry).toHaveBeenCalledWith(expect.objectContaining({ id: 'second', sourcePageIndex: 0, rotation: 0 }), f.after);
  });

  it('a page edit during the capability lookup refuses before preparing or writing', async () => {
    const f = fixture(); let state = f.seen;
    const geometry = vi.fn();
    const perform: PerformOperation = async (_p, _m, _v, options) => {
      assertOperationIntent(state, options!.intent!);
      throw new Error('must not reach write');
    };
    await expect(writeRedactionMarks('a', [f.mark], f.seen, 'redact', () => state, perform, geometry, async () => {
      state = { ...state, pageUndoStack: [...state.pageUndoStack] };
      return 'gs';
    })).rejects.toThrow('document or history changed');
    expect(geometry).not.toHaveBeenCalled();
  });

  it('a replacement that removed the physical page cannot receive an old mark', async () => {
    const f = fixture();
    const after = { ...f.after, workspace: { documents: [] } };
    const perform: PerformOperation = async (_p, _m, _v, options) => {
      await options!.prepareParams!(after);
      throw new Error('must not reach write');
    };
    await expect(writeRedactionMarks('a', [f.mark], f.seen, 'save_redaction_marks', () => f.seen, perform, vi.fn(), async () => 'gs'))
      .rejects.toThrow('document or history changed');
  });

  it('groups by the current page holder, including pages imported from another file', () => {
    const f = fixture();
    const doc = { ...f.seen.workspace.documents[0], path: 'other' };
    expect(groupRedactionMarks({ ...f.seen, workspace: { documents: [doc] } }, [f.mark]))
      .toEqual([{ path: 'other', marks: [f.mark], markIds: ['mark'] }]);
  });
});
