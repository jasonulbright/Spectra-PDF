// The compose settle is the only evidence the backend gets that a webview has
// been re-placed off the client area, so it must report the viewport in the
// units the window is measured in, must not report a burst of them, and must
// never propagate a failure into a live window.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  app: { settleWindowCompose: vi.fn() },
}));

import {
  physicalViewport,
  watchWindowCompose,
  SETTLE_DEBOUNCE_MS,
} from '../src/renderer/lib/compose-settle';

/** A stand-in for `window` that records its listeners. */
function listenerTarget() {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    handlers,
    target: {
      addEventListener: (type: string, cb: () => void) => {
        (handlers[type] ??= []).push(cb);
      },
      removeEventListener: (type: string, cb: () => void) => {
        handlers[type] = (handlers[type] ?? []).filter((h) => h !== cb);
      },
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>,
    fire: (type: string) => {
      (handlers[type] ?? []).slice().forEach((cb) => {
        cb();
      });
    },
  };
}

describe('physicalViewport', () => {
  it('scales CSS pixels by the device pixel ratio', () => {
    const view = { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 1.5 } as Window;
    expect(physicalViewport(view)).toEqual([1800, 1200]);
  });

  it('rounds rather than truncating a fractional ratio', () => {
    const view = { innerWidth: 1201, innerHeight: 801, devicePixelRatio: 1.25 } as Window;
    expect(physicalViewport(view)).toEqual([1501, 1001]);
  });

  it('treats a missing ratio as 1', () => {
    const view = { innerWidth: 1200, innerHeight: 800, devicePixelRatio: 0 } as Window;
    expect(physicalViewport(view)).toEqual([1200, 800]);
  });
});

describe('watchWindowCompose', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the viewport after the resize settles', () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const t = listenerTarget();
    watchWindowCompose(t.target, settle, SETTLE_DEBOUNCE_MS, () => [1200, 800]);
    t.fire('resize');
    expect(settle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS);
    expect(settle).toHaveBeenCalledWith(1200, 800);
  });

  it('collapses a drag-resize burst into one report', () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const t = listenerTarget();
    watchWindowCompose(t.target, settle, SETTLE_DEBOUNCE_MS, () => [1200, 800]);
    for (let i = 0; i < 20; i += 1) {
      t.fire('resize');
      vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS - 1);
    }
    expect(settle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('reports the viewport as it is when the debounce expires, not when the resize began', () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const t = listenerTarget();
    let size: [number, number] = [1200, 800];
    watchWindowCompose(t.target, settle, SETTLE_DEBOUNCE_MS, () => size);
    t.fire('resize');
    size = [1440, 920];
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS);
    expect(settle).toHaveBeenCalledWith(1440, 920);
  });

  it('stops reporting once torn down, including a report already pending', () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const t = listenerTarget();
    const stop = watchWindowCompose(t.target, settle, SETTLE_DEBOUNCE_MS, () => [1200, 800]);
    t.fire('resize');
    stop();
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS * 4);
    expect(settle).not.toHaveBeenCalled();
    t.fire('resize');
    vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS * 4);
    expect(settle).not.toHaveBeenCalled();
  });

  it('swallows a refused settle', () => {
    const settle = vi.fn().mockRejectedValue(new Error('unknown command'));
    const t = listenerTarget();
    watchWindowCompose(t.target, settle, SETTLE_DEBOUNCE_MS, () => [1200, 800]);
    t.fire('resize');
    expect(() => {
      vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS);
    }).not.toThrow();
  });

  it('swallows a bridge that is not there at all', () => {
    const settle = vi.fn(() => {
      throw new Error('no bridge');
    });
    const t = listenerTarget();
    watchWindowCompose(
      t.target,
      settle as unknown as (w: number, h: number) => Promise<unknown>,
      SETTLE_DEBOUNCE_MS,
      () => [1200, 800],
    );
    t.fire('resize');
    expect(() => {
      vi.advanceTimersByTime(SETTLE_DEBOUNCE_MS);
    }).not.toThrow();
  });
});
