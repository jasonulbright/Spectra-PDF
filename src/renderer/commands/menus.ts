// The menu tree as DATA (19-phase4 § 4.1 / § 9.1). Every static item
// references a registered command id — the menu layer never holds a handler.
// Dynamic sections (Open Recent, the Window document list) are item factories
// over CommandContext. The MenuBar component renders this; a vitest asserts
// every referenced id is registered and that displayed shortcuts come from
// the keymap table (so a menu label can never drift from its binding).
import { isDocTab } from '../state/types';
import type { CommandContext } from './types';
import type { CommandId } from './registry';

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
        return recent.slice(0, 10).map((path) => ({
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

// Tools menu — the 20 panel commands grouped by the sidebar's five groups.
const toolsGroups: { label: string; ops: CommandId[] }[] = [
  { label: 'Pages', ops: ['tools.panel.split', 'tools.panel.rotate', 'tools.panel.delete'] },
  {
    label: 'Transform',
    ops: [
      'tools.panel.compress',
      'tools.panel.grayscale',
      'tools.panel.optimize',
      'tools.panel.pdfa',
      'tools.panel.pdf_version',
    ],
  },
  { label: 'Repair', ops: ['tools.panel.repair', 'tools.panel.rebuild', 'tools.panel.recover'] },
  { label: 'Security', ops: ['tools.panel.encrypt', 'tools.panel.decrypt'] },
  {
    label: 'Content',
    ops: [
      'tools.panel.extract_text',
      'tools.panel.outline',
      'tools.panel.watermark',
      'tools.panel.forms',
      'tools.panel.compare',
      'tools.panel.signatures',
      'tools.panel.metadata',
    ],
  },
];

const toolsItems: MenuNode[] = toolsGroups.flatMap((g, i) => [
  ...(i > 0 ? [sep] : []),
  ...g.ops.map((op) => cmd(op)),
]);

// Window ▸ open-document list — focus that doc's tab. importOnly sources
// (2n.3) have no tab and are excluded (mirrors registry.tabFiles).
const windowDocList: MenuNode = {
  kind: 'dynamic',
  id: 'window-docs',
  build: (ctx) => {
    const docs = [...ctx.state.files.values()].filter((f) => !f.importOnly);
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
      cmd('edit.selectAll', 'menuitem-edit-select-all'),
      cmd('edit.deselect', 'menuitem-edit-deselect'),
      sep,
      cmd('edit.find', 'menuitem-edit-find'),
      cmd('edit.preferences', 'menuitem-edit-preferences'),
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      cmd('view.zoomIn', 'menuitem-view-zoom-in'),
      cmd('view.zoomOut', 'menuitem-view-zoom-out'),
      cmd('view.fit', 'menuitem-view-fit'),
    ],
  },
  {
    id: 'document',
    label: 'Document',
    items: [
      cmd('tools.panel.rotate', 'menuitem-document-rotate'),
      cmd('tools.panel.delete', 'menuitem-document-delete'),
      cmd('tools.panel.split', 'menuitem-document-split'),
      sep,
      cmd('tools.panel.extract_text', 'menuitem-document-extract-text'),
      cmd('tools.panel.watermark', 'menuitem-document-watermark'),
      sep,
      cmd('document.applyPageEdits', 'menuitem-document-apply-page-edits'),
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
