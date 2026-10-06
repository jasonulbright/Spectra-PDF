import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFDocument, degrees } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeWorkspaceOperation, type OperationIo, type OperationOptions } from '../src/renderer/lib/operation-transaction';
import { OP_EDIT_CLASS, type OpMethod } from '../src/renderer/lib/op-edit-class';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';
import { createAppStore } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';
import type { AppAction, AppState, OpenDocument, OpenFile } from '../src/renderer/state/types';
import { commitPageEdits } from '../src/renderer/lib/workspace-commit';
import { hasPendingPageCommit, recoverPendingPageCommit, type PageCommitEntry } from '../src/renderer/lib/page-commit-transaction';
import * as locks from '../src/renderer/lib/engine-lock';
import * as writes from '../src/renderer/lib/document-writes';
import { withFileLock, __lockedCount } from '../src/renderer/lib/engine-lock';
import { hasWorkspacePublication, serializeWorkspacePublication } from '../src/renderer/lib/workspace-publication';
import { runPageCommit } from '../src/renderer/lib/page-commit-run';
import { captureOperationIntent } from '../src/renderer/lib/operation-intent';
import { restoreHistory, type HistoryIo } from '../src/renderer/lib/disk-history';
import { withFileSave } from '../src/renderer/lib/file-save-barrier';
import { runCommitGate, setCommitGate } from '../src/renderer/lib/commit-gate';
import { engineClosures } from './helpers/engine-closures';
import { readingWith } from './helpers/published-bytes';

const __chainedCount = () => locks.__chainedCount();

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
  const original = await pdf.save();
  const disk = new Map<string, Uint8Array>([['work', original.slice()]]);
  const file: OpenFile = { path: 'source', workingPath: 'work', name: 'source', buffer: original,
    pageCount: 1, dirty: false, undoStack: [], redoStack: [] };
  const store = createAppStore({ ...initialState, activeFileId: file.path, files: new Map([[file.path, file]]) });
  const events: string[] = []; const actions: AppAction[] = []; const backups = new Map<string, Uint8Array>();
  const io: OperationIo = {
    confirm: vi.fn(async () => { events.push('confirm'); return true; }),
    commit: vi.fn(async () => { events.push('commit'); }),
    read: vi.fn(async path => { events.push('read'); return disk.get(path)!.slice(); }),
    write: vi.fn(async (path, bytes) => { events.push('write'); disk.set(path, bytes.slice()); }),
    remove: async path => { events.push('cleanup'); disk.delete(path); },
    index: vi.fn(readingWith(async bytes => { events.push('count'); return (await PDFDocument.load(bytes)).getPageCount(); })),
    track: vi.fn(async (_method, params, run) => {
      expect(params.file).toBe('work'); expect(params.output).toBe('work'); events.push('track');
      try { const result = await run(); events.push('done'); return result; }
      catch (error) { events.push('error'); throw error; }
    }),
    callStaged: vi.fn(async (_method, params) => {
      events.push('engine');
      expect(params.file).not.toBe('work'); expect(params.output).toBe(params.file);
      expect(disk.get('work')).toEqual(original);
      expect(disk.get(params.file as string)).toEqual(original);
      const changed = await PDFDocument.load(disk.get(params.file as string)!);
      changed.getPage(0).setRotation(degrees(90));
      disk.set(params.output as string, await changed.save());
      return { output: params.output, pages_rotated: 1, warnings: ['keep me'], incremental: true, refused: ['one field'] };
    }),
    transaction: {
      publish: vi.fn(async (id, [entry]) => {
        events.push('publish');
        if (hash(disk.get('work')!) !== entry.expectedWorkingSha256
            || hash(disk.get(entry.stagedPath)!) !== entry.expectedStagedSha256) throw new Error('revision mismatch');
        const prior = disk.get('work')!.slice(); backups.set(id, prior); disk.set(`backup-${id}`, prior);
        disk.set('work', disk.get(entry.stagedPath)!.slice());
        return { status: 'committed', snapshots: [`backup-${id}`], detail: '' };
      }),
      abort: vi.fn(async id => { events.push('abort'); if (backups.has(id)) disk.set('work', backups.get(id)!.slice());
        return { status: 'rolledBack', snapshots: [], detail: '' }; }),
      acknowledge: vi.fn(async () => { events.push('ack'); }),
    },
  };
  const dispatch = (action: AppAction) => { actions.push(action); store.dispatch(action); };
  const run = (method: OpMethod = 'rotate', params: Record<string, unknown> = { pages: 'all', angle: 90 }) =>
    executeWorkspaceOperation('source', method, params, store.getState, dispatch, io);
  const unchanged = () => { expect(disk.get('work')).toEqual(original); expect(store.getState().files.get('source')).toBe(file); expect(actions).toEqual([]); };
  return { io, run, disk, original, store, file, actions, events, unchanged };
}

