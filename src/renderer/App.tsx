import React, { useState, useCallback, useEffect, useRef } from 'react';
import { AppStateProvider, useAppState, useAppDispatch } from './state/AppStateProvider';
import { file, app } from './lib/tauri-bridge';
import { ConfirmDialog, ConfirmResult } from './components/ConfirmDialog';
import { PasswordDialog, PasswordResult } from './components/PasswordDialog';
import { Sidebar, Operation } from './components/Sidebar';
import { PageInspector } from './components/PageInspector';
import { SplitPanel } from './panels/SplitPanel';
import { RotatePanel } from './panels/RotatePanel';
import { DeletePanel } from './panels/DeletePanel';
import { CompressPanel } from './panels/CompressPanel';
import { PdfaPanel } from './panels/PdfaPanel';
import { EncryptPanel } from './panels/EncryptPanel';
import { DecryptPanel } from './panels/DecryptPanel';
import { ExtractTextPanel } from './panels/ExtractTextPanel';
import { MetadataPanel } from './panels/MetadataPanel';
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
import type { CanvasTool } from './state/types';
import { WorkspaceCanvasView } from './components/canvas/WorkspaceCanvasView';
import type { CanvasDropResolver } from './components/canvas/WorkspaceCanvasView';
import { commitPageEdits } from './lib/workspace-commit';
import { setCommitGate } from './lib/commit-gate';
import { fillFormFields, readFormFields } from './lib/forms';
import type { FormFieldValue } from './lib/forms';
import { resolveFillTargets } from './lib/form-overlay';
import { addFormField } from './lib/form-authoring';
import type { NewFieldSpec } from './lib/form-authoring';
import { DropZone } from './components/DropZone';
import { OperationQueue } from './components/OperationQueue';
import { QueueProvider, useOperationQueue } from './hooks/useOperationQueue';
import { SettingsPanel, getSettings } from './panels/SettingsPanel';
import { MenuBar } from './components/MenuBar';
import { MainToolbar } from './components/MainToolbar';
import { TabStrip } from './components/TabStrip';
import { HomeTab } from './components/HomeTab';
import { AboutDialog } from './components/AboutDialog';
import { UpdateBar } from './components/UpdateBar';
import { NavPane } from './components/navpane/NavPane';
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
  extract_text: ExtractTextPanel, metadata: MetadataPanel,
  watermark: WatermarkPanel, forms: FormsPanel, compare: ComparePanel,
  signatures: SignaturesPanel,
  repair: RepairPanel, rebuild: RebuildPanel, recover: RecoverPanel,
};

const titles: Record<Operation, string> = {
  split: 'Split by Range', rotate: 'Rotate Pages', delete: 'Delete Pages',
  compress: 'Compress', grayscale: 'Convert to Grayscale', optimize: 'Optimize PDF',
  pdfa: 'Convert to PDF/A', pdf_version: 'Set PDF Version',
  encrypt: 'Encrypt PDF', decrypt: 'Decrypt PDF',
  extract_text: 'Extract Text', metadata: 'Edit Metadata',
  watermark: 'Watermark', forms: 'Fill Form', compare: 'Compare PDFs',
  signatures: 'Signatures',
  repair: 'Repair PDF', rebuild: 'Rebuild PDF', recover: 'Recover Pages',
};

