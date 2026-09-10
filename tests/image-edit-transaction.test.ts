import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { editWorkspaceImage, type ImageEdit, type ImageEditIo } from '../src/renderer/lib/image-edit-transaction';
import { createAppStore } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';
import type { AppAction, OpenFile } from '../src/renderer/state/types';

const raw = { raw_path: 'input.raw', width: 1, height: 1, channels: 3 as const };
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const edits: ImageEdit[] = [
  { kind: 'replace', page: 1, index: 0, source: raw },
  { kind: 'add', page: 1, rect: [10, 20, 50, 80], source: raw },
  { kind: 'add', page: 1, rect: null, at: [10, 20], source: { svg_path: 'image.svg' } },
];
function fixture() {
  const original = new Uint8Array([1, 2, 3]), filled = new Uint8Array([4, 5, 6]);
  const disk = new Map([['work', original.slice()]]), backups = new Map<string, Uint8Array>();
  const file: OpenFile = { path: 'source', workingPath: 'work', name: 'source', pageCount: 1,
    buffer: original, dirty: false, undoStack: [], redoStack: [] };
  const store = createAppStore({ ...initialState, files: new Map([['source', file]]), activeFileId: 'source' });
  const actions: AppAction[] = [], events: string[] = [];
  const io: ImageEditIo = {
    confirm: vi.fn(async () => true), commit: vi.fn(async () => {}),
    pick: vi.fn(async () => 'photo.jpg'), readSource: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
    decode: vi.fn(async (_bytes, write) => ({ ...raw, raw_path: await write(new Uint8Array([0, 255, 0])) })),
    write: vi.fn(async (p, b) => { disk.set(p, b.slice()); }),
    read: vi.fn(async p => disk.get(p)!.slice()), remove: async p => { disk.delete(p); }, countPages: async () => 1,
    callStaged: vi.fn(async (_method, params = {}) => {
      expect(params.file).not.toBe('work'); expect(params.file).toBe(params.output);
      expect(disk.get('work')).toEqual(original); expect(disk.get(String(params.file))).toEqual(original);
      events.push('engine'); disk.set(String(params.file), filled.slice());
      return { output: params.output };
    }),
    track: vi.fn(async (_method, _path, run) => { events.push('tracking'); await run(); events.push('success'); }),
    transaction: {
      publish: vi.fn(async (id, [e]) => {
        expect(e.expectedWorkingSha256).toBe(hash(disk.get('work')!)); expect(e.expectedStagedSha256).toBe(hash(disk.get(e.stagedPath)!));
        backups.set(id, disk.get('work')!.slice()); disk.set(`backup-${id}`, disk.get('work')!.slice());
        disk.set('work', disk.get(e.stagedPath)!.slice()); events.push('publish');
        return { status: 'committed', snapshots: [`backup-${id}`], detail: '' };
      }),
      abort: async id => { if (backups.has(id)) disk.set('work', backups.get(id)!.slice()); return { status: 'rolledBack', snapshots: [], detail: '' }; },
      acknowledge: async () => {},
    },
  };
  const run = (edit: ImageEdit = edits[0]) => editWorkspaceImage('source', edit, store.getState, a => { actions.push(a); store.dispatch(a); }, io);
  const unchanged = () => { expect(disk.get('work')).toEqual(original); expect(store.getState().files.get('source')).toBe(file); expect(actions).toEqual([]); expect([...disk.keys()].filter(p => p.includes('.operation-'))).toEqual([]); };
  return { io, run, original, filled, disk, actions, events, unchanged, store };
}

