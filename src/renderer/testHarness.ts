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
 * Signing goes through two native dialogs (.pfx picker + output save) that
 * WebDriver can't drive, so the SignaturesPanel registers its real sign call
 * here while mounted. The harness injects the paths + password and exercises
 * the exact `call('sign_pdf', …)` path the UI runs.
 */
export interface SignHandler {
  sign: (params: {
    pfxPath: string;
    password: string;
    output: string;
    reason?: string;
    location?: string;
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
  /**
   * Sign the active file via the Signatures panel's real engine call, with
   * injected paths (the .pfx picker and output save dialog are native and
   * not WebDriver-drivable). The Signatures panel must be mounted. Returns the
   * self-verify summary of the produced file.
   */
  signActiveFile: (params: {
    pfxPath: string;
    password: string;
    output: string;
    reason?: string;
    location?: string;
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