describe('whole-file operation publication', () => {
  it('derives parameters after the gate and refuses an edit while derivation awaits', async () => {
    const f = await fixture();
    let committed = false;
    f.io.commit = async () => { committed = true; };
    await expect(executeWorkspaceOperation('source', 'redact', {}, f.store.getState,
      f.store.dispatch, f.io, {
        prepareParams: async accepted => {
          expect(committed).toBe(true);
          expect(accepted.files.get('source')!.buffer).toBe(f.file.buffer);
          await Promise.resolve();
          f.store.dispatch({ type: 'REFRESH_BUFFER', path: 'source', buffer: f.original.slice(), pageCount: 1, documents: [] });
          return { regions: [{ page: 1, rect: [0, 0, 10, 10] }] };
        },
      })).rejects.toThrow('document or history changed');
    expect(f.io.callStaged).not.toHaveBeenCalled();
    expect(f.io.transaction.publish).not.toHaveBeenCalled();
    expect(f.disk.get('work')).toEqual(f.original);
  });

  it('passes the accepted derived parameters to the engine', async () => {
    const f = await fixture();
    const regions = [{ page: 1, rect: [1, 2, 3, 4] }];
    await executeWorkspaceOperation('source', 'redact', { gs_path: 'gs' }, f.store.getState,
      f.store.dispatch, f.io, { prepareParams: async () => ({ regions }) });
    expect(f.io.callStaged).toHaveBeenCalledWith('redact', expect.objectContaining({ regions, gs_path: 'gs' }));
  });
  it.each(['reopen', 'revision', 'pending'])('gesture captured before prerequisites refuses %s before consent or staging', async boundary => {
    const f = await fixture();
    const intent = captureOperationIntent(f.store.getState(), f.file);
    if (boundary === 'reopen') f.store.dispatch({ type: 'OPEN_FILE', path: 'source', workingPath: 'new-work', name: 'source', buffer: f.original.slice(), pageCount: 1 });
    if (boundary === 'revision') f.store.dispatch({ type: 'REFRESH_BUFFER', path: 'source', buffer: f.original.slice(), pageCount: 1, documents: [] });
    const read = () => boundary === 'pending' ? { ...f.store.getState(), pageUndoStack: [] } : f.store.getState();
    await expect(executeWorkspaceOperation('source', 'rotate', { pages: 'all', angle: 90 }, read,
      f.store.dispatch, f.io, { intent })).rejects.toThrow();
    expect(f.io.confirm).not.toHaveBeenCalled(); expect(f.io.write).not.toHaveBeenCalled();
    expect(f.io.callStaged).not.toHaveBeenCalled(); expect(f.disk.get('work')).toEqual(f.original);
  });
  it.each(['consent', 'gate', 'queue', 'engine'])('owner cancellation at %s refuses publication', async boundary => {
    const f = await fixture(); let active = true;
    const intent = captureOperationIntent(f.store.getState(), f.file);
    if (boundary === 'consent') f.io.confirm = async () => { active = false; return true; };
    if (boundary === 'gate') f.io.commit = async () => { active = false; };
    if (boundary === 'queue') f.io.track = async (_m, _p, run) => { active = false; return run(); };
    if (boundary === 'engine') { const original = f.io.callStaged; f.io.callStaged = async (...args) => { const result = await original(...args); active = false; return result; }; }
    await expect(executeWorkspaceOperation('source', 'rotate', { pages: 'all', angle: 90 }, f.store.getState,
      f.store.dispatch, f.io, { intent, assertActive: () => { if (!active) throw new Error('owner abandoned'); } })).rejects.toThrow();
    expect(f.io.transaction.publish).not.toHaveBeenCalled(); expect(f.disk.get('work')).toEqual(f.original);
  });
  it('a fresh buffer without authored gate evidence cannot become the gesture source', async () => {
    const f = await fixture(); const intent = captureOperationIntent(f.store.getState(), f.file);
    f.io.commit = async () => { f.store.dispatch({ type: 'REFRESH_BUFFER', path: 'source', buffer: f.original.slice(), pageCount: 1, documents: [] }); };
    await expect(executeWorkspaceOperation('source', 'rotate', { pages: 'all', angle: 90 }, f.store.getState,
      f.store.dispatch, f.io, { intent })).rejects.toThrow();
    expect(f.io.callStaged).not.toHaveBeenCalled(); expect(f.disk.get('work')).toEqual(f.original);
  });
  it('the actual authored gate transition is accepted after consent and re-confirmed before writing', async () => {
    const f = await fixture(); const intent = captureOperationIntent(f.store.getState(), f.file);
    const buffer = f.original.slice();
    const after = { ...f.file, buffer, authoredIdentity: { sourceBuffer: f.file.buffer!, buffer, pages: [], documents: [] } };
    let committed = false;
    const read = () => committed ? { ...f.store.getState(), files: new Map([['source', after]]) } : f.store.getState();
    // Keep the production transaction/publication machinery. The gate's state
    // publication uses the same source/result identity carried by page commits.
    f.io.commit = async () => { f.events.push('commit'); committed = true; };
    const dispatch = (action: AppAction) => { committed = false; f.store.dispatch(action); };
    const result = await executeWorkspaceOperation('source', 'rotate', { pages: 'all', angle: 90 }, read,
      dispatch, f.io, { intent });
    expect(result && typeof result === 'object' && result.publication.buffer).toBe(f.store.getState().files.get('source')!.buffer);
    expect(f.events.slice(0, 3)).toEqual(['confirm', 'commit', 'confirm']);
    expect(f.io.callStaged).toHaveBeenCalledTimes(1);
  });
  it.each(['before', 'gate', 'pending'])('revision-derived parameters refuse drift at %s', async boundary => {
    const f = await fixture();
    const updated = () => f.store.dispatch({ type: 'REFRESH_BUFFER', path: 'source', buffer: f.original.slice(), pageCount: 1, documents: [] });
    if (boundary === 'before') updated();
    if (boundary === 'gate') f.io.commit = async () => { updated(); };
    const read = () => boundary === 'pending' ? { ...f.store.getState(), pageDirtyPaths: ['source'] } : f.store.getState();
    await expect(executeWorkspaceOperation('source', 'set_threads', { threads: [] }, read, f.store.dispatch, f.io,
      { expectedBuffer: f.file.buffer!, expectedWorkingPath: 'work' })).rejects.toThrow();
    expect(f.disk.get('work')).toEqual(f.original); expect(f.io.callStaged).not.toHaveBeenCalled();
    expect(f.store.getState().files.get('source')!.undoStack).toEqual([]);
  });
  it.each(['second throws', 'second report', 'final read', 'control'])('a compound edit stages every step before one publication: %s', async mode => {
    const f = await fixture(); let calls = 0; const paths: string[] = [];
    f.io.callStaged = async (_m, params) => {
      calls++; paths.push(String(params.file));
      expect(f.disk.get('work')).toEqual(f.original);
      const pdf = await PDFDocument.load(f.disk.get(String(params.file))!);
      pdf.getPage(0).setRotation(degrees(pdf.getPage(0).getRotation().angle + 90));
      f.disk.set(String(params.output), await pdf.save());
      if (calls === 2 && mode === 'second throws') throw new Error('second refused');
      if (calls === 2 && mode === 'second report') return {};
      return { output: params.output };
    };
    if (mode === 'final read') f.io.read = async () => { throw new Error('final read'); };
    const run = executeWorkspaceOperation('source', 'set_link_target', {}, f.store.getState, f.store.dispatch, f.io,
      { following: [{ method: 'set_link_appearance', params: {} }] });
    if (mode === 'control') {
      await run; const now = f.store.getState().files.get('source')!;
      expect(now.undoStack).toHaveLength(1); expect(f.disk.get(now.undoStack[0])).toEqual(f.original);
      expect(now.buffer).toEqual(f.disk.get('work'));
      expect((await PDFDocument.load(f.disk.get('work')!)).getPage(0).getRotation().angle).toBe(180);
    } else { await expect(run).rejects.toThrow(); f.unchanged(); }
    expect(calls).toBe(2); expect(paths[0]).toBe(paths[1]); expect(paths[0]).not.toBe('work');
  });
  it('freezes later-step parameters before any await', async () => {
    const f = await fixture(); const seen: unknown[] = [];
    f.io.callStaged = async (_m, params) => { seen.push(params.appearance); return { output: params.output }; };
    const appearance = { width: 2 };
    const run = executeWorkspaceOperation('source', 'set_link_target', {}, f.store.getState, f.store.dispatch, f.io,
      { following: [{ method: 'set_link_appearance', params: { appearance } }] });
    appearance.width = 999;
    await run; expect(seen).toEqual([undefined, { width: 2 }]);
  });
  it('App supplies fresh state, consent, private transport, and full-publication queue tracking', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const callback = app.slice(app.indexOf('const performOperation ='), app.indexOf('const handleRedactFile ='));
    for (const part of ['sequenceEditClass(method, options?.following?.map(step => step.method))', 'executeWorkspaceOperation(filePath, method, params, readState, dispatch',
      'confirmEditOfSignedDoc(path, working, editClass)', 'commit: (paths, before) => commitRef.current(paths, before)', 'callStaged: callRaw', 'trackOperation', 'trackInteractive']) expect(callback).toContain(part);
    for (const old of ['file.snapshot(', 'await call(', 'reloadFile(', "dispatch({ type: 'UPDATE_FILE'"]) expect(callback).not.toContain(old);
  });
  it.each(['read', 'count', 'stage', 'engine', 'publish'])('%s failure preserves disk/buffer/history and never reports done', async where => {
    const f = await fixture(); const fail = async () => { throw new Error(`injected ${where}`); };
    if (where === 'read') f.io.read = fail;
    if (where === 'count') f.io.index = readingWith(fail);
    if (where === 'stage') f.io.write = fail;
    if (where === 'publish') f.io.transaction.publish = fail;
    if (where === 'engine') { const call = f.io.callStaged; f.io.callStaged = async (m, p) => { await call(m, p); return fail(); }; }
    await expect(f.run()).rejects.toThrow(`injected ${where}`);
    f.unchanged(); expect(f.events).not.toContain('done'); expect(f.events).toContain('error');
    expect([...f.disk.keys()].some(p => p.includes('.operation-'))).toBe(false);
    expect(__chainedCount()).toBe(0); expect(__lockedCount()).toBe(0);
    expect(hasWorkspacePublication()).toBe(false); expect(writes.__documentWriteCount()).toBe(0);
  });
  it.each([null, [], 'done', {}, { output: 'foreign' }])('refuses an invalid report %j', async report => {
    const f = await fixture(); f.io.callStaged = async () => report;
    await expect(f.run()).rejects.toThrow('could not be verified'); f.unchanged();
  });
  it.each([0, -1, 1.5, NaN, Infinity])('refuses an invalid final page count %s', async count => {
    const f = await fixture(); f.io.index = readingWith(async () => count);
    await expect(f.run()).rejects.toThrow('could not be verified'); f.unchanged();
  });
  it('keeps operation reports, native original snapshot, and one final publication', async () => {
    const f = await fixture();
    expect(await f.run()).toEqual({ output: 'work', pages_rotated: 1, warnings: ['keep me'], incremental: true, refused: ['one field'],
      publication: f.store.getState().files.get('source') });
    const now = f.store.getState().files.get('source')!;
    expect(now.buffer).toEqual(f.disk.get('work')); expect(now.undoStack).toHaveLength(1);
    expect(f.disk.get(now.undoStack[0])).toEqual(f.original);
    expect((await PDFDocument.load(f.disk.get('work')!)).getPage(0).getRotation().angle).toBe(90);
    expect(f.actions.map(a => a.type)).toEqual(['UPDATE_FILE']);
    expect(f.events.indexOf('count')).toBeLessThan(f.events.indexOf('publish'));
    expect(f.events.indexOf('done')).toBeGreaterThan(f.events.indexOf('ack'));
  });
  it('allows valid page-count changes and protects against caller output/file overrides', async () => {
    const f = await fixture(); f.io.callStaged = async (_m, p) => {
      expect(p.file).not.toBe('evil'); expect(p.output).toBe(p.file);
      const pdf = await PDFDocument.load(f.disk.get(p.file as string)!); pdf.addPage();
      f.disk.set(p.output as string, await pdf.save()); return { output: p.output };
    };
    await f.run('delete', { file: 'evil', output: 'evil' });
    expect(f.store.getState().files.get('source')!.pageCount).toBe(2);
  });
  it('all classed methods use the same publication protocol (not a per-call-site migration)', async () => {
    for (const method of Object.keys(OP_EDIT_CLASS) as OpMethod[]) {
      const f = await fixture(); await f.run(method);
      expect(f.io.callStaged).toHaveBeenCalledWith(method, expect.any(Object));
      expect(f.actions).toHaveLength(1);
    }
  });
  it('declines before the gate or queue, and skips missing/import-only files', async () => {
    const f = await fixture(); f.io.confirm = async () => false;
    expect(await f.run()).toBe(EDIT_DECLINED); expect(f.io.commit).not.toHaveBeenCalled(); expect(f.io.track).not.toHaveBeenCalled(); f.unchanged();
    f.store.getState().files.clear(); expect(await f.run()).toBeNull();
    f.store.getState().files.set('source', { ...f.file, importOnly: true }); expect(await f.run()).toBeNull();
  });
  it('gate failure refuses before writing a stage', async () => {
    const f = await fixture(); f.io.commit = async () => { throw new Error('gate'); };
    await expect(f.run()).rejects.toThrow('gate'); f.unchanged(); expect(f.io.write).not.toHaveBeenCalled();
  });
  it('rechecks consent for committed bytes and freezes requested parameters', async () => {
    const f = await fixture(); const params = { angle: 90, pages: [1] };
    f.io.commit = async () => { params.angle = 180; params.pages.push(2);
      f.store.dispatch({ type: 'UPDATE_FILE', path: 'source', buffer: f.original.slice(), pageCount: 1, snapshotPath: 'page-snapshot', documents: [] }); };
    await f.run('rotate', params);
    expect(f.io.confirm).toHaveBeenCalledTimes(2);
    expect(f.io.callStaged).toHaveBeenCalledWith('rotate', expect.objectContaining({ angle: 90, pages: [1] }));
  });
  it.each(['consent', 'engine', 'publish'])('rejects state drift during %s', async when => {
    const f = await fixture(); const change = () => f.store.dispatch({ type: 'MARK_SAVED', path: 'source' });
    if (when === 'consent') f.io.confirm = async () => { change(); return true; };
    if (when === 'engine') { const call = f.io.callStaged; f.io.callStaged = async (m, p) => { const r = await call(m, p); change(); return r; }; }
    if (when === 'publish') { const publish = f.io.transaction.publish; f.io.transaction.publish = async (id, entries) => { const r = await publish(id, entries); change(); return r; }; }
    await expect(f.run()).rejects.toThrow('changed'); expect(f.disk.get('work')).toEqual(f.original); expect(f.actions).toEqual([]);
  });
  it('rejects a revision changed while waiting for another working-file writer', async () => {
    const f = await fixture(); let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    const other = withFileLock(['work'], async () => { await wait; f.store.dispatch({ type: 'MARK_SAVED', path: 'source' }); });
    const run = f.run(); await vi.waitFor(() => expect(f.io.commit).toHaveBeenCalled());
    release(); await other; await expect(run).rejects.toThrow('changed'); expect(f.io.write).not.toHaveBeenCalled();
  });
  it.each(['lost', 'malformed', 'ignored dispatch'])('recovers native publication after %s', async mode => {
    const f = await fixture(); const publish = f.io.transaction.publish;
    f.io.transaction.publish = async (id, entries) => { const r = await publish(id, entries); if (mode === 'lost') throw new Error('lost'); return mode === 'malformed' ? {} : r; };
    const run = mode === 'ignored dispatch' ? executeWorkspaceOperation('source', 'rotate', {}, f.store.getState, () => {}, f.io) : f.run();
    await expect(run).rejects.toThrow(); f.unchanged(); expect(f.events).toContain('abort'); expect(f.events).not.toContain('done');
  });
  it('retains recovery on lost abort, then permits a retry after confirmed rollback', async () => {
    const f = await fixture(); const publish = f.io.transaction.publish; const abort = f.io.transaction.abort;
    f.io.transaction.publish = async (id, entries) => { await publish(id, entries); throw new Error('lost'); };
    f.io.transaction.abort = async () => { throw new Error('lost abort'); };
    try {
      await expect(f.run()).rejects.toThrow('needs recovery'); expect(hasPendingPageCommit()).toBe(true);
      await expect(f.run()).rejects.toThrow('needs recovery'); expect(f.io.callStaged).toHaveBeenCalledTimes(1);
    } finally { f.io.transaction.abort = abort; await recoverPendingPageCommit(); }
    f.unchanged(); f.io.transaction.publish = publish; await f.run(); expect(f.actions).toHaveLength(1);
  });
  it('lost acknowledgement keeps published history and retires the stage', async () => {
    const f = await fixture(); f.io.transaction.acknowledge = async () => { throw new Error('lost ack'); };
    await f.run(); expect(f.actions).toHaveLength(1); expect(f.events).not.toContain('abort');
    expect([...f.disk.keys()].some(p => p.includes('.operation-'))).toBe(false);
    f.io.transaction.acknowledge = async () => {}; await recoverPendingPageCommit();
  });
  it('refuses external working-byte drift without erasing that external edit', async () => {
    const f = await fixture(); const external = new Uint8Array([7, 8, 9]); const call = f.io.callStaged;
    f.io.callStaged = async (m, p) => { const r = await call(m, p); f.disk.set('work', external); return r; };
    await expect(f.run()).rejects.toThrow('revision mismatch'); expect(f.disk.get('work')).toEqual(external); expect(f.actions).toEqual([]);
  });
});

