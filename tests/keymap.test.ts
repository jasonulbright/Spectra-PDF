// The keymap layer (Phase 4 M1): table integrity, the pure resolver, the
// dispatcher's scope order (interceptors → editable guard → bindings), and
// the Escape chain.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_BINDINGS, type KeyBinding } from '../src/renderer/commands/acrobat-keys';
import { dispatchKeyEvent, isEditable, resolveBinding } from '../src/renderer/commands/keymap';
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
  target?: unknown;
}

function fakeEvent(init: FakeEventInit): KeyboardEvent & { defaultPrevented: boolean } {
  const e = {
    key: init.key,
    ctrlKey: init.ctrl ?? false,
    metaKey: init.meta ?? false,
    shiftKey: init.shift ?? false,
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
    const compatible = (a: boolean | undefined, b: boolean | undefined): boolean =>
      a === undefined || b === undefined || a === b;
    const conflicts: string[] = [];
    for (let i = 0; i < KEY_BINDINGS.length; i++) {
      for (let j = i + 1; j < KEY_BINDINGS.length; j++) {
        const a = KEY_BINDINGS[i] as KeyBinding;
        const b = KEY_BINDINGS[j] as KeyBinding;
        if (a.key === b.key && compatible(a.ctrl, b.ctrl) && compatible(a.shift, b.shift)) {
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

  it('the shift split — Ctrl+F is Find, Ctrl+Shift+F is Search (M3.3)', () => {
    expect(resolveBinding(fakeEvent({ key: 'f', ctrl: true }))?.command).toBe('edit.find');
    expect(resolveBinding(fakeEvent({ key: 'f', ctrl: true, shift: true }))?.command).toBe('view.navPanel.search');
  });

  it('unmodified Delete/Backspace and [ ] resolve regardless of modifiers (legacy semantics)', () => {
    expect(resolveBinding(fakeEvent({ key: 'Delete' }))?.command).toBe('document.deleteSelection');
    expect(resolveBinding(fakeEvent({ key: 'Backspace', ctrl: true }))?.command).toBe('document.deleteSelection');
    expect(resolveBinding(fakeEvent({ key: ']' }))?.command).toBe('document.rotateSelectionCW');
    expect(resolveBinding(fakeEvent({ key: '[' }))?.command).toBe('document.rotateSelectionCCW');
  });

  it('zoom keeps the shiftless keys; the SHIFTED pair rotates the view (M6.1)', () => {
    // The legacy '=' OR '+' any-shift matching ended when the Acrobat preset
    // claimed Ctrl+Shift+Plus/Minus for Rotate View (§ 9.2).
    expect(resolveBinding(fakeEvent({ key: '=', ctrl: true }))?.command).toBe('view.zoomIn');
    expect(resolveBinding(fakeEvent({ key: '+', ctrl: true }))?.command).toBe('view.zoomIn'); // numpad plus
    expect(resolveBinding(fakeEvent({ key: '-', ctrl: true }))?.command).toBe('view.zoomOut');
    expect(resolveBinding(fakeEvent({ key: '+', ctrl: true, shift: true }))?.command).toBe('view.rotateCW');
    expect(resolveBinding(fakeEvent({ key: '_', ctrl: true, shift: true }))?.command).toBe('view.rotateCCW');
    expect(resolveBinding(fakeEvent({ key: '-', ctrl: true, shift: true }))?.command).toBe('view.rotateCCW'); // numpad minus
    expect(resolveBinding(fakeEvent({ key: '0', ctrl: true }))?.command).toBe('view.fit');
  });

  it('Ctrl+P prints; Ctrl+Shift+P stays reserved (Page Setup, unshipped)', () => {
    // Bound at M-P. 'always' preventDefault: WebView2 has its own Ctrl+P UI.
    expect(resolveBinding(fakeEvent({ key: 'p', ctrl: true }))?.command).toBe('file.print');
    expect(resolveBinding(fakeEvent({ key: 'p', ctrl: true, shift: true }))).toBeNull();
  });

  it('Ctrl+D properties vs Ctrl+Shift+D delete pages (M6.3 shift split)', () => {
    // The properties binding was shift-lax and sits earlier in the table —
    // without its shift:false, Ctrl+Shift+D would open Properties instead.
    expect(resolveBinding(fakeEvent({ key: 'd', ctrl: true }))?.command).toBe('file.properties');
    expect(resolveBinding(fakeEvent({ key: 'd', ctrl: true, shift: true }))?.command).toBe('tools.panel.delete');
  });

  it('document-op chords land on their panes (§ 9.2 ✓ rows)', () => {
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

  it('Ctrl+Shift+T stays reserved until the M6.5 verification pass', () => {
    // Version-variant in Acrobat (classic: Crop, which we don't ship).
    // Reserve-don't-remap: unbound beats a guess.
    expect(resolveBinding(fakeEvent({ key: 't', ctrl: true, shift: true }))).toBeNull();
  });

  it('returns null for unbound keys', () => {
    expect(resolveBinding(fakeEvent({ key: 'z' }))).toBeNull(); // bare z: single-key accelerators are M6, default off
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
  return { dispatched, current: () => current };
}

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
      find: { isOpen: () => false, open, openWith: vi.fn(), close: vi.fn() },
    });
    const e = fakeEvent({ key: 'f', ctrl: true, target: INPUT });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });

  it('Ctrl+Shift+F opens the Search nav panel (split from Find)', () => {
    // The shift split (M3.3): plain Ctrl+F is Find; Ctrl+Shift+F is Search.
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' } }));
    const open = vi.fn();
    registerCanvasServices({
      canvas: () => null,
      find: { isOpen: () => false, open, openWith: vi.fn(), close: vi.fn() },
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
    // panel and discard the query (review-caught MED).
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' } }));
    const e = fakeEvent({ key: 'f', ctrl: true, shift: true, target: INPUT });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(false); // guarded: no preventDefault, no dispatch
    expect(dispatched).toEqual([]);
  });

  it('canvas-scoped bindings fall through outside the canvas view', () => {
    const { dispatched } = wire(uiState({ focusedTab: 'tools' }));
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

  it('Delete with a selection dispatches the batched delete + clear', () => {
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' }, selectedPageIds: new Set(['x#p0']) }));
    const e = fakeEvent({ key: 'Delete', target: DIV });
    dispatchKeyEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(dispatched.map((a) => a.type)).toEqual(['DELETE_PAGE_REFS', 'UI_CLEAR_SELECTION']);
  });

  it('] and [ rotate the selection', () => {
    const { dispatched } = wire(uiState({ focusedTab: { doc: 'x.pdf' }, selectedPageIds: new Set(['x#p0']) }));
    dispatchKeyEvent(fakeEvent({ key: ']', target: DIV }));
    dispatchKeyEvent(fakeEvent({ key: '[', target: DIV }));
    expect(dispatched).toEqual([
      { type: 'ROTATE_PAGE_REFS', pageIds: ['x#p0'], delta: 90 },
      { type: 'ROTATE_PAGE_REFS', pageIds: ['x#p0'], delta: 270 },
    ]);
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
    const { dispatched } = wire(uiState({ focusedTab: 'tools', tool: 'select' }));
    dispatchKeyEvent(fakeEvent({ key: 'Escape', target: DIV }));
    expect(dispatched).toEqual([]);
  });
});
