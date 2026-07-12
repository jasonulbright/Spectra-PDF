/**
 * Helpers for tests to drive the in-app test harness exposed at
 * `window.__SPECTRA_TEST__` (only present when the renderer is built with
 * VITE_E2E=1).
 */

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

export async function waitForHarness(timeoutMs = 15_000): Promise<void> {
  await browser.waitUntil(
    async () =>
      Boolean(await browser.execute(() => Boolean((window as any).__SPECTRA_TEST__))),
    { timeout: timeoutMs, timeoutMsg: 'Test harness never appeared on window' },
  );
}

export async function openByPaths(paths: string[]): Promise<void> {
  const result = await browser.executeAsync<string | null, [string[]]>(
    function (p, done) {
      const h = (window as any).__SPECTRA_TEST__;
      if (!h) {
        done('__SPECTRA_TEST__ missing — was the binary built with VITE_E2E=1?');
        return;
      }
      h.openByPaths(p)
        .then(() => done(null))
        .catch((err: unknown) => done(String(err)));
    },
    paths,
  );
  if (typeof result === 'string') throw new Error(`openByPaths failed: ${result}`);
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

export async function recolorAnnotation(
  docId: string,
  pageId: string,
  annotationId: string,
  color: string,
): Promise<void> {
  await browser.execute(
    function (d, p, a, c) {
      (window as any).__SPECTRA_TEST__.recolorAnnotation(d, p, a, c);
    },
    docId,
    pageId,
    annotationId,
    color,
  );
}

export async function removeAnnotation(docId: string, pageId: string, annotationId: string): Promise<void> {
  await browser.execute(
    function (d, p, a) {
      (window as any).__SPECTRA_TEST__.removeAnnotation(d, p, a);
    },
    docId,
    pageId,
    annotationId,
  );
}

export interface FirstAnnotation {
  docId: string;
  pageId: string;
  annotationId: string;
  kind: string;
  color: string;
  note?: string;
}

export async function getFirstAnnotation(timeoutMs = 10_000): Promise<FirstAnnotation | null> {
  return await browser.executeAsync<FirstAnnotation | null, [number]>(
    function (timeout, done) {
      (window as any).__SPECTRA_TEST__.getFirstAnnotation(timeout)
        .then((r: unknown) => done(r as any))
        .catch(() => done(null as any));
    },
    timeoutMs,
  );
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

export interface RedactionMarkRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function addRedactionMark(
  rect: RedactionMarkRect,
): Promise<{ markId: string; docId: string; pageId: string }> {
  const result = await browser.executeAsync<
    { markId: string; docId: string; pageId: string } | string,
    [RedactionMarkRect]
  >(
    function (r, done) {
      (window as any).__SPECTRA_TEST__.addRedactionMark(r)
        .then((res: unknown) => done(res as any))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    rect,
  );
  if (typeof result === 'string') {
    throw new Error(`addRedactionMark failed: ${result.replace(ERROR_TAG, '')}`);
  }
  return result;
}

export async function applyRedactions(): Promise<void> {
  const result = await browser.executeAsync<string | null, []>(function (done) {
    (window as any).__SPECTRA_TEST__.applyRedactions()
      .then(() => done(null))
      .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
  });
  if (typeof result === 'string') {
    throw new Error(`applyRedactions failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

export async function clearRedactionMarks(): Promise<void> {
  await browser.execute(function () {
    (window as any).__SPECTRA_TEST__.clearRedactionMarks();
  });
}

export async function getRedactionMarkCount(): Promise<number> {
  return await browser.execute<number, []>(function () {
    return (window as any).__SPECTRA_TEST__.getRedactionMarkCount();
  });
}

/** Import a file's pages into a document at an index (2n.3) — the add-page /
 * per-position-drop path, bypassing the native file picker. */
export async function importPagesIntoDoc(
  filePath: string,
  toDocId: string,
  toIndex: number,
): Promise<void> {
  const result = await browser.executeAsync<string | null, [string, string, number]>(
    function (fp, doc, idx, done) {
      (window as any).__SPECTRA_TEST__.importPagesIntoDoc(fp, doc, idx)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    filePath,
    toDocId,
    toIndex,
  );
  if (typeof result === 'string') {
    throw new Error(`importPagesIntoDoc failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

/** Test-only: close every open file so the next case starts clean. */
export async function closeAllFiles(): Promise<void> {
  await browser.execute(function () {
    (window as any).__SPECTRA_TEST__.closeAllFiles();
  });
}

/** Workspace-flattened page ids in order (2n.1). Canvas must be mounted. */
export async function getWorkspacePageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.getWorkspacePageIds();
  });
}

/** Select a set of canvas page ids (2n.1 multi-select). */
export async function selectCanvasPages(pageIds: string[]): Promise<void> {
  await browser.execute<void, [string[]]>(
    function (ids) {
      (window as any).__SPECTRA_TEST__.selectCanvasPages(ids);
    },
    pageIds,
  );
}

/** The currently selected canvas page ids. */
export async function getSelectedCanvasPageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.getSelectedCanvasPageIds();
  });
}

