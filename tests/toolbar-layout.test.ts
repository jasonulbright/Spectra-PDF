import { describe, expect, it } from 'vitest';
import {
  NO_OVERRIDES,
  isToolbarItemVisible,
  parseToolbarOverrides,
  withToolbarVisibility,
} from '../src/renderer/lib/toolbar-layout';
import { TOOLBAR_CATALOG, visibleToolbarNodes } from '../src/renderer/commands/toolbars';

describe('parseToolbarOverrides', () => {
  it('accepts the stored shape and drops junk', () => {
    expect(parseToolbarOverrides('{"shown":["a"],"hidden":["b"]}')).toEqual({
      shown: ['a'],
      hidden: ['b'],
    });
    expect(parseToolbarOverrides('{"shown":[1,"a",null],"hidden":"x"}')).toEqual({
      shown: ['a'],
      hidden: [],
    });
  });

  it('wrong shapes and corrupt JSON yield the default', () => {
    for (const raw of [null, '', 'null', '[]', '"str"', '{broken', '{}']) {
      expect(parseToolbarOverrides(raw)).toBe(NO_OVERRIDES);
    }
  });

  it('an id in both lists resolves hidden (the safer direction)', () => {
    const parsed = parseToolbarOverrides('{"shown":["x","y"],"hidden":["x"]}');
    expect(parsed).toEqual({ shown: ['y'], hidden: ['x'] });
    expect(isToolbarItemVisible('x', true, parsed)).toBe(false);
  });
});

describe('visibility + overrides', () => {
  it('defaults apply when no override names the item', () => {
    expect(isToolbarItemVisible('cmd', true, NO_OVERRIDES)).toBe(true);
    expect(isToolbarItemVisible('cmd', false, NO_OVERRIDES)).toBe(false);
  });

  it('withToolbarVisibility stores only differences from the default', () => {
    // Hiding a default-on item records it; re-showing it converges back to
    // no overrides (not a redundant "shown" entry).
    const hidden = withToolbarVisibility(NO_OVERRIDES, 'file.save', true, false);
    expect(hidden).toEqual({ shown: [], hidden: ['file.save'] });
    expect(withToolbarVisibility(hidden, 'file.save', true, true)).toEqual(NO_OVERRIDES);
    // Showing a default-off item records it; re-hiding converges too.
    const shown = withToolbarVisibility(NO_OVERRIDES, 'view.toolsPane', false, true);
    expect(shown).toEqual({ shown: ['view.toolsPane'], hidden: [] });
    expect(withToolbarVisibility(shown, 'view.toolsPane', false, false)).toEqual(NO_OVERRIDES);
  });
});

describe('visibleToolbarNodes', () => {
  const commandsOf = (o = NO_OVERRIDES) =>
    visibleToolbarNodes(o)
      .filter((n): n is Extract<ReturnType<typeof visibleToolbarNodes>[number], { kind: 'command' }> => n.kind === 'command')
      .map((n) => n.command);

  it('the default layout is the shipped toolbar (default-off items absent)', () => {
    expect(commandsOf()).toEqual([
      'file.open', 'file.save',
      'edit.undo', 'edit.redo',
      'tools.hand', 'tools.select',
      'view.zoomOut', 'view.fit', 'view.zoomIn',
      'edit.find',
    ]);
  });

  it('separators sit between kept groups only — a fully hidden group leaves none', () => {
    const defaults = visibleToolbarNodes(NO_OVERRIDES);
    expect(defaults.filter((n) => n.kind === 'separator')).toHaveLength(4);
    // Hide the whole zoom group: its separator goes with it.
    const noZoom = parseToolbarOverrides(
      '{"hidden":["view.zoomOut","view.fit","view.zoomIn"]}',
    );
    const nodes = visibleToolbarNodes(noZoom);
    expect(nodes.filter((n) => n.kind === 'separator')).toHaveLength(3);
    expect(nodes[0].kind).toBe('command'); // never leads with a separator
  });

  it('showing a default-off item appends its group', () => {
    const withPages = withToolbarVisibility(NO_OVERRIDES, 'view.navPanel.pages', false, true);
    expect(commandsOf(withPages)).toContain('view.navPanel.pages');
  });

  it('every catalog item has a distinct command', () => {
    const all = TOOLBAR_CATALOG.flatMap((g) => g.items.map((i) => i.command));
    expect(new Set(all).size).toBe(all.length);
  });
});
