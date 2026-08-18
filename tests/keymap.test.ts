// The keymap layer: table integrity, the pure resolver, the
// dispatcher's scope order (interceptors → editable guard → bindings), and
// the Escape chain.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_BINDINGS, type KeyBinding } from '../src/renderer/commands/standard-keys';
import { dispatchKeyEvent, isEditable, resolveBinding, shortcutForCommand } from '../src/renderer/commands/keymap';
import { COMMANDS } from '../src/renderer/commands/registry';
import {
  pushEscapeInterceptor,
  registerAppCommandHandlers,
  registerCanvasServices,
  setCommandStateSource,
} from '../src/renderer/commands/context';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import type { AppAction, AppState } from '../src/renderer/state/types';

interface FakeEventInit {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  target?: unknown;
}

function fakeEvent(init: FakeEventInit): KeyboardEvent & { defaultPrevented: boolean } {
  const e = {
    key: init.key,
    ctrlKey: init.ctrl ?? false,
    metaKey: init.meta ?? false,
    shiftKey: init.shift ?? false,
    altKey: init.alt ?? false,
    target: init.target ?? null,
    defaultPrevented: false,
    preventDefault(): void {
      e.defaultPrevented = true;
    },
  };
  return e as unknown as KeyboardEvent & { defaultPrevented: boolean };
}

const INPUT = { tagName: 'INPUT' } as unknown as EventTarget;
const DIV = { tagName: 'DIV', isContentEditable: false } as unknown as EventTarget;

afterEach(() => {
  setCommandStateSource(null);
  registerAppCommandHandlers(null);
  registerCanvasServices(null);
});

describe('table integrity', () => {
  it('every binding references a registered command', () => {
    for (const b of KEY_BINDINGS) {
      expect(COMMANDS[b.command], `${b.key} -> ${b.command}`).toBeDefined();
    }
  });

  it('no two bindings can match the same key event', () => {
    // Two bindings conflict when key matches and every constrained modifier
    // is compatible (undefined = don't care, so it overlaps everything).
    // requiresPref does NOT exempt a pair: resolveBinding returns the FIRST
    // match regardless, and a pref-gated hit that the dispatcher refuses
    // would SWALLOW a later live binding on the same event.
    const compatible = (a: boolean | undefined, b: boolean | undefined): boolean =>
      a === undefined || b === undefined || a === b;
    const conflicts: string[] = [];
    for (let i = 0; i < KEY_BINDINGS.length; i++) {
      for (let j = i + 1; j < KEY_BINDINGS.length; j++) {
        const a = KEY_BINDINGS[i] as KeyBinding;
        const b = KEY_BINDINGS[j] as KeyBinding;
        if (
          a.key === b.key &&
          compatible(a.ctrl, b.ctrl) &&
          compatible(a.shift, b.shift) &&
          compatible(a.alt, b.alt)
        ) {
          conflicts.push(`${a.key}: ${a.command} vs ${b.command}`);
        }
      }
    }
    expect(conflicts).toEqual([]);
  });

  it('escape is never a table binding — the chain owns it', () => {
    expect(KEY_BINDINGS.some((b) => b.key === 'escape')).toBe(false);
  });
});

