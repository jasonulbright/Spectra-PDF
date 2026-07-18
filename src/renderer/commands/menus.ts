// The menu tree as DATA (19-phase4 § 4.1 / § 9.1). Every static item
// references a registered command id — the menu layer never holds a handler.
// Dynamic sections (Open Recent, the Window document list) are item factories
// over CommandContext. The MenuBar component renders this; a vitest asserts
// every referenced id is registered and that displayed shortcuts come from
// the keymap table (so a menu label can never drift from its binding).
import { isDocTab } from '../state/types';
import { tabFiles } from '../state/selectors';
import type { CommandContext } from './types';
import type { CommandId } from './registry';
import { NAV_PANEL_IDS } from './navpanels';
import { TOOL_DEFS } from './tools';

// A leaf the renderer can draw without further resolution. `command` items are
// resolved against COMMANDS (title, enablement, shortcut) by the renderer;
// `action` items carry an ad-hoc run (dynamic, path-parameterized — exempt
// from the registered-command integrity check).
export type MenuNode =
  | { kind: 'command'; command: CommandId; testid?: string }
  | { kind: 'separator' }
  | { kind: 'submenu'; id: string; label: string; items: MenuNode[] }
  | { kind: 'dynamic'; id: string; build: (ctx: CommandContext) => MenuActionLeaf[] };

export interface MenuActionLeaf {
  label: string;
  testid?: string;
  disabled?: boolean;
  run: (ctx: CommandContext) => void;
}

export interface MenuDef {
  id: string;
  label: string;
  items: MenuNode[];
}

const sep: MenuNode = { kind: 'separator' };
const cmd = (command: CommandId, testid?: string): MenuNode => ({ kind: 'command', command, testid });

// Recent files (File ▸ Open Recent). A path item opens + focuses that doc.
const recentSubmenu: MenuNode = {
  kind: 'submenu',
  id: 'file-recent',
  label: 'Open Recent',
  items: [
    {
      kind: 'dynamic',
      id: 'recent-list',
      build: (ctx) => {
        const recent = ctx.state.ui.recentFiles;
        if (recent.length === 0) {
          return [{ label: 'No Recent Files', disabled: true, run: () => {} }];
        }
        return recent.slice(0, 10).map(({ path }) => ({
          label: path.split(/[\\/]/).pop() || path,
          testid: 'menuitem-recent',
          run: (c: CommandContext) => void c.app?.openPath(path),
        }));
      },
    },
    sep,
    cmd('file.clearRecent', 'menuitem-file-clear-recent'),
  ],
};

// Tools menu — the twelve TOOLS (§ 9.1), in the Tools Center's own order.
//
// It used to list the 19 operations under the RAIL's five groups (Pages /
// Transform / Repair / Security / Content). The rail was deleted in M5.2 but its
// taxonomy outlived it here — and that taxonomy is precisely what M5.1 removed:
// it named what the ENGINE does, not what the user came to do. Generated from
// TOOL_DEFS, so the menu, the tile grid and the task panes cannot disagree about
// which tools exist.
//
// It is also the doc-tab entry point the floating pill used to be: the pill was
// the only way to arm Comment or Redact without leaving the document, and it
// retired into the secondary toolbar, which only appears once a tool is already
// armed. This is how you arm one.
const toolsItems: MenuNode[] = [
  ...TOOL_DEFS.map((t): MenuNode => cmd(`tools.open.${t.id}`, `menuitem-tool-${t.id}`)),
  // Phase 6 — the one Tools entry that is NOT a tool tile: it needs no open
  // document (the tiles are disabled without one), so it lives here where it
  // stays reachable from an empty workspace.
  sep,
  cmd('tools.batchOcr', 'menuitem-tools-batch-ocr'),
];

// Window ▸ open-document list — focus that doc's tab. importOnly sources
// (2n.3) have no tab and are excluded (mirrors registry.tabFiles).
const windowDocList: MenuNode = {
  kind: 'dynamic',
  id: 'window-docs',
  build: (ctx) => {
    const docs = tabFiles(ctx.state);
    if (docs.length === 0) return [{ label: 'No Open Documents', disabled: true, run: () => {} }];
    return docs.map((f, i) => ({
      label: `${i + 1}  ${f.name}`,
      testid: 'menuitem-window-doc',
      disabled: isDocTab(ctx.state.ui.focusedTab) && ctx.state.ui.focusedTab.doc === f.path,
      run: (c: CommandContext) => c.dispatch({ type: 'UI_FOCUS_TAB', tab: { doc: f.path } }),
    }));
  },
};

