import type React from 'react';
import type { OpenFile } from '../../state/types';
import type { ChromeIconId } from '../chrome-icons';
import type { AvailableNavPanel } from '../../commands/navpanels';

// The prop bundle every nav-pane panel receives (Phase 4 M3). `activeFile` is
// the panel's subject; the page callbacks feed the shared page context menu
// (App's inspect / extract-text handlers, the same ones the board uses). A
// leaf module so PagesPanel and the registry don't import each other.
export interface NavPanelComponentProps {
  activeFile: OpenFile | null;
  onOpenPage: (path: string, pageNumber: number) => void;
  onExtractText: (path: string, pageNumber: number) => void;
}

export interface NavPanelDef {
  id: AvailableNavPanel;
  title: string;
  icon: ChromeIconId;
  Component: React.ComponentType<NavPanelComponentProps>;
}
