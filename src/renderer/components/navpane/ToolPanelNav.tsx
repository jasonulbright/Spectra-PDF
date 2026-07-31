import React from 'react';
import type { NavPanelComponentProps } from './types';

// Left-dock candidates (§ I.6): Attachments / Layers / Tags in the NAV pane.
// These nav panels MOUNT THE SAME components the tool dock uses — one
// implementation per capability, so the two surfaces can never disagree
// (the selectors lesson applied to panels). The tool panels self-serve via
// useActiveFile/useEngine, which resolve to the same showable document the
// pane's `activeFile` prop carries, so the prop bundle is deliberately
// unused. The host div supplies the scroll + the dock's breathing room; the
// pane's resize handle covers the narrow-width case.
export function toolPanelNav(
  Panel: React.ComponentType,
): React.ComponentType<NavPanelComponentProps> {
  return function ToolPanelNav(): React.ReactElement {
    return (
      <div className="navpanel-scroll navpanel-tool-host" data-testid="navpanel-tool-host">
        <Panel />
      </div>
    );
  };
}
