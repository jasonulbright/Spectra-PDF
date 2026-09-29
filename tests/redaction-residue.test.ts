import { describe, expect, it, vi } from 'vitest';
import { residueGroups, residueMessage, residueOf, residueRequest } from '../src/renderer/lib/redaction-residue';
import { writeRedactionMarks } from '../src/renderer/lib/redaction-write';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenDocument, OpenFile } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import type { RedactionMark } from '../src/renderer/lib/redaction';

const RESULT = {
  output: 'a.work',
  removed_text: ['SSN 123-45-6789'],
  residue: [
    { kind: 'outline', where: 'SSN 123-45-6789', text: 'SSN 123-45-6789' },
    { kind: 'metadata', where: 'Subject', text: 'SSN 123-45-6789' },
    { kind: 'metadata', where: 'description', text: 'SSN 123-45-6789' },
    { kind: 'bogus', where: '', text: '' },
  ],
  residue_counts: { outline: 1, metadata: 2, bogus: 1 },
  residue_truncated: false,
};

describe('redaction residue', () => {
  it('reads the places a redact result reports and drops unknown kinds', () => {
    const residue = residueOf(RESULT)!;
    expect(residue.terms).toEqual(['SSN 123-45-6789']);
    expect(residue.entries.map(e => e.kind)).toEqual(['outline', 'metadata', 'metadata']);
  });

  it('offers nothing when nothing is left or the result carries no terms', () => {
    expect(residueOf({ ...RESULT, residue: [], residue_counts: {} })).toBeNull();
    expect(residueOf({ ...RESULT, removed_text: [] })).toBeNull();
    expect(residueOf({ output: 'a.work' })).toBeNull();
    expect(residueOf(null)).toBeNull();
  });

  it('counts every kind and lists metadata once', () => {
    const groups = residueGroups(residueOf(RESULT)!);
    expect(groups).toEqual([
      { label: 'panel.sanitize.category.bookmarks', count: 1 },
      { label: 'panel.sanitize.category.metadata', count: 2 },
    ]);
    const message = residueMessage(residueOf(RESULT)!, 'en');
    expect(message).toContain('Bookmarks (1)');
    expect(message).toContain('Document and page metadata (2)');
    expect(message).not.toContain('Named destinations get new names');
  });

  it('requests removal from every kind the engine counted, including rows past the cap', () => {
    const capped = residueOf({
      ...RESULT,
      residue: [RESULT.residue[0]],
      residue_counts: { outline: 1, metadata: 2, javascript: 1, dest_name: 1, field: 1 },
      residue_truncated: true,
    })!;
    expect(residueRequest(capped)).toEqual({
      terms: ['SSN 123-45-6789'], kinds: ['outline', 'dest_name', 'metadata', 'field', 'javascript'],
    });
    const message = residueMessage(capped, 'en');
    expect(message).toContain('Every occurrence is removed.');
    expect(message).toContain('removed whole');
    expect(message).toContain('stop working');
    expect(message).toContain('Field names are not changed.');
  });

  it('never offers places that removal cannot clear', () => {
    const namesOnly = residueOf({ ...RESULT, residue: [], residue_counts: {}, residue_report_only: { field_name: 2 } });
    expect(namesOnly).toBeNull();
    const withNames = residueOf({ ...RESULT, residue_report_only: { field_name: 1 } })!;
    expect(residueRequest(withNames).kinds).toEqual(['outline', 'metadata']);
    expect(residueMessage(withNames, 'en')).toContain('Field names are not changed.');
  });

  it('takes the signed-document decision like every other rewrite', async () => {
    const { opEditClass } = await import('../src/renderer/lib/op-edit-class');
    expect(opEditClass('remove_redaction_residue')).toBe('structural');
  });
});

