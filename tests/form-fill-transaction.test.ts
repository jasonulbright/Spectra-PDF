import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFTextField } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { fillFormValues, type FormFillIo } from '../src/renderer/lib/form-fill-transaction';
import { remainingFormValues } from '../src/renderer/lib/form-overlay';
import { classifyFillResult } from '../src/renderer/lib/fill-result';
import { createAppStore } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';
import type { AppAction, OpenFile } from '../src/renderer/state/types';
import { hasPendingPageCommit, recoverPendingPageCommit } from '../src/renderer/lib/page-commit-transaction';

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function fixture() {
  const pdf = await PDFDocument.create(); const page = pdf.addPage();
  const field = pdf.getForm().createTextField('name'); field.setText('Original'); field.addToPage(page);
  const original = await pdf.save();
  const disk = new Map<string, Uint8Array>([['work', original.slice()]]);
  const file: OpenFile = { path: 'source', workingPath: 'work', name: 'source', buffer: original,
    pageCount: 1, dirty: false, undoStack: [], redoStack: [] };
  const store = createAppStore({ ...initialState, pageDirtyPaths: [], files: new Map([['source', file]]), activeFileId: 'source' });
  const actions: AppAction[] = [], events: string[] = [];
  const backups = new Map<string, Uint8Array>();
  const io: FormFillIo = {
    confirm: vi.fn(async () => { events.push('consent'); return true; }),
    commit: vi.fn(async () => { events.push('gate'); }),
    write: vi.fn(async (p, b) => { disk.set(p, b.slice()); }),
    read: vi.fn(async p => { events.push('reload'); return disk.get(p)!.slice(); }),
    remove: async p => { disk.delete(p); },
    countPages: vi.fn(async b => { events.push('count'); return (await PDFDocument.load(b)).getPageCount(); }),
    fontDirectory: async () => 'fonts',
    track: vi.fn(async run => { events.push('tracking'); await run(); events.push('success'); }),
    callStaged: vi.fn(async (method, params = {}) => {
      const p = String(params.file); expect(p).not.toBe('work');
      const doc = await PDFDocument.load(disk.get(p)!);
      if (method === 'read_form_fields') {
        events.push('fields');
        const fields = doc.getForm().getFields().map(f => ({ name: f.getName(), type: 'text', value: f instanceof PDFTextField ? f.getText() ?? '' : '',
          read_only: false, required: false, widgets: f.acroField.getWidgets().map(w => {
            const r = w.getRectangle(); return { page: 0, rect: [r.x, r.y, r.x + r.width, r.y + r.height] };
          }) }));
        return { fields, count: fields.length, has_xfa: false, xfa: 'none', xfa_calculations: false, calculation_order: [] };
      }
      expect(method).toBe('fill_form_fields'); expect(params.output).toBe(p); events.push('fill');
      for (const [name, value] of Object.entries(params.edits as Record<string, string>)) doc.getForm().getTextField(name).setText(value);
      if (params.flatten) doc.getForm().flatten();
      disk.set(p, await doc.save());
      return { output: p, filled: Object.keys(params.edits as object).length, flattened: params.flatten === true };
    }),
    transaction: {
      publish: vi.fn(async (id, [e]) => {
        events.push('publish');
        if (hash(disk.get('work')!) !== e.expectedWorkingSha256 || hash(disk.get(e.stagedPath)!) !== e.expectedStagedSha256) throw new Error('revision mismatch');
        backups.set(id, disk.get('work')!.slice()); disk.set(`backup-${id}`, disk.get('work')!.slice());
        disk.set('work', disk.get(e.stagedPath)!.slice());
        return { status: 'committed', snapshots: [`backup-${id}`], detail: '' };
      }),
      abort: vi.fn(async id => {
        events.push('abort'); if (backups.has(id)) disk.set('work', backups.get(id)!.slice());
        return { status: 'rolledBack', snapshots: [], detail: '' };
      }),
      acknowledge: async () => {},
    },
  };
  const dispatch = (a: AppAction) => { actions.push(a); store.dispatch(a); };
  const run = (values = { name: 'Changed' }) => fillFormValues('source', values, store.getState, dispatch, io);
  const unchanged = () => {
    expect(disk.get('work')).toEqual(original); expect(store.getState().files.get('source')).toBe(file);
    expect(actions).toEqual([]); expect([...disk.keys()].filter(p => p.includes('.forms-'))).toEqual([]);
    expect(events).not.toContain('success');
  };
  return { io, run, disk, original, store, file, actions, events, unchanged, dispatch };
}

