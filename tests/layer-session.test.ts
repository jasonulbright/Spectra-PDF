import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { createLayerSessions, parseLayerRead, remapLayerIndex, type Layer } from '../src/renderer/lib/layer-session';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile, OpenDocument } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import type { WorkspaceOperationResult } from '../src/renderer/lib/operation-transaction';
import { buildPdf } from '../src/renderer/lib/pdfx-build';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';
const rows = (names = ['A', 'B', 'C']): Layer[] => names.map((name, index) => ({ index, name, visible: true, locked: false, processing_step: null }));
const reply = (layers = rows()) => ({ layers, count: layers.length, complete: true, processing_step_count: 0 });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function layered(duplicateNames = false) {
  const pdf = await PDFDocument.create();
  const groups = ['A', 'B', 'C'].map(name => pdf.context.register(pdf.context.obj({ Type: 'OCG', Name: PDFString.of(duplicateNames ? 'Same' : name) })));
  for (const ref of groups) { const page = pdf.addPage(); page.node.set(PDFName.of('Resources'), pdf.context.obj({ Properties: { Group: ref } })); }
  pdf.catalog.set(PDFName.of('OCProperties'), pdf.context.obj({ OCGs: groups, D: { ON: groups, OFF: [] } })); return pdf.save();
}
async function rebuild(bytes: Uint8Array, indices = [1, 2]) {
  return buildPdf(indices.map(pageIndex => ({ sourceKey: 'A', bytes, pageIndex, rotation: 0 })), bytes, 'A');
}
async function fixture() {
  const a: OpenFile = { path: 'A', workingPath: 'workA', name: 'A', buffer: await layered(), pageCount: 3, dirty: false, undoStack: [], redoStack: [] };
  const b = { ...a, path: 'B', workingPath: 'workB' };
  let state: AppState = { ...initialState, pageDirtyPaths: [], activeFileId: 'A', files: new Map([['A', a], ['B', b]]),
    workspace: { documents: [{ ...a, id: 'doc', pages: [0, 1, 2].map(i => ({ id: `page${i}`, sourceDocId: 'A', sourcePageIndex: i, rotation: 0, width: 600, height: 800 })) } as OpenDocument] } };
  const sessions = createLayerSessions(() => state), s = sessions.get(a)!, other = sessions.get(b)!;
  const change = (next: Partial<AppState>) => { state = { ...state, ...next }; sessions.reconcile(); };
  const call = vi.fn(async () => reply()); await sessions.load(s, call); await sessions.load(other, call);
  const operation = vi.fn<PerformOperation>(async path => {
    const file = state.files.get(path)!, publication = { ...file, buffer: file.buffer!.slice() };
    change({ files: new Map(state.files).set(path, publication) }); return { output: file.workingPath, publication } as WorkspaceOperationResult;
  });
  return { a, b, s, other, sessions, call, operation, change, state: () => state,
    toggle: (index = 1, commit = async () => {}) => sessions.toggle(s, s.layers[index], s.buffer, operation, call, commit) };
}
describe('layer working-session ownership', () => {
  it('ordinary toggle pins the actual loaded revision; duplicate names are allowed', async () => {
    const f = await fixture(); await f.toggle(); expect(f.operation.mock.calls[0]).toEqual(['A', 'set_layer_visibility', { index: 1, visible: false },
      { expectedWorkingPath: 'workA', expectedBuffer: f.a.buffer }]); expect(f.s.loaded).toBe(false);
    expect(parseLayerRead(reply(rows(['Same', 'Same'])))).toHaveLength(2);
  });
  it('pending deletion re-resolves B from its page-resource identity, never its old numeric index', async () => {
    const f = await fixture(); f.change({ pageDirtyPaths: ['A'] });
    await f.toggle(1, async () => {
      const buffer = await rebuild(new Uint8Array(f.a.buffer!));
      f.change({ pageDirtyPaths: [], files: new Map(f.state().files).set('A', { ...f.a, buffer, pageCount: 2,
        authoredIdentity: { sourceBuffer: f.a.buffer, buffer, pages: ['page1', 'page2'], documents: [{ id: 'doc', name: 'A' }] } }) });
      f.call.mockResolvedValue(reply(rows(['B', 'C'])));
    });
    expect(f.s.error).toBe(''); expect(f.operation.mock.calls[0][2]).toEqual({ index: 0, visible: false });
  });
  it.each(['buffer', 'no-edge', 'new-pending', 'altered-list', 'missing-page'])('unproven change refuses: %s', async mode => {
    const f = await fixture();
    if (mode === 'buffer') f.change({ files: new Map(f.state().files).set('A', { ...f.a, buffer: f.a.buffer!.slice() }) });
    await f.toggle(1, async () => {
      const buffer = await rebuild(new Uint8Array(f.a.buffer!));
      f.change({ pageDirtyPaths: mode === 'new-pending' ? ['A'] : [], files: new Map(f.state().files).set('A', { ...f.a, buffer, pageCount: 2,
        authoredIdentity: mode === 'no-edge' ? undefined : { sourceBuffer: f.a.buffer, buffer,
          pages: mode === 'missing-page' ? ['foreign', 'page2'] : ['page1', 'page2'], documents: [] } }) });
      f.call.mockResolvedValue(reply(rows(mode === 'altered-list' ? ['Foreign', 'C'] : ['B', 'C'])));
    });
    expect(f.operation).not.toHaveBeenCalled(); expect(f.s.error).not.toBe('');
  });
  it.each([EDIT_DECLINED, null, 'fault'] as const)('refusal is retained on its owner and can retry: %s', async mode => {
    const f = await fixture();
    if (mode === 'fault') f.operation.mockRejectedValueOnce(new Error('fault')); else f.operation.mockResolvedValueOnce(mode);
    await f.toggle(); expect(f.s.layers[1].visible).toBe(true); expect(f.s.busy).toBe(false); await f.toggle(); expect(f.operation).toHaveBeenCalledTimes(2);
  });
  it('switching tabs during a gate does not retarget the old gesture', async () => {
    const f = await fixture(); await f.toggle(1, async () => { f.change({ activeFileId: 'B' }); });
    expect(f.operation.mock.calls[0][0]).toBe('A'); expect(f.other.layers[1].visible).toBe(true); expect(f.other.error).toBe('');
  });
  it.each(['read', 'error', 'save'])('close/reopen isolates late %s completions', async mode => {
    const f = await fixture(), pending = deferred<unknown>(); let run: Promise<void>;
    if (mode === 'save') { f.operation.mockImplementationOnce(() => pending.promise as ReturnType<PerformOperation>); run = f.toggle(); await Promise.resolve(); }
    else { f.s.loaded = false; run = f.sessions.load(f.s, () => pending.promise); }
    f.change({ files: new Map([['B', f.b]]) }); f.change({ files: new Map([['A', f.a], ['B', f.b]]) });
    const fresh = f.sessions.get(f.a)!; await f.sessions.load(fresh, f.call);
    if (mode === 'error') pending.reject(new Error('late')); else pending.resolve(mode === 'save' ? { publication: f.a } : reply(rows(['old'])));
    await run; expect(fresh.layers).toEqual(rows()); expect(fresh.error).toBe('');
  });
  it('a cancelled old read cannot replace a fresh read', async () => {
    const f = await fixture(), pending = deferred<unknown>(); f.s.loaded = false;
    const old = f.sessions.load(f.s, () => pending.promise); f.sessions.cancelLoad(f.s);
    await f.sessions.load(f.s, async () => reply(rows(['Fresh']))); pending.resolve(reply()); await old;
    expect(f.s.layers[0].name).toBe('Fresh');
  });
  it('an old row object cannot operate on a freshly loaded list at the same buffer', async () => {
    const f = await fixture(), old = f.s.layers[1]; f.sessions.retry(f.s); await f.sessions.load(f.s, f.call);
    await f.sessions.toggle(f.s, old, f.a.buffer, f.operation, f.call, async () => {}); expect(f.operation).not.toHaveBeenCalled();
  });
  it.each([null, {}, { layers: [] }, { ...reply(), complete: false }, { ...reply(), count: 9 },
    reply([{ ...rows()[0], visible: 'yes' } as unknown as Layer]), reply([{ ...rows()[0], index: 1 }]),
    reply([{ ...rows()[0], processing_step: {} as Layer['processing_step'] }])])('malformed reply cannot seed an editable empty list: %j', async value => {
    expect(() => parseLayerRead(value)).toThrow(); const f = await fixture(); f.sessions.retry(f.s);
    await f.sessions.load(f.s, async () => value); expect(f.s.loaded).toBe(false); expect(f.s.error).not.toBe('');
  });
});
describe('OCG resource remapping', () => {
  it('distinguishes equal-name/equal-dictionary groups by page references', async () => {
    const before = await layered(true), after = await rebuild(before);
    expect(await remapLayerIndex(before, after, 1, [[1, 0], [2, 1]])).toBe(0);
    expect(await remapLayerIndex(before, after, 2, [[1, 0], [2, 1]])).toBe(1);
  });
  it('removed and inconsistent targets refuse', async () => {
    const before = await layered(), after = await rebuild(before);
    await expect(remapLayerIndex(before, after, 0, [[1, 0], [2, 1]])).rejects.toThrow();
    await expect(remapLayerIndex(before, after, 1, [[1, 0], [1, 1]])).rejects.toThrow();
  });
});
