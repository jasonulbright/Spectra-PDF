import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createOwnedDocumentRuns } from '../src/renderer/lib/owned-document-run';
import { captureCanvasTextRequest, canvasTextRequestCurrent, textExtractionDisplayCurrent,
  type CanvasTextRequest } from '../src/renderer/lib/extract-text-owner';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile, PageRef } from '../src/renderer/state/types';

// Execute the actual component without a DOM. Effects flush after rendering;
// mocked seams are transport/UI only, with the production ownership authority.
const path = 'src/renderer/panels/ExtractTextPanel.tsx';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'ExtractTextPanel');
if (!component) throw new Error('Missing actual ExtractTextPanel');
const code = ts.transpileModule(component.getText(source).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
interface Node { type: string; props: Record<string, unknown>; children: unknown[] }
interface Reply { text?: string; length?: number; pages_extracted?: number; characters?: number; output?: unknown }
function find(value: unknown, predicate: (node: Node) => boolean): Node | null {
  if (!value || typeof value !== 'object') return null;
  const node = value as Node;
  if (predicate(node)) return node;
  for (const child of node.children?.flat(Infinity) ?? []) { const result = find(child, predicate); if (result) return result; }
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const file = (name: string): OpenFile => ({ path: name, name: `${name}.pdf`, workingPath: `work-${name}`,
    buffer: new Uint8Array([name.charCodeAt(0)]), pageCount: 2, dirty: false, undoStack: [], redoStack: [] });
  const a = file('A'), b = file('B');
  let state: AppState = { ...initialState, activeFileId: 'A', files: new Map([['A', a], ['B', b]]),
    workspace: { documents: [a, b].map(f => ({ ...f, id: f.path,
      pages: [1, 2].map(n => ({ id: `${f.path}-${n}` } as PageRef)) })) },
    pageDirtyPaths: [] };
  const runs = createOwnedDocumentRuns(() => state);
  let ticket: ReturnType<typeof runs.begin> = null;
  const slots: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  let cursor = 0, queued: (() => void)[] = [], tree: Node;
  const react = {
    createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    useState: <T,>(initial: T) => { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i] as T, (v: T | ((old: T) => T)) => {
        slots[i] = typeof v === 'function' ? (v as (old: T) => T)(slots[i] as T) : v;
      }]; },
    useRef: <T,>(initial: T) => { const i = cursor++; return (slots[i] ??= { current: initial }) as { current: T }; },
    useCallback: <T,>(callback: T) => { cursor++; return callback; },
    useEffect: (run: () => (() => void) | undefined, deps: unknown[]) => {
      const i = cursor++, old = effects[i];
      if (!old || deps.some((d, n) => d !== old.deps[n])) queued.push(() => {
        old?.cleanup?.(); effects[i] = { deps, cleanup: run() };
      });
    },
  };
  const transport = vi.fn(async (method: string, params: Record<string, unknown>): Promise<Reply> => method === 'extract_text'
    ? { text: `Contents of ${params.file}`, length: 18, pages_extracted: 1 }
    : { characters: 18, output: params.output });
  const beforeDispatch = vi.fn(async () => {});
  const call = vi.fn(async (method: string, params: Record<string, unknown>, options: { assertCurrent(): void }) => {
    await beforeDispatch(); options.assertCurrent(); return transport(method, params);
  });
  const saveFile = vi.fn(async () => 'chosen.txt' as string | null);
  const gate = vi.fn(async () => {}), clipboard = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  const consumed = vi.fn();
  const bindings = { React: react, ...react, useTranslation: () => {},
    useActiveFile: () => ({ activeFile: state.files.get(state.activeFileId!) ?? null, state, openNewFiles: () => {} }),
    useReadAppState: () => () => state,
    useOwnedDocumentRun: (owner: OpenFile) => {
      react.useEffect(() => { runs.activate(); return () => runs.deactivate(); }, []);
      react.useEffect(() => { ticket?.synchronize(); return undefined; }, [owner, state.pageDirtyPaths]);
      return () => { const run = runs.begin(owner); if (run) ticket = run; return run; };
    },
    useEngine: () => ({ call, saveFile }), runCommitGate: gate,
    canvasTextRequestCurrent, textExtractionDisplayCurrent,
    tChrome: (key: string) => key, NoFileOpen: 'NoFileOpen', StatusBar: 'StatusBar',
    navigator: { clipboard: { writeText: clipboard } },
  };
  const Component = new Function(...Object.keys(bindings), `${code};return ExtractTextPanel;`)(...Object.values(bindings));
  let request: CanvasTextRequest | null = null;
  const render = () => { cursor = 0; queued = []; tree = Component({ initialRequest: request, onConsumeInitialRequest: consumed });
    for (const effect of queued) effect(); return tree; };
  const click = (name: 'extract' | 'save' | 'copy') => {
    const button = find(tree, n => n.type === 'button' && (name === 'save'
      ? n.props['data-testid'] === 'extract-text-save' : n.children.includes(`panel.extractText.${name}`)));
    if (!button) throw new Error(`Missing ${name}`);
    return (button.props.onClick as () => Promise<void>)();
  };
  const text = () => find(tree, n => n.type === 'textarea')?.props.value;
  const change = (patch: Partial<AppState>) => { state = { ...state, ...patch }; };
  const pages = (value: string) => {
    (find(tree, n => n.type === 'input')!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } }); render();
  };
  render();
  return { a, b, render, click, text, change, pages, call, transport, beforeDispatch, gate, saveFile, clipboard, consumed,
    state: () => state, auto: (value: CanvasTextRequest) => { request = value; render(); },
    dispose: () => runs.deactivate() };
}
async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve(); }

