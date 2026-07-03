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
  view: 'welcome' | 'operations' | 'pages' | 'canvas';
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

export interface TestHarness {
  /** Open one or more PDFs by absolute path, bypassing the OS dialog. */
  openByPaths: (paths: string[]) => Promise<void>;
  /** Save the active working copy to a known destination, no dialog. */
  saveActiveAs: (destPath: string) => Promise<void>;
  /** Switch the main view. */
  setView: (view: 'welcome' | 'operations' | 'pages' | 'canvas') => void;
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
}

export interface TestHarnessDeps {
  openByPaths: (paths: string[]) => Promise<void>;
  setView: (view: 'welcome' | 'operations' | 'pages' | 'canvas') => void;
  setActiveOp: (op: string) => void;
  getStateSnapshot: () => TestStateSnapshot;
  subscribe: (listener: (s: TestStateSnapshot) => void) => () => void;
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
  };

  window.__SPECTRA_TEST__ = harness;
   
  console.warn(
    '[spectra] e2e test harness active — window.__SPECTRA_TEST__ exposed. ' +
      'This build was compiled with VITE_E2E=1 and must NOT be shipped.',
  );
}
