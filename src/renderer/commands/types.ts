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
