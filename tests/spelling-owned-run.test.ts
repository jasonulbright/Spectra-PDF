import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createOwnedOperationRuns } from '../src/renderer/lib/owned-operation-run';
import { inspectOperationInput } from '../src/renderer/lib/operation-input';
import { spellingCommentTarget } from '../src/renderer/lib/spelling-comment-target';
import { placementDocsCurrent } from '../src/renderer/lib/form-overlay';
import { paragraphFix, replaceRange, wordAt, type SpellIssue } from '../src/renderer/lib/spellcheck';
import { createAppStore } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';
import type { OpenFile, PageRef } from '../src/renderer/state/types';
import type { OperationOptions } from '../src/renderer/lib/operation-transaction';
import type { FormFillOptions } from '../src/renderer/lib/form-fill-transaction';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';

const path = 'src/renderer/panels/SpellingPanel.tsx';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, bindings: Record<string, unknown>) {
  const found: ts.VariableDeclaration[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source); expect(found).toHaveLength(1);
  const initializer = found[0].initializer;
  if (!initializer || !ts.isCallExpression(initializer)) throw new Error(name);
  const code = ts.transpileModule(`const fn=${initializer.arguments[0].getText(source)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), `${code};return fn;`)(...Object.values(bindings));
}

function fixture(attack: 'none' | 'late-publication' | 'read-reopen' = 'none') {
  const file: OpenFile = { path: 'A', workingPath: 'work', name: 'A', buffer: new Uint8Array([1]),
    pageCount: 1, dirty: false, undoStack: [], redoStack: [] };
  const page: PageRef = { id: 'p', sourceDocId: 'A', sourcePageIndex: 0, width: 612, height: 792, rotation: 0,
    annotations: [{ id: 'note', kind: 'note', x: 0, y: 0, w: .1, h: .1, color: '#000000', note: 'helo helo',
      importedOriginal: { subtype: 'Text', rect: [0, 0, 20, 20], contents: 'helo helo', color: '#000000', hasAppearance: false } }] };
  const store = createAppStore({ ...initialState, activeFileId: 'A', files: new Map([['A', file]]),
    workspace: { documents: [{ ...file, id: 'd', pages: [page] }] } });
  const owners = createOwnedOperationRuns(store.getState), events: string[] = [];
  const disk = new Map<string, Uint8Array>();
  let text = 'helo helo', field = 'helo helo', serial = 1;
  let indexed = { ...file, id: 'd', pages: [page] };
  const publish = () => {
    store.dispatch({ type: 'REFRESH_BUFFER', path: 'A', buffer: new Uint8Array([++serial]), pageCount: 1 });
    const next = store.getState().files.get('A')!;
    // The indexer republishes the document AFTER the buffer lands, never with
    // it, and the pages it comes back with carry a fresh generation: an edit
    // made against the index left behind does not survive the republish.
    const current = store.getState().workspace.documents.find(doc => doc.id === 'd') ?? indexed;
    indexed = { ...current, ...next, id: 'd',
      pages: current.pages.map(page => ({ ...page, id: `p#g${serial}` })) };
    const settled = indexed;
    setTimeout(() => store.dispatch({ type: 'SET_WORKSPACE_DOCUMENTS', path: 'A', documents: [settled] }), 60);
    return next;
  };
  const check = vi.fn(async () => {}), status = vi.fn(), busy = vi.fn();
  const bindings: Record<string, unknown> = {
    activeFile: file, reportSource: file, filePath: 'A', workingPath: 'work', replacement: 'hello',
    beginRun: () => owners.begin(file), readState: store.getState, dispatch: store.dispatch,
    paragraphFix, spellingCommentTarget, placementDocsCurrent, wordAt, replaceRange, EDIT_DECLINED,
    setStatus: status, setBusy: busy, check,
    tChrome: (key: string) => key, tChromeCount: (key: string, count: number) => `${key}:${count}`,
    app: { getEditFontPath: async () => 'fonts' },
    inspectSource: (run: Parameters<typeof inspectOperationInput>[0], inspect: (path: string) => Promise<unknown>) =>
      inspectOperationInput(run, { allocate: async () => 'private', write: async (path, bytes) => { disk.set(path, bytes); },
        remove: async path => { disk.delete(path); } }, inspect),
    callRaw: async (method: string, params: { file: string }) => {
      expect(params.file).toBe('private'); expect(disk.has('private')).toBe(true);
      if (attack === 'read-reopen') store.dispatch({ type: 'OPEN_FILE', path: 'A', workingPath: 'reopened', name: 'A', buffer: new Uint8Array([9]), pageCount: 1 });
      if (method === 'read_form_fields') return { fields: [{ name: 'field', value: field }] };
      expect(method).toBe('list_text_paragraphs');
      return { paragraphs: [{ index: 0, runs: [0], text, spans: [] }] };
    },
    performOperation: async (_path: string, method: string, params: { expected_text: string; new_text: string }, options: OperationOptions) => {
      options.assertActive!(); expect(options.expectedBuffer).toBe(store.getState().files.get('A')!.buffer);
      expect(method).toBe('replace_paragraph_text'); expect(params.expected_text).toBe(text);
      events.push('text'); text = params.new_text;
      const publication = publish();
      if (attack === 'late-publication') publish();
      return { publication, output: 'work' };
    },
    fillFormValues: async (_path: string, values: Record<string, string>, options: FormFillOptions) => {
      options.assertActive!(); expect(options.expectedValues).toEqual({ field });
      expect(options.expectedBuffer).toBe(store.getState().files.get('A')!.buffer);
      events.push('field'); field = values.field; return { completed: true, publication: publish() };
    },
  };
  for (const name of ['fixPageText', 'fixComment', 'fixField', 'applyOne', 'awaitAnnotationIndex']) bindings[name] = callback(name, bindings);
  return { run: callback('runFix', bindings), events, check, status, busy, disk, store,
    contents: () => ({ text, field, note: store.getState().workspace.documents[0].pages[0].annotations![0].note }) };
}
function issue(source: SpellIssue['source'], start: number): SpellIssue {
  return { source, word: 'helo', start, end: start + 4, context: 'helo helo', page: 1, paragraph: 0,
    annotation: 0, annotation_text: 'helo helo', subtype: 'Text', annotation_rect: [0, 0, 20, 20], field: 'field' };
}

