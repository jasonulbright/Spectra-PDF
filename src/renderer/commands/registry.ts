// The command registry (19-phase4 § 4). COMMANDS is a TOTAL record over the
// finite CommandId union — adding an id without a command (or a command
// without an id) fails tsc, the tool-icons GLYPHS precedent. Menus, toolbars,
// tool tiles and the keymap reference these ids; nothing re-implements a
// handler. M1 registers every action that existed before the workbench;
// M2+ chrome only *references* what is here.
import { isDocTab } from '../state/types';
import type { AppState, CanvasTool, FocusedTab, NavPanelId } from '../state/types';
import type { Command, CommandContext, CommandNamespace } from './types';
import { NAV_PANEL_IDS, NAV_PANEL_TITLES } from './navpanels';
import { TOOL_DEFS, TOOL_IDS } from './tools';
import { openFindWhenCanvasReady } from './find-intent';

// --- Pure enablement helpers (unit-tested; menus gray from these) ---------

/**
 * The active file's path, but only if it is a document we can actually SHOW.
 *
 * `activeFileId` alone isn't that: an import-only source (bytes dragged in to
 * supply pages, never opened as a document) has an entry in `files` but no tab,
 * and `focusTab` rejects a doc tab for it. Closing the last real file can leave
 * one as the active id, so this is reachable. A caller that focuses a doc tab
 * must gate on THIS, or it dispatches a focus that silently no-ops and then
 * carries on as though the document were in front.
 */
function showableDoc(state: AppState): string | null {
  const path = state.activeFileId;
  if (!path) return null;
  const f = state.files.get(path);
  return f && !f.importOnly ? path : null;
}

export function canUndo(state: AppState): boolean {
  if (state.pageUndoStack.length > 0) return true;
  const f = state.activeFileId ? state.files.get(state.activeFileId) : null;
  return f ? f.undoStack.length > 0 : false;
}

export function canRedo(state: AppState): boolean {
  if (state.pageRedoStack.length > 0) return true;
  const f = state.activeFileId ? state.files.get(state.activeFileId) : null;
  return f ? f.redoStack.length > 0 : false;
}

/** Dirty = whole-file dirty OR pending page-tier edits touching the file. */
export function isActiveFileDirty(state: AppState): boolean {
  const f = state.activeFileId ? state.files.get(state.activeFileId) : null;
  if (!f) return false;
  return f.dirty || state.pageDirtyPaths.includes(f.path);
}

/**
 * There is an active file the user can act on.
 *
 * Excludes byte-only import sources: they live in `files` but have no tab and
 * are never shown, and `CLOSE_FILE`'s active-id fallback can land on one, so
 * "activeFileId is set" is NOT the same question. Without the `importOnly`
 * check, closing your only real document after having imported pages from
 * another file left File ▸ Save As and File ▸ Close enabled in the menu,
 * pointed at a ghost — Save As would open a native dialog named after a file
 * the user isn't looking at, and Close would silently discard it.
 */
export function hasActiveFile(state: AppState): boolean {
  return showableDoc(state) !== null;
}

export function hasOpenFiles(state: AppState): boolean {
  return state.files.size > 0;
}

export function hasSelection(state: AppState): boolean {
  return state.ui.selectedPageIds.size > 0;
}

/** Open files that get doc tabs — byte-only import sources (2n.3) don't. */
export function tabFiles(state: AppState): string[] {
  return [...state.files.values()].filter((f) => !f.importOnly).map((f) => f.path);
}

/** The visible tab order: Home | Tools | one tab per open document. */
export function tabOrder(state: AppState): FocusedTab[] {
  return ['home', 'tools', ...tabFiles(state).map((doc) => ({ doc }))];
}

/** Cycle the visible strip by ±1 from the focused tab (wraps). */
export function cycledTab(state: AppState, delta: 1 | -1): FocusedTab {
  const order = tabOrder(state);
  const cur = state.ui.focusedTab;
  const idx = order.findIndex((t) =>
    isDocTab(t) ? isDocTab(cur) && t.doc === cur.doc : t === cur,
  );
  return order[(idx + delta + order.length) % order.length];
}