describe('lock order between a rewrite and a page commit', () => {
  it('a rewrite queued for the lane and a commit of its working path both settle', async () => {
    const f = await fixture();
    let release!: () => void;
    const blocker = serializeWorkspacePublication(() => new Promise<void>(r => { release = r; }));
    const rewrite = f.run();
    // The rewrite claims its write chain before it queues for the lane, and
    // holds no file lock there.
    for (let i = 0; i < 500 && __chainedCount() === 0; i++) await Promise.resolve();
    expect(__chainedCount()).toBe(1);
    expect(__lockedCount()).toBe(0);
    const order: string[] = [];
    const commit = runPageCommit<string>({
      read: () => ({ ...f.store.getState(), pageDirtyPaths: ['source'] }),
      recover: async () => {},
      settle: async () => {},
      clean: 'clean',
      commit: async () => { order.push(`commit after ${f.events.filter(e => e === 'publish').length} publish`); return 'committed'; },
    });
    release();
    await blocker;
    await rewrite;
    await expect(commit).resolves.toEqual({ value: 'committed' });
    // The commit claimed the working path before the rewrite's engine step
    // asked for it shared, so it lands first; the rewrite's fence still holds
    // because this commit's state is not the store's.
    expect(order).toEqual(['commit after 0 publish']);
    expect(__lockedCount()).toBe(0);
    expect(__chainedCount()).toBe(0);
  });
});

