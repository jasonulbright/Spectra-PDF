// A document opened with its USER password keeps an encrypted working copy.
// The renderer-built writes (page-tier commit with its annotations, field
// creation) build from the engine's decrypted bytes and land through the
// engine's reseal; every other document keeps the pdf-lib path unchanged.
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCommitBytes,
  commitPageEdits,
  planCommit,
} from '../src/renderer/lib/workspace-commit';
import {
  base64ToBytes,
  bytesToBase64,
  commitCapabilities,
} from '../src/renderer/lib/sealed-edit';
import { parseDocumentSecurity, PERMISSION_NAMES } from '../src/renderer/lib/document-permissions';
import type { PageCommitEntry } from '../src/renderer/lib/page-commit-transaction';
import type { AppAction, OpenDocument, OpenFile, PageRef, Workspace } from '../src/renderer/state/types';
import { tChrome } from '../src/renderer/i18n';
import { runHealthSweep } from '../src/renderer/lib/doc-health-engine';
import { createFormFields, type FormCreateIo } from '../src/renderer/lib/form-create-transaction';
import type { NewFieldSpec } from '../src/renderer/lib/form-authoring';
import { createAppStore } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';
import { setStageCredentialCaller } from '../src/renderer/lib/stage-credentials';
import { readingWith } from './helpers/published-bytes';

const USER_OPENED = parseDocumentSecurity({
  opener: 'user',
  permissions: Object.fromEntries(PERMISSION_NAMES.map((name) => [name, true])),
});
// Stands in for the encrypted working copy: pdf-lib must never be handed it.
const CIPHERTEXT = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xde, 0xad, 0xbe, 0xef]);

async function pdfOf(widths: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const w of widths) doc.addPage([w, 400]);
  return doc.save();
}

function file(path: string, buffer: Uint8Array, pageCount: number, sealed = false): OpenFile {
  return {
    path, workingPath: `${path}.working`, name: path, pageCount, buffer,
    dirty: false, undoStack: [], redoStack: [], ...(sealed ? { security: USER_OPENED } : {}),
  };
}

function ref(path: string, index: number, rotation: 0 | 90 | 180 | 270 = 0): PageRef {
  return { id: `${path}#p${index}`, sourceDocId: path, sourcePageIndex: index, rotation, width: 0, height: 0 };
}

function doc(id: string, f: OpenFile, pages: PageRef[]): OpenDocument {
  return { ...f, id, name: f.path, pages, pageCount: pages.length };
}

function harness() {
  const contents = new Map<string, Uint8Array>();
  const writes: string[] = [];
  const dispatched: AppAction[] = [];
  const engine: { method: string; params: Record<string, unknown> }[] = [];
  const planned = { pageUndoStack: [], pageRedoStack: [] };
  const deps = {
    tier: { planned, current: () => planned },
    dispatch: (action: AppAction) => dispatched.push(action),
    transaction: {
      publish: async (_id: string, entries: PageCommitEntry[]) => {
        for (const e of entries) contents.set(e.workingPath, contents.get(e.stagedPath)!);
        return { status: 'committed' as const, snapshots: entries.map((e) => `${e.workingPath}.snap`), detail: '' };
      },
      abort: async () => ({ status: 'rolledBack' as const, snapshots: [], detail: '' }),
      acknowledge: async () => {},
    },
    writeBuffer: async (path: string, bytes: Uint8Array) => { writes.push(path); contents.set(path, bytes); },
    remove: async (path: string) => { contents.delete(path); },
    readBack: async (path: string) => contents.get(path)!,
  };
  return { contents, writes, dispatched, engine, deps };
}