// --- Command definitions ---------------------------------------------------

// The operation panels (retiring at M5 into tools/dialogs; until then each
// gets a navigation command so menus/tiles/welcome actions share one path).
const PANEL_OPS = [
  'split', 'rotate', 'delete',
  'compress', 'grayscale', 'optimize', 'pdfa', 'pdf_version',
  'repair', 'rebuild', 'recover',
  'encrypt', 'decrypt',
  'extract_text', 'watermark', 'forms', 'compare', 'signatures', 'metadata',
] as const;
type PanelOp = (typeof PANEL_OPS)[number];

const PANEL_TITLES: Record<PanelOp, string> = {
  split: 'Split by Range', rotate: 'Rotate Pages', delete: 'Delete Pages',
  compress: 'Compress', grayscale: 'Convert to Grayscale', optimize: 'Optimize PDF',
  pdfa: 'Convert to PDF/A', pdf_version: 'Set PDF Version',
  encrypt: 'Encrypt PDF', decrypt: 'Decrypt PDF',
  extract_text: 'Extract Text', metadata: 'Edit Metadata',
  watermark: 'Watermark', forms: 'Fill Form', compare: 'Compare PDFs',
  signatures: 'Signatures',
  repair: 'Repair PDF', rebuild: 'Rebuild PDF', recover: 'Recover Pages',
};

// Canvas interaction tools (the floating pill set). Activation toggles like
// the pills: picking the active tool returns to Select.
const CANVAS_TOOLS = [
  'select', 'highlight', 'freetext', 'ink', 'stamp', 'redact', 'signature', 'forms',
] as const;

const TOOL_TITLES: Record<CanvasTool, string> = {
  select: 'Select', highlight: 'Highlight', freetext: 'Text', ink: 'Draw',
  stamp: 'Stamp', redact: 'Redact', signature: 'Sign', forms: 'Forms',
};