// Two documents in one window. Each engine step of a document waits for that
// document's hold, so a test decides when a long rewrite's engine step ends.
function twoDocuments() {
  const disk = new Map<string, Uint8Array>([['work-A', new Uint8Array([1])], ['work-B', new Uint8Array([1])]]);
  const open = (path: string): OpenFile => ({ path, workingPath: `work-${path}`, name: path,
    buffer: new Uint8Array([1]), pageCount: 1, dirty: false, undoStack: [], redoStack: [] });
  const store = createAppStore({ ...initialState, activeFileId: 'A', files: new Map([['A', open('A')], ['B', open('B')]]) });
  const events: string[] = [];
  const holds = new Map<string, Promise<void>>();
  let view: ((state: AppState) => AppState) | null = null;
  const read = () => (view ? view(store.getState()) : store.getState());
  const transaction = {
    publish: async (id: string, entries: PageCommitEntry[]) => {
      const [entry] = entries;
      if (hash(disk.get(entry.workingPath)!) !== entry.expectedWorkingSha256
          || hash(disk.get(entry.stagedPath)!) !== entry.expectedStagedSha256) throw new Error('revision mismatch');
      events.push(`publish ${entry.workingPath}`);
      disk.set(`backup-${id}`, disk.get(entry.workingPath)!.slice());
      disk.set(entry.workingPath, disk.get(entry.stagedPath)!.slice());
      return { status: 'committed', snapshots: [`backup-${id}`], detail: '' };
    },
    abort: async () => ({ status: 'rolledBack', snapshots: [], detail: '' }),
    acknowledge: async () => {},
  };
  const step = async (method: string, params: Record<string, unknown>) => {
    const stage = String(params.file);
    const doc = stage.slice('work-'.length, 'work-'.length + 1);
    events.push(`engine ${doc} ${method}`);
    await holds.get(doc);
    events.push(`engine ${doc} done`);
    disk.set(stage, new Uint8Array([...disk.get(stage)!, 2]));
    return { output: params.output };
  };
  const io: OperationIo = {
    confirm: async () => true,
    commit: async () => {},
    read: async path => disk.get(path)!.slice(),
    write: async (path, bytes) => { disk.set(path, bytes.slice()); },
    remove: async path => { disk.delete(path); },
    index: readingWith(async bytes => bytes.length),
    track: async (_method, _params, run) => run(),
    callStaged: step,
    transaction,
  };
  const history: HistoryIo = { read: io.read, write: io.write, remove: io.remove, index: io.index, transaction };
  const hold = (doc: string) => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    holds.set(doc, held);
    return () => { if (holds.get(doc) === held) holds.delete(doc); release(); };
  };
  const rewrite = (doc: string, options: OperationOptions = {}) =>
    executeWorkspaceOperation(doc, 'rotate', { angle: 90 }, read, store.dispatch, io, options);
  // The production `call` and `callLocked`, with the real locks and gate.
  const sent: string[] = [];
  const { call, callLocked } = engineClosures({
    ...locks, ...writes, isTrackableMethod: (method: string) => method !== 'get_page_count',
    beginInteractive: () => () => {}, runCommitGate,
    restoreLostCredentials: async () => {},
    track: async (_m: string, _p: unknown, run: () => Promise<unknown>) => run(),
    rawCall: async (method: string, params: Record<string, unknown>) => {
      const bytes = disk.get(String(params.file));
      sent.push(`${method} ${String(params.file)} [${bytes ? Array.from(bytes).join(',') : ''}]`);
      return {};
    },
  });
  return { disk, store, events, sent, io, history, hold, rewrite, read, step, call, callLocked,
    setView: (next: ((state: AppState) => AppState) | null) => { view = next; } };
}

