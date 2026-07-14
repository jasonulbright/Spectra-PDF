// The nav-pane component registry (Phase 4 M3). Maps each AVAILABLE panel id
// (commands/navpanels — grows per sub-slice) to its icon + component. Must
// cover exactly NAV_PANEL_IDS; a `satisfies` check keeps them in lockstep so
// an icon-strip button never renders without a component (completeness rule).
import type { NavPanelDef } from './types';
import { NAV_PANEL_TITLES, type AvailableNavPanel } from '../../commands/navpanels';
import { PagesPanel } from './PagesPanel';
import { BookmarksPanel } from './BookmarksPanel';
import { SearchPanel } from './SearchPanel';

export const NAV_PANEL_DEFS = [
  { id: 'pages', title: NAV_PANEL_TITLES.pages, icon: 'pages', Component: PagesPanel },
  { id: 'bookmarks', title: NAV_PANEL_TITLES.bookmarks, icon: 'bookmarks', Component: BookmarksPanel },
  // Reuses the magnifier glyph — Acrobat marks both Find and Search with one.
  { id: 'search', title: NAV_PANEL_TITLES.search, icon: 'find', Component: SearchPanel },
] as const satisfies readonly NavPanelDef[];

export function navPanelDef(id: string): NavPanelDef | undefined {
  return NAV_PANEL_DEFS.find((d) => d.id === (id as AvailableNavPanel));
}