/** Delete the current canvas selection via the batched path Delete runs. */
export async function deleteSelectedCanvasPages(): Promise<void> {
  await browser.execute(function () {
    (window as any).__SPECTRA_TEST__.deleteSelectedCanvasPages();
  });
}

/** Rotate the current canvas selection ±90 via the batched path (`[`/`]`). */
export async function rotateSelectedCanvasPages(delta: 90 | 270): Promise<void> {
  await browser.execute<void, [number]>(
    function (d) {
      (window as any).__SPECTRA_TEST__.rotateSelectedCanvasPages(d);
    },
    delta,
  );
}

/**
 * Dispatch a real global keydown on `window` (2n.1 keyboard shortcuts).
 * WDIO `browser.keys` targets the focused element; the canvas shortcuts are
 * window-level listeners, so we synthesize the event directly — this exercises
 * the exact keydown handlers WorkspaceCanvasView/App register.
 */
export async function pressGlobalKey(
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {},
): Promise<void> {
  await browser.execute<void, [string, { ctrl?: boolean; shift?: boolean; meta?: boolean }]>(
    function (k, m) {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: k,
          ctrlKey: Boolean(m.ctrl),
          shiftKey: Boolean(m.shift),
          metaKey: Boolean(m.meta),
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    key,
    mods,
  );
}

/** Flattened outline rows the sidebar shows (2n.2). Sidebar must be mounted. */
export async function getOutlineOrder(): Promise<
  { title: string; depth: number; page: number | null }[]
> {
  return await browser.execute<{ title: string; depth: number; page: number | null }[], []>(
    function () {
      return (window as any).__SPECTRA_TEST__.getOutlineOrder();
    },
  );
}

/** Reorder an outline node via the exact drop path (moveOutlineNode ->
 * set_outline -> UPDATE_FILE); resolves after the save. */
export async function reorderOutline(
  fromPath: number[],
  overIndex: number,
  depth: number,
): Promise<void> {
  const result = await browser.executeAsync<string | null, [number[], number, number]>(
    function (fp, oi, d, done) {
      (window as any).__SPECTRA_TEST__.reorderOutline(fp, oi, d)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    fromPath,
    overIndex,
    depth,
  );
  if (typeof result === 'string') {
    throw new Error(`reorderOutline failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

/** Number of scanned source pages whose OCR words are ready to persist. */
export async function ocrReadyCount(): Promise<number> {
  return await browser.execute<number, []>(function () {
    return (window as any).__SPECTRA_TEST__.ocrReadyCount();
  });
}

/** Run "Make searchable" (engine apply_ocr_layer per file). Canvas mounted. */
export async function applyOcr(): Promise<void> {
  const result = await browser.executeAsync<string | null, []>(function (done) {
    (window as any).__SPECTRA_TEST__.applyOcr()
      .then(() => done(null))
      .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
  });
  if (typeof result === 'string') {
    throw new Error(`applyOcr failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

export interface SignParams {
  // One signer source: .pfx path, or PEM key+cert pair (2k).
  pfxPath?: string;
  keyPath?: string;
  certPath?: string;
  password: string;
  output: string;
  reason?: string;
  location?: string;
  // Visible-stamp placement (engine convention: 1-based page, PDF points).
  appearance?: { page: number; rect: [number, number, number, number] };
}

export interface SignSummary {
  output: string;
  signer: string | null;
  valid: boolean;
  intact: boolean;
  covers_whole_document: boolean;
}

export async function signActiveFile(params: SignParams): Promise<SignSummary> {
  const result = await browser.executeAsync<SignSummary | string, [SignParams]>(
    function (p, done) {
      (window as any).__SPECTRA_TEST__.signActiveFile(p)
        .then((res: unknown) => done(res as any))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    params,
  );
  if (typeof result === 'string') {
    throw new Error(`signActiveFile failed: ${result.replace(ERROR_TAG, '')}`);
  }
  return result;
}

/** Place a visible-signature box on the active file's first canvas page
 * (display-normalized rect). Canvas view must be mounted. */
export async function placeSignature(rect: { x: number; y: number; w: number; h: number }): Promise<void> {
  const result = await browser.executeAsync<string | null, [{ x: number; y: number; w: number; h: number }]>(
    function (r, done) {
      (window as any).__SPECTRA_TEST__.placeSignature(r)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    rect,
  );
  if (typeof result === 'string') {
    throw new Error(`placeSignature failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

/** The engine appearance payload the canvas Sign button would send for the
 * pending placement — produced by the REAL display→PDF conversion path. */
export async function buildSignatureAppearance(): Promise<{
  path: string;
  appearance: { page: number; rect: [number, number, number, number] };
} | null> {
  const result = await browser.executeAsync<
    { path: string; appearance: { page: number; rect: [number, number, number, number] } } | string | null,
    []
  >(function (done) {
    (window as any).__SPECTRA_TEST__.buildSignatureAppearance()
      .then((res: unknown) => done(res as any))
      .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
  });
  if (typeof result === 'string') {
    throw new Error(`buildSignatureAppearance failed: ${result.replace(ERROR_TAG, '')}`);
  }
  return result;
}

/**
 * Set a React-controlled input's value atomically. WDIO's `setValue` is
 * unreliable here twice over: its clearValue can be undone by React
 * re-rendering the controlled value, and char-by-char typing into the
 * WebView2 can drop keystrokes (observed live: "CONFIDENTIAL" default
 * surviving + a truncated suffix landing in the same field). The native
 * value setter + a bubbling `input` event is the canonical React-compatible
 * way to set the whole value in one shot.
 */
export async function setReactInputValue(selector: string, value: string): Promise<void> {
  const el = await $(selector);
  await el.waitForDisplayed({ timeout: 10_000 });
  await browser.execute(
    function (element, v) {
      const input = element as unknown as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    el,
    value,
  );
  const readBack = await el.getValue();
  if (readBack !== value) {
    throw new Error(`setReactInputValue: field holds ${JSON.stringify(readBack)}, expected ${JSON.stringify(value)}`);
  }
}

// --- On-canvas form fill (2n.4b) ------------------------------------------

export async function setCanvasFormValue(
  path: string,
  fieldName: string,
  value: string | boolean | string[],
): Promise<boolean> {
  return browser.executeAsync<boolean, [string, string, string | boolean | string[]]>(
    function (p, name, v, done) {
      (window as any).__SPECTRA_TEST__.setCanvasFormValue(p, name, v)
        .then((ok: boolean) => done(ok))
        .catch(() => done(false));
    },
    path,
    fieldName,
    value,
  );
}

export async function pendingFormValueCount(): Promise<number> {
  return browser.execute(function () {
    return (window as any).__SPECTRA_TEST__.pendingFormValueCount();
  });
}

export async function applyCanvasFormValues(): Promise<void> {
  const result = await browser.executeAsync<string | null, []>(function (done) {
    (window as any).__SPECTRA_TEST__.applyCanvasFormValues()
      .then(() => done(null))
      .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
  });
  if (typeof result === 'string') {
    throw new Error(`applyCanvasFormValues failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

export async function formWidgetCount(path: string): Promise<number> {
  return browser.execute(function (p) {
    return (window as any).__SPECTRA_TEST__.formWidgetCount(p);
  }, path);
}

export async function placeNewField(rect: { x: number; y: number; w: number; h: number }): Promise<void> {
  const result = await browser.executeAsync<string | null, [{ x: number; y: number; w: number; h: number }]>(
    function (r, done) {
      (window as any).__SPECTRA_TEST__.placeNewField(r)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    rect,
  );
  if (typeof result === 'string') {
    throw new Error(`placeNewField failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

export async function createPlacedField(params: {
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist' | 'signature';
  options?: string[];
  multiline?: boolean;
}): Promise<void> {
  const result = await browser.executeAsync<string | null, [typeof params]>(
    function (p, done) {
      (window as any).__SPECTRA_TEST__.createPlacedField(p)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    params,
  );
  if (typeof result === 'string') {
    throw new Error(`createPlacedField failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

export async function signCanvasField(params: {
  fieldName: string;
  pfxPath?: string;
  keyPath?: string;
  certPath?: string;
  password: string;
  output: string;
  reason?: string;
  location?: string;
}): Promise<{ signer: string | null; output: string; valid: boolean; intact: boolean; covers_whole_document: boolean }> {
  const result = await browser.executeAsync<
    | { signer: string | null; output: string; valid: boolean; intact: boolean; covers_whole_document: boolean }
    | string,
    [typeof params]
  >(function (p, done) {
    (window as any).__SPECTRA_TEST__.signCanvasField(p)
      .then((r: unknown) => done(r as any))
      .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
  }, params);
  if (typeof result === 'string') {
    throw new Error(`signCanvasField failed: ${result.replace(ERROR_TAG, '')}`);
  }
  return result;
}
