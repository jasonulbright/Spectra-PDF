// The keymap layer (19-phase4 § 4.4): ONE window-level dispatcher owns every
// shortcut. Scope order: Escape interceptor stack (in-flight drag, open
// context menu — LIFO) → the shared inline-edit guard → table bindings.
// This replaces the six hand-rolled keydown effects and both duplicated
// isEditable helpers that predated Phase 4.
import { useEffect } from 'react';
import { KEY_BINDINGS, type KeyBinding } from './acrobat-keys';
import { COMMANDS, type CommandId } from './registry';
import { getCommandContext, runEscapeInterceptors } from './context';
import { isDocTab, type CanvasTool } from '../state/types';
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

const KEY_LABELS: Record<string, string> = {
  delete: 'Del',
  backspace: 'Backspace',
  tab: 'Tab',
  escape: 'Esc',
  ' ': 'Space',
};

function formatKey(key: string): string {
  return KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/**
 * The display shortcut for a command, derived from the FIRST keymap binding
 * that targets it (multi-bound commands like redo/zoom show their primary
 * chord). Menus render from this, so a menu's label and the live binding can
 * never drift — the § 4.4 PhotoGIMP property. Null when the command is
 * unbound. Exported for the menu layer and its integrity test.
 */
export function shortcutForCommand(command: CommandId): string | null {
  const b = KEY_BINDINGS.find((x) => x.command === command);
  if (!b) return null;
  const parts: string[] = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.shift) parts.push('Shift');
  parts.push(formatKey(b.key));
  return parts.join('+');
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
  if (!isDocTab(ctx.state.ui.focusedTab)) return;
  if (ctx.state.ui.tool !== 'select') {
    ctx.dispatch({ type: 'UI_SET_TOOL', tool: 'select' });
    return;
  }
  if (ctx.state.ui.selectedPageIds.size > 0 && !isEditable(target)) {
    ctx.dispatch({ type: 'UI_CLEAR_SELECTION' });
  }
}

// An open Radix menu (role="menu") or an app modal (data-app-modal) owns the
// keyboard — the first scope in § 4.4 ("native menu/dialog handling wins").
// While one is up, the dispatcher steps aside entirely: menu typeahead/arrows/
// Escape are Radix's, and a chord like Ctrl+W must not close a file behind the
// modal. Guarded by presence, not focus, so it holds even mid-animation.
function overlayOpen(): boolean {
  // role=menu: Radix menubar + dropdown content. role=dialog: Radix
  // Confirm/Password dialogs. data-app-modal: the plain-div overlays
  // (Preferences, About).
  return (
    typeof document !== 'undefined' &&
    document.querySelector('[role="menu"], [role="dialog"], [data-app-modal]') !== null
  );
}

// Space = temporary Hand while held (M6.2, Acrobat's own gesture). Module
// state, one owner: the prior mode to restore on keyup. Deliberately restored
// by direct dispatch (not a command) so the release always works — even if a
// dialog opened mid-hold.
let spaceHandPrior: CanvasTool | null = null;

/** Keyup half of the Space temporary hand. Installed beside the keydown. */
export function dispatchKeyUpEvent(e: KeyboardEvent): void {
  if (e.key !== ' ' || spaceHandPrior === null) return;
  const ctx = getCommandContext();
  const prior = spaceHandPrior;
  spaceHandPrior = null;
  // Restore ONLY if the hold is still what's armed: if something else moved
  // the tool mid-hold (Escape disarmed to select, a tool was picked), the
  // release must not resurrect the pre-Space mode over that decision.
  if (ctx?.state.ui.tool === 'hand') {
    ctx.dispatch({ type: 'UI_SET_TOOL', tool: prior });
  }
}

/** Focus-loss mid-hold (alt-tab) eats the keyup — treat blur as release, so
 * the window never comes back stuck in a hand the user isn't holding. */
export function dispatchWindowBlur(): void {
  if (spaceHandPrior === null) return;
  const ctx = getCommandContext();
  const prior = spaceHandPrior;
  spaceHandPrior = null;
  if (ctx?.state.ui.tool === 'hand') {
    ctx.dispatch({ type: 'UI_SET_TOOL', tool: prior });
  }
}

/** The one window keydown handler. Exported for tests; installed by the hook. */
export function dispatchKeyEvent(e: KeyboardEvent): void {
  const ctx = getCommandContext();
  if (!ctx) return;
  if (overlayOpen()) return;
  // Space temporary hand: hold to pan, release to get your mode back. Guarded
  // like a text key (Space in a field types a space), doc-tab only. Runs
  // before the table — Space has no binding. preventDefault is NOT gated on
  // e.repeat: holding is the whole gesture, and auto-repeat keydowns would
  // otherwise fall through to the browser's Space (page-down scroll, focused-
  // button activation) and fight the pan (review-caught). Re-arming is
  // already impossible — `spaceHandPrior` is set for the whole hold.
  if (e.key === ' ' && isDocTab(ctx.state.ui.focusedTab) && !isEditable(e.target)) {
    if (spaceHandPrior === null && ctx.state.ui.tool !== 'hand') {
      spaceHandPrior = ctx.state.ui.tool;
      ctx.dispatch({ type: 'UI_SET_TOOL', tool: 'hand' });
    }
    e.preventDefault(); // Acrobat's Space doesn't also scroll
    return;
  }
  if (e.key === 'Escape') {
    dispatchEscape(ctx, e.target);
    return;
  }
  const binding = resolveBinding(e);
  if (!binding) return;
  if (binding.scope === 'canvas' && !isDocTab(ctx.state.ui.focusedTab)) return;
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
    window.addEventListener('keyup', dispatchKeyUpEvent);
    window.addEventListener('blur', dispatchWindowBlur);
    return () => {
      window.removeEventListener('keydown', dispatchKeyEvent);
      window.removeEventListener('keyup', dispatchKeyUpEvent);
      window.removeEventListener('blur', dispatchWindowBlur);
    };
  }, []);
}
