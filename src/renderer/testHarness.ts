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
import { app, file, engine } from './lib/tauri-bridge';
import { getRenderTimings, clearRenderTimings } from './components/canvas/raster';
import { invokeCommand as invokeRegisteredCommand, getCanvasServices } from './commands/context';
import { COMMANDS, type CommandId } from './commands/registry';
import { setAppLanguage } from './i18n';
import { getTakeoffSettings, setTakeoffSettings } from './lib/takeoff-settings';
import {
  getSymbolSets,
  getUserSymbolSets,
  reloadSymbolSets,
  removeSymbolSet,
} from './lib/symbol-library';
import { importSymbolSetFromPath } from './lib/symbol-set-io';
import type { FocusedTab } from './state/types';

export interface TestStateSnapshot {
  // Legacy projection of the tab model — kept so legacy specs'
  // assertions hold: home→'welcome', tools→'operations', doc→'canvas'.
  view: 'welcome' | 'operations' | 'canvas';
  focusedTab: FocusedTab;
  activeOp: string;
  /** The armed canvas mode (the secondary toolbar reads it). */
  tool: string;
  /** The OPEN tool, if any. */
  activeToolId: string | null;
  /** Which document pane is showing (the View menu's mode items). */
  docViewMode: 'organize' | 'document';
  /** Split view (I.6, Window ▸ Split): two stacked reading panes. */
  splitView: boolean;
  /** The full split shape ('off' | 'two' | 'quad'); splitView stays the
   * boolean projection so pre-quad specs' truthy checks hold. */
  splitMode: 'off' | 'two' | 'quad';
  /** The page being read (tracking) — insertion anchors hang off it. */
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
  /** ink only: per-pen-lift paths. An ink given `points` instead is
   *  normalized to one stroke, so legacy specs keep working. */
  strokes?: number[][];
  /** stamp only: a custom image stamp's data URL. */
  imageData?: string;
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
  /** Persist the pending marks as the file's /Redact set. */
  save: () => Promise<string[]>;
  clear: () => void;
  count: () => number;
}

let canvasRedaction: CanvasRedactionHandlers | null = null;

export function registerCanvasRedaction(handlers: CanvasRedactionHandlers | null): void {
  canvasRedaction = handlers;
}

/**
 * Visible-signature placement is likewise transient canvas state. The
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

/**
 * Crop draw. The band-to-insets ARITHMETIC has direct vitest coverage,
 * but the wiring either side of it — canvas handler resolves the page
 * geometry, publishes on the module channel, dock panel subscribes and fills
 * its fields — has none, because there is no DOM test environment. That
 * whole path is hand-written, so it gets driven here for real instead of
 * being assumed: same shape as the signature placement, which exists for the
 * same reason.
 */
export interface CanvasCropHandlers {
  drawOnFirstPage: (rect: { x: number; y: number; w: number; h: number }) => boolean;
}

let canvasCrop: CanvasCropHandlers | null = null;

