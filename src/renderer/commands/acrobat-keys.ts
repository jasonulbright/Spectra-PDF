// Bindings live only in this table, and menus display shortcuts from the same
// data so the two surfaces cannot drift. Unsupported shortcuts remain unbound
// and reserved rather than being reassigned.
import type { CommandId } from './registry';

export interface KeyBinding {
  /** KeyboardEvent.key, lowercased ('z', 'delete', '[', '='). */
  key: string;
  /** Required Ctrl/Cmd state; undefined means the modifier is ignored. */
  ctrl?: boolean;
  /** Required Shift state; undefined = don't care. */
  shift?: boolean;
  /** Required Alt state; undefined means the modifier is ignored. The
   * single-key accelerators set alt: false — a bare letter must not fire on
   * Alt+letter, which reads as a mnemonic, not a tool pick. */
  alt?: boolean;
  /** Only live while this Settings boolean is on. Single-key accelerators are
   * off by default. Preference-gated bindings
   * are invisible to shortcutForCommand: a menu must not display a key that
   * may be dead. */
  requiresPref?: 'singleKeyAccelerators';
  command: CommandId;
  /** 'global' is app-wide; 'canvas' only fires while the canvas view is focused. */
  scope: 'global' | 'canvas';
  /** Skip while typing in a field. Ctrl+F deliberately remains global. */
  editableGuard: boolean;
  /** 'always': preventDefault whenever the binding matches. 'whenEnabled':
   * prevent it only when the command is enabled, allowing browser behavior
   * through otherwise, such as Backspace with nothing selected. */
  preventDefault: 'always' | 'whenEnabled';
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
  // File commands are global chords that fields do not own. They always
  // preventDefault (they'd otherwise hit WebView2's own Ctrl+S/Ctrl+O/Ctrl+P).
  // 'whenEnabled' where the browser has no default worth suppressing and the
  // command may be disabled (save/close/exit gate on an open/dirty file).
  { key: 'o', ctrl: true, command: 'file.open', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 's', ctrl: true, shift: false, command: 'file.save', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 's', ctrl: true, shift: true, command: 'file.saveAs', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 'w', ctrl: true, command: 'file.close', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 'q', ctrl: true, command: 'file.exit', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 'k', ctrl: true, command: 'edit.preferences', scope: 'global', editableGuard: false, preventDefault: 'always' },
  // Ctrl+P: WebView2 has its own print
  // UI, which must never appear, enabled or not. shift: false — Ctrl+Shift+P
  // is reserved and stays unbound rather than falling through to Print.
  { key: 'p', ctrl: true, shift: false, command: 'file.print', scope: 'global', editableGuard: false, preventDefault: 'always' },
  // Ctrl+D opens Document Properties. Use whenEnabled rather than always:
  // with no document open it must fall through rather than be swallowed.
  // shift must be false because Ctrl+Shift+D is Delete Pages below.
  { key: 'd', ctrl: true, shift: false, command: 'file.properties', scope: 'global', editableGuard: true, preventDefault: 'whenEnabled' },
  // Document-operation chords. Pane commands mirror their
  // menu items: enabled from anywhere, they focus the Tools tab.
  { key: 'd', ctrl: true, shift: true, command: 'tools.panel.delete', scope: 'global', editableGuard: true, preventDefault: 'always' },
  { key: 'r', ctrl: true, shift: true, command: 'tools.panel.rotate', scope: 'global', editableGuard: true, preventDefault: 'always' },
  { key: 'i', ctrl: true, shift: true, command: 'document.insertFromFile', scope: 'global', editableGuard: true, preventDefault: 'whenEnabled' },
  // Ctrl+Shift+T inserts blank pages.
  { key: 't', ctrl: true, shift: true, command: 'document.insertBlankPage', scope: 'global', editableGuard: true, preventDefault: 'whenEnabled' },
  // Go to page: focus the reading view's page box.
  { key: 'n', ctrl: true, shift: true, command: 'view.goToPage', scope: 'global', editableGuard: true, preventDefault: 'whenEnabled' },
  // Read Out Loud. The transport's four chords, all guarded against editable
  // targets — Ctrl+Shift+V is a paste chord inside a field and must stay one
  // there. 'whenEnabled': with no document open they mean nothing, and a
  // suppressed press that does nothing is worse than the webview's own
  // handling of it.
  { key: 'v', ctrl: true, shift: true, command: 'view.readAloud.page', scope: 'global', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'b', ctrl: true, shift: true, command: 'view.readAloud.document', scope: 'global', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'c', ctrl: true, shift: true, command: 'view.readAloud.pause', scope: 'global', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'e', ctrl: true, shift: true, command: 'view.readAloud.stop', scope: 'global', editableGuard: true, preventDefault: 'whenEnabled' },
  // Reading mode. Ctrl+H is a browser
  // accelerator (history) already in the suppress list; a disabled press must
  // still never reach the webview.
  { key: 'h', ctrl: true, shift: false, command: 'view.readingMode', scope: 'global', editableGuard: true, preventDefault: 'always' },
  // Properties Bar toggle. Not a browser accelerator, but 'always'
  // keeps the pair with Ctrl+H/Ctrl+E semantics predictable on doc tabs.
  { key: 'e', ctrl: true, shift: false, command: 'view.propertiesBar', scope: 'global', editableGuard: true, preventDefault: 'always' },
  // Presentation / full-screen (F5 — the universal presentation key). MUST be
  // 'always': F5 is the browser reload key (already in suppressBrowserDefault),
  // so it must be prevented even when presentation is disabled (no doc open) —
  // 'whenEnabled' would let a disabled F5 fall through and reload the whole app.
  { key: 'f5', command: 'view.presentation', scope: 'global', editableGuard: true, preventDefault: 'always' },
  // Find next/previous: F3 / Shift+F3 with Ctrl+G aliases. Global
  // scope + 'always' so the webview's own find UI can never surface off a
  // doc tab; the commands' `when` (canvas services present) gates behavior.
  // Guard-exempt like Ctrl+F: F3 pressed INSIDE the find field must step the
  // match, not type.
  { key: 'f3', shift: false, command: 'edit.findNext', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 'f3', shift: true, command: 'edit.findPrev', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 'g', ctrl: true, shift: false, command: 'edit.findNext', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 'g', ctrl: true, shift: true, command: 'edit.findPrev', scope: 'global', editableGuard: false, preventDefault: 'always' },
  // Tab cycling is always available because Home and
  // Tools always present); guard-exempt so it cycles even from a focused field.
  { key: 'tab', ctrl: true, shift: false, command: 'window.nextTab', scope: 'global', editableGuard: false, preventDefault: 'always' },
  { key: 'tab', ctrl: true, shift: true, command: 'window.prevTab', scope: 'global', editableGuard: false, preventDefault: 'always' },
  // The navigation-pane toggle is canvas-scoped because it concerns the active
  // document), guard-exempt (F4 isn't a text key).
  { key: 'f4', shift: false, command: 'view.navPane', scope: 'canvas', editableGuard: false, preventDefault: 'always' },
  // Shift+F4 toggles the Tools tab.
  // Global — the toggle works FROM the Tools tab too, that's its point.
  { key: 'f4', shift: true, command: 'view.toolsPane', scope: 'global', editableGuard: false, preventDefault: 'always' },
  // Ctrl+Shift+F opens the navigation-pane Search list
  // (the command toggles, so it also closes on repeat). Canvas-scoped. Unlike
  // Find (Ctrl+F, guard-exempt), this is editableGuard:TRUE: the panel it opens
  // autofocuses a text input, and because the command toggles, a guard-exempt
  // binding would let a second Ctrl+Shift+F *from inside that input* close the
  // panel and discard the half-typed query. Guarded, the reflex
  // re-press is a no-op; you still open Search from any non-field focus, and
  // Find stays the always-available search. The shift split from Ctrl+F is why
  // the Find binding below is now shift: false.
  { key: 'f', ctrl: true, shift: true, command: 'view.navPanel.search', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  // Undo and redo are app-global. Ctrl+Y redo is shift-agnostic.
  { key: 'z', ctrl: true, shift: false, command: 'edit.undo', scope: 'global', editableGuard: true, preventDefault: 'always' },
  { key: 'z', ctrl: true, shift: true, command: 'edit.redo', scope: 'global', editableGuard: true, preventDefault: 'always' },
  { key: 'y', ctrl: true, command: 'edit.redo', scope: 'global', editableGuard: true, preventDefault: 'always' },
  // Find always wins, even from inside a text field. shift: false so it
  // no longer swallows Ctrl+Shift+F (that now opens the Search panel, above).
  { key: 'f', ctrl: true, shift: false, command: 'edit.find', scope: 'canvas', editableGuard: false, preventDefault: 'always' },
  // Canvas selection and page operations. Delete/Backspace and [ / ] ignore
  // unspecified modifiers.
  // 'always': Ctrl+A selects PAGES in both views and must never fall through to
  // the browser's select-all, which in the VIRTUALIZED reading view would grab
  // only the mounted pages' text and silently mislead. See `edit.selectAll`.
  { key: 'a', ctrl: true, command: 'edit.selectAll', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: 'delete', command: 'document.deleteSelection', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'backspace', command: 'document.deleteSelection', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: ']', command: 'document.rotateSelectionCW', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: '[', command: 'document.rotateSelectionCCW', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  // Zoom keeps the shiftless main-row keys ('='/'-') and the numpad keys
  // (which produce '+'/'-' with shiftKey false), and the shifted pair rotates.
  { key: '=', ctrl: true, shift: false, command: 'view.zoomIn', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: '+', ctrl: true, shift: false, command: 'view.zoomIn', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: '-', ctrl: true, shift: false, command: 'view.zoomOut', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  // Rotate View. Ctrl+Shift+= produces key '+' on US layouts; Ctrl+Shift+- gives
  // '_' on the main row but '-' from the numpad, so both spellings bind.
  { key: '+', ctrl: true, shift: true, command: 'view.rotateCW', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: '_', ctrl: true, shift: true, command: 'view.rotateCCW', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: '-', ctrl: true, shift: true, command: 'view.rotateCCW', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: '0', ctrl: true, command: 'view.fit', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  // Zoom presets. Ctrl+1/Ctrl+2 sit beside Ctrl+0 (Fit Page) and are
  // reading-view only — the commands' `when` disables them on the board, so the
  // keys are inert there rather than doing something unexpected.
  { key: '1', ctrl: true, command: 'view.actualSize', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  { key: '2', ctrl: true, command: 'view.fitWidth', scope: 'canvas', editableGuard: true, preventDefault: 'always' },
  // Single-key accelerators are preference-gated and off by default. Bare
  // letters honor the editable guard and require every modifier to be false;
  // Alt+letter is a mnemonic, not a tool selection. Disabled commands let the
  // letter fall through. Z, S, and E select zoom marquee, sticky note, and
  // content editing respectively.
  { key: 'h', ctrl: false, shift: false, alt: false, requiresPref: 'singleKeyAccelerators', command: 'tools.hand', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'v', ctrl: false, shift: false, alt: false, requiresPref: 'singleKeyAccelerators', command: 'tools.select', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'u', ctrl: false, shift: false, alt: false, requiresPref: 'singleKeyAccelerators', command: 'tools.highlight', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'x', ctrl: false, shift: false, alt: false, requiresPref: 'singleKeyAccelerators', command: 'tools.freetext', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'd', ctrl: false, shift: false, alt: false, requiresPref: 'singleKeyAccelerators', command: 'tools.ink', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'k', ctrl: false, shift: false, alt: false, requiresPref: 'singleKeyAccelerators', command: 'tools.stamp', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 's', ctrl: false, shift: false, alt: false, requiresPref: 'singleKeyAccelerators', command: 'tools.note', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'z', ctrl: false, shift: false, alt: false, requiresPref: 'singleKeyAccelerators', command: 'tools.zoommarquee', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
  { key: 'e', ctrl: false, shift: false, alt: false, requiresPref: 'singleKeyAccelerators', command: 'tools.open.edit', scope: 'canvas', editableGuard: true, preventDefault: 'whenEnabled' },
];