/** One macrotask: every microtask a runnable waiter needs has run. */
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await turn();
  expect(check()).toBe(true);
}
function commitOf(w: ReturnType<typeof twoDocuments>, label: string) {
  return runPageCommit<string>({
    read: () => ({ ...w.store.getState(), pageDirtyPaths: ['A'] }),
    recover: async () => {}, settle: async () => {}, clean: 'clean',
    commit: async () => { w.events.push(label); return 'committed'; },
  });
}

describe('a staged rewrite runs its engine step outside the publication lane', () => {
  afterEach(() => setCommitGate(null));

  it('another document publishes, and a gated call on it runs, while the engine step runs', async () => {
    const w = twoDocuments();
    const release = w.hold('A');
    try {
      const long = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      const other = w.rewrite('B');
      await until(() => w.events.includes('publish work-B'));
      await other;
      const call = w.call('compress', { file: 'work-B', output: 'work-B' });
      await until(() => w.sent.length === 1);
      await call;
      expect(w.events).toEqual(['engine A rotate', 'engine B rotate', 'engine B done', 'publish work-B']);
      expect(w.sent).toEqual(['compress work-B [1,2]']);
      release();
      await long;
      expect(w.events.slice(-2)).toEqual(['engine A done', 'publish work-A']);
    } finally { release(); }
    expect(__lockedCount()).toBe(0);
  });

  it('a read of the rewritten document returns the bytes the user sees until publication', async () => {
    const w = twoDocuments();
    const release = w.hold('A');
    try {
      const long = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      const reads = [w.callLocked('get_page_count', { file: 'work-A' }), w.call('get_page_count', { file: 'work-A' })];
      await until(() => w.sent.length === 2);
      await Promise.all(reads);
      expect(w.sent).toEqual(['get_page_count work-A [1]', 'get_page_count work-A [1]']);
      expect(w.store.getState().files.get('A')!.buffer).toEqual(new Uint8Array([1]));
      release();
      await long;
      await w.callLocked('get_page_count', { file: 'work-A' });
      expect(w.sent.at(-1)).toBe('get_page_count work-A [1,2]');
      expect(w.store.getState().files.get('A')!.buffer).toEqual(new Uint8Array([1, 2]));
    } finally { release(); }
  });

  it('a save, a disk undo and a gated write of the document wait for the publication, in issue order', async () => {
    const w = twoDocuments();
    const release = w.hold('A');
    try {
      const long = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      const save = withFileSave('work-A', 'dest-A', async () => {
        w.events.push(`save [${Array.from(w.disk.get('work-A')!).join(',')}]`);
      });
      await turn();
      const undo = restoreHistory('undo', w.read, w.store.dispatch, w.history);
      await turn();
      const write = w.call('compress', { file: 'work-A', output: 'work-A' }).then(() => { w.events.push('compress'); });
      await turn();
      // A reader still runs while the three writers wait.
      const reader = w.callLocked('get_page_count', { file: 'work-A' });
      await until(() => w.sent.length === 1);
      await reader;
      expect(w.sent).toEqual(['get_page_count work-A [1]']);
      expect(w.events).toEqual(['engine A rotate']);
      release();
      await Promise.all([long, save, undo, write]);
      expect(w.events).toEqual(['engine A rotate', 'engine A done', 'publish work-A', 'save [1,2]', 'publish work-A', 'compress']);
      expect(w.sent.at(-1)).toBe('compress work-A [1]');
    } finally { release(); }
    expect(__lockedCount()).toBe(0);
  });

  it('a second rewrite of the path, asked for during the first one, queues and applies to its result', async () => {
    const w = twoDocuments();
    w.io.commit = (paths, before) => runCommitGate(paths, before);
    const confirms: string[] = [];
    w.io.confirm = async () => { confirms.push(`confirm after ${w.events.filter(e => e === 'publish work-A').length}`); return true; };
    const release = w.hold('A');
    try {
      const first = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      // Unheld, the second engine step would answer before the first.
      const second = w.rewrite('A');
      await turn();
      expect(w.events).toEqual(['engine A rotate']);
      release();
      await Promise.all([first, second]);
      expect(w.events).toEqual(['engine A rotate', 'engine A done', 'publish work-A',
        'engine A rotate', 'engine A done', 'publish work-A']);
      expect(w.disk.get('work-A')).toEqual(new Uint8Array([1, 2, 2]));
      expect(w.store.getState().files.get('A')!.undoStack).toHaveLength(2);
      // Consent is asked again for the bytes the second write now applies to.
      expect(confirms).toEqual(['confirm after 0', 'confirm after 0', 'confirm after 1']);
    } finally { release(); }
    expect(locks.__chainedCount()).toBe(0);
  });

  it('two rewrites of the path asked for in one turn both publish, in issue order', async () => {
    const w = twoDocuments();
    w.io.commit = (paths, before) => runCommitGate(paths, before);
    let confirms = 0;
    w.io.confirm = async () => { confirms++; return true; };
    const release = w.hold('A');
    try {
      const first = w.rewrite('A');
      const second = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      await turn();
      expect(w.events).toEqual(['engine A rotate']);
      release();
      await Promise.all([first, second]);
      expect(w.events.filter(e => e === 'publish work-A')).toHaveLength(2);
      expect(w.disk.get('work-A')).toEqual(new Uint8Array([1, 2, 2]));
      expect(confirms).toBe(3);
    } finally { release(); }
  });

  it('a gated reader asked for during a rewrite reads the rewritten bytes; a reader that runs no gate reads the old ones', async () => {
    const w = twoDocuments();
    const release = w.hold('A');
    try {
      const long = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      // A user operation whose output leaves the workspace (print, export).
      const gated = w.call('compress', { file: 'work-A', output: 'out.pdf' });
      const background = w.callLocked('get_page_count', { file: 'work-A' });
      await until(() => w.sent.length === 1);
      await background;
      expect(w.sent).toEqual(['get_page_count work-A [1]']);
      release();
      await Promise.all([long, gated]);
      expect(w.sent).toEqual(['get_page_count work-A [1]', 'compress work-A [1,2]']);
    } finally { release(); }
  });

  it('a gated reader asked for in the same turn as a rewrite reads the rewritten bytes', async () => {
    const w = twoDocuments();
    w.io.commit = (paths, before) => runCommitGate(paths, before);
    const release = w.hold('A');
    try {
      const long = w.rewrite('A');
      // Before the rewrite has run its own consent prompt or its own gate.
      const gated = w.call('compress', { file: 'work-A', output: 'out.pdf' });
      await until(() => w.events.includes('engine A rotate'));
      await turn();
      expect(w.sent).toEqual([]);
      release();
      await Promise.all([long, gated]);
      expect(w.sent).toEqual(['compress work-A [1,2]']);
    } finally { release(); }
  });

  it('page history of another document recorded during a rewrite refuses its publication', async () => {
    const w = twoDocuments();
    const release = w.hold('A');
    try {
      const long = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      // A page edit of B undone: nothing is dirty, and a redo entry exists.
      w.setView(state => ({ ...state, pageRedoStack: [{ documents: [], dirtyPaths: ['B'], action: { type: 'NOOP' } } as never] }));
      release();
      await expect(long).rejects.toThrow(/changed/);
      expect(w.events).not.toContain('publish work-A');
      expect(w.disk.get('work-A')).toEqual(new Uint8Array([1]));
    } finally { release(); w.setView(null); }
  });

  it('a commit of a dirty document does not wait for a long rewrite of another one', async () => {
    const w = twoDocuments();
    const release = w.hold('B');
    try {
      const long = w.rewrite('B');
      await until(() => w.events.includes('engine B rotate'));
      const commit = commitOf(w, 'commit A');
      await until(() => w.events.includes('commit A'));
      await expect(commit).resolves.toEqual({ value: 'committed' });
      expect(w.events).toEqual(['engine B rotate', 'commit A']);
      release();
      await long;
    } finally { release(); }
  });

  it('a path-scoped gate waits for a rewrite that waits for its exclusive lock, and only for that path', async () => {
    const w = twoDocuments();
    const releaseEngine = w.hold('A');
    let releaseReader: () => void = () => {};
    try {
      const long = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      // A reader that holds the path when the engine step ends keeps the
      // rewrite from its exclusive lock.
      const reader = withFileLock([{ key: 'work-A', mode: 'shared' }], () => new Promise<void>(r => { releaseReader = r; }));
      releaseEngine();
      await until(() => w.events.includes('engine A done'));
      await turn();
      const gates: string[] = [];
      const gateA = runCommitGate(['work-A']).then(() => {
        gates.push(`A after ${w.events.includes('publish work-A') ? 'publish' : 'nothing'}`);
      });
      await runCommitGate(['work-B']);
      gates.push('B');
      await turn();
      expect(gates).toEqual(['B']);
      expect(w.events).not.toContain('publish work-A');
      releaseReader();
      await reader;
      await Promise.all([long, gateA]);
      expect(gates).toEqual(['B', 'A after publish']);
    } finally { releaseEngine(); releaseReader(); }
  });

  it('a rewrite survives a page edit of another document committed during its engine steps', async () => {
    const w = twoDocuments();
    const releaseFirst = w.hold('A');
    let releaseSecond: () => void = () => {};
    try {
      const long = w.rewrite('A', { following: [{ method: 'rotate', params: { angle: 90 } }] });
      await until(() => w.events.includes('engine A rotate'));
      // A page edit of B, pending while the first step ends and the second runs.
      w.setView(state => ({ ...state, pageDirtyPaths: ['B'] }));
      releaseSecond = w.hold('A');
      releaseFirst();
      await until(() => w.events.filter(e => e === 'engine A rotate').length === 2);
      // Committed before the publication: B has new bytes, nothing is pending.
      const committedB = { ...w.store.getState().files.get('B')!, buffer: new Uint8Array([9]) };
      w.setView(state => ({ ...state, files: new Map([...state.files, ['B', committedB]]), pageDirtyPaths: [] }));
      releaseSecond();
      await long;
      expect(w.events).toEqual(['engine A rotate', 'engine A done', 'engine A rotate', 'engine A done', 'publish work-A']);
      expect(w.store.getState().files.get('A')!.buffer).toEqual(new Uint8Array([1, 2, 2]));
    } finally { releaseFirst(); releaseSecond(); w.setView(null); }
  });

  it('a page edit of another document pending at the publication is committed first, then the rewrite publishes', async () => {
    const w = twoDocuments();
    const commits: string[] = [];
    // The page commit: what it commits leaves the tier.
    setCommitGate(async () => { commits.push('commit B'); w.setView(null); });
    const release = w.hold('A');
    try {
      const long = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      w.setView(state => ({ ...state, pageDirtyPaths: ['B'] }));
      release();
      await long;
      expect(commits).toEqual(['commit B']);
      expect(w.events).toEqual(['engine A rotate', 'engine A done', 'publish work-A']);
      expect(w.disk.get('work-A')).toEqual(new Uint8Array([1, 2]));
    } finally { release(); w.setView(null); }
  });

  it('a page edit that cannot be committed refuses the rewrite; one on the rewritten file refuses before the next step', async () => {
    const stuck = twoDocuments();
    setCommitGate(async () => { throw new Error('commit refused'); });
    let release = stuck.hold('A');
    try {
      const long = stuck.rewrite('A');
      await until(() => stuck.events.includes('engine A rotate'));
      stuck.setView(state => ({ ...state, pageDirtyPaths: ['B'] }));
      release();
      await expect(long).rejects.toThrow('commit refused');
      expect(stuck.events).not.toContain('publish work-A');
      expect(stuck.disk.get('work-A')).toEqual(new Uint8Array([1]));
      expect([...stuck.disk.keys()].filter(key => key.includes('.operation-'))).toEqual([]);
    } finally { release(); stuck.setView(null); setCommitGate(null); }
    const own = twoDocuments();
    release = own.hold('A');
    try {
      const long = own.rewrite('A', { following: [{ method: 'rotate', params: { angle: 90 } }] });
      await until(() => own.events.includes('engine A rotate'));
      own.setView(state => ({ ...state, pageDirtyPaths: ['A'] }));
      release();
      await expect(long).rejects.toThrow(/changed/);
      expect(own.events).toEqual(['engine A rotate', 'engine A done']);
    } finally { release(); own.setView(null); }
    expect(locks.__chainedCount()).toBe(0);
    expect(__lockedCount()).toBe(0);
    expect(hasWorkspacePublication()).toBe(false);
  });

  it.each(['engine step', 'fence'])('an owner that goes away at the %s refuses the rewrite and leaves nothing held', async where => {
    const w = twoDocuments();
    let active = true;
    const release = w.hold('A');
    try {
      const long = w.rewrite('A', { assertActive: () => { if (!active) throw new Error('owner gone'); } });
      await until(() => w.events.includes('engine A rotate'));
      if (where === 'engine step') active = false;
      else w.io.index = readingWith(async bytes => { active = false; return bytes.length; });
      release();
      await expect(long).rejects.toThrow('owner gone');
      expect(w.events).not.toContain('publish work-A');
      expect(w.disk.get('work-A')).toEqual(new Uint8Array([1]));
      expect([...w.disk.keys()].filter(key => key.includes('.operation-'))).toEqual([]);
    } finally { release(); }
    expect(locks.__chainedCount()).toBe(0);
    expect(__lockedCount()).toBe(0);
    expect(hasWorkspacePublication()).toBe(false);
    expect(writes.__documentWriteCount()).toBe(0);
  });
});

