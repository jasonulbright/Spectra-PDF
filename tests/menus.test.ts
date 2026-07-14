// Menu + toolbar data integrity (Phase 4 M2). Every static item references a
// registered command; displayed shortcuts come from the keymap table (so a
// label can't drift from its binding); dynamic sections produce valid leaves.
import { describe, expect, it } from 'vitest';
import { MENUS, menuCommandIds, type MenuNode } from '../src/renderer/commands/menus';
import { toolbarCommandIds } from '../src/renderer/commands/toolbars';
import { COMMANDS, type CommandId } from '../src/renderer/commands/registry';
import { shortcutForCommand } from '../src/renderer/commands/keymap';
import { initialState } from '../src/renderer/state/reducer';
import type { AppState, OpenFile } from '../src/renderer/state/types';
import type { CommandContext } from '../src/renderer/commands/types';

function ctxWith(partial: Partial<AppState>): CommandContext {
  const state = { ...initialState, ...partial, ui: { ...initialState.ui, ...(partial.ui ?? {}) } };
  return { state, dispatch: () => {}, app: null, canvas: null };
}

function makeFile(path: string, importOnly = false): OpenFile {
  return {
    path, workingPath: `${path}.w`, name: path, pageCount: 1, buffer: [1],
    dirty: false, undoStack: [], redoStack: [], ...(importOnly ? { importOnly } : {}),
  };
}

describe('menu integrity', () => {
  it('every command node references a registered command', () => {
    for (const id of menuCommandIds()) {
      expect(COMMANDS[id], id).toBeDefined();
    }
  });

  it('the toolbar references only registered commands', () => {
    for (const id of toolbarCommandIds()) {
      expect(COMMANDS[id], id).toBeDefined();
    }
  });

  it('menu ids are unique and every menu has items', () => {
    const ids = MENUS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MENUS) expect(m.items.length, m.id).toBeGreaterThan(0);
  });

  it('the File menu wires Open Recent as a submenu with a dynamic list', () => {
    const file = MENUS.find((m) => m.id === 'file')!;
    const recent = file.items.find(
      (n): n is Extract<MenuNode, { kind: 'submenu' }> => n.kind === 'submenu' && n.id === 'file-recent',
    );
    expect(recent).toBeDefined();
    expect(recent!.items.some((n) => n.kind === 'dynamic')).toBe(true);
  });
});

describe('dynamic sections', () => {
  function dynamicBuild(menuId: string, dynId: string) {
    const search = (nodes: MenuNode[]): Extract<MenuNode, { kind: 'dynamic' }> | null => {
      for (const n of nodes) {
        if (n.kind === 'dynamic' && n.id === dynId) return n;
        if (n.kind === 'submenu') {
          const found = search(n.items);
          if (found) return found;
        }
      }
      return null;
    };
    return search(MENUS.find((m) => m.id === menuId)!.items)!.build;
  }

  it('Open Recent shows a disabled placeholder when empty, else the paths', () => {
    const build = dynamicBuild('file', 'recent-list');
    expect(build(ctxWith({}))).toEqual([expect.objectContaining({ disabled: true })]);
    const items = build(ctxWith({ ui: { ...initialState.ui, recentFiles: ['C:\\docs\\a.pdf'] } }));
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('a.pdf');
    expect(items[0].disabled).toBeFalsy();
  });

  it('the Window doc list excludes importOnly sources and disables the focused doc', () => {
    const build = dynamicBuild('window', 'window-docs');
    const files = new Map([
      ['a.pdf', makeFile('a.pdf')],
      ['src.pdf', makeFile('src.pdf', true)],
      ['b.pdf', makeFile('b.pdf')],
    ]);
    const items = build(ctxWith({ files, ui: { ...initialState.ui, focusedTab: { doc: 'b.pdf' } } }));
    expect(items.map((i) => i.label)).toEqual(['1  a.pdf', '2  b.pdf']); // src.pdf excluded
    expect(items.find((i) => i.label.endsWith('b.pdf'))!.disabled).toBe(true);
  });

  it('the Window doc list shows a placeholder when nothing is open', () => {
    const build = dynamicBuild('window', 'window-docs');
    expect(build(ctxWith({}))).toEqual([expect.objectContaining({ disabled: true })]);
  });
});

describe('shortcutForCommand', () => {
  it('formats the primary binding for a command', () => {
    expect(shortcutForCommand('file.save')).toBe('Ctrl+S');
    expect(shortcutForCommand('file.saveAs')).toBe('Ctrl+Shift+S');
    expect(shortcutForCommand('edit.undo')).toBe('Ctrl+Z');
    expect(shortcutForCommand('edit.redo')).toBe('Ctrl+Shift+Z'); // first binding, not Ctrl+Y
    expect(shortcutForCommand('document.deleteSelection')).toBe('Del');
    expect(shortcutForCommand('window.nextTab')).toBe('Ctrl+Tab');
  });

  it('returns null for an unbound command', () => {
    expect(shortcutForCommand('help.about')).toBeNull();
    expect(shortcutForCommand('tools.panel.compress' as CommandId)).toBeNull();
  });
});