describe('page-tier commit routing', () => {
  it('builds a user-opened file from the engine plaintext and lands it through the reseal', async () => {
    const plaintext = await pdfOf([100, 101, 102]);
    const a = file('a.pdf', CIPHERTEXT, 3, true);
    const files = new Map([['a.pdf', a]]);
    const workspace: Workspace = { documents: [doc('a#0', a, [ref('a.pdf', 2), ref('a.pdf', 0, 90)])] };
    const h = harness();
    const resealed = new Uint8Array([9, 9, 9]);
    let builderOutput: Uint8Array | null = null;
    const sealed = vi.fn(async (method: string, params: Record<string, unknown>) => {
      h.engine.push({ method, params });
      if (method === 'sealed_plaintext') return { data: bytesToBase64(plaintext) };
      builderOutput = base64ToBytes(params.data as string);
      h.contents.set(params.output as string, resealed);
      return { output: params.output };
    });
    await commitPageEdits({ workspace, files, dirtyPaths: ['a.pdf'], ...h.deps, sealed });

    expect(h.engine.map((c) => c.method)).toEqual(['sealed_plaintext', 'sealed_reseal']);
    expect(h.engine[0].params).toEqual({ path: 'a.pdf.working', capabilities: ['pageTier'] });
    expect(h.engine[1].params.capabilities).toEqual(['pageTier']);
    expect(h.engine[1].params.output).toMatch(/^a\.pdf\.working\.commit-tmp-/);
    expect(h.writes).toEqual([]); // no plaintext is ever staged
    const action = h.dispatched[0];
    expect(action.type).toBe('COMMIT_PAGE_EDITS');
    if (action.type === 'COMMIT_PAGE_EDITS') {
      expect(action.updates[0].buffer).toBe(resealed);
      expect(action.updates[0].authored.pages).toEqual(['a.pdf#p2', 'a.pdf#p0']);
    }
    // The builder's output is what the same builder writes for the plaintext
    // held by an unencrypted file.
    const plainFiles = new Map([['a.pdf', file('a.pdf', plaintext, 3)]]);
    const plainWorkspace: Workspace = { documents: [doc('a#0', plainFiles.get('a.pdf')!, [ref('a.pdf', 2), ref('a.pdf', 0, 90)])] };
    const [plan] = planCommit(plainWorkspace, plainFiles, ['a.pdf']);
    expect(builderOutput).toEqual(await buildCommitBytes(plan));
  });

  it('leaves an unencrypted file on the pdf-lib path, byte for byte', async () => {
    const bytes = await pdfOf([100, 101]);
    const a = file('a.pdf', bytes, 2);
    const files = new Map([['a.pdf', a]]);
    const workspace: Workspace = { documents: [doc('a#0', a, [ref('a.pdf', 1), ref('a.pdf', 0)])] };
    const h = harness();
    const sealed = vi.fn();
    await commitPageEdits({ workspace, files, dirtyPaths: ['a.pdf'], ...h.deps, sealed });
    expect(sealed).not.toHaveBeenCalled();
    expect(h.writes).toHaveLength(1);
    const [plan] = planCommit(workspace, files, ['a.pdf']);
    expect(h.contents.get('a.pdf.working')).toEqual(await buildCommitBytes(plan));
  });

  it("refuses pages leaving a user-opened file, and calls no engine door", async () => {
    const a = file('a.pdf', CIPHERTEXT, 2, true);
    const b = file('b.pdf', await pdfOf([200]), 1);
    const files = new Map([['a.pdf', a], ['b.pdf', b]]);
    const workspace: Workspace = {
      documents: [doc('a#0', a, [ref('a.pdf', 1)]), doc('b#0', b, [ref('b.pdf', 0), ref('a.pdf', 0)])],
    };
    const h = harness();
    const sealed = vi.fn();
    await expect(commitPageEdits({ workspace, files, dirtyPaths: ['a.pdf', 'b.pdf'], ...h.deps, sealed }))
      .rejects.toThrow(tChrome('app.permissions.ownerPasswordNeeded'));
    expect(sealed).not.toHaveBeenCalled();
    expect(h.dispatched).toEqual([]);
  });

  it('refuses a user-opened file when no engine transport is supplied', async () => {
    const a = file('a.pdf', CIPHERTEXT, 2, true);
    const files = new Map([['a.pdf', a]]);
    const workspace: Workspace = { documents: [doc('a#0', a, [ref('a.pdf', 1), ref('a.pdf', 0)])] };
    const h = harness();
    await expect(commitPageEdits({ workspace, files, dirtyPaths: ['a.pdf'], ...h.deps }))
      .rejects.toThrow(tChrome('app.permissions.ownerPasswordNeeded'));
  });

  it('names the /P classes a commit exercises', () => {
    const page = { bytes: CIPHERTEXT, sourceKey: 'a.pdf', pageIndex: 0 };
    expect(commitCapabilities('a.pdf', [page, { ...page, pageIndex: 1 }], 2)).toEqual(['pageTier']);
    expect(commitCapabilities('a.pdf', [{ ...page, annotations: [{} as never] }, { ...page, pageIndex: 1 }], 2))
      .toEqual(['commentTier']);
    expect(commitCapabilities('a.pdf', [{ ...page, rotation: 90, annotations: [{} as never] }], 2))
      .toEqual(['pageTier', 'commentTier']);
  });

  it('App hands the commit the ungated engine transport', async () => {
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const call = app.slice(app.indexOf('return commitPageEdits({'), app.indexOf('if (!outcome) throw'));
    expect(call).toContain('sealed: callRaw');
    expect(app).toContain('setSealedReader(callRaw)');
  });
});