export const MENUS: MenuDef[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      cmd('file.open', 'menuitem-file-open'),
      recentSubmenu,
      sep,
      cmd('file.save', 'menuitem-file-save'),
      cmd('file.saveAs', 'menuitem-file-save-as'),
      cmd('file.close', 'menuitem-file-close'),
      cmd('file.closeAll', 'menuitem-file-close-all'),
      sep,
      {
        kind: 'submenu',
        id: 'file-export',
        label: 'Export',
        // "Text…" is the extract-text pane — the same op the Document menu
        // reaches; § 9.1 lists both entry points.
        items: [cmd('tools.panel.extract_text', 'menuitem-file-export-text')],
      },
      sep,
      cmd('file.print', 'menuitem-file-print'),
      sep,
      cmd('file.properties', 'menuitem-file-properties'),
      sep,
      cmd('file.exit', 'menuitem-file-exit'),
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      cmd('edit.undo', 'menuitem-edit-undo'),
      cmd('edit.redo', 'menuitem-edit-redo'),
      sep,
      cmd('edit.copy', 'menuitem-edit-copy'),
      sep,
      cmd('edit.selectAll', 'menuitem-edit-select-all'),
      cmd('edit.deselect', 'menuitem-edit-deselect'),
      sep,
      cmd('edit.find', 'menuitem-edit-find'),
      cmd('view.navPanel.search', 'menuitem-edit-search'),
      sep,
      cmd('edit.preferences', 'menuitem-edit-preferences'),
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      {
        kind: 'submenu',
        id: 'view-nav-panels',
        label: 'Navigation Panels',
        items: [
          ...NAV_PANEL_IDS.map(
            (id) => cmd(`view.navPanel.${id}`, `menuitem-navpanel-${id}`),
          ),
          sep,
          cmd('view.navPane', 'menuitem-view-nav-pane'),
        ],
      },
      cmd('view.toolsPane', 'menuitem-view-tools-pane'),
      sep,
      {
        kind: 'submenu',
        id: 'view-zoom',
        label: 'Zoom',
        items: [
          cmd('view.zoomIn', 'menuitem-view-zoom-in'),
          cmd('view.zoomOut', 'menuitem-view-zoom-out'),
          sep,
          cmd('view.actualSize', 'menuitem-view-actual-size'),
          cmd('view.fit', 'menuitem-view-fit'),
          cmd('view.fitWidth', 'menuitem-view-fit-width'),
        ],
      },
      sep,
      {
        kind: 'submenu',
        id: 'view-rotate',
        label: 'Rotate View',
        items: [
          cmd('view.rotateCW', 'menuitem-view-rotate-cw'),
          cmd('view.rotateCCW', 'menuitem-view-rotate-ccw'),
        ],
      },
      sep,
      cmd('view.documentView', 'menuitem-view-document'),
      cmd('tools.open.organize', 'menuitem-view-organize'),
      cmd('view.organizeAll', 'menuitem-view-organize-all'),
    ],
  },
  {
    id: 'document',
    label: 'Document',
    items: [
      {
        kind: 'submenu',
        id: 'document-insert',
        label: 'Insert Pages',
        items: [
          cmd('document.insertFromFile', 'menuitem-document-insert-file'),
          cmd('document.insertBlankPage', 'menuitem-document-insert-blank'),
        ],
      },
      cmd('document.combineFiles', 'menuitem-document-combine'),
      sep,
      cmd('tools.panel.delete', 'menuitem-document-delete'),
      cmd('tools.panel.rotate', 'menuitem-document-rotate'),
      cmd('tools.panel.split', 'menuitem-document-split'),
      cmd('tools.panel.extract_text', 'menuitem-document-extract-text'),
      sep,
      cmd('tools.panel.watermark', 'menuitem-document-watermark'),
      sep,
      cmd('document.applyPageEdits', 'menuitem-document-apply-page-edits'),
      sep,
      cmd('tools.open.ocr', 'menuitem-document-make-searchable'),
    ],
  },
  { id: 'tools', label: 'Tools', items: toolsItems },
  {
    id: 'window',
    label: 'Window',
    items: [
      cmd('window.nextTab', 'menuitem-window-next-tab'),
      cmd('window.prevTab', 'menuitem-window-prev-tab'),
      sep,
      windowDocList,
      sep,
      cmd('window.minimizeToTray', 'menuitem-window-minimize-tray'),
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: [
      cmd('help.about', 'menuitem-help-about'),
      cmd('help.licenses', 'menuitem-help-licenses'),
      cmd('help.checkUpdates', 'menuitem-help-check-updates'),
    ],
  },
];

/** Every registered-command id referenced anywhere in the tree (for the
 * integrity test; dynamic action leaves are excluded by design). */
export function menuCommandIds(nodes: MenuNode[] = MENUS.flatMap((m) => m.items)): CommandId[] {
  const out: CommandId[] = [];
  for (const n of nodes) {
    if (n.kind === 'command') out.push(n.command);
    else if (n.kind === 'submenu') out.push(...menuCommandIds(n.items));
  }
  return out;
}
