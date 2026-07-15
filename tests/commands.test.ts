// The command system (Phase 4 M1): registry totality, enablement
// predicates, invokeCommand gating, and the escape-interceptor stack.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMANDS,
  COMMAND_IDS,
  canRedo,
  canUndo,
  hasSelection,
  isActiveFileDirty,
  type CommandId,
} from '../src/renderer/commands/registry';
import {
  escapeInterceptorCount,
  getCommandContext,
  invokeCommand,
  pushEscapeInterceptor,
  registerAppCommandHandlers,
  registerCanvasServices,
  runEscapeInterceptors,
  setCommandStateSource,
} from '../src/renderer/commands/context';
import { KEY_BINDINGS } from '../src/renderer/commands/acrobat-keys';
import { resetPendingFind } from '../src/renderer/commands/find-intent';
import type { AppCommandHandlers } from '../src/renderer/commands/types';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import type { AppAction, AppState, OpenFile } from '../src/renderer/state/types';

function makeFile(path: string, extra: Partial<OpenFile> = {}): OpenFile {
  return {
    path,
    workingPath: `${path}.working`,
    name: path,
    pageCount: 1,
    buffer: [1],
    dirty: false,
    undoStack: [],
    redoStack: [],
    ...extra,
  };
}

function stateWith(partial: Partial<AppState>): AppState {
  return { ...initialState, ...partial, ui: { ...initialState.ui, ...(partial.ui ?? {}) } };
}

const noopHandlers = (): AppCommandHandlers => ({
  openFiles: vi.fn(async () => true),
  openPath: vi.fn(async () => {}),
  save: vi.fn(async () => {}),
  saveAs: vi.fn(async () => {}),
  closeFile: vi.fn(async () => {}),
  closeAll: vi.fn(async () => {}),
  undo: vi.fn(async () => {}),
  redo: vi.fn(async () => {}),
  applyPageEdits: vi.fn(async () => {}),
  openPreferences: vi.fn(),
  openLicenses: vi.fn(),
  openAbout: vi.fn(),
  checkForUpdates: vi.fn(),
  exit: vi.fn(async () => {}),
  minimizeToTray: vi.fn(async () => {}),
});

afterEach(() => {
  setCommandStateSource(null);
  registerAppCommandHandlers(null);
  registerCanvasServices(null);
  // Module-level slot: a case that parks a Find must not leak into the next.
  resetPendingFind();
});

describe('registry totality', () => {
  it('every declared id has a command with a namespace prefix and a title', () => {
    const namespaces = ['file.', 'edit.', 'view.', 'document.', 'tools.', 'window.', 'help.'];
    for (const id of COMMAND_IDS) {
      const cmd = COMMANDS[id];
      expect(cmd, id).toBeDefined();
      expect(cmd.title.length, id).toBeGreaterThan(0);
      expect(namespaces.some((ns) => id.startsWith(ns)), id).toBe(true);
    }
  });

  it('the record carries no ids outside the declared union', () => {
    expect(Object.keys(COMMANDS).sort()).toEqual([...COMMAND_IDS].sort());
  });
});

