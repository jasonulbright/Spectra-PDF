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
  splitView: boolean;
  splitMode: 'off' | 'two' | 'quad';
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

/**
 * Open a menubar menu and wait for one of its items — RETRYING the trigger.
 *
 * A single `.click()` on a menubar trigger is not reliable immediately after
 * `openByPaths` + `setView('canvas')`, so the click can land while the
 * canvas is still mounting and the menu either never opens or is dismissed
 * by the focus change that follows. Waiting longer cannot fix that — the
 * menu is CLOSED, not slow — which is why this re-issues the trigger
 * instead of extending a timeout.
 *
 * The trigger TOGGLES, so it is only re-clicked when the menu is actually
 * shut (Radix reflects that in `aria-expanded`); re-clicking an open menu
 * would close the very thing we are waiting for.
 */
export async function openMenuItem(menuTestId: string, itemTestId: string): Promise<void> {
  const trigger = $(`[data-testid="${menuTestId}"]`);
  await trigger.waitForDisplayed({ timeout: 15_000 });

  await browser.waitUntil(
    async () => {
      if (await $(`[data-testid="${itemTestId}"]`).isDisplayed()) return true;
      if ((await trigger.getAttribute('aria-expanded')) !== 'true') {
        await trigger.click();
      }
      return await $(`[data-testid="${itemTestId}"]`).isDisplayed();
    },
    {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: `${itemTestId} never appeared after opening ${menuTestId}`,
    },
  );
}

/** Focus a tab directly: 'home' | 'tools' | { doc: path }. */
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

/** Compress panel run with an injected output path (panel must be open).
 *
 * The save dialog is native and undrivable, so the harness supplies the
 * destination and the panel's OWN state drives everything else — the quality
 * select's change handler, the MRC branch, the parameter assembly and the real
 * engine call are all the ones a click reaches. */
export async function compressRun(
  out: string,
  opts?: { quality?: string; mrcPreset?: string; verifyText?: boolean },
): Promise<string> {
  return browser.executeAsync<string, [string, unknown]>(
    function (dest, options, done) {
      (window as any).__SPECTRA_TEST__.compressRun(dest, options)
        .then((r: string) => done(r))
        .catch((err: unknown) => done(`error: ${String(err)}`));
    },
    out,
    opts ?? {},
  );
}

/** Image export via the dialog's harness bridge (dialog must be open). */
export async function exportImagesRun(
  out: string,
  opts?: { format?: string; dpi?: number; pages?: string; gray?: boolean },
): Promise<unknown> {
  return await browser.executeAsync<unknown, [string, object | undefined]>(
    function (dest, options, done) {
      (window as any).__SPECTRA_TEST__.exportImagesRun(dest, options)
        .then((r: unknown) => done(r as any))
        .catch((err: unknown) => done(('__SPECTRA_E2E_ERROR__:' + String(err)) as any));
    },
    out,
    opts,
  );
}

/** Export via the engine (bypasses the native save dialog). Returns the
 *  string '__SPECTRA_E2E_ERROR__:…' on failure so the spec can assert on it. */
