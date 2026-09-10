import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFDocument, degrees } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { executeWorkspaceOperation, type OperationIo } from '../src/renderer/lib/operation-transaction';
import { OP_EDIT_CLASS, type OpMethod } from '../src/renderer/lib/op-edit-class';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';
import { createAppStore } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';
import type { AppAction, OpenFile } from '../src/renderer/state/types';
import { hasPendingPageCommit, recoverPendingPageCommit } from '../src/renderer/lib/page-commit-transaction';
import { withFileLock } from '../src/renderer/lib/engine-lock';

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
    countPages: vi.fn(async bytes => { events.push('count'); return (await PDFDocument.load(bytes)).getPageCount(); }),
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
  it.each(['before', 'gate', 'pending'])('revision-derived parameters refuse drift at %s', async boundary => {
    const f = await fixture();
    const updated = () => f.store.dispatch({ type: 'REFRESH_BUFFER', path: 'source', buffer: f.original.slice(), pageCount: 1 });
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
      'confirmEditOfSignedDoc(path, working, editClass)', 'commit: () => commitRef.current()', 'callStaged: callRaw', 'trackOperation', 'trackInteractive']) expect(callback).toContain(part);
    for (const old of ['file.snapshot(', 'await call(', 'reloadFile(', "dispatch({ type: 'UPDATE_FILE'"]) expect(callback).not.toContain(old);
  });
  it.each(['read', 'count', 'stage', 'engine', 'publish'])('%s failure preserves disk/buffer/history and never reports done', async where => {
    const f = await fixture(); const fail = async () => { throw new Error(`injected ${where}`); };
    if (where === 'read') f.io.read = fail;
    if (where === 'count') f.io.countPages = fail;
    if (where === 'stage') f.io.write = fail;
    if (where === 'publish') f.io.transaction.publish = fail;
    if (where === 'engine') { const call = f.io.callStaged; f.io.callStaged = async (m, p) => { await call(m, p); return fail(); }; }
    await expect(f.run()).rejects.toThrow(`injected ${where}`);
    f.unchanged(); expect(f.events).not.toContain('done'); expect(f.events).toContain('error');
    expect([...f.disk.keys()].some(p => p.includes('.operation-'))).toBe(false);
  });
  it.each([null, [], 'done', {}, { output: 'foreign' }])('refuses an invalid report %j', async report => {
    const f = await fixture(); f.io.callStaged = async () => report;
    await expect(f.run()).rejects.toThrow('could not be verified'); f.unchanged();
  });
  it.each([0, -1, 1.5, NaN, Infinity])('refuses an invalid final page count %s', async count => {
    const f = await fixture(); f.io.countPages = async () => count;
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
      f.store.dispatch({ type: 'UPDATE_FILE', path: 'source', buffer: f.original.slice(), pageCount: 1, snapshotPath: 'page-snapshot' }); };
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