describe('enablement helpers', () => {
  it('canUndo/canRedo: page tier first, then the active file snapshots', () => {
    expect(canUndo(initialState)).toBe(false);
    const pageTier = stateWith({
      pageUndoStack: [{ documents: [], dirtyPaths: [] }],
    });
    expect(canUndo(pageTier)).toBe(true);
    const snapshots = stateWith({
      activeFileId: 'a.pdf',
      files: new Map([['a.pdf', makeFile('a.pdf', { undoStack: ['s1'], redoStack: ['s2'] })]]),
    });
    expect(canUndo(snapshots)).toBe(true);
    expect(canRedo(snapshots)).toBe(true);
    expect(canRedo(initialState)).toBe(false);
  });

  it('isActiveFileDirty covers whole-file dirt and pending page edits', () => {
    const clean = stateWith({
      activeFileId: 'a.pdf',
      files: new Map([['a.pdf', makeFile('a.pdf')]]),
    });
    expect(isActiveFileDirty(clean)).toBe(false);
    const dirty = stateWith({
      activeFileId: 'a.pdf',
      files: new Map([['a.pdf', makeFile('a.pdf', { dirty: true })]]),
    });
    expect(isActiveFileDirty(dirty)).toBe(true);
    const pageDirty = stateWith({
      activeFileId: 'a.pdf',
      files: new Map([['a.pdf', makeFile('a.pdf')]]),
      pageDirtyPaths: ['a.pdf'],
    });
    expect(isActiveFileDirty(pageDirty)).toBe(true);
  });

  it('hasSelection reads the ui slice', () => {
    expect(hasSelection(initialState)).toBe(false);
    expect(hasSelection(stateWith({ ui: { ...initialState.ui, selectedPageIds: new Set(['x']) } }))).toBe(true);
  });
});

