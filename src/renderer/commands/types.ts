// The command system — the load-bearing architecture of the workbench.
// Everything visible
// (menus, toolbars, context menus, tool tiles, the keymap) is data that
// references command ids; handlers live in exactly one place.
import type { Dispatch } from 'react';
import type { AppAction, AppState } from '../state/types';
import type { CanvasHandle } from '../canvas/canvas-handle';

// Menu-bar namespaces. Every command id must live under one of them —
// enforced by the `satisfies` check on COMMAND_IDS in registry.ts. The
// concrete ids are a finite union (typeof COMMAND_IDS[number]) so that
// `COMMANDS: Record<CommandId, Command>` is a TOTAL record: adding an id
// without a command (or vice versa) fails tsc — the tool-icons GLYPHS
// precedent.
export type CommandNamespace =
  | `file.${string}`
  | `edit.${string}`
  | `view.${string}`
  | `document.${string}`
  | `tools.${string}`
  | `window.${string}`
  | `help.${string}`;

/**
 * App-level handlers the registry invokes — registered by App.tsx while
 * mounted (the same handlers the header buttons once ran; commands are
 * entry points, not re-implementations). Everything that only needs
 * state+dispatch is implemented directly in the registry instead.
 */
export interface AppCommandHandlers {
  /** Native open dialog → openByPaths. Resolves true if files were opened. */
  openFiles(): Promise<boolean>;
  /** Native open dialog → openByPaths, WITHOUT focusing the opened doc's tab.
   * The panels' "Open a PDF to …" button: it hands the panel a file, it isn't a
   * request to go and read it. Same code path as openFiles otherwise —
   * decryption, recents, the ghost upgrade and its commit gate all included. */
  openFilesInPlace(): Promise<void>;
  /** Open specific path(s) and focus the (last) opened document's tab — the
   * File ▸ Open Recent and Home-tab recent/open flows. */
  openPath(path: string): Promise<void>;
  /** Open a path (if not already open) and reveal a 1-based page — the
   * cross-file search hit click (part 2). Polls for the doc to index. */
  openPathAtPage(path: string, pageNumber: number): Promise<void>;
  /** Save active file to its original path (commit-gated). */
  save(): Promise<void>;
  /** Save active file via the native save dialog (commit-gated). */
  saveAs(): Promise<void>;
  /** File ▸ Send To ▸ Email: stage a copy of the current working state and
   * hand it to the default desktop mail client via MAPI (commit-gated).
   * Failures — chiefly no registered mail client — surface as a notice. */
  sendToEmail(): Promise<void>;
  /** Export the active document to an editable Office / web format via
   * bundled LibreOffice — docx/rtf/odt/html/xhtml. Commit-gated (the export
   * reflects pending page edits); writes a NEW external file. */
  exportDocument(format: string): Promise<void>;
  /** Open the Export Pages as Images dialog (image half). */
  openExportImages(): void;
  openExportDocument(format: 'txt' | 'xlsx' | 'pptx'): void;
  /** Enter full-screen presentation mode on the active document (I.6). */
  openPresentation(): void;
  /** Close one open file, with the unsaved-changes prompt. */
  closeFile(path: string): Promise<void>;
  /** Close every open file, with the unsaved-changes prompt. */
  closeAll(): Promise<void>;
  /** Two-tier undo/redo (page tier first, then disk snapshots). */
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Materialize pending page edits — the "Apply changes" path
   * (commitAndReport: failures surface on the commit-error banner). */
  applyPageEdits(): Promise<void>;
  /** Open the Settings modal (Edit ▸ Preferences…). */
  openPreferences(): void;
  /** Open the Document Properties dialog (File ▸ Properties…, Ctrl+D). */
  openProperties(): void;
  /** Open the Print dialog (File ▸ Print…, Ctrl+P). */
  openPrint(): void;
  /** Open the Batch OCR dialog (Tools ▸ Batch OCR Folder…).
   * Needs no open document: the dialog operates on a picked folder tree,
   * entirely outside the workspace. */
  openBatchOcr(): void;
  /** Open the Search & Redact folder dialog (Tools ▸ Search & Redact
   * Folder…). Needs no open document: it sweeps a picked folder tree by
   * path, entirely outside the workspace. */
  openDiskRedact(): void;
  /** Open the folder form-preparation dialog (Tools ▸ Prepare Forms in a
   * Folder…). Needs no open document: it analyses a picked folder tree by
   * path, entirely outside the workspace. */
  openFormPrepFolder(): void;
  openFolderExport(): void;
  openFolderCreatePdf(): void;
  /** Open the droplet (Tools ▸ Preflight a Folder…). Needs no open document:
   * it measures a picked tree by path, entirely outside the workspace. */
  openFolderPreflight(): void;
  openScheduledRuns(): void;
  /** Open the Watched Folders dialog (Tools ▸ Watched Folders…). */
  openWatchedFolders(): void;
  /** Insert a blank page after the page being read — pdf-lib
   * one-pager sized to the neighbor, through the byte-only import machinery. */
  insertBlankPage(): Promise<void>;
  /** Insert another file's pages after the page being read (Ctrl+Shift+I,
   * — the native picker, then the same import machinery. */
  insertPagesFromFile(): Promise<void>;
  /** Combine Files appends picked PDF pages to the end of the active document,
   * providing a menu path to the same import machinery as board drag-merging
   * does (same import machinery, page-tier undoable). */
  combineFiles(): Promise<void>;
  /** Create PDF from PostScript: open the distill dialog. */
  openCreatePdf(): void;
  /** Create PDF, opened with one acquisition already started: the clipboard
   * read runs, or the capture dialog is up. */
  openCreatePdfFrom(source: 'clipboard' | 'web'): void;
  /** Open the scan dialog. `append` lands the pages in the open document at
   * the insertion anchor; with nothing to append to it opens for a new
   * document instead, because the destination is the part that has no answer,
   * not the scanning. */
  openScan(mode: 'new' | 'append'): void;
  /** Open the Settings modal at its third-party-licenses section (Help ▸
   * Third-party Licenses). Same surface as preferences. */
  openLicenses(): void;
  /** Open the About dialog (name/version/repo). */
  openAbout(): void;
  /** Open the Customize Toolbar dialog (I.6 — per-item show/hide). */
  openCustomizeToolbar(): void;
  /** Manual update check (Help ▸ Check for Updates) — surfaces the
   * available-flow / up-to-date / enterprise-disabled states on the UpdateBar. */
  checkForUpdates(): void;
  /** Quit, honoring the unsaved-changes prompt (Exit / Ctrl+Q). Always
   * closes when clean — the tray-minimize setting is for the window ×, not Exit. */
  exit(): Promise<void>;
  /** Hide the window to the system tray (Window ▸ Minimize to Tray). */
  minimizeToTray(): Promise<void>;
  /** Open an empty second workspace (Window ▸ New Window). */
  newWindow(): Promise<void>;
  /** Move the active document to a new window (Window ▸ Move to New Window).
   * The document LEAVES this workspace: pending page edits commit first, the
   * claim is released, and only the path crosses. */
  moveToNewWindow(): Promise<void>;
  /** Remove the checked categories of hidden information from a document.
   *
   * The pass is a full rewrite by construction — collapsing prior revisions is
   * what removes content an earlier revision still holds — so a signed
   * document is warned about first, with the signature count the report
   * measured. Returns false when the warning was declined and the document was
   * left alone. */
  sanitizeDocument(
    path: string,
    request: import('../lib/sanitize-report').SanitizeRequest,
  ): Promise<boolean>;
  /** Set the `/Lock` an UNSIGNED signature field carries — the seed whoever
   * signs it later is bound by. `lock` of null removes it.
   *
   * Writing it is a structural edit, so a signed document is decided the way
   * every other one is: refused under a certification that allows no changes,
   * warned about otherwise. Returns false when the warning was declined and
   * the document was left alone. */
  setFieldLock(
    path: string,
    field: string,
    lock: import('../lib/signatures').FieldLock | null,
  ): Promise<boolean>;
  /** Set the Format, Accepted range, Calculate and data actions an EXISTING
   * field carries.
   *
   * Total, like the lock door: every action this app authors is rewritten from
   * `actions`, so a member left out is REMOVED rather than kept. `/CO` is
   * re-sorted so a calculation lands after the fields it reads, and a cycle
   * refuses. `data` is the same contract for the `/AA` kinds that carry no
   * code — omitting it leaves every trigger alone, passing one (empty
   * included) takes over all of them. Structural, so the signed decision is
   * taken where every other edit takes it; returns false when the warning was
   * declined. */
  setFieldActions(
    path: string,
    field: string,
    actions: import('../lib/form-candidates').FieldActions | null,
    data?: import('../lib/field-actions').AuthoredAction[],
  ): Promise<boolean>;
  /** Author link regions on a file.
   *
   * Link authoring writes `/Link` annotations, so it is annotate-class: the
   * incremental tier preserves it, and only a certification that forbids
   * commenting has anything to say about it. Every link mutation — the canvas
   * gesture, the panel's Create, a retarget, a restyle, a delete — comes
   * through these four so the signed decision is taken in one place; each
   * returns false when the warning was declined. */
  addLinks(
    path: string,
    links: import('../lib/links').LinkSpec[],
  ): Promise<boolean>;
  retargetLink(
    path: string,
    page: number,
    index: number,
    target: Record<string, unknown>,
  ): Promise<boolean>;
  restyleLink(
    path: string,
    page: number,
    index: number,
    appearance: Record<string, unknown>,
  ): Promise<boolean>;
  removeLink(path: string, page: number, index: number): Promise<boolean>;
}