function AppContent(): React.ReactElement {
  const state = useAppState();
  const dispatch = useAppDispatch();
  // The tab model lives in the ui slice (Phase 4 M2) so the command registry,
  // menus, and tab strip all read it. focusedTab replaces the old `view`.
  const focusedTab = state.ui.focusedTab;
  const inDocTab = isDocTab(focusedTab);
  const activeOp = state.ui.activeOp as Operation;
  const setActiveOp = useCallback(
    (op: Operation) => dispatch({ type: 'UI_SET_ACTIVE_OP', op }),
    [dispatch],
  );
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
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
  const tabFileList = Array.from(state.files.values()).filter((f) => !f.importOnly);

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
  const openByPaths = useCallback(async (paths: string[]) => {
    let recent = stateRef.current.ui.recentFiles;
    let lastOpened: string | null = null;
    let changed = false;
    try {
      for (const filePath of paths) {
        if (state.files.has(filePath)) {
          dispatch({ type: 'SET_ACTIVE_FILE', path: filePath });
          recent = withRecent(recent, filePath); // only on success — a cancel/throw
          lastOpened = filePath;                  // must not pollute Recent (review-caught)
          changed = true;
          continue;
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
      if (lastOpened) dispatch({ type: 'UI_FOCUS_TAB', tab: { doc: lastOpened } });
    }
  }, [state.files, dispatch, prepareFileBytes]);

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
    openPath: (path) => openByPaths([path]),
    save: handleSave,
    saveAs: handleSaveAs,
    closeFile: handleCloseFile,
    closeAll: handleCloseAll,
    undo: handleUndo,
    redo: handleRedo,
    applyPageEdits: commitAndReport,
    openPreferences: () => setShowSettings(true),
    openLicenses: () => setShowSettings(true),
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
      openPath: (path) => h.current.openPath(path),
      save: () => h.current.save(),
      saveAs: () => h.current.saveAs(),
      closeFile: (path) => h.current.closeFile(path),
      closeAll: () => h.current.closeAll(),
      undo: () => h.current.undo(),
      redo: () => h.current.redo(),
      applyPageEdits: () => h.current.applyPageEdits(),
      openPreferences: () => h.current.openPreferences(),
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
    const firstDoc = Array.from(filesRef.current.values()).find((f) => !f.importOnly);
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
    view: 'welcome', focusedTab: 'home', activeOp: 'merge', fileCount: 0,
    activeFileId: null, activeFile: null,
  }));
  harnessSnapshotRef.current = () => ({
    view: viewOf(focusedTab),
    focusedTab,
    activeOp,
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
        const target =
          (s.activeFileId && !s.files.get(s.activeFileId)?.importOnly && s.activeFileId) ||
          Array.from(s.files.values()).find((f) => !f.importOnly)?.path ||
          null;
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
      getStateSnapshot: () => harnessSnapshotRef.current(),
      subscribe: (listener) => {
        harnessListenersRef.current.add(listener);
        return () => harnessListenersRef.current.delete(listener);
      },
      getFirstPage: () => harnessFirstPageRef.current(),
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
  }, [focusedTab, activeOp, state.files, state.activeFileId, activeFile?.dirty, activeFile?.pageCount]);

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
        {/* Tools tab: active-file switcher + operations rail + the active panel */}
        {focusedTab === 'tools' && (
          <div className="app-rail flex flex-col shrink-0 border-r border-neutral-800">
            {tabFileList.length > 0 && (
              <div className="w-48 border-b border-neutral-800 py-2 shrink-0 max-h-48 overflow-y-auto">
                <div className="px-4 pb-1 text-[10px] uppercase tracking-widest text-neutral-300 font-semibold">
                  Active File
                </div>
                {tabFileList.map((f) => (
                  <button
                    key={f.path}
                    data-testid="tools-active-file"
                    onClick={() => dispatch({ type: 'SET_ACTIVE_FILE', path: f.path })}
                    className={`w-full px-4 py-1.5 text-left text-sm truncate transition-colors ${
                      f.dirty ? 'italic' : ''
                    } ${
                      state.activeFileId === f.path
                        ? 'bg-neutral-700 text-white'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800'
                    }`}
                    title={f.path}
                  >
                    {isFileDirty(f) && <span className="text-amber-400 mr-1 not-italic">*</span>}
                    {f.name}
                  </button>
                ))}
              </div>
            )}
            <Sidebar active={activeOp} onSelect={(op) => invokeCommand(`tools.panel.${op}`)} />
          </div>
        )}

        <main className="app-content flex-1 flex flex-col overflow-hidden">
          {focusedTab === 'home' ? (
            <HomeTab
              recentFiles={recentFiles}
              onOpen={() => invokeCommand('file.open')}
              onOpenRecent={(path) => void openByPaths([path])}
              onClearRecent={() => invokeCommand('file.clearRecent')}
            />
          ) : focusedTab === 'tools' ? (
            <div className="flex-1 flex flex-col p-6 min-h-0">
              <h2 className="text-lg font-medium mb-4 shrink-0">{titles[activeOp]}</h2>
              <div className="flex-1 min-h-0">
                {activeOp === 'extract_text' ? (
                  <ExtractTextPanel initialPage={extractPage} onConsumeInitialPage={() => setExtractPage(null)} />
                ) : (
                  <Panel />
                )}
              </div>
            </div>
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
      {showSettings && (
        <div data-app-modal className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setShowSettings(false)}>
          <div className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[500px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
              <h3 className="text-sm font-semibold">Preferences</h3>
              <button onClick={() => setShowSettings(false)} className="text-neutral-500 hover:text-neutral-300 text-sm">Close</button>
            </div>
            <div className="p-5">
              <SettingsPanel />
            </div>
          </div>
        </div>
      )}
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
        <AppContent />
      </AppStateProvider>
    </QueueProvider>
  );
}
