// The keymap table (19-phase4 § 4.4 / § 9.2). Bindings live ONLY here; menus
// display shortcuts from this same data at M2, so drift is impossible. M1
// carries exactly the pre-workbench set (the six hand-rolled keydown
// listeners' bindings, semantics preserved bit-for-bit); the full Acrobat
// preset lands across M2–M6 with the mandatory verification pass before the
// keymap freezes. Rule for gaps: an Acrobat key whose feature we don't ship
// stays UNBOUND (reserved), never remapped.
import type { CommandId } from './registry';

export interface KeyBinding {
  /** KeyboardEvent.key, lowercased ('z', 'delete', '[', '='). */
  key: string;
  /** Required Ctrl/Cmd state; undefined = don't care (matches the legacy
   * listeners, which mostly ignored modifiers they didn't check). */
  ctrl?: boolean;
  /** Required Shift state; undefined = don't care. */
  shift?: boolean;
  command: CommandId;
  /** 'global' is app-wide; 'canvas' only fires while the canvas view is
   * focused (the legacy listeners were mounted with WorkspaceCanvasView). */
  scope: 'global' | 'canvas';
  /** Skip while typing in a field (the shared isEditable guard). Ctrl+F is
   * the deliberate exception — it keeps its always-wins behavior (§ 4.4). */
  editableGuard: boolean;
  /** 'always': preventDefault whenever the binding matches (legacy listeners
   * that preventDefault'ed before checking anything). 'whenEnabled': only
   * when the command's enablement predicate passes (legacy listeners that
   * early-returned before preventDefault, letting the browser default
   * through — e.g. Backspace with nothing selected). */
  preventDefault: 'always' | 'whenEnabled';
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
  // File cluster (§ 9.2) — global chords fields don't own, always
  // preventDefault (they'd otherwise hit WebView2's own Ctrl+S/Ctrl+O/Ctrl+P).
  // 'whenEnabled' where the browser has no default worth suppressing and the
  // command may be disabled (save/close/exit gate on an open/dirty file).
  { key: 'o', ctrl: true, command: 'file.open', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 's', ctrl: true, shift: false, command: 'file.save', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 's', ctrl: true, shift: true, command: 'file.saveAs', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 'w', ctrl: true, command: 'file.close', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 'q', ctrl: true, command: 'file.exit', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 'k', ctrl: true, command: 'edit.preferences', scope: 'global', editableGuard: false, preventDefault: 'always' },
  // Tab cycling (§ 9.2). Ctrl+Tab / Ctrl+Shift+Tab — always available (Home +
  // Tools always present); guard-exempt so it cycles even from a focused field.
  { key: 'tab', ctrl: true, shift: false, command: 'window.nextTab', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 'tab', ctrl: true, shift: true, command: 'window.prevTab', scope: 'global', editableGuard: false, preventDefault: 'always' },
  // Nav pane toggle (§ 9.2, M3) — canvas-scoped (the pane is about the active
  // document), guard-exempt (F4 isn't a text key). Shift+F4 (task pane) stays
  // reserved/unbound until M5.
  { key: 'f4', command: 'view.navPane', scope: 'canvas', editableGuard: false, preventDefault: 'always' },
  // Search panel (§ 9.2, M3.3) — Ctrl+Shift+F opens the nav-pane Search list
  // (the command toggles, so it also closes on repeat). Canvas-scoped. Unlike
  // Find (Ctrl+F, guard-exempt), this is editableGuard:TRUE: the panel it opens
  // autofocuses a text input, and because the command toggles, a guard-exempt
  // binding would let a second Ctrl+Shift+F *from inside that input* close the
  // panel and discard the half-typed query (review-caught). Guarded, the reflex
  // re-press is a no-op; you still open Search from any non-field focus, and
  // Find stays the always-available search. The shift split from Ctrl+F is why
  // the Find binding below is now shift: false.
  { key: 'f', ctrl: true, shift: true, command: 'view.navPanel.search', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  // Undo/redo — app-global (2n.1). Ctrl+Y redo is shift-agnostic like the
  // listener it replaces.
  { key: 'z', ctrl: true, shift: false, command: 'edit.undo', scope: 'global', editableGuard: true, preventDefault: 'always' },
  { key: 'z', ctrl: true, shift: true, command: 'edit.redo', scope: 'global', editableGuard: true, preventDefault: 'always' },
  { key: 'y', ctrl: true, command: 'edit.redo', scope: 'global', editableGuard: true, preventDefault: 'always' },
  // Find (2m) — always wins, even from inside a text field. shift: false so it
  // no longer swallows Ctrl+Shift+F (that now opens the Search panel, above).
  { key: 'f', ctrl: true, shift: false, command: 'edit.find', scope: 'canvas', editableGuard: false, preventDefault: 'always' },
  // Canvas selection + page ops (2n.1). Delete/Backspace and [ / ] ignored
  // modifiers in the legacy listener; kept.
  // 'always': Ctrl+A selects PAGES in both views and must never fall through to
  // the browser's select-all, which in the VIRTUALIZED reading view would grab
  // only the mounted pages' text and silently mislead. See `edit.selectAll`.
  { key: 'a', ctrl: true, command: 'edit.selectAll', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: 'delete', command: 'document.deleteSelection', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'backspace', command: 'document.deleteSelection', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: ']', command: 'document.rotateSelectionCW', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: '[', command: 'document.rotateSelectionCCW', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  // Zoom cluster — '=' and '+' both zoom in (with or without shift, matching
  // the legacy `e.key === '=' || e.key === '+'` check).
  { key: '=', ctrl: true, command: 'view.zoomIn', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: '+', ctrl: true, command: 'view.zoomIn', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: '-', ctrl: true, command: 'view.zoomOut', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: '0', ctrl: true, command: 'view.fit', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  // Acrobat's zoom presets. Ctrl+1/Ctrl+2 sit beside Ctrl+0 (Fit Page) and are
  // reading-view only — the commands' `when` disables them on the board, so the
  // keys are inert there rather than doing something unexpected.
  { key: '1', ctrl: true, command: 'view.actualSize', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: '2', ctrl: true, command: 'view.fitWidth', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
];