/**
 * Services owned by the canvas view while it is mounted. Getter-shaped
 * because the underlying handle/find state changes without re-registration.
 */
export interface CanvasServices {
  /** The d3-zoom camera handle (null until the Canvas mounts its ref). */
  canvas(): CanvasHandle | null;
  /**
   * Bring a page into view, wherever it lives.
   *
   * ALWAYS prefer this over `canvas().centerOn()` for a page the caller didn't
   * get from the currently-shown document. The board renders every document, so
   * centring works for any page there — but the reading view renders exactly
   * ONE, and `centerOn` silently returns for a page it doesn't own. This routes
   * through the owning document first (focusing it, then centring once its view
   * has mounted), so a jump into another open file or another `.pdfx` partition
   * actually lands instead of no-oping.
   */
  jumpToPage(pageId: string): void;
  /** Jump to the Nth page (1-based) of a FILE, resolving the page id from
   * live workspace state. Ids are opaque — generation-
   * tagged when positional, historic when adopted — so callers that know
   * only a page NUMBER (bookmarks) must resolve here, never string-build
   * an id. */
  jumpToFilePage(path: string, pageNumber: number): boolean;
  /** READ this page: switch to the reading view (focusing the owning
   * document if needed) and land on the page — the PageInspector's
   * replacement. Uses the pending-jump slot, so it is safe to call from any
   * view mode; `jumpToPage` after a mode dispatch is NOT (stale-ref fast
   * path — regression). */
  openPageForReading(pageId: string): void;
  /** The floating Find bar. */
  find: {
    isOpen(): boolean;
    open(): void;
    /** Open seeded with a query, optional page jump, and optional advanced
     * modes — the Search nav panel's result click (carries the
     * panel's regex/case/whole-word modes so the highlight agrees). */
    openWith(query: string, pageId?: string, options?: import('../search/normalize').SearchOptions): void;
    close(): void;
    /** Step the match cursor. Only meaningful while
     * open — the commands open the bar first when it isn't. */
    next(): void;
    prev(): void;
  };
  /** Read Out Loud's transport. The reader is transient view state owned by
   * the canvas (the find bar's shape), so the View menu routes here rather
   * than through the reducer: a highlight is bound to the blocks of a
   * specific buffer and dies with it. */
  readAloud: {
    /** True while a reading run exists — speaking, paused or preparing. */
    isReading(): boolean;
    isPaused(): boolean;
    /** Start at the page on screen, ending with it. */
    readPage(): void;
    /** Start at the page on screen and continue to the last page. */
    readDocument(): void;
    /** Pause a speaking reader, resume a paused one. Does nothing when
     * nothing is being read — the command's `when` is what gates it. */
    togglePause(): void;
    stop(): void;
  };

