/**
 * Test harness — exposes a controlled surface on `window.__SPECTRA_TEST__`
 * for end-to-end tests driving the app via WebDriver (tauri-driver + WDIO).
 *
 * Only installed when the renderer was built with VITE_E2E=1. Release builds
 * never set the flag, so the global is absent in shipped binaries.
 *
 * The harness wraps existing Tauri commands and React state — it does NOT
 * grant any capability the renderer doesn't already have. Treat it as a
 * scriptable remote control over the public IPC surface.
 */
import { file, engine } from './lib/tauri-bridge';

export interface TestStateSnapshot {
  view: 'welcome' | 'operations' | 'canvas';
  activeOp: string;
  fileCount: number;
  activeFileId: string | null;
  activeFile: {
    name: string;
    path: string;
    workingPath: string;
    pageCount: number;
    dirty: boolean;
  } | null;
}

export interface TestAnnotationInput {
  kind: 'highlight' | 'freetext' | 'ink' | 'stamp';
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  note?: string;
  points?: number[];
}

/**
 * Redaction marks are transient WorkspaceCanvasView state (not reducer
 * state), so the annotation hooks' dispatch-from-App pattern can't reach
 * them. Instead the canvas registers its own handlers here while mounted;
 * harness methods poll the slot the same way addAnnotation polls the async
 * indexer. `apply` runs the exact code path the confirm dialog's Redact
 * button runs and resolves with per-file failure messages (empty = success).
 */
export interface CanvasRedactionHandlers {
  addMarkToFirstPage: (rect: {
    x: number;
    y: number;
    w: number;
    h: number;
  }) => { markId: string; docId: string; pageId: string } | null;
  apply: () => Promise<string[]>;
  clear: () => void;
  count: () => number;
}

let canvasRedaction: CanvasRedactionHandlers | null = null;

export function registerCanvasRedaction(handlers: CanvasRedactionHandlers | null): void {
  canvasRedaction = handlers;
}

/**
 * Visible-signature placement is likewise transient canvas state (2k). The
 * canvas registers placement + the REAL display→PDF conversion here;
 * `buildAppearance` returns the exact appearance payload the Sign & Save
 * button would send, so a spec can hand it to signActiveFile and exercise the
 * same engine path end to end.
 */
export interface CanvasSignatureHandlers {
  placeOnFirstPage: (rect: { x: number; y: number; w: number; h: number }) => boolean;
  buildAppearance: () => Promise<{
    path: string;
    appearance: { page: number; rect: [number, number, number, number] };
  } | null>;
  clear: () => void;
  has: () => boolean;
}

let canvasSignature: CanvasSignatureHandlers | null = null;

export function registerCanvasSignature(handlers: CanvasSignatureHandlers | null): void {
  canvasSignature = handlers;
}

/**
 * OCR "Make searchable" is a canvas action gated on real (in-webview)
 * tesseract results, and the FindBar button's visibility depends on that
 * async state — flaky to drive by click. The canvas registers the same
 * apply path here so a spec can (1) wait for `readyCount() > 0` (OCR words
 * landed) then (2) run the exact `apply_ocr_layer` flow the button runs.
 */
export interface CanvasOcrHandlers {
  readyCount: () => number;
  apply: () => Promise<string[]>;
}

let canvasOcr: CanvasOcrHandlers | null = null;

export function registerCanvasOcr(handlers: CanvasOcrHandlers | null): void {
  canvasOcr = handlers;
}

/**
 * Multi-select (2n.1) is local canvas view state, and both modifier-click
 * selection and the pointer-capture group drag are not reliably
 * WebDriver-drivable. The canvas registers selection setters/readers plus the
 * exact batched delete/rotate paths the Delete/`[`/`]` keys run, so a spec can
 * select a subset and exercise the real reducer + commit path.
 */
export interface CanvasSelectionHandlers {
  selectPageIds: (ids: string[]) => void;
  getSelectedPageIds: () => string[];
  getWorkspacePageIds: () => string[];
  deleteSelected: () => void;
  rotateSelected: (delta: 90 | 270) => void;
}

let canvasSelection: CanvasSelectionHandlers | null = null;

export function registerCanvasSelection(handlers: CanvasSelectionHandlers | null): void {
  canvasSelection = handlers;
}