describe('a document that leaves this window', () => {
  it('leaves only after a write in progress has published; a write asked for once nothing is recorded refuses and cancels the move', async () => {
    const w = twoDocuments();
    w.io.commit = (paths, before) => runCommitGate(paths, before);
    const release = w.hold('A');
    let stays: boolean | null = null;
    try {
      const long = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      let reachedLeave!: () => void;
      const atLeave = new Promise<void>(r => { reachedLeave = r; });
      let finishLeave!: () => void;
      const leaveHeld = new Promise<void>(r => { finishLeave = r; });
      const left = writes.whileDocumentLeaves('work-A', async (cancelled) => {
        await runCommitGate(['work-A']);
        w.events.push(`leave with [${Array.from(w.disk.get('work-A')!).join(',')}]`);
        reachedLeave();
        await leaveHeld;
        stays = cancelled();
      });
      release();
      await atLeave;
      // Nothing is recorded any more: a new gesture refuses before any await.
      const confirm = vi.fn(async () => true);
      w.io.confirm = confirm;
      await expect(w.rewrite('A')).rejects.toThrow(/moved to another window/);
      await expect(w.call('compress', { file: 'work-A', output: 'work-A' })).rejects.toThrow(/moved to another window/);
      expect(confirm).not.toHaveBeenCalled();
      finishLeave();
      await Promise.all([long, left]);
      expect(w.events).toEqual(['engine A rotate', 'engine A done', 'publish work-A', 'leave with [1,2]']);
      expect(stays).toBe(true);
      // Once the move is over, writes are accepted again.
      await w.rewrite('A');
      expect(w.events.at(-1)).toBe('publish work-A');
    } finally { release(); }
    expect(writes.__documentWriteCount()).toBe(0);
  });

  it('App moves a document only inside the leave, gated on its own working path', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const handOff = app.slice(app.indexOf('const handOffDocument = useCallback('), app.indexOf('const handleMoveToNewWindow'));
    expect(handOff).toContain('return whileDocumentLeaves(beforeCommit.workingPath, async (cancelled) => {');
    expect(handOff.indexOf('whileDocumentLeaves(')).toBeLessThan(handOff.indexOf('commitOrAbort([beforeCommit.workingPath])'));
    expect(handOff.indexOf('commitOrAbort([beforeCommit.workingPath])')).toBeLessThan(handOff.indexOf("dispatch({ type: 'CLOSE_FILE', path })"));
  });
});

