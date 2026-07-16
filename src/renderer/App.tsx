import React, { useState, useCallback, useEffect, useRef } from 'react';
import { AppStateProvider, useAppState, useAppDispatch } from './state/AppStateProvider';
import { file, app } from './lib/tauri-bridge';
import { ConfirmDialog, ConfirmResult } from './components/ConfirmDialog';
import { PasswordDialog, PasswordResult } from './components/PasswordDialog';
import { PageInspector } from './components/PageInspector';
import { SplitPanel } from './panels/SplitPanel';
import { RotatePanel } from './panels/RotatePanel';
import { DeletePanel } from './panels/DeletePanel';
import { CompressPanel } from './panels/CompressPanel';
import { PdfaPanel } from './panels/PdfaPanel';
import { EncryptPanel } from './panels/EncryptPanel';
import { DecryptPanel } from './panels/DecryptPanel';
import { ExtractTextPanel } from './panels/ExtractTextPanel';
import { RepairPanel } from './panels/RepairPanel';
import { RebuildPanel } from './panels/RebuildPanel';
import { RecoverPanel } from './panels/RecoverPanel';
import { GrayscalePanel } from './panels/GrayscalePanel';
import { OptimizePanel } from './panels/OptimizePanel';
import { PdfVersionPanel } from './panels/PdfVersionPanel';
import { WatermarkPanel } from './panels/WatermarkPanel';
import { FormsPanel } from './panels/FormsPanel';
import { ComparePanel } from './panels/ComparePanel';
import { SignaturesPanel } from './panels/SignaturesPanel';
import { useEngine } from './hooks/useEngine';
import { useWorkspaceIndexer } from './hooks/useWorkspaceIndexer';
import { indexOpenFile } from './lib/workspace';
import type { PageRef, PdfBuffer } from './state/types';
import { isDocTab, viewOf } from './state/types';
import { showableDoc, tabFiles } from './state/selectors';
import type { CanvasTool } from './state/types';
import { WorkspaceCanvasView } from './components/canvas/WorkspaceCanvasView';
import type { CanvasDropResolver } from './components/canvas/WorkspaceCanvasView';
import { commitPageEdits } from './lib/workspace-commit';
import { setCommitGate, runCommitGate } from './lib/commit-gate';
import { fillFormFields, readFormFields } from './lib/forms';
import type { FormFieldValue } from './lib/forms';
import { resolveFillTargets } from './lib/form-overlay';
import { addFormField } from './lib/form-authoring';
import type { NewFieldSpec } from './lib/form-authoring';
import { DropZone } from './components/DropZone';
import { OperationQueue } from './components/OperationQueue';
import { QueueProvider, useOperationQueue } from './hooks/useOperationQueue';
import { SearchProvider } from './search/SearchProvider';
import { SettingsPanel, getSettings, type PrefCategory } from './panels/SettingsPanel';
import { MenuBar } from './components/MenuBar';
import { MainToolbar } from './components/MainToolbar';
import { TabStrip } from './components/TabStrip';
import { HomeTab } from './components/HomeTab';
import { AboutDialog } from './components/AboutDialog';
import { PropertiesDialog } from './components/PropertiesDialog';
import { PrintDialog } from './components/PrintDialog';
import { buildBlankPagePdf } from './lib/blank-page';
import { insertAnchor } from './state/selectors';
import { UpdateBar } from './components/UpdateBar';
import { NavPane } from './components/navpane/NavPane';
import { ToolsCenter } from './components/ToolsCenter';
import { ToolIcon } from './components/tool-icons';
import { toolById } from './commands/tools';
import { OPERATION_TITLES, type Operation } from './commands/operations';
import { withRecent } from './lib/recent-files';
import { writeWorkbenchUi } from './lib/workbench-ui';
import { installTestHarness, TEST_HARNESS_ENABLED } from './testHarness';
import type { TestStateSnapshot } from './testHarness';
import {
  invokeCommand,
  registerAppCommandHandlers,
  setCommandStateSource,
} from './commands/context';
import { useKeymapDispatcher } from './commands/keymap';
import type { AppCommandHandlers } from './commands/types';

const panels: Record<Operation, React.ComponentType> = {
  split: SplitPanel, rotate: RotatePanel, delete: DeletePanel,
  compress: CompressPanel, grayscale: GrayscalePanel, optimize: OptimizePanel,
  pdfa: PdfaPanel, pdf_version: PdfVersionPanel,
  encrypt: EncryptPanel, decrypt: DecryptPanel,
  extract_text: ExtractTextPanel,
  watermark: WatermarkPanel, forms: FormsPanel, compare: ComparePanel,
  signatures: SignaturesPanel,
  repair: RepairPanel, rebuild: RebuildPanel, recover: RecoverPanel,
};

