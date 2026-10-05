import { describe, it, expect } from 'vitest';
import { canvasChromeInsets, flowItems } from '../src/renderer/components/canvas/useCanvasChromeInsets';

describe('canvasChromeInsets', () => {
  it('measures the tool strip above and the status bar below the document region', () => {
    // strip 34px, region 520px, status bar 28px in a 582px view.
    const insets = canvasChromeInsets(582, [
      { top: 0, height: 34 },
      { top: 34, height: 520 },
      { top: 554, height: 28 },
    ]);
    expect(insets).toEqual({ start: 34, end: 28 });
  });

  it('counts a wrapped strip and a banner above the region', () => {
    const insets = canvasChromeInsets(600, [
      { top: 0, height: 60 },
      { top: 60, height: 24 },
      { top: 84, height: 488 },
      { top: 572, height: 28 },
    ]);
    expect(insets).toEqual({ start: 84, end: 28 });
  });

  it('is zero with no chrome or no children', () => {
    expect(canvasChromeInsets(500, [{ top: 0, height: 500 }])).toEqual({ start: 0, end: 0 });
    expect(canvasChromeInsets(500, [])).toEqual({ start: 0, end: 0 });
  });
});

interface Node {
  name: string;
  display: string;
  position: string;
  top: number;
  height: number;
  children: Node[];
}

const node = (
  name: string,
  display: string,
  position: string,
  top: number,
  height: number,
  children: Node[] = [],
): Node => ({ name, display, position, top, height, children });

const layoutOf = (n: Node) => ({ display: n.display, position: n.position });

describe('flowItems', () => {
  it('descends into a display: contents wrapper so the document region is found', () => {
    // The document view's frame is `display: contents`: its scroll region is
    // a layout item of the canvas view, and the frame itself reads as 0x0.
    const scroll = node('scroll', 'block', 'relative', 0, 670);
    const guide = node('guide', 'block', 'absolute', 10, 1);
    const frame = node('frame', 'contents', 'static', 0, 0, [scroll, guide]);
    const status = node('status', 'flex', 'static', 670, 30);
    const findBar = node('find', 'flex', 'absolute', 16, 48);
    const { items, wrappers } = flowItems([frame, status, findBar], layoutOf);
    expect(items.map((n) => n.name)).toEqual(['scroll', 'status']);
    expect(wrappers.map((n) => n.name)).toEqual(['frame']);
    expect(canvasChromeInsets(700, items)).toEqual({ start: 0, end: 30 });
  });

  it('keeps the tool strip above a wrapped region and skips hidden nodes', () => {
    const strip = node('strip', 'flex', 'static', 0, 34);
    const hidden = node('hidden', 'none', 'static', 0, 0);
    const inner = node('inner', 'contents', 'static', 0, 0, [node('scroll', 'block', 'static', 34, 636)]);
    const outer = node('outer', 'contents', 'static', 0, 0, [inner]);
    const status = node('status', 'flex', 'static', 670, 30);
    const { items, wrappers } = flowItems([strip, hidden, outer, status], layoutOf);
    expect(items.map((n) => n.name)).toEqual(['strip', 'scroll', 'status']);
    expect(wrappers.map((n) => n.name)).toEqual(['outer', 'inner']);
    expect(canvasChromeInsets(700, items)).toEqual({ start: 34, end: 30 });
  });

  it('reads an element without layout information as absent', () => {
    const text = node('text', 'block', 'static', 0, 100);
    expect(flowItems([text], () => null)).toEqual({ items: [], wrappers: [] });
  });
});