describe('actual Spelling panel correction sequence', () => {
  it('preserves mixed-source Change all and two corrections within one note', async () => {
    const f = fixture();
    await f.run([issue('comments', 5), issue('text', 5), issue('fields', 5),
      issue('comments', 0), issue('text', 0), issue('fields', 0)], 'helo');
    // Read after the lagged republish has landed: an edit made against the
    // index the writes left behind does not survive it.
    await new Promise<void>(resolve => { setTimeout(resolve, 200); });
    expect(f.contents()).toEqual({ text: 'hello hello', field: 'hello hello', note: 'hello hello' });
    expect(f.events).toEqual(['text', 'field', 'text', 'field']);
    expect(f.status).toHaveBeenCalledWith('panel.spelling.changed:6');
    expect(f.store.getState().pageUndoStack).toHaveLength(2);
    expect(f.check).toHaveBeenCalledOnce(); expect(f.busy).toHaveBeenLastCalledWith(false);
    expect(f.disk.size).toBe(0);
  });
  it('never chains from a foreign publication that won before the first acknowledgement', async () => {
    const f = fixture('late-publication');
    await f.run([issue('text', 5), issue('text', 0)], 'helo');
    expect(f.events).toEqual(['text']); expect(f.check).not.toHaveBeenCalled();
    // Clear this ticket's old "changing" message, but do not report an error
    // or success against the foreign revision that replaced its publication.
    expect(f.status).toHaveBeenLastCalledWith(''); expect(f.disk.size).toBe(0);
  });
  it.each(['text', 'fields'] as const)('a reopened session during %s inspection receives no mutation', async source => {
    const f = fixture('read-reopen'); await f.run([issue(source, 0)], 'helo');
    expect(f.events).toEqual([]); expect(f.check).not.toHaveBeenCalled(); expect(f.disk.size).toBe(0);
    expect(f.store.getState().files.get('A')!.workingPath).toBe('reopened');
  });
});
