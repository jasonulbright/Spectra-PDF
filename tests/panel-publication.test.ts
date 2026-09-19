import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { PDFDocument, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { createAppStore } from '../src/renderer/state/store';
import { initialState } from '../src/renderer/state/reducer';
import type { OpenFile } from '../src/renderer/state/types';
import { fillFormValues } from '../src/renderer/lib/form-fill-transaction';
import { executeWorkspaceOperation } from '../src/renderer/lib/operation-transaction';
import { createOwnedOperationRuns } from '../src/renderer/lib/owned-operation-run';
import { inspectOperationInput } from '../src/renderer/lib/operation-input';
import { EDIT_DECLINED } from '../src/renderer/lib/edit-text';
import { isOpMethod, sequenceEditClass } from '../src/renderer/lib/op-edit-class';
import { STEP_CATALOG, stepDefFor, engineMethodFor, buildStepParams, newStep, planAction, gsBlocker, gsPathFor } from '../src/renderer/lib/guided-actions';
import { writtenRoots } from '../src/renderer/lib/output-root-claim';
import { replaceRange, wordAt } from '../src/renderer/lib/spellcheck';
import { createArticleDrafts } from '../src/renderer/lib/article-drafts';
import { emptyArticle } from '../src/renderer/lib/article-beads';
import { createLinkDrafts } from '../src/renderer/lib/link-drafts';
import { defaultAppearance } from '../src/renderer/lib/links';
import { createFormDrafts } from '../src/renderer/lib/form-drafts';
import { createBookmarkDrafts } from '../src/renderer/lib/bookmark-drafts';
import { createPageLabelDrafts } from '../src/renderer/lib/page-label-drafts';
import { createDocumentJsDrafts } from '../src/renderer/lib/document-js-drafts';
import { createLayerSessions } from '../src/renderer/lib/layer-session';
import { readingWith } from './helpers/published-bytes';

/** Execute the actual component callbacks and actual App adapters, without
 * replacing the publication boundary with a mock that simply promises success. */
function actual(path: string, name: string, env: Record<string, unknown>) {
  const source = ts.createSourceFile(path, readFileSync(`src/renderer/${path}`, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name
        && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression || !ts.isArrowFunction(expression)) throw new Error(`Missing callback ${path}:${name}`);
  const code = ts.transpileModule(`const callback = ${expression.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), `${code}; return callback;`)(...Object.values(env));
}
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
async function fixture() {
  const pdf = await PDFDocument.create(); const page = pdf.addPage();
  const field = pdf.getForm().createTextField('name'); field.setText('Original'); field.addToPage(page);
  const original = await pdf.save();
  const open: OpenFile = { path: 'source', workingPath: 'work', name: 'source', buffer: original,
    pageCount: 1, dirty: false, undoStack: [], redoStack: [] };
  const store = createAppStore({ ...initialState, activeFileId: 'source', files: new Map([['source', open]]) });
  const disk = new Map<string, Uint8Array>([['work', original.slice()]]);
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const activeFileRef = { current: open };
  const touched = { current: new Set(['name']) };
  const valuesRef = { current: { name: 'Changed' } };
  const drafts = createArticleDrafts(store.getState); store.subscribe(drafts.reconcile);
  const draft = drafts.get(open)!;
  const linkDrafts = createLinkDrafts(store.getState); store.subscribe(linkDrafts.reconcile);
  const linkSession = linkDrafts.get(open)!;
  await linkDrafts.load(linkSession, async method => method === 'list_links' ? { links: [
    { page: 1, index: 0, rect: [0, 0, 100, 30], kind: 'uri', target: 'https://old.example/',
      target_spec: { kind: 'uri', url: 'https://old.example/' }, appearance: defaultAppearance() },
  ] } : { destinations: [] });
  linkDrafts.beginEdit(linkSession, linkSession.links[0]);
  linkDrafts.patchDraft(linkSession, linkSession.draft!, {
    target: { kind: 'uri', url: 'https://new.example/' }, appearance: { ...defaultAppearance(), width: 2 },
  });
  await drafts.load(draft, async () => ({ threads: [] }));
  drafts.change(draft, () => [emptyArticle('Submitted')]);
  const articlesRef = { get current() { return draft.articles; },
    set current(value) { drafts.change(draft, () => value); } };
  const result = { status: '', loaded: null as OpenFile['buffer'], dirty: true, statuses: [] as unknown[] };
  const fault = { read: false, engine: false, allow: true, after: () => {}, reads: 0, failReadAt: Infinity };
  drafts.subscribe(() => {
    if (activeFileRef.current.workingPath !== draft.workingPath) return;
    result.dirty = draft.dirty;
    if (draft.buffer !== open.buffer) result.loaded = draft.buffer;
    result.status = draft.error;
  });
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'read_form_fields') {
      const doc = await PDFDocument.load(disk.get(String(params.file))!);
      return { fields: [{ name: 'name', type: 'text', value: doc.getForm().getTextField('name').getText(),
        widgets: [{ page: 0, rect: [0, 0, 100, 30] }], read_only: false, required: false }],
        count: 1, has_xfa: false, xfa: 'none', xfa_calculations: false, calculation_order: [] };
    }
    const doc = await PDFDocument.load(disk.get(String(params.file))!);
    if (method === 'fill_form_fields') {
      for (const [name, value] of Object.entries(params.edits as Record<string, string>)) doc.getForm().getTextField(name).setText(value);
      if (params.flatten) doc.getForm().flatten();
    } else doc.getPage(0).setRotation(degrees(doc.getPage(0).getRotation().angle + 90));
    disk.set(String(params.output), await doc.save()); fault.after();
    if (fault.engine) throw new Error('injected engine after write');
    return { output: params.output, filled: Object.keys(params.edits ?? {}).length, flattened: params.flatten === true };
  };
  const transaction = {
    publish: async (id: string, [entry]: { stagedPath: string; expectedWorkingSha256: string; expectedStagedSha256: string }[]) => {
      expect(hash(disk.get('work')!)).toBe(entry.expectedWorkingSha256);
      expect(hash(disk.get(entry.stagedPath)!)).toBe(entry.expectedStagedSha256);
      disk.set(`backup-${id}`, disk.get('work')!.slice()); disk.set('work', disk.get(entry.stagedPath)!.slice());
      return { status: 'committed' as const, snapshots: [`backup-${id}`], detail: '' };
    },
    abort: async (id: string) => { if (disk.has(`backup-${id}`)) disk.set('work', disk.get(`backup-${id}`)!);
      return { status: 'rolledBack' as const, snapshots: [], detail: '' }; },
    acknowledge: async () => {},
  };
  const env = {
    readState: store.getState, dispatch: store.dispatch, executeWorkspaceOperation, fillFormValues,
    trackInteractive: async (run: () => Promise<unknown>) => run(),
    trackOperation: async (_m: string, _p: unknown, run: () => Promise<unknown>) => run(),
    isTrackableMethod: () => true, sequenceEditClass, isOpMethod,
    commitRef: { current: async () => {} }, confirmEditOfSignedDoc: async () => fault.allow,
    callRaw: call, call, pageCommit: transaction,
    readPublishedBytes: readingWith(async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount()),
    file: { writeBuffer: async (p: string, b: Uint8Array) => { disk.set(p, b.slice()); },
      readBuffer: async (p: string) => {
        if (fault.read || ++fault.reads === fault.failReadAt) throw new Error('injected read');
        return disk.get(p)!.slice();
      }, remove: async (p: string) => { disk.delete(p); } },
    app: { getEditFontPath: async () => 'fonts' },
    EDIT_DECLINED, tChrome: (key: string, p?: { message?: string }) => `${key} ${p?.message ?? ''}`,
    tChromeCount: (key: string, n: number) => `${key}:${n}`,
  };
  const operations = { fillFormValues: actual('App.tsx', 'handleFillFormValues', env), performOperation: actual('App.tsx', 'performOperation', env) };
  const forms = createFormDrafts(store.getState); store.subscribe(forms.reconcile);
  const formDraft = forms.get(open)!; await forms.load(formDraft, (method, params) => call(method, params ?? {}));
  forms.setValue(formDraft, open.buffer, 'name', 'Changed'); calls.length = 0;
  const bookmarks = createBookmarkDrafts(store.getState); store.subscribe(bookmarks.reconcile);
  const bookmarkDraft = bookmarks.get(open)!;
  await bookmarks.load(bookmarkDraft, async () => ({ outline: [{ title: 'Original', page: 1, children: [] }], count: 1, truncated: false }));
  bookmarks.change(bookmarkDraft, open.buffer, () => [{ title: 'Submitted', page: 1, children: [] }]);
  bookmarks.subscribe(() => {
    if (activeFileRef.current.workingPath !== bookmarkDraft.workingPath) return;
    if (bookmarkDraft.buffer !== open.buffer) result.loaded = bookmarkDraft.buffer;
    result.status = bookmarkDraft.error;
  });
  const panelEnv = { ...env, ...operations, draft, drafts, activeFile: open, activeFileRef, articlesRef, touched, valuesRef,
    values: { name: 'Changed' }, fields: [{ name: 'name', editable: true }], initialValues: { current: { name: 'Original' } },
    valueEquals: (a: unknown, b: unknown) => a === b, flatten: false, replacement: 'Corrected', wordAt, replaceRange,
    setBusy: () => {}, setStatus: (s: string) => { result.status = s; },
    setDirty: (value: boolean) => { result.dirty = value; },
    setLoadedBuffer: (value: OpenFile['buffer']) => { result.loaded = value; },
    running: false, setRunning: () => {}, setView: () => {},
    setRunStatuses: (value: unknown[] | ((s: unknown[]) => unknown[])) => { result.statuses = typeof value === 'function' ? value(result.statuses) : value; },
    stepDefFor, engineMethodFor, buildStepParams, saveFile: async () => 'export', terminalOutputName: () => 'export',
    planAction, gsBlocker, gsPathFor, gsBlocked: () => false, gsRef: { current: null },
    planRequest: async (params: { steps: { op: string }[] }) =>
      ({ gs: 'never', steps: params.steps.map((s) => ({ op: s.op, gs: 'never' })) }),
    GS_LOOKUP: { require: async () => 'gs', ifAvailable: async () => 'gs' },
    editing: { page: 1, index: 0 }, editProblem: null,
    editTarget: { kind: 'uri', url: 'https://new.example/' }, editAppearance: { width: 2 },
    targetPayload: (v: unknown) => v, appearancePayload: (v: unknown) => v,
    setEditing: () => {}, refresh: async () => {},
  };
  const pageLabels = createPageLabelDrafts(store.getState); store.subscribe(pageLabels.reconcile);
  const labelDraft = pageLabels.get(open)!;
  await pageLabels.load(labelDraft, async () => ({ complete: true, ranges: [], count: 0, labels: ['1'] }));
  pageLabels.change(labelDraft, open.buffer, () => [{ start: 1, style: 'D', prefix: 'Changed', startAt: 5 }]);
  pageLabels.subscribe(() => {
    if (activeFileRef.current.workingPath !== labelDraft.workingPath) return;
    if (labelDraft.buffer !== open.buffer) result.loaded = labelDraft.buffer;
    result.status = labelDraft.error;
  });
  const documentJs = createDocumentJsDrafts(store.getState); store.subscribe(documentJs.reconcile);
  const jsDraft = documentJs.get(open)!;
  await documentJs.load(jsDraft, async () => ({ complete: true, scripts: [], count: 0 }));
  documentJs.change(jsDraft, open.buffer, () => [{ name: 'Script', js: '// Submitted' }]);
  documentJs.subscribe(() => {
    if (activeFileRef.current.workingPath !== jsDraft.workingPath) return;
    if (jsDraft.buffer !== open.buffer) result.loaded = jsDraft.buffer;
    result.status = jsDraft.error;
  });
  const run = (surface: string) => {
    if (surface === 'layers') return actual('panels/LayersPanel.tsx', 'toggle', { ...panelEnv,
      session: layerSession, sessions: layerSessions, buffer: open.buffer, runCommitGate: async () => {} })(layerSession.layers[0]);
    if (surface === 'documentJs') return actual('panels/DocumentJsPanel.tsx', 'save', { ...panelEnv,
      draft: jsDraft, drafts: documentJs })();
    if (surface === 'pageLabels') return actual('panels/PageLabelsPanel.tsx', 'handleApply', { ...panelEnv,
      draft: labelDraft, drafts: pageLabels, runCommitGate: async () => {} })();
    if (surface === 'forms') return actual('panels/FormsPanel.tsx', 'handleApply', { ...panelEnv, draft: formDraft, drafts: forms })();
    if (surface === 'spelling') {
      const owner = createOwnedOperationRuns(store.getState).begin(open)!;
      const inspectSource = (run: typeof owner, inspect: (path: string) => Promise<unknown>) => inspectOperationInput(run,
        { allocate: async () => 'spelling-inspection', write: env.file.writeBuffer, remove: env.file.remove }, inspect);
      return (async () => {
        try {
          const fixField = actual('panels/SpellingPanel.tsx', 'fixField', { ...panelEnv, inspectSource });
          return await fixField({ field: 'name', start: 0, end: 8 }, 'Original', owner);
        }
        finally { owner.finish(); }
      })();
    }
    if (surface === 'bookmarks') return actual('components/navpane/BookmarksPanel.tsx', 'persist', { ...panelEnv,
      draft: bookmarkDraft, drafts: bookmarks, runCommitGate: async () => {} })();
    if (surface === 'articles') return actual('components/navpane/ArticlesPanel.tsx', 'save', panelEnv)();
    if (surface === 'links') return actual('panels/LinksPanel.tsx', 'applyEdit', { ...panelEnv,
      session: linkSession, drafts: linkDrafts })();
    return actual('panels/GuidedActionsPanel.tsx', 'executeRun', panelEnv)({ name: 'test', steps: [newStep('strip_metadata'), newStep('strip_metadata')] }, {});
  };
  const layerSessions = createLayerSessions(store.getState); store.subscribe(layerSessions.reconcile);
  const layerSession = layerSessions.get(open)!;
  await layerSessions.load(layerSession, async () => ({ complete: true, count: 1, processing_step_count: 0,
    layers: [{ index: 0, name: 'Layer', visible: true, locked: false, processing_step: null }] }));
  return { run, result, fault, disk, original, store, open, calls, activeFileRef, touched, articlesRef, operations, transaction, panelEnv, forms, formDraft };
}

describe('actual panel publication callbacks', () => {
  const surfaces = ['forms', 'spelling', 'bookmarks', 'articles', 'guided', 'links', 'pageLabels', 'documentJs', 'layers'];
  for (const surface of surfaces) {
    it.each(['read', 'engine'])(`${surface}: %s failure cannot publish private bytes`, async where => {
      const f = await fixture(); f.fault[where as 'read' | 'engine'] = true;
      if (surface === 'spelling') await expect(f.run(surface)).rejects.toThrow('injected'); else await f.run(surface);
      expect(f.disk.get('work')).toEqual(f.original); expect(f.store.getState().files.get('source')).toBe(f.open);
      if (surface === 'forms') expect(f.formDraft.pending).toEqual({ name: 'Changed' });
      if (surface === 'articles') expect(f.result.dirty).toBe(true);
      if (surface === 'guided') expect(f.result.statuses).toEqual([{ error: expect.stringContaining('injected') }, 'pending']);
    });
    it(`${surface}: faithful callback publishes matching bytes and original undo`, async () => {
      const f = await fixture(); await f.run(surface); const now = f.store.getState().files.get('source')!;
      expect(now.buffer).toEqual(f.disk.get('work')); expect(now.buffer).not.toEqual(f.original);
      expect(now.undoStack).toHaveLength(surface === 'guided' ? 2 : 1); expect(f.disk.get(now.undoStack[0])).toEqual(f.original);
      if (surface === 'bookmarks' || surface === 'articles') expect(f.result.loaded).toBe(now.buffer);
      if (surface === 'forms') expect(f.formDraft.pending).toEqual({});
    });
    it(`${surface}: refused consent never writes a revision`, async () => {
      const f = await fixture(); f.fault.allow = false; await f.run(surface);
      expect(f.disk.get('work')).toEqual(f.original); expect(f.store.getState().files.get('source')).toBe(f.open);
      expect(f.calls.every(c => c.method === 'read_form_fields')).toBe(true);
    });
  }
  it('Guided Actions retains only the successful first step when the second read fails', async () => {
    const f = await fixture(); f.fault.failReadAt = 2; await f.run('guided');
    const now = f.store.getState().files.get('source')!;
    expect(now.undoStack).toHaveLength(1); expect(now.buffer).toEqual(f.disk.get('work'));
    expect((await PDFDocument.load(f.disk.get('work')!)).getPage(0).getRotation().angle).toBe(90);
    expect(f.result.statuses).toEqual(['done', { error: expect.stringContaining('injected read') }]);
  });
  it('Guided Actions terminal output remains a separate file with no document undo', async () => {
    const f = await fixture();
    await actual('panels/GuidedActionsPanel.tsx', 'executeRun', f.panelEnv)({ name: 'export', steps: [newStep('encrypt')] }, {}, 'export');
    expect(f.disk.has('export')).toBe(true); expect(f.disk.get('work')).toEqual(f.original);
    expect(f.store.getState().files.get('source')).toBe(f.open); expect(f.result.statuses).toEqual(['done']);
  });
  it('Guided Actions refuses a step that needs Ghostscript before the first step runs', async () => {
    const f = await fixture();
    const planRequest = async () => ({ gs: 'required', steps: [
      { op: 'strip_metadata', gs: 'never' }, { op: 'grayscale', gs: 'required' }] });
    await actual('panels/GuidedActionsPanel.tsx', 'executeRun', { ...f.panelEnv, planRequest, gsBlocked: () => true })(
      { name: 'gs', steps: [newStep('strip_metadata'), newStep('grayscale')] }, {});
    expect(f.result.statuses).toEqual(['pending', { error: expect.stringContaining('Ghostscript') }]);
    expect(f.calls).toEqual([]); expect(f.disk.get('work')).toEqual(f.original);
  });
  it('Guided Actions hands each step the Ghostscript its planned need takes', async () => {
    const f = await fixture();
    const planRequest = async () => ({ gs: 'required', steps: [{ op: 'strip_metadata', gs: 'never' },
      { op: 'search_redact', gs: 'optional' }, { op: 'grayscale', gs: 'required' }] });
    const GS_LOOKUP = { require: async () => 'required-gs', ifAvailable: async () => 'usable-gs' };
    const steps = [newStep('strip_metadata'), newStep('search_redact'), newStep('grayscale')];
    await actual('panels/GuidedActionsPanel.tsx', 'executeRun', { ...f.panelEnv, planRequest, GS_LOOKUP })(
      { name: 'gs', steps }, {});
    expect(f.result.statuses).toEqual(['done', 'done', 'done']);
    const methods = steps.map((s) => engineMethodFor(s.op));
    expect(f.calls.filter((c) => methods.includes(c.method)).map((c) => c.params.gs_path))
      .toEqual([undefined, 'usable-gs', 'required-gs']);
  });
  it('Guided Actions plans a folder run over the picked folder before it starts', async () => {
    const f = await fixture(); const views: { error?: string | null }[] = [];
    const sent: Record<string, unknown>[] = []; const order: string[] = [];
    let plan = { gs: 'required', steps: [{ op: 'create_pdf', gs: 'required' }] };
    const env = { ...f.panelEnv, gsBlocked: () => true, setView: (v: { error?: string | null }) => { views.push(v); },
      planRequest: async (params: Record<string, unknown>) => { sent.push(params); order.push('plan'); return plan; },
      getSettings: () => ({ batchLogEnabled: false, batchLogRetentionDays: 0, batchLogDir: '' }),
      batch: { logDir: async () => '', pruneLogs: async () => 0 },
      app: { getEditFontPath: async () => 'fonts', getTesseractPath: async () => 'tess', getSofficePath: async () => 'soffice' },
      writtenRoots,
      claimOutputRoots: async (roots: string[]) => {
        order.push(`claim ${roots.join(',')}`);
        return { granted: true, message: '', release: async () => { order.push(`release ${roots.join(',')}`); } };
      } };
    const action = { name: 'create', steps: [newStep('create_pdf')] };
    const run = actual('panels/GuidedActionsPanel.tsx', 'executeFolderRun', env);
    await run(action, {}, 'C:/in', 'C:/out');
    expect(sent).toEqual([{ source: 'C:/in', dest: '', steps: [{ op: 'create_pdf', params: buildStepParams(action.steps[0]) }], plan: true }]);
    // The destination is claimed before the plan and released after the refusal.
    expect(order).toEqual(['claim C:/out', 'plan', 'release C:/out']);
    expect(views.at(-1)?.error).toContain('Ghostscript');
    expect(f.calls).toEqual([]);
    plan = { gs: 'optional', steps: [{ op: 'create_pdf', gs: 'optional' }] };
    await run(action, {}, 'C:/in', 'C:/out');
    expect(f.calls.find((c) => c.method === 'run_action')?.params.gs_path).toBe('gs');
    plan = { gs: 'never', steps: [{ op: 'create_pdf', gs: 'never' }] };
    f.calls.length = 0; await run(action, {}, 'C:/in', 'C:/out');
    expect(f.calls.find((c) => c.method === 'run_action')?.params.gs_path).toBe('');
  });
  it('Guided Actions runs nothing over a folder another run is writing, and says so', async () => {
    const f = await fixture(); const views: { error?: string | null }[] = [];
    const planned: unknown[] = []; const claimed: string[][] = [];
    const env = { ...f.panelEnv, setView: (v: { error?: string | null }) => { views.push(v); },
      planRequest: async (params: Record<string, unknown>) => { planned.push(params); return { gs: 'never', steps: [] }; },
      writtenRoots,
      claimOutputRoots: async (roots: string[]) => {
        claimed.push(roots);
        return { granted: false, message: `busy: ${roots.join(',')}`, release: async () => {} };
      } };
    const run = actual('panels/GuidedActionsPanel.tsx', 'executeFolderRun', env);
    await run({ name: 'gray', steps: [newStep('grayscale')] }, {}, 'C:/in', '', true);
    // An in-place run writes its source tree, so that is the folder it claims.
    expect(claimed).toEqual([['C:/in']]);
    expect(views.at(-1)?.error).toBe('busy: C:/in');
    expect(planned).toEqual([]);
    expect(f.calls).toEqual([]);
  });
  it.each(['runAction', 'runActionOnFolder', 'runActionInPlace'])('Guided Actions %s opens nothing for an action its plan blocks', async (name) => {
    const f = await fixture(); const opened: unknown[] = [];
    const env = { ...f.panelEnv, activeFile: f.open, running: false, plansRef: { current: new Map() },
      openDocumentBlocker: () => null, inPlaceBlocker: () => null, listedGsBlocker: () => 'blocked', askedParamKeys: () => [],
      gsBlocked: () => true, setView: (v: unknown) => { opened.push(v); },
      executeRun: async () => { opened.push('run'); }, executeFolderRun: async () => { opened.push('folder run'); },
      dialog: { pickFolder: async () => { opened.push('picker'); return 'C:/in'; } } };
    await actual('panels/GuidedActionsPanel.tsx', name, env)({ name: 'gs', steps: [newStep('grayscale')] });
    expect(opened).toEqual([]);
  });
  it.each(['forms', 'bookmarks', 'articles', 'pageLabels'])('%s does not update another tab after publication', async surface => {
    const f = await fixture(); f.fault.after = () => { f.activeFileRef.current = { ...f.open, path: 'other', workingPath: 'other-work' }; f.result.status = 'Other'; };
    await f.run(surface); expect(f.result.status).toBe('Other'); expect(f.result.loaded).toBe(null);
    if (surface === 'forms') expect(f.formDraft.pending).toEqual({}); // A retires its accepted input, without touching B
  });
  it('Articles keeps changes made after submission dirty', async () => {
    const f = await fixture(); f.fault.after = () => { f.articlesRef.current = [emptyArticle('Later')]; };
    await f.run('articles'); expect(f.result.dirty).toBe(true);
    expect(f.calls.find(c => c.method === 'set_threads')!.params.threads).toEqual([emptyArticle('Submitted')]);
  });
  it('publication receipt remains the accepted revision when state changes during acknowledgement', async () => {
    const f = await fixture(); f.transaction.acknowledge = async () => { f.store.dispatch({ type: 'MARK_SAVED', path: 'source' }); };
    const result = await f.operations.performOperation('source', 'set_threads', { threads: [] });
    expect(result.publication.dirty).toBe(true); expect(f.store.getState().files.get('source')!.dirty).toBe(false);
    expect(result.publication.buffer).toBe(f.store.getState().files.get('source')!.buffer);
  });
  it('queued target from a closed working session cannot target its replacement', async () => {
    const f = await fixture();
    await expect(f.operations.performOperation('source', 'set_threads', { threads: [] }, { expectedWorkingPath: 'older-session' })).rejects.toThrow();
    expect(f.store.getState().files.get('source')).toBe(f.open); expect(f.calls).toEqual([]);
  });
  it('every in-place Guided Actions method belongs to the consent/publication roster', () => {
    for (const def of STEP_CATALOG.filter(d => !d.sourceStep && !d.terminalOutput)) expect(isOpMethod(engineMethodFor(def.op)), def.op).toBe(true);
  });
});