describe('resolveBinding', () => {
  it('resolves modifier chords case-insensitively (Ctrl+Shift+Z → redo)', () => {
    expect(resolveBinding(fakeEvent({ key: 'Z', ctrl: true, shift: true }))?.command).toBe('edit.redo');
    expect(resolveBinding(fakeEvent({ key: 'z', ctrl: true }))?.command).toBe('edit.undo');
    expect(resolveBinding(fakeEvent({ key: 'z', meta: true }))?.command).toBe('edit.undo'); // Cmd = Ctrl
  });

  it("don't-care modifiers match either state (Ctrl+Y and Ctrl+Shift+Y both redo)", () => {
    expect(resolveBinding(fakeEvent({ key: 'y', ctrl: true }))?.command).toBe('edit.redo');
    expect(resolveBinding(fakeEvent({ key: 'y', ctrl: true, shift: true }))?.command).toBe('edit.redo');
  });

  it('the shift split — Ctrl+F is Find, Ctrl+Shift+F is Search', () => {
    expect(resolveBinding(fakeEvent({ key: 'f', ctrl: true }))?.command).toBe('edit.find');
    expect(resolveBinding(fakeEvent({ key: 'f', ctrl: true, shift: true }))?.command).toBe('view.navPanel.search');
  });

  it('unmodified Delete/Backspace and [ ] resolve regardless of modifiers (legacy semantics)', () => {
    expect(resolveBinding(fakeEvent({ key: 'Delete' }))?.command).toBe('document.deleteSelection');
    expect(resolveBinding(fakeEvent({ key: 'Backspace', ctrl: true }))?.command).toBe('document.deleteSelection');
    expect(resolveBinding(fakeEvent({ key: ']' }))?.command).toBe('document.rotateSelectionCW');
    expect(resolveBinding(fakeEvent({ key: '[' }))?.command).toBe('document.rotateSelectionCCW');
  });

  it('zoom keeps the shiftless keys; the SHIFTED pair rotates the view', () => {
    // Shiftless plus/minus zoom; Ctrl+Shift+plus/minus rotate the view.
    expect(resolveBinding(fakeEvent({ key: '=', ctrl: true }))?.command).toBe('view.zoomIn');
    expect(resolveBinding(fakeEvent({ key: '+', ctrl: true }))?.command).toBe('view.zoomIn'); // numpad plus
    expect(resolveBinding(fakeEvent({ key: '-', ctrl: true }))?.command).toBe('view.zoomOut');
    expect(resolveBinding(fakeEvent({ key: '+', ctrl: true, shift: true }))?.command).toBe('view.rotateCW');
    expect(resolveBinding(fakeEvent({ key: '_', ctrl: true, shift: true }))?.command).toBe('view.rotateCCW');
    expect(resolveBinding(fakeEvent({ key: '-', ctrl: true, shift: true }))?.command).toBe('view.rotateCCW'); // numpad minus
    expect(resolveBinding(fakeEvent({ key: '0', ctrl: true }))?.command).toBe('view.fit');
  });

  it('Ctrl+P prints; Ctrl+Shift+P stays reserved (Page Setup, unshipped)', () => {
    // 'always' preventDefault: WebView2 has its own Ctrl+P UI.
    expect(resolveBinding(fakeEvent({ key: 'p', ctrl: true }))?.command).toBe('file.print');
    expect(resolveBinding(fakeEvent({ key: 'p', ctrl: true, shift: true }))).toBeNull();
  });

  it('Ctrl+D properties vs Ctrl+Shift+D delete pages (shift split)', () => {
    // The properties binding was shift-lax and sits earlier in the table —
    // without its shift:false, Ctrl+Shift+D would open Properties instead.
    expect(resolveBinding(fakeEvent({ key: 'd', ctrl: true }))?.command).toBe('file.properties');
    expect(resolveBinding(fakeEvent({ key: 'd', ctrl: true, shift: true }))?.command).toBe('tools.panel.delete');
  });

  it('document-op chords land on their panes', () => {
    expect(resolveBinding(fakeEvent({ key: 'r', ctrl: true, shift: true }))?.command).toBe('tools.panel.rotate');
    expect(resolveBinding(fakeEvent({ key: 'i', ctrl: true, shift: true }))?.command).toBe('document.insertFromFile');
    expect(resolveBinding(fakeEvent({ key: 'n', ctrl: true, shift: true }))?.command).toBe('view.goToPage');
  });

  it('F3 family steps the Find cursor, guard-exempt like Ctrl+F', () => {
    const next = resolveBinding(fakeEvent({ key: 'F3' }));
    expect(next?.command).toBe('edit.findNext');
    expect(next?.editableGuard).toBe(false); // F3 INSIDE the find field steps
    expect(resolveBinding(fakeEvent({ key: 'F3', shift: true }))?.command).toBe('edit.findPrev');
    expect(resolveBinding(fakeEvent({ key: 'g', ctrl: true }))?.command).toBe('edit.findNext');
    expect(resolveBinding(fakeEvent({ key: 'g', ctrl: true, shift: true }))?.command).toBe('edit.findPrev');
  });

  it('the freeze bound the last verified rows', () => {
    // Ctrl+Shift+T inserts blank pages. Shift+F4 toggles the tool pane, while
    // F4 alone toggles the navigation pane.
    expect(resolveBinding(fakeEvent({ key: 't', ctrl: true, shift: true }))?.command).toBe('document.insertBlankPage');
    expect(resolveBinding(fakeEvent({ key: 'F4' }))?.command).toBe('view.navPane');
    expect(resolveBinding(fakeEvent({ key: 'F4', shift: true }))?.command).toBe('view.toolsPane');
  });

  it('returns null for unbound keys', () => {
    // bare 'z' RESOLVES (marquee zoom) — pref-gated, so the
    // dispatcher still refuses it until the accelerators switch is on; a
    // genuinely unbound letter proves the null path instead.
    expect(resolveBinding(fakeEvent({ key: 'q' }))).toBeNull();
    expect(resolveBinding(fakeEvent({ key: 'z' }))?.requiresPref).toBe('singleKeyAccelerators');
  });
});

