import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { assertOperationGateResult, assertOperationIntent, captureFileOperationIntent } from '../src/renderer/lib/operation-intent';
import { initialState } from '../src/renderer/state/reducer';
import { withDocumentWrite, __documentWriteCount } from '../src/renderer/lib/document-writes';
import type { AppState, OpenFile } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import type { WorkspaceOperationResult } from '../src/renderer/lib/operation-transaction';

const source = ts.createSourceFile('src/renderer/App.tsx', readFileSync('src/renderer/App.tsx', 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, bindings: Record<string, unknown>): (...args: unknown[]) => Promise<unknown> {
  const found: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(found).toHaveLength(1);
  const initializer = found[0].initializer;
  if (!initializer || !ts.isCallExpression(initializer)) throw new Error(`Missing callback ${name}`);
  const code = ts.transpileModule(`const result=${initializer.arguments[0].getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), `${code};return result;`)(...Object.values(bindings));
}

const cases: [string, string, (run: (...args: unknown[]) => Promise<unknown>) => Promise<unknown>][] = [
  ['widget reset', 'handleWidgetAction', run => run('A.pdf', 'f', { kind: 'reset' })],
  ['widget import', 'handleWidgetAction', run => run('A.pdf', 'f', { kind: 'import', file: 'x.fdf' })],
  ['widget submit reply', 'handleWidgetAction', run => run('A.pdf', 'f', { kind: 'submit', format: 'fdf', includeEmpty: false })],
  ['sanitize', 'handleSanitizeDocument', run => run('A.pdf', { categories: [], formFieldsMode: 'keep', includeOcrLayer: false,
    signatures: { count: 1, document_timestamps: 0, certification: null } })],
  ['convert text run', 'handleEditText', run => run('A.pdf', 1, 0, 'x', { convert: true })],
  ['edit paragraph', 'handleEditParagraph', run => run('A.pdf', 1, { index: 0, runs: [0], text: 'a' }, 'b', [])],
  ['merge paragraph', 'handleMergeParagraph', run => run('A.pdf', 1, { index: 0, runs: [0], text: 'a' }, { index: 1, runs: [1], text: 'b' })],
  ['add text', 'handleAddText', run => run('A.pdf', 1, [0, 0, 10, 10], 'x')],
];

describe('App write wrappers own the gesture session across their awaits', () => {
  for (const [label, name, invoke] of cases) {
    it.each(['control', 'reopen'])(`${label}: %s`, async mode => {
      const file: OpenFile = { path: 'A.pdf', workingPath: 'work-A.pdf', name: 'A', buffer: new Uint8Array([1]),
        pageCount: 3, dirty: false, undoStack: [], redoStack: [] };
      let state: AppState = { ...initialState, activeFileId: file.path, files: new Map([[file.path, file]]) };
      const readState = () => state;
      let release!: () => void, reached = false;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const wait = async <T,>(value: T) => { reached = true; await gate; return value; };
      const published: string[] = [];
      const operation = vi.fn<PerformOperation>(async (path, _method, _params, options) => {
        if (options?.intent) assertOperationIntent(state, options.intent);
        else if (options?.expectedWorkingPath === undefined) throw new Error('unowned write');
        const current = state.files.get(path)!;
        if (options?.expectedWorkingPath !== undefined && current.workingPath !== options.expectedWorkingPath) throw new Error('session changed');
        published.push(current.workingPath);
        return { output: current.workingPath, publication: current } as unknown as WorkspaceOperationResult;
      });
      const bindings: Record<string, unknown> = {
        state, readState, tChrome: (key: string) => key, tChromeCount: (key: string) => key, EDIT_DECLINED: Symbol('declined'),
        captureFileOperationIntent,
        app: { getEditFontPath: () => wait('fonts') }, dialog: { pickFormDataFile: () => wait('data.fdf') },
        showProceedConfirm: () => wait(true), showNotice: async () => {},
        call: async () => ({ count: 1 }), showSubmitConsent: async () => true, openByPaths: async () => {},
        copyToClipboard: async () => {}, file: { remove: async () => {} }, batch: {},
        runSubmission: async (deps: { importFormData: (data: string) => Promise<void> }) => {
          await wait(undefined); await deps.importFormData('reply.fdf');
        },
        performOperation: operation, lockNeedsFields: () => false, toEngineFormat: (x: unknown) => x, toEngineAction: (x: unknown) => x,
      };
      bindings.gestureIntent = callback('gestureIntent', bindings);
      bindings.writeGesture = callback('writeGesture', { ...bindings, withDocumentWrite });
      const settled = invoke(callback(name, bindings)).then(() => 'ok', (error: unknown) => String(error));
      for (let i = 0; i < 50 && !reached; i++) await new Promise(resolve => setTimeout(resolve, 0));
      expect(reached).toBe(true);
      expect(operation).not.toHaveBeenCalled();
      // Recorded from the handler's first line: a move of the document waits.
      expect(__documentWriteCount()).toBe(1);
      if (mode === 'reopen') {
        state = { ...state, files: new Map([[file.path, { ...file, workingPath: 'work-A-reopened.pdf', buffer: new Uint8Array([3]) }]]) };
      }
      release();
      const outcome = await settled;
      expect(__documentWriteCount()).toBe(0);
      if (mode === 'control') {
        expect(outcome).toBe('ok');
        expect(published).toEqual(['work-A.pdf']);
      } else {
        expect(outcome).not.toBe('ok');
        expect(published).toEqual([]);
      }
    });
  }
});

describe('image extraction reads only the revision the gesture addressed', () => {
  it.each(['control', 'reopen', 'revision'])('%s', async mode => {
    const file: OpenFile = { path: 'A.pdf', workingPath: 'work-A.pdf', name: 'A', buffer: new Uint8Array([1]),
      pageCount: 3, dirty: false, undoStack: [], redoStack: [] };
    let state: AppState = { ...initialState, activeFileId: file.path, files: new Map([[file.path, file]]) };
    let release!: () => void, reached = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reads: string[] = [];
    const bindings: Record<string, unknown> = {
      state, readState: () => state, tChrome: (key: string) => key, EDIT_DECLINED: Symbol('declined'),
      captureFileOperationIntent, assertOperationGateResult, runCommitGate: async () => {},
      dialog: { saveImageFile: async () => { reached = true; await gate; return 'C:/out/photo.png'; } },
      call: async (_method: string, params: { file: string }) => { reads.push(params.file); return { output: 'C:/out/photo.png' }; },
      performOperation: async () => { throw new Error('no write expected'); }, performImageEdit: async () => false,
    };
    bindings.gestureIntent = callback('gestureIntent', bindings);
    bindings.writeGesture = callback('writeGesture', { ...bindings, withDocumentWrite });
    const settled = callback('handleEditImage', bindings)('extract', 'A.pdf', 1, 0).then(() => 'ok', (error: unknown) => String(error));
    for (let i = 0; i < 50 && !reached; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(reached).toBe(true);
    if (mode === 'reopen') state = { ...state, files: new Map([[file.path, { ...file, workingPath: 'work-A-reopened.pdf', buffer: new Uint8Array([3]) }]]) };
    if (mode === 'revision') state = { ...state, files: new Map([[file.path, { ...file, buffer: new Uint8Array([2]) }]]) };
    release();
    const outcome = await settled;
    expect(reads).toEqual(mode === 'control' ? ['work-A.pdf'] : []);
    expect(outcome === 'ok').toBe(mode === 'control');
  });
});
