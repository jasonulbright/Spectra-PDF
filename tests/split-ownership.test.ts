import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createOwnedDocumentRuns } from '../src/renderer/lib/owned-document-run';
import { splitBookmarkCount } from '../src/renderer/lib/split-bookmarks';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';

const path = 'src/renderer/panels/SplitPanel.tsx';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback<T>(name: string, bindings: Record<string, unknown>): T {
  const found: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found.length !== 1 || !found[0].initializer || !ts.isCallExpression(found[0].initializer))
    throw new Error(`Missing unique production callback ${name}`);
  const code = ts.transpileModule(`const result = ${found[0].initializer.arguments[0].getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), `${code}; return result;`)(...Object.values(bindings)) as T;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(mode = 'ranges') {
  const file: OpenFile = { path: 'source.pdf', name: 'source.pdf', workingPath: 'working.pdf',
    buffer: new Uint8Array([1]), pageCount: 3, dirty: false, undoStack: [], redoStack: [] };
  let state: AppState = { ...initialState, activeFileId: file.path, files: new Map([[file.path, file]]) };
  const runs = createOwnedDocumentRuns(() => state);
  const status = vi.fn(), busy = vi.fn();
  const gate = vi.fn(async () => {}), beforeDispatch = vi.fn(async () => {});
  const transport = vi.fn(async (_method: string, params: Record<string, unknown>) =>
    ({ ok: true, parts: 1, pages_extracted: 1, outputs: [params.output], oversize: [], retained_files: [] as string[] }));
  const call = async (method: string, params: Record<string, unknown>, options: { assertCurrent(): void }) => {
    await beforeDispatch(); options.assertCurrent(); return transport(method, params);
  };
  const saveFile = vi.fn(async () => 'Chosen report.pdf' as string | null);
  const pickFolder = vi.fn(async () => 'Chosen folder' as string | null);
  const shared = { activeFile: file, beginRun: () => runs.begin(file), mode, ranges: '1', everyN: 1, maxMb: 5,
    runCommitGate: gate, call, setStatus: status, setBusy: busy,
    tChrome: (key: string, params?: unknown) => `${key}:${JSON.stringify(params)}`,
    tChromeCount: (key: string) => key };
  const performSplit = callback<(choose: () => Promise<unknown>) => Promise<void>>('performSplit', shared);
  const handle = callback<() => Promise<void>>('handleSplit', { ...shared, performSplit, saveFile, dialog: { pickFolder } });
  return { file, state: () => state, change: (patch: Partial<AppState>) => { state = { ...state, ...patch }; },
    runs, gate, beforeDispatch, transport, saveFile, pickFolder, status, busy, handle };
}
async function flush() { for (let n = 0; n < 10; n++) await Promise.resolve(); }

describe('Split owns its source and exact picker destination', () => {
  it('passes the selected file rather than its parent or a generated sibling', async () => {
    const f = fixture(); await f.handle();
    expect(f.transport).toHaveBeenCalledExactlyOnceWith('split', {
      file: 'working.pdf', output: 'Chosen report.pdf', mode: 'ranges', ranges: '1',
    });
    expect(f.pickFolder).not.toHaveBeenCalled();
  });
  it.each(['every_n', 'size', 'bookmarks'])('retains folder semantics for %s', async mode => {
    const f = fixture(mode); await f.handle();
    expect(f.saveFile).not.toHaveBeenCalled();
    expect(f.transport.mock.calls[0][1]).toMatchObject({ file: 'working.pdf', output_dir: 'Chosen folder', mode });
    expect(f.transport.mock.calls[0][1]).not.toHaveProperty('output');
  });
  it('reserves before the picker and releases after cancellation', async () => {
    const f = fixture(), answer = deferred<string | null>(); f.saveFile.mockImplementationOnce(() => answer.promise);
    const run = f.handle(); await flush(); await f.handle(); expect(f.saveFile).toHaveBeenCalledTimes(1);
    answer.resolve(null); await run; expect(f.transport).not.toHaveBeenCalled();
    await f.handle(); expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it.each(['picker', 'lock'])('refuses replaced bytes at the %s boundary', async boundary => {
    const f = fixture();
    const replace = () => f.change({ files: new Map([[f.file.path, { ...f.file, buffer: new Uint8Array([9]) }]]) });
    if (boundary === 'picker') f.saveFile.mockImplementationOnce(async () => { replace(); return 'chosen.pdf'; });
    else f.beforeDispatch.mockImplementationOnce(async () => replace());
    await f.handle(); expect(f.transport).not.toHaveBeenCalled();
  });
  it('rejects changed sessions, dirty pages and tab switches', async () => {
    for (const patch of [ { activeFileId: 'other.pdf' }, { pageDirtyPaths: ['source.pdf'] },
      { files: new Map<string, OpenFile>() } ]) {
      const f = fixture(); f.saveFile.mockImplementationOnce(async () => { f.change(patch); return 'chosen.pdf'; });
      await f.handle(); expect(f.transport).not.toHaveBeenCalled();
    }
  });
  it('accepts its own authored commit before asking for a destination', async () => {
    const f = fixture(), buffer = new Uint8Array([3]); f.change({ pageDirtyPaths: [f.file.path] });
    f.gate.mockImplementationOnce(async () => f.change({ pageDirtyPaths: [], files: new Map([[f.file.path, {
      ...f.file, buffer, authoredIdentity: { sourceBuffer: f.file.buffer!, buffer, pages: [], documents: [] },
    }]]) }));
    await f.handle(); expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it('does not display late success on another document', async () => {
    const f = fixture(), reply = deferred<Awaited<ReturnType<typeof f.transport>>>();
    f.transport.mockImplementationOnce(() => reply.promise); const run = f.handle(); await flush();
    f.change({ activeFileId: 'other.pdf' }); f.status.mockClear();
    reply.resolve({ ok: true, parts: 1, pages_extracted: 1, outputs: [], oversize: [], retained_files: [] });
    await run; expect(f.status).not.toHaveBeenCalled();
  });
  it('reports retained recovery files without calling saved output a failed operation', async () => {
    const f = fixture(); f.transport.mockResolvedValueOnce({ ok: true, parts: 1, pages_extracted: 1,
      outputs: [], oversize: [], retained_files: ['retained.backup'] });
    await f.handle(); const result = f.status.mock.calls.at(-1)![0] as string;
    expect(result).toContain('panel.split.done'); expect(result).toContain('panel.split.retainedFiles');
    expect(result).toContain('retained.backup'); expect(result).not.toContain('panel.common.error');
  });
});

describe('Split bookmark facts fail closed', () => {
  it('distinguishes valid empty and resolved top-level destinations', () => {
    expect(splitBookmarkCount({ count: 0, truncated: false, outline: [] }, 3)).toBe(0);
    expect(splitBookmarkCount({ count: 3, truncated: false, outline: [{ page: 1 }, { page: null }, { page: 3 }] }, 3)).toBe(2);
  });
  it.each([null, {}, { ok: false, truncated: false, outline: [] }, { ok: true, outline: [] },
    { ok: true, truncated: true, outline: [] }, { ok: true, truncated: false, outline: null },
    ...[{}, [], { page: 0 }, { page: 4 }, { page: 1.5 }, { page: '1' }].map(item =>
      ({ ok: true, truncated: false, outline: [item] }))])('does not turn malformed data into absence: %j', reply => {
    expect(splitBookmarkCount(reply, 3)).toBeNull();
  });
});
