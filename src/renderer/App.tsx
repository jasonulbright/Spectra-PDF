import React, { useState, useCallback, useEffect, useRef } from 'react';
import { AppStateProvider, useAppState, useAppDispatch } from './state/AppStateProvider';
import { file, app } from './lib/tauri-bridge';
import { ConfirmDialog, ConfirmResult } from './components/ConfirmDialog';
import { PasswordDialog, PasswordResult } from './components/PasswordDialog';
import { Sidebar, Operation } from './components/Sidebar';
import { PageInspector } from './components/PageInspector';
import { MergePanel } from './panels/MergePanel';
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
import { OutlinePanel } from './panels/OutlinePanel';
import { WatermarkPanel } from './panels/WatermarkPanel';
import { FormsPanel } from './panels/FormsPanel';
import { ComparePanel } from './panels/ComparePanel';
import { SignaturesPanel } from './panels/SignaturesPanel';
import { useEngine } from './hooks/useEngine';
import { useWorkspaceIndexer } from './hooks/useWorkspaceIndexer';
import { WorkspaceCanvasView } from './components/canvas/WorkspaceCanvasView';
import { commitPageEdits } from './lib/workspace-commit';
import { setCommitGate } from './lib/commit-gate';
import { DropZone } from './components/DropZone';
import { OperationQueue } from './components/OperationQueue';
import { QueueProvider, useOperationQueue } from './hooks/useOperationQueue';
import { SettingsPanel, getSettings } from './panels/SettingsPanel';
import { WelcomeScreen } from './components/WelcomeScreen';
import { UpdateBar } from './components/UpdateBar';
import { installTestHarness, TEST_HARNESS_ENABLED } from './testHarness';
import type { TestStateSnapshot } from './testHarness';

type ViewMode = 'operations' | 'canvas';

const panels: Record<Operation, React.ComponentType> = {
  merge: MergePanel, split: SplitPanel, rotate: RotatePanel, delete: DeletePanel,
  compress: CompressPanel, grayscale: GrayscalePanel, optimize: OptimizePanel,
  pdfa: PdfaPanel, pdf_version: PdfVersionPanel,
  encrypt: EncryptPanel, decrypt: DecryptPanel,
  extract_text: ExtractTextPanel, metadata: MetadataPanel, outline: OutlinePanel,
  watermark: WatermarkPanel, forms: FormsPanel, compare: ComparePanel,
  signatures: SignaturesPanel,
  repair: RepairPanel, rebuild: RebuildPanel, recover: RecoverPanel,
};

const titles: Record<Operation, string> = {
  merge: 'Merge PDFs', split: 'Split by Range', rotate: 'Rotate Pages', delete: 'Delete Pages',
  compress: 'Compress', grayscale: 'Convert to Grayscale', optimize: 'Optimize PDF',
  pdfa: 'Convert to PDF/A', pdf_version: 'Set PDF Version',
  encrypt: 'Encrypt PDF', decrypt: 'Decrypt PDF',
  extract_text: 'Extract Text', metadata: 'Edit Metadata', outline: 'Bookmarks',
  watermark: 'Watermark', forms: 'Fill Form', compare: 'Compare PDFs',
  signatures: 'Signatures',
  repair: 'Repair PDF', rebuild: 'Rebuild PDF', recover: 'Recover Pages',
};

