/**
 * Helpers for tests to drive the in-app test harness exposed at
 * `window.__SPECTRA_TEST__` (only present when the renderer is built with
 * VITE_E2E=1).
 */

export interface TestStateSnapshot {
  view: 'welcome' | 'operations' | 'pages';
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

export async function waitForHarness(timeoutMs = 15_000): Promise<void> {
  await browser.waitUntil(
    async () =>
      Boolean(await browser.execute(() => Boolean((window as any).__SPECTRA_TEST__))),
    { timeout: timeoutMs, timeoutMsg: 'Test harness never appeared on window' },
  );
}

export async function openByPaths(paths: string[]): Promise<void> {
  await browser.executeAsync<void, [string[]]>(
    function (p, done) {
      const h = (window as any).__SPECTRA_TEST__;
      if (!h) {
        done('__SPECTRA_TEST__ missing — was the binary built with VITE_E2E=1?' as any);
        return;
      }
      h.openByPaths(p).then(() => done(undefined)).catch((err: unknown) => done(String(err) as any));
    },
    paths,
  );
}

export async function getState(): Promise<TestStateSnapshot> {
  return await browser.execute<TestStateSnapshot, []>(function () {
    return (window as any).__SPECTRA_TEST__.getState();
  });
}

export async function setView(view: TestStateSnapshot['view']): Promise<void> {
  await browser.execute<void, [TestStateSnapshot['view']]>(
    function (v) {
      (window as any).__SPECTRA_TEST__.setView(v);
    },
    view,
  );
}

export async function setActiveOp(op: string): Promise<void> {
  await browser.execute<void, [string]>(
    function (o) {
      (window as any).__SPECTRA_TEST__.setActiveOp(o);
    },
    op,
  );
}

export async function saveActiveAs(destPath: string): Promise<void> {
  await browser.executeAsync<void, [string]>(
    function (dest, done) {
      (window as any).__SPECTRA_TEST__.saveActiveAs(dest)
        .then(() => done(undefined))
        .catch((err: unknown) => done(String(err) as any));
    },
    destPath,
  );
}

export async function consumeLastError(): Promise<string | null> {
  return await browser.execute<string | null, []>(function () {
    return (window as any).__SPECTRA_TEST__.consumeLastError();
  });
}

export async function skipWelcome(): Promise<void> {
  await browser.execute(function () {
    (window as any).__SPECTRA_TEST__.skipWelcome();
  });
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

// executeAsync's `done` always RESOLVES the browser-side call — there's no
// way to reject it from inside the page. Errors are tagged with this marker
// so the Node-side wrapper below can tell "resolved with a result" from
// "resolved with an error string" and throw a real, readable failure instead
// of a confusing downstream assertion mismatch (e.g. `undefined.docId`).
const ERROR_TAG = '__SPECTRA_E2E_ERROR__:';

export async function addAnnotation(
  annotation: TestAnnotationInput,
): Promise<{ docId: string; pageId: string; annotationId: string }> {
  const result = await browser.executeAsync<
    { docId: string; pageId: string; annotationId: string } | string,
    [TestAnnotationInput]
  >(
    function (a, done) {
      (window as any).__SPECTRA_TEST__.addAnnotation(a)
        .then((r: unknown) => done(r as any))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    annotation,
  );
  if (typeof result === 'string') {
    throw new Error(`addAnnotation failed: ${result.replace(ERROR_TAG, '')}`);
  }
  return result;
}

export async function commitPendingEdits(): Promise<void> {
  const result = await browser.executeAsync<string | null, []>(function (done) {
    (window as any).__SPECTRA_TEST__.commitPendingEdits()
      .then(() => done(null))
      .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
  });
  if (typeof result === 'string') {
    throw new Error(`commitPendingEdits failed: ${result.replace(ERROR_TAG, '')}`);
  }
}
