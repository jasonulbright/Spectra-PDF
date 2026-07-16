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
  /** Save active file to its original path (commit-gated). */
  save(): Promise<void>;
  /** Save active file via the native save dialog (commit-gated). */
  saveAs(): Promise<void>;
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
  /** The floating Find bar (2m). */
  find: {
    isOpen(): boolean;
    open(): void;
    /** Open seeded with a query and jump to a page — the Search nav panel's
     * result click (Phase 4 M3.3). */
    openWith(query: string, pageId?: string): void;
    close(): void;
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
  /** Menu/tooltip label (menus render from the registry at M2). */
  title: string;
  /** Pure enablement predicate — menus/toolbars gray consistently from this,
   * and the keymap only runs enabled commands. Absent = always enabled.
   * `disabled` is rendering-state only; features we don't ship are ABSENT
   * (§ 3.3), never registered-and-disabled. */
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void | Promise<void>;
}