/**
 * Outline sidebar reorder (2n.2) is a pointer-capture tree drag, not
 * WebDriver-drivable. The sidebar registers a reader + the exact drop path
 * (moveOutlineNode -> set_outline -> UPDATE_FILE) so a spec can reorder and
 * verify the persisted file. Only registered while the sidebar is mounted.
 */
export interface CanvasOutlineHandlers {
  getOrder: () => { title: string; depth: number; page: number | null }[];
  reorder: (fromPath: number[], overIndex: number, depth: number) => Promise<void>;
}

let canvasOutline: CanvasOutlineHandlers | null = null;

export function registerCanvasOutline(handlers: CanvasOutlineHandlers | null): void {
  canvasOutline = handlers;
}

/**
 * Signing goes through two native dialogs (.pfx picker + output save) that
 * WebDriver can't drive, so the SignaturesPanel registers its real sign call
 * here while mounted. The harness injects the paths + password and exercises
 * the exact `call('sign_pdf', …)` path the UI runs.
 */
export interface SignHandler {
  sign: (params: {
    // Signer source: a .pfx path, OR a PEM key+cert pair (2k).
    pfxPath?: string;
    keyPath?: string;
    certPath?: string;
    password: string;
    output: string;
    reason?: string;
    location?: string;
    // Visible-stamp placement (2k) — engine convention: 1-based page, PDF
    // user-space rect.
    appearance?: { page: number; rect: [number, number, number, number] };
  }) => Promise<{
    output: string;
    signer: string | null;
    valid: boolean;
    intact: boolean;
    covers_whole_document: boolean;
  }>;
}

let signHandler: SignHandler | null = null;

export function registerSignHandler(handler: SignHandler | null): void {
  signHandler = handler;
}

