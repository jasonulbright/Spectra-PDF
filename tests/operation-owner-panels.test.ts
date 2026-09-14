import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createOwnedOperationRuns } from '../src/renderer/lib/owned-operation-run';
import { assertOperationIntent } from '../src/renderer/lib/operation-intent';
import { parsePageScope, summarizeContentCrop } from '../src/renderer/lib/content-crop';
import { parsePageRangeField } from '../src/renderer/lib/page-range';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';
import type { PerformOperation } from '../src/renderer/hooks/useOperations';
import type { WorkspaceOperationResult } from '../src/renderer/lib/operation-transaction';

const cases = [
  ['HeaderFooterPanel', 'handleApply'], ['WatermarkPanel', 'handleApply'],
  ['FlattenerPanel', 'apply'], ['PrinterMarksPanel', 'addMarks'],
  ['PreflightPanel', 'runFix'], ['ScanEnhancePanel', 'apply'],
  ['AttachmentsPanel', 'handleAdd'], ['CommentsPanel', 'importXfdf'],
  ['PortfolioPanel', 'handleAddMember'], ['PortfolioPanel', 'handleUpdateMember'],
  ['PageBoxesPanel', 'runAuto'],
] as const;
const sources = new Map<string, ts.SourceFile>();
function callback(panel: string, name: string, bindings: Record<string, unknown>): (...args: unknown[]) => Promise<unknown> {
  const path = `src/renderer/panels/${panel}.tsx`;
  let source = sources.get(path);
  if (!source) { source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); sources.set(path, source); }
  const found: ts.VariableDeclaration[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(found).toHaveLength(1);
  const initializer = found[0].initializer;
  if (!initializer || !ts.isCallExpression(initializer)) throw new Error(`Missing callback ${name}`);
  const code = ts.transpileModule(`const result=${initializer.arguments[0].getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), `${code};return result;`)(...Object.values(bindings));
}

describe('real panel gestures own prerequisites and native pickers', () => {
  for (const [panel, name] of cases) {
    const picker = ['AttachmentsPanel', 'CommentsPanel', 'PortfolioPanel'].includes(panel);
    it.each(['control', 'reopen', 'cancel', ...(picker ? ['picker-cancel'] : [])])(`${panel}.${name}: %s`, async mode => {
      const file: OpenFile = { path: 'A.pdf', workingPath: 'work-A.pdf', name: 'A', buffer: new Uint8Array([1]),
        pageCount: 3, dirty: false, undoStack: [], redoStack: [] };
      let state: AppState = { ...initialState, activeFileId: file.path, files: new Map([[file.path, file]]) };
      const owners = createOwnedOperationRuns(() => state);
      let release!: (value: string | null) => void;
      const prerequisite = new Promise<string | null>(resolve => { release = resolve; });
      const operation = vi.fn<PerformOperation>(async (path, _method, _params, options) => {
        options!.assertActive!(); assertOperationIntent(state, options!.intent!);
        expect(path).toBe(file.path);
        const publication = { ...file, buffer: new Uint8Array([2]) };
        state = { ...state, files: new Map([[path, publication]]) };
        return { output: file.workingPath, publication, name: 'member.pdf', added: 1, skipped: [],
          pages: [], pages_stamped: 3, pages_watermarked: 3 } as unknown as WorkspaceOperationResult;
      });
      const status = vi.fn(), busy = vi.fn();
      const bindings: Record<string, unknown> = {
        activeFile: file, filePath: file.path, pageInput: 'all', beginRun: () => owners.begin(file),
        performOperation: operation, setBusy: busy, setApplying: busy, setStatus: status,
        tChrome: (key: string) => key, tChromeCount: (key: string) => key, EDIT_DECLINED: 'edit-declined',
        app: { getEditFontPath: () => prerequisite, getTesseractPath: async () => '' },
        dialog: { pickAnyFile: () => prerequisite },
        slots: { tl: 'SCOPE' }, SLOTS: [{ pos: 'tl' }], fontSize: 10, margin: 24, color: '#000000', batesStart: 1, batesDigits: 6,
        source: 'text', text: 'SCOPE', imagePath: '', pdfPath: '', pdfPage: 1, opacity: 1, angle: 0, layer: 'over',
        scale: 1, position: 'center', tile: false, tileGap: 24, writing: 'horizontal', writingParams: () => ({}),
        resolvedColumns: () => null, setColumns: vi.fn(), invalidate: vi.fn(), balance: 50, dpi: 300,
        requireGsPath: async () => 'gs', outlines: { text: false, strokes: false },
        kinds: ['crop'], style: 'western', weight: .25, offset: 9, length: 18, markGrowth: () => 54,
        tools: async () => { await prerequisite; return {}; }, report: null,
        toolPaths: async () => { await prerequisite; return {}; }, params: {}, problem: null, counts: { changing: 3 },
        box: 'crop', parsePageScope, parsePageRangeField, summarizeContentCrop, setAutoPreview: vi.fn(), gsPathIfAvailable: () => prerequisite,
      };
      if (panel === 'PortfolioPanel') {
        bindings.addWithSource = callback(panel, 'addWithSource', bindings);
        bindings.updateWithSource = callback(panel, 'updateWithSource', bindings);
      }
      const handler = callback(panel, name, bindings);
      const request = handler(panel === 'PortfolioPanel' ? 'member.pdf' : false);
      expect(operation).not.toHaveBeenCalled();
      if (mode === 'reopen') state = { ...state, files: new Map([[file.path, { ...file, workingPath: 'work-reopened.pdf', buffer: new Uint8Array([9]) }]]) };
      // For capability paths, cancellation is an owner teardown; for picker
      // paths it is the real null answer. Neither is a successful mutation.
      if (mode === 'cancel') owners.deactivate();
      release(mode === 'cancel' || mode === 'picker-cancel' ? null : 'picked-source.pdf'); await request;
      expect(operation).toHaveBeenCalledTimes(mode === 'control' ? 1 : 0);
      expect(busy).toHaveBeenLastCalledWith(false);
      if (mode === 'reopen') expect(state.files.get(file.path)!.buffer).toEqual(new Uint8Array([9]));
      expect(status.mock.calls.flat()).not.toContain(undefined);
      if (mode === 'picker-cancel') {
        expect(state.files.get(file.path)).toBe(file);
        const next = owners.begin(file);
        expect(next).not.toBeNull(); next!.finish();
      }
    });
  }
});
