// The command registry. COMMANDS is a TOTAL record over the
// finite CommandId union — adding an id without a command (or a command
// without an id) fails tsc, the tool-icons GLYPHS precedent. Menus, toolbars,
// tool tiles and the keymap reference these ids; nothing re-implements a
// handler. Every action is registered here; the chrome only
// *references* what is here.
import { isDocTab } from '../state/types';
import { insertAnchor, showableDoc, tabFiles } from '../state/selectors';
import type { AppState, CanvasTool, FocusedTab, NavPanelId } from '../state/types';
import type { Command, CommandContext, CommandNamespace } from './types';
import { NAV_PANEL_IDS, NAV_PANEL_TITLES } from './navpanels';
import { TOOL_DEFS, TOOL_IDS, toolById, toolForCanvasTool, worksOnPage, type ToolId } from './tools';
import { OPERATIONS, OPERATION_TITLES, type Operation } from './operations';
import { openFindWhenCanvasReady } from './find-intent';
import {
  toggleGrid,
  toggleGuides,
  toggleRulers,
  toggleSnapping,
} from '../lib/snap-settings';

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

/** The visible tab order: Home | one tab per open document. (The Tools
 * pseudo-tab is retired — ops panels live in the dock.) */
export function tabOrder(state: AppState): FocusedTab[] {
  return ['home', ...tabFilePaths(state).map((doc) => ({ doc }))];
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
  'formfields', 'edit', 'addtext', 'addimage', 'measuredist', 'measureperim', 'measurearea',
  'measurecal', 'shape', 'callout', 'note', 'inkerase', 'zoommarquee', 'cropdraw', 'count',
  'outputpreview', 'flattenpreview', 'tablereview', 'beaddraw',
] as const;

export const TOOL_TITLES: Record<CanvasTool, string> = {
  select: 'Select', hand: 'Hand', highlight: 'Highlight', freetext: 'Text', ink: 'Draw',
  stamp: 'Stamp', redact: 'Redact', signature: 'Sign', forms: 'Fill Fields',
  formfields: 'Add Field', edit: 'Select Image', addtext: 'Add Text',
  addimage: 'Add Image',
  measuredist: 'Distance', measureperim: 'Perimeter', measurearea: 'Area', measurecal: 'Calibrate',
  shape: 'Shape', callout: 'Callout', note: 'Sticky Note', inkerase: 'Eraser',
  zoommarquee: 'Marquee Zoom', cropdraw: 'Draw Crop', count: 'Count',
  outputpreview: 'Separation Preview',
  flattenpreview: 'Flattener Preview',
  tablereview: 'Table Review',
  beaddraw: 'Draw Article Box',
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
  'file.sendToEmail',
  'tools.close',
  'file.save',
  'file.saveAs',
  'file.exportWord',
  'file.exportRtf',
  'file.exportOdt',
  'file.exportHtml',
  'file.exportXhtml',
  'file.exportText',
  'file.exportExcel',
  'file.exportPowerpoint',
  'file.exportImages',
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
  'view.navPane',
  ...NAV_PANEL_IDS.map((id) => `view.navPanel.${id}` as const),
  'view.zoomIn',
  'view.zoomOut',
  'view.fit',
  'view.actualSize',
  'view.fitWidth',
  'view.documentView',
  'view.presentation',
  'view.readingMode',
  'view.propertiesBar',
  'view.snapping',
  'view.rulers',
  'view.grid',
  'view.guides',
  'view.clearGuides',
  'view.customizeToolbar',
  'view.singlePage',
  'view.twoUp',
  'view.twoUpCover',
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
  'window.split',
  'window.spreadsheetSplit',
  'window.minimizeToTray',
  'help.about',
  'help.licenses',
  'help.checkUpdates',
  'file.exit',
  'file.clearRecent',
  'tools.batchOcr',
  'tools.diskRedact',
  'tools.formPrepFolder',
  'tools.folderExport',
  'tools.scheduledRuns',
  'tools.watchedFolders',
  'file.createPdf',
  ...CANVAS_TOOLS.map((t) => `tools.${t}` as const),
  ...OPERATIONS.map((op) => `tools.panel.${op}` as const),
  ...TOOL_IDS.map((id) => `tools.open.${id}` as const),
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

// Every id must live under a menu-bar namespace.
COMMAND_IDS satisfies readonly CommandNamespace[];

// "In the document board" = a doc tab is focused (the canvas board is the
// pane content). Tool + selection commands only make sense there.
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
      // Escape means "stop drawing", not "close Comment". Closing the toolbar
      // would make Escape unrecoverable now that the
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
    run: (ctx) => {
      // With a visible document, the panel opens in the right dock on that tab
      // so the document remains visible while the form is filled in. With no
      // document, the picker runs first and the tool opens on the selected file.
      //
      // UI_SET_ACTIVE_OP opens the TOOL that hosts this operation too, so a menu
      // item and a Tools Center tile land in the same place. That re-homing
      // lives in the reducer, not here, so it holds for every dispatcher (the
      // e2e harness sets activeOp directly).
      const path = showableDoc(ctx.state);
      if (path) {
        ctx.dispatch({ type: 'UI_FOCUS_TAB', tab: { doc: path } });
        ctx.dispatch({ type: 'UI_SET_ACTIVE_OP', op });
        ctx.dispatch({ type: 'UI_SET_TOOL_DOCK_OPEN', open: true });
      } else {
        void openThenSeat(ctx, op);
      }
    },
  };
}