describe('form fill publication', () => {
  it.each(['before', 'pending', 'gate'])('a draft revision is checked %s', async phase => {
    const f = await fixture();
    if (phase === 'before') f.store.dispatch({ type: 'REFRESH_BUFFER', path: 'source', buffer: f.original.slice(), pageCount: 1 });
    if (phase === 'pending') f.store.getState().pageDirtyPaths.push('source');
    if (phase === 'gate') f.io.commit = async () => {
      f.store.dispatch({ type: 'REFRESH_BUFFER', path: 'source', buffer: f.original.slice(), pageCount: 1 });
    };
    await expect(fillFormValues('source', { name: 'Changed' }, f.store.getState, f.dispatch, f.io,
      { expectedBuffer: f.original })).rejects.toThrow('changed');
    expect(f.events).not.toContain('fill'); expect(f.disk.get('work')).toEqual(f.original);
  });
  it('receipt is captured at publication, not after acknowledgement', async () => {
    const f = await fixture();
    f.io.transaction.acknowledge = async () => { f.store.dispatch({ type: 'MARK_SAVED', path: 'source' }); };
    const result = await f.run(); expect(result.completed).toBe(true);
    if (!result.completed) throw Error('receipt missing');
    expect(result.publication.dirty).toBe(true); expect(f.store.getState().files.get('source')!.dirty).toBe(false);
    expect(result.publication.buffer).toBe(f.store.getState().files.get('source')!.buffer);
  });
  it.each<Record<string, string>>([{}, { name: 'Changed' }])('flatten publishes even with no typed edits: %j', async values => {
    const f = await fixture();
    f.io.confirm = async (_p, _inspection, _targets, _typed, flatten) => { expect(flatten).toBe(true); return true; };
    await expect(fillFormValues('source', values, f.store.getState, f.dispatch, f.io, { flatten: true })).resolves.toMatchObject({ completed: true });
    expect((await PDFDocument.load(f.disk.get('work')!)).getForm().getFields()).toHaveLength(0);
    expect(f.store.getState().files.get('source')!.undoStack).toHaveLength(1);
  });
  it.each(['before', 'after gate', 'unchanged rename'])('spelling expected value is checked %s', async when => {
    const f = await fixture();
    if (when !== 'before') f.io.commit = async () => {
      const pdf = await PDFDocument.load(f.original); const field = pdf.getForm().getTextField('name');
      field.acroField.setPartialName('name+1');
      if (when === 'after gate') field.setText('Changed elsewhere');
      const b = await pdf.save(); f.disk.set('work', b);
      f.store.dispatch({ type: 'UPDATE_FILE', path: 'source', buffer: b, pageCount: 1, snapshotPath: 'gate' });
    };
    const run = fillFormValues('source', { name: 'Correction' }, f.store.getState, f.dispatch, f.io,
      { expectedValues: { name: when === 'before' ? 'Stale value' : 'Original' }, changedMessage: 'moved' });
    if (when === 'unchanged rename') {
      await expect(run).resolves.toMatchObject({ completed: true });
      expect((await PDFDocument.load(f.disk.get('work')!)).getForm().getTextField('name+1').getText()).toBe('Correction');
    } else {
      await expect(run).rejects.toThrow('moved'); expect(f.events).not.toContain('fill');
      expect(f.actions).toEqual([]);
    }
  });
  it('uses the actual App transport and preserves declined canvas input', () => {
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const callback = app.slice(app.indexOf('const handleFillFormValues ='), app.indexOf('const handleAddFormFields ='));
    expect(callback).toContain('fillFormValues(path, values, readState, dispatch');
    expect(callback).toContain('callStaged: callRaw'); expect(callback).toContain('filled : EDIT_DECLINED');
    expect(callback).not.toMatch(/file\.snapshot\(|reloadFile\(|await call\(/);
    const canvas = readFileSync(new URL('../src/renderer/components/canvas/WorkspaceCanvasView.tsx', import.meta.url), 'utf8');
    expect(canvas).toContain('if (await onFillFormValues(path, Object.fromEntries(values)) === EDIT_DECLINED) continue;');
    expect(canvas).toContain('remainingFormValues(current, values)');
  });
  it.each(['inspection write', 'inspection read', 'policy', 'gate', 'stage write', 'font', 'fill', 'reload', 'count', 'publish'])('%s failure never changes working bytes or undo', async where => {
    const f = await fixture(); const fail = async () => { throw new Error(`injected ${where}`); };
    if (where === 'policy') f.io.confirm = fail;
    if (where === 'gate') f.io.commit = fail;
    if (where === 'font') f.io.fontDirectory = fail;
    if (where === 'reload') f.io.read = fail;
    if (where === 'count') f.io.countPages = fail;
    if (where === 'publish') f.io.transaction.publish = fail;
    const write = f.io.write, call = f.io.callStaged;
    f.io.write = async (p, b) => {
      await write(p, b);
      if (where === 'inspection write' && p.includes('.forms-policy-') || where === 'stage write' && !p.includes('.forms-policy-')) await fail();
    };
    f.io.callStaged = async (m, p) => {
      if (where === 'inspection read' && m === 'read_form_fields') return fail();
      const result = await call(m, p);
      if (where === 'fill' && m === 'fill_form_fields') return fail();
      return result;
    };
    await expect(f.run()).rejects.toThrow(`injected ${where}`); f.unchanged();
  });
  it.each([null, {}, [], { filled: 0 }, { filled: 2 }, { filled: 1.5 }, { filled: -1 }, { filled: NaN },
    { output: 'foreign' }, { flattened: true }, { flattened: undefined }])('rejects bad fill report %j before publication', async bad => {
    const f = await fixture(); const call = f.io.callStaged;
    f.io.callStaged = async (m, p) => {
      const r = await call(m, p);
      return m === 'fill_form_fields' ? bad && !Array.isArray(bad) ? { ...(r as object), ...bad } : bad : r;
    };
    if (bad && !Array.isArray(bad) && !Object.keys(bad).length) {
      f.io.callStaged = async (m, p) => m === 'fill_form_fields' ? {} : call(m, p);
    }
    await expect(f.run()).rejects.toThrow(); f.unchanged();
  });
  it.each([null, {}, { fields: [] }, { count: 99 }, { calculation_order: null }, { calculation_order: [2] },
    { xfa: 'unknown' }, { fields: [{ name: 'name' }] }])('rejects incomplete fingerprint read %j', async bad => {
    const f = await fixture(); const call = f.io.callStaged;
    f.io.callStaged = async (m, p) => m === 'read_form_fields' ? bad && { ...(await call(m, p) as object), ...bad } : call(m, p);
    if (bad && !Object.keys(bad).length) f.io.callStaged = async () => ({});
    await expect(f.run()).rejects.toThrow(); f.unchanged(); expect(f.io.commit).not.toHaveBeenCalled();
  });
  it('publishes once, keeps original undo bytes and only then completes tracking', async () => {
    const f = await fixture(); await expect(f.run()).resolves.toMatchObject({ completed: true });
    const now = f.store.getState().files.get('source')!;
    expect((await PDFDocument.load(f.disk.get('work')!)).getForm().getTextField('name').getText()).toBe('Changed');
    expect(now.buffer).toEqual(f.disk.get('work')); expect(now.undoStack).toHaveLength(1);
    expect(f.disk.get(now.undoStack[0])).toEqual(f.original); expect(f.actions.map(a => a.type)).toEqual(['UPDATE_FILE']);
    expect(f.events).toEqual(['fields', 'consent', 'gate', 'tracking', 'fill', 'reload', 'count', 'publish', 'success']);
  });
  it('consent sees a private copy even if working disk bytes differ', async () => {
    const f = await fixture(); f.disk.set('work', new Uint8Array([1, 2]));
    f.io.confirm = async (_p, inspection) => { expect(f.disk.get(inspection)).toEqual(f.original); return true; };
    await expect(f.run()).rejects.toThrow('revision mismatch'); expect(f.disk.get('work')).toEqual(new Uint8Array([1, 2]));
    expect(f.actions).toEqual([]);
  });
  it('a decline is not success and does not run the commit gate', async () => {
    const f = await fixture(); f.io.confirm = async () => false;
    await expect(f.run()).resolves.toMatchObject({ completed: false }); f.unchanged(); expect(f.io.commit).not.toHaveBeenCalled();
  });
  it('freezes submitted values before awaiting inspection', async () => {
    const f = await fixture(); const values = { name: 'Changed' }; const run = f.run(values); values.name = 'Later'; await run;
    expect((await PDFDocument.load(f.disk.get('work')!)).getForm().getTextField('name').getText()).toBe('Changed');
  });
  it.each([true, false])('remaps fields across the gate and rechecks consent (allow=%s)', async allow => {
    const f = await fixture();
    const post = await PDFDocument.load(f.original); post.getForm().getTextField('name').acroField.setPartialName('name+1');
    const committed = await post.save();
    f.io.commit = async () => {
      f.disk.set('work', committed); f.store.dispatch({ type: 'UPDATE_FILE', path: 'source', buffer: committed, pageCount: 1, snapshotPath: 'page-backup' });
    };
    const seen: string[][] = [];
    f.io.confirm = async (_p, _inspection, targets, typed) => { seen.push([...typed]); expect(targets).toEqual(typed); return seen.length === 1 || allow; };
    await expect(f.run()).resolves.toMatchObject({ completed: allow }); expect(seen).toEqual([['name'], ['name+1']]);
    if (allow) {
      const now = f.store.getState().files.get('source')!;
      expect((await PDFDocument.load(f.disk.get('work')!)).getForm().getTextField('name+1').getText()).toBe('Changed');
      expect(now.undoStack).toHaveLength(2); expect(f.disk.get(now.undoStack[1])).toEqual(committed);
    } else { expect(f.disk.get('work')).toEqual(committed); expect(f.actions).toEqual([]); expect(f.events).not.toContain('fill'); }
  });
  it('asks about calculated lock targets, not only the typed field', async () => {
    const f = await fixture(); const call = f.io.callStaged;
    f.io.callStaged = async (m, p) => {
      const r = await call(m, p) as { fields: { name: string; actions?: Record<string, string> }[]; count: number; calculation_order: string[] };
      if (m === 'read_form_fields') { r.fields.push({ ...r.fields[0], name: 'total', actions: { C: 'AFSimple_Calculate("SUM", ["name"]);' } }); r.count++; r.calculation_order = ['total']; }
      return r;
    };
    f.io.confirm = async (_p, _inspection, targets, typed) => { expect(typed).toEqual(['name']); expect(targets).toEqual(['name', 'total']); return false; };
    await expect(f.run()).resolves.toMatchObject({ completed: false }); f.unchanged();
  });
  it.each(['consent', 'fill', 'publish'])('revision drift during %s cannot overwrite a newer state', async where => {
    const f = await fixture(); const drift = () => f.store.dispatch({ type: 'MARK_SAVED', path: 'source' });
    if (where === 'consent') f.io.confirm = async () => { drift(); return true; };
    if (where === 'fill') f.io.fontDirectory = async () => { drift(); return 'fonts'; };
    if (where === 'publish') { const publish = f.io.transaction.publish; f.io.transaction.publish = async (id, entries) => { const r = await publish(id, entries); drift(); return r; }; }
    await expect(f.run()).rejects.toThrow('changed'); expect(f.disk.get('work')).toEqual(f.original); expect(f.actions).toEqual([]);
  });
  it('lost publication reply rolls back; lost acknowledgement does not roll back success', async () => {
    const f = await fixture(); const publish = f.io.transaction.publish;
    f.io.transaction.publish = async (id, entries) => { await publish(id, entries); throw new Error('lost reply'); };
    await expect(f.run()).rejects.toThrow(); f.unchanged();
    f.io.transaction.publish = publish;
    f.io.transaction.acknowledge = async () => { throw new Error('lost ack'); };
    try { await expect(f.run()).resolves.toMatchObject({ completed: true }); expect(hasPendingPageCommit()).toBe(true); }
    finally { f.io.transaction.acknowledge = async () => {}; await recoverPendingPageCommit(); }
    expect(f.events.filter(e => e === 'abort')).toHaveLength(1);
  });
  it('retiring submitted values preserves edits typed while awaiting publication', () => {
    const applied = new Map([['name', 'Changed'], ['old', 'value']]);
    const current = new Map([['name', 'Later'], ['old', 'value'], ['new', 'Unsubmitted']]);
    expect(remainingFormValues(current, applied)).toEqual(new Map([['name', 'Later'], ['new', 'Unsubmitted']]));
    expect(current.size).toBe(3);
  });
  it.each([1.5, -1, Infinity, Number.MAX_SAFE_INTEGER + 1, 2])('invalid or excess count %s cannot certify one fill', count => {
    expect(classifyFillResult({ output: 'stage', filled: count }, 1)).toMatchObject({ kind: 'refused' });
  });
});
