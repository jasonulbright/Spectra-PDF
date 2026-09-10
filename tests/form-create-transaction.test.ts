import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { createFormFields, type FormCreateIo } from '../src/renderer/lib/form-create-transaction';
import type { NewFieldSpec } from '../src/renderer/lib/form-authoring';
import { createAppStore } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';
import type { AppAction, OpenFile } from '../src/renderer/state/types';
import { hasPendingPageCommit, recoverPendingPageCommit } from '../src/renderer/lib/page-commit-transaction';
import { withFileLock } from '../src/renderer/lib/engine-lock';

const ordinary: NewFieldSpec = { type: 'text', name: 'plain', pageIndex: 0, rect: [50, 700, 250, 724] };
const vertical: NewFieldSpec = { ...ordinary, name: 'column', writingMode: 'vertical', script: 'japanese' };
const list: NewFieldSpec = { ...vertical, type: 'optionlist', name: 'list', options: ['東京', '大阪'] };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]);
  const original = await pdf.save();
  const disk = new Map<string, Uint8Array>([['work', original.slice()]]);
  const file: OpenFile = { path: 'source', workingPath: 'work', name: 'source', buffer: original,
    pageCount: 1, dirty: false, undoStack: [], redoStack: [] };
  const store = createAppStore({ ...initialState, activeFileId: file.path, files: new Map([[file.path, file]]) });
  const events: string[] = [];
  const actions: AppAction[] = [];
  const backups = new Map<string, Uint8Array>();
  const io: FormCreateIo = {
    confirm: vi.fn(async () => { events.push('confirm'); return true; }),
    commit: vi.fn(async () => { events.push('commit'); }),
    read: vi.fn(async path => { events.push('read'); return disk.get(path)!.slice(); }),
    write: vi.fn(async (path, bytes) => { events.push('write'); disk.set(path, bytes.slice()); }),
    remove: async path => { events.push('cleanup'); disk.delete(path); },
    fontDirectory: vi.fn(async () => { events.push('font'); return 'fonts'; }),
    countPages: vi.fn(async bytes => { events.push('count'); return (await PDFDocument.load(bytes)).getPageCount(); }),
    callStaged: vi.fn(async (method, params) => {
      events.push(method);
      expect(params.file).not.toBe('work'); expect(params.output).toBe(params.file);
      expect(params.allow_signed).toBe(true);
      expect(disk.get('work')).toEqual(original);
      return { output: params.output, fields: params.fields };
    }),
    transaction: {
      publish: vi.fn(async (id, [entry]) => {
        events.push('publish');
        if (hash(disk.get('work')!) !== entry.expectedWorkingSha256
            || hash(disk.get(entry.stagedPath)!) !== entry.expectedStagedSha256) throw new Error('revision mismatch');
        const prior = disk.get('work')!.slice(); backups.set(id, prior);
        disk.set(`backup-${id}`, prior);
        disk.set('work', disk.get(entry.stagedPath)!.slice());
        return { status: 'committed', snapshots: [`backup-${id}`], detail: '' };
      }),
      abort: vi.fn(async id => {
        events.push('abort');
        if (backups.has(id)) disk.set('work', backups.get(id)!.slice());
        return { status: 'rolledBack', snapshots: [], detail: '' };
      }),
      acknowledge: vi.fn(async () => { events.push('ack'); }),
    },
  };
  const dispatch = (action: AppAction) => { actions.push(action); store.dispatch(action); };
  const run = (specs: readonly NewFieldSpec[] = [ordinary]) => createFormFields('source', specs, store.getState, dispatch, io);
  const unchanged = () => {
    expect(disk.get('work')).toEqual(original);
    expect(store.getState().files.get('source')).toBe(file);
    expect(actions).toEqual([]);
  };
  return { io, run, disk, original, store, file, actions, events, unchanged };
}

