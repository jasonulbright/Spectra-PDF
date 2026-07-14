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
  // Undo/redo — app-global (2n.1). Ctrl+Y redo is shift-agnostic like the
  // listener it replaces.
  { key: 'z', ctrl: true, shift: false, command: 'edit.undo', scope: 'global', editableGuard: true, preventDefault: 'always' },
  { key: 'z', ctrl: true, shift: true, command: 'edit.redo', scope: 'global', editableGuard: true, preventDefault: 'always' },
  { key: 'y', ctrl: true, command: 'edit.redo', scope: 'global', editableGuard: true, preventDefault: 'always' },
  // Find (2m) — always wins, even from inside a text field. Shift-agnostic
  // until M3 splits Ctrl+Shift+F off to the Search panel.
  { key: 'f', ctrl: true, command: 'edit.find', scope: 'canvas', editableGuard: false, preventDefault: 'always' },
  // Canvas selection + page ops (2n.1). Delete/Backspace and [ / ] ignored
  // modifiers in the legacy listener; kept.
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
];
