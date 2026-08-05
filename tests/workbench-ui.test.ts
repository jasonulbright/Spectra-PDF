// workbench-ui persistence, including the tool dock.
// readWorkbenchUi must coerce a corrupt/partial persisted value against
// defaults field-by-field, so a bad entry can't propagate a wrong shape into
// ui.navPane / ui.toolDock (the recent-files precedent). Uses a localStorage
// stub since vitest runs in node.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkbenchUi, writeWorkbenchUi } from '../src/renderer/lib/workbench-ui';
import { NAV_PANE_DEFAULT_WIDTH, TOOL_DOCK_DEFAULT_WIDTH } from '../src/renderer/state/types';

const DEFAULTS = {
  navPane: { open: false, panel: 'pages' as const, width: NAV_PANE_DEFAULT_WIDTH },
  toolDock: { open: false, width: TOOL_DOCK_DEFAULT_WIDTH },
};

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('readWorkbenchUi', () => {
  it('returns defaults when nothing is stored', () => {
    expect(readWorkbenchUi(DEFAULTS)).toEqual(DEFAULTS);
  });

  it('round-trips a valid value', () => {
    writeWorkbenchUi({
      navPane: { open: true, panel: 'bookmarks', width: 260 },
      toolDock: { open: true, width: 420 },
    });
    const read = readWorkbenchUi(DEFAULTS);
    expect(read.navPane).toEqual({ open: true, panel: 'bookmarks', width: 260 });
    expect(read.toolDock).toEqual({ open: true, width: 420 });
  });

  it('drops a legacy entry\'s retired toolDock.view instead of choking on it', () => {
    // Every existing install has one of these on disk: the dock used to carry
    // `view: 'tool' | 'comments'` and it is retired (comments are a normal op
    // panel now). The reader must keep the fields it still understands rather
    // than fall back to defaults and lose the user's width.
    store.set(
      'workbench-ui',
      JSON.stringify({
        navPane: { open: true, panel: 'pages', width: 240 },
        toolDock: { open: true, width: 420, view: 'comments' },
      }),
    );
    const read = readWorkbenchUi(DEFAULTS);
    expect(read.toolDock).toEqual({ open: true, width: 420 });
    expect(read.navPane.width).toBe(240);
  });

  it('coerces each field against defaults, clamping width low and high', () => {
    store.set('workbench-ui', JSON.stringify({ navPane: { open: 'yes', panel: 'nope', width: 10 } }));
    expect(readWorkbenchUi(DEFAULTS).navPane).toEqual({
      open: false, // non-boolean → default
      panel: 'pages', // invalid id → default
      width: 180, // below min → clamped
    });
    // An already-persisted oversized width self-heals on next boot.
    store.set('workbench-ui', JSON.stringify({ navPane: { open: true, panel: 'pages', width: 5000 } }));
    expect(readWorkbenchUi(DEFAULTS).navPane.width).toBe(520);
  });

  it('coerces the tool dock the same way (and tolerates its absence — older entries)', () => {
    // A persisted value from before the dock existed: navPane only.
    store.set('workbench-ui', JSON.stringify({ navPane: { open: true, panel: 'pages', width: 200 } }));
    expect(readWorkbenchUi(DEFAULTS).toolDock).toEqual(DEFAULTS.toolDock);
    // Corrupt dock fields coerce field-by-field with width clamped both ways.
    store.set('workbench-ui', JSON.stringify({ toolDock: { open: 'wide', width: 10_000 } }));
    expect(readWorkbenchUi(DEFAULTS).toolDock).toEqual({ open: false, width: 640 });
    store.set('workbench-ui', JSON.stringify({ toolDock: { open: true, width: 12 } }));
    expect(readWorkbenchUi(DEFAULTS).toolDock).toEqual({ open: true, width: 300 });
  });

  it('survives a non-object / malformed entry', () => {
    store.set('workbench-ui', '"garbage"');
    expect(readWorkbenchUi(DEFAULTS)).toEqual(DEFAULTS);
    store.set('workbench-ui', '{not json');
    expect(readWorkbenchUi(DEFAULTS)).toEqual(DEFAULTS);
    store.set('workbench-ui', JSON.stringify({ navPane: null }));
    expect(readWorkbenchUi(DEFAULTS).navPane).toEqual(DEFAULTS.navPane);
  });

  it('accepts a valid panel id from the full stable set even if not yet built', () => {
    store.set('workbench-ui', JSON.stringify({ navPane: { open: true, panel: 'search', width: 200 } }));
    // 'search' is a valid NavPanelId (the NavPane falls back to an available
    // panel at render time); readWorkbenchUi keeps it.
    expect(readWorkbenchUi(DEFAULTS).navPane.panel).toBe('search');
  });
});
