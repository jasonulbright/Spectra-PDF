// The command system — the load-bearing architecture of Phase 4
// (docs/architecture/19-phase4-workbench-ui.md § 4). Everything visible
// (menus, toolbars, context menus, tool tiles, the keymap) is data that
// references command ids; handlers live in exactly one place.
import type { Dispatch } from 'react';
import type { AppAction, AppState } from '../state/types';
import type { CanvasHandle } from '../canvas/canvas-handle';

// Menu-bar namespaces (§ 4.1). Every command id must live under one of them —
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
 * mounted (the same handlers the header buttons ran before M1; commands are
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
   * cross-file search hit click (P4 part 2). Polls for the doc to index. */
  openPathAtPage(path: string, pageNumber: number): Promise<void>;
  /** Save active file to its original path (commit-gated). */
  save(): Promise<void>;
  /** Save active file via the native save dialog (commit-gated). */
  saveAs(): Promise<void>;
  /** Export the active document to an editable Office / web format (O1) via
   * bundled LibreOffice — docx/rtf/odt/html/xhtml. Commit-gated (the export
   * reflects pending page edits); writes a NEW external file. */
  exportDocument(format: string): Promise<void>;
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
  /** Open the Settings modal (Edit ▸ Preferences… at M5). */
  openPreferences(): void;
  /** Open the Document Properties dialog (File ▸ Properties…, Ctrl+D). */
  openProperties(): void;
  /** Open the Print dialog (File ▸ Print…, Ctrl+P — M-P, § 3.4). */
  openPrint(): void;
  /** Open the Batch OCR dialog (Tools ▸ Batch OCR Folder… — Phase 6).
   * Needs no open document: the dialog operates on a picked folder tree,
   * entirely outside the workspace. */
  openBatchOcr(): void;
  /** Insert a blank page after the page being read (§ 9.3, M6.3) — pdf-lib
   * one-pager sized to the neighbor, through the byte-only import machinery. */
  insertBlankPage(): Promise<void>;
  /** Insert another file's pages after the page being read (Ctrl+Shift+I,
   * § 9.2) — the native picker, then the same import machinery. */
  insertPagesFromFile(): Promise<void>;
  /** Combine Files (2026-07-18): append picked PDFs' pages to the END of
   * the active document — the menu-named path to what board drag-merging
   * does (same import machinery, page-tier undoable). */
  combineFiles(): Promise<void>;
  /** Create PDF from PostScript (Phase 8): open the distill dialog. */
  openCreatePdf(): void;
  /** Open the Settings modal at its third-party-licenses section (Help ▸
   * Third-party Licenses). Same surface as preferences until M5 splits it. */
  openLicenses(): void;
  /** Open the About dialog (name/version/repo). */
  openAbout(): void;
  /** Manual update check (Help ▸ Check for Updates) — surfaces the
   * available-flow / up-to-date / enterprise-disabled states on the UpdateBar. */
  checkForUpdates(): void;
  /** Quit, honoring the unsaved-changes prompt (Exit / Ctrl+Q). Always
   * closes when clean — the tray-minimize setting is for the window ×, not Exit. */
  exit(): Promise<void>;
  /** Hide the window to the system tray (Window ▸ Minimize to Tray). */
  minimizeToTray(): Promise<void>;
}

/**
 * Services owned by the canvas view while it is mounted. Getter-shaped
 * because the underlying handle/find state changes without re-registration.
 */
export interface CanvasServices {
  /** The d3-zoom camera handle (null until the Canvas mounts its ref). */
  canvas(): CanvasHandle | null;
  /**
   * Bring a page into view, wherever it lives (M4.1c).
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
   * live workspace state. Phase 5 (§ F): ids are opaque — generation-
   * tagged when positional, historic when adopted — so callers that know
   * only a page NUMBER (bookmarks) must resolve here, never string-build
   * an id. */
  jumpToFilePage(path: string, pageNumber: number): boolean;
  /** READ this page (M6.2): switch to the reading view (focusing the owning
   * document if needed) and land on the page — the PageInspector's
   * replacement. Uses the pending-jump slot, so it is safe to call from any
   * view mode; `jumpToPage` after a mode dispatch is NOT (stale-ref fast
   * path — review-caught). */
  openPageForReading(pageId: string): void;
  /** The floating Find bar (2m). */
  find: {
    isOpen(): boolean;
    open(): void;
    /** Open seeded with a query, optional page jump, and optional advanced
     * modes — the Search nav panel's result click (Phase 4 M3.3; P4 carries the
     * panel's regex/case/whole-word modes so the highlight agrees). */
    openWith(query: string, pageId?: string, options?: import('../search/normalize').SearchOptions): void;
    close(): void;
    /** Step the match cursor (F3 / Shift+F3, M6.3). Only meaningful while
     * open — the commands open the bar first when it isn't. */
    next(): void;
    prev(): void;
  };
  /** Focus the reading view's page box (Ctrl+Shift+N, § 9.2). Returns false
   * when the box isn't on screen (organize view) — the command's `when`
   * gates on the view mode, this is the belt for the render race. */
  goToPage(): boolean;
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
  /** Menu/tooltip label (menus render from the registry at M2). */
  title: string;
  /** Pure enablement predicate — menus/toolbars gray consistently from this,
   * and the keymap only runs enabled commands. Absent = always enabled.
   * `disabled` is rendering-state only; features we don't ship are ABSENT
   * (§ 3.3), never registered-and-disabled. */
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}
