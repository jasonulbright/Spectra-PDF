// Persistence for workbench chrome state under the NEW `workbench-ui`
// localStorage key (Phase 4 § 4.3 — new keys do NOT extend the legacy
// `spectra-` prefix). M3 persists the nav-pane state (open/panel/width). App
// mirrors ui.navPane → here in one effect; boot hydration reads it back
// through the validated parse so a corrupt entry can't propagate a bad shape
// into state (the recent-files precedent).
import { NAV_PANE_MIN_WIDTH, type NavPaneState, type NavPanelId } from '../state/types';

const KEY = 'workbench-ui';
const PANELS: readonly NavPanelId[] = ['pages', 'bookmarks', 'signatures', 'search'];

interface WorkbenchUi {
  navPane: NavPaneState;
}

/** Validate one persisted nav-pane shape against `fallback`, field by field. */
function coerceNavPane(raw: unknown, fallback: NavPaneState): NavPaneState {
  if (typeof raw !== 'object' || raw === null) return fallback;
  const r = raw as Record<string, unknown>;
  const panel = PANELS.includes(r.panel as NavPanelId) ? (r.panel as NavPanelId) : fallback.panel;
  const width =
    typeof r.width === 'number' && Number.isFinite(r.width)
      ? Math.max(NAV_PANE_MIN_WIDTH, Math.round(r.width))
      : fallback.width;
  return {
    open: typeof r.open === 'boolean' ? r.open : fallback.open,
    panel,
    width,
  };
}

/** Read persisted workbench-ui, coercing every field against `defaults`. */
export function readWorkbenchUi(defaults: WorkbenchUi): WorkbenchUi {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return defaults;
  }
  if (typeof raw !== 'object' || raw === null) return defaults;
  return { navPane: coerceNavPane((raw as Record<string, unknown>).navPane, defaults.navPane) };
}

export function writeWorkbenchUi(value: WorkbenchUi): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // storage full / unavailable — chrome state is best-effort
  }
}