describe('isEditable', () => {
  it('flags form fields and contenteditable, not plain elements', () => {
    expect(isEditable(INPUT)).toBe(true);
    expect(isEditable({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isEditable({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(isEditable({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isEditable(DIV)).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

// --- dispatcher ------------------------------------------------------------

function wire(state: AppState): { dispatched: AppAction[]; current: () => AppState } {
  const dispatched: AppAction[] = [];
  let current = state;
  setCommandStateSource(() => ({
    state: current,
    dispatch: (a: AppAction) => {
      dispatched.push(a);
      current = appReducer(current, a);
    },
  }));
  // The page-tier commands consult App's signed-document gate before they
  // dispatch and are unavailable without it, so a keymap test that wants them
  // to run has to stand one up — App registers its bundle in the same mount
  // effect that installs this dispatcher.
  registerAppCommandHandlers({
    confirmPageEdit: async () => true,
  } as unknown as Parameters<typeof registerAppCommandHandlers>[0]);
  return { dispatched, current: () => current };
}

/** The page-tier commands answer the gate on a later turn. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function uiState(partial: Partial<AppState['ui']>): AppState {
  return { ...initialState, ui: { ...initialState.ui, ...partial } };
}

describe('dispatchKeyEvent', () => {
  it('does nothing before the context is registered', () => {
    const e = fakeEvent({ key: 'z', ctrl: true });
    expect(() => dispatchKeyEvent(e)).not.toThrow();
    expect(e.defaultPrevented).toBe(false);
  });

  it('runs an enabled global binding (Ctrl+Z → undo) and preventDefaults', () => {
    wire(uiState({}));
    const undo = vi.fn(async () => {});
    registerAppCommandHandlers({
      openFiles: vi.fn(), save: vi.fn(), saveAs: vi.fn(), closeFile: vi.fn(), closeAll: vi.fn(),
      undo, redo: vi.fn(), applyPageEdits: vi.fn(), openPreferences: vi.fn(),
    } as never);
    // Nothing to undo → command disabled, but the legacy listener still
    // preventDefault'ed on the chord: 'always' semantics.
    const e = fakeEvent({ key: 'z', ctrl: true });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(undo).not.toHaveBeenCalled();
    // With page-tier history the command is enabled and runs.
    wire({ ...uiState({}), pageUndoStack: [{ documents: [], dirtyPaths: [] }] });
    registerAppCommandHandlers({
      openFiles: vi.fn(), save: vi.fn(), saveAs: vi.fn(), closeFile: vi.fn(), closeAll: vi.fn(),
      undo, redo: vi.fn(), applyPageEdits: vi.fn(), openPreferences: vi.fn(),
    } as never);
    dispatchKeyEvent(fakeEvent({ key: 'z', ctrl: true }));
    expect(undo).toHaveBeenCalledOnce();
  });

  it('the editable guard swallows guarded bindings inside fields', () => {
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' } }));
    const e = fakeEvent({ key: 'a', ctrl: true, target: INPUT });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it('Ctrl+F always wins — even from inside a field', () => {
    wire(uiState({ focusedTab: { doc: 'x.pdf' } }));
    const open = vi.fn();
    registerCanvasServices({
      canvas: () => null,
      jumpToPage: vi.fn(),
      jumpToFilePage: vi.fn(),
      openPageForReading: vi.fn(),
      clearGuides: vi.fn(),
      readAloud: {
        isReading: () => false,
        isPaused: () => false,
        readPage: vi.fn(),
        readDocument: vi.fn(),
        togglePause: vi.fn(),
        stop: vi.fn(),
      },
      redaction: {
        addMarks: async () => ({ added: 0, duplicates: 0, skipped: 0 }),
        markedRects: async () => [],
        count: () => 0,
        subscribe: () => () => {},
        searchOcrPage: async () => [],
      },
      formCandidates: {
        publish: async () => ({ shown: 0, skipped: 0 }),
        list: () => [],
        accept: async () => ({ created: 0, skipped: 0 }),
        update: () => {},
        clear: () => {},
        focus: () => {},
        subscribe: () => () => {},
      },
      tableReview: {
        publish: async () => ({ shown: 0, skipped: 0 }),
        list: () => [],
        update: () => {},
        clear: () => {},
        focus: () => {},
        exportTo: async () => ({ output: '' }),
        subscribe: () => () => {},
      },
      a11yFindings: {
        publish: async () => ({ shown: 0, skipped: 0 }),
        list: () => [],
        clear: () => {},
        focus: () => {},
      },
      goToPage: () => false,
      find: { isOpen: () => false, open, openWith: vi.fn(), close: vi.fn(), next: vi.fn(), prev: vi.fn() },
    });
    const e = fakeEvent({ key: 'f', ctrl: true, target: INPUT });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });

  it('Ctrl+Shift+F opens the Search nav panel (split from Find)', () => {
    // The shift split: plain Ctrl+F is Find; Ctrl+Shift+F is Search.
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' } }));
    const open = vi.fn();
    registerCanvasServices({
      canvas: () => null,
      jumpToPage: vi.fn(),
      jumpToFilePage: vi.fn(),
      openPageForReading: vi.fn(),
      clearGuides: vi.fn(),
      readAloud: {
        isReading: () => false,
        isPaused: () => false,
        readPage: vi.fn(),
        readDocument: vi.fn(),
        togglePause: vi.fn(),
        stop: vi.fn(),
      },
      redaction: {
        addMarks: async () => ({ added: 0, duplicates: 0, skipped: 0 }),
        markedRects: async () => [],
        count: () => 0,
        subscribe: () => () => {},
        searchOcrPage: async () => [],
      },
      formCandidates: {
        publish: async () => ({ shown: 0, skipped: 0 }),
        list: () => [],
        accept: async () => ({ created: 0, skipped: 0 }),
        update: () => {},
        clear: () => {},
        focus: () => {},
        subscribe: () => () => {},
      },
      tableReview: {
        publish: async () => ({ shown: 0, skipped: 0 }),
        list: () => [],
        update: () => {},
        clear: () => {},
        focus: () => {},
        exportTo: async () => ({ output: '' }),
        subscribe: () => () => {},
      },
      a11yFindings: {
        publish: async () => ({ shown: 0, skipped: 0 }),
        list: () => [],
        clear: () => {},
        focus: () => {},
      },
      goToPage: () => false,
      find: { isOpen: () => false, open, openWith: vi.fn(), close: vi.fn(), next: vi.fn(), prev: vi.fn() },
    });
    const e = fakeEvent({ key: 'f', ctrl: true, shift: true, target: DIV });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled(); // NOT Find
    expect(dispatched).toEqual([{ type: 'UI_OPEN_NAV_PANEL', panel: 'search' }]);
  });

  it('Ctrl+Shift+F is edit-guarded — a re-press from inside the search box is a no-op', () => {
    // Unlike Find, the Search command toggles; guarding it means a reflex
    // re-press while the (autofocused) search input has focus can't close the
    // panel and discard the query (regression).
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' } }));
    const e = fakeEvent({ key: 'f', ctrl: true, shift: true, target: INPUT });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(false); // guarded: no preventDefault, no dispatch
    expect(dispatched).toEqual([]);
  });

  it('canvas-scoped bindings fall through outside the canvas view', () => {
    const { dispatched } = wire(uiState({ focusedTab: 'home' }));
    const e = fakeEvent({ key: 'a', ctrl: true, target: DIV });
    dispatchKeyEvent(e);
    // No preventDefault: the browser's own select-all belongs to the page.
    expect(e.defaultPrevented).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it('Ctrl+A in canvas selects all pages', () => {
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' } }));
    const e = fakeEvent({ key: 'a', ctrl: true, target: DIV });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(true); // legacy: pd before the (empty-workspace) no-op
    expect(dispatched).toEqual([{ type: 'UI_SELECT_ALL_PAGES' }]);
  });

  it('Delete without a selection falls through (no preventDefault)', () => {
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' } }));
    const e = fakeEvent({ key: 'Delete', target: DIV });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it('Delete with a selection dispatches the batched delete + clear', async () => {
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' }, selectedPageIds: new Set(['x#p0']) }));
    const e = fakeEvent({ key: 'Delete', target: DIV });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await settle();
    expect(dispatched.map((a) => a.type)).toEqual(['DELETE_PAGE_REFS', 'UI_CLEAR_SELECTION']);
  });

  it('] and [ rotate the selection', async () => {
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' }, selectedPageIds: new Set(['x#p0']) }));
    dispatchKeyEvent(fakeEvent({ key: ']', target: DIV }));
    dispatchKeyEvent(fakeEvent({ key: '[', target: DIV }));
    await settle();
    expect(dispatched).toEqual([
      { type: 'ROTATE_PAGE_REFS', pageIds: ['x#p0'], delta: 90 },
      { type: 'ROTATE_PAGE_REFS', pageIds: ['x#p0'], delta: 270 },
    ]);
  });

  it('Delete falls through when the signed-document gate is unreachable', () => {
    // Fail-closed at the keyboard too: the command is unavailable without the
    // gate, so the key is not consumed and nothing is dispatched.
    wire(uiState({ focusedTab: { doc: 'x.pdf' }, selectedPageIds: new Set(['x#p0']) }));
    registerAppCommandHandlers(null);
    const e = fakeEvent({ key: 'Delete', target: DIV });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('the Escape chain', () => {
  it('an interceptor (drag/menu) consumes Escape ahead of everything', () => {
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' }, tool: 'highlight' }));
    const consumed = vi.fn(() => true);
    const un = pushEscapeInterceptor(consumed);
    dispatchKeyEvent(fakeEvent({ key: 'Escape', target: DIV }));
    expect(consumed).toHaveBeenCalledOnce();
    expect(dispatched).toEqual([]); // tool untouched
    un();
  });

  it('exits the armed tool next (even from inside a field — legacy behavior)', () => {
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' }, tool: 'redact' }));
    dispatchKeyEvent(fakeEvent({ key: 'Escape', target: INPUT }));
    expect(dispatched).toEqual([{ type: 'UI_SET_TOOL', tool: 'select' }]);
  });

  it('clears the selection when no tool is armed (edit-guarded)', () => {
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' }, selectedPageIds: new Set(['x#p0']) }));
    dispatchKeyEvent(fakeEvent({ key: 'Escape', target: INPUT }));
    expect(dispatched).toEqual([]); // guarded inside a field
    dispatchKeyEvent(fakeEvent({ key: 'Escape', target: DIV }));
    expect(dispatched).toEqual([{ type: 'UI_CLEAR_SELECTION' }]);
  });

  it('tool exit takes priority over selection clear — one step per press', () => {
    const { dispatched, current } = wire(
      uiState({ focusedTab: { doc: 'x.pdf' }, tool: 'highlight', selectedPageIds: new Set(['x#p0']) }),
    );
    dispatchKeyEvent(fakeEvent({ key: 'Escape', target: DIV }));
    expect(dispatched).toEqual([{ type: 'UI_SET_TOOL', tool: 'select' }]);
    expect(current().ui.selectedPageIds.size).toBe(1);
    dispatchKeyEvent(fakeEvent({ key: 'Escape', target: DIV }));
    expect(dispatched.map((a) => a.type)).toEqual(['UI_SET_TOOL', 'UI_CLEAR_SELECTION']);
  });

  it('is inert outside the canvas view', () => {
    const { dispatched } = wire(uiState({ focusedTab: 'home', tool: 'select' }));
    dispatchKeyEvent(fakeEvent({ key: 'Escape', target: DIV }));
    expect(dispatched).toEqual([]);
  });
});

describe('single-key accelerators (pref-gated, default OFF)', () => {
  it('the letters resolve to their tools at the table level', () => {
    expect(resolveBinding(fakeEvent({ key: 'h' }))?.command).toBe('tools.hand');
    expect(resolveBinding(fakeEvent({ key: 'v' }))?.command).toBe('tools.select');
    expect(resolveBinding(fakeEvent({ key: 'u' }))?.command).toBe('tools.highlight');
    expect(resolveBinding(fakeEvent({ key: 'x' }))?.command).toBe('tools.freetext');
    expect(resolveBinding(fakeEvent({ key: 'd' }))?.command).toBe('tools.ink');
    expect(resolveBinding(fakeEvent({ key: 'k' }))?.command).toBe('tools.stamp');
    // The reserve-don't-remap trio binds now that its features exist.
    expect(resolveBinding(fakeEvent({ key: 's' }))?.command).toBe('tools.note');
    expect(resolveBinding(fakeEvent({ key: 'z' }))?.command).toBe('tools.zoommarquee');
    expect(resolveBinding(fakeEvent({ key: 'e' }))?.command).toBe('tools.open.edit');
    // Every one is pref-gated — the dispatcher refuses them until the
    // Settings switch is on.
    for (const k of ['h', 'v', 'u', 'x', 'd', 'k', 's', 'z', 'e']) {
      expect(resolveBinding(fakeEvent({ key: k }))?.requiresPref).toBe('singleKeyAccelerators');
    }
  });

  it('Alt+letter and Shift+letter are NOT tool picks', () => {
    // Alt+letter is a mnemonic, and Shift+letter is reserved.
    expect(resolveBinding(fakeEvent({ key: 'h', alt: true }))).toBeNull();
    expect(resolveBinding(fakeEvent({ key: 'H', shift: true }))).toBeNull();
  });

  it('INVERSION — Z/S/E bind (their features shipped); modified forms stay dead', () => {
    // This test used to pin the trio as RESERVED (no zoom device, no note
    // kind, no content editing). All three exist now, so reserve-don't-
    // remap resolves to BINDING them — while the modifier discipline that
    // motivated the reservation still holds.
    expect(resolveBinding(fakeEvent({ key: 'z' }))?.command).toBe('tools.zoommarquee');
    expect(resolveBinding(fakeEvent({ key: 's' }))?.command).toBe('tools.note');
    expect(resolveBinding(fakeEvent({ key: 'e' }))?.command).toBe('tools.open.edit');
    expect(resolveBinding(fakeEvent({ key: 's', alt: true }))).toBeNull();
    expect(resolveBinding(fakeEvent({ key: 'S', shift: true }))).toBeNull();
  });

  it('pref-gated bindings never DISPLAY as menu shortcuts', () => {
    // A menu must not advertise a key that may be dead.
    expect(shortcutForCommand('tools.hand')).toBeNull();
    expect(shortcutForCommand('tools.highlight')).toBeNull();
  });
});