function AppContent(): React.ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  // The tab model lives in the ui slice (Phase 4 M2) so the command registry,
  // menus, and tab strip all read it. focusedTab replaces the old `view`.
  const focusedTab = state.ui.focusedTab;
  const inDocTab = isDocTab(focusedTab);
  const activeOp = state.ui.activeOp as Operation;
  // The tool whose pane the Tools tab shows; null = the tile grid ("no tool
  // open" is a real state, not an absence to paper over). `activeToolId` outlives the
  // document it was opened on (deliberately — Escape disarms the mode, not the
  // tool), so an ops-less tool with nothing to act on has NOTHING to put here:
  // its pane is a fence saying "this works on the page" plus a button that
  // `when`-fails with no document open. A dead button is worse than the grid.
  const openTool = state.ui.activeToolId ? toolById(state.ui.activeToolId) : null;
  const activeTool =
    openTool && (openTool.ops.length > 0 || showableDoc(state)) ? openTool : null;
  const setActiveOp = useCallback(
    (op: Operation) => dispatch({ type: 'UI_SET_ACTIVE_OP', op }),
    [dispatch],
  );
  // Which Preferences category is open, or null for closed. Carrying the
  // category (rather than a boolean) is what lets Help ▸ Third-party Licenses
  // land ON the licences, instead of at the top of a scroll.
  const [showSettings, setShowSettings] = useState<PrefCategory | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [showProperties, setShowProperties] = useState(false);
  const [showPrint, setShowPrint] = useState(false);
  // Manual "Check for Updates" (Help menu): bump a signal the UpdateBar
  // watches, so the banner surfaces the available / up-to-date / disabled state.
  const [updateCheckSignal, setUpdateCheckSignal] = useState(0);
  const { items: queue, clear: clearQueue } = useOperationQueue();
  const [extractPage, setExtractPage] = useState<number | null>(null);
  const [appVersion, setAppVersion] = useState('');
  // PageInspector overlay target (canvas view). `page` is the file's
  // committed page order — the opener commits pending edits first.
  const [inspector, setInspector] = useState<{ path: string; page: number } | null>(null);
  const recentFiles = state.ui.recentFiles;
  const { call, openFiles, saveFile } = useEngine();
  useWorkspaceIndexer();

  // 3-choice confirm dialog state (Save / Don't Save / Cancel)
  const [confirmState, setConfirmState] = useState<{
    message: string;
    resolve: (result: ConfirmResult) => void;
  } | null>(null);

  // Password prompt dialog state
  const [passwordState, setPasswordState] = useState<{
    fileName: string;
    error?: string;
    resolve: (result: PasswordResult) => void;
  } | null>(null);

  const showPasswordPrompt = useCallback((fileName: string, error?: string): Promise<PasswordResult> => {
    return new Promise((resolve) => {
      setPasswordState({ fileName, error, resolve });
    });
  }, []);

  const handlePasswordResult = useCallback((result: PasswordResult) => {
    if (passwordState) {
      passwordState.resolve(result);
      setPasswordState(null);
    }
  }, [passwordState]);

  const showConfirm = useCallback((message: string): Promise<ConfirmResult> => {
    return new Promise((resolve) => {
      setConfirmState({ message, resolve });
    });
  }, []);

  const handleConfirmResult = useCallback((result: ConfirmResult) => {
    if (confirmState) {
      confirmState.resolve(result);
      setConfirmState(null);
    }
  }, [confirmState]);

  // Fetch app version on mount
  useEffect(() => {
    app.getVersion().then((v) => setAppVersion(`v${v}`));
  }, []);

  // Mirror the recent-files list (ui slice) to localStorage — the single
  // persistence point; every mutation just dispatches UI_SET_RECENT_FILES.
  useEffect(() => {
    localStorage.setItem('spectra-recent', JSON.stringify(recentFiles));
  }, [recentFiles]);

  // Mirror the nav-pane state (M3) to the workbench-ui key. Debounced: a resize
  // drag dispatches a new width per pointermove, and an unthrottled synchronous
  // localStorage write per event competes with the drag for main-thread time
  // (review-caught). Each change reschedules; only the settled value persists.
  useEffect(() => {
    const t = setTimeout(() => writeWorkbenchUi({ navPane: state.ui.navPane }), 200);
    return () => clearTimeout(t);
  }, [state.ui.navPane]);

  const activeFile = state.activeFileId ? state.files.get(state.activeFileId) : null;
  const inspectorFile = inspector ? state.files.get(inspector.path) : null;
  // Open, tab-bearing files (importOnly sources excluded) — the Tools-tab
  // active-file switcher lists these so a panel can retarget without leaving
  // the tab (a doc-tab click would move focus off Tools and unmount the panel).
  const tabFileList = tabFiles(state);
  // The active file, but only if it is one the picker below lists — the SAME
  // question showableDoc answers for the menus, so it gets the same (tested)
  // answer rather than a second implementation that could drift from it.
  const selectableFile = showableDoc(state);

  // Commit-failure banner: commits triggered from gates/effects have no
  // natural place to report, so failures surface here.
  const [commitError, setCommitError] = useState<string | null>(null);

  // Materialize pending in-memory page edits onto the snapshot undo chain.
  // Runs before anything that reads or replaces file bytes (save, whole-file
  // ops, close) — all dirty files commit together because cross-file moves
  // entangle them. Uses the raw (ungated) snapshot to avoid re-entering the
  // commit gate.
  const inflightCommit = useRef<Promise<void> | null>(null);
  const commitIfNeeded = useCallback((): Promise<void> => {
    if (inflightCommit.current) return inflightCommit.current;
    if (state.pageDirtyPaths.length === 0) return Promise.resolve();
    const run = (async () => {
      try {
        await commitPageEdits({
          workspace: state.workspace,
          files: state.files,
          dirtyPaths: state.pageDirtyPaths,
          dispatch,
          snapshot: file.snapshotRaw,
          writeBuffer: file.writeBuffer,
          rename: file.rename,
          remove: file.remove,
        });
        setCommitError(null);
      } finally {
        inflightCommit.current = null;
      }
    })();
    inflightCommit.current = run;
    return run;
  }, [state.pageDirtyPaths, state.workspace, state.files, dispatch]);
  const commitRef = useRef(commitIfNeeded);
  commitRef.current = commitIfNeeded;

  // Fire-and-forget variant for gates/effects/buttons: reports instead of
  // throwing. Flows that must abort on failure (save, close) await
  // commitIfNeeded directly and handle the rejection themselves.
  const commitAndReport = useCallback(async () => {
    try {
      await commitRef.current();
    } catch (err) {
      setCommitError(
        `Applying page changes failed: ${err instanceof Error ? err.message : String(err)}. ` +
          'Your edits are still pending — fix the cause (disk space, file locks) and retry.',
      );
    }
  }, []);

  // Register the commit gate so panel operations (which snapshot the working
  // file before mutating it) flush pending canvas edits first.
  useEffect(() => {
    setCommitGate(() => commitRef.current());
    return () => setCommitGate(null);
  }, []);

  const isFileDirty = useCallback(
    (f: { path: string; dirty: boolean }) =>
      f.dirty || state.pageDirtyPaths.includes(f.path),
    [state.pageDirtyPaths],
  );

  // Reload the working copy buffer and page count into state
  const reloadFile = useCallback(async (filePath: string) => {
    const f = state.files.get(filePath);
    if (!f) return;
    const buffer = await file.readBuffer(f.workingPath);
    const info = await call('get_page_count', { file: f.workingPath });
    return { buffer, pageCount: info.pages };
  }, [state.files, call]);

  // Create a working copy, unlock if encrypted, read bytes + page count. Shared
  // by opening files and by importing a file's pages into a document (2n.3).
  // Returns null if the user cancelled an encrypted file.
  const prepareFileBytes = useCallback(
    async (
      filePath: string,
    ): Promise<{ workingPath: string; name: string; buffer: PdfBuffer; pageCount: number } | null> => {
      const workingPath = await file.createWorkingCopy(filePath);
      const name = filePath.split(/[\\/]/).pop() || filePath;
      const encStatus = await call('check_encrypted', { file: workingPath });
      if (encStatus.encrypted) {
        let unlocked = false;
        let error: string | undefined;
        while (!unlocked) {
          const result = await showPasswordPrompt(name, error);
          if (result === 'cancel') return null;
          try {
            await call('unlock', { file: workingPath, password: result.password });
            unlocked = true;
          } catch {
            error = 'Incorrect password. Please try again.';
          }
        }
      }
      const buffer = await file.readBuffer(workingPath);
      const info = await call('get_page_count', { file: workingPath });
      return { workingPath, name, buffer, pageCount: info.pages };
    },
    [call, showPasswordPrompt],
  );

  const stateRef = useRef(state);
  stateRef.current = state;

  // Open files, then focus the last opened document's tab (opening a file is
  // an explicit request to view it — § M2 tab model). Already-open files are
  // re-activated. Recent list accumulates once so a multi-open batch doesn't
  // clobber itself.
  // `focus: false` opens without moving the user: a panel's "Open a PDF"
  // button is a way to give the PANEL a file, not a request to go read it.
  // That difference used to justify a whole second implementation of "open some
  // files" (useActiveFile.openNewFiles), which then diverged from this one FOUR
  // times — including losing encryption support entirely, so a panel's Open
  // button could not open a password-protected PDF at all. One implementation,
  // one flag.
  const openByPaths = useCallback(async (paths: string[], opts?: { focus?: boolean }) => {
    let recent = stateRef.current.ui.recentFiles;
    let lastOpened: string | null = null;
    let changed = false;
    try {
      // The same path STRING twice in one batch is one open. Nothing upstream
      // dedupes: the CLI and second-instance handlers both build this list
      // straight off argv, so `openpdfstudio.exe a.pdf a.pdf` really does arrive
      // as two entries. Deduping HERE (not in Rust) covers every caller — CLI,
      // second instance, the open dialog, drag-and-drop.
      //
      // String equality, NOT path identity: `C:\a.pdf` and `c:\A.PDF` are the
      // same file on Windows and this won't merge them. That's deliberate, not
      // an oversight — `state.files` is keyed by the raw path string app-wide
      // (tabs, recent, activeFileId all take string identity for file
      // identity), so canonicalizing only here would make this function
      // disagree with everything downstream. The whole-app gap is tracked in
      // the punchlist; don't paper over it with a local normalize.
      //
      // This can't be left to the already-open check below: that reads state
      // React hasn't flushed yet. The loop only awaits BEFORE each dispatch,
      // never after, so the next iteration's read runs in the same tick as the
      // previous OPEN_FILE and still sees the file as absent — `stateRef` is as
      // stale as the closure was for this particular read. A duplicate would
      // open twice, leaking the first working copy (`create_working_copy` mints
      // a fresh temp dir per call and nothing purges them) and prompting twice
      // for an encrypted file's password.
      for (const filePath of [...new Set(paths)]) {
        // Already open as a real DOCUMENT → just re-activate it. A byte-only
        // import source doesn't count: it has an entry in `files` but no tab,
        // nothing ever upgrades the flag, and `focusTab` rejects a doc tab for
        // it — so treating it as "already open" made File ▸ Open on a file you
        // had previously imported pages FROM a permanent no-op with no
        // feedback. Fall through and open it properly instead.
        // Off the ref, not the closure: the closure's `state.files` is stale for
        // the whole call (the same reason `recent` is threaded above), so a
        // file opened by an earlier, separate openByPaths call would be missed.
        // The ref is current as of the last completed render — which is enough
        // here precisely because the dedupe above already handles the one case
        // it can't see (a duplicate within this batch, dispatched but not yet
        // flushed).
        const existing = stateRef.current.files.get(filePath);
        if (existing && !existing.importOnly) {
          dispatch({ type: 'SET_ACTIVE_FILE', path: filePath });
          recent = withRecent(recent, filePath); // only on success — a cancel/throw
          lastOpened = filePath;                  // must not pollute Recent (review-caught)
          changed = true;
          continue;
        }
        if (existing?.importOnly) {
          // Upgrading a ghost REPLACES bytes that other documents' pending
          // pages still point into (`PageRef.sourceDocId` + a positional
          // `sourcePageIndex`, resolved at commit by `bytesFor`). If the file
          // changed on disk since the import, those indices now mean something
          // else — a silent wrong page, or a throw at commit. Flush first, so
          // the imported pages are materialized into their own files and
          // nothing references these bytes any more. `prepareFileBytes` can't
          // be relied on for this: its only engine call is `check_encrypted`,
          // which is an INTERNAL_METHOD and so deliberately ungated.
          await runCommitGate();
        }
        const prepared = await prepareFileBytes(filePath);
        if (!prepared) continue; // cancelled encrypted file
        dispatch({ type: 'OPEN_FILE', path: filePath, ...prepared });
        recent = withRecent(recent, filePath);
        lastOpened = filePath;
        changed = true;
      }
    } finally {
      // Flush whatever succeeded even if a later file threw (a malformed PDF
      // mid-batch would otherwise strand the opened tabs unfocused + unrecorded).
      if (changed) dispatch({ type: 'UI_SET_RECENT_FILES', files: recent });
      if (lastOpened && opts?.focus !== false) dispatch({ type: 'UI_FOCUS_TAB', tab: { doc: lastOpened } });
    }
  }, [dispatch, prepareFileBytes]);

  // Import one or more files' pages INTO an existing document at an index (the
  // add-page ghost and per-position drops, 2n.3). Each file is registered
  // byte-only (no strip) and its pages spliced in — atomic, undoable. Files
  // already open are reused. A cancelled encrypted file is skipped.
  const importFilesIntoDoc = useCallback(
    async (filePaths: string[], toDocId: string, toIndex: number) => {
      const toRegister: {
        path: string;
        workingPath: string;
        name: string;
        pageCount: number;
        buffer: PdfBuffer;
      }[] = [];
      const allPages: PageRef[] = [];
      for (const filePath of filePaths) {
        const existing = state.files.get(filePath);
        let src: { workingPath: string; name: string; buffer: PdfBuffer; pageCount: number };
        if (existing?.buffer) {
          src = {
            workingPath: existing.workingPath,
            name: existing.name,
            buffer: existing.buffer,
            pageCount: existing.pageCount,
          };
        } else {
          const prepared = await prepareFileBytes(filePath);
          if (!prepared) continue;
          toRegister.push({ path: filePath, ...prepared });
          src = prepared;
        }
        const docs = await indexOpenFile({
          path: filePath,
          workingPath: src.workingPath,
          name: src.name,
          pageCount: src.pageCount,
          buffer: src.buffer,
          dirty: false,
          undoStack: [],
          redoStack: [],
          importOnly: true,
        });
        for (const d of docs) allPages.push(...d.pages);
      }
      if (allPages.length === 0) return;
      for (const reg of toRegister) dispatch({ type: 'REGISTER_IMPORT_SOURCE', ...reg });
      dispatch({ type: 'IMPORT_PAGES', toDocId, toIndex, pages: allPages });
    },
    [state.files, dispatch, prepareFileBytes],
  );

  // The canvas publishes its drop resolver here (2n.3).
  const dropResolverRef = useRef<CanvasDropResolver | null>(null);

  const handleFilesDropped = useCallback(
    async (paths: string[], position?: { x: number; y: number }) => {
      // A drop landing ON a document while a doc tab is focused imports its
      // pages into that document at the drop point (2n.3). A miss falls
      // through to opening the files (which focuses the last one's tab).
      if (inDocTab && position && dropResolverRef.current) {
        const dpr = window.devicePixelRatio || 1;
        const target = dropResolverRef.current(position.x / dpr, position.y / dpr);
        if (target) {
          await importFilesIntoDoc(paths, target.docId, target.index);
          return;
        }
      }
      await openByPaths(paths);
    },
    [openByPaths, importFilesIntoDoc, inDocTab],
  );

  const handleOpenFile = useCallback(async (): Promise<boolean> => {
    const paths = await openFiles();
    if (paths.length > 0) {
      await openByPaths(paths);
      return true;
    }
    return false;
  }, [openFiles, openByPaths]);

  // Add-page ghost (2n.3): pick file(s) and import their pages into a document.
  const handleAddPages = useCallback(
    async (docId: string, toIndex: number) => {
      const paths = await openFiles();
      if (paths.length > 0) await importFilesIntoDoc(paths, docId, toIndex);
    },
    [openFiles, importFilesIntoDoc],
  );

  // Document ▸ Insert Pages ▸ … (M6.3). Both land AFTER the page being read
  // (`insertAnchor`) and both ride the byte-only import machinery — undoable
  // page-tier work, zero new commit paths (§ 9.3).
  const insertPagesFromFile = useCallback(async () => {
    const anchor = insertAnchor(stateRef.current);
    if (!anchor) return;
    await handleAddPages(anchor.docId, anchor.index);
  }, [handleAddPages]);

  const insertBlankPage = useCallback(async () => {
    const s = stateRef.current;
    const anchor = insertAnchor(s);
    if (!anchor) return;
    const destDoc = s.workspace.documents.find((d) => d.id === anchor.docId);
    const destFile = destDoc ? s.files.get(destDoc.path) : null;
    if (!destFile) return;
    const bytes = await buildBlankPagePdf(
      anchor.neighbor?.width,
      anchor.neighbor?.height,
    );
    // Written beside the destination's working copy: that directory exists by
    // construction (create_working_copy made it) and is inside the fs
    // capability's $TEMP/openpdfstudio scope — no new grants, no mkdir.
    const dir = destFile.workingPath.replace(/[\\/][^\\/]+$/, '');
    const sep = destFile.workingPath.includes('\\') ? '\\' : '/';
    const tempPath = `${dir}${sep}blank-${crypto.randomUUID()}.pdf`;
    await file.writeBuffer(tempPath, bytes);
    await importFilesIntoDoc([tempPath], anchor.docId, anchor.index);
  }, [importFilesIntoDoc]);

  // Snapshot + perform operation + reload
  const performOperation = useCallback(async (
    filePath: string,
    method: string,
    params: Record<string, unknown>,
  ) => {
    const f = state.files.get(filePath);
    if (!f) return;
    const snapshotPath = await file.snapshot(f.workingPath);
    await call(method, { ...params, file: f.workingPath, output: f.workingPath });
    const result = await reloadFile(filePath);
    if (result) {
      dispatch({ type: 'UPDATE_FILE', path: filePath, pageCount: result.pageCount, buffer: result.buffer, snapshotPath });
    }
  }, [state.files, call, reloadFile, dispatch]);

  const handleRedactFile = useCallback(
    async (path: string, regions: { page: number; rect: [number, number, number, number] }[]) => {
      await performOperation(path, 'redact', { regions });
    },
    [performOperation],
  );

  const handleFillFormValues = useCallback(
    async (path: string, values: Record<string, FormFieldValue>) => {
      const f = state.files.get(path);
      if (!f) throw new Error('The file is no longer open.');
      const preFields = f.buffer ? (await readFormFields(f.buffer)).fields : [];
      const snapshotPath = await file.snapshot(f.workingPath);
      const bytes = await file.readBuffer(f.workingPath);
      const postFields = (await readFormFields(bytes)).fields;
      const { resolved, skipped } = resolveFillTargets(preFields, postFields, values);
      if (skipped.length > 0) {
        throw new Error(skipped.map((s) => `"${s.name}": ${s.reason}`).join('; '));
      }
      const filled = await fillFormFields(bytes, resolved);
      await file.writeBuffer(f.workingPath, filled);
      const result = await reloadFile(path);
      if (!result) throw new Error('The file is no longer open.');
      dispatch({
        type: 'UPDATE_FILE',
        path,
        pageCount: result.pageCount,
        buffer: result.buffer,
        snapshotPath,
      });
    },
    [state.files, reloadFile, dispatch],
  );

  const handleAddFormField = useCallback(
    async (path: string, spec: NewFieldSpec) => {
      const f = state.files.get(path);
      if (!f) throw new Error('The file is no longer open.');
      const snapshotPath = await file.snapshot(f.workingPath);
      const bytes = await file.readBuffer(f.workingPath);
      const withField = await addFormField(bytes, spec);
      await file.writeBuffer(f.workingPath, withField);
      const result = await reloadFile(path);
      if (!result) throw new Error('The file is no longer open.');
      dispatch({
        type: 'UPDATE_FILE',
        path,
        pageCount: result.pageCount,
        buffer: result.buffer,
        snapshotPath,
      });
    },
    [state.files, reloadFile, dispatch],
  );

  const handleApplyOcrLayer = useCallback(
    async (
      path: string,
      pages: { page: number; words: { text: string; rect: [number, number, number, number] }[] }[],
    ) => {
      await performOperation(path, 'apply_ocr_layer', { pages });
    },
    [performOperation],
  );

  const handleInspectorRotate = useCallback(async (page: number, angle: number) => {
    if (!inspector) return;
    await performOperation(inspector.path, 'rotate', { pages: [page], angle });
  }, [inspector, performOperation]);

  const handleInspectorDelete = useCallback(async (page: number) => {
    if (!inspector) return;
    await performOperation(inspector.path, 'delete', { pages: [page] });
    setInspector(null);
  }, [inspector, performOperation]);

  const handleUndo = useCallback(async () => {
    if (state.pageUndoStack.length > 0) {
      dispatch({ type: 'UNDO_PAGE_OP' });
      return;
    }
    if (!activeFile || activeFile.undoStack.length === 0) return;
    const snapshotPath = activeFile.undoStack[activeFile.undoStack.length - 1];
    const redoSnapshot = await file.snapshotRaw(activeFile.workingPath);
    await file.restoreSnapshot(activeFile.workingPath, snapshotPath);
    dispatch({ type: 'UNDO', path: activeFile.path, redoSnapshot });
    const result = await reloadFile(activeFile.path);
    if (result) {
      dispatch({
        type: 'REFRESH_BUFFER',
        path: activeFile.path,
        pageCount: result.pageCount,
        buffer: result.buffer,
      });
    }
  }, [activeFile, state.pageUndoStack.length, reloadFile, dispatch]);

  const handleRedo = useCallback(async () => {
    if (state.pageRedoStack.length > 0) {
      dispatch({ type: 'REDO_PAGE_OP' });
      return;
    }
    if (!activeFile || activeFile.redoStack.length === 0) return;
    const snapshotPath = activeFile.redoStack[activeFile.redoStack.length - 1];
    const undoSnapshot = await file.snapshotRaw(activeFile.workingPath);
    await file.restoreSnapshot(activeFile.workingPath, snapshotPath);
    dispatch({ type: 'REDO', path: activeFile.path, undoSnapshot });
    const result = await reloadFile(activeFile.path);
    if (result) {
      dispatch({
        type: 'REFRESH_BUFFER',
        path: activeFile.path,
        pageCount: result.pageCount,
        buffer: result.buffer,
      });
    }
  }, [activeFile, state.pageRedoStack.length, reloadFile, dispatch]);

  // Run the commit ahead of a dependent step; on failure surface the error
  // and tell the caller to abort (the edits are still pending and retryable).
  const commitOrAbort = useCallback(async (): Promise<boolean> => {
    try {
      await commitIfNeeded();
      return true;
    } catch (err) {
      setCommitError(
        `Applying page changes failed: ${err instanceof Error ? err.message : String(err)}. ` +
          'Nothing was saved — your edits are still pending.',
      );
      return false;
    }
  }, [commitIfNeeded]);

  const handleSave = useCallback(async () => {
    if (!activeFile) return;
    if (!(await commitOrAbort())) return;
    await file.saveAs(activeFile.workingPath, activeFile.path);
    dispatch({ type: 'MARK_SAVED', path: activeFile.path });
  }, [activeFile, dispatch, commitOrAbort]);

  const handleSaveAs = useCallback(async () => {
    if (!activeFile) return;
    const dest = await saveFile(activeFile.name);
    if (!dest) return;
    if (!(await commitOrAbort())) return;
    await file.saveAs(activeFile.workingPath, dest);
    dispatch({ type: 'MARK_SAVED', path: activeFile.path });
  }, [activeFile, saveFile, dispatch, commitOrAbort]);

  // Close file with unsaved changes prompt
  const handleCloseFile = useCallback(async (filePath: string) => {
    const f = state.files.get(filePath);
    if (f && isFileDirty(f)) {
      const result = await showConfirm(
        `"${f.name}" has unsaved changes. Save before closing?`
      );
      if (result === 'cancel') return;
      if (result === 'save') {
        if (!(await commitOrAbort())) return;
        await file.saveAs(f.workingPath, f.path);
      }
    }
    dispatch({ type: 'CLOSE_FILE', path: filePath });
  }, [state.files, dispatch, showConfirm, isFileDirty, commitOrAbort]);

  // Close all open files with unsaved changes prompt
  const handleCloseAll = useCallback(async () => {
    const allOpen = Array.from(state.files.values());
    const dirtyFiles = allOpen.filter(isFileDirty);
    if (dirtyFiles.length > 0) {
      const names = dirtyFiles.map((f) => f.name).join(', ');
      const result = await showConfirm(
        `Unsaved changes in: ${names}. Save before closing all?`
      );
      if (result === 'cancel') return;
      if (result === 'save') {
        if (!(await commitOrAbort())) return;
        for (const f of dirtyFiles) {
          await file.saveAs(f.workingPath, f.path);
        }
      }
    }
    for (const f of allOpen) {
      dispatch({ type: 'CLOSE_FILE', path: f.path });
    }
  }, [state.files, dispatch, showConfirm, isFileDirty, commitOrAbort]);

  // Exit the app (File ▸ Exit / Ctrl+Q) — always quits when clean; the
  // tray-minimize setting governs the window × (below), not an explicit Exit.
  const handleExit = useCallback(async () => {
    const dirtyFiles = Array.from(state.files.values()).filter(isFileDirty);
    if (dirtyFiles.length > 0) {
      const names = dirtyFiles.map((f) => f.name).join(', ');
      const result = await showConfirm(`Unsaved changes in: ${names}. Save before exiting?`);
      if (result === 'cancel') return;
      if (result === 'save') {
        if (!(await commitOrAbort())) return;
        for (const f of dirtyFiles) await file.saveAs(f.workingPath, f.path);
      }
    }
    await app.confirmClose();
  }, [state.files, isFileDirty, showConfirm, commitOrAbort]);

  // --- Command layer (Phase 4 M1/M2) ------------------------------------
  const commandHandlers: AppCommandHandlers = {
    openFiles: handleOpenFile,
    // The same open, minus the tab jump — the panels' "Open a PDF" button.
    openFilesInPlace: async () => {
      const paths = await openFiles();
      if (paths.length > 0) await openByPaths(paths, { focus: false });
    },
    openPath: (path) => openByPaths([path]),
    save: handleSave,
    saveAs: handleSaveAs,
    closeFile: handleCloseFile,
    closeAll: handleCloseAll,
    undo: handleUndo,
    redo: handleRedo,
    applyPageEdits: commitAndReport,
    openPreferences: () => setShowSettings('general'),
    openProperties: () => setShowProperties(true),
    openPrint: () => setShowPrint(true),
    insertBlankPage,
    insertPagesFromFile,
    openLicenses: () => setShowSettings('licenses'),
    openAbout: () => setShowAbout(true),
    checkForUpdates: () => setUpdateCheckSignal((n) => n + 1),
    exit: handleExit,
    minimizeToTray: async () => { await app.hideToTray(); },
  };
  const commandHandlersRef = useRef(commandHandlers);
  commandHandlersRef.current = commandHandlers;
  useEffect(() => {
    const h = commandHandlersRef;
    registerAppCommandHandlers({
      openFiles: () => h.current.openFiles(),
      openFilesInPlace: () => h.current.openFilesInPlace(),
      openPath: (path) => h.current.openPath(path),
      save: () => h.current.save(),
      saveAs: () => h.current.saveAs(),
      closeFile: (path) => h.current.closeFile(path),
      closeAll: () => h.current.closeAll(),
      undo: () => h.current.undo(),
      redo: () => h.current.redo(),
      applyPageEdits: () => h.current.applyPageEdits(),
      openPreferences: () => h.current.openPreferences(),
      openProperties: () => h.current.openProperties(),
      openPrint: () => h.current.openPrint(),
      insertBlankPage: () => h.current.insertBlankPage(),
      insertPagesFromFile: () => h.current.insertPagesFromFile(),
      openLicenses: () => h.current.openLicenses(),
      openAbout: () => h.current.openAbout(),
      checkForUpdates: () => h.current.checkForUpdates(),
      exit: () => h.current.exit(),
      minimizeToTray: () => h.current.minimizeToTray(),
    });
    setCommandStateSource(() => ({ state: stateRef.current, dispatch }));
    return () => {
      registerAppCommandHandlers(null);
      setCommandStateSource(null);
    };
  }, [dispatch]);
  // The ONE window-level shortcut dispatcher (M1).
  useKeymapDispatcher();

  // Open the PageInspector overlay from the canvas. Pending edits commit first.
  const handleInspectPage = useCallback(async (path: string, page: number) => {
    if (!(await commitOrAbort())) return;
    dispatch({ type: 'SET_ACTIVE_FILE', path });
    setInspector({ path, page });
  }, [commitOrAbort, dispatch]);

  const handleExtractFromCanvas = useCallback((path: string, page: number) => {
    dispatch({ type: 'SET_ACTIVE_FILE', path });
    setExtractPage(page);
    // Leaving the board commits, so the panel reads committed bytes.
    invokeCommand('tools.panel.extract_text');
  }, [dispatch]);

  // The inspector cannot outlive its file.
  useEffect(() => {
    if (inspector && !state.files.has(inspector.path)) setInspector(null);
  }, [inspector, state.files]);

  // Keep refs to current state so the close handler always sees latest values
  const filesRef = useRef(state.files);
  filesRef.current = state.files;
  const pageDirtyRef = useRef(state.pageDirtyPaths);
  pageDirtyRef.current = state.pageDirtyPaths;

  // Handle window close — Rust intercepts CloseRequested and emits app:beforeClose
  useEffect(() => {
    const unlisten = app.onBeforeClose(async () => {
      const minimizeToTray = getSettings().minimizeToTray === true;
      const dirtyFiles = Array.from(filesRef.current.values()).filter(
        (f) => f.dirty || pageDirtyRef.current.includes(f.path),
      );
      if (dirtyFiles.length === 0) {
        if (minimizeToTray) {
          await app.hideToTray();
        } else {
          await app.confirmClose();
        }
        return;
      }
      const names = dirtyFiles.map((f) => f.name).join(', ');
      const result = await showConfirm(
        `Unsaved changes in: ${names}. Save before closing?`
      );
      if (result === 'cancel') {
        return;
      }
      if (result === 'save') {
        try {
          await commitRef.current();
        } catch {
          return;
        }
        for (const f of dirtyFiles) {
          await file.saveAs(f.workingPath, f.path);
        }
      }
      if (minimizeToTray) {
        await app.hideToTray();
      } else {
        await app.confirmClose();
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [showConfirm]);

  // Leaving doc-tab-land commits pending page edits (the "in-memory edits
  // exist only while a document tab is focused" invariant — the Tools panels
  // and Home always see materialized state). Doc→doc switches don't commit
  // (the tier is workspace-global). On failure the banner shows and the tier
  // stays pending. Re-keyed from the old view-transition effect (§ 6.6).
  const prevInDocRef = useRef(inDocTab);
  useEffect(() => {
    const prev = prevInDocRef.current;
    prevInDocRef.current = inDocTab;
    if (prev && !inDocTab) {
      void commitAndReport();
    }
  }, [inDocTab, commitAndReport]);

  // Focus a document's tab (tray/shell flows), or Home when nothing is open.
  const focusBoardOrHome = useCallback(() => {
    const firstDoc = tabFiles(stateRef.current)[0];
    dispatch({ type: 'UI_FOCUS_TAB', tab: firstDoc ? { doc: firstDoc.path } : 'home' });
  }, [dispatch]);

  // Handle tray actions (Quick Merge) — land on the document board (2o), or
  // Home (its Open button) when nothing is open yet.
  useEffect(() => {
    const unlisten = app.onTrayAction((action: string) => {
      if (action === 'merge') focusBoardOrHome();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [focusBoardOrHome]);

  // Handle files opened via file association, context menu, or second instance.
  // openByPaths focuses the opened doc's tab (strips + merge-up ARE the merge
  // flow, 2o — a shell "merge" open lands there like any multi-open).
  useEffect(() => {
    const unlisten = app.onOpenFile(async (data: { files: string[]; merge: boolean }) => {
      await openByPaths(data.files);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [openByPaths]);

  // Test harness — only compiled in when VITE_E2E=1 was set at build time.
  const harnessListenersRef = useRef<Set<(s: TestStateSnapshot) => void>>(new Set());
  const harnessSnapshotRef = useRef<() => TestStateSnapshot>(() => ({
    view: 'welcome', focusedTab: 'home', activeOp: 'merge', tool: 'select', activeToolId: null,
    docViewMode: 'document', currentPageId: null, fileCount: 0, activeFileId: null, activeFile: null,
  }));
  harnessSnapshotRef.current = () => ({
    view: viewOf(focusedTab),
    focusedTab,
    activeOp,
    tool: state.ui.tool,
    activeToolId: state.ui.activeToolId,
    docViewMode: state.ui.docViewMode,
    currentPageId: state.ui.currentPageId,
    fileCount: state.files.size,
    activeFileId: state.activeFileId,
    activeFile: activeFile
      ? {
          name: activeFile.name,
          path: activeFile.path,
          workingPath: activeFile.workingPath,
          pageCount: activeFile.pageCount,
          dirty: activeFile.dirty,
        }
      : null,
  });

  const harnessFirstPageRef = useRef<() => { docId: string; pageId: string } | null>(() => null);
  harnessFirstPageRef.current = () => {
    const doc = state.workspace.documents.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    return doc && page ? { docId: doc.id, pageId: page.id } : null;
  };

  const harnessFirstAnnotationRef = useRef<
    () => { docId: string; pageId: string; annotationId: string; kind: string; color: string; note?: string } | null
  >(() => null);
  harnessFirstAnnotationRef.current = () => {
    const doc = state.workspace.documents.find((d) => d.path === state.activeFileId);
    const page = doc?.pages[0];
    const annotation = page?.annotations?.[0];
    return doc && page && annotation
      ? {
          docId: doc.id,
          pageId: page.id,
          annotationId: annotation.id,
          kind: annotation.kind,
          color: annotation.color,
          note: annotation.note,
        }
      : null;
  };

  // Map the legacy harness setView onto the tab model so pre-M2 specs keep
  // working: welcome→Home, operations→Tools, canvas→the active (or first)
  // document's tab (a no-op to Home when nothing is open).
  const harnessSetView = useCallback(
    (v: 'welcome' | 'operations' | 'canvas') => {
      if (v === 'welcome') dispatch({ type: 'UI_FOCUS_TAB', tab: 'home' });
      else if (v === 'operations') dispatch({ type: 'UI_FOCUS_TAB', tab: 'tools' });
      else {
        const s = stateRef.current;
        // The shared rule, not a copy of it — the harness must answer "which
        // document is in front?" exactly as production does, or 16 e2e specs
        // silently drift from the app they're testing.
        const target = showableDoc(s) ?? tabFiles(s)[0]?.path ?? null;
        dispatch({ type: 'UI_FOCUS_TAB', tab: target ? { doc: target } : 'home' });
      }
    },
    [dispatch],
  );

  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    installTestHarness({
      openByPaths: (paths) => openByPaths(paths),
      setView: (v) => harnessSetView(v),
      focusTab: (tab) => dispatch({ type: 'UI_FOCUS_TAB', tab }),
      setActiveOp: (op) => setActiveOp(op as Operation),
      setTool: (tool) => dispatch({ type: 'UI_SET_TOOL', tool: tool as CanvasTool }),
      setDocViewMode: (mode) => dispatch({ type: 'UI_SET_DOC_VIEW_MODE', mode }),
      getStateSnapshot: () => harnessSnapshotRef.current(),
      subscribe: (listener) => {
        harnessListenersRef.current.add(listener);
        return () => harnessListenersRef.current.delete(listener);
      },
      getFirstPage: () => harnessFirstPageRef.current(),
      getActiveDocPages: () =>
        stateRef.current.workspace.documents
          .filter((d) => d.path === stateRef.current.activeFileId)
          .flatMap((d) => d.pages.map((p) => ({ id: p.id, width: p.width, height: p.height }))),
      getFirstPageAnnotation: () => harnessFirstAnnotationRef.current(),
      dispatchAddAnnotation: (docId, pageId, annotation) =>
        dispatch({ type: 'ADD_ANNOTATION', docId, pageId, annotation }),
      dispatchRecolorAnnotation: (docId, pageId, annotationId, color) =>
        dispatch({ type: 'RECOLOR_ANNOTATION', docId, pageId, annotationId, color }),
      dispatchRemoveAnnotation: (docId, pageId, annotationId) =>
        dispatch({ type: 'REMOVE_ANNOTATION', docId, pageId, annotationId }),
      commitPendingEdits: () => commitRef.current(),
      closeAllFiles: () => {
        for (const f of filesRef.current.values()) dispatch({ type: 'CLOSE_FILE', path: f.path });
      },
      importPagesIntoDoc: (filePath, toDocId, toIndex) =>
        importFilesIntoDoc([filePath], toDocId, toIndex),
    });
  }, [openByPaths, dispatch, importFilesIntoDoc, harnessSetView, setActiveOp]);

  // Notify harness subscribers on every state-relevant change.
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    const snap = harnessSnapshotRef.current();
    harnessListenersRef.current.forEach((l) => l(snap));
  }, [focusedTab, activeOp, state.ui.tool, state.ui.activeToolId, state.files, state.activeFileId, activeFile?.dirty, activeFile?.pageCount]);

  const Panel = panels[activeOp];

  return (
    <DropZone onFilesDropped={handleFilesDropped}>
    <div className="app-shell h-screen bg-neutral-900 text-neutral-100 flex flex-col overflow-hidden">
      <MenuBar />
      <MainToolbar />

      <UpdateBar checkSignal={updateCheckSignal} />

      {commitError && (
        <div data-testid="commit-error-bar" className="app-banner flex items-center gap-3 px-4 py-2 bg-red-600/20 border-b border-red-500/40 text-sm text-red-200 shrink-0">
          <span className="flex-1">{commitError}</span>
          <button
            onClick={() => void commitAndReport()}
            className="px-2 py-0.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded font-medium"
          >
            Retry
          </button>
          <button
            onClick={() => setCommitError(null)}
            className="text-red-300 hover:text-red-100 text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      <TabStrip onCloseFile={(path) => void handleCloseFile(path)} />

      <div className="flex flex-1 overflow-hidden">
          <main className="app-content flex-1 flex flex-col overflow-hidden">
          {focusedTab === 'home' ? (
            <HomeTab
              recentFiles={recentFiles}
              onOpen={() => invokeCommand('file.open')}
              onOpenRecent={(path) => void openByPaths([path])}
              onClearRecent={() => invokeCommand('file.clearRecent')}
            />
          ) : focusedTab === 'tools' ? (
            !activeTool ? (
            // The tab's landing state: what job are you here to do? (§ 7)
            <ToolsCenter onOpenTool={(id) => invokeCommand(`tools.open.${id}`)} />
          ) : (
            <div className="flex-1 flex flex-col p-6 min-h-0">
              <div className="tool-pane-head shrink-0">
                <button
                  type="button"
                  data-testid="tool-back"
                  className="tool-back"
                  onClick={() => dispatch({ type: 'UI_OPEN_TOOL', toolId: null })}
                  title="All tools"
                >
                  ‹ Tools
                </button>
                <h2 className="text-lg font-medium">{activeTool.title}</h2>
                {/* Which document the tool acts on. The Tools tab isn't a doc
                    tab, so the panels need a target named somewhere — this is
                    the old rail's Active File list, as one control instead of a
                    standing column. Hidden for a single file: a picker with one
                    choice asks a question that has no other answer. */}
                {tabFileList.length > 1 && (
                  <label className="tool-pane-file">
                    <span className="tool-pane-file-label">File</span>
                    <select
                      data-testid="tools-active-file"
                      // Clamped to a file this list actually offers. React
                      // resolves a controlled <select> whose value matches no
                      // <option> by selecting the FIRST one — so an active file
                      // that isn't in the list wouldn't show as "unset", it
                      // would confidently name the wrong document while the
                      // panels worked on another. Defence in depth — the reducer
                      // refuses to make a ghost active, so this should be
                      // unreachable; it stays because the failure mode it
                      // prevents is a control that LIES rather than one that
                      // looks broken, and that is the wrong way to degrade.
                      value={selectableFile ?? ''}
                      onChange={(e) => dispatch({ type: 'SET_ACTIVE_FILE', path: e.target.value })}
                    >
                      {selectableFile === null && <option value="">—</option>}
                      {tabFileList.map((f) => (
                        <option key={f.path} value={f.path}>
                          {isFileDirty(f) ? `* ${f.name}` : f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {/* A tool that hosts several operations lists them: the tool is the
                  JOB, these are the ways of doing it. One-op tools show no
                  switcher — a single-item list is noise. */}
              {activeTool.ops.length > 1 && (
                <div className="tool-op-switch shrink-0" data-testid="tool-op-switch">
                  {activeTool.ops.map((op) => (
                    <button
                      key={op}
                      type="button"
                      data-testid={`tool-op-${op}`}
                      aria-pressed={activeOp === op}
                      className={'tool-op' + (activeOp === op ? ' active' : '')}
                      onClick={() => invokeCommand(`tools.panel.${op}`)}
                    >
                      <ToolIcon op={op} />
                      {OPERATION_TITLES[op]}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex-1 min-h-0">
                {activeTool.ops.length === 0 ? (
                  // The tool's work is on the PAGE — it has no form here. Say
                  // that, and offer the way back. Rendering `panels[activeOp]`
                  // would put some unrelated operation's form under this tool's
                  // name, which is § 3.3's absence fence exactly: an empty or
                  // borrowed shell instead of an honest statement.
                  <div className="tool-on-canvas" data-testid="tool-on-canvas">
                    <p>{activeTool.title} works directly on the page.</p>
                    <button
                      type="button"
                      data-testid="tool-on-canvas-go"
                      className="tool-op"
                      onClick={() => invokeCommand(`tools.open.${activeTool.id}`)}
                    >
                      Go to the document
                    </button>
                  </div>
                ) : activeOp === 'extract_text' ? (
                  <ExtractTextPanel initialPage={extractPage} onConsumeInitialPage={() => setExtractPage(null)} />
                ) : (
                  <Panel />
                )}
              </div>
            </div>
            )
          ) : (
            <div className="flex-1 flex flex-row overflow-hidden">
              {/* Left navigation pane (M3) — thumbnails etc. for the active doc */}
              <NavPane
                activeFile={activeFile ?? null}
                onOpenPage={(path, pageNumber) => void handleInspectPage(path, pageNumber)}
                onExtractText={handleExtractFromCanvas}
              />
              <div className="flex-1 flex flex-col relative overflow-hidden">
                <WorkspaceCanvasView
                  onOpenFiles={() => void handleOpenFile()}
                  onCloseFile={(path) => void handleCloseFile(path)}
                  onInspectPage={(path, pageNumber) => void handleInspectPage(path, pageNumber)}
                  onExtractText={handleExtractFromCanvas}
                  onRedactFile={handleRedactFile}
                  onApplyOcrLayer={handleApplyOcrLayer}
                  onAddPages={handleAddPages}
                  onFillFormValues={handleFillFormValues}
                  onAddFormField={handleAddFormField}
                  dropResolverRef={dropResolverRef}
                />
                {inspector && inspectorFile?.buffer && (
                  <div className="absolute inset-0 z-40 bg-neutral-900">
                    <PageInspector
                      buffer={inspectorFile.buffer}
                      page={inspector.page}
                      onClose={() => setInspector(null)}
                      onRotate={handleInspectorRotate}
                      onDelete={handleInspectorDelete}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Operation queue */}
      <OperationQueue items={queue} onClear={clearQueue} />

      {/* Settings modal — accessible from Edit ▸ Preferences / Help ▸ Licenses */}
      {showSettings !== null && (
        <div data-app-modal className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setShowSettings(null)}>
          <div className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[640px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
              <h3 className="text-sm font-semibold">Preferences</h3>
              <button data-testid="prefs-close" onClick={() => setShowSettings(null)} className="text-neutral-500 hover:text-neutral-300 text-sm">Close</button>
            </div>
            <div className="p-5">
              <SettingsPanel initialCategory={showSettings} />
            </div>
          </div>
        </div>
      )}
      {showProperties && <PropertiesDialog onClose={() => setShowProperties(false)} />}
      {showPrint && <PrintDialog onClose={() => setShowPrint(false)} />}
      {showAbout && <AboutDialog version={appVersion} onClose={() => setShowAbout(false)} />}
      <ConfirmDialog
        open={confirmState !== null}
        message={confirmState?.message ?? ''}
        onResult={handleConfirmResult}
      />
      <PasswordDialog
        open={passwordState !== null}
        fileName={passwordState?.fileName ?? ''}
        error={passwordState?.error}
        onResult={handlePasswordResult}
      />
    </div>
    </DropZone>
  );
}

export function App(): React.ReactElement {
  return (
    <QueueProvider>
      <AppStateProvider>
        <SearchProvider>
          <AppContent />
        </SearchProvider>
      </AppStateProvider>
    </QueueProvider>
  );
}