function AppContent(): React.ReactElement {
  const [view, setView] = useState<ViewMode | 'welcome'>(() =>
    localStorage.getItem('spectra-skip-welcome') === 'true' ? 'operations' : 'welcome'
  );
  const [activeOp, setActiveOp] = useState<Operation>('merge');
  const [showSettings, setShowSettings] = useState(false);
  const { items: queue, clear: clearQueue } = useOperationQueue();
  const [extractPage, setExtractPage] = useState<number | null>(null);
  const [recentFiles, setRecentFiles] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('spectra-recent') || '[]'); } catch { return []; }
  });
  const [appVersion, setAppVersion] = useState('');
  // PageInspector overlay target (canvas view). `page` is the file's
  // committed page order — the opener commits pending edits first.
  const [inspector, setInspector] = useState<{ path: string; page: number } | null>(null);
  const state = useAppState();
  const dispatch = useAppDispatch();
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

  const addRecent = useCallback((filePath: string) => {
    setRecentFiles((prev) => {
      const next = [filePath, ...prev.filter((f) => f !== filePath)].slice(0, 10);
      localStorage.setItem('spectra-recent', JSON.stringify(next));
      return next;
    });
  }, []);

  const activeFile = state.activeFileId ? state.files.get(state.activeFileId) : null;
  const allFiles = Array.from(state.files.values());
  const inspectorFile = inspector ? state.files.get(inspector.path) : null;

  // Commit-failure banner: commits triggered from gates/effects have no
  // natural place to report, so failures surface here.
  const [commitError, setCommitError] = useState<string | null>(null);

  // Materialize pending in-memory page edits onto the snapshot undo chain.
  // Runs before anything that reads or replaces file bytes (save, whole-file
  // ops, close) — all dirty files commit together because cross-file moves
  // entangle them. Uses the raw (ungated) snapshot to avoid re-entering the
  // commit gate.
  //
  // Every entry point (gate, Apply button, save/close, inspector open,
  // leave-view effect) shares ONE in-flight run: two overlapping commits
  // stage and rename the same working files and consume each other's temps —
  // e.g. double-click a page and hit "Apply changes" during the ~200ms the
  // first commit is writing, and the second rename hits ENOENT.
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

  const openByPaths = useCallback(async (paths: string[]) => {
    for (const filePath of paths) {
      if (state.files.has(filePath)) {
        dispatch({ type: 'SET_ACTIVE_FILE', path: filePath });
        addRecent(filePath);
        continue;
      }
      const workingPath = await file.createWorkingCopy(filePath);
      const fileName = filePath.split(/[\\/]/).pop() || filePath;

      // Check if encrypted and prompt for password if needed
      const encStatus = await call('check_encrypted', { file: workingPath });
      if (encStatus.encrypted) {
        let unlocked = false;
        let error: string | undefined;
        while (!unlocked) {
          const result = await showPasswordPrompt(fileName, error);
          if (result === 'cancel') break;
          try {
            await call('unlock', { file: workingPath, password: result.password });
            unlocked = true;
          } catch {
            error = 'Incorrect password. Please try again.';
          }
        }
        if (!unlocked) continue; // User cancelled — skip this file
      }

      const buffer = await file.readBuffer(workingPath);
      const info = await call('get_page_count', { file: workingPath });
      dispatch({
        type: 'OPEN_FILE',
        path: filePath,
        workingPath,
        name: fileName,
        pageCount: info.pages,
        buffer,
      });
      addRecent(filePath);
    }
  }, [state.files, call, dispatch, addRecent, showPasswordPrompt]);

  // Drag-drop handler: open files, then navigate based on count. Drops while
  // in the canvas stay there — new files appear as strips in place.
  const handleFilesDropped = useCallback(async (paths: string[]) => {
    await openByPaths(paths);
    if (paths.length === 0 || view === 'canvas') return;
    if (paths.length >= 2) {
      setView('operations');
      setActiveOp('merge');
    } else {
      setView('canvas');
    }
  }, [openByPaths, view]);

  const handleOpenFile = useCallback(async (): Promise<boolean> => {
    const paths = await openFiles();
    if (paths.length > 0) {
      await openByPaths(paths);
      return true;
    }
    return false;
  }, [openFiles, openByPaths]);

  const handleWelcomeAction = useCallback(async (action: string) => {
    if (action === 'open') {
      if (state.files.size > 0) {
        setView('canvas');
      } else {
        const opened = await handleOpenFile();
        if (opened) setView('canvas');
      }
    } else if (action === 'merge') {
      setView('operations');
      setActiveOp('merge');
    } else if (action === 'compress') {
      setView('operations');
      setActiveOp('compress');
    } else if (action === 'secure') {
      setView('operations');
      setActiveOp('encrypt');
    } else if (action === 'content') {
      setView('operations');
      setActiveOp('extract_text');
    } else if (action === 'recent' && recentFiles.length > 0) {
      await openByPaths([recentFiles[0]]);
      setView('canvas');
    } else if (action.startsWith('open:')) {
      await openByPaths([action.slice(5)]);
      setView('canvas');
    }
  }, [handleOpenFile, openByPaths, recentFiles, state.files]);

  // Snapshot + perform operation + reload
  const performOperation = useCallback(async (
    filePath: string,
    method: string,
    params: Record<string, unknown>,
  ) => {
    const f = state.files.get(filePath);
    if (!f) return;
    // Snapshot before mutation. file.snapshot runs the commit gate first, so
    // pending page edits are on disk before the snapshot and the engine call.
    const snapshotPath = await file.snapshot(f.workingPath);
    // Perform operation on working copy
    await call(method, { ...params, file: f.workingPath, output: f.workingPath });
    // Reload
    const result = await reloadFile(filePath);
    if (result) {
      dispatch({ type: 'UPDATE_FILE', path: filePath, pageCount: result.pageCount, buffer: result.buffer, snapshotPath });
    }
  }, [state.files, call, reloadFile, dispatch]);

  // Canvas redaction — same snapshot/gate/reload flow as the inspector ops.
  // Destructive by design, so it must NOT use the panels' save-to-new-file
  // pattern: the snapshot keeps it undoable while the file is open, and the
  // gate materializes pending page edits so the engine sees the page order
  // and rotations the marks were drawn against.
  const handleRedactFile = useCallback(
    async (path: string, regions: { page: number; rect: [number, number, number, number] }[]) => {
      await performOperation(path, 'redact', { regions });
    },
    [performOperation],
  );

  // Persist OCR text layers (2m) — same routing as redaction: the commit
  // gate flushes pending page edits, a snapshot lands on the undo chain, and
  // the buffer reloads (which also invalidates the search index for the
  // file, so Find re-reads the now-searchable text).
  const handleApplyOcrLayer = useCallback(
    async (
      path: string,
      pages: { page: number; words: { text: string; rect: [number, number, number, number] }[] }[],
    ) => {
      await performOperation(path, 'apply_ocr_layer', { pages });
    },
    [performOperation],
  );

  // Inspector overlay ops — engine-backed, so they run against the committed
  // file (the inspector opener commits before handing over a page number).
  const handleInspectorRotate = useCallback(async (page: number, angle: number) => {
    if (!inspector) return;
    await performOperation(inspector.path, 'rotate', { pages: [page], angle });
  }, [inspector, performOperation]);

  const handleInspectorDelete = useCallback(async (page: number) => {
    if (!inspector) return;
    await performOperation(inspector.path, 'delete', { pages: [page] });
    setInspector(null); // page numbering shifted — the canvas is the safe place
  }, [inspector, performOperation]);

  const handleUndo = useCallback(async () => {
    // Page-edit tier first: pending in-memory edits are always newer than the
    // last disk snapshot (commit drains the tier before whole-file ops).
    if (state.pageUndoStack.length > 0) {
      dispatch({ type: 'UNDO_PAGE_OP' });
      return;
    }
    if (!activeFile || activeFile.undoStack.length === 0) return;
    const snapshotPath = activeFile.undoStack[activeFile.undoStack.length - 1];
    // Capture the current state first so redo can come back to it. Raw
    // snapshot — the page tier is empty here, the gate has nothing to do.
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

  // Open the PageInspector overlay from the canvas. Pending edits commit
  // first so the file's on-disk order matches the workspace numbering the
  // canvas computed, and the inspector's engine ops hit the right page.
  const handleInspectPage = useCallback(async (path: string, page: number) => {
    if (!(await commitOrAbort())) return;
    dispatch({ type: 'SET_ACTIVE_FILE', path });
    setInspector({ path, page });
  }, [commitOrAbort, dispatch]);

  const handleExtractFromCanvas = useCallback((path: string, page: number) => {
    dispatch({ type: 'SET_ACTIVE_FILE', path });
    setExtractPage(page);
    setView('operations'); // leaving the canvas commits, so the panel reads committed bytes
    setActiveOp('extract_text');
  }, [dispatch]);

  // The inspector cannot outlive its file.
  useEffect(() => {
    if (inspector && !state.files.has(inspector.path)) setInspector(null);
  }, [inspector, state.files]);

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

  // Keep refs to current state so the close handler always sees latest values
  const filesRef = useRef(state.files);
  filesRef.current = state.files;
  const pageDirtyRef = useRef(state.pageDirtyPaths);
  pageDirtyRef.current = state.pageDirtyPaths;

  // Handle window close — Rust intercepts CloseRequested and emits app:beforeClose
  useEffect(() => {
    const unlisten = app.onBeforeClose(async () => {
      const minimizeToTray = getSettings().minimizeToTray === true;

      // If no dirty files, either minimize to tray or close
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
        return; // Do nothing — window stays open
      }
      if (result === 'save') {
        try {
          await commitRef.current();
        } catch {
          return; // commit failed — keep the window open, edits still pending
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
  }, []);

  // Leaving the canvas commits pending page edits, making "in-memory edits
  // exist only while in canvas view" the invariant — Pages/Inspector and the
  // operation panels always see materialized state. On failure the banner
  // shows and the tier stays pending (the engine-call/snapshot gates still
  // protect any operation attempted meanwhile).
  const prevViewRef = useRef(view);
  useEffect(() => {
    const prev = prevViewRef.current;
    prevViewRef.current = view;
    if (prev === 'canvas' && view !== 'canvas') {
      void commitAndReport();
    }
  }, [view, commitAndReport]);

  // Handle tray actions (Quick Merge)
  useEffect(() => {
    const unlisten = app.onTrayAction((action: string) => {
      if (action === 'merge') {
        setView('operations');
        setActiveOp('merge');
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Handle files opened via file association, context menu, or second instance
  useEffect(() => {
    const unlisten = app.onOpenFile(async (data: { files: string[]; merge: boolean }) => {
      await openByPaths(data.files);
      if (data.merge && data.files.length > 0) {
        setView('operations');
        setActiveOp('merge');
      } else {
        setView('canvas');
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [openByPaths]);

  // Test harness — only compiled in when VITE_E2E=1 was set at build time.
  const harnessListenersRef = useRef<Set<(s: TestStateSnapshot) => void>>(new Set());
  const harnessSnapshotRef = useRef<() => TestStateSnapshot>(() => ({
    view: 'welcome', activeOp: 'merge', fileCount: 0,
    activeFileId: null, activeFile: null,
  }));
  harnessSnapshotRef.current = () => ({
    view,
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

  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    installTestHarness({
      openByPaths: (paths) => openByPaths(paths),
      setView: (v) => setView(v),
      setActiveOp: (op) => setActiveOp(op as Operation),
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
    });
  }, [openByPaths, dispatch]);

  // Notify harness subscribers on every state-relevant change.
  useEffect(() => {
    if (!TEST_HARNESS_ENABLED) return;
    const snap = harnessSnapshotRef.current();
    harnessListenersRef.current.forEach((l) => l(snap));
  }, [view, activeOp, state.files, state.activeFileId, activeFile?.dirty, activeFile?.pageCount]);

  const Panel = panels[activeOp];
  const canUndo =
    state.pageUndoStack.length > 0 || (activeFile ? activeFile.undoStack.length > 0 : false);
  const canRedo =
    state.pageRedoStack.length > 0 || (activeFile ? activeFile.redoStack.length > 0 : false);

  return (
    <DropZone onFilesDropped={handleFilesDropped}>
    <div className="h-screen bg-neutral-900 text-neutral-100 flex flex-col overflow-hidden">
      {/* Header */}
      <header data-testid="app-header" className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 shrink-0">
        <div className="flex items-center gap-3">
          <h1 data-testid="app-title" className="text-lg font-semibold tracking-tight">Spectra PDF</h1>
          <span data-testid="app-version" className="text-[10px] text-neutral-500 bg-neutral-800 px-1.5 py-0.5 rounded">{appVersion}</span>
          <button data-testid="settings-btn" onClick={() => setShowSettings(true)} className="w-6 h-6 flex items-center justify-center text-neutral-500 hover:text-neutral-300 rounded transition-colors" title="Settings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-2">
          {/* Undo / Save — in canvas view with an active file */}
          {view === 'canvas' && activeFile && (
            <>
              <button data-testid="undo-btn" onClick={handleUndo} disabled={!canUndo} className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-30 rounded font-medium" title="Undo last action">
                Undo
              </button>
              <button data-testid="redo-btn" onClick={handleRedo} disabled={!canRedo} className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-30 rounded font-medium" title="Redo">
                Redo
              </button>
              <button data-testid="save-btn" onClick={handleSave} disabled={!isFileDirty(activeFile)} className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-30 rounded font-medium" title="Save to original file">
                Save
              </button>
              <button data-testid="save-as-btn" onClick={handleSaveAs} className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 rounded font-medium" title="Save as new file">
                Save As
              </button>
            </>
          )}
          <button data-testid="open-pdf-btn" onClick={handleOpenFile} className="px-3 py-1 text-xs text-white bg-blue-600 hover:bg-blue-500 rounded font-medium">
            Open PDF
          </button>
          <div data-testid="view-switcher" className="flex bg-neutral-800 rounded overflow-hidden">
            <button
              data-testid="view-home"
              onClick={() => setView('welcome')}
              className={`px-3 py-1 text-xs font-medium ${view === 'welcome' ? 'bg-neutral-600 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}
            >
              Home
            </button>
            <button
              data-testid="view-tools"
              onClick={() => setView('operations')}
              className={`px-3 py-1 text-xs font-medium ${view === 'operations' ? 'bg-neutral-600 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}
            >
              Tools
            </button>
            <button
              data-testid="view-canvas"
              onClick={() => setView('canvas')}
              className={`px-3 py-1 text-xs font-medium ${view === 'canvas' ? 'bg-neutral-600 text-white' : 'text-neutral-400 hover:text-neutral-200'}`}
            >
              Canvas
            </button>
          </div>
        </div>
      </header>

      <UpdateBar />

      {commitError && (
        <div data-testid="commit-error-bar" className="flex items-center gap-3 px-4 py-2 bg-red-600/20 border-b border-red-500/40 text-sm text-red-200 shrink-0">
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

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — operations + open files in tools view */}
        {view === 'operations' && (
          <div className="flex flex-col shrink-0 border-r border-neutral-800">
            {allFiles.length > 0 && (
              <div className="w-48 border-b border-neutral-800 py-2 shrink-0">
                <div className="flex items-center justify-between px-4 pb-1">
                <span className="text-[10px] uppercase tracking-widest text-neutral-300 font-semibold">Active File</span>
                <button onClick={handleCloseAll} className="text-neutral-500 hover:text-red-400 transition-colors" title="Close all files">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M1 1l8 8M9 1l-8 8"/></svg>
                </button>
              </div>
                {allFiles.map((f) => (
                  <div key={f.path} className="flex items-center group">
                    <button
                      onClick={() => dispatch({ type: 'SET_ACTIVE_FILE', path: f.path })}
                      className={`flex-1 px-4 py-1.5 text-left text-sm truncate transition-colors ${
                        f.dirty ? 'italic' : ''
                      } ${
                        state.activeFileId === f.path ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800'
                      }`}
                      title={f.path}
                    >
                      {f.dirty && <span className="text-amber-400 mr-1 not-italic">*</span>}
                      {f.name}
                    </button>
                    <button
                      onClick={() => handleCloseFile(f.path)}
                      className="px-2 text-neutral-500 hover:text-red-400 opacity-0 group-hover:opacity-100 text-xs"
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Sidebar active={activeOp} onSelect={setActiveOp} />
          </div>
        )}

        {/* Main area */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {view === 'welcome' ? (
            <WelcomeScreen onAction={handleWelcomeAction} recentFiles={recentFiles} onSkipChanged={() => {}} onClearRecent={() => { setRecentFiles([]); localStorage.removeItem('spectra-recent'); }} />
          ) : view === 'operations' ? (
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
            <div className="flex-1 flex flex-col relative overflow-hidden">
              <WorkspaceCanvasView
                onOpenFiles={() => void handleOpenFile()}
                onCloseFile={(path) => void handleCloseFile(path)}
                onInspectPage={(path, pageNumber) => void handleInspectPage(path, pageNumber)}
                onExtractText={handleExtractFromCanvas}
                onApplyChanges={() => void commitAndReport()}
                onRedactFile={handleRedactFile}
                onApplyOcrLayer={handleApplyOcrLayer}
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
          )}
        </main>
      </div>

      {/* Operation queue */}
      <OperationQueue items={queue} onClear={clearQueue} />

      {/* Settings modal — accessible from any view */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setShowSettings(false)}>
          <div className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl w-[500px] max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
              <h3 className="text-sm font-semibold">Settings</h3>
              <button onClick={() => setShowSettings(false)} className="text-neutral-500 hover:text-neutral-300 text-sm">Close</button>
            </div>
            <div className="p-5">
              <SettingsPanel />
            </div>
          </div>
        </div>
      )}
      {/* 3-choice confirm dialog (Save / Don't Save / Cancel) */}
      <ConfirmDialog
        open={confirmState !== null}
        message={confirmState?.message ?? ''}
        onResult={handleConfirmResult}
      />
      {/* Password prompt for encrypted PDFs */}
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