/** Shared docless-tool flow: open the picker via the app
 * services; once a document lands (openFiles focuses its tab itself — the
 * openByPaths funnel), seat the op and open the dock. A cancelled picker
 * leaves everything untouched. */
function openThenSeat(ctx: CommandContext, op: Operation): Promise<void> {
  if (!ctx.app) return Promise.resolve();
  return ctx.app.openFiles().then((opened) => {
    if (!opened) return;
    ctx.dispatch({ type: 'UI_SET_ACTIVE_OP', op });
    ctx.dispatch({ type: 'UI_SET_TOOL_DOCK_OPEN', open: true });
  });
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
  // The detection surface is reachable from the page, not only from the dock:
  // the tool arms its canvas mode, so its panel is otherwise a click away in a
  // place the user is not looking.
  prepareform: ['tools.panel.prepareform', 'tools.close'],
  redact: ['tools.close'],
  measure: ['tools.close'],
  takeoff: ['tools.close'],
  actions: [],
  ocr: [],
  compare: [],
  protect: [],
  optimize: [],
  repair: [],
  watermark: [],
  headerfooter: [],
  // Pagebox owns the `cropdraw` mode, so its strip needs a way out.
  pagebox: ['tools.close'],
  pagelabels: [],
  attachments: [],
  portfolio: [],
  layers: [],
  accessibility: [],
  printproduction: [],
  links: [],
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
  // File ▸ Properties… (Ctrl+D). Needs a document it can describe.
  'file.properties': {
    title: 'Properties…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.openProperties(),
  },
  // File ▸ Print… (Ctrl+P). Needs a document to print; a ghost
  // import source is refused like everywhere else (hasActiveFile).
  'file.print': {
    title: 'Print…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.openPrint(),
  },
  // File ▸ Send To ▸ Email attaches the current document to a compose window
  // in the default desktop mail client.
  'file.sendToEmail': {
    title: 'Email…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => void ctx.app!.sendToEmail(),
  },
  'tools.close': {
    title: 'Close Tool',
    // Enabled while a canvas tool is OPEN — not merely while a mode is armed.
    // Escape disarms the mode and leaves the tool up; this is what puts it away.
    when: (ctx) =>
      isDocTab(ctx.state.ui.focusedTab) &&
      (toolById(ctx.state.ui.activeToolId ?? '')?.canvasTools?.length ?? 0) > 0,
    // openTool(null) clears activeToolId AND disarms, in the one place that owns
    // that pairing.
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
  // Export (bundled LibreOffice). Same enablement as Save As — an active
  // document. LibreOffice availability is handled engine-side: a missing
  // runtime surfaces as a clear operation-queue error, not a disabled menu, so
  // the capability is discoverable rather than silently absent.
  'file.exportWord': {
    title: 'Word (.docx)…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.exportDocument('docx'),
  },
  'file.exportRtf': {
    title: 'Rich Text (.rtf)…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.exportDocument('rtf'),
  },
  'file.exportOdt': {
    title: 'OpenDocument (.odt)…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.exportDocument('odt'),
  },
  'file.exportHtml': {
    title: 'Web Page (.html)…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.exportDocument('html'),
  },
  'file.exportXhtml': {
    title: 'XHTML (.xhtml)…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.exportDocument('xhtml'),
  },
  // The engine produces these three itself, so they stay available whether or
  // not LibreOffice is provisioned, and each takes options the others do not —
  // which is why they open a step rather than going straight to a save dialog.
  'file.exportText': {
    title: 'Plain Text (.txt)…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.openExportDocument('txt'),
  },
  'file.exportExcel': {
    title: 'Spreadsheet (.xlsx)…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.openExportDocument('xlsx'),
  },
  'file.exportPowerpoint': {
    title: 'Presentation (.pptx)…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.openExportDocument('pptx'),
  },
  'file.exportImages': {
    title: 'Images (PNG/JPEG/TIFF)…',
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.openExportImages(),
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
    // Ctrl+A selects pages in both views. Browser-native select-all over the
    // text layer is unsafe because the reading
    // view is VIRTUALIZED — only the pages within the scroll window have text
    // spans in the DOM at all — so native select-all can physically only reach
    // the handful of mounted pages. Ctrl+A then Ctrl+C would put a few pages of
    // text on the clipboard while the user believed they had copied the
    // document, silently and with no way to notice (regression). A
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
  // Copy the reading view's live TEXT selection (Edit ▸ Copy). Ctrl+C
  // itself is native (the text layer is real DOM text and stays unbound in
  // the keymap) — this is the menu's honest twin. `when` reads the DOM
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
  // F3 / Shift+F3 (+ Ctrl+G aliases) step the Find cursor. If the bar is
  // closed, F3 opens it instead of doing nothing.
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
  // Needs NO document (operates on a picked folder tree, outside
  // the workspace entirely), so its only gate is App being mounted.
  'tools.batchOcr': {
    title: 'Batch OCR Folder…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openBatchOcr(),
  },
  // Same no-document shape: it searches and redacts a picked folder tree by
  // path, and never opens a document to do it.
  'tools.diskRedact': {
    title: 'Search & Redact Folder…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openDiskRedact(),
  },
  // Same no-document shape: it analyses and prepares a picked folder tree by
  // path, and never opens a document to do it.
  'tools.formPrepFolder': {
    title: 'Prepare Forms in a Folder…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openFormPrepFolder(),
  },
  // Same no-document shape: it reads a picked folder tree by path and writes
  // the exports into a mirror, and never opens a document to do it.
  'tools.folderExport': {
    title: 'Export a Folder…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openFolderExport(),
  },
  // Request 5 — same no-document shape as Batch OCR: it manages schedules over
  // picked folder trees, nothing to do with what is open.
  'tools.scheduledRuns': {
    title: 'Scheduled Batch Runs…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openScheduledRuns(),
  },
  // Watched folders — same no-document shape: watches picked folder trees.
  'tools.watchedFolders': {
    title: 'Watched Folders…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openWatchedFolders(),
  },
  // Same no-document shape: builds a PDF from PICKED sources of any
  // accepted kind (images, Office/text/web, PostScript, blank pages). The old
  // `file.createPdfFromPostScript` id is REMOVED, not aliased: a stale id in a
  // registry that drives the menus, the Home tab and the command palette is a
  // fossil that outlives its own feature (the rebrand's clean-break precedent).
  'file.createPdf': {
    title: 'Create PDF…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openCreatePdf(),
  },
  'view.home': {
    title: 'Home',
    run: ({ dispatch }) => dispatch({ type: 'UI_FOCUS_TAB', tab: 'home' }),
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
  // there rather than doing something else (the `when` reads the
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
  // The two modes, as the View menu names them. "Organize All Documents" IS the
  // board (it renders every open document — the cross-doc superpower); the
  // per-doc "Organize View" menu item is the Organize tool (tools.open.organize).
  'view.documentView': {
    title: 'Document View',
    when: inCanvas,
    run: ({ dispatch }) => dispatch({ type: 'UI_SET_DOC_VIEW_MODE', mode: 'document' }),
  },
  'view.presentation': {
    title: 'Presentation (Full Screen)',
    // Only meaningful with a document to present (reading OR organize view —
    // it opens its own full-screen surface regardless of the current mode).
    when: (ctx) => ctx.app !== null && hasActiveFile(ctx.state),
    run: (ctx) => ctx.app!.openPresentation(),
  },
  // Reading mode (I.6): collapse the chrome around the document. Doc tabs
  // only — Home/Tools NEED their chrome, and leaving the doc tab clears it.
  'view.readingMode': {
    title: 'Reading Mode',
    when: inCanvas,
    run: ({ dispatch }) => dispatch({ type: 'UI_TOGGLE_READING_MODE' }),
  },
  // Properties bar: the selected annotation's
  // properties, under the secondary toolbar. Doc tabs only, like the strip.
  'view.propertiesBar': {
    title: 'Properties Bar',
    when: inCanvas,
    run: ({ dispatch }) => dispatch({ type: 'UI_TOGGLE_PROPERTIES_BAR' }),
  },
  // Snapping: the master toggle, mirrored from the status bar's
  // Snap segment so it is keyboard- and OmniSearch-reachable. It flips a
  // persisted PREFERENCE, not workspace state, so it writes through the
  // snap-settings store rather than dispatching. Doc tabs only — there is
  // nothing to snap without a page.
  'view.snapping': {
    title: 'Snapping',
    when: inCanvas,
    run: () => toggleSnapping(),
  },
  // Rulers / Grid / Guides — the same preference store for the
  // same reason. Show Grid and Snap to Grid stay SEPARATE (the grid type's
  // checkbox is in the Snap popover): drafting with a grid you snap to but
  // cannot see is an ordinary workflow, so the settings remain independent.
  'view.rulers': {
    title: 'Rulers',
    when: inCanvas,
    run: () => toggleRulers(),
  },
  'view.grid': {
    title: 'Grid',
    when: inCanvas,
    run: () => toggleGrid(),
  },
  'view.guides': {
    title: 'Guides',
    when: inCanvas,
    run: () => toggleGuides(),
  },
  // Clearing guides is the one of the four that is NOT a preference: guides
  // are per-document VIEW state owned by the canvas (the redaction-mark
  // lifetime), so this routes through CanvasServices like the find bar does.
  'view.clearGuides': {
    title: 'Clear Guides',
    when: (ctx) => inCanvas(ctx) && ctx.canvas !== null,
    run: (ctx) => ctx.canvas!.clearGuides(),
  },
  // Toolbar customization (I.6): per-item show/hide over the catalog. The
  // toolbar exists on every tab, so no canvas gate.
  'view.customizeToolbar': {
    title: 'Customize Toolbar…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.openCustomizeToolbar(),
  },
  // Page Display (I.6): single-page column vs two-up facing spreads, and the
  // cover convention. Layout is a reading-view property, so they gate on the
  // canvas exactly like Rotate View does.
  'view.singlePage': {
    title: 'Single Page',
    when: inCanvas,
    run: ({ dispatch }) => dispatch({ type: 'UI_SET_PAGE_LAYOUT', layout: 'single' }),
  },
  'view.twoUp': {
    title: 'Two-Page Spread',
    when: inCanvas,
    run: ({ dispatch }) => dispatch({ type: 'UI_SET_PAGE_LAYOUT', layout: 'two' }),
  },
  'view.twoUpCover': {
    title: 'Show Cover Page Separately',
    when: (ctx) => inCanvas(ctx) && ctx.state.ui.pageLayout === 'two',
    run: ({ dispatch }) => dispatch({ type: 'UI_TOGGLE_TWOUP_COVER' }),
  },
  'view.organizeAll': {
    title: 'Organize All Documents',
    when: inCanvas,
    run: ({ dispatch }) => dispatch({ type: 'UI_SET_DOC_VIEW_MODE', mode: 'organize' }),
  },
  // Rotate View applies render-only quarter-turns to the reading display per
  // file; it never changes the page tier. Reading-view
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
  // Shift+F4 toggles the Tools tab and returns to the
  // document you were on (or Home when none).
  'view.toolsPane': {
    title: 'Tools Pane',
    // The Tools TAB is gone — Shift+F4 toggles the right
    // dock on the document instead (the pane the panels actually live in).
    when: inCanvas,
    run: ({ state, dispatch }) =>
      dispatch({ type: 'UI_SET_TOOL_DOCK_OPEN', open: !state.ui.toolDock.open }),
  },
  // Ctrl+Shift+N: land the caret in the reading view's page box.
  'view.goToPage': {
    title: 'Go to Page…',
    when: (ctx) =>
      inCanvas(ctx) && ctx.state.ui.docViewMode === 'document' && ctx.canvas !== null,
    run: (ctx) => void ctx.canvas!.goToPage(),
  },
  // Document ▸ Insert Pages ▸ …. Both insert AFTER the page
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
  // Combine Files: opens the Combine dialog — a source list
  // that accepts everything Create PDF accepts, converts the non-PDF members
  // through the one `create_pdf` door, and lands the result either in a NEW
  // document or in one that is already open (the old behaviour, which is
  // still the byte-only import machinery Insert Pages uses).
  //
  // No longer gated on an insert anchor: "combine into a new PDF" needs no
  // open document, and gating it left the Home tab's own Combine action dead
  // on a cold start — the one moment a user is most likely to reach for it.
  'document.combineFiles': {
    title: 'Combine Files…',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => void ctx.app!.combineFiles(),
  },
  'document.deleteSelection': {
    title: 'Delete Selected Pages',
    when: (ctx) => hasSelection(ctx.state),
    run: ({ state, dispatch }) => {
      // Same pair the keyboard path has always run: batched delete, then clear —
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
  // Split view uses two stacked panes over the same
  // document, independent scroll/zoom. Document mode only — the organize
  // board is one d3 world with no honest second scroll position
  // (absent, not faked).
  'window.split': {
    title: 'Split',
    when: (ctx) =>
      inCanvas(ctx) && ctx.state.ui.docViewMode === 'document' && hasActiveFile(ctx.state),
    run: ({ dispatch }) => dispatch({ type: 'UI_TOGGLE_SPLIT_VIEW' }),
  },
  // Spreadsheet Split uses a 2×2 grid with frozen-pane scroll linking.
  'window.spreadsheetSplit': {
    title: 'Spreadsheet Split',
    when: (ctx) =>
      inCanvas(ctx) && ctx.state.ui.docViewMode === 'document' && hasActiveFile(ctx.state),
    run: ({ dispatch }) => dispatch({ type: 'UI_TOGGLE_SPREADSHEET_SPLIT' }),
  },
  'window.minimizeToTray': {
    title: 'Minimize to Tray',
    when: (ctx) => ctx.app !== null,
    run: (ctx) => ctx.app!.minimizeToTray(),
  },
  'help.about': {
    title: 'About Spectra PDF',
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
  // One command per TOOL — what the Tools menu and the Tools Center tiles
  // both invoke, so the two can never disagree about what a tool opens.
  ...(Object.fromEntries(
    TOOL_DEFS.map((tool) => [
      `tools.open.${tool.id}`,
      {
        title: tool.title,
        // The two-entry-point question, settled: EVERY tool
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
          // Scan & OCR is two halves — Find's "Make searchable" and the Scan
          // Enhancement pane — and opening the tool has always meant BOTH, so
          // this fires whichever destination the rule below picks. Deferred,
          // not called on ctx.canvas: the focus below has only been SCHEDULED,
          // so the canvas is still unmounted right now.
          if (tool.id === 'ocr' && path) openFindWhenCanvasReady(ctx.canvas, path);
          // OPENING A TOOL GOES WHERE ITS WORK IS. One rule, and it is the whole
          // of the destination logic (revision):
          //
          //   owns canvas modes, or has no ops  ⇒  the DOCUMENT (mode armed)
          //   a form to fill in, with a doc     ⇒  the DOCUMENT + the RIGHT DOCK
          //   a form to fill in, no doc open    ⇒  the legacy Tools tab
          //
          // Fill & Sign and Prepare Form have BOTH ops and modes; their work is
          // on the page, so they arm there (their panes are one dock-click
          // away). Ops tools used to yank the user off the document to a
          // full-page form — the frankenstein seam the relayout exists to kill;
          // the dock keeps the document visible. The Tools tab survives as the
          // no-document fallback.
          if (worksOnPage(tool)) {
            if (!path) return; // unreachable: `when` requires one.
            dispatch({ type: 'UI_FOCUS_TAB', tab: { doc: path } });
            // One dispatch either way, because the reducer's `openTool` owns
            // the rule — a tool with ops goes through UI_SET_ACTIVE_OP (which
            // seats its pane on the first op AND re-homes activeToolId AND
            // arms the mode); a tool without goes direct. Doing any of it here
            // too would be a second, stompable copy. The dock is NOT auto-
            // opened for these: they arm a canvas mode, and grabbing
            // horizontal space unbidden is the floating-pill class of mistake
            // — their pane is one dock-click away, already seated.
            if (tool.ops.length > 0) dispatch({ type: 'UI_SET_ACTIVE_OP', op: tool.ops[0] });
            else dispatch({ type: 'UI_OPEN_TOOL', toolId: tool.id });
            return;
          }
          // Focus FIRST, then open: leaving doc land resets the mode, so an arm
          // before the focus would be stomped by its own command. UI_SET_ACTIVE_OP
          // lands the pane on the tool's first op AND re-homes activeToolId.
          if (path) {
            dispatch({ type: 'UI_FOCUS_TAB', tab: { doc: path } });
            dispatch({ type: 'UI_SET_ACTIVE_OP', op: tool.ops[0] });
            dispatch({ type: 'UI_SET_TOOL_DOCK_OPEN', open: true });
          } else {
            void openThenSeat(ctx, tool.ops[0]);
          }
        },
      } satisfies Command,
    ]),
  ) as Record<`tools.open.${(typeof TOOL_IDS)[number]}`, Command>),
};