describe('Extract Text owns visible text, queued requests and output authority', () => {
  it('extracts, copies and exports the faithful document through the shared door', async () => {
    const f = fixture(); await f.click('extract'); f.render(); expect(f.text()).toBe('Contents of work-A');
    await f.click('copy'); expect(f.clipboard).toHaveBeenCalledWith('Contents of work-A');
    await f.click('save'); expect(f.transport).toHaveBeenLastCalledWith('export_document', {
      file: 'work-A', output: 'chosen.txt', fmt: 'txt', pages: 'all' });
  });
  it.each(['tab', 'buffer', 'session', 'dirty', 'selection'])('hides old text immediately after %s changes', async change => {
    const f = fixture(); await f.click('extract'); f.render(); expect(f.text()).toBeTruthy();
    if (change === 'tab') f.change({ activeFileId: 'B' });
    if (change === 'buffer') f.change({ files: new Map([['A', { ...f.a, buffer: new Uint8Array([9]) }]]) });
    if (change === 'session') f.change({ files: new Map([['A', { ...f.a, workingPath: 'reopened-A' }]]) });
    if (change === 'dirty') f.change({ pageDirtyPaths: ['A'] });
    if (change === 'selection') f.pages('2');
    f.render(); expect(f.text()).toBeUndefined();
  });
  it.each(['tab', 'buffer', 'selection', 'unmount', 'A-B-A'])('rejects a late manual reply after %s', async change => {
    const f = fixture(), answer = deferred<Reply>(); f.transport.mockImplementationOnce(() => answer.promise);
    const run = f.click('extract'); await flush();
    if (change === 'tab') f.change({ activeFileId: 'B' });
    if (change === 'buffer') f.change({ files: new Map([['A', { ...f.a, buffer: new Uint8Array([8]) }]]) });
    if (change === 'selection') f.pages('2');
    if (change === 'unmount') f.dispose();
    if (change === 'A-B-A') { f.change({ activeFileId: 'B' }); f.render(); f.change({ activeFileId: 'A' }); f.render(); }
    answer.resolve({ text: 'OLD', length: 3, pages_extracted: 1 }); await run; f.render();
    expect(f.text()).toBeUndefined();
  });
  it('reserves before the picker, cancels overlap, and keeps preview on cancellation', async () => {
    const f = fixture(); await f.click('extract'); f.render(); const answer = deferred<string | null>();
    f.saveFile.mockImplementationOnce(() => answer.promise);
    const first = f.click('save'); await flush(); await f.click('save');
    expect(f.saveFile).toHaveBeenCalledTimes(1); answer.resolve(null); await first; f.render();
    expect(f.text()).toBe('Contents of work-A'); expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it.each(['picker', 'lock'])('refuses source replacement during the %s await before export', async boundary => {
    const f = fixture(); const replace = async () => { f.change({ files: new Map([['A', { ...f.a, buffer: new Uint8Array([8]) }]]) }); };
    if (boundary === 'picker') f.saveFile.mockImplementationOnce(async () => { await replace(); return 'chosen.txt'; });
    else f.beforeDispatch.mockImplementationOnce(replace);
    await f.click('save'); expect(f.transport).not.toHaveBeenCalled();
  });
  it('does not revive a request after the page input changes away and back', async () => {
    const f = fixture(), answer = deferred<string | null>(); f.saveFile.mockImplementationOnce(() => answer.promise);
    const run = f.click('save'); await flush(); f.pages('2'); f.pages('all'); answer.resolve('chosen.txt'); await run;
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('accepts its authored page commit before extracting the selected page', async () => {
    const f = fixture(); f.pages('2'); f.change({ pageDirtyPaths: ['A'] });
    const buffer = new Uint8Array([2]);
    f.gate.mockImplementationOnce(async () => f.change({ pageDirtyPaths: [], files: new Map([['A', {
      ...f.a, buffer, authoredIdentity: { sourceBuffer: f.a.buffer!, buffer, pages: [], documents: [] },
    }]]) }));
    await f.click('extract'); f.render(); expect(f.text()).toBe('Contents of work-A');
    expect(f.transport).toHaveBeenCalledWith('extract_text', { file: 'work-A', pages: [2] });
  });
  it('consumes one canvas request once and rejects a stale original view', async () => {
    const f = fixture(), request = captureCanvasTextRequest(f.state(), 'A', 2)!;
    f.change({ activeFileId: 'B' }); f.auto(request); await flush(); f.render();
    expect(f.consumed).toHaveBeenCalledExactlyOnceWith(request); expect(f.transport).not.toHaveBeenCalled();
  });
  it('holds a canvas request during an active run and executes it exactly once afterward', async () => {
    const f = fixture(), answer = deferred<Reply>(); f.transport.mockImplementationOnce(() => answer.promise);
    const first = f.click('extract'); await flush(); f.render();
    const request = captureCanvasTextRequest(f.state(), 'A', 2)!; f.auto(request);
    expect(f.consumed).not.toHaveBeenCalled(); answer.resolve({ text: 'first', length: 5, pages_extracted: 2 });
    await first; f.render(); await flush(); f.render(); await flush(); f.render();
    expect(f.consumed).toHaveBeenCalledExactlyOnceWith(request); expect(f.transport).toHaveBeenCalledTimes(2);
    expect(f.transport).toHaveBeenLastCalledWith('extract_text', { file: 'work-A', pages: [2] });
    expect(f.text()).toBe('Contents of work-A');
  });
  it('canvas view identity includes all same-file partitions and refuses changed topology', () => {
    const f = fixture(), [a, b] = f.state().workspace.documents;
    f.change({ workspace: { documents: [{ ...a, id: 'first', pages: [a.pages[0]] },
      { ...a, id: 'second', pages: [a.pages[1]] }, b] } });
    const request = captureCanvasTextRequest(f.state(), 'A', 2)!;
    expect(request.documents).toHaveLength(2);
    expect(canvasTextRequestCurrent(request, f.state())).toBe(true);
    f.change({ workspace: { documents: f.state().workspace.documents.map(doc => doc.path === 'A' ? { ...doc, pages: [...doc.pages].reverse() } : doc) } });
    expect(canvasTextRequestCurrent(request, f.state())).toBe(false);
    expect(captureCanvasTextRequest(f.state(), 'A', 3)).toBeNull();
  });
  it('does not bind a canvas page to an index from an older buffer', () => {
    const f = fixture(); f.change({ files: new Map([['A', { ...f.a, buffer: new Uint8Array([9]) }]]) });
    expect(captureCanvasTextRequest(f.state(), 'A', 1)).toBeNull();
  });
  it('does not rebind a waiting canvas request when the active document changes', async () => {
    const f = fixture(), answer = deferred<Reply>(); f.transport.mockImplementationOnce(() => answer.promise);
    const first = f.click('extract'); await flush(); f.render();
    const request = captureCanvasTextRequest(f.state(), 'A', 2)!; f.auto(request);
    f.change({ activeFileId: 'B' }); f.render();
    answer.resolve({ text: 'OLD', length: 3, pages_extracted: 1 }); await first;
    f.render(); await flush(); f.render();
    expect(f.transport).toHaveBeenCalledTimes(1); expect(f.text()).toBeUndefined();
    expect(f.consumed).toHaveBeenCalledExactlyOnceWith(request);
  });
  it('handles a clipboard refusal without falsely reporting a completed copy', async () => {
    const f = fixture(); await f.click('extract'); f.render();
    f.clipboard.mockRejectedValueOnce(new Error('clipboard denied'));
    await expect(f.click('copy')).resolves.toBeUndefined();
    const tree = f.render(); expect(find(tree, n => n.type === 'StatusBar')!.props.message).toBe('panel.common.error');
  });
  it('shows a same-document revision refusal while hiding stale preview and success', async () => {
    const f = fixture(); await f.click('extract'); f.render();
    f.beforeDispatch.mockImplementationOnce(async () => f.change({ pageDirtyPaths: ['A'] }));
    await f.click('save'); const tree = f.render();
    expect(f.transport).toHaveBeenCalledTimes(1); expect(f.text()).toBeUndefined();
    expect(find(tree, n => n.type === 'StatusBar')!.props.message).toBe('panel.common.error');
  });
});
