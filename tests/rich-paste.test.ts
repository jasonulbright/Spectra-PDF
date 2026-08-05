// Rich paste — the pure walk (there is no DOM test environment; the
// DOMParser shim is browser-only by design, so everything decidable is
// pinned here on the serializable tree).
import { describe, expect, it } from 'vitest';
import {
  classifyFamily,
  colorToRgb,
  sizeToPoints,
  treeToRich,
  type RichTreeNode,
} from '../src/renderer/lib/rich-paste';

const text = (t: string): RichTreeNode => ({ text: t });
const el = (tag: string, children: RichTreeNode[], style?: Record<string, string>): RichTreeNode => ({
  tag,
  style,
  children,
});

describe('classifyFamily', () => {
  it('maps common stacks onto the engine vocabulary', () => {
    expect(classifyFamily('Arial, sans-serif')).toBe('sans');
    expect(classifyFamily('"Times New Roman", serif')).toBe('serif');
    expect(classifyFamily('Consolas, monospace')).toBe('mono');
    expect(classifyFamily('Garamond')).toBe('serif');
  });
  it('first recognizable entry wins; unknown stacks keep the document face', () => {
    expect(classifyFamily('Wingdings, Courier New')).toBe('mono');
    expect(classifyFamily('Wingdings, MysteryFont')).toBeUndefined();
  });
});

describe('sizeToPoints', () => {
  it('converts px and passes pt through', () => {
    expect(sizeToPoints('16px')).toBe(12);
    expect(sizeToPoints('12pt')).toBe(12);
  });
  it('rejects other units and garbage rather than guessing', () => {
    expect(sizeToPoints('1.2em')).toBeUndefined();
    expect(sizeToPoints('large')).toBeUndefined();
  });
});

describe('colorToRgb', () => {
  it('parses hex and rgb() forms', () => {
    expect(colorToRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(colorToRgb('#0f0')).toEqual([0, 1, 0]);
    expect(colorToRgb('rgb(0, 0, 255)')).toEqual([0, 0, 1]);
  });
  it('keeps the document colour for anything else', () => {
    expect(colorToRgb('red')).toBeUndefined();
    expect(colorToRgb('currentcolor')).toBeUndefined();
  });
});

describe('treeToRich', () => {
  it('plain text yields zero spans — the plain path stays byte-identical', () => {
    const r = treeToRich([text('hello world')]);
    expect(r.text).toBe('hello world');
    expect(r.spans).toEqual([]);
  });

  it('b/strong and i/em become ranges; nesting composes', () => {
    const r = treeToRich([
      text('a '),
      el('b', [text('bold '), el('i', [text('both')])]),
      text(' tail'),
    ]);
    expect(r.text).toBe('a bold both tail');
    expect(r.spans).toEqual([
      { start: 2, end: 7, style: { bold: true } },
      { start: 7, end: 11, style: { bold: true, italic: true } },
    ]);
  });

  it('inline style wins over tag inheritance (font-weight: normal inside <b>)', () => {
    const r = treeToRich([el('b', [el('span', [text('thin')], { 'font-weight': 'normal' })])]);
    expect(r.spans).toEqual([]);
  });

  it('family, size and colour ride the ranges in engine vocabulary', () => {
    const r = treeToRich([
      el('span', [text('red')], { color: '#ff0000' }),
      text(' '),
      el('span', [text('big')], { 'font-size': '24px' }),
      text(' '),
      el('span', [text('mono')], { 'font-family': 'Consolas' }),
    ]);
    expect(r.spans).toEqual([
      { start: 0, end: 3, style: { color: [1, 0, 0] } },
      { start: 4, end: 7, style: { size: 18 } },
      { start: 8, end: 12, style: { family: 'mono' } },
    ]);
  });

  it('block boundaries flatten to single spaces; whitespace collapses', () => {
    const r = treeToRich([
      el('p', [text('  one\n  line ')]),
      el('p', [text('two')]),
      el('div', [el('br', [])]),
      el('p', [text(' three ')]),
    ]);
    expect(r.text).toBe('one line two three');
  });

  it('adjacent same-style text folds into one range', () => {
    const r = treeToRich([el('b', [text('ab')]), el('strong', [text('cd')])]);
    expect(r.spans).toEqual([{ start: 0, end: 4, style: { bold: true } }]);
  });
});