export const COMMAND_IDS = [
  'file.open',
  'file.save',
  'file.saveAs',
  'file.close',
  'file.closeAll',
  'edit.undo',
  'edit.redo',
  'edit.selectAll',
  'edit.deselect',
  'edit.find',
  'edit.preferences',
  'view.home',
  'view.tools',
  'view.navPane',
  ...NAV_PANEL_IDS.map((id) => `view.navPanel.${id}` as const),
  'view.zoomIn',
  'view.zoomOut',
  'view.fit',
  'view.actualSize',
  'view.fitWidth',
  'document.deleteSelection',
  'document.rotateSelectionCW',
  'document.rotateSelectionCCW',
  'document.applyPageEdits',
  'window.nextTab',
  'window.prevTab',
  'window.minimizeToTray',
  'help.about',
  'help.licenses',
  'help.checkUpdates',
  'file.exit',
  'file.clearRecent',
  ...CANVAS_TOOLS.map((t) => `tools.${t}` as const),
  ...PANEL_OPS.map((op) => `tools.panel.${op}` as const),
  ...TOOL_IDS.map((id) => `tools.open.${id}` as const),
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

// Every id must live under a menu-bar namespace (§ 4.1).
COMMAND_IDS satisfies readonly CommandNamespace[];

// "In the document board" = a doc tab is focused (the canvas board is the
// pane content at M2). Tool + selection commands only make sense there.
const inCanvas = (ctx: CommandContext): boolean => isDocTab(ctx.state.ui.focusedTab);


function toolCommand(tool: CanvasTool): Command {
  return {
    title: TOOL_TITLES[tool],
    when: inCanvas,
    run: ({ state, dispatch }) => {
      // Pill toggle semantics: re-picking the active tool exits to Select.
      const next = tool !== 'select' && state.ui.tool === tool ? 'select' : tool;
      dispatch({ type: 'UI_SET_TOOL', tool: next });
    },
  };
}

function panelCommand(op: PanelOp): Command {
  return {
    title: PANEL_TITLES[op],
    run: ({ dispatch }) => {
      dispatch({ type: 'UI_FOCUS_TAB', tab: 'tools' });
      // UI_SET_ACTIVE_OP opens the TOOL that hosts this operation too, so a menu
      // item and a Tools Center tile land in the same place — otherwise the menu
      // would drop the user on the tile grid with the operation invisibly
      // "active". That re-homing lives in the reducer, not here, so it holds for
      // every dispatcher (the e2e harness sets activeOp directly).
      dispatch({ type: 'UI_SET_ACTIVE_OP', op });
    },
  };
}

export const COMMANDS: Record<CommandId, Command> = {
  'file.open': {
    title: 'Open…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => void ctx.app!.openFiles(),
  },
  'file.save': {
    title: 'Save',
    when: (ctx) => ctx.app !== null && isActiveFileDirty(ctx.state),
    run: (ctx) => ctx.app!.save(),
  },
  'file.saveAs': {
    title: 'Save As…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.saveAs(),
  },
  'file.close': {
    title: 'Close',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.closeFile(ctx.state.activeFileId!),
  },
  'file.closeAll': {
    title: 'Close All',
    when: (ctx) => ctx.app !== null && hasOpenFiles(ctx.state),
    run: (ctx) => ctx.app!.closeAll(),
  },
  'edit.undo': {
    title: 'Undo',
    when: (ctx) => ctx.app !== null && canUndo(ctx.state),
    run: (ctx) => ctx.app!.undo(),
  },
  'edit.redo': {
    title: 'Redo',
    when: (ctx) => ctx.app !== null && canRedo(ctx.state),
    run: (ctx) => ctx.app!.redo(),
  },
  'edit.selectAll': {
    title: 'Select All Pages',
    // Selects PAGES in BOTH views, deliberately — see § 9.2's amendment.
    //
    // § 9.2 originally had Ctrl+A select TEXT in the reading view (Acrobat's
    // behaviour), and that was tried: disable here, let the browser's native
    // select-all run over the text layer. It was REVERTED because the reading
    // view is VIRTUALIZED — only the pages within the scroll window have text
    // spans in the DOM at all — so native select-all can physically only reach
    // the handful of mounted pages. Ctrl+A then Ctrl+C would put a few pages of
    // text on the clipboard while the user believed they had copied the
    // document, silently and with no way to notice (review-caught). A
    // well-defined "select all pages" (which the reading view's own context menu
    // can act on) beats a select-all that quietly lies about its scope; drag-,
    // double-click- and triple-click-selection all still work on the text.
    when: inCanvas,
    run: ({ dispatch }) => dispatch({ type: 'UI_SELECT_ALL_PAGES' }),
  },
  'edit.deselect': {
    title: 'Deselect',
    when: (ctx) => hasSelection(ctx.state),
    run: ({ dispatch }) => dispatch({ type: 'UI_CLEAR_SELECTION' }),
  },
  'edit.find': {
    title: 'Find',
    when: (ctx) => ctx.canvas !== null,
    run: (ctx) => ctx.canvas!.find.open(),
  },
  'edit.preferences': {
    title: 'Preferences…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openPreferences(),
  },
  'view.home': {
    title: 'Home',
    run: ({ dispatch }) => dispatch({ type: 'UI_FOCUS_TAB', tab: 'home' }),
  },
  'view.tools': {
    title: 'Tools',
    run: ({ dispatch }) => dispatch({ type: 'UI_FOCUS_TAB', tab: 'tools' }),
  },
  'view.navPane': {
    title: 'Navigation Pane',
    // The pane is about the active document — only meaningful on a doc tab.
    when: inCanvas,
    run: ({ dispatch }) => dispatch({ type: 'UI_TOGGLE_NAV_PANE' }),
  },
  ...(Object.fromEntries(
    NAV_PANEL_IDS.map((id) => [
      `view.navPanel.${id}`,
      {
        title: NAV_PANEL_TITLES[id],
        when: inCanvas,
        run: ({ dispatch }: CommandContext) => dispatch({ type: 'UI_OPEN_NAV_PANEL', panel: id as NavPanelId }),
      } satisfies Command,
    ]),
  ) as Record<`view.navPanel.${(typeof NAV_PANEL_IDS)[number]}`, Command>),
  'view.zoomIn': {
    title: 'Zoom In',
    when: (ctx) => ctx.canvas?.canvas() != null,
    run: (ctx) => ctx.canvas!.canvas()!.zoomIn(),
  },
  'view.zoomOut': {
    title: 'Zoom Out',
    when: (ctx) => ctx.canvas?.canvas() != null,
    run: (ctx) => ctx.canvas!.canvas()!.zoomOut(),
  },
  'view.fit': {
    title: 'Fit to View',
    when: (ctx) => ctx.canvas?.canvas() != null,
    run: (ctx) => ctx.canvas!.canvas()!.reset(),
  },
  // Reading-view only: the board has no honest notion of a page's true size or
  // of fitting one page's width, so it doesn't implement these and they DISABLE
  // there rather than doing something else (§ 3.3 — the `when` reads the
  // optional method's presence, which is the capability, not the view mode).
  'view.actualSize': {
    title: 'Actual Size',
    when: (ctx) => ctx.canvas?.canvas()?.actualSize != null,
    run: (ctx) => ctx.canvas!.canvas()!.actualSize!(),
  },
  'view.fitWidth': {
    title: 'Fit Width',
    when: (ctx) => ctx.canvas?.canvas()?.fitWidth != null,
    run: (ctx) => ctx.canvas!.canvas()!.fitWidth!(),
  },
  'document.deleteSelection': {
    title: 'Delete Selected Pages',
    when: (ctx) => hasSelection(ctx.state),
    run: ({ state, dispatch }) => {
      // Same pair the keyboard path ran pre-M1: batched delete, then clear —
      // unconditionally, so a reducer-rejected batch (stale id / would empty
      // a file) still drops the hazardous stale selection.
      dispatch({ type: 'DELETE_PAGE_REFS', pageIds: [...state.ui.selectedPageIds] });
      dispatch({ type: 'UI_CLEAR_SELECTION' });
    },
  },
  'document.rotateSelectionCW': {
    title: 'Rotate Selection Right 90°',
    when: (ctx) => hasSelection(ctx.state),
    run: ({ state, dispatch }) =>
      dispatch({ type: 'ROTATE_PAGE_REFS', pageIds: [...state.ui.selectedPageIds], delta: 90 }),
  },
  'document.rotateSelectionCCW': {
    title: 'Rotate Selection Left 90°',
    when: (ctx) => hasSelection(ctx.state),
    run: ({ state, dispatch }) =>
      dispatch({ type: 'ROTATE_PAGE_REFS', pageIds: [...state.ui.selectedPageIds], delta: 270 }),
  },
  'document.applyPageEdits': {
    title: 'Apply Page Edits',
    when: (ctx) => ctx.app !== null && ctx.state.pageDirtyPaths.length > 0,
    run: (ctx) => ctx.app!.applyPageEdits(),
  },
  'window.nextTab': {
    title: 'Next Tab',
    // Home + Tools are always present, so cycling is always meaningful.
    run: ({ state, dispatch }) =>
      dispatch({ type: 'UI_FOCUS_TAB', tab: cycledTab(state, 1) }),
  },
  'window.prevTab': {
    title: 'Previous Tab',
    run: ({ state, dispatch }) =>
      dispatch({ type: 'UI_FOCUS_TAB', tab: cycledTab(state, -1) }),
  },
  'window.minimizeToTray': {
    title: 'Minimize to Tray',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.minimizeToTray(),
  },
  'help.about': {
    title: 'About Open PDF Studio',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openAbout(),
  },
  'help.licenses': {
    title: 'Third-party Licenses',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openLicenses(),
  },
  'help.checkUpdates': {
    title: 'Check for Updates',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.checkForUpdates(),
  },
  'file.exit': {
    title: 'Exit',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.exit(),
  },
  'file.clearRecent': {
    title: 'Clear Recent',
    when: (ctx) => ctx.state.ui.recentFiles.length > 0,
    run: ({ dispatch }) => dispatch({ type: 'UI_SET_RECENT_FILES', files: [] }),
  },
  ...(Object.fromEntries(
    CANVAS_TOOLS.map((t) => [`tools.${t}`, toolCommand(t)]),
  ) as Record<`tools.${(typeof CANVAS_TOOLS)[number]}`, Command>),
  ...(Object.fromEntries(
    PANEL_OPS.map((op) => [`tools.panel.${op}`, panelCommand(op)]),
  ) as Record<`tools.panel.${PanelOp}`, Command>),
  // One command per TOOL (§ 7) — what the Tools menu and the Tools Center tiles
  // both invoke, so the two can never disagree about what a tool opens.
  ...(Object.fromEntries(
    TOOL_DEFS.map((tool) => [
      `tools.open.${tool.id}`,
      {
        title: tool.title,
        // A tool whose work happens ON the page needs a page to show. Not just
        // "activeFileId is set": an import-only source is bytes with no tab, and
        // `focusTab` rejects it — leaving us to arm a mode on a document the
        // user can't see. (CLOSE_FILE can leave a ghost import-only file as the
        // active one, so this is reachable, not theoretical.)
        when: (ctx) => tool.ops.length > 0 || showableDoc(ctx.state) !== null,
        run: (ctx) => {
          const { state, dispatch } = ctx;
          // Activating a tool arms its interaction mode (§ 7) — for EVERY tool,
          // not just the canvas-mode ones (Prepare Form and Fill & Sign each
          // host a panel AND want their widget mode live). Unconditional with a
          // 'select' default, NOT `if (tool.canvasTool)`: a tool whose mode is
          // "none" must DISARM the last one. Nothing else clears `ui.tool` —
          // `focusTab` only resets it when LEAVING a doc tab, so Tools→Tools and
          // Tools→doc never qualify — and a stale mode is live on the canvas
          // (PageCell branches on it), so opening Prepare Form, going back, then
          // opening Protect would leave Forms mode armed under a tool that never
          // asked for it.
          dispatch({ type: 'UI_SET_TOOL', tool: tool.canvasTool ?? 'select' });
          if (tool.ops.length === 0) {
            // Canvas-mode tool (Comment, Redact, Scan & OCR): there is no form to
            // fill — the work IS the document. So open the document and arm the
            // mode, rather than parking the user on a Tools tab that would have
            // nothing to show. Acrobat does the same: picking Comment puts you on
            // the page with the markup tools live.
            const path = showableDoc(state);
            if (!path) return; // unreachable: `when` above requires one.
            dispatch({ type: 'UI_FOCUS_TAB', tab: { doc: path } });
            // Scan & OCR's whole surface is Find's "Make searchable" (2m), so the
            // tool opens Find rather than inventing a second entry point for it.
            // Deferred, not called on ctx.canvas: the tab focus above has only
            // been SCHEDULED, so the canvas is still unmounted right now.
            if (tool.id === 'ocr') openFindWhenCanvasReady(ctx.canvas, path);
            return;
          }
          dispatch({ type: 'UI_FOCUS_TAB', tab: 'tools' });
          // Land on the tool's first operation — opening a tool should show its
          // work, not an empty shell. UI_SET_ACTIVE_OP re-homes activeToolId
          // onto the op's owning tool, so this also opens `tool`.
          dispatch({ type: 'UI_SET_ACTIVE_OP', op: tool.ops[0] });
        },
      } satisfies Command,
    ]),
  ) as Record<`tools.open.${(typeof TOOL_IDS)[number]}`, Command>),
};
