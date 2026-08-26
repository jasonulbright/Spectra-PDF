// The first-paint signal is what makes the window visible, so it must fire
// exactly once, a full frame after the mount, and must never propagate a
// failure into boot.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  app: { rendererReady: vi.fn() },
}));

import { signalFirstPaint } from '../src/renderer/lib/first-paint';

/** A manual frame clock: nothing runs until a frame is actually produced. */
function frames() {
  const queue: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => {
      queue.push(cb);
    },
    tick: () => {
      const due = queue.splice(0, queue.length);
      due.forEach((cb) => {
        cb();
      });
    },
  };
}

describe('signalFirstPaint', () => {
  it('waits a second frame before reporting', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const clock = frames();
    signalFirstPaint(clock.schedule, notify);
    expect(notify).not.toHaveBeenCalled();
    clock.tick();
    // One frame in: the commit's frame has been produced, the content it
    // carries has not been composited yet.
    expect(notify).not.toHaveBeenCalled();
    clock.tick();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('reports once, not once per later frame', () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const clock = frames();
    signalFirstPaint(clock.schedule, notify);
    clock.tick();
    clock.tick();
    clock.tick();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected signal', () => {
    const notify = vi.fn().mockRejectedValue(new Error('unknown command'));
    const clock = frames();
    signalFirstPaint(clock.schedule, notify);
    clock.tick();
    expect(() => {
      clock.tick();
    }).not.toThrow();
  });

  it('swallows a bridge that is not there at all', () => {
    const notify = vi.fn(() => {
      throw new Error('no bridge');
    });
    const clock = frames();
    signalFirstPaint(clock.schedule, notify as unknown as () => Promise<unknown>);
    clock.tick();
    expect(() => {
      clock.tick();
    }).not.toThrow();
  });
});
