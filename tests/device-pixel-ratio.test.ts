import { describe, it, expect, vi } from 'vitest';
import { watchDevicePixelRatio } from '../src/renderer/lib/device-pixel-ratio';

function fakeWindow(ratio: number) {
  const queries: { query: string; listeners: Set<() => void> }[] = [];
  const win = {
    devicePixelRatio: ratio,
    matchMedia(query: string) {
      const q = { query, listeners: new Set<() => void>() };
      queries.push(q);
      return {
        addEventListener: (_: string, fn: () => void) => q.listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => q.listeners.delete(fn),
      } as never;
    },
  };
  const fire = (): void => [...queries[queries.length - 1].listeners].forEach((fn) => fn());
  return { win, queries, fire };
}

describe('watchDevicePixelRatio', () => {
  it('reports each change and re-arms on the new ratio', () => {
    const { win, queries, fire } = fakeWindow(1);
    const onChange = vi.fn();
    const stop = watchDevicePixelRatio(win, onChange);
    expect(queries[0].query).toBe('(resolution: 1dppx)');
    win.devicePixelRatio = 1.5;
    fire();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(queries[1].query).toBe('(resolution: 1.5dppx)');
    expect(queries[0].listeners.size).toBe(0);
    win.devicePixelRatio = 2;
    fire();
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
    expect(queries[2].listeners.size).toBe(0);
  });
});
