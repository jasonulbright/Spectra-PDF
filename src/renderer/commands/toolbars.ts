// The main toolbar as DATA, now a CATALOG (toolbar
// customization). Groups of registered command ids (each with its glyph and a
// default-visibility flag); the user's show/hide overrides select which render
// (`visibleToolbarNodes`), with a separator between groups that kept at least
// one item. The MainToolbar component renders each as an icon button driven by
// the command (title→tooltip, when→disabled). Zoom and Find need the board's
// canvas services, so their commands self-disable off the board — no
// toolbar-side view gating needed. The icon rides on the item (not a side map)
// so a new entry can't compile without one (the GLYPHS precedent).
//
// Customization changes per-item visibility while preserving grouped order.
// Offering an item costs a registered command + a glyph; the optional
// nav-panel/tools entries below ship default-off, so the shipped look is
// unchanged until the user opts in.
import type { CommandId } from './registry';
import type { ChromeIconId } from '../components/chrome-icons';
import type { ToolbarOverrides } from '../lib/toolbar-layout';
import { isToolbarItemVisible } from '../lib/toolbar-layout';

export type ToolbarNode =
  | { kind: 'command'; command: CommandId; icon: ChromeIconId }
  | { kind: 'separator' };

export interface ToolbarCatalogItem {
  command: CommandId;
  icon: ChromeIconId;
  /** Visible with no user override — the shipped default toolbar. */
  byDefault: boolean;
}

export interface ToolbarCatalogGroup {
  id: string;
  /** Heading in the customize dialog. */
  label: string;
  items: ToolbarCatalogItem[];
}

const item = (command: CommandId, icon: ChromeIconId, byDefault = true): ToolbarCatalogItem => ({
  command,
  icon,
  byDefault,
});

export const TOOLBAR_CATALOG: readonly ToolbarCatalogGroup[] = [
  { id: 'file', label: 'File', items: [item('file.open', 'open'), item('file.save', 'save')] },
  { id: 'history', label: 'Undo & redo', items: [item('edit.undo', 'undo'), item('edit.redo', 'redo')] },
  {
    id: 'modes',
    label: 'Hand & select',
    // Hand / Select: how you hold vs. touch the page — the pair.
    items: [item('tools.hand', 'hand'), item('tools.select', 'cursor')],
  },
  {
    id: 'zoom',
    label: 'Zoom',
    items: [item('view.zoomOut', 'zoomOut'), item('view.fit', 'fit'), item('view.zoomIn', 'zoomIn')],
  },
  { id: 'find', label: 'Find', items: [item('edit.find', 'find')] },
  {
    id: 'panels',
    label: 'Panes',
    items: [
      item('view.navPanel.pages', 'pages', false),
      item('view.navPanel.bookmarks', 'bookmarks', false),
      item('view.navPanel.attachments', 'attachments', false),
      item('view.navPanel.layers', 'layers', false),
      item('view.navPanel.tags', 'tags', false),
      item('view.navPanel.signatures', 'signatures', false),
      // This ships visible because the tool dock's header has a close button;
      // hiding the entry would create a one-way door out of the
      // pane, reachable back only by knowing Shift+F4 or the View menu. The
      // top icon row is where a pane toggle belongs, and the catalog entry
      // already existed; only this default was hiding it.
      item('view.toolsPane', 'tools'),
    ],
  },
];

/** The toolbar the overrides produce: visible items in catalog order, one
 * separator between groups that kept anything. */
export function visibleToolbarNodes(overrides: ToolbarOverrides): ToolbarNode[] {
  const nodes: ToolbarNode[] = [];
  for (const group of TOOLBAR_CATALOG) {
    const kept = group.items.filter((i) => isToolbarItemVisible(i.command, i.byDefault, overrides));
    if (kept.length === 0) continue;
    if (nodes.length > 0) nodes.push({ kind: 'separator' });
    for (const i of kept) nodes.push({ kind: 'command', command: i.command, icon: i.icon });
  }
  return nodes;
}

/** Every registered id the catalog can offer (integrity test). */
export function toolbarCommandIds(): CommandId[] {
  return TOOLBAR_CATALOG.flatMap((g) => g.items.map((i) => i.command));
}
