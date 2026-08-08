// The nav-pane component registry. Maps each AVAILABLE panel id
// (commands/navpanels — grows per sub-slice) to its icon + component. Must
// cover exactly NAV_PANEL_IDS; a `satisfies` check keeps them in lockstep so
// an icon-strip button never renders without a component (completeness rule).
import type { NavPanelDef } from './types';
import { NAV_PANEL_TITLES, type AvailableNavPanel } from '../../commands/navpanels';
import { PagesPanel } from './PagesPanel';
import { BookmarksPanel } from './BookmarksPanel';
import { ArticlesPanel } from './ArticlesPanel';
import { SearchPanel } from './SearchPanel';
import { SignaturesNavPanel } from './SignaturesNavPanel';
import { toolPanelNav } from './ToolPanelNav';
import { AttachmentsPanel } from '../../panels/AttachmentsPanel';
import { LayersPanel } from '../../panels/LayersPanel';
import { TagsPanel } from '../../panels/TagsPanel';

export const NAV_PANEL_DEFS = [
  { id: 'pages', title: NAV_PANEL_TITLES.pages, icon: 'pages', Component: PagesPanel },
  { id: 'bookmarks', title: NAV_PANEL_TITLES.bookmarks, icon: 'bookmarks', Component: BookmarksPanel },
  { id: 'articles', title: NAV_PANEL_TITLES.articles, icon: 'articles', Component: ArticlesPanel },
  // Left-dock candidates: the SAME components the tool dock mounts,
  // hosted at nav width — one implementation per capability (ToolPanelNav).
  { id: 'attachments', title: NAV_PANEL_TITLES.attachments, icon: 'attachments', Component: toolPanelNav(AttachmentsPanel) },
  { id: 'layers', title: NAV_PANEL_TITLES.layers, icon: 'layers', Component: toolPanelNav(LayersPanel) },
  { id: 'tags', title: NAV_PANEL_TITLES.tags, icon: 'tags', Component: toolPanelNav(TagsPanel) },
  // Find and Search intentionally share the magnifier glyph.
  { id: 'search', title: NAV_PANEL_TITLES.search, icon: 'find', Component: SearchPanel },
  { id: 'signatures', title: NAV_PANEL_TITLES.signatures, icon: 'signatures', Component: SignaturesNavPanel },
] as const satisfies readonly NavPanelDef[];

export function navPanelDef(id: string): NavPanelDef | undefined {
  return NAV_PANEL_DEFS.find((d) => d.id === (id as AvailableNavPanel));
}
