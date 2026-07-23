// The command registry (19-phase4 § 4). COMMANDS is a TOTAL record over the
// finite CommandId union — adding an id without a command (or a command
// without an id) fails tsc, the tool-icons GLYPHS precedent. Menus, toolbars,
// tool tiles and the keymap reference these ids; nothing re-implements a
// handler. M1 registers every action that existed before the workbench;
// M2+ chrome only *references* what is here.
import { isDocTab } from '../state/types';
import { insertAnchor, showableDoc, tabFiles } from '../state/selectors';
import type { AppState, CanvasTool, FocusedTab, NavPanelId } from '../state/types';
import type { Command, CommandContext, CommandNamespace } from './types';
import { NAV_PANEL_IDS, NAV_PANEL_TITLES } from './navpanels';
import { TOOL_DEFS, TOOL_IDS, toolById, toolForCanvasTool, worksOnPage, type ToolId } from './tools';
import { OPERATIONS, OPERATION_TITLES, type Operation } from './operations';
import { openFindWhenCanvasReady } from './find-intent';

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

/**
 * Dirty = whole-file dirty OR pending page-tier edits touching the file.
 *
 * Gates File ▸ Save, whose handler writes the working copy back over
 * `activeFile.path` with no dialog. So it asks `showableDoc`, not
 * `activeFileId`: for a byte-only import source that path is the ORIGINAL file
 * the user imported from, and "Save" would silently overwrite it — a file with
 * no tab, no dirty marker, and nothing on screen to connect it to the action.
 * `hasActiveFile` (Save As / Close) already refused; Save was the one that
 * didn't, which is the wrong way round for the destructive one.
 */
export function isActiveFileDirty(state: AppState): boolean {
  const path = showableDoc(state);
  const f = path ? state.files.get(path) : null;
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

/** The tab-bearing files' PATHS. Named apart from the selector's `tabFiles`
 * (which returns the files themselves) on purpose: two exported functions with
 * the same name and different shapes is how an importer picks the wrong one. */
export function tabFilePaths(state: AppState): string[] {
  return tabFiles(state).map((f) => f.path);
}

/** The visible tab order: Home | Tools | one tab per open document. */
export function tabOrder(state: AppState): FocusedTab[] {
  return ['home', 'tools', ...tabFilePaths(state).map((doc) => ({ doc }))];
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

// Canvas interaction modes. Activation toggles: picking the active one returns
// to Select. Which TOOL owns each is `commands/tools.ts`'s `canvasTools`.
const CANVAS_TOOLS = [
  'select', 'hand', 'highlight', 'freetext', 'ink', 'stamp', 'redact', 'signature', 'forms',
  'formfields', 'edit', 'addtext', 'addimage',
] as const;

export const TOOL_TITLES: Record<CanvasTool, string> = {
  select: 'Select', hand: 'Hand', highlight: 'Highlight', freetext: 'Text', ink: 'Draw',
  stamp: 'Stamp', redact: 'Redact', signature: 'Sign', forms: 'Fill Fields',
  formfields: 'Add Field', edit: 'Select Image', addtext: 'Add Text',
  addimage: 'Add Image',
};

// CANVAS_TOOLS must be a literal tuple (COMMAND_IDS builds `tools.${t}` from
// it), so it can't be derived from the union — which means it CAN fall behind
// it. This makes that a compile error instead of a mode with no command: a
// `CanvasTool` missing from the tuple resolves the type to itself, and `true`
// isn't assignable to it, so tsc names the missing mode.
type ModeWithoutACommand = Exclude<CanvasTool, (typeof CANVAS_TOOLS)[number]>;
const _EVERY_MODE_HAS_A_COMMAND: [ModeWithoutACommand] extends [never] ? true : ModeWithoutACommand = true;
void _EVERY_MODE_HAS_A_COMMAND;

/** Every canvas mode, at runtime — the same tuple, widened. One list: a second
 * copy (from TOOL_TITLES' keys, say) would be a second thing to keep in step,
 * which is how `Operation` ended up declared in four places. */
export const CANVAS_MODES: readonly CanvasTool[] = CANVAS_TOOLS;

export const COMMAND_IDS = [
  'file.open',
  'file.openInPlace',
  'file.properties',
  'file.print',
  'tools.close',
  'file.save',
  'file.saveAs',
  'file.close',
  'file.closeAll',
  'edit.undo',
  'edit.redo',
  'edit.copy',
  'edit.selectAll',
  'edit.deselect',
  'edit.find',
  'edit.findNext',
  'edit.findPrev',
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
  'view.documentView',
  'view.organizeAll',
  'view.goToPage',
  'view.rotateCW',
  'view.rotateCCW',
  'view.toolsPane',
  'document.insertBlankPage',
  'document.insertFromFile',
  'document.combineFiles',
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
  'tools.batchOcr',
  'file.createPdfFromPostScript',
  ...CANVAS_TOOLS.map((t) => `tools.${t}` as const),
  ...OPERATIONS.map((op) => `tools.panel.${op}` as const),
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
      // Toggle semantics: re-picking the armed mode exits to Select.
      const next = tool !== 'select' && state.ui.tool === tool ? 'select' : tool;
      // Arming a mode OPENS its owning tool, so `activeToolId` can never be
      // behind what the canvas is actually doing — the secondary toolbar reads
      // it, and a mode armed by a keybinding while no tool was open would
      // otherwise leave the strip absent with the canvas live.
      //
      // Only when ARMING. Disarming (toggle-off, Escape) leaves the tool open:
      // Escape means "stop drawing", not "close Comment" — Acrobat keeps the
      // toolbar up, and closing it would make Escape unrecoverable now that the
      // pill isn't there to re-arm from. `tools.close` is the way out.
      if (next !== 'select') {
        const owner = toolForCanvasTool(next);
        if (owner) dispatch({ type: 'UI_OPEN_TOOL', toolId: owner.id });
      }
      dispatch({ type: 'UI_SET_TOOL', tool: next });
    },
  };
}

