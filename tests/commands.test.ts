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
  function wire(state: AppState): { dispatched: AppAction[]; handlers: AppCommandHandlers } {
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
    return { dispatched, handlers };
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

  it('tools.panel.* focuses the Tools tab with the op armed', () => {
    const { dispatched } = wire(initialState);
    expect(invokeCommand('tools.panel.compress')).toBe(true);
    expect(dispatched).toEqual([
      { type: 'UI_FOCUS_TAB', tab: 'tools' },
      { type: 'UI_SET_ACTIVE_OP', op: 'compress' },
    ]);
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

// M4.2 — Ctrl+A is context-dependent (§ 9.2): PAGES on the board, TEXT in the
// reading view. The reading view has real selectable text (pdf.js TextLayer), so
// select-all there must fall through to the browser rather than select pages.
describe('edit.selectAll is view-dependent', () => {
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

  it('stands aside in the reading view so the browser selects TEXT', () => {
    expect(enabledOn('document')).toBe(false);
  });

  it('its binding only preventDefaults when enabled, or the fall-through is dead', () => {
    // 'always' would swallow Ctrl+A in the reading view and leave it doing
    // nothing at all — the binding and the when() have to agree.
    const b = KEY_BINDINGS.find((k) => k.command === 'edit.selectAll' && k.ctrl && k.key === 'a');
    expect(b).toBeDefined();
    expect(b!.preventDefault).toBe('whenEnabled');
  });
});