export interface TestHarness {
  /** Open one or more PDFs by absolute path, bypassing the OS dialog. */
  openByPaths: (paths: string[]) => Promise<void>;
  /** Save the active working copy to a known destination, no dialog. */
  saveActiveAs: (destPath: string) => Promise<void>;
  /** Switch the main view. */
  setView: (view: 'welcome' | 'operations' | 'canvas') => void;
  /** Select an operation in the sidebar. */
  setActiveOp: (op: string) => void;
  /** Snapshot of currently observable state, for assertions. */
  getState: () => TestStateSnapshot;
  /** Wait for the next state change matching a predicate (10s timeout). */
  waitForState: (
    predicate: (s: TestStateSnapshot) => boolean,
    timeoutMs?: number,
  ) => Promise<TestStateSnapshot>;
  /** Wait for the Python engine sidecar to respond to a ping. */
  waitForEngine: (timeoutMs?: number) => Promise<void>;
  /** Pop the most recent error captured by the harness, if any. */
  consumeLastError: () => string | null;
  /** Skip the welcome screen on the next reload. */
  skipWelcome: () => void;
  /**
   * Add an annotation to the active file's first workspace page, bypassing
   * pointer-drag simulation (the canvas tools are pointer-capture based —
   * see CLAUDE.md — which WebDriver can't reliably drive). Polls for the
   * workspace indexer to finish since it runs async after OPEN_FILE.
   * Exercises the exact reducer path the real tools use.
   */
  addAnnotation: (
    annotation: TestAnnotationInput,
    timeoutMs?: number,
  ) => Promise<{ docId: string; pageId: string; annotationId: string }>;
  /** Recolor an existing annotation (docId/pageId/annotationId as returned by
   * addAnnotation) via the same reducer path the per-annotation swatches use. */
  recolorAnnotation: (docId: string, pageId: string, annotationId: string, color: string) => void;
  /** Remove an existing annotation via the same reducer path the hover ×
   * button / comment sidebar's Remove use. */
  removeAnnotation: (docId: string, pageId: string, annotationId: string) => void;
  /**
   * The first annotation (of any origin — freshly added or imported from a
   * pre-existing PDF object) on the active file's first workspace page, once
   * the async indexer has run. Polls like addAnnotation, for e2e coverage of
   * import-on-open without a pointer-driven way to discover annotation ids.
   */
  getFirstAnnotation: (
    timeoutMs?: number,
  ) => Promise<{ docId: string; pageId: string; annotationId: string; kind: string; color: string; note?: string } | null>;
  /** Materialize pending page-tier edits (annotations, moves, etc.) via the
   * real commit bridge — same path as the "Apply changes" button. */
  commitPendingEdits: () => Promise<void>;
  /** Test-only: close every open file so a spec starts from a clean
   * workspace (multi-select is workspace-wide, so accumulated files across
   * cases would otherwise cross-contaminate select-all). */
  closeAllFiles: () => void;
  /**
   * Add a pending redaction mark to the active file's first workspace page,
   * bypassing pointer-drag simulation (same WebDriver constraint as
   * addAnnotation). Polls for the canvas view + async indexer. The canvas
   * view must be mounted (setView('canvas')) first.
   */
  addRedactionMark: (
    rect: { x: number; y: number; w: number; h: number },
    timeoutMs?: number,
  ) => Promise<{ markId: string; docId: string; pageId: string }>;
  /** Apply all pending redaction marks via the same path as the confirm
   * dialog's Redact button (commit gate → snapshot → engine → reload).
   * Rejects if any file's redaction failed. */
  applyRedactions: () => Promise<void>;
  /** Drop all pending redaction marks (the Clear button). */
  clearRedactionMarks: () => void;
  /** Number of pending redaction marks the canvas currently shows. */
  getRedactionMarkCount: () => number;
  /** Place a visible-signature box on the active file's first canvas page
   * (display-normalized rect), waiting for the canvas + indexer like
   * addRedactionMark. */
  placeSignature: (
    rect: { x: number; y: number; w: number; h: number },
    timeoutMs?: number,
  ) => Promise<void>;
  /** Convert the pending placement via the REAL display→PDF path; returns the
   * engine appearance payload the canvas Sign button would send. */
  buildSignatureAppearance: () => Promise<{
    path: string;
    appearance: { page: number; rect: [number, number, number, number] };
  } | null>;
  /** Drop the pending signature placement. */
  clearSignaturePlacement: () => void;
  /** Select a set of canvas page ids (2n.1) — bypasses modifier-click pointer
   * simulation. Canvas view must be mounted. */
  selectCanvasPages: (pageIds: string[]) => void;
  /** The currently selected canvas page ids. */
  getSelectedCanvasPageIds: () => string[];
  /** Workspace-flattened page ids in order (the select-all / range basis). */
  getWorkspacePageIds: () => string[];
  /** Delete the current canvas selection via the same batched path Delete runs
   * (DELETE_PAGE_REFS → page tier). Canvas view must be mounted. */
  deleteSelectedCanvasPages: () => void;
  /** Rotate the current canvas selection ±90 via the batched path (`[`/`]`). */
  rotateSelectedCanvasPages: (delta: 90 | 270) => void;
  /** Flattened outline rows (title/depth/page) the sidebar currently shows.
   * Outline sidebar must be mounted (toggle-outline). */
  getOutlineOrder: () => { title: string; depth: number; page: number | null }[];
  /** Reorder an outline node via the exact drop path (moveOutlineNode ->
   * set_outline -> UPDATE_FILE); resolves after the save. */
  reorderOutline: (fromPath: number[], overIndex: number, depth: number) => Promise<void>;
  /** Number of scanned source pages with OCR words ready to persist. */
  ocrReadyCount: () => number;
  /** Run the "Make searchable" flow (engine apply_ocr_layer per file);
   * rejects if any file failed. Canvas view must be mounted. */
  applyOcr: () => Promise<void>;
  /**
   * Sign the active file via the Signatures panel's real engine call, with
   * injected paths (the .pfx picker and output save dialog are native and
   * not WebDriver-drivable). The Signatures panel must be mounted. Returns the
   * self-verify summary of the produced file.
   */
  signActiveFile: (params: {
    pfxPath?: string;
    keyPath?: string;
    certPath?: string;
    password: string;
    output: string;
    reason?: string;
    location?: string;
    appearance?: { page: number; rect: [number, number, number, number] };
  }) => Promise<{
    output: string;
    signer: string | null;
    valid: boolean;
    intact: boolean;
    covers_whole_document: boolean;
  }>;
}