describe('field creation routing', () => {
  const spec: NewFieldSpec = { type: 'text', name: 'plain', pageIndex: 0, rect: [50, 700, 250, 724] };

  async function run(sealedFile: boolean) {
    const plain = await pdfOf([600]);
    const disk = new Map<string, Uint8Array>([['work', sealedFile ? CIPHERTEXT : plain.slice()]]);
    const f: OpenFile = { path: 'source', workingPath: 'work', name: 'source', buffer: disk.get('work')!,
      pageCount: 1, dirty: false, undoStack: [], redoStack: [], ...(sealedFile ? { security: USER_OPENED } : {}) };
    const store = createAppStore({ ...initialState, activeFileId: f.path, files: new Map([[f.path, f]]) });
    const calls: string[] = [];
    setStageCredentialCaller(async (method) => { calls.push(method); return { shared: true }; });
    const io: FormCreateIo = {
      confirm: async () => true,
      commit: async () => {},
      read: async (path) => disk.get(path)!.slice(),
      write: vi.fn(async (path, bytes) => { disk.set(path, bytes.slice()); }),
      remove: async (path) => { disk.delete(path); },
      fontDirectory: async () => 'fonts',
      index: readingWith(async (bytes) => (await PDFDocument.load(bytes)).getPageCount()),
      callStaged: vi.fn(async (method, params) => {
        calls.push(method);
        if (method === 'sealed_plaintext') {
          expect(params).toEqual({ path: 'work', capabilities: ['formAuthoring'] });
          return { data: bytesToBase64(plain) };
        }
        if (method === 'sealed_reseal') {
          expect(params.capabilities).toEqual(['formAuthoring']);
          disk.set(params.output as string, base64ToBytes(params.data as string));
          return { output: params.output };
        }
        return { output: params.output, fields: params.fields };
      }),
      transaction: {
        publish: async (id, [entry]) => {
          disk.set('work', disk.get(entry.stagedPath)!.slice());
          return { status: 'committed', snapshots: [`backup-${id}`], detail: '' };
        },
        abort: async () => ({ status: 'rolledBack', snapshots: [], detail: '' }),
        acknowledge: async () => {},
      },
    };
    const done = await createFormFields('source', [spec], store.getState, (a) => store.dispatch(a), io);
    setStageCredentialCaller(null);
    const fields = (await PDFDocument.load(disk.get('work')!)).getForm().getFields().map((x) => x.getName());
    return { done, calls, write: io.write, fields };
  }

  it('routes a user-opened document through the engine doors', async () => {
    const r = await run(true);
    expect(r.done).toBe(true);
    expect(r.calls.slice(0, 3)).toEqual(['share_document', 'sealed_plaintext', 'sealed_reseal']);
    expect(new Set(r.calls.slice(3))).toEqual(new Set(['close_document']));
    expect(r.write).not.toHaveBeenCalled();
    expect(r.fields).toEqual(['plain']);
  });

  it('keeps an unencrypted document on the pdf-lib write', async () => {
    const r = await run(false);
    expect(r.done).toBe(true);
    expect(r.calls).toEqual([]);
    expect(r.write).toHaveBeenCalledTimes(1);
    expect(r.fields).toEqual(['plain']);
  });
});

describe('health sweep password', () => {
  it('hands the stored password to the begin request only when there is one', async () => {
    const seen: Record<string, unknown>[] = [];
    const dispatch = async (method: string, params: Record<string, unknown>) => {
      if (method === 'document_health_begin') seen.push(params);
      return { token: '', done: true, status: 'collected', pages: 0, facts: [] };
    };
    const gate = <R,>(send: () => Promise<R>) => send();
    await runHealthSweep(dispatch, 'scratch.pdf', gate, 'reader-pw');
    await runHealthSweep(dispatch, 'scratch.pdf', gate);
    expect(seen).toEqual([{ file: 'scratch.pdf', password: 'reader-pw' }, { file: 'scratch.pdf' }]);
  });

  it('the health hook reads the password for the path it sweeps', async () => {
    const { readFileSync } = await import('node:fs');
    const hook = readFileSync(new URL('../src/renderer/hooks/useDocumentHealth.ts', import.meta.url), 'utf8');
    expect(hook).toContain('collectHealth(buffer, isCurrent, documentPassword(path))');
    const engine = readFileSync(new URL('../src/renderer/hooks/useEngine.ts', import.meta.url), 'utf8');
    expect(engine).toContain('runHealthSweep(dispatch, path, gate, password)');
  });
});

describe('removed dead code', () => {
  it('drops the unlock queue label', async () => {
    const { readFileSync } = await import('node:fs');
    const queue = readFileSync(new URL('../src/renderer/hooks/useOperationQueue.tsx', import.meta.url), 'utf8');
    expect(queue).not.toMatch(/unlock: 'Unlock'|case 'unlock'/);
  });
});

describe('raw annotation styles of an encrypted file', () => {
  it('reads names but never ciphertext strings', async () => {
    const { PDFName, PDFString } = await import('pdf-lib');
    const { readRawAnnotationStyles } = await import('../src/renderer/lib/annotation-raw-style');
    const build = async (encrypted: boolean) => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([300, 300]);
      const annot = pdf.context.obj({
        Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 50, 50],
        Subj: PDFString.of('Group A'), SpectraInkStyle: PDFName.of('highlighter'),
      });
      page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annot)]));
      if (encrypted) pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard' }));
      return pdf.save({ useObjectStreams: false });
    };
    const plain = (await readRawAnnotationStyles(await build(false)))![0][0];
    expect(plain.subj).toBe('Group A');
    const sealed = (await readRawAnnotationStyles(await build(true)))![0][0];
    expect(sealed.subj).toBeUndefined();
    expect(sealed.spectraInkStyle).toBe('highlighter');
  });
});