describe('form creation publication', () => {
  it('the production callback supplies structural consent and an ungated private-stage transport', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const callback = app.slice(app.indexOf('const handleAddFormFields ='), app.indexOf('const handleAddFormField ='));
    expect(callback).toContain('createFormFields(path, specs, readState, dispatch');
    expect(callback).toContain("confirmEditOfSignedDoc(source, working, 'structural')");
    expect(callback).toContain('commit: () => commitRef.current()');
    expect(callback).toContain('callStaged: callRaw');
    expect(callback).not.toContain('file.snapshot(');
    expect(callback).not.toContain('file.writeBuffer(');
  });
  it.each(['font', 'read', 'count', 'stage', 'first bind', 'second bind', 'appearance', 'publish'])('%s failure preserves working bytes and history', async where => {
    const f = await fixture();
    const fail = async () => { throw new Error(`injected ${where}`); };
    if (where === 'font') f.io.fontDirectory = fail;
    if (where === 'read') f.io.read = fail;
    if (where === 'count') f.io.countPages = fail;
    if (where === 'stage') f.io.write = async path => { f.disk.set(path, new Uint8Array([1])); return fail(); };
    if (where === 'publish') f.io.transaction.publish = fail;
    let binds = 0;
    const call = f.io.callStaged;
    f.io.callStaged = async (method, params) => {
      if (method === 'author_vertical_field_font') {
        binds++;
        if (where === 'first bind' || where === 'second bind' && binds === 2) return fail();
      } else if (where === 'appearance') return fail();
      return call(method, params);
    };
    await expect(f.run([list, { ...vertical, name: 'korean', script: 'korean' }])).rejects.toThrow(`injected ${where}`);
    f.unchanged();
    expect([...f.disk.keys()].some(p => p.includes('.forms-'))).toBe(false);
  });
  it.each([null, {}, { fields: [] }, { fields: ['list', 'list'] }, { fields: ['other'] }, { fields: ['list'], output: 'foreign' }])('refuses an incomplete postprocessing receipt %j', async report => {
    const f = await fixture();
    f.io.callStaged = async (_method, params) => report && { output: params.output, ...report };
    await expect(f.run([list])).rejects.toThrow('could not be verified'); f.unchanged();
  });
  it.each([0, -1, NaN, Infinity, 1.5, 2])('refuses invalid or changed page count %s', async count => {
    const f = await fixture(); f.io.countPages = async () => count;
    await expect(f.run()).rejects.toThrow('could not be verified'); f.unchanged();
  });
  it('single and multi-field batches publish one complete PDF and one original snapshot', async () => {
    for (const specs of [[ordinary], [ordinary, list, { ...vertical, name: 'korean', script: 'korean' as const }]]) {
      const f = await fixture(); await expect(f.run(specs)).resolves.toBe(true);
      const now = f.store.getState().files.get('source')!;
      expect(now.buffer).toEqual(f.disk.get('work')); expect(now.undoStack).toHaveLength(1);
      expect(f.disk.get(now.undoStack[0])).toEqual(f.original);
      expect((await PDFDocument.load(f.disk.get('work')!)).getForm().getFields().map(x => x.getName()).sort())
        .toEqual(specs.map(x => x.name).sort());
      expect(f.actions.map(a => a.type)).toEqual(['UPDATE_FILE']);
      expect(f.events.indexOf('count')).toBeLessThan(f.events.indexOf('publish'));
      if (specs.length > 1) expect(f.events.lastIndexOf('author_vertical_field_font')).toBeLessThan(f.events.indexOf('author_choice_appearance'));
      expect([...f.disk.keys()].some(p => p.includes('.forms-'))).toBe(false);
    }
  });
  it('a refusal precedes the commit gate; an empty batch does nothing', async () => {
    const f = await fixture(); f.io.confirm = async () => false;
    await expect(f.run()).resolves.toBe(false); expect(f.io.commit).not.toHaveBeenCalled(); f.unchanged();
    await expect(f.run([])).resolves.toBe(true); expect(f.io.write).not.toHaveBeenCalled();
  });
  it('a gate failure cannot create a field', async () => {
    const f = await fixture(); f.io.commit = async () => { throw new Error('gate'); };
    await expect(f.run()).rejects.toThrow('gate'); f.unchanged(); expect(f.io.write).not.toHaveBeenCalled();
  });
  it.each(['consent', 'build', 'publish'])('refuses a changed revision during %s', async when => {
    const f = await fixture();
    const change = () => f.store.dispatch({ type: 'MARK_SAVED', path: 'source' });
    if (when === 'consent') f.io.confirm = async () => { change(); return true; };
    if (when === 'build') f.io.countPages = async () => { change(); return 1; };
    if (when === 'publish') {
      const publish = f.io.transaction.publish;
      f.io.transaction.publish = async (id, entries) => { const r = await publish(id, entries); change(); return r; };
    }
    await expect(f.run()).rejects.toThrow('changed');
    expect(f.disk.get('work')).toEqual(f.original); expect(f.actions).toEqual([]);
  });
  it('rechecks policy after the commit changes bytes, before any form stage', async () => {
    const f = await fixture();
    f.io.commit = async () => f.store.dispatch({ type: 'UPDATE_FILE', path: 'source', buffer: f.original.slice(), pageCount: 1, snapshotPath: 'page-snapshot' });
    let confirmations = 0; f.io.confirm = async () => ++confirmations === 1;
    await expect(f.run()).resolves.toBe(false); expect(confirmations).toBe(2);
    expect(f.io.write).not.toHaveBeenCalled(); expect(f.actions).toEqual([]);
  });
  it('a competing engine lock cannot cause creation against a stale revision', async () => {
    const f = await fixture(); let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    const other = withFileLock(['work'], async () => { await wait; f.store.dispatch({ type: 'MARK_SAVED', path: 'source' }); });
    const run = f.run(); await vi.waitFor(() => expect(f.io.commit).toHaveBeenCalled());
    release(); await other; await expect(run).rejects.toThrow('changed'); expect(f.io.write).not.toHaveBeenCalled();
  });
  it.each(['lost', 'malformed', 'ignored dispatch'])('recovers native publication after %s', async mode => {
    const f = await fixture(); const publish = f.io.transaction.publish;
    f.io.transaction.publish = async (id, entries) => {
      const answer = await publish(id, entries);
      if (mode === 'lost') throw new Error('lost reply');
      return mode === 'malformed' ? {} : answer;
    };
    const run = mode === 'ignored dispatch' ? createFormFields('source', [ordinary], f.store.getState, () => {}, f.io) : f.run();
    await expect(run).rejects.toThrow(); f.unchanged(); expect(f.events).toContain('abort');
  });
  it('unconfirmed abort blocks a second attempt until the same transaction recovers', async () => {
    const f = await fixture(); const publish = f.io.transaction.publish; const abort = f.io.transaction.abort;
    f.io.transaction.publish = async (id, entries) => { await publish(id, entries); throw new Error('lost'); };
    f.io.transaction.abort = async () => { throw new Error('lost abort'); };
    try {
      await expect(f.run()).rejects.toThrow('needs recovery');
      const writes = f.events.filter(x => x === 'write').length;
      await expect(f.run()).rejects.toThrow('needs recovery');
      expect(f.events.filter(x => x === 'write')).toHaveLength(writes); expect(hasPendingPageCommit()).toBe(true);
    } finally { f.io.transaction.abort = abort; await recoverPendingPageCommit(); }
    f.unchanged(); expect([...f.disk.keys()].some(p => p.includes('.forms-'))).toBe(false);
  });
  it('lost acknowledgement keeps published fields but still removes private stages', async () => {
    const f = await fixture(); f.io.transaction.acknowledge = async () => { throw new Error('lost ack'); };
    try {
      await f.run(); expect(f.events).not.toContain('abort'); expect(f.actions).toHaveLength(1);
      expect(f.store.getState().files.get('source')!.buffer).toEqual(f.disk.get('work'));
      expect([...f.disk.keys()].some(p => p.includes('.forms-'))).toBe(false);
    } finally { f.io.transaction.acknowledge = async () => {}; await recoverPendingPageCommit(); }
  });
  it('freezes caller-owned field specs before the first await', async () => {
    const f = await fixture(); const specs = [{ ...ordinary }]; const run = f.run(specs);
    specs[0].name = 'mutated'; await run;
    expect((await PDFDocument.load(f.disk.get('work')!)).getForm().getFields()[0].getName()).toBe('plain');
  });
  it('an invalid batch never publishes a partial subset', async () => {
    const f = await fixture();
    await expect(f.run([ordinary, { ...ordinary }])).rejects.toThrow();
    f.unchanged(); expect(f.io.write).not.toHaveBeenCalled();
  });
  it('native revision checks retain an independently changed working file', async () => {
    const f = await fixture(); const other = new Uint8Array([9, 8, 7]);
    f.io.countPages = async () => { f.disk.set('work', other); return 1; };
    await expect(f.run()).rejects.toThrow('revision mismatch');
    expect(f.disk.get('work')).toEqual(other); expect(f.actions).toEqual([]);
  });
});