export interface TestHarnessDeps {
  openByPaths: (paths: string[]) => Promise<void>;
  setView: (view: 'welcome' | 'operations' | 'canvas') => void;
  setActiveOp: (op: string) => void;
  getStateSnapshot: () => TestStateSnapshot;
  subscribe: (listener: (s: TestStateSnapshot) => void) => () => void;
  /** First page of the active file's first workspace document, once the
   * async indexer has produced one; null until then. */
  getFirstPage: () => { docId: string; pageId: string } | null;
  /** Same page lookup as getFirstPage, plus its first annotation if any. */
  getFirstPageAnnotation: () => {
    docId: string;
    pageId: string;
    annotationId: string;
    kind: string;
    color: string;
    note?: string;
  } | null;
  dispatchAddAnnotation: (docId: string, pageId: string, annotation: TestAnnotationInput & { id: string }) => void;
  dispatchRecolorAnnotation: (docId: string, pageId: string, annotationId: string, color: string) => void;
  dispatchRemoveAnnotation: (docId: string, pageId: string, annotationId: string) => void;
  commitPendingEdits: () => Promise<void>;
  closeAllFiles: () => void;
}

export const TEST_HARNESS_ENABLED =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_E2E === '1';

declare global {
  interface Window {
    __SPECTRA_TEST__?: TestHarness;
  }
}