export function registerCanvasCrop(handlers: CanvasCropHandlers | null): void {
  canvasCrop = handlers;
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
 * Batch OCR: the dialog's folder pickers are native and not
 * WebDriver-drivable, so the dialog registers path injectors that run the
 * SAME selectSource/setDest/start flow the buttons run. A spec opens the
 * dialog (`tools.batchOcr`), injects fixture folders, starts, then polls
 * `snapshot()` until phase === 'done' and asserts on the report.
 */
export interface BatchOcrHandlers {
  setSource: (path: string) => Promise<void>;
  setDest: (path: string) => void;
  /** The opt-in filing options. Native folder pickers
   * are not WebDriver-drivable, so the spec injects the roots the same way it
   * injects source/dest; the checkboxes ARE drivable and the spec clicks them. */
  setFiling: (filing: { movedRoot?: string | null; errorRoot?: string | null }) => void;
  start: () => Promise<void>;
  snapshot: () => {
    phase: 'setup' | 'running' | 'done';
    fileCount: number | null;
    report: {
      cancelled: boolean;
      results: {
        rel: string;
        status: string;
        pagesOcrd?: number;
        reason?: string;
        movedTo?: string;
        moveError?: string;
        repaired?: boolean;
        repairedOriginalReplaced?: boolean;
      }[];
      skippedDirs: string[];
    } | null;
    /** Full path of the log this run wrote, or null (logging off / write
     * failed). The spec reads the file back to prove the run left a
     * durable record, not just a dialog that once said so. */
    logPath: string | null;
  };
}

/** Scheduled batch runs. The native folder pickers are
 * not WebDriver-drivable, so a spec injects a whole profile through the SAME
 * create path the form uses, then lists and deletes through the same commands. */
export interface ScheduledRunsHandlers {
  /** `actionJson` = the frozen guided-action `{name, steps}` body for
   * runType 'action' profiles. */
  create: (profile: Record<string, unknown>, actionJson?: string) => Promise<string>;
  list: () => Promise<unknown[]>;
  remove: (name: string) => Promise<void>;
}

let scheduledRuns: ScheduledRunsHandlers | null = null;

export function registerScheduledRuns(handlers: ScheduledRunsHandlers | null): void {
  scheduledRuns = handlers;
}

/** Watched folders. The dialog's folder pickers are native, so a spec
 * injects a whole entry through the SAME upsert path the form uses. */
export interface WatchedFoldersHandlers {
  create: (folder: Record<string, unknown>) => Promise<void>;
  list: () => Promise<unknown[]>;
  remove: (id: string) => Promise<void>;
}

let watchedFolders: WatchedFoldersHandlers | null = null;

export function registerWatchedFolders(handlers: WatchedFoldersHandlers | null): void {
  watchedFolders = handlers;
}

let batchOcr: BatchOcrHandlers | null = null;

export function registerBatchOcr(handlers: BatchOcrHandlers | null): void {
  batchOcr = handlers;
}

/**
 * Disk-scope Search & Redact. The folder pickers are native, so a spec
 * injects source and destination into the same selection flow the buttons
 * run, then drives the same search and apply the buttons call. `check` takes
 * hit keys from the snapshot, which is what lets a spec redact a SUBSET and
 * prove the unchecked hits survived.
 */
export interface DiskRedactHandlers {
  setSource: (path: string) => Promise<void>;
  setDest: (path: string) => void;
  setQuery: (text: string) => void;
  /** The query travels with the call: setting the field and starting the
   * search in one round trip leaves no render in between for state to land. */
  search: (query: string) => Promise<void>;
  check: (keys: string[]) => void;
  apply: () => Promise<void>;
  snapshot: () => {
    phase: 'setup' | 'searching' | 'review' | 'applying' | 'done';
    fileCount: number | null;
    /** Every hit key the run may act on, in file then page then hit order. */
    hitKeys: string[];
    files: { rel: string; hits: number; skipReason: string | null }[] | null;
    report: {
      cancelled: boolean;
      results: { rel: string; status: string; regions?: number; reason?: string }[];
      skippedDirs: string[];
    } | null;
    logPath: string | null;
  };
}

let diskRedact: DiskRedactHandlers | null = null;

export function registerDiskRedact(handlers: DiskRedactHandlers | null): void {
  diskRedact = handlers;
}

/**
 * Folder form preparation: the folder pickers are native dialogs, so e2e
 * injects the paths into the same flow the buttons run and then drives the
 * REAL detect and apply. `check` takes candidate keys from the snapshot,
 * which is what lets a spec accept a SUBSET and prove the rest were not
 * created.
 */
export interface FormPrepHandlers {
  setSource: (path: string) => Promise<void>;
  setDest: (path: string) => void;
  detect: () => Promise<void>;
  check: (keys: string[]) => void;
  apply: () => Promise<void>;
  snapshot: () => {
    phase: 'setup' | 'detecting' | 'review' | 'applying' | 'done';
    fileCount: number | null;
    /** Every candidate key the run may act on, in file then detection order. */
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
  };
}

let formPrep: FormPrepHandlers | null = null;

export function registerFormPrep(handlers: FormPrepHandlers | null): void {
  formPrep = handlers;
}

/**
 * Folder-scope export: the folder pickers are native dialogs, so e2e injects
 * the paths into the same flow the buttons run and then drives the REAL sweep.
 * There is no review step to drive — the run's per-file rows ARE its result.
 */
export interface FolderExportHandlers {
  setSource: (path: string) => Promise<void>;
  setDest: (path: string) => void;
  setFormat: (format: string) => void;
  run: () => Promise<void>;
  snapshot: () => {
    phase: 'setup' | 'running' | 'done';
    fileCount: number | null;
    report: {
      cancelled: boolean;
      results: { rel: string; status: string; out?: string; produced?: string; reason?: string }[];
      skippedDirs: string[];
    } | null;
    logPath: string | null;
  };
}

let folderExport: FolderExportHandlers | null = null;

export function registerFolderExport(handlers: FolderExportHandlers | null): void {
  folderExport = handlers;
}

import type { Orientation as CreatePdfOrientation, PageSize as CreatePdfPageSize } from './lib/create-pdf';

/**
 * Create PDF: the source and output pickers are native dialogs — e2e
 * injects the source LIST and runs the REAL conversion path.
 *
 * A source of `'__blank__'` adds a blank page member, which is the one source
 * that has no path to inject. The injected list goes through the SAME
 * `addPaths` the picker's result does, so an injected run and a clicked one
 * cannot diverge.
 */
export interface CreatePdfRunOptions {
  pageSize?: CreatePdfPageSize;
  orientation?: CreatePdfOrientation;
  marginPt?: number;
  preset?: string;
}

export interface CreatePdfHandlers {
  run: (
    sources: string[],
    output: string,
    options?: CreatePdfRunOptions,
  ) => Promise<{ output: string; pages: number } | null>;
}

let createPdf: CreatePdfHandlers | null = null;

export function registerCreatePdf(handlers: CreatePdfHandlers | null): void {
  createPdf = handlers;
}

/**
 * Combine Files: same shape and the same reason — the source
 * picker and the save dialog are native, so e2e injects the LIST and the
 * output and the REAL assembly runs.
 *
 * `ranges` is positional against `sources`, so a range can be set on a member
 * without driving a text input; `target: 'append'` sends the result into an
 * open document instead of a new file (and then `output` is ignored).
 */
export interface CombineRunOptions {
  target?: 'new' | 'append';
  /** Which open document an append lands in; defaults to the dialog's own
   * current selection. */
  docId?: string;
  /** Output path for a `new` run — the dialog fills this from the save
   * dialog when a human drives it. */
  output?: string;
  /** Per-source page ranges, positional. `null`/absent means every page. */
  ranges?: (string | null)[];
}

export interface CombineHandlers {
  run: (
    sources: string[],
    output: string,
    options?: CombineRunOptions,
  ) => Promise<{ output: string; pages: number } | null>;
}

let combine: CombineHandlers | null = null;

export function registerCombine(handlers: CombineHandlers | null): void {
  combine = handlers;
}

/**
 * Compress panel: the save dialog is native and undrivable, so e2e sets
 * the panel's REAL controls and runs the REAL engine call with an injected
 * output path — the createPdfRun precedent. `setQuality` goes through the
 * panel's own change handler, so the DPI/MRC branch it drives is the branch a
 * click drives.
 */
export interface CompressHandlers {
  run: (output: string) => Promise<string>;
  setQuality: (quality: string) => void;
  setMrcPreset: (preset: string) => void;
  setVerifyText: (on: boolean) => void;
  /** What the panel currently HAS. The run reads panel state, so the harness
   * waits on this rather than on a timer — a fixed sleep between the setters
   * and the run is a race that fails on a slow machine and passes on a fast
   * one, which is the worst kind of flake. */
  snapshot: () => { quality: string; mrcPreset: string; verifyText: boolean };
}

let compress: CompressHandlers | null = null;

export function registerCompress(handlers: CompressHandlers | null): void {
  compress = handlers;
}

/**
 * Trap Presets: the PostScript export's save dialog is native, so e2e injects
 * the destination and the panel's OWN state drives everything else — the same
 * shape the compress bridge uses, and for the same reason.
 */
export interface TrapPresetHandlers {
  exportPostscript: (output: string) => Promise<unknown>;
}

let trapPresets: TrapPresetHandlers | null = null;

export function registerTrapPresets(handlers: TrapPresetHandlers | null): void {
  trapPresets = handlers;
}

/**
 * Export Pages as Images: the save dialog is native — e2e injects the
 * destination and runs the REAL gated export path the Export button runs.
 */
export interface ExportImagesHandlers {
  run: (
    out: string,
    opts?: { format?: string; dpi?: number; pages?: string; gray?: boolean },
  ) => Promise<unknown>;
}

let exportImages: ExportImagesHandlers | null = null;

export function registerExportImages(handlers: ExportImagesHandlers | null): void {
  exportImages = handlers;
}

/**
 * Portfolio panel bridges: the member pickers and save dialogs are
 * NATIVE and undrivable — e2e injects the paths and runs the REAL panel
 * flows (create routes callRaw+openPath; add/update/save run the gated
 * snapshot→call→reload shape). The panel registers while mounted — which
 * the portfolio auto-open story provides for an opened portfolio.
 */
export interface PortfolioHandlers {
  create: (output: string, sources: string[], title?: string) => Promise<unknown>;
  add: (source: string) => Promise<unknown>;
  update: (name: string, source: string) => Promise<unknown>;
  saveMember: (name: string, output: string) => Promise<unknown>;
}

let portfolioHandlers: PortfolioHandlers | null = null;

export function registerPortfolioHandlers(handlers: PortfolioHandlers | null): void {
  portfolioHandlers = handlers;
}

/**
 * Guided-actions bridge: a TERMINAL step's output is a NATIVE save
 * dialog — e2e injects the path and any ask-at-run values, then the REAL
 * runner executes (same executeRun the Run button uses). Panel must be
 * mounted.
 */
export interface GuidedActionsHandlers {
  runWithOutput: (
    actionId: string,
    values: Record<number, Record<string, string | number>>,
    output: string,
  ) => Promise<void>;
  /** FOLDER mode with injected source/dest (the pickers are native).
   * `inPlace`: dest is ignored and the ORIGINALS are replaced. */
  runFolder: (
    actionId: string,
    values: Record<number, Record<string, string | number>>,
    source: string,
    dest: string,
    inPlace?: boolean,
  ) => Promise<void>;
  /** Slice 4: write one action to `path` (the `{name, steps}` file shape). */
  exportToPath: (actionId: string, path: string) => Promise<void>;
  /** Slice 4: import an action file; rejects with the named refusal. */
  importFromPath: (path: string) => Promise<void>;
}

let guidedActionsHandlers: GuidedActionsHandlers | null = null;

export function registerGuidedActionsHandlers(handlers: GuidedActionsHandlers | null): void {
  guidedActionsHandlers = handlers;
}

/**
 * Edit ▸ Images: placements live in transformed canvas space and the
 * Replace/Extract actions pop NATIVE dialogs — both undrivable by WebDriver.
 * The canvas registers its real selection + action paths; `act`'s opts
 * inject what the dialogs would have collected (the signing precedent).
 */
export interface CanvasEditImagesHandlers {
  /** Page ids that currently have listed placements (edit mode armed). */
  pageIds: () => string[];
  /** Page ids whose snap geometry has landed. */
  snapGeometryPageIds: () => string[];
  snapGeometry: (pageId: string) => { subpaths: number[][]; closed: boolean[] }[];
  /** The live ruler guides, in the frame each was drawn in. */
  guides: () => {
    id: string;
    pageId: string;
    axis: 'x' | 'y';
    pos: number;
    rotationAtDraw: 0 | 90 | 180 | 270;
  }[];
  /** False while a listing pass is in flight — the maps are keyed by
   * generation-tagged page ids and a rebuild empties them until the fresh
   * per-page engine round-trips land, so "empty" alone proves nothing. */
  listingSettled: () => boolean;
  placements: (
    pageId: string,
  ) => {
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
  }[];
  select: (pageId: string, index: number, additive?: boolean) => void;
  /** Transform the selected image via the real commit path. */
  transformImage: (pageId: string, index: number, matrix: number[]) => Promise<void>;
  /** Multi-select: group transform via the ONE multi engine op. */
  transformImages: (
    pageId: string,
    targets: { index: number; matrix: number[] }[],
  ) => Promise<void>;
  /** Delete the whole current selection (routes the group op at N>1). */
  deleteSelected: () => Promise<void>;
  /** Add Image: embed a source at a user-space rect via the real
   * commit path (the native file picker is undrivable — inject the source).
   * rect=null with `at` = the natural-size click-place. */
  addImage: (
    page: number,
    rect: [number, number, number, number] | null,
    source:
      | { jpeg_path: string }
      | { raw_path: string; width: number; height: number; channels: 3 | 4 }
      | { svg_path: string },
    at?: [number, number],
  ) => Promise<void>;
  selection: () =>
    | { kind: 'image'; pageId: string; index: number; indexes: number[] }
    | { kind: 'text' | 'para'; pageId: string; index: number }
    | null;
  /** Text runs: listing + opening the REAL inline editor (the input
   * itself is then driven through the DOM — data-testid edit-text-input). */
  textRuns: (
    pageId: string,
  ) => { index: number; text: string; editable: boolean; reason: string | null }[];
  textPageIds: () => string[];
  openTextEditor: (pageId: string, index: number) => void;
  /** Paragraph layer. */
  paragraphs: (
    pageId: string,
  ) => {
    index: number;
    text: string;
    lineCount: number;
    alignment: string;
    vertical: boolean;
    /** The frame the paragraph's layout ran in (horizontal /
     * vertical-rl / rotated-cw / rotated-ccw / rotated-180). */
    orientation: string;
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
  ) => Promise<void>;
  /** Add Text: place a box on the active file's first page (the band
   * lives in transformed canvas space — undrivable), then author via the REAL
   * display→PDF + engine-op path. */
  placeAddText: (rect: { x: number; y: number; w: number; h: number }) => boolean;
  commitAddText: (params: {
    text: string;
    size?: number;
    color?: [number, number, number];
    family?: 'sans' | 'serif' | 'mono';
    rotate?: number;
    bold?: boolean;
    italic?: boolean;
    smallCaps?: boolean;
    alternates?: boolean;
    altIndex?: number;
  }) => Promise<void>;
  // Vector objects.
  vectorPageIds: () => string[];
  vectors: (pageId: string) => {
    index: number;
    kind: 'fill' | 'stroke' | 'fillstroke' | 'shading';
    fill: [number, number, number] | null;
    stroke: [number, number, number] | null;
    lineWidth: number;
    nested: boolean;
    userRect: [number, number, number, number];
  }[];
  selectVector: (pageId: string, index: number) => void;
  selectedVector: () => { pageId: string; index: number } | null;
  deleteSelectedVector: () => Promise<void>;
  transformVector: (pageId: string, index: number, matrix: number[]) => Promise<void>;
  restyleVector: (
    pageId: string,
    index: number,
    opts: {
      fill?: [number, number, number];
      stroke?: [number, number, number];
      lineWidth?: number;
    },
  ) => Promise<void>;
}

let canvasEditImages: CanvasEditImagesHandlers | null = null;

export function registerCanvasEditImages(handlers: CanvasEditImagesHandlers | null): void {
  canvasEditImages = handlers;
}

/**
 * Multi-select is local canvas view state, and both modifier-click
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
 * Outline sidebar reorder is a pointer-capture tree drag, not
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
 * On-canvas form fill: the overlay inputs live inside transformed
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
  // Add-field authoring — place on the active file's first page
  // (display-normalized rect), then create through the REAL conversion +
  // whole-file-op flow the card's Create button runs.
  placeNewFieldOnFirstPage: (rect: { x: number; y: number; w: number; h: number }) => boolean;
  createPlacedField: (params: {
    name: string;
    type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist' | 'signature';
    options?: string[];
    multiline?: boolean;
    lock?: { action: 'all' | 'include' | 'exclude' | null; fields: string[] };
  }) => Promise<void>;
  // Sign into an existing empty signature field of the ACTIVE file —
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
 * Canvas whole-document merge: the header hover actions sit inside the
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
/** What a read-only verify reports to a spec: the counts, plus the
 * document-level certification and each signature's policy verdict — the
 * shape the two signature surfaces render. */
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

export interface SignHandler {
  sign: (params: {
    // Signer source: a .pfx path, OR a PEM key+cert pair.
    pfxPath?: string;
    keyPath?: string;
    certPath?: string;
    password: string;
    output: string;
    reason?: string;
    location?: string;
    // Visible-stamp placement — engine convention: 1-based page, PDF
    // user-space rect.
    appearance?: { page: number; rect: [number, number, number, number] };
    /** PAdES (ETSI.CAdES.detached) profile. */
    pades?: boolean;
    /** Apply an author (certification) signature at this level. */
    certify?: boolean;
    certifyLevel?: 'none' | 'form-fill' | 'annotate';
    /** Lock form fields against further change after signing. */
    lock?: 'all' | 'include' | 'exclude';
    lockFields?: string[];
  }) => Promise<{
    output: string;
    signer: string | null;
    valid: boolean;
    intact: boolean;
    covers_whole_document: boolean;
    certified?: boolean;
    certification_level?: string | null;
    lock?: string | null;
    lock_fields?: string[];
  }>;
  // Sign the ACTIVE document in place (undoable performOperation flow);
  // no output path. Returns the post-sign verification summary.
  signInPlace: (params: {
    pfxPath?: string;
    keyPath?: string;
    certPath?: string;
    password: string;
    reason?: string;
    location?: string;
    certify?: boolean;
    certifyLevel?: 'none' | 'form-fill' | 'annotate';
    lock?: 'all' | 'include' | 'exclude';
    lockFields?: string[];
  }) => Promise<{ signature_count: number; all_valid: boolean }>;
  // Verify the active working copy's signatures (read-only) — lets an
  // e2e confirm an undo restored the pre-sign, unsigned state.
  verifyActive: () => Promise<SignatureVerifySnapshot>;
}

let signHandler: SignHandler | null = null;

export function registerSignHandler(handler: SignHandler | null): void {
  signHandler = handler;
}

/** The Document JavaScript panel's harness hooks (set in place via the
 * undoable flow; read the active working copy). */
export interface DocumentJsHandler {
  set: (scripts: { name: string; js: string }[]) => Promise<void>;
  list: () => Promise<{ name: string; js: string }[]>;
}

let documentJsHandler: DocumentJsHandler | null = null;

export function registerDocumentJsHandler(handler: DocumentJsHandler | null): void {
  documentJsHandler = handler;
}

export interface TestHarness {
  /** Open one or more PDFs by absolute path, bypassing the OS dialog. */
  openByPaths: (paths: string[]) => Promise<void>;
  /** Save the active working copy to a known destination, no dialog. */
  saveActiveAs: (destPath: string) => Promise<void>;
  /** Send To ▸ Email's STAGING half: copy the active working file into the
   * send-to scratch under its real name and return the staged path. The
   * MAPI launch half is deliberately not bridged — it opens a real compose
   * window on boxes with a mail client. */
  sendToEmailStage: () => Promise<string>;
  /** Export the active document to `destPath` in `format` via the engine
   *  (bypasses the native save dialog). Returns the engine result. */
  exportActiveAs: (destPath: string, format: string, options?: Record<string, unknown>) => Promise<unknown>;
  /** The detected tables under review: what the panel lists and the page
   *  draws, as data a spec can assert on. */
  tableReviewList: () => {
    id: string; page: number; caption: string | null; columns: number[]; rows: number;
    cells: number; accepted: boolean;
  }[];
  /** Accept or reject one table. */
  tableReviewToggle: (regionId: string) => void;
  /** Move one column boundary to `fraction` of the table's own width. A
   *  pointer drag on a two-pixel rule is not reliably WebDriver-drivable, so
   *  the gesture's RESULT is bridged rather than the gesture. */
  tableReviewMoveColumn: (regionId: string, index: number, fraction: number) => void;
  /** Write the accepted tables to `destPath` (bypasses the native save
   *  dialog). Returns the engine result. */
  tableReviewExport: (
    destPath: string,
    options?: { sheetPer?: string; includeUntabled?: boolean },
  ) => Promise<unknown>;
  /** Switch the main view (legacy — maps onto the tab model: welcome→Home,
   * operations→Tools, canvas→the active/first document's tab). */
  setView: (view: 'welcome' | 'operations' | 'canvas') => void;
  /** Focus a tab directly: 'home' | 'tools' | { doc: path }. */
  focusTab: (tab: FocusedTab) => void;
  /** Select an operation in the sidebar. */
  setActiveOp: (op: string) => void;
  /** Invoke a command-registry entry — the ONE entry point the menus,
   * toolbars and keymap share. Returns false when the command's
   * enablement predicate refused; throws on an unknown id. */
  invokeCommand: (id: string) => boolean;
  /** Arm a canvas interaction tool directly (absolute set, no pill toggle). */
  setTool: (tool: string) => void;
  /** Choose the document pane's view (absolute set, no pill toggle). A document
   * opens in 'document' (the reading view), so a spec that drives
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
   * pointer-drag simulation because WebDriver cannot reliably drive the
   * canvas tools' pointer-capture behavior. Polls for the
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
  ) => Promise<{
    docId: string;
    pageId: string;
    annotationId: string;
    kind: string;
    color: string;
    note?: string;
    /** textmarkup only: the style, and how many quads it carries. */
    markupType?: string;
    quadCount?: number;
    /** ink only: how many pen strokes it carries. */
    strokeCount?: number;
    /** stamp only: whether it carries a custom image. */
    hasImage?: boolean;
  } | null>;
  /** Every pending annotation on one page, workspace order (= z-order) —
   * geometry assertions for the manipulation gestures (rung 1). */
  getPageAnnotations: (
    docId: string,
    pageId: string,
  ) => { id: string; kind: string; x: number; y: number; w: number; h: number; color: string; note?: string; shapeType?: string; strokeWidth?: number; fillColor?: string; opacity?: number; points?: number[]; countGroup?: string; countSymbol?: string; countSeq?: number; symbolId?: string; symbolParts?: number }[];
  /** Materialize pending page-tier edits (annotations, moves, etc.) via the
   * real commit bridge — same path as the "Apply changes" button. */
  commitPendingEdits: () => Promise<void>;
  /** Test-only: close every open file so a spec starts from a clean
   * workspace (multi-select is workspace-wide, so accumulated files across
   * cases would otherwise cross-contaminate select-all). */
  closeAllFiles: () => void;
  /** Import a file's pages into a document at an index — the same path
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
  /** Completed pdf.js render durations (base + detail rasters). */
  getRenderTimings: () => { kind: string; pageNumber: number; ms: number }[];
  clearRenderTimings: () => void;
  /** Persist the pending marks as the file's /Redact set (the status
   * bar's Save-marks path). */
  saveRedactionMarks: () => Promise<void>;
  /** Place a visible-signature box on the active file's first canvas page
   * (display-normalized rect), waiting for the canvas + indexer like
   * addRedactionMark. */
  /** Drive the crop band the canvas gesture produces. */
  drawCropRect: (
    rect: { x: number; y: number; w: number; h: number },
    timeoutMs?: number,
  ) => Promise<void>;
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
  /** Select a set of canvas page ids — bypasses modifier-click pointer
   * simulation. Canvas view must be mounted. */
  selectCanvasPages: (pageIds: string[]) => void;
  /** The currently selected canvas page ids. */
  getSelectedCanvasPageIds: () => string[];
  /** Workspace-flattened page ids in order (the select-all / range basis). */
  getWorkspacePageIds: () => string[];
  /** The active file's page-tier pages with sizes (value assertions). */
  getActiveDocPages: () => { id: string; width: number; height: number }[];
  /** Delete the current canvas selection via the same batched path Delete runs
   * (DELETE_PAGE_REFS → page tier). Canvas view must be mounted. */
  deleteSelectedCanvasPages: () => void;
  /** Rotate the current canvas selection ±90 via the batched path (`[`/`]`). */
  rotateSelectedCanvasPages: (delta: 90 | 270) => void;
  /** Flattened outline rows (title/depth/page) the bookmarks surface shows.
   * The nav-pane Bookmarks panel must be mounted (navicon-bookmarks). */
  getOutlineOrder: () => { title: string; depth: number; page: number | null }[];
  /** Reorder an outline node via the exact drop path (moveOutlineNode ->
   * set_outline -> UPDATE_FILE); resolves after the save. */
  reorderOutline: (fromPath: number[], overIndex: number, depth: number) => Promise<void>;
  /** Set a pending on-canvas form value for a field of an open file
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
  /** Place a new-field box on the active file's first canvas page,
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
    lock?: { action: 'all' | 'include' | 'exclude' | null; fields: string[] };
  }) => Promise<void>;
  /** Sign into an existing empty signature field of the active file
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
  /** Canvas documents (id/path/name/page count), for merge-flow specs.
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
    pades?: boolean;
    certify?: boolean;
    certifyLevel?: 'none' | 'form-fill' | 'annotate';
  }) => Promise<{
    output: string;
    signer: string | null;
    valid: boolean;
    intact: boolean;
    covers_whole_document: boolean;
    certified?: boolean;
    certification_level?: string | null;
  }>;
  /** Sign the active document IN PLACE (undoable); no output path. */
  signActiveFileInPlace: (params: {
    pfxPath?: string;
    keyPath?: string;
    certPath?: string;
    password: string;
    reason?: string;
    location?: string;
    certify?: boolean;
    certifyLevel?: 'none' | 'form-fill' | 'annotate';
  }) => Promise<{ signature_count: number; all_valid: boolean }>;
  /** Read-only signature verify of the active working copy, including the
   * document-level certification and each signature's policy verdict. */
  verifyActiveSignatures: () => Promise<SignatureVerifySnapshot>;
  /** Set the active document's JavaScript (undoable), and read it back. */
  documentJsSet: (scripts: { name: string; js: string }[]) => Promise<void>;
  documentJsList: () => Promise<{ name: string; js: string }[]>;
  /** Batch OCR dialog injectors (dialog must be open — `tools.batchOcr`). */
  batchOcrSetFolders: (source: string, dest: string) => Promise<void>;
  batchOcrSetFiling: (filing: { movedRoot?: string | null; errorRoot?: string | null }) => void;
  batchOcrStart: () => Promise<void>;
  batchOcrSnapshot: () => ReturnType<BatchOcrHandlers['snapshot']> | null;
  /** Search & Redact folder injectors (dialog must be open —
   * `tools.diskRedact`). */
  diskRedactSetFolders: (source: string, dest: string) => Promise<void>;
  diskRedactSearch: (query: string) => Promise<void>;
  diskRedactCheck: (keys: string[]) => void;
  diskRedactApply: () => Promise<void>;
  diskRedactSnapshot: () => ReturnType<DiskRedactHandlers['snapshot']> | null;
  /** Folder form preparation injectors (dialog must be open —
   * `tools.formPrepFolder`). */
  formPrepSetFolders: (source: string, dest: string) => Promise<void>;
  formPrepDetect: () => Promise<void>;
  formPrepCheck: (keys: string[]) => void;
  formPrepApply: () => Promise<void>;
  formPrepSnapshot: () => ReturnType<FormPrepHandlers['snapshot']> | null;
  /** Folder-scope export injectors (dialog must be open —
   * `tools.folderExport`). */
  folderExportSetFolders: (source: string, dest: string) => Promise<void>;
  folderExportSetFormat: (format: string) => void;
  folderExportRun: () => Promise<void>;
  folderExportSnapshot: () => ReturnType<FolderExportHandlers['snapshot']> | null;
  scheduleCreate: (profile: Record<string, unknown>, actionJson?: string) => Promise<string>;
  scheduleList: () => Promise<unknown[]>;
  scheduleRemove: (name: string) => Promise<void>;
  /** Watched folders (dialog must be open — `tools.watchedFolders`). */
  watcherCreate: (folder: Record<string, unknown>) => Promise<void>;
  watcherList: () => Promise<unknown[]>;
  watcherRemove: (id: string) => Promise<void>;
  /** Switch the live UI language ('qps' included — the pseudo-locale
   * only exists under VITE_E2E/DEV, which is the only place this harness
   * compiles in). Does NOT touch the persisted preference. */
  setLanguage: (lang: string) => void;
  /** Edit ▸ Images (canvas must be mounted with the edit mode armed). */
  editTextPageIds: () => string[];
  editTextRuns: (
    pageId: string,
  ) => { index: number; text: string; editable: boolean; reason: string | null }[];
  editTextOpen: (pageId: string, index: number) => void;
  /** Edit ▸ Paragraphs: the paragraph layer's listing + opening the
   * REAL paragraph editor (then driven via data-testid edit-para-input). */
  editParagraphs: (
    pageId: string,
  ) => {
    index: number;
    text: string;
    lineCount: number;
    alignment: string;
    vertical: boolean;
    /** The frame the paragraph's layout ran in (horizontal /
     * vertical-rl / rotated-cw / rotated-ccw / rotated-180). */
    orientation: string;
    colors: string[];
    sizes: number[];
  }[];
  editParagraphOpen: (pageId: string, index: number) => void;
  /** Create PDF (dialog must be open). `'__blank__'` in `sources` adds a
   * blank page. Null result = the conversion failed and the dialog shows why. */
  createPdfRun: (
    sources: string[],
    output: string,
    options?: CreatePdfRunOptions,
  ) => Promise<{ output: string; pages: number } | null>;
  /** Combine Files (dialog must be open). For `target: 'append'`
   * the result's `output` is empty and `pages` is what was imported. */
  combineRun: (
    sources: string[],
    output: string,
    options?: CombineRunOptions,
  ) => Promise<{ output: string; pages: number } | null>;
  /** Compress panel (panel must be mounted). Sets the panel's own
   * controls, then runs the real engine call with an injected output path. */
  compressRun: (
    output: string,
    opts?: { quality?: string; mrcPreset?: string; verifyText?: boolean },
  ) => Promise<string>;
  /** Trap Presets PostScript export (panel must be mounted). Runs the real
   * engine call the Export button runs, with an injected output path. */
  trapExportPostscript: (output: string) => Promise<unknown>;
  /** Export pages as images (dialog must be open). Null result = failed
   *  (the dialog shows the error); non-null = the engine result. */
  exportImagesRun: (
    out: string,
    opts?: { format?: string; dpi?: number; pages?: string; gray?: boolean },
  ) => Promise<unknown>;
  /** Guided-actions run with an injected terminal output path (panel must
   * be mounted; values keyed by step index carry ask-at-run params). */
  guidedRunWithOutput: (
    actionId: string,
    values: Record<number, Record<string, string | number>>,
    output: string,
  ) => Promise<void>;
  /** Guided-actions FOLDER run with injected source/dest paths. `inPlace`
   * replaces the originals — dest is ignored. */
  guidedRunFolder: (
    actionId: string,
    values: Record<number, Record<string, string | number>>,
    source: string,
    dest: string,
    inPlace?: boolean,
  ) => Promise<void>;
  /** Guided-actions export/import with injected paths (the dialogs are
   * native). Import rejects with the named refusal for malformed files. */
  guidedExportToPath: (actionId: string, path: string) => Promise<void>;
  guidedImportFromPath: (path: string) => Promise<void>;
  /** Portfolio flows with injected paths (panel must be mounted). */
  portfolioCreateRun: (output: string, sources: string[], title?: string) => Promise<unknown>;
  portfolioAddRun: (source: string) => Promise<unknown>;
  portfolioUpdateRun: (name: string, source: string) => Promise<unknown>;
  portfolioSaveMemberRun: (name: string, output: string) => Promise<unknown>;
  editImagePageIds: () => string[];
  /** Whether the edit-listing pass has settled — pair it with
   * `editImagePageIds()` before concluding a page has no images. */
  editImageListingSettled: () => boolean;
  editImagePlacements: (
    pageId: string,
  ) => {
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
  }[];
  editImageSelect: (pageId: string, index: number, additive?: boolean) => void;
  /** The live edit selection (proves the post-op auto-reselect).
   * The image arm also reports `indexes` (the whole group). */
  editImageSelection: () => {
    kind: string;
    pageId: string;
    index: number;
    indexes?: number[];
  } | null;
  /** Multi-select: group transform (one multi op) + delete-selection. */
  editImageTransformMany: (
    pageId: string,
    targets: { index: number; matrix: number[] }[],
  ) => Promise<void>;
  editImageDeleteSelected: () => Promise<void>;
  /** Page ids whose SNAP geometry has landed. Snapping is
   * fetched asynchronously per page, and "no snap happened" is both "there
   * was nothing in range" and "the listing hasn't arrived yet" — the
   * `listingSettled` lesson, same shape. A spec waits on this before
   * asserting a snap. */
  snapGeometryPageIds: () => string[];
  /** One page's snap geometry, display-normalized. A page with
   * an entry but ZERO paths is a settled EMPTY listing, which is a different
   * thing from "not fetched yet" — the spec waits for paths, not for keys. */
  snapGeometry: (pageId: string) => { subpaths: number[][]; closed: boolean[] }[];
  /** The ruler GUIDES currently on the document, in the frame
   * each was drawn in. Read-back only — spec 106 drags them off the real
   * ruler chrome, because a harness that placed them would prove nothing
   * about the gesture. */
  guides: () => {
    id: string;
    pageId: string;
    axis: 'x' | 'y';
    pos: number;
    rotationAtDraw: 0 | 90 | 180 | 270;
  }[];
  /** Seed the count GROUPS and arm one, deterministically.
   *
   * The groups are a persisted preference (localStorage), so a spec that
   * clicked its way through the panel would inherit whatever the last run
   * left behind and its group NAMES would drift. This resets the store to a
   * known list; spec 107 still exercises the panel's own controls for the
   * things only the panel can prove (the tally, the legend). */
  takeoffSetGroups: (
    groups: { name: string; color: string; symbol: string }[],
    armed: string | null,
  ) => void;
  takeoffArmed: () => string | null;
  /** Import a symbol SET from a path — the native file picker is
   * the only step skipped, so a spec drives the real parse, the real
   * sanitizer and the real store. Rejects with the refusal message a
   * malformed file earns (the guided-actions import precedent). */
  symbolImportFromPath: (path: string) => Promise<{ id: string; outcome: string }>;
  /** Every set in the registry, built-ins included, with its symbol ids. */
  symbolSets: () => { id: string; name: string; builtin: boolean; symbols: string[] }[];
  /** Drop the imported sets and re-read the store — the cross-spec-leak rule
   * (a set left behind would change the next run's palette). */
  symbolResetSets: () => void;
  /** Vector objects: list, select, delete. */
  editVectorPageIds: () => string[];
  editVectors: (pageId: string) => {
    index: number;
    kind: 'fill' | 'stroke' | 'fillstroke' | 'shading';
    fill: [number, number, number] | null;
    stroke: [number, number, number] | null;
    lineWidth: number;
    nested: boolean;
    userRect: [number, number, number, number];
  }[];
  editVectorSelect: (pageId: string, index: number) => void;
  editVectorSelection: () => { pageId: string; index: number } | null;
  editVectorDelete: () => Promise<void>;
  /** Transform (move/resize/rotate) a vector to a target placement M'. */
  editVectorTransform: (pageId: string, index: number, matrix: number[]) => Promise<void>;
  /** Recolour / re-width a vector object. */
  editVectorRestyle: (
    pageId: string,
    index: number,
    opts: {
      fill?: [number, number, number];
      stroke?: [number, number, number];
      lineWidth?: number;
    },
  ) => Promise<void>;
  /** Transform an image placement to an absolute user-space matrix. */
  editImageTransform: (pageId: string, index: number, matrix: number[]) => Promise<void>;
  editImageAct: (
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
  ) => Promise<void>;
  /** Add Image: embed a source at a user-space rect; rect=null
   * with `at` places at natural size on the click point. */
  editImageAdd: (
    page: number,
    rect: [number, number, number, number] | null,
    source:
      | { jpeg_path: string }
      | { raw_path: string; width: number; height: number; channels: 3 | 4 }
      | { svg_path: string },
    at?: [number, number],
  ) => Promise<void>;
  /** Add Text: place then author. */
  addTextPlace: (rect: { x: number; y: number; w: number; h: number }, timeoutMs?: number) => Promise<void>;
  addTextCommit: (params: {
    text: string;
    size?: number;
    color?: [number, number, number];
    family?: 'sans' | 'serif' | 'mono';
    rotate?: number;
    bold?: boolean;
    italic?: boolean;
    smallCaps?: boolean;
    alternates?: boolean;
    altIndex?: number;
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
   * for asserting VALUES about page-level edits (the blank page copies
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
    markupType?: string;
    quadCount?: number;
    strokeCount?: number;
    hasImage?: boolean;
  } | null;
  /** Every pending annotation on one page, workspace order (= z-order) —
   * for asserting geometry after manipulation gestures (rung 1). */
  getPageAnnotations: (
    docId: string,
    pageId: string,
  ) => { id: string; kind: string; x: number; y: number; w: number; h: number; color: string; note?: string; shapeType?: string; strokeWidth?: number; fillColor?: string; opacity?: number; points?: number[]; countGroup?: string; countSymbol?: string; countSeq?: number; symbolId?: string; symbolParts?: number }[];
  dispatchAddAnnotation: (docId: string, pageId: string, annotation: TestAnnotationInput & { id: string }) => void;
  dispatchRecolorAnnotation: (docId: string, pageId: string, annotationId: string, color: string) => void;
  dispatchRemoveAnnotation: (docId: string, pageId: string, annotationId: string) => void;
  commitPendingEdits: () => Promise<void>;
  closeAllFiles: () => void;
  importPagesIntoDoc: (filePath: string, toDocId: string, toIndex: number) => Promise<void>;
  /** Export via the engine, with an explicit destination (no dialog). */
  exportActiveDocument: (destPath: string, format: string, options?: Record<string, unknown>) => Promise<unknown>;
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
    sendToEmailStage: async () => {
      const snap = deps.getStateSnapshot();
      if (!snap.activeFile) {
        const msg = 'sendToEmailStage: no active file';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        return await app.stageSendCopy(snap.activeFile.workingPath, snap.activeFile.name);
      } catch (err) {
        captureError('sendToEmailStage', err);
        throw err;
      }
    },
    tableReviewList: () =>
      (getCanvasServices()?.tableReview.list() ?? []).map((r) => ({
        id: r.id,
        page: r.page,
        caption: r.caption,
        columns: r.columns,
        rows: r.rows.length,
        cells: r.cells,
        accepted: r.accepted,
      })),
    tableReviewToggle: (regionId) => {
      const service = getCanvasServices()?.tableReview;
      if (!service) return;
      service.update(
        service.list().map((r) => (r.id === regionId ? { ...r, accepted: !r.accepted } : r)),
      );
    },
    tableReviewMoveColumn: (regionId, index, fraction) => {
      const service = getCanvasServices()?.tableReview;
      if (!service) return;
      service.update(
        service.list().map((r) => {
          if (r.id !== regionId) return r;
          const columns = [...r.columns];
          columns[index] = fraction;
          return { ...r, columns: columns.sort((a, b) => a - b) };
        }),
      );
    },
    tableReviewExport: async (destPath, options) => {
      const service = getCanvasServices()?.tableReview;
      if (!service) {
        const msg = 'tableReviewExport: the canvas is not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        return await service.exportTo(destPath, {
          sheetPer: options?.sheetPer ?? 'table',
          includeUntabled: options?.includeUntabled ?? false,
        });
      } catch (err) {
        captureError('tableReviewExport', err);
        throw err;
      }
    },
    exportActiveAs: async (destPath, format, options) => {
      const snap = deps.getStateSnapshot();
      if (!snap.activeFile) {
        const msg = 'exportActiveAs: no active file';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        return await deps.exportActiveDocument(destPath, format, options);
      } catch (err) {
        captureError('exportActiveAs', err);
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
        const normalized =
          annotation.kind === 'ink' && annotation.points && !annotation.strokes
            ? { ...annotation, strokes: [annotation.points], points: undefined }
            : annotation;
        deps.dispatchAddAnnotation(page.docId, page.pageId, { ...normalized, id: annotationId });
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
    getPageAnnotations: (docId, pageId) => deps.getPageAnnotations(docId, pageId),
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
    getRenderTimings: () => getRenderTimings(),
    clearRenderTimings: () => clearRenderTimings(),
    saveRedactionMarks: async () => {
      if (!canvasRedaction) {
        const msg = 'saveRedactionMarks: canvas view not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        const failures = await canvasRedaction.save();
        if (failures.length > 0) throw new Error(failures.join('; '));
      } catch (err) {
        captureError('saveRedactionMarks', err);
        throw err;
      }
    },
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
    drawCropRect: async (rect, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      let drawn = canvasCrop?.drawOnFirstPage(rect) ?? false;
      while (!drawn && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        drawn = canvasCrop?.drawOnFirstPage(rect) ?? false;
      }
      if (!drawn) {
        const msg = `drawCropRect: no canvas page appeared within ${timeoutMs}ms`;
        lastError = msg;
        throw new Error(msg);
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
    signActiveFileInPlace: async (params) => {
      if (!signHandler) {
        const msg = 'signActiveFileInPlace: Signatures panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        return await signHandler.signInPlace(params);
      } catch (err) {
        captureError('signActiveFileInPlace', err);
        throw err;
      }
    },
    verifyActiveSignatures: async () => {
      if (!signHandler) {
        const msg = 'verifyActiveSignatures: Signatures panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        return await signHandler.verifyActive();
      } catch (err) {
        captureError('verifyActiveSignatures', err);
        throw err;
      }
    },
    documentJsSet: async (scripts) => {
      if (!documentJsHandler) {
        const msg = 'documentJsSet: Document JavaScript panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await documentJsHandler.set(scripts);
      } catch (err) {
        captureError('documentJsSet', err);
        throw err;
      }
    },
    documentJsList: async () => {
      if (!documentJsHandler) {
        const msg = 'documentJsList: Document JavaScript panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        return await documentJsHandler.list();
      } catch (err) {
        captureError('documentJsList', err);
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
    batchOcrSetFiling: (filing) => {
      if (!batchOcr) {
        const msg = 'batchOcrSetFiling: Batch OCR dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      batchOcr.setFiling(filing);
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
    diskRedactSetFolders: async (source, dest) => {
      if (!diskRedact) {
        const msg = 'diskRedactSetFolders: Search & Redact folder dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await diskRedact.setSource(source);
        diskRedact.setDest(dest);
      } catch (err) {
        captureError('diskRedactSetFolders', err);
        throw err;
      }
    },
    diskRedactSearch: async (query) => {
      if (!diskRedact) {
        const msg = 'diskRedactSearch: Search & Redact folder dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        diskRedact.setQuery(query);
        await diskRedact.search(query);
      } catch (err) {
        captureError('diskRedactSearch', err);
        throw err;
      }
    },
    diskRedactCheck: (keys) => {
      if (!diskRedact) {
        const msg = 'diskRedactCheck: Search & Redact folder dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      diskRedact.check(keys);
    },
    diskRedactApply: async () => {
      if (!diskRedact) {
        const msg = 'diskRedactApply: Search & Redact folder dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await diskRedact.apply();
      } catch (err) {
        captureError('diskRedactApply', err);
        throw err;
      }
    },
    diskRedactSnapshot: () => diskRedact?.snapshot() ?? null,
    formPrepSetFolders: async (source, dest) => {
      if (!formPrep) {
        const msg = 'formPrepSetFolders: folder form preparation dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await formPrep.setSource(source);
        formPrep.setDest(dest);
      } catch (err) {
        captureError('formPrepSetFolders', err);
        throw err;
      }
    },
    formPrepDetect: async () => {
      if (!formPrep) {
        const msg = 'formPrepDetect: folder form preparation dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await formPrep.detect();
      } catch (err) {
        captureError('formPrepDetect', err);
        throw err;
      }
    },
    formPrepCheck: (keys) => {
      if (!formPrep) {
        const msg = 'formPrepCheck: folder form preparation dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      formPrep.check(keys);
    },
    formPrepApply: async () => {
      if (!formPrep) {
        const msg = 'formPrepApply: folder form preparation dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await formPrep.apply();
      } catch (err) {
        captureError('formPrepApply', err);
        throw err;
      }
    },
    formPrepSnapshot: () => formPrep?.snapshot() ?? null,
    folderExportSetFolders: async (source, dest) => {
      if (!folderExport) {
        const msg = 'folderExportSetFolders: folder export dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await folderExport.setSource(source);
        folderExport.setDest(dest);
      } catch (err) {
        captureError('folderExportSetFolders', err);
        throw err;
      }
    },
    folderExportSetFormat: (format) => {
      if (!folderExport) {
        const msg = 'folderExportSetFormat: folder export dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      folderExport.setFormat(format);
    },
    folderExportRun: async () => {
      if (!folderExport) {
        const msg = 'folderExportRun: folder export dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await folderExport.run();
      } catch (err) {
        captureError('folderExportRun', err);
        throw err;
      }
    },
    folderExportSnapshot: () => folderExport?.snapshot() ?? null,
    scheduleCreate: async (profile, actionJson) => {
      if (!scheduledRuns) throw new Error('scheduleCreate: Scheduled Runs dialog not mounted');
      return scheduledRuns.create(profile, actionJson);
    },
    scheduleList: async () => {
      if (!scheduledRuns) throw new Error('scheduleList: Scheduled Runs dialog not mounted');
      return scheduledRuns.list();
    },
    watcherCreate: async (folder) => {
      if (!watchedFolders) throw new Error('watcherCreate: Watched Folders dialog not mounted');
      return watchedFolders.create(folder);
    },
    watcherList: async () => {
      if (!watchedFolders) throw new Error('watcherList: Watched Folders dialog not mounted');
      return watchedFolders.list();
    },
    watcherRemove: async (id) => {
      if (!watchedFolders) throw new Error('watcherRemove: Watched Folders dialog not mounted');
      return watchedFolders.remove(id);
    },
    scheduleRemove: async (name) => {
      if (!scheduledRuns) throw new Error('scheduleRemove: Scheduled Runs dialog not mounted');
      return scheduledRuns.remove(name);
    },
    setLanguage: (lang) => setAppLanguage(lang),
    editTextPageIds: () => canvasEditImages?.textPageIds() ?? [],
    editTextRuns: (pageId) => canvasEditImages?.textRuns(pageId) ?? [],
    editTextOpen: (pageId, index) => canvasEditImages?.openTextEditor(pageId, index),
    editParagraphs: (pageId) => canvasEditImages?.paragraphs(pageId) ?? [],
    editParagraphOpen: (pageId, index) => canvasEditImages?.openParagraphEditor(pageId, index),
    createPdfRun: async (sources, output, options) => {
      if (!createPdf) {
        const msg = 'createPdfRun: dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return createPdf.run(sources, output, options);
    },
    combineRun: async (sources, output, options) => {
      if (!combine) {
        const msg = 'combineRun: dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return combine.run(sources, output, options);
    },
    compressRun: async (output, opts) => {
      if (!compress) {
        const msg = 'compressRun: panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      // Set the panel's own state, WAIT for the render that applies it, then
      // run — the run reads panel state, and a fixed sleep here would be a
      // machine-speed race.
      if (opts?.quality !== undefined) compress.setQuality(opts.quality);
      if (opts?.mrcPreset !== undefined) compress.setMrcPreset(opts.mrcPreset);
      if (opts?.verifyText !== undefined) compress.setVerifyText(opts.verifyText);
      for (let i = 0; i < 200; i++) {
        const now = compress?.snapshot();
        if (
          now &&
          (opts?.quality === undefined || now.quality === opts.quality) &&
          (opts?.mrcPreset === undefined || now.mrcPreset === opts.mrcPreset) &&
          (opts?.verifyText === undefined || now.verifyText === opts.verifyText)
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!compress) throw new Error('compressRun: panel unmounted mid-run');
      return compress.run(output);
    },
    trapExportPostscript: async (output) => {
      if (!trapPresets) {
        const msg = 'trapExportPostscript: panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return trapPresets.exportPostscript(output);
    },
    exportImagesRun: async (out, opts) => {
      if (!exportImages) {
        const msg = 'exportImagesRun: dialog not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return exportImages.run(out, opts);
    },
    guidedRunWithOutput: async (actionId, values, output) => {
      if (!guidedActionsHandlers) {
        const msg = 'guidedRunWithOutput: panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return guidedActionsHandlers.runWithOutput(actionId, values, output);
    },
    guidedRunFolder: async (actionId, values, source, dest, inPlace) => {
      if (!guidedActionsHandlers) {
        const msg = 'guidedRunFolder: panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return guidedActionsHandlers.runFolder(actionId, values, source, dest, inPlace);
    },
    guidedExportToPath: async (actionId, path) => {
      if (!guidedActionsHandlers) {
        const msg = 'guidedExportToPath: panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return guidedActionsHandlers.exportToPath(actionId, path);
    },
    guidedImportFromPath: async (path) => {
      if (!guidedActionsHandlers) {
        const msg = 'guidedImportFromPath: panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return guidedActionsHandlers.importFromPath(path);
    },
    portfolioCreateRun: async (output, sources, title) => {
      if (!portfolioHandlers) {
        const msg = 'portfolioCreateRun: panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return portfolioHandlers.create(output, sources, title);
    },
    portfolioAddRun: async (source) => {
      if (!portfolioHandlers) {
        const msg = 'portfolioAddRun: panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return portfolioHandlers.add(source);
    },
    portfolioUpdateRun: async (name, source) => {
      if (!portfolioHandlers) {
        const msg = 'portfolioUpdateRun: panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return portfolioHandlers.update(name, source);
    },
    portfolioSaveMemberRun: async (name, output) => {
      if (!portfolioHandlers) {
        const msg = 'portfolioSaveMemberRun: panel not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      return portfolioHandlers.saveMember(name, output);
    },
    editImagePageIds: () => canvasEditImages?.pageIds() ?? [],
    editImageListingSettled: () => canvasEditImages?.listingSettled() ?? false,
    editImagePlacements: (pageId) => canvasEditImages?.placements(pageId) ?? [],
    editImageSelect: (pageId, index, additive) =>
      canvasEditImages?.select(pageId, index, additive),
    editImageSelection: () => canvasEditImages?.selection() ?? null,
    editImageTransformMany: async (pageId, targets) => {
      if (!canvasEditImages) {
        const msg = 'editImageTransformMany: canvas edit mode not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      await canvasEditImages.transformImages(pageId, targets);
    },
    editImageDeleteSelected: async () => {
      if (!canvasEditImages) {
        const msg = 'editImageDeleteSelected: canvas edit mode not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      await canvasEditImages.deleteSelected();
    },
    snapGeometryPageIds: () => canvasEditImages?.snapGeometryPageIds() ?? [],
    snapGeometry: (pageId) => canvasEditImages?.snapGeometry(pageId) ?? [],
    guides: () => canvasEditImages?.guides() ?? [],
    takeoffSetGroups: (groups, armed) =>
      setTakeoffSettings({
        groups: groups.map((g) => ({ ...g })),
        armed: armed && groups.some((g) => g.name === armed) ? armed : null,
      }),
    takeoffArmed: () => getTakeoffSettings().armed,
    symbolImportFromPath: async (path) => {
      const res = await importSymbolSetFromPath(path);
      return { id: res.set.id, outcome: res.outcome };
    },
    symbolSets: () =>
      getSymbolSets().map((s) => ({
        id: s.id,
        name: s.name,
        builtin: s.builtin === true,
        symbols: s.symbols.map((x) => x.id),
      })),
    symbolResetSets: () => {
      for (const set of [...getUserSymbolSets()]) removeSymbolSet(set.id);
      reloadSymbolSets();
    },
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
    editVectorTransform: async (pageId, index, matrix) => {
      if (!canvasEditImages) {
        const msg = 'editVectorTransform: canvas edit mode not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      await canvasEditImages.transformVector(pageId, index, matrix);
    },
    editVectorRestyle: async (pageId, index, opts) => {
      if (!canvasEditImages) {
        const msg = 'editVectorRestyle: canvas edit mode not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      await canvasEditImages.restyleVector(pageId, index, opts);
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
    editImageAdd: async (page, rect, source, at) => {
      if (!canvasEditImages) {
        const msg = 'editImageAdd: canvas edit mode not mounted';
        lastError = msg;
        throw new Error(msg);
      }
      try {
        await canvasEditImages.addImage(page, rect, source, at);
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