export async function exportActiveAs(
  destPath: string,
  format: string,
  options?: Record<string, unknown>,
): Promise<unknown> {
  return await browser.executeAsync<unknown, [string, string, Record<string, unknown>]>(
    function (dest, fmt, opts, done) {
      (window as any).__SPECTRA_TEST__.exportActiveAs(dest, fmt, opts)
        .then((r: unknown) => done(r as any))
        .catch((err: unknown) => done(('__SPECTRA_E2E_ERROR__:' + String(err)) as any));
    },
    destPath,
    format,
    options ?? {},
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

export interface PageAnnotationSnapshot {
  id: string;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  note?: string;
  shapeType?: string;
  strokeWidth?: number;
  fillColor?: string;
  opacity?: number;
  /** The vertex list, for the geometry assertions a snap needs. */
  points?: number[];
  /** Which count group a mark belongs to, its marker symbol and
   * its sequence — spec 107 asserts these RECONSTITUTE from the saved file. */
  countGroup?: string;
  countSymbol?: string;
  countSeq?: number;
  /** The registry symbol a placed stamp / count marker draws, and
   * how many PARTS of carried geometry travel with it (spec 108 asserts the
   * artwork survives save + reopen even where the SET does not). */
  symbolId?: string;
  symbolParts?: number;
}

/** Every pending annotation on one page, workspace order (= z-order). */
export async function getPageAnnotations(
  docId: string,
  pageId: string,
): Promise<PageAnnotationSnapshot[]> {
  return await browser.execute<PageAnnotationSnapshot[], [string, string]>(
    function (d, p) {
      return (window as any).__SPECTRA_TEST__.getPageAnnotations(d, p);
    },
    docId,
    pageId,
  );
}

/** Seed the count groups + arm one (a persisted preference, so
 * a spec must not inherit what the last run left behind). */
export async function takeoffSetGroups(
  groups: { name: string; color: string; symbol: string }[],
  armed: string | null,
): Promise<void> {
  await browser.execute(
    function (g, a) {
      (window as any).__SPECTRA_TEST__.takeoffSetGroups(g, a);
    },
    groups,
    armed as any,
  );
}

export async function takeoffArmed(): Promise<string | null> {
  return (await browser.execute(function () {
    return (window as any).__SPECTRA_TEST__.takeoffArmed();
  })) as string | null;
}

/** Import a symbol SET from a path (the native picker is the
 * only step skipped). Resolves `{ id, outcome }`, or rejects with the refusal
 * message a malformed file earns. */
export async function symbolImportFromPath(
  path: string,
): Promise<{ id: string; outcome: string } | string> {
  return (await browser.executeAsync(
    function (p: string, done: (r: unknown) => void) {
      (window as any).__SPECTRA_TEST__
        .symbolImportFromPath(p)
        .then((r: unknown) => done(r))
        // The refusal MESSAGE is the interesting half — a spec asserts on it,
        // so it comes back as a string rather than as a rejected promise the
        // bridge would flatten to "unknown error".
        .catch((e: unknown) => done(String(e instanceof Error ? e.message : e)));
    },
    path,
  )) as { id: string; outcome: string } | string;
}

export async function symbolSets(): Promise<
  { id: string; name: string; builtin: boolean; symbols: string[] }[]
> {
  return (await browser.execute(function () {
    return (window as any).__SPECTRA_TEST__.symbolSets();
  })) as { id: string; name: string; builtin: boolean; symbols: string[] }[];
}

export async function symbolResetSets(): Promise<void> {
  await browser.execute(function () {
    (window as any).__SPECTRA_TEST__.symbolResetSets();
  });
}

async function editTextPageIdsRaw(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editTextPageIds();
  });
}

async function editParagraphCount(pageId: string): Promise<number> {
  return await browser.execute<number, [string]>(function (p) {
    return (window as any).__SPECTRA_TEST__.editParagraphs(p).length;
  }, pageId);
}

/**
 * Open the paragraph editor and require it to STAY open, re-resolving the page
 * id on every attempt — the `openMenuItem` shape, applied to the editor.
 *
 * Two races live here and only the pair of them is a fix.
 *
 * (1) `editParagraphOpen` is fire-and-forget: it returns void whether or not
 * the editor mounted, so `open(); waitForDisplayed()` is check-then-act. A
 * reindex still in flight from a previous test's undo lands just after the open
 * and re-renders the editor away, and the wait then burns its whole timeout on
 * an editor that was opened once and closed.
 *
 * (2) **Page ids are generation-tagged, so a retry that reuses the caller's id
 * can never recover.** That is not a theory: hardening (1) alone turned the
 * v1.0.20 battery's opaque `edit-para-input still not displayed after 10000ms`
 * into a reproducible `never stayed open for …pdf#g4#p0 paragraph 0` — twenty
 * seconds of re-opening a RETIRED id. The reindex that fires between the
 * caller's listing read and the open publishes generation g+1 and drops g, and
 * by design a stale id can never re-bind. Therefore
 * the id is re-read inside the predicate, exactly as spec 43's convert case had
 * already learned to do locally.
 *
 * Living here means the ~30 call sites across specs
 * 43/49/50/52/54/55/56/57/98/109/110 are covered rather than the one that
 * happened to lose the race — the same reason `openMenuItem` exists.
 */
