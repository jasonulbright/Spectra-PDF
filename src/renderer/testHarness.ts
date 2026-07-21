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
import { invokeCommand as invokeRegisteredCommand } from './commands/context';
import { COMMANDS, type CommandId } from './commands/registry';
import type { FocusedTab } from './state/types';

export interface TestStateSnapshot {
  // Legacy projection of the tab model (Phase 4 M2) — kept so pre-M2 specs'
  // assertions hold: home→'welcome', tools→'operations', doc→'canvas'.
  view: 'welcome' | 'operations' | 'canvas';
  focusedTab: FocusedTab;
  activeOp: string;
  /** The armed canvas mode (M5.3/M5.4 — the secondary toolbar reads it). */
  tool: string;
  /** The OPEN tool, if any. */
  activeToolId: string | null;
  /** Which document pane is showing (M6.3 — the View menu's mode items). */
  docViewMode: 'organize' | 'document';
  /** The page being read (M4.1e tracking) — insertion anchors hang off it. */
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
 * Batch OCR (Phase 6): the dialog's folder pickers are native and not
 * WebDriver-drivable, so the dialog registers path injectors that run the
 * SAME selectSource/setDest/start flow the buttons run. A spec opens the
 * dialog (`tools.batchOcr`), injects fixture folders, starts, then polls
 * `snapshot()` until phase === 'done' and asserts on the report.
 */
export interface BatchOcrHandlers {
  setSource: (path: string) => Promise<void>;
  setDest: (path: string) => void;
  start: () => Promise<void>;
  snapshot: () => {
    phase: 'setup' | 'running' | 'done';
    fileCount: number | null;
    report: {
      cancelled: boolean;
      results: { rel: string; status: string; pagesOcrd?: number; reason?: string }[];
      skippedDirs: string[];
    } | null;
  };
}

let batchOcr: BatchOcrHandlers | null = null;

export function registerBatchOcr(handlers: BatchOcrHandlers | null): void {
  batchOcr = handlers;
}

/**
 * Create PDF from PostScript (Phase 8): the source/output pickers are
 * native dialogs — e2e injects paths and runs the REAL conversion path.
 */
export interface CreatePdfHandlers {
  run: (source: string, output: string, preset?: string) => Promise<boolean>;
}

let createPdf: CreatePdfHandlers | null = null;

export function registerCreatePdf(handlers: CreatePdfHandlers | null): void {
  createPdf = handlers;
}

/**
 * Edit ▸ Images (7.1): placements live in transformed canvas space and the
 * Replace/Extract actions pop NATIVE dialogs — both undrivable by WebDriver.
 * The canvas registers its real selection + action paths; `act`'s opts
 * inject what the dialogs would have collected (the signing precedent).
 */
export interface CanvasEditImagesHandlers {
  /** Page ids that currently have listed placements (edit mode armed). */
  pageIds: () => string[];
  placements: (
    pageId: string,
  ) => {
    index: number;
    nested: boolean;
    matrix: number[];
    opacity: number;
    kind: string;
    crop: number[] | null;
  }[];
  select: (pageId: string, index: number) => void;
  /** Transform (9.C1) the selected image via the real commit path. */
  transformImage: (pageId: string, index: number, matrix: number[]) => Promise<void>;
  /** Add Image (9.C2): embed a source at a user-space rect via the real
   * commit path (the native file picker is undrivable — inject the source). */
  addImage: (
    page: number,
    rect: [number, number, number, number],
    source: { jpeg_path: string } | { raw_path: string; width: number; height: number; channels: 3 | 4 },
  ) => Promise<void>;
  selection: () => { kind: 'image' | 'text' | 'para'; pageId: string; index: number } | null;
  /** Text runs (7.2): listing + opening the REAL inline editor (the input
   * itself is then driven through the DOM — data-testid edit-text-input). */
  textRuns: (
    pageId: string,
  ) => { index: number; text: string; editable: boolean; reason: string | null }[];
  textPageIds: () => string[];
  openTextEditor: (pageId: string, index: number) => void;
  /** Paragraph layer (7.5). */
  paragraphs: (
    pageId: string,
  ) => {
    index: number;
    text: string;
    lineCount: number;
    alignment: string;
    vertical: boolean;
    colors: string[];
    sizes: number[];
  }[];
  openParagraphEditor: (pageId: string, index: number) => void;
  act: (
    kind: 'delete' | 'replace' | 'extract' | 'crop' | 'opacity',
    opts?: {
      source?: { jpeg_path: string } | { raw_path: string; width: number; height: number; channels: 3 | 4 };
      outputPrefix?: string;
      rect?: [number, number, number, number];
      opacity?: number;
    },
  ) => Promise<void>;
  /** Add Text (9.A2): place a box on the active file's first page (the band
   * lives in transformed canvas space — undrivable), then author via the REAL
   * display→PDF + engine-op path. */
  placeAddText: (rect: { x: number; y: number; w: number; h: number }) => boolean;
  commitAddText: (params: {
    text: string;
    size?: number;
    color?: [number, number, number];
    family?: 'sans' | 'serif' | 'mono';
    rotate?: 0 | 90 | 180 | 270;
    bold?: boolean;
    italic?: boolean;
  }) => Promise<void>;
  // 9.D1 vector objects.
  vectorPageIds: () => string[];
  vectors: (pageId: string) => {
    index: number;
    kind: 'fill' | 'stroke' | 'fillstroke';
    fill: [number, number, number] | null;
    stroke: [number, number, number] | null;
  }[];
  selectVector: (pageId: string, index: number) => void;
  selectedVector: () => { pageId: string; index: number } | null;
  deleteSelectedVector: () => Promise<void>;
}

let canvasEditImages: CanvasEditImagesHandlers | null = null;

export function registerCanvasEditImages(handlers: CanvasEditImagesHandlers | null): void {
  canvasEditImages = handlers;
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
 * On-canvas form fill (2n.4b): the overlay inputs live inside transformed
 * canvas space (flaky to drive via WebDriver), so the canvas registers
 * value-setting + apply against the REAL pending-value map and fill path.
 * Values are validated against the current field read (must exist + be
 * editable), mirroring what the UI controls allow.
 */
export interface CanvasFormsHandlers {
  setFieldValue: (path: string, fieldName: string, value: string | boolean | string[]) => boolean;
  pendingCount: () => number;
  apply: () => Promise<string[]>; // per-file failure messages; empty = success
  widgetCountFor: (path: string) => number;
  // Add-field authoring (2n.4c) — place on the active file's first page
  // (display-normalized rect), then create through the REAL conversion +
  // whole-file-op flow the card's Create button runs.
  placeNewFieldOnFirstPage: (rect: { x: number; y: number; w: number; h: number }) => boolean;
  createPlacedField: (params: {
    name: string;
    type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist' | 'signature';
    options?: string[];
    multiline?: boolean;
  }) => Promise<void>;
  // Sign into an existing empty signature field of the ACTIVE file (2n.4d) —
  // the sign card's field branch with the dialog paths injected.
  signField: (params: {
    fieldName: string;
    pfxPath?: string;
    keyPath?: string;
    certPath?: string;
    password: string;
    output: string;
    reason?: string;
    location?: string;
  }) => Promise<{
    signer: string | null;
    output: string;
    valid: boolean;
    intact: boolean;
    covers_whole_document: boolean;
  }>;
}

let canvasForms: CanvasFormsHandlers | null = null;

export function registerCanvasForms(handlers: CanvasFormsHandlers | null): void {
  canvasForms = handlers;
}

/**
 * Canvas whole-document merge (2o): the header hover actions sit inside the
 * transformed overlay (flaky to click via WebDriver), so the canvas registers
 * the doc listing plus the REAL merge-up and guarded remove paths.
 */
export interface CanvasMergeHandlers {
  getDocs: () => { id: string; path: string; name: string; pages: number }[];
  mergeUp: (docId: string) => void;
  removeDoc: (docId: string) => void; // the guarded header × path
  noticeText: () => string | null; // the merge close-guard banner, if shown
}

let canvasMerge: CanvasMergeHandlers | null = null;

export function registerCanvasMerge(handlers: CanvasMergeHandlers | null): void {
  canvasMerge = handlers;
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
  /** Switch the main view (legacy — maps onto the tab model: welcome→Home,
   * operations→Tools, canvas→the active/first document's tab). */
  setView: (view: 'welcome' | 'operations' | 'canvas') => void;
  /** Focus a tab directly (Phase 4 M2): 'home' | 'tools' | { doc: path }. */
  focusTab: (tab: FocusedTab) => void;
  /** Select an operation in the sidebar. */
  setActiveOp: (op: string) => void;
  /** Invoke a command-registry entry — the ONE entry point the menus,
   * toolbars and keymap share (Phase 4 M1). Returns false when the command's
   * enablement predicate refused; throws on an unknown id. */
  invokeCommand: (id: string) => boolean;
  /** Arm a canvas interaction tool directly (absolute set, no pill toggle). */
  setTool: (tool: string) => void;
  /** Choose the document pane's view (absolute set, no pill toggle). A document
   * opens in 'document' (the reading view) since M4.1g, so a spec that drives
   * BOARD-only behaviour — the page-reorder drag, the strips — must ask for
   * 'organize' rather than assume it. */
  setDocViewMode: (mode: 'organize' | 'document') => void;
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
  /** Import a file's pages into a document at an index (2n.3) — the same path
   * the add-page ghost / per-position drop run, bypassing the native picker.
   * Resolves once the byte-only source is registered and the pages spliced. */
  importPagesIntoDoc: (filePath: string, toDocId: string, toIndex: number) => Promise<void>;
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
  /** The active file's page-tier pages with sizes (M6.3 value assertions). */
  getActiveDocPages: () => { id: string; width: number; height: number }[];
  /** Delete the current canvas selection via the same batched path Delete runs
   * (DELETE_PAGE_REFS → page tier). Canvas view must be mounted. */
  deleteSelectedCanvasPages: () => void;
  /** Rotate the current canvas selection ±90 via the batched path (`[`/`]`). */
  rotateSelectedCanvasPages: (delta: 90 | 270) => void;
  /** Flattened outline rows (title/depth/page) the bookmarks surface shows.
   * The nav-pane Bookmarks panel must be mounted (M3.2b — navicon-bookmarks). */
  getOutlineOrder: () => { title: string; depth: number; page: number | null }[];
  /** Reorder an outline node via the exact drop path (moveOutlineNode ->
   * set_outline -> UPDATE_FILE); resolves after the save. */
  reorderOutline: (fromPath: number[], overIndex: number, depth: number) => Promise<void>;
  /** Set a pending on-canvas form value for a field of an open file (2n.4b)
   * — validated against the current field read like the real overlay inputs
   * (must exist + be editable). Returns false when refused. Canvas view must
   * be mounted; polls for the async forms read like addAnnotation does for
   * the indexer. */
  setCanvasFormValue: (
    path: string,
    fieldName: string,
    value: string | boolean | string[],
    timeoutMs?: number,
  ) => Promise<boolean>;
  /** Total pending on-canvas form values. */
  pendingFormValueCount: () => number;
  /** Bake all pending on-canvas form values via the real fill path (the
   * "Fill N fields" button); rejects if any file failed. */
  applyCanvasFormValues: () => Promise<void>;
  /** Overlay widget count read for a file (0 until the async read lands). */
  formWidgetCount: (path: string) => number;
  /** Place a new-field box on the active file's first canvas page (2n.4c),
   * waiting for the canvas + indexer like placeSignature. */
  placeNewField: (
    rect: { x: number; y: number; w: number; h: number },
    timeoutMs?: number,
  ) => Promise<void>;
  /** Create the placed field through the real conversion + whole-file-op
   * flow (the card's Create button); rejects with the validation message on
   * refusal. */
  createPlacedField: (params: {
    name: string;
    type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist' | 'signature';
    options?: string[];
    multiline?: boolean;
  }) => Promise<void>;
  /** Sign into an existing empty signature field of the active file (2n.4d)
   * via the sign card's real field branch, dialog paths injected. */
  signCanvasField: (params: {
    fieldName: string;
    pfxPath?: string;
    keyPath?: string;
    certPath?: string;
    password: string;
    output: string;
    reason?: string;
    location?: string;
  }) => Promise<{
    signer: string | null;
    output: string;
    valid: boolean;
    intact: boolean;
    covers_whole_document: boolean;
  }>;
  /** Canvas documents (id/path/name/page count), for merge-flow specs (2o).
   * Polls for the async indexer like addAnnotation — until at least
   * `expectedCount` docs are indexed (files index independently, so a
   * poll-until-any returns early while a later file is still cooking). */
  getCanvasDocs: (
    expectedCount?: number,
    timeoutMs?: number,
  ) => Promise<{ id: string; path: string; name: string; pages: number }[]>;
  /** Merge a document's pages (as copies) into the document above — the
   * header merge-up action's real path. */
  mergeDocUp: (docId: string) => void;
  /** The header ×'s real (close-guarded) remove path. */
  removeCanvasDoc: (docId: string) => void;
  /** The merge close-guard banner text, or null when not shown. */
  mergeNoticeText: () => string | null;
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
  /** Batch OCR dialog injectors (dialog must be open — `tools.batchOcr`). */
  batchOcrSetFolders: (source: string, dest: string) => Promise<void>;
  batchOcrStart: () => Promise<void>;
  batchOcrSnapshot: () => ReturnType<BatchOcrHandlers['snapshot']> | null;
  /** Edit ▸ Images (7.1; canvas must be mounted with the edit mode armed). */
  editTextPageIds: () => string[];
  editTextRuns: (
    pageId: string,
  ) => { index: number; text: string; editable: boolean; reason: string | null }[];
  editTextOpen: (pageId: string, index: number) => void;
  /** Edit ▸ Paragraphs (7.5): the paragraph layer's listing + opening the
   * REAL paragraph editor (then driven via data-testid edit-para-input). */
  editParagraphs: (
    pageId: string,
  ) => {
    index: number;
    text: string;
    lineCount: number;
    alignment: string;
    vertical: boolean;
    colors: string[];
    sizes: number[];
  }[];
  editParagraphOpen: (pageId: string, index: number) => void;
  /** Create PDF from PostScript (Phase 8; dialog must be open). */
  createPdfRun: (source: string, output: string, preset?: string) => Promise<boolean>;
  editImagePageIds: () => string[];
  editImagePlacements: (
    pageId: string,
  ) => {
    index: number;
    nested: boolean;
    matrix: number[];
    opacity: number;
    kind: string;
    crop: number[] | null;
  }[];
  editImageSelect: (pageId: string, index: number) => void;
  /** The live edit selection (C1-tail: proves the post-op auto-reselect). */
  editImageSelection: () => { kind: string; pageId: string; index: number } | null;
  /** 9.D1 vector objects: list, select, delete. */
  editVectorPageIds: () => string[];
  editVectors: (pageId: string) => {
    index: number;
    kind: 'fill' | 'stroke' | 'fillstroke';
    fill: [number, number, number] | null;
    stroke: [number, number, number] | null;
  }[];
  editVectorSelect: (pageId: string, index: number) => void;
  editVectorSelection: () => { pageId: string; index: number } | null;
  editVectorDelete: () => Promise<void>;
  /** Transform (9.C1) an image placement to an absolute user-space matrix. */
  editImageTransform: (pageId: string, index: number, matrix: number[]) => Promise<void>;
  editImageAct: (
    kind: 'delete' | 'replace' | 'extract' | 'crop' | 'opacity',
    opts?: {
      source?: { jpeg_path: string } | { raw_path: string; width: number; height: number; channels: 3 | 4 };
      outputPrefix?: string;
      rect?: [number, number, number, number];
      opacity?: number;
    },
  ) => Promise<void>;
  /** Add Image (9.C2): embed a source at a user-space rect. */
  editImageAdd: (
    page: number,
    rect: [number, number, number, number],
    source: { jpeg_path: string } | { raw_path: string; width: number; height: number; channels: 3 | 4 },
  ) => Promise<void>;
  /** Add Text (9.A2): place then author. */
  addTextPlace: (rect: { x: number; y: number; w: number; h: number }, timeoutMs?: number) => Promise<void>;
  addTextCommit: (params: {
    text: string;
    size?: number;
    color?: [number, number, number];
    family?: 'sans' | 'serif' | 'mono';
    rotate?: 0 | 90 | 180 | 270;
    bold?: boolean;
    italic?: boolean;
  }) => Promise<void>;
}

export interface TestHarnessDeps {
  openByPaths: (paths: string[]) => Promise<void>;
  setView: (view: 'welcome' | 'operations' | 'canvas') => void;
  focusTab: (tab: FocusedTab) => void;
  setActiveOp: (op: string) => void;
  setTool: (tool: string) => void;
  setDocViewMode: (mode: 'organize' | 'document') => void;
  getStateSnapshot: () => TestStateSnapshot;
  subscribe: (listener: (s: TestStateSnapshot) => void) => () => void;
  /** First page of the active file's first workspace document, once the
   * async indexer has produced one; null until then. */
  getFirstPage: () => { docId: string; pageId: string } | null;
  /** The active file's page-tier pages with their sizes, workspace order —
   * for asserting VALUES about page-level edits (M6.3: the blank page copies
   * its insertion neighbor's size). */
  getActiveDocPages: () => { id: string; width: number; height: number }[];
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
  importPagesIntoDoc: (filePath: string, toDocId: string, toIndex: number) => Promise<void>;
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
    focusTab: (tab) => deps.focusTab(tab),
    setActiveOp: (op) => deps.setActiveOp(op),
    invokeCommand: (id) => {
      if (!(id in COMMANDS)) {
        const msg = `invokeCommand: unknown command id "${id}"`;
        lastError = msg;
        throw new Error(msg);
      }
      return invokeRegisteredCommand(id as CommandId);
    },
    setTool: (tool) => deps.setTool(tool),
    setDocViewMode: (mode) => deps.setDocViewMode(mode),
    getActiveDocPages: () => deps.getActiveDocPages(),
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
    importPagesIntoDoc: async (filePath, toDocId, toIndex) => {
      try {
        await deps.importPagesIntoDoc(filePath, toDocId, toIndex);
      } catch (err) {
        captureError('importPagesIntoDoc', err);
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
    setCanvasFormValue: async (path, fieldName, value, timeoutMs = 10_000) => {
      // The forms read is async (buffer -> readFormFields -> projection);
      // poll like addAnnotation polls the indexer.
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (canvasForms?.setFieldValue(path, fieldName, value)) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    pendingFormValueCount: () => canvasForms?.pendingCount() ?? 0,
    applyCanvasFormValues: async () => {
      if (!canvasForms) {
        const msg = 'applyCanvasFormValues: canvas view not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        const failures = await canvasForms.apply();
        if (failures.length > 0) throw new Error(failures.join('; '));
      } catch (err) {
        captureError('applyCanvasFormValues', err);
        throw err;
      }
    },
    formWidgetCount: (path) => canvasForms?.widgetCountFor(path) ?? 0,
    placeNewField: async (rect, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      let placed = canvasForms?.placeNewFieldOnFirstPage(rect) ?? false;
      while (!placed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        placed = canvasForms?.placeNewFieldOnFirstPage(rect) ?? false;
      }
      if (!placed) {
        const msg = `placeNewField: no canvas page appeared within ${timeoutMs}ms`;
        lastError = msg;
        throw new Error(msg);
      }
    },
    createPlacedField: async (params) => {
      if (!canvasForms) {
        const msg = 'createPlacedField: canvas view not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await canvasForms.createPlacedField(params);
      } catch (err) {
        captureError('createPlacedField', err);
        throw err;
      }
    },
    signCanvasField: async (params) => {
      if (!canvasForms) {
        const msg = 'signCanvasField: canvas view not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        return await canvasForms.signField(params);
      } catch (err) {
        captureError('signCanvasField', err);
        throw err;
      }
    },
    getCanvasDocs: async (expectedCount = 1, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const docs = canvasMerge?.getDocs() ?? [];
        if (docs.length >= expectedCount) return docs;
        // On timeout return what's there — the caller's assert fails loudly.
        if (Date.now() >= deadline) return docs;
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    mergeDocUp: (docId) => canvasMerge?.mergeUp(docId),
    removeCanvasDoc: (docId) => canvasMerge?.removeDoc(docId),
    mergeNoticeText: () => canvasMerge?.noticeText() ?? null,
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
    batchOcrSetFolders: async (source, dest) => {
      if (!batchOcr) {
        const msg = 'batchOcrSetFolders: Batch OCR dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await batchOcr.setSource(source);
        batchOcr.setDest(dest);
      } catch (err) {
        captureError('batchOcrSetFolders', err);
        throw err;
      }
    },
    batchOcrStart: async () => {
      if (!batchOcr) {
        const msg = 'batchOcrStart: Batch OCR dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await batchOcr.start();
      } catch (err) {
        captureError('batchOcrStart', err);
        throw err;
      }
    },
    batchOcrSnapshot: () => batchOcr?.snapshot() ?? null,
    editTextPageIds: () => canvasEditImages?.textPageIds() ?? [],
    editTextRuns: (pageId) => canvasEditImages?.textRuns(pageId) ?? [],
    editTextOpen: (pageId, index) => canvasEditImages?.openTextEditor(pageId, index),
    editParagraphs: (pageId) => canvasEditImages?.paragraphs(pageId) ?? [],
    editParagraphOpen: (pageId, index) => canvasEditImages?.openParagraphEditor(pageId, index),
    createPdfRun: async (source, output, preset) => {
      if (!createPdf) {
        const msg = 'createPdfRun: dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return createPdf.run(source, output, preset);
    },
    editImagePageIds: () => canvasEditImages?.pageIds() ?? [],
    editImagePlacements: (pageId) => canvasEditImages?.placements(pageId) ?? [],
    editImageSelect: (pageId, index) => canvasEditImages?.select(pageId, index),
    editImageSelection: () => canvasEditImages?.selection() ?? null,
    editVectorPageIds: () => canvasEditImages?.vectorPageIds() ?? [],
    editVectors: (pageId) => canvasEditImages?.vectors(pageId) ?? [],
    editVectorSelect: (pageId, index) => canvasEditImages?.selectVector(pageId, index),
    editVectorSelection: () => canvasEditImages?.selectedVector() ?? null,
    editVectorDelete: async () => {
      if (!canvasEditImages) {
        const msg = 'editVectorDelete: canvas edit mode not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      await canvasEditImages.deleteSelectedVector();
    },
    editImageAct: async (kind, opts) => {
      if (!canvasEditImages) {
        const msg = 'editImageAct: canvas edit mode not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await canvasEditImages.act(kind, opts);
      } catch (err) {
        captureError('editImageAct', err);
        throw err;
      }
    },
    editImageTransform: async (pageId, index, matrix) => {
      if (!canvasEditImages) {
        const msg = 'editImageTransform: canvas edit mode not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await canvasEditImages.transformImage(pageId, index, matrix);
      } catch (err) {
        captureError('editImageTransform', err);
        throw err;
      }
    },
    editImageAdd: async (page, rect, source) => {
      if (!canvasEditImages) {
        const msg = 'editImageAdd: canvas edit mode not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await canvasEditImages.addImage(page, rect, source);
      } catch (err) {
        captureError('editImageAdd', err);
        throw err;
      }
    },
    addTextPlace: async (rect, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      let placed = canvasEditImages?.placeAddText(rect) ?? false;
      while (!placed && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        placed = canvasEditImages?.placeAddText(rect) ?? false;
      }
      if (!placed) {
        const msg = `addTextPlace: no canvas page appeared within ${timeoutMs}ms`;
        lastError = msg;
        throw new Error(msg);
      }
    },
    addTextCommit: async (params) => {
      if (!canvasEditImages) {
        const msg = 'addTextCommit: canvas edit mode not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await canvasEditImages.commitAddText(params);
      } catch (err) {
        captureError('addTextCommit', err);
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