describe('commit gates of the App name their paths', () => {
  const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
  it('every dependent step passes the working paths it reads or writes', () => {
    expect(app).not.toMatch(/commitOrAbort\(\)/);
    for (const call of ['commitOrAbort([activeFile.workingPath])', 'commitOrAbort([file.workingPath])',
      'commitOrAbort(working)', 'commitOrAbort([])']) expect(app).toContain(call);
  });
  it('the reseal of a save runs no gated call under the write chain', () => {
    const save = app.slice(app.indexOf('const saveOrReport = useCallback('), app.indexOf('const saveOrReportRef'));
    expect(save).toContain('call: (method, params) => callLocked(method, params)');
    expect(save).toContain("await callLocked('pubkey_reattach'");
  });
});

describe('lock order across the write chain, the file locks and the lane', () => {
  it('two rewrites of one path with a commit, a save and a disk undo queued between them all settle', async () => {
    const w = twoDocuments();
    const release = w.hold('A');
    try {
      const first = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      const commit = commitOf(w, 'commit A');
      const save = withFileSave('work-A', 'dest-A', async () => { w.events.push('save'); });
      const undo = restoreHistory('undo', w.read, w.store.dispatch, w.history);
      const second = w.rewrite('A');
      release();
      const outcomes = await Promise.allSettled([first, commit, save, undo, second]);
      // The second rewrite queues behind the chain and applies to the result.
      expect(outcomes.map(o => o.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
      expect(w.events.filter(e => e === 'publish work-A').length).toBe(3);
      expect(w.events).toContain('commit A');
      expect(w.events).toContain('save');
    } finally { release(); }
    expect(__lockedCount()).toBe(0);
  });

  it('a commit of the path issued while a rewrite waits for the lane to publish settles after the publication', async () => {
    const w = twoDocuments();
    const releaseEngine = w.hold('A');
    let releaseLane: () => void = () => {};
    try {
      const rewrite = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      const blocker = serializeWorkspacePublication(() => new Promise<void>(r => { releaseLane = r; }));
      releaseEngine();
      await until(() => w.events.includes('engine A done'));
      await turn();
      // The rewrite holds exclusive(work-A) while it waits for the lane, so
      // this commit waits for the rewrite and never holds the lane against it.
      const commit = commitOf(w, 'commit A');
      await turn();
      releaseLane();
      await Promise.all([blocker, rewrite, commit]);
      expect(w.events).toEqual(['engine A rotate', 'engine A done', 'publish work-A', 'commit A']);
    } finally { releaseEngine(); releaseLane(); }
    expect(__lockedCount()).toBe(0);
  });

  it('a rewrite whose own gate must commit settles while another commit holds the dirty lock and waits for the lane', async () => {
    const w = twoDocuments();
    let releaseLane!: () => void;
    const blocker = serializeWorkspacePublication(() => new Promise<void>(r => { releaseLane = r; }));
    // The other commit holds exclusive(work-A) and queues for the lane.
    const other = commitOf(w, 'other commit');
    await turn();
    // The rewrite's own gate is a commit of the same dirty set.
    w.io.commit = async () => { await commitOf(w, 'gate commit'); };
    const rewrite = w.rewrite('A');
    await turn();
    releaseLane();
    await blocker;
    await Promise.all([other, rewrite]);
    expect(w.events).toEqual(['other commit', 'gate commit', 'engine A rotate', 'engine A done', 'publish work-A']);
    expect(__lockedCount()).toBe(0);
  });
});

describe('the page commit a rewrite runs under its write chain', () => {
  afterEach(() => setCommitGate(null));

  it('settles while a disk undo of the same path, announced, waits for that chain', async () => {
    const w = twoDocuments();
    setCommitGate(async () => { w.events.push('commit B'); w.setView(null); });
    const release = w.hold('A');
    try {
      const rewrite = w.rewrite('A');
      await until(() => w.events.includes('engine A rotate'));
      const undo = restoreHistory('undo', w.read, w.store.dispatch, w.history);
      await until(() => hasWorkspacePublication(['work-A']) && locks.__chainedCount() === 1);
      w.setView(state => ({ ...state, pageDirtyPaths: ['B'] }));
      release();
      await Promise.all([rewrite, undo]);
      expect(w.events).toEqual(['engine A rotate', 'engine A done', 'commit B', 'publish work-A', 'publish work-A']);
      expect(w.disk.get('work-A')).toEqual(new Uint8Array([1]));
    } finally { release(); w.setView(null); }
    expect(locks.__chainedCount()).toBe(0);
    expect(hasWorkspacePublication()).toBe(false);
  });
});

describe('a page edit of another document during a rewrite, through the reducer', () => {
  afterEach(() => setCommitGate(null));

  it('is committed before the publication, keeps its page ids, and the rewrite publishes', async () => {
    const onePage = async (width: number) => {
      const pdf = await PDFDocument.create(); pdf.addPage([width, 800]); return pdf.save();
    };
    const disk = new Map<string, Uint8Array>([['work-A', await onePage(600)], ['work-B', await onePage(300)]]);
    const open = (path: string): OpenFile => ({ path, workingPath: `work-${path}`, name: path,
      buffer: disk.get(`work-${path}`)!.slice(), pageCount: 1, dirty: false, undoStack: [], redoStack: [] });
    const fileA = open('A'), fileB = open('B');
    const documentOf = (file: OpenFile, width: number): OpenDocument => ({ ...file, id: `${file.path}#g1#0`, pageCount: 1,
      pages: [{ id: `${file.path}#g1#p0`, sourceDocId: file.path, sourcePageIndex: 0, rotation: 0, width, height: 800 }] });
    const store = createAppStore({ ...initialState, activeFileId: 'A', files: new Map([['A', fileA], ['B', fileB]]),
      workspace: { documents: [documentOf(fileA, 600), documentOf(fileB, 300)] } });
    const events: string[] = [];
    const transaction = {
      publish: async (id: string, entries: PageCommitEntry[]) => {
        for (const entry of entries) {
          if (entry.expectedWorkingSha256 && hash(disk.get(entry.workingPath)!) !== entry.expectedWorkingSha256) throw new Error('revision mismatch');
          disk.set(`${entry.workingPath}.snap-${id}`, disk.get(entry.workingPath)!.slice());
          disk.set(entry.workingPath, disk.get(entry.stagedPath)!.slice());
          events.push(`publish ${entry.workingPath}`);
        }
        return { status: 'committed', snapshots: entries.map(e => `${e.workingPath}.snap-${id}`), detail: '' };
      },
      abort: async () => ({ status: 'rolledBack', snapshots: [], detail: '' }),
      acknowledge: async () => {},
    };
    const writeBuffer = async (path: string, bytes: Uint8Array) => { disk.set(path, bytes.slice()); };
    const remove = async (path: string) => { disk.delete(path); };
    setCommitGate(async () => {
      const state = store.getState();
      if (!state.pageDirtyPaths.length) return;
      events.push(`commit ${state.pageDirtyPaths.join(',')}`);
      await commitPageEdits({ workspace: state.workspace, files: state.files, dirtyPaths: state.pageDirtyPaths,
        tier: { planned: { pageUndoStack: state.pageUndoStack, pageRedoStack: state.pageRedoStack }, current: store.getState },
        dispatch: store.dispatch, transaction, writeBuffer, remove });
    });
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const io: OperationIo = {
      confirm: async () => true, commit: (paths, before) => runCommitGate(paths, before),
      read: async path => disk.get(path)!.slice(), write: writeBuffer, remove,
      index: readingWith(async bytes => (await PDFDocument.load(bytes)).getPageCount()),
      track: async (_method, _params, run) => run(),
      callStaged: async (_method, params) => {
        events.push('engine A');
        await held;
        const pdf = await PDFDocument.load(disk.get(String(params.file))!);
        pdf.getPage(0).setRotation(degrees(90));
        disk.set(String(params.output), await pdf.save());
        return { output: params.output };
      },
      transaction,
    };
    try {
      const rewrite = executeWorkspaceOperation('A', 'rotate', { angle: 90 }, store.getState, store.dispatch, io);
      await until(() => events.includes('engine A'));
      store.dispatch({ type: 'ROTATE_PAGE_REF', docId: 'B#g1#0', pageId: 'B#g1#p0', rotation: 90 });
      expect(store.getState().pageDirtyPaths).toEqual(['B']);
      release();
      await rewrite;
      expect(events).toEqual(['engine A', 'commit B', 'publish work-B', 'publish work-A']);
      const state = store.getState();
      expect(state.pageDirtyPaths).toEqual([]);
      expect(state.files.get('B')!.undoStack).toHaveLength(1);
      expect(state.files.get('A')!.undoStack).toHaveLength(1);
      // B's page keeps the id the commit planned; its turn is in its bytes now.
      const pageB = state.workspace.documents.find(d => d.path === 'B')!.pages[0];
      expect(pageB.id).toBe('B#g1#p0');
      expect(pageB.rotation).toBe(0);
      expect((await PDFDocument.load(disk.get('work-B')!)).getPage(0).getRotation().angle).toBe(90);
      expect((await PDFDocument.load(disk.get('work-A')!)).getPage(0).getRotation().angle).toBe(90);
      expect(state.files.get('A')!.buffer).toEqual(disk.get('work-A'));
    } finally { release(); }
  });
});
