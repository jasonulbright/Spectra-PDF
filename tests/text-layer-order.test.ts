import { describe, it, expect } from 'vitest';
import { applyReadingOrder } from '../src/renderer/lib/text-layer-order';
import { orderedPageText, readingSequence, type OrientedItem } from '../src/renderer/search/text-order';

const rad = (deg: number): number => (deg * Math.PI) / 180;
const at = (str: string, deg: number, hasEOL = false): OrientedItem => ({
  str,
  hasEOL,
  transform: [10 * Math.cos(rad(deg)), 10 * Math.sin(rad(deg)), -10 * Math.sin(rad(deg)), 10 * Math.cos(rad(deg)), 0, 0],
});

type Node = { text: string };
const BR: Node = { text: '\n' };

/** The layer pdf.js builds: attached spans in content-stream order plus a
 * break after each line-ending item. */
function pdfjsLayer(items: readonly OrientedItem[]): { divs: Node[]; children: Node[] } {
  const divs = items.map((it) => ({ text: it.str }));
  const children: Node[] = [];
  items.forEach((it, i) => {
    if (it.str !== '') children.push(divs[i]);
    if (it.hasEOL) children.push(BR);
  });
  return { divs, children };
}

function selectAllCopy(children: readonly Node[]): string {
  return children.map((n) => n.text).join('');
}

function reorder(items: readonly OrientedItem[], pageRotate = 0): { applied: boolean; children: Node[]; divs: Node[] } {
  const layer = pdfjsLayer(items);
  const container = { replaceChildren: (...n: Node[]) => (layer.children = n) };
  const applied = applyReadingOrder(container, layer.divs, items, pageRotate, () => BR);
  return { applied, children: layer.children, divs: layer.divs };
}

const body = [at('Body line one of the page', 0, true), at('Body line two continues here', 0, true)];

describe('text layer reading order', () => {
  for (const deg of [90, 180, 270]) {
    it(`copies a ${deg}-degree sidebar drawn first after the body`, () => {
      const items = [at('SIDE', deg), at('BAR', deg, true), ...body];
      const expected = 'Body line one of the page\nBody line two continues here\nSIDEBAR\n';
      expect(selectAllCopy(pdfjsLayer(items).children)).not.toBe(expected);
      const r = reorder(items);
      expect(r.applied).toBe(true);
      expect(selectAllCopy(r.children)).toBe(expected);
      expect(selectAllCopy(r.children)).toBe(orderedPageText(items));
    });
  }

  it('reuses the pdf.js spans instead of rebuilding them', () => {
    const items = [at('SIDEBAR', 90), ...body];
    const r = reorder(items);
    expect(r.children.filter((n) => n !== BR)).toEqual([r.divs[1], r.divs[2], r.divs[0]]);
    expect(r.children.filter((n) => n !== BR).every((n) => r.divs.includes(n))).toBe(true);
  });

  it('breaks between orientations when the last item has no line end', () => {
    const items = [...body.slice(0, 1), at('Tail of the body text', 0), at('SIDE', 270)];
    const r = reorder(items);
    expect(selectAllCopy(r.children)).toBe(orderedPageText(items));
  });

  it('keeps empty items detached and their line breaks', () => {
    const items = [at('SIDEBAR', 90), at('', 90, true), body[0], at('', 0, true), body[1]];
    const r = reorder(items);
    expect(r.children).not.toContain(r.divs[1]);
    expect(r.children).not.toContain(r.divs[3]);
    expect(selectAllCopy(r.children)).toBe(orderedPageText(items));
  });

  it('leaves an upright page untouched', () => {
    const items = [...body, at('x', 0), at(' ', 0), at('tail', 0)];
    expect(readingSequence(items)).toBeNull();
    const before = pdfjsLayer(items).children;
    const r = reorder(items, 90);
    expect(r.applied).toBe(false);
    expect(r.children).toEqual(before);
  });

  it('leaves a truncated layer untouched', () => {
    const items = [at('SIDEBAR', 90), ...body];
    const layer = pdfjsLayer(items);
    const before = layer.children;
    const container = { replaceChildren: (...n: Node[]) => (layer.children = n) };
    expect(applyReadingOrder(container, layer.divs.slice(0, 2), items, 0, () => BR)).toBe(false);
    expect(layer.children).toBe(before);
  });
});