export function installTestHarness(deps: TestHarnessDeps): void {
  if (!TEST_HARNESS_ENABLED) return;

  let lastError: string | null = null;
  const captureError = (label: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    lastError = `${label}: ${msg}`;
  };

  let nextPingId = 1_000_000;
  const pingEngine = async (timeoutMs: number): Promise<void> => {
    const id = nextPingId++;

    // Attach the listener BEFORE sending the ping — engine.onResponse returns
    // Promise<UnlistenFn>, so we must await it or the reply can fire before
    // the listener is wired up and we'll hang until timeout.
    let resolvePing: () => void = () => {};
    let rejectPing: (err: Error) => void = () => {};
    const waiter = new Promise<void>((resolveFn, rejectFn) => {
      resolvePing = resolveFn;
      rejectPing = rejectFn;
    });
    const unlisten = await engine.onResponse((response: unknown) => {
      if (
        typeof response === 'object' &&
        response !== null &&
        (response as { id?: number }).id === id
      ) {
        resolvePing();
      }
    });
    const timer = setTimeout(() => {
      rejectPing(new Error(`pingEngine: no response in ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      await engine.request({ jsonrpc: '2.0', method: 'ping', params: {}, id });
      await waiter;
    } finally {
      clearTimeout(timer);
      unlisten();
    }
  };

  const waitForEngine = async (timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        await pingEngine(1_500);
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(
      `waitForEngine: Python engine never responded within ${timeoutMs}ms (last error: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      })`,
    );
  };

  const harness: TestHarness = {
    openByPaths: async (paths) => {
      try {
        await waitForEngine();
        await deps.openByPaths(paths);
      } catch (err) {
        captureError('openByPaths', err);
        throw err;
      }
    },
    waitForEngine,
    saveActiveAs: async (destPath) => {
      const snap = deps.getStateSnapshot();
      if (!snap.activeFile) {
        const msg = 'saveActiveAs: no active file';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await file.saveAs(snap.activeFile.workingPath, destPath);
      } catch (err) {
        captureError('saveActiveAs', err);
        throw err;
      }
    },
    setView: (view) => deps.setView(view),
    setActiveOp: (op) => deps.setActiveOp(op),
    getState: () => deps.getStateSnapshot(),
    waitForState: (predicate, timeoutMs = 10_000) =>
      new Promise<TestStateSnapshot>((resolve, reject) => {
        const initial = deps.getStateSnapshot();
        if (predicate(initial)) {
          resolve(initial);
          return;
        }
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`waitForState: timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const unsubscribe = deps.subscribe((s) => {
          if (predicate(s)) {
            clearTimeout(timer);
            unsubscribe();
            resolve(s);
          }
        });
      }),
    consumeLastError: () => {
      const e = lastError;
      lastError = null;
      return e;
    },
    skipWelcome: () => {
      localStorage.setItem('spectra-skip-welcome', 'true');
    },
    addAnnotation: async (annotation, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      let page = deps.getFirstPage();
      while (!page && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        page = deps.getFirstPage();
      }
      if (!page) {
        const msg = `addAnnotation: no workspace page appeared within ${timeoutMs}ms`;
        lastError = msg;
        throw new Error(msg);
      }
      const annotationId = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      try {
        deps.dispatchAddAnnotation(page.docId, page.pageId, { ...annotation, id: annotationId });
      } catch (err) {
        captureError('addAnnotation', err);
        throw err;
      }
      return { docId: page.docId, pageId: page.pageId, annotationId };
    },
    recolorAnnotation: (docId, pageId, annotationId, color) => {
      try {
        deps.dispatchRecolorAnnotation(docId, pageId, annotationId, color);
      } catch (err) {
        captureError('recolorAnnotation', err);
        throw err;
      }
    },
    removeAnnotation: (docId, pageId, annotationId) => {
      try {
        deps.dispatchRemoveAnnotation(docId, pageId, annotationId);
      } catch (err) {
        captureError('removeAnnotation', err);
        throw err;
      }
    },
    getFirstAnnotation: async (timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      let found = deps.getFirstPageAnnotation();
      while (!found && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        found = deps.getFirstPageAnnotation();
      }
      return found;
    },
    commitPendingEdits: async () => {
      try {
        await deps.commitPendingEdits();
      } catch (err) {
        captureError('commitPendingEdits', err);
        throw err;
      }
    },
    closeAllFiles: () => deps.closeAllFiles(),
    addRedactionMark: async (rect, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      // Waits for the canvas view to mount (registration) AND the indexer to
      // produce a first page (addMarkToFirstPage returns null until then).
      let added = canvasRedaction?.addMarkToFirstPage(rect) ?? null;
      while (!added && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        added = canvasRedaction?.addMarkToFirstPage(rect) ?? null;
      }
      if (!added) {
        const msg = `addRedactionMark: no canvas page appeared within ${timeoutMs}ms`;
        lastError = msg;
        throw new Error(msg);
      }
      return added;
    },
    applyRedactions: async () => {
      if (!canvasRedaction) {
        const msg = 'applyRedactions: canvas view not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        const failures = await canvasRedaction.apply();
        if (failures.length > 0) throw new Error(failures.join('; '));
      } catch (err) {
        captureError('applyRedactions', err);
        throw err;
      }
    },
    clearRedactionMarks: () => canvasRedaction?.clear(),
    getRedactionMarkCount: () => canvasRedaction?.count() ?? 0,
    placeSignature: async (rect, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      let placed = canvasSignature?.placeOnFirstPage(rect) ?? false;
      while (!placed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        placed = canvasSignature?.placeOnFirstPage(rect) ?? false;
      }
      if (!placed) {
        const msg = `placeSignature: no canvas page appeared within ${timeoutMs}ms`;
        lastError = msg;
        throw new Error(msg);
      }
    },
    buildSignatureAppearance: async () => {
      if (!canvasSignature) {
        const msg = 'buildSignatureAppearance: canvas view not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        return await canvasSignature.buildAppearance();
      } catch (err) {
        captureError('buildSignatureAppearance', err);
        throw err;
      }
    },
    clearSignaturePlacement: () => canvasSignature?.clear(),
    selectCanvasPages: (pageIds) => canvasSelection?.selectPageIds(pageIds),
    getSelectedCanvasPageIds: () => canvasSelection?.getSelectedPageIds() ?? [],
    getWorkspacePageIds: () => canvasSelection?.getWorkspacePageIds() ?? [],
    deleteSelectedCanvasPages: () => canvasSelection?.deleteSelected(),
    rotateSelectedCanvasPages: (delta) => canvasSelection?.rotateSelected(delta),
    getOutlineOrder: () => canvasOutline?.getOrder() ?? [],
    reorderOutline: async (fromPath, overIndex, depth) => {
      if (!canvasOutline) throw new Error('reorderOutline: outline sidebar not mounted');
      await canvasOutline.reorder(fromPath, overIndex, depth);
    },
    ocrReadyCount: () => canvasOcr?.readyCount() ?? 0,
    applyOcr: async () => {
      if (!canvasOcr) {
        const msg = 'applyOcr: canvas view not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        const failures = await canvasOcr.apply();
        if (failures.length > 0) throw new Error(failures.join('; '));
      } catch (err) {
        captureError('applyOcr', err);
        throw err;
      }
    },
    signActiveFile: async (params) => {
      if (!signHandler) {
        const msg = 'signActiveFile: Signatures panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        return await signHandler.sign(params);
      } catch (err) {
        captureError('signActiveFile', err);
        throw err;
      }
    },
  };

  window.__SPECTRA_TEST__ = harness;
   
  console.warn(
    '[spectra] e2e test harness active — window.__SPECTRA_TEST__ exposed. ' +
      'This build was compiled with VITE_E2E=1 and must NOT be shipped.',
  );
}