describe('image gesture publication', () => {
  it('actual raster and SVG callbacks cannot bypass the staged publisher', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const region = app.slice(app.indexOf('const performImageEdit ='), app.indexOf('const handleHistory ='));
    expect(region).toContain('editWorkspaceImage(path, edit, readState, dispatch');
    expect(region).toContain('callStaged: callRaw'); expect(region).toContain('performImageEdit(path, { kind: \'add\'');
    expect(region).toContain('performImageEdit(path, { kind: \'replace\'');
    expect(region).not.toMatch(/file\.snapshot\(|reloadFile\(|call\('(add_page_image|replace_page_image|add_page_vector_graphic)'/);
  });
  for (const edit of edits) {
    it.each(['write', 'engine', 'read', 'count', 'publish'])(`${edit.kind}/${'svg_path' in edit.source! ? 'svg' : 'raw'}: %s failure preserves bytes/history`, async where => {
      const f = fixture(); const fail = async () => { throw new Error('injected'); };
      if (where === 'write') f.io.write = fail;
      if (where === 'read') f.io.read = fail;
      if (where === 'count') f.io.countPages = fail;
      if (where === 'publish') f.io.transaction.publish = fail;
      if (where === 'engine') { const call = f.io.callStaged; f.io.callStaged = async (m, p) => { await call(m, p); return fail(); }; }
      await expect(f.run(edit)).rejects.toThrow('injected'); f.unchanged(); expect(f.events).not.toContain('success');
    });
    it(`${edit.kind}/${'svg_path' in edit.source! ? 'svg' : 'raw'}: success is one complete publication`, async () => {
      const f = fixture(); await expect(f.run(edit)).resolves.toBe(true);
      const now = f.store.getState().files.get('source')!;
      expect(now.buffer).toEqual(f.filled); expect(f.disk.get('work')).toEqual(f.filled);
      expect(now.undoStack).toHaveLength(1); expect(f.disk.get(now.undoStack[0])).toEqual(f.original);
      expect(f.events).toEqual(['tracking', 'engine', 'publish', 'success']);
      expect(f.io.pick).not.toHaveBeenCalled();
    });
  }
  it.each(['add', 'replace'] as const)('JPEG fallback for %s discards a dirty refused attempt and publishes once', async kind => {
    const f = fixture(); const call = f.io.callStaged;
    f.io.callStaged = vi.fn(async (m, p = {}) => {
      if ('jpeg_path' in (p.source as object)) { f.disk.set(String(p.file), new Uint8Array([9])); throw new Error('unsupported JPEG (4 components); send raw pixels'); }
      return call(m, p);
    });
    await expect(f.run(kind === 'add' ? { kind, page: 1, rect: null, at: [10, 20] } : { kind, page: 1, index: 0 })).resolves.toBe(true);
    expect(f.io.callStaged).toHaveBeenCalledTimes(2); expect(f.io.decode).toHaveBeenCalledTimes(1);
    expect(f.io.transaction.publish).toHaveBeenCalledTimes(1); expect(f.io.track).toHaveBeenCalledTimes(1);
    expect([...f.disk.keys()].filter(p => p.endsWith('.raw'))).toEqual([]);
  });
  it.each(['decode', 'raw write', 'raw engine'])('failed JPEG fallback at %s preserves originals and cleans scratch', async where => {
    const f = fixture(); f.io.callStaged = async (_m, p = {}) => {
      f.disk.set(String(p.file), new Uint8Array([9]));
      throw new Error('jpeg_path' in (p.source as object) ? 'send raw pixels' : 'injected raw engine');
    };
    if (where === 'decode') f.io.decode = async () => { throw new Error('injected decode'); };
    if (where === 'raw write') { const write = f.io.write; f.io.write = async (p, b) => { await write(p, b); if (p.endsWith('.raw')) throw new Error('injected raw write'); }; }
    await expect(f.run({ kind: 'add', page: 1, rect: null, at: [0, 0] })).rejects.toThrow(`injected ${where}`);
    f.unchanged(); expect([...f.disk.keys()].filter(p => p.endsWith('.raw'))).toEqual([]);
  });
  it('an unrelated engine error does not enter fallback', async () => {
    const f = fixture(); f.io.callStaged = async () => { throw new Error('permission denied'); };
    await expect(f.run({ kind: 'add', page: 1, rect: null })).rejects.toThrow('permission denied');
    expect(f.io.decode).not.toHaveBeenCalled(); f.unchanged();
  });
  it.each([null, {}, [], { output: 'elsewhere' }])('unverified report %j never publishes', async report => {
    const f = fixture(); f.io.callStaged = async () => report;
    await expect(f.run()).rejects.toThrow('could not be verified'); f.unchanged();
  });
  it('cancelled picking and denied consent create no history or engine call', async () => {
    const f = fixture(); f.io.pick = async () => null;
    await expect(f.run({ kind: 'add', page: 1, rect: null })).resolves.toBe(false);
    f.io.confirm = async () => false; await expect(f.run()).resolves.toBe(false);
    expect(f.io.commit).not.toHaveBeenCalled(); expect(f.io.callStaged).not.toHaveBeenCalled(); f.unchanged();
  });
  it('a changed post-gate revision gets fresh consent without repeating the picker', async () => {
    const f = fixture(); const confirm = vi.fn(async () => true); f.io.confirm = confirm;
    f.io.commit = async () => f.store.dispatch({ type: 'UPDATE_FILE', path: 'source', buffer: f.original.slice(), pageCount: 1, snapshotPath: 'gate-snapshot' });
    await f.run({ kind: 'add', page: 1, rect: null });
    expect(confirm).toHaveBeenCalledTimes(2); expect(f.io.pick).toHaveBeenCalledTimes(1);
  });
});