export async function openParagraphEditor(
  pageId: string,
  index: number,
  timeoutMs = 30_000,
): Promise<void> {
  let lastId = pageId;
  await browser.waitUntil(
    async () => {
      const ids = await editTextPageIdsRaw();
      if (ids.length === 0) return false;
      // Prefer the caller's page when it is still live. Falling back to the
      // sole surviving id is safe precisely because it is SOLE — every caller
      // today reads `editTextPageIds()[0]` off a single-page fixture. A
      // multi-page caller whose id retired gets no guess, it gets a timeout.
      const target = ids.includes(pageId) ? pageId : ids.length === 1 ? ids[0] : '';
      if (!target) return false;
      const count = await editParagraphCount(target);
      if (count === 0 || index >= count) return false;
      lastId = target;

      await browser.execute<void, [string, number]>(
        function (p, i) {
          (window as any).__SPECTRA_TEST__.editParagraphOpen(p, i);
        },
        target,
        index,
      );
      // Long enough for a reindex that is already in flight to land and take
      // the editor back down, so a "displayed" answer means it stayed.
      await browser.pause(400);
      return await $('[data-testid="edit-para-input"]')
        .isDisplayed()
        .catch(() => false);
    },
    {
      timeout: timeoutMs,
      interval: 250,
      timeoutMsg:
        `the paragraph editor never stayed open for paragraph ${index} ` +
        `(asked for ${pageId}, last live page id ${lastId})`,
    },
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

/** Persist the pending marks as the file's /Redact set. */
export async function saveRedactionMarks(): Promise<void> {
  const result = await browser.executeAsync<string | null, []>(function (done) {
    (window as any).__SPECTRA_TEST__.saveRedactionMarks()
      .then(() => done(null))
      .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
  });
  if (typeof result === 'string') {
    throw new Error(`saveRedactionMarks failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

export async function getRedactionMarkCount(): Promise<number> {
  return await browser.execute(function () {
    return (window as any).__SPECTRA_TEST__.getRedactionMarkCount();
  });
}

export async function clearRedactionMarks(): Promise<void> {
  await browser.execute(function () {
    (window as any).__SPECTRA_TEST__.clearRedactionMarks();
  });
}

/** Import a file's pages into a document at an index — the add-page /
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

/** Workspace-flattened page ids in order. Canvas must be mounted. */
/** The active file's page-tier pages with sizes (value assertions). */
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

/** Select a set of canvas page ids (multi-select). */
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
 * Dispatch a real global keydown on `window` (keyboard shortcuts).
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

/** Flattened outline rows the sidebar shows. Sidebar must be mounted. */
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
  // One signer source: .pfx path, or PEM key+cert pair.
  pfxPath?: string;
  keyPath?: string;
  certPath?: string;
  password: string;
  output: string;
  reason?: string;
  location?: string;
  // Visible-stamp placement (engine convention: 1-based page, PDF points).
  appearance?: { page: number; rect: [number, number, number, number] };
  /** PAdES (ETSI.CAdES.detached) profile. */
  pades?: boolean;
  /** Apply an author (certification) signature at this level. */
  certify?: boolean;
  certifyLevel?: CertifyLevel;
}

export interface SignSummary {
  output: string;
  signer: string | null;
  valid: boolean;
  intact: boolean;
  covers_whole_document: boolean;
  certified?: boolean;
  certification_level?: string | null;
}

/** Wire values, never localized. */
export type CertifyLevel = 'none' | 'form-fill' | 'annotate';

/** What a read-only verify reports: the counts, the document-level
 * certification and each signature's policy verdict. */
export interface SignatureVerifySnapshot {
  signature_count: number;
  all_valid: boolean;
  certified: boolean;
  certification_level: string | null;
  any_policy_violation: boolean;
  any_lock_violation?: boolean;
  signatures: {
    field: string | null;
    certification_level: string | null;
    policy_ok: boolean | null;
    policy_judged: boolean;
    modification_level: string | null;
    lock?: { action: string; fields: string[] } | null;
    lock_violation?: { fields: string[] } | null;
  }[];
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

export interface SignInPlaceParams {
  pfxPath?: string;
  keyPath?: string;
  certPath?: string;
  password: string;
  reason?: string;
  location?: string;
  certify?: boolean;
  certifyLevel?: CertifyLevel;
  /** Lock form fields against further change after signing. */
  lock?: 'all' | 'include' | 'exclude';
  lockFields?: string[];
}

/** Sign the ACTIVE document in place (no output path) via the undoable
 * workspace flow. Returns the post-sign verification summary. */
export async function signActiveFileInPlace(
  params: SignInPlaceParams,
): Promise<{ signature_count: number; all_valid: boolean }> {
  const result = await browser.executeAsync<
    { signature_count: number; all_valid: boolean } | string,
    [SignInPlaceParams]
  >(function (p, done) {
    (window as any).__SPECTRA_TEST__.signActiveFileInPlace(p)
      .then((res: unknown) => done(res as any))
      .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
  }, params);
  if (typeof result === 'string') {
    throw new Error(`signActiveFileInPlace failed: ${result.replace(ERROR_TAG, '')}`);
  }
  return result;
}

/** Read-only verify of the active working copy's signatures. */
export async function verifyActiveSignatures(): Promise<SignatureVerifySnapshot> {
  const result = await browser.executeAsync<SignatureVerifySnapshot | string, []>(function (done) {
    (window as any).__SPECTRA_TEST__.verifyActiveSignatures()
      .then((res: unknown) => done(res as any))
      .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
  });
  if (typeof result === 'string') {
    throw new Error(`verifyActiveSignatures failed: ${result.replace(ERROR_TAG, '')}`);
  }
  return result;
}

export interface DocScript {
  name: string;
  js: string;
}

/** Set the active document's JavaScript (undoable) via the panel flow. */
export async function documentJsSet(scripts: DocScript[]): Promise<void> {
  const result = await browser.executeAsync<string | null, [DocScript[]]>(function (s, done) {
    (window as any).__SPECTRA_TEST__.documentJsSet(s)
      .then(() => done(null))
      .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
  }, scripts);
  if (typeof result === 'string') {
    throw new Error(`documentJsSet failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

/** Read the active working copy's document JavaScript. */
export async function documentJsList(): Promise<DocScript[]> {
  const result = await browser.executeAsync<DocScript[] | string, []>(function (done) {
    (window as any).__SPECTRA_TEST__.documentJsList()
      .then((res: unknown) => done(res as any))
      .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
  });
  if (typeof result === 'string') {
    throw new Error(`documentJsList failed: ${result.replace(ERROR_TAG, '')}`);
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

/** Draw a crop band on the first page of the active document, through
 * the real canvas handler. */
export async function drawCropRect(rect: { x: number; y: number; w: number; h: number }): Promise<void> {
  const result = await browser.executeAsync<string | null, [{ x: number; y: number; w: number; h: number }]>(
    function (r, done) {
      (window as any).__SPECTRA_TEST__.drawCropRect(r)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    rect,
  );
  if (typeof result === 'string') {
    throw new Error(`drawCropRect failed: ${result.replace(ERROR_TAG, '')}`);
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
        if (tracker) tracker.setValue(v + '\u0000'); // force a tracked change
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

/** setReactInputValue's sibling for a controlled `<select>` (family
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
        if (tracker) tracker.setValue(v + '\u0000'); // force a tracked change
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

// --- On-canvas form fill --------------------------------------------------

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
    /** The `/Lock` seed, signature fields only — what whoever signs it later
     * is bound by. */
    lock?: { action: 'all' | 'include' | 'exclude' | null; fields: string[] };
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
  rotate?: 0 | 90 | 180 | 270;
  bold?: boolean;
  italic?: boolean;
  // OpenType features.
  smallCaps?: boolean;
  alternates?: boolean;
  altIndex?: number;
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

// --- Canvas whole-document merge -------------------------------------------

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

// --- Batch OCR --------------------------------------------------------------

export interface BatchOcrSnapshot {
  phase: 'setup' | 'running' | 'done';
  fileCount: number | null;
  report: {
    cancelled: boolean;
    results: {
      rel: string;
      status: string;
      pagesOcrd?: number;
      reason?: string;
      /** Where the ORIGINAL ended up, and why it did
       * not move if a move was asked for and did not happen. */
      movedTo?: string;
      moveError?: string;
      repaired?: boolean;
      repairedOriginalReplaced?: boolean;
    }[];
    skippedDirs: string[];
  } | null;
  /** Full path of the log the run wrote, or null when logging is
   * off or the write failed. The spec reads the file back from disk. */
  logPath: string | null;
}

/** Inject the opt-in moved/error roots. The native
 * folder pickers are not WebDriver-drivable; the checkboxes beside them ARE,
 * and the spec clicks those for real. */
export async function batchOcrSetFiling(filing: {
  movedRoot?: string | null;
  errorRoot?: string | null;
}): Promise<void> {
  await browser.execute(function (f: { movedRoot?: string | null; errorRoot?: string | null }) {
    (window as any).__SPECTRA_TEST__.batchOcrSetFiling(f);
  }, filing);
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

// --- Search & Redact folder -------------------------------------------------

export interface DiskRedactSnapshot {
  phase: 'setup' | 'searching' | 'review' | 'applying' | 'done';
  fileCount: number | null;
  /** Every hit key the run may act on. A spec checks a SUBSET of these, which
   * is what lets it prove an unchecked occurrence survived. */
  hitKeys: string[];
  files: { rel: string; hits: number; skipReason: string | null }[] | null;
  report: {
    cancelled: boolean;
    results: { rel: string; status: string; regions?: number; reason?: string }[];
    skippedDirs: string[];
  } | null;
  logPath: string | null;
}

/** Inject source+destination into the open Search & Redact folder dialog —
 * runs the dialog's REAL selection flow, enumeration included. */
export async function diskRedactSetFolders(source: string, dest: string): Promise<void> {
  const result = await browser.executeAsync<string | null, [string, string]>(
    function (s, d, done) {
      (window as any).__SPECTRA_TEST__.diskRedactSetFolders(s, d)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    source,
    dest,
  );
  if (typeof result === 'string') {
    throw new Error(`diskRedactSetFolders failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

/** Run the search WITHOUT awaiting it — a folder sweep can outlive the
 * WebDriver script timeout. Poll `diskRedactSnapshot()` for the phase. */
export async function diskRedactSearch(query: string): Promise<void> {
  await browser.execute(function (q: string) {
    void (window as any).__SPECTRA_TEST__.diskRedactSearch(q);
  }, query);
}

export async function diskRedactCheck(keys: string[]): Promise<void> {
  await browser.execute(function (k: string[]) {
    (window as any).__SPECTRA_TEST__.diskRedactCheck(k);
  }, keys);
}

/** Same non-awaiting shape as the search. */
export async function diskRedactApply(): Promise<void> {
  await browser.execute(function () {
    void (window as any).__SPECTRA_TEST__.diskRedactApply();
  });
}

export async function diskRedactSnapshot(): Promise<DiskRedactSnapshot | null> {
  return await browser.execute<DiskRedactSnapshot | null, []>(function () {
    return (window as any).__SPECTRA_TEST__.diskRedactSnapshot();
  });
}

// --- Tools ▸ Prepare Forms in a Folder ------------------------------------

export interface FormPrepSnapshot {
  phase: 'setup' | 'detecting' | 'review' | 'applying' | 'done';
  fileCount: number | null;
  /** Every candidate key the run may act on. A spec checks a SUBSET of these,
   * which is what lets it prove an unchecked candidate never became a field. */
  candidateKeys: string[];
  files:
    | {
        rel: string;
        candidates: number;
        existingFields: number;
        skipReason: string | null;
        names: string[];
      }[]
    | null;
  report: {
    cancelled: boolean;
    results: { rel: string; status: string; fields?: number; reason?: string }[];
    skippedDirs: string[];
  } | null;
  logPath: string | null;
}

/** Inject source+destination into the open folder form-preparation dialog —
 * runs the dialog's REAL selection flow, enumeration included. */
export async function formPrepSetFolders(source: string, dest: string): Promise<void> {
  const result = await browser.executeAsync<string | null, [string, string]>(
    function (s, d, done) {
      (window as any).__SPECTRA_TEST__.formPrepSetFolders(s, d)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    source,
    dest,
  );
  if (typeof result === 'string') {
    throw new Error(`formPrepSetFolders failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

/** Run the detection WITHOUT awaiting it — a folder sweep can outlive the
 * WebDriver script timeout. Poll `formPrepSnapshot()` for the phase. */
export async function formPrepDetect(): Promise<void> {
  await browser.execute(function () {
    void (window as any).__SPECTRA_TEST__.formPrepDetect();
  });
}

export async function formPrepCheck(keys: string[]): Promise<void> {
  await browser.execute(function (k: string[]) {
    (window as any).__SPECTRA_TEST__.formPrepCheck(k);
  }, keys);
}

/** Same non-awaiting shape as the detection. */
export async function formPrepApply(): Promise<void> {
  await browser.execute(function () {
    void (window as any).__SPECTRA_TEST__.formPrepApply();
  });
}

export async function formPrepSnapshot(): Promise<FormPrepSnapshot | null> {
  return await browser.execute<FormPrepSnapshot | null, []>(function () {
    return (window as any).__SPECTRA_TEST__.formPrepSnapshot();
  });
}

// --- Tools ▸ Export a Folder ----------------------------------------------

export interface FolderExportSnapshot {
  phase: 'setup' | 'running' | 'done';
  fileCount: number | null;
  report: {
    cancelled: boolean;
    results: { rel: string; status: string; out?: string; produced?: string; reason?: string }[];
    skippedDirs: string[];
  } | null;
  logPath: string | null;
}

/** Inject source+destination into the open folder-export dialog — runs the
 * dialog's REAL selection flow, enumeration included. */
export async function folderExportSetFolders(source: string, dest: string): Promise<void> {
  const result = await browser.executeAsync<string | null, [string, string]>(
    function (s, d, done) {
      (window as any).__SPECTRA_TEST__.folderExportSetFolders(s, d)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    source,
    dest,
  );
  if (typeof result === 'string') {
    throw new Error(`folderExportSetFolders failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

export async function folderExportSetFormat(format: string): Promise<void> {
  await browser.execute(function (f: string) {
    (window as any).__SPECTRA_TEST__.folderExportSetFormat(f);
  }, format);
}

/** Run the sweep WITHOUT awaiting it — a folder run can outlive the WebDriver
 * script timeout. Poll `folderExportSnapshot()` for the phase. */
export async function folderExportRun(): Promise<void> {
  await browser.execute(function () {
    void (window as any).__SPECTRA_TEST__.folderExportRun();
  });
}

export async function folderExportSnapshot(): Promise<FolderExportSnapshot | null> {
  return await browser.execute<FolderExportSnapshot | null, []>(function () {
    return (window as any).__SPECTRA_TEST__.folderExportSnapshot();
  });
}

// --- Edit ▸ Images ---------------------------------------------------------

export async function editImagePageIds(): Promise<string[]> {
  return await browser.execute<string[], []>(function () {
    return (window as any).__SPECTRA_TEST__.editImagePageIds();
  });
}

/**
 * The listing maps are keyed by generation-tagged page ids; a whole-file op
 * rebuilds the file, the ids rotate, and the canvas prunes the dead keys
 * immediately — so the maps are EMPTY for the whole per-page engine refetch.
 * An assertion on emptiness alone therefore also passes when the op did
 * nothing at all. Always pair it with this.
 */
export async function editImageListingSettled(): Promise<boolean> {
  return await browser.execute<boolean, []>(function () {
    return (window as any).__SPECTRA_TEST__.editImageListingSettled();
  });
}

/** Page ids from a SETTLED listing — the only honest reading. */
export async function settledEditImagePageIds(): Promise<string[] | null> {
  return await browser.execute<string[] | null, []>(function () {
    const h = (window as any).__SPECTRA_TEST__;
    return h.editImageListingSettled() ? h.editImagePageIds() : null;
  });
}

export async function editImagePlacements(
  pageId: string,
): Promise<
  {
    index: number;
    nested: boolean;
    matrix: number[];
    opacity: number;
    blend: string;
    mask: {
      kind: string;
      from: [number, number];
      to: [number, number];
      startAlpha: number;
      endAlpha: number;
    } | null;
    kind: string;
    crop: number[] | null;
  }[]
> {
  return await browser.execute<
    {
      index: number;
      nested: boolean;
      matrix: number[];
      opacity: number;
      kind: string;
      crop: number[] | null;
    }[],
    [string]
  >(
    function (p) {
      return (window as any).__SPECTRA_TEST__.editImagePlacements(p);
    },
    pageId,
  );
}

/** Transform an image placement to an absolute user-space matrix,
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

/** Add Image: embed a source at a user-space rect through the REAL
 * commit path (the native picker is undrivable — inject the source).
 * rect=null with `at` = the natural-size click-place. */
export async function editImageAdd(
  page: number,
  rect: [number, number, number, number] | null,
  source:
    | { jpeg_path: string }
    | { raw_path: string; width: number; height: number; channels: 3 | 4 }
    | { svg_path: string },
  at?: [number, number],
): Promise<void> {
  const result = await browser.executeAsync<
    string | null,
    [number, number[] | null, unknown, number[] | null]
  >(
    function (pg, r, s, a, done) {
      (window as any).__SPECTRA_TEST__.editImageAdd(pg, r, s, a ?? undefined)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    page,
    rect,
    source,
    at ?? null,
  );
  if (typeof result === 'string') {
    throw new Error(`editImageAdd failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

export async function editImageSelection(): Promise<
  { kind: string; pageId: string; index: number; indexes?: number[] } | null
> {
  return await browser.execute<
    { kind: string; pageId: string; index: number; indexes?: number[] } | null,
    []
  >(
    function () {
      return (window as any).__SPECTRA_TEST__.editImageSelection();
    },
  );
}

export async function editImageSelect(
  pageId: string,
  index: number,
  additive?: boolean,
): Promise<void> {
  await browser.execute<void, [string, number, boolean]>(
    function (p, i, a) {
      (window as any).__SPECTRA_TEST__.editImageSelect(p, i, a);
    },
    pageId,
    index,
    Boolean(additive),
  );
}

/** Multi-select: group transform — ONE multi engine op (one undo entry). */
export async function editImageTransformMany(
  pageId: string,
  targets: { index: number; matrix: number[] }[],
): Promise<void> {
  const result = await browser.executeAsync<
    string | null,
    [string, { index: number; matrix: number[] }[]]
  >(
    function (p, t, done) {
      (window as any).__SPECTRA_TEST__.editImageTransformMany(p, t)
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
    pageId,
    targets,
  );
  if (typeof result === 'string') {
    throw new Error(`editImageTransformMany failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

/** Delete the CURRENT selection (routes the group op at N>1). */
export async function editImageDeleteSelected(): Promise<void> {
  const result = await browser.executeAsync<string | null, []>(
    function (done) {
      (window as any).__SPECTRA_TEST__.editImageDeleteSelected()
        .then(() => done(null))
        .catch((err: unknown) => done((('__SPECTRA_E2E_ERROR__:') + String(err)) as any));
    },
  );
  if (typeof result === 'string') {
    throw new Error(`editImageDeleteSelected failed: ${result.replace(ERROR_TAG, '')}`);
  }
}

/** Run an edit action through the canvas's REAL handler; opts inject what
 * the native dialogs would collect (replace source / extract prefix) or,
 * for the adjustments, the crop rect (image-unit space) / opacity. */
export async function editImageAct(
  kind: 'delete' | 'replace' | 'extract' | 'crop' | 'opacity',
  opts?: {
    source?: { jpeg_path: string } | { raw_path: string; width: number; height: number; channels: 3 | 4 };
    outputPrefix?: string;
    rect?: [number, number, number, number];
    opacity?: number;
    blend?: string;
    mask?:
      | { kind: 'none' }
      | {
          kind: 'linear' | 'radial';
          from: [number, number];
          to: [number, number];
          start_alpha: number;
          end_alpha: number;
        };
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
 * A document opens in the reading view, so a spec driving
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

/**
 * The paragraph editor is a contentEditable RICH SURFACE, not a
 * textarea — per-span colour/weight/slant/family/size render as real styles so
 * the caret, the selection and the line wrapping are computed from the same
 * glyphs the user sees (the mirror-overlay it replaced positioned the caret
 * from a uniform-metric textarea, which drifts under any bold/size/family run).
 *
 * `setReactInputValue` cannot drive it: there is no `value` property and no
 * React `_valueTracker`. Replace the text and fire the same `input` event the
 * browser fires, then wait for React to render its state back.
 */
export async function setContentEditableValue(selector: string, value: string): Promise<void> {
  await $(selector).waitForDisplayed({ timeout: 10_000 });
  await browser.waitUntil(
    async () =>
      browser.execute(
        function (sel, v) {
          // Re-query INSIDE the execute — a React re-render can replace the
          // node between calls (the setReactInputValue stale-handle lesson).
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) return false;
          el.focus();
          el.textContent = v;
          // Caret to the end so a following keystroke appends, and so the
          // component's input handler reads a real selection.
          const selection = window.getSelection();
          if (selection && el.firstChild) {
            const r = document.createRange();
            r.setStart(el.firstChild, (el.firstChild.textContent ?? '').length);
            r.collapse(true);
            selection.removeAllRanges();
            selection.addRange(r);
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          return (el.textContent ?? '') === v;
        },
        selector,
        value,
      ),
    { timeout: 10_000, timeoutMsg: `contentEditable ${selector} never took the value` },
  );
}

/**
 * Select a CODE-POINT range in the paragraph editor (the domain the engine's
 * spans use — `Array.from`, so an astral char is ONE unit). Replaces the
 * `ta.selectionStart = x` idiom the textarea specs used; walks the rendered
 * style segments' text nodes so a selection can span several styled runs.
 */
export async function setParagraphSelection(start: number, end: number): Promise<void> {
  const selector = '[data-testid="edit-para-input"]';
  await $(selector).waitForDisplayed({ timeout: 10_000 });
  await browser.execute(
    function (sel, s, e) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error('paragraph editor not open');
      // code-point offset -> UTF-16 offset inside one string
      const cpToUtf16 = function (str: string, cp: number): number {
        let i = 0;
        let n = 0;
        while (n < cp && i < str.length) {
          const c = str.codePointAt(i) as number;
          i += c > 0xffff ? 2 : 1;
          n++;
        }
        return i;
      };
      // Walk text nodes in order, converting an absolute code-point offset
      // into (node, utf16Offset).
      const locate = function (target: number): { node: Node; offset: number } {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let seen = 0;
        let last: Node | null = null;
        let node = walker.nextNode();
        while (node) {
          const text = node.textContent ?? '';
          const len = Array.from(text).length;
          if (seen + len >= target) {
            return { node, offset: cpToUtf16(text, target - seen) };
          }
          seen += len;
          last = node;
          node = walker.nextNode();
        }
        // Past the end: clamp to the last text node's end.
        if (last) return { node: last, offset: (last.textContent ?? '').length };
        return { node: el, offset: 0 };
      };
      el.focus();
      const a = locate(s);
      const b = locate(e);
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const selection = window.getSelection();
      if (!selection) throw new Error('no selection object');
      selection.removeAllRanges();
      selection.addRange(range);
      // Mirror what a real drag does, so the component's selection capture runs.
      el.dispatchEvent(new Event('select', { bubbles: true }));
      document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    },
    selector,
    start,
    end,
  );
}

// --- Scheduled batch runs ---------------------------------------------------
//
// The dialog's folder pickers are native and not WebDriver-drivable, so a spec
// injects a whole profile through the SAME create path the form's Save button
// runs, then lists and deletes through the same commands the buttons use.

export interface ScheduleProfileInput {
  name: string;
  source: string;
  dest: string;
  lang?: string;
  movedRoot?: string;
  errorRoot?: string;
  repairDamaged?: boolean;
  replaceRepairedOriginals?: boolean;
  logDir?: string;
  frequency?: string;
  time?: string;
  days?: string;
  account?: string;
  /** 'batch-ocr' (default) or 'action' (guided actions). */
  runType?: string;
}

export interface ScheduledRunRow {
  name: string;
  profile: { source: string; dest: string; lang: string; runType?: string; actionFile?: string } | null;
  status: string;
  nextRun: string;
  actionName?: string;
  actionSteps?: string[];
  actionMissing?: boolean;
}

/** `actionJson` = the frozen `{name, steps}` body for runType 'action'. */
export async function scheduleCreate(
  profile: ScheduleProfileInput,
  actionJson?: string,
): Promise<string> {
  return await browser.execute(
    function (p: ScheduleProfileInput, aj: string | undefined) {
      return (window as any).__SPECTRA_TEST__.scheduleCreate(p, aj);
    },
    profile,
    actionJson,
  );
}

export async function scheduleList(): Promise<ScheduledRunRow[]> {
  return await browser.execute(function () {
    return (window as any).__SPECTRA_TEST__.scheduleList();
  });
}

export async function scheduleRemove(name: string): Promise<void> {
  await browser.execute(function (n: string) {
    return (window as any).__SPECTRA_TEST__.scheduleRemove(n);
  }, name);
}

export interface TableReviewRow {
  id: string;
  page: number;
  caption: string | null;
  /** Column starts as fractions of the table's own width, ascending. */
  columns: number[];
  rows: number;
  cells: number;
  accepted: boolean;
}

/** The detected tables the review is holding. */
export async function tableReviewList(): Promise<TableReviewRow[]> {
  return await browser.execute(function () {
    return (window as any).__SPECTRA_TEST__.tableReviewList();
  });
}

export async function tableReviewToggle(regionId: string): Promise<void> {
  await browser.execute(function (id: string) {
    return (window as any).__SPECTRA_TEST__.tableReviewToggle(id);
  }, regionId);
}

/** Move a column boundary to `fraction` of the table's own width. */
export async function tableReviewMoveColumn(
  regionId: string,
  index: number,
  fraction: number,
): Promise<void> {
  await browser.execute(
    function (id: string, i: number, f: number) {
      return (window as any).__SPECTRA_TEST__.tableReviewMoveColumn(id, i, f);
    },
    regionId,
    index,
    fraction,
  );
}

/** Write the accepted tables (bypasses the native save dialog). Returns the
 *  string '__SPECTRA_E2E_ERROR__:…' on failure so the spec can assert on it. */
export async function tableReviewExport(
  destPath: string,
  options?: { sheetPer?: string; includeUntabled?: boolean },
): Promise<unknown> {
  return await browser.executeAsync<unknown, [string, object]>(
    function (dest, opts, done) {
      (window as any).__SPECTRA_TEST__.tableReviewExport(dest, opts)
        .then((r: unknown) => done(r as any))
        .catch((err: unknown) => done(('__SPECTRA_E2E_ERROR__:' + String(err)) as any));
    },
    destPath,
    options ?? {},
  );
}