describe('invokeCommand', () => {
  function wire(state: AppState): {
    dispatched: AppAction[];
    handlers: AppCommandHandlers;
    /** State after every dispatch — for invariants the reducer derives. */
    finalState: () => AppState;
  } {
    const dispatched: AppAction[] = [];
    // Reducer-backed dispatch so multi-dispatch commands see evolving state.
    let current = state;
    setCommandStateSource(() => ({
      state: current,
      dispatch: (a: AppAction) => {
        dispatched.push(a);
        current = appReducer(current, a);
      },
    }));
    const handlers = noopHandlers();
    registerAppCommandHandlers(handlers);
    return { dispatched, handlers, finalState: () => current };
  }

  it('returns false with no registered context', () => {
    expect(invokeCommand('file.open')).toBe(false);
  });

  it('runs an enabled command through the registered app handlers', () => {
    const { handlers } = wire(initialState);
    expect(invokeCommand('file.open')).toBe(true);
    expect(handlers.openFiles).toHaveBeenCalledOnce();
  });

  it('refuses a command whose predicate fails (save with nothing dirty)', () => {
    const { handlers } = wire(initialState);
    expect(invokeCommand('file.save')).toBe(false);
    expect(handlers.save).not.toHaveBeenCalled();
  });

  it('tools.* toggle like the pills: re-invoking the active tool exits to Select', () => {
    const { dispatched } = wire(stateWith({ ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' } } }));
    expect(invokeCommand('tools.highlight')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_SET_TOOL', tool: 'highlight' });
    expect(invokeCommand('tools.highlight')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_SET_TOOL', tool: 'select' });
  });

  it('tools.* are scoped to a focused document tab', () => {
    wire(initialState); // Home focused
    expect(invokeCommand('tools.highlight')).toBe(false);
  });

  it('tools.panel.* focuses the Tools tab with the op armed, inside its owning tool', () => {
    const { dispatched , finalState } = wire(initialState);
    expect(invokeCommand('tools.panel.compress')).toBe(true);
    expect(dispatched).toEqual([
      { type: 'UI_FOCUS_TAB', tab: 'tools' },
      { type: 'UI_SET_ACTIVE_OP', op: 'compress' },
    ]);
    // Compress lives under Optimize (M5 § 7), and arming the op must OPEN that
    // tool — otherwise the Tools tab renders the tile grid with the op
    // invisibly "active" and the menu item looks like it did nothing.
    expect(finalState().ui.activeToolId).toBe('optimize');
  });

  it('tools.open.* opens a form-backed tool on the Tools tab at its first op', () => {
    const { dispatched, finalState } = wire(initialState);
    expect(invokeCommand('tools.open.protect')).toBe(true);
    expect(dispatched).toEqual([
      { type: 'UI_FOCUS_TAB', tab: 'tools' },
      { type: 'UI_SET_ACTIVE_OP', op: 'encrypt' },
    ]);
    expect(finalState().ui.activeToolId).toBe('protect');
  });

  it('tools.open.* for a canvas-mode tool opens the DOCUMENT and arms the mode', () => {
    // Comment has no ops — its work is a mode on the page, so parking the user
    // on the Tools tab would show them an empty pane. It must route to the doc.
    const { dispatched } = wire(
      stateWith({ files: new Map([['a.pdf', makeFile('a.pdf')]]), activeFileId: 'a.pdf' }),
    );
    expect(invokeCommand('tools.open.comment')).toBe(true);
    expect(dispatched).toEqual([
      { type: 'UI_SET_TOOL', tool: 'highlight' },
      { type: 'UI_FOCUS_TAB', tab: { doc: 'a.pdf' } },
    ]);
  });

  it('tools.open.* for a canvas-mode tool is disabled with no document open', () => {
    wire(initialState);
    // There is nothing to comment on / redact / OCR without a document, and the
    // tool has no pane of its own to fall back to.
    expect(invokeCommand('tools.open.comment')).toBe(false);
    expect(invokeCommand('tools.open.redact')).toBe(false);
    expect(invokeCommand('tools.open.ocr')).toBe(false);
    // A tool with its own pane stays reachable — the panels prompt for a file.
    expect(invokeCommand('tools.open.protect')).toBe(true);
  });

  it('tools.open.* for a canvas-mode tool refuses a GHOST import-only active file', () => {
    // Closing the last real file can leave a byte-only import source as the
    // active id. focusTab rejects a doc tab for it, so arming the mode anyway
    // would strand Highlight on a document the user cannot see — and it would
    // then be live on the next real doc they open.
    const { dispatched } = wire(
      stateWith({
        files: new Map([['src.pdf', makeFile('src.pdf', { importOnly: true })]]),
        activeFileId: 'src.pdf',
      }),
    );
    expect(invokeCommand('tools.open.comment')).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it('tools.open.ocr opens Find once the canvas mounts — not at invoke time', () => {
    // The REAL precondition: the tile lives on the Tools tab, where the canvas
    // is unmounted, so no find service exists when the command runs. It must
    // park the intent and let the mount drain it, or the tool is a dead click.
    const open = vi.fn();
    wire(stateWith({ files: new Map([['a.pdf', makeFile('a.pdf')]]), activeFileId: 'a.pdf' }));
    expect(invokeCommand('tools.open.ocr')).toBe(true);
    expect(open).not.toHaveBeenCalled(); // nothing to call it on yet

    registerCanvasServices({
      canvas: () => null,
      find: { isOpen: () => false, open, close: vi.fn() },
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a parked Find is consumed once, not re-opened on every later mount', () => {
    const open = vi.fn();
    wire(stateWith({ files: new Map([['a.pdf', makeFile('a.pdf')]]), activeFileId: 'a.pdf' }));
    invokeCommand('tools.open.ocr');
    const services = {
      canvas: () => null,
      find: { isOpen: () => false, open, close: vi.fn() },
    };
    registerCanvasServices(services);
    registerCanvasServices(null); // leave the doc tab
    registerCanvasServices(services); // come back to it
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('tools.open.ocr opens Find immediately when the canvas IS mounted', () => {
    const open = vi.fn();
    wire(stateWith({ files: new Map([['a.pdf', makeFile('a.pdf')]]), activeFileId: 'a.pdf' }));
    registerCanvasServices({
      canvas: () => null,
      find: { isOpen: () => false, open, close: vi.fn() },
    });
    expect(invokeCommand('tools.open.ocr')).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('arming an op from OUTSIDE the registry still opens its tool', () => {
    // The e2e harness (and any future caller) dispatches UI_SET_ACTIVE_OP raw.
    // The re-homing lives in the reducer precisely so it cannot be forgotten:
    // without it the Tools tab shows the tile grid while `watermark` is armed.
    const next = appReducer(
      stateWith({ ui: { ...initialState.ui, focusedTab: 'tools' } }),
      { type: 'UI_SET_ACTIVE_OP', op: 'watermark' },
    );
    expect(next.ui.activeOp).toBe('watermark');
    expect(next.ui.activeToolId).toBe('watermark');
    // …and switching to an op owned by a DIFFERENT tool re-homes, so the pane
    // header can never name one tool while showing another's panel.
    const moved = appReducer(next, { type: 'UI_SET_ACTIVE_OP', op: 'encrypt' });
    expect(moved.ui.activeToolId).toBe('protect');
  });

  it('tools.open.* arms the canvas mode for a tool that has BOTH a pane and a mode', () => {
    // Prepare Form hosts the `forms` panel AND wants widget mode live (§ 7:
    // activating a tool arms its interaction mode — for every tool that names
    // one, not only the ops-less ones).
    const { dispatched } = wire(initialState);
    expect(invokeCommand('tools.open.prepareform')).toBe(true);
    expect(dispatched).toContainEqual({ type: 'UI_SET_TOOL', tool: 'forms' });
  });

  it('document.deleteSelection deletes the batch then clears — even when the reducer rejects', () => {
    const { dispatched } = wire(
      stateWith({ ui: { ...initialState.ui, selectedPageIds: new Set(['stale#p0']), focusedTab: { doc: 'x.pdf' } } }),
    );
    expect(invokeCommand('document.deleteSelection')).toBe(true);
    expect(dispatched.map((a) => a.type)).toEqual(['DELETE_PAGE_REFS', 'UI_CLEAR_SELECTION']);
  });

  it('view.home / view.tools focus their tabs', () => {
    const { dispatched } = wire(stateWith({ ui: { ...initialState.ui, focusedTab: 'tools' } }));
    expect(invokeCommand('view.home')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_FOCUS_TAB', tab: 'home' });
    expect(invokeCommand('view.tools')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_FOCUS_TAB', tab: 'tools' });
  });

  it('window.nextTab / prevTab cycle Home → Tools → docs', () => {
    // Home + Tools always present; with no docs, next from Home → Tools.
    const { dispatched } = wire(initialState);
    expect(invokeCommand('window.nextTab')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_FOCUS_TAB', tab: 'tools' });
    expect(invokeCommand('window.prevTab')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_FOCUS_TAB', tab: 'home' }); // wraps
  });

  it('file.clearRecent is disabled when the recent list is empty', () => {
    wire(initialState); // recentFiles: []
    expect(invokeCommand('file.clearRecent')).toBe(false);
  });

  it('file.clearRecent clears a non-empty recent list', () => {
    const { dispatched } = wire(stateWith({ ui: { ...initialState.ui, recentFiles: ['a.pdf'] } }));
    expect(invokeCommand('file.clearRecent')).toBe(true);
    expect(dispatched.at(-1)).toEqual({ type: 'UI_SET_RECENT_FILES', files: [] });
  });

  it('zoom commands require a mounted canvas handle', () => {
    wire(stateWith({ ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' } } }));
    expect(invokeCommand('view.zoomIn')).toBe(false);
    const zoomIn = vi.fn();
    registerCanvasServices({
      canvas: () => ({
        zoomIn,
        zoomOut: vi.fn(),
        reset: vi.fn(),
        clientToWorld: () => null,
        centerOn: vi.fn(),
      }),
      find: { isOpen: () => false, open: vi.fn(), close: vi.fn() },
    });
    expect(invokeCommand('view.zoomIn')).toBe(true);
    expect(zoomIn).toHaveBeenCalledOnce();
  });

  it('edit.find opens the registered find bar', () => {
    wire(initialState);
    const open = vi.fn();
    registerCanvasServices({
      canvas: () => null,
      find: { isOpen: () => false, open, close: vi.fn() },
    });
    expect(invokeCommand('edit.find')).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });
});

describe('escape interceptors', () => {
  it('runs LIFO and stops at the first consumer', () => {
    const calls: string[] = [];
    const un1 = pushEscapeInterceptor(() => {
      calls.push('first');
      return true;
    });
    const un2 = pushEscapeInterceptor(() => {
      calls.push('second');
      return true;
    });
    expect(runEscapeInterceptors()).toBe(true);
    expect(calls).toEqual(['second']);
    un2();
    expect(runEscapeInterceptors()).toBe(true);
    expect(calls).toEqual(['second', 'first']);
    un1();
    expect(runEscapeInterceptors()).toBe(false);
    expect(escapeInterceptorCount()).toBe(0);
  });

  it('a non-consuming interceptor falls through', () => {
    const un = pushEscapeInterceptor(() => false);
    expect(runEscapeInterceptors()).toBe(false);
    un();
  });
});

describe('getCommandContext', () => {
  it('exposes registered services and null before registration', () => {
    expect(getCommandContext()).toBeNull();
    setCommandStateSource(() => ({ state: initialState, dispatch: () => {} }));
    const ctx = getCommandContext();
    expect(ctx?.state).toBe(initialState);
    expect(ctx?.app).toBeNull();
    expect(ctx?.canvas).toBeNull();
  });
});

// Exhaustive smoke: every command either refuses cleanly or runs without
// throwing against a registered context (no handler may assume unchecked
// state). Guards the total record against a run() that dereferences state
// its when() didn't check.
describe('registry smoke', () => {
  it('every command invokes or refuses without throwing, on every tab', () => {
    const tabs = ['home', 'tools', { doc: 'x.pdf' }] as const;
    for (const tab of tabs) {
      let current = stateWith({ ui: { ...initialState.ui, focusedTab: tab } });
      setCommandStateSource(() => ({
        state: current,
        dispatch: (a: AppAction) => {
          current = appReducer(current, a);
        },
      }));
      registerAppCommandHandlers(noopHandlers());
      for (const id of COMMAND_IDS as readonly CommandId[]) {
        expect(() => invokeCommand(id), `${id} on ${JSON.stringify(tab)}`).not.toThrow();
      }
      setCommandStateSource(null);
      registerAppCommandHandlers(null);
    }
  });
});

// M4.2 — Ctrl+A selects PAGES in BOTH views, and must NOT fall through to the
// browser's select-all in the reading view. § 9.2 originally specified TEXT
// there (Acrobat's behaviour); it was tried and reverted, because the reading
// view is VIRTUALIZED — only mounted pages have text spans — so native
// select-all can reach only the on-screen pages and Ctrl+C would silently copy
// a fraction of the document. These pin the reverted decision so it isn't
// "restored" from the plan without re-reading why.
describe('edit.selectAll selects pages in BOTH views (virtualization)', () => {
  const enabledOn = (mode: 'organize' | 'document'): boolean => {
    const state = stateWith({
      files: new Map([['x.pdf', makeFile('x.pdf')]]),
      activeFileId: 'x.pdf',
      ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' }, docViewMode: mode },
    });
    setCommandStateSource(() => ({ state, dispatch: () => {} }));
    registerAppCommandHandlers(noopHandlers());
    const ctx = getCommandContext()!;
    return COMMANDS['edit.selectAll'].when?.(ctx) ?? true;
  };

  it('selects pages on the Organize board', () => {
    expect(enabledOn('organize')).toBe(true);
  });

  it('ALSO selects pages in the reading view — never a partial text select-all', () => {
    expect(enabledOn('document')).toBe(true);
  });

  it('always preventDefaults, so the browser can never run a partial select-all', () => {
    const b = KEY_BINDINGS.find((k) => k.command === 'edit.selectAll' && k.ctrl && k.key === 'a');
    expect(b).toBeDefined();
    expect(b!.preventDefault).toBe('always');
  });
});
