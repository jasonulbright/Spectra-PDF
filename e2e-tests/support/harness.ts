/**
 * Helpers for tests to drive the in-app test harness exposed at
 * `window.__SPECTRA_TEST__` (only present when the renderer is built with
 * VITE_E2E=1).
 */

export type FocusedTab = 'home' | 'tools' | { doc: string };

export interface TestStateSnapshot {
  view: 'welcome' | 'operations' | 'canvas';
  focusedTab: FocusedTab;
  activeOp: string;
  tool: string;
  activeToolId: string | null;
  docViewMode: 'organize' | 'document';
  currentPageId: string | null;
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

/**
 * Start an open WITHOUT waiting for it to finish.
 *
 * `openByPaths` awaits the app's promise — which, for a password-protected
 * file, does not resolve until the prompt is answered. Awaiting it and then
 * trying to type the password deadlocks: the script is still blocked inside the
 * call that put the prompt on screen.
 */
export async function startOpenByPaths(paths: string[]): Promise<void> {
  await browser.execute((p: string[]) => {
    void (window as any).__SPECTRA_TEST__.openByPaths(p);
  }, paths);
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

/** Focus a tab directly (Phase 4 M2): 'home' | 'tools' | { doc: path }. */
export async function focusTab(tab: FocusedTab): Promise<void> {
  await browser.execute<void, [FocusedTab]>(
    function (t) {
      (window as any).__SPECTRA_TEST__.focusTab(t);
    },
    tab,
  );
}

/** Invoke a registered command via the harness (the menus/toolbar entry
 * point). Returns the enablement verdict. */
export async function invokeAppCommand(id: string): Promise<boolean> {
  return await browser.execute<boolean, [string]>(
    function (i) {
      return (window as any).__SPECTRA_TEST__.invokeCommand(i);
    },
    id,
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
/** The active file's page-tier pages with sizes (M6.3 value assertions). */
export async function getActiveDocPages(): Promise<
  { id: string; width: number; height: number }[]
> {
  return await browser.execute(function () {
    return (window as any).__SPECTRA_TEST__.getActiveDocPages();
  });
}

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
  await $(selector).waitForDisplayed({ timeout: 10_000 });
  // Robust against two observed WebView2 flakes (dev-notes; 3 occurrences
  // across the session before this hardening):
  //  1. STALE HANDLE — grabbing the wdio element then handing it to a
  //     separate `execute` leaves a window in which a React re-render
  //     replaces the DOM node. Re-query the selector INSIDE the execute,
  //     one synchronous frame, so no cross-call handle exists.
  //  2. onChange NOT FIRING — React tracks a controlled input's value via
  //     an internal `_valueTracker`; the native-setter workaround can
  //     still miss if the tracker already holds the target, so onChange
  //     never fires and the live-validation render never happens. Poke
  //     the tracker to a DIFFERENT value first, guaranteeing a change.
  // Loop until the DOM value sticks (the controlled input reflects React
  // state on the next render) — a bare set-then-assert raced both flakes.
  await browser.waitUntil(
    async () =>
      browser.execute(function (sel, v) {
        const input = document.querySelector(sel) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | null;
        if (!input) return false;
        const proto =
          input.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
        const tracker = (input as unknown as { _valueTracker?: { setValue(v: string): void } })
          ._valueTracker;
        if (tracker) tracker.setValue(v + ' '); // force a tracked change
        setter.call(input, v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return input.value === v;
      }, selector, value),
    {
      timeout: 10_000,
      interval: 150,
      timeoutMsg: `setReactInputValue: ${selector} never held ${JSON.stringify(value)}`,
    },
  );
}

/** setReactInputValue's sibling for a controlled `<select>` (A3a family
 * dropdown): same hardened shape — re-query inside the execute, poke the
 * value tracker, loop until the value sticks — but the native setter is
 * HTMLSelectElement's and React hears `change` (not `input`) on selects. */
export async function setReactSelectValue(selector: string, value: string): Promise<void> {
  await $(selector).waitForDisplayed({ timeout: 10_000 });
  await browser.waitUntil(
    async () =>
      browser.execute(function (sel, v) {
        const el = document.querySelector(sel) as HTMLSelectElement | null;
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          'value',
        )!.set!;
        const tracker = (el as unknown as { _valueTracker?: { setValue(v: string): void } })
          ._valueTracker;
        if (tracker) tracker.setValue(v + ' '); // force a tracked change
        setter.call(el, v);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value === v;
      }, selector, value),
    {
      timeout: 10_000,
      interval: 150,
      timeoutMsg: `setReactSelectValue: ${selector} never held ${JSON.stringify(value)}`,
    },
  );
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

export async function createPlacedField(
  params: {
    name: string;
    type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist' | 'signature';
    options?: string[];
    multiline?: boolean;
  },
  /** Field-create → read-back hardening (the 18-canvas-forms flake's
   * strike-3 rule, mirroring the setReactInputValue precedent): when
   * given, wait until the created widgets are VISIBLE in the renderer's
   * own forms read (formWidgetCount) before returning — the app's
   * create chain awaits its writes, but the post-UPDATE_FILE forms
   * refetch is async, and an immediately-following name-keyed action
   * (sign-into-field) raced it under load. `widgetDelta` = how many
   * widgets the create adds (1 for every type this suite creates; a
   * radio group would add its option count). Omit for creates expected
   * to THROW (the duplicate-name refusal). */
  readBack?: { path: string; widgetDelta?: number },
): Promise<void> {
  const before = readBack ? await formWidgetCount(readBack.path) : 0;
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
  if (readBack) {
    const want = before + (readBack.widgetDelta ?? 1);
    // 30s: the forms hook retries a transiently-failing read (destroyed
    // proxy during the reload) with backoff — under heavy machine load
    // the heal can take well over 10s; the wait must outlast it.
    await browser.waitUntil(async () => (await formWidgetCount(readBack.path)) >= want, {
      timeout: 30_000,
      interval: 150,
      timeoutMsg: `createPlacedField: "${params.name}" never appeared in the forms read-back (${want} widgets expected)`,
    });
  }
}

export async function placeAddText(rect: { x: number; y: number; w: number; h: number }): Promise<void> {
  const result = await browser.executeAsync<string | null, [{ x: number; y: number; w: number; h: number }]>(
    function (r, done) {
      (window as any).__SPECTRA_TEST__.addTextPlace(r)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    rect,
  );
  if (typeof result === 'string') {
    throw new Error(`placeAddText failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

export async function commitAddText(params: {
  text: string;
  size?: number;
  color?: [number, number, number];
  family?: 'sans' | 'serif' | 'mono';
}): Promise<void> {
  const result = await browser.executeAsync<string | null, [typeof params]>(
    function (p, done) {
      (window as any).__SPECTRA_TEST__.addTextCommit(p)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    params,
  );
  if (typeof result === 'string') {
    throw new Error(`commitAddText failed: ${result.replace(ERROR_TAG, '')}`);
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

// --- Canvas whole-document merge (2o) --------------------------------------

export async function getCanvasDocs(expectedCount = 1): Promise<
  { id: string; path: string; name: string; pages: number }[]
> {
  return browser.executeAsync<
    { id: string; path: string; name: string; pages: number }[],
    [number]
  >(
    function (count, done) {
      (window as any).__SPECTRA_TEST__.getCanvasDocs(count).then((d: unknown) => done(d as any));
    },
    expectedCount,
  );
}

export async function mergeDocUp(docId: string): Promise<void> {
  await browser.execute(function (id) {
    (window as any).__SPECTRA_TEST__.mergeDocUp(id);
  }, docId);
}

export async function removeCanvasDoc(docId: string): Promise<void> {
  await browser.execute(function (id) {
    (window as any).__SPECTRA_TEST__.removeCanvasDoc(id);
  }, docId);
}

export async function mergeNoticeText(): Promise<string | null> {
  return browser.execute(function () {
    return (window as any).__SPECTRA_TEST__.mergeNoticeText();
  });
}

// --- Batch OCR (Phase 6) ----------------------------------------------------

export interface BatchOcrSnapshot {
  phase: 'setup' | 'running' | 'done';
  fileCount: number | null;
  report: {
    cancelled: boolean;
    results: { rel: string; status: string; pagesOcrd?: number; reason?: string }[];
    skippedDirs: string[];
  } | null;
}

/** Inject source+destination into the open Batch OCR dialog (native folder
 * pickers are not WebDriver-drivable) — runs the dialog's REAL
 * selectSource/setDest flow, including enumeration. */
export async function batchOcrSetFolders(source: string, dest: string): Promise<void> {
  const result = await browser.executeAsync<string | null, [string, string]>(
    function (s, d, done) {
      (window as any).__SPECTRA_TEST__.batchOcrSetFolders(s, d)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    source,
    dest,
  );
  if (typeof result === 'string') {
    throw new Error(`batchOcrSetFolders failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

/** Start the batch run WITHOUT awaiting completion — real in-webview
 * recognition can far outlive the WebDriver script timeout. Poll
 * `batchOcrSnapshot()` for phase === 'done' instead (the ocrReadyCount
 * idiom). */
export async function batchOcrStart(): Promise<void> {
  await browser.execute(function () {
    void (window as any).__SPECTRA_TEST__.batchOcrStart();
  });
}

export async function batchOcrSnapshot(): Promise<BatchOcrSnapshot | null> {
  return await browser.execute<BatchOcrSnapshot | null, []>(function () {
    return (window as any).__SPECTRA_TEST__.batchOcrSnapshot();
  });
}

// --- Edit ▸ Images (Phase 7.1) ---------------------------------------------

export async function editImagePageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editImagePageIds();
  });
}

export async function editImagePlacements(
  pageId: string,
): Promise<{ index: number; nested: boolean; matrix: number[] }[]> {
  return await browser.execute<{ index: number; nested: boolean; matrix: number[] }[], [string]>(
    function (p) {
      return (window as any).__SPECTRA_TEST__.editImagePlacements(p);
    },
    pageId,
  );
}

/** Transform (9.C1) an image placement to an absolute user-space matrix,
 * through the canvas's REAL commit path (the drag handles are undrivable). */
export async function editImageTransform(
  pageId: string,
  index: number,
  matrix: number[],
): Promise<void> {
  const result = await browser.executeAsync<string | null, [string, number, number[]]>(
    function (p, i, m, done) {
      (window as any).__SPECTRA_TEST__.editImageTransform(p, i, m)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    pageId,
    index,
    matrix,
  );
  if (typeof result === 'string') {
    throw new Error(`editImageTransform failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

/** Add Image (9.C2): embed a source at a user-space rect through the REAL
 * commit path (the native picker is undrivable — inject the source). */
export async function editImageAdd(
  page: number,
  rect: [number, number, number, number],
  source: { jpeg_path: string } | { raw_path: string; width: number; height: number; channels: 3 | 4 },
): Promise<void> {
  const result = await browser.executeAsync<string | null, [number, number[], unknown]>(
    function (pg, r, s, done) {
      (window as any).__SPECTRA_TEST__.editImageAdd(pg, r, s)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    page,
    rect,
    source,
  );
  if (typeof result === 'string') {
    throw new Error(`editImageAdd failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

export async function editImageSelect(pageId: string, index: number): Promise<void> {
  await browser.execute<void, [string, number]>(
    function (p, i) {
      (window as any).__SPECTRA_TEST__.editImageSelect(p, i);
    },
    pageId,
    index,
  );
}

/** Run an edit action through the canvas's REAL handler; opts inject what
 * the native dialogs would collect (replace source / extract prefix). */
export async function editImageAct(
  kind: 'delete' | 'replace' | 'extract',
  opts?: {
    source?: { jpeg_path: string } | { raw_path: string; width: number; height: number; channels: 3 | 4 };
    outputPrefix?: string;
  },
): Promise<void> {
  const result = await browser.executeAsync<string | null, [string, unknown]>(
    function (k, o, done) {
      (window as any).__SPECTRA_TEST__.editImageAct(k, o)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    kind,
    opts ?? null,
  );
  if (typeof result === 'string') {
    throw new Error(`editImageAct failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

/**
 * Choose the document pane's view (absolute set, no pill toggle).
 *
 * A document opens in the reading view since M4.1g, so a spec driving
 * BOARD-only behaviour (the page-reorder drag, the strips, the doc headers)
 * must ask for 'organize' rather than assume it.
 */
export async function setDocViewMode(mode: 'organize' | 'document'): Promise<void> {
  await browser.execute<void, ['organize' | 'document']>(
    function (m) {
      (window as any).__SPECTRA_TEST__.setDocViewMode(m);
    },
    mode,
  );
}
