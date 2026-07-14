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

// --- Pure enablement helpers (unit-tested; menus gray from these) ---------

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

export function hasActiveFile(state: AppState): boolean {
  return state.activeFileId !== null && state.files.has(state.activeFileId);
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
    title: 'Select All',
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
};
