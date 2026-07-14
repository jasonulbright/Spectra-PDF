// The keymap layer (19-phase4 § 4.4): ONE window-level dispatcher owns every
// shortcut. Scope order: Escape interceptor stack (in-flight drag, open
// context menu — LIFO) → the shared inline-edit guard → table bindings.
// This replaces the six hand-rolled keydown effects and both duplicated
// isEditable helpers that predated Phase 4.
import { useEffect } from 'react';
import { KEY_BINDINGS, type KeyBinding } from './acrobat-keys';
import { COMMANDS } from './registry';
import { getCommandContext, runEscapeInterceptors } from './context';
import type { CommandContext } from './types';

/** The single inline-edit guard (formerly duplicated in App.tsx and
 * WorkspaceCanvasView.tsx): keystrokes belong to a focused field. */
export function isEditable(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n || !n.tagName) return false;
  return (
    n.tagName === 'INPUT' ||
    n.tagName === 'TEXTAREA' ||
    n.tagName === 'SELECT' ||
    n.isContentEditable
  );
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

function matches(b: KeyBinding, e: KeyLike): boolean {
  if (b.key !== e.key.toLowerCase()) return false;
  const mod = e.ctrlKey || e.metaKey;
  if (b.ctrl !== undefined && b.ctrl !== mod) return false;
  if (b.shift !== undefined && b.shift !== e.shiftKey) return false;
  return true;
}

/** First matching binding in table order, or null. Pure — table-tested. */
export function resolveBinding(
  e: KeyLike,
  bindings: readonly KeyBinding[] = KEY_BINDINGS,
): KeyBinding | null {
  for (const b of bindings) {
    if (matches(b, e)) return b;
  }
  return null;
}

/**
 * The Escape chain (§ 4.4), replacing four independent listeners:
 *   1. interceptors — an in-flight page drag or an open context menu owns
 *      Escape while active (LIFO; these can't coexist);
 *   2. exit the armed canvas tool (NOT edit-guarded — the legacy tool-exit
 *      effect fired even from inside a text field; behavior kept);
 *   3. clear the page selection (edit-guarded, like the legacy canvas keys).
 * Steps 2–3 are canvas-view-only, matching the listeners' mount scope. No
 * preventDefault anywhere — none of the legacy Escape handlers called it.
 */
function dispatchEscape(ctx: CommandContext, target: EventTarget | null): void {
  if (runEscapeInterceptors()) return;
  if (ctx.state.ui.view !== 'canvas') return;
  if (ctx.state.ui.tool !== 'select') {
    ctx.dispatch({ type: 'UI_SET_TOOL', tool: 'select' });
    return;
  }
  if (ctx.state.ui.selectedPageIds.size > 0 && !isEditable(target)) {
    ctx.dispatch({ type: 'UI_CLEAR_SELECTION' });
  }
}

/** The one window keydown handler. Exported for tests; installed by the hook. */
export function dispatchKeyEvent(e: KeyboardEvent): void {
  const ctx = getCommandContext();
  if (!ctx) return;
  if (e.key === 'Escape') {
    dispatchEscape(ctx, e.target);
    return;
  }
  const binding = resolveBinding(e);
  if (!binding) return;
  if (binding.scope === 'canvas' && ctx.state.ui.view !== 'canvas') return;
  if (binding.editableGuard && isEditable(e.target)) return;
  const cmd = COMMANDS[binding.command];
  const enabled = cmd.when ? cmd.when(ctx) : true;
  if (binding.preventDefault === 'always' || enabled) e.preventDefault();
  if (enabled) void cmd.run(ctx);
}

/** Mounted once by App. The handler is module-stable; context flows through
 * the registered state source, so this never re-registers. */
export function useKeymapDispatcher(): void {
  useEffect(() => {
    window.addEventListener('keydown', dispatchKeyEvent);
    return () => window.removeEventListener('keydown', dispatchKeyEvent);
  }, []);
}