  /** Focus the reading view's page box (Ctrl+Shift+N). Returns false
   * when the box isn't on screen (organize view) — the command's `when`
   * gates on the view mode, this is the belt for the render race. */
  goToPage(): boolean;
  /** Drop every ruler guide (View ▸ Clear Guides). Guides are
   * per-document VIEW state owned by the canvas — the redaction-mark
   * lifetime — so the command routes here rather than through the reducer or
   * the snap-preference store. */
  clearGuides(): void;
  /** Arm the canvas's visible-signature placement from a PANEL, with the
   * panel's signer details and certification choice prefilled into the canvas
   * sign card. Optional — present only while the canvas view is mounted with a
   * document. */
  startVisibleSignature?(
    prefill?: import('../components/SignerSourceFields').SignerSource,
    certification?: import('../lib/signatures').CertifyOptions,
    fieldLock?: import('../lib/signatures').LockOptions,
  ): void;
  /**
   * The Search & Redact panel's seam onto the canvas's redaction
   * marks.
   *
   * The panel does not own geometry and must not: converting a page-space rect
   * into a display-normalized mark is the seed's own conversion, and there
   * is exactly ONE of it (in the canvas, where the pdf.js proxies and the
   * PageRef rotations live). What crosses this seam is the payload shape
   * `list_redact_annotations` returns and `save_redaction_marks` takes —
   * `{page, rect}` in the page's own point space — so the panel, the seed and
   * the apply all speak the same geometry.
   *
   * Nothing here is destructive. Marks are transient view state; the status
   * bar's apply/save/clear remains the only path that changes a file.
   */
  redaction: {
    /** Add marks from page-space rects. Returns what happened: a rect that
     * duplicates a mark already on that page is NOT added (double-clicking
     * "Mark checked" must not stack marks), and a page the view can no longer
     * resolve is skipped and counted rather than guessed at. */
    addMarks(
      requests: { path: string; page: number; rect: [number, number, number, number] }[],
    ): Promise<{ added: number; duplicates: number; skipped: number }>;
    /** Every pending mark, converted back to page-space rects — what the
     * panel compares a fresh hit against to show it as already marked. */
    markedRects(): Promise<{ path: string; page: number; rect: [number, number, number, number] }[]>;
    /** How many marks are pending, across every document. */
    count(): number;
    /** Fires whenever the pending mark set changes, so the panel's
     * already-marked state stays live while the user also draws by hand.
     * Returns its own unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** The SECOND rect authority: an image-only page's hits come from
     * the in-memory OCR word boxes the index already holds, converted to page
     * space by the same machinery "Make searchable" uses. Returns [] when the
     * page has not been recognised yet. */
    searchOcrPage(
      path: string,
      page: number,
      query: string,
      options: import('../search/normalize').SearchOptions,
    ): Promise<{ text: string; rect: [number, number, number, number] }[]>;
  };
  /**
   * The Prepare Form panel's seam onto the canvas's provisional field
   * candidates.
   *
   * The same division the redaction seam draws: the panel owns the review, the
   * canvas owns the geometry. A candidate's page-space rectangle becomes a cell
   * rectangle through the pdf.js proxies and the PageRef rotations, which live
   * here and nowhere else.
   *
   * NOTHING here writes to the document except `accept`, which routes through
   * the ONE field-authoring operation the hand-drawn placement already uses.
   */
  formCandidates: {
    /** Replace the candidate set from a detection result. */
    publish(
      path: string,
      result: import('../lib/form-candidates').DetectionResult,
    ): Promise<{ shown: number; skipped: number }>;
    /** The live set, pruned to pages that still exist. */
    list(): import('../lib/form-candidates').FieldCandidate[];
    /** Turn the named candidates into fields — one snapshot, one undo entry. */
    accept(ids: readonly string[]): Promise<{ created: number; skipped: number }>;
    update(next: readonly import('../lib/form-candidates').FieldCandidate[]): void;
    clear(): void;
    /** Bring a candidate's page into view and select its overlay. */
    focus(candidateId: string): void;
    /** Fires whenever the candidate set changes, so the panel stays live while
     * the user also edits overlays on the page. Returns its own unsubscribe. */
    subscribe(listener: () => void): () => void;
  };
  /**
   * Detected tables, reviewed on the page before a spreadsheet is written.
   *
   * The same division as the candidate seam above, for the same reason: the
   * bounds of a table are page-space geometry, and the pdf.js proxies and
   * PageRef rotations that project one live here alone.
   *
   * NOTHING here writes to the document at all — `exportTo` writes only the
   * workbook it is given a path for.
   */
  tableReview: {
    /** Replace the region set from a detection result. */
    publish(
      path: string,
      result: import('../lib/table-review').TableDetectionResult,
    ): Promise<{ shown: number; skipped: number }>;
    /** The live set, pruned to pages that still exist. */
    list(): import('../lib/table-review').TableRegion[];
    update(next: readonly import('../lib/table-review').TableRegion[]): void;
    clear(): void;
    /** Bring a table's page into view and select its overlay. */
    focus(regionId: string): void;
    /** Write the accepted tables to `output`. Refuses rather than writing a
     * workbook whose tables are not the ones that were reviewed. */
    exportTo(
      output: string,
      options: { sheetPer: string; includeUntabled: boolean },
    ): Promise<import('../lib/export-targets').ExportDocumentResult>;
    subscribe(listener: () => void): () => void;
  };
  /**
   * Accessibility findings shown on the page — the third use of the same seam.
   *
   * The checker addresses a page finding by the file's own page number and a
   * rectangle in un-rotated user space; turning that into a place on screen is
   * page geometry, which lives here alone.
   *
   * NOTHING here writes to the document, and there is no accept side at all:
   * a finding is a claim, and the edit that answers it is an ordinary op run
   * from the panel.
   */
  a11yFindings: {
    /** Replace the finding set with one check's findings. */
    publish(
      path: string,
      findings: readonly import('../lib/a11y-findings').PlaceableFinding[],
    ): Promise<{ shown: number; skipped: number }>;
    /** The live set, pruned to pages that still exist. */
    list(): import('../lib/a11y-findings').A11yFinding[];
    clear(): void;
    /** Bring a finding's page into view and select its overlay. */
    focus(findingId: string): void;
    // No `subscribe` and no `update`: the two seams above let the panel and the
    // page edit ONE set from either end, and this one has nothing to edit — the
    // panel publishes, the page draws, and a re-check replaces the whole set.
  };
}

export interface CommandContext {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  /** Null only before App's registration effect runs (never observable by user input). */
  app: AppCommandHandlers | null;
  /** Null while the canvas view is unmounted. */
  canvas: CanvasServices | null;
}

export interface Command {
  /** Menu/tooltip label (menus render from the registry). */
  title: string;
  /** Pure enablement predicate — menus/toolbars gray consistently from this,
   * and the keymap only runs enabled commands. Absent = always enabled.
   * `disabled` is rendering-state only; features we don't ship are ABSENT
   * Never registered-and-disabled. */
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}
