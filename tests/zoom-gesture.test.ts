// zoomGestureAllowed (M6.2): the d3 pan/zoom admission rule, extracted pure
// so hand mode's page-pans-too exception is testable without a DOM gesture.
import { describe, expect, it } from 'vitest';
import { zoomGestureAllowed } from '../src/renderer/canvas/create-zoom-behavior';

function el(matches: string[]): Element {
  return {
    closest: (sel: string) =>
      sel.split(',').some((s) => matches.includes(s.trim())) ? ({} as Element) : null,
  } as unknown as Element;
}

describe('zoomGestureAllowed', () => {
  it('select mode: background pans, pages/headers/controls do not', () => {
    expect(zoomGestureAllowed(el([]), false)).toBe(true);
    expect(zoomGestureAllowed(el(['.page']), false)).toBe(false);
    expect(zoomGestureAllowed(el(['.doc-header']), false)).toBe(false);
    expect(zoomGestureAllowed(el(['button']), false)).toBe(false);
  });

  it('hand mode: pages become pannable surface; controls stay controls', () => {
    expect(zoomGestureAllowed(el(['.page']), true)).toBe(true);
    expect(zoomGestureAllowed(el(['.doc-header']), true)).toBe(true);
    expect(zoomGestureAllowed(el([]), true)).toBe(true);
    expect(zoomGestureAllowed(el(['button']), true)).toBe(false);
    expect(zoomGestureAllowed(el(['input']), true)).toBe(false);
    expect(zoomGestureAllowed(el(['.doc-actions']), true)).toBe(false);
  });

  it('a null target pans in both modes (the viewport itself)', () => {
    expect(zoomGestureAllowed(null, false)).toBe(true);
    expect(zoomGestureAllowed(null, true)).toBe(true);
  });
});