function panelCommand(op: Operation): Command {
  return {
    title: OPERATION_TITLES[op],
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

/**
 * The extra ACTIONS each tool's secondary toolbar offers, beyond its modes.
 *
 * Total over ToolId, so a new tool must say what its strip does — even if the
 * answer is "nothing" — rather than silently getting an empty one.
 *
 * Modes are NOT listed here: they come from `canvasTools`, which already
 * declares them. Listing them again would be a second copy to keep in step,
 * and this milestone has spent enough on those.
 *
 * Deliberately absent: the pending-state buttons ("Fill 3 fields", "Redact 2
 * regions"). They aren't tool options — they report queued work, and the canvas
 * invariant is that pending state is never invisible, so they must not vanish
 * when a tool closes. They stay in the floating cluster.
 */
export const SECONDARY_TOOLBAR_ACTIONS: Record<ToolId, readonly CommandId[]> = {
  organize: [],
  comment: ['tools.close'],
  edit: ['tools.close'],
  fillsign: ['tools.close'],
  prepareform: ['tools.close'],
  redact: ['tools.close'],
  ocr: [],
  compare: [],
  protect: [],
  optimize: [],
  repair: [],
  watermark: [],
  headerfooter: [],
  pagebox: [],
  export: [],
};

export const COMMANDS: Record<CommandId, Command> = {
  'file.open': {
    title: 'Open…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => void ctx.app!.openFiles(),
  },
  // Not in any menu — this is the panels' "Open a PDF to …" button. The same
  // open as file.open (decryption, recents, the ghost upgrade and its commit
  // gate), minus the tab jump: it hands the PANEL a file rather than asking to
  // go and read it. A command rather than a hook-local implementation because
  // that is the one entry point every caller shares — the hook-local copy this
  // replaces diverged from the real open FOUR times, and the last divergence
  // meant a password-protected PDF could not be opened from a panel at all
  // (including, absurdly, the Decrypt panel).
  'file.openInPlace': {
    title: 'Open…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => void ctx.app!.openFilesInPlace(),
  },
  // Leave the active tool: disarm its mode, back to plain Select. The secondary
  // toolbar's own exit. The pill made this implicit — you clicked "Select",
  // which only reads as "leave the tool" if you already know the eight modes
  // were grouped into tools, which was the pill's whole problem.
  // File ▸ Properties… (Ctrl+D) — § 3.2. Needs a document it can describe.
  'file.properties': {
    title: 'Properties…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.openProperties(),
  },
  // File ▸ Print… (Ctrl+P) — M-P, § 3.4. Needs a document to print; a ghost
  // import source is refused like everywhere else (hasActiveFile).
  'file.print': {
    title: 'Print…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.openPrint(),
  },
  'tools.close': {
    title: 'Close Tool',
    // Enabled while a canvas tool is OPEN — not merely while a mode is armed.
    // Escape disarms the mode and leaves the tool up; this is what puts it away.
    when: (ctx) =>
      isDocTab(ctx.state.ui.focusedTab) &&
      (toolById(ctx.state.ui.activeToolId ?? '')?.canvasTools?.length ?? 0) > 0,
    // openTool(null) clears activeToolId AND disarms, in the one place that owns
    // that pairing (CLAUDE.md § Design invariants).
    run: ({ dispatch }) => dispatch({ type: 'UI_OPEN_TOOL', toolId: null }),
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
  // Copy the reading view's live TEXT selection (§ 9.1 Edit ▸ Copy). Ctrl+C
  // itself is native (the text layer is real DOM text and stays unbound in
  // the keymap, § 9.2) — this is the menu's honest twin. `when` reads the DOM
  // selection because a selection isn't app state; menus resolve enablement
  // when they open, which is exactly when it's needed.
  'edit.copy': {
    title: 'Copy',
    when: (ctx) =>
      inCanvas(ctx) &&
      typeof window !== 'undefined' &&
      !(window.getSelection()?.isCollapsed ?? true),
    run: () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString();
      void navigator.clipboard.writeText(text).catch(() => {
        // The selection survives the menu click; execCommand copies it even
        // with focus elsewhere — the fallback for a denied async clipboard.
        document.execCommand('copy');
      });
    },
  },
  // F3 / Shift+F3 (+ Ctrl+G aliases): step the Find cursor; when the bar
  // isn't up, F3 OPENS it (Acrobat's own behavior) instead of doing nothing.
  'edit.findNext': {
    title: 'Find Next',
    when: (ctx) => ctx.canvas !== null,
    run: (ctx) => {
      const f = ctx.canvas!.find;
      if (f.isOpen()) f.next();
      else f.open();
    },
  },
  'edit.findPrev': {
    title: 'Find Previous',
    when: (ctx) => ctx.canvas !== null,
    run: (ctx) => {
      const f = ctx.canvas!.find;
      if (f.isOpen()) f.prev();
      else f.open();
    },
  },
  'edit.preferences': {
    title: 'Preferences…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openPreferences(),
  },
  // Phase 6 — needs NO document (operates on a picked folder tree, outside
  // the workspace entirely), so its only gate is App being mounted.
  'tools.batchOcr': {
    title: 'Batch OCR Folder…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openBatchOcr(),
  },
  // Phase 8 — same no-document shape: distills a PICKED PostScript file.
  'file.createPdfFromPostScript': {
    title: 'Create PDF from PostScript…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openCreatePdf(),
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
  // § 6.1's two modes, § 9.1's View items. "Organize All Documents" IS the
  // board (it renders every open document — the cross-doc superpower); the
  // per-doc "Organize View" menu item is the Organize tool (tools.open.organize).
  'view.documentView': {
    title: 'Document View',
    when: inCanvas,
    run: ({ dispatch }) => dispatch({ type: 'UI_SET_DOC_VIEW_MODE', mode: 'document' }),
  },
  'view.organizeAll': {
    title: 'Organize All Documents',
    when: inCanvas,
    run: ({ dispatch }) => dispatch({ type: 'UI_SET_DOC_VIEW_MODE', mode: 'organize' }),
  },
  // Rotate View (M6.1, § 9.1) — render-only quarter-turns of the READING
  // display, per file; never the page tier (that's Document ▸ Rotate Pages…,
  // and the two menu labels carry Acrobat's own distinction). Reading-view
  // only: the board is where real rotation lives.
  'view.rotateCW': {
    title: 'Rotate View Clockwise',
    when: (ctx) =>
      inCanvas(ctx) && ctx.state.ui.docViewMode === 'document' && hasActiveFile(ctx.state),
    run: ({ state, dispatch }) =>
      dispatch({ type: 'UI_ROTATE_VIEW', path: showableDoc(state)!, delta: 90 }),
  },
  'view.rotateCCW': {
    title: 'Rotate View Counterclockwise',
    when: (ctx) =>
      inCanvas(ctx) && ctx.state.ui.docViewMode === 'document' && hasActiveFile(ctx.state),
    run: ({ state, dispatch }) =>
      dispatch({ type: 'UI_ROTATE_VIEW', path: showableDoc(state)!, delta: 270 }),
  },
  // Shift+F4 (§ 9.2, verified at the M6.5 freeze): Acrobat's "open or close
  // the Task pane". Ours is the Tools tab — toggle to it, and back to the
  // document you were on (or Home when none).
  'view.toolsPane': {
    title: 'Tools Pane',
    run: ({ state, dispatch }) => {
      if (state.ui.focusedTab === 'tools') {
        const doc = showableDoc(state);
        dispatch({ type: 'UI_FOCUS_TAB', tab: doc ? { doc } : 'home' });
      } else {
        dispatch({ type: 'UI_FOCUS_TAB', tab: 'tools' });
      }
    },
  },
  // Ctrl+Shift+N (§ 9.2): land the caret in the reading view's page box.
  'view.goToPage': {
    title: 'Go to Page…',
    when: (ctx) =>
      inCanvas(ctx) && ctx.state.ui.docViewMode === 'document' && ctx.canvas !== null,
    run: (ctx) => void ctx.canvas!.goToPage(),
  },
  // Document ▸ Insert Pages ▸ … (§ 9.1/§ 9.3). Both insert AFTER the page
  // being read (insertAnchor) and both ride the byte-only import machinery,
  // so they're page-tier undoable like a drag-in.
  'document.insertBlankPage': {
    title: 'Blank Page',
    when: (ctx) => ctx.app !== null && insertAnchor(ctx.state) !== null,
    run: (ctx) => void ctx.app!.insertBlankPage(),
  },
  'document.insertFromFile': {
    title: 'From File…',
    when: (ctx) => ctx.app !== null && insertAnchor(ctx.state) !== null,
    run: (ctx) => void ctx.app!.insertPagesFromFile(),
  },
  // Discoverability alias for the launch-thread's "merge pages" ask
  // (2026-07-18): the SAME byte-only import machinery as Insert Pages,
  // targeted at the END of the active document — the name users actually
  // search the menus for. Direct-manipulation merging on the board is
  // unchanged; this is the menu path to the same outcome.
  'document.combineFiles': {
    title: 'Combine Files…',
    when: (ctx) => ctx.app !== null && insertAnchor(ctx.state) !== null,
    run: (ctx) => void ctx.app!.combineFiles(),
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
    OPERATIONS.map((op) => [`tools.panel.${op}`, panelCommand(op)]),
  ) as Record<`tools.panel.${Operation}`, Command>),
  // One command per TOOL (§ 7) — what the Tools menu and the Tools Center tiles
  // both invoke, so the two can never disagree about what a tool opens.
  ...(Object.fromEntries(
    TOOL_DEFS.map((tool) => [
      `tools.open.${tool.id}`,
      {
        title: tool.title,
        // The two-entry-point question M5.1 flagged here, settled: EVERY tool
        // sets `activeToolId` when opened, ops-less ones included. It is "the
        // tool that is open", full stop — one answer, not one per surface.
        //
        // (An earlier draft of this comment claimed the opposite, and stayed
        // there for a commit after the code changed underneath it. `activeToolId`
        // is what the secondary toolbar reads, so Escape can disarm the mode
        // without closing the tool — which is why the ops-less branch had to
        // start setting it.)
        //
        // What each surface does with it differs, and that's the actual answer:
        // the DOC tab's strip shows the tool if it drives the canvas; the TOOLS
        // tab shows its pane if it has ops, and an honest "this works on the
        // page" fence if it doesn't.
        //
        // A tool whose work happens ON the page needs a page to show. Not just
        // "activeFileId is set": an import-only source is bytes with no tab, and
        // `focusTab` rejects it — leaving us to arm a mode on a document the
        // user can't see. (CLOSE_FILE can leave a ghost import-only file as the
        // active one, so this is reachable, not theoretical.)
        when: (ctx) => !worksOnPage(tool) || showableDoc(ctx.state) !== null,
        run: (ctx) => {
          const { state, dispatch } = ctx;
          const path = showableDoc(state);
          // OPENING A TOOL GOES WHERE ITS WORK IS. One rule, and it is the whole
          // of the destination logic:
          //
          //   owns canvas modes, or has no ops  ⇒  the DOCUMENT
          //   otherwise (a form to fill in)     ⇒  the TOOLS tab
          //
          // Fill & Sign and Prepare Form have BOTH ops and modes, and the old
          // ops-first test sent them to the Tools tab — so picking either from a
          // document yanked you off the page before arming, and you had to click
          // back to use the mode it had just armed. The pill hid that, because
          // its Fill/Sign/+Field buttons were always there to re-arm with; the
          // pill is gone, so the detour became the only path. Their work is on
          // the page (their panes are still one Tools-tab click away).
          if (worksOnPage(tool)) {
            if (!path) return; // unreachable: `when` requires one.
            dispatch({ type: 'UI_FOCUS_TAB', tab: { doc: path } });
          } else {
            dispatch({ type: 'UI_FOCUS_TAB', tab: 'tools' });
          }
          // Focus FIRST, then open: leaving doc land resets the mode, so an arm
          // before the focus would be stomped by its own command.
          //
          // One dispatch either way, because the reducer's `openTool` owns the
          // rule — a tool with ops goes through UI_SET_ACTIVE_OP (which lands
          // the pane on its first op AND re-homes activeToolId AND arms the
          // mode); a tool without goes direct. Doing any of it here too would be
          // a second, stompable copy.
          if (tool.ops.length > 0) dispatch({ type: 'UI_SET_ACTIVE_OP', op: tool.ops[0] });
          else dispatch({ type: 'UI_OPEN_TOOL', toolId: tool.id });
          // Scan & OCR's whole surface is Find's "Make searchable" (2m), so the
          // tool opens Find rather than inventing a second entry point for it.
          // Deferred, not called on ctx.canvas: the focus above has only been
          // SCHEDULED, so the canvas is still unmounted right now.
          if (tool.id === 'ocr' && path) openFindWhenCanvasReady(ctx.canvas, path);
        },
      } satisfies Command,
    ]),
  ) as Record<`tools.open.${(typeof TOOL_IDS)[number]}`, Command>),
};
