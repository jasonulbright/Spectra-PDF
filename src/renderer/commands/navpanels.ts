// The nav panels that EXIST at this sub-slice. This list is the
// single source of truth for which icon-strip buttons, commands, and menu
// items appear — it grows as each panel lands (pages, bookmarks,
// signatures, search), so an icon/command never appears without a
// working panel (completeness rule). A leaf data module (no component
// imports) so both the command registry and the component registry can read
// it without a cycle.
import type { NavPanelId } from '../state/types';

export const NAV_PANEL_IDS = [
  'pages',
  'bookmarks',
  'articles',
  'attachments',
  'layers',
  'tags',
  'search',
  'signatures',
] as const satisfies readonly NavPanelId[];

export type AvailableNavPanel = (typeof NAV_PANEL_IDS)[number];

export const NAV_PANEL_TITLES: Record<AvailableNavPanel, string> = {
  pages: 'Pages',
  bookmarks: 'Bookmarks',
  articles: 'Articles',
  attachments: 'Attachments',
  layers: 'Layers',
  tags: 'Tags',
  search: 'Search',
  signatures: 'Signatures',
};