function fixture() {
  const file: OpenFile = { path: 'a', name: 'a.pdf', workingPath: 'a.work', buffer: [1], pageCount: 1,
    dirty: false, undoStack: [], redoStack: [] };
  const doc: OpenDocument = { ...file, id: 'a.doc', pages: [
    { id: 'p', sourceDocId: 'a', sourcePageIndex: 0, rotation: 0, width: 600, height: 800 },
  ] };
  const state: AppState = { ...initialState, files: new Map([['a', file]]), workspace: { documents: [doc] } };
  const mark: RedactionMark = { id: 'm', path: 'a', pageId: 'p', rotationAtDraw: 0, rect: { x: .1, y: .1, w: .2, h: .1 } };
  return { state, mark };
}

describe('the apply flow hands the result to the residue offer', () => {
  const geometry = async () => ({ box: { x: 0, y: 0, width: 600, height: 800 }, bakedRotate: 0 });

  it('after an applied redaction', async () => {
    const { state, mark } = fixture();
    const perform: PerformOperation = async (_p, _m, _v, options) => {
      await options!.prepareParams!(state);
      return { ...RESULT, publication: state.files.get('a')! } as unknown as Awaited<ReturnType<PerformOperation>>;
    };
    const offer = vi.fn(async () => {});
    expect(await writeRedactionMarks('a', [mark], state, 'redact', () => state, perform, geometry, async () => '', offer)).toBe(true);
    expect(offer).toHaveBeenCalledWith('a', expect.objectContaining({ removed_text: RESULT.removed_text }));
  });

  it('never for saved marks or a declined write', async () => {
    const { state, mark } = fixture();
    const offer = vi.fn(async () => {});
    const saved: PerformOperation = async () => ({ output: 'a.work' }) as unknown as Awaited<ReturnType<PerformOperation>>;
    await writeRedactionMarks('a', [mark], state, 'save_redaction_marks', () => state, saved, geometry, async () => '', offer);
    const declined: PerformOperation = async () => null as unknown as Awaited<ReturnType<PerformOperation>>;
    expect(await writeRedactionMarks('a', [mark], state, 'redact', () => state, declined, geometry, async () => '', offer)).toBe(false);
    expect(offer).not.toHaveBeenCalled();
  });
});

vi.mock('../src/renderer/lib/tauri-bridge', () => ({ batch: {} }));
vi.mock('../src/renderer/lib/gs-capability', () => ({ gsPathIfAvailable: async () => '' }));

describe('disk redaction offers the same removal', () => {
  it('asks once per written file and removes from the output on yes', async () => {
    const { createDiskRedactIo } = await import('../src/renderer/lib/disk-redact-io');
    const calls: [string, Record<string, unknown>][] = [];
    const callRaw = async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      return method === 'redact' ? RESULT : {};
    };
    const ask = vi.fn(async () => true);
    await createDiskRedactIo(callRaw, 'fonts', ask).write('in.pdf', 'out.pdf', [{ page: 1, rect: [0, 0, 1, 1] }], false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(calls[1]).toEqual(['remove_redaction_residue', {
      file: 'out.pdf', output: 'out.pdf', terms: RESULT.removed_text, kinds: ['outline', 'metadata'], font_dir: 'fonts',
    }]);
    calls.length = 0;
    await createDiskRedactIo(callRaw, 'fonts', async () => false).write('in.pdf', 'out.pdf', [{ page: 1, rect: [0, 0, 1, 1] }], false);
    expect(calls.map(c => c[0])).toEqual(['redact']);
  });
});

describe('a guided Search & Redact step', () => {
  it('reports by default and removes only when the step says so', async () => {
    const { stepDefFor } = await import('../src/renderer/lib/guided-actions');
    const def = stepDefFor('search_redact');
    expect(def.params.find(p => p.key === 'residue')?.defaultValue).toBe('report');
    expect(def.mapParams!({ query: 'x' })).not.toHaveProperty('remove_residue');
    expect(def.mapParams!({ query: 'x', residue: 'remove' })).toMatchObject({ remove_residue: 'all' });
  });
});
