// Persistence for workbench chrome state under the NEW `workbench-ui`
// localStorage key (new keys do NOT extend the legacy
// `spectra-` prefix). It persists the nav-pane state (open/panel/width)
// and the right tool dock (open/width). App mirrors
// ui.navPane + ui.toolDock → here in one debounced effect; boot hydration
// reads them back through the validated parse so a corrupt entry can't
// propagate a bad shape into state (the recent-files precedent).
import {
  NAV_PANE_MIN_WIDTH,
  NAV_PANE_MAX_WIDTH,
  TOOL_DOCK_MIN_WIDTH,
  TOOL_DOCK_MAX_WIDTH,
  type NavPaneState,
  type NavPanelId,
  type ToolDockState,
} from '../state/types';
import { NAV_PANEL_IDS } from '../commands/navpanels';
import { readScoped, writeScoped } from './window-label';

// Per WINDOW, not per app: pane widths describe the window they are in, and a
// second window mirroring its own layout back over a shared key resizes the
// first one's panes from under it.
const KEY = 'workbench-ui';
// The AVAILABLE-panel list is the validator — a hand-copied list here would
// silently bounce a newly-added panel back to the fallback on every boot
// (caught when the left-dock candidates landed; navpanels is a leaf data
// module, so no cycle).
const PANELS: readonly NavPanelId[] = NAV_PANEL_IDS;

interface WorkbenchUi {
  navPane: NavPaneState;
  toolDock: ToolDockState;
  /** Whether a completed placement leaves the canvas mode armed. Per window
   * like the pane widths: it describes how you are working in THIS window. */
  toolLock: boolean;
}

/** Validate one persisted nav-pane shape against `fallback`, field by field. */
function coerceNavPane(raw: unknown, fallback: NavPaneState): NavPaneState {
  if (typeof raw !== 'object' || raw === null) return fallback;
  const r = raw as Record<string, unknown>;
  const panel = PANELS.includes(r.panel as NavPanelId) ? (r.panel as NavPanelId) : fallback.panel;
  const width =
    typeof r.width === 'number' && Number.isFinite(r.width)
      ? Math.min(NAV_PANE_MAX_WIDTH, Math.max(NAV_PANE_MIN_WIDTH, Math.round(r.width)))
      : fallback.width;
  return {
    open: typeof r.open === 'boolean' ? r.open : fallback.open,
    panel,
    width,
  };
}

/** Same discipline for the tool dock. */
function coerceToolDock(raw: unknown, fallback: ToolDockState): ToolDockState {
  if (typeof raw !== 'object' || raw === null) return fallback;
  const r = raw as Record<string, unknown>;
  const width =
    typeof r.width === 'number' && Number.isFinite(r.width)
      ? Math.min(TOOL_DOCK_MAX_WIDTH, Math.max(TOOL_DOCK_MIN_WIDTH, Math.round(r.width)))
      : fallback.width;
  // A legacy entry may still carry `view: 'comments'` — it is simply dropped;
  // the dock has one mode now, so there is nothing to coerce it to.
  return {
    open: typeof r.open === 'boolean' ? r.open : fallback.open,
    width,
  };
}

/** Read persisted workbench-ui, coercing every field against `defaults`. */
export function readWorkbenchUi(defaults: WorkbenchUi): WorkbenchUi {
  let raw: unknown;
  try {
    raw = JSON.parse(readScoped(KEY) || '{}');
  } catch {
    return defaults;
  }
  if (typeof raw !== 'object' || raw === null) return defaults;
  const r = raw as Record<string, unknown>;
  return {
    navPane: coerceNavPane(r.navPane, defaults.navPane),
    toolDock: coerceToolDock(r.toolDock, defaults.toolDock),
    toolLock: typeof r.toolLock === 'boolean' ? r.toolLock : defaults.toolLock,
  };
}

export function writeWorkbenchUi(value: WorkbenchUi): void {
  writeScoped(KEY, JSON.stringify(value));
}
