// Floating surfaces (placement cards, status-bar popovers) own Escape while
// open: one press closes the newest surface and nothing else, and focus goes
// back to where it was only when it was lost with the surface.
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchKeyEvent } from '../src/renderer/commands/keymap';
import {
  escapeInterceptorCount,
  pushEscapeInterceptor,
  setCommandStateSource,
} from '../src/renderer/commands/context';
import { focusReturnTarget } from '../src/renderer/hooks/useDismissOnEscape';
import { appReducer, initialState } from '../src/renderer/state/reducer';
import type { AppAction, AppState } from '../src/renderer/state/types';

const DIV = { tagName: 'DIV', isContentEditable: false } as unknown as EventTarget;

function escape(): KeyboardEvent {
  return {
    key: 'Escape',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: DIV,
    preventDefault(): void {},
  } as unknown as KeyboardEvent;
}

function wire(tool: AppState['ui']['tool']): AppAction[] {
  const dispatched: AppAction[] = [];
  let current: AppState = {
    ...initialState,
    ui: { ...initialState.ui, focusedTab: { doc: 'x.pdf' }, tool },
  };
  setCommandStateSource(() => ({
    state: current,
    dispatch: (a: AppAction) => {
      dispatched.push(a);
      current = appReducer(current, a);
    },
  }));
  return dispatched;
}

/** A surface registered the way the hook registers it. */
function surface(log: string[], name: string): () => void {
  let open = true;
  const pop = pushEscapeInterceptor(() => {
    open = false;
    log.push(name);
    pop();
    return true;
  });
  return () => {
    if (open) pop();
  };
}

afterEach(() => setCommandStateSource(null));

describe('Escape over floating surfaces', () => {
  it('closes the open card and leaves the armed mode alone', () => {
    const dispatched = wire('signature');
    const log: string[] = [];
    const dispose = surface(log, 'sign card');
    dispatchKeyEvent(escape());
    expect(log).toEqual(['sign card']);
    expect(dispatched).toEqual([]);
    // The next press reaches the mode.
    dispatchKeyEvent(escape());
    expect(dispatched).toEqual([{ type: 'UI_SET_TOOL', tool: 'select' }]);
    dispose();
  });

  it('closes the newest surface first, one per press', () => {
    wire('select');
    const before = escapeInterceptorCount();
    const log: string[] = [];
    const a = surface(log, 'sign card');
    const b = surface(log, 'snap options');
    dispatchKeyEvent(escape());
    expect(log).toEqual(['snap options']);
    dispatchKeyEvent(escape());
    expect(log).toEqual(['snap options', 'sign card']);
    expect(escapeInterceptorCount()).toBe(before);
    a();
    b();
  });
});

describe('focusReturnTarget', () => {
  const body = { isConnected: true };
  const opener = { isConnected: true };

  it('returns to the opener when focus fell to the body with the surface', () => {
    expect(focusReturnTarget(body, body, opener)).toBe(opener);
    expect(focusReturnTarget(null, body, opener)).toBe(opener);
  });

  it('keeps focus that moved somewhere else', () => {
    expect(focusReturnTarget({ isConnected: true }, body, opener)).toBeNull();
  });

  it('never targets a detached opener or the body itself', () => {
    expect(focusReturnTarget(body, body, { isConnected: false })).toBeNull();
    expect(focusReturnTarget(body, body, body)).toBeNull();
    expect(focusReturnTarget(body, body, null)).toBeNull();
  });
});
